# CONTEXT.md — 当前开发会话上下文快照

> 本文件是 2026-08-15 开发会话（DSH session-d735fe6b）的可移植上下文快照，随项目克隆。任何 Agent（DSH / Claude Code / Cline / Codex / Cursor）在新环境读完本文件即可恢复对本项目的完整认知，无需原始会话。
> 原始会话 JSONL（57093 行，14MB，zstd 压缩）位于本机 `~/.dsh/sessions/--Users-major-DeepSeek-polaris-terminal--/session-d735fe6b-21be-467e-a4b4-6fd18970d3f5/session.jsonl.zstd`（仅本机可读，克隆环境不可用——本文件即其精华摘要）。
> **2026-08-23 刷新**：Claude Code 会话按 git log（2026-08-16 → 08-21，至 v1.0.8）补录「需求脉络②」「已完成功能」「技术决策」，原 08-15 内容保留为历史基线；待办/已知边界逐条核对过代码仍成立。

## 项目与目标

Polaris（北极星）— Electron SSH/SFTP 终端。开发主线：**参考 Chaterm 完善功能**，本会话聚焦：堡垒机（JumpServer + H3C）对接与体验打磨、SFTP 面板完善、稳定性修复、全量日志、**CI 发布流水线（GitHub Releases）**。当前版本 **v1.0.43**（2026-09-11；本轮修复清单见 `docs/issues-2026-09-11.md`）。

- 架构：单文件主进程 `main.js`（~2700 行）+ 渲染进程 `src/renderer.js`（~10000 行）+ `preload.js` contextBridge 安全桥（无 nodeIntegration）

## 用户需求脉络

### ① 2026-08-15 会话（DSH 104 条消息提炼，历史基线）

1. 拉取项目 → 开发环境跑通（沙箱 workaround：`--no-sandbox --disable-gpu` + `POLARIS_LOCK_DIR=.polaris-data`）
2. SFTP 打开范围修正：改为**按标签各自独立**（之前一开全开）；堡垒机多主机 SFTP 标签要能区分是哪台（`displayHost` 资产 IP 前置）
3. 提供 DeepSeek API Key 配置 AI；删除"展开资产列表"按钮及对应面板
4. **信任弹窗**每次连接都弹 → 加 `autoTrustHostKey` 自动信任
5. 堡垒机 SFTP 空目录 → 登录 JumpServer 实查：资产 PVE-堡垒机缺 sftp 协议 → API 启用
6. 上传成功但不知文件到哪 → 状态栏明确路径 + 列表高亮闪烁
7. 测试 H3C 堡垒机（10.204.240.4）→ 提供真实 HAR 分析 → 实现 accessclient:// 对接
8. **右键菜单 open/close 刷屏**（多轮）：空菜单数组 → 残留 click 防抖（250ms）→ webview 抢焦点（bastionFocusCheck 暂停）→ 焦点跟随用户（__hostAnyClickTs）
9. **堡垒机连接后频繁刷新** → pollBastionAssets 站点守卫（仅 H3C /shterm）→ 事件驱动 + 15s 兜底 → 数据无变化零刷新（stableJson + 提示去重）
10. SFTP 下载失败排查 → 底层全通 → **macOS TCC 权限**（桌面不可写 EPERM）→ 保存位置预检 + 明确指引
11. 全量日志系统：主/渲染层/dlog/异常落盘 `logs/app-*.log` + 调试面板「⬇ 下载日志」
12. **SFTP 默认家目录**：sftp:home 探测（exec pwd → SFTP readdir 验证 → 回退 /tmp）；上传用同一路径（显示=上传）
13. SFTP 路径显示：连接信息下方第二行完整路径；面包屑 `//root` → `/root` 修复
14. 启动过场简化为**单边框环**
15. **登录堡垒机配置**：JumpServer Linux 平台 sftp_home /tmp → /root（protocol-settings API）
16. H3C 同步：SFTP 菜单入口加回 + 共享功能（家目录/路径）验证
17. 编译安装正式版 `/Applications/Polaris.app`（npm run dist，未签名）
18. （当前）克隆到别处 + 保留会话上下文（多 agent）→ 本文件
19. **堡垒机入口整合**：把会话列表头部「🛡 堡垒机」按钮与「会话列表下 🛡 堡垒机分组」合并成一个入口——删除头部按钮，其 3 项（JumpServer API 对接 / JumpServer Web / H3C 浏览器登录）并入堡垒机分组右键菜单。右侧堡垒机浏览器面板保持原样

