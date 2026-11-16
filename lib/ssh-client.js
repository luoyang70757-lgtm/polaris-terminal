'use strict';
/**
 * ssh-client.js — SSH/SFTP 直连封装(替代原来的 koko-ssh.js)
 *
 * 和 KoKo 版的区别:
 *   - 不再对用户名做 "JMS用户@账号@资产" 编码,直接用真实用户名
 *   - 连接的是用户自己的服务器,而不是 JumpServer 的网关
 *
 * 这个文件是"最底层",只干一件事:建立 SSH 连接、提供终端流和 SFTP 通道。
 * (v1.0.25 起内置 SFTP 面板整套删除,上传/下载/递归走文件系统都由本机 WinSCP 负责,
 *  这里只留 openSftp —— 主进程仍需要用它在 WinSCP 拉起前验证家目录能否 readdir。)
 * 用到的库是 ssh2(Node.js 最流行的 SSH 库,不用自己实现协议)。
 */

// ssh2 惰性加载:它是启动路径上最重的第三方依赖(Windows 冷启动可达数百毫秒)。
// 主进程启动时不再 require,首次连接/空闲预热时再加载(warmup 由 main.js 在首屏后调用)。
let Ssh2Client = null;
function getClient() {
  if (!Ssh2Client) Ssh2Client = require('ssh2').Client;
  return Ssh2Client;
}
function warmup() { try { getClient(); } catch { /* 真正连接时会报更清楚的错 */ } }
/**
 * keyboard-interactive 应答策略(域认证 / 双密码 / OTP 等服务器发起挑战时):
 *   - 单"密码"提示且有保存的密码 → 自动应答,不打扰用户;
 *   - 多提示或没密码 → 交给 opts.onKeyboardInteractive 问用户(可返回 Promise);
 *   - 都没有 → 应答空数组(认证失败,让服务器报错,而不是挂起)。
 */
function attachKbd(conn, opts) {
  conn.on('keyboard-interactive', (name, instructions, instructionsLang, prompts, finish) => {
    const list = (prompts || []).map((p) => ({ prompt: p.prompt || '', echo: p.echo !== false }));
    Promise.resolve()
      .then(() => {
        if (list.length === 1 && !list[0].echo && opts.password) return [opts.password];
        const ask = opts.onKeyboardInteractive;
        return ask ? ask({ name, instructions, prompts: list }) : null;
      })
      .then((answers) => finish(Array.isArray(answers) ? answers.slice(0, list.length) : []))
      .catch(() => finish([]));
  });
}

/**
 * 建立 SSH 连接
 * @param {object} opts {
 *   host: 服务器 IP/域名
 *   port: SSH 端口(默认 22)
 *   username: 登录用户名
 *   password: 密码(或私钥,二选一)
 *   privateKey: 私钥内容(选填)
 *   cols, rows: 终端初始尺寸
 *   onKeyboardInteractive: 处理 keyboard-interactive 挑战(可选)
 * }
 * @returns {Promise<{ conn: Client, stream: ClientChannel }>}
 *   conn   — SSH 连接对象(用来开更多通道、查状态)
 *   stream — 终端数据流(收/发终端字符)
 */
function connect(opts) {
  return new Promise((resolve, reject) => {
    const conn = new (getClient())();
    attachKbd(conn, opts);

    // 连接成功(SSH 握手+认证通过)后触发
    conn.on('ready', () => {
      // 向服务器请求一个"伪终端"(PTY),这样 vim/top 这类全屏程序才能正常工作
      conn.shell(
        { term: 'xterm-256color', cols: opts.cols || 120, rows: opts.rows || 32 },
        (err, stream) => {
          if (err) {
            // shell 申请失败也必须把 SSH 连接关掉,否则连接开着没人用 = 泄漏(旧版只 reject)
            try { conn.end(); } catch { /* ignore */ }
            return reject(err);
          }
          resolve({ conn, stream });
        }
      );
    });

    // 连接失败(网络不通/认证失败/超时)都会走这里
    conn.on('error', (err) => reject(err));

    conn.connect({
      host: opts.host,
      port: opts.port || 22,
      username: opts.username,
      password: opts.password,
      privateKey: opts.privateKey,
      passphrase: opts.passphrase, // 私钥口令(有则用)
      sock: opts.sock, // 已建立的 socket(跳板机 forwardOut 隧道),见 main.js openJumpTunnel
      hostVerifier: opts.hostVerifier, // 指纹校验(known_hosts),由调用方提供
      readyTimeout: opts.readyTimeout || 15000,
      keepaliveInterval: opts.keepaliveInterval || 10000, // 每 10 秒发心跳,防闲置被防火墙断线
      keepaliveCountMax: 8, // 连续 8 次没回应才判定掉线(大文件慢写时设备不一定及时回心跳,放宽防误杀)
      tryKeyboard: true, // 支持 keyboard-interactive 认证(域/双密码/OTP 挑战)
    });
  });
}

