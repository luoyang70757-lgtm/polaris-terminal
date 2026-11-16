'use strict';
/**
 * verify-bastion-client-open.js — H3C 客户端透传(accessclient://)的 e2e 回归(v1.0.19)
 *
 * 场景:非 SSH 资产(RDP / 存储 Web)不该由 Polaris 硬连,而是把堡垒机返回的
 * `accessclient://<token>` **原样交给 Windows 上已注册的 AccessClient.exe**。
 *
 * 本脚本在 macOS/Linux 上也能跑:用两个测试钩子
 *   POLARIS_H3C_CLIENT=1     → 主进程 h3cClient:detect 直接返回「已安装」(不读注册表)
 *   POLARIS_TEST_NO_EXTERNAL=1 → app:openExternal 只回 {ok:true,skipped:true}(不真起程序)
 * 断言链路:detect → state.h3cClient → 列表文案/徽标 → 透传地址 → 失败提示 → 主进程白名单。
 *
 *   node verify-bastion-client-open.js   (需 9378 端口空闲)
 */
const { spawn, execSync } = require('child_process');
const { freePort, guardTimeout, evaluate, sleep } = require('./test-helper');
const fs = require('fs');
const os = require('os');
const path = require('path');

let passed = 0, failed = 0;
const ok = (n) => { passed++; console.log('  ✓ ' + n); };
const bad = (n, e) => { failed++; console.error('  ✗ ' + n + (e ? ' → ' + e : '')); };

