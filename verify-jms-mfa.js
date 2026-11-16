'use strict';
/**
 * verify-jms-mfa.js — JumpServer 双因素(MFA/OTP)登录全链路
 *
 * mock 现在支持 mfa 账号(密码通过 → mfa_required → 提交 OTP → 才发 token),
 * 覆盖「正确密码但还没过 OTP」「OTP 错」「OTP 对」三条分支,以及登录后的资产拉取。
 *
 * 断言:
 *   ① jms:login(mfa 账号) → ok + mfaRequired + cookie + choices 含 otp + challengeUrl
 *   ② 错 OTP → ok:false 且错误信息可读(不能静默成功,也不能卡住)
 *   ③ 对 OTP(123456) → ok:true + token
 *   ④ 拿 token 拉资产 → 成功且数量正确(证明 MFA 后的 token 真能用)
 *   ⑤ 普通账号(admin)不触发 MFA(不受影响,没被这改动波及)
 *   ⑥ UI 路径:填表点登录 → OTP 输入框出现 → 填 OTP → 登录成功、资产进会话列表
 *
 * 运行: node verify-jms-mfa.js(需 9472 空闲;mock SSH 2242 / HTTP 8142)
 */
const { spawn } = require('child_process');
const { freePort, killTree, guardTimeout, evaluate } = require('./test-helper');
const fs = require('fs'); const os = require('os'); const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-jmsmfa-'));
const PORT = 9472, SSH = 2242, HTTP = 8142;
freePort(PORT); freePort(SSH); freePort(HTTP);
process.env.MOCK_SSH_PORT = String(SSH);
process.env.MOCK_HTTP_PORT = String(HTTP);
require('./mock/mock-server').start();

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
  console.log('\n=== JumpServer MFA(OTP)登录 ===');
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

    head('① 密码通过后进入 MFA 挑战');
    const login = JSON.parse(await ev(c, `(async()=>JSON.stringify(await window.api.jmsLogin(${JSON.stringify({ baseUrl: BASE, username: 'mfa', password: 'mfa123' })})))()`));
    if (login.ok && login.mfaRequired === true) ok('返回 mfaRequired(不是直接发 token)');
    else bad('未进入 MFA 分支', JSON.stringify(login).slice(0, 160));
    if (login.cookie && /mfa_sid=/.test(login.cookie)) ok(`握手带会话 cookie(${String(login.cookie).slice(0, 24)}…)`);
    else bad('缺 MFA 会话 cookie', JSON.stringify(login).slice(0, 160));
    if (Array.isArray(login.choices) && login.choices.includes('otp')) ok(`可选验证方式含 otp(${login.choices.join('/')})`);
    else bad('choices 不含 otp', JSON.stringify(login.choices));
    const challengeUrl = login.challengeUrl || '';
    if (/mfa\/challenge/.test(challengeUrl)) ok(`挑战地址正确(${challengeUrl})`);
    else bad('挑战地址不对', challengeUrl);

    head('② 错误的 OTP');
    const badOtp = JSON.parse(await ev(c, `(async()=>JSON.stringify(await window.api.jmsMfa(${JSON.stringify({
      baseUrl: BASE, cookie: login.cookie, challengeUrl, type: 'otp', code: '000000', username: 'mfa', password: 'mfa123',
    })})))()`));
    if (!badOtp.ok && /验证码错误|otp_invalid/i.test(badOtp.error || '')) ok(`错误 OTP 明确失败且可读:${badOtp.error}`);
    else bad('错误 OTP 未被拒绝(或错误信息不可读)', JSON.stringify(badOtp).slice(0, 200));

    head('③ 正确的 OTP(123456)');
    const goodOtp = JSON.parse(await ev(c, `(async()=>JSON.stringify(await window.api.jmsMfa(${JSON.stringify({
      baseUrl: BASE, cookie: login.cookie, challengeUrl, type: 'otp', code: '123456', username: 'mfa', password: 'mfa123',
    })})))()`));
    if (goodOtp.ok && goodOtp.token) ok('OTP 通过 → 拿到 token');
    else bad('OTP 通过后未拿到 token', JSON.stringify(goodOtp).slice(0, 200));

    head('④ MFA 后的 token 真能用');
    const assets = JSON.parse(await ev(c, `(async()=>JSON.stringify(await window.api.jmsAssets(${JSON.stringify({ baseUrl: BASE, token: goodOtp.token })})))()`));
    const n = (assets.assets || []).length;
    if (assets.ok && n === 3) ok(`拉取资产成功(${n} 台:${(assets.assets || []).map((a) => a.name).join(', ')})`);
    else bad('MFA 后资产拉取', JSON.stringify({ ok: assets.ok, n, err: assets.error }).slice(0, 200));

    head('⑤ 不需要 MFA 的账号不受影响');
    const plain = JSON.parse(await ev(c, `(async()=>JSON.stringify(await window.api.jmsLogin(${JSON.stringify({ baseUrl: BASE, username: 'admin', password: 'admin123' })})))()`));
    if (plain.ok && plain.token && !plain.mfaRequired) ok('admin 直接拿 token(没被 MFA 逻辑波及)');
    else bad('admin 登录异常', JSON.stringify(plain).slice(0, 160));

    head('⑥ UI 路径(填表 → OTP 框出现 → 填码 → 成功)');
    const ui = await ev(c, `(async()=>{
      // 打开新建堡垒机连接弹窗并切到 JumpServer 类型
      openBastionCfg && openBastionCfg();
      await new Promise((r) => setTimeout(r, 300));
      const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
      set('bastion-cfg-url', ${JSON.stringify(BASE)});
      set('jms-url', ${JSON.stringify(BASE)});
      set('jms-name', 'MFA测试');
      set('jms-ssh-host', '127.0.0.1');
      set('jms-ssh-port', '${SSH}');
      set('jms-user', 'mfa');
      set('jms-pass', 'mfa123');
      await jmsDoLogin();
      const otpShown = getComputedStyle(document.getElementById('jms-otp-wrap')).display !== 'none';
      document.getElementById('jms-otp').value = '123456';
      // 真实路径:登录按钮在 OTP 框可见时会走 jmsDoMfa()(而不是再跑一次密码登录)
      document.getElementById('jms-login').click();
      for (let i = 0; i < 30; i++) {
        const sv = state.jmsServers.find((x) => x.account === 'mfa');
        if (sv && sv.token && (sv.assets || []).length) break;
        await new Promise((r) => setTimeout(r, 300));
      }
      const server = state.jmsServers.find((x) => x.account === 'mfa') || {};
      const assets = (server.assets || []).map((a) => a.name);
      return JSON.stringify({ otpShown, loggedIn: !!server.token, assetCount: assets.length, assets });
    })()`, 60000);
    const u = JSON.parse(ui || '{}');
    if (u.otpShown) ok('密码通过后 UI 自动显示 OTP 输入框');
    else bad('UI 没显示 OTP 输入框', ui);
    if (u.loggedIn && u.assetCount === 3) ok(`填 OTP 后登录成功并拉到 ${u.assetCount} 台资产(${u.assets.join(', ')})`);
    else bad('UI 提交 OTP 后未登录成功', ui);

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
