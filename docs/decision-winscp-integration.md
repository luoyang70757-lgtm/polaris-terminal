# 技术决策：是否集成 WinSCP 的 SFTP 实现

> 结论：**不集成**。把 WinSCP（https://github.com/winscp/winscp）的 SFTP 代码与本项目搭配使用，
> 只有"Windows 专属、可选子进程"这一条路勉强成立，产品上不划算；它真正能补的三个能力
> （权限编辑、目录同步、限速）用现有 `ssh2` 基础设施 3~6 天就能自己做完，且跨平台。
> 本文记录判定依据，避免以后重复评估。

## 三种"搭配"方式，逐个判定

| 方式 | 说明 | 判定 |
|---|---|---|
| A. 链接/嵌入 | 把 `source/core/SftpFileSystem.cpp` 编成库，链进 Electron 主进程 | **不可行**（平台/编译器/许可三重硬墙，见下） |
| B. 子进程引擎 | Windows 上装 WinSCP，用 `winscp.com /script` 或 `WinSCPnet.dll` 遥控，把它当"下载/上传引擎" | **技术可行，产品不划算**（见"代价"） |
| C. 只取思路与功能清单 | 用 `ssh2` 原生补齐 WinSCP 有、我们没有的能力 | **推荐** |

## A 不可行的硬性证据（都已在本仓库之外可复核）

1. **平台**：WinSCP 是 Windows-only 的原生 Win32 桌面程序（readme 首句即 "file manager for Windows"）。
   本项目要跑 Windows + macOS（CI 只编 Windows，本机 `npm run dist` 出 `.app`）。WinSCP 没有
   macOS/Linux 版本，也不存在可移植分支。
2. **编译器锁死**：仓库里 17 个 `.cbproj` + 1 个 `.groupproj`（Embarcadero C++Builder / RAD Studio 工程），
   **没有 CMake、没有 MSVC 工程**（`libs/` 下的 CMake 只在第三方 expat 库里）。构建说明要求
   "Embarcadero C++Builder 11 Professional" —— Windows-only 的商业专有 IDE。macOS 上根本无法
   产出二进制。
3. **"非可视化核心"也不是库**：`source/core/CorePCH.h` 第一行就是 `#include <vcl.h>`，还带
   `Winapi.Windows.hpp`、`System.SysUtils.hpp` 等 C++Builder RTL 头 → 即使 `source/core`
   标称"non-visual"，仍然绑 VCL + Win32 + Borland RTL。它**没有公共 C ABI、没有版本化头文件契约**，
   `Interface.h` 里全是 GUI 侧的 switch/字符串常量。`SftpFileSystem.cpp` 直接跟
   `CopyParam`/`Queue`/`FileOperationProgress` 耦合，脱离 app 框架无法单独用。
4. **许可**：整仓 **GPLv3**（`license.txt` 首条 "GNU General Public License"）。把 GPLv3 代码
   链接进本项目（闭源发布）→ 整个应用必须 GPLv3 开源，直接终结当前的商业分发模式。
   （唯一标 MPL-2.0 的是 `dotnet/license-dotnet.txt` 里的 `WinSCPnet.dll`，见方式 B。）

## B 的代价清单（假如硬要走子进程）

- **只有 Windows 有这功能** → 功能矩阵分叉，macOS 用户永远拿不到；两套传输引擎要各自测试。
- **运行时依赖第三方安装包**：要么用户自己装 WinSCP，要么随包分发（GPLv3 合规：附许可文本 +
  提供对应源码获取方式），还要处理"没装/版本不对/路径被改"。
- **自动化接口天生不适合做 UI 引擎**：`winscp.com /script` 的进度是**控制台文本**，`WinSCPnet`
  是外部进程 + 事件回调；拿它做 Polaris 现在这套「传输队列 / 单条进度条 / 取消 / 断点续传
  记录」只能靠解析文本，精度和取消语义都退化。
- **凭据落盘**：命令行/脚本模式要把密码或私钥路径写进临时脚本或参数 —— 现在是
  `safeStorage` 加密 + `enc:v1:` 前缀走 IPC，这一改是安全上的倒退。
- **堡垒机语义全部要重做**：KoKo 网关的复合用户名、H3C 的 `accessclient://` 一次性 OTP、
  `sftp_home` chroot、H3C/KoKo 类设备"SFTP 串行处理"（`SFTP_CONCURRENCY = 2`）——
  v1.0.13 刚为这些踩完坑，换成外部引擎等于把 5 个真实成因重新踩一遍。
- **法律口径**："独立进程 + 官方命令行接口"通常被视为 separate program，可以绕开 GPL 传染，
  但这需要法务确认，且**永远是一份风险**。

