'use strict';
/**
 * lib/sftp-sizes.js — SFTP 上传文件的"真实大小"记录表(磁盘持久化)
 *
 * 从"会话内存 Map"升级为磁盘 JSON(数据目录 lockDir()/sftp-sizes.json):
 * H3C 网络设备等 SFTP 对刚写入的文件 readdir/stat 恒报 size 0(数据其实在 flash 上)。
 * 上传成功后把真实大小记下来,面板列目录读到 0 就用它覆盖显示。落盘后重连/重启
 * app 记录仍在 —— H3C 是主要目标,跨会话后文件夹不再全显示 0(旧版只按 sessionId
 * 记内存、会话一关就丢,重连又显示 0)。
 *
 * 键由调用方拼好(稳定主机身份 hostId|remotePath,见 main.js knownSizeKey),本模块
 * 只做键值存储。每次 set 同步落盘(原子写 + 0600 + 损坏兜底,仿 sftp-partials.js)。
 * 值 { size, ts }:ts 用于过期裁剪(超过 maxAge 的旧记录丢弃,防磁盘表无限增长)。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { atomicWriteFileSync } = require('./fs-util');

const FILE_NAME = 'sftp-sizes.json';
// 30 天:这些是 H3C 设备列表的显示覆盖,flash 上文件常存数月,7 天就剪掉会让"下次再看又变 0";
// 条目极小(每条几字节),30 天足够防无限增长又保长期可用。
const DEFAULT_MAX_AGE_MS = 30 * 24 * 3600 * 1000;

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
    // 数据目录不可写 → 回退临时目录(至少会话内可用),打日志避免"大小记录不落盘"无感知
    console.warn('[sftp-sizes] 数据目录不可写(' + err.message + '),回退到临时目录存储大小记录');
    const tmp = path.join(os.tmpdir(), 'jms-terminal');
    // 共享临时目录必须 0700 且属于当前用户(防其他本地用户预置/符号链接劫持记录文件)
    fs.mkdirSync(tmp, { recursive: true, mode: 0o700 });
    const st = fs.lstatSync(tmp);
    if (!st.isDirectory()) throw new Error('临时存储路径不是目录');
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new Error('临时存储目录属主异常');
    try { fs.chmodSync(tmp, 0o700); } catch { /* ignore */ }
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
    cache = {}; // 文件不存在/损坏 → 空表(放弃覆盖,列表按设备报的 0 显示;不产生错误数据)
  }
  return cache;
}

function save() {
  try {
    // 原子写(tmp + rename,Windows 杀软占用时退避重试):直接覆盖时崩溃/断电会留下半截 JSON,
    // load() 会当作损坏整表清空 → H3C 等设备的上传真实大小记录全部丢失(列表重新显示 0)。
    atomicWriteFileSync(ensureFile(), JSON.stringify(cache || {}, null, 2), { mode: 0o600 });
  } catch (err) {
    // 写入失败不能静默:否则刚记下的大小下次重启就没了。
    // 不要再调 ensureFile():它可能正是失败原因(临时目录不安全),二次抛错会逃出 save()
    console.warn('[sftp-sizes] 大小记录写入失败(' + err.message + '):', file || '(未初始化)');
  }
}

module.exports = {
  /** 取某路径已知的真实大小;返回 { size, ts } 或 undefined */
  get: (key) => load()[key],
  /** 记真实大小;自动补 ts 用于过期裁剪 */
  set: (key, size) => { const m = load(); m[key] = { size, ts: Date.now() }; save(); },
  remove: (key) => { const m = load(); if (key in m) { delete m[key]; save(); } },
  /** 裁剪过期条目(maxAgeMs 缺省 30 天),返回删掉的条数;损坏/非对象条目一并清掉 */
  prune: (maxAgeMs = DEFAULT_MAX_AGE_MS) => {
    const m = load();
    const cutoff = Date.now() - maxAgeMs;
    let removed = 0;
    for (const k of Object.keys(m)) {
      const v = m[k];
      if (typeof v !== 'object' || v === null || typeof v.size !== 'number' || !(v.ts > cutoff)) {
        delete m[k];
        removed++;
      }
    }
    if (removed) save();
    return removed;
  },
  save, // 显式落盘兜底(正常路径每次 set 已同步落盘,退出时再调一次无害)
  _file: () => file || ensureFile(), // 供测试/调试
};
