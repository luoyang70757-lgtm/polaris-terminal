'use strict';
/**
 * verify-sftp-stress.js — SFTP 大批量传输压力测试(纯 lib,自起 mock SFTP,无需 electron):
 *  ① 批量上传:混合大小文件树(嵌套目录)→ uploadDir(并发池)→ 逐文件远端 statSize 对账
 *  ② 批量下载:downloadDir 到临时目录 → 逐文件本地大小对账
 *  ③ 续传决策表:resolveUploadOffset / resolveDownloadOffset 各分支断言(纯函数)
 *  ④ 截断远端续传:远端预写"真实前缀"N 字节 → uploadFile(resumeFrom=N) → 最终远端与本地逐字节一致
 *  ⑤ 中继截断读回:TRUNC_LIMIT 包裹 WRITE(模拟 KoKo 丢尾部)→ 必须删残缺 + 抛"上传校验失败"
 *
 * 规模 env 可调(mock 写入是整文件重写,O(n²),默认 60 文件/约 20MB 避免过慢):
 *   STRESS_FILES = 总文件数(默认 60)   STRESS_MAX = 单文件最大 KB(默认 2048)
 * 运行: node verify-sftp-stress.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
const { Server: SSHServer } = require('ssh2');
const { Client } = require('ssh2');

// 必须在 require mock/sftp-vfs 之前设好:让 mock 磁盘根指向临时目录,用后自清理,不污染演示磁盘
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'polaris-stress-'));
const localSrc = path.join(tmpBase, 'src');
const localDst = path.join(tmpBase, 'dst');
const mockRoot = path.join(tmpBase, 'mock-root');
fs.mkdirSync(localSrc, { recursive: true });
fs.mkdirSync(localDst, { recursive: true });
process.env.MOCK_SFTP_ROOT = mockRoot;

const { createSftpServer } = require('./mock/sftp-vfs');
const sshClient = require('./lib/ssh-client');
const { uploadDir, downloadDir, uploadFile, statSize, walkRemote, resolveUploadOffset, resolveDownloadOffset } = sshClient;

const HOSTKEY = path.join(__dirname, 'mock', 'hostkey.pem');
const STRESS_FILES = parseInt(process.env.STRESS_FILES || '60', 10);
const STRESS_MAX_KB = parseInt(process.env.STRESS_MAX || '2048', 10); // 单文件最大 KB

let passed = 0, failed = 0;
const ok = (n) => { passed++; console.log('  ✓ ' + n); };
const bad = (n, e) => { failed++; console.error('  ✗ ' + n + (e ? ' -> ' + e : '')); };

// 拿一个空闲端口(绑定 0 拿系统分配,再释放),避免和别的测试撞端口
function freePort() {
  return new Promise((res) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => res(p)); });
  });
}

// 起一个 ssh2 服务器(可挂 TRUNC_LIMIT 截断包裹,模拟 KoKo 中继丢尾部),返回 { server, port }
async function makeServer(truncLimit) {
  const port = await freePort();
  const server = new SSHServer({ hostKeys: [fs.readFileSync(HOSTKEY)] }, (client) => {
    client.on('authentication', (ctx) => ctx.accept());
    client.on('ready', () => {
      client.on('session', (accept) => {
        const s = accept();
        s.on('sftp', (a) => {
          const stream = a();
          if (truncLimit > 0) {
            const on = stream.on.bind(stream);
            stream.on = (ev, fn) => on(ev, (reqid, handle, offset, data) => {
              if (ev === 'WRITE' && offset + data.length > truncLimit) {
                if (offset >= truncLimit) return stream.status(reqid, 3);
                data = data.slice(0, truncLimit - offset);
              }
              return fn(reqid, handle, offset, data);
            });
          }
          createSftpServer(stream);
        });
      });
    });
  });
  await new Promise((res) => server.listen(port, '127.0.0.1', res));
  return { server, port };
}

function connect(port) {
  return new Promise((resolve, reject) => {
    const c = new Client();
    c.on('ready', () => c.sftp((e, s) => (e ? reject(e) : resolve({ c, sftp: s }))))
      .on('error', reject)
      .connect({ host: '127.0.0.1', port, username: 'root', password: 'x', readyTimeout: 5000 });
  });
}

// 生成混合大小 + 嵌套目录的文件树,返回 { lp, rp, size } 清单
function makeTree() {
  const dirs = ['', 'sub', 'sub/deep'];
  for (const d of dirs) fs.mkdirSync(path.join(localSrc, d), { recursive: true });
  const rand = (minKB, maxKB) => Math.floor(minKB * 1024 + Math.random() * ((maxKB - minKB) * 1024));
  const sizeOf = (i) => {
    if (i < STRESS_FILES * 0.6) return rand(16, 128);    // 60% 小文件 16-128KB
    if (i < STRESS_FILES * 0.9) return rand(256, 1024);  // 30% 中文件 256KB-1MB
    return rand(1024, STRESS_MAX_KB);                     // 10% 大文件 1MB-STRESS_MAX_KB
  };
  const files = [];
  for (let i = 0; i < STRESS_FILES; i++) {
    const size = sizeOf(i);
    const d = dirs[i % dirs.length];
    const name = `f${i}.bin`;
    fs.writeFileSync(path.join(localSrc, d, name), crypto.randomBytes(size));
    files.push({ lp: path.join(localSrc, d, name), rp: path.posix.join('/stress', d, name), size });
  }
  fs.mkdirSync(path.join(localSrc, 'empty-parent', 'empty'), { recursive: true }); // 空目录也要能处理
  return files;
}

(async () => {
  const t0 = Date.now();
  const files = makeTree();
  const totalBytes = files.reduce((s, f) => s + f.size, 0);
  console.log(`生成 ${files.length} 个文件,共 ${(totalBytes / 1024 / 1024).toFixed(1)} MB(含嵌套子目录)`);

  // 服务器 1:正常(无截断)—— 批量上传/下载 + 截断远端续传
  const { server, port } = await makeServer(0);
  const { c, sftp } = await connect(port);

  // ① 批量上传
  const upStart = Date.now();
  const { uploaded, failed: uploadFailed } = await uploadDir(sftp, localSrc, '/stress', () => {});
  if (uploadFailed.length === 0 && uploaded.length === files.length) {
    ok(`① 批量上传 ${uploaded.length}/${files.length} 个文件(并发池 ${sshClient.SFTP_CONCURRENCY})`);
  } else bad('① 批量上传全部成功', `uploaded=${uploaded.length}, failed=${JSON.stringify(uploadFailed.slice(0, 3))}`);
  // 逐文件远端大小对账
  const remoteFiles = await walkRemote(sftp, '/stress', localDst);
  const badSize = [];
  for (const f of remoteFiles) {
    const sz = await statSize(sftp, f.rp);
    if (sz !== f.size) badSize.push(`${f.rp}:${sz}≠${f.size}`);
  }
  if (badSize.length === 0) ok(`① 远端 ${remoteFiles.length} 个文件大小全部对账一致`);
  else bad('① 远端大小对账', badSize.slice(0, 3).join(', '));

  // ② 批量下载
  const dlStart = Date.now();
  await downloadDir(sftp, '/stress', localDst, () => {});
  const badDl = [];
  for (const f of files) {
    const lp = localDst + f.rp.slice('/stress'.length);
    if (!fs.existsSync(lp) || fs.statSync(lp).size !== f.size) badDl.push(f.rp);
  }
  if (badDl.length === 0) ok(`② 批量下载 ${files.length} 个文件全部落盘且大小一致`);
  else bad('② 批量下载对账', badDl.slice(0, 3).join(', '));

  // ③ 续传决策表(纯函数 7 分支)
  const pU = { bytes: 1000, mtimeMs: 111 };
  const d = [
    resolveUploadOffset(pU, 111, 1000) === 1000,        // 匹配 → 续 1000
    resolveUploadOffset(pU, 222, 1000) === 0,           // 本地 mtime 变过 → 全量
    resolveUploadOffset(pU, 111, 500) === 0,            // 远端被改小 → 全量
    resolveUploadOffset(pU, 111, 0) === 0,              // 远端没了/0 字节 → 全量
    resolveUploadOffset(undefined, 111, 1000) === 0,    // 无记录 → 全量
    resolveDownloadOffset({ bytes: 800 }, 800) === 800, // 本地残留恰好匹配 → 续
    resolveDownloadOffset({ bytes: 800 }, 700) === 0,   // 本地残留不符 → 全量
  ];
  if (d.every(Boolean)) ok('③ 续传决策表 7 分支全部正确');
  else bad('③ 续传决策表', '[' + d.join(',') + ']');

  // ④ 截断远端续传:远端预写真实前缀 prefix 字节 → uploadFile(resumeFrom=prefix) → 最终与本地逐字节一致
  const rFile = files[0];
  const prefix = Math.floor(rFile.size * 0.4);
  const prefixBuf = fs.readFileSync(rFile.lp).subarray(0, prefix); // 用真实前缀,保证续传后内容完整
  await new Promise((res, rej) => {
    const ws = sftp.createWriteStream(rFile.rp);
    ws.on('error', rej).on('close', res);
    ws.end(prefixBuf);
  });
  await uploadFile(sftp, rFile.lp, rFile.rp, () => {}, prefix);
  const after = await statSize(sftp, rFile.rp);
  const remoteContent = await new Promise((res, rej) => {
    const chunks = [];
    const rs = sftp.createReadStream(rFile.rp);
    rs.on('data', (d) => chunks.push(d));
    rs.on('error', rej);
    rs.on('end', () => res(Buffer.concat(chunks)));
  });
  if (after === rFile.size && remoteContent.equals(fs.readFileSync(rFile.lp))) {
    ok(`④ 截断远端续传:${prefix}B 前缀 → 补齐到 ${after}B,与本地逐字节一致`);
  } else bad('④ 截断远端续传', `after=${after}, 期望=${rFile.size}, 内容一致=${remoteContent.equals(fs.readFileSync(rFile.lp))}`);

  c.end(); server.close();

  // ⑤ 中继截断读回:TRUNC_LIMIT 包裹 → uploadFile 必须删残缺 + 抛"上传校验失败"
  const { server: s2, port: p2 } = await makeServer(512 * 1024); // 远端最多 512KB
  const { c: c2, sftp: sftp2 } = await connect(p2);
  const big = path.join(tmpBase, 'big.bin');
  const bigSize = 2 * 1024 * 1024 + 777;
  fs.writeFileSync(big, crypto.randomBytes(bigSize));
  let threw = null;
  try { await uploadFile(sftp2, big, '/big.bin', () => {}); } catch (e) { threw = e.message || String(e); }
  if (threw && threw.includes('上传校验失败')) ok('⑤ 中继截断 → 抛"上传校验失败"');
  else bad('⑤ 中继截断 → 抛"上传校验失败"', threw ? '未含关键词: ' + threw : '竟然返回成功');
  const remain = await statSize(sftp2, '/big.bin');
  if (remain === 0 || remain === null) ok('⑤ 远端残缺文件已删除(下轮不会拿残缺前缀续传)');
  else bad('⑤ 远端残缺文件已删除', `仍存在 ${remain}B`);
  c2.end(); s2.close();

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n耗时 ${elapsed}s(上传 ${((Date.now() - upStart) / 1000).toFixed(1)}s / 下载 ${((Date.now() - dlStart) / 1000).toFixed(1)}s)`);
  console.log(`结果: ${passed} 通过, ${failed} 失败`);
  fs.rmSync(tmpBase, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('测试异常:', e && e.stack || e); try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch { /* ignore */ } process.exit(1); });
