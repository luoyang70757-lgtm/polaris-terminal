'use strict';
/**
 * ai-stream.js — 流式调用大模型 API(SSE 解析)
 * 支持 Anthropic 格式和 OpenAI 兼容格式,边生成边通过 onEvent 回调把事件推给调用方。
 * 独立成模块:方便单测(本地 mock SSE 服务器即可验证解析)。
 */

const AI_SYSTEM_PROMPT = `你是一个内嵌在 SSH 终端工具里的服务器运维助手。
用户会告诉你当前选中的主机(可能是一台或多台)。你有 run_command 工具,可以在这些主机上执行 shell 命令并立即获得输出;命令会在所有选中的主机上执行,输出按 [主机IP] 开头标注是哪台的。
要求:
- 回答简洁,用中文;
- 优先用 run_command 工具确认实际情况(查磁盘、内存、进程、日志等)再回答,不要凭空猜;
- 多台主机时注意对比各台的差异;
- 涉及危险操作(删除、关机、格式化等)要先提醒用户并说明命令作用;
- 命令不要交互式(vim/less 等),要能一次执行完;
- 用户要求"清屏/清除屏幕"时,必须调用 clear_screen 工具来清除本地终端显示。绝不只在文字里说"已清屏"——不调用工具,屏幕就不会真的被清除;也不要试图在服务器上执行命令来清屏。`;

// run_command 工具定义(Anthropic / OpenAI 两种格式)
const AI_TOOL_ANTHROPIC = {
  name: 'run_command',
  description: '在当前连接的主机上执行一条 shell 命令并返回输出,用于诊断和操作服务器。',
  input_schema: {
    type: 'object',
    properties: { command: { type: 'string', description: '要执行的 shell 命令' } },
    required: ['command'],
  },
};
const AI_TOOL_OPENAI = {
  type: 'function',
  function: {
    name: 'run_command',
    description: '在当前连接的主机上执行一条 shell 命令并返回输出,用于诊断和操作服务器。',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string', description: '要执行的 shell 命令' } },
      required: ['command'],
    },
  },
};
// 清屏工具:清除本地终端的显示(不执行服务器命令),当用户要求"清屏/清除屏幕/clear"时调用。
const AI_TOOL_CLEAR_ANTHROPIC = {
  name: 'clear_screen',
  description: '清除本地终端显示屏幕(不执行任何服务器命令)。用户说"清屏/清除屏幕/clear 一下"时调用。',
  input_schema: { type: 'object', properties: {} },
};
const AI_TOOL_CLEAR_OPENAI = {
  type: 'function',
  function: {
    name: 'clear_screen',
    description: '清除本地终端显示屏幕(不执行任何服务器命令)。用户说"清屏/清除屏幕/clear 一下"时调用。',
    parameters: { type: 'object', properties: {} },
  },
};

// use_skill 工具:按名称加载一个已启用的运维技能(参考 Chaterm)。
// 技能清单在系统提示的 "AVAILABLE SKILLS" 段落里,代理先看清单再决定加载哪个。
const AI_TOOL_USE_ANTHROPIC = {
  name: 'use_skill',
  description: '加载并激活一个运维技能。技能是可复用的指令集(如"部署 docker 应用""排查磁盘占用"),按名称从 AVAILABLE SKILLS 清单中选择。加载后严格按技能内容执行。',
  input_schema: {
    type: 'object',
    properties: { name: { type: 'string', description: '技能名,必须与 AVAILABLE SKILLS 清单中的名字完全一致' } },
    required: ['name'],
  },
};
const AI_TOOL_USE_OPENAI = {
  type: 'function',
  function: {
    name: 'use_skill',
    description: '加载并激活一个运维技能。技能是可复用的指令集(如"部署 docker 应用""排查磁盘占用"),按名称从 AVAILABLE SKILLS 清单中选择。加载后严格按技能内容执行。',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: '技能名,必须与 AVAILABLE SKILLS 清单中的名字完全一致' } },
      required: ['name'],
    },
  },
};

