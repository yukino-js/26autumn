---
title: "LLM"
description: "LLM 接入层 (src/llm/): 把对话历史翻译成 Anthropic / OpenAI Responses / OpenAI Chat Completions 三种协议的 API 请求, 把 SSE 流统一映射成 StreamEvent; 覆盖思考强度映射, token 计费与 prompt cache 打点, 消息构建与配对修复, 错误分类重试, 模型发现与 ConversationManager"
local_path: "$HOME/github/yukino-code/apps/yukino"
local_commit: "bef5439b54e6510a12da61bcfa4285ecb1cd2192"
---

Yukino 的 LLM 层在 src/llm/: 把 ConversationManager 里的对话历史翻译成三种协议的 LLM API 请求, 把各家返回的 SSE 流统一映射成内部的 `StreamEvent` 事件流, 交给上层 [Agent Loop](./react-and-agent-loop) 消费; 同时负责思考强度、token 计费口径、prompt cache 打点、错误分类重试和模型发现

```txt
src/llm/
├── client.ts           # LLMClient 接口与 createClient 工厂
├── anthropic.ts        # AnthropicClient (Anthropic Messages API)
├── openai.ts           # OpenAIClient (Responses API) + OpenAICompatClient (Chat Completions)
├── events.ts           # StreamEvent、UsageInfo、parseToolArguments
├── errors.ts           # 统一错误类型与 containsContextLengthError
├── retry.ts            # 重试退避延迟与可中断等待
├── model-discovery.ts  # GET /models 模型列表
├── model-resolver.ts   # 基于同一 provider 配置按模型名建客户端
└── constants.ts        # 重试常量、anthropic-version、缺 key 报错文案
```

## 请求与响应的结构

以 Anthropic Messages API 为例, 一次请求携带 system、messages、tools 三部分:

```bash
curl https://api.anthropic.com/v1/messages \
  -H "Content-Type: application/json"      \
  -H "x-api-key: $ANTHROPIC_API_KEY"       \
  -H "anthropic-version: 2023-06-01"       \
  -d '{
    "max_tokens": 1024,
    "model": "claude-sonnet-4-6",
    "messages": [
      { "role": "user", "content": [{ "type": "text", "text": "Hello, who are you?" }] }
    ]
  }'
```

响应示例:

```json
{
  "id": "<uuid>",
  "type": "message",
  "role": "assistant",
  "model": "claude-sonnet-4-6",
  "content": [
    {
      "type": "thinking",
      "thinking": "User asks hello who are you...",
      "signature": "<signature>"
    },
    {
      "type": "text",
      "text": "Hello! I'm Claude, an AI assistant created by Anthropic."
    }
  ],
  "stop_reason": "end_turn",
  "stop_sequence": null,
  "usage": {
    "input_tokens": 89,
    "cache_creation_input_tokens": 0,
    "cache_read_input_tokens": 0,
    "output_tokens": 46
  }
}
```

- 请求的 messages: 每条 message 有 role 和 content 两个字段, role (API 场景下) 只有两个值: user 和 assistant; messages 数组中, 最好保持 user 和 assistant 两个 role 交替出现; 如果连续传递两条 user 消息, API 不会报错, 会自动合并为一条 user 消息
- LLM 返回一个工具调用 (tool_use) 请求, 这是 assistant 消息; 用户调用工具拿到结果, 该工具调用结果需要作为 user 消息发送; 如果错误的将工具调用结果作为 assistant 消息发送, 则会导致连续两条 assistant 消息, API 会直接报错。工具调用协议本身的细节见 [工具调用](./function-calling)
- 响应的 content 字段是一个数组: LLM 的响应可能包含多种内容, 每种内容是一个独立的 content block, 类型可能是 text、thinking、redacted_thinking、tool_use 等
- 流式响应基于 SSE (Server-Sent Events), 本质是 HTTP 长连接

Claude 的流式事件有固定顺序:

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

## StreamEvent: 统一的流事件

封装层将各协议的 SSE 事件映射到内部的 StreamEvent (src/llm/events.ts):

