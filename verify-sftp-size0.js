'use strict';
/**
 * verify-sftp-size0.js — 验证 SFTP 列表对"设备 readdir 报 size 0"的修复(node 直跑)
 *
 * H3C 网络设备等 SFTP 对已写入文件 readdir 恒报 size 0(数据其实在)。修复:
 * 1) 本次上传过的文件 → 主进程 sftpKnownSizes 已知记录覆盖真实大小
 * 2) 未上传但 stat 能报真实值 → 新鲜 stat 兜底
 * 3) 两者都拿不到 → 保持 0(避免逐文件读内容拖垮慢目录)
 * 本脚本复刻 main.js sftp:list 的条目映射逻辑做纯函数验证。
 *
 * 运行: node verify-sftp-size0.js
 */
const assert = require('assert');

let passed = 0, failed = 0;
async function ok(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.log('  ✗ ' + name + ' — ' + (e && e.message)); }
}

// 复刻 main.js sftp:list 的条目映射逻辑
async function mapEntries(items, remotePath, sessionId, knownSizes, sftp) {
  return Promise.all(items.map(async (it) => {
    const isDir = !!it.attrs.isDirectory();
    let size = it.attrs.size || 0;
    const join = (d, n) => (d === '/' || d === '') ? `/${n}` : `${d.replace(/\/$/, '')}/${n}`;
    const fullPath = join(remotePath, it.filename);
    if (!isDir && size === 0) {
      const known = knownSizes.get(`${sessionId}|${fullPath}`);
      if (known) size = known;
      else {
        try {
          const a = await new Promise((res, rej) => sftp.stat(fullPath, (e, x) => (e ? rej(e) : res(x))));
          if (a && a.size) size = a.size;
        } catch { /* keep 0 */ }
      }
    }
    return { name: it.filename, isDir, size };
  }));
}

(async () => {
  // 场景1:撒谎设备(readdir 恒 0,stat 对 f2 报真实值,其余 0)
  const lyingSftp = { stat: (p, cb) => { const s = { '/home/user/up/f2': 2048 }; cb(null, { size: s[p] || 0 }); } };
  const known = new Map([
    ['sess1|/home/user/up/f1', 1024],
    ['sess1|/home/user/up/f3', 4096],
  ]);
  await ok('已知上传记录覆盖真实大小 + stat 兜底 + 都拿不到保持 0 + 目录不显示大小', async () => {
    const items = [
      { filename: 'f1', attrs: { size: 0, mtime: 10, isDirectory: () => false } },
      { filename: 'f2', attrs: { size: 0, mtime: 11, isDirectory: () => false } },
      { filename: 'f3', attrs: { size: 0, mtime: 12, isDirectory: () => false } },
      { filename: 'f4', attrs: { size: 0, mtime: 13, isDirectory: () => false } },
      { filename: 'sub', attrs: { mode: 0o040000, size: 0, isDirectory: () => true } },
    ];
    const res = await mapEntries(items, '/home/user/up', 'sess1', known, lyingSftp);
    const byName = Object.fromEntries(res.map((e) => [e.name, e]));
    assert.strictEqual(byName.f1.size, 1024, 'f1 应被已知记录覆盖为 1024');
    assert.strictEqual(byName.f2.size, 2048, 'f2 应被 stat 兜底为 2048');
    assert.strictEqual(byName.f3.size, 4096, 'f3 应被已知记录覆盖为 4096');
    assert.strictEqual(byName.f4.size, 0, 'f4 都拿不到应保持 0');
    assert.strictEqual(byName.sub.size, 0, '目录不显示大小');
  });

  // 场景2:stat 正常设备,readdir 属性过期报 0 → stat 兜底拿真实值
  await ok('readdir 属性过期但 stat 正常 → stat 兜底', async () => {
    const normal = { stat: (p, cb) => cb(null, { size: p.includes('f1') ? 999 : 0 }) };
    const res = await mapEntries([{ filename: 'f1', attrs: { size: 0, mtime: 1, isDirectory: () => false } }], '/d', 'sess2', new Map(), normal);
    assert.strictEqual(res[0].size, 999);
  });

  console.log('\n=== ' + (failed ? failed + ' 项失败' : '全部通过(' + passed + ')') + ' ===');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('执行异常:', e.message); process.exit(1); });
