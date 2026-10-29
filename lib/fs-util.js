'use strict';
/**
 * fs-util.js — 落盘工具(Windows 友好)
 *
 * atomicWriteFileSync:先写同目录临时文件再 rename 原子替换,避免崩溃/断电留下半截文件。
 * Windows 上杀软/索引器会短暂占用目标文件,rename 可能抛 EPERM/EBUSY/EACCES ——
 * 这类瞬时错误要退避重试,否则一次扫描就会让设置/指纹/中断点写入静默失败。
 */

const fs = require('fs');
const path = require('path');

function sleepSync(ms) {
  try {
    // 主进程同步短睡(仅错误重试路径使用)。SharedArrayBuffer 不可用时退化为忙等一小会儿。
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* busy wait */ }
  }
}

/**
 * 原子写文件
 * @param {string} target 目标绝对路径
 * @param {string|Buffer} data 内容
 * @param {{encoding?:string, mode?:number, retries?:number}} [opts]
 */
function atomicWriteFileSync(target, data, opts = {}) {
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  // 临时名带 pid + 时间戳:防止同目录并发写(如两个窗口/进程)互相踩临时文件
  const tmp = `${target}.tmp-${process.pid}-${Date.now().toString(36)}`;
  const writeOpts = opts.encoding ? { encoding: opts.encoding } : undefined;
  try {
    fs.writeFileSync(tmp, data, writeOpts);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw err;
  }
  const retries = opts.retries == null ? 5 : opts.retries;
  let lastErr = null;
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(tmp, target);
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      const transient = err && (err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'EACCES');
      if (!transient || i >= retries) break;
      sleepSync(40 * (i + 1)); // 40/80/120/160/200ms 退避(Windows 杀软扫描通常几十 ms)
    }
  }
  if (lastErr) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw lastErr;
  }
  if (opts.mode) { try { fs.chmodSync(target, opts.mode); } catch { /* Windows 不支持/无需 chmod */ } }
  return target;
}

module.exports = { atomicWriteFileSync, sleepSync };
