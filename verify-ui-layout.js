'use strict';
/**
 * verify-ui-layout.js — 界面布局 / 字体缩放回归
 *
 * 背景:「界面字体大小」设置以前只作用于工具栏/会话列表等少数元素(其余是写死的 11/12px),
 * 调大字号时大部分 UI 不变,而 SFTP 工具栏、面板标题等窄区域会折行/裁字。本次把全 UI 字号
 * 改成由 --ui-font 派生的档位(--fs-2xs…--fs-lg),并修了窄面板溢出。
 *
 * 断言:
 *   ① 默认 13px 下各档位与旧像素值一致(分组头 13 / SFTP 按钮 12 / 折叠三角 9 / 底部提示 11);
 *   ② 把界面字号调到 17px:分组头、会话行、工具栏、SFTP 文件行、底部提示全部跟着变大;
 *   ③ 会话列表不出横向滚动条(长名字走省略号);
 *   ④ 面板标题「会话」单行不折行(大字号也不折);
 *   ⑤ 底部提示单行(不折成两行);
 *   ⑥ SFTP 工具栏在大字号下不被裁切(工具栏自身不溢出、按钮文字不折字);
 *   ⑦ 240px 面板 + 13px:长主机名基本可读(不整段变省略号)。
 *
 * 运行:node verify-ui-layout.js
 */
const { spawn } = require('child_process');
const { freePort, killTree, guardTimeout, evaluate } = require('./test-helper');
const fs = require('fs'); const os = require('os'); const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-uilayout-'));
const PORT = 9456, SSH = 2286, HTTP = 2386;
freePort(PORT); freePort(SSH); freePort(HTTP);
process.env.MOCK_SSH_PORT = String(SSH);
process.env.MOCK_HTTP_PORT = String(HTTP);
require('./mock/mock-server').start();

