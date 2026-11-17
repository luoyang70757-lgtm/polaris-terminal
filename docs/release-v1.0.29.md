# Polaris v1.0.29（2026-11-17）

> 主题：**把「跳板机」这条线补完整** —— `~/.ssh/config` 里的 `ProxyJump` 真正导进来；JumpServer 登录态不再靠「token 存在就当有效」；顺手把三个长期红灯用例查清（其中一条是真 bug：输入法残留会把命令行改坏）。

## 1. `~/.ssh/config` 的 `ProxyJump` / `ProxyCommand` 导入

以前从 `~/.ssh/config` 导入主机，**`ProxyJump` 被直接无视**——导入完直接连内网资产必然超时，用户只会以为是「Polaris 的跳板机功能坏了」。

现在 `lib/ssh-config.js` 新增两个纯函数：

| 写法 | 解析结果 |
|---|---|
| `ProxyJump ops@gw.example:2222` | jump = `{host:'gw.example', port:2222, username:'ops'}` |
| `ProxyJump ssh://ops@gw.example:2200/` | 同上，端口取 2200 |
| `ProxyJump gw.example` | 端口 22，用户名沿用目标账号（连接时缺省填充） |
| `ProxyJump none` | 明确不使用跳板 |
| `ProxyCommand ssh -p 2222 ops@gw.example -W %h:%p` | 端口 2222，跳板 `gw.example`/`ops` |
| `ProxyCommand nc gw.example 2222` | 同上（`nc`/`netcat`/`ncat` 都认） |

规则与 OpenSSH 对齐：**`ProxyJump` 优先于 `ProxyCommand`**；`Host *` 的全局默认照旧继承。

**认不出来的写法绝不静默丢跳板**（这点很关键——静默丢跳板 = 连不上还没线索）：

- 多跳 `ProxyJump a,b`（A→B→C）→ 主机照常导入，带 `warn: '多跳跳板机(A→B→C)暂不支持'`
- `ProxyCommand` 里只剩 `%h/%p`（没有可推断的跳板主机）→ `warn`
- 不认识的工具（既不是 `ssh` 也不是 `nc`）→ `warn`

`warn` 会显示在**导入预览**里（`⚠ <名称>: <原因>`，最多 8 条），提醒「连接前请手动填写跳板机」。

同时修了 `sessions:import` 的一个坑：`jump` 是对象直接 bind 会报 `cannot bind object`，现在统一 `packJump()` 打包；`packJump` 对**已是 JSON 串**的输入幂等（反复导入 / 覆盖更新不会双重编码）。

## 2. JumpServer 登录态加固

- **token 过期判定**：登录响应的 `date_expired` 一路透传到渲染层（`lib/jms-api.js`、`main.js`），`jmsTokenValid()` 按 **5 分钟余量**（`JMS_TOKEN_MARGIN_MS`）判定，不会在「token 恰好过期那一刻」才打到网关报错。
- **写 token 只有一条路**：全部收敛到 `jmsApplyLogin()`（回归脚本里有「禁止绕过它直接赋 token」的源码断言），漏掉 `tokenExpiredAt` 的情况不会再有。
- **别把网络抖动当登录失效**：拉资产/刷新失败只有 `jmsAuthError()`（401 / 403 / token 过期 / 未登录）为真时才强制重登；超时、连接被拒绝、网关 5xx 不再把人踢回登录框。
- **登录单飞**：`jmsLoginOnce()` + 模块级 `jmsLoginInflight`，把「资产轮询 + 手动点资产 + 批量连接」同时触发的登录合并成**一次**。对 JumpServer 的「密码错 8 次锁 30 分钟」是硬保护——一次误操作原本要扣 2~3 次额度。

## 3. 三个红灯用例查清（其中一个是真 bug）

| 脚本 | 结论 |
|---|---|
| `verify-debug-log.js` | 假红：**新手引导的弹窗开着**。产品行为正确（弹窗打开时按键一律归弹窗输入框），所以 `KEY` 日志不会出现；测试没先关引导。现在 **9/9**。 |
| `verify-space-composition-flush.js` | B **真 bug**：xterm 有时不认为自己在组合（`isComposing=false`），但隐藏 textarea 留着上次 preedit（`" T"`），敲空格时被一起发给服务器 → 命令行被改成 `df -Th T`。现在空格前**无条件丢弃非组合态残留**。C 假红：非焦点窗口里 Chromium 把后台定时器节流到 ~1s，断言只等 450ms → 改成轮询。现在 **6/6**。 |
| `verify-vim-real.js` | 假红：Chromium 的 `Input.dispatchMouseEvent` 右键不派发 DOM `contextmenu`。测试改成在 `.term-pane` 上合成 `contextmenu`，走的仍是产品同一条监听器（右键 → 菜单 → 粘贴 → 焦点回终端整条链路照旧验证）。现在 **5/5**。 |

`docs/verify-known-red.md` 已改写为「历史记录 + 以后怎么查」，套件里不再有红灯。

## 4. 回归

```
node run-verify.js --pure   → 12/12 脚本，314 断言
```

| 脚本 | 断言 |
|---|---|
| `verify-ssh-config.js` | 16 → **41**（ProxyJump 6 / ProxyCommand 3 / warn 5 / 优先级 2 / Host* 继承 / jump+私钥共存 / 导出契约 / 源码接线） |
| `verify-ssh-config-import.js` | 20 → **23**（含多跳 `warn` 与预览文案） |
| `verify-jms-auth-guard.js` | 31 → **50**（token 有效期 9 / 登录单飞 3 / 错误分类 2 + 4 条接线） |
| `verify-debug-log.js` | **9/9** |
| `verify-space-composition-flush.js` | **6/6** |
| `verify-vim-real.js` | **5/5** |
| 其余（`bastion-*` / `jumps*` / `winscp-*` / `groups-*` / `ui-layout`） | 无退化 |

## 5. 仍未覆盖（下一批）

- Telnet 走跳板（`lib/telnet-client.js`），~0.5d
- 多跳 A→B→C（`lib/jump-host.js` 目前单跳写死），~1d
- 隧道持久化、主会话 `-hostkey` 钉死
