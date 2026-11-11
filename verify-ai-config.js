'use strict';
/**
 * verify-ai-config.js — AI 面板"配好就能用"回归
 *
 * 背景(用户反馈「AI 功能现在用不了」):
 *   ① 新加厂商时 url 为空 + 协议默认 anthropic,主进程 normalizeAiUrl 会静默回落到
 *      https://api.anthropic.com/v1/messages → 401/404,界面只有一句 HTTP 天书;
 *   ② 模型为空时静默回落到 'claude-sonnet-5' → DeepSeek 直接 400(模型名不支持);
 *   ③ 错误信息没有"去改哪个输入框"的提示。
 *
 * 本用例覆盖:
 *  ① HTTP 错误码 → 人话提示映射(纯 Node);
 *  ② 「＋ 新增厂商」默认就是能跑通的 DeepSeek 配置(地址/协议/模型都在);
 *  ③ ⚙「快速模板」选 DeepSeek → 地址/协议/模型落盘,且选完自动复位;
 *  ④ 接口地址为空 → ai:chat 直接返回可读错误(不再偷偷打到 api.anthropic.com);
 *  ⑤ 模型为空 → ai:chat 直接返回可读错误(不再偷偷用 claude-sonnet-5);
 *  ⑥ aiSend 前置校验:地址/模型缺失时弹提示并展开 ⚙,不发请求;
 *  ⑦ API Key 密文落盘(enc:v1:)且能解密回明文。
 *
 * 运行: node verify-ai-config.js
 *   端口 9398 / 2299 / 2399 需空闲。默认**不联网**;
 *   想顺带测真实连通:`POLARIS_AI_KEY=sk-xxx node verify-ai-config.js`(会真发一条 DeepSeek 请求)
 */
const { spawn } = require('child_process');
const { freePort, guardTimeout, evaluate } = require('./test-helper');
const fs = require('fs');
const os = require('os');
const path = require('path');
const aiStream = require('./lib/ai-stream');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-aicfg-'));
const PORT = 9398, SSH = 2299, HTTP = 2399;
freePort(PORT); freePort(SSH); freePort(HTTP);
process.env.MOCK_SSH_PORT = String(SSH);
process.env.MOCK_HTTP_PORT = String(HTTP);
require('./mock/mock-server').start();

