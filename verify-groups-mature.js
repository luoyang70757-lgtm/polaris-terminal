'use strict';
/**
 * verify-groups-mature.js — 多变分组场景下,列表 / 树形两种视图的「成熟产品」体检
 *
 * 与 verify-group-views.js 的区别:
 *   那个只验证「父子两层的层级一致性」;这个造一棵接近真实环境的树
 *   (5 个顶级分组 / 5 层深链 / 同名不同父 / 空分组 / 多主机),然后对两种视图做全量验收:
 *
 *   ① 结构一致性:两种视图的展开顺序 = 数据模型 DFS 顺序(一条不多、一条不少、不重复);
 *   ② 层级缩进:深度每 +1 缩进 +18px,两种视图一致;5 层深链不横向溢出面板;
 *   ③ 树形折叠:折叠父组隐藏整棵子树(不只直属)、兄弟组不受影响、折叠状态跨渲染保持;
 *   ④ 列表模式:不折叠(全部展开)、层级仍用缩进表达、无折叠三角、切回树形折叠状态不被污染;
 *   ⑤ 空分组 / 同名不同父 / 分组计数;
 *   ⑥ 搜索联动:命中主机可见,并检查「空分组头是否被过滤掉」(成熟产品通常会隐藏);
 *   ⑦ 数据操作:拖拽移动进深层分组不丢字段、删父分组连带子分组与主机、默认分组不可删。
 *
 * 输出分两类:
 *   ✓ / ✗ 硬断言(不符合就是 bug)
 *   ⚠ 成熟度建议(能用,但对照 Xshell / FinalShell / MobaXterm / Termius 有差距)
 *
 * 运行:node verify-groups-mature.js            (默认不截图)
 *      SHOTS=1 node verify-groups-mature.js     (额外把两种视图截图存到 verify-shots/)
 */
const { spawn } = require('child_process');
const { freePort, killTree, guardTimeout, evaluate } = require('./test-helper');
const fs = require('fs'); const os = require('os'); const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-groups-mature-'));
const SHOT_DIR = path.join(__dirname, 'verify-shots');
const PORT = 9432, SSH = 2262, HTTP = 2362;
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
      const r = await fetch(`http://127.0.0.1:${PORT}/json`, { signal: AbortSignal.timeout(3000) });
      const j = await r.json();
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
async function ev(c, expr) { return evaluate(c, expr); }

let passed = 0, failed = 0; const notes = [];
const ok = (n) => { passed++; console.log('  ✓ ' + n); };
const bad = (n, e) => { failed++; console.error('  ✗ ' + n + (e ? ' → ' + e : '')); };
const note = (n) => { notes.push(n); console.log('  ⚠ ' + n); };
const head = (t) => console.log(`\n— ${t} —`);

