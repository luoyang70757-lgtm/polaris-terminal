'use strict';
/**
 * winscp-open.js — 把当前会话交给本机 WinSCP 打开(Windows 可选功能)
 *
 * 设计前提(决策见 docs/decision-winscp-integration.md):
 *   - WinSCP 是 Windows-only 原生程序(GPLv3),没有库 API → 不做"引擎集成",
 *     只做"外链":生成一条 SFTP 会话 URL + 少量命令行开关,拉起 winscp.exe。
 *   - 因此本模块**不随包分发任何 WinSCP 文件**,只在用户机器上已经装了 WinSCP 时才有用。
 *
 * 本文件是纯函数模块(不 spawn、不弹窗、不做 IO 判定之外的事),便于单测。
 * 真正 spawn 在 main.js 的 winScp:open IPC 里。
 *
 * WinSCP 命令行要点(实测口径,改这里前先看 docs/decision-winscp-integration.md):
 *   winscp.exe sftp://user:password@host:port/ /rawsettings SFTPRealPath=off [RemoteDirectory=/root]
 *               [-privatekey=...] [-passphrase=...]
 *   · 会话 URL 里 user/password 必须 percent-encode(密码含 @ : / # ? 等不被截断)
 *   · 有密码才自动登录;没密码时 WinSCP 会弹自己的登录框(用户可点"公钥"/agent)
 *   · **SFTPRealPath=off 必须带**:WinSCP 开会话时会 `REALPATH(".")` 探测家目录
 *     (source/core/SftpFileSystem.cpp GetHomeDirectory → RealPath(L"."));
 *     chroot 型服务器(JumpServer KoKo / H3C 网关 / internal-sftp chroot 等)对这个请求
 *     直接回 SSH_FX_FAILURE → WinSCP 弹「不能获得 '.' 的真实路径。错误码 4」。
 *     设 off 后 WinSCP 不再发该请求(改用本地 canonify),会话正常打开。
 *   · 主机指纹:WinSCP 用自己的格式(PuTTY 风格),首连会弹"是否信任主机"
 *     —— 与 Polaris 的 known_hosts 不通用,这里不猜,交给 WinSCP 自己问
 */

const fs = require('fs');

// 常见安装位置(按优先级)。装到别处的用户可用环境变量 POLARIS_WINSCP_PATH 指定。
const CANDIDATES = [
  '%ProgramFiles%\\WinSCP\\WinSCP.exe',
  '%ProgramFiles(x86)%\\WinSCP\\WinSCP.exe',
  '%LOCALAPPDATA%\\Programs\\WinSCP\\WinSCP.exe',
  '%USERPROFILE%\\scoop\\apps\\winscp\\current\\WinSCP.exe',
  '%ProgramData%\\chocolatey\\lib\\winscp\\tools\\WinSCP.exe',
  '%ProgramData%\\chocolatey\\bin\\WinSCP.exe',
];

/** 展开 Windows 风格 %VAR%(大小写不敏感;取不到就留空,让该候选整体失效) */
function expandEnv(p, env) {
  if (!p) return '';
  return String(p).replace(/%([^%]+)%/g, (_m, k) => {
    const e = env || {};
    return e[k] != null ? e[k] : (e[k.toUpperCase()] != null ? e[k.toUpperCase()] : (e[k.toLowerCase()] != null ? e[k.toLowerCase()] : ''));
  });
}

