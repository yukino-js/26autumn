---
title: "LLM 接入、表设计与工具设计"
description: "模型槽位如何接 OpenAI 兼容的 Chat Completions 上游, structured() 与系统提示词如何稳定产出 JSON; PostgreSQL/Prisma 的会话、业务、飞轮与审计表如何组织; 工具注册与执行引擎如何做参数校验、超时、重试与审计"
---

## LLM API

业界常见的三种 LLM API 协议:

- OpenAI: Chat Completions 协议
- Anthropic: Messages 协议
- OpenAI: Responses API 协议

本项目统一接 OpenAI 兼容的 Chat Completions 端点: 所有模型调用都经过 `@langchain/openai` 的 ChatOpenAI (`server/src/core/llm.ts`), 换供应商只需要改环境变量。必填项由 `server/src/config.ts` 的 `missingRuntimeConfig()` 启动时检查 (CHAT_MODEL / CHAT_BASE_URL / CHAT_API_KEY / EMBED_API_KEY / RERANK_API_KEY); `getChatModel` 取不到所属槽位的 API key 时直接抛错。

### 模型槽位

三个槽位: chat (主力)、intent (意图分类)、summary (会话摘要)。intent / summary 未配置时逐字段回落到 chat 组 —— `resolveSlot` 返回 `[model, baseUrl, apiKey]` 三元组, 命名槽位里哪一项是空串, 就用 chat 组的对应项:

| 槽位    | 环境变量                                           | 用途                                               |
| ------- | -------------------------------------------------- | -------------------------------------------------- |
| chat    | CHAT_MODEL / CHAT_BASE_URL / CHAT_API_KEY          | 主力 agent、指代消解、查询改写、自检、忠实度评审等 |
| intent  | INTENT_MODEL / INTENT_BASE_URL / INTENT_API_KEY    | 意图分类                                           |
| summary | SUMMARY_MODEL / SUMMARY_BASE_URL / SUMMARY_API_KEY | 会话摘要                                           |

chat 组还支持三个思考/推理扩展参数 (`thinkingKwargs()`, 拼进 modelKwargs):

- CHAT_THINKING: 原样透传为 `thinking.type` (`.env.example` 里的示例值是 adaptive)
- CHAT_REASONING_SPLIT: 只有 `1/true/yes/on` (大小写不敏感) 算真, 转为布尔的 `reasoning_split`
- CHAT_REASONING_EFFORT: 用 zod 枚举校验 `none/minimal/low/medium/high/xhigh/max`, 非法值记 warn 后忽略

`getChatModel(options)` 的默认值: `streaming=false`、`temperature=0.3`、`maxTokens=MAX_OUTPUT_TOKENS` (默认 10000)、`streamUsage=true` (流式响应也回传 usage_metadata, 主力 agent 的 agent_step 日志据此统计每步 token)、`thinking=true`。thinking 显式传 false 时改挂 `thinking={ type: "disabled" }` —— 所有结构化输出调用统一关闭 thinking。

个别模型家族不支持流式工具调用: `needsNonStreamingTools` 检查模型名是否包含 minimax, 命中则由调用方降级为非流式。

### 结构化输出 structured()

`structured(schema)` (`server/src/core/llm.ts`) 封装了全部「LLM 返回 JSON 对象」的场景:

1. `getChatModel({ ..., thinking: false })` + `withStructuredOutput(schema, { method: "functionCalling" })`, zod schema 作为函数调用的参数定义交给模型
2. invoke 返回后再过一遍 `schema.parse` 做 zod 校验
3. 失败自动重试: 返回 null/undefined (模型没给 tool_calls) 或 invoke 抛错时记 warn 并重试, 最多两次尝试, 第二次仍失败则抛错

