'use strict';
/**
 * verify-sftp-download-many.js — 文件夹/多文件下载的健壮性回归
 *   用户症状:「文件夹下载,多文件下载失败」。真实成因有三类(本脚本逐条锁死):
 *   ① 某个子目录列不出来(无权限/设备限制)→ 旧版整批 aborts,一个文件都不下
 *   ② 批量并发(2 路)在 H3C/KoKo 类"SFTP 串行处理"设备上部分文件失败,单文件却正常
 *   ③ 符号链接指向目录时被当文件下载 → 逐文件失败
 *   另外锁死两个观感问题:批量进度 total 被遮蔽(总进度恒 100%)、目录被误传 isDir:false。
 * 断言:
 *   1 目录(含中文/空格/#/空文件/空目录/软链)整体下载成功,文件字节与源一致
 *   2 软链到目录会递归下载(不是当文件读失败)
 *   3 软链到文件按文件下载
 *   4 空目录会在本地建出来
 *   5 子目录无权限时:其它文件照常成功 + 该目录作为失败项回传(不再整批失败)
 *   6 首次读失败的文件会被串行重试成功(results.retried=true + 日志「下载重试成功」)
 *   7 批量进度 total = 全批总字节(done ≤ total,不再恒 100%)
 *   8 传 isDir:false 的目录仍按目录递归(服务端 stat 兜底)
 *   9 空目录整批 results 为空也判成功(不会静默无反馈)
 * 运行: node verify-sftp-download-many.js(需 9401/2292/2392 空闲)
 */
const { spawn, execSync } = require('child_process');
const { freePort, killTree, guardTimeout, evaluate } = require('./test-helper');
const fs = require('fs'); const os = require('os'); const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-dlmany-'));
const MOCK_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-dlmany-disk-'));
const DL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-dlmany-out-'));

// ---- 造远程树:嵌套 / 中文 / 空格 / # / 空文件 / 空目录 / 软链(目录+文件) / 无权限目录 / 一次读失败 ----
const W = (rel, content) => { const p = path.join(MOCK_ROOT, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); };
W('big/a.txt', 'AAA\n'.repeat(1000));                    // 4000B
W('big/中文 目录/深/更深/中.txt', '中文内容\n');            // 13B
W('big/empty.txt', '');                                  // 0B
W('big/空格 名字#1.txt', 'special chars\n');
fs.mkdirSync(path.join(MOCK_ROOT, 'big/emptydir'), { recursive: true });
fs.mkdirSync(path.join(MOCK_ROOT, 'big/中文 目录/深'), { recursive: true });
let canLink = true;
try {
  fs.symlinkSync('中文 目录/深', path.join(MOCK_ROOT, 'big/link-dir'));  // 软链 → 目录
  fs.symlinkSync('a.txt', path.join(MOCK_ROOT, 'big/link-file'));        // 软链 → 文件
} catch { canLink = false; }
// 无权限目录(MOCK_SFTP_FAIL_READDIR 注入 OPENDIR 权限错误)
W('locked/secret.txt', 'cannot list me\n');
// 首次 READ 失败、重试才成功的文件
W('retry/once.txt', 'retry me please\n');

const PORT = 9401, SSH = 2292, HTTP = 2392;
try { execSync('pkill -f "polaris-terminal/node_modules/electron" 2>/dev/null'); } catch { /* 无残留 */ }
freePort(PORT); freePort(SSH); freePort(HTTP);
process.env.MOCK_SSH_PORT = String(SSH);
process.env.MOCK_HTTP_PORT = String(HTTP);
process.env.MOCK_SFTP_ROOT = MOCK_ROOT;
process.env.POLARIS_AUTO_DL_DIR = DL_DIR;
require('./mock/mock-server').start();