### ② 2026-08-16 → 08-21 后续开发（git log 提炼，v1.0.0 → v1.0.8）

1. **CI 发布流水线**：GitHub Actions 编译 Windows 便携版（.exe）+ macOS 版（.app 打包 zip）；push main 只传 artifact，打标签 `v*` 自动发布 Releases，手动触发发草稿；显式声明 `contents:write` 权限（修复发布被拒）
2. **gitee（码云）镜像发布**：GitHub 发布后自动把产物同步到 gitee（`scripts/sync-to-gitee.js`），gitee 不构建只接收产物；海外 runner 大块上传易断 → 10MB 分块 + 失败重试 3 次 + 60s 超时，提示按文件分条
3. **堡垒机收藏分组**：左侧收藏按收藏分组展示（默认收藏/各分组子区块）；收藏分组自动获取 + 业务目录/收藏分组上下级缩进
4. **堡垒机分组计数与网页一致**：设备可出现在多个业务目录，计数去重（871 不虚增到 2066）；旧版单目录数据启动自动重新分组；重捕获期间分组不消失（mergeBastionCapture 并集）；逐目录补充把扁平捕获缺失的设备补进资产集
5. 堡垒机收藏分组脏 `favGroup` 清洗；webview 焦点不再抢占终端
6. **SFTP 上传/下载远端大小对账**：中继截断不再误报成功；上传校验三态区分（0 字节不再被静默放过）；**读回核对**（设备 stat 骗人——报 0 但数据在——不再误报失败/误删文件）
7. **自动重连死循环修复** + 输入法死键守卫 + 上传失败后终端恢复
8. **主题系统升级**：auto 跟随系统 + 12 新预设 + deriveUiTokens 派生 UI 变量
9. 界面字体大小独立设置（与终端字号分开）；折叠左面板+无终端时 AI 面板不再跑到最左
10. 工具栏输出过滤框 → 弹窗创建多个条件 + 复选框多选启用 + 百分比高亮 + 设置开关
11. 终端编码修复 + 自定义关键字高亮
12. 锁屏边框合并；默认收起主机/堡垒机分组；锁定后窗口缩小；已保存堡垒机连接区块默认折叠
13. 堡垒机连接管理体验：编辑入口、批量连接、浏览器入口按钮（部分后来被简化/移除）
14. 虚拟机资产导出 csv 加入 .gitignore（含内网 IP/人员信息，防误提交）；macOS 只编译 x64（arm64 不再编译）；升级 electron 43.4.0 / electron-builder 26.15.3

## 已完成功能（代码已提交）

### 堡垒机（JumpServer + H3C）
- JumpServer API（登录/资产/复合用户名 KoKo 网关）+ H3C Web（accessclient:// token 解码、自动登录、资产捕获）
- 堡垒机入口整合：头部🛡按钮删除，3 项菜单并入会话列表🛡分组右键菜单；堡垒机连接 CRUD（type=jms|h3c）、编辑入口、双击资产直连 SSH（`bastionConnectAsset`，未登录自动用保存账号登录）；右侧浏览器面板保留
- 堡垒机收藏分组（按收藏分组展示 + 自动获取 + 上下级缩进）；分组计数与网页一致（多业务目录去重）；收藏分组脏 favGroup 清洗
- 左侧列表显示未登录的 JMS 服务器；默认折叠分组；webview 焦点不抢占终端

