# H3C 堡垒机登录 —— 回归基线（v1.0.25 / Windows 实机）

> 记录时间：2026-11-01（本机 Windows 11 + mock 环境）。用于后续改动时的对照基线。
> 复跑命令：`node run-verify.js --only=h3c --only=bastion`

## 结果：19/19 脚本全绿

```
脚本:19/19 通过   断言:177 通过（另有 4 个脚本只打 JSON/结果文件，见下）
总计约 200 条断言通过
```

| # | 脚本 | 断言 | 覆盖点 |
|---|---|---|---|
| 1 | verify-h3c.js | 8（结果文件） | token 解码（hn/pn/sa/sn）、压缩炸弹/超大/坏 base64 拒绝、`bastion:probe` 识别 SSH banner、accessclient:// 经网关连接 |
| 2 | verify-h3c-native.js | 15（结果文件） | 原生 accessUrl 登录 → 网关连接；会话字段（名称/网关/目标/资产键）；清 cookie 模拟过期 → `loggedOut` → 面板弹出重登 → 重登成功 → 再次自动最小化 |
| 3 | verify-h3c-client.js | 30 | H3C 客户端探测/拉起（RDP/Web 资产走客户端） |
| 4 | verify-h3c-cert.js | 1 | 自签名证书放行（无 `ERR_CERT_AUTHORITY_INVALID`） |
| 5 | verify-h3cguard.js | JSON 结果 | 轮询守卫：未登录不乱拉、状态不误变 |
| 6 | verify-bastion-proto.js | 32 | 资产协议识别（SSH / RDP / Web 分流，RDP·Web 不再当 SSH 连） |
| 7 | verify-bastion-login-collapse.js | 6 | 登录成功后自动最小化面板（once-per-login） |
| 8 | verify-bastion-client-open.js | 17 | 客户端入口显隐与拉起 |
| 9 | verify-bastion-browser-ui.js | 9 | 堡垒机浏览器面板 UI |
| 10 | verify-bastion-hierarchy.js | 15 | 业务目录层级 + 收藏分组缩进 |
| 11 | verify-bastion-server-sync.js | 4 | 多服务器配置同步 |
| 12 | verify-bastion-clear.js | 16 | 清除堡垒机历史 |
| 13 | verify-bastion-group.js | 10 | 收藏分组 |
| 14 | verify-bastion-merge.js | 9 | 入口合并（🛡 分组右键） |
| 15 | verify-bastion-multisite.js | 5 | 多站点 |
| 16 | verify-bastion-pull-move.js | 5 | 资产拖拽 |
| 17 | verify-bastion-ui.js | 11 | 面板 UI |
| 18 | verify-bastion-panel-fix.js | 7 | 面板收起/展开修复 |
| 19 | verify-bastion-har.js | -（依赖 HAR 快照，无则秒过） | HAR 回放 |

## 登录链路（被这些用例覆盖的实现）

```
① webview 登录（partition=persist:bastion，只承载会话 cookie）
② 主进程原生通道：h3c:tree / h3c:devs / h3c:recent（ses.fetch 带 cookie 直连 /shterm/api/*）
③ 点资产 → h3c:accessUrl 拿 accessclient:// → zlib 解压 → hn/pn(网关)、sa(账号)、pw(一次性 OTP)
④ 复合用户名直连网关 SSH → 落到目标资产（复用普通 SSH/SFTP 通道）
```

容错点（都在 `lib/h3c-api.js`）：
- 401/403、返回 HTML 登录页、URL 跳登录页、登录错误码 → `needLogin` → 面板自动弹出重登
- 网络层失败（连不上/DNS/超时）→ 明确报错，**不误判成未登录**
- 自签名证书 → 主进程对 `persist:bastion` 放行；webview 先登录导致证书失败缓存时清缓存重试一次

## 已知边界

- **真实 H3C 设备端到端登录未在本机验证**（需内网堡垒机地址 + 账号）；以上均为 mock 覆盖协议与状态机层面。
- `verify-bastion-har.js` 需要历史抓包 `*.har`（含真实内网信息，未入库），无文件时直接通过。
- `verify-h3c.js` / `verify-h3c-native.js` / `verify-h3cguard.js` 把结果写到 `%TEMP%/verify-*-result.txt`，`run-verify.js` 统计为「断言 -」，需看文件或按退出码判定。

## 本轮顺带修掉的用例问题（Windows）

远端这条线里 5 个脚本仍用 `spawn('node_modules/.bin/electron')`（macOS/Linux 的 shell 脚本），
Windows 上必然 `ENOENT` → 改成 `spawn(require('electron'))`：
`verify-h3c-cert` / `verify-bastion-browser-ui` / `verify-bastion-server-sync` /
`verify-check-update` / `verify-nologin-hint`（commit `acd3d97`）。
