'use strict';
/**
 * local-name.js — 远程文件名 → 本地安全文件名(Windows 优先)
 *
 * 远程文件系统(Linux/H3C 等)允许 `: * ? " < > |` 等在 Windows 上非法的字符,
 * 也允许结尾带点/空格、或恰好叫 CON/PRN/AUX/NUL/COM1…/LPT1…(Windows 保留设备名)。
 * 直接拿远程名做本地文件名,在 Windows 上会写失败(EINVAL)或写到控制台设备,
 * 甚至因 `..`/分隔符写出保存目录。这里统一转成 Windows 可安全使用的名字
 * (在 macOS/Linux 上同样适用,只是略保守)。
 */

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i; // 忽略大小写,带扩展名也算
const MAX_LEN = 150; // 给路径其他部分/Windows MAX_PATH 留余量

/**
 * @param {string} name 远程文件名(或路径最后一段)
 * @returns {string} 本地可用的文件名(非空)
 */
function safeLocalName(name) {
  let s = String(name == null ? '' : name);
  // Windows 非法字符 + 控制字符(含 / \ : * ? " < > |)统一替换
  s = s.replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_');
  // Windows 会静默去掉结尾的点和空格("foo." / "foo " 实际写成 "foo")
  s = s.replace(/[. ]+$/g, '');
  if (!s || s === '.' || s === '..') s = 'download';
  if (s.length > MAX_LEN) {
    // 截断但尽量保留扩展名
    const dot = s.lastIndexOf('.');
    if (dot > 0 && s.length - dot <= 20) s = s.slice(0, MAX_LEN - (s.length - dot)) + s.slice(dot);
    else s = s.slice(0, MAX_LEN);
  }
  if (RESERVED.test(s)) s = '_' + s; // CON.txt → _CON.txt
  return s;
}

module.exports = { safeLocalName, isWindowsReservedName: (n) => RESERVED.test(String(n || '')) };
