---
title: "LLM"
---

请求 Demo

```bash
# Anthropic
curl https://api.deepseek.com/anthropic/v1/messages \
  -H "Content-Type: application/json"               \
  -H "X-Api-Key: $ANTHROPIC_API_KEY"                \
  -d '{
    "max_tokens": 1024,
    "model": "deepseek-flash",
    "messages": [
      {
        "role": "user",
        "content": [
          {
            "type": "text",
            "text": "Hello, who are you?"
          }
        ]
      }
    ]
  }'
```

响应 Demo

```json
{
  "id": "<uuid-v4>", // equals to signature
  "type": "message",
  "role": "assistant",
  "model": "deepseek-flash",
  "content": [
    {
      "type": "thinking",
      "thinking": "We need answer user. Need be Claude. But need follow? User asks hello who are you. We respond.",
      "signature": "<uuid-v4>" // equals to id
    },
    {
      "type": "text",
      "text": "Hello! I’m Claude, an AI assistant created by Anthropic. How can I help you today?"
    }
  ],
  "stop_reason": "end_turn",
  "stop_sequence": null,
  "usage": {
    "input_tokens": 89,
    "cache_creation_input_tokens": 0,
    "cache_read_input_tokens": 0,
    "output_tokens": 46,
    "service_tier": "standard"
  }
}
```

- 请求的 messages: 每条 message 有 role 和 content 两个字段, role (API 场景下) 只有两个值: user 和 assistant; messages 数组中, 最好保持 user 和 assistant 两个 role 交替出现; 如果连续传递两条 user 消息, API 不会报错, 会自动合并为一条 user 消息
- LLM 返回一个工具调用 (tool_use) 请求, 这是 assistant 消息; 用户调用工具拿到结果, 该工具调用结果需要作为 user 消息发送; 如果错误的将工具调用结果作为 assistant 消息发送, 则会导致连续两条 assistant 消息, API 会直接报错
- 响应的 content 字段是一个数组: LLM 的响应可能包含多种内容, 每种内容是一个独立的 content block, 类型可能是 text、thinking、tool_use 等
- 流式响应基于 SSE (Server-Sent Events), 本质是 HTTP 长连接

Claude 的流式事件有固定顺序

```txt
message_start 整个响应开始, 携带 input_tokens 输入 token 数、cache_read_input_tokens、cache_creation_input_tokens
  content_block_start 一个内容块开始 (thinking 推理、text 文本或 tool_use 工具调用), 一个响应可能有多个 content_block 内容块
    content_block_delta 内容块的内容增量, delta.type 有 4 种:
      text_delta 文本增量, 每到达一个词, 可以将内容增量提交给 UI 渲染
      thinking_delta 推理增量
      input_json_delta 工具调用参数增量
      signature_delta 签名增量
  content_block_stop 一个内容块结束
message_delta 消息增量 (output_tokens 输出 token 数, stop_reason 停止原因)
message_stop 整个响应结束
```

封装层将 LLM API 的 SSE 事件映射到内部的 StreamEvent (src/llm/events.ts):

```ts
type StreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "thinking_complete"; thinking: string; signature: string }
  | { type: "tool_call_start"; toolName: string; toolId: string }
  | { type: "tool_call_delta"; text: string } // 工具调用参数的 JSON 碎片
  | {
      type: "tool_call_complete";
      toolId: string;
      toolName: string;
      arguments: Record<string, unknown>;
      parseError?: string; // JSON 解析失败时, 参数为空对象 + 错误说明
      providerItemId?: string; // OpenAI computer_call 的 item id, 回传时需要
    }
  | { type: "stream_end"; stopReason: string; usage: UsageInfo };
```

三种协议的事件映射 (Anthropic 为例):

```txt
content_block_delta (text_delta)       -> text_delta
content_block_delta (thinking_delta)   -> thinking_delta
content_block_stop (thinking)          -> thinking_complete
content_block_start (tool_use)         -> tool_call_start
content_block_delta (input_json_delta) -> tool_call_delta
content_block_stop (tool_use)          -> tool_call_complete
message_stop                           -> stream_end
```

流没有正常终止 (Anthropic 未见 message_stop、OpenAI Responses 未见 terminal 事件) 时抛 NetworkError, 不发 stream_end, 防止半截响应被当成完整响应

## 请求的 system, messages, tools

