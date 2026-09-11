'use strict';
/**
 * verify-batch-focus.js — 批量连接不再抢焦点/切激活标签(#10 回归)
 *   旧行为:connectToServer 无条件 activateTab → term.focus(),批量入口每 500ms 一台 →
 *          正在看的终端被逐台切走、焦点被抢(FOCUS 日志刷屏)。
 *   断言:① 会话列表批量连接:激活标签与键盘焦点都不变,新标签照常连上
 *        ② H3C 资产批量连接(用户报的场景):同上
 *        ③ 点开后台上标签:能激活并自愈尺寸(后台标签先按 80x24 建 PTY)
 *        ④ 对照:单台用户连接仍走前台(激活 + 聚焦),证明改动只作用于批量入口
 * 运行: node verify-batch-focus.js(需 9381/2256 空闲)
 */
const { spawn, execSync } = require('child_process');
const { freePort, killTree, guardTimeout } = require('./test-helper');
const fs = require('fs'); const os = require('os'); const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-batchfocus-'));
const MOCK_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-batchfocus-disk-'));
const PORT = 9381, SSH = 2256, HTTP = 2356;
try { execSync('pkill -f "polaris-terminal/node_modules/electron" 2>/dev/null'); } catch { /* 无残留 */ }
freePort(PORT); freePort(SSH); freePort(HTTP);
process.env.MOCK_SSH_PORT = String(SSH);
process.env.MOCK_HTTP_PORT = String(HTTP);
process.env.MOCK_SFTP_ROOT = MOCK_ROOT;
const { start } = require('./mock/mock-server');
start();
const BASE = `http://127.0.0.1:${HTTP}`;

