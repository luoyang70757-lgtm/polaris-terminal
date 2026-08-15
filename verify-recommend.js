'use strict';
/**
 * verify-recommend.js — 端到端验证智能命令推荐(参考 Chaterm):
 *   ① IPC:addCmdHistory 后 cmd:recommend 返回"历史高频优先 + 常用库补齐"
 *   ② UI:点工具栏「✨ 推荐」→ 下拉列出当前主机的推荐(历史徽标 ×次数 / 常用徽标)
 *   ③ 发送:点推荐项 → runInActiveTerminal 把命令发到当前终端(mock 审计日志出现 [CMD])
 *   ④ 兜底:未连接会话时打开菜单显示"暂无推荐"提示
 * 运行: node verify-recommend.js(需 9357 空闲;会占用 mock 端口 8080/2222)
 */
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-rec-'));
const PORT = 9357;
const LOG_DIR = path.join(__dirname, 'logs');

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

// 清理:杀掉本项目旧实例 + 释放端口(mock 8080/2222、CDP 9357)
try { execSync('pkill -f "polaris-terminal/node_modules/electron" 2>/dev/null'); } catch { /* ignore */ }
freePort(PORT); freePort(8080); freePort(2222);

const appProc = spawn('node_modules/.bin/electron', ['.', '--dev', `--remote-debugging-port=${PORT}`, '--no-sandbox', '--disable-gpu'], {
  env: { ...process.env, POLARIS_LOCK_DIR: DIR, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  stdio: ['ignore', 'ignore', 'ignore'], detached: true,
});
setTimeout(() => killTree(appProc), 150000); // 兜底超时
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
const ok = (n) => { passed++; console.log('  ✓ ' + n); };
const bad = (n, e) => { failed++; console.error('  ✗ ' + n + (e ? ' -> ' + e : '')); };
const check = (cond, n, e) => (cond ? ok(n) : bad(n, e));

(async () => {
  console.log('\n=== 智能命令推荐端到端验证 ===\n');
  try {
    // 解锁进入主窗口
    const ts = await targets();
    const lockT = ts.find((t) => /解锁/.test(t.title || ''));
    const lock = await connect(lockT.webSocketDebuggerUrl);
    for (let i = 0; i < 30; i++) { if (await ev(lock, `!!document.getElementById('pw')`)) break; await sleep(300); }
    await sleep(400);
    await ev(lock, `document.getElementById('pw').value='x12345678'; document.getElementById('pw2').value='x12345678'; document.getElementById('btn').click();`);
    let main = null, c = null;
    for (let i = 0; i < 30; i++) {
      await sleep(500);
      const t2 = await targets();
      const m = t2.find((t) => t.type === 'page' && !/解锁/.test(t.title || ''));
      if (m) { main = m; break; }
    }
    check(!!main, '解锁后主窗口出现');
    c = await connect(main.webSocketDebuggerUrl);
    for (let i = 0; i < 40; i++) { if (await ev(c, `!!window.api.recommendCmds && !!document.getElementById('btn-recommend')`)) break; await sleep(300); }
    check(await ev(c, `!!window.api.recommendCmds && !!document.getElementById('btn-recommend')`), 'recommendCmds API 与「✨ 推荐」按钮就绪');

    // ① IPC:先造历史(3×df -h + 1×ls),再查推荐 → 历史优先 + 常用库补齐
    for (let i = 0; i < 3; i++) await ev(c, `window.api.addCmdHistory('127.0.0.1', 'df -h')`);
    await ev(c, `window.api.addCmdHistory('127.0.0.1', 'ls')`);
    await ev(c, `window.api.addCmdHistory('other-host', 'rm -rf /x')`); // 别的主机不混入
    await sleep(600);
    const rec1 = await ev(c, `(async () => { const r = await window.api.recommendCmds('127.0.0.1'); return JSON.stringify(r); })()`);
    const rec1j = JSON.parse(rec1);
    check(rec1j.ok === true, 'IPC cmd:recommend 返回 ok');
    const dfEntry = (rec1j.list || []).find((x) => x.command === 'df -h');
    check(dfEntry && dfEntry.source === 'history' && dfEntry.count === 3, 'df -h 识别为历史高频(×3,去重后仅一条)');
    check(rec1j.list.some((x) => x.command === 'ls' && x.source === 'history'), 'ls 进入历史推荐');
    check(!rec1j.list.some((x) => x.command === 'rm -rf /x'), '别的主机命令不混入推荐');
    check(rec1j.list.some((x) => x.source === 'common' && x.desc), '常用运维命令库补齐(带说明)');

    // ② 建会话 + 连接 mock(等 mock 端口就绪)
    const created = await ev(c, `(async () => JSON.stringify(await window.api.createSession({ name: '推荐测试机', host: '127.0.0.1', port: 2222, username: 'admin', password: 'admin123' })))()`);
    check(created.includes('"ok":true'), '创建测试会话成功');
    await ev(c, `loadSessions()`);
    await sleep(500);
    // 默认树形视图 + 分组启动时折叠:展开所有分组再重渲染,让会话行可见
    await ev(c, `(async () => { state.collapsedGroups.clear(); renderSessionList(''); return true; })()`);
    await sleep(300);
    const cardOk = await ev(c, `[...document.querySelectorAll('.asset-item')].some((x) => x.textContent.includes('推荐测试机'))`);
    check(cardOk, '会话行出现在列表');
    check(await waitPort(2222, 10000), 'mock KoKo SSH 端口 2222 就绪');
    // 关闭指纹校验:首次连接会弹原生"是否信任"对话框,CDP 点不了,会阻塞主进程
    await ev(c, `(async () => { state.settings.verifyHostKey = false; saveSettings(); return true; })()`);
    await ev(c, `(async () => {
      const row = [...document.querySelectorAll('.asset-item')].find((x) => x.textContent.includes('推荐测试机'));
      row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      return true;
    })()`);
    let connected = false;
    for (let i = 0; i < 40; i++) {
      connected = await ev(c, `(async () => {
        const t = [...state.tabs.values()].find((x) => x.session && x.session.name === '推荐测试机');
        return !!(t && t.status === 'connected');
      })()`);
      if (connected) break;
      await sleep(400);
    }
    check(connected, '会话连接成功(state.tabs status=connected)');

    // ③ UI:点「✨ 推荐」→ 下拉出现历史推荐(df -h 徽标"历史" ×3)与常用推荐
    await ev(c, `document.getElementById('btn-recommend').click()`);
    await sleep(600);
    const menuOpen = await ev(c, `!document.getElementById('recommend-menu').classList.contains('hidden')`);
    check(menuOpen, '推荐下拉菜单展开');
    const hostLabel = await ev(c, `document.getElementById('recommend-host').textContent`);
    check(hostLabel.includes('127.0.0.1'), '菜单头部显示当前主机 @ 127.0.0.1');
    const menuText = await ev(c, `document.getElementById('recommend-list').textContent`);
    check(menuText.includes('df -h') && menuText.includes('×3'), '菜单含 df -h(×3)');
    check(menuText.includes('free -m') || menuText.includes('uptime'), '菜单含常用运维命令');
    const badgeOk = await ev(c, `(async () => {
      const rows = [...document.querySelectorAll('#recommend-list .recommend-item')];
      const dfRow = rows.find((r) => { const c = r.querySelector('.recommend-cmd'); return c && c.textContent === 'df -h'; });
      return dfRow && dfRow.querySelector('.recommend-badge').textContent === '历史';
    })()`);
    check(badgeOk === true, 'df -h 项带「历史」徽标');

    // ④ 点击推荐项 → 命令发到当前终端:
    //    1) runInActiveTerminal 成功会 setStatus("已在终端执行…")(状态栏证据)
    //    2) xterm 缓冲区出现命令回显(直接证据)
    //    3) 关闭会话冲刷审计流后,mock 审计日志出现 [CMD] df -h(落盘证据)
    await ev(c, `document.getElementById('toolbar-status').textContent = '(复位)'`);
    await ev(c, `(async () => {
      const rows = [...document.querySelectorAll('#recommend-list .recommend-item')];
      const dfRow = rows.find((r) => { const c = r.querySelector('.recommend-cmd'); return c && c.textContent === 'df -h'; });
      dfRow.click();
      return true;
    })()`);
    await sleep(1200);
    const menuClosed = await ev(c, `document.getElementById('recommend-menu').classList.contains('hidden')`);
    check(menuClosed, '点击后菜单自动收起');
    const statusText = await ev(c, `document.getElementById('toolbar-status').textContent`);
    check(statusText.includes('已在终端执行') && statusText.includes('df -h'), 'runInActiveTerminal 已执行(setStatus 出现「已在终端执行: df -h」),实际值: ' + statusText);
    const activeInfo = await ev(c, `(async () => {
      const t = state.tabs.get(state.activeSessionId);
      return JSON.stringify({ activeSessionId: state.activeSessionId, status: t ? t.status : null, host: t && t.session ? t.session.host : null });
    })()`);
    check(activeInfo.includes('"status":"connected"'), '点击时 activeSessionId 指向已连接会话: ' + activeInfo);
    const termBuf = await ev(c, `(async () => {
      const t = [...state.tabs.values()].find((x) => x.session && x.session.name === '推荐测试机');
      if (!t || !t.term) return '';
      let out = '';
      const b = t.term.buffer.active;
      for (let i = 0; i < b.length; i++) { const l = b.getLine(i); if (l) out += l.translateToString(false) + '\\n'; }
      return out;
    })()`);
    check(termBuf.includes('df -h'), 'xterm 缓冲区出现 df -h 回显(命令已真实进入终端)');
    // 关闭会话:触发 mock audit.close() → ws.end() 冲刷,日志才保证落盘
    await ev(c, `(async () => {
      const t = [...state.tabs.values()].find((x) => x.session && x.session.name === '推荐测试机');
      if (t) await window.api.sshClose(t.sessionId);
      return true;
    })()`);
    await sleep(800);
    const after = fs.existsSync(LOG_DIR) ? fs.readdirSync(LOG_DIR).filter((f) => f.startsWith('audit-')) : [];
    // 本次运行的新会话审计文件 = 连接后新建的那个(含本次 [IN]/[CMD]);按时间取最新几个
    let sawCmd = false, seenFiles = [];
    const candidates = after.sort();
    for (const f of candidates.slice(-4)) {
      seenFiles.push(f);
      // 日志格式: [CMD 2026-08-14T16:04:01.671Z] df -h(时间戳在 [CMD 与 ] 之间)
      try { if (fs.readFileSync(path.join(LOG_DIR, f), 'utf8').includes('] df -h')) sawCmd = true; } catch { /* ignore */ }
    }
    check(sawCmd, 'mock 审计日志出现 [CMD] df -h(命令已发送并落盘)' + (sawCmd ? '' : ' · 扫描文件: ' + seenFiles.join(',')));

    // ⑤ 无连接会话时的表现:头部显示"未连接会话",列表仍给常用运维命令(点击会提示未连接)
    await ev(c, `(async () => {
      const t = [...state.tabs.values()].find((x) => x.session && x.session.name === '推荐测试机');
      if (t) { state.tabs.delete(t.sessionId); if (state.activeSessionId === t.sessionId) state.activeSessionId = null; }
      return true;
    })()`);
    await sleep(400);
    await ev(c, `document.getElementById('btn-recommend').click()`);
    await sleep(500);
    const noTabHost = await ev(c, `document.getElementById('recommend-host').textContent`);
    const noTabList = await ev(c, `document.getElementById('recommend-list').textContent`);
    check(noTabHost.includes('未连接会话'), '无连接会话时菜单头部显示「未连接会话」');
    check(noTabList.includes('free -m') || noTabList.includes('uptime'), '无连接会话时仍给出常用运维命令(点击有未连接提示兜底)');

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
