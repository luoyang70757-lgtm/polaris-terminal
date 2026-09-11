'use strict';
/**
 * verify-transfer-cancel.js — 取消传输:半成品保留 + 续传点可续(纯 lib,无需 electron)
 *   旧版:watchdog 命中取消只 destroy 流、不结算 → ws 'close' 把 promise resolve 成"成功"
 *        → 走校验分支把半成品 unlink、也记不下续传点(见 docs/issues-2026-09-11.md 第 2 条)。
 *   本测试用手写假 sftp 精确控制时序(数据流"走一点就停"),断言:
 *     ① 上传取消 → reject(code=CANCELLED)、流被销毁、已写字节仍在(未删)、**校验分支未触发**
 *     ② 取消后按真实已写字节能续传(resolveUploadOffset 给出非 0 偏移)
 *     ③ 下载取消 → reject(code=CANCELLED) 且**本地半成品文件仍在**(未被 settle() 删掉)
 *     ④ 正向对照:非取消的真失败仍按原逻辑(下载大小不符 → 删残留 + 报错)
 * 运行: node verify-transfer-cancel.js
 */
const fs = require('fs'); const os = require('os'); const path = require('path');
const { EventEmitter } = require('events');
const { Readable } = require('stream');
const sshClient = require('./lib/ssh-client');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-cancel-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0;
const ok = (n) => { passed++; console.log('  ✓ ' + n); };
const bad = (n, e) => { failed++; console.error('  ✗ ' + n + (e ? ' → ' + e : '')); };

// 假 sftp:写流"收下数据但不结束"(模拟传输中的大文件),便于在传输途中精确取消
function fakeSftpForUpload() {
  const state = { bytes: 0, destroyed: 0, statCalls: 0, unlinked: 0 };
  return {
    state,
    createWriteStream() {
      const ws = new EventEmitter();
      // 返回 false = 缓冲区满 → pipe 会暂停源流(模拟慢链路),这样"半成品"才是真的部分数据
      ws.write = (chunk) => { state.bytes += chunk.length; return state.bytes < 1024 * 1024; };
      ws.end = () => {};
      ws.destroy = () => { state.destroyed++; };
      return ws;
    },
    stat(_p, cb) { state.statCalls++; cb(null, { size: state.bytes }); }, // 校验/对账才走到这里
    unlink(_p, cb) { state.unlinked++; cb(null); },
  };
}
// 假 sftp:读流先给 1KB 就停(模拟慢链路),用于取消下载
function fakeSftpForDownload(total) {
  const state = { destroyed: 0, unlinked: 0 };
  return {
    state,
    stat(_p, cb) { cb(null, { size: total }); },
    createReadStream() {
      let sent = false;
      const rs = new Readable({
        read() {
          if (sent) return; // 只推一次,之后不再有数据(= 传输停滞,交由 watchdog 处理)
          sent = true;
          setTimeout(() => { try { this.push(Buffer.alloc(1024, 7)); } catch { /* ignore */ } }, 10);
        },
      });
      const origDestroy = rs.destroy.bind(rs);
      rs.destroy = (e) => { state.destroyed++; return origDestroy(e); };
      return rs;
    },
  };
}

