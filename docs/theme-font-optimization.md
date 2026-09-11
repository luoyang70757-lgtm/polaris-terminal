# 主题 / 字体系统优化（参考 Termius）

> 生成时间：2026-08-23。参考对象：Termius 的配色/字体策略（官方文档 + release notes 查证）。
> 用途：供后续 Claude Code 会话**直接按此执行**的主题/字体优化清单。改前先读 `CONTEXT.md`「关键技术决策」第 16 条（主题系统）。
> 行号以 2026-08-23 为准；代码改动后重新 `grep` 定位。

> **状态（2026-09-11 核对代码）：T1–T4 全部已实现。**
> T1 每主题 ANSI 16 色 → `THEMES` 现 25 套预设各带 `ansi: [...]`；T2 删硬编码 css → 全库 0 处 `css: {`，统一走 `deriveUiTokens`；
> T3 字体扩充 + 自定义 → 下拉 10 个预设（含 3 个 Nerd Font）+「自定义…」输入框，存同一 `settings.fontFamily`；
> T4 补 Termius 热门主题 → Rosé Pine / Night Owl / Everforest(深·浅) / Aura 均在。
> 本文件保留为历史分析与验收依据；回归 `node verify-theme.js`。

## 结论速览

| # | 位置 | 问题 | 风险 | 建议 |
|---|---|---|---|---|
| T1 | ANSI 色板 | **16 色 ANSI 是全局一份，换主题不变** → 选「经典绿」ls 还是默认蓝系，和主题冲突 | 中 | THEMES 每套加 `ansi:[16]` 字段，applyTheme 按优先级取 |
| T2 | 预设定义 | 前 8 套硬编码 `css` 变量，后 12 套走 `deriveUiTokens` 派生 → 两套来源，硬编码覆盖派生，会漂移 | 低 | 全部统一走 deriveUiTokens，删 css 块 |
| T3 | 字体 | 下拉只有 7 个字体，缺 Nerd Font/Cascadia/Meslo/Source Code Pro 等；无「自定义字体名」入口 | 低 | 扩充列表 + 加自定义输入 |
| T4 | 预设覆盖 | 缺 Termius 热门主题：Rosé Pine / Night Owl / Everforest / Aura | 极低 | 可选补充 |

## 现状盘点（证据）

- **主题结构**（renderer.js:32-122）：20 套预设，每套 `name / appearance / term(bg,fg,cursor,selection)`；前 8 套（dark/light/green/solarized×2/nord/dracula/onedark）额外带硬编码 `css`，后 12 套只写 term 配色。
- **ANSI 16 色全局**（renderer.js:160、694、760）：`settings.customAnsi || DEFAULT_ANSI`，**一份全局、换主题不变**。applyTheme 里 `t.term.options.theme = { ...th.term, ansi }`（renderer.js:697），ansi 不含主题色。
- **UI 变量派生**（renderer.js:139-157 `deriveUiTokens`）：从 term 的 bg/fg 派生 9 个 UI 变量（`--bg-panel`/`--border`/`--text-dim`…），第 691 行 `{...deriveUiTokens(...), ...(th.css||{})}` 里硬编码 css **覆盖**派生值。
- **主题下拉已按明暗分组**（renderer.js:713-724：auto + 深色/浅色 optgroup）——已做，不用动。
- **字体列表**（index.html:553-563）：SF Mono / Monaco / Menlo / Consolas / Courier New / JetBrains Mono / Fira Code，固定 `<select>`。
- **领先项**：关键字高亮（error/warning/fail）、界面/终端字号分离、auto 跟随系统、16 色 ANSI 编辑器（设置弹窗）——Termius 没有关键字高亮。

## Termius 参考（查证结论）

- **内置主题**（release notes）：Night Owl / Light Owl / Aura / Flexoki Dark+Light / Rosé Pine(+Moon/Dawn) / Everforest Dark+Light / Kanagawa Wave/Dragon/Lotus / Hacker Blue/Green/Red；另有经典默认 **Graphite 深 / Mist 浅**——即 Polaris `termiusDark`/`termiusLight` 预设的参考来源（#222426 / #f5f5f5）。
- **每主题自带完整调色板**：前景/背景/光标/选区 + **ANSI 16 色**（`color-palette-overrides` 里 color0-7 亮色、color8-15 普通色）——这是 Termius 主题「自洽」的关键。
- **字体**：Nerd Font 系 + 等宽编码字体，含 FiraCode / JetBrainsMono / Meslo / Source Code Pro(+变体) / DejaVu Sans Mono / Ubuntu Mono / Cascadia Code，支持连字。

