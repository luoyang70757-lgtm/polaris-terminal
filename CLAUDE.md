# CLAUDE.md — Claude Code 项目上下文

本项目的完整上下文见：
- **`AGENTS.md`** — 项目架构/运行/约定（Claude Code 也读取）
- **`CONTEXT.md`** — 当前开发会话快照（需求脉络/技术决策/待办，2026-08-15）

开始工作前请先读这两个文件。关键提醒：
- 数据目录默认 `~/.jms-terminal`（或 `POLARIS_LOCK_DIR`）；开发用 `.polaris-data/`（已 gitignore）
- 不要提交 `.polaris-data/`、`*.har`、probe 脚本、含真实凭据的脚本
- 运行 dev：`POLARIS_LOCK_DIR="$PWD/.polaris-data" ./node_modules/.bin/electron . --dev --no-sandbox --disable-gpu`
- 编译正式版：`npm run dist`
- 调试日志：🧾 调试面板（⬇ 下载日志导出完整 app 日志）
