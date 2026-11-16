'use strict';
/**
 * verify-su-root.js — 验证「切换 root(su - root)+ 密码粘贴」:
 *  ① 命令面板含「切换 root」命令;
 *  ② 会话连接后调用 switchToRoot → 终端收到 "Password: "(mock 打印),弹出密码框(password 类型 + 📋 粘贴按钮);
 *  ③ suPending 抑制 autoFillPassword(登录密码 admin123 ≠ root 密码 root123,不应误发);
 *  ④ 填 root123 确认 → mock 校验通过,终端显示「(su) 已切换到 root」,suPending 复位;
 *  ⑤ 再次切换后点「取消」→ 发送 Ctrl+C 中止 su(mock 显示 ^C),无新增授权。
 * 运行: node verify-su-root.js(需 9360/2244 空闲;mock su 密码默认 root123)
 */
const { spawn } = require('child_process');
const { freePort, killTree, guardTimeout, evaluate } = require('./test-helper');
const fs = require('fs'); const os = require('os'); const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-su-'));
const PORT = 9360, SSH = 2244;
freePort(PORT); freePort(SSH);
process.env.MOCK_SSH_PORT = String(SSH);
process.env.MOCK_HTTP_PORT = String(SSH + 100);
process.env.MOCK_SUDO_PW = 'admin123'; // 登录密码 = sudo 密码(与 root 密码不同,验证不会误发)
process.env.MOCK_SU_PW = 'root123';     // su(root) 密码
const mockLog = [];
const origLog = console.log.bind(console);
console.log = (...a) => { mockLog.push(a.join(' ')); origLog(...a); };
const { start } = require('./mock/mock-server');
start();

