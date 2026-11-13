# 评估：Polaris 能不能支持 RDP（远程桌面）

- 日期：2026-11-13（v1.0.18 之后）
- 触发：v1.0.18 修好了「H3C RDP/Web 资产不再当 SSH 连」，但这类资产在 Polaris 里**仍然打不开**（提示让用户去堡垒机网页）。问题自然变成：能不能真的支持 RDP？
- 结论先行：**能，但要分清三层**。最划算的一层是「把会话交回系统已装的客户端（Windows 的 `mstsc.exe` / H3C 自己的 `accessclient://` 处理器）」，**0.5~1 天**；「Polaris 内嵌 RDP 画布、像 SSH 一样在标签页里」是**4~8 周**级别的工程（Rust/WASM 或原生插件 + 打包链改造），不建议先做。

---

## 1. 事实基础（来自真实流量与代码，不是猜的）

### 1.1 用户的 H3C 环境里 RDP 到底有多少

把 6 份 `10.204.240.4-*.har` 里所有资产响应按 `services.services` 的键去重（`dev.id` 唯一）：

| 协议 | 唯一资产数 | 占比 |
|---|---|---|
| SSH（含 sftp） | 690 | ~79% |
| `rdp` | **64** | ~7% |
| Web 类（`Device_Storage_web` / `Device_Server_web` / `Device_Security_web` / `VM_*_web`） | **115** | ~13% |
| 其他（`B/S`） | 1 | ~0% |

→ RDP 是真需求（64 台），但**Web 类资产（115 台）比 RDP 还多**，任何方案最好一次覆盖两者。

### 1.2 H3C 的 RDP 会话是怎么跑起来的（token 实测解码）

`POST /shterm/api/deviceAccess/accessUrl`（`proto=Device_Storage_web`，dev=2350）返回：

```
{"url":"accessclient://eJx1UctO…","launcher":"accessclient"}
```

zlib 解出的内容**本身就是一份 `mstsc` 启动配置**（键名就是 RDP 文件键名，`i:`/`s:` 是类型前缀）：

```json
{"app":"mstsc","st":"super@OceanStor Pacific 9520","ver":"4.6.7","bpp":"i:16",
 "dh":"i:440","dw":"i:1474","screen mode id":"i:1","maximize":"1","mv":"0",
 "al":"i:2","au":"i:2","pc":"i:0","rm":"i:0","ec":"i:0","audiocapturemode":"i:0",
 "keyboardhook":"i:1","use_host":"0","sh":"10.204.253.79","sn":"OceanStor Pacific 9520",
 "sa":"super","fa":"s:10.204.240.4:3389","as":"s:S2J2XC13N0CTKR OTP:oEdvH5XRq9IV",
 "url":"https://10.204.240.4:443/shterm/resources/conf/AccessClient.exe","shterm_ver":"2"}
```

要点：
- `fa:"s:10.204.240.4:3389"` = 客户端连的是**堡垒机网关的 3389**，由网关转发到目标 `sh`（10.204.253.79）——和 SSH 那条 gate 链路是同一个模型。
- `app:"mstsc"` 说明 **H3C 自己也是拉起 Windows 自带的 mstsc**，不是自研图形协议栈。
- `as:"s:… OTP:…"` 是会话凭据串（含一次性密码），**没有独立的明文密码字段**（不像 SSH token 有 `pw`/`hn`/`pn`）。
- `url` 指向 H3C 的 `AccessClient.exe` 下载地址，即 `accessclient://` 这个 URL scheme 是该程序安装时注册的——**H3C 网页 `location.href = url` 只是把 token 丢给这个处理器**。

### 1.3 关键未知点（决定方案 B 生死）

网关 `10.204.240.4:3389` **接不接受“标准 RDP 客户端 + 标准账号密码”**。三种可能：
1. 接受（凭据就是 `sa` + 某段一次性口令）→ 我们自己的 `.rdp` 也能连，方案 B 成立；
2. 只接受 `as` 里那串“preconnection/凭据”封装（类似 RD Gateway 的 `pcb:s:`）→ 仍需 `AccessClient.exe` 参与；
3. 走 CredSSP MITM / 自定义凭据提供程序 → 只有他们的 exe 能用。

这一点**没法在 macOS 开发机上验证**，必须在用户的 Windows 上做一次 10 分钟取证（见 §5）。

### 1.4 代码现状

