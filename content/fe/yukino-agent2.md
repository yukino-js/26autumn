---
title: "Yukino Agent2 技术笔记: 电商客服 Agent 的 LangGraph 后端与可插拔检索体系"
description: "基于代码事实梳理 yukino-agent2 的 Hono HTTP 层、LangGraph 会话图、四策略知识库检索、Milvus 可选向量路径、MCP 工具体系与 Lit 前端"
---

> 本机器路径 `$HOME/github/yukino-agent2`

yukino-agent2 是一个电商客服 (customer-service) Agent 的 Node.js/TypeScript 实现, 由一个 Python 版本迁移而来 (`README.md` 首段: "This is the migrated backend of the Python project in `~/Downloads/python`"). 后端品牌为 MeowMeow Select, 客服人设名为 Meow (`AGENTS.md` 中固化为项目规范, 且声明 "Yukino Agent2 is a pure English project", 知识库语料为英文). 本文所有结论均基于仓库真实源码, 关键处给出相对仓库根的文件路径与函数名引用.

## 一、项目快照

本机仓库 2026-09-30 核实 (`git log -1`): HEAD 为 `87b14a2`, 提交日期 2026-09-30; 仓库仅有两个提交 (`67ee80c` Initial commit 与 `87b14a2` "feat: Update npm registry").

| 维度        | 内容                                                                                                                       |
| ----------- | -------------------------------------------------------------------------------------------------------------------------- |
| 定位        | 电商客服 Agent 后端: 意图路由、知识库 RAG、ReAct 工具调用、工单/退款流程、运营后台                                         |
| 语言/运行时 | TypeScript (ESM, `"type": "module"`), 通过 tsx 直接运行, Node 内置 `process.loadEnvFile` 读 `.env` (`src/config.ts:11-14`) |
| HTTP 框架   | Hono 4.13.10 (`hono` + `@hono/node-server` + `hono-pino`)                                                                  |
| Agent 编排  | LangChain/LangGraph: `@langchain/langgraph` 1.4.18, `@langchain/core` 1.2.13, `@langchain/openai` 1.6.0                    |
| 会话持久化  | `@langchain/langgraph-checkpoint-postgres` 1.0.5 (PostgresSaver) + `pg` 8.23.0                                             |
| 关系数据    | Prisma 7.10.0 (`@prisma/client` + `@prisma/adapter-pg`, 输出到 `generated/prisma`)                                         |
| 向量库      | 可选 Milvus Standalone (`@zilliz/milvus2-sdk-node` 3.0.6); 缺省为进程内检索                                                |
| 校验/日志   | zod 4.6.5, pino 10.3.1 + pino-pretty, ajv 8.20.0 (工具参数校验)                                                            |
| 协议/可观测 | `@modelcontextprotocol/server` 与 `client` 2.2.0, Langfuse 5.11.1 (over OpenTelemetry `@opentelemetry/sdk-node` 0.222.0)   |
| 测试        | Vitest 5.0.2 (16 个测试文件, 59 个用例)                                                                                    |
| 前端        | `fe/` 子包: Lit 3.3.3 + `@yukino.js/lit-jsx` + Vite 8.3.1 + Tailwind CSS 4.3.3                                             |
| 包管理      | pnpm workspace (`pnpm-workspace.yaml` 声明 `packages: [fe]`)                                                               |
| 启动        | `pnpm dev` (tsx watch) 或 `node main.js dev` (先拉起两个 MCP mock 服务再 `pnpm dev`)                                       |

版本号取自根 `package.json` 的 dependencies/devDependencies 声明区间, 其中 hono 4.13.10、langgraph 1.4.18、core 1.2.13、checkpoint-postgres 1.0.5、openai 7.23.0 与 `pnpm-lock.yaml` 实际解析版本一致.

### 目录结构

```text
yukino-agent2/
├── main.js               # 任务运行器 (替代旧 Makefile): dev / mcp-up / milvus-up / kb-* / eval-*
├── src/
│   ├── index.ts          # 入口: 校验必填配置 -> scanBuiltin -> startServer
│   ├── server.ts         # Hono 应用装配与启动/关停生命周期
│   ├── config.ts         # .env 配置读取 (settings 对象 + missingRuntimeConfig)
│   ├── logger.ts         # pino 日志
│   ├── api/              # 12 个路由模块 (chat/agent/kb/review/rageval/admin/jobs/...)
│   ├── core/             # llm/intent/coref/retrieval/rerank/confidence/memory/
│   │                     # budget/summarizer/selfcheck/flywheel/observability/jobs/prompts
│   ├── graph/            # LangGraph 图: build/state/nodes/routing/runtime
│   ├── kb/               # 知识库: chunking/documents/sources/store/milvus/dualwrite/mining/dedup
│   ├── tools/            # 工具注册表/执行引擎/MCP 客户端 + builtin/ 内置工具
│   ├── mcp-servers/      # 两个独立进程的 MCP mock 服务 (logistics/aftersales)
│   └── db/               # Prisma client、仓储层 repository、json 工具
├── prisma/schema.prisma  # 12 个数据模型 (PostgreSQL)
├── generated/prisma/     # prisma-client 生成产物 (output 目录)
├── fe/                   # Lit + Vite 前端 (CSR SPA, 客服工作台 + 运营后台)
├── scripts/              # 35 个离线脚本: kb-* / eval-* / smoke-* / validate-*
├── data/kb/              # 6 个英文 Markdown 知识语料
├── deploy/milvus/        # Milvus Standalone docker compose (etcd + MinIO + standalone)
└── tests/                # Vitest 单测与评测样本数据
```

包内路径别名通过 `package.json` 的 `imports` 字段声明 (`#/* -> ./src/*`, `#generated/*`, `#scripts/*`, `#tests/*`), `vitest.config.ts` 用 resolve.alias 复刻了同一套别名.

### 启动方式

```bash
pnpm install                # 仓库根, pnpm workspace
pnpm db:migrate             # prisma migrate deploy, 首次启动前执行
node main.js mcp-up         # 拉起 logistics(:8101) 与 aftersales(:8102) 两个 MCP mock 服务
pnpm dev                    # tsx watch src/index.ts, 默认监听 127.0.0.1:8000
pnpm --filter fe dev        # 前端 Vite dev server (5173), /api/* 代理到后端 8000
```

`node main.js dev` 一条命令等价于后三步: 先 `mcpUp()` 再前台 `pnpm dev` (`main.js:533-542`).

### 环境变量组 (以 `.env.example` 为准)

