'use strict';
/**
 * verify-pack-upload.js — 验证"目录打包上传"(方案 B):
 *  ① 打包路径:本地目录 → 探测通过(exec+tar+gzip)→ 本地 tar.gz → 单文件上传 → 远端 exec 解压 → 清理压缩包。
 *     断言磁盘:远端出现同名目录(含嵌套/空文件/空目录),压缩包被删,完成事件 packed=true,传输面板显示目录名。
 *  ② 无打包能力(H3C):mock 打包探测关闭 → 回退逐文件递归上传,目录照常出现在远端,不产生压缩包。
 * 运行: node verify-pack-upload.js(需 9361/2229 空闲)
 */
const { spawn } = require('child_process');
const { freePort, killTree, guardTimeout } = require('./test-helper');
const fs = require('fs'); const os = require('os'); const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-pack-'));
const MOCK_ROOT = path.join(DIR, 'mock-root');
const LOCAL = path.join(DIR, 'local');

// 场景①的目录:嵌套 + 空文件 + 空目录 + 中文名(验证 tar 保真)
const MK = (p) => fs.mkdirSync(p, { recursive: true });
MK(path.join(LOCAL, 'MyFolder', 'sub', 'deep'));
MK(path.join(LOCAL, 'MyFolder', 'empty-dir'));
fs.writeFileSync(path.join(LOCAL, 'MyFolder', 'a.txt'), 'pack upload hello\n');
fs.writeFileSync(path.join(LOCAL, 'MyFolder', 'sub', 'b.txt'), 'nested '.repeat(200));
fs.writeFileSync(path.join(LOCAL, 'MyFolder', 'sub', 'deep', '空文件.txt'), '');
// 场景②的目录:3 个文件(递归回退时 count=文件数)
MK(path.join(LOCAL, 'FallbackDir', 'sub'));
fs.writeFileSync(path.join(LOCAL, 'FallbackDir', 'a.txt'), 'fb a\n');
fs.writeFileSync(path.join(LOCAL, 'FallbackDir', 'sub', 'b.txt'), 'fb b\n');
fs.writeFileSync(path.join(LOCAL, 'FallbackDir', 'sub', 'empty.txt'), '');
// 场景③的目录:2 个已知大小的文件(H3C size 撒谎 → 验证 sftp-sizes 覆盖显示 + 跨会话持久化)
MK(path.join(LOCAL, 'SizeDir'));
fs.writeFileSync(path.join(LOCAL, 'SizeDir', 'big.dat'), Buffer.alloc(5000, 7));
fs.writeFileSync(path.join(LOCAL, 'SizeDir', 'small.txt'), 'hello size\n');

const PORT = 9361, SSH = 2229;
freePort(PORT); freePort(SSH);
process.env.MOCK_SSH_PORT = String(SSH);
process.env.MOCK_HTTP_PORT = String(SSH + 100);
process.env.MOCK_SFTP_ROOT = MOCK_ROOT;
process.env.MOCK_LIE_SIZES = '1'; // 模拟 H3C:readdir/stat 对文件恒报 size 0(场景③验证 sftp-sizes 覆盖显示)
const { start } = require('./mock/mock-server');
start();

