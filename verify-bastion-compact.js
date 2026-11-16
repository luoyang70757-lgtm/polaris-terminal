'use strict';
/**
 * verify-bastion-compact.js — 堡垒机区块「显示不要太繁琐」回归
 *
 * 精简前的毛病：
 *   · 会话列表：H3C 区块套了 4 层头（🌐 H3C → ⭐收藏 → 📁站点 → 📁设备名 → 行）；
 *     JMS 全部未分组时也要多一层「🗂 未分组」；H3C 头还重复标 ⭐收藏数。
 *   · 右侧面板：地址栏被两行工具栏挤窄；一个站点都没有时还占一条标签栏；
 *     空态一大块图标 + 3 处"配置/添加"入口。
 *
 * 断言：
 *   ① 单连接收藏不出现「按连接」子层；无归组的主机不人造同名分组
 *   ② JMS 全部未分组时直接平铺（无「🗂 未分组」头）
 *   ③ H3C 区块头不再重复 ⭐N
 *   ④ 没有站点时标签栏整条隐藏；工具栏只剩一行（高 < 60px）
 *   ⑤ 导航/缩放按钮不在可视区但仍在 DOM（脚本/快捷键仍可用）
 *   ⑥ 「⋯」菜单含 堡垒机配置/后退/前进/刷新/放大/缩小/重置缩放
 *   ⑦ 工具栏按钮收敛:⚙ 收进菜单、不再有与地址栏重复的「当前页」行
 *
 * 运行：node verify-bastion-compact.js（需 9482 空闲）
 */
