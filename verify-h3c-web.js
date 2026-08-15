'use strict';
/**
 * verify-h3c-web.js — 验证 H3C 堡垒机"网页控制台集成"(mock H3C 控制台):
 *   ① 网页加载后注入捕获:mock 页面提供资产 API → window.__bastionAssets 捕获资产
 *   ② 轮询把捕获资产同步到 state.bastionAssets
 *   ③ bastionConnect:网页 fetch /shterm/api/deviceAccess/accessUrl → accessclient://
 *      → handleAccessClientUrl 解码 → 经网关连接成功
 * 运行: node verify-h3c-web.js(需 9382 空闲;mock H3C 网页 8150 / SSH 2246)
 */
const { spawn, execSync } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path'); const zlib = require('zlib'); const http = require('http');
const OUT = path.join(os.tmpdir(), 'verify-h3c-web-result.txt');
try { fs.writeFileSync(OUT, ''); } catch {}
const w = (s) => { try { fs.appendFileSync(OUT, s + '\n'); } catch {} };
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-h3cw-'));
const PORT = 9382, SSH = 2246, H3C_HTTP = 8150;

// 构造 accessclient token(指向 mock SSH 网关 127.0.0.1:SSH)
function makeToken(info) {
  const buf = zlib.deflateSync(Buffer.from(JSON.stringify(info), 'utf8'));
  return 'accessclient://' + buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const TOKEN = makeToken({ mode: 'proxy', hn: '127.0.0.1', pn: SSH, sa: 'admin', pw: 'admin123', sn: 'H3C-WEB设备', st: 'web-node', sh: '192.168.10.99', cp: 'UTF-8' });

// mock H3C 网页控制台:首页 + 资产 API + accessUrl 接口
const h3cAssets = [{ id: 'dev-1', name: 'H3C-WEB设备', ip: '192.168.10.99', services: { services: { ssh: { port: 22 } } }, accounts: { accounts: [{ name: 'root' }] } }];
const h3cServer = http.createServer((req, res) => {
  const url = req.url || '/';
  if (url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!DOCTYPE html><html><head><title>H3C 控制台(mock)</title></head><body>
      <div class="asset-list"><span class="node_name">生产一</span><span class="node_name">H3C-WEB设备</span></div>
      <script>
        // 页面会在加载后请求一次资产 API(触发注入捕获)
        fetch('/shterm/api/asset/getAccessViewDevs?page=0&size=20', { method: 'GET' }).catch(function(){});
      </script></body></html>`);
    return;
  }
  if (url.startsWith('/shterm/api/asset/getAccessViewTree')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ children: [{ id: 'tree-root', name: '根', path: ['根'], children: [{ id: 'dev-1', name: 'H3C-WEB设备', ip: '192.168.10.99' }] }] }));
    return;
  }
  if (url.startsWith('/shterm/api/asset/getAccessViewDevs')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ content: h3cAssets.map((a) => ({ id: a.id, dev: a })) }));
    return;
  }
  if (url.startsWith('/shterm/api/deviceAccess/accessUrl')) {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ url: TOKEN }));
    });
    return;
  }
  res.writeHead(404); res.end('not found');
});

function freePort(p){ try{ execSync(`lsof -ti tcp:${p} | xargs kill -9 2>/dev/null`);}catch{} }
function killTree(proc){ try{ if(proc&&proc.pid) process.kill(-proc.pid,'SIGKILL'); }catch{} }
freePort(PORT); freePort(SSH); freePort(H3C_HTTP);
h3cServer.listen(H3C_HTTP, '127.0.0.1');
const appProc = spawn('node_modules/.bin/electron', ['.','--dev',`--remote-debugging-port=${PORT}`,'--no-sandbox','--disable-gpu'], {
  env: { ...process.env, POLARIS_LOCK_DIR: DIR, MOCK_SSH_PORT: String(SSH), MOCK_HTTP_PORT: String(8146), ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  stdio: ['ignore','ignore','ignore'], detached: true,
});
setTimeout(() => killTree(appProc), 150000);
const sleep = ms => new Promise(r=>setTimeout(r,ms));
async function targets(){ for(let i=0;i<50;i++){ try{ const r=await fetch(`http://127.0.0.1:${PORT}/json`); const j=await r.json(); const p=j.find(t=>t.type==='page'&&/解锁|Polaris/.test(t.title||'')); if(p) return j; }catch{} await sleep(400);} throw new Error('no targets'); }
function connect(url){ return new Promise((res,rej)=>{ const ws=new WebSocket(url); let id=0; const pend=new Map(); ws.onopen=()=>res({ call(m,p={}){return new Promise(r=>{const mid=++id;pend.set(mid,r);ws.send(JSON.stringify({id:mid,method:m,params:p}));});}, close(){ws.close();} }); ws.onerror=e=>rej(e); ws.onmessage=e=>{const m=JSON.parse(e.data); if(m.id&&pend.has(m.id)){pend.get(m.id)(m.result);pend.delete(m.id);}}; }); }
async function ev(c,expr){ const r=await c.call('Runtime.evaluate',{expression:expr,awaitPromise:true,returnByValue:true}); if(r.exceptionDetails) throw new Error('JS异常: '+JSON.stringify(r.exceptionDetails).slice(0,600)+' @ '+expr.slice(0,120)); return r.result&&r.result.value; }
// ev 带超时:渲染层繁忙(连接瞬间)时不至于让整个测试挂死
async function evT(c, expr, ms) { return Promise.race([ev(c, expr), sleep(ms || 5000).then(() => 'EV-TIMEOUT')]); }
let passed=0, failed=0;
const ok=(n)=>{passed++;w('  ✓ '+n);};
const bad=(n,e)=>{failed++;w('  ✗ '+n+(e?' -> '+e:''));};
const check=(c,n,e)=>(c?ok(n):bad(n,e));
(async()=>{
  w('\n=== H3C 网页控制台集成验证 ===\n');
  try {
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

    // ① 打开堡垒机面板,把 webview 指向 mock H3C 控制台
    await ev(c, `(async()=>{ openBastionPanel(); return true; })()`);
    await sleep(400);
    await ev(c, `(async()=>{ loadBastion('http://127.0.0.1:${H3C_HTTP}'); return true; })()`);
    w('[step] 已把 webview 指向 mock H3C 控制台,等待加载+注入…');
    // 等注入存活(正则修复后脚本可正常解析执行)
    let alive = false;
    for(let i=0;i<30;i++){
      alive = await ev(c, `(async()=>{ const wv = els.bastionWebview; if(!wv||!wv.executeJavaScript) return false; const r = await wv.executeJavaScript('typeof window.__bastionFetchAll === "function"').catch(()=>false); return !!r; })()`).catch(()=>false);
      if (alive) break;
      await sleep(500);
    }
    check(alive, 'webview 注入脚本成功执行(钩子存活)');
    // 注入就绪后触发页面资产 API(full-fetch 也会走 tree → devs)
    await ev(c, `(async()=>{ const wv = els.bastionWebview; await wv.executeJavaScript('fetch("/shterm/api/asset/getAccessViewDevs?page=0&size=20").catch(function(){})'); return true; })()`);
    await sleep(2000);
    let assets = 0;
    for(let i=0;i<20;i++){
      assets = await ev(c, `(async()=>{ const wv = els.bastionWebview; if(!wv||!wv.executeJavaScript) return 0; const r = await wv.executeJavaScript('(window.__bastionAssets||[]).length').catch(()=>0); return r || 0; })()`).catch(()=>0);
      if (assets > 0) break;
      await sleep(400);
    }
    check(assets >= 1, 'webview 注入捕获到资产(window.__bastionAssets=' + assets + ' 个)');
    let stateAssets = 0;
    for(let i=0;i<15;i++){ stateAssets = await ev(c, `state.bastionAssets.length`).catch(()=>0); if (stateAssets > 0) break; await sleep(400); }
    check(stateAssets >= 1, '轮询把捕获资产同步到 state.bastionAssets(' + stateAssets + ' 个)');

    // ③ bastionConnect:网页 fetch accessUrl → accessclient:// → 连接
    w('[step] 调用 bastionConnect…');
    const bc = await evT(c, `(async()=>{
      const a = state.bastionAssets[0];
      bastionConnect(a, null, 'ssh', false);
      return 'called';
    })()`, 6000);
    w('[step] bastionConnect 返回: ' + bc);
    let connected=false;
    for(let i=0;i<30;i++){ connected=await evT(c,`[...state.tabs.values()].some(t=>t.status==='connected')`, 5000); if(connected===true) break; await sleep(500); }
    check(connected === true, 'bastionConnect → accessclient:// → 经网关 SSH 连接成功');
    const tabInfo = await evT(c, `(async()=>{ const t=[...state.tabs.values()].find(x=>x.session&&x.session.bastionKey); return t ? JSON.stringify({ name: t.session.name, host: t.session.host, port: t.session.port, displayHost: t.session.displayHost, bastionKey: t.session.bastionKey }) : 'none'; })()`, 6000);
    const ti = JSON.parse(tabInfo);
    check(ti.name === 'H3C-WEB设备' && ti.host === '127.0.0.1' && ti.port === SSH && ti.displayHost === '192.168.10.99' && ti.bastionKey === 'h3c-dev-1',
      '会话按 H3C 资产正确构造(名称/网关/目标/资产键): ' + tabInfo);

    w('\n结果: '+passed+' 通过, '+failed+' 失败');
  } catch (e) { w('\n测试异常: '+(e&&e.message)); w('结果: '+passed+' 通过, '+failed+' 失败'); }
  try { h3cServer.close(); } catch {}
  try { killTree(appProc); } catch {}
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch {}
  setTimeout(() => process.exit(failed ? 1 : 0), 300);
})();
