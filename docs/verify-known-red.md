# 已知红灯用例（历史记录：已全部修复，v1.0.29）

> 2026-11-03 记录的三条红灯在 **2026-11-17（v1.0.29）** 全部定位并修掉。
> 保留本文作为排障记录——它们当时被判定「与本轮改动无关」，实际是**测试环境/断言写法**问题（两条）加**一个真 bug**（`" T"` 残留被发给服务器）。
> 现在套件里不再有红灯；下面写清每条的根因与回归值，避免以后又踩同样的坑。

| 脚本 | 当时失败断言 | 根因 | 现在 |
|---|---|---|---|
| `verify-debug-log.js` | ② `KEY ... →终端`、③ `KEY '␣' ... 已兜底转发终端` | **新手引导的 `.modal` 开着**。产品行为正确：弹窗打开时全局 keydown 一律归弹窗输入框（`topVisibleModal()` → `preventDefault()`+`focus()`+return），所以 `dlog('KEY')` 根本不会执行。测试用临时数据目录 = 首次解锁 = 引导必然弹出，而它是**延迟**弹出的（会等别的弹窗，最多 5×1.5s），于是同一个脚本时红时绿（曾出现一次 8/8）。探针结论：`window.__kd=1`（handler 跑了）、`keyLines=0`、`modalOpen=1` 同时成立。 | **9/9**。测试在连上会话后先 `closeOnboarding(true)` 并等 `.modal:not(.hidden)` 归零；同时也印证了别在测试里指望「弹窗开着还能敲终端」。 |
| `verify-space-composition-flush.js` | B（组合残留 `" T"` 被发给 SSH）、C（空格看门狗未触发） | **B 是真 bug**：xterm 5.3 有时 `_compositionHelper.isComposing=false`（它不认为自己组合中），但隐藏 textarea 里仍留着上一次 preedit（`" T"`），敲空格时被 `_finalizeComposition` 一并 `SEND` → 命令行变成 `df -Th T`。`termCompositionStuck()` 因此返回「没卡住」→ 不清理。**C 是假红**：`armSpaceWatchdog` 本身正常，但测试窗口是非焦点窗口，Chromium 把后台定时器**节流到 ~1s**，断言只等 450ms。 | **6/6**。产品侧：空格 keydown 分支在 `resetTermComposition()` 之后**无条件**清掉非组合态残留的 `textarea.value`（真实组合 `e.isComposing` 已在前面排除）；测试侧：RECOVER 改成轮询等待最多 2s。 |
| `verify-vim-real.js` | 右键终端 → 上下文菜单（`menuVisible=false`） | Chromium 的 `Input.dispatchMouseEvent` 右键**只发 mouse 事件，不派发 DOM `contextmenu`**（不是产品 bug，代码里 `paneEl.addEventListener('contextmenu')` 一直在）。 | **5/5**。测试改为在 `.term-pane` 上合成 `MouseEvent('contextmenu', {button:2})`，走的仍是产品同一条监听器 → 菜单 → 「📥 粘贴」→ 焦点回终端整条链路照旧验证。（仍依赖本机 `python3` + `pty-bridge.py`，CI 不跑。） |

## 以后遇到「日志里少一类行」先查这三件事

1. **弹窗**：`.modal:not(.hidden)` 有几层？弹窗开着时按键全部归弹窗（`KEY`/`SEND` 都不会有）。
2. **焦点**：`document.activeElement` 是 `xterm-helper-textarea` 还是 `BODY`/某个输入框。
3. **定时器节流**：非焦点窗口里 `setTimeout` 会被拉到 ~1s（Chrome 行为），断言别死等 250ms。

## 复核命令

```bash
node verify-debug-log.js                # 9/9
node verify-space-composition-flush.js  # 6/6
node verify-vim-real.js                 # 5/5
node run-verify.js --e2e --only=debug-log   # 套件内单跑（更稳，脚本自身有等待/重试）
```

> 这些 e2e 脚本在本机连跑时偶发 `⏱ 测试超时(120000ms)`（Electron 冷启动 + 端口释放的机器抖动），单独复跑即可；不是断言失败。
