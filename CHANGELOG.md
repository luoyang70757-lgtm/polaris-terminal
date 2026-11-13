# 更新日志

## v1.0.22（2026-11-13）

**「打开 SFTP 时」默认改成内置面板(不再默认拉 WinSCP)+ 新增「WinSCP 协议 SFTP/SCP」。**

上一版只是把 WinSCP 的日志装上了,但默认行为还是「点 SFTP 直接拉 WinSCP」——在 WinSCP 进不去的机器上
(比如报「错误码 4 / General failure」的 H3C 内网设备)等于每次点 SFTP 都先撞一次墙,还得手动回落到面板。
这版把默认摆正,并给受限设备留一条**绕过 SFTP 子系统**的路:

1. **默认 = 内置面板**(`button` 档):点 SFTP 直接开面板(该有的权限/限速/上传下载都在),WinSCP 变成面板工具栏
   里的「🪟 WinSCP」按钮——想用的时候才用,失败也影响不到你。
   老配置里**从没自己选过**的 `replace`(那是 v1.0.15 我们给的默认值)会自动迁到 `button` 并写回
   (`settingsVersion` 3 → 4 + `winscpModeMigrated` 一次性标记);**用户自己选过 `replace` 的不动**。
2. **WinSCP 协议可选 `SFTP` / `SCP`**(设置 → SFTP →「WinSCP 协议」,默认 SFTP):
   - `sftp://` 走 SFTP 子系统;
   - `scp://` 走服务器上的 `scp` 命令,**完全绕开 SFTP 子系统**——`LSTAT`/`OPENDIR` 被回成 4 的老设备
     (嵌入式/H3C 类)可以用它绕过去;
   - SCP 会话**不再下发** `SFTPRealPath=off`(那是 SFTP 专属开关,发了也只是让人误以为生效);
     日志/私钥/口令/`RemoteDirectory` 照常;`redactUrl`/`describeCommand` 同步支持 `scp://` 脱敏。
   - 不认识的协议值一律回落 `sftp`(绝不拼出怪 URL)。
3. SFTP 面板每次打开都重刷一次 WinSCP 按钮显隐(装/没装、模式改过立刻反映)。

回归: `verify-winscp-args.js` 34→**38**(scheme 默认/大小写/非法值回落/堡垒机复合用户名整体编码/`scp://` 脱敏)、
`verify-winscp-open.js` 39→**46**(默认档 = button、下拉首项顺序、v4 迁移两种情形、协议下拉、
`scp://` 真实拉起且不带 `SFTPRealPath`、面板打开重刷按钮)、`verify-sftp-panel` 5/5、`verify-sftp-attrs-dialog` 16/16、
`run-verify --pure` **17/17 脚本 343 断言**。

## v1.0.21（2026-11-13）

**修「SFTPRealPath=off 之后 WinSCP 还是打不开」——先让 WinSCP 自己说清是哪一步挂的。**

现场：Windows 上 `[WINSCP] 已拉起: …/rawsettings SFTPRealPath=off`，WinSCP 仍弹
「一般错误（服务器应该提供错误描述）。错误码：4，服务器返回的错误消息：General failure」。
注意**报错文字变了**（不再是「不能获得'.'的真实路径」），说明 `off` 生效、REALPATH 那步已经不发了，
失败点换到后面的请求上（按 WinSCP 源码，`GetHomeDirectory()` 之后紧跟 `TryOpenDirectory` → 先发
`SSH_FXP_LSTAT`，收到 4/FAILURE 直接致命；嵌入式/H3C 类 SFTP 很可能就栽在这）。

问题是我们此前只在 `POLARIS_WINSCP_DEBUG=1` 时才让 WinSCP 写日志 —— 用户拿不到证据，只能猜。这一版改两处：

1. **WinSCP 日志默认就写**：`<数据目录>/logs/winscp-<YYYYMMDD-HHMMSS>.log`，级别 1（请求级：含
   "Trying to open directory …" / "Listing directory …" / 服务器返回状态，**不含口令与文件内容**）；
   拉起日志里直接给出 `日志=<路径>`，`调试 → 打开日志目录` 就能取到。
   `POLARIS_WINSCP_DEBUG=1` 时级别升到 `*`（全协议包，含敏感内容，排障后请删）。
2. **逃生阀 `POLARIS_WINSCP_RAWSETTINGS`**：形如 `A=B;C=D`，叠加在默认 rawsettings 之上（同名覆盖），
   用户自己试 WinSCP 开关不必等新版本。例：`set POLARIS_WINSCP_RAWSETTINGS=SFTPRealPath=on;RemoteDirectory=/tmp`。
   解析只收 `[A-Za-z]` 开头的名字与非空值，非法条目整条丢弃（绝不把怪货拼进 argv）。

看不到错误码 4 到底出在哪一步之前，不做"猜着改"的开关；排查表（REALPATH / LSTAT / OPEN 各自的判定与绕过）、
与「内置面板交叉验证」的判据写在 `docs/winscp-realpath-fix.md` 第六节。

回归：`verify-winscp-args.js` 32→**34**（日志参数默认下发 / debug 换 `*` / 空路径整组不传 / `parseRawSettings` 四类边界）、
`verify-winscp-open.js` 37→**39**（argv 里确有 `/log=<数据目录>/logs/winscp-<时间戳>.log` + `/loglevel=1`、日志目录提前建好）。

## v1.0.20（2026-11-13）

### 发布形态变更：Windows 只发便携版

