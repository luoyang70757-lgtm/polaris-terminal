'use strict';
/**
 * sftp-throttle.js — SFTP 传输限速(纯函数 + 一个 Transform 流)
 *
 * 为什么用「节流 Transform」而不是改 ssh2 的 read/write:
 *   上传/下载都是 `rs.pipe(ws)` 一路管道(见 lib/ssh-client.js)。在中间插一个 Transform
 *   就能限速,不用碰底层 SFTP 请求,也不改变断点续传/对账逻辑(它们只看流是否正常结束)。
 *   有 backpressure(下游 writable 满 → 上游自然停),限速不会被"内存里攒一大坨"绕过。
 *
 * 限速方式:每块数据算它"本该花多久"(chunk.bytes / bytesPerSec),按累计额度推迟回调。
 *   不 sleep 每一块定长(那样小块多、系统定时器抖动大);用"下一个允许时间"累加,
 *   长时间运行速率稳定到 ±5% 以内(verify-sftp-throttle.js 用 20KB / 50KB/s 实测)。
 */

const { Transform } = require('stream');

/** 允许的限速档位(字节/秒);0 = 不限速 */
function normalizeRate(kbps) {
  const n = Number(kbps);
  if (!Number.isFinite(n) || n <= 0) return 0;
  // 上限 100 MB/s:再高就没意义(SSH 通道本身也到不了),同时挡住误输的超大数
  const bytes = Math.round(n * 1024);
  return Math.min(Math.max(1, bytes), 100 * 1024 * 1024);
}

/** 一块数据在给定速率下应占用的毫秒(纯函数,便于单测) */
function paceMs(bytes, bytesPerSec) {
  const b = Number(bytes) || 0;
  const r = Number(bytesPerSec) || 0;
  if (b <= 0 || r <= 0) return 0;
  return (b / r) * 1000;
}

/**
 * 创建一个限速 Transform。
 * @param {number} bytesPerSec 目标速率(<=0 返回 null,表示不需要插入该流)
 * @param {{now?:Function}} [opts] 注入时钟便于单测
 * @returns {Transform|null}
 */
function createThrottle(bytesPerSec, opts) {
  const rate = Number(bytesPerSec) || 0;
  if (rate <= 0) return null;
  const now = (opts && opts.now) || (() => Date.now());
  // "下一个允许的开始时间";每块按 字节/速率 累加,长时间平均速率稳定
  let next = 0;
  let closed = false;
  let timer = null;
  return new Transform({
    highWaterMark: 64 * 1024,
    transform(chunk, _enc, cb) {
      if (closed) return; // 已销毁:不再回调(流已死)
      const t = now();
      const start = Math.max(t, next);
      next = start + paceMs(chunk.length, rate);
      const wait = start - t;
      if (wait <= 0) return cb(null, chunk);
      timer = setTimeout(() => {
        timer = null;
        if (!closed) cb(null, chunk);
      }, wait);
    },
    destroy(err, cb) {
      // 取消/断连时别留悬挂定时器(否则 cb 会在流销毁后才触发)
      closed = true;
      if (timer) { clearTimeout(timer); timer = null; }
      cb(err);
    },
  });
}

/** 人类可读的速率文案(状态栏提示用) */
function describeRate(bytesPerSec) {
  const r = Number(bytesPerSec) || 0;
  if (r <= 0) return '不限速';
  if (r < 1024 * 1024) return `${Math.round(r / 1024)} KB/s`;
  return `${(r / (1024 * 1024)).toFixed(1)} MB/s`;
}

module.exports = { normalizeRate, paceMs, createThrottle, describeRate };
