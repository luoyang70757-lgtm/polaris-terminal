# v1.0.22 发布说明 — 默认用内置面板 + WinSCP 协议可选 SFTP/SCP

> Windows 只发布便携版：`Polaris.Portable.1.0.22.exe`。

## 一句话

**点 SFTP 现在默认开 Polaris 自己的面板**（不再默认拉 WinSCP）；WinSCP 仍在面板工具栏「🪟 WinSCP」，
想用才用。同时新增「WinSCP 协议：SFTP / SCP」——SCP 走服务器上的 `scp` 命令，**完全绕过 SFTP 子系统**，
给「错误码 4 / General failure」这类老设备留一条路。

## 改了什么

### 1. 默认档：内置面板（`button`）

| 设置（设置 → SFTP → 打开 SFTP 时） | 行为 |
|---|---|
| **用内置面板（面板里有「🪟 WinSCP」按钮）← 默认** | 点 SFTP 开面板，WinSCP 按需点按钮 |
| 用本机 WinSCP 打开 | 点 SFTP 直接拉 WinSCP（没装/拉起失败自动回落面板） |
| 只用内置面板 | 点 SFTP 开面板，连 WinSCP 按钮都不显示 |

老配置自动迁移：**从没自己选过**的 `replace`（那是 v1.0.15 我们给的默认值）→ `button` 并写回
（`settingsVersion` 3 → 4 + `winscpModeMigrated` 一次性标记）。**你自己选过 `replace` 的不动**，
随时可以在设置里切回去。

### 2. WinSCP 协议：SFTP / SCP（默认 SFTP）

- `sftp://`：标准 SFTP 子系统。
- `scp://`：WinSCP 用服务器上的 `scp` 命令传文件，**不发任何 SFTP 请求**——
  `LSTAT` / `OPENDIR` 被服务器回成 4（FAILURE）的设备（嵌入式/H3C 类）可以用它绕过去。
  代价：SCP 能力弱于 SFTP（没有远端复制/保留时间戳/单文件断点等），大目录会慢一些。
- SCP 会话**不再下发** `SFTPRealPath=off`（SFTP 专属开关，带了只会让人误判）；日志、私钥、口令、
  `RemoteDirectory` 照常带。
- 脱敏覆盖 `scp://`：调试面板/落盘日志里仍是 `scp://user:***@host:22/`。
- 不认识的协议值一律回落 `sftp`，绝不会拼出怪 URL。

### 3. 小修

SFTP 面板每次打开都重刷一次 WinSCP 按钮显隐（装/没装、模式刚改过都能立刻反映）。

## 现场建议（那台 `root@h3c-bastion.example`）

1. 先按新默认点 SFTP → 内置面板能列目录就说明服务器 SFTP 正常，问题只在 WinSCP 的请求序列；
2. 想让 WinSCP 也进得去：设置 → SFTP → **WinSCP 协议 = SCP**，再点面板里的「🪟 WinSCP」；
3. 仍旧失败：把 `<exe 同级>\.Polaris\logs\winscp-*.log` 的最后 20 行发出来（v1.0.21 起默认就有）。

## 回归

| 脚本 | 结果 |
|---|---|
| `verify-winscp-args.js`（纯 Node） | **38/38**（scheme 默认/大小写/非法值回落/堡垒机复合用户名整体编码/`scp://` 脱敏） |
| `verify-winscp-open.js`（e2e） | **46/46**（默认档 = button、下拉首项、v4 迁移两种情形、协议下拉、`scp://` 真实拉起且不带 `SFTPRealPath`、面板重刷按钮） |
| `verify-sftp-panel.js` / `verify-sftp-attrs-dialog.js` / `verify-theme.js` | 5/5 · 16/16 · 21/21（无退化） |
| `run-verify --pure` | **17/17 脚本 343 断言** |

## 升级注意

- 默认档变了：如果你之前**依赖**「点 SFTP 直接开 WinSCP」，请到设置里切回「用本机 WinSCP 打开」。
- macOS/Linux 上 WinSCP 相关入口照旧完全不出现（`detectExe` 对非 Windows 返 null）。
