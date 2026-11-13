# Polaris v1.0.17 — WinSCP 排障日志可见（调试面板不再"什么都看不到"）

## 背景

v1.0.16 修好了「不能获得 `'.'` 的真实路径（错误码 4）」，但用户贴回来的调试日志里**一条 `[WINSCP]` 都找不到**：

```
[18:11:40] FOCUS window blur: hasFocus=false active=BUTTON#btn-sftp-toggle ...
[18:35:13] FOCUS window blur: hasFocus=false active=BUTTON#btn-sftp-toggle ...
```

这是日志**可观测性缺口**造成的误判，不是功能没跑：

- `main.js` 里 WinSCP 的拉起/失败走 `appLog.log('main', …)` —— 它**只写 `数据目录/logs/app-*.log`**，不转发渲染层；
- 渲染层调试面板只能看到 `console.log` 系列（主进程 `console.log` 会被转发成 `MAIN …`），
  所以面板里只剩「点击 SFTP 按钮 + 焦点被外部窗口抢走」两行痕迹，完全看不出 WinSCP 到底有没有拉起、
  `SFTPRealPath=off` 到底有没有带上。

## 改动

1. **主进程**（`main.js` `winScp:open`）：拉起成功/失败两处由 `appLog.log('main', …)`
   改为 `console.log(…)` —— 同时进调试面板（`main:log` 通道）与落盘日志，且内容是脱敏后的命令行：

   ```
   [WINSCP] 已拉起: sftp://root:***@10.204.240.4:22/ /rawsettings SFTPRealPath=off RemoteDirectory=/root | rawsettings={"SFTPRealPath":"off","RemoteDirectory":"/root"}
   ```

   面板里一行就能核对：URL 密码是 `***`（脱敏生效）、`rawsettings` 里确有 `SFTPRealPath=off`。

2. **渲染层**（`src/renderer.js` `openSessionInWinScp` / `toggleSftpPanel`）新增 `dlog` 记录：
   - 下发给谁、落在哪：`WINSCP 交给 WinSCP: root@ip:22 起始目录=/root/www`（或 `(未定,由 WinSCP 自己落位)`）；
   - 失败原因：`WINSCP·错误 …`；
   - `replace` 档拉起失败时：`WINSCP 拉起失败 → 回落内置 SFTP 面板(功能不消失)`；
   - 未装：`WINSCP 本机未检测到 WinSCP,放弃拉起`。
   - **这些行只含账号/主机/路径，永远不含密码**。

3. 顺带修掉 `verify-winscp-open.js` 的一个偶发：拿 sid 一轮失败会**再点一次连接再等一轮**，
   之前一次 mock 握手抖动会连带后面 18 条断言全部判红。

## 回归

- `verify-winscp-open.js`：32 → **37/37**（新增 5 条：拉起成功同时进调试面板 / 面板日志含 `rawsettings` 且无密码 /
  落盘日志含 `[WINSCP] 已拉起` / 渲染层记了「交给 WinSCP + 起始目录」/ 该行不含密码），连跑两次稳定。
- `run-verify --pure`：**13/13 脚本 135 断言**全绿。
- 无退化：`verify-key-forward` 7/7、`verify-ai-copy` 11/11、`verify-sftp-panel` 5/5。

## 用户怎么看日志

菜单栏「调试 → 终端调试日志（⌘⇧D / Ctrl+Shift+D）」打开后，点一次 SFTP（`replace` 档）应看到两行：

```
[..] WINSCP 交给 WinSCP: 账号@主机:22 起始目录=/root
[..] MAIN [WINSCP] 已拉起: sftp://账号:***@主机:22/ /rawsettings SFTPRealPath=off RemoteDirectory=/root | rawsettings={...}
```

没有第二行 = 没拉起（看第一行后面有没有 `WINSCP·错误`），或者根本是「本机未检测到 WinSCP」。
完整日志仍可用「调试 → ⬇ 下载完整日志」导出（含主进程所有内容）。