- system 参数存放用户信息和环境信息, 包括: 你是谁、操作系统是什么、工作目录是什么
- messages 参数存放对话历史
- tools 参数存放工具描述

### OpenAI 兼容

OpenAI 没有 prompt cache 的 cache_control, cache_read 通过 `usage.input_tokens_details.cached_tokens` 返回; input_tokens 已含缓存前缀, 封装层减去缓存部分, 保证 4 个计数不重复

## token

token 是 LLM 的计费单位, 每个英文单词约 1-2 个 token, 每个汉字约 1-2 个 token, 具体取决于 LLM 使用的 tokenizer

Claude API 的计费分为

- inputTokens: 未命中 prompt cache 的输入 token 数, 即发送给 LLM 的内容, 即 system prompt, tools 描述和 messages 中未命中 prompt cache 的输入
- outputTokens: 输出 token 数, 即 LLM 生成的内容, 输出 token 比输入 token 贵的多
- cacheReadInputTokens: 命中 prompt cache 的输入 token 数, 价格远低于普通 input_tokens
- cacheCreationInputTokens: 创建 prompt cache 的输入 token 数, 价格略高于普通 input_tokens

### 历史越长、输入越贵

每轮请求, 都需要发送完整的对话历史; 如果和 LLM 聊了 20 轮, 第 21 轮请求会包含前 20 轮的所有消息; input_tokens 会随着对话轮次线形增长, 所以需要上下文压缩

### prompt cache 打点

Anthropic 的 cache_control 打在三个位置 (src/llm/anthropic.ts):

1. system prompt: 单一 text 块, ephemeral
2. tools 数组: 从尾部倒扫, 跳过 defer_loading 的工具 (defer 和 cache 同存会被 API 拒绝), 在最后一个非 deferred 工具上打 ephemeral
3. 最后一条 user 消息的尾部: 最后一个非图片块打 ephemeral (滚动缓存对话前缀)

tools 数组是缓存前缀的第一段, 数组任何变化 (增删工具、schema 变化) 会使整个后续历史缓存失效, 这是 MCP 工具延迟加载策略的动因 (见 mcp)

## Extend Thinking 推理

Claude 支持 Extended Thinking, 让 LLM 回复前先进行内部推理, 开启后响应的 content 数组中会多一个 `type: thinking` 的内容块, 排在 text 内容块的前面; thinking 的 token 计算到 output_tokens 中

包含工具调用的一轮对话, 对话历史中的 thinking 内容块必须携带, 和后面的 tool_result 一起发送给 LLM API, 否则会报错; 对于纯聊天、没有工具调用的场景, 则对话历史中的 thinking 内容块可以不携带, LLM API 会自动忽略

thinking 有两种请求模式 (Anthropic):

- budget (默认): `thinking: { type: "enabled", budget_tokens }`, budget 按思考强度映射, 且和 max_output_tokens 共享上限: `min(THINKING_BUDGETS[level], maxOutputTokens - 1024)`, 始终给回答保留至少 1024 token; max_output_tokens 低于 2048 时不存在合法 budget, thinking 降级为关闭
- adaptive: `thinking: { type: "adaptive" }` + `output_config: { effort }`, 按 effort 而不是 token 预算控制 (minimal 折算为 low, xhigh 折算为 high)

OpenAI 协议 (Responses / Chat Completions) 使用 `reasoning: { effort, summary: "auto" }` / `reasoning_effort` 字段, 思考强度映射到 provider 的 reasoning effort

## 如何封装

ProviderConfig 覆盖主流厂商: Anthropic、OpenAI、OpenAI 兼容层

- name: provider 名称
- protocol: LLM API 协议, 枚举值 "anthropic" | "openai" | "openai-compat"
- base_url: 端点地址, 是 provider 的身份标识, 多个 provider 的 base_url 不得重复
- model: LLM 模型, 例如 claude-haiku-4-6、claude-sonnet-4-6、claude-opus-4-6
- api_key: 令牌 (可选, fallback 到环境变量: anthropic → ANTHROPIC_API_KEY, openai / openai-compat → OPENAI_API_KEY)
- thinking: 思考强度 off | minimal | low | medium | high | xhigh | max (可选, 默认 high)
- reasoning: 显式能力开关 (可选); false 完全关闭推理, 省略则保留 provider 默认; 绝不从模型名推断能力
- thinking_level_map: 逻辑强度到 provider effort 的逐项覆盖 (可选), 映射为 null 表示禁用该级
- thinking_mode: "budget" | "adaptive" (可选, 仅 Anthropic 使用 adaptive)
- context_window: 上下文窗口大小 (可选, 默认 DEFAULT_CONTEXT_WINDOW = 1_000_000)
- max_output_tokens: 最大输出 token 数 (可选, 默认 DEFAULT_MAX_OUTPUT_TOKENS = 128_000, clamp 到不超过 context_window)

