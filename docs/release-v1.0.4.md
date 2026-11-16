# Polaris v1.0.4（2026-11-03）

## 修复：堡垒机「添加站点」配置弹窗显示

- 「🌐 堡垒机配置(H3C 等)」弹窗补上右上角 **✕**（以前只有底部「关闭」）；
- 打开配置弹窗时临时隐藏 `bastion-webview`：
  - Electron 的 guest view 会盖住宿主 DOM，弹窗/按钮可能被网页画面遮住；
  - 关闭时若没有其它可见弹窗，再恢复 webview（不重载页面、登录态保持）。

## 回归

- `verify-bastion-browser-ui.js`：9/9
  - 空态/错误态结构
  - 更多菜单
  - 缩放重置
  - **配置弹窗 ✕ 存在，打开时隐藏 webview、关闭后恢复**
  - `openExternal` 协议限制

## 安装包

| 文件 | 说明 |
|---|---|
| `Polaris.Setup.1.0.4.exe` | NSIS 安装版（推荐，支持自动更新） |
| `Polaris.Portable.1.0.4.exe` | portable 免安装版（手动下载） |
| `latest.yml` | 自动更新版本/哈希清单 |
| `Polaris.Setup.1.0.4.exe.blockmap` | 差分下载元数据 |