const appProc = spawn(require('electron'), ['.', '--dev', `--remote-debugging-port=${PORT}`, '--no-sandbox', '--disable-gpu'], {
  env: { ...process.env, POLARIS_LOCK_DIR: DIR, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  stdio: ['ignore', 'ignore', 'ignore'], detached: true,
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
const head = (t) => console.log(`\n— ${t} —`);

(async () => {
  console.log('\n=== 界面布局 / 字体缩放 ===');
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

    // 造数据:一个分组 + 几台长名字主机,并连上一台把 SFTP 打开
    const S = JSON.stringify(SSH);
    await ev(c, `(async () => {
      const g = await window.api.createGroup('生产环境·华东', null);
      const mk = (o) => window.api.createSession(Object.assign({ host: '10.0.0.1', port: 22, username: 'root', password: 'x', groupId: g.id }, o));
      await mk({ name: 'prod-db-mysql-replica-01', host: '10.20.2.21' });
      await mk({ name: 'prod-web-02', host: '10.20.1.12' });
      await mk({ name: 'mock-shell-01', host: '127.0.0.1', port: ${S}, username: 'admin', password: 'admin123' });
      await loadSessions();
      state.settings.verifyHostKey = false; state.settings.autoTrustHostKey = true;
      state.collapsedTopHost = false; state.collapsedGroups.clear();
      state.settings.sessionView = 'tree'; renderSessionList('');
      const s = state.sessions.find((x) => x.name === 'mock-shell-01');
      await connectToServer(s);
      for (let i = 0; i < 60 && !findTabBySessionId(s.id); i++) await new Promise((r) => setTimeout(r, 250));
      return true;
    })()`);
    await sleep(1500);
    await ev(c, `(function(){ document.getElementById('btn-sftp-toggle').click(); return true; })()`);
    await sleep(2000);

    // 量测器:拿关键元素的字号/尺寸
    const measure = `(function () {
      var px = function (el, prop) { return el ? parseFloat(getComputedStyle(el)[prop]) : null; };
      var tree = document.getElementById('session-tree');
      var head = document.querySelector('.top-group-container .asset-group-head');
      var host = document.querySelector('.top-group-container .asset-item.host-item');
      var hostName = host && host.querySelector('.name');
      var caret = document.querySelector('.top-group-container .asset-group-caret');
      var footer = document.querySelector('.asset-footer');
      var title = document.querySelector('.asset-header .asset-title');
      var sfBtn = document.querySelector('.sftp-toolbar-main .btn-mini');
      var sfRow = document.querySelector('.sftp-list .sftp-row, .sftp-list .sftp-item, .sftp-list > *');
      var toolbar = document.querySelector('.toolbar .btn-mini');
      var sfToolbar = document.querySelector('.sftp-toolbar');
      var sfMain = document.querySelector('.sftp-toolbar-main');
      return {
        uiFont: getComputedStyle(document.documentElement).getPropertyValue('--ui-font').trim(),
        headFs: px(head, 'fontSize'), headH: head ? Math.round(head.getBoundingClientRect().height) : null,
        hostFs: px(host, 'fontSize'), hostH: host ? Math.round(host.getBoundingClientRect().height) : null,
        hostNameW: hostName ? hostName.offsetWidth : null,
        hostNameTrunc: !!(hostName && hostName.scrollWidth > hostName.clientWidth + 1),
        caretFs: px(caret, 'fontSize'),
        footerFs: px(footer, 'fontSize'), footerH: footer ? Math.round(footer.getBoundingClientRect().height) : null,
        footerLines: footer ? Math.round(footer.getBoundingClientRect().height / parseFloat(getComputedStyle(footer).lineHeight || footerFs)) : null,
        titleH: title ? Math.round(title.getBoundingClientRect().height) : null,
        titleFs: px(title, 'fontSize'),
        sfBtnFs: px(sfBtn, 'fontSize'), sfRowFs: px(sfRow, 'fontSize'),
        toolbarBtnFs: px(toolbar, 'fontSize'),
        treeClientW: tree ? tree.clientWidth : null, treeScrollW: tree ? tree.scrollWidth : null,
        sfToolbarH: sfToolbar ? Math.round(sfToolbar.getBoundingClientRect().height) : null,
        sfToolbarClip: !!(sfToolbar && sfToolbar.scrollHeight > sfToolbar.clientHeight + 1),
        sfMainClip: !!(sfMain && sfMain.scrollHeight > sfMain.clientHeight + 1),
        sfBtnWrapped: !!(sfBtn && sfBtn.getBoundingClientRect().height > parseFloat(getComputedStyle(sfBtn).fontSize) * 2),
        panelW: document.getElementById('session-panel') ? Math.round(document.getElementById('session-panel').getBoundingClientRect().width) : null,
        overflowers: (function () {
          if (!tree) return [];
          var tr = tree.getBoundingClientRect();
          var out = [];
          [].forEach.call(tree.querySelectorAll('*'), function (el) {
            var r = el.getBoundingClientRect();
            if (r.width > 0 && r.right > tr.right + 1) out.push({ cls: String(el.className).slice(0, 40), w: Math.round(r.width), over: Math.round(r.right - tr.right) });
          });
          return out.slice(0, 5);
        })(),
        footerLineH: footer ? (function () { var v = getComputedStyle(footer).lineHeight; if (v === 'normal') return Math.round(px(footer, 'fontSize') * 1.45); return Math.round(parseFloat(v)); })() : null,
        rects: (function () {
          var pick = function (sel) { var el = document.querySelector(sel); if (!el) return null; var r = el.getBoundingClientRect(); var cs = getComputedStyle(el); return { l: Math.round(r.left), r: Math.round(r.right), w: Math.round(r.width), pl: cs.paddingLeft, pr: cs.paddingRight, ml: cs.marginLeft, box: cs.boxSizing, mw: cs.maxWidth }; };
          return { tree: pick('#session-tree'), box: pick('.top-group-container'), host: pick('.top-group-container .asset-item.host-item'), grid: pick('.session-grid') };
        })(),
        footerPad: footer ? Math.round(parseFloat(getComputedStyle(footer).paddingTop) + parseFloat(getComputedStyle(footer).paddingBottom)) : null,
      };
    })()`;

    // ① 默认 13px:档位与旧像素值一致
    head('① 默认字号(13px)');
    const d = await ev(c, measure);
    if (d.uiFont === '13px') ok('--ui-font 默认 13px');
    else bad('--ui-font 默认值不对', d.uiFont);
    if (d.headFs === 13 && d.hostFs === 13) ok('会话列表分组头/主机名 13px(与旧版一致)');
    else bad('会话列表字号变了', JSON.stringify({ headFs: d.headFs, hostFs: d.hostFs }));
    if (d.sfBtnFs === 12 && d.toolbarBtnFs === 13) ok('SFTP 按钮 12px / 工具栏按钮 13px(与旧版一致)');
    else bad('按钮字号变了', JSON.stringify({ sf: d.sfBtnFs, toolbar: d.toolbarBtnFs }));
    if (d.caretFs === 9) ok('折叠三角 9px(与旧版一致)');
    else bad('三角字号变了', d.caretFs);
    if (d.footerFs === 11) ok('底部提示 11px(与旧版一致)');
    else bad('底部提示字号变了', d.footerFs);

    // ② 默认布局:不横向滚动、标题/提示都单行
    head('② 默认布局健康度');
    if (d.treeScrollW <= d.treeClientW + 2) ok(`会话列表无横向滚动(scrollW=${d.treeScrollW} ≤ ${d.treeClientW})`);
    else bad('会话列表出现横向滚动条', JSON.stringify({ scrollW: d.treeScrollW, clientW: d.treeClientW, over: d.overflowers, rects: d.rects }));
    const footerLines = (h) => Math.round((h - d.footerPad) / (d.footerLineH || d.footerFs));
    if (footerLines(d.footerH) <= 1) ok(`底部提示单行(内容高 ${d.footerH - d.footerPad}px,行高 ${d.footerLineH}px)`);
    else bad('底部提示折行了', JSON.stringify({ h: d.footerH, lineH: d.footerLineH, pad: d.footerPad }));
    if (d.titleH <= d.titleFs * 2) ok(`面板标题单行(高 ${d.titleH}px / 字号 ${d.titleFs}px)`);
    else bad('面板标题折行', JSON.stringify({ h: d.titleH, fs: d.titleFs }));
    if (!d.hostNameTrunc || d.hostNameW > 80) ok(`240px 面板里长主机名可读(name 宽 ${d.hostNameW}px,截断=${d.hostNameTrunc})`);
    else bad('主机名被压缩得太狠', JSON.stringify({ w: d.hostNameW, panelW: d.panelW }));
    if (!d.sfToolbarClip && !d.sfMainClip) ok('SFTP 工具栏内容未被裁切');
    else bad('SFTP 工具栏被裁切', JSON.stringify({ toolbarClip: d.sfToolbarClip, mainClip: d.sfMainClip }));

    // ③ 界面字号 17px:全 UI 跟着放大
    head('③ 界面字号 17px');
    await ev(c, `(async () => {
      state.settings.uiFontSize = 17; applyTheme();
      renderSessionList(els.inputSessionSearch.value);
      window.dispatchEvent(new Event('resize'));
      for (const t of state.tabs.values()) { try { t.fit.fit(); } catch {} }
      await new Promise((r) => setTimeout(r, 400));
      return true;
    })()`);
    await sleep(600);
    const big = await ev(c, measure);
    if (big.uiFont === '17px') ok('--ui-font 已切到 17px');
    else bad('字号没切换', big.uiFont);
    if (big.headFs === 17 && big.hostFs === 17) ok('会话列表分组头/主机名跟着变大(13 → 17)');
    else bad('会话列表没跟着放大', JSON.stringify({ headFs: big.headFs, hostFs: big.hostFs }));
    if (big.headH > d.headH && big.hostH > d.hostH) ok(`行高同步增长(分组头 ${d.headH}→${big.headH}px,主机行 ${d.hostH}→${big.hostH}px)`);
    else bad('行高没跟着变', JSON.stringify({ d: [d.headH, d.hostH], big: [big.headH, big.hostH] }));
    if (big.toolbarBtnFs === 17 && big.sfBtnFs === 16) ok('工具栏 17px / SFTP 按钮 16px(档位按比例放大)');
    else bad('按钮字号没同步', JSON.stringify({ toolbar: big.toolbarBtnFs, sf: big.sfBtnFs }));
    if (big.footerFs === 15 && big.caretFs > 9) ok(`底部提示 15px / 三角 ${big.caretFs}px 也跟着放大`);
    else bad('小字号元素没放大', JSON.stringify({ footer: big.footerFs, caret: big.caretFs }));
    if (big.sfRowFs > d.sfRowFs) ok(`SFTP 文件行 ${d.sfRowFs} → ${big.sfRowFs}px`);
    else bad('SFTP 文件行没放大', JSON.stringify({ before: d.sfRowFs, after: big.sfRowFs }));

    // ④ 大字号下仍然不裁字
    head('④ 17px 下布局不崩');
    if (big.treeScrollW <= big.treeClientW + 2) ok(`会话列表仍无横向滚动(scrollW=${big.treeScrollW} ≤ ${big.treeClientW})`);
    else bad('大字号下会话列表横向溢出', JSON.stringify({ scrollW: big.treeScrollW, clientW: big.treeClientW, over: big.overflowers }));
    if (big.titleH <= big.titleFs * 2) ok(`面板标题仍单行(高 ${big.titleH}px / 字号 ${big.titleFs}px)`);
    else bad('大字号下标题折行', JSON.stringify({ h: big.titleH, fs: big.titleFs }));
    if (!big.sfToolbarClip && !big.sfMainClip) ok(`SFTP 工具栏不裁切(高 ${big.sfToolbarH}px,自动换行)`);
    else bad('大字号下 SFTP 工具栏被裁切', JSON.stringify({ clip: big.sfToolbarClip, mainClip: big.sfMainClip, h: big.sfToolbarH }));
    if (!big.sfBtnWrapped) ok('SFTP 按钮文字不折字(一字一行)');
    else bad('SFTP 按钮文字被折成一字一行');
    if (footerLines(big.footerH) <= 1) ok('大字号下底部提示仍单行(省略号)');
    else bad('大字号下底部提示折行', JSON.stringify({ h: big.footerH, lineH: big.footerLineH, pad: big.footerPad }));

    // 复原
    await ev(c, `(async () => {
      state.settings.uiFontSize = 13; applyTheme(); renderSessionList('');
      window.dispatchEvent(new Event('resize'));
      for (const t of state.tabs.values()) { try { t.fit.fit(); } catch {} }
      return true;
    })()`);

    console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  } catch (e) {
    console.error('\n测试异常:', e && e.message);
    failed++;
  }
  try { killTree(appProc); } catch { /* ignore */ }
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(failed ? 1 : 0);
})();
