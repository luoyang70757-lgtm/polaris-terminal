'use strict';
/**
 * verify-h3c.js — 验证 H3C 堡垒机功能链路:
 *   ① token 编解码:构造 accessclient://(zlib 压缩 JSON) → bastion:decode 还原字段
 *   ② 安全防护:压缩炸弹(膨胀超 1MB)/超大输入/坏 base64 一律拒绝
 *   ③ 连接流程:handleAccessClientUrl → 经网关(hn:pn)代理连接成功
 *   ④ 连通性探测:bastion:probe 识别 SSH banner
 * 运行: node verify-h3c.js(需 9381 空闲;mock 2245/8145)
 */
const { spawn, execSync } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path'); const zlib = require('zlib');
const OUT = path.join(os.tmpdir(), 'verify-h3c-result.txt');
try { fs.writeFileSync(OUT, ''); } catch {}
const w = (s) => { try { fs.appendFileSync(OUT, s + '\n'); } catch {} };
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-h3c-'));
const PORT = 9381, SSH = 2245, HTTP = 8145;
// 构造合法 accessclient:// token(zlib 压缩 JSON → base64url)
function makeToken(info) {
  const buf = zlib.deflateSync(Buffer.from(JSON.stringify(info), 'utf8'));
  return 'accessclient://' + buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const INFO = { mode: 'proxy', hn: '127.0.0.1', pn: SSH, sa: 'admin', pw: 'admin123', sn: 'H3C测试设备', st: 'web-01', sh: '192.168.10.10', cp: 'UTF-8' };
const TOKEN = makeToken(INFO);
// 压缩炸弹:1000 个 'A' 压缩后很小,解压会很大?不——压缩比高的是重复内容。构造 1MB+ 的重复串
const BOMB_INFO = { hn: 'x', pn: 22, sa: 'a', pw: 'b', sn: 'A'.repeat(1024 * 1024 + 100), st: 'B'.repeat(1024 * 1024 + 100) };
const BOMB_TOKEN = makeToken(BOMB_INFO);
function freePort(p){ try{ execSync(`lsof -ti tcp:${p} | xargs kill -9 2>/dev/null`);}catch{} }
function killTree(proc){ try{ if(proc&&proc.pid) process.kill(-proc.pid,'SIGKILL'); }catch{} }
freePort(PORT); freePort(SSH); freePort(HTTP);
const appProc = spawn('node_modules/.bin/electron', ['.','--dev',`--remote-debugging-port=${PORT}`,'--no-sandbox','--disable-gpu'], {
  env: { ...process.env, POLARIS_LOCK_DIR: DIR, MOCK_SSH_PORT: String(SSH), MOCK_HTTP_PORT: String(HTTP), ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  stdio: ['ignore','ignore','ignore'], detached: true,
});
setTimeout(() => killTree(appProc), 120000);
const sleep = ms => new Promise(r=>setTimeout(r,ms));
async function targets(){ for(let i=0;i<50;i++){ try{ const r=await fetch(`http://127.0.0.1:${PORT}/json`); const j=await r.json(); const p=j.find(t=>t.type==='page'&&/解锁|Polaris/.test(t.title||'')); if(p) return j; }catch{} await sleep(400);} throw new Error('no targets'); }
function connect(url){ return new Promise((res,rej)=>{ const ws=new WebSocket(url); let id=0; const pend=new Map(); ws.onopen=()=>res({ call(m,p={}){return new Promise(r=>{const mid=++id;pend.set(mid,r);ws.send(JSON.stringify({id:mid,method:m,params:p}));});}, close(){ws.close();} }); ws.onerror=e=>rej(e); ws.onmessage=e=>{const m=JSON.parse(e.data); if(m.id&&pend.has(m.id)){pend.get(m.id)(m.result);pend.delete(m.id);}}; }); }
async function ev(c,expr){ const r=await c.call('Runtime.evaluate',{expression:expr,awaitPromise:true,returnByValue:true}); if(r.exceptionDetails) throw new Error('JS异常: '+JSON.stringify(r.exceptionDetails).slice(0,600)+' @ '+expr.slice(0,120)); return r.result&&r.result.value; }
let passed=0, failed=0;
const ok=(n)=>{passed++;w('  ✓ '+n);};
const bad=(n,e)=>{failed++;w('  ✗ '+n+(e?' -> '+e:''));};
const check=(c,n,e)=>(c?ok(n):bad(n,e));
(async()=>{
  w('\n=== H3C 堡垒机功能验证 ===\n');
  try {
    const ts = await targets();
    const lock = await connect(ts.find(t=>/解锁/.test(t.title||'')).webSocketDebuggerUrl);
    for(let i=0;i<30;i++){ if(await ev(lock,`!!document.getElementById('pw')`)) break; await sleep(300); }
    await sleep(300);
    await ev(lock, `document.getElementById('pw').value='x12345678'; document.getElementById('pw2').value='x12345678'; document.getElementById('btn').click();`);
    let c=null;
    for(let i=0;i<30;i++){ await sleep(500); const t2=await targets(); const m=t2.find(t=>t.type==='page'&&!/解锁/.test(t.title||'')); if(m){ c=await connect(m.webSocketDebuggerUrl); break; } }
    check(!!c, '解锁后主窗口出现');
    for(let i=0;i<40;i++){ if(await ev(c,`!!window.api.bastionDecode && !!window.api.bastionProbe`)) break; await sleep(300); }

    // ① token 解码
    const dec = await ev(c, `(async()=>JSON.stringify(await window.api.bastionDecode('${TOKEN}')))()`);
    const decJ = JSON.parse(dec);
    check(decJ.ok && decJ.info.hn === '127.0.0.1' && decJ.info.pn === SSH && decJ.info.sa === 'admin' && decJ.info.sn === 'H3C测试设备',
      'accessclient:// token 解码还原全部字段(hn/pn/sa/sn…)');

    // ② 安全防护
    const bomb = await ev(c, `(async()=>JSON.stringify(await window.api.bastionDecode('${BOMB_TOKEN}')))()`);
    check(bomb.includes('"ok":false') && /超限|过大|解压/.test(bomb), '压缩炸弹 token 被拒绝(实际: ' + bomb.slice(0,80) + ')');
    const badB64 = await ev(c, `(async()=>JSON.stringify(await window.api.bastionDecode('accessclient://!!!not-base64!!!')))()`);
    check(badB64.includes('"ok":false'), '非法 base64 被拒绝');
    const big = await ev(c, `(async()=>JSON.stringify(await window.api.bastionDecode('accessclient://' + 'A'.repeat(100000))))()`);
    check(big.includes('"ok":false'), '超大输入(100KB+)被拒绝');

    // ③ 连通性探测(mock SSH 网关)
    const probe = await ev(c, `(async()=>JSON.stringify(await window.api.bastionProbe({ host:'127.0.0.1', port:${SSH}, timeoutMs:5000 })))()`);
    const probeJ = JSON.parse(probe);
    check(probeJ.tcp === 'ok' && probeJ.banner && /SSH|ssh/i.test(probeJ.banner || ''), 'bastion:probe 识别 SSH banner(实际: ' + JSON.stringify(probeJ).slice(0,100) + ')');

    // ④ 完整连接流程:handleAccessClientUrl(token) → 经网关连接
    await ev(c, `state.settings.verifyHostKey = false; state.settings.autoTrustHostKey = true; saveSettings();`);
    const connRes = await ev(c, `(async()=>{
      handleAccessClientUrl('${TOKEN}', false, 'dev-h3c-1');
      return true;
    })()`);
    await sleep(800);
    let connected=false;
    for(let i=0;i<30;i++){ connected=await ev(c,`[...state.tabs.values()].some(t=>t.status==='connected')`); if(connected) break; await sleep(400); }
    check(connected, 'accessclient:// 触发经网关 SSH 连接成功');
    const tabInfo = await ev(c, `(async()=>{ const t=[...state.tabs.values()][0]; return t ? JSON.stringify({ name: t.session.name, host: t.session.host, port: t.session.port, user: t.session.username, displayHost: t.session.displayHost, bastionKey: t.session.bastionKey }) : 'none'; })()`);
    const ti = JSON.parse(tabInfo);
    check(ti.name === 'H3C测试设备' && ti.host === '127.0.0.1' && ti.port === SSH && ti.displayHost === '192.168.10.10' && ti.bastionKey === 'h3c-dev-h3c-1',
      '会话按 H3C token 构造正确(名称/网关/目标/资产标识): ' + tabInfo);

    w('\n结果: '+passed+' 通过, '+failed+' 失败');
  } catch (e) { w('\n测试异常: '+(e&&e.message)); w('结果: '+passed+' 通过, '+failed+' 失败'); }
  try { killTree(appProc); } catch {}
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch {}
  setTimeout(() => process.exit(failed ? 1 : 0), 300);
})();
