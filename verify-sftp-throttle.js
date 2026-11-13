'use strict';
/**
 * verify-sftp-throttle.js — SFTP 传输限速的纯回归(不需要 Electron/网络)
 *
 * A. lib/sftp-throttle.js:KB/s 换算、上限、单块应耗时、人类可读文案
 * B. 节流 Transform 的**实测速率**(20 万字节 @100KB/s ≈ 2s,容忍 1.2~3.5s)与销毁不悬挂定时器
 * C. lib/ssh-client.js:限速值是模块级状态(setTransferRate/getTransferRate),上传/下载两条管道都插了节流流
 * D. 接线:设置项(set-sftp-limit)→ 渲染层 applySftpLimit → preload → main sftp:setTransferLimit → ssh-client
 * 运行: node verify-sftp-throttle.js
 */
const fs = require('fs');
const path = require('path');
const { normalizeRate, paceMs, createThrottle, describeRate } = require('./lib/sftp-throttle');
const sshClient = require('./lib/ssh-client');

let passed = 0, failed = 0;
const ok = (m) => { passed++; console.log(`  ✓ ${m}`); };
const bad = (m, extra) => { failed++; console.log(`  ✗ ${m}${extra ? ` — ${extra}` : ''}`); };
const eq = (m, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(m) : bad(m, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));
const near = (m, got, lo, hi) => (got >= lo && got <= hi ? ok(`${m}(实测 ${got})`) : bad(`${m} 超出范围 [${lo},${hi}]`, got));

const ROOT = __dirname;
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

