'use strict';
/**
 * verify-jms.js — JumpServer 对接链路回归(此前这条线没有独立用例)
 *
 * 覆盖面:
 *   ① jms:login:正确账号 → token + user;错误密码 → 明确失败(不冒充成功)
 *   ② jms:assets:拉取当前用户可见资产(admin 3 台 / ops 2 台,权限隔离生效)
 *   ③ 复合用户名经 KoKo 网关直连资产:JMS用户@ssh@账号@资产IP,连上后会话字段正确
 *   ④ jms:persist / jms:restore:连接配置落盘(数据目录 jms-servers.json)并能读回
 *   ⑤ 渲染层入口:JMS 服务器在会话列表「🛡 堡垒机」下渲染(未登录也给入口)
 *   ⑥ 登录态校验:token 无效时 jms:assets 失败而不是返回空列表(不能"假成功")
 *
 * 运行: node verify-jms.js(需 9471 空闲;mock SSH 2241 / HTTP 8141)
 */
const { spawn } = require('child_process');
const { freePort, killTree, guardTimeout, evaluate } = require('./test-helper');
const fs = require('fs'); const os = require('os'); const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-jms-'));
const PORT = 9471, SSH = 2241, HTTP = 8141;
freePort(PORT); freePort(SSH); freePort(HTTP);
process.env.MOCK_SSH_PORT = String(SSH);
process.env.MOCK_HTTP_PORT = String(HTTP);
const { start } = require('./mock/mock-server');
start();

