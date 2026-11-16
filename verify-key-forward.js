'use strict';
/**
 * verify-key-forward.js — 焦点在 BODY 时组合键必须真的进终端(回归 Ctrl+C 不生效)
 *   现场日志(long_text_819E…):用户在 AI 面板点过一下 → 焦点掉到 BODY → 按 Ctrl+C 后
 *   只有 `KEY 'c' ^ ime=0 kc=0 active=TEXTAREA … →终端` / `KEY 'c' ^ active=BODY →已兜底转发终端`
 *   两条日志,**没有 SEND "\u0003"** —— 也就是 Ctrl+C 没打断远端命令(用户报「ctrl+C 不生效」)。
 *   根因:BODY 兜底转发时合成的 KeyboardEvent 没带 keyCode/which(日志里的 kc=0),
 *   xterm 的按键映射按 keyCode 走,拿不到就直接吞掉。修法:合成事件带上原事件的 keyCode/which。
 * 断言:BODY 焦点下 Ctrl+C / Ctrl+D / Esc / Tab / ↑ / 普通字母 都能落到远端(SEND 有对应字节)。
 * 运行: node verify-key-forward.js(需 9363/2229/2329 空闲)
 */
const { spawn, execSync } = require('child_process');
const { freePort, killTree, guardTimeout, evaluate } = require('./test-helper');
const fs = require('fs'); const os = require('os'); const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-keyfwd-'));
const PORT = 9363, SSH = 2229, HTTP = 2329;
try { execSync('pkill -f "remote-debugging-port" 2>/dev/null'); } catch { /* 无残留 */ }
freePort(PORT); freePort(SSH); freePort(HTTP);
process.env.MOCK_SSH_PORT = String(SSH);
process.env.MOCK_HTTP_PORT = String(HTTP);
require('./mock/mock-server').start();

