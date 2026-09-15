'use strict';
/**
 * verify-sftp-download-fail.js — 目录下载中"逐文件失败"必须可见且不泄漏资源(回归)
 *   用户症状:「SFTP 点击下载后没有任何反应」——实测:目录里若干文件读失败(设备 READ 报错/空读),
 *   而这些文件一次进度都没产生 → 渲染层不为它们建传输行 → 界面全无痕迹(状态栏也可能被"已下载"掩盖)。
 *   断言:① 失败文件有可见的「✗ 失败」行(含原因) ② 状态栏点出失败数 ③ 主进程日志有逐文件失败记录
 *        ④ 失败文件的写句柄**不泄漏**(lsof 无残留写 fd) ⑤ 同目录其它文件照常下载成功
 * 运行: node verify-sftp-download-fail.js(需 9382/2257 空闲)
 */
const { spawn, execSync } = require('child_process');
const { freePort, killTree, guardTimeout } = require('./test-helper');
const fs = require('fs'); const os = require('os'); const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-dlfail-'));
const MOCK_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-dlfail-disk-'));
const DL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-dlfail-out-'));
// 远端目录:两个文件,其中一个让 mock 的 READ 报 FAILURE
fs.mkdirSync(path.join(MOCK_ROOT, 'faildir'), { recursive: true });
fs.writeFileSync(path.join(MOCK_ROOT, 'faildir', 'bad.txt'), 'this file cannot be read\n');
fs.writeFileSync(path.join(MOCK_ROOT, 'faildir', 'good.txt'), 'this one is fine\n');
const PORT = 9382, SSH = 2257, HTTP = 2357;
try { execSync('pkill -f "polaris-terminal/node_modules/electron" 2>/dev/null'); } catch { /* 无残留 */ }
freePort(PORT); freePort(SSH); freePort(HTTP);
process.env.MOCK_SSH_PORT = String(SSH);
process.env.MOCK_HTTP_PORT = String(HTTP);
process.env.MOCK_SFTP_ROOT = MOCK_ROOT;
process.env.POLARIS_AUTO_DL_DIR = DL_DIR;
process.env.MOCK_SFTP_FAIL_READ = 'faildir/bad.txt'; // ← 注入"读失败"
const { start } = require('./mock/mock-server');
start();

