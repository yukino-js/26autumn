---
title: "会话上下文"
description: "会话上下文管理: 三层记忆结构 (层 1 原文 / 层 2 规则压缩 / 摘要层)、token 估算、上下文预算分账与启动自检、层降级与异步摘要的轮末结算, 以及模型上下文注入方式和 LangGraph state 字段清单"
local_path: "$HOME/github/yukino-ecomm-agent"
local_commit: "fa5a5090930436aca0dcfb824d948036132697ef"
---

LLM API 是无状态的, 每个请求都要发送完整的对话历史, token 消耗随轮次线性增长, 不管控迟早撑爆模型的上下文窗口. 常见的上下文管理策略有三类:

1. 滑动窗口: 只保留最近 N 轮消息
2. 语义检索: 从历史中召回最相关的 topK 轮候选消息
3. 保留关键消息: 先判断某条消息是否为关键消息, 是则标记为关键消息, 整个会话都携带

本项目采用「滑动窗口 + 分层压缩 + 异步摘要」: 最近的消息原样保留, 较旧的消息降级压缩, 最旧的消息异步压缩成滚动摘要. 分层坐标持久化在数据库的会话记录上, 进程重启后依然成立.

## 三层记忆结构

会话记录 (Prisma 的 `Conversation` 表) 上记录两个消息 ID 坐标, 都是可空字段:

- `S = summaryUptoMsgId`: 摘要覆盖到的最后一条消息 ID
- `L = layer1FromMsgId`: 层 1 的第一条消息 ID

以这两个坐标为界, 全部消息被划成三层:

1. 层 1, 最近的消息 (`ID >= L`): 原样保留
2. 层 2, 中间的消息 (`S < ID < L`): 构建窗口时做规则压缩, 不调用 LLM
   - 用户消息原样保留
   - Agent 回复只保留前 60 字符 (`LAYER2_REPLY_KEEP_CHARS`), 追加 `… (truncated)`
   - 工具结果 ≤ 200 tokens (`LAYER2_TOOL_KEEP_TOKENS`) 的保留原文, 更大的结果替换为占位符 `(Called <工具名>; result omitted)`
3. 摘要层, 最旧的消息 (`ID <= S`): 已被压缩进 `Conversation.summary`, 不再进入窗口

对应代码: `server/src/core/memory.ts` 的 `buildWindow` / `toLayer2` / `compressReply` / `compressToolResult`.

`buildWindow(messages, summaryUptoMsgId, layer1FromMsgId, maxTokens?)` 的处理顺序:

1. `indexAfter` 按坐标截取消息. 两个坐标都锚定在带 `db-<消息ID>` 前缀 ID 的用户消息上 (运行时写入图的用户消息 ID 就是 `db-${msgId}`), 找到第一条 ID 大于坐标的用户消息作为切点
2. 对 `L` 之前的消息段调用 `toLayer2` 做压缩. 压缩时 AI 消息的 `tool_calls` 原样保留, 保证与后续 `ToolMessage` 的配对不断
3. `trimHistory` 兜底: 从最旧的消息开始逐条丢弃直到不超预算, 再保证留下的第一条是用户消息, 否则模型会看到孤立的回复. 若裁剪后为空则退回裁剪前的窗口

预算取 `windowBudget()`: `CONTEXT_WINDOW_MAX_TOKENS` 大于 0 时直接使用它, 否则用 `budget.compute().sliding`.

### 早期消息, 截断 or 压缩?

截断丢事实, 压缩要花一次 LLM 调用. 本项目的答案是分层: 层 1 不动, 层 2 用便宜的规则压缩 (保留用户消息全文, 截断 Agent 回复, 大工具结果换占位符), 只有滑出层 2 的部分才异步调用 LLM 压缩成摘要.

## Token 估算