// summarize_to_skill 工具:把当前对话沉淀为可复用技能(写操作需用户确认)。
const AI_TOOL_SUMMARIZE_ANTHROPIC = {
  name: 'summarize_to_skill',
  description: '把当前对话中体现的可复用运维流程沉淀成一个新技能,供以后遇到类似任务时调用。需要用户确认才会真正保存。',
  input_schema: {
    type: 'object',
    properties: {
      skill_name: { type: 'string', description: '技能名:小写字母/数字/连字符,如 deploy-docker-app' },
      description: { type: 'string', description: '一行描述:这个技能做什么、何时用' },
      content: { type: 'string', description: '技能正文(Markdown):清晰的步骤、命令、配置模板' },
    },
    required: ['skill_name', 'description', 'content'],
  },
};
const AI_TOOL_SUMMARIZE_OPENAI = {
  type: 'function',
  function: {
    name: 'summarize_to_skill',
    description: '把当前对话中体现的可复用运维流程沉淀成一个新技能,供以后遇到类似任务时调用。需要用户确认才会真正保存。',
    parameters: {
      type: 'object',
      properties: {
        skill_name: { type: 'string', description: '技能名:小写字母/数字/连字符,如 deploy-docker-app' },
        description: { type: 'string', description: '一行描述:这个技能做什么、何时用' },
        content: { type: 'string', description: '技能正文(Markdown):清晰的步骤、命令、配置模板' },
      },
      required: ['skill_name', 'description', 'content'],
    },
  },
};

// 规范化接口地址:填 base_url 或完整地址都行,自动补全对应路径
//   Anthropic 格式: base + /v1/messages   (官方 base 如 https://api.deepseek.com/anthropic)
//   OpenAI 格式:   base + /chat/completions (官方 base 如 https://api.deepseek.com)
function normalizeAiUrl(url, format) {
  let base = String(url || '').trim().replace(/\/+$/, '');
  if (!base) base = format === 'openai' ? 'https://api.openai.com/v1/chat/completions' : 'https://api.anthropic.com/v1/messages';
  if (format === 'openai') {
    return /chat\/completions$/.test(base) ? base : `${base}/chat/completions`;
  }
  return /v1\/messages$/.test(base) ? base : `${base}/v1/messages`;
}