streaming 默认 true, 但 `needsNonStreamingTools` 命中时强制 false。项目里的调用点: 意图分类 (`core/intent.ts`, slot=intent)、会话摘要 (`core/summarizer.ts`, slot=summary)、查询改写与扩写 (`core/query-understanding.ts`)、证据自检 (`core/selfcheck.ts`)、飞轮问题标准化 (`core/flywheel.ts`)、历史会话问答挖掘 (`kb/mining.ts`)、售后工单字段抽取 (`api/extract.ts`), 以及评测脚本里的忠实度评审 (`server/scripts/eval-*.ts`, 额外传 temperature=0)。

两个不走 structured() 的例外: 主力 agent 用 `getChatModel({ streaming: true }).bindTools(toolDefs)` 跑 ReAct 工具循环 (`graph/nodes.ts` 的 `mainAgent`); 指代消解 (`core/coref.ts`) 直接 `getChatModel()` 接纯文本改写结果, 失败时静默回退原句。

### Prompt 设计

系统提示词集中在 `server/src/core/prompts.ts`, 都是 `ChatPromptTemplate.fromMessages` 的 system + history/human 模板, 定义 agent 的角色、业务范围与行为约束。「不承诺赔偿金额与具体时限、退款时限统一说 subject to the platform's after-sales rules」这类约束在多个 prompt 里重复出现。代表性的几个:

- AGENT_SYSTEM (主力 agent): 工具使用原则 (要具体数据就调对应工具、缺失参数先问用户、绝不编造)、query_faq 结果处理 (sufficient=true 时严格按证据回答并在关键结论后附引用编号, 如 `[1][2]`; sufficient=false 时明确告知「暂未找到相关信息」并引导人工)、禁止承诺的负向知识
- RAG_ANSWER_SYSTEM (纯 RAG 回答): 引用规则之外, 要求型号等标识串从证据原样复制、带条件的结论必须连条件一起说、证据不足时拒答
- FAITHFULNESS_SYSTEM (忠实度评审 judge): 只针对「无中生有的具体事实」判 fabrication, 列出七类豁免 (标准兜底引导、不承诺具体值的兜底话术、跨证据合并结论、不确定语气提醒、无害安全提示、通用常识注释等), 并点名两类最高危的编造 —— 凭空补出具体数字、把数字安到另一条规则的条款上 (起点/范围/责任方张冠李戴), 附真实边界判例
- INTENT_CLASSIFY_SYSTEM: 九类意图判据 + 边界 few-shot, 要求以工具参数返回 intent/confidence 两字段, 不输出自然语言
- 其余: COREF_REWRITE_SYSTEM (指代消解补全成独立问题)、QUERY_REWRITE_SYSTEM / EXPAND_QUERIES_SYSTEM (检索 query 标准化与扩写, 扩写固定 3 条)、SELF_CHECK_SYSTEM (检索质量评审)、MINING_SYSTEM (会话挖掘可复用问答对)、FLYWHEEL_NORMALIZE_SYSTEM (问题标准化 + 候选去重匹配 + AI 建议答案, 三合一输出)、SUMMARY_SYSTEM (滚动摘要, 只蒸馏事实与诉求)、EXTRACT_SYSTEM (工单字段抽取)
- 固定话术 (不经过 LLM): CHITCHAT_REPLY_TEXT / COMPLAINT_REPLY_TEXT / FALLBACK_REPLY_TEXT / SCRIPT_REPLY_CHITCHAT / SCRIPT_REPLY_OTHER, 以及 REFUND_JUDGE_HINT (退款子流程注入的一次性判定任务提示)

## 表设计

PostgreSQL + Prisma (`server/prisma/schema.prisma`, client 生成到 `server/generated/prisma`)。关系数据在 DATABASE_URL 库; LangGraph 检查点用另一个 CHECKPOINTER_DB_URL 库 (见 [workflow](./workflow))。业务表按职责分四组:

### 会话域

