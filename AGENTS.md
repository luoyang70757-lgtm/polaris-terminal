# AGENTS.md — 项目上下文（所有 AI Agent 通用）

> 本文件供任何 AI 编程 Agent（Claude Code / Cline / Codex / Cursor / DSH 等）在开始工作前读取，快速了解项目。配合 `CONTEXT.md`（当前开发会话快照）使用。

## 项目概览

**Polaris（北极星）** — 科幻风 SSH/SFTP 终端工具（Electron 桌面应用）。

- 技术栈：Electron 43 + xterm.js 5.3 + ssh2 + SQLite（node:sqlite 内置）
- 数据安全：会话数据存本地 SQLite（整库 AES-256-GCM 加密），密码走系统 safeStorage 加密（`enc:v1:` 前缀）
- 架构：主进程 `main.js`（~2700 行）+ 渲染进程 `src/renderer.js`（~11000 行）+ contextBridge 安全桥（`preload.js`，无 nodeIntegration）；
  主进程已拆模块（依赖惰性注入，命脉区块 SFTP/SSH/堡垒机仍在 main.js）：`lib/connect-opts.js`、`lib/session-groups.js`、`lib/session-ipc.js`

## 核心文件

| 文件 | 职责 |
|---|---|
| `main.js` | 主进程：窗口、SSH 连接（ssh2）、SFTP、IPC、JumpServer API、加密、录制、日志 |
| `src/renderer.js` | 渲染进程：全部 UI 逻辑、xterm 终端、会话列表、SFTP 面板、堡垒机交互 |
| `src/index.html` / `src/styles.css` | UI 结构与样式 |
| `preload.js` | contextBridge 安全桥（渲染层通过 `window.api.*` 调主进程能力） |
| `lib/` | 模块：ssh-client、session-store、app-lock、db-crypto、known-hosts、jms-api、skills、recommend、kb、app-log、recorder、session-log 等 |
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
# Windows(同时产出两种包):
#   release/Polaris Setup <v>.exe     NSIS 安装版(启动快，推荐)
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

10. **界面字号 / 字体 / 布局约定**：所有 UI 字号都由 `--ui-font`（设置里的「界面字体大小」）派生，档位变量 `--fs-2xs/--fs-xs/--fs-sm/--fs-md/--fs-base/--fs-lg` = ui-font −4/−3/−2/−1/+0/+1（默认 13px 时与旧像素值完全一致）。**新增样式不要写死 `font-size: 11px` 之类**，用 `var(--fs-sm)`；终端字号走 `settings.fontSize`，与 UI 无关；**界面字体族**走 `settings.uiFontFamily`（`''`=内置自动栈：`-apple-system`/SF Pro/苹方 → Windows 雅黑 → Linux Noto，苹果设备优先命中 SF/苹方），设置项 `#set-ui-font-family` 支持 自动 / SF Pro / 苹方 / 雅黑 / Noto / 自定义，applyTheme 注入 `--ui-font-family`。主题只保留 **10 套精选**（dark/light/termiusDark/termiusLight/solarizedDark/nord/dracula/catppuccinMocha/gruvboxDark/rosePine），已删主题的旧配置自动回落 dark。布局红线：会话列表行缩进只用 `padding-left`（行上不要再加 `margin-left`，否则 `width:max-content` 会顶出 6px 横向滚动条）；`.asset-tree` 固定 `overflow-x: hidden`；固定高度面板（如 `#sftp-panel`）里的工具栏必须 `flex-shrink: 0` 且允许 `flex-wrap`，否则大字号换行后按钮会被裁一半。回归：`verify-ui-layout.js`（21 条：默认档位、17px 缩放、横向溢出、标题/提示单行、SFTP 工具栏不裁切）。

## 安全约定

- 危险命令（rm -rf、dd、mkfs 等）在生产环境标记的主机执行前弹确认框
- 主机指纹校验（known_hosts）；`autoTrustHostKey` 设置可跳过首次信任弹窗
- **不要提交**：`.polaris-data/`、`*.har`、含真实凭据的脚本（verify-realdl/ui-dl/tcc 等）

## 常用调试

- 工具栏「🧾 调试」：终端调试日志（按键/焦点/收发数据），「⬇ 下载日志」导出完整 app 日志
- e2e 验证：`node verify-<功能>.js`（自动 spawn electron + 调试端口 + 临时数据目录，用后 pkill）
- 测试会杀掉正在运行的 app（pkill electron），测完需重启

## 当前状态（截至 2026-11-03）

> **2026-11-03 版本号重置**：GitHub 历史 Releases 与 `v*` 标签已按用户要求清理，版本号从 **v1.0.0** 重新开始；下方 v1.0.x 条目仅作为开发历史保留。

**当前版本 v1.0.4**（2026-11-03）：**修堡垒机配置弹窗显示**——「添加堡垒机站点」补右上角 ✕；打开弹窗时临时隐藏 `bastion-webview`，避免 Electron guest view 盖住宿主弹窗/按钮。回归 `verify-bastion-browser-ui` 9/9。

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

已完成：堡垒机（JMS/H3C）对接、SFTP 面板全功能与断点续传、命令补全与智能推荐、主题系统（10 套精选，各带 ANSI 色板）、AI 技能/知识库、SSH 隧道、录制回放、全量日志、堡垒机入口整合。
详见 `CONTEXT.md` 的「已完成功能」「技术决策」。

**依赖注意**：`xlsx` 用 SheetJS 官方 CDN tarball（非 npm registry，见 `docs/deps-xlsx-evaluation.md`），`npm ci`/CI 需能访问 cdn.sheetjs.com。