```ts
type StreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "thinking_complete"; thinking: string; signature: string }
  | { type: "redacted_thinking_complete"; data: string }
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

- `redacted_thinking_complete`: 加密推理块整体到达 (没有 delta), 封装层原样捕获, 下次请求时原样回放, 绝不解码、落日志或展示
- `parseToolArguments`: 工具参数 JSON 收齐后统一解析; 空串视为合法的无参调用, 非对象或解析失败返回空对象加 `parseError` 说明, 让执行器能回一条配对的错误结果, 而不是拿一个伪造的空对象去调工具

Anthropic 协议的映射 (anthropic.ts 的 stream 循环):

```txt
content_block_start (thinking)         -> 开始累积推理文本与签名 (不发事件)
content_block_delta (text_delta)       -> text_delta
content_block_delta (thinking_delta)   -> thinking_delta
content_block_delta (signature_delta)  -> 累积签名 (不发事件)
content_block_start (tool_use)         -> tool_call_start (缺 id 或 name 直接抛 NetworkError)
content_block_delta (input_json_delta) -> tool_call_delta
content_block_stop (thinking)          -> thinking_complete
content_block_stop (redacted_thinking) -> redacted_thinking_complete
content_block_stop (tool_use)          -> tool_call_complete
message_delta                          -> 更新 stopReason 与 usage 各字段 (不发事件)
message_stop                           -> 置终止标记
流结束且见到 message_stop              -> stream_end
```

终止保护: 流没有正常终止 (Anthropic 未见 message_stop、OpenAI Responses 未见 terminal 事件、Chat Completions 未见 finish_reason) 时抛 `NetworkError`, 不发 `stream_end`, 防止半截响应被当成完整响应提交入库。`message_delta` 的 usage 字段独立应用: 一个 output_tokens 为 0 但携带 input/cache 字段的 delta, 也会更新对应计数

## ProviderConfig 与客户端工厂

ProviderConfig (src/config/provider-config.ts) 覆盖三种协议: Anthropic、OpenAI、OpenAI 兼容层

| 字段               | 说明                                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------ |
| name               | provider 名称                                                                                                |
| protocol           | LLM API 协议, 枚举值 `"anthropic"` \| `"openai"` \| `"openai-compat"`                                        |
| base_url           | 端点地址, 是 provider 的身份标识, 配置加载时校验多个 provider 的 base_url 不得重复                           |
| model              | LLM 模型, 例如 claude-sonnet-4-6                                                                             |
| api_key            | 令牌 (可选, fallback 到环境变量: anthropic → `ANTHROPIC_API_KEY`, openai / openai-compat → `OPENAI_API_KEY`) |
| thinking           | 思考强度 off \| minimal \| low \| medium \| high \| xhigh \| max (可选, 默认 high)                           |
| reasoning          | 显式能力开关 (可选); false 完全关闭推理, 省略则保留 provider 默认; 绝不从模型名推断能力                      |
| thinking_level_map | 逻辑强度到 provider effort 的逐项覆盖 (可选), 映射为 null 表示禁用该级                                       |
| thinking_mode      | `"budget"` \| `"adaptive"` (可选, 仅 Anthropic 使用 adaptive)                                                |
| context_window     | 上下文窗口大小 (可选, 默认 DEFAULT_CONTEXT_WINDOW = 1_000_000)                                               |
| max_output_tokens  | 最大输出 token 数 (可选, 默认 DEFAULT_MAX_OUTPUT_TOKENS = 128_000, clamp 到不超过 context_window)            |

客户端接口 (src/llm/client.ts):

```ts
interface LLMStreamOptions {
  systemPrompt?: string;
  maxOutputTokens?: number;
  /** provider 使用固定 thinking 预算时保留的回答空间 */
  answerReserveTokens?: number;
  maxRetries?: number; // 传给 SDK 的底层重试次数
}

interface LLMOutputBudget {
  maxOutputTokens: number;
  /** provider 原生 reasoning effort 折算的思考预算 */
  thinkingTokens: number;
}

interface LLMClient
  extends Partial<MaxTokensSetter>, Partial<ThinkingLevelControl> {
  readonly protocol?: ToolProtocol;
  getOutputBudget?(): LLMOutputBudget;
  stream(
    conversationManager: ConversationManager,
    toolSchemas: ProviderToolSchema[],
    abortSignal?: AbortSignal,
    options?: LLMStreamOptions,
  ): AsyncGenerator<StreamEvent>;
  setSystemPrompt(prompt: string): void;
}

interface MaxTokensSetter {
  setMaxOutputTokens(maxTokens: number): void; // max_tokens 升级 (agent loop 用)
}

