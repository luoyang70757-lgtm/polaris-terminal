'use strict';
/**
 * verify-winscp-open.js — 「点 SFTP 就用 WinSCP 打开」整条链路(真启动 electron)
 *
 * 用桩程序替身验证:把 POLARIS_WINSCP_PATH 指到一个 shell 桩(参数写进文件),
 * 于是即便测试机是 macOS 也能验证"参数到底长什么样、有没有把密码漏进日志"。
 * 断言:
 *   ① 探测:装了 → installed/path;没装 → 入口不出现
 *   ② 打开:argv 第一条是 sftp://会话 URL,密码经过 percent-encode
 *      + `/rawsettings SFTPRealPath=off`(chroot 服务器不发 REALPATH("."),否则 WinSCP 报错误码 4)
 *      + 已知起始目录时附带 `RemoteDirectory=/x`
 *   ③ 日志/状态栏里不出现明文密码(只有 ***)
 *   ④ 设置项 winscpMode=replace/button/panel 三种模式行为(替代/加按钮/只用内置面板)
 *   ⑤ replace 模式下拉起失败或没装 → 自动回落内置面板(功能不消失)
 *   ⑥ telnet 会话拒绝、缺主机报错
 *   ⑦ 标签右键菜单里有「🪟 用 WinSCP 打开 SFTP」
 * 运行: node verify-winscp-open.js(需 9403/2233/2333 空闲)
 */
const { spawn, execSync } = require('child_process');
const { freePort, killTree, guardTimeout, evaluate } = require('./test-helper');
const fs = require('fs'); const os = require('os'); const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-winscp-'));
const STUB = path.join(DIR, 'fake-winscp');
const ARGV_FILE = path.join(DIR, 'argv.txt');
// 桩:把收到的参数一行一个写进 $WINSCP_STUB_OUT(模仿真实 winscp.exe 收到的 argv)
fs.writeFileSync(STUB, '#!/bin/sh\n{ for a in "$@"; do printf \'%s\\n\' "$a"; done; printf \'%s\\n\' \'---\'; } >> "$WINSCP_STUB_OUT"\n');
fs.chmodSync(STUB, 0o755);
fs.writeFileSync(ARGV_FILE, '');

const PORT = 9403, SSH = 2233, HTTP = 2333;
try { execSync('pkill -f "remote-debugging-port" 2>/dev/null'); } catch { /* 无残留 */ }
freePort(PORT); freePort(SSH); freePort(HTTP);
process.env.MOCK_SSH_PORT = String(SSH);
process.env.MOCK_HTTP_PORT = String(HTTP);
require('./mock/mock-server').start();

const SECRET = 'p@ss:w/rd#1';
function argvFrames() {
  const raw = fs.readFileSync(ARGV_FILE, 'utf8');
  return raw.split('---\n').filter((x) => x.trim()).map((x) => x.split('\n').filter(Boolean));
}

