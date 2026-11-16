# Polaris v1.0.8（2026-11-06）

本版把 **10 套内置主题整体换成 Tabby / iTerm2 精选配色**，升级后旧主题自动迁移，界面观感更接近主流终端。

## 修复：自动锁定后无法输入密码

用户反馈「自动锁定后输不了密码」。已复现并修掉，根因是**锁定界面没有真正守住键盘焦点**：

1. 锁定后点一下卡片空白处（最常见动作），焦点会掉到窗口 BODY，而全局按键兜底会把按键**转发给底层终端**
   —— 密码字符直接被发到远端 shell，界面上密码框永远是空的；
2. 如果锁定发生时正开着设置/导入/新建会话等弹窗，**弹窗的"焦点锁"**会把焦点从密码框抢回弹窗输入框；
3. 命令补全面板（z-index 1000）会浮在锁定层（300）之上，锁定界面能被遮挡/误点。

修复后：

- 锁定期所有按键只进密码框（Enter 直接解锁、Backspace 正常删除），**绝不转发给 SSH 会话、也不触发快捷键**；
- 点锁定卡片任何位置都会把焦点拉回密码框；密码框失焦立即抓回；窗口切走再回来焦点仍在密码框；
- 弹窗焦点锁在锁定期间让位给密码框；
- 锁定层 z-index 提到 1200，压住命令补全/调试面板/右键菜单/弹窗。

回归：新增 `verify-autolock-input.js`（17 条：焦点、输入落地、密码不漏进 SSH、点空白处、弹窗场景、z 序、错误密码与解锁）。

## 新的 10 套主题

| 键 | 名称 | 明暗 | 底色 | 特点 |
|---|---|---|---|---|
| `tokyonight` | 夜色 Tokyo Night（默认） | 深 | `#1a1b26` | 蓝紫夜景，与原有的科幻青强调色最搭 |
| `dracula` | 德古拉 Dracula | 深 | `#1e1f29` | 高对比紫黑，受众最广 |
| `nord` | 极地 Nord | 深 | `#2e3440` | 冷灰蓝，长时间盯屏不刺眼 |
| `solarizedDark` | 日晒 Solarized Dark | 深 | `#001e27` | 经典 Solarized 的高对比变体 |
| `gruvboxDark` | 格鲁夫 Gruvbox | 深 | `#1e1e1e` | 复古暖色 |
| `oneHalfDark` | 半深 One Half | 深 | `#282c34` | Atom One Dark 系，中规中矩 |
| `iceberg` | 冰山 Iceberg | 深 | `#161821` | 低饱和冷色，护眼 |
| `rosePine` | 松雾 Rosé Pine | 深 | `#191724` | 柔和紫罗兰 |
| `github` | GitHub 浅 | 浅 | `#f4f4f4` | 经典浅色，跟随系统时用 |
| `oneHalfLight` | 半浅 One Half | 浅 | `#fafafa` | 柔和浅色，白底不扎眼 |

配色数据来自 Tabby 社区配色方案（`tabby-community-color-schemes`，Xresources 格式），
只取终端色板（前景/背景/光标/16 色 ANSI）；UI 外壳（面板/边框/悬停/次要文字）仍由背景色与前景色派生。
许可与出处见仓库根目录 `NOTICE`。

## 升级兼容

- 老配置里的主题键**自动映射**到新配色，不会重置：
  `dark → tokyonight`、`light → github`、`termiusDark → oneHalfDark`、`termiusLight → oneHalfLight`、`catppuccinMocha → iceberg`；
  `solarizedDark / nord / dracula / gruvboxDark / rosePine` 同名保留。
- 更早已删除的主题键（`kanagawa*`、`nightOwl`、`everforest*`、`aura` 等）回落默认 Tokyo Night。

## 可读性保底

换配色最大的坑是"小字糊掉"（第三方配色里 189 套中有 95 套的次要文字对比度 < 3）。
本版在派生层加了**对比度保底**：

- 正文（`--text`）对背景 ≥ **4.5**（WCAG AA）
- 次要文字（`--text-dim`）对背景 ≥ **3.0**
- 只调整到刚够，尽量保留原配色的观感

内置 10 套实测：正文最低 **8.99**、次要文字最低 **3.05**，全部达标。

## 回归

| 脚本 | 结果 |
|---|---|
| `verify-autolock-input.js`（新增：自动锁定后输入密码） | 17/17 |
| `verify-theme.js`（重写：11 项下拉 / 旧键迁移 / 派生值 / 10 套对比度遍历 / auto 跟随） | 21/21 |
| `verify-ui-layout.js` | 21/21 |
| `verify-ui-font.js` | 通过 |
| `run-verify.js --pure` | 12/12 脚本、103 断言 |

## 安装包

| 文件 | 说明 |
|---|---|
| `Polaris.Setup.1.0.8.exe` | NSIS 安装版（推荐，支持自动更新） |
| `Polaris.Portable.1.0.8.exe` | portable 免安装版 |
| `latest.yml` | 自动更新清单 |
| `Polaris.Setup.1.0.8.exe.blockmap` | 差分下载元数据 |
