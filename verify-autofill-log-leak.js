'use strict';
/**
 * verify-autofill-log-leak.js — 密码绝不落盘:自动填充/含密码的输入不进会话日志与录制
 *   背景:自动填充走 window.api.sshWrite → 主进程 ssh:write 会把所有输入写进会话日志
 *        (lib/session-log)与录制 → 数据目录下明文 .log/.jsonl 里出现账号密码。
 *   修法:① 调用方 opts.noLog(自动填充)② 主进程兜底:文本含该会话密码一律跳过。
 *   断言:① 终端不回显密码 ② 调试面板无明文 ③ 会话日志无密码明文(核心)
 *        ④ 录制里的"输入事件"不含密码(含不带 noLog 的调用方 —— 兜底脱敏)
 *        ⑤ 正向对照:普通命令仍照常进日志/录制(防过度脱敏把审计打没了)
 * 运行: node verify-autofill-log-leak.js(需 9370/2245 空闲)
 */
const { spawn, execSync } = require('child_process');
const { freePort, killTree, guardTimeout } = require('./test-helper');
const fs = require('fs'); const os = require('os'); const path = require('path');
const zlib = require('zlib');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-autofill-leak-'));
const PORT = 9370, SSH = 2245;
try { execSync('pkill -f "polaris-terminal/node_modules/electron" 2>/dev/null'); } catch { /* 无残留 */ }
freePort(PORT); freePort(SSH);
process.env.MOCK_SSH_PORT = String(SSH);
process.env.MOCK_HTTP_PORT = String(SSH + 100);
process.env.MOCK_SUDO_PW = 'admin123'; // 会话密码即 sudo 密码
const { start } = require('./mock/mock-server');
start();

