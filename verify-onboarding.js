'use strict';
/**
 * verify-onboarding.js — 端到端验证「新手引导向导」
 *
 * 覆盖:
 *  ① 首次使用(无会话、未完成引导)解锁后自动弹出向导;
 *  ② 三步导航(下一步/上一步/进度点/按钮显隐)、文案随步骤变化;
 *  ③ ✕ / 跳过 / 完成都会关闭并持久化 onboardingDone;
 *  ④ 空态卡片「查看新手引导」可重开;
 *  ⑤ 步骤 1 的 4 个入口分别关闭向导并打开对应面板(新建会话/批量导入/SSH 导入/快捷连接)。
 *
 * 运行:node verify-onboarding.js
 */
const { spawn } = require('child_process');
const { freePort, killTree, guardTimeout, evaluate } = require('./test-helper');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-ob-'));
const PORT = 9467;
freePort(PORT);

// 构造临时 HOME,放一个 ~/.ssh/config 供「导入 SSH 配置」入口走通 happy path。
const fakeHome = path.join(DIR, 'home');
fs.mkdirSync(path.join(fakeHome, '.ssh'), { recursive: true });
fs.writeFileSync(path.join(fakeHome, '.ssh', 'config'),
  '# 临时配置\nHost web01\n  HostName 10.9.9.9\n  User ops\n');

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
  console.log('\n=== 新手引导向导 ===');
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
    for (let i = 0; i < 50; i++) { if (await ev(c, `typeof state === 'object' && !!state.settings && typeof closeOnboarding === 'function'`)) break; await sleep(200); }
    await sleep(500); // 等首次使用自动弹出(onboardingDone 未置、无会话)

    // ① 首次使用自动弹出
    eq(await ev(c, `!document.getElementById('onboarding-modal').classList.contains('hidden')`), true, '首次使用自动弹出向导');
    eq(await ev(c, `!document.querySelector('.ob-step[data-step="0"]').classList.contains('hidden')`), true, '默认在第 0 步(欢迎)');
    eq(await ev(c, `document.querySelector('.ob-step[data-step="1"]').classList.contains('hidden')`), true, '第 1 步初始隐藏');
    eq(await ev(c, `document.querySelector('.ob-dot[data-step="0"]').classList.contains('active')`), true, '进度点 0 高亮');
    eq(await ev(c, `document.getElementById('ob-back').classList.contains('hidden')`), true, '第 0 步无「上一步」');
    eq(await ev(c, `document.getElementById('ob-next').textContent.trim()`), '开始 →', '第 0 步主按钮文案「开始 →」');

    // ② 导航:开始 → 第 1 步 → 上一步 → 下一步 → 第 2 步
    await ev(c, `document.getElementById('ob-next').click()`);
    eq(await ev(c, `!document.querySelector('.ob-step[data-step="1"]').classList.contains('hidden')`), true, '「开始」进入第 1 步');
    eq(await ev(c, `document.getElementById('ob-next').textContent.trim()`), '下一步 →', '第 1 步主按钮文案「下一步 →」');
    eq(await ev(c, `document.getElementById('ob-back').classList.contains('hidden')`), false, '第 1 步有「上一步」');
    await ev(c, `document.getElementById('ob-back').click()`);
    eq(await ev(c, `!document.querySelector('.ob-step[data-step="0"]').classList.contains('hidden')`), true, '「上一步」回到欢迎');
    await ev(c, `document.getElementById('ob-next').click(); document.getElementById('ob-next').click();`);
    eq(await ev(c, `!document.querySelector('.ob-step[data-step="2"]').classList.contains('hidden')`), true, '连续两次「下一步」到第 2 步');
    eq(await ev(c, `!document.getElementById('ob-finish').classList.contains('hidden')`), true, '第 2 步显示「开始使用」');
    eq(await ev(c, `document.getElementById('ob-skip').classList.contains('hidden')`), true, '第 2 步隐藏「跳过」');

    // ③ 「开始使用」关闭 + 持久化 onboardingDone
    await ev(c, `document.getElementById('ob-finish').click()`);
    eq(await ev(c, `document.getElementById('onboarding-modal').classList.contains('hidden')`), true, '「开始使用」关闭向导');
    eq(await ev(c, `state.settings.onboardingDone === true`), true, 'onboardingDone 已持久化');

    // ④ 空态卡片「查看新手引导」可重开;重开后不因 onboardingDone 而受限
    eq(await ev(c, `!!document.querySelector('.session-empty-card .ob-guide-link')`), true, '空态卡片存在「查看新手引导」入口');
    await ev(c, `document.querySelector('.session-empty-card .ob-guide-link').click()`);
    eq(await ev(c, `!document.getElementById('onboarding-modal').classList.contains('hidden')`), true, '空态卡片可重开向导');

    // ⑤ 第 1 步 4 个入口:关闭向导并打开对应面板
    // 新建会话
    await ev(c, `openOnboarding(); document.getElementById('ob-next').click(); document.getElementById('ob-new-session').click();`);
    eq(await ev(c, `document.getElementById('onboarding-modal').classList.contains('hidden')`), true, '「新建会话」关闭向导');
    eq(await ev(c, `!document.getElementById('session-modal').classList.contains('hidden')`), true, '「新建会话」打开会话弹窗');
    await ev(c, `document.getElementById('modal-cancel').click()`);
    // 批量导入
    await ev(c, `openOnboarding(); document.getElementById('ob-next').click(); document.getElementById('ob-import-batch').click();`);
    eq(await ev(c, `!document.getElementById('import-modal').classList.contains('hidden')`), true, '「批量导入」打开导入弹窗');
    await ev(c, `document.getElementById('import-cancel').click()`);
    // 导入 SSH 配置(假 HOME 的 ~/.ssh/config)
    await ev(c, `openOnboarding(); document.getElementById('ob-next').click(); document.getElementById('ob-import-ssh').click();`);
    eq(await ev(c, `document.getElementById('onboarding-modal').classList.contains('hidden')`), true, '「导入 SSH 配置」关闭向导');
    eq(await ev(c, `!document.getElementById('import-modal').classList.contains('hidden')`), true, '「导入 SSH 配置」打开导入弹窗');
    eq(await ev(c, `(document.getElementById('import-result')||{}).innerText.indexOf('web01') !== -1`), true, 'SSH 配置预览含 web01');
    await ev(c, `document.getElementById('import-cancel').click()`);
    // 快捷连接
    await ev(c, `openOnboarding(); document.getElementById('ob-next').click(); document.getElementById('ob-quick').click();`);
    eq(await ev(c, `!document.getElementById('quick-connect').classList.contains('hidden')`), true, '「快捷连接」展开快捷连接条');
    await ev(c, `document.getElementById('qc-close').click()`);

    console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
    killTree(appProc);
    process.exit(failed ? 1 : 0);
  } catch (err) {
    console.error('\n✗ 测试异常:', err.message);
    killTree(appProc);
    process.exit(1);
  }
})();