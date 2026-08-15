// 验证:
//   ① bastionFocusCheck 的 3 秒时间窗:guest ts 太久远(>3s) → 不再抢焦点
//   ② guest ts 很新(<3s) → 正常补焦点(功能保留)
//   ③ ✕ 关闭按钮正常隐藏面板
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');

const OUT = process.env.VERIFY_OUT || os.tmpdir() + '/verify-ctxmenu4-result.txt';
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
  const PORT = 9395;
  const DIR = fs.mkdtempSync(os.tmpdir() + '/polaris-ctxmenu4-');
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
      if (typeof bastionFocusCheck !== 'function' || !els.bastionWebview) return { err: '环境缺失' };
      const wv = els.bastionWebview;
      els.bastionSlot.classList.remove('hidden'); // 模拟面板显示
      let focusCalls = 0;
      const orig = wv.focus.bind(wv);
      wv.focus = () => { focusCalls++; };
      wv.executeJavaScript = (code) => Promise.resolve(code.includes('__bastionFocusTs') ? window.__mockTs : 0);
      const container = document.createElement('div');
      document.body.appendChild(container);
      const head = makeSectionHead('🛡 测试', false, () => {}, [{ label: 'A', action: () => {} }]);
      container.appendChild(head);

      // ① guest ts 很旧(60s 前) → 不应抢焦点
      window.__mockTs = Date.now() - 60000;
      bastionFocusCheck();
      await new Promise((r) => setTimeout(r, 150));
      const oldTsFocus = focusCalls;

      // ② guest ts 很新(1s 前) → 应抢焦点(补键盘焦点给 webview)
      window.__mockTs = Date.now() - 1000;
      bastionFocusCheck();
      await new Promise((r) => setTimeout(r, 150));
      const newTsFocus = focusCalls;

      // ③ 菜单打开时即使 ts 新也不抢
      head.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 50, clientY: 50, button: 2 }));
      const menuOpen = !document.getElementById('ctx-menu').classList.contains('hidden');
      bastionFocusCheck();
      await new Promise((r) => setTimeout(r, 150));
      const focusWhileMenu = focusCalls - newTsFocus;
      closeCtxMenu('test');

      // ④ ✕ 关闭按钮:面板显示 → 点击 → hidden
      els.bastionSlot.classList.remove('hidden');
      els.bastionClose.click();
      const panelHiddenAfterClose = els.bastionSlot.classList.contains('hidden');

      container.remove();
      wv.focus = orig;
      els.bastionSlot.classList.add('hidden');
      return { oldTsFocus, newTsFocus, menuOpen, focusWhileMenu, panelHiddenAfterClose };
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