async function targets(PORT) {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json`, { signal: AbortSignal.timeout(3000) });
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
    let id = 0;
    const pending = new Map();
    ws.onopen = () => resolve({
      call(m, p = {}) { return new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method: m, params: p })); }); },
      close() { ws.close(); },
    });
    ws.onerror = (e) => reject(e);
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
    };
  });
}
const ev = (c, expr) => evaluate(c, expr);

(async () => {
  console.log('\n=== H3C 客户端透传(accessclient:// → AccessClient.exe) ===\n');
  const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-h3cclient-'));
  const PORT = 9378;
  try { execSync('pkill -f "remote-debugging-port" 2>/dev/null'); } catch { /* 无残留 */ }
  freePort(PORT);
  const appProc = spawn(require('electron'), ['.', '--dev', `--remote-debugging-port=${PORT}`], {
    env: {
      ...process.env,
      POLARIS_LOCK_DIR: DIR,
      POLARIS_H3C_CLIENT: '1',          // 假装本机装了 H3C 客户端
      POLARIS_TEST_NO_EXTERNAL: '1',    // 不真的起 mstsc/浏览器
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
    },
    stdio: ['ignore', 'ignore', 'ignore'],
    detached: true,
  });
  guardTimeout(150000, appProc);
  try {
    let lockT = null;
    for (let i = 0; i < 50; i++) {
      lockT = (await targets(PORT)).find((t) => /解锁/.test(t.title || ''));
      if (lockT) break;
      await sleep(400);
    }
    if (!lockT) throw new Error('解锁页没出现');
    const lock = await connect(lockT.webSocketDebuggerUrl);
    for (let i = 0; i < 30; i++) { if (await ev(lock, `!!document.getElementById('pw')`)) break; await sleep(300); }
    await sleep(300);
    await ev(lock, `document.getElementById('pw').value='x1234567'; document.getElementById('pw2').value='x1234567'; document.getElementById('btn').click();`);
    let main = null;
    for (let i = 0; i < 30; i++) {
      await sleep(500);
      const t2 = await targets(PORT);
      const m = t2.find((t) => t.type === 'page' && !/解锁/.test(t.title || ''));
      if (m) { main = m; break; }
    }
    if (!main) throw new Error('主窗口没出现');
    const c = await connect(main.webSocketDebuggerUrl);
    await sleep(900);

    if (!(await ev(c, `typeof bastionOpenAccessClient === 'function' && typeof bastionNonSshEntry === 'function' && typeof bastionConnectNonSsh === 'function'`))) {
      throw new Error('renderer 缺 bastionOpenAccessClient/bastionNonSshEntry/bastionConnectNonSsh(被改名?)');
    }

    // ---------- ① 探测:测试钩子 → 已安装 ----------
    const det = JSON.parse(await ev(c, `(async function(){ const r = await window.api.h3cClientDetect(); return JSON.stringify(r); })()`));
    if (det && det.ok && det.installed === true) ok('① h3cClient:detect 返回已安装(POLARIS_H3C_CLIENT=1 钩子)');
    else bad('① 探测结果不对', JSON.stringify(det));
    const st = JSON.parse(await ev(c, `JSON.stringify(state.h3cClient || null)`));
    if (st && st.installed === true) ok('① 启动时把探测结果写进 state.h3cClient(入口据此显隐)');
    else bad('① state.h3cClient 未就绪', JSON.stringify(st));

    // ---------- ② 列表文案 + 徽标 ----------
    const assetExpr = `bastionParseDevs({ content: [{ id: 4242, dev: { id: 4242, name: 'nas-rdp', ip: '10.9.9.9', services: { services: { rdp: { port: 3389 } } } } }] }, ['IDC'])[0]`;
    const info = JSON.parse(await ev(c, `(function(){
      const a = ${assetExpr};
      const item = makeBastionAssetItem(a);
      const badge = item.querySelector('.asset-proto');
      return JSON.stringify({ title: item.title, badge: badge ? badge.textContent : '', cls: item.className,
        menu: bastionNonSshEntry(a, true).menu, supports: bastionAssetSupportsSsh(a) });
    })()`));
    if (info.supports === false) ok('② RDP 资产被判非 SSH(不会拿 proto=ssh 去请求)');
    else bad('② RDP 资产仍被判可连', JSON.stringify(info));
    if (/H3C 客户端/.test(info.title) && /asset-nonssh/.test(info.cls)) ok('② 装了客户端后,行提示「双击用 H3C 客户端打开」并保留非 SSH 样式');
    else bad('② 行文案/样式不对', JSON.stringify({ title: info.title, cls: info.cls }));
    if (info.badge === 'RDP') ok('② 徽标仍标真实协议 RDP');
    else bad('② 徽标不对', info.badge);
    if (/用堡垒机客户端打开/.test(info.menu) && /RDP/.test(info.menu)) ok('② 右键首项 = 用堡垒机客户端打开(RDP)');
    else bad('② 右键首项不对', info.menu);

    // ---------- ③ 透传:地址必须原样 ----------
    const TOKEN = 'accessclient://eJx1UctOwzAQ-JUoZ-S8nIbmBKqQeEi0aivUW+U6W8VqEwc/QgHx73gdJRUHbju7Y8/M7nfIui4sw0YbzcObUBsHtO1A3S05sHZjpApWjIuj4ME8T2PH6UE5EiUzUjh08O9FmcwcqGpfU4o8ZishOeuMVdDICvwIB03vSs84';
    const t1 = JSON.parse(await ev(c, `(async function(){
      window.__opened = null;
      window.openExternalUrl = async function (u) { window.__opened = u; return { ok: true }; };
      const a = ${assetExpr};
      const r = await bastionOpenAccessClient(${JSON.stringify(TOKEN)}, a);
      return JSON.stringify({ ok: r, opened: window.__opened, status: document.getElementById('toolbar-status').textContent });
    })()`));
    if (t1.ok === true && t1.opened === TOKEN) ok('③ 透传地址与堡垒机返回的 token 逐字节一致(未过 new URL())');
    else bad('③ 透传地址被改写或没传', JSON.stringify({ opened: t1.opened && t1.opened.slice(0, 40), same: t1.opened === TOKEN }));
    if (/已交给 H3C 客户端/.test(t1.status)) ok('③ 状态栏提示「已交给 H3C 客户端打开」');
    else bad('③ 状态栏没提示', t1.status);

    // ---------- ④ 拉不起来 → 明确失败,不静默 ----------
    const t2 = JSON.parse(await ev(c, `(async function(){
      window.__alerts = [];
      window.alert = function (m) { window.__alerts.push(String(m)); };
      window.openExternalUrl = async function () { return { ok: false, error: 'no handler registered' }; };
      const r = await bastionOpenAccessClient(${JSON.stringify(TOKEN)}, ${assetExpr});
      return JSON.stringify({ r: r, alerts: window.__alerts, status: document.getElementById('toolbar-status').textContent });
    })()`));
    if (t2.r === false) ok('④ 拉起失败返回 false');
    else bad('④ 失败时返回值不对', JSON.stringify(t2.r));
    if (t2.alerts.length && /打开 H3C 客户端失败/.test(t2.alerts[0]) && /no handler registered/.test(t2.alerts[0])) ok('④ 失败提示说明原因,并让用户回堡垒机网页打开');
    else bad('④ 失败提示不对', JSON.stringify(t2.alerts));
    if (!/已交给/.test(t2.status)) ok('④ 失败时不冒充成功(状态栏不显示「已交给」)');
    else bad('④ 失败却显示成功', t2.status);

    // ---------- ⑤ 没装客户端:不请求 accessUrl,给可读提示 ----------
    const t3 = JSON.parse(await ev(c, `(async function(){
      state.h3cClient.installed = false;
      window.__alerts = [];
      window.alert = function (m) { window.__alerts.push(String(m)); };
      const n0 = (window.__bastionConnLog || []).length;
      bastionConnect(${assetExpr});
      const logs = (window.__bastionConnLog || []).slice(n0);
      const r = { alerts: window.__alerts, logs: logs };
      state.h3cClient.installed = true;
      return JSON.stringify(r);
    })()`));
    const skipLog = (t3.logs || []).filter((l) => l && l.ev === 'accessUrl-skip').length;
    if (skipLog >= 1) ok('⑤ 没装客户端 → 记 accessUrl-skip,不向堡垒机发请求');
    else bad('⑤ 没有 accessUrl-skip 日志', JSON.stringify(t3.logs));
    if (t3.alerts.length && /只能打开 SSH/.test(t3.alerts[0]) && /AccessClient/.test(t3.alerts[0])) ok('⑤ 提示说清「Polaris 只能开 SSH」+ 缺 AccessClient 的安装指引');
    else bad('⑤ 提示文案不对', JSON.stringify(t3.alerts));

    // ---------- ⑥ 主进程白名单:只放行 accessclient,且自定义 scheme 不经 URL 规范化 ----------
    const w1 = JSON.parse(await ev(c, `(async function(){ return JSON.stringify(await window.api.openExternal(${JSON.stringify(TOKEN)})); })()`));
    if (w1 && w1.ok === true && w1.skipped === true) ok('⑥ accessclient:// 被放行(测试钩子只返回 skipped,不起程序)');
    else bad('⑥ accessclient:// 被拒', JSON.stringify(w1));
    const w2 = JSON.parse(await ev(c, `(async function(){ return JSON.stringify(await window.api.openExternal('file:///etc/passwd')); })()`));
    if (w2 && w2.ok === false && /http\/https/.test(w2.error || '')) ok('⑥ file:// 仍被拒(白名单没被这版放宽)');
    else bad('⑥ file:// 被放行', JSON.stringify(w2));
    const w3 = JSON.parse(await ev(c, `(async function(){ return JSON.stringify(await window.api.openExternal('accessclient://bad token \\" & calc')); })()`));
    if (w3 && w3.ok === false) ok('⑥ 带空格/引号的 accessclient 地址被拒(防命令行注入)');
    else bad('⑥ 非法 accessclient 地址被放行', JSON.stringify(w3));
    const w4 = JSON.parse(await ev(c, `(async function(){ return JSON.stringify(await window.api.openExternal('https://example.com/x')); })()`));
    if (w4 && w4.ok === true && w4.skipped === true) ok('⑥ 普通 https 链接行为不变(回归)');
    else bad('⑥ https 行为被破坏', JSON.stringify(w4));
  } finally {
    /* 进程由 guardTimeout 的退出钩子收尾(killTree),这里不动端口,避免误杀自己 */
  }
})().then(() => {
  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  process.exit(failed ? 1 : 0);
}).catch((err) => {
  console.error('  ✗ 异常: ' + (err && err.message || err));
  process.exit(1);
});
