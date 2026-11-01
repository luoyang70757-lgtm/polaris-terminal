'use strict';
/**
 * verify-group-views.js — 列表/树形视图分组层级一致性(回归)
 *
 * 用户症状:
 *   ① 列表模式下新建的子分组"合并不了"——它被拆成和父分组平级的独立节标题;
 *   ② 列表模式与树形模式的目录结构不一致(列表模式完全不体现 parent_id 层级)。
 * 根因:列表视图按 s.group_name 平铺,树形视图才按 groups.parent_id 建树。
 * 修法:两种视图共用 buildGroupHierarchy/renderGroupHierarchy;列表模式仅不折叠。
 *
 * 断言:
 *   ① 树形模式:父组 → 子组 → 子组内主机 的嵌套顺序正确(子组头在父组主机之前/之后均可,
 *      关键是父子组的层级与缩进);
 *   ② 列表模式:同一套父子结构,子组头缩进更深,不再与父组平级;
 *   ③ 空分组在两种模式下都显示;
 *   ④ 列表模式分组头可管理(有 groupId / list-head / 右键菜单),不是纯文本;
 *   ⑤ 拖拽移动会话不丢字段(私钥/口令/编码/协议/标签色/登录宏/跳板机)。
 *
 * 运行:node verify-group-views.js(需 9431/2261/2361 空闲)
 */
const { spawn } = require('child_process');
const { freePort, killTree, guardTimeout, evaluate } = require('./test-helper');
const fs = require('fs'); const os = require('os'); const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-groupviews-'));
const PORT = 9431, SSH = 2261, HTTP = 2361;
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
// CDP 求值(ReferenceError 自动重试,见 test-helper.evaluate)
async function ev(c, expr) { return evaluate(c, expr); }
let passed = 0, failed = 0;
const ok = (n) => { passed++; console.log('  ✓ ' + n); };
const bad = (n, e) => { failed++; console.error('  ✗ ' + n + (e ? ' → ' + e : '')); };

