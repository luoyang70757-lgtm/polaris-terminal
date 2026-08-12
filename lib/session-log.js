'use strict';
/**
 * session-log.js — 会话日志落盘(可读纯文本)
 *
 * 与"录制"(JSONL + 回放)不同,会话日志是事后查看/审计用的纯文本:
 *   - 输出:流式解码(GBK 等编码不乱码)+ 剥离 ANSI 转义序列后追加
 *   - 输入:按行缓冲,命令回车后整行追加(退格可回退修正)
 * 文件放 <数据目录>/session-logs/,命名 = 会话名_时间戳.log
 */

const fs = require('fs');
const path = require('path');
const iconv = require('iconv-lite');
const appLock = require('./app-lock'); // 复用统一数据目录

/** 会话日志目录:<数据目录>/session-logs/ */
function sessionLogsDir() {
  return path.join(appLock.lockDir(), 'session-logs');
}

/** 生成日志文件名:会话名_时间戳.log(清理非法字符,截断过长名字) */
function newLogName(sessionName) {
  const safe = String(sessionName || 'session').replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 40) || 'session';
  const ts = new Date().toISOString().replace(/[:.]/g, '-'); // 2026-08-05T15-30-00-000Z
  return `${safe}_${ts}.log`;
}

/**
 * ANSI 转义剥离状态机:返回一个逐 chunk 处理"字节串→可读文本"的函数。
 * 状态跨 chunk 保持,ESC 序列被切开(常见于大输出流)也不会漏进日志。
 * 剥掉:ESC[ CSI 序列、ESC] OSC 序列、ESC X 单字符序列;普通文本原样保留。
 */
function makeAnsiStripper() {
  let state = 0; // 0=文本 1=刚见ESC 2=CSI 3=OSC 4=OSC里见ESC(等'\'完成ST)
  return function strip(chunk) {
    let out = '';
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk[i];
      switch (state) {
        case 0:
          if (c === '\x1b') state = 1; else out += c;
          break;
        case 1:
          if (c === '[') state = 2;
          else if (c === ']') state = 3;
          else state = 0; // ESC X 单字符序列(ESC7/8 光标保存等),整段丢弃
          break;
        case 2: // CSI:直到 0x40–0x7E 终结符
          if (c >= '@' && c <= '~') state = 0;
          break;
        case 3: // OSC:直到 BEL(0x07)或 ST(ESC \)
          if (c === '\x07') state = 0;
          else if (c === '\x1b') state = 4;
          break;
        case 4:
          state = c === '\\' ? 0 : 3;
          break;
      }
    }
    return out;
  };
}

/**
 * 输入行缓冲:把逐键/逐块的输入攒成"行",回车时整行写出。
 * 退格(0x7f/0x08)删掉上一字符,控制码(ESC 等)直接丢弃,只记可读命令。
 * @returns {{feed: Function, flush: Function}}
 */
function makeLineBuffer(write) {
  let buf = '';
  return {
    feed(text) {
      for (const ch of String(text)) {
        if (ch === '\r' || ch === '\n') {
          if (buf) write(buf + '\n');
          buf = '';
        } else if (ch === '\x7f' || ch === '\b') {
          buf = buf.slice(0, -1); // 退格
        } else if (ch >= ' ' && ch !== '\x1b') {
          buf += ch;
        }
      }
    },
    flush() {
      if (buf) { write(buf + '\n'); buf = ''; }
    },
  };
}

module.exports = { sessionLogsDir, newLogName, makeAnsiStripper, makeLineBuffer };
