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
      keepaliveCountMax: 8, // 大文件慢写放宽(设备不及时回心跳不误杀)
      tryKeyboard: true,
    });
  });
}

// ---------- 带进度的流式传输 ----------
// 统一用 createReadStream/createWriteStream 而不是 fastPut/fastGet —— 前者能在数据流过时
// 回调字节数,驱动界面进度条。onProgress(done, total) 为每块数据回调(done 是本次文件的累计字节)。
//
// 断点续传:resumeFrom > 0 时,本地读流/远端写流都从该偏移起(ssh2 的 SFTP WriteStream 支持
// { flags:'r+', start } 绝对偏移续写,ReadStream 支持 { start } 区间读取),进度也从该偏移计。
// 只续传"本次会话里我们自己中断过"的传输 —— 是否续传由调用方(main.js)用 sftpPartials
// 记录 + 下方两个纯决策函数判定,绝不按 size 猜同名既有文件(那会拼脏文件)。

// stat 失败返回 null(区别于真实 0 字节):调用方据此区分「设备不支持 stat、无法对账」和「对账到 0」,
// 避免把 0 字节误判成对账一致(上传校验曾被 0 静默放过,见 uploadFile verify)。
function statSize(sftp, remotePath) {
  return new Promise((res) => sftp.stat(remotePath, (e, st) => res(e ? null : (st && st.size) || 0)));
}

// 读回远端文件核对:部分设备 SFTP 的 stat/readdir 对已写入文件恒报 0(内容其实在)。
// 全量读回并逐字节对比本地:一致 → 数据确实落盘,是设备 stat 骗人 → 视为上传成功(不删文件);
// 不一致/读不到 → 真没传上,由调用方删残缺文件并报错。读回只在 stat 不符时兜底,正常路径不触发。
// 大文件读回核对上限:超过则跳过(全量读回在串行 SFTP 上耗时极长且内存吃满;
// 写入流完整结束已是强证据,失败会在 write stream 上报错)。小文件仍完整核对。
const MAX_VERIFY_READBACK = 100 * 1024 * 1024; // 100MB

function verifyByReadback(sftp, remotePath, localPath, total) {
  const fs = require('fs');
  if (total > MAX_VERIFY_READBACK) return Promise.resolve({ ok: true, got: total, skipped: true });
  return new Promise((resolve) => {
    // 流式哈希逐块比对,不整文件缓存(旧版 Buffer.concat 大文件吃 2 倍内存 → OOM/卡死)
    const crypto = require('crypto');
    const localHash = crypto.createHash('sha256');
    const remoteHash = crypto.createHash('sha256');
    let got = 0;
    const lr = fs.createReadStream(localPath);
    lr.on('data', (c) => localHash.update(c));
    lr.on('error', () => resolve({ ok: false, got: -1 }));
    lr.on('end', () => {
      const rs = sftp.createReadStream(remotePath);
      rs.on('data', (c) => { remoteHash.update(c); got += c.length; });
      rs.on('error', () => resolve({ ok: false, got: -1 }));
      rs.on('end', () => resolve({ ok: got === total && localHash.digest('hex') === remoteHash.digest('hex'), got }));
    });
  });
}

// 断点续传决策(纯函数,便于无 electron 单测):
//   上传:中断点记录 partial={bytes, mtimeMs},本地 mtime 变过 / 远端被删或被改小 → 前缀不可信,返回 0(全量重传)
function resolveUploadOffset(partial, localMtimeMs, remoteSize) {
  if (!partial) return 0;
  if (partial.mtimeMs !== localMtimeMs) return 0;
  if (!remoteSize || remoteSize < partial.bytes) return 0;
  return partial.bytes;
}

// 下载:本地残留大小必须恰好等于中断点(说明那份残留是我们传的),否则返回 0
function resolveDownloadOffset(partial, localSize) {
  if (!partial) return 0;
  if (localSize !== partial.bytes) return 0;
  return partial.bytes;
}

