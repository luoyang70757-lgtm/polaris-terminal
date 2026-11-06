'use strict';
const { freePort, killTree, guardTimeout, evaluate } = require('./test-helper');
/**
 * verify-theme.js — 验证主题系统(v1.0.8:10 套 Tabby/iTerm2 精选配色 + 旧键迁移 + 对比度保底):
 *  ① 下拉 = auto + 10 套预设(深色 8 / 浅色 2),旧键已不在下拉里
 *  ② 旧主题键自动迁移:dark→tokyonight、catppuccinMocha→iceberg、已删主题→默认
 *  ③ 派生正确:iceberg → --bg/--text/--border;浅色方向 --border 比 bg 深
 *  ④ 对比度保底:10 套逐个 apply,正文 ≥4.5、次要文字 ≥3.0(换任意配色都不糊)
 *  ⑤ auto 跟随系统:深色 → Tokyo Night,浅色 → GitHub 浅
 * 运行: node verify-theme.js(需 9370 空闲;--dev 临时数据目录)
 */
const { spawn } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-theme-'));
const PORT = 9366;
const appProc = spawn(require('electron'), ['.', '--dev', `--remote-debugging-port=${PORT}`, '--no-sandbox', '--disable-gpu'], {
  env: { ...process.env, POLARIS_LOCK_DIR: DIR, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  stdio: ['ignore', 'ignore', 'ignore'], detached: true,
});
guardTimeout(100000, appProc);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function listTargets() { for (let i = 0; i < 40; i++) { try { const r = await fetch(`http://127.0.0.1:${PORT}/json`); return await r.json(); } catch {} await sleep(400); } throw new Error('targets 未就绪'); }
function connect(url) { return new Promise((resolve, reject) => { const ws = new WebSocket(url); let id = 0; const pending = new Map(); ws.onopen = () => resolve({ call(m, p = {}) { return new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method: m, params: p })); }); }, close() { ws.close(); } }); ws.onerror = (e) => reject(e); ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } }; }); }
// CDP 求值(ReferenceError 自动重试,见 test-helper.evaluate)
async function ev(c, expr) { return evaluate(c, expr); }
let passed = 0, failed = 0;
const ok = (n) => { passed++; console.log('  ✓ ' + n); };
const bad = (n, e) => { failed++; console.error('  ✗ ' + n + (e ? ' -> ' + e : '')); };
async function check(c, name, expr, expect = true) { try { const v = await ev(c, expr); if (v === expect) ok(name); else bad(name, `got ${JSON.stringify(v)}`); } catch (e) { bad(name, e.message); } }
const cssVar = (k) => `document.documentElement.style.getPropertyValue('${k}').trim()`;
const applyTheme = (v) => `(function(){var s=document.getElementById('set-theme');s.value='${v}';s.dispatchEvent(new Event('change'));})()`;
const emulatedMedia = async (c, scheme) => c.call('Emulation.setEmulatedMedia', { media: '', features: [{ name: 'prefers-color-scheme', value: scheme }] });

