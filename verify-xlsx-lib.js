'use strict';
/**
 * verify-xlsx-lib.js — xlsx 依赖替换后的回归(SheetJS 官方 0.20.3 tarball)
 *   背景:npm 上的 xlsx@0.18.5 有 2 个 high(原型污染/ReDoS)且 fixAvailable:false(线上止于 0.18.5),
 *        已按评估换成官方 CDN tarball 0.20.3(API 一致 → 业务代码零改动)。
 *   断言:① 版本是 0.20.3(防悄悄退回旧 npm 线)
 *        ② 主进程那条链路(session-groups 的模板生成调用)原样可用 → 双 sheet 模板正确
 *        ③ 渲染层 dist 在 Chromium 里可用(script 标签/CSP 没挡住),能读主进程造的 .xlsx
 * 运行: node verify-xlsx-lib.js(需 9378 空闲)
 */
const { spawn, execSync } = require('child_process');
const { freePort, killTree, guardTimeout } = require('./test-helper');
const fs = require('fs'); const os = require('os'); const path = require('path');
const XLSX = require('xlsx');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-xlsx-'));
const PORT = 9387, SSH = 2254;
let passed = 0, failed = 0;
const ok = (n) => { passed++; console.log('  ✓ ' + n); };
const bad = (n, e) => { failed++; console.error('  ✗ ' + n + (e ? ' → ' + e : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log('\n=== xlsx 0.20.3(官方 tarball)回归 ===\n');
  try {
    // ① 版本
    if (XLSX.version === '0.20.3') ok(`① 主进程侧 xlsx 版本 = ${XLSX.version}`);
    else bad('① 版本不是 0.20.3(可能退回了 npm 旧线)', String(XLSX.version));

    // ② 复刻 lib/session-groups.js 的模板生成调用,原样不改编
    const ws = XLSX.utils.aoa_to_sheet([
      ['名称', '主机', '端口', '用户名', '密码', '分组'],
      ['示例服务器A', '192.0.2.10', '22', 'root', 'password123', '生产'],
      ['', '192.0.2.11', '22', 'ubuntu', '', '测试'],
    ]);
    ws['!cols'] = [{ wch: 16 }, { wch: 16 }, { wch: 8 }, { wch: 14 }, { wch: 16 }, { wch: 10 }];
    const note = XLSX.utils.aoa_to_sheet([['填写说明'], ['1. 在"主机列表"表里填你的服务器,首行表头不要动。']]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '主机列表');
    XLSX.utils.book_append_sheet(wb, note, '说明');
    const tpl = path.join(DIR, 'template.xlsx');
    XLSX.writeFile(wb, tpl);
    const back = XLSX.read(fs.readFileSync(tpl));
    const rows = XLSX.utils.sheet_to_json(back.Sheets[back.SheetNames[0]], { header: 1, defval: '' });
    if (back.SheetNames.join('|') === '主机列表|说明' && rows.length === 3 && rows[0][0] === '名称' && rows[2][1] === '192.0.2.11') {
      ok(`② 模板生成/读回正确(${back.SheetNames.join('/')},${rows.length} 行)`);
    } else bad('② 模板生成或读回异常', JSON.stringify({ names: back.SheetNames, rows }));

    // ③ 渲染层:dist 可用 + 能读主进程造的这份 .xlsx
    try { execSync('pkill -f "polaris-terminal/node_modules/electron" 2>/dev/null'); } catch { /* 无残留 */ }
    freePort(PORT); freePort(SSH);
    process.env.MOCK_SSH_PORT = String(SSH);
    process.env.MOCK_HTTP_PORT = String(SSH + 100);
    const appProc = spawn('node_modules/.bin/electron', ['.', '--dev', `--remote-debugging-port=${PORT}`], {
      env: { ...process.env, POLARIS_LOCK_DIR: DIR, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
      stdio: ['ignore', 'ignore', 'ignore'], detached: true,
    });
    guardTimeout(150000, appProc);
    async function targets() {
      for (let i = 0; i < 60; i++) {
        try { const r = await fetch(`http://127.0.0.1:${PORT}/json`, { signal: AbortSignal.timeout(3000) }); const j = await r.json(); const p = j.find((t) => t.type === 'page' && /解锁|Polaris/.test(t.title || '')); if (p) return j; } catch { /* not ready */ }
        await sleep(400);
      }
      throw new Error('targets 未就绪');
    }
    function connect(url) {
      return new Promise((resolve, reject) => {
        const ws2 = new WebSocket(url); let id = 0; const pending = new Map();
        ws2.onopen = () => resolve({ call(m, p = {}) { return new Promise((res) => { const mid = ++id; pending.set(mid, res); ws2.send(JSON.stringify({ id: mid, method: m, params: p })); }); }, close() { ws2.close(); } });
        ws2.onerror = (e) => reject(e);
        ws2.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };
      });
    }
    async function ev(c, expr) {
      const r = await c.call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error('JS异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
      return r.result && r.result.value;
    }
    let lockT = null;
    for (let i = 0; i < 50; i++) { lockT = (await targets()).find((t) => /解锁/.test(t.title || '')); if (lockT) break; await sleep(400); }
    const lock = await connect(lockT.webSocketDebuggerUrl);
    for (let i = 0; i < 30; i++) { if (await ev(lock, `!!document.getElementById('pw')`)) break; await sleep(300); }
    await sleep(300);
    await ev(lock, `document.getElementById('pw').value='x1234567'; document.getElementById('pw2').value='x1234567'; document.getElementById('btn').click();`);
    let main = null;
    for (let i = 0; i < 30; i++) { await sleep(500); const t2 = await targets(); const m = t2.find((t) => t.type === 'page' && !/解锁/.test(t.title || '')); if (m) { main = m; break; } }
    const c = await connect(main.webSocketDebuggerUrl);
    await sleep(800);

    const v = await ev(c, `(typeof XLSX === 'object' && XLSX && XLSX.version) || 'NONE'`);
    if (v === '0.20.3') ok('③ 渲染层 dist 可用且版本一致(XLSX.version = 0.20.3)');
    else bad('③ 渲染层 xlsx 未加载或版本不符', String(v));

    const b64 = fs.readFileSync(tpl).toString('base64');
    const readBack = await ev(c, `(function(){
      const bin = atob(${JSON.stringify(b64)});
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const wb2 = XLSX.read(arr, { type: 'array' });
      const rows2 = XLSX.utils.sheet_to_json(wb2.Sheets[wb2.SheetNames[0]], { header: 1, defval: '' });
      return JSON.stringify({ names: wb2.SheetNames, n: rows2.length, host: rows2[2] ? rows2[2][1] : null });
    })()`);
    const rb = JSON.parse(readBack);
    if (rb.names.join('|') === '主机列表|说明' && rb.n === 3 && rb.host === '192.0.2.11') ok(`③ 渲染层读主进程造的模板成功(${rb.names.join('/')},第3行主机=${rb.host})`);
    else bad('③ 渲染层读取失败', readBack);
    try { killTree(appProc); } catch { /* ignore */ }
  } catch (e) { console.error('\n测试异常:', e && e.message); failed++; }
  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(failed ? 1 : 0);
})();
