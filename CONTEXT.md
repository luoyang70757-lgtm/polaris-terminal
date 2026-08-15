# CONTEXT.md — 当前开发会话上下文快照

> 本文件是 2026-08-15 开发会话（DSH session-d735fe6b）的可移植上下文快照，随项目克隆。任何 Agent（DSH / Claude Code / Cline / Codex / Cursor）在新环境读完本文件即可恢复对本项目的完整认知，无需原始会话。
> 原始会话 JSONL（57093 行，14MB，zstd 压缩）位于本机 `~/.dsh/sessions/--Users-major-DeepSeek-polaris-terminal--/session-d735fe6b-21be-467e-a4b4-6fd18970d3f5/session.jsonl.zstd`（仅本机可读，克隆环境不可用——本文件即其精华摘要）。

## 项目与目标

Polaris（北极星）— Electron SSH/SFTP 终端。用户开发主线：**参考 Chaterm 完善功能**，本会话聚焦：堡垒机（JumpServer + H3C）对接与体验打磨、SFTP 面板完善、稳定性修复、全量日志。

## 用户需求脉络（本会话 104 条消息提炼）

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

## 已完成功能（代码已提交）

- 堡垒机：JumpServer API（登录/资产/复合用户名 KoKo 网关）+ H3C Web（accessclient:// token 解码、自动登录、资产捕获）
- SFTP：面板（浏览/上传下载断点续传/编辑/重命名/删除/多选）、按标签独立状态、连接名下拉、真实目标主机区分、路径面包屑、文件右键菜单、默认家目录探测
- 稳定性：右键菜单防刷屏（3 层）、BODY 焦点兜底（Cmd+A/普通键不吞）、堡垒机轮询优化、上传后刷新（path 崩溃修复）
- 全量日志系统（lib/app-log.js + 调试面板下载）
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
8. **会话上下文**：`.polaris-data/`、`*.har`、probe 脚本、含真实凭据的 verify 脚本不入库（.gitignore）

## 运行与调试

```bash
# dev（自动 mock）
POLARIS_LOCK_DIR="$PWD/.polaris-data" ./node_modules/.bin/electron . --dev --no-sandbox --disable-gpu
# 正式版编译
npm run dist   # release/mac/Polaris.app
# e2e 验证（会 pkill electron，测完重启）
node verify-<功能>.js
```

- 真实环境：JumpServer `192.168.1.250`（admin / 密码见本地 `~/.jms-terminal/jms-servers.json` 或用户提供），PVE 资产 `192.168.1.254`（root，经 KoKo 网关 2222）；H3C 参考 `10.204.240.4`（HAR 已入 .gitignore）
- 日志：`数据目录/logs/app-*.log`（全量）；调试面板 🧾 → ⬇ 下载日志

## 待办 / 已知边界

- 正式版未签名（Gatekeeper 需右键打开或系统设置放行）；正式版 app.asar 需 `npm run dist` 重新编译才含最新代码
- H3C 资产 SFTP 根目录取决于 H3C 网关配置（非 JumpServer sftp_home），家目录探测会自动回退
- SFTP 上传大目录/断点续传已实现但未经大批量压力测试
- 当前未提交改动：本次上下文文件（AGENTS.md/CONTEXT.md）及可能的 verify 脚本，需按需提交