| 组                   | 变量                                                                   | 说明                                                    |
| -------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------- |
| 对话上游 (必填)      | `CHAT_BASE_URL`, `CHAT_MODEL`, `CHAT_API_KEY`                          | OpenAI 兼容聊天上游; 示例为 deepseek-v4-flash           |
| 思考链               | `CHAT_THINKING`, `CHAT_REASONING_EFFORT`, `CHAT_REASONING_SPLIT`       | adaptive/disabled; MiniMax 专用 reasoning_split         |
| 意图/摘要上游 (可选) | `INTENT_*`, `SUMMARY_*`                                                | 留空则回落到 chat 组 (`src/core/llm.ts:39 resolveSlot`) |
| Embedding (必填)     | `EMBED_MODEL`, `EMBED_API_KEY`, `EMBED_BASE_URL`                       | 默认 qwen3.7-text-embedding-flash, 阿里云兼容网关       |
| Rerank (必填)        | `RERANK_MODEL`, `RERANK_API_KEY`, `RERANK_BASE_URL`, `RERANK_PROTOCOL` | jina (Jina/Cohere 形态) 或 dashscope 原生路径           |
| 存储                 | `DATABASE_URL`, `CHECKPOINTER_DB_URL`                                  | 两个独立 PostgreSQL 库, 后者首启自动创建                |
| 向量库 (可选)        | `MILVUS_URI`, `MILVUS_TOKEN`, `MILVUS_COLLECTION`                      | 空 = legacy 进程内检索; 设置后 Milvus 成为权威向量库    |
| MCP                  | `MCP_LOGISTICS_URL`, `MCP_AFTERSALES_URL`, `DEMO_TICKET_DELAY_SECONDS` | 两个工具服务地址, 默认 8101/8102                        |
| 可观测               | `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASE_URL`      | 三者齐全才启用 Langfuse                                 |
| 服务                 | `HOST`, `PORT`                                                         | 默认 127.0.0.1:8000                                     |

必填项在入口处硬校验: `src/index.ts` 调用 `missingRuntimeConfig()` (`src/config.ts:157-166`), 缺失 CHAT_MODEL / CHAT_BASE_URL / CHAT_API_KEY / EMBED_API_KEY / RERANK_API_KEY 任一项即打印缺失清单并 `process.exit(1)`. 此外还有大量可选的预算与检索调优变量 (`RECALL_TOP_K`, `RERANK_TOP_K`, `SUBQUERY_SPLIT`, `RERANK_MIN_SCORE`, `MAX_AGENT_STEPS`, `MODEL_CONTEXT_WINDOW`, `EVIDENCE_CONFIDENCE_THRESHOLD` 等, 全集见 `src/config.ts:44-155` 的 `settings` 对象).

## 二、HTTP 层: Hono 应用与 zod 校验

### 应用装配

`createApp()` (`src/server.ts:33`) 组装整个应用:

- 中间件只有一个: `pinoLogger({ pino: logger })` (`hono-pino`), 请求级结构化日志.
- 健康检查 `GET /healthz` 返回 `{ ok: true }`.
- 12 个路由模块全部挂载在根路径下 (`app.route("/", xxxRouter)`), 路由内部自带 `/api/*` 前缀.
- `notFound` 返回 FastAPI 风格的 `{ detail }` 404; `onError` 区分 `HTTPException` (透传 status/message) 与未捕获错误 (500 + 通用文案, 真实错误只进日志).

启动顺序 (`startServer`, `src/server.ts:109`): `assertDbReady()` (Prisma 连通性) -> `initObservability()` -> `checkContextBudget()` -> `warmupMilvus()` -> `runtime.initGraph()` (编译图 + checkpointer) -> `serve()`. SIGINT/SIGTERM 触发优雅关停: 关 server, 依次 `closeGraph()`、`shutdownObservability()`、`closeDb()`, 最后 `flushLogs()`.

### 请求校验

所有 JSON body 统一走 `parseJsonBody(c, schema)` (`src/api/http.ts`): 先 `c.req.json()` 捕获非法 JSON (400), 再 zod `safeParse`, 失败时取第一个 issue 拼成 `消息(路径)` 形式的 400 响应. 例如聊天请求 schema (`src/api/schemas.ts:4-8`):

```ts
export const chatRequestSchema = z.object({
  user_id: z.string().min(1, "user_id must not be empty"),
  message: z.string().min(1, "message must not be empty"),
  conversation_id: z.number().int().positive().nullable().default(null),
});
```

### 端点清单

由 `grep` 各路由文件得到 (相对路径 `src/api/*.ts`):

| 端点                                                                                                                                                                     | 文件             | 职责                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- | ---------------------------------------------------------- |
| POST /api/chat                                                                                                                                                           | chat.ts          | 对话 SSE 流式端点                                          |
| POST /api/agent                                                                                                                                                          | agent.ts         | 非流式对话端点 (评测/测试用), 返回 tool_calls/tool_results |
| POST /api/actions/create-ticket, /api/actions/create-refund, /api/actions/resume                                                                                         | actions.ts       | UI 动作卡片回调与 interrupt 恢复                           |
| GET /api/conversations                                                                                                                                                   | conversations.ts | 会话列表                                                   |
| POST /api/feedback                                                                                                                                                       | feedback.ts      | 点赞/点踩反馈                                              |
| POST /api/extract                                                                                                                                                        | extract.ts       | 售后工单信息抽取                                           |
| GET /api/kb/overview, POST /api/kb/preview, /api/kb/ingest, /api/kb/vectorize, /api/kb/search, GET /api/kb/staging, POST /api/kb/staging/approve, /api/kb/staging/reject | kb.ts            | 知识库运营页后端                                           |
| GET /api/review/queue, GET /api/review/:review_id, POST /api/review/:review_id/approve, /api/review/:review_id/reject                                                    | review.ts        | 低置信问题人工审核队列                                     |
| GET /api/rag-eval/overview, GET /api/rag-eval/faith-cases, POST /api/rag-eval/faith-cases/:case_id/status                                                                | rageval.ts       | RAG 评测看板与忠实度案例处置                               |
| GET /api/admin/overview, GET /api/admin/jobs                                                                                                                             | admin.ts         | 管理后台概览                                               |
| GET /api/jobs, POST /api/jobs/:name, GET /api/jobs/:name, POST /api/jobs/:name/stop                                                                                      | jobs.ts          | 任务运行器 HTTP 接口                                       |
| GET /api/observability/overview                                                                                                                                          | observability.ts | 可观测/成本/校准三合一概览                                 |

### 聊天 SSE 协议

`POST /api/chat` (`src/api/chat.ts:29`) 先对入参做长度限制 (`memory.countTokens` 超过 `MAX_USER_INPUT_TOKENS`, 默认 2000 token, 即 400), 然后 `streamSSE` 逐帧转发 `runtime.streamTurn()` 产生的事件:

| 帧           | 载荷                                                               | 含义                             |
| ------------ | ------------------------------------------------------------------ | -------------------------------- |
| (无 event)   | `{ delta }`                                                        | main_agent 节点的增量文本        |
| (无 event)   | `{ event: "tool", name }`                                          | 工具开始执行                     |
| (无 event)   | `{ event: "citations", items }`                                    | 引用证据块列表                   |
| (无 event)   | `{ event: "interrupt", kind, conversation_id, orders?, preview? }` | 图中 interrupt (选订单/确认工单) |
| (无 event)   | `{ event: "actions", items }`                                      | 建议动作 (如退款表单)            |
| (无 event)   | `{ event: "done", conversation_id }`                               | 本轮结束                         |
| event: error | `{ message }`                                                      | 异常归一化文案                   |
| (收尾)       | `[DONE]`                                                           | 流结束标记                       |

