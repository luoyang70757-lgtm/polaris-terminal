'use strict';
/**
 * verify-scope.js — 验证搜索框前的「全部/主机/堡垒机」下拉范围选择:
 *  ① 下拉存在且默认「全部」,两个顶级分组都在
 *  ② 选「主机」→ 🛡堡垒机分组隐藏;选「堡垒机」→ 🖥主机分组隐藏;选「全部」→ 都显示
 * 运行: node verify-scope.js(需 9365 空闲;--dev 临时数据目录)
 */
const { spawn } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-scope-'));
const PORT = 9365;
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
const groupVisible = (label) => `(function(){var h=document.querySelectorAll('.asset-group-head .asset-group-name');for(var i=0;i<h.length;i++){if(h[i].textContent.indexOf('${label}')===0)return true;}return false;})()`;
const setScope = (v) => `(function(){var s=document.getElementById('scope-select');s.value='${v}';s.dispatchEvent(new Event('change'));})()`;

(async () => {
  console.log('\n=== 搜索范围下拉(全部/主机/堡垒机) ===\n');
  try {
    const ts0 = await listTargets();
    const lockT = ts0.find((t) => /解锁/.test(t.title || '')) || ts0.find((t) => t.type === 'page');
    const lock = await connect(lockT.webSocketDebuggerUrl);
    for (let i = 0; i < 30; i++) { if (await ev(lock, `!!document.getElementById('pw')`)) break; await sleep(300); }
    await ev(lock, `document.getElementById('pw').value='x1234567'; document.getElementById('pw2').value='x1234567'; document.getElementById('btn').click();`);
    let c = null;
    for (let i = 0; i < 30; i++) { await sleep(400); const t2 = await listTargets(); const m = t2.find((t) => t.type === 'page' && !/解锁/.test(t.title || '')); if (m) { c = await connect(m.webSocketDebuggerUrl); break; } }
    if (!c) throw new Error('主窗口未就绪');

    await check(c, '下拉存在且默认「全部」', `(function(){var s=document.getElementById('scope-select');return !!s && s.value==='all' && s.options.length===3;})()`);
    await check(c, '默认两个分组都在(🖥 主机)', groupVisible('🖥 主机'));
    await check(c, '默认两个分组都在(🛡 堡垒机)', groupVisible('🛡 堡垒机'));

    await ev(c, setScope('host'));
    await sleep(150);
    await check(c, '选「主机」→ 🖥 主机显示', groupVisible('🖥 主机'));
    await check(c, '选「主机」→ 🛡 堡垒机隐藏', groupVisible('🛡 堡垒机'), false);

    await ev(c, setScope('bastion'));
    await sleep(150);
    await check(c, '选「堡垒机」→ 🛡 堡垒机显示', groupVisible('🛡 堡垒机'));
    await check(c, '选「堡垒机」→ 🖥 主机隐藏', groupVisible('🖥 主机'), false);

    await ev(c, setScope('all'));
    await sleep(150);
    await check(c, '选「全部」→ 两个分组都显示', `(${groupVisible('🖥 主机')}) && (${groupVisible('🛡 堡垒机')})`);

    console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  } catch (e) { console.error('\n测试异常:', e && e.message); failed++; console.log(`\n结果: ${passed} 通过, ${failed} 失败`); }
  try { process.kill(-appProc.pid, 'SIGKILL'); } catch {}
  process.exit(failed ? 1 : 0);
})();
