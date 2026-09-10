'use strict';
/**
 * verify-space-composition-flush.js — 复现:空格键把 xterm 组合缓冲区的残留内容发给 SSH(命令行被改写)
 *
 * 用户症状:敲 `df -Th` 回车 → 服务端收到 `df -Th T` → `df: T: 没有那个文件或目录`
 * 根因假设:renderer.js 空格 keydown 兜底会派发 synthetic compositionend,
 *          xterm 5.3 CompositionHelper._finalizeComposition 会把
 *          `this._textarea.value.substring(start,end)` 当用户输入 triggerDataEvent 发给 SSH。
 *          缓冲区有残留 → 残留内容被插进命令行(空格键每次都触发一次)。
 * 断言:
 *   A. 干净环境:敲 "df -Th" → 除按键本身外不应有多余 SEND(现状:每次空格多一条 SEND)
 *   B. 组合残留:输入法/组合视图留下 " T" + 敲空格 → 严禁把 " T" 发给 SSH(现状:发!)
 * 运行: node verify-space-composition-flush.js
 */
const { spawn, execSync } = require('child_process');
const { freePort, killTree, guardTimeout } = require('./test-helper');
const fs = require('fs'); const os = require('os'); const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-spflush-'));
const PORT = 9361, SSH = 2231;
// 先清掉本项目残留 dev 实例:它们占着 mock/CDP 端口时 app 会起不来(targets 未就绪)
try { execSync('pkill -f "polaris-terminal/node_modules/electron" 2>/dev/null'); } catch { /* 无残留 */ }
const sleep0 = (ms) => new Promise((r) => setTimeout(r, ms));
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
  if (r.exceptionDetails) throw new Error('JS异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 400) + ' @ ' + expr.slice(0, 80));
  return r.result && r.result.value;
}
let passed = 0, failed = 0;
const ok = (n) => { passed++; console.log('  ✓ ' + n); };
const bad = (n, e) => { failed++; console.error('  ✗ ' + n + (e ? ' -> ' + e : '')); };

// 真实按键(CDP 可信事件):key/code/text/winVK/macVK
const KEYS = {
  d: { key: 'd', code: 'KeyD', text: 'd', win: 68, mac: 2 },
  f: { key: 'f', code: 'KeyF', text: 'f', win: 70, mac: 3 },
  t: { key: 't', code: 'KeyT', text: 't', win: 84, mac: 17 },
  h: { key: 'h', code: 'KeyH', text: 'h', win: 72, mac: 4 },
  '-': { key: '-', code: 'Minus', text: '-', win: 189, mac: 27 },
  ' ': { key: ' ', code: 'Space', text: ' ', win: 32, mac: 49 },
};
async function tap(c, name) {
  const k = KEYS[name];
  await c.call('Input.dispatchKeyEvent', { type: 'keyDown', key: k.key, code: k.code, text: k.text, unmodifiedText: k.text, windowsVirtualKeyCode: k.win, nativeVirtualKeyCode: k.mac });
  await c.call('Input.dispatchKeyEvent', { type: 'keyUp', key: k.key, code: k.code, windowsVirtualKeyCode: k.win, nativeVirtualKeyCode: k.mac });
  await sleep(120);
}

