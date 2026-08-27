'use strict';
/**
 * verify-h3c-web.js — 已废弃(占位)
 *
 * 原功能:验证 H3C 堡垒机"网页控制台集成"—— 在 webview 里注入 XHR/fetch 钩子捕获
 * /shterm/api/* 响应 → 轮询同步到 state.bastionAssets → 网页 fetch accessUrl 连接。
 *
 * 该注入式捕获已整体移除(H3C 资产枚举/连接改为主进程 lib/h3c-api.js 原生 IPC,
 * webview 只做登录会话载体)。本脚本断言被删的 __bastionFetchAll/__bastionAssets,
 * 跑必失败 —— 已被 verify-h3c-native.js 取代。
 * 运行: node verify-h3c-native.js
 */
const fs = require('fs'); const os = require('os'); const path = require('path');
const OUT = path.join(os.tmpdir(), 'verify-h3c-web-result.txt');
try { fs.writeFileSync(OUT, '已由 verify-h3c-native.js 取代(注入式捕获已移除,webview 只做登录会话载体)\n'); } catch {}
console.log('verify-h3c-web.js 已废弃:注入式捕获已移除,请运行 verify-h3c-native.js');
process.exit(0);
