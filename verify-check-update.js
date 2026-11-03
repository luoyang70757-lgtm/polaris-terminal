'use strict';
/**
 * verify-check-update.js — 手动检查更新(IPC)回归
 *
 * 断言:
 *   ① 主进程 app:checkUpdate 能读取 Releases API，返回 current/latest/hasUpdate/url；
 *   ② 版本比较正确：远端更高 → hasUpdate=true；等于当前 → false；
 *   ③ app:openRelease 只允许本项目 GitHub Releases 域名，非法 URL 被拒绝(不打开外部链接)；
 *   ④ renderer 的 checkUpdate 能把结果写进「关于」弹窗状态。
 *
 * 运行:node verify-check-update.js(需 9494/9495 空闲)
 */
const { spawn } = require('child_process');
const { freePort, killTree, guardTimeout } = require('./test-helper');
const fs = require('fs'); const os = require('os'); const path = require('path'); const http = require('http');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-upd-'));
const PORT = 9494, HTTP_PORT = 9495;
freePort(PORT); freePort(HTTP_PORT);
const CURRENT = require('./package.json').version;
let mode = 'newer'; // newer | current
const server = http.createServer((req, res) => {
  const latest = mode === 'newer' ? '99.0.0' : CURRENT;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    tag_name: 'v' + latest,
    html_url: 'https://github.com/luoyang70757-lgtm/polaris-terminal/releases/tag/v' + latest,
    body: '## test release\n- item',
    published_at: '2026-11-03T00:00:00Z',
  }));
});
server.listen(HTTP_PORT, '127.0.0.1');

const appProc = spawn('node_modules/.bin/electron', ['.', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${PORT}`], {
  env: { ...process.env, POLARIS_LOCK_DIR: DIR, POLARIS_UPDATE_API: `http://127.0.0.1:${HTTP_PORT}/latest`, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
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
  console.log('\n=== 手动检查更新 ===\n');
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

    // ① 远端更高
    const r1 = await ev(c, `window.api.checkUpdate()`);
    if (r1 && r1.ok && r1.latest === '99.0.0' && r1.current === CURRENT && r1.hasUpdate === true && /releases\/tag\/v99\.0\.0/.test(r1.url)) {
      ok(`发现新版本 v${r1.latest}(当前 v${r1.current})`);
    } else bad('新版本检查结果异常', JSON.stringify(r1));

    // ② 远端等于当前
    mode = 'current';
    const r2 = await ev(c, `window.api.checkUpdate()`);
    if (r2 && r2.ok && r2.latest === CURRENT && r2.hasUpdate === false) ok('远端等于当前版本 → hasUpdate=false');
    else bad('同版本判断异常', JSON.stringify(r2));

    // ③ 非法外链被拒
    const r3 = await ev(c, `window.api.openRelease('https://evil.example.com/x')`);
    if (r3 && r3.ok === false) ok('非本项目 Release 地址被拒绝');
    else bad('非法外链未被拒绝', JSON.stringify(r3));

    // ④ 关于弹窗状态 + 下载/下载页按钮
    mode = 'newer';
    const r5 = await ev(c, `(async()=>{
      openAbout();
      await checkUpdate();
      return {
        msg: els.aboutUpdateMsg.textContent, cls: els.aboutUpdateMsg.className,
        downloadHidden: els.aboutDownload.classList.contains('hidden'),
        releaseHidden: els.aboutRelease.classList.contains('hidden'),
      };
    })()`);
    if (r5 && /99\.0\.0/.test(r5.msg) && /ok/.test(r5.cls) && !r5.downloadHidden && !r5.releaseHidden) ok('关于弹窗显示新版本 + 下载/下载页按钮');
    else bad('关于弹窗状态未更新', JSON.stringify(r5));

    // ⑤ 开发/未打包环境:自动下载/安装必须给出可读拒绝,而不是抛异常
    const r6 = await ev(c, `window.api.downloadUpdate()`);
    if (r6 && r6.ok === false && /开发|未打包|Windows|便携版/.test(r6.error || '')) ok('开发环境下载更新被友好拒绝');
    else bad('开发环境下载更新未友好拒绝', JSON.stringify(r6));
    const r7 = await ev(c, `window.api.installUpdate()`);
    if (r7 && r7.ok === false && /尚未下载/.test(r7.error || '')) ok('未下载完成时安装被拒绝');
    else bad('安装拒绝语义异常', JSON.stringify(r7));

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
