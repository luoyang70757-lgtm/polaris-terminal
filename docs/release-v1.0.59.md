# Polaris v1.0.59（2026-11-03）

## 修复：右侧堡垒机下拉不同步

左侧保存/登录/删除 JumpServer（JMS）连接后，右侧堡垒机浏览器的服务器下拉仍停留在旧列表，
表现为「右侧获取不到左侧创建的堡垒机连接信息」。

根因：

- 左侧「＋ 新增」JMS 服务器时 `baseUrl` 为空，右侧下拉会过滤掉该条目；
- `jmsDoSave` 只刷新左侧 JMS 弹窗下拉，没有调用 `bastionRenderServerSelect()`；
- 登录 / MFA / 彻底删除同样只刷新左侧，不刷新右侧。

修复：

- 保存、登录、MFA、删除后统一刷新右侧堡垒机下拉；
- 保存后同时重绘左侧会话列表，不再等下一次偶然重绘；
- 新连接保存后即可在右侧下拉中选中并自动填充账号密码打开。

## 回归

- `verify-bastion-server-sync.js`：4/4（新增 / 改名 / 删除 / 左侧列表）
- `verify-bastion-group.js`：10/10
- `verify-bastion-multisite.js`：5/5

## 安装包

| 文件 | 说明 |
|---|---|
| `Polaris Setup 1.0.59.exe` | NSIS 安装版（推荐，启动快，可自选目录/建快捷方式） |
| `Polaris Portable 1.0.59.exe` | portable 免安装版（每次启动自解压，较慢但便携） |
