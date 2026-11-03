# Polaris v1.0.0（2026-11-03）

> **版本号重置说明**：历史 GitHub Releases 与 `v*` 标签已按用户要求清理，版本号从 **v1.0.0** 重新开始。
> 本版本包含重置前 v1.0.61 的全部功能与修复。

## 当前能力

- SSH / SFTP 终端：多标签、分屏、广播、断点续传、远程编辑、批量执行
- 堡垒机：JumpServer（API + KoKo 网关）、H3C（浏览器登录 + 原生 API）、资产分组/收藏/批量连接
- 会话与安全：SQLite 整库 AES-256-GCM、App 密码锁、主机指纹校验、危险命令确认
- 界面：10 套精选主题、每主题 ANSI 色板、界面/终端字号分离、SF Pro/苹方优先
- Windows：NSIS 安装版（启动快）、便携版；**安装版支持应用内自动更新**
- 运维辅助：命令补全/推荐、AI 助手、SSH 隧道、录制回放、会话日志

## 升级注意

- **v1.0.61 及更早版本的客户端不会把 1.0.0 视为更新**（版本号更低），需要手动安装一次 v1.0.0；
- 从 v1.0.0 起，后续版本可以通过「帮助 → 检查更新」下载并重启安装；
- 安装包仍未签名，更新校验已设置为 `verifyUpdateCodeSignature=false`，Windows SmartScreen 可能提示未知发布者。

## 发布资产

| 文件 | 说明 |
|---|---|
| `Polaris.Setup.1.0.0.exe` | NSIS 安装版（推荐，支持自动更新） |
| `Polaris.Portable.1.0.0.exe` | portable 免安装版（手动下载） |
| `latest.yml` | 自动更新版本/哈希清单 |
| `Polaris.Setup.1.0.0.exe.blockmap` | 差分下载元数据 |

## 验证

- `verify-check-update` 6/6
- `verify-about` 15/15
- 本地 Windows 打包生成 `app-update.yml` / `latest.yml` / `.blockmap`
