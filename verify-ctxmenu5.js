// 验证"打开网页 SFTP 后能退回主界面"(焦点跟随用户):
//   ① guest ts 新 + 宿主最近点过主界面(任意位置)→ 不抢焦点(可退回)
//   ② guest ts 新 + 宿主没点过 → 抢焦点(webview 里输入正常)
//   ③ 菜单打开时始终不抢(回归)
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');

const OUT = process.env.VERIFY_OUT || os.tmpdir() + '/verify-ctxmenu5-result.txt';
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
  const PORT = 9397;
  const DIR = fs.mkdtempSync(os.tmpdir() + '/polaris-ctxmenu5-');
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
      els.bastionSlot.classList.remove('hidden');
      let focusCalls = 0;
      const orig = wv.focus.bind(wv);
      wv.focus = () => { focusCalls++; };
      let mockTs = 0;
      wv.executeJavaScript = (code) => Promise.resolve(code.includes('__bastionFocusTs') ? mockTs : 0);
      const container = document.createElement('div');
      document.body.appendChild(container);
      const head = makeSectionHead('🛡 测试', false, () => {}, [{ label: 'A', action: () => {} }]);
      container.appendChild(head);

      // 模拟"打开网页 SFTP 后":guest ts 新(1s 前),宿主没点过 → 应抢焦点(webview 输入正常)
      mockTs = Date.now() - 1000;
      window.__hostAnyClickTs = 0;
      window.__hostEditableTs = 0;
      bastionFocusCheck();
      await new Promise((r) => setTimeout(r, 150));
      const focusWhenHostIdle = focusCalls;

      // 用户点主界面任意位置(非输入框,如会话列表空白处)→ 之后不再抢(可退回)
      window.__hostAnyClickTs = Date.now();
      focusCalls = 0;
      bastionFocusCheck();
      await new Promise((r) => setTimeout(r, 150));
      const focusAfterHostClick = focusCalls;

      // 菜单打开时即使 guest ts 新 + 宿主没点过也不抢(回归)
      focusCalls = 0;
      window.__hostAnyClickTs = 0;
      head.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 50, clientY: 50, button: 2 }));
      const menuOpen = !document.getElementById('ctx-menu').classList.contains('hidden');
      bastionFocusCheck();
      await new Promise((r) => setTimeout(r, 150));
      const focusWhileMenu = focusCalls;
      closeCtxMenu('test');

      container.remove();
      wv.focus = orig;
      els.bastionSlot.classList.add('hidden');
      return { focusWhenHostIdle, focusAfterHostClick, menuOpen, focusWhileMenu };
    })()`);

    w('RESULT ' + JSON.stringify(r1));
    log('result: ' + JSON.stringify(r1));

    await sleep(500);
    process.exit(0);
  } catch (e) {
    w('ERROR ' + (e && e.stack || String(e)).slice(0, 700));
    log('error: ' + e);
    process.exit(1);
  } finally {
    killTree(app);
  }
}

main();