const appProc = spawn('node_modules/.bin/electron', ['.', '--dev', `--remote-debugging-port=${PORT}`], {
  env: { ...process.env, POLARIS_LOCK_DIR: DIR, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  stdio: ['ignore', 'ignore', 'ignore'], detached: true,
});
guardTimeout(200000, appProc);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function targets() {
  for (let i = 0; i < 75; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json`, { signal: AbortSignal.timeout(3000) }); const j = await r.json(); const p = j.find((t) => t.type === 'page' && /解锁|Polaris/.test(t.title || '')); if (p) return j; } catch { /* not ready */ }
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
  if (r.exceptionDetails) throw new Error('JS异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result && r.result.value;
}
let passed = 0, failed = 0;
const ok = (n) => { passed++; console.log('  ✓ ' + n); };
const bad = (n, e) => { failed++; console.error('  ✗ ' + n + (e ? ' → ' + e : '')); };

(async () => {
  console.log('\n=== 目录下载逐文件失败:可见性 + 资源回收 ===\n');
  try {
    let lockT = null;
    for (let i = 0; i < 50; i++) { lockT = (await targets()).find((t) => /解锁/.test(t.title || '')); if (lockT) break; await sleep(400); }
    const lock = await connect(lockT.webSocketDebuggerUrl);
    for (let i = 0; i < 30; i++) { if (await ev(lock, `!!document.getElementById('pw')`)) break; await sleep(300); }
    await sleep(300);
    await ev(lock, `document.getElementById('pw').value='x1234567'; document.getElementById('pw2').value='x1234567'; document.getElementById('btn').click();`);
    let main = null;
    for (let i = 0; i < 30; i++) { await sleep(500); const t2 = await targets(); const m = t2.find((t) => t.type === 'page' && !/解锁/.test(t.title || '')); if (m) { main = m; break; } }
    const c = await connect(main.webSocketDebuggerUrl);
    await sleep(1000);
    await ev(c, `(async()=>{ state.settings.verifyHostKey=false; state.settings.autoTrustHostKey=true; await window.api.createSession({name:'dl', host:'127.0.0.1', port:${SSH}, username:'admin', password:'admin123', protocol:'ssh'}); await loadSessions(); return true; })()`);
    await sleep(400);
    const sj = await ev(c, `(function(){ const s=state.sessions.find(x=>x.name==='dl'); return JSON.stringify(s); })()`);
    await ev(c, `connectToServer(${sj})`);
    let sid = null;
    for (let i = 0; i < 30; i++) { sid = await ev(c, `(state.tabs.size ? [...state.tabs.keys()][0] : null)`); if (sid && await ev(c, `state.tabs.get('${sid}').status`) === 'connected') break; await sleep(300); }
    if (!sid) throw new Error('连接失败');
    await ev(c, `toggleSftpPanel(); true`);
    for (let i = 0; i < 20; i++) { if (await ev(c, `state.sftp.path`) !== '.') break; await sleep(400); }
    ok('SFTP 就绪,当前目录=' + await ev(c, `state.sftp.path`));

    // 触发"下载目录"(走 sftpDownloadMany,与面板多选/目录下载同一条路)
    const job = await ev(c, `(async()=>{ const r = await window.api.sftpDownloadMany('${sid}', [{ remotePath: '/faildir', isDir: true }]); return JSON.stringify(r); })()`);
    const j = JSON.parse(job);
    if (j && j.ok) ok('下载已发起(jobId=' + j.jobId + ')');
    else bad('下载未发起', job);
    await sleep(4000);

    // ① 失败文件必须有可见的"✗ 失败"行
    const ui = JSON.parse(await ev(c, `(function(){
      const rows=[...document.querySelectorAll('#sftp-transfers-list .sftp-transfer-row')];
      return JSON.stringify({ total: rows.length,
        fail: rows.filter(r=>r.classList.contains('fail')).map(r=>({name:(r.querySelector('.st-name')||{}).textContent, meta:(r.querySelector('.st-meta')||{}).textContent, text:r.textContent.slice(0,120)})),
        status: document.getElementById('toolbar-status').textContent });
    })()`));
    if (ui.fail.length >= 1 && ui.fail.some((f) => /bad\.txt/.test(f.name || ''))) ok(`① 失败文件有可见行:${JSON.stringify(ui.fail.map((f) => f.name + '/' + f.meta))}`);
    else bad('① 失败文件没有任何界面痕迹(用户报的"点了没反应")', JSON.stringify(ui).slice(0, 300));
    if (/失败/.test(ui.status || '')) ok(`② 状态栏点出失败:「${ui.status}」`);
    else bad('② 状态栏未提示失败', String(ui.status));

    // ③ 主进程日志有逐文件失败记录
    let logTxt = '';
    try { logTxt = fs.readdirSync(path.join(DIR, 'logs')).filter((f) => f.startsWith('app-')).map((f) => fs.readFileSync(path.join(DIR, 'logs', f), 'utf8')).join('\n'); } catch { /* ignore */ }
    if (/下载失败\(单文件\)/.test(logTxt)) ok('③ 主进程日志有「下载失败(单文件)」记录');
    else bad('③ 日志没有逐文件失败记录(排障无依据)', logTxt.slice(-200));

    // ④ 失败文件的写句柄不泄漏
    let lsofOut = '';
    try { lsofOut = execSync(`lsof -p ${appProc.pid} 2>/dev/null | grep -i "faildir" || true`).toString(); } catch { /* ignore */ }
    const leaked = lsofOut.split('\n').filter((l) => /\sw\s/.test(l) || /\s\d+w\s/.test(l) || /w\s+REG/.test(l));
    if (!leaked.length) ok('④ 无残留写句柄(失败时成对销毁流)');
    else bad('④ 写句柄泄漏', leaked.slice(0, 3).join(' | '));

    // ⑤ 同目录其它文件照常下载
    const good = fs.existsSync(path.join(DL_DIR, 'faildir', 'good.txt')) && fs.readFileSync(path.join(DL_DIR, 'faildir', 'good.txt'), 'utf8').includes('this one is fine');
    if (good) ok('⑤ 同目录正常文件照常下载成功');
    else bad('⑤ 正常文件没下来', JSON.stringify(fs.existsSync(path.join(DL_DIR, 'faildir')) ? fs.readdirSync(path.join(DL_DIR, 'faildir')) : null));

    console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  } catch (e) { console.error('\n测试异常:', e && e.message); failed++; console.log(`\n结果: ${passed} 通过, ${failed} 失败`); }
  try { killTree(appProc); } catch { /* ignore */ }
  for (const d of [MOCK_ROOT, DL_DIR]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
  process.exit(failed ? 1 : 0);
})();
