'use strict';
/**
 * verify-debug-log.js — 验证终端调试日志(🧾 调试)功能:
 *  ① 点击 🧾 调试 → 面板打开
 *  ② 终端聚焦时按 a → KEY 日志标记 active=…textarea →终端,且有 SEND 日志
 *  ③ 焦点被顶到 BODY 时按空格 → KEY 日志标记「BODY 按键被吞」(诊断 vim 粘贴后打不出字)
 *  ④ 复制按钮 → 剪贴板拿到日志
 * 运行: node verify-debug-log.js(需 9353/2229 空闲)
 */
const { spawn } = require('child_process');
const { freePort, killTree, guardTimeout } = require('./test-helper');
const fs = require('fs'); const os = require('os'); const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-debuglog-'));
const PORT = 9353, SSH = 2229;
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
// CDP 真实按键(trusted 事件,xterm 才能处理)
async function key(c, k, o) {
  await c.call('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: o.code, windowsVirtualKeyCode: o.vk, modifiers: 0 });
  if (o.text) await c.call('Input.dispatchKeyEvent', { type: 'char', text: o.text, unmodifiedText: o.text, key: k, windowsVirtualKeyCode: o.vk, modifiers: 0 });
  await c.call('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: o.code, windowsVirtualKeyCode: o.vk, modifiers: 0 });
}
let passed = 0, failed = 0;
const ok = (n) => { passed++; console.log('  ✓ ' + n); };
const bad = (n, e) => { failed++; console.error('  ✗ ' + n + (e ? ' -> ' + e : '')); };

(async () => {
  console.log('\n=== 终端调试日志功能验证 ===\n');
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

    // 建会话 + 连接(mock SSH)
    await ev(c, `(async()=>{ await window.api.createSession({name:'srvA', host:'127.0.0.1', port:${SSH}, username:'admin', password:'admin123', protocol:'ssh'}); await loadSessions(); state.collapsedGroups.clear(); state.settings.sessionView='list'; renderSessionList(''); return true; })()`);
    await sleep(400);
    const aJson = await ev(c, `(function(){ const s=state.sessions.find(x=>x.name==='srvA'); return s?JSON.stringify(s):'NOTFOUND'; })()`);
    if (aJson === 'NOTFOUND') throw new Error('srvA 未创建');
    await ev(c, `connectToServer(${aJson})`);
    let sid = null;
    for (let i = 0; i < 30; i++) { sid = await ev(c, `(state.tabs.size ? [...state.tabs.keys()][0] : null)`); if (sid && await ev(c, `state.tabs.get('${sid}').status`) === 'connected') break; await sleep(300); }
    if (!sid) throw new Error('会话连接失败');
    ok(`会话已连接(sid=${sid})`);

    // ① 打开调试面板
    await ev(c, `document.getElementById('btn-debug').click(); true`);
    await sleep(200);
    const vis = await ev(c, `!document.getElementById('debug-panel').classList.contains('hidden')`);
    if (vis) ok('点击 🧾 调试 → 日志面板打开'); else bad('面板未打开');

    // ② 聚焦终端,按 a
    const hasTa = await ev(c, `(function(){ const ta=document.querySelector('.xterm-helper-textarea'); if(ta) ta.focus(); return !!ta; })()`);
    await sleep(150);
    await key(c, 'a', { code: 'KeyA', vk: 65, text: 'a' });
    await sleep(350);
    const logA = await ev(c, `document.getElementById('debug-body').textContent`);
    if (/KEY[\s\S]*'a'[\s\S]*→终端/.test(logA)) ok(`聚焦终端按 a → KEY 日志标记「→终端」`); else bad('KEY 日志未标记正常送达', logA.slice(-400));
    if (logA.includes('SEND')) ok(`按键经 xterm 发送 → SEND 日志`); else bad('SEND 日志缺失', logA.slice(-400));

    // ③ 焦点顶到 BODY 后按空格 → 应标记按键被吞
    await ev(c, `(function(){ const ta=document.querySelector('.xterm-helper-textarea'); if(ta) ta.focus(); document.activeElement.blur(); return true; })()`);
    await sleep(150);
    await key(c, ' ', { code: 'Space', vk: 32, text: ' ' });
    await sleep(350);
    const logB = await ev(c, `document.getElementById('debug-body').textContent`);
    if (/KEY[\s\S]*'␣'[\s\S]*BODY 按键被吞/.test(logB)) ok(`焦点在 BODY 按空格 → 日志标记「BODY 按键被吞」`); else bad('未标记按键被吞', logB.slice(-400));

    // ④ 复制按钮 → 状态栏提示已复制
    await ev(c, `document.getElementById('debug-copy').click(); true`);
    await sleep(250);
    const st = await ev(c, `document.getElementById('toolbar-status').textContent || ''`);
    if (/复制/.test(st)) ok(`复制按钮 → 状态栏提示「${st}」`); else bad('复制无反馈', st);

    // ⑤ 保存按钮 → 状态栏提示保存路径,且文件真实存在
    await ev(c, `document.getElementById('debug-save').click(); true`);
    await sleep(400);
    const st2 = await ev(c, `document.getElementById('toolbar-status').textContent || ''`);
    const savedPath = (st2.match(/保存: (\S+)/) || [])[1] || null;
    if (savedPath && fs.existsSync(savedPath) && /polaris-debug-\d+\.log$/.test(savedPath)) {
      ok(`保存按钮 → 日志已写盘(${savedPath})`);
    } else {
      bad('保存按钮无反馈或文件不存在', st2 || '(空)');
    }

    console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  } catch (e) { console.error('\n测试异常:', e && e.message); failed++; console.log(`\n结果: ${passed} 通过, ${failed} 失败`); }
  try { killTree(appProc); } catch {}
  process.exit(failed ? 1 : 0);
})();
