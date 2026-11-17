#!/usr/bin/env node
/**
 * verify-bastion-group-fold.js — 会话列表里「已保存堡垒机连接」下的资产分组:三角箭头 + 默认折叠
 *
 * 背景(用户反馈「分组要添加三角箭头,默认分组是折叠状态」):
 * `renderBastionSavedSessions()` 里 JMS / H3C 两条分支以前都是纯文字分组头
 * (`div.bastion-asset-group-head` + `textContent = '📁 分组(N)'`),**没有三角、永远全展开**:
 * 一个连接下有 5 个业务目录 + 300 台资产时,一展开就是一屏刷不完,也没法只挑一个组看。
 *
 * 现在两条分支都走 `makeBastionGroupHead()`:
 *   · 头上有 `.asset-group-caret`(▶ 折叠 / ▼ 展开),整行也可点(三角太小不好点)
 *   · **默认折叠**:展开态只记在 `state.bastionSavedGroupsExpanded`(内存 Set,key=`saved:<connId>:<分组>`),
 *     启动 / 清空「清除历史」/ 点「收起全部分组」都会回到全折叠
 *   · 分组之间互不影响;搜索命中自动展开(否则搜到了却看不见)
 *   · 右键菜单(批量连接)仍保留
 *
 * 纯结构断言 + CDP e2e 断言各一段。
 * 运行:node verify-bastion-group-fold.js
 */
'use strict';
const { spawn } = require('child_process');
const { freePort, killTree, guardTimeout, evaluate } = require('./test-helper');
const fs = require('fs');
const os = require('os');
const path = require('path');

let passed = 0;
let failed = 0;
const ok = (n, d) => { passed++; console.log('  ✓ ' + n + (d ? '  → ' + d : '')); };
const bad = (n, e) => { failed++; console.error('  ✗ ' + n + (e ? '  → ' + e : '')); };

// ---------------------------------------------------------------- ① 源码结构
console.log('\n=== 堡垒机资产分组:三角 + 默认折叠 ===\n');
console.log('— 源码结构 —');
const RENDERER = path.join(__dirname, 'src', 'renderer.js');
const STYLES = path.join(__dirname, 'src', 'styles.css');
const src = fs.readFileSync(RENDERER, 'utf8');
const css = fs.readFileSync(STYLES, 'utf8');

if (/function makeBastionGroupHead\(label, key, opts\)/.test(src)) ok('存在 makeBastionGroupHead(唯一的分组头构造函数)');
else bad('缺少 makeBastionGroupHead');
const uses = (src.match(/makeBastionGroupHead\(/g) || []).length;
if (uses >= 3) ok(`两处渲染分支都改用它(JMS/H3C + 定义本身,共 ${uses} 处)`);
else bad('渲染分支没接线', uses);
const headRefs = (src.match(/bastion-asset-group-head/g) || []).length;
if (headRefs === 1) ok('只剩 makeBastionGroupHead 一处构造分组头(旧的「纯文字分组头」写法已删净)');
else bad('还有别处在拼 bastion-asset-group-head(容易出现没三角的分组头)', headRefs);

if (/bastionSavedGroupsExpanded: new Set\(\)/.test(src)) ok('state 里有 bastionSavedGroupsExpanded(默认空 = 全折叠)');
else bad('state 缺 bastionSavedGroupsExpanded');
if (/function collapseAllBastionGroups\(\)[\s\S]{0,220}?state\.bastionSavedGroupsExpanded\.clear\(\)/.test(src)) ok('「收起全部分组」会把已保存连接的资产分组一起收起');
else bad('collapseAllBastionGroups 没清展开态');

const headCss = (/:?\s*\.bastion-asset-group-head \{[^}]*\}/.exec(css) || [''])[0];
if (/display: flex/.test(headCss) && /cursor: pointer/.test(headCss)) ok('分组头是 flex + 可点击(三角与名字同行)');
else bad('分组头样式不完整', headCss.slice(0, 120));
const caretCss = (/.asset-group-caret \{[^}]*\}/.exec(css) || [''])[0];
if (/font-size: var\(--fs-base\)/.test(caretCss) && /color: var\(--accent\)/.test(caretCss)) ok('折叠三角放大到界面基准字号(13px)且用强调色(暗背景上一眼可见)');
else bad('折叠三角样式仍太小/不显眼', caretCss.slice(0, 120));

