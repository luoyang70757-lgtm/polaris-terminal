'use strict';
/**
 * dangerous.js — 危险命令识别与分级(生产环境手动输入 + AI agent 执行前都过这一关)
 *
 * v2(2026-08-15):从"正则关键词匹配"升级为"命令解析 + 分级":
 *   1. 命令解析器:感知引号/转义,把复合命令(&& || ; | 换行)拆成多个子命令逐段检查
 *      —— 旧版会被 `echo ok; rm -rf /`、`rm  -rf`(双空格)、`r"m" -rf /` 绕过
 *   2. 危险分级:
 *        critical  直接拦(根目录破坏/整盘写/分区格式化/fork 炸弹)
 *        high      必须询问(rm -rf、重启关机、format 等)
 *        medium    可询问(可选,当前规则集暂未启用)
 *      isDangerousCommand(line) 保持旧语义(非 safe 即危险),analyzeCommand 供调用处
 *      展示级别与命中原因。
 */

// ---- 命令解析:感知引号/转义,按 && || ; | 换行 拆分子命令 ----
function splitCommands(line) {
  const parts = [];
  let cur = '';
  let quote = null; // '"' 或 "'"
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null; // 闭合引号
      continue;
    }
    if (ch === '\\') { cur += ch; i++; if (i < line.length) cur += line[i]; continue; } // 转义字符整体保留
    if (ch === '"' || ch === "'") { cur += ch; quote = ch; continue; }
    if (ch === ';' || ch === '\n') { if (cur.trim()) parts.push(cur.trim()); cur = ''; continue; }
    if (ch === '&' || ch === '|') {
      if (cur.trim()) parts.push(cur.trim());
      cur = '';
      // 吃掉第二个 & 或 |(&& || 双字符)
      if (i + 1 < line.length && line[i + 1] === ch) i++;
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

// 去掉引号和转义,还原真实命令词(用于正则匹配:r"m" → rm)
function stripQuotes(s) {
  return s
    .replace(/\\(.)/g, '$1')
    .replace(/"([^"]*)"/g, '$1')
    .replace(/'([^']*)'/g, '$1');
}

/**
 * 危险规则表:level = critical(直接拦) / high(必问) / medium(可问)
 * 注意:所有正则在 stripQuotes 归一化后的命令上匹配,引号/转义绕不过。
 */
const RULES = [
  // ---- critical:根目录破坏 / 整盘写 / 分区格式化 / fork 炸弹 ----
  // 根目录判定要严格:rm 的目标必须是"独立参数 /"(行尾/空白后)、/* 或 --no-preserve-root,
  // 否则 `rm -rf /tmp/x`、`rm /tmp/x.txt` 这种普通路径会被误判为删根
  { level: 'critical', name: '删除根目录', re: /\brm\b[\s\S]*?(\s\/\s*$|\s\/\*\s*|\s--no-preserve-root\b)/i },
  { level: 'critical', name: '整盘写入(dd)', re: /\bdd\s+.*\bof=\/dev\/(sd|nvme|vd|hd)[a-z]+\d*/i },
  { level: 'critical', name: '格式化分区', re: /\bmkfs(\.\w+)?(\s|\b)/i },
  { level: 'critical', name: '分区操作(fdisk/parted)', re: /\b(fdisk|parted|gdisk|sfdisk)\b/i },
  { level: 'critical', name: '写入块设备', re: />\s*\/dev\/(sd|nvme|vd|hd)[a-z]+\d*/i },
  { level: 'critical', name: 'fork 炸弹', re: /:\s*\(\s*\)\s*\{|:\s*\|\s*:/i },

  // ---- high:必须询问(生产环境/AI 审批弹窗) ----
  { level: 'high', name: '递归强制删除(rm -rf)', re: /\brm\s+-[a-zA-Z]*[rf][a-zA-Z]*\b/i },
  { level: 'high', name: '关机/重启', re: /\b(shutdown|reboot|halt|poweroff)\b/i },
  { level: 'high', name: '切换运行级别(init)', re: /\binit\s+[06]\b/i },
  { level: 'high', name: '格式化命令', re: /\bformat\b/i },
];

// 兼容旧导出名(老代码引用 DANGEROUS_CMDS)
const DANGEROUS_CMDS = RULES.map((r) => r.re);

/**
 * 分析一条命令:拆子命令 → 逐段匹配规则 → 汇总最高级别
 * @returns {{ level: 'critical'|'high'|'medium'|'safe', segments: string[], findings: Array<{command, level, name}> }}
 */
function analyzeCommand(line) {
  const segments = splitCommands(String(line || ''));
  const findings = [];
  let worst = 'safe';
  for (const seg of segments) {
    const norm = stripQuotes(seg);
    for (const rule of RULES) {
      if (rule.re.test(norm)) {
        findings.push({ command: seg, level: rule.level, name: rule.name });
        if (rule.level === 'critical') worst = 'critical';
        else if (rule.level === 'high' && worst !== 'critical') worst = 'high';
        else if (rule.level === 'medium' && worst === 'safe') worst = 'medium';
      }
    }
  }
  return { level: worst, segments, findings };
}

/** 兼容旧接口:非 safe 即"危险"(critical/high/medium 都算) */
function isDangerousCommand(line) {
  return analyzeCommand(line).level !== 'safe';
}

module.exports = { DANGEROUS_CMDS, RULES, splitCommands, stripQuotes, analyzeCommand, isDangerousCommand };
