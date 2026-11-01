'use strict';
/**
 * verify-groups-order.js — 分组手动排序(sort_order)的迁移与 moveGroup 语义
 *
 * 纯 Node 跑(不起 Electron):用 node:sqlite 造一个**老版本 schema** 的库
 * (groups 表没有 sort_order 列),deserialize 进 session-store,验证:
 *   ① 启动时自动补列,且升级后顺序与升级前一致(全部 0 → 回退按名称,不打乱用户现有目录);
 *   ② moveGroup:同级调序 / 末尾追加 / 变子分组;
 *   ③ 防环:拖到自己里、拖到自己的子分组里、把保留的「默认分组」挂到别人下面 → 全部拒绝;
 *   ④ 新分组排在同级最后(前提:该父级已经被拖拽排过序);
 *   ⑤ 调序不影响会话归属,删父分组仍级联。
 *
 * 运行:node verify-groups-order.js
 */
const { DatabaseSync } = require('node:sqlite');
const { createStore } = require('./lib/session-store');

let passed = 0, failed = 0;
const ok = (n) => { passed++; console.log('  ✓ ' + n); };
const bad = (n, e) => { failed++; console.error('  ✗ ' + n + (e ? ' → ' + e : '')); };
const head = (t) => console.log(`\n— ${t} —`);
const names = (store) => store.listGroups().map((g) => g.name);
const idOf = (store, name) => {
  const g = store.listGroups().find((x) => x.name === name);
  return g ? Number(g.id) : null;
};

// ---- 造一个"老库":groups 表没有 sort_order 列 ----
function legacyStore() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    parent_id INTEGER DEFAULT NULL,
    is_prod INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  const ins = db.prepare('INSERT INTO groups (name, parent_id) VALUES (?, ?)');
  ins.run('默认分组', null); // 1
  ins.run('生产环境', null); // 2
  ins.run('测试环境', null); // 3
  ins.run('华东', 2);        // 4 → 生产环境的子分组
  ins.run('数据库', 4);      // 5 → 生产环境/华东/数据库
  const bytes = db.serialize();
  db.close();
  return createStore(bytes);
}

