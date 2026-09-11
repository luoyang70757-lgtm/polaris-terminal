'use strict';
/**
 * verify-dangerous-onclick.js — 生产危险命令确认覆盖"一键执行入口"(回归)
 *   产品要求:所有一键入口都必须与手敲同一套生产保护,含 batch:exec。
 *   覆盖:① 终端手敲 ② AI 代码块/推荐(runInActiveTerminal) ③ 快捷命令「▶ 当前」
 *        ④ 命令记录重发 ⑤ 批量执行(batch:exec) ⑥ 登录宏(on_connect)
 *   反例:非生产会话不弹窗(防过度打扰);同意后命令确实执行。
 * 运行: node verify-dangerous-onclick.js(需 9375/2251 空闲)
 */
const { spawn, execSync } = require('child_process');
const { freePort, killTree, guardTimeout } = require('./test-helper');
const fs = require('fs'); const os = require('os'); const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-danger-'));
const MOCK_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-danger-disk-'));
const PORT = 9375, SSH = 2251;
try { execSync('pkill -f "polaris-terminal/node_modules/electron" 2>/dev/null'); } catch { /* 无残留 */ }
freePort(PORT); freePort(SSH);
process.env.MOCK_SSH_PORT = String(SSH);
process.env.MOCK_HTTP_PORT = String(SSH + 100);
process.env.MOCK_SFTP_ROOT = MOCK_ROOT;
const { start } = require('./mock/mock-server');
start();

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
const bufOf = (sid) => `(function(){ const t=state.tabs.get('${sid}'); if(!t) return ''; const b=t.term.buffer.active; let s=''; for(let i=Math.max(0,b.length-60);i<b.length;i++){const l=b.getLine(i); if(l) s+=l.translateToString(true)+'\\n';} return s; })()`;
let passed = 0, failed = 0;
const ok = (n) => { passed++; console.log('  ✓ ' + n); };
const bad = (n, e) => { failed++; console.error('  ✗ ' + n + (e ? ' → ' + e : '')); };
const CMD = (n) => `rm -rf /tmp/pol-danger-${n}`; // 每例独立命令:断言"有没有发出去"时不会串台
// 真实按键输入(走 term.onData,才会经过终端里的生产守卫)
async function typeLine(c, text) {
  await c.call('Input.insertText', { text });
  await sleep(150);
  await c.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', unmodifiedText: '\r', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 36 });
  await c.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 36 });
  await sleep(500);
}

