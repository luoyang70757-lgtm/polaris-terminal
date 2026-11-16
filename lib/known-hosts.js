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
const { atomicWriteFileSync } = require('./fs-util');

let file = null;
let cache = null; // 内存缓存:首次读取后常驻,避免每次 get/set 都重读磁盘(性能优化)
function ensureFile() {
  if (file) return file;
  const dir = require('./app-lock').lockDir(); // 和数据库/锁同一个数据目录(支持 POLARIS_LOCK_DIR 覆盖)
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    file = path.join(dir, 'known_hosts.json');
  } catch (err) {
    // 数据目录不可写时回退到临时目录,但要打日志 —— 否则"信任永远不落盘"会表现为每次连接都弹窗
    console.warn('[known-hosts] 数据目录不可写(' + err.message + '),回退到临时目录存储指纹');
    file = path.join(secureTmpDir(), 'known_hosts.json');
  }
  return file;
}

// 回退临时目录必须是 0700 且属于当前用户,否则同机其他用户可预置 known_hosts.json
// (写入自己的指纹 → 首次连接不弹窗直接接受中间人),或把它做成符号链接让 App 覆盖任意文件。
function secureTmpDir() {
  const tmp = path.join(os.tmpdir(), 'jms-terminal');
  fs.mkdirSync(tmp, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(tmp);
  if (!st.isDirectory()) throw new Error('临时存储路径不是目录');
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new Error('临时存储目录属主异常');
  try { fs.chmodSync(tmp, 0o700); } catch { /* 平台不支持则忽略 */ }
  return tmp;
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
    // 原子写(tmp + rename,Windows 杀软占用时退避重试):直接覆盖时崩溃/断电留下半截 JSON,
    // load() 会当作损坏清空 → 所有已信任指纹丢失(之后每次连接都要重新信任,
    // autoTrust 场景还会给中间人可乘之机)。文件权限 0600。
    atomicWriteFileSync(ensureFile(), JSON.stringify(cache || {}, null, 2), { mode: 0o600 });
    return true;
  } catch (err) {
    // 写入失败不能静默:否则刚点的"信任并连接"下次连接又弹。
    // 注意不要在这里再调 ensureFile():它可能正是失败原因(临时目录不安全),二次抛错会逃出 save()
    console.warn('[known-hosts] 指纹写入失败(' + err.message + '),信任可能不生效:', file || '(未初始化)');
    return false;
  }
}

/** 指纹文件路径(报错时告诉用户去检查哪个目录/文件) */
function location() {
  try { return ensureFile(); } catch { return file || ''; }
}

/** 计算主机密钥的 SHA256 指纹(OpenSSH 风格 SHA256:base64) */
function fingerprint(hostKey) {
  const raw = hostKey && hostKey.raw ? hostKey.raw : hostKey;
  const hash = crypto.createHash('sha256').update(raw).digest();
  return 'SHA256:' + hash.toString('base64').replace(/=+$/, '');
}

module.exports = {
  get: (id) => load()[id],
  // set 返回是否**真的落盘**:调用方(connect-opts)据此告知用户"指纹保存失败,下次仍会询问",
  // 否则该问题只表现为"每次连接都弹信任框",用户/开发都无从定位。
  set: (id, fp) => {
    const m = load();
    m[id] = fp;
    if (!save()) return false;
    // 回读校验:写完立刻读盘确认该条目存在(防数据目录被回退/被外部清理/写到了别的文件)
    try {
      const onDisk = JSON.parse(fs.readFileSync(ensureFile(), 'utf8'));
      return !!(onDisk && onDisk[id] === fp);
    } catch { return false; }
  },
  remove: (id) => { const m = load(); delete m[id]; save(); },
  location,
  fingerprint,
};