// 流式调用一次 AI(SSE):边生成边通过 onEvent 把文本/工具动作推给界面。
// onEvent 事件: { type:'text', delta } / { type:'tool_start' }
// opts 可选: { systemPrompt, tools } — 覆盖默认系统提示 / 工具列表(技能系统用)
// 返回 { text, toolUses, assistantMsg, error }
async function callAiStream(base, mdl, format, apiKey, messages, onEvent, opts) {
  const systemPrompt = (opts && opts.systemPrompt) || AI_SYSTEM_PROMPT;
  const tools = (opts && opts.tools) || [AI_TOOL_OPENAI, AI_TOOL_CLEAR_OPENAI, AI_TOOL_USE_OPENAI, AI_TOOL_SUMMARIZE_OPENAI];
  const toolsAn = (opts && opts.tools) || [AI_TOOL_ANTHROPIC, AI_TOOL_CLEAR_ANTHROPIC, AI_TOOL_USE_ANTHROPIC, AI_TOOL_SUMMARIZE_ANTHROPIC];
  let headers, body;
  if (format === 'openai') {
    headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` };
    body = {
      model: mdl, max_tokens: 2048, stream: true,
      messages: [{ role: 'system', content: systemPrompt }, ...messages],
      tools,
    };
  } else {
    headers = { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
    body = { model: mdl, max_tokens: 2048, stream: true, system: systemPrompt, messages, tools: toolsAn };
  }
  // 加超时兜底:AI 接口(或中间代理)挂起不返回时,fetch 会永久等待 → 主进程 agent 循环
  // 卡在 await reader.read(),"停止"按钮也救不回来(旧版无超时无 abort)。
  // 正常流式响应可能持续较久,超时给足 5 分钟;超时/abort 后返回错误而非挂死。
  const controller = new AbortController();
  const aiTimer = setTimeout(() => controller.abort(), 5 * 60 * 1000);
  let res;
  try {
    res = await fetch(base, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });
  } catch (err) {
    clearTimeout(aiTimer);
    const aborted = err && (err.name === 'AbortError' || err.name === 'TimeoutError');
    return { error: aborted ? 'AI 请求超时(5 分钟无响应)' : `网络错误: ${err && err.message ? err.message : String(err)}` };
  }
  clearTimeout(aiTimer);
  if (!res.ok) {
    const raw = await res.text();
    let data = null; try { data = JSON.parse(raw); } catch { /* 不是 JSON */ }
    const msg = data && data.error && data.error.message ? data.error.message : (raw ? raw.slice(0, 200) : '空响应');
    return { error: `HTTP ${res.status}: ${msg}` };
  }
  if (!res.body) return { error: '空响应(接口可能不支持流式)' };

  const toolUses = [];
  const textParts = [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let oaiToolCalls = []; // OpenAI:index -> { id, name, args }
  let anBlocks = {};     // Anthropic:index -> { type, text, id, name, inputJson }

  const handleEvent = (evt) => {
    if (format === 'openai') {
      const delta = evt.choices && evt.choices[0] && evt.choices[0].delta;
      if (!delta) return;
      if (delta.content) { textParts.push(delta.content); onEvent && onEvent({ type: 'text', delta: delta.content }); }
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index || 0;
          let slot = oaiToolCalls[idx] || (oaiToolCalls[idx] = { id: '', name: '', args: '' });
          if (tc.id) slot.id = tc.id;
          if (tc.function) {
            if (tc.function.name) { slot.name += tc.function.name; if (!slot._started) { slot._started = true; onEvent && onEvent({ type: 'tool_start' }); } }
            if (tc.function.arguments) slot.args += tc.function.arguments;
          }
        }
      }
    } else {
      if (evt.type === 'content_block_start') {
        const cb = evt.content_block || {};
        anBlocks[evt.index] = { type: cb.type || 'text', text: '', id: cb.id || '', name: cb.name || '', inputJson: '' };
        if (cb.type === 'tool_use') onEvent && onEvent({ type: 'tool_start' });
      } else if (evt.type === 'content_block_delta') {
        const d = evt.delta || {};
        const b = anBlocks[evt.index];
        if (!b) return;
        if (d.type === 'text_delta' && d.text) { b.text += d.text; textParts.push(d.text); onEvent && onEvent({ type: 'text', delta: d.text }); }
        else if (d.type === 'input_json_delta' && d.partial_json) b.inputJson += d.partial_json;
      }
    }
  };

  while (true) {
    // 读循环也要响应 abort:流中途挂死时 controller.abort() 会让 reader.read() reject,
    // 不 catch 的话整个 agent 循环永久卡死(与"停止"按钮配合,超时后能真正中断)
    let r;
    try {
      r = await reader.read();
    } catch (err) {
      const aborted = err && (err.name === 'AbortError' || err.name === 'TimeoutError');
      return { error: aborted ? 'AI 流中断(超时)' : `流读取错误: ${err && err.message ? err.message : String(err)}` };
    }
    const { done, value } = r;
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line.startsWith('data:')) {
        const jsonStr = line.slice(5).trim();
        if (!jsonStr || jsonStr === '[DONE]') continue;
        try { handleEvent(JSON.parse(jsonStr)); } catch { /* 坏行跳过 */ }
      }
    }
  }
  if (buf.trim().startsWith('data:')) {
    try { handleEvent(JSON.parse(buf.trim().slice(5).trim())); } catch { /* ignore */ }
  }

  const text = textParts.join('');
  if (format === 'openai') {
    for (const slot of oaiToolCalls) {
      if (slot && slot.name) {
        let input = {}; try { input = JSON.parse(slot.args || '{}'); } catch { /* 参数不完整 */ }
        toolUses.push({ id: slot.id, name: slot.name, input });
      }
    }
    const toolCalls = oaiToolCalls.filter((s) => s && s.name).map((s) => ({ id: s.id, type: 'function', function: { name: s.name, arguments: s.args || '{}' } }));
    return { text, toolUses, assistantMsg: { role: 'assistant', content: text, tool_calls: toolCalls } };
  }
  const content = [];
  for (const b of Object.values(anBlocks)) {
    if (!b) continue;
    if (b.type === 'text') { if (b.text) content.push({ type: 'text', text: b.text }); }
    else if (b.type === 'tool_use') {
      let input = {}; try { input = JSON.parse(b.inputJson || '{}'); } catch { /* 参数不完整 */ }
      content.push({ type: 'tool_use', id: b.id, name: b.name, input });
      toolUses.push({ id: b.id, name: b.name, input });
    }
  }
  if (!content.length && text) content.push({ type: 'text', text });
  return { text, toolUses, assistantMsg: { role: 'assistant', content } };
}

module.exports = {
  callAiStream, normalizeAiUrl, AI_SYSTEM_PROMPT,
  AI_TOOL_ANTHROPIC, AI_TOOL_OPENAI,
  AI_TOOL_CLEAR_ANTHROPIC, AI_TOOL_CLEAR_OPENAI,
  AI_TOOL_USE_ANTHROPIC, AI_TOOL_USE_OPENAI,
  AI_TOOL_SUMMARIZE_ANTHROPIC, AI_TOOL_SUMMARIZE_OPENAI,
};
