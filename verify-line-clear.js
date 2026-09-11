'use strict';
/**
 * verify-line-clear.js — 终端行残留防护(两个低危项回归)
 *   ① 初始化清理(finishInitClean)取干净提示符前应**先清行**(Ctrl+U):否则连接后 ~1.5s 内
 *      敲的半条命令会被那个裸回车提前执行(实测踩到)。
 *      走真实可达路径:手动指定编码(如 GBK,典型 H3C 设备)的会话不跑编码探针,connected 后
 *      1.5s 由 encSettleTimer 调 finishInitClean —— 与探针成功路径同一个函数。
 *   ② 拒绝手敲的危险命令时应清掉远端行上的文本(Ctrl+U):否则残留会被后续"一键命令"拼成一条。
 *
 * 观测通道:mock 审计日志(logs/audit-*.log)记录每段 `[IN]`/`[CMD]`。mock 能力边界(已规避):
 *   假 shell 不实现 printf/OSC-0(探针走 3s 超时兜底,那是 verify-enc-probe.js 的被测行为)、
 *   也不实现 Ctrl+U(所以"清行后本该丢掉的文本"在 mock 里仍留着)——故本脚本只断言
 *   **应用发出了什么**,不断言 mock 的 readline 行为。
 * 运行: node verify-line-clear.js(需 9379/2255 空闲)
 */
const { spawn, execSync } = require('child_process');
const { freePort, killTree, guardTimeout } = require('./test-helper');
const fs = require('fs'); const os = require('os'); const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-lineclear-'));
const MOCK_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-lineclear-disk-'));
const LOG_DIR = path.join(__dirname, 'logs');
const PORT = 9379, SSH = 2255;
const CTRLU = '\\u0015'; // 审计日志里 JSON 转义后的 Ctrl+U 字面量
try { execSync('pkill -f "polaris-terminal/node_modules/electron" 2>/dev/null'); } catch { /* 无残留 */ }
freePort(PORT); freePort(SSH);
process.env.MOCK_SSH_PORT = String(SSH);
process.env.MOCK_HTTP_PORT = String(SSH + 100);
process.env.MOCK_SFTP_ROOT = MOCK_ROOT;
const { start } = require('./mock/mock-server');
const T0 = Date.now();
start();

const appProc = spawn('node_modules/.bin/electron', ['.', '--dev', `--remote-debugging-port=${PORT}`], {
  env: { ...process.env, POLARIS_LOCK_DIR: DIR, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  stdio: ['ignore', 'ignore', 'ignore'], detached: true,
});
guardTimeout(200000, appProc);
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
  if (r.exceptionDetails) throw new Error('JS异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result && r.result.value;
}
async function typeLine(c, text) {
  await c.call('Input.insertText', { text });
  await sleep(150);
  await c.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', unmodifiedText: '\r', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 36 });
  await c.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 36 });
  await sleep(500);
}
let passed = 0, failed = 0;
const ok = (n) => { passed++; console.log('  ✓ ' + n); };
const bad = (n, e) => { failed++; console.error('  ✗ ' + n + (e ? ' → ' + e : '')); };
function auditText() {
  try {
    const files = fs.readdirSync(LOG_DIR).filter((f) => f.startsWith('audit-') && f.endsWith('.log'))
      .map((f) => ({ f, m: fs.statSync(path.join(LOG_DIR, f)).mtimeMs }))
      .filter((x) => x.m >= T0 - 2000).sort((a, b) => a.m - b.m);
    return files.map((x) => fs.readFileSync(path.join(LOG_DIR, x.f), 'utf8')).join('\n');
  } catch { return ''; }
}
const inLines = (txt) => txt.split('\n').filter((l) => l.includes('[IN '));
const countCtrlU = (txt) => inLines(txt).filter((l) => l.includes(CTRLU)).length;

