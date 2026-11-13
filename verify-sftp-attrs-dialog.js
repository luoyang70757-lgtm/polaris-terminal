'use strict';
/**
 * verify-sftp-attrs-dialog.js — 「SFTP 权限与属性」对话框的端到端回归(真 Electron + mock SFTP)
 *
 * 纯函数与接线在 verify-sftp-attrs.js / verify-sftp-throttle.js,这里验证"点了真的生效":
 *   1 打开对话框 → 自动读出远端 mode/uid/gid/时间(不盲改)
 *   2 非法八进制 → 红字 + 保存被拦(远端不变)
 *   3 644 → 640 真的改到远端(再 stat 复核)
 *   4 uid/gid 一起改(chown 同时要两个值)
 *   5 修改时间真的落到远端
 *   6 目录 + 递归:子文件跟着改(条目数对得上)
 *   7 文件不显示"递归"勾选
 *   8 路径不存在 → 红字报错,不冒充成功
 *   9 传输限速 IPC:50KB/s → 51200 B/s;0 → 不限
 *  10 限速对真实下载生效(100KB @100KB/s 明显变慢,数据完整)
 *  11 保存后状态栏/传输记录留痕
 * 运行: node verify-sftp-attrs-dialog.js(需 9386/2260/2360 空闲)
 */
const { spawn } = require('child_process');
const { freePort, killTree, guardTimeout, evaluate, waitPort } = require('./test-helper');
const fs = require('fs'); const os = require('os'); const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-attrs-'));
const MOCK_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-attrs-disk-'));
const DL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-attrs-dl-'));
const PORT = 9386, SSH = 2260;

// 造一份远端树:普通文件 + 目录(含子目录) + 100KB 大文件(限速实测用)
{
  const W = (rel, content) => { const p = path.join(MOCK_ROOT, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); };
  W('README.txt', '# perm demo\n');
  W('perm/a.txt', 'aaa\n');
  W('perm/sub/b.txt', 'bbb\n');
  W('big/100kb.bin', Buffer.alloc(100 * 1024, 0x7a));
}

freePort(PORT); freePort(SSH); freePort(SSH + 100);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// mock 跑在**独立子进程**里:本回归要密集轮询 CDP,同进程的 mock 会跟 evaluate 往返
// 抢事件循环,偶发"客户端握手超时"假红灯(实测约 1/3)。分离后跑 6 次全稳。
const mockEnv = { ...process.env, MOCK_SSH_PORT: String(SSH), MOCK_HTTP_PORT: String(SSH + 100), MOCK_SFTP_ROOT: MOCK_ROOT };
const mockProc = spawn(process.execPath, [path.join(__dirname, 'mock', 'mock-server.js')], { env: mockEnv, stdio: process.env.ATTRS_DEBUG ? 'inherit' : 'ignore' });

