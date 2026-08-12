'use strict';
/**
 * ssh-client.js — SSH/SFTP 直连封装(替代原来的 koko-ssh.js)
 *
 * 和 KoKo 版的区别:
 *   - 不再对用户名做 "JMS用户@账号@资产" 编码,直接用真实用户名
 *   - 连接的是用户自己的服务器,而不是 JumpServer 的网关
 *
 * 这个文件是"最底层",只干一件事:建立 SSH 连接、提供终端流和 SFTP。
 * 用到的库是 ssh2(Node.js 最流行的 SSH 库,不用自己实现协议)。
 */

const { Client } = require('ssh2');

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
    const conn = new Client();
    attachKbd(conn, opts);

    // 连接成功(SSH 握手+认证通过)后触发
    conn.on('ready', () => {
      // 向服务器请求一个"伪终端"(PTY),这样 vim/top 这类全屏程序才能正常工作
      conn.shell(
        { term: 'xterm-256color', cols: opts.cols || 120, rows: opts.rows || 32 },
        (err, stream) => {
          if (err) return reject(err);
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
      keepaliveCountMax: 3, // 连续 3 次没回应才判定掉线
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
    const conn = new Client();
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
      keepaliveCountMax: 3,
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
    const conn = new Client();
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
      keepaliveCountMax: 3,
      tryKeyboard: true,
    });
  });
}

// ---------- 带进度的流式传输 ----------
// 统一用 createReadStream/createWriteStream 而不是 fastPut/fastGet —— 前者能在数据流过时
// 回调字节数,驱动界面进度条。onProgress(done, total) 为每块数据回调(done 是本次文件的累计字节)。

function statSize(sftp, remotePath) {
  return new Promise((res) => sftp.stat(remotePath, (e, st) => res(e ? 0 : (st && st.size) || 0)));
}

// 上传单个文件(本地 → 远程),onProgress(done, total) 每块数据回调
function uploadFile(sftp, localPath, remotePath, onProgress) {
  const fs = require('fs');
  const total = fs.statSync(localPath).size;
  let done = 0;
  return new Promise((resolve, reject) => {
    const rs = fs.createReadStream(localPath);
    const ws = sftp.createWriteStream(remotePath);
    rs.on('error', (e) => reject(new Error(`${localPath} → ${remotePath}: ${e.message}`)));
    ws.on('error', (e) => reject(new Error(`${localPath} → ${remotePath}: ${e.message}`)));
    rs.on('data', (c) => { done += c.length; if (onProgress) onProgress(done, total); });
    rs.pipe(ws); // 进度计数同时把数据真正流进远程文件
    ws.on('close', () => resolve());
    ws.on('finish', () => resolve());
  });
}

// 下载单个文件(远程 → 本地),onProgress(done, total) 每块数据回调
function downloadFile(sftp, remotePath, localPath, onProgress) {
  const fs = require('fs');
  return statSize(sftp, remotePath).then((total) => new Promise((resolve, reject) => {
    let done = 0;
    const rs = sftp.createReadStream(remotePath);
    const ws = fs.createWriteStream(localPath);
    rs.on('error', (e) => reject(new Error(`${remotePath} → ${localPath}: ${e.message}`)));
    ws.on('error', (e) => reject(new Error(`${remotePath} → ${localPath}: ${e.message}`)));
    rs.on('data', (c) => { done += c.length; if (onProgress) onProgress(done, total); });
    rs.pipe(ws); // 进度计数同时把数据真正落到本地文件
    ws.on('close', () => resolve());
    ws.on('finish', () => resolve());
  }));
}

// 把本地目录展开成 { lp, rp, size } 文件清单(子目录递归),远程路径按 remoteDir 前缀拼
async function walkLocal(localDir, remoteDir) {
  const fs = require('fs');
  const path = require('path');
  const files = [];
  const entries = await fs.promises.readdir(localDir, { withFileTypes: true });
  for (const ent of entries) {
    const lp = path.join(localDir, ent.name);
    const rp = (remoteDir === '/' || remoteDir === '') ? `/${ent.name}` : `${remoteDir.replace(/\/$/, '')}/${ent.name}`;
    if (ent.isDirectory()) files.push(...(await walkLocal(lp, rp)));
    else files.push({ lp, rp, size: fs.statSync(lp).size });
  }
  return files;
}

