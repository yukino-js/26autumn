---
title: "会话上下文"
---

# 会话上下文

LLM API 是无状态的, 每个请求都要发送完整的对话历史, token 消耗随轮次线性增长, 不管控迟早撑爆模型的上下文窗口。常见的上下文管理策略:

1. 滑动窗口: 只保留最近 N 轮消息
2. 语义检索: 从历史中召回最相关的 topK 轮候选消息
3. 保留关键消息: 先判断某条消息是否为关键消息, 如果是则标记为关键消息, 整个会话都携带

本项目实现的是「滑动窗口 + 分层压缩 + 异步摘要」: 最近的消息原样保留, 较旧的消息降级压缩, 最旧的消息异步压缩成摘要。

## 三层记忆结构

会话记录 (Conversation 表) 上记录两个消息 ID 坐标:

- S = summaryUptoMsgId: 摘要覆盖到的最后一条消息 ID
- L = layer1FromMsgId: 层 1 的第一条消息 ID

1. 层 1, 最近的消息 (ID >= L): 原样保留
2. 层 2, 中间的消息 (S < ID < L): 构建窗口时做规则压缩, 不调用 LLM
   - 用户消息原样保留
   - Agent 回复保留前 60 字符 (LAYER2_REPLY_KEEP_CHARS), 追加 "… (truncated)"
   - 工具结果 ≤ 200 tokens (LAYER2_TOOL_KEEP_TOKENS) 保留, 更大的结果替换为占位符 "(Called <工具名>; result omitted)"
3. 摘要层, 最旧的消息 (ID <= S): 已被压缩成滚动摘要, 不再进入窗口

对应代码: `server/src/core/memory.ts` 的 `buildWindow` / `toLayer2` / `compressReply` / `compressToolResult`。`buildWindow` 先截取 S 之后的消息, 对 L 之前的消息做层 2 压缩, 最后 `trimHistory` 从最旧的消息开始逐条丢弃直到不超预算 (并保证留下的第一条是用户消息, 否则模型会看到孤立的回复)。

### 早期消息, 截断 or 压缩?

截断丢事实, 压缩要花一次 LLM 调用。本项目的答案是分层: 层 1 不动, 层 2 用便宜的规则压缩 (保留用户消息全文, 截断 Agent 回复, 大工具结果换占位符), 只有滑出层 2 的部分才异步调用 LLM 压缩成摘要。

## Token 估算

- 中文 1 个汉字 ≈ 1 个 token; 英文 4 个字母 ≈ 1 个 token
- 本项目统一按字符数估算: `tokens = ceil(chars / EN_CHARS_PER_TOKEN)`, 默认 4 字符/token; 每条消息另加 3 个 token 的角色/结构开销, AI 消息的 tool_calls、ToolMessage 的 tool_call_id 也计入 (`countTokens`)

## 上下文预算

`budget.compute()` (`server/src/core/budget.ts`) 从模型上下文窗口中切出滑动窗口预算:

```
window  = 模型上下文窗口 (MODEL_CONTEXT_WINDOW 优先, 否则按模型名查 KNOWN_WINDOWS 表, 兜底 32768)

fixed   = 系统提示词 700 + 证据 10 块 * 160 + 摘要 3 段 * 250
          + 最大输出 10000 + 安全边际 1000
peak    = 单轮峰值 = 用户输入 2000 + 6 步 agent * (工具结果 3000 + 单步 AI 输出 500)
sliding = min(20 轮 * 稳态每轮, window - fixed - peak)
稳态每轮 = 2000 + 10000 + 6 步 * 200 (层 2 工具占位符)
```