// 应用侧刻意不继承 MOCK_*:dev 模式的应用会自己起一份 mock,和测试抢同一端口会让
// "谁在服务"变得不确定;让它落在默认端口(占不到就自行跳过)。
const appEnv = { ...process.env, POLARIS_LOCK_DIR: DIR, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true', POLARIS_AUTO_DL_DIR: DL_DIR };
delete appEnv.MOCK_SSH_PORT; delete appEnv.MOCK_HTTP_PORT; delete appEnv.MOCK_SFTP_ROOT;
const appProc = spawn(require('electron'), ['.', '--dev', `--remote-debugging-port=${PORT}`], { env: appEnv, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
guardTimeout(120000, appProc);
guardTimeout(120000, mockProc);
if (process.env.ATTRS_DEBUG) {
  appProc.stdout.on('data', (d) => process.stdout.write('[APP] ' + d));
  appProc.stderr.on('data', (d) => process.stdout.write('[ERR] ' + d));
}

async function targets() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json`);
      const j = await r.json();
      const p = j.find((t) => t.type === 'page' && /解锁|Polaris/.test(t.title || ''));
      if (p) return j;
    } catch { /* not ready */ }
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
const bad = (n, e) => { failed++; console.error('  ✗ ' + n + (e ? ' -> ' + e : '')); };
const near = (n, v, lo, hi) => (v >= lo && v <= hi) ? ok(`${n}(实测 ${v}ms)`) : bad(`${n} 超出 [${lo},${hi}]ms`, v);

(async () => {
  console.log('\n=== SFTP 权限与属性对话框(端到端)===\n');
  try {
    await waitPort(SSH, 8000);
    await waitPort(SSH + 100, 8000);
    // ---- 解锁 → 主窗口 ----
    let lockT = null;
    for (let i = 0; i < 50; i++) { lockT = (await targets()).find((t) => /解锁/.test(t.title || '')); if (lockT) break; await sleep(400); }
    if (!lockT) throw new Error('解锁页未就绪');
    const lock = await connect(lockT.webSocketDebuggerUrl);
    for (let i = 0; i < 30; i++) { if (await evaluate(lock, `!!document.getElementById('pw')`)) break; await sleep(300); }
    await sleep(400);
    await evaluate(lock, `document.getElementById('pw').value='x1234567'; document.getElementById('pw2').value='x1234567'; document.getElementById('btn').click();`);
    let main = null;
    for (let i = 0; i < 30; i++) { await sleep(500); const t2 = await targets(); const m = t2.find((t) => t.type === 'page' && !/解锁/.test(t.title || '')); if (m) { main = m; break; } }
    if (!main) throw new Error('主窗口未就绪');
    const c = await connect(main.webSocketDebuggerUrl);
    await sleep(1200);

    // ---- 建会话 + 连接 + 开 SFTP 面板 ----
    // 关掉主机指纹弹窗 + 新手引导:否则"信任并连接"模态会挂住握手(ssh2 会报 handshake 超时)
    await evaluate(c, `(async()=>{ state.settings.onboardingDone=true; state.settings.verifyHostKey=false; state.settings.autoTrustHostKey=true; saveSettings();
      const om=document.getElementById('onboarding-modal'); if(om) om.classList.add('hidden');
      await window.api.createSession({name:'attrs', host:'127.0.0.1', port:${SSH}, username:'admin', password:'admin123', protocol:'ssh'}); await loadSessions(); return true; })()`);
    await sleep(400);
    await evaluate(c, `state.collapsedGroups.clear(); state.collapsedTopHost = false; state.settings.sessionView='list'; renderSessionList(''); true`);
    await sleep(300);
    const sJson = await evaluate(c, `(function(){ const s=state.sessions.find(x=>x.name==='attrs'); return s?JSON.stringify(s):'NOTFOUND'; })()`);
    if (sJson === 'NOTFOUND') throw new Error('会话未创建');
    await evaluate(c, `connectToServer(${sJson})`);
    let sid = null;
    for (let i = 0; i < 40; i++) { sid = await evaluate(c, `(state.tabs.size ? [...state.tabs.keys()][0] : null)`); if (sid && await evaluate(c, `state.tabs.get('${sid}').status`) === 'connected') break; await sleep(300); }
    if (!sid) throw new Error('连接失败');
    ok(`会话已连接(sid=${sid})`);
    await evaluate(c, `toggleSftpPanel(); true`);
    await sleep(700);
    // 打开前先确认根目录可列(面板已加载列表)
    await evaluate(c, `loadSftpList(); true`);
    await sleep(700);

    const ui = async () => JSON.parse(await evaluate(c, `(function(){
      return JSON.stringify({
        open: !els.attrsModal.classList.contains('hidden'),
        mode: els.attrsMode.value,
        uid: els.attrsUid.value,
        gid: els.attrsGid.value,
        mtime: els.attrsMtime.value,
        preview: els.attrsModePreview.textContent,
        status: els.attrsStatus.textContent,
        saveDisabled: els.attrsSave.disabled,
        recursiveHidden: els.attrsRecursiveRow.classList.contains('hidden'),
        recursiveChecked: els.attrsRecursive.checked,
      });
    })()`));

    const statJson = async (rp) => evaluate(c, `(async()=>{ const r = await window.api.sftpStat('${sid}', ${JSON.stringify(rp)}); return JSON.stringify(r); })()`);

    // ① 打开对话框:属性自动填好
    await evaluate(c, `openSftpAttrs('/perm/a.txt', {name:'a.txt', isDir:false}); true`);
    await sleep(600);
    const s1 = await ui();
    if (s1.open && s1.mode === '644' && s1.uid === '1000' && s1.gid === '1000' && !s1.saveDisabled && /-rw-r--r--/.test(s1.preview)) {
      ok(`对话框打开并读出属性:mode=${s1.mode} uid=${s1.uid} gid=${s1.gid} 预览「${s1.preview}」`);
    } else bad('对话框没有正确读出远端属性', JSON.stringify(s1));
    if (s1.recursiveHidden) ok('文件不显示「递归」勾选(只对目录有意义)');
    else bad('文件的递归勾选没隐藏', JSON.stringify(s1));

    // ② 非法八进制:红字 + 保存不改远端
    await evaluate(c, `els.attrsMode.value='abc'; els.attrsMode.dispatchEvent(new Event('input')); true`);
    await sleep(200);
    const s2 = await ui();
    if (/3~4 位八进制|不能为空/.test(s2.preview)) ok('非法八进制 → 即时红字提示');
    else bad('非法八进制没有提示', s2.preview);
    await evaluate(c, `els.attrsSave.click(); true`);
    await sleep(500);
    const after2 = JSON.parse(await statJson('/perm/a.txt'));
    if (after2.ok && after2.stat.modeOctal === '644') ok('保存被拦下,远端仍是 644');
    else bad('非法输入竟然改到了远端', JSON.stringify(after2));

    // ③ 644 → 640
    await evaluate(c, `els.attrsMode.value='640'; els.attrsMode.dispatchEvent(new Event('input')); els.attrsSave.click(); true`);
    for (let i = 0; i < 20; i++) { await sleep(300); const s = await ui(); if (!s.open) break; }
    const after3 = JSON.parse(await statJson('/perm/a.txt'));
    if (after3.ok && after3.stat.modeOctal === '640') ok('644 → 640 真的落到远端');
    else bad('权限没改成 640', JSON.stringify(after3 && after3.stat));

    // ④ uid/gid 一起改
    await evaluate(c, `openSftpAttrs('/perm/a.txt', {name:'a.txt', isDir:false}); true`);
    await sleep(600);
    await evaluate(c, `els.attrsUid.value='0'; els.attrsGid.value='5'; els.attrsSave.click(); true`);
    for (let i = 0; i < 20; i++) { await sleep(300); const s = await ui(); if (!s.open) break; }
    const after4 = JSON.parse(await statJson('/perm/a.txt'));
    if (after4.ok && after4.stat.uid === 0 && after4.stat.gid === 5) ok('uid/gid 同时改到 0/5');
    else bad('属主/属组没改对', JSON.stringify(after4 && after4.stat));

    // ⑤ 修改时间
    await evaluate(c, `openSftpAttrs('/perm/a.txt', {name:'a.txt', isDir:false}); true`);
    await sleep(600);
    await evaluate(c, `els.attrsMtime.value='2020-09-13T12:26:40'; els.attrsSave.click(); true`);
    for (let i = 0; i < 20; i++) { await sleep(300); const s = await ui(); if (!s.open) break; }
    const after5 = JSON.parse(await statJson('/perm/a.txt'));
    // 2020-09-13 12:26:40 本地时间 = 1600000000(中国时区);用"输入框往返"判断更稳
    if (after5.ok && after5.stat.mtimeLocal === '2020-09-13T12:26:40') ok('修改时间落到远端(本地时间往返一致)');
    else bad('修改时间没改对', JSON.stringify(after5 && after5.stat));

    // ⑥ 目录 + 递归(perm 下 a.txt + sub/b.txt;perm/sub 本身不含文件)
    await evaluate(c, `openSftpAttrs('/perm', {name:'perm', isDir:true}); true`);
    await sleep(700);
    const s6 = await ui();
    if (!s6.recursiveHidden) ok('目录显示「递归」勾选'); else bad('目录没有递归勾选', JSON.stringify(s6));
    await evaluate(c, `els.attrsMode.value='700'; els.attrsMode.dispatchEvent(new Event('input')); els.attrsRecursive.checked=true; els.attrsSave.click(); true`);
    for (let i = 0; i < 40; i++) { await sleep(400); const s = await ui(); if (!s.open) break; }
    const d1 = JSON.parse(await statJson('/perm'));
    const d2 = JSON.parse(await statJson('/perm/sub/b.txt'));
    if (d1.ok && d1.stat.modeOctal === '700' && d2.ok && d2.stat.modeOctal === '700') ok('递归改权限:目录与其下文件都变成 700');
    else bad('递归没覆盖到子项', JSON.stringify({ dir: d1 && d1.stat && d1.stat.modeOctal, child: d2 && d2.stat && d2.stat.modeOctal }));

    // ⑦ 路径不存在 → 报错不冒充成功
    await evaluate(c, `openSftpAttrs('/nope-not-exist.txt', {name:'nope', isDir:false}); true`);
    await sleep(600);
    const s7 = await ui();
    if (s7.open && s7.saveDisabled && /读不到属性/.test(s7.status)) ok(`不存在的路径 → 红字「${s7.status.slice(0, 24)}…」并禁用保存`);
    else bad('不存在的路径处理不对', JSON.stringify(s7));
    await evaluate(c, `closeSftpAttrs(); true`);

    // ⑧ 保存后留痕(状态栏/传输记录)
    const logTxt = await evaluate(c, `(state.sftp.log||[]).map(x=>x.text).join(' | ')`);
    /🔐/.test(logTxt) ? ok('传输记录里有 🔐 权限修改条目') : bad('没有权限修改记录', logTxt.slice(-120));

    // ⑨ 传输限速 IPC
    const lim50 = JSON.parse(await evaluate(c, `(async()=>{ const r = await window.api.sftpSetTransferLimit(50); return JSON.stringify(r); })()`));
    if (lim50.ok && lim50.bytesPerSec === 51200) ok('限速 50KB/s → 51200 B/s');
    else bad('限速换算不对', JSON.stringify(lim50));
    const lim0 = JSON.parse(await evaluate(c, `(async()=>{ const r = await window.api.sftpSetTransferLimit(0); return JSON.stringify(r); })()`));
    if (lim0.ok && lim0.bytesPerSec === 0) ok('限速 0 → 不限速(bytesPerSec=0)');
    else bad('关闭限速失败', JSON.stringify(lim0));

    // ⑩ 限速对真实下载生效(100KB 文件)
    const dlOnce = async (kbps) => {
      await evaluate(c, `(async()=>{ await window.api.sftpSetTransferLimit(${kbps}); return true; })()`);
      for (const f of fs.readdirSync(DL_DIR)) { try { fs.unlinkSync(path.join(DL_DIR, f)); } catch { /* ignore */ } }
      const t0 = Date.now();
      const res = JSON.parse(await evaluate(c, `(async()=>{ const r = await window.api.sftpDownload('${sid}', '/big/100kb.bin'); return JSON.stringify(r); })()`));
      // 后台 job:轮询本地文件到齐(100KB)
      let done = false, size = 0;
      for (let i = 0; i < 80; i++) {
        await sleep(150);
        const cand = fs.readdirSync(DL_DIR).filter((f) => /^100kb.bin/.test(f));
        if (cand.length) {
          size = fs.statSync(path.join(DL_DIR, cand[0])).size;
          if (size >= 100 * 1024) { done = true; break; }
        }
      }
      return { ok: !!res && res.ok !== false, done, size, ms: Date.now() - t0 };
    };
    const limited = await dlOnce(100);
    if (limited.done && limited.size === 100 * 1024 && limited.ms >= 500) ok(`限速 100KB/s 下 100KB 下载耗时 ${limited.ms}ms(明显被限速)`);
    else bad('限速下载不符合预期', JSON.stringify(limited));
    const full = await dlOnce(0);
    if (full.done && full.size === 100 * 1024) ok(`不限速下载完成(${full.ms}ms,数据 100KB 完整)`);
    else bad('不限速下载失败', JSON.stringify(full));

    console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  } catch (e) {
    console.error('\n测试异常:', e && (e.stack || e.message));
    failed++;
    console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  }
  try { killTree(appProc); } catch { /* ignore */ }
  try { killTree(mockProc); } catch { /* ignore */ }
  for (const d of [MOCK_ROOT, DL_DIR]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
  process.exit(failed ? 1 : 0);
})();
