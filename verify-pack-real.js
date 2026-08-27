'use strict';
/**
 * verify-pack-real.js — 真实 Linux 主机上验证"目录打包上传"(方案 B)全链路:
 *   探测(真实 tar/gzip)→ 本地纯 JS tar 打包 → SFTP 单文件上传 → 远端 tar -xzf 解压 → 清理压缩包。
 * 凭据只走环境变量(CLAUDE.md 安全红线:真实凭据绝不在代码里留默认密码):
 *   REAL_PASS(必填)  REAL_HOST(默认 10.211.55.5)  REAL_PORT(22)  REAL_USER(root)
 * 流程:boot app → sshConnect 真机 → 造本地小文件目录 → sftpUploadPaths 上传 →
 *       done.packed=true → sftpList 递归核验远端文件数/目录数/字节数与本地一致、压缩包已清理 →
 *       sftpRmdir 清理远端测试目录。
 * 运行: REAL_PASS='...' node verify-pack-real.js
 */
const { spawn } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path');

const HOST = process.env.REAL_HOST || '10.211.55.5';
const PORT = parseInt(process.env.REAL_PORT || '22', 10);
const USER = process.env.REAL_USER || 'root';
const PASS = process.env.REAL_PASS || '';
if (!PASS) { console.error('请设置环境变量 REAL_PASS 传入真实主机密码(如 REAL_PASS=\'...\' node verify-pack-real.js)'); process.exit(1); }

const OUT = process.env.VERIFY_OUT || os.tmpdir() + '/verify-pack-real-result.txt';
const w = (s) => { try { fs.appendFileSync(OUT, s + '\n'); } catch {} };