- 经验值: 中文 1 个汉字 ≈ 1 个 token; 英文 4 个字母 ≈ 1 个 token
- 本项目统一按字符数估算 (`countTokens`, `server/src/core/memory.ts`): 每条消息 `ceil(chars / EN_CHARS_PER_TOKEN) + 3`, 默认 4 字符/token, 3 是每条消息的角色/结构开销
- 计入字符数的不止正文: AI 消息的 `tool_calls` 按 `JSON.stringify` 长度计、`ToolMessage` 的 `tool_call_id` 长度计、消息的 OpenAI 角色名 (`user` / `assistant` / `tool` / `system`) 和可选的 `name` 也计入
- `charsToTokens` / `tokensToChars` 是两个方向的粗略换算 (向下取整), 供规则压缩使用

## 上下文预算

`budget.compute()` (`server/src/core/budget.ts`) 从模型上下文窗口中切出滑动窗口预算:

```text
window  = 模型上下文窗口 (MODEL_CONTEXT_WINDOW > 0 时优先,
          否则按模型名查 KNOWN_WINDOWS 表, 兜底 32768)

fixed   = 系统提示词 700 + 证据 RERANK_TOP_K(10) 块 * 160
          + 摘要 SUMMARY_INJECT_SEGMENTS(3) 段 * 250
          + 最大输出 10000 + 安全边际 1000
peak    = 单轮峰值 = 用户输入 2000
          + MAX_AGENT_STEPS(6) 步 * (工具结果 3000 + 单步 AI 输出 500)
稳态每轮 = 用户输入 2000 + 最大输出 10000
          + 6 步 * 200 (层 2 工具占位符按 LAYER2_TOOL_KEEP_TOKENS 计)
sliding = min(CONTEXT_BUDGET_TURNS(20) * 稳态每轮, window - fixed - peak)
turns   = floor(sliding / 稳态每轮)
```

窗口解析: `MODEL_CONTEXT_WINDOW` 未显式配置时, `lookupWindow` 把 `CHAT_MODEL` 转小写、取最后一个 `/` 之后的段, 对内置的 `KNOWN_WINDOWS` 前缀表做最长前缀匹配 (覆盖 minimax / deepseek / qwen / glm / kimi / moonshot / gpt / `claude-` 等常见型号), 未命中则回落到 32768.

健康判定: `window - fixed - peak <= 0`, 或者切出来的 `sliding` 装不满一轮稳态消耗 (`turns < 1`) 时 `healthy = false`. `limited_by` 记录滑动窗口是被轮数 (`turns`) 还是窗口 (`window`) 卡住的.

服务启动时 `server.ts` 的 `checkContextBudget()` 输出一条预算报告, 格式为 `window=… fixed=… turn_peak=… sliding=… turns=… (steady_per_turn=…) limited_by=… healthy=yes/no`; 健康时记 info (`context budget ok`), 否则记 error 并提示调大 `MODEL_CONTEXT_WINDOW` 或调小 `MAX_AGENT_STEPS` / `TOOL_RESULT_MAX_TOKENS` / `MAX_OUTPUT_TOKENS` / `RERANK_TOP_K`.

以上数字都可用环境变量调整 (`server/src/config.ts`):

| 环境变量                     | 默认值         | 用途                   |
| ---------------------------- | -------------- | ---------------------- |
| `MODEL_CONTEXT_WINDOW`       | 0 (查表)       | 模型上下文窗口         |
| `CONTEXT_WINDOW_MAX_TOKENS`  | 0 (用 sliding) | 直接指定窗口裁剪预算   |
| `CONTEXT_BUDGET_TURNS`       | 20             | 稳态轮数上限           |
| `SYSTEM_PROMPT_TOKENS`       | 700            | 系统提示词预算         |
| `EVIDENCE_TOKENS_PER_CHUNK`  | 160            | 每块知识证据预算       |
| `SUMMARY_INJECT_SEGMENTS`    | 3              | 注入的历史摘要段数     |
| `SUMMARY_TOKENS_PER_SEGMENT` | 250            | 每段摘要预算           |
| `MAX_OUTPUT_TOKENS`          | 10000          | 最大输出预算           |
| `BUDGET_SAFETY_MARGIN`       | 1000           | 安全边际               |
| `MAX_USER_INPUT_TOKENS`      | 2000           | 单轮用户输入预算       |
| `MAX_AGENT_STEPS`            | 6              | agent 最大步数         |
| `TOOL_RESULT_MAX_TOKENS`     | 3000           | 单步工具结果峰值       |
| `AGENT_STEP_AI_TOKENS`       | 500            | 单步 AI 输出峰值       |
| `LAYER1_RATIO`               | 0.7            | 层 1 占滑动窗口的比例  |
| `LAYER2_REPLY_KEEP_CHARS`    | 60             | 层 2 回复保留字符数    |
| `LAYER2_TOOL_KEEP_TOKENS`    | 200            | 层 2 工具结果保留上限  |
| `EN_CHARS_PER_TOKEN`         | 4              | token 估算的字符/token |

