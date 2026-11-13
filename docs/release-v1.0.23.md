# v1.0.23 发布说明 — 对外可见文字去 IP 化

> Windows 只发布便携版：`Polaris.Portable.1.0.23.exe`。

## 一句话

界面示例、文档、代码注释、测试用例、**以及已发布的 Release 正文**里，不再出现真实 IP / 内网地址 / 凭据串，
统一换成看着就像占位符的写法。

## 改了什么

### 1. 界面占位符（用户直接能看到的地方）

| 位置 | 以前 | 现在 |
|---|---|---|
| 新建会话「主机」/ 探测主机 | `192.168.1.10` | `主机地址` |
| 快速连接输入框 | `root@10.0.0.5:2222` | `root@主机地址:2222` |
| 跳板机 | `如 10.0.0.1(留空 = 直连)` | `如 跳板机地址(留空 = 直连)` |
| 隧道远程主机 | `如 192.168.1.50` | `如 内网主机地址` |
| 批量导入示例 | `web01,192.168.1.10,22,…` | `web01,<主机地址>,22,…` |

### 2. 文档 / 注释

堡垒机 `h3c-bastion.example`、JumpServer `jms.example`、PVE `pve.example`、存储 `storage.example`；
真实 HAR 里的 OTP 会话串写 `XXXX-XXXX OTP:YYYY-YYYY`。

### 3. 测试脚本

HAR 相关用例不再写死带 IP 的文件名，改为**按后缀扫描**仓库根目录的 `*.har`（`-5` 小样本优先，其次 `-11` 全量），
行为与原来一致；没有 HAR 时照旧自动跳过。

### 4. 已发布的页面

v1.0.17 / v1.0.18 / v1.0.21 / v1.0.22 的 Release 正文已逐条改干净（`gh release edit` 就地更新，不重发）。

### 5. 规则固化

`AGENTS.md`「安全约定」新增：**任何对外可见的文字**（Release 说明 / CHANGELOG / docs / 代码注释 /
UI placeholder / 提交信息）都不许出现真实 IP、内网地址、主机名、凭据串。

## 回归

| 脚本 | 结果 |
|---|---|
| `run-verify --pure` | **17/17 脚本 343 断言** |
| `verify-bastion-proto` / `verify-bastion-har` | 35/35 · 13/13 |
| `verify-h3c-client` / `verify-bastion-ui` / `verify-bastion-clear` / `verify-bastion-panel-fix` | 30/30 · 11/11 · 16/16 · 7/7 |
| `verify-bastion-multisite` / `verify-bastion-pull-move` / `verify-sftp-pin` / `verify-sftp-sizes` | 5/5 · 5/5 · 24/24 · 5/5 |
| `verify-ui-layout` / `verify-theme` | 21/21 · 21/21 |

## 升级注意

功能零变化（只有文案与测试脚本调整），不需要改任何设置。v1.0.22 的「默认内置面板 + WinSCP 协议 SFTP/SCP」照旧。
