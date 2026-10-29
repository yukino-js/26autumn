---
title: "Yukino Agent2: 电商客服 Agent 的检索、编排、工具与持久化组织方式"
description: "从 server 与 client 源码事实出发, 讲清客服 Agent 如何把 Hono HTTP 层、LangGraph 会话图、四策略检索与两道置信度门禁、可选 Milvus 向量路径、MCP 工具执行、分层记忆与上下文预算组织成一次可中断、可审计的对话"
local_path: "$HOME/github/yukino-ecomm-agent"
---

Yukino Agent2 是一个电商客服 (customer-service) Agent 的 Node.js/TypeScript 实现, 品牌为 Yukino Select, 客服人设名为 Yukino。仓库是一个 pnpm workspace: `server/` 是 Hono + LangGraph 服务端, 把意图分类、知识库检索、ReAct 工具调用、工单与退款流程、低置信数据飞轮和运营后台放进同一个进程; `client/` 是一个 Lit 单页控制台。各子系统另有专页展开: 图编排细节见 [workflow](./workflow), 检索细节见 [RAG](./rag), 工具与 MCP 见 [MCP 和 Skill](./mcp) 与 [LLM 接入、表设计与工具设计](./llm), 记忆与预算见 [会话上下文](./context), 端点清单见 [HTTP API 和管理台](./api), 评测与飞轮见 [可观测性和数据飞轮](./observable)。

本文讨论的不是逐文件走读, 而是这套系统为什么这样组织: 一次对话如何穿过 HTTP、图编排、检索、工具与持久化各层, 四策略检索与两道置信度门禁如何拦住无依据回答, Milvus 为什么是可选的第二条向量路径, 以及工具执行、分层记忆和上下文预算在什么场景下成立。结论均以 server 与 client 的源码为准, 关键处给出仓库相对路径与符号名。

## 一、总体分层与一次对话的生命周期

### 1.1 三层结构与外部依赖

系统可以分成三层: HTTP 接口层、Agent 编排层、知识与数据层。

- 接口层是 Hono 应用 (`createApp`, server/src/server.ts), 挂载 12 个路由模块, 负责参数校验、错误归一化与 SSE 流式输出。
- 编排层是 LangGraph 会话图 (server/src/graph/), 把意图路由、检索、ReAct 工具循环、确定性兜底话术和落库串成一张有状态图, 用 Postgres checkpointer 按会话线程持久化。
- 知识与数据层是 Prisma/PostgreSQL (server/prisma/schema.prisma)、进程内或 Milvus 的检索存储 (server/src/kb/)、工具注册与执行引擎 (server/src/tools/), 以及可选的 Langfuse 追踪 (server/src/core/observability.ts)。

外部上游通过 server/.env 配置 (server/src/config.ts 的 `settings` 对象), 分三个组: 聊天 (`CHAT_MODEL` / `CHAT_BASE_URL` / `CHAT_API_KEY`)、嵌入 (`EMBED_*`, OpenAI 兼容接口, 默认模型 `qwen3.7-text-embedding-flash`)、重排 (`RERANK_*`, 默认模型 `qwen3.7-text-rerank`, 默认协议 `jina`)。意图与摘要可以另配上游 (`INTENT_*` / `SUMMARY_*`), 留空则回落到聊天组 (server/src/core/llm.ts 的 `resolveSlot`)。存储是两套独立的 PostgreSQL: 关系数据用 `DATABASE_URL`, LangGraph 检查点用 `CHECKPOINTER_DB_URL`, 后者在首次启动时由服务端自动建库 (`ensureCheckpointerDatabase`, server/src/graph/runtime.ts)。Milvus 是可选第三方, 只有设置了 `MILVUS_URI` 才启用。

启动时入口先硬校验必填上游 (server/src/index.ts 调用 `missingRuntimeConfig`), 缺失 `CHAT_MODEL`、`CHAT_BASE_URL`、`CHAT_API_KEY`、`EMBED_API_KEY`、`RERANK_API_KEY` 任一项即打印清单并退出; 随后 `scanBuiltin` 导入内置工具模块自注册, 再进入 `startServer`。`startServer` 的顺序是: 数据库连通性检查 (`assertDbReady`) -> 初始化可观测 (`initObservability`) -> 上下文预算自检 (`checkContextBudget`) -> 预热 Milvus (`warmupMilvus`) -> 编译图并建 checkpointer (`initGraph`) -> 创建应用并监听端口。SIGINT/SIGTERM 走优雅关停, 依次关 HTTP server、`closeGraph` 释放 checkpointer 连接、`shutdownObservability` 冲刷追踪缓冲、`closeDb` 断开 Prisma、`flushLogs` 落盘日志后退出。

### 1.2 一次对话的端到端路径

以 POST /api/chat 为例, 一次对话的路径是:

1. 校验请求体 (`chatRequestSchema`), 把用户消息按 `memory.countTokens` 估算 token 并做长度门禁 (`maxUserInputTokens`, 默认 2000), 超限返回 400 (server/src/api/chat.ts)。
2. `streamTurn` 载入或新建会话, 先把用户消息落 Message 表拿到消息 id, 再以 `graphInput` 组装本轮图输入 (server/src/graph/runtime.ts)。
3. 图从 `resolve_reference` 开始, 做指代消解与意图分类, 按意图路由到投诉、闲聊兜底、知识检索、退款流或通用业务分支。
4. 知识分支强制检索, 过两道置信度门禁后进 `main_agent`; 退款分支先取订单号再强制取证; 通用业务分支直接进 ReAct 循环。
5. 图以 `messages` 与 `updates` 两种 streamMode 同时产出, runtime 把增量文本、引用、工具事件、interrupt 和建议动作翻译成 `StreamEvent`, 由 chat.ts 写成 SSE 帧。
6. 图在 `log` 节点把最终回答写回 Message 表; 流结束后 runtime 记录轮次统计 (Langfuse)、做记忆分层结算 (`settleLayers`) 并按需触发后台摘要 (`maybeScheduleSummary`)。

所以“一次对话”在本项目里不是一个函数调用, 而是一次带检查点的图执行: 它可以在中途 suspend (interrupt) 等待前端回传用户选择, 也可以在图内多步循环 (ReAct)。这是整套设计的地基。

### 1.3 为什么用图与 checkpointer

