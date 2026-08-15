// 验证:SFTP 打开路径跟随终端当前目录(cd 跟踪)
//   ① 连接后 shellCwd 初始 null → 打开 SFTP 用默认(登录目录)
//   ② 终端 cd /tmp 后 → shellCwd=/tmp → 打开 SFTP 定位到 /tmp
//   ③ cd .. 相对路径解析正确
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');

const OUT = process.env.VERIFY_OUT || os.tmpdir() + '/verify-cwd-result.txt';
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
  const PORT = 9412, SSH = 2235, HTTP = 8135;
  const DIR = fs.mkdtempSync(os.tmpdir() + '/polaris-cwd-');
  freePort(PORT); freePort(SSH); freePort(HTTP);
  const app = spawn('node_modules/.bin/electron', ['.', '--dev', `--remote-debugging-port=${PORT}`, '--no-sandbox', '--disable-gpu'], {
    env: { ...process.env, POLARIS_LOCK_DIR: DIR, MOCK_SSH_PORT: String(SSH), MOCK_HTTP_PORT: String(HTTP), ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
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

    // 连接 mock
    await ev(c, `window.api.createSession({ name: 'CWD-A', host: '127.0.0.1', port: ${SSH}, username: 'admin', password: 'admin123' })`);
    await ev(c, `state.settings.verifyHostKey = false; saveSettings()`);
    await ev(c, `loadSessions()`); await sleep(500);
    await ev(c, `state.collapsedGroups.clear(); renderSessionList('')`);
    await ev(c, `[...document.querySelectorAll('.asset-item')].find((x) => x.textContent.includes('CWD-A')).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
    let connected = false;
    for (let i = 0; i < 40; i++) {
      connected = await ev(c, `[...state.tabs.values()].some((t) => t.status === 'connected')`);
      if (connected) break;
      await sleep(400);
    }
    if (!connected) throw new Error('连接未建立');
    const sid = await ev(c, `[...state.tabs.values()][0].sessionId`);

    // ① 连接后 shellCwd 应为 null(还没开 SFTP/cd)
    const r0 = await ev(c, `({ shellCwd: state.tabs.get('${sid}').shellCwd })`);

    // ② 模拟 cd /tmp(走 trackShellCwd)
    const r1 = await ev(c, `(async () => {
      const t = state.tabs.get('${sid}');
      trackShellCwd(t, 'cd /tmp');
      const afterCd = t.shellCwd;
      // 打开 SFTP → 应定位到 /tmp
      activateTab(t.sessionId);
      toggleSftpPanel();
      await new Promise((r) => setTimeout(r, 900));
      return { afterCd, sftpPath: state.sftp.path, entries: state.sftp.entries.length };
    })()`);

    // ③ cd .. 相对解析
    const r2 = await ev(c, `(async () => {
      const t = state.tabs.get('${sid}');
      trackShellCwd(t, 'cd ..');
      const afterUp = t.shellCwd;
      toggleSftpPanel(); // 关
      await new Promise((r) => setTimeout(r, 300));
      toggleSftpPanel(); // 再开 → 应定位 / 
      await new Promise((r) => setTimeout(r, 900));
      return { afterUp, sftpPath2: state.sftp.path };
    })()`);

    w('RESULT ' + JSON.stringify({ r0, r1, r2 }));
    log('result: ' + JSON.stringify({ r0, r1, r2 }));

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
