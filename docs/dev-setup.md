# 开发环境搭建与 e2e 运行（Windows / macOS / Linux）

> 面向新机器 / 重新 clone 后的环境恢复。踩过的坑都写在下面，按顺序做即可。
> 相关背景：`AGENTS.md`（项目约定）、`CONTEXT.md`（开发历史）、`docs/windows-startup-slow.md`（打包版启动慢）。

## 1. 一次性安装

```bash
npm ci
```

两个依赖特例：

- **`xlsx`** 指向 SheetJS 官方 tarball `https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`（非 npm registry），
  所以 `npm ci` 需要能访问 `cdn.sheetjs.com`；npm 上的 `xlsx` 止于 0.18.5 且有 2 个 high 漏洞，**不要改回 registry 版本**。
- **Electron 二进制不在 npm 包内**：`electron` 的 postinstall 会从 GitHub Releases 下载约 144MB 的
  `electron-v<ver>-<platform>-<arch>.zip`。部分网络（国内 / 企业代理）直连 GitHub 会失败，而 npm 只打印告警仍返回成功，
  结果 `node_modules/electron/dist` 缺失 → `npm run dev` 和所有 `verify-*.js` 报 `ENOENT`。
  为此本仓库加了 **`postinstall → scripts/ensure-electron.js`**：检测 `dist/<path.txt>`，缺失时先试官方源、
  失败自动切 `https://npmmirror.com/mirrors/electron/` 重试。看到下面这行即正常：

  ```
  [ensure-electron] 完成:...\node_modules\electron\dist\electron.exe
  ```

  手动修复（任选其一）：

  ```bash
  # bash / zsh
  ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node node_modules/electron/install.js
  ```
  ```powershell
  $env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"; node node_modules/electron/install.js
  ```
  ```cmd
  set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ && node node_modules/electron/install.js
  ```

## 2. 开发运行

```bash
npm run dev     # 等价 electron . --dev，自动拉起 mock 服务器
```

mock 默认端口 **HTTP 8080 / SSH 2222**，测试账号 `admin/admin123`（另有 `ops/ops123`、`kbd/kbd123` 测 keyboard-interactive）。

隔离数据目录（推荐，避免污染 `~/.jms-terminal`）：

```bash
# bash
POLARIS_LOCK_DIR="$PWD/.polaris-data" npm run dev
```
```powershell
# PowerShell
$env:POLARIS_LOCK_DIR="$PWD\.polaris-data"; npm run dev
```
```cmd
:: cmd
set POLARIS_LOCK_DIR=%CD%\.polaris-data && npm run dev
```

其他常用开关：

| 开关 | 作用 |
|---|---|
| `POLARIS_GPU=1` | Windows 默认关硬件加速（规避 GPU 合成器点击失效），需要时打开 |
| `--no-sandbox --disable-gpu` | 沙箱/虚拟机上跑不起来时加 |

> 不要直接执行 `./node_modules/.bin/electron`（Unix 专用 shell 脚本，Windows 下无法运行）；
> npm scripts 会自动走 `electron.cmd`。

## 3. e2e（CDP 验证脚本）

```bash
node verify-<功能>.js        # 例：node verify-winscp-open.js
```

约定：

- 每个脚本自建临时 `POLARIS_LOCK_DIR`、自选独立调试端口，跑完 **只杀自己 spawn 的 Electron**。
- 共用工具 **`test-helper.js`**（已入库）：`freePort(port)` / `killTree(proc)` / `guardTimeout(ms, proc)` /
  `waitPort(port, ms)` / `spawnElectron(args, opts)` / `evaluate(c, expr)`，内部按平台分流：
  - Windows：`netstat -ano` + `taskkill /F /T /PID`
  - macOS / Linux：`lsof -ti tcp:<port>` + `kill -9 -<pgid>`
- 启动 Electron 统一用 **`spawn(require('electron'), ...)`** —— `require('electron')` 在纯 Node 下返回二进制绝对路径；
  写死 `'node_modules/.bin/electron'` 在 Windows 会 `ENOENT`。
- **启动竞态**：page target 一出现就 `connect` 时，`renderer.js` 可能还没执行完，此时求值会拿到
  `xxx is not defined`（`typeof` 得到 `undefined`）。各脚本的 `ev()` 统一委托给 `test-helper.evaluate()`：
  首次求值前等 `document.readyState === 'complete'`，之后对 `ReferenceError` 再做一次短重试（共 ~10s）。
- 端口冲突/残留进程：脚本开头都会 `freePort(PORT)`；`guardTimeout` 同时登记 `process.on('exit')` 清理（脚本常用 `process.exit()`，`finally` 不会执行）→ 跑完不留 Electron 进程。手动兜底可 `taskkill /F /IM electron.exe /T`（会杀掉所有 Electron 实例，慎用）。

## 4. 打包（可选）

```bash
npm run dist            # macOS → release/mac/Polaris.app；--win → release/Polaris Portable <v>.exe（只发便携版）
npm run dist -- --win   # 只编 Windows
```

electron-builder 首次打包还会从 GitHub 下载 `winCodeSign` / `nsis` 等工具链；
被墙时设置镜像后重试：

```bash
ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/ npm run dist
```

## 5. 排障速查

| 现象 | 处理 |
|---|---|
| `npm ci` 卡在 xlsx | 检查 `cdn.sheetjs.com` 可达性；或用代理 |
| `electron: not found` / `ENOENT ... electron.exe` | 跑 `node scripts/ensure-electron.js`（会自动切镜像） |
| 启动后无窗口 / 白屏 | 看 `<数据目录>/logs/startup-error.log` 的分段打点 |
| verify 脚本一直等 CDP | 先用 `freePort(端口)` 清理；确认 Electron 版本 `./node_modules/.bin/electron --version` |
| 测试后残留 Electron | `taskkill /F /IM electron.exe /T`（Windows）；`pkill -9 -f node_modules/electron`（macOS/Linux） |
| Windows 启动慢 | 见 `docs/windows-startup-slow.md`（portable 每次启动重解压 200MB） |

