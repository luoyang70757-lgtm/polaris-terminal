// 验证 SFTP 路径面包屑 + 文件右键菜单:
//   ① 路径栏渲染为可点击面包屑(根/段按钮齐全,当前段高亮)
//   ② 点击路径段 → 跳转到该目录并刷新列表
//   ③ 文件行右键 → 弹出含 下载/编辑/重命名/复制路径/删除 的菜单
//   ④ 目录行右键 → 含 进入 项;重命名真实执行(sftp:rename IPC)
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');

const OUT = process.env.VERIFY_OUT || os.tmpdir() + '/verify-sftpmenu-result.txt';
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
  const PORT = 9396, SSH = 2232, HTTP = 8132;
  const DIR = fs.mkdtempSync(os.tmpdir() + '/polaris-sftpmenu-');
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
    for (let i = 0; i < 40; i++) { if (await ev(c, `!!document.getElementById('sftp-path') && !!document.getElementById('btn-sftp-toggle')`)) break; await sleep(300); }

    // 建主机并连接(mock SSH):渲染资产行 → 双击连接 → 等 connected
    await ev(c, `window.api.createSession({ name: 'SFTP-A', host: '127.0.0.1', port: ${SSH}, username: 'admin', password: 'admin123' })`);
    await ev(c, `state.settings.verifyHostKey = false; saveSettings()`);
    await ev(c, `loadSessions()`); await sleep(500);
    await ev(c, `state.collapsedGroups.clear(); renderSessionList('')`);
    await ev(c, `(async () => {
      const row = [...document.querySelectorAll('.asset-item')].find((x) => x.textContent.includes('SFTP-A'));
      if (!row) return { err: 'no asset row' };
      row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      return true;
    })()`);
    let connected = false;
    for (let i = 0; i < 40; i++) {
      connected = await ev(c, `[...state.tabs.values()].some((t) => t.status === 'connected')`);
      if (connected) break;
      await sleep(400);
    }
    if (!connected) throw new Error('mock SSH 连接未建立');

    // 打开 SFTP 面板并浏览根目录(toggleSftpPanel 已正确设置 state.sftp.sessionId)
    await ev(c, `toggleSftpPanel()`);
    await sleep(800);
    const openRes = await ev(c, `(async () => {
      const sid = state.sftp.sessionId;
      if (!sid) return { err: 'no sftp sessionId' };
      state.sftp.path = '/';
      await loadSftpList();
      return { entries: state.sftp.entries.length, path: state.sftp.path, sid };
    })()`);

    // ① 面包屑:根目录显示一个"／"段
    const r1 = await ev(c, `(() => {
      const segs = document.querySelectorAll('#sftp-path .sftp-path-seg');
      return { segCount: segs.length, rootText: segs[0] ? segs[0].textContent : null, title: document.getElementById('sftp-path').title || '' };
    })()`);

    // 进一个目录后看面包屑 + 点击跳转
    const r2 = await ev(c, `(async () => {
      const dirs = state.sftp.entries.filter((e) => e.isDir);
      if (!dirs.length) return { err: 'no dirs in root' };
      state.sftp.path = '/' + dirs[0].name;
      await loadSftpList();
      const segs = [...document.querySelectorAll('#sftp-path .sftp-path-seg')];
      const labels = segs.map((s) => s.textContent);
      const active = segs.filter((s) => s.classList.contains('active')).map((s) => s.textContent);
      // 点击根段 → 回到 /
      document.querySelector('#sftp-path .sftp-path-seg.root').click();
      await new Promise((r) => setTimeout(r, 400));
      const afterRootClick = state.sftp.path;
      return { dirEntered: '/' + dirs[0].name, labels, active, afterRootClick };
    })()`);

    // ③④ 文件行右键菜单(用 state.sftp.entries 的 isDir 区分,而非路径结尾)
    const r3 = await ev(c, `(async () => {
      const file = state.sftp.entries.find((e) => !e.isDir);
      const dir = state.sftp.entries.find((e) => e.isDir);
      const out = {};
      const menuOf = (path) => {
        const row = [...document.querySelectorAll('.sftp-row')].find((r) => r.dataset.path === path);
        if (!row) return null;
        row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 150, clientY: 150, button: 2 }));
        const items = [...document.querySelectorAll('#ctx-menu .ctx-item')].map((d) => d.textContent);
        closeCtxMenu('test');
        return items;
      };
      if (file) out.fileMenu = menuOf('/' + file.name);
      if (dir) out.dirMenu = menuOf('/' + dir.name);
      return out;
    })()`);

    // ⑤ 重命名真实执行:把根目录第一个文件改名再改回(用 state.sftp.sessionId)
    const r4 = await ev(c, `(async () => {
      const f = state.sftp.entries.find((e) => !e.isDir);
      if (!f) return { err: 'no file in root' };
      const sid = state.sftp.sessionId;
      const from = '/' + f.name;
      const to = '/' + f.name + '.renamed-test';
      const res = await window.api.sftpRename(sid, from, to);
      if (!res.ok) return { err: 'rename failed: ' + res.error };
      const back = await window.api.sftpRename(sid, to, from);
      return { renamed: res.ok, renamedBack: back.ok };
    })()`);

    w('RESULT ' + JSON.stringify({ openRes, r1, r2, r3, r4 }));
    log('result: ' + JSON.stringify({ openRes, r1, r2, r3, r4 }));

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