const APP_PW = 'x1234567';
const REAL_KEY = process.env.POLARIS_AI_KEY || '';
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
  console.log('\n=== AI 面板配置:配好就能用 ===\n');
  try {
    // ---- ① 错误码 → 人话提示(纯 Node)----
    const hints = [
      [401, 'API Key 无效'], [402, '余额'], [404, '接口地址'], [429, '频繁'], [500, '服务端'],
    ];
    const hintOk = hints.every(([code, kw]) => (aiStream.aiErrorHint(code) || '').includes(kw));
    if (hintOk) ok('HTTP 401/402/404/429/5xx → 都带"去改哪里"的提示');
    else bad('错误码提示缺失或文案对不上', JSON.stringify(hints.map(([c]) => [c, aiStream.aiErrorHint(c)])));
    if (!aiStream.aiErrorHint(200)) ok('HTTP 200 不追加多余提示');
    else bad('200 被误加提示', aiStream.aiErrorHint(200));

    // ---- 起 App、解锁、进主窗口 ----
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
    await ev(c, `(function(){
      state.settings.onboardingDone = true; saveSettings();
      var om = document.getElementById('onboarding-modal'); if (om) om.classList.add('hidden');
      return true;
    })()`);

    // ---- ② ＋ 新增厂商:默认就是能跑通的 DeepSeek 配置 ----
    await ev(c, `(function(){
      document.getElementById('btn-ai').click();
      if (document.getElementById('ai-panel').classList.contains('hidden')) document.getElementById('btn-ai').click();
      document.getElementById('ai-config').classList.remove('hidden');
      window.__alertLog = []; window.alert = (m) => { window.__alertLog.push(String(m)); };
      return true;
    })()`);
    await sleep(300);
    await ev(c, `document.getElementById('ai-vendor-new').click(); true`);
    await sleep(200);
    // 用 showPrompt 的输入框 + OK 按钮走一遍真实新增流程
    await ev(c, `(function(){
      var inp = document.getElementById('prompt-input');
      inp.value = '测试厂商A';
      document.getElementById('prompt-ok').click();
      return true;
    })()`);
    await sleep(300);
    const nv = await ev(c, `(function(){
      var v = (state.settings.aiVendors || {})['测试厂商A'];
      return v ? JSON.stringify({ url: v.url, format: v.format, model: v.model, models: v.models }) : 'MISSING';
    })()`);
    let nvObj = null;
    try { nvObj = JSON.parse(nv); } catch { /* ignore */ }
    if (nvObj && /deepseek\.com/.test(nvObj.url) && nvObj.format === 'anthropic' && nvObj.model && (nvObj.models || []).length) {
      ok('＋ 新增厂商 → 默认填好 DeepSeek 地址/协议/模型', `${nvObj.url} · ${nvObj.format} · ${nvObj.model}`);
    } else {
      bad('新增厂商默认配置不能直接跑', nv);
    }

    // ---- ③ 快速模板:选 DeepSeek → 落盘;选完复位 ----
    await ev(c, `(function(){
      var sel = document.getElementById('ai-vendor-preset');
      sel.value = 'deepseek';
      sel.dispatchEvent(new Event('change'));
      return true;
    })()`);
    await sleep(300);
    const presetRes = await ev(c, `(function(){
      var sel = document.getElementById('ai-vendor-preset');
      var v = (state.settings.aiVendors || {})[state.settings.aiActiveVendor] || {};
      return JSON.stringify({ reset: sel.value === '', url: v.url, format: v.format, model: v.model, inputUrl: document.getElementById('ai-url').value });
    })()`);
    const pr = JSON.parse(presetRes);
    if (pr.url === 'https://api.deepseek.com/anthropic' && pr.format === 'anthropic' && pr.inputUrl === pr.url) {
      ok('⚙ 快速模板 DeepSeek → 地址/协议写入并同步到输入框', pr.url);
    } else {
      bad('快速模板没把配置填对', presetRes);
    }
    if (pr.reset) ok('快速模板选完自动复位成「自定义」(可以重复选同一家)');
    else bad('快速模板没有复位,再次选同一家不触发');

    // ---- ④ 接口地址为空 → 可读错误,不联网 ----
    const r4 = await ev(c, `window.api.aiChat({ apiKey:'k', url:'', model:'deepseek-v4-flash', format:'anthropic', messages:[{role:'user',content:'hi'}], hosts:[], requestId:'t4' })`);
    const e4 = r4 && r4.error ? r4.error : JSON.stringify(r4);
    if (/接口地址/.test(e4)) ok('地址为空 → 直接提示去 ⚙ 填接口地址(不再打到官方 Anthropic)');
    else bad('地址为空时没有可读提示', e4);

    // ---- ⑤ 模型为空 → 可读错误,不再回落 claude-sonnet-5 ----
    const r5 = await ev(c, `window.api.aiChat({ apiKey:'k', url:'https://api.deepseek.com/anthropic', model:'', format:'anthropic', messages:[{role:'user',content:'hi'}], hosts:[], requestId:'t5' })`);
    const e5 = r5 && r5.error ? r5.error : JSON.stringify(r5);
    if (/选一个模型/.test(e5) && !/claude/i.test(e5)) ok('模型为空 → 提示去 ⚙ 选模型(不再偷偷用 claude-sonnet-5)');
    else bad('模型为空时的行为不对', e5);

    // ---- ⑥ aiSend 前置校验:地址/模型缺失 → 弹提示 + 展开 ⚙,不发请求 ----
    await ev(c, `(function(){
      var v = state.settings.aiVendors[state.settings.aiActiveVendor];
      v.url = ''; v.key = 'enc:v1:placeholder'; v.model = 'deepseek-v4-flash';
      saveSettings(); fillAiConfig();
      document.getElementById('ai-config').classList.add('hidden'); // 故意收起,验证会被自动展开
      document.getElementById('ai-input').value = '测试';
      window.__alertLog = [];
      aiSend();
      return true;
    })()`);
    await sleep(300);
    const a6 = await ev(c, `JSON.stringify({ log: window.__alertLog, cfgHidden: document.getElementById('ai-config').classList.contains('hidden'), busy: aiBusy })`);
    const a6o = JSON.parse(a6);
    if (a6o.log.length && /接口地址/.test(a6o.log[0]) && !a6o.cfgHidden && !a6o.busy) {
      ok('地址缺失 → 发消息前就提示 + 自动展开 ⚙,不发起请求');
    } else bad('aiSend 前置校验没生效', a6);

    // ---- ⑦ Key 密文落盘 + 能解密 ----
    await ev(c, `(function(){
      var sel = document.getElementById('ai-vendor-preset'); sel.value = 'deepseek'; sel.dispatchEvent(new Event('change'));
      document.getElementById('ai-key').value = 'sk-test-abcdef123456';
      document.getElementById('ai-config-save').click();
      return true;
    })()`);
    await sleep(600);
    const savedKey = await ev(c, `(function(){ var v=(state.settings.aiVendors||{})[state.settings.aiActiveVendor]||{}; return String(v.key||''); })()`);
    const dec = await ev(c, `decryptSecret((state.settings.aiVendors[state.settings.aiActiveVendor]||{}).key)`);
    if (/^enc:v1:/.test(savedKey) && dec === 'sk-test-abcdef123456') {
      ok('API Key 以 enc:v1: 密文入库,且能解密回原文');
    } else {
      bad('Key 没有密文存储或解密不一致', `${String(savedKey).slice(0, 12)}… / ${String(dec).slice(0, 8)}…`);
    }

    // ---- ⑧(可选,需真实 Key)实际发一条消息 → 终端能收到回复 ----
    if (REAL_KEY) {
      await ev(c, `(function(){
        var v = state.settings.aiVendors[state.settings.aiActiveVendor];
        encryptSecret(${JSON.stringify(REAL_KEY)}).then(function(k){ v.key = k; v.url = 'https://api.deepseek.com/anthropic'; v.format = 'anthropic'; v.model = 'deepseek-v4-flash'; v.models = ['deepseek-v4-flash','deepseek-v4-pro']; state.settings.aiActiveVendor = state.settings.aiActiveVendor; saveSettings(); fillAiConfig(); });
        return true;
      })()`);
      await sleep(1200);
      await ev(c, `document.getElementById('ai-input').value='只回复两个字:OK'; document.getElementById('ai-send').click(); true`);
      let chat = '';
      for (let i = 0; i < 60; i++) {
        await sleep(400);
        chat = await ev(c, `document.getElementById('ai-chat').textContent || ''`);
        if (/OK/.test(chat) || /⚠️/.test(chat)) break;
      }
      if (/⚠️/.test(chat)) bad('真实请求报错', chat.slice(-200));
      else if (/OK/.test(chat)) ok('真实 DeepSeek Key → AI 回复成功', chat.replace(/\s+/g, ' ').slice(-60));
      else bad('真实请求无回复', chat.slice(-200));
    } else {
      ok('(跳过真实请求:设置 POLARIS_AI_KEY 才测)');
    }

    console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  } catch (e) {
    console.error('\n测试异常:', e && e.message);
    failed++;
    console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  }
  try { appProc.kill('SIGKILL'); } catch { /* ignore */ }
  try { require('child_process').execSync(`pkill -f "remote-debugging-port=${PORT}"`); } catch { /* ignore */ }
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(failed ? 1 : 0);
})();
