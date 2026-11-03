'use strict';
/**
 * verify-nologin-hint.js — 远端账号 nologin 的识别与提示(回归)
 *
 * 现场日志:STATUS connected → RECV 45B(\r\nThis account is currently not available.) → STATUS closed
 * 认证成功但目标账号 shell=/usr/sbin/nologin,服务器发完提示立即断开。
 * 期望:
 *   ① 识别该消息,tab.noLogin=true;
 *   ② 状态栏提示「没有登录 shell(nologin)」;
 *   ③ 终端里给出可操作提示(换账号 / usermod -s /bin/bash);
 *   ④ 不再自动重连(账号问题重试无意义),reconnectAttempts=0。
 *
 * 运行:node verify-nologin-hint.js(需 9498/2323/2423 空闲)
 */
const { spawn } = require('child_process');
const { freePort, killTree, guardTimeout } = require('./test-helper');
const fs = require('fs'); const os = require('os'); const path = require('path');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-nologin-'));
const PORT = 9498, SSH = 2323, HTTP = 2423;
freePort(PORT); freePort(SSH); freePort(HTTP);
process.env.MOCK_SSH_PORT = String(SSH);
process.env.MOCK_HTTP_PORT = String(HTTP);
require('./mock/mock-server').start();

const appProc = spawn('node_modules/.bin/electron', ['.', '--dev', `--remote-debugging-port=${PORT}`, '--no-sandbox', '--disable-gpu'], {
  env: { ...process.env, POLARIS_LOCK_DIR: DIR, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  stdio: ['ignore', 'ignore', 'ignore'], detached: true,
});
guardTimeout(150000, appProc);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function targets() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json`); const j = await r.json(); if (j.find((t) => t.type === 'page' && /解锁|Polaris/.test(t.title || ''))) return j; } catch { /* ignore */ }
    await sleep(400);
  }
  throw new Error('targets 未就绪');
}
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url); let id = 0; const pending = new Map();
    ws.onopen = () => resolve({ call(m, p = {}) { return new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method: m, params: p })); }); }, close() { ws.close(); } });
    ws.onerror = reject;
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };
  });
}
async function ev(c, expr) {
  const r = await c.call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('JS异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 400) + ' @ ' + expr.slice(0, 100));
  return r.result && r.result.value;
}
let passed = 0, failed = 0;
const ok = (n) => { passed++; console.log('  ✓ ' + n); };
const bad = (n, e) => { failed++; console.error('  ✗ ' + n + (e ? ' → ' + e : '')); };

(async () => {
  console.log('\n=== nologin 账号识别与提示 ===\n');
  try {
    const t0 = await targets();
    const lockT = t0.find((t) => /解锁/.test(t.title || '')) || t0.find((t) => t.type === 'page');
    const lock = await connect(lockT.webSocketDebuggerUrl);
    for (let i = 0; i < 40; i++) { if (await ev(lock, `!!document.getElementById('pw')`)) break; await sleep(300); }
    await sleep(300);
    await ev(lock, `document.getElementById('pw').value='x1234567'; document.getElementById('pw2').value='x1234567'; document.getElementById('btn').click();`);
    let c = null;
    for (let i = 0; i < 50; i++) {
      await sleep(400);
      const t2 = await targets();
      const m = t2.find((t) => t.type === 'page' && !/解锁/.test(t.title || ''));
      if (m) { c = await connect(m.webSocketDebuggerUrl); break; }
    }
    if (!c) throw new Error('主窗口未就绪');
    for (let i = 0; i < 50; i++) { if (await ev(c, `typeof state === 'object' && !!state.settings`)) break; await sleep(200); }

    // mock:admin@ssh@nologin@... → 认证成功、目标账号 nologin、服务器立即关闭
    await ev(c, `(function(){
      connectToServer({
        name: 'nologin-test', host: '127.0.0.1', port: ${SSH},
        username: 'admin@ssh@nologin@192.168.10.10', password: 'admin123', protocol: 'ssh',
      });
      return true;
    })()`);
    let sid = null, tab = null;
    for (let i = 0; i < 40; i++) {
      sid = await ev(c, `(state.tabs.size ? [...state.tabs.keys()][0] : null)`);
      if (sid) {
        tab = await ev(c, `(function(){ const t=state.tabs.get('${sid}'); return t ? {status:t.status,noLogin:t.noLogin,attempts:t.reconnectAttempts,statusBar:els.toolbarStatus.textContent} : null; })()`);
        if (tab && tab.noLogin) break;
      }
      await sleep(300);
    }
    if (!tab) throw new Error('标签未创建');
    if (tab.noLogin === true) ok('识别 nologin 并标记 tab.noLogin');
    else bad('未识别 nologin', JSON.stringify(tab));
    if (/nologin|登录 shell/i.test(tab.statusBar || '')) ok('状态栏显示 nologin 提示');
    else bad('状态栏未提示', JSON.stringify(tab));

    const termText = await ev(c, `(function(){ const t=state.tabs.get('${sid}'); if(!t) return ''; const b=t.term.buffer.active; let s=''; for(let i=0;i<b.length;i++){const l=b.getLine(i); if(l) s+=l.translateToString(true)+'\\n';} return s; })()`);
    if (/nologin|登录 shell/i.test(termText) && /usermod|换有 shell 的账号/i.test(termText)) ok('终端内给出原因与处理方式');
    else bad('终端提示不完整', termText.slice(-500));

    const rec = await ev(c, `termDebug.lines.filter(l => l.indexOf('NOLOGIN') >= 0)`);
    if (rec.length) ok('调试日志记录 NOLOGIN');
    else bad('缺少 NOLOGIN 调试记录', JSON.stringify(rec));

    // 自动重连默认开启;nologin 不应该重连(等 > 2s 的首次退避)
    await sleep(2600);
    const after = await ev(c, `(function(){ const t=state.tabs.get('${sid}'); return {attempts:t?t.reconnectAttempts:-1, timer:!!(t&&t.reconnectTimer), status:t?t.status:null, noLogin:t?t.noLogin:null}; })()`);
    if (after.noLogin && after.attempts === 0 && !after.timer) ok('nologin 不触发自动重连');
    else bad('nologin 仍安排重连', JSON.stringify(after));

    console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  } catch (e) {
    console.error('\n测试异常:', e && e.message);
    failed++;
  }
  try { killTree(appProc); } catch { /* ignore */ }
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(failed ? 1 : 0);
})();
