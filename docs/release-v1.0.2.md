# Polaris v1.0.2（2026-11-03）

## 修复：终端空格被 xterm 组合态吞掉

**日志特征**：

```
KEY '␣' - active=TEXTAREA.xterm-helper-textarea →终端
（没有 SEND）
... 失焦 / 重新聚焦后 ...
KEY '␣' ...
SEND sess-2 " "
```

**原因**：

- 空格 keydown 已到达窗口，焦点也在 xterm 隐藏 textarea；
- 但 xterm 的 `CompositionHelper` / 输入法会话卡住，xterm 没有产生 `onData`；
- 失焦/重新聚焦会重建输入法会话，所以之后再敲空格恢复。
- 真实中文输入法组合中（`e.isComposing` / keyCode 229）空格用于选字，属于输入法行为，不是本 bug。

**修复**：

1. 保留原有 `resetTermComposition`（只在确认卡住时复位，避免每次空格多发一条空 `SEND`）；
2. 新增 250ms 看门狗：本次空格没有产生任何输入数据 → `textarea.blur()/focus()` 重建输入法会话；
3. **不自动补发空格**，避免真实输入法组合时出现双空格；下一次按键即可正常发送；
4. KEY 日志补充 `ime=0/1 kc=<keyCode>`，以后可直接区分“输入法组合”与“普通按键被吞”。

## 回归

- `verify-space-composition-flush.js`：6/6
  - 干净环境按键只发一次
  - 组合残留不被发给 SSH
  - `disableStdin` 模拟空格被吞 → 看门狗 RECOVER + 恢复后正常发送
- `verify-vim-space.js`：2/2
- `verify-debug-log.js`：7/7

## 安装包

| 文件 | 说明 |
|---|---|
| `Polaris.Setup.1.0.2.exe` | NSIS 安装版（推荐，支持自动更新） |
| `Polaris.Portable.1.0.2.exe` | portable 免安装版（手动下载） |
| `latest.yml` | 自动更新版本/哈希清单 |
| `Polaris.Setup.1.0.2.exe.blockmap` | 差分下载元数据 |
