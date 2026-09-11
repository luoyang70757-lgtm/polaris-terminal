# UI 布局优化清单

> 生成时间：2026-08-23。由会话分析 `src/index.html`（布局骨架）+ `src/styles.css`（尺寸/约束）+ `src/renderer.js`（行为）得出。
> 用途：供后续 Claude Code 会话**直接按此执行**的优化清单。覆盖两类问题：**A) 功能/入口冗余**、**B) 布局健壮性与空间利用**。改前请先读 `CONTEXT.md` 的「关键技术决策」第 8 条（堡垒机入口整合）与「待办 / 已知边界」。
> 行号以 2026-08-23 为准；代码改动后重新 `grep` 定位，不要盲信行号。

## 状态更新（2026-09-11 核对代码后）

本清单写于 2026-08-23，**部分条目已在后续版本中被实现**，核对结果：

| 条目 | 状态 |
|---|---|
| A1 SFTP 传输历史双份记录 | ✅ 已完成（现仅传输失败/非传输操作写文本日志，成功上传下载不再 addLog） |
| B1 右侧面板挤死终端 | 🟡 部分完成：命令记录/批量执行**已互斥**（`toggleCmdPanel`/`toggleBatchPanel` 互相收起）；**剩余**：AI 面板仍可与二者之一同开（默认 1000px 窗口下终端约剩 100px）、`.terminal-area` 仍无 `min-width` 保护 |
| B2 面板尺寸记忆不一致 | ✅ 已完成（`sessionPanelWidth`/`sftpPanelHeight` 均已持久化，拖动后 saveSettings） |
| A2 堡垒机三重选控件 / A3 入口重复 / A4、A5 轻度冗余 / B3、B4、B5 | ⬜ 仍按原文；判断前请重新 `grep` 定位（行号以 2026-08-23 为准，已失效） |

> 主题/字体那份清单（`docs/theme-font-optimization.md`）T1–T4 **已全部实现**，见该文件头部的核对记录。

## 结论速览

### A 类：冗余（真正要动的 3 块 + 轻度 2 处）

| # | 位置 | 问题 | 风险 | 建议 |
|---|---|---|---|---|
| A1 | SFTP 面板 | 同一批传输事件在「传输记录」和「操作日志」各记一份 | 低 | 保留传输记录，日志只留非传输操作 |
| A2 | 堡垒机面板 | tabs + 下拉 + 地址栏 三重「选堡垒机」控件并存 | 中 | tabs 保留，下拉瘦身或去掉 |
| A3 | 堡垒机入口 | 头部 🌐 按钮与分组右键菜单动作重复 | 低 | 先确认产品意图，删其一或明确分工 |
| A4 | 命令记录 | 面板开关 + 设置开关 = 同一 state 双入口 | 极低 | 不必改，表述统一即可 |
| A5 | 轻度 | 调试日志三导出钮 / AI 厂商双控件 / 欢迎+底部双提示 | 极低 | 可选 |

### B 类：布局健壮性 / 空间利用（1 处近乎 bug + 若干体验项）

| # | 位置 | 问题 | 风险 | 建议 |
|---|---|---|---|---|
| B1 | 右侧面板 | 三个固定宽面板可同时打开且不收缩，终端 `min-width:0` → 默认窗口 1000px 时终端被挤没 | **高** | 命令记录/批量执行互斥 + 终端 min-width 保护 |
| B2 | 面板尺寸 | 堡垒机宽度持久化，但会话列表宽/SFTP 高不持久化，重启回默认 | 低 | 统一加 settings 持久化 |
| B3 | 工具栏 | 20+ 按钮密度高，窄窗口换行占纵向空间 | 低 | 产品取舍：低频收进「⋯」菜单 |
| B4 | 垂直空间 | SFTP 面板固定 220px，矮窗口终端只剩 ~340px | 低 | 矮窗口默认收起/自适应高度 |
| B5 | 空态 | 大体已覆盖，仅 batch 结果、AI 首开缺引导 | 极低 | 可不做 |

