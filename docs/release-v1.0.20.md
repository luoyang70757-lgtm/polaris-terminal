# v1.0.20 — SFTP 权限/属主/时间戳对话框 + 传输限速

发布日期：2026-11-13
上一版本：v1.0.19（H3C RDP/Web 资产 `accessclient://` 透传）

## 为什么做这一版

用户在 SFTP 里干重活时缺两件最基础的事：

1. **改权限要切工具**。传上去的脚本 `chmod +x`、网站根目录改 `755`、把 `/etc/xxx` 属主从 `root` 交给业务账号 —— 以前只能开终端敲 `chmod`/`chown`，而堡垒机场景往往没有终端（RDP/Web 资产、chroot 的 SFTP-only 账号）或者不方便敲。
2. **没法给传输踩刹车**。公司专线/跨机房同步，一条 SFTP 不限速会把整条链路跑满；同理，"先限 50 KB/s 慢慢传完再走" 是运维常用手法。

这两件事 WinSCP 都有（这也是用户当初想要 WinSCP 的原因之一），所以补齐后，`设置 → SFTP → WinSCP` 的三档里选 `panel`（完全用内置面板）也不再缺胳膊少腿。

## 一、「🔐 权限与属性…」对话框

入口：SFTP 面板 → 右键文件/目录 →「🔐 权限与属性…」。

设计约束：

- **先读后改**。打开对话框立刻 `sftp:stat` 取远端真实属性（mode/uid/gid/size/mtime），填进表单并渲染 `ls -l` 风格符号预览；读到之前「保存」是禁用的 —— 不允许"盲改"（用户以为改的是 755，实际改的是 000）。
- **校验两端各一次**。渲染层输入时就红字提示（`644` 打错成 `64O` 立刻能看见），主进程 `sftp:setAttrs` 再用 `lib/sftp-attrs.js` 的 `validatePatch()` 复核 —— IPC 不是只有对话框能调，前端校验不能当安全边界。
- **只下发真的动过的字段**。`buildAttrsPatch` 收成 `{mode?, uid?, gid?, mtime?}`，空的跳过；一项都没改 → 对话框直接关，不惊动服务器。
- **顺序固定 chown → chmod → utimes**。`chown` 会清掉 `setuid`/`setgid` 位，先 chmod 等于白改；`chown` 的 `uid`/`gid` 必须同时给（缺的一侧用当前 stat 回填），否则等于把属主改一半。`atime` 缺省跟 `mtime` 一致（多数场景要的是"两个时间都对齐"）。
- **递归要可预期**。目录才有「包含子目录与文件」；勾了就先递归列清单，**上限 20000 条**（`SFTP_ATTRS_RECURSE_MAX`）并在返回里标 `truncated`，避免"想改一个目录，结果把挂载点下几万条一起 chmod，SFTP 通道直接拖死"。符号链接目录**不递归**（防环）。
- **失败不冒充成功**。逐项 SETSTAT，失败项收集前 10 条回显（`错误 1：/path …`），成功数写回调用方并在传输记录留一行 `🔐 权限 644 / UID 0 / GID 1000`。

八进制解析口径（`lib/sftp-attrs.js`）：

| 输入 | 结果 | 说明 |
|---|---|---|
| `644` / `0644` / `0o644` / `0O644` | `0o644` | 3~4 位；前缀 `0o`/`0O` 可省 |
| `4755` | `0o4755` | setuid 档位合法 |
| 空 | `empty`（不改） | 只改属主/时间也行 |
| `64O`（字母 O）/ `8xx` / `77777` / 负数 | 报错 | 只收八进制数字，上限 `0o7777` |

符号串（`modeToSymbolic`）覆盖 `s`/`S`/`t`/`T` 四个特殊位，例如 `0o1664` + 目录 → `drw-rw-r-T`（sticky 设了但 other 无 x → 大写 `T`）。

数据侧新增 IPC：

- `sftp:stat`（`{ok, stat:{mode, modeOctal, symbolic, uid, gid, size, isDir, atime, mtime, mtimeLocal}}`，20s 超时）
- `sftp:setAttrs`（`{ok, applied, total, errors, truncated, text}`）

## 二、传输限速

设置 → SFTP →「传输限速（每条连接，KB/s；0 = 不限）」。

