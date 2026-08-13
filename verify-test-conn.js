'use strict';
/**
 * verify-test-conn.js — 会话弹窗"测试连接"(协议感知)+ 登录宏 textarea 深色样式
 * 运行: node verify-test-conn.js(需 9343/2240/2241/2242 空闲)
 * 断言: SSH banner 服务→✅;accept 但静默(假阳性)→❌;关闭端口→❌;telnet 任意数据→✅;空主机→提示;textarea 深色底
 */
const { spawn } = require('child_process');
const { freePort, killTree, guardTimeout } = require('./test-helper');
const fs = require('fs'); const os = require('os'); const path = require('path'); const net = require('net');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-tcc-'));
const PORT = 9343, SSH = 2240, SILENT = 2241, CLOSED = 2242;
freePort(PORT); freePort(SSH); freePort(SILENT); freePort(CLOSED);
// 真 SSH 服务:连上立即发 banner
const sshSrv = net.createServer((sock) => { sock.setNoDelay(true); sock.write('SSH-2.0-MockSSH_8.9\r\n'); sock.on('error', () => {}); });
sshSrv.listen(SSH);
// accept 但静默无数据 —— 正是"Connection lost before handshake"的假阳性场景
const silentSrv = net.createServer((sock) => { sock.setNoDelay(true); sock.on('error', () => {}); });
silentSrv.listen(SILENT);

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
// 点测试并等结果(✅/❌/⚠ 出现)
async function clickTest(c, host, port) {
  await ev(c, `document.getElementById('f-host').value=${JSON.stringify(host)}; document.getElementById('f-port').value='${port}'; document.getElementById('f-test-conn').click();`);
  let txt = '';
  for (let i = 0; i < 30; i++) { txt = await ev(c, `document.getElementById('f-test-conn-result').textContent`); if (/[✅❌⚠]/.test(txt)) break; await sleep(300); }
  return txt;
}
(async () => {
  console.log('\n=== 测试连接(协议感知)+ 登录宏 textarea ===\n');
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

    // A. 登录宏 textarea 深色样式(不是默认白框)
    await ev(c, `openSessionModal(null)`);
    await sleep(300);
    const ta = JSON.parse(await ev(c, `(function(){ const t=document.getElementById('f-on-connect'); const cs=getComputedStyle(t); return JSON.stringify({w:cs.width, bg:cs.backgroundColor, color:cs.color, mono:cs.fontFamily, h:t.offsetHeight}); })()`));
    if (ta.w !== '0px' && ta.bg !== 'rgba(0, 0, 0, 0)' && ta.color !== 'rgb(0, 0, 0)' && ta.h >= 30) {
      ok(`登录宏 textarea 深色样式:宽 ${ta.w} 高 ${ta.h}px 背景 ${ta.bg} 文字 ${ta.color}`);
    } else bad('登录宏 textarea 仍是默认白框: ' + JSON.stringify(ta), null);

    // B. 空主机提示
    await ev(c, `document.getElementById('f-host').value=''; document.getElementById('f-test-conn').click();`);
    await sleep(300);
    const empty = await ev(c, `document.getElementById('f-test-conn-result').textContent`);
    if (empty.indexOf('先填写主机') >= 0) ok('空主机 → 提示先填写');
    else bad('空主机提示异常: ' + empty, null);

    // C. 真 SSH banner 服务 → ✅(protocol 默认 ssh)
    const sshTxt = await clickTest(c, '127.0.0.1', SSH);
    if (sshTxt.indexOf('✅') >= 0 && sshTxt.indexOf('SSH 服务正常') >= 0) ok(`真 SSH 服务测试:${sshTxt}`);
    else bad('真 SSH 服务结果异常: ' + sshTxt, null);

    // D. accept 但静默 → ❌(关键回归:不再误报成功)
    const silentTxt = await clickTest(c, '127.0.0.1', SILENT);
    if (silentTxt.indexOf('❌') >= 0) ok(`accept 但静默(假阳性场景)→ 判失败:${silentTxt}`);
    else bad('静默端口被误报成功(回归!): ' + silentTxt, null);

    // E. 关闭端口 → ❌
    const closedTxt = await clickTest(c, '127.0.0.1', CLOSED);
    if (closedTxt.indexOf('❌') >= 0 && closedTxt.indexOf(String(CLOSED)) >= 0) ok(`关闭端口测试:${closedTxt}`);
    else bad('关闭端口结果异常: ' + closedTxt, null);

    // F. telnet 协议:任意数据即算可达(SSH banner 也算数据)
    await ev(c, `document.getElementById('f-protocol').value='telnet';`);
    const telnetTxt = await clickTest(c, '127.0.0.1', SSH);
    if (telnetTxt.indexOf('✅') >= 0) ok(`telnet 协议测试(收到数据即可达):${telnetTxt}`);
    else bad('telnet 协议结果异常: ' + telnetTxt, null);

    console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  } catch (e) { console.error('\n测试异常:', e && e.message); failed++; console.log(`\n结果: ${passed} 通过, ${failed} 失败`); }
  try { killTree(appProc); } catch {}
  try { sshSrv.close(); } catch {}
  try { silentSrv.close(); } catch {}
  process.exit(failed ? 1 : 0);
})();