(async () => {
  console.log('\n=== 空格键冲刷 xterm 组合缓冲区(命令行被改写)复现 ===\n');
  try {
    let lockT = null;
    for (let i = 0; i < 50; i++) { lockT = (await targets()).find((t) => /解锁/.test(t.title || '')); if (lockT) break; await sleep(400); }
    if (!lockT) throw new Error('解锁页未就绪');
    const lock = await connect(lockT.webSocketDebuggerUrl);
    for (let i = 0; i < 30; i++) { if (await ev(lock, `!!document.getElementById('pw')`)) break; await sleep(300); }
    await sleep(400);
    await ev(lock, `document.getElementById('pw').value='x1234567'; document.getElementById('pw2').value='x1234567'; document.getElementById('btn').click();`);
    let main = null;
    for (let i = 0; i < 30; i++) { await sleep(500); const t2 = await targets(); const m = t2.find((t) => t.type === 'page' && !/解锁/.test(t.title || '')); if (m) { main = m; break; } }
    const c = await connect(main.webSocketDebuggerUrl);
    await sleep(1200);

    await ev(c, `(async()=>{ await window.api.createSession({name:'sp', host:'127.0.0.1', port:${SSH}, username:'admin', password:'admin123', protocol:'ssh'}); await loadSessions(); return true; })()`);
    await sleep(400);
    const sessJson = await ev(c, `(function(){ for (const s of state.sessions) if (s.name==='sp') return JSON.stringify(s); return 'NOTFOUND'; })()`);
    if (sessJson === 'NOTFOUND') throw new Error('会话未创建成功');
    await ev(c, `connectToServer(${sessJson})`);
    let sid = null;
    for (let i = 0; i < 30; i++) { sid = await ev(c, `(state.tabs.size ? [...state.tabs.keys()][0] : null)`); if (sid && await ev(c, `state.tabs.get('${sid}').status`) === 'connected') break; await sleep(300); }
    if (!sid) throw new Error('未能建立 SSH 连接');
    ok('SSH 连接建立(sid=' + sid + ')');

    const readSends = async (from) => ev(c, `termDebug.lines.slice(${from}).filter(l => l.indexOf('SEND ${sid} ') >= 0)`);
    const mark = async () => ev(c, `termDebug.lines.length`);

    // ---------- A. 干净环境:敲 "df -Th" ----------
    await ev(c, `state.tabs.get('${sid}').term.focus(); true`);
    await sleep(150);
    let m0 = await mark();
    for (const k of ['d', 'f', ' ', '-', 't', 'h']) await tap(c, k);
    await sleep(300);
    const sendsA = await readSends(m0);
    console.log('   [A] 实际 SEND 序列:' + JSON.stringify(sendsA));
    const stA = await ev(c, `(function(){ const t=state.tabs.get('${sid}'); const ch=t.term._compositionHelper; return JSON.stringify({textarea: t.term.textarea.value, composing: !!(ch&&ch.isComposing), sending: !!(ch&&ch._isSendingComposition), pos: ch?ch._compositionPosition:null, viewActive: !!(t.term.element && t.term.element.querySelector('.composition-view.active'))}); })()`);
    console.log('   [A] 敲完后的组合状态:' + stA);
    const expectA = ['d', 'f', ' ', '-', 't', 'h'];
    const gotA = sendsA.map((l) => JSON.parse(l.slice(l.indexOf('"'))));
    if (JSON.stringify(gotA) === JSON.stringify(expectA)) ok('干净环境:每个按键只发一次,无多余内容');
    else bad('干净环境出现多余/异常发送', JSON.stringify(gotA));

    // ---------- B. 组合残留:输入法在 textarea 留下 " T",再敲空格 ----------
    await ev(c, `(function(){
      const t = state.tabs.get('${sid}'), ta = t.term.textarea;
      ta.value='';
      ta.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      ta.value=' T';   // 输入法/浏览器把 preedit 落进 textarea
      ta.dispatchEvent(new CompositionEvent('compositionupdate', { data: ' T', bubbles: true }));
      return true;
    })()`);
    await sleep(120); // compositionupdate 的 setTimeout 记录 end
    const before = await ev(c, `(function(){ const t=state.tabs.get('${sid}'); const ta=t.term.textarea; const ch=t.term._compositionHelper; return JSON.stringify({textareaValue: ta.value, composing: !!(ch&&ch.isComposing), sending: !!(ch&&ch._isSendingComposition), pos: ch?ch._compositionPosition:null}); })()`);
    console.log('   [B] 空格前组合状态:' + before);
    m0 = await mark();
    await tap(c, ' '); // 只敲空格
    await sleep(400);
    const sendsB = await readSends(m0);
    console.log('   [B] 本次空格触发的 SEND:' + JSON.stringify(sendsB));
    const junk = sendsB.filter((l) => l.indexOf('" T"') >= 0);
    const spaceSent = sendsB.some((l) => l.indexOf('" "') >= 0);
    if (junk.length) bad('组合残留被发给 SSH(命令行被改写)', JSON.stringify(junk));
    else ok('未把组合残留发给 SSH');
    if (spaceSent) ok('空格本身正常发出');
    else bad('空格被吞(没发出去)', JSON.stringify(sendsB));

    console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  } catch (e) { console.error('\n测试异常:', e && e.message); failed++; console.log(`\n结果: ${passed} 通过, ${failed} 失败`); }
  try { killTree(appProc); } catch { /* ignore */ }
  process.exit(failed ? 1 : 0);
})();
