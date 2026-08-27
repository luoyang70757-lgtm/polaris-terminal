'use strict';
/**
 * verify-sftp-sizes.js — SFTP 上传真实大小记录表(lib/sftp-sizes.js)单测:
 *  ① set → 重新加载模块(模拟重启)→ get 拿到 {size, ts}(真落盘,H3C 重连后仍能覆盖显示 0)
 *  ② remove → 记录消失
 *  ③ prune 过期裁剪:盘上把 ts 改成 31 天前 → 只有旧记录被删
 *  ④ 损坏 JSON → 兜底空对象,get 不抛错(放弃覆盖,按设备报的 0 显示,不产生错误数据)
 * 运行: node verify-sftp-sizes.js(纯模块单测,无 ssh/electron,秒级)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-sizes-'));
process.env.POLARIS_LOCK_DIR = tmp; // 必须在 require 之前设好,让 lockDir() 指向临时目录

const MOD = './lib/sftp-sizes';
const freshRequire = () => { delete require.cache[require.resolve(MOD)]; return require(MOD); };
const sizes = freshRequire(); // 第一个实例

let passed = 0, failed = 0;
const ok = (n) => { passed++; console.log('  ✓ ' + n); };
const bad = (n, e) => { failed++; console.error('  ✗ ' + n + (e ? ' -> ' + e : '')); };

(async () => {
  const key = 'admin@ssh@root@192.168.1.254@192.168.1.250:2222|flash:/test/a.bin';

  // ① set → 重新加载(模拟 app 重启)→ get 拿到完整记录(键稳定,重连后仍能取到)
  sizes.set(key, 10240);
  const fresh = freshRequire();
  const got = fresh.get(key);
  if (got && got.size === 10240 && typeof got.ts === 'number') {
    ok('set → 重新加载模块(模拟重启) → get 拿到 {size, ts}');
  } else bad('set → 重新加载 → get 拿到 {size, ts}', JSON.stringify(got));

  const fp = fresh._file();
  if (fs.existsSync(fp)) ok('落盘文件已生成: ' + path.basename(fp));
  else bad('落盘文件已生成');

  // ② remove → 消失
  fresh.remove(key);
  if (fresh.get(key) === undefined) ok('remove → 记录消失'); else bad('remove → 记录消失');

  // ③ prune:盘上把 one 的 ts 改成 31 天前,newer 保留 → 只删 one
  fresh.set('one', 5);
  fresh.set('newer', 7);
  const jp = fresh._file();
  const data = JSON.parse(fs.readFileSync(jp, 'utf8'));
  data.one.ts = Date.now() - 31 * 24 * 3600 * 1000; // 改旧
  fs.writeFileSync(jp, JSON.stringify(data));
  const removed = freshRequire().prune();
  if (removed === 1 && freshRequire().get('one') === undefined && freshRequire().get('newer')) {
    ok('prune → 只删 31 天前的旧记录,新记录保留(removed=' + removed + ')');
  } else bad('prune 过期裁剪', `removed=${removed}, one=${JSON.stringify(freshRequire().get('one'))}`);

  // ④ 损坏 JSON → 兜底空对象,get 不抛错
  fs.writeFileSync(jp, '{oops broken json');
  const corrupt = freshRequire();
  try {
    const v = corrupt.get('anything');
    if (v === undefined) ok('损坏 JSON → 兜底空对象,get 返回 undefined 不抛错');
    else bad('损坏 JSON 兜底', JSON.stringify(v));
  } catch (e) { bad('损坏 JSON 兜底', e.message); }

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('\n测试异常:', e && e.message); process.exit(1); });
