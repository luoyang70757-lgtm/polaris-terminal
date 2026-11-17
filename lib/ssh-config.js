'use strict';
/**
 * lib/ssh-config.js — 解析 OpenSSH ~/.ssh/config
 *
 * 纯函数,无 electron 依赖,便于单测(verify-ssh-config.js)。
 * 支持:Host 段(空格分隔多个 pattern)、HostName/User/Port/IdentityFile、
 *       "#" 注释(行首或空白后)、"Keyword = value" 与 "Keyword value" 两种写法;
 *       仅 Host * 视为全局默认(不生成会话);其它含通配符的 Host 段(如 *.prod)
 *       跳过不导入,避免其 User/IdentityFile 泄漏到不相关主机;Match 段跳过。
 * 输出行结构与会话导入管线一致:{ name, host, port, username, password, group, privateKey?, jump?, warn? }
 *
 * ProxyJump / ProxyCommand(v1.0.29):把跳板机解析成会话的 jump 字段,导入后直接可用,
 *   不必再手工去会话弹窗里填一遍。只支持**单跳**(多跳 A→B→C 会给出 warn 并照常导入主机,
 *   不会静默丢跳板信息);写法认不出来的也走 warn,提示用户手动补。
 */
const os = require('os');
const path = require('path');

// 主目录解析:Windows 上 os.homedir() 不认 HOME(只认 USERPROFILE),回归脚本注入假 HOME 会失效,
// 所以留一个显式覆盖入口(~ 展开与默认 config 路径统一跟它走)
function homeDir() {
  const o = process.env.POLARIS_SSH_HOME;
  return o ? String(o) : os.homedir();
}

function defaultSshConfigPath() {
  return path.join(homeDir(), '.ssh', 'config');
}

// ---- ProxyJump / ProxyCommand → 跳板机 -------------------------------------------------
// ProxyJump: [user@]host[:port] / ssh://user@host:port / none;多跳(逗号分隔)不支持
function parseProxyJump(val) {
  const s = String(val || '').trim().replace(/^["']|["']$/g, '');
  if (!s || /^none$/i.test(s)) return null;
  if (s.includes(',')) return { error: '多跳跳板机(A→B→C)暂不支持' };
  const uri = /^ssh:\/\/(?:([^@\/]+)@)?([^:\/]+)(?::(\d+))?\/?$/i.exec(s);
  if (uri) return { host: uri[2], port: parseInt(uri[3] || '22', 10) || 22, username: uri[1] || '' };
  const m = /^(?:([^@\s]+)@)?([^:@\s]+)(?::(\d+))?$/.exec(s);
  if (!m) return { error: 'ProxyJump 写法无法识别: ' + s };
  return { host: m[2], port: parseInt(m[3] || '22', 10) || 22, username: m[1] || '' };
}

// ProxyCommand:只有 ssh / nc(netcat) 两种常见写法能推出来;%h/%p 是目标占位符,推不出跳板机
function parseProxyCommand(val) {
  const s = String(val || '').trim().replace(/^["']|["']$/g, '');
  if (!s || /^none$/i.test(s)) return null;
  const toks = s.match(/"[^"]*"|'[^']*'|\S+/g) || [];
  const unq = (t) => String(t || '').replace(/^["']|["']$/g, '');
  const base = unq(toks[0] || '').toLowerCase().split(/[\/]/).pop();
  if (base === 'nc' || base === 'netcat' || base === 'ncat') {
    const host = unq(toks[1] || '');
    if (!host || /%[hp]/i.test(host)) return { error: 'ProxyCommand 里是 %h/%p 展开,无法推断跳板机' };
    return { host, port: parseInt(unq(toks[2] || ''), 10) || 22, username: '' };
  }
  if (!/^(ssh|ssh\.exe)$/.test(base)) return { error: 'ProxyCommand 不是 ssh/nc(暂不支持该写法)' };
  let jumpTok = '', portArg = '', skipNext = false;
  for (let i = 1; i < toks.length; i++) {
    const t = unq(toks[i]);
    if (skipNext) { skipNext = false; continue; }
    if (t === '-p') { portArg = unq(toks[i + 1] || ''); skipNext = true; continue; }
    if (t === '-W' || t === '-o' || t === '-l' || t === '-i' || t === '-F') { skipNext = true; continue; }
    if (t.startsWith('-')) continue;
    if (!jumpTok) { if (/%[hp]/i.test(t)) return { error: 'ProxyCommand 的目标是 %h/%p 展开,无法推断跳板机' }; jumpTok = t; }
  }
  if (!jumpTok) return { error: 'ProxyCommand 里找不到跳板机主机' };
  const m = /^(?:([^@]+)@)?([^:]+)(?::(\d+))?$/.exec(jumpTok);
  if (!m) return { error: 'ProxyCommand 跳板机写法无法识别: ' + jumpTok };
  return { host: m[2], port: parseInt(m[3] || portArg || '22', 10) || 22, username: m[1] || '' };
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
      if (identityFile.startsWith('~')) identityFile = path.join(homeDir(), identityFile.slice(2));
      // 跳板机:ProxyJump 优先,没有才看 ProxyCommand(与 OpenSSH 一致)
      // 推不出来时**不算错误**:照常导入主机,只带一条 warn 让用户知道要手动补跳板
      const pj = merged.proxyjump || '';
      const pc = merged.proxycommand || '';
      let jump = null, warn = '';
      if (String(pj).trim() && !/^none$/i.test(String(pj).trim())) jump = parseProxyJump(pj);
      else if (String(pc).trim() && !/^none$/i.test(String(pc).trim())) jump = parseProxyCommand(pc);
      if (jump && jump.error) { warn = '跳板机未导入(' + jump.error + '),连接前请手动填写'; jump = null; }
      rows.push({
        name: pat,
        host,
        port: parseInt(merged.port || '22', 10) || 22,
        username: merged.user || '',
        password: '',
        group: '默认分组',
        ...(identityFile ? { privateKey: identityFile } : {}),
        ...(jump ? { jump: { host: jump.host, port: jump.port || 22, username: jump.username || '', password: '' } } : {}),
        ...(warn ? { warn } : {}),
      });
    }
  }
  return rows;
}

module.exports = { parseSshConfig, defaultSshConfigPath, parseProxyJump, parseProxyCommand };