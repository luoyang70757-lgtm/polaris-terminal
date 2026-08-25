'use strict';
/**
 * verify-sftp-path.js — 验证 SFTP 下载保存路径显示:
 *  ① makeSftpTransferRow 下载行:默认 .st-local-row 隐藏,结构含 .st-main/.st-open/.st-local
 *  ② setLocal(path) → 路径行显示(纯渲染层)
 *  ③ 上传行不显示本地路径行
 *  ④ 单文件下载成功(真实 mock SFTP)→ 自动建「已完成」记录行 + 盖保存路径
 *  ⑤ 批量下载(2 个文件)→ 每个文件的行都盖上本地路径
 *  ⑥ 点击 📂 → 主进程真实收到 fs:reveal(断言 stdout 观察点)
 * 运行: node verify-sftp-path.js(需 9362/2230 空闲;走 POLARIS_AUTO_DL_DIR 自动应答对话框)
 */
const { spawn } = require('child_process');
const { freePort, killTree, guardTimeout } = require('./test-helper');
const fs = require('fs'); const os = require('os'); const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-sftp-path-'));
const DLDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-dl-'));
const PORT = 9362, SSH = 2230;
freePort(PORT); freePort(SSH);
process.env.MOCK_SSH_PORT = String(SSH);
process.env.MOCK_HTTP_PORT = String(SSH + 100);
process.env.POLARIS_AUTO_DL_DIR = DLDIR; // 自动应答保存/选目录对话框
const { start } = require('./mock/mock-server');
start();