如果只用一个循环函数加全局历史, 会有三个问题: 中断恢复需要一个“挂起点”语义; 追问需要把上一轮的标量输出与消息历史一起带进下一轮; 工具调用与人工确认要在同一状态机上推进。LangGraph 提供了这三者的原语: 条件边表达路由, reducer 表达通道合并策略, checkpointer 按 thread 持久化状态, `interrupt` 让节点在任意点 suspend 并以 `Command({ resume })` 恢复。

代价是状态泄漏: 因为 checkpointer 会把整张状态图按会话线程存下来, 标量通道下一轮会读到上一轮的值。项目用两处设计抵消它: 每轮 `graphInput` 显式重置所有输出通道; 合并型通道 `trace` 用 `null` 作为清零哨兵 (server/src/graph/state.ts 的 `mergeDict`)。第 3.3 节展开。

## 二、HTTP 层: Hono 装配与 zod 边界

### 2.1 应用装配与错误归一化

`createApp` (server/src/server.ts) 的装配很克制: 只挂一个请求级日志中间件 `pinoLogger`, 提供 GET /healthz, 然后把 12 个路由模块全部挂到根路径 (各路由自带 `/api` 前缀)。`notFound` 返回 `{ detail: "Not Found: <path>" }`; `onError` 区分 `HTTPException` (透传 status 与 message) 与未捕获错误 (500 加通用文案, 真实错误只进日志)。这个设计的好处是客户端只需要处理一种错误结构, 而内部异常不会泄漏到响应体。

### 2.2 请求校验与端点分布

所有 JSON body 统一走 `parseJsonBody` (server/src/api/http.ts): 先捕获非法 JSON (400), 再 zod `safeParse`, 失败时取第一个 issue 拼成 `消息(路径)` 形式的 400。共享 schema 集中在 server/src/api/schemas.ts, 例如聊天请求:

```ts
export const chatRequestSchema = z.object({
  user_id: z.string().min(1, "user_id must not be empty"),
  message: z.string().min(1, "message must not be empty"),
  conversation_id: z.number().int().positive().nullable().default(null),
});
```

端点按职责分为四组 (完整清单见 [HTTP API 和管理台](./api)):

| 组         | 端点                                                                                                                        | 作用                                                             |
| ---------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 对话       | POST /api/chat, POST /api/agent, POST /api/actions/resume, POST /api/actions/create-ticket, POST /api/actions/create-refund | 流式对话、非流式对话 (评测用)、interrupt 恢复、动作卡片直接落库  |
| 会话与反馈 | GET /api/conversations (+ /:id/messages), POST /api/feedback, POST /api/extract                                             | 历史查询、点赞点踩、售后信息抽取                                 |
| 知识库运营 | /api/kb/overview, /api/kb/preview, /api/kb/ingest, /api/kb/vectorize, /api/kb/search, /api/kb/staging (+approve/reject)     | 概览、预览、入库、向量化、检索调试、暂存审核                     |
| 评测与后台 | /api/review/\*, /api/rag-eval/\*, /api/admin/\*, /api/jobs/\*, GET /api/observability/overview                              | 低置信审核队列、RAG 看板与忠实度案例、任务运行器、成本与校准概览 |

其中 POST /api/agent 走非流式的 `runTurn`, 返回 `answer`、`tool_calls`、`tool_results`、`suggested_actions` 与 `interrupt`, 主要给离线评测脚本使用 (server/src/api/agent.ts)。POST /api/actions/create-ticket 与 /api/actions/create-refund 是前端动作卡片的直接落库入口 (后者把订单号与原因拼成工单描述, 以 `refund` 类型建单), 不经过图; /api/actions/resume 才走图恢复。

### 2.3 聊天 SSE 帧协议

POST /api/chat 用 `streamSSE` 逐帧转发 `runtime.streamTurn` 产生的事件。帧格式是 data 一行的 JSON, 没有自定义 event 名 (只有错误帧用 `event: error`):

| 载荷                                                               | 含义                                                                    |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| `{ delta }`                                                        | `main_agent` 的增量文本; 三个确定性回复节点的整段回答也以此帧一次性发出 |
| `{ event: "tool", name }`                                          | 工具执行完成 (`submit_refund` 不发此帧)                                 |
| `{ event: "citations", items }`                                    | 引用证据块列表                                                          |
| `{ event: "interrupt", kind, conversation_id, orders?, preview? }` | 图中 suspend (选订单 / 确认工单)                                        |
| `{ event: "actions", items }`                                      | 建议动作 (如退款表单、转人工), 按 type 去重                             |
| `{ event: "done", conversation_id }`                               | 本轮正常结束                                                            |
| `event: error` + `{ message }`                                     | 异常归一化文案                                                          |
| `[DONE]`                                                           | 流结束标记                                                              |

两个细节值得注意。其一, `streamEvents` 在产出 interrupt 事件后立即 return, 所以 interrupt 帧之后直接是 `[DONE]`, 不再有 done 帧——前端因此在收到 interrupt 时从帧里自取 `conversation_id` 并持久化, 供后续恢复使用 (client/app/routes/chat.tsx)。其二, 错误在 `errorMessage` (server/src/api/chat.ts) 里被归一化: `ConversationNotFound` 映射为 “Conversation not found”, 类名以 `Prisma` 开头的错误映射为数据库暂不可用, 其余一律 “The upstream model is temporarily unavailable”。前端不用 EventSource, 而是 fetch + reader 按 `\n\n` 切帧 (client/app/lib/sse.ts 的 `readSSEStream`), 遇到 `event: error` 直接抛错。

## 三、LangGraph 会话图: 拓扑、状态与路由

### 3.1 图的拓扑与表驱动路由

`buildGraph` (server/src/graph/build.ts) 用 StateGraph 定义 12 个节点, 拓扑如下:

```text
START -> resolve_reference -> classify_intent
classify_intent --routeByIntent-->
    escalate        -> complaint_reply -> log
    fallback_script -> script_reply    -> log
    knowledge       -> retrieve_knowledge -> confidence_check
    refund_flow     -> fetch_order -> retrieve_policy -> main_agent
    business        -> main_agent
confidence_check --confidenceGate--> strong -> main_agent
                                     weak   -> fallback_reply -> log
main_agent --shouldContinue--> continue -> agent_tools -> main_agent
                               stop     -> log
log -> END
```

