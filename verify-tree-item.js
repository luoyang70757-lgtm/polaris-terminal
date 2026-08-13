'use strict';
/**
 * verify-tree-item.js — 验证树形/列表视图主机 = 紧凑小条(无右侧「}」竖线 + 宽度贴合内容;JMS/分组头仍带分割线)
 * 运行: node verify-tree-item.js(需 9341 空闲)
 * 断言: 首次打开(不手动展开分组)分组默认折叠;树形/列表行 .host-item 与分组头均无右侧竖线(border-right 0);JMS/H3C 资产行仍带右侧亮色分割线;网格视图不变(卡片)
 */
const { spawn } = require('child_process');
const { freePort, killTree, guardTimeout } = require('./test-helper');
const fs = require('fs'); const os = require('os'); const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-treeitem-'));
const PORT = 9341;
freePort(PORT);
const appProc = spawn('node_modules/.bin/electron', ['.', '--dev', `--remote-debugging-port=${PORT}`], {
  env: { ...process.env, POLARIS_LOCK_DIR: DIR, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  stdio: ['ignore', 'ignore', 'ignore'], detached: true,
});
guardTimeout(90000, appProc);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function targets() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json`);
      const j = await r.json();
      const p = j.find((t) => t.type === 'page' && /解锁|Polaris/.test(t.title || ''));
      if (p) return j;
    } catch { /* not ready */ }
    await sleep(400);
  }
  throw new Error('targets 未就绪');
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
  if (r.exceptionDetails) throw new Error('JS异常: ' + JSON.stringify(r.exceptionDetails.exception && r.exceptionDetails.exception.description));
  return r.result && r.result.value;
}
let passed = 0, failed = 0;
const ok = (n) => { passed++; console.log('  ✓ ' + n); };
const bad = (n, e) => { failed++; console.error('  ✗ ' + n + (e ? ' -> ' + e : '')); };

(async () => {
  console.log('\n=== 树形紧凑小条布局验证 ===\n');
  try {
    const ts = await targets();
    const lockT = ts.find((t) => /解锁/.test(t.title || ''));
    const lock = await connect(lockT.webSocketDebuggerUrl);
    for (let i = 0; i < 30; i++) { if (await ev(lock, `!!document.getElementById('pw')`)) break; await sleep(300); }
    await sleep(400);
    await ev(lock, `document.getElementById('pw').value='x1234'; document.getElementById('pw2').value='x1234'; document.getElementById('btn').click();`);
    let main = null, c = null;
    for (let i = 0; i < 30; i++) {
      await sleep(500);
      const t2 = await targets();
      const m = t2.find((t) => t.type === 'page' && !/解锁/.test(t.title || ''));
      if (m) { main = m; break; }
    }
    c = await connect(main.webSocketDebuggerUrl);
    await sleep(1200);

    // 造 3 个会话;loadSessions 走启动路径(不手动展开分组)
    await ev(c, `(async()=>{ for (const n of ['web-server-01','db-server-02','app-03']) await window.api.createSession({name:n, host:'127.0.0.1', port:22, username:'root', password:'x', protocol:'ssh'}); await loadSessions(); renderSessionList(''); return true; })()`);
    await sleep(600);

    // 首次打开(树形默认):全部分组默认折叠 → 只显示分组头,主机行隐藏
    const boot = JSON.parse(await ev(c, `JSON.stringify({
      collapsedCount: state.collapsedGroups.size,
      groupCount: state.groups.length,
      hostRows: [...document.querySelectorAll('.asset-item.host-item')].length,
      heads: [...document.querySelectorAll('.asset-group-head')].length,
    })`));
    if (boot.collapsedCount === boot.groupCount && boot.groupCount >= 1 && boot.hostRows === 0 && boot.heads >= boot.groupCount) {
      ok(`默认不打开分组:${boot.collapsedCount} 个分组折叠,只显示分组头(${boot.heads}),主机行隐藏(${boot.hostRows})`);
    } else bad('启动分组折叠异常: ' + JSON.stringify(boot), null);

    // 展开分组 → 主机行带分割线可见
    await ev(c, `state.collapsedGroups.clear(); renderSessionList('');`);
    await sleep(400);

    // 树形视图:紧凑条;主机条不再有右侧「}」竖线(border-right 已去掉),宽度仍贴合内容
    const tree = JSON.parse(await ev(c, `JSON.stringify({
      m: (()=>{ const el=document.querySelector('.asset-item.host-item'); if(!el) return null; const r=el.getBoundingClientRect(); const cr=document.getElementById('session-tree').getBoundingClientRect(); const cs=getComputedStyle(el); return {rowW:Math.round(r.width), contW:Math.round(cr.width), border:cs.borderRightWidth, marginR:cs.marginRight}; })()
    })`));
    if (tree.m && tree.m.rowW < tree.m.contW && tree.m.border === '0px' && tree.m.marginR === '0px') {
      ok(`树形紧凑条:宽度 ${tree.m.rowW}px < 容器 ${tree.m.contW}px,右侧竖线已去掉(border-right ${tree.m.border}、留白 ${tree.m.marginR}),不再是「}」大括号`);
    } else bad('树形布局异常: ' + JSON.stringify(tree), null);

    // JMS/H3C 堡垒机资产行(asset-item jms-asset-item)同样带右侧分割线
    const jms = JSON.parse(await ev(c, `(function(){ const el=document.createElement('div'); el.className='asset-item jms-asset-item'; document.getElementById('session-tree').appendChild(el); const cs=getComputedStyle(el); const w=cs.borderRightWidth, color=cs.borderRightColor, mr=cs.marginRight; el.remove(); return JSON.stringify({w, color, mr}); })()`));
    if (jms.w === '2px' && jms.color === 'rgb(148, 169, 218)' && jms.mr === '8px') {
      ok(`JMS/H3C 资产行同样带右侧亮色分割线(${jms.w} ${jms.color})`);
    } else bad('JMS/H3C 资产行无分割线: ' + JSON.stringify(jms), null);

    // 分组头(asset-group-head)右侧也不再有「}」竖线
    const ghead = JSON.parse(await ev(c, `(function(){ const el=document.querySelector('.asset-group-head'); if(!el) return null; const cs=getComputedStyle(el); return JSON.stringify({w:cs.borderRightWidth}); })()`));
    if (ghead && ghead.w === '0px') {
      ok(`分组头右侧竖线已去掉(border-right ${ghead.w}),不再是「}」大括号`);
    } else bad('分组头仍有右侧竖线: ' + JSON.stringify(ghead), null);

    // 三个视图切换按钮:带文字标签,均分整行,总宽与分组头一致(协调美观)
    const vs = JSON.parse(await ev(c, `JSON.stringify({
      texts: [...document.querySelectorAll('.vs-btn')].map(b=>b.textContent.trim()),
      totalW: (()=>{ const bs=[...document.querySelectorAll('.vs-btn')]; if(!bs.length) return 0; const r=bs[0].getBoundingClientRect(); return Math.round((bs[bs.length-1].getBoundingClientRect().right - r.left)); })(),
      gap: getComputedStyle(document.querySelector('.view-switch')).gap,
      headW: Math.round(document.querySelector('.asset-group-head').getBoundingClientRect().width),
    })`));
    const hasLabels = vs.texts.length === 3 && vs.texts[0].includes('网格') && vs.texts[1].includes('列表') && vs.texts[2].includes('树形');
    const matchesHead = vs.totalW >= vs.headW - 30 && vs.totalW <= vs.headW + 10;
    if (hasLabels && matchesHead && vs.gap === '4px') {
      ok(`三个视图按钮:${vs.texts.join(' / ')},总宽 ${vs.totalW}px ≈ 分组头 ${vs.headW}px,间距 ${vs.gap}(协调美观)`);
    } else bad('视图按钮布局异常: ' + JSON.stringify(vs), null);

    // 列表视图:同样紧凑条(有 host-item)
    await ev(c, `state.settings.sessionView='list'; renderSessionList('');`);
    await sleep(500);
    const list = JSON.parse(await ev(c, `JSON.stringify({
      hostItem: [...document.querySelectorAll('.asset-item.host-item')].length,
      rows: [...document.querySelectorAll('.asset-item')].length,
      m: (()=>{ const el=document.querySelector('.asset-item'); if(!el) return null; const r=el.getBoundingClientRect(); const cr=document.getElementById('session-tree').getBoundingClientRect(); return {rowW:Math.round(r.width), contW:Math.round(cr.width)}; })()
    })`));
    if (list.hostItem >= 3 && list.hostItem === list.rows && list.m && list.m.rowW < list.m.contW) {
      ok(`列表视图同样紧凑条:${list.hostItem} 行 host-item,宽度 ${list.m.rowW}px < 容器 ${list.m.contW}px`);
    } else bad('列表视图异常: ' + JSON.stringify(list), null);

    // 网格视图:卡片不变
    await ev(c, `state.settings.sessionView='grid'; renderSessionList('');`);
    await sleep(500);
    const grid = JSON.parse(await ev(c, `JSON.stringify({ cards: document.querySelectorAll('.session-card').length })`));
    if (grid.cards >= 3) ok(`网格视图不变:${grid.cards} 张卡片`);
    else bad('网格卡片异常: ' + JSON.stringify(grid), null);

    console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  } catch (e) {
    console.error('\n测试异常:', e && e.message);
    failed++;
    console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  }
  try { killTree(appProc); } catch { /* ignore */ }
  process.exit(failed ? 1 : 0);
})();
