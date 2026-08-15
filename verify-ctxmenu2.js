// 验证菜单残留 click 防抖:
//   ① 右键弹菜单后 <250ms 内 click 落在菜单项上 → 忽略(不执行动作、菜单不关)
//   ② >250ms 后 click 菜单项 → 执行动作 + 关闭
//   ③ 空菜单数组分组头右键不弹菜单(回归)
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');

const OUT = process.env.VERIFY_OUT || os.tmpdir() + '/verify-ctxmenu2-result.txt';
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
  const PORT = 9393;
  const DIR = fs.mkdtempSync(os.tmpdir() + '/polaris-ctxmenu2-');
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

    const r1 = await ev(c, `(async () => {
      if (typeof makeSectionHead !== 'function') return { err: 'makeSectionHead missing' };
      const container = document.createElement('div');
      document.body.appendChild(container);
      const sleep2 = (ms) => new Promise((r) => setTimeout(r, ms));

      // ③ 回归:空菜单头右键不弹
      const head0 = makeSectionHead('🗂 空分组(0)', false, () => {}, []);
      container.appendChild(head0);
      head0.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10, button: 2 }));
      const emptyKeepsHidden = document.getElementById('ctx-menu').classList.contains('hidden');

      // 造一个带菜单项的头,右键弹出(用真实 showCtxMenu 路径)
      let actCount = 0;
      const head = makeSectionHead('🛡 测试服务器(1)', false, () => {}, [
        { label: '🔄 刷新资产', action: () => { actCount++; } },
      ]);
      container.appendChild(head);
      head.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 120, clientY: 120, button: 2 }));
      const openedNow = !document.getElementById('ctx-menu').classList.contains('hidden');
      const firstItem = document.querySelector('#ctx-menu .ctx-item');
      const tOpen = Date.now();

      // ① 立即(残留 click)点菜单项:<250ms → 应忽略
      firstItem.click();
      const ignoredFast = (actCount === 0) && !document.getElementById('ctx-menu').classList.contains('hidden');

      // ② 等 300ms 再点 → 应执行 + 关闭
      await sleep2(300);
      firstItem.click();
      const actedLate = (actCount === 1) && document.getElementById('ctx-menu').classList.contains('hidden');

      container.remove();
      return { emptyKeepsHidden, openedNow, ignoredFast, actedLate };
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
