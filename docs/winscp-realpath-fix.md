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

## 六、v1.0.21：关掉 REALPATH 之后**仍**报「错误码 4」

现场特征（Windows 实测日志）：

```
[WINSCP] 已拉起: …WinSCP.exe sftp://root:***@h3c-bastion.example:22/ /rawsettings SFTPRealPath=off
→ WinSCP 弹「一般错误（服务器应该提供错误描述）。错误码：4，服务器返回的错误消息：General failure」
```

要点：**报错文字变了** —— 不再是「不能获得'.'的真实路径」，而是裸的 `错误码 4 / General failure`。
说明 `SFTPRealPath=off` 生效了（REALPATH 那一步已经不发了），失败点换到了**后面某一个请求**上。

按 WinSCP 的启动顺序，`GetHomeDirectory()` 之后紧跟的是：

| 顺序 | 位置 | 发什么 |
|---|---|---|
| 1 | `SftpFileSystem.cpp:2976` | `REALPATH(".")`（已用 `off` 关掉 → 改本地 canonify） |
| 2 | 同文件 `:3510` `ChangeDirectory` → `:3481` `TryOpenDirectory` | 先发 **`SSH_FXP_LSTAT`**，收到"不支持"才退化成 `OPENDIR` |
| 3 | 同文件 `ReadDirectory` | `SSH_FXP_OPENDIR` + `SSH_FXP_READDIR` |

`TryOpenDirectory` 只在服务器回 `SSH_FX_OP_UNSUPPORTED`（8）时才走退化路径；**回 4（FAILURE）就是致命错误**
—— 所以「H3C/嵌入式 SFTP 不实现或拒绝 `LSTAT`」这类服务器会在这里挂掉。

### 排障步骤（v1.0.21 起可开日志；**v1.0.24 起默认关闭**，见第八节）

1. 复现一次失败；
2. 先开日志环境变量 `POLARIS_WINSCP_LOG=1`，再复现；
3. 打开 `调试 → 打开日志目录`，取 `logs/winscp-<YYYYMMDD-HHMMSS>.log`（**级别 1 = 请求级**，含主机/用户名，
   **以及会话 URL 里的明文口令** —— 共享前先删）；
4. 看最后几行「请求 + 服务器返回状态」：

```
> 正在获取 '…' 的真实路径 / Trying to open directory "…" / Listing directory "…"
< 状态：4 (失败)
```

哪一行后面跟 `4` 就是真凶：

| 失败在 | 判定 | 绕过 |
|---|---|---|
| `REALPATH` | `off` 没生效（检查 argv 里是否真有 `/rawsettings SFTPRealPath=off`） | 命令行手工加同一个开关验证 |
| `LSTAT` / `OPENDIR` | 服务器不认这个请求（嵌入式/非标准 SFTP） | 用 `POLARIS_WINSCP_RAWSETTINGS` 试开关；或改用 Polaris 内置面板 |
| `OPEN` / `READ` | 目标路径在 chroot 外 / 权限不足 | 换 `RemoteDirectory` 或改用内置面板 |

### 逃生阀：自己下发 WinSCP 开关

```
set POLARIS_WINSCP_RAWSETTINGS=SFTPRealPath=on;RemoteDirectory=/tmp
```

- 分号或换行分隔，`名字=值`；名字只收 `[A-Za-z]` 开头的标识符，空值丢弃，非法条目整条忽略；
- 叠加在 Polaris 的默认值之上（**同名覆盖**），所以 `SFTPRealPath=on` 可以临时恢复 WinSCP 原生行为；
- 排障想看到协议包：`set POLARIS_WINSCP_DEBUG=1` → `/loglevel=*`（**含口令/文件内容**，共享前先删）。

### 交叉验证（判断是 WinSCP 的问题还是服务器的问题）

同一台主机在 Polaris 里切到 **设置 → SFTP → 「内置面板」**（或用另一台机器的 WinSCP 图形界面手动连）：
- 内置面板能列出目录 → 服务器 SFTP 正常，问题在 WinSCP 的请求序列（看日志定位到具体请求）；
- 内置面板也列不出来 → 服务器 SFTP 子系统本身有问题（WinSCP 报 4 只是它的说法）。

### 变更

| 文件 | 改法 |
|---|---|
| `lib/winscp-open.js` | 新增 `parseRawSettings()`；`buildArgs()` 从"只在 debug 时写日志"改为**给了 `logPath` 就写** `/log=<path> /loglevel=1`（`debug` → `*`） |
| `main.js` | `winScp:open` 默认在 `<数据目录>/logs/winscp-<时间戳>.log` 落 WinSCP 日志（先 `mkdir` 再拉起）；`POLARIS_WINSCP_RAWSETTINGS` 合并进 rawsettings；拉起日志里带 `日志=<path>` |

回归：`verify-winscp-args.js` **34/34**、`verify-winscp-open.js` **39/39**（新增日志参数/日志落点/目录预建三条）。