按要求，`build.win.target` 只保留 `portable`（x64），NSIS 安装版配置与 CI 上传/发布规则一并收掉：
`release/Polaris Portable <v>.exe` 是 Windows 唯一的产物，`latest.yml` / `.blockmap` 不再生成。
顺带影响：自动更新（electron-updater）没有安装版可替换了，便携版本来就走「手动下载新版（替换 exe 保留数据）」提示，行为不变；
macOS 仍是 `npm run dist` 出的 `Polaris.app`。v1.0.20 的 Release 已把安装版/`latest.yml`/`.blockmap` 三个资产删掉，只剩便携版。

**两个 SFTP 干活时最缺的能力：改权限、限带宽。** 以前在 Polaris 里只能上传下载，改一个 `chmod`、改一次属主、或者"别把公司专线跑满"都得切到别的工具。这一版把两件事都放进面板了。

### 一、右键 →「🔐 权限与属性…」（chmod / chown / 改时间戳，可递归）

- SFTP 面板对文件或目录右键 →「🔐 权限与属性…」：先**读远端真实属性**再给你改，读到之前保存按钮是灰的（不盲改、不猜）。
- 权限支持三种写法：`644` / `0644` / `0o644` 随便填，旁边**实时显示 `ls -l` 风格符号**（`-rw-r--r-- (644)`、`drwxr-xr-x (755)`，setuid/setgid/sticky 显示 `s`/`S`/`t`/`T`），也有 644 / 755 / 600 / 700 四个快捷档位。
- 属主 / 属组（UID / GID）与**修改时间**（本地时间选择器，秒级往返）可一起改。
- 目录多一个「包含子目录与文件（递归）」：改之前先把目标清单列出来，**上限 20000 条**（`SFTP_ATTRS_RECURSE_MAX`），符号链接目录不递归（防环）——不会因为误点一下把几万条文件一起 chmod 拖死 SFTP 通道。
- 下发顺序固定 **chown → chmod → utimes**：`chown` 会清掉 setuid/setgid 位，反过来先 chmod 就白改了；`chown` 必须 uid+gid 一起给（缺的一侧用当前值回填，避免把属主改一半）。
- 只改**你真的动过**的字段：没改的项不下发，一项没改就不惊动服务器。失败项汇总回显前 10 条，成功条数写进传输记录（`🔐 权限 644 …`）。
- 校验两端各做一次：渲染层即时红字（`644` 写错立刻提示），主进程再用 `lib/sftp-attrs.js` 复核（IPC 不是只有对话框能调），`mode` 上限 `0o7777`。

### 二、设置 → SFTP →「传输限速」（每条连接，KB/s，0 = 不限）

- 默认 0 = 不限速：**不插节流流，零开销**，老机器不受影响。
- 想给专线留余量就填个数（如 `50`）：上传/下载两条管道都按这个速率走，走的是**节流 Transform 插在 `rs.pipe → mid → ws` 中间**——不碰 ssh2 底层 SFTP 请求、不改断点续传/对账逻辑（它们只看流是否正常结束），有 backpressure 也不会"内存里攒一大坨再一次性灌出去"。
- 速率按「下一个允许开始时间」单调累加，长时间跑下来速率稳定（不是逐块定长 sleep，不受定时器抖动影响）；上限 100 MB/s，填非法值按不限速处理。
- 改完立即生效（保存设置 + 推给主进程），状态栏/日志记 `[SFTP] 传输限速 = 50 KB/s`，方便在调试面板确认到底是"没生效"还是"网络本来就慢"。
- 取消/超时/出错各分支都会销毁节流流并清掉待触发的定时器，不会留悬挂 timer。

### 三、mock 与回归

- `mock/sftp-vfs.js` 补 **SETSTAT** 应答（chmod/chown/utimes 都得有回应，否则 ssh2 客户端一直等），并且**改 mode 时保留类型位**（`0o100640` / `0o040700`）——真实 OpenSSH 就是这么回的，不补类型位面板会把目录当文件。
- 新增 `lib/sftp-attrs.js`、`lib/sftp-throttle.js`（都是纯函数，可单测）、`verify-sftp-attrs.js`（纯 Node **100** 条，含渲染层与服务端两份八进制解析逐值对拍）、`verify-sftp-throttle.js`（**37** 条，含"20 万字节 @100KB/s 实测约 2s"与"destroy 后不留悬挂定时器"）、`verify-sftp-attrs-dialog.js`（真 Electron + mock **16** 条，端到端跑通 chmod/chown/utimes/递归/限速下载）。
- 无退化：`verify-sftp-download-many` 16/16、`verify-sftp-panel` 5/5、`verify-batch-sftp` 5/5、`verify-sftp-upload-flash` 3/3、`verify-transfer-cancel` 10/10、`verify-sftp-cancel` 9/9；`run-verify --pure` **17/17 脚本 337 断言**（原 15/200）。

## v1.0.19（2026-11-13）