interface ThinkingLevelControl {
  setThinkingLevel(level: ThinkingLevel): ThinkingLevel; // 返回实际生效的级别 (可能被 clamp)
  getThinkingLevel(): ThinkingLevel;
  getSupportedThinkingLevels?(): readonly ThinkingLevel[];
}
```

`createClient(config, systemPrompt)` 按 protocol 动态 import 对应的实现 (AnthropicClient / OpenAIClient / OpenAICompatClient, 后两者同在 openai.ts), 只有配置到的协议 SDK 会被加载; 各客户端构造函数内先用 `resolveAPIKey` 解析令牌, 缺失时抛 `AuthenticationError` 并提示全局配置文件路径与对应环境变量。创建出的客户端再经 `registerLlmClient` 登记模型与协议元数据, 供遥测上报使用 (见 [遥测](./telemetry))

`createModelResolver(baseConfig, systemPrompt)` 返回一个按模型名建客户端的函数: 复用同一份 provider 配置只替换 model; 作为库导出供外部消费者使用 (/model 切换模型走的是 discoverModels + createClient)

## 思考强度

逻辑级别共 7 档: `THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"]`, 默认 `high`。token 预算 (THINKING_BUDGETS, src/config/constants.ts): minimal 1024, low 2048, medium 8192, high 16384, xhigh 32768, max 65536

级别先经 `toReasoningEffort` 映射, 再看 provider 能力:

- `reasoning: false` → 任何级别都映射为 null, 完全禁用
- 级别为 off → 固定映射为 `"none"`, 显式压制服务端默认推理
- `thinking_level_map` 有该级的覆盖项 → 用覆盖值; 映射为 null 表示禁用该级
- Anthropic adaptive 模式特殊折算: minimal → low, xhigh → high (adaptive effort 合法值只有 low/medium/high/xhigh/max)
- 其余原样透传

`getSupportedThinkingLevels` 据此枚举可用级别: `reasoning: false`, 或 Anthropic budget 模式下 `max_output_tokens` 低于 2048 (`MIN_THINKING_BUDGET_TOKENS + MIN_THINKING_ANSWER_TOKENS`, 不存在合法 budget) 时只剩 `["off"]`。`clampThinkingLevel` 只降不升: 请求的级别不支持时落到最近的可用级别

### Anthropic 的两种请求模式

- budget (默认): `thinking: { type: "enabled", budget_tokens }`。回答空间 `answerReserve = max(1024, options.answerReserveTokens)`, 预算 `thinkingTokens = min(budget[level], maxOutputTokens - answerReserve)`, 始终给回答保留至少 1024 token; `thinkingTokens` 低于 1024 时 thinking 降级为 `{ type: "disabled" }`。请求时通过 `options.answerReserveTokens` 可以抬高保留量 (压缩摘要、记忆整理等旁路请求就是这么用的)
- adaptive: `thinking: { type: "adaptive" }` + `output_config: { effort }`, 按 effort 而不是 token 预算控制
- 级别为 off 时发 `{ type: "disabled" }`; `reasoning: false` 时 thinking 字段整个省略, 保留 provider 默认

OpenAI 两种协议的 effort 原样透传 (不做 Anthropic adaptive 那样的折算), 只有 `thinking_level_map` 覆盖或 `reasoning: false` 会改变它:

- Responses API: `reasoning: { effort, summary: "auto" }`, effort 为 `"none"` (即 off) 时不带 summary 字段, 映射为 null (即 `reasoning: false`) 时整个 reasoning 字段省略
- Chat Completions: `reasoning_effort` 字段, 同样的省略规则; off 也显式发送 `none`, 防止服务端默认悄悄开启推理

## token 计费与 prompt cache

token 是 LLM 的计费单位, 每个英文单词约 1-2 个 token, 每个汉字约 1-2 个 token, 具体取决于 LLM 使用的 tokenizer。Claude API 的计费分为:

- inputTokens: 未命中 prompt cache 的输入 token 数, 即 system prompt、tools 描述和 messages 中未命中 prompt cache 的部分
- outputTokens: 输出 token 数, 即 LLM 生成的内容 (thinking 也算在内), 输出 token 比输入 token 贵的多
- cacheReadInputTokens: 命中 prompt cache 的输入 token 数, 价格远低于普通 input_tokens
- cacheCreationInputTokens: 创建 prompt cache 的输入 token 数, 价格略高于普通 input_tokens

每一轮请求都要发送完整的对话历史; 如果和 LLM 聊了 20 轮, 第 21 轮请求会包含前 20 轮的所有消息, input_tokens 随对话轮次线性增长, 所以需要 [上下文压缩](./context-compaction)