错误归一化在 `errorMessage()` (`src/api/chat.ts:18`): `ConversationNotFound` 映射为 "Conversation not found", Prisma 系错误映射数据库暂不可用, 其余一律 "The upstream model is temporarily unavailable". 前端用 fetch + reader 消费该协议 (`fe/app/lib/sse.ts` 的 `readSSEStream`, 注释说明因请求带 body 而不用 EventSource).

## 三、LangGraph 会话图

### 图拓扑

`buildGraph(checkpointer)` (`src/graph/build.ts:10`) 用 `StateGraph` 定义 12 个节点:

```text
START -> resolve_reference -> classify_intent
classify_intent --routeByIntent-->
    escalate          -> complaint_reply -> log
    fallback_script   -> script_reply    -> log
    knowledge         -> retrieve_knowledge -> confidence_check
    refund_flow       -> fetch_order -> retrieve_policy -> main_agent
    business          -> main_agent
confidence_check --confidenceGate--> strong -> main_agent
                                     weak   -> fallback_reply -> log
main_agent --shouldContinue--> continue -> agent_tools -> main_agent   (ReAct 循环)
                               stop     -> log
log -> END
```

意图到出口的映射是显式表驱动: 九个意图收敛为五个路由键 (`src/graph/routing.ts:12 INTENT_TO_ROUTE`), `routeByIntent` 查表, 未知意图兜底 `business`. 三个条件边函数均在 `src/graph/routing.ts`:

- `routeByIntent`: 纯查表.
- `confidenceGate`: `state.evidenceStrong ? "strong" : "weak"`.
- `shouldContinue`: 最后一条消息无 `tool_calls` 即停; 或 `steps >= settings.maxAgentSteps` (默认 6, `src/config.ts:104`) 强制停.

### 状态设计

`ConversationState` (`src/graph/state.ts:43`) 用 LangGraph `Annotation.Root` 定义约 24 个通道, 其中两个带自定义 reducer:

- `messages`: `messagesStateReducer` (追加并按 id 合并).
- `trace`: `mergeDict` 合并字典; 注释说明 `null` 是入口重置哨兵 —— 合并型通道无法用空对象清零, 只能靠 null (`src/graph/state.ts:32-41`).

其余标量通道 (intent, route, evidence, citations, evidenceStrong, evidenceConfidence, orderId, orderData, answer, steps, tokensUsed, suggestedActions, summary, summaryUptoMsgId, layer1FromMsgId 等) 均取最后写入值.

因为 checkpointer 按 thread 持久化状态, 标量通道会把上一轮的值泄漏到下一轮, 所以每轮入口 `graphInput()` (`src/graph/runtime.ts:208`) 显式重置所有输出通道 (answer 清空、steps 归零、`trace: null` 等), 只把新的 `HumanMessage` (id 形如 `db-<msgId>`) 追加进 messages.

### 节点职责 (src/graph/nodes.ts)

| 节点                                            | 函数                      | 职责要点                                                                                                     |
| ----------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------ |
| resolve_reference                               | `resolveReference` (208)  | 指代消解 + 口语改写 (`coref.resolve`), 失败原样透传; 打印 `history_ctx` 日志                                 |
| classify_intent                                 | `classifyIntent` (225)    | 九分类意图 + 置信度 (`src/core/intent.ts:39 classify`, structured output, 失败兜底 other/0)                  |
| retrieve_knowledge                              | `retrieveKnowledge` (242) | knowledge 意图强制 RAG: 查询改写 -> hybrid_rerank 检索 -> 置信度门 -> selfcheck                              |
| confidence_check                                | `confidenceCheck` (313)   | 只记录 gate 决策进 trace, 真正分叉在条件边                                                                   |
| fetch_order                                     | `fetchOrder` (90)         | 退款流第一步: 正则 `(?<!\d)(\d{4,})(?!\d)` 抽订单号 (83 行), 校验归属, 不通过则 `interrupt` 让 UI 弹订单选择 |
| retrieve_policy                                 | `retrievePolicy` (115)    | 退款流强制取证: 扩写 3 条查询, 逐条 hybrid_rerank, 按 chunk id 取最高分合并                                  |
| main_agent                                      | `mainAgent` (396)         | ReAct 推理步: `getAllSpecs()` 转 function 定义后 `bindTools`, 流式调用 chat 模型, 累计 steps/tokensUsed      |
| agent_tools                                     | `agentTools` (449)        | ReAct 行动步: 全部调用走执行引擎; create_ticket 先 interrupt 确认; submit_refund 拦截为 UI 退款表单          |
| complaint_reply / script_reply / fallback_reply | 同名函数 (169/161/181)    | 确定性出口: 投诉话术 + 建议动作、闲聊话术、低置信兜底并把问题写入飞轮池                                      |
| log                                             | `logNode` (589)           | 打印 turn 日志并把最终回答 `appendMessage` 落库                                                              |

最终回答的解析在 `resolveAnswer` (`src/graph/nodes.ts:576`): 优先 `state.answer`, 否则取最后一条 AIMessage 文本.

### Checkpointer 持久化

- `initGraph()` (`src/graph/runtime.ts:85`) 先 `ensureCheckpointerDatabase()`: 连到维护库 `/postgres` 执行 `CREATE DATABASE`, 库名先做 `^[A-Za-z0-9_]+$` 白名单校验 (防注入), 竞争失败时容忍 `42P04 duplicate_database` (`src/graph/runtime.ts:61-83`).
- 随后 `PostgresSaver.fromConnString(CHECKPOINTER_DB_URL)` + `setup()` (saver 自建表/迁移), 图编译时注入 checkpointer.
- 会话线程键就是会话 id: `graphConfig()` 里 `thread_id: String(conversationId)`, 同时把 `langfuse_session_id` 写进 metadata、挂 Langfuse callbacks (`src/graph/runtime.ts:109-115`).
- interrupt 恢复: `POST /api/actions/resume` 携带 `conversation_id` 与 `order_id`/`confirmed` (`src/api/schemas.ts:36 resumeRequestSchema`), 由 runtime 把恢复值喂回图; `fetchOrder` 节点注释强调 interrupt 前只做只读工作, 恢复后节点从头重跑 (`src/graph/nodes.ts:91-92`).

## 四、知识库检索: 四种策略

### 统一入口

`searchKnowledge(query, options)` (`src/core/retrieval.ts:67`) 是全部检索的唯一入口, 支持四种 strategy:

| strategy      | 行为                                                                   |
| ------------- | ---------------------------------------------------------------------- |
| vector        | 查询向量化后纯稠密检索 (`store.denseSearch`)                           |
| bm25          | 纯稀疏检索 (`store.bm25Search`)                                        |
| hybrid        | 稠密 + BM25 双路召回, RRF 融合, 取前 k                                 |
| hybrid_rerank | hybrid 召回 `max(k, RECALL_TOP_K)` 条, 再调 rerank 上游精排 (默认策略) |

默认值: strategy 为 hybrid_rerank, topK 回落 `settings.rerankTopK` (默认 10), 召回宽度 `settings.recallTopK` (默认 50).

