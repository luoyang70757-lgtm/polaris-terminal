'use strict';
/**
 * verify-group-name-unique.js — 分组命名规则:同一父级下唯一(不依赖 Electron)
 *
 * 需求:列表/树形/网格都使用同一份分组数据 —— **同一级目录下分组名必须唯一**;
 *       不同父级可以同名(如 生产/网络 与 测试/网络)。
 * 旧库是 groups.name TEXT UNIQUE(全局唯一),必须迁移成:
 *   - 根级 name 唯一(部分索引 parent_id IS NULL)
 *   - 同一 parent_id 下 name 唯一
 *   - 不同父级允许同名
 *
 * 运行:node verify-group-name-unique.js
 */
const { DatabaseSync } = require('node:sqlite');
const { createStore } = require('./lib/session-store');

let passed = 0, failed = 0;
const ok = (n) => { passed++; console.log('  ✓ ' + n); };
const bad = (n, e) => { failed++; console.error('  ✗ ' + n + (e ? ' → ' + e : '')); };
function expectThrow(name, fn) {
  try { fn(); bad(name, '未抛错'); } catch (e) { ok(name + `(${e.message})`); }
}

// ---- 构造旧库:groups.name 全局 UNIQUE ----
const legacy = new DatabaseSync(':memory:');
legacy.exec(`
  CREATE TABLE groups (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL UNIQUE,
    parent_id  INTEGER DEFAULT NULL,
    is_prod    INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  )
`);
legacy.prepare('INSERT INTO groups (name) VALUES (?)').run('默认分组');
legacy.prepare('INSERT INTO groups (name, parent_id) VALUES (?, ?)').run('生产', null);
// 旧库的会话表(含 group_id 关联),验证重建 groups 表后会话归属不丢
legacy.exec(`
  CREATE TABLE sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL, host TEXT NOT NULL, port INTEGER DEFAULT 22,
    username TEXT NOT NULL, password TEXT DEFAULT '',
    private_key TEXT DEFAULT '', passphrase TEXT DEFAULT '',
    encoding TEXT DEFAULT 'utf8', protocol TEXT DEFAULT 'ssh',
    group_id INTEGER DEFAULT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )
`);
legacy.prepare('INSERT INTO sessions (name, host, username, group_id) VALUES (?, ?, ?, ?)').run('web1', '127.0.0.1', 'root', 2);
const store = createStore(legacy.serialize());

console.log('\n=== 旧库迁移 + 同一父级下唯一 ===\n');
const 生产 = store.listGroups().find((g) => g.name === '生产');
if (生产 && 生产.parent_id == null) ok('旧库分组 id/parent_id 迁移保留');
else bad('旧库迁移异常', JSON.stringify(store.listGroups()));
const web1 = store.list().find((s) => s.name === 'web1');
if (web1 && Number(web1.group_id) === 2 && web1.group_name === '生产') ok('重建 groups 表后会话 group_id/group_name 仍正确');
else bad('会话分组关联迁移后丢失', JSON.stringify(web1));

// 不同父级同名:根级「生产」 + 子级「生产」→ 允许
let childId = null;
try {
  childId = store.createGroup('生产', 生产.id);
  ok('不同父级下允许同名(生产/生产)');
} catch (e) { bad('不同父级下同名被误拒', e.message); }

// 同一父级下重名 → 拒绝
expectThrow('同一父级下重名被拒绝', () => store.createGroup('生产', 生产.id));
// 根级重名 → 拒绝
expectThrow('根级重名被拒绝', () => store.createGroup('生产', null));
// 父分组不存在 → 拒绝
expectThrow('父分组不存在被拒绝', () => store.createGroup('任意', 999999));

// 重命名:改成同级已存在名 → 拒绝;改成不重名 → 成功
const a = store.createGroup('A', 生产.id);
const b = store.createGroup('B', 生产.id);
expectThrow('重命名为同级已存在名称被拒绝', () => store.renameGroup(b, 'A'));
try { store.renameGroup(b, 'C'); ok('同级不重名可正常重命名'); } catch (e) { bad('同级不重名重命名失败', e.message); }

// 空名 / 纯空格 → 拒绝
expectThrow('空分组名被拒绝', () => store.createGroup('   ', null));

// 不同分支同名不冲突:生产/A/C 与 生产/生产/A?
const a2 = store.createGroup('A', childId);
if (a2) ok('另一父级下可再建同名子分组(生产/生产/A)');
else bad('另一父级下同名子分组失败');

const all = store.listGroups();
const sameParentDup = all.filter((g) => Number(g.parent_id) === Number(生产.id) && g.name === 'A');
if (sameParentDup.length === 1) ok('同一父级下最终只有 1 个「A」');
else bad('同一父级下出现重名', JSON.stringify(all));

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed ? 1 : 0);
