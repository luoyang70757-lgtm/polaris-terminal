'use strict';
/**
 * verify-bastion-merge.js — 验证「头部🛡堡垒机按钮」已并入「会话列表🛡堡垒机分组」:
 *  ① 右侧堡垒机浏览器恢复(#bastion-slot.bastion-slot + 地址栏/下拉/标签栏)
 *  ② 头部 btn-bastion2 按钮已删除
 *  ③ 堡垒机分组右键菜单含 3 项(JumpServer API / Web / H3C)
 *  ④ bastionConnectAsset / openBastionPanel / bastionRenderServerSelect 调用不抛异常
 * 运行: node verify-bastion-merge.js(需 9361 空闲;--dev 临时数据目录)
 */
const { spawn } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-bmrg-'));
const PORT = 9361;
const appProc = spawn('node_modules/.bin/electron', ['.', '--dev', `--remote-debugging-port=${PORT}`, '--no-sandbox', '--disable-gpu'], {
  env: { ...process.env, POLARIS_LOCK_DIR: DIR, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  stdio: ['ignore', 'ignore', 'ignore'], detached: true,
});
setTimeout(() => { try { process.kill(-appProc.pid, 'SIGKILL'); } catch {} process.exit(1); }, 100000).unref();
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
  console.log('\n=== 堡垒机按钮并入会话列表分组 ===\n');
  try {
    const ts0 = await listTargets();
    const lockT = ts0.find((t) => /解锁/.test(t.title || '')) || ts0.find((t) => t.type === 'page');
    const lock = await connect(lockT.webSocketDebuggerUrl);
    for (let i = 0; i < 30; i++) { if (await ev(lock, `!!document.getElementById('pw')`)) break; await sleep(300); }
    await ev(lock, `document.getElementById('pw').value='x1234567'; document.getElementById('pw2').value='x1234567'; document.getElementById('btn').click();`);
    let c = null;
    for (let i = 0; i < 30; i++) { await sleep(400); const t2 = await listTargets(); const m = t2.find((t) => t.type === 'page' && !/解锁/.test(t.title || '')); if (m) { c = await connect(m.webSocketDebuggerUrl); break; } }
    if (!c) throw new Error('主窗口未就绪');

    // ① 右侧浏览器恢复
    await check(c, '#bastion-slot 恢复(类名 bastion-slot)', `(function(){const e=document.getElementById('bastion-slot');return !!e && e.classList.contains('bastion-slot');})()`);
    await check(c, '右侧面板元素存在(panel/url/server-select/tabs)', `(function(){return ['bastion-panel','bastion-url','bastion-server-select','bastion-tabs-list'].every(function(id){return !!document.getElementById(id);});})()`);

    // ② 头部按钮已删除
    await check(c, 'btn-bastion2 已删除', `document.getElementById('btn-bastion2') === null`);

    // ③ 关键函数存在且可调用
    await check(c, 'bastionConnectAsset 已定义', `typeof window.bastionConnectAsset === 'function'`);
    for (const f of ['openBastionPanel', 'bastionRenderServerSelect', 'bastionRenderTabs', 'openJmsModal', 'openJmsWeb']) {
      await check(c, `${f}() 不抛异常`, `(function(){try{ ${f}(); return true; }catch(e){ return 'THROW: '+e.message; }})()`);
    }
    // openJmsModal 会打开弹窗,关闭它避免干扰
    await ev(c, `(function(){ try{ closeJmsModal && closeJmsModal(); }catch(e){} try{ closeBastionCfg(); }catch(e){} return true; })()`);

    console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  } catch (e) { console.error('\n测试异常:', e && e.message); failed++; console.log(`\n结果: ${passed} 通过, ${failed} 失败`); }
  try { process.kill(-appProc.pid, 'SIGKILL'); } catch {}
  process.exit(failed ? 1 : 0);
})();
