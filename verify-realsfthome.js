// 真实堡垒机 e2e:连接 → 打开 SFTP → 验证路径栏/上传路径 = 家目录探测结果(/tmp)
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');

const OUT = process.env.VERIFY_OUT || os.tmpdir() + '/verify-realsfthome-result.txt';
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
  const PORT = 9417;
  const DIR = fs.mkdtempSync(os.tmpdir() + '/polaris-realsfthome-');
  freePort(PORT);
  const app = spawn('node_modules/.bin/electron', ['.', '--dev', `--remote-debugging-port=${PORT}`, '--no-sandbox', '--disable-gpu'], {
    env: { ...process.env, POLARIS_LOCK_DIR: DIR, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
    stdio: 'ignore', detached: true,
  });
  setTimeout(() => killTree(app), 180000);

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

    // 直连真实堡垒机
    await ev(c, `(async () => {
      const res = await window.api.sshConnect('sess-realhome', {
        host: '192.168.1.250', port: 2222, username: 'admin@ssh@root@192.168.1.254',
        password: '${process.env.JMS_PASS || 'Shouhuzhe@2018'}', cols: 80, rows: 24,
        verifyHostKey: false, autoTrustHostKey: true, sessionName: '真实家目录测试',
      });
      return res;
    })()`);
    await sleep(1500);

    // ① sftp:home 探测结果
    const r0 = await ev(c, `window.api.sftpHome('sess-realhome')`);

    // ② 造 tab 并打开 SFTP → 看 path(不经过 activateTab 的 DOM 依赖)
    const r1 = await ev(c, `(async () => {
      const t = { sessionId: 'sess-realhome', session: { name: '真实家目录测试', host: '192.168.1.250', port: 2222, username: 'admin@ssh@root@192.168.1.254' }, status: 'connected', sftpPath: '.', shellCwd: null };
      state.tabs.set('sess-realhome', t);
      state.activeSessionId = 'sess-realhome';
      state.sftp.sessionId = null; // 强制走 sftpSession() 的 activeSessionId 分支
      toggleSftpPanel();
      await new Promise((r) => setTimeout(r, 2000));
      return {
        sftpPath: state.sftp.path,
        pathBar: document.getElementById('sftp-path').textContent,
        pathSegs: [...document.querySelectorAll('#sftp-path .sftp-path-seg')].map((s) => s.textContent),
        entries: state.sftp.entries.length,
        connText: document.getElementById('sftp-conn').textContent,
      };
    })()`);

    w('RESULT ' + JSON.stringify({ r0, r1 }));
    log('result: ' + JSON.stringify({ r0, r1 }));

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
