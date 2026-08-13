'use strict';
/**
 * verify-boot.js — 验证解锁后科幻开机过场(正式版 ?boot=1):
 *  ① 主窗口加载后 boot-overlay 揭开(非 hidden)
 *  ② ~2.4s 内过场结束,overlay 被移除,主界面可用
 * 运行: node verify-boot.js(需 9352 空闲;注意:无 --dev → DEV_MODE=false → 播放过场)
 */
const { spawn } = require('child_process');
const { freePort, killTree, guardTimeout } = require('./test-helper');
const fs = require('fs'); const os = require('os'); const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-boot-'));
const PORT = 9352;
freePort(PORT);
// 不传 --dev:正式版路径(带 ?boot=1),验证过场真会播
const appProc = spawn('node_modules/.bin/electron', ['.', `--remote-debugging-port=${PORT}`], {
  env: { ...process.env, POLARIS_LOCK_DIR: DIR, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  stdio: ['ignore', 'ignore', 'ignore'], detached: true,
});
guardTimeout(120000, appProc);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function targets() {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json`); const j = await r.json(); const p = j.find((t) => t.type === 'page' && /解锁|Polaris/.test(t.title || '')); if (p) return j; } catch {}
    await sleep(400);
  }
  throw new Error('targets 未就绪');
}
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url); let id = 0; const pending = new Map();
    ws.onopen = () => resolve({ call(m, p = {}) { return new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method: m, params: p })); }); }, close() { ws.close(); } });
    ws.onerror = (e) => reject(e);
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };
  });
}
async function ev(c, expr) {
  const r = await c.call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('JS异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 600) + ' @ ' + expr.slice(0, 90));
  return r.result && r.result.value;
}
let passed = 0, failed = 0;
const ok = (n) => { passed++; console.log('  ✓ ' + n); };
const bad = (n, e) => { failed++; console.error('  ✗ ' + n + (e ? ' -> ' + e : '')); };

(async () => {
  console.log('\n=== 解锁后科幻开机过场 ===\n');
  try {
    const ts = await targets();
    const lockT = ts.find((t) => /解锁/.test(t.title || ''));
    const lock = await connect(lockT.webSocketDebuggerUrl);
    for (let i = 0; i < 30; i++) { if (await ev(lock, `!!document.getElementById('pw')`)) break; await sleep(300); }
    await sleep(400);
    // 首次运行:设置密码并进入
    await ev(lock, `document.getElementById('pw').value='x1234'; document.getElementById('pw2').value='x1234'; document.getElementById('btn').click();`);
    let main = null, c = null;
    for (let i = 0; i < 30; i++) { await sleep(500); const t2 = await targets(); const m = t2.find((t) => t.type === 'page' && !/解锁/.test(t.title || '')); if (m) { main = m; break; } }
    c = await connect(main.webSocketDebuggerUrl);

    // ① 过场应立即揭开:轮询捕获"非 hidden"状态(过场约 2.4s,别错过)
    let sawVisible = false;
    for (let i = 0; i < 12; i++) {
      const st = await ev(c, `(function(){ const o=document.getElementById('boot-overlay'); return o?JSON.stringify({hidden:o.classList.contains('hidden'),gone:false}):JSON.stringify({gone:true}); })()`);
      const s = JSON.parse(st);
      if (s.gone) break; // 已移除(太快?)——若从没看见过也算失败
      if (!s.hidden) { sawVisible = true; break; }
      await sleep(150);
    }
    if (sawVisible) ok('解锁后主窗口揭开科幻过场(boot-overlay 非 hidden)');
    else bad('未观察到过场揭开(overlay hidden 或已移除)', null);

    // ② 过场结束:overlay 被移除,主界面工具栏可用
    let gone = false;
    for (let i = 0; i < 40; i++) {
      const st = await ev(c, `(function(){ const o=document.getElementById('boot-overlay'); return o?JSON.stringify({gone:false}):JSON.stringify({gone:true}); })()`);
      if (JSON.parse(st).gone) { gone = true; break; }
      await sleep(150);
    }
    const uiAlive = await ev(c, `!!document.getElementById('main-view') && !!document.querySelector('.toolbar')`);
    if (gone && uiAlive) ok(`过场 ~${'2.4s'}内结束,overlay 已移除,主界面可用(toolbar 存在)`);
    else bad(`过场未正常结束: gone=${gone} uiAlive=${uiAlive}`, null);

    console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  } catch (e) { console.error('\n测试异常:', e && e.message); failed++; console.log(`\n结果: ${passed} 通过, ${failed} 失败`); }
  try { killTree(appProc); } catch {}
  process.exit(failed ? 1 : 0);
})();