入口还内置两个与语言/排版相关的处理:

1. 子句拆分: `splitClauses` 按 `[,，;；?？。]` 切分, 长度不小于 4 的子句达到 2 条才生效 (`src/core/retrieval.ts:9-19`), 每个子句并行检索后用 `mergeRoundRobin` 轮转归并 (按 id 去重, 同 section_path 的后续命中压到尾部), 受 `SUBQUERY_SPLIT` 开关控制 (默认开).
2. 头尾排布: `arrangeHeadTail` (`src/core/retrieval.ts:52`) 把排好序的列表重排为 `[第1名, 第3名..., 第2名]` —— 利用上下文首尾注意力更强的特性, 让次优证据落在窗口尾部.

### 进程内实现 (legacy 模式)

无 `MILVUS_URI` 时, `src/kb/store.ts` 在进程内完成全部检索:

- 语料缓存: `loadChunks()` (75 行) 从 PG 读全部已向量化 chunk, 以 `knowledgeRevision()` 作为缓存失效版本号; 每个文档预计算 `embedding`、`tokens`、`tf` 词频表.
- 分词器 `tokenize` (`src/kb/store.ts:49`): 正则 `/[a-z0-9]+|[\u4e00-\u9fff]+/g` 分段 —— ASCII 词/数字整词保留, CJK 连续段切成字符 bigram (单字保留). 这是无外部分词器依赖下对中文检索的务实方案.
- BM25: 经典公式, 常数 `K1 = 1.5`, `B = 0.75` (`src/kb/store.ts:17-18`), IDF 用 `log(1 + (N - df + 0.5) / (df + 0.5))`, 每次查询现算 avgdl 与 df, 全量打分后取正分 topK (`bm25Search`, 159 行).
- 稠密检索: 手写 cosine (`denseSearch`, 136 行).
- hybrid: 两路各召回 recall 条后做 RRF, 平滑常数 K = 60 (`hybridSearch`, 206 行), 与 Milvus 模式及 Python 原版的 RRFRanker 默认值对齐 (`src/kb/milvus.ts:40-42` 注释).

### Rerank 上游

`src/core/rerank.ts` 封装两种协议: `RERANK_PROTOCOL=jina` 时请求 `POST {base}/rerank` (Jina/Cohere 形态, Python 原版对接 SiliconFlow 的形态); `dashscope` 时剥掉 `/v1`、`/compatible-mode` 等后缀, 走阿里网关原生路径 `{gateway}/api/v1/services/rerank/text-rerank/text-rerank` (`rerankUrl()`, 18-43 行). 重试策略: 429/500/502/503/504 触发, 最多 3 次, 退避 1500ms (`rerank.ts:10-12`). 返回按 `relevance_score` 降序, 输出 `[index, score]` 对供 `searchKnowledge` 回填 `rerank_score`.

### 证据置信度与两道门禁

`retrieve_knowledge` 节点不直接采信检索结果, 而是过两道门 (`src/graph/nodes.ts:242-311`):

1. 数值门: `computeEvidenceConfidence` (`src/core/confidence.ts:31`) 用四个零成本信号加权:

```text
score = 0.5 * clip01(top1_score)          # 最高 rerank 分
      + 0.2 * min(valid_count, 3) / 3     # rerank 分 >= 0.3 的命中数
      + 0.2 * clip01(margin)              # top1 - top2 的领先幅度
      + 0.1 * key_clause_hit              # top3 是否命中关键条款词 (KEY_TERMS)
```

权重常量在 `src/core/confidence.ts:10-15`; `KEY_TERMS` 定义于 `src/kb/documents.ts:4` (refund/return/timeframe/shipping fee/warranty 等). 得分低于 `EVIDENCE_CONFIDENCE_THRESHOLD` (默认 0.26) 即判弱证据, 走 fallback 并记录 `retrieval_low_conf`. 2. 模型门: `selfcheck.checkSufficient` (`src/core/selfcheck.ts:22`) 用 structured output 让模型判断证据是否足够; 注释明确失败一律按"不足"处理 (门禁的职责就是拦住无依据回答). 不通过则记 `self_check`.

弱证据出口 `fallbackReply` 除回复兜底话术外, 还会把问题写入低置信池 (`low_confidence_questions`), 供数据飞轮后续消化 (`src/graph/nodes.ts:181-184` 注释).

### 查询理解

检索前有两级可选改写, 均以"失败退化为原查询"为设计前提 (`src/core/query-understanding.ts` 头注):

- `understand()` (32 行): 口语转标准问法 + 同义词扩展; 扩展词只进 BM25 文本 (`bm25Text`), 不污染向量查询.
- `expandQueries()` (49 行): 退款流 `retrieve_policy` 用, 生成恰好 3 条检索友好查询.
- 指代消解 `coref.resolve` (`src/core/coref.ts:6`) 在图入口执行, 直接走 chat 模型 pipe `COREF_REWRITE_PROMPT`.

## 五、Milvus 可选向量路径

### 双模式设计

`milvusEnabled()` (`src/kb/milvus.ts:73`) 仅看 `MILVUS_URI` 是否为空. 两种模式的语义差异:

| 维度         | legacy (MILVUS_URI 空)                         | Milvus 模式                                                                  |
| ------------ | ---------------------------------------------- | ---------------------------------------------------------------------------- |
| 稠密向量存放 | PG `knowledge_chunks.embedding` 列 (JSON 数组) | Milvus collection, PG 该列保持 null, 仅记 `vector_id` + 状态                 |
| BM25         | 进程内打分 + CJK bigram                        | Milvus 原生 BM25 Function 全文检索                                           |
| hybrid 融合  | 进程内 RRF                                     | Milvus 服务端 RRF (RANKER_TYPE.RRF, k=60)                                    |
| 故障语义     | 不依赖外部服务                                 | 无静默降级: `denseSearch` 直接透传 SDK 错误 (`src/kb/store.ts:141-146` 注释) |

`store.ts` 的 `bm25Search`/`hybridSearch`/`denseSearch`/`count` 都在函数开头判断模式, Milvus 模式委托给 `milvus.ts`, 否则走进程内实现 —— 上层 `searchKnowledge` 对两种模式完全无感.

### Collection schema

`ensureCollection(dim)` (`src/kb/milvus.ts:209`) 幂等建集合, 关键设计:

- 维度模型无关: 从第一条 upsert 的 embedding 长度推断, 不硬编码 (注释: embedding 模型可通过上游配置更换).
- Strong 一致性: 保证双写对账 (PG done 数 === Milvus count) 与写后即读确定性.
- 字段: `id` (Int64 主键, autoID false), `dense` (FloatVector), `text` (VarChar 16384, `enable_analyzer: true`, `analyzer_params: { type: "standard" }` —— 注释说明 Python 原版中文库用 chinese analyzer, 本库是英文语料故用 standard), `sparse` (SparseFloatVector, `is_function_output: true`), 加 question/answer/section_path/content_type/category 五个标量字段.
- BM25 Function: `text_bm25`, 输入 `text` 输出 `sparse`, 服务端派生, upsert 从不直接写 sparse.
- 索引: dense 用 AUTOINDEX + COSINE, sparse 用 SPARSE_INVERTED_INDEX + BM25, 随后 loadCollection.
- 跨进程竞争: 服务器与 vectorize 任务可能并发建集合, 因此 create/createIndex 失败时只要集合最终可用即容忍 (`src/kb/milvus.ts:205-208` 注释).

