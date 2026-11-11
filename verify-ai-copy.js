'use strict';
/**
 * verify-ai-copy.js — AI 对话区文字必须能复制(回归)
 *   用户症状:「ai 对话框中的文本不能复制」。根因是全局按键兜底:焦点在 BODY(点完 AI 对话区
 *   焦点掉到 body)时,所有按键都会被 preventDefault 后转发给终端 —— 连 ⌘C/Ctrl+C 的原生复制
 *   一起被吞,选中文字后按复制毫无反应。修法:① AI 对话区可聚焦(tabindex=-1),点进去焦点就到它,
 *   按键不再走终端兜底;② 有"终端以外"选中文字时 ⌘C 一律放行原生复制;③ ⌘A 在对话区 = 全选对话;
 *   ④ 每条消息 / 每个代码块给显式「📋 复制」按钮(拖选不好用时兜底)。
 * 断言:结构(tabindex / user-select)、点选聚焦、⌘C 不再被 preventDefault、⌘A 全选对话、
 *       普通按键仍转发终端、消息复制按钮写入剪贴板、代码块复制按钮写入剪贴板、BODY 焦点+有选中时放行 ⌘C。
 * 运行: node verify-ai-copy.js(需 9402/2291/2391 空闲)
 */
const { spawn, execSync } = require('child_process');
const { freePort, killTree, guardTimeout, evaluate } = require('./test-helper');
const fs = require('fs'); const os = require('os'); const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-aicopy-'));
const PORT = 9402, SSH = 2291, HTTP = 2391;
try { execSync('pkill -f "remote-debugging-port" 2>/dev/null'); } catch { /* 无残留 */ }
freePort(PORT); freePort(SSH); freePort(HTTP);
process.env.MOCK_SSH_PORT = String(SSH);
process.env.MOCK_HTTP_PORT = String(HTTP);
require('./mock/mock-server').start();