// 把远程目录展开成 { lp, rp, size } 文件清单(子目录递归),本地路径按 localDir 前缀拼
async function walkRemote(sftp, remoteDir, localDir) {
  const fs = require('fs');
  const path = require('path');
  const files = [];
  const entries = await new Promise((res, rej) => sftp.readdir(remoteDir, (e, l) => (e ? rej(e) : res(l || []))));
  for (const ent of entries) {
    const rp = (remoteDir === '/' || remoteDir === '') ? `/${ent.filename}` : `${remoteDir.replace(/\/$/, '')}/${ent.filename}`;
    const lp = path.join(localDir, ent.filename);
    const isDir = ent.attrs && typeof ent.attrs.mode === 'number' ? (ent.attrs.mode & 0o170000) === 0o040000 : false;
    if (isDir) files.push(...(await walkRemote(sftp, rp, lp)));
    else files.push({ lp, rp, size: (ent.attrs && ent.attrs.size) || 0 });
  }
  return files;
}

// 递归上传本地目录到远程,onProgress({done,total,file,filesDone,filesTotal}) 驱动进度条
// 返回 { uploaded:[远程路径], failed:[{rp,error}] }:单个文件失败不中断整个目录,汇总给界面显示全名
async function uploadDir(sftp, localDir, remoteDir, onProgress) {
  const fs = require('fs');
  const path = require('path');
  await new Promise((res) => sftp.mkdir(remoteDir, () => res())); // 目标目录不存在则建(已存在忽略)
  const files = await walkLocal(localDir, remoteDir);
  const total = files.reduce((s, f) => s + f.size, 0);
  let done = 0;
  const uploaded = [], failed = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const parent = path.posix.dirname(f.rp);
    if (parent && parent !== '.' && parent !== '/') await new Promise((res) => sftp.mkdir(parent, () => res())); // 递归建远程父目录(已存在忽略)
    try {
      await uploadFile(sftp, f.lp, f.rp, (d) => { done += d; if (onProgress) onProgress({ done, total, file: f.rp, fileDone: d, fileTotal: f.size, filesDone: i, filesTotal: files.length }); });
      uploaded.push(f.rp);
    } catch (e) {
      failed.push({ rp: f.rp, error: e.message || String(e) }); // 单文件失败继续传下一个,失败全名留给界面
    }
    // 每文件完成后补一发:保证空文件/末块也有一行 100% 进度(Xshell 式逐文件进度条)
    if (onProgress) onProgress({ done, total, file: f.rp, fileDone: f.size, fileTotal: f.size, filesDone: i + 1, filesTotal: files.length });
  }
  return { uploaded, failed };
}

// 递归下载远程目录到本地,onProgress({done,total,file,filesDone,filesTotal}) 驱动进度条
async function downloadDir(sftp, remoteDir, localDir, onProgress) {
  const fs = require('fs');
  const path = require('path');
  fs.mkdirSync(localDir, { recursive: true });
  const files = await walkRemote(sftp, remoteDir, localDir);
  const total = files.reduce((s, f) => s + f.size, 0);
  let done = 0;
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    fs.mkdirSync(path.dirname(f.lp), { recursive: true });
    await downloadFile(sftp, f.rp, f.lp, (d) => { done += d; if (onProgress) onProgress({ done, total, file: f.rp, fileDone: d, fileTotal: f.size, filesDone: i, filesTotal: files.length }); });
    if (onProgress) onProgress({ done, total, file: f.rp, fileDone: f.size, fileTotal: f.size, filesDone: i + 1, filesTotal: files.length });
  }
  return files.map((f) => f.lp);
}

// 递归删除远程目录:先删内容(文件 unlink、子目录递归)再删目录本身。
// ssh2 的 sftp.rmdir 只能删空目录,非空会返回 FAILURE("Failure")——删目录必须递归。
async function rmdirRecursive(sftp, remoteDir) {
  const entries = await new Promise((res, rej) => sftp.readdir(remoteDir, (e, l) => (e ? rej(e) : res(l || []))));
  for (const ent of entries) {
    const rp = (remoteDir === '/' || remoteDir === '') ? `/${ent.filename}` : `${remoteDir.replace(/\/$/, '')}/${ent.filename}`;
    if (ent.attrs.isDirectory()) await rmdirRecursive(sftp, rp);
    else await new Promise((res, rej) => sftp.unlink(rp, (e) => (e ? rej(e) : res())));
  }
  await new Promise((res, rej) => sftp.rmdir(remoteDir, (e) => (e ? rej(e) : res())));
}

module.exports = { connect, connectRaw, openSftp, execCommand, uploadFile, downloadFile, uploadDir, downloadDir, walkRemote, rmdirRecursive };