旧版只有 dense 路径的集合会被 `assertBm25Schema` (`src/kb/milvus.ts:168`) 检测出缺少 `text`/`sparse` 字段并抛错, 错误信息直接给出重建命令: `node main.js kb-reset && node main.js kb-build && node main.js kb-vectorize`.

### 搜索 API

- `search()` (321 行): dense ANN, `metric_type: "COSINE"`, category 过滤用布尔表达式且 `quote()` 转义防逃逸.
- `bm25Search()` (348 行): `data: text` 直接传原始查询文本到 `sparse` 字段 (SDK 识别 function-output 字段自动发文本占位符).
- `hybridSearch()` (378 行): 两路子请求 (COSINE + BM25) 各召回 `max(topK, recall)` 条, `rerank: { strategy: RANKER_TYPE.RRF, params: { k: 60 } }` 服务端融合, 与 Python 原版 `hybrid_search([dense_req, sparse_req], RRFRanker())` 形态一致.

### 双写与预热

`vectorizePending()` (`src/kb/dualwrite.ts:70`) 是两种模式共用的向量化批处理: 批大小 64 (对齐 Python 原版 upsert 粒度), 但 embed 请求拆成 20 条一批 (阿里云 embed 网关单请求上限), 两个粒度解耦 (`src/kb/dualwrite.ts:57-68`). 每个 chunk 的 `text = category + "\n" + questions + "\n" + answer` —— 同一字符串既被 embed 成 dense, 又作为 BM25 Function 的输入 (`src/kb/dualwrite.ts:79-83`). Milvus 模式 upsert 后统一 `flush()`, 再逐条 `markChunkVectorizedExternal`; legacy 模式逐条写回 embedding 列.

服务器启动时 `warmupMilvus()` (`src/server.ts:90`) 预热: Milvus 集合 load 是异步的, 未就绪的集合搜索会静默返回空, 因此循环用 `bm25Search("shipping fee", 1, null)` 探测直到有命中, 最多 15 秒, 失败只 warn 不阻塞启动 (best-effort, 与 Python 原版 lifespan 探针对齐).

### main.js 的 milvus-up / milvus-down

`main.js:431 milvusUp` 的安装后端探测 (`milvusBackend`, 354 行) 优先 RPM/DEB 包注册的 `milvus.service` systemd 单元 (`systemctl cat` 探测成功即用, 非 root 自动加 `sudo -n`), 否则回落到 vendored 的 `deploy/milvus/docker-compose.yml` (etcd + MinIO + standalone, 卷挂载在 `deploy/milvus/volumes/`, 已 gitignore). 启动后轮询 `http://127.0.0.1:9091/healthz` 直到 200, 预算 3 分钟; 成功提示 gRPC 在 `127.0.0.1:19530`、WebUI 在 9091, 并要求往 `.env` 写 `MILVUS_URI=http://127.0.0.1:19530` 后重启 Node 服务. `milvusDown` (491 行) 对称停止. README 给出的完整迁移流程: milvus-up -> 设 MILVUS_URI -> `node main.js kb-vectorize` 重嵌 -> `node scripts/smoke-milvus.ts` 冒烟 -> milvus-down.

## 六、知识库构建与数据飞轮

### 语料与切分

语料在 `data/kb/` 下 6 个英文 Markdown (product-faq / returns-policy / after-sales-manual / product-specs / member-benefits / billing-shipping), 文件到内容类型的映射集中在 `src/kb/sources.ts:9 SOURCE_TYPES` (faq/policy/manual/spec 四类), 离线构建、预览与运营页 ingest 共用同一份定义.

切分管线 `src/kb/chunking.ts`:

- `splitSections` (34 行): 按 `#`~`####` 标题切节, 维护 h1..h4 标题栈, 每节携带层级路径元数据; 首个标题前的内容独立成节.
- `recursiveSplit` (69 行): `RecursiveCharacterTextSplitter` (@langchain/textsplitters), 分隔符序列兼顾中英文: 段落、换行、`。！？；`、`!?;`、`，`、空格、字符.
- `applySentenceOverlap` (105 行): 句子级重叠 —— 从前一块尾部按整句回卷 overlap 字符数, 英文句号与 CJK 终止符都识别 (`SENT_RE`).
- 表格专项: `isTableBlock`/`splitTableRows` (137/145 行) 把大表按行分组 (默认 10 行), 每组重复表头, 前言只留在第一组.

`buildChunks(md, contentType, chunkSize=400, overlap=60, tableMaxRows=10)` (`src/kb/documents.ts:57`) 汇总上述步骤: 每块记录 category (父级标题路径)、questions (末级标题)、answer (正文)、sectionPath、contentType, 并用 `isKey()` 标记关键条款 (标题 + 正文前 40 字符命中 KEY_TERMS).

### 构建链路与任务运行器

离线链路: `kb-build` (语料切分 -> `knowledge_chunks` 行, `vectorize_status=pending`) -> `kb-vectorize` (embed + 写向量 + 标记 done, 幂等可重跑, `scripts/kb-vectorize.ts`). 同一套 `dualwrite` 也被 `POST /api/kb/ingest` 在线复用. 另有 `kb-preview` (只读预览)、`kb-repatch` (md 变更原地重嵌)、`kb-reset` (清空双表 + 向量)、`kb-mine` (会话挖掘).

这些任务同时注册进统一 job runner `JOBS` (`src/core/jobs.ts:45`, 每个 spec 含 name/title/argv/needs/heavy), `main.js` 命令行与 `POST /api/jobs/:name` 共享同一份注册表 —— README 明确前端只能提交注册过的 job 名, 永远不可能注入 shell 片段.

### 会话挖掘与审核飞轮

知识库有两个增量来源, 都经人工审核后入库:

1. 会话挖掘 (`src/kb/mining.ts`): `extractQa` 用 `MINING_PROMPT` + structured output 从历史会话批量抽取 QA; schema 刻意用 questions/answers 两个平行数组而非对象数组 (注释: 部分兼容上游拒绝嵌套对象数组), 长度不齐时对齐到短者. 抽取结果经 `dedupe` (`src/kb/dedup.ts`) 去重 —— `normalizeQuestion` 去掉所有空白/标点/符号 (Unicode 感知, 保留 CJK) 后比对, 落 `QaExtractionStaging` 表, 走 `/api/kb/staging/approve|reject` 审核; 通过者以 `approvedStagingChunk` 入库 (category=`conversation_history`).
2. 低置信飞轮 (`src/core/flywheel.ts`): 弱证据兜底时写入的 `low_confidence_questions` 是游标 (`matched_review_id IS NULL`, 任务幂等), `processPending` (36 行) 逐条调 `FLYWHEEL_NORMALIZE_PROMPT` 归一化为 FAQ 式问法, 并给出候选匹配 (每行实时拉取候选, 使同批同义问题能合并到刚创建的行), 合并/新建进 `ReviewQueue` (累计 `occurrenceCount`); 人工在 `/api/review/*` 批准后以 `approvedReviewChunk` 入库 (category=`flywheel_review`) 并可反哺检索.

