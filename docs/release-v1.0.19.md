# Polaris v1.0.19 — RDP / 存储 Web 资产：交给 H3C 客户端打开（方案 A）

> 上一版（v1.0.18）把 RDP / 存储 Web 资产**识别出来了**，但只能提示"去堡垒机网页里开"。
> 这一版把双击之后那一步也补上：把堡垒机签发的 `accessclient://` 会话地址**原样交给本机
> 已装的 H3C 客户端（AccessClient.exe）**，由它拉起 mstsc / 浏览器 —— 和 H3C 自己网页里的
> 行为完全一致。

---

## 1. 为什么不是"在 Polaris 里跑 RDP"

评估文档 `docs/decision-rdp-support.md` 的结论（v1.0.18 已写）：RDP 的问题不是"能不能"，
而是"在哪跑"。

- **H3C 自己就用 `mstsc`**：`10.204.240.4-5.har` 里 RDP 资产的 `accessUrl` token 解出来是
  一份 mstsc 启动配置 —— `{"app":"mstsc","fa":"s:10.204.240.4:3389","sa":"super",`
  `"as":"s:S2J2XC13N0CTKR OTP:oEdvH5XRq9IV","sh":"10.204.253.79",…}`，**没有 `pw`/`hn`/`pn`**。
  也就是说网关签发的是一次性图形会话凭证，不是 SSH 凭据。
- **纯 JS 的 RDP 库不能用**：`node-rdpjs` / `mstsc.js` 均为 **AGPL v3.0**（`npm view` 实测），
  分发桌面应用等于整包开源，直接排除。FreeRDP（Apache-2.0）官方只发源码包、Windows 二进制
  要自己 MSVC 构建；IronRDP 是 WASM + Rust 工具链，内嵌进 xterm 画布的工作量 4~8 周。
- **用户机器上已经有能跑 RDP 的东西**：H3C 控制台自己就要求装 `AccessClient.exe`（它安装时
  注册了 `accessclient://` URL scheme）。所以最划算的是**复用**，不是重写。

于是 v1.0.19 取方案 A：**不做 RDP 协议栈，只做会话透传**。零第三方二进制、零授权风险，
一次覆盖全部 64 台 RDP + 115 台存储/服务器 Web 资产（按 6 份真实 HAR 去重统计）。

## 2. 用户看到的变化

| 场景 | v1.0.18 | v1.0.19 |
|---|---|---|
| 双击 RDP 资产（本机装了 H3C 客户端） | 弹「只能打开 SSH/SFTP…去网页开」 | **请求 accessUrl → 交给 AccessClient.exe → mstsc 窗口起来** |
| 双击 RDP 资产（没装客户端） | 同上 | 提示写清**缺 `AccessClient.exe`** + 安装指引（不再让人以为没权限） |
| 右键 RDP 资产 | 「ℹ️ 非 SSH 资产(RDP)，点此查看说明」 | 装了 → 「🖥 用堡垒机客户端打开(RDP)」；没装 → 原说明项 |
| 存储 Web 资产 | 右键「🌐 用系统浏览器打开」 | 多一条「🖥 用堡垒机客户端打开(Web)」（走堡垒机自己的单点登录，免再输一次密码） |
| 行悬浮提示 | 「双击查看说明」 | 装了 → 「双击用 H3C 客户端打开(RDP)」 |

SSH 资产链路（双击直连 KoKo 网关）**完全没动**。

## 3. 实现要点

### 3.1 新增 `lib/h3c-client.js`（纯函数，可注入便于单测）

- `isAccessClientUrl(url)`：只放行 `accessclient://` + urlsafe base64 字符集（`A-Za-z0-9-_+=/%`），
  挡掉 `http/file/javascript`、空格/引号/换行（**命令行注入**）、超长（>8KB）。
- `detectPlan(platform, env)`：Windows 用 **`%SystemRoot%\System32\reg.exe`** 绝对路径查
  `HKCR\accessclient` 的 `URL Protocol`（不依赖 PATH）；非 Windows 返回 `supported:false`。
- `parseDetect/parseHandler/handlerBasename`：解析 `reg query` 输出、取出处理器路径，日志里只留文件名。
- `openTarget(platform, url)`：**返回原样字符串**，刻意不做任何 URL 规范化。

### 3.2 主进程（`main.js`）

- `ipcMain.handle('h3cClient:detect')`：探测是否注册了该 scheme，装了顺手记一下处理器文件名；
  失败也是 `{ok:true, installed:false}`（探测失败 ≠ 功能报错）。
- **`app:openExternal` 新增 `accessclient:` 分支，且放在 http/https 白名单之前**：
  ```js
  if (raw.toLowerCase().indexOf('accessclient:') === 0) {
    if (!h3cClient.isAccessClientUrl(raw)) return { ok:false, error:'连接凭证格式不正确(accessclient)' };
    const plan = h3cClient.openTarget(process.platform, raw);
    if (!plan.ok) return { ok:false, error: plan.error };
    await shell.openExternal(plan.url);   // ← 原样,不过 new URL()
  }
  ```
  **不能过 `new URL()`**：token 里的 `+` `/` `=` `%` 会被重编码，主进程 `zlib.inflateSync`
  直接报 `unexpected end of file`（v1.0.18 解码 H3C token 时踩过同样的坑）。
