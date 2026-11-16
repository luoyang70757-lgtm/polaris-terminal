# Polaris v1.0.9（2026-11-06）

本版给终端补上**链接**能力：输出里的 `http/https` 地址**按住 ⌘（mac）/ Ctrl（Win·Linux）点击**，直接用系统默认浏览器打开。

## 怎么用

1. 终端里出现 `https://...` 的地址时，鼠标移上去会**变手型并有下划线**，底部状态栏显示完整链接；
2. 按住 **⌘（macOS）/ Ctrl（Windows·Linux）** 点它 → 系统浏览器打开；
3. 不想按修饰键时：**选中整条链接 → 右键 → 🔗 在系统浏览器打开**（长链接点不准时的兜底）。

裸点击不会打开任何东西（保留给拖选文本），避免误触。

## 识别范围

| 场景 | 是否可点 |
|---|---|
| `https://example.com/docs?id=7` | ✅ |
| 中文行中间夹链接（`文档在 https://x.com/a 这里`） | ✅ 列位置精确，不会点偏 |
| 长 URL 在窄终端里**折行** | ✅ 自动拼回整条 |
| 句尾带标点（`https://x.com/a.`、`（https://x.com/a）`） | ✅ 标点不算进链接 |
| URL 自带括号（`https://x.com/a_(b)`） | ✅ 括号保留 |
| `javascript:` / `file:` / `data:` / `ftp:` | ❌ 一律不认（安全） |

## 安全

- 渲染层只识别 `http/https`，其余协议连下划线都不会有；
- 打开动作走主进程 `app:openExternal`，**再校验一次协议**（只放行 `http/https`），双保险；
- 不会把终端里的内容交给浏览器做任何自动化，只是"打开 URL"。

## 回归

新增 `verify-term-links.js`（28 条断言，全绿）：

- 纯函数：URL 抽取、尾部英文/中文标点裁剪、成对括号保留、一行多条、引号剥离、无主机名不认、非 http(s) 不认、起始列/长度；
- 协议白名单：`http/https` 放行，`javascript:/file:/data:/ftp/垃圾串` 全部拒绝；
- 真实终端：`registerLinkProvider` 已注册、缓冲区 URL 识别（含 query）、range 精确覆盖、装饰（下划线/手型光标）；
- 中文行：双宽字符按单元格算列，range 左边界准确；
- 折行：24 列窄终端下 URL 折行后拼回一条、range 跨行；
- 交互：裸点击只提示、⌘+点击打开正确 URL、主进程 IPC 拒绝非白名单、右键菜单对 URL 出现/对普通文本不出现。

其他回归：`run-verify.js --pure` 12/12 脚本 103 断言；`verify-bufferfocus` 4/4、`verify-line-clear` 6/6。

## 安装包

| 文件 | 说明 |
|---|---|
| `Polaris.Setup.1.0.9.exe` | NSIS 安装版（推荐，支持自动更新） |
| `Polaris.Portable.1.0.9.exe` | portable 免安装版 |
| `latest.yml` | 自动更新清单 |
| `Polaris.Setup.1.0.9.exe.blockmap` | 差分下载元数据 |
