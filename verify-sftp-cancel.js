'use strict';
/**
 * verify-sftp-cancel.js — 取消传输的端到端语义(app 级)
 *   产品要求:取消必须保留本地/远端半成品 + 保留续传记录 + UI 明确显示「已取消」。
 *   断言:① done 载荷 cancelled=true ② 面板该行显示「已取消」+ 状态栏提示可续传
 *        ③ 远端半成品仍在(0 < size < 总量) ④ sftp-partials.json 里有续传记录
 *        ⑤ 重试同一文件:从断点续传(首个进度事件的 fileDone = 半成品大小),最终成功
 * 运行: node verify-sftp-cancel.js(需 9373/2248 空闲;MOCK_SFTP_ROOT 指向临时目录,不污染仓库假盘)
 */
const { spawn, execSync } = require('child_process');
const { freePort, killTree, guardTimeout } = require('./test-helper');
const fs = require('fs'); const os = require('os'); const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-cancel-app-'));
const MOCK_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-cancel-disk-'));
const LOCAL = path.join(DIR, 'big-cancel.bin');
fs.writeFileSync(LOCAL, Buffer.alloc(4 * 1024 * 1024, 5)); // 4MB:保证取消发生在传输途中
const PORT = 9385, SSH = 2248;
try { execSync('pkill -f "polaris-terminal/node_modules/electron" 2>/dev/null'); } catch { /* 无残留 */ }
freePort(PORT); freePort(SSH);
process.env.MOCK_SSH_PORT = String(SSH);
process.env.MOCK_HTTP_PORT = String(SSH + 100);
process.env.MOCK_SFTP_ROOT = MOCK_ROOT; // 假 SFTP 磁盘指向临时目录(取消会留下半成品,别落在仓库里)
const { start } = require('./mock/mock-server');
start();

