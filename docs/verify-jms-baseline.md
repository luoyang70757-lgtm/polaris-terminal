# JumpServer(JMS)对接 —— 回归基线（v1.0.25 / Windows 实机）

> 记录时间：2026-11-01。新增用例 `verify-jms.js`（这条线此前**没有** JMS 独立用例，只有 bastion-* 间接覆盖）。
> 复跑：`node verify-jms.js`（mock 2241/8141，需 9471 空闲）

## 结果：14/14 通过

| # | 断言 | 结果 |
|---|---|---|
| ① | admin 登录成功（拿到 token + user） | ✅ |
| ② | 错误密码明确失败（不冒充成功） | ✅ |
| ③ | 普通用户 ops 登录成功 | ✅ |
| ④ | admin 拉到 3 台资产（名称/地址/账号齐全） | ✅ |
| ⑤ | ops 只看到 2 台（**权限隔离生效**） | ✅ |
| ⑥ | token 无效 → 明确失败（**不返回空列表假装成功**） | ✅（修复后） |
| ⑦ | 复合用户名 `admin@ssh@root@<资产IP>` 经 KoKo 网关直连成功 | ✅ |
| ⑧ | 会话展示用资产地址（`displayHost`），不是网关 127.0.0.1 | ✅ |
| ⑨ | 资产标识 `bastionKey=jms-<assetId>` 正确 | ✅ |
| ⑩ | 连接配置落盘 `数据目录/jms-servers.json`（名称/端口保留） | ✅ |
| ⑪ | `jms:restore` 能读回同一份配置 | ✅ |
| ⑫ | 会话列表「🛡 堡垒机」分组存在 | ✅ |
| ⑬ | **未登录**的 JMS 服务器也显示在列表（可右键编辑/登录） | ✅ |
| ⑭ | 资产详情 N+1 补齐账号（`permed_accounts`） | ✅ |

## 本轮发现并修复的真 bug

**JMS 登录失效被当成"成功但没资产"（静默失败）**

- 现象：token 过期后 `jms:assets` 返回 `{ ok: true, assets: [] }`，界面显示"0 台资产"，用户以为账号没权限，实际是登录过期。
- 根因：`lib/jms-api.js` 的 `request()` 只在「HTTP ≥400 **且响应体不是 JSON**」时才 reject；而 JumpServer 的 401 正好返回 JSON `{error: '未认证或 token 已过期'}` → 被当成正常响应。
- 修复：4xx/5xx 一律按失败处理，错误信息带上状态码语义（401/403 → "登录已过期或无权限,请重新登录 JumpServer"）；`err.status`/`err.data` 保留原始响应。**例外**：登录阶段的 `{error:'mfa_required'}` 仍按正常分支 resolve（MFA 是流程内状态，不是错误）。

## MFA（双因素）—— 已由 mock 覆盖

mock 新增账号 `mfa / mfa123`（OTP = `123456`）与端点 `POST /api/v1/authentication/mfa/challenge/`，
用例 `verify-jms-mfa.js`（10 条）覆盖：

| # | 断言 | 结果 |
|---|---|---|
| ① | 密码通过 → 返回 `mfaRequired`（不是直接发 token）+ 会话 cookie + `choices:['otp']` + 挑战地址 | ✅ |
| ② | 错误 OTP → 明确失败且信息可读（`JumpServer 请求失败(HTTP 400): 验证码错误`） | ✅ |
| ③ | 正确 OTP → 拿到 token | ✅ |
| ④ | MFA 后的 token 真能用（拉到 3 台资产） | ✅ |
| ⑤ | 不需要 MFA 的账号（admin）不受影响 | ✅ |
| ⑥ | UI 路径：填表点登录 → OTP 框自动出现 → 填码 → 「验证并登录」成功、资产进列表 | ✅ |

复跑：`node verify-jms-mfa.js`

## 覆盖范围之外（需真机）

- 真实 JumpServer 的 MFA 类型差异（短信/邮件/企业微信，mock 只模拟 otp）与 challenge 页面跳转
- 真实 KoKo 网关的资产跳转与审计
- 团队/角色差异（mock 只有 admin/ops/mfa 三个账号，权限表是硬编码的 2/3 台）

## 相关用例（同批验证，全部通过）

| 用例 | 断言 |
|---|---|
| verify-bastion-ui.js | 11 |
| verify-bastion-group.js（收藏分组） | 10 |
| verify-bastion-hierarchy.js（业务目录层级） | 15 |
| verify-bastion-clear.js（清除历史） | 16 |
| verify-bastion-login-collapse.js（登录后自动最小化） | 6 |
| verify-bastion-multisite.js | 5 |
| verify-bastion-server-sync.js | 4 |
| verify-h3c.js / verify-h3c-native.js（H3C 线路对照） | 8 / 15 |

见 `docs/verify-h3c-baseline.md`（H3C 线路基线，19 个脚本 / ~200 条断言）。