### SFTP
- 面板（浏览/上传下载断点续传/编辑/重命名/删除/多选）、按标签独立状态、连接名下拉、真实目标主机区分、路径面包屑、文件右键菜单、默认家目录探测
- 上传/下载远端大小对账（三态校验 + 读回核对），中继截断不再误报成功、0 字节不再被静默放过、设备 stat 骗人不再误删文件
- **断点续传磁盘化**（lib/sftp-partials.js）：中断点落盘，app 重启/崩溃后跨会话续传，不再退化为全量重传；大批量压测通过（verify-sftp-stress.js / verify-sftp-partials.js）

### 稳定性 / 体验
- 右键菜单防刷屏（3 层）、BODY 焦点兜底、堡垒机轮询优化、上传后刷新（path 崩溃修复）
- 自动重连死循环修复、输入法死键守卫、上传失败后终端恢复
- 锁屏边框合并、折叠面板/无终端时 AI 面板位置修复、锁定后窗口缩小

### 界面 / 主题
- 主题系统：auto 跟随系统 + 12 新预设 + deriveUiTokens 派生；界面字体大小独立设置
- 输出过滤框（多条件弹窗 + 百分比高亮 + 设置开关）；终端编码修复 + 自定义关键字高亮

### 日志 / 发布
- 全量日志系统（lib/app-log.js + 调试面板下载）
- CI 发布流水线（GitHub Releases + gitee 码云镜像同步）

### 其他
- AI 功能（前会话）：Agent 技能、命令推荐、知识库
- 生产环境危险命令确认、known_hosts 指纹校验、GBK 编码、隧道、录制回放

## 关键技术决策（重要，勿轻易改）

