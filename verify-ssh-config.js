'use strict';
/**
 * verify-ssh-config.js — 纯 Node 单测 lib/ssh-config.js 的 ~/.ssh/config 解析器
 * 不 spawn electron、不碰数据库,直接 require 纯函数验证。用法:node verify-ssh-config.js
 */
const assert = require('assert');
const { parseSshConfig, defaultSshConfigPath, parseProxyJump, parseProxyCommand } = require('./lib/ssh-config');

let pass = 0;

function eq(actual, expected, msg) {
  assert.deepStrictEqual(actual, expected, msg);
  pass++;
  console.log(`  ok - ${msg}`);
}

// 1. 空文本 / 无 Host 段
eq(parseSshConfig(''), [], '#1 空文本 → 0 行');
eq(parseSshConfig('# 只有注释\n\nHostName foo\n'), [], '#2 只有注释+顶层 HostName → 0 行(无 Host 段)');

// 2. 基本 Host + HostName + User + Port
eq(
  parseSshConfig('Host server1\n  HostName 10.0.0.5\n  User root\n  Port 2222\n'),
  [{ name: 'server1', host: '10.0.0.5', port: 2222, username: 'root', password: '', group: '默认分组' }],
  '#3 基本 Host 段解析'
);

// 3. Host *(通配)作为全局默认,其后具体 Host 继承
const global3 = parseSshConfig('Host *\n  User deploy\n  IdentityFile ~/.ssh/id_ed25519\nHost web\n  HostName 1.2.3.4\n');
eq(global3.length, 1, '#4a Host * 不生成会话,只作默认');
eq(global3[0].username, 'deploy', '#4b 继承全局 User');
eq(global3[0].host, '1.2.3.4', '#4c 继承后 HostName 覆盖 pattern');

// 4. IdentityFile ~ 展开(homedir)
const home = require('os').homedir();
const have = global3[0].privateKey;
eq(have, require('path').join(home, '.ssh', 'id_ed25519'), '#5 IdentityFile ~ 展开成绝对路径');

// 5. "Keyword = value" 写法 + HostName 在具体段覆盖全局
eq(
  parseSshConfig('Host = prod\n  HostName = 9.9.9.9\n  User = admin\n'),
  [{ name: 'prod', host: '9.9.9.9', port: 22, username: 'admin', password: '', group: '默认分组' }],
  '#6 "Keyword = value" 写法'
);

// 6. 具体段覆盖其后的 Host * 默认(Match 语义:默认块只对其后生效)
eq(
  parseSshConfig('Host a\n  HostName 1.1.1.1\n  User alice\nHost *\n  User bob\nHost b\n  HostName 2.2.2.2\n'),
  [
    { name: 'a', host: '1.1.1.1', port: 22, username: 'alice', password: '', group: '默认分组' },
    { name: 'b', host: '2.2.2.2', port: 22, username: 'bob', password: '', group: '默认分组' },
  ],
  '#7 默认块只对出现其后的 Host 生效'
);

// 7. 通配 Host pattern 跳过(仅具体 pattern 生成) + 否定 pattern 跳过
const wild = parseSshConfig('Host *.prod\n  User x\nHost core !core-backup\n  HostName 3.3.3.3\n');
eq(wild, [{ name: 'core', host: '3.3.3.3', port: 22, username: '', password: '', group: '默认分组' }], '#8 通配 pattern 跳过、否定 pattern 跳过');

// 8. Match 段整体跳过(条件无法评估)
eq(
  parseSshConfig('Host m1\n  HostName 4.4.4.4\nMatch host m1\n  User should-not-apply\n'),
  [{ name: 'm1', host: '4.4.4.4', port: 22, username: '', password: '', group: '默认分组' }],
  '#9 Match 段跳过'
);

// 9. 注释剥离:行内 #、整行 #、以及 URL/值中含 # 不应误删
eq(
  parseSshConfig('# 整行注释\nHost c1  # 行内注释\n  HostName 5.5.5.5 # 端口注释\n  Port 22#not-a-comment\n'),
  [{ name: 'c1', host: '5.5.5.5', port: 22, username: '', password: '', group: '默认分组' }],
  '#10 注释剥离语义'
);

// 10. CRLF 换行与大小写
eq(
  parseSshConfig('HOST win\r\n  hostname 6.6.6.6\r\n  user Admin\r\n'),
  [{ name: 'win', host: '6.6.6.6', port: 22, username: 'Admin', password: '', group: '默认分组' }],
  '#11 CRLF + 大小写关键字'
);

// 11. 多 Host pattern 一行(Host a b c)
const multi = parseSshConfig('Host a b c\n  HostName 7.7.7.7\n');
eq(multi.map((r) => r.name), ['a', 'b', 'c'], '#12 一行多个 Host pattern 都生成');
eq(new Set(multi.map((r) => r.host)), new Set(['7.7.7.7']), '#13 多 pattern 共享同一 HostName');

// 12. defaultSshConfigPath 返回用户主目录下的路径
eq(defaultSshConfigPath(), require('path').join(require('os').homedir(), '.ssh', 'config'), '#14 默认路径');