## C：WinSCP 有、我们没有的，其实只有三件

对照本仓库的 SFTP 现状（`main.js` 15 个 `sftp:*` IPC：list/home/download/downloadMany/batchDownload/
upload/uploadPaths/batchUpload/mkdir/rename/delete/rmdir/readFile/writeFile/cancel，加断点续传、
批量进度、失败项串行重试、符号链接按真实类型递归），真正缺的是：

| 能力 | WinSCP 的做法 | 我们的实现路径 | 工作量 |
|---|---|---|---|
| **权限/属主/时间戳编辑**（chmod/chown/utimes） | 属性对话框、递归改权限 | `ssh2` 原生支持 `sftp.chmod/chown/utimes`（也有 `setstat`）；加 3 个 IPC + 一个属性对话框 | 0.5~1 天 |
| **目录同步 / keep-up-to-date** | `synchronize` + 定时监视，带预览比对 | 复用现成 `walkRemote`（`lib/ssh-client.js`，已含失败跳过/软链防环）+ 下载/上传引擎 + `stat` 比对，界面出"差异清单（新增/更新/删除）" | 2~4 天 |
| **传输限速** | `-speed=` 参数 + 全局限速 | 在 `downloadFile`/上传流的 chunk 上加 token bucket | 0.5 天 |
| SFTP v4~v6 | 支持 v3~v6 | `ssh2` 只到 v3；换库成本高，且 v3 兼容性最好（OpenSSH/KoKo/H3C 全跑 v3） | 不做 |
| SCP 协议 | 有（老设备保底） | 现有堡垒机路径都走 SFTP；`ssh2` 也能 exec，需要时按"命令通道"补 | 暂不做 |
| sudo 提权 SFTP | 非 root 账号用 `sudo` 起 sftp-server 专属技巧 | 与堡垒机场景冲突（网关内本来就有权限模型），收益窄、坑多 | 不做 |

## 建议

1. **不引入 WinSCP**（不链源码、不分发二进制、不弹子进程）。
2. 按上表 C 自己补：**权限/属主/时间戳对话框**（最实用、半天见效）→ **传输限速** →
   **目录同步 + 差异化预览**（这块是当前 SFTP 面板唯一明显的功能缺口）。
3. 如果以后确实要"同步"的高阶形态（双向、冲突解决、断点续同步），也仍然在 `walkRemote` +
   现有引擎上长，不要引入第二套传输栈。
4. 若只是想支持更多协议（S3/WebDAV/FTP），WinSCP 帮不上 —— 那些是它另外几十万行
   `S3FileSystem.cpp`/`WebDAVFileSystem.cpp` + neon/expat 依赖，同样 GPL + C++Builder 锁死。
   需要的话应选独立库（如 `basic-ftp`、AWS SDK）单点引入。

## 复核方式

```bash
# 许可：GPLv3（整仓）/ MPL-2.0（仅 dotnet 程序集）
head -8 license.txt            # A. GNU General Public License
head -2 dotnet/license-dotnet.txt   # Mozilla Public License Version 2.0

# 编译器锁死：只有 C++Builder 工程，无 CMake / MSVC
git ls-tree -r --name-only HEAD:source | grep -oE "\.[a-z]+proj$" | sort | uniq -c   # 17 .cbproj

# 核心不是库：绑 VCL + Win32 + C++Builder RTL
curl -s https://raw.githubusercontent.com/winscp/winscp/master/source/core/CorePCH.h | head -12
```

---

## 附录：假如「只考虑 Windows」（平台障碍解除后的重新评估）

结论不变：**仍然不把 WinSCP 当 SFTP 引擎**。平台这一条确实被解除了（Windows 上原生程序合法、也
能编），但另外三道墙原样立着：

| 原障碍 | Windows-only 下是否解除 | 说明 |
|---|---|---|
| 平台（Windows-only 原生） | ✅ 解除 | 交付目标只有 Windows 时不再是问题 |
| 编译器锁死（C++Builder） | ⚠️ 半解除 | Windows 上**能**编，但要买 Embarcadero RAD Studio（商业专有，每年授权），且改一行 WinSCP 源码就得长期维护这套异质工具链 |
| 不是库、绑 VCL/Win32 | ❌ 不解除 | `CorePCH.h` 仍是 `#include <vcl.h>`；没有公共 C ABI。要"嵌"就得自己写一个 C++Builder 的 DLL 桥 + 消息循环，把 SFTP 从 `CopyParam`/`Queue`/GUI 回调里剥出来 |
| 许可 GPLv3 | ❌ 不解除 | 链接进闭源应用 = 整体 GPLv3。只有"独立进程 + 官方命令行接口"的 aggregation 说法才勉强安全 |

