# Polaris v1.0.15 — 「点 SFTP 直接开 WinSCP」(Windows)

> 一句话：装了 WinSCP 的 Windows 机器上，Polaris 里点「📁 SFTP」不再开内置面板，而是把
> **主机 / 端口 / 账号 / 密码**（有私钥就连私钥路径与口令）一起交给本机 `WinSCP.exe`，直接自动登录。

---

## 为什么做这个

WinSCP 的**同步、权限/属主对话框、限速、双窗格**这几块比 Polaris 内置 SFTP 面板成熟得多，而
Polaris 自己的面板定位是"顺手看一眼/传个文件"。用户诉求很明确：**要干重活时，用鼠标点一下就把
这个会话丢给 WinSCP，不想再手输一遍密码**。

"把 WinSCP 当引擎集成"上一轮已评估否决（GPLv3 + 17 个 C++Builder `.cbproj` + VCL 无公共 C ABI，
详 `docs/decision-winscp-integration.md`）。本轮只做**外链**：不分发、不链接、不解析其输出，
只在用户机器上已有 WinSCP 时 `spawn` 它 —— 完全没有 GPL 义务。

---

## 具体行为

### 三档设置（设置 → SFTP）

| 模式 | 点「SFTP」时 |
|---|---|
| **`replace`（默认，新装即此档）** | 直接拉起本机 WinSCP。**没装或拉起失败 → 自动回落内置面板**（功能一定不消失） |
| `button` | 照开内置面板，工具栏多一个「🪟 WinSCP」按钮；标签右键菜单也有入口 |
| `panel` | 只用内置面板，WinSCP 入口完全不出现 |

入口显隐**只认探测结果**（`state.winScp.installed`）：探测不到就一个按钮都不显示，不会出现
"按钮在、点了必报错"的体验。

### 传过去的东西

```
WinSCP.exe sftp://账号:密码@主机:端口/ [-privatekey=<私钥路径>] [-passphrase=<口令>]
```

- 用户名/密码走 `encodeURIComponent`（`p@ss:w/rd#1` → `p%40ss%3Aw%2Frd%231`），否则 WinSCP
  解析歪会表现成"密码错误/主机名错误"，用户根本看不出是编码问题。
- 私钥存的是**路径**，直接 `-privatekey=`；文件不存在就不传（让 WinSCP 弹自己的登录框），
  有口令才 `-passphrase=`。
- **堡垒机原样透传**：`jms@ssh@账号@资产IP` 是 KoKo 网关要的复合用户名形态，整体编码后交给
  WinSCP；`displayHost` 只是展示用，绝不拿去连接。
- **主机指纹由 WinSCP 自己问**（PuTTY 风格 host key 与我们的 `known_hosts` 不通用），我们不静默信任。
- 测试/排障：`POLARIS_WINSCP_PATH` 指定自定义安装路径；`POLARIS_WINSCP_DEBUG=1` 时加
  `/log=` + `/loglevel=1`（**注意该日志含会话信息，共享前先看一眼**）。

### 密码进命令行：代价与兜底

WinSCP 没有库 API，也读不到 Electron 的 `safeStorage`，想"自动登录"只有「命令行 URL / 临时 ini /
让用户再输一次」三条路。选了命令行，配套**硬约束**：

1. **不落盘**：不写临时文件/ini，不进 shell 历史（直接 `spawn`，不经 shell）。
2. **不写日志**：`redactUrl` 把密码压成 `***`，`describeCommand` 对 URL 参数和 `-passphrase=`
   同样脱敏 → `termDebug`、状态栏、`logs/app-*.log` 里只可能看到
   `sftp://user:***@host:22/`（回归脚本专门断言明文与 `p%40ss` 编码串**都不出现**）。
3. **明说风险边界**：同用户/本机管理员的进程列表能看到 argv。不想要 → 切到 `button`/`panel`
   （那两档不传密码）。

### 非 Windows 行为

`detectExe()` 在 `darwin`/`linux` 直接返回 `null` → macOS/Linux 用户**看不到任何 WinSCP 入口**，
内置面板照旧。所以本轮改动对 macOS 用户是无感的（也就没法在本机 e2e 验证真实拉起，改由
`POLARIS_WINSCP_PATH` 指到一个 shell 桩来验证"参数长什么样 + 有没有漏密码"）。

---

## 代码落点

| 文件 | 内容 |
|---|---|
| `lib/winscp-open.js`（新） | 纯函数：路径候选 + 环境变量展开 + `detectExe` + `buildSessionUrl` + `buildArgs` + `redactUrl` + `describeCommand`（**不 spawn、不弹窗**，可注入 `platform/env/exists` 便于单测） |
| `main.js` | `winScp:detect` / `winScp:open` 两个 handler；`spawn(exe, args, {detached:true, stdio:'ignore'})` + `unref()`（Polaris 退出后 WinSCP 继续用） |
| `preload.js` | `winScpDetect()` / `winScpOpen(payload)` |
| `src/index.html` | 设置项 `#set-winscp-mode`、SFTP 工具栏 `#btn-sftp-winScp`（=`btn-sftp-winscp`） |
| `src/renderer.js` | `winScpMode()` / `refreshWinScpButton()` / `detectWinScp()` / `winScpPayloadFor()` / `openSessionInWinSCP`（=`openSessionInWinScp`）/ `toggleSftpPanel` 的 `replace` 分支 / `openInlineSftp()` 抽取 / 标签右键菜单项 |

---

## 回归

- `verify-winscp-args.js`（纯 Node，**25/25**）：探测顺序、`POLARIS_WINSCP_PATH` 覆盖、`%VAR%` 展开、
  URL 编码（`@ : / # ? % &`、空格、无密码、无端口、IPv6、堡垒机复合用户名）、缺主机报错、脱敏、
  参数组装（`-privatekey`/`-passphrase`/调试日志）。
- `verify-winscp-open.js`（真启动 Electron + shell 桩，**27/27**，连跑两次稳定）：桩收到的 argv、三处脱敏
  （渲染层 dlog / 落盘 `app-*.log` / 状态栏）、telnet 与缺主机拒绝、三档行为（replace 拉起 / 未装回落
  内置面板 / button 出按钮 / panel 隐身）、标签右键菜单显隐、渲染层入口返回值与状态栏反馈。
- `run-verify --pure` **13/13 脚本 128 断言**全绿；相关 e2e 无退化：`verify-key-forward` 7/7、
  `verify-ai-copy` 11/11、`verify-sftp-panel` 5/5、`verify-sftp-download-many` 16/16。

## 升级提示

- 默认档 `replace`：**Windows + 已装 WinSCP** 的用户升级后，点「SFTP」会直接开 WinSCP（这是本轮
  的诉求）；没装 WinSCP 的用户行为完全不变。
- 想保留内置面板：设置 → SFTP → 选「用内置面板（工具栏留 WinSCP 按钮）」或「只用内置面板」。