// 上传单个文件(本地 → 远程),onProgress(done, total) 每块数据回调,resumeFrom=断点续传偏移(默认 0=全量)
// 传完 statSize 对账远端实际大小:进度按本地读字节数算、必然到 100%,但堡垒机中继(KoKo 等)
// 偶发"ACK 了 WRITE、尾部没落到目标"导致远端比本地小 —— 不能只信进度。不符 → 全量重传一次
// (不用续传,残留前缀可能缺块);仍不符 → 删远端残缺文件 + 明确报错,绝不静默丢数据。
function uploadFile(sftp, localPath, remotePath, onProgress, resumeFrom) {
  const fs = require('fs');
  const total = fs.statSync(localPath).size;
  resumeFrom = Math.min(Math.max(0, resumeFrom || 0), total);
  // 单次管道执行;from>0 从偏移续写(r+),否则全量截断重建(w)
  const runOnce = (from) => new Promise((resolve, reject) => {
    let done = from;
    const rs = fs.createReadStream(localPath, from > 0 ? { start: from } : undefined);
    const ws = from > 0
      ? sftp.createWriteStream(remotePath, { flags: 'r+', start: from })
      : sftp.createWriteStream(remotePath);
    rs.on('error', (e) => reject(new Error(`${localPath} → ${remotePath}: ${e.message}`)));
    ws.on('error', (e) => reject(new Error(`${localPath} → ${remotePath}: ${e.message}`)));
    rs.on('data', (c) => { done += c.length; if (onProgress) onProgress(done, total); });
    rs.pipe(ws);
    ws.on('close', () => resolve());
    ws.on('finish', () => resolve());
  });
  // verify 返回三态:null=对账一致;{unverifiable}=stat 失败(设备不支持,无法对账,按成功);
  // 数值=真实不符(含远端 0 字节 —— 旧逻辑 `if (!badSize)` 把 0 当成功,0 字节上传被静默放过)。
  const verify = () => statSize(sftp, remotePath).then((remoteSize) => {
    if (remoteSize === null) return { unverifiable: true };
    return remoteSize === total ? null : remoteSize;
  });
  // 读回核对:只有"读回成功且字节数确实不符"(真截断)才判失败删文件;
  // 读回流报错(got=-1,如 H3C 设备不支持读回)不能证明上传失败 → 信任写入流成功,不删文件。
  const readbackOrFail = () => verifyByReadback(sftp, remotePath, localPath, total).then((rb) => {
    if (rb.ok) return;
    if (rb.got === -1) return; // 读回流出错:设备限制,无法核对,但写入流已完成 → 按成功
    return new Promise((res) => sftp.unlink(remotePath, () => res())).then(() => {
      throw new Error(`上传校验失败:远端 ${rb.got}B ≠ 本地 ${total}B(读回不一致,已删除远端残缺文件,请重试)`);
    });
  });
  return runOnce(resumeFrom).then(verify).then((badSize) => {
    if (badSize === null || (badSize && badSize.unverifiable)) return;
    // stat 报 0:H3C 等设备对已写入文件恒报 0(数据其实在)。写入流已完整结束 = 数据已落盘,
    // 此时 stat=0 是设备撒谎,不是失败;真 0 字节写入会在 write stream 上报错。
    // 直接信任成功,不再读回(读回在 H3C 上也会报错,白耗一次全量读)。
    if (badSize === 0) return;
    // stat 报非 0 但≠本地 → 真实部分写入:全量重传一次再对账,仍不符再读回
    return runOnce(0).then(verify).then((badSize2) => {
      if (badSize2 === null || (badSize2 && badSize2.unverifiable)) return;
      return readbackOrFail();
    });
  });
}

