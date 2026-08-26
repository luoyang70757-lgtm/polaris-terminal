'use strict';
/**
 * main.js — Electron 主进程(纯 SSH/SFTP 终端版)
 * 职责:
 *   1. 创建主窗口(会话列表 → 多标签终端)
 *   2. 用 SQLite 保存会话配置(增删改查)
 *   3. 持有 SSH 连接池(ssh2 在主进程运行)
 *   4. --dev 模式下自动拉起本地 mock SSH 服务器(方便没有真实服务器时测试)
 */

const { app, BrowserWindow, ipcMain, dialog, Menu, shell, session } = require('electron');
const path = require('path');
const fs = require('fs'); // 读私钥、写导出文件等
const net = require('net'); // 堡垒机连通性探测(bastion:probe)

// ---- 启动诊断:早期崩溃(模块 require 失败/异常)记到独立文件 —— 排查 Windows 打不开 ----
// app-log 在下面才加载,若它自身或它依赖的模块 require 失败,app 会在注册任何错误处理
// 前崩溃、无任何日志。这里用最原始的 fs 先落一个启动痕迹,任何失败都能定位到具体模块。
const __startupLog = (() => {
  try {
    const os = require('os');
    const f = path.join(process.env.POLARIS_LOCK_DIR || (os.homedir() + '/.jms-terminal'), 'logs', 'startup-error.log');
    try { fs.mkdirSync(path.dirname(f), { recursive: true }); } catch { /* ignore */ }
    return (m) => { try { fs.appendFileSync(f, `[${new Date().toISOString()}] ${m}\n`); } catch { /* ignore */ } };
  } catch { return () => {}; }
})();
__startupLog('main.js 加载开始');
// 逐模块加载并留痕:任何一个 require 失败(如 node:sqlite 在当前 Electron 不可用)都会在
// 启动时崩溃且无日志 —— 这里把失败模块名记到 startup-error.log,Windows 打不开时能定位。
// 用 var(function 作用域)保证后续代码能访问到这些模块。
function __req(mod, label) {
  try { return require(mod); }
  catch (e) { __startupLog('require 失败 ' + (label || mod) + ': ' + (e && (e.stack || e.message))); throw e; }
}
var sshClient = __req('./lib/ssh-client', 'ssh-client');
var telnetClient = __req('./lib/telnet-client', 'telnet-client');
var { createStore } = __req('./lib/session-store', 'session-store');
var crypto = __req('./lib/crypto', 'crypto');
var knownHosts = __req('./lib/known-hosts', 'known-hosts');
var iconv = __req('iconv-lite', 'iconv-lite');
var dangerousLib = __req('./lib/dangerous', 'dangerous');
var { callAiStream, normalizeAiUrl, AI_SYSTEM_PROMPT } = __req('./lib/ai-stream', 'ai-stream');
var skillsLib = __req('./lib/skills', 'skills');
var recommendLib = __req('./lib/recommend', 'recommend');
var kbLib = __req('./lib/kb', 'kb');
var dbCrypto = __req('./lib/db-crypto', 'db-crypto');
var appLock = __req('./lib/app-lock', 'app-lock');
var recorder = __req('./lib/recorder', 'recorder');
var sessionLog = __req('./lib/session-log', 'session-log');
var tunnelLib = __req('./lib/tunnel', 'tunnel');
var jmsApi = __req('./lib/jms-api', 'jms-api');
var XLSX = __req('xlsx', 'xlsx');
var appLog = __req('./lib/app-log', 'app-log');
__startupLog('模块加载完成');

// ---------- 安全日志 ----------
// 当 stdout/stderr 管道被关闭(如从终端启动后终端被关、后台运行、日志重定向断开)时,
// console.log 可能抛 EPIPE 未捕获异常,导致主进程流程中断(如 ssh 连接失败后 return 不执行,
// 渲染层 invoke 永远挂起,标签卡在"连接中")。统一让日志写失败时静默忽略。
const __log = console.log, __err = console.error;
function __safeLog(fn) {
  return function () { try { return fn.apply(console, arguments); } catch { /* stdout 已关闭,忽略 */ } };
}
const __safeLogImpl = __safeLog(__log);
const __safeErrImpl = __safeLog(__err);
// 主进程日志转发到渲染层调试面板(排查主进程侧问题:启动慢/连接失败/崩溃)。
// 渲染层自己的 console 会被 mainWindow 的 console-message 打回来(带 [RENDERER] 前缀),
// 渲染层已自行记录,这里过滤掉避免重复刷屏。
// 另外过滤"堡垒机 webview 注入在页面导航瞬间的良性失败"(GUEST_VIEW_MANAGER_CALL /
// Script failed to execute):这是 Electron 对 executeJavaScript 在帧切换时的固定报错,
// 注入逻辑会自动重试,转发进调试面板只会造成 MAIN·错误 刷屏。控制台仍会打印,可排查。
const __BENIGN_MAIN_ERROR = /GUEST_VIEW_MANAGER_CALL|Script failed to execute/;
function __forwardMainLog(level, args) {
  try {
    const msg = Array.from(args).map(String).join(' ');
    if (level === 'log' && msg.startsWith('[RENDERER]')) return;
    if (level === 'error' && __BENIGN_MAIN_ERROR.test(msg)) return; // 良性 webview 错误不刷调试面板
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('main:log', level, msg);
    }
  } catch { /* ignore */ }
}
console.log = function () { __forwardMainLog('log', arguments); appLog.log('main', ...arguments); return __safeLogImpl.apply(console, arguments); };
console.error = function () { __forwardMainLog('error', arguments); appLog.log('error', ...arguments); return __safeErrImpl.apply(console, arguments); };
// 兜底:其他 EPIPE 未捕获异常忽略,非 EPIPE 打印到 stderr 继续运行(桌面应用不因日志崩溃退出)
process.on('uncaughtException', (e) => {
  if (e && e.code === 'EPIPE') return;
  try { __err.call(console, '[MAIN] 未捕获异常:', e); } catch { /* ignore */ }
  try { appLog.error('uncaughtException', e); } catch { /* ignore */ }
  // Windows 打不开排查:弹一个可见错误框(而不是静默退出),用户能直接看到报错文字并反馈
  try { __startupLog('uncaughtException: ' + (e && (e.stack || e.message))); } catch { /* ignore */ }
  try { dialog.showErrorBox('Polaris 异常', String((e && (e.stack || e.message)) || e)); } catch { /* ignore */ }
});
// Promise 拒绝也要独立处理:不能只靠 uncaughtException 兜底(拒绝不会触发它)。
// 错误要打日志(可观测),而不是静默吞掉 —— 桌面应用继续运行,不退出。
process.on('unhandledRejection', (reason) => {
  try { __err.call(console, '[MAIN] 未处理的 Promise 拒绝:', reason instanceof Error ? (reason.stack || reason.message) : reason); } catch { /* ignore */ }
  try { appLog.error('unhandledRejection', reason instanceof Error ? (reason.stack || reason.message) : reason); } catch { /* ignore */ }
});

// 堡垒机常用自签名证书/内网 CA,放行证书错误(否则内置浏览器打不开堡垒机 Web)
// 与 jms-api 的 rejectUnauthorized:false、PuTTY/Xshell 的行为一致:内网工具不校验 CA
app.on('certificate-error', (event, _wc, _url, _error, _cert, callback) => {
  event.preventDefault();
  callback(true);
});

// ---------- 数据目录 ----------
// 便携版(PORTABLE_EXECUTABLE_DIR 由 electron-builder portable 运行时注入,= exe 所在目录):
// 所有数据(userData 设置/AI 配置 + 加密库/密码锁/指纹/录制/归档)统一放 exe 同目录的 .Polaris 文件夹,
// 第一次运行自动创建,真正做到"数据随 exe 走",拷走文件夹即带全部数据。
// 安装版:固定 userData 目录(改产品名/包名不会丢设置和 AI 配置)。
const POLARIS_DATA_DIR = process.env.PORTABLE_EXECUTABLE_DIR
  ? path.join(process.env.PORTABLE_EXECUTABLE_DIR, '.Polaris')
  : null;
if (POLARIS_DATA_DIR) {
  fs.mkdirSync(POLARIS_DATA_DIR, { recursive: true }); // 第一次运行自动创建
  app.setPath('userData', POLARIS_DATA_DIR);
  process.env.POLARIS_LOCK_DIR = POLARIS_DATA_DIR; // 数据库/密码锁/指纹/录制/归档 走同一目录(app-lock 读取)
} else {
  // 测试环境(POLARIS_LOCK_DIR 已注入临时目录)→ userData 跟随,避免共享的真实配置/设置污染测试
  const testDir = process.env.POLARIS_LOCK_DIR;
  app.setPath('userData', testDir ? path.join(testDir, 'userdata') : path.join(app.getPath('appData'), 'polaris'));
}

// Windows 上部分显卡/虚拟机(Win11 测试环境常见)的 GPU 合成器命中测试有 bug:
// 弹窗等"新合成层"能渲染出来但点击坐标定位失效(点了完全没反应)→ 关掉硬件加速。
// 不影响任何功能,只影响渲染性能。必须在 app ready 前调用。
if (process.platform === 'win32') app.disableHardwareAcceleration();

// Linux 下 Electron 35+ 默认启用 Chromium 的 Fontations 新字体后端,小字号文字(菜单栏/工具栏)
// 易发虚、不清晰。关闭它退回 FreeType 渲染,中英文小字更锐利。必须在 app ready / 创建窗口前设置。
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('disable-features', 'FontationsFontBackend');
}

// ---- 中文输入法在 Wayland(GNOME/Mutter)下不定时失效的修复 ----
// 现象:打开 App 后当前终端中文打不出来 / 切标签、切窗口后候选窗偶尔消失。
// 根因:GNOME 的 Mutter 合成器只提供 text-input-v3 协议,而 Chromium 对它的实现较新、
//       在聚焦切换时经常状态失步(实测协议日志里出现 set_surrounding_text 错乱、频繁
//       disable/enable 抖动)。而 fcitx5 成熟稳定的 XIM 路径(XMODIFIERS=@im=fcitx5)
//       只有 X11/XWayland 应用能走。
// 修法:Wayland 会话下强制应用跑在 XWayland,中文输入走 fcitx5 XIM,绕开 text-input-v3。
//       本机 1080p 无缩放,不受 XWayland HiDPI 模糊影响;仅 Wayland 会话生效,X11 会话无副作用。
// 注意:app.commandLine.appendSwitch 对 ozone-platform 太晚(Electron 原生层已按 Wayland
//       初始化完);实测 --ozone-platform-hint=x11 也会被自动检测覆盖。只有真实命令行参数
//       才能生效,因此这里检测到 Wayland 会话且尚未带参时,带参重启一次(重启后 argv 含
//       --ozone-platform=x11,不会再进入这里,无死循环)。
if (process.platform === 'linux' && process.env.XDG_SESSION_TYPE === 'wayland') {
  if (!process.argv.includes('--ozone-platform=x11')) {
    app.relaunch({ args: process.argv.slice(1).concat(['--ozone-platform=x11']) });
    app.exit(0);
  }
}

const DEV_MODE = process.argv.includes('--dev') || process.env.POLARIS_DEV === '1';
let mainWindow = null;

// ---------- 会话存储(SQLite,内存运行 + 整库加密落盘) ----------
// 密码解锁后才创建(sessionStore = createStore(解密后的字节))。
// 持久化:每次变更 schedulePersist() → serialize() → 加密 → 写 data.bin
let sessionStore = null;
let dbPassword = null;   // 解锁后保存的密码(用于加密落盘)
let lockWindow = null;   // 锁屏窗口(仅启动解锁用;临时锁定用主窗口内覆盖层)
let persistTimer = null;

function persistDb() {
  if (!sessionStore || !dbPassword) return;
  try {
    const bytes = Buffer.from(sessionStore.serialize());
    const blob = dbCrypto.encryptBytes(bytes, dbPassword);
    const dir = appLock.lockDir();
    fs.mkdirSync(dir, { recursive: true });
    // 原子写:先写临时文件再 rename(同目录 rename 是原子的)。
    // 旧版直接 writeFileSync 覆盖 data.bin:中途崩溃/断电会留下半截文件,
    // 而 data.bin 是整库加密、无任何损坏恢复机制 → 一次写一半 = 全部数据不可解密。
    const finalPath = path.join(dir, 'data.bin');
    const tmpPath = path.join(dir, `data.bin.tmp-${process.pid}`);
    fs.writeFileSync(tmpPath, blob);
    fs.renameSync(tmpPath, finalPath);
    try { fs.chmodSync(finalPath, 0o600); } catch { /* 平台不支持则忽略 */ } // 加密库只允许当前用户读写
  } catch (err) {
    console.warn('[MAIN] 保存数据库失败:', err.message);
  }
}
function schedulePersist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(persistDb, 400); // 防抖:变更后 400ms 落盘
}

// ---------- SSH 连接池 ----------
// sessionId -> { conn, stream }
const sshSessions = new Map();
// Telnet 连接池:sessionId -> telnet-client 客户端对象(复用整套 ssh:data 管线,协议无关)
const telnetSessions = new Map();
// 已广播过 closed 的 sessionId:stream close 与 conn close 同一次断开可能都触发,只广播一次
// (不能放在 sshSessions 记录上——ssh:close 会先删记录再触发 close 事件;重连时在 ssh:connect 清掉)
const closedBroadcast = new Set();
let sshSeq = 0;
// 跳板机连接:sessionId -> 已连的跳板 conn(经它 forwardOut 隧道到目标)
const jumpConns = new Map();
// 录制状态:sessionId -> { file, startTs, encoding, cols, rows, sessionName, host, port, username }
// 同一 sessionId(同一个标签页)同时只允许一个录制,存这里方便在打点处快速查
const recSessions = new Map();

function broadcast(channel, ...args) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, ...args);
  }
}

// ---------- SSH 终端数据批量转发(性能优化) ----------
// 高吞吐输出(top / cat 大文件 / yes 等)时,SSH 会瞬间产生海量小块数据。
// 原来每块都立即过一遍 IPC,消息数爆炸。现在按 session 攒一批:
//   攒够 64KB 立即发;否则最多等 16ms 发一次(肉眼无感,但 IPC 消息数降一个量级)。
const dataBuffer = new Map(); // sessionId -> { chunks: Buffer[], total: number, timer }
const sshDecoders = new Map(); // sessionId -> iconv 流式解码器(仅非 utf8 会话,GBK/GB2312)

function pushSshData(sessionId, chunk) {
  let b = dataBuffer.get(sessionId);
  if (!b) { b = { chunks: [], total: 0, timer: null }; dataBuffer.set(sessionId, b); }
  b.chunks.push(chunk);
  b.total += chunk.length;
  if (b.total >= 64 * 1024) { flushSshData(sessionId); return; } // 攒够了立即发
  if (!b.timer) b.timer = setTimeout(() => flushSshData(sessionId), 16); // 否则 16ms 内发
}

function flushSshData(sessionId) {
  const b = dataBuffer.get(sessionId);
  if (!b) return;
  if (b.chunks.length) {
    const buf = Buffer.concat(b.chunks, b.total); // 拼成一大块一次发
    // 录制/日志写盘失败(磁盘满/权限)绝不能中断数据转发:
    // 旧版 recorder.writeOutput 直接 appendFileSync,抛异常会跳过下面的
    // dataBuffer.delete → 条目和 timer 泄漏,终端冻结、内存增长。
    try {
      const rec = recSessions.get(sessionId);
      if (rec) recorder.writeOutput(rec.file, Date.now() - rec.startTs, buf);
      writeSessionOutput(sessionId, buf); // 会话日志:解码 + 剥 ANSI 后落盘
    } catch (err) {
      console.warn('[MAIN] 录制/日志写盘失败(已跳过):', err.message);
    }
    const dec = sshDecoders.get(sessionId);
    if (dec) {
      // 非 UTF-8 会话:主进程用流式解码器转成 UTF-8 字符串(跨块的中文字符不会丢)
      broadcast('ssh:data', sessionId, dec.write(buf));
    } else {
      broadcast('ssh:data', sessionId, buf); // UTF-8:直接发原始字节
    }
  }
  if (b.timer) clearTimeout(b.timer);
  dataBuffer.delete(sessionId);
}

// 清理某会话的解码器(连接关闭时调用,把没转完的尾巴冲刷掉)
function cleanupSshDecoder(sessionId) {
  const dec = sshDecoders.get(sessionId);
  if (dec) {
    try {
      const tail = dec.end(); // 冲刷剩余的半截字符
      if (tail) broadcast('ssh:data', sessionId, tail);
    } catch { /* ignore */ }
    sshDecoders.delete(sessionId);
  }
}

// ---------- 会话录制:开始 / 收尾 ----------
// 数据打点不在这个模块里,输出在 flushSshData、输入在 ssh:write。
// 这里只管"开始一个录制""收尾一个录制(写元数据到 SQLite)"两件事。
function startRecording(sessionId, meta) {
  const m = meta || {};
  if (recSessions.has(sessionId)) return recSessions.get(sessionId); // 已在录制,直接复用
  const dir = recorder.recordingsDir();
  fs.mkdirSync(dir, { recursive: true }); // 目录不存在就建
  const file = path.join(dir, recorder.newRecordingName()); // 每个录制一个 JSONL 文件
  const rec = {
    file,
    startTs: Date.now(),                  // 事件的时间戳都相对它算(毫秒)
    encoding: m.encoding || 'utf8',
    cols: m.cols || 120,                  // 回放窗口大小按录制时的来
    rows: m.rows || 32,
    sessionName: m.sessionName || '',
    host: m.host || '',
    port: m.port || 22,
    username: m.username || '',
  };
  recSessions.set(sessionId, rec);
  return rec;
}