const appProc = spawn(require('electron'), ['.', '--dev', `--remote-debugging-port=${PORT}`, '--no-sandbox', '--disable-gpu'], {
  env: { ...process.env, POLARIS_LOCK_DIR: DIR, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  stdio: ['ignore', 'ignore', 'ignore'], detached: true,
});
guardTimeout(180000, appProc);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function targets() {
  for (let i = 0; i < 80; i++) {
    try { const j = await (await fetch(`http://127.0.0.1:${PORT}/json`, { signal: AbortSignal.timeout(3000) }).then((r) => r)).json(); if (j.some((t) => t.type === 'page')) return j; } catch { /* not ready */ }
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
const CTRL = 2; // CDP modifiers:1=Alt 2=Ctrl 4=Meta 8=Shift
async function press(c, key, o = {}) {
  const mod = o.modifiers || 0;
  await c.call('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code: o.code || '', windowsVirtualKeyCode: o.vk || 0, modifiers: mod });
  if (o.text) await c.call('Input.dispatchKeyEvent', { type: 'char', text: o.text, unmodifiedText: o.text, key, windowsVirtualKeyCode: o.vk || 0, modifiers: mod });
  await c.call('Input.dispatchKeyEvent', { type: 'keyUp', key, code: o.code || '', windowsVirtualKeyCode: o.vk || 0, modifiers: mod });
}
let passed = 0, failed = 0;
const ok = (n) => { passed++; console.log('  ✓ ' + n); };
const bad = (n, e) => { failed++; console.error('  ✗ ' + n + (e ? ' → ' + e : '')); };

(async () => {
  console.log('\n=== 焦点在 BODY 时的按键转发(Ctrl+C 等) ===\n');
  try {
    const t0 = await targets();
    const lockT = t0.find((t) => /解锁/.test(t.title || '')) || t0.find((t) => t.type === 'page');
    const lock = await connect(lockT.webSocketDebuggerUrl);
    for (let i = 0; i < 30; i++) { if (await evaluate(lock, `!!document.getElementById('pw')`)) break; await sleep(300); }
    await evaluate(lock, `document.getElementById('pw').value='x1234567'; document.getElementById('pw2').value='x1234567'; document.getElementById('btn').click();`);
    let main = null;
    for (let i = 0; i < 30 && !main; i++) { await sleep(500); main = (await targets()).find((t) => t.type === 'page' && !/解锁/.test(t.title || '')); }
    if (!main) throw new Error('主窗口未就绪');
    const c = await connect(main.webSocketDebuggerUrl);
    await sleep(1200);

    // 建 mock 会话并连接
    await evaluate(c, `(async()=>{ await window.api.createSession({name:'keyfwd', host:'127.0.0.1', port:${SSH}, username:'admin', password:'admin123', protocol:'ssh'}); await loadSessions(); state.collapsedGroups.clear(); state.settings.sessionView='list'; renderSessionList(''); return true; })()`);
    await sleep(400);
    const aJson = await evaluate(c, `(function(){ const s=state.sessions.find(x=>x.name==='keyfwd'); return s?JSON.stringify(s):'NOTFOUND'; })()`);
    if (aJson === 'NOTFOUND') throw new Error('会话未创建');
    await evaluate(c, `connectToServer(${aJson})`);
    let sid = null;
    for (let i = 0; i < 40; i++) { sid = await evaluate(c, `(state.tabs.size ? [...state.tabs.keys()][0] : null)`); if (sid && await evaluate(c, `state.tabs.get('${sid}').status`) === 'connected') break; await sleep(300); }
    if (!sid) throw new Error('mock 会话连接失败');
    ok(`会话已连接(sid=${sid})`);

    // 新手引导弹窗会兜住所有按键(topVisibleModal 分支),先关掉(否则测的就不是 BODY 兜底逻辑)
    await evaluate(c, `(function(){ state.settings.onboardingDone = true; saveSettings(); var om=document.getElementById('onboarding-modal'); if(om) om.classList.add('hidden'); return true; })()`);
    await sleep(200);
    // 调试面板打开,后面靠读它的日志判断"有没有真的发出去"
    await evaluate(c, `toggleDebugPanel(); true`);
    await sleep(250);
    const clear = () => evaluate(c, `(function(){ termDebug.lines.length = 0; var b=document.getElementById('debug-body'); if(b) b.innerHTML=''; return true; })()`);
    const logText = () => evaluate(c, `termDebug.lines.join(String.fromCharCode(10))`);
    const toBody = async () => {
      await evaluate(c, `(function(){ var ta=document.querySelector('.xterm-helper-textarea'); if(ta) ta.focus(); document.activeElement && document.activeElement.blur && document.activeElement.blur(); return document.activeElement === document.body; })()`);
      await sleep(120);
      return await evaluate(c, `(function(){ var a=document.activeElement; return a===document.body ? 'BODY' : (a?a.tagName+'#'+(a.id||'')+'/'+(a.className||''):'none'); })()`);
    };

    // ① 焦点在 BODY 按 Ctrl+C → 必须 SEND "\u0003"
    await clear(); const ae1 = await toBody();
    await press(c, 'c', { code: 'KeyC', vk: 67, modifiers: CTRL });
    await sleep(400);
    const l1 = await logText();
    if (process.env.DBG_LOG) console.log('--- activeElement:', ae1, '\n--- LOG ---\n' + l1.slice(-1500));
    const sent1 = /SEND .*"\\u0003"/.test(l1);
    if (sent1) ok('① BODY 焦点 Ctrl+C → SEND "\\u0003"(真正打断远端命令)');
    else bad('① BODY 焦点 Ctrl+C 没有发出 ^C(用户报的"ctrl+C 不生效")', l1.slice(-500));
    if (/已兜底转发终端/.test(l1)) ok('① 日志标记「已兜底转发终端」'); else bad('① 未走兜底转发路径', l1.slice(-500));

    // ② Ctrl+D(EOF)
    await clear(); await toBody();
    await press(c, 'd', { code: 'KeyD', vk: 68, modifiers: CTRL });
    await sleep(400);
    const l2 = await logText();
    if (/SEND .*"\\u0004"/.test(l2)) ok('② BODY 焦点 Ctrl+D → SEND "\\u0004"');
    else bad('② Ctrl+D 未发出', l2.slice(-400));

    // ③ Esc / Tab / ↑(TUI 常用)
    await clear(); await toBody();
    await press(c, 'Escape', { code: 'Escape', vk: 27 });
    await sleep(300);
    await press(c, 'Tab', { code: 'Tab', vk: 9 });
    await sleep(300);
    await press(c, 'ArrowUp', { code: 'ArrowUp', vk: 38 });
    await sleep(400);
    const l3 = await logText();
    const hasEsc = /SEND .*"\\u001b"/.test(l3), hasTab = /SEND .*"\\t"|SEND .*"\\u0009"/.test(l3), hasUp = /SEND .*"\\u001b\[A"|SEND .*"\\u001bOA"/.test(l3);
    // Esc 有意不转发(留给关菜单/弹窗),只校验 Tab 与方向键
    if (hasTab && hasUp) ok('③ BODY 焦点 Tab / ↑ 都发到远端(Esc 仍归界面)');
    else bad('③ 特殊键转发不全', JSON.stringify({ hasTab, hasUp }) + ' ' + l3.slice(-400));

    // ④ 普通字母(中文/英文输入的基础)
    await clear(); await toBody();
    await press(c, 'l', { code: 'KeyL', vk: 76, text: 'l' });
    await sleep(250);
    await press(c, 's', { code: 'KeyS', vk: 83, text: 's' });
    await sleep(400);
    const l4 = await logText();
    if (/SEND .*"l"/.test(l4) && /SEND .*"s"/.test(l4)) ok('④ BODY 焦点普通字母照常进终端');
    else bad('④ 普通字母没进终端', l4.slice(-400));

    // ⑤ 回归防护:焦点在终端(textarea)本身时 Ctrl+C 仍是原来的正常路径
    await clear();
    await evaluate(c, `(function(){ var ta=document.querySelector('.xterm-helper-textarea'); if(ta) ta.focus(); return true; })()`);
    await sleep(150);
    await press(c, 'c', { code: 'KeyC', vk: 67, modifiers: CTRL });
    await sleep(400);
    const l5 = await logText();
    if (/SEND .*"\\u0003"/.test(l5)) ok('⑤ 终端焦点 Ctrl+C 仍正常(未被兜底逻辑干扰)');
    else bad('⑤ 终端焦点 Ctrl+C 失灵', l5.slice(-400));

    console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  } catch (e) { console.error('\n测试异常:', e && (e.stack || e.message)); failed++; console.log(`\n结果: ${passed} 通过, ${failed} 失败`); }
  try { killTree(appProc); } catch { /* ignore */ }
  try { if (process.env.KEEP_DIR) console.log('DIR=' + DIR); else fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(failed ? 1 : 0);
})();