九种意图收敛为五个路由键, 映射表集中在 server/src/graph/routing.ts 的 `INTENT_TO_ROUTE`: `complaint` -> `escalate`, `chitchat` / `other` -> `fallback_script`, `product_inquiry` -> `knowledge`, `refund_return` / `after_sales` -> `refund_flow`, `logistics` / `order` / `human_agent` -> `business`。`routeByIntent` 只做查表, 未知意图兜底 `business`。把意图到出口的映射做成显式表而不是散落的 if, 好处是新增意图只改一处, 且评测脚本可以复用同一张表。

另外两个条件边函数也在 routing.ts: `confidenceGate` 读 `state.evidenceStrong`; `shouldContinue` 检查最后一条消息是否还有 `tool_calls`, 有则继续 ReAct, 或者步数达到 `maxAgentSteps` (默认 6) 时强制停。把步数上限作为硬停止条件, 是为了防止模型在工具循环里空转烧 token。

### 3.2 状态通道与 reducer 设计

`ConversationState` (server/src/graph/state.ts) 用 `Annotation.Root` 定义 23 个通道。绝大多数是标量, 不带 reducer 即取最后写入值; 只有两个通道需要合并语义:

- `messages` 用 LangGraph 内置的 `messagesStateReducer`, 追加消息并按 id 合并。
- `trace` 用自定义 `mergeDict`, 把各节点的诊断信息合并进一个字典。

`mergeDict` 的实现道出一个关键约束: 合并型通道无法用空对象清零, 因为空字典会被合并成“无变化”, 所以 `graphInput` 只能传 `null` 作为重置哨兵 (`b === null` 时返回 `{}`)。这是 reducer 语义与“每轮重置”需求之间的妥协, 也是理解 `graphInput` 为什么必须显式重置的原因。

### 3.3 checkpointer 持久化与每轮状态重置

`initGraph` (server/src/graph/runtime.ts) 先 `ensureCheckpointerDatabase`: 连到维护库 /postgres 执行 CREATE DATABASE, 库名先做 `^[A-Za-z0-9_]+$` 白名单校验以防注入, 竞争失败时容忍 42P04 (duplicate_database)。随后用 `PostgresSaver.fromConnString` 与 `setup` 建表, 图编译时注入 checkpointer。会话线程键就是会话 id: `graphConfig` 里 `thread_id: String(conversationId)`, 同时把 `langfuse_session_id` 写进 metadata 并挂上 Langfuse callbacks。

因为 checkpointer 按 thread 持久化, 标量通道会把上一轮的值泄漏到下一轮, 所以每轮入口 `graphInput` 显式重置所有输出通道: `answer` 清空、`steps` 与 `tokensUsed` 归零、`evidenceStrong` 置 false、`suggestedActions` / `citations` 清空、`trace: null` 等, 只把新的 HumanMessage (id 形如 `db-<msgId>`, 供记忆分层按消息 id 定位) 追加进 `messages`, 并把会话行上的摘要与两个记忆锚点灌入状态。

### 3.4 节点职责与 ReAct 循环

节点实现在 server/src/graph/nodes.ts, 按职责分成四类:

- 入口与分类: `resolve_reference` 先做指代消解与口语改写 (`coref.resolve`), 失败原样透传并把 `coref: passthrough` 记进 trace; `classify_intent` 用结构化输出做九分类 (失败兜底 `other`) 并回填 route, 同时给活跃 trace 打意图标签。
- 检索与门禁: `retrieve_knowledge` 对知识意图强制 RAG, 先查询理解再 `hybrid_rerank` 检索, 过两道门禁后产出 evidence 与 citations; `retrieve_policy` 是退款流的强制取证。
- ReAct: `main_agent` 是推理步, 把 `getAllSpecs()` 转成 function 定义后 `bindTools`, 流式调用聊天模型并累计 `steps` 与 `tokensUsed`; `agent_tools` 是行动步, 所有调用走统一执行引擎。
- 确定性出口: `complaint_reply`、`script_reply`、`fallback_reply` 不调模型, 直接给固定话术与建议动作; `log` 打印轮次日志并把最终回答落库。

`agentMessages` 组装模型上下文时有一个值得注意的约束: 恰好一条 SystemMessage (`AGENT_SYSTEM` 人设)。本轮材料 (历史摘要、检索证据、退款订单数据) 被拼成一条 id 为 `turn-ctx` 的 HumanMessage, 插入到窗口内最后一条用户消息之后 (`turnContext` 与 `withTurnContext`)。这样既保留了“系统提示词是稳定可缓存前缀”的前提, 又让本轮的动态证据只影响最新的消息段。

### 3.5 interrupt 与前端动作闭环

需要人参与的三处被接进图 (agent_tools 与 fetch_order, nodes.ts):

- `create_ticket`: 首个参数校验通过的建单调用触发 `interrupt({ type: "confirm_ticket", preview })`, 前端弹工单预览卡; 恢复时 `confirmed: true` 才真正执行, 取消则带 `denyNote` 告知模型“用户已取消, 勿再主动发起”。同轮多个建单调用只处理第一个, 其余回报“一次只处理一个建单请求”。
- `submit_refund`: 不经执行引擎, 先做归属校验 (`ownsOrder`, 防止绕过), 然后推入 `refund_form` 建议动作, 并提示模型“已交给用户确认, 一句话说明可退后停止”。因此 SSE 里不会出现 `submit_refund` 的 tool 帧 (`streamEvents` 显式跳过该名字)。
- 订单不属于当前用户时 (fetch_order 的循环或 query_order 触发 `notOwned`), 追加 `select_order` 动作, 附该用户全部订单列表。

恢复入口是 POST /api/actions/resume: 请求体校验后, 若 `order_id` 非空则恢复值为该字符串 (供 fetch_order 的 `select_order` interrupt 使用), 否则为 `{ confirmed }` (供 `confirm_ticket` 使用), 然后以 `Command({ resume })` 继续流式执行并复用同一套 SSE 帧协议。

前端 (client/app/routes/chat.tsx) 把这些动作渲染成卡片, 用户点确认/取消或选订单后调用 resume, 并把该消息标记为已决。这就形成一个闭环: 图 suspend, 前端收集用户决定, 图从挂起点重启。写副作用严格放在恢复之后: interrupt 之前节点只做只读工作 (列订单、校验参数), 真正的建单落库发生在 `confirmed` 到达之后。

