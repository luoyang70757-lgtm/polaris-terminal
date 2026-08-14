'use strict';
/**
 * verify-autofill-pw.js — 验证「自动填充密码」:
 *  ① 开启状态下:终端出现 [sudo] password for ...: 提示 → app 自动发送会话保存的密码
 *     → mock 校验通过,终端显示「(sudo) 密码正确」(mockLog 记录,不回显明文)
 *  ② 关闭状态:再次触发 sudo 提示 → 不再自动发送(仅 ON 一次成功,不新增)
 * 运行: node verify-autofill-pw.js(需 9368/2243 空闲;mock sudo 密码默认 admin123)
 */
const { spawn } = require('child_process');
const { freePort, killTree, guardTimeout } = require('./test-helper');
const fs = require('fs'); const os = require('os'); const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-autofill-'));
const PORT = 9368, SSH = 2243;
freePort(PORT); freePort(SSH);
process.env.MOCK_SSH_PORT = String(SSH);
process.env.MOCK_HTTP_PORT = String(SSH + 100);
process.env.MOCK_SUDO_PW = 'admin123'; // 会话密码即 sudo 密码:证明"发的是会话保存的密码"
const mockLog = [];
const origLog = console.log.bind(console);
console.log = (...a) => { mockLog.push(a.join(' ')); origLog(...a); };
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
const termText = async (c, sid) => {
  try {
    return await ev(c, `(function(){ const l=[]; const b=state.tabs.get('${sid}').term.buffer.active; for(let y=0;y<b.length;y++){ const t=b.getLine(y); if(t) l.push(t.translateToString(true)); } return l.join('\\n'); })()`);
  } catch { return ''; }
};

(async () => {
  console.log('\n=== 自动填充密码验证 ===\n');
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

    // 设置默认开(应默认 true)
    const defOn = await ev(c, `state.settings.autoFillPassword`);
    if (defOn !== false) ok(`自动填充密码默认开启(autoFillPassword=${defOn})`); else bad('默认应是开启');
    await ev(c, `openSettingsModal(); true`); // checked 状态只在打开设置面板时同步
    await sleep(200);
    const cbOn = await ev(c, `document.getElementById('set-autofillpw').checked`);
    if (cbOn) ok('设置面板复选框默认勾选'); else bad('设置面板复选框应默认勾选');
    await ev(c, `closeSettingsModal(); true`);

    // 建会话并连接(mock 用户 admin/admin123)
    await ev(c, `(async()=>{ await window.api.createSession({name:'srvA', host:'127.0.0.1', port:${SSH}, username:'admin', password:'admin123', protocol:'ssh'}); await loadSessions(); state.collapsedGroups.clear(); state.settings.sessionView='list'; renderSessionList(''); return true; })()`);
    await sleep(400);
    const aJson = await ev(c, `(function(){ const s=state.sessions.find(x=>x.name==='srvA'); return s?JSON.stringify(s):'NOTFOUND'; })()`);
    if (aJson === 'NOTFOUND') throw new Error('srvA 未创建');
    await ev(c, `connectToServer(${aJson})`);
    let sid = null;
    for (let i = 0; i < 30; i++) { sid = await ev(c, `(state.tabs.size ? [...state.tabs.keys()][0] : null)`); if (sid && await ev(c, `state.tabs.get('${sid}').status`) === 'connected') break; await sleep(300); }
    if (!sid) throw new Error('会话连接失败');
    await sleep(500);

    // ① 开启状态:输入 sudo → 自动填密码 → mock 校验通过
    await ev(c, `sendInput('${sid}', 'sudo\\r'); true`);
    await sleep(800);
    console.log('  [诊断] pw=', await ev(c, `JSON.stringify(state.tabs.get('${sid}').session.password)`));
    console.log('  [诊断] autoPwBuf=', await ev(c, `JSON.stringify(state.tabs.get('${sid}').autoPwBuf||'')`));
    console.log('  [诊断] AUTOFILL日志=', await ev(c, `termDebug.lines.filter(l=>l.includes('AUTOFILL')).join(' | ')`));
    let granted = null;
    for (let i = 0; i < 20; i++) { granted = mockLog.join('\n').match(/\[SUDO\] 密码正确/); if (granted) break; await sleep(250); }
    if (granted) ok('终端出现 [sudo] password 提示 → 自动发送会话密码,mock 校验通过');
    else bad('未检测到自动发送(无 [SUDO] 密码正确)', mockLog.slice(-3).join(' | '));
    await sleep(400);
    const buf1 = await termText(c, sid);
    if (buf1.includes('(sudo) 密码正确')) ok('终端显示授权成功文本'); else bad('终端未见 (sudo) 密码正确', (buf1.match(/.{0,40}sudo.{0,40}/s) || [buf1.slice(-80)])[0]);

    // ② 关闭状态:再次 sudo → 不再自动发送(无新增 [SUDO] 授权,终端停在等待提示)
    await ev(c, `state.settings.autoFillPassword=false; true`);
    const cntBefore = (mockLog.join('\n').match(/\[SUDO\] 密码正确/g) || []).length;
    await ev(c, `sendInput('${sid}', 'sudo\\r'); true`);
    await sleep(1500);
    const cntAfter = (mockLog.join('\n').match(/\[SUDO\] 密码正确/g) || []).length;
    const buf2 = await termText(c, sid);
    const grant1 = (buf1.match(/\(sudo\) 密码正确/g) || []).length;
    const grant2 = (buf2.match(/\(sudo\) 密码正确/g) || []).length;
    if (cntAfter === cntBefore && grant2 === grant1) ok('关闭后不再自动填充(提示保持等待,无密码发送)');
    else bad(`关闭后仍自动发送: [SUDO] ${cntBefore}→${cntAfter},终端授权 ${grant1}→${grant2}`, null);

    console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  } catch (e) { console.error('\n测试异常:', e && e.message); failed++; console.log(`\n结果: ${passed} 通过, ${failed} 失败`); }
  try { killTree(appProc); } catch {}
  process.exit(failed ? 1 : 0);
})();
