# Polaris v1.0.24 — WinSCP 的两个硬伤修掉了（起始目录必须绝对路径 + 默认不写含口令的日志）

用现场日志（Windows，WinSCP 6.7.1 / Win11）把「错误码 4 / General failure」的真凶钉死了。

## 一、起始目录必须是绝对路径

同一台机器、同一版本的三份 WinSCP 会话日志对照：

| 日志 | argv | 结果 |
|---|---|---|
| 第 1 份 | 带 `RemoteDirectory=/root` | ✅ `OPENDIR /root → READDIR → Status code: 1`（读完） |
| 第 2 份 | 带 `RemoteDirectory=/root` | ✅ 同上 |
| 第 3 份 | **没有** `RemoteDirectory` | ❌ `SSH_FXP_OPENDIR "."` → `Status code: 4, Server: General failure` |

也就是说 `SFTPRealPath=off`（v1.0.16 起默认）之后，**唯一还会翻车的就是「起始目录是相对路径 `.`」**：
服务器（`sshd-core 1.7.0 / Apache MINA`）不认 cwd，对 `"."` 直接回 4。

**改动**：只要可能，就给 WinSCP 一个**绝对**起始目录。

- 已知：SFTP 面板当前目录 > 标签自己的 `sftpPath` > 终端里跟踪到的 `shellCwd`；
- 未知：**主进程当场探一次家目录**（`sftp:home` 的核心抽成 `resolveSftpHome()`：exec `pwd` →
  SFTP `readdir` 校验 → 不可访问回退 `/tmp`，和 SFTP 面板同一套逻辑），归一成绝对路径再当 `RemoteDirectory`；
- 连探都失败（连接已断）：才回到「不传」的老行为——绝不因此不给用户开 WinSCP。

## 二、WinSCP 日志默认关闭（它把明文口令写进去了）

v1.0.21 起为了让「到底哪个请求被拒」有证据，默认给 WinSCP 加 `/log=… /loglevel=1`。实测这行日志：

```
Parameter: sftp://root:OTP%3AtirPq3FdQN6n@host:22/
```

`Parameter:` 是**明文会话 URL**（口令 URL 解码后原样出现）。也就是说默认开着 = 把口令写进
`<数据目录>/logs/winscp-*.log`。默认落盘不可接受，改成**默认关闭**：

| 环境变量 | 日志 | 级别 | 含口令 |
|---|---|---|---|
| （不设） | 不写 | — | — |
| `POLARIS_WINSCP_LOG=1` | 写 | 1（请求级） | **是** |
| `POLARIS_WINSCP_DEBUG=1` | 写 | `*`（全协议包，含文件内容） | **是** |

要排障就显式开，共享日志文件前先删掉。拉起日志里会写清当前状态：
`日志=关闭（要开日志设 POLARIS_WINSCP_LOG=1）`。

## 三、背景：WinSCP 与内置面板的宽容度不一样

现场另一条日志值得记下来：

```
[SFTP] 独立 SFTP 探测失败(General failure),回退主连接
[SFTP] SFTP 回退主连接成功 … readdir 完成 {"path":"/root","count":20}
```

同一个设备：**新建连接的 SFTP 子系统**被拒，**已登录会话里的 SFTP 通道**却能用。WinSCP 永远是新建连接，
所以它在「相对路径 / 不支持的请求」上比内置面板脆弱得多。内置面板能用 ≠ WinSCP 一定能用，反之亦然。

## 四、如果还进不去

1. 先确认 `调试 → 下载完整日志` 里 `[WINSCP]` 那行的 `rawsettings`：
   应有 `SFTPRealPath=off` 与 `RemoteDirectory=/…`（绝对路径）；
2. 想自己试 WinSCP 开关：`set POLARIS_WINSCP_RAWSETTINGS=…`（叠加在默认值上，同名覆盖）；
3. 终极退路：**设置 → SFTP → WinSCP 协议 = SCP**。SCP 走服务器上的 `scp` 命令，连 `OPENDIR` 都不发
   （代价：无远端改名/复制、列目录靠 `ls -l` 解析，大目录慢）；
4. 不想折腾：设置 → SFTP → 模式「内置面板」，日常传文件照旧。

## 五、升级注意

- 旧版默认生成的 `logs/winscp-*.log` **可能含明文口令**，请删掉；不放心就把该主机的口令改一次。
- v1.0.24 之后默认不再生成这类日志文件；要排障再开 `POLARIS_WINSCP_LOG=1`。
- 其余行为不变（默认仍是「点 SFTP 开内置面板 + 工具栏「🪟 WinSCP」按钮」）。

回归：`verify-winscp-args` **39/39**、`verify-winscp-open` **46/46**、`run-verify --pure` **17/17 脚本 344 断言**。
