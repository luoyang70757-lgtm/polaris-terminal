'use strict';
/**
 * verify-winscp-args.js — WinSCP 外链的参数生成(纯 Node,不启 Electron)
 *
 * 这块最容易出错的地方是**转义**:密码里一个 `@`/`:`/`%`/`/` 编码错了,WinSCP 就把
 * 用户名/密码解析歪,表现为"密码错误"或"主机名错误",用户完全看不出是编码问题。
 * 这里把 lib/winscp-open.js 的纯函数逐条钉住:
 *   ① 探测安装位置(Windows 常见目录 / 环境变量覆盖 / 非 Windows)
 *   ② 会话 URL 编码(特殊字符、无密码、无端口、缺主机报错、堡垒机复合用户名)
 *   ③ 日志脱敏(密码永远不出现)
 *   ④ 参数组装(私钥/口令/调试日志)
 * 运行: node verify-winscp-args.js
 */
const assert = require('assert');
const w = require('./lib/winscp-open');

let passed = 0, failed = 0;
const ok = (n) => { passed++; console.log('  ✓ ' + n); };
const bad = (n, e) => { failed++; console.error('  ✗ ' + n + (e ? ' → ' + e.message : '')); };
function t(name, fn) { try { fn(); ok(name); } catch (e) { bad(name, e); } }

console.log('\n=== WinSCP 外链:参数生成(纯 Node) ===\n');

// ---------- ① 探测安装位置 ----------
console.log('① 探测本机 WinSCP');
t('非 Windows 平台不猜(默认判定没装)', () => {
  assert.strictEqual(w.detectExe({ platform: 'darwin', env: { ProgramFiles: '/Applications' }, exists: () => true }), null);
});
t('Windows:命中 %ProgramFiles%\\WinSCP\\WinSCP.exe', () => {
  const exe = w.detectExe({ platform: 'win32', env: { ProgramFiles: 'C:\\Program Files' }, exists: (p) => p === 'C:\\Program Files\\WinSCP\\WinSCP.exe' });
  assert.strictEqual(exe, 'C:\\Program Files\\WinSCP\\WinSCP.exe');
});
t('Windows:64 位程序装在 x86 目录也能找到', () => {
  const exe = w.detectExe({ platform: 'win32', env: { 'ProgramFiles(x86)': 'C:\\Program Files (x86)' }, exists: (p) => p === 'C:\\Program Files (x86)\\WinSCP\\WinSCP.exe' });
  assert.strictEqual(exe, 'C:\\Program Files (x86)\\WinSCP\\WinSCP.exe');
});
t('Windows:都没装 → null', () => {
  assert.strictEqual(w.detectExe({ platform: 'win32', env: { ProgramFiles: 'C:\\PF' }, exists: () => false }), null);
});
t('POLARIS_WINSCP_PATH 覆盖探测(自定义安装/绿色版)', () => {
  const exe = w.detectExe({ platform: 'win32', env: { ProgramFiles: 'C:\\PF', POLARIS_WINSCP_PATH: 'D:\\Tools\\winscp\\WinSCP.exe' }, exists: (p) => p === 'D:\\Tools\\winscp\\WinSCP.exe' });
  assert.strictEqual(exe, 'D:\\Tools\\winscp\\WinSCP.exe');
});
t('POLARIS_WINSCP_PATH 指向不存在的文件 → null(不去猜别的)', () => {
  assert.strictEqual(w.detectExe({ platform: 'win32', env: { ProgramFiles: 'C:\\PF', POLARIS_WINSCP_PATH: 'D:\\不存在.exe' }, exists: (p) => p.includes('Program Files') }), null);
});
t('环境变量里的 %VAR% 会被展开', () => {
  assert.strictEqual(w.expandEnv('%A%\\x', { A: 'C:\\y' }), 'C:\\y\\x');
  assert.strictEqual(w.expandEnv('%nope%\\x', {}), '\\x');
});

