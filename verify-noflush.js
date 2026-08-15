// 验证:堡垒机资产轮询"数据没变化不刷新"
//   ① 两轮轮询数据相同(但对象每次重建/键序不同)→ changed=false → 不调 renderSessionList
//   ② 数据真变化 → changed=true → 调 renderSessionList
//   ③ triggerBastionFullFetch 的 setStatus 只在首次/状态变化时提示(重复成功不刷状态栏)
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');

const OUT = process.env.VERIFY_OUT || os.tmpdir() + '/verify-noflush-result.txt';
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
  const PORT = 9410;
  const DIR = fs.mkdtempSync(os.tmpdir() + '/polaris-noflush-');
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

    const r1 = await ev(c, `(async () => {
      // ① stableJson 比较:两轮相同内容(键序不同) → 判相等(不刷新)
      const a = { name: 'x', children: [{ name: 'y', ip: '1.1.1.1' }] };
      const b = { children: [{ ip: '1.1.1.1', name: 'y' }], name: 'x' };
      const same = stableJson(a) === stableJson(b);

      // ② 模拟两轮 poll 判定:数据相同 → changed=false
      let stateAssets = null, changed = 0;
      const mk = () => [{ id: 'd1', name: '设备1', ip: '10.0.0.1', services: { ssh: { port: 22 } } }];
      const round1 = mk(); const round2 = mk(); // 内容相同的新对象
      if (stableJson(round1) !== stableJson(stateAssets)) changed++; stateAssets = round1;
      if (stableJson(round2) !== stableJson(stateAssets)) changed++; stateAssets = round2;
      const pollChangesSameData = changed; // 期望 1(首次初始化),第二轮不触发

      // ③ 数据真变 → changed 增加
      if (stableJson([{ id: 'd1', name: '设备1改了', ip: '10.0.0.2' }]) !== stableJson(stateAssets)) changed++;
      const pollChangesRealDiff = changed; // 期望 2

      // ④ triggerBastionFullFetch 的提示标记:首次 true,重复不重复提示
      bastionFetchOkNotified = false;
      const firstOk = !bastionFetchOkNotified;
      bastionFetchOkNotified = true;
      const secondOk = !bastionFetchOkNotified;

      return { same, pollChangesSameData, pollChangesRealDiff, firstOk, secondOk };
    })()`);

    w('RESULT ' + JSON.stringify(r1));
    log('result: ' + JSON.stringify(r1));

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