const appProc = spawn(require('electron'), ['.', '--dev', `--remote-debugging-port=${PORT}`, '--no-sandbox', '--disable-gpu'], {
  env: { ...process.env, POLARIS_LOCK_DIR: DIR, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  stdio: ['ignore', 'ignore', 'ignore'], detached: true,
});
guardTimeout(180000, appProc);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function targets() {
  for (let i = 0; i < 60; i++) {
    try {
      const j = await (await fetch(`http://127.0.0.1:${PORT}/json`, { signal: AbortSignal.timeout(3000) })).json();
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
const ev = (c, expr, t) => evaluate(c, expr, t);

let passed = 0, failed = 0;
const ok = (n) => { passed++; console.log('  ✓ ' + n); };
const bad = (n, e) => { failed++; console.error('  ✗ ' + n + (e ? ' → ' + e : '')); };
const head = (t) => console.log(`\n— ${t} —`);

(async () => {
  console.log('\n=== JumpServer(JMS)对接链路 ===');
  try {
    const lockT = (await targets()).find((t) => /解锁/.test(t.title || ''));
    const lock = await connect(lockT.webSocketDebuggerUrl);
    for (let i = 0; i < 40; i++) { if (await ev(lock, `!!document.getElementById('pw')`)) break; await sleep(300); }
    await sleep(300);
    await ev(lock, `document.getElementById('pw').value='x12345678'; document.getElementById('pw2').value='x12345678'; document.getElementById('btn').click();`);
    let c = null;
    for (let i = 0; i < 40; i++) {
      await sleep(400);
      const m = (await targets()).find((t) => t.type === 'page' && !/解锁/.test(t.title || ''));
      if (m) { c = await connect(m.webSocketDebuggerUrl); break; }
    }
    if (!c) throw new Error('解锁后主窗口未出现');
    for (let i = 0; i < 40; i++) { if (await ev(c, `typeof window.api.jmsLogin === 'function'`)) break; await sleep(300); }
    const BASE = `http://127.0.0.1:${HTTP}`;

    head('① 登录');
    const login = JSON.parse(await ev(c, `(async()=>JSON.stringify(await window.api.jmsLogin(${JSON.stringify({ baseUrl: BASE, username: 'admin', password: 'admin123' })})))()`));
    if (login.ok && login.token) ok(`admin 登录成功(拿到 token,user=${login.user && (login.user.name || login.user.username)})`);
    else bad('admin 登录', JSON.stringify(login).slice(0, 160));
    const badLogin = JSON.parse(await ev(c, `(async()=>JSON.stringify(await window.api.jmsLogin(${JSON.stringify({ baseUrl: BASE, username: 'admin', password: 'wrong-pass' })})))()`));
    if (!badLogin.ok) ok('错误密码明确失败(不冒充成功)');
    else bad('错误密码竟然登录成功', JSON.stringify(badLogin).slice(0, 160));
    const opsLogin = JSON.parse(await ev(c, `(async()=>JSON.stringify(await window.api.jmsLogin(${JSON.stringify({ baseUrl: BASE, username: 'ops', password: 'ops123' })})))()`));
    if (opsLogin.ok && opsLogin.token) ok('普通用户 ops 登录成功');
    else bad('ops 登录', JSON.stringify(opsLogin).slice(0, 160));

    head('② 资产拉取(含权限隔离)');
    const adminAssets = JSON.parse(await ev(c, `(async()=>JSON.stringify(await window.api.jmsAssets(${JSON.stringify({ baseUrl: BASE, token: login.token })})))()`));
    const aList = (adminAssets.assets || []);
    if (adminAssets.ok && aList.length === 3) ok(`admin 拉到 3 台资产:${aList.map((x) => x.name).join(', ')}`);
    else bad('admin 资产数量', JSON.stringify({ ok: adminAssets.ok, n: aList.length, err: adminAssets.error }).slice(0, 160));
    const first = aList[0] || {};
    if (first.name && first.address && Array.isArray(first.accounts) && first.accounts.length) ok(`资产字段完整(名称/地址/账号):${first.name} · ${first.address} · ${first.accounts.map((x) => x.username).join('/')}`);
    else bad('资产字段缺失', JSON.stringify(first).slice(0, 160));
    const opsAssets = JSON.parse(await ev(c, `(async()=>JSON.stringify(await window.api.jmsAssets(${JSON.stringify({ baseUrl: BASE, token: opsLogin.token })})))()`));
    if (opsAssets.ok && (opsAssets.assets || []).length === 2) ok('ops 只看到 2 台(权限隔离生效)');
    else bad('ops 资产数量', JSON.stringify({ ok: opsAssets.ok, n: (opsAssets.assets || []).length }).slice(0, 160));
    const badToken = JSON.parse(await ev(c, `(async()=>JSON.stringify(await window.api.jmsAssets(${JSON.stringify({ baseUrl: BASE, token: 'invalid-token' })})))()`));
    if (!badToken.ok) ok('token 无效 → 明确失败(不返回空列表假装成功)');
    else bad('无效 token 被当成成功', JSON.stringify(badToken).slice(0, 160));

    head('③ 复合用户名经 KoKo 网关直连资产');
    await ev(c, `state.settings.verifyHostKey = false; state.settings.autoTrustHostKey = true; saveSettings(); true`);
    const asset = aList[0] || {};
    const acct = (asset.accounts && asset.accounts[0] && asset.accounts[0].username) || 'root';
    const sid = await ev(c, `(async()=>{
      const server = {
        id: 'jms-server-test', name: 'MockJMS', baseUrl: ${JSON.stringify(BASE)},
        sshHost: '127.0.0.1', sshPort: ${SSH}, account: 'admin', password: 'admin123', token: ${JSON.stringify(login.token)},
        user: ${JSON.stringify(login.user || null)},
        assets: [{ id: ${JSON.stringify(String(asset.id))}, name: ${JSON.stringify(String(asset.name))}, address: ${JSON.stringify(String(asset.address))},
                   accounts: [{ username: ${JSON.stringify(String(acct))} }] }],
      };
      state.jmsServers = [server];
      state.jmsActiveId = server.id;
      await connectToServer({
        name: server.assets[0].name, host: server.sshHost, port: server.sshPort,
        username: 'admin@ssh@' + ${JSON.stringify(String(acct))} + '@' + server.assets[0].address,
        password: 'admin123', protocol: 'ssh',
        displayHost: server.assets[0].address, bastionKey: 'jms-' + server.assets[0].id,
      });
      for (let i = 0; i < 60; i++) {
        const t = [...state.tabs.values()].find((x) => x.status === 'connected');
        if (t) return JSON.stringify({ sid: t.sessionId, name: t.session.name, user: t.session.username, displayHost: t.session.displayHost, bastionKey: t.session.bastionKey, port: t.session.port });
        await new Promise((r) => setTimeout(r, 300));
      }
      return 'NOTCONNECTED';
    })()`, 45000);
    if (sid && sid !== 'NOTCONNECTED' && sid !== 'TIMEOUT') {
      const j = JSON.parse(sid);
      if (/^admin@ssh@.+@/.test(j.user)) ok(`复合用户名直连成功:${j.user}`);
      else bad('复合用户名格式不对', j.user);
      if (j.displayHost === asset.address) ok(`会话展示用的是资产地址(${j.displayHost})而不是网关 127.0.0.1`);
      else bad('displayHost 不对', j.displayHost);
      if (j.bastionKey === 'jms-' + asset.id) ok(`资产标识正确(${j.bastionKey})`);
      else bad('bastionKey 不对', j.bastionKey);
    } else {
      bad('复合用户名连接网关失败', String(sid));
    }

    head('④ 配置落盘 / 恢复');
    const persist = JSON.parse(await ev(c, `(async()=>JSON.stringify(await window.api.jmsPersist([{ id:'jms-1', name:'落盘测试', baseUrl:${JSON.stringify(BASE)}, sshHost:'127.0.0.1', sshPort:${SSH}, account:'admin' }])))()`));
    const cfgFile = path.join(DIR, 'jms-servers.json');
    const onDisk = (() => { try { return JSON.parse(fs.readFileSync(cfgFile, 'utf8')); } catch { return null; } })();
    if (onDisk && onDisk.length === 1 && onDisk[0].name === '落盘测试') ok(`连接配置已落盘(${path.basename(cfgFile)},名称与端口保留)`);
    else bad('连接配置未落盘', JSON.stringify({ persist, onDisk }).slice(0, 200));
    const restored = JSON.parse(await ev(c, `(async()=>JSON.stringify(await window.api.jmsRestore()))()`));
    const rList = restored.servers || restored.list || [];
    if (Array.isArray(rList) && rList.some((x) => x.name === '落盘测试')) ok('jms:restore 能读回同一份配置');
    else bad('恢复失败', JSON.stringify(restored).slice(0, 200));

    head('⑤ 会话列表入口(未登录也可见)');
    const entry = await ev(c, `(async()=>{
      state.jmsServers = [{ id:'jms-1', name:'落盘测试', baseUrl:${JSON.stringify(BASE)}, sshHost:'127.0.0.1', sshPort:${SSH}, account:'admin', assets: [] }];
      state.collapsedTopBastion = false;
      renderSessionList('');
      const heads = [...document.querySelectorAll('.asset-group-head, .asset-item')].map((el) => el.textContent || '');
      return JSON.stringify({ hasServer: heads.some((t) => t.includes('落盘测试')), hasBastionGroup: heads.some((t) => t.includes('堡垒机')) });
    })()`);
    const eJ = JSON.parse(entry);
    if (eJ.hasBastionGroup) ok('「🛡 堡垒机」分组存在');
    else bad('堡垒机分组缺失');
    if (eJ.hasServer) ok('未登录的 JMS 服务器也显示在列表里(可右键编辑/登录)');
    else bad('JMS 服务器未显示', entry);

    console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  } catch (e) {
    console.error('\n测试异常:', e && e.message);
    failed++;
    console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  }
  try { killTree(appProc); } catch { /* ignore */ }
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(failed ? 1 : 0);
})();