// 13. ProxyJump → 会话 jump 字段(导入后跳板机直接可用,不用再手工填一遍)
const pj1 = parseSshConfig('Host db1\n  HostName 192.0.2.10\n  User polaris\n  ProxyJump ops@gw.example:2222\n');
eq(pj1[0].jump, { host: 'gw.example', port: 2222, username: 'ops', password: '' }, '#15 ProxyJump user@host:port → jump');
eq(pj1[0].username, 'polaris', '#16 目标账号不被跳板机账号顶替');
eq(pj1[0].host, '192.0.2.10', '#17 目标主机名照常解析');

const pj2 = parseSshConfig('Host db2\n  Hostname 192.0.2.11\n  ProxyJump gw.example\n');
eq(pj2[0].jump, { host: 'gw.example', port: 22, username: '', password: '' }, '#18 ProxyJump 只给主机 → 端口 22、用户名空(连接时沿用目标账号)');

const pj3 = parseSshConfig('Host db3\n  ProxyJump ssh://ops@gw.example:2200/\n');
eq(pj3[0].jump && pj3[0].jump.host, 'gw.example', '#19 ProxyJump ssh:// URI 形式也能认');
eq(pj3[0].jump && pj3[0].jump.port, 2200, '#19b URI 里的端口');

// 14. ProxyCommand:ssh -W 与 nc 两种常见写法
const pc1 = parseSshConfig('Host db4\n  ProxyCommand ssh -p 2222 ops@gw.example -W %h:%p\n');
eq(pc1[0].jump, { host: 'gw.example', port: 2222, username: 'ops', password: '' }, '#20 ProxyCommand ssh -W → jump(端口取 -p)');
eq(pc1[0].warn, undefined, '#20b 能解析时不带 warn');

const pc2 = parseSshConfig('Host db5\n  ProxyCommand ssh bastion -W %h:%p\n');
eq(pc2[0].jump, { host: 'bastion', port: 22, username: '', password: '' }, '#21 ProxyCommand ssh bastion -W %h:%p(默认端口 22)');

const pc3 = parseSshConfig('Host db6\n  ProxyCommand nc gw.example 2222\n');
eq(pc3[0].jump, { host: 'gw.example', port: 2222, username: '', password: '' }, '#22 ProxyCommand nc host port');

// 15. 推不出跳板机时:照常导入主机 + warn(绝不静默丢跳板信息)
const bad1 = parseSshConfig('Host db7\n  Hostname 192.0.2.12\n  ProxyJump a@gw.example,b@gw.example:22\n');
eq(bad1[0].jump, undefined, '#23 多跳(A→B→C):不导入跳板');
eq(!!bad1[0].warn, true, '#23b 多跳给出 warn');
eq(bad1[0].host, '192.0.2.12', '#23c 多跳时主机照常导入');

const bad2 = parseSshConfig('Host db8\n  ProxyCommand ssh -W %h:%p\n');
eq(bad2[0].jump, undefined, '#24 ProxyCommand 只有 %h/%p(没有跳板机)');
eq(!!bad2[0].warn, true, '#24b 给出 warn');

const bad3 = parseSshConfig('Host db9\n  ProxyCommand some-vpn-tool --flag\n');
eq(bad3[0].warn !== undefined, true, '#25 不认识的 ProxyCommand 也 warn(不猜)');

// 16. ProxyJump 优先于 ProxyCommand;none 视为不使用
const pri = parseSshConfig('Host dbA\n  ProxyJump gw.example\n  ProxyCommand nc other.example 22\n');
eq(pri[0].jump, { host: 'gw.example', port: 22, username: '', password: '' }, '#26 ProxyJump 优先于 ProxyCommand');
eq(parseSshConfig('Host dbB\n  ProxyJump none\n')[0].jump, undefined, '#27 ProxyJump none → 无跳板');

// 17. Host * 里的跳板机也当默认继承(与 OpenSSH 一致)
const glob = parseSshConfig('Host *\n  ProxyJump gw.example:22\nHost inner\n  HostName 192.0.2.13\n');
eq(glob[0].jump && glob[0].jump.host, 'gw.example', '#28 Host * 的 ProxyJump 被具体 Host 继承');

// 18. 跳板机与私钥共存(ProxyJump + IdentityFile)
const both = parseSshConfig('Host dbC\n  Hostname 192.0.2.14\n  ProxyJump ops@gw.example\n  IdentityFile ~/.ssh/id_ed25519\n');
eq(both[0].jump.host, 'gw.example', '#29 跳板机与私钥并存(不互相顶掉)');
eq(!!both[0].privateKey, true, '#29b 私钥仍展开成绝对路径');

// 19. 直接调纯函数(导出即契约)
eq(parseProxyJump('u@h:2222'), { host: 'h', port: 2222, username: 'u' }, '#30 parseProxyJump 导出可用');
eq(parseProxyCommand('nc h 22'), { host: 'h', port: 22, username: '' }, '#31 parseProxyCommand 导出可用');

// 20. 落库必须 pack(否则 node:sqlite 直接 bind 失败: cannot bind object)
const fs = require('fs');
const path = require('path');
const ipc = fs.readFileSync(path.join(__dirname, 'lib', 'session-ipc.js'), 'utf8');
eq(/jump: packJump\(x\.jump\)/.test(ipc), true, '#32 sessions:import 把 jump 对象包成 JSON 串再入库');
eq(/if \(typeof o === 'string'\)/.test(ipc), true, '#32b packJump 兼容已是 JSON 串的输入');

console.log(`\nverify-ssh-config 通过 ${pass} 项断言 ✅`);