'use strict';
/**
 * verify-sftp-attrs.js — 「SFTP 权限与属性」对话框的纯回归(不需要 Electron/网络)
 *
 * 覆盖两层:
 *   A. lib/sftp-attrs.js 的纯函数(八进制解析/格式化、`ls -l` 符号串、UID/GID、时间串、patch 组装)
 *   B. 渲染层那份 `modeSymbolicPreview` / `parseAttrsModeInput` 与 lib 逐值对拍
 *      (渲染进程没有 nodeIntegration,不能 require lib,只能各写一份 —— 两份必须一致)
 * 再锁死接线(改了名字/删了入口就会红):
 *   C. 主进程三个 IPC(sftp:stat / sftp:setAttrs / sftp:setTransferLimit 相关部分)、递归上限、
 *      chown→chmod 顺序、mock SETSTAT、preload 桥、index.html 控件、右键菜单项
 * 运行: node verify-sftp-attrs.js
 */
const fs = require('fs');
const path = require('path');
const lib = require('./lib/sftp-attrs');

let passed = 0, failed = 0;
const ok = (m) => { passed++; console.log(`  ✓ ${m}`); };
const bad = (m, extra) => { failed++; console.log(`  ✗ ${m}${extra ? ` — ${extra}` : ''}`); };
const eq = (m, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(m) : bad(m, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));

const ROOT = __dirname;
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

console.log('\n== A. lib/sftp-attrs 纯函数 ==');
eq('formatMode 0o644 → 644', lib.formatMode(0o644), '644');
eq('formatMode 0o4755 → 4755', lib.formatMode(0o4755), '4755');
eq('formatMode 0o40755 去掉类型位 → 755', lib.formatMode(0o40755), '755');
eq('formatMode 非法输入 → 空串', lib.formatMode('x'), '');
eq('formatMode NaN → 空串', lib.formatMode(NaN), '');

eq('parseMode 644', lib.parseMode('644'), { ok: true, mode: 0o644 });
eq('parseMode 0644', lib.parseMode(' 0644 '), { ok: true, mode: 0o644 });
eq('parseMode 0o755', lib.parseMode('0o755'), { ok: true, mode: 0o755 });
eq('parseMode 0O700(大写前缀)', lib.parseMode('0O700'), { ok: true, mode: 0o700 });
eq('parseMode 4755(SUID)', lib.parseMode('4755'), { ok: true, mode: 0o4755 });
eq('parseMode 7777 是上限', lib.parseMode('7777'), { ok: true, mode: 0o7777 });
for (const badv of ['', '  ', '999', '8', '75', '-1', 'rwx', '7778', '17777']) {
  const r = lib.parseMode(badv);
  if (!r.ok && r.error) ok(`parseMode 拒绝「${badv}」`);
  else bad(`parseMode 误接受「${badv}」`, JSON.stringify(r));
}

eq('modeToSymbolic 644', lib.modeToSymbolic(0o644, false), '-rw-r--r--');
eq('modeToSymbolic 目录 755', lib.modeToSymbolic(0o40755, true), 'drwxr-xr-x');
eq('modeToSymbolic SUID 可执行 → s', lib.modeToSymbolic(0o4755, false), '-rwsr-xr-x');
eq('modeToSymbolic SUID 不可执行 → S', lib.modeToSymbolic(0o4644, false), '-rwSr--r--');
eq('modeToSymbolic SGID → s', lib.modeToSymbolic(0o2755, false), '-rwxr-sr-x');
eq('modeToSymbolic sticky → t', lib.modeToSymbolic(0o1777, true), 'drwxrwxrwt');
eq('modeToSymbolic sticky 不可执行 → T', lib.modeToSymbolic(0o1664, true), 'drw-rw-r-T');
eq('modeToSymbolic 0o600', lib.modeToSymbolic(0o600, false), '-rw-------');