- conversation: 会话 —— userId、处理状态 status (默认 active, 创建工单时置为 transferred)、滚动摘要 summary、摘要覆盖点 summaryUptoMsgId、层 1 起点 layer1FromMsgId (后两个坐标支撑分层记忆, 见 [context](./context))
- conversation_summary: 摘要分段 —— seq (会话内序号, 与 conversationId 联合唯一)、fromMsgId、uptoMsgId、content
- message: 消息历史 —— 会话中每条消息的 role、content、toolCalls、toolCallId

### 业务域

- faq: 常见问题 —— question、answer、category (按分类建索引)
- ticket: 人工工单 —— 工单号 ticketNo 是主键 (repository 的 `genTicketNo` 生成 `T + 时间戳 + 序号`)、关联会话、description、ticketType (create_ticket 的 zod 枚举限定 after_sales/complaint/inquiry 三种)、status (默认 pending)
- knowledge_chunk: 知识块 —— category、questions、answer、sectionPath、contentType、isKeyClause、prevChunkId/nextChunkId 邻接链、vectorId、vectorizeStatus (默认 pending)、embedding/embeddingModel; chunk 结构的由来见 [rag](./rag)

### 数据飞轮与评测域

- qa_extraction_staging: 会话挖掘暂存 —— batchNo、sourceRef、question、answer、status (extracted/kept/discarded/approved/rejected)
- low_confidence_question: 飞轮入口 —— rawQuestion、source、reason、检索快照 retrievedChunks、matchedReviewId (外键指向 review_queue)
- review_queue: 待审队列 —— normalizedQuestion、aiSuggestedAnswer、occurrenceCount (默认 1)、reviewStatus (pending_review/approved/rejected)、approvedAnswer
- eval_run: 评测运行记录 —— triggeredBy (默认 scheduled)、datasetSize、metrics
- faith_case: 幻觉案例台账 —— evalId (唯一键)、bucket、query、strategy (默认 hybrid_rerank)、answer、reason、citations、judgeModel、status (unresolved/resolved/dismissed)、seenCount、resolution

### 审计域

- tool_audit_log: 工具调用审计 —— conversationId、toolCallId、toolName、toolSource、mcpServer、arguments、resultSummary、status、errorMessage、retryCount、durationMs

飞轮与评测表的读写闭环见 [observable](./observable)。

## 工具设计

### 内置工具

`server/src/tools/builtin/` 共五个, 由四个模块注册 (faq / orders / refunds / tickets):

| 工具          | 说明                                                                                                              |
| ------------- | ----------------------------------------------------------------------------------------------------------------- |
| query_order   | 订单查询 —— 状态、金额、下单时间、商品、运单号 tracking_no; 系统注入 user_id, 非本人订单返回 order_not_owned 错误 |
| query_product | 商品查询 —— 价格、库存、规格                                                                                      |
| query_faq     | 政策与常见问题查询 —— 混合检索 + 精排 + 自检, 返回带编号的证据或 sufficient=false (细节见 [rag](./rag))           |
| submit_refund | 发起退款 —— 只表示「该订单可退、提交入口已交给用户」, 真正提交要用户在前端表单确认                                |
| create_ticket | 转人工工单 —— 唯一的写工具 (WRITE_TOOLS), 注入 conversation_id                                                    |

订单/商品数据来自 `server/src/tools/business.ts` 的确定性伪随机 mock: FNV-1a 散列做种子 + xorshift 生成, 同样的订单号/商品名永远得到同样的快照; `listUserOrders` 给每个 userId 固定生成一批订单 (含演示单 1001/2002), `ownsOrder` 据此做归属校验。

MCP 工具 (query_logistics、query_warranty、query_return_status) 由两个独立进程提供, 注册进同一个 registry, 见 [MCP 和 Skill](./mcp)。

### 工具注册 (registry.ts)