const appProc = spawn(require('electron'), ['.', '--dev', `--remote-debugging-port=${PORT}`], {
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
async function ev(c, expr) { return evaluate(c, expr); }
let passed = 0, failed = 0;
const ok = (n) => { passed++; console.log('  ✓ ' + n); };
const bad = (n, e) => { failed++; console.error('  ✗ ' + n + (e ? ' -> ' + e : '')); };
const termText = async (c, sid) => {
  try {
    return await ev(c, `(function(){ const l=[]; const b=state.tabs.get('${sid}').term.buffer.active; for(let y=0;y<b.length;y++){ const t=b.getLine(y); if(t) l.push(t.translateToString(true)); } return l.join('\\n'); })()`);
  } catch { return ''; }
};

(async () => {
  console.log('\n=== 切换 root(su - root)+ 密码粘贴 ===\n');
  try {
    const ts = await targets();
    const lockT = ts.find((t) => /解锁/.test(t.title || ''));
    const lock = await connect(lockT.webSocketDebuggerUrl);
    for (let i = 0; i < 30; i++) { if (await ev(lock, `!!document.getElementById('pw')`)) break; await sleep(300); }
    await sleep(400);
    const isSetup = await ev(lock, `document.getElementById('btn').textContent.includes('设置')`);
    const lockPw = isSetup ? 'x12345678' : 'x1234';
    await ev(lock, `document.getElementById('pw').value='${lockPw}'; document.getElementById('pw2').value='${lockPw}'; document.getElementById('btn').click();`);
    let main = null, c = null;
    for (let i = 0; i < 30; i++) { await sleep(500); const t2 = await targets(); const m = t2.find((t) => t.type === 'page' && !/解锁/.test(t.title || '')); if (m) { main = m; break; } }
    c = await connect(main.webSocketDebuggerUrl);
    await sleep(1200);

    // ① 命令面板含「切换 root」命令
    const inPalette = await ev(c, `COMMANDS.some(x => (x.name||'').includes('切换 root'))`);
    if (inPalette) ok('命令面板含「切换 root(su - root)」'); else bad('命令面板缺「切换 root」');

    // 建会话并连接(mock 用户 admin/admin123)
    await ev(c, `(async()=>{ await window.api.createSession({name:'srvA', host:'127.0.0.1', port:${SSH}, username:'admin', password:'admin123', protocol:'ssh'}); await loadSessions(); state.collapsedGroups.clear(); state.settings.sessionView='list'; state.settings.verifyHostKey = false; state.settings.autoTrustHostKey = true; renderSessionList(''); return true; })()`);
    await sleep(400);
    const aJson = await ev(c, `(function(){ const s=state.sessions.find(x=>x.name==='srvA'); return s?JSON.stringify(s):'NOTFOUND'; })()`);
    if (aJson === 'NOTFOUND') throw new Error('srvA 未创建');
    await ev(c, `connectToServer(${aJson})`);
    let sid = null;
    for (let i = 0; i < 30; i++) { sid = await ev(c, `(state.tabs.size ? [...state.tabs.keys()][0] : null)`); if (sid && await ev(c, `state.tabs.get('${sid}').status`) === 'connected') break; await sleep(300); }
    if (!sid) throw new Error('会话连接失败');
    await sleep(500);

    // ② 调 switchToRoot → 发送 su - root,弹出密码框
    await ev(c, `switchToRoot('${sid}'); true`);
    await sleep(300);
    const modalOpen = await ev(c, `!document.getElementById('prompt-modal').classList.contains('hidden')`);
    if (modalOpen) ok('switchToRoot 弹出密码输入框'); else bad('switchToRoot 未弹出密码框');
    const inputType = await ev(c, `document.getElementById('prompt-input').type`);
    if (inputType === 'password') ok('密码框为 password 类型(隐藏明文)'); else bad(`密码框 type=${inputType}`, null);
    const pasteBtn = await ev(c, `(function(){ const b=document.getElementById('prompt-paste'); return b?b.textContent:'NONE'; })()`);
    if (pasteBtn && pasteBtn.includes('粘贴')) ok('密码框带「📋 粘贴」按钮'); else bad('缺「📋 粘贴」按钮', pasteBtn);
    const suPending1 = await ev(c, `state.tabs.get('${sid}').suPending`);
    if (suPending1 === true) ok('切换期间 suPending=true(抑制 autoFillPassword)'); else bad('suPending 未置位', suPending1);

    // 等待 mock 打印 Password:(轮询最多 ~3s,避免冷启动/高负载时序抖动)
    let sawPw = false;
    for (let i = 0; i < 15; i++) {
      const t = await termText(c, sid);
      if (t.includes('Password:')) { sawPw = true; break; }
      await sleep(200);
    }
    const bufPw = await termText(c, sid);
    if (sawPw) ok('终端收到 su 的 Password: 提示'); else bad('终端未见 Password: 提示', (bufPw.slice(-80) || ''));
    // 关键:登录密码 admin123 不应被误发(否则 mock 会记 [SU] 密码不匹配 admin123)
    const leak = mockLog.join('\n').match(/\[SU\] 密码不匹配\(收到="admin123"\)/);
    if (!leak) ok('未把登录密码误发给 su(autoFill 被正确抑制)'); else bad('登录密码被误发给了 su');

    // ③ 填 root123 → 确认 → mock 校验通过
    await ev(c, `document.getElementById('prompt-input').value='root123'; document.getElementById('prompt-ok').click(); true`);
    let granted = null;
    for (let i = 0; i < 24; i++) { granted = mockLog.join('\n').match(/\[SU\] 密码正确/); if (granted) break; await sleep(250); }
    if (granted) ok('填入 root 密码确认 → mock 校验通过'); else bad('未检测到 [SU] 密码正确', mockLog.slice(-3).join(' | '));
    // 终端切换成功文本也是异步回显,轮询最多 ~3s
    let sawOk = false;
    let bufSu = '';
    for (let i = 0; i < 15; i++) { bufSu = await termText(c, sid); if (bufSu.includes('(su) 已切换到 root')) { sawOk = true; break; } await sleep(200); }
    if (sawOk) ok('终端显示「已切换到 root」'); else bad('终端未见切换成功文本', (bufSu.match(/.{0,40}su.{0,60}/s) || [bufSu.slice(-80)])[0]);
    const suPending2 = await ev(c, `state.tabs.get('${sid}').suPending`);
    if (suPending2 !== true) ok('确认后 suPending 已复位'); else bad('suPending 未复位', suPending2);
    const modalClosed = await ev(c, `document.getElementById('prompt-modal').classList.contains('hidden')`);
    if (modalClosed) ok('确认后密码框已关闭'); else bad('密码框未关闭');

    // ④ 再次切换后点「取消」→ Ctrl+C 中止,无新增授权
    const grantCntBefore = (mockLog.join('\n').match(/\[SU\] 密码正确/g) || []).length;
    await ev(c, `switchToRoot('${sid}'); true`);
    await sleep(300);
    await ev(c, `document.getElementById('prompt-cancel').click(); true`);
    await sleep(400);
    const grantCntAfter = (mockLog.join('\n').match(/\[SU\] 密码正确/g) || []).length;
    const bufAbort = await termText(c, sid);
    if (grantCntAfter === grantCntBefore && /\^C/.test(bufAbort)) ok('取消后发送 Ctrl+C 中止 su,无新增授权'); else bad(`取消未中止:授权 ${grantCntBefore}→${grantCntAfter}`, (bufAbort.slice(-60) || ''));
    const suPending3 = await ev(c, `state.tabs.get('${sid}').suPending`);
    if (suPending3 !== true) ok('取消后 suPending 已复位'); else bad('取消后 suPending 未复位');

    console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  } catch (e) { console.error('\n测试异常:', e && e.message); failed++; console.log(`\n结果: ${passed} 通过, ${failed} 失败`); }
  try { killTree(appProc); } catch {}
  process.exit(failed ? 1 : 0);
})();