- **RDP / 存储 Web 资产：双击直接交给 H3C 客户端打开（方案 A 落地）**（v1.0.18 只做到"识别出非 SSH 资产并提示去网页开"，这一版把双击之后那一步补上）：H3C 的 RDP/Web 资产本来就是靠 `AccessClient.exe` 拉起 mstsc / 浏览器 —— 真实 HAR 里 RDP 的 `accessUrl` token 解出来就是一份 mstsc 启动配置（`{"app":"mstsc","fa":"s:<网关>:3389","sa":"super","as":"…OTP:…"}`，**没有 `pw`/`hn`/`pn`**）。所以 Polaris **不做 RDP 协议栈**，把堡垒机签发的 `accessclient://<token>` **原样交给本机已装的客户端**（`docs/decision-rdp-support.md` 结论：纯 JS RDP 库 `node-rdpjs`/`mstsc.js` 是 AGPL v3.0 → 排除；FreeRDP 只发源码、IronRDP 要 Rust 工具链 + 4~8 周）。
  - **新增 `lib/h3c-client.js`（纯函数）**：`isAccessClientUrl` 只放行 `accessclient://` + urlsafe base64 字符集（挡掉 http/file/javascript、空格/引号/换行注入、>8KB）、`detectPlan`（Windows 用 `%SystemRoot%\System32\reg.exe` 绝对路径查 `HKCR\accessclient` 的 `URL Protocol`，非 Windows 返回 `supported:false`）、`parseDetect/parseHandler/handlerBasename`、`openTarget`（**返回原样字符串，不做规范化**）。
  - **主进程**：新增 `h3cClient:detect` IPC（探测失败也是 `{ok:true, installed:false}`，不报错）；**`app:openExternal` 新增 `accessclient:` 分支且放在 http/https 白名单之前**——自定义 scheme **不能过 `new URL()`**（token 里的 `+` `/` `=` `%` 会被重编码，`zlib.inflateSync` 会报 `unexpected end of file`）；新增 `execFileP()`（8s 超时/1MB 上限、不经 shell）只用于注册表探测。
  - **渲染层**：`state.h3cClient` + 启动 `detectH3cClient()`（失败静默回落"未装"，功能降级不消失）；新增 `bastionConnectNonSsh()`（**装了才请求 accessUrl**，带真实 `proto` + `handoff:'accessclient'` 日志；没装/没登录记 `accessUrl-skip` 并给可读提示，绝不发无效请求）与 `bastionOpenAccessClient()`（走唯一外链出口 `openExternalUrl`，失败**状态栏改红 + 弹窗写原因**，不冒充成功）；新增纯函数 `bastionNonSshEntry()` 统一入口文案（右键首项 + 行 `title`）；`bastionUnsupportedAssetMsg(a,{clientMissing})` 补「缺 AccessClient.exe + 安装指引」；`handleAccessClientUrl` 的 `graphic` 分支复用同一套透传；`isOpenableUrl()` 显式放行 `accessclient://`。
  - **安全边界**：不分发 H3C 闭源二进制（只借用用户已装的，`POLARIS_H3C_CLIENT=1` 仅为回归钩子）；白名单仍只有 `accessclient://`（`file://`/`javascript:` 拒绝）；非 Windows 完全无感；日志只记 `tokenLen`/`app`/`sn`，不含 token 正文。
  - 回归：新增 `verify-h3c-client.js`（纯 Node，**30/30**：11 组非法输入/探测解析/`openTarget` 原样透传/接线顺序断言）+ `verify-bastion-client-open.js`（e2e，**17/17**：detect→state→行文案→**透传地址逐字节一致**→失败不冒充成功→未装记 `accessUrl-skip`→主进程白名单）；`verify-bastion-proto.js` **29 → 35**（新增"装了/没装"两套入口文案 + Web 同入口 + 安装指引）；`verify-bastion-har.js` 10/10（`-5.har`）；`run-verify --pure` **15/15 脚本 200 断言**（原 14/164）；`verify-bastion-ui` 11/11、`verify-bastion-browser-ui` 9/9、`verify-term-links` 28/28 无退化。发布说明 `docs/release-v1.0.19.md`。

## v1.0.18（2026-11-13）

- **H3C 堡垒机：分得清 RDP / Web 资产，不再当 SSH 连**（对照用户给的真实流量 `bastion-5.har` 发现）：H3C 资产 `dev.services.services` 的键**就是协议名**，实测有 `ssh` / `rdp` / `Device_Storage_web` 三类；旧代码只认 `ssh`/`sftp`，其余一律当 `ssh`。
  - **症状**：双击 RDP 或存储资产时，拿 `proto='ssh'` 去 `POST /shterm/api/deviceAccess/accessUrl`（堡垒机侧协议不匹配，还留失败访问记录），偶尔拿到图形 token（无 `pw`/`hn`/`pn`）后只报「堡垒机连接信息不完整」，用户看不出是资产类型不支持。全量 HAR（`-11`）复算：854 台里 **180 台（约 21%）不是 SSH**。
  - **修法**：① `bastionParseDevs` 改为按服务键识别协议，新增 `protocols`（保留原始键）与 `webUrl`（`services.<*web*>.url`，只收 http/https），`proto=ssh→sftp→首个服务键`、`port` 取所选服务端口；② `bastionConnect` 开头就拦非 SSH 资产（**不发 accessUrl**），提示写清协议 + 替代路径（有 `webUrl` 就指到右键「🌐 用系统浏览器打开」）；③ `handleAccessClientUrl` 先判 token 类型（`mstsc/rdp/vnc/…` → 图形客户端，明确提示无法接管；缺 `pw/pn` → 不完整），SSH token 照旧接管；④ 批量连接只连 SSH 资产，状态栏标明「跳过 M 台非 SSH」。
  - **列表可见性**：非 SSH 资产行加橙色协议徽标（`RDP`/`Web`/原始键，多协议并集）、名字压成次要色，`title` 写明"双击查看说明"；右键菜单对非 SSH 资产首项换成「ℹ️ 非 SSH 资产(RDP)，点此查看说明」，有 `webUrl` 时多一项「🌐 用系统浏览器打开」，SSH 专属项（连接/账号/断开/打开 SFTP）只对 SSH 资产出现（`src/renderer.js` + `src/styles.css`）。
  - 回归：**新增 `verify-bastion-proto.js`（纯 Node，29/29，从 renderer.js 切纯函数区块 eval）**；`verify-bastion-har.js` 6/6（`-5.har` 小样本）/ 13/13（`-11.har` 全量），`findHar()` 支持 `POLARIS_HAR` 与 `-5.har`，小样本 HAR 不再被"≥800 台 / >100 目录"规模阈值误报，新增真实数据协议判定与 DOM 徽标断言；`run-verify --pure` **14/14 脚本 164 断言**（原 13/135）；`verify-bastion-ui` 11/11 无退化。发布说明见 `docs/release-v1.0.18.md`。