- `src/renderer.js` 已有完整 token 解码（`window.api.bastionDecode` → base64+zlib）与「非 SSH 资产」判定（v1.0.18：`bastionAssetSupportsSsh` / `bastionUnsupportedAssetMsg`），**原始 `acUrl` 已经在手上**。
- `main.js app:openExternal` 只放行 `http/https`（`new URL(u.href)` 白名单 + `POLARIS_TEST_NO_EXTERNAL` 测试钩子）→ 要透传 `accessclient:` 必须显式扩展白名单，**且自定义 scheme 不能用 `new URL()` 往返**（`+`／`/`／`=` 会被二次编码）。
- Polaris 目前**没有 RDP 会话类型**（`package.json` 依赖只有 ssh2/xterm/xlsx/tar/iconv-lite），数据库 `sessions` 表也没有 protocol=rdp 的形态。

---

## 2. 四个候选方案

| # | 方案 | 授权 | 工作量 | 用户体验 | 主要风险 |
|---|---|---|---|---|---|
| **A** | **`accessclient://` 透传**：非 SSH 资产双击/右键 → 交给 Windows 已装的 H3C 客户端 | 不打包任何第三方二进制 | **0.5~1 天** | 弹出 mstsc 窗口（不在 tab 里），但 **RDP + 全部 Web 资产一次覆盖、功能 100% 保真**（多屏/音频/剪贴板/驱动器都由 mstsc 提供） | 依赖用户机器已装 `AccessClient.exe`；执行第三方协议处理器要先探测注册表 |
| **B** | **自己做 `.rdp` + 拉起系统 `mstsc.exe`**（非堡垒机直连 RDP 会话也能用） | 自研，无依赖 | **2~4 天** | 同样是外部窗口；可加“在 Polaris 里新建 RDP 会话” | **密码进 `.rdp` 只能靠 DPAPI blob**（`password 51:b:`，需 PowerShell 一次 `ProtectedData.Protect`）；网关是否接受标准凭据未知（§1.3） |
| **C** | **FreeRDP 旁挂进程**（`wfreerdp.exe` / `xfreerdp`，单击拉起） | **Apache-2.0**（可打包，需 NOTICE） | 3~5 天（Windows 二进制需自编或取 CI 产物） | 仍是外部窗口；参数比 mstsc 更可控（`/cert-ignore`、`/gfx`） | 官方 Release **只发源码包**（3.33.1 的资产里没有 Windows 二进制），要自己 MSVC 构建并长期跟版本 |
| **D** | **内嵌 RDP 画布（真正的 tab 内体验）** | IronRDP **Apache-2.0**（WASM）或 FreeRDP 原生插件 | **4~8 周** | 和 SSH 一样平铺在标签页里，能联动主题/分屏/录制 | 浏览器/渲染层没有裸 TCP → 需要主进程 TCP↔WS 桥 + Rust 工具链与 Windows CI；输入/剪贴板/缩放/重连/驱动器全要自己接；FreeRDP 走 native addon 还要 per-arch 编译 |

### 已被授权否决的选项（记录免得以后重复调研）

- `node-rdpjs` / `mstsc.js`（唯一成熟的纯 JS RDP 实现）：**AGPL v3.0**（`npm view` 实测），对一个要分发的桌面应用等于“整包必须开源”，且 2016 年后基本停更、无 NLA/RemoteFX/CredSSP → **直接排除**（授权 + 质量双杀）。
- Apache Guacamole：需要 Linux 侧 `guacd` 守护进程，Windows 单机安装无法自带 → 排除。
- 打包 H3C 的 `AccessClient.exe`：闭源、来源是堡垒机、签名/杀软风险 → **绝不分发**；只能像 WinSCP 那样“用户机器上已有就用”。

---

## 3. 建议路线

> **状态更新（v1.0.19，2026-11-13）**：**方案 A 已实现并发布** —— `lib/h3c-client.js` + `h3cClient:detect` + `app:openExternal` 的 `accessclient:` 分支 + 渲染层 `bastionConnectNonSsh`/`bastionOpenAccessClient`/`bastionNonSshEntry`；回归 `verify-h3c-client.js` 30/30、`verify-bastion-client-open.js` 17/17。详细说明见 `docs/release-v1.0.19.md`；B / D 仍未启动（B 等 §5 的 Windows 取证，D 暂缓）。

**先 A，再按取证结果决定 B/C，D 暂缓。**

