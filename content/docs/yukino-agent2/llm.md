---
title: "LLM"
---

## LLM API

业界常见的三种协议:

- OpenAI: Chat Completions 协议
- Anthropic: Message 协议
- OpenAI: Responses API 协议

本项目统一接 OpenAI 兼容的 Chat Completions 端点 (@langchain/openai 的 ChatOpenAI), 通过环境变量切换上游。

### 模型槽位

三个槽位: chat (主力)、intent (意图分类)、summary (摘要); intent / summary 未配置时回落到 chat 组 (`resolveSlot`):

| 槽位    | 环境变量                                           | 用途                                               |
| ------- | -------------------------------------------------- | -------------------------------------------------- |
| chat    | CHAT_MODEL / CHAT_BASE_URL / CHAT_API_KEY          | 主力 agent、指代消解、查询改写、自检、忠实度评审等 |
| intent  | INTENT_MODEL / INTENT_BASE_URL / INTENT_API_KEY    | 意图分类                                           |
| summary | SUMMARY_MODEL / SUMMARY_BASE_URL / SUMMARY_API_KEY | 会话摘要                                           |

chat 组还支持 CHAT_THINKING (如 adaptive)、CHAT_REASONING_SPLIT、CHAT_REASONING_EFFORT (none/minimal/low/medium/high/xhigh/max)。`getChatModel` 默认 temperature=0.3、maxTokens=MAX_OUTPUT_TOKENS (默认 10000)、streamUsage=true (流式也返回 token 用量); 需要结构化输出的调用统一关闭 thinking。个别模型家族 (minimax) 不支持流式工具调用, `needsNonStreamingTools` 自动降级为非流式。

### 结构化输出

`structured(schema)` (`server/src/core/llm.ts`): `withStructuredOutput(functionCalling)` + zod 校验, 失败 (没返回 tool_calls 或抛错) 自动重试一次。项目里所有「LLM 返回 JSON」的场景都走这里: 意图分类、会话摘要、查询改写/扩写、证据自检、飞轮标准化、工单字段抽取、忠实度评审等。

prompt 设计: agent 的角色、业务范围、行为约束。主力 agent 的系统提示 AGENT_SYSTEM (`server/src/core/prompts.ts`) 还包括工具使用原则、query_faq 结果处理 (引用编号、sufficient=false 时拒答)、禁止承诺等约束。

## 表设计

PostgreSQL + Prisma (`server/prisma/schema.prisma`):

- conversation: 会话 —— 谁在什么时候开启的会话、处理状态、滚动摘要 summary、摘要覆盖点 summaryUptoMsgId、层 1 起点 layer1FromMsgId
- conversation_summary: 摘要分段 —— seq、fromMsgId、uptoMsgId、content
- message: 消息历史 —— 会话中每条消息的角色、内容、toolCalls、toolCallId
- faq: 常见问题 —— 问题描述、答案、问题类型
- ticket: 人工工单 —— 工单号 (主键)、关联会话、问题描述、问题类型 (after_sales/complaint/inquiry/refund)、处理状态、创建时间
- knowledge_chunk: 知识块 —— 见 RAG 一章的 chunk 结构
- qa_extraction_staging: 会话挖掘暂存 —— batchNo、sourceRef、question、answer、status (extracted/kept/discarded/approved/rejected)
- tool_audit_log: 工具调用审计
- low_confidence_question: 数据飞轮入口 —— 原始问题、来源、原因、检索快照 retrievedChunks、matchedReviewId
- review_queue: 待审队列 —— normalizedQuestion、aiSuggestedAnswer、occurrenceCount、reviewStatus (pending_review/approved/rejected)、approvedAnswer
- eval_run: 评测运行记录 —— triggeredBy、datasetSize、metrics
- faith_case: 幻觉案例台账 —— bucket、query、strategy、answer、reason、citations、judgeModel、status (unresolved/resolved/dismissed)、seenCount、resolution

## 工具设计

内置工具 (`server/src/tools/builtin/`):

- query_order: 订单查询 —— 状态、金额、下单时间、商品、运单号 tracking_no; 系统注入 user_id, 非本人订单返回错误
- query_product: 商品查询 —— 价格、库存、规格
- query_faq: 政策与常见问题查询 —— 混合检索 + 精排 + 自检, 返回带编号的证据或 sufficient=false
- submit_refund: 发起退款 —— 只表示「该订单可退、提交入口已交给用户」, 真正提交要用户在前端表单确认
- create_ticket: 转人工工单 —— 唯一的写工具 (WRITE_TOOLS)

MCP 工具 (见 MCP 一章): query_logistics、query_warranty、query_return_status。

- 工具注册: LLM 返回的 tool_calls 字段中只有工具名, registry 保存工具名到 ToolSpec 的映射。启动时 `scanBuiltin` 加载内置模块, mcp-client 把 MCP 工具注册进同一个 registry (source=mcp)
- 工具定义: `defineTool(name, description, zod schema, handler, injectConversation/injectUserId, timeout, maxRetries, formatResult)`; zod schema 经 `z.toJSONSchema` 导出为 JSON Schema 提供给模型
- 工具调用容错 (`server/src/tools/engine.ts`):
  1. 参数不合法: ajv 按 JSON Schema 校验参数, 失败时把错误信息作为 ToolMessage 返回给模型, 让它修正参数重试 (status=validation_blocked)
  2. 查询为空: 工具如实返回空结果, 模型如实告知用户
  3. 连接器故障与重试: 每次调用带超时 (内置默认 5s、MCP 10s、query_faq 30s); 瞬时故障 (超时 / 网络 TypeError / AbortError) 只对读工具重试, 最多 TOOL_MAX_RETRIES=2 次, 退避 200ms*次数
  4. 对于 create_ticket 等写操作, 网络连接超时不代表工单创建失败 —— 写工具从不自动重试 (engine 强制 retries=0), 且执行前必须经过用户确认, 未确认直接拒绝 (status=permission_denied); 详见 MCP 一章
- 结果处理: formatResult 把机器码翻译成自然语言; 超长结果按 TOOL_RESULT_MAX_TOKENS=3000 token 截断并附提示
- 审计: 每次调用无论成败都写 tool_audit_log
