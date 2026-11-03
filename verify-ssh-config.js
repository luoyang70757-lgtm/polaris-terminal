'use strict';
/**
 * verify-ssh-config.js — 纯 Node 单测 lib/ssh-config.js 的 ~/.ssh/config 解析器
 * 不 spawn electron、不碰数据库,直接 require 纯函数验证。用法:node verify-ssh-config.js
 */
const assert = require('assert');
const { parseSshConfig, defaultSshConfigPath } = require('./lib/ssh-config');

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

console.log(`\nverify-ssh-config 通过 ${pass} 项断言 ✅`);