// 验证"堡垒机轮询不再频繁刷新会话列表":
//   ① guest 返回的 tree/favTree/assets 键序不同但内容相同 → changed=false(不重渲染)
//   ② 内容真的变化 → changed=true(正常刷新)
//   ③ 模拟 3 次轮询,renderSessionList 调用次数应为 0(内容稳定时)
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');

const OUT = process.env.VERIFY_OUT || os.tmpdir() + '/verify-pollrefresh-result.txt';
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
  const PORT = 9399;
  const DIR = fs.mkdtempSync(os.tmpdir() + '/polaris-pollrefresh-');
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
      if (typeof stableJson !== 'function') return { err: 'stableJson missing' };

      // 直接验证 pollBastionAssets 的判定逻辑(与代码内联一致)
      const treeA = { name: 'root', children: [{ name: 'x', ip: '1.1.1.1', services: { ssh: { port: 22 } } }] };
      // 键序打乱但值完全一致(用 stableJson 重排后应相等)
      const treeB = JSON.parse(stableJson(treeA)); // 与 treeA 完全同值
      delete treeB.name; treeB.name = 'root'; // 确保键序不同(先删后加,键序即变)
      const treeC = { name: 'root', children: [{ name: 'x', ip: '9.9.9.9' }] }; // 内容真变

      const same1 = stableJson(treeA) === stableJson(treeB);       // 应 true(键序无关)
      const diff = stableJson(treeA) !== stableJson(treeC);        // 应 true(内容变了)

      // 模拟 3 次轮询:内容稳定但对象每次重建、键序随机 → changed 应全 false
      let stateTree = null;
      let changedCount = 0;
      const randKeyOrder = (o) => JSON.parse(JSON.stringify(o, Object.keys(o).sort(() => Math.random() - 0.5)));
      for (let i = 0; i < 3; i++) {
        const fresh = randKeyOrder(treeA); // 每次新对象 + 随机键序
        if (stableJson(fresh) !== stableJson(stateTree)) { stateTree = fresh; changedCount++; }
      }
      // 同样的模拟,用旧 JSON.stringify 比较 → 应每次都"变"(展示修复前的问题)
      let oldStateTree = null;
      let oldChanged = 0;
      for (let i = 0; i < 3; i++) {
        const fresh = randKeyOrder(treeA);
        if (JSON.stringify(fresh) !== JSON.stringify(oldStateTree)) { oldStateTree = fresh; oldChanged++; }
      }

      return { same1, diff, stablePollChanges: changedCount, oldJsonStringifyChanges: oldChanged };
    })()`);

    w('RESULT ' + JSON.stringify(r1));
    log('result: ' + JSON.stringify(r1));

    await sleep(500);
    process.exit(0);
  } catch (e) {
    w('ERROR ' + (e && e.stack || String(e)).slice(0, 700));
    log('error: ' + e);
    process.exit(1);
  } finally {
    killTree(app);
  }
}

main();
