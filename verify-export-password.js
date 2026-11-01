'use strict';
/**
 * verify-export-password.js — 导出加密备份的密码框必须能输入(回归)
 *
 * 用户症状:「设置导出密码功能失效,无法输入密码」。
 * 根因:弹窗打开后焦点被终端/原生菜单/堡垒机 webview 抢回,按键经 BODY 兜底转发进终端,
 *       密码框始终为空。修复:
 *   ① 打开弹窗立即聚焦 + rAF/50ms/250ms 补聚焦;
 *   ② 全局 focusin:焦点落到弹窗外时拉回最上层弹窗第一个可输入元素;
 *   ③ 全局 keydown:BODY 焦点且弹窗打开时绝不转发终端;
 *   ④ 密码长度提示 4/8 不一致修正(渲染层/后端统一 8 位)。
 *
 * 断言:
 *   ① 打开导出密码弹窗后,即使焦点被终端抢走,300ms 内会回到密码框;
 *   ② 真实键入能写进密码框;
 *   ③ 焦点掉到 BODY 后仍能恢复并输入;
 *   ④ 4 位密码被拒绝并提示“密码至少 8 位”;
 *   ⑤ 后端 sessions:export 同样拒绝 <8 位(不会弹保存框);
 *   ⑥ 修改密码弹窗同样具备焦点锁。
 *
 * 运行:node verify-export-password.js(需 9481/2311/2411 空闲)
 */
const { spawn } = require('child_process');
const { freePort, killTree, guardTimeout, evaluate } = require('./test-helper');
const fs = require('fs'); const os = require('os'); const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-expwd-'));
const PORT = 9481, SSH = 2311, HTTP = 2411;
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
      const r = await fetch(`http://127.0.0.1:${PORT}/json`, { signal: AbortSignal.timeout(3000) });
      const j = await r.json();
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
// CDP 求值(ReferenceError 自动重试,见 test-helper.evaluate)
async function ev(c, expr) { return evaluate(c, expr); }
const activeId = (c) => ev(c, `document.activeElement && document.activeElement.id || (document.activeElement && document.activeElement.tagName)`);
let passed = 0, failed = 0;
const ok = (n) => { passed++; console.log('  ✓ ' + n); };
const bad = (n, e) => { failed++; console.error('  ✗ ' + n + (e ? ' → ' + e : '')); };

