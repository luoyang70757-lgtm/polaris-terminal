# CLAUDE.md — Polaris（北极星）SSH/SFTP 终端

Claude Code 项目上下文。本文件 + 下方 `@import` 的内容会在每次会话自动加载，让新环境（克隆后）的 Claude Code 立即获得完整项目认知与开发历史。

@import AGENTS.md
@import CONTEXT.md

## 本文件要点（快速须知）

- **项目**：Electron 43 + xterm.js + ssh2 + SQLite 的 SSH/SFTP 终端（参考 Chaterm 功能开发）
- **架构**：主进程 `main.js`（~2700 行）+ 渲染进程 `src/renderer.js`（~9300 行）+ `preload.js` contextBridge 安全桥（无 nodeIntegration）
- **主进程已拆独立模块**（依赖惰性注入，命脉区块 SFTP/SSH/堡垒机仍在 main.js）：`lib/connect-opts.js`（指纹校验链 makeHostVerifier/resolvePrivateKey/withHostVerify）、`lib/session-groups.js`（分组/命令历史归档/快速命令/导入模板 IPC）、`lib/session-ipc.js`（会话管理/导入导出/系统探测 IPC）
- **运行 dev**：`POLARIS_LOCK_DIR="$PWD/.polaris-data" ./node_modules/.bin/electron . --dev --no-sandbox --disable-gpu`（自动拉起 mock 服务器）
- **编译正式版**：`npm run dist` → `release/mac/Polaris.app`（未签名）。⚠️ **macOS 双击启动会被系统限制局域网访问（未公证 → 内网 EHOSTUNREACH）**，日常请用桌面「启动Polaris.command」或命令行直接跑二进制
- **依赖注意**：`xlsx` 用 **SheetJS 官方 CDN tarball**（`https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`，非 npm registry）——`npm ci`/CI 需能访问 cdn.sheetjs.com；npm 上的 `xlsx` 止于 0.18.5 且有 2 个 high 无法修复，勿改回 registry 版本。评估见 `docs/deps-xlsx-evaluation.md`
- **数据目录**：`POLARIS_LOCK_DIR` 指定（默认 `~/.jms-terminal`）；开发用 `.polaris-data/`（**已 gitignore，勿提交**）

## 安全红线（必须遵守）

1. **绝不提交**：`.polaris-data/`（含真实凭据）、`*.har`（抓包）、`probe-*.js`、含明文密码的 verify 脚本（verify-realdl/ui-dl/tcc）
2. 真实堡垒机凭据（JumpServer admin 密码、PVE root 密码）**只在本机本地配置**，写入代码/文档前必须脱敏（用占位符或指向 `~/.jms-terminal/jms-servers.json`）
3. 危险命令（rm -rf、dd、mkfs 等）在生产标记主机执行前，app 会弹确认框——改这块逻辑要谨慎
4. 测试脚本会 `pkill electron`（杀掉正在运行的 app），跑完 e2e 记得重启

## 调试与验证

- 工具栏「🧾 调试」→ 终端调试日志 + 「⬇ 下载日志」导出完整 app 日志（`数据目录/logs/app-*.log`）
- e2e：`node verify-<功能>.js`（自建 electron + CDP 端口 + 临时数据目录，跑完自动清理）
- 堡垒机资产轮询只在 H3C 站点（URL 含 `/shterm`）运行；SFTP 默认家目录探测走 `sftp:home` IPC

## 当前开发状态

见 `CONTEXT.md`（已 @import）。**当前版本 v1.0.43**。本次会话（v1.0.35→v1.0.40）已提交的重要变化：

- **命令补全**（v1.0.38）：输入命令前缀 ≥2 字符弹候选（内置常用 + 该主机历史高频 + 快捷命令，历史带描述），**Tab 补全 / ↑↓ 选择 / 点击补全，不自动执行**；转义/回车/Ctrl/点击面板外自动关闭；行被服务器改写（dirty）时不补全
- **性能**（v1.0.37）：主终端 xterm **WebGL 渲染**（GPU 不可用自动回退 canvas）、scrollback 5000→3000、启动延迟加载堡垒机资产
- **SFTP 加固**（v1.0.35）：进度节流（`lib/sftp-progress-throttle.js`，每 job 每 100ms 一条，**文件切换立即发送**保证多文件面板逐行）、120s 传输假死看门狗、stat 30s 超时
- **堡垒机连接编辑**（v1.0.39/40）：新建连接后自动展开「已保存堡垒机连接」子区；H3C 资产区块头菜单首位有「✏️ 编辑连接」
- **macOS 双击启动**：检测 LaunchServices 启动 + 内网 EHOSTUNREACH 时，错误消息明确提示用启动器

**v1.0.41/42 修复的交互 bug**：