服务启动时输出一条预算报告 (`window=… fixed=… sliding=… turns=… limited_by=… healthy=…`); 窗口小到装不下 fixed + peak 时 healthy=false。以上数字都可用环境变量调整 (SYSTEM_PROMPT_TOKENS / EVIDENCE_TOKENS_PER_CHUNK / SUMMARY_INJECT_SEGMENTS / SUMMARY_TOKENS_PER_SEGMENT / MAX_OUTPUT_TOKENS / BUDGET_SAFETY_MARGIN / MAX_USER_INPUT_TOKENS / MAX_AGENT_STEPS / TOOL_RESULT_MAX_TOKENS / AGENT_STEP_AI_TOKENS / CONTEXT_BUDGET_TURNS / LAYER1_RATIO)。

## 层降级 (层 1 -> 层 2)

每轮结束后 `settleLayers` 检查: 层 1 的 token 数超过 `sliding * LAYER1_RATIO` (默认 0.7) 时, 把 L 向前推 —— `nextLayer1From` 从最新消息往前累加 token, 找到超出预算的边界, 新的 layer1FromMsgId 持久化到数据库。滑出层 1 的消息下次构建窗口时自动按层 2 压缩。

## 异步摘要 (层 2 -> 摘要)

每轮结束后 `maybeScheduleSummary` 检查: 层 2 (ID 在 (S, L] 的消息) 的 token 数超过 `sliding * (1 - 0.7)` 时, 异步开启 `runSummary` (`server/src/core/summarizer.ts`):

- 异步不阻塞: 用户本轮回复不等摘要; 按会话去重, 同一会话不会并发跑两个摘要任务
- 把这一段对话拼成 "User: … / Agent: …" 交给 SUMMARY_PROMPT (summary 槽位模型, 结构化输出 {summary})
- 摘要规则: 只提炼事实和请求 (问过什么商品、给过的订单号、用户的明确请求、未解决的问题); 不编造对话中没有的内容; 丢弃寒暄; 旧摘要只作背景, 不重复、不合并
- `appendSummarySegment` 写入一条 ConversationSummary 分段 (seq / fromMsgId / uptoMsgId), 并把最近 SUMMARY_INJECT_SEGMENTS (默认 3) 段用换行拼接更新 Conversation.summary, summaryUptoMsgId 推进到 L
- 下一轮窗口只保留新 S 之后的消息; 已被压缩的历史摘要不会被二次压缩

历史摘要不需要全量携带, 一条摘要对应多轮对话, 预算上只按 3 段计。

## 注入模型上下文

主力 agent 每轮看到的消息序列 (`agentMessages`):

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
  // 本轮会话的材料, 紧跟当前消息之后作为一条 user 消息插入
  {
    role: "user",
    content:
      "## Summary of earlier conversation ...\n## Retrieved knowledge evidence [1] ...",
  },
];
```

本轮材料 (turnContext) 按需拼装: 历史摘要 (summarySystem)、知识证据 (带引用编号和「型号必须照抄证据」的约束)、退款流程的订单数据 + 判断要求 (REFUND_JUDGE_HINT)。材料插在窗口尾部而不是头部, 前缀 (system + 历史) 保持稳定, 有利于命中前缀缓存。

指代消解和意图识别节点用的是另一份更轻的历史: 一行摘要 (summaryLine) + 最近 6 条消息的文本 (historyText)。

## langgraph state

langgraph 的 state 是节点间共享的数据结构, 每个节点都可以读写 state。本项目的 ConversationState (`server/src/graph/state.ts`):

- messages: 历史消息 (messagesStateReducer 追加合并), 即消息历史
- summary / summaryUptoMsgId / layer1FromMsgId: 记忆分层坐标
- userId / conversationId
- intent / intentConfidence / route / resolvedQuery: 查询理解的结果
- orderId / orderData: 退款子流程
- evidence / citations / evidenceStrong / evidenceConfidence / retrievedSnapshot / fallbackSource: 检索与置信度
- answer / steps / tokensUsed: 回复与资源消耗
- suggestedActions: 交给前端确认的动作卡片 (选订单 / 工单预览 / 退款表单 / 转人工)
- trace: 各节点的诊断信息 (mergeDict reducer 合并)
