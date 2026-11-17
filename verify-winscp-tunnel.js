'use strict';
/**
 * verify-winscp-tunnel.js — 跳板机会话交给 WinSCP 时走「WinSCP 自己的 SSH 隧道」(纯 Node + 可选冒烟)
 *
 * 为什么要这个脚本:
 *   跳板机会话的 URL 里 host 是**内网目标**,本机根本连不上。不把跳板信息一起交给
 *   WinSCP,用户点「用 WinSCP 打开 SFTP」只会看到连接超时/没反应,而 Polaris 里终端是通的
 *   → 被当成"SFTP 坏了"。
 *
 * 隧道开关名不是猜的,是拿 WinSCP 6.7.1 实测钉下来的(见文件尾冒烟段):
 *   /rawsettings Tunnel=1 TunnelHostName=<跳板> TunnelPortNumber=<端口> TunnelUserName=<账号>
 *                TunnelPasswordPlain=<密码> (或 TunnelPublicKeyFile=<私钥路径> TunnelPassphrase=<口令>)
 *                TunnelHostKey=*
 *
 * 运行:
 *   node verify-winscp-tunnel.js                       纯函数 + 结构断言
 *   POLARIS_WINSCP_SMOKE=1 node verify-winscp-tunnel.js 额外用**真实 WinSCP** 跑一遍隧道
 *                                                      (起两个 mock SSH:A 当跳板、B 当目标,
 *                                                      断言 WinSCP 退出码 0 且 A 侧出现 TCP 转发)
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const w = require('./lib/winscp-open');

let passed = 0, failed = 0;
const ok = (n) => { passed++; console.log('  ✓ ' + n); };
const bad = (n, e) => { failed++; console.error('  ✗ ' + n + (e ? ' → ' + e.message : '')); };
function t(name, fn) { try { fn(); ok(name); } catch (e) { bad(name, e); } }
const src = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8').replace(/\r\n/g, '\n');

console.log('\n=== WinSCP 跳板机隧道(纯 Node) ===\n');

// ---------- ① 归一化:没有跳板机 / 配置不完整 ----------
console.log('① 跳板机配置归一化');
t('没有跳板机(null / 缺 host / 非对象)→ null(不生成任何隧道开关)', () => {
  assert.strictEqual(w.tunnelSettings(null), null);
  assert.strictEqual(w.tunnelSettings({}), null);
  assert.strictEqual(w.tunnelSettings({ host: '   ' }), null);
  assert.strictEqual(w.tunnelSettings('{}'), null);
});
t('跳板机 JSON 字符串(老库里是 TEXT 列)也能解析', () => {
  const r = w.tunnelSettings(JSON.stringify({ host: 'gw.example', username: 'j', password: 'pw' }));
  assert.ok(r && r.rawSettings && r.rawSettings.TunnelHostName === 'gw.example', JSON.stringify(r));
});
t('非法 JSON → 明确报错(不静默地当"没有跳板机"直连出去)', () => {
  const r = w.tunnelSettings('{host:');
  assert.ok(r && /JSON/.test(r.error), JSON.stringify(r));
});
t('缺用户名 → 报错(不猜一个账号让 WinSCP 反复认证失败)', () => {
  const r = w.tunnelSettings({ host: 'gw.example', password: 'pw' });
  assert.ok(r && /用户名/.test(r.error), JSON.stringify(r));
});
t('既没密码也没私钥 → 报错(否则 WinSCP 卡在认证)', () => {
  const r = w.tunnelSettings({ host: 'gw.example', username: 'j' });
  assert.ok(r && /密码/.test(r.error), JSON.stringify(r));
});

// ---------- ② 隧道开关 ----------
console.log('② 隧道开关(实测键名)');
t('密码认证:生成 Tunnel=1 + 主机/端口/账号 + 明文密码键', () => {
  const r = w.tunnelSettings({ host: 'gw.example', port: 2222, username: 'jumpuser', password: 'pw@ss:1' });
  const rs = r.rawSettings;
  assert.strictEqual(rs.Tunnel, '1');
  assert.strictEqual(rs.TunnelHostName, 'gw.example');
  assert.strictEqual(rs.TunnelPortNumber, '2222');
  assert.strictEqual(rs.TunnelUserName, 'jumpuser');
  assert.strictEqual(rs.TunnelPasswordPlain, 'pw@ss:1'); // 明文键名就是 TunnelPasswordPlain(实测)
  assert.ok(!('TunnelPublicKeyFile' in rs));
  assert.deepStrictEqual(r.jump, { host: 'gw.example', port: 2222, user: 'jumpuser' });
  assert.strictEqual(r.usedKey, false);
});
t('用户名缺省沿用目标账号(与 Polaris 自己的跳板行为一致)', () => {
  const r = w.tunnelSettings({ host: 'gw', password: 'pw' }, { defaultUser: 'deploy' });
  assert.strictEqual(r.rawSettings.TunnelUserName, 'deploy');
});
t('端口缺省 22(不是 0 —— TunnelPortNumber=0 会被 WinSCP 当非法)', () => {
  const r = w.tunnelSettings({ host: 'gw', username: 'j', password: 'pw' });
  assert.strictEqual(r.rawSettings.TunnelPortNumber, '22');
  assert.strictEqual(w.tunnelSettings({ host: 'gw', port: 0, username: 'j', password: 'pw' }).rawSettings.TunnelPortNumber, '22');
});
t('私钥认证:走私钥路径 + 私钥标记,且不带明文密码键', () => {
  const r = w.tunnelSettings({ host: 'gw', username: 'j', private_key: 'C:/keys/id_ed25519', passphrase: 'pp' });
  assert.strictEqual(r.rawSettings.TunnelPublicKeyFile, 'C:/keys/id_ed25519');
  assert.strictEqual(r.rawSettings.TunnelPassphrase, 'pp');
  assert.ok(!('TunnelPasswordPlain' in r.rawSettings));
  assert.strictEqual(r.usedKey, true);
});
t('私钥别名 privateKey 也认(导入的会话/老数据两种写法)', () => {
  const r = w.tunnelSettings({ host: 'gw', username: 'j', privateKey: 'C:/keys/id_rsa' });
  assert.strictEqual(r.rawSettings.TunnelPublicKeyFile, 'C:/keys/id_rsa');
});
t('隧道主机指纹默认 * (WinSCP 独立连接,用不到 Polaris 的 known_hosts)', () => {
  const r = w.tunnelSettings({ host: 'gw', username: 'j', password: 'pw' });
  assert.strictEqual(r.rawSettings.TunnelHostKey, '*');
  const r2 = w.tunnelSettings({ host: 'gw', username: 'j', password: 'pw' }, { hostKey: 'ssh-ed25519 256 SHA256:abc' });
  assert.strictEqual(r2.rawSettings.TunnelHostKey, 'ssh-ed25519 256 SHA256:abc');
  assert.strictEqual(w.tunnelSettings({ host: 'gw', username: 'j', password: 'pw' }, { hostKey: '   ' }).rawSettings.TunnelHostKey, '*');
});
t('POLARIS_WINSCP_TUNNEL=off 可关掉隧道(排障逃生阀)', () => {
  assert.strictEqual(w.tunnelEnabled({}), true);
  assert.strictEqual(w.tunnelEnabled({ POLARIS_WINSCP_TUNNEL: 'on' }), true);
  assert.strictEqual(w.tunnelEnabled({ POLARIS_WINSCP_TUNNEL: 'off' }), false);
  assert.strictEqual(w.tunnelEnabled({ POLARIS_WINSCP_TUNNEL: 'OFF' }), false);
});

// ---------- ③ 脱敏(隧道密码也是密码) ----------
console.log('③ 脱敏:隧道密码/口令不许出现在任何日志');
t('redactRawSettings 把密码/口令键压成 ***,其它键原样', () => {
  const rs = { Tunnel: '1', TunnelHostName: 'gw', TunnelUserName: 'j', TunnelPasswordPlain: 'p@ss', TunnelPassphrase: 'pp', RemoteDirectory: '/root' };
  const rd = w.redactRawSettings(rs);
  assert.strictEqual(rd.TunnelPasswordPlain, '***');
  assert.strictEqual(rd.TunnelPassphrase, '***');
  assert.strictEqual(rd.TunnelHostName, 'gw');
  assert.strictEqual(rd.Tunnel, '1');
  assert.strictEqual(rd.RemoteDirectory, '/root');
  assert.strictEqual(rs.TunnelPasswordPlain, 'p@ss'); // 不改原对象(调用方还要用它拉起)
});
t('describeCommand 压掉 rawsettings 里的凭证明文(命令行会进日志/面板)', () => {
  const cmd = w.describeCommand('winscp.exe', [
    'sftp://u:pw@target.example:22/',
    '/rawsettings', 'Tunnel=1', 'TunnelHostName=gw', 'TunnelPasswordPlain=secret23', 'TunnelPassphrase=pp23',
  ]);
  assert.ok(!cmd.includes('secret23') && !cmd.includes('pp23'), cmd);
  assert.ok(cmd.includes('TunnelPasswordPlain=***') && cmd.includes('TunnelPassphrase=***'), cmd);
  assert.ok(cmd.includes('Tunnel=1') && cmd.includes('TunnelHostName=gw'), cmd);
  assert.ok(cmd.includes('sftp://u:***@target.example:22/'), cmd);
});

// ---------- ④ 参数组装 ----------
console.log('④ 组装进 argv');
t('buildArgs 把隧道开关逐个作为独立 argv 追加在 /rawsettings 之后', () => {
  const tn = w.tunnelSettings({ host: 'gw', port: 2222, username: 'j', password: 'pw' });
  const args = w.buildArgs({
    url: w.buildSessionUrl({ host: 'target.example', port: 22, username: 'root', password: 'pw' }),
    rawSettings: Object.assign({ SFTPRealPath: 'off' }, tn.rawSettings),
  });
  assert.strictEqual(args[0], 'sftp://root:pw@target.example:22/');
  const i = args.indexOf('/rawsettings');
  assert.ok(i > 0, 'has /rawsettings');
  assert.ok(args.includes('SFTPRealPath=off'));
  assert.ok(args.includes('Tunnel=1'));
  assert.ok(args.includes('TunnelHostName=gw'));
  assert.ok(args.includes('TunnelPortNumber=2222'));
  assert.ok(args.includes('TunnelUserName=j'));
  assert.ok(args.includes('TunnelPasswordPlain=pw'));
  assert.ok(args.includes('TunnelHostKey=*'));
});

// ---------- ⑤ 代码接线(main / renderer 真的用它) ----------
console.log('⑤ 接线(main.js / renderer.js)');
const mainSrc = src('main.js');
const rendSrc = src('src/renderer.js');
t('main.js 在 winScp:open 里读 p.jump 并生成隧道开关', () => {
  assert.ok(/winScp\.tunnelEnabled\(process\.env\)/.test(mainSrc), 'main 没判断 tunnelEnabled');
  assert.ok(/winScp\.tunnelSettings\(p\.jump/.test(mainSrc), 'main 没调用 tunnelSettings(p.jump)');
  assert.ok(/Object\.assign\(rawSettings, tunnel\.rawSettings\)/.test(mainSrc), '隧道开关没并进 rawSettings');
});
t('隧道配置不完整 → 明确失败(绝不静默直连内网目标)', () => {
  assert.ok(/tunnel\.error\) return \{ ok: false, error: '跳板机隧道不可用/.test(mainSrc), '没返回可读错误');
});
t('拉起日志用 redactRawSettings(隧道密码不落盘/不进面板)', () => {
  assert.ok(/rawsettings=\$\{JSON\.stringify\(winScp\.redactRawSettings\(rawSettings\)\)\}/.test(mainSrc), '日志没脱敏');
});
t('renderer 把 jump 一起交给主进程(含私钥/口令字段)', () => {
  assert.ok(/jump: s\.jump && s\.jump\.host/.test(rendSrc), 'payload 没带 jump');
  assert.ok(/private_key: s\.jump\.private_key \|\| s\.jump\.privateKey/.test(rendSrc), 'payload 没带跳板私钥');
});
t('面板日志写明"经跳板 x:port"(排障能一眼看出走没走隧道)', () => {
  assert.ok(/经跳板 \$\{j\.host\}:\$\{j\.port\}/.test(rendSrc), 'dlog 没写跳板');
});

// ---------- ⑥ 真实 WinSCP 冒烟(可选) ----------
async function smoke() {
  console.log('\n⑥ 真实 WinSCP 隧道冒烟(两个 mock SSH:A=跳板,B=目标)');
  const { freePort, sleep } = require('./test-helper');
  const { spawn } = require('child_process');
  const os = require('os');
  const exe = w.detectExe();
  if (process.platform !== 'win32' || !exe) { console.log('  ⤵ 跳过:非 Windows 或本机没装 WinSCP'); return; }
  const com = path.join(path.dirname(exe), 'WinSCP.com');
  if (!fs.existsSync(com)) { console.log('  ⤵ 跳过:找不到 WinSCP.com'); return; }

  // 端口写成常量:freePort() 只负责"清掉占用者",不返回端口号
  const pA = 2401, pA2 = 2402, pB = 2403, pB2 = 2404;
  [pA, pA2, pB, pB2].forEach(freePort);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-wscp-tunnel-'));
  const startMock = (sshPort, httpPort) => {
    const p = spawn(process.execPath, [path.join(__dirname, 'mock', 'mock-server.js')], {
      env: Object.assign({}, process.env, { MOCK_SSH_PORT: String(sshPort), MOCK_HTTP_PORT: String(httpPort) }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    p.out = '';
    p.stdout.on('data', (d) => { p.out += String(d); });
    p.stderr.on('data', (d) => { p.out += String(d); });
    p.on('error', (e) => { p.spawnError = e.message; });
    return p;
  };
  const A = startMock(pA, pA2), B = startMock(pB, pB2);
  const killed = [];
  const killAll = () => { killed.forEach((p) => { try { p.kill('SIGKILL'); } catch { /* ignore */ } }); };
  try {
    for (let i = 0; i < 100 && !(A.out.includes('KoKo SSH 网关已启动') && B.out.includes('KoKo SSH 网关已启动')); i++) await sleep(100);
    if (!A.out.includes('KoKo SSH 网关已启动') || !B.out.includes('KoKo SSH 网关已启动')) throw new Error('mock 服务器没起来 | A:' + JSON.stringify(A.out.slice(-200)) + ' | B:' + JSON.stringify(B.out.slice(-200)) + ' | spawn 错误:' + String(A.spawnError || '') + String(B.spawnError || ''));

    // 用**代码自己生成的**开关跑(而不是手写一串),这样键名/取值口径与产品一致
    const tn = w.tunnelSettings({ host: '127.0.0.1', port: pA, username: 'admin', password: 'admin123' });
    const url = w.buildSessionUrl({ host: '127.0.0.1', port: pB, username: 'admin', password: 'admin123' });
    const args = w.buildArgs({ url, rawSettings: tn.rawSettings, logPath: path.join(tmp, 'w.log'), loglevel: '2' });
    // 注意:product 的 argv 用顶级开关 `/rawsettings`(直接拉起 WinSCP.exe 的正确写法);
    // 这里在 WinSCP.com 的 `/command` 里要写成会话选项 `-rawsettings`。
    const cliArgs = args.slice();
    if (cliArgs[1] === '/rawsettings') cliArgs[1] = '-rawsettings';
    const openCmd = `open ${cliArgs[0]} -hostkey=* ${cliArgs.slice(1).join(' ')}`;
    const logPath = path.join(tmp, 'w.log');
    const r = await new Promise((resolve) => {
      const p = spawn(com, ['/ini=nul', `/log=${logPath}`, '/loglevel=2', '/command', openCmd, 'pwd', 'exit'], { env: Object.assign({}, process.env, { MSYS_NO_PATHCONV: '1' }), stdio: ['ignore', 'pipe', 'pipe'] });
      let out = ''; p.stdout.on('data', (d) => { out += String(d); }); p.stderr.on('data', (d) => { out += String(d); });
      const to = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* ignore */ } }, 30000);
      p.on('close', (code) => { clearTimeout(to); resolve({ code, out }); });
    });
    try {
      assert.strictEqual(r.code, 0, 'exit=' + r.code + ' | ' + r.out.split('\n').slice(-6).join(' / '));
      ok('真实 WinSCP 用生成的隧道开关建会话成功(退出码 0,跑到 pwd)');
      assert.ok(/TCP 转发 → 127\.0\.0\.1:/.test(A.out), '跳板侧没出现转发日志:\n' + A.out.split('\n').slice(-6).join('\n'));
      ok('跳板机(A)侧出现 TCP 转发 → 目标是经隧道连的(不是直连)');
      assert.ok(!/TCP 转发/.test(B.out), 'B 是目标,不该自己转发');
      ok('目标侧(B)没有转发记录(证明隧道确实在 A 上建立)');
    } catch (e) { bad('真实 WinSCP 隧道冒烟', e); }
  } catch (e) {
    bad('真实 WinSCP 隧道冒烟(环境)', e);
  } finally {
    killAll();
    A.kill && A.kill('SIGKILL'); B.kill && B.kill('SIGKILL');
  }
}

(async () => {
  if (process.env.POLARIS_WINSCP_SMOKE === '1') {
    await smoke();
  } else {
    console.log('\n⑥ 真实 WinSCP 隧道冒烟:跳过(要跑请设 POLARIS_WINSCP_SMOKE=1)');
  }
  console.log(`\n结果: ${passed} 通过, ${failed} 失败\n`);
  process.exit(failed ? 1 : 0);
})();