- `execFileP(file, args)`：一次性短命令执行（8s 超时 + 1MB 上限），只用于注册表探测，
  不经过 shell、不拼字符串。

### 3.3 渲染层（`src/renderer.js`）

- `state.h3cClient = { installed, handler, supported }`，启动时 `detectH3cClient()` 探测一次
  （失败静默回落成"未装"，功能降级为说明文案，不会消失）。
- 新增 `bastionConnectNonSsh(asset, accountName)`：**装了才请求 `accessUrl`**（带 `proto`=真实
  服务键 + `handoff:'accessclient'` 日志），拿到 `accessclient://` 才交给 `bastionOpenAccessClient`；
  没装 / 没有堡垒机登录会话 → 记 `accessUrl-skip` 并给可读提示，**绝不发无效请求**。
- 新增 `bastionOpenAccessClient(acUrl, asset)`：统一走渲染层唯一外链出口 `openExternalUrl()`；
  成功 → 状态栏「已交给 H3C 客户端打开…」；失败 → **状态栏改红 + 弹窗写明原因**，不冒充成功。
- `bastionNonSshEntry(a, clientInstalled)`（纯函数）：入口文案唯一来源（右键首项 + 行 `title`）。
- `bastionUnsupportedAssetMsg(a, {clientMissing})`：没装客户端时补一句「缺 AccessClient.exe，
  可先在 H3C 控制台页面安装」。
- `handleAccessClientUrl` 的 `graphic` 分支：老路径（用户从网页复制来的 token）也复用同一套
  透传，装了客户端就直接打开。
- `isOpenableUrl()`：显式放行 `accessclient://`（**不能交给 `new URL()` 判定**），其余规则不变；
  `openExternalUrl()` 记录 `state.lastOpenExternalError` 供失败提示复用。

## 4. 安全边界

1. **不分发 H3C 闭源二进制**：只借用用户机器上已装的 `AccessClient.exe`（同 WinSCP 口径：
   `POLARIS_H3C_CLIENT=1` 只是回归钩子）。没装就是"不出现入口/不接管"。
2. **白名单只有 `accessclient://`**：`file://`、`javascript:`、`mailto:` 仍一律拒绝
   （回归脚本断言 `file:///etc/passwd` 打不开）。
3. **不做 URL 规范化**：透传的是堡垒机签发的原样字符串，防注入靠 `isAccessClientUrl` 的
   字符集正则（空格/引号/换行全部拒绝）。
4. **非 Windows 无感**：`detectPlan('darwin'|'linux')` → `supported:false`，
   macOS/Linux 上 RDP/Web 资产仍是"说明 + 浏览器直达"。
5. **日志不含 token 正文**：只记 `tokenLen`、`app`、`fa`、`sn`、`st`；`bastionLog` 的
   `token-decode` 本来就被截断到 60 字符。

## 5. 回归

| 脚本 | 结果 | 覆盖 |
|---|---|---|
| `verify-h3c-client.js`（新增，纯 Node） | **30/30** | 地址判定 11 组非法输入 / 探测计划与 `reg` 输出解析 / 处理器路径 / `openTarget` 原样透传 / 主-预加载-渲染接线顺序（accessclient 分支必须在 http 白名单之前） |
| `verify-bastion-client-open.js`（新增，e2e） | **17/17** | `POLARIS_H3C_CLIENT=1` 钩子下 detect → `state.h3cClient` → 行文案/徽标/右键首项 → **透传地址逐字节一致** → 拉起失败不冒充成功 → 未装客户端记 `accessUrl-skip` → 主进程白名单（accessclient 放行 / `file://` 拒绝 / 带空格引号拒绝 / https 回归） |
| `verify-bastion-proto.js`（增强） | **29 → 35** | 新增 ⑩：装了/没装两种入口文案、Web 资产同入口、未装时的安装指引 |
| `verify-bastion-har.js`（真实 HAR） | **10/10** | `10.204.240.4-5.har`：21 台设备、10 台非 SSH 识别、RDP/Web 徽标、说明文案 |
| `run-verify.js --pure` | **15/15 脚本 200 断言** | 全量纯 Node 基线（原 14/164） |
| 无退化 | `verify-bastion-ui` 11/11、`verify-bastion-browser-ui` 9/9、`verify-term-links` 28/28 | SSH 链路、外链菜单、终端链接 |

两个新脚本都能在 macOS 上跑：`POLARIS_H3C_CLIENT=1`（假装装了客户端）+
`POLARIS_TEST_NO_EXTERNAL=1`（`openExternal` 只回 `skipped`，不真起 mstsc/浏览器）。

## 6. 已知限制 / 下一步

- **必须在 Windows + 已装 H3C 客户端**才会真正拉起会话；macOS/Linux 上只有说明文案。
- RDP 会话在**外部窗口**（mstsc）里，不在 Polaris 标签内 —— 这是方案 A 的有意取舍
  （换来零协议栈、零授权风险、功能 100% 与网页端一致）。
- 想要"标签内 RDP"是方案 D（IronRDP 画布，4~8 周），见 `docs/decision-rdp-support.md` §4；
  想要"不依赖 AccessClient 的自研 `.rdp`"是方案 B（2~4 天），取决于 `docs/…` §5 的 Windows 取证。
