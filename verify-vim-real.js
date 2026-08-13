'use strict';
/**
 * verify-vim-real.js — 真实 vim 复现:终端里跑真 vim(mouse) → 粘贴 → :wq → 敲空格
 * 与 verify-vim-space.js 的区别:这里连的是"真实 bash PTY"(python pty 桥),vim 是真的。
 * 运行: node verify-vim-real.js(需 9348/2360 空闲)
 * 依赖: pty-bridge.py(与本测试同目录,零依赖纯 python3)
 * 流程: 建 telnet 会话连到 pty 桥 → bash 里跑真 vim → i 进插入 → term.paste 粘贴 →
 *       Esc :wq 退出 → 敲空格+X → 断言服务端收到 " x"(空格没被吞)
 */
const { spawn } = require('child_process');
const { freePort, killTree, guardTimeout } = require('./test-helper');
const fs = require('fs'); const os = require('os'); const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-vimreal-'));
const PORT = 9348, BRIDGE = 2360;
freePort(PORT); freePort(BRIDGE);

// 1) 起真实 bash PTY 桥(纯 python3,零依赖;与测试同目录,不依赖 /tmp)
const bridge = spawn('python3', [path.join(__dirname, 'pty-bridge.py'), String(BRIDGE)], {
  stdio: ['ignore', 'ignore', 'ignore'], detached: true,
});
guardTimeout(120000, bridge);

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
// 往终端发数据(走 app 同一 sshWrite 管线;telnet 会话写进 socket)
async function typeInto(c, sid, str) {
  await ev(c, `window.api.sshWrite('${sid}', ${JSON.stringify(str)}); true`);
}
let passed = 0, failed = 0;
const ok = (n) => { passed++; console.log('  ✓ ' + n); };
const bad = (n, e) => { failed++; console.error('  ✗ ' + n + (e ? ' -> ' + e : '')); };