所以在 Windows-only 下，「搭配使用」变成三个可做的档位，收益/代价如下。

### 档 1：把 WinSCP 当 SFTP 引擎（替换 ssh2）— **强烈不建议**

- **没有持久会话可用**：`winscp.com /script` 是一次性批处理；想常驻要自己养一个控制台进程，
  往 stdin 喂命令、从 stdout 解析 `winscp>` 提示符和结果。文件浏览器每秒都在 listdir，等于把
  一个结构化协议降级成**人类可读文本协议**。
- **要解析人类可读输出**：`ls` 的列宽/时间格式随 locale 变、文件名含空格/竖线/中文/emoji、
  软链接带 `->`、错误靠英文文案匹配 → 现在 `sftp:list` 拿到的是 `readdir` 结构体，换成文本解析是**明确的退步**。
- **二进制不再流式**：远端编辑（`readFile`/`writeFile`）、上传下载都变成"落临时文件 + get/put"，
  大文件双倍磁盘写、进度只能解析 `xx%` 文本行、取消只能 kill 进程（SSH 会话一起断，下次重连）。
- **好不容易修好的稳健性要重踩**：v1.0.13 的 5 条（子目录失败隔离、并发 2、失败项串行重试、
  软链按真实类型递归、批量 total）在外部引擎模型里**全部失效**，得对着它的输出重新实现一遍。
- **凭据要外泄到命令行/临时 ini**：现在是 `safeStorage` + `enc:v1:` 走 IPC，改完是安全负资产。
- 估：做到"能替代现有面板"约 **3~6 周**，上限还低于现在。

### 档 2：只把「目录同步 / keepuptodate」外包给 WinSCP CLI — 收益中等，可做但要克制

只在这一个功能上用它（`synchronize` / `keepuptodate` 是控制台命令，正好是我们缺的），主 SFTP
面板仍走 `ssh2`：

- 前提：用户机器上有 WinSCP（**检测到才显示这个按钮**），我们不随包分发 → 完全没有 GPL 义务。
- 只传必要信息：`winscp.com /command "open sftp://user@host/" ...`，密码用临时 ini/`/ini:` 或
  让用户在 WinSCP 侧输一次（**不要把密码放进命令行**，它会被进程列表/任务管理器看到）。
- 代价：多一个"外挂进程 + 文本进度"的 UI 分支；跨语言错误文案要翻译；用户没装就没有这功能。
- 估：**3~5 天**（含探测、参数拼装、进度解析、失败提示）。收益：拿到成熟的 keepuptodate
  （定时轮询 + 差异比对 + 删除策略），省掉我们自己写同步引擎的 2~4 天。

### 档 3：「用 WinSCP 打开此会话」外链 — **推荐（零成本）**

> ⚠ 本节是决策时的原始口径；v1.0.15 实际落地时**改成默认外链且传密码**（用户要求自动登录），以文末「已实现」为准。

- 菜单/右键加一项：已装 WinSCP 时，把当前会话变成 `sftp://user@host:port/` 交给 `winscp.exe`
  （终端用户拿到的就是完整的 WinSCP：同步、权限对话框、限速、双窗格）。
- 我们**不分发、不链接、不解析输出**，只是 `shell.openExternal` 一个本地程序 → GPL 问题、引擎
  耦合、文本解析问题全部不存在。
- （原始口径）注意：**不要把密码拼进 URL**（会进进程列表/历史/日志）；由用户在 WinSCP 里输一次，或复用
  WinSCP 自己的已保存会话。→ **v1.0.15 已改为传密码 + 日志全脱敏**，见文末。
- 估：**2~4 小时**。

### 仍然建议的主线（Windows-only 同样成立）

| 能力 | 我们的实现路径 | 工作量 |
|---|---|---|
| 权限/属主/时间戳对话框（chmod/chown/utimes） | `ssh2` 原生 API + 3 个 IPC | 0.5~1 天 |
| 传输限速 | 传输流 token bucket | 0.5 天 |
| 目录同步 + 差异预览（新增/更新/删除清单） | 复用 `walkRemote` + 现有引擎 | 2~4 天 |
| （可选）已装 WinSCP 时「用它打开此会话」 | `openExternal` | 2~4 小时 |

**一句话**：只考虑 Windows 只是去掉了"编不出来"这一条，`GPL + 不是库 + 文本协议降级` 这三条
依然成立；WinSCP 值得被"请来做客"（档 2/档 3），不值得"请来当引擎"（档 1）。

---

## 已实现（v1.0.15）：档 3 外链，且升级为默认行为

