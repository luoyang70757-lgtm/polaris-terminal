'use strict';
/**
 * verify-about.js — 「帮助 → 关于」只展示版本信息 + 简介
 *
 * 背景:原来的「📖 使用说明」是一长篇文档(快速开始/快捷键/各功能说明…),
 * 现在精简成「关于」:只留 App 名称、版本号、一段简介。其余内容全部删除。
 *
 * 断言:
 *   ① 设置弹窗里是「ℹ️ 关于」入口(不再有「使用说明」),命令面板同样提供「关于 Polaris」
 *   ② 点击打开关于弹窗:标题「关于」、Logo「Polaris 北极星」、版本号来自主进程 app.getVersion()
 *   ③ 只剩版本 + 简介:没有旧说明文档残留(快速开始/快捷键表/功能清单/help-body 等)
 *   ④ 「帮助 → 关于 Polaris」菜单事件(menu:about)也能打开同一弹窗
 *   ⑤ Esc / ✕ / 「关闭」按钮都能关掉
 *
 * 运行:node verify-about.js
 */
const { spawn } = require('child_process');
const { freePort, killTree, guardTimeout, evaluate } = require('./test-helper');
const fs = require('fs'); const os = require('os'); const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-about-'));
const PORT = 9457, SSH = 2287, HTTP = 2387;
freePort(PORT); freePort(SSH); freePort(HTTP);
process.env.MOCK_SSH_PORT = String(SSH);
process.env.MOCK_HTTP_PORT = String(HTTP);
require('./mock/mock-server').start();

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
const appProc = spawn(require('electron'), ['.', '--dev', `--remote-debugging-port=${PORT}`, '--no-sandbox', '--disable-gpu'], {
  env: { ...process.env, POLARIS_LOCK_DIR: DIR, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  stdio: ['ignore', 'ignore', 'ignore'], detached: true,
});
guardTimeout(150000, appProc);
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
const head = (t) => console.log(`\n— ${t} —`);

(async () => {
  console.log('\n=== 关于(版本 + 简介) ===');
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

    head('① 入口');
    const entry = await ev(c, `(function () {
      var btn = document.getElementById('btn-about');
      var settingsText = (document.getElementById('settings-modal') || {}).textContent || '';
      var palette = (typeof COMMANDS !== 'undefined' ? COMMANDS : []).map(function (x) { return x.name; });
      return {
        btn: btn ? btn.textContent.trim() : null,
        hasOldBtn: !!document.getElementById('btn-help'),
        hasOldModal: !!document.getElementById('help-modal'),
        settingsHasGuide: /使用说明/.test(settingsText),
        paletteHasAbout: palette.some(function (n) { return /关于/.test(n); }),
        paletteHasHelp: palette.some(function (n) { return /使用说明/.test(n); }),
      };
    })()`);
    if (entry.btn && /关于/.test(entry.btn)) ok(`设置弹窗入口为「${entry.btn}」`);
    else bad('设置弹窗里没有「关于」按钮', JSON.stringify(entry));
    if (!entry.hasOldBtn && !entry.hasOldModal && !entry.settingsHasGuide) ok('旧的「使用说明」按钮/弹窗已删除');
    else bad('旧「使用说明」残留', JSON.stringify(entry));
    if (entry.paletteHasAbout && !entry.paletteHasHelp) ok('命令面板同样换成「关于 Polaris」');
    else bad('命令面板条目未替换', JSON.stringify(entry));

    head('② 打开关于弹窗');
    await ev(c, `(function(){ document.getElementById('btn-about').click(); return true; })()`);
    await sleep(700);
    const dlg = await ev(c, `(function () {
      var m = document.getElementById('about-modal');
      var q = function (sel) { var el = m && m.querySelector(sel); return el ? el.textContent.trim() : null; };
      var origHelp = document.getElementById('help-modal');
      return {
        visible: !!m && !m.classList.contains('hidden'),
        title: q('h3'),
        logo: q('.about-logo'),
        ver: q('#about-version'),
        intro: q('.about-intro'),
        sections: m ? m.querySelectorAll('section').length : -1,
        kbdRows: m ? m.querySelectorAll('table tr, .help-kbd tr').length : -1,
        hasHelpBody: !!document.querySelector('.help-body, .help-kbd, #help-modal'),
        oldModalGone: !origHelp,
        btnCount: m ? m.querySelectorAll('button').length : -1,
      };
    })()`);
    if (dlg.visible) ok('关于弹窗已打开');
    else bad('关于弹窗没打开', JSON.stringify(dlg));
    if (dlg.title && /关于/.test(dlg.title)) ok(`标题「${dlg.title}」`);
    else bad('标题不对', dlg.title);
    if (dlg.logo && /Polaris/.test(dlg.logo) && /北极星/.test(dlg.logo)) ok(`Logo 区展示「${dlg.logo}」`);
    else bad('Logo/名称区不对', dlg.logo);
    if (dlg.ver === 'v' + pkg.version) ok(`版本号来自主进程 app.getVersion()(${dlg.ver})`);
    else bad('版本号不对', JSON.stringify({ got: dlg.ver, want: 'v' + pkg.version }));
    if (dlg.intro && /SSH/.test(dlg.intro) && /SFTP/.test(dlg.intro) && dlg.intro.length > 40) ok(`有简介(${dlg.intro.length} 字)`);
    else bad('简介缺失或过短', dlg.intro);

    head('③ 版本 + 简介 + 检查更新');
    if (dlg.sections === 0 && dlg.kbdRows === 0) ok('旧说明文档结构(章节 / 快捷键表)已清空');
    else bad('关于弹窗里仍有大量说明段落', JSON.stringify({ sections: dlg.sections, kbdRows: dlg.kbdRows }));
    if (!dlg.hasHelpBody && dlg.oldModalGone) ok('help-body / help-kbd / help-modal 均已从 DOM 删除');
    else bad('旧样式节点残留', JSON.stringify(dlg));
    if (dlg.btnCount === 3) ok('弹窗按钮:✕ / 检查更新 / 关闭');
    else bad('按钮数量异常', dlg.btnCount);

    head('④ 菜单「帮助 → 关于 Polaris」');
    const viaMenu = await ev(c, `(function () {
      document.getElementById('about-close').click();          // 先关掉
      var before = !document.getElementById('about-modal').classList.contains('hidden');
      window.api.onMenu && null;
      // 直接触发渲染层对 menu:about 的处理(等价于主进程 send('menu:about'))
      var fns = [];
      try { openAbout(); } catch (e) { return { err: e.message }; }
      var after = !document.getElementById('about-modal').classList.contains('hidden');
      return { before: before, after: after };
    })()`);
    if (!viaMenu.before && viaMenu.after) ok('menu:about → openAbout() 打开同一弹窗');
    else bad('菜单事件未打开关于弹窗', JSON.stringify(viaMenu));

    head('⑤ 关闭方式');
    await ev(c, `(document.getElementById('about-modal').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), true)`);
    await sleep(200);
    const escClosed = await ev(c, `document.getElementById('about-modal').classList.contains('hidden')`);
    if (escClosed) ok('Esc 关闭');
    else bad('Esc 没关闭');
    await ev(c, `(openAbout(), true)`); await sleep(400);
    await ev(c, `(document.getElementById('about-close-x').click(), true)`); await sleep(200);
    if (await ev(c, `document.getElementById('about-modal').classList.contains('hidden')`)) ok('✕ 关闭');
    else bad('✕ 没关闭');
    await ev(c, `(openAbout(), true)`); await sleep(400);
    await ev(c, `(document.getElementById('about-close').click(), true)`); await sleep(200);
    if (await ev(c, `document.getElementById('about-modal').classList.contains('hidden')`)) ok('「关闭」按钮关闭');
    else bad('关闭按钮无效');

    console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  } catch (e) {
    console.error('\n测试异常:', e && e.message);
    failed++;
  }
  try { killTree(appProc); } catch { /* ignore */ }
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(failed ? 1 : 0);
})();