## 层降级 (层 1 -> 层 2)

每轮结束后 (非流式的 `runTurn` 与流式的 `streamTurn` 都会调用), `server/src/graph/runtime.ts` 的 `settleLayers` 检查层 1 是否超预算:

1. 层 1 预算 = `floor(budget.compute().sliding * LAYER1_RATIO)`, 默认占滑动窗口的 0.7
2. `memory.layerTokens` 分别算出层 2 (压缩后) 与层 1 的 token 数; 层 1 未超预算则直接返回
3. 超预算时 `memory.nextLayer1From` 从最新消息往前逐条累加 token, 找到超出预算的边界, 再从边界向更旧的方向定位第一条带 `db-` ID 的消息, 其 ID 就是新的 `layer1FromMsgId`
4. 新坐标比旧坐标更大时才持久化 (`repository.updateLayer1From`), 并记一条 `layer 1 degraded` 日志

滑出层 1 的消息下次构建窗口时自动按层 2 压缩. 整个结算被 try/catch 包住, 失败只记 `layer settlement failed (reply unaffected)`, 不影响已经发出的回复.

## 异步摘要 (层 2 -> 摘要)

每轮结束后 `maybeScheduleSummary` (`server/src/core/summarizer.ts`) 检查层 2 是否需要压缩 (`runTurn` / `streamTurn` / 恢复中断后的 `resumeTurn` / `streamResume` 都会触发):

- 触发条件: 层 2 消息 (ID 在 `(S, L]` 区间, 从数据库取 user / assistant 两种角色的对话消息) 的总字符数经 `charsToTokens` 折算后超过 `floor(sliding * (1 - LAYER1_RATIO))`
- 异步不阻塞: 用户本轮回复不等摘要; 进程内用 `running` Map 按会话 ID 去重, 同一会话不会并发跑两个摘要任务

命中后异步执行 `runSummary`:

1. 把这一段对话拼成 `User: …` / `Agent: …` 行, 交给 `SUMMARY_PROMPT` (summary 槽位模型, 结构化输出 `{summary}`)
2. 摘要规则 (`SUMMARY_SYSTEM`): 只提炼事实和请求 (问过什么商品、给过的订单号/手机号、用户的明确请求、未解决的问题); 不编造对话中没有的内容; 丢弃寒暄; 旧摘要只作背景输入, 不重复、不合并; 长度控制在几十到一两百字
3. 摘要为空则抛错中止, 不更新任何坐标
4. `repository.appendSummarySegment` 在一个事务里写入一条 `ConversationSummary` 分段 (`seq` = 上一段 + 1, 记录 `fromMsgId` / `uptoMsgId`), 并把最近 `SUMMARY_INJECT_SEGMENTS` (默认 3) 段按时间顺序用换行拼接成投影, 更新 `Conversation.summary`, `summaryUptoMsgId` 推进到 `L`
5. 任务失败只记 `summary failed` 日志, 不影响主流程

推进后 `S = L`, 层 2 清空; 下一轮窗口只保留新 `S` 之后的消息, 已被压缩的历史摘要不会被二次压缩. 历史摘要不需要全量携带: 一条摘要对应多轮对话, 窗口预算上只按 `SUMMARY_INJECT_SEGMENTS` 段计.

