'use strict';
/**
 * verify-bastion-har.js — 用真实 H3C 浏览器 HAR 验证资产**解析与合并**(node 直跑)
 *
 * 历史:本脚本原先把 HAR 喂给 webview 注入钩子(__bastionFetchAll);该注入层已整体移除
 * (资产改由主进程 lib/h3c-api.js 原生 IPC 拉取)。现改为直接驱动**现存纯函数**:
 *   bastionParseDevs(响应, paths)  +  bastionMergeDevs(累积, 本页)
 * 与原生链路 lib/h3c-api → bastionParseDevs/bastionMergeDevs 完全一致,回归价值不变。
 *
 * 断言:① 解析出全部设备且都带目录归属 ② 存在多目录设备 ③ 子目录设备的 dirPath 带业务根
 *      ④ 观察到 >100 个目录 ⑤ 同一响应重复喂入 → devId 去重(不翻倍) ⑥ 树结构({children})也能解析
 * 依赖本地 10.204.240.4-*.har(HAR 不入库,无 HAR 时本脚本自动跳过)。
 * 运行: node verify-bastion-har.js(需 9377 空闲)
 */
const { spawn, execSync } = require('child_process');
const { freePort, killTree, guardTimeout, evaluate } = require('./test-helper');
const fs = require('fs'); const os = require('os'); const path = require('path');

let passed = 0, failed = 0;
const ok = (n) => { passed++; console.log('  ✓ ' + n); };
const bad = (n, e) => { failed++; console.error('  ✗ ' + n + (e ? ' → ' + e : '')); };

