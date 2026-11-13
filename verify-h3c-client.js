'use strict';
/**
 * verify-h3c-client.js — H3C 堡垒机客户端(accessclient://)透传的**纯 Node** 回归
 *
 * 背景(v1.0.19):
 *   H3C 的 RDP / 存储 Web 资产不在终端里跑,堡垒机网页的做法是把 accessUrl 返回的
 *   `accessclient://<zlib token>` 交给 `AccessClient.exe`(它安装时注册了 URL scheme),
 *   由它拉起 mstsc / 浏览器。Polaris 不该自己实现 RDP 协议栈,而是**把会话原样交回**。
 *
 * 本脚本不启 Electron,只测 lib/h3c-client.js 纯函数 + 主/渲染层的接线断言:
 *   - accessclient:// 地址判定(必须挡住 http/文件/注入/超长)
 *   - 探测命令与输出解析(Windows 注册表 HKCR\accessclient 的 URL Protocol)
 *   - 处理器路径解析
 *   - 打开前置条件(平台/合法性)与「原样透传、不经 new URL()」的接线
 *
 *   node verify-h3c-client.js
 */
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
const ok = (n) => { passed++; console.log('  ✓ ' + n); };
const bad = (n, e) => { failed++; console.error('  ✗ ' + n + (e ? ' → ' + e : '')); };

console.log('\n=== H3C 客户端透传(accessclient://) ===\n');

let H = null;
try {
  H = require('./lib/h3c-client.js');
} catch (err) {
  console.error('  ✗ 找不到 lib/h3c-client.js: ' + err.message);
  process.exit(1);
}
for (const fn of ['isAccessClientUrl', 'detectPlan', 'parseDetect', 'parseHandler', 'openTarget']) {
  if (typeof H[fn] !== 'function') {
    console.error(`  ✗ lib/h3c-client.js 缺少导出 ${fn}()`);
    process.exit(1);
  }
}

// ---------- ① 地址判定 ----------
{
  // 真实 token 前缀(10.204.240.4-5.har),含 urlsafe 的 - _ = + /
  const real = 'accessclient://eJx1UctOwzAQ-JUoZ-S8nIbmBKqQeEi0aivUW+U6W8VqEwc/QgHx73gdJRUHbju7Y8/M7nfIui4sw0YbzcObUBsHtO1A3S05sHZjpApWjIuj4ME8T2PH6UE5EiUzUjh08O9FmcwcqGpfU4o8ZishOeuMVdDICvwIB03vSs84+16KwlwBtAHyAlENP2KbjX4csAr5tTGdLqMoiUkaU5LSmFCnmEW6NqCaSIGWVnHQEZftMbrnrtSLs4DWELgA6rOLaMQXGkINplGj3KTP6W6RZK/xYvuyDpbbVSkfqv4x363f509vmO5j8EUL6lDHp0DMXnPgBkZreUaKuWue4PMgmapqKU9TNKthX0u/cPzj6JOWf1Jl2S0+160b/XuOIfZ+uApaUM1kDEaPP799dIp3';
  if (H.isAccessClientUrl(real) === true) ok('① 真实 token(含 + / - _ 与尾部长串)判为合法');
  else bad('① 真实 token 被拒', String(real.slice(0, 40)));
  if (H.isAccessClientUrl('  ' + real + '  ') === true) ok('① 首尾空白被裁剪后仍合法');
  else bad('① 首尾空白没有裁剪');

  const rejects = [
    ['空串', ''],
    ['undefined', undefined],
    ['http', 'http://evil.example/x'],
    ['https', 'https://evil.example/x'],
    ['file', 'file:///C:/Windows/System32/cmd.exe'],
    ['javascript', 'javascript:alert(1)'],
    ['裸 scheme', 'accessclient:'],
    ['accessclient 无 //', 'accessclient:eJx1'],
    ['含空格', 'accessclient://eJx1 Uct'],
    ['含引号注入', 'accessclient://eJx1" & calc'],
    ['含换行(命令行注入)', 'accessclient://eJx1\ncalc.exe'],
    ['超长', 'accessclient://' + 'A'.repeat(9000)],
  ];
  let rj = 0;
  for (const [name, v] of rejects) if (H.isAccessClientUrl(v) === false) rj++;
  if (rj === rejects.length) ok(`① ${rejects.length} 个非法输入全部被拒(http/file/注入/超长等)`);
  else bad('① 有非法输入被放行', `${rj}/${rejects.length} 通过`);
}

