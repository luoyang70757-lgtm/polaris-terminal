'use strict';
/**
 * verify-bastion-inline.js — 验证堡垒机浏览器已整合进左侧会话面板:
 *  ① #bastion-slot.bastion-inline 存在,webview(partition=persist:bastion)存在
 *  ② 旧右侧面板元素(bastion-panel/server-select/url/tabs/zoom…)已全部删除
 *  ③ openBastionPanel / bastionRenderServerSelect / bastionRenderTabs / minimizeBastion
 *     / closeBastionPanel / updateBastionMini 调用不抛异常(无 null 元素崩溃)
 * 运行: node verify-bastion-inline.js(需 9359 空闲;--dev 用临时数据目录)
 */
const { spawn } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-binl-'));
const PORT = 9359;
const appProc = spawn('node_modules/.bin/electron', ['.', '--dev', `--remote-debugging-port=${PORT}`, '--no-sandbox', '--disable-gpu'], {
  env: { ...process.env, POLARIS_LOCK_DIR: DIR, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  stdio: ['ignore', 'ignore', 'ignore'], detached: true,
});
setTimeout(() => { try { process.kill(-appProc.pid, 'SIGKILL'); } catch {} process.exit(1); }, 100000).unref();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function listTargets() {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json`); return await r.json(); } catch {}
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
  if (r.exceptionDetails) throw new Error('JS异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 500) + ' @ ' + expr.slice(0, 80));
  return r.result && r.result.value;
}
let passed = 0, failed = 0;
const ok = (n) => { passed++; console.log('  ✓ ' + n); };
const bad = (n, e) => { failed++; console.error('  ✗ ' + n + (e ? ' -> ' + e : '')); };
async function check(c, name, expr, expect = true) {
  try { const v = await ev(c, expr); if (v === expect) ok(name); else bad(name, `got ${JSON.stringify(v)}`); } catch (e) { bad(name, e.message); }
}

(async () => {
  console.log('\n=== 堡垒机浏览器整合进左侧会话面板 ===\n');
  try {
    // 解锁(临时目录首次运行 → 设密码)
    const ts0 = await listTargets();
    const lockT = ts0.find((t) => /解锁/.test(t.title || '')) || ts0.find((t) => t.type === 'page');
    const lock = await connect(lockT.webSocketDebuggerUrl);
    for (let i = 0; i < 30; i++) { if (await ev(lock, `!!document.getElementById('pw')`)) break; await sleep(300); }
    await ev(lock, `document.getElementById('pw').value='x1234567'; document.getElementById('pw2').value='x1234567'; document.getElementById('btn').click();`);
    let c = null;
    for (let i = 0; i < 30; i++) { await sleep(400); const t2 = await listTargets(); const m = t2.find((t) => t.type === 'page' && !/解锁/.test(t.title || '')); if (m) { c = await connect(m.webSocketDebuggerUrl); break; } }
    if (!c) throw new Error('主窗口未就绪');

    // ① 内嵌容器与 webview 存在
    await check(c, '#bastion-slot 存在且带 .bastion-inline', `(function(){const e=document.getElementById('bastion-slot');return !!e && e.classList.contains('bastion-inline');})()`);
    await check(c, '#bastion-webview 存在且 partition=persist:bastion', `(function(){const e=document.getElementById('bastion-webview');return !!e && e.getAttribute('partition')==='persist:bastion';})()`);

    // ② 旧右侧面板元素已删除
    const dead = ['bastion-panel','bastion-server-select','bastion-url','bastion-go','bastion-min','bastion-tabs','bastion-tabs-list','bastion-tab-add','bastion-load','bastion-zoom-in','bastion-zoom-out','bastion-zoom-label','bastion-cfg','bastion-empty-cfg','divider-bastion'];
    const deadExpr = `(function(){var left=${JSON.stringify(dead)}.filter(function(id){return !!document.getElementById(id);});return left.length===0;})()`;
    await check(c, `旧右侧面板元素已删除`, deadExpr);

    // ③ 交互函数不抛异常(重点回归:bastionRenderServerSelect 曾因 sel 为 null 崩溃)
    const fns = ['openBastionPanel','bastionRenderServerSelect','bastionRenderTabs','updateBastionMini','minimizeBastion','closeBastionPanel'];
    for (const f of fns) {
      await check(c, `${f}() 不抛异常`, `(function(){try{ ${f}(); return true; }catch(e){ return 'THROW: '+e.message; }})()`);
    }

    // ④ openBastionPanel 后 slot 应显示(非 hidden)
    await check(c, 'openBastionPanel 后 slot 显示', `(function(){ openBastionPanel(); return !document.getElementById('bastion-slot').classList.contains('hidden'); })()`);
    await check(c, 'closeBastionPanel 后 slot 隐藏', `(function(){ closeBastionPanel(); return document.getElementById('bastion-slot').classList.contains('hidden'); })()`);

    console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  } catch (e) { console.error('\n测试异常:', e && e.message); failed++; console.log(`\n结果: ${passed} 通过, ${failed} 失败`); }
  try { process.kill(-appProc.pid, 'SIGKILL'); } catch {}
  process.exit(failed ? 1 : 0);
})();