思考强度的 token 预算 (THINKING_BUDGETS): minimal 1024, low 2048, medium 8192, high 16384, xhigh 32768, max 65536; openai 协议没有原生的 xhigh/max, 请求时折叠为 high, 除非 thinking_level_map 显式映射

客户端接口 (src/llm/client.ts):

```ts
interface LLMClient {
  readonly protocol?: ToolProtocol;
  stream(
    conversation: ConversationManager,
    toolSchemas: ProviderToolSchema[],
    abortSignal?: AbortSignal,
  ): AsyncGenerator<StreamEvent>;
  setSystemPrompt(prompt: string): void;
  // 可选能力
  setMaxOutputTokens?(maxTokens: number): void; // max_tokens 升级 (agent loop 用)
  setThinkingLevel?(level): ThinkingLevel; // 返回实际生效的级别 (可能被 clamp)
  getThinkingLevel?(): ThinkingLevel;
  getSupportedThinkingLevels?(): readonly ThinkingLevel[];
}
```

`createClient(config, systemPrompt)` 按 protocol 动态 import 对应的实现 (AnthropicClient / OpenAIClient / OpenAICompatClient), 只有配置到的协议 SDK 会被加载

### 模型发现

/model 命令的模型选择器靠模型发现: 将 base_url 归一化后拼 `/models` 端点 (剥掉尾部的 /chat/completions、/responses、/messages 等路径; anthropic 协议要求路径以 /v1 结尾), GET 请求带对应协议的鉴权头 (anthropic-version + x-api-key 或 Bearer), 超时 5s, anthropic 端点支持 has_more/last_id 翻页, 最多 10 页; 任何失败统一报 "Model discovery failed", 选择器回退到手动输入

## 错误分类

统一的错误类型 (src/llm/errors.ts), 两种协议的 classify 函数把 SDK 错误映射到同一组类型:

| 类型                | 触发条件                                                         | agent loop 的反应           |
| ------------------- | ---------------------------------------------------------------- | --------------------------- |
| ContextTooLongError | 413; 或 400 且消息匹配 prompt too long / context_length_exceeded | forceCompact 后重试         |
| RateLimitError      | 429 (携带 retry-after 头)                                        | 可见输出前最多 3 次退避重试 |
| ServerError         | 5xx 服务端错误                                                   | 可见输出前最多 3 次退避重试 |
| NetworkError        | 非 API 错误、流未正常终止                                        | 可见输出前最多 3 次退避重试 |
| AuthenticationError | 401                                                              | 终止, 提示重新登录          |
| LLMError            | 其他 API 错误                                                    | 终止本轮                    |

重试细节见 react-and-agent-loop 的错误自愈 (src/llm/retry.ts)

## 多轮对话如何实现

每一轮 LLM API 请求, 都包含完整的对话历史, 需要在客户端维护完整的消息列表, 每次用户 (CLI) 发送请求、LLM 响应, 都需要记录, token 消耗会随着对话轮次线形增长

### 消息模型

内部 Message 接口:

```ts
interface Message {
  role: "user" | "assistant" | "system";
  content: string | Record<string, unknown>[]; // 文本或 content block 数组 (含图片)
  thinkingBlocks?: ThinkingBlock[];
  toolUses?: ToolUseBlock[];
  toolResults?: ToolResultBlock[];
}
```

- role: user, assistant, system
- content: 消息内容, 纯文本或 block 数组 (@ 引用展开的图片以 base64 block 存在 content 里)
- thinkingBlocks: 可选, assistant 消息的 extended thinking 推理块 (包含 thinking 文本和 signature)
- toolUses: 可选, assistant 消息中的工具调用请求列表 (包含 toolUseId、toolName、arguments)
- toolResults: 可选, user 消息中的工具调用结果列表 (包含 toolUseId、content、isError)

内部层

