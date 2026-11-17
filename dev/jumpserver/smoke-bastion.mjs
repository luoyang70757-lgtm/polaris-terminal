#!/usr/bin/env node
'use strict';
/**
 * dev/jumpserver/smoke-bastion.mjs — 用本地 Docker JumpServer 给「堡垒机」链路做冒烟自检
 *
 * 与 verify-*.js 的区别：那些跑 mock，这个跑**你机器上真实的那套 docker JumpServer**，
 * 用来在改堡垒机代码时快速确认「登录 → 资产 → KoKo 网关直连」整条链路还通。
 *
 * 做的事：
 *   1) 检查 http://127.0.0.1:8080/api/health/（docker 环境没起就直接报错退出）
 *   2) 建临时数据目录，预写 jms-servers.json（渲染层启动时自动静默重登）
 *   3) 起 Polaris（--dev，POLARIS_NO_MOCK=1，不抢 8080/2222）→ 解锁 → 等自动重登拉资产
 *   4) 断言资产 `dev-target-01` 在列表里 → 连它 → 断言终端里出现目标机 shell
 *
 * 用法：
 *   node dev/jumpserver/smoke-bastion.mjs            # 临时数据目录，跑完自动清
 *   node dev/jumpserver/smoke-bastion.mjs --keep     # 保留数据目录（排障用，会打印路径）
 *
 * 退出码：0 全绿；1 有断言失败或环境没起。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { resolveEndpoints } from './endpoints.mjs';

const require = createRequire(import.meta.url);
const H = require('../../test-helper.js');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');

const args = process.argv.slice(2);
const KEEP = args.includes('--keep');
// 地址/端口从运行中的 docker 容器解析（docker port jms_web 80 / jms_koko 2222），不写死 8080/2222
const EP = resolveEndpoints();
const BASE = EP.baseUrl;
const KOKO_PORT = EP.sshPort;
const DEBUG_PORT = 9475;

let passed = 0, failed = 0;
const DIALOGS = [];
const RUNTIME_ERRORS = []; // 渲染层未捕获异常 // 页面弹框记录（含「请先登录该 JumpServer」这类阻塞式 alert）
const ok = (n) => { passed++; console.log('  ✓ ' + n); };
const bad = (n, e) => { failed++; console.error('  ✗ ' + n + (e ? ' → ' + e : '')); };

// —— CDP 连接（与 verify-*.js 同一套用法）——
async function targets() {
  for (let i = 0; i < 60; i++) {
    try {
      const j = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`, { signal: AbortSignal.timeout(3000) })).json();
      if (j.find((t) => t.type === 'page' && /解锁|Polaris/.test(t.title || ''))) return j;
    } catch { /* 未就绪 */ }
    await H.sleep(400);
  }
  throw new Error('CDP target 未就绪');
}
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    const send = (m, p = {}) => { const mid = ++id; ws.send(JSON.stringify({ id: mid, method: m, params: p })); return new Promise((res) => pending.set(mid, res)); };
    ws.onopen = () => {
      send('Page.enable').catch(() => {});
      send('Runtime.enable').catch(() => {});
      resolve({
        call: (m, p = {}) => send(m, p),
        close() { ws.close(); },
      });
    };
    ws.onerror = reject;
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      // 页面里的 alert/confirm 会阻塞渲染进程（CDP evaluate 永远不返回）：自动关掉并记下来。
      // 「请先登录该 JumpServer」这类弹框本身就是要消灭的，留着它卡住整轮冒烟毫无意义。
      if (m.method === 'Page.javascriptDialogOpening') {
        DIALOGS.push(m.params.message || '(空弹框)');
        console.log('  ! 页面弹框(已自动关闭): ' + m.params.message);
        ws.send(JSON.stringify({ id: ++id, method: 'Page.handleJavaScriptDialog', params: { accept: true } }));
        return;
      }
      // 渲染层未捕获异常/console.error —— 异步调用（如 setTimeout 里跑 jmsConnect）出错的唯一线索
      if (m.method === 'Runtime.exceptionThrown') {
        const d = (m.params && m.params.exceptionDetails) || {};
        RUNTIME_ERRORS.push((d.exception && d.exception.description ? d.exception.description : d.text) || 'unknown');
        return;
      }
      if (m.method === 'Runtime.consoleAPICalled' && m.params && m.params.type === 'error') {
        RUNTIME_ERRORS.push((m.params.args || []).map((a) => a.value || a.description || '').join(' '));
        return;
      }
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
    };
  });
}
const ev = (c, expr) => H.evaluate(c, expr);
// 单次 evaluate 的看门狗：渲染进程被阻塞 / CDP 掉线时不会无限等下去
const evT = (c, expr, ms = 20000) => Promise.race([
  ev(c, expr),
  H.sleep(ms).then(() => { throw new Error(`CDP evaluate 超时(${ms}ms)：${String(expr).replace(/\s+/g, ' ').slice(0, 120)}`); }),
]);