封装层在 `UsageInfo` 中统一了四个计数的口径: `inputTokens` 在所有协议上都**不含**缓存前缀, 四个字段加起来就是真实 token 基线, 直接用作压缩判断的锚点 (`recordUsageAnchor`)。OpenAI 协议没有 cache_creation 概念 (恒为 0), cache_read 通过 `usage.input_tokens_details.cached_tokens` (Responses) 或 `usage.prompt_tokens_details.cached_tokens` (Chat Completions) 返回, 且 `input_tokens` 已含缓存前缀, 封装层减去缓存部分, 保证 4 个计数不重复

### Anthropic 的 cache_control 打点

Anthropic 的 cache_control 打在三个位置 (src/llm/anthropic.ts):

1. system prompt: 单一 text 块, ephemeral
2. tools 数组: `markToolsForCache` 从尾部倒扫, 跳过 `defer_loading` 的工具 (defer 和 cache 同存会被 API 拒绝), 在最后一个非 deferred 工具上打 ephemeral; 内置工具永不 defer, 所以合法位置总是存在
3. 最后一条 user 消息的尾部: `markLastUserTailForCache` 在最后一个非图片块打 ephemeral (部分网关拒绝图片块上的 cache_control, 全是图片时退回真正的尾块), 滚动缓存对话前缀

tools 数组是缓存前缀的第一段, 数组任何变化 (增删工具、schema 变化) 会使整个后续历史缓存失效, 这是 MCP 工具延迟加载策略的动因 (见 [MCP](./mcp))

此外, 只有本批工具中确有 `defer_loading` 时才发送 `anthropic-beta: advanced-tool-use-2025-11-20` 头 (needsToolSearchBeta): 不识别该 beta 的端点会直接拒绝请求

## 消息构建: 内部消息到 LLM API 消息

内部 Message 接口 (src/conversation/index.ts):

```ts
type ThinkingBlock =
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "redacted_thinking"; data: string }; // 加密块, 原样回放

interface ToolUseBlock {
  toolUseId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  parseError?: string;
  providerItemId?: string; // OpenAI computer_call item id
}

interface ToolResultBlock {
  toolUseId: string;
  content: string;
  contentBlocks?: ToolResultContentBlock[]; // 富内容 (图片/文档)
  isError: boolean;
}

interface Message {
  role: "user" | "assistant" | "system";
  content: string | Record<string, unknown>[]; // 文本或 content block 数组 (含图片)
  thinkingBlocks?: ThinkingBlock[];
  toolUses?: ToolUseBlock[];
  toolResults?: ToolResultBlock[];
  userBash?: UserBashResult; // 用户 "!" 前缀自执行命令的记录
  userInput?: UserInput;
}
```

- content: 纯文本或 block 数组 (@ 引用展开的图片以 base64 block 存在 content 里); assistant/system 内容实际总是纯文本
- thinkingBlocks: assistant 消息的推理块, 包含 thinking 文本与 signature, 或加密的 redacted_thinking
- toolUses: assistant 消息中的工具调用请求列表
- toolResults: user 消息中的工具调用结果列表

### 发送前修复配对: ensureToolPairing

中断、会话恢复、并发交错都可能在历史中留下悬空的 tool_use (有调用请求没有结果), 缺配对会被 API 直接拒绝; 三种协议的客户端在构建请求前统一调用 `ensureToolPairing` (src/conversation/pairing.ts):

- assistant 消息带 toolUses 时, 收集其后紧邻的 toolResults; 缺失的结果在该 turn 边界补一条 `INTERRUPTED_TOOL_RESULT` (isError: true), 文案不断言工具「没有副作用」, 只要求模型先核实
- 重复的、孤儿的结果丢弃; 所有结果合并为单条 user 消息 (防止 Chat Completions 的图片合成消息拆散配对)
- 返回副本, 不回写历史: 历史忠实记录实际发生的事, 修补只为让本次请求合法

### 三个协议的转换函数

- Anthropic: `buildAnthropicMessages` (src/llm/anthropic.ts)
- OpenAI Responses: `buildOpenAIInput` (src/llm/openai.ts)
- OpenAI Chat Completions: `buildChatCompletionMessages` (src/llm/openai.ts)

共同的三步:

1. 转换: 内部 Message 的 thinkingBlocks、content、toolUses 转换为 LLM API 的 content block; toolResults 转换为 tool_result block (Chat Completions 是 role: "tool" 消息)
2. 合并: 虽然 Claude API 可以自动合并相邻的相同 role 的消息, 但是在客户端合并是更好的做法, 消息结构更清晰, 减少 token 消耗; Anthropic 分支把连续 user 消息合并进前一条 user 的 content
3. 过滤后消息数组保持 user / assistant 交替

