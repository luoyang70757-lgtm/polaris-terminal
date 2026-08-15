'use strict';
/**
 * recommend.js — 智能命令推荐(参考 Chaterm 的"智能命令推荐"思路,本地化实现)
 *
 * 两条来源合并:
 *   1. 历史高频:同主机执行过的命令按出现次数排序(用户习惯)
 *   2. 常用运维命令库:内置一份常用诊断/运维命令(与历史去重后补齐)
 *
 * 纯函数设计,方便单测;主进程 IPC 只做"取历史 → 调 recommend()"两件事。
 */

// 内置常用运维命令库(命令 + 一句话说明,展示在推荐面板)
const COMMON_OPS_COMMANDS = [
  { command: 'df -h', desc: '磁盘空间' },
  { command: 'free -m', desc: '内存占用' },
  { command: 'uptime', desc: '负载与运行时间' },
  { command: 'ps aux --sort=-%mem | head -15', desc: '内存占用 Top 进程' },
  { command: 'top -bn1 | head -25', desc: 'CPU/负载一览(非交互)' },
  { command: 'ss -tlnp', desc: '监听端口' },
  { command: 'journalctl -xe --no-pager | tail -50', desc: '最近系统日志' },
  { command: 'dmesg -T | tail -20', desc: '内核日志' },
  { command: 'tail -f /var/log/syslog', desc: '实时跟踪系统日志' },
  { command: 'systemctl list-units --type=service --state=running', desc: '运行中服务' },
  { command: 'docker ps', desc: '运行中容器' },
  { command: 'docker logs --tail 100 <容器>', desc: '容器日志' },
  { command: 'du -sh * 2>/dev/null | sort -rh | head -15', desc: '目录占用排行' },
  { command: 'ls -lht', desc: '按时间列出文件' },
  { command: 'uname -a', desc: '系统内核信息' },
  { command: 'cat /etc/os-release', desc: '发行版信息' },
  { command: 'who', desc: '在线用户' },
  { command: 'vmstat 1 5', desc: '系统状态采样' },
  { command: 'iostat -x 1 3', desc: '磁盘 IO 采样' },
];

// 噪音过滤:太短的、纯符号的、控制序列残留(^C/^D 等)的命令不推荐
function isNoise(cmd) {
  const c = String(cmd || '').trim();
  if (c.length < 2) return true;
  if (!/[a-zA-Z0-9]/.test(c)) return true;
  if (/^[\^]/.test(c)) return true;          // ^C / ^D 等 Ctrl 组合残留
  if (/[\x00-\x1f\x7f]/.test(c)) return true; // 控制字符
  return false;
}

/**
 * 合并推荐
 * @param {Array} historyRows — [{ host, command, created_at }](已按主机过滤或全量)
 * @param {object} opts — { host, limit }
 * @returns [{ command, source:'history'|'common', count, lastTs, desc }]
 *   历史来源带 count(次数)/lastTs(最近使用时间);常用库来源带 desc。
 */
function recommend(historyRows, opts = {}) {
  const limit = opts.limit || 12;
  const host = opts.host;
  // 1) 按命令统计频率(只统计指定主机;host 为空则全量)
  const freq = new Map(); // command -> { count, lastTs }
  for (const r of historyRows || []) {
    if (host && r.host !== host) continue;
    const cmd = String(r.command || '').trim();
    if (!cmd || isNoise(cmd)) continue;
    const f = freq.get(cmd) || { count: 0, lastTs: 0 };
    f.count++;
    const ts = new Date(r.created_at || 0).getTime() || 0;
    if (ts > f.lastTs) f.lastTs = ts;
    freq.set(cmd, f);
  }
  const fromHistory = [...freq.entries()]
    .map(([command, f]) => ({ command, source: 'history', count: f.count, lastTs: f.lastTs, desc: '' }))
    .sort((a, b) => b.count - a.count || b.lastTs - a.lastTs);
  // 2) 常用命令库补齐(与历史去重)
  const seen = new Set(fromHistory.map((x) => x.command));
  const fromCommon = COMMON_OPS_COMMANDS
    .filter((x) => !seen.has(x.command))
    .map((x) => ({ command: x.command, source: 'common', count: 0, lastTs: 0, desc: x.desc }));
  // 3) 合并:历史优先,常用库补齐,总数不超 limit
  return [...fromHistory, ...fromCommon].slice(0, limit);
}

module.exports = { recommend, COMMON_OPS_COMMANDS, isNoise };