const appProc = spawn('node_modules/.bin/electron', ['.', '--dev', `--remote-debugging-port=${PORT}`], {
  env: { ...process.env, POLARIS_LOCK_DIR: DIR, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  stdio: ['ignore', 'ignore', 'ignore'], detached: true,
});
guardTimeout(180000, appProc);
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
const PW = 'admin123';

(async () => {
  console.log('\n=== 密码不落盘:自动填充 / 含密码输入 ===\n');
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

    await ev(c, `(async()=>{ state.settings.verifyHostKey=false; state.settings.autoTrustHostKey=true; state.settings.sessionLog=true; state.settings.autoFillPassword=true; await window.api.createSession({name:'leak', host:'127.0.0.1', port:${SSH}, username:'admin', password:'${PW}', protocol:'ssh'}); await loadSessions(); return true; })()`);
    await sleep(400);
    const sj = await ev(c, `(function(){ const s=state.sessions.find(x=>x.name==='leak'); return s?JSON.stringify(s):'NOTFOUND'; })()`);
    if (sj === 'NOTFOUND') throw new Error('会话未创建');
    await ev(c, `connectToServer(${sj})`);
    let sid = null;
    for (let i = 0; i < 30; i++) { sid = await ev(c, `(state.tabs.size ? [...state.tabs.keys()][0] : null)`); if (sid && await ev(c, `state.tabs.get('${sid}').status`) === 'connected') break; await sleep(300); }
    if (!sid) throw new Error('连接失败');
    ok('会话已连接(sid=' + sid + ')');
    // 开始录制(密码也必须不进录制)
    await ev(c, `window.api.recStart('${sid}', { sessionName:'leak', host:'127.0.0.1', port:${SSH}, username:'admin', encoding:'utf8', cols:98, rows:46 }); true`);
    await sleep(300);

    // 触发 sudo 密码提示 → app 自动填充
    await ev(c, `sendInput('${sid}', 'sudo\\r'); true`);
    await sleep(2000);
    const afl = await ev(c, `termDebug.lines.filter(l=>l.includes('AUTOFILL')).join(' | ')`);
    if (/AUTOFILL/.test(String(afl))) ok('自动填充已触发:' + String(afl).slice(0, 80));
    else bad('自动填充未触发(前提不成立)', String(afl));

    // 正向对照:一条普通命令(必须照常进日志/录制)
    await ev(c, `sendInput('${sid}', 'uptime\\r'); true`);
    await sleep(800);

    // ① 终端不回显密码
    const termTxt = await ev(c, `(function(){ const t=state.tabs.get('${sid}').term; const b=t.buffer.active; let s=''; for(let i=Math.max(0,b.length-40);i<b.length;i++){const l=b.getLine(i); if(l) s+=l.translateToString(true)+'\\n';} return s; })()`);
    if (!String(termTxt).includes(PW)) ok('终端未回显密码');
    else bad('终端回显了密码', String(termTxt).match(/.{0,30}admin123.{0,30}/)[0]);

    // ② 调试面板无明文
    const dbg = await ev(c, `termDebug.lines.join('\\n')`);
    if (!String(dbg).includes(PW)) ok('调试面板无密码明文');
    else bad('调试面板出现密码明文', String(dbg).match(/.{0,40}admin123.{0,40}/)[0]);

    // ③ 会话日志(主进程落盘)不含密码,且普通命令仍在(核心断言 + 正向对照)
    await sleep(1200);
    const logDir = path.join(DIR, 'session-logs');
    const files = fs.existsSync(logDir) ? fs.readdirSync(logDir).filter((f) => f.endsWith('.log')) : [];
    if (!files.length) bad('没有会话日志文件(前提不成立)', logDir);
    const logTxt = files.map((f) => fs.readFileSync(path.join(logDir, f), 'utf8')).join('\n');
    if (!logTxt.includes(PW)) ok(`会话日志无密码明文(检查 ${files.length} 个文件)`);
    else bad('会话日志里出现密码明文', (logTxt.match(/.{0,60}admin123.{0,20}/s) || [''])[0].replace(/\n/g, '⏎'));
    if (/uptime/.test(logTxt)) ok('正向对照:普通命令(uptime)仍写入会话日志');
    else bad('普通命令没被记录(过度脱敏,审计丢失)', logTxt.slice(-160).replace(/\n/g, '⏎'));

    // ④ 兜底脱敏:不带 noLog 的调用方(未来新增路径/手敲密码)也不得进"输入事件"
    await ev(c, `window.api.sshWrite('${sid}', 'echo ' + state.tabs.get('${sid}').session.password + '\\r'); true`);
    await sleep(800);
    const rec = await ev(c, `window.api.recStop('${sid}')`);
    await sleep(800);
    const recFiles = fs.existsSync(path.join(DIR, 'recordings')) ? fs.readdirSync(path.join(DIR, 'recordings')) : [];
    const jsonl = recFiles.filter((f) => /\.jsonl(\.gz)?$/.test(f)).map((f) => {
      const buf = fs.readFileSync(path.join(DIR, 'recordings', f));
      return /\.gz$/.test(f) ? zlib.gunzipSync(buf).toString('utf8') : buf.toString('utf8');
    }).join('\n');
    const inputEvents = jsonl.split('\n').filter((l) => l.includes('"k":"i"'));
    const leaked = inputEvents.filter((l) => l.includes(PW));
    if (!leaked.length) ok(`录制里 ${inputEvents.length} 条输入事件均无密码明文(含 noLog 与兜底两条路径)`);
    else bad('录制的输入事件含密码明文', leaked[0].slice(0, 120));
    if (inputEvents.some((l) => l.includes('uptime'))) ok('正向对照:普通命令仍写入录制输入事件');
    else bad('普通命令未进录制(过度脱敏)', JSON.stringify(inputEvents.slice(-3)).slice(0, 200));
    if (rec && rec.ok) ok('录制已收尾(rec:stop ok)');

    console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
    console.log(`(测试数据目录: ${DIR})`);
  } catch (e) { console.error('\n测试异常:', e && e.message); failed++; console.log(`\n结果: ${passed} 通过, ${failed} 失败`); }
  try { killTree(appProc); } catch { /* ignore */ }
  process.exit(failed ? 1 : 0);
})();
