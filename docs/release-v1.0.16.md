# Polaris v1.0.16 — 修「WinSCP 报『不能获得 . 的真实路径』(错误码 4)」

发布日期：2026-11-12

## 症状

v1.0.15 把「点 SFTP 用本机 WinSCP 打开」做成了默认行为之后，一部分服务器（JumpServer KoKo 网关 / H3C 网关 / 各种把 SFTP 根 chroot 掉的服务端）上，WinSCP 一开会话就弹：

```
不能获得'.'的真实路径。一般错误（服务器应该提供错误描述）。
错误码：4，服务器返回的错误消息：General failure
```

会话进不去，目录也列不出来。

## 根因

WinSCP 建立 SFTP 会话时会先问服务器「`"."` 的真实路径是什么」，用它当作家目录：

- `source/core/SftpFileSystem.cpp:2976` → `FHomeDirectory = RealPath(L".");`
- `source/core/SftpFileSystem.cpp:2785` → 只有 `SessionData->SFTPRealPath == asOff` 时才走本地拼接（`LocalCanonify`），否则发 `SSH_FXP_REALPATH`
- `source/core/SessionData.cpp:303` → 默认 `SFTPRealPath = asAuto`

chroot 型服务端对这个请求直接回 `SSH_FX_FAILURE`（错误码 4），WinSCP 把它当致命错误抛出 → 上面那句提示。

（Polaris 自己的 SFTP 面板从来没这个问题，因为我们不发 REALPATH：家目录用 `exec pwd` + `readdir` 验证，路径按字符串处理。）

## 修法

拉起的命令行从

```
WinSCP.exe sftp://user:pass@host:port/ -privatekey=… -passphrase=…
```

变成

```
WinSCP.exe sftp://user:pass@host:port/ /rawsettings SFTPRealPath=off [RemoteDirectory=/root/www] [-privatekey=…] [-passphrase=…]
```

- `SFTPRealPath=off`（`/rawsettings` 是 WinSCP 官方支持的会话级 ini 注入）→ 不再对 `"."` 发 REALPATH，chroot 服务器也能正常打开。
- `RemoteDirectory=<已知目录>` → 打开就落在用户刚才所在的位置（顺序：SFTP 面板当前目录 → 该标签记住的 SFTP 路径 → 终端里跟踪到的 `cd` 目录；相对路径/未知不传，避免猜错报「目录不存在」）。
- 想保留 WinSCP 原生行为：`POLARIS_WINSCP_REALPATH=on` 启动 Polaris（此时只额外传起始目录）。

## 这次改了哪些文件

| 文件 | 改动 |
|---|---|
| `lib/winscp-open.js` | `RAW_SETTINGS_DEFAULTS = { SFTPRealPath: 'off' }`；`buildArgs()` 支持 `rawSettings`（空值跳过、顺序稳定）；新增 `normalizeRemotePath()`（只收绝对路径）与 `realPathCompat(env)` |
| `main.js` | `winScp:open` 组装 `rawSettings` + 可选 `RemoteDirectory`，拉起日志追加 `rawsettings=…`（无凭据） |
| `src/renderer.js` | `winScpPayloadFor()` 增加 `remotePath`（面板当前目录 > 标签 `sftpPath` > `shellCwd`） |
| `docs/winscp-realpath-fix.md` | 新增：源码级根因、三种用户侧绕过方式、回归说明 |
| `verify-winscp-args.js` / `verify-winscp-open.js` | 各自补 7 / 5 条断言 |

## 回归

- `run-verify --pure`：**13/13 脚本、135 断言全绿**（`verify-winscp-args.js` 25 → **32**）
- `verify-winscp-open.js`（真启动 Electron + shell 桩）：**32/32**（新增：argv 里确实出现 `/rawsettings SFTPRealPath=off`、`RemoteDirectory=/srv/my dir` 整段到达、payload 起始目录优先级、相对路径丢弃）
- 无退化：`verify-sftp-panel` 5/5、`verify-sftp-download-many` 16/16、`verify-key-forward` 7/7、`verify-ai-copy` 11/11

## 升级提示

- 覆盖安装即可；设置里 `WinSCP 打开方式` 三档（替代内置面板 / 面板加按钮 / 只用内置面板）不变。
- 若关掉 REALPATH 后仍报「找不到目录」，说明起始目录在 chroot 之外：删掉该会话的「远程目录」/ 换一个能访问的路径即可（`docs/winscp-realpath-fix.md` 有手工绕过方式）。
