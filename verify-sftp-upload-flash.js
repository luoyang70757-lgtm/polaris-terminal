'use strict';
/**
 * verify-sftp-upload-flash.js — 上传成功后列表高亮定位(回归)
 *   旧版:job 化改造后没人往 state.sftpUploadFlash 写入 → 高亮是死代码(面板看不到"传到了哪")
 *   本测试走**真实上传**(sftpUploadPaths),断言 ① 集合被写入 ② 列表里该行带 .upload-flash
 * 运行: node verify-sftp-upload-flash.js(需 9372/2247 空闲)
 */
const { spawn, execSync } = require('child_process');
const { freePort, killTree, guardTimeout } = require('./test-helper');
const fs = require('fs'); const os = require('os'); const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-upflash-'));
const LOCAL = path.join(DIR, 'flash-demo.txt');
fs.writeFileSync(LOCAL, 'polaris upload flash test\n');
const PORT = 9372, SSH = 2247;
try { execSync('pkill -f "polaris-terminal/node_modules/electron" 2>/dev/null'); } catch { /* 无残留 */ }
freePort(PORT); freePort(SSH);
process.env.MOCK_SSH_PORT = String(SSH);
process.env.MOCK_HTTP_PORT = String(SSH + 100);
const { start } = require('./mock/mock-server');
start();

const appProc = spawn('node_modules/.bin/electron', ['.', '--dev', `--remote-debugging-port=${PORT}`], {
  env: { ...process.env, POLARIS_LOCK_DIR: DIR, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  stdio: ['ignore', 'ignore', 'ignore'], detached: true,
});
guardTimeout(150000, appProc);
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
  console.log('\n=== 上传成功后高亮定位 ===\n');
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

    await ev(c, `(async()=>{ state.settings.verifyHostKey=false; state.settings.autoTrustHostKey=true; await window.api.createSession({name:'up', host:'127.0.0.1', port:${SSH}, username:'admin', password:'admin123', protocol:'ssh'}); await loadSessions(); return true; })()`);
    await sleep(400);
    const sj = await ev(c, `(function(){ const s=state.sessions.find(x=>x.name==='up'); return s?JSON.stringify(s):'NOTFOUND'; })()`);
    if (sj === 'NOTFOUND') throw new Error('会话未创建');
    await ev(c, `connectToServer(${sj})`);
    let sid = null;
    for (let i = 0; i < 30; i++) { sid = await ev(c, `(state.tabs.size ? [...state.tabs.keys()][0] : null)`); if (sid && await ev(c, `state.tabs.get('${sid}').status`) === 'connected') break; await sleep(300); }
    if (!sid) throw new Error('连接失败');
    await ev(c, `toggleSftpPanel(); true`);
    for (let i = 0; i < 20; i++) { const p = await ev(c, `state.sftp.path`); if (p && p !== '.') break; await sleep(400); }
    ok('SFTP 面板已打开,当前目录=' + await ev(c, `state.sftp.path`));

    // 真实上传(sftpUploadPaths = 拖拽上传走的同一入口)
    const job = await ev(c, `window.api.sftpUploadPaths('${sid}', state.sftp.path, [${JSON.stringify(LOCAL)}])`);
    if (!job || !job.ok) throw new Error('上传未发起: ' + JSON.stringify(job));
    let flash = null, rows = null;
    for (let i = 0; i < 30; i++) {
      await sleep(250);
      flash = await ev(c, `Array.from(state.sftpUploadFlash || [])`);
      rows = await ev(c, `document.querySelectorAll('#sftp-list .sftp-row.upload-flash').length`);
      if (Array.isArray(flash) && flash.includes('flash-demo.txt') && rows > 0) break;
    }
    if (Array.isArray(flash) && flash.includes('flash-demo.txt')) ok('上传成功后 sftpUploadFlash 已写入:' + JSON.stringify(flash));
    else bad('sftpUploadFlash 未被写入(旧 bug:高亮死代码)', JSON.stringify(flash));
    if (rows > 0) ok(`列表里有 ${rows} 行带 .upload-flash 高亮`);
    else bad('列表里没有高亮行', String(rows));

    console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  } catch (e) { console.error('\n测试异常:', e && e.message); failed++; console.log(`\n结果: ${passed} 通过, ${failed} 失败`); }
  try { killTree(appProc); } catch { /* ignore */ }
  process.exit(failed ? 1 : 0);
})();