- **0 = 不插流**。`createThrottle(0)` 返回 `null`，`ssh-client` 里 `rs.pipe(ws)` 原样走 —— 不限速的人一分钱开销都不付。
- **用节流 Transform，不改底层**。上传/下载两条管道各插一处：`rs.pipe(mid).pipe(ws)`。ssh2 的 SFTP 请求、断点续传（`resolveDownloadResume`）、上传对账（`sftpSizes`）都只看"流是否正常结束"，插一节流完全不影响它们；Transform 自带 backpressure，不会变成"内存里攒一大坨再一次性灌给 socket"。
- **速率算法**：维护"下一个允许开始时间"（`nextAt`），每块数据算出应到时刻并单调累加，`await` 到点再放行。长时间平均速率稳定，不受逐块 `setTimeout` 抖动影响（不会越跑越慢/越跑越快）。实测 300KB @50KB/s 用 5.4s、200KB @100KB/s 用 2.0s。
- **清理干净**：cancel / 假死 / error 各分支都 `mid.destroy()`，`destroy()` 里清掉待触发的定时器；有专门的回归断言"destroy 后 400ms 内必须 close"。
- 上限 100 MB/s；非法/负数/空按 0（不限）处理。改设置**立即生效**（保存设置 + 推主进程），面板日志可见 `[SFTP] 传输限速 = 50 KB/s`。

单位口径（容易搞错的地方）：

- `lib/sftp-throttle.js` 的 `normalizeRate(kbps)` 入参是 **KB/s**（设置里填的数）。
- `lib/ssh-client.js` 的 `setTransferRate(bytesPerSec)` 入参是 **字节/秒**。
- 换算只在 `main.js sftp:setTransferLimit` 一处做（单一换算源）。

## 三、Mock 侧配套

`mock/sftp-vfs.js`：

- 新增 `SETSTAT` 应答（`chmod`/`chown`/`utimes` 三个 flag 各对应一次应答）——缺它 ssh2 客户端会一直等，测试必然卡死。
- `toAttrs` 允许 `node.mode/uid/gid` 被 SETSTAT 覆盖。
- **改 mode 时保留类型位**：`(attrs.mode & 0o7777) | (node.type === 'dir' ? 0o040000 : 0o100000)`。真实 OpenSSH `stat` 回的是 `0o100640`/`0o040700`，`attrs.isDirectory()` 依赖 `0o040000`；不补类型位的话面板会把目录当文件直接崩（这个坑实测踩到过）。

## 回归

| 脚本 | 结果 |
|---|---|
| `verify-sftp-attrs.js`（纯 Node） | **100/100** |
| `verify-sftp-throttle.js`（纯 Node，含实测速率） | **37/37** |
| `verify-sftp-attrs-dialog.js`（Electron + mock 端到端） | **16/16** |
| `run-verify --pure` | **17/17 脚本 337 断言**（原 15/200） |
| `verify-sftp-download-many` | 16/16 |
| `verify-sftp-panel` | 5/5 |
| `verify-batch-sftp` | 5/5 |
| `verify-sftp-upload-flash` | 3/3 |
| `verify-transfer-cancel` | 10/10 |
| `verify-sftp-cancel` | 9/9 |

已知历史红灯不变（与本版无关）：`verify-debug-log` 6/8、`verify-space-composition-flush` 4/6、`verify-vim-real`（需真实 vim），见 `docs/verify-known-red.md`。

## 发布形态变更（同日追加）

按要求 **Windows 只发便携版**：

- `package.json` 的 `build.win.target` 只留 `{ target: 'portable', arch: ['x64'] }`，`nsis` 配置块删除。
- `.github/workflows/build-windows.yml` 的 artifact / Release 上传项只留 `*.exe`（不再传 `latest*.yml` / `*.blockmap`）。
- v1.0.20 的 Release 已删除 `Polaris.Setup.1.0.20.exe`、`.blockmap`、`latest.yml`，**只剩 `Polaris.Portable.1.0.20.exe`**。
- 自动更新（electron-updater）随之停用：便携版一直走「手动下载新版（替换 exe 即可保留数据）」提示，`app:checkUpdate` 的版本检查与下载页跳转不受影响。

## 升级注意

- 无破坏性变更：老数据库、老设置照旧；限速默认 0 = 不限，行为与升级前一致。
- 递归改权限要 20000 条以上时会被截断，返回里 `truncated:true`，需要分批做。
- 属主/属组改的是**数字 UID/GID**（不是用户名）：面板不查 `/etc/passwd`（chroot/SFTP-only 账号常常查不到），填用户名会明确报错。