> 上面「档 3」是**决策时的原始评估**（当时按"零成本、可选入口、不传密码"写的）。实际落地时
> 用户明确要求「点 SFTP 就把本机 WinSCP 拉起来，主机/账号/密码自动带过去」，所以：
> **默认行为改成"直接开 WinSCP"，密码进 argv（本条被需求推翻）**，代价用"绝不写日志"兜底。
> 以下为实现口径，与上文冲突处以本节为准。

### 落地内容

| 位置 | 内容 |
|---|---|
| `lib/winscp-open.js`（新，纯函数） | `CANDIDATES`（`%ProgramFiles%\WinSCP` / `%ProgramFiles(x86)%` / `%LOCALAPPDATA%\Programs\WinSCP` / scoop / chocolatey 两处）、`expandEnv`（`%VAR%` 大小写不敏感）、`detectExe({platform, env, exists})`（`POLARIS_WINSCP_PATH` 优先且**只认它**；`platform !== 'win32'` → `null`）、`buildSessionUrl`（user/password `encodeURIComponent`）、`redactUrl`、`buildArgs`（`-privatekey=` / `-passphrase=` / 调试时 `/log`+`/loglevel=1`）、`describeCommand` |
| `main.js` | `ipcMain.handle('winScp:detect')`、`ipcMain.handle('winScp:open')`：telnet 拒绝、未装提示、`spawn(exe, args, {detached:true, stdio:'ignore'})` + `unref()`（Polaris 退出后 WinSCP 继续可用） |
| `preload.js` | `winScpDetect()` / `winScpOpen(payload)` |
| `src/index.html` | 设置项 `#set-winscp-mode`（三档）+ SFTP 工具栏 `#btn-sftp-winscp` |
| `src/renderer.js` | `winScpMode()` / `refreshWinScpButton()` / `detectWinScp()` / `winScpPayloadFor()` / `openSessionInWinScp()`；`toggleSftpPanel` 在 `replace` 档改为「先试 WinSCP，失败/未装即回落内置面板」；标签右键菜单加「🪟 用 WinSCP 打开 SFTP」 |

### 三档语义（设置 → SFTP）

| 值 | 行为 |
|---|---|
| `replace`（默认） | 点「SFTP」→ 直接拉起本机 WinSCP；**没装/拉起失败自动回落内置面板**（功能一定不消失） |
| `button` | 点「SFTP」→ 内置面板；面板工具栏多一个「🪟 WinSCP」按钮，另可从标签右键菜单走 |
| `panel` | 只用内置面板，WinSCP 入口完全不出现 |

入口显隐**只依赖 `state.winScp.installed`**（探测不到就什么都没有），避免"按钮在、点了必报错"。

### 密码进 argv：为什么接受，以及怎么控风险

WinSCP 没有库 API，也读不到 Electron 的 `safeStorage`，想"自动登录"只有三条路：
命令行会话 URL / 临时 ini / 让用户在 WinSCP 里再输一次。选了 URL（`sftp://user:pw@host:port/`，
user/password 全 `encodeURIComponent`），配套硬约束：

1. **不落盘**：不写临时文件、不写 ini、不进 shell 历史（直接 `spawn`，不经 shell）。
2. **不写日志**：`redactUrl` 把密码压成 `***`，`describeCommand` 对 URL 参数与 `-passphrase=` 同样脱敏；
   `termDebug`、状态栏、`logs/app-*.log` 一律只见 `sftp://user:***@host:22/`（回归脚本专门断言
   明文与 `p%40ss` 编码串都不出现）。
3. **风险边界写在文档里**：本机管理员/同用户进程列表可见 argv，这是"自动登录"的固有代价；
   不想要就把设置切到 `button`/`panel`（那两档不传密码）。

### 其它口径

- **堡垒机不拆用户名**：`jms@ssh@账号@资产IP` 原样整体编码（KoKo 网关要的就是这个形态），
  `displayHost/displayPort` 只做展示、绝不用于连接。
- **主机指纹不共用**：WinSCP 用 PuTTY 风格 host key，与我们的 `known_hosts` 无关 → 首次信任交给
  WinSCP 自己问（我们不静默信任）。
- **私钥**：Polaris 存的 `private_key` 是路径，直接 `-privatekey=`；文件不存在就不传（让 WinSCP
  弹自己的登录框），有口令才 `-passphrase=`。
- **不开 GPL 义务**：不随包分发 WinSCP 二进制、不 fork 源码、不链接其代码——只是在用户已装时
  `spawn` 它。
