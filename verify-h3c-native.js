'use strict';
/**
 * verify-h3c-native.js — 验证 H3C 堡垒机"原生 API"链路(替代 webview 注入钩子):
 *   ① 注入钩子已删:window.__bastionFetchAll 不存在;焦点桥在(Webview 浏览时焦点修复)
 *   ② webview 登录(仅作会话载体)→ 主进程 h3c:* IPC(persist:bastion cookie)原生拉资产
 *      → state.bastionAssets 合并(树 + 逐根分页 + 最近设备)
 *   ③ 登录成功 → 自动最小化到迷你条(登录模式)
 *   ④ bastionConnect → h3c:accessUrl 原生 → accessclient:// → 经 mock 网关 SSH 连接成功
 *   ⑤ 会话过期(清 partition cookie)→ 自动弹面板 + loginState=loggedOut;重登 → 再次自动最小化
 * 运行: node verify-h3c-native.js(需 9383 空闲;mock HTTP 8146 / SSH 2246;用 mock-server 自带 /shterm)
 */
const { spawn, execSync } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path');
const OUT = path.join(os.tmpdir(), 'verify-h3c-native-result.txt');
try { fs.writeFileSync(OUT, ''); } catch {}
const w = (s) => { try { fs.appendFileSync(OUT, s + '\n'); } catch {} };
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-h3cn-'));
const PORT = 9383, SSH = 2246, HTTP = 8146;
function freePort(p){ try{ execSync(`lsof -ti tcp:${p} | xargs kill -9 2>/dev/null`);}catch{} }
function killTree(proc){ try{ if(proc&&proc.pid) process.kill(-proc.pid,'SIGKILL'); }catch{} }
freePort(PORT); freePort(SSH); freePort(HTTP);
// mock-server.js 自带 /shterm 控制台 + API + SSH 网关(一个进程两服务)
const mockProc = spawn('node', ['mock/mock-server.js'], {
  env: { ...process.env, MOCK_HTTP_PORT: String(HTTP), MOCK_SSH_PORT: String(SSH) },
  stdio: ['ignore','ignore','ignore'], detached: true,
});
const appProc = spawn('node_modules/.bin/electron', ['.','--dev',`--remote-debugging-port=${PORT}`,'--no-sandbox','--disable-gpu'], {
  env: { ...process.env, POLARIS_LOCK_DIR: DIR, MOCK_SSH_PORT: String(SSH), MOCK_HTTP_PORT: String(HTTP), ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  stdio: ['ignore','ignore','ignore'], detached: true,
});
setTimeout(() => { try{ killTree(appProc); }catch{} try{ killTree(mockProc); }catch{} }, 150000);
const sleep = ms => new Promise(r=>setTimeout(r,ms));
async function targets(){ for(let i=0;i<50;i++){ try{ const r=await fetch(`http://127.0.0.1:${PORT}/json`); const j=await r.json(); const p=j.find(t=>t.type==='page'&&/解锁|Polaris/.test(t.title||'')); if(p) return j; }catch{} await sleep(400);} throw new Error('no targets'); }
function connect(url){ return new Promise((res,rej)=>{ const ws=new WebSocket(url); let id=0; const pend=new Map(); ws.onopen=()=>res({ call(m,p={}){return new Promise(r=>{const mid=++id;pend.set(mid,r);ws.send(JSON.stringify({id:mid,method:m,params:p}));});}, close(){ws.close();} }); ws.onerror=e=>rej(e); ws.onmessage=e=>{const m=JSON.parse(e.data); if(m.id&&pend.has(m.id)){pend.get(m.id)(m.result);pend.delete(m.id);}}; }); }
async function ev(c,expr){ const r=await c.call('Runtime.evaluate',{expression:expr,awaitPromise:true,returnByValue:true}); if(r.exceptionDetails) throw new Error('JS异常: '+JSON.stringify(r.exceptionDetails).slice(0,600)+' @ '+expr.slice(0,120)); return r.result&&r.result.value; }
async function evT(c, expr, ms) { return Promise.race([ev(c, expr), sleep(ms || 5000).then(() => 'EV-TIMEOUT')]); }
let passed=0, failed=0;
const ok=(n)=>{passed++;w('  ✓ '+n);};
const bad=(n,e)=>{failed++;w('  ✗ '+n+(e?' -> '+e:''));};
const check=(c,n,e)=>(c?ok(n):bad(n,e));
(async()=>{
  w('\n=== H3C 堡垒机原生 API 验证 ===\n');
  try {
    // 等 mock HTTP 起来
    for(let i=0;i<20;i++){ try{ const r=await fetch(`http://127.0.0.1:${HTTP}/shterm/`); if(r.status===200) break; }catch{} await sleep(300); }
    const ts = await targets();
    const lock = await connect(ts.find(t=>/解锁/.test(t.title||'')).webSocketDebuggerUrl);
    for(let i=0;i<30;i++){ if(await ev(lock,`!!document.getElementById('pw')`)) break; await sleep(300); }
    await sleep(300);
    await ev(lock, `document.getElementById('pw').value='x12345678'; document.getElementById('pw2').value='x12345678'; document.getElementById('btn').click();`);
    let c=null;
    for(let i=0;i<30;i++){ await sleep(500); const t2=await targets(); const m=t2.find(t=>t.type==='page'&&!/解锁/.test(t.title||'')); if(m){ c=await connect(m.webSocketDebuggerUrl); break; } }
    check(!!c, '解锁后主窗口出现');
    for(let i=0;i<40;i++){ if(await ev(c,`!!document.getElementById('bastion-webview')`)) break; await sleep(300); }
    await ev(c, `state.settings.verifyHostKey = false; state.settings.autoTrustHostKey = true; saveSettings();`);

    // ① 打开堡垒机面板,webview 指向 mock H3C 控制台 /shterm(登录载体)
    await ev(c, `openBastionPanel()`);
    await sleep(400);
    await ev(c, `loadBastion('http://127.0.0.1:${HTTP}/shterm/')`);
    w('[step] webview 已指向 mock H3C /shterm,等待登录表单…');
    let formReady = false;
    for(let i=0;i<30;i++){
      formReady = await ev(c, `(async()=>{ const wv=els.bastionWebview; if(!wv||!wv.executeJavaScript) return false; return wv.executeJavaScript('!!document.getElementById("loginForm")').catch(()=>false); })()`).catch(()=>false);
      if (formReady) break; await sleep(500);
    }
    check(formReady, 'webview 加载到 H3C 登录表单');

    // ② 断言注入钩子已删、焦点桥在(登录页未登录时 poll 已跑过一次 needLogin 探测)
    await sleep(1500); // 等 800ms debounce 注入焦点桥
    let hookGone = false, focusBridge = false;
    for(let i=0;i<10;i++){
      hookGone = await ev(c, `(async()=>{ const wv=els.bastionWebview; const r=await wv.executeJavaScript('typeof window.__bastionFetchAll').catch(()=>"ERR"); return r === 'undefined'; })()`).catch(()=>false);
      focusBridge = await ev(c, `(async()=>{ const wv=els.bastionWebview; const r=await wv.executeJavaScript('typeof window.__bastionFocusTs').catch(()=>"ERR"); return r === 'number'; })()`).catch(()=>false);
      if (hookGone && focusBridge) break; await sleep(400);
    }
    check(hookGone, '注入资产钩子已移除(window.__bastionFetchAll 不存在)');
    check(focusBridge, '焦点桥注入正常(window.__bastionFocusTs 是 number)');

    // ③ 登录(驱动 webview 表单 → mock Set-Cookie 进 persist:bastion)
    await ev(c, `(async()=>{ const wv=els.bastionWebview; return wv.executeJavaScript('document.getElementById("username").value="admin"; document.getElementById("password").value="admin123"; document.getElementById("loginForm").dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})); true'); })()`);
    w('[step] 已提交登录,等待原生拉取资产…');
    let assets = 0;
    for(let i=0;i<40;i++){ assets = await ev(c, `state.bastionAssets.length`).catch(()=>0); if (assets >= 5) break; await sleep(500); }
    check(assets >= 5, '主进程原生拉取到 H3C 资产(state.bastionAssets=' + assets + ' 台)');
    check(await ev(c, `(state.bastionTree||[]).length >= 2`), '目录树已加载(≥2 个业务目录)');
    const loginState1 = await ev(c, `bastionLoginState`);
    check(loginState1 === 'loggedIn', '登录状态机置为 loggedIn(实际=' + loginState1 + ')');

    // ④ 登录成功自动最小化(登录模式)
    let minimized = false;
    for(let i=0;i<20;i++){
      minimized = await ev(c, `els.bastionSlot.classList.contains('hidden') && !els.bastionMini.classList.contains('hidden')`).catch(()=>false);
      if (minimized) break; await sleep(300);
    }
    check(minimized, '登录成功后面板自动最小化到迷你条');

    // ⑤ bastionConnect → h3c:accessUrl 原生 → 经 mock 网关 SSH 连接
    w('[step] 调用 bastionConnect(原生 accessUrl)…');
    const bc = await evT(c, `(async()=>{ const a = state.bastionAssets.find(x=>x.devId==='dev-1') || state.bastionAssets[0]; bastionConnect(a, null, 'ssh', false); return a ? a.devId : 'none'; })()`, 6000);
    w('[step] 连接目标: ' + bc);
    let connected=false;
    for(let i=0;i<30;i++){ connected=await evT(c,`[...state.tabs.values()].some(t=>t.status==='connected')`, 5000); if(connected===true) break; await sleep(500); }
    check(connected === true, 'bastionConnect → 原生 accessUrl → 经网关 SSH 连接成功');
    const tabInfo = await evT(c, `(async()=>{ const t=[...state.tabs.values()].find(x=>x.session&&x.session.bastionKey); return t ? JSON.stringify({ name: t.session.name, host: t.session.host, port: t.session.port, displayHost: t.session.displayHost, bastionKey: t.session.bastionKey }) : 'none'; })()`, 6000);
    const ti = JSON.parse(tabInfo);
    check(ti.name === 'web-node-1' && ti.host === '127.0.0.1' && ti.port === SSH && ti.displayHost === '192.168.10.99' && ti.bastionKey === 'h3c-dev-1',
      '会话按 H3C 资产正确构造(名称/网关/目标/资产键): ' + tabInfo);

    // ⑥ 会话过期:清 persist:bastion partition cookie(jms:webLogout 是现成的清 cookie 通道)
    await ev(c, `window.api.jmsWebLogout('http://127.0.0.1:${HTTP}')`);
    w('[step] 已清 partition cookie,触发全量拉取 → 应探测到未登录');
    let loggedOut = false;
    for(let i=0;i<20;i++){
      await ev(c, `triggerBastionFullFetch()`).catch(()=>{});
      loggedOut = await ev(c, `bastionLoginState === 'loggedOut'`).catch(()=>false);
      if (loggedOut) break; await sleep(400);
    }
    check(loggedOut, '会话过期 → loginState 置 loggedOut');
    let reopened = false;
    for(let i=0;i<20;i++){
      reopened = await ev(c, `!els.bastionSlot.classList.contains('hidden')`).catch(()=>false);
      if (reopened) break; await sleep(300);
    }
    check(reopened, '会话过期 → 面板自动弹出(重登)');

    // ⑦ 重登 → 再次自动最小化(验证 bastionAutoMinimized 重置 + 登录模式重新生效)
    await ev(c, `(async()=>{ const wv=els.bastionWebview; return wv.executeJavaScript('window.location.href = "/shterm/"; true'); })()`);
    w('[step] 已导航回登录页,等待表单…');
    for(let i=0;i<30;i++){
      formReady = await ev(c, `(async()=>{ const wv=els.bastionWebview; return wv.executeJavaScript('!!document.getElementById("loginForm")').catch(()=>false); })()`).catch(()=>false);
      if (formReady) break; await sleep(500);
    }
    check(formReady, '重登:登录表单已加载');
    await ev(c, `(async()=>{ const wv=els.bastionWebview; return wv.executeJavaScript('document.getElementById("username").value="admin"; document.getElementById("password").value="admin123"; document.getElementById("loginForm").dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})); true'); })()`);
    let relogged = false, remin = false;
    for(let i=0;i<40;i++){
      relogged = await ev(c, `bastionLoginState === 'loggedIn'`).catch(()=>false);
      if (relogged) break; await sleep(500);
    }
    check(relogged, '重登成功 → loginState 再次 loggedIn');
    for(let i=0;i<20;i++){
      remin = await ev(c, `els.bastionSlot.classList.contains('hidden') && !els.bastionMini.classList.contains('hidden')`).catch(()=>false);
      if (remin) break; await sleep(300);
    }
    check(remin, '重登后再次自动最小化(once-per-login 重置)');

    w('\n结果: '+passed+' 通过, '+failed+' 失败');
  } catch (e) { w('\n测试异常: '+(e&&e.message)); w('结果: '+passed+' 通过, '+failed+' 失败'); }
  try { killTree(appProc); } catch {}
  try { killTree(mockProc); } catch {}
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch {}
  setTimeout(() => process.exit(failed ? 1 : 0), 300);
})();
