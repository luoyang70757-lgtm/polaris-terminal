// 验证:makeSectionHead 传空菜单数组时,右键分组头不再弹出空白菜单
// 同时验证带菜单项的头右键仍正常弹菜单
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');

const OUT = process.env.VERIFY_OUT || os.tmpdir() + '/verify-ctxmenu-result.txt';
const w = (s) => fs.appendFileSync(OUT, s + '\n');
const log = (s) => { try { console.log(s); } catch {} };

function freePort(p) { try { execSync(`lsof -ti tcp:${p} | xargs kill -9 2>/dev/null`); } catch {} }
function killTree(proc) { try { if (proc && proc.pid) process.kill(-proc.pid, 'SIGKILL'); } catch {} }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function targets(PORT) {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json`);
      const j = await r.json();
      const p = j.find((t) => t.type === 'page' && /解锁|Polaris/.test(t.title || ''));
      if (p) return j;
    } catch { /* not ready */ }
    await sleep(400);
  }
  throw new Error('CDP targets 未就绪');
}
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0; const pending = new Map();
    ws.onopen = () => resolve({
      call(m, p = {}) { return new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method: m, params: p })); }); },
      close() { ws.close(); },
    });
    ws.onerror = (e) => reject(e);
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };
  });
}
async function ev(c, expr) {
  const r = await c.call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('JS异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 600) + ' @ ' + expr.slice(0, 120));
  return r.result && r.result.value;
}

async function main() {
  fs.writeFileSync(OUT, '');
  const PORT = 9392;
  const DIR = fs.mkdtempSync(os.tmpdir() + '/polaris-ctxmenu-');
  freePort(PORT);
  const app = spawn('node_modules/.bin/electron', ['.', '--dev', `--remote-debugging-port=${PORT}`, '--no-sandbox', '--disable-gpu'], {
    env: { ...process.env, POLARIS_LOCK_DIR: DIR, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
    stdio: 'ignore', detached: true,
  });
  setTimeout(() => killTree(app), 150000);

  try {
    const ts = await targets(PORT);
    const lock = await connect(ts.find((t) => /解锁/.test(t.title || '')).webSocketDebuggerUrl);
    for (let i = 0; i < 30; i++) { if (await ev(lock, `!!document.getElementById('pw')`)) break; await sleep(300); }
    await sleep(300);
    await ev(lock, `document.getElementById('pw').value='x12345678'; document.getElementById('pw2').value='x12345678'; document.getElementById('btn').click();`);
    let c = null;
    for (let i = 0; i < 30; i++) {
      await sleep(500);
      const t2 = await targets(PORT);
      const m = t2.find((t) => t.type === 'page' && !/解锁/.test(t.title || ''));
      if (m) { c = await connect(m.webSocketDebuggerUrl); break; }
    }
    if (!c) throw new Error('解锁后主窗口未出现');

    const r1 = await ev(c, `(() => {
      if (typeof makeSectionHead !== 'function') return { err: 'makeSectionHead missing' };
      const container = document.createElement('div');
      let toggled = 0;
      // ① 空菜单数组的分组头:右键不应弹菜单(ctx-menu 保持 hidden)
      const head = makeSectionHead('🗂 测试分组(0)', false, () => { toggled++; }, []);
      container.appendChild(head);
      document.body.appendChild(container);
      const ev1 = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 100, clientY: 100, button: 2 });
      head.dispatchEvent(ev1);
      const emptyHeadKeepsHidden = document.getElementById('ctx-menu').classList.contains('hidden');
      // ② 带菜单项的头:右键应正常弹菜单(ctx-menu 显示,含该项文字)
      let opened = 0;
      const head2 = makeSectionHead('🛡 测试服务器(1)', false, () => {}, [
        { label: '🔄 刷新资产', action: () => { opened++; } },
      ]);
      container.appendChild(head2);
      const ev2 = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 200, clientY: 200, button: 2 });
      head2.dispatchEvent(ev2);
      const withItemsOpens = !document.getElementById('ctx-menu').classList.contains('hidden');
      const menuText = document.getElementById('ctx-menu').textContent;
      container.remove();
      return { emptyHeadKeepsHidden, withItemsOpens, menuText };
    })()`);

    w('RESULT ' + JSON.stringify(r1));
    log('result: ' + JSON.stringify(r1));

    await sleep(500);
    process.exit(0);
  } catch (e) {
    w('ERROR ' + (e && e.stack || String(e)).slice(0, 600));
    log('error: ' + e);
    process.exit(1);
  } finally {
    killTree(app);
  }
}

main();
