'use strict';
/**
 * verify-vim-space.js — 复现/验证:vim 内鼠标粘贴后退出,空格无法敲出(严重 bug 回归)
 * 运行: node verify-vim-space.js(需 9347/2227 空闲)
 * 流程: 连 mock SSH → 模拟 vim 进入(alt-screen + bracketed paste + 鼠标上报)→ 鼠标粘贴 →
 *       vim 退出 → 敲空格+X → 断言服务端收到了 " X"(空格没被吞)
 */
const { spawn } = require('child_process');
const { freePort, killTree, guardTimeout } = require('./test-helper');
const fs = require('fs'); const os = require('os'); const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-vimspace-'));
const PORT = 9347, SSH = 2227;
freePort(PORT); freePort(SSH);
// 必须在 require mock 之前设好端口(模块顶部按 env 读端口)
process.env.MOCK_SSH_PORT = String(SSH);
process.env.MOCK_HTTP_PORT = String(SSH + 100); // HTTP 用另一个端口避免撞车
const { start } = require('./mock/mock-server');
start(); // mock 服务器(SSH + HTTP)

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
  console.log('\n=== vim 鼠标粘贴后空格失效(严重 bug 回归) ===\n');
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

    // 建会话
    await ev(c, `(async()=>{ await window.api.createSession({name:'vimt', host:'127.0.0.1', port:${SSH}, username:'admin', password:'admin123', protocol:'ssh'}); await loadSessions(); return true; })()`);
    await sleep(400);
    // 连接 mock SSH(与 telnet e2e 同法:把会话对象 JSON 内联传进去)
    const sessJson = await ev(c, `(function(){ for (const s of state.sessions) if (s.name==='vimt') return JSON.stringify(s); return 'NOTFOUND'; })()`);
    if (sessJson === 'NOTFOUND') throw new Error('会话未创建成功');
    await ev(c, `connectToServer(${sessJson})`);
    let sid = null;
    for (let i = 0; i < 30; i++) { sid = await ev(c, `(state.tabs.size ? [...state.tabs.keys()][0] : null)`); if (sid && await ev(c, `state.tabs.get('${sid}').status`) === 'connected') break; await sleep(300); }
    if (!sid) throw new Error('未能建立 SSH 连接');
    ok('SSH 连接建立(sid=' + sid + ')');

    // A. 模拟 vim 进入(真实 vim + mouse):alt-screen + bracketed paste + SGR 鼠标上报 + 应用光标键
    await ev(c, `state.tabs.get('${sid}').term.write('\\x1b[?1049h\\x1b[?2004h\\x1b[?1006h\\x1b[?1000h\\x1b[?1h'); true`);
    await sleep(200);

    // B. 鼠标粘贴(应用右键菜单「📥 粘贴」同一路径 term.paste)
    await ev(c, `window.api.copyText('hello  world  paste'); const t=window.api.readClipboard(); state.tabs.get('${sid}').term.paste(t); true`);
    await sleep(300);

    // C. 模拟 vim 退出 —— 喂真实 vim :wq 后发出的完整转义序列(macOS vim 实测捕获),
    //    含 ?2004l ×2 / ?1l / keypad reset(\x1b>) / 窗口尺寸恢复 / cursor / \x07
    const realExit = JSON.stringify('\x07\x1b[?25l\x1b[24;1H\x1b[K\x1b[24;1H\x1b[?2004l\x1b[>4;m\x1b[23;2t\x1b[23;1t\r\r\n\x1b[?2004l\x1b[?1l\x1b>\x1b[?1049l\x1b[?25h\x1b[>4;m');
    await ev(c, `state.tabs.get('${sid}').term.write(${realExit}); true`);
    await sleep(300);

    // D. 聚焦终端,敲空格 + 标记字符 X(真实可信键盘事件)
    await ev(c, `state.tabs.get('${sid}').term.focus(); true`);
    await sleep(100);
    const spaceKey = { key: ' ', code: 'Space', text: ' ', unmodifiedText: ' ', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 49 };
    await c.call('Input.dispatchKeyEvent', { type: 'keyDown', ...spaceKey });
    await c.call('Input.dispatchKeyEvent', { type: 'keyUp', ...spaceKey });
    await c.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'x', code: 'KeyX', text: 'x', unmodifiedText: 'x', windowsVirtualKeyCode: 88, nativeVirtualKeyCode: 45 });
    await c.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'x', code: 'KeyX', windowsVirtualKeyCode: 88 });
    await sleep(400);

    // 断言:app 的输入镜像(inputBuf)应含 " x"(空格在前,小写 x)。若空格被吞 → 只有 "x" 或空。
    const buf = await ev(c, `(state.tabs.get('${sid}').inputBuf || '')`);
    const lastLine = await ev(c, `(function(){ const t=state.tabs.get('${sid}').term; const b=t.buffer.active; return b.getLine(b.cursorY) ? b.getLine(b.cursorY).translateToString(true).replace(/\\s+$/,'') : ''; })()`);
    if (buf.indexOf(' x') >= 0) ok(`空格正常敲出:inputBuf=${JSON.stringify(buf)} 行尾=${JSON.stringify(lastLine)}`);
    else if (buf.indexOf('x') >= 0) bad(`空格被吞!inputBuf=${JSON.stringify(buf)}(只有 x 没有前面的空格)`, null);
    else bad(`空格与 x 都没到服务器:inputBuf=${JSON.stringify(buf)} 行尾=${JSON.stringify(lastLine)}`, null);

    console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  } catch (e) { console.error('\n测试异常:', e && e.message); failed++; console.log(`\n结果: ${passed} 通过, ${failed} 失败`); }
  try { killTree(appProc); } catch {}
  process.exit(failed ? 1 : 0);
})();