// ---------- ② 会话 URL ----------
console.log('② 会话 URL(user/password 必须 percent-encode)');
t('普通会话: sftp://user:pw@host:port/', () => {
  assert.strictEqual(w.buildSessionUrl({ host: '10.0.0.8', port: 22, username: 'root', password: 'abc123' }), 'sftp://root:abc123@10.0.0.8:22/');
});
t('密码含 @ : / # ? % & 全部转义(否则 WinSCP 解析歪)', () => {
  const url = w.buildSessionUrl({ host: 'h', port: 22, username: 'u', password: 'p@ss:w/rd#1?2%3&4' });
  assert.strictEqual(url, 'sftp://u:p%40ss%3Aw%2Frd%231%3F2%253%264@h:22/');
  // 解码回来必须和原文一字不差
  const auth = url.slice('sftp://'.length, url.lastIndexOf('@'));
  const [u, p] = auth.split(':');
  assert.strictEqual(decodeURIComponent(u), 'u');
  assert.strictEqual(decodeURIComponent(p), 'p@ss:w/rd#1?2%3&4');
});
t('密码含空格 → %20', () => {
  assert.strictEqual(w.buildSessionUrl({ host: 'h', username: 'u', password: 'a b' }), 'sftp://u:a%20b@h/');
});
t('无密码(公钥登录)→ sftp://user@host:port/', () => {
  assert.strictEqual(w.buildSessionUrl({ host: 'h', port: 2222, username: 'u', password: '' }), 'sftp://u@h:2222/');
});
t('无端口 → 不带 :port', () => {
  assert.strictEqual(w.buildSessionUrl({ host: 'h', username: 'u', password: 'p' }), 'sftp://u:p@h/');
});
t('缺主机 → 抛错(不生成半截 URL)', () => {
  assert.throws(() => w.buildSessionUrl({ username: 'u', password: 'p' }), /缺少主机地址/);
});
t('堡垒机复合用户名 jms@ssh@账号@资产IP 编码后仍可解码还原', () => {
  const user = 'admin@ssh@root@10.1.2.3';
  const url = w.buildSessionUrl({ host: 'jms.example.com', port: 2222, username: user, password: 'pw' });
  assert.ok(url.includes('admin%40ssh%40root%4010.1.2.3'), '复合用户名要整体转义,不能被 URL 解析切开');
  const auth = url.slice('sftp://'.length, url.lastIndexOf('@'));
  assert.strictEqual(decodeURIComponent(auth.split(':')[0]), user);
});
t('IPv6 主机原样保留', () => {
  assert.strictEqual(w.buildSessionUrl({ host: '2001:db8::1', port: 22, username: 'u', password: 'p' }), 'sftp://u:p@2001:db8::1:22/');
});

// ---------- ③ 日志脱敏 ----------
console.log('③ 日志脱敏(密码绝不出现)');
t('redactUrl 把密码抹成 ***', () => {
  assert.strictEqual(w.redactUrl('sftp://u:secret@h:22/'), 'sftp://u:***@h:22/');
});
t('redactUrl 对无密码 URL 不动', () => {
  assert.strictEqual(w.redactUrl('sftp://u@h:22/'), 'sftp://u@h:22/');
});
t('redactUrl 对含编码密码的 URL 也能抹掉', () => {
  const url = w.buildSessionUrl({ host: 'h', username: 'u', password: 'p@ss' });
  const red = w.redactUrl(url);
  assert.ok(!red.includes('p%40ss'), 'redacted: ' + red);
  assert.ok(red.includes('*****') === false || red.includes('***'), red);
  assert.strictEqual(red, 'sftp://u:***@h/');
});
t('describeCommand 抹掉 URL 里的密码与 passphrase,不抹私钥路径', () => {
  const s = w.describeCommand('C:\\WinSCP.exe', [w.buildSessionUrl({ host: 'h', username: 'u', password: 'p@ss:w/rd#1' }), '-privatekey=C:\\k\\id_rsa', '-passphrase=pp']);
  assert.ok(!s.includes('pp'), s);
  assert.ok(s.includes('-passphrase=***'), s);
  assert.ok(s.includes('C:\\k\\id_rsa'), s);
});

