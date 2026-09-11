'use strict';
/**
 * verify-bastion-multisite.js — 多堡垒机资产按 bastionUrl 分键持久化(回归)
 *   旧版:state.bastionAssets 是"多站点合并展示"的集合,持久化却整包写到 state.bastionUrl
 *        一把键上 → B 站点的资产被写进 A 键下,重启后跨键去重会丢设备/挪位置。
 *   断言:① 恢复后内存里仍是合并集合(展示行为不变)
 *        ② 落盘后 A 键只含 A 的设备、B 键只含 B 的设备(新增的 B 设备也落在 B 键)
 *        ③ 缺 bastionUrl 的资产不会被写到任何键(宁可不写,不写错键)
 * 运行: node verify-bastion-multisite.js(需 9376/2252 空闲)
 */
const { spawn, execSync } = require('child_process');
const { freePort, killTree, guardTimeout } = require('./test-helper');
const fs = require('fs'); const os = require('os'); const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-multisite-'));
const PORT = 9376, SSH = 2252;
try { execSync('pkill -f "polaris-terminal/node_modules/electron" 2>/dev/null'); } catch { /* 无残留 */ }
freePort(PORT); freePort(SSH);
process.env.MOCK_SSH_PORT = String(SSH);
process.env.MOCK_HTTP_PORT = String(SSH + 100);
const { start } = require('./mock/mock-server');
start();

const appProc = spawn('node_modules/.bin/electron', ['.', '--dev', `--remote-debugging-port=${PORT}`], {
  env: { ...process.env, POLARIS_LOCK_DIR: DIR, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  stdio: ['ignore', 'ignore', 'ignore'], detached: true,
});
guardTimeout(180000, appProc);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function targets() {
  for (let i = 0; i < 75; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json`, { signal: AbortSignal.timeout(3000) }); const j = await r.json(); const p = j.find((t) => t.type === 'page' && /解锁|Polaris/.test(t.title || '')); if (p) return j; } catch { /* not ready */ }
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
  if (r.exceptionDetails) throw new Error('JS异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result && r.result.value;
}
let passed = 0, failed = 0;
const ok = (n) => { passed++; console.log('  ✓ ' + n); };
const bad = (n, e) => { failed++; console.error('  ✗ ' + n + (e ? ' → ' + e : '')); };
const A = 'https://10.204.240.4';
const B = 'https://10.204.240.9';

(async () => {
  console.log('\n=== 多堡垒机资产分键持久化 ===\n');
  try {
    let lockT = null;
    for (let i = 0; i < 50; i++) { lockT = (await targets()).find((t) => /解锁/.test(t.title || '')); if (lockT) break; await sleep(400); }
    const lock = await connect(lockT.webSocketDebuggerUrl);
    for (let i = 0; i < 30; i++) { if (await ev(lock, `!!document.getElementById('pw')`)) break; await sleep(300); }
    await sleep(300);
    await ev(lock, `document.getElementById('pw').value='x1234567'; document.getElementById('pw2').value='x1234567'; document.getElementById('btn').click();`);
    let main = null;
    for (let i = 0; i < 30; i++) { await sleep(500); const t2 = await targets(); const m = t2.find((t) => t.type === 'page' && !/解锁/.test(t.title || '')); if (m) { main = m; break; } }
    const c = await connect(main.webSocketDebuggerUrl);
    await sleep(1000);

    // 两台堡垒机各seed一个设备
    await ev(c, `(async()=>{
      await window.api.bastionSaveAssets(${JSON.stringify(A)}, [{devId:'a1', name:'A-1', ip:'10.1.1.1', dirs:['d'], dir:'d'}], 'h3c');
      await window.api.bastionSaveAssets(${JSON.stringify(B)}, [{devId:'b1', name:'B-1', ip:'10.2.2.2', dirs:['d'], dir:'d'}], 'h3c');
      return true;
    })()`);
    await sleep(500);
    // 恢复(合并展示)+ 当前站点设为 A
    await ev(c, `(async()=>{ state.bastionUrl=${JSON.stringify(A)}; await restoreBastionAssets(); return true; })()`);
    await sleep(800);
    const merged = await ev(c, `JSON.stringify(state.bastionAssets.map(a=>({id:a.devId, u:a.bastionUrl})))`);
    const mArr = JSON.parse(merged);
    if (mArr.length === 2) ok('① 恢复后内存为合并集合(展示行为不变):' + merged);
    else bad('① 恢复后集合不符', merged);
    if (mArr.every((x) => x.u)) ok('① 每台资产都带自己的 bastionUrl');
    else bad('① 资产缺 bastionUrl', merged);

    // 模拟"B 站点又捕获到一台新设备" → 触发持久化
    await ev(c, `(async()=>{
      state.bastionAssets.push({devId:'b2', name:'B-2', ip:'10.2.2.3', dirs:['d'], dir:'d', bastionUrl:${JSON.stringify(B)}});
      flushBastionAssets();
      return true;
    })()`);
    await sleep(1200);
    const byUrl = JSON.parse(await ev(c, `(async()=>{ const r = await window.api.bastionLoadAssets(); const o={}; for (const [u,list] of Object.entries(r.byUrl||{})) o[u]=list.map(a=>a.devId).sort(); return JSON.stringify(o); })()`));
    const aIds = (byUrl[A] || []).join(',');
    const bIds = (byUrl[B] || []).join(',');
    if (aIds === 'a1') ok(`② A 键只含 A 的设备(${aIds})`);
    else bad('② A 键混入了其它站点的设备(旧 bug)', JSON.stringify(byUrl));
    if (bIds === 'b1,b2') ok(`② B 键含 B 的设备含新增(${bIds})`);
    else bad('② B 键不符', JSON.stringify(byUrl));

    // ③ 没带 bastionUrl 的资产(如按目录补拉时新建的设备)归**当前站点**,绝不串到别的键
    await ev(c, `(async()=>{ state.bastionAssets.push({devId:'x1', name:'X-1', ip:'10.9.9.9'}); flushBastionAssets(); return true; })()`);
    await sleep(1000);
    const after = JSON.parse(await ev(c, `(async()=>{ const r = await window.api.bastionLoadAssets(); const o={}; for (const [u,list] of Object.entries(r.byUrl||{})) o[u]=list.map(a=>a.devId); return JSON.stringify(o); })()`));
    const inA = (after[A] || []).includes('x1');
    const inB = (after[B] || []).includes('x1');
    if (inA && !inB) ok('③ 无 bastionUrl 的资产归当前站点(A),未串到别的站点键');
    else bad('③ 无归属资产的落键不符', JSON.stringify(after));

    console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  } catch (e) { console.error('\n测试异常:', e && e.message); failed++; console.log(`\n结果: ${passed} 通过, ${failed} 失败`); }
  try { killTree(appProc); } catch { /* ignore */ }
  process.exit(failed ? 1 : 0);
})();