## v1.0.17（2026-11-12）

- **WinSCP 排障日志可见（调试面板不再"什么都看不到"）**（用户贴回 v1.0.16 调试日志，里面一条 `[WINSCP]` 都没有，只剩 `window blur … active=BUTTON#btn-sftp-toggle`）：根因是**日志可观测性缺口**——`main.js` 里 WinSCP 拉起/失败走 `appLog.log('main', …)`，**只落盘 `logs/app-*.log`、不转发渲染层**，面板只看得到主进程 `console.log` 系的内容，于是「点了 SFTP、WinSCP 起来了/没起来」在面板上完全没有痕迹。
  - **修法**：① 主进程拉起成功/失败改 `console.log` → 面板与落盘日志都有，内容仍是脱敏后的命令行（`sftp://账号:***@主机:22/ /rawsettings SFTPRealPath=off RemoteDirectory=/root | rawsettings={…}`）；② 渲染层 `openSessionInWinScp`/`toggleSftpPanel` 新增 `dlog`：`交给 WinSCP: 账号@主机:22 起始目录=…` / `WINSCP·错误 …` / `拉起失败 → 回落内置 SFTP 面板(功能不消失)` / `本机未检测到 WinSCP`，**这些行只含账号/主机/路径，永不含密码**。
  - 顺带修 `verify-winscp-open.js` 的偶发：拿 sid 一轮失败会**再点一次连接再等一轮**（之前一次 mock 握手抖动会连带后面 18 条断言全红）。
  - 回归：`verify-winscp-open.js` **32 → 37**（拉起成功同时进面板 / 面板日志含 `rawsettings` 且无密码 / 落盘日志含 `[WINSCP] 已拉起` / 渲染层记了「交给 WinSCP + 起始目录」/ 该行不含密码）；`run-verify --pure` **13/13 脚本 135 断言**；key-forward 7/7、ai-copy 11/11、sftp-panel 5/5 无退化。发布说明见 `docs/release-v1.0.17.md`。

## v1.0.16（2026-11-12）

- **修「WinSCP 报『不能获得 \'.\' 的真实路径』(错误码 4)」**（用户反馈，v1.0.15 拉起 WinSCP 后必现）：根因是 WinSCP **建会话时会先对 `"."` 发一次 `SSH_FXP_REALPATH`** 当作家目录（`source/core/SftpFileSystem.cpp:2976` `FHomeDirectory = RealPath(L".")`；默认 `SessionData.cpp:303` `SFTPRealPath = asAuto`），而 **chroot 型服务端**（JumpServer KoKo 网关、H3C 网关、`internal-sftp` chroot、老 ProFTPD）对这个请求直接回 `SSH_FX_FAILURE`（错误码 4）→ WinSCP 当致命错误抛出，会话进不去。Polaris 自己的 SFTP 面板从不受影响，因为我们从不发 REALPATH（家目录走 `exec pwd` + `readdir` 验证）。
  - **修法**：拉起的命令追加 `/rawsettings SFTPRealPath=off`（WinSCP 官方支持的会话级 ini 注入），`RealPath()` 改走 `LocalCanonify`、不再发请求；同时把 Polaris 已知的目录作为 `RemoteDirectory` 交过去（**SFTP 面板当前目录 > 该标签记住的 `sftpPath` > 终端跟踪到的 `shellCwd`**，相对路径/未知一律不传，避免猜错报「目录不存在」）。要恢复 WinSCP 原生行为：`POLARIS_WINSCP_REALPATH=on` 启动 Polaris。
  - **代码落点**：`lib/winscp-open.js` 新增 `RAW_SETTINGS_DEFAULTS` / `buildArgs()` 支持 `rawSettings`（空值跳过、顺序稳定）/ `normalizeRemotePath()`（只收绝对路径）/ `realPathCompat(env)`；`main.js winScp:open` 组装 rawsettings 并在拉起日志里记 `rawsettings=…`（只有设置、无凭据）；`src/renderer.js winScpPayloadFor()` 增加 `remotePath`。
  - 回归：`verify-winscp-args.js` **25 → 32**（rawsettings 拼装/空值跳过/带空格中文目录/与私钥口令共存顺序/`normalizeRemotePath`/`realPathCompat`）、`verify-winscp-open.js` **27 → 32**（argv 里确有 `SFTPRealPath=off`、`RemoteDirectory=/srv/my dir` 整段到达、payload 起始目录优先级与相对路径丢弃）；`run-verify --pure` **13/13 脚本 135 断言全绿**。排障与用户侧手工绕过见 `docs/winscp-realpath-fix.md`，发布说明见 `docs/release-v1.0.16.md`。

## v1.0.15（2026-11-12）

