'use strict';
/**
 * verify-kb.js — 端到端验证用户知识库(参考 Chaterm):
 *   ① IPC:导入文档(kbImport)→ kbList 列出 → kbSearch 检索出命中片段
 *   ② UI:AI 配置区知识库区块显示文档;搜索框输入出命中预览
 *   ③ AI 集成:aiChat 带 kbEnabled → mock AI 收到含「知识库相关片段」的 system 提示
 * 运行: node verify-kb.js(需 9371 空闲;mock SSH 2236/HTTP 8136/AI 9372)
 */
const { spawn, execSync } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path'); const net = require('net');
const OUT = path.join(os.tmpdir(), 'verify-kb-result.txt');
try { fs.writeFileSync(OUT, ''); } catch {}
const w = (s) => { try { fs.appendFileSync(OUT, s + '\n'); } catch {} };
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-kb-'));
const PORT = 9371, SSH = 2236, HTTP = 8136, AI_PORT = 9372;
function freePort(p){ try{ execSync(`lsof -ti tcp:${p} | xargs kill -9 2>/dev/null`);}catch{} }
function killTree(proc){ try{ if(proc&&proc.pid) process.kill(-proc.pid,'SIGKILL'); }catch{} }
freePort(PORT); freePort(SSH); freePort(HTTP); freePort(AI_PORT);
// mock AI:记录请求体,返回纯文本
const http = require('http');
let lastReqBody = null;
const aiServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    lastReqBody = body;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: '好的,已参考知识库回答' } }] }) + '\n\n');
    res.end('data: [DONE]\n\n');
  });
});
aiServer.listen(AI_PORT, '127.0.0.1');
// 测试用文档
const DOC_PATH = path.join(os.tmpdir(), 'kb-test-nginx.md');
fs.writeFileSync(DOC_PATH, '# Nginx 排障手册\n\n## 502 Bad Gateway\n\n表示后端服务不可用,检查 upstream 与后端进程。\n\ntail -f /var/log/nginx/error.log\n\nnginx -t\n');
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
  w('\n=== 用户知识库端到端验证 ===\n');
  try {
    const ts = await targets();
    const lock = await connect(ts.find(t=>/解锁/.test(t.title||'')).webSocketDebuggerUrl);
    for(let i=0;i<30;i++){ if(await ev(lock,`!!document.getElementById('pw')`)) break; await sleep(300); }
    await sleep(300);
    await ev(lock, `document.getElementById('pw').value='x12345678'; document.getElementById('pw2').value='x12345678'; document.getElementById('btn').click();`);
    let c=null;
    for(let i=0;i<30;i++){ await sleep(500); const t2=await targets(); const m=t2.find(t=>t.type==='page'&&!/解锁/.test(t.title||'')); if(m){ c=await connect(m.webSocketDebuggerUrl); break; } }
    check(!!c, '解锁后主窗口出现');
    for(let i=0;i<40;i++){ if(await ev(c,`!!window.api.kbImport && !!document.getElementById('kb-list')`)) break; await sleep(300); }
    check(await ev(c,`!!window.api.kbImport`), 'kb API 就绪');

    // ① IPC:导入 → 列表 → 检索
    const imp = await ev(c, `(async()=>JSON.stringify(await window.api.kbImport('${DOC_PATH}')))()`);
    check(imp.includes('"ok":true') && imp.includes('kb-test-nginx.md'), 'kbImport 导入文档成功(实际: ' + imp.slice(0,100) + ')');
    const list = await ev(c, `(async()=>JSON.stringify(await window.api.kbList()))()`);
    check(list.includes('kb-test-nginx.md'), 'kbList 列出文档');
    const s1 = await ev(c, `(async()=>JSON.stringify(await window.api.kbSearch('nginx 502', 5)))()`);
    check(s1.includes('kb-test-nginx.md') && s1.includes('后端服务不可用'), 'kbSearch 检索命中片段(实际: ' + s1.slice(0,120) + ')');
    const s2 = await ev(c, `(async()=>JSON.stringify(await window.api.kbSearch('完全不存在的词xyz', 5)))()`);
    check(s2.includes('"results":[]'), '无关词无命中');

    // ② UI:AI 配置区知识库区块
    await ev(c, `document.getElementById('btn-ai').click()`);
    await sleep(300);
    await ev(c, `document.getElementById('ai-config-toggle').click()`);
    await sleep(400);
    const kbSection = await ev(c, `!!document.getElementById('kb-list') && !!document.getElementById('kb-import') && !!document.getElementById('kb-ai-toggle')`);
    check(kbSection, 'AI 配置区含知识库区块(列表/导入/开关)');
    const kbListText = await ev(c, `document.getElementById('kb-list').textContent`);
    check(kbListText.includes('kb-test-nginx.md'), '知识库列表显示导入的文档');
    // 搜索框输入 → 命中预览
    await ev(c, `(async()=>{ const i = document.getElementById('kb-search'); i.value='502'; i.dispatchEvent(new Event('input')); return true; })()`);
    await sleep(600);
    const kbRes = await ev(c, `document.getElementById('kb-results').textContent`);
    check(kbRes.includes('kb-test-nginx.md') && kbRes.includes('后端服务不可用'), '搜索框输入出命中片段预览(实际: ' + kbRes.slice(0,100) + ')');

    // ③ AI 集成:aiChat 带 kbEnabled → mock AI 收到含知识库片段的 system 提示
    lastReqBody = null;
    const r = await ev(c, `(async()=>{
      const av = activeAiVendor() || { url:'', key:'', format:'openai', model:'mock' };
      const res = await window.api.aiChat({
        apiKey: 'sk-test', url: 'http://127.0.0.1:${AI_PORT}', model: 'mock-model', format: 'openai',
        messages: [{ role: 'user', content: 'nginx 502 怎么排查' }], hosts: [], requestId: 'kb-e2e-1', kbEnabled: true,
      });
      return JSON.stringify(res);
    })()`);
    check(r.includes('"ok":true'), 'aiChat 调用成功(带 kbEnabled)');
    let sysPrompt = '';
    try { sysPrompt = JSON.parse(lastReqBody || '{}').messages && JSON.parse(lastReqBody).messages[0].content || ''; } catch { /* ignore */ }
    check(sysPrompt.includes('知识库相关片段') && sysPrompt.includes('kb-test-nginx.md'), 'AI system 提示注入了知识库相关片段');
    // 关闭知识库 → 不再注入
    lastReqBody = null;
    await ev(c, `(async()=>{ await window.api.aiChat({ apiKey:'sk-test', url:'http://127.0.0.1:${AI_PORT}', model:'mock-model', format:'openai', messages:[{role:'user',content:'nginx'}], hosts:[], requestId:'kb-e2e-2', kbEnabled:false }); return true; })()`);
    await sleep(500);
    let sysPrompt2 = '';
    try { sysPrompt2 = JSON.parse(lastReqBody || '{}').messages && JSON.parse(lastReqBody).messages[0].content || ''; } catch { /* ignore */ }
    check(!sysPrompt2.includes('知识库相关片段'), 'kbEnabled=false 时不注入知识库');

    w('\n结果: '+passed+' 通过, '+failed+' 失败');
  } catch (e) { w('\n测试异常: '+(e&&e.message)); w('结果: '+passed+' 通过, '+failed+' 失败'); }
  try { aiServer.close(); } catch {}
  try { fs.rmSync(DOC_PATH, { force: true }); } catch {}
  try { killTree(appProc); } catch {}
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch {}
  setTimeout(() => process.exit(failed ? 1 : 0), 300);
})();