// 收尾录制:写元数据到 SQLite 并清状态。重复调用无害(第二次直接返回 null)
function finalizeRecording(sessionId) {
  const rec = recSessions.get(sessionId);
  if (!rec) return null;
  recSessions.delete(sessionId); // 先摘掉,防止收尾过程中又来新数据
  try {
    const fin = recorder.finishRecording(rec.file); // 停止时压缩成 .jsonl.gz,返回 {size, file}
    const id = sessionStore.addRecording({
      sessionName: rec.sessionName, host: rec.host, port: rec.port,
      username: rec.username, encoding: rec.encoding, cols: rec.cols, rows: rec.rows,
      file: fin.file, // 压缩后的文件路径(旧版 .jsonl 兼容:finishRecording 失败时原样返回)
      startedAt: new Date(rec.startTs).toISOString().replace('T', ' ').slice(0, 19),
      durationMs: Date.now() - rec.startTs,
      size: fin.size,
    });
    schedulePersist(); // 元数据变更,防抖落盘
    return { id, ...rec, file: fin.file, size: fin.size }; // file 覆盖为压缩后的路径(rec:stop 返回它)
  } catch (err) {
    console.warn('[MAIN] 录制收尾失败:', err.message);
    return null;
  }
}

// 退出时把还没手动停的录制全部收尾(否则元数据缺失,JSONL 文件成了孤儿)
function finalizeAllRecordings() {
  for (const sid of Array.from(recSessions.keys())) finalizeRecording(sid);
}

// ---------- 会话日志落盘 ----------
// 与录制不同:日志是"可读纯文本"(解码 + 剥离 ANSI),连接建立时开,断开/关标签时收尾。
// 打点在 flushSshData(输出)和 ssh:write(输入),这里只管"开一个日志 / 收尾一个日志"。
const logSessions = new Map(); // sessionId -> { file, decoder, stripper, lineBuf }

function startSessionLog(sessionId, meta) {
  if (logSessions.has(sessionId)) return logSessions.get(sessionId); // 已有日志,复用
  const m = meta || {};
  const dir = sessionLog.sessionLogsDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, sessionLog.newLogName(m.sessionName)); // 每个连接一个文件
  const log = {
    file,
    decoder: iconv.getDecoder(m.encoding || 'utf8'), // 流式解码:GBK/utf8 跨块都安全
    stripper: sessionLog.makeAnsiStripper(),
    lineBuf: sessionLog.makeLineBuffer((line) => fs.appendFileSync(file, line, 'utf8')),
  };
  logSessions.set(sessionId, log);
  const header = `===== Polaris 会话日志 | ${m.sessionName || ''} | ${m.username || ''}@${m.host || ''}:${m.port || 22} | ${new Date().toLocaleString()} =====\n`;
  try { fs.appendFileSync(file, header, 'utf8'); } catch { /* ignore */ }
  return log;
}

// 输出打点:解码成文本 + 剥 ANSI 后追加(写失败不阻塞主流程)
function writeSessionOutput(sessionId, buf) {
  const log = logSessions.get(sessionId);
  if (!log) return;
  try {
    const text = log.stripper(log.decoder.write(buf));
    if (text) fs.appendFileSync(log.file, text, 'utf8');
  } catch { /* ignore */ }
}

// 输入打点:按行缓冲,回车后整行落盘
function writeSessionInput(sessionId, text) {
  const log = logSessions.get(sessionId);
  if (!log) return;
  try { log.lineBuf.feed(String(text)); } catch { /* ignore */ }
}

// 收尾:冲刷解码器残留字符 + 没回车的内容。重复调用无害(第二次直接返回)
function finalizeSessionLog(sessionId) {
  const log = logSessions.get(sessionId);
  if (!log) return;
  logSessions.delete(sessionId); // 先摘掉,防止收尾过程中又来新数据
  try {
    const tail = log.decoder.end(); // 冲刷半截字符(跨块的 utf8/GBK 尾巴)
    if (tail) { const t = log.stripper(tail); if (t) fs.appendFileSync(log.file, t, 'utf8'); }
    log.lineBuf.flush(); // 没回车的残留命令也写进去,不丢
  } catch { /* ignore */ }
}

// 退出时把没关的日志全部收尾(否则解码器残留字符/未回车输入丢失)
function finalizeAllSessionLogs() {
  for (const sid of Array.from(logSessions.keys())) finalizeSessionLog(sid);
}

// 跳板机(SSH 代理)配置:会话里的 jump 字段存成 JSON 字符串,其中的密码/口令同样加密
function packJump(j) {
  if (!j || !j.host) return '';
  return JSON.stringify({
    host: j.host,
    port: j.port || 22,
    username: j.username || '',
    password: j.password ? crypto.encrypt(j.password) : '',
    private_key: j.private_key || '',
    passphrase: j.passphrase ? crypto.encrypt(j.passphrase) : '',
  });
}
function unpackJump(s) {
  if (!s) return null;
  try {
    const j = JSON.parse(s);
    if (!j || !j.host) return null;
    return {
      host: j.host, port: j.port, username: j.username,
      password: j.password ? crypto.decrypt(j.password) : '',
      private_key: j.private_key || '',
      passphrase: j.passphrase ? crypto.decrypt(j.passphrase) : '',
    };
  } catch { return null; }
}