1. **SFTP 默认路径探测**（main.js `sftp:home`）：`exec('pwd')` 拿 shell 视角真实家目录 → SFTP `readdir` 验证可访问 → 家目录不可访问（堡垒机 chroot）回退 `/tmp`。**不要**只依赖 SFTP `realpath('.')`（chroot 下返回 `/` 误导）
2. **SFTP 路径显示=上传路径一致**：`state.sftp.path` 唯一来源；`loadSftpList` 只在请求相对路径（`.`）时用 realpath 覆盖，绝对路径（家目录探测结果）保留
3. **面包屑渲染**：首段按钮自带根 `/`，段间分隔符 `/` 仅多级路径出现（`/root` 不能显示成 `//root`）
4. **堡垒机轮询**：`pollBastionAssets` 只在 URL 含 `/shterm` 或裸根时运行（JMS 站点跳过）；15s 低频 + 用户操作事件驱动；`stableJson`（键排序）比较防误判；拉取提示只弹一次
5. **webview 焦点**：`bastionFocusCheck` 只在用户 3s 内操作过 guest 且宿主无更近点击时 `wv.focus()`；菜单打开时暂停——否则 webview 抢焦点触发 window blur，菜单闪关、点 ✕ 无效"无法退回"
6. **右键菜单防抖**：打开后 250ms 内 click 一律忽略（含菜单项），防 macOS 右键残留 click 误触
7. **JumpServer SFTP chroot**：由平台协议 `setting.sftp_home` 控制（`PATCH /api/v1/assets/protocol-settings/{id}/`，内置平台不可整体 PUT，403 Internal platform）；Linux 平台已改 /root
8. **堡垒机入口整合**：头部「🛡 堡垒机」按钮与「会话列表 🛡 堡垒机分组」是重复入口，合并为一——删头部按钮，其 JumpServer API / Web / H3C 三项并入分组右键菜单；右侧浏览器面板保留。**H3C 资产枚举/连接已改主进程原生**（`lib/h3c-api.js` + `h3c:*` IPC，`ses.fetch` 带 `persist:bastion` cookie；webview 只做登录会话载体，登录成功自动最小化，会话过期自动弹出重登）—— 不再注入 webview 钩子捕获 `/shterm/api/*`
9. **会话上下文**：`.polaris-data/`、`*.har`、probe 脚本、含真实凭据的 verify 脚本、虚拟机资产导出 csv 不入库（.gitignore）
10. **SFTP 上传校验**（lib/ssh-client.js `uploadFile`）：传完 `statSize` 对账远端大小（三态：`null`=一致 / `{unverifiable}`=设备不支持 stat 无法对账按成功 / 数值=真实不符——**0 字节是真实不符而非成功**）；不符全量重传一次；再不符**读回远端逐字节对比本地**（`verifyByReadback`）——区分"设备 stat 骗人（如 H3C 网络设备恒报 0 但数据已落盘）"和"真没传上"，前者视为成功，后者删远端残缺 + 明确报错。**绝不静默丢数据**
11. **自动重连防死循环**（renderer.js）：connected 后**延迟 15s** 才清零重连计数——"握手成功→立刻被服务端关闭"（瞬连瞬断）计数不归零，MAX_RECONNECT 正常触发；否则每轮 connected 都清零，每 3 秒连一次永不停
12. **输入法死键守卫**（renderer.js）：中文输入组合中 textarea 失焦会让 xterm 一直 `_isComposing=true` → 先清残留 preedit 再补派发 `compositionend` 强制复位；回车"提交"判定 `!e.isComposing && e.keyCode !== 229`
13. **堡垒机分组计数**：设备可在多个业务目录同时显示（与网页一致），计数按设备去重（871 不虚增到 2066）；根级设备归到业务根
14. **CI 发布**（`.github/workflows/build-windows.yml`）：push main 只传 artifact；标签 `v*` 自动发布、手动触发发草稿；macOS 只编译 x64（`--mac --x64`，arm64 不编译）；两平台 build job 完成后由单独 release job 汇总发布（避免并发建 Release 冲突）
15. **gitee 同步**（`scripts/sync-to-gitee.js`）：只依赖 Node 18+ 内置 fetch/FormData，无第三方依赖，CI 和本机都能跑；**10MB 分块** + 每附件 60s 超时 + 失败重试 3 次（2/4s 背退），对抗海外 runner → 国内网络；多个分片文件**逐条**拼接提示，不混进一条 cat 命令拼坏
16. **主题系统**（renderer.js）：预设只写 term 配色 + `appearance`，UI 变量走 `deriveUiTokens` 派生（dark 面板/边框比 bg 提亮，light 则加深），预设可 `css` 覆盖；`auto` 跟随系统
17. **断点续传磁盘化**（lib/sftp-partials.js + main.js）：中断点存 `lockDir()/sftp-partials.json`（仿 known-hosts：原子写 + 0600 + 损坏兜底），每次 set/remove **同步落盘**（崩溃/强杀后记录仍在，这是磁盘化的核心价值）；键用**稳定主机身份** `hostId:kind:path`（`hostId` 在 ssh:connect 时补存 = `username@host:port`，JMS 复合用户名区分同网关不同资产；sessionId 每次启动从 sess-1 重计、不能单独做键，否则 A 主机断点会续到 B 主机）；启动时 `prune` 掉 7 天前过期条目防磁盘表无限增长；「判定失效删记录返回 0（全量）」与「续传成功后删记录」语义不变
18. **main.js 拆模块**（v1.0.38，3263→2712 行）：抽 `lib/connect-opts.js`（makeHostVerifier/resolvePrivateKey/withHostVerify 指纹校验链，被 ssh:connect/批量/AI/导入共用）、`lib/session-groups.js`（分组/命令历史归档/快速命令/导入模板 IPC）、`lib/session-ipc.js`（会话管理/导入导出/系统探测，含 packJump/unpackJump）。**依赖惰性注入**：`register(ipcMain, { getSessionStore, schedulePersist, getMainWindow })`——sessionStore/mainWindow 启动早期不可用，传 getter 不取快照。SFTP/SSH/堡垒机等被数据管线重度消费的命脉区块**未拆**（拆分需同步改消费方，收益/风险不成比例）
19. **命令补全**（v1.0.38，renderer.js）：输入命令前缀 ≥2 字符弹候选（内置常用命令数组 + `recommendCmds(host)` 该主机历史高频带 desc + 快捷命令首词），**Tab 补全选中 / ↑↓ 切换 / 点击补全，不自动执行**；转义/回车/Ctrl+C/U/点击面板外自动关闭；**dirty 保护**（行被服务器改写时不补全，避免误删输入）；只补全命令词（第一个词），不做路径/参数（远程文件系统不可知）
20. **SFTP 进度节流**（v1.0.35/38，lib/sftp-progress-throttle.js）：每 job 每 100ms 发一条，完成 flush 补终态；**文件切换（`p.file` 变化）立即发送**——多文件/递归上传保证面板每文件一行（verify-pack-upload 回归点）
21. **macOS 双击启动限制**（v1.0.38，main.js `LAUNCHED_VIA_LAUNCHSERVICES`）：未公证 app 经 LaunchServices 启动被系统限制局域网访问（内网 EHOSTUNREACH）；命令行/启动器直接跑二进制正常。检测 `process.env.XPC_SERVICE_NAME` 以 `application.` 开头 → 连接 EHOSTUNREACH 时错误消息追加提示用启动器。**日常用桌面「启动Polaris.command」**
22. **H3C 网页收藏持久化**（v1.0.38，main.js）：退出与 `bastion:clearAll` 都改为 `clearStorageData({storages:['cookies','cachestorage','serviceworkers']})` + clearCache——**保留 localStorage**（H3C 网页收藏分组存这），只清登录态 cookie；全清会把收藏一起丢（用户重登后收藏消失）
23. **堡垒机连接编辑入口**（v1.0.39/40，renderer.js）：新建连接后 `collapsedBastionSaved=false` 展开子区（连接项可见）；首次有已保存连接时 `bastionSavedAutoExpanded` 自动展开一次；H3C 资产区块头菜单首位加「✏️ 编辑连接」（当前站点按 `bastionOrigin` 匹配已保存连接）
24. **xterm 组合态复位唯一入口**（v1.0.41，renderer.js `resetTermComposition`）：xterm 5.x 的 `CompositionHelper._finalizeComposition` 会把**隐藏 textarea 的内容**当作用户刚输入的文字 `triggerDataEvent` 发给 SSH（异步分支 `substring(start)`、同步分支 `substring(start,end)`），而 textarea 平时就残留按键字符（实测敲一次空格后 `textarea.value === " "`），组合位置又可能是上次输入法组合的旧值 → **"复位组合态"这个动作本身会把残留字符插进命令行**（用户实测 `df -Th` → `df -Th T`）。两道保险：① 只在 xterm 真卡组合态（`_compositionHelper.isComposing || _isSendingComposition`，取不到退回 DOM `.composition-view.active`）时才派发 `compositionend`；② **派发前先清空 textarea**，冲刷内容恒为空。三处调用点（空格兜底 / 失焦·聚焦复位 / 死键 229）统一走它
25. **SFTP 上一级与慢读取反馈**（v1.0.41，renderer.js `sftpGoUp`/`sftpParent`/`loadSftpList` + main.js `sftp:list`）：① 已在根目录（H3C 会话常见 path=`/`）时旧版仍重读同目录 → 改为直接提示、不发请求；② `sftpParent` 认 `flash:/`、`cfcard:/` 设备文件系统根（旧版会切出 `flash:` 这种不存在路径）；③ 发起读取立刻状态栏「正在读取 …」、结束换「已读取 …（N 项）」/失败报原因——设备慢也不再"点了没反应"；④ readdir 40s 超时时，**无传输任务（`hasActiveTransfer`）在跑才 `resetSftp`**：挂死请求会堵住设备串行 SFTP 通道，不重置则后续每次点击都再等 40s；有传输在跑不动它（重置会掐断在传文件）

