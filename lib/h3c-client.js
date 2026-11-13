'use strict';
/**
 * lib/h3c-client.js — H3C 堡垒机客户端(accessclient://)透传的纯函数
 *
 * 为什么需要它(v1.0.19):
 *   H3C 的 RDP / 存储 Web 资产**不在终端里跑**。堡垒机网页的做法是把 accessUrl 返回的
 *   `accessclient://<zlib 压缩 token>` 交给 `AccessClient.exe`(该程序安装时注册了同名
 *   URL scheme),由它拉起 mstsc / 浏览器。真实 HAR(10.204.240.4-5.har)里 token 内容就是
 *   一份 mstsc 启动配置:{"app":"mstsc","fa":"s:<网关>:3389","sa":"super","as":"…OTP:…"}。
 *
 *   所以 Polaris 不实现 RDP 协议栈,只把这条**已经由堡垒机签发**的会话地址原样交回系统
 *   已注册的处理器 —— 和 WinSCP(v1.0.15)是同一个思路:不打包第三方二进制,只借用用户本机
 *   已装的客户端。
 *
 * 安全约束:
 *   - 只放行 `accessclient://` + urlsafe base64 字符集,挡掉 http/file/javascript 与
 *     空格/引号/换行(命令行注入)、超长(内存/日志污染);
 *   - **不能过 `new URL()`**:token 里的 `+` `/` `=` `%` 会被重编码,解压就失败;
 *   - 非 Windows 直接拒绝:AccessClient.exe 是 Windows 程序,别的平台没有处理器。
 *
 * 本文件只做纯函数(不碰 fs / child_process / shell),真正的探测与拉起在 main.js。
 */
const SCHEME = 'accessclient:';
const MAX_URL_LEN = 8192; // 真实 token 300~600 字符;给复杂资产留足余量
const REG_KEY = 'HKCR\\accessclient';
// urlsafe base64 全集 + 少量合法路径字符;其余一律拒绝
const URL_RE = /^accessclient:\/\/[A-Za-z0-9\-_+=\/%]{1,8192}$/;

/** 是否是堡垒机签发的 accessclient 会话地址(纯判字符串,不做任何规范化) */
function isAccessClientUrl(url) {
  if (typeof url !== 'string') return false;
  const t = url.trim();
  if (!t || t.length > MAX_URL_LEN) return false;
  return URL_RE.test(t);
}

/**
 * 探测计划:Windows 上查注册表确认 URL scheme 已注册。
 * 非 Windows 返回 {supported:false}(不起进程,也不假装已装)。
 */
function detectPlan(platform, env) {
  if (platform !== 'win32') {
    return { supported: false, reason: 'accessclient:// 由 Windows 上的 H3C AccessClient.exe 注册' };
  }
  const root = String((env && (env.SystemRoot || env.windir)) || 'C:\\Windows').replace(/[\\/]+$/, '');
  return {
    supported: true,
    // 用绝对路径,不依赖 PATH(用户环境变量被改坏也能探测)
    file: root + '\\System32\\reg.exe',
    args: ['query', REG_KEY, '/v', 'URL Protocol'],
    // 装了就顺手取一次处理器路径(只在日志/界面展示文件名,不外传完整路径)
    commandArgs: ['query', REG_KEY + '\\shell\\open\\command', '/ve'],
  };
}

/** reg query 输出 → 是否注册了该 scheme(code!==0 表示键不存在) */
function parseDetect(result) {
  const r = result || {};
  if (r.platform !== 'win32') return false;
  if (Number(r.code) !== 0) return false;
  return /URL\s+Protocol\s+REG_SZ/i.test(String(r.stdout || ''));
}

/** reg query HKCR\accessclient\shell\open\command 输出 → 可执行文件完整路径 */
function parseHandler(stdout) {
  const t = String(stdout || '');
  const quoted = t.match(/"([A-Za-z]:\\[^"]*\.exe)"/i);
  if (quoted) return quoted[1];
  const bare = t.match(/([A-Za-z]:\\[^\r\n"|]*?\.exe)/i);
  return bare ? bare[1] : '';
}

/** 完整路径 → 文件名(日志/提示里不暴露用户目录结构) */
function handlerBasename(p) {
  const s = String(p || '');
  return s.split(/[\\/]/).filter(Boolean).pop() || '';
}

/**
 * 打开前置条件:合法 + Windows。返回原样地址(调用方直接喂 shell.openExternal)。
 * 注意这里刻意**不返回改写后的 URL** —— 归一化会把 token 弄坏。
 */
function openTarget(platform, url) {
  const raw = typeof url === 'string' ? url.trim() : '';
  if (!isAccessClientUrl(raw)) return { ok: false, error: '不是有效的 accessclient 地址' };
  if (platform !== 'win32') {
    return { ok: false, error: 'accessclient:// 只能在 Windows 上打开(H3C 客户端是 Windows 程序)' };
  }
  return { ok: true, url: raw };
}

module.exports = {
  SCHEME,
  MAX_URL_LEN,
  REG_KEY,
  isAccessClientUrl,
  detectPlan,
  parseDetect,
  parseHandler,
  handlerBasename,
  openTarget,
};
