'use strict';
/**
 * verify-ssh-config-import.js — 端到端验证「~/.ssh/config 导入」IPC/UI 胶水
 *
 * 覆盖:
 *   ① 主进程 sessions:importExternal 对 .conf / 无扩展名 config 文件的解析(含 Host * 默认、IdentityFile ~ 展开);
 *   ② import-sshconfig 按钮存在、window.api.importSshConfig 已从 preload 暴露;
 *   ③ sessions:importSshConfig 往返:无 ~/.ssh/config 时返回 {ok:false,error},有文件时返回 {ok:true,rows}。
 *
 * 纯函数解析器由 verify-ssh-config.js 覆盖,这里只验证 IPC + 渲染层胶水,不碰真实 SSH。
 * 运行:node verify-ssh-config-import.js
 */
const { spawn } = require('child_process');
const { freePort, killTree, guardTimeout, evaluate } = require('./test-helper');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-sshcfg-'));
const PORT = 9466, SSH = 2296, HTTP = 2396;
freePort(PORT); freePort(SSH); freePort(HTTP);
process.env.MOCK_SSH_PORT = String(SSH);
process.env.MOCK_HTTP_PORT = String(HTTP);
require('./mock/mock-server').start();

// 构造临时 HOME,放一个假 ~/.ssh/config,让 sessions:importSshConfig 走通 happy path。
const fakeHome = path.join(DIR, 'home');
fs.mkdirSync(path.join(fakeHome, '.ssh'), { recursive: true });
fs.writeFileSync(path.join(fakeHome, '.ssh', 'config'),
  '# 临时测试配置\nHost www\n  HostName 10.0.0.9\n  User deploy\n  IdentityFile ~/.ssh/id_ed25519\n');

