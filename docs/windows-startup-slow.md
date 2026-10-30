# Windows 11 启动慢 — 根因与解决

## 结论（先看这里）

**绝大多数情况不是代码慢，而是 Windows 发布物是 `portable` 单文件 exe。**

`electron-builder` 的 portable 启动器（`node_modules/app-builder-lib/templates/nsis/portable.nsi`）每次双击都会：

1. `RMDir /r $INSTDIR` —— 删除上次解压目录；
2. `File /r` —— 把约 200MB 的 Electron 运行时 + 应用文件**重新解压**到 `%TEMP%\<uuid>`；
3. 启动 `Polaris.exe`；
4. 退出后再 `RMDir /r` 清理。

也就是说，**每次启动都是一次 200MB 解压 + 上千个文件落盘 + Windows Defender 实时扫描**。机械硬盘/开启 Defender/OneDrive 同步目录下，10–40 秒都很常见。慢发生在"窗口出现之前"，所以看起来像"点了没反应"。

## 如何确认（在用户机器上）

1. 看数据目录的启动打点：
   - 便携版：`<exe 所在目录>\.Polaris\logs\startup-error.log`
   - 安装版：`%USERPROFILE%\.jms-terminal\logs\startup-error.log`
2. 每次启动会追加类似：
   ```
   [+0ms] main.js 加载开始
   [+220ms] 模块加载完成
   [+260ms] 应用菜单就绪
   [+300ms] 锁屏窗口已创建,等待页面加载
   [+520ms] 锁屏页面加载完成(用户可见)
   ```
   - **第一行时间戳距双击很久（几秒~几十秒）** → 时间花在 portable 解压/杀软，代码侧无解，换安装版。
   - 若 `main.js 加载开始 → 锁屏页面加载完成` 本身很慢，再按下文"代码侧优化"排查。
3. 任务管理器观察：双击后先出现 `Polaris Portable <v>.exe`（NSIS 解压进程）占用磁盘，之后才出现 `Polaris.exe` —— 即为 portable 解压阶段。

## 解决方案

### 方案 A（推荐）：改用安装版（NSIS）

安装一次，之后启动只加载已解压好的文件，不再每次解压。本项目已把 Windows 构建目标改为**同时产出两种包**：

| 产物 | 启动速度 | 适用 |
|---|---|---|
| `Polaris Setup <v>.exe` | **快**（正常 Electron 启动） | 日常使用，推荐 |
| `Polaris Portable <v>.exe` | 慢（每次自解压 ~200MB） | U 盘/免安装/无法安装的环境 |

构建：`npm run dist -- --win`，`release/` 下会同时出现两个 exe。CI 同样会一起发布。

> 数据迁移（portable → 安装版）：
> - portable 的数据在 `<exe目录>\.Polaris\`；
> - 安装版数据库/锁/指纹在 `%USERPROFILE%\.jms-terminal\`，界面设置/localStorage 在 `%APPDATA%\polaris\`。
> - 迁移：先退出 app，把 `.Polaris\` 里的内容复制到上述两个目录（`data.bin`、`app.lock`、`known_hosts`、`sftp-partials.json`、`jms-servers.json`、`skills/`、`kb/`、`recordings/` 等 → `.jms-terminal\`；`Local Storage\`、`Network\` 等 Chromium 配置 → `%APPDATA%\polaris\`）。

### 方案 B：继续用 portable 时的缓解措施

1. **给 exe 与 `%TEMP%` 加 Defender 排除项**（设置 → 病毒和威胁防护 → 排除项）。企业环境需管理员策略。
2. 把 exe 放在**本地 SSD**，不要放 OneDrive/网络盘/U 盘。
3. **确认 `%TEMP%` 在本机磁盘**：`echo %TEMP%`。企业 GPO 常把 TEMP 重定向到网络盘，portable 每次往网络盘解压 200MB 会慢到 1–2 分钟。
4. 关闭该目录的 Windows 搜索索引。
5. 接受"每次启动慢"，或改用方案 A。
   - `portable.unpackDirName` 无法解决：portable.nsi 每次仍然 `RMDir /r` 后重新解压。

### 方案 C：硬件加速（可选）

代码默认在 Windows 关闭 GPU（规避部分 Win11 显卡/虚拟机的点击命中 bug），界面走软件渲染，首帧和滚动会更慢。显卡正常的机器可设环境变量：

```bat
set POLARIS_GPU=1
Polaris.exe
```

如果出现"弹窗能显示但点不动"，去掉该变量即可。

## 本次已做的代码侧优化

| 改动 | 收益 |
|---|---|
| `xlsx` 从主进程启动路径移除，改为生成 Excel 模板时 `require` | 少解析约 1MB JS |
| `tar` 改为目录打包上传时 `require` | 少解析打包库 |
| `ssh2` 改为惰性加载 + 首屏 2.5s 后空闲预热 | 启动少解析最重的依赖（Windows 上可达数百毫秒），首次连接也不等 |
| 渲染层 `xlsx.full.min.js`（930KB）改为 Excel 导入时动态注入 | 首屏少解析 930KB |
| V8 编译缓存（`<userData>/v8-compile-cache`） | 第二次启动跳过主进程模块重复解析 |
| 应用日志 200ms 批量写盘；渲染层 console 只落一次盘 | 大幅减少启动期 `appendFileSync`，Windows 上少触发杀软扫描 |
| 数据维护（`migrateUserData` / 续传表裁剪）移到锁屏窗口显示之后 | 锁屏窗口更早出现 |
| 解锁时数据库重新加密落盘延后到主窗口创建之后 | 弱 CPU 上“解锁后出界面”不再白等 PBKDF2+写盘 |
| Windows 只保留 `zh-CN` / `en-US` 两个 locale（`electronLanguages`） | 减小安装包/portable 解压体积 |
| 生产包不再包含 `mock/**` | 包更小（mock 仅 `--dev` 使用） |
| portable 解压阶段显示品牌启动图（`build/splash.bmp`） | 慢解压时不再是“点了没反应”，有视觉反馈 |
| 新增 `startup-error.log` 分段打点 | 下次可直接定位慢在哪一段 |
| Windows 构建新增 NSIS 安装版 | 根治 portable 每次解压 |

## 预期效果

- 安装版冷启动：通常 **1–4 秒**（取决于杀软/磁盘）。
- portable 冷启动：解压 200MB + 扫描，通常 **5–40 秒**，与代码优化基本无关。
