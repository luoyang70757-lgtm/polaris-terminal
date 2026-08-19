'use strict';
/**
 * verify-sftp-size.js — 验证 SFTP 上传后的远端大小对账(防中继截断误报成功):
 *  ① 正常上传 → 远端大小 == 本地(不误报)
 *  ② 强制截断(模拟 KoKo 中继丢尾部)→ uploadFile 捕获不符 → 全量重传仍不符 →
 *     删除远端残缺文件 + 抛"上传校验失败",绝不静默报成功
 * 运行: node verify-sftp-size.js(纯 lib 逻辑,自起 mock SFTP,秒级,无需 electron)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Server: SSHServer } = require('ssh2');
const { createSftpServer } = require('./mock/sftp-vfs');
const { uploadFile, statSize } = require('./lib/ssh-client');

const PORT = 2247;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-size-'));
let passed = 0, failed = 0;
const ok = (n) => { passed++; console.log('  ✓ ' + n); };
const bad = (n, e) => { failed++; console.error('  ✗ ' + n + (e ? ' -> ' + e : '')); };

// 强制截断上限(>0 时远端文件最多 TRUNC_LIMIT 字节,模拟中继丢尾部)
const TRUNC_LIMIT = process.env.TRUNC_LIMIT ? parseInt(process.env.TRUNC_LIMIT, 10) : 0;
const server = new SSHServer({ hostKeys: [fs.readFileSync(path.join(__dirname, 'mock', 'hostkey.pem'))] }, (client) => {
  client.on('authentication', (ctx) => ctx.accept());
  client.on('ready', () => {
    client.on('session', (accept) => {
      const s = accept();
      s.on('sftp', (a) => {
        const stream = a();
        if (TRUNC_LIMIT > 0) {
          const on = stream.on.bind(stream);
          stream.on = (ev, fn) => on(ev, (reqid, handle, offset, data) => {
            if (ev === 'WRITE' && offset + data.length > TRUNC_LIMIT) {
              if (offset >= TRUNC_LIMIT) return stream.status(reqid, 3);
              data = data.slice(0, TRUNC_LIMIT - offset);
            }
            return fn(reqid, handle, offset, data);
          });
        }
        createSftpServer(stream);
      });
    });
  });
});

const { Client } = require('ssh2');
const c = new Client();

(async () => {
  await new Promise((res, rej) => server.listen(PORT, '127.0.0.1', res));
  await new Promise((res, rej) => c.on('ready', res).on('error', rej).connect({ host: '127.0.0.1', port: PORT, username: 'root', password: 'x', readyTimeout: 5000 }));
  const sftp = await new Promise((res, rej) => c.sftp((e, s) => (e ? rej(e) : res(s))));

  const local = path.join(tmp, 'f.bin');
  const size = 3 * 1024 * 1024 + 1234;
  fs.writeFileSync(local, require('crypto').randomBytes(size));

  if (TRUNC_LIMIT === 0) {
    // 正常:远端大小 == 本地,不误报
    await uploadFile(sftp, local, '/f.bin', () => {});
    const got = await statSize(sftp, '/f.bin');
    if (got === size) ok('正常上传 → 远端大小与本地一致,校验通过'); else bad('正常上传 → 远端大小与本地一致', `远端 ${got}B ≠ 本地 ${size}B`);
  } else {
    // 截断:必须抛"上传校验失败"且远端残缺文件被删除
    let threw = null;
    try { await uploadFile(sftp, local, '/f.bin', () => {}); } catch (e) { threw = e.message || String(e); }
    if (threw && threw.includes('上传校验失败')) ok('强制截断 → uploadFile 抛"上传校验失败"');
    else bad('强制截断 → uploadFile 抛"上传校验失败"', threw ? '未包含关键词: ' + threw : '竟然返回成功');
    const remain = await statSize(sftp, '/f.bin');
    if (remain === 0) ok('远端残缺文件已删除(下轮不会拿残缺前缀续传)'); else bad('远端残缺文件已删除', `仍存在 ${remain}B`);
  }

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  sftp.end(); c.end(); server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('测试异常:', e && e.message); process.exit(1); });
