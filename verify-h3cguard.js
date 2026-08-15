// 验证:堡垒机资产轮询只在 H3C(/shterm)站点运行,连接 JMS 后不再频繁刷新
//   ① webview = JMS 站点(http://192.168.1.250/ui/) → pollBastionAssets 提前返回,不执行 executeJavaScript
//   ② webview = H3C 站点(https://10.204.240.4/shterm/login) → pollBastionAssets 正常执行
//   ③ triggerBastionFullFetch 对 JMS 站点也提前返回(不拉取、不改状态栏)
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');

const OUT = process.env.VERIFY_OUT || os.tmpdir() + '/verify-h3cguard-result.txt';
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
  const PORT = 9406;
  const DIR = fs.mkdtempSync(os.tmpdir() + '/polaris-h3cguard-');
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
      if (typeof pollBastionAssets !== 'function') return { err: '函数缺失' };
      const wv = els.bastionWebview;
      els.bastionSlot.classList.remove('hidden'); // 面板显示,让轮询能走到守卫
      let execCalls = 0;
      const origExec = wv.executeJavaScript.bind(wv);
      wv.executeJavaScript = (code) => { execCalls++; return Promise.resolve({}); };
      const origGetURL = wv.getURL ? wv.getURL.bind(wv) : null;
      let mockUrl = '';
      if (origGetURL) wv.getURL = () => mockUrl;

      // ① JMS 站点 → poll 提前返回(execCalls 应 0)
      mockUrl = 'http://192.168.1.250/ui/';
      execCalls = 0;
      pollBastionAssets();
      await new Promise((r) => setTimeout(r, 100));
      const jmsPollExec = execCalls;
      const jmsAllFetched = state.bastionAllFetched;

      // ② H3C 站点 → poll 正常执行(execCalls 应 1)
      mockUrl = 'https://10.204.240.4/shterm/login';
      execCalls = 0;
      state.bastionAllFetched = false;
      pollBastionAssets();
      await new Promise((r) => setTimeout(r, 100));
      const h3cPollExec = execCalls;

      // ③ triggerBastionFullFetch 对 JMS 提前返回
      mockUrl = 'http://192.168.1.250/ui/';
      execCalls = 0;
      const stBefore = document.querySelector('.status-bar') ? document.querySelector('.status-bar').textContent : '';
      triggerBastionFullFetch();
      await new Promise((r) => setTimeout(r, 100));
      const jmsFetchExec = execCalls;
      const stAfter = document.querySelector('.status-bar') ? document.querySelector('.status-bar').textContent : '';

      if (origGetURL) wv.getURL = origGetURL;
      wv.executeJavaScript = origExec;
      els.bastionSlot.classList.add('hidden');
      return { jmsPollExec, jmsAllFetched, h3cPollExec, jmsFetchExec, statusChanged: stBefore !== stAfter };
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
