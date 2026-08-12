'use strict';
/**
 * dangerous.js — 危险命令识别(生产环境手动输入 + AI agent 执行前都过这一关)
 * 借鉴 Claude Code / Codex 的"危险操作审批"思路:先识别,再让用户拍板。
 */

const DANGEROUS_CMDS = [
  /rm\s+-[a-zA-Z]*rf[a-zA-Z]*\b/i,   // rm -rf(含 -rfv 等变体)
  /rm\s+-[a-zA-Z]*fr[a-zA-Z]*\b/i,   // rm -fr
  /\bshutdown\b/i, /\breboot\b/i, /\bhalt\b/i, /\bpoweroff\b/i,
  /\binit\s+[06]\b/i, /\bmkfs(\s|\b)/i, /\bfdisk\b/i, /\bparted\b/i,
  /\bdd\s+if=.*\bof=\/dev\//i, /\bformat\b/i,
  />\s*\/dev\/(sda|sdb|sdc|nvme)/i, /:\(\)\s*\{/i, /:\|:/i, // 写盘 / fork 炸弹
];

function isDangerousCommand(line) {
  return DANGEROUS_CMDS.some((re) => re.test(line));
}

module.exports = { DANGEROUS_CMDS, isDangerousCommand };