- **新功能：点「SFTP」直接用本机 WinSCP 打开这个会话**（用户诉求：一份 Key/密码不想再手输一遍，要拿 WinSCP 的同步、权限对话框、限速、双窗格干重活）。
  - **三档设置（设置 → SFTP）**：`replace`（默认）点 SFTP 直接拉起 WinSCP，**没装/拉起失败自动回落内置面板**；`button` 照开内置面板但工具栏留「🪟 WinSCP」按钮；`panel` 只用内置面板、WinSCP 入口完全不出现。入口显隐**只认探测结果**，不会出现"按钮在、点了必报错"。
  - **带什么过去**：`WinSCP.exe sftp://账号:密码@主机:端口/ -privatekey=<路径> -passphrase=<口令>`。用户名/密码 `encodeURIComponent`（`p@ss:w/rd#1` → `p%40ss%3Aw%2Frd%231`，不编码 WinSCP 会解析歪成"密码错误/主机名错误"）；私钥存的是路径直接传、文件不存在就不传；**堡垒机复合用户名 `jms@ssh@账号@资产IP` 原样整体编码**（KoKo 网关要的就是这个形态），`displayHost` 绝不用于连接；主机指纹交给 WinSCP 自己问（PuTTY 风格 host key 与我们的 `known_hosts` 不通用）。
  - **密码进 argv 的取舍**：WinSCP 无库 API、读不到 Electron `safeStorage`，要"自动登录"只能命令行 URL / 临时 ini / 用户再输一次。选命令行，配套硬约束是**不落盘 + 不写日志**：`redactUrl` 把密码压成 `***`、`describeCommand` 对 URL 参数与 `-passphrase=` 同样脱敏 → `termDebug`/状态栏/`logs/app-*.log` 里只会有 `sftp://user:***@host:22/`（回归脚本断言明文与编码串都不出现）。风险边界（同用户/本机管理员可见 argv）写进文档；不想要就切 `button`/`panel`。
  - **新增 `lib/winscp-open.js`（纯函数：候选路径 / 环境变量展开 / 探测 / 拼会话 URL / 拼参数 / 脱敏）** + `main.js` `winScp:detect`、`winScp:open`（`spawn` 时 `detached:true` + `unref()`，Polaris 退出后 WinSCP 继续可用）+ `preload.js` 两个桥接 + 设置项 `#set-winscp-mode` + SFTP 工具栏 `#btn-sftp-winscp` + 标签右键菜单「🪟 用 WinSCP 打开 SFTP」。`toggleSftpPanel` 的内联打开逻辑抽成 `openInlineSftp()` 供回落复用。排障可设 `POLARIS_WINSCP_PATH`（自定义安装路径）、`POLARIS_WINSCP_DEBUG=1`（加 WinSCP 自己的 `/log`）。
  - **非 Windows 无感**：`detectExe` 对 `darwin/linux` 直接返回 `null`，macOS/Linux 看不到任何 WinSCP 入口，内置面板照旧。
  - 回归：新增 `verify-winscp-args.js`（纯 Node 25/25）+ `verify-winscp-open.js`（真启动 Electron + shell 桩 27/27，连跑两次稳定）；`run-verify --pure` **13/13 脚本 128 断言**；相关 e2e 无退化（key-forward 7/7、ai-copy 11/11、sftp-panel 5/5、sftp-download-many 16/16）。细节见 `docs/release-v1.0.15.md`，决策补充见 `docs/decision-winscp-integration.md` 文末「已实现」。

## v1.0.14（2026-11-11）

- **修「AI 对话框文字不能复制」+「Ctrl+C 不生效」**（用户反馈，同一根因）：全局按键兜底会把按键 `preventDefault()` 后转发给终端，连 ⌘/Ctrl+C 的原生复制一起吞掉；而"转发"这条路径本身也是坏的——合成 `KeyboardEvent` 没带 `keyCode`（线上日志特征 `KEY 'c' ^ … kc=0`），xterm 拿不到键码直接丢弃，所以 Ctrl+C 既没打断远端命令也没复制界面文字。
  1. **AI 对话区可聚焦**：`#ai-chat` 加 `tabindex="-1"`，点进对话区就把焦点给它，按键不再走"转发给终端"的兜底。
  2. **有选中文字时放行 ⌘C**：焦点即使在 BODY（点过面板空白），只要选中了终端以外的文字，⌘/Ctrl+C 原样交给浏览器做原生复制，不 `preventDefault`、不转给终端。
  3. **合成按键补回键码**：兜底转发时用 `Object.defineProperty` 补 `keyCode`/`which` → Ctrl+C(`\u0003`)、Ctrl+D(`\u0004`)、Tab、方向键、普通字母都真正进终端（以前全是"日志有、SEND 没有"）。
  4. **合成事件加 `__polarisSynthetic` 标记**：防止同一个 window 捕获 handler 二次处理导致无限递归转发。
  5. **⌘A 在对话区 = 全选对话内容**（以前会被当"终端全选"），方便整段复制。
- **一键复制入口**：每条 AI 消息一个悬停显形的「📋」（复制整条含代码块），每个代码块一个「📋 复制命令」；复制走 `window.api.copyText`，状态栏给反馈。AI 面板补 `user-select: text`（SFTP 面板早有同类修复，AI 漏了）。
- **对话区里不转发组合键**：以前在对话区按 Ctrl+C（无选中文字）会静默给远端发 `^C` 打断命令；现在组合键留给界面/系统，只有普通打字才还给终端（点一下 AI 面板仍能直接敲命令）。
- 回归：新增 `verify-ai-copy.js` 11/11（未修复版 1/9）+ `verify-key-forward.js` 7/7（未修复版 3/7，日志与用户现场一致）；`verify-ai-config` 11/11、`verify-ime-deadkey` 9/9、`verify-bufferfocus` 4/4、`verify-line-clear` 6/6、`verify-ui-layout` 21/21、`verify-theme` 21/21、`run-verify --pure` 12/12 脚本 103 断言。细节见 `docs/release-v1.0.14.md`。


