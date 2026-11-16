## Polaris v1.0.11

### 修「AI 功能用不了」

填了 API Key 也发不出消息，其实是**配置项缺失时被静默兜底**惹的祸：

- 新加的厂商「接口地址」留空 → 请求被悄悄发到官方 `https://api.anthropic.com/v1/messages`，界面只回你一句 `HTTP 401 / 404`；
- 模型下拉为空 → 静默拿 `claude-sonnet-5` 去请求 DeepSeek，直接 `HTTP 400: model not supported`。

现在：

- **发消息前先校验**：地址/模型没配就直接告诉你「去 ⚙ 填接口地址 / 选模型」，并自动把配置面板弹出来，不再发无效请求；
- **⚙ 新增「快速模板」**：DeepSeek / OpenAI / 通义千问（DashScope）/ 智谱 GLM / Moonshot Kimi / Anthropic / OpenRouter，选中即填好接口地址、协议格式、模型名（DeepSeek 模板已实测跑通），你只需粘上 Key 点保存；
- **「＋ 新增厂商」默认就是能跑通的 DeepSeek 配置**（`https://api.deepseek.com/anthropic` + `deepseek-v4-flash / deepseek-v4-pro`），不再是一张白纸；
- **错误信息说人话**：401/403 → API Key 无效或没权限；402 → 余额不足或被限流；404 → 接口地址或模型名不对（常见是漏填 `/v1`）；429 → 请求太频繁；5xx → 服务端错误。每条都指向该改哪个输入框。

### 工具栏「调试」移进菜单栏

工具栏少一个按钮，调试入口改到 macOS 菜单栏「调试」（紧跟「帮助」）：

- 终端调试日志（开/关）— ⌘⇧D，快捷键和 ⌘K 命令面板入口都不变
- ⬇ 下载完整日志…
- 打开日志目录
- 清空调试日志

### 回归

- 新增 `verify-ai-config.js`（10 条）：错误码提示映射、新增厂商默认配置、快速模板落盘与复位、地址/模型缺失的可读报错、发送前校验并展开 ⚙、Key 密文入库可解密，另附可选真实 Key 连通性实测（`POLARIS_AI_KEY=sk-…`）。
- `run-verify --pure` 12/12 脚本 103 断言全绿。
