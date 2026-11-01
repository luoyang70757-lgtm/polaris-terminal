'use strict';
/**
 * ensure-electron.js — npm install / npm ci 之后确保 Electron 二进制存在
 *
 * 为什么需要:
 *   electron 的二进制不在 npm 包里,而是 postinstall 时从 GitHub Releases 下载(~144MB)。
 *   - 部分网络(国内/企业代理)无法直连 github.com → 下载失败(fetch failed),
 *     但 npm 只打印告警、仍然返回成功 → node_modules/electron/dist 缺失。
 *   - 结果是 `npm run dev` / 所有 verify-*.js 都起不来,而报错信息只有 ENOENT,很难定位。
 *
 * 策略:先探测 dist/<path.txt>;缺失时按 [官方源 → npmmirror 镜像] 依次重试安装。
 * 已就绪时零开销直接退出(CI / 正常网络环境不受影响)。
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const electronDir = path.join(root, 'node_modules', 'electron');
const installJs = path.join(electronDir, 'install.js');

// 还没安装依赖(单独跑本脚本):静默通过
if (!fs.existsSync(installJs)) process.exit(0);

function installedPath() {
  try {
    const rel = fs.readFileSync(path.join(electronDir, 'path.txt'), 'utf8').trim();
    if (!rel) return null;
    const abs = path.join(electronDir, 'dist', rel);
    return fs.existsSync(abs) ? abs : null;
  } catch { return null; }
}

if (installedPath()) {
  console.log('[ensure-electron] Electron 二进制已就绪');
  process.exit(0);
}

const mirrors = [
  null, // 先试官方(GitHub Releases)
  'https://npmmirror.com/mirrors/electron/', // 官方源不通时用国内镜像
];

for (const mirror of mirrors) {
  try {
    console.log(`[ensure-electron] 下载 Electron 二进制${mirror ? ' · 镜像 ' + mirror : ' · 官方源'}…`);
    execFileSync(process.execPath, [installJs], {
      stdio: 'inherit',
      cwd: root,
      env: { ...process.env, ...(mirror ? { ELECTRON_MIRROR: mirror } : {}) },
    });
    const p = installedPath();
    if (p) {
      console.log('[ensure-electron] 完成:' + p);
      process.exit(0);
    }
  } catch (err) {
    console.warn('[ensure-electron] 该源失败:' + ((err && err.message) || err));
  }
}

console.error(
  '\n[ensure-electron] 无法下载 Electron 二进制(所有源均失败)。\n' +
  '请检查网络后手动执行(任选其一):\n' +
  '  ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node node_modules/electron/install.js\n' +
  '  set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ && node node_modules/electron/install.js   (cmd)\n' +
  '  $env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"; node node_modules/electron/install.js  (PowerShell)\n'
);
process.exit(1);
