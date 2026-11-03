'use strict';
/**
 * lib/ssh-config.js — 解析 OpenSSH ~/.ssh/config
 *
 * 纯函数,无 electron 依赖,便于单测(verify-ssh-config.js)。
 * 支持:Host 段(空格分隔多个 pattern)、HostName/User/Port/IdentityFile、
 *       "#" 注释(行首或空白后)、"Keyword = value" 与 "Keyword value" 两种写法;
 *       仅 Host * 视为全局默认(不生成会话);其它含通配符的 Host 段(如 *.prod)
 *       跳过不导入,避免其 User/IdentityFile 泄漏到不相关主机;Match 段跳过。
 * 输出行结构与会话导入管线一致:{ name, host, port, username, password, group, privateKey? }
 */
const os = require('os');
const path = require('path');

function defaultSshConfigPath() {
  return path.join(os.homedir(), '.ssh', 'config');
}

function parseSshConfig(text) {
  const lines = [];
  for (const rawLn of String(text).split(/\r?\n/)) {
    let s = rawLn;
    const hash = s.search(/(^|\s)#/); // OpenSSH:# 前是行首或空白才是注释
    if (hash >= 0) s = s.slice(0, hash);
    s = s.trim();
    if (s) lines.push(s);
  }

  // 每行拆成 [keyword, value]:先试 "Keyword = value",再试 "Keyword value"
  const blocks = []; // { kind:'default'|'host'|'match', patterns:[], dirs:[[k,v]] }
  let cur = null;
  for (const line of lines) {
    let kw, val;
    let m = line.match(/^([A-Za-z][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m) { kw = m[1].toLowerCase(); val = m[2].trim(); }
    else {
      m = line.match(/^([A-Za-z][A-Za-z0-9_]*)\s+(.*)$/);
      if (m) { kw = m[1].toLowerCase(); val = m[2].trim(); }
      else { kw = line.toLowerCase(); val = ''; }
    }
    if (kw === 'host' || kw === 'match') {
      const pats = val.split(/\s+/).filter(Boolean);
      if (kw === 'match') {
        cur = { kind: 'match', patterns: pats, dirs: [] };
      } else {
        const isDefault = pats.length > 0 && pats.every((p) => p === '*'); // 仅 Host * 作全局默认
        const hasConcrete = pats.some((p) => p && !p.startsWith('!') && !/[*?]/.test(p));
        // 纯通配(非 *)的 Host 段(如 *.prod):既不导入也不作默认 → 归为 match 一起跳过
        cur = { kind: isDefault ? 'default' : (hasConcrete ? 'host' : 'match'), patterns: pats, dirs: [] };
      }
      blocks.push(cur);
    } else {
      if (!cur) { cur = { kind: 'default', patterns: [], dirs: [] }; blocks.push(cur); }
      cur.dirs.push([kw, val]);
    }
  }

  const rows = [];
  const defaults = {}; // 运行中的默认值(keyword → value);default 块出现得越晚,默认越新
  for (const b of blocks) {
    if (b.kind === 'match') continue;
    if (b.kind === 'default') {
      for (const [k, v] of b.dirs) if (v !== '') defaults[k] = v;
      continue;
    }
    const merged = { ...defaults };
    for (const [k, v] of b.dirs) merged[k] = v;
    for (const pat of b.patterns) {
      if (!pat || pat.startsWith('!') || /[*?]/.test(pat)) continue;
      const host = merged.hostname || pat;
      let identityFile = merged.identityfile || '';
      if (identityFile.startsWith('~')) identityFile = path.join(os.homedir(), identityFile.slice(2));
      rows.push({
        name: pat,
        host,
        port: parseInt(merged.port || '22', 10) || 22,
        username: merged.user || '',
        password: '',
        group: '默认分组',
        ...(identityFile ? { privateKey: identityFile } : {}),
      });
    }
  }
  return rows;
}

module.exports = { parseSshConfig, defaultSshConfigPath };