const printResult = () => {
  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  if (failed) process.exitCode = 1;
};

(async () => {
  console.log('\n=== 真机冒烟：Docker JumpServer → Polaris 堡垒机链路 ===');

  // ① 环境前置
  let healthy = false;
  try { healthy = (await fetch(`${BASE}/api/health/`, { signal: AbortSignal.timeout(3000) })).ok; } catch { /* ignore */ }
  if (!healthy) {
    console.error(`  ✗ ${BASE} 不可用 —— 先起环境：node dev/jumpserver/setup.mjs`);
    failed++;
    printResult();
    return;
  }
  ok(`docker JumpServer 就绪 ${BASE}`);

  // ② 临时数据目录 + 预写连接配置
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-jms-smoke-'));
  fs.writeFileSync(path.join(dir, 'jms-servers.json'), JSON.stringify([{
    id: 'jms-docker-smoke',
    name: 'Docker JumpServer (smoke)',
    baseUrl: BASE,
    sshHost: '127.0.0.1',
    sshPort: Number(KOKO_PORT) || 2222,
    account: 'polaris',
    password: 'Polaris@123',
    loggedOut: false,
  }]));
  if (KEEP) console.log('  · 数据目录:', dir);

  // ③ 启动应用
  H.freePort(DEBUG_PORT);
  const app = spawn(require('electron'), ['.', '--dev', `--remote-debugging-port=${DEBUG_PORT}`, '--no-sandbox', '--disable-gpu'], {
    cwd: ROOT,
    env: {
      ...process.env,
      POLARIS_LOCK_DIR: dir,
      POLARIS_NO_MOCK: '1',
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
    detached: true,
  });
  let appErr = '';
  app.stderr.on('data', (d) => { appErr += d.toString(); if (appErr.length > 20000) appErr = appErr.slice(-20000); });
  let killedByUs = false;
  app.on('exit', (code) => { if (code && !killedByUs) console.error(`  ! Electron 意外退出 code=${code}`); });
  const NL = String.fromCharCode(10);
  const dumpAppErr = () => {
    const tail = appErr.trim().split(/\r?\n/).filter(Boolean).slice(-12).join(NL + '    ');
    if (tail) console.error('  ! Electron stderr(尾部):' + NL + '    ' + tail);
  };
  H.guardTimeout(180000, app, 'smoke-bastion');

  try {
    // ④ 解锁（临时目录 = 首次使用，走"设置密码"表单）
    const lockT = (await targets()).find((t) => /解锁/.test(t.title || ''));
    const lock = await connect(lockT.webSocketDebuggerUrl);
    for (let i = 0; i < 40; i++) { if (await ev(lock, `!!document.getElementById('pw')`)) break; await H.sleep(300); }
    await H.sleep(300);
    await ev(lock, `document.getElementById('pw').value='smoke1234'; document.getElementById('pw2').value='smoke1234'; document.getElementById('btn').click();`);
    let c = null;
    for (let i = 0; i < 40; i++) {
      await H.sleep(400);
      const m = (await targets()).find((t) => t.type === 'page' && !/解锁/.test(t.title || ''));
      if (m) { c = await connect(m.webSocketDebuggerUrl); break; }
    }
    if (!c) throw new Error('解锁后主窗口未出现');
    for (let i = 0; i < 40; i++) { if (await ev(c, `typeof state !== 'undefined' && !!state.jmsServers`)) break; await H.sleep(300); }
    ok('应用启动并解锁');

    // ⑤ 等自动重登（jmsRestore：文件配置 → jmsLogin → jmsAssets）
    let srv = null;
    for (let i = 0; i < 60; i++) {
      srv = JSON.parse(await ev(c, `(function(){const s=(state.jmsServers||[])[0];return JSON.stringify(s?{id:s.id,token:!!s.token,user:!!s.user,assets:(s.assets||[]).length,err:s.err||null}:null);})()`));
      if (srv && srv.token && srv.user && srv.assets > 0) break;
      await H.sleep(500);
    }
    if (srv && srv.token) ok('从 jms-servers.json 恢复配置并静默重登成功');
    else bad('自动重登', JSON.stringify(srv));
    if (srv && srv.assets === 3) ok(`拉到资产 ${srv.assets} 台（种子数据 3 台）`);
    else bad('资产拉取（应为 3 台）', JSON.stringify(srv));

    const asset = JSON.parse(await ev(c, `(function(){const a=(state.jmsServers[0].assets||[])[0];return JSON.stringify(a?{name:a.name,address:a.address,protocols:(a.protocols||[]).map(p=>p.name),accounts:(a.accounts||[]).map(x=>x.username)}:null);})()`));
    if (asset && asset.name === 'dev-target-01') ok(`资产字段正确:${asset.name} · ${asset.address} · 协议 ${asset.protocols.join('/')} · 账号 ${asset.accounts.join('/')}`);
    else bad('资产字段', JSON.stringify(asset));

    // 权限隔离：另一个账号只被授权 dev-target-02（种子数据里 polaris-ro → 1 台）
    const iso = JSON.parse(await ev(c, `(async()=>{
      const r = await window.api.jmsLogin({ baseUrl: ${JSON.stringify(BASE)}, username: 'polaris-ro', password: 'Polaris@123' });
      if (!r.ok) return JSON.stringify({ ok: false, err: r.error });
      const a = await window.api.jmsAssets({ baseUrl: ${JSON.stringify(BASE)}, token: r.token });
      return JSON.stringify({ ok: true, names: (a.assets || []).map((x) => x.name) });
    })()`));
    if (iso.ok && iso.names.length === 1 && iso.names[0] === 'dev-target-02') ok('权限隔离生效：polaris-ro 只看到 dev-target-02');
    else bad('权限隔离', JSON.stringify(iso));

    // 会话列表：展开「🛡 堡垒机」下的服务器 + 节点分组，应渲染出 3 条资产行。
    // 注意 state.bastionDirCollapsed：登录成功后 collapseJmsGroupsState() 会把节点分组
    // （JumpServer 资产默认挂在 DEFAULT 节点下）全部折叠，不展开就一条资产行都看不到。
    const rows = JSON.parse(await ev(c, `(async()=>{
      state.collapsedTopBastion = false;
      state.collapsedJms.delete(state.jmsServers[0].id);
      state.bastionDirCollapsed.clear();
      renderSessionList('');
      await new Promise((r) => setTimeout(r, 300));
      return JSON.stringify([...document.querySelectorAll('.jms-asset-item')].map((el) => (el.textContent || '').trim()));
    })()`));
    const wanted = ['dev-target-01', 'dev-target-02', 'dev-target-03'];
    if (rows.length >= 3 && wanted.every((n) => rows.some((t) => t.includes(n)))) ok(`会话列表渲染出 ${rows.length} 条资产行（01/02/03 都在）`);
    else bad('会话列表渲染', JSON.stringify(rows).slice(0, 300));

    // ⑥ 连资产（复合用户名经 KoKo 网关）
    await ev(c, `state.settings.autoTrustHostKey = true; saveSettings && saveSettings(); true`);
    const sid = await ev(c, `(async()=>{ jmsConnect(state.jmsServers[0].id, state.jmsServers[0].assets[0]); await new Promise(r=>setTimeout(r,500)); const id=[...state.tabs.keys()].pop(); try { activateTab(id); } catch {} return id; })()`);
    let status = '', buf = '';
    for (let i = 0; i < 60; i++) {
      status = await ev(c, `(function(){const t=state.tabs.get('${sid}');return t?t.status:'';})()`);
      if (status === 'connected') break;
      await H.sleep(500);
    }
    if (status === 'connected') ok('经 KoKo 网关连上资产(tab=connected)');
    else bad('连接状态', status);

    // 连接后渲染层会跑「字符集探针」并清屏(initMask),banner 不会留在 buffer 里 ——
    // 先把探针等完(否则清屏会把我们的回显擦掉),再往会话里打标记命令、断言回显。
    for (let i = 0; i < 80; i++) {
      const masked = await ev(c, `(function(){const t=state.tabs.get('${sid}');return t?!!t.initMask:true;})()`);
      if (!masked) break;
      await H.sleep(300);
    }
    await H.sleep(600);
    for (let round = 0; round < 3; round++) {
      await ev(c, `window.api.sshWrite('${sid}', 'echo POLARIS_SMOKE_OK; hostname\\r')`);
      for (let i = 0; i < 12; i++) {
        buf = await ev(c, `(function(){const t=state.tabs.get('${sid}'); if(!t||!t.term) return ''; const b=t.term.buffer.active; let s=''; for(let i=Math.max(0,b.length-40);i<b.length;i++){const l=b.getLine(i); if(l) s+=l.translateToString(true)+'\\n';} return s;})()`);
        if (/POLARIS_SMOKE_OK/.test(buf)) break;
        await H.sleep(400);
      }
      if (/POLARIS_SMOKE_OK/.test(buf)) break;
    }
    if (/POLARIS_SMOKE_OK/.test(buf)) ok('在目标机上执行命令并拿到回显(shell 真的可用)');
    else bad('命令回显', JSON.stringify(buf.slice(-120)));
    if (/target/.test(buf)) ok('回显里出现目标机主机名 target');
    else bad('目标机主机名未出现', JSON.stringify(buf.slice(-160)));

    // 断开连接（manualDisconnect 不应触发自动重连）
    const off = await ev(c, `(async()=>{ jmsDisconnectAsset(state.jmsServers[0].id, state.jmsServers[0].assets[0]); await new Promise(r=>setTimeout(r,1500)); const t=state.tabs.get('${sid}'); return t?t.status:'gone'; })()`);
    if (off !== 'connected') ok(`断开连接生效（tab 状态 ${off}）`);
    else bad('断开连接未生效');

    // ⑦ 批量连接：3 台一次开起来（同一 KoKo 网关，300ms 错峰）
    console.log('  · 步骤 ⑦ 批量连接 …');
    const pre = JSON.parse(await evT(c, `(async()=>{
      const s = state.jmsServers[0];
      const before = { assets: (s.assets || []).length, token: !!s.token, user: !!s.user, loggedOut: !!s.loggedOut };
      const okLogin = await ensureJmsLogin(s);
      batchJmsConnect(s, s.assets);
      return JSON.stringify({ before, okLogin, after: { assets: (s.assets || []).length, token: !!s.token } });
    })()`));
    console.log('  · 批量连接前置:', JSON.stringify(pre));
    let batch = null;
    for (let i = 0; i < 60; i++) {
      batch = JSON.parse(await ev(c, `(function(){
        const sid = state.jmsServers[0].id;
        const all = [...state.tabs.values()].filter((t) => t.session && t.session.jmsKey
          && t.session.jmsKey.startsWith(sid + '|'));
        const tabs = all.filter((t) => t.status === 'connected');
        return JSON.stringify({ n: tabs.length, hosts: tabs.map((t) => t.session.displayHost), users: tabs.map((t) => t.session.username),
          allStatus: all.map((t) => t.session.displayHost + ':' + t.status) });
      })()`));
      if (batch && batch.n >= 3) break;
      if (i % 5 === 0) console.log(`  · 批量连接进度 ${batch ? batch.n : '?'}/3（${(batch && (batch.allStatus || []).join(', ')) || ''}）`);
      await H.sleep(700);
    }
    if (batch && batch.n === 3) ok(`批量连接 3 台全部 connected（${(batch.hosts || []).join(', ')}）`);
    else bad('批量连接（应为 3 条 connected 标签）', JSON.stringify(batch));
    if (batch && new Set(batch.users || []).size === 3) ok('复合用户名按资产地址区分（3 个互不相同）');
    else bad('复合用户名去重', JSON.stringify(batch && batch.users));

    // ⑧ 搜索过滤：按资产名/地址搜，未命中的资产不渲染
    console.log('  · 步骤 ⑧ 搜索过滤 …');
    const searchRows = JSON.parse(await ev(c, `(async()=>{
      renderSessionList('target-03');
      await new Promise((r) => setTimeout(r, 200));
      const rows = [...document.querySelectorAll('.jms-asset-item')].map((el) => (el.textContent || '').trim());
      renderSessionList('');
      return JSON.stringify(rows);
    })()`));
    if (searchRows.length === 1 && searchRows[0].includes('dev-target-03')) ok('资产搜索生效（搜 target-03 只剩 1 条）');
    else bad('资产搜索', JSON.stringify(searchRows).slice(0, 200));

    // ⑨ token 过期（JumpServer token 默认 24h）→ 双击资产必须能自己登上去，
    //    历史行为是直接弹「请先登录该 JumpServer」（用户视角：凭什么让我再登一次）
    const expiry = JSON.parse(await evT(c, `(async()=>{
      const s = state.jmsServers[0];
      s.token = null; s.user = null; s.loggedOut = false;   // 模拟第二天再来：token 已过期
      const beforeIds = new Set(state.tabs.keys());
      const relogged = await ensureJmsLogin(s);
      await jmsConnect(s.id, s.assets[0]);                  // 内部还会再 ensure 一次，应直接放行
      let status = "";
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 400));
        const t = [...state.tabs.values()].find((x) => !beforeIds.has(x.sessionId));
        if (t) status = t.status;
        if (status === "connected") break;
      }
      return JSON.stringify({ relogged, hasToken: !!s.token, hasUser: !!s.user, newTabs: state.tabs.size - beforeIds.size, status });
    })()`, 60000));
    if (expiry.relogged && expiry.hasToken && expiry.hasUser) ok('token 过期后自动重登成功（无需手动登录）');
    else bad('token 过期自动重登', JSON.stringify(expiry));
    if (expiry.status === 'connected') ok('自动重登后直接连上资产（新标签 connected）');
    else bad('自动重登后连接', JSON.stringify(expiry));

    // ⑩ 刷新资产时 token 失效 → 强制重登再拉（不能静默失败，也不许把密文当密码发出去）
    const refresh = JSON.parse(await evT(c, `(async()=>{
      const s = state.jmsServers[0];
      s.token = 'invalid-token-for-test';
      await jmsRefreshServer(s.id);
      await new Promise((r) => setTimeout(r, 300));
      return JSON.stringify({ assets: (s.assets || []).length, tokenRefreshed: !!s.token && s.token !== "invalid-token-for-test" });
    })()`, 60000));
    if (refresh.tokenRefreshed && refresh.assets === 3) ok('刷新资产遇到失效 token → 强制重登并重新拉到 3 台');
    else bad('刷新强制重登', JSON.stringify(refresh));

    // 整轮不应出现阻塞式弹框（尤其「请先登录该 JumpServer」——已改为自动重登）
    if (!DIALOGS.length) ok('全程无阻塞弹框（含「请先登录该 JumpServer」）');
    else bad('出现页面弹框: ' + JSON.stringify(DIALOGS).slice(0, 200));
    if (!RUNTIME_ERRORS.length) ok('渲染层无未捕获异常');
    else bad('渲染层未捕获异常: ' + JSON.stringify(RUNTIME_ERRORS).slice(0, 400));

    const tail = buf.trim().split('\n').filter(Boolean).slice(-3).join(' | ');
    if (tail) console.log('  · 终端末尾:', tail.slice(0, 200));
  } catch (e) {
    dumpAppErr();
    throw e;
  } finally {
    killedByUs = true;
    H.killTree(app);
    if (!KEEP) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 占用则忽略 */ } }
    else console.log('  · 数据目录保留:', dir);
    printResult();
  }
})().catch((e) => {
  console.error('✗ 冒烟失败:', e.message);
  printResult();
  process.exit(1);
});