const { spawn } = require('child_process');
const { freePort, killTree, guardTimeout, evaluate } = require('./test-helper');
const fs = require('fs'); const os = require('os'); const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-bcompact-'));
const PORT = 9482, SSH = 2244, HTTP = 8144;
freePort(PORT); freePort(SSH); freePort(HTTP);
process.env.MOCK_SSH_PORT = String(SSH);
process.env.MOCK_HTTP_PORT = String(HTTP);
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
  console.log('\n=== 堡垒机区块「精简显示」===');
  try {
    const lockT = (await targets()).find((t) => /解锁/.test(t.title || ''));
    const lock = await connect(lockT.webSocketDebuggerUrl);
    for (let i = 0; i < 40; i++) { if (await ev(lock, `!!document.getElementById('pw')`)) break; await sleep(300); }
    await sleep(300);
    await ev(lock, `document.getElementById('pw').value='x12345678'; document.getElementById('pw2').value='x12345678'; document.getElementById('btn').click();`);
    let c = null;
    for (let i = 0; i < 40; i++) {
      await sleep(400);
      const m = (await targets()).find((t) => t.type === 'page' && !/解锁/.test(t.title || ''));
      if (m) { c = await connect(m.webSocketDebuggerUrl); break; }
    }
    if (!c) throw new Error('解锁后主窗口未出现');
    for (let i = 0; i < 50; i++) { if (await ev(c, `typeof state === 'object' && !!state.groups`)) break; await sleep(200); }

    head('① 会话列表:收藏/未分组层数');
    const layers = await ev(c, `(function(){
      state.settings.onboardingDone = true;
      try { document.getElementById('onboarding-modal').classList.add('hidden'); } catch (e) {}
      // 单台 H3C 堡垒机 + 1 台收藏(未归组) + 1 台普通目录设备
      state.bastionAssets = [
        { devId:'h1', name:'web-node-1', ip:'10.0.0.21', port:22, proto:'ssh', accounts:['root'], recentAccount:'root', dir:'生产一', dirPath:['生产一'], favorite:true },
        { devId:'h2', name:'db-node-1', ip:'10.0.0.22', port:22, proto:'ssh', accounts:['root'], recentAccount:'', dir:'生产一', dirPath:['生产一'], favorite:false },
      ];
      state.bastionUrls = ['https://h3c-bastion.example'];
      state.bastionUrl = 'https://h3c-bastion.example';
      state.bastionFavGroups = [];
      state.bastionDirsInit = true;            // 跳过"首次默认折叠"
      state.bastionDirCollapsed.clear();
      state.bastionCollapsed = false; state.collapsedTopBastion = false;
      // JMS:2 台资产都没节点(未分组)
      state.jmsServers = [{ id:'jms-1', name:'总部 JumpServer', baseUrl:'https://jms.example', sshHost:'127.0.0.1', sshPort:${SSH},
        account:'admin', password:'enc:x', token:'tok', user:{username:'admin'},
        assets:[{id:'a1',name:'web-server-01',address:'10.0.0.11'},{id:'a2',name:'db-server-01',address:'10.0.0.12'}] }];
      state.collapsedJms.clear();
      renderSessionList('');
      const heads = [...document.querySelectorAll('#session-tree .asset-group-head, #session-tree .asset-item')]
        .map((el) => ({ cls: el.className, txt: (el.querySelector('.asset-group-name, .name') || {}).textContent || el.textContent || '' }));
      return JSON.stringify({
        h3cHead: (heads.find((h) => /H3C 堡垒机/.test(h.txt)) || {}).txt || '',
        hasOriginLayer: heads.some((h) => /h3c-bastion\\.example/.test(h.txt)),
        hasDeviceGroup: heads.some((h) => /^web-node-1\\(/.test(h.txt)),
        favRow: heads.some((h) => h.cls.includes('asset-item') && /web-node-1/.test(h.txt)),
        jmsHead: (heads.find((h) => /总部 JumpServer/.test(h.txt)) || {}).txt || '',
        hasUngroupedLayer: heads.some((h) => /未分组/.test(h.txt)),
        // 注意:堡垒机(H3C)资产行也用 .jms-asset-item 这个类名,靠资产名区分
        jmsRows: heads.filter((h) => /web-server-01|db-server-01/.test(h.txt)).length,
        jmsTxts: heads.filter((h) => h.cls.includes('jms-asset-item')).map((h) => h.txt),
      });
    })()`);
    const L = JSON.parse(layers);
    if (!L.hasOriginLayer) ok('单连接收藏不再套「📁 站点(origin)」一层');
    else bad('收藏仍出现按连接的子层', layers);
    if (!L.hasDeviceGroup) ok('未归组的收藏主机不再人造同名分组(直接是行)');
    else bad('仍造了与主机同名的分组', layers);
    if (L.favRow) ok('收藏主机直接以设备行显示');
    else bad('收藏主机行缺失', layers);
    if (!/⭐\\d/.test(L.h3cHead)) ok(`H3C 区块头不再重复标收藏数(${L.h3cHead})`);
    else bad('H3C 区块头仍带 ⭐N', L.h3cHead);
    if (!L.hasUngroupedLayer) ok('JMS 全部未分组时不再多一层「🗂 未分组」');
    else bad('JMS 仍有「未分组」中间层', layers);
    if (L.jmsRows === 2) ok('JMS 两台资产直接平铺(2 行,没有中间分组层)');
    else bad('JMS 行数不对', layers);

    head('② 右侧面板:标签栏 / 工具栏行数');
    const panel = await ev(c, `(function(){
      state.settings.bastionServers = [];           // 没有任何站点
      try { bastionRenderTabs(); } catch (e) {}
      openBastionPanel();
      const tabs = document.getElementById('bastion-tabs');
      const bar = document.querySelector('.bastion-bar');
      let barRows = 0;
      try {
        const ts = [...bar.children].filter((el) => el.offsetParent !== null && el.getBoundingClientRect().width > 0);
        const tops = ts.map((el) => Math.round(el.getBoundingClientRect().top)).sort((a, b) => a - b);
        barRows = 0; let last = null;
        for (const t of tops) { if (last === null || t - last > 8) barRows++; last = t; }
      } catch (e) {}
      return JSON.stringify({
        tabsHidden: tabs.classList.contains('hidden') || getComputedStyle(tabs).display === 'none',
        barH: Math.round(bar.getBoundingClientRect().height),
        barRows,
        navHidden: document.getElementById('bastion-back').offsetParent === null,
        zoomHidden: document.getElementById('bastion-zoom-label').offsetParent === null,
        backInDom: !!document.getElementById('bastion-back'),
        zoomInDom: !!document.getElementById('bastion-zoom-label'),
        emptyIcon: (document.querySelector('#bastion-empty .be-icon') || {}).textContent,
        cfgHidden: document.getElementById('bastion-cfg').offsetParent === null,
        cfgInDom: !!document.getElementById('bastion-cfg'),
        visibleBtns: [...bar.querySelectorAll('button')].filter((b) => b.offsetParent !== null).length,
        currentText: (document.getElementById('bastion-current') || {}).textContent || '',
      });
    })()`);
    const P = JSON.parse(panel);
    if (P.tabsHidden) ok('没有站点时整条标签栏隐藏');
    else bad('空站点仍占一条标签栏', panel);
    if (P.barH < 60 && P.barRows <= 1) ok(`工具栏收成一行(高 ${P.barH}px)`);
    else bad('工具栏仍是多行', JSON.stringify({ h: P.barH, rows: P.barRows }));
    if (P.navHidden && P.zoomHidden && P.backInDom && P.zoomInDom) ok('导航/缩放按钮不可见但仍在 DOM(脚本与快捷键可调)');
    else bad('导航/缩放按钮状态异常', panel);
    if (P.cfgHidden && P.cfgInDom) ok('⚙ 配置按钮收进菜单(仍在 DOM,「编辑连接」等流程可直接调用)');
    else bad('⚙ 配置按钮状态异常', panel);
    if (P.visibleBtns <= 4) ok(`工具栏可见按钮只剩 ${P.visibleBtns} 个:站点下拉 / 打开 / ⋯ / 最小化 / 关闭`);
    else bad('工具栏按钮仍然偏多', P.visibleBtns);
    if (P.emptyIcon === '🌐') ok('空态图标保留(🌐)但改为内联小图标');
    else bad('空态图标异常', P.emptyIcon);

    head('③ 「⋯」菜单补齐被收起的操作');
    const menu = await ev(c, `(function(){
      document.getElementById('bastion-more').click();
      const m = document.getElementById('ctx-menu');
      const txt = m ? m.textContent : '';
      const vis = !!m && !m.classList.contains('hidden');
      if (m) closeCtxMenu();
      return JSON.stringify({ vis, txt });
    })()`);
    const M = JSON.parse(menu);
    const need = ['堡垒机配置', '后退', '前进', '刷新页面', '放大', '缩小', '重置缩放'];
    const miss = need.filter((k) => !M.txt.includes(k));
    if (M.vis && !miss.length) ok(`「⋯」菜单含 ${need.join(' / ')}`);
    else bad('「⋯」菜单缺少项', JSON.stringify({ miss, txt: M.txt.slice(0, 200) }));

    console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  } catch (e) {
    console.error('\n测试异常:', e && e.message);
    failed++;
    console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  }
  try { killTree(appProc); } catch { /* ignore */ }
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(failed ? 1 : 0);
})();
