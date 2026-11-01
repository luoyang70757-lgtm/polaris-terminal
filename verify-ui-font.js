'use strict';
/**
 * verify-ui-font.js — 界面/终端字体(含苹果 SF Pro / 苹方支持)
 *
 * 断言:
 *   ① 界面上有「界面字体」下拉:自动 / 苹果系统字体(SF Pro)/ 苹方 / 微软雅黑 / Noto / 自定义
 *   ② 默认「自动」:body 的 font-family 栈里同时有 -apple-system(苹果 SF)与 PingFang SC(苹方),
 *      且苹果系排在 Windows/Linux 字体之前(苹果设备上优先命中 SF/苹方)
 *   ③ 选「苹方」→ --ui-font-family 注入,body 实际 font-family 以 PingFang SC 开头
 *   ④ 选「自定义」→ 出现输入框,填值后立即生效(body 字体跟着变),存进 settings
 *   ⑤ 终端字体下拉含「系统等宽(ui-monospace / SF Mono)」与 SFMono-Regular 回退链
 *   ⑥ 恢复默认后 --ui-font-family 被移除(回到自动栈),不污染其他用户
 *
 * 运行:node verify-ui-font.js
 */
const { spawn } = require('child_process');
const { freePort, killTree, guardTimeout, evaluate } = require('./test-helper');
const fs = require('fs'); const os = require('os'); const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-uifont-'));
const PORT = 9459, SSH = 2289, HTTP = 2389;
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
  console.log('\n=== 界面 / 终端字体(苹果支持) ===');
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
    for (let i = 0; i < 50; i++) { if (await ev(c, `typeof openSettingsModal === 'function'`)) break; await sleep(200); }
    await ev(c, 'openSettingsModal()'); await sleep(400);

    head('① 界面字体入口');
    const opts = await ev(c, `(function () {
      var sel = document.getElementById('set-ui-font-family');
      if (!sel) return null;
      return [].map.call(sel.options, function (o) { return { v: o.value, t: o.textContent.trim() }; });
    })()`);
    if (opts && opts.length >= 6) ok(`界面字体下拉 ${opts.length} 项:${opts.map((o) => o.t).join(' / ')}`);
    else bad('没有界面字体下拉', JSON.stringify(opts));
    const texts = (opts || []).map((o) => o.t).join('|');
    if (/苹果|SF Pro/.test(texts) && /苹方/.test(texts) && /自定义/.test(texts)) ok('含「苹果系统字体(SF Pro)」「苹方」「自定义」等苹果相关选项');
    else bad('缺少苹果字体选项', texts);

    head('② 自动栈(苹果优先)');
    const autoStack = await ev(c, `(function () {
      var fam = getComputedStyle(document.body).fontFamily;
      var iApple = fam.indexOf('-apple-system');
      var iPing = fam.indexOf('PingFang SC');
      var iYahei = fam.indexOf('Microsoft YaHei');
      var iNoto = fam.indexOf('Noto Sans CJK SC');
      return { fam: fam, iApple: iApple, iPing: iPing, iYahei: iYahei, iNoto: iNoto,
        appleFirst: iApple >= 0 && (iYahei < 0 || iApple < iYahei) && (iNoto < 0 || iApple < iNoto),
        hasPingFang: iPing >= 0 };
    })()`);
    if (autoStack.iApple >= 0) ok('默认栈含 -apple-system(苹果系统字体 SF)');
    else bad('默认栈没有 -apple-system', autoStack.fam);
    if (autoStack.hasPingFang) ok('默认栈含 PingFang SC(苹方中文)');
    else bad('默认栈没有苹方', autoStack.fam);
    if (autoStack.appleFirst) ok('苹果系排在 Windows/Linux 字体之前(苹果设备优先命中)');
    else bad('字体栈顺序不对(苹果系未优先)', JSON.stringify(autoStack));

    head('③ 选「苹方」');
    await ev(c, `(function () {
      var sel = document.getElementById('set-ui-font-family');
      sel.value = '"PingFang SC", "Hiragino Sans GB", "Heiti SC", -apple-system, sans-serif';
      sel.dispatchEvent(new Event('change'));
      return true;
    })()`);
    await sleep(300);
    const ping = await ev(c, `(function () {
      var v = getComputedStyle(document.documentElement).getPropertyValue('--ui-font-family').trim();
      var fam = getComputedStyle(document.body).fontFamily;
      return { cssVar: v, fam: fam, saved: state.settings.uiFontFamily,
        starts: fam.replace(/^["']/, '').indexOf('PingFang SC') === 0 };
    })()`);
    if (ping.cssVar && /PingFang SC/.test(ping.cssVar)) ok('--ui-font-family 注入苹方链');
    else bad('--ui-font-family 没注入', JSON.stringify(ping));
    if (ping.starts) ok(`body 实际字体以 PingFang SC 开头(${ping.fam.slice(0, 40)}…)`);
    else bad('body 字体没跟着变', ping.fam);

    head('④ 自定义字体');
    await ev(c, `(function () {
      var sel = document.getElementById('set-ui-font-family');
      sel.value = '__custom__'; sel.dispatchEvent(new Event('change'));
      var inp = document.getElementById('set-ui-font-family-custom');
      inp.value = '"HarmonyOS Sans SC", "PingFang SC", sans-serif';
      inp.dispatchEvent(new Event('change'));
      return true;
    })()`);
    await sleep(300);
    const custom = await ev(c, `(function () {
      var wrap = document.getElementById('set-ui-font-family-custom-wrap');
      var v = getComputedStyle(document.documentElement).getPropertyValue('--ui-font-family').trim();
      return { wrapShown: getComputedStyle(wrap).display !== 'none', cssVar: v, saved: state.settings.uiFontFamily };
    })()`);
    if (custom.wrapShown) ok('选「自定义…」→ 显示自定义输入框');
    else bad('自定义输入框没显示', JSON.stringify(custom));
    if (/HarmonyOS Sans SC/.test(custom.cssVar) && /HarmonyOS/.test(custom.saved || '')) ok('自定义字体已生效并存入 settings');
    else bad('自定义字体未生效', JSON.stringify(custom));

    head('⑤ 终端字体(苹果等宽)');
    const termOpts = await ev(c, `(function () {
      var sel = document.getElementById('set-font-family');
      return [].map.call(sel.options, function (o) { return o.value; });
    })()`);
    const joined = (termOpts || []).join('|');
    if (/ui-monospace/.test(joined)) ok('终端字体含「系统等宽(ui-monospace / SF Mono)」');
    else bad('终端字体缺少 ui-monospace 预设', joined.slice(0, 200));
    if (/SFMono-Regular/.test(joined)) ok('SF Mono 回退链含 SFMono-Regular(macOS 族名兼容)');
    else bad('SF Mono 回退链不完整', joined.slice(0, 200));

    head('⑥ 恢复自动');
    await ev(c, `(function () {
      var sel = document.getElementById('set-ui-font-family');
      sel.value = ''; sel.dispatchEvent(new Event('change'));
      return true;
    })()`);
    await sleep(300);
    const back = await ev(c, `(function () {
      var v = getComputedStyle(document.documentElement).getPropertyValue('--ui-font-family').trim();
      var fam = getComputedStyle(document.body).fontFamily;
      return { cssVar: v, fam: fam, saved: state.settings.uiFontFamily };
    })()`);
    if (!back.cssVar && !back.saved) ok('恢复「自动」→ 变量被移除,回到内置苹果优先字体栈');
    else bad('恢复自动失败', JSON.stringify(back));

    console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  } catch (e) {
    console.error('\n测试异常:', e && e.message);
    failed++;
  }
  try { killTree(appProc); } catch { /* ignore */ }
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(failed ? 1 : 0);
})();