26. **传输取消/超时语义**（v1.0.43，lib/ssh-client.js）：取消或 120s 假死超时一律 **reject `code:'CANCELLED'`** 并**保留本地/远端半成品**（下载侧用 `settled=true` 阻止 `settle()` 按大小不符 unlink）；调用方记续传点、UI 明示"已取消(可续传)"。旧版取消只 destroy 流、不结算 → `ws 'close'` 把 promise resolve 成"成功" → 走校验分支删半成品且记不下续传点。**真失败仍按原逻辑删残缺 + 报错**
27. **后台开标签模式**（v1.0.43，renderer.js `connectToServer(session, { background: true })`）：批量入口（会话列表批量/菜单连接选中/JMS 批量/H3C 批量/已保存连接批量）传 `background` → 不切激活标签、不抢键盘焦点；无激活标签时仍走前台。**注意**：后台标签的 pane 不在 DOM 里 → 先按 80x24 建 PTY，点开时 `activateTab → fit + scheduleRefit` 自愈。另修：`renderLayout()` 重建容器 DOM 会让焦点掉到 body（旧版被 `activateTab` 内 `term.focus()` 掩盖），现由 `activateTab` 与后台模式分别补回（用户正在输入框打字时不抢）
28. **敏感输入不落盘**（v1.0.43，main.js `isSecretInput`）：`ssh:write` 支持 `opts.noLog`；并兜底"待写入文本包含该会话密码(长度≥3)"→ 一律跳过 `recorder.writeInput` 与会话日志。自动填充密码（renderer 传 `noLog`）是主要来源；**登录宏仍照常记录**（审计需要，含密码时由兜底命中）。Telnet 密码不走本条链路
29. **xlsx 依赖**（v1.0.43）：`package.json` 指向 SheetJS 官方 tarball `xlsx-0.20.3`（非 npm registry —— npm 线止于 0.18.5 且有 2 个 high 无法修复）。`npm ci`/CI 需能访问 cdn.sheetjs.com；`npm audit` 不再跟踪它。评估与 PoC 见 `docs/deps-xlsx-evaluation.md`

