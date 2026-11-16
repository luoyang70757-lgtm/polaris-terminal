'use strict';
/**
 * verify-ime-deadkey.js — 输入法"死键"吞字符(v1.0.9 日志里的真问题)
 *
 * 现象(v1.0.9 线上日志):
 *   KEY 'Process' - ime=0 kc=229 active=TEXTAREA.xterm-helper-textarea →终端   ← 没有任何 SEND
 *   KEY 'Backspace' → SEND sess-1 "\x7f"                                        ← 退格/回车正常
 * 即:输入法处于"死键"状态(key='Process'/keyCode=229,但 compositionstart 从未触发),
 * 字符键被 IME 拦走,只有 Backspace/Enter 能到 xterm。
 *
 * 旧逻辑的门槛是"**连续 ≥3** 个死键"才 blur+focus 重建 IME 会话。实测用户是
 * 「2 连发 → 敲退格 → 2 连发」,计数器被普通按键复位,永远到不了 3 → 一直吞字符。
 *
 * 本用例覆盖:
 *  ① 单个死键不重建(避免误伤正常输入法);
 *  ② 3s 窗口内累计 2 个死键 → 重建输入法会话(核心:旧代码这里是 0 次,红灯);
 *  ③ 两个死键间隔 > 3s(不在同一窗口)→ 不重建(防止长期累计误触发);
 *  ④ 真实组合(compositionstart 先到)不被判成死键,且会清空死键统计;
 *  ⑤ 复刻线上节奏:2 连发 → 退格 → 2 连发 → 重建;
 *  ⑥ 重建后键盘仍可用(真字符照样 SEND 到会话)。
 *
 * 运行: node verify-ime-deadkey.js(需 9397/2296/2396 空闲;mock SSH 密码 admin123)
 */
const { spawn } = require('child_process');
const { freePort, guardTimeout, evaluate } = require('./test-helper');
const fs = require('fs'); const os = require('os'); const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-ime-dead-'));
const PORT = 9397, SSH = 2296, HTTP = 2396;
freePort(PORT); freePort(SSH); freePort(HTTP);
process.env.MOCK_SSH_PORT = String(SSH);
process.env.MOCK_HTTP_PORT = String(HTTP);
require('./mock/mock-server').start();