## 四、知识库检索: 四策略与两道门禁

### 4.1 统一入口与四种策略

`searchKnowledge` (server/src/core/retrieval.ts) 是全部检索的唯一入口, 支持四种 strategy (展开讨论见 [RAG](./rag)):

| strategy      | 行为                                                            |
| ------------- | --------------------------------------------------------------- |
| vector        | 查询向量化后纯稠密检索 (`store.denseSearch`)                    |
| bm25          | 纯稀疏检索 (`store.bm25Search`)                                 |
| hybrid        | 稠密 + BM25 双路召回, RRF 融合, 取前 k                          |
| hybrid_rerank | 召回 `max(k, RECALL_TOP_K)` 条, 再调 rerank 上游精排 (默认策略) |

默认 strategy 是 `hybrid_rerank`, topK 回落 `rerankTopK` (默认 10), 召回宽度 `recallTopK` (默认 50)。入口内置两个与语言和排版相关的处理:

1. 子句拆分与归并: `splitClauses` 按 `[,，;；?？。]` 切分, 只保留长度不小于 4 的子句, 达到 2 条才生效; 每个子句各自检索后用 `mergeRoundRobin` 轮转归并 (按 id 去重, 同一 `section_path` 的后续命中压到尾部)。这里的检索是串行而非并行: 每次子句检索都是一串 embed + rerank 调用, 而 rerank 上游带限流重试, 串行等待恰好起到天然节流作用。整条拆分受 `SUBQUERY_SPLIT` 开关控制。
2. 头尾排布: `arrangeHeadTail` 把排好序的列表重排为 `[第 1 名, 第 3 名..., 第 2 名]`, 利用上下文首尾注意力更强的特性, 让次优证据落在窗口尾部。

### 4.2 进程内检索实现

无 `MILVUS_URI` 时, server/src/kb/store.ts 在进程内完成全部检索:

- 语料缓存: `loadChunks` 从 PG 读全部已向量化 chunk, 以 `knowledgeRevision()` (行数 + 最大 id + 最大 updatedAt 拼成的版本号) 作为缓存失效依据; 每个文档的文本是 `category + "\n" + question + "\n" + answer`, 预计算 tokens 与 tf 词频表。
- 分词器 `tokenize`: 正则 `/[a-z0-9]+|[\u4e00-\u9fff]+/g` 分段——ASCII 词与数字整词保留, CJK 连续段切成字符 bigram (单字保留)。这是无外部分词器依赖下对中文检索的务实方案。
- BM25: 经典公式, 常数 K1 = 1.5、B = 0.75; IDF 用 `log(1 + (N - df + 0.5) / (df + 0.5))`, 每次查询现算 avgdl 与 df, 全量打分后取正分 topK。
- 稠密检索: 手写 cosine, 维度不一致直接报错 (而不是静默补零)。
- hybrid: 两路各召回 recall 条后做 RRF, 平滑常数 K = 60, 与 Milvus 模式服务端融合的 `RRF_K` 一致。

这套实现的取舍很明确: 零外部依赖、可离线跑通, 代价是每次查询全量打分, 只适合中小规模语料; 语料变大时切到 Milvus 是自然的升级路径。

### 4.3 查询理解与证据编排

检索前有两级可选改写, 失败时均退化为原查询 (server/src/core/query-understanding.ts):

- `understand`: 口语转标准问法 + 同义词扩展; 扩展词只拼进 BM25 文本 (`bm25Text`), 不污染向量查询——同义词对稀疏召回有用, 对稠密召回反而可能引入噪声。
- `expandQueries`: 退款流 `retrieve_policy` 用, 生成恰好 3 条检索友好查询 (上限裁剪为 3, 为空则退回原查询)。

指代消解 `coref.resolve` 在图入口执行, 直接走聊天模型并拼 `COREF_REWRITE_PROMPT`, 失败返回原查询。`retrieve_policy` 把 3 条查询的结果按 chunk id 合并, 同一 id 保留更高 rerank 分, 再按分排序并做头尾排布。

### 4.4 两道置信度门禁

`retrieve_knowledge` 节点不直接采信检索结果, 而是依次过两道门 (server/src/graph/nodes.ts 与 server/src/core/confidence.ts):

第一道是数值门, 用四个零成本信号加权:

```text
score = 0.5 * clip01(top1_score)          # 最高 rerank 分
      + 0.2 * min(valid_count, 3) / 3     # rerank 分 >= 0.3 的命中数
      + 0.2 * clip01(margin)              # top1 - top2 的领先幅度
      + 0.1 * key_clause_hit              # top3 是否命中关键条款词 (KEY_TERMS)
```

得分为 0 到 1, 低于 `EVIDENCE_CONFIDENCE_THRESHOLD` (默认 0.26) 即判弱证据, `fallbackSource` 记为 `retrieval_low_conf`。第二道是模型门, `selfcheck.checkSufficient` 用结构化输出让模型判断证据是否足够; 关键点是失败一律按“不足”处理——门禁的职责就是拦住无依据回答, 所以在不确定时宁可转人工。

弱证据出口 `fallbackReply` 除回复兜底话术外, 还会把问题写入低置信池 (`low_confidence_questions` 表), 并记录 reason 与 `retrievedSnapshot`。快照是三态的: 有命中是列表, 检索到但零命中是空数组, 完全没检索是 `null`——这个区分让后续飞轮能分辨“检索不到”与“根本没检索”。

### 4.5 rerank 上游适配

server/src/core/rerank.ts 封装两种 wire 协议, 以 `RERANK_PROTOCOL === "jina"` (默认) 分流: jina 形态请求 `POST {base}/rerank`, base 缺版本段时才补 `/v1`; 任何非 jina 取值走 DashScope 原生路径, 先剥掉 `/v1`、`/v2`、`/compatible-mode`、`/compatible-api` 后缀并补齐 `/api`, 再请求 `{gateway}/api/v1/services/rerank/text-rerank/text-rerank`。响应 schema 同时兼容两种形态: jina/Cohere 顶层返回 `results`, DashScope 嵌套在 `output.results`。

