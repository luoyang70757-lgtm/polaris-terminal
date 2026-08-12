'use strict';
/**
 * crypto.js — 密码加密(safeStorage)
 * 用 Electron 的 safeStorage(内部走系统钥匙串/DPAPI)加密密码后存 SQLite。
 * 格式: enc:v1:<base64> —— 旧的明文密码(不带前缀)在启动时自动迁移成加密。
 */

const { safeStorage } = require('electron');
const MARKER = 'enc:v1:';

/** 加密:返回带前缀的密文;若系统加密不可用则退回明文(记录警告) */
function encrypt(text) {
  const value = String(text || '');
  if (!value) return value;
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return MARKER + safeStorage.encryptString(value).toString('base64');
    }
  } catch (err) {
    console.warn('[crypto] 加密失败,退回明文:', err.message);
  }
  return value;
}

/** 解密:只有带前缀的密文才解密,明文原样返回 */
function decrypt(stored) {
  if (typeof stored === 'string' && stored.startsWith(MARKER)) {
    try {
      return safeStorage.decryptString(Buffer.from(stored.slice(MARKER.length), 'base64'));
    } catch {
      return '';
    }
  }
  return stored || '';
}

/** 判断是否已加密(用于迁移) */
function isEncrypted(stored) {
  return typeof stored === 'string' && stored.startsWith(MARKER);
}

module.exports = { encrypt, decrypt, isEncrypted };
