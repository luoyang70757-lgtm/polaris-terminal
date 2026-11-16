# Polaris v1.0.6（2026-11-03）

本版聚焦**新用户第一次用得上手**，四件事：切换 root、新手引导、`~/.ssh/config` 导入、空态卡片。

## 新增：切换 root（su - root）+ 密码粘贴

- 终端**右键菜单**与 **⌘K 命令面板**新增「🔐 切换 root（su - root）」。
- 一键发送 `su - root`（先 Ctrl+U/Ctrl+K 清掉远端当前行），随后终端出现 `Password:`，弹出密码框：
  - 可直接 `Ctrl/Cmd+V` 粘贴，或点「📋 粘贴」从剪贴板填入；
  - 勾选「记住到本会话」→ root 密码加密存库（`su_password`），下次切换**自动发送、不再弹框**。
- 安全与体验细节：
  - 切换期间 `suPending` 抑制「自动填充密码」，避免把**登录密码**误发给 su 的密码提示；
  - root 密码以 `noLog` 发送，不进会话日志 / 录制 / 命令记录；
  - 点「取消」自动发 `Ctrl+C` 中止 su，不会把密码提示卡在终端；
  - Telnet 会话不支持共用一个 `su`，直接给出提示。

## 新增：新手引导向导

- 首次使用（无任何会话、且未完成过引导）解锁后自动弹出三步向导：
  1. **欢迎**：多标签/分屏、SFTP 断点续传、堡垒机、批量执行；本机 AES-256-GCM 加密 / 指纹校验 / 数据不出网；
  2. **建立第一台主机**：🔑 导入 SSH 配置 / 📥 批量导入 / ➕ 新建会话 / ⚡ 快捷连接；
  3. **一切就绪**：双击连接、堡垒机分组右键建连接。
- ✕ / 跳过 / 完成都会关闭并持久化 `onboardingDone`，之后不再打扰；
- 空态卡片里的「🚀 查看新手引导」可随时重开。

## 新增：从 `~/.ssh/config` 导入

- 导入弹窗新增「🔑 从 ~/.ssh/config 导入」（另可经「从 Xshell/iTerm2/SSH config 导入」手选 `.conf` / `config` 文件）。
- 解析 `Host` / `HostName` / `User` / `Port` / `IdentityFile`：
  - `Host *` 作为全局默认（不生成会话），支持 `Keyword = value`、CRLF、大小写关键字、注释剥离；
  - `IdentityFile ~/...` 自动展开成绝对路径；
  - 通配 / 否定 pattern、`Match` 段跳过；
  - 一个 `Host` 行写多个 pattern 会生成多条会话。
- 密码不会从 config 还原，导入后需补填（导入预览里会写明「已解析 N 台新增」）。

## 修复：首次使用看不到空态卡片

- 首次启动会话列表默认全部折叠，「🖥 主机」分组收起导致空态卡片不可见 → 无会话时自动展开主机分组；
- 空态卡片给出四个直达入口：➕ 新建会话 / 📄 批量导入 / 🔑 导入 `~/.ssh/config` / ⚡ 快捷连接。

## 数据库

- `sessions.su_password`（加密存库，老库自动 `ALTER TABLE` 补列，无需迁移操作）。

## 回归

| 脚本 | 结果 |
|---|---|
| `verify-su-root.js` | 13/13 |
| `verify-onboarding.js` | 24/24 |
| `verify-ssh-config.js`（纯 Node） | 16/16 |
| `verify-ssh-config-import.js` | 20/20 |
| `verify-ui-layout.js` | 21/21 |
| `verify-session-modal.js`（新增字段回填） | 13/13 |
| `verify-autofill-pw.js`（suPending 抑制不误伤原功能） | 5/5 |
| `verify-autofill-log-leak.js`（root 密码 noLog 不泄漏） | 9/9 |
| `verify-export-password.js` | 9/9 |
| `verify-groups-order.js`（老库补列/迁移） | 19/19 |
| `verify-boot.js`（引导不遮挡过场） | 2/2 |

## 安装包

| 文件 | 说明 |
|---|---|
| `Polaris.Setup.1.0.6.exe` | NSIS 安装版（推荐，支持自动更新） |
| `Polaris.Portable.1.0.6.exe` | portable 免安装版（手动下载） |
| `latest.yml` | 自动更新版本/哈希清单 |
| `Polaris.Setup.1.0.6.exe.blockmap` | 差分下载元数据 |