- LLM 返回的 tool_calls 里只有工具名, registry 保存工具名到 ToolSpec 的映射。ToolSpec 记录 name、description、jsonSchema、invoke、permission (read/write)、source (builtin/mcp)、mcpServer、timeout、maxRetries、injectConversation、injectUserId、formatResult
- permission 不由调用方指定: `permissionFor` 查 WRITE_TOOLS 集合 (当前只有 create_ticket), 其余一律 read
- `defineTool` 接 zod schema, 经 `jsonSchemaOf` 用 `z.toJSONSchema` 导出为 JSON Schema (删掉 `$schema` 字段) 作为模型的 function parameters; `defineRawTool` 给 MCP 工具用, JSON Schema 原样透传
- `scanBuiltin` 惰性 import 四个内置模块触发 register; 重名工具记 warn 并保留先注册者。`getAllSpecs` 合并内置与 `fetchMcpSpecs` 的结果, MCP 工具与内置重名时丢弃 MCP 那份; MCP server 连不上时跳过其工具, 本轮不注册
- 模型看到的工具列表: `mainAgent` 把每个 ToolSpec 映射成 OpenAI function 定义 (`{ type: "function", function: { name, description, parameters } }`) 后 bindTools

### 执行与容错 (engine.ts)

`executeToolCall` 按固定顺序处理一次工具调用:

1. 未知工具名: 直接返回 failed, ToolMessage 内容是 "unknown tool"
2. 参数校验: Ajv 按 jsonSchema 编译校验器 (WeakMap 缓存), 失败时挑 instancePath 最深的那条错误, 连同「修正参数后重试、缺失信息先问用户、不要编造」的指示作为 ToolMessage 返回给模型 (status=validation_blocked); 校验器本身崩溃 (通常是畸形的 MCP schema) 记为 failed
3. 写权限闸: permission=write 且未经用户确认 (confirmed !== true) 时拒绝执行 (status=permission_denied), 确认中断发生在图节点侧, 见 [mcp](./mcp)
4. 系统注入: injectConversation 写入 args.conversation_id, injectUserId 写入 args.user_id —— 身份参数不经过模型, 避免编造或越权
5. 超时: 每次调用用 Promise.race 包 `withTimeout`, 超时抛 ToolTimeoutError。spec.timeout 优先, 否则 MCP 工具用 MCP_TOOL_TIMEOUT (默认 10s)、内置工具用 TOOL_DEFAULT_TIMEOUT (默认 5s); query_faq 因为内部串了检索 + 精排 + 自检, 自设 timeout=30s
6. 重试: 只有瞬时故障 (ToolTimeoutError / 网络 TypeError / AbortError) 才重试, 读工具最多 `spec.maxRetries ?? TOOL_MAX_RETRIES` (默认 2) 次, 退避 `200ms * 已试次数`; 写工具从不自动重试 (engine 对 permission=write 强制 retries=0, 避免超时重试造成重复写入), query_faq 也显式 maxRetries=0
7. 结果整形: `formatContent` 先把 MCP 的 content 块拼成文本、尝试 JSON.parse, 再执行 formatResult 把机器码翻译成自然语言 (如 IN_TRANSIT → "In transit"、EXPIRED → "Warranty expired"; formatter 抛错时透传原始结果), 最后 JSON.stringify (bigint 转字符串)。超长结果按 TOOL_RESULT_MAX_TOKENS (默认 3000) token 截断 —— 经 EN_CHARS_PER_TOKEN (默认 4) 换算成字符数, 在限制附近的换行处切断并附「结果过长已截断」提示
8. 审计: 无论成败都写 tool_audit_log (参数、结果摘要截前 500 字符、status、错误消息、重试次数、耗时) 并打 tool_run 结构化日志; 审计写库失败只记 error, 不影响工具执行

查询为空不算故障: engine 不做特殊处理, 工具如实返回空结果, 由模型如实告知用户。返回给模型的 ToolMessage 带 success/error 状态; 审计里的 status 有 success / failed / timeout / validation_blocked / permission_denied 五种。