重试策略是 429/500/502/503/504 或连接层异常触发, `RETRIES = 3` 即最多重试 3 次 (加首次共 4 次尝试), 退避 `1500ms * 2^i` 指数增长, 单次请求超时 60 秒。有一个防御性设计: 200 但响应体没有 `results` 列表时直接抛错, 而不是当作“无证据”返回空——否则 `hybrid_rerank` 会静默变空, 把上游网关的形状故障伪装成检索无结果。

## 五、Milvus 可选向量路径

### 5.1 双模式语义

`milvusEnabled()` 仅看 `MILVUS_URI` 是否为空 (server/src/kb/milvus.ts)。两种模式的语义差异不是“有向量库/没向量库”这么简单:

| 维度         | 进程内 (`MILVUS_URI` 空)                         | Milvus 模式                                           |
| ------------ | ------------------------------------------------ | ----------------------------------------------------- |
| 稠密向量存放 | PG `knowledge_chunks.embedding` 列 (JSON 字符串) | Milvus collection, PG 该列保持 null, 仅记 `vector_id` |
| BM25         | 进程内打分 + CJK bigram                          | Milvus 原生 BM25 Function 全文检索                    |
| hybrid 融合  | 进程内 RRF (k=60)                                | Milvus 服务端 RRF (`RANKER_TYPE.RRF`, k=60)           |
| 故障语义     | 不依赖外部服务                                   | 无静默降级: 搜索直接透传 SDK 错误                     |

store.ts 的 `bm25Search`、`hybridSearch`、`denseSearch`、`count` 都在函数开头判断模式, Milvus 模式委托给 milvus.ts, 否则走进程内实现; 上层 `searchKnowledge` 对两种模式完全无感。Milvus 模式刻意不做进程内兜底: 向量库挂了就应该报错, 而不是悄悄返回空结果让客服机器人“失忆”却不报警。

### 5.2 collection schema 与 BM25 Function

`ensureCollection` (server/src/kb/milvus.ts) 幂等建集合, 关键设计:

- 维度模型无关: 从第一条 upsert 的 embedding 长度推断, 不硬编码, 因为 embedding 模型可通过上游配置更换。
- Strong 一致性: 保证双写对账 (PG done 数等于 Milvus count) 与写后即读的确定性。
- 字段: `id` (Int64 主键, autoID false)、`dense` (FloatVector)、`text` (VarChar 16384, `enable_analyzer`, standard analyzer)、`sparse` (SparseFloatVector, `is_function_output`), 外加 question / answer / section_path / content_type / category 五个标量字段。analyzer 选 standard 是因为本库语料是英文。
- BM25 Function: `text_bm25`, 输入 `text` 输出 `sparse`, 服务端派生, upsert 从不直接写 sparse。
- 索引: `dense` 用 AUTOINDEX + COSINE, `sparse` 用 SPARSE_INVERTED_INDEX + BM25, 随后 `loadCollection`。
- 跨进程竞争: 服务器与 vectorize 任务可能并发建集合, 因此 create/createIndex 失败时只要集合最终可用即容忍。

缺少 `text` / `sparse` 字段的旧集合会被 `assertBm25Schema` 检测并抛错, 错误信息直接给出重建命令 (kb-reset、kb-build、kb-vectorize)。这是把“不可用状态”转成“可执行的修复指令”的做法, 避免运维面对一个语义模糊的服务端报错。

### 5.3 双写、预热与运维

`vectorizePending` (server/src/kb/dualwrite.ts) 是两种模式共用的向量化批处理: 批大小 64 (Milvus upsert 粒度), 但 embed 请求进一步拆成 20 条一批, 两个粒度解耦。每个 chunk 的 `text = category + "\n" + questions + "\n" + answer`——同一字符串既被 embed 成 dense, 又作为 BM25 Function 的输入。Milvus 模式 upsert 后统一 flush 再逐条标记 vectorized (PG 只记 `vector_id`); 进程内模式逐条写回 embedding 列。待处理集合的判定 (`listChunksForVectorization`) 还覆盖 embedding 模型变更与两种模式切换后的补写。

服务器启动时 `warmupMilvus` (server/src/server.ts) 预热: Milvus 集合 load 是异步的, 未就绪的集合搜索可能返回空, 因此循环用 `bm25Search("shipping fee", 1, null)` 探测直到有命中, 最多 15 秒, 失败只 warn 不阻塞启动。这是 best-effort, 但它把“服务已就绪”与“向量库已就绪”两种状态解耦开。

部署物料随仓库提供: main.js 的 `milvus-up` 先探测 RPM/DEB 包注册的 `milvus.service` systemd 单元 (适合生产安装), 否则走仓库内 vendored 的 Docker Compose (`server/deploy/milvus/docker-compose.yml`, etcd + MinIO + standalone), 启动后轮询健康检查直到就绪。README 给出的迁移流程是 milvus-up -> 设置 `MILVUS_URI` -> kb-vectorize 重嵌 -> smoke-milvus 冒烟 -> milvus-down。

## 六、工具系统与 MCP

### 6.1 注册表与权限模型

server/src/tools/registry.ts 把两类工具统一成 `ToolSpec`: 内置工具以 zod schema 定义, 经 `z.toJSONSchema` 转成模型可见的 JSON Schema (并剥掉 `$schema` 键); MCP 工具已经是 JSON Schema, 走 `defineRawTool`。内置工具由 `scanBuiltin` 动态导入 `src/tools/builtin/` 下的 faq、orders、refunds、tickets 四个模块并自注册; MCP 工具由 `getAllSpecs` 每轮现拉 (`fetchMcpSpecs`) ——服务端工具变更无需重启。合并顺序是内置优先且稳定: MCP 与内置重名时丢弃 MCP 工具并告警; 顺序必须稳定是因为工具定义位于模型的可缓存前缀, 顺序一变就整段失效。

权限完全由本地名单决定: `WRITE_TOOLS = new Set(["create_ticket"])`, 名字在集合里就是 write。写工具必须经确认流, 读工具默认允许。

### 6.2 内置工具

内置工具共五个, 覆盖订单、商品、退款、FAQ 与工单:

