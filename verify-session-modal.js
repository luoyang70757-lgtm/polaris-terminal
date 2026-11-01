'use strict';
/**
 * verify-session-modal.js — 新建/编辑会话弹窗:只显示必要字段,其余收进「高级选项」
 *
 * 背景:原弹窗把 协议/私钥/私钥口令/跳板机/编码/登录宏 全平铺在最上面,
 * 一屏放不下(保存按钮要滚动才能看到),新用户第一眼看到的是私钥和口令。
 *
 * 断言:
 *   ① 默认只显示 名称 / 主机 / 端口 / 用户名 / 密码 / 分组 / 测试连接,高级区折叠;
 *   ② 保存/取消按钮在弹窗可视区内(不用滚动就能点);
 *   ③ 高级区展开后 协议/私钥/私钥口令/跳板机/编码/登录宏 都在,且能被操作;
 *   ④ 编辑带高级设置的会话时自动展开高级区(否则改了半天看不到自己配的私钥/编码);
 *   ⑤ 协议切 telnet → 隐藏 SSH 专属字段、端口自动 23(原有行为不回归);
 *   ⑥ 字段顺序:名称在主机前,高级选项在分组之后(符合填写习惯)。
 *
 * 运行:node verify-session-modal.js
 */
const { spawn } = require('child_process');
const { freePort, killTree, guardTimeout, evaluate } = require('./test-helper');
const fs = require('fs'); const os = require('os'); const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-sessmodal-'));
const PORT = 9458, SSH = 2288, HTTP = 2388;
freePort(PORT); freePort(SSH); freePort(HTTP);
process.env.MOCK_SSH_PORT = String(SSH);
process.env.MOCK_HTTP_PORT = String(HTTP);
require('./mock/mock-server').start();