## 优化项

### T1. 每主题 ANSI 16 色调色板（核心，对齐 Termius）

**现状**：换主题不换 ANSI → 「经典绿」主题下目录/错误仍是默认蓝红，观感割裂。

**方案**：
1. `THEMES` 每套加 `ansi: [16 个 hex]`，用该主题的原生调色板（Solarized / Nord / Dracula / One Dark / Catppuccin / Gruvbox / Kanagawa / Termius 官方均有公开色板可抄；没公开色板的用当前 DEFAULT_ANSI 兜底）。
2. applyTheme 取色优先级：`th.ansi ?? settings.customAnsi ?? DEFAULT_ANSI`（renderer.js:694）。用户手动改过 ANSI（customAnsi 非空）时不覆盖，尊重用户；否则用主题自带色板。
3. ANSI 编辑器（设置弹窗）继续编辑全局 `customAnsi`，文案加一句「自定义色板会覆盖主题自带的 16 色」。

**回归**：`node verify-theme.js` + 手测逐个换主题看 `ls`/错误色。

### T2. 预设统一走 deriveUiTokens（删硬编码 css）

**现状**：前 8 套的 `css` 块在 applyTheme 里覆盖派生值（renderer.js:691），时间久了会和派生算法漂移（如 dark 的 `--bg-panel #0d1530` 与 `lighten(#070c18, .05)` 不一致）。

**方案**：删掉前 8 套的 `css` 块，全部统一 `deriveUiTokens`。该函数已保证输出变量名与现有 CSS 变量名一致 → `styles.css` 零改动。删之前先截图对比 8 套主题的 UI 观感，允许微小色差（以「单一事实来源」为准）。

**回归**：`node verify-theme.js` + 深/浅各截图对比。

### T3. 字体扩充 + 自定义字体名

**现状**：固定 7 个 `<select>`（index.html:553-563），无自定义入口。

**方案**：
1. 下拉补：Cascadia Code / Meslo / Source Code Pro / Ubuntu Mono / DejaVu Sans Mono + Nerd Font 连字版（如 `"CaskaydiaCove Nerd Font"`、`"JetBrainsMono Nerd Font"`）。
2. 加一个「自定义字体名」文本框：直接输入 font-family 字符串（支持逗号回退链），存 `settings.fontFamily`，与下拉共用同一字段（下拉选「自定义…」时显示输入框）。
3. 提示：字体需系统已安装，未安装则回退默认——下拉加一行说明或预览。

**回归**：`node verify-theme.js`（含字体设置路径）。

### T4. 补充 Termius 热门主题（可选）

新增预设参考 Termius release notes 里的热门：**Rosé Pine**(+Moon/Dawn)、**Night Owl**、**Everforest**(深/浅)、**Aura**。沿用现有命名风格（中文意译，如 Rosé Pine →「松雾」），只写 `term` 配色，自动走 deriveUiTokens。

**回归**：`node verify-theme.js`。

## 不要动的

- **关键字高亮**（error/warning/fail）：Termius 没有，是 Polaris 领先项，保留。
- **界面/终端字号分离**、**auto 跟随系统**、**主题下拉明暗分组**：均已实现且合理。
- **ANSI 编辑器本身**：保留，只改它作用于全局、可被主题色覆盖的语义。

## 执行顺序 + 通用注意

建议顺序：**T1**（核心差距）→ **T2**（单一事实来源）→ **T3**（字体体验）→ **T4**（可选补主题）。

通用注意：
- `applyTheme`（renderer.js:688）是唯一入口，改动都从它过，避免散落。
- `deriveUiTokens` 的 `--ui-font` 由第 693 行单独设，别混进主题逻辑。
- 每套主题新增 `ansi` 后，`DEFAULT_ANSI`（renderer.js:160）保留作兜底，不要删。
- 改完跑 `verify-theme.js`；该脚本会 `pkill electron`，测完记得重启 dev。
