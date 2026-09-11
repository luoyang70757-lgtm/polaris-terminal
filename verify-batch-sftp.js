'use strict';
/**
 * verify-batch-sftp.js — 批量上传/下载走加固管线(回归)
 *   旧版批量用 fastPut/fastGet:无进度、无大小对账、无读回核对(中继截断也报成功)。
 *   产品要求:复用加固后的 uploadFile/downloadFile。
 *   断言:① 批量上传 2 台全成功,结果带 bytes ② 远端真的写进去了(用批量下载回读对比)
 *        ③ 批量下载 2 台全成功、本地文件与源文件逐字节一致(sha256)
 *        ④ 失败隔离:一台密码错 → 该台报错、另一台仍成功
 * 运行: node verify-batch-sftp.js(需 9374/2249 空闲)
 */
const { spawn, execSync } = require('child_process');
const { freePort, killTree, guardTimeout } = require('./test-helper');
const fs = require('fs'); const os = require('os'); const path = require('path');
const crypto = require('crypto');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-batch-'));
const MOCK_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-batch-disk-'));
const DL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-batch-dl-'));
const LOCAL = path.join(DIR, 'batch-round.bin');
fs.writeFileSync(LOCAL, crypto.randomBytes(512 * 1024)); // 512KB 随机内容,便于哈希比对
const SRC_SHA = crypto.createHash('sha256').update(fs.readFileSync(LOCAL)).digest('hex');
const PORT = 9374, SSH = 2249;
try { execSync('pkill -f "polaris-terminal/node_modules/electron" 2>/dev/null'); } catch { /* 无残留 */ }
freePort(PORT); freePort(SSH);
process.env.MOCK_SSH_PORT = String(SSH);
process.env.MOCK_HTTP_PORT = String(SSH + 100);
process.env.MOCK_SFTP_ROOT = MOCK_ROOT;
process.env.POLARIS_AUTO_DL_DIR = DL_DIR; // 批量下载的"选文件夹"自动应答
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
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

(async () => {
  console.log('\n=== 批量上传/下载(加固管线) ===\n');
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

    const sessions = [
      { name: 'h1', host: '127.0.0.1', port: SSH, username: 'admin', password: 'admin123' },
      { name: 'h2', host: '127.0.0.1', port: SSH, username: 'admin', password: 'admin123' },
    ];
    // ---- ① 批量上传 ----
    // 注:mock 的首次 SSH 握手偶发 "Timed out while waiting for handshake"(本机环境抖动,
    // 同一调用内另一台成功、后续重连也正常)→ 失败重试一次,不影响被测语义。
    const batchUp = async () => JSON.parse(await ev(c, `(async()=>{ const r = await window.api.sftpBatchUpload(${JSON.stringify(sessions)}, '/', [${JSON.stringify(LOCAL)}]); return JSON.stringify(r); })()`));
    let up = await batchUp();
    if (!up.results.every((r) => r.ok)) {
      console.log('    (首次握手超时,重试一次)' + JSON.stringify(up.results.map((r) => r.error || 'ok')));
      await sleep(1500);
      up = await batchUp();
    }
    if (up && up.ok && up.results.length === 2 && up.results.every((r) => r.ok)) ok(`① 批量上传 2/2 成功(远端路径 ${up.results[0].path})`);
    else bad('① 批量上传未全成功', JSON.stringify(up).slice(0, 300));
    if (up.results.every((r) => r.bytes === fs.statSync(LOCAL).size)) ok(`① 结果带回字节数(${up.results[0].bytes})`);
    else bad('① 结果的 bytes 缺失/不符', JSON.stringify(up.results));

    // ---- ②③ 批量下载回读 → 逐字节一致(证明远端确实写对了 + 下载也走加固管线) ----
    const dn = JSON.parse(await ev(c, `(async()=>{ const r = await window.api.sftpBatchDownload(${JSON.stringify(sessions)}, '/batch-round.bin'); return JSON.stringify(r); })()`));
    if (dn && dn.ok && dn.results.length === 2 && dn.results.every((r) => r.ok)) ok('③ 批量下载 2/2 成功(带本地路径)');
    else bad('③ 批量下载未全成功', JSON.stringify(dn).slice(0, 300));
    let allSame = true; const detail = [];
    for (const r of (dn.results || [])) {
      if (!r.path || !fs.existsSync(r.path)) { allSame = false; detail.push(`${r.name}:无文件`); continue; }
      const h = sha(r.path);
      if (h !== SRC_SHA) { allSame = false; detail.push(`${r.name}:哈希不符`); }
    }
    if (allSame && dn.results.length === 2) ok(`②③ 两台下载内容与源文件逐字节一致(sha256 ${SRC_SHA.slice(0, 12)}…)`);
    else bad('②③ 下载内容不一致', detail.join('; '));

    // ---- ④ 失败隔离:一台密码错 ----
    const badSessions = [sessions[0], { name: 'bad', host: '127.0.0.1', port: SSH, username: 'admin', password: 'WRONG-PW' }];
    const up2 = JSON.parse(await ev(c, `(async()=>{ const r = await window.api.sftpBatchUpload(${JSON.stringify(badSessions)}, '/', [${JSON.stringify(LOCAL)}]); return JSON.stringify(r); })()`));
    const okHosts = (up2.results || []).filter((r) => r.ok).map((r) => r.name);
    const failHosts = (up2.results || []).filter((r) => !r.ok);
    if (okHosts.length === 1 && failHosts.length === 1) ok(`④ 失败隔离:成功 ${JSON.stringify(okHosts)}、失败 ${JSON.stringify(failHosts.map((f) => f.name))}(错误:${String(failHosts[0].error).slice(0, 60)})`);
    else bad('④ 失败隔离异常', JSON.stringify(up2).slice(0, 300));

    console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  } catch (e) { console.error('\n测试异常:', e && e.message); failed++; console.log(`\n结果: ${passed} 通过, ${failed} 失败`); }
  try { killTree(appProc); } catch { /* ignore */ }
  try { fs.rmSync(MOCK_ROOT, { recursive: true, force: true }); fs.rmSync(DL_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(failed ? 1 : 0);
})();