// ---------- IPC:会话管理(SQLite) ----------
// 返回给渲染进程时解密(渲染进程连接要用明文);入库时加密
ipcMain.handle('sessions:list', () => {
  try {
    const sessions = sessionStore.list().map((x) => ({
      ...x,
      password: crypto.decrypt(x.password),
      passphrase: crypto.decrypt(x.passphrase), // 私钥口令同样加密存储
      jump: unpackJump(x.jump),
    }));
    return { ok: true, sessions };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('sessions:create', (_e, s) => {
  try {
    const id = sessionStore.create({ ...s, password: crypto.encrypt(s.password), passphrase: crypto.encrypt(s.passphrase), jump: packJump(s.jump) });
    schedulePersist();
    return { ok: true, id };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('sessions:update', (_e, id, s) => {
  try {
    sessionStore.update(id, { ...s, password: crypto.encrypt(s.password), passphrase: crypto.encrypt(s.passphrase), jump: packJump(s.jump) });
    schedulePersist();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('sessions:remove', (_e, id) => {
  try {
    sessionStore.remove(id);
    schedulePersist();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('sessions:import', (_e, list) => {
  try {
    // 入库前逐条加密密码
    const encrypted = (Array.isArray(list) ? list : []).map((x) => ({
      ...x,
      password: crypto.encrypt(x.password),
      passphrase: crypto.encrypt(x.passphrase),
    }));
    const results = sessionStore.importMany(encrypted);
    schedulePersist();
    const okCount = results.filter((r) => r.ok).length;
    return { ok: true, imported: okCount, total: results.length, results };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// 导出会话为"加密备份文件"(保存对话框)。rows: [{name,host,port,username,password,group}]
// 内容先生成 CSV,再用导出密码 AES-256-GCM 整体加密 → 文件不是明文,客户端工具打不开
ipcMain.handle('sessions:export', async (_e, { rows, password }) => {
  try {
    if (!password || String(password).length < 4) return { ok: false, error: '导出密码至少 4 位' };
    const save = await dialog.showSaveDialog(mainWindow, {
      title: '导出会话(加密备份)',
      defaultPath: `Polaris会话备份_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '_')}.polaris`,
      filters: [{ name: 'Polaris 加密备份', extensions: ['polaris'] }],
    });
    if (save.canceled || !save.filePath) return { ok: false, canceled: true };
    // CSV 转义:含逗号/引号/换行的字段加引号包裹,内部引号翻倍
    const esc = (v) => {
      const s = String(v ?? '');
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = ['名称,主机,端口,用户名,密码,分组'];
    for (const r of rows || []) {
      lines.push([esc(r.name), esc(r.host), esc(r.port || 22), esc(r.username), esc(r.password || ''), esc(r.group || '默认分组')].join(','));
    }
    const csv = '﻿' + lines.join('\n');
    const blob = dbCrypto.encryptBytes(Buffer.from(csv), password); // 整包加密
    fs.writeFileSync(save.filePath, blob);
    return { ok: true, path: save.filePath, count: (rows || []).length };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ---- 从 Xshell(.xsh) / iTerm2(JSON) 导入会话配置 ----
// Xshell .xsh 是 INI 格式: [CONNECTION] 段里有 Host/Port/UserName;密码被 Xshell 加密无法还原,需重新填
// iTerm2 导出的 Profiles JSON: { "Profiles": [ { "Name","Host","Port","Username" } ] }
function parseIniText(text) {
  const map = {};
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^\s*([^#;=]+?)\s*=\s*(.*?)\s*$/);
    if (m) map[m[1].trim()] = m[2].trim();
  }
  return map;
}
ipcMain.handle('sessions:importExternal', async (_e, { files }) => {
  try {
    const paths = Array.isArray(files) ? files : [];
    if (!paths.length) return { ok: false, error: '没有选择文件' };
    const rows = [];
    for (const fp of paths) {
      const base = path.basename(fp);
      const lower = base.toLowerCase();
      try {
        if (lower.endsWith('.xsh')) {
          const ini = parseIniText(fs.readFileSync(fp, 'utf8'));
          const host = ini.Host || ini.host || '';
          const username = ini.UserName || ini.username || '';
          if (!host) continue;
          rows.push({ name: base.replace(/\.xsh$/i, '') || host, host, port: parseInt(ini.Port || '22', 10) || 22, username, password: '', group: '默认分组' });
        } else if (lower.endsWith('.json')) {
          const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
          const profiles = (data.Profiles || []).filter((p) => p && p.Host);
          for (const p of profiles) {
            rows.push({ name: p.Name || p.Host, host: p.Host, port: parseInt(p.Port || '22', 10) || 22, username: p.Username || p.User || '', password: '', group: '默认分组' });
          }
        }
      } catch (err) {
        console.warn('[MAIN] 导入外部配置失败', base, err.message);
      }
    }
    if (!rows.length) return { ok: false, error: '没有解析出可用的主机(请选 .xsh 或 iTerm2 JSON 导出文件)' };
    return { ok: true, rows };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ---- 加密备份导入:读取 .polaris → 解密 → 解析 CSV → 返回行数组(供渲染层走统一导入) ----
// 简单 CSV 行解析(支持引号包裹的逗号/引号转义)
function parseCsvLine(line) {
  const cells = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false;
      } else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { cells.push(cur); cur = ''; }
    else cur += c;
  }
  cells.push(cur);
  return cells;
}
ipcMain.handle('sessions:importBackup', (_e, { buf, password }) => {
  try {
    if (!password) return { ok: false, error: '请输入备份文件密码' };
    if (!buf || !buf.byteLength) return { ok: false, error: '备份文件为空' };
    const csv = dbCrypto.decryptBytes(Buffer.from(buf), password).toString('utf8'); // 密码错会抛错
    const rows = String(csv).replace(/^﻿/, '').split(/\r?\n/).map(parseCsvLine).filter((r) => r.some((c) => String(c).trim() !== ''));
    return { ok: true, rows };
  } catch (err) {
    return { ok: false, error: '密码错误或文件已损坏: ' + err.message };
  }
});

// 探测远程系统类型(参考 Netcatty 的 OS 识别):exec 跑 os-release / uname 解析
ipcMain.handle('sessions:detectOs', async (_e, opts) => {
  try {
    const r = await sshClient.execCommand(
      withHostVerify(resolvePrivateKey(opts)),
      'cat /etc/os-release 2>/dev/null; uname -s'
    );
    const text = r.stdout || '';
    const pretty = text.match(/PRETTY_NAME="?([^"\n]+)"?/);
    const id = text.match(/^ID=(\S+)/m);
    const uname = text.match(/(Darwin|Linux|FreeBSD|SunOS)/);
    const name = pretty ? pretty[1] : (id ? id[1] : (uname ? uname[1] : 'Linux'));
    // id 可能带引号(如 ID="centos"),去掉引号再转小写
    const distro = id ? id[1].replace(/["']/g, '').toLowerCase() : (uname ? uname[1].toLowerCase() : 'linux');
    return { ok: true, distro, name };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ---------- IPC:JumpServer 资产(堡垒机) ----------
// 密码加解密(JMS 配置存渲染层 localStorage,落盘前加密,与 SSH 会话密码一致用 safeStorage)
ipcMain.handle('crypto:encrypt', (_e, text) => ({ ok: true, value: crypto.encrypt(text) }));
ipcMain.handle('crypto:decrypt', (_e, text) => ({ ok: true, value: crypto.decrypt(text) }));

// 登录:POST /api/v1/authentication/auth/ → { token, user } 或 { mfaRequired, cookie, choices, challengeUrl }
ipcMain.handle('jms:login', async (_e, { baseUrl, username, password }) => {
  try {
    const r = await jmsApi.login(baseUrl, username, password);
    if (r.mfaRequired) {
      return { ok: true, mfaRequired: true, cookie: r.cookie, choices: r.choices, challengeUrl: r.challengeUrl };
    }
    return { ok: true, token: r.token, user: r.user };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
// 提交 MFA 验证码并完成登录(带会话 cookie)
ipcMain.handle('jms:mfa', async (_e, { baseUrl, cookie, challengeUrl, type, code, username, password }) => {
  try {
    const r = await jmsApi.verifyMfaAndLogin(baseUrl, { cookie, challengeUrl, type, code, username, password });
    return { ok: true, token: r.token, user: r.user };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
// 拉取当前用户可见资产:GET /api/v1/assets/assets/(普通用户可用 user-assets,按版本调整)
ipcMain.handle('jms:assets', async (_e, { baseUrl, token }) => {
  try {
    const assets = await jmsApi.fetchAssets(baseUrl, token);
    return { ok: true, assets };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// JumpServer/堡垒机连接配置落盘:localStorage 偶发丢失(实测重启后 jmsServers 丢失),
// 这里原子写一份到数据目录 jms-servers.json,启动时文件优先恢复,保证连接信息不丢。
const jmsCfgFile = () => path.join(appLock.lockDir(), 'jms-servers.json');
ipcMain.handle('jms:persist', async (_e, servers) => {
  try {
    const dir = appLock.lockDir();
    fs.mkdirSync(dir, { recursive: true });
    const finalPath = path.join(dir, 'jms-servers.json');
    const tmpPath = path.join(dir, `jms-servers.json.tmp-${process.pid}`);
    fs.writeFileSync(tmpPath, JSON.stringify(servers || []), 'utf8');
    fs.renameSync(tmpPath, finalPath);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
ipcMain.handle('jms:restore', async () => {
  try {
    const p = jmsCfgFile();
    if (!fs.existsSync(p)) return { ok: true, servers: [] };
    return { ok: true, servers: JSON.parse(fs.readFileSync(p, 'utf8')) || [] };
  } catch (err) {
    return { ok: false, error: err.message, servers: [] };
  }
});

// 已保存的堡垒机连接(bastionServers)同样落盘:与 jmsServers 同因(localStorage 在 Windows
// 偶发丢失,重启后连接消失),bastionServers 此前只有 localStorage 存储 → 文件备份兜底。
ipcMain.handle('bastion:persist', async (_e, servers) => {
  try {
    const dir = appLock.lockDir();
    fs.mkdirSync(dir, { recursive: true });
    const finalPath = path.join(dir, 'bastion-servers.json');
    const tmpPath = path.join(dir, `bastion-servers.json.tmp-${process.pid}`);
    fs.writeFileSync(tmpPath, JSON.stringify(servers || []), 'utf8');
    fs.renameSync(tmpPath, finalPath);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
ipcMain.handle('bastion:restore', async () => {
  try {
    const p = path.join(appLock.lockDir(), 'bastion-servers.json');
    if (!fs.existsSync(p)) return { ok: true, servers: [] };
    return { ok: true, servers: JSON.parse(fs.readFileSync(p, 'utf8')) || [] };
  } catch (err) {
    return { ok: false, error: err.message, servers: [] };
  }
});

// 清除指定 origin 的登录态 cookie(左侧退出登录/删除时,同步退出右侧 webview 里的堡垒机网页)
// 注意:堡垒机 webview 用 partition="persist:bastion",cookie 存在该 partition,不是 defaultSession。
ipcMain.handle('jms:webLogout', async (_e, { origin }) => {
  try {
    const url = new URL(origin);
    const host = url.hostname;
    const bs = session.fromPartition('persist:bastion');
    const cookies = await bs.cookies.get({ domain: host });
    for (const c of cookies) {
      try { await bs.cookies.remove(url.origin + c.path, c.name); } catch { /* 逐个清,失败跳过 */ }
    }
    return { ok: true, removed: cookies.length };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// 清除堡垒机浏览器的会话记录(浏览历史/登录态/表单/localStorage):清空 persist:bastion partition。
// 只清浏览器会话,不动 SQLite 捕获的堡垒机资产——那些是左侧面板的连接/主机(app 自己的数据,不属于浏览历史)。
ipcMain.handle('bastion:clearAll', async () => {
  try {
    const bs = session.fromPartition('persist:bastion');
    await bs.clearStorageData(); // cookie + localStorage + cache 全清
    await bs.clearCache();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ---------- IPC:H3C 堡垒机(accessclient:// token 解码) ----------
// H3C Shterm 堡垒机用 accessclient://<base64(zlib(json))> 唤起外部工具,
// 内含目标主机/账号/一次性密码。这里在主子进程解码(zlib 只在 Node 有)。
// 传输记录行「📂 打开所在文件夹」:在系统文件管理器里定位已下载的文件/目录
ipcMain.on('fs:reveal', (_e, p) => {
  try { if (p) shell.showItemInFolder(String(p)); } catch { /* ignore */ }
  if (process.env.POLARIS_AUTO_DL_DIR) console.log('[fs:reveal] ' + String(p)); // 测试观察点:真实调用了 reveal
});

// 终端调试日志:把渲染层面板内容存到会话日志目录(排查终端/vim 按键问题用)
ipcMain.handle('debug:save', (_e, text) => {
  try {
    const dir = sessionLog.sessionLogsDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `polaris-debug-${Date.now()}.log`);
    fs.writeFileSync(file, String(text || ''), 'utf8');
    return { ok: true, path: file };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('bastion:decode', (_e, url) => {
  try {
    const zlib = require('zlib');
    const token = String(url || '').replace(/^accessclient:\/\//, '');
    // 压缩炸弹防护:正常 accessclient token 是几十~几百字节的 JSON;
    // 恶意构造的高压缩比 base64 经 inflateSync 可膨胀出 GB 级内存,直接 OOM 主进程。
    // 限制:输入 base64 解码后 ≤ 64KB,解压后 ≤ 1MB,超限拒绝。
    if (token.length > 96 * 1024) return { ok: false, error: '连接凭证过大,拒绝解码' };
    const b64 = token.replace(/-/g, '+').replace(/_/g, '/');
    const buf = Buffer.from(b64, 'base64');
    if (buf.length > 64 * 1024) return { ok: false, error: '连接凭证异常(长度超限)' };
    const inflated = zlib.inflateSync(buf);
    if (inflated.length > 1024 * 1024) return { ok: false, error: '连接凭证异常(解压超限)' };
    const info = JSON.parse(inflated.toString('utf8'));
    return { ok: true, info };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// 堡垒机目标连通性探测:TCP 连接 + 等待 SSH banner(区分"防火墙丢包"/"TCP通但非SSH"/"SSH可达")
ipcMain.handle('bastion:probe', (_e, { host, port, timeoutMs }) => {
  const t = timeoutMs || 5000;
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    let done = false;
    const finish = (r) => { if (done) return; done = true; try { sock.destroy(); } catch {} resolve(r); };
    sock.on('connect', () => { /* TCP 建立,继续等 banner */ });
    sock.on('data', (d) => finish({ tcp: 'ok', banner: d.toString('utf8', 0, 60).replace(/\s+$/, '').trim() }));
    sock.on('error', (e) => finish({ tcp: 'error', banner: null, error: e.code || e.message }));
    sock.setTimeout(t, () => finish({ tcp: sock.connected ? 'ok' : 'connect-timeout', banner: null, note: 'no SSH banner within ' + t + 'ms (TCP ' + (sock.connected ? 'connected' : 'not connected') + ')' }));
  });
});

// 导出堡垒机资产诊断包:渲染层收集的资产请求记录 → 写 JSON 到用户下载目录,返回路径供拷贝
// ---------- IPC:批量端口探测 ----------
// 每个端口一个 TCP 连接 + 超时,并行探测;开放且收到首字节时带上 banner 前 60 字节。
// status: 'open'(能连上) / 'closed'(拒连) / 'timeout'(连不上没回包) / 'error'(其他)
function probeOnePort(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    let done = false, connected = false;
    const finish = (r) => { if (done) return; done = true; try { sock.destroy(); } catch {} resolve(r); };
    sock.on('connect', () => {
      connected = true;
      sock.setTimeout(Math.min(timeoutMs, 2500)); // 连上后只等短暂 banner(等不到也算 open)
    });
    sock.on('data', (d) => finish({ status: 'open', banner: d.toString('utf8', 0, 60).replace(/[\r\n\t]+/g, ' ').trim() }));
    sock.on('timeout', () => finish(connected ? { status: 'open', banner: null } : { status: 'timeout', banner: null }));
    sock.on('error', (e) => finish({ status: (e.code === 'ECONNREFUSED' || e.code === 'EHOSTUNREACH') ? 'closed' : 'error', banner: null, error: e.code || e.message }));
    sock.setTimeout(timeoutMs); // 连接阶段超时
  });
}
ipcMain.handle('probe:ports', async (_e, { host, ports, timeoutMs }) => {
  const t = timeoutMs || 3000;
  const list = (Array.isArray(ports) ? ports : []).map((p) => Number(p)).filter((p) => p > 0 && p < 65536);
  const results = await Promise.allSettled(list.map((port) => probeOnePort(host, port, t)));
  return list.map((port, i) => ({ port, ...(results[i].status === 'fulfilled' ? results[i].value : { status: 'error', error: '内部错误' }) }));
});

// ---------- IPC:测试连接(会话弹窗「测试连接」按钮) ----------
// 协议感知,比纯 TCP 探测严格:端口 accept 但没服务(如 NAT/防火墙转发后静默断开)会误报成功,
// 而真实 SSH 连接会 "Connection lost before handshake"。这里 SSH 必须收到 SSH banner、Telnet 等到任意数据才算可达。
ipcMain.handle('test:connect', async (_e, { host, port, protocol, timeoutMs }) => {
  const t = timeoutMs || 3000;
  const wantSsh = (protocol || 'ssh') !== 'telnet';
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    let done = false; let buf = ''; let dataSeen = false;
    const finish = (ok, message) => { if (done) return; done = true; try { sock.destroy(); } catch {} resolve({ ok, message }); };
    sock.on('connect', () => sock.setTimeout(t));
    sock.on('data', (d) => {
      buf += d.toString('utf8', 0, 64);
      dataSeen = true;
      if (wantSsh) {
        if (buf.indexOf('SSH-') >= 0) return finish(true, 'SSH 服务正常');
        sock.setTimeout(500); // 收到非 SSH 数据:再等片刻排除 banner 分片,然后判"不是 SSH"
        return;
      }
      return finish(true, '服务可达');
    });
    sock.on('close', () => finish(false, '连接被对端关闭(未完成握手)'));
    sock.on('timeout', () => finish(false, wantSsh
      ? (dataSeen ? '端口可达,但不是 SSH 服务(未收到 SSH banner)' : '端口可达但无响应,可能不是 SSH 服务')
      : '连接后无响应'));
    sock.on('error', (e) => finish(false, (e.code === 'ECONNREFUSED' || e.code === 'EHOSTUNREACH') ? '端口未开放/拒绝连接' : `连接失败(${e.code || e.message})`));
    sock.setTimeout(t);
  });
});

ipcMain.handle('diag:exportBastion', (_e, data) => {
  try {
    const dir = app.getPath('downloads') || app.getPath('userData');
    const ts = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    const file = path.join(dir, `Polaris-bastion-diag-${ts}.json`);
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
    return { ok: true, path: file };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ---------- IPC:堡垒机资产缓存(SQLite 持久化,重启不丢) ----------
// 渲染层捕获/刷新资产后整批写入;启动时读出恢复上次的资产列表。
ipcMain.handle('bastion:saveAssets', (_e, { url, assets }) => {
  try {
    const n = sessionStore.saveBastionAssets(url, assets);
    schedulePersist();
    return { ok: true, count: n };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
ipcMain.handle('bastion:loadAssets', () => {
  try {
    return { ok: true, byUrl: sessionStore.loadBastionAssets() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
ipcMain.handle('bastion:deleteAssets', (_e, url) => {
  try {
    sessionStore.deleteBastionAssets(url);
    schedulePersist();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
// 清空全部已缓存堡垒机资产(清除历史时调用:缓存是"历史"的一部分,连接配置不动)
ipcMain.handle('bastion:clearAllAssets', () => {
  try {
    sessionStore.deleteAllBastionAssets();
    schedulePersist();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// 批量上传:选一个本地文件,上传到每个选中主机的远程目录
ipcMain.handle('sftp:batchUpload', async (_e, { sessions, remoteDir }) => {
  try {
    const pick = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'], title: '选择要批量上传的文件' });
    if (pick.canceled || !pick.filePaths[0]) return { ok: false, canceled: true };
    const localPath = pick.filePaths[0];
    const remotePath = `${(remoteDir || '/').replace(/\/+$/, '')}/${path.basename(localPath)}`;
    const results = [];
    for (const s of sessions) {
      try {
        const conn = await sshClient.connectRaw(withHostVerify(resolvePrivateKey(s)));
        const sftp = await sshClient.openSftp(conn);
        await new Promise((res, rej) => sftp.fastPut(localPath, remotePath, (e) => (e ? rej(e) : res())));
        sftp.end();
        conn.end();
        results.push({ ok: true, name: s.name, host: s.host });
      } catch (err) {
        results.push({ ok: false, name: s.name, host: s.host, error: err.message });
      }
    }
    return { ok: true, results };
  } catch (err) { return { ok: false, error: err.message }; }
});

// 批量下载:从每个选中主机下载同一远程文件到本地文件夹(按主机名区分文件名)
ipcMain.handle('sftp:batchDownload', async (_e, { sessions, remotePath }) => {
  try {
    const pick = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'], title: '选择保存到哪个文件夹' });
    if (pick.canceled || !pick.filePaths[0]) return { ok: false, canceled: true };
    const localDir = pick.filePaths[0];
    const base = path.basename(remotePath) || 'download';
    const results = [];
    for (const s of sessions) {
      // 会话名可能来自导入文件(如 iTerm2 的 Name 字段),含 ../ 或 / 会让 path.join
      // 穿越出保存目录 → 本地任意路径写文件(安全漏洞)。净化后再拼。
      const safeName = String(s.name || 'host').replace(/[\\/:*?"<>|\r\n]+/g, '_').replace(/\.\./g, '_').slice(0, 60) || 'host';
      const localPath = path.join(localDir, `${safeName}_${base}`);
      try {
        const conn = await sshClient.connectRaw(withHostVerify(resolvePrivateKey(s)));
        const sftp = await sshClient.openSftp(conn);
        await new Promise((res, rej) => sftp.fastGet(remotePath, localPath, (e) => (e ? rej(e) : res())));
        sftp.end();
        conn.end();
        results.push({ ok: true, name: s.name, host: s.host, path: localPath });
      } catch (err) {
        results.push({ ok: false, name: s.name, host: s.host, error: err.message });
      }
    }
    return { ok: true, results };
  } catch (err) { return { ok: false, error: err.message }; }
});

// ---------- IPC:AI 运维助手(参考 Netcatty 的 Catty Agent) ----------
// 执行 AI 的一条命令并返回输出;同时同步到可见终端(让用户实时看到 AI 在干嘛)
// 在"一台或多台"主机上执行命令,输出按 [主机名] 标注,方便 AI 区分;
// 同时把命令同步到对应终端的可见区域(hostList 每项带 sessionId)
async function runAiCommand(hostList, cmd, executed) {
  const outputs = [];
  for (const item of hostList) {
    try {
      const res = await sshClient.execCommand(item.hostOpts, cmd);
      const out = (res.stdout || '') + (res.stderr ? `\n[stderr] ${res.stderr}` : '') || '(无输出)';
      const hostLabel = item.hostOpts.host;
      outputs.push(`[${hostLabel}] ${out}`);
      executed.push({ command: cmd, host: hostLabel, code: res.code, output: out });
      if (item.sessionId) {
        const s = sshSessions.get(item.sessionId);
        if (s && s.stream && !s.stream.destroyed) {
          try { s.stream.write(`${cmd}\r`); } catch { /* ignore */ }
        }
      }
    } catch (err) {
      outputs.push(`[${item.hostOpts.host}] 执行失败: ${err.message}`);
    }
  }
  return outputs.join('\n') || '(无输出)';
}

// ---------- IPC:批量执行结果面板 ----------
// 一条命令在多台主机上非交互执行,返回逐台结果(主机名/退出码/输出/耗时)。
// 复用 execCommand(每次新连接),hostVerifier 指纹校验照常生效。
ipcMain.handle('batch:exec', async (_e, { hosts, command }) => {
  try {
    const cmd = String(command || '').trim();
    if (!cmd) return { ok: false, error: '命令为空' };
    const results = [];
    for (const h of (Array.isArray(hosts) ? hosts : [])) {
      const t0 = Date.now();
      try {
        const opts = withHostVerify(resolvePrivateKey({
          host: h.host, port: h.port || 22, username: h.username, password: h.password,
          privateKey: h.privateKey, passphrase: h.passphrase,
        }));
        const res = await sshClient.execCommand(opts, cmd);
        const out = ((res.stdout || '') + (res.stderr ? `\n[stderr] ${res.stderr}` : '')).trim() || '(无输出)';
        results.push({ ok: true, name: h.name || h.host, host: h.host, code: res.code, output: out.slice(0, 4000), durationMs: Date.now() - t0 });
      } catch (err) {
        results.push({ ok: false, name: h.name || h.host, host: h.host, error: err.message, durationMs: Date.now() - t0 });
      }
    }
    return { ok: true, results };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// AI 对话 + agent 循环:AI 可调用 run_command 在连接的主机上执行命令,直到给出最终回答
// 支持流式输出(ai:stream 事件推给界面)和"停止"请求。
const aiStopSet = new Set(); // 被用户点"停止"的 requestId 集合
ipcMain.on('ai:stop', (_e, requestId) => { if (requestId) aiStopSet.add(requestId); });

ipcMain.handle('ai:chat', async (_e, { apiKey, url, model, format, messages, hosts, requestId, kbEnabled }) => {
  aiStopSet.clear(); // 单聊:新一轮对话清掉遗留停止标记,防 Set 只增不减
  if (!apiKey) return { ok: false, error: '请先在 AI 面板 ⚙ 里填 API Key' };
  const base = normalizeAiUrl(url, format);
  const mdl = (model && model.trim()) || 'claude-sonnet-5';
  // 多主机:每项含连接信息 + 对应终端的 sessionId(命令会同步到这些终端)
  const hostList = (Array.isArray(hosts) ? hosts : []).map((h) => ({
    hostOpts: h && h.host
      ? withHostVerify(resolvePrivateKey({ host: h.host, port: h.port || 22, username: h.username, password: h.password, privateKey: h.privateKey, passphrase: h.passphrase }))
      : null,
    sessionId: (h && h.sessionId) || null,
  })).filter((x) => x.hostOpts);
  const MAX_ROUNDS = 10; // 技能加载会多占轮次,比纯命令循环放宽
  const executed = []; // 记录 AI 实际执行过的命令,返回给界面展示
  let conv = [...messages];
  // 把事件推给渲染层(带上 requestId,防止多个流混淆)
  const send = (evt) => broadcast('ai:stream', { requestId, ...evt });
  // 用户是否点了"停止"
  const shouldStop = () => { if (aiStopSet.has(requestId)) { aiStopSet.delete(requestId); return true; } return false; };
  // 系统提示 = 基础提示 + 已启用技能的 AVAILABLE SKILLS 清单(use_skill 靠它选技能)
  //            + 知识库相关片段(渲染层开了知识库且问题有匹配文档时)
  let kbSection = '';
  if (kbEnabled !== false) {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    const q = lastUser && lastUser.content ? (typeof lastUser.content === 'string' ? lastUser.content : '') : '';
    kbSection = kbLib.buildKbPromptSection(q, { limit: 3 });
  }
  const systemPrompt = AI_SYSTEM_PROMPT + skillsLib.buildSkillsPromptSection() + kbSection;

  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      if (shouldStop()) { send({ type: 'stopped' }); return { ok: true, text: '(已停止)', executed, stopped: true }; }
      const r = await callAiStream(base, mdl, format, apiKey, conv, (evt) => send({ type: 'model', ...evt }), { systemPrompt });
      if (r.error) {
        send({ type: 'error', message: r.error }); // 流式气泡已渲染到一半也要打上错误标记
        return { ok: false, error: r.error };
      }
      const toolUses = r.toolUses || [];
      if (toolUses.length === 0) {
        send({ type: 'done' });
        return { ok: true, text: r.text || '(空回复)', executed };
      }
      // 执行 AI 要的命令,收集结果
      const results = [];
      for (const tu of toolUses) {
        let output;
        if (tu.name === 'clear_screen') {
          // 清屏工具:通知渲染层清掉本地终端显示(不执行服务器命令)
          send({ type: 'clear_screen' });
          output = '(已清除本地终端屏幕)';
        } else if (tu.name === 'use_skill') {
          // 技能加载:把 SKILL.md 全文返回给模型,让代理严格按技能执行
          const skillName = tu.input && tu.input.name;
          send({ type: 'tool', command: `use_skill: ${skillName || '(无名称)'}` });
          if (!skillName) {
            output = '(缺少技能名)';
          } else {
            const skill = skillsLib.getSkill(skillName);
            if (!skill || skill._broken) {
              output = `(技能不存在: ${skillName},请先确认 AVAILABLE SKILLS 清单里的名字)`;
            } else if (!skill.enabled) {
              output = `(技能 ${skillName} 未启用,请用已启用的技能)`;
            } else {
              send({ type: 'skill_loaded', name: skill.name });
              output = `技能「${skill.name}」已加载,严格按以下内容执行:\n\n${skill.content}`;
            }
          }
        } else if (tu.name === 'summarize_to_skill') {
          // 对话沉淀成技能:写操作,弹窗让用户确认后再落盘
          const input = tu.input || {};
          const skillName = String(input.skill_name || '').trim();
          const description = String(input.description || '').trim();
          const content = String(input.content || '').trim();
          send({ type: 'tool', command: `summarize_to_skill: ${skillName || '(无名称)'}` });
          if (!skillName || !description || !content) {
            output = '(缺少 skill_name/description/content 字段,无法保存)';
          } else {
            try {
              const preview = content.length > 600 ? content.slice(0, 600) + '\n…(截断)' : content;
              const { response } = await dialog.showMessageBox(mainWindow, {
                type: 'question',
                title: '保存为技能',
                message: `AI 想把本次对话沉淀为技能「${skillName}」,要保存吗?`,
                detail: `${description}\n\n${preview}`,
                buttons: ['保存技能', '取消'],
                defaultId: 0,
                cancelId: 1,
              });
              if (response === 0) {
                skillsLib.saveSkill({ name: skillName, description, enabled: true, content });
                send({ type: 'skill_saved', name: skillName });
                output = `(技能「${skillName}」已保存,以后遇到类似任务会从 AVAILABLE SKILLS 加载)`;
              } else {
                output = '(用户取消保存技能)';
              }
            } catch (err) {
              output = `(保存技能失败: ${err.message})`;
            }
          }
        } else if (tu.name !== 'run_command') {
          output = '(未知工具)';
          send({ type: 'tool', command: '(未知工具)' });
        } else if (hostList.length === 0) {
          output = '(未连接主机,无法执行)';
          send({ type: 'tool', command: (tu.input && tu.input.command) || '(无命令)' });
        } else {
          const cmd = tu.input && tu.input.command;
          send({ type: 'tool', command: cmd || '' }); // 告诉界面 AI 要执行什么
          // 危险命令审批(借鉴 Claude Code 的 permission 机制):
          // AI 想执行 rm -rf / reboot 等,先弹窗让用户拍板,拒绝就把"用户拒绝"反馈给模型。
          // v2:analyzeCommand 返回分级与命中原因,文案更明确(critical 严重 / high 危险)
          const an = dangerousLib.analyzeCommand(cmd || '');
          if (an.level !== 'safe') {
            const label = an.level === 'critical' ? '🔴 严重危险' : '🟠 危险';
            const reasons = an.findings.map((f) => `  · ${f.name}`).join('\n');
            const { response } = await dialog.showMessageBox(mainWindow, {
              type: an.level === 'critical' ? 'error' : 'warning',
              title: 'AI 危险命令审批',
              message: `${label}: AI 想执行危险命令,要允许吗?`,
              detail: `${String(cmd || '')}\n\n命中:\n${reasons}`,
              buttons: ['允许执行', '拒绝'],
              defaultId: 1,
              cancelId: 1,
            });
            if (response === 1) {
              executed.push({ command: cmd, code: null, output: '用户拒绝' });
              output = '(用户拒绝了此危险命令,请换个更安全的做法)';
              send({ type: 'tool_rejected', command: cmd });
            } else {
              output = await runAiCommand(hostList, cmd, executed);
              send({ type: 'tool_result', command: cmd, output: String(output).slice(0, 400) });
            }
          } else {
            output = await runAiCommand(hostList, cmd, executed);
            send({ type: 'tool_result', command: cmd, output: String(output).slice(0, 400) });
          }
        }
        results.push({ id: tu.id, output });
      }
      // 原样回传 assistant(含 thinking 块)+ 工具结果
      if (format === 'openai') {
        conv = [...conv, r.assistantMsg, ...results.map((res) => ({ role: 'tool', tool_call_id: res.id, content: res.output }))];
      } else {
        conv = [
          ...conv,
          r.assistantMsg,
          { role: 'user', content: results.map((res) => ({ type: 'tool_result', tool_use_id: res.id, content: res.output })) },
        ];
      }
    }
    send({ type: 'done' });
    return { ok: true, text: '(达到最大执行轮次,请换个问法)', executed };
  } catch (err) {
    send({ type: 'error', message: err.message });
    return { ok: false, error: `请求异常: ${err.message}` };
  }
});

// ---------- IPC:Agent Skill 技能库(参考 Chaterm) ----------
// 技能是数据目录 skills/ 下的 SKILL.md 文件:list/get 只读,save/delete/setEnabled 写文件。
// 启用中的技能会出现在 AI 系统提示的 AVAILABLE SKILLS 清单,代理用 use_skill 按需加载。
ipcMain.handle('skills:list', () => {
  try {
    return { ok: true, skills: skillsLib.listSkills() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('skills:get', (_e, name) => {
  try {
    const s = skillsLib.getSkill(String(name || ''));
    return { ok: true, skill: s };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('skills:save', (_e, skill) => {
  try {
    const saved = skillsLib.saveSkill(skill || {});
    return { ok: true, skill: saved };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('skills:delete', (_e, name) => {
  try {
    skillsLib.deleteSkill(String(name || ''));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('skills:setEnabled', (_e, name, enabled) => {
  try {
    const s = skillsLib.setEnabled(String(name || ''), !!enabled);
    return { ok: true, skill: s };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// 打开技能目录(方便用户手动编辑/备份)
ipcMain.handle('skills:openFolder', async () => {
  try {
    const dir = skillsLib.skillsDir();
    fs.mkdirSync(dir, { recursive: true });
    const err = await shell.openPath(dir);
    return { ok: !err, error: err || undefined };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ---------- IPC:用户知识库(参考 Chaterm) ----------
// 文档是数据目录 kb/ 下的文本文件;检索为本地关键词搜索(标题命中优先)。
// AI 对话开启知识库时,会先把相关问题检索到的片段注入系统提示。
ipcMain.handle('kb:list', () => {
  try { return { ok: true, docs: kbLib.listDocs() }; }
  catch (err) { return { ok: false, error: err.message }; }
});

// 弹文件选择器导入(渲染层不直接碰 Node,路径由主进程对话框给)
ipcMain.handle('kb:pickImport', async () => {
  try {
    const pick = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      title: '导入运维文档到知识库',
      filters: [
        { name: '文档/文本', extensions: ['md', 'txt', 'log', 'conf', 'ini', 'yaml', 'yml', 'json', 'sh', 'py', 'sql', 'rst', 'csv'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    });
    if (pick.canceled || !pick.filePaths.length) return { ok: false, canceled: true };
    const doc = kbLib.importDoc(pick.filePaths[0]);
    return { ok: true, doc };
  } catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('kb:import', (_e, { filePath, name }) => {
  try { return { ok: true, doc: kbLib.importDoc(filePath, name) }; }
  catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('kb:remove', (_e, name) => {
  try { kbLib.removeDoc(name); return { ok: true }; }
  catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('kb:search', (_e, query, limit) => {
  try { return { ok: true, results: kbLib.search(query, { limit }) }; }
  catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('kb:openFolder', async () => {
  try {
    const dir = kbLib.kbDir();
    fs.mkdirSync(dir, { recursive: true });
    const err = await shell.openPath(dir);
    return { ok: !err, error: err || undefined };
  } catch (err) { return { ok: false, error: err.message }; }
});

// ---------- IPC:分组管理 ----------
ipcMain.handle('groups:list', () => {
  try {
    return { ok: true, groups: sessionStore.listGroups() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('groups:create', (_e, name, parentId) => {
  try {
    const id = sessionStore.createGroup(name, parentId);
    schedulePersist();
    return { ok: true, id };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('groups:rename', (_e, id, name) => {
  try {
    sessionStore.renameGroup(id, name);
    schedulePersist();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('groups:setProd', (_e, id, flag) => {
  try {
    sessionStore.setGroupProd(id, !!flag);
    schedulePersist();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('groups:delete', (_e, id) => {
  try {
    sessionStore.deleteGroup(id);
    schedulePersist();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// 生成"导入模板"Excel:弹保存对话框 → SheetJS 生成带表头和示例行的 xlsx → 写盘
// ---- 命令记录持久化(SQLite cmd_history 表) ----
ipcMain.handle('cmd:add', (_e, host, command) => {
  try { sessionStore.addCmd(host, command); schedulePersist(); return { ok: true }; }
  catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('cmd:list', () => {
  try { return { ok: true, cmds: sessionStore.listCmds() }; }
  catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('cmd:clear', () => {
  try { sessionStore.clearCmds(); schedulePersist(); return { ok: true }; }
  catch (err) { return { ok: false, error: err.message }; }
});

// 智能命令推荐(参考 Chaterm):该主机的历史高频命令 + 内置常用运维命令库合并。
// host 为空 → 全量统计(全局常用)。纯函数在 lib/recommend.js,可独立单测。
ipcMain.handle('cmd:recommend', (_e, host) => {
  try {
    const rows = sessionStore.listCmdsByHost(host);
    const list = recommendLib.recommend(rows, { host: host || undefined, limit: 12 });
    return { ok: true, host: host || null, list };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// AI 命令推荐(参考 Chaterm 的"智能命令推荐"):单次调用(非 agent 循环),
// 把"主机 + 最近命令历史 + 终端最近输出"给模型,让它推荐一条下一条要执行的命令。
// 不带工具,模型只输出 { command, reason },渲染层直接可点选执行。
ipcMain.handle('ai:suggestCmd', async (_e, { apiKey, url, model, format, host, history, context }) => {
  try {
    if (!apiKey) return { ok: false, error: '请先在 AI 面板 ⚙ 里填 API Key' };
    const base = normalizeAiUrl(url || '', format || 'openai');
    const mdl = (model && model.trim()) || 'claude-sonnet-5';
    const system = `你是一名资深 Linux/运维工程师,内嵌在 SSH 终端工具里。
用户给你当前主机的上下文(主机标识、最近执行过的命令、终端最近输出),请你推荐**一条**接下来最值得执行的命令。
要求:
- 只输出一个 JSON 对象,不要任何多余文字: {"command": "命令", "reason": "一句话中文理由"}
- command 必须是单条、非交互、能一次执行完的 shell 命令(不要 vim/less/top 这类需要退出的交互程序;用 top -bn1 这类一次性版本)
- reason 用中文,一句话说明为什么执行它
- 结合终端输出判断:有报错就推荐排查命令,有磁盘/内存告警就推荐对应的检查命令`;
    const user = [
      `当前主机: ${host || '(未知)'}`,
      history ? `最近执行过的命令(按时间):\n${String(history).slice(0, 1500)}` : '最近执行过的命令: (无)',
      context ? `终端最近输出(末尾截取):\n${String(context).slice(-1500)}` : '终端最近输出: (空)',
      '',
      '请严格按系统要求输出 JSON。',
    ].join('\n');
    const r = await callAiStream(base, mdl, format, apiKey, [{ role: 'user', content: user }], null, { systemPrompt: system, tools: [] });
    if (r.error) return { ok: false, error: r.error };
    // 尽量解析 JSON;失败则从文本里兜底提取第一行当命令
    let parsed = null;
    try { parsed = JSON.parse(String(r.text || '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { /* 非严格 JSON */ }
    if (parsed && parsed.command) {
      return { ok: true, command: String(parsed.command), reason: parsed.reason || '' };
    }
    const lines = String(r.text || '').trim().split('\n').map((x) => x.trim()).filter(Boolean);
    return { ok: true, command: lines[0] || '', reason: lines.slice(1).join(' ').slice(0, 120) || '' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// 归档某台主机的命令记录:按当前主机归档,文件名 = 标签页名称_时间戳.txt(不自动打开)
ipcMain.handle('cmd:archive', async (_e, { host, sessionName }) => {
  try {
    const now = new Date();
    const pad = (x) => String(x).padStart(2, '0');
    const archiveId = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const name = String(sessionName || '归档').trim().replace(/[\\/:*?"<>|\s]+/g, '_');
    const count = sessionStore.archiveCmds(archiveId, host, ''); // 先占位 file
    if (!count) return { ok: true, archived: 0, path: null };
    const rows = sessionStore.archiveDetail(archiveId);
    const dir = path.join(appLock.lockDir(), 'archives');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${name}_${archiveId}.txt`);
    const byHost = {};
    for (const r of rows) {
      const h = r.host || '未知主机';
      if (!byHost[h]) byHost[h] = [];
      byHost[h].push(r);
    }
    let out = `Polaris 命令记录归档  ${archiveId}\n${'='.repeat(50)}\n`;
    for (const h of Object.keys(byHost)) {
      out += `\n===== ${h} =====\n`;
      for (const c of byHost[h]) out += `[${c.created_at}] ${c.command}\n`;
    }
    fs.writeFileSync(file, out, 'utf8');
    // 把文件路径补进批次记录
    dbSetArchiveFile(archiveId, file);
    schedulePersist();
    return { ok: true, archived: count, archiveId, path: file };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// 补写归档批次的文件路径(sessionStore 内部更新)
function dbSetArchiveFile(archiveId, file) {
  try { sessionStore.setArchiveFile(archiveId, file); } catch { /* ignore */ }
}

// 列出某台主机的归档批次(时间倒序)
ipcMain.handle('cmd:listArchives', (_e, host) => {
  try { return { ok: true, archives: sessionStore.listArchives(host || '') }; }
  catch (err) { return { ok: false, error: err.message }; }
});

// 查看某批归档的明细
ipcMain.handle('cmd:archiveDetail', (_e, archiveId) => {
  try { return { ok: true, rows: sessionStore.archiveDetail(archiveId) }; }
  catch (err) { return { ok: false, error: err.message }; }
});

// 列出归档文件夹里的文件(时间倒序)
ipcMain.handle('cmd:listArchiveFiles', () => {
  try {
    const dir = path.join(appLock.lockDir(), 'archives');
    fs.mkdirSync(dir, { recursive: true });
    const files = fs.readdirSync(dir)
      .filter((f) => f.endsWith('.txt'))
      .map((f) => {
        const st = fs.statSync(path.join(dir, f));
        return { name: f, size: st.size, mtime: st.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
    return { ok: true, files };
  } catch (err) { return { ok: false, error: err.message }; }
});

// 归档文件路径必须落在 archives 目录内(渲染层传的路径不可信,防任意文件删/拷)
function isInArchives(filePath) {
  const dir = path.resolve(appLock.lockDir(), 'archives');
  const resolved = path.resolve(String(filePath || ''));
  return resolved === dir || resolved.startsWith(dir + path.sep);
}

// 下载归档文件:弹保存对话框 → 复制一份到用户选的位置
ipcMain.handle('cmd:downloadArchive', async (_e, filePath) => {
  try {
    const src = String(filePath || '');
    if (!src || !isInArchives(src)) return { ok: false, error: '归档文件不存在' };
    const save = await dialog.showSaveDialog(mainWindow, {
      title: '保存归档文件', defaultPath: path.basename(src),
      filters: [{ name: '文本文件', extensions: ['txt'] }],
    });
    if (save.canceled || !save.filePath) return { ok: false, error: '已取消' };
    fs.copyFileSync(src, save.filePath);
    return { ok: true, path: save.filePath };
  } catch (err) { return { ok: false, error: err.message }; }
});

// 删除归档:删文件 + 删数据库里对应批次的归档记录
ipcMain.handle('cmd:deleteArchive', (_e, archiveId, filePath) => {
  try {
    if (filePath) {
      if (!isInArchives(filePath)) return { ok: false, error: '非法路径' };
      if (fs.existsSync(filePath)) fs.rmSync(filePath);
    }
    sessionStore.deleteArchive(String(archiveId || ''));
    schedulePersist();
    return { ok: true };
  } catch (err) { return { ok: false, error: err.message }; }
});

// 打开归档文件夹(查看所有归档文件)
ipcMain.handle('cmd:openArchives', () => {
  try {
    const dir = path.join(appLock.lockDir(), 'archives');
    fs.mkdirSync(dir, { recursive: true });
    shell.openPath(dir);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// 导出命令记录为 txt:弹保存对话框 → 按主机分组写入
// 默认文件名 = 连接名称 + 日期 + 时间(如 我的服务器_2026-08-04_20-55-30.txt)
// 选择 SSH 私钥文件(原生对话框),返回路径
ipcMain.handle('pick:keyFile', async () => {
  try {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: '选择 SSH 私钥文件',
      properties: ['openFile'],
      filters: [{ name: '私钥文件', extensions: ['*'] }],
    });
    if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true };
    return { ok: true, path: r.filePaths[0] };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('template:save', async () => {
  try {
    const save = await dialog.showSaveDialog(mainWindow, {
      title: '保存导入模板',
      defaultPath: '主机导入模板.xlsx',
      filters: [{ name: 'Excel 文件', extensions: ['xlsx'] }],
    });
    if (save.canceled || !save.filePath) return { ok: false, error: '已取消' };

    // 第一个 sheet:主机列表(表头 + 示例行,示例用文档保留网段 192.0.2.x 避免误连)
    const ws = XLSX.utils.aoa_to_sheet([
      ['名称', '主机', '端口', '用户名', '密码', '分组'],
      ['示例服务器A', '192.0.2.10', '22', 'root', 'password123', '生产'],
      ['', '192.0.2.11', '22', 'ubuntu', '', '测试'],
    ]);
    ws['!cols'] = [{ wch: 16 }, { wch: 16 }, { wch: 8 }, { wch: 14 }, { wch: 16 }, { wch: 10 }];
    // 第二个 sheet:填写说明
    const note = XLSX.utils.aoa_to_sheet([
      ['填写说明'],
      ['1. 在"主机列表"表里填你的服务器,首行表头不要动。'],
      ['2. 每行一台,列顺序:名称,主机,端口,用户名,密码,分组。'],
      ['3. 名称/端口/密码/分组可留空:名称留空用主机地址,端口默认22,分组默认"默认分组"。'],
      ['4. 填好后保存,回软件点"导入 → 从 Excel 文件导入"选择本文件。'],
      ['5. 示例行可直接删掉或用它当格式参照。'],
    ]);
    note['!cols'] = [{ wch: 90 }];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '主机列表');
    XLSX.utils.book_append_sheet(wb, note, '说明');
    XLSX.writeFile(wb, save.filePath);
    return { ok: true, path: save.filePath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ---------- IPC:快速命令(命令收藏) ----------
ipcMain.handle('quick:list', () => {
  try { return { ok: true, cmds: sessionStore.listQuickCmds() }; }
  catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('quick:add', (_e, { name, command }) => {
  try { const id = sessionStore.addQuickCmd(name, command); schedulePersist(); return { ok: true, id }; }
  catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('quick:update', (_e, { id, name, command }) => {
  try { sessionStore.updateQuickCmd(id, name, command); schedulePersist(); return { ok: true }; }
  catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('quick:del', (_e, id) => {
  try { sessionStore.deleteQuickCmd(id); schedulePersist(); return { ok: true }; }
  catch (err) { return { ok: false, error: err.message }; }
});

// ---------- IPC:SSH 隧道 / 端口转发 ----------
// 隧道挂在"已连接的 SSH 会话"上,id -> { stop(), ...元数据 }
const tunnels = new Map();
let tunnelSeq = 0;

function tunnelPublic(t) {
  return {
    id: t.id, name: t.name, type: t.type, sessionId: t.sessionId,
    localHost: t.localHost, localPort: t.localPort,
    remoteHost: t.remoteHost, remotePort: t.remotePort,
    status: t.status, createdAt: t.createdAt,
  };
}

// 停掉某条隧道(本地/动态=关监听,远程=取消 forwardIn)
function stopTunnel(t) {
  try { t.stop(); } catch { /* ignore */ }
  t.status = 'stopped';
}

// 会话断开/关闭时,把它挂着的隧道全部停掉(否则端口残留)
function stopTunnelsForSession(sessionId) {
  for (const [id, t] of tunnels) {
    if (t.sessionId === sessionId) {
      stopTunnel(t);
      tunnels.delete(id);
    }
  }
}

ipcMain.handle('tunnel:list', () => {
  try { return { ok: true, tunnels: [...tunnels.values()].map(tunnelPublic) }; }
  catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('tunnel:create', async (_e, spec) => {
  try {
    const sessionId = String(spec.sessionId || '');
    const s = sshSessions.get(sessionId);
    if (!s || !s.conn) return { ok: false, error: '请先连接一个会话,再在它上面建隧道' };
    const type = spec.type; // 'local' | 'remote' | 'dynamic'
    if (!['local', 'remote', 'dynamic'].includes(type)) return { ok: false, error: '未知隧道类型' };
    const localPort = Number(spec.localPort);
    if (!localPort) return { ok: false, error: '本地端口不合法' };
    // 本地端口不能已被占用(本地/动态要在本地监听;远程的本地端口是"目标")
    if (type !== 'remote' && [...tunnels.values()].some((t) => t.status === 'active' && t.localPort === localPort && t.type !== 'remote')) {
      return { ok: false, error: `本地端口 ${localPort} 已被另一条隧道占用` };
    }
    let started;
    if (type === 'local') {
      started = await tunnelLib.startLocal(s.conn, { localHost: '127.0.0.1', localPort, remoteHost: spec.remoteHost, remotePort: Number(spec.remotePort) });
    } else if (type === 'remote') {
      started = await tunnelLib.startRemote(s.conn, { bindAddr: '127.0.0.1', remotePort: Number(spec.remotePort), localHost: '127.0.0.1', localPort });
    } else {
      started = await tunnelLib.startDynamic(s.conn, { localHost: '127.0.0.1', localPort });
    }
    const id = `tun-${++tunnelSeq}`;
    tunnels.set(id, {
      id, name: String(spec.name || '').trim() || `${type.toUpperCase()}:${localPort}`,
      type, sessionId, localHost: '127.0.0.1', localPort,
      remoteHost: type === 'remote' ? `(远程:127.0.0.1:${spec.remotePort})` : (spec.remoteHost || ''),
      remotePort: Number(spec.remotePort) || 0,
      status: 'active', createdAt: new Date().toLocaleString('zh-CN', { hour12: false }),
      stop: started.stop, server: started.server,
    });
    const t = tunnels.get(id);
    console.log(`[MAIN] 隧道已建: ${t.name} (${t.type}) 本地:${t.localPort}`);
    return { ok: true, tunnel: tunnelPublic(t) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('tunnel:delete', (_e, id) => {
  try {
    const t = tunnels.get(String(id || ''));
    if (!t) return { ok: false, error: '隧道不存在' };
    stopTunnel(t);
    tunnels.delete(String(id));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ---------- IPC:会话录制与回放 ----------
// 录制:渲染层传 sessionId + 会话元数据,主进程在数据流里打点写 JSONL
ipcMain.handle('rec:start', (_e, { sessionId, meta }) => {
  try {
    const rec = startRecording(String(sessionId || ''), meta);
    return { ok: true, file: rec.file };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// 停止录制:先把缓冲区里攒着的输出发完(避免尾部数据丢失)再收尾
ipcMain.handle('rec:stop', (_e, sessionId) => {
  try {
    const sid = String(sessionId || '');
    flushSshData(sid); // 把还没 flush 的终端数据补录进去
    const rec = finalizeRecording(sid);
    return { ok: true, record: rec };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// 列出全部录制(新的在前)
ipcMain.handle('rec:list', () => {
  try { return { ok: true, recordings: sessionStore.listRecordings() }; }
  catch (err) { return { ok: false, error: err.message }; }
});

// 删除录制:删元数据 + 删磁盘 JSONL 文件
ipcMain.handle('rec:delete', (_e, id) => {
  try {
    const row = sessionStore.deleteRecording(Number(id));
    if (row && row.file && fs.existsSync(row.file)) {
      try { fs.rmSync(row.file); } catch { /* 文件删不掉也不阻塞 */ }
    }
    schedulePersist();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// 打开录制目录(方便用户手动拷贝/管理 JSONL)
ipcMain.handle('rec:openDir', () => {
  try {
    const dir = recorder.recordingsDir();
    fs.mkdirSync(dir, { recursive: true });
    shell.openPath(dir);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// 打开会话日志目录(查看/拷贝 .log 审计文件)
ipcMain.handle('log:openDir', () => {
  try {
    const dir = sessionLog.sessionLogsDir();
    fs.mkdirSync(dir, { recursive: true });
    shell.openPath(dir);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// 读取录制内容供回放:解析 JSONL → 输出按 encoding 解码成文本,输入原样文本
// (base64 / 编码逻辑都留在主进程,渲染层只拿纯文本,写进 xterm 即可)
ipcMain.handle('rec:replay', (_e, id) => {
  try {
    const meta = sessionStore.getRecording(Number(id));
    if (!meta) return { ok: false, error: '录制不存在' };
    if (!fs.existsSync(meta.file)) return { ok: false, error: '录制文件已丢失: ' + meta.file };
    const events = recorder.parseRecording(meta.file).map((evt) => ({
      t: evt.t,
      kind: evt.kind,
      text: evt.kind === 'o' ? recorder.decodeOutput(evt.data, meta.encoding) : evt.data,
    }));
    return { ok: true, meta, events };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ---------- IPC:SSH 直连 ----------
// 指纹校验(known_hosts):首次连接询问是否信任,已信任校验一致,不一致拒绝。
// autoTrust:设置里开了"自动信任新主机密钥" → 未记录的主机直接信任并记录(不弹窗)。
function makeHostVerifier(host, port, autoTrust) {
  return (key) => {
    try {
      const fp = knownHosts.fingerprint(key);
      const id = `${host}:${port}`;
      const known = knownHosts.get(id);
      if (known) {
        if (known === fp) return true;
        dialog.showMessageBoxSync(mainWindow, {
          type: 'error', title: '安全警告',
          message: '主机密钥不匹配,可能被中间人攻击!',
          detail: `${id}\n已记录指纹: ${known}\n本次指纹:   ${fp}`,
          buttons: ['断开连接'],
        });
        return false;
      }
      // 自动信任:跳过弹窗,直接记录指纹并放行(仍写入 known_hosts,之后照常校验)
      if (autoTrust) {
        knownHosts.set(id, fp);
        console.warn(`[MAIN] 自动信任新主机 ${id}(指纹 ${fp.slice(0, 20)}…),已写入 known_hosts`);
        return true;
      }
      const r = dialog.showMessageBoxSync(mainWindow, {
        type: 'question', title: '首次连接',
        message: `是否信任 ${host}:${port} 的主机密钥?`,
        detail: `指纹: ${fp}`,
        buttons: ['信任并连接', '拒绝'],
        defaultId: 0,
        cancelId: 1,
      });
      if (r === 0) { knownHosts.set(id, fp); return true; }
      return false;
    } catch (err) {
      console.warn('[MAIN] 指纹校验异常,拒绝连接:', err.message);
      return false;
    }
  };
}

// 跳板机(SSH 代理,等价 ssh -J):先连跳板机,经它 forwardOut 开一条到目标的隧道,
// 目标 SSH 连接把这条隧道当 sock 用,目标机的认证仍由用户自己的账号完成(跳板只转发字节)。
// 失败时清理已建的跳板连接并抛出,调用方会走 ssh:connect 的失败分支。
async function openJumpTunnel(sessionId, finalOpts) {
  const j = finalOpts.jump;
  const jport = j.port || 22;
  const jumpConn = await sshClient.connectRaw({
    ...resolvePrivateKey({
      host: j.host, port: jport, username: j.username || finalOpts.username,
      password: j.password, privateKey: j.private_key || '', passphrase: j.passphrase || '',
    }),
    hostVerifier: makeHostVerifier(j.host, jport, finalOpts.autoTrustHostKey === true), // 跳板机指纹同样校验
    onKeyboardInteractive: makeKbdResponder(sessionId, { ...finalOpts, host: j.host, port: jport }), // 跳板可能也要域认证/OTP
  });
  jumpConns.set(sessionId, jumpConn);
  try {
    return await new Promise((resolve, reject) => {
      // 超时兜底:跳板机握手成功但转发永不响应时,别让标签永久卡"连接中"
      const timer = setTimeout(() => reject(new Error('跳板机转发超时')), 30000);
      jumpConn.forwardOut(finalOpts.host, 0, finalOpts.host, finalOpts.port || 22, (err, stream) => {
        clearTimeout(timer);
        if (err) return reject(err);
        resolve(stream);
      });
    });
  } catch (err) {
    try { jumpConn.end(); } catch { /* ignore */ }
    jumpConns.delete(sessionId);
    throw err;
  }
}

// 断开/关标签时收掉挂在这条会话上的跳板连接(幂等)
function closeJump(sessionId) {
  const jc = jumpConns.get(sessionId);
  if (jc) {
    jumpConns.delete(sessionId);
    try { jc.end(); } catch { /* ignore */ }
  }
}

// 把私钥文件路径换成私钥内容(ssh2 要的是内容不是路径)
function resolvePrivateKey(opts) {
  if (!opts || !opts.privateKey) return opts;
  try {
    return { ...opts, privateKey: fs.readFileSync(opts.privateKey) };
  } catch (err) {
    console.warn('[MAIN] 读取私钥失败:', err.message); // 读不到就保留路径,让 ssh2 报错更清楚
    return opts;
  }
}

// 给"一次性连接"(批量传输/AI 助手/系统探测)也自动装上指纹校验。
// 规则与 ssh:connect 一致:传了 verifyHostKey:false 就跳过,否则一律校验。
function withHostVerify(opts) {
  if (!opts || !opts.host) return opts;
  if (opts.verifyHostKey === false) return opts;
  return { ...opts, hostVerifier: makeHostVerifier(opts.host, opts.port || 22, opts.autoTrustHostKey === true) };
}

// ---------- keyboard-interactive 认证(域/双密码/OTP 挑战) ----------
// ssh2 认证阶段如果服务器发起键盘交互挑战,把提示推给渲染层弹窗,用户填完再应答。
// 单"密码"提示且有保存的密码 → 主进程自动应答,不弹窗打扰。
const kbdWaiters = new Map(); // id → { resolve, reject, timer }
let kbdSeq = 0;
function makeKbdResponder(sessionId, opts) {
  return ({ name, instructions, prompts }) => new Promise((resolve, reject) => {
    if (prompts.length === 1 && prompts[0].echo === false && opts.password) {
      return resolve([opts.password]); // 常规密码挑战:直接用保存的密码
    }
    const id = `kbd-${++kbdSeq}`;
    kbdWaiters.set(id, { resolve, reject });
    broadcast('ssh:kbd-interactive', sessionId, { id, name, instructions, prompts });
    const timer = setTimeout(() => {
      if (kbdWaiters.delete(id)) reject(new Error('keyboard-interactive 应答超时(60s)'));
    }, 60000);
    kbdWaiters.get(id).timer = timer;
  });
}
ipcMain.on('ssh:kbd-respond', (_e, id, answers, cancelled) => {
  const w = kbdWaiters.get(id);
  if (!w) return;
  clearTimeout(w.timer);
  kbdWaiters.delete(id);
  if (cancelled) w.reject(new Error('用户取消键盘交互认证'));
  else w.resolve(Array.isArray(answers) ? answers : []);
});

ipcMain.handle('ssh:connect', async (_e, { sessionId, opts }) => {
  console.log('[MAIN] ssh:connect 被调用 →', `${opts && opts.username}@${opts && opts.host}:${opts && opts.port}`);
  if (sshSessions.has(sessionId)) {
    return { ok: false, error: `会话 ${sessionId} 已存在` };
  }
  try {
    const finalOpts = resolvePrivateKey({ ...opts }); // 私钥路径 → 内容
    // 默认开启指纹校验;渲染进程可传 verifyHostKey:false 关闭
    if (finalOpts.verifyHostKey !== false) {
      finalOpts.hostVerifier = makeHostVerifier(finalOpts.host, finalOpts.port, finalOpts.autoTrustHostKey === true);
    }
    // keyboard-interactive 挑战 → 渲染层弹窗问用户
    finalOpts.onKeyboardInteractive = makeKbdResponder(sessionId, finalOpts);
    // 配了跳板机:先经跳板开隧道到目标,再在隧道上做目标机的 SSH 认证(等价 ssh -J)
    if (finalOpts.jump && finalOpts.jump.host) {
      finalOpts.sock = await openJumpTunnel(sessionId, finalOpts);
    }
    const { conn, stream } = await sshClient.connect(finalOpts);
    // 非 utf8 会话(GBK/GB2312):建流式解码器,主进程转码后再发给渲染层
    const enc = finalOpts.encoding || 'utf8';
    if (enc !== 'utf8') {
      try { sshDecoders.set(sessionId, iconv.getDecoder(enc)); } catch { /* 不支持的编码 */ }
    }
    closedBroadcast.delete(sessionId); // 重连:清掉上次断开的 closed 标记,新连接可再次广播
    // hostId:跨重启续传的稳定主机身份(sessionId 每次启动从 sess-1 重计,不能单独做键)。
    // JMS 堡垒机用复合用户名(用户@协议@账号@资产IP),天然区分同网关下不同资产。
    const uname = String(finalOpts.username || '');
    sshSessions.set(sessionId, {
      conn, stream, encoding: enc,
      sessionUser: uname.split('@').pop(),
      hostId: `${uname ? uname + '@' : ''}${finalOpts.host || ''}:${finalOpts.port || 22}`,
      connOpts: finalOpts, // 存完整连接参数:SFTP 走独立连接重连用(含 KoKo 复合用户名/跳板)
    });
    // 会话日志:设置里开着(默认开)就为这次连接建日志文件
    if (finalOpts.sessionLog !== false) {
      startSessionLog(sessionId, {
        sessionName: finalOpts.sessionName, host: finalOpts.host, port: finalOpts.port,
        username: finalOpts.username, encoding: enc,
      });
    }

    stream.on('data', (data) => {
      pushSshData(sessionId, data); // 批量转发(性能优化),不再逐条 IPC
    });
    stream.on('close', () => {
      // 无 presence guard:主动断开(ssh:close)已先删记录,但 closed 广播仍要发给渲染层
      flushSshData(sessionId); // 关前把攒着的数据发完,别丢尾部
      cleanupSshDecoder(sessionId); // 冲刷没转完的字符
      finalizeRecording(sessionId); // 断线时若在录制,自动收尾保存
      finalizeSessionLog(sessionId); // 断开时收尾会话日志
      stopTunnelsForSession(sessionId); // 断开时停掉挂在这条连接上的隧道
      closeJump(sessionId); // 断开时收掉跳板连接
      if (!closedBroadcast.has(sessionId)) {
        closedBroadcast.add(sessionId);
        broadcast('ssh:status', sessionId, { status: 'closed' });
      }
      closeSftpConn(sessionId); // 先关独立的 SFTP 连接(记录还在)
      sshSessions.delete(sessionId);
      clearSftpKnownSizes(sessionId);
    });
    conn.on('close', () => {
      if (!sshSessions.has(sessionId)) return; // 流 close / ssh:close 已收尾并广播,这里只兜底
      flushSshData(sessionId);
      cleanupSshDecoder(sessionId);
      finalizeRecording(sessionId); // 幂等:即使上面已收尾,这里也是空操作
      finalizeSessionLog(sessionId); // 幂等:已收尾则空操作
      stopTunnelsForSession(sessionId); // 幂等:已停的隧道这里也是空操作
      closeJump(sessionId); // 幂等:已收的跳板连接这里也是空操作
      closeSftpConn(sessionId); // 先关独立的 SFTP 连接(记录还在)
      if (!closedBroadcast.has(sessionId)) {
        closedBroadcast.add(sessionId);
        broadcast('ssh:status', sessionId, { status: 'closed' });
      }
      sshSessions.delete(sessionId);
    });
    conn.on('error', (err) => {
      broadcast('ssh:status', sessionId, { status: 'error', error: err.message });
    });

    stream.setWindow(opts.rows || 32, opts.cols || 120, 0, 0);
    broadcast('ssh:status', sessionId, { status: 'connected' });
    return { ok: true };
  } catch (err) {
    console.log('[MAIN] ssh:connect 失败:', err.message); // 日志里能看到失败原因
    closeJump(sessionId); // 目标连接失败也要收掉已开好的跳板隧道(幂等,无跳板时为 no-op)
    return { ok: false, error: err.message };
  }
});

// ---------- IPC:Telnet 连接 ----------
// Telnet 会话复用整条 ssh:data/ssh:status/ssh:write 管线(录制/会话日志/GBK 转码都在
// pushSshData 里按 sessionId 路由),只是底层从 ssh2 stream 换成裸 TCP socket + IAC 协商。
ipcMain.handle('telnet:connect', (_e, { sessionId, opts }) => new Promise((resolve) => {
  if (telnetSessions.has(sessionId)) { resolve({ ok: false, error: `会话 ${sessionId} 已存在` }); return; }
  let settled = false;
  let telnetConnected = false; // onConnect 后置 true:区分"连接阶段失败"与"已连接后的错误"
  const done = (r) => { if (!settled) { settled = true; resolve(r); } };
  const tel = telnetClient.connect({
    host: opts.host,
    port: opts.port || 23,
    timeoutMs: opts.timeoutMs || 15000,
    cols: opts.cols, rows: opts.rows,
    encoding: opts.encoding || 'utf8', // 输入按此编码发送(GBK 设备)
    autoLogin: (opts.username || opts.password) ? { username: opts.username, password: opts.password } : null,
    onConnect: () => {
      telnetConnected = true;
      // 守卫:ssh:close 可能在 onConnect 之前到达(用户连接瞬间关标签)——
      // 记录已被删除,此时不能再广播 connected(否则渲染层冒出"幽灵已连接"状态)
      if (!telnetSessions.has(sessionId)) {
        done({ ok: false, error: '连接已取消' });
        return;
      }
      const enc = opts.encoding || 'utf8';
      if (enc !== 'utf8') {
        try { sshDecoders.set(sessionId, iconv.getDecoder(enc)); } catch { /* 不支持的编码 */ }
      }
      if (opts.sessionLog !== false) {
        startSessionLog(sessionId, { sessionName: opts.sessionName, host: opts.host, port: opts.port, username: opts.username, encoding: enc });
      }
      broadcast('ssh:status', sessionId, { status: 'connected' });
      done({ ok: true });
    },
    onData: (chunk) => pushSshData(sessionId, chunk),
    onError: (err) => {
      // 连接阶段失败(超时/拒连):只回错误给调用方,不触发收尾(此时无录制/日志/解码器)
      if (!telnetConnected) {
        telnetSessions.delete(sessionId);
        done({ ok: false, error: err.message });
        return;
      }
      // 已连接后的错误:必须完整收尾,与 onClose 一致(冲刷数据/清解码器/收录制收日志)+
      // 广播 closed —— 否则渲染层标签永久假活、不触发自动重连,录制/日志句柄泄漏(旧版 bug)。
      flushSshData(sessionId);
      cleanupSshDecoder(sessionId);
      finalizeRecording(sessionId); // 幂等
      finalizeSessionLog(sessionId); // 幂等
      if (!closedBroadcast.has(sessionId)) {
        closedBroadcast.add(sessionId);
        broadcast('ssh:status', sessionId, { status: 'closed' });
      }
      telnetSessions.delete(sessionId);
      done({ ok: false, error: err.message });
    },
    onClose: () => {
      if (!telnetSessions.has(sessionId)) return; // 连接失败已删记录,这里只兜底
      flushSshData(sessionId);
      cleanupSshDecoder(sessionId);
      finalizeRecording(sessionId); // 幂等:ssh:close 已收尾则空操作
      finalizeSessionLog(sessionId); // 幂等
      if (!closedBroadcast.has(sessionId)) {
        closedBroadcast.add(sessionId);
        broadcast('ssh:status', sessionId, { status: 'closed' });
      }
      telnetSessions.delete(sessionId);
    },
  });
  telnetSessions.set(sessionId, tel); // 立即登记:用户中途关标签,ssh:close 也能路由到它
}));

ipcMain.on('ssh:write', (_e, sessionId, data) => {
  // 录制打点:记录敲过的输入(回放时用 ▶ 标出,看清每步做了什么)
  const rec = recSessions.get(sessionId);
  if (rec && data) recorder.writeInput(rec.file, Date.now() - rec.startTs, data);
  writeSessionInput(sessionId, data); // 会话日志:按行缓冲记录输入(命令回车后整行落盘)
  const s = sshSessions.get(sessionId);
  if (s && s.stream && !s.stream.destroyed) {
    // 输入按会话编码编码:GBK/GB2312 会话不能恒发 UTF-8,否则服务器按 GBK 解出乱码。
    // 编码已含连接后自动探测的结果(ssh:setEncoding 会更新 s.encoding)。
    const enc = s.encoding || 'utf8';
    s.stream.write(enc === 'utf8' ? Buffer.from(data) : iconv.encode(String(data || ''), enc));
    return;
  }
  // Telnet 会话:CRLF 映射 + 本地回显在 telnet 客户端内处理(编码也在其 write 内按会话编码处理)
  const t = telnetSessions.get(sessionId);
  if (t) t.write(data);
});

// 自动探测到非 utf8 字符集后切换会话编码:更新输入编码 + 重建输出解码器。
// 注意连接中途切换,切换前已按旧编码发出去的数据不会再改(仅影响后续收发)。
ipcMain.on('ssh:setEncoding', (_e, sessionId, enc) => {
  const s = sshSessions.get(sessionId);
  if (!s) return;
  s.encoding = enc;
  try {
    const old = sshDecoders.get(sessionId);
    if (old) { try { old.end(); } catch { /* ignore */ } sshDecoders.delete(sessionId); }
    if (enc !== 'utf8') sshDecoders.set(sessionId, iconv.getDecoder(enc));
  } catch { /* 不支持的编码 */ }
});

ipcMain.on('ssh:resize', (_e, sessionId, cols, rows) => {
  const s = sshSessions.get(sessionId);
  if (s && s.stream) {
    try { s.stream.setWindow(rows, cols, 0, 0); } catch { /* ignore */ }
    return;
  }
  const t = telnetSessions.get(sessionId);
  if (t) t.resize(cols, rows); // NAWS 窗口大小协商
});

ipcMain.on('ssh:close', (_e, sessionId) => {
  flushSshData(sessionId); // 关闭前先把攒着的终端数据发完
  cleanupSshDecoder(sessionId);
  finalizeRecording(sessionId); // 关标签时若在录制,自动收尾
  finalizeSessionLog(sessionId); // 关标签时收尾会话日志
  stopTunnelsForSession(sessionId); // 关标签时停掉该连接的隧道
  closeJump(sessionId); // 关标签时收掉跳板连接
  const t = telnetSessions.get(sessionId);
  if (t) {
    try { t.destroy(); } catch { /* ignore */ }
    telnetSessions.delete(sessionId);
    // socket close 事件里 onClose 已因记录删除而 early-return,这里补发 closed
    if (!closedBroadcast.has(sessionId)) {
      closedBroadcast.add(sessionId);
      broadcast('ssh:status', sessionId, { status: 'closed' });
    }
  }
  const s = sshSessions.get(sessionId);
  if (s) {
    try { s.stream.end(); } catch { /* ignore */ }
    try { s.conn.end(); } catch { /* ignore */ }
    sshSessions.delete(sessionId);
  }
});

// ---------- IPC:SFTP 文件传输 ----------
// SFTP 对象按 sessionId 缓存:同一 SSH 连接只开一次 sftp 通道
// ---- SFTP 调试日志:记录每次 SFTP 操作(耗时/结果/错误),协助排查偶发"目录读取超时"、大文件传输失败 ----
// 日志写到 app-*.log(调试面板 ⬇ 下载日志可导出),带 [SFTP] 前缀便于 grep。
function __sftpLog(msg, extra) {
  try {
    const line = '[SFTP] ' + msg + (extra ? ' | ' + JSON.stringify(extra).slice(0, 600) : '');
    // console.log 在 main.js 里被重写:转发到调试面板(🧾) + 落盘 app-*.log
    try { console.log(line); } catch { /* ignore */ }
  } catch { /* ignore */ }
}
async function getSftp(sessionId) {
  const s = sshSessions.get(sessionId);
  if (!s) throw new Error('SSH 连接不存在或已断开');
  if (!s.sftp) {
    const t0 = Date.now();
    // 优先独立 SFTP 连接:H3C 等单通道设备在 shell 同连接开 SFTP 会顶掉 shell(终端失效)。
    // 但 H3C 用一次性 OTP,独立连接复用 OTP 可能失败/顶掉主连接 → 失败时回退主连接 SFTP。
    // 回退后的行为 = v1.0.20 前:SFTP 走主连接,保证功能可用。
    __sftpLog('打开 SFTP(优先独立连接)', { sessionId, t0 });
    const openOnMain = async () => {
      const raw = await Promise.race([
        sshClient.openSftp(s.conn),
        new Promise((_, reject) => setTimeout(() => reject(new Error('SFTP 通道打开超时(15s),堡垒机网关可能未响应 SFTP 子系统')), 15000)),
      ]);
      s.sftp = raw; // 主连接上的 SFTP:不加 sftpConn(随主连接一起关)
      return raw;
    };
    const openSeparate = async () => {
      const opts = { ...s.connOpts };
      delete opts.sock; // 旧连接的跳板隧道 socket 不能复用
      delete opts.hostVerifier; // 指纹校验按需重建
      if (opts.verifyHostKey !== false) {
        opts.hostVerifier = makeHostVerifier(opts.host, opts.port || 22, opts.autoTrustHostKey === true);
      }
      const connectOnce = async () => {
        if (opts.jump && opts.jump.host) opts.sock = await openJumpTunnel(sessionId, opts);
        const raw = await sshClient.connectRaw(opts);
        try {
          const sftp = await sshClient.openSftp(raw);
          s.sftpConn = raw; s.sftp = sftp;
          return sftp;
        } catch (e) {
          try { raw.end(); } catch { /* ignore */ }
          throw e;
        }
      };
      try {
        return await connectOnce();
      } catch (e) {
        const msg = String((e && e.message) || e);
        // 通道打开被限流(too offen):等 1s 重试一次
        if (/channel open|too offen|too often|Channel open failure/i.test(msg)) {
          __sftpLog('SFTP 通道被限流,1s 后重试', { sessionId, error: msg });
          await new Promise((r) => setTimeout(r, 1000));
          return connectOnce();
        }
        throw e;
      }
    };
    // 探测独立 SFTP 是否真能用:某些设备(H3C OTP 复用)独立连接能认证通过,但该连接上
    // SFTP 操作全被拒(General failure)——连接打开成功不代表可用。readdir('.') 探测一次,
    // 报 General failure 即判定独立连接不可用,回退主连接。超时按可用处理(慢设备不误判)。
    const probeSftp = (sftp) => new Promise((resolve) => {
      let done = false;
      const finish = (ok) => { if (!done) { done = true; resolve(ok); } };
      const timer = setTimeout(() => finish(true), 5000);
      try {
        sftp.readdir('.', (err) => { clearTimeout(timer); finish(!err || !String((err && err.message) || err).includes('General failure')); });
      } catch { clearTimeout(timer); finish(true); }
    });
    try {
      try {
        const sep = await Promise.race([
          openSeparate(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('SFTP 独立连接超时(20s)')), 20000)),
        ]);
        const usable = await probeSftp(sep);
        if (!usable) {
          // 独立连接认证通过但 SFTP 不可用(H3C OTP 复用)→ 关闭它,回退主连接 SFTP
          __sftpLog('独立 SFTP 探测失败(General failure),回退主连接', { sessionId, ms: Date.now() - t0 });
          closeSftpConn(sessionId); // 关掉不可用的独立连接
          await openOnMain();
          __sftpLog('SFTP 回退主连接成功', { sessionId, ms: Date.now() - t0 });
        } else {
          __sftpLog('SFTP 独立连接成功', { sessionId, ms: Date.now() - t0 });
        }
      } catch (e) {
        // 独立连接失败(OTP 复用被拒/设备限制/超时)→ 回退主连接 SFTP,不阻断功能
        __sftpLog('SFTP 独立连接失败,回退主连接', { sessionId, error: e && e.message, ms: Date.now() - t0 });
        s.sftpConn = null; s.sftp = null; // 清掉独立连接残留(如有)
        await openOnMain();
        __sftpLog('SFTP 回退主连接成功', { sessionId, ms: Date.now() - t0 });
      }
    } catch (e) {
      __sftpLog('SFTP 连接失败', { sessionId, ms: Date.now() - t0, error: e && e.message });
      throw e;
    }
  }
  return s.sftp;
}

// 关掉会话的独立 SFTP 连接(会话断开/关标签时调用,幂等)
function closeSftpConn(sessionId) {
  const s = sshSessions.get(sessionId);
  if (s) {
    try { if (s.sftpConn) { s.sftpConn.end(); } } catch { /* ignore */ }
    s.sftpConn = null; s.sftp = null;
  }
}

// 把目录和文件名拼成远程路径(统一用 / 分隔,处理 root 边界)
function joinRemote(dir, name) {
  if (dir === '/' || dir === '') return `/${name}`;
  return `${dir.replace(/\/$/, '')}/${name}`;
}

// ---- 断点续传(磁盘持久化)----
// 只续传"我们自己中断过"的传输:失败时记真实已写字节(+本地 mtime),重试同一路径时
// 由 ssh-client 的 resolve*Offset 纯函数判定偏移。绝不按 size 猜同名既有文件(那会拼脏文件)。
// 记录落在 lib/sftp-partials.js 管理的 sftp-partials.json(每次变更同步落盘),app 重启/
// 崩溃后中断点仍在 —— 跨会话续传不再退化为全量重传。
// 键用稳定主机身份 hostId:kind:path(hostId 由 ssh:connect 存进 sshSessions):
//   sessionId 每次启动从 sess-1 重计,不能单独做键(否则会把 A 主机的断点续传到 B 主机);
//   kind=u(上传远端路径)/d(下载本地路径)区分同一路径的两种记录。
const sftpPartials = require('./lib/sftp-partials');
const ptKey = (sessionId, kind, p) => {
  const s = sshSessions.get(sessionId);
  const hostId = (s && s.hostId) || sessionId; // 取不到 hostId 时回退 sessionId(至少会话内隔离)
  return `${hostId}:${kind}:${p}`;
};

// 查上传续传偏移:返回 >0 表示应从该偏移续传;状态已失效则清记录并返回 0
async function resolveUploadResume(sessionId, sftp, remotePath, localPath) {
  const key = ptKey(sessionId, 'u', remotePath);
  const p = sftpPartials.get(key);
  if (!p) return 0;
  const cur = await sshClient.statSize(sftp, remotePath); // 远端真实已写字节(以实际落盘为准)
  const off = sshClient.resolveUploadOffset(p, fs.statSync(localPath).mtimeMs, cur);
  if (off === 0) sftpPartials.remove(key);
  return off;
}

// 上传失败时记下中断点:远端已写字节 + 本地 mtime(本地 mtime 变过就不续,前缀可能已失效)
async function recordUploadPartial(sessionId, sftp, remotePath, localPath) {
  try {
    const cur = await sshClient.statSize(sftp, remotePath);
    if (cur > 0) sftpPartials.set(ptKey(sessionId, 'u', remotePath), { bytes: cur, mtimeMs: fs.statSync(localPath).mtimeMs });
  } catch { /* 记不下来就放弃续传,不影响主流程 */ }
}

// 查下载续传偏移:本地残留必须恰好等于中断点(说明那份残留是我们传的)
function resolveDownloadResume(sessionId, localPath) {
  const key = ptKey(sessionId, 'd', localPath);
  const p = sftpPartials.get(key);
  if (!p) return 0;
  const localSize = fs.existsSync(localPath) ? fs.statSync(localPath).size : 0;
  const off = sshClient.resolveDownloadOffset(p, localSize);
  if (off === 0) sftpPartials.remove(key);
  return off;
}

// 下载失败时记下本地中断点(真实落盘大小)
function recordDownloadPartial(sessionId, localPath) {
  try { if (fs.existsSync(localPath)) sftpPartials.set(ptKey(sessionId, 'd', localPath), { bytes: fs.statSync(localPath).size }); } catch { /* ignore */ }
}

// 探测 SFTP 默认家目录:
//   规则(用户要求):优先当前用户家目录;家目录在 SFTP 里不可访问(堡垒机 SFTP 被 chroot)
//   或不存在时用 /tmp。显示路径与上传路径都用这里的结果,保证一致。
//   实现:
//     1. exec 通道执行 pwd / $HOME 拿 shell 视角的真实家目录(如 /root)——SFTP 是
//        chroot 的,用 SFTP stat 看不到 /root,必须用 exec。
//     2. 用 SFTP readdir 验证该家目录可访问;能列出 → 用它。
//     3. 不能(SFTP chroot 看不到家目录,如 KoKo 网关 SFTP 根 = 系统 /tmp)→ 回退 /tmp。
ipcMain.handle('sftp:home', async (_e, { sessionId }) => {
  try {
    const s = sshSessions.get(sessionId);
    if (!s || !s.conn) return { ok: false, error: '连接不存在' };
    // 1. exec 拿真实家目录
    const home = await new Promise((res) => {
      try {
        s.conn.exec('pwd', (err, stream) => {
          if (err || !stream) return res(null);
          let data = '';
          stream.on('data', (d) => { data += d; });
          stream.on('close', () => {
            const p = String(data).trim().split('\n').pop() || '';
            res(/^\//.test(p) ? p : null);
          });
          stream.stderr.on('data', () => {});
          setTimeout(() => res(null), 8000); // 超时兜底
        });
      } catch { res(null); }
    });
    // 2. 用 SFTP 验证家目录可访问(readdir 能列出才算可用;chroot 下 /root 不可访问)
    if (home) {
      const sftp = await getSftp(sessionId).catch(() => null);
      if (sftp) {
        const ok = await new Promise((res2) => sftp.readdir(home, (e) => res2(!e)));
        if (ok) return { ok: true, home };
      }
    }
    // 3. 家目录不可访问/拿不到 → 回退 /tmp(SFTP 可访问的常用目录)
    return { ok: true, home: '/tmp' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// 列出目录内容 → 返回 { entries: [{ name, isDir, size, mtime }], cwd: 绝对路径 }
// 某些设备(H3C 网络设备等)SFTP 对刚写入的文件 readdir/stat 恒报 size 0,但数据已落盘。
// 记录本次会话成功上传文件的真实大小(sessionId|remotePath → size),面板列目录时
// 若读到 0 就用真实值覆盖 —— 否则上传完面板里全是 0,用户误以为传坏了。
const sftpKnownSizes = new Map();
// 会话关闭时清掉该会话的上传大小记录,防 Map 无限增长
function clearSftpKnownSizes(sessionId) {
  const prefix = sessionId + '|';
  for (const k of sftpKnownSizes.keys()) if (k.startsWith(prefix)) sftpKnownSizes.delete(k);
}

ipcMain.handle('sftp:list', async (_e, { sessionId, remotePath }) => {
  const _t0 = Date.now();
  try {
    const sftp = await getSftp(sessionId);
    const [items, cwd] = await Promise.all([
      new Promise((resolve, reject) => {
        let done = false;
        // 慢设备(H3C 网络设备)readdir 可能很慢;stat 探测若挂住通道也会拖到 readdir。
        // 放宽到 40s + 超时留痕(旧版 20s 偏紧,慢设备常误报"目录读取超时")
        const to = setTimeout(() => {
          if (!done) {
            done = true;
            __sftpLog('readdir 超时', { sessionId, path: remotePath, ms: Date.now() - _t0 });
            try { if (typeof __startupLog === 'function') __startupLog('sftp:list readdir 超时: ' + remotePath + ' (40s)'); } catch { /* ignore */ }
            reject(new Error('目录读取超时(40s)'));
          }
        }, 40000);
        sftp.readdir(remotePath, (err, list) => {
          if (done) return;
          done = true; clearTimeout(to);
          err ? reject(err) : resolve(list || []);
        });
      }),
      // realpath 把 '.' / 相对路径 解析成绝对路径,这样面板路径栏显示的是真路径
      new Promise((resolve) => {
        sftp.realpath(remotePath, (err, p) => resolve(err ? remotePath : p));
      }),
    ]);
    __sftpLog('readdir 完成', { sessionId, path: remotePath, count: (items || []).length, ms: Date.now() - _t0 });
    // 设备 stat 骗人(读目录属性报 0,数据其实在):用已知上传大小覆盖显示。
    // 不做 stat 兜底探测 —— H3C 等设备 SFTP 服务器串行处理请求,挂住的 stat 会阻塞
    // 后续 readdir → 面板"目录读取超时";且撒谎设备 stat 也报 0,探测无收益。
    const entries = [];
    for (const it of items) {
      const isDir = !!it.attrs.isDirectory();
      let size = it.attrs.size || 0;
      const fullPath = joinRemote(remotePath, it.filename);
      if (!isDir && size === 0) {
        const known = sftpKnownSizes.get(`${sessionId}|${fullPath}`);
        if (known) size = known;
      }
      entries.push({ name: it.filename, isDir, size, mtime: it.attrs.mtime ? it.attrs.mtime * 1000 : null });
    }
    return { ok: true, entries, cwd };
  } catch (err) {
    __sftpLog('readdir 失败', { sessionId, path: remotePath, ms: Date.now() - _t0, error: err && err.message });
    return { ok: false, error: err.message };
  }
});

// 读取远程文本文件内容(给"SFTP 远程编辑"用)。限制大小,避免误读大二进制。
const EDIT_MAX_BYTES = 512 * 1024; // 512KB 以内才能编辑
ipcMain.handle('sftp:readFile', async (_e, { sessionId, remotePath }) => {
  try {
    const sftp = await getSftp(sessionId);
    // 先看文件大小:目录/超大文件拒绝
    const stat = await new Promise((resolve, reject) => sftp.stat(remotePath, (err, a) => (err ? reject(err) : resolve(a))));
    if (stat.isDirectory()) return { ok: false, error: '这是目录,不是文件' };
    if (stat.size > EDIT_MAX_BYTES) return { ok: false, error: `文件太大(${(stat.size / 1024).toFixed(0)}KB),超过 512KB 不支持在线编辑` };
    const buf = await new Promise((resolve, reject) => sftp.readFile(remotePath, (err, d) => (err ? reject(err) : resolve(d))));
    // 按会话编码解码(GBK 会话读 GBK 文件,否则编辑器里直接乱码)
    const enc = (sshSessions.get(sessionId) && sshSessions.get(sessionId).encoding) || 'utf8';
    let content;
    try { content = enc === 'utf8' ? buf.toString('utf8') : iconv.decode(buf, enc); } catch { content = buf.toString('utf8'); }
    return { ok: true, content, size: stat.size };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// 把编辑后的内容写回远程文件
ipcMain.handle('sftp:writeFile', async (_e, { sessionId, remotePath, content }) => {
  try {
    const sftp = await getSftp(sessionId);
    // 按会话编码写回(GBK 会话写回 GBK 字节,避免 UTF-8 覆盖损坏原文件)
    const enc = (sshSessions.get(sessionId) && sshSessions.get(sessionId).encoding) || 'utf8';
    let data;
    try { data = enc === 'utf8' ? Buffer.from(String(content ?? ''), 'utf8') : iconv.encode(String(content ?? ''), enc); } catch { data = Buffer.from(String(content ?? ''), 'utf8'); }
    await new Promise((resolve, reject) =>
      sftp.writeFile(remotePath, data, (err) => (err ? reject(err) : resolve()))
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// 新建目录
ipcMain.handle('sftp:mkdir', async (_e, { sessionId, remotePath }) => {
  try {
    const sftp = await getSftp(sessionId);
    await new Promise((resolve, reject) => sftp.mkdir(remotePath, (err) => (err ? reject(err) : resolve())));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// 删除目录:递归删空内容后删目录本身(ssh2 的 sftp.rmdir 只能删空目录,非空返回 "Failure")
ipcMain.handle('sftp:rmdir', async (_e, { sessionId, remotePath }) => {
  try {
    const sftp = await getSftp(sessionId);
    await sshClient.rmdirRecursive(sftp, remotePath);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// 删除文件
ipcMain.handle('sftp:delete', async (_e, { sessionId, remotePath }) => {
  try {
    const sftp = await getSftp(sessionId);
    await new Promise((resolve, reject) => sftp.unlink(remotePath, (err) => (err ? reject(err) : resolve())));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// 重命名/移动(文件或目录;目标可以是新名字或新路径)
ipcMain.handle('sftp:rename', async (_e, { sessionId, from, to }) => {
  try {
    const sftp = await getSftp(sessionId);
    await new Promise((resolve, reject) => sftp.rename(from, to, (err) => (err ? reject(err) : resolve())));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// 上传:弹出系统对话框选本地文件 → fastPut 到远程
// 传输进度 → 渲染进程进度条(sftp:progress 事件)
function emitSftpProgress(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('sftp:progress', payload);
}

ipcMain.handle('sftp:upload', async (_e, { sessionId, remoteDir, mode }) => {
  const _t0 = Date.now();
  try {
    const sftp = await getSftp(sessionId);
    // 文件 + 文件夹都能选;选到目录时递归上传(mkdir 建目录 + 流式传文件)。
    // mode='file'/'dir' 时分开只选对应类型(macOS 上 openFile+openDirectory 混开会退化成只能选文件夹)。
    const properties = mode === 'file' ? ['openFile'] : (mode === 'dir' ? ['openDirectory'] : ['openFile', 'openDirectory']);
    const pick = await dialog.showOpenDialog(mainWindow, {
      title: mode === 'file' ? '选择要上传的本地文件' : (mode === 'dir' ? '选择要上传的本地文件夹' : '选择要上传的本地文件或文件夹'),
      properties,
    });
    if (pick.canceled || !pick.filePaths[0]) return { ok: false, error: '已取消' };
    const localPath = pick.filePaths[0];
    __sftpLog('上传开始', { sessionId, remoteDir, localPath, isDir: fs.statSync(localPath).isDirectory() });
    const prog = (p) => emitSftpProgress({ op: 'upload', ...p });
    if (fs.statSync(localPath).isDirectory()) {
      const target = joinRemote(remoteDir, path.basename(localPath));
      // 目录内每个文件各自断点续传:中断点判定 + 失败时记录
      const { uploaded, failed } = await sshClient.uploadDir(
        sftp, localPath, target, prog,
        (lp, rp) => resolveUploadResume(sessionId, sftp, rp, lp),
        (lp, rp) => recordUploadPartial(sessionId, sftp, rp, lp)
      );
      // 记录本次上传文件的真实大小(设备 stat 可能报 0,面板列目录时用它覆盖显示)
      for (const u of uploaded) sftpKnownSizes.set(`${sessionId}|${u.rp}`, u.size);
      __sftpLog('上传结束(目录)', { sessionId, target, ok: uploaded.length, failed: (failed || []).length, ms: Date.now() - _t0 });
      if (failed && failed.length) __sftpLog('上传失败文件', { sessionId, failed: failed.slice(0, 10).map((f) => ({ rp: f.rp, error: f.error })) });
      return { ok: true, remotePath: target, isDir: true, count: uploaded.length, failed };
    }
    const remotePath = joinRemote(remoteDir, path.basename(localPath));
    const resumeFrom = await resolveUploadResume(sessionId, sftp, remotePath, localPath);
    if (resumeFrom > 0) sftpPartials.remove(ptKey(sessionId, 'u', remotePath)); // 这次从偏移续传,旧的记录作废
    try {
      __sftpLog('上传文件开始', { sessionId, remotePath, size: fs.statSync(localPath).size, resumeFrom });
      await sshClient.uploadFile(sftp, localPath, remotePath, (done, total) => prog({ done, total, file: remotePath, fileDone: done, fileTotal: total, filesDone: 0, filesTotal: 1 }), resumeFrom);
      sftpKnownSizes.set(`${sessionId}|${remotePath}`, fs.statSync(localPath).size); // 同上:记录真实大小
      __sftpLog('上传文件完成', { sessionId, remotePath, ms: Date.now() - _t0 });
      return { ok: true, remotePath, resumedFrom: resumeFrom };
    } catch (err) {
      recordUploadPartial(sessionId, sftp, remotePath, localPath); // 又失败:用最新的真实已写字节更新中断点
      __sftpLog('上传文件失败', { sessionId, remotePath, ms: Date.now() - _t0, error: err && err.message });
      return { ok: false, error: err.message };
    }
  } catch (err) {
    __sftpLog('上传异常', { sessionId, remoteDir, ms: Date.now() - _t0, error: err && err.message });
    return { ok: false, error: err.message };
  }
});

// 下载:弹出保存对话框 → 流式下载到本地(带进度),再次存到同一路径时断点续传
ipcMain.handle('sftp:download', async (_e, { sessionId, remotePath }) => {
  try {
    const sftp = await getSftp(sessionId);
    // 文件名取自远程路径,净化掉路径分隔符/.. (远程路径理论上可控,防保存时穿越)
    const name = String(remotePath.split('/').filter(Boolean).pop() || 'download').replace(/[\\/:*?"<>|\r\n]+/g, '_').replace(/\.\./g, '_') || 'download';
    // 测试钩子(POLARIS_AUTO_DL_DIR):自动应答保存对话框,不弹原生窗口
    const save = process.env.POLARIS_AUTO_DL_DIR
      ? { canceled: false, filePath: path.join(process.env.POLARIS_AUTO_DL_DIR, name) }
      : await dialog.showSaveDialog(mainWindow, { title: '保存到本地', defaultPath: name });
    if (save.canceled || !save.filePath) return { ok: false, error: '已取消' };
    const localPath = save.filePath;
    // 预检可写性(macOS TCC 保护目录):先试写再下载,失败立刻提示换目录
    try {
      const probe = localPath + '.wt';
      fs.writeFileSync(probe, '');
      fs.unlinkSync(probe);
    } catch (err) {
      const hint = (process.platform === 'darwin' && /EPERM|EACCES/i.test(err.message))
        ? '保存位置无写入权限(macOS 系统保护)。请换一个普通文件夹,或在 系统设置→隐私与安全性→完全磁盘访问权限 中授权 Polaris 后重启应用。'
        : `保存位置不可写: ${err.message}`;
      return { ok: false, error: hint };
    }
    const resumeFrom = resolveDownloadResume(sessionId, localPath);
    if (resumeFrom > 0) sftpPartials.remove(ptKey(sessionId, 'd', localPath)); // 这次从偏移续传,旧的记录作废
    const prog = (p) => emitSftpProgress({ op: 'download', ...p });
    const _t0 = Date.now();
    __sftpLog('下载开始', { sessionId, remotePath, localPath, resumeFrom });
    try {
      await sshClient.downloadFile(sftp, remotePath, localPath, (done, total) => prog({ done, total, file: remotePath, fileDone: done, fileTotal: total, filesDone: 0, filesTotal: 1 }), resumeFrom);
      __sftpLog('下载完成', { sessionId, remotePath, ms: Date.now() - _t0 });
      return { ok: true, localPath, resumedFrom: resumeFrom };
    } catch (err) {
      recordDownloadPartial(sessionId, localPath); // 又失败:用最新的真实落盘大小更新中断点
      __sftpLog('下载失败', { sessionId, remotePath, ms: Date.now() - _t0, error: err && err.message });
      return { ok: false, error: err.message };
    }
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// 批量下载(第 6 课·全选下载):只弹一次"选文件夹",统一字节进度。
// entries = [{ remotePath, isDir }] —— 目录会递归下载到本地同名子文件夹,文件按原名保存。
ipcMain.handle('sftp:downloadMany', async (_e, { sessionId, entries }) => {
  const list = (Array.isArray(entries) ? entries : []).filter((e) => e && e.remotePath);
  if (list.length === 0) return { ok: false, error: '没有要下载的内容' };
  try {
    const sftp = await getSftp(sessionId);
    // 测试钩子(POLARIS_AUTO_DL_DIR):自动应答"选文件夹"对话框,不弹原生窗口
    const pick = process.env.POLARIS_AUTO_DL_DIR
      ? { canceled: false, filePaths: [process.env.POLARIS_AUTO_DL_DIR] }
      : await dialog.showOpenDialog(mainWindow, {
          title: `选择把 ${list.length} 个条目保存到哪个文件夹`,
          properties: ['openDirectory'],
        });
    if (pick.canceled || !pick.filePaths[0]) return { ok: false, error: '已取消' };
    const dir = pick.filePaths[0];
    // 预检可写性:macOS 桌面/文稿/下载等受 TCC 保护,未授权时写入会 EPERM。
    // 这里先试写一个临时文件,失败立刻返回明确提示 —— 避免"全部文件下载完才发现失败"。
    try {
      const probe = path.join(dir, `.polaris-wt-${Date.now()}`);
      fs.writeFileSync(probe, '');
      fs.unlinkSync(probe);
    } catch (err) {
      const hint = (process.platform === 'darwin' && /EPERM|EACCES/i.test(err.message))
        ? '保存位置无写入权限(macOS 系统保护)。请换一个普通文件夹(如 ~/sftp),或在 系统设置→隐私与安全性→完全磁盘访问权限 中授权 Polaris 后重启应用。'
        : `保存位置不可写: ${err.message}`;
      return { ok: false, error: hint };
    }
    // 先把目录展开成文件清单,算总字节 → 统一进度
    const plans = [];
    for (const e of list) {
      if (e.isDir) {
        const localTarget = path.join(dir, e.remotePath.split('/').filter(Boolean).pop() || 'dir');
        plans.push(...(await sshClient.walkRemote(sftp, e.remotePath, localTarget)));
      } else {
        plans.push({ rp: e.remotePath, lp: path.join(dir, path.basename(e.remotePath)), size: 0 });
      }
    }
    const total = plans.reduce((s, p) => s + (p.size || 0), 0);
    const prog = (p) => emitSftpProgress({ op: 'download', ...p });
    let done = 0, finished = 0;
    // 并发下载:一次多个文件同时传;done 各 worker 增量累加(单线程无竞争),filesDone 取已完成的文件数
    const results = await sshClient.mapConcurrent(plans, sshClient.SFTP_CONCURRENCY, async (p) => {
      const resumeFrom = resolveDownloadResume(sessionId, p.lp);
      if (resumeFrom > 0) sftpPartials.remove(ptKey(sessionId, 'd', p.lp));
      let fDone = resumeFrom; // 续传时首块增量只算新写的部分,避免把续传字节重复计入累计
      try {
        fs.mkdirSync(path.dirname(p.lp), { recursive: true });
        await sshClient.downloadFile(sftp, p.rp, p.lp, (d, total) => { done += (d - fDone); fDone = d; prog({ done, total, file: p.rp, fileDone: d, fileTotal: total, filesDone: finished, filesTotal: plans.length }); }, resumeFrom);
        return { ok: true, remotePath: p.rp, localPath: p.lp };
      } catch (err) {
        recordDownloadPartial(sessionId, p.lp); // 又失败:更新本地中断点
        return { ok: false, remotePath: p.rp, error: err.message };
      } finally {
        finished++;
      }
    });
    return { ok: true, dir, results };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ---------- 窗口 ----------
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,   // 工具栏真实内容宽 817px(实测,spacer 会被压到 0);1000 = 单行紧凑间距(~8px) + Windows 字体/边框余量,1920×1080 完全放得下
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'Polaris',
    backgroundColor: '#1e1f22',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true, // 堡垒机内置浏览器(webview)需要
    },
  });

  // 正式版:带 ?boot=1 触发主窗口的科幻开机过场(解锁后"打开的瞬间");dev/测试不播,避免干扰
  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'),
    DEV_MODE ? undefined : { query: { boot: '1' } });

  // Windows: 打开主窗口时显式显示原生菜单栏(文件/编辑/…)。锁定流程会 setMenuBarVisibility(false),
  // 若此前锁定后退出/重建窗口,这里强制恢复,保证"打开应用就有菜单栏"。
  mainWindow.setMenuBarVisibility(true);

  // 渲染进程的报错/日志:转发 stdout + 全部级别落盘 app 日志(不只 error,方便完整排查)
  mainWindow.webContents.on('console-message', (evt, levelOrMsg, msgOrLine) => {
    // Electron 27+ 事件对象形式(evt.message / evt.level);旧版是位置参数
    const message = evt && typeof evt === 'object' && 'message' in evt ? evt.message : msgOrLine;
    const level = evt && typeof evt === 'object' && 'level' in evt ? evt.level : levelOrMsg;
    if (message) {
      console.log('[RENDERER]', message); // 控制台 + 落盘(main hook 已写)
      appLog.log('renderer', message); // 显式落盘(含非 log 级别)
    }
    // 兼容旧 error.log 记录(error 级别仍写,供只读 error.log 的场景)
    if ((level === 'error' || level === 3) && message) {
      try {
        const dir = appLock.lockDir();
        fs.mkdirSync(dir, { recursive: true });
        fs.appendFileSync(path.join(dir, 'error.log'), `[${new Date().toISOString()}] ${message}\n`);
      } catch { /* ignore */ }
    }
  });
  // 全量日志 IPC:渲染层 dlog(调试日志)批量转发落盘 + 下载日志导出
  ipcMain.handle('app:log-dump', () => {
    try { return { ok: true, content: appLog.dumpLogs() }; } catch (e) { return { ok: false, error: e.message }; }
  });
  ipcMain.on('app:log-dlog', (_e, lines) => {
    if (Array.isArray(lines)) appLog.pushDlogLines(lines);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    for (const [, s] of sshSessions) {
      try { s.stream.end(); } catch { /* ignore */ }
      try { s.conn.end(); } catch { /* ignore */ }
    }
    sshSessions.clear();
  });
}

// ---------- 应用菜单栏(参考 Netcatty/原生桌面习惯) ----------
function buildMenu() {
  const isMac = process.platform === 'darwin';
  const send = (channel) => () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel);
  };
  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about', label: '关于 Polaris' },
        { type: 'separator' },
        { label: '设置…', accelerator: 'Cmd+,', click: send('menu:settings') }, // macOS 惯例:偏好设置放 App 菜单
        { type: 'separator' },
        { role: 'hide', label: '隐藏' }, { role: 'hideOthers', label: '隐藏其他' }, { role: 'unhide', label: '全部显示' },
        { type: 'separator' },
        { role: 'quit', label: '退出 Polaris' },
      ],
    }] : []),
    {
      label: '文件',
      submenu: [
        { label: '连接选中会话', accelerator: 'CmdOrCtrl+Enter', click: send('menu:connect') },
        { label: '断开当前终端', click: send('menu:disconnect') },
        { type: 'separator' },
        { label: '新建会话', accelerator: 'CmdOrCtrl+N', click: send('menu:new-session') },
        { label: '新建分组…', click: send('menu:new-group') },
        { label: '导入主机…', click: send('menu:import') },
        { label: '导出会话…', click: send('menu:export') },
        { type: 'separator' },
        { label: '锁定', accelerator: 'CmdOrCtrl+L', click: send('menu:lock') },
        { type: 'separator' },
        isMac ? { role: 'close', label: '关闭窗口' } : { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' }, { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' }, { role: 'paste', label: '粘贴' }, { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '查看',
      submenu: [
        { label: '折叠/展开会话列表', accelerator: 'CmdOrCtrl+Shift+P', click: send('menu:toggle-panel') },
        { type: 'separator' },
        { label: '垂直分屏', click: send('menu:split-v') },
        { label: '横向分屏', click: send('menu:split-h') },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '切换全屏' },
      ],
    },
    {
      label: '工具',
      submenu: [
        { label: 'SFTP 文件面板', click: send('menu:sftp') },
        { label: 'SSH 隧道…', click: send('menu:tunnel') },
        { type: 'separator' },
        { label: '批量执行', click: send('menu:batch') },
        { label: '快速命令…', click: send('menu:quick') },
        { label: '命令记录', click: send('menu:cmd') },
        { type: 'separator' },
        { label: '录制当前会话', click: send('menu:record-toggle') },
        { label: '回放列表…', click: send('menu:record-list') },
        { type: 'separator' },
        { label: '打开会话日志目录', click: send('menu:log-open') },
        { type: 'separator' },
        { label: 'AI 运维助手', click: send('menu:ai') },
        { type: 'separator' },
        { label: 'JumpServer 资产…', click: send('menu:jms') },
        // Xshell 惯例:设置(选项)放工具菜单;macOS 仍放 App 菜单(系统惯例)
        ...(isMac ? [] : [{ type: 'separator' }, { label: '设置…', accelerator: 'Ctrl+,', click: send('menu:settings') }]),
      ],
    },
    { role: 'windowMenu', label: '窗口' },
    {
      label: '帮助',
      submenu: [
        { label: '关于 Polaris', click: send('menu:about') },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// 启动时把旧明文密码迁移成加密(safeStorage)
function migratePasswords() {
  try {
    for (const s of sessionStore.list()) {
      if (s.password && !crypto.isEncrypted(s.password)) {
        // groupId: s.group_id —— DB 行的分组字段叫 group_id,
        // update 内部只看 groupId/group,不显式传会把会话挪去"默认分组"
        sessionStore.update(s.id, { ...s, groupId: s.group_id, password: crypto.encrypt(s.password) });
      }
    }
  } catch (err) {
    console.warn('[MAIN] 密码迁移失败:', err.message);
  }
}

// 改名(jms-terminal → polaris)后,把旧目录的 localStorage 迁到固定目录,恢复设置/AI配置
function migrateUserData() {
  if (POLARIS_DATA_DIR) return; // 便携版数据自包含,不迁本机旧设置
  try {
    const appData = app.getPath('appData');
    const newDir = app.getPath('userData');
    const newLS = path.join(newDir, 'Local Storage');
    // 新目录若已有真实数据(不止 1 个数据文件)就不覆盖
    const hasData = fs.existsSync(newLS) && fs.readdirSync(newLS).filter((f) => f.endsWith('.log') || f.endsWith('.ldb')).length > 1;
    if (hasData) return;
    for (const oldName of ['jms-terminal', 'polaris-terminal']) {
      const oldLS = path.join(appData, oldName, 'Local Storage');
      if (fs.existsSync(oldLS)) {
        fs.mkdirSync(path.dirname(newLS), { recursive: true });
        fs.cpSync(oldLS, newLS, { recursive: true, force: true });
        console.log(`[MAIN] 已从 ${oldName} 迁移 localStorage(设置/AI 配置恢复)`);
        return;
      }
    }
  } catch (err) {
    console.warn('[MAIN] 迁移设置失败:', err.message);
  }
}

// ---------- 启动 ----------
// ---- App 密码锁:首次设密码,之后输入密码才能打开;库文件整库加密 ----
ipcMain.handle('lock:has', () => ({ ok: true, has: appLock.hasPassword() }));
// 锁定/解锁时切换原生菜单栏(Windows 上菜单栏是原生 OS 层,覆盖层盖不住)。
// 只用 setMenuBarVisibility(false) 不够:按 Alt 菜单栏会临时弹出。
// 锁定 → 彻底移除应用菜单(Menu.setApplicationMenu(null),Alt 也弹不出);解锁 → 重建。
ipcMain.handle('lock:menu', (_e, visible) => {
  try {
    if (visible) {
      buildMenu();
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setMenuBarVisibility(true);
    } else {
      Menu.setApplicationMenu(null);
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setMenuBarVisibility(false);
    }
    return { ok: true };
  } catch (err) { return { ok: false, error: err.message }; }
});
// 查询应用菜单是否被移除(锁定后应为 null)。供测试断言"锁定后无菜单栏"。
ipcMain.handle('lock:menuState', () => ({ ok: true, removed: Menu.getApplicationMenu() === null }));
// 临时锁定/解锁时缩放主窗口:锁定收成小卡片(美观),解锁恢复原尺寸/最大化/全屏
let lockResizeSaved = null, lockWasMaximized = false, lockWasFullscreen = false;
ipcMain.handle('lock:resize', (_e, shrink) => {
  try {
    if (!mainWindow || mainWindow.isDestroyed()) return { ok: false, error: '无主窗口' };
    if (shrink) {
      if (!lockResizeSaved) {
        lockResizeSaved = mainWindow.getBounds();
        lockWasMaximized = mainWindow.isMaximized();
        lockWasFullscreen = mainWindow.isFullScreen();
      }
      if (mainWindow.isMaximized()) mainWindow.unmaximize();
      if (mainWindow.isFullScreen()) mainWindow.setFullScreen(false);
      mainWindow.setMinimumSize(360, 380); // 临时放开默认最小尺寸(900x600),允许收成小卡片
      mainWindow.setSize(400, 430);
      mainWindow.center();
    } else {
      mainWindow.setMinimumSize(900, 600);
      if (lockResizeSaved) {
        mainWindow.setBounds(lockResizeSaved);
        lockResizeSaved = null;
        if (lockWasMaximized) mainWindow.maximize();
        if (lockWasFullscreen) mainWindow.setFullScreen(true);
        lockWasMaximized = false; lockWasFullscreen = false;
      }
    }
    return { ok: true };
  } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('lock:setup', (_e, password) => {
  try {
    // 最小密码长度:整库加密密钥由密码 PBKDF2 派生,1 字符密码 = 密钥可被秒级爆破拖垮
    if (!password || String(password).length < 8) return { ok: false, error: 'App 密码至少 8 位' };
    appLock.setPassword(password);
    return { ok: true };
  }
  catch (err) { return { ok: false, error: err.message }; }
});
// 校验密码(带防暴力破解:连续失败锁定/递增延时)
ipcMain.handle('lock:verify', (_e, password) => {
  try {
    const r = appLock.verifyWithLock(password);
    return { ok: r.ok, locked: r.locked, remainingSec: r.remainingSec, attemptsLeft: r.attemptsLeft, error: r.locked ? `锁定中,请 ${r.remainingSec} 秒后再试` : undefined };
  } catch (err) { return { ok: false, error: err.message }; }
});
// 当前锁定状态(锁屏页加载时展示倒计时/剩余次数)
ipcMain.handle('lock:status', () => {
  try {
    const s = appLock.status();
    return { ok: true, locked: s.locked, remainingSec: s.remainingSec, attemptsLeft: s.attemptsLeft };
  } catch (err) { return { ok: false, error: err.message }; }
});
// 修改密码:校验旧密码 → 更新 app.lock 哈希 → 用新密码重新加密整个数据库(data.bin)
ipcMain.handle('lock:change', (_e, { current, next }) => {
  try {
    if (!appLock.hasPassword()) return { ok: false, error: '尚未设置密码' };
    if (!appLock.verifyPassword(current)) return { ok: false, error: '当前密码不正确' };
    if (!next || String(next).length < 4) return { ok: false, error: '新密码至少 4 位' };
    appLock.updatePassword(next); // 更新锁的密码哈希
    dbPassword = next;            // 数据库用新密码重新加密(密钥由新密码派生)
    persistDb();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
// 密码验证通过后,解锁:解密库 → 建主窗口(启动流程)
// 临时锁定用主窗口内覆盖层(renderer 端验证,不走这里),此通道仅启动解锁用
ipcMain.handle('lock:success', async (_e, password) => {
  try {
    if (appLock.isLocked()) return { ok: false, error: '尝试次数过多,请稍后再试' }; // 防暴力:锁定期间一律拒绝
    // 解锁也走防暴力校验(防绕过锁屏直接调 unlockApp)
    const v0 = appLock.verifyWithLock(password);
    if (!v0.ok) return { ok: false, error: v0.locked ? `锁定中,请 ${v0.remainingSec} 秒后再试` : '密码不正确' };
    await unlockApp(password);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

function openLockWindow() {
  const has = appLock.hasPassword();
  lockWindow = new BrowserWindow({
    width: 400,
    height: has ? 374 : 437, // 居中卡片 364x338(已设密码)/364x401(加"确认密码"行),四周留白 18px
    resizable: false,
    title: 'Polaris · 解锁',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
    },
  });
  lockWindow.on('closed', () => { lockWindow = null; });
  // 锁屏期间不显示应用菜单栏(文件/编辑/…),未输密码时不暴露菜单内容。
  // 仅移除菜单而不动窗口标题栏;解锁进主界面后 unlockApp() 会重新 buildMenu() 恢复。
  Menu.setApplicationMenu(null);
  lockWindow.setMenuBarVisibility(false);
  lockWindow.loadFile(path.join(__dirname, 'src', 'lock.html'));
}

// 用密码解密数据库并进入主界面(首次会迁移现有明文库)
async function unlockApp(password) {
  const dataPath = path.join(appLock.lockDir(), 'data.bin');
  const oldDb = path.join(appLock.lockDir(), 'sessions.db');
  let bytes = null;
  if (fs.existsSync(dataPath)) {
    bytes = dbCrypto.decryptBytes(fs.readFileSync(dataPath), password); // 密码错会抛错
  } else if (fs.existsSync(oldDb)) {
    bytes = fs.readFileSync(oldDb); // 首次启用加密:迁移现有明文库
    console.log('[MAIN] 首次启用加密,迁移现有数据库');
  }
  dbPassword = password;
  sessionStore = createStore(bytes ? Buffer.from(bytes) : null);
  migratePasswords(); // 老明文密码 → safeStorage 加密(内存库内)
  persistDb();        // 立即把库写成加密 data.bin
  createWindow();
  buildMenu();        // 解锁进主界面时重建菜单栏(防锁定期间被置空后残留)
  if (lockWindow && !lockWindow.isDestroyed()) { lockWindow.close(); lockWindow = null; }
}

app.whenReady().then(() => {
  // 内置浏览器中文乱码修复:部分堡垒机页面(控制台/模拟页)响应头不带 charset,
  // 浏览器按 HTML 规范默认以 Windows-1252 解码 → UTF-8 中文变乱码(æ¨¡æ‹Ÿ...)。
  // 给"text/html 且未声明 charset"的响应补上 charset=utf-8;
  // 已声明编码(GBK/UTF-8)的页面不受影响。
  try {
    session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
      const hdrs = details.responseHeaders || {};
      const key = Object.keys(hdrs).find((k) => k.toLowerCase() === 'content-type');
      const ct = key && hdrs[key] ? hdrs[key][0] : '';
      if (ct && /^text\/html/i.test(ct) && !/charset=/i.test(ct)) {
        cb({ responseHeaders: { ...hdrs, [key]: [ct + '; charset=utf-8'] } });
        return;
      }
      cb({});
    });
  } catch (e) { console.warn('[MAIN] 响应头 charset 拦截失败(不影响使用):', e.message); }
  buildMenu();
  migrateUserData(); // 改名后把旧目录的设置/AI 配置迁过来
  sftpPartials.prune(); // 加载续传记录 + 裁剪过期中断点(7 天前的丢弃,防磁盘表无限增长)
  if (DEV_MODE) {
    try {
      require('./mock/mock-server').start();
    } catch (err) {
      console.warn('[MAIN] mock 服务器启动失败(可能已在运行):', err.message);
    }
  }
  openLockWindow(); // 先过密码锁,再开主界面
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && sessionStore) createWindow();
});

app.on('before-quit', () => {
  for (const t of tunnels.values()) stopTunnel(t); // 退出前停掉所有隧道(释放本地端口)
  tunnels.clear();
  finalizeAllRecordings(); // 退出前把没停的录制都收尾(否则文件成孤儿)
  finalizeAllSessionLogs(); // 退出前把没关的会话日志收尾(冲刷残留字符)
  persistDb();             // 再确保数据库落盘
  sftpPartials.save();     // 续传记录兜底落盘(正常路径每次变更已同步写盘,这里无害防漏)
  // 退出前清除堡垒机浏览器的登录态/记录(cookie)——用户要求:关闭 app 后清除浏览器记录。
  // 异步执行,不阻塞退出;成功与否都放行。
  try {
    const bastionSession = session.fromPartition('persist:bastion');
    bastionSession.clearStorageData().catch(() => {});
  } catch { /* ignore */ }
  // 收尾全部完成后才关库:close 之后 sessionStore 的所有方法(如 addRecording)都会抛错
  if (sessionStore) { try { sessionStore.close(); } catch { /* ignore */ } }
  sessionStore = null;
});

app.on('window-all-closed', () => {
  // 注意:这里不能 close sessionStore!窗口关闭 → app.quit() → before-quit 里还要
  // finalizeAllRecordings(往 recordings 表写元数据)+ persistDb,提前关库会让这两步
  // 全部静默失败(旧版 bug:窗口关闭路径退出时录制元数据丢失、最后 400ms 数据丢失)。
  persistDb();
  app.quit();
});