| 工具          | 要点                                                                                                                                                                                                            |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| query_order   | `injectUserId`, 身份注入不接受模型传入; 非本人订单与不存在订单返回同一文案 (`order_not_owned`), 防止工具变成枚举预言机                                                                                          |
| query_product | 返回价格、库存、规格, 数据源是确定性 mock                                                                                                                                                                       |
| submit_refund | 只声明“该订单可退”, 真正提交由 UI 表单完成; 在 `agent_tools` 中被拦截为 `refund_form` 动作卡片                                                                                                                  |
| query_faq     | 复用检索管线: understand -> hybrid_rerank; category 过滤后为空或 top rerank 分低于 `RERANK_MIN_SCORE` (默认 0.3) 即去掉过滤重试, 再过 selfcheck, 输出 sufficient / evidence / citations; 自身超时 30 秒、不重试 |
| create_ticket | 唯一写工具; `injectConversation`; 必须先向用户要描述, 禁止编造; 支持 `DEMO_TICKET_DELAY_SECONDS` 注入延迟                                                                                                       |

业务数据源 server/src/tools/business.ts 是确定性 mock: FNV-1a 哈希喂 mulberry32 PRNG (`seedFrom`), 同一 key 永远产出同一订单快照; 演示订单固定为 1001 与 2002 (`DEMO_ORDER_IDS`), 每个用户再派生 2 到 4 个随机订单; `ownsOrder` 对空 userId 一律拒绝——身份只能注入, 不能由用户或模型提供。

### 6.3 执行引擎

`executeToolCall` (server/src/tools/engine.ts) 是所有工具调用 (内置与 MCP) 的唯一执行路径, 流水线是:

1. 未知工具 -> `failed` 加审计。
2. `validateArgs`: ajv 按工具自身 JSON Schema 校验模型入参, 校验器按 spec 缓存在 WeakMap; 校验失败返回 `validation_blocked` 并提示模型修正参数或向用户要信息。校验器崩溃 (通常是畸形 MCP schema) 也归一为 `failed`, 不让一个坏工具拖垮整轮。
3. 写工具门禁: permission 为 write 且 `options.confirmed !== true` 一律 `permission_denied`, 确认令牌来自 interrupt 恢复。
4. 注入参数在校验之后追加 (`conversation_id`、`user_id`), 因此不出现在对模型可见的 schema 里。
5. 超时与重试: 超时取 spec 覆盖, 否则内置 5 秒、MCP 10 秒; 瞬时错误 (超时、TypeError、AbortError) 对读工具重试 (默认 2 次, 退避 `200ms * 次数`), 写工具 0 次。每次调用都有超时 (写也一样), 避免一个卡住的写操作拖死整轮。
6. 结果整形: MCP 的 content blocks 抽取文本、尝试解析 JSON, 有 `formatResult` 就套用, 最后按 `TOOL_RESULT_MAX_TOKENS` 截断, 防止超长工具结果撑爆上下文。
7. 审计: 每次调用落 `ToolAuditLog` (会话、工具名、来源、MCP 服务、入参、结果摘要、状态、重试数、耗时), 审计写失败不影响工具执行; 同时打结构化 `tool_run` 日志。

结果格式化发生在主服务而不是 MCP 服务端: server/src/tools/mcp-client.ts 为 query_logistics、query_warranty、query_return_status 各配了 `ResultFormatter`, 把内部枚举 (如 `IN_TRANSIT`) 翻译成面向用户的文案, 并丢弃内部字段 (`status_code`、`warranty_code`、`return_code`)。这样做让 MCP 服务端只暴露原始语义, 展示层的措辞由调用方统一控制。

### 6.4 MCP 客户端与 mock 服务端

两个 mock 服务是独立进程, 用官方 `@modelcontextprotocol/server` 的 `McpServer` 加 `createMcpHandler` 挂在 Hono 的 /mcp 路径上, 只监听 `127.0.0.1`: logistics (默认 8101) 提供 query_logistics, aftersales (默认 8102) 提供 query_warranty 与 query_return_status。两者都支持 `MOCK_DELAY_SECONDS` 注入延迟, 用来演练客户端超时与审计路径。主服务侧每次调用新建一个客户端连接 (fresh session per call), `listTools` 每轮现拉, 不可达的服务只 warn 并跳过, 畸形 input schema 的工具也跳过 (详见 [MCP 和 Skill](./mcp))。

工具描述里写入了调用约束 (如“运单号不是订单号, 先用 query_order 拿 tracking_no”), 这体现了一个设计意图: 多工具链的编排不必写死在代码里, 可以靠工具描述引导模型。这在 mock 阶段很划算, 但描述同时也是模型可见上下文, 需要控制篇幅。

## 七、记忆分层与上下文预算

### 7.1 三锚点窗口

server/src/core/memory.ts 的 `buildWindow` 用两个会话级消息 id 锚点把历史切成三层 (完整讨论见 [会话上下文](./context)):

```text
id <= summaryUpto            已摘要层: 不渲染原文, 只注入摘要行
summaryUpto < id <= layer1   第 2 层: 半压缩渲染 (toLayer2)
id > layer1                  第 1 层: 逐字原文
```

消息 id 来自入口给用户消息打的 `db-<msgId>`, 所以锚点能跨轮、跨进程稳定定位。锚点缺失时退化为单层原文加按 token 裁剪 (`trimHistory`: 从头部逐条丢弃直到入预算, 且首条必须是 HumanMessage, 避免留下半轮对话或孤儿工具结果)。

第 2 层压缩 (`toLayer2`) 的规则: 助手回复截断到 `layer2ReplyKeepChars` (默认 60 字符) 并附省略标记; 工具结果超过 `layer2ToolKeepTokens` (默认 200 token) 即替换为 `(Called xxx; result omitted)`; AIMessage 的 `tool_calls` 必须保留, 因为后续 ToolMessage 按 `tool_call_id` 引用, 丢掉会让历史不合法。

### 7.2 第一层预算与边界推进

layer1 是逐字原文层, 它的预算取滑窗额度的 `layer1Ratio` (默认 0.7)。每轮结束后 `settleLayers` (server/src/graph/runtime.ts) 计算第 1 层 token, 超过预算就调用 `memory.nextLayer1From` 把边界一次性前移, 并持久化到会话行的 `layer1FromMsgId`。结算失败只记日志, 不影响本轮回复。

这里的关键取舍是: 边界一次移动一大步, 而不是每轮挪一点。渲染出的前缀要在一段时间内保持字节稳定, 否则模型侧的 prompt cache 每轮都失效。这解释了为什么“激进压缩”在 LLM 应用里常常比“温和压缩”更省成本。

