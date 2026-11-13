# AGENTS.md — 项目上下文（所有 AI Agent 通用）

> 本文件供任何 AI 编程 Agent（Claude Code / Cline / Codex / Cursor / DSH 等）在开始工作前读取，快速了解项目。配合 `CONTEXT.md`（当前开发会话快照）使用。

## 项目概览

**Polaris（北极星）** — 科幻风 SSH/SFTP 终端工具（Electron 桌面应用）。

- 技术栈：Electron 43 + xterm.js 5.3 + ssh2 + SQLite（node:sqlite 内置）
- 数据安全：会话数据存本地 SQLite（整库 AES-256-GCM 加密），密码走系统 safeStorage 加密（`enc:v1:` 前缀）
- 架构：主进程 `main.js`（~2700 行）+ 渲染进程 `src/renderer.js`（~11000 行）+ contextBridge 安全桥（`preload.js`，无 nodeIntegration）；
  主进程已拆模块（依赖惰性注入，命脉区块 SFTP/SSH/堡垒机仍在 main.js）：`lib/connect-opts.js`、`lib/session-groups.js`、`lib/session-ipc.js`、`lib/winscp-open.js`

## 核心文件

| 文件 | 职责 |
|---|---|
| `main.js` | 主进程：窗口、SSH 连接（ssh2）、SFTP、IPC、JumpServer API、加密、录制、日志 |
| `src/renderer.js` | 渲染进程：全部 UI 逻辑、xterm 终端、会话列表、SFTP 面板、堡垒机交互 |
| `src/index.html` / `src/styles.css` | UI 结构与样式 |
| `preload.js` | contextBridge 安全桥（渲染层通过 `window.api.*` 调主进程能力） |
| `lib/` | 模块：ssh-client、session-store、app-lock、db-crypto、known-hosts、jms-api、**h3c-client**、**winscp-open**、skills、recommend、kb、app-log、recorder、session-log 等 |
| `mock/` | 开发模式 mock：mock-server（假 JumpServer API + KoKo SSH 网关 + SFTP 虚拟磁盘） |
| `verify-*.js` | CDP e2e 验证脚本（自建 electron + 调试端口，临时数据目录） |

## 运行方式

> 新机器/重新 clone 的环境搭建（依赖、Electron 二进制镜像、Windows 下的 dev/e2e 差异）见 **`docs/dev-setup.md`**。

```bash
# 依赖（xlsx 走 cdn.sheetjs.com；postinstall 会确保 Electron 二进制）
npm ci

# 开发模式（自动拉起 mock 服务器）
POLARIS_LOCK_DIR="$PWD/.polaris-data" ./node_modules/.bin/electron . --dev --no-sandbox --disable-gpu
# Windows 用 npm run dev（.bin/electron 是 Unix 脚本，Windows 无法直接执行）

# 编译正式版
npm run dist   # → release/mac/Polaris.app(macOS，未签名)
# Windows(只产出便携版——2026-11-13 用户决定不再发布 NSIS 安装版):
#   release/Polaris Portable <v>.exe  portable 免安装版(每次启动自解压，较慢)
npm run dist -- --win
```

**启动慢排查**：数据目录 `logs/startup-error.log` 有分段打点；portable 版本的慢在"窗口出现前"(每次重解压 ~200MB)，详见 `docs/windows-startup-slow.md`。

**数据目录**：`POLARIS_LOCK_DIR` 指定（默认 `~/.jms-terminal`）；开发用 `.polaris-data/`。数据库/密码锁/指纹/录制/归档/日志都在此目录。**`.polaris-data/`、`*.har`、`probe-*.js` 已 .gitignore，不入库。**

## 关键架构约定

1. **SFTP 面板是全局共享的**：所有 SSH 会话共用同一个 SFTP 面板，按标签独立记忆 `sftpOpen`/`sftpPath` 状态
2. **SFTP 默认路径**：`sftp:home` IPC 探测家目录（exec `pwd` 拿真实 home → SFTP `readdir` 验证可访问 → 不可访问回退 `/tmp`）；终端 `cd` 命令被跟踪（`trackShellCwd`）更新 `tab.shellCwd`，SFTP 打开时优先跟随
3. **堡垒机两条路径**：
   - **JumpServer（API 对接）**：`jmsConnect` 用复合用户名 `JMS用户@协议@账号@资产IP` 直连 KoKo 网关（sshHost:2222），网关路由到目标
   - **H3C（Web 登录 + 原生 API）**：webview 只做登录会话载体（`persist:bastion` partition cookie）；资产枚举/连接走主进程 `lib/h3c-api.js`（`ses.fetch` 带 partition cookie 直连 `/shterm/api/*`，IPC `h3c:tree/devs/recent/accessUrl`）；`bastionConnect` 拿 `accessclient://` token → 解码（zlib）得 `hn/pn`（网关）、`sa`（账号）、`pw`（一次性 OTP）→ 直连网关
4. **SFTP chroot**：JumpServer 的 SFTP 会话被 chroot（sftp_home 配置，Linux 平台默认 /tmp）。修改 `protocol-settings/{id}` 的 `setting.sftp_home` 可改根目录（已把 Linux 平台从 /tmp 改为 /root）
5. **堡垒机连接 CRUD 与资产直连**：堡垒机连接存 `state.settings.bastionServers`（type=`jms`/`h3c`），增删改查走 `bastion-cfg-modal`；双击资产用 `bastionConnectAsset`（复合用户名走 KoKo 网关，密码 `decryptSecret` 解密，未登录自动用保存账号登录）。会话列表「🛡 堡垒机」分组右键菜单统一入口：➕ 创建连接 / JumpServer API 对接 / JumpServer Web / H3C 浏览器登录 / 清除历史（原头部 🛡 按钮已删除并入）
6. **右键菜单防刷屏**：菜单打开后 250ms 内的 click 视为"右键残留"忽略（`ctxMenuOpenedAt`）；空菜单数组不注册 contextmenu
7. **堡垒机资产轮询**：`pollBastionAssets` 只对 H3C 站点（URL 含 `/shterm`）运行，15s 低频兜底 + 用户操作时事件驱动；数据无变化不刷新（`stableJson` 键序无关比较）。**H3C 资产是主进程原生拉取**（`lib/h3c-api.js` + `h3c:*` IPC），不再注入 webview 钩子；登录成功自动最小化面板（`bastionLoginState`/`bastionLoginMode` 状态机），会话过期自动弹出重登
8. **全量日志**：`lib/app-log.js` 把主进程 console + 渲染层 console + dlog + 异常写入 `数据目录/logs/app-YYYYMMDD.log`（按天轮转 10MB）；调试面板「⬇ 下载日志」导出完整日志
9. **会话列表分组视图（列表/树形共用一套）**：`renderSessionList` → `renderSessionsTree/List` → 同一个 `renderGroupHierarchy`（按 `groups.parent_id` 建树）；列表模式只是 `flat=true`（仅保留 `list-head` 类名做样式/测试区分）；**两种视图都能折叠三角收起来**，共用同一套 `state.collapsedGroups` 持久化状态，右键/拖拽/选中/键盘完全一致。约定：
   - 缩进 `groupIndent(depth)`：前 3 层 18px/层，第 4 层起 10px/层（深层不把主机名挤没）；行上带 `data-depth`
   - 分组计数 `(直属/合计)`，父组下主机在子组里时显示 `(0/3)` 而非误导性的 `(0)`；分组头 `title` 显示完整路径
   - 搜索时 `prune`：没有命中后代的分组整棵不渲染，且忽略折叠自动展开命中路径（清空搜索后折叠态原样恢复）
   - 折叠状态只在本次运行内有效：**每次启动一律全部折叠**（列表/树形都只显示分组头，顶级「主机/堡垒机」也收起），不写 localStorage
   - 分组拖拽排序：`groups.sort_order`（同级间 10，0 = 未排过 → 回退按名称，保证升级后顺序不变）。拖分组头：**中间 = 变成子分组**，上/下边缘 = 插到同级前/后；IPC `groups:move(id, parentId, beforeId)`，数据层做环检测 + 「默认分组」不允许挂到别人下面
   - 键盘导航：roving tabindex（全树一个 Tab 停靠点），↑↓ 移动、← 折叠/回父级、→ 展开/进子项、Enter 连接或折叠、Shift+F10 右键；行键为 `t:<host|bastion>` / `g:<gid>` / `s:<sid>`
   - 回归用例：`verify-groups-mature.js`（84 条：结构一致性、折叠、搜索剪枝、计数、键盘、持久化、拖拽排序、规模压测）+ `verify-groups-order.js`（19 条纯 Node：老库补列迁移、moveGroup 语义、防环）