## 七、工具系统与 MCP

### 注册表

`src/tools/registry.ts` 把两类工具统一成 `ToolSpec`:

- builtin: `scanBuiltin()` (123 行) 启动时动态 import `src/tools/builtin/` 下全部模块, 各模块在导入时自注册 (`register`); 重名只保留先注册者.
- MCP: `getAllSpecs()` (163 行) 每轮调用时通过 `fetchMcpSpecs()` (`src/tools/mcp-client.ts:166`) 现拉 `listTools()` —— 服务端工具变更无需重启; 不可达的 MCP 服务只 warn 并跳过. builtin 优先: MCP 与 builtin 重名时丢弃 MCP 工具. 注释说明合并顺序必须稳定, 因为工具定义位于模型的可缓存前缀.

权限完全由本地决定 (`WRITE_TOOLS = new Set(["create_ticket"])`, `src/tools/registry.ts:13`, 注释: 绝不信任服务端描述): 写工具必须经确认流, 读工具默认允许.

### 内置工具

| 工具          | 文件               | 要点                                                                                                                                                                       |
| ------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| query_order   | builtin/orders.ts  | `injectUserId: true` (身份注入, 不接受模型传入); 非本人订单与不存在订单返回同一文案, 防止工具变成枚举预言机                                                                |
| query_product | builtin/orders.ts  | 价格/库存/规格, mock 数据                                                                                                                                                  |
| submit_refund | builtin/refunds.ts | 只声明"该订单可退", 真正提交由 UI 表单完成; 在 `agentTools` 中被拦截为 `refund_form` 动作卡片                                                                              |
| query_faq     | builtin/faq.ts     | 复用检索管线: understand -> hybrid_rerank; category 过滤失败 (空或 top 分低于 `RERANK_MIN_SCORE` 0.3) 自动去掉过滤重试; 再过 selfcheck, 输出 sufficient/evidence/citations |
| create_ticket | builtin/tickets.ts | 唯一写工具; `injectConversation: true`; 必须先向用户要 description, 禁止编造                                                                                               |

业务数据源 `src/tools/business.ts` 是确定性 mock: FNV-1a 哈希喂 mulberry32 PRNG (`seedFrom`), 同一 key 永远产出同一订单快照; 演示订单固定为 1001 与 2002 (`DEMO_ORDER_IDS`, 54 行); `ownsOrder` (84 行) 对空 userId 一律拒绝 —— 身份只能注入, 不能由用户/模型提供.

### 执行引擎

`executeToolCall` (`src/tools/engine.ts:242`) 是所有工具调用 (builtin + MCP) 的唯一执行路径, 流水线:

1. 未知工具 -> failed + 审计.
2. `validateArgs` (72 行): ajv 按工具自身 JSON Schema 校验模型入参, 校验器按 spec 缓存; 校验失败返回 `validation_blocked` 并提示模型修正参数或向用户要信息.
3. 写工具门禁: `permission === "write"` 且 `options.confirmed !== true` 一律 `permission_denied` (确认令牌来自 interrupt 恢复).
4. 注入参数在校验之后追加 (`conversation_id`/`user_id`), 因此不出现在对模型可见的 schema 里.
5. 超时与重试: 超时取 spec 覆盖, 否则 `TOOL_DEFAULT_TIMEOUT` (5s) 或 `MCP_TOOL_TIMEOUT` (10s); 读工具重试 `TOOL_MAX_RETRIES` (2) 次, 写工具 0 次.
6. 审计: 每次调用落 `ToolAuditLog` (会话、工具名、来源、MCP 服务、入参、结果摘要、状态、重试数、耗时), 审计写失败不影响工具执行 (`audit`, 173 行); 同时打 `tool_run` 结构化日志.

结果格式化发生在客户端而非服务端: `src/tools/mcp-client.ts` 为 query_logistics/query_warranty/query_return_status 各配了 `ResultFormatter`, 把内部枚举 (如 `IN_TRANSIT`) 翻译成面向用户的文案, 并丢弃内部字段 (`carrier_code` 等).

### MCP 服务端

两个 mock 服务是独立进程, 用官方 `@modelcontextprotocol/server` 的 `McpServer` + `createMcpHandler` 挂在 Hono 的 `/mcp` 路径上 (Streamable HTTP):

- `src/mcp-servers/logistics.ts` (:8101): `query_logistics`, 按运单号种子化生成状态/城市/轨迹.
- `src/mcp-servers/aftersales.ts` (:8102): `query_warranty` 与 `query_return_status`.

两者都支持 `MOCK_DELAY_SECONDS` 注入延迟, 用来演练客户端超时与审计路径. 工具描述里写入了调用约束 (如"运单号不是订单号, 先用 query_order 拿 tracking_no"), 体现了用描述引导模型编排多工具链的意图.

### interrupt 与 UI 动作闭环

`agentTools` (`src/graph/nodes.ts:449`) 把三个需要人参与的环节接进图:

- create_ticket: 首个参数校验通过的建单调用触发 `interrupt({ type: "confirm_ticket", preview })`, 前端弹工单预览卡; 恢复时 `confirmed: true` 才真正执行, 取消则带 denyNote 告知模型"用户取消, 勿再主动发起". 同轮多个建单调用只处理第一个.
- submit_refund: 不经执行引擎, 先做归属校验 (防止绕过), 然后推入 `refund_form` 建议动作, 并提示模型"已交给用户确认, 一句话说明可退后停止".
- 订单不属于当前用户时 (query_order/submit_refund 触发 `notOwned`), 追加 `select_order` 动作, 附该用户全部订单列表.

## 八、记忆分层与上下文预算

### 三锚点滑窗

`buildWindow(messages, summaryUptoMsgId, layer1FromMsgId)` (`src/core/memory.ts:114`) 用两个消息 id 锚点把历史切成三层:

```text
id <= summaryUpto            已摘要层: 不渲染原文, 只注入摘要行
summaryUpto < id <= layer1   第 2 层: 半压缩渲染 (toLayer2)
id > layer1                  第 1 层: 逐字原文
```

锚点缺失时退化为单层原文 + 按 token 裁剪 (`trimHistory`: 从头部逐条丢弃直到入预算, 且首条必须是 HumanMessage, 避免留下半轮对话或孤儿工具结果).

第 2 层压缩 (`toLayer2`, `src/core/memory.ts:211`): 助手回复截断到 `LAYER2_REPLY_KEEP_CHARS` (默认 60 字符) + "(truncated)"; 工具结果超过 `LAYER2_TOOL_KEEP_TOKENS` (200) 即替换为 "(Called xxx; result omitted)"; AIMessage 的 `tool_calls` 必须保留, 因为后续 ToolMessage 按 `tool_call_id` 引用.

