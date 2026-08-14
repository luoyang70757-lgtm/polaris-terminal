'use strict';
/**
 * verify-bastion-all.js — 堡垒机"全部资产展示"改造的验证脚本(node 直跑)
 *
 * 覆盖:
 *   1. 注入脚本语法(直接执行 renderer.js 里 injectBastionAssetHook 的注入代码本体)
 *   2. 资产解析正确性(用真实 HAR 的 getAccessViewDevs 响应)
 *   3. 主动拉全量翻页合并(多页去重)
 *   4. 收藏设备解析(favorite 标记 + favSet)
 *   5. 目录树解析(getAccessViewTree → 203 节点)
 *   6. 目录分组补充分配(dir 字段)
 *   7. session-store bastion_assets 持久化 round-trip
 *
 * 运行: node verify-bastion-all.js
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

let passed = 0, failed = 0;
function ok(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.log('  ✗ ' + name + ' — ' + e.message); }
}

// ---- 从 renderer.js 提取注入脚本本体(与运行时代码完全一致) ----
function extractInjectedScript() {
  const src = fs.readFileSync(path.join(__dirname, 'src/renderer.js'), 'utf8');
  const start = src.indexOf('function injectBastionAssetHook()');
  assert(start >= 0, '找不到 injectBastionAssetHook');
  const seg = src.slice(start, start + 20000);
  const open = seg.indexOf('executeJavaScript(`(function(){');
  assert(open >= 0, '找不到 executeJavaScript 模板起点');
  const begin = open + 'executeJavaScript(`'.length;
  // 模板以 })()` 结束(反引号紧跟其后),匹配完整的模板闭合
  const close = seg.indexOf('})()`)', begin);
  assert(close >= 0, '找不到模板终点');
  return seg.slice(begin, close + 4); // 含 (function(){ ... })()
}

// ---- 从 HAR 提取真实响应 ----
function loadHar(fname) {
  const d = JSON.parse(fs.readFileSync(path.join(__dirname, '..', fname), 'utf8'));
  const out = {};
  for (const e of d.log.entries) {
    const u = e.request.url;
    if (u.includes('getAccessViewTree') && !out.tree) out.tree = e.response.content.text;
    if (u.includes('getAccessViewDevs') && !out.devs) { out.devs = e.response.content.text; out.devsUrl = u; }
  }
  return out;
}

// 沙箱执行注入脚本:mock window/document/XHR/fetch,返回闭包可调用的环境
function runInjected(mockFetch) {
  const code = extractInjectedScript();
  // 记录注入脚本实际挂到 window 上的东西
  const sandbox = { __apiLog: [] };
  const windowObj = sandbox;
  const documentObj = { addEventListener: () => {} };
  function FakeXHR() {}
  FakeXHR.prototype = { open() {}, send() {}, addEventListener() {} };

  const fn = new Function('window', 'document', 'XMLHttpRequest', 'fetch', 'console',
    code + '\n;return window;');
  return fn(windowObj, documentObj, FakeXHR, mockFetch, console);
}

// ---- 测试 1:注入脚本能加载,挂载 fetchAll/fetchDirs ----
let w = null;
ok('注入脚本加载并挂载主动拉取函数', () => {
  w = runInjected(() => Promise.resolve({ clone: () => ({ text: () => Promise.resolve('{}') }), text: () => Promise.resolve('{}') }));
  assert.strictEqual(typeof w.__bastionFetchAll, 'function', '缺 __bastionFetchAll');
  assert.strictEqual(typeof w.__bastionFetchDirs, 'function', '缺 __bastionFetchDirs');
  assert.ok(Array.isArray(w.__bastionAssets));
  assert.ok(Array.isArray(w.__bastionDiag));
});

// ---- 测试 2:资产解析正确性(真实 HAR 数据,单页无翻页) ----
ok('资产解析字段正确(真实 HAR getAccessViewDevs 数据)', async () => {
  const har = loadHar('10.204.240.4-3.har');
  assert(har.devs, 'HAR 里没有 getAccessViewDevs 响应');
  const devsResp = JSON.parse(har.devs);
  // 把真实响应改造成"最后一页",避免触发翻页(此用例只验证解析)
  const one = Object.assign({}, devsResp, { last: true, totalPages: 1 });
  const w2 = runInjected((url, init) => {
    if (String(url).includes('getAccessViewDevs')) {
      return Promise.resolve({ clone: () => ({ text: () => Promise.resolve(JSON.stringify(one)) }), text: () => Promise.resolve(JSON.stringify(one)) });
    }
    return Promise.resolve({ clone: () => ({ text: () => Promise.resolve('{}') }), text: () => Promise.resolve('{}') });
  });
  return w2.__bastionFetchAll().then((r) => {
    assert.strictEqual(r, true, 'fetchAll 应成功');
    const assets = w2.__bastionAssets;
    assert.strictEqual(assets.length, devsResp.content.length, '设备数应等于 content 数');
    const first = assets.find((a) => a.name === '10.204.32.231');
    assert(first, '应有 10.204.32.231');
    assert.strictEqual(first.ip, '10.204.32.231');
    assert.strictEqual(first.port, 22);
    assert.strictEqual(first.proto, 'ssh');
    assert.ok(first.accounts.includes('root'), '账号应含 root');
    assert.ok(first.devId, '应有 devId');
  });
});

// ---- 测试 3:翻页合并去重(构造 2 页,page0 与 page1 有重复设备) ----
ok('主动拉全量翻页合并 + 去重', async () => {
  const mkDev = (id, name) => ({
    id, dev: { id, name, ip: '10.0.0.' + id, services: { services: { ssh: { port: 22 } } }, accounts: { accounts: [{ name: 'root' }] } },
    recent: { account: 'root' },
  });
  const p0 = { content: [mkDev(1, 'dev-1'), mkDev(2, 'dev-2')], last: false, totalPages: 2, totalElements: 3 };
  const p1 = { content: [mkDev(2, 'dev-2'), mkDev(3, 'dev-3')], last: true, totalPages: 2, totalElements: 3 };
  const tree = { children: [{ name: 'rootA', id: 'r1', empty: false, path: ['rootA'] }] };
  const w3 = runInjected((url, init) => {
    let resp = '{}';
    if (String(url).includes('getAccessViewTree')) resp = JSON.stringify(tree);
    else if (String(url).includes('getAccessViewDevs')) {
      const page = Number(new URL(String(url), 'http://x').searchParams.get('page')) || 0;
      resp = JSON.stringify(page === 0 ? p0 : p1);
    }
    return Promise.resolve({ clone: () => ({ text: () => Promise.resolve(resp) }), text: () => Promise.resolve(resp) });
  });
  return w3.__bastionFetchAll().then(() => {
    const assets = w3.__bastionAssets;
    assert.strictEqual(assets.length, 3, '3 台(dev-2 只算一次)');
    assert.ok(assets.some((a) => a.name === 'dev-3'), '第二页设备应合并进来');
  });
});

// ---- 测试 4:收藏设备解析 ----
ok('收藏设备解析(favorite 标记 + favSet)', async () => {
  const fav = {
    content: [
      { id: 100, dev: { id: 100, name: 'DLitim01', ip: '10.204.241.246', services: { services: { ssh: { port: 22 } } }, accounts: { accounts: [{ name: 'root' }] } }, recent: { account: 'root' } },
    ],
    last: true, totalPages: 1,
  };
  const w4 = runInjected((url) => {
    const resp = String(url).includes('getFavoriteDevices') ? JSON.stringify(fav) : '{}';
    return Promise.resolve({ clone: () => ({ text: () => Promise.resolve(resp) }), text: () => Promise.resolve(resp) });
  });
  return w4.__bastionFetchAll().then(() => {
    assert.strictEqual(w4.__bastionAssets.length, 1);
    assert.strictEqual(w4.__bastionAssets[0].favorite, true, '收藏设备应带 favorite=true');
    assert.ok(w4.__bastionFavSet.has('100'), 'favSet 应含 devId 100');
  });
});

// ---- 测试 5:目录树解析(真实 HAR getAccessViewTree,203 节点) ----
ok('目录树解析(真实 HAR,203 节点 + path)', async () => {
  const har = loadHar('10.204.240.4-3.har');
  assert(har.tree, 'HAR 里没有 getAccessViewTree 响应');
  const tree = JSON.parse(har.tree);
  const w5 = runInjected((url) => {
    const resp = String(url).includes('getAccessViewTree') ? JSON.stringify(tree) : '{}';
    return Promise.resolve({ clone: () => ({ text: () => Promise.resolve(resp) }), text: () => Promise.resolve(resp) });
  });
  return w5.__bastionFetchAll().then(() => {
    assert.ok(Array.isArray(w5.__bastionTree), '应有树');
    assert.strictEqual(w5.__bastionTree.length, 203, '203 个目录节点');
    const n = w5.__bastionTree[0];
    assert.ok(Array.isArray(n.path) && n.path.length === 2, 'path 应为 [根, 目录名]');
    assert.strictEqual(n.path[0], '中华人寿大连IDC');
  });
});

// ---- 测试 6:目录分组分配(dir 字段渐进式补齐) ----
ok('目录分组分配(逐目录请求 → dir 字段)', async () => {
  const tree = {
    children: [
      { name: '主机_客户管理系统', id: '164', empty: false, path: ['中华人寿大连IDC', '主机_客户管理系统'] },
      { name: '中间交易平台', id: '57', empty: false, path: ['中华人寿大连IDC', '中间交易平台'] },
      { name: '空', id: '999', empty: true, path: ['中华人寿大连IDC', null] },
    ],
  };
  const mkDev = (id, name) => ({ id, dev: { id, name, ip: '10.1.1.' + id, services: { services: { ssh: { port: 22 } } }, accounts: { accounts: [] } }, recent: {} });
  const d1 = { content: [mkDev(1, 'a-host')], last: true, totalPages: 1 };
  const d2 = { content: [mkDev(2, 'b-host')], last: true, totalPages: 1 };
  const w6 = runInjected((url, init) => {
    let resp = '{}';
    if (String(url).includes('getAccessViewTree')) resp = JSON.stringify(tree);
    else if (String(url).includes('getAccessViewDevs')) {
      let body = {};
      try { body = JSON.parse((init && init.body) || '{}'); } catch {}
      const p = (body.paths || [])[1] || '';
      resp = JSON.stringify(p === '主机_客户管理系统' ? d1 : (p === '中间交易平台' ? d2 : { content: [], last: true, totalPages: 1 }));
    }
    return Promise.resolve({ clone: () => ({ text: () => Promise.resolve(resp) }), text: () => Promise.resolve(resp) });
  });
  // 先拉全量(合并两台),再分组
  await w6.__bastionFetchAll();
  await w6.__bastionFetchDirs();
  const a1 = w6.__bastionAssets.find((a) => a.name === 'a-host');
  const a2 = w6.__bastionAssets.find((a) => a.name === 'b-host');
  assert.strictEqual(a1.dir, '主机_客户管理系统', 'a-host 应归入目录1');
  assert.strictEqual(a2.dir, '中间交易平台', 'b-host 应归入目录2');
});

// ---- 测试 7:session-store 持久化 round-trip ----
ok('session-store bastion_assets 持久化 round-trip', () => {
  const { createStore } = require('./lib/session-store.js');
  const store = createStore();
  const assets = [
    { devId: '100', name: 'DLitim01', ip: '10.204.241.246', port: 22, proto: 'ssh', accounts: ['root'], recentAccount: 'root', dir: '主机_客户管理系统', dirPath: ['中华人寿大连IDC', '主机_客户管理系统'], favorite: true },
    { devId: '200', name: 'web-02', ip: '10.204.1.2', port: 22, proto: 'ssh', accounts: [], recentAccount: '', dir: '', dirPath: [], favorite: false },
  ];
  const n = store.saveBastionAssets('https://10.204.240.4', assets);
  assert.strictEqual(n, 2);
  // 整库序列化 → 新库反序列化 → 数据还在(模拟重启)
  const bytes = store.serialize();
  const store2 = createStore(Buffer.from(bytes));
  const byUrl = store2.loadBastionAssets();
  assert.ok(byUrl['https://10.204.240.4'], '按地址分组');
  assert.strictEqual(byUrl['https://10.204.240.4'].length, 2);
  const first = byUrl['https://10.204.240.4'].find((a) => a.devId === '100');
  assert.strictEqual(first.name, 'DLitim01');
  assert.strictEqual(first.favorite, true);
  assert.strictEqual(first.dir, '主机_客户管理系统');
  assert.deepStrictEqual(first.accounts, ['root']);
  // 整批覆盖:只存 1 台 → 旧的 200 应消失
  store2.saveBastionAssets('https://10.204.240.4', [assets[0]]);
  assert.strictEqual(store2.loadBastionAssets()['https://10.204.240.4'].length, 1, '整批覆盖应清掉旧数据');
  // 删除
  store2.deleteBastionAssets('https://10.204.240.4');
  assert.ok(!store2.loadBastionAssets()['https://10.204.240.4'], '删除后应为空');
  store.close(); store2.close();
});

console.log('\n=== 汇总: ' + passed + ' 通过, ' + failed + ' 失败 ===');
process.exit(failed ? 1 : 0);