## 6. 用 Docker 里的真 JumpServer 联调堡垒机

改 JumpServer 对接代码（登录 / 资产列表 / KoKo 网关直连 / MFA）时，别再对着 mock 猜——
本仓库自带一套 Docker Desktop 版的 JumpServer 社区版 v4，`dev/jumpserver/` 下一条命令即可复现真机环境。

```bash
node dev/jumpserver/setup.mjs     # 首次：拉起容器 + 建库 + 写种子数据（幂等，可反复跑）
node dev/jumpserver/setup.mjs --seed-only   # 只重跑种子数据（几秒，不碰容器/迁移）
npm run dev:jms                   # 之后每次开发：写连接配置 + 起 Polaris（自动关 mock）
npm run dev:jms:smoke             # 冒烟自检 19 项：登录→3 台资产→权限隔离→会话列表→连目标机→断开→批量连接→搜索→token 过期自动重登
```

### 端口 / 账号（种子数据由 `setup.mjs` 固化）

| 项 | 值 |
|---|---|
| Web 控制台 | `http://127.0.0.1:8080`（admin / `Polaris@Admin2026`；v4 有弱口令策略，`ChangeMe` 这类会被拒。手动改过 admin 口令的用 `JMS_ADMIN_PASSWORD=... node dev/jumpserver/setup.mjs`） |
| KoKo SSH 网关 | `127.0.0.1:2222` |
| 全量账号 | `polaris` / `Polaris@123` → 授权 3 台（`dev-target-01/02/03`） |
| 受限账号 | `polaris-ro` / `Polaris@123` → 只授权 `dev-target-02`（验权限隔离） |
| 目标机 | 容器 `jms_target`（`linuxserver/openssh-server`），系统账号 `polaris`，端口 2222；
网络别名 `target-01` / `target-02` / `target-03` 就为这三台资产区分地址 |

> **三台资产共用一个容器**：地址不能都用 `target` —— JumpServer 的直连用户名是
> `JMS用户@协议@账号@资产地址`，地址重复时 KoKo 会判成“多台主机命中”而弹
> `选择其中一个资产登录 Opt>`，双击直连就断在那里。所以 compose 给 `jms_target` 挂了
> 三个网络别名，三台资产各用一个。改这块时注意口径一致。

### 种子数据（`setup.mjs`）里的 JumpServer v4 坑

改 `seed()` 时注意（都是真实踩过的）：

- 登录成功返回 **201**（不是 200），判断只看 `data.token`，否则会静默跳过建种子；
- 资产 `platform` 要传 **pk**（`/api/v1/assets/platforms/` 里 `name === 'Linux'` 的 `id`），传字符串会 400；
- **“系统用户”模型已并入 accounts**：`/api/v1/assets/system-users/` 现在 404，账号直接用
  `/api/v1/accounts/accounts/`（`asset` + `username` + `secret_type` + `secret`）；
- 资产授权里用 **`accounts: [用户名]`**，不再是 `system_users: [id]`；
- 账号的 `secret` 可能为空（KoKo 连资产时会退化成提示 `password:`）→ 脚本每次都 PATCH 补齐；
- 只想重跑种子数据（不等容器/迁移）：`node dev/jumpserver/setup.mjs --seed-only`。

### `npm run dev:jms` 到底做了什么

1. `GET http://127.0.0.1:8080/api/health/` 检查容器是否就绪（没起会提示先跑 `setup.mjs`，加 `--up` 可自动代跑）；
2. 把 `{ baseUrl, sshHost:127.0.0.1, sshPort:2222, account:polaris, password }` 写进
   数据目录的 `jms-servers.json` —— 渲染层启动时读它还**自动静默重登 + 拉资产**，不用每次手填；
3. 用 `POLARIS_NO_MOCK=1` 起 `electron . --dev`。**必须关 mock**：mock 默认也占 `8080/2222`，
   和 `jms_web` / `jms_koko` 撞端口（撞上时 mock 会自己跳过，但日志噪音大、H3C mock 资源也用不了）。

常用参数：`--dir=<数据目录>`（默认 `<repo>/.polaris-data`）、`--no-launch`（只写配置）、
`--account= / --password= / --url= / --koko-port=`。

起来后：左侧会话列表「🛡 堡垒机」下直接有 `dev-target-01`，双击即经 KoKo 网关连进去。

### 排查

| 现象 | 处理 |
|---|---|
| `8080 不可用` | `node dev/jumpserver/setup.mjs`；或 `docker compose -f dev/jumpserver/docker-compose.yml --profile target up -d` |
| 资产列表空 / 登录失败 | `docker exec -it jms_postgresql psql -U postgres -d jumpserver -c 'select name from assets_asset'` 看种子资产在不在 |
| 连资产卡住 | `docker logs --tail 50 jms_koko`；`docker network inspect jumpserver_net` 确认 `jms_target` 在网里 |
| 想清库重装 | `node dev/jumpserver/setup.mjs --reset`（会 `down -v` 并清 `dev/jumpserver/data`） |

> `dev/jumpserver/data/`、`.env`、`config/` 都是本机生成物（含口令），**不要提交**。
> 容器统一归在 Docker Desktop 的 `jumpserver` 组里（compose 工程名 `name: jumpserver`）。

