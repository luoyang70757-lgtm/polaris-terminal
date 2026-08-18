'use strict';
/** verify-bastion-group.js — 回归:堡垒机资产按「全部所属目录」分组(设备可在多个目录重复显示,与网页一致)
 * 覆盖:①渲染分组:dirs=[A,B] 的设备同时出现在 A、B 两组,组计数=该目录全部设备数
 *       ②注入钩子的 dirs 累积逻辑:同一设备被多个目录匹配时全部记录
 * 运行: node verify-bastion-group.js(--dev 临时数据目录)
 */
const { spawn } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-grp-'));
const PORT = 9373;
const appProc = spawn('node_modules/.bin/electron', ['.', '--dev', `--remote-debugging-port=${PORT}`, '--no-sandbox', '--disable-gpu'], {
  env: { ...process.env, POLARIS_LOCK_DIR: DIR, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  stdio: ['ignore', 'ignore', 'ignore'], detached: true,
});
setTimeout(() => { try { process.kill(-appProc.pid, 'SIGKILL'); } catch {} process.exit(1); }, 120000).unref();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function listTargets() {
  for (let i = 0; i < 40; i++) { try { const r = await fetch(`http://127.0.0.1:${PORT}/json`); return await r.json(); } catch {} await sleep(400); }
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
async function ev(c, expr, tries = 3) {
  let r;
  for (let i = 0; i < tries; i++) {
    r = await c.call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r && !r.error) break;
    await sleep(300);
  }
  if (!r || r.error) throw new Error('CDP error ' + JSON.stringify(r && r.error) + ' @ ' + expr.slice(0, 120));
  if (r.exceptionDetails) throw new Error('JS异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 500) + ' @ ' + expr.slice(0, 120));
  return r.result && r.result.value;
}
let passed = 0, failed = 0;
const ok = (n, d) => { passed++; console.log('  ✓ ' + n + (d ? '  → ' + d : '')); };
const bad = (n, e) => { failed++; console.error('  ✗ ' + n + (e ? '  → ' + e : '')); };

(async () => {
  console.log('\n=== 堡垒机资产按全部所属目录分组 ===\n');
  try {
    const ts0 = await listTargets();
    const lockT = ts0.find((t) => /解锁/.test(t.title || '')) || ts0.find((t) => t.type === 'page');
    if (!lockT) throw new Error('锁定页未就绪');
    const lock = await connect(lockT.webSocketDebuggerUrl);
    for (let i = 0; i < 40; i++) { if (await ev(lock, `!!document.getElementById('pw')`)) break; await sleep(300); }
    await ev(lock, `document.getElementById('pw').value='x1234567'; document.getElementById('pw2').value='x1234567'; document.getElementById('btn').click();`);
    let c = null;
    for (let i = 0; i < 50; i++) { await sleep(400); const t2 = await listTargets(); const m = t2.find((t) => t.type === 'page' && !/解锁/.test(t.title || '')); if (m) { c = await connect(m.webSocketDebuggerUrl); break; } }
    if (!c) throw new Error('主窗口未就绪');

    // 注入含多目录资产的 state,展开堡垒机分组后检查计数与重复出现
    await ev(c, `(function(){
      state.bastionAssets = [
        { devId:'1', name:'设备A', ip:'10.0.0.1', port:22, proto:'ssh', accounts:[], recentAccount:'', favorite:false, dir:'麒麟1', dirs:['麒麟','麒麟1'], dirPath:['根','麒麟1'] },
        { devId:'2', name:'设备B', ip:'10.0.0.2', port:22, proto:'ssh', accounts:[], recentAccount:'', favorite:false, dir:'麒麟1', dirs:['麒麟1'], dirPath:['根','麒麟1'] },
        { devId:'3', name:'设备C', ip:'10.0.0.3', port:22, proto:'ssh', accounts:[], recentAccount:'', favorite:false, dir:'麒麟', dirs:['麒麟'], dirPath:['根','麒麟'] },
        { devId:'4', name:'设备D', ip:'10.0.0.4', port:22, proto:'ssh', accounts:[], recentAccount:'', favorite:false, dir:'', dirs:[], dirPath:[] },
      ];
      state.bastionCollapsed = false; state.bastionDirsInit = false;
      state.collapsedTopBastion = false; state.collapsedTopHost = false;
      renderSessionList('');
      return true;
    })()`);
    await sleep(400);

    const dump = `(function(){ const sc=document.getElementById('session-tree'); return sc?sc.innerText:''; })()`;
    const txt = await ev(c, dump);
    const has = (s) => txt.includes(s);
    // 麒麟 组:设备A(同时属麒麟) + 设备C → 计数 2
    if (has('📁 麒麟(2)')) ok('麒麟 组计数=2(含跨目录设备A)'); else bad('麒麟 组计数', txt.slice(0, 300).replace(/\n/g,'|'));
    // 麒麟1 组:设备A + 设备B → 计数 2
    if (has('📁 麒麟1(2)')) ok('麒麟1 组计数=2(含跨目录设备A)'); else bad('麒麟1 组计数', txt.slice(0, 300).replace(/\n/g,'|'));
    // 未分组:设备D
    if (has('🗂 未分组(1)')) ok('未分组计数=1'); else bad('未分组计数', txt.slice(0, 300).replace(/\n/g,'|'));

    // 展开所有分组,确认设备A 在 麒麟 和 麒麟1 两组各出现一次(与网页一致)
    await ev(c, `(function(){ state.bastionDirCollapsed.clear(); renderSessionList(''); return true; })()`);
    await sleep(300);
    const txt2 = await ev(c, dump);
    const firstA = txt2.indexOf('设备A');
    const secondA = txt2.indexOf('设备A', firstA + 1);
    if (firstA >= 0 && secondA >= 0) ok('设备A 在麒麟 和 麒麟1 两组各出现一次(与网页一致)');
    else bad('设备A 重复出现', txt2.slice(0, 400).replace(/\n/g,'|'));

    console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  } catch (e) { console.error('\n测试异常:', e && e.message); failed++; console.log(`\n结果: ${passed} 通过, ${failed} 失败`); }
  try { process.kill(-appProc.pid, 'SIGKILL'); } catch {}
  process.exit(failed ? 1 : 0);
})();
