# Polaris v1.0.25 — SFTP 只剩一个入口：用本机 WinSCP 打开当前会话

> 一句话：**内置 SFTP 面板整套删除**，SFTP 全部交给本机 WinSCP。工具栏「🪟 WinSCP」/ ⌘⇧S /
> 菜单 / 标签右键点一下，就直接在 WinSCP 里打开这条会话（主机、账号、密码、起始目录自动带过去）。

## 为什么删

内置面板从 v1.0.6 起一路补功能（断点续传、权限对话框、限速、批量传输都做过），但真实使用里
反复踩两类坑：

1. **堡垒机网关的 SFTP 行为不一致**：KoKo / H3C 网关会对 `REALPATH(".")` 回 `Status code: 4`，
   独立 SFTP 通道还会被限流、串行处理，表现为"打开面板空白"、"列表 40 秒不动"、
   "文件夹下载一半失败"——每一次都要在面板里加超时/重试/回落兜底。
2. **维护成本**：面板自己实现了文件列表、多选、重命名、删除、上传下载、断点续传、远程编辑、
   权限改造、限速、进度节流……这些 WinSCP 免费且更成熟（双窗格、同步、权限对话框、限速、队列）。

所以这一版按"砍干净、不留双轨"处理：**面板整套删掉，只保留把会话交给 WinSCP 这一条链路**。

## 用户看到的变化

| 之前 | 现在 |
|---|---|
| 点 SFTP 打开内置面板（`button` 档），面板上还有「🪟 WinSCP」按钮 | 点 SFTP（或 ⌘⇧S / 菜单 / 标签右键）**直接拉起 WinSCP** |
| 设置 → SFTP 有三档模式（`replace`/`button`/`panel`）+ 传输限速 | 只留「WinSCP 协议：SFTP / SCP」一项 |
| 没装 WinSCP 时回落内置面板 | 没装时按钮变暗 + 点一下给提示（装好后重开窗口即可） |
| 面板里能改远端文件权限、重命名、删除 | 这些在 WinSCP 里做（它一直在做） |

入口点了之后的三种提示（都在状态栏，不再静默失败）：

- 还没连接主机 → 「先连接一台主机，再用 WinSCP 打开 SFTP」
- Telnet 会话 → 「SFTP 仅支持 SSH 会话（Telnet 没有 SFTP）」
- 本机没装 WinSCP → 「本机没装 WinSCP，无法打开 SFTP」（可用 `POLARIS_WINSCP_PATH` 指自定义安装路径）

## 技术细节（对二次开发者）

删掉的：

- DOM/样式：`#sftp-panel`（文件列表、路径栏、传输进度、传输记录）、`#attrs-modal`、`#edit-modal`、
  `#batch-upload`/`#batch-download`、`#set-winscp-mode`、`#set-sftp-limit`、`#divider-h` 及其全部 `.sftp-*` 样式
- 渲染层：`state.sftp`、`toggleSftpPanel`/`loadSftpList`/`renderSftpList`/`sftpUpload`/`sftpDownload`/
  `openSftpAttrs`/`openRemoteEditor`/`refreshWinScpButton`/`winScpMode`/`sftpLimitKbps` 等
- 主进程：全部 18 个 `sftp:*` handler（`list`/`stat`/`read`/`write`/`upload`/`download`/`mkdir`/`rename`/
  `delete`/`setAttrs`/`batchUpload`/`batchDownload`/`transfers`/…）与 `sftp:home`
- 模块：`lib/sftp-attrs.js`、`lib/sftp-partials.js`、`lib/sftp-progress-throttle.js`、`lib/sftp-sizes.js`、
  `lib/sftp-throttle.js`
- `lib/ssh-client.js` 的上传/下载/递归/断点续传（`uploadFile`/`downloadFile`/`uploadDir`/`downloadDir`/
  `walkRemote`/`rmdirRecursive`/`statSize`/断点偏移解析/并发映射/限速）。文件降到 **208 行**，
  导出只剩 `connect`/`connectRaw`/`openSftp`/`execCommand`/`warmup`

保留的：

- `lib/winscp-open.js` 纯函数层 + `winScp:detect`/`winScp:open`（`spawn` 时 `detached:true` + `unref()`）
- `trackShellCwd()`：跟踪终端里的 `cd`，作为 WinSCP 起始目录（只认绝对路径）
- `resolveSftpHome(sessionId)`：起始目录未知时现探家目录（exec `pwd` / `echo %USERPROFILE%` →
  SFTP `readdir` 校验 → 不可用回退 `/tmp`），现在只剩 `winScp:open` 一个调用方
- `openSftpEntry(sessionId)`：唯一入口；`syncSftpEntryButton()`：按安装状态切 dim/title

## 顺手修的：`MaxListenersExceededWarning: 11 did-stop-loading listeners`

现场日志里出现这条告警：堡垒机 webview 每加载完成一次就挂一个一次性监听，累计到 11 个时 Node
开始警告（默认上限 10）。现在主进程在 `web-contents-created` 里给 **webview 型 contents**
`setMaxListeners(50)`；主窗口**不动**上限——如果那边真有泄漏，告警仍然会报出来。

## 升级注意

1. 老配置里的 `winscpMode`（`replace`/`button`/`panel`）与 `sftpSpeedLimitKBps` 会被忽略，
   不迁移也不报错；设置里对应两项已删除。
2. 之前若把「打开 SFTP 时」设成 `panel`（完全不用 WinSCP），升级后 SFTP 就靠 WinSCP——
   **没装 WinSCP 的话先装**（或临时用协议 SCP、或用系统自带的 scp/sftp 命令行）。
3. WinSCP 的排障开关不变：`POLARIS_WINSCP_PATH`、`POLARIS_WINSCP_REALPATH=on`、
   `POLARIS_WINSCP_RAWSETTINGS=...`、`POLARIS_WINSCP_LOG=1`（注意 WinSCP 自己的级别 1 日志会把
   明文口令写进 `winscp-*.log`，排完障记得删）、`POLARIS_WINSCP_DEBUG=1`。

## 回归

- `node run-verify.js --pure` → **9/9 脚本、199 断言全绿**
- 新增 `verify-sftp-entry.js`（纯 Node 26 条）：DOM/CSS/`sftp:*` IPC/`lib/sftp-*` 残留全为 0、
  入口唯一性（工具栏/快捷键/菜单/标签右键都走 `openSftpEntry`）、三类提示、
  WinSCP 链路完整（`winScp:detect`/`winScp:open`/`resolveSftpHome`/`RemoteDirectory`/payload 只认 `shellCwd`）、
  webview 监听器上限
- `verify-winscp-open.js` 41/41（第 ④ 段重写为「SFTP 入口 = WinSCP」，含装了/没装/未连接/Telnet 四态、
  SFTP↔SCP、日志默认关、起始目录、密码脱敏）
- `verify-ui-layout.js` 22/22（SFTP 面板测点换成工具栏 WinSCP 按钮：字号跟随 `--ui-font`、不折字、工具栏不裁切）
- 其余 e2e 抽查 50+ 脚本全绿（`verify-debug-log.js` 为已知红灯，见 `docs/verify-known-red.md`）

## 已知边界

- WinSCP 是 Windows-only：macOS / Linux 上 SFTP 入口不存在（面板删了，这里不再有替代品）。
- WinSCP 的密码仍走 argv（percent-encode），同用户/管理员可见；不想要可以用协议 SCP 或命令行 scp。
- 堡垒机会话的复合用户名（`JMS用户@协议@账号@资产IP`）整体编码后交给 WinSCP，不拆分。