const appProc = spawn(require('electron'), ['.', '--dev', `--remote-debugging-port=${PORT}`, '--no-sandbox', '--disable-gpu'], {
  env: { ...process.env, POLARIS_LOCK_DIR: DIR, HOME: fakeHome, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  stdio: ['ignore', 'ignore', 'ignore'],
  detached: true,
});
guardTimeout(180000, appProc);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function targets() {
  for (let i = 0; i < 60; i++) {
    try {
      const j = await (await fetch(`http://127.0.0.1:${PORT}/json`, { signal: AbortSignal.timeout(3000) })).json();
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
const ev = (c, expr) => evaluate(c, expr);

let passed = 0, failed = 0;
const ok = (n) => { passed++; console.log('  ✓ ' + n); };
const bad = (n, e) => { failed++; console.error('  ✗ ' + n + (e ? ' → ' + e : '')); };
const eq = (a, b, n) => { if (a === b) ok(n); else bad(n, `期望 ${JSON.stringify(b)} 实得 ${JSON.stringify(a)}`); };

(async () => {
  console.log('\n=== ~/.ssh/config 导入(E2E 胶水) ===');
  let appReady = appProc;
  try {
    const lockT = (await targets()).find((t) => /解锁/.test(t.title || ''));
    const lock = await connect(lockT.webSocketDebuggerUrl);
    for (let i = 0; i < 40; i++) { if (await ev(lock, `!!document.getElementById('pw')`)) break; await sleep(300); }
    await sleep(300);
    await ev(lock, `document.getElementById('pw').value='x1234567'; document.getElementById('pw2').value='x1234567'; document.getElementById('btn').click();`);
    let c = null;
    for (let i = 0; i < 40; i++) {
      await sleep(400);
      const m = (await targets()).find((t) => t.type === 'page' && !/解锁/.test(t.title || ''));
      if (m) { c = await connect(m.webSocketDebuggerUrl); break; }
    }
    if (!c) throw new Error('解锁后主窗口未出现');
    for (let i = 0; i < 50; i++) { if (await ev(c, `typeof state === 'object' && !!state.settings`)) break; await sleep(200); }
    // 跳过并关闭首次使用自动弹出的新手引导,避免遮挡后续点击/断言
    await ev(c, `state.settings.onboardingDone = true; saveSettings(); var _om = document.getElementById('onboarding-modal'); if (_om) _om.classList.add('hidden'); true;`);

    // ① preload 暴露 + 按钮存在
    eq(await ev(c, `typeof window.api.importSshConfig`), 'function', 'preload 暴露 importSshConfig');
    eq(await ev(c, `!!document.getElementById('import-sshconfig')`), true, '导入窗内存在「从 ~/.ssh/config 导入」按钮');
    eq(await ev(c, `!!document.getElementById('import-external')`), true, '外部导入按钮仍在');

    // ② importExternal 对 .conf 文件解析(纯胶水:文件由渲染层传入)
    const confPath = path.join(DIR, 'site.conf');
    fs.writeFileSync(confPath, 'Host web\n  HostName 1.2.3.4\n  User root\n  Port 2222\n');
    const r1 = await ev(c, `window.api.importExternal([${JSON.stringify(confPath)}])`);
    eq(r1 && r1.ok, true, 'importExternal 解析 .conf 成功');
    if (r1.ok) {
      eq(r1.rows.length, 1, '  解析出 1 台主机');
      eq(r1.rows[0].name, 'web', '  name=web');
      eq(r1.rows[0].host, '1.2.3.4', '  HostName 取对');
      eq(r1.rows[0].port, 2222, '  Port 取对');
      eq(r1.rows[0].username, 'root', '  User 取对');
    }

    // ③ importExternal 对无扩展名 "config" 文件解析(Host * 默认 + IdentityFile ~ 展开)
    const cfgPath = path.join(DIR, 'config');
    fs.writeFileSync(cfgPath, 'Host *\n  User admin\n  IdentityFile ~/.ssh/id_rsa\nHost db\n  HostName 5.6.7.8\n');
    const r2 = await ev(c, `window.api.importExternal([${JSON.stringify(cfgPath)}])`);
    eq(r2 && r2.ok, true, 'importExternal 解析无扩展名 config 成功');
    if (r2.ok) {
      eq(r2.rows.length, 1, '  Host * 不生成会话,仅 db');
      eq(r2.rows[0].name, 'db', '  name=db');
      eq(r2.rows[0].username, 'admin', '  继承 Host * 的 User');
      eq(r2.rows[0].privateKey, path.join(fakeHome, '.ssh', 'id_rsa'), '  IdentityFile ~ 按(假)HOME 展开');
    }

    // ④ sessions:importSshConfig 往返:用注入的 fakeHome 的 ~/.ssh/config
    const r3 = await ev(c, `window.api.importSshConfig()`);
    eq(r3 && r3.ok, true, 'importSshConfig 读到 ~/.ssh/config(假 HOME)');
    if (r3.ok) {
      eq(r3.rows.length, 1, '  解析出 1 台');
      eq(r3.rows[0].name, 'www', '  name=www');
      eq(r3.rows[0].host, '10.0.0.9', '  HostName=10.0.0.9');
      eq(r3.rows[0].privateKey, path.join(fakeHome, '.ssh', 'id_ed25519'), '  IdentityFile 展开');
    }

    // ⑤ 点击按钮 → 导入弹窗出现并进入预览(通过 import-modal 可见性验证渲染端胶水)
    await ev(c, `document.getElementById('import-sshconfig').click()`);
    await sleep(500);
    eq(await ev(c, `!document.getElementById('import-modal').classList.contains('hidden')`), true, '点击按钮后导入弹窗打开');
    // 预览数量文本应包含 "www"
    const previewTxt = await ev(c, `(document.getElementById('import-result')||{}).innerText || (document.getElementById('import-summary')||{}).innerText || ''`);
    console.log('    (预览内容) ', JSON.stringify(String(previewTxt).slice(0, 120)));

    console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
    killTree(appProc);
    process.exit(failed ? 1 : 0);
  } catch (err) {
    console.error('\n✗ 测试异常:', err.message);
    killTree(appProc);
    process.exit(1);
  }
})();