const appProc = spawn('node_modules/.bin/electron', ['.', '--dev', `--remote-debugging-port=${PORT}`], {
  env: { ...process.env, POLARIS_LOCK_DIR: DIR, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  stdio: ['ignore', 'ignore', 'ignore'], detached: true,
});
guardTimeout(240000, appProc);
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
let passed = 0, failed = 0;
const ok = (n) => { passed++; console.log('  ✓ ' + n); };
const bad = (n, e) => { failed++; console.error('  ✗ ' + n + (e ? ' → ' + e : '')); };
// 当前激活标签 + 焦点是否在它自己身上(抢焦点的判定)
const focusState = `(function(){ const t=state.tabs.get(state.activeSessionId); return JSON.stringify({ active: state.activeSessionId, tabs: state.tabs.size, focusOnActive: !!(t && document.activeElement === t.term.textarea) }); })()`;

(async () => {
  console.log('\n=== 批量连接不抢焦点(#10) ===\n');
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
    // 造 4 个普通会话 + 桩(alert 会阻塞 CDP,必须换成记录)
    await ev(c, `(async()=>{
      state.settings.verifyHostKey=false; state.settings.autoTrustHostKey=true;
      window.__alerts=[]; window.alert=(m)=>{ window.__alerts.push(String(m)); };
      for (const n of ['bf1','bf2','bf3','bf4']) await window.api.createSession({name:n, host:'127.0.0.1', port:${SSH}, username:'admin', password:'admin123', protocol:'ssh'});
      await loadSessions(); return true; })()`);
    await sleep(500);

    // 前台连第一台 → 它成为激活标签并获得焦点
    const j1 = await ev(c, `(function(){ const s=state.sessions.find(x=>x.name==='bf1'); return JSON.stringify(s); })()`);
    await ev(c, `connectToServer(${j1})`);
    for (let i = 0; i < 30; i++) { if (await ev(c, `state.tabs.size===1 && state.tabs.get(state.activeSessionId).status==='connected'`)) break; await sleep(300); }
    await ev(c, `state.tabs.get(state.activeSessionId).term.focus(); true`);
    await sleep(300);
    const before = JSON.parse(await ev(c, focusState));
    if (before.focusOnActive) ok(`① 前台连接:激活标签 ${before.active} 且焦点在它身上(前提成立)`);
    else bad('① 前台连接后焦点不在激活终端(前提不成立)', JSON.stringify(before));

    // ---- ① 会话列表批量连接 3 台 ----
    await ev(c, `(function(){ const ids=['bf2','bf3','bf4'].map(n=>state.sessions.find(x=>x.name===n).id); state.selectedForBatch=new Set(ids); batchConnect(); return true; })()`);
    for (let i = 0; i < 40; i++) { const n = await ev(c, `[...state.tabs.values()].filter(t=>t.status==='connected').length`); if (n >= 4) break; await sleep(300); }
    await sleep(600);
    const after1 = JSON.parse(await ev(c, focusState));
    if (after1.tabs === 4) ok(`① 批量连接完成:共 ${after1.tabs} 个标签,全部连上`);
    else bad('① 批量连接未全部完成', JSON.stringify(after1));
    if (after1.active === before.active) ok(`① 激活标签未被打断(仍 ${after1.active})`);
    else bad('① 激活标签被批量连接切走(旧 bug)', JSON.stringify({ before: before.active, after: after1.active }));
    if (after1.focusOnActive) ok('① 键盘焦点仍在原终端(未被抢)');
    else bad('① 焦点被抢走了(旧 bug)', JSON.stringify(after1));

    // ---- ③ 点开后台上标签:激活 + 尺寸自愈 ----
    const bgSid = await ev(c, `[...state.tabs.keys()].find(k=>k!=='${before.active}')`);
    const colsBefore = await ev(c, `state.tabs.get('${bgSid}').term.cols`);
    await ev(c, `activateTab('${bgSid}'); true`);
    await sleep(800);
    const after3 = JSON.parse(await ev(c, focusState));
    const colsAfter = await ev(c, `state.tabs.get('${bgSid}').term.cols`);
    if (after3.active === bgSid && after3.focusOnActive) ok(`③ 点开后台标签:已激活且获得焦点(${bgSid})`);
    else bad('③ 激活后台标签失败', JSON.stringify(after3));
    if (colsAfter >= colsBefore) ok(`③ 尺寸自愈:后台期 ${colsBefore} 列 → 激活后 ${colsAfter} 列`);
    else bad('③ 激活后列数反而变小', JSON.stringify({ colsBefore, colsAfter }));

    // ---- ④ 对照:单台用户连接仍走前台 ----
    await ev(c, `activateTab('${before.active}'); true`);
    await sleep(300);
    const j5 = await ev(c, `(function(){ const s=state.sessions.find(x=>x.name==='bf4'); return JSON.stringify(s); })()`);
    await ev(c, `connectToServer(${j5})`);
    for (let i = 0; i < 30; i++) { if (await ev(c, `state.tabs.get(state.activeSessionId).session.name==='bf4' && state.tabs.get(state.activeSessionId).status==='connected'`)) break; await sleep(300); }
    await sleep(400);
    const after4 = JSON.parse(await ev(c, focusState));
    if (after4.active !== before.active && after4.focusOnActive) ok('④ 对照:单台连接仍前台激活并聚焦(改动只作用于批量入口)');
    else bad('④ 单台连接行为异常', JSON.stringify(after4));

    // ---- ② H3C 资产批量连接(用户报的场景) ----
    await ev(c, `(async()=>{
      // 保存一台 H3C 堡垒机(指向 mock)并加载 → 自动填充登录
      // 注意:webview 要加载的是控制台页面(带 /shterm 路径);裸 origin 在 mock 上是 404
      bastionServers().push({ id:'bf-h3c', name:'mock-h3c', url:${JSON.stringify(BASE + '/shterm/')}, account:'admin', password:'admin123', type:'h3c' });
      state.settings.bastionUrl = ${JSON.stringify(BASE)};
      openBastionPanel();                    // 与真实用法一致:面板打开(隐藏容器里的 webview 不保证开始加载)
      bastionSelectServer('B:bf-h3c'); return true; })()`);
    let logged = false;
    for (let i = 0; i < 60; i++) { const r = await ev(c, `(async()=>{ const r = await window.api.h3cRecent({ baseUrl: ${JSON.stringify(BASE)}, page: 0 }); return !!(r && r.ok); })()`); if (r) { logged = true; break; } await sleep(700); }
    if (logged) ok('② H3C mock 已登录(拿到会话 cookie)');
    else throw new Error('H3C 登录未完成(webview 自动填充失败)');
    const assets = JSON.parse(await ev(c, `(async()=>{ const r = await window.api.h3cDevs({ baseUrl: ${JSON.stringify(BASE)}, paths:['生产一'], page:0 }); const list = bastionParseDevs(r.data, ['生产一']); window.__h3cAssets = list; return JSON.stringify(list.slice(0,2).map(a=>({name:a.name, devId:a.devId}))); })()`));
    if (assets.length >= 2) ok(`② 解析到 H3C 资产:${assets.map((a) => a.name).join(', ')}`);
    else bad('② 未解析到 H3C 资产(前提不成立)', JSON.stringify(assets));
    const activeBeforeH3c = await ev(c, `state.activeSessionId`);
    const tabsBefore = await ev(c, `state.tabs.size`);
    // 注:openBastionPanel() 按设计会把焦点交给 webview(便于在控制台里操作),
    // 所以这里断言的是"焦点没被**新建的终端**抢走",而不是"焦点在旧终端上"。
    const focusDesc = `(function(){ const a=document.activeElement; return a ? (a.tagName + (a.id ? '#'+a.id : '')) : 'null'; })()`;
    const focusBeforeH3c = await ev(c, focusDesc);
    await ev(c, `batchBastionConnect(window.__h3cAssets.slice(0,2)); true`);
    let h3cTabs = 0;
    for (let i = 0; i < 40; i++) {
      h3cTabs = await ev(c, `[...state.tabs.values()].filter(t=>/^bastion-/.test(String(t.session.id)) && t.status==='connected').length`);
      if (h3cTabs >= 2) break;
      await sleep(400);
    }
    await sleep(600);
    if (h3cTabs >= 2) ok(`② H3C 批量连接:${h3cTabs} 个资产已连上(共 ${tabsBefore} → ${await ev(c, 'state.tabs.size')} 个标签)`);
    else bad('② H3C 批量连接未完成', JSON.stringify({ h3cTabs, alerts: await ev(c, 'window.__alerts') }));
    const afterH3c = JSON.parse(await ev(c, focusState));
    if (afterH3c.active === activeBeforeH3c) ok('② H3C 批量:激活标签未被打断(用户报的"终端被切走"已修)');
    else bad('② H3C 批量把激活标签切走了(旧 bug)', JSON.stringify({ before: activeBeforeH3c, after: afterH3c.active }));
    const focusStolen = await ev(c, `[...state.tabs.values()].some(t => document.activeElement === t.term.textarea && /^bastion-/.test(String(t.session.id)))`);
    const focusAfterH3c = await ev(c, focusDesc);
    if (!focusStolen) ok(`② H3C 批量:焦点没被新建终端抢走(批量前 ${focusBeforeH3c} → 批量后 ${focusAfterH3c})`);
    else bad('② H3C 批量把焦点抢进了新终端(旧 bug)', JSON.stringify({ focusAfterH3c }));

    console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  } catch (e) { console.error('\n测试异常:', e && e.message); failed++; console.log(`\n结果: ${passed} 通过, ${failed} 失败`); }
  try { killTree(appProc); } catch { /* ignore */ }
  try { fs.rmSync(MOCK_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(failed ? 1 : 0);
})();
