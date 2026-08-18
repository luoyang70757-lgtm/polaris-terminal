'use strict';
/**
 * verify-highlight-kw.js — 回归:自定义关键字高亮
 *   ① 设置面板关键词输入框存在
 *   ② 逗号/中文逗号分隔 + 去空去重 → settings.highlightKeywords
 *   ③ 持久化到 localStorage
 *   ④ 高亮生效(ASCII 词边界 + 中文子串)
 *   ⑤ outerror 不误高亮(error 词边界)
 * 运行: node verify-highlight-kw.js(--dev 临时数据目录)
 */
const { spawn } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-kw2-'));
const PORT = 9378;
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
    // 等 renderer 完全加载
    let ready=false;
    for(let i=0;i<60;i++){ if(await ev(c,`(typeof state !== 'undefined' && typeof highlightString === 'function')`)){ ready=true; break; } await sleep(300); }
    if(!ready) throw new Error('renderer 未就绪 state='+await ev(c,`typeof state`));

    // 元素存在性(设置弹窗静态在 DOM)
    const kwExists = await ev(c, `!!document.getElementById('set-highlight-kw')`);
    if (kwExists === true) ok('① 关键词输入框存在'); else bad('① 输入框', kwExists);

    // 通过 UI 设置关键词
    await ev(c, `(function(){ const el=document.getElementById('set-highlight-kw'); if(!el) return 'NOEL'; el.value=' error , 失败,,warning '; el.dispatchEvent(new Event('change')); return 'OK'; })()`);
    const kws = await ev(c, `JSON.stringify(state.settings.highlightKeywords)`);
    if (kws === '["error","失败","warning"]') ok('② 逗号分隔+去空去重', kws); else bad('② 解析', kws);

    // 持久化
    const saved = await ev(c, `(localStorage.getItem('jms-settings')||'').includes('失败')`);
    if (saved === true) ok('③ 已持久化'); else bad('③ 持久化', saved);

    // 高亮生效(ASCII 词边界 + 中文子串)
    const hl = await ev(c, `highlightString('命令失败 outerror error')`);
    if (typeof hl === 'string' && hl.indexOf('[31m') >= 0) {
      const red = (hl.match(/\[31m([^]*)\[0m/g)||[]).map(s=>s.replace(/\[31m|\[0m/g,''));
      ok('④ 高亮生效(命中: '+red.join(',')+')');
    } else bad('④ 高亮', JSON.stringify(hl));
    // 验证 outerror 里的 error 没被高亮
    const hl2 = await ev(c, `highlightString('outerror')`);
    if (typeof hl2 === 'string' && hl2.indexOf('[31m') < 0) ok('⑤ 词边界: outerror 不误高亮'); else bad('⑤ 词边界', JSON.stringify(hl2));

    console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  }catch(e){ console.error('异常:', e.message); process.exitCode=1; }
  try { process.kill(-appProc.pid, 'SIGKILL'); } catch {}
  process.exit(fail?1:0);
})();
