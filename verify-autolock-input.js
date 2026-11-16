'use strict';
/**
 * verify-autolock-input.js — 自动锁定后能否正常输入密码(用户报「自动锁定后无法输入密码」)
 *
 * 复现路径与线上一致:主窗口里已有连接的终端(焦点在 xterm)→ 闲置到点/手动锁定触发
 * `showLockOverlay()` → 用户直接敲密码。
 *
 * 断言:
 *  ① 锁定后密码框拿到焦点(document.activeElement === lo-pw),窗口缩小后焦点不丢;
 *  ② 直接敲键 → 字符进密码框,且**没有**漏进底层 SSH 会话(termDebug 无这些 SEND);
 *  ③ 点一下密码框再敲 → 同样进密码框;
 *  ④ 回车 → 解锁成功,覆盖层关闭,终端焦点恢复;
 *  ⑤ 窗口重新获得焦点(切走后回来)时密码框焦点不被终端抢走。
 *
 * 运行: node verify-autolock-input.js(需 9395/2299 空闲;mock SSH 密码 admin123)
 */
const { spawn } = require('child_process');
const { freePort, killTree, guardTimeout, evaluate } = require('./test-helper');
const fs = require('fs'); const os = require('os'); const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-autolock-'));
const PORT = 9395, SSH = 2299, HTTP = 2399;
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
// 真实按键:Input.dispatchKeyEvent('char') 会走 keydown→默认插入,和用户敲键一致
async function typeText(c, text) {
  for (const ch of text) {
    await c.call('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, key: ch, unmodifiedText: ch });
    await c.call('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
    await sleep(30);
  }
}
async function pressEnter(c) {
  await c.call('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 36 });
  await c.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 36 });
}

let passed = 0, failed = 0;
const ok = (n, extra) => { passed++; console.log('  ✓ ' + n + (extra ? '  → ' + extra : '')); };
const bad = (n, extra) => { failed++; console.error('  ✗ ' + n + (extra ? '  → ' + extra : '')); };

(async () => {
  console.log('\n=== 自动锁定后输入密码 ===\n');
  try {
    // ---- 解锁初始窗口(首次设置密码) ----
    const t0 = await targets();
    const lockT = t0.find((t) => /解锁/.test(t.title || '')) || t0.find((t) => t.type === 'page');
    const lock = await connect(lockT.webSocketDebuggerUrl);
    // 首次运行:设置 App 密码并进入。lock.js 是 async IIFE —— 按钮监听在 await IPC 之后才绑,
    // 过早点击会静默无效,所以"设置密码 + 点击"整体重试,直到主窗口出现。
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
    // 关掉首次使用引导(它会遮挡/抢焦点)
    await ev(c, `state.settings.onboardingDone = true; saveSettings(); var om=document.getElementById('onboarding-modal'); if(om) om.classList.add('hidden'); true;`);

    // ---- 连一台 mock 主机,让焦点在终端(xterm textarea)----
    await ev(c, `connectToServer({ name:'锁屏测试', host:'127.0.0.1', port:${SSH}, username:'admin', password:'admin123', protocol:'ssh' }); true`);
    let sid = null;
    for (let i = 0; i < 50; i++) {
      sid = await ev(c, `state.activeSessionId || null`);
      const st = sid ? await ev(c, `(function(){var t=state.tabs.get(${JSON.stringify(sid)});return t?t.status:null;})()`) : null;
      if (st === 'connected') break;
      await sleep(300);
    }
    if (!sid) throw new Error('连接未建立');
    await ev(c, `(function(){var t=state.tabs.get(${JSON.stringify(sid)});t.term.focus();return document.activeElement.className;})()`);
    await sleep(200);
    const focusedBefore = await ev(c, `document.activeElement && document.activeElement.className`);
    ok('锁定前焦点在终端', String(focusedBefore));

    // ---- 自动锁定 ----（与 maybeAutoLock 同一路径）
    await ev(c, `showLockOverlay(); true`);
    await sleep(700); // 等窗口缩小(lockResize)完成 —— 这一步最容易把焦点弄丢

    // ① 焦点是否还在密码框
    const st1 = await ev(c, `(function(){
      var ae=document.activeElement||{};
      return {
        overlayVisible: !document.getElementById('lock-overlay').classList.contains('hidden'),
        activeId: ae.id || ae.className || ae.tagName,
        inputDisabled: document.getElementById('lo-pw').disabled,
        pwValue: document.getElementById('lo-pw').value,
      };
    })()`);
    if (st1.overlayVisible) ok('锁定覆盖层已显示'); else bad('锁定覆盖层未显示');
    if (st1.activeId === 'lo-pw') ok('锁定后密码框自动获得焦点'); else bad('锁定后焦点不在密码框(用户会以为“输入不了密码”)', st1.activeId);
    if (!st1.inputDisabled) ok('密码框未被禁用(不是暴力锁倒计时)'); else bad('密码框被禁用', JSON.stringify(st1));

    // ② 直接敲密码 → 应进密码框,且不漏进终端
    const m0 = await ev(c, `termDebug.lines.length`);
    await typeText(c, 'abc');
    await sleep(250);
    const st2 = await ev(c, `(function(){
      var t=state.tabs.get(${JSON.stringify(sid)});
      return {
        pwValue: document.getElementById('lo-pw').value,
        sends: termDebug.lines.slice(${m0}).filter(function(l){return l.indexOf('SEND')>=0;}),
        activeId: (document.activeElement||{}).id || (document.activeElement||{}).tagName,
      };
    })()`);
    if (st2.pwValue === 'abc') ok('直接敲键:字符进入密码框', '(value=' + st2.pwValue + ')');
    else bad('直接敲键:字符没进密码框', JSON.stringify(st2));
    if (!st2.sends.length) ok('密码没有漏进底层 SSH 会话', '(无 SEND)');
    else bad('密码字符被发到 SSH 会话(严重)', JSON.stringify(st2.sends));

    // ③ 点一下密码框再敲
    const box = await ev(c, `(function(){var r=document.getElementById('lo-pw').getBoundingClientRect();return JSON.stringify({x:r.left+r.width/2,y:r.top+r.height/2});})()`);
    const p = JSON.parse(box);
    await c.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', buttons: 1, clickCount: 1 });
    await c.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(150);
    await typeText(c, 'de');
    await sleep(200);
    const st3 = await ev(c, `document.getElementById('lo-pw').value`);
    if (st3 === 'abcde') ok('点击密码框后可继续输入', '(value=' + st3 + ')'); else bad('点击密码框后仍输入不了', String(st3));

    // ④ 输错一次 → 提示剩余次数且焦点回到密码框
    await ev(c, `document.getElementById('lo-pw').value='wrongpw'; document.getElementById('lo-btn').click(); true`);
    await sleep(600);
    const st4 = await ev(c, `(function(){
      return { msg: document.getElementById('lo-msg').textContent, activeId: (document.activeElement||{}).id,
               stillLocked: !document.getElementById('lock-overlay').classList.contains('hidden') };
    })()`);
    if (st4.stillLocked && /密码错误|次机会/.test(st4.msg || '')) ok('错误密码给出提示', st4.msg);
    else bad('错误密码提示异常', JSON.stringify(st4));
    if (st4.activeId === 'lo-pw') ok('错误后焦点仍在密码框'); else bad('错误后焦点丢失', st4.activeId);

    // ⑤ 正确密码 → 解锁
    await ev(c, `document.getElementById('lo-pw').value=${JSON.stringify(APP_PW)}; document.getElementById('lo-btn').click(); true`);
    await sleep(800);
    const st5 = await ev(c, `(function(){
      return { hidden: document.getElementById('lock-overlay').classList.contains('hidden'),
               active: (document.activeElement||{}).className || (document.activeElement||{}).tagName };
    })()`);
    if (st5.hidden) ok('正确密码解锁成功'); else bad('正确密码未解锁', JSON.stringify(st5));

    // ⑥ 点覆盖层空白处(不是输入框)再敲键 → 字符仍应进密码框,不能漏进 SSH 会话
    await ev(c, `showLockOverlay(); true`);
    await sleep(500);
    const blank = await ev(c, `(function(){var r=document.querySelector('.lock-overlay-box').getBoundingClientRect();return JSON.stringify({x:r.left+10,y:r.top+6});})()`);
    const bp = JSON.parse(blank);
    await c.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: bp.x, y: bp.y, button: 'left', buttons: 1, clickCount: 1 });
    await c.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: bp.x, y: bp.y, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(150);
    const m1 = await ev(c, `termDebug.lines.length`);
    await typeText(c, 'xy');
    await sleep(200);
    const st7 = await ev(c, `(function(){
      return { pw: document.getElementById('lo-pw').value,
               activeId: (document.activeElement||{}).id || (document.activeElement||{}).className,
               sends: termDebug.lines.slice(${m1}).filter(function(l){return l.indexOf('SEND')>=0;}) };
    })()`);
    if (st7.pw === 'xy') ok('点空白处再敲键:字符进密码框'); else bad('点空白处后敲键没进密码框', JSON.stringify(st7));
    if (!st7.sends.length) ok('点空白处后敲键也没有漏进 SSH 会话', '(无 SEND)');
    else bad('点空白处后密码漏进 SSH 会话(严重)', JSON.stringify(st7.sends));
    if (st7.activeId === 'lo-pw') ok('点空白处后焦点被拉回密码框'); else bad('点空白处后焦点丢失', st7.activeId);
    await ev(c, `hideLockOverlay(); true`);
    await sleep(300);

    // ⑦ 设置弹窗开着时自动锁定:覆盖层必须盖在弹窗之上(否则用户看到的是弹窗,以为“输不了密码”)
    const z = await ev(c, `(function(){
      openSettingsModal();
      showLockOverlay();
      var ov=parseInt(getComputedStyle(document.getElementById('lock-overlay')).zIndex,10);
      var md=parseInt(getComputedStyle(document.getElementById('settings-modal')).zIndex,10);
      var cc=parseInt(getComputedStyle(document.querySelector('.cmd-complete-panel')||document.body).zIndex,10)||0;
      return { ov: ov, md: md, cc: cc };
    })()`);
    if (z.ov > z.md) ok('锁定覆盖层在设置弹窗之上', `overlay=${z.ov} > modal=${z.md}`); else bad('弹窗盖住了锁定层', JSON.stringify(z));
    if (z.ov >= (z.cc || 0)) ok('锁定覆盖层不低于命令补全面板', `overlay=${z.ov} vs cmdComplete=${z.cc}`); else bad('命令补全盖住了锁定层', JSON.stringify(z));
    await sleep(400);
    const st8 = await ev(c, `(function(){
      focusLockInput();
      return { activeId: (document.activeElement||{}).id,
               locked: !document.getElementById('lock-overlay').classList.contains('hidden'),
               modalOpen: !document.getElementById('settings-modal').classList.contains('hidden') };
    })()`);
    if (st8.locked && st8.modalOpen && st8.activeId === 'lo-pw') ok('弹窗开着时锁定:焦点仍归密码框'); else bad('弹窗场景下聚焦失败', JSON.stringify(st8));
    await ev(c, `document.getElementById('settings-modal').classList.add('hidden'); hideLockOverlay(); true`);
    await sleep(300);

    // ⑧ 再锁一次,模拟“切走再回来”:窗口 focus 事件不应把焦点抢回终端
    await ev(c, `showLockOverlay(); true`);
    await sleep(600);
    await ev(c, `window.dispatchEvent(new Event('focus')); true`);
    await sleep(200);
    const st6 = await ev(c, `(document.activeElement||{}).id || (document.activeElement||{}).className`);
    if (st6 === 'lo-pw') ok('窗口重新聚焦后密码框仍持有焦点'); else bad('窗口聚焦后焦点被抢走', String(st6));

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