(async () => {
  console.log('\n=== 导出密码框输入 / 焦点锁 ===\n');
  try {
    const lockT = (await targets()).find((t) => /解锁/.test(t.title || ''));
    const lock = await connect(lockT.webSocketDebuggerUrl);
    for (let i = 0; i < 40; i++) { if (await ev(lock, `!!document.getElementById('pw')`)) break; await sleep(300); }
    await sleep(300);
    await ev(lock, `document.getElementById('pw').value='x1234567'; document.getElementById('pw2').value='x1234567'; document.getElementById('btn').click();`);
    let c = null;
    for (let i = 0; i < 40; i++) {
      await sleep(400);
      const t2 = await targets();
      const m = t2.find((t) => t.type === 'page' && !/解锁/.test(t.title || ''));
      if (m) { c = await connect(m.webSocketDebuggerUrl); break; }
    }
    if (!c) throw new Error('解锁后主窗口未出现');
    for (let i = 0; i < 50; i++) { if (await ev(c, `typeof state === 'object' && !!state.settings`)) break; await sleep(200); }

    // 建会话并连接,确保有一个真实终端(焦点争抢的实际场景)
    await ev(c, `(async()=>{ await window.api.createSession({name:'exp',host:'127.0.0.1',port:${SSH},username:'admin',password:'admin123'}); await loadSessions(); connectToServer(state.sessions[0]); return true; })()`);
    for (let i = 0; i < 40; i++) { if (await ev(c, `state.tabs.size > 0`)) break; await sleep(300); }
    await sleep(800);

    // ① 打开弹窗 + 模拟焦点被终端抢走
    await ev(c, `(function(){ promptFilePwd('set', {type:'export', data:[]}); const t=[...state.tabs.values()][0]; t.term.focus(); return true; })()`);
    await sleep(350);
    const id1 = await activeId(c);
    if (id1 === 'file-pwd-input') ok('焦点被终端抢走后自动回到密码框');
    else bad('焦点未回到密码框', String(id1));

    // ② 真实键入
    await c.call('Input.insertText', { text: 'abcd1234' });
    await sleep(120);
    const v1 = await ev(c, `document.getElementById('file-pwd-input').value`);
    if (v1 === 'abcd1234') ok('密码框可正常输入');
    else bad('密码框输入失败', JSON.stringify(v1));

    // ③ 焦点掉到 BODY 后恢复
    await ev(c, `document.activeElement && document.activeElement.blur && document.activeElement.blur(); true`);
    await sleep(400);
    const id2 = await activeId(c);
    await c.call('Input.insertText', { text: 'X' });
    await sleep(120);
    const v2 = await ev(c, `document.getElementById('file-pwd-input').value`);
    if (id2 === 'file-pwd-input' && v2.endsWith('X')) ok('焦点掉到 BODY 后仍能恢复输入');
    else bad('BODY 焦点未恢复', JSON.stringify({ id2, v2 }));

    // ④ 真实导出入口不再调用原生 confirm(Windows 焦点恢复问题源),直接开密码弹窗并带数量提示
    const exp = await ev(c, `(function(){
      let called = false;
      const old = window.confirm;
      window.confirm = function(){ called = true; return true; };
      exportSessions();
      window.confirm = old;
      return { called, hidden: els.filePwdModal.classList.contains('hidden'), hint: els.filePwdHint.textContent };
    })()`);
    if (!exp.called && !exp.hidden && /将导出/.test(exp.hint)) ok('导出入口不再走原生 confirm,直接打开密码弹窗');
    else bad('导出入口仍走 confirm / 未打开弹窗', JSON.stringify(exp));
    await ev(c, `closeFilePwd()`);

    // ⑤ 延迟 600ms 的焦点抢夺(Windows 原生菜单/对话框常见)也能被 1s 重试拉回
    await ev(c, `promptFilePwd('set', {type:'export', data:[]})`);
    await sleep(600);
    await ev(c, `(function(){ const t=[...state.tabs.values()][0]; t.term.focus(); return true; })()`);
    await sleep(500);
    const idLate = await activeId(c);
    if (idLate === 'file-pwd-input') ok('延迟焦点抢夺后仍能自动拉回');
    else bad('延迟焦点未拉回', String(idLate));

    // ⑥ 4 位密码被拒 + 提示 8 位;标签同步为 8 位
    const short = await ev(c, `(function(){
      const a=document.getElementById('file-pwd-input'), b=document.getElementById('file-pwd-input2');
      a.value='abcd'; b.value='abcd'; document.getElementById('file-pwd-ok').click();
      return { label:document.getElementById('file-pwd-label').textContent,
        msg:document.getElementById('file-pwd-msg').textContent,
        hidden:document.getElementById('file-pwd-modal').classList.contains('hidden') };
    })()`);
    if (!short.hidden && /至少\s*8\s*位/.test(short.msg) && /至少\s*8\s*位/.test(short.label)) ok('4 位密码被拒且提示/标签均为 8 位');
    else bad('长度校验/提示不一致', JSON.stringify(short));

    // ⑦ 后端同样拒绝 <8 位(校验在弹保存框之前,不会卡住)
    const be = await ev(c, `window.api.exportSessions([], '1234')`);
    if (be && be.ok === false && /8\s*位/.test(be.error || '')) ok('后端导出同样拒绝 <8 位');
    else bad('后端未拒绝短密码', JSON.stringify(be));

    await ev(c, `closeFilePwd()`);

    // ⑧ 导入加密备份:导入弹窗仍开着,密码弹窗叠在上面
    //    —— 按键必须进顶层密码框(旧版 querySelector 取到背后的导入弹窗,导致输入无效)
    await ev(c, `(function(){
      openImportModal();
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array([1,2,3])], 'x.polaris'));
      els.importBackupFile.files = dt.files;
      importBackupSelected();
      return true;
    })()`);
    await sleep(500);
    const imp = await ev(c, `(function(){
      const t=[...state.tabs.values()][0]; t.term.focus(); // 模拟焦点被终端抢回
      return { importVisible:!els.importModal.classList.contains('hidden'), pwdVisible:!els.filePwdModal.classList.contains('hidden') };
    })()`);
    await sleep(350);
    const impActive = await activeId(c);
    // 发真实 keydown(insertText 不经过 window keydown,测不出守卫选错弹窗)
    for (const ch of ['a', 'b', 'c']) {
      const vk = ch.toUpperCase().charCodeAt(0);
      await c.call('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, code: 'Key' + ch.toUpperCase(), text: ch, unmodifiedText: ch, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
      await c.call('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code: 'Key' + ch.toUpperCase(), windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
    }
    await sleep(200);
    const impVal = await ev(c, `document.getElementById('file-pwd-input').value`);
    if (imp.importVisible && imp.pwdVisible && impActive === 'file-pwd-input' && impVal === 'abc') ok('导入备份:双弹窗叠加时按键进入顶层密码框');
    else bad('导入备份双弹窗焦点/按键异常', JSON.stringify({ imp, impActive, impVal }));
    await ev(c, `closeFilePwd(); closeImportModal();`);

    // ⑨ 修改 App 密码弹窗同样具备焦点锁
    await ev(c, `(function(){ openPwdModal(); const t=[...state.tabs.values()][0]; t.term.focus(); return true; })()`);
    await sleep(350);
    const id3 = await activeId(c);
    if (id3 === 'pwd-current') ok('修改密码弹窗焦点被抢后也能恢复');
    else bad('修改密码弹窗焦点未恢复', String(id3));
    await ev(c, `closePwdModal()`);

    console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  } catch (e) {
    console.error('\n测试异常:', e && e.message);
    failed++;
  }
  try { killTree(appProc); } catch { /* ignore */ }
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(failed ? 1 : 0);
})();
