# CONTEXT.md — 当前开发会话上下文快照

> 本文件是 2026-08-15 开发会话（DSH session-d735fe6b）的可移植上下文快照，随项目克隆。任何 Agent（DSH / Claude Code / Cline / Codex / Cursor）在新环境读完本文件即可恢复对本项目的完整认知，无需原始会话。
> 原始会话 JSONL（57093 行，14MB，zstd 压缩）位于本机 `~/.dsh/sessions/--Users-major-DeepSeek-polaris-terminal--/session-d735fe6b-21be-467e-a4b4-6fd18970d3f5/session.jsonl.zstd`（仅本机可读，克隆环境不可用——本文件即其精华摘要）。
> **2026-08-23 刷新**：Claude Code 会话按 git log（2026-08-16 → 08-21，至 v1.0.8）补录「需求脉络②」「已完成功能」「技术决策」，原 08-15 内容保留为历史基线；待办/已知边界逐条核对过代码仍成立。

## 项目与目标

Polaris（北极星）— Electron SSH/SFTP 终端。开发主线：**参考 Chaterm 完善功能**，本会话聚焦：堡垒机（JumpServer + H3C）对接与体验打磨、SFTP 面板完善、稳定性修复、全量日志、**CI 发布流水线（GitHub Releases + gitee 码云镜像）**。当前版本 **v1.0.8**。

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

## 运行与调试

```bash
# dev（自动 mock）
POLARIS_LOCK_DIR="$PWD/.polaris-data" ./node_modules/.bin/electron . --dev --no-sandbox --disable-gpu
# 正式版编译（本机）
npm run dist   # release/mac/Polaris.app（未签名）
# CI 产物命名：Windows 便携版 Polaris-<v>.exe；macOS Polaris-<v>-mac-x64.zip（仅 x64）
# e2e 验证（会 pkill electron，测完重启）
node verify-<功能>.js
```

- **发布流程**：`git tag vX.Y.Z` → push → GitHub Actions 自动编译两平台 → 发 Releases → 自动同步 gitee（需 secrets.GITEE_TOKEN）
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
