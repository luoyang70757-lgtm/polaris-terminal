# v1.0.14 — 修「AI 对话框文字不能复制」+「Ctrl+C 不生效」

> 用户反馈两句：①「ai 对话框中的文本不能复制」②「ctrl+C 不生效了」（并附了终端调试日志）。
> 查下来根因是**同一个**：全局按键兜底会把所有按键 preventDefault 后转发给终端，连 ⌘/Ctrl+C 的
> 原生复制一起吞掉；而"转发"这条路径本身也是坏的 —— 合成事件没有键码，xterm 直接丢弃。

## 日志证据（`long_text_819E….txt`）

```
[17:17:24.960] FOCUS → TEXTAREA.xterm-helper-textarea (终端)
[17:17:24.960] KEY 'c' ^ ime=0 kc=0 active=TEXTAREA.xterm-helper-textarea →终端
[17:17:24.961] KEY 'c' ^ active=BODY →已兜底转发终端       ← 焦点已被顶到 BODY
```
两条 `KEY`、**一条 `SEND` 都没有** —— 日志里 `kc=0` 就是合成事件的键码缺失；对照同一天的正常按键
是 `KEY 'c' ^ ime=0 kc=67 … →终端` + `SEND sess-1 "\u0003"`。所以 Ctrl+C 既没打断远端命令，
也没复制界面选中的文字。

## 五个成因与修法

| # | 成因 | 现场 | 修法 |
|---|---|---|---|
| 1 | 全局 keydown 兜底（BODY 焦点）无条件 `preventDefault()` | 用户点过 AI 面板 → 焦点掉到 BODY → ⌘/Ctrl+C 被吞，选中文字复制不出来 | 有"终端以外"的选中文字时**放行 ⌘C**（`hasSelectionOutsideTerm()`），不 preventDefault 也不转给终端 |
| 2 | AI 对话区不可聚焦 | 点进去焦点还是 BODY，所有按键进兜底路径 | `#ai-chat` 加 `tabindex="-1"` + `mousedown` 取焦点；聚焦后按键**不再**走终端兜底 |
| 3 | 兜底转发用合成 `KeyboardEvent`，**没带 keyCode/which** | 日志 `kc=0`，xterm 按键映射拿不到键码 → 静默丢弃（Ctrl+C/Ctrl+D/Tab/字母全废） | 合成事件用 `Object.defineProperty` 补 `keyCode`/`which`（取原事件的值） |
| 4 | 合成事件会被同一个 window 捕获 handler 再处理一遍 | 焦点没真正落到终端时无限递归转发 | 合成事件打 `__polarisSynthetic` 标记，handler 开头直接 return |
| 5 | 选中文字后按 ⌘A 被当"终端全选" | 想把整段 AI 回答复制走，结果只全选终端 | 焦点在对话区时 ⌘A = 全选对话内容（`selectAllInRegion`） |

## 顺手做的两件事

- **每条 AI 消息一个「📋」**（悬停显形）和**每个代码块一个「📋 复制命令」**：流式文本边滚边变、
  拖选容易丢，给显式入口；复制走 `window.api.copyText`，状态栏给反馈。
- **对话区里不转发组合键**：以前 Ctrl+C 在对话区（无选中文字）会静默给远端发 `^C`，把正在跑的
  命令打断。现在组合键留给界面/系统，只有普通打字才还给终端（也就是"点一下 AI 面板还能直接敲命令"）。

另外补了两条 CSS：`.ai-chat / .ai-msg / .ai-msg-body / .ai-code { user-select: text }`（SFTP 面板早有
同类修复，AI 面板漏了）+ `.ai-chat:focus { outline: none }`（聚焦只为了拿键盘，不画焦点框）。

## 回归

- 新增 `verify-ai-copy.js` **11/11**（结构 tabindex / user-select / 复制按钮、点消息体聚焦对话区、
  选中后 ⌘C 不被拦截、BODY 焦点 + 有选中时也放行、⌘A 全选对话、普通字符仍转发终端、
  无选中时 ⌘/Ctrl+C 不误发 `^C`、消息复制与代码块复制真的写进剪贴板）。
  **未修复版 1/9 通过**（③ ⌘C 被吞、④ ⌘A 全选终端、① 无 tabindex/user-select、无复制按钮）。
- 新增 `verify-key-forward.js` **7/7**（BODY 焦点下 Ctrl+C → `SEND "\u0003"`、Ctrl+D → `"\u0004"`、
  Tab / ↑ / 普通字母都真到远端、终端焦点下 Ctrl+C 不受影响）。
  **未修复版 3/7 通过**（①②③④ 全红，日志有 `已兜底转发终端` 但无 SEND，与用户日志一字不差）。
- 既有回归：`verify-ai-config` 11/11、`verify-ime-deadkey` 9/9、`verify-bufferfocus` 4/4、
  `verify-line-clear` 6/6、`verify-ui-layout` 21/21、`verify-theme` 21/21、
  `run-verify --pure` 12/12 脚本 103 断言。`verify-debug-log` 6/8（②③ 是历史红灯，
  stash 前后一致，见 `docs/verify-known-red.md`）。

## 复现要点（写测试时踩到的坑）

- **新手引导弹窗会兜住所有按键**：`topVisibleModal()` 命中 `onboarding-modal` 时，按键被
  `preventDefault` 并转进弹窗第一个输入框（不产生 KEY 日志）。e2e 里必须先关掉再测按键。
- **无标签页时全局 handler 整体早退**（`state.tabs.size === 0`）：要验证边界逻辑得先接一个
  mock 会话，或用假 `state.tabs` 桩。
- CDP 修饰键：`2`=Ctrl、`4`=Cmd、`8`=Shift；测 Ctrl+C 用 `modifiers: 2` + `windowsVirtualKeyCode: 67`。
