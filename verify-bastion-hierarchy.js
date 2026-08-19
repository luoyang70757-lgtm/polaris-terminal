'use strict';
/**
 * verify-bastion-hierarchy.js — 验证堡垒机分组上下级层次渲染 + 收藏分组自动获取链路:
 *  ① 业务目录树两级(父A→子B):父组头在子组前、子组缩进(paddingLeft>0)、父组头显示后代总数
 *  ② 收藏分组嵌套(组1→组2):两级 📁 且子级缩进;未归属收藏归「默认收藏」
 *  ③ 树缺失降级:无 bastionTree → 平铺(无缩进),与旧行为一致
 *  ④ guest 侧 __bastionFetchFavTree / __bastionFetchFavGroups 定义存在(收藏分组自动获取入口)
 * 运行: node verify-bastion-hierarchy.js(需 9373 空闲;--dev 临时数据目录)
 */
const { spawn } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-bhier-'));
const PORT = 9373;
const appProc = spawn('node_modules/.bin/electron', ['.', '--dev', `--remote-debugging-port=${PORT}`, '--no-sandbox', '--disable-gpu'], {
  env: { ...process.env, POLARIS_LOCK_DIR: DIR, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  stdio: ['ignore', 'ignore', 'ignore'], detached: true,
});
setTimeout(() => { try { process.kill(-appProc.pid, 'SIGKILL'); } catch {} process.exit(1); }, 100000).unref();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function listTargets() { for (let i = 0; i < 40; i++) { try { const r = await fetch(`http://127.0.0.1:${PORT}/json`); return await r.json(); } catch {} await sleep(400); } throw new Error('targets 未就绪'); }
function connect(url) { return new Promise((resolve, reject) => { const ws = new WebSocket(url); let id = 0; const pending = new Map(); ws.onopen = () => resolve({ call(m, p = {}) { return new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method: m, params: p })); }); }, close() { ws.close(); } }); ws.onerror = (e) => reject(e); ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } }; }); }
async function ev(c, expr) { const r = await c.call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error('JS异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 500) + ' @ ' + expr.slice(0, 80)); return r.result && r.result.value; }
let passed = 0, failed = 0;
const ok = (n) => { passed++; console.log('  ✓ ' + n); };
const bad = (n, e) => { failed++; console.error('  ✗ ' + n + (e ? ' -> ' + e : '')); };
async function check(c, name, expr, expect = true) { try { const v = await ev(c, expr); if (v === expect) ok(name); else bad(name, `got ${JSON.stringify(v)}`); } catch (e) { bad(name, e.message); } }
// 读取会话列表里所有分组头的 {label, paddingLeft}
const headsJSON = `(function(){var out=[];document.querySelectorAll('#session-tree .asset-group-head').forEach(function(h){var n=h.querySelector('.asset-group-name');out.push({label:n?n.textContent:'',pad:h.style.paddingLeft||''});});return JSON.stringify(out);})()`;
// 注入假数据并渲染
const seedAndRender = (treeJson, assetsJson, favTreeJson) => `(function(){
  state.searchScope='all'; state.collapsedTopBastion=false; state.bastionCollapsed=false;
  state.bastionDirsInit=true; state.bastionDirCollapsed.clear();
  state.bastionTree=${treeJson || '[]'};
  state.bastionAssets=${assetsJson};
  state.bastionFavTree=${favTreeJson || 'null'};
  renderSessionList('');
  return true;
})()`;

const TREE = JSON.stringify([
  { name: 'ROOT', id: 0, path: ['ROOT'], empty: false, children: [
    { name: '父A', id: 1, path: ['ROOT', '父A'], empty: false, children: [
      { name: '子B', id: 2, path: ['ROOT', '父A', '子B'], empty: false, children: [] }
    ]}
  ]}
]);
const FAVTREE = JSON.stringify({ name: 'favs', children: [
  { id: 1081, name: '组1', children: [ { id: 1082, name: '组2', children: [] } ] }
]});
const mkAsset = (name, ip, id, extra) => Object.assign({ name, ip, devId: id, port: 22, proto: 'ssh', accounts: [], recentAccount: '', favorite: false }, extra);
const ASSETS_HIER = JSON.stringify([
  mkAsset('dev1', '10.1.1.1', '101', { dir: '父A', dirs: ['父A'], dirPath: ['ROOT', '父A'] }),
  mkAsset('dev2', '10.1.1.2', '102', { dir: '子B', dirs: ['子B'], dirPath: ['ROOT', '父A', '子B'] }),
  mkAsset('fav1', '10.1.1.3', '201', { favorite: true, favGroup: '组1/组2' }),
  mkAsset('fav2', '10.1.1.4', '202', { favorite: true, favGroup: '默认收藏' }),
]);
const ASSETS_FLAT = JSON.stringify([
  mkAsset('dev1', '10.1.1.1', '101', { dir: '父A', dirs: ['父A'], dirPath: ['ROOT', '父A'] }),
  mkAsset('dev2', '10.1.1.2', '102', { dir: '子B', dirs: ['子B'], dirPath: ['ROOT', '父A', '子B'] }),
]);

(async () => {
  console.log('\n=== 堡垒机分组层次渲染 + 收藏分组自动获取 ===\n');
  try {
    const ts0 = await listTargets();
    const lockT = ts0.find((t) => /解锁/.test(t.title || '')) || ts0.find((t) => t.type === 'page');
    const lock = await connect(lockT.webSocketDebuggerUrl);
    for (let i = 0; i < 30; i++) { if (await ev(lock, `!!document.getElementById('pw')`)) break; await sleep(300); }
    await ev(lock, `document.getElementById('pw').value='x1234567'; document.getElementById('pw2').value='x1234567'; document.getElementById('btn').click();`);
    let c = null;
    for (let i = 0; i < 30; i++) { await sleep(400); const t2 = await listTargets(); const m = t2.find((t) => t.type === 'page' && !/解锁/.test(t.title || '')); if (m) { c = await connect(m.webSocketDebuggerUrl); break; } }
    if (!c) throw new Error('主窗口未就绪');

    // ④ guest 侧自动获取函数存在(注入到 webview 的脚本含定义;mock 无 H3C webview 不注入,故源码级断言)
    const rjs = fs.readFileSync(path.join(__dirname, 'src', 'renderer.js'), 'utf8');
    if (rjs.includes('window.__bastionFetchFavTree = function()') && rjs.includes('window.__bastionFetchFavGroups = function()')) ok('guest 定义 __bastionFetchFavTree/__bastionFetchFavGroups(收藏分组自动获取入口)');
    else bad('guest 定义 __bastionFetchFavTree/__bastionFetchFavGroups(收藏分组自动获取入口)');

    // ① 业务目录两级 + 收藏分组嵌套(层次渲染)
    await ev(c, seedAndRender(TREE, ASSETS_HIER, FAVTREE));
    await sleep(120);
    const heads = JSON.parse(await ev(c, headsJSON));
    const pad = (label) => { const h = heads.find((x) => x.label.startsWith(label)); return h ? h.pad : null; };
    const idx = (label) => heads.findIndex((x) => x.label.startsWith(label));
    const padVal = (label) => { const p = pad(label); return p === null ? -999 : parseInt(p, 10) || 0; };
    const hParent = '📁 父A(', hChild = '📁 子B(', hG1 = '📁 组1(', hG2 = '📁 组2(', hDef = '📁 默认收藏(';
    if (pad(hParent) === null) bad('业务目录父组头「父A」存在'); else ok('业务目录父组头「父A」存在');
    if (pad(hChild) === null) bad('业务目录子组头「子B」存在'); else ok('业务目录子组头「子B」存在');
    if (pad(hParent) !== null && pad(hChild) !== null) {
      if (idx(hParent) < idx(hChild)) ok('父组在子组之前(树序)'); else bad('父组在子组之前(树序)', `父@${idx(hParent)} 子@${idx(hChild)}`);
      if (padVal(hChild) > padVal(hParent)) ok('子组缩进 > 父组缩进'); else bad('子组缩进 > 父组缩进', `父=${pad(hParent)} 子=${pad(hChild)}`);
      if (padVal(hParent) === 0) ok('父组为顶层级(无缩进)'); else bad('父组为顶层级(无缩进)', `父=${pad(hParent)}`);
    }
    if (pad(hParent) !== null) {
      const lbl = heads.find((x) => x.label.startsWith(hParent)).label;
      if (lbl === '📁 父A(2)') ok('父组头设备数=自身+后代 父A(2)'); else bad('父组头设备数=自身+后代 父A(2)', lbl);
    }
    if (pad(hG1) === null || pad(hG2) === null) { bad('收藏分组两级 📁 存在(组1/组2)'); }
    else {
      ok('收藏分组两级 📁 存在(组1/组2)');
      if (idx(hG1) < idx(hG2)) ok('收藏组1在组2之前'); else bad('收藏组1在组2之前');
      if (padVal(hG2) > padVal(hG1)) ok('收藏子组缩进 > 父组'); else bad('收藏子组缩进 > 父组', `组1=${pad(hG1)} 组2=${pad(hG2)}`);
    }
    if (pad(hDef) === null) bad('未归属收藏归「默认收藏」'); else ok('未归属收藏归「默认收藏」');

    // ③ 无 bastionTree 降级平铺
    await ev(c, seedAndRender('[]', ASSETS_FLAT, 'null'));
    await sleep(120);
    const heads2 = JSON.parse(await ev(c, headsJSON));
    const h2 = (label) => heads2.find((x) => x.label.startsWith(label));
    if (h2('📁 父A(')) {
      if (!h2('📁 父A(').pad) ok('无树时平铺(父A 无缩进)'); else bad('无树时平铺(父A 无缩进)', h2('📁 父A(').pad);
    } else bad('无树时平铺(父A 组存在)');
    if (h2('📁 子B(')) {
      if (!h2('📁 子B(').pad) ok('无树时平铺(子B 无缩进)'); else bad('无树时平铺(子B 无缩进)', h2('📁 子B(').pad);
    } else bad('无树时平铺(子B 组存在)');

    console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  } catch (e) { console.error('\n测试异常:', e && e.message); failed++; console.log(`\n结果: ${passed} 通过, ${failed} 失败`); }
  try { process.kill(-appProc.pid, 'SIGKILL'); } catch {}
  process.exit(failed ? 1 : 0);
})();
