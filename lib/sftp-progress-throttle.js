'use strict';
/**
 * lib/sftp-progress-throttle.js — SFTP 传输进度节流器
 *
 * 背景:底层流(ssh2 SFTP)按 64KB 块回调,大文件在高速链路上每秒产生上千个进度事件。
 * 若全量推给渲染层,渲染层每条都要做同步 DOM 写(进度条宽/文本),主线程被打满 →
 * 界面卡死、进度条定格,且 sftp:done 被排在几千条 progress 后面、传输早完成却迟迟不刷新。
 *
 * 做法:按 job 每 intervalMs 最多发一条,窗口内的新事件只记 pending(最新进度);
 * 传输完成时调用方 flush(jobId) 补发最后一条并清理条目。进度条既平滑(≈10 条/秒),
 * 又能走到真实终态(不至于停在 95%)。
 *
 * send 由调用方注入(main.js 里是 webContents.send),本模块不依赖 electron,便于单测。
 */
function createProgressThrottle({ send, intervalMs = 100 } = {}) {
  const entries = new Map(); // jobId → { lastTs, pending }
  return {
    /** 记一条进度;jobId 为空时不做节流(兜底,当前调用方都带 jobId) */
    emit(payload) {
      if (!send) return;
      if (!payload.jobId) { send(payload); return; }
      const now = Date.now();
      const st = entries.get(payload.jobId);
      if (st && now - st.lastTs < intervalMs) {
        st.pending = payload; // 距上次发送不足节流窗口:只更新最新进度,暂缓发送
        return;
      }
      entries.set(payload.jobId, { lastTs: now, pending: null });
      send(payload);
    },
    /** 传输完成/失败/取消时补发最后一条被节流的进度,然后删掉条目(防 Map 泄漏) */
    flush(jobId) {
      const st = entries.get(jobId);
      if (!st) return;
      if (st.pending && send) send(st.pending);
      entries.delete(jobId);
    },
    _entries: entries, // 仅供测试/调试
  };
}

module.exports = { createProgressThrottle };
