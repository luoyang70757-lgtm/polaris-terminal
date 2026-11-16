'use strict';
/**
 * verify-bastion-browser-ui.js — 堡垒机浏览器面板显示优化回归
 *
 * 覆盖:
 *   ① 工具栏精简:保留「⋯」更多操作,清除历史收进菜单(隐藏按钮仍可点击,兼容旧脚本)；
 *   ② 空态结构完整(图标/标题/说明/配置/重试),不会再被 textContent 覆盖；
 *   ③ 错误态显示「重试」、隐藏配置；空闲态相反；
 *   ④ 「⋯」菜单包含系统浏览器打开/复制地址/重置缩放/清除历史；
 *   ⑤ 双击缩放百分比恢复 100%；
 *   ⑥ app:openExternal 只允许 http/https。
 *
 * 运行:node verify-bastion-browser-ui.js(需 9497 空闲)
 */
const { spawn } = require('child_process');
const { freePort, killTree, guardTimeout } = require('./test-helper');
const fs = require('fs'); const os = require('os'); const path = require('path');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-bui-'));
const PORT = 9497;
freePort(PORT);
const appProc = spawn('node_modules/.bin/electron', ['.', '--dev', `--remote-debugging-port=${PORT}`, '--no-sandbox', '--disable-gpu'], {
  env: { ...process.env, POLARIS_LOCK_DIR: DIR, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  stdio: ['ignore', 'ignore', 'ignore'], detached: true,
});
guardTimeout(150000, appProc);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function targets() {
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json`); const j = await r.json(); if (j.find((t) => t.type === 'page')) return j; } catch { /* ignore */ }
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
async function ev(c, expr) {
  const r = await c.call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400) + ' @ ' + expr.slice(0, 80));
  return r.result && r.result.value;
}
let passed = 0, failed = 0;
const ok = (n) => { passed++; console.log('  ✓ ' + n); };
const bad = (n, e) => { failed++; console.error('  ✗ ' + n + (e ? ' → ' + e : '')); };

(async () => {
  console.log('\n=== 堡垒机浏览器显示优化 ===\n');
  try {
    const t0 = await targets();
    const lockT = t0.find((t) => /解锁/.test(t.title || '')) || t0.find((t) => t.type === 'page');
    const lock = await connect(lockT.webSocketDebuggerUrl);
    for (let i = 0; i < 40; i++) { if (await ev(lock, `!!document.getElementById('pw')`)) break; await sleep(300); }
    await ev(lock, `document.getElementById('pw').value='x1234567'; document.getElementById('pw2').value='x1234567'; document.getElementById('btn').click();`);
    let c = null;
    for (let i = 0; i < 50; i++) {
      await sleep(400);
      const t2 = await targets();
      const m = t2.find((t) => t.type === 'page' && !/解锁/.test(t.title || ''));
      if (m) { c = await connect(m.webSocketDebuggerUrl); break; }
    }
    if (!c) throw new Error('主窗口未就绪');
    for (let i = 0; i < 50; i++) { if (await ev(c, `typeof state === 'object' && !!state.settings`)) break; await sleep(200); }
    // 关掉首次使用自动弹出的新手引导:它也是 .modal,开着时 setBastionWebviewForModal(false)
    // 会因为「还有别的弹窗开着」而拒绝恢复 webview → 本用例的 restored 断言会被误伤。
    await ev(c, `state.settings.onboardingDone = true; saveSettings(); var _om = document.getElementById('onboarding-modal'); if (_om) _om.classList.add('hidden'); true;`);

    const idle = await ev(c, `(function(){
      openBastionPanel();
      const e = document.getElementById('bastion-empty');
      return {
        hidden: e.classList.contains('hidden'),
        icon: (document.querySelector('#bastion-empty .be-icon') || {}).textContent,
        title: document.getElementById('bastion-empty-title').textContent,
        sub: document.getElementById('bastion-empty-sub').textContent,
        cfgHidden: document.getElementById('bastion-empty-cfg').classList.contains('hidden'),
        retryHidden: document.getElementById('bastion-empty-retry').classList.contains('hidden'),
        more: !!document.getElementById('bastion-more'),
        clearHidden: document.getElementById('bastion-clear').classList.contains('hidden'),
        currentHidden: getComputedStyle(document.querySelector('.bastion-current-row')).display === 'none',
      };
    })()`);
    if (!idle.hidden && idle.icon === '🌐' && /堡垒机浏览器/.test(idle.title) && idle.sub.length > 5) ok('空态结构完整(图标/标题/说明)');
    else bad('空态结构异常', JSON.stringify(idle));
    if (!idle.cfgHidden && idle.retryHidden) ok('空闲态显示配置、隐藏重试');
    else bad('空闲态按钮状态异常', JSON.stringify(idle));
    if (idle.more && idle.clearHidden) ok('工具栏保留「⋯」，清除历史收进菜单');
    else bad('工具栏结构异常', JSON.stringify(idle));
    if (idle.currentHidden) ok('无页面标题时当前页信息行自动隐藏');
    else bad('空态仍占着当前页信息行', JSON.stringify(idle));

    const err = await ev(c, `(function(){
      setBastionEmptyState('error', '加载失败', '(ERR_TEST) 测试');
      return {
        cfgHidden: document.getElementById('bastion-empty-cfg').classList.contains('hidden'),
        retryHidden: document.getElementById('bastion-empty-retry').classList.contains('hidden'),
        title: document.getElementById('bastion-empty-title').textContent,
        sub: document.getElementById('bastion-empty-sub').textContent,
      };
    })()`);
    if (err.cfgHidden && !err.retryHidden && /加载失败/.test(err.title) && /ERR_TEST/.test(err.sub)) ok('错误态显示重试、隐藏配置');
    else bad('错误态按钮状态异常', JSON.stringify(err));
    await ev(c, `setBastionEmptyState('idle', '堡垒机浏览器', '在上方选择/输入堡垒机 Web 地址'); true`);

    const more = await ev(c, `(function(){
      document.getElementById('bastion-more').click();
      const m = document.getElementById('ctx-menu');
      const visible = !!m && !m.classList.contains('hidden');
      const txt = m ? m.textContent : '';
      if (m) closeCtxMenu();
      return { visible, txt };
    })()`);
    if (more.visible && /在系统浏览器打开/.test(more.txt) && /复制当前地址/.test(more.txt) && /重置缩放/.test(more.txt) && /清除堡垒机历史/.test(more.txt)) ok('「⋯」菜单包含系统浏览器/复制/重置缩放/清除历史');
    else bad('「⋯」菜单内容异常', JSON.stringify(more));

    const zoom = await ev(c, `(function(){
      state.bastionZoom = 1.4; applyBastionZoom();
      document.getElementById('bastion-zoom-label').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      return { z: state.bastionZoom, label: document.getElementById('bastion-zoom-label').textContent };
    })()`);
    if (zoom.z === 1 && zoom.label === '100%') ok('双击缩放百分比恢复 100%');
    else bad('缩放重置异常', JSON.stringify(zoom));

    // 配置弹窗:右上角 ✕ 必须存在；打开时隐藏 webview（避免 guest view 盖住宿主弹窗）
    const cfg = await ev(c, `(function(){
      openBastionCfg();
      const m = document.getElementById('bastion-cfg-modal');
      const x = document.getElementById('bastion-cfg-x');
      const wv = document.getElementById('bastion-webview');
      const before = { visible: !m.classList.contains('hidden'), hasX: !!x, wvHidden: wv.style.visibility === 'hidden' };
      if (x) x.click();
      return Object.assign(before, { closed: m.classList.contains('hidden'), restored: wv.style.visibility !== 'hidden' });
    })()`);
    if (cfg.visible && cfg.hasX && cfg.wvHidden && cfg.closed && cfg.restored) ok('配置弹窗有 ✕，打开时隐藏 webview、关闭后恢复');
    else bad('配置弹窗关闭/层级异常', JSON.stringify(cfg));

    const ext = await ev(c, `window.api.openExternal('file:///etc/passwd')`);
    if (ext && ext.ok === false) ok('openExternal 拒绝非 http/https');
    else bad('openExternal 未拒绝 file://', JSON.stringify(ext));

    console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  } catch (e) {
    console.error('\n测试异常:', e && e.message);
    failed++;
  }
  try { killTree(appProc); } catch { /* ignore */ }
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(failed ? 1 : 0);
})();