const appProc = spawn('node_modules/.bin/electron', ['.', '--dev', `--remote-debugging-port=${PORT}`], {
  env: { ...process.env, POLARIS_LOCK_DIR: DIR, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  stdio: ['ignore', 'ignore', 'ignore'], detached: true,
});
guardTimeout(120000, appProc);
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

async function waitConnected(c, name) {
  for (let i = 0; i < 40; i++) {
    // 多标签下按会话名找对应 tab(不能用 [...tabs.keys()][0],可能拿到别的会话)
    const sid = await ev(c, `(function(){ for (const [k,t] of state.tabs) if (t.session && t.session.name==='${name}') return k; return null; })()`);
    if (sid) {
      const st = await ev(c, `state.tabs.get('${sid}').status`);
      if (st === 'connected') return sid;
    }
    await sleep(300);
  }
  throw new Error(name + ' 连接失败');
}
// 创建会话并连接,返回 sid
async function addSession(c, name) {
  await ev(c, `(async()=>{ await window.api.createSession({name:'${name}', host:'127.0.0.1', port:${SSH}, username:'admin', password:'admin123', protocol:'ssh'}); await loadSessions(); return true; })()`);
  await sleep(400);
  const json = await ev(c, `(function(){ const s=state.sessions.find(x=>x.name==='${name}'); return s?JSON.stringify(s):'NOTFOUND'; })()`);
  if (json === 'NOTFOUND') throw new Error(name + ' 未创建');
  await ev(c, `connectToServer(${json})`);
  return waitConnected(c, name);
}
// 触发一次上传(先复位 done 钩子再触发,避免竞态),等下一次 upload 完成事件
async function uploadAndWait(c, sid, folder, expectPacked) {
  await ev(c, `window.__lastSftpDone = null; window.api.sftpUploadPaths('${sid}', '/', [${JSON.stringify(folder)}]); true`);
  for (let i = 0; i < 60; i++) {
    const d = await ev(c, `window.__lastSftpDone`);
    if (d && d.op === 'upload') {
      if (expectPacked !== undefined && !!d.packed !== expectPacked) throw new Error('done.packed 不符合预期: ' + JSON.stringify(d));
      return d;
    }
    await sleep(300);
  }
  throw new Error('等待上传完成事件超时');
}
const diskHas = (rel, expectDir) => {
  const p = path.join(MOCK_ROOT, rel);
  const e = fs.existsSync(p);
  if (!e) return { ok: false, why: `磁盘缺失 ${rel}` };
  const isDir = fs.statSync(p).isDirectory();
  if (expectDir && !isDir) return { ok: false, why: `${rel} 不是目录` };
  if (expectDir === false && isDir) return { ok: false, why: `${rel} 不是文件` };
  return { ok: true };
};

(async () => {
  console.log('\n=== 目录打包上传(方案 B)验证 ===\n');
  try {
    let lockT = null;
    for (let i = 0; i < 50; i++) { lockT = (await targets()).find((t) => /解锁/.test(t.title || '')); if (lockT) break; await sleep(400); }
    if (!lockT) throw new Error('解锁页未就绪');
    const lock = await connect(lockT.webSocketDebuggerUrl);
    for (let i = 0; i < 30; i++) { if (await ev(lock, `!!document.getElementById('pw')`)) break; await sleep(300); }
    await sleep(400);
    await ev(lock, `document.getElementById('pw').value='x1234567'; document.getElementById('pw2').value='x1234567'; document.getElementById('btn').click();`);
    let main = null;
    for (let i = 0; i < 30; i++) { await sleep(500); const t2 = await targets(); const m = t2.find((t) => t.type === 'page' && !/解锁/.test(t.title || '')); if (m) { main = m; break; } }
    const c = await connect(main.webSocketDebuggerUrl);
    await sleep(1200);
    // 挂 done 钩子(渲染层本就订阅,再挂一个不影响)
    await ev(c, `window.__lastSftpDone = null; window.api.onSftpDone((d)=>{ window.__lastSftpDone = d; }); true`);
    await ev(c, `state.collapsedGroups.clear(); state.collapsedTopHost = false; state.settings.sessionView='list'; renderSessionList(''); true`);
    await sleep(300);

    // ================= ① 打包路径 =================
    console.log('  --- 场景①:打包上传(探测通过) ---');
    const sidA = await addSession(c, 'srvA');
    ok(`srvA 已连接(sid=${sidA})`);
    const d1 = await uploadAndWait(c, sidA, path.join(LOCAL, 'MyFolder'), true);
    ok(`打包完成事件 packed=true${d1.count !== undefined ? `, count=${d1.count}` : ''}`);

    // 远端磁盘:目录 + 嵌套 + 空文件 + 空目录;压缩包已删
    const checks1 = [
      ['MyFolder', true],
      ['MyFolder/a.txt', false],
      ['MyFolder/sub/b.txt', false],
      ['MyFolder/sub/deep/空文件.txt', false],
      ['MyFolder/empty-dir', true],
    ];
    let d1Bad = false;
    for (const [rel, dir] of checks1) { const r = diskHas(rel, dir); if (!r.ok) { d1Bad = true; bad(`远端 ${rel}`, r.why); } }
    if (!d1Bad) ok(`远端出现同名目录(嵌套/空文件/空目录齐全)`);
    const aContent = fs.readFileSync(path.join(MOCK_ROOT, 'MyFolder', 'a.txt'), 'utf8');
    if (aContent === 'pack upload hello\n') ok(`a.txt 内容一致`);
    else bad(`a.txt 内容不一致`, JSON.stringify(aContent));
    const bSize = fs.statSync(path.join(MOCK_ROOT, 'MyFolder', 'sub', 'b.txt')).size;
    if (bSize === fs.statSync(path.join(LOCAL, 'MyFolder', 'sub', 'b.txt')).size) ok(`sub/b.txt 大小一致(${bSize}B)`);
    else bad(`sub/b.txt 大小不一致`, `${bSize}`);
    if (!fs.existsSync(path.join(MOCK_ROOT, 'MyFolder.tar.gz'))) ok(`远端压缩包 MyFolder.tar.gz 已清理`);
    else bad(`远端压缩包未清理`, null);
    const rowName = await ev(c, `(function(){ const r=[...document.querySelectorAll('.st-name')].map(x=>x.textContent); return JSON.stringify(r); })()`);
    if (rowName.includes('MyFolder')) ok(`传输面板显示目录名(非压缩包名): ${rowName}`);
    else bad(`传输面板目录名异常`, rowName);

    // ================= ② 无打包能力(H3C) =================
    console.log('  --- 场景②:打包探测关闭(H3C)→ 回退逐文件递归上传 ---');
    await fetch(`http://127.0.0.1:${SSH + 100}/mock/pack`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }) });
    const sidB = await addSession(c, 'srvB');
    ok(`srvB 已连接(sid=${sidB})`);
    const d2 = await uploadAndWait(c, sidB, path.join(LOCAL, 'FallbackDir'), false);
    ok(`递归完成事件 packed=${!!d2.packed} ok=${d2.ok}(done.count=${d2.count} 为路径数)`);
    // 递归路径:传输面板按文件出多行(证明走的是逐文件递归,不是打包)
    const rows2 = await ev(c, `(function(){ return JSON.stringify([...document.querySelectorAll('.st-name')].map(x=>x.textContent)); })()`);
    const perFile = ['a.txt', 'b.txt', 'empty.txt'].every((n) => rows2.includes(n));
    if (perFile) ok(`递归逐文件上传(面板出现逐文件行): ${rows2}`);
    else bad(`递归未出现逐文件行`, rows2);
    let d2Bad = false;
    for (const rel of ['FallbackDir', 'FallbackDir/a.txt', 'FallbackDir/sub/b.txt', 'FallbackDir/sub/empty.txt']) {
      const r = diskHas(rel, rel === 'FallbackDir');
      if (!r.ok) { d2Bad = true; bad(`远端 ${rel}`, r.why); }
    }
    if (!d2Bad) ok(`递归后目录照常出现在远端`);
    if (!fs.existsSync(path.join(MOCK_ROOT, 'FallbackDir.tar.gz'))) ok(`递归路径未产生压缩包`);
    else bad(`递归路径不应有压缩包`, null);

    // ================= ③ H3C size 撒谎 → 覆盖显示 + 跨会话持久化 =================
    console.log('  --- 场景③:mock 恒报文件 size 0(H3C)→ sftp-sizes 覆盖显示,跨会话仍正确 ---');
    const sidC = await addSession(c, 'srvC');
    ok(`srvC 已连接(sid=${sidC})`);
    await uploadAndWait(c, sidC, path.join(LOCAL, 'SizeDir'), false); // 递归路径(pack 已关)→ 逐文件记录真实大小
    const expArr = JSON.stringify([['big.dat', 5000], ['small.txt', 11]]);
    const listFn = (sid) => `(async () => { const r = await window.api.sftpList('${sid}', '/SizeDir'); return r.ok ? JSON.stringify(r.entries.map(e=>[e.name,e.size]).sort()) : 'ERR:'+r.error; })()`;
    const sizesC = await ev(c, listFn(sidC));
    if (sizesC === expArr) ok(`同会话列表显示真实大小(覆盖设备报的 0): ${sizesC}`);
    else bad(`同会话列表应覆盖为真实大小`, `${sizesC} vs ${expArr}`);
    // 跨会话:另起一个从未上传过的连接(同一 hostId)→ 列表仍显示真实大小 → 持久化 + hostId 键生效
    const sidD = await addSession(c, 'srvD');
    ok(`srvD 已连接(sid=${sidD}, 与 srvC 同 hostId,从未上传过)`);
    const sizesD = await ev(c, listFn(sidD));
    if (sizesD === expArr) ok(`跨会话列表仍显示真实大小(磁盘持久化 + hostId 键)`);
    else bad(`跨会话应仍覆盖显示`, `${sizesD} vs ${expArr}`);

    console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  } catch (e) { console.error('\n测试异常:', e && e.message); failed++; console.log(`\n结果: ${passed} 通过, ${failed} 失败`); }
  try { killTree(appProc); } catch {}
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch {}
  process.exit(failed ? 1 : 0);
})();