10. **界面字号 / 字体 / 布局约定**：所有 UI 字号都由 `--ui-font`（设置里的「界面字体大小」）派生，档位变量 `--fs-2xs/--fs-xs/--fs-sm/--fs-md/--fs-base/--fs-lg` = ui-font −4/−3/−2/−1/+0/+1（默认 13px 时与旧像素值完全一致）。**新增样式不要写死 `font-size: 11px` 之类**，用 `var(--fs-sm)`；终端字号走 `settings.fontSize`，与 UI 无关；**界面字体族**走 `settings.uiFontFamily`（`''`=内置自动栈：`-apple-system`/SF Pro/苹方 → Windows 雅黑 → Linux Noto，苹果设备优先命中 SF/苹方），设置项 `#set-ui-font-family` 支持 自动 / SF Pro / 苹方 / 雅黑 / Noto / 自定义，applyTheme 注入 `--ui-font-family`。主题只保留 **10 套精选配色**（v1.0.8 起换成 Tabby/iTerm2 精选：tokyonight/dracula/nord/solarizedDark/gruvboxDark/oneHalfDark/iceberg/rosePine + 浅色 github/oneHalfLight），旧键经 `THEME_ALIASES` 自动迁移（dark→tokyonight、catppuccinMocha→iceberg、termius*→oneHalf*、light→github），其余已删主题回落默认；`deriveUiTokens` 新增**对比度保底**（正文 ≥4.5、次要文字 ≥3.0），换任意配色小字都不糊。布局红线：会话列表行缩进只用 `padding-left`（行上不要再加 `margin-left`，否则 `width:max-content` 会顶出 6px 横向滚动条）；`.asset-tree` 固定 `overflow-x: hidden`；固定高度面板（如 `#sftp-panel`）里的工具栏必须 `flex-shrink: 0` 且允许 `flex-wrap`，否则大字号换行后按钮会被裁一半。回归：`verify-ui-layout.js`（21 条：默认档位、17px 缩放、横向溢出、标题/提示单行、SFTP 工具栏不裁切）。

11. **终端链接（v1.0.9）**：`registerTermLinks(term)` 挂在每个会话终端上（句柄存 `tab.linkProvider`，随 tab 释放），识别器只认 `http/https`；**必须带修饰键**（mac ⌘ / Win·Linux Ctrl）才真的打开，裸点击保留给拖选；打开统一走 `window.api.openExternal` → 主进程 `app:openExternal`（协议白名单 + 测试钩子）。改这块注意三点：① range 用 `line.getCell(x).getWidth()` 算单元格列，别用字符串下标（中文/emoji 占两列会点偏）；② 折行行要按 `line.isWrapped` 往上找到块首并拼接，否则长 URL 只识别前半截；③ 不要把 `tab` 引用提前到它 `const tab = {...}` 之前（TDZ），provider 句柄先放局部变量再挂 tab。

12. **WinSCP 外链（v1.0.15，Windows-only）**：**不集成引擎**（GPLv3 + 17 个 C++Builder 工程 + VCL 无公共 C ABI，见 `docs/decision-winscp-integration.md`），只在用户机器**已装** WinSCP 时把会话交出去。约定：
   - 逻辑分两层：`lib/winscp-open.js` 只做**纯函数**（探测/拼 URL/拼参数/脱敏，可注入 `platform/env/exists` 便于单测），`main.js` 才 `spawn`（`detached:true` + `unref()`）。
   - 入口显隐**只看探测结果**（`state.winScp.installed`）；`replace` 档拉起失败/未装必须**回落内置面板**（`openInlineSftp`），不允许“功能消失”。
   - 密码**只在 argv**（`sftp://user:pw@host:port/` + `-passphrase=`），所以**任何日志/状态一律脱敏**（`redactUrl`/`describeCommand` → `***`），不落盘、不写临时 ini、不经 shell。
   - user/password 必须 `encodeURIComponent`；堡垒机复合用户名**整体编码、不拆**；`displayHost` 只展示不连接。
   - 主机指纹不通用：WinSCP 用 PuTTY 风格 host key，别试图拿 `known_hosts` 去喂它。
   - **拉起/失败日志走 `console.log`（v1.0.17 起）**：`appLog.log('main', …)` 只落盘、不转发调试面板，用户排障时面板里看不到 WinSCP 任何痕迹（历史上就因此误判「没拉起」）。面板日志只写账号/主机/路径与 rawsettings，**任何情况下都不含密码**。
   - **必须带 `/rawsettings SFTPRealPath=off`（v1.0.16）**：WinSCP 开会话会 `REALPATH(".")` 探测家目录（`SftpFileSystem.cpp:2976`），chroot 型服务端（KoKo/H3C 网关/internal-sftp chroot）回错误码 4 → WinSCP 报「不能获得 '.' 的真实路径」直接打不开。`off` 后改走本地 canonify；想恢复原生行为设 `POLARIS_WINSCP_REALPATH=on`。顺便传 `RemoteDirectory=<绝对路径>`（面板目录 > `sftpPath` > `shellCwd`，相对路径不传），打开就落在用户刚才的位置。

13. **H3C 资产协议识别（v1.0.18）**：`dev.services.services` 的键**就是 H3C 的 proto 名**（`ssh` / `rdp` / `Device_Storage_web` …），不要只查 `srv.ssh`：
   - `bastionParseDevs` 产出 `protocols`（原始服务键数组，缺省 `['ssh']` 向后兼容老缓存）、`proto`（`ssh` 优先、其次 `sftp`、再次首个服务键）、`port`（所选服务的 port，缺省 22）、`webUrl`（`services.<*web*>.url`，只收 `http/https`）。
   - **非 SSH 资产不许打 `accessUrl`**：`bastionConnect` 开头 `bastionAssetSupportsSsh()` 拦下并给出可读提示（`bastionUnsupportedAssetMsg`，有 `webUrl` 就指到右键「🌐 用系统浏览器打开」）。RDP token 没有 `pw/pn`，硬连只会报「连接信息不完整」——那正是旧版用户看到的误导信息。
   - `handleAccessClientUrl` 用 `accessClientSessionKind(info)` 分类：`mstsc/rdp/vnc/guacamole/xfreerdp/spice` → `graphic`（明确说"图形会话，Polaris 无法接管"）、缺 `pw`+`hn/pn` → `incomplete`、其余（含带 `app` 字段的 SSH token）→ `ssh`。
   - 批量连接只连 SSH 资产；服务键出现意料之外的值（如 `-11.har` 里的 `B/S`）回落成原始键标签，不崩。
   - 回归：`verify-bastion-proto.js`（纯 Node，从 `renderer.js` 切 `bastionTagPaths … // 合并:按 devId 去重` 区块 eval，**移动/改名这段会明确报错**）+ `verify-bastion-har.js`（`POLARIS_HAR` 可指定任意 HAR）。

14. **H3C 客户端透传（v1.0.19，Windows-only）**：RDP / 存储 Web 资产靠 H3C 自己的 `AccessClient.exe`（安装时注册了 `accessclient://` URL scheme）拉起 mstsc / 浏览器 —— Polaris **不做 RDP 协议栈**，只把堡垒机签发的会话地址原样交出去（详见 `docs/decision-rdp-support.md`、`docs/release-v1.0.19.md`）。约定：
   - 纯函数在 `lib/h3c-client.js`（`isAccessClientUrl` / `detectPlan` / `parseDetect` / `parseHandler` / `handlerBasename` / `openTarget`），探测与执行在 `main.js`（`h3cClient:detect` + `execFileP`）。
   - **`app:openExternal` 里 `accessclient:` 分支必须放在 http/https 白名单之前，且绝不能过 `new URL()`**：token 里的 `+` `/` `=` `%` 会被重编码 → 解码 `zlib.inflateSync` 报 `unexpected end of file`。防注入靠字符集白名单（空格/引号/换行/超长一律拒）。
   - 入口显隐只认 `state.h3cClient.installed`（启动 `detectH3cClient()` 探测一次，失败静默回落"未装"，功能降级不消失）。没装时 **不请求 `accessUrl`**（记 `accessUrl-skip`），只给说明 + 浏览器直达。
   - `bastionNonSshEntry(a, clientInstalled)` 是入口文案唯一来源（右键首项 + 行 `title`）；`bastionOpenAccessClient` 失败必须**状态栏改红 + 弹窗写原因**，不许冒充成功。
   - 回归：`verify-h3c-client.js`（纯 Node 30/30）+ `verify-bastion-client-open.js`（e2e 17/17，靠 `POLARIS_H3C_CLIENT=1` / `POLARIS_TEST_NO_EXTERNAL=1` 在 macOS 也能跑）。

