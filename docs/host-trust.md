# 主机指纹信任（known_hosts）与「总是弹『信任并连接』」排查

## 默认行为

- 首次连接某台主机（按 `host:port` 记）弹一次「首次连接」，选项三个：
  1. **信任并连接**：记录指纹，以后这台主机不再问；
  2. **信任并记住所有主机**：记录指纹 **并打开设置里的「自动信任新主机密钥」**，以后连任何新主机都不再问（仍记录、仍校验）；
  3. **拒绝**：不连、不记录。
- 已记录过的主机：指纹一致直接连；**指纹变了**会弹红色「安全警告 · 主机密钥不匹配」并断开（防中间人），旧指纹不会被覆盖。
- 指纹存在**数据目录**下的 `known_hosts.json`（默认 `~/.jms-terminal/known_hosts.json`，权限 0600；用 `POLARIS_LOCK_DIR` 时在该目录）。

## 仍然每次都弹？按这三类查

### 1. 每次连的其实是"不同主机"（最常见）

指纹键是 `host:port`，下面这些都会被当成不同主机、各弹一次：

- 同一台机器有时用 hostname（`web01`）、有时用域名（`web01.corp.example`）、有时用 IP；
- 堡垒机 / 网关在内网有多个地址（VIP、主备节点），会话配置里地址不同；
- 同一台机器的两个端口（如 SSH 22 与网关 2222）各算一条。

**处理**：会话尽量统一使用同一个地址写法；或直接选「信任并记住所有主机」。

### 2. 指纹没写进去（数据目录不可写 / 被清空）

- v1.0.7 起，写入失败会**在状态栏红字提示**：`<主机> 的指纹没能保存到 <路径> → 下次连接仍会询问(检查目录是否可写)`，
  同时主进程日志里有 `[known-hosts] 指纹写入失败(...)`。
- 数据目录不可写时程序会**回退到临时目录**（`$TMPDIR/jms-terminal/known_hosts.json`），临时目录被系统清理后就要重新信任。
- 自查：

  ```bash
  ls -l ~/.jms-terminal/known_hosts.json          # 是否存在、权限 0600
  cat ~/.jms-terminal/known_hosts.json            # 里面有没有你要连的 host:port
  grep -n "known-hosts\|自动信任新主机" ~/.jms-terminal/logs/app-*.log | tail
  ```

### 3. 服务器有多个主机密钥、每次协商到的不同

集群 / 负载均衡后面每台机器各有一把主机密钥时，客户端可能这次走 A 节点、下次走 B 节点，
表现为「主机密钥不匹配 · 安全警告」（不是「首次连接」）。这时不要盲目点信任：
把各节点指纹都用 `ssh-keyscan` 对齐，或让网关统一密钥；确认无误后再清掉对应条目重连。

## 彻底不弹的两条路

1. 下次弹窗时点 **「信任并记住所有主机」**（一次性，立即生效，无需重启）；
2. 设置 → 「自动信任新主机密钥」勾上（等价于上面）；命令行/无界面运行时也可直接编辑
   `~/.jms-terminal/known_hosts.json` 预先写入已知指纹。

> 安全说明：自动信任**只是跳过询问**，仍然会写指纹并逐次校验；指纹变化照样「安全警告 + 断开」。
> 因此建议只在可信内网使用。

## 相关代码

| 位置 | 作用 |
|---|---|
| `lib/connect-opts.js` `makeHostVerifier()` | 弹窗/校验/自动信任；新主机三按钮，写入失败回调 `onPersistFail` |
| `lib/known-hosts.js` | `set()` 返回是否真的落盘（写后回读校验）+ `location()` 给出文件路径 |
| `main.js` `connectOpts.init({onTrustAll,onPersistFail})` | 广播 `settings:trustAll` / `settings:trustPersistFail` 给渲染层 |
| `src/renderer.js` `window.api.onTrustAll` | 打开 `settings.autoTrustHostKey` 并落盘、状态栏提示 |
| `verify-host-trust.js` | 23 条断言：三按钮、第二次不弹、记住所有、自动信任、指纹不一致、写盘失败提示 |
