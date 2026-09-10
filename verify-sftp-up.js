'use strict';
/**
 * verify-sftp-up.js — 验证 SFTP「⬆ 上一级」不再"点了没反应":
 *   ① sftpParent 纯函数(含 H3C Comware 的 flash:/ 文件系统根)
 *   ② 已在根目录点上一级 → 立即提示"已在根目录",且不再去重读同目录(列表原地不动)
 *   ③ 非根目录点上一级 → 路径立刻切到父级
 *   ④ 发起读取立刻有反馈("正在读取 …"),完成后换成结果(慢设备/超时不再毫无动静)
 * 运行: node verify-sftp-up.js(需 9363/2233 空闲)
 */
const { spawn, execSync } = require('child_process');
const { freePort, killTree, guardTimeout } = require('./test-helper');
const fs = require('fs'); const os = require('os'); const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-sftpup-'));
const PORT = 9363, SSH = 2233;
try { execSync('pkill -f "polaris-terminal/node_modules/electron" 2>/dev/null'); } catch { /* 无残留 */ }
freePort(PORT); freePort(SSH);
process.env.MOCK_SSH_PORT = String(SSH);
process.env.MOCK_HTTP_PORT = String(SSH + 100);
const { start } = require('./mock/mock-server');
start();

const appProc = spawn('node_modules/.bin/electron', ['.', '--dev', `--remote-debugging-port=${PORT}`], {
  env: { ...process.env, POLARIS_LOCK_DIR: DIR, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  stdio: ['ignore', 'ignore', 'ignore'], detached: true,
});
guardTimeout(150000, appProc);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function targets() {
  for (let i = 0; i < 75; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json`, { signal: AbortSignal.timeout(3000) }); const j = await r.json(); const p = j.find((t) => t.type === 'page' && /解锁|Polaris/.test(t.title || '')); if (p) return j; } catch { /* not ready */ }
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
  if (r.exceptionDetails) throw new Error('JS异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 400) + ' @ ' + expr.slice(0, 80));
  return r.result && r.result.value;
}
let passed = 0, failed = 0;
const ok = (n) => { passed++; console.log('  ✓ ' + n); };
const bad = (n, e) => { failed++; console.error('  ✗ ' + n + (e ? ' -> ' + e : '')); };

(async () => {
  console.log('\n=== SFTP「上一级」点不动的修复验证 ===\n');
  try {
    let lockT = null;
    for (let i = 0; i < 50; i++) { lockT = (await targets()).find((t) => /解锁/.test(t.title || '')); if (lockT) break; await sleep(400); }
    if (!lockT) throw new Error('解锁页未就绪');
    const lock = await connect(lockT.webSocketDebuggerUrl);
    for (let i = 0; i < 30; i++) { if (await ev(lock, `!!document.getElementById('pw')`)) break; await sleep(300); }
    await sleep(400);
    await ev(lock, `document.getElementById('pw').value='x1234567'; document.getElementById('pw2').value='x1234567'; document.getElementById('btn').click();`);
    let main = null;
    for (let i = 0; i < 30; i++) { await sleep(500); const t2 = await targets(); const m = t2.find((t) => t.type === 'page' && !/解锁/.test(t.title || '')); if (m) { main = m; break; } }
    const c = await connect(main.webSocketDebuggerUrl);
    await sleep(1200);

    await ev(c, `(async()=>{ await window.api.createSession({name:'up', host:'127.0.0.1', port:${SSH}, username:'admin', password:'admin123', protocol:'ssh'}); await loadSessions(); return true; })()`);
    await sleep(400);
    const sessJson = await ev(c, `(function(){ for (const s of state.sessions) if (s.name==='up') return JSON.stringify(s); return 'NOTFOUND'; })()`);
    if (sessJson === 'NOTFOUND') throw new Error('会话未创建成功');
    await ev(c, `connectToServer(${sessJson})`);
    let sid = null;
    for (let i = 0; i < 30; i++) { sid = await ev(c, `(state.tabs.size ? [...state.tabs.keys()][0] : null)`); if (sid && await ev(c, `state.tabs.get('${sid}').status`) === 'connected') break; await sleep(300); }
    if (!sid) throw new Error('未能建立 SSH 连接');
    ok('SSH 连接建立(sid=' + sid + ')');

    // ① 纯函数:上一级路径(含 H3C Comware 的 flash:/)
    const cases = [['/a/b', '/a'], ['/a', '/'], ['/', '/'], ['/a/b/c', '/a/b'], ['/a/b/', '/a'],
      ['flash:/', 'flash:/'], ['flash:/a', 'flash:/'], ['flash:/a/b', 'flash:/a'], ['cfcard:/d', 'cfcard:/']];
    const got = await ev(c, `JSON.stringify(${JSON.stringify(cases.map((x) => x[0]))}.map((p) => [p, sftpParent(p)]))`);
    const parsed = JSON.parse(got);
    const wrong = parsed.filter(([i, o], k) => o !== cases[k][1]);
    if (!wrong.length) ok('sftpParent 路径计算正确(含 flash:/ 设备根)');
    else bad('sftpParent 计算错误', JSON.stringify(wrong));

    // ② 已在根目录:给提示 + 不重读(列表里的哨兵原地不动)
    await ev(c, `state.sftp.path='/'; els.sftpList.innerHTML='<div id="sentinel">SENTINEL</div>'; els.toolbarStatus.textContent=''; true`);
    await ev(c, `document.getElementById('btn-sftp-up').click(); true`);
    await sleep(500);
    const kept = await ev(c, `!!document.getElementById('sentinel')`);
    const st2 = await ev(c, `els.toolbarStatus.textContent`);
    const p2 = await ev(c, `state.sftp.path`);
    if (p2 === '/' && kept && /已在根目录/.test(String(st2))) ok(`根目录点上一级:提示「${st2}」且不重读目录`);
    else bad('根目录点上一级行为不符', JSON.stringify({ p2, kept, st2 }));

    // ③ 非根目录:路径立刻切到父级
    await ev(c, `state.sftp.path='/a/b'; true`);
    await ev(c, `document.getElementById('btn-sftp-up').click(); true`);
    const p3 = await ev(c, `state.sftp.path`);
    if (p3 === '/a') ok('非根目录点上一级:路径立刻变 /a');
    else bad('非根目录点上一级路径不对', String(p3));

    // ④ 发起读取立刻有反馈(同步取状态栏),完成后换成结果
    const sync = await ev(c, `(function(){ state.sftp.path='/'; els.toolbarStatus.textContent=''; loadSftpList(); return els.toolbarStatus.textContent; })()`);
    if (/正在读取/.test(String(sync))) ok(`发起读取即有反馈:「${sync}」`);
    else bad('发起读取没有即时反馈', String(sync));
    await sleep(1500);
    const after = await ev(c, `els.toolbarStatus.textContent`);
    if (/已读取|读取失败/.test(String(after))) ok(`读取结束状态栏更新:「${after}」`);
    else bad('读取结束后状态栏未更新', String(after));

    console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  } catch (e) { console.error('\n测试异常:', e && e.message); failed++; console.log(`\n结果: ${passed} 通过, ${failed} 失败`); }
  try { killTree(appProc); } catch { /* ignore */ }
  process.exit(failed ? 1 : 0);
})();