特殊转换:

- ComputerUse 工具在 Anthropic 协议下映射为原生 `computer` 工具 (名称互转); OpenAI Responses 下映射为 `computer_call` / `computer_call_output` item (providerItemId 回传), 结果里的截图以 `computer_screenshot` 输出, pending safety checks 逐条确认; 结果报错或缺图时文本内容额外作为 user 消息发送
- Anthropic 分支原样回放 redacted_thinking 块; Chat Completions 下 thinking 块合并为非标的 `reasoning_content` 字段; Responses 下只回放 signature 以 `rs_` 开头的 thinking 块为 `reasoning` item (其余 signature 无效, 丢弃)
- Chat Completions 下富内容 (图片/文档) 的工具结果合并为一条后置 user 消息, 以 `[Rich content returned by tool call <id>]` 文本打头; 文档源为 url 时该协议无法表达, 生成说明文本而不是静默丢弃
- 官方 Anthropic 端点 (base_url 为空即 SDK 默认地址, 或 host 为 api.anthropic.com) 的 tool schema 带 `type: "custom"` 显式声明; 非官方端点剥掉 type 字段
- 空的 assistant 消息补一个空 text 块, 保证 content 数组非空; user 内容里的 tool_reference 等不支持块直接报错

## OpenAI 两种协议的流式差异

- Responses API: 结构化事件 (response.output_text.delta、response.output_item.added/done 等), 工具调用的 id/name 在 output_item.added 中一次到齐, 缺一即抛 NetworkError; reasoning item 结束时发 `thinking_complete` (signature 取 reasoning id); 终止事件是 `response.completed` / `response.incomplete`, incomplete 且原因为 max_output_tokens 时 stopReason 映射为 max_tokens (触发 agent loop 的输出上限恢复), 其他 incomplete 原因抛 LLMError; `response.failed` 与顶层 `error` 事件按消息内容区分 ContextTooLongError / LLMError
- Chat Completions: 工具调用参数按 `tool_calls[].index` 分片到达, id 和 name 可能分散在多个 delta 中, 客户端按 index 建 Map 拼接, 两者齐备才发 tool_call_start, start 之前的参数增量不外发; finish_reason 时若仍有未 start 的调用直接抛 NetworkError。finish_reason 映射: content_filter → 抛 LLMError (被拦截的响应不是正常完成, 不能执行已累积的工具调用), length → max_tokens, tool_calls / function_call / (stop 且已有工具调用) → tool_use, stop → end_turn, 未知值 → 抛 LLMError; reasoning 走非标的 `delta.reasoning_content`, finish_reason 到达时收口为 `thinking_complete` (signature 为空)。usage 通过 `stream_options: { include_usage: true }` 在尾包 (choices 为空) 中到达

### 流式接收机制

用户发送请求后, LLMClient 的 stream 方法返回 `AsyncGenerator<StreamEvent>`, 每收到一个 SSE chunk, yield 对应的 StreamEvent; agent loop 循环消费 AsyncGenerator, 如果是文本增量, 则提交给 UI 渲染 (yield stream_text), 如果收集到完整的工具调用参数, 则执行工具调用; 流式接收完成后, 完整的 assistant 消息 (text + thinkingBlocks + toolUses) 通过 `addAssistantFull` 写入对话历史并持久化

## 错误分类与重试

统一的错误类型 (src/llm/errors.ts), 两种协议的 classify 函数 (classifyAnthropicError / classifyOpenAIError) 把 SDK 错误映射到同一组类型:

| 类型                | 触发条件                                                                | agent loop 的反应           |
| ------------------- | ----------------------------------------------------------------------- | --------------------------- |
| ContextTooLongError | 413; 或 400 且消息匹配 prompt too long / context_length_exceeded 等正则 | forceCompact 后重试本轮     |
| RateLimitError      | 429 (携带 retry-after 头)                                               | 可见输出前最多 3 次退避重试 |
| ServerError         | 5xx 或 408 服务端错误 (携带 retry-after 头)                             | 可见输出前最多 3 次退避重试 |
| NetworkError        | 连接错误、请求中断、非 API 的未知异常、流未正常终止                     | 可见输出前最多 3 次退避重试 |
| AuthenticationError | 401; 或构造客户端时 API key 缺失                                        | 终止, 提示重新登录          |
| LLMError            | 其他 API 错误                                                           | 终止本轮                    |

