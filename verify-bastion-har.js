'use strict';
/**
 * verify-bastion-har.js — 用真实 H3C 浏览器 HAR 验证资产捕获(node 直跑)
 *
 * 需求:左侧堡垒机资产应"自动获取",不写死接口。H3C 部分版本没有 getAccessViewTree,
 * 浏览器是逐个目录请求 getAccessViewDevs(请求体 paths 即目录)。本脚本把 HAR 里的
 * 真实请求/响应喂给注入钩子,验证:
 *   1. 被动捕获全部资产(去重)且带目录归属 dir/dirs/dirPath
 *   2. __bastionFetchAll 在无树接口时用观察到的 paths 补拉,返回 true(不硬等 getAccessViewTree)
 *
 * 依赖本地 10.204.240.4-*.har(HAR 不入库,无 HAR 时本脚本自动跳过)。
 * 运行: node verify-bastion-har.js
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

let passed = 0, failed = 0;
async function ok(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.log('  ✗ ' + name + ' — ' + (e && e.message)); }
}

// ---- 提取注入脚本(模拟宿主模板字面量转义 \\/ -> \/) ----
function extractInjectedScript() {
  const src = fs.readFileSync(path.join(__dirname, 'src/renderer.js'), 'utf8');
  const start = src.indexOf('function injectBastionAssetHook(');
  assert(start >= 0, '找不到 injectBastionAssetHook');
  const seg = src.slice(start, start + 40000);
  const open = seg.indexOf('executeJavaScript(`(function(){');
  assert(open >= 0, '找不到 executeJavaScript 模板起点');
  const begin = open + 'executeJavaScript(`'.length;
  const close = seg.indexOf('})()`)', begin);
  assert(close >= 0, '找不到模板终点');
  return seg.slice(begin, close + 4).replace(/\\\\\//g, '\\/');
}

// ---- 找本地 HAR ----
function findHar() {
  for (const c of ['10.204.240.4-11.har', '10.204.240.4-10.har', '10.204.240.4-9.har', '10.204.240.4-8.har']) {
    if (fs.existsSync(path.join(__dirname, c))) return path.join(__dirname, c);
  }
  return null;
}

(async () => {
  const harFile = findHar();
  if (!harFile) { console.log('跳过:仓库根目录没有 10.204.240.4-*.har(HAR 不入库,本测试仅本机跑)'); process.exit(0); }
  console.log('HAR:', path.basename(harFile));
  const HAR = JSON.parse(fs.readFileSync(harFile, 'utf8'));
  const entries = HAR.log.entries;

  const code = extractInjectedScript();
  // ---- 索引资产响应: pathsJson|p<page> -> response text ----
  const index = new Map();
  for (const e of entries) {
    const u = e.request.url;
    if (!/getAccessViewDevs|getFavoriteDevices|getAccessViewTree|userFav/.test(u)) continue;
    if (!e.response.content || !e.response.content.text) continue;
    let body = {};
    try { body = JSON.parse(e.request.postData ? e.request.postData.text : '{}'); } catch {}
    const pathsK = JSON.stringify(body.paths || []);
    const page = body.page != null ? body.page : 0;
    index.set(u.split('?')[0].split('/shterm').pop() + '|' + pathsK + '|p' + page, e.response.content.text);
    index.set('URL|' + u + '|' + pathsK + '|p' + page, e.response.content.text);
  }
  function respond(u, body) {
    const pb = (() => { try { return JSON.parse(body || '{}'); } catch { return {}; } })();
    const pathsK = JSON.stringify(pb.paths || []);
    const page = pb.page != null ? pb.page : 0;
    if (u.includes('getAccessViewTree') || u.includes('userFav')) return '{}';
    let hit = index.get('URL|' + u + '|' + pathsK + '|p' + page);
    if (hit) return hit;
    hit = index.get((u.split('?')[0].split('/shterm').pop() || '') + '|' + pathsK + '|p' + page);
    if (hit) return hit;
    for (const [k, v] of index) if (k.endsWith('|' + pathsK + '|p' + page)) return v;
    return '{}';
  }
  function FakeXHR() { this._listeners = {}; this._headers = {}; }
  FakeXHR.prototype.open = function (m, u) { this.__m = m; this.__u = u; };
  FakeXHR.prototype.setRequestHeader = function (k, v) { this._headers[k] = v; };
  FakeXHR.prototype.addEventListener = function (ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn); };
  FakeXHR.prototype.send = function (body) {
    this.__body = body;
    const self = this;
    setImmediate(() => {
      try { self.responseText = respond(self.__u, body); } catch { self.responseText = '{}'; }
      try { (self._listeners.load || []).forEach((fn) => fn.call(self)); } catch (e) {}
      if (self.onload) self.onload.call(self);
    });
  };
  const windowObj = {
    fetch: (u, init) => {
      const body = (init && init.body) || '';
      return Promise.resolve({ url: String(u), clone: () => ({ text: () => Promise.resolve(respond(String(u), body)) }), text: () => Promise.resolve(respond(String(u), body)) });
    },
  };
  const w = new Function('window', 'document', 'XMLHttpRequest', 'fetch', 'console', code + '\n;return window;')(
    windowObj, { addEventListener: () => {} }, FakeXHR, windowObj.fetch, console);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  await ok('被动捕获:喂入全部 getAccessViewDevs/getFavoriteDevices → 资产去重 + 目录归属', async () => {
    const reqs = entries.filter((e) => /getAccessViewDevs|getFavoriteDevices/.test(e.request.url));
    for (const e of reqs) {
      const x = new FakeXHR();
      x.open(e.request.method, e.request.url);
      x.send((e.request.postData && e.request.postData.text) || '');
      await sleep(0);
    }
    await sleep(50);
    const assets = w.__bastionAssets || [];
    assert(assets.length >= 800, '应捕获 >=800 台,实际 ' + assets.length);
    const withDir = assets.filter((a) => a.dir || (a.dirs && a.dirs.length));
    assert.strictEqual(withDir.length, assets.length, '全部设备应带目录归属,缺 ' + (assets.length - withDir.length));
    const sub = assets.find((a) => a.dirPath && a.dirPath.length >= 2);
    assert(sub, '应有子目录设备');
    assert(sub.dirPath[0], '子目录设备 dirPath 应有业务根');
    assert((w.__bastionPaths || new Set()).size > 100, '应观察到 >100 个目录,实际 ' + (w.__bastionPaths || new Set()).size);
  });

  await ok('主动拉取:无树接口时用观察 paths 补拉,返回 true(不写死 getAccessViewTree)', async () => {
    const r = await w.__bastionFetchAll();
    assert.strictEqual(r, true, 'fetchAll 应返回 true');
    assert((w.__bastionAssets || []).length >= 800, '补拉后资产仍 >=800');
  });

  await ok('全量 API 抓包:netLog 记录所有非静态请求(方法/URL/请求体/响应)', async () => {
    const net = w.__bastionNetLog || [];
    const total = entries.filter((e) => /getAccessViewDevs|getFavoriteDevices|getLoginUserRecentDevs|sessshare/.test(e.request.url)).length;
    assert(net.length >= total, 'netLog 应覆盖全部 API 请求,实际 ' + net.length + ' / ' + total);
    const sample = net.find((n) => n.url.includes('getAccessViewDevs'));
    assert(sample, '应有 getAccessViewDevs 记录');
    assert(sample.m === 'PUT', '方法应为 PUT,实际 ' + sample.m);
    assert(sample.req && sample.req.includes('paths'), '请求体应含 paths');
    assert(sample.resp && sample.resp.length > 0, '响应预览应非空');
    const hasTree = net.some((n) => n.url.includes('userFav') || n.url.includes('getAccessViewTree'));
    console.log('    netLog 条数:' + net.length + ', 含目录/收藏接口:' + hasTree);
  });

  console.log('\n=== ' + (failed ? failed + ' 项失败' : '全部通过(' + passed + ')') + ' ===');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('执行异常:', e.message); process.exit(1); });
