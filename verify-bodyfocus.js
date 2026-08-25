// 验证 BODY 焦点兜底 + SFTP 面板点击归还焦点:
//   ① 焦点在 BODY 时,普通字符键 → 被兜底转发(不再"被吞",日志记已转发)
//   ② BODY 时 Cmd+A → 触发 term.selectAll(不吞)
//   ③ 点击 SFTP 面板空白/文件行后 → 焦点自动还给终端 textarea
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');

const OUT = process.env.VERIFY_OUT || os.tmpdir() + '/verify-bodyfocus-result.txt';
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
  const PORT = 9400, SSH = 2233, HTTP = 8133;
  const DIR = fs.mkdtempSync(os.tmpdir() + '/polaris-bodyfocus-');
  freePort(PORT); freePort(SSH); freePort(HTTP);
  const app = spawn('node_modules/.bin/electron', ['.', '--dev', `--remote-debugging-port=${PORT}`, '--no-sandbox', '--disable-gpu'], {
    env: { ...process.env, POLARIS_LOCK_DIR: DIR, MOCK_SSH_PORT: String(SSH), MOCK_HTTP_PORT: String(HTTP), ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
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

    // 建会话并连接,造一个真实活跃终端
    await ev(c, `window.api.createSession({ name: 'T-A', host: '127.0.0.1', port: ${SSH}, username: 'admin', password: 'admin123' })`);
    await ev(c, `state.settings.verifyHostKey = false; saveSettings()`);
    await ev(c, `loadSessions()`); await sleep(500);
    await ev(c, `state.collapsedGroups.clear(); state.collapsedTopHost = false; renderSessionList('')`);
    await ev(c, `[...document.querySelectorAll('.asset-item')].find((x) => x.textContent.includes('T-A')).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
    let connected = false;
    for (let i = 0; i < 40; i++) {
      connected = await ev(c, `[...state.tabs.values()].some((t) => t.status === 'connected')`);
      if (connected) break;
      await sleep(400);
    }
    if (!connected) throw new Error('连接未建立');
    await ev(c, `document.activeElement && document.activeElement.blur && document.activeElement.blur()`);
    await sleep(200);

    const r1 = await ev(c, `(async () => {
      const out = {};
      // 把焦点强制移到 BODY
      document.body.focus ? document.body.focus() : (document.activeElement && document.activeElement.blur());
      await new Promise((r) => setTimeout(r, 100));
      const isBody = document.activeElement === document.body;
      const t = state.tabs.get(state.activeSessionId);
      if (!t || !t.term) return { err: 'no active term' };

      // ① BODY 时按普通键 'x' → keydown 兜底应 preventDefault 并把焦点还给终端
      const ev1 = new KeyboardEvent('keydown', { key: 'x', code: 'KeyX', bubbles: true, cancelable: true });
      const notDefaulted = document.dispatchEvent(ev1);
      await new Promise((r) => setTimeout(r, 100));
      const focusAfterChar = document.activeElement.className || '';
      out.isBodyBefore = isBody;
      out.chaDefaulted = !notDefaulted; // preventDefault 被调用 = 兜底生效
      out.focusAfterCharInTerm = focusAfterChar.includes('xterm-helper-textarea');

      // ② BODY 时 Cmd+A → selectAll
      if (document.activeElement) { try { document.activeElement.blur(); } catch { /* ignore */ } }
      await new Promise((r) => setTimeout(r, 100));
      const isBody2 = document.activeElement === document.body;
      let selectAllCalled = 0;
      const origSA = t.term.selectAll ? t.term.selectAll.bind(t.term) : null;
      if (origSA) { t.term.selectAll = () => { selectAllCalled++; }; }
      const ev2 = new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', metaKey: true, bubbles: true, cancelable: true });
      document.dispatchEvent(ev2);
      await new Promise((r) => setTimeout(r, 50));
      out.cmdACalled = selectAllCalled > 0;
      out.isBody2 = isBody2;
      if (origSA) t.term.selectAll = origSA;

      // ③ 打开 SFTP 面板 → 点击文件行 → 焦点自动回终端
      return out;
    })()`);
    await ev(c, `toggleSftpPanel()`);
    await sleep(600);
    const r2 = await ev(c, `(async () => {
      const out = {};
      out.sftpPanelOpen = !document.getElementById('sftp-panel').classList.contains('hidden');
      if (out.sftpPanelOpen) {
        const row = document.querySelector('#sftp-list .sftp-row');
        if (row) {
          row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
          await new Promise((r) => setTimeout(r, 150));
          const ae = document.activeElement;
          out.focusAfterSftpClick = !!(ae && ae.className && String(ae.className).includes('xterm-helper-textarea'));
        } else {
          out.focusAfterSftpClick = 'no-row';
        }
      }
      return out;
    })()`);

    w('RESULT ' + JSON.stringify({ ...r1, ...r2 }));
    log('result: ' + JSON.stringify({ ...r1, ...r2 }));

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