### 7.3 后台分段摘要

server/src/core/summarizer.ts 负责把第 2 层压缩成摘要段: 一轮结束后若第 2 层超预算 (预算是滑窗额度的 `1 - layer1Ratio`), 触发 `runSummary`, 只摘要 `summaryUptoMsgId` 到 `layer1FromMsgId` 之间的新增段, 已有段永不重摘; 同会话用 running Map 防并发 (并在 await 后重查一次防 TOCTOU)。摘要走独立的 summary 模型槽, 结果以新 seq 追加进 `ConversationSummary` 表, 并在同一事务里把投影后的总摘要与 `summaryUptoMsgId` 写回会话行。

摘要模型提示词 (`SUMMARY_PROMPT`) 要求“只压缩这一段新对话, 既有摘要仅作背景且不要复述”, 并且“本批未提到的事实不得写入, 即使背景里有”。目的是让摘要可增量拼接而不会随轮数漂移。

### 7.4 上下文预算分账

server/src/core/budget.ts 把模型窗口显式分账, 启动自检 (`checkContextBudget`) 不通过会打 error 并提示调参:

```text
window  = MODEL_CONTEXT_WINDOW 显式值, 否则按模型名查 KNOWN_WINDOWS 表, 兜底 32768
fixed   = system_prompt + evidence(RERANK_TOP_K * 每块) + summary(片段数 * 每段)
          + max_output + safety_margin
peak    = max_user_input + MAX_AGENT_STEPS * (tool_result_max + agent_step_ai)   # 本轮瞬时峰值
sliding = min(CONTEXT_BUDGET_TURNS * steady_per_turn, window - fixed - peak)     # 历史滑窗额度
```

其中 `steady_per_turn` 是 `max_user_input + max_output + MAX_AGENT_STEPS * layer2_tool_keep`。源码特意区分两个“每轮”数字: `turnPeakTokens` 是当前 ReAct 轮的瞬时峰值 (自检用), `historyPerTurn` 是该轮压缩进历史后的稳态占用 (滑窗覆盖轮数用); `healthy` 的判据是至少能覆盖一轮 (`turns >= 1`)。`KNOWN_WINDOWS` 是本地前缀表 (deepseek-flash 1M、minimax-m3 1M、qwen3 128K 等), 因为 OpenAI 兼容的 `/v1/models` 不暴露上下文长度。分账的意义在于把“窗口够不够”从玄学变成可自检的算术: 启动时就知道当前配置能不能安全跑一轮。

## 八、知识库运营与数据飞轮

### 8.1 语料切分

语料是 server/data/kb/ 下 6 个英文 Markdown (product-faq、returns-policy、after-sales-manual、product-specs、member-benefits、billing-shipping), 文件到内容类型的映射集中在 server/src/kb/sources.ts 的 `SOURCE_TYPES`, 离线构建、预览与在线 ingest 共用同一份定义。

切分管线 server/src/kb/chunking.ts 解决三类问题:

- `splitSections` 按 `#` 到 `####` 标题切节, 维护标题栈, 每节携带层级路径; 代码围栏 (反引号或波浪号) 内的 `#` 不当作标题; 首个标题前的内容独立成节。
- `recursiveSplit` 使用 `RecursiveCharacterTextSplitter`, 分隔符序列依次是段落、换行、中文终止符、ASCII 终止符 (`!?;`)、中文逗号、空格、字符。
- `applySentenceOverlap` 做句子级重叠, 从前一块尾部按整句回卷; 大表格按行分组 (`buildChunks` 默认 10 行), 每组重复表头, 前言只留在第一组。

`buildChunks` (server/src/kb/documents.ts) 汇总这些步骤, 默认参数 chunkSize 400、overlap 60: 每块记录 category (父级标题路径)、questions (末级标题)、answer (正文)、sectionPath、contentType, 并用 `isKey` 标记关键条款 (标题加正文前 40 字符命中 `KEY_TERMS`)。

### 8.2 构建链路与任务运行器

离线链路是 kb-build (切分入 `knowledge_chunks`, 幂等: 已存在的文件跳过, 部分存在则报错并指向 kb-repatch) -> kb-vectorize (embed 加写向量并标记 done, 幂等可重跑)。同一套 dualwrite 也被 POST /api/kb/ingest 在线复用。另有 kb-preview (只读预览)、kb-repatch (md 变更原地重嵌)、kb-reset (清空双表与向量)、kb-mine (会话挖掘)。

这些任务同时注册进统一 job runner server/src/core/jobs.ts 的 `JOBS` 表 (共 13 项, 每项含 name / title / argv / needs / heavy), 管理页的 “Re-run” 按钮经 POST /api/jobs/:name 共享同一份注册表; 前端只能提交注册过的 job 名, 永远不可能注入 shell 片段。任务在独立进程里以 detached 方式启动, 日志写 `log/acceptance/<name>.log`, 支持 tail (默认 400 行) 与 stop (对进程组发 SIGTERM, 10 秒后 SIGKILL)。把“能跑什么”收敛为一张服务端注册表, 是让运营页可安全暴露给非工程用户的关键 (详见 [可观测性和数据飞轮](./observable))。

### 8.3 会话挖掘

知识库的第一个增量来源是历史会话挖掘 (server/src/kb/mining.ts): `extractQa` 用 `MINING_PROMPT` 加结构化输出从历史会话批量抽取 QA。schema 用 questions / answers 两个平行数组, 长度不齐时对齐到短者并告警。抽取结果经 `dedupe` (归一化后与既有问题比对) 分成 kept / discarded 两种状态落 `QaExtractionStaging` 表, 走 /api/kb/staging/approve 或 reject 人工审核; 通过者以 `approvedStagingChunk` 入库并立即向量化 (category 为 `conversation_history`)。

### 8.4 低置信飞轮

第二个增量来源是低置信飞轮 (server/src/core/flywheel.ts)。低置信池有三个写入源: 检索弱证据 (`retrieval_low_conf`)、模型自检不足 (`self_check`)、用户点踩 (POST /api/feedback 的 `user_feedback`, 顺带尝试从图状态里取回本轮的检索快照)。游标是 `matchedReviewId IS NULL`, 任务天然幂等。

