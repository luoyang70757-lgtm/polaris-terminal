'use strict';
/**
 * db-crypto.js — 数据库整库加密(AES-256-GCM)
 * 用 App 设置的密码派生出密钥,把整个 SQLite 数据库(序列化后的字节)加密落盘。
 * 落盘格式: salt(16) + iv(12) + authTag(16) + ciphertext
 */

const crypto = require('crypto');

const ITER = 120000; // PBKDF2 迭代次数(兼顾安全与速度)

// 从密码 + 随机盐派生 32 字节 AES 密钥
function deriveKey(password, salt) {
  return crypto.pbkdf2Sync(String(password), salt, ITER, 32, 'sha256');
}

// 加密一段字节,返回落盘的 Buffer
function encryptBytes(bytes, password) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveKey(password, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(Buffer.from(bytes)), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([salt, iv, tag, ct]);
}

// 解密:密码错 / 数据损坏会抛错
function decryptBytes(blob, password) {
  const salt = blob.subarray(0, 16);
  const iv = blob.subarray(16, 28);
  const tag = blob.subarray(28, 44);
  const ct = blob.subarray(44);
  const key = deriveKey(password, salt);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

module.exports = { encryptBytes, decryptBytes, deriveKey };