13. **SFTP 权限/属性与限速（v1.0.20）**：两件事都走纯函数模块，主进程只做编排。
   - `lib/sftp-attrs.js`：`parseMode`（`644`/`0644`/`0o644`，只收八进制，上限 `MAX_MODE=0o7777`）、`modeToSymbolic`（`s`/`S`/`t`/`T`）、`parseId`（空=不改，只收非负整数）、`toDatetimeLocal`/`parseDatetimeLocal`（秒级、本地时区往返）、`buildAttrsPatch`（字符串表单）、`validatePatch`（**主进程侧数值复核，唯一校验源**）、`describePatch`。**渲染层因无 nodeIntegration 只能各写一份解析**，所以 `verify-sftp-attrs.js` 专门做逐值对拍，改一边必须同步另一边。
   - `sftp:setAttrs` 顺序 **chown → chmod → utimes**（chown 清 setuid/setgid；uid+gid 必须同时给，缺的用当前 stat 回填；atime 缺省跟 mtime）。递归改权限先递归列清单，上限 `SFTP_ATTRS_RECURSE_MAX=20000`，符号链接目录不递归（防环）。只下发真的改了的项，一项没改 → 直接关框。
   - `lib/sftp-throttle.js`：`normalizeRate(kbps)` 入参 **KB/s** → 字节/秒（clamp 1~100MB/s，0/非法→0）；`createThrottle(0)` 返 `null`（**不插流、零开销**）；速率用「下一个允许开始时间」单调累加。`lib/ssh-client.js` `setTransferRate(bytesPerSec)` 入参是**字节/秒**，换算只在 `main.js sftp:setTransferLimit` 一处做。上传/下载管道 `rs.pipe(mid).pipe(ws)`，cancel/stall/error 各分支都要 `mid.destroy()`（否则留悬挂定时器）。
   - mock：`mock/sftp-vfs.js` 的 `SETSTAT` 必须应答，且**改 mode 要保留类型位** `(mode & 0o7777) | (dir ? 0o040000 : 0o100000)`，否则 `attrs.isDirectory()` 判错、面板把目录当文件。

## 安全约定

- 危险命令（rm -rf、dd、mkfs 等）在生产环境标记的主机执行前弹确认框
- 主机指纹校验（known_hosts）；`autoTrustHostKey` 设置可跳过首次信任弹窗
- **不要提交**：`.polaris-data/`、`*.har`、含真实凭据的脚本（verify-realdl/ui-dl/tcc 等）
- **任何对外可见的文字都不许出现真实 IP / 内网地址 / 主机名 / 凭据串**（Release 说明、CHANGELOG、AGENTS/CONTEXT、docs、代码注释、UI placeholder、提交信息一律算）。本项目约定占位符：堡垒机 `h3c-bastion.example`、JumpServer `jms.example`、PVE `pve.example`、存储 `storage.example`、测试主机 `real-host.example`、HAR 文件写 `bastion-*.har`（测试脚本按**后缀**匹配 `*.har`，绝不写死带 IP 的文件名）、OTP/会话串写 `XXXX-XXXX OTP:YYYY-YYYY`。**改动了已发布的 Release 正文**：`gh release edit <tag> --notes-file <文档>` 就地改（本仓库 v1.0.17/18/21/22 已按此清理）

## 常用调试

- 菜单栏「调试」（紧跟「帮助」）：终端调试日志（按键/焦点/收发数据，⌘⇧D 开关）、「⬇ 下载完整日志…」导出 app 日志、打开日志目录、清空调试日志。**工具栏不再有「调试」按钮**（v1.0.11 按要求挪进菜单栏）
- e2e 验证：`node verify-<功能>.js`（自动 spawn electron + 调试端口 + 临时数据目录，用后 pkill）
- **全量回归入口**：`node run-verify.js`（串行跑全部 `verify-*.js` 并汇总；`--pure` 只跑纯 Node 断言、`--e2e` 只跑 CDP、`--only=bastion` 按名字过滤、`--list` 看计划、`--fail-fast`/`--timeout=N`）。旧入口 `test-all.js` 含真实凭据、已被 .gitignore 排除且新克隆没有 → 以此脚本代替（入库，可直接在 CI 跑）
- CI 两道：`.github/workflows/build-windows.yml`（tag `v*` 触发打包发 Release）+ `.github/workflows/test.yml`（push/PR 跑 `run-verify.js --pure`，不启 Electron、不需要显示环境）
- 测试会杀掉正在运行的 app（pkill electron），测完需重启

## 当前状态（截至 2026-11-03）

> **2026-11-03 版本号重置**：GitHub 历史 Releases 与 `v*` 标签已按用户要求清理，版本号从 **v1.0.0** 重新开始；下方 v1.0.x 条目仅作为开发历史保留。