(async () => {
  console.log('\n=== 分组:列表 / 树形 成熟度体检 ===');
  try {
    const lockT = (await targets()).find((t) => /解锁/.test(t.title || ''));
    const lock = await connect(lockT.webSocketDebuggerUrl);
    for (let i = 0; i < 40; i++) { if (await ev(lock, `!!document.getElementById('pw')`)) break; await sleep(300); }
    await sleep(300);
    await ev(lock, `document.getElementById('pw').value='x1234567'; document.getElementById('pw2').value='x1234567'; document.getElementById('btn').click();`);
    let c = null;
    for (let i = 0; i < 40; i++) {
      await sleep(400);
      const t2 = await targets();
      const m = t2.find((t) => t.type === 'page' && !/解锁/.test(t.title || ''));
      if (m) { c = await connect(m.webSocketDebuggerUrl); break; }
    }
    if (!c) throw new Error('解锁后主窗口未出现');
    for (let i = 0; i < 50; i++) { if (await ev(c, `typeof state === 'object' && !!state.settings`)) break; await sleep(200); }

    // ---------------------------------------------------------------
    // 0. 造分组:5 个顶级 + 5 层深链 + 同名不同父 + 空分组 + 11 台主机
    // ---------------------------------------------------------------
    const S = JSON.stringify(SSH);
    const G = await ev(c, `(async () => {
      const S = ${S};
      const mk = async (name, pid) => { const r = await window.api.createGroup(name, pid == null ? null : pid); if (!r.ok) throw new Error(r.error); return r.id; };
      const host = (name, gid, extra) => window.api.createSession(Object.assign({ name, host: '127.0.0.1', port: S, username: 'admin', password: 'admin123', groupId: gid }, extra || {}));
      // 生产环境 → 华东 → {数据库, Web};生产环境 → 华北
      const prod = await mk('生产环境', null);
      const east = await mk('华东', prod);
      const db = await mk('数据库', east);
      const web = await mk('Web', east);
      const north = await mk('华北', prod);
      // 测试环境 → 数据库(与生产环境/华东/数据库 同名,不同父级)
      const test = await mk('测试环境', null);
      const testDb = await mk('数据库', test);
      // 空分组
      const cloud = await mk('云上资源', null);
      // 5 层深链:L1 → L2 → L3 → L4 → L5,主机挂在最深一层
      let prev = null, deep = [];
      for (let i = 1; i <= 5; i++) { prev = await mk('深链 L' + i, prev); deep.push(prev); }
      // 主机
      await host('prod-gw-01', prod);
      await host('east-db-01', db); await host('east-db-02', db);
      await host('east-web-01', web);
      await host('north-cache-01', north);
      await host('test-db-01', testDb); await host('test-db-02', testDb);
      await host('deep-leaf-01', deep[4], { encoding: 'gbk', protocol: 'ssh', tagColor: 'red', privateKey: '/tmp/k', passphrase: 'kp', onConnect: 'echo hi',
        jump: { host: '127.0.0.1', port: 2222, username: 'jump', password: 'jp' } });
      await loadSessions();
      return { prod, east, db, web, north, test, testDb, cloud, deep };
    })()`);
    const all = await ev(c, `({ groups: state.groups.length, sessions: state.sessions.length,
      names: state.groups.map((g) => (g.parent_id ? '  ' : '') + g.name) })`);
    console.log(`\n  数据:${all.groups} 个分组 / ${all.sessions} 台主机`);
    console.log('  ' + all.names.join(' | '));

    // ---------------------------------------------------------------
    // 快照器:把 .top-group-container 摊平成 [{kind,name,pad,depth,gid,count,caret}]
    // ---------------------------------------------------------------
    const snapFn = `(function(view, filter){
      state.settings.sessionView = view;
      state.collapsedTopHost = false;
      renderSessionList(filter || '');
      var box = document.querySelector('.top-group-container');
      var out = [];
      if (!box) return { items: [], width: 0, scrollW: 0 };
      for (var i = 0; i < box.children.length; i++) {
        var el = box.children[i];
        var pad = parseInt(el.style.paddingLeft, 10) || 0;
        if (el.classList.contains('asset-group-head')) {
          var caretEl = el.querySelector('.asset-group-caret');
          out.push({ kind: 'group',
            name: (el.querySelector('.asset-group-name') || {}).textContent || el.textContent,
            count: (el.querySelector('.asset-group-count') || {}).textContent || '',
            caret: caretEl ? caretEl.textContent : '', caretHidden: !!(caretEl && caretEl.style.visibility === 'hidden'),
            pad: pad, depth: (el.dataset.depth != null ? Number(el.dataset.depth) : Math.round((pad - 8) / 18)), gid: el.dataset.groupId ? Number(el.dataset.groupId) : null,
            listHead: el.classList.contains('list-head'), tab: el.hasAttribute('tabindex'), draggable: !!el.draggable, titled: !!el.title });
        } else if (el.classList.contains('asset-item')) {
          var nm = el.querySelector('.name');
          out.push({ kind: 'host', name: nm ? nm.textContent : '',
            nameW: nm ? nm.offsetWidth : 0, pad: pad,
            depth: (el.dataset.depth != null ? Number(el.dataset.depth) : Math.round((pad - 24) / 18)),
            focused: el === document.activeElement, sid: el.dataset.sessionId ? Number(el.dataset.sessionId) : null });
        }
      }
      var tree = document.getElementById('session-tree');
      return { items: out, width: tree ? tree.clientWidth : 0, scrollW: tree ? tree.scrollWidth : 0,
        focusedKey: (function () {
          var a = document.activeElement;
          if (!a || !a.dataset) return null;
          if (a.dataset.groupId) return 'g:' + a.dataset.groupId;
          if (a.dataset.sessionId) return 's:' + a.dataset.sessionId;
          return null;
        })() };
    })`;

    // 数据模型 DFS(顺序取自 state.groups / state.sessions,即库里的排序)
    const expectFn = `(function(){
      var ids = {}; state.groups.forEach(function (g) { ids[Number(g.id)] = 1; });
      var kids = {}, by = {};
      state.groups.forEach(function (g) {
        var pid = g.parent_id != null && ids[Number(g.parent_id)] ? Number(g.parent_id) : null;
        (kids[pid] = kids[pid] || []).push(g);
      });
      state.sessions.forEach(function (s) { var gid = Number(s.group_id); (by[gid] = by[gid] || []).push(s); });
      var out = [];
      var rec = function (g, d) {
        out.push({ kind: 'group', name: g.name, gid: Number(g.id), depth: d });
        (kids[Number(g.id)] || []).forEach(function (ch) { rec(ch, d + 1); });
        (by[Number(g.id)] || []).forEach(function (s) { out.push({ kind: 'host', name: s.name, depth: d }); });
      };
      (kids[null] || []).forEach(function (g) { rec(g, 0); });
      return out;
    })`;

    const snap = async (view, filter) => ev(c, `(${snapFn})(${JSON.stringify(view)}, ${JSON.stringify(filter || '')})`);
    const expected = await ev(c, `(${expectFn})()`);

    // ---------------------------------------------------------------
    // ① 结构一致性:两种视图 = 数据模型 DFS
    // ---------------------------------------------------------------
    head('① 两种视图的结构是否 = 数据模型(展开全部)');
    await ev(c, `state.collapsedGroups.clear()`);
    const tree = await snap('tree');
    const list = await snap('list');
    const seq = (arr) => arr.map((x) => x.kind[0] + ':' + x.name);
    const expSeq = seq(expected);
    for (const [label, s] of [['树形', tree], ['列表', list]]) {
      const got = seq(s.items);
      if (got.join() === expSeq.join()) ok(`${label}模式顺序与数据模型完全一致(${got.length} 行)`);
      else {
        const diff = got.findIndex((x, i) => x !== expSeq[i]);
        bad(`${label}模式顺序偏离数据模型`, `首个差异 @${diff}: 期望 ${expSeq[diff]} 实际 ${got[diff]}\n      期望=${expSeq.join(' ')}\n      实际=${got.join(' ')}`);
      }
      const names = s.items.filter((x) => x.kind === 'host').map((x) => x.name);
      const dup = names.filter((n, i) => names.indexOf(n) !== i);
      if (!dup.length) ok(`${label}模式无重复主机行`);
      else bad(`${label}模式主机行重复`, JSON.stringify(dup));
    }
    if (seq(tree.items).join() === seq(list.items).join()) ok('列表与树形两种视图目录结构完全一致');
    else bad('列表与树形结构不一致', `\n      树形=${seq(tree.items).join(' ')}\n      列表=${seq(list.items).join(' ')}`);

    // ---------------------------------------------------------------
    // ② 缩进 / 层级 / 横向溢出
    // ---------------------------------------------------------------
    head('② 层级缩进(5 层深链)');
    for (const [label, s] of [['树形', tree], ['列表', list]]) {
      const bads = [];
      // 缩进规则:前 3 层每层 18px,第 4 层起每层 10px(深层不再把主机名挤没)
      const wantPad = (kind, depth) => (kind === 'group' ? 8 : 24) + Math.min(depth, 3) * 18 + Math.max(0, depth - 3) * 10;
      for (const it of s.items) if (it.pad !== wantPad(it.kind, it.depth) || it.depth < 0) bads.push(it);
      if (!bads.length) ok(`${label}模式缩进深度与层级严格对应(${s.items.length} 行)`);
      else bad(`${label}模式缩进/深度不匹配`, JSON.stringify(bads.slice(0, 3)));
      // 深链 5 层:前 3 层 +18,第 4 层起收为 +10
      const chain = s.items.filter((x) => x.kind === 'group' && /^深链 L/.test(x.name));
      const pads = chain.map((x) => x.pad);
      const steps = pads.slice(1).map((p, i) => p - pads[i]);
      if (chain.length === 5 && steps.join() === '18,18,18,10') ok(`${label}模式 5 层深链:前 3 层 +18px、第 4 层起 +10px(${pads.join(' → ')})`);
      else bad(`${label}模式深链缩进异常`, JSON.stringify({ pads, steps }));
      const leaf = s.items.find((x) => x.kind === 'host' && x.name === 'deep-leaf-01');
      const root = s.items.find((x) => x.kind === 'host' && x.name === 'prod-gw-01');
      if (leaf && root && leaf.depth === 4 && root.depth === 0) ok(`${label}模式最深层主机 depth=4、顶级主机 depth=0`);
      else bad(`${label}模式主机深度异常`, JSON.stringify({ leaf, root }));
      if (leaf && leaf.nameW > 30) ok(`${label}模式 5 层缩进后主机名仍可读(width=${leaf.nameW}px,面板 ${s.width}px)`);
      else note(`${label}模式 5 层缩进后主机名被压缩到 ${leaf && leaf.nameW}px(面板 ${s.width}px)——建议深度超过 N 层后限制缩进步长`);
      if (s.scrollW <= s.width + 2) ok(`${label}模式无横向溢出(scrollW=${s.scrollW} ≤ ${s.width})`);
      else bad(`${label}模式横向溢出`, `scrollW=${s.scrollW} > ${s.width}`);
    }
    // 窄侧边栏(260px)下 5 层深链是否还能读
    const narrow = await ev(c, `(function(){
      state.settings.sessionView = 'tree'; state.collapsedTopHost = false; state.collapsedGroups.clear();
      var t = document.getElementById('session-tree');
      var old = t.style.width;
      t.style.width = '260px'; renderSessionList('');
      var host = null, hs = document.querySelectorAll('.top-group-container .asset-item.host-item');
      for (var i = 0; i < hs.length; i++) { if ((hs[i].querySelector('.name') || {}).textContent === 'deep-leaf-01') host = hs[i]; }
      var nm = host && host.querySelector('.name');
      var res = { w: t.clientWidth, scrollW: t.scrollWidth, nameW: nm ? nm.offsetWidth : null, pad: host ? host.style.paddingLeft : null,
        truncated: !!(nm && nm.scrollWidth > nm.clientWidth + 1), text: nm ? nm.textContent : null };
      t.style.width = old; renderSessionList('');
      return res;
    })()`);
    if (narrow.w < 500) {
      if (!narrow.truncated) ok(`窄侧边栏 ${narrow.w}px 下 5 层深主机名完整可读(width=${narrow.nameW}px)`);
      else note(`窄侧边栏 ${narrow.w}px 下 5 层深主机名「${narrow.text}」被省略号截断(仅 ${narrow.nameW}px,缩进 ${narrow.pad})——行有 title 悬停可见完整名,可接受;若要更宽可继续收窄深层步长`);
    } else note('未能强制缩窄侧边栏,跳过窄宽深度检查');

    // 同名不同父:两个「数据库」缩进不同,均可辨认
    const dbHeads = tree.items.filter((x) => x.kind === 'group' && x.name === '数据库');
    if (dbHeads.length === 2 && dbHeads[0].pad !== dbHeads[1].pad) ok(`同名分组靠缩进区分(${dbHeads.map((x) => x.pad + 'px').join(' vs ')})`);
    else bad('同名分组无法区分', JSON.stringify(dbHeads));

    // ---------------------------------------------------------------
    // ③ 树形折叠
    // ---------------------------------------------------------------
    head('③ 树形:折叠后子树是否整体隐藏');
    const countIn = async () => (await snap('tree')).items;
    // 折叠父组「华东」(它自己 0 台主机,3 台在子组里)→ 子树整体消失
    // 注意:必须先切回树形再点(上一节把视图留在 list,列表模式的分组头没有折叠三角)
    const clickCaret = (name) => ev(c, `(function(){
      state.settings.sessionView = 'tree';
      state.collapsedTopHost = false;
      renderSessionList('');
      var hs = document.querySelectorAll('.top-group-container .asset-group-head');
      for (var i = 0; i < hs.length; i++) {
        var nm = hs[i].querySelector('.asset-group-name');
        if (nm && nm.textContent === ${JSON.stringify(name)}) { hs[i].querySelector('.asset-group-caret').click(); return true; }
      }
      throw new Error('找不到分组 ${name}');
    })()`);
    await ev(c, `state.settings.sessionView = 'tree'; state.collapsedGroups.clear()`);
    await clickCaret('华东');
    let after = await countIn();
    const has = (arr, n) => arr.some((x) => x.kind === 'group' && x.name === n);
    const hasGid = (arr, gid) => arr.some((x) => x.kind === 'group' && x.gid === Number(gid));
    const hasHost = (arr, n) => arr.some((x) => x.kind === 'host' && x.name === n);
    if (has(after, '华东') && !hasGid(after, G.db) && !hasGid(after, G.web)) ok('折叠「华东」→ 子分组「数据库 / Web」一起隐藏');
    else bad('折叠父组时子分组未隐藏', JSON.stringify(after.filter((x) => x.kind === 'group').map((x) => x.name + '#' + x.gid)));
    if (!hasHost(after, 'east-db-01') && !hasHost(after, 'east-web-01')) ok('折叠「华东」→ 子孙主机全部隐藏(不只直属)');
    else bad('折叠后仍显示子孙主机');
    if (has(after, '华北') && hasHost(after, 'north-cache-01') && hasHost(after, 'prod-gw-01')) ok('兄弟分组「华北」与父组直属主机不受影响');
    else bad('折叠影响了兄弟分组/直属主机', JSON.stringify(after.map((x) => x.name)));
    const eastHead = after.find((x) => x.kind === 'group' && x.name === '华东');
    if (eastHead && eastHead.caret === '▶') ok('折叠后折叠三角为 ▶');
    else bad('折叠三角未反映折叠状态', JSON.stringify(eastHead));
    if (has(after, '测试环境') && has(after, '云上资源') && has(after, '深链 L1')) ok('其他顶级分组仍完整显示');
    else bad('其他顶级分组被牵连', JSON.stringify(after.map((x) => x.name)));

    // 折叠状态跨视图切换保持
    await snap('list');
    const back = await snap('tree');
    if (back.items.find((x) => x.kind === 'group' && x.name === '华东').caret === '▶' && !hasGid(back.items, G.db)) ok('切到列表再切回树形,折叠状态保持');
    else bad('视图切换丢失折叠状态', JSON.stringify(back.items.filter((x) => x.kind === 'group').map((x) => x.name + x.caret)));

    // 折叠状态跨数据刷新保持(loadSessions 会整体重建列表)
    const kept = await ev(c, `(async () => {
      const before = [...state.collapsedGroups].map(Number).includes(${G.east});
      await loadSessions();
      state.collapsedTopHost = false; state.settings.sessionView = 'tree'; renderSessionList('');
      const head = [...document.querySelectorAll('.top-group-container .asset-group-head')]
        .find((el) => (el.querySelector('.asset-group-name') || {}).textContent === '华东');
      return { before, after: head ? head.querySelector('.asset-group-caret').textContent : null };
    })()`);
    if (kept.before && kept.after === '▶') ok('折叠状态在数据刷新(loadSessions)后保持');
    else bad('数据刷新丢失折叠状态', JSON.stringify(kept));

    // 展开还原
    await ev(c, `state.collapsedGroups.delete(Number(${G.east})); state.settings.sessionView='tree'; renderSessionList('')`);
    after = await countIn();
    if (has(after, '数据库') && hasHost(after, 'east-db-01') && after.find((x) => x.kind === 'group' && x.name === '华东').caret === '▼') ok('再次点开「华东」→ 子树完整还原(▶ → ▼)');
    else bad('展开还原失败', JSON.stringify(after.map((x) => x.name + (x.caret || ''))));

    // ---------------------------------------------------------------
    // ④ 列表模式(现在也能折叠)
    // ---------------------------------------------------------------
    head('④ 列表:可折叠,且与树形共享折叠状态');
    await ev(c, `state.collapsedGroups.clear(); state.collapsedGroups.add(Number(${G.prod})); state.collapsedGroups.add(Number(${G.deep[0]}))`);
    const listCollapsed = await snap('list');
    if (!hasHost(listCollapsed.items, 'east-db-01') && !hasGid(listCollapsed.items, G.db)
      && !hasGid(listCollapsed.items, G.deep[4]) && !hasHost(listCollapsed.items, 'deep-leaf-01')) {
      ok('列表模式同样遵守折叠状态:「生产环境 / 深链 L1」的子项全部隐藏');
    } else bad('列表模式没折叠', JSON.stringify(listCollapsed.items.map((x) => x.name)));
    const lc = listCollapsed.items.filter((x) => x.kind === 'group');
    if (lc.every((x) => x.listHead && !x.caretHidden && /[▶▼]/.test(x.caret))) ok('列表模式分组头有可点击的折叠三角(▶/▼)');
    else bad('列表模式分组头没三角', JSON.stringify(lc.filter((x) => x.caretHidden || !x.caret).map((x) => x.name)));
    if ((lc.find((x) => x.name === '生产环境') || {}).caret === '▶') ok('折叠的组在列表模式显示 ▶');
    else bad('列表模式折叠三角状态不对', JSON.stringify(lc.map((x) => x.name + x.caret)));
    // 两种视图的折叠状态一致:切回树形仍是同一批组折叠
    const shared = await snap('tree');
    const foldedBoth = ['生产环境', '深链 L1'].every((n) => (shared.items.find((x) => x.kind === 'group' && x.name === n) || {}).caret === '▶');
    if (foldedBoth && !hasHost(shared.items, 'east-db-01')) ok('列表/树形共用同一套折叠状态(切视图不丢)');
    else bad('两视图折叠状态不同步', JSON.stringify(shared.items.filter((x) => x.kind === 'group').map((x) => x.name + x.caret)));
    // 列表模式点三角真能折叠/展开
    const listToggle = await ev(c, `(async () => {
      state.settings.sessionView = 'list'; state.collapsedTopHost = false; state.collapsedGroups.clear(); renderSessionList('');
      var headOf = function (name) {
        return [].filter.call(document.querySelectorAll('.top-group-container .asset-group-head.list-head'),
          function (el) { return (el.querySelector('.asset-group-name') || {}).textContent === name; })[0];
      };
      var h = headOf('生产环境');
      if (!h) return { err: 'no head' };
      var before = !!document.querySelector('#session-tree [data-session-id="' + (state.sessions.find(function (s) { return s.name === 'prod-gw-01'; }) || {}).id + '"]');
      h.querySelector('.asset-group-caret').click();           // 折叠
      var afterCollapse = !!document.querySelector('#session-tree [data-session-id="' + (state.sessions.find(function (s) { return s.name === 'prod-gw-01'; }) || {}).id + '"]');
      var caret1 = (headOf('生产环境').querySelector('.asset-group-caret') || {}).textContent;
      headOf('生产环境').querySelector('.asset-group-caret').click(); // 展开
      var afterExpand = !!document.querySelector('#session-tree [data-session-id="' + (state.sessions.find(function (s) { return s.name === 'prod-gw-01'; }) || {}).id + '"]');
      var caret2 = (headOf('生产环境').querySelector('.asset-group-caret') || {}).textContent;
      return { before: before, afterCollapse: afterCollapse, caret1: caret1, afterExpand: afterExpand, caret2: caret2,
        persisted: (state.settings.collapsedGroupIds || []).map(Number) };
    })()`);
    if (listToggle.before && !listToggle.afterCollapse && listToggle.caret1 === '▶') ok('列表模式下点三角 → 子项收起(▶)');
    else bad('列表模式点三角不能折叠', JSON.stringify(listToggle));
    if (listToggle.afterExpand && listToggle.caret2 === '▼') ok('列表模式下再点 → 展开还原(▼)');
    else bad('列表模式不能展开', JSON.stringify(listToggle));
    await ev(c, `state.collapsedGroups.clear()`);
    const lc2 = (await snap('list')).items;
    // 列表模式分组头右键菜单(真实派发 contextmenu,检查 6 个管理项)
    const listMenu = await ev(c, `(function(){
      state.settings.sessionView = 'list'; state.collapsedTopHost = false; state.collapsedGroups.clear(); renderSessionList('');
      var head = null, hs = document.querySelectorAll('.top-group-container .asset-group-head.list-head');
      for (var i = 0; i < hs.length; i++) { if ((hs[i].querySelector('.asset-group-name') || {}).textContent === '深链 L5') { head = hs[i]; break; } }
      if (!head) return { err: 'no head' };
      head.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 200, clientY: 300 }));
      var menu = document.getElementById('ctx-menu');
      var items = [].map.call(menu.querySelectorAll('.ctx-item'), function (x) { return x.textContent; });
      var open = !menu.classList.contains('hidden');
      closeCtxMenu('test');
      return { open: open, items: items };
    })()`);
    const wantMenu = ['创建主机会话', '重命名分组', '新建子分组', '导出此分组', '删除分组'];
    if (listMenu.open && wantMenu.every((w) => (listMenu.items || []).some((it) => it.includes(w)))) ok(`列表模式分组头右键可用(${listMenu.items.length} 项:${listMenu.items.join(' / ')})`);
    else bad('列表模式分组头右键菜单缺失', JSON.stringify(listMenu));
    // 列表模式分组头可接收拖拽(真实 DragEvent 投放)
    const listDrop = await ev(c, `(async () => {
      state.settings.sessionView = 'list'; state.collapsedTopHost = false; state.collapsedGroups.clear(); renderSessionList('');
      var tgt = await window.api.createGroup('拖拽目标', null);
      if (!tgt.ok) return { err: tgt.error };
      await loadSessions();
      state.collapsedTopHost = false; state.settings.sessionView = 'list'; renderSessionList('');
      var head = null, hs = document.querySelectorAll('.top-group-container .asset-group-head.list-head');
      for (var i = 0; i < hs.length; i++) { if ((hs[i].querySelector('.asset-group-name') || {}).textContent === '拖拽目标') { head = hs[i]; break; } }
      if (!head) return { err: 'no head' };
      var s = state.sessions.find(function (x) { return x.name === 'test-db-01'; });
      var dt = new DataTransfer(); dt.setData('text/plain', String(s.id));
      head.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
      var over = head.classList.contains('drag-over');
      head.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
      await new Promise(function (r) { setTimeout(r, 500); });
      var m = state.sessions.find(function (x) { return Number(x.id) === Number(s.id); });
      return { over: over, gid: Number(m.group_id), want: Number(tgt.id), moved: !!m };
    })()`);
    if (listDrop.moved && listDrop.gid === listDrop.want) ok(`列表模式分组头可直接接收拖拽(drag-over 高亮=${listDrop.over})`);
    else bad('列表模式拖拽投放失败', JSON.stringify(listDrop));
    const listDupDepth = lc2.filter((x) => x.kind === 'group' && /^深链/.test(x.name)).map((x) => x.pad);
    if (new Set(listDupDepth).size === 5) ok(`列表模式 5 层分组缩进各不相同(${listDupDepth.join(' / ')})`);
    else bad('列表模式缩进无法区分层级', JSON.stringify(listDupDepth));

    // ---------------------------------------------------------------
    // ⑤ 计数 / 空分组
    // ---------------------------------------------------------------
    head('⑤ 分组计数 / 空分组');
    await ev(c, `state.collapsedGroups.clear()`);
    const fresh = (await snap('tree')).items.filter((x) => x.kind === 'group');
    const cnt = (n, i) => (fresh.filter((x) => x.name === n)[i || 0] || {}).count;
    if (cnt('生产环境') === '(1/5)' && cnt('华东') === '(0/3)' && cnt('数据库', 1) === '(2)') ok(`父分组显示「直属/合计」:生产环境 ${cnt('生产环境')} / 华东 ${cnt('华东')} / 数据库(华东) ${cnt('数据库', 1)}`);
    else bad('分组计数格式不对', JSON.stringify(fresh.map((x) => x.name + x.count)));
    const eastCount = cnt('华东');
    if (eastCount.includes('/')) ok(`父分组不再误报空:「华东」显示 ${eastCount}(直属 0 台、含子分组 3 台)`);
    else note(`父分组计数只算直属主机:「华东」显示 ${eastCount}`);
    if (fresh.find((x) => x.name === '云上资源') && fresh.find((x) => x.name === '云上资源').count === '(0)') ok('空分组在树形模式可见并显示 (0)');
    else bad('空分组不显示');
    if (listCollapsed.items.some((x) => x.kind === 'group' && x.name === '云上资源')) ok('空分组在列表模式可见');
    else bad('列表模式空分组不显示');
    // 空分组可投放(拖进去不报错)
    const emptyDrop = await ev(c, `(async () => {
      const s = state.sessions.find((x) => x.name === 'north-cache-01');
      await moveSessionToGroup(s.id, ${G.cloud});
      await loadSessions();
      const m = state.sessions.find((x) => Number(x.id) === Number(s.id));
      return { gid: Number(m.group_id), ok: Number(m.group_id) === Number(${G.cloud}) };
    })()`);
    if (emptyDrop.ok) ok('可把主机拖进空分组');
    else bad('拖入空分组失败', JSON.stringify(emptyDrop));

    // ---------------------------------------------------------------
    // ⑥ 搜索联动
    // ---------------------------------------------------------------
    head('⑥ 搜索:命中主机与空分组头');
    const searched = await snap('tree', 'east-db-01');
    if (hasHost(searched.items, 'east-db-01')) ok('搜索命中主机可见');
    else bad('搜索结果里找不到命中主机', JSON.stringify(searched.items.map((x) => x.name)));
    if (!hasHost(searched.items, 'east-db-02')) ok('未命中的同组主机被过滤');
    else bad('未命中主机仍显示');
    // 每个分组头下真正显示了几个命中主机(DFS 展开序列里,到下一个同级/更浅分组头为止)
    const perGroup = [];
    for (let i = 0; i < searched.items.length; i++) {
      const it = searched.items[i];
      if (it.kind !== 'group') continue;
      let n = 0;
      for (let j = i + 1; j < searched.items.length; j++) {
        const x = searched.items[j];
        if (x.kind === 'group' && x.depth <= it.depth) break;
        if (x.kind === 'host') n++;
      }
      perGroup.push({ name: it.name, depth: it.depth, matched: n, count: it.count });
    }
    const emptyHeads = perGroup.filter((g) => g.matched === 0);
    if (emptyHeads.length === 0) ok(`搜索时只保留命中路径(${perGroup.length} 个分组头:${perGroup.map((g) => g.name).join(' / ')})`);
    else note(`搜索「east-db-01」时仍渲染了 ${perGroup.length} 个分组头,其中 ${emptyHeads.length} 个无命中后代(${emptyHeads.slice(0, 4).map((g) => g.name).join('、')}…)——成熟产品搜索时只显示命中路径`);
    if (has(searched.items, '生产环境') && has(searched.items, '华东') && has(searched.items, '数据库') && !has(searched.items, '华北')) ok('命中路径的祖先分组完整保留、兄弟分组正确隐藏');
    else bad('搜索剪枝把命中路径也剪了', JSON.stringify(searched.items.filter((x) => x.kind === 'group').map((x) => x.name + x.depth)));
    const staleCount = perGroup.find((g) => g.name === '华东');
    if (staleCount && staleCount.count === '(0/3)') ok(`搜索时分组计数保持全量口径(不跟随过滤):「华东」仍为 ${staleCount.count}`);
    else bad('搜索时分组计数被改了', JSON.stringify(staleCount));
    // 搜索时忽略折叠:命中路径自动展开(否则命中的主机藏在折叠分组里,搜了等于没搜)
    const searchFold = await ev(c, `(async () => {
      state.settings.sessionView = 'tree'; state.collapsedTopHost = false;
      state.collapsedGroups.clear(); state.collapsedGroups.add(${G.east});
      renderSessionList('');
      const hidden = [...document.querySelectorAll('.top-group-container .asset-item .name')].map((x) => x.textContent);
      renderSessionList('east-db-01');
      const shown = [...document.querySelectorAll('.top-group-container .asset-item .name')].map((x) => x.textContent);
      renderSessionList('');
      const back = [...document.querySelectorAll('.top-group-container .asset-item .name')].map((x) => x.textContent);
      return { hidden: hidden.includes('east-db-01'), shown: shown.includes('east-db-01'), back: back.includes('east-db-01'),
        collapsedAfter: [...state.collapsedGroups].map(Number).includes(${G.east}) };
    })()`);
    if (!searchFold.hidden && searchFold.shown) ok('折叠的分组里有命中时,搜索自动展开命中路径');
    else bad('搜索不展开折叠分组(命中主机被藏起来)', JSON.stringify(searchFold));
    if (!searchFold.back && searchFold.collapsedAfter) ok('清空搜索后分组回到折叠状态(搜索不污染折叠态)');
    else bad('搜索改掉了折叠状态', JSON.stringify(searchFold));

    // ---------------------------------------------------------------
    // ⑦ 数据操作
    // ---------------------------------------------------------------
    head('⑦ 移动 / 删除语义');
    const moved = await ev(c, `(async () => {
      const s = state.sessions.find((x) => x.name === 'deep-leaf-01');
      await moveSessionToGroup(s.id, ${G.db});
      await loadSessions();
      state.collapsedGroups.clear(); // 上一节搜索留下的折叠态会藏掉新位置的主机
      const m = state.sessions.find((x) => Number(x.id) === Number(s.id));
      return { gid: Number(m.group_id), encoding: m.encoding, tag: m.tag_color, key: m.private_key, pp: m.passphrase,
        onConnect: m.on_connect, jumpHost: m.jump && m.jump.host, jumpPw: m.jump && m.jump.password };
    })()`);
    const movedOk = moved.gid === Number(G.db) && moved.encoding === 'gbk' && moved.tag === 'red' && moved.key === '/tmp/k'
      && moved.pp === 'kp' && moved.onConnect === 'echo hi' && moved.jumpHost === '127.0.0.1' && moved.jumpPw === 'jp';
    if (movedOk) ok('从 5 层深处拖到另一分支:字段(私钥/口令/编码/标签/登录宏/跳板机)全保留');
    else bad('跨层移动丢字段', JSON.stringify(moved));
    const reDeep = await snap('tree');
    const leafNow = reDeep.items.find((x) => x.kind === 'host' && x.name === 'deep-leaf-01');
    if (leafNow && leafNow.depth === 2) ok('移动后主机缩进跟随新分组(depth 4 → 2)');
    else bad('移动后缩进未更新', JSON.stringify(leafNow));

    const del = await ev(c, `(async () => {
      const p = await window.api.createGroup('待删父组', null);
      const ch = await window.api.createGroup('待删子组', p.id);
      await window.api.createSession({ name: '待删主机A', host: '127.0.0.1', port: ${S}, username: 'a', groupId: p.id });
      await window.api.createSession({ name: '待删主机B', host: '127.0.0.1', port: ${S}, username: 'b', groupId: ch.id });
      await loadSessions();
      const r = await window.api.deleteGroup(p.id);
      const def = state.groups.find((g) => g.name === '默认分组' && g.parent_id == null);
      const defDel = await window.api.deleteGroup(def.id);
      await loadSessions();
      return { ok: r.ok, err: r.error || null,
        groupsLeft: state.groups.filter((g) => /待删/.test(g.name)).length,
        hostsLeft: state.sessions.filter((s) => /待删主机/.test(s.name)).length,
        defDelOk: defDel.ok, defDelErr: defDel.error || null,
        others: state.groups.length, sessions: state.sessions.length };
    })()`);
    if (del.ok && del.groupsLeft === 0 && del.hostsLeft === 0) ok('删父分组连带删掉 2 个子分组 + 2 台主机(库里不留孤儿)');
    else bad('删父分组残留数据', JSON.stringify(del));
    if (!del.defDelOk) ok(`「默认分组」受保护不可删(${del.defDelErr})`);
    else bad('默认分组被删掉了');

    // ---------------------------------------------------------------
    // ⑧ 成熟度体检(与 Xshell / FinalShell / MobaXterm / Termius 的交互差距)
    // ---------------------------------------------------------------
    head('⑧ 成熟度体检(交互差距)');
    const gap = await ev(c, `(function(){
      state.settings.sessionView = 'tree'; state.collapsedTopHost = false; state.collapsedGroups.clear(); renderSessionList('');
      var hs = document.querySelectorAll('.top-group-container .asset-group-head');
      var head = null;
      for (var i = 0; i < hs.length; i++) { if ((hs[i].querySelector('.asset-group-name') || {}).textContent === '华东') { head = hs[i]; break; } }
      var names = state.groups.map(function (g) { return g.name; });
      return {
        tab: head ? head.tabIndex : null,
        draggable: head ? !!head.draggable : null,
        title: head ? head.title : null,
        sortedByName: names.join('\u0001') === names.slice().sort().join('\u0001'),
        saved: Object.keys(state.settings || {}).filter(function (k) { return /group/i.test(k) && /collapse/i.test(k) && state.settings[k] != null; }),
      };
    })()`);
    if (gap.tab) ok('分组头已接入 roving tabindex(可以用键盘聚焦/导航)');
    else note(`分组头无 tabindex(gap.tab=${gap.tab})——纯鼠标操作,键盘用户/无障碍访问缺位`);
    if (gap.draggable) ok('分组头可拖拽排序');
    else note(`分组只能按名称排序(库里 ORDER BY name,分组头 draggable=${gap.draggable})——不支持拖拽调序/拖成子分组;主机拖到分组头的拖拽已有`);
    if (gap.title) ok(`分组头有悬停提示(${JSON.stringify(gap.title)})`);
    else note('分组头无悬停提示(无 title):深层同名分组(如两个「数据库」)只能靠缩进区分');
    if (gap.title && gap.title.includes('生产环境 / 华东') && gap.title.includes('直属 0 台')) ok('悬停提示含完整路径与直属/合计主机数');
    else bad('悬停提示未含路径或计数', JSON.stringify(gap.title));
    if (!gap.saved.length) ok('折叠状态只在内存(按产品要求:每次启动都回到"全部折叠")');
    else bad('折叠状态仍写进 settings,启动会恢复上次展开', JSON.stringify(gap.saved));
    if (gap.sortedByName) ok('分组顺序确定且可预测(按名称升序)');

    // ---------------------------------------------------------------
    // ⑨ 启动默认全部折叠(两种视图一致)
    // ---------------------------------------------------------------
    head('⑨ 打开 App 默认全部折叠');
    const boot = await ev(c, `(async () => {
      // 先制造"上次运行时都展开了"的状态(不重启,只改内存)
      state.settings.sessionView = 'tree';
      state.settings.collapsedGroupIds = null;
      state.collapsedGroups.clear();
      state.collapsedTopHost = false; state.collapsedTopBastion = false;
      renderSessionList('');
      const expandedRows = document.querySelectorAll('#session-tree .asset-item[data-session-id]').length;
      // 模拟重启:内存态清零 + 允许重新初始化 → loadSessions 应该把所有分组收起
      groupsCollapsedOnBoot = false;
      state.collapsedGroups.clear();
      await loadSessions();
      const collapsed = [...state.collapsedGroups].map(Number);
      const allFolded = state.groups.every((g) => collapsed.includes(Number(g.id)));
      const treeRows = document.querySelectorAll('#session-tree .asset-item[data-session-id]').length;
      const treeHeads = document.querySelectorAll('#session-tree .asset-group-head .asset-group-name').length;
      const treeCarets = [].map.call(document.querySelectorAll('#session-tree .top-group-container .asset-group-caret'), (x) => x.textContent).join('');
      const topHost = state.collapsedTopHost, topBastion = state.collapsedTopBastion;
      // 列表模式同样默认折叠
      state.settings.sessionView = 'list'; renderSessionList('');
      const listRows = document.querySelectorAll('#session-tree .asset-item[data-session-id]').length;
      const listCarets = [].map.call(document.querySelectorAll('#session-tree .top-group-container .asset-group-caret'), (x) => x.textContent).join('');
      // 手动展开一个分组后不应写盘(下次启动仍全折叠)
      var probe = state.groups.find((g) => g.name === '测试环境');
      state.collapsedGroups.delete(Number(probe.id));
      renderSessionList('');
      const wroteSettings = state.settings.collapsedGroupIds != null;
      state.settings.sessionView = 'tree'; state.collapsedGroups.clear();
      renderSessionList('');
      return { expandedRows, treeRows, treeHeads, treeCarets, listRows, listCarets, topHost, topBastion,
        groupCount: state.groups.length, collapsedCount: collapsed.length, allFolded, wroteSettings };
    })()`);
    if (boot.expandedRows > 0) ok(`前置:重启前确实有 ${boot.expandedRows} 行主机是展开的`);
    else bad('前置状态异常(没有展开的主机)', JSON.stringify(boot));
    if (boot.allFolded && boot.collapsedCount === boot.groupCount) ok(`重启后 ${boot.collapsedCount}/${boot.groupCount} 个分组全部折叠`);
    else bad('重启后仍有分组展开', JSON.stringify(boot));
    if (boot.treeRows === 0 && boot.treeHeads > 0) ok(`树形模式:只显示分组头(${boot.treeHeads} 行),主机行 0`);
    else bad('树形模式默认没折叠', JSON.stringify(boot));
    if (boot.listRows === 0) ok('列表模式:同样只显示分组头,主机行 0');
    else bad('列表模式默认没折叠', JSON.stringify({ listRows: boot.listRows }));
    if (/^▶*$/.test(boot.treeCarets) && /^▶*$/.test(boot.listCarets)) ok('两种视图的分组三角全部为 ▶');
    else bad('三角状态不对', JSON.stringify({ tree: boot.treeCarets, list: boot.listCarets }));
    if (boot.topHost === true && boot.topBastion === true) ok('顶级「🖥 主机 / 🛡 堡垒机」也默认收起');
    else bad('顶部分组未默认收起', JSON.stringify({ topHost: boot.topHost, topBastion: boot.topBastion }));
    if (!boot.wroteSettings) ok('展开/折叠不再写 settings(下次启动仍回到全折叠)');
    else bad('仍在持久化折叠状态', JSON.stringify(boot));

    // ---------------------------------------------------------------
    // ⑩ 键盘导航(↑↓←→ / Enter / Shift+F10)
    // ---------------------------------------------------------------
    head('⑩ 键盘导航');
    const kb = await ev(c, `(function () {
      state.settings.sessionView = 'tree'; state.collapsedTopHost = false;
      state.activeGroupId = null; // 先清空选中态,不然 Enter 会把已选中的组取消掉
      state.collapsedGroups.clear(); renderSessionList('');
      var rows = [].filter.call(document.querySelectorAll('#session-tree .asset-group-head, #session-tree .asset-item'),
        function (el) { return el.dataset.topGroup || el.dataset.groupId || el.dataset.sessionId; });
      var tabStops = rows.filter(function (el) { return el.tabIndex === 0; }).length;
      var focusable = rows.filter(function (el) { return el.tabIndex >= -1 && el.hasAttribute('tabindex'); }).length;
      // 定位到「华东」分组头,模拟键盘操作
      var east = null;
      for (var i = 0; i < rows.length; i++) { if (Number(rows[i].dataset.groupId) === ${G.east}) { east = rows[i]; break; } }
      if (!east) return { err: 'no east head' };
      var key = function (el, k, shift) {
        el.dispatchEvent(new KeyboardEvent('keydown', { key: k, shiftKey: !!shift, bubbles: true, cancelable: true }));
      };
      east.focus(); key(east, 'ArrowDown');
      var down = document.activeElement;
      var downAdvanced = down !== east && rows.indexOf(down) === rows.indexOf(east) + 1;
      key(document.activeElement, 'ArrowUp');
      var up = document.activeElement;
      // ← 折叠、→ 展开
      key(up, 'Escape'); // 无害按键,只验证不会误动作
      key(up, 'ArrowLeft');
      var collapsedHead = document.activeElement;
      var collapsedCaret = collapsedHead.querySelector('.asset-group-caret').textContent;
      var hiddenAfter = !document.querySelector('.top-group-container .asset-item[data-session-id="' +
        (state.sessions.find(function (s) { return s.name === 'east-web-01'; }) || {}).id + '"]');
      key(collapsedHead, 'ArrowRight'); // 展开
      var expandedCaret = document.activeElement.querySelector('.asset-group-caret').textContent;
      key(document.activeElement, 'ArrowRight'); // 展开后 → 入第一个子项(子分组)
      var child = document.activeElement;
      var childIsGroup = child.classList.contains('asset-group-head');
      var childKey = child.dataset.groupId;
      key(child, 'ArrowLeft'); // 子项是展开的分组 → 先折叠它(重渲染后元素会换新,按 key 比)
      var afterFirstLeft = document.activeElement;
      var childCollapsed = String(afterFirstLeft.dataset.groupId) === String(childKey)
        && afterFirstLeft.querySelector('.asset-group-caret').textContent === '▶';
      key(afterFirstLeft, 'ArrowLeft'); // 再 ← → 回到父分组
      var backTo = document.activeElement;
      // Enter 在分组头上 = 选中该组(activeGroupId)
      key(backTo, 'Enter');
      var activeGid = state.activeGroupId;
      // Shift+F10 = 右键菜单
      key(document.activeElement, 'F10', true);
      var menu = document.getElementById('ctx-menu');
      var menuOpen = !menu.classList.contains('hidden');
      var menuItems = [].map.call(menu.querySelectorAll('.ctx-item'), function (x) { return x.textContent; });
      closeCtxMenu('test');
      return { tabStops: tabStops, rows: rows.length, focusable: focusable,
        downAdvanced: downAdvanced, downDepth: Number(down.dataset.depth),
        upBack: up === east, collapsedCaret: collapsedCaret, hiddenAfter: hiddenAfter, expandedCaret: expandedCaret,
        childIsGroup: childIsGroup, childDepth: Number(child.dataset.depth), childCollapsed: childCollapsed,
        backToEast: Number(backTo.dataset.groupId) === ${G.east}, activeGid: activeGid ? Number(activeGid) : null,
        menuOpen: menuOpen, menuCount: menuItems.length };
    })()`);
    if (kb.tabStops === 1) ok(`会话列表全树只有一个 Tab 停靠点(${kb.rows} 行可导航、不逐个 Tab)`);
    else bad('roving tabindex 异常', JSON.stringify(kb));
    if (kb.focusable === kb.rows) ok('所有分组头 / 会话行均可获得键盘焦点');
    else bad('部分行无法聚焦', JSON.stringify({ focusable: kb.focusable, rows: kb.rows }));
    if (kb.downAdvanced) ok(`↓ 移到下一行(depth=${kb.downDepth})`);
    else bad('↓ 未移动', JSON.stringify(kb));
    if (kb.upBack) ok('↑ 回到上一行');
    else bad('↑ 未回位', JSON.stringify(kb));
    if (kb.collapsedCaret === '▶' && kb.hiddenAfter) ok('← 折叠该分组,子项隐藏且焦点留在分组头');
    else bad('← 未折叠或丢焦点', JSON.stringify(kb));
    if (kb.expandedCaret === '▼') ok('→ 展开该分组(焦点不丢)');
    else bad('→ 未展开', JSON.stringify(kb));
    if (kb.childIsGroup && kb.childDepth > 1) ok(`展开后再 → 进入第一个子项(depth=${kb.childDepth})`);
    else bad('→ 未进入子项', JSON.stringify(kb));
    if (kb.childCollapsed) ok('← 在展开的子分组上 = 先折叠它(同 Windows 资源管理器键盘语义)');
    else bad('← 未折叠子分组', JSON.stringify(kb));
    if (kb.backToEast) ok('再 ← 从子项回到父分组头');
    else bad('← 未回到父分组', JSON.stringify(kb));
    if (kb.activeGid === Number(G.east)) ok('Enter 在分组头上 = 选中该组(同鼠标点击)');
    else bad('Enter 未选中分组', JSON.stringify(kb));
    if (kb.menuOpen && kb.menuCount >= 5) ok(`Shift+F10 弹出分组右键菜单(${kb.menuCount} 项)`);
    else bad('Shift+F10 未弹菜单', JSON.stringify(kb));

    // 顶级分组头(🖥 主机 / 🛡 堡垒机)也要能纯键盘开合:否则全折叠时键盘用户根本进不了树
    const kbTop = await ev(c, `(function () {
      state.settings.sessionView = 'tree'; state.collapsedGroups.clear();
      state.collapsedTopHost = true; state.collapsedTopBastion = true; renderSessionList('');
      var rows = [].filter.call(document.querySelectorAll('#session-tree .asset-group-head, #session-tree .asset-item'),
        function (el) { return el.dataset.topGroup || el.dataset.groupId || el.dataset.sessionId; });
      var first = rows[0];
      var isHostHead = !!(first && first.dataset.topGroup === 'host');
      var tabStop = first ? first.tabIndex : -1;
      first.focus();
      first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      var expanded = state.collapsedTopHost === false;
      var focusTop = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.topGroup : null;
      first = document.activeElement;
      first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); // 再收回去
      return { isHostHead: isHostHead, tabStop: tabStop, expanded: expanded, focusTop: focusTop,
        collapsedAgain: state.collapsedTopHost === true };
    })()`);
    if (kbTop.isHostHead && kbTop.tabStop === 0) ok('Tab 进入会话列表时第一个停靠点是「🖥 主机」标题');
    else bad('顶级分组头不是首个 Tab 停靠点', JSON.stringify(kbTop));
    if (kbTop.expanded && kbTop.focusTop === 'host') ok('Enter 展开「🖥 主机」(焦点留在标题上)');
    else bad('Enter 未展开顶级分组', JSON.stringify(kbTop));
    if (kbTop.collapsedAgain) ok('再按 Enter 收回「🖥 主机」');
    else bad('顶级分组无法再次折叠', JSON.stringify(kbTop));

    // ---------------------------------------------------------------
    // ⑪ 规模压测:一次多建 12 根 × 4 层 = 48 个分组 + 48 台主机
    //    检验两种视图在大数据量下是否仍一致、可折叠、不卡顿
    // ---------------------------------------------------------------
    head('⑪ 规模压测(多分组 / 多主机)');
    const scale = await ev(c, `(async () => {
      const roots = [];
      for (let i = 0; i < 12; i++) {
        const r = await window.api.createGroup('压测根' + String(i).padStart(2, '0'), null);
        if (!r.ok) return { err: r.error };
        roots.push(r.id);
        let pid = r.id;
        for (let d = 1; d <= 3; d++) {
          const c2 = await window.api.createGroup('压测子' + i + '-' + d, pid);
          if (!c2.ok) return { err: c2.error };
          pid = c2.id;
        }
        for (let h = 0; h < 4; h++) {
          await window.api.createSession({ name: 'p' + i + 'h' + h, host: '10.9.' + i + '.' + h, port: 22, username: 'u', groupId: pid });
        }
      }
      await loadSessions();
      const groupTotal = state.groups.length, sessionTotal = state.sessions.length;
      state.collapsedTopHost = false; state.collapsedGroups.clear();
      const tk = performance.now();
      state.settings.sessionView = 'tree'; renderSessionList('');
      const treeMs = performance.now() - tk;
      const treeRows = document.querySelectorAll('.top-group-container > *').length;
      const tl = performance.now();
      state.settings.sessionView = 'list'; renderSessionList('');
      const listMs = performance.now() - tl;
      const listRows = document.querySelectorAll('.top-group-container > *').length;
      // 折叠全部后应只剩分组头行
      const tc = performance.now();
      for (const g of state.groups) state.collapsedGroups.add(Number(g.id));
      state.settings.sessionView = 'tree'; renderSessionList('');
      const collapseMs = performance.now() - tc;
      const collapsedRows = document.querySelectorAll('.top-group-container > *').length;
      const collapsedHosts = document.querySelectorAll('.top-group-container .asset-item').length;
      // 测完清场(截图保持代表性数据)
      for (const rid of roots) { try { await window.api.deleteGroup(rid); } catch { /* ignore */ } }
      await loadSessions();
      state.collapsedGroups.clear(); state.settings.sessionView = 'tree'; renderSessionList('');
      return { groupTotal, sessionTotal, treeRows, listRows, collapsedRows, collapsedHosts,
        treeMs: Math.round(treeMs), listMs: Math.round(listMs), collapseMs: Math.round(collapseMs),
        leftAfterCleanup: state.groups.length };
    })()`);
    if (!scale.err) {
      if (scale.treeRows === scale.listRows) ok(`${scale.groupTotal} 分组 + ${scale.sessionTotal} 主机:树形/列表行数一致(${scale.treeRows} 行)`);
      else bad('大数量下两视图行数不一致', JSON.stringify(scale));
      if (Math.max(scale.treeMs, scale.listMs) < 300) ok(`渲染耗时:树形 ${scale.treeMs}ms / 列表 ${scale.listMs}ms(< 300ms,无感知)`);
      else note(`渲染耗时偏高:树形 ${scale.treeMs}ms / 列表 ${scale.listMs}ms(分组过多时可考虑虚拟列表)`);
      if (scale.collapsedHosts === 0) ok(`全部折叠只需 ${scale.collapseMs}ms,主机行归零(${scale.collapsedRows} 行分组头)`);
      else bad('全部折叠后仍残留主机行', JSON.stringify(scale));
      if (scale.leftAfterCleanup === all.groups + 1) ok('压测数据全部清场(仅剩本轮之前的 15 个分组)');
      else note(`清场后分组数 ${scale.leftAfterCleanup}(预期 ${all.groups + 1})`);
    } else bad('压测数据创建失败', scale.err);

    // ---------------------------------------------------------------
    // ⑫ Enter 连接 + 标签「定位到会话列表」
    // ---------------------------------------------------------------
    head('⑫ Enter 连接 / 定位到会话列表');
    const loc = await ev(c, `(async () => {
      state.settings.verifyHostKey = false; state.settings.autoTrustHostKey = true;
      state.collapsedTopHost = false; state.collapsedGroups.clear(); state.settings.sessionView = 'tree'; renderSessionList('');
      var s = state.sessions.find(function (x) { return x.name === 'test-db-02'; });
      var row = document.querySelector('#session-tree [data-session-id="' + s.id + '"]');
      if (!row) return { err: 'row not found' };
      var before = document.querySelectorAll('#tab-bar > *').length;
      row.focus();
      row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      for (var i = 0; i < 60 && !findTabBySessionId(s.id); i++) await new Promise(function (r) { setTimeout(r, 200); });
      var tab = findTabBySessionId(s.id);
      var after = document.querySelectorAll('#tab-bar > *').length;
      // 把该会话分组 + 祖先全部折叠 → 再「定位到会话列表」,应该自动展开 + 闪烁
      // 注意:tab 的 key 是 sess-N(不是数据库 id),locateInSessionList 要传 tab.sessionId
      var recentBackup = state.recent;
      state.recent = []; // 「最近连接」区块也会渲染同一会话,临时关掉才能准确判断组内行是否隐藏
      var g = state.groups.find(function (x) { return Number(x.id) === Number(s.group_id); });
      state.collapsedGroups.add(Number(g.id));
      if (g.parent_id != null) state.collapsedGroups.add(Number(g.parent_id));
      renderSessionList('');
      var hidden = !document.querySelector('#session-tree [data-session-id="' + s.id + '"]');
      locateInSessionList(tab.sessionId);
      var again = document.querySelector('#session-tree [data-session-id="' + s.id + '"]');
      var res = { tabOpened: !!tab, tabsBefore: before, tabsAfter: after,
        hiddenWhileCollapsed: hidden, visibleAfterLocate: !!again,
        flash: !!(again && again.classList.contains('flash')),
        expanded: !state.collapsedGroups.has(Number(g.id)) };
      state.recent = recentBackup;
      var t = findTabBySessionId(s.id); if (t) closeTab(t.sessionId);
      state.collapsedGroups.clear(); renderSessionList('');
      return res;
    })()`);
    if (loc.tabOpened) ok(`键盘 Enter 在会话行上 = 双击连接(标签 ${loc.tabsBefore} → ${loc.tabsAfter})`);
    else bad('Enter 未连接', JSON.stringify(loc));
    if (loc.hiddenWhileCollapsed && loc.visibleAfterLocate && loc.expanded) ok('「定位到会话列表」会自动展开折叠中的分组');
    else bad('定位未展开分组或找不到行', JSON.stringify(loc));
    if (loc.flash) ok('定位后会话行闪烁提示(树形/列表模式也生效,不再只限网格卡片)');
    else bad('定位未闪烁', JSON.stringify(loc));

    // ---------------------------------------------------------------
    // ⑬ 分组拖拽调序 / 拖成子分组
    // ---------------------------------------------------------------
    head('⑬ 分组拖拽(调序 / 变子分组 / 防环)');
    const gdrag = await ev(c, `(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const headOf = (gid) => [].filter.call(document.querySelectorAll('#session-tree .asset-group-head'),
        function (el) { return Number(el.dataset.groupId) === Number(gid); })[0];
      const drag = (gid, targetGid, where) => {
        const dt = new DataTransfer();
        dt.setData('application/x-polaris-group', String(gid));
        const t = headOf(targetGid);
        if (!t) return { err: 'no target ' + targetGid };
        const r = t.getBoundingClientRect();
        const y = where === 'before' ? r.top + 2 : (where === 'after' ? r.bottom - 2 : r.top + r.height / 2);
        const opts = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 40, clientY: y };
        t.dispatchEvent(new DragEvent('dragover', opts));
        const cls = t.className;
        t.dispatchEvent(new DragEvent('drop', opts));
        t.dispatchEvent(new DragEvent('dragend', opts));
        return { cls: cls };
      };
      state.collapsedTopHost = false; state.collapsedGroups.clear(); state.settings.sessionView = 'tree'; renderSessionList('');
      const out = {};
      // ① 拖到「华东」中间 = 变成子分组(华北 是它的兄弟)
      out.inside = drag(${G.north}, ${G.east}, 'inside');
      await sleep(700);
      var north = state.groups.find(function (g) { return Number(g.id) === ${G.north}; });
      out.northParent = north ? (north.parent_id == null ? null : Number(north.parent_id)) : 'missing';
      // ② 根级调序:云上资源 拖到「生产环境」下方 = 插到它后面
      state.collapsedTopHost = false; renderSessionList('');
      out.after = drag(${G.cloud}, ${G.prod}, 'after');
      await sleep(700);
      var ids = state.groups.map(function (g) { return Number(g.id); });
      out.cloudAfterProd = ids.indexOf(${G.cloud}) === ids.indexOf(${G.prod}) + 1;
      out.sortOrders = state.groups.filter(function (g) { return g.sort_order > 0; }).length;
      // ③ 防环:把父分组「生产环境」拖进它的后代「华东」里 → 应被拒
      state.collapsedGroups.clear(); renderSessionList('');
      drag(${G.prod}, ${G.east}, 'inside');
      await sleep(600);
      var prod = state.groups.find(function (g) { return Number(g.id) === ${G.prod}; });
      out.prodStillRoot = prod ? prod.parent_id == null : 'missing';
      out.statusMsg = (document.getElementById('toolbar-status') || {}).textContent || '';
      // ④ 数据层也拒绝成环(绕过 UI 直调 IPC)
      var bad = await window.api.moveGroup(${G.prod}, ${G.east}, null);
      out.apiReject = { ok: bad.ok, error: bad.error || null };
      // ⑤ 顺序落库:重新读一次库,顺序应与内存一致
      await loadSessions();
      var dbIds = state.groups.map(function (g) { return Number(g.id); });
      out.dbOrderKept = JSON.stringify(dbIds) === JSON.stringify(ids);
      // ⑥ 列表模式下同样可拖(共用一套分组头)
      state.collapsedGroups.clear(); state.settings.sessionView = 'list'; renderSessionList('');
      var listHeadDraggable = (headOf(${G.test}) || {}).draggable;
      out.listDraggable = !!listHeadDraggable;
      out.insideClass = (out.inside && out.inside.cls || '').indexOf('drop-inside') >= 0;
      out.beforeClass = (out.after && out.after.cls || '').indexOf('drop-after') >= 0;
      state.settings.sessionView = 'tree'; state.collapsedGroups.clear(); renderSessionList('');
      return out;
    })()`);
    if (gdrag.northParent === Number(G.east)) ok('拖到分组头中间 = 变成它的子分组(华北 → 华东 下)');
    else bad('拖成子分组失败', JSON.stringify(gdrag));
    if (gdrag.insideClass) ok('拖到中间时显示「变子分组」虚线框提示');
    else bad('中间区拖拽提示缺失', JSON.stringify(gdrag));
    if (gdrag.cloudAfterProd) ok('拖到下边缘 = 插到同级后面(云上资源 → 生产环境 后)');
    else bad('同级调序失败', JSON.stringify(gdrag));
    if (gdrag.beforeClass) ok('边缘拖拽时显示插入线提示');
    else bad('插入线提示缺失', JSON.stringify(gdrag));
    if (gdrag.sortOrders > 0) ok(`拖拽后写入同级序号 sort_order(${gdrag.sortOrders} 个分组已排序)`);
    else bad('sort_order 未落库', JSON.stringify(gdrag));
    if (gdrag.dbOrderKept) ok('顺序已落库:重新读库后顺序与拖拽结果一致');
    else bad('顺序未持久化', JSON.stringify(gdrag));
    if (gdrag.prodStillRoot) ok('把父分组拖进自己的子分组 → UI 拒绝(不会成环)');
    else bad('UI 未拦住成环拖拽', JSON.stringify(gdrag));
    if (!gdrag.apiReject.ok) ok(`数据层同样拒绝成环(${gdrag.apiReject.error})`);
    else bad('IPC 层未拦住成环', JSON.stringify(gdrag));
    if (gdrag.listDraggable) ok('列表模式分组头同样可拖拽调序');
    else bad('列表模式分组头不可拖拽', JSON.stringify(gdrag));

    // ---------------------------------------------------------------
    // ⑭ 截图
    // ---------------------------------------------------------------
    if (process.env.SHOTS === '1') {
      try {
        fs.mkdirSync(SHOT_DIR, { recursive: true });
        for (const v of ['tree', 'list']) {
          await ev(c, `(function(){ setSessionView(${JSON.stringify(v)}); state.collapsedGroups.clear(); state.collapsedTopBastion = true; renderSessionList(''); })()`);
          await sleep(400);
          const shot = await c.call('Page.captureScreenshot', { format: 'png' });
          const f = path.join(SHOT_DIR, `groups-${v}.png`);
          fs.writeFileSync(f, Buffer.from(shot.data, 'base64'));
          console.log(`  📷 ${f}`);
        }
      } catch (e) { console.log('  (截图失败:' + e.message + ')'); }
    }

    console.log(`\n──────── 结果:${passed} 通过,${failed} 失败,${notes.length} 条成熟度建议 ────────`);
    if (notes.length) { console.log('建议:'); notes.forEach((n, i) => console.log(`  ${i + 1}. ${n}`)); }
  } catch (e) {
    console.error('\n测试异常:', e && e.message);
    failed++;
  }
  try { killTree(appProc); } catch { /* ignore */ }
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(failed ? 1 : 0);
})();