---

## A 类：冗余

### A1. SFTP 面板：传输历史双份记录

**现象**：`sftp-progress` 里的 `sftp-transfers-list`（Xshell 式：每文件一行 + 进度条 + 完成/失败/已取消状态，完成留在列表当「本次会话历史」，可清空）与 `sftp-log`（文件列表下方文本日志：时间 + 操作 + 结果，上限 50 条）**同时记录同一批上传/下载**。

**证据**（renderer.js）：
- `addLog` 入队：`renderer.js:8016`
- 单文件下载完成：既 `makeSftpTransferRow` 补记录行，又 `addLog`（`renderer.js:8384-8400`）
- 进度行更新 + 批次收尾状态：`renderer.js:9774-9800`
- 文本日志渲染：`renderer.js:8067-8077`
- HTML 位置：`index.html:147-153`（sftp-progress）、`index.html:156`（sftp-log）

一次下载完成后，面板上方有进度条历史行，下方又有 `⬇ 下载 xxx → xxx ✅` 文本，内容重复。

**修复方案 A（推荐）**：保留 `sftp-transfers-list`（信息更全、可清空、可点开所在文件夹），`sftp-log` 只记**非传输**操作（新建目录/删除/重命名/编辑/错误）。即删掉 `addLog` 中成功上传/下载的调用（`renderer.js:8384-8385`、`8415`），仅传输失败/取消时才落 log（保留诊断能力）。
**修复方案 B**：直接删 `sftp-log` 及其渲染逻辑与 `state.sftp.log`，面板少一块。

**回归**：`node verify-sftp-panel.js`、`node verify-sftp-stress.js`、`node verify-sftp-partials.js`。

### A2. 堡垒机面板：三重「选堡垒机」控件

**现象**：同一面板里三个控件都在做「选一个堡垒机并加载」：
- `bastion-tabs`（标签：每个已保存堡垒机一个 tab，点切换 / × 关闭 / 右键编辑删除 —— 功能最全）
- `bastion-server-select`（下拉：手动输入地址 + **同一批**已保存堡垒机 + JMS 服务器）
- `bastion-url` 地址栏 + 「打开」（手动输入地址）

tabs 和下拉枚举的是**同一份 `bastionServers()`**，动作都是「填地址并加载」。

**证据**（renderer.js）：
- tabs 渲染：`renderer.js:4541-4581`
- 下拉渲染：`renderer.js:4631-4645`
- 下拉 change 已触发加载：`renderer.js:8859`
- 「加载」按钮 `bastionLoadSelected`：下拉有值就走 `bastionSelectServer`，与 change **重复触发**（`renderer.js:4660-4665`）

**修复建议**：tabs 保留（功能全）；下拉**瘦身或去掉**，只保留 tabs 覆盖不到的 JMS 服务器，或并入 tabs。可一并考虑去掉「加载」按钮（其功能已被 change + 「打开」覆盖）。
**注意**：双击堡垒机资产走 `bastionSelectServer('B:'+id)`（`renderer.js:5632`），是下拉的 id 链路 —— 改下拉时要保这条路径，否则双击资产失效。

**回归**：`node verify-bastion-ui.js`、`node verify-bastion-merge.js`、`node verify-h3c.js`（登录态/切换是高风险区）。

### A3. 堡垒机入口重复：4 个入口通到同一面板

**现象**：`openBastionPanel()` 至少 4 个入口：
1. 会话列表头部 `btn-bastion-browser` 🌐（`renderer.js:8794`）
2. 面板收起时的 `bastion-mini` 🌐 迷你条（`restoreBastion` → `openBastionPanel`，`renderer.js:4521`）
3. 会话列表 🛡 分组右键菜单「🌐 H3C(浏览器登录)」（`renderer.js:1549`）
4. 双击堡垒机资产（`renderer.js:5632`）

