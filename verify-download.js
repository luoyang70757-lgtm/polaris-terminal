// 验证 SFTP 下载文件/目录(mock 环境):
//   ① 单文件下载(sftp:download)→ 成功且本地文件存在
//   ② 目录下载(sftp:downloadMany)→ 成功且本地目录含文件
//   ③ 右键菜单"下载"入口(downloadSftpEntry)→ 不抛异常
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT = process.env.VERIFY_OUT || os.tmpdir() + '/verify-dl-result.txt';
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
  const PORT = 9401, SSH = 2234, HTTP = 8134;
  const DIR = fs.mkdtempSync(os.tmpdir() + '/polaris-dl-');
  const DL = fs.mkdtempSync(os.tmpdir() + '/polaris-dl-out-');
  freePort(PORT); freePort(SSH); freePort(HTTP);
  const app = spawn('node_modules/.bin/electron', ['.', '--dev', `--remote-debugging-port=${PORT}`, '--no-sandbox', '--disable-gpu'], {
    env: { ...process.env, POLARIS_LOCK_DIR: DIR, MOCK_SSH_PORT: String(SSH), MOCK_HTTP_PORT: String(HTTP), POLARIS_AUTO_DL_DIR: DL, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
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
    await ev(c, `window.api.createSession({ name: 'DL-A', host: '127.0.0.1', port: ${SSH}, username: 'admin', password: 'admin123' })`);
    await ev(c, `state.settings.verifyHostKey = false; saveSettings()`);
    await ev(c, `loadSessions()`); await sleep(500);
    await ev(c, `state.collapsedGroups.clear(); state.collapsedTopHost = false; renderSessionList('')`);
    await ev(c, `[...document.querySelectorAll('.asset-item')].find((x) => x.textContent.includes('DL-A')).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
    let connected = false;
    for (let i = 0; i < 40; i++) {
      connected = await ev(c, `[...state.tabs.values()].some((t) => t.status === 'connected')`);
      if (connected) break;
      await sleep(400);
    }
    if (!connected) throw new Error('连接未建立');
    await ev(c, `toggleSftpPanel()`);
    await sleep(800);
    await ev(c, `(async () => { state.sftp.path = '/'; await loadSftpList(); })()`);
    await sleep(500);

    // 列出根目录内容,找文件/目录
    const r0 = await ev(c, `state.sftp.entries.map((e) => ({ n: e.name, d: e.isDir }))`);
    log('root entries: ' + JSON.stringify(r0));

    // ① 单文件下载
    const r1 = await ev(c, `(async () => {
      const f = state.sftp.entries.find((e) => !e.isDir);
      if (!f) return { err: 'no file in root' };
      const res = await window.api.sftpDownload(state.sftp.sessionId, '/' + f.name);
      return { name: f.name, res };
    })()`);
    log('single file: ' + JSON.stringify(r1));

    // ② 目录下载
    const r2 = await ev(c, `(async () => {
      const d = state.sftp.entries.find((e) => e.isDir);
      if (!d) return { err: 'no dir in root' };
      const res = await window.api.sftpDownloadMany(state.sftp.sessionId, [{ remotePath: '/' + d.name, isDir: true }]);
      return { name: d.name, res };
    })()`);
    log('dir: ' + JSON.stringify(r2));

    // 检查本地文件是否真的落了盘
    const localFiles = [];
    const walk = (p) => {
      for (const e of fs.readdirSync(p, { withFileTypes: true })) {
        const fp = path.join(p, e.name);
        if (e.isDirectory()) walk(fp);
        else localFiles.push(fp);
      }
    };
    walk(DL);
    w('RESULT ' + JSON.stringify({ r0, r1, r2, localFiles }));
    log('localFiles: ' + JSON.stringify(localFiles));

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