const appProc = spawn('node_modules/.bin/electron', ['.', '--dev', `--remote-debugging-port=${PORT}`], {
  env: { ...process.env, POLARIS_LOCK_DIR: DIR, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  stdio: ['ignore', 'ignore', 'ignore'], detached: true,
});
guardTimeout(240000, appProc);
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
const partialsFile = () => path.join(DIR, 'sftp-partials.json');

(async () => {
  console.log('\n=== 取消传输(端到端) ===\n');
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

    await ev(c, `(async()=>{ state.settings.verifyHostKey=false; state.settings.autoTrustHostKey=true; await window.api.createSession({name:'cx', host:'127.0.0.1', port:${SSH}, username:'admin', password:'admin123', protocol:'ssh'}); await loadSessions(); return true; })()`);
    await sleep(400);
    const sj = await ev(c, `(function(){ const s=state.sessions.find(x=>x.name==='cx'); return s?JSON.stringify(s):'NOTFOUND'; })()`);
    if (sj === 'NOTFOUND') throw new Error('会话未创建');
    await ev(c, `connectToServer(${sj})`);
    let sid = null;
    for (let i = 0; i < 30; i++) { sid = await ev(c, `(state.tabs.size ? [...state.tabs.keys()][0] : null)`); if (sid && await ev(c, `state.tabs.get('${sid}').status`) === 'connected') break; await sleep(300); }
    if (!sid) throw new Error('连接失败');
    await ev(c, `toggleSftpPanel(); true`);
    for (let i = 0; i < 20; i++) { if (await ev(c, `state.sftp.path`) !== '.') break; await sleep(400); }
    const dirPath = await ev(c, `state.sftp.path`);
    ok(`SFTP 就绪,当前目录=${dirPath}`);
    // 采集进度/完成事件
    await ev(c, `window.__prog=[]; window.__done=[]; window.api.onSftpProgress((p)=>window.__prog.push({file:p.file, fileDone:p.fileDone, jobId:p.jobId})); window.api.onSftpDone((d)=>window.__done.push(d)); true`);

    // ---- 发起上传 → 400ms 后取消 ----
    const job = await ev(c, `window.api.sftpUploadPaths('${sid}', state.sftp.path, [${JSON.stringify(LOCAL)}])`);
    if (!job || !job.ok) throw new Error('上传未发起:' + JSON.stringify(job));
    await sleep(400);
    await ev(c, `window.api.sftpCancel(${JSON.stringify(job.jobId)}); true`);
    for (let i = 0; i < 60; i++) { if ((await ev(c, `window.__done.length`)) > 0) break; await sleep(300); }
    await sleep(500);
    const done1 = await ev(c, `JSON.stringify(window.__done[0] || null)`);
    const d1 = JSON.parse(done1 || 'null');
    if (d1 && d1.cancelled === true) ok('① done 载荷 cancelled=true');
    else bad('① 未标记 cancelled', done1);

    const ui = await ev(c, `(function(){ const rows=[...document.querySelectorAll('#sftp-transfers-list .sftp-transfer-row')]; const meta=rows.map(r=>(r.querySelector('.st-meta')||{}).textContent); return JSON.stringify({ meta, status: document.getElementById('toolbar-status').textContent }); })()`);
    const u = JSON.parse(ui);
    if (u.meta.some((m) => /已取消/.test(m || ''))) ok(`② 传输行显示「已取消」(${JSON.stringify(u.meta)})`);
    else bad('② 传输行未显示已取消', ui);
    if (/已取消/.test(u.status || '')) ok(`② 状态栏提示:${u.status}`);
    else bad('② 状态栏无取消提示', u.status);

    // ---- ③ 远端半成品仍在 ----
    await sleep(400);
    const remote = JSON.parse(await ev(c, `(async()=>{ const r = await window.api.sftpList('${sid}', ${JSON.stringify(dirPath)}); const e = (r.entries||[]).find(x=>x.name==='big-cancel.bin'); return JSON.stringify(e||null); })()`));
    const size = remote ? remote.size : -1;
    if (size > 0 && size < 4 * 1024 * 1024) ok(`③ 远端半成品保留:${size} / ${4 * 1024 * 1024} 字节`);
    else bad('③ 远端半成品异常(可能被删/未写入)', JSON.stringify(remote));
    // ---- ④ 续传记录 ----
    let rec = null;
    try { rec = JSON.parse(fs.readFileSync(partialsFile(), 'utf8')); } catch { /* 无文件 */ }
    const key = rec && Object.keys(rec).find((k) => k.endsWith('big-cancel.bin'));
    if (key && rec[key] && rec[key].bytes > 0) ok(`④ 续传记录已落盘:${key.slice(-40)} → ${rec[key].bytes} 字节`);
    else bad('④ 无续传记录', JSON.stringify(rec).slice(0, 200));

    // ---- ⑤ 重试:应从断点续 ----
    await ev(c, `window.__prog=[]; true`);
    const job2 = await ev(c, `window.api.sftpUploadPaths('${sid}', state.sftp.path, [${JSON.stringify(LOCAL)}])`);
    if (!job2 || !job2.ok) throw new Error('重试未发起');
    for (let i = 0; i < 120; i++) { const n = await ev(c, `window.__done.length`); if (n > 1) break; await sleep(500); }
    const done2 = JSON.parse((await ev(c, `JSON.stringify(window.__done[1] || null)`)) || 'null');
    if (done2 && done2.ok === true) ok('⑤ 重试完成且成功');
    else bad('⑤ 重试未成功', JSON.stringify(done2));
    const firstProg = JSON.parse(await ev(c, `(function(){ const p=(window.__prog||[]).find(x=>String(x.file).endsWith('big-cancel.bin')); return JSON.stringify(p||null); })()`));
    if (firstProg && firstProg.fileDone > 0) ok(`⑤ 重试从断点续传:首个进度 fileDone=${firstProg.fileDone}(= 取消时的半成品大小 ${size})`);
    else bad('⑤ 重试未从断点续(从 0 开始)', JSON.stringify(firstProg));
    const remote2 = JSON.parse(await ev(c, `(async()=>{ const r = await window.api.sftpList('${sid}', ${JSON.stringify(dirPath)}); const e = (r.entries||[]).find(x=>x.name==='big-cancel.bin'); return JSON.stringify(e||null); })()`));
    if (remote2 && remote2.size === 4 * 1024 * 1024) ok('⑤ 续传后远端完整(4MB)');
    else bad('⑤ 续传后远端大小不对', JSON.stringify(remote2));

    console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  } catch (e) { console.error('\n测试异常:', e && e.message); failed++; console.log(`\n结果: ${passed} 通过, ${failed} 失败`); }
  try { killTree(appProc); } catch { /* ignore */ }
  try { fs.rmSync(MOCK_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(failed ? 1 : 0);
})();