## v1.0.13（2026-11-11）

- **修「文件夹下载 / 多文件下载失败」**（用户反馈）：这条链路以前有 5 个会直接坑到真实服务器的点，现在全部修掉。
  1. **一个子目录列不出来，整批就不下了**（真实服务器上 root 拥有的子目录、设备限制很常见）：`walkRemote` 以前一路 `await` 递归，`readdir` 报错直接抛到 IPC → 用户点「下载文件夹」只看到「下载失败: Permission denied」，一个文件都没下。现在子目录失败**只记一条失败项**（带原因，界面出「✗ 失败」行），同目录其它文件照常下完。
  2. **批量并发在"SFTP 串行处理"设备上部分文件失败**（H3C/KoKo 类网关，单文件能下、全选就挂）：批量阶段失败的文件现在会**再逐个串行重试一次**（并重开 SFTP 通道），成功即并入结果（`retried: true`，日志 `下载重试成功`）。
  3. **符号链接指向目录时被当文件下载**：`readdir` 报的是链接自身 mode（`0o12xxxx`），旧判定只认 `0o040000` → 链接目录被塞进文件清单 → 读它必然失败。现在按 `stat`（跟随链接）判定真实类型，链接到目录继续递归，并用 `visited` 防链接成环。
  4. **目录被当文件**（列表 `isDir` 缺失/来自缓存的条目）：`sftp:downloadMany` 现在对 `isDir:false` 的条目**先 stat 兜底**，是目录仍按目录递归。
  5. **批量进度 total 被遮蔽**（`(d, total)` 回调参数盖住了外层 `total`）→ 多文件下载的总进度条恒显示 100%，看着像"瞬间完成/已完成"；现在 `total` 是全批总字节。
- **失败原因更像人话**：本地写失败时按错误码补提示——路径过长（Windows 260 字符限制）、磁盘空间不足、同名位置已是文件夹、文件被占用/只读/杀软。
- **空目录照常建出来**：递归时先建本地子目录，勾选带空文件夹的目录不会再"少几个文件夹"。
- 回归：新增 `verify-sftp-download-many.js`（16 条：嵌套/中文/空格/`#`/空文件/空目录整体下载、软链→目录递归、软链→文件、无权限子目录隔离、首次读失败串行重试、进度 total 正确、`isDir:false` 兜底、空目录判成功、界面失败行、重试日志）；修复前该用例 5/11 通过（① 本地文件缺失、② 软链目录、④ 空目录、⑥ 重试、⑦ 进度 total 全红）。`verify-sftp-download-fail` 7/7、`verify-sftp-cancel` 9/9、`verify-sftp-stress` 7/7、`verify-batch-sftp` 5/5、`run-verify --pure` 12/12 脚本 103 断言。


## v1.0.12（2026-11-11）

- **DeepSeek 配置改为官方 OpenAI 兼容端点**（默认模板 + 新增厂商默认值都用 `https://api.deepseek.com/v1`，自动拼 `/chat/completions`）。同一把 DeepSeek Key 也能走 `https://api.deepseek.com/anthropic`（Anthropic 兼容端点），两种都保留在「快速模板」里，各自对应的**接口格式**不同——格式与端点混用才会 401。
- **迁移修正**：老配置里接口地址为空（或还指向旧官方 Claude 地址）的厂商，补 DeepSeek 端点时**按该厂商当前选的接口格式**给对应地址（OpenAI 兼容 `/v1`、Anthropic 兼容 `/anthropic`），避免拼出 `…/anthropic/chat/completions` 这种 404。
- 「接口地址没有填」的报错现在同时给出两种端点，并自动展开 ⚙。
- 回归：`verify-ai-config.js` 11/11（新增 Anthropic 兼容模板断言；真实 Key 连通性实测走 OpenAI 兼容端点）。


## v1.0.11（2026-11-11）

- **修「AI 功能用不了」**（用户反馈：填了 DeepSeek 的 Key 也发不出消息）：根因是配置项缺失时静默回落到官方地址/模型 —— 新加的厂商「接口地址」为空 → 请求被悄悄发到 `https://api.anthropic.com/v1/messages`，界面只给一句 `HTTP 401/404`；模型为空 → 静默用 `claude-sonnet-5` 去请求 DeepSeek，直接 400。现在：
  - **发请求前先校验**：地址/模型没配就直说「去 ⚙ 里填接口地址 / 选模型」，并自动展开配置面板，不再发无效请求；
  - **⚙ 新增「快速模板」**：DeepSeek / OpenAI / 通义千问（DashScope）/ 智谱 GLM / Moonshot Kimi / Anthropic / OpenRouter，选中即填好接口地址、协议格式、模型名（DeepSeek 模板已实测跑通），用户只需粘 Key；
  - **「＋ 新增厂商」默认就是能跑通的 DeepSeek 配置**（地址 + `deepseek-v4-flash/pro`），不再是一张白纸；
  - **错误信息人话化**：`HTTP 401/403 → API Key 无效或没权限`、`402 → 余额不足/限流`、`404 → 地址或模型名不对（常见漏填 /v1）`、`429 → 频繁或额度用尽`、`5xx → 服务端错误`，每条都指向该改哪个输入框。
