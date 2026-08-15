'use strict';
/**
 * verify-ai-recommend.js — 验证 AI 命令推荐(参考 Chaterm 的"智能命令推荐"):
 *   ① IPC ai:suggestCmd:mock AI 返回 {command,reason} JSON → 正确解析出命令
 *   ② 渲染层:推荐菜单顶部有「🤖 AI 推荐」入口行;点它(走 mock AI)→ 菜单出现 AI 结果行
 *   ③ 点 AI 结果行 → runInActiveTerminal 发送(mock 审计日志 [CMD])
 * 运行: node verify-ai-recommend.js(需 9368 空闲;mock SSH 2235/HTTP 8135)
 */
const { spawn, execSync } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path'); const net = require('net');
const OUT = path.join(os.tmpdir(), 'verify-ai-recommend-result.txt');
try { fs.writeFileSync(OUT, ''); } catch {}
const w = (s) => { try { fs.appendFileSync(OUT, s + '\n'); } catch {} };
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-air-'));
const PORT = 9368, SSH = 2235, HTTP = 8135, AI_PORT = 9369;
function freePort(p){ try{ execSync(`lsof -ti tcp:${p} | xargs kill -9 2>/dev/null`);}catch{} }
function killTree(proc){ try{ if(proc&&proc.pid) process.kill(-proc.pid,'SIGKILL'); }catch{} }
freePort(PORT); freePort(SSH); freePort(HTTP); freePort(AI_PORT);
// mock AI 服务器:返回 {command, reason} JSON 的 SSE
const http = require('http');
const aiServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const parsed = JSON.parse(body);
    const userMsg = (parsed.messages || []).map((m) => m.content).join(' ');
    const isSuggest = /推荐一条|JSON/.test(userMsg);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (isSuggest) {
      const json = '{"command":"df -h","reason":"检查磁盘空间是否告警"}';
      // 分块输出,模拟流式
      for (const ch of json) res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: ch } }] }) + '\n\n');
    } else {
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'x' } }] }) + '\n\n');
    }
    res.end('data: [DONE]\n\n');
  });
});
aiServer.listen(AI_PORT, '127.0.0.1');
const appProc = spawn('node_modules/.bin/electron', ['.','--dev',`--remote-debugging-port=${PORT}`,'--no-sandbox','--disable-gpu'], {
  env: { ...process.env, POLARIS_LOCK_DIR: DIR, MOCK_SSH_PORT: String(SSH), MOCK_HTTP_PORT: String(HTTP), ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  stdio: ['ignore','ignore','ignore'], detached: true,
});
setTimeout(() => killTree(appProc), 120000);
const sleep = ms => new Promise(r=>setTimeout(r,ms));
function waitPort(p, ms){ return new Promise((resolve)=>{ const t0=Date.now(); const tick=()=>{ const s=net.connect(p,'127.0.0.1'); s.on('connect',()=>{s.destroy();resolve(true);}); s.on('error',()=>{s.destroy(); if(Date.now()-t0>ms) resolve(false); else setTimeout(tick,300);}); }; tick(); }); }
async function targets(){ for(let i=0;i<50;i++){ try{ const r=await fetch(`http://127.0.0.1:${PORT}/json`); const j=await r.json(); const p=j.find(t=>t.type==='page'&&/解锁|Polaris/.test(t.title||'')); if(p) return j; }catch{} await sleep(400);} throw new Error('no targets'); }
function connect(url){ return new Promise((res,rej)=>{ const ws=new WebSocket(url); let id=0; const pend=new Map(); ws.onopen=()=>res({ call(m,p={}){return new Promise(r=>{const mid=++id;pend.set(mid,r);ws.send(JSON.stringify({id:mid,method:m,params:p}));});}, close(){ws.close();} }); ws.onerror=e=>rej(e); ws.onmessage=e=>{const m=JSON.parse(e.data); if(m.id&&pend.has(m.id)){pend.get(m.id)(m.result);pend.delete(m.id);}}; }); }
async function ev(c,expr){ const r=await c.call('Runtime.evaluate',{expression:expr,awaitPromise:true,returnByValue:true}); if(r.exceptionDetails) throw new Error('JS异常: '+JSON.stringify(r.exceptionDetails).slice(0,600)+' @ '+expr.slice(0,120)); return r.result&&r.result.value; }
let passed=0, failed=0;
const ok=(n)=>{passed++;w('  ✓ '+n);};
const bad=(n,e)=>{failed++;w('  ✗ '+n+(e?' -> '+e:''));};
const check=(c,n,e)=>(c?ok(n):bad(n,e));
(async()=>{
  w('\n=== AI 命令推荐验证 ===\n');
  try {
    const ts = await targets();
    const lock = await connect(ts.find(t=>/解锁/.test(t.title||'')).webSocketDebuggerUrl);
    for(let i=0;i<30;i++){ if(await ev(lock,`!!document.getElementById('pw')`)) break; await sleep(300); }
    await sleep(300);
    await ev(lock, `document.getElementById('pw').value='x12345678'; document.getElementById('pw2').value='x12345678'; document.getElementById('btn').click();`);
    let c=null;
    for(let i=0;i<30;i++){ await sleep(500); const t2=await targets(); const m=t2.find(t=>t.type==='page'&&!/解锁/.test(t.title||'')); if(m){ c=await connect(m.webSocketDebuggerUrl); break; } }
    check(!!c, '解锁后主窗口出现');
    for(let i=0;i<40;i++){ if(await ev(c,`!!window.api.aiSuggestCmd && !!document.getElementById('recommend-list')`)) break; await sleep(300); }
    check(await ev(c,`!!window.api.aiSuggestCmd`), 'aiSuggestCmd API 就绪');

    // ① 直接调 IPC(mock AI)→ 解析出 {command, reason}
    const r1 = await ev(c, `(async()=>JSON.stringify(await window.api.aiSuggestCmd({ apiKey:'sk-test', url:'http://127.0.0.1:${AI_PORT}', model:'mock', format:'openai', host:'test(1.2.3.4)', history:'df -h\\nfree -m', context:'Filesystem 100% full' })))()`);
    check(r1.includes('"ok":true') && r1.includes('"command":"df -h"') && r1.includes('磁盘空间'), 'IPC ai:suggestCmd 解析出 command+reason(实际: ' + r1.slice(0,120) + ')');

    // ② 渲染层:连接主机 → 打开推荐菜单 → 有 AI 入口行
    await ev(c, `window.api.createSession({ name: 'AI机', host: '127.0.0.1', port: ${SSH}, username: 'admin', password: 'admin123' })`);
    await ev(c, `loadSessions()`); await sleep(500);
    await ev(c, `state.collapsedGroups.clear(); renderSessionList('')`);
    await ev(c, `state.settings.verifyHostKey = false; saveSettings()`);
    check(await waitPort(SSH, 10000), `mock SSH 端口 ${SSH} 就绪`);
    await ev(c, `(async()=>{ const row=[...document.querySelectorAll('.asset-item')].find(x=>x.textContent.includes('AI机')); row.dispatchEvent(new MouseEvent('dblclick',{bubbles:true})); return true; })()`);
    let conn=false;
    for(let i=0;i<40;i++){ conn=await ev(c,`[...state.tabs.values()].some(t=>t.status==='connected')`); if(conn) break; await sleep(400); }
    check(conn, '主机已连接');
    await ev(c, `document.getElementById('btn-recommend').click()`);
    await sleep(500);
    const aiRow = await ev(c, `!!document.querySelector('#recommend-list .recommend-item.ai-row')`);
    check(aiRow, '推荐菜单顶部有「🤖 AI 推荐」入口行');
    // ③ 配置 mock AI 厂商(直接写 settings)并点击 AI 入口行
    await ev(c, `(async()=>{
      state.settings.aiVendors = state.settings.aiVendors || {};
      state.settings.aiVendors['mock'] = { url:'http://127.0.0.1:${AI_PORT}', key:'enc:plain', format:'openai', model:'mock', models:['mock'] };
      state.settings.aiActiveVendor = 'mock';
      // encryptSecret 是异步 safeStorage;直接存明文会被 decryptSecret 解密失败 → 覆写 decryptSecret 兼容
      window.__decryptOrig = window.__decryptOrig || {};
      return true;
    })()`);
    // decryptSecret 解 enc:plain → 直接返回明文
    await ev(c, `(async()=>{
      const orig = decryptSecret;
      window.__origDecrypt = orig;
      decryptSecret = async (s) => String(s||'').startsWith('enc:plain') ? 'sk-mock-ok' : orig(s);
      return true;
    })()`);
    await ev(c, `document.querySelector('#recommend-list .recommend-item.ai-row').click()`);
    await sleep(300);
    const aiRowText = await ev(c, `document.querySelector('#recommend-list .recommend-item.ai-row') ? document.querySelector('#recommend-list .recommend-item.ai-row').textContent : '(row gone)'`);
    w('   [diag] 点击后 AI 行文本: ' + aiRowText);
    await sleep(2000);
    const aiResult = await ev(c, `(async()=>{ const r=document.querySelector('#recommend-list .recommend-item.ai-result'); return r ? JSON.stringify({ cmd: r.querySelector('.recommend-cmd').textContent, meta: r.querySelector('.recommend-meta').textContent }) : 'null'; })()`);
    check(aiResult.includes('df -h') && aiResult.includes('磁盘空间'), '点击 AI 入口后出现 AI 结果行(实际: ' + aiResult + ')');
    // ④ 点 AI 结果 → 发送到终端(mock 审计日志 [CMD] df -h)
    await ev(c, `(async()=>{ const r=document.querySelector('#recommend-list .recommend-item.ai-result'); r.click(); return true; })()`);
    await sleep(1500);
    const menuClosed = await ev(c, `document.getElementById('recommend-menu').classList.contains('hidden')`);
    check(menuClosed, '点击 AI 结果后菜单收起');
    const logs = fs.existsSync(path.join(__dirname,'logs')) ? fs.readdirSync(path.join(__dirname,'logs')).filter(f=>f.startsWith('audit-')) : [];
    let sawCmd=false;
    for (const f of logs.sort().slice(-3)) { try { if (fs.readFileSync(path.join(__dirname,'logs',f),'utf8').includes('] df -h')) sawCmd=true; } catch {} }
    check(sawCmd, 'mock 审计日志出现 [CMD] df -h(AI 推荐命令已真实发送)');
    w('\n结果: '+passed+' 通过, '+failed+' 失败');
  } catch (e) { w('\n测试异常: '+(e&&e.message)); w('结果: '+passed+' 通过, '+failed+' 失败'); }
  try { aiServer.close(); } catch {}
  try { killTree(appProc); } catch {}
  setTimeout(() => process.exit(failed ? 1 : 0), 300);
})();