// ---------- ② 探测计划(平台相关) ----------
{
  const win = H.detectPlan('win32', { SystemRoot: 'C:\\Windows' });
  if (win && win.supported === true && /reg\.exe$/i.test(win.file)) ok('② Windows:用 %SystemRoot%\\System32\\reg.exe 探测');
  else bad('② Windows 探测计划不对', JSON.stringify(win));
  if (win && Array.isArray(win.args) && win.args[0] === 'query' && win.args[1] === 'HKCR\\accessclient' && win.args.join(' ').indexOf('URL Protocol') >= 0) {
    ok('② 探测参数 = reg query HKCR\\accessclient /v "URL Protocol"');
  } else bad('② 探测参数不对', JSON.stringify(win && win.args));
  for (const p of ['darwin', 'linux']) {
    const d = H.detectPlan(p, {});
    if (d && d.supported === false) ok(`② ${p}:不支持(不探测、不起进程)`);
    else bad(`② ${p} 平台判定错误`, JSON.stringify(d));
  }
  const noRoot = H.detectPlan('win32', {});
  if (noRoot && /System32/i.test(noRoot.file)) ok('② 没有 SystemRoot 时仍拼到 System32(不依赖 PATH)');
  else bad('② 缺 SystemRoot 时路径不对', JSON.stringify(noRoot && noRoot.file));
}

// ---------- ③ 探测输出解析 ----------
{
  if (H.parseDetect({ platform: 'win32', code: 0, stdout: '\nHKEY_CLASSES_ROOT\\accessclient\n    URL Protocol    REG_SZ    \n\n' }) === true) {
    ok('③ reg 输出含 "URL Protocol REG_SZ" → 已安装');
  } else bad('③ 已安装场景被误判');
  if (H.parseDetect({ platform: 'win32', code: 1, stdout: '' }) === false) ok('③ reg 退出码非 0(键不存在)→ 未安装');
  else bad('③ 键不存在时被判已安装');
  if (H.parseDetect({ platform: 'win32', code: 0, stdout: 'HKEY_CLASSES_ROOT\\accessclient\n(其它键)\n' }) === false) ok('③ 没有 URL Protocol 值 → 未安装');
  else bad('③ 只有同名键、没有 URL Protocol 时被判已安装');
  if (H.parseDetect({ platform: 'darwin', code: 0, stdout: 'URL Protocol REG_SZ' }) === false) ok('③ 非 Windows 永远 false');
  else bad('③ 非 Windows 被误判已安装');
}

// ---------- ④ 处理器路径解析 ----------
{
  const out = '\nHKEY_CLASSES_ROOT\\accessclient\\shell\\open\\command\n    (Default)    REG_SZ    "C:\\Program Files (x86)\\H3C\\AccessClient\\AccessClient.exe" "%1"\n\n';
  const exe = H.parseHandler(out);
  if (exe === 'C:\\Program Files (x86)\\H3C\\AccessClient\\AccessClient.exe') ok('④ 从注册表输出里取出可执行文件路径(去掉引号与 %1)');
  else bad('④ 处理器路径解析错误', JSON.stringify(exe));
  const bare = H.parseHandler('HKEY_CLASSES_ROOT\\accessclient\\shell\\open\\command\n(Default) REG_SZ C:\\H3C\\AccessClient.exe %1');
  if (/AccessClient\.exe$/.test(bare)) ok('④ 无引号写法也能解析');
  else bad('④ 无引号写法解析失败', JSON.stringify(bare));
  if (H.parseHandler('') === '' && H.parseHandler(undefined) === '') ok('④ 空输出返回空串(不抛)');
  else bad('④ 空输出处理异常');
  const base = H.handlerBasename('C:\\Program Files (x86)\\H3C\\AccessClient\\AccessClient.exe');
  if (base === 'AccessClient.exe') ok('④ handlerBasename 只留文件名(日志/界面不暴露完整路径)');
  else bad('④ handlerBasename 错误', JSON.stringify(base));
}