**当前版本 v1.0.23**（2026-11-13）：**对外可见文字去 IP 化**——界面占位符、文档、代码注释、测试用例、**已发布的 Release 正文**一律不再出现真实 IP / 内网地址 / 凭据串,统一占位符(`h3c-bastion.example`/`jms.example`/`pve.example`/`storage.example`,HAR 写 `bastion-*.har`,OTP 写 `XXXX-XXXX OTP:YYYY-YYYY`);HAR 相关用例改**按后缀扫**仓库根目录 `*.har`(`-5` 小样本优先、其次 `-11` 全量,没有就自动跳过),不再写死带 IP 的文件名;`gh release edit --notes-file` 就地清理了 v1.0.17/18/21/22 的页面正文;安全约定新增「任何对外可见文字都不许出现真实 IP/内网地址/主机名/凭据串」一条。回归:`run-verify --pure` **17/17 脚本 343 断言**、`verify-bastion-proto` 35/35、`verify-bastion-har` 13/13、`verify-h3c-client` 30/30、`verify-bastion-ui` 11/11、`verify-bastion-clear` 16/16、`verify-bastion-panel-fix` 7/7、`verify-bastion-multisite` 5/5、`verify-bastion-pull-move` 5/5、`verify-sftp-pin` 24/24、`verify-sftp-sizes` 5/5、`verify-ui-layout` 21/21。发布说明 `docs/release-v1.0.23.md`。
上一版本 v1.0.22（2026-11-13，已发版）：**「打开 SFTP 时」默认改成内置面板 + WinSCP 协议可选 SFTP/SCP**——v1.0.15 把「点 SFTP 直接拉 WinSCP」设成了默认,可现场已经两次被 WinSCP 的「错误码 4 / General failure」挡住(见 `docs/winscp-realpath-fix.md`),默认不该把用户交给一个可能进不去的第三方程序。① 默认 `button` 档(`winScpMode()` 缺省值改为 `'button'`,**且只认 `replace/button/panel` 三值**,其它一律回落 `button`):点 SFTP 直接开内置面板,WinSCP 变成面板工具栏「🪟 WinSCP」按需按钮;老配置里**从没自己选过**的 `replace` 自动迁到 `button`(`settingsVersion` 3→4 + `winscpModeMigrated` 一次性标记,**用户自己选过 `replace` 的不动**,切档时置标记)。② 新增「WinSCP 协议」(`sftp` 默认 / `scp`):`scp://` 走服务器 `scp` 命令、**完全绕过 SFTP 子系统**——`LSTAT`/`OPENDIR` 被回 4 的老设备(H3C/嵌入式)用它绕过去;SCP 会话**不下发 `SFTPRealPath=off`**(SFTP 专属开关,带了只让人误判),日志/私钥/口令/`RemoteDirectory` 照常;`redactUrl`/`describeCommand` 同步覆盖 `scp://`;非法 scheme 一律回落 `sftp`(`buildSessionUrl` 里 `SCHEMES=['sftp','scp']` 白名单)。③ `openInlineSftp()` 末尾 `refreshWinScpButton()`:面板每次打开都按当前状态重刷按钮(此前只有开设置/探测时才刷)。回归:`verify-winscp-args` 34→**38**(scheme 默认/大小写/非法回落/堡垒机复合用户名整体编码/`scp://` 脱敏)、`verify-winscp-open` 39→**46**(默认档 button、下拉首项顺序、v4 迁移两种情形、协议下拉、`scp://` 真实拉起且无 `SFTPRealPath`、面板重刷)、`verify-sftp-panel` 5/5、`verify-sftp-attrs-dialog` 16/16、`verify-theme` 21/21,`run-verify --pure` **17/17 脚本 343 断言**。发布说明 `docs/release-v1.0.22.md`。
上一版本 v1.0.21（2026-11-13，已发版）：**WinSCP 排障日志默认开启 + `POLARIS_WINSCP_RAWSETTINGS` 逃生阀**——现场 `SFTPRealPath=off` 之后 WinSCP 仍报「一般错误 / 错误码 4 / General failure」（报错文字已不再是「不能获得'.'的真实路径」，说明 `off` 生效、失败点移到启动序列后面的请求；按 WinSCP 源码 `GetHomeDirectory()` 之后紧跟 `TryOpenDirectory` → 先发 `SSH_FXP_LSTAT`，服务器回 4/FAILURE 直接致命）。此前 WinSCP 日志只在 `POLARIS_WINSCP_DEBUG=1` 时才写，用户拿不到证据。改动：① `buildArgs()` 语义改成**给了 `logPath` 就下发** `/log=<path> /loglevel=1`（`debug` → `*` 全协议包），空/空白路径整组不传；② `main.js winScp:open` **默认**写 `<数据目录>/logs/winscp-<YYYYMMDD-HHMMSS>.log`（先 `mkdirSync` 再拉起，建不出来就不传日志、绝不因此不给用户开 WinSCP），拉起日志带 `| 日志=<path>`；③ 新增 `parseRawSettings()` 解析 `POLARIS_WINSCP_RAWSETTINGS`（分号/换行分隔 `名=值`，只收 `[A-Za-z]` 开头名字与非空值，非法整条丢弃），**叠加在默认 rawsettings 之上（同名覆盖）**，用户试开关不必等新版本。排查表（REALPATH/LSTAT/OPEN 各自判定与绕过）+ 内置面板交叉验证写在 `docs/winscp-realpath-fix.md` 第六节。回归：`verify-winscp-args` 32→**34**、`verify-winscp-open` 37→**39**（argv 里确有 `/log=<数据目录>/logs/winscp-<时间戳>.log` + `/loglevel=1`、日志目录提前建好），`run-verify --pure` **17/17 脚本 339 断言**（原 17/337）。发布说明 `docs/release-v1.0.21.md`。
上一版本 v1.0.20（2026-11-13，已发版）：**SFTP 补两个干活必备能力——「🔐 权限与属性」对话框 + 传输限速**（用户要的就是 WinSCP 里那两个天天用的功能，这样「设置→SFTP→WinSCP」选 `panel` 也不缺胳膊少腿）。① **权限/属主/时间戳**：SFTP 面板右键 →「🔐 权限与属性…」，**先 `sftp:stat` 读远端真实属性再允许保存**（读到前「保存」禁用，不盲改），权限支持 `644`/`0644`/`0o644` 三种写法 + 四个快捷档位 + 实时 `ls -l` 符号预览（`s`/`S`/`t`/`T` 四个特殊位都对），UID/GID/`mtime`（本地时间）一起改；目录多一个「递归」，先列清单**上限 20000 条**（`SFTP_ATTRS_RECURSE_MAX`，返回 `truncated`），符号链接目录不递归防环；下发**顺序固定 chown→chmod→utimes**（chown 会清 setuid/setgid，先 chmod 白改；uid+gid 必须一起给，缺的用当前 stat 回填；atime 缺省跟 mtime）；**只下发真的动过的字段**，一项没改直接关框；失败项收集前 10 条回显、成功数写进传输记录（`🔐 权限 644 / UID 0 / GID 1000`）。② **校验两端各做一次**：渲染层即时红字，主进程 `sftp:setAttrs` 再用 `lib/sftp-attrs.js` 的 `validatePatch()` 复核（IPC 不是只有对话框能调），`mode` 上限 `0o7777`；`parseMode` 只收八进制（`64O`/`8xx`/`77777`/负数都报错）。③ **限速**（设置→SFTP→「传输限速(每条连接,KB/s;0=不限)」）：`lib/sftp-throttle.js` 的节流 Transform **插在 `rs.pipe → mid → ws` 中间**，不碰 ssh2 底层 SFTP 请求、不改断点续传/上传对账（它们只看流是否正常结束），带 backpressure 不会"内存攒一大坨再灌 socket"；速率按「下一个允许开始时间」**单调累加**（不是逐块定长 sleep，长跑速率稳定）；`createThrottle(0) = null` → **0 档不插流、零开销**；cancel/假死/error 各分支都 `mid.destroy()` 并清定时器（有断言"destroy 后 400ms 内必须 close"）。**单位口径**：`normalizeRate(kbps)` 入参 KB/s、`sshClient.setTransferRate(bytesPerSec)` 入参字节/秒，换算只在 `main.js sftp:setTransferLimit` 一处做。④ mock：`sftp-vfs.js` 补 **SETSTAT** 应答（chmod/chown/utimes 各一次应答，缺它客户端一直等），且**改 mode 必须保留类型位**（`| 0o040000`/`| 0o100000`，真实 OpenSSH 回 `0o100640`，不补面板把目录当文件）。回归：新增 `verify-sftp-attrs.js`（纯 Node **100**，含渲染层/服务端两份八进制解析逐值对拍）、`verify-sftp-throttle.js`（**37**，含"200KB @100KB/s 实测约 2s"）、`verify-sftp-attrs-dialog.js`（Electron+mock **16**，端到端 chmod/chown/utimes/递归/限速下载实测 761ms vs 153ms）；`run-verify --pure` **17/17 脚本 337 断言**（原 15/200）；download-many 16/16、sftp-panel 5/5、batch-sftp 5/5、upload-flash 3/3、transfer-cancel 10/10、sftp-cancel 9/9 无退化。发布说明 `docs/release-v1.0.20.md`。
上一版本 v1.0.19（2026-11-13，已发版）：RDP / 存储 Web 资产双击直接交给 H3C 客户端打开（方案 A）——v1.0.18 只做到「识别出非 SSH 资产 + 提示去网页开」，这一版把双击之后那一步补上。真实 HAR 证实 H3C 的 RDP/Web 本来就是靠 `AccessClient.exe` 拉起 mstsc / 浏览器（RDP token = 一份 mstsc 配置：`app:mstsc`、`fa:s:<网关>:3389`、`sa:super`、`as:…OTP:…`，**无 `pw`/`hn`/`pn`**），所以 Polaris 不做 RDP 协议栈，把堡垒机签发的 `accessclient://<token>` **原样交给本机已装客户端**（评估见 `docs/decision-rdp-support.md`：`node-rdpjs`/`mstsc.js` 是 AGPL v3.0 直接排除；FreeRDP 只发源码；IronRDP 要 Rust + 4~8 周）。实现：① 新增 `lib/h3c-client.js` 纯函数（`isAccessClientUrl` 只放行 accessclient:// + urlsafe 字符集、挡 http/file/注入/超长；`detectPlan` 用 `%SystemRoot%\System32\reg.exe` 查 `HKCR\accessclient` 的 `URL Protocol`，非 Windows `supported:false`；`openTarget` **返回原样字符串**）；② 主进程新增 `h3cClient:detect`，且 **`app:openExternal` 的 `accessclient:` 分支放在 http/https 白名单之前、不过 `new URL()`**（token 里的 `+` `/` `=` `%` 会被重编码 → `zlib.inflateSync` 报 `unexpected end of file`）；③ 渲染层 `state.h3cClient` + 启动 `detectH3cClient()`（失败静默回落「未装」，功能降级不消失）、`bastionConnectNonSsh()`（**装了才请求 accessUrl**，没装记 `accessUrl-skip` 绝不发无效请求）、`bastionOpenAccessClient()`（走唯一外链出口 `openExternalUrl`，失败状态栏改红 + 弹窗写原因）、纯函数 `bastionNonSshEntry()` 统一入口文案、`bastionUnsupportedAssetMsg(a,{clientMissing})` 补安装指引、`isOpenableUrl()` 显式放行 accessclient://；④ **安全**：不分发 H3C 闭源二进制（`POLARIS_H3C_CLIENT=1` 仅为回归钩子）、白名单仍只 `accessclient://`、日志不含 token 正文。回归：新增 `verify-h3c-client.js`（纯 Node **30/30**）+ `verify-bastion-client-open.js`（e2e **17/17**，含「透传地址逐字节一致」「失败不冒充成功」「未装记 skip」「http 白名单回归」）；`verify-bastion-proto.js` **35/35**；`verify-bastion-har.js` 10/10；`run-verify --pure` **15/15 脚本 200 断言**；`verify-bastion-ui` 11/11、`verify-bastion-browser-ui` 9/9、`verify-term-links` 28/28。发布说明 `docs/release-v1.0.19.md`。
**当前版本 v1.0.19**（2026-11-13）：**RDP / 存储 Web 资产双击直接交给 H3C 客户端打开（方案 A）**——v1.0.18 只做到「识别出非 SSH 资产 + 提示去网页开」，这一版把双击之后那一步补上。真实 HAR 证实 H3C 的 RDP/Web 本来就是靠 `AccessClient.exe` 拉起 mstsc / 浏览器（RDP token = 一份 mstsc 配置：`app:mstsc`、`fa:s:<网关>:3389`、`sa:super`、`as:…OTP:…`，**无 `pw`/`hn`/`pn`**），所以 Polaris 不做 RDP 协议栈，把堡垒机签发的 `accessclient://<token>` **原样交给本机已装客户端**（评估见 `docs/decision-rdp-support.md`：`node-rdpjs`/`mstsc.js` 是 AGPL v3.0 直接排除；FreeRDP 只发源码；IronRDP 要 Rust + 4~8 周）。实现：① 新增 `lib/h3c-client.js` 纯函数（`isAccessClientUrl` 只放行 accessclient:// + urlsafe 字符集、挡 http/file/注入/超长；`detectPlan` 用 `%SystemRoot%\System32\reg.exe` 查 `HKCR\accessclient` 的 `URL Protocol`，非 Windows `supported:false`；`openTarget` **返回原样字符串**）；② 主进程新增 `h3cClient:detect`，且 **`app:openExternal` 的 `accessclient:` 分支放在 http/https 白名单之前、不过 `new URL()`**（token 里的 `+` `/` `=` `%` 会被重编码 → `zlib.inflateSync` 报 `unexpected end of file`）；③ 渲染层 `state.h3cClient` + 启动 `detectH3cClient()`（失败静默回落「未装」，功能降级不消失）、`bastionConnectNonSsh()`（**装了才请求 accessUrl**，没装记 `accessUrl-skip` 绝不发无效请求）、`bastionOpenAccessClient()`（走唯一外链出口 `openExternalUrl`，失败状态栏改红 + 弹窗写原因）、纯函数 `bastionNonSshEntry()` 统一入口文案、`bastionUnsupportedAssetMsg(a,{clientMissing})` 补安装指引、`isOpenableUrl()` 显式放行 accessclient://；④ **安全**：不分发 H3C 闭源二进制（`POLARIS_H3C_CLIENT=1` 仅为回归钩子）、白名单仍只 `accessclient://`、日志不含 token 正文。回归：新增 `verify-h3c-client.js`（纯 Node **30/30**）+ `verify-bastion-client-open.js`（e2e **17/17**，含「透传地址逐字节一致」「失败不冒充成功」「未装记 skip」「http 白名单回归」）；`verify-bastion-proto.js` **35/35**；`verify-bastion-har.js` 10/10；`run-verify --pure` **15/15 脚本 200 断言**；`verify-bastion-ui` 11/11、`verify-bastion-browser-ui` 9/9、`verify-term-links` 28/28。发布说明 `docs/release-v1.0.19.md`。
上一版本 v1.0.18（2026-11-13，已发版）：**H3C 堡垒机分得清 RDP / Web 资产（不再当 SSH 连）**——用户给的真实流量 `bastion-5.har` 对照后发现：H3C 资产 `dev.services.services` 的键**就是协议名**（实测 `ssh` / `rdp` / `Device_Storage_web`），旧代码只认 `ssh`/`sftp`、其余一律当 `ssh` → 双击 RDP/存储资产会拿 `proto='ssh'` 去请求 `accessUrl`（堡垒机协议不匹配，留失败访问记录），或拿到无 `pw/pn` 的图形 token 后只报「堡垒机连接信息不完整」。全量 HAR 复算：**854 台里 180 台（~21%）不是 SSH**。修法：① `bastionParseDevs` 按服务键识别协议，新增 `protocols`（保留原始键）+ `webUrl`（`services.<*web*>.url`，只收 http/https），`proto=ssh→sftp→首个服务键`、`port` 取所选服务端口；② `bastionConnect` 开头拦非 SSH 资产（**不发 accessUrl**），提示写清协议 + 替代路径（有 `webUrl` 指到右键「🌐 用系统浏览器打开」）；③ `handleAccessClientUrl` 先判 token 类型（`mstsc/rdp/vnc/…` → 图形客户端明确提示；缺 `pw/pn` → 不完整），SSH token 照旧接管；④ 批量连接只连 SSH 资产并在状态栏标「跳过 M 台非 SSH」；⑤ 列表行加橙色协议徽标（`RDP`/`Web`/原始键，多协议并集）、名字压次要色，右键菜单对非 SSH 资产首项换成「ℹ️ 非 SSH 资产(RDP)，点此查看说明」，SSH 专属项只对 SSH 资产出现。回归：新增 `verify-bastion-proto.js`（纯 Node，**29/29**，从 `renderer.js` 切纯函数区块 eval）、`verify-bastion-har.js` **6/6**（`-5.har` 小样本）/ **13/13**（`-11.har` 全量，`findHar()` 支持 `POLARIS_HAR` 与 `-5.har`、小样本不再被规模阈值误报、新增真实数据协议判定 + DOM 徽标断言）、`run-verify --pure` **14/14 脚本 164 断言**（原 13/135）、`verify-bastion-ui` 11/11 无退化。发布说明 `docs/release-v1.0.18.md`。
上一版本 v1.0.17（2026-11-12，已发版）：**WinSCP 排障日志可见**——用户贴回 v1.0.16 的调试日志里一条 `[WINSCP]` 都没有（只剩 `window blur … active=BUTTON#btn-sftp-toggle`），根因是**日志只落盘不转发渲染层**（`appLog.log('main', …)` 不进 `main:log` 通道），所以「点 SFTP 后 WinSCP 起没起、`SFTPRealPath=off` 带没带」在面板上完全看不到。修法：① `main.js winScp:open` 的拉起成功/失败两处改 `console.log`（同时进面板 + 落盘，内容仍是脱敏后的命令行 `… /rawsettings SFTPRealPath=off RemoteDirectory=/root | rawsettings={…}`）；② `renderer.js openSessionInWinScp/toggleSftpPanel` 新增 `dlog`：`交给 WinSCP: 账号@主机:22 起始目录=…` / `WINSCP·错误 …` / `拉起失败 → 回落内置 SFTP 面板(功能不消失)` / `本机未检测到 WinSCP`（只含账号/主机/路径，**永不含密码**）。③ `verify-winscp-open.js` 拿 sid 一轮失败会再点一次连接再等一轮（消除 mock 握手抖动导致 18 条断言连坐）。回归：`verify-winscp-open.js` 32→**37**、`--pure` **13/13 脚本 135 断言**、key-forward 7/7、ai-copy 11/11、sftp-panel 5/5。发布说明 `docs/release-v1.0.17.md`。
上一版本 v1.0.16（2026-11-12，已发版）：**修「WinSCP 报『不能获得 '.' 的真实路径』（错误码 4）」**——v1.0.15 拉起 WinSCP 后必现。根因在 WinSCP 自己：建会话时先对 `"."` 发 `SSH_FXP_REALPATH` 当作家目录（`source/core/SftpFileSystem.cpp:2976` `FHomeDirectory = RealPath(L".")`，默认 `SessionData.cpp:303` `SFTPRealPath = asAuto`），而 **chroot 型服务端**（JumpServer KoKo 网关、H3C 网关、`internal-sftp` chroot、老 ProFTPD）对该请求直接回 `SSH_FX_FAILURE`（错误码 4）→ WinSCP 当致命错误抛出。Polaris 自己的面板从不受影响（家目录走 `exec pwd` + `readdir`，从不发 REALPATH）。修法：拉起命令追加 `/rawsettings SFTPRealPath=off`（`RealPath()` 改走 `LocalCanonify`）+ 已知目录作为 `RemoteDirectory`（**面板当前目录 > 标签 `sftpPath` > 跟踪的 `shellCwd`**，相对路径/未知不传）；要恢复 WinSCP 原生行为 `POLARIS_WINSCP_REALPATH=on`。代码：`lib/winscp-open.js` 新增 `RAW_SETTINGS_DEFAULTS` / `buildArgs({rawSettings})`（空值跳过、顺序稳定）/ `normalizeRemotePath()` / `realPathCompat(env)`，`main.js winScp:open` 组装 rawsettings 并在拉起日志记 `rawsettings=…`，`renderer.js winScpPayloadFor()` 增加 `remotePath`。回归：`verify-winscp-args.js` 25→**32**、`verify-winscp-open.js` 27→**32**（argv 里确有 `SFTPRealPath=off` 与 `RemoteDirectory=/srv/my dir`）、`--pure` **13/13 脚本 135 断言**。根因/手工绕过见 `docs/winscp-realpath-fix.md`，发布说明 `docs/release-v1.0.16.md`。
上一版本 v1.0.15（2026-11-12，已发版）：**新功能「点 SFTP 直接用本机 WinSCP 打开这个会话」**（用户要“别再手输一遍密码，用 WinSCP 的同步/权限对话框/限速/双窗格干重活”）。① 三档设置（设置 → SFTP）：`replace`（默认，点 SFTP 直接拉起 WinSCP，**没装/拉起失败自动回落内置面板**）/ `button`（照开内置面板 + 工具栏「🪟 WinSCP」按钮）/ `panel`（WinSCP 入口完全不出现）；入口显隐**只认 `state.winScp.installed`**，不出现“按钮在、点了必报错”。② 参数：`WinSCP.exe sftp://账号:密码@主机:端口/ [-privatekey=<路径>] [-passphrase=<口令>]`；user/password 走 `encodeURIComponent`（不编码会被 WinSCP 解析歪 → “密码错误”）；**堡垒机复合用户名 `jms@ssh@账号@资产IP` 原样整体编码**，`displayHost` 绝不用于连接；主机指纹交 WinSCP 自己问（PuTTY 风格与 `known_hosts` 不通用）。③ **密码进 argv 的取舍**（WinSCP 无库 API、读不到 `safeStorage`）：配套硬约束是**不落盘 + 不写日志**——`redactUrl`/`describeCommand` 把密码与 `-passphrase=` 均压成 `***`，`termDebug`/状态栏/`logs/app-*.log` 只有 `sftp://user:***@host:22/`；风险（同用户/本机管理员可见 argv）已写进文档，不想要就切 `button`/`panel`。④ 代码：新增 `lib/winscp-open.js`（纯函数：候选路径/`%VAR%` 展开/`detectExe({platform,env,exists})`/`buildSessionUrl`/`buildArgs`/`redactUrl`/`describeCommand`，可注入便于单测）+ `main.js` `winScp:detect|open`（`spawn` 时 `detached:true`+`unref()`，Polaris 退出后 WinSCP 继续用）+ `preload.js` 两桥接 + `#set-winscp-mode` + `#btn-sftp-winscp` + 标签右键菜单项；`toggleSftpPanel` 内联逻辑抽成 `openInlineSftp()` 供回落复用；`POLARIS_WINSCP_PATH` 指定自定义安装路径、`POLARIS_WINSCP_DEBUG=1` 让 WinSCP 写自己的 `/log`。⑤ **非 Windows 无感**：`detectExe` 对 `darwin/linux` 返 `null`，macOS/Linux 看不到任何 WinSCP 入口。回归：新增 `verify-winscp-args.js` 25/25（纯 Node）+ `verify-winscp-open.js` 27/27（真启动 Electron + shell 桩，连跑两次稳定）；`--pure` **13/13 脚本 128 断言**；key-forward 7/7、ai-copy 11/11、sftp-panel 5/5、sftp-download-many 16/16 无退化。详见 `docs/release-v1.0.15.md` + `docs/decision-winscp-integration.md` 文末「已实现」。
上一版本 v1.0.14（2026-11-11，已发版）：**修「AI 对话区文字不能复制」+「Ctrl+C 不生效」**——两者同一个根因：全局 keydown 兜底把按键 `preventDefault()` 后转发给终端，连 ⌘/Ctrl+C 的原生复制一起吞；而转发本身也坏（合成 `KeyboardEvent` 没带 `keyCode`，线上日志 `KEY 'c' ^ … kc=0`，xterm 拿不到键码直接丢弃）。修法：① `#ai-chat` 加 `tabindex="-1"`，点进对话区焦点就归它，按键不再走终端兜底；② 有"终端以外"选中文字时 ⌘C 一律放行原生复制（`hasSelectionOutsideTerm()`，BODY 焦点也算）；③ 合成事件用 `Object.defineProperty` 补 `keyCode`/`which` → Ctrl+C `\u0003`/Ctrl+D `\u0004`/Tab/方向键/字母真正进终端；④ 合成事件打 `__polarisSynthetic` 标记，handler 开头 return（防递归转发）；⑤ 对话区 ⌘A = 全选对话内容（`selectAllInRegion`）；⑥ 每条消息「📋」+ 每个代码块「📋 复制命令」，AI 面板补 `user-select: text`；⑦ 对话区里组合键不再转发（避免无选中时 Ctrl+C 静默给远端发 `^C` 打断命令）。回归：新增 `verify-ai-copy.js` 11/11（修复前 1/9）、`verify-key-forward.js` 7/7（修复前 3/7）；`--pure` 12/12 脚本 103 断言。
上一版本 v1.0.13（2026-11-11，已发版）：**修「文件夹下载 / 多文件下载失败」**——这条链路 5 个真实成因全部修掉：① `lib/ssh-client.js` `walkRemote` 以前一个子目录 `readdir` 报错就整批抛错（真实服务器上 root 拥有的子目录很常见）→ 现在子目录失败只记一条失败项（界面出「✗ 失败」行），其它文件照常下完；② **失败项串行重试**——批量并发（`SFTP_CONCURRENCY=2`）在 H3C/KoKo 类"SFTP 串行处理"设备上会让部分文件失败，`startDownloadJob` 的 `many` 分支现在把失败文件逐个串行再试一次（并重开 SFTP 通道），成功即并入结果（`retried:true` + 日志「下载重试成功」）；③ 符号链接到目录以前被当文件下载（`readdir` 给的是链接自身 mode `0o12xxxx`）→ 现在 `stat`（跟随链接）判真实类型、递归 + `visited` 防环；④ `sftp:downloadMany` 对 `isDir:false` 的条目 stat 兜底（目录仍按目录递归）；⑤ 批量进度 `total` 被回调参数遮蔽（总进度恒 100%）已修，`total` = 全批总字节。另外：本地写失败按错误码补人话提示（Windows 260 字符路径过长/磁盘满/EISDIR/占用只读），递归时先建本地子目录（空文件夹不再消失）。回归：新增 `verify-sftp-download-many.js` 16/16（修复前 5/11）+ `verify-sftp-download-fail` 7/7、`verify-sftp-cancel` 9/9、`verify-sftp-stress` 7/7、`verify-batch-sftp` 5/5、`--pure` 12/12 脚本 103 断言。

