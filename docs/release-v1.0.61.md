# Polaris v1.0.61（2026-11-03）

## 新增：Windows 安装版自动更新

- 「帮助 → 检查更新…」或「关于」弹窗检查新版本；
- 发现新版本后可 **下载更新 → 显示进度 → 重启安装**（不再只跳下载页）；
- 使用 `electron-updater` + GitHub Releases（`latest.yml` / `.blockmap`）；
- 仅 **Windows NSIS 安装版**支持自动更新；**便携版、开发版、非 Windows** 会提示并回退到「打开下载页」；
- 未签名安装包设置 `win.verifyUpdateCodeSignature=false`，与现有未签名发布策略一致。

> ⚠️ v1.0.60 及更早版本没有内置更新器，需要**手动安装一次 v1.0.61**；
> 从 v1.0.61 起，后续版本可以直接在应用内下载并重启安装。

## 发布资产

Release 除两个 exe 外，还包含自动更新元数据：

| 文件 | 用途 |
|---|---|
| `Polaris.Setup.1.0.61.exe` | NSIS 安装版（自动更新使用） |
| `Polaris.Portable.1.0.61.exe` | 便携版（手动下载） |
| `latest.yml` | electron-updater 版本/哈希/文件名清单 |
| `Polaris.Setup.1.0.61.exe.blockmap` | 差分下载元数据 |

## 回归

- `verify-check-update.js`：6/6（检查、同版本、非法外链、开发环境拒绝、未下载不可安装）
- `verify-about.js`：15/15
- 本地 Windows 打包验证：生成 `latest.yml` + `.blockmap`，`app-update.yml` 指向 GitHub provider

## 安装包

| 文件 | 说明 |
|---|---|
| `Polaris.Setup.1.0.61.exe` | NSIS 安装版（推荐，支持自动更新） |
| `Polaris.Portable.1.0.61.exe` | portable 免安装版（每次启动自解压，较慢但便携） |