eq('parseId 空串 = 不改(null)', lib.parseId(''), { ok: true, id: null });
eq('parseId 0 = root(不能被当空值跳过)', lib.parseId('0'), { ok: true, id: 0 });
eq('parseId 1000', lib.parseId(' 1000 '), { ok: true, id: 1000 });
for (const badv of ['root', '-1', '1.5', '1e3', '99999999']) {
  const r = lib.parseId(badv, 'UID');
  if (!r.ok && /UID/.test(r.error)) ok(`parseId 拒绝「${badv}」并说明是 UID`);
  else bad(`parseId 误接受「${badv}」`, JSON.stringify(r));
}

// 时间串:本机时区往返一致(±1s,秒级精度)
{
  const secs = [1763000000, 1600000000, 1700000000];
  let allOk = true;
  for (const s of secs) {
    const str = lib.toDatetimeLocal(s);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(str)) { allOk = false; break; }
    const back = lib.parseDatetimeLocal(str);
    if (!back.ok || Math.abs(back.sec - s) > 1) { allOk = false; break; }
  }
  allOk ? ok('toDatetimeLocal/parseDatetimeLocal 往返一致(3 个时间点)') : bad('时间串往返不一致');
}
eq('toDatetimeLocal(0) → 空串', lib.toDatetimeLocal(0), '');
eq('parseDatetimeLocal("") → null', lib.parseDatetimeLocal(''), { ok: true, sec: null });
{
  const r = lib.parseDatetimeLocal('不是时间');
  r.ok ? bad('parseDatetimeLocal 误接受非法串') : ok('parseDatetimeLocal 拒绝非法串');
}

eq('buildAttrsPatch 全空 → empty(什么都不改就不惊动服务器)', lib.buildAttrsPatch({ mode: '', uid: '', gid: '', mtime: '' }), { ok: true, empty: true, patch: {}, recursive: false });
eq('buildAttrsPatch 只改权限', lib.buildAttrsPatch({ mode: '640' }).patch, { mode: 0o640 });
eq('buildAttrsPatch uid=0 不被丢', lib.buildAttrsPatch({ mode: '644', uid: '0' }).patch, { mode: 0o644, uid: 0 });
eq('buildAttrsPatch uid+gid 同时', lib.buildAttrsPatch({ mode: '755', uid: '1000', gid: '1000' }).patch, { mode: 0o755, uid: 1000, gid: 1000 });
{
  const p = lib.buildAttrsPatch({ mode: '644', mtime: '2026-11-13T10:30', isDir: true, recursive: true });
  if (p.ok && p.recursive === true && typeof p.patch.mtime === 'number') ok('buildAttrsPatch 目录+递归 → recursive:true 且 mtime 有值');
  else bad('buildAttrsPatch 递归标记/时间不对', JSON.stringify(p));
}
{
  const p = lib.buildAttrsPatch({ mode: '644', isDir: false, recursive: true });
  if (p.ok && p.recursive === false) ok('buildAttrsPatch 文件勾递归 → 忽略(recursive:false)');
  else bad('文件不该递归', JSON.stringify(p));
}
{
  const p = lib.buildAttrsPatch({ mode: '999', uid: 'root' });
  if (!p.ok && p.errors.length === 2) ok('buildAttrsPatch 多项错误一起回传(2 条)');
  else bad('多错误没一起回传', JSON.stringify(p));
}
console.log('\n== A2. validatePatch(主进程侧的数值复核) ==');
eq('validatePatch {} → empty', lib.validatePatch({}), { ok: true, empty: true, patch: {} });
eq('validatePatch {mode:0o644}', lib.validatePatch({ mode: 0o644 }), { ok: true, empty: false, patch: { mode: 0o644 } });
eq('validatePatch 上限 0o7777 放行', lib.validatePatch({ mode: 0o7777 }).ok, true);
{
  const r = lib.validatePatch({ mode: 0o17777 & 0o7777, uid: 0 }); // 0o7777 仍合法,uid=0 不能被丢
  r.ok && r.patch.uid === 0 ? ok('validatePatch 保留 uid=0(不是"假值"跳过)') : bad('uid=0 被丢了', JSON.stringify(r));
}
for (const [label, p] of [['mode 字符串', { mode: '644' }], ['mode 负数', { mode: -1 }], ['mode 超上限', { mode: 0o10000 }],
  ['uid 小数', { uid: 1.5 }], ['gid 负数', { gid: -2 }], ['mtime 毫秒误传', { mtime: 1794537000000 }], ['mtime 负数', { mtime: -1 }]]) {
  const r = lib.validatePatch(p);
  r.ok ? bad(`validatePatch 误接受 ${label}`, JSON.stringify(r)) : ok(`validatePatch 拒绝 ${label}`);
}
{
  const r = lib.validatePatch({ mode: '644', uid: 1.5, mtime: -1 });
  !r.ok && r.errors.length === 3 ? ok('validatePatch 多项错误一起回传(3 条)') : bad('多错误没一起回传', JSON.stringify(r));
}
eq('describePatch 摘要', lib.describePatch({ mode: 0o644, uid: 0, gid: 1000 }), '权限 644 / UID 0 / GID 1000');
eq('describePatch 空 → 空串', lib.describePatch({}), '');