`containsContextLengthError` 用三个正则跨协议识别上下文超长: `context_length_exceeded`、`maximum context length`、`prompts? (is )?too long` (Anthropic 返回 "prompt is too long: N tokens > M maximum", OpenAI 系及 DeepSeek 等兼容网关返回 context_length_exceeded)

重试机制 (src/llm/retry.ts): `llmRetryDelay(error, attempt)` 对 RateLimitError / ServerError / NetworkError 返回等待毫秒数, 其余错误返回 undefined (不重试); attempt 达到 `MAX_RETRIES = 3` 后同样不再重试。RateLimitError 优先解析 retry-after 头 (支持秒数和 HTTP 日期两种格式), 缺省时按 `RATE_LIMIT_BASE_DELAY_MS (5000) * 2^attempt` 指数退避; ServerError / NetworkError 按 `BACKOFF_BASE_DELAY_MS (1000) * 2^attempt` 退避; 一律封顶 `MAX_DELAY_MS = 60_000`。等待由 `waitForLlmRetry` 执行, 可被 AbortSignal 中断

agent loop 的消费策略: ContextTooLongError 触发 forceCompact 压缩后重试; 瞬时错误只在**本轮还没有任何可见输出** (没有文本、thinking、工具调用) 时才静默重放 —— 已流出的内容无法撤回。重试细节见 [Agent Loop](./react-and-agent-loop) 的错误自愈

## 模型发现

/model 命令的模型选择器靠模型发现 (src/llm/model-discovery.ts):

- `modelListUrl` 归一化 base_url: 要求是合法 HTTP(S) URL 且不内嵌账号密码; 剥掉尾部的 `/chat/completions`、`/completions`、`/responses`、`/messages`、`/models` 路径; 路径为空时补上 `/v1`, anthropic 协议额外要求路径以 `/v1` 结尾 (缺则补上); 最后拼上 `/models`, 并清空 query 与 hash
- `discoverModels` 发 GET 请求, 带 `Accept: application/json`; anthropic 协议加 `anthropic-version: 2023-06-01` 与 `x-api-key`, 其余协议用 `Authorization: Bearer`; 整体超时 `DISCOVERY_TIMEOUT_MS = 5_000` 毫秒
- anthropic 端点支持 has_more/last_id 翻页 (游标参数为 `after_id`, 游标重复即报错), 最多 `MAX_MODEL_PAGES = 10` 页, 按 id 去重; 其他协议只取一页
- 任何失败 (非 2xx、schema 校验失败、翻页异常) 统一报 "Model discovery failed", 超时或被中断报 AbortError, 选择器回退到错误态手动输入

provider-login 与 remote server 也复用同一套发现逻辑

## 多轮对话: ConversationManager

每一轮 LLM API 请求都包含完整的对话历史, 需要在客户端维护完整的消息列表, 每次用户 (CLI) 发送请求、LLM 响应都需要记录, token 消耗随对话轮次线性增长

ConversationManager (src/conversation/index.ts) 是这份历史的唯一持有者, 关键方法:

- addUserMessage / addAssistantFull / addToolResultsMessage: 追加三种 turn
- addSystemReminder (`<system-reminder>` 包裹, user 角色) 与 addSystemReminderIfChanged (按 marker 比对最近一条同名 reminder, 内容没变不重复注入)
- hasReminderContaining: 扫历史判断某 marker 是否还在, 压缩感知 —— 压缩会把 reminder 折叠进摘要, 调用方据此决定重新注入, 不必侵入压缩路径
- injectLongTermMemory: 一次性 unshift 到历史头部 (长期记忆、skills 注入, 见 [AGENTS.md and Memory](./agents-md-and-memory))
- appendMessages / getMessages / len / truncateTo / reset: 历史读写; reset 就地清空而不是替换实例, 因为 AgentTool 等组件持有旧实例的引用
- fork: structuredClone 全部历史, subagent fork 用
- replaceWithCompacted: 压缩后重建 (摘要 user 消息 + 原样保留的尾部消息), 见 [上下文压缩](./context-compaction)
- recordUsageAnchor / clearUsageAnchor / usageAnchorState: token 估算锚点, 基线为 input + cache_read + cache_creation + output 四项之和

考虑到流式接收, CLI 正在向 assistant 消息追加 SSE 增量, 同时 TUI 正在读消息列表以渲染, 两处同时操作同一份历史; Node.js 单线程异步模型天然避免了数据竞争。追加增量时定位正在接收的 assistant 消息, 更新 TUI 时读取一份快照
