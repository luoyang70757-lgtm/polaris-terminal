# AGENTS.md — 项目上下文（所有 AI Agent 通用）

> 本文件供任何 AI 编程 Agent（Claude Code / Cline / Codex / Cursor / DSH 等）在开始工作前读取，快速了解项目。配合 `CONTEXT.md`（当前开发会话快照）使用。

## 项目概览

**Polaris（北极星）** — 科幻风 SSH/SFTP 终端工具（Electron 桌面应用）。

- 技术栈：Electron 43 + xterm.js 5.3 + ssh2 + SQLite（node:sqlite 内置）
- 数据安全：会话数据存本地 SQLite（整库 AES-256-GCM 加密），密码走系统 safeStorage 加密（`enc:v1:` 前缀）
- 架构：单文件主进程 `main.js`（~2600 行）+ 渲染进程 `src/renderer.js`（~9300 行）+ contextBridge 安全桥（`preload.js`，无 nodeIntegration）

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

```bash
# 开发模式（自动拉起 mock 服务器）
POLARIS_LOCK_DIR="$PWD/.polaris-data" ./node_modules/.bin/electron . --dev --no-sandbox --disable-gpu

# 编译正式版
npm run dist   # → release/mac/Polaris.app（macOS，未签名）
```

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

## 安全约定

- 危险命令（rm -rf、dd、mkfs 等）在生产环境标记的主机执行前弹确认框
- 主机指纹校验（known_hosts）；`autoTrustHostKey` 设置可跳过首次信任弹窗
- **不要提交**：`.polaris-data/`、`*.har`、含真实凭据的脚本（verify-realdl/ui-dl/tcc 等）

## 常用调试

- 工具栏「🧾 调试」：终端调试日志（按键/焦点/收发数据），「⬇ 下载日志」导出完整 app 日志
- e2e 验证：`node verify-<功能>.js`（自动 spawn electron + 调试端口 + 临时数据目录，用后 pkill）
- 测试会杀掉正在运行的 app（pkill electron），测完需重启

## 当前状态（截至 2026-08-15 会话）

已完成：堡垒机（JMS/H3C）对接、SFTP 面板全功能、菜单/焦点/刷新修复、全量日志、AI 技能/推荐/知识库、堡垒机入口整合（头部🛡按钮并入会话列表🛡分组右键菜单，右侧浏览器保留）。
详见 `CONTEXT.md` 的「已完成功能」「技术决策」。