function fileExists(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

/**
 * 探测本机 WinSCP 可执行文件。
 * @param {object} o
 * @param {string} [o.platform]  process.platform(非 win32 直接判定"没装",除非显式给了路径)
 * @param {object} [o.env]       process.env
 * @param {function} [o.exists]  文件存在性判定(测试注入)
 * @returns {string|null} 可执行文件绝对路径;没装返回 null
 */
function detectExe(o) {
  const opt = o || {};
  const env = opt.env || process.env;
  const check = typeof opt.exists === 'function' ? opt.exists : fileExists;
  const platform = opt.platform || process.platform;
  // 显式指定(绿色版/自定义安装/自动化测试):只认它,不再猜(猜错了会拉起别的程序)
  const custom = String(env.POLARIS_WINSCP_PATH || '').trim();
  if (custom) {
    const p = expandEnv(custom, env);
    return p && check(p) ? p : null;
  }
  if (platform !== 'win32') return null;
  for (const c of CANDIDATES) {
    const p = expandEnv(c, env);
    if (p && check(p)) return p;
  }
  return null;
}

/** URL 组件编码:encodeURIComponent 会把 @ : / # ? & % 都转义(%40 等),WinSCP 会解回来 */
function enc(v) {
  return encodeURIComponent(String(v == null ? '' : v));
}

/**
 * 生成 WinSCP 会话 URL。
 * @param {object} s { host, port, username, password }
 * @returns {string} 例: sftp://admin:p%40ss%3Aword@主机地址:22/
 * @throws {Error} 缺主机地址
 *
 * 注意 JumpServer/H3C 的复合用户名(形如 jms@ssh@acct@资产IP)会被编码成
 * jms%40ssh%40acct%40IP —— WinSCP 解码后就是原来的复合用户名,KoKo 网关照样能路由。
 */
const SCHEMES = ['sftp', 'scp'];

function buildSessionUrl(s) {
  const o = s || {};
  const host = String(o.host || '').trim();
  if (!host) throw new Error('缺少主机地址,无法交给 WinSCP');
  const port = Number(o.port) > 0 ? Number(o.port) : 0;
  const user = o.username ? enc(o.username) : '';
  const pass = o.password ? ':' + enc(o.password) : '';
  const auth = (user || pass) ? user + pass + '@' : '';
  // SCP 协议(WinSCP 支持 scp://):走服务器上的 `scp` 命令,完全绕过 SFTP 子系统。
  // 给"SFTP 子系统残缺/把 LSTAT 之类回成 4"的老设备留一条路(docs/winscp-realpath-fix.md 第六节)。
  const scheme = SCHEMES.includes(String(o.scheme || '').toLowerCase()) ? String(o.scheme).toLowerCase() : 'sftp';
  return `${scheme}://${auth}${host}${port ? ':' + port : ''}/`;
}

/** 把 URL 里的密码抹掉(日志/状态栏/错误信息里只能出现这个版本) */
function redactUrl(url) {
  const s = String(url == null ? '' : url);
  // sftp://user:password@host → sftp://user:***@host
  return s.replace(/^((?:sftp|scp):\/\/[^:@/]*):[^@/]*@/, '$1:***@');
}

/**
 * 远端路径归一化:只接受绝对路径(交给 WinSCP 当 RemoteDirectory)。
 * 相对路径/`~`/空串一律丢弃 —— 猜错了会让 WinSCP 打开失败,不如让它自己落在家目录。
 */
function normalizeRemotePath(p) {
  const s = String(p == null ? '' : p).trim();
  if (!/^\//.test(s) || /[\r\n]/.test(s)) return '';
  return s;
}

/**
 * 组装 winscp.exe 的参数(不含 exe 自身;第一个参数是会话 URL)。
 * 只输出**已确认被 WinSCP 接受**的开关,避免"看起来传了其实被忽略":
 *   /rawsettings  会话的 ini 级设置(名字→值;空值跳过)
 *   -privatekey=  公钥认证的私钥文件
 *   -passphrase=  私钥口令
 * 日志:给了 logPath 才加 `/log=<path>` + `/loglevel=<level>`(默认 1;`*` = 全协议包)。
 * **默认不写日志**(见 logOptions):WinSCP 的 `Parameter:` 行会把会话 URL 里的密码
 * 原样(URL 解码后)打进日志文件,默认开着就等于把口令落盘。
 * @param {object} o { url, privateKey, passphrase, logPath, debug, rawSettings }
 * @returns {string[]}
 */
function buildArgs(o) {
  const opt = o || {};
  const url = opt.url;
  if (!url) throw new Error('缺少会话 URL');
  const args = [url];
  // rawsettings 的每个「名字=值」都是独立的一个 argv(`/rawsettings A=B C=D`)
  const rs = opt.rawSettings || null;
  if (rs) {
    const pairs = [];
    for (const k of Object.keys(rs)) {
      if (!k) continue;
      const v = rs[k] == null ? '' : String(rs[k]);
      if (v === '') continue;
      pairs.push(`${k}=${v}`);
    }
    if (pairs.length) args.push('/rawsettings', ...pairs);
  }
  const key = String(opt.privateKey || '').trim();
  // Polaris 存的是私钥**路径**(不是内容),可以直接交给 WinSCP;不存在就别传,让它弹登录框
  if (key && (opt.keyExists == null ? true : !!opt.keyExists)) args.push(`-privatekey=${key}`);
  const pp = String(opt.passphrase || '').trim();
  if (pp) args.push(`-passphrase=${pp}`);
  // WinSCP 日志:调用方给 logPath 才写(默认不给)。级别 0 = 完全不写日志。
  // 注意级别 1 的 `Parameter:` 行会**明文打印会话 URL(含解码后的密码)** —— 见 logOptions 注释。
  const log = String(opt.logPath || '').trim();
  const level = opt.loglevel == null ? (opt.debug ? '*' : '1') : String(opt.loglevel);
  if (log && level !== '0') {
    args.push(`/log=${log}`);
    args.push(`/loglevel=${level}`);
  }
  return args;
}

/**
 * 解析环境变量 POLARIS_WINSCP_RAWSETTINGS(形如 `A=B;C=D` 或换行分隔)。
 * 用途:出问题时让用户自己试 WinSCP 的开关(不必等我们发新版本)。
 * 只收 `[A-Za-z][A-Za-z0-9_]*` 的名字、值非空的条目;`#` 开头的行忽略。
 * @param {string} text
 * @returns {object}
 */
function parseRawSettings(text) {
  const out = {};
  String(text == null ? '' : text)
    .split(/[;\r\n]+/)
    .forEach((chunk) => {
      const line = chunk.trim();
      if (!line || line.charAt(0) === '#') return;
      const eq = line.indexOf('='); // 值里可能还有 '=',只按第一个切
      if (eq <= 0) return;
      const k = line.slice(0, eq).trim();
      const v = line.slice(eq + 1).trim();
      if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(k)) return;
      if (!v) return;
      out[k] = v;
    });
  return out;
}

/** 给日志/状态栏用的完整命令描述(密码/口令一律抹掉) */
function describeCommand(exe, args) {
  const a = (args || []).map((x) => {
    if (/^-passphrase=/.test(x)) return '-passphrase=***';
    if (/^(sftp|scp):\/\//.test(x)) return redactUrl(x); // 会话 URL 里的密码
    return String(x);
  });
  return [exe].concat(a).join(' ');
}

/**
 * 是否给 WinSCP 下发 SFTPRealPath=off(默认下发)。
 * 环境变量 POLARIS_WINSCP_REALPATH=on|auto 时保留 WinSCP 自己的默认行为
 * (少数服务器的家目录是符号链接、且用户希望 WinSCP 帮它 canonicalize 时用)。
 */
function realPathCompat(env) {
  const v = String((env && env.POLARIS_WINSCP_REALPATH) || '').trim();
  return !/^(on|auto)$/i.test(v);
}

/**
 * WinSCP 自己那份会话日志的开关与级别(纯函数,便于单测)。
 *
 * **默认关闭**(v1.0.24 起):实测 v1.0.21/22 默认 `/loglevel=1` 的日志里,
 * `Parameter: sftp://root:rNCzMBFRb%23xp3g@host:22/` 这行是**解码后的明文密码** ——
 * 相等同于把口令写进 `<数据目录>/logs/winscp-*.log`。排障价值有,但默认落盘不可接受。
 *
 *   POLARIS_WINSCP_LOG=1      → 开,级别 1(请求级,足以看出哪个请求被拒;**含口令**)
 *   POLARIS_WINSCP_DEBUG=1    → 开,级别 `*`(全协议包;**含口令/文件内容**)
 * @param {object} [env]
 * @returns {{on: boolean, level: string}} on=false 时不写日志文件;level='0' 等效于不写
 */
function logOptions(env) {
  const e = env || {};
  const truthy = (v) => /^(1|true|on|yes)$/i.test(String(v == null ? '' : v));
  const debug = truthy(e.POLARIS_WINSCP_DEBUG);
  const on = debug || truthy(e.POLARIS_WINSCP_LOG);
  return { on, level: debug ? '*' : '1', containsSecret: on };
}

/** WinSCP 会话级默认 rawsettings(见文件头:关掉 REALPATH 探测,chroot 型服务器才打得开) */
const RAW_SETTINGS_DEFAULTS = { SFTPRealPath: 'off' };

module.exports = { SCHEMES, CANDIDATES, detectExe, buildSessionUrl, buildArgs, redactUrl, describeCommand, expandEnv, normalizeRemotePath, realPathCompat, parseRawSettings, logOptions, RAW_SETTINGS_DEFAULTS };