console.log('\n== B. 渲染层预览/解析 与 lib 逐值对拍 ==');
const rendererSrc = read('src/renderer.js');
function sliceFn(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) return null;
  let depth = 0, i = src.indexOf('{', start);
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(start, i);
}
const symSrc = sliceFn(rendererSrc, 'modeSymbolicPreview');
const parseSrc = sliceFn(rendererSrc, 'parseAttrsModeInput');
if (!symSrc) bad('renderer.js 里找不到 modeSymbolicPreview()');
if (!parseSrc) bad('renderer.js 里找不到 parseAttrsModeInput()');
if (symSrc && parseSrc) {
  // eslint-disable-next-line no-new-func
  const f = new Function(`${symSrc}\n${parseSrc}\nreturn { modeSymbolicPreview, parseAttrsModeInput };`)();
  const modes = [0o600, 0o644, 0o666, 0o700, 0o711, 0o755, 0o777, 0o000, 0o400, 0o200, 0o100,
    0o4755, 0o4644, 0o2755, 0o2644, 0o1777, 0o1664, 0o7777, 0o000, 0o40755, 0o040755 & 0o7777];
  let mismatch = 0;
  for (const m of modes) {
    for (const isDir of [false, true]) {
      if (f.modeSymbolicPreview(m, isDir) !== lib.modeToSymbolic(m, isDir)) mismatch++;
    }
  }
  mismatch === 0 ? ok(`渲染层 symbol 预览与 lib 完全一致(${modes.length}×2 组)`) : bad(`符号串不一致 ${mismatch} 组`);

  let parseMismatch = 0;
  const cases = ['644', '0644', '0o755', '4755', '7777', '', '999', '8', '75', '-1', 'rwx', '7778'];
  for (const c of cases) {
    const a = f.parseAttrsModeInput(c);
    const b = lib.parseMode(c);
    const same = a.ok === b.ok && (a.ok ? a.mode === b.mode : true);
    if (!same) parseMismatch++;
  }
  parseMismatch === 0 ? ok(`渲染层八进制解析与 lib 判定一致(${cases.length} 组)`) : bad(`解析判定不一致 ${parseMismatch} 组`);
}

console.log('\n== C. 接线(改坏即红) ==');
const mainSrc = read('main.js');
const preloadSrc = read('preload.js');
const htmlSrc = read('src/index.html');
const mockSrc = read('mock/sftp-vfs.js');
const sftpClientSrc = read('lib/ssh-client.js');

const has = (src, re, msg) => (re.test(src) ? ok(msg) : bad(msg));

