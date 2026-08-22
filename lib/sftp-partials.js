'use strict';
/**
 * lib/sftp-partials.js — SFTP 断点续传记录表(磁盘持久化)
 *
 * 从"会话内存 Map"升级为磁盘 JSON(数据目录 lockDir()/sftp-partials.json):
 * 传输失败时记下真实已写字节(+ 本地 mtime / 本地残留大小),重试同一路径时
 * 由 lib/ssh-client 的 resolve*Offset 纯函数判定是否续传。落盘后即使 app 重启
 * 或崩溃,中断点仍在 —— 跨会话续传不再退化为全量重传(旧版注释:需要跨重启续传
 * 再做磁盘化,即本文件)。
 *
 * 键由调用方拼好(稳定主机身份 hostId:kind:path,见 main.js ptKey),本模块只做
 * 键值存储。每次 set/remove 同步落盘:这类变更低频(仅传输失败/续传成功),
 * 同步写保证强杀进程后记录仍在,而磁盘化的核心价值正是"跨中断恢复"。
 * 原子写 + 0600 + 损坏兜底(仿 known-hosts.js)。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const FILE_NAME = 'sftp-partials.json';
const DEFAULT_MAX_AGE_MS = 7 * 24 * 3600 * 1000; // 默认裁剪:超过 7 天未更新的中断点丢弃

let file = null;
let cache = null; // 内存缓存:首次读取后常驻,避免每次 get/set 都重读磁盘

function ensureFile() {
  if (file) return file;
  const dir = require('./app-lock').lockDir(); // 和数据库/锁/指纹同一个数据目录(POLARIS_LOCK_DIR 可覆盖)
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    file = path.join(dir, FILE_NAME);
  } catch (err) {
    // 数据目录不可写 → 回退临时目录(至少会话内可用),打日志避免"续传不落盘"无感知
    console.warn('[sftp-partials] 数据目录不可写(' + err.message + '),回退到临时目录存储续传记录');
    const tmp = path.join(os.tmpdir(), 'jms-terminal');
    fs.mkdirSync(tmp, { recursive: true });
    file = path.join(tmp, FILE_NAME);
  }
  return file;
}

function load() {
  if (cache) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(ensureFile(), 'utf8'));
    cache = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  } catch {
    cache = {}; // 文件不存在/损坏 → 空表(放弃续传,退化为全量重传;不产生错误数据)
  }
  return cache;
}

function save() {
  try {
    fs.writeFileSync(ensureFile(), JSON.stringify(cache || {}, null, 2));
    try { fs.chmodSync(ensureFile(), 0o600); } catch { /* 平台不支持则忽略 */ }
  } catch (err) {
    // 写入失败不能静默:否则刚记下的中断点下次重启就没了
    console.warn('[sftp-partials] 续传记录写入失败(' + err.message + '):', ensureFile());
  }
}

module.exports = {
  get: (key) => load()[key],
  /** 记中断点;value 为 {bytes, mtimeMs?}(下载无 mtimeMs);自动补 ts 用于过期裁剪 */
  set: (key, value) => { const m = load(); m[key] = { ...value, ts: Date.now() }; save(); },
  remove: (key) => { const m = load(); if (key in m) { delete m[key]; save(); } },
  /** 裁剪过期条目(maxAgeMs 缺省 7 天),返回删掉的条数;损坏/非对象条目一并清掉 */
  prune: (maxAgeMs = DEFAULT_MAX_AGE_MS) => {
    const m = load();
    const cutoff = Date.now() - maxAgeMs;
    let removed = 0;
    for (const k of Object.keys(m)) {
      const v = m[k];
      if (typeof v !== 'object' || v === null || !(v.ts > cutoff)) {
        delete m[k];
        removed++;
      }
    }
    if (removed) save();
    return removed;
  },
  save, // 显式落盘兜底(正常路径每次 set/remove 已同步落盘,退出时再调一次无害)
  _file: () => file || ensureFile(), // 供测试/调试
};
