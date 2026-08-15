'use strict';
/**
 * verify-sftp-pin.js — 验证 SFTP 面板"按标签各自的状态"(每个标签独立记忆
 *   自己的 SFTP 开关与浏览目录;修复:旧行为切换标签会自动把 SFTP 绑到新连接)。
 * 验证点:
 *   ① 打开 SFTP → 当前标签记为已开,按钮亮、面板展开
 *   ② 切到"未打开 SFTP"的标签 → 面板收起、SFTP 按钮不亮(用户要求)
 *   ③ 切回开过的标签 → 恢复它的 SFTP 状态与目录
 *   ④ 各标签独立开/关互不影响
 *   ⑤ 连接名下拉 → 切到目标标签并打开/恢复它的 SFTP
 * 运行: node verify-sftp-pin.js(需 9364 空闲;mock 用 2231/8131,不占用 8080/2222)
 */
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-sftppin-'));
const PORT = 9364, SSH = 2231, HTTP = 8131;

function freePort(p) {
  try { execSync(`lsof -ti tcp:${p} | xargs kill -9 2>/dev/null`); } catch { /* ignore */ }
}
function killTree(proc) {
  try { if (proc && proc.pid) process.kill(-proc.pid, 'SIGKILL'); } catch { /* ignore */ }
}
function waitPort(p, ms) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      const s = net.connect(p, '127.0.0.1');
      s.on('connect', () => { s.destroy(); resolve(true); });
      s.on('error', () => { s.destroy(); if (Date.now() - t0 > ms) resolve(false); else setTimeout(tick, 300); });
    };
    tick();
  });
}

