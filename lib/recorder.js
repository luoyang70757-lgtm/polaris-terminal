'use strict';
/**
 * recorder.js — 会话录制与回放的数据层
 *
 * 负责两件事:
 *  1) 录制:把终端"屏幕输出"和"敲过的命令"按时间戳写成 JSONL 文件
 *  2) 回放:把 JSONL 文件读回来,还原成带时间的播放事件列表
 *
 * JSONL 格式(每行一个 JSON 对象,一个事件):
 *   {"t":0,   "k":"o", "d":"<base64 原始字节>"}   ← 输出(kind=output),d 是 base64
 *   {"t":120, "k":"i", "d":"ls -la"}             ← 输入(kind=input),d 是 utf8 文本
 *   t  = 相对录制开始(第 0 毫秒)的时间戳
 *   k  = 事件类型:"o" 输出 / "i" 输入
 *   d  = 数据:输出存 base64 原始字节(保证 GBK 等非 utf8 编码也能原样还原),
 *            输入存可读文本
 *
 * 为什么输出存 base64 而不是直接存文本?
 *   终端数据是"字节流",utf8/gbk/gb2312 编码都可能是字节序列里的一个片段。
 *   存原始字节,回放时再按会话的 encoding 解码,就能 100% 还原当时的画面。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const iconv = require('iconv-lite');
const appLock = require('./app-lock'); // 复用 ~/.jms-terminal 数据目录

/** 录制文件存放目录:~/.jms-terminal/recordings/ */
function recordingsDir() {
  return path.join(appLock.lockDir(), 'recordings');
}

/** 生成一个录制文件名(时间戳+随机数,避免重名) */
function newRecordingName() {
  const ts = new Date().toISOString().replace(/[:.]/g, '-'); // 2026-08-05T15-30-00-000Z
  const rand = Math.random().toString(36).slice(2, 8);        // 6 位随机串
  return `rec-${ts}-${rand}.jsonl`;
}

/** 追加一行"输出"事件到录制文件 */
function writeOutput(filePath, t, chunk) {
  // Buffer.toString('base64') 把任意字节编码成 ASCII 字符串,安全写进 JSON
  const line = JSON.stringify({ t, k: 'o', d: chunk.toString('base64') });
  fs.appendFileSync(filePath, line + '\n');
}

/** 追加一行"输入"事件到录制文件 */
function writeInput(filePath, t, text) {
  // JSON.stringify 会自动转义引号/换行,输入里的特殊字符不会破坏格式
  const line = JSON.stringify({ t, k: 'i', d: String(text) });
  fs.appendFileSync(filePath, line + '\n');
}

/** 录制结束:返回文件大小(字节)。主进程用它 + 起止时间算时长 */
function finishRecording(filePath) {
  const st = fs.statSync(filePath);
  return { size: st.size };
}

/**
 * 读取并解析一个录制文件 → 播放事件数组
 * @returns {Array<{t:number, kind:'o'|'i', data:Buffer|string}>}
 *   kind='o' 时 data 是 Buffer(原始字节,回放时按 encoding 解码)
 *   kind='i' 时 data 是字符串(输入文本)
 */
function parseRecording(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const events = [];
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue; // 跳过空行
    let evt;
    try { evt = JSON.parse(s); } catch { continue; } // 坏行直接跳过,不拖垮整体
    if (evt.k === 'o') {
      events.push({ t: evt.t, kind: 'o', data: Buffer.from(evt.d, 'base64') });
    } else if (evt.k === 'i') {
      events.push({ t: evt.t, kind: 'i', data: evt.d });
    }
  }
  return events;
}

/**
 * 把输出字节按会话编码解码成文本(给回放/渲染用)
 * @param {Buffer} buffer — 原始字节
 * @param {string} encoding — 'utf8' / 'gbk' / 'gb2312'
 */
function decodeOutput(buffer, encoding) {
  const enc = String(encoding || 'utf8').toLowerCase();
  if (enc === 'utf8' || enc === 'utf-8') return buffer.toString('utf8');
  // GBK / GB2312 用 iconv-lite 转成 utf8(直播时主进程也是这么做的)
  try { return iconv.decode(buffer, enc); } catch { return buffer.toString('utf8'); }
}

module.exports = {
  recordingsDir,
  newRecordingName,
  writeOutput,
  writeInput,
  finishRecording,
  parseRecording,
  decodeOutput,
};
