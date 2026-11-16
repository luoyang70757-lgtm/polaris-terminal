# Polaris v1.0.60（2026-11-03）

## 新增：检查更新

- 「帮助 → 检查更新…」或「关于」弹窗里的「检查更新」按钮；
- 主进程读取 GitHub Releases 最新版本，比较当前版本；
- 有新版本时显示版本号、发布说明摘要，并可打开下载页面；
- 已是最新版本 / 网络失败都有明确提示；
- 只允许打开本项目 GitHub Releases 地址，防止任意外链；
- **不自动下载/安装**，不引入 `electron-updater`，不影响现有发布链路。

## 回归

- `verify-check-update.js`：4/4
  - 远端更高 → `hasUpdate=true`
  - 远端等于当前 → `hasUpdate=false`
  - 非法外链被拒绝
  - 关于弹窗显示检查结果
- `verify-about.js`：15/15（关于弹窗新增「检查更新」按钮）

## 安装包

| 文件 | 说明 |
|---|---|
| `Polaris Setup 1.0.60.exe` | NSIS 安装版（推荐，启动快，可自选目录/建快捷方式） |
| `Polaris Portable 1.0.60.exe` | portable 免安装版（每次启动自解压，较慢但便携） |