上一版本 v1.0.12（2026-11-11，已发版）：**DeepSeek 配置改为官方 OpenAI 兼容端点**——默认模板/新增厂商默认值用 `https://api.deepseek.com/v1`（自动拼 `/chat/completions`），另留 `https://api.deepseek.com/anthropic`（Anthropic 兼容）备选；**端点与「接口格式」必须配套**（openai↔`/v1`、anthropic↔`/anthropic`），混用即 401，`migrateDeepSeekUrl` 已按各厂商 `format` 补对应地址。回归 `verify-ai-config.js` 11/11。

上一版本 v1.0.11（2026-11-11，已发版）：**修「AI 功能用不了」+ 工具栏「调试」移入菜单栏**——① AI 配置缺失时不再静默回落到官方 Anthropic/OpenAI 地址与 `claude-sonnet-5` 模型（那正是「填了 DeepSeek Key 也发不出去」的根因）：`main.js` `ai:chat` 与 `lib/session-groups.js` `ai:suggestCmd` 在 `url`/`model` 为空时直接返回可读错误；`src/renderer.js` `aiSend` 发送前校验并自动展开 ⚙；`lib/ai-stream.js` 新增 `aiErrorHint`（401/402/404/429/5xx → 指向该改哪个输入框）。② ⚙ 新增「快速模板」下拉（`AI_VENDOR_PRESETS`：DeepSeek/OpenAI/DashScope/智谱/Moonshot/Anthropic/OpenRouter），DeepSeek 模板已实测跑通；「＋ 新增厂商」默认即为 DeepSeek 可跑通配置。③ 工具栏「调试」按钮删除，入口移到菜单栏「调试」（紧跟「帮助」：终端调试日志 ⌘⇧D / 下载完整日志 / 打开日志目录 / 清空调试日志）——**新增菜单项必须同时在 `preload.js` `onMenu` 白名单里登记 channel，否则点击静默无反应**。回归：新增 `verify-ai-config.js` 10/10（含可选真实 Key 实测）。

