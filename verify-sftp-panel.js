'use strict';
/**
 * verify-sftp-panel.js — 验证 SFTP 面板选中行为:
 *  ① 面板打开且绑定到已连接标签 → 工具栏显示「名称 · IP:端口」
 *  ② 选中侧边栏"未打开"的会话 → 下方 SFTP 面板收起(不显示)
 *  ③ 选中侧边栏"已打开"的会话 → 切到对应标签(activeSessionId 更新)
 * 运行: node verify-sftp-panel.js(需 9351/2228 空闲)
 */
const { spawn } = require('child_process');
const { freePort, killTree, guardTimeout } = require('./test-helper');
const fs = require('fs'); const os = require('os'); const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-sftppanel-'));
const PORT = 9351, SSH = 2228;
freePort(PORT); freePort(SSH);
process.env.MOCK_SSH_PORT = String(SSH);
process.env.MOCK_HTTP_PORT = String(SSH + 100);
const { start } = require('./mock/mock-server');
start();

const appProc = spawn('node_modules/.bin/electron', ['.', '--dev', `--remote-debugging-port=${PORT}`], {
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
  console.log('\n=== SFTP 面板选中行为验证 ===\n');
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

    // 建两个会话(都指向 mock SSH):srvA 会打开,srvB 保持未打开
    await ev(c, `(async()=>{ await window.api.createSession({name:'srvA', host:'127.0.0.1', port:${SSH}, username:'admin', password:'admin123', protocol:'ssh'}); await window.api.createSession({name:'srvB', host:'127.0.0.1', port:${SSH}, username:'admin', password:'admin123', protocol:'ssh'}); await loadSessions(); return true; })()`);
    await sleep(400);
    // 展开分组 + 列表视图(默认树形分组折叠,主机行不显示)
    await ev(c, `state.collapsedGroups.clear(); state.collapsedTopHost = false; state.settings.sessionView='list'; renderSessionList(''); true`);
    await sleep(300);

    // 连接 srvA
    const aJson = await ev(c, `(function(){ const s=state.sessions.find(x=>x.name==='srvA'); return s?JSON.stringify(s):'NOTFOUND'; })()`);
    if (aJson === 'NOTFOUND') throw new Error('srvA 未创建');
    await ev(c, `connectToServer(${aJson})`);
    let sidA = null;
    for (let i = 0; i < 30; i++) { sidA = await ev(c, `(state.tabs.size ? [...state.tabs.keys()][0] : null)`); if (sidA && await ev(c, `state.tabs.get('${sidA}').status`) === 'connected') break; await sleep(300); }
    if (!sidA) throw new Error('srvA 连接失败');
    ok(`srvA 已连接(sid=${sidA})`);

    // ① 打开 SFTP 面板 → 工具栏显示名称+IP
    await ev(c, `toggleSftpPanel(); true`);
    await sleep(600);
    const lab1 = await ev(c, `els.sftpConn.textContent`);
    const vis1 = await ev(c, `!els.sftpPanel.classList.contains('hidden')`);
    if (vis1 && lab1 === 'srvA · 127.0.0.1:' + SSH) ok(`面板打开,工具栏显示当前连接「${lab1}」`);
    else bad(`面板打开但连接标签异常: visible=${vis1} label=${JSON.stringify(lab1)}(期望 srvA · 127.0.0.1:${SSH})`, null);

    // ② 点击侧边栏"未打开"的 srvB → SFTP 面板保持(各标签 SFTP 独立,互不影响),标签不变
    await ev(c, `(function(){ const row=[...document.querySelectorAll('.asset-item.host-item')].find(el=>el.querySelector('.name').textContent==='srvB'); if(!row) return 'NOROW'; row.click(); return 'OK'; })()`);
    await sleep(400);
    const vis2 = await ev(c, `!els.sftpPanel.classList.contains('hidden')`);
    const lab2 = await ev(c, `els.sftpConn.textContent`);
    if (vis2 && lab2 === 'srvA · 127.0.0.1:' + SSH) ok(`选中未打开的会话 → SFTP 面板保持(各标签独立),连接标签不变「${lab2}」`);
    else bad(`选中未打开会话后面板状态异常: visible=${vis2} label=${JSON.stringify(lab2)}`, null);

    // ③ 点击侧边栏"已打开"的 srvA → 切回该标签(activeSessionId = srvA 的 tab)
    await ev(c, `(function(){ const row=[...document.querySelectorAll('.asset-item.host-item')].find(el=>el.querySelector('.name').textContent==='srvA'); if(!row) return 'NOROW'; row.click(); return 'OK'; })()`);
    await sleep(400);
    const activeId = await ev(c, `state.activeSessionId`);
    if (activeId === sidA) ok(`选中已打开的 srvA → 切到该标签(activeSessionId=${activeId})`);
    else bad(`选中已打开会话未切换标签: active=${JSON.stringify(activeId)} 期望=${sidA}`, null);

    // ④ 再次开关面板:先关(sftpA 仍开着)→ 再开,标签应仍正确(回归:面板重开绑定当前连接)
    await ev(c, `toggleSftpPanel(); true`); // 关
    await sleep(400);
    await ev(c, `toggleSftpPanel(); true`); // 开
    await sleep(600);
    const lab3 = await ev(c, `els.sftpConn.textContent`);
    if (lab3 === 'srvA · 127.0.0.1:' + SSH) ok(`面板重新打开仍显示「${lab3}」`);
    else bad(`面板重开标签异常: ${JSON.stringify(lab3)}`, null);

    console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  } catch (e) { console.error('\n测试异常:', e && e.message); failed++; console.log(`\n结果: ${passed} 通过, ${failed} 失败`); }
  try { killTree(appProc); } catch {}
  process.exit(failed ? 1 : 0);
})();
