'use strict';
/**
 * verify-bastion-hierarchy.js — 验证堡垒机分组层级渲染 + 收藏分组自动获取:
 *  ① 业务根(中华人寿大连IDC,取自资产 dirPath[0])作为父级显示,其下目录缩进、不漏目录
 *  ② 收藏分组嵌套(组1→组2)两级 📁 缩进;未归属收藏归「默认收藏」
 *  ③ 资产无 dirPath → 平铺(无缩进),兼容树缺失
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
const headsJSON = `(function(){var out=[];document.querySelectorAll('#session-tree .asset-group-head').forEach(function(h){var n=h.querySelector('.asset-group-name');out.push({label:n?n.textContent:'',pad:h.style.paddingLeft||''});});return JSON.stringify(out);})()`;
const seedAndRender = (assetsJson, favTreeJson) => `(function(){
  state.searchScope='all'; state.collapsedTopBastion=false; state.bastionCollapsed=false;
  state.bastionDirsInit=true; state.bastionDirCollapsed.clear();
  state.bastionTree=[]; state.bastionAssets=${assetsJson};
  state.bastionFavTree=${favTreeJson || 'null'};
  renderSessionList('');
  return true;
})()`;
const FAVTREE = JSON.stringify({ name: 'favs', children: [
  { id: 1081, name: '组1', children: [ { id: 1082, name: '组2', children: [] } ] }
]});
const mkAsset = (name, ip, id, extra) => Object.assign({ name, ip, devId: id, port: 22, proto: 'ssh', accounts: [], recentAccount: '', favorite: false }, extra);
// ① 有业务根(dirPath[0]=中华人寿大连IDC)的目录
const ASSETS_HIER = JSON.stringify([
  mkAsset('dev1', '10.1.1.1', '101', { dir: '父A', dirs: ['父A'], dirPath: ['中华人寿大连IDC', '父A'] }),
  mkAsset('dev2', '10.1.1.2', '102', { dir: '子B', dirs: ['子B'], dirPath: ['中华人寿大连IDC', '子B'] }),
  mkAsset('fav1', '10.1.1.3', '201', { favorite: true, favGroup: '组1/组2' }),
  mkAsset('fav2', '10.1.1.4', '202', { favorite: true, favGroup: '默认收藏' }),
]);
// ③ 无 dirPath 的目录(平铺)
const ASSETS_FLAT = JSON.stringify([
  mkAsset('dev1', '10.1.1.1', '101', { dir: '父A', dirs: ['父A'] }),
  mkAsset('dev2', '10.1.1.2', '102', { dir: '子B', dirs: ['子B'] }),
]);

(async () => {
  console.log('\n=== 堡垒机分组层级渲染 + 收藏分组自动获取 ===\n');
  try {
    const ts0 = await listTargets();
    const lockT = ts0.find((t) => /解锁/.test(t.title || '')) || ts0.find((t) => t.type === 'page');
    const lock = await connect(lockT.webSocketDebuggerUrl);
    for (let i = 0; i < 30; i++) { if (await ev(lock, `!!document.getElementById('pw')`)) break; await sleep(300); }
    await ev(lock, `document.getElementById('pw').value='x1234567'; document.getElementById('pw2').value='x1234567'; document.getElementById('btn').click();`);
    let c = null;
    for (let i = 0; i < 30; i++) { await sleep(400); const t2 = await listTargets(); const m = t2.find((t) => t.type === 'page' && !/解锁/.test(t.title || '')); if (m) { c = await connect(m.webSocketDebuggerUrl); break; } }
    if (!c) throw new Error('主窗口未就绪');

    // ④ guest 侧自动获取函数存在 + 残留 favGroup 清理逻辑(源码级断言,mock 无 H3C webview 不注入)
    const rjs = fs.readFileSync(path.join(__dirname, 'src', 'renderer.js'), 'utf8');
    if (rjs.includes('window.__bastionFetchFavTree = function()') && rjs.includes('window.__bastionFetchFavGroups = function()')) ok('guest 定义 __bastionFetchFavTree/__bastionFetchFavGroups(收藏分组自动获取入口)');
    else bad('guest 定义 __bastionFetchFavTree/__bastionFetchFavGroups(收藏分组自动获取入口)');
    if (rjs.includes('delete x.favGroup')) ok('guest 重映射前清除残留 favGroup(undefinedxxx 不再残留)');
    else bad('guest 重映射前清除残留 favGroup(undefinedxxx 不再残留)');
    if (rjs.includes("old.favGroup.indexOf('undefined') !== 0")) ok('资产合并不再保留 "undefined" 前缀的脏 favGroup');
    else bad('资产合并不再保留 "undefined" 前缀的脏 favGroup');

    // ① 业务根父级 + 子目录缩进 + 不漏目录
    await ev(c, seedAndRender(ASSETS_HIER, FAVTREE));
    await sleep(120);
    const heads = JSON.parse(await ev(c, headsJSON));
    const find = (p) => heads.find((x) => x.label.startsWith(p));
    const findIdx = (p) => heads.findIndex((x) => x.label.startsWith(p));
    const padVal = (p) => { const h = find(p); return h ? (parseInt(h.pad, 10) || 0) : -999; };
    if (find('📁 中华人寿大连IDC(')) ok('业务根父级「中华人寿大连IDC」存在(含资产计数)');
    else bad('业务根父级「中华人寿大连IDC」存在(含资产计数)');
    if (find('📁 父A(') && find('📁 子B(')) ok('子目录「父A」「子B」都存在(不漏目录)');
    else bad('子目录「父A」「子B」都存在(不漏目录)');
    if (findIdx('📁 中华人寿大连IDC(') < findIdx('📁 父A(') && findIdx('📁 父A(') < findIdx('📁 子B(')) ok('顺序:业务根 → 父A → 子B');
    else bad('顺序:业务根 → 父A → 子B', `根@${findIdx('📁 中华人寿大连IDC(')} 父A@${findIdx('📁 父A(')} 子B@${findIdx('📁 子B(')}`);
    if (padVal('📁 父A(') === 22 && padVal('📁 子B(') === 22) ok('子目录缩进一级(paddingLeft=22px)');
    else bad('子目录缩进一级(paddingLeft=22px)', `父A=${padVal('📁 父A(')} 子B=${padVal('📁 子B(')}`);
    if (find('📁 中华人寿大连IDC(')) {
      const lbl = find('📁 中华人寿大连IDC(').label;
      if (lbl === '📁 中华人寿大连IDC(2)') ok('业务根头设备数=其下目录总数(2)'); else bad('业务根头设备数=其下目录总数(2)', lbl);
    }

    // ② 收藏分组两级缩进 + 默认收藏
    if (find('📁 组1(') && find('📁 组2(')) ok('收藏分组两级 📁 存在(组1/组2)'); else bad('收藏分组两级 📁 存在(组1/组2)');
    if (findIdx('📁 组1(') < findIdx('📁 组2(')) ok('收藏组1在组2之前'); else bad('收藏组1在组2之前');
    if (padVal('📁 组2(') > padVal('📁 组1(')) ok('收藏子组缩进 > 父组'); else bad('收藏子组缩进 > 父组', `组1=${padVal('📁 组1(')} 组2=${padVal('📁 组2(')}`);
    if (find('📁 默认收藏(')) ok('未归属收藏归「默认收藏」'); else bad('未归属收藏归「默认收藏」');

    // ③ 无 dirPath → 平铺(无缩进)
    await ev(c, seedAndRender(ASSETS_FLAT, 'null'));
    await sleep(120);
    const heads2 = JSON.parse(await ev(c, headsJSON));
    const pad2 = (p) => { const h = heads2.find((x) => x.label.startsWith(p)); return h ? h.pad : null; };
    if (pad2('📁 父A(') !== null && pad2('📁 父A(') === '') ok('无 dirPath 时父A 平铺(无缩进)'); else bad('无 dirPath 时父A 平铺(无缩进)', String(pad2('📁 父A(')));
    if (pad2('📁 子B(') !== null && pad2('📁 子B(') === '') ok('无 dirPath 时子B 平铺(无缩进)'); else bad('无 dirPath 时子B 平铺(无缩进)', String(pad2('📁 子B(')));

    console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  } catch (e) { console.error('\n测试异常:', e && e.message); failed++; console.log(`\n结果: ${passed} 通过, ${failed} 失败`); }
  try { process.kill(-appProc.pid, 'SIGKILL'); } catch {}
  process.exit(failed ? 1 : 0);
})();