上一版本 v1.0.10（2026-11-06，已发版）：**修「输入法死键吞字符」**——输入法卡在"假组合"状态时字符键只产生 `KEY 'Process' kc=229`、**没有任何 SEND**（命令打不进去，只剩退格/回车能发）。旧逻辑要求"**连续** 3 个死键"才 `blur()+focus()` 重建 IME 会话，而用户实际节奏是「2 连发 → 退格 → 2 连发」，计数被普通按键复位 → 永远到不了阈值。现在改成**时间窗 + 延迟判定**（`src/renderer.js` `setupImeGuard`）：每个 `Process/229` 各自排一个 150ms 结算定时器，期间没等到真正的 `compositionstart` 才算死键（正常拼音输入第一时间就来组合事件，不会误伤），3s 内累计 2 个即重建会话；跨窗口不累计；`compositionstart` 清空统计。另一处隐患同时修掉：普通按键被 xterm 处理完会 `stopImmediatePropagation`，靠 `ta` 上的 keydown 清计数收不到（实测只有 229 能收到），改用 `term.onData` 清；状态栏提示由"仅 Windows"放开到全平台（每终端一次）。回归：新增 `verify-ime-deadkey.js` 9/9（修复前 6/9，②③ 红）。

上一版本 v1.0.9（2026-11-06，已发版）：**终端支持 Cmd/Ctrl+点击打开浏览器链接**——`term.registerLinkProvider` 自研链接识别器（`registerTermLinks`）：只认 `http/https`（`extractTermUrls` 正则 + 尾部标点/括号裁剪 + 主机名校验），鼠标悬停给下划线/手型光标并在状态栏提示，**⌘（mac）/ Ctrl 点击**才打开（裸点击留给拖选，避免误触），走既有 `app:openExternal`（主进程 http/https 白名单第二道）。range 按**单元格**算（`line.getCell(x).getWidth()`，双宽字符占两列），含中文的行不会把链接点偏；折行 URL 按 `line.isWrapped` 拼回整条。右键菜单在选中内容是链接时多一项「🔗 在系统浏览器打开」。主进程加测试钩子 `POLARIS_TEST_NO_EXTERNAL=1`（只回 `{ok:true,skipped:true}`，回归不弹浏览器）。回归：新增 `verify-term-links.js` 28/28。