其中**头部 🌐 按钮和分组右键菜单项动作完全相同**（都只调 `openBastionPanel`）。

**背景**：CONTEXT.md 关键技术决策第 8 条已把头部「🛡 堡垒机」按钮并入分组右键菜单，但头部 🌐 按钮作为「打开浏览器面板」被保留，与右键菜单项重复。

**修复建议**（先与用户确认产品意图，三选一）：
- a) 删头部 🌐 按钮，只留分组右键（最贴合「入口整合」方向）；
- b) 删分组右键「H3C 浏览器登录」项，只留头部 🌐；
- c) 明确分工：头部 🌐 = 打开面板，右键 = 直接加载 H3C。
无论选哪个，**双击资产入口（4）和迷你条（2）都要保留**。

**回归**：`node verify-bastion-merge.js`（专门覆盖入口整合）。

### A4. 命令记录：同一开关双入口

**现象**：命令记录面板的 `cmd-record-toggle`（● 记录中 / ○ 已暂停，`renderer.js:6407-6418`）与设置弹窗的 `set-cmdrecord`（`renderer.js:9151`）控制**同一个** `state.settings.cmdRecord`，同步良好，不是 bug。

**结论**：不必改代码。只是在文档/需求里要表述为「同一个开关的两个入口」，不要当成两个独立功能。若要统一，倾向删设置里那一项、保留面板快捷开关（改动小、收益也小，优先级低）。

### A5. 轻度冗余（可选，基本可不做）

- **调试面板日志三导出按钮**：⬇ 下载 / 📋 复制 / 💾 保存（`renderer.js:9072-9099`）导出同一份日志到不同落点，各自有用，**不建议删**。
- **AI 厂商双控件**：`ai-vendor-select`（下拉切换已存厂商）与 `ai-vendor`（输入框，显示当前厂商名 + 兼作新厂商名，`renderer.js:958/9195`）语义重叠。可改 input 只做「新建厂商名」或并入「＋ 新增厂商」弹窗；UI 影响小，优先级低。
- **欢迎提示 vs 底部提示**：`welcome-hint-session`（`index.html:88-90`）与 `asset-footer`（`index.html:92`）都在提示「双击连接」。可让 footer 只在无会话时显示，或去掉欢迎条。

---

## 不要动的（看起来重复，实际不是）

- **工具栏 📁 SFTP 开关 vs SFTP 面板内操作按钮**：前者只控面板显隐，后者是文件操作，层次不同。
- **工具栏 🔌 连接 / 双击会话 / 批量条连接 / 快捷连接条**：分层快捷方式，是常见设计。
- **「全选」按钮出现在搜索行与 SFTP 面板**：不同上下文（选主机 vs 选文件）。
- **快捷连接条 vs 新建会话弹窗**：临时直连不保存 vs 完整保存，用途相反。
- **命令记录面板 / 批量执行面板共用 `.cmd-panel` 样式**：class 复用，不是布局重复。
- **AI 面板主机选择 vs 会话列表**：作用域不同。

---

## B 类：布局健壮性 / 空间利用

### B1. 右侧固定宽面板会把终端挤没（最严重，近乎 bug）

**现象**：右侧面板全部固定宽 + `flex-shrink: 0`：
- 命令记录 `cmd-panel`：340px（styles.css:961）
- 批量执行 `batch-panel`：共用 `.cmd-panel` 样式，也是 340px
- AI `ai-panel`：320px（styles.css:936-947）
- 堡垒机 `bastion-panel`：默认 560px，可拖到 1200px（styles.css:714-715）

而终端区 `min-width: 0`（styles.css:460），**无最小宽度保护**。

**关键**：三个面板**不互斥**——`toggleCmdPanel` / `toggleBatchPanel` / `toggleAiPanel`（renderer.js:3578/3588/1058）各自独立开关，开一个不会关另一个。