// ---------- ④ 参数组装 ----------
console.log('④ winscp.exe 参数');
t('只有 URL', () => {
  assert.deepStrictEqual(w.buildArgs({ url: 'sftp://u:p@h/' }), ['sftp://u:p@h/']);
});
t('私钥路径 + 口令 → -privatekey= / -passphrase=', () => {
  const a = w.buildArgs({ url: 'sftp://u@h/', privateKey: 'C:\\Users\\me\\.ssh\\id_rsa', passphrase: 'pp' });
  assert.deepStrictEqual(a, ['sftp://u@h/', '-privatekey=C:\\Users\\me\\.ssh\\id_rsa', '-passphrase=pp']);
});
t('私钥文件不存在 → 不传 -privatekey(让 WinSCP 弹自己的登录框)', () => {
  const a = w.buildArgs({ url: 'sftp://u@h/', privateKey: 'X:\\no-such-key', keyExists: false });
  assert.deepStrictEqual(a, ['sftp://u@h/']);
});
t('空口令不传 -passphrase=', () => {
  assert.deepStrictEqual(w.buildArgs({ url: 'sftp://u:p@h/', passphrase: '   ' }), ['sftp://u:p@h/']);
});
t('给了 logPath 就写日志(默认级别 1);debug 时级别换成 *', () => {
  assert.deepStrictEqual(w.buildArgs({ url: 'sftp://u:p@h/', logPath: 'C:\\t\\w.log' }), ['sftp://u:p@h/', '/log=C:\\t\\w.log', '/loglevel=1']);
  assert.deepStrictEqual(w.buildArgs({ url: 'sftp://u:p@h/', debug: true, logPath: 'C:\\t\\w.log' }), ['sftp://u:p@h/', '/log=C:\\t\\w.log', '/loglevel=*']);
  // 没给路径(比如日志目录建不出来)就整组不传,不能让 WinSCP 收到空的 /log=
  assert.deepStrictEqual(w.buildArgs({ url: 'sftp://u:p@h/', debug: true, logPath: '' }), ['sftp://u:p@h/']);
  assert.deepStrictEqual(w.buildArgs({ url: 'sftp://u:p@h/', logPath: '   ' }), ['sftp://u:p@h/']);
});
t('realPathCompat:默认开(与关 WinSCP 默认行为),on/auto 时不动)', () => {
  assert.strictEqual(w.realPathCompat({}), true);
  assert.strictEqual(w.realPathCompat({ POLARIS_WINSCP_REALPATH: '' }), true);
  assert.strictEqual(w.realPathCompat({ POLARIS_WINSCP_REALPATH: 'off' }), true);
  assert.strictEqual(w.realPathCompat({ POLARIS_WINSCP_REALPATH: 'ON' }), false);
  assert.strictEqual(w.realPathCompat({ POLARIS_WINSCP_REALPATH: 'auto' }), false);
});
t('缺 URL → 抛错', () => {
  assert.throws(() => w.buildArgs({}), /缺少会话 URL/);
});
t('默认 rawsettings = SFTPRealPath off(绕开 chroot 服务器的 REALPATH(".") 失败)', () => {
  assert.deepStrictEqual(w.RAW_SETTINGS_DEFAULTS, { SFTPRealPath: 'off' });
  const a = w.buildArgs({ url: 'sftp://u:p@h/', rawSettings: w.RAW_SETTINGS_DEFAULTS });
  assert.deepStrictEqual(a, ['sftp://u:p@h/', '/rawsettings', 'SFTPRealPath=off']);
});
t('rawsettings:多个「名=值」各自一个 argv,空值跳过,顺序保持', () => {
  const a = w.buildArgs({ url: 'sftp://u:p@h/', rawSettings: { SFTPRealPath: 'off', RemoteDirectory: '/root/www', Skip: '' } });
  assert.deepStrictEqual(a, ['sftp://u:p@h/', '/rawsettings', 'SFTPRealPath=off', 'RemoteDirectory=/root/www']);
});
t('rawsettings:带空格/中文的目录整段传(不拆参)', () => {
  const a = w.buildArgs({ url: 'sftp://u:p@h/', rawSettings: { RemoteDirectory: '/srv/my dir/数据' } });
  assert.deepStrictEqual(a, ['sftp://u:p@h/', '/rawsettings', 'RemoteDirectory=/srv/my dir/数据']);
});
t('rawsettings 与私钥/口令/日志共存顺序固定', () => {
  const a = w.buildArgs({ url: 'sftp://u@h/', rawSettings: { SFTPRealPath: 'off' }, privateKey: 'C:\\k\\id_rsa', passphrase: 'pp', debug: true, logPath: 'C:\\t\\w.log' });
  assert.deepStrictEqual(a, ['sftp://u@h/', '/rawsettings', 'SFTPRealPath=off', '-privatekey=C:\\k\\id_rsa', '-passphrase=pp', '/log=C:\\t\\w.log', '/loglevel=*']);
});
t('normalizeRemotePath:只收绝对路径,相对/~ /换行一律丢弃', () => {
  assert.strictEqual(w.normalizeRemotePath('/root/www'), '/root/www');
  assert.strictEqual(w.normalizeRemotePath('  /tmp/x  '), '/tmp/x');
  assert.strictEqual(w.normalizeRemotePath('/srv/my dir'), '/srv/my dir');
  assert.strictEqual(w.normalizeRemotePath('~'), '');
  assert.strictEqual(w.normalizeRemotePath('.'), '');
  assert.strictEqual(w.normalizeRemotePath('rel/dir'), '');
  assert.strictEqual(w.normalizeRemotePath('/a\nb'), '');
  assert.strictEqual(w.normalizeRemotePath(null), '');
});
t('parseRawSettings:分号/换行分隔,只收合法名字与非空值', () => {
  assert.deepStrictEqual(w.parseRawSettings('SFTPRealPath=off;RemoteDirectory=/tmp'), { SFTPRealPath: 'off', RemoteDirectory: '/tmp' });
  assert.deepStrictEqual(w.parseRawSettings('  A=1 \n B=2 \r\n C=3  '), { A: '1', B: '2', C: '3' });
  // 非法/空/注释都丢掉,避免把怪货拼进 argv
  assert.deepStrictEqual(w.parseRawSettings('1bad=1;=x;Empt=;ok=1;#注释=1'), { ok: '1' });
  // 值里带 '=' 与空格:只按第一个 '=' 切,后面原样保留
  assert.deepStrictEqual(w.parseRawSettings('ProxyCommand=exec echo a=b'), { ProxyCommand: 'exec echo a=b' });
  assert.deepStrictEqual(w.parseRawSettings(''), {});
  assert.deepStrictEqual(w.parseRawSettings(null), {});
});
t('parseRawSettings 的结果能直接被 buildArgs 用(顺序按对象键)', () => {
  const rs = Object.assign({}, w.RAW_SETTINGS_DEFAULTS, w.parseRawSettings('RemoteDirectory=/tmp'));
  assert.deepStrictEqual(w.buildArgs({ url: 'sftp://u@h/', rawSettings: rs }), ['sftp://u@h/', '/rawsettings', 'SFTPRealPath=off', 'RemoteDirectory=/tmp']);
});
t('describeCommand 脱敏不误伤 rawsettings(目录不是敏感信息)', () => {
  const s = w.describeCommand('C:\\WinSCP.exe', w.buildArgs({ url: w.buildSessionUrl({ host: 'h', username: 'u', password: 'p@ss' }), rawSettings: { SFTPRealPath: 'off', RemoteDirectory: '/root' } }));
  assert.ok(s.includes('SFTPRealPath=off'), s);
  assert.ok(s.includes('RemoteDirectory=/root'), s);
  assert.ok(!s.includes('p@ss') && s.includes('u:***@h'), s);
});

console.log(`\n结果: ${passed} 通过, ${failed} 失败\n`);
process.exit(failed ? 1 : 0);