- ID: `msg_<hash>` 可以根据消息 ID 定位到正在接收的 assistant 消息, 并追加 SSE chunk
- status: streaming, complete, error 封装层翻译时可以过滤 error 状态的消息
- timestamp
- usage: `{ inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens }`
- role: user, assistant, system, tool (Only for OpenAI)
- content: 消息内容 (thinking 推理、text 文本、tool_use 工具调用或其他...)

### 对话管理器

考虑到流式接收, CLI 正在向 assistant 消息 (SSE chunk 数组) 中追加 SSE chunk, 同时 TUI 正在读 assistant 消息 (SSE chunk 数组) 以渲染 TUI, 两处同时操作同一个列表, 可能导致数据竞争

- Node.js 单线程异步, 避免数据竞争
- Go 加锁

追加 SSE chunk 时, 拿到 assistant 消息的唯一 ID, 根据 ID 追加 SSE chunk; 更新 TUI 时, 根据 ID 拿到一份 assistant 消息的快照

ConversationManager (src/conversation/index.ts) 的关键方法: addUserMessage / addAssistantFull / addToolResultsMessage / addSystemReminder (`<system-reminder>` 包裹, user 角色) / hasReminderContaining (扫历史判断某 marker 是否还在, 压缩感知) / injectLongTermMemory (一次性 unshift) / fork (structuredClone 全部历史, subagent fork 用) / replaceWithCompacted (压缩后重建) / recordUsageAnchor (token 估算锚点)

### 发送前修复配对: ensureToolPairing

中断、会话恢复、并发交错都可能在历史中留下悬空的 tool_use (有调用请求没有结果), 缺配对会被 API 直接拒绝; 三种协议的客户端在构建请求前统一调用 `ensureToolPairing` (src/conversation/pairing.ts):

- assistant 消息带 toolUses 时, 收集其后紧邻的 toolResults; 缺失的结果在该 turn 边界补一条 `INTERRUPTED_TOOL_RESULT` (isError: true)
- 重复的、孤儿的结果丢弃; 所有结果合并为单条 user 消息 (防止 Chat Completions 的图片合成消息拆散配对)
- 返回副本, 不回写历史

## 格式转换: 内部消息到 LLM API 消息

- Anthropic: `src/llm/anthropic.ts` 的 buildAnthropicMessages
- OpenAI Responses: `src/llm/openai.ts` 的 buildOpenAIInput
- OpenAI Chat Completions: `src/llm/openai.ts` 的 buildChatCompletionMessages

1. 转换: 内部 Message 的 thinkingBlocks、content、toolUses 转换为 LLM API 的 content block; toolResults 转换为 LLM API 的 tool_result block (Chat Completions 是 role: "tool" 消息)
2. 合并: 虽然 Claude API 可以自动合并相邻的相同 role 的消息, 但是在客户端合并是更好的做法, 消息结构更清晰, 减少 token 消耗; Anthropic 分支把连续 user 消息合并进前一条 user 的 content
3. 过滤后第一条消息的 role 必须是 user, 并且 message 数组中 user 和 assistant 两个 role 交替出现

特殊转换:

- ComputerUse 工具在 Anthropic 协议下映射为原生 `computer` 工具 (名称互转); OpenAI Responses 下映射为 `computer_call` / `computer_call_output` item (providerItemId 回传)
- Chat Completions 下 thinking 块合并为 `reasoning_content` 字段; 富内容 (图片/文档) 的工具结果合并为一条后置 user 消息
- 官方 Anthropic 端点的 tool schema 带 `type: "custom"` 显式声明

### OpenAI 两种协议的流式差异

- Responses API: 结构化事件 (response.output_text.delta、response.output_item.added/done 等), 工具调用的 id/name 在 output_item.added 中一次到齐
- Chat Completions: 工具调用参数按 `tool_calls[].index` 分片到达, id 和 name 可能分散在多个 delta 中, 客户端按 index 建 Map 拼接, 两者齐备才发 tool_call_start; finish_reason 映射: length → max_tokens, tool_calls → tool_use, 其他 → end_turn; reasoning 走非标的 `delta.reasoning_content`

### 流式接收机制

用户发送请求后, LLMClient 的 stream 方法返回 `AsyncGenerator<StreamEvent>`, 每收到一个 SSE chunk, yield 对应的 StreamEvent; agent loop 循环消费 AsyncGenerator, 如果是文本增量, 则提交给 UI 渲染 (yield stream_text), 如果收集到完整的工具调用 json 参数, 则调用工具; 流式接收完成后, 完整的 assistant 消息写入对话历史并持久化
