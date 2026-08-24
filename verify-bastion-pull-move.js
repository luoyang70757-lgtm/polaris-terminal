'use strict';
// 验证:浏览器面板已无「🔄 拉取资产」按钮;左侧已保存堡垒机连接右键菜单含「🔄 拉取资产」。
const { spawn } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-pull-'));
const PORT = 9378;
const appProc = spawn('node_modules/.bin/electron', ['.', '--dev', `--remote-debugging-port=${PORT}`, '--no-sandbox', '--disable-gpu'], {
  env: { ...process.env, POLARIS_LOCK_DIR: DIR, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  stdio: ['ignore', 'ignore', 'ignore'], detached: true,
});
setTimeout(() => { try { process.kill(-appProc.pid, 'SIGKILL'); } catch {} process.exit(1); }, 90000).unref();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function listTargets() { for (let i = 0; i < 40; i++) { try { const r = await fetch(`http://127.0.0.1:${PORT}/json`); return await r.json(); } catch {} await sleep(400); } throw new Error('targets 未就绪'); }
function connect(url) { return new Promise((resolve, reject) => { const ws = new WebSocket(url); let id = 0; const pending = new Map(); ws.onopen = () => resolve({ call(m, p = {}) { return new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method: m, params: p })); }); }, close() { ws.close(); } }); ws.onerror = reject; ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } }; }); }
async function ev(c, expr) { const r = await c.call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error('JS异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 300) + ' @ ' + expr.slice(0, 80)); return r.result && r.result.value; }

(async () => {
  console.log('\n=== 验证:拉取资产按钮移入左侧连接 ===\n');
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

    // ① 浏览器面板按钮已删除
    const hasPull = await ev(c, `!!document.getElementById('bastion-pull')`);
    check('浏览器面板无 #bastion-pull 按钮', hasPull, false);

    // ② 加一个已保存 H3C 连接 + 一个 JMS 连接,渲染左列表,检查右键菜单
    const r = await ev(c, `
      (function(){
        state.settings.bastionServers = [
          { id: 's-h3c', name: 'H3C测试', url: 'https://10.204.240.4/shterm/', type: 'h3c', account: '', password: '' },
          { id: 's-jms', name: 'JMS测试', url: 'http://192.168.1.250', type: 'jms', account: 'admin', password: '' },
        ];
        state.collapsedTopBastion = false; state.collapsedBastionSaved = false;
        renderSessionList(els.inputSessionSearch.value);
        const rows = Array.from(document.querySelectorAll('#session-tree .bastion-saved-item'));
        return rows.length;
      })()
    `);
    check('已保存连接渲染 2 行', r, 2);

    // 模拟右键一个连接,构造菜单,检查是否含「拉取资产」
    const menuCheck = await ev(c, `
      (function(){
        // 复用 renderBastionSavedSessions 里的菜单逻辑(直接调 showCtxMenu 的入参不方便,改测函数返回)
        // 这里手动模拟:构造两个连接的 contextmenu,捕获 showCtxMenu 的入参
        const captured = [];
        const orig = window.showCtxMenu;
        window.showCtxMenu = function(x, y, items){ captured.push(items.map(i => i.label)); };
        const rows = Array.from(document.querySelectorAll('#session-tree .bastion-saved-item'));
        const evt = new Event('contextmenu'); evt.preventDefault = function(){};
        rows[0].dispatchEvent(evt);
        rows[1].dispatchEvent(evt);
        window.showCtxMenu = orig;
        return JSON.stringify(captured);
      })()
    `);
    console.log('右键菜单捕获:', menuCheck);
    const menus = JSON.parse(menuCheck);
    check('H3C 连接菜单含「🔄 拉取资产」', (menus[0] || []).some((l) => l.includes('拉取资产')), true);
    check('JMS 连接菜单含「🔄 拉取资产」', (menus[1] || []).some((l) => l.includes('拉取资产')), true);
    check('H3C 连接菜单不含「刷新资产」', (menus[0] || []).some((l) => l.includes('刷新资产')), false);

  } catch (e) { console.error('异常:', e.message); fail++; }
  try { process.kill(-appProc.pid, 'SIGKILL'); } catch {}
  console.log(`\n结果: ${ok} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