const appProc = spawn(require('electron'), ['.', '--dev', `--remote-debugging-port=${PORT}`, '--no-sandbox', '--disable-gpu'], {
  env: {
    ...process.env,
    POLARIS_LOCK_DIR: DIR,
    ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
    POLARIS_WINSCP_PATH: STUB,     // 打桩:让探测认为"装了 WinSCP"
    WINSCP_STUB_OUT: ARGV_FILE,
  },
  stdio: ['ignore', 'ignore', 'ignore'], detached: true,
});
guardTimeout(180000, appProc);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function targets() {
  for (let i = 0; i < 80; i++) {
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
// 带超时的 evaluate:某个步骤若把渲染层卡住,不能让整个用例挂 3 分钟(直接报 TIMEOUT 继续跑)
const ev = (conn, expr, ms = 20000) => Promise.race([
  evaluate(conn, expr),
  new Promise((r) => setTimeout(() => r('TIMEOUT'), ms)),
]);
let passed = 0, failed = 0;
const ok = (n) => { passed++; console.log('  ✓ ' + n); };
const bad = (n, e) => { failed++; console.error('  ✗ ' + n + (e ? ' → ' + (e.message || e) : '')); };

(async () => {
  console.log('\n=== 用 WinSCP 打开 SFTP(整链路) ===\n');
  try {
    const t0 = await targets();
    const lockT = t0.find((t) => /解锁/.test(t.title || '')) || t0.find((t) => t.type === 'page');
    const lock = await connect(lockT.webSocketDebuggerUrl);
    for (let i = 0; i < 30; i++) { if (await evaluate(lock, `!!document.getElementById('pw')`)) break; await sleep(300); }
    await evaluate(lock, `document.getElementById('pw').value='x1234567'; document.getElementById('pw2').value='x1234567'; document.getElementById('btn').click();`);
    let main = null;
    for (let i = 0; i < 70 && !main; i++) { await sleep(500); main = (await targets()).find((t) => t.type === 'page' && !/解锁/.test(t.title || '')); }
    if (!main) throw new Error('主窗口未就绪');
    const c = await connect(main.webSocketDebuggerUrl);
    await sleep(1200);
    // 新手引导弹窗会吞按键/挡操作,先关掉
    await evaluate(c, `state.settings.onboardingDone = true; saveSettings(); document.getElementById('onboarding-modal').classList.add('hidden'); true`);
    // 主机指纹弹窗会挂住 ssh2 握手(等用户点"信任"),测试里直接放行(真实用户仍走弹窗)
    await evaluate(c, `state.settings.verifyHostKey = false; state.settings.autoTrustHostKey = true; state.settings.onboardingDone = true; saveSettings(); true`);

    // ---------- ① 探测 ----------
    const det = await evaluate(c, `(async()=>JSON.stringify(await window.api.winScpDetect()))()`);
    const detJ = JSON.parse(det);
    if (detJ.ok && detJ.installed && detJ.path === STUB) ok('探测到桩 WinSCP(installed + path 正确)');
    else bad('探测到桩 WinSCP', det);
    if (await evaluate(c, `state.winScp.installed === true && state.winScp.path === ${JSON.stringify(STUB)}`)) ok('渲染层 state.winScp 与探测结果一致');
    else bad('渲染层 state.winScp 与探测结果一致');

    // ---------- ② 打开 + ③ 脱敏 ----------
    const before = argvFrames().length;
    const r1 = JSON.parse(await evaluate(c, `(async()=>JSON.stringify(await window.api.winScpOpen(${JSON.stringify({
      protocol: 'ssh', host: '10.0.0.9', port: 22, username: 'root', password: SECRET,
    })})))()`));
    if (r1.ok) ok('winScp:open 返回成功');
    else bad('winScp:open 返回成功', r1.error);
    await sleep(500);
    const frames = argvFrames().slice(before);
    if (frames.length >= 1) ok('真的拉起了 WinSCP(桩收到了参数)');
    else bad('真的拉起了 WinSCP');
    const first = frames[0] && frames[0][0];
    // 期望:密码整段 percent-encode,一个原始 @ : / # 都不能漏出去
    const wantUrl = `sftp://root:p%40ss%3Aw%2Frd%231@10.0.0.9:22/`;
    if (first === wantUrl) ok('会话 URL 正确(密码已 percent-encode)');
    else bad('会话 URL 正确', `实际: ${first}`);
    const argv1 = frames[0] || [];
    // rawsettings 必须带上 SFTPRealPath=off(否则 chroot 服务器报「不能获得 '.' 的真实路径,错误码 4」)
    if (argv1.includes('/rawsettings') && argv1.includes('SFTPRealPath=off')) ok('参数带 /rawsettings SFTPRealPath=off(绕开 REALPATH(".") 探测)');
    else bad('参数带 SFTPRealPath=off', JSON.stringify(argv1));
    // 日志默认**关闭**(v1.0.24):/loglevel=1 的 `Parameter:` 行是明文口令 → 不再默认落盘。
    // 默认参数 = URL + /rawsettings + SFTPRealPath=off,没有任何 /log= / /loglevel=
    if (argv1.length === 3 && argv1[1] === '/rawsettings' && argv1[2] === 'SFTPRealPath=off' && !argv1.some((a) => a.startsWith('/log'))) ok('参数只有 URL + /rawsettings(默认不写日志)');
    else bad('参数只有 URL + /rawsettings(默认不写日志)', JSON.stringify(argv1));
    const anyWinScpLog = (() => {
      try { return fs.readdirSync(path.join(DIR, 'logs')).filter((f) => f.startsWith('winscp-')); } catch { return []; }
    })();
    if (anyWinScpLog.length === 0) ok('默认不生成 winscp-*.log(不把口令写进数据目录)');
    else bad('默认不生成 winscp-*.log', JSON.stringify(anyWinScpLog));
    // 日志里不能有明文密码
    const logs = await evaluate(c, `(function(){ var t = termDebug.lines.join('\\n'); try { t += '\\n' + (document.getElementById('debug-body') ? document.getElementById('debug-body').textContent : ''); } catch(e){} return t; })()`);
    const diskLog = (() => {
      try {
        const d = path.join(DIR, 'logs');
        return fs.readdirSync(d).filter((f) => f.startsWith('app-')).map((f) => fs.readFileSync(path.join(d, f), 'utf8')).join('\n');
      } catch { return ''; }
    })();
    if (!logs.includes(SECRET)) ok('渲染层调试日志里没有明文密码');
    else bad('渲染层调试日志里没有明文密码');
    // v1.0.17:拉起/失败日志改成 console.log → 调试面板也能看到(以前只落盘,面板里只有 window blur)
    if (/\[WINSCP\] 已拉起/.test(logs)) ok('拉起成功同时进调试面板(不再只落盘)');
    else bad('拉起成功同时进调试面板', logs.slice(-300));
    if (logs.includes('rawsettings=') && logs.includes('SFTPRealPath') && !logs.includes(SECRET)) ok('面板日志里能看到 rawsettings(SFTPRealPath=off) 且无密码');
    else bad('面板日志里能看到 rawsettings 且无密码', logs.slice(-300));
    if (diskLog.includes('[WINSCP] 已拉起')) ok('落盘日志里也有 [WINSCP] 已拉起');
    else bad('落盘日志里也有 [WINSCP] 已拉起');
    if (diskLog.includes('***@10.0.0.9')) ok('落盘日志里有脱敏后的命令行(说明确实记了日志)');
    else bad('落盘日志里有脱敏后的命令行', diskLog.slice(-200));
    if (!diskLog.includes(SECRET) && !diskLog.includes('p%40ss')) ok('落盘日志里没有明文/编码密码');
    else bad('落盘日志里没有明文/编码密码');
    const statusText = await evaluate(c, `(document.getElementById('toolbar-status')||{}).textContent || ''`);
    if (!String(statusText).includes(SECRET)) ok('状态栏不显示密码');
    else bad('状态栏不显示密码', statusText);

    // ---------- ⑥ telnet / 缺主机 ----------
    const rTel = JSON.parse(await evaluate(c, `(async()=>JSON.stringify(await window.api.winScpOpen({protocol:'telnet', host:'h', username:'u', password:'p'})))()`));
    if (!rTel.ok && /Telnet/.test(rTel.error || '')) ok('telnet 会话被拒(没有 SFTP)');
    else bad('telnet 会话被拒', JSON.stringify(rTel));
    const rNo = JSON.parse(await evaluate(c, `(async()=>JSON.stringify(await window.api.winScpOpen({protocol:'ssh', username:'u', password:'p'})))()`));
    if (!rNo.ok && /缺少主机地址/.test(rNo.error || '')) ok('缺主机地址 → 明确报错');
    else bad('缺主机地址 → 明确报错', JSON.stringify(rNo));

    // ---------- 建一个真实(连到 mock)会话,供模式/菜单用例用 ----------
    await ev(c, `(async()=>{ try { await window.api.createSession({name:'winscp', host:'127.0.0.1', port:${SSH}, username:'admin', password:'admin123', protocol:'ssh'}); return 'created'; } catch(e) { return 'ERR:' + e.message; } })()`);
    await ev(c, `(async()=>{ await loadSessions(); renderSessionList(''); return 'rendered'; })()`, 25000);
    const sJson = await ev(c, `(function(){ const s=state.sessions.find(x=>x.name==='winscp'); return s?JSON.stringify(s):'NOTFOUND'; })()`);
    if (sJson === 'NOTFOUND' || sJson === 'TIMEOUT') throw new Error('会话未创建');
    await ev(c, `(function(){ connectToServer(${sJson}); return 'started'; })()`);
    // 用「一次 evaluate 内自轮询」拿 sid:避免测试端反复 round-trip(偶发 CDP 卡顿会被误判成未连接)
    const pollSid = `(async()=>{ for (let i=0;i<60;i++){ const id=state.activeSessionId; const t=id&&state.tabs.get(id); if (t && t.status==='connected') return id; await new Promise(function(r){setTimeout(r,300);}); } return 'NOTCONNECTED'; })()`;
    let sid = await ev(c, pollSid, 40000);
    if (sid === 'NOTCONNECTED' || sid === 'TIMEOUT') {
      // mock/SSH 握手偶发慢(连跑多次时见过一次):再点一次连接再等一轮,
      // 不让一次抖动把后面 18 条断言全部带走
      await ev(c, `(function(){ connectToServer(${sJson}); return 'retry'; })()`);
      sid = await ev(c, pollSid, 40000);
    }
    if (!sid || sid === 'NOTCONNECTED' || sid === 'TIMEOUT') throw new Error('mock 会话连接失败');
    ok(`mock 会话已连接(sid=${sid})`);

    // ---------- ④ 三种模式 ----------
    // 默认 = button(v1.0.22 起):点 SFTP 开内置面板,不默认把用户交给 WinSCP
    await evaluate(c, `state.settings.winscpMode = undefined; state.settings.winscpModeMigrated = true; true`);
    const modeDefault = await evaluate(c, `winScpMode()`);
    if (modeDefault === 'button') ok('默认模式 = button(点 SFTP 开内置面板,面板里有 WinSCP 按钮)');
    else bad('默认模式 = button', modeDefault);
    const opts = JSON.parse(await evaluate(c, `(function(){ var s=document.getElementById('set-winscp-mode'); return JSON.stringify({ n: s.options.length, vals: [].map.call(s.options, function(o){return o.value;}), first: s.options[0].value }); })()`));
    if (opts.n === 3 && opts.first === 'button' && ['replace', 'button', 'panel'].every((v) => opts.vals.includes(v))) ok('设置项有三种模式且默认档排在第一位(button/replace/panel)');
    else bad('设置项有三种模式且默认档排第一', JSON.stringify(opts));
    // v4 迁移:老配置里仍是 replace(= 当年我们给的默认值)且用户没自己选过 → 变 button
    await evaluate(c, `state.settings.winscpMode = 'replace'; state.settings.winscpModeMigrated = false; state.settings.settingsVersion = 3; saveSettings(); loadSettings(); true`);
    const afterMigrate = await evaluate(c, `({ mode: winScpMode(), migrated: state.settings.winscpModeMigrated, ver: state.settings.settingsVersion, raw: state.settings.winscpMode })`);
    if (afterMigrate.mode === 'button' && afterMigrate.raw === 'button' && afterMigrate.migrated === true && afterMigrate.ver === 4) ok('v4 迁移:没自己选过的 replace 老配置 → button(并写回)');
    else bad('v4 迁移 replace→button', JSON.stringify(afterMigrate));
    // 用户自己选过 replace(迁移标记为 true)→ 绝不再改
    await evaluate(c, `state.settings.winscpMode = 'replace'; state.settings.winscpModeMigrated = true; state.settings.settingsVersion = 3; saveSettings(); loadSettings(); true`);
    if ((await evaluate(c, `winScpMode()`)) === 'replace') ok('v4 迁移:用户自己选过的 replace 保持不动');
    else bad('v4 迁移:用户自己选的 replace 被改了');
    // WinSCP 协议下拉:默认 sftp,可切 scp
    const proto = await evaluate(c, `(function(){ var s=document.getElementById('set-winscp-protocol'); return JSON.stringify({ n: s.options.length, vals: [].map.call(s.options, function(o){return o.value;}), cur: s.value, fn: winScpProtocol() }); })()`);
    const prot = JSON.parse(proto);
    if (prot.n === 2 && prot.vals.join(',') === 'sftp,scp' && prot.fn === 'sftp') ok('WinSCP 协议下拉(SFTP/SCP),默认 sftp');
    else bad('WinSCP 协议下拉', proto);
    await evaluate(c, `state.settings.winscpProtocol = 'scp'; true`);
    if ((await evaluate(c, `winScpProtocol()`)) === 'scp') ok('切 SCP 后 winScpProtocol() 生效');
    else bad('切 SCP 后 winScpProtocol()');
    await evaluate(c, `state.settings.winscpProtocol = 'sftp'; true`);

    // replace:点 SFTP → 拉起 WinSCP,内置面板不显示
    const nBefore = argvFrames().length;
    await evaluate(c, `state.winScp.installed = true; state.settings.winscpMode='replace'; document.getElementById('set-winscp-mode').value='replace'; toggleSftpPanel(); true`);
    await sleep(500);
    const openCnt = argvFrames().length - nBefore;
    if (openCnt >= 1) ok('replace 模式:点 SFTP 拉起了 WinSCP');
    else bad('replace 模式:点 SFTP 拉起了 WinSCP', String(openCnt));
    if (await evaluate(c, `document.getElementById('sftp-panel').classList.contains('hidden')`)) ok('replace 模式:内置面板不显示');
    else bad('replace 模式:内置面板不显示');
    const lastArgs = argvFrames().slice(-1)[0];
    if (lastArgs && lastArgs[0] === 'sftp://admin:admin123@127.0.0.1:' + SSH + '/') ok('replace 模式:用的是这条会话自己的账号密码(不是别的会话)');
    else bad('replace 模式:用的是这条会话的账号密码', JSON.stringify(lastArgs));
    // 渲染层也记一行“交给谁 / 落在哪”(排查起始目录优先级问题时有据可查)
    const rlog = await evaluate(c, `(function(){ return termDebug.lines.slice(-40).join('\\n'); })()`);
    if (/WINSCP 交给 WinSCP: admin@127.0.0.1/.test(rlog) && rlog.includes('起始目录=')) ok('渲染层调试日志记了“交给 WinSCP + 起始目录”');
    else bad('渲染层调试日志记了交给 WinSCP', String(rlog).slice(-200));
    if (!rlog.includes('admin123')) ok('这行日志不含密码');
    else bad('这行日志不含密码');

    // replace + 没装(探测结果 false) → 回落内置面板
    await evaluate(c, `state.winScp.installed = false; toggleSftpPanel(); true`);
    await sleep(600);
    if (!(await evaluate(c, `document.getElementById('sftp-panel').classList.contains('hidden')`))) ok('没装 WinSCP 时:自动回落内置面板(功能不消失)');
    else bad('没装 WinSCP 时:自动回落内置面板');
    if (await evaluate(c, `document.getElementById('btn-sftp-winscp').classList.contains('hidden')`)) ok('没装 WinSCP 时:面板里不显示 WinSCP 按钮');
    else bad('没装 WinSCP 时:面板里不显示 WinSCP 按钮');

    // button 模式:面板照开 + 按钮出现
    await evaluate(c, `state.winScp.installed = true; state.settings.winscpMode='button'; refreshWinScpButton(); true`);
    if (!(await evaluate(c, `document.getElementById('btn-sftp-winscp').classList.contains('hidden')`))) ok('button 模式:面板里出现「🪟 WinSCP」按钮');
    else bad('button 模式:面板里出现 WinSCP 按钮');
    // panel 模式:按钮隐藏
    await evaluate(c, `state.settings.winscpMode='panel'; refreshWinScpButton(); true`);
    if (await evaluate(c, `document.getElementById('btn-sftp-winscp').classList.contains('hidden')`)) ok('panel 模式:按钮隐藏(只用内置面板)');
    else bad('panel 模式:按钮隐藏');

    // 协议=scp:URL 换成 scp://,且不再下发 SFTPRealPath(SCP 会话没有这个概念)
    const nScp = argvFrames().length;
    await evaluate(c, `state.settings.winscpProtocol = 'scp'; state.settings.winscpMode = 'replace'; openSessionInWinScp('${sid}'); true`);
    await sleep(400);
    const scpArgs = argvFrames().slice(nScp).pop() || [];
    if (scpArgs[0] === 'scp://admin:admin123@127.0.0.1:' + SSH + '/') ok('设置 SCP 协议后 WinSCP 收到 scp:// 会话 URL');
    else bad('SCP 协议 → scp:// URL', JSON.stringify(scpArgs));
    if (!scpArgs.includes('SFTPRealPath=off')) ok('SCP 协议不下发 SFTPRealPath(避免误以为生效)');
    else bad('SCP 协议仍下发 SFTPRealPath', JSON.stringify(scpArgs));
    if (!scpArgs.some((a) => a.startsWith('/log='))) ok('SCP 会话同样不写日志(默认关)');
    else bad('SCP 会话不该有 /log=', JSON.stringify(scpArgs));
    await evaluate(c, `state.settings.winscpProtocol = 'sftp'; state.settings.winscpMode = 'replace'; true`);

    // ---------- ⑦ 标签右键菜单 ----------
    await evaluate(c, `state.settings.winscpMode='button'; state.winScp.installed = true; true`);
    await evaluate(c, `showTabMenu({ preventDefault: function(){}, clientX: 20, clientY: 20 }, '${sid}'); true`);
    await sleep(200);
    const menuTxt = await evaluate(c, `document.getElementById('ctx-menu').textContent`);
    console.log('DEBUG menu =', JSON.stringify(String(menuTxt).slice(0, 80)), 'hidden=', await evaluate(c, `document.getElementById('ctx-menu').classList.contains('hidden')`));
    if (/用 WinSCP 打开 SFTP/.test(menuTxt)) ok('标签右键菜单有「🪟 用 WinSCP 打开 SFTP」');
    else bad('标签右键菜单有 WinSCP 项', String(menuTxt).slice(0, 120));
    await evaluate(c, `closeCtxMenu('test'); true`);
    await evaluate(c, `state.winScp.installed = false; showTabMenu({ preventDefault: function(){}, clientX: 20, clientY: 20 }, '${sid}'); true`);
    await sleep(200);
    const menuTxt2 = await evaluate(c, `document.getElementById('ctx-menu').textContent`);
    if (!/用 WinSCP/.test(menuTxt2)) ok('没装 WinSCP 时右键菜单不出现该项');
    else bad('没装 WinSCP 时右键菜单不出现该项');
    await evaluate(c, `closeCtxMenu('test'); true`);

    // ---------- 口令/私钥参数直通 ----------
    const before2 = argvFrames().length;
    const r2 = JSON.parse(await evaluate(c, `(async()=>JSON.stringify(await window.api.winScpOpen(${JSON.stringify({
      protocol: 'ssh', host: 'k.example.com', port: 22, username: 'k', password: '', privateKey: '/tmp/polaris-fake-key', passphrase: 'kpp',
    })})))()`));
    await sleep(400);
    const f2 = argvFrames().slice(before2)[0] || [];
    if (r2.ok && f2[0] === 'sftp://k@k.example.com:22/') ok('公钥会话:URL 不带密码');
    else bad('公钥会话:URL 不带密码', JSON.stringify(f2));
    if (f2.some((a) => a.startsWith('-privatekey=')) && f2.some((a) => a === '-passphrase=kpp')) ok('私钥路径与口令作为参数传给 WinSCP');
    else bad('私钥路径与口令作为参数传给 WinSCP', JSON.stringify(f2));

    // ---------- 起始目录(RemoteDirectory)直通 ----------
    const beforePath = argvFrames().length;
    const rPath = JSON.parse(await evaluate(c, `(async()=>JSON.stringify(await window.api.winScpOpen(${JSON.stringify({
      protocol: 'ssh', host: 'h.example.com', port: 22, username: 'u', password: 'pw', remotePath: '/srv/my dir',
    })})))()`));
    await sleep(400);
    const fPath = argvFrames().slice(beforePath)[0] || [];
    if (rPath.ok && fPath.some((a) => a === 'RemoteDirectory=/srv/my dir')) ok('起始目录原样交给 WinSCP(含空格不拆参)');
    else bad('起始目录原样交给 WinSCP', JSON.stringify(fPath));
    if (fPath.includes('SFTPRealPath=off')) ok('起始目录与 SFTPRealPath=off 同在一个 /rawsettings 里');
    else bad('SFTPRealPath=off 仍在', JSON.stringify(fPath));
    // 渲染层组装 payload:面板/标签/跟踪的 cwd 都能被用作起始目录,相对路径丢弃
    const payload = JSON.parse(await ev(c, `(function(){ state.sftp.visible=false; var t=state.tabs.get('${sid}'); if (!t) return '{}'; t.sftpPath='/root/www'; t.shellCwd=null; return JSON.stringify(winScpPayloadFor('${sid}')); })()`) || '{}');
    if (payload.remotePath === '/root/www') ok('winScpPayloadFor 用标签自己的 SFTP 路径作起始目录');
    else bad('winScpPayloadFor 起始目录', JSON.stringify(payload));
    const payloadRel = JSON.parse(await ev(c, `(function(){ var t=state.tabs.get('${sid}'); t.sftpPath='.'; t.shellCwd=null; state.sftp.visible=false; return JSON.stringify(winScpPayloadFor('${sid}')); })()`) || '{}');
    if (payloadRel.remotePath === '') ok('相对路径 / 未知目录不传给 WinSCP(避免它报目录不存在)');
    else bad('相对路径不传', JSON.stringify(payloadRel));
    // 起始目录未知时主进程用它现探家目录(exec pwd + readdir 校验),所以 payload 必须带 sessionId
    if (payload.sessionId === sid) ok('payload 带 sessionId(起始目录未知时主进程自己探家目录)');
    else bad('payload 带 sessionId', JSON.stringify(payload.sessionId));

    // 走渲染层自己的入口(标签右键菜单/按钮调的就是它),返回值 + 状态栏文案一起验
    await ev(c, `state.winScp.installed = true; true`);
    const open2 = await ev(c, `(async()=>{ const r = await openSessionInWinScp('${sid}'); return JSON.stringify({ ok: !!r, st: (document.getElementById('toolbar-status')||{}).textContent || '' }); })()`);
    const o2 = JSON.parse(open2 === 'TIMEOUT' ? '{"ok":false,"st":"TIMEOUT"}' : open2);
    if (o2.ok && /已用 WinSCP 打开/.test(o2.st)) ok('渲染层入口成功 + 状态栏「已用 WinSCP 打开…」');
    else bad('渲染层入口成功 + 状态栏反馈', open2);
  } catch (e) {
    failed++; console.error('  ✗ 异常: ' + (e && e.message));
    console.error(e);
  } finally {
    try { killTree(appProc); } catch { /* ignore */ }
    if (!process.env.KEEP) { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* ignore */ } } else console.error('KEEP DIR: ' + DIR);
    console.log(`\n结果: ${passed} 通过, ${failed} 失败\n`);
    process.exit(failed ? 1 : 0);
  }
})();