// ---------- ⑤ 打开前置条件 ----------
{
  const good = H.openTarget('win32', 'accessclient://eJx1Uct');
  if (good && good.ok === true && good.url === 'accessclient://eJx1Uct') ok('⑤ Windows + 合法地址 → 原样透传(不做 URL 规范化)');
  else bad('⑤ 合法地址没有被原样返回', JSON.stringify(good));

  const plus = 'accessclient://a+b/c=d-e_f%2B';
  const r2 = H.openTarget('win32', plus);
  if (r2 && r2.ok === true && r2.url === plus) ok('⑤ 含 + / = % 的地址保持字节完全一致(不能过 new URL())');
  else bad('⑤ 地址被改写', JSON.stringify(r2));

  if (H.openTarget('darwin', 'accessclient://eJx1Uct').ok === false) ok('⑤ macOS/Linux → 拒绝并给出原因(客户端是 Windows 程序)');
  else bad('⑤ 非 Windows 平台被放行');
  if (H.openTarget('win32', 'http://evil').ok === false) ok('⑤ 非 accessclient 协议 → 拒绝');
  else bad('⑤ 其它协议被放行');
  const trimmed = H.openTarget('win32', '  accessclient://eJx1  ');
  if (trimmed.ok === true && trimmed.url === 'accessclient://eJx1') ok('⑤ 首尾空白裁掉再透传(避免命令行多余空格)');
  else bad('⑤ 空白处理不对', JSON.stringify(trimmed));
}

// ---------- ⑥ 接线断言(源码级) ----------
{
  const mainSrc = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const preloadSrc = fs.readFileSync(path.join(__dirname, 'preload.js'), 'utf8');
  const rendererSrc = fs.readFileSync(path.join(__dirname, 'src', 'renderer.js'), 'utf8');

  if (mainSrc.indexOf("ipcMain.handle('h3cClient:detect'") >= 0) ok('⑥ 主进程有 h3cClient:detect IPC');
  else bad('⑥ 缺 h3cClient:detect IPC');
  if (preloadSrc.indexOf('h3cClientDetect') >= 0) ok('⑥ preload 暴露 h3cClientDetect');
  else bad('⑥ preload 没暴露 h3cClientDetect');
  // accessclient 分支必须在 http/https 白名单之前:否则会被 new URL() 走一遍
  const iAc = mainSrc.indexOf("h3cClient.openTarget(process.platform");
  const iHttp = mainSrc.indexOf("!/^https?:$/.test(u.protocol)");
  if (iAc >= 0 && iHttp >= 0 && iAc < iHttp) ok('⑥ app:openExternal 里 accessclient 分支在 http/https 白名单之前');
  else bad('⑥ accessclient 分支位置不对(顺序会破坏透传)', `ac=${iAc} http=${iHttp}`);
  if (/openExternal\(\s*plan\.url|shell\.openExternal\(plan\.url\)/.test(mainSrc)) ok('⑥ 实际执行用 plan.url(原样字符串),没有 new URL() 往返');
  else bad('⑥ 执行时可能经过了 URL 规范化');

  if (rendererSrc.indexOf('h3cClient: { installed: false') >= 0 || rendererSrc.indexOf('h3cClient: { installed:false') >= 0) ok('⑥ renderer 有 state.h3cClient');
  else bad('⑥ renderer 缺 state.h3cClient');
  if (rendererSrc.indexOf('async function detectH3cClient') >= 0) ok('⑥ renderer 有 detectH3cClient()');
  else bad('⑥ renderer 缺 detectH3cClient()');
  if (rendererSrc.indexOf('async function bastionOpenAccessClient') >= 0) ok('⑥ renderer 有 bastionOpenAccessClient()(统一交给内部 openExternalUrl)');
  else bad('⑥ renderer 缺 bastionOpenAccessClient()');
  if (rendererSrc.indexOf('async function openExternalUrl') >= 0) ok('⑥ renderer 有 openExternalUrl() 间接层(测试可替换)');
  else bad('⑥ renderer 缺 openExternalUrl() 间接层');
  if (/bastionConnectNonSsh/.test(rendererSrc)) ok('⑥ renderer 有 bastionConnectNonSsh()(非 SSH 资产走客户端透传)');
  else bad('⑥ renderer 缺 bastionConnectNonSsh()');
}

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed ? 1 : 0);
