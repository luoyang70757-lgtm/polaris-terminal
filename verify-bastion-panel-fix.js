'use strict';
// 验证两个修复:
//  ① 堡垒机面板拖到最窄/最宽时 最小化/关闭 按钮都在视口内(flex-wrap + 动态宽度上限)
//  ② 左侧已保存堡垒机连接:右键菜单含「🔌 断开连接」,活动连接徽标 🔗n 显示,断开函数能命中正确会话
const { spawn } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-pfix-'));
const PORT = 9380;
const appProc = spawn('node_modules/.bin/electron', ['.', '--dev', `--remote-debugging-port=${PORT}`, '--no-sandbox', '--disable-gpu'], {
  env: { ...process.env, POLARIS_LOCK_DIR: DIR, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  stdio: ['ignore', 'ignore', 'ignore'], detached: true,
});
setTimeout(() => { try { process.kill(-appProc.pid, 'SIGKILL'); } catch {} process.exit(1); }, 120000).unref();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function listTargets() { for (let i = 0; i < 40; i++) { try { const r = await fetch(`http://127.0.0.1:${PORT}/json`); return await r.json(); } catch {} await sleep(400); } throw new Error('targets 未就绪'); }
function connect(url) { return new Promise((resolve, reject) => { const ws = new WebSocket(url); let id = 0; const pending = new Map(); ws.onopen = () => resolve({ call(m, p = {}) { return new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method: m, params: p })); }); }, close() { ws.close(); } }); ws.onerror = reject; ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } }; }); }
async function ev(c, expr) { const r = await c.call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error('JS异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 300) + ' @ ' + expr.slice(0, 80)); return r.result && r.result.value; }

(async () => {
  console.log('\n=== 验证:面板按钮可见 + 连接断开功能 ===\n');
  let ok = 0, fail = 0;
  const check = (n, v, e) => { if (v === e) { ok++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + ' -> got ' + JSON.stringify(v) + ' want ' + JSON.stringify(e)); } };
  try {
    const ts0 = await listTargets();
    const lockT = ts0.find((t) => /解锁/.test(t.title || '')) || ts0.find((t) => t.type === 'page');
    const lock = await connect(lockT.webSocketDebuggerUrl);
    for (let i = 0; i < 30; i++) { if (await ev(lock, `!!document.getElementById('pw')`)) break; await sleep(300); }
    await ev(lock, `document.getElementById('pw').value='x1234567'; document.getElementById('pw2').value='x1234567'; document.getElementById('btn').click();`);
    let c = null;
    for (let i = 0; i < 30; i++) { await sleep(400); const t2 = await listTargets(); const m = t2.find((t) => t.type === 'page' && !/解锁/.test(t.title || '')); if (m) { c = await connect(m.webSocketDebuggerUrl); break; } }
    if (!c) throw new Error('主窗口未就绪');
    for (let i = 0; i < 30; i++) { if (await ev(c, `typeof renderSessionList === 'function'`)) break; await sleep(300); }

    // ---- ① 面板按钮可见性 + 可拖宽 ----
    await ev(c, `openBastionPanel(); true;`);
    await sleep(300);
    const capW = await ev(c, `bastionMaxWidth()`);
    check('bastionMaxWidth() 有界(≤窗口-会话面板最小宽)', capW <= (await ev(c, `window.innerWidth`)) - 100, true);
    for (const [label, w] of [['最窄(380px)', 380], ['上限宽', capW]]) {
      await ev(c, `els.bastionPanel.style.width = '${w}px'; true;`);
      await sleep(200);
      const v = await ev(c, `(function(){ const mn=document.getElementById('bastion-min').getBoundingClientRect(); const cl=document.getElementById('bastion-close').getBoundingClientRect(); const w=window.innerWidth; return mn.left>=0 && mn.right<=w && cl.left>=0 && cl.right<=w; })()`);
      check(`面板 ${label} 时 最小化/关闭 按钮在视口内`, v, true);
    }
    // 拖分隔条应能调宽(修复后上限宽松,拖拽不被卡死)
    const drag = await ev(c, `(function(){
      els.bastionPanel.style.width = '400px'; true;
      const div = document.getElementById('divider-bastion');
      const r = div.getBoundingClientRect();
      const before = els.bastionPanel.offsetWidth;
      div.dispatchEvent(new MouseEvent('mousedown', { clientX: r.x + 3, clientY: r.y + 10, bubbles: true }));
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: r.x + 3 - 120, clientY: r.y + 10 }));
      window.dispatchEvent(new MouseEvent('mouseup', { clientX: r.x + 3 - 120, clientY: r.y + 10 }));
      return { before, after: els.bastionPanel.offsetWidth };
    })()`);
    console.log('  拖拽结果:', JSON.stringify(drag));
    check('拖分隔条可将面板调宽', drag.after > drag.before, true);

    // ---- ② 断开连接功能 ----
    await ev(c, `(function(){
      state.settings.bastionServers = [{ id: 's-h3c', name: 'H3C测试', url: 'https://10.204.240.4/shterm/', type: 'h3c' }];
      state.collapsedTopBastion = false; state.collapsedBastionSaved = false;
      // 伪造一个该连接发起的会话(带 closeTab 需要的 DOM 元素)
      const fe = { remove(){} };
      state.tabs.set('sess-99', { session: { id: 'jms-1', jmsKey: 'saved-s-h3c|10.1.1.1|root' }, status: 'connected', el: fe, paneEl: fe, term: { dispose(){} }, userClosed: false });
      renderSessionList(els.inputSessionSearch.value);
      return true;
    })()`);
    await sleep(300);
    const menuItems = await ev(c, `(function(){
      const captured = [];
      const orig = window.showCtxMenu;
      window.showCtxMenu = function(x, y, items){ captured.push(items.map(i => i.label)); };
      const row = document.querySelector('#session-tree .bastion-saved-item');
      const evt = new Event('contextmenu'); evt.preventDefault = function(){};
      row.dispatchEvent(evt);
      window.showCtxMenu = orig;
      return JSON.stringify(captured[0] || []);
    })()`);
    console.log('  右键菜单:', menuItems);
    check('菜单含「🔌 断开连接」', JSON.parse(menuItems).some((l) => l.includes('断开连接')), true);

    const badgeTxt = await ev(c, `(document.querySelector('#session-tree .bastion-saved-badge')||{}).textContent`);
    console.log('  徽标:', badgeTxt);
    check('活动连接徽标显示 🔗1', (badgeTxt || '').includes('🔗1'), true);

    // 实际断开:调用 disconnectBastionSavedConn,会话应被移除
    const after = await ev(c, `(function(){ disconnectBastionSavedConn({ id: 's-h3c', name: 'H3C测试' }); return !state.tabs.has('sess-99'); })()`);
    check('disconnectBastionSavedConn 关掉该连接会话', after, true);

  } catch (e) { console.error('异常:', e.message); fail++; }
  try { process.kill(-appProc.pid, 'SIGKILL'); } catch {}
  console.log(`\n结果: ${ok} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
