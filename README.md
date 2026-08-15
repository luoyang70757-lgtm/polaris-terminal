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
- 主机指纹校验(known_hosts:首次信任 / 变更拒绝防中间人;设置里可开「自动信任新主机密钥」跳过首次弹窗,适合可信内网)

**终端**
- 多标签、垂直/横向分屏、广播模式(输入同步到全部会话)
- 命令历史、危险命令生产环境确认、复制/粘贴、搜索、主题/字体切换、GBK/GB2312 编码
- **智能命令推荐(参考 Chaterm)**:工具栏「✨ 推荐」下拉,基于当前主机的历史高频命令 + 内置常用运维命令库(磁盘/内存/日志/端口/容器…),点击即发送到当前终端;无连接会话时给出全局常用命令兜底
- **AI 命令推荐(参考 Chaterm)**:推荐下拉顶部「🤖 AI 推荐」,让模型结合当前主机的历史命令与终端最近输出,推荐一条下一条要执行的命令(输出 `{command, reason}`),点击即发送(需在 AI ⚙ 配置 API Key)
- **用户知识库(参考 Chaterm)**:AI 面板 ⚙ →「📚 知识库」导入运维手册/内部文档(.md/.txt 等,存 `<数据目录>/kb/`),本地关键词检索(标题命中优先)预览命中片段;开启「AI 对话时检索知识库」后,每次提问会自动把相关文档片段注入 AI 上下文,让回答/执行参考你的文档

**文件与运维**
- SFTP:浏览、上传/下载(支持断点续传,中断后重试自动续传)、新建/删除、远程文本编辑、全选批量操作
- SFTP 面板**按标签各自的状态**:每个标签独立记忆自己的 SFTP 开关与浏览目录——选中"未打开 SFTP 的标签页"时按钮不亮、面板收起;切回开过的标签自动恢复它的文件列表;左上角连接名下拉可跳转到某台已连接主机的 SFTP
- 堡垒机会话的 SFTP 标签/下拉显示**真实目标主机**(资产 IP,如 `192.168.10.10 · web-server-01(root)`),而非堡垒机网关地址——同一堡垒机的多台主机也能一眼分清 SFTP 是谁的;老会话从 jmsKey/username 自动反推目标主机
- SSH 隧道:本地端口转发 + 动态 SOCKS
- 批量执行(连上即跑一条命令取回输出)
- 快速命令收藏(一键发送 / 批量下发)

**录制与审计**
- 会话录制(JSONL,停止时自动压缩为 .jsonl.gz)与回放,逐键还原操作过程
- 会话日志:每个连接落盘为可读纯文本(工具 → 打开会话日志目录),自动剥离 ANSI
- 堡垒机:内置 H3C / JumpServer Web 面板、资产捕获(会话列表直接双击资产)、`accessclient://` 免交互连接(面板为 Electron `<webview>` 嵌入)

**堡垒机资产(2026-08-14 增强)**
- **全量拉取**:主动调用资产 API 翻页拉取该用户可见的全部主机(不依赖前端页面行为),失败单页重试;诊断包可导出排查"资产不完整"
- **按目录分组**:资产按堡垒机业务目录(如"主机_客户管理系统")分组展示,可折叠;分组后台渐进式补齐
- **收藏夹**:捕获收藏设备接口,⭐ 星标 + 置顶"收藏"分组
- **持久化**:资产缓存进加密 SQLite(`bastion_assets` 表),重启不丢,随整库 AES 加密

**AI 运维助手**
- 侧边 AI 面板,基于当前会话上下文提问/执行,可配置模型
- **Agent Skill 技能库(参考 Chaterm)**:把可复用的运维流程(部署、排查、巡检…)沉淀为技能
  - 技能 = `SKILL.md` 文件,存 `<数据目录>/skills/<技能名>/`,支持新建/编辑/删除/启停/打开目录
  - 启用中的技能自动进入 AI 的 `AVAILABLE SKILLS` 清单,AI 用 `use_skill` 按需加载后严格按技能执行
  - `summarize_to_skill`:AI 可把一段对话沉淀成新技能(保存前弹窗确认)
  - 技能名限小写字母/数字/连字符,防路径穿越

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
│   ├── ai-stream.js      # AI 助手流式输出(SSE 解析 + use_skill/summarize_to_skill 工具)
│   ├── skills.js         # Agent Skill 技能库(SKILL.md 文件管理 + AVAILABLE SKILLS 清单)
│   ├── recommend.js      # 智能命令推荐(历史高频 + 常用运维命令库合并去重)
│   └── kb.js             # 用户知识库(运维文档导入 + 关键词检索 + AI 提示片段)
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