function findHar() {
  // POLARIS_HAR 可指定任意一份(本机 HAR 不入库,常放在别的目录)
  if (process.env.POLARIS_HAR && fs.existsSync(process.env.POLARIS_HAR)) return process.env.POLARIS_HAR;
  for (const c of ['10.204.240.4-5.har', '10.204.240.4-11.har', '10.204.240.4-10.har', '10.204.240.4-9.har', '10.204.240.4-8.har']) {
    if (fs.existsSync(path.join(__dirname, c))) return path.join(__dirname, c);
  }
  return null;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function targets(PORT) {
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json`, { signal: AbortSignal.timeout(3000) }); const j = await r.json(); const p = j.find((t) => t.type === 'page' && /解锁|Polaris/.test(t.title || '')); if (p) return j; } catch { /* not ready */ }
    await sleep(400);
  }
  throw new Error('targets 未就绪');
}
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url); let id = 0; const pending = new Map();
    ws.onopen = () => resolve({ call(m, p = {}) { return new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method: m, params: p })); }); }, close() { ws.close(); } });
    ws.onerror = (e) => reject(e);
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };
  });
}
// CDP 求值(ReferenceError 自动重试,见 test-helper.evaluate)
async function ev(c, expr) { return evaluate(c, expr); }

(async () => {
  console.log('\n=== 真实 HAR → 资产解析/合并(原生链路同款纯函数) ===\n');
  const harFile = findHar();
  if (!harFile) { console.log('跳过:仓库根目录没有 10.204.240.4-*.har(HAR 不入库,本测试仅本机跑)'); process.exit(0); }
  console.log('HAR:', path.basename(harFile));
  const HAR = JSON.parse(fs.readFileSync(harFile, 'utf8'));
  const entries = HAR.log.entries;
  // 索引:getAccessViewDevs / getFavoriteDevices 的 {paths, body}
  const devs = [];
  let treeBody = null;
  for (const e of entries) {
    const u = e.request.url;
    if (!e.response.content || !e.response.content.text) continue;
    if (/getAccessViewTree/.test(u)) { treeBody = e.response.content.text; continue; }
    if (!/getAccessViewDevs|getFavoriteDevices|getLoginUserRecentDevs/.test(u)) continue;
    let body = {}; try { body = JSON.parse((e.request.postData && e.request.postData.text) || '{}'); } catch { /* ignore */ }
    devs.push({ paths: body.paths || null, text: e.response.content.text });
  }
  console.log(`  提取 ${devs.length} 个资产响应${treeBody ? ' + 1 个目录树' : ''}`);

  const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-har-'));
  const PORT = 9377;
  try { execSync('pkill -f "polaris-terminal/node_modules/electron" 2>/dev/null'); } catch { /* 无残留 */ }
  freePort(PORT);
  const appProc = spawn(require('electron'), ['.', '--dev', `--remote-debugging-port=${PORT}`], {
    env: { ...process.env, POLARIS_LOCK_DIR: DIR, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
    stdio: ['ignore', 'ignore', 'ignore'], detached: true,
  });
  guardTimeout(150000, appProc);
  try {
    let lockT = null;
    for (let i = 0; i < 50; i++) { lockT = (await targets(PORT)).find((t) => /解锁/.test(t.title || '')); if (lockT) break; await sleep(400); }
    const lock = await connect(lockT.webSocketDebuggerUrl);
    for (let i = 0; i < 30; i++) { if (await ev(lock, `!!document.getElementById('pw')`)) break; await sleep(300); }
    await sleep(300);
    await ev(lock, `document.getElementById('pw').value='x1234567'; document.getElementById('pw2').value='x1234567'; document.getElementById('btn').click();`);
    let main = null;
    for (let i = 0; i < 30; i++) { await sleep(500); const t2 = await targets(PORT); const m = t2.find((t) => t.type === 'page' && !/解锁/.test(t.title || '')); if (m) { main = m; break; } }
    const c = await connect(main.webSocketDebuggerUrl);
    await sleep(800);
    if (!(await ev(c, `typeof bastionParseDevs === 'function' && typeof bastionMergeDevs === 'function'`))) {
      throw new Error('renderer 里找不到 bastionParseDevs/bastionMergeDevs(函数被改名?)');
    }

    // 逐响应喂入(每个 evaluate 只带一份响应,避免单次消息过大)
    await ev(c, `window.__acc = []; window.__seen = new Set(); true`);
    for (const d of devs) {
      const pathsJson = JSON.stringify(d.paths);
      const bodyJson = JSON.stringify(d.text); // 已是字符串本体,再 stringify 成 JS 字面量
      await ev(c, `(function(){ window.__acc = bastionMergeDevs(window.__acc, bastionParseDevs(JSON.parse(${bodyJson}), ${pathsJson})); (${pathsJson}||[]).forEach(function(p){ window.__seen.add(JSON.stringify(p)); }); return window.__acc.length; })()`);
    }
    const stats = JSON.parse(await ev(c, `(function(){
      const a = window.__acc || [];
      const withDir = a.filter(function(x){ return x.dir || (x.dirs && x.dirs.length); }).length;
      const multi = a.filter(function(x){ return (x.dirs||[]).length >= 2; }).length;
      const sub = a.filter(function(x){ return x.dirPath && x.dirPath.length >= 2 && x.dirPath[0]; }).length;
      const sample = a.find(function(x){ return x.dirPath && x.dirPath.length >= 2; }) || null;
      return JSON.stringify({ n: a.length, withDir: withDir, multi: multi, sub: sub, paths: window.__seen.size,
        sample: sample ? { name: sample.name, ip: sample.ip, devId: sample.devId, dirs: sample.dirs, root: sample.dirPath[0] } : null });
    })()`));
    // 规模阈值面向"全量 HAR"(几百台/过百目录);小样本 HAR(如 10.204.240.4-5.har 只录了
    // 一页 20 台、1 个目录)只断言"解析对了",不拿规模阈值误报红。
    const smallHar = stats.n < 100;
    if (smallHar) console.log(`  (小样本 HAR:${stats.n} 台 / ${stats.paths} 个目录 → 跳过规模断言 ②③④)`);
    if (smallHar ? stats.n > 0 : stats.n >= 800) ok(`① 解析出 ${stats.n} 台设备${smallHar ? '(小样本)' : '(>=800)'}`);
    else bad('① 设备数偏少', String(stats.n));
    // 无 paths 的响应(如"最近设备" getLoginUserRecentDevs)解析出的设备本就没有目录归属,
    // UI 用「🗂 未分组」兜底(renderBastionInSessionList 里 dir 为空即归未分组)——属设计内,不是缺陷。
    const noDir = stats.n - stats.withDir;
    if (noDir === 0) ok('① 全部设备都带目录归属');
    else if (noDir / stats.n < 0.02) ok(`① 带目录归属 ${stats.withDir}/${stats.n},其余 ${noDir} 台来自无 paths 的响应(UI 归「未分组」)`);
    else bad('① 缺目录归属的设备过多', `${noDir} / ${stats.n}`);
    if (smallHar) {
      // 小样本里设备数少,顺带断言第一个设备字段完整(真实数据上有 name/ip/devId)
      const first = await ev(c, `(function(){ const a = window.__acc || []; const x = a[0] || {}; return JSON.stringify({ name: x.name, ip: x.ip, devId: x.devId, proto: x.proto }); })()`);
      const f = JSON.parse(first);
      if (f.name && f.ip && f.devId && f.proto) ok(`① 字段完整(例:${f.name}/${f.ip}/devId=${String(f.devId).slice(0, 8)}…/proto=${f.proto})`);
      else bad('① 解析字段缺失', first);
    } else {
      if (stats.multi > 0) ok(`② 存在多目录设备(${stats.multi} 台,与网页一致)`);
      else bad('② 没有多目录设备');
      if (stats.sub > 0) ok(`③ 子目录设备 dirPath 带业务根(${stats.sub} 台,例:${stats.sample && stats.sample.root})`);
      else bad('③ 无带业务根的子目录设备');
      if (stats.paths > 100) ok(`④ 观察到 ${stats.paths} 个目录`);
      else bad('④ 目录数偏少', String(stats.paths));
      if (stats.n >= 800 && stats.sample && stats.sample.devId && stats.sample.ip) ok(`① 字段完整(例:${stats.sample.name}/${stats.sample.ip}/devId=${String(stats.sample.devId).slice(0, 8)}…)`);
      else bad('① 解析字段缺失', JSON.stringify(stats.sample));
    }

    // ⑦ 协议识别(纯函数,同一批真实数据):services 里没有 ssh 的资产绝不能被判成"可连 SSH"
    const protoStats = JSON.parse(await ev(c, `(function(){
      const a = window.__acc || [];
      const nonssh = a.filter(function(x){ return !bastionAssetSupportsSsh(x); });
      return JSON.stringify({ n: a.length, nonssh: nonssh.length, labels: nonssh.slice(0, 3).map(function(x){ return bastionProtoLabels(x).join('/'); }), ids: nonssh.slice(0, 3).map(function(x){ return String(x.devId); }) });
    })()`));
    if (protoStats.nonssh > 0) ok(`⑦ 真实数据里 ${protoStats.nonssh}/${protoStats.n} 台非 SSH 资产已识别(标签:${protoStats.labels.join(',')})`);
    else console.log('  (这份 HAR 里全是 SSH 资产,跳过 ⑦ 的非 SSH 断言)');
    if (protoStats.nonssh > 0 && protoStats.labels.every((l) => l && l !== 'SSH')) ok('⑦ 非 SSH 资产的协议标签不是 SSH');
    else if (protoStats.nonssh > 0) bad('⑦ 非 SSH 资产被标成 SSH', JSON.stringify(protoStats.labels));

    // ⑧ 列表行徽标 / 右键说明(pure 逻辑同上,这里确认真实 DOM 上也能渲染出来)
    const dom = JSON.parse(await ev(c, `(function(){
      const mk = function(o){ return makeBastionAssetItem(o).outerHTML; };
      const rdp = { name:'win-rdp', ip:'10.0.0.1', devId:'1', proto:'rdp', protocols:['rdp'], accounts:['admin'], dir:'', dirs:[] };
      const ssh = { name:'linux-a', ip:'10.0.0.2', devId:'2', proto:'ssh', protocols:['ssh'], accounts:['root'], dir:'', dirs:[] };
      const web = { name:'storage', ip:'10.0.0.3', devId:'3', proto:'Device_Storage_web', protocols:['Device_Storage_web'], webUrl:'https://10.0.0.3:8088', accounts:[], dir:'', dirs:[] };
      return JSON.stringify({ rdp: mk(rdp), ssh: mk(ssh), web: mk(web), rdpMsg: bastionUnsupportedAssetMsg(rdp), webMsg: bastionUnsupportedAssetMsg(web) });
    })()`));
    if (/\.asset-proto|asset-proto/.test(dom.rdp) && />RDP</.test(dom.rdp)) ok('⑧ RDP 资产行渲染出「RDP」徽标');
    else bad('⑧ RDP 资产行没有协议徽标', dom.rdp.slice(0, 160));
    if (!/asset-proto/.test(dom.ssh)) ok('⑧ SSH 资产行不加徽标(不制造噪声)');
    else bad('⑧ SSH 资产行也加了徽标', dom.ssh.slice(0, 160));
    if (/>Web</.test(dom.web)) ok('⑧ 存储 Web 资产行渲染出「Web」徽标');
    else bad('⑧ Web 资产行没有协议徽标', dom.web.slice(0, 160));
    if (/RDP/.test(dom.rdpMsg) && dom.webMsg.indexOf('https://10.0.0.3:8088') >= 0) ok('⑧ 说明文案:非 SSH 资产给出真实协议 + 浏览器地址');
    else bad('⑧ 说明文案不对', JSON.stringify([dom.rdpMsg, dom.webMsg]));

    // ⑤ 去重:同一批响应再喂一遍,设备数不应翻倍
    const before = await ev(c, `window.__acc.length`);
    for (const d of devs.slice(0, 3)) {
      const pathsJson = JSON.stringify(d.paths);
      const bodyJson = JSON.stringify(d.text);
      await ev(c, `(function(){ window.__acc = bastionMergeDevs(window.__acc, bastionParseDevs(JSON.parse(${bodyJson}), ${pathsJson})); return true; })()`);
    }
    const after = await ev(c, `window.__acc.length`);
    if (after === before) ok(`⑤ 重复喂入同一响应 → devId 去重生效(${before} → ${after})`);
    else bad('⑤ 去重失效(设备翻倍)', `${before} → ${after}`);

    // ⑥ 树结构({children})解析
    if (treeBody) {
      const treeJson = JSON.stringify(treeBody);
      const treeN = await ev(c, `(function(){ const t = bastionParseDevs(JSON.parse(${treeJson}), null); return JSON.stringify({ n: t.length, withIp: t.filter(function(x){ return x.ip; }).length }); })()`);
      const t = JSON.parse(treeN);
      if (t.n > 0 && t.withIp === t.n) ok(`⑥ 目录树({children})解析出 ${t.n} 台设备且都带 IP`);
      else if (t.n === 0) console.log('  (这份 HAR 的目录树只有分组节点、没有带 IP 的设备节点,跳过 ⑥)');
      else bad('⑥ 树解析异常', treeN);
    } else console.log('  (HAR 里没有目录树响应,跳过 ⑥)');

    console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  } catch (e) { console.error('\n测试异常:', e && e.message); failed++; console.log(`\n结果: ${passed} 通过, ${failed} 失败`); }
  try { killTree(appProc); } catch { /* ignore */ }
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(failed ? 1 : 0);
})();
