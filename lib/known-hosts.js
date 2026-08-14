'use strict';
/**
 * known-hosts.js — 信任的主机指纹存储(类似 OpenSSH 的 known_hosts)
 * 保存格式: { "host:port": "SHA256:xxxx" } → JSON 文件
 * 首次连接询问是否信任;已信任则校验一致;不一致则拒绝(防中间人)。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

let file = null;
let cache = null; // 内存缓存:首次读取后常驻,避免每次 get/set 都重读磁盘(性能优化)
function ensureFile() {
  if (file) return file;
  const dir = require('./app-lock').lockDir(); // 和数据库/锁同一个数据目录(支持 POLARIS_LOCK_DIR 覆盖)
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    file = path.join(dir, 'known_hosts.json');
  } catch {
    const tmp = path.join(os.tmpdir(), 'jms-terminal');
    fs.mkdirSync(tmp, { recursive: true });
    file = path.join(tmp, 'known_hosts.json');
  }
  return file;
}

function load() {
  if (cache) return cache; // 内存里已有就直接用
  try {
    cache = JSON.parse(fs.readFileSync(ensureFile(), 'utf8')) || {};
  } catch {
    cache = {}; // 文件不存在/损坏 → 空对象
  }
  return cache;
}
function save() {
  try {
    fs.writeFileSync(ensureFile(), JSON.stringify(cache || {}, null, 2));
    try { fs.chmodSync(ensureFile(), 0o600); } catch { /* 平台不支持则忽略 */ } // 指纹文件只允许当前用户读写
  } catch { /* ignore */ }
}

/** 计算主机密钥的 SHA256 指纹(OpenSSH 风格 SHA256:base64) */
function fingerprint(hostKey) {
  const raw = hostKey && hostKey.raw ? hostKey.raw : hostKey;
  const hash = crypto.createHash('sha256').update(raw).digest();
  return 'SHA256:' + hash.toString('base64').replace(/=+$/, '');
}

module.exports = {
  get: (id) => load()[id],
  set: (id, fp) => { const m = load(); m[id] = fp; save(); },
  remove: (id) => { const m = load(); delete m[id]; save(); },
  fingerprint,
};
