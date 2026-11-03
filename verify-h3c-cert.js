'use strict';
/**
 * verify-h3c-cert.js — H3C 原生 API 必须放行堡垒机自签名证书(回归)
 *
 * 现场(诊断包 Polaris-bastion-diag-2026-11-03-03-38-58.json):
 *   同一台 H3C 的 accessUrl 前两次返回 net::ERR_CERT_AUTHORITY_INVALID,第三次才成功。
 * 根因:main.js 的 app.on('certificate-error') 只对 webContents 生效;
 *       h3c-api 的 session.fetch() 走 Chromium 网络栈,不触发该事件 → 自签名证书被拒。
 * 修法:lib/h3c-api.js 对 persist:bastion 会话安装
 *       setCertificateVerifyProc((_req, cb) => cb(0)),与内置浏览器放行口径一致。
 *
 * 本测试起一个自签名 HTTPS 服务,通过 window.api.h3cTree() 走主进程原生链路:
 *   修复前 → { ok:false, error:'无法连接堡垒机(net::ERR_CERT_AUTHORITY_INVALID)' }
 *   修复后 → { ok:true, data:{children:[]} }
 *
 * 运行:node verify-h3c-cert.js(需 9491/9492 空闲;无 openssl 时自动 SKIP)
 */
const { spawn, execSync } = require('child_process');
const { freePort, killTree, guardTimeout } = require('./test-helper');
const https = require('https');
const fs = require('fs'); const os = require('os'); const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-h3ccert-'));
const PORT = 9491, HTTPS_PORT = 9492;
const KEY = path.join(DIR, 'key.pem'), CERT = path.join(DIR, 'cert.pem'), CNF = path.join(DIR, 'openssl.cnf');

// 自签名证书只用于本测试(10 年有效);没有 openssl 时跳过,不误报失败
try {
  execSync('openssl version', { stdio: 'ignore' });
  fs.writeFileSync(CNF, [
    '[req]', 'distinguished_name=dn', 'x509_extensions=v3', 'prompt=no',
    '[dn]', 'CN=127.0.0.1',
    '[v3]', 'subjectAltName=IP:127.0.0.1', 'basicConstraints=CA:TRUE',
  ].join('\n'));
  execSync(`openssl req -x509 -newkey rsa:2048 -nodes -keyout "${KEY}" -out "${CERT}" -days 3650 -config "${CNF}"`, { stdio: 'ignore' });
} catch {
  console.log('\n=== H3C 自签名证书放行 ===\n  - SKIP: 本机没有 openssl,跳过\n');
  process.exit(0);
}

freePort(PORT); freePort(HTTPS_PORT);
const server = https.createServer({ key: fs.readFileSync(KEY), cert: fs.readFileSync(CERT) }, (req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ children: [] }));
});
server.listen(HTTPS_PORT, '127.0.0.1');

const appProc = spawn('node_modules/.bin/electron', ['.', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${PORT}`], {
  env: { ...process.env, POLARIS_LOCK_DIR: DIR, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  stdio: ['ignore', 'ignore', 'ignore'], detached: true,
});
guardTimeout(150000, appProc);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function targets() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json`, { signal: AbortSignal.timeout(3000) });
      const j = await r.json();
      if (j.find((t) => t.type === 'page' && /解锁|Polaris/.test(t.title || ''))) return j;
    } catch { /* not ready */ }
    await sleep(400);
  }
  throw new Error('targets 未就绪');
}
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url); let id = 0; const pending = new Map();
    ws.onopen = () => resolve({ call(m, p = {}) { return new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method: m, params: p })); }); }, close() { ws.close(); } });
    ws.onerror = reject;
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };
  });
}
async function ev(c, expr) {
  const r = await c.call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('JS异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 400));
  return r.result && r.result.value;
}
let passed = 0, failed = 0;
const ok = (n) => { passed++; console.log('  ✓ ' + n); };
const bad = (n, e) => { failed++; console.error('  ✗ ' + n + (e ? ' → ' + e : '')); };

(async () => {
  console.log('\n=== H3C 自签名证书放行 ===\n');
  try {
    const lockT = (await targets()).find((t) => /解锁/.test(t.title || ''));
    const lock = await connect(lockT.webSocketDebuggerUrl);
    for (let i = 0; i < 40; i++) { if (await ev(lock, `!!document.getElementById('pw')`)) break; await sleep(300); }
    await sleep(300);
    await ev(lock, `document.getElementById('pw').value='x1234567'; document.getElementById('pw2').value='x1234567'; document.getElementById('btn').click();`);
    let c = null;
    for (let i = 0; i < 40; i++) {
      await sleep(400);
      const t2 = await targets();
      const m = t2.find((t) => t.type === 'page' && !/解锁/.test(t.title || ''));
      if (m) { c = await connect(m.webSocketDebuggerUrl); break; }
    }
    if (!c) throw new Error('解锁后主窗口未出现');
    for (let i = 0; i < 50; i++) { if (await ev(c, `typeof state === 'object' && !!state.settings`)) break; await sleep(200); }

    const r = await ev(c, `window.api.h3cTree('https://127.0.0.1:${HTTPS_PORT}')`);
    if (r && r.ok === true && r.data && Array.isArray(r.data.children)) ok('自签名 HTTPS 堡垒机请求成功(无 ERR_CERT_AUTHORITY_INVALID)');
    else bad('自签名证书仍被拒', JSON.stringify(r));

    console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  } catch (e) {
    console.error('\n测试异常:', e && e.message);
    failed++;
  }
  try { killTree(appProc); } catch { /* ignore */ }
  try { server.close(); } catch { /* ignore */ }
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(failed ? 1 : 0);
})();