freePort(PORT); freePort(SSH); freePort(HTTP);
const appProc = spawn('node_modules/.bin/electron', ['.', '--dev', `--remote-debugging-port=${PORT}`, '--no-sandbox', '--disable-gpu'], {
  env: { ...process.env, POLARIS_LOCK_DIR: DIR, MOCK_SSH_PORT: String(SSH), MOCK_HTTP_PORT: String(HTTP), ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  stdio: ['ignore', 'ignore', 'ignore'], detached: true,
});
setTimeout(() => killTree(appProc), 150000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function targets() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json`);
      const j = await r.json();
      const p = j.find((t) => t.type === 'page' && /解锁|Polaris/.test(t.title || ''));
      if (p) return j;
    } catch { /* not ready */ }
    await sleep(400);
  }
  throw new Error('CDP targets 未就绪');
}
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0; const pending = new Map();
    ws.onopen = () => resolve({
      call(m, p = {}) { return new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method: m, params: p })); }); },
      close() { ws.close(); },
    });
    ws.onerror = (e) => reject(e);
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };
  });
}
async function ev(c, expr) {
  const r = await c.call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('JS异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 600) + ' @ ' + expr.slice(0, 120));
  return r.result && r.result.value;
}

let passed = 0, failed = 0;
const RESULT_FILE = path.join(os.tmpdir(), 'verify-sftp-pin-result.txt');
try { fs.writeFileSync(RESULT_FILE, ''); } catch { /* ignore */ }
const w = (s) => { try { fs.appendFileSync(RESULT_FILE, s + '\n'); } catch { /* ignore */ } console.log(s); };
const ok = (n) => { passed++; w('  ✓ ' + n); };
const bad = (n, e) => { failed++; w('  ✗ ' + n + (e ? ' -> ' + e : '')); };
const check = (cond, n, e) => (cond ? ok(n) : bad(n, e));

(async () => {
  console.log('\n=== SFTP 面板固定浏览目标(不随标签切换)验证 ===\n');
  try {
    const ts = await targets();
    const lock = await connect(ts.find((t) => /解锁/.test(t.title || '')).webSocketDebuggerUrl);
    for (let i = 0; i < 30; i++) { if (await ev(lock, `!!document.getElementById('pw')`)) break; await sleep(300); }
    await sleep(300);
    await ev(lock, `document.getElementById('pw').value='x12345678'; document.getElementById('pw2').value='x12345678'; document.getElementById('btn').click();`);
    let c = null;
    for (let i = 0; i < 30; i++) {
      await sleep(500);
      const t2 = await targets();
      const m = t2.find((t) => t.type === 'page' && !/解锁/.test(t.title || ''));
      if (m) { c = await connect(m.webSocketDebuggerUrl); break; }
    }
    check(!!c, '解锁后主窗口出现');
    for (let i = 0; i < 40; i++) { if (await ev(c, `!!document.getElementById('sftp-conn-menu') && !!document.getElementById('btn-sftp-toggle')`)) break; await sleep(300); }
    check(await ev(c, `!!document.getElementById('sftp-conn-menu') && !!document.getElementById('btn-sftp-toggle')`), 'SFTP 连接下拉与面板按钮就绪');

    // 建两台主机并连接(mock 2231)
    await ev(c, `window.api.createSession({ name: 'SFTP-A', host: '127.0.0.1', port: ${SSH}, username: 'admin', password: 'admin123' })`);
    await ev(c, `window.api.createSession({ name: 'SFTP-B', host: '127.0.0.1', port: ${SSH}, username: 'admin', password: 'admin123' })`);
    await ev(c, `loadSessions()`); await sleep(500);
    await ev(c, `state.collapsedGroups.clear(); renderSessionList('')`);
    await ev(c, `state.settings.verifyHostKey = false; saveSettings()`);
    check(await waitPort(SSH, 10000), `mock KoKo SSH 端口 ${SSH} 就绪`);
    await ev(c, `(async () => {
      for (const name of ['SFTP-A', 'SFTP-B']) {
        const row = [...document.querySelectorAll('.asset-item')].find((x) => x.textContent.includes(name));
        row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 400));
      }
      return true;
    })()`);
    let bothConnected = false;
    for (let i = 0; i < 40; i++) {
      bothConnected = await ev(c, `(async () => {
        const tabs = [...state.tabs.values()];
        return tabs.length === 2 && tabs.every((t) => t.status === 'connected');
      })()`);
      if (bothConnected) break;
      await sleep(400);
    }
    check(bothConnected, '两台主机均已连接(2 个标签)');

    // ① 激活 A,打开 SFTP 面板 → A 自己记录为"已开 SFTP"
    await ev(c, `(async () => {
      const a = [...state.tabs.values()].find((t) => t.session.name === 'SFTP-A');
      activateTab(a.sessionId);
      return a.sessionId;
    })()`);
    const aSid = await ev(c, `(async () => { const a = [...state.tabs.values()].find((t) => t.session.name === 'SFTP-A'); return a.sessionId; })()`);
    const bSid = await ev(c, `(async () => { const b = [...state.tabs.values()].find((t) => t.session.name === 'SFTP-B'); return b.sessionId; })()`);
    await ev(c, `toggleSftpPanel()`);
    await sleep(800);
    const openedOn = await ev(c, `state.sftp.sessionId`);
    check(openedOn === aSid, `打开 SFTP 绑定到当前激活连接 A(${openedOn} === ${aSid})`);
    const st1 = await ev(c, `(async () => { const b = document.getElementById('btn-sftp-toggle'); return JSON.stringify({ active: b.classList.contains('active'), panelHidden: document.getElementById('sftp-panel').classList.contains('hidden'), aOpen: [...state.tabs.values()].find(t=>t.session.name==='SFTP-A').sftpOpen }); })()`);
    check(st1.includes('"active":true') && st1.includes('"panelHidden":false') && st1.includes('"aOpen":true'), 'A 的 SFTP 打开:按钮亮、面板展开、A.sftpOpen=true(实际: ' + st1 + ')');
    const labelA = await ev(c, `document.getElementById('sftp-conn').textContent`);
    check(labelA.includes('SFTP-A'), '工具栏连接名显示 SFTP-A');

    // ② 切换到 B(未打开 SFTP)→ 面板收起、SFTP 按钮不亮(用户要求的行为)
    await ev(c, `activateTab('${bSid}')`);
    await sleep(600);
    const st2 = await ev(c, `(async () => { const b = document.getElementById('btn-sftp-toggle'); return JSON.stringify({ active: b.classList.contains('active'), panelHidden: document.getElementById('sftp-panel').classList.contains('hidden'), sessionId: state.sftp.sessionId, bOpen: [...state.tabs.values()].find(t=>t.session.name==='SFTP-B').sftpOpen, aOpen: [...state.tabs.values()].find(t=>t.session.name==='SFTP-A').sftpOpen }); })()`);
    check(st2.includes('"active":false') && st2.includes('"panelHidden":true') && st2.includes('"aOpen":true') && st2.includes('"bOpen":false'),
      '切到未开 SFTP 的 B:按钮不亮、面板收起、A 的状态保留、B 未被自动打开(实际: ' + st2 + ')');
    const activeNow = await ev(c, `state.activeSessionId`);
    check(activeNow === bSid, '当前激活标签确实是 B');

    // ③ 切回 A → 恢复 A 的 SFTP(面板展开、按钮亮、浏览 A 的目录)
    await ev(c, `activateTab('${aSid}')`);
    await sleep(700);
    const st3 = await ev(c, `(async () => { const b = document.getElementById('btn-sftp-toggle'); return JSON.stringify({ active: b.classList.contains('active'), panelHidden: document.getElementById('sftp-panel').classList.contains('hidden'), sessionId: state.sftp.sessionId }); })()`);
    check(st3.includes('"active":true') && st3.includes('"panelHidden":false') && st3.includes('"' + aSid + '"'), '切回 A:恢复其 SFTP 状态(按钮亮、面板展开)(实际: ' + st3 + ')');
    const labelA2 = await ev(c, `document.getElementById('sftp-conn').textContent`);
    check(labelA2.includes('SFTP-A'), '切回 A 后面板仍浏览 SFTP-A');

    // ④ 在 B 上打开 SFTP → 各标签独立
    await ev(c, `toggleSftpPanel()`); // 当前激活是 A → 先关掉 A 的
    await sleep(400);
    await ev(c, `activateTab('${bSid}')`);
    await sleep(300);
    await ev(c, `toggleSftpPanel()`); // 打开 B 的
    await sleep(700);
    const st4 = await ev(c, `(async () => { const b = document.getElementById('btn-sftp-toggle'); return JSON.stringify({ active: b.classList.contains('active'), sessionId: state.sftp.sessionId }); })()`);
    check(st4.includes('"active":true') && st4.includes('"' + bSid + '"'), '在 B 上打开 SFTP:B 按钮亮、浏览 B(实际: ' + st4 + ')');
    const labelB = await ev(c, `document.getElementById('sftp-conn').textContent`);
    check(labelB.includes('SFTP-B'), '工具栏连接名显示 SFTP-B');

    // ⑤ 下拉切换:点 A → 切到 A 标签并打开/恢复其 SFTP
    await ev(c, `document.getElementById('sftp-conn').click()`);
    await sleep(400);
    const menuOpen = await ev(c, `!document.getElementById('sftp-conn-menu').classList.contains('hidden')`);
    check(menuOpen, '点击连接名弹出切换下拉');
    const menuItems = await ev(c, `[...document.querySelectorAll('#sftp-conn-menu .ctx-item')].map((x) => x.textContent).join('|')`);
    check(menuItems.includes('SFTP-A') && menuItems.includes('SFTP-B'), '下拉列出全部已连接会话(实际: ' + menuItems + ')');
    await ev(c, `(async () => {
      const items = [...document.querySelectorAll('#sftp-conn-menu .ctx-item')];
      const it = items.find((x) => x.textContent.includes('SFTP-A'));
      it.click();
      return true;
    })()`);
    await sleep(800);
    const st5 = await ev(c, `(async () => { const b = document.getElementById('btn-sftp-toggle'); return JSON.stringify({ active: b.classList.contains('active'), activeTab: state.activeSessionId, sessionId: state.sftp.sessionId }); })()`);
    check(st5.includes('"active":true') && st5.includes('"' + aSid + '"'), '下拉选 A:激活 A 标签并恢复其 SFTP(实际: ' + st5 + ')');
    const listLoaded = await ev(c, `(async () => {
      const box = document.getElementById('sftp-list');
      return box.children.length > 0;
    })()`);
    check(listLoaded, 'A 的目录列表已加载(mock VFS 有内容)');
    const menuClosed = await ev(c, `document.getElementById('sftp-conn-menu').classList.contains('hidden')`);
    check(menuClosed, '选中后下拉自动收起');
    // 关闭 A 的 SFTP:再切回 A 时面板保持收起(状态记住了)
    await ev(c, `toggleSftpPanel()`);
    await sleep(300);
    await ev(c, `activateTab('${bSid}')`);
    await sleep(300);
    await ev(c, `activateTab('${aSid}')`);
    await sleep(400);
    const st6 = await ev(c, `(async () => { const b = document.getElementById('btn-sftp-toggle'); return JSON.stringify({ active: b.classList.contains('active'), panelHidden: document.getElementById('sftp-panel').classList.contains('hidden'), aOpen: [...state.tabs.values()].find(t=>t.session.name==='SFTP-A').sftpOpen }); })()`);
    check(st6.includes('"active":false') && st6.includes('"aOpen":false'), '关闭 A 的 SFTP 后切走再切回,保持关闭(A.sftpOpen=false)(实际: ' + st6 + ')');

    // ④ 堡垒机会话展示:同堡垒机的两台主机,SFTP 标签/下拉必须按"真实目标主机"区分
    //    (host/port 是堡垒机网关,所有资产相同 → 不能只显示 名称·网关:端口)
    const textJms = await ev(c, `sftpSessionText({ session: { name: 'web-server-01', host: '192.168.1.250', port: 2222, username: 'admin@ssh@root@192.168.10.10', jmsKey: 'jms-server-1|192.168.10.10|root', displayHost: '192.168.10.10' } })`);
    check(textJms === '192.168.10.10 · web-server-01(root)', 'JMS 堡垒机会话标签显示真实目标主机(实际: ' + textJms + ')');
    const textOld = await ev(c, `sftpSessionText({ session: { name: 'web-server-01', host: '192.168.1.250', port: 2222, username: 'admin@ssh@root@192.168.10.10', jmsKey: 'jms-server-1|192.168.10.10|root' } })`);
    check(textOld === '192.168.10.10 · web-server-01(root)', '老会话(无 displayHost)从 jmsKey 反推真实目标(实际: ' + textOld + ')');
    const textH3c = await ev(c, `sftpSessionText({ session: { name: 'h3c-node', host: '192.168.1.250', port: 2222, username: 'root', displayHost: '10.0.0.5', bastionKey: 'h3c-1' } })`);
    check(textH3c === '10.0.0.5 · h3c-node(root)', 'H3C 堡垒机会话标签显示真实目标主机(实际: ' + textH3c + ')');
    const textNormal = await ev(c, `sftpSessionText({ session: { name: '直连机', host: '192.168.1.14', port: 22, username: 'root' } })`);
    check(textNormal === '直连机 · 192.168.1.14:22', '普通会话维持 名称·host:port(实际: ' + textNormal + ')');
    // 下拉里两台堡垒主机按真实 IP 区分(目标 IP 在最前,截断也不丢)
    await ev(c, `(async () => {
      const A = { sessionId: 'bastion-fake-a', status: 'connected', session: { name: 'web-server-01', host: '192.168.1.250', port: 2222, username: 'admin@ssh@root@192.168.10.10', jmsKey: 'x|192.168.10.10|root', displayHost: '192.168.10.10' } };
      const B = { sessionId: 'bastion-fake-b', status: 'connected', session: { name: 'db-server-01', host: '192.168.1.250', port: 2222, username: 'admin@ssh@root@192.168.10.11', jmsKey: 'x|192.168.10.11|root', displayHost: '192.168.10.11' } };
      state.tabs.set(A.sessionId, A); state.tabs.set(B.sessionId, B);
      return true;
    })()`);
    await ev(c, `document.getElementById('sftp-conn').click()`);
    await sleep(300);
    const bastionMenu = await ev(c, `[...document.querySelectorAll('#sftp-conn-menu .ctx-item')].map((x) => x.textContent).join('|')`);
    check(bastionMenu.includes('192.168.10.10 · web-server-01(root)') && bastionMenu.includes('192.168.10.11 · db-server-01(root)'),
      '下拉里两台堡垒主机按真实 IP 可区分(实际: ' + bastionMenu + ')');
    await ev(c, `(async () => { state.tabs.delete('bastion-fake-a'); state.tabs.delete('bastion-fake-b'); return true; })()`);

    console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  } catch (e) {
    console.error('\n测试异常:', e && e.message);
    failed++;
    console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  }
  try { killTree(appProc); } catch { /* ignore */ }
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  // 延迟退出:让 stdout 缓冲刷完再退,否则管道/文件重定向时 console.log 会被 process.exit 截断
  setTimeout(() => process.exit(failed ? 1 : 0), 300);
})();