`processPending` 逐条调 `FLYWHEEL_NORMALIZE_PROMPT` 归一化为 FAQ 式问法, 并给出候选匹配。候选是每行实时拉取的 (最多 200 条), 使同批同义问题能合并到刚创建的行; 模型若返回不在候选列表里的 id 会被判为幻觉并跳过本轮。合并或新建进 `ReviewQueue` 走事务化的认领语义: 合并时 `occurrenceCount` 递增, 新建时先建行再回写引用, 并发抢占失败即放弃。人工在 /api/review/:id/approve 批准后以 `approvedReviewChunk` 入库 (category 为 `flywheel_review`) 并立即向量化, 下一轮即可被检索召回; 写回失败会回滚已插的 chunk 并保持状态不变, 允许重试。

这条链路体现的是“低置信不是丢弃, 而是收集信号”: 兜底回答同时产出一条待审核问题, 让人工把机器的失败样本转成知识。

## 九、数据模型与可观测性

### 9.1 Prisma 模型

server/prisma/schema.prisma 定义 12 个模型, 覆盖会话、消息、分段摘要、工单、FAQ、知识块、挖掘暂存、工具审计、低置信池、审核队列、评测记录与忠实度案例。其中几个设计点值得说明 (表结构与 LLM 接入的完整讨论见 [LLM 接入、表设计与工具设计](./llm)):

- `Conversation` 直接把两个记忆锚点 (`summaryUptoMsgId`、`layer1FromMsgId`) 和总摘要放在会话行上, 因此记忆分层不需要额外查询。
- `KnowledgeChunk` 同时保留 `prev/nextChunkId` 与 `vectorId` / `vectorizeStatus` / `embedding`, 使进程内与 Milvus 两种模式共用一张表。
- `ToolAuditLog` 与 `LowConfidenceQuestion` 是“运营可读”的表, 分别支撑工具审计与数据飞轮; `EvalRun` 与 `FaithCase` 承接评测趋势与忠实度案例台账。

### 9.2 Langfuse over OTel

server/src/core/observability.ts 实现可选 Langfuse 追踪, 未配置时全部退化为 no-op: 三个环境变量 (`LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` / `LANGFUSE_BASE_URL`) 齐全才启用; `initObservability` 用 OpenTelemetry `NodeSDK` 只挂一个 `LangfuseSpanProcessor` 启动, 失败只 warn 继续。图级回调 `graphCallbacks` 带 sessionId、userId 与 `chat-turn` 标签, 会话 id 即 Langfuse session。轮级记录用 `propagateAttributes` 加 `startActiveObservation` 记一条 generation (输入、输出、模型、token 用量); 意图作为 tag 与 metadata 写入活跃 trace (`tagIntent`)。所有追踪调用都吞掉异常——可观测是增强项, 绝不因追踪失败影响业务。本地部署另有 `node main.js langfuse-up` 拉起 vendored 的 Langfuse compose 栈 (详见 [可观测性和数据飞轮](./observable))。

## 十、前端 Lit 工作台

### 10.1 技术选型与路由

client/ 是 pnpm workspace 成员, 一个纯 CSR 的单页控制台: 客服聊天页加运营后台, 无 SSR。技术选型是 Lit 加 `@yukino.js/lit-jsx` (React 风格 JSX 编译成 lit-html 模板), 路由用 `@lit-labs/router`, 样式用 Tailwind v4, 图表用 Chart.js, 动画用框架无关的 motion 与 dotLottie, 图标用 lucide-static 的原始 SVG。路由表在 client/app/components/app-shell.tsx, 共六条: 聊天 (/)、管理概览 (/admin)、知识库 (/kb)、RAG 评测 (/rag-eval)、低置信审核 (/review)、可观测 (/observability), 其余路径落 404 页。

两个架构约束写在 client/README.md 里: 所有元素继承 `LightElement` 渲染到 light DOM, 这样全局 Tailwind 样式才生效 (shadow root 看不到全局样式); 输入框是非受控的, 因为 lit-jsx 把 props 当属性写入, 受控 value 会在每次按键时重置光标。

### 10.2 状态与 SSE 消费

聊天页 client/app/routes/chat.tsx 自己持有会话状态 (SSE 流、interrupt、动作、反馈), 消息以不可变方式更新, 让每个 message-bubble 只在自身 msg 对象变化时重渲染 (Lit 属性标识即 React.memo)。SSE 消费器 `readSSEStream` 按 `\n\n` 切帧, 按 event 字段分发, `event: error` 直接抛错, `[DONE]` 收尾。interrupt 帧到达时立刻持久化帧里的 `conversation_id`; 用户点确认/取消或选订单后走 /api/actions/resume。运营页带 “Re-run” 区块 (job-row 组件), 通过 /api/jobs/:name 触发与终端同一份注册任务。

## 十一、适用场景与设计边界

这套组织方式在以下场景成立:

- 需要人工确认闭环的场景。interrupt 加动作卡片把“写操作”与“人工决定”绑定, 适合退款、建单、改权限这类不可逆动作。
- 有明确证据链要求的问答。两道置信度门禁加引用编号, 让“查不到就说查不到”成为默认行为, 而不是靠提示词祈祷模型不编。
- 可离线演进的运营流程。任务运行器、暂存审核、低置信飞轮把知识库维护做成可审核、可重跑的表单流程。
- 需要向量库可插拔的部署。进程内模式让开发与小规模部署零依赖, Milvus 模式给规模化留出升级路径。

需要明确的边界:

- 业务数据 (订单、商品、物流、保修) 是确定性 mock, 不是真实交易系统; 工具描述与权限设计也以此为前提。
- 没有认证与多租户; `user_id` 由调用方提供, 身份注入只保证“工具不接受模型传入的 user_id”, 不构成鉴权。
- 语料与回答语言为英文, 但检索、切分、分词都保留了中文处理路径 (CJK bigram、中文终止符), 属于为迁移预留的能力。
- 前端是演示型控制台, 运营页图表的数据可得性取决于对应离线任务是否跑过。

把检索、编排、工具与持久化分层, 并让每一层各自可测试、可替换, 是这套实现最值得借鉴的地方; 它牺牲了一些“单文件就能跑通”的简洁, 换来了中断恢复、证据门禁与运营闭环这些客服 Agent 真正需要的性质。