1. **A（0.5~1 天）**：`accessclient://` 透传。
   - `main.js`：`app:openExternal` 增加 `accessclient:` 分支（保留 http/https 白名单语义；自定义 scheme 直接 `shell.openExternal(raw)` 不经 `URL` 往返；`POLARIS_TEST_NO_EXTERNAL` 同样跳过真实调用）。
   - `main.js` 新增 `h3cClient:detect`（Windows 下 `reg query HKCR\accessclient` 判 `URL Protocol` 存在；非 Windows 直接 false）。
   - `src/renderer.js`：非 SSH 资产右键首项从「ℹ️ 点此查看说明」改为「🖥 用堡垒机客户端打开（RDP/Web）」；未装则保留现在的说明文案，并给 `accessclient.exe` 的下载地址（token 里的 `url`，只在提示里展示，不自动下载）。
   - 回归：`verify-bastion-proto.js` 增「acUrl → 透传参数」纯函数断言；`verify-bastion-acclient.js`（新增，桩 `shell.openExternal`）断言 argv/URL 原样、白名单外的 scheme 仍被拒。
2. **B（2~4 天，视 §5 取证）**：通用 RDP 会话类型 + `.rdp` 生成 + DPAPI 注入密码 + `mstsc.exe` 探测（macOS `open -a "Windows App"` / Linux `xfreerdp` 分支）。
3. **C/D**：只有当用户明确要“tab 内 RDP 且不接受外部窗口”、且愿意接受 4~8 周 + Rust/原生工具链时才启动。

### 验收标准（A）

- Windows 且装了 H3C 客户端：双击 RDP/Web 资产 → mstsc/浏览器窗口起来，全程无需手输地址与账号。
- Windows 未装客户端：列表仍显示 `RDP`/`Web` 徽标，双击给出说明 + 下载指引，**不报错、不静默**。
- 非 Windows：入口不出现（与 WinSCP 同口径），日志里仍记 `accessUrl-skip` 便于排障。

---

## 4. 如果走 D（内嵌），最小可行的技术骨架

（先记下来，避免将来重新调研）

- **协议栈**：IronRDP（Apache-2.0，Rust）：`ironrdp-session`/`ironrdp-graphics`/`ironrdp-web`。WASM 在渲染层跑解码 + `<canvas>` 渲染。
- **传输**：渲染层不能裸 TCP → 主进程开 `net.Socket` 连 `host:3389`，用 `WS`（或 `postMessage`/MessageChannel）把字节流转给 wasm。这块已有 Electron IPC 经验（SFTP 分块思路可复用）。
- **输入**：键鼠事件 → 转 RDP fastpath 输入事件；剪贴板（`cliprdr`）；分辨率/DPI 变化要重新 `Deactivate/Reactivate`。
- **打包**：CI 里加 Rust + `wasm-pack`（Windows runner 可行，但要缓存 toolchain 否则打包时间 +10 分钟）。
- **里程碑**：① 只读画面能出图（1~2 周）② 键鼠可用（+1 周）③ 剪贴板/重连/DPI（+1~2 周）④ 与堡垒机 token 对接（未知数最多）。

---

## 5. 需要在用户 Windows 机器上做的取证（10 分钟，决定 B 的可行性）

1. 用 H3C 网页正常打开那台 RDP 资产（让它自己调起客户端），**先别关**。
2. PowerShell：
   ```powershell
   Get-CimInstance Win32_Process -Filter "Name='mstsc.exe'" | Select-Object CommandLine
   cmdkey /list | Select-String -Context 0,3 "10.204.240.4"
   Get-ChildItem $env:TEMP,$env:LOCALAPPDATA -Recurse -Filter *.rdp -ErrorAction SilentlyContinue |
     Sort-Object LastWriteTime -Desc | Select-Object -First 3 FullName,LastWriteTime
   ```
3. 若找到 `.rdp`：`Get-Content <file>.rdp`（**只贴 `full address`/`gateway*`/`pcb*`/`username`/`authentication level` 这几行，密码字段（`password 51:b:`）不必贴**）。
4. 结论分三种：只 `full address+username` → 方案 B 直接用系统凭据输入即可；出现 `pcb:s:`/`gatewayhostname` → 需要复刻 preconnection blob（B 仍可能，但要逆向字段）；`mstsc` 命令行里带非常规参数或根本没有 `mstsc.exe`（说明他们自研客户端）→ 只走 A。

---

## 6. 一句话总结

- **RDP 不是“能不能”的问题，而是“在哪跑”的问题**：H3C 自己都用 `mstsc`，用户机器上大概率已经装了它的客户端 → **0.5~1 天把会话透传出去**就能让 64 台 RDP + 115 台 Web 资产全部可用。
- **真正的“tab 内 RDP”是另一个量级的项目**（4~8 周、Rust/WASM 或原生插件、CI 与打包链改造），在现有阶段性目标里不划算；等 A 上线、用户真的嫌“弹出窗口”再启动。
- 纯 JS 的 RDP 库（`node-rdpjs`/`mstsc.js`）**授权是 AGPL v3**，不可用——这条要在文档里钉死，避免反复调研。
