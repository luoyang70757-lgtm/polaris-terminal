// 验证全量日志系统:
//   ① 启动后 logs/ 目录自动创建,app-*.log 文件出现且含 [MAIN]/[RENDERER] 内容
//   ② dlog 产生的行最终落盘([DLOG])
//   ③ appLogDump 返回完整导出(系统信息 + 日志文件内容)
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT = process.env.VERIFY_OUT || os.tmpdir() + '/verify-applog-result.txt';
const w = (s) => fs.appendFileSync(OUT, s + '\n');
const log = (s) => { try { console.log(s); } catch {} };

function freePort(p) { try { execSync(`lsof -ti tcp:${p} | xargs kill -9 2>/dev/null`); } catch {} }
function killTree(proc) { try { if (proc && proc.pid) process.kill(-proc.pid, 'SIGKILL'); } catch {} }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function targets(PORT) {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json`);
      const j = await r.json();
      const p = j.find((t) => t.type === 'page' && /解锁|Polaris/.test(t.title || ''));
      if (p) return j;
    } catch { /* not ready */ }
    await sleep(400);
  }
  throw new Error('CDP targets 未就绪');
}
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0; const pending = new Map();
    ws.onopen = () => resolve({
      call(m, p = {}) { return new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method: m, params: p })); }); },
      close() { ws.close(); },
    });
    ws.onerror = (e) => reject(e);
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };
  });
}
async function ev(c, expr) {
  const r = await c.call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('JS异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 600) + ' @ ' + expr.slice(0, 120));
  return r.result && r.result.value;
}

async function main() {
  fs.writeFileSync(OUT, '');
  const PORT = 9411;
  const DIR = fs.mkdtempSync(os.tmpdir() + '/polaris-applog-');
  freePort(PORT);
  const app = spawn('node_modules/.bin/electron', ['.', '--dev', `--remote-debugging-port=${PORT}`, '--no-sandbox', '--disable-gpu'], {
    env: { ...process.env, POLARIS_LOCK_DIR: DIR, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
    stdio: 'ignore', detached: true,
  });
  setTimeout(() => killTree(app), 150000);

  try {
    const ts = await targets(PORT);
    const lock = await connect(ts.find((t) => /解锁/.test(t.title || '')).webSocketDebuggerUrl);
    for (let i = 0; i < 30; i++) { if (await ev(lock, `!!document.getElementById('pw')`)) break; await sleep(300); }
    await sleep(300);
    await ev(lock, `document.getElementById('pw').value='x12345678'; document.getElementById('pw2').value='x12345678'; document.getElementById('btn').click();`);
    let c = null;
    for (let i = 0; i < 30; i++) {
      await sleep(500);
      const t2 = await targets(PORT);
      const m = t2.find((t) => t.type === 'page' && !/解锁/.test(t.title || ''));
      if (m) { c = await connect(m.webSocketDebuggerUrl); break; }
    }
    if (!c) throw new Error('解锁后主窗口未出现');

    // 触发一些 dlog(模拟真实使用)
    await ev(c, `dlog('TEST', 'e2e 测试日志行: abc123')`);
    await ev(c, `console.log('renderer console 测试: xyz789')`);
    await sleep(1500); // 等 dlog 批量落盘(500ms) + 日志写入

    // ① 检查日志文件
    const logsDir = path.join(DIR, 'logs');
    const files = fs.existsSync(logsDir) ? fs.readdirSync(logsDir).filter((f) => f.endsWith('.log')) : [];
    let fileContent = '';
    if (files.length) {
      const f = path.join(logsDir, files[files.length - 1]);
      fileContent = fs.readFileSync(f, 'utf8');
    }

    // ③ appLogDump 完整导出
    const r1 = await ev(c, `(async () => {
      const r = await window.api.appLogDump();
      return r && r.ok ? { ok: true, len: r.content.length, hasHeader: r.content.includes('Polaris 日志导出'), hasSysInfo: r.content.includes('Electron:'), hasLogFile: r.content.includes('日志文件:') } : { err: r && r.error };
    })()`);

    // ② 文件里应有 MAIN(启动日志)/DLOG(测试行)/RENDERER(console 测试)
    const r2 = {
      logFiles: files.length,
      hasMain: fileContent.includes('[MAIN]'),
      hasDlogTest: fileContent.includes('abc123'),
      hasRendererConsole: fileContent.includes('xyz789'),
      fileSize: fileContent.length,
    };

    w('RESULT ' + JSON.stringify({ r1, r2 }));
    log('result: ' + JSON.stringify({ r1, r2 }));

    await sleep(500);
    process.exit(0);
  } catch (e) {
    w('ERROR ' + (e && e.stack || String(e)).slice(0, 600));
    log('error: ' + e);
    process.exit(1);
  } finally {
    killTree(app);
  }
}

main();
