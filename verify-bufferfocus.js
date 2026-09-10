'use strict';
/**
 * verify-bufferfocus.js — 验证"远端备用屏切换不再乱抢焦点":
 *   ① 焦点在搜索框里时,当前标签切备用屏(远端 vim 之类)→ 焦点不被拽回终端
 *   ② 焦点在 body(终端失焦)时切备用屏 → 仍然补焦点回终端(原"vim 退出后打不了字"的修复不回退)
 *   ③ 非当前标签切备用屏 → 不动当前焦点(后台标签不抢焦点)
 * 运行: node verify-bufferfocus.js(需 9364/2234 空闲)
 */
const { spawn, execSync } = require('child_process');
const { freePort, killTree, guardTimeout } = require('./test-helper');
const fs = require('fs'); const os = require('os'); const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-buffocus-'));
const PORT = 9364, SSH = 2234;
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
guardTimeout(180000, appProc);
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
const active = `(function(){ const a=document.activeElement; return a ? (a.id ? '#'+a.id : (a.tagName + (typeof a.className==='string' && a.className ? '.'+a.className.split(' ')[0] : ''))) : 'null'; })()`;

(async () => {
  console.log('\n=== 备用屏切换不抢焦点 ===\n');
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

    // 建两个会话(都连上,后面用第二个当"非当前标签")
    for (const nm of ['bf-a', 'bf-b']) {
      await ev(c, `(async()=>{ await window.api.createSession({name:'${nm}', host:'127.0.0.1', port:${SSH}, username:'admin', password:'admin123', protocol:'ssh'}); await loadSessions(); return true; })()`);
      await sleep(300);
      const sj = await ev(c, `(function(){ for (const s of state.sessions) if (s.name==='${nm}') return JSON.stringify(s); return 'NOTFOUND'; })()`);
      if (sj === 'NOTFOUND') throw new Error('会话未创建:' + nm);
      await ev(c, `connectToServer(${sj})`);
      await sleep(1200);
    }
    const ids = await ev(c, `JSON.stringify([...state.tabs.keys()])`);
    const [sidA, sidB] = JSON.parse(ids);
    if (!sidA || !sidB) throw new Error('两个标签未建立:' + ids);
    for (const s of [sidA, sidB]) {
      for (let i = 0; i < 30; i++) { if (await ev(c, `state.tabs.get('${s}').status`) === 'connected') break; await sleep(300); }
    }
    ok(`两个会话已连接(${sidA} / ${sidB})`);
    await ev(c, `toggleSftpPanel(); true`); // 打开 SFTP 面板,用它的路径框当"别处输入"
    await sleep(600);

    // ① 焦点在路径框 → 当前标签切备用屏,焦点不该被拽走
    await ev(c, `activateTab('${sidA}'); document.getElementById('input-session-search').focus(); true`);
    await sleep(300);
    const before1 = await ev(c, active);
    await ev(c, `state.tabs.get('${sidA}').term.write('\\x1b[?1049h'); true`);
    await sleep(400);
    await ev(c, `state.tabs.get('${sidA}').term.write('\\x1b[?1049l'); true`);
    await sleep(500);
    const after1 = await ev(c, active);
    if (after1 === before1 && /input-session-search/.test(String(after1))) ok(`焦点留在搜索框(未被抢):${after1}`);
    else bad('焦点被备用屏切换抢走了', JSON.stringify({ before1, after1 }));

    // ② 焦点在 body(失焦)→ 切备用屏仍应补回终端(原修复不回退)
    await ev(c, `document.activeElement && document.activeElement.blur(); true`);
    await sleep(200);
    const before2 = await ev(c, active);
    await ev(c, `state.tabs.get('${sidA}').term.write('\\x1b[?1049h'); true`);
    await sleep(400);
    await ev(c, `state.tabs.get('${sidA}').term.write('\\x1b[?1049l'); true`);
    await sleep(500);
    const after2 = await ev(c, active);
    if (/xterm-helper-textarea/.test(String(after2))) ok(`失焦时切备用屏仍补回终端(${before2} → ${after2})`);
    else bad('失焦时没有补回终端焦点', JSON.stringify({ before2, after2 }));

    // ③ 非当前标签切备用屏 → 不动当前焦点
    await ev(c, `activateTab('${sidA}'); document.getElementById('input-session-search').focus(); true`);
    await sleep(300);
    const before3 = await ev(c, active);
    await ev(c, `state.tabs.get('${sidB}').term.write('\\x1b[?1049h'); true`);
    await sleep(400);
    await ev(c, `state.tabs.get('${sidB}').term.write('\\x1b[?1049l'); true`);
    await sleep(500);
    const after3 = await ev(c, active);
    if (after3 === before3) ok(`非当前标签切备用屏不影响焦点(${after3})`);
    else bad('非当前标签抢走了焦点', JSON.stringify({ before3, after3 }));

    console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  } catch (e) { console.error('\n测试异常:', e && e.message); failed++; console.log(`\n结果: ${passed} 通过, ${failed} 失败`); }
  try { killTree(appProc); } catch { /* ignore */ }
  process.exit(failed ? 1 : 0);
})();