const appProc = spawn('node_modules/.bin/electron', ['.', '--dev', `--remote-debugging-port=${PORT}`], {
  env: { ...process.env, POLARIS_LOCK_DIR: DIR, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  stdio: ['ignore', 'pipe', 'pipe'], detached: true,
});
const mainOut = [];
appProc.stdout.on('data', (d) => mainOut.push(d.toString()));
appProc.stderr.on('data', (d) => mainOut.push(d.toString()));
guardTimeout(150000, appProc);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function targets() {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json`); const j = await r.json(); const p = j.find((t) => t.type === 'page' && /解锁|Polaris/.test(t.title || '')); if (p) return j; } catch {}
    await sleep(400);
  }
  throw new Error('targets 未就绪');
}
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url); let id = 0; const pending = new Map();
    ws.onopen = () => resolve({ call(m, p = {}) { return new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method: m, params: p })); }); }, close() { ws.close(); } });
    ws.onerror = (e) => reject(e);
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };
  });
}
async function ev(c, expr) {
  const r = await c.call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('JS异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 600) + ' @ ' + expr.slice(0, 90));
  return r.result && r.result.value;
}
let passed = 0, failed = 0;
const ok = (n) => { passed++; console.log('  ✓ ' + n); };
const bad = (n, e) => { failed++; console.error('  ✗ ' + n + (e ? ' -> ' + e : '')); };

(async () => {
  console.log('\n=== SFTP 下载保存路径显示验证 ===\n');
  try {
    let lockT = null;
    for (let i = 0; i < 50; i++) { lockT = (await targets()).find((t) => /解锁/.test(t.title || '')); if (lockT) break; await sleep(400); }
    if (!lockT) throw new Error('解锁页未就绪');
    const lock = await connect(lockT.webSocketDebuggerUrl);
    for (let i = 0; i < 30; i++) { if (await ev(lock, `!!document.getElementById('pw')`)) break; await sleep(300); }
    await sleep(400);
    await ev(lock, `document.getElementById('pw').value='x1234567'; document.getElementById('pw2').value='x1234567'; document.getElementById('btn').click();`);
    let main = null, c = null;
    for (let i = 0; i < 30; i++) { await sleep(500); const t2 = await targets(); const m = t2.find((t) => t.type === 'page' && !/解锁/.test(t.title || '')); if (m) { main = m; break; } }
    c = await connect(main.webSocketDebuggerUrl);
    await sleep(1200);

    // ---- ①-③ 纯渲染层:行结构 / setLocal / 上传行 ----
    const a = await ev(c, `(() => {
      const row = makeSftpTransferRow({ file: '/home/user/report.txt', op: 'download' });
      const el = row.el;
      return JSON.stringify({
        hasMain: !!el.querySelector('.st-main'),
        hasOpen: !!el.querySelector('.st-open'),
        hasLocal: !!el.querySelector('.st-local'),
        hidden: el.querySelector('.st-local-row').classList.contains('hidden'),
      });
    })()`);
    const A = JSON.parse(a);
    if (A.hasMain && A.hasOpen && A.hasLocal && A.hidden) ok('下载行默认隐藏本地路径行,结构含 st-main/st-open/st-local');
    else bad('行结构或初始隐藏态不对', a);

    const b = await ev(c, `(() => {
      const row = makeSftpTransferRow({ file: '/home/user/report.txt', op: 'download' });
      row.setLocal('/Users/major/Downloads/report.txt');
      const lr = row.el.querySelector('.st-local-row');
      return JSON.stringify({ shown: !lr.classList.contains('hidden'), text: row.el.querySelector('.st-local').textContent });
    })()`);
    const B = JSON.parse(b);
    if (B.shown && B.text === '/Users/major/Downloads/report.txt') ok(`setLocal → 本地路径行显示(${B.text})`); else bad('setLocal 未显示路径', b);

    const up = await ev(c, `(() => {
      const row = makeSftpTransferRow({ file: '/home/user/report.txt', op: 'upload' });
      return row.el.querySelector('.st-local-row').classList.contains('hidden');
    })()`);
    if (up) ok('上传行保持隐藏本地路径行'); else bad('上传行不应有本地路径行');

    // ---- 连 mock SSH,开 SFTP 面板,准备真实下载 ----
    await ev(c, `(async()=>{ await window.api.createSession({name:'srvA', host:'127.0.0.1', port:${SSH}, username:'admin', password:'admin123', protocol:'ssh'}); await loadSessions(); state.collapsedGroups.clear(); state.settings.sessionView='list'; state.settings.verifyHostKey = false; state.settings.autoTrustHostKey = true; renderSessionList(''); return true; })()`);
    await sleep(400);
    const aJson = await ev(c, `(function(){ const s=state.sessions.find(x=>x.name==='srvA'); return s?JSON.stringify(s):'NOTFOUND'; })()`);
    if (aJson === 'NOTFOUND') throw new Error('srvA 未创建');
    await ev(c, `connectToServer(${aJson})`);
    let sid = null;
    for (let i = 0; i < 30; i++) { sid = await ev(c, `(state.tabs.size ? [...state.tabs.keys()][0] : null)`); if (sid && await ev(c, `state.tabs.get('${sid}').status`) === 'connected') break; await sleep(300); }
    if (!sid) throw new Error('会话连接失败');
    console.log('  [诊断] sid=' + sid + ' status=' + (await ev(c, `state.tabs.get('${sid}').status`)) + ' mock尾: ' + mainOut.join('').trim().split('\n').slice(-3).join('|'));
    await sleep(600); // 连接就绪后等 shell 会话在 mock 侧真正建立,避免 SFTP 通道开太早
    await ev(c, `toggleSftpPanel(); true`);
    for (let i = 0; i < 40; i++) {
      if (await ev(c, `state.sftp.entries.length > 0`)) break;
      if (i > 0 && i % 4 === 0) await ev(c, `loadSftpList(); true`); // 首次可能太早失败,重试拉取
      await sleep(300);
    }
    const entries = await ev(c, `state.sftp.entries.map(e=>e.name).join(',')`);
    if (!/README\.txt/.test(entries)) throw new Error('SFTP 面板未加载 mock 文件列表: ' + entries);
    ok(`SFTP 面板加载 mock 文件列表(${entries})`);

    // ---- ④ 单文件下载 → 自动建完成记录行 + 盖路径 ----
    await ev(c, `clearSftpTransfers(); state.sftp.selectedSet.clear(); state.sftp.selectedSet.add(sftpJoin('README.txt')); true`);
    await ev(c, `(async()=>{ await sftpDownload(); return true; })()`);
    await sleep(600);
    const d = await ev(c, `(() => {
      const row = sftpTransfer.rows.get('/README.txt');
      if (!row) return 'NOROW';
      return JSON.stringify({ done: row.el.classList.contains('done'), local: row.el.querySelector('.st-local').textContent });
    })()`);
    if (d === 'NOROW') bad('单文件下载后未建传输记录行');
    else {
      const D = JSON.parse(d);
      const expectLocal = path.join(DLDIR, 'README.txt');
      if (D.done && D.local === expectLocal) ok(`单文件下载 → 自动建已完成记录行并显示保存路径(${D.local})`); else bad(`单文件下载行状态/路径不对: done=${D.done} local=${JSON.stringify(D.local)} 期望=${expectLocal}`, d);
    }

    // ---- ⑤ 批量下载(2 文件)→ 每行都盖路径 ----
    await ev(c, `clearSftpTransfers(); state.sftp.selectedSet.clear(); state.sftp.selectedSet.add(sftpJoin('README.txt')); state.sftp.selectedSet.add(sftpJoin('hello.txt')); true`);
    await ev(c, `(async()=>{ await sftpDownload(); return true; })()`);
    await sleep(1200);
    const e = await ev(c, `(() => {
      const g = (n) => { const r = sftpTransfer.rows.get('/' + n); return r ? r.el.querySelector('.st-local').textContent : 'NOROW'; };
      return JSON.stringify({ readme: g('README.txt'), hello: g('hello.txt') });
    })()`);
    const E = JSON.parse(e);
    if (E.readme === path.join(DLDIR, 'README.txt') && E.hello === path.join(DLDIR, 'hello.txt')) ok(`批量下载 → 每个文件行都盖上本地路径(${E.readme} / ${E.hello})`);
    else bad(`批量下载盖路径不对: ${JSON.stringify(E)}`, null);

    // ---- ⑥ 点击 📂 → 主进程真实收到 fs:reveal ----
    await ev(c, `(function(){ const rows=[...document.querySelectorAll('.sftp-transfer-row')]; const r=rows.find(x=>x.querySelector('.st-local') && x.querySelector('.st-local').textContent.includes('README.txt')); if(!r) return 'NOROW'; r.querySelector('.st-open').click(); return 'OK'; })()`);
    let revealed = null;
    for (let i = 0; i < 20; i++) {
      revealed = mainOut.join('').match(/\[fs:reveal\] (.+)/);
      if (revealed) break;
      await sleep(250);
    }
    if (revealed && revealed[1] === path.join(DLDIR, 'README.txt')) ok(`点击 📂 → 主进程收到 fs:reveal(${revealed[1]})`);
    else bad(`📂 未到达主进程: ${revealed ? revealed[1] : '(无观察点输出)'}`, null);

    console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  } catch (e) { console.error('\n测试异常:', e && e.message); failed++; console.log(`\n结果: ${passed} 通过, ${failed} 失败`); }
  try { killTree(appProc); } catch {}
  process.exit(failed ? 1 : 0);
})();
