'use strict';
/**
 * verify-cmdcomp-dirty.js — 关闭「命令记录」后命令补全仍可用(回归)
 *   旧版:tab.inputDirty 的唯一复位点被写在 cmdRecord 开关内 → 关掉命令记录后按一次 ↑/↓
 *        就永久 dirty,maybeShowCmdComplete 永远早退,命令补全在该标签彻底死掉。
 *   断言:① cmdRecord=false 时按 ↑ 再敲 2 字符 → 补全面板仍弹出
 *        ② 回车后 inputDirty 复位(与是否记录命令无关)
 *        ③ cmdRecord=true(默认)时同样正常(无回归)
 * 运行: node verify-cmdcomp-dirty.js(需 9371/2246 空闲)
 */
const { spawn, execSync } = require('child_process');
const { freePort, killTree, guardTimeout } = require('./test-helper');
const fs = require('fs'); const os = require('os'); const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-ccdirty-'));
const PORT = 9371, SSH = 2246;
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
  if (r.exceptionDetails) throw new Error('JS异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result && r.result.value;
}
// 真实按键(CDP 可信事件)——必须走 xterm 的 onData 才会改写 inputDirty/inputBuf
async function tap(c, key, code, win, mac, text) {
  const k = { key, code, windowsVirtualKeyCode: win, nativeVirtualKeyCode: mac };
  if (text) { k.text = text; k.unmodifiedText = text; }
  await c.call('Input.dispatchKeyEvent', { type: 'keyDown', ...k });
  await c.call('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: win, nativeVirtualKeyCode: mac });
  await sleep(120);
}
let passed = 0, failed = 0;
const ok = (n) => { passed++; console.log('  ✓ ' + n); };
const bad = (n, e) => { failed++; console.error('  ✗ ' + n + (e ? ' → ' + e : '')); };

(async () => {
  console.log('\n=== 关闭命令记录后命令补全仍可用 ===\n');
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

    await ev(c, `(async()=>{ state.settings.verifyHostKey=false; state.settings.autoTrustHostKey=true; await window.api.createSession({name:'cc', host:'127.0.0.1', port:${SSH}, username:'admin', password:'admin123', protocol:'ssh'}); await loadSessions(); return true; })()`);
    await sleep(400);
    const sj = await ev(c, `(function(){ const s=state.sessions.find(x=>x.name==='cc'); return s?JSON.stringify(s):'NOTFOUND'; })()`);
    if (sj === 'NOTFOUND') throw new Error('会话未创建');
    await ev(c, `connectToServer(${sj})`);
    let sid = null;
    for (let i = 0; i < 30; i++) { sid = await ev(c, `(state.tabs.size ? [...state.tabs.keys()][0] : null)`); if (sid && await ev(c, `state.tabs.get('${sid}').status`) === 'connected') break; await sleep(300); }
    if (!sid) throw new Error('连接失败');
    ok('会话已连接(sid=' + sid + ')');
    await ev(c, `state.tabs.get('${sid}').term.focus(); true`);
    await sleep(200);

    // 读补全状态的小工具(候选数用 'gr' 前缀:dirty 时本就不该弹,这是设计)
    const compState = () => ev(c, `(function(){ const t=state.tabs.get('${sid}'); return JSON.stringify({dirty:!!t.inputDirty, buf:t.inputBuf, visible:!!(t.cmdComp&&t.cmdComp.visible), panelHidden:document.getElementById('cmd-complete-panel').classList.contains('hidden'), n:(t.cmdComp&&t.cmdComp.candidates.length)||0}); })()`);
    const typeGr = async () => { await tap(c, 'g', 'KeyG', 71, 5, 'g'); await tap(c, 'r', 'KeyR', 82, 15, 'r'); await sleep(300); };

    // ---- ① 关掉命令记录:↑ 调历史 → 回车换行 → 新命令仍能补全(旧版到此永久失效) ----
    await ev(c, `state.settings.cmdRecord=false; true`);
    await tap(c, 'ArrowUp', 'ArrowUp', 38, 126);
    const d1 = JSON.parse(await compState());
    if (d1.dirty === true) ok('关记录时按 ↑ → inputDirty=true(前提成立,dirty 期间不补全是设计)');
    else bad('按 ↑ 未置 dirty(前提不成立)', JSON.stringify(d1));
    await tap(c, 'Enter', 'Enter', 13, 36, '\r');
    await sleep(400);
    const d2 = JSON.parse(await compState());
    if (d2.dirty === false) ok('回车后 inputDirty 已复位(cmdRecord=false)');
    else bad('回车后 inputDirty 未复位(旧 bug:补全将被永久压制)', JSON.stringify(d2));
    await typeGr();
    const d3 = JSON.parse(await compState());
    if (d3.visible && !d3.panelHidden && d3.n > 0) ok(`关记录后新命令仍能补全(候选 ${d3.n} 个,buf=${JSON.stringify(d3.buf)})`);
    else bad('关记录后补全没弹出(旧 bug)', JSON.stringify(d3));

    // ---- ② 打开命令记录(默认行为)无回归 ----
    await ev(c, `state.settings.cmdRecord=true; true`);
    await tap(c, 'Enter', 'Enter', 13, 36, '\r'); // 清掉上一行
    await sleep(300);
    await tap(c, 'ArrowUp', 'ArrowUp', 38, 126);
    await tap(c, 'Enter', 'Enter', 13, 36, '\r');
    await sleep(300);
    await typeGr();
    const d4 = JSON.parse(await compState());
    if (d4.visible && d4.n > 0) ok(`记录开启时补全正常(候选 ${d4.n} 个)`);
    else bad('记录开启时补全异常(回归)', JSON.stringify(d4));

    console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  } catch (e) { console.error('\n测试异常:', e && e.message); failed++; console.log(`\n结果: ${passed} 通过, ${failed} 失败`); }
  try { killTree(appProc); } catch { /* ignore */ }
  process.exit(failed ? 1 : 0);
})();