const APP_PW = 'x1234567';
const appProc = spawn(require('electron'), ['.', '--dev', `--remote-debugging-port=${PORT}`, '--no-sandbox', '--disable-gpu'], {
  env: { ...process.env, POLARIS_LOCK_DIR: DIR, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  stdio: ['ignore', 'ignore', 'ignore'], detached: true,
});
guardTimeout(180000, appProc);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function targets() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json`);
      const j = await r.json();
      if (j.some((t) => t.type === 'page')) return j;
    } catch { /* ignore */ }
    await sleep(400);
  }
  throw new Error('targets 未就绪');
}
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0; const pending = new Map();
    ws.onopen = () => resolve({
      call(m, p = {}) { return new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method: m, params: p })); }); },
      close() { ws.close(); },
    });
    ws.onerror = reject;
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };
  });
}
async function ev(c, expr) { return evaluate(c, expr); }

let passed = 0, failed = 0;
const ok = (n, extra) => { passed++; console.log('  ✓ ' + n + (extra ? '  → ' + extra : '')); };
const bad = (n, extra) => { failed++; console.error('  ✗ ' + n + (extra ? '  → ' + extra : '')); };

(async () => {
  console.log('\n=== 输入法死键吞字符:时间窗 + 延迟判定 ===\n');
  try {
    const t0 = await targets();
    const lockT = t0.find((t) => /解锁/.test(t.title || '')) || t0.find((t) => t.type === 'page');
    const lock = await connect(lockT.webSocketDebuggerUrl);
    let c = null;
    for (let attempt = 0; attempt < 20 && !c; attempt++) {
      const ready = await ev(lock, `(function(){var b=document.getElementById('btn');return !!b && /设置|解锁/.test(b.textContent||'');})()`);
      if (ready) {
        await ev(lock, `document.getElementById('pw').value=${JSON.stringify(APP_PW)}; document.getElementById('pw2').value=${JSON.stringify(APP_PW)}; document.getElementById('btn').click();`);
      }
      for (let i = 0; i < 4 && !c; i++) {
        await sleep(350);
        const t = await targets();
        const m = t.find((x) => x.type === 'page' && !/解锁/.test(x.title || ''));
        if (m) c = await connect(m.webSocketDebuggerUrl);
      }
    }
    if (!c) throw new Error('主窗口未就绪');
    for (let i = 0; i < 60; i++) { if (await ev(c, `typeof state === 'object' && !!state.settings`)) break; await sleep(200); }
    await ev(c, `state.settings.onboardingDone = true; saveSettings(); var om=document.getElementById('onboarding-modal'); if(om) om.classList.add('hidden'); true;`);

    // ---- 连一台 mock 主机 ----
    await ev(c, `connectToServer({ name:'IME测试', host:'127.0.0.1', port:${SSH}, username:'admin', password:'admin123', protocol:'ssh' }); true`);
    let sid = null;
    for (let i = 0; i < 50; i++) {
      sid = await ev(c, `state.activeSessionId || null`);
      const st = sid ? await ev(c, `(function(){var t=state.tabs.get(${JSON.stringify(sid)});return t?t.status:null;})()`) : null;
      if (st === 'connected') break;
      await sleep(300);
    }
    if (!sid) throw new Error('连接未建立');
    const S = JSON.stringify(sid);

    // ---- 页面侧探针:+注入死键/组合事件的工具 ----
    await ev(c, `(function(){
      var t = state.tabs.get(${S});
      var ta = t.term.textarea;
      window.__imeProbe = { blur: 0, focus: 0 };
      window.__imeLog = []; window.__imeT0 = Date.now();
      ta.addEventListener('blur', function(){ window.__imeProbe.blur++; window.__imeLog.push('blur@'+(Date.now()-window.__imeT0)); });
      ta.addEventListener('focus', function(){ window.__imeProbe.focus++; window.__imeLog.push('focus@'+(Date.now()-window.__imeT0)); });
      // 死键:key='Process' + keyCode 229(KeyboardEvent 构造器不给设 keyCode,defineProperty 补)
      window.__deadKey = function(){
        var e = new KeyboardEvent('keydown', { key: 'Process', bubbles: true, cancelable: true });
        try { Object.defineProperty(e, 'keyCode', { get: function(){ return 229; } }); } catch (x) {}
        try { Object.defineProperty(e, 'which', { get: function(){ return 229; } }); } catch (x) {}
        ta.dispatchEvent(e);
        window.__imeLog.push('dead@'+(Date.now()-window.__imeT0));
        return true;
      };
      window.__realKey = function(k){
        var e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
        try { Object.defineProperty(e, 'keyCode', { get: function(){ return k.toUpperCase().charCodeAt(0); } }); } catch (x) {}
        ta.dispatchEvent(e);
        return true;
      };
      window.__imestart = function(){ ta.dispatchEvent(new CompositionEvent('compositionstart', { data: '', bubbles: true })); window.__imeLog.push('cstart@'+(Date.now()-window.__imeT0)); return true; };
      window.__imeend = function(){ ta.dispatchEvent(new CompositionEvent('compositionend', { data: '', bubbles: true })); window.__imeLog.push('cend@'+(Date.now()-window.__imeT0)); return true; };
      t.term.focus();
      return true;
    })()`);
    await sleep(200);

    const probe = async () => JSON.parse(await ev(c, `JSON.stringify(window.__imeProbe)`));
    const reset0 = async () => { await ev(c, `window.__imeProbe.blur=0; window.__imeProbe.focus=0; true`); };

    // ---- ① 单个死键:不重建 ----
    await reset0();
    await ev(c, `window.__deadKey(); true`);
    await sleep(400);
    const p1 = await probe();
    if (p1.blur === 0 && p1.focus === 0) ok('① 单个死键不重建输入法会话(不误伤正常输入法)');
    else bad('① 单个死键就重建了(过度触发)', JSON.stringify(p1));

    // ---- ② 3s 窗口内第二个死键(间隔 400ms)→ 重建 ----
    await ev(c, `window.__deadKey(); true`);
    await sleep(500);
    const p2 = await probe();
    if (p2.blur >= 1 && p2.focus >= 1) ok('② 3s 内累计 2 个死键 → 重建输入法会话', `blur=${p2.blur} focus=${p2.focus}`);
    else bad('② 2 个死键没有重建会话(旧门槛 3 太高)', JSON.stringify(p2));

    // 重建后状态栏应提示输入法(每终端一次,不刷屏)
    const hint = await ev(c, `String((document.getElementById('toolbar-status')||{}).textContent||'')`);
    if (/输入法/.test(hint)) ok('② 重建后状态栏提示输入法被吞字符', hint.trim());
    else bad('② 没有提示用户切换输入法', hint);

    // ---- ③ 两个死键间隔 > 3s(不在同一窗口)→ 不重建 ----
    await ev(c, `window.__imeProbe.blur=0; window.__imeProbe.focus=0; window.__deadKey(); true`);
    await sleep(3400);
    await ev(c, `window.__deadKey(); true`);
    await sleep(500);
    const p3 = await probe();
    if (p3.blur === 0 && p3.focus === 0) ok('③ 死键间隔 > 3s 不累计(不因长期零散死键误触发)');
    else bad('③ 跨窗口的死键被累计了', JSON.stringify(p3));

    // ---- ④ 真实组合:compositionstart 先到 → 不算死键,并清空统计 ----
    // 先用一个真字符把 ③ 的死键统计清空(真字符 ⇒ 链路通),再单独验证组合:
    // 否则 ③ 最后一个死键 + ④ 第一个死键仍在 3s 窗口内,会(正确地)触发重建,干扰本步断言。
    await ev(c, `window.__realKey('z'); true`);
    await sleep(120);
    await ev(c, `window.__imeProbe.blur=0; window.__imeProbe.focus=0; window.__deadKey(); true`); // 先攒 1 个(未到阈值)
    await sleep(250);
    await ev(c, `window.__imestart(); window.__deadKey(); window.__deadKey(); window.__imeend(); true`);
    await sleep(500);
    const p4 = await probe();
    if (p4.blur === 0 && p4.focus === 0) ok('④ 真实组合(拼音)期间不重建,不打断候选窗');
    else bad('④ 真实组合被误判成死键', JSON.stringify(p4) + ' log=' + await ev(c, `window.__imeLog.slice(-14).join(' ')`));

    // 组合结束后再打 1 个死键:统计已被组合清空 → 不重建
    await ev(c, `window.__imeProbe.blur=0; window.__imeProbe.focus=0; window.__deadKey(); true`);
    await sleep(400);
    const p4b = await probe();
    if (p4b.blur === 0 && p4b.focus === 0) ok('④ 组合会清空死键统计(组合后的单个死键不触发)');
    else bad('④ 组合没清空死键统计', JSON.stringify(p4b));

    // ---- ⑤ 复刻线上节奏:真字符复位后,40ms 内的 2 连发(同一结算周期)也要算 2 次 ----
    await ev(c, `window.__realKey('y'); true`); // 真字符:清空死键统计,回到"干净"状态
    await sleep(150);
    await ev(c, `window.__imeProbe.blur=0; window.__imeProbe.focus=0; true`);
    await ev(c, `window.__deadKey(); true`);
    await sleep(40);
    await ev(c, `window.__deadKey(); true`);
    await sleep(400);
    const p5 = await probe();
    if (p5.blur >= 1 && p5.focus >= 1) ok('⑤ 40ms 内的「2 连发」即重建会话(线上就是这个节奏)', `blur=${p5.blur} focus=${p5.focus}`);
    else bad('⑤ 同一结算周期内的连发漏计了(共享句柄的老问题)', JSON.stringify(p5));

    // ---- ⑥ 重建后键盘仍可用:真字符照样送到会话 ----
    await ev(c, `window.__realKey('a'); true`);
    await sleep(400);
    const sent = await ev(c, `(function(){
      var t=state.tabs.get(${S});
      return JSON.stringify({ inputBuf: String(t.inputBuf||''), focused: document.activeElement === t.term.textarea });
    })()`);
    const SN = JSON.parse(sent);
    if (/a/.test(SN.inputBuf)) ok('⑥ 重建后真字符仍进终端', `inputBuf=${JSON.stringify(SN.inputBuf)}`);
    else bad('⑥ 重建后键盘不可用', sent);
    if (SN.focused) ok('⑥ 重建后焦点回到终端 textarea'); else bad('⑥ 重建后焦点丢了', sent);
  } catch (e) {
    failed++;
    console.error(`\n测试异常: ${e && e.message}`);
  } finally {
    console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
    try { process.kill(-appProc.pid); } catch { /* ignore */ }
    await sleep(500);
    process.exit(failed ? 1 : 0);
  }
})();
