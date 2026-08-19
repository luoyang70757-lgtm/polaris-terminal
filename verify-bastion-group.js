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
async function check(c, name, expr, expect = true) {
  try { const v = await ev(c, expr); if (v === expect) ok(name, '=' + JSON.stringify(v)); else bad(name, 'got ' + JSON.stringify(v) + ' want ' + JSON.stringify(expect)); } catch (e) { bad(name, e.message); }
}

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
    // 展开所有分组(根/目录/收藏),看完整层级
    await ev(c, `(function(){ state.bastionDirCollapsed.clear(); state.collapsedTopBastion=false; renderSessionList(''); return true; })()`);
    await sleep(300);
    const txt = await ev(c, dump);
    const has = (s) => txt.includes(s);
    // 业务根包裹:测试数据 dirPath=['根', ...],根名=根
    if (has('📁 根(3)')) ok('业务根「根」存在且去重计数=3'); else bad('业务根', txt.slice(0, 300).replace(/\n/g,'|'));
    // 麒麟 组:设备A(同时属麒麟) + 设备C → 计数 2(根的子目录)
    if (has('📁 麒麟(2)')) ok('麒麟 组计数=2(含跨目录设备A)'); else bad('麒麟 组计数', txt.slice(0, 300).replace(/\n/g,'|'));
    // 麒麟1 组:设备A + 设备B → 计数 2
    if (has('📁 麒麟1(2)')) ok('麒麟1 组计数=2(含跨目录设备A)'); else bad('麒麟1 组计数', txt.slice(0, 300).replace(/\n/g,'|'));
    // 未分组:设备D(无 dir/dirPath)
    if (has('🗂 未分组(1)')) ok('未分组计数=1'); else bad('未分组计数', txt.slice(0, 300).replace(/\n/g,'|'));

    // 设备A 在 麒麟 和 麒麟1 两组各出现一次(与网页一致)
    const firstA = txt.indexOf('设备A');
    const secondA = txt.indexOf('设备A', firstA + 1);
    if (firstA >= 0 && secondA >= 0) ok('设备A 在麒麟 和 麒麟1 两组各出现一次(与网页一致)');
    else bad('设备A 重复出现', txt.slice(0, 400).replace(/\n/g,'|'));

    // 旧数据兼容:只有 dir(单一目录)没有 dirs 的资产仍按单目录分组显示(等重新捕获才补全)
    await ev(c, `(function(){
      state.bastionAssets = [
        { devId:'5', name:'旧设备X', ip:'10.0.0.5', port:22, proto:'ssh', accounts:[], recentAccount:'', favorite:false, dir:'旧组A', dirs:[] },
        { devId:'6', name:'旧设备Y', ip:'10.0.0.6', port:22, proto:'ssh', accounts:[], recentAccount:'', favorite:false, dir:'旧组A', dirs:[] },
      ];
      state.bastionCollapsed = false; state.bastionDirsInit = false;
      renderSessionList('');
      return true;
    })()`);
    await sleep(300);
    await ev(c, `(function(){ state.bastionDirCollapsed.clear(); renderSessionList(''); return true; })()`);
    await sleep(300);
    const txt3 = await ev(c, dump);
    if (txt3.includes('📁 旧组A(2)') && txt3.includes('旧设备X')) ok('旧数据(无 dirs)按单目录分组正常显示');
    else bad('旧数据兼容', txt3.slice(0, 300).replace(/\n/g,'|'));
    // mergeBastionCapture:重捕获时旧 dir/dirs 与新 dirs 取并集,分组不丢
    await check(c, '重捕获并集保留旧 dir', `(function(){ const r=mergeBastionCapture([{devId:'1',dir:'安全设备',dirs:[]}],[{devId:'1',dir:'',dirs:[],dirPath:[]}]); return r[0].dirs.join('|')==='安全设备'; })()`, true);
    await check(c, '重捕获并集=旧+新(不丢已补充目录)', `(function(){ const r=mergeBastionCapture([{devId:'1',dir:'旧',dirs:['旧']}],[{devId:'1',dir:'',dirs:['麒麟','麒麟1'],dirPath:[]}]); const s=r[0].dirs; return s.includes('麒麟')&&s.includes('麒麟1')&&s.includes('旧')&&s.length===3; })()`, true);
    await check(c, '重捕获保留 favGroup', `(function(){ const r=mergeBastionCapture([{devId:'1',favGroup:'默认收藏'}],[{devId:'1'}]); return r[0].favGroup==='默认收藏'; })()`, true);

    // ---- 收藏按分组展示 ----
    await ev(c, `(function(){
      state.bastionAssets = [
        { devId:'f1', name:'收藏A', ip:'10.0.0.1', port:22, proto:'ssh', accounts:[], recentAccount:'', favorite:true, favGroup:'111', dir:'', dirs:[] },
        { devId:'f2', name:'收藏B', ip:'10.0.0.2', port:22, proto:'ssh', accounts:[], recentAccount:'', favorite:true, favGroup:'默认收藏', dir:'', dirs:[] },
        { devId:'f3', name:'收藏C', ip:'10.0.0.3', port:22, proto:'ssh', accounts:[], recentAccount:'', favorite:true, favGroup:'111', dir:'', dirs:[] },
      ];
      state.bastionCollapsed = false; state.bastionDirsInit = false; state.bastionDirCollapsed.clear();
      renderSessionList('');
      return true;
    })()`);
    await sleep(300);
    const ftxt = await ev(c, dump);
    if (ftxt.includes('⭐ 收藏(3)') && ftxt.includes('📁 111(2)') && ftxt.includes('📁 默认收藏(1)')) ok('收藏按分组展示(111/默认收藏)');
    else bad('收藏分组', ftxt.slice(0, 300).replace(/\n/g,'|'));

    console.log(`\n结果: ${passed} 通过, ${failed} 失败`);

    console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  } catch (e) { console.error('\n测试异常:', e && e.message); failed++; console.log(`\n结果: ${passed} 通过, ${failed} 失败`); }
  try { process.kill(-appProc.pid, 'SIGKILL'); } catch {}
  process.exit(failed ? 1 : 0);
})();
