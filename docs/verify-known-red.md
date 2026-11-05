# 已知红灯用例（与本轮改动无关）

> 记录时间：2026-11-03。`node run-verify.js` 全量跑时这三个脚本稳定失败，**与本轮改动无关**：
> 用 `git stash push -- src/renderer.js src/index.html src/styles.css` 回到改动前，同样 4 条断言失败（脚本输出一致）。
> 保留在套件里（不自动跳过），避免"看起来全绿"掩盖真实回归；修它们需要单独一轮排查。

| 脚本 | 失败断言 | 现状与线索 |
|---|---|---|
| `verify-debug-log.js` | ② `KEY ... →终端`、③ `KEY '␣' ... 已兜底转发终端` | 调试面板里 **完全没有 KEY 行**（只有 FOCUS/STATUS/SEND/RECV）。`dlog('KEY')` 在 `window keydown` 捕获层最前面被 `topVisibleModal()` 早退或 `state.tabs.size` 判定拦住，需加临时探针确认是哪一条。CDP `Input.dispatchKeyEvent` 派发的键确实进了 xterm（有 SEND），所以不是"键没到"。 |
| `verify-space-composition-flush.js` | B（组合残留 `" T"` 被发给 SSH）、C（空格看门狗未触发） | B：模拟 `compositionstart` + `textarea.value=' T'` 后敲空格，仍 `SEND " T"` → `resetTermComposition` 的 `termCompositionStuck()` 判定在该状态返回"没卡住"，没清 textarea。C：`term.options.disableStdin=true` 后敲空格，250ms 看门狗没产出 `RECOVER` 日志，需确认 `armSpaceWatchdog` 的调用点是否在 `disableStdin` 时被跳过。**A（干净环境每键只发一次）仍通过**。 |
| `verify-vim-real.js` | 右键终端 → 上下文菜单 | `menuVisible=false`：CDP 的 `Input.dispatchMouseEvent` 右键没有触发 `contextmenu`（Chromium 侧行为变化），后续自然找不到「📥 粘贴」项。菜单项本身仍在代码里（`renderer.js` 终端面板右键菜单）。改为直接调用 `showCtxMenu` 或合成 `contextmenu` 事件即可修。 |

## 怎么复核

```bash
cd <repo>
git stash push -- src/renderer.js src/index.html src/styles.css   # 回到任一"绿灯"基线
node verify-debug-log.js                # 仍是 5/7
node verify-space-composition-flush.js  # 仍是 4/6
node verify-vim-real.js                 # 仍是 3/4 + 异常
git stash pop
```

（`verify-vim-real.js` 依赖本机 `python3` + `pty-bridge.py`，CI 不跑。）
