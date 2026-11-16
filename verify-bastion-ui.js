'use strict';
const { freePort, killTree, guardTimeout, evaluate } = require('./test-helper');
/** verify-bastion-ui.js — 复现:①断开全部堡垒机连接是否漏掉 jms- 会话 ②右侧下拉是否缺左侧连接 */
const { spawn } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-ui-'));
const PORT = 9360;
const appProc = spawn(require('electron'), ['.', '--dev', `--remote-debugging-port=${PORT}`, '--no-sandbox', '--disable-gpu'], {
  env: { ...process.env, POLARIS_LOCK_DIR: DIR, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  stdio: ['ignore', 'ignore', 'ignore'], detached: true,
});
guardTimeout(120000, appProc);
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
// CDP 求值(ReferenceError 自动重试,见 test-helper.evaluate)
async function ev(c, expr) { return evaluate(c, expr); }
let passed = 0, failed = 0;
const ok = (n, d) => { passed++; console.log('  ✓ ' + n + (d ? '  → ' + d : '')); };
const bad = (n, e) => { failed++; console.error('  ✗ ' + n + (e ? '  → ' + e : '')); };

(async () => {
  console.log('\n=== 断开全部堡垒机连接 + 右侧下拉 ===\n');
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

    // ---- 问题①:断开全部堡垒机连接 的匹配逻辑 ----
    await ev(c, `(function(){
      window.__closed = [];
      window.__closeTabOrig = closeTab;
      closeTab = function(sid){ window.__closed.push(String(sid)); };
      state.tabs = new Map([
        ['bastion-1', {session:{id:'bastion-1'}}],
        ['jms-2',     {session:{id:'jms-2'}}],
        ['sess-3',    {session:{id:'sess-3'}}],
      ]);
      disconnectBastionAll();
      return true;
    })()`);
    const closed = await ev(c, `window.__closed.join(',')`);
    if (closed.includes('bastion-1') && closed.includes('jms-2')) ok('断开全部: 覆盖 bastion- 与 jms- 会话', closed);
    else bad('断开全部: 应同时关 bastion- 和 jms-', '实际关闭=' + closed);
    if (!closed.includes('sess-3')) ok('断开全部: 普通会话不受影响'); else bad('断开全部: 普通会话被误关');

    // ---- 问题②:右侧下拉是否含左侧创建的连接 ----
    await ev(c, `(function(){
      state.settings.bastionServers = [
        { id: 'cfg-1', name: '左侧H3C', url: 'https://h3c-bastion.example/shterm', type: 'h3c' },
        { id: 'cfg-2', name: '左侧JMS', url: 'https://jms.a.com', type: 'jms' },
      ];
      state.jmsServers = [
        { id: 'jms-e', name: '空地址服务器', baseUrl: '' },
        { id: 'jms-ok', name: '有地址服务器', baseUrl: 'https://jms.b.com' },
      ];
      state.bastionUrls = [];
      bastionRenderTabs();
      bastionRenderServerSelect();
      return true;
    })()`);
    const ui = await ev(c, `(function(){
      const sel=document.getElementById('bastion-server-select');
      const tabs=document.getElementById('bastion-tabs-list');
      return {
        opts:[...sel.options].map(o=>o.textContent).join('|'),
        groups:[...sel.querySelectorAll('optgroup')].map(g=>g.label).join('|'),
        selectHidden: sel.classList.contains('hidden'),
        tabs: tabs.textContent,
        internal: bastionSelectableServers().map(s=>s.src).join(','),
      };
    })()`);
    ok('下拉内容', ui.opts);
    if (ui.tabs.includes('左侧H3C') && ui.tabs.includes('左侧JMS')) ok('标签栏含左侧两个连接(已保存配置的唯一入口)'); else bad('标签栏缺左侧连接', ui.tabs);
    if (!ui.opts.includes('左侧H3C') && !ui.opts.includes('左侧JMS')) ok('下拉不再重复列出已保存配置(A2 三重选控件冗余已消除)'); else bad('下拉仍重复列出已保存配置', ui.opts);
    if (ui.opts.includes('有地址服务器')) ok('下拉含有地址的 JMS 服务器'); else bad('下拉缺有地址 JMS 服务器', ui.opts);
    if (!ui.opts.includes('空地址服务器')) ok('空地址 JMS 服务器正确排除(无地址无法加载)'); else bad('空地址 JMS 服务器不应出现', ui.opts);
    if (ui.groups.includes('JumpServer')) ok('下拉按来源分组(JumpServer / 已有资产的堡垒机)'); else bad('下拉缺来源分组', ui.groups);
    if (!ui.selectHidden) ok('有额外站点时下拉可见'); else bad('有额外站点时下拉不应隐藏');
    if (ui.internal.includes('cfg') && ui.internal.includes('jms')) ok('内部清单仍含 cfg(双击资产 bastionSelectServer("B:id") 路径不受影响)'); else bad('内部清单缺 cfg', String(ui.internal));

    // 只有已保存配置、无额外站点时 → 下拉整个收起(不再摆一个只有占位项的空下拉)
    const hidden = await ev(c, `(function(){
      state.jmsServers = []; state.bastionUrls = [];
      bastionRenderServerSelect();
      return document.getElementById('bastion-server-select').classList.contains('hidden');
    })()`);
    if (hidden) ok('没有额外站点时下拉自动收起'); else bad('没有额外站点时下拉应隐藏');

    console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  } catch (e) { console.error('\n测试异常:', e && e.message); failed++; console.log(`\n结果: ${passed} 通过, ${failed} 失败`); }
  try { process.kill(-appProc.pid, 'SIGKILL'); } catch {}
  process.exit(failed ? 1 : 0);
})();
