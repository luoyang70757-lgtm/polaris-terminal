'use strict';
// clean-release.js — 编译新版本前删除旧 release 目录(约定:只保留一个 release 目录)
// 被 package.json 的 clean 脚本调用;rmSync(force) 删不掉的文件(被占用)静默保留,
// 此时 electron-builder 会因文件被占用而报错,提示先关掉正在运行的 Polaris/退出会话。
const fs = require('fs');
try {
  fs.rmSync('release', { recursive: true, force: true });
  console.log('[clean] release 目录已清空');
} catch (e) {
  console.log('[clean] 清理 release 失败:', e.message);
}