has(mainSrc, /ipcMain\.handle\('sftp:stat'/, 'main.js 注册 sftp:stat');
has(mainSrc, /ipcMain\.handle\('sftp:setAttrs'/, 'main.js 注册 sftp:setAttrs');
has(mainSrc, /ipcMain\.handle\('sftp:setTransferLimit'/, 'main.js 注册 sftp:setTransferLimit');
has(mainSrc, /function walkRemotePaths\(/, 'main.js 有递归列目录 walkRemotePaths()');
has(mainSrc, /SFTP_ATTRS_RECURSE_MAX\s*=\s*\d+/, 'main.js 有递归条目上限(防止误点拖死通道)');
{
  // chown 必须在 chmod 之前(否则 setuid/setgid 位会被 chown 清掉)
  const iChown = mainSrc.indexOf('await chownP(');
  const iChmod = mainSrc.indexOf('await chmodP(');
  (iChown > 0 && iChmod > iChown) ? ok('setAttrs 顺序:先 chown 再 chmod') : bad('chown/chmod 顺序不对', `${iChown}/${iChmod}`);
}
has(mainSrc, /sftpAttrs\.validatePatch\(patch\)/,'main.js 用 lib.validatePatch 复核数值(单一校验源)');
has(mainSrc, /if \(v\.empty\) return \{ ok: false, error: '没有要修改的项目' \}/, 'main.js 拦下"什么都没改"的请求');
has(mainSrc, /text: sftpAttrs\.describePatch\(p\)/, 'setAttrs 回传可读摘要(状态栏用)');
has(mockSrc, /on\('SETSTAT'/, 'mock sftp-vfs 支持 SETSTAT(chmod/chown/utimes 才有应答)');
has(mockSrc, /node\.type === 'dir' \? 0o040000 : 0o100000/, 'mock 改 mode 时保留类型位(否则目录被当文件)');
has(sftpClientSrc, /const mid = createThrottle\(TRANSFER_BYTES_PER_SEC\)/, 'ssh-client 下载/上传插入节流流');

has(preloadSrc, /sftpStat:\s*\(sessionId, remotePath\) => ipcRenderer\.invoke\('sftp:stat'/, 'preload 暴露 sftpStat');
has(preloadSrc, /sftpSetAttrs:\s*\(sessionId, remotePath, patch, recursive\)/, 'preload 暴露 sftpSetAttrs');
has(preloadSrc, /sftpSetTransferLimit:\s*\(kbps\)/, 'preload 暴露 sftpSetTransferLimit');

for (const id of ['attrs-modal', 'attrs-path', 'attrs-mode', 'attrs-mode-preview', 'attrs-uid', 'attrs-gid', 'attrs-mtime', 'attrs-recursive', 'attrs-recursive-row', 'attrs-save', 'attrs-cancel', 'set-sftp-limit', 'sftp-limit-note']) {
  has(htmlSrc, new RegExp(`id="${id}"`), `index.html 有 #${id}`);
}
has(htmlSrc, /data-attrs-mode="644"/, 'index.html 有 644 快捷档位');

has(rendererSrc, /🔐 权限与属性/, 'SFTP 右键菜单有「🔐 权限与属性」');
has(rendererSrc, /function openSftpAttrs\(/, 'renderer 有 openSftpAttrs()');
has(rendererSrc, /window\.api\.sftpStat\(sid, remotePath\)/, '对话框真的去读远端属性(不盲改)');
has(rendererSrc, /els\.attrsSave\.disabled = true;/, '读到属性前禁止保存');
has(rendererSrc, /window\.api\.sftpSetAttrs\(sessionId, remotePath, patch, recursive\)/, '保存走 sftpSetAttrs,带 recursive 标记');
has(rendererSrc, /function applySftpLimit\(/, 'renderer 有 applySftpLimit()');
has(rendererSrc, /function refreshSftpLimitNote\(/, 'renderer 有限速文案 refreshSftpLimitNote()');
has(rendererSrc, /sftpSpeedLimitKBps:\s*0/, '默认不限速(0)');

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed ? 1 : 0);
