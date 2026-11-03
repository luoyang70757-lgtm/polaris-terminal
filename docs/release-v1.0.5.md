# Polaris v1.0.5（2026-11-03）

## 修复：H3C `ERR_CERT_AUTHORITY_INVALID`

**现象**：请求堡垒机连接失败：

```
无法连接堡垒机(net::ERR_CERT_AUTHORITY_INVALID)
```

**根因**：

- `setCertificateVerifyProc` 的校验结果会被 Chromium 网络服务**缓存**；
- H3C webview 先登录时，可能把“证书校验失败”结果缓存下来；
- h3c-api 在首次请求时才懒安装证书放行，已经来不及覆盖缓存；
- 所以同一 `accessUrl` 有时要点两三次/等一会儿才成功。

**修复**：

1. `app.whenReady` 一开始（任何 webview/HTTP 请求之前）就对 `persist:bastion`
   安装 `setCertificateVerifyProc(callback(0))`；
2. h3c-api 保留懒安装兜底；
3. 捕获 `ERR_CERT_*` 时重新安装放行并**自动重试一次**，不再让用户手动点三次。

## 回归

- `verify-h3c-cert.js`：1/1
  - 新增“webview 先走自签名 HTTPS，再调原生 API”的复现路径
- `verify-h3c-native.js`：15/15

## 如果仍复现

1. 确认版本是 **v1.0.5**；
2. 完全退出应用再启动（让 Chromium 网络服务重新初始化证书缓存）；
3. 检查系统时间是否正确、是否有企业代理/杀软做了 HTTPS 中间人；
4. 仍失败请导出堡垒机诊断包，日志里应能看到：
   - `[MAIN] 已放行 persist:bastion 堡垒机自签名证书`
   - 或 `[H3C] 证书校验失败,重新安装放行后重试一次`

## 安装包

| 文件 | 说明 |
|---|---|
| `Polaris.Setup.1.0.5.exe` | NSIS 安装版（推荐，支持自动更新） |
| `Polaris.Portable.1.0.5.exe` | portable 免安装版（手动下载） |
| `latest.yml` | 自动更新版本/哈希清单 |
| `Polaris.Setup.1.0.5.exe.blockmap` | 差分下载元数据 |
