'use strict';
/**
 * verify-highlight-kw.js — 回归:终端关键字高亮(highlightString)
 *   ① 默认关键词高亮(error)
 *   ② 中文关键词子串匹配("失败"在"命令失败"里也命中,JS \b 不认 CJK)
 *   ③ 词边界:outerror 不误高亮
 *   ④ 百分比恒高亮(80%)
 * 运行: node verify-highlight-kw.js(--dev 临时数据目录)
 */
const { spawn } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-hl-'));
const PORT = 9380;
const appProc = spawn('node_modules/.bin/electron', ['.', '--dev', `--remote-debugging-port=${PORT}`, '--no-sandbox', '--disable-gpu'], { env: { ...process.env, POLARIS_LOCK_DIR: DIR, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' }, stdio: ['ignore','ignore','ignore'], detached: true });
setTimeout(() => { try { process.kill(-appProc.pid, 'SIGKILL'); } catch {} process.exit(1); }, 100000).unref();
const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
async function targets(){ for(let i=0;i<40;i++){ try{ const j=await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); if(j.length) return j; }catch{} await sleep(400);} return []; }
function connect(url){ return new Promise((res,rej)=>{ const ws=new WebSocket(url); let id=0; const p=new Map();
  ws.onopen=()=>res({call(m,q={}){return new Promise(r=>{const mid=++id;p.set(mid,r);ws.send(JSON.stringify({id:mid,method:m,params:q}));});},close(){ws.close();}});
  ws.onerror=e=>rej(e); ws.onmessage=e=>{const m=JSON.parse(e.data); if(m.id&&p.has(m.id)){p.get(m.id)(m.result);p.delete(m.id);}}; }); }
async function ev(c,x){ try { const r=await c.call('Runtime.evaluate',{expression:x,awaitPromise:true,returnByValue:true}); if(r&&r.exceptionDetails) return 'EX:'+JSON.stringify(r.exceptionDetails).slice(0,200); return r&&r.result&&r.result.value; } catch(e){ return 'ERR:'+e.message; } }
let pass=0,fail=0; const ok=(n,d)=>{pass++;console.log('  ✓ '+n+(d?'  → '+d:''));}; const bad=(n,e)=>{fail++;console.error('  ✗ '+n+(e?'  → '+e:''));};
(async()=>{
  try{
    const ts=await targets();
    const lockT=ts.find(t=>/解锁/.test(t.title||''))||ts[0];
    const lock=await connect(lockT.webSocketDebuggerUrl);
    for(let i=0;i<40;i++){ if(await ev(lock,`!!document.getElementById('pw')`))break; await sleep(300); }
    await ev(lock,`document.getElementById('pw').value='x1234567'; document.getElementById('pw2').value='x1234567'; document.getElementById('btn').click();`);
    let c=null;
    for(let i=0;i<50;i++){ await sleep(400); const t2=await targets(); const m=t2.find(t=>t.type==='page'&&!/解锁/.test(t.title||'')); if(m){ c=await connect(m.webSocketDebuggerUrl); break; } }
    if(!c) throw new Error('主窗口未就绪');
    let ready=false;
    for(let i=0;i<60;i++){ if(await ev(c,`(typeof state !== 'undefined' && typeof highlightString === 'function')`)){ ready=true; break; } await sleep(300); }
    if(!ready) throw new Error('renderer 未就绪');

    await ev(c, `state.settings.highlightKeywords=['error','失败']`);
    const hl1 = await ev(c, `highlightString('error occurred')`);
    if (typeof hl1 === 'string' && hl1.indexOf('\x1b[31merror\x1b[0m') >= 0) ok('① 默认关键词 error 高亮'); else bad('①', JSON.stringify(hl1));
    const hl2 = await ev(c, `highlightString('命令失败！')`);
    if (typeof hl2 === 'string' && hl2.indexOf('\x1b[31m失败\x1b[0m') >= 0) ok('② 中文关键词子串匹配'); else bad('②', JSON.stringify(hl2));
    const hl3 = await ev(c, `highlightString('outerror')`);
    if (typeof hl3 === 'string' && hl3.indexOf('\x1b[31m') < 0) ok('③ outerror 不误高亮(词边界)'); else bad('③', JSON.stringify(hl3));
    const hl4 = await ev(c, `highlightString('CPU 80%')`);
    if (typeof hl4 === 'string' && hl4.indexOf('\x1b[31m80%\x1b[0m') >= 0) ok('④ 百分比恒高亮'); else bad('④', JSON.stringify(hl4));

    console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  }catch(e){ console.error('异常:', e.message); process.exitCode=1; }
  try { process.kill(-appProc.pid, 'SIGKILL'); } catch {}
  process.exit(fail?1:0);
})();