// ---------------------------------------------------------------- ② e2e
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-fold-'));
const PORT = 9462;
freePort(PORT);
const appProc = spawn(require('electron'), ['.', '--dev', `--remote-debugging-port=${PORT}`, '--no-sandbox', '--disable-gpu'], {
  env: { ...process.env, POLARIS_LOCK_DIR: DIR, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  stdio: ['ignore', 'ignore', 'ignore'], detached: true,
});
guardTimeout(150000, appProc);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function listTargets() {
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json`); return await r.json(); } catch { /* not ready */ }
    await sleep(400);
  }
  throw new Error('targets 未就绪');
}
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    ws.onopen = () => resolve({
      call(m, p = {}) { return new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method: m, params: p })); }); },
      close() { ws.close(); },
    });
    ws.onerror = (e) => reject(e);
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };
  });
}
const ev = (c, expr) => evaluate(c, expr);

(async () => {
  try {
    const ts0 = await listTargets();
    const lockT = ts0.find((t) => /解锁/.test(t.title || '')) || ts0.find((t) => t.type === 'page');
    if (!lockT) throw new Error('锁定页未就绪');
    const lock = await connect(lockT.webSocketDebuggerUrl);
    for (let i = 0; i < 40; i++) { if (await ev(lock, `!!document.getElementById('pw')`)) break; await sleep(300); }
    await ev(lock, `document.getElementById('pw').value='x1234567'; document.getElementById('pw2').value='x1234567'; document.getElementById('btn').click();`);
    let c = null;
    for (let i = 0; i < 50; i++) {
      await sleep(400);
      const t2 = await listTargets();
      const m = t2.find((t) => t.type === 'page' && !/解锁/.test(t.title || ''));
      if (m) { c = await connect(m.webSocketDebuggerUrl); break; }
    }
    if (!c) throw new Error('主窗口未就绪');
    for (let i = 0; i < 40; i++) { if (await ev(c, `typeof state === 'object' && !!state.settings`)) break; await sleep(200); }
    await ev(c, `state.settings.appLock = false;`);

    console.log('\n— 造数据(1 个 JMS 连接 2 个分组 + 1 个 H3C 连接 2 个目录)—');
    // 直接在 state 里放已保存连接(不落盘,避免污染真实数据目录):JMS 资产带 nodes,H3C 资产带 dirs
    const seeded = await ev(c, `(function(){
      state.settings.bastionServers = [
        { id: 'bastion-fold-jms', name: 'JMS 折叠测试', url: 'http://127.0.0.1:8080', type: 'jms',
          account: 'polaris', password: '', sshHost: '127.0.0.1', sshPort: 2222,
          assets: [
            { name: 'prod-a', address: '10.0.0.1', nodes: [{ name: '生产组' }] },
            { name: 'prod-b', address: '10.0.0.2', nodes: [{ name: '生产组' }] },
            { name: 'test-a', address: '10.0.0.3', nodes: [{ name: '测试组' }] },
          ],
          assetsExpanded: true },
        { id: 'bastion-fold-h3c', name: 'H3C 折叠测试', url: 'http://h3c.example/shterm', type: 'h3c',
          account: 'polaris', password: '', assetsExpanded: true },
      ];
      state.bastionUrl = 'http://h3c.example';
      state.bastionAssets = [
        { name: 'sw-1', ip: '10.1.1.1', devId: 'd1', dirs: ['核心机房'], favorite: false },
        { name: 'sw-2', ip: '10.1.1.2', devId: 'd2', dirs: ['核心机房'], favorite: false },
        { name: 'fw-1', ip: '10.1.1.3', devId: 'd3', dirs: ['边界'], favorite: false },
      ];
      state.collapsedTopHost = true;
      state.collapsedTopBastion = false;   // 展开 🛡 堡垒机,才看得到已保存连接
      state.collapsedBastionSaved = false;
      state.bastionSavedGroupsExpanded.clear(); // 模拟「刚启动 / 刚清除历史」
      renderSessionList('');
      // 快照器:每个分组头的三角、展开标记、其下可见资产行数
      window.__foldSnap = function(){
        return [...document.querySelectorAll('.bastion-asset-group-head')].map(function(h){
          var nm = h.querySelector('.bastion-group-name');
          var rows = 0;
          var n = h.nextElementSibling;
          while (n && !n.classList.contains('bastion-asset-group-head')) {
            if (n.classList.contains('asset-item')) rows++;
            n = n.nextElementSibling;
          }
          var cs = getComputedStyle(h);
          var cc = getComputedStyle(h.querySelector('.asset-group-caret'));
          return {
            label: nm ? nm.textContent : h.textContent.trim(),
            caret: (h.querySelector('.asset-group-caret') || {}).textContent || '',
            expanded: h.dataset.expanded,
            key: h.dataset.groupKey,
            rows: rows,
            display: cs.display, cursor: cs.cursor, caretPx: parseFloat(cc.fontSize)
          };
        });
      };
      return window.__foldSnap();
    })()`);

    const jmsHeads = seeded.filter((h) => /生产组|测试组/.test(h.label));
    const h3cHeads = seeded.filter((h) => /核心机房|边界/.test(h.label));
    if (jmsHeads.length === 2 && h3cHeads.length === 2) ok(`JMS / H3C 两条分支的分组头都渲染出来(共 ${seeded.length} 个头)`, seeded.map((h) => h.label).join(' | '));
    else bad('分组头数量不对', JSON.stringify(seeded.map((h) => h.label)));

    // ① 默认折叠:头是 ▶、下面 0 行资产
    const allCollapsed = seeded.every((h) => h.caret === '▶' && h.expanded === '0' && h.rows === 0);
    if (allCollapsed && seeded.length === 4) ok('默认全部折叠:4 个分组头都是 ▶,其下 0 台资产(不再一展开就刷屏)');
    else bad('默认不是折叠状态', JSON.stringify(seeded.map((h) => [h.label, h.caret, h.expanded, h.rows])));

    // ② 三角是可见/可点的:flex + pointer + ≥13px
    const styleOk = seeded.every((h) => h.display === 'flex' && h.cursor === 'pointer' && h.caretPx >= 13);
    if (styleOk) ok('分组头 flex + cursor:pointer,三角 13px(能看见、能点中)');
    else bad('分组头样式未生效', JSON.stringify(seeded.map((h) => [h.display, h.cursor, h.caretPx])));

    // ③ 点 JMS「生产组」三角 → 只有它展开,兄弟组不受影响
    const expandJms = await ev(c, `(function(){
      var hs = [...document.querySelectorAll('.bastion-asset-group-head')];
      var h = hs.find(function(x){ var n = x.querySelector('.bastion-group-name'); return n && /生产组/.test(n.textContent); });
      if (!h) return null;
      h.querySelector('.asset-group-caret').click();
      return window.__foldSnap();
    })()`);
    const prod = expandJms && expandJms.find((h) => /生产组/.test(h.label));
    const test = expandJms && expandJms.find((h) => /测试组/.test(h.label));
    if (prod && prod.caret === '▼' && prod.rows === 2) ok('点「生产组」三角:▼ 且列出 2 台资产');
    else bad('点三角没展开生产组', JSON.stringify(prod));
    if (test && test.caret === '▶' && test.rows === 0) ok('兄弟分组「测试组」仍是 ▶、0 行(分组互不影响)');
    else bad('兄弟分组被连带展开/折叠', JSON.stringify(test));

    // ④ 再点一次 → 收起
    const collapseBack = await ev(c, `(function(){
      var hs = [...document.querySelectorAll('.bastion-asset-group-head')];
      var h = hs.find(function(x){ var n = x.querySelector('.bastion-group-name'); return n && /生产组/.test(n.textContent); });
      h.querySelector('.asset-group-caret').click();
      var p = window.__foldSnap().find(function(x){ return /生产组/.test(x.label); });
      return p;
    })()`);
    if (collapseBack && collapseBack.caret === '▶' && collapseBack.rows === 0) ok('再点一次回到 ▶、资产收起');
    else bad('再次点击没收起', JSON.stringify(collapseBack));

    // ⑤ 点整行(不是三角)也能切换 —— 三角太小不好点,给大目标
    const rowClick = await ev(c, `(function(){
      var hs = [...document.querySelectorAll('.bastion-asset-group-head')];
      var h = hs.find(function(x){ var n = x.querySelector('.bastion-group-name'); return n && /测试组/.test(n.textContent); });
      h.click(); // 点名字/空白处
      return window.__foldSnap().find(function(x){ return /测试组/.test(x.label); });
    })()`);
    if (rowClick && rowClick.caret === '▼' && rowClick.rows === 1) ok('点整行也能展开(不非得精确点中小三角)');
    else bad('整行点击没切换', JSON.stringify(rowClick));

    // ⑥ H3C 目录头同样可折叠
    const h3cFold = await ev(c, `(function(){
      var hs = [...document.querySelectorAll('.bastion-asset-group-head')];
      var h = hs.find(function(x){ var n = x.querySelector('.bastion-group-name'); return n && /核心机房/.test(n.textContent); });
      h.querySelector('.asset-group-caret').click();
      return window.__foldSnap().filter(function(x){ return /核心机房|边界/.test(x.label); });
    })()`);
    const core = h3cFold && h3cFold.find((h) => /核心机房/.test(h.label));
    const edge = h3cFold && h3cFold.find((h) => /边界/.test(h.label));
    if (core && core.caret === '▼' && core.rows === 2 && edge && edge.caret === '▶' && edge.rows === 0) ok('H3C 站点目录分组:展开「核心机房」得 2 台,「边界」仍折叠');
    else bad('H3C 目录折叠异常', JSON.stringify(h3cFold));

    // ⑥.5 列表视图的「未分组」兜底头也要有三角(用户要求:所有分组头都有 ▶/▼)
    const orphan = await ev(c, `(function(){
      state.settings.sessionView = 'list';
      state.sessions = [{ id: 99001, name: '孤儿主机', host: '10.9.9.9', port: 22, username: 'root', group_id: 999999 }];
      state.groups = [];
      state.collapsedOrphans = undefined;
      state.collapsedTopHost = false;
      state.collapsedGroups.clear();
      renderSessionList('');
      var h = [...document.querySelectorAll('.asset-group-head.list-head')].pop();
      if (!h) return null;
      var caret = h.querySelector('.asset-group-caret');
      var rows = [...document.querySelectorAll('.host-item')].length;
      var out = { caret: caret ? caret.textContent : '', text: (h.querySelector('.asset-group-name') || h).textContent, hostRows: rows, clickable: getComputedStyle(h).cursor };
      h.click(); // 展开
      out.afterClickCaret = (h.ownerDocument.querySelectorAll('.asset-group-head.list-head .asset-group-caret')[0] || {}).textContent || '';
      out.afterClickRows = [...document.querySelectorAll('.host-item')].length;
      return out;
    })()`);
    if (orphan && orphan.caret === '▶' && /未分组/.test(orphan.text) && orphan.hostRows === 0) ok('列表视图「未分组」兜底头也有 ▶ 且默认折叠');
    else bad('未分组兜底头没三角/默认展开', JSON.stringify(orphan));
    if (orphan && orphan.afterClickCaret === '▼' && orphan.afterClickRows >= 1) ok('点它同样能展开(展开后列出孤儿会话)');
    else bad('未分组兜底头点击无效', JSON.stringify(orphan));
    await ev(c, `state.sessions = []; state.settings.sessionView = 'tree'; state.collapsedOrphans = undefined; renderSessionList('');`);

    // ⑦ 折叠状态跨重渲染保持(点资产/切搜索都会重渲染)
    const persist = await ev(c, `(function(){
      renderSessionList('');
      var s = window.__foldSnap().find(function(x){ return /核心机房/.test(x.label); });
      return s;
    })()`);
    if (persist && persist.caret === '▼' && persist.rows === 2) ok('重渲染后展开状态保持(不会自己弹回折叠)');
    else bad('重渲染丢了展开状态', JSON.stringify(persist));

    // ⑧ 搜索命中自动展开(否则搜到了却看不见)
    const searchExpand = await ev(c, `(function(){
      state.bastionSavedGroupsExpanded.clear();
      renderSessionList('');
      els.inputSessionSearch.value = 'prod-a';
      els.inputSessionSearch.dispatchEvent(new Event('input', { bubbles: true }));
      renderSessionList('prod-a');
      var snap = window.__foldSnap();
      var p = snap.find(function(x){ return /生产组/.test(x.label); });
      return { p: p, heads: snap.map(function(x){ return x.label; }) };
    })()`);
    if (searchExpand.p && searchExpand.p.caret === '▼' && searchExpand.p.rows === 1) ok('搜索「prod-a」:命中分组自动展开且只显示命中的 1 台');
    else bad('搜索没自动展开命中分组', JSON.stringify(searchExpand.p));
    await ev(c, `els.inputSessionSearch.value=''; els.inputSessionSearch.dispatchEvent(new Event('input', { bubbles: true })); renderSessionList('');`);

    // ⑨ 「收起全部分组」回到全折叠
    const collapseAll = await ev(c, `(function(){
      collapseAllBastionGroups();
      var snap = window.__foldSnap();
      return { expandedSet: state.bastionSavedGroupsExpanded.size, snap: snap };
    })()`);
    const backToFolded = collapseAll.snap.length > 0 && collapseAll.snap.every((h) => h.caret === '▶' && h.rows === 0);
    if (collapseAll.expandedSet === 0 && backToFolded) ok('「收起全部分组」→ 展开集合清空、全部回到 ▶');
    else bad('收起全部分组没回到默认折叠', JSON.stringify({ set: collapseAll.expandedSet, snap: collapseAll.snap.map((h) => [h.label, h.caret, h.rows]) }));

    // ⑩ 分组头右键菜单(批量连接)仍在
    const ctx = await ev(c, `(function(){
      var hs = [...document.querySelectorAll('.bastion-asset-group-head')];
      var h = hs.find(function(x){ var n = x.querySelector('.bastion-group-name'); return n && /生产组/.test(n.textContent); });
      var evt = new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 40 });
      h.dispatchEvent(evt);
      return true;
    })()`);
    await sleep(300);
    const menuText = await ev(c, `(document.getElementById('ctx-menu') || {}).textContent || ''`);
    if (ctx && /批量连接/.test(menuText)) ok('分组头右键仍是「🔗 批量连接」', String(menuText).trim().slice(0, 40));
    else bad('分组头右键菜单丢了', menuText);
    await ev(c, `(document.getElementById('ctx-menu') || {}).classList && document.getElementById('ctx-menu').classList.add('hidden');`);

    // ⑪ 展开集合是内存态:不写 localStorage / 不写设置
    const persistedCheck = await ev(c, `(function(){
      state.bastionSavedGroupsExpanded.add('saved:bastion-fold-jms:生产组');
      saveSettings();
      var raw = localStorage.getItem('settings') || '';
      return { inSettings: raw.indexOf('bastionSavedGroupsExpanded') >= 0, inLocalStorage: raw.indexOf('saved:bastion-fold-jms') >= 0 };
    })()`);
    if (!persistedCheck.inSettings && !persistedCheck.inLocalStorage) ok('展开/折叠状态不落盘(每次启动都回到全折叠,符合约定)');
    else bad('折叠状态被持久化了', JSON.stringify(persistedCheck));
  } catch (e) {
    bad('e2e 异常', e.message + '\n' + String(e.stack || '').split('\n').slice(0, 3).join(' '));
  } finally {
    killTree(appProc);
    try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  console.log(`\n结果: ${passed} 通过, ${failed} 失败\n`);
  process.exit(failed ? 1 : 0);
})();