(async () => {
  console.log('\n=== 终端行残留防护 ===\n');
  try {
    let lockT = null;
    for (let i = 0; i < 50; i++) { lockT = (await targets()).find((t) => /解锁/.test(t.title || '')); if (lockT) break; await sleep(400); }
    const lock = await connect(lockT.webSocketDebuggerUrl);
    for (let i = 0; i < 30; i++) { if (await ev(lock, `!!document.getElementById('pw')`)) break; await sleep(300); }
    await sleep(300);
    await ev(lock, `document.getElementById('pw').value='x1234567'; document.getElementById('pw2').value='x1234567'; document.getElementById('btn').click();`);
    let main = null;
    for (let i = 0; i < 30; i++) { await sleep(500); const t2 = await targets(); const m = t2.find((t) => t.type === 'page' && !/解锁/.test(t.title || '')); if (m) { main = m; break; } }
    const c = await connect(main.webSocketDebuggerUrl);
    await sleep(1000);
    await ev(c, `(async()=>{
      const g = await window.api.createGroup('lc-prod'); await window.api.setGroupProd(g.id, true);
      await window.api.createSession({name:'lc1', host:'127.0.0.1', port:${SSH}, username:'admin', password:'admin123', protocol:'ssh', groupId: g.id});
      await window.api.createSession({name:'lc-gbk', host:'127.0.0.1', port:${SSH}, username:'admin', password:'admin123', protocol:'ssh', encoding:'gbk'});
      state.settings.verifyHostKey=false; state.settings.autoTrustHostKey=true;
      await loadSessions(); window.__confirms=[]; window.__ans=false;
      window.confirm=(m)=>{ window.__confirms.push(String(m)); return window.__ans; };
      return true; })()`);
    await sleep(600);

    // ---- ① GBK 会话(不跑探针)→ 1.5s 兜底触发 finishInitClean,应先清行 ----
    const gj = await ev(c, `(function(){ const s=state.sessions.find(x=>x.name==='lc-gbk'); return JSON.stringify(s); })()`);
    await ev(c, `connectToServer(${gj})`);
    let sidG = null;
    for (let i = 0; i < 30; i++) { sidG = await ev(c, `(state.tabs.size ? [...state.tabs.keys()][0] : null)`); if (sidG && await ev(c, `state.tabs.get('${sidG}').status`) === 'connected') break; await sleep(300); }
    if (!sidG) throw new Error('GBK 会话连接失败');
    await sleep(3500);
    const a1 = auditText();
    if (countCtrlU(a1) >= 1 && inLines(a1).some((l) => l.includes(CTRLU + '\\r'))) {
      ok(`① finishInitClean 先清行再回车(无探针会话的 1.5s 兜底路径;审计见 ${countCtrlU(a1)} 次 Ctrl+U,含 "\\u0015\\r")`);
    } else bad('① 初始化清理未先清行', JSON.stringify(inLines(a1).slice(0, 3)));
    await ev(c, `closeTab('${sidG}'); true`);
    await sleep(400);

    // ---- ② 生产会话:拒绝手敲危险命令 → 补发 Ctrl+U,且该行不被提交 ----
    const pj = await ev(c, `(function(){ const s=state.sessions.find(x=>x.name==='lc1'); return JSON.stringify(s); })()`);
    await ev(c, `connectToServer(${pj})`);
    let sid = null;
    for (let i = 0; i < 30; i++) { sid = await ev(c, `(state.tabs.size ? [...state.tabs.keys()][0] : null)`); if (sid && await ev(c, `state.tabs.get('${sid}').status`) === 'connected') break; await sleep(300); }
    if (!sid) throw new Error('生产会话连接失败');
    for (let i = 0; i < 25; i++) { if (!(await ev(c, `!!state.tabs.get('${sid}').initMask`))) break; await sleep(300); }
    await sleep(500);
    await ev(c, `state.tabs.get('${sid}').term.focus(); true`);
    const beforeU = countCtrlU(auditText());
    await typeLine(c, 'rm -rf /tmp/pol-lineclear');
    await sleep(800);
    const a2 = auditText();
    if ((await ev(c, `window.__confirms.length`)) === 1) ok('② 确实弹出了生产确认(前提成立)');
    else bad('② 未弹确认(前提不成立)', String(await ev(c, `window.__confirms.length`)));
    if (countCtrlU(a2) === beforeU + 1) ok(`② 拒绝后补发 Ctrl+U 清行(${beforeU} → ${countCtrlU(a2)})`);
    else bad('② 拒绝后未清行', JSON.stringify({ beforeU, after: countCtrlU(a2) }));
    if (!a2.split('\n').some((l) => l.includes('[CMD ') && l.includes('rm -rf'))) ok('② 该危险命令未被提交执行');
    else bad('② 危险命令被执行了', (a2.match(/\[CMD [^\n]*rm -rf[^\n]*/) || [''])[0]);

    // ---- ③ 正向对照:普通命令不触发清行,且照常发出 ----
    const beforeU3 = countCtrlU(auditText());
    await ev(c, `state.tabs.get('${sid}').term.focus(); true`);
    await typeLine(c, 'uptime');
    await sleep(800);
    const a3 = auditText();
    if (countCtrlU(a3) === beforeU3) ok('③ 普通命令不触发清行(不干扰正常输入)');
    else bad('③ 普通命令也被清行了', String(countCtrlU(a3)));
    if (inLines(a3).some((l) => l.includes('"uptime"'))) ok('③ 普通命令照常发给远端(mock 不实现 Ctrl+U,其行缓冲会残留上一条——属 mock 边界)');
    else bad('③ 普通命令未发出', JSON.stringify(inLines(a3).slice(-3)));

    console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  } catch (e) { console.error('\n测试异常:', e && e.message); failed++; console.log(`\n结果: ${passed} 通过, ${failed} 失败`); }
  try { killTree(appProc); } catch { /* ignore */ }
  try { fs.rmSync(MOCK_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(failed ? 1 : 0);
})();