**复现路径**：默认窗口 1000px（min 900，main.js:2381）。会话列表 240 + 命令记录 340 + 批量 340 + AI 320 = **1240px > 窗口宽度 → 终端被挤到 0**；即便只开命令记录 + AI 两个面板，也只剩 ~100px，基本没法用。

**修复方案**（建议组合）：
- 方案 A（最小改动，最贴合现有结构）：命令记录/批量执行**互斥**——共用 `.cmd-panel` 样式、视觉上就是「同一位置的两种视图」，开一个自动收另一个；AI 面板可独立。
- 方案 B：`.terminal-area` 加 `min-width`（如 360px），空间不足时右面板被压缩或溢出隐藏。
- 方案 C：空间紧张时右面板自动收成窄条（图标模式）。

**回归**：面板显隐相关 `verify-*.js`（如 verify-toolbar.js）；`refitAll()` 已在两个 toggle 里调用（renderer.js:3582/3595），改动后确认终端 xterm refit 正常、输出不越过垂直分割线。

### B2. 面板尺寸记忆不一致

**现象**：堡垒机面板宽度持久化（`state.settings.bastionWidth`，renderer.js:8543），但会话列表宽度（divider-v，renderer.js:8520）与 SFTP 面板高度（divider-h，renderer.js:8526）**不持久化**，重启回到默认 240px / 220px。

**修复**：给 `sessionPanelWidth` / `sftpPanelHeight` 加 settings 持久化，与 `bastionWidth` 一致（`makeResizer` 的 onEnd 回调里 `saveSettings()`）。

### B3. 工具栏密度（产品取舍，非 bug）

**现象**：20+ 按钮分 4 组 + AI 挤一条工具栏，窄窗口靠 `flex-wrap` 换行（styles.css:175）成 2-3 行，占纵向空间。

**可选**：高频按钮留一行、低频（录制/过滤/推荐/快捷）收进「⋯ 更多」菜单或分组收起。**这是交互取舍，改动前先确认产品意图。**

### B4. 终端垂直空间（轻微）

**现象**：SFTP 面板默认固定 220px 高（styles.css:1237），窗口最小高 600px 时终端只剩 ~340px，偏紧。

**可选**：矮窗口时 SFTP 面板默认收起，或高度跟随窗口自适应。

### B5. 空态（已覆盖，不用动）

会话树「还没有会话」（renderer.js:1568）、命令记录「还没有命令记录」（3433）、堡垒机空态引导（index.html:238-243）、探针占位均已覆盖。仅 batch 结果、AI 首开缺引导，轻微，可不做。

### 已有基础

会话列表已用 `container-type: inline-size` + `@container` 窄宽适配（styles.css:434/441）——右面板的响应式可照这个先例做。

---

## 执行顺序与通用注意

建议顺序：
1. **A1 SFTP 双份记录**（低风险、收益直接）→ `verify-sftp-*.js`
2. **B1 右面板挤死终端**（布局健壮性，方案 A 改动小）→ `verify-toolbar.js` + 相关面板 verify
3. **A3 堡垒机入口**（先确认意图）→ `verify-bastion-merge.js`
4. **A2 堡垒机面板双选器**（中等风险，依赖 A3 决定）→ `verify-bastion-ui.js` / `verify-h3c.js`
5. **B2 尺寸持久化** → 重启后手测
6. **B3/B4/A4/A5** 视需要，基本可不做

通用注意：
- 改前先跑一遍相关 `verify-*.js` 建立基线；这些脚本会 `pkill electron`，测完记得重启 dev。
- 面板显隐/分隔条改动，注意 `.main-body` 是横向 flex，**右侧面板的左右次序由 DOM 顺序决定**（`index.html:199` 注释：AI 面板放最后，永远最右）。删/改面板时不要打乱这个次序。
- 所有删除都要先确认没有 `verify-*.js` 依赖对应 DOM id（grep 一下）。
- `refitAll()` 在面板开关后必须调用，否则 xterm 输出会越过垂直分割线（renderer.js:3582/3595）。
