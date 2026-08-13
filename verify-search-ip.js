'use strict';
/**
 * verify-search-ip.js — 搜索框 IP 精确匹配
 * 运行: node verify-search-ip.js(需 9345 空闲)
 * 断言: 完整 IP 词 → 主机精确相等(1.10 不再误中 1.100);
 *       部分 IP(非 4 段)→ 保持子串;多词 OR;普通名称词不变
 */
const { spawn } = require('child_process');
const { freePort, killTree, guardTimeout } = require('./test-helper');
const fs = require('fs'); const os = require('os'); const path = require('path');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-ipsearch-'));
const PORT = 9345;
freePort(PORT);
const appProc = spawn('node_modules/.bin/electron', ['.', '--dev', `--remote-debugging-port=${PORT}`], {
  env: { ...process.env, POLARIS_LOCK_DIR: DIR, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  stdio: ['ignore', 'ignore', 'ignore'], detached: true,
});
guardTimeout(90000, appProc);
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
  if (r.exceptionDetails) throw new Error('JS异常: ' + JSON.stringify(r.exceptionDetails.exception && r.exceptionDetails.exception.description));
  return r.result && r.result.value;
}
let passed = 0, failed = 0;
const ok = (n) => { passed++; console.log('  ✓ ' + n); };
const bad = (n, e) => { failed++; console.error('  ✗ ' + n + (e ? ' -> ' + e : '')); };
const hits = (c, q) => ev(c, `filterSessions(${JSON.stringify(q)}).map(s=>s.name)`);
(async () => {
  console.log('\n=== 搜索框 IP 精确匹配 ===\n');
  try {
    const ts = await targets();
    const lockT = ts.find((t) => /解锁/.test(t.title || ''));
    const lock = await connect(lockT.webSocketDebuggerUrl);
    for (let i = 0; i < 30; i++) { if (await ev(lock, `!!document.getElementById('pw')`)) break; await sleep(300); }
    await sleep(400);
    await ev(lock, `document.getElementById('pw').value='x1234'; document.getElementById('pw2').value='x1234'; document.getElementById('btn').click();`);
    let main = null, c = null;
    for (let i = 0; i < 30; i++) { await sleep(500); const t2 = await targets(); const m = t2.find((t) => t.type === 'page' && !/解锁/.test(t.title || '')); if (m) { main = m; break; } }
    c = await connect(main.webSocketDebuggerUrl);
    await sleep(1200);
    // 造会话:同名不同 IP,用于区分精确/子串
    await ev(c, `(async()=>{ for (const h of ['192.168.1.10','192.168.1.100','10.0.0.5']) await window.api.createSession({name:'host-'+h, host:h, port:22, username:'root', password:'x', protocol:'ssh'}); await loadSessions(); return true; })()`);
    await sleep(600);

    // A. 完整 IP → 精确:只有 192.168.1.10,不含 192.168.1.100
    const a = await hits(c, '192.168.1.10');
    if (a.length === 1 && a[0] === 'host-192.168.1.10') ok(`完整 IP 精确匹配:搜 192.168.1.10 → ${a.join(',')}(不误中 1.100)`);
    else bad('完整 IP 未精确匹配: ' + JSON.stringify(a), null);

    // B. 部分 IP(3 段)→ 保持子串:两个 192.168.1.x 都中
    const b = await hits(c, '192.168.1');
    if (b.length === 2) ok(`部分 IP 仍子串:搜 192.168.1 → ${b.join(',')}`);
    else bad('部分 IP 子串异常: ' + JSON.stringify(b), null);

    // C. 多词 OR:精确 IP + 普通词,两个都命中
    const cc = await hits(c, '192.168.1.10 10.0.0.5');
    if (cc.length === 2) ok(`多项搜索(两个完整 IP)→ ${cc.join(',')}`);
    else bad('多项完整 IP 异常: ' + JSON.stringify(cc), null);

    // D. 普通词仍子串
    const d = await hits(c, 'host-');
    if (d.length === 3) ok(`普通词子串不变:搜 host- → ${d.length} 个`);
    else bad('普通词子串异常: ' + JSON.stringify(d), null);

    console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  } catch (e) { console.error('\n测试异常:', e && e.message); failed++; console.log(`\n结果: ${passed} 通过, ${failed} 失败`); }
  try { killTree(appProc); } catch {}
  process.exit(failed ? 1 : 0);
})();
