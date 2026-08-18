'use strict';
/**
 * verify-enc-probe.js — 验证「连接后自动探测服务器字符集」的探针生命周期:
 *   ① 连接成功后 startEncodingProbe 已启动(t.encProbe 存在,默认 utf8 的 SSH 会话)
 *   ② 用户手动指定编码(如 gbk)的会话不探测
 *   ③ mock 不返回真实 locale → 3s 超时兜底,encProbe 被清掉(不卡会话)
 *   ④ langToEncoding 映射(UTF-8/GBK/gb18030/big5/C)
 * 运行: node verify-enc-probe.js(--dev 临时数据目录,mock SSH 127.0.0.1:2222)
 */
const { spawn } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-enc-'));
const PORT = 9374; const SSH = 2222;
const appProc = spawn('node_modules/.bin/electron', ['.', '--dev', `--remote-debugging-port=${PORT}`, '--no-sandbox', '--disable-gpu'], {
  env: { ...process.env, POLARIS_LOCK_DIR: DIR, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  stdio: ['ignore', 'ignore', 'ignore'], detached: true,
});
setTimeout(() => { try { process.kill(-appProc.pid, 'SIGKILL'); } catch {} process.exit(1); }, 120000).unref();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function targets() { for (let i = 0; i < 40; i++) { try { const r = await fetch(`http://127.0.0.1:${PORT}/json`); const j = await r.json(); const p = j.find((t) => t.type === 'page' && /解锁|Polaris/.test(t.title || '')); if (p) return j; } catch {} await sleep(400); } throw new Error('targets 未就绪'); }
function connect(url) { return new Promise((resolve, reject) => { const ws = new WebSocket(url); let id = 0; const pending = new Map(); ws.onopen = () => resolve({ call(m, p = {}) { return new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method: m, params: p })); }); } }); ws.onerror = reject; ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } }; }); }
async function ev(c, expr, tries = 3) { let r; for (let i = 0; i < tries; i++) { r = await c.call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r && !r.error) break; await sleep(300); } if (r && r.exceptionDetails) throw new Error('JS异常 ' + JSON.stringify(r.exceptionDetails).slice(0, 300)); return r && r.result && r.result.value; }
let passed = 0, failed = 0;
const ok = (n, d) => { passed++; console.log('  ✓ ' + n + (d ? '  → ' + d : '')); };
const bad = (n, e) => { failed++; console.error('  ✗ ' + n + (e ? '  → ' + e : '')); };

(async () => {
  console.log('\n=== 连接后自动探测字符集 ===\n');
  try {
    const ts = await targets();
    const lockT = ts.find((t) => /解锁/.test(t.title || ''));
    if (!lockT) throw new Error('锁定页未就绪');
    const lock = await connect(lockT.webSocketDebuggerUrl);
    for (let i = 0; i < 40; i++) { if (await ev(lock, `!!document.getElementById('pw')`)) break; await sleep(300); }
    await ev(lock, `document.getElementById('pw').value='x1234567'; document.getElementById('pw2').value='x1234567'; document.getElementById('btn').click();`);
    let c = null;
    for (let i = 0; i < 50; i++) { await sleep(400); const t2 = await targets(); const m = t2.find((t) => t.type === 'page' && !/解锁/.test(t.title || '')); if (m) { c = await connect(m.webSocketDebuggerUrl); break; } }
    if (!c) throw new Error('主窗口未就绪');

    // ① 默认 utf8 会话:连接后探针启动
    await ev(c, `(async()=>{ await window.api.createSession({name:'encA', host:'127.0.0.1', port:${SSH}, username:'admin', password:'admin123', protocol:'ssh'}); await loadSessions(); state.settings.sessionView='list'; renderSessionList(''); return true; })()`);
    await sleep(400);
    const aJson = await ev(c, `(function(){ const s=state.sessions.find(x=>x.name==='encA'); return s?JSON.stringify(s):'NOTFOUND'; })()`);
    if (aJson === 'NOTFOUND') throw new Error('encA 未创建');
    await ev(c, `connectToServer(${aJson})`);
    let sid = null;
    for (let i = 0; i < 30; i++) { sid = await ev(c, `(state.tabs.size ? [...state.tabs.keys()][0] : null)`); if (sid && await ev(c, `state.tabs.get('${sid}').status`) === 'connected') break; await sleep(300); }
    if (!sid) throw new Error('会话未连上');
    await sleep(400);
    const probeActive = await ev(c, `!!state.tabs.get('${sid}').encProbe`);
    if (probeActive) ok('① 连接后探针已启动(encProbe 存在)'); else bad('① 探针未启动');

    // ③ mock 不返回 locale → 3s 超时清理
    await sleep(3200);
    const probeGone = await ev(c, `!state.tabs.get('${sid}').encProbe`);
    if (probeGone) ok('③ 探针 3s 超时兜底,已清理(不卡会话)'); else bad('③ 探针未超时清理');

    // ② 手动指定编码的会话不探测
    await ev(c, `(async()=>{ await window.api.createSession({name:'encB', host:'127.0.0.1', port:${SSH}, username:'admin', password:'admin123', protocol:'ssh', encoding:'gbk'}); await loadSessions(); renderSessionList(''); return true; })()`);
    await sleep(400);
    const bJson = await ev(c, `(function(){ const s=state.sessions.find(x=>x.name==='encB'); return s?JSON.stringify(s):'NOTFOUND'; })()`);
    await ev(c, `connectToServer(${bJson})`);
    let sid2 = null;
    for (let i = 0; i < 30; i++) { sid2 = await ev(c, `(state.tabs.size ? [...state.tabs.keys()][0] : null)`); if (sid2 && await ev(c, `state.tabs.get('${sid2}').status`) === 'connected' && sid2 !== sid) break; await sleep(300); }
    await sleep(300);
    const noProbe = await ev(c, `!state.tabs.get('${sid2}').encProbe`);
    if (noProbe) ok('② 手动指定 gbk 的会话不探测(尊重用户设置)'); else bad('② 手动指定编码仍在探测');

    // ④ langToEncoding 映射
    const map = await ev(c, `(function(){
      const tests = { 'zh_CN.UTF-8':'utf8', 'zh_CN.GBK':'gbk', 'zh_CN.GB18030':'gb18030', 'zh_TW.Big5':'big5', 'C':'utf8', '':'utf8' };
      let bad = [];
      for (const [k,v] of Object.entries(tests)) if (langToEncoding(k) !== v) bad.push(k+'→'+langToEncoding(k));
      return bad.length ? bad.join(',') : 'OK';
    })()`);
    if (map === 'OK') ok('④ langToEncoding 映射全部正确'); else bad('④ 映射错误: ' + map);

    console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  } catch (e) { console.error('\n测试异常:', e && e.message); failed++; console.log(`\n结果: ${passed} 通过, ${failed} 失败`); }
  try { process.kill(-appProc.pid, 'SIGKILL'); } catch {}
  process.exit(failed ? 1 : 0);
})();