## 注入模型上下文

主力 agent 每轮看到的消息序列由 `agentMessages` (`server/src/graph/nodes.ts`) 组装:

```js
[
  // 角色、业务范围、行为约束; 放最前且内容固定, prompt cache 按前缀命中
  { role: "system", content: AGENT_SYSTEM },
  // 层 2 压缩后的消息 (用户原样 / agent 截断 / 工具占位符)
  { role: "user", content: "..." },
  { role: "assistant", content: "... (truncated)" },
  // 层 1 最近的消息: 原样保留
  { role: "user", content: "..." },
  { role: "assistant", content: "..." },
  // 用户当前的消息
  { role: "user", content: "..." },
  // 本轮会话材料, 以 id 为 turn-ctx 的 user 消息
  // 紧跟在当前用户消息之后插入
  {
    role: "user",
    content:
      "## Summary of earlier conversation ...\n## Retrieved knowledge evidence [1] ...",
  },
];
```

本轮材料 (`turnContext`) 按需拼装, 非空时由 `withTurnContext` 插入: 从窗口尾部向前找到最后一条用户消息, 把 turn-ctx 消息插在它后面. 材料放在窗口尾部而不是头部, 前缀 (system + 历史) 保持稳定, 有利于命中前缀缓存. `turnContext` 的组成:

- 历史摘要: `summarySystem` 生成 `## Summary of earlier conversation (earlier turns are compressed; the facts in it are trustworthy)` 开头的段落
- 知识证据: `KNOWLEDGE_EVIDENCE_HINT` 声明引用编号规则 (关键结论后标注 `[1]` 这类来源编号)、证据已给出时不再调 `query_faq`, 并强调型号必须照抄证据、证据外的型号不许写、条件性结论要带条件
- 退款场景: `route` 为 `refund_flow` 时追加 `REFUND_JUDGE_HINT`, 附上 `orderData` 的 JSON 和判断要求 (可退则调 `submit_refund` 并一句话说明依据, 不可退则解释原因并提示可转人工)

`mainAgent` 调用模型前后, `logModelContext` 会以 `model_ctx` 日志打出本轮窗口概况 (每条消息的类型和前 40 字符、turn-ctx 的字符数、总 token 数), 便于核对实际注入内容.

指代消解 (`resolveReference`) 和意图识别 (`classifyIntent`) 节点用的是另一份更轻的历史 (`historyText`): 一行摘要 (`summaryLine`, 形如 `(Summary of earlier conversation: …)`) + 窗口中除当前消息外最近 6 条消息的文本, 逐行拼成 `User: …` / `Agent: …`.

## langgraph state

langgraph 的 state 是节点间共享的数据结构, 每个节点都可以读写 state. 消息历史不需要每轮重新拼装: `graphInput` 只把当前用户消息 (ID 为 `db-<消息ID>`) 交给图, 更早的消息由 Postgres checkpointer (`CHECKPOINTER_DB_URL`, `thread_id` 就是会话 ID) 恢复. 本项目的 `ConversationState` (`server/src/graph/state.ts`) 字段:

- `messages`: 消息历史, 用 `messagesStateReducer` 追加合并
- `summary` / `summaryUptoMsgId` / `layer1FromMsgId`: 记忆分层坐标
- `userId` / `conversationId`
- `intent` / `intentConfidence` / `route` / `resolvedQuery`: 查询理解的结果
- `orderId` / `orderData`: 退款子流程
- `evidence` / `citations` / `evidenceStrong` / `evidenceConfidence` / `retrievedSnapshot` / `fallbackSource`: 检索与置信度
- `answer` / `steps` / `tokensUsed`: 回复与资源消耗
- `suggestedActions`: 交给前端确认的动作卡片 (选订单 / 工单预览 / 退款表单 / 转人工)
- `trace`: 各节点的诊断信息 (`mergeDict` reducer 浅合并)

图的构建与执行流程见 [workflow](./workflow), 摘要等辅助调用走的模型槽位见 [llm](./llm).