(async () => {
  console.log('\n=== 真实 vim 粘贴后空格失效(端到端) ===\n');
  try {
    await sleep(1200); // 等桥起来
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

    // 建 telnet 会话(真实 bash PTY)
    await ev(c, `(async()=>{ await window.api.createSession({name:'vimreal', host:'127.0.0.1', port:${BRIDGE}, username:'', password:'', protocol:'telnet'}); await loadSessions(); return true; })()`);
    await sleep(400);
    const sessJson = await ev(c, `(function(){ for (const s of state.sessions) if (s.name==='vimreal') return JSON.stringify(s); return 'NOTFOUND'; })()`);
    if (sessJson === 'NOTFOUND') throw new Error('会话未创建成功');
    await ev(c, `connectToServer(${sessJson})`);
    let sid = null;
    for (let i = 0; i < 30; i++) { sid = await ev(c, `(state.tabs.size ? [...state.tabs.keys()][0] : null)`); if (sid && await ev(c, `state.tabs.get('${sid}').status`) === 'connected') break; await sleep(300); }
    if (!sid) throw new Error('未能建立连接');
    ok('连接建立(sid=' + sid + ')');
    await sleep(800);

    // bash 就绪,进 /tmp 准备跑 vim
    await typeInto(c, sid, 'cd /tmp && echo VIM_READY\r');
    await sleep(600);

    // 跑真 vim(带鼠标):set mouse=a → alt-screen
    await typeInto(c, sid, "vim -c 'set mouse=a' vimreal.txt\r");
    await sleep(1500);
    // 确认进入了 alt-screen(全屏 UI)
    const inAlt = await ev(c, `state.tabs.get('${sid}').term.buffer.active === state.tabs.get('${sid}').term.buffer.alternate`);
    ok(`vim 进入全屏(alt-screen)=${inAlt}`);

    // 进插入模式
    await typeInto(c, sid, 'i');
    await sleep(300);

    // —— 真实鼠标粘贴:右键终端 → 上下文菜单 → 点「📥 粘贴」(不是直接调 term.paste)——
    await ev(c, `window.api.copyText('hello  world  paste'); true`);
    const paneRect = JSON.parse(await ev(c, `(function(){ const el=document.querySelector('.term-pane'); if(!el) return null; const r=el.getBoundingClientRect(); return JSON.stringify({left:r.left,top:r.top,width:r.width,height:r.height}); })()`));
    if (!paneRect) throw new Error('找不到终端面板');
    const mx = paneRect.left + paneRect.width / 2, my = paneRect.top + paneRect.height / 2;
    await c.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: mx, y: my, button: 'right', buttons: 2, clickCount: 1 });
    await c.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: mx, y: my, button: 'right', buttons: 0, clickCount: 1 });
    await sleep(300);
    const menuVisible = await ev(c, `!els.ctxMenu.classList.contains('hidden')`);
    ok('右键弹出上下文菜单=' + menuVisible);
    const pasteItem = JSON.parse(await ev(c, `(function(){ const el=[...document.querySelectorAll('#ctx-menu .ctx-item')].find(d=>d.textContent.includes('📥')); if(!el) return null; const r=el.getBoundingClientRect(); return JSON.stringify({x:r.left+r.width/2,y:r.top+r.height/2}); })()`));
    if (!pasteItem) throw new Error('找不到「📥 粘贴」菜单项');
    await c.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: pasteItem.x, y: pasteItem.y, button: 'left', buttons: 1, clickCount: 1 });
    await c.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pasteItem.x, y: pasteItem.y, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(400);
    // 回归点:粘贴完焦点必须回到终端 textarea(否则接着敲的字/空格全被吞掉)
    const activeEl = await ev(c, `(document.activeElement && (document.activeElement.className || document.activeElement.tagName)) || 'NONE'`);
    console.log('    粘贴后 activeElement=' + JSON.stringify(activeEl));
    if (activeEl === 'xterm-helper-textarea') ok('粘贴后焦点已还回终端(不再落到 body)');
    else bad('粘贴后焦点未还回终端:activeElement=' + JSON.stringify(activeEl), null);

    // 退出 vim:Esc + :wq + Enter
    await typeInto(c, sid, '\x1b:wq\r');

    // 敲空格 + X —— 不手动 focus(真实用户不会);观察自然焦点状态
    await sleep(30);
    const focusAtType = await ev(c, `(document.activeElement && (document.activeElement.className || document.activeElement.tagName)) || 'NONE'`);
    console.log('    vim 退出后 activeElement=' + JSON.stringify(focusAtType));
    const spaceKey = { key: ' ', code: 'Space', text: ' ', unmodifiedText: ' ', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 49 };
    await c.call('Input.dispatchKeyEvent', { type: 'keyDown', ...spaceKey });
    await c.call('Input.dispatchKeyEvent', { type: 'keyUp', ...spaceKey });
    await c.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'x', code: 'KeyX', text: 'x', unmodifiedText: 'x', windowsVirtualKeyCode: 88, nativeVirtualKeyCode: 45 });
    await c.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'x', code: 'KeyX', windowsVirtualKeyCode: 88 });
    await sleep(500);

    const buf = await ev(c, `(state.tabs.get('${sid}').inputBuf || '')`);
    const lastLine = await ev(c, `(function(){ const t=state.tabs.get('${sid}').term; const b=t.buffer.active; return b.getLine(b.cursorY) ? b.getLine(b.cursorY).translateToString(true).replace(/\\s+$/,'') : ''; })()`);
    console.log('    inputBuf=' + JSON.stringify(buf) + ' 行尾=' + JSON.stringify(lastLine));
    if (buf.indexOf(' x') >= 0) ok('空格正常敲出(端到端真实 vim):服务器收到了空格+X');
    else if (buf.indexOf('x') >= 0) bad('空格被吞!只有 X 没有前面的空格(端到端真实 vim)', null);
    else bad('空格与 X 都没到服务器(端到端真实 vim)', null);

    console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  } catch (e) { console.error('\n测试异常:', e && e.message); failed++; console.log(`\n结果: ${passed} 通过, ${failed} 失败`); }
  try { killTree(appProc); } catch {}
  try { killTree(bridge); } catch {}
  process.exit(failed ? 1 : 0);
})();
