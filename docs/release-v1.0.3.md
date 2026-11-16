# Polaris v1.0.3（2026-11-03）

## 新增：识别 nologin 账号并给出可操作提示

现场日志：

```
STATUS sess-39 connected
RECV sess-39 +45B [0d 0a 54 68 69 73 20 61 63 63 6f 75 …]
STATUS sess-39 closed
```

- SSH 认证成功（`connected`），紧接着收到
  `\r\nThis account is currently not available.`；
- 这是目标 Linux 账号 shell 为 `/usr/sbin/nologin`（或 `/bin/false`）的标准提示；
- 服务器发完就关闭连接，不是网络/堡垒机/密码问题。

### 现在的行为

- 自动识别该消息，标记 `tab.noLogin`；
- 状态栏提示「远端账号没有登录 shell(nologin)」；
- 终端内给出原因和处理方式：
  - 换有 shell 的账号（资产右键可切换账号）；
  - 或让管理员执行 `usermod -s /bin/bash <账号>`；
- **不再自动重连**（账号问题重试无意义），换账号后手动重连即可；
- 调试日志新增 `NOLOGIN` 记录。

## 回归

- `verify-nologin-hint.js`：5/5
  - 识别 nologin
  - 状态栏提示
  - 终端原因/处理提示
  - NOLOGIN 调试记录
  - 不触发自动重连

## 安装包

| 文件 | 说明 |
|---|---|
| `Polaris.Setup.1.0.3.exe` | NSIS 安装版（推荐，支持自动更新） |
| `Polaris.Portable.1.0.3.exe` | portable 免安装版（手动下载） |
| `latest.yml` | 自动更新版本/哈希清单 |
| `Polaris.Setup.1.0.3.exe.blockmap` | 差分下载元数据 |
