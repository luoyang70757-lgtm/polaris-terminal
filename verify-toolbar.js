'use strict';
/**
 * verify-toolbar.js — 回归:工具栏改动
 *   ① 输出过滤框存在且在锁定按钮前
 *   ② 输入关键词 → outputFilterKw 更新
 *   ③ filterWrite:不匹配行变暗、未完成尾行不延迟
 *   ④ 百分比(80%/100%)+ 关键词都高亮
 *   ⑤ 设置按钮可开可关(toggle)
 * 运行: node verify-toolbar.js(--dev 临时数据目录)
 */
const { spawn } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-ui-'));
const PORT = 9379;
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
    for(let i=0;i<60;i++){ if(await ev(c,`(typeof state !== 'undefined' && typeof filterWrite === 'function')`)){ ready=true; break; } await sleep(300); }
    if(!ready) throw new Error('renderer 未就绪');

    const filterPos = await ev(c, `(function(){ const f=document.getElementById('output-filter'); const l=document.getElementById('btn-lock'); if(!f||!l) return 'NOEL'; return f.compareDocumentPosition(l) & Node.DOCUMENT_POSITION_FOLLOWING ? 'before' : 'after'; })()`);
    if (filterPos === 'before') ok('① 过滤框存在且在锁定按钮前'); else bad('① 过滤框位置', filterPos);

    await ev(c, `(function(){ const f=document.getElementById('output-filter'); f.value='error'; f.dispatchEvent(new Event('input')); return true; })()`);
    const kw = await ev(c, `typeof outputFilterKw !== 'undefined' ? outputFilterKw : 'UNDEF'`);
    if (kw === 'error') ok('② 输入即更新过滤关键词', kw); else bad('② 过滤关键词', kw);

    const fw = await ev(c, `filterWrite(String.fromCharCode(108,105,110,101,49,10,108,105,110,101,50))`);
    if (fw === '\x1b[2mline1\x1b[0m\nline2') ok('③ 过滤生效:不匹配行变暗,尾行不延迟'); else bad('③ filterWrite', JSON.stringify(fw));

    const hl = await ev(c, `state.settings.highlightKeywords=['error']; highlightString('CPU 80% error')`);
    if (typeof hl === 'string' && hl.indexOf('\x1b[31m80%\x1b[0m') >= 0 && hl.indexOf('\x1b[31merror\x1b[0m') >= 0) ok('④ 百分比+关键词都高亮'); else bad('④ 百分比', JSON.stringify(hl));

    await ev(c, `(function(){ els.settingsModal.classList.add('hidden'); return true; })()`);
    await ev(c, `document.getElementById('btn-settings').click()`);
    const opened = await ev(c, `!els.settingsModal.classList.contains('hidden')`);
    await ev(c, `document.getElementById('btn-settings').click()`);
    const closed = await ev(c, `els.settingsModal.classList.contains('hidden')`);
    if (opened === true && closed === true) ok('⑤ 设置按钮可开可关(toggle)'); else bad('⑤ 设置切换', opened+'/'+closed);

    console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  }catch(e){ console.error('异常:', e.message); process.exitCode=1; }
  try { process.kill(-appProc.pid, 'SIGKILL'); } catch {}
  process.exit(fail?1:0);
})();