console.log('\n=== 分组排序(sort_order)迁移 + moveGroup ===');
try {
  const store = legacyStore();

  head('① 老库迁移');
  const gs = store.listGroups();
  if (gs.every((g) => typeof g.sort_order === 'number' || g.sort_order === null)) ok('老库自动补上 sort_order 列(不再报错)');
  else bad('sort_order 列缺失', JSON.stringify(gs[0]));
  if (gs.every((g) => !g.sort_order)) ok('老数据 sort_order 全为 0(未排过)');
  else bad('老数据被写了序号', JSON.stringify(gs.map((g) => g.name + ':' + g.sort_order)));
  const legacyOrder = ['华东', '数据库', '测试环境', '生产环境', '默认分组']; // ORDER BY name(保持升级前观感)
  if (names(store).join() === legacyOrder.join()) ok(`升级后顺序不变(按名称):${names(store).join(' / ')}`);
  else bad('升级后顺序被打乱', names(store).join(' / '));
  const east = idOf(store, '华东'), db1 = idOf(store, '数据库');
  const prod = idOf(store, '生产环境'), test = idOf(store, '测试环境'), def = idOf(store, '默认分组');

  head('② 同级调序 / 追加 / 变子分组');
  const rootsNow = () => store.listGroups().filter((g) => g.parent_id == null).map((g) => Number(g.id));
  // 根级按名称升序:测试环境(0x6D4B) < 生产环境(0x751F) < 默认分组(0x9ED8)
  if (rootsNow().join() === [test, prod, def].join()) ok(`初始根级顺序:${rootsNow().join(',')}(测试环境 / 生产环境 / 默认分组)`);
  else bad('初始根级顺序异常', rootsNow().join());
  store.moveGroup(prod, null, test); // 生产环境 插到 测试环境 前面(改变初始顺序)
  if (rootsNow().join() === [prod, test].join() + ',' + def) ok('插到同级前面生效(生产环境 → 测试环境 前)');
  else bad('插到前面失败', rootsNow().join());
  if (rootsNow().every((id) => store.listGroups().find((g) => Number(g.id) === id).sort_order > 0)) ok('被调序的同级全部写入序号(10/20/30)');
  else bad('序号未规范化', JSON.stringify(store.listGroups().map((g) => g.name + ':' + g.sort_order)));
  store.moveGroup(test, null, null); // 追加到根级最后
  if (rootsNow().join() === [prod, def, test].join()) ok('beforeId=null 追加到同级最后(测试环境 → 末尾)');
  else bad('追加到最后失败', rootsNow().join());
  store.moveGroup(db1, prod, null); // 数据库 提到 生产环境 下(成为子分组)
  const dbRow = store.listGroups().find((g) => Number(g.id) === db1);
  if (Number(dbRow.parent_id) === prod) ok('变成子分组(数据库 → 生产环境下)');
  else bad('变子分组失败', JSON.stringify(dbRow));
  if (dbRow.sort_order > 0) ok('子分组也被写入序号(同级只有它 → 10)');
  else bad('新父级下未写序号', JSON.stringify(dbRow));

  head('③ 防环 / 保留分组保护');
  const tryMove = (label, fn) => {
    try { fn(); bad(`${label}:未报错`); } catch (e) { ok(`${label}:${e.message}`); }
  };
  tryMove('拖到自己里被拒', () => store.moveGroup(prod, prod, null));
  tryMove('拖到自己的子分组里被拒', () => store.moveGroup(prod, db1, null));
  tryMove('「默认分组」挂到别人下面被拒', () => store.moveGroup(def, prod, null));
  store.moveGroup(def, null, null); // 默认分组在根级调序是允许的
  ok('「默认分组」允许在根级调整顺序');

  head('④ 新建分组排在同级最后');
  store.moveGroup(test, null, prod); // 先让根级有序
  const newId = store.createGroup('新来的分组', null);
  const rootNames = store.listGroups().filter((g) => g.parent_id == null).map((g) => g.name);
  if (rootNames[rootNames.length - 1] === '新来的分组') ok(`新分组追加到根级最后:${rootNames.join(' / ')}`);
  else bad('新分组没排到最后', rootNames.join(' / '));
  const childNew = store.createGroup('子分组X', prod);
  const prodKids = store.listGroups().filter((g) => Number(g.parent_id) === prod).map((g) => g.name);
  if (prodKids[prodKids.length - 1] === '子分组X') ok(`子分组也追加到最后:${prodKids.join(' / ')}`);
  else bad('新子分组没排到最后', prodKids.join(' / '));

  head('⑤ 调序不影响会话 / 删父分组仍级联');
  const sid = store.create({ name: 'web-01', host: '10.0.0.1', username: 'root', groupId: childNew });
  store.moveGroup(childNew, test, null); // 子分组X 从 生产环境 挪到 测试环境(与生产环境无关的分支)
  const s = store.list().find((x) => Number(x.id) === Number(sid));
  if (s && Number(s.group_id) === Number(childNew)) ok('分组换父级后,组内会话归属不变');
  else bad('会话被挪走了', JSON.stringify(s));
  store.deleteGroup(prod);
  const left = store.listGroups().map((g) => Number(g.id));
  if (!left.includes(prod) && !left.includes(db1) && !left.includes(east)) ok('删父分组连带删掉整棵子树(华东 / 数据库)');
  else bad('级联删除不完整', JSON.stringify(left));
  if (left.includes(childNew)) ok('已移走到其他分支的子分组不受影响');
  else bad('被移动过的分组被误删', JSON.stringify(left));
  if (store.list().some((x) => Number(x.group_id) === Number(childNew))) ok('移走的分组里的会话仍存在');
  else bad('会话被误删');

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  store.close();
} catch (e) {
  console.error('\n测试异常:', e && e.stack ? e.stack : e);
  failed++;
}
process.exit(failed ? 1 : 0);
