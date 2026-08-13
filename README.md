# Polaris — SSH/SFTP 终端

> 技术栈:Electron 43 + xterm.js + ssh2 + SQLite(node:sqlite 内置)
> 会话数据存本地 SQLite(整库 AES-256-GCM 加密),密码走系统 safeStorage 加密。

## 功能特性

**会话管理**
- 会话增删改查、分组、标签颜色、模糊搜索
- 批量导入主机(CSV / Excel)
- 快捷连接(输入 `user@host[:port]` 临时直连,不保存会话)
- 登录宏:连接后自动发送一组命令

**连接与认证**
- 密码 / 私钥(passphrase)/ keyboard-interactive(域认证、OTP、双密码自动应答或弹窗询问)
- 跳板机(SSH 代理,等价 `ssh -J`):目标经跳板 forwardOut 隧道直连,目标认证用用户自己的账号;跳板机指纹同样校验
- 主机指纹校验(known_hosts:首次信任 / 变更拒绝防中间人)

**终端**
- 多标签、垂直/横向分屏、广播模式(输入同步到全部会话)
- 命令历史、危险命令生产环境确认、复制/粘贴、搜索、主题/字体切换、GBK/GB2312 编码

**文件与运维**
- SFTP:浏览、上传/下载(支持断点续传,中断后重试自动续传)、新建/删除、远程文本编辑、全选批量操作
- SSH 隧道:本地端口转发 + 动态 SOCKS
- 批量执行(连上即跑一条命令取回输出)
- 快速命令收藏(一键发送 / 批量下发)

**录制与审计**
- 会话录制(JSONL,停止时自动压缩为 .jsonl.gz)与回放,逐键还原操作过程
- 会话日志:每个连接落盘为可读纯文本(工具 → 打开会话日志目录),自动剥离 ANSI
- 堡垒机:内置 H3C / JumpServer Web 面板、资产捕获(会话列表直接双击资产)、`accessclient://` 免交互连接(面板为 Electron `<webview>` 嵌入)

**AI 运维助手**
- 侧边 AI 面板,基于当前会话上下文提问/执行,可配置模型

## 安全设计

- 密码/私钥口令:safeStorage 加密入库;跳板机密码同样加密
- 数据库:整库 AES-256-GCM,解锁密码派生密钥
- 启动锁屏 + 手动锁定,密码可改
- 主机指纹校验、生产环境分组标记 + 危险命令确认
- 渲染层 contextBridge 白名单 IPC,无 `nodeIntegration`

## 运行方式

```bash
npm install          # 首次
npm run dev          # 开发模式(自动拉起 mock SSH 服务器)
# 无真实服务器时用 mock:主机 127.0.0.1 / 端口 2222 / admin / admin123
# 有真实服务器时直接填真实 IP/账号/密码;配跳板机时在会话里填跳板地址
```

## 代码结构

```
├── main.js               # 主进程:IPC、SSH 连接池、跳板隧道、SQLite、录制/日志
├── preload.js            # 渲染进程安全桥(contextBridge)
├── lib/
│   ├── ssh-client.js     # SSH/SFTP/exec 封装(ssh2),支持 sock 透传(跳板)
│   ├── session-store.js  # SQLite 会话存储(分组/颜色/登录宏/跳板字段)
│   ├── known-hosts.js    # 主机指纹校验
│   ├── app-lock.js       # 启动锁屏 + 数据库目录
│   ├── crypto.js         # 密码 safeStorage 加密
│   ├── db-crypto.js      # 整库 AES-256-GCM 加密
│   ├── recorder.js       # 会话录制(JSONL)
│   ├── session-log.js    # 会话日志(可读文本 + ANSI 剥离)
│   ├── tunnel.js         # 本地端口转发 / 动态 SOCKS
│   ├── jms-api.js        # JumpServer API(登录/资产)
│   ├── dangerous.js      # 生产环境危险命令清单
│   └── ai-stream.js      # AI 助手流式输出
├── src/
│   ├── index.html        # 界面(会话列表/终端/堡垒机/SFTP/AI)
│   ├── renderer.js       # 渲染逻辑
│   └── styles.css        # 深色主题
├── mock/
│   ├── mock-server.js    # mock SSH/HTTP/堡垒机服务器(开发模式自动拉起,演示用)
│   └── fake-shell.js     # 假资产 shell
```

> 内部端到端回归套件(mock SSH + CDP 驱动)与真实环境凭据不入库,仅保留在本地开发目录。

## 已知局限

- SFTP 断点续传记录在会话内存中:应用重启后中断点重置,续传退化为全量重传(不产生错误数据)
- 堡垒机面板为 Electron `<webview>`(guest view)嵌入,受宿主层叠顺序限制,已在分隔条拖动与锁屏时显式隐藏