// 下载单个文件(远程 → 本地),onProgress(done, total) 每块数据回调,resumeFrom=断点续传偏移(默认 0=全量)
// 落盘后对账本地实际大小:中继偶发读截断时本地会比远端小,删残留 + 明确报错,不静默丢数据。
function downloadFile(sftp, remotePath, localPath, onProgress, resumeFrom) {
  const fs = require('fs');
  return statSize(sftp, remotePath).then((total) => new Promise((resolve, reject) => {
    resumeFrom = Math.min(Math.max(0, resumeFrom || 0), total);
    let done = resumeFrom;
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      const got = fs.statSync(localPath).size;
      if (got === total) return resolve();
      try { fs.unlinkSync(localPath); } catch { /* ignore */ }
      reject(new Error(`下载校验失败:本地 ${got}B ≠ 远端 ${total}B(已删除残缺文件,请重试)`));
    };
    const rs = sftp.createReadStream(remotePath, resumeFrom > 0 ? { start: resumeFrom } : undefined);
    const ws = resumeFrom > 0
      ? fs.createWriteStream(localPath, { flags: 'r+', start: resumeFrom }) // 在本地残留之后续写
      : fs.createWriteStream(localPath);
    rs.on('error', (e) => reject(new Error(`${remotePath} → ${localPath}: ${e.message}`)));
    ws.on('error', (e) => reject(new Error(`${remotePath} → ${localPath}: ${e.message}`)));
    rs.on('data', (c) => { done += c.length; if (onProgress) onProgress(done, total); });
    rs.pipe(ws);
    ws.on('close', () => settle());
    ws.on('finish', () => settle());
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

// 并发池:最多同时跑 limit 个,结果按下标顺序返回(SSH2 单通道支持并发流,目录批量传输用它提速)
// 并发不宜过大:H3C 等网络设备 SFTP 串行处理,4 路并发写会互相排队/冲突 → 大文件/多目录上传失败。
// 降到 2:普通服务器仍有并行,串行设备也扛得住。
const SFTP_CONCURRENCY = 2;
async function mapConcurrent(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

// 递归上传本地目录到远程,onProgress({done,total,file,filesDone,filesTotal}) 驱动进度条
// 返回 { uploaded:[远程路径], failed:[{rp,error}] }:单个文件失败不中断整个目录,汇总给界面显示全名
// resumeFromOf(lp, rp) = 每个文件应续传的偏移(默认 0=全量);onFileError(lp, rp) = 单文件失败后的钩子(记录中断点,供重试续传)
async function uploadDir(sftp, localDir, remoteDir, onProgress, resumeFromOf, onFileError) {
  const fs = require('fs');
  const path = require('path');
  resumeFromOf = resumeFromOf || (() => 0);
  await new Promise((res) => sftp.mkdir(remoteDir, () => res())); // 目标目录不存在则建(已存在忽略)
  const files = await walkLocal(localDir, remoteDir);
  const total = files.reduce((s, f) => s + f.size, 0);
  // 先把所有父目录一次性建好(去重 + 按深浅排序,浅的在前):并发传文件时目录不存在引发的失败就没了
  const dirs = [...new Set(files.map((f) => path.posix.dirname(f.rp)))].filter((d) => d && d !== '.' && d !== '/');
  dirs.sort((a, b) => a.split('/').length - b.split('/').length);
  for (const d of dirs) await new Promise((res) => sftp.mkdir(d, () => res()));
  let done = 0, finished = 0;
  const uploaded = [], failed = [];
  await mapConcurrent(files, SFTP_CONCURRENCY, async (f, i) => {
    let last = 0;
    try {
      const rFrom = await resumeFromOf(f.lp, f.rp); // 该文件若有中断点则从那里续,否则全量
      await uploadFile(sftp, f.lp, f.rp, (d) => { done += (d - last); last = d; if (onProgress) onProgress({ done, total, file: f.rp, fileDone: d, fileTotal: f.size, filesDone: finished, filesTotal: files.length }); }, rFrom);
      uploaded.push({ rp: f.rp, size: f.size });
    } catch (e) {
      failed.push({ rp: f.rp, error: e.message || String(e) }); // 单文件失败继续传下一个,失败全名留给界面
      if (onFileError) { try { onFileError(f.lp, f.rp); } catch { /* 中断点记不下来不影响主流程 */ } }
    }
    finished++;
    // 每文件完成后补一发:保证空文件/末块也有一行 100% 进度(Xshell 式逐文件进度条)
    if (onProgress) onProgress({ done, total, file: f.rp, fileDone: f.size, fileTotal: f.size, filesDone: finished, filesTotal: files.length });
  });
  return { uploaded, failed };
}

// 递归下载远程目录到本地,onProgress({done,total,file,filesDone,filesTotal}) 驱动进度条
async function downloadDir(sftp, remoteDir, localDir, onProgress) {
  const fs = require('fs');
  const path = require('path');
  fs.mkdirSync(localDir, { recursive: true });
  const files = await walkRemote(sftp, remoteDir, localDir);
  const total = files.reduce((s, f) => s + f.size, 0);
  let done = 0, finished = 0;
  const locals = new Array(files.length);
  await mapConcurrent(files, SFTP_CONCURRENCY, async (f, i) => {
    fs.mkdirSync(path.dirname(f.lp), { recursive: true });
    let last = 0;
    await downloadFile(sftp, f.rp, f.lp, (d) => { done += (d - last); last = d; if (onProgress) onProgress({ done, total, file: f.rp, fileDone: d, fileTotal: f.size, filesDone: finished, filesTotal: files.length }); });
    locals[i] = f.lp;
    finished++;
    if (onProgress) onProgress({ done, total, file: f.rp, fileDone: f.size, fileTotal: f.size, filesDone: finished, filesTotal: files.length });
  });
  return locals;
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

module.exports = { connect, connectRaw, openSftp, execCommand, uploadFile, downloadFile, uploadDir, downloadDir, walkRemote, rmdirRecursive, statSize, resolveUploadOffset, resolveDownloadOffset, mapConcurrent, SFTP_CONCURRENCY };