- **工具栏「调试」移入菜单栏**：工具栏少一个按钮，入口改到 macOS 菜单栏「调试」（紧跟「帮助」）——终端调试日志（⌘⇧D 开关）、⬇ 下载完整日志…、打开日志目录、清空调试日志。快捷键与命令面板入口不变。
- 回归：新增 `verify-ai-config.js`（10 条：错误码提示映射、新增厂商默认配置、快速模板落盘与复位、地址/模型缺失的可读报错、发送前校验并展开 ⚙、Key 密文入库可解密，另附可选真实 Key 连通性实测）；`verify-debug-log.js` 跟进新入口（工具栏按钮已移除的断言）。`run-verify --pure` 12/12 脚本 103 断言全绿。

## v1.0.10（2026-11-06）

- **修「输入法死键吞字符」**（用户日志反馈，已复现）：输入法卡在"假组合"状态时，按下的字符键只产生 `KEY 'Process' kc=229` 却**没有任何数据送到远端**（命令打不进去，只剩退格/回车能用）。旧逻辑要"**连续** 3 个死键"才重建输入法会话，而用户的实际节奏是「2 连发 → 敲退格 → 2 连发」，计数器被普通按键复位，永远到不了阈值 → 一直被吞。
  现在改成**时间窗 + 延迟判定**：每个 `Process/229` 先等 150ms，若期间没有真正的 `compositionstart` 才算死键（正常拼音输入第一时间就会来组合事件，不会误伤）；3 秒内累计 2 个死键即 `blur()+focus()` 重建 IME 会话。顺带修掉旧实现的一个隐患——真实按键被 xterm 处理完会 `stopImmediatePropagation`，靠 keydown 清计数根本收不到，改用 `term.onData`（真实字符必定触发）。
- **提示更清楚**：连续死键时状态栏提示「输入法一直处于激活状态，字符键被吞了：请切到英文输入法」，每个终端只提示一次；该提示原先只在 Windows 生效，现在 macOS/Linux 同样给出。
- 回归：新增 `verify-ime-deadkey.js`（9 条：单键不误伤、3s 内 2 连发即重建、跨窗口不累计、真实组合不打断候选窗、40ms 内连发不漏计、重建后键盘与焦点正常）；修复前该用例 6/9（②③ 红灯）。

## v1.0.9（2026-11-06）

- **终端支持 Cmd/Ctrl+点击打开浏览器链接**：以前终端里的 URL 只是死文本，只能手动拖选复制。现在 `http/https` 链接自动识别（下划线 + 手型光标），按住 ⌘（mac）/ Ctrl（Win·Linux）点击即用系统默认浏览器打开；URL 折行、含查询串、含中文路径、行内有中文都能点准（按单元格列号算 range，不按字符串下标）。裸点击仍然只做拖选，不误触；右键菜单在选中内容是链接时多一项「🔗 在系统浏览器打开」，长 URL 点不准时兜底。
- **安全**：只有 `http/https` 会被打开（`javascript:` / `file:` / `data:` / `ftp:` 一律拒绝），渲染层白名单 + 主进程 `app:openExternal` 双重校验。
- 回归：新增 `verify-term-links.js`（28 条：URL 抽取/尾部标点裁剪、协议白名单、linkProvider 注册、缓冲区 range、中文列号、折行拼接、裸点击不打开、⌘ 点击打开正确 URL、IPC 双白名单、右键菜单两项）。

> 面向用户的版本更新说明。Bug、新功能、体验改进按版本倒序记录。
> 版本号从 v1.0.0 重新开始（2026-11-03），更早的开发历史略去不列。

## v1.0.8（2026-11-06）

- **修「自动锁定后无法输入密码」**（用户反馈，已复现）：锁定界面点一下卡片空白处，焦点会掉到底层终端 —— 之后敲的密码字符被**发到远端 shell**（界面看着就是"输不进密码"）；开着设置/导入弹窗时自动锁定更糟，弹窗的焦点锁会把焦点从密码框抢回去。现在锁定期所有按键只归密码框、点空白处自动拉回焦点、密码框失焦立刻抓回、窗口切回来也回到密码框；同时命令补全面板不再浮在锁定层之上（锁定层 z-index 300 → 1200）。
- **主题全换新**：10 套内置配色整体替换为 Tabby / iTerm2 精选配色方案——**夜色 Tokyo Night（默认）、德古拉 Dracula、极地 Nord、日晒 Solarized Dark、格鲁夫 Gruvbox、半深 One Half、冰山 Iceberg、松雾 Rosé Pine**，浅色为 **GitHub 浅、半浅 One Half**。
- **升级不丢主题**：旧配置的主题键自动迁移（深空→Tokyo Night、极简白→GitHub 浅、Graphite 深/Mist 浅→One Half、Truffle 摩卡→Iceberg），其余已删主题回落到默认。
- **换任意配色都不糊**：UI 外壳颜色仍由背景/前景派生，并新增**对比度保底**——正文 ≥ 4.5、次要文字 ≥ 3.0（WCAG 口径），内置 10 套实测最低 8.99 / 3.05。
- 署名：配色来源与许可见新增的 `NOTICE`（Tabby 社区配色 / iTerm2-Color-Schemes，均 MIT）。

## v1.0.7（2026-11-03）