- **非 Windows 自动隐身**：`detectExe` 对 `darwin/linux` 直接返回 `null`，macOS 用户看不到任何
  WinSCP 入口（本机也无法 e2e 验证真实拉起，靠 `POLARIS_WINSCP_PATH` 指到 shell 桩来测参数与脱敏）。

### 回归

- `verify-winscp-args.js`（纯 Node，25 条）：探测顺序 / 环境变量覆盖 / URL 编码（`@ : / # ? % &` 空格、
  无密码、无端口、IPv6、复合用户名）/ 缺主机报错 / 脱敏 / 参数组装。
- `verify-winscp-open.js`（真启动 electron，27 条）：桩程序收到 argv、脱敏（渲染层 dlog + 落盘日志 +
  状态栏三处）、telnet 与缺主机拒绝、三档行为（replace 拉起 / 未装回落面板 / button 出按钮 /
  panel 隐身）、标签右键菜单项显隐、渲染层入口返回值与状态栏反馈。

## 追加（v1.0.16）：必须带 `SFTPRealPath=off`

v1.0.15 上线后用户实测立刻踩到 WinSCP 的经典坑：

```
不能获得'.'的真实路径。一般错误（服务器应该提供错误描述）。
错误码：4，服务器返回的错误消息：General failure
```

源码定位（`winscp/winscp` master）：

- `source/core/SftpFileSystem.cpp:2976` `FHomeDirectory = RealPath(L".");` —— 建会话时对 `"."` 求真实路径当作家目录；
- 同文件 `:2785` `RealPath()`：只有 `SessionData->SFTPRealPath == asOff` 才走 `LocalCanonify`（纯本地拼接），否则发 `SSH_FXP_REALPATH`；
- `source/core/SessionData.cpp:303` 默认 `asAuto`。

所以只要服务器不支持/拒绝 REALPATH（chroot 型：KoKo 网关、H3C 网关、`internal-sftp` chroot、老 ProFTPD…），
WinSCP 连会话都开不起来。Polaris 自己的 SFTP 面板之所以没这问题，是因为我们**从不发 REALPATH**（家目录用
`exec pwd` + `readdir` 验证），路径一律按字符串使用。

**决定：每次拉起都下发 `/rawsettings SFTPRealPath=off`**，不做事前探测：

- 探测要真开一条 SFTP 通道，H3C/KoKo 类网关可达 15~20s，点一下「SFTP」等 20 秒不可接受；
- `off` 只关掉"服务器端 canonicalize"，对正常 OpenSSH 服务器同样可用（`LocalCanonify` 不访问服务器）；
- 想保留 WinSCP 原生行为：`POLARIS_WINSCP_REALPATH=on|auto`。

配套：把 Polaris 已知的绝对路径作为 `RemoteDirectory` 一起交过去（面板当前目录 > 标签 `sftpPath` >
跟踪的 `shellCwd`；相对/未知不传），这样 WinSCP 打开就落在用户刚才所在的位置，而不是自己猜（猜错会报
「目录不存在」）。

回归：`verify-winscp-args.js` 32/32（新增 `RAW_SETTINGS_DEFAULTS`/`/rawsettings` 拼装/空值跳过/带空格中文目录/
与私钥口令共存顺序/`normalizeRemotePath`/`realPathCompat`）+ `verify-winscp-open.js` 32/32（argv 里确有
`SFTPRealPath=off`、`RemoteDirectory=/srv/my dir` 整段到达、payload 起始目录优先级、相对路径丢弃）。
手工绕过（不改 Polaris）：WinSCP 站点「高级 → Canonicalize paths on the server = Off」，
或命令行 `/rawsettings SFTPRealPath=off`，或站点 ini 里加 `SFTPRealPath=off`。

### 追加（v1.0.21）：WinSCP 日志默认开启 + rawsettings 逃生阀

- 现场反馈：`SFTPRealPath=off` 之后 WinSCP 仍报「错误码 4 / General failure」（报错文字已变，说明 REALPATH 那步
  已经不发了，失败点移到 `TryOpenDirectory` 的 `SSH_FXP_LSTAT` 或更后面）。
- 因此**日志默认就写**（`<数据目录>/logs/winscp-<时间戳>.log`，`/loglevel=1` 请求级，不含口令/文件内容），
  拉起日志里给出 `日志=<path>`；`POLARIS_WINSCP_DEBUG=1` → `/loglevel=*`。
- `POLARIS_WINSCP_RAWSETTINGS=名=值;名=值` 叠加覆盖默认 rawsettings —— 让用户在**现场试开关**，
  不必为每个 WinSCP 兼容性问题发一次版；解析在纯函数 `parseRawSettings()` 里（非法条目整条丢弃，不拼怪 argv）。