function freePort(p) { try { require('child_process').execSync(`lsof -ti tcp:${p} | xargs kill -9 2>/dev/null`); } catch {} }
function killTree(proc) { try { if (proc && proc.pid) process.kill(-proc.pid, 'SIGKILL'); } catch {} }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function targets(PORT) {
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json`); const j = await r.json(); const p = j.find((t) => t.type === 'page' && /解锁|Polaris/.test(t.title || '')); if (p) return j; } catch {}
    await sleep(400);
  }
  throw new Error('CDP targets 未就绪');
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
  if (r.exceptionDetails) throw new Error('JS异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 600) + ' @ ' + expr.slice(0, 120));
  return r.result && r.result.value;
}

// 本地目录树 + 统计
const RAND = Date.now();
const LOCAL_ROOT = path.join(os.tmpdir(), 'polaris-pack-real-src-' + RAND);
const FOLDER = 'polaris-pack-real';
const SRC = path.join(LOCAL_ROOT, FOLDER);
(function build() {
  const mk = (p) => fs.mkdirSync(p, { recursive: true });
  mk(path.join(SRC, 'empty-dir'));
  for (let d = 0; d < 8; d++) {
    const dir = path.join(SRC, 'dir' + d);
    mk(path.join(dir, 'deep'));
    for (let f = 0; f < 12; f++) fs.writeFileSync(path.join(dir, 'f' + f + '.txt'), ('x'.repeat(512) + '\n').repeat(1 + f * 3));
    fs.writeFileSync(path.join(dir, 'deep', 'note.md'), '# deep ' + d + '\n');
  }
  fs.writeFileSync(path.join(SRC, 'empty.txt'), ''); // 空文件
})();
function walkLocal(dir, acc = { files: 0, dirs: 0, bytes: 0 }) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { acc.dirs++; walkLocal(p, acc); }
    else { acc.files++; acc.bytes += fs.statSync(p).size; }
  }
  return acc;
}
const LOCAL_STAT = walkLocal(SRC);

async function main() {
  fs.writeFileSync(OUT, '');
  const CDP = 9417;
  const DIR = fs.mkdtempSync(os.tmpdir() + '/polaris-packreal-');
  freePort(CDP);
  const app = spawn('node_modules/.bin/electron', ['.', '--dev', `--remote-debugging-port=${CDP}`, '--no-sandbox', '--disable-gpu'], {
    env: { ...process.env, POLARIS_LOCK_DIR: DIR, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
    stdio: 'ignore', detached: true,
  });
  setTimeout(() => killTree(app), 180000);
  let c = null; // 函数级:finally 清理远端也要用
  let remoteDir = null;
  const sid = 'sess-real';

  try {
    console.log(`\n=== 真机打包上传验证 → ${USER}@${HOST}:${PORT} ===\n`);
    const ts = await targets(CDP);
    const lock = await connect(ts.find((t) => /解锁/.test(t.title || '')).webSocketDebuggerUrl);
    for (let i = 0; i < 30; i++) { if (await ev(lock, `!!document.getElementById('pw')`)) break; await sleep(300); }
    await sleep(300);
    await ev(lock, `document.getElementById('pw').value='x12345678'; document.getElementById('pw2').value='x12345678'; document.getElementById('btn').click();`);
    for (let i = 0; i < 30; i++) { await sleep(500); const t2 = await targets(CDP); const m = t2.find((t) => t.type === 'page' && !/解锁/.test(t.title || '')); if (m) { c = await connect(m.webSocketDebuggerUrl); break; } }
    if (!c) throw new Error('主窗口未出现');
    await ev(c, `window.__lastSftpDone = null; window.api.onSftpDone((d)=>{ window.__lastSftpDone = d; }); true`);

    // 直连真机
    const cc = await ev(c, `(async () => { const r = await window.api.sshConnect('${sid}', { host: ${JSON.stringify(HOST)}, port: ${PORT}, username: ${JSON.stringify(USER)}, password: ${JSON.stringify(PASS)}, cols: 80, rows: 24, verifyHostKey: false, autoTrustHostKey: true, sessionName: '真机打包验证' }); return r; })()`);
    if (!cc || !cc.ok) throw new Error('sshConnect 失败: ' + JSON.stringify(cc).slice(0, 300));
    console.log('  已连接真机');
    // 补一个 tab(渲染层 sftp 面板绑定用,IPC 调用不依赖但保持一致)
    await ev(c, `(async () => { const t = { sessionId: '${sid}', session: { name: '真机打包验证', host: ${JSON.stringify(HOST)}, port: ${PORT}, username: ${JSON.stringify(USER)} }, status: 'connected', sftpPath: '.', shellCwd: null }; state.tabs.set('${sid}', t); state.activeSessionId = '${sid}'; return true; })()`);

    // 家目录探测(真实 pwd):上传目标
    const home = await ev(c, `window.api.sftpHome('${sid}')`);
    if (!home || !home.ok) throw new Error('sftpHome 失败: ' + JSON.stringify(home).slice(0, 300));
    const targetDir = home.home === '/' ? '/' : home.home;
    console.log('  远端家目录:', targetDir);

    // 上传本地目录(路径走 sftpUploadPaths = 拖拽同款入口)
    const localAbs = SRC;
    remoteDir = (targetDir === '/' ? '' : targetDir) + '/' + FOLDER;
    await ev(c, `window.__lastSftpDone = null; window.api.sftpUploadPaths('${sid}', ${JSON.stringify(targetDir)}, [${JSON.stringify(localAbs)}]); true`);
    let done = null;
    for (let i = 0; i < 90; i++) { done = await ev(c, `window.__lastSftpDone`); if (done && done.op === 'upload') break; await sleep(300); }
    if (!done || done.op !== 'upload') throw new Error('上传完成事件超时');
    console.log('  done:', JSON.stringify({ ok: done.ok, packed: done.packed, count: done.count, cancelled: done.cancelled }));

    const pass1 = !!(done.ok && done.packed === true);
    if (pass1) console.log('  ✓ 走打包上传路径(done.packed=true)');
    else { w('RESULT ' + JSON.stringify({ pass: false, stage: 'packed-flag', done })); throw new Error('未走打包路径, packed=' + done.packed); }

    // 远端核验:递归 walk,与本地比对文件数/目录数/字节数
    await ev(c, `window.__sftpWalk = async (sid, p) => {
      const list = await window.api.sftpList(sid, p);
      if (!list || !list.ok) return { err: list && list.error, files: 0, dirs: 0, bytes: 0 };
      let files = 0, dirs = 0, bytes = 0;
      for (const e of list.entries) {
        const sub = p === '/' ? '/' + e.name : p.replace(/\\/$/, '') + '/' + e.name;
        if (e.isDir) { dirs++; const r = await window.__sftpWalk(sid, sub); files += r.files; dirs += r.dirs; bytes += r.bytes; }
        else { files++; bytes += (e.size || 0); }
      }
      return { files, dirs, bytes };
    }; true`);
    await sleep(300);
    const R = await ev(c, `window.__sftpWalk('${sid}', ${JSON.stringify(remoteDir)})`);
    console.log('  远端核验:', JSON.stringify(R), ' vs 本地', JSON.stringify(LOCAL_STAT));
    const pass2 = !R.err && R.files === LOCAL_STAT.files && R.dirs === LOCAL_STAT.dirs && R.bytes === LOCAL_STAT.bytes;
    if (pass2) console.log(`  ✓ 远端结构一致(文件 ${R.files}/${LOCAL_STAT.files} · 目录 ${R.dirs}/${LOCAL_STAT.dirs} · 字节 ${R.bytes}/${LOCAL_STAT.bytes})`);
    else { w('RESULT ' + JSON.stringify({ pass: false, stage: 'structure', R, L: LOCAL_STAT })); throw new Error('远端结构与本地不一致: ' + JSON.stringify({ R, L: LOCAL_STAT })); }

    // 压缩包已清理
    const parent = await ev(c, `window.api.sftpList('${sid}', ${JSON.stringify(targetDir)})`);
    const leftArchive = parent.ok && parent.entries.some((e) => e.name === FOLDER + '.tar.gz');
    if (!leftArchive) console.log('  ✓ 远端无残留压缩包 ' + FOLDER + '.tar.gz');
    else { w('RESULT ' + JSON.stringify({ pass: false, stage: 'archive-leftover' })); throw new Error('远端残留压缩包 ' + FOLDER + '.tar.gz'); }

    // 传输面板显示目录名
    const row = await ev(c, `[...document.querySelectorAll('.st-name')].map(x=>x.textContent)`);
    if (row.includes(FOLDER)) console.log('  ✓ 传输面板显示目录名:', JSON.stringify(row));
    else console.log('  - 传输面板行(未要求):', JSON.stringify(row));

    w('RESULT ' + JSON.stringify({ pass: true, host: HOST + ':' + PORT, user: USER, packed: true, files: LOCAL_STAT.files, dirs: LOCAL_STAT.dirs, bytes: LOCAL_STAT.bytes }));
    console.log(`\n结果: 全部通过 ✅ (打包上传 ${LOCAL_STAT.files} 文件 / ${LOCAL_STAT.dirs} 目录 / ${LOCAL_STAT.bytes}B)`);
    process.exit(0);
  } catch (e) {
    w('ERROR ' + (e && e.stack || String(e)).slice(0, 600));
    console.error('\n验证失败:', e && e.message);
    console.log(`\n结果: 失败 ❌ (详情见 ${OUT})`);
    process.exit(1);
  } finally {
    // 清理远端测试目录(尽力)
    try {
      if (c && remoteDir) await ev(c, `window.api.sftpRmdir('${sid}', ${JSON.stringify(remoteDir)})`);
    } catch {}
    killTree(app);
    try { fs.rmSync(LOCAL_ROOT, { recursive: true, force: true }); } catch {}
  }
}
main();
