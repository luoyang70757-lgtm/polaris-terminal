# Polaris v1.0.58（2026-11-03）

## 修复

### H3C 堡垒机偶发 `ERR_CERT_AUTHORITY_INVALID`

根据诊断包 `Polaris-bastion-diag-2026-11-03-03-38-58.json`：

- 同一台 H3C 的 `accessUrl` 前两次返回
  `无法连接堡垒机(net::ERR_CERT_AUTHORITY_INVALID)`，第三次重试才成功；
- 根因：`app.on('certificate-error')` 只对 webContents 生效，
  H3C 原生 API 的 `session.fetch()` 不触发该事件，自签名证书被 Chromium 拒绝；
- 修复：对 `persist:bastion` 会话安装
  `setCertificateVerifyProc((_req, cb) => cb(0))`，与内置浏览器放行口径一致。

### 堡垒机登录后分组默认折叠

- H3C 登录成功 / 首次拉到资产：业务根、目录组、未分组、收藏子组全部折叠；
- JMS 手动登录 / MFA / 启动静默重登 / 未登录点刷新：服务器区块 + 节点分组默认折叠；
- 普通刷新（已登录）不重置用户的展开状态。

## 回归

- `verify-h3c-cert.js`：1/1（自签名 HTTPS + `window.api.h3cTree`）
- `verify-h3c-native.js`：15/15
- `verify-bastion-login-collapse.js`：6/6

## 安装包

| 文件 | 说明 |
|---|---|
| `Polaris Setup 1.0.58.exe` | NSIS 安装版（推荐，启动快，可自选目录/建快捷方式） |
| `Polaris Portable 1.0.58.exe` | portable 免安装版（每次启动自解压，较慢但便携） |