- **修「每次连接都弹『信任并连接』」**：① 首次连接弹窗新增第三个选项「**信任并记住所有主机**」——点一次就把设置里的「自动信任新主机密钥」打开，以后连任何新主机都不再弹（仍记录并校验指纹）；② 指纹写入磁盘失败时（数据目录只读/被清理）状态栏红字明确告知“指纹没能保存到 <路径>，下次仍会询问”，不再只表现为反复弹窗；③ 指纹落盘后回读校验，避免“看着点了信任、实际没存”。排查文档见 `docs/host-trust.md`。
- **堡垒机面板精简**：右侧「选堡垒机」不再三重重复——已保存连接只由顶部标签栏出（下拉里不再重复列一遍）；下拉只留标签栏覆盖不到的站点（左侧 JumpServer 服务器 / 已有资产的堡垒机 URL），按来源分组，没额外站点时整个下拉自动收起；双击资产/从下拉进入时标签会同步高亮，同一个站点可反复选。
- **全量回归入口入库**：新增 `node run-verify.js`（串行跑全部 `verify-*.js` 并汇总断言数与失败清单；`--pure` / `--e2e` / `--only=` / `--retry=N` / `--fail-fast`），取代含真实凭据、新克隆里根本没有的旧 `test-all.js`。
- **CI 开始跑测试**：新增 `.github/workflows/test.yml`，push / PR 自动跑纯 Node 断言（不启 Electron，秒级）；`npm ci` 支持 `POLARIS_SKIP_ELECTRON=1` 跳过 144MB 二进制下载。
- **新手引导不再叠弹窗**：打开其他弹窗（新建会话/导入/配置…）时，首次引导会等待而不是叠上来抢焦点。
- 文档对齐：`docs/theme-font-optimization.md` 主题数改为实际的 10 套、`docs/layout-redundancy.md` A2 标为已完成、新增 `docs/verify-known-red.md`（记录 3 个与本轮无关的历史红灯用例及复核方式）。

## v1.0.6（2026-11-03）

- **切换 root（su - root）+ 密码粘贴**：终端右键菜单与 ⌘K 命令面板新增「🔐 切换 root」——一键发送 `su - root`，弹出密码框可直接 Ctrl/Cmd+V 粘贴、或点「📋 粘贴」从剪贴板填入 root 密码；切换期间自动屏蔽「自动填充密码」（避免把登录密码误发给 su），root 密码不进会话日志/录制，取消则 Ctrl+C 中止切换。
- **新手引导向导**：首次使用（无任何会话）解锁后自动弹出三步引导——欢迎 → 建立第一台主机（一键导入 ~/.ssh/config / 批量导入 / 新建会话 / 快捷连接）→ 完成；关闭/跳过即持久化不再打扰，空态卡片里的「🚀 查看新手引导」可随时重开。
- **新增「从 ~/.ssh/config 导入」**：导入弹窗与空态卡片都能一键读取本地 OpenSSH 主机配置，自动解析 `Host` / `HostName` / `User` / `Port` / `IdentityFile`（含 `Host *` 全局默认、`~` 路径展开）；密码不会从 config 还原，需导入后补填。
- **首次使用空态卡片**：会话列表为空时给出「新建会话 / 批量导入 / 从 ~/.ssh/config 导入 / 快捷连接」四个直达入口（并修正首次启动时主机分组默认折叠导致卡片不可见的问题）。

## v1.0.5（2026-11-03）

- 修复 H3C 堡垒机自签名证书导致的 `ERR_CERT_AUTHORITY_INVALID`：证书放行提前到应用启动时安装，失败自动重装并重试。

## v1.0.4（2026-11-03）

- 修复「添加堡垒机站点」弹窗缺少右上角关闭按钮；打开弹窗时临时隐藏浏览器面板，避免遮挡弹窗。

## v1.0.3（2026-11-03）

- 识别远端 `nologin` 账号：连接后立即断开的场景会给出「换有 shell 的账号 / usermod -s /bin/bash」提示，并停止无意义地自动重连。

## v1.0.2（2026-11-03）

- 修复终端输入空格被输入法组合态吞掉的偶发问题（新增看门狗自动重建输入法会话）。

## v1.0.1（2026-11-03）

- 右侧堡垒机浏览器面板体验优化：工具栏精简（清理历史收进「⋯」）、空态/加载/错误态结构化并带「重试」、更多菜单支持系统浏览器打开/复制地址/重置缩放、双击缩放恢复 100%。

## v1.0.0（2026-11-03）

- 版本号重置后的首个正式版。
- 新增 Windows 安装版自动更新：检查更新 → 下载进度 → 重启安装。便携版/开发版/非 Windows 回退为打开下载页。

---

## v1.0.60 及更早（开发历史摘录）

> 以下为版本号重置前的迭代，仅保留对用户可见的关键变化。

- **检查更新**：帮助菜单 / 关于弹窗可手动查看 GitHub Releases 最新版本与发布说明。
- **堡垒机稳定性**：修 H3C 自签名证书偶发连接失败、右侧堡垒机下拉与左侧保存后不同步。
- **回归与真 Bug 修复**：打包上传探测误判「不支持打包」而回退逐文件上传（已修）；mock 远端解压在 Windows 下改用系统 tar。
- **主题与字体**：主题精简为 10 套精选（旧配置自动回落深色）；新增「界面字体」与苹果字体支持（SF Pro / 苹方优先）。
- **会话弹窗精简**：默认只显示必要字段，协议/私钥/口令/跳板机/编码/登录宏收进「高级选项」。
- **关于弹窗**：只保留 Logo、版本号与一段简介，移除冗长的使用说明。
- **界面布局/字号**：全 UI 字号统一由「界面字体大小」派生；窄面板下长主机名不再整段省略。
- **打开即折叠**：启动时会话列表只显示分组头，展开状态不在重启间保留。
- **列表模式可折叠**：列表/树形两种视图都能折叠分组。
- **分组管理对齐成熟产品**：分组计数按「直属/合计」显示、悬停显示完整路径、搜索自动展开命中路径、分组拖拽排序/拖成子分组、侧边栏全键盘导航。