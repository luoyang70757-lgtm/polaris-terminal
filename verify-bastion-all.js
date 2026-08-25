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
 * 注意:ok() 必须是 async + await —— 否则 async 断言失败会变成 unhandledRejection,
 * try/catch 接不住,测试会"假绿"(旧版踩过这个坑)。
 *
 * 运行: node verify-bastion-all.js
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

let passed = 0, failed = 0;
async function ok(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.log('  ✗ ' + name + ' — ' + (e && e.message)); }
}

// ---- 从 renderer.js 提取注入脚本本体(与运行时代码完全一致) ----
function extractInjectedScript() {
  const src = fs.readFileSync(path.join(__dirname, 'src/renderer.js'), 'utf8');
  const start = src.indexOf('function injectBastionAssetHook(');
  assert(start >= 0, '找不到 injectBastionAssetHook');
  const seg = src.slice(start, start + 40000);
  const open = seg.indexOf('executeJavaScript(`(function(){');
  assert(open >= 0, '找不到 executeJavaScript 模板起点');
  const begin = open + 'executeJavaScript(`'.length;
  // 模板以 })()` 结束(反引号紧跟其后),匹配完整的模板闭合
  const close = seg.indexOf('})()`)', begin);
  assert(close >= 0, '找不到模板终点');
  // 模拟宿主模板字面量转义:注入脚本里的 \\/ 在运行时被宿主模板解码成 \/
  return seg.slice(begin, close + 4).replace(/\\\\\//g, '\\/');
}

// ---- 从 HAR 提取真实响应(优先当前版本 -11,回退旧版) ----
function loadHar(fname) {
  const candidates = [fname, '10.204.240.4-11.har', '10.204.240.4-10.har', '10.204.240.4-9.har', '10.204.240.4-8.har'];
  let p = null;
  for (const c of candidates) {
    const q = path.join(__dirname, c);
    if (fs.existsSync(q)) { p = q; break; }
  }
  assert(p, '仓库根目录没有可用的 10.204.240.4-*.har(HAR 不入库,本测试仅本机跑)');
  const d = JSON.parse(fs.readFileSync(p, 'utf8'));
  const out = {};
  for (const e of d.log.entries) {
    const u = e.request.url;
    if (u.includes('getAccessViewTree') && !out.tree) out.tree = e.response.content.text;
    if (u.includes('getAccessViewDevs') && !out.devs) { out.devs = e.response.content.text; out.devsUrl = u; }
  }
  return out;
}

// 沙箱执行注入脚本:mock window/document/XHR/fetch,返回脚本挂到 window 上的环境
function runInjected(mockFetch) {
  const code = extractInjectedScript();
  // 注入脚本会 hook window.fetch(const oFetch = window.fetch),所以 window 上必须先有
  // 一个 fetch(真实 webview 里是浏览器原生函数)——否则 oFetch 是 undefined,一调用就崩。
  // 另外 capture() 读的是 r.url(真实 Response 自带),mock 的返回对象必须补上 url 字段,
  // 否则 capture 因 url 为 undefined 直接跳过解析(assets 恒为空)。
  const wrapped = (url, init) => Promise.resolve(mockFetch(url, init)).then((r) => Object.assign({}, r, { url: String(url) }));
  // 注入脚本的 fetchAll/fetchDirs 改用 XHR 发请求(bxhr),FakeXHR 要把响应分发到 onload,
  // 同时触发注入脚本 hook 加的 'load' 监听(capture 合并资产也走这条)。
  function FakeXHR() { this._headers = {}; }
  FakeXHR.prototype = {
    open(m, u) { this._m = m; this._u = u; },
    setRequestHeader(k, v) { this._headers[k] = v; },
    addEventListener(ev, fn) { (this._listeners = this._listeners || {})[ev] = fn; },
    send(body) {
      const self = this;
      const init = { method: this._m, headers: this._headers };
      if (body !== undefined && body !== null) init.body = body;
      Promise.resolve(wrapped(this._u, init))
        .then((r) => (r && r.text ? r.text() : String(r || '')))
        .then((text) => {
          self.responseText = text;
          // 注入脚本 hook 的 send 里 addEventListener('load', function(){ capture(this.__u, ...) })
          // —— 回调里 this 必须是 XHR 实例,否则 __u 是 undefined,capture 直接跳过
          try { self._listeners && self._listeners.load && self._listeners.load.call(self); } catch (e) { /* capture 内部容错 */ }
          if (self.onload) self.onload.call(self);
        })
        .catch(() => { if (self.onerror) self.onerror(new Error('mock xhr error')); });
    },
  };
  const windowObj = { fetch: wrapped };
  const documentObj = { addEventListener: () => {} };
  const fn = new Function('window', 'document', 'XMLHttpRequest', 'fetch', 'console',
    code + '\n;return window;');
  return fn(windowObj, documentObj, FakeXHR, wrapped, console);
}

// 通用 mock fetch 工厂:按 URL 子串分发响应
function mockFetchByUrl(routes) {
  return (url, init) => {
    let resp = '{}';
    for (const key of Object.keys(routes)) {
      if (String(url).includes(key)) { resp = routes[key]; break; }
    }
    return Promise.resolve({ clone: () => ({ text: () => Promise.resolve(resp) }), text: () => Promise.resolve(resp) });
  };
}

(async () => {
  const w = runInjected(mockFetchByUrl({}));
  await ok('注入脚本加载并挂载主动拉取函数', () => {
    assert.strictEqual(typeof w.__bastionFetchAll, 'function', '缺 __bastionFetchAll');
    assert.strictEqual(typeof w.__bastionFetchDirs, 'function', '缺 __bastionFetchDirs');
    assert.ok(Array.isArray(w.__bastionAssets));
    assert.ok(Array.isArray(w.__bastionDiag));
  });

  const har = loadHar('10.204.240.4-3.har');
  await ok('资产解析字段正确(真实 HAR getAccessViewDevs 数据)', async () => {
    assert(har.devs, 'HAR 里没有 getAccessViewDevs 响应');
    const devsResp = JSON.parse(har.devs);
    const one = Object.assign({}, devsResp, { last: true, totalPages: 1 }); // 单页,不触发翻页
    const tree = { children: [{ name: 'rootA', id: 'r1', empty: false, path: ['rootA'] }] };
    const w2 = runInjected(mockFetchByUrl({ getAccessViewTree: JSON.stringify(tree), getAccessViewDevs: JSON.stringify(one) }));
    const r = await w2.__bastionFetchAll();
    assert.strictEqual(r, true, 'fetchAll 应成功');
    const assets = w2.__bastionAssets;
    assert.strictEqual(assets.length, devsResp.content.length, '设备数应等于 content 数,实际 ' + assets.length);
    const first = assets.find((a) => a.name === '10.204.32.231');
    assert(first, '应有 10.204.32.231');
    assert.strictEqual(first.ip, '10.204.32.231');
    assert.strictEqual(first.port, 22);
    assert.strictEqual(first.proto, 'ssh');
    assert.ok(first.accounts.includes('root'), '账号应含 root');
    assert.ok(first.devId, '应有 devId');
  });

  await ok('主动拉全量翻页合并 + 去重', async () => {
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
    await w3.__bastionFetchAll();
    const assets = w3.__bastionAssets;
    assert.strictEqual(assets.length, 3, '3 台(dev-2 只算一次),实际 ' + assets.length);
    assert.ok(assets.some((a) => a.name === 'dev-3'), '第二页设备应合并进来');
  });

  await ok('收藏设备解析(favorite 标记 + favSet)', async () => {
    const fav = {
      content: [
        { id: 100, dev: { id: 100, name: 'DLitim01', ip: '10.204.241.246', services: { services: { ssh: { port: 22 } } }, accounts: { accounts: [{ name: 'root' }] } }, recent: { account: 'root' } },
      ],
      last: true, totalPages: 1,
    };
    const tree = { children: [{ name: 'rootA', id: 'r1', empty: false, path: ['rootA'] }] };
    const w4 = runInjected(mockFetchByUrl({ getAccessViewTree: JSON.stringify(tree), getFavoriteDevices: JSON.stringify(fav) }));
    await w4.__bastionFetchAll();
    assert.strictEqual(w4.__bastionAssets.length, 1, '应有 1 台收藏设备');
    assert.strictEqual(w4.__bastionAssets[0].favorite, true, '收藏设备应带 favorite=true');
    assert.ok(w4.__bastionFavSet.has('100'), 'favSet 应含 devId 100');
  });

  if (har.tree) {
    await ok('目录树解析(树接口版本:getAccessViewTree → 树结构)', async () => {
      const tree = JSON.parse(har.tree);
      const w5 = runInjected(mockFetchByUrl({ getAccessViewTree: JSON.stringify(tree) }));
      await w5.__bastionFetchAll();
      assert.ok(Array.isArray(w5.__bastionTree), '应有树');
      assert.ok(w5.__bastionTree.length > 0, '树非空');
    });
  }

  // 无树接口版本(10.204.240.4 现行):目录归属从 getAccessViewDevs 请求体 paths 自动获取
  // (不写死 getAccessViewTree)。__bastionFetchAll 用观察到的 paths 补拉,设备带 dir/dirs/dirPath。
  await ok('无树接口自动归属(观察 paths → fetchAll 补拉 → dir/dirs/dirPath)', async () => {
    const mkDev = (id, name) => ({ id, dev: { id, name, ip: '10.1.1.' + id, services: { services: { ssh: { port: 22 } } }, accounts: { accounts: [{ name: 'root' }] } }, recent: { account: 'root' } });
    const rA = { content: [mkDev(1, 'host-a')], last: true, totalPages: 1 };
    const rB = { content: [mkDev(1, 'host-a'), mkDev(2, 'host-b')], last: true, totalPages: 1 };
    const w7 = runInjected((url, init) => {
      let resp = '{}';
      if (String(url).includes('getAccessViewDevs')) {
        let body = {};
        try { body = JSON.parse((init && init.body) || '{}'); } catch {}
        const p = (body.paths || []).join('/');
        resp = JSON.stringify(p === '根/目录A' ? rA : (p === '根/目录B' ? rB : { content: [], last: true, totalPages: 1 }));
      }
      return Promise.resolve({ clone: () => ({ text: () => Promise.resolve(resp) }), text: () => Promise.resolve(resp) });
    });
    // 模拟浏览器已观察到的两个目录(无树接口)
    w7.__bastionPaths.add(JSON.stringify(['根', '目录A']));
    w7.__bastionPaths.add(JSON.stringify(['根', '目录B']));
    const r = await w7.__bastionFetchAll();
    assert.strictEqual(r, true, '无树接口 fetchAll 不应失败');
    const a = w7.__bastionAssets.find((x) => x.name === 'host-a');
    const b = w7.__bastionAssets.find((x) => x.name === 'host-b');
    assert(a, 'host-a 应捕获');
    assert.strictEqual(a.dir, '目录A', '主目录首次为准');
    assert.deepStrictEqual(a.dirPath, ['根', '目录A'], 'dirPath 首次为准');
    assert.ok(a.dirs.includes('目录A') && a.dirs.includes('目录B'), 'host-a 应属两个目录(dirs 并集),实际 ' + JSON.stringify(a.dirs));
    assert.strictEqual(b.dir, '目录B', 'host-b 主目录 目录B');
  });

  await ok('目录分组分配(逐目录请求 → dir 字段)', async () => {
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
    await w6.__bastionFetchAll();
    await w6.__bastionFetchDirs();
    const a1 = w6.__bastionAssets.find((a) => a.name === 'a-host');
    const a2 = w6.__bastionAssets.find((a) => a.name === 'b-host');
    assert(a1, 'a-host 应存在');
    assert(a2, 'b-host 应存在');
    assert.strictEqual(a1.dir, '主机_客户管理系统', 'a-host 应归入目录1');
    assert.strictEqual(a2.dir, '中间交易平台', 'b-host 应归入目录2');
  });

  await ok('session-store bastion_assets 持久化 round-trip', () => {
    const { createStore } = require('./lib/session-store.js');
    const store = createStore();
    const assets = [
      { devId: '100', name: 'DLitim01', ip: '10.204.241.246', port: 22, proto: 'ssh', accounts: ['root'], recentAccount: 'root', dir: '主机_客户管理系统', dirPath: ['中华人寿大连IDC', '主机_客户管理系统'], favorite: true },
      { devId: '200', name: 'web-02', ip: '10.204.1.2', port: 22, proto: 'ssh', accounts: [], recentAccount: '', dir: '', dirPath: [], favorite: false },
    ];
    const n = store.saveBastionAssets('https://10.204.240.4', assets);
    assert.strictEqual(n, 2);
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
    store2.saveBastionAssets('https://10.204.240.4', [assets[0]]);
    assert.strictEqual(store2.loadBastionAssets()['https://10.204.240.4'].length, 1, '整批覆盖应清掉旧数据');
    store2.deleteBastionAssets('https://10.204.240.4');
    assert.ok(!store2.loadBastionAssets()['https://10.204.240.4'], '删除后应为空');
    store.close(); store2.close();
  });

  console.log('\n=== 汇总: ' + passed + ' 通过, ' + failed + ' 失败 ===');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.log('\n=== 执行异常: ' + e.message + ' ===');
  process.exit(1);
});
