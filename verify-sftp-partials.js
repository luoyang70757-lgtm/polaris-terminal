'use strict';
/**
 * verify-sftp-partials.js — SFTP 断点续传记录表(lib/sftp-partials.js)单测:
 *  ① set → 重新加载模块(模拟重启)→ get 拿到 {bytes, mtimeMs, ts}(真落盘)
 *  ② remove → 记录消失
 *  ③ prune 过期裁剪:盘上把 ts 改成 8 天前 → 只有旧记录被删
 *  ④ 损坏 JSON → 兜底空对象,get 不抛错(退化为全量重传,不产生错误数据)
 * 运行: node verify-sftp-partials.js(纯模块单测,无 ssh/electron,秒级)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-partials-'));
process.env.POLARIS_LOCK_DIR = tmp; // 必须在 require 之前设好,让 lockDir() 指向临时目录

const MOD = './lib/sftp-partials';
const freshRequire = () => { delete require.cache[require.resolve(MOD)]; return require(MOD); };
const partials = freshRequire(); // 第一个实例

let passed = 0, failed = 0;
const ok = (n) => { passed++; console.log('  ✓ ' + n); };
const bad = (n, e) => { failed++; console.error('  ✗ ' + n + (e ? ' -> ' + e : '')); };

(async () => {
  const key = 'root@10.0.0.1:22:u:/root/x.bin';

  // ① set → 重新加载(模拟 app 重启)→ get 拿到完整记录
  partials.set(key, { bytes: 1234, mtimeMs: 1000 });
  const fresh = freshRequire();
  const got = fresh.get(key);
  if (got && got.bytes === 1234 && got.mtimeMs === 1000 && typeof got.ts === 'number') {
    ok('set → 重新加载模块(模拟重启) → get 拿到 {bytes, mtimeMs, ts}');
  } else bad('set → 重新加载 → get 拿到 {bytes, mtimeMs, ts}', JSON.stringify(got));

  const fp = fresh._file();
  if (fs.existsSync(fp)) ok('落盘文件已生成: ' + path.basename(fp));
  else bad('落盘文件已生成');

  // ② remove → 消失
  fresh.remove(key);
  if (fresh.get(key) === undefined) ok('remove → 记录消失'); else bad('remove → 记录消失');

  // ③ prune:盘上把 one 的 ts 改成 8 天前,newer 保留 → 只删 one
  fresh.set('one', { bytes: 5 });
  fresh.set('newer', { bytes: 6 });
  const onDisk = JSON.parse(fs.readFileSync(fp, 'utf8'));
  onDisk['one'].ts = Date.now() - 8 * 24 * 3600 * 1000;
  fs.writeFileSync(fp, JSON.stringify(onDisk));
  const pruned = freshRequire();
  const removed = pruned.prune(7 * 24 * 3600 * 1000);
  if (removed === 1 && pruned.get('one') === undefined && pruned.get('newer') && pruned.get('newer').bytes === 6) {
    ok('prune → 8 天前的旧记录被删,新记录保留(removed=' + removed + ')');
  } else bad('prune → 8 天前旧记录被删、新记录保留', `removed=${removed}, one=${pruned.get('one')}, newer=${JSON.stringify(pruned.get('newer'))}`);

  // ④ 损坏 JSON → 兜底空对象,get 不抛错
  fs.writeFileSync(fp, '{corrupt json !!!');
  const corrupt = freshRequire();
  let threw = false;
  let v;
  try { v = corrupt.get('anything'); } catch (e) { threw = true; }
  if (!threw && v === undefined) ok('损坏 JSON → 兜底空对象,get 返回 undefined 不抛错'); else bad('损坏 JSON → 兜底空对象', threw ? '抛错' : `get=${v}`);

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('测试异常:', e && e.stack || e); process.exit(1); });