## 运行与调试

```bash
# dev（自动 mock）
POLARIS_LOCK_DIR="$PWD/.polaris-data" ./node_modules/.bin/electron . --dev --no-sandbox --disable-gpu
# 正式版编译（本机）
npm run dist   # release/mac/Polaris.app（未签名）
# CI 产物：仅 Windows 便携版 Polaris.<v>.exe（GitHub Releases 附件）；macOS 由本机 `npm run dist` 产出 release/mac/Polaris.app（未签名，CI 不编 macOS）
# e2e 验证（会 pkill electron，测完重启）
node verify-<功能>.js
```

- **发布流程**：`git tag vX.Y.Z` → `git push origin <tag>` → GitHub Actions 编译 Windows → 自动创建 Release 并附 `.exe`
  **只推 main 不会出 Release**（workflow 的 release job 条件是 `refs/tags/v*`）；CI 不编 macOS、也不再向 gitee 同步产物（gitee 只留源码仓库）
- 真实环境：JumpServer `192.168.1.250`（admin / 密码见本地 `~/.jms-terminal/jms-servers.json` 或用户提供），PVE 资产 `192.168.1.254`（root，经 KoKo 网关 2222）；H3C 参考 `10.204.240.4`（HAR 已入 .gitignore）
- 日志：`数据目录/logs/app-*.log`（全量）；调试面板 🧾 → ⬇ 下载日志
- verify 脚本：`verify-bastion-merge.js`（堡垒机入口整合回归）、`verify-sftp-*.js`、`verify-bastion-*.js`、`verify-h3c*.js`、`verify-ctxmenu*.js` 等 40+ 个（CDP e2e，自建 electron + 调试端口 + 临时数据目录）

