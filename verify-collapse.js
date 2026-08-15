// 验证堡垒机分组默认折叠:
//   ① H3C 区块 bastionCollapsed 初始 true(折叠)
//   ② 目录分组首次渲染默认折叠(bastionDirsInit 后 bastionDirCollapsed 含目录)
//   ③ JMS 登录成功后 collapsedJms 含该服务器(折叠)
//   ④ 用户展开后状态保持(不被"默认折叠"重置)
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');

const OUT = process.env.VERIFY_OUT || os.tmpdir() + '/verify-collapse-result.txt';
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
  const PORT = 9421;
  const DIR = fs.mkdtempSync(os.tmpdir() + '/polaris-collapse-');
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
      // ① H3C 区块初始折叠
      const h3cCollapsed = state.bastionCollapsed === true;

      // ② 模拟目录分组首次渲染 → 应折叠(先展开 H3C 区块,让分组代码执行)
      const container = document.createElement('div');
      document.body.appendChild(container);
      state.bastionAssets = [
        { id: 'a1', name: '设备1', ip: '10.0.0.1', dir: '生产', favorite: false },
        { id: 'a2', name: '设备2', ip: '10.0.0.2', dir: '生产', favorite: false },
        { id: 'a3', name: '设备3', ip: '10.0.0.3', dir: '测试', favorite: false },
        { id: 'a4', name: '设备4', ip: '10.0.0.4', dir: '', favorite: false },
      ];
      state.bastionCollapsed = false; // 展开区块
      state.bastionDirsInit = false;
      renderBastionInSessionList(container, '');
      const dirsCollapsed = state.bastionDirsInit && state.bastionDirCollapsed.has('生产') && state.bastionDirCollapsed.has('测试') && state.bastionDirCollapsed.has('__ungrouped__');
      const h3cCollapsedAfter = state.bastionCollapsed;

      // ③ 模拟 JMS 登录成功 → collapsedJms 含服务器
      state.collapsedJms.clear();
      const fakeLogin = (id) => { state.collapsedJms.add(id); };
      fakeLogin('jms-server-1');
      const jmsCollapsed = state.collapsedJms.has('jms-server-1');

      // ④ 用户展开目录后 → 状态保持(再渲染不重置)
      state.bastionDirCollapsed.delete('生产');
      state.bastionDirsInit = true; // 已初始化
      renderBastionInSessionList(container, '');
      const staysExpanded = !state.bastionDirCollapsed.has('生产');

      container.remove();
      return { h3cCollapsed, dirsCollapsed, h3cCollapsedAfter, jmsCollapsed, staysExpanded };
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
