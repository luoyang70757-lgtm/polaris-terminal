'use strict';
/**
 * verify-bastion-clear.js — 回归:「清除历史」不得误删左侧堡垒机连接
 *
 * 背景:清除历史曾把 SQLite 捕获的 H3C 资产 + 已保存连接的资产缓存一并清掉,
 * 导致左侧「🌐 H3C 堡垒机」块整块消失、已保存连接的主机列表清空(用户视为"连接被删")。
 * v1.0.17 最终行为:清除历史清 webview 浏览器会话 + 缓存资产(state.bastionAssets),
 * 保留连接配置、连接登录态(token)与已保存 JMS 连接的资产缓存。
 *
 * 断言:
 *  ① 清除前左侧渲染出 已保存连接 + H3C 捕获块 + JMS 连接
 *  ② 清除后连接配置仍在(state.settings.bastionServers / state.jmsServers 数量不变)
 *  ③ 清除后缓存资产被清(state.bastionAssets=0);已保存 JMS 连接的 s.assets 不清空
 *  ④ 清除后连接登录态保留(token/user 不清,符合"不抹连接登录态")
 *
 * 运行: node verify-bastion-clear.js(--dev 临时数据目录)
 */
const { spawn } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-bclear-'));
const PORT = 9367;
const appProc = spawn('node_modules/.bin/electron', ['.', '--dev', `--remote-debugging-port=${PORT}`, '--no-sandbox', '--disable-gpu'], {
  env: { ...process.env, POLARIS_LOCK_DIR: DIR, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  stdio: ['ignore', 'ignore', 'ignore'], detached: true,
});
setTimeout(() => { try { process.kill(-appProc.pid, 'SIGKILL'); } catch {} process.exit(1); }, 120000).unref();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function listTargets() {
  for (let i = 0; i < 100; i++) { try { const r = await fetch(`http://127.0.0.1:${PORT}/json`); return await r.json(); } catch {} await sleep(400); }
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
async function ev(c, expr, tries = 3) {
  let r;
  for (let i = 0; i < tries; i++) {
    r = await c.call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r && !r.error) break;
    await sleep(300); // CDP 偶发返回 error(渲染忙)时重试
  }
  if (!r || r.error) throw new Error('CDP error ' + JSON.stringify(r && r.error) + ' @ ' + expr.slice(0, 120));
  if (r.exceptionDetails) throw new Error('JS异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 500) + ' @ ' + expr.slice(0, 120));
  return r.result && r.result.value;
}
let passed = 0, failed = 0;
const ok = (n, d) => { passed++; console.log('  ✓ ' + n + (d ? '  → ' + d : '')); };
const bad = (n, e) => { failed++; console.error('  ✗ ' + n + (e ? '  → ' + e : '')); };
async function check(c, name, expr, expect = true) {
  try { const v = await ev(c, expr); if (v === expect) ok(name, '=' + JSON.stringify(v)); else bad(name, 'got ' + JSON.stringify(v) + ' want ' + JSON.stringify(expect)); } catch (e) { bad(name, e.message); }
}

(async () => {
  console.log('\n=== 清除历史不得误删左侧堡垒机连接 ===\n');
  try {
    const ts0 = await listTargets();
    const lockT = ts0.find((t) => /解锁/.test(t.title || '')) || ts0.find((t) => t.type === 'page');
    if (!lockT) throw new Error('锁定页未就绪');
    const lock = await connect(lockT.webSocketDebuggerUrl);
    for (let i = 0; i < 40; i++) { if (await ev(lock, `!!document.getElementById('pw')`)) break; await sleep(300); }
    await ev(lock, `document.getElementById('pw').value='x1234567'; document.getElementById('pw2').value='x1234567'; document.getElementById('btn').click();`);
    let c = null;
    for (let i = 0; i < 80; i++) { await sleep(400); const t2 = await listTargets(); const m = t2.find((t) => t.type === 'page' && !/解锁/.test(t.title || '')); if (m) { c = await connect(m.webSocketDebuggerUrl); break; } }
    if (!c) throw new Error('主窗口未就绪');
    for (let i = 0; i < 30; i++) { if (await ev(c, `typeof renderSessionList === 'function'`)) break; await sleep(300); } // 渲染层就绪再动 state

    // 造数据:H3C 已保存连接(带资产缓存) + JumpServer API 连接 + H3C 捕获资产
    await ev(c, `(function(){
      state.settings.bastionServers = [{ id: 'h3c', name: '复现H3C', url: 'https://192.168.9.9', account: 'admin', password: 'enc:v1:fake', type: 'h3c', token: 'tok', user: 'admin', assetsExpanded: true }];
      state.jmsServers = [{ id: 'jms', name: '复现JMS', baseUrl: 'https://jms.example.com', account: 'admin', password: 'enc:v1:fake', token: 'tok', user: 'admin', assets: [{id:'a1',name:'JMS主机1',address:'10.0.0.2'}] }];
      state.jmsActiveId = 'jms';
      state.bastionAssets = [{devId:'h1',name:'H3C设备1',ip:'10.0.0.1',port:22,proto:'ssh',accounts:[],recentAccount:'',dir:'',dirPath:[],favorite:false}];
      state.collapsedBastionSaved = false; state.collapsedTopBastion = false; state.collapsedTopHost = false;
      saveSettings(); renderSessionList('');
      return true;
    })()`);
    await sleep(400);

    const dump = `(function(){ const e=document.getElementById('session-tree'); return e?e.innerText:''; })()`;
    const before = await ev(c, dump);
    ok('清除前左侧含 H3C 捕获块', before.includes('H3C 堡垒机'));
    ok('清除前左侧含已保存连接', before.includes('复现H3C'));
    ok('清除前左侧含 JMS 连接', before.includes('复现JMS'));

    // 覆盖 confirm,点击右侧「清除历史」
    await ev(c, `window.confirm = function(){ return true; }; document.getElementById('bastion-clear').click();`);
    await sleep(1500);

    const after = await ev(c, dump);
    if (!after.includes('H3C 堡垒机')) ok('① 清除后 H3C 捕获块已清(缓存资产清空,区块按设计隐藏)'); else bad('① 清除后 H3C 捕获块应已清', after.slice(0, 200));
    if (after.includes('复现H3C')) ok('① 清除后已保存连接仍在左侧'); else bad('① 清除后已保存连接仍在左侧', after.slice(0, 200));
    if (after.includes('复现JMS')) ok('① 清除后 JMS 连接仍在左侧'); else bad('① 清除后 JMS 连接仍在左侧', after.slice(0, 200));
    await check(c, '② 保存连接数量不变', `state.settings.bastionServers.length`, 1);
    await check(c, '② JMS 服务器数量不变', `state.jmsServers.length`, 1);
    await check(c, '③ 缓存 H3C 资产被清(重新捕获)', `state.bastionAssets.length`, 0);
    await check(c, '③ 已保存 JMS 连接资产缓存未清', `(function(){ const s=state.jmsServers[0]; return (s.assets||[]).length; })()`, 1);
    await check(c, '④ 已保存连接登录态保留(token)', `state.settings.bastionServers[0].token`, 'tok');
    await check(c, '④ 已保存连接 user 保留', `state.settings.bastionServers[0].user`, 'admin');

    // ---- H3C 已保存连接:展开不得调 JMS API(否则 H3C 地址拼出 JMS 登录接口 → 401) ----
    await ev(c, `(function(){
      state.settings.bastionServers = [{ id: 'h3c2', name: 'H3C生产', url: 'https://10.204.240.4/shterm', account: 'admin', password: 'enc:v1:fake', type: 'h3c', assetsExpanded: true }];
      saveSettings(); renderSessionList('');
      return true;
    })()`);
    await sleep(300);
    await check(c, 'H3C 连接展开后不报加载失败', `(function(){ const s=state.settings.bastionServers[0]; return !s.assetsLoadFailed; })()`, true);
    await check(c, 'H3C 连接展开后无 401 错误文案', `(function(){ const s=state.settings.bastionServers[0]; return !(s.assetsLoadError||'').includes('401'); })()`, true);
    const hint = await ev(c, `(function(){ const el=document.querySelector('.bastion-saved-assets'); return el ? el.innerText : ''; })()`);
    if (hint.includes('未捕获到资产')) ok('H3C 连接展开显示捕获提示文案'); else bad('H3C 连接展开显示捕获提示文案', hint.slice(0, 120));
    await check(c, 'isH3CSavedConn 识别 /shterm 站点', `(function(){ return isH3CSavedConn({type:'jms', url:'https://x/shterm/index'}) || isH3CSavedConn({type:'h3c'}); })()`, true);

    console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  } catch (e) { console.error('\n测试异常:', e && e.message); failed++; console.log(`\n结果: ${passed} 通过, ${failed} 失败`); }
  try { process.kill(-appProc.pid, 'SIGKILL'); } catch {}
  process.exit(failed ? 1 : 0);
})();
