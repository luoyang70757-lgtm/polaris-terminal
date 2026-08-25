'use strict';
/**
 * verify-pty-size.js — 验证连接时发送真实终端尺寸:
 *  服务器 PTY 按真实 cols/rows 创建(不再 80x24),修复高窗口里 vim 只占上半屏
 *  ① 渲染层终端最终尺寸非默认 80x24(94x44 级)
 *  ② mock 收到的 pty-req 尺寸 = 渲染层终端尺寸(一致)
 * 运行: node verify-pty-size.js(需 9367/2242 空闲;脚本进程内 mock,不冲突 app 的 --dev mock)
 */
const { spawn } = require('child_process');
const { freePort, killTree, guardTimeout } = require('./test-helper');
const fs = require('fs'); const os = require('os'); const path = require('path');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-pty-'));
const PORT = 9367, SSH = 2242;
freePort(PORT); freePort(SSH);
process.env.MOCK_SSH_PORT = String(SSH);
process.env.MOCK_HTTP_PORT = String(SSH + 100);
const mockLog = [];
const origLog = console.log.bind(console);
console.log = (...a) => { mockLog.push(a.join(' ')); origLog(...a); };
const { start } = require('./mock/mock-server');
start();
const appProc = spawn('node_modules/.bin/electron', ['.', '--dev', `--remote-debugging-port=${PORT}`], {
  env: { ...process.env, POLARIS_LOCK_DIR: DIR, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  stdio: ['ignore', 'pipe', 'pipe'], detached: true,
});
const mainOut = [];
appProc.stdout.on('data', (d) => mainOut.push(d.toString()));
appProc.stderr.on('data', (d) => mainOut.push(d.toString()));
guardTimeout(120000, appProc);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function targets() { for (let i = 0; i < 40; i++) { try { const r = await fetch(`http://127.0.0.1:${PORT}/json`); const j = await r.json(); const p = j.find((t) => t.type === 'page' && /解锁|Polaris/.test(t.title || '')); if (p) return j; } catch {} await sleep(400); } throw new Error('targets 未就绪'); }
function connect(url) { return new Promise((resolve, reject) => { const ws = new WebSocket(url); let id = 0; const pending = new Map(); ws.onopen = () => resolve({ call(m, p = {}) { return new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method: m, params: p })); }); } }); ws.onerror = reject; ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } }; }); }
async function ev(c, expr) { const r = await c.call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error('JS异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 500) + ' @ ' + expr.slice(0, 80)); return r.result && r.result.value; }
(async () => {
  console.log('\n=== 连接时服务器 PTY 尺寸验证(80x24 → 真实尺寸) ===\n');
  let failed = 0; const ok = (n, x) => console.log('  ✓ ' + n + (x ? `(${x})` : '')); const bad = (n, x) => { failed++; console.error('  ✗ ' + n + (x ? ' -> ' + x : '')); };
  try {
    let lockT = null;
    for (let i = 0; i < 50; i++) { lockT = (await targets()).find((t) => /解锁/.test(t.title || '')); if (lockT) break; await sleep(400); }
    if (!lockT) throw new Error('解锁页未就绪');
    const lock = await connect(lockT.webSocketDebuggerUrl);
    for (let i = 0; i < 30; i++) { if (await ev(lock, `!!document.getElementById('pw')`)) break; await sleep(300); }
    await sleep(400);
    await ev(lock, `document.getElementById('pw').value='x1234567'; document.getElementById('pw2').value='x1234567'; document.getElementById('btn').click();`);
    let main = null, c = null;
    for (let i = 0; i < 30; i++) { await sleep(500); const t2 = await targets(); const m = t2.find((t) => t.type === 'page' && !/解锁/.test(t.title || '')); if (m) { main = m; break; } }
    c = await connect(main.webSocketDebuggerUrl);
    await sleep(1200);
    await ev(c, `(async()=>{ await window.api.createSession({name:'srvA', host:'127.0.0.1', port:${SSH}, username:'admin', password:'admin123', protocol:'ssh'}); await loadSessions(); state.collapsedGroups.clear(); state.settings.sessionView='list'; renderSessionList(''); return true; })()`);
    await sleep(400);
    const aJson = await ev(c, `(function(){ const s=state.sessions.find(x=>x.name==='srvA'); return s?JSON.stringify(s):'NOTFOUND'; })()`);
    if (aJson === 'NOTFOUND') throw new Error('srvA 未创建');
    await ev(c, `connectToServer(${aJson})`);
    const hasFix = await ev(c, `connectToServer.toString().includes('等 xterm')`);
    console.log('  [诊断] renderer 含修复:', hasFix);
    let sid = null;
    for (let i = 0; i < 30; i++) { sid = await ev(c, `(state.tabs.size ? [...state.tabs.keys()][0] : null)`); if (sid && await ev(c, `state.tabs.get('${sid}').status`) === 'connected') break; await sleep(300); }
    if (!sid) throw new Error('会话未连上');
    await sleep(600);
    // 1) 渲染层终端真实尺寸(应为 44 行级,不是 24)
    const termSize = await ev(c, `state.tabs.get('${sid}').term.cols+'x'+state.tabs.get('${sid}').term.rows`);
    if (termSize === '80x24') bad('终端尺寸仍是 80x24'); else ok('渲染层终端尺寸', termSize);
    // 2) mock 收到的 pty-req 尺寸(服务器端 PTY 创建尺寸)
    let m = mockLog.join('').match(/终端=(\d+x\d+)/);
    if (!m) bad('mock 未记录终端尺寸', mainOut.join('').slice(-300));
    else {
      const pty = m[1];
      if (pty === '80x24') bad('服务器 PTY 仍按 80x24 创建(vim 只占上半屏)');
      else if (pty === termSize) ok('服务器 PTY 与终端一致', pty);
      else bad(`服务器 PTY ${pty} ≠ 终端 ${termSize}`, null);
    }
    console.log(failed ? `\n结果: ${failed} 项失败` : '\n结果: 全部通过');
  } catch (e) { console.error('\n测试异常:', e && e.message); failed++; }
  try { killTree(appProc); } catch {}
  process.exit(failed ? 1 : 0);
})();