### 后台分段摘要

`src/core/summarizer.ts`: 一轮结束后若第 2 层超预算则触发 `runSummary` —— 只摘要 `summaryUptoMsgId` 到 `layer1FromMsgId` 之间的新增段, 已有段永不重摘 (同会话用 `running` Map 防并发); 摘要走独立的 summary 模型槽; 结果按 seq 追加进 `ConversationSummary` 表, 并推进 `summaryUptoMsgId`. 每轮注入的摘要行由 `memory.summaryLine` 提供.

### 上下文预算

`src/core/budget.ts` 把模型窗口显式分账, 启动自检 (`checkContextBudget`, `src/server.ts:65`) 不通过会打 error 并提示调参:

```text
window  = MODEL_CONTEXT_WINDOW 显式值, 否则按模型名查 KNOWN_WINDOWS 表, 兜底 32768
fixed   = system_prompt(700) + evidence(RERANK_TOP_K * 160) + summary(3 * 250)
          + max_output(10000) + safety_margin(1000)
peak    = max_user_input + MAX_AGENT_STEPS * (tool_result_max + agent_step_ai)   # 本轮瞬时峰值
sliding = min(CONTEXT_BUDGET_TURNS * steady_per_turn, window - fixed - peak)     # 历史滑窗额度
```

注释特意区分两个"每轮"数字 (`src/core/budget.ts:1-6`): `turnPeakTokens()` 是当前 ReAct 轮的瞬时峰值 (自检用), `historyPerTurn()` 是该轮压缩进历史后的稳态占用 (滑窗覆盖轮数用). `KNOWN_WINDOWS` 是本地前缀表 (deepseek-v4-flash 1M、minimax-m3 1M、qwen3 128K 等), 因为 OpenAI 兼容 `/v1/models` 不暴露上下文长度 (`src/core/budget.ts:9-27`).

## 九、数据模型 (Prisma + PostgreSQL)

`prisma/schema.prisma` 定义 12 个模型, generator 输出到 `generated/prisma` (prisma-client provider), datasource 为 postgresql. schema 头注声明枚举类列一律用普通字符串, 并称允许值集中在 `src/db/constants.js`; 但当前仓库 `src/db/` 下只有 client.ts / json.ts / repository.ts, 该 constants 文件不存在 —— 这是一条过时的注释. 实际的枚举约束落在 zod schema 与 `src/db/repository.ts` 的写入逻辑上 (如 `ticket_type` 的三值枚举见 `src/api/schemas.ts:18-22` 与 `src/tools/builtin/tickets.ts` 的 createTicketSchema).

| 模型                  | 职责                                                                                                                                                                                   |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Conversation          | 会话主表: userId, status, summary, summaryUptoMsgId, layer1FromMsgId (两个记忆锚点直接落在会话行上)                                                                                    |
| ConversationSummary   | 分段摘要: (conversationId, seq) 唯一, 记录 fromMsgId/uptoMsgId 区间                                                                                                                    |
| Message               | 消息流水: role, content, toolCalls, toolCallId                                                                                                                                         |
| Faq                   | 经典 FAQ 表 (question/answer/category)                                                                                                                                                 |
| Ticket                | 人工工单: ticketNo 主键 (字符串单号), ticketType, status 默认 pending                                                                                                                  |
| KnowledgeChunk        | 知识库块: category/questions/answer/sectionPath/contentType/isKeyClause, prev/nextChunkId, vectorId, vectorizeStatus (pending/done), embedding (legacy 模式 JSON 数组), embeddingModel |
| QaExtractionStaging   | 会话挖掘暂存区: batchNo, question, answer, status 默认 extracted                                                                                                                       |
| ToolAuditLog          | 工具审计: 会话、调用 id、工具名、来源 (builtin/mcp)、mcpServer、入参、结果摘要、状态、错误、重试数、耗时                                                                               |
| LowConfidenceQuestion | 低置信问题池: rawQuestion, source, reason, retrievedChunks, 可回链 matchedReview                                                                                                       |
| ReviewQueue           | 人工审核队列: normalizedQuestion, aiSuggestedAnswer, occurrenceCount, reviewStatus, approvedAnswer                                                                                     |
| EvalRun               | 评测趋势记录: triggeredBy, datasetSize, metrics (JSON 字符串)                                                                                                                          |
| FaithCase             | 忠实度案例台账: bucket/query/strategy/answer/reason/citations/judgeModel, status 默认 unresolved, seenCount 累计                                                                       |

数据库客户端 `src/db/client.ts` 用 `@prisma/adapter-pg` 的 `PrismaPg` 驱动适配器绑定 `DATABASE_URL`; `assertDbReady()` 在启动时连接并 count 一次 conversation 表. `prisma.config.ts` 用 `process.loadEnvFile(".env")` 让 CLI (migrate/generate) 与运行时共用同一数据库地址. 迁移目录 `prisma/migrations`, 命令 `pnpm db:migrate` (即 `prisma migrate deploy`).

## 十、前端 fe/: Lit 工作台

`fe/` 是 pnpm workspace 成员, CSR-only SPA (`fe/README.md`: 客服聊天页 + 运营后台, 无 SSR). 技术选型 (摘自 fe README 与 `fe/package.json`):

| 关注点 | 选择                                                                                                              |
| ------ | ----------------------------------------------------------------------------------------------------------------- |
| 组件   | Lit 3.3.3 + `@yukino.js/lit-jsx` (React 风格 JSX 编译为 lit-html 模板)                                            |
| 路由   | `@lit-labs/router` (pathname 匹配; query string 靠 `location.search` 手动传递, `fe/app/lib/router.ts` 有专门注释) |
| 样式   | Tailwind CSS v4 (`@tailwindcss/vite`), Material 风格设计令牌在 `app/app.css`, class 切换暗色模式                  |
| 图表   | Chart.js (`app/components/charts.tsx`, 自定义 valueLabels 插件在柱顶绘数值)                                       |
| 动画   | motion 框架无关 `animate()`; dotLottie 装饰动画 (WASM 自托管, `fe/app/main.ts` 中 `setWasmUrl` + preload)         |
| 图标   | lucide-static 原始 SVG                                                                                            |
| 构建   | Vite 8.3.1, 无服务端产物                                                                                          |

路由表在 `fe/app/components/app-shell.tsx:18`, 共 6 条:

| 路径           | 页面                                         | 对应后端                             |
| -------------- | -------------------------------------------- | ------------------------------------ |
| /              | chat-page 客服对话                           | /api/chat (SSE), /api/actions/*      |
| /admin         | 管理后台概览                                 | /api/admin/overview, /api/admin/jobs |
| /kb            | 知识库运营 (预览/ingest/向量化/staging 审核) | /api/kb/*                            |
| /rag-eval      | RAG 评测看板与 faith cases                   | /api/rag-eval/*                      |
| /review        | 低置信审核队列                               | /api/review/*                        |
| /observability | 成本/校准/可观测三面板                       | /api/observability/overview          |

开发联调: `fe/vite.config.ts` 把 `/api` 代理到 `BACKEND_URL ?? http://127.0.0.1:8000` (注释说明 SSE POST 流原样透传), dev server 在 5173. SSE 消费器 `readSSEStream` (`fe/app/lib/sse.ts`) 按 `\n\n` 切帧, 帧类型与后端一一对应, `event: error` 直接抛错, `[DONE]` 收尾. 运营页普遍带 "Re-run from this page" 区块 (`fe/app/routes/observability.tsx` 的 `jobFoot`), 通过 `/api/jobs/:name` 触发与终端同一份注册任务.

## 十一、可观测性: Langfuse over OTel

`src/core/observability.ts` 实现可选 Langfuse 追踪, 未配置时全部退化为 no-op:

- 启用条件: `LANGFUSE_PUBLIC_KEY`/`SECRET_KEY`/`BASE_URL` 三者齐全 (`langfuseEnabled`, 14 行).
- `initObservability` (38 行): `NodeSDK` (@opentelemetry/sdk-node) + `LangfuseSpanProcessor`, 启动失败只 warn 继续.
- 图级回调: `graphCallbacks(sessionId, userId)` (22 行) 返回带 sessionId/userId/tags=[chat-turn] 的 `CallbackHandler` (@langfuse/langchain), 由 `graphConfig` 挂到每次 invoke/stream; metadata 同时写 `langfuse_session_id`, 会话 id 即 Langfuse session.
- 轮级记录: `recordTurn` (82 行) 用 `propagateAttributes` + `startActiveObservation` 记一条 generation (input/output/model/total tokens), 意图作为 tag (`intent:xxx`) 与 metadata; 注释写明可观测是增强项, 一切异常吞掉.
- 关停: `shutdownObservability` 在 server 优雅关停链里 flush.

成本报表 `scripts/cost-report.ts` (job `cost-report`) 依赖 Langfuse 中窗口内的 traces 按意图汇总成本, 展示在 /observability 页面; `src/api/observability.ts` 的 overview 端点把成本、置信度校准、Langfuse 配置状态聚合成一个响应.

## 十二、部署与任务运行器

### main.js 命令表 (节选)

`main.js` 是替代旧 Makefile 的任务运行器 (头注自述), 分两类命令: 前台一次性任务 (spawnSync 流式 stdio, 透传退出码, 额外参数追加, 如 `node main.js eval-rag --skip-gen`) 与后台守护服务.

| 命令                                                                                        | 作用                                                   |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| dev / dev-down                                                                              | 拉起两个 MCP 服务后前台跑 API / 停掉后台服务           |
| mcp-up / mcp-down / mcp-logistics / mcp-aftersales                                          | MCP 服务守护与前台直跑                                 |
| kb-preview / kb-build / kb-vectorize / kb-mine / kb-reset / kb-repatch                      | 知识库离线管线                                         |
| milvus-up / milvus-down                                                                     | Milvus Standalone 生命周期 (systemd 或 docker compose) |
| seed-conv                                                                                   | 灌入历史会话种子数据                                   |
| flywheel                                                                                    | 跑一轮数据飞轮                                         |
| eval-rag / eval-flywheel / eval-retrieval / eval-judge / calibrate-confidence / cost-report | 评测与校准                                             |

守护服务遵循仓库约定: detached spawn, 日志 `log/<name>.log`, pid 文件 `data/<name>.pid`, 启动后跑就绪探测 (http 探测任意状态码即算存活), 探测失败除非 `required: false` 否则置退出码 1 并打印日志尾部 (`daemonUp`/`daemonDown`, `main.js:240/311`). SERVICES 表驱动: 新增一个服务只需加一条表项, `<name>-up`/`<name>-down` 命令自动生成 (`main.js:636-647`). 脚本自注 POSIX-only (detached spawn + node_modules/.bin shims).

### Milvus 部署物料

`deploy/milvus/docker-compose.yml` 是 vendored 的官方 Standalone 编排 (etcd + MinIO + standalone), 数据卷绑定挂载在 `deploy/milvus/volumes/` (gitignore). `main.js` 用 `-f` 指定 compose 文件以保持 project 目录在 deploy/milvus, 使卷落点稳定 (`main.js:450-452` 注释).

## 十三、测试与离线脚本

### Vitest

`pnpm test` (vitest run) 覆盖 16 个测试文件共 59 个用例 (按源码 it/test 块静态统计), 均不走真实上游. 代表性文件:

| 文件                                                                                                                                                 | 关注点                                                     |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| api-contracts.test.ts                                                                                                                                | Hono 应用级契约 (含 /api/agent, /api/chat 的 400/404 行为) |
| retrieval-pipeline.test.ts / retrieval-helpers.test.ts                                                                                               | 检索管线与 rerank 组装                                     |
| kb-store.test.ts                                                                                                                                     | 进程内 BM25/稠密/混合检索 (含 tokenize)                    |
| confidence.test.ts                                                                                                                                   | 置信度公式与信号 (4 个用例)                                |
| memory.test.ts / budget.test.ts                                                                                                                      | 分层窗口裁剪与预算分账                                     |
| tool-engine.test.ts                                                                                                                                  | 执行引擎校验/权限/审计                                     |
| dualwrite.test.ts / chunking.test.ts / dedup.test.ts / repository.test.ts / json.test.ts / model-guard.test.ts / read-notes.test.ts / config.test.ts | KB 双写、切分、去重、仓储、JSON 安全、模型护栏等           |

### 离线脚本 (scripts/, 35 个)

README 将其定位为离线工具: 或直接驱动运行中的服务器, 或直连上游. 按前缀分组:

- `kb-*`: 知识库构建/向量化/挖掘/重置/预览/重嵌 (即 main.js kb 任务的实体).
- `eval-*`: eval-rag (四策略对比)、eval-flywheel (记录一轮趋势)、eval-retrieval、eval-judge、eval-intent、eval-coref、eval-expand、eval-extract、eval-mcp、eval-workflow、eval-agent、eval-context、calibrate-confidence、cost-report. 其中 eval-mcp/eval-workflow 等对 `http://localhost:8000/api/agent` 跑验收用例 (建单三连问: 缺描述先追问 -> 补描述弹 interrupt 预览卡 -> 确认后落 tickets 行 + 审计 success + 回答带单号).
- `smoke-*`: smoke-embed / smoke-rerank / smoke-bm25 / smoke-milvus / smoke-toolcall / smoke-langgraph / smoke-interrupt, 分别冒烟各上游与关键机制.
- `validate-*` 与 `bare-agent-loop.ts`: 样本数据校验与最小 agent 循环基线.

测试数据 (tests/data/) 含 eval_rag.jsonl、query_rewrite_samples.jsonl、retrieval_samples.json 等样本集, 与评测脚本配套.

---

参考文件汇总: `README.md`、`AGENTS.md`、`package.json`、`pnpm-workspace.yaml`、`pnpm-lock.yaml`、`.env.example`、`main.js`、`prisma/schema.prisma`、`prisma.config.ts`、`vitest.config.ts`、`src/` 与 `fe/` 全部源码、`deploy/milvus/docker-compose.yml`. 所有路径均相对 `$HOME/github/yukino-agent2`.