(async () => {
  console.log('\n=== 生产危险命令确认:一键入口全覆盖 ===\n');
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

    // 建"生产分组" + 一个生产会话 + 一个普通会话
    await ev(c, `(async()=>{
      const g = await window.api.createGroup('pol-prod');
      await window.api.setGroupProd(g.id, true);
      await window.api.createSession({name:'prod1', host:'127.0.0.1', port:${SSH}, username:'admin', password:'admin123', protocol:'ssh', groupId: g.id});
      await window.api.createSession({name:'plain1', host:'127.0.0.1', port:${SSH}, username:'admin', password:'admin123', protocol:'ssh'});
      state.settings.verifyHostKey=false; state.settings.autoTrustHostKey=true;
      await loadSessions(); return true;
    })()`);
    await sleep(600);
    const isProd = await ev(c, `(function(){ const s=state.sessions.find(x=>x.name==='prod1'); return !!(s && isSessionProd(s)); })()`);
    if (isProd) ok('生产分组与会话已就绪(isSessionProd=true)');
    else throw new Error('生产标记未生效,测试前提不成立');
    // 桩:记录 confirm 调用 + 默认"拒绝"
    await ev(c, `window.__confirms=[]; window.__ans=false; window.confirm=(m)=>{ window.__confirms.push(String(m)); return window.__ans; }; window.__sent=[]; true`);

    // 连生产会话
    const pj = await ev(c, `(function(){ const s=state.sessions.find(x=>x.name==='prod1'); return JSON.stringify(s); })()`);
    await ev(c, `connectToServer(${pj})`);
    let sid = null;
    for (let i = 0; i < 30; i++) { sid = await ev(c, `(state.tabs.size ? [...state.tabs.keys()][0] : null)`); if (sid && await ev(c, `state.tabs.get('${sid}').status`) === 'connected') break; await sleep(300); }
    if (!sid) throw new Error('生产会话连接失败');
    ok('生产会话已连接(sid=' + sid + ')');
    await ev(c, `state.tabs.get('${sid}').term.focus(); true`);
    await sleep(200);

    const nConfirms = () => ev(c, `window.__confirms.length`);
    const lastConfirm = () => ev(c, `window.__confirms[window.__confirms.length-1] || ''`);

    // ① 手敲(真实按键 → 经 term.onData 的生产守卫)
    // 先等连接初始化(编码探针 + finishInitClean)结束:它会补发一个裸回车以取得干净提示符,
    // 若此时行里已有内容会被提前执行(与本次改动无关的既有行为)。
    for (let i = 0; i < 25; i++) { if (!(await ev(c, `!!state.tabs.get('${sid}').initMask`))) break; await sleep(300); }
    await sleep(500);
    await ev(c, `state.tabs.get('${sid}').term.focus(); true`);
    await typeLine(c, CMD(1));
    const c1 = await nConfirms();
    if (c1 === 1 && /终端手敲/.test(String(await lastConfirm()))) ok('① 手敲:弹出生产确认');
    else bad('① 手敲:未弹确认', JSON.stringify({ c1, msg: String(await lastConfirm()).slice(0, 70) }));
    // 判别串用 "bash: rm:" —— 应用自己的编码探针(mock 未实现 printf)也会打印 "command not found",
    // 用它当判别会把探针误判成"命令被执行了"(实测踩过)。
    const b1 = String(await ev(c, bufOf(sid)));
    if (!b1.includes('bash: rm:')) ok('① 手敲:拒绝后命令未提交执行(未出现 "bash: rm:")');
    else bad('① 手敲:拒绝后命令仍被执行', JSON.stringify(b1.split('\n').filter((l) => l.includes('bash: rm:')).slice(0, 2)));

    // ② AI 代码块 / 推荐项执行
    await ev(c, `runInActiveTerminal(${JSON.stringify(CMD(2))}); true`);
    await sleep(400);
    const c2 = await nConfirms();
    if (c2 === 2 && /AI 代码块/.test(String(await lastConfirm()))) ok('② runInActiveTerminal(AI 代码块/推荐)弹出确认');
    else bad('② runInActiveTerminal 未弹确认', JSON.stringify({ c2, msg: String(await lastConfirm()).slice(0, 70) }));
    if (!String(await ev(c, bufOf(sid))).includes(CMD(2))) ok('② 拒绝后未发送');
    else bad('② 拒绝后仍发送');

    // ③ 快捷命令「▶ 当前」
    await ev(c, `sendQuickCurrent('危险命令', ${JSON.stringify(CMD(3))}); true`);
    await sleep(400);
    const c3 = await nConfirms();
    if (c3 === 3 && /快捷命令/.test(String(await lastConfirm()))) ok('③ 快捷命令「▶ 当前」弹出确认');
    else bad('③ 快捷命令未弹确认', JSON.stringify({ c3, msg: String(await lastConfirm()).slice(0, 70) }));
    if (!String(await ev(c, bufOf(sid))).includes(CMD(3))) ok('③ 拒绝后未发送');
    else bad('③ 拒绝后仍发送');

    // ④ 命令记录重发
    await ev(c, `resendCommand('127.0.0.1', ${JSON.stringify(CMD(4))}); true`);
    await sleep(400);
    const c4 = await nConfirms();
    if (c4 === 4 && /重发/.test(String(await lastConfirm()))) ok('④ 命令记录重发弹出确认');
    else bad('④ 重发未弹确认', JSON.stringify({ c4, msg: String(await lastConfirm()).slice(0, 70) }));
    if (!String(await ev(c, bufOf(sid))).includes(CMD(4))) ok('④ 拒绝后未发送');
    else bad('④ 拒绝后仍发送');

    // ⑤ 批量执行(batch:exec)
    await ev(c, `(async()=>{ els.batchCmd.value=${JSON.stringify(CMD(5))}; state.batchHosts=new Set(['${sid}']); renderBatchHosts(); await runBatchExec(); return true; })()`);
    await sleep(600);
    const c5 = await nConfirms();
    const res5 = await ev(c, `document.querySelectorAll('#batch-results .batch-res-item').length`);
    if (c5 === 5 && /batch:exec/.test(String(await lastConfirm()))) ok('⑤ 批量执行(batch:exec)弹出确认');
    else bad('⑤ 批量执行未弹确认', JSON.stringify({ c5, msg: String(await lastConfirm()).slice(0, 70) }));
    if (res5 === 0) ok('⑤ 拒绝后没有产生执行结果');
    else bad('⑤ 拒绝后仍执行了', String(res5));

    // ⑥ 登录宏(on_connect,连接后自动发送)
    const macroJson = await ev(c, `(function(){ const s=state.sessions.find(x=>x.name==='prod1'); const o=Object.assign({}, s, { on_connect: ${JSON.stringify(CMD(6))}, name: 'prod-macro' }); return JSON.stringify(o); })()`);
    await ev(c, `connectToServer(${macroJson})`);
    let sid2 = null;
    for (let i = 0; i < 30; i++) { sid2 = await ev(c, `(state.tabs.size>1 ? [...state.tabs.keys()][1] : null)`); if (sid2 && await ev(c, `state.tabs.get('${sid2}').status`) === 'connected') break; await sleep(300); }
    await sleep(1500); // 宏在 connected 后 400ms 起发送
    const c6 = await nConfirms();
    if (c6 === 6 && /登录宏/.test(String(await lastConfirm()))) ok('⑥ 登录宏含危险命令 → 连接时弹出确认');
    else bad('⑥ 登录宏未弹确认', JSON.stringify({ c6, msg: String(await lastConfirm()).slice(0, 70) }));
    if (sid2 && !String(await ev(c, bufOf(sid2))).includes(CMD(6))) ok('⑥ 拒绝后宏未发送');
    else bad('⑥ 拒绝后宏仍发送了');

    // ⑦ 反例:同意后确实执行(生产会话)——先切回该标签(⑥ 新连的标签会抢走 activeSessionId)
    await ev(c, `window.__ans=true; activateTab('${sid}'); true`);
    await sleep(300);
    const before7 = await nConfirms();
    await ev(c, `runInActiveTerminal(${JSON.stringify(CMD(7))}); true`);
    await sleep(900);
    const b7 = String(await ev(c, bufOf(sid)));
    if ((await nConfirms()) === before7 + 1 && b7.includes(CMD(7))) ok('⑦ 同意后命令确实发到终端(正向对照)');
    else bad('⑦ 同意后未发送', JSON.stringify({ confirms: await nConfirms(), sent: b7.includes(CMD(7)) }));

    // ⑧ 反例:非生产会话不弹窗(不打扰)
    const plainJson = await ev(c, `(function(){ const s=state.sessions.find(x=>x.name==='plain1'); return JSON.stringify(s); })()`);
    await ev(c, `connectToServer(${plainJson})`);
    let sid3 = null;
    for (let i = 0; i < 30; i++) { sid3 = await ev(c, `(state.tabs.size>2 ? [...state.tabs.keys()][2] : null)`); if (sid3 && await ev(c, `state.tabs.get('${sid3}').status`) === 'connected') break; await sleep(300); }
    await sleep(600);
    const before8 = await nConfirms();
    await ev(c, `state.tabs.get('${sid3}').term.focus(); runInActiveTerminal(${JSON.stringify(CMD(8))}); true`);
    await sleep(700);
    const after8 = await nConfirms();
    if (after8 === before8) ok('⑧ 非生产会话:危险命令不弹窗(不打扰)');
    else bad('⑧ 非生产会话被误弹窗', JSON.stringify({ before8, after8, msg: String(await lastConfirm()).slice(0, 70) }));

    console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  } catch (e) { console.error('\n测试异常:', e && e.message); failed++; console.log(`\n结果: ${passed} 通过, ${failed} 失败`); }
  try { killTree(appProc); } catch { /* ignore */ }
  try { fs.rmSync(MOCK_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(failed ? 1 : 0);
})();