const appProc = spawn(require('electron'), ['.', '--dev', `--remote-debugging-port=${PORT}`, '--no-sandbox', '--disable-gpu'], {
  env: { ...process.env, POLARIS_LOCK_DIR: DIR, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  stdio: ['ignore', 'ignore', 'ignore'], detached: true,
});
guardTimeout(200000, appProc);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function targets() {
  for (let i = 0; i < 75; i++) {
    try { const j = await (await fetch(`http://127.0.0.1:${PORT}/json`, { signal: AbortSignal.timeout(3000) })).json(); if (j.some((t) => t.type === 'page')) return j; } catch { /* not ready */ }
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
let passed = 0, failed = 0;
const ok = (n) => { passed++; console.log('  ✓ ' + n); };
const bad = (n, e) => { failed++; console.error('  ✗ ' + n + (e ? ' → ' + e : '')); };

(async () => {
  console.log('\n=== 文件夹 / 多文件下载健壮性 ===\n');
  try {
    const t0 = await targets();
    const lockT = t0.find((t) => /解锁/.test(t.title || '')) || t0.find((t) => t.type === 'page');
    const lock = await connect(lockT.webSocketDebuggerUrl);
    for (let i = 0; i < 30; i++) { if (await evaluate(lock, `!!document.getElementById('pw')`)) break; await sleep(300); }
    await evaluate(lock, `document.getElementById('pw').value='x1234567'; document.getElementById('pw2').value='x1234567'; document.getElementById('btn').click();`);
    let main = null;
    for (let i = 0; i < 30 && !main; i++) { await sleep(500); main = (await targets()).find((t) => t.type === 'page' && !/解锁/.test(t.title || '')); }
    if (!main) throw new Error('主窗口未就绪');
    const c = await connect(main.webSocketDebuggerUrl);
    await sleep(1000);
    await evaluate(c, `(function(){ state.settings.onboardingDone=true; saveSettings(); var om=document.getElementById('onboarding-modal'); if(om) om.classList.add('hidden'); state.settings.verifyHostKey=false; state.settings.autoTrustHostKey=true; return true; })()`);
    await evaluate(c, `(async()=>{ await window.api.createSession({name:'dlm', host:'127.0.0.1', port:${SSH}, username:'admin', password:'admin123', protocol:'ssh'}); await loadSessions(); return true; })()`);
    await sleep(400);
    const sj = await evaluate(c, `(function(){ const s=state.sessions.find(x=>x.name==='dlm'); return JSON.stringify(s); })()`);
    await evaluate(c, `connectToServer(${sj})`);
    let sid = null;
    for (let i = 0; i < 30; i++) { sid = await evaluate(c, `(state.tabs.size ? [...state.tabs.keys()][0] : null)`); if (sid && await evaluate(c, `state.tabs.get('${sid}').status`) === 'connected') break; await sleep(300); }
    if (!sid) throw new Error('连接失败');
    await evaluate(c, `(function(){ window.__prog=[]; window.__done=[]; window.api.onSftpProgress(function(p){ window.__prog.push(p); }); window.api.onSftpDone(function(d){ window.__done.push(d); }); return true; })()`);

    // 单次批量下载并等完成事件
    const run = async (entries, label) => {
      await evaluate(c, `window.__prog.length=0; window.__done.length=0; true`);
      const r = await evaluate(c, `(async()=>{ const r=await window.api.sftpDownloadMany('${sid}', ${JSON.stringify(entries)}); return JSON.stringify(r); })()`);
      const j = JSON.parse(r);
      for (let i = 0; i < 120; i++) { if ((await evaluate(c, `window.__done.length`)) > 0) break; await sleep(300); }
      const done = JSON.parse(await evaluate(c, `JSON.stringify(window.__done[0]||null)`));
      if (!done) throw new Error(label + ' 未收到完成事件(jobId=' + (j.jobId || r) + ')');
      return { job: j, done };
    };

    // ---------- A) 完整目录(含软链/空目录/特殊字符),并注入"首次读失败"验证串行重试 ----------
    process.env.MOCK_SFTP_FAIL_READ_ONCE = 'big/a.txt';
    delete process.env.MOCK_SFTP_FAIL_READDIR;
    let A = await run([{ remotePath: '/big', isDir: true }], 'A');
    if (A.done.ok) ok('① 目录整体下载成功(results=' + A.done.results.length + ')');
    else bad('① 目录下载失败', JSON.stringify(A.done.failed || A.done).slice(0, 300));
    const exp = {
      'a.txt': 4000,
      '中文 目录/深/更深/中.txt': 13,
      'empty.txt': 0,
      '空格 名字#1.txt': 14,
    };
    for (const [rel, size] of Object.entries(exp)) {
      const p = path.join(DL_DIR, 'big', rel);
      const goodSize = fs.existsSync(p) && fs.statSync(p).size === size;
      if (goodSize) ok('① 本地文件正确:big/' + rel + ' (' + size + 'B)');
      else bad('① 本地文件缺失/大小不符:big/' + rel, fs.existsSync(p) ? fs.statSync(p).size + 'B' : '缺失');
    }
    if (canLink) {
      const deepLink = path.join(DL_DIR, 'big/link-dir/更深/中.txt');
      if (fs.existsSync(deepLink) && fs.statSync(deepLink).size === 13) ok('② 软链→目录 被递归下载(link-dir/更深/中.txt)');
      else bad('② 软链→目录 没被递归(被当文件下载了)', JSON.stringify(fs.existsSync(path.join(DL_DIR, 'big')) ? fs.readdirSync(path.join(DL_DIR, 'big')) : null));
      const linkFile = path.join(DL_DIR, 'big/link-file');
      if (fs.existsSync(linkFile) && fs.statSync(linkFile).size === 4000) ok('③ 软链→文件 按文件下载(4000B)');
      else bad('③ 软链→文件 未正确下载', fs.existsSync(linkFile) ? fs.statSync(linkFile).size + 'B' : '缺失');
    }
    const ed = path.join(DL_DIR, 'big/emptydir');
    if (fs.existsSync(ed) && fs.statSync(ed).isDirectory()) ok('④ 空目录在本地建出来了');
    else bad('④ 空目录没建出来');
    const retried = (A.done.results || []).some((r) => r && r.retried && /a\.txt$/.test(r.remotePath));
    if (retried) ok('⑥ 首次读失败的文件被串行重试成功(标记 retried)');
    else bad('⑥ 失败项串行重试没生效', JSON.stringify((A.done.results || []).filter((r) => !r || !r.ok).slice(0, 3)));
    delete process.env.MOCK_SFTP_FAIL_READ_ONCE;

    // ⑦ 批量进度 total = 全批总字节
    const prog = JSON.parse(await evaluate(c, `JSON.stringify(window.__prog.slice(-1))`));
    const last = prog[0] || {};
    if (typeof last.total === 'number' && last.total > 0 && last.done <= last.total) ok(`⑦ 批量进度 total 正确(${last.done}/${last.total})`);
    else bad('⑦ 批量进度 total 被遮蔽(总进度恒 100%)', JSON.stringify(last));

    // ---------- B) 无权限子目录:其它文件照常成功 + 失败项回传 ----------
    process.env.MOCK_SFTP_FAIL_READDIR = 'big/中文 目录';
    const B = await run([{ remotePath: '/big', isDir: true }], 'B');
    delete process.env.MOCK_SFTP_FAIL_READDIR;
    const bFail = (B.done.failed || []);
    const bFailHit = bFail.some((f) => /中文 目录/.test(f.remotePath || '') || /无法列出目录/.test(f.error || ''));
    if (bFailHit) ok('⑤ 子目录无权限 → 记为失败项并回传:' + JSON.stringify(bFail[0]).slice(0, 120));
    else bad('⑤ 无权限子目录没有回传失败项', JSON.stringify(B.done).slice(0, 300));
    const bOthers = ['a.txt', 'empty.txt'].every((f) => fs.existsSync(path.join(DL_DIR, 'big', f)));
    if (bOthers && B.done.ok) ok('⑤ 同目录其它文件照常下载成功(不再整批 aborts)');
    else bad('⑤ 一个子目录失败把整批搞挂了', JSON.stringify({ ok: B.done.ok, a: fs.existsSync(path.join(DL_DIR, 'big', 'a.txt')) }));

    // ---------------------------- C) 目录被误传 isDir:false → stat 兜底仍按目录下载 ----------------------------
    const C = await run([{ remotePath: '/big', isDir: false }], 'C');
    const cOk = C.done.ok && (C.done.results || []).length >= 4 && fs.existsSync(path.join(DL_DIR, 'big/中文 目录/深/更深/中.txt'));
    if (cOk) ok('⑧ isDir:false 的目录仍按目录递归下载(results=' + C.done.results.length + ')');
    else bad('⑧ 目录被当文件下载失败了', JSON.stringify(C.done).slice(0, 300));

    // ---------------------------- D) 空目录 batch:results 为空也算成功 ----------------------------
    const D = await run([{ remotePath: '/big/emptydir', isDir: true }], 'D');
    if (D.done.ok && (D.done.results || []).length === 0 && fs.existsSync(path.join(DL_DIR, 'emptydir'))) ok('⑨ 空目录下载 = 成功且本地目录存在');
    else bad('⑨ 空目录下载被判失败/无反馈', JSON.stringify(D.done).slice(0, 200));

    // 界面:失败行 + 状态栏
    const ui = JSON.parse(await evaluate(c, `(function(){
      const rows=[...document.querySelectorAll('#sftp-transfers-list .sftp-transfer-row')];
      return JSON.stringify({ fail: rows.filter(r=>r.classList.contains('fail')).length,
        status: (document.getElementById('toolbar-status')||{}).textContent || '' });
    })()`));
    if (ui.fail >= 1) ok('界面有「✗ 失败」传输行(' + ui.fail + ' 条)');
    else bad('界面上没有任何失败痕迹(用户报的"点了没反应")', JSON.stringify(ui));

    // 日志:重试成功 / 无权限目录
    let logTxt = '';
    try { logTxt = fs.readdirSync(path.join(DIR, 'logs')).filter((f) => f.startsWith('app-')).map((f) => fs.readFileSync(path.join(DIR, 'logs', f), 'utf8')).join('\n'); } catch { /* ignore */ }
    if (/下载重试成功/.test(logTxt)) ok('日志有「下载重试成功」记录');
    else bad('日志没有串行重试记录', logTxt.slice(-200));

    console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  } catch (e) { console.error('\n测试异常:', e && (e.stack || e.message)); failed++; console.log(`\n结果: ${passed} 通过, ${failed} 失败`); }
  try { killTree(appProc); } catch { /* ignore */ }
  for (const d of [MOCK_ROOT, DL_DIR]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
  process.exit(failed ? 1 : 0);
})();
