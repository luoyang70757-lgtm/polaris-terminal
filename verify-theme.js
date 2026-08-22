'use strict';
/**
 * verify-theme.js — 验证主题系统升级:
 *  ① 下拉含「跟随系统(auto)」+ 深/浅 optgroup 分组,共 21 项(auto + 20 预设)
 *  ② 新预设纯派生:catppuccinMocha → --bg=#1e1e2e;浅色派生方向(--border 比 bg 深)
 *  ③ 旧预设 css 覆盖优先:dark → --bg=#070c18(手写值,零回归)
 *  ④ auto 跟随系统:Emulation 切 dark/light → 即时切到 dark/浅色预设
 * 运行: node verify-theme.js(需 9370 空闲;--dev 临时数据目录)
 */
const { spawn } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-theme-'));
const PORT = 9370;
const appProc = spawn('node_modules/.bin/electron', ['.', '--dev', `--remote-debugging-port=${PORT}`, '--no-sandbox', '--disable-gpu'], {
  env: { ...process.env, POLARIS_LOCK_DIR: DIR, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  stdio: ['ignore', 'ignore', 'ignore'], detached: true,
});
setTimeout(() => { try { process.kill(-appProc.pid, 'SIGKILL'); } catch {} process.exit(1); }, 100000).unref();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function listTargets() { for (let i = 0; i < 40; i++) { try { const r = await fetch(`http://127.0.0.1:${PORT}/json`); return await r.json(); } catch {} await sleep(400); } throw new Error('targets 未就绪'); }
function connect(url) { return new Promise((resolve, reject) => { const ws = new WebSocket(url); let id = 0; const pending = new Map(); ws.onopen = () => resolve({ call(m, p = {}) { return new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method: m, params: p })); }); }, close() { ws.close(); } }); ws.onerror = (e) => reject(e); ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } }; }); }
async function ev(c, expr) { const r = await c.call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error('JS异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 500) + ' @ ' + expr.slice(0, 80)); return r.result && r.result.value; }
let passed = 0, failed = 0;
const ok = (n) => { passed++; console.log('  ✓ ' + n); };
const bad = (n, e) => { failed++; console.error('  ✗ ' + n + (e ? ' -> ' + e : '')); };
async function check(c, name, expr, expect = true) { try { const v = await ev(c, expr); if (v === expect) ok(name); else bad(name, `got ${JSON.stringify(v)}`); } catch (e) { bad(name, e.message); } }
const cssVar = (k) => `document.documentElement.style.getPropertyValue('${k}').trim()`;
const applyTheme = (v) => `(function(){var s=document.getElementById('set-theme');s.value='${v}';s.dispatchEvent(new Event('change'));})()`;
const emulatedMedia = async (c, scheme) => c.call('Emulation.setEmulatedMedia', { media: '', features: [{ name: 'prefers-color-scheme', value: scheme }] });

(async () => {
  console.log('\n=== 主题系统升级(auto 跟随系统 + 20 预设 + deriveUiTokens) ===\n');
  try {
    const ts0 = await listTargets();
    const lockT = ts0.find((t) => /解锁/.test(t.title || '')) || ts0.find((t) => t.type === 'page');
    const lock = await connect(lockT.webSocketDebuggerUrl);
    for (let i = 0; i < 30; i++) { if (await ev(lock, `!!document.getElementById('pw')`)) break; await sleep(300); }
    await ev(lock, `document.getElementById('pw').value='x1234567'; document.getElementById('pw2').value='x1234567'; document.getElementById('btn').click();`);
    let c = null;
    for (let i = 0; i < 30; i++) { await sleep(400); const t2 = await listTargets(); const m = t2.find((t) => t.type === 'page' && !/解锁/.test(t.title || '')); if (m) { c = await connect(m.webSocketDebuggerUrl); break; } }
    if (!c) throw new Error('主窗口未就绪');

    // 打开设置弹窗(下拉选项由 openSettingsModal() 动态构建,启动时为空)
    await ev(c, 'openSettingsModal()'); await sleep(150);

    // ① 下拉结构
    await check(c, '下拉含「跟随系统(auto)」选项', `(function(){var s=document.getElementById('set-theme');return !!s.querySelector('option[value="auto"]');})()`);
    await check(c, '下拉分 深色/浅色 两个 optgroup', `document.getElementById('set-theme').querySelectorAll('optgroup').length===2`);
    await check(c, '选项总数 = auto + 25 预设', `document.getElementById('set-theme').options.length===26`);
    await check(c, '新增预设已注册(12 + T4 新 5 套)', `['termiusDark','termiusLight','flexokiDark','flexokiLight','kanagawaWave','kanagawaDragon','kanagawaLotus','hackerBlue','hackerGreen','catppuccinMocha','catppuccinLatte','gruvboxDark','rosePine','nightOwl','everforestDark','everforestLight','aura'].every(function(k){return !!document.getElementById('set-theme').querySelector('option[value="'+k+'"]');})`);

    // ② 新预设纯派生
    await ev(c, applyTheme('catppuccinMocha')); await sleep(120);
    await check(c, 'catppuccinMocha → --bg 派生 = #1e1e2e', `${cssVar('--bg')}==='#1e1e2e'`);
    await check(c, 'catppuccinMocha → --text 派生 = #cdd6f4', `${cssVar('--text')}==='#cdd6f4'`);
    await check(c, 'catppuccinMocha → --border 派生 = #42424f(提亮方向)', `${cssVar('--border')}==='#42424f'`);

    // ③ 浅色派生方向(--border 比 bg 深)
    await ev(c, applyTheme('catppuccinLatte')); await sleep(120);
    await check(c, 'catppuccinLatte → --bg = #eff1f5', `${cssVar('--bg')}==='#eff1f5'`);
    const borderDir = await ev(c, `(function(){var d=function(x){x=x.replace('#','');return [0,2,4].map(function(i){return parseInt(x.slice(i,i+2),16)});};var bg=d(document.documentElement.style.getPropertyValue('--bg')),bd=d(document.documentElement.style.getPropertyValue('--border'));return bd[0]+bd[1]+bd[2] < bg[0]+bg[1]+bg[2];})()`);
    if (borderDir) ok('catppuccinLatte → --border 比 bg 深(浅色方向)'); else bad('catppuccinLatte → --border 比 bg 深(浅色方向)');

    // ④ 旧预设统一走派生(删手写 css)→ --bg 取 term.bg,零回归
    await ev(c, applyTheme('dark')); await sleep(120);
    await check(c, 'dark → --bg = #070c18(派生)', `${cssVar('--bg')}==='#070c18'`);
    await check(c, 'light → --bg = #ffffff(派生,原手写 #f5f6f8 已删)', `(function(){var s=document.getElementById('set-theme');s.value='light';s.dispatchEvent(new Event('change'));return document.documentElement.style.getPropertyValue('--bg').trim()==='#ffffff';})()`);

    // ⑤ auto 跟随系统(Emulation 模拟明暗切换)
    await ev(c, applyTheme('auto')); await sleep(120);
    await emulatedMedia(c, 'dark'); await sleep(200);
    await check(c, 'auto + 系统深色 → 深空(dark) --bg=#070c18', `${cssVar('--bg')}==='#070c18'`);
    await emulatedMedia(c, 'light'); await sleep(200);
    await check(c, 'auto + 系统浅色 → 浅色 --bg=#ffffff(派生)', `${cssVar('--bg')}==='#ffffff'`);
    await emulatedMedia(c, 'dark'); await sleep(150); // 复原

    console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  } catch (e) { console.error('\n测试异常:', e && e.message); failed++; console.log(`\n结果: ${passed} 通过, ${failed} 失败`); }
  try { process.kill(-appProc.pid, 'SIGKILL'); } catch {}
  process.exit(failed ? 1 : 0);
})();
