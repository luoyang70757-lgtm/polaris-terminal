# v1.0.21 发布说明 — WinSCP 排障日志（默认开启）+ rawsettings 逃生阀

> Windows 只发布便携版：`Polaris.Portable.1.0.21.exe`（不再产出 NSIS 安装版）。

## 为什么做这一版

v1.0.16 给 WinSCP 加了 `/rawsettings SFTPRealPath=off`，解决了 chroot 型服务器上
「不能获得'.'的真实路径（错误码 4）」那一条。但现场又报了**另一种**错误码 4：

```
[WINSCP] 已拉起: C:\Program Files (x86)\WinSCP\WinSCP.exe sftp://root:***@h3c-bastion.example:22/ /rawsettings SFTPRealPath=off
WinSCP → 一般错误（服务器应该提供错误描述）。错误码：4，服务器返回的错误消息：General failure
```

报错文字变了（没有"'.' 的真实路径"），说明 `off` 生效、`SSH_FXP_REALPATH` 那一步已经不再发，
失败点移到了启动序列里**后面的某个请求**。而 WinSCP 自己的日志此前只在 `POLARIS_WINSCP_DEBUG=1` 时才写，
用户拿不到证据 —— 所以这一版先把"看清现场"这件事做掉，不做猜着改的开关。

## 改动

### 1. WinSCP 日志默认就写（级别 1）

- 路径：`<数据目录>/logs/winscp-<YYYYMMDD-HHMMSS>.log`（Windows 便携版默认数据目录即 exe 同级 `data/`，
  若显式设了 `POLARIS_LOCK_DIR` 则用它）；
- 级别：`/loglevel=1` —— **请求级**（`Trying to open directory "…"` / `Listing directory "…"` /
  服务器返回状态码），**不含口令与文件内容**；
- Polaris 拉起日志里直接给出 `| 日志=<path>`，菜单 `调试 → 打开日志目录` 就能取到文件；
- `POLARIS_WINSCP_DEBUG=1` → `/loglevel=*`（全协议包，**含口令/文件内容**，共享前先删）。

`buildArgs()` 的语义随之调整：**给了 `logPath` 就下发** `/log=… /loglevel=…`（不再用 `debug` 当开关）；
空/空白路径整组不传，避免 WinSCP 收到空的 `/log=`。

### 2. `POLARIS_WINSCP_RAWSETTINGS` 逃生阀

```
set POLARIS_WINSCP_RAWSETTINGS=SFTPRealPath=on;RemoteDirectory=/tmp
```

- 分号或换行分隔 `名字=值`；叠加在默认 rawsettings 之上（**同名覆盖**）；
- 只收 `[A-Za-z]` 开头的名字与非空值，非法条目整条丢弃；
- 用途：排障时试 WinSCP 各种开关（不必等我们发版）、临时恢复 WinSCP 原生 REALPATH 行为。

## 怎么用它定位「错误码 4」

复现一次 → 取 `logs/winscp-*.log` → 看最后几条「请求 + 返回状态」：

| 失败在 | 判定 | 绕过 |
|---|---|---|
| `REALPATH` | `off` 没生效（检查 argv 里是否真有 `/rawsettings SFTPRealPath=off`） | 手工命令行加同一开关验证 |
| `LSTAT` / `OPENDIR` | 服务器不认这个请求（嵌入式/H3C 类 SFTP；`TryOpenDirectory` 对 4/FAILURE 直接报错） | 用 `POLARIS_WINSCP_RAWSETTINGS` 试开关，或改用内置面板 |
| `OPEN` / `READ` | 目标路径在 chroot 外 / 权限不足 | 改 `RemoteDirectory` 或改用内置面板 |

交叉验证：同一主机在 Polaris 里切 **设置 → SFTP → 内置面板** —— 面板能列目录说明服务器 SFTP 正常、
问题在 WinSCP 的请求序列；面板也列不出来说明服务器 SFTP 子系统本身有问题。

详细推导与源码定位见 `docs/winscp-realpath-fix.md` 第六节。

## 回归

| 脚本 | 结果 | 覆盖 |
|---|---|---|
| `verify-winscp-args.js`（纯 Node） | **34/34** | 日志参数默认下发 / debug 换 `*` / 空路径不传 / `parseRawSettings` 四类边界 / rawsettings 与私钥口令共存顺序 |
| `verify-winscp-open.js`（e2e） | **39/39** | argv 里确有 `/log=<数据目录>/logs/winscp-<时间戳>.log` + `/loglevel=1`、日志目录提前建好、`SFTPRealPath=off` 与 `RemoteDirectory` 仍在、脱敏不回退 |
| `run-verify --pure` | **17/17 脚本 339 断言**（原 17/337） | 全量纯 Node 基线无退化 |

## 升级注意

- 只是诊断增强，行为对正常 OpenSSH 服务器无变化（日志文件几十 KB）。
- 日志里**有主机地址与用户名**（级别 1 无口令/文件内容）；贴出去前自己看一眼。
- 若你的 WinSCP 会话此前靠 `POLARIS_WINSCP_REALPATH=on` 打开，本次不变，仍按该环境变量走。