- **输入法残留被当输入发到服务器**：空格兜底/焦点复位会派发 synthetic `compositionend`，xterm 的 `_finalizeComposition` 会把**隐藏 textarea 的残留内容**当用户输入 `triggerDataEvent` 发给 SSH（症状：敲 `df -Th` 回车 → 服务端收到 `df -Th T` → `df: T: 没有那个文件或目录`；日志特征：空格键两条 SEND）。修法：统一入口 `resetTermComposition`（renderer.js）——只在 xterm 真卡组合态时复位，且**复位前先清空 textarea**，冲刷内容恒为空
- **SFTP「⬆ 上一级」点了没反应**：① 已在根目录时旧版仍去重读同目录（H3C 设备 readdir 慢，40s 内界面毫无动静）→ 改为立即提示「已在根目录」且不发请求；② `sftpParent` 认 H3C Comware 的 `flash:/`、`cfcard:/` 文件系统根；③ 读取中/结束都有状态栏反馈；④ readdir 40s 超时后**无传输在跑时重置 SFTP 通道**（旧版挂死的请求会把设备串行 SFTP 堵死，之后每次点击都再等 40s）

- **备用屏切换乱抢焦点**（v1.0.42）：`connectToServer` 里 `buffer.onBufferChange → term.focus()` 无条件补焦点 —— 远端任何全屏程序切备用屏（vim 进入/退出等）都会把焦点从用户正在输入的地方（会话搜索框/路径框/堡垒机地址框）拽回终端，非当前标签也会抢。改为：**只对当前标签、且焦点不在别的输入框里时才补**（"vim 退出后终端仍能输入"的初衷不变）。回归 `verify-bufferfocus.js`、`verify-vim-real.js`
**v1.0.43 的一批修复（安全 / 传输 / 交互 / 依赖）**：

- **敏感输入不落盘**：自动填充的密码、以及任何"文本含该会话密码"的写入，一律不进会话日志与录制（`main.js` `isSecretInput` + `ssh:write` 的 `opts.noLog`）；此前自动填充的密码会明文写进 `session-logs/*.log`（实测复现）
- **取消传输保留半成品**：取消/假死超时改为 reject `code:'CANCELLED'` 并保留本地/远端半成品 + 记续传点，UI 明示"已取消(可续传)"；旧版会 resolve 成"成功"→ 走校验分支把半成品删掉
- **批量上传/下载并入加固管线**：`fastPut/fastGet` → `sshClient.uploadFile/downloadFile`（statSize 对账 + 读回核对）
- **危险命令确认覆盖全部一键入口**：AI 代码块/推荐、快捷命令、命令重发、批量执行(`batch:exec`)、登录宏 —— 与手敲同一套守卫（生产分组 + 危险分级）
- **批量连接不抢焦点**：`connectToServer(session, { background: true })` 后台开标签（5 个批量入口），不再逐台切走激活标签；并修掉 `renderLayout()` 重建 DOM 后焦点掉到 body（旧版被 `activateTab` 里的 `term.focus()` 掩盖）
- **多堡垒机资产按 `bastionUrl` 分键持久化**（旧版把合并集写到单一键，跨站点串键）
- **交互四修**：关闭「命令记录」后命令补全失效（`inputDirty` 永不复位）；`flash:/` 设备根的路径拼接/面包屑；上传成功高亮死代码；非当前 H3C 连接误报"未捕获到资产"
- **终端行残留两处防护**：初始化清理与"拒绝危险命令"都先 Ctrl+U 清行（避免半条命令被提前执行/被后续命令拼接）
- **依赖**：`xlsx` 换 SheetJS 官方 tarball 0.20.3（npm 线止于 0.18.5 且有 2 个 high 无法修复），`npm audit` 清零；评估见 `docs/deps-xlsx-evaluation.md`

**调试注意**：测试脚本会 `pkill electron`（含用户正式 app），跑完 e2e 记得重启；功能验证后清理残留 dev 实例（`pkill -9 -f "polaris-terminal/node_modules/electron"`）。

回归测试：`verify-batch-focus.js`（批量连接不抢焦点）、`verify-line-clear.js`（行残留防护）、`verify-xlsx-lib.js`（xlsx 替换）、`verify-transfer-cancel.js`（取消语义）、`verify-sftp-cancel.js`（取消端到端）、`verify-batch-sftp.js`（批量传输）、`verify-dangerous-onclick.js`（一键入口守卫）、`verify-bastion-multisite.js`（多站点分键）、`node verify-sftp-stress.js`（SFTP 全链路）、`verify-recommend.js`（命令推荐，拆模块后）、`verify-pack-upload.js`（打包/递归上传）、`verify-sftp-progress-throttle.js`（节流器单测）、`verify-space-composition-flush.js`（输入法残留污染命令行）、`verify-sftp-up.js`（SFTP 上一级/慢读取反馈）、`verify-bufferfocus.js`（备用屏切换不抢焦点）。