const appProc = spawn(require('electron'), ['.', '--dev', `--remote-debugging-port=${PORT}`, '--no-sandbox', '--disable-gpu'], {
  env: { ...process.env, POLARIS_LOCK_DIR: DIR, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  stdio: ['ignore', 'ignore', 'ignore'], detached: true,
});
guardTimeout(200000, appProc);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function targets() {
  for (let i = 0; i < 75; i++) {
    try { const j = await (await fetch(`http://127.0.0.1:${PORT}/json`, { signal: AbortSignal.timeout(3000) }).then((r) => r)).json(); if (j.some((t) => t.type === 'page')) return j; } catch { /* not ready */ }
    await sleep(400);
  }
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
let passed = 0, failed = 0;
const ok = (n) => { passed++; console.log('  ✓ ' + n); };
const bad = (n, e) => { failed++; console.error('  ✗ ' + n + (e ? ' → ' + e : '')); };

(async () => {
  console.log('\n=== AI 对话区复制 ===\n');
  try {
    const t0 = await targets();
    const lockT = t0.find((t) => /解锁/.test(t.title || '')) || t0.find((t) => t.type === 'page');
    const lock = await connect(lockT.webSocketDebuggerUrl);
    for (let i = 0; i < 30; i++) { if (await evaluate(lock, `!!document.getElementById('pw')`)) break; await sleep(300); }
    await evaluate(lock, `document.getElementById('pw').value='x1234567'; document.getElementById('pw2').value='x1234567'; document.getElementById('btn').click();`);
    let main = null;
    for (let i = 0; i < 30 && !main; i++) { await sleep(500); main = (await targets()).find((t) => t.type === 'page' && !/解锁/.test(t.title || '')); }
    if (!main) throw new Error('主窗口未就绪');
    const c = await connect(main.webSocketDebuggerUrl);
    await sleep(1000);

    // 打开 AI 面板 + 塞两条消息(assistant 带一个 bash 代码块)
    await evaluate(c, `(function(){
      state.settings.onboardingDone = true; saveSettings();
      var om = document.getElementById('onboarding-modal'); if (om) om.classList.add('hidden');
      if (els.aiPanel) els.aiPanel.classList.remove('hidden');
      els.aiChat.innerHTML = '';
      appendAiMsg('user', '把磁盘占用最高的目录找出来');
      appendAiMsg('assistant', '可以这样查:\\n\\n\\\`\\\`\\\`bash\\ndu -xhd1 / | sort -rh | head -10\\n\\\`\\\`\\\`\\n先看根分区'); 
      return true;
    })()`);
    await sleep(300);

    // ① 结构:对话区可聚焦 + 文字可选中
    const struct = JSON.parse(await evaluate(c, `(function(){
      var chat = document.getElementById('ai-chat');
      var body = document.querySelector('.ai-msg-body');
      return JSON.stringify({ tabindex: chat.getAttribute('tabindex'),
        chatSel: getComputedStyle(chat).userSelect || getComputedStyle(chat).webkitUserSelect,
        bodySel: getComputedStyle(body).userSelect || getComputedStyle(body).webkitUserSelect,
        msgCopy: !!document.querySelector('.ai-msg-copy'),
        codeCopy: !!document.querySelector('.ai-copy'),
        reversed: (function(){ var s=getComputedStyle(chat); return null; })() });
    })()`));
    if (struct.tabindex === '-1') ok('① AI 对话区可聚焦(tabindex=-1)');
    else bad('① 对话区没有 tabindex,焦点只能掉到 BODY', String(struct.tabindex));
    if (/text/.test(String(struct.chatSel)) && /text/.test(String(struct.bodySel))) ok('① 对话区与消息体 user-select: text');
    else bad('① 气泡文字被 user-select 挡掉', JSON.stringify([struct.chatSel, struct.bodySel]));
    if (struct.msgCopy && struct.codeCopy) ok('① 每条消息/代码块都有复制按钮');
    else bad('① 缺复制按钮入口', JSON.stringify(struct));

    // ② 在对话区按下鼠标 → 焦点到对话区(不再掉 BODY,按键兜底就不会劫持 ⌘C)
    const focusInfo = JSON.parse(await evaluate(c, `(function(){
      document.body.focus && document.body.focus();
      var body = document.querySelectorAll('.ai-msg-body')[1];
      body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
      var ae = document.activeElement;
      return JSON.stringify({ id: ae ? ae.id : null, cls: ae ? ae.className : null, bodyFocused: ae === document.body });
    })()`));
    if (focusInfo.id === 'ai-chat') ok('② 点消息体 → 焦点落在 #ai-chat');
    else bad('② 点击后焦点仍在 ' + JSON.stringify(focusInfo));

    // ③ 焦点在对话区:选中文字后按 ⌘C,全局兜底不得 preventDefault(否则原生复制被吞)
    const copyKey = JSON.parse(await evaluate(c, `(function(){
      // handler 在"没有任何标签页"时会整体早退;用户现场是连着主机 → 造个假标签还原真实路径
      state.tabs.set('__fakeC', { term: { focus: function(){}, textarea: null }, status: 'connected' });
      state.activeSessionId = '__fakeC';
      var body = document.querySelectorAll('.ai-msg-body')[1];
      var range = document.createRange(); range.selectNodeContents(body);
      var sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
      var ev = new KeyboardEvent('keydown', { key: 'c', code: 'KeyC', bubbles: true, cancelable: true,
        metaKey: navigator.platform.toUpperCase().includes('MAC'), ctrlKey: !navigator.platform.toUpperCase().includes('MAC') });
      document.activeElement.dispatchEvent(ev);
      var r = { prevented: ev.defaultPrevented, selLen: sel.toString().length };
      state.tabs.delete('__fakeC');
      return JSON.stringify(r);
    })()`));
    if (copyKey.selLen > 0 && copyKey.prevented === false) ok(`③ 选中 ${copyKey.selLen} 字后 ⌘C 未被拦截(原生复制可用)`);
    else bad('③ ⌘C 被全局兜底 preventDefault 吞掉(正是"不能复制"的根因)', JSON.stringify(copyKey));

    // 还有一条真实路径:焦点在 BODY + 对话区有选中文字 → 也必须放行 ⌘C
    const bodyCopy = JSON.parse(await evaluate(c, `(function(){
      state.tabs.set('__fakeB', { term: { focus: function(){}, textarea: null }, status: 'connected' });
      state.activeSessionId = '__fakeB';
      var body = document.querySelectorAll('.ai-msg-body')[1];
      var range = document.createRange(); range.selectNodeContents(body);
      var sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
      document.body.focus && document.body.focus();
      var ev = new KeyboardEvent('keydown', { key: 'c', code: 'KeyC', bubbles: true, cancelable: true,
        metaKey: navigator.platform.toUpperCase().includes('MAC'), ctrlKey: !navigator.platform.toUpperCase().includes('MAC') });
      window.dispatchEvent(ev);
      var r2 = { prevented: ev.defaultPrevented };
      state.tabs.delete('__fakeB');
      return JSON.stringify(r2);
    })()`));
    if (bodyCopy.prevented === false) ok('③ BODY 焦点 + 有选中文字 → ⌘C 也放行(不转发终端)');
    else bad('③ BODY 焦点下 ⌘C 仍被吞(选中文字后按复制无反应)', JSON.stringify(bodyCopy));

    // ④ 焦点在对话区:⌘A = 全选对话记录
    const selectAll = JSON.parse(await evaluate(c, `(function(){
      // handler 在「没有标签页」时会整体早退(state.tabs.size===0),这里补个假标签让路由逻辑真正跑
      state.tabs.set('__fake0', { term: { focus: function(){}, textarea: null }, status: 'connected' });
      state.activeSessionId = '__fake0';
      document.getElementById('ai-chat').focus();
      var ev = new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', bubbles: true, cancelable: true,
        metaKey: navigator.platform.toUpperCase().includes('MAC'), ctrlKey: !navigator.platform.toUpperCase().includes('MAC') });
      document.activeElement.dispatchEvent(ev);
      var s = window.getSelection().toString();
      var out = { prevented: ev.defaultPrevented, len: s.length, hasQ: /磁盘占用/.test(s), hasCmd: /du -xhd1/.test(s) };
      state.tabs.delete('__fake0');
      return JSON.stringify(out);
    })()`));
    if (selectAll.prevented && selectAll.hasQ && selectAll.hasCmd) ok(`④ ⌘A 全选整段对话(${selectAll.len} 字,含提问与命令)`);
    else bad('④ ⌘A 在对话区没全选对话(被当终端全选/页面全选)', JSON.stringify(selectAll));

    // ⑤ 普通字符键在对话区仍转发给终端(不能为了复制把输入弄坏)
    const fwd = JSON.parse(await evaluate(c, `(function(){
      // 造一个假标签:只提供 handler 需要的 term.focus / term.textarea
      var ta = document.createElement('textarea'); ta.id = '__fake_term_ta'; document.body.appendChild(ta);
      var got = [];
      ta.addEventListener('keydown', function(e){ got.push(e.key); });
      // 真 xterm 的 term.focus() 会把焦点交给隐藏 textarea,这里照做(否则假标签下判断不到焦点归还)
      state.tabs.set('__fake', { term: { focus: function(){ try { ta.focus(); } catch (e) {} }, textarea: ta }, status: 'connected' });
      state.activeSessionId = '__fake';
      document.getElementById('ai-chat').focus();
      var ev = new KeyboardEvent('keydown', { key: 'l', code: 'KeyL', bubbles: true, cancelable: true });
      document.activeElement.dispatchEvent(ev);
      var r = { prevented: ev.defaultPrevented, forwarded: got.slice(), focusNow: document.activeElement === ta };
      state.tabs.delete('__fake'); try { ta.remove(); } catch (e) {}
      return JSON.stringify(r);
    })()`));
    if (fwd.prevented && fwd.forwarded.includes('l') && fwd.focusNow) ok('⑤ 普通字符键仍转发给终端(焦点还回终端)');
    else bad('⑤ 普通按键没转发终端(输入会失效)', JSON.stringify(fwd));

    // ⑤b 对话区按组合键但没选中文字(例如 Ctrl+C)→ 既不放行给终端发 ^C,也不拦截
    const plainMod = JSON.parse(await evaluate(c, `(function(){
      var ta = document.createElement('textarea'); document.body.appendChild(ta);
      var got = []; ta.addEventListener('keydown', function(e){ got.push(e.key); });
      state.tabs.set('__fakeM', { term: { focus: function(){ try { ta.focus(); } catch (e) {} }, textarea: ta }, status: 'connected' });
      state.activeSessionId = '__fakeM';
      window.getSelection().removeAllRanges();
      document.getElementById('ai-chat').focus();
      var ev = new KeyboardEvent('keydown', { key: 'c', code: 'KeyC', bubbles: true, cancelable: true,
        metaKey: navigator.platform.toUpperCase().includes('MAC'), ctrlKey: !navigator.platform.toUpperCase().includes('MAC') });
      document.activeElement.dispatchEvent(ev);
      var r = { prevented: ev.defaultPrevented, forwarded: got.slice(), focusStay: document.activeElement && document.activeElement.id };
      state.tabs.delete('__fakeM'); try { ta.remove(); } catch (e) {}
      return JSON.stringify(r);
    })()`));
    if (plainMod.prevented === false && plainMod.forwarded.length === 0) ok('⑤b 对话区无选中时按 ⌘/Ctrl+C 不转发终端(不会误发 ^C 打断命令)');
    else bad('⑤b 对话区组合键被转发成终端信号(会静默打断远端命令)', JSON.stringify(plainMod));

    // ⑥ 消息复制按钮 → 剪贴板
    await evaluate(c, `(function(){ var b=document.querySelectorAll('.ai-msg')[1].querySelector('.ai-msg-copy'); b.click(); return true; })()`);
    await sleep(300);
    const clip1 = await evaluate(c, `window.api.readClipboard()`);
    const want1 = '可以这样查:\n\ndu -xhd1 / | sort -rh | head -10\n	先看根分区';
    if (String(clip1).includes('du -xhd1 / | sort -rh | head -10')) ok(`⑥ 「📋」复制整条消息到剪贴板(${String(clip1).length} 字)`);
    else bad('⑥ 消息复制按钮没写剪贴板', JSON.stringify(String(clip1).slice(0, 120)) + ' vs ' + JSON.stringify(want1));

    // ⑦ 代码块「复制命令」按钮 → 剪贴板
    await evaluate(c, `(function(){ var b=document.querySelector('.ai-copy'); if(b) b.click(); return true; })()`);
    await sleep(300);
    const clip2 = await evaluate(c, `window.api.readClipboard()`);
    if (String(clip2).trim() === 'du -xhd1 / | sort -rh | head -10') ok('⑦ 代码块「复制命令」只复制命令本体');
    else bad('⑦ 代码块复制内容不对', JSON.stringify(String(clip2).slice(0, 120)));

    // ⑧ 摘掉 selection 不影响后续(清理:避免残留选中让后面的用例误判)
    await evaluate(c, `window.getSelection().removeAllRanges(); document.getElementById('ai-chat').blur(); true`);

    console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  } catch (e) { console.error('\n测试异常:', e && (e.stack || e.message)); failed++; console.log(`\n结果: ${passed} 通过, ${failed} 失败`); }
  try { killTree(appProc); } catch { /* ignore */ }
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(failed ? 1 : 0);
})();
