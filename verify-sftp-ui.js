// 验证四项改动:
//   ① SFTP 打开默认定位家目录(realpath 解析)
//   ② 连接主机信息下方第二行显示完整路径(sftp-path-row 存在且 sftp-path 在其中)
//   ③ boot 过场只剩边框(boot-ring 存在,boot-rain/boot-line 已移除)
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');

const OUT = process.env.VERIFY_OUT || os.tmpdir() + '/verify-sftp-ui-result.txt';
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
  const PORT = 9413, SSH = 2236, HTTP = 8136;
  const DIR = fs.mkdtempSync(os.tmpdir() + '/polaris-sftpui-');
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

    // ③ boot 过场结构(HTML 静态检查)
    const r3 = await ev(c, `({
      hasRing: !!document.getElementById('boot-ring'),
      hasRain: !!document.getElementById('boot-rain'),
      hasLine: !!document.getElementById('boot-line'),
      hasScan: !!document.querySelector('.boot-scan'),
      hasLogo: !!document.querySelector('.boot-logo'),
    })`);

    // 连接 mock
    await ev(c, `window.api.createSession({ name: 'UI-A', host: '127.0.0.1', port: ${SSH}, username: 'admin', password: 'admin123' })`);
    await ev(c, `state.settings.verifyHostKey = false; saveSettings()`);
    await ev(c, `loadSessions()`); await sleep(500);
    await ev(c, `state.collapsedGroups.clear(); renderSessionList('')`);
    await ev(c, `[...document.querySelectorAll('.asset-item')].find((x) => x.textContent.includes('UI-A')).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
    let connected = false;
    for (let i = 0; i < 40; i++) {
      connected = await ev(c, `[...state.tabs.values()].some((t) => t.status === 'connected')`);
      if (connected) break;
      await sleep(400);
    }
    if (!connected) throw new Error('连接未建立');
    const sid = await ev(c, `[...state.tabs.values()][0].sessionId`);

    // ① 打开 SFTP(没 cd 过)→ 默认家目录(路径栏显示 realpath 绝对路径)
    const r1 = await ev(c, `(async () => {
      const t = state.tabs.get('${sid}');
      activateTab(t.sessionId);
      toggleSftpPanel();
      await new Promise((r) => setTimeout(r, 1000));
      return {
        sftpPath: state.sftp.path,
        pathIsAbs: String(state.sftp.path).startsWith('/'),
        connText: document.getElementById('sftp-conn').textContent,
      };
    })()`);

    // ② 路径在连接信息下方第二行
    const r2 = await ev(c, `({
      pathInSecondRow: !!document.querySelector('.sftp-path-row #sftp-path'),
      connInFirstRow: !!document.querySelector('.sftp-toolbar-main #sftp-conn'),
      pathRowExists: !!document.querySelector('.sftp-path-row'),
      pathLabel: document.querySelector('.sftp-path-label') ? document.querySelector('.sftp-path-label').textContent : '',
      connAbovePath: (() => {
        const conn = document.getElementById('sftp-conn');
        const path = document.getElementById('sftp-path');
        if (!conn || !path) return false;
        return conn.getBoundingClientRect().bottom <= path.getBoundingClientRect().top;
      })(),
    })`);

    w('RESULT ' + JSON.stringify({ r1, r2, r3 }));
    log('result: ' + JSON.stringify({ r1, r2, r3 }));

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
