'use strict';
/**
 * verify-bastion-server-sync.js — 左侧创建/编辑/删除 JMS 服务器后，右侧堡垒机下拉必须同步(回归)
 *
 * 用户症状:右侧堡垒机获取不到左侧创建的堡垒机连接信息。
 * 根因:jmsAddServer 新建时 baseUrl 为空，右侧下拉会过滤掉；jmsDoSave/jmsDoLogin/
 *       jmsDeleteServerCompletely 只刷新左侧 JMS 弹窗下拉，没调用 bastionRenderServerSelect()
 *       → 右侧下拉一直停留在旧列表。
 * 修法:JMS 保存/登录/MFA/删除后统一刷新右侧下拉，保存后同时重绘左侧会话列表。
 *
 * 断言:
 *   ① 左侧保存新 JMS 服务器后，右侧下拉出现 JMS:<id> 且名称正确；
 *   ② 左侧改名保存后，右侧下拉名称跟着变；
 *   ③ 左侧彻底删除后，右侧下拉不再有该服务器；
 *   ④ 保存后左侧会话列表也出现该服务器(不再等下一次偶然重绘)。
 *
 * 运行:node verify-bastion-server-sync.js(需 9493 空闲)
 */
const { spawn } = require('child_process');
const { freePort, killTree, guardTimeout } = require('./test-helper');
const fs = require('fs'); const os = require('os'); const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-bsync-'));
const PORT = 9493;
freePort(PORT);
const appProc = spawn('node_modules/.bin/electron', ['.', '--dev', `--remote-debugging-port=${PORT}`, '--no-sandbox', '--disable-gpu'], {
  env: { ...process.env, POLARIS_LOCK_DIR: DIR, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  stdio: ['ignore', 'ignore', 'ignore'], detached: true,
});
guardTimeout(150000, appProc);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function targets() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json`, { signal: AbortSignal.timeout(3000) });
      const j = await r.json();
      if (j.find((t) => t.type === 'page' && /解锁|Polaris/.test(t.title || ''))) return j;
    } catch { /* not ready */ }
    await sleep(400);
  }
  throw new Error('targets 未就绪');
}
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url); let id = 0; const pending = new Map();
    ws.onopen = () => resolve({ call(m, p = {}) { return new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method: m, params: p })); }); }, close() { ws.close(); } });
    ws.onerror = reject;
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };
  });
}
async function ev(c, expr) {
  const r = await c.call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('JS异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 400) + ' @ ' + expr.slice(0, 100));
  return r.result && r.result.value;
}
let passed = 0, failed = 0;
const ok = (n) => { passed++; console.log('  ✓ ' + n); };
const bad = (n, e) => { failed++; console.error('  ✗ ' + n + (e ? ' → ' + e : '')); };

(async () => {
  console.log('\n=== 左侧 JMS 连接 → 右侧堡垒机下拉同步 ===\n');
  try {
    const lockT = (await targets()).find((t) => /解锁/.test(t.title || ''));
    const lock = await connect(lockT.webSocketDebuggerUrl);
    for (let i = 0; i < 40; i++) { if (await ev(lock, `!!document.getElementById('pw')`)) break; await sleep(300); }
    await sleep(300);
    await ev(lock, `document.getElementById('pw').value='x1234567'; document.getElementById('pw2').value='x1234567'; document.getElementById('btn').click();`);
    let c = null;
    for (let i = 0; i < 40; i++) {
      await sleep(400);
      const t2 = await targets();
      const m = t2.find((t) => t.type === 'page' && !/解锁/.test(t.title || ''));
      if (m) { c = await connect(m.webSocketDebuggerUrl); break; }
    }
    if (!c) throw new Error('解锁后主窗口未出现');
    for (let i = 0; i < 50; i++) { if (await ev(c, `typeof state === 'object' && !!state.settings`)) break; await sleep(200); }

    // 模拟右侧面板已打开（旧版此时下拉已渲染过一次，之后左侧新建不会刷新）
    await ev(c, `openBastionPanel(); true`);
    await sleep(300);

    // ① 左侧新建并保存 JMS 服务器
    const r1 = await ev(c, `(function(){
      jmsAddServer();                       // 新服务器 baseUrl 为空，右侧下拉会过滤掉
      state.collapsedTopBastion = false;    // 展开顶级分组，才能断言左侧列表行
      const id = state.jmsActiveId;
      els.jmsName.value = '左侧新建JMS';
      els.jmsUrl.value = 'http://10.0.0.10';
      els.jmsUser.value = 'admin';
      els.jmsPass.value = 'pw123456';
      jmsDoSave();
      const opts = [...els.bastionServerSelect.options].map((o) => ({ v: o.value, t: o.textContent }));
      const leftHit = [...document.querySelectorAll('.asset-group-name')].some((n) => n.textContent.includes('左侧新建JMS'));
      return { id, opts, leftHit, servers: state.jmsServers.map((s) => ({ id: s.id, name: s.name, baseUrl: s.baseUrl })) };
    })()`);
    const opt1 = r1.opts.find((o) => o.v === 'JMS:' + r1.id);
    if (opt1 && /左侧新建JMS/.test(opt1.t)) ok('保存后右侧下拉出现左侧 JMS 连接');
    else bad('右侧下拉未同步新 JMS 连接', JSON.stringify(r1));
    if (r1.leftHit) ok('保存后左侧会话列表也出现该服务器');
    else bad('左侧会话列表未重绘', JSON.stringify(r1));

    // ② 改名保存 → 右侧下拉名称同步
    const r2 = await ev(c, `(function(){
      state.jmsActiveId = ${JSON.stringify(r1.id)};
      els.jmsName.value = '左侧改名JMS';
      jmsDoSave();
      const o = [...els.bastionServerSelect.options].find((x) => x.value === 'JMS:${r1.id}');
      return { text: o ? o.textContent : null };
    })()`);
    if (r2.text && /左侧改名JMS/.test(r2.text)) ok('改名保存后右侧下拉名称同步');
    else bad('改名后右侧下拉未更新', JSON.stringify(r2));

    // ③ 彻底删除 → 右侧下拉移除
    const r3 = await ev(c, `(function(){
      const old = window.confirm; window.confirm = () => true;
      jmsDeleteServerCompletely(${JSON.stringify(r1.id)});
      window.confirm = old;
      return { opts: [...els.bastionServerSelect.options].map((o) => o.value) };
    })()`);
    if (!r3.opts.includes('JMS:' + r1.id)) ok('删除后右侧下拉同步移除');
    else bad('删除后右侧下拉仍残留', JSON.stringify(r3));

    console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  } catch (e) {
    console.error('\n测试异常:', e && e.message);
    failed++;
  }
  try { killTree(appProc); } catch { /* ignore */ }
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(failed ? 1 : 0);
})();