(async () => {
  console.log('\n=== 列表/树形分组层级一致性 ===\n');
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

    // 建层级:父组 → 子组;再建一个空组;主机分别挂在父/子组
    const built = await ev(c, `(async () => {
      const parent = await window.api.createGroup('父组', null);
      const child = await window.api.createGroup('子组', parent.id);
      const empty = await window.api.createGroup('空组', null);
      await window.api.createSession({
        name: '父组主机', host: '127.0.0.1', port: ${SSH}, username: 'admin', password: 'admin123',
        groupId: parent.id, privateKey: '/tmp/fake_key', passphrase: 'kp', encoding: 'gbk',
        protocol: 'ssh', tagColor: 'red', onConnect: 'echo hi',
        jump: { host: '127.0.0.1', port: 2222, username: 'jump', password: 'jp' },
      });
      await window.api.createSession({ name: '子组主机A', host: '127.0.0.2', port: ${SSH}, username: 'admin', password: 'admin123', groupId: child.id });
      await window.api.createSession({ name: '子组主机B', host: '127.0.0.3', port: ${SSH}, username: 'admin', password: 'admin123', groupId: child.id });
      await loadSessions();
      return { parent, child, empty };
    })()`);

    // ③ 分组命名唯一性:根级唯一 + 同一父级唯一;不同父级允许同名
    const uniq = await ev(c, `(async () => {
      const rootDup = await window.api.createGroup('父组', null);                              // 根级重名 → 应失败
      const sameParentDup = await window.api.createGroup('子组', ${built.parent.id});          // 同父重名 → 应失败
      const crossLevel = await window.api.createGroup('子组', ${built.child.id});              // 不同父级同名 → 应成功
      const a = await window.api.createGroup('A', ${built.parent.id});
      const b = await window.api.createGroup('B', ${built.parent.id});
      const renameDup = await window.api.renameGroup(b.id, 'A');                               // 改为同级已存在名 → 应失败
      const renameOk = await window.api.renameGroup(b.id, 'C');                                // 同级不重名 → 应成功
      await loadSessions();
      fillGroupSelect();
      const labels = [...els.fGroup.options].map((o) => o.textContent);
      // 清理本次新增的空分组,避免影响后续视图断言
      for (const g of [crossLevel, a, b]) if (g && g.ok) { try { await window.api.deleteGroup(g.id); } catch { /* ignore */ } }
      await loadSessions();
      return { rootDup, sameParentDup, crossLevel, renameDup, renameOk, labels };
    })()`);

    if (!uniq.rootDup.ok) ok('根级重名被拒绝');
    else bad('根级重名未被拒绝', JSON.stringify(uniq.rootDup));
    if (!uniq.sameParentDup.ok) ok('同一父级下重名被拒绝');
    else bad('同一父级下重名未被拒绝', JSON.stringify(uniq.sameParentDup));
    if (uniq.crossLevel.ok) ok('不同父级下允许同名(如 父组/子组/子组)');
    else bad('不同父级下同名被误拒', JSON.stringify(uniq.crossLevel));
    if (!uniq.renameDup.ok) ok('重命名为同级已存在名称被拒绝');
    else bad('重命名为同级同名未被拒绝', JSON.stringify(uniq.renameDup));
    if (uniq.renameOk.ok) ok('同级不重名可正常重命名');
    else bad('同级不重名重命名失败', JSON.stringify(uniq.renameOk));
    const pathLabel = '父组 / 子组 / 子组';
    if (uniq.labels.includes(pathLabel) && uniq.labels.includes('父组 / 子组')) ok(`分组下拉显示层级路径(含「${pathLabel}」)`);
    else bad('分组下拉未用路径区分同名分组', JSON.stringify(uniq.labels));

    // DOM 快照:按顺序记录分组头(名称/缩进/groupId)与主机行(名称/缩进)
    const snap = (view) => ev(c, `(function(){
      state.settings.sessionView = ${JSON.stringify(view)};
      state.collapsedTopHost = false;
      for (const g of state.groups) state.collapsedGroups.delete(Number(g.id));
      renderSessionList('');
      const host = document.querySelector('.top-group-container');
      const out = [];
      for (const el of (host ? host.children : [])) {
        if (el.classList.contains('asset-group-head')) {
          out.push({ kind:'group', name:(el.querySelector('.asset-group-name')||{}).textContent||el.textContent,
            pad:parseInt(el.style.paddingLeft,10)||0, gid:el.dataset.groupId||null,
            listHead:el.classList.contains('list-head'),
            hasMenu:!!(el.oncontextmenu), canDrop:!!(el.ondrop) });
        } else if (el.classList.contains('host-item')) {
          out.push({ kind:'host', name:(el.querySelector('.name')||{}).textContent||'', pad:parseInt(el.style.paddingLeft,10)||0 });
        }
      }
      return out;
    })()`);

    const tree = await snap('tree');
    const list = await snap('list');

    // ① 两种模式都包含 父组/子组/空组,且子组紧跟父组(嵌套在同一棵树里)
    for (const [label, arr] of [['树形', tree], ['列表', list]]) {
      const names = arr.filter((x) => x.kind === 'group').map((x) => x.name);
      if (names.includes('父组') && names.includes('子组') && names.includes('空组')) ok(`${label}模式包含父组/子组/空组`);
      else bad(`${label}模式分组缺失`, JSON.stringify(names));
      const pi = arr.findIndex((x) => x.kind === 'group' && x.name === '父组');
      const ci = arr.findIndex((x) => x.kind === 'group' && x.name === '子组');
      if (pi >= 0 && ci === pi + 1) ok(`${label}模式子组紧跟父组(不再平铺成独立顶级节)`);
      else bad(`${label}模式子组未嵌套`, `父@${pi} 子@${ci} ${JSON.stringify(arr)}`);
    }

    // ② 子组缩进 > 父组;子组主机缩进 > 父组主机
    for (const [label, arr] of [['树形', tree], ['列表', list]]) {
      const p = arr.find((x) => x.kind === 'group' && x.name === '父组');
      const ch = arr.find((x) => x.kind === 'group' && x.name === '子组');
      if (p && ch && ch.pad > p.pad) ok(`${label}模式子组有层级缩进(${p.pad}px → ${ch.pad}px)`);
      else bad(`${label}模式子组无缩进`, JSON.stringify({ p, ch }));
      const ph = arr.find((x) => x.kind === 'host' && x.name === '父组主机');
      const chh = arr.find((x) => x.kind === 'host' && x.name === '子组主机A');
      if (ph && chh && chh.pad > ph.pad) ok(`${label}模式子组主机缩进更深(${ph.pad}px → ${chh.pad}px)`);
      else bad(`${label}模式子组主机缩进异常`, JSON.stringify({ ph, chh }));
    }

    // ③ 列表模式分组头仍是可管理的真实分组头(不是旧版纯文本 div)
    const listChild = list.find((x) => x.kind === 'group' && x.name === '子组');
    if (listChild && listChild.listHead && listChild.gid === String(built.child.id)) ok(`列表模式分组头可管理(groupId=${listChild.gid})`);
    else bad('列表模式分组头缺少 groupId/list-head', JSON.stringify(listChild));

    // ④ 拖拽移动不能丢字段(旧版只传 name/host/port/username/password)
    const moved = await ev(c, `(async () => {
      const s = state.sessions.find((x) => x.name === '父组主机');
      await moveSessionToGroup(s.id, ${built.empty.id});
      await loadSessions();
      const m = state.sessions.find((x) => Number(x.id) === Number(s.id));
      return { gid:Number(m.group_id), private_key:m.private_key, passphrase:m.passphrase, encoding:m.encoding,
        protocol:m.protocol, tag_color:m.tag_color, on_connect:m.on_connect,
        jumpHost:m.jump && m.jump.host, jumpPw:m.jump && m.jump.password };
    })()`);
    const keep = moved.gid === Number(built.empty.id) && moved.private_key === '/tmp/fake_key' && moved.passphrase === 'kp'
      && moved.encoding === 'gbk' && moved.protocol === 'ssh' && moved.tag_color === 'red'
      && moved.on_connect === 'echo hi' && moved.jumpHost === '127.0.0.1' && moved.jumpPw === 'jp';
    if (keep) ok('拖拽移动保留私钥/口令/编码/协议/标签色/登录宏/跳板机');
    else bad('拖拽移动丢字段', JSON.stringify(moved));

    console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  } catch (e) {
    console.error('\n测试异常:', e && e.message);
    failed++;
  }
  try { killTree(appProc); } catch { /* ignore */ }
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(failed ? 1 : 0);
})();
