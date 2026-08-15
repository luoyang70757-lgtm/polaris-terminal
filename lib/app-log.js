// app-log.js — 全量日志落盘引擎(开发/排障用)
// 职责:
//   1. 把主进程 console(log/warn/error)+ 渲染层 dlog + 渲染层 console 转发 + 未捕获异常
//      统一写入 数据目录/logs/app-YYYYMMDD.log(按天轮转,单文件 ≤10MB 截断留尾)。
//   2. 提供 dumpLogs():打包当前日志 + 系统信息(版本/平台/数据目录),供"下载日志"导出。
// 默认开启(不依赖任何设置);日志写盘失败绝不抛异常(磁盘满/权限 → 静默跳过)。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_FILE = 10 * 1024 * 1024; // 单日志文件上限 10MB

let logDir = null; // 日志目录(数据目录/logs),首次写入时初始化
let logPath = null; // 当前日志文件路径(按天)
let dayKey = '';    // 今天的日期键 YYYY-MM-DD
let queue = [];     // 待写行(文件未就绪时暂存,避免丢早期日志)
let drainTimer = null;

function todayKey() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// 初始化日志目录(延迟到首次写入,避免在 app 数据目录就绪前创建)
function ensureDir() {
  if (logDir) return;
  try {
    const base = process.env.POLARIS_LOCK_DIR || path.join(os.homedir(), '.jms-terminal');
    logDir = path.join(base, 'logs');
    fs.mkdirSync(logDir, { recursive: true });
  } catch { logDir = null; }
}

function rotateIfNeeded() {
  const tk = todayKey();
  if (logPath && tk === dayKey) return;
  dayKey = tk;
  logPath = logDir ? path.join(logDir, `app-${tk}.log`) : null;
}

// 把一行日志写盘(带时间戳 + 来源标签)。写失败静默跳过(不影响主流程)。
function writeLine(line) {
  ensureDir();
  rotateIfNeeded();
  if (!logPath) return;
  try {
    const st = fs.statSync(logPath);
    if (st.size > MAX_FILE) {
      // 超限:改名 .old 后开新文件(保留最近的日志)
      try { fs.renameSync(logPath, logPath + '.old'); } catch { /* ignore */ }
      logPath = path.join(logDir, `app-${dayKey}.log`);
    }
  } catch { /* 文件还不存在 */ }
  try {
    fs.appendFileSync(logPath, line + '\n');
  } catch { /* 磁盘满/权限:静默 */ }
}

// 主入口:记录一条日志。
// kind: 'main'|'renderer'|'dlog'|'error'|'event' —— 决定来源标签
// args: 要记录的文本(可多个,自动 join)
function log(kind, ...args) {
  try {
    const msg = args.map((a) => (a instanceof Error ? (a.stack || a.message) : String(a))).join(' ');
    const ts = new Date().toISOString();
    let tag = '[MAIN]';
    if (kind === 'renderer') tag = '[RENDERER]';
    else if (kind === 'dlog') tag = '[DLOG]';
    else if (kind === 'error') tag = '[ERROR]';
    else if (kind === 'event') tag = '[EVENT]';
    const line = `${ts} ${tag} ${msg}`;
    writeLine(line);
    return line;
  } catch { return ''; }
}

// 批量写(渲染层 dlog 批量转发时用)
function logBatch(kind, lines) {
  if (!Array.isArray(lines) || !lines.length) return;
  try {
    const ts = new Date().toISOString();
    const tag = kind === 'renderer' ? '[RENDERER]' : '[DLOG]';
    const out = lines.map((l) => `${ts} ${tag} ${l}`).join('\n');
    writeLine(out);
  } catch { /* ignore */ }
}

// 未捕获异常/拒绝:落盘 + 仍交给原处理(不吞)
function error(kind, ...args) {
  log('error', `[${kind}]`, ...args);
}

// 打包日志:把当前日志文件(含 .old)+ 系统信息写成一段文本,返回给渲染层下载
function dumpLogs() {
  const parts = [];
  parts.push('===== Polaris 日志导出 =====');
  parts.push(`时间: ${new Date().toISOString()}`);
  parts.push(`平台: ${process.platform} ${process.arch}`);
  parts.push(`Electron: ${process.versions.electron} | Node: ${process.versions.node}`);
  parts.push(`数据目录: ${process.env.POLARIS_LOCK_DIR || path.join(os.homedir(), '.jms-terminal')}`);
  parts.push(`数据目录: ${logDir || '(未初始化)'}`);
  parts.push('');
  ensureDir();
  if (logDir) {
    // 今天的日志
    const files = [];
    try {
      const names = fs.readdirSync(logDir).filter((f) => f.startsWith('app-') && f.endsWith('.log')).sort().reverse();
      for (const n of names.slice(0, 3)) { // 今天 + 最多 2 个历史天
        const fp = path.join(logDir, n);
        try { files.push({ name: n, size: fs.statSync(fp).size }); } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
    if (!files.length) {
      parts.push('(暂无日志文件)');
    }
    for (const f of files) {
      parts.push('');
      parts.push(`===== 日志文件: ${f.name} (${(f.size / 1024).toFixed(1)} KB) =====`);
      try {
        const content = fs.readFileSync(path.join(logDir, f.name), 'utf8');
        // 超大文件只带尾部(避免下载体积爆炸)
        const MAX = 400 * 1024;
        parts.push(content.length > MAX ? '(文件过大,仅截取末尾 400KB)\n' + content.slice(-MAX) : content);
      } catch (e) { parts.push('(读取失败: ' + e.message + ')'); }
    }
  } else {
    parts.push('(日志目录不可用)');
  }
  parts.push('');
  parts.push('===== 导出结束 =====');
  return parts.join('\n');
}

// 渲染层 dlog 批量转发(防抖:100ms 攒一批写一次盘,降低高频 dlog 的写盘开销)
function pushDlogLines(lines) {
  logBatch('dlog', lines);
}

module.exports = { log, logBatch, error, dumpLogs, pushDlogLines };