## 七、v1.0.22：内网设备的终极退路 —— 改用 SCP

排查表里「LSTAT / OPENDIR 被回 4」那一行,到了 v1.0.22 有了不用改代码的解法:

**设置 → SFTP → WinSCP 协议 = SCP** → WinSCP 用 `scp://` 会话,文件传输走服务器上的 `scp` 命令。

- 整个 SFTP 子系统(REALPATH / LSTAT / OPENDIR / READDIR / SETSTAT …)一个请求都不发,所以"回 4"这类
  半残实现完全绕开;
- 命令形态:`WinSCP.exe scp://user:pw@host:2222/ /log=… /loglevel=1`(不再带 `SFTPRealPath=off`);
- 代价:SCP 只有 `scp` 命令的能力——没有远端复制/改名、不保留时间戳、单文件不能断点续传、列目录走
  `ls -l` 解析(特殊文件名可能出偏差);大目录明显慢。**能用 SFTP 就别用 SCP**。
- 服务器上没有 `scp` 命令(纯 sftp-server 的精简系统)→ SCP 也进不去,那就只剩内置面板/或让设备侧开 SFTP。

同时默认档兜底:点 SFTP 现在默认开**内置面板**(`button`),WinSCP 变成按需按钮——
再怎么折腾 WinSCP 也挡不住日常传文件。

## 八、v1.0.24：真机日志把两件事同时钉死了

来自 Windows 现场的三份 WinSCP 会话日志（同一台机器，WinSCP 6.7.1 / Windows 11）：

| 日志 | 起始目录 | 结果 |
|---|---|---|
| 第一次 | argv 带 `RemoteDirectory=/root` | ✅ 正常（`OPENDIR /root` → `READDIR` → `Status code: 1` = 读完 EOF） |
| 第二次 | argv 带 `RemoteDirectory=/root` | ✅ 正常 |
| 第三次 | argv **没有** `RemoteDirectory` | ❌ `SSH_FXP_OPENDIR "."` → `Status code: 4, Server: General failure` → 弹「列出'.'的目录项时出错。错误码：4」 |

也就是说 `SFTPRealPath=off` 之后，**剩下唯一会翻车的就是"起始目录是相对路径 `"."`"**：

- `off` 已经让 WinSCP 不再发 `REALPATH(".")`，但它接着就用 `"."` 去 `OPENDIR` 列目录
  （`SftpFileSystem.cpp` 里 `RealPath` 关掉后走 `LocalCanonify`，`"."` 原样留着）；
- 该设备（`sshd-core 1.7.0 (org.apache.sshd)`，Apache MINA）对**相对路径**的处理就是直接回 4，
  不认 cwd —— `"."` 必挂；换成绝对路径 `/root` 立刻正常。

两条改法（都在 v1.0.24）：

| 改动 | 说明 |
|---|---|
| **起始目录一律给绝对路径** | 渲染层知道面板目录/标签 `sftpPath`/跟踪的 `shellCwd` 就用它；**不知道时主进程当场探一次家目录**（`resolveSftpHome`：exec `pwd` → SFTP `readdir` 校验 → 不可访问回退 `/tmp`，与 SFTP 面板同一套逻辑），归一化成绝对路径再当 `RemoteDirectory`。极端情况下连探都失败（连接已断），才回到"不给 `RemoteDirectory`"的老行为 |
| **WinSCP 日志默认关闭** | `/loglevel=1` 的日志里 `Parameter:` 行是**明文会话 URL（口令 URL 解码后原样）**：`Parameter: sftp://root:OTP%3AtirPq3FdQN6n@host:22/`。默认开着 = 把口令写进 `<数据目录>\logs\winscp-*.log`。要排障就显式 `POLARIS_WINSCP_LOG=1`（级别 1）或 `POLARIS_WINSCP_DEBUG=1`（`*` 全协议包）；两种都含口令，共享前先删文件 |

另外两条结论，免得后人再绕：

- **"独立 SFTP 探测失败(General failure) → 回退主连接成功"** 说明这类网关对**新建连接的 SFTP 子系统**和
  **已登录会话里的 SFTP 通道**宽容度不一样；WinSCP 永远是新建连接，所以它在"相对路径/不支持的请求"上比内置面板脆弱得多。
  内置面板能用不代表 WinSCP 一定能用，反之亦然。
- 现场若仍失败，`SCP`（设置 → SFTP → WinSCP 协议 = SCP）是最后一条不改代码的路（第七节），
  它连 `OPENDIR` 都不发。

回归：`verify-winscp-args.js` **39/39**（新增 `logOptions()`：默认关、`LOG=1` 开、`DEBUG=1` 全量、`loglevel=0` 不写）、
`verify-winscp-open.js` **46/46**（默认 argv 里没有任何 `/log`、也不生成 `winscp-*.log`、payload 带 `sessionId`）。
