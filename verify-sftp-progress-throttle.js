'use strict';
/**
 * verify-sftp-progress-throttle.js — 传输进度节流器(lib/sftp-progress-throttle.js)单测
 *
 * 验证大文件进度节流核心语义:
 *  ① 节流:窗口内连续 N 条进度只发 1 条(模拟高速链路 64KB 块洪水,渲染层不再被打满)
 *  ② flush 补发:窗口内被压住的最后一条在 flush 时补发(进度条走到真实终态)
 *  ③ flush 清理:flush 后条目删除,同一 job 再发进度是新窗口(防 Map 泄漏)
 *  ④ 多 job 隔离:A 的节流不影响 B 的发送节奏
 *  ⑤ 无 jobId 兜底:不节流、直接发
 * 运行: node verify-sftp-progress-throttle.js(纯模块单测,无 ssh/electron,秒级)
 */
const { createProgressThrottle } = require('./lib/sftp-progress-throttle');

let passed = 0, failed = 0;
const ok = (n) => { passed++; console.log('  ✓ ' + n); };
const bad = (n, e) => { failed++; console.error('  ✗ ' + n + (e ? ' -> ' + e : '')); };

(async () => {
  // ① 节流:同一 job 在窗口内连发 20 条 → 只发 1 条,其余进 pending
  {
    const sent = [];
    const t = createProgressThrottle({ send: (p) => sent.push(p), intervalMs: 50 });
    for (let i = 1; i <= 20; i++) t.emit({ jobId: 'u1', done: i * 100, total: 2000 });
    const sentCount = sent.length;
    if (sentCount === 1 && sent[0].done === 100) ok('① 节流:窗口内 20 条只发 1 条,其余进 pending');
    else bad('① 节流', `sent=${sentCount}, first.done=${sent[0] && sent[0].done}`);
  }

  // ② flush 补发:窗口内最后一条(最新进度)在 flush 时发出
  {
    const sent = [];
    const t = createProgressThrottle({ send: (p) => sent.push(p), intervalMs: 50 });
    t.emit({ jobId: 'u2', done: 100, total: 2000 });
    t.emit({ jobId: 'u2', done: 2000, total: 2000 }); // 被窗口压住:最终 100%
    t.flush('u2');
    const last = sent[sent.length - 1];
    if (sent.length === 2 && last.done === 2000 && last.total === 2000) ok('② flush 补发最后一条(100%)');
    else bad('② flush 补发', `sent=${sent.length}, last.done=${last && last.done}`);
  }

  // ③ flush 清理:flush 后条目删除,同 job 再发是新窗口(立即发)
  {
    const sent = [];
    const t = createProgressThrottle({ send: (p) => sent.push(p), intervalMs: 10000 });
    t.emit({ jobId: 'u3', done: 1, total: 10 });
    t.flush('u3');
    if (t._entries.size !== 0) bad('③ flush 清理', `entries=${t._entries.size}`);
    t.emit({ jobId: 'u3', done: 2, total: 10 }); // 已清理,不节流,直接发
    const ok3 = t._entries.size === 1 && sent.length === 2 && sent[1].done === 2;
    if (ok3) ok('③ flush 清理后同 job 再发为新窗口');
    else bad('③ flush 清理', `entries=${t._entries.size}, sent=${sent.length}`);
  }

  // ④ 多 job 隔离:job A 被节流时,job B 的首次发送不被压制
  {
    const sent = [];
    const t = createProgressThrottle({ send: (p) => sent.push(p), intervalMs: 10000 });
    t.emit({ jobId: 'A', done: 1, total: 10 });
    t.emit({ jobId: 'A', done: 2, total: 10 });
    t.emit({ jobId: 'B', done: 1, total: 10 }); // 另一 job 立即发
    if (sent.length === 2 && sent[1].jobId === 'B') ok('④ 多 job 隔离互不影响');
    else bad('④ 多 job 隔离', `sent=${sent.map((s) => s.jobId).join(',')}`);
  }

  // ⑤ 无 jobId 兜底:直接发,不节流
  {
    const sent = [];
    const t = createProgressThrottle({ send: (p) => sent.push(p), intervalMs: 10000 });
    t.emit({ done: 1, total: 10 });
    t.emit({ done: 2, total: 10 });
    if (sent.length === 2) ok('⑤ 无 jobId 兜底直接发');
    else bad('⑤ 无 jobId 兜底', `sent=${sent.length}`);
  }

  // ⑥ 文件切换立即发:同 job 窗口内不同 file(递归/多文件上传)每条都发,保证面板逐文件行
  {
    const sent = [];
    const t = createProgressThrottle({ send: (p) => sent.push(p), intervalMs: 10000 });
    t.emit({ jobId: 'u6', file: 'a.txt', done: 1, total: 10 });
    t.emit({ jobId: 'u6', file: 'b.txt', done: 1, total: 10 }); // 同窗口但换文件 → 立即发
    t.emit({ jobId: 'u6', file: 'b.txt', done: 5, total: 10 }); // 同文件 → 被节流
    t.emit({ jobId: 'u6', file: 'c.txt', done: 1, total: 10 }); // 换文件 → 立即发
    if (sent.length === 3 && sent.map((s) => s.file).join(',') === 'a.txt,b.txt,c.txt')
      ok('⑥ 文件切换立即发(每文件至少一条)');
    else bad('⑥ 文件切换', `sent=${sent.map((s) => s.file).join(',')}`);
  }

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  process.exit(failed ? 1 : 0);
})();
