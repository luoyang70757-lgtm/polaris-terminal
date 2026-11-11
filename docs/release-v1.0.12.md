## Polaris v1.0.12

### DeepSeek 用官方 OpenAI 兼容端点

同一把 DeepSeek Key 有两个可用的官方接口，**端点要和「接口格式」配套**，配错就是 401：

| 接口 | 地址（base_url） | ⚙ 里选「接口格式」 |
|---|---|---|
| OpenAI 兼容（**默认模板**） | `https://api.deepseek.com/v1` | OpenAI 兼容格式 |
| Anthropic 兼容（备选模板） | `https://api.deepseek.com/anthropic` | Anthropic 格式 |

- 「＋ 新增厂商」默认就是上面第一行（`deepseek-v4-flash` / `deepseek-v4-pro`），粘 Key 保存即可用；
- 「快速模板」里两个都在，选错格式也能一键纠正；
- 老配置里地址为空的厂商，升级时**按它当前选的格式**补对应端点，不会拼出 `…/anthropic/chat/completions` 这种 404。

### 顺带

- 「接口地址没填」「模型没选」的提示会直接告诉你该填什么，并自动展开 ⚙（见 v1.0.11）。

### 回归

- `verify-ai-config.js` 11/11（新增 Anthropic 兼容模板断言）；真实 Key 连通性实测走 OpenAI 兼容端点，App 内流式回复正常。