## 待办 / 已知边界

- **正式版未签名**（Gatekeeper 需右键打开或系统设置放行）：package.json build 无 sign/identity/notarize 配置，CI 产物同样未签名；**macOS 仅 x64**，arm64 机型需本机 `npm run dist` 自行编译（用户已决定暂不做签名相关）
- **H3C 资产 SFTP 根目录取决于 H3C 网关配置**（非 JumpServer sftp_home），家目录探测会自动回退（服务端配置，app 无法改）
- **堡垒机面板为 Electron `<webview>` 嵌入**（guest view），受宿主层叠顺序限制，已在分隔条拖动与锁屏时显式隐藏（Electron 固有限制）

**已解决（2026-08-23）**：SFTP 断点续传磁盘化（跨重启续传，lib/sftp-partials.js + hostId 键）；SFTP 大批量压测（verify-sftp-stress.js + verify-sftp-partials.js）；工作目录调试产物清理（long_text_*.txt / polaris-logs-*.zip 已删并 gitignore）

**已解决（2026-08-25，历史会话复盘）**：**历史最高频问题——左侧堡垒机（尤其 H3C）获取不到资产列表 /「未捕获到资产」**，跨 4 个会话出现 15+ 次。它是一串根因而非单个 bug，已在 v1.0.2→v1.0.12 逐个铲除，关键节点：v1.0.2 `4ac370d`（API 写死 getAccessViewTree → 改读浏览器真实请求体 paths）、v1.0.3 `c7a28de`（钩子注入死锁）、v1.0.8/9 `8b331c2` + `5c63ff2`（**根因**：注入脚本正则被宿主模板解码破坏 → 钩子永远进不去）、v1.0.12 `f5b5401`（H3C 会话保活放宽到面板隐藏也运行）、08-25 未打 tag（JMS/H3C 共性问题：折叠层级把资产藏起来 → 登录后默认展开）。**判断依据**：v1.0.13 起用户抱怨转移到显示层（分组重复 `df6f473`、收藏分组 `66d4184`/`2a8fffc`/`471aab2`，均已修），资产捕获链路本身是通的（确认 870/879 台设备 dirs 含根），当前 v1.0.18「获取不到资产列表」本体不再出现。**遗留**：SFTP 偶发目录读取超时/大文件传输失败——根因是 v1.0.11 加的 stat 探测挂住 H3C 串行 SFTP 通道，v1.0.17 `5dbb8ef` 移除修复，v1.0.18 `0076967` 加 [SFTP] 调试日志，等真实设备复现后按日志收尾
- **UI 布局优化**（`docs/layout-redundancy.md`，2026-08-23 分析，待执行）：A 类冗余——SFTP 传输历史双份记录、堡垒机面板三重选控件、堡垒机入口重复；B 类健壮性——右侧固定宽面板可同时全开把终端挤没（`min-width:0`）、面板尺寸记忆不一致
- **主题/字体优化**（`docs/theme-font-optimization.md`，2026-08-23 分析，待执行）：ANSI 16 色全局一份换主题不变（Termius 每主题自带调色板，核心差距）、前 8 套预设硬编码 css 与派生值漂移、字体列表缺 Nerd Font/自定义入口

**已解决（2026-09-01，v1.0.35→v1.0.40）**：
- **SFTP 大文件上传加固**（v1.0.35）：进度节流（lib/sftp-progress-throttle.js，高频进度不再打满渲染层）、120s 传输假死看门狗（连接假死主动终止）、stat 30s 超时（H3C 串行通道挂住不阻塞）；断开/关标签清空传输记录、彻底移除启动自动连接（v1.0.35）
- **性能**（v1.0.37）：主终端 xterm WebGL 渲染（GPU 不可用自动回退 canvas）、scrollback 5000→3000、启动延迟加载堡垒机资产（300ms 后异步）
- **main.js 拆模块 + 命令补全 + macOS 启动提示 + H3C 收藏持久化 + 节流文件切换修复**（v1.0.38，见关键技术决策 18-23）
- **堡垒机连接编辑入口**（v1.0.39/40）：新建连接自动展开子区 + H3C 资产区块头「编辑连接」——用户"左侧连接没编辑功能"根因是已保存连接子区默认折叠 + 资产区块头无编辑入口，非功能缺失
- 完整回归：14 项 verify 脚本全过（含 verify-pack-upload 抓到节流文件切换回归并修复）

