# Polaris v1.0.18 — H3C 堡坉机：分得清 RDP / Web 资产，不再当 SSH 连

## 背景（用户提供真实流量 `10.204.240.4-5.har`）

用户拿 H3C 堡坉机的真实 HAR 让助手「参考下」。对照后发现旧实现有一处**语义错误**：

- H3C 资产接口里 `dev.services.services` 的**键就是协议名**，实测出现三类：
  - `{ ssh: { port: 22, proto: 'ssh', state: 1 } }` → 可接终端
  - `{ rdp: { … } }` → Windows 图形会话（`accessclient` token 里是 `app:"mstsc"`、`fa:"网关:3389"`、`as:"…OTP:…"`）
  - `{ Device_Storage_web: { url: "https://10.204.253.79:8088" } }` → 存储 Web 控制台
- 旧代码只认 `srv.ssh` / `srv.sftp`，**其余一律当 `ssh`**：
  1. 双击 RDP/存储资产时拿 `proto='ssh'` 去 `POST /shterm/api/deviceAccess/accessUrl`（堡坉机侧协议不匹配，还留一条失败访问记录）；
  2. 真拿到图形 token 时没有 `pw`/`hn`/`pn` 字段，前端落到"堡垒机连接信息不完整"——**用户完全不知道是资产类型不支持**。
- 规模影响（`10.204.240.4-11.har` 全量复算）：854 台资产里 **180 台（约 21%）不是 SSH**，在旧实现下全是"点了没反应/连不上"。

## 改动

### 1. 协议识别（`src/renderer.js`）
- `bastionParseDevs` 不再只看 ssh/sftp：新增 `protocols`（保留 H3C 原始服务键）、`webUrl`（`services.<*web*>.url`，仅收 `http/https`）；`proto` 取 `ssh`（其次 `sftp`，都没有则取第一个服务键）；`port` 取所选服务的 `port`，缺省 22。
- 新增纯函数：`bastionAssetProtos` / `bastionAssetSupportsSsh` / `bastionProtoLabels` / `bastionUnsupportedAssetMsg` / `accessClientSessionKind`。

### 2. 连接拦截（不再误发请求）
- `bastionConnect` 开头即判定：非 SSH 资产**直接给可读提示并 return**（不打 `accessUrl`）：
  - 有 `webUrl` 的：`「X」是通过 Web 接入的资产，Polaris 只能打开 SSH/SFTP 终端。\n可以在右键菜单「🌐 用系统浏览器打开」里直接访问: https://…`
  - 其余：`…请在 H3C 堡垒机网页里打开它。`
- `handleAccessClientUrl` 先分辨 token 类型：`mstsc/rdp/vnc/guacamole/xfreerdp/spice` → `graphic`，提示"H3C 图形客户端接入，无法接管"；缺 `pw`/`hn`/`pn` → `incomplete`。**SSH token（带 app 字段但不属于图形客户端）仍正常接管**。
- 批量连接（`batchBastionConnect`）只连 SSH 资产：状态栏写「批量连接 H3C 资产 N 台…(跳过 M 台非 SSH)」，全是非 SSH 时直接提示不启动。

### 3. 列表可见性（`src/renderer.js` + `src/styles.css`）
- 非 SSH 资产行加协议徽标（`RDP` / `Web` / 原始键，多协议取并集），名字压成次要色（`.asset-nonssh`）、`title` 里写清"双击查看说明"与协议。
- 右键菜单：非 SSH 资产首项换成「ℹ️ 非 SSH 资产(RDP)，点此查看说明」；有 `webUrl` 时新增「🌐 用系统浏览器打开」（走 `window.api.openExternal`）；「连接 SSH / 账号切换 / 断开 / 打开 SFTP」只对 SSH 资产出现。

## 回归

| 脚本 | 结果 |
|---|---|
| `verify-bastion-proto.js`（**新增，纯 Node**） | **29/29** |
| `verify-bastion-har.js`（增强） | **6/6**（小样本 `-5.har`）/ **13/13**（全量 `-11.har`） |
| `run-verify --pure` | **14/14 脚本 164 断言**（原 13/135） |
| `verify-bastion-ui.js` | 11/11 无退化 |

- 新增 `verify-bastion-proto.js`：从 `renderer.js` 切出纯函数区块在 Node 里 eval，覆盖 SSH / RDP / Web / ssh+rdp / sftp-only / 无 services（向后兼容）/ 树结构 / token 类型判定 / 真实 HAR 一致性（21 台全部对得上，SSH 11 / 非 SSH 9）。
- `verify-bastion-har.js`：`findHar()` 支持 `POLARIS_HAR` 环境变量与 `-5.har`；小样本 HAR（只录一页 20 台）不再拿"≥800 台 / >100 目录 / 多目录设备"的规模阈值误报红；新增 ⑦（真实数据协议判定）、⑧（列表徽标与说明文案在真实 DOM 上渲染）。

## 已知边界

- **只有 SSH/SFTP 能在 Polaris 里打开**。RDP 图形会话、存储/设备 Web 控制台需要对应的图形客户端，Polaris 不做（这也是本次改成"明确说明 + 浏览器直达"而不是硬连的原因）。
- 老缓存里的资产没有 `protocols` 字段 → 会按 `proto`（旧值是 `ssh`）判定；重新拉一次资产列表即恢复正确标记。
- 服务键里出现意料之外的值（如 `-11.har` 里的 `B/S`）不会崩：标签回落成原始键，连接判定按"非 ssh/sftp"处理。

## 手动验证（Windows / 内网）

1. 打开 H3C 堡坉机面板并登录，展开资产列表。
2. RDP 主机（如 Windows 资产）与存储设备行应显示橙色 `RDP` / `Web` 徽标；双击弹提示，说明去堡坉机网页打开。
3. 存储资产右键「🌐 用系统浏览器打开」应直接打开 `https://<设备>:8088`。
4. SSH 资产双击照常起终端、右键「📁 打开 SFTP」照常可用。
5. 需要看判定细节时开「调试 → 终端调试日志」，`bastionLog` 会记 `accessUrl-skip` / `token-not-ssh`（含 `protocols` / `app` / `fa`，无私密信息）。