const appProc = spawn(require('electron'), ['.', '--dev', `--remote-debugging-port=${PORT}`, '--no-sandbox', '--disable-gpu'], {
  env: { ...process.env, POLARIS_LOCK_DIR: DIR, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  stdio: ['ignore', 'ignore', 'ignore'], detached: true,
});
guardTimeout(150000, appProc);
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
const ev = (c, expr) => evaluate(c, expr);

let passed = 0, failed = 0;
const ok = (n) => { passed++; console.log('  ✓ ' + n); };
const bad = (n, e) => { failed++; console.error('  ✗ ' + n + (e ? ' → ' + e : '')); };
const head = (t) => console.log(`\n— ${t} —`);

(async () => {
  console.log('\n=== 新建会话弹窗(必要字段优先)===');
  try {
    const lockT = (await targets()).find((t) => /解锁/.test(t.title || ''));
    const lock = await connect(lockT.webSocketDebuggerUrl);
    for (let i = 0; i < 40; i++) { if (await ev(lock, `!!document.getElementById('pw')`)) break; await sleep(300); }
    await sleep(300);
    await ev(lock, `document.getElementById('pw').value='x1234567'; document.getElementById('pw2').value='x1234567'; document.getElementById('btn').click();`);
    let c = null;
    for (let i = 0; i < 40; i++) {
      await sleep(400);
      const m = (await targets()).find((t) => t.type === 'page' && !/解锁/.test(t.title || ''));
      if (m) { c = await connect(m.webSocketDebuggerUrl); break; }
    }
    if (!c) throw new Error('解锁后主窗口未出现');
    for (let i = 0; i < 50; i++) { if (await ev(c, `typeof state === 'object' && !!state.settings`)) break; await sleep(200); }

    const info = `(function () {
      var modal = document.getElementById('session-modal');
      var adv = document.getElementById('session-advanced');
      // 注意:Chromium 新版 <details> 用 ::details-content(content-visibility) 收起内容,
      // 收起时子元素的 getBoundingClientRect 仍是非零 → 必须用 checkVisibility() 判断真正可见
      var vis = function (id) {
        var el = document.getElementById(id);
        if (!el) return null;
        if (typeof el.checkVisibility === 'function') return el.checkVisibility({ contentVisibilityAuto: true });
        var r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      var order = function (a, b) {
        var ea = document.getElementById(a), eb = document.getElementById(b);
        if (!ea || !eb) return null;
        return !!(ea.compareDocumentPosition(eb) & Node.DOCUMENT_POSITION_FOLLOWING);
      };
      var save = document.getElementById('modal-save').getBoundingClientRect();
      var card = modal.querySelector('.modal-card').getBoundingClientRect();
      var view = { top: 0, bottom: innerHeight };
      return {
        open: !modal.classList.contains('hidden'),
        advOpen: !!(adv && adv.open),
        core: {
          name: vis('f-name'), host: vis('f-host'), port: vis('f-port'), username: vis('f-username'),
          password: vis('f-password'), group: vis('f-group'), testConn: vis('f-test-conn'),
        },
        advVisible: {
          protocol: vis('f-protocol'), key: vis('f-private-key'), passphrase: vis('f-passphrase'),
          encoding: vis('f-encoding'), onConnect: vis('f-on-connect'), jump: vis('f-jump-host'),
        },
        saveInView: save.bottom <= view.bottom + 1 && save.top >= view.top,
        cardInView: card.bottom <= view.bottom + 1,
        orderNameBeforeHost: order('f-name', 'f-host'),
        orderHostBeforeAdv: order('f-host', 'f-port') && order('f-group', 'modal-save'),
        portValue: document.getElementById('f-port').value,
        sshOnlyHidden: document.getElementById('f-ssh-only').classList.contains('hidden'),
        advBoxH: Math.round(document.getElementById('session-advanced').getBoundingClientRect().height),
      };
    })()`;

    head('① 默认视图(新建)');
    await ev(c, `(function(){ openSessionModal(null); return true; })()`);
    await sleep(500);
    const d = await ev(c, info);
    if (d.open) ok('弹窗已打开');
    else bad('弹窗没打开', JSON.stringify(d));
    const coreAll = Object.values(d.core).every(Boolean);
    if (coreAll) ok('必要字段全部可见:名称 / 主机 / 端口 / 用户名 / 密码 / 分组 / 测试连接');
    else bad('必要字段缺失', JSON.stringify(d.core));
    if (!d.advOpen) ok('「高级选项」默认折叠');
    else bad('高级选项默认就是展开的', JSON.stringify({ advOpen: d.advOpen }));
    const advHidden = Object.values(d.advVisible).every((v) => v === false);
    if (advHidden) ok('折叠时 协议 / 私钥 / 私钥口令 / 编码 / 登录宏 / 跳板机 都不可见');
    else bad('折叠时仍有高级字段露出来', JSON.stringify(d.advVisible));
    if (d.advBoxH < 60) ok(`折叠时高级区只占一行标题(高 ${d.advBoxH}px)`);
    else bad('折叠时高级区仍然很高', d.advBoxH);
    if (d.saveInView && d.cardInView) ok('保存/取消按钮与整个弹窗都在可视区内(无需滚动)');
    else bad('弹窗超出视口,需要滚动才能点保存', JSON.stringify({ saveInView: d.saveInView, cardInView: d.cardInView }));
    if (d.orderNameBeforeHost && d.orderHostBeforeAdv) ok('字段顺序:名称 → 主机 → … → 分组 → 高级选项 → 保存');
    else bad('字段顺序不符合填写习惯', JSON.stringify(d));

    head('② 展开「高级选项」');
    await ev(c, `(function(){ document.getElementById('session-advanced').open = true; return true; })()`);
    await sleep(400);
    const adv = await ev(c, info);
    const advTop = ['protocol', 'key', 'passphrase', 'encoding', 'onConnect'].every((k) => adv.advVisible[k] === true);
    if (advTop) ok('展开后 协议 / 私钥 / 私钥口令 / 编码 / 登录宏 全部可见可用');
    else bad('高级字段没展开全', JSON.stringify(adv.advVisible));
    // 跳板机是第二层折叠:展开它才出现主机/端口/账号/密码
    await ev(c, `(function(){ document.querySelector('#session-advanced .jump-field').open = true; return true; })()`);
    await sleep(300);
    const jumpOpen = await ev(c, info);
    if (jumpOpen.advVisible.jump === true) ok('再展开「跳板机」→ 跳板主机等字段出现');
    else bad('跳板机展开后字段仍不可见', JSON.stringify(jumpOpen.advVisible));

    head('③ 协议切 telnet(原有行为不回归)');
    await ev(c, `(function(){ var p = document.getElementById('f-protocol'); p.value = 'telnet'; p.dispatchEvent(new Event('change')); return true; })()`);
    await sleep(300);
    const tel = await ev(c, info);
    if (tel.sshOnlyHidden) ok('切 Telnet → 私钥/口令/跳板机整块隐藏');
    else bad('切 Telnet 没隐藏 SSH 专属字段', JSON.stringify(tel));
    if (String(tel.portValue) === '23') ok('切 Telnet → 端口自动改 23');
    else bad('切 Telnet 端口没跟着改', tel.portValue);
    await ev(c, `(function(){ var p = document.getElementById('f-protocol'); p.value = 'ssh'; p.dispatchEvent(new Event('change')); return true; })()`);
    await sleep(200);

    head('④ 编辑带高级设置的会话时自动展开');
    const autoOpen = await ev(c, `(async () => {
      closeSessionModal();
      const g = state.groups.length ? state.groups[0] : null;
      const r = await window.api.createSession({
        name: 'advanced-01', host: '10.1.2.3', port: 22, username: 'root', password: 'x',
        groupId: g ? g.id : undefined, privateKey: '/tmp/id_rsa', encoding: 'gbk',
      });
      await loadSessions();
      const s = state.sessions.find((x) => x.name === 'advanced-01');
      openSessionModal(s);
      const opened = document.getElementById('session-advanced').open;
      const keyVal = document.getElementById('f-private-key').value;
      const encVal = document.getElementById('f-encoding').value;
      closeSessionModal();
      const plain = await window.api.createSession({ name: 'plain-01', host: '10.1.2.4', port: 22, username: 'root', password: 'x', groupId: g ? g.id : undefined });
      await loadSessions();
      const s2 = state.sessions.find((x) => x.name === 'plain-01');
      openSessionModal(s2);
      const plainOpened = document.getElementById('session-advanced').open;
      closeSessionModal();
      return { created: r.ok, opened: opened, keyVal: keyVal, encVal: encVal, plainOpened: plainOpened };
    })()`);
    if (autoOpen.opened && autoOpen.keyVal === '/tmp/id_rsa' && autoOpen.encVal === 'gbk') ok('编辑「有私钥+GBK」的会话 → 高级选项自动展开且回填正确');
    else bad('编辑时高级设置没自动展开/回填', JSON.stringify(autoOpen));
    if (autoOpen.plainOpened === false) ok('编辑「纯密码」会话 → 高级选项保持折叠(不打扰)');
    else bad('普通会话也把高级选项展开了', JSON.stringify(autoOpen));

    console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  } catch (e) {
    console.error('\n测试异常:', e && e.message);
    failed++;
  }
  try { killTree(appProc); } catch { /* ignore */ }
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(failed ? 1 : 0);
})();