**遗留**：macOS 双击启动网络限制**根治需公证**（无 Apple 证书，短期保留启动器方案）；「UI 布局优化」「主题/字体优化」两份 docs 清单仍待执行；H3C 网页收藏若要彻底 SQLite 化（跨设备/清 localStorage 也不丢）需读取 H3C 网页 localStorage 结构设计捕获，当前靠"保留 localStorage"兜底。

**已解决（2026-09-10，v1.0.41）**：
- **输入法残留被当输入发到服务器**（renderer.js）：用户报「敲 `df -Th` 回车，服务端收到 `df -Th T` 报 `df: T: 没有那个文件或目录`」。日志取证：空格键每次出现两条 SEND（一条多余的空串/`" T"`，一条正常空格），多出的内容来自 xterm 组合冲刷（见技术决策 24）。修法：统一入口 `resetTermComposition`（只在真卡组合态复位 + 复位前清空 textarea）。复现/回归 `verify-space-composition-flush.js`（改前逐字复现 `SEND " T"`，改后 4/4 通过）；`verify-vim-space.js`（原"vim 退出后空格失效"修复）无回退
- **SFTP「⬆ 上一级」点了没反应**（renderer.js + main.js）：根目录空转 + readdir 超时后通道不重置（后者是"越点越坏"的放大器，用户 [SFTP] 日志里 8 次 `readdir path:"/"` 40s 超时即此）。修法见技术决策 25。回归 `verify-sftp-up.js`（6/6）、`verify-sftp-panel.js`（5/5）
- **备用屏切换乱抢焦点**（v1.0.42，renderer.js `onBufferChange`）：补焦点加两道前提——只对**当前标签**补（后台标签不抢）、焦点停在别的输入框（`INPUT/TEXTAREA/contentEditable`）时不补。原来远端任何全屏程序切备用屏都会把用户正在别处输入（搜索框/路径框/堡垒机地址框）的焦点拽回终端。回归 `verify-bufferfocus.js`（4/4）、`verify-vim-real.js`（5/5，真实 vim 退出后仍能输入）
- **H3C/批量连接抢焦点（2026-09-11 未发版已修）**：`connectToServer(session, opts)` 加 `background` 后台模式（不切激活标签、不抢焦点），5 个批量入口全部传入；连带修掉 `renderLayout()` 重建 DOM 后焦点掉到 body（旧版被 `activateTab` 内的 `term.focus()` 掩盖）。回归 `verify-batch-focus.js`

**已解决（2026-09-11，v1.0.43）**：本清单 `docs/issues-2026-09-11.md` 的 #1～#12、#14、#15 与"三条新发现"全部完成（#13 需用户决定是否改写 git 历史）。要点：敏感输入不落盘、取消传输保留半成品+可续传、批量传输并入加固管线、危险命令确认覆盖 6 类一键入口(含 batch:exec)、批量连接不抢焦点(后台模式)、多堡垒机资产按 bastionUrl 分键、关闭命令记录后补全失效等交互四修、终端行残留两处防护、xlsx 换官方 tarball 且 `npm audit` 清零、verify 脚本端口全库去重 + `freePort` 校验真空闲、过时 verify 脚本清理（删 2 重写 1）。回归：19 个 verify 脚本全绿 + `npm run dist` 打包通过并已装入本机 /Applications。
