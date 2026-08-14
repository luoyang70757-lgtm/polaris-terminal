'use strict';
/**
 * verify-dangerous.js — 危险命令解析器 v2 验证(node 直跑)
 *
 * 验证:复合命令拆分、引号/转义绕过、危险分级、旧接口兼容。
 * 运行: node verify-dangerous.js
 */
const assert = require('assert');
const { splitCommands, stripQuotes, analyzeCommand, isDangerousCommand } = require('./lib/dangerous.js');

let passed = 0, failed = 0;
function ok(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.log('  ✗ ' + name + ' — ' + e.message); }
}

// ---- 命令拆分 ----
ok('拆分复合命令(&& || ; | 换行)', () => {
  assert.deepStrictEqual(splitCommands('a && b || c; d | e\nf'), ['a', 'b', 'c', 'd', 'e', 'f']);
});
ok('拆分保留引号内的分隔符', () => {
  assert.deepStrictEqual(splitCommands('echo "a; b" && ls'), ['echo "a; b"', 'ls']);
});
ok('拆分忽略空段', () => {
  assert.deepStrictEqual(splitCommands('ls;;pwd'), ['ls', 'pwd']);
});

// ---- 引号/转义归一 ----
ok('stripQuotes 还原引号内命令', () => {
  assert.strictEqual(stripQuotes('r"m" -rf /'), 'rm -rf /');
  assert.strictEqual(stripQuotes("rm -r'f' /"), 'rm -rf /');
  assert.strictEqual(stripQuotes('r\\m -rf /'), 'rm -rf /');
});

// ---- 分级 ----
ok('rm -rf / → critical(删除根目录)', () => {
  const a = analyzeCommand('rm -rf /');
  assert.strictEqual(a.level, 'critical');
  assert.ok(a.findings.some((f) => f.name === '删除根目录'));
});
ok('rm -rf /* → critical', () => {
  assert.strictEqual(analyzeCommand('rm -rf /*').level, 'critical');
});
ok('rm -rfv /tmp/x → high(非根,递归删除)', () => {
  const a = analyzeCommand('rm -rfv /tmp/x');
  assert.strictEqual(a.level, 'high');
  assert.ok(a.findings.some((f) => f.name.includes('rm -rf')));
});
ok('reboot → high', () => {
  assert.strictEqual(analyzeCommand('sudo reboot now').level, 'high');
});
ok('mkfs.ext4 /dev/sdb1 → critical', () => {
  assert.strictEqual(analyzeCommand('mkfs.ext4 /dev/sdb1').level, 'critical');
});
ok('dd 写盘 → critical', () => {
  assert.strictEqual(analyzeCommand('dd if=img of=/dev/sda bs=4M').level, 'critical');
});
ok('fork 炸弹 → critical', () => {
  assert.strictEqual(analyzeCommand(':(){ :|:& };:').level, 'critical');
});
ok('普通命令 → safe', () => {
  assert.strictEqual(analyzeCommand('ls -la /tmp').level, 'safe');
  assert.strictEqual(analyzeCommand('rm /tmp/x.txt').level, 'safe'); // 无 -r/-f
});

// ---- 旧版被绕过的场景(升级核心价值) ----
ok('echo ok; rm -rf / 复合绕过 → critical', () => {
  const a = analyzeCommand('echo ok; rm -rf /');
  assert.strictEqual(a.level, 'critical');
});
ok('r"m" -rf / 引号绕过 → critical', () => {
  const a = analyzeCommand('r"m" -rf /');
  assert.strictEqual(a.level, 'critical');
});
ok('rm  -rf / 双空格 → critical', () => {
  assert.strictEqual(analyzeCommand('rm  -rf /').level, 'critical');
});

// ---- 旧接口兼容 ----
ok('isDangerousCommand 兼容(危险=true,安全=false)', () => {
  assert.strictEqual(isDangerousCommand('reboot'), true);
  assert.strictEqual(isDangerousCommand('ls'), false);
  assert.strictEqual(isDangerousCommand(''), false);
  assert.strictEqual(isDangerousCommand(null), false);
});

console.log('\n=== 汇总: ' + passed + ' 通过, ' + failed + ' 失败 ===');
process.exit(failed ? 1 : 0);