上一版本 v1.0.8（2026-11-06，已发版）：**修「自动锁定后无法输入密码」+ 主题全换新**——① 锁定界面焦点加固：锁定期全局 keydown 一律路由到 `#lo-pw`（Enter 解锁/Backspace 删除），点覆盖层空白处拉回焦点，`lo-pw` blur 立刻抓回，弹窗焦点锁（`focusin`/`focusout`）在锁定时让位，`refocusTerminal`/`sftpRefocusTerminal` 锁定时不抢焦点，窗口 focus 回密码框；`.lock-overlay` z-index 300→1200（压住命令补全 1000）。根因（已复现）：点空白 → 焦点掉 BODY → 全局 BODY 兜底把密码字符发到 SSH 会话；弹窗开着时锁 → 弹窗焦点锁抢走密码框焦点。回归 `verify-autolock-input` 17/17。②**主题全换新**——10 套内置配色整体替换为 Tabby/iTerm2 精选（tokyonight/dracula/nord/solarizedDark/gruvboxDark/oneHalfDark/iceberg/rosePine + 浅色 github/oneHalfLight），只取终端色板、UI 外壳仍派生；旧键经 `THEME_ALIASES` 迁移（dark→tokyonight、light→github、termius*→oneHalf*、catppuccinMocha→iceberg，其余回落默认）；`deriveUiTokens` 增加**对比度保底**（正文 ≥4.5、`--text-dim` ≥3.0，10 套实测最低 8.99/3.05）；新增 `NOTICE` 署名（Tabby / iTerm2-Color-Schemes，均 MIT）。回归：`verify-theme` 21/21（重写：11 项下拉/旧键迁移/派生值/10 套对比度遍历/auto 跟随）、`verify-ui-layout` 21/21、`--pure` 12/12 脚本 103 断言。

上一版本 v1.0.7（2026-11-03）：**收尾打磨 + 测试基建**——① **修「总是弹『信任并连接』」**：信任框新增第三选项「信任并记住所有主机」（`onTrustAll` → 渲染层开 `settings.autoTrustHostKey` 并落盘）；`known-hosts.set()` 改成写入后回读校验并返回 boolean，失败时 `onPersistFail` → 状态栏红字告知“指纹没能保存到 <路径>，下次仍会询问”（治过去的静默失败）；排查文档 `docs/host-trust.md`，回归 `verify-host-trust` 23/23。② 堡垒机面板去掉重复选择控件（A2）：已保存连接只由顶部标签栏出，地址栏下拉只留标签栏覆盖不到的站点（左侧 JumpServer 服务器 / 已有资产的堡垒机 URL，`optgroup` 按来源分组，无额外站点时整体 `.hidden`）；`bastionSelectableServers()` 内部清单不变（`B:id` 双击资产链路保留），`bastionSelectServer` 对 cfg 同步 `bastionActiveTabId` + 重绘 tabs，末尾复位下拉。② 全量回归入口入库 `run-verify.js`（串行 + 汇总断言 + `--retry` 标记 flaky；`--pure` 供 CI）。③ 新增 `.github/workflows/test.yml`（push/PR 跑 `--pure`）；`npm ci` 支持 `POLARIS_SKIP_ELECTRON=1`。④ 新手引导不再叠在其他弹窗上（检测到 `.modal:not(.hidden)` 就等，最多 5 次×1.5s）。回归：全量 89/92（3 个历史红灯见 `docs/verify-known-red.md`，已 stash 复核与本轮无关）、`--pure` 11/11 脚本 80 断言全绿、`verify-bastion-ui` 11/11、`verify-bastion-server-sync` 4/4、`verify-bastion-merge` 9/9、`verify-bastion-browser-ui` 9/9。

上一版本 v1.0.6（2026-11-03）：**新手可用性四件套**——① 终端右键菜单 / ⌘K 命令面板新增「🔐 切换 root（su - root）」：一键发 `su - root`，密码框支持 Ctrl/Cmd+V 与「📋 粘贴」按钮；`tab.suPending` 抑制 `autoFillPassword`（避免把登录密码误发给 su），root 密码走 `noLog` 不进日志/录制，取消即 Ctrl+C 中止；会话可保存 `su_password`（加密入库，`sessions:create/update` 加解密，老库自动补列），有保存值时检测到 `Password:` 自动发送、不再弹框。② 新手引导向导（三步，首次无会话解锁后自动弹，关闭/跳过持久化 `onboardingDone`，空态卡片可重开）。③ 「从 ~/.ssh/config 导入」（`lib/ssh-config.js` 纯函数解析 `Host`/`HostName`/`User`/`Port`/`IdentityFile`、`Host *` 全局默认、`~` 展开；IPC `sessions:importSshConfig`，`.conf`/`config` 也走 `importExternal`）。④ 会话列表空态卡片（新建/批量导入/SSH 导入/快捷连接）并修正首次启动主机分组默认折叠导致卡片不可见。回归：`verify-su-root` 13/13、`verify-onboarding` 24/24、`verify-ssh-config` 16/16、`verify-ssh-config-import` 20/20、`verify-ui-layout` 21/21。

上一版本 v1.0.5（2026-11-03）：**修 H3C `ERR_CERT_AUTHORITY_INVALID`**——证书放行改为 `app.whenReady` 启动时、任何 webview/请求之前安装（避免 webview 先登录把失败结果缓存）；h3c-api 捕获证书错误后自动重装放行并重试一次。回归 `verify-h3c-cert` 1/1、`verify-h3c-native` 15/15。

上一版本 v1.0.4（2026-11-03）：**修堡垒机配置弹窗显示**——「添加堡垒机站点」补右上角 ✕；打开弹窗时临时隐藏 `bastion-webview`，避免 Electron guest view 盖住宿主弹窗/按钮。回归 `verify-bastion-browser-ui` 9/9。

上一版本 v1.0.3（2026-11-03）：**识别 nologin 账号**——远端账号 shell=`/usr/sbin/nologin` 时，服务器发 `This account is currently not available.` 后立即断开；现在会标记 `tab.noLogin`、状态栏/终端给出「换有 shell 的账号 / usermod -s /bin/bash」提示，并停止自动重连。回归 `verify-nologin-hint` 5/5。

上一版本 v1.0.2（2026-11-03）：**修终端空格被 xterm 组合态吞掉**——日志特征 `KEY '␣'` 有、`SEND` 没有，失焦/聚焦才恢复；新增 250ms 看门狗，自动重建输入法会话（不自动补发空格），KEY 日志补 `ime/keyCode`。回归 `verify-space-composition-flush` 6/6。