(async () => {
  console.log('\n=== 取消传输:半成品保留 + 可续传 ===\n');
  // 本地 8MB 文件(远大于假流"暂停点",保证取消发生在传输途中)
  const local = path.join(DIR, 'big.bin');
  fs.writeFileSync(local, Buffer.alloc(8 * 1024 * 1024, 3));
  const localMtimeMs = fs.statSync(local).mtimeMs;

  // ---- ① 上传取消 ----
  {
    const sftp = fakeSftpForUpload();
    let cancelNow = false;
    const p = sshClient.uploadFile(sftp, local, '/remote/big.bin', null, 0, () => cancelNow);
    await sleep(120);          // 让数据流先写进去一点
    cancelNow = true;          // 用户点「取消」
    let err = null;
    try { await p; } catch (e) { err = e; }
    if (err && err.code === 'CANCELLED') ok('上传取消 → reject(code=CANCELLED)');
    else bad('上传取消未 reject CANCELLED(旧版会 resolve 成成功)', err ? `${err.code || ''} ${err.message}` : 'resolved 成功');
    if (sftp.state.destroyed > 0) ok('写流已销毁(传输确实中止)');
    else bad('写流未销毁', String(sftp.state.destroyed));
    const totalBytes = fs.statSync(local).size;
    if (sftp.state.bytes > 0 && sftp.state.bytes < totalBytes) ok(`远端半成品保留(${sftp.state.bytes} / ${totalBytes} 字节,未删除)`);
    else bad('半成品字节数不符预期(应为部分)', JSON.stringify({ got: sftp.state.bytes, total: totalBytes }));
    if (sftp.state.statCalls === 0 && sftp.state.unlinked === 0) ok('未进入校验/删除分支(stat 与 unlink 都未被调用)');
    else bad('走了校验/删除分支(半成品会被清掉)', JSON.stringify({ stat: sftp.state.statCalls, unlink: sftp.state.unlinked }));
    // ---- ② 用真实已写字节续传 ----
    const off = sshClient.resolveUploadOffset({ bytes: sftp.state.bytes, mtimeMs: localMtimeMs }, localMtimeMs, sftp.state.bytes);
    if (off === sftp.state.bytes && off > 0 && off < totalBytes) ok(`取消后可续传:偏移 ${off} 字节(0 < off < 总量 ${totalBytes})`);
    else bad('取消后无法续传', JSON.stringify({ off, total: totalBytes }));
  }

  // ---- ③ 下载取消:本地半成品必须还在 ----
  {
    const sftp = fakeSftpForDownload(8 * 1024 * 1024);
    const lp = path.join(DIR, 'big-dl.bin');
    let cancelNow = false;
    const p = sshClient.downloadFile(sftp, '/remote/big.bin', lp, null, 0, () => cancelNow);
    await sleep(120);
    cancelNow = true;
    let err = null;
    try { await p; } catch (e) { err = e; }
    await sleep(300); // 给 ws 'close' 回调留出时间(旧版正是在这里 unlink 半成品)
    if (err && err.code === 'CANCELLED') ok('下载取消 → reject(code=CANCELLED)');
    else bad('下载取消未 reject CANCELLED', err ? `${err.code || ''} ${err.message}` : 'resolved 成功');
    const exists = fs.existsSync(lp);
    const size = exists ? fs.statSync(lp).size : 0;
    if (exists && size > 0) ok(`本地半成品仍在(${size} 字节,未被删)`);
    else bad('本地半成品被删除(旧 bug:settle() 按大小不符 unlink)', JSON.stringify({ exists, size }));
    const off2 = sshClient.resolveDownloadOffset({ bytes: size }, size);
    if (off2 === size && size > 0) ok(`取消后可续传:下载偏移 ${off2} 字节`);
    else bad('下载取消后无法续传', String(off2));
  }

  // ---- ④ 正向对照:真失败(读完但大小不符)仍删残留 + 报错 ----
  {
    const total = 4096;
    const sftp = {
      stat(_p, cb) { cb(null, { size: total }); },
      createReadStream() {
        let sent = false;
        return new Readable({
          read() {
            if (sent) return;
            sent = true;
            setTimeout(() => { try { this.push(Buffer.alloc(1024, 1)); this.push(null); } catch { /* ignore */ } }, 10); // 只给 1KB(远端 4KB)后 EOF
          },
        });
      },
    };
    const lp = path.join(DIR, 'trunc.bin');
    let err = null;
    try { await sshClient.downloadFile(sftp, '/remote/trunc.bin', lp, null, 0, null); } catch (e) { err = e; }
    if (err && /下载校验失败/.test(err.message)) ok('真失败:报「下载校验失败」');
    else bad('真失败未按预期报错', err ? err.message : 'resolved');
    if (!fs.existsSync(lp)) ok('真失败:残缺文件已删除(与取消区分开)');
    else bad('真失败残留未删', String(fs.statSync(lp).size));
  }

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(failed ? 1 : 0);
})();
