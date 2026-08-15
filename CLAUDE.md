# CLAUDE.md — Polaris（北极星）SSH/SFTP 终端

Claude Code 项目上下文。本文件 + 下方 `@import` 的内容会在每次会话自动加载，让新环境（克隆后）的 Claude Code 立即获得完整项目认知与开发历史。

@import AGENTS.md
@import CONTEXT.md

## 本文件要点（快速须知）

- **项目**：Electron 43 + xterm.js + ssh2 + SQLite 的 SSH/SFTP 终端（参考 Chaterm 功能开发）
- **架构**：单文件主进程 `main.js`（~2600 行）+ 渲染进程 `src/renderer.js`（~9300 行）+ `preload.js` contextBridge 安全桥（无 nodeIntegration）
- **运行 dev**：`POLARIS_LOCK_DIR="$PWD/.polaris-data" ./node_modules/.bin/electron . --dev --no-sandbox --disable-gpu`（自动拉起 mock 服务器）
- **编译正式版**：`npm run dist` → `release/mac/Polaris.app`（未签名，Gatekeeper 需右键打开）
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

见 `CONTEXT.md`（已 @import）：SFTP 家目录探测、面包屑修复、堡垒机（JMS/H3C）对接、全量日志、右键菜单/焦点/刷新稳定性修复均已完成并提交；**堡垒机入口已整合**（头部🛡按钮删除，3 项菜单并入会话列表🛡分组右键菜单，右侧浏览器面板保留）。回归测试 `node verify-bastion-merge.js`。待办见 `CONTEXT.md` 末尾章节。