(async () => {
  console.log('\n=== 主题系统(10 套 Tabby 精选 + 旧键迁移 + 对比度保底 + auto) ===\n');
  try {
    const ts0 = await listTargets();
    const lockT = ts0.find((t) => /解锁/.test(t.title || '')) || ts0.find((t) => t.type === 'page');
    const lock = await connect(lockT.webSocketDebuggerUrl);
    for (let i = 0; i < 30; i++) { if (await ev(lock, `!!document.getElementById('pw')`)) break; await sleep(300); }
    await ev(lock, `document.getElementById('pw').value='x1234567'; document.getElementById('pw2').value='x1234567'; document.getElementById('btn').click();`);
    let c = null;
    for (let i = 0; i < 30; i++) { await sleep(400); const t2 = await listTargets(); const m = t2.find((t) => t.type === 'page' && !/解锁/.test(t.title || '')); if (m) { c = await connect(m.webSocketDebuggerUrl); break; } }
    if (!c) throw new Error('主窗口未就绪');
    // 同 verify-applog:等 renderer.js 真正执行完再调用其全局函数。
    for (let i = 0; i < 50; i++) {
      if (await ev(c, `typeof openSettingsModal === 'function'`)) break;
      await sleep(200);
    }

    // 打开设置弹窗(下拉选项由 openSettingsModal() 动态构建,启动时为空)
    await ev(c, 'openSettingsModal()'); await sleep(150);

    // ① 下拉结构
    await check(c, '下拉含「跟随系统(auto)」选项', `(function(){var s=document.getElementById('set-theme');return !!s.querySelector('option[value="auto"]');})()`);
    await check(c, '下拉分 深色/浅色 两个 optgroup', `document.getElementById('set-theme').querySelectorAll('optgroup').length===2`);
    await check(c, '选项总数 = auto + 10 套精选预设', `document.getElementById('set-theme').options.length===11`);
    await check(c, '10 套预设齐全(8 深 + 2 浅)',
      `['tokyonight','dracula','nord','solarizedDark','gruvboxDark','oneHalfDark','iceberg','rosePine','github','oneHalfLight'].every(function(k){return !!document.getElementById('set-theme').querySelector('option[value="'+k+'"]');})`);
    await check(c, '深色 8 套 / 浅色 2 套',
      `(function(){var g=document.getElementById('set-theme').querySelectorAll('optgroup');return g[0].children.length===8 && g[1].children.length===2;})()`);
    await check(c, '旧主题键不再出现在下拉里(自研 10 套已换掉)',
      `!['dark','light','termiusDark','termiusLight','catppuccinMocha','kanagawaWave','nightOwl','everforestDark','aura','onedark'].some(function(k){return !!document.getElementById('set-theme').querySelector('option[value="'+k+'"]');})`);

    // ② 旧键迁移:老用户存的 dark/light/termius*/catppuccinMocha 都要落到对应新配色
    await check(c, '旧键 dark → Tokyo Night(--bg=#1a1b26)',
      `(function(){state.settings.theme='dark';applyTheme();var ok=getComputedStyle(document.body).getPropertyValue('--bg').trim()==='#1a1b26';state.settings.theme='tokyonight';applyTheme();return ok;})()`);
    await check(c, '旧键 catppuccinMocha → Iceberg(--bg=#161821)',
      `(function(){state.settings.theme='catppuccinMocha';applyTheme();return getComputedStyle(document.body).getPropertyValue('--bg').trim()==='#161821';})()`);
    await check(c, '已删主题(kanagawaWave)→ 回落默认 Tokyo Night',
      `(function(){state.settings.theme='kanagawaWave';applyTheme();return getComputedStyle(document.body).getPropertyValue('--bg').trim()==='#1a1b26';})()`);
    await check(c, '旧键 light → GitHub 浅(--bg=#f4f4f4)',
      `(function(){state.settings.theme='light';applyTheme();return getComputedStyle(document.body).getPropertyValue('--bg').trim()==='#f4f4f4';})()`);

    // ③ 派生正确(iceberg:bg #161821 / fg #c6c8d1,对比度足够 → 原样保留)
    await ev(c, applyTheme('iceberg')); await sleep(120);
    await check(c, 'iceberg → --bg = #161821', `${cssVar('--bg')}==='#161821'`);
    await check(c, 'iceberg → --text = #c6c8d1', `${cssVar('--text')}==='#c6c8d1'`);
    await check(c, 'iceberg → --border = #3b3d45(提亮方向)', `${cssVar('--border')}==='#3b3d45'`);
    await check(c, 'iceberg → --bg-panel = #22242c', `${cssVar('--bg-panel')}==='#22242c'`);

    // 浅色方向:--border 比 bg 深
    await ev(c, applyTheme('oneHalfLight')); await sleep(120);
    await check(c, 'oneHalfLight → --bg = #fafafa', `${cssVar('--bg')}==='#fafafa'`);
    const borderDir = await ev(c, `(function(){var d=function(x){x=x.replace('#','');return [0,2,4].map(function(i){return parseInt(x.slice(i,i+2),16)});};var bg=d(document.documentElement.style.getPropertyValue('--bg')),bd=d(document.documentElement.style.getPropertyValue('--border'));return bd[0]+bd[1]+bd[2] < bg[0]+bg[1]+bg[2];})()`);
    if (borderDir) ok('oneHalfLight → --border 比 bg 深(浅色方向)'); else bad('oneHalfLight → --border 比 bg 深(浅色方向)');

    // ④ 全部 10 套:正文 ≥4.5、次要文字 ≥3.0(派生层做了对比度保底)
    const worst = await ev(c, `(function(){
      var lum=function(h){h=h.replace('#','');var c=[0,2,4].map(function(i){var v=parseInt(h.slice(i,i+2),16)/255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4)});return 0.2126*c[0]+0.7152*c[1]+0.0722*c[2]};
      var cr=function(a,b){var A=lum(a),B=lum(b);return (Math.max(A,B)+0.05)/(Math.min(A,B)+0.05)};
      var out={fg:99,dim:99,names:[]};var old=state.settings.theme;
      Object.keys(THEMES).forEach(function(k){
        state.settings.theme=k;applyTheme();
        var bg=document.documentElement.style.getPropertyValue('--bg').trim();
        var fg=document.documentElement.style.getPropertyValue('--text').trim();
        var dim=document.documentElement.style.getPropertyValue('--text-dim').trim();
        out.fg=Math.min(out.fg,cr(fg,bg));out.dim=Math.min(out.dim,cr(dim,bg));out.names.push(k);
      });
      state.settings.theme=old;applyTheme();return out;})()`);
    if (worst && worst.fg >= 4.5) ok(`10 套正文对比度最低 ${worst.fg.toFixed(2)} ≥ 4.5`);
    else bad('有主题正文对比度 < 4.5', JSON.stringify(worst));
    if (worst && worst.dim >= 3.0) ok(`10 套次要文字对比度最低 ${worst.dim.toFixed(2)} ≥ 3.0`);
    else bad('有主题次要文字对比度 < 3.0', JSON.stringify(worst));
    if (worst && worst.names.length === 10) ok('遍历覆盖全部 10 套预设'); else bad('主题数量不对', JSON.stringify(worst && worst.names));

    // ⑤ auto 跟随系统
    await ev(c, applyTheme('auto')); await sleep(120);
    await emulatedMedia(c, 'dark'); await sleep(500);
    await check(c, 'auto + 系统深色 → Tokyo Night(--bg=#1a1b26)', `${cssVar('--bg')}==='#1a1b26'`);
    await emulatedMedia(c, 'light'); await sleep(500);
    await check(c, 'auto + 系统浅色 → GitHub 浅(--bg=#f4f4f4)', `${cssVar('--bg')}==='#f4f4f4'`);
    await emulatedMedia(c, 'dark'); await sleep(300); // 复原

    console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  } catch (e) { console.error('\n测试异常:', e && e.message); failed++; console.log(`\n结果: ${passed} 通过, ${failed} 失败`); }
  try { process.kill(-appProc.pid, 'SIGKILL'); } catch {}
  process.exit(failed ? 1 : 0);
})();