上一版本 v1.0.1（2026-11-03）：**优化右侧堡垒机浏览器面板**——工具栏精简（清除历史收进「⋯」更多菜单）、空态/加载/错误态结构化并带「重试」、更多菜单支持系统浏览器打开/复制地址/重置缩放、双击缩放恢复 100%、拖动面板后自动重新适配。回归 `verify-bastion-browser-ui` 8/8。

上一版本 v1.0.0（2026-11-03）：版本号重置后的首个正式版，包含 **Windows 安装版自动更新**——检查更新后可「下载更新 → 显示进度 → 重启安装」；electron-updater + GitHub provider，CI 随 Release 上传 `latest.yml`/`.blockmap`。便携版、开发版、非 Windows 回退打开下载页；未签名安装包 `verifyUpdateCodeSignature=false`。回归 `verify-check-update` 6/6、`verify-about` 15/15。

上一版本 v1.0.60（2026-11-03）：**新增「检查更新」**——帮助菜单 / 关于弹窗可手动查 GitHub Releases 最新版本，显示新版本与发布说明并可打开下载页；主进程 `net.fetch` + 版本比较，`openRelease` 只允许本项目 Release。

上一版本 v1.0.59（2026-11-03）：**修右侧堡垒机下拉不同步**——左侧保存/登录/删除 JMS 服务器后只刷新左侧下拉，右侧堡垒机下拉停留在旧列表（新建时 baseUrl 为空会被过滤）；现在保存/登录/MFA/删除后统一刷新右侧下拉，保存后同时重绘左侧列表。回归 `verify-bastion-server-sync` 4/4。

上一版本 v1.0.58（2026-11-03）：**修 H3C 自签名证书导致的偶发连接失败**——诊断包 `Polaris-bastion-diag-2026-11-03-03-38-58.json` 实测同一 `accessUrl` 前两次 `net::ERR_CERT_AUTHORITY_INVALID`、第三次才成功；`app.on('certificate-error')` 只覆盖 webContents，`session.fetch()` 不触发，故对 `persist:bastion` 安装 `setCertificateVerifyProc(cb(0))`。同时包含 v1.0.57 之后未发版的「堡垒机登录后分组默认折叠」。回归：`verify-h3c-cert` 1/1、`verify-h3c-native` 15/15、`verify-bastion-login-collapse` 6/6。

上一版本 v1.0.57（2026-11-01）：**修掉 5 个漂移用例 + 两个真 bug**——① `execOnSession` 改为「exit 只记退出码、close 才 resolve」：ssh2 的 exit 早于 data 到达，导致 stdout 为空 → 打包上传探测误判「不支持打包」而回退逐文件上传（真实产品 bug，已修）；② mock 远端解压改用系统 bsdtar（`execFileSync` + `%SystemRoot%\System32\tar.exe`），Git Bash 的 GNU tar 会把 `C:\` 当远程主机；③ mock 失败注入路径分隔符归一（Windows 反斜杠）；④ verify-kb 的 Windows 路径改用 `JSON.stringify` 注入（原先 `	` 被当转义）；⑤ verify-bastion-hierarchy 的 webview 钩子断言按新架构（主进程原生 `h3c:*` IPC）重写；⑥ verify-sftp-cancel 用 24MB + 120ms 取消并允许重试、verify-sftp-download-fail 断连自动重连一次。全量回归 `test-all.js`：**82/84 脚本全绿 / 579 条断言**（仅 `pack-real` 需真实主机密码）。

上一版本 v1.0.56（2026-11-01）：**精简主题 + 苹果字体 + 全量回归**——主题从 25 套精简到 10 套精选（旧配置自动回落 dark）；新增「界面字体」设置与苹果字体支持（默认字体栈改为 SF Pro / 苹方优先，终端字体补 `ui-monospace`/`SFMono-Regular`）；修「选自定义字体时输入框被 sync 回滚」；跑通全量回归 `test-all.js`（84 个 verify 脚本）。回归：新增 `verify-ui-font.js`（12 条）。

上一版本 v1.0.55（2026-11-01）：**新建/编辑会话弹窗精简**——默认只显示必要字段（名称 / 主机+端口 / 用户名+密码 / 分组 / 测试连接），协议、私钥、私钥口令、跳板机、终端编码、登录宏收进折叠的「高级选项」（编辑带高级设置的会话会自动展开）；弹窗从"要滚动才能看到保存"变成一屏放下。回归：`verify-session-modal.js`（13 条）。

v1.0.54（2026-11-01）：**「帮助 → 关于」只留版本 + 简介**——原「📖 使用说明」长文档（快速开始/快捷键表/九大功能说明）整块删除，改为「关于」弹窗：Logo「Polaris 北极星」、版本号（主进程 `app.getVersion()` 经 IPC `app:about` 下发）、一段 161 字简介；设置弹窗入口改「ℹ️ 关于」、命令面板/菜单/菜单栏统一指向同一弹窗。回归：`verify-about.js`（15 条）。

上一版本 v1.0.53（2026-11-01）：**界面布局 / 字体优化**——全 UI 字号改由 `--ui-font` 派生（`--fs-2xs…--fs-lg`），设置里的「界面字体大小」现在真正全局生效（以前只作用于工具栏/列表，其余写死 11/12px）；会话列表行距收紧、缩进步长 18→14px（深层不再把主机名挤成省略号，240px 面板下长名可读）、去掉行重复 margin 修掉 6px 横向滚动条；底部提示/面板标题改单行省略（不再折成两行）；SFTP 工具栏 `flex-wrap` + `flex-shrink:0`，大字号换行不裁字。回归：`verify-ui-layout.js`（21 条）。

上一版本 v1.0.52（2026-11-01）：**打开 App 默认全部折叠**——列表/树形两种视图进来都只显示分组头（顶级「主机/堡垒机」也收起），展开状态只在本次运行内保留（产品要求不跨重启记住）；去掉 `settings.collapsedGroupIds/collapsedTopHost/collapsedTopBastion` 的持久化。

上一版本 v1.0.51：**列表模式也能折叠了**——之前 `flat=true` 关掉了折叠三角、只能全展开一个长列表；两种视图共用同一套折叠状态（`state.collapsedGroups`），点三角即收/展，切视图不丢，搜索时仍自动展开命中路径。

上一版本 v1.0.50（2026-11-01 发版）：会话列表分组体验对齐成熟产品（Xshell / FinalShell）——父分组计数改 `(直属/合计)`（`华东 (0/3)` 不再误报空）、分组头悬停显示完整路径、**搜索时只保留命中路径并自动展开折叠分组**、折叠/展开状态持久化（`collapsedGroupIds` + 顶部分组）、**分组拖拽排序与拖成子分组**（新表字段 `groups.sort_order`，老库自动补列且顺序不变，数据层防环）、**侧边栏全键盘导航**（roving tabindex，↑↓←→ / Enter / Shift+F10）、深层缩进步长收窄（3 层后 18→10px）、「定位到会话列表」自动展开折叠分组并支持树形/列表模式闪烁。回归：`verify-groups-mature.js`（84 条）+ `verify-groups-order.js`（19 条）。

之前版本 v1.0.49（2026-10-30 发版）：修复导入加密备份时密码框被背后的导入弹窗抢按键（多弹窗叠加时取最上层弹窗）；导出加密备份密码框焦点加固（去掉导出前原生 confirm、主进程 `window:focus`、补聚焦重试 2s、弹窗期间暂停 webview 抢焦点），密码长度口径统一为 8 位；Windows 启动优化（NSIS 安装版 + portable 启动图 + V8 编译缓存 + ssh2/xlsx/tar 惰性加载 + 日志批量写盘 + locale 精简）；列表/树形视图统一按 `parent_id` 渲染分组层级（子分组嵌套，不再平铺）；分组名改为**同一父级下唯一**（旧库自动迁移，不同父级可同名）；拖拽移动会话不再丢私钥/跳板机等字段。历史问题清单见 `docs/issues-2026-09-11.md`，Windows 启动排查见 `docs/windows-startup-slow.md`。

已完成：堡垒机（JMS/H3C）对接、SFTP 面板全功能与断点续传、命令补全与智能推荐、主题系统（10 套 Tabby/iTerm2 精选配色，各带 ANSI 色板 + 对比度保底派生）、AI 技能/知识库、SSH 隧道、录制回放、全量日志、堡垒机入口整合。
详见 `CONTEXT.md` 的「已完成功能」「技术决策」。

**依赖注意**：`xlsx` 用 SheetJS 官方 CDN tarball（非 npm registry，见 `docs/deps-xlsx-evaluation.md`），`npm ci`/CI 需能访问 cdn.sheetjs.com。
