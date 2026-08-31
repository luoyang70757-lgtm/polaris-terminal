'use strict';
/**
 * lib/session-ipc.js — 会话管理 / 导入导出 / 系统探测 IPC
 *
 * 从 main.js 拆出(原 IPC:会话管理区块),依赖 sessionStore(惰性)+ crypto/dbCrypto/
 * ssh-client/connect-opts。packJump/unpackJump 只被本区块使用,一并带入。
 * sessionStore / mainWindow 启动早期不可用 → 用 getter 惰性注入。
 */
const fs = require('fs');
const path = require('path');
const { dialog, ipcMain } = require('electron');
const crypto = require('./crypto');
const dbCrypto = require('./db-crypto');
const sshClient = require('./ssh-client');
const connectOpts = require('./connect-opts');

let getSessionStore = () => null;
let schedulePersist = () => {};
let getMainWindow = () => null;
const store = () => getSessionStore();

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

/** main.js 启动早期调用:注入惰性依赖(sessionStore 解锁后才赋值,mainWindow 建窗后才赋值) */
function register(_ipcMain, deps) {
  if (deps) {
    if (typeof deps.getSessionStore === 'function') getSessionStore = deps.getSessionStore;
    if (typeof deps.schedulePersist === 'function') schedulePersist = deps.schedulePersist;
    if (typeof deps.getMainWindow === 'function') getMainWindow = deps.getMainWindow;
  }
  const H = _ipcMain || ipcMain;

  // 返回给渲染进程时解密(渲染进程连接要用明文);入库时加密
  H.handle('sessions:list', () => {
    try {
      const sessions = store().list().map((x) => ({
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

  H.handle('sessions:create', (_e, s) => {
    try {
      const id = store().create({ ...s, password: crypto.encrypt(s.password), passphrase: crypto.encrypt(s.passphrase), jump: packJump(s.jump) });
      schedulePersist();
      return { ok: true, id };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  H.handle('sessions:update', (_e, id, s) => {
    try {
      store().update(id, { ...s, password: crypto.encrypt(s.password), passphrase: crypto.encrypt(s.passphrase), jump: packJump(s.jump) });
      schedulePersist();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  H.handle('sessions:remove', (_e, id) => {
    try {
      store().remove(id);
      schedulePersist();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  H.handle('sessions:import', (_e, list) => {
    try {
      // 入库前逐条加密密码
      const encrypted = (Array.isArray(list) ? list : []).map((x) => ({
        ...x,
        password: crypto.encrypt(x.password),
        passphrase: crypto.encrypt(x.passphrase),
      }));
      const results = store().importMany(encrypted);
      schedulePersist();
      const okCount = results.filter((r) => r.ok).length;
      return { ok: true, imported: okCount, total: results.length, results };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // 导出会话为"加密备份文件"(保存对话框)。rows: [{name,host,port,username,password,group}]
  // 内容先生成 CSV,再用导出密码 AES-256-GCM 整体加密 → 文件不是明文,客户端工具打不开
  H.handle('sessions:export', async (_e, { rows, password }) => {
    try {
      if (!password || String(password).length < 4) return { ok: false, error: '导出密码至少 4 位' };
      const save = await dialog.showSaveDialog(getMainWindow(), {
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
  H.handle('sessions:importExternal', async (_e, { files }) => {
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
  H.handle('sessions:importBackup', (_e, { buf, password }) => {
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
  H.handle('sessions:detectOs', async (_e, opts) => {
    try {
      const r = await sshClient.execCommand(
        connectOpts.withHostVerify(connectOpts.resolvePrivateKey(opts)),
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
}

module.exports = { register };