async function main() {
console.log('\n== A. 速率换算 ==');
eq('normalizeRate(0) = 0(不限速)', normalizeRate(0), 0);
eq('normalizeRate(50) = 51200 B/s', normalizeRate(50), 51200);
eq('normalizeRate("500") = 512000 B/s', normalizeRate('500'), 512000);
eq('normalizeRate(-5) = 0', normalizeRate(-5), 0);
eq('normalizeRate("abc") = 0', normalizeRate('abc'), 0);
eq('normalizeRate(null) = 0', normalizeRate(null), 0);
eq('normalizeRate(200000) 封顶 100MB/s', normalizeRate(200000), 100 * 1024 * 1024);
eq('normalizeRate(0.001) 至少 1 B/s', normalizeRate(0.001), 1);

eq('paceMs(1024, 51200) = 20ms', paceMs(1024, 51200), 20);
eq('paceMs(0, 51200) = 0', paceMs(0, 51200), 0);
eq('paceMs(1024, 0) = 0(不限速不等待)', paceMs(1024, 0), 0);

eq('describeRate(0) = 不限速', describeRate(0), '不限速');
eq('describeRate(51200) = 50 KB/s', describeRate(51200), '50 KB/s');
eq('describeRate(2MB) = 2.0 MB/s', describeRate(2 * 1024 * 1024), '2.0 MB/s');

console.log('\n== B. 节流流实测 ==');
eq('createThrottle(0) = null(不插流,零开销)', createThrottle(0), null);
{
  // 40 块 × 5KB = 200KB,目标 100KB/s → 理论 2s
  const th = createThrottle(100 * 1024);
  let bytes = 0;
  const t0 = Date.now();
  await new Promise((resolve) => {
    th.on('data', (c) => { bytes += c.length; });
    th.on('end', resolve);
    for (let i = 0; i < 40; i++) th.write(Buffer.alloc(5 * 1024));
    th.end();
  });
  const ms = Date.now() - t0;
  bytes === 200 * 1024 ? ok('数据完整通过(200KB)') : bad('数据被丢', bytes);
  near('200KB @100KB/s 耗时约 2s', ms, 1200, 3500);
}
{
  // 无限速:同样数据应瞬间通过(确保 0 档真的没插流)
  const th = createThrottle(0);
  th === null ? ok('不限速直接返回 null') : bad('0 档仍创建了节流流');
}
{
  // 销毁不悬挂定时器:写入后立刻 destroy,close 必须很快到来
  const th = createThrottle(50 * 1024);
  const t0 = Date.now();
  const done = new Promise((resolve) => th.on('close', resolve));
  th.write(Buffer.alloc(64 * 1024)); // 会排一个 ~1.3s 的等待
  th.destroy();
  const waited = await Promise.race([done.then(() => Date.now() - t0), new Promise((r) => setTimeout(() => r(-1), 1500))]);
  waited >= 0 && waited < 400 ? ok(`destroy() 立刻关闭(等待 ${waited}ms,没留悬挂定时器)`) : bad('destroy 后 close 迟迟不来(定时器泄漏)', waited);
}

console.log('\n== C. ssh-client 的限速状态 ==');
typeof sshClient.setTransferRate === 'function' ? ok('导出 setTransferRate()') : bad('没有 setTransferRate()');
typeof sshClient.getTransferRate === 'function' ? ok('导出 getTransferRate()') : bad('没有 getTransferRate()');
{
  const before = sshClient.getTransferRate();
  const set = sshClient.setTransferRate(1024 * 1024);
  const got = sshClient.getTransferRate();
  set === 1048576 && got === 1048576 ? ok('setTransferRate(1MB/s) 生效并回读一致') : bad('限速值没生效', `${set}/${got}`);
  const back = sshClient.setTransferRate(before);
  back === before ? ok('恢复原值') : bad('恢复原值失败', back);
}
{
  const src = read('lib/ssh-client.js');
  const inserts = (src.match(/const mid = createThrottle\(TRANSFER_BYTES_PER_SEC\)/g) || []).length;
  inserts === 2 ? ok('上传/下载两条管道各插一处节流(2 处)') : bad('节流插入点数量不对', inserts);
  /if \(mid\) \{ mid\.on\('error'/.test(src) && (src.match(/mid\.on\('error'/g) || []).length === 2
    ? ok('两处都处理了节流流自身错误(且先判空)') : bad('节流流错误处理缺失/未判空');
  const destroys = (src.match(/mid && mid\.destroy\(\)/g) || []).length;
  destroys >= 4 ? ok(`取消/假死/出错分支都销毁节流流(${destroys} 处)`) : bad('有分支没销毁节流流(会留悬挂定时器)', destroys);
}

console.log('\n== D. 设置项接线 ==');
const mainSrc = read('main.js');
const preloadSrc = read('preload.js');
const rendererSrc = read('src/renderer.js');
const htmlSrc = read('src/index.html');
const has = (src, re, msg) => (re.test(src) ? ok(msg) : bad(msg));

has(mainSrc, /ipcMain\.handle\('sftp:setTransferLimit'/, 'main 注册 sftp:setTransferLimit');
has(mainSrc, /sftpThrottle\.normalizeRate\(kbps\)/, 'main 用 lib 做 KB/s → B/s 换算(单一换算源)');
has(mainSrc, /sshClient\.setTransferRate\(bytesPerSec\)/, 'main 把速率交给 ssh-client');
has(mainSrc, /\[SFTP\] 传输限速 = /, '改限速会打日志(用户能在调试面板确认生效)');
has(preloadSrc, /sftpSetTransferLimit:\s*\(kbps\) => ipcRenderer\.invoke\('sftp:setTransferLimit'/, 'preload 暴露 sftpSetTransferLimit');
has(htmlSrc, /id="set-sftp-limit"/, '设置里有「传输限速」输入框');
has(htmlSrc, /id="sftp-limit-note"/, '设置里有当前速率说明');
has(rendererSrc, /sftpSpeedLimitKBps:\s*0/, '默认 0 = 不限速');
has(rendererSrc, /els\.setSftpLimit\.addEventListener\('change'/, '改输入框立刻保存并生效');
has(rendererSrc, /applySftpLimit\(\); \/\/ 启动时/, '启动时把已保存的限速推给主进程');
has(rendererSrc, /window\.api\.sftpSetTransferLimit\(sftpLimitKbps\(\)\)/, 'applySftpLimit 走 IPC');

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed ? 1 : 0);
}

main();