/**
 * 仅建立 SSH 连接(不申请 shell/终端),用于 sftp 等通道
 * @param {object} opts — 连接参数
 * @returns {Promise<Client>} — 已连好的 conn
 */
function connectRaw(opts) {
  return new Promise((resolve, reject) => {
    const conn = new (getClient())();
    attachKbd(conn, opts);
    conn.on('ready', () => resolve(conn));
    conn.on('error', (err) => reject(err));
    conn.connect({
      host: opts.host,
      port: opts.port || 22,
      username: opts.username,
      password: opts.password,
      privateKey: opts.privateKey,
      passphrase: opts.passphrase,
      sock: opts.sock,
      hostVerifier: opts.hostVerifier, // 指纹校验(known_hosts),由调用方提供
      readyTimeout: 15000,
      keepaliveInterval: 10000, // 保活:每 10 秒心跳,防闲置断线
      keepaliveCountMax: 8, // 大文件慢写放宽(设备不及时回心跳不误杀)
      tryKeyboard: true,
    });
  });
}

/**
 * 打开 SFTP 会话(用于文件传输)
 * @param {Client} conn — 已连接的 SSH 连接
 * @returns {Promise<SFTPWrapper>} — sftp 对象,提供 readdir/readFile/writeFile 等
 */
function openSftp(conn) {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) return reject(err);
      resolve(sftp);
    });
  });
}

/**
 * 非交互执行一条命令(批量操作远程机器用)
 * 和 connect() 的区别:
 *   - connect() 开的是交互式 shell(保持连接,用于终端)
 *   - execCommand() 连上 → 执行一条命令 → 收完输出 → 断开(一次性)
 * @param {object} opts — 连接参数(同 connect)
 * @param {string} command — 要执行的命令,如 'uptime'
 * @returns {Promise<{ stdout, stderr, code }>} code 是退出码(0=成功)
 */
function execCommand(opts, command) {
  return new Promise((resolve, reject) => {
    const conn = new (getClient())();
    attachKbd(conn, opts);
    let settled = false; // 防 double-settle:超时/error/close 只会结算一次
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { conn.end(); } catch { /* ignore */ }
      reject(new Error(`命令执行超时(30s): ${command.slice(0, 80)}`));
    }, 30000);
    const settle = (fn, v) => { if (settled) return; settled = true; clearTimeout(timer); fn(v); };

    conn.on('ready', () => {
      // conn.exec = 请服务器非交互执行这条命令,返回输出流
      conn.exec(command, (err, stream) => {
        if (err) {
          conn.end();
          return settle(reject, err);
        }
        let stdout = '';
        let stderr = '';
        let code = null;
        stream.on('data', (d) => { stdout += d.toString(); });       // 标准输出
        stream.stderr.on('data', (d) => { stderr += d.toString(); }); // 标准错误
        stream.on('close', (exitCode) => {                            // 命令结束
          code = exitCode;
          conn.end();
          settle(resolve, { stdout, stderr, code });
        });
      });
    });

    conn.on('error', (err) => settle(reject, err));

    conn.connect({
      host: opts.host,
      port: opts.port || 22,
      username: opts.username,
      password: opts.password,
      privateKey: opts.privateKey,
      passphrase: opts.passphrase,
      sock: opts.sock,
      hostVerifier: opts.hostVerifier, // 指纹校验(known_hosts),由调用方提供
      readyTimeout: 15000,
      keepaliveInterval: 10000, // 保活:每 10 秒心跳,防闲置断线
      keepaliveCountMax: 8, // 大文件慢写放宽(设备不及时回心跳不误杀)
      tryKeyboard: true,
    });
  });
}

module.exports = {
  connect,
  connectRaw,
  openSftp,
  execCommand,
  warmup,
};
