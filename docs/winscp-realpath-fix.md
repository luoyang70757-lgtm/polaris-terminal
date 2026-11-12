# WinSCP「不能获得 '.' 的真实路径（错误码 4）」— 成因与修法（v1.0.16）

> 现象：Polaris 点「SFTP」拉起本机 WinSCP 后，WinSCP 弹：
>
> ```
> 不能获得'.'的真实路径。一般错误（服务器应该提供错误描述）。
> 错误码：4，服务器返回的错误消息：General failure
> ```
>
> 之后会话打不开，连目录都列不出来。（错误文字随 WinSCP 语言包略有差异，核心是 `SFTP_FXP_REALPATH` 对 `"."` 失败。）

## 一、根因：WinSCP 建会话时对 `"."` 发了一次 REALPATH

WinSCP 源码（`winscp/winscp`，master）里的调用链是确定的：

| 位置 | 内容 |
|---|---|
| `source/core/SftpFileSystem.cpp:2976` | `FHomeDirectory = RealPath(L".");` —— 打开 SFTP 会话/初始化家目录时对 `"."` 请求真实路径 |
| 同文件 `:2785` `TSFTPFileSystem::RealPath(Path)` | 若 `SessionData->SFTPRealPath == asOff` → 直接 `return LocalCanonify(Path)`（**不发请求**）；否则发 `SSH_FXP_REALPATH` |
| 同文件 `:2888` `LocalCanonify` | 纯本地拼接：绝对路径原样返回，相对路径用当前目录拼绝对路径 |
| `source/core/SessionData.cpp:303` | 默认值 `SFTPRealPath = asAuto` |

也就是说：**WinSCP 默认会要求服务器把 `"."` 规范化成绝对路径**；服务器回 `SSH_FX_FAILURE`（错误码 4）时，WinSCP 直接把这次失败当致命错误抛出，会话打不开。

哪些服务器会这么回？都是「SFTP 根被 chroot / 路径空间受限」这一类：

- **JumpServer 的 KoKo 网关**（Linux 平台默认 `sftp_home=/tmp`，改成 `/root` 也一样是 chroot）
- **H3C / 各类网络设备网关**（`/shterm` 后台，SFTP 子系统只做最小实现）
- OpenSSH `internal-sftp -d` / `ChrootDirectory` 限制过的容器
- 老版本 ProFTPD `mod_sftp`、部分「SFTP 网关 / 文件交换平台」产品

Polaris 自己的 SFTP 面板不受影响，是因为我们从不发 REALPATH（家目录用 `exec pwd` 探测 + `readdir` 验证，见 `AGENTS.md` 的关键架构约定 2），路径一律按字符串用。

> 顺带区分一下：用户手册里「错误码 4」那一串常见原因（重命名到已存在文件、创建已存在目录、跨文件系统移动、磁盘满、配额超限）是在**具体文件操作**时报 4；这里的 4 出现在 **会话初始化阶段**，报文对象是 `"."`，所以只可能是 REALPATH 不被支持/被拒绝。

## 二、修法：下发 `SFTPRealPath=off`（v1.0.16 起默认）

`lib/winscp-open.js` 给每次拉起的命令都加了一段 rawsettings：

```
WinSCP.exe sftp://user:pass@host:port/ /rawsettings SFTPRealPath=off [RemoteDirectory=/root/www] [-privatekey=…] [-passphrase=…]
```

- `/rawsettings` 是 WinSCP 官方支持的**会话级 ini 设置**注入方式（多个「名=值」各自一个 argv，见 `commandline` 文档与 `source/core/Option.cpp` 的 `FSwitchMarks = "/-"`、`source/core/SessionData.cpp` 的 `FindSwitch(RawSettingsOption, …)`）。
- `SFTPRealPath=off` 让 `RealPath()` 走 `LocalCanonify`，**不再对 `"."` 发请求**，chroot 服务器也能正常打开。
- 顺手把 Polaris 已知的目录作为 `RemoteDirectory` 交过去（标签自己的 SFTP 路径 → 交互 shell 跟踪到的 `cd` 目录 → 已知则用，未知就不传），这样 WinSCP 打开就落在用户刚才所在的位置，而不是自己瞎猜。

实现落点：

| 文件 | 改动 |
|---|---|
| `lib/winscp-open.js` | `RAW_SETTINGS_DEFAULTS = { SFTPRealPath: 'off' }`；`buildArgs()` 支持 `rawSettings`（空值跳过、顺序稳定）；`normalizeRemotePath()` 只收绝对路径；`realPathCompat(env)` 决定是否下发 |
| `main.js` `winScp:open` | 组装 `rawSettings`（`SFTPRealPath=off` + 可选 `RemoteDirectory`），日志里额外记 `rawsettings=…`（只有设置，无凭据） |
| `src/renderer.js` `winScpPayloadFor()` | payload 增加 `remotePath`（面板当前目录 > 标签 `sftpPath` > `shellCwd`；相对路径丢弃） |

## 三、为什么「默认关」而不是探测后再关

- 探测要真开一条 SFTP 通道（H3C/KoKo 类网关开通道可达 15~20s），点一下「SFTP」等 20 秒不可接受；而 `off` 只影响「服务器端 canonicalize」，对正常 OpenSSH 服务器也完全可用（Symlink 场景下 WinSCP 会退回本地拼接，路径仍是服务器侧按字符串处理，不会写错位置）。
- WinSCP 官方给出这个选项就是给这类服务器用的（GUI 里同一项叫 **Canonicalize paths on the server**）。
- 想恢复 WinSCP 原生行为：`POLARIS_WINSCP_REALPATH=on`（或 `auto`）启动 Polaris 即可，此时只额外传 `RemoteDirectory`，不动 `SFTPRealPath`。

## 四、用户侧临时绕过（不改 Polaris 也能验证）

1. WinSCP 图形界面：会话 → **编辑** → **高级** → 环境/SFTP 区 → **Canonicalize paths on the server** 设为 **Off**，保存后重连；
2. 或者命令行加参数：`WinSCP.exe sftp://… /rawsettings SFTPRealPath=off`；
3. 或者站点 ini（`%APPDATA%\WinSCP.ini` 或便携版 `WinSCP.ini`）里该会话加一行 `SFTPRealPath=off`。

三种等价。若关掉后仍报别的错（比如「找不到目录」），那是 `RemoteDirectory` 猜错或该路径在 chroot 外，删掉 `RemoteDirectory`/清空「远程目录」再试。

## 五、回归

- `verify-winscp-args.js`（纯 Node，32 条）：`RAW_SETTINGS_DEFAULTS`、`/rawsettings` 参数拼装（多对、空值跳过、带空格/中文的目录整段传、与私钥/口令/日志共存顺序）、`normalizeRemotePath`、`realPathCompat`。
- `verify-winscp-open.js`（真启动 Electron + shell 桩，32 条）：argv 里确实出现 `/rawsettings SFTPRealPath=off`、`RemoteDirectory=/srv/my dir` 原样到达、渲染层 payload 的起始目录优先级与相对路径丢弃、脱敏不回退。
