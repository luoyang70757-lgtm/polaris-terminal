'use strict';
/**
 * app-lock.js — App 打开密码锁
 * 密码以 PBKDF2 哈希存在 ~/.jms-terminal/app.lock(不存明文)。
 * 数据目录: 与数据库同目录(便于统一管理)
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ITER = 120000;

// 数据目录默认 ~/.jms-terminal;可用 POLARIS_LOCK_DIR 环境变量覆盖(便携/隔离测试用)
function lockDir() {
  return process.env.POLARIS_LOCK_DIR || path.join(os.homedir(), '.jms-terminal');
}

function lockFile() {
  return path.join(lockDir(), 'app.lock');
}

// 是否已设置过密码(首次运行=false)
function hasPassword() {
  try { return fs.existsSync(lockFile()); } catch { return false; }
}

// 设置密码(仅首次;已设置则抛错)
function setPassword(password) {
  if (!password) throw new Error('密码不能为空');
  if (hasPassword()) throw new Error('已设置过密码');
  fs.mkdirSync(lockDir(), { recursive: true });
  const salt = crypto.randomBytes(16);
  const hash = crypto.pbkdf2Sync(String(password), salt, ITER, 32, 'sha256');
  fs.writeFileSync(lockFile(), JSON.stringify({ salt: salt.toString('base64'), hash: hash.toString('base64') }));
  try { fs.chmodSync(lockFile(), 0o600); } catch { /* 平台不支持则忽略 */ } // 密码哈希只允许当前用户读写
}

// 校验密码(用 timingSafeEqual 防时序攻击)
function verifyPassword(password) {
  const raw = fs.readFileSync(lockFile(), 'utf8');
  const { salt, hash } = JSON.parse(raw);
  const test = crypto.pbkdf2Sync(String(password), Buffer.from(salt, 'base64'), ITER, 32, 'sha256');
  const expect = Buffer.from(hash, 'base64');
  if (test.length !== expect.length) return false;
  return crypto.timingSafeEqual(test, expect);
}

// 修改密码:直接覆盖 app.lock 里的哈希(主进程已先校验旧密码)
function updatePassword(password) {
  if (!password) throw new Error('密码不能为空');
  fs.mkdirSync(lockDir(), { recursive: true });
  const salt = crypto.randomBytes(16);
  const hash = crypto.pbkdf2Sync(String(password), salt, ITER, 32, 'sha256');
  fs.writeFileSync(lockFile(), JSON.stringify({ salt: salt.toString('base64'), hash: hash.toString('base64') }));
  try { fs.chmodSync(lockFile(), 0o600); } catch { /* 平台不支持则忽略 */ }
  resetBrute(); // 改密码后清掉暴力破解计数
}

// ---------- 防暴力破解:连续失败锁定,锁定时长递增,持久化到磁盘(重启不重置) ----------
const BRUTE_FILE = 'brute.json';
const MAX_ATTEMPTS = 5;            // 连续失败 5 次触发锁定
const LOCK_BASE_MS = 30 * 1000;    // 首次锁定 30 秒
const LOCK_CAP_MS = 5 * 60 * 1000; // 锁定上限 5 分钟

let brute = { attempts: 0, lockLevel: 0, lockedUntil: 0 };

function loadBrute() {
  try {
    const f = path.join(lockDir(), BRUTE_FILE);
    if (fs.existsSync(f)) {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      brute = { attempts: j.attempts || 0, lockLevel: j.lockLevel || 0, lockedUntil: j.lockedUntil || 0 };
    }
  } catch { /* 损坏则用默认值 */ }
}
function saveBrute() {
  try {
    fs.mkdirSync(lockDir(), { recursive: true });
    fs.writeFileSync(path.join(lockDir(), BRUTE_FILE), JSON.stringify(brute));
  } catch { /* 忽略 */ }
}
function remainingLockMs() { return Math.max(0, brute.lockedUntil - Date.now()); }

// 当前是否处于锁定(禁试)状态
function isLocked() { loadBrute(); return remainingLockMs() > 0; }

// 记录一次失败:满 MAX_ATTEMPTS 次 → 锁定,锁定时长按级数翻倍(30s→60s→120s→…上限 5 分钟)
function recordFailure() {
  loadBrute();
  brute.attempts += 1;
  if (brute.attempts >= MAX_ATTEMPTS) {
    brute.lockLevel += 1;
    brute.lockedUntil = Date.now() + Math.min(LOCK_BASE_MS * Math.pow(2, brute.lockLevel - 1), LOCK_CAP_MS);
    brute.attempts = 0; // 锁定期间一律拒绝;解锁后从 0 重新计
  }
  saveBrute();
}
function recordSuccess() {
  brute = { attempts: 0, lockLevel: 0, lockedUntil: 0 };
  saveBrute();
}
function resetBrute() {
  brute = { attempts: 0, lockLevel: 0, lockedUntil: 0 };
  try { fs.rmSync(path.join(lockDir(), BRUTE_FILE), { force: true }); } catch { /* 忽略 */ }
}

// 校验密码(带防暴力):返回 { ok, locked, remainingSec, attemptsLeft }
function verifyWithLock(password) {
  loadBrute();
  const remain = remainingLockMs();
  if (remain > 0) return { ok: false, locked: true, remainingSec: Math.ceil(remain / 1000), attemptsLeft: 0 };
  const ok = verifyPassword(password); // app.lock 不存在会抛错,由调用方捕获
  if (ok) { recordSuccess(); return { ok: true, locked: false, remainingSec: 0, attemptsLeft: MAX_ATTEMPTS }; }
  recordFailure();
  const remain2 = remainingLockMs();
  return {
    ok: false,
    locked: remain2 > 0,
    remainingSec: remain2 > 0 ? Math.ceil(remain2 / 1000) : 0,
    attemptsLeft: remain2 > 0 ? 0 : Math.max(0, MAX_ATTEMPTS - brute.attempts),
  };
}

// 当前锁定状态(锁屏页加载时展示)
function status() {
  loadBrute();
  const remain = remainingLockMs();
  return { locked: remain > 0, remainingSec: Math.ceil(remain / 1000), attemptsLeft: remain > 0 ? 0 : Math.max(0, MAX_ATTEMPTS - brute.attempts) };
}

module.exports = { lockDir, hasPassword, setPassword, verifyPassword, updatePassword, verifyWithLock, isLocked, status, resetBrute };
