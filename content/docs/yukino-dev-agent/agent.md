---
title: "Yukino Agent"
description: "OnCall 视角入门: 技术栈与双档模型、RAG 建库与在线问答、Milvus 混合检索流程、ReAct 对话 Agent、Plan-Execute-Replan 运维 Agent 与报告护栏、Tool/MCP、A2UI、知识库管理与自监控"
local_path: "$HOME/github/yukino-dev-agent"
local_commit: "789da32fc0bd86a9c512fe31d616b1d683673d70"
---

yukino-dev-agent 是一个 AI 智能运维 (OnCall) 助手, 把两个产品面合并进单一 Next.js 16 + AI SDK 应用:

- **OnCall** (`/`): 基于 RAG 的运维问答, LLM 生成 A2UI 交互界面, LangGraph Plan-Execute-Replan 运维 Agent 把 Prometheus / Alertmanager 告警转成排查报告
- **DevFlow** (`/dev-flow`): GitHub 工程副驾, 见 [DevFlow](./dev-flow)

两个面都公开、无登录. 正因为无登录, 所有管理面写操作 (知识库重索引/删除、自定义提示词、技能、MCP 连接) 一律由 `ONCALL_ADMIN_TOKEN` 门控 (`lib/ai/admin.ts` 的 `requireOncallAdmin`): Bearer token 或 `x-admin-token` 请求头, 常量时间比较, token 未配置时直接拒绝 (fail-closed). 代码仓库 `~/github/yukino-dev-agent`.

## 技术栈

| 层        | 选型                                                                                    |
| --------- | --------------------------------------------------------------------------------------- |
| 框架      | Next.js 16 App Router + React 19 + TypeScript strict                                    |
| AI SDK    | Vercel AI SDK v7 (`ai`): `streamText` / `generateText` / `tool` / `embed` / `embedMany` |
| LLM       | OpenAI 兼容 (`@ai-sdk/openai`) 或 Anthropic (`@ai-sdk/anthropic`), `LLM_PROVIDER` 切换  |
| Embedding | text-embedding-v4 (`@ai-sdk/openai-compatible`), 批次上限 10 条                         |
| 向量库    | Milvus Standalone (`@zilliz/milvus2-sdk-node`, :19530)                                  |
| 数据库    | PostgreSQL + Prisma 7 (`@prisma/adapter-pg`, 生成到 `generated/prisma`)                 |
| 编排      | LangGraph (`@langchain/langgraph`), 见 [LangGraph](../langgraph)                        |
| 工具协议  | MCP (`@modelcontextprotocol/sdk`)                                                       |
| 可观测    | Langfuse (OTEL) + prom-client + `@yukino.js/sentry` 上报桥                              |
| 前端      | Tailwind v4 + streamdown + A2UI (`@a2ui/react` / `@a2ui/web_core`) + next-intl v4       |

模型分两档 (`lib/ai/models.ts`):

- `thinkModel`: 复杂推理, 用于运维 Agent 的规划、重规划、报告生成和 A2UI 界面渲染
- `quickModel`: 轻量快速, 用于对话、步骤执行、信息抽取

Anthropic 分支在 fetch 层包了一层 (`createAnthropicFetch`): 给缺失 `signature` 的 thinking 块补空签名 (`patchAnthropicThinkingSignatures`), 规避 SDK 解析报错. `providerOptions` 在 Anthropic 下还会按 `ANTHROPIC_THINKING` (默认开启) 输出 thinking 配置, budget 为 `ANTHROPIC_MAX_OUTPUT_TOKENS - 1` (默认 8192).

## LLM 基础

token: 大模型处理文本的基本单位

- 中文 1 个汉字约 1 个 token
- 英文约 4 个字母 1 个 token

消息角色:

- `system`: 系统提示, 定义角色、能力边界、输出格式
- `user`: 用户输入
- `assistant`: 模型输出

结构化输出统一用 AI SDK v7 的 `output: Output.object({ schema })`, 结果在 `.output` 上; 运行时未知数据 (LLM 返回、外部 API 响应、请求体) 一律用 zod `safeParse` / `parse` 校验, 全仓从 `zod/v4` 导入.

## RAG

### 离线建库

1. 将文档切割为 chunk
2. 通过 embedding 模型将 chunk 转换为向量
3. 将向量、chunk 原文、元信息存储到向量库

```json
{
  "content": "iPhone17 支持 7 天无理由退货",
  "vector": [0.12, 0.34, -0.56, 0.78],
  "metadata": {}
}
```

OnCall 的知识库由 `FILE_DIR` (默认 `./data/docs`) 支撑:

- 启动时 `instrumentation.ts` 调 `indexDataDir()`, 把目录下所有 `.md/.markdown/.txt/.pdf/.docx` embed 进 Milvus (`lib/ai/pipelines/knowledge-index.ts`)
- `POST /api/upload` 上传的文件落盘到 `FILE_DIR` 后立即建索引; 单文件上限 50MB, sha256 与已有文件相同则跳过重建

分块用 `@langchain/textsplitters` 的 markdown 感知 `RecursiveCharacterTextSplitter` (`chunkSize = 1000`, `chunkOverlap = 200`), 并从每个 chunk 的标题行提取 `title` 元信息. 索引时给每份文档分类 `knowledgeType` (`sop` / `document` / `diagnostic-case`), 供前端引用芯片展示; 分类优先级: frontmatter 里的 `knowledgeType:` > 文件名 `aiops-case-` 前缀 > 文件名含 `sop` 或正文含 "standard operating procedure" > 默认 `document`.

二进制抽取在 `lib/ai/doc-extract.ts`: PDF 走 unpdf (≤500 页, 加密件拒绝), DOCX 走 mammoth, 但先手工解析 zip 结构做防御 (≤10000 条目、解压后 ≤64MB、加密件拒绝); 两种格式都受 12MB 文件上限和 400 万字符抽取上限约束. 纯文本按 `utf-8-sig` / `utf-8` / `gb18030` / `windows-1252` 顺序探测解码, 混入 NUL 字节的二进制直接拒绝.

### 在线问答

1. 通过 embedding 模型将用户问题转换为 query 向量
2. **召回**: 向量库对 query 向量做相似度搜索, 召回 topK 个最相似的候选 chunk
3. **重排**: 拼接问题和召回的 chunk 原文, 输入 rerank 模型 (cross-encoder 交叉编码), 输出相关性得分, 取最相关的 topK
4. **精排** (optional): 把命中的参考资料拼进提示词

```md
请根据以下参考资料回答用户问题

参考资料

1. xxx
2. yyy
3. zzz
```

## Milvus 混合检索

单个 collection (`MILVUS_COLLECTION`, 默认 `yukino_knowledge`) 同时承载两条召回路 (`lib/milvus/client.ts`):

- **dense 路**: `vector` FloatVector 字段, AUTOINDEX + COSINE 相似度
- **BM25 全文路**: 开启 analyzer (`MILVUS_ANALYZER`, 默认 `standard`) 的 `content` 字段绑定 BM25 Function `content_bm25`, 自动填充 `sparse` 稀疏向量字段, 索引为 SPARSE_INVERTED_INDEX + BM25 度量

collection 的字段还有 `id` (主键)、`source` (来源, 最长 512)、`metadata` (JSON 字符串, 最长 16384)、`created_at`; `content` 最长 `MAX_CONTENT_LENGTH = 8192`. embedding 维度从第一条写入的向量推断, 与存量 collection 维度不匹配时自动 drop 重建.

`retrieve()` (`lib/milvus/retriever.ts`) 的流程:

1. **过量取回**: 需要排除 DevFlow 来源或开启 rerank 时, 候选池取 `min(max(topK * 4, 20), 50)` (默认 topK = 5 时为 20 条), 否则就是 topK
2. **三路并行**: `hybridSearch()` (dense COSINE + sparse BM25 双路 ANN, Milvus 内 RRF 倒排融合, `RRF_K = 60`, 融合输出 `limit = max(候选数, recall=50)`) 给出主序; 同时单跑 dense `search()` 和 `bm25Search()` 只为记录每条候选在各路的排名
3. **隔离**: 未带 `filter` 的调用是 OnCall 视角, 融合后剔除 `dev_flow:` 前缀的来源, DevFlow 的仓库知识不会泄漏进 OnCall 答案; 需要定向检索的调用方显式传 `filter`
4. **精排 (optional)**: 设置了 `RERANK_API_KEY` 时用阿里云 DashScope text-rerank 接口重排 (`lib/ai/rerank.ts`, 默认 `qwen3-vl-rerank`, 超时 10s, 429/5xx 指数退避重试 2 次), 失败则退化为融合顺序
5. **截断**: 取 topK (`DEFAULT_TOP_K = 5`)

每条结果带 `stages` (vector / BM25 / rerank 三阶段的排名和分数), 一路传到前端引用芯片上. RRF 分数只反映排名 (向量余弦 `[-1,1]` 和 BM25 分数量纲不同, 只有排名可比), 需要绝对分数阈值时用仅 COSINE 的 `retrieveDense()`; `retrieveRaw()` 支持 `hybrid` / `dense` / `bm25` 三种方式裸查, 供知识库检索测试使用.

## 对话 Agent (ReAct)

ReAct: Reasoning -> Acting -> Observation, 模型边推理边调用工具, 观察工具结果后继续.

对话管线在 `lib/ai/pipelines/chat.ts`: 系统提示词注入当前日期、RAG 召回的文档、技能目录 (`getSkillCatalogPrompt`)、管理员配置的自定义提示 (`ChatPrompt` 表) 和滚动对话摘要, 用 `quickModel` + `streamText` 流式输出, 工具循环上限 `isStepCount(25)`. `chatStream()` 产出 `ChatStreamEvent` (`text` / `a2ui` / `notice` / `references` / `reasoning` / `tool`), `POST /api/chat_stream` 以 SSE 逐帧推给前端 (事件名 `connected` / `message` / `a2ui` / `references` / `reasoning` / `tool` / `done` / `error`); 非流式的 `chat()` 由 `POST /api/chat` 提供. `references` 携带知识库来源 (标题/来源/分数/摘要/`knowledgeType`) 和各检索阶段排名, 在回复下方渲染成引用芯片.

记忆在 `lib/memory.ts`, 进程内 LRU (最多 100 个 session):

- 滑动窗口保留最近 `MEMORY_WINDOW_SIZE = 6` 条消息
- 滑出窗口的对话对进入 pending 队列 (上限 12 对), 攒到 `SUMMARY_TRIGGER_PAIRS = 6` 对时用 quickModel 折叠成滚动摘要 (≤ `SUMMARY_MAX_CHARS = 1200` 字符), 作为 `## Conversation summary` 注入系统提示, 而不是直接丢弃; 可用 `MEMORY_SUMMARY_ENABLED=false` 关闭

## 运维 Agent (Plan-Execute-Replan)

Plan-Execute-Replan 是一种多 Agent 协作的任务执行模式, 核心是先拆分步骤, 再按计划执行, 动态调整.

| 角色       | 对应节点    | 做什么                             |
| ---------- | ----------- | ---------------------------------- |
| 计划者     | `planner`   | 拿到目标后, 拆解为分步骤的计划     |
| 执行者     | `executor`  | 按计划、一步一步地执行             |
| 计划调整者 | `replanner` | 审查整轮执行结果, 决定是否调整计划 |

实现在 `lib/ai/pipelines/plan-execute-replan/`, 用 LangGraph `StateGraph` 编排五个节点: `planner` / `executor` / `replanner` / `uiify` / `exhausted`. 状态用 `Annotation.Root` 定义 (query / alert / runId / plan / stepIndex / detail / iteration / done / report).

- **Planner**: thinkModel + 结构化输出 (`planSchema`) 生成 `{ steps: string[] }`; 空计划直接走 `exhausted`
- **Executor**: 每次节点运行执行一步, 把步骤文本直接作为 prompt, 带全部工具调 quickModel (`stopWhen: isStepCount(10)`); 护栏: 步骤文本引用了未被发现的工具名时, 该步标记 `[skipped]` 并列出当前可用工具, 不做幻觉调用
- **Replanner**: 整轮步骤跑完后介入, thinkModel + `replanSchema` 输出 `{ done, remaining, summary }` — `done` 为真则进入 `uiify` 收尾; 否则 `remaining` 成为新计划、`stepIndex` 归零继续执行; `iteration` 达到 `MAX_ITERATIONS = 20` 或剩余计划为空则走 `exhausted`. `RECURSION_LIMIT = 525` (20 * 25 + 25) 只是 LangGraph 层面的安全网, 真正的循环闸门是迭代预算

节点通过 `getWriter()` 往 `custom` stream 发布 `PlanExecuteEvent` (`plan_created` / `step_start` / `step_done` / `replan` / `done` / `error`, zod 判别联合), `index.ts` 的 `runPlanExecuteReplan()` 对每一帧再做一次 schema 校验后才 yield, 非法帧被丢弃.

### 报告收尾: 校验、回退与 UI-ify

`uiify` 节点不直接信任模型产出的报告:

1. `cleanMarkdownReport()` 做结构校验 — 报告必须包含「告警分析报告」「活跃告警」「结论」三个标记, 且不是 JSON; 整体被 markdown 代码围栏包裹时先剥壳
2. 校验失败给一次 `regenerateReport()` 重试 (thinkModel, 提示词强制只使用证据、缺证据写「未获取」)
3. 仍失败则用 `fallbackReportContent()` 拼确定性模板报告 — 只含告警字段表格和已执行步骤的证据行 (≤20 条, 每条 ≤500 字符), 明确写明「模型报告两次未通过结构校验, 本模板未采用任何未经验证的推断」, 绝不伪造内容

报告确定后, `uiifyReport()` 用 thinkModel (无工具) 把它可选地渲染成 A2UI 界面; 提示词要求报告是唯一数据源、无结构化内容可渲染时回复 NONE, 失败 (含一次 A2UI 纠正重试) 不丢弃报告.

### 告警入口、持久化与沉淀

- `POST /api/ai_ops`: body 为可选 `{ query?, alert? }`. 不带 alert 时跑默认的巡检模板 (先 `query_prometheus_alerts` 拉全量活跃告警, 再按告警名查 runbook); 带 alert 时生成针对单条告警的诊断 query, 注入归一化字段 (`alert_name` / `severity` / `service` / `state` / `active_at` / `duration` / `description` / `context_url` / `fingerprint` / `source`), 同步返回最终报告
- `POST /api/ai_ops/stream` (`maxDuration = 600`): 以 SSE 直播同一运行, 帧类型为 `run_started` / `plan_created` / `step_start` / `step_done` / `replan` / `done` / `error`, 客户端解析器在 `hooks/aiops-stream.ts`, 运维面板据此画出实时步骤时间线
- `GET /api/ai_ops/runs`: 最近 20 条 `AiOpsRun` 运行历史; `GET /api/active_alerts` 暴露聚合后的活跃告警列表

告警源聚合在 `lib/ai/alerts.ts`: `ALERT_SOURCES` 是一段 JSON 数组 (`name` / `type: prometheus | alertmanager` / `baseUrl` / 可选 basic auth), Prometheus 走 `GET /api/v1/alerts`, Alertmanager 走 `GET /api/v2/alerts`; 单源失败记入 `sourceErrors` 而不拖垮整体, 同名告警跨源去重; 未配置时回退到 `PROMETHEUS_BASE_URL` 单源.

两个持久化环节:

- **运行历史**: 每次运行写一行 `AiOpsRun` (status `running` / `success` / `exhausted` / `failed`、报告全文、告警名); `events` 字段存一条截断的 PlanExecuteEvent 时间线 (≤300 帧, 步骤文本 ≤400 字符、步骤输出 ≤1200 字符, `done` 帧只留标记), 在运维面板的运行历史里渲染. 每次工具调用另记入 `ToolCallAudit` 表, session 为 `aiops:<runId>`
- **案例沉淀**: 报告 ≥200 字符时, `persistDiagnosticCase()` 把它写成 `FILE_DIR/aiops-case-<sha256 前 16 位>.md` (同名去重, 总量上限 200 份, fire-and-forget, 写失败不丢报告), 以 `diagnostic-case` 类型重新建索引并 upsert 一条 `DiagnosticCaseRecord` (hash 唯一、标题、告警名、摘要、文件名), `GET /api/diagnostic_cases` 可查. 后续对话和诊断因此能检索到历史故障

告警排查的典型流程:

1. 根据告警消息, 提取关键信息: 服务名、接口名、错误类型、时间范围
2. 调用日志平台搜索日志, 调用监控平台查询指标
3. 错误归因, 输出故障处理方案

场景: 订单服务接口失败率超过 25%, Agent 故障排查流程:

1. 调用日志平台 API, 搜索最近 1 小时包含错误关键词的日志
2. Agent 发现 90% 的错误日志都是 context cancelled, 通常意味着请求超时被取消
3. 调用监控平台 API, 拉取下游支付服务的响应时间指标
4. Agent 发现下游支付服务的 P99 响应时间 (即 99% 的请求都在该时间内完成) 从 200ms 飙升到 3s
5. 查询知识库, 找到文档: 下游支付服务响应时间异常导致 context cancelled -> 确认下游支付服务是否在发布
6. 总结故障排查流程, 更新知识库

## ReAct 对比 Plan-Execute-Replan

|                | ReAct                              | Plan-Execute-Replan                           |
| -------------- | ---------------------------------- | --------------------------------------------- |
| 思路           | Reasoning -> Acting -> Observation | 先拆分步骤, 再按计划执行, 动态调整            |
| 有没有全局计划 | 没有                               | 有                                            |
| 场景           | 通用                               | 多步骤的复杂任务, 例如运维排查                |
| 执行进度       | 可以观测                           | 方便观测                                      |
| 反馈           | 工具调用                           | 工具调用和 replan 机制调整计划                |
| Agent 数量     | 通常是单 Agent                     | 多 Agent 协作: Planner + Executor + Replanner |

## Tool 和 MCP

工具定义遵循三层拆分: `lib/ai/tools/schemas.ts` (zod) -> `operations.ts` (纯函数) -> `index.ts` (AI SDK `tool` 包装). 内置工具 (`builtinTools`):

| 工具                      | 作用                                                                                                             |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `get_current_time`        | 获取当前时间 (秒 / 毫秒 / 微秒 / 可读时间戳)                                                                     |
| `query_internal_docs`     | RAG 文档检索 (走 Milvus 混合检索)                                                                                |
| `query_prometheus_alerts` | 查询所有配置源的活跃告警, 返回 snake_case 字段 (alertname / description / active_at / severity / context_url 等) |
| `postgres_query`          | 对独立配置的 OnCall 库执行 SQL (`query` / `insert` / `update` / `delete`), 见下                                  |
| `load_skill`              | 按名称读取技能的完整说明                                                                                         |

`postgres_query` 的安全边界在 `lib/ai/tools/postgres.ts`: 连接用独立的 `ONCALL_DATABASE_URL` (DSN 不作为工具参数), 连接前强制校验目标库不能复用应用库或应用角色, 登录后再查一次 `pg_roles`, 命中 superuser / createrole / createdb / replication / bypassrls 等特权或应用角色成员关系即拒绝; 超时设置为连接 5s / 语句 10s / 查询 15s. 未配置该 DSN 时工具直接报不可用.

日志工具走 MCP: `getLogMcpTools()` (`lib/ai/tools/query-log.ts`) 合并两类连接 — 环境变量 `MCP_URL` (内置连接, 名为 `logs`, SSE 传输, 可选 `MCP_TOKEN` Bearer 头) 和管理员通过 `/api/mcp_connections` 添加的多个 `McpConnection` 行 (SSE 或 Streamable HTTP, 可带自定义请求头, 带连通性探测). 每个连接按 `transport | url | headers` 签名缓存工具集 (连接和 listTools 超时 15s), 不可用的连接跳过不阻塞整体; 跨连接重名的工具改名为 `<connection>__<tool>`. 日志查询参数需带 region 和 log topic (可通过 `LOG_TOPIC_REGION` / `LOG_TOPIC_ID` 注入对话提示词).

所有对话和运维的工具调用都 fire-and-forget 记录到 `ToolCallAudit` 表 (session / turn / tool / 来源 builtin | mcp / 截断到 500 字符的输入输出 / 状态 / 耗时), 通过 `GET /api/tool_audits?session=` 读取最近 50 条.

技能和自定义提示也是数据库资产: `SkillAsset` 要求标准 SKILL.md 格式 (YAML frontmatter 含 `name` 和 `description`, name 为 1-64 位小写字母数字连字符, 文件 ≤64KB); `ChatPrompt` 是注入对话提示词的自定义段落 (name ≤160 字符, 内容 ≤12000 字符). 两者的 CRUD 都在 `/api/skills` 和 `/api/prompts`, 全部受 `ONCALL_ADMIN_TOKEN` 门控.

## A2UI (LLM 生成 UI)

A2UI 是声明式的模型生成 UI 协议, 协议本身的机制见 [A2UI](../a2ui). 在本应用里, LLM 在 markdown 回答之后, 可选地追加一个 `<a2ui-json>[...]</a2ui-json>` 块 (A2UI v0.9 消息的 JSON 数组), 用来渲染告警列表、指标表格、表单等交互界面:

- `lib/ai/a2ui/extract.ts` 的流式过滤器把块从文本流里剥离 (跨 chunk 保留未闭合的标签尾部); 校验只用 `@a2ui/web_core/v0_9` 的 `A2uiMessageListSchema`
- 校验失败时给一次无工具的纠正重试 (`lib/ai/a2ui/correct.ts`), 仍失败则降级为诚实的 notice 提示, 绝不伪造 UI 数据
- 组件目录 `catalog/` 注册 18 个基础组件 + 47 个 shadcn 扩展组件 (合计 65 个, 与 `lib/a2ui/prompt/schemas/catalog.json` 的 prompt 侧 schema 一一对应), 另有 25 个内置函数 (`required` / `regex` / `formatNumber` / `openUrl` 等); `/gallery` 页面无后端预览全部组件
- 组件 action 由前端携带 `{ name, surfaceId, sourceComponentId, context }` 和当前界面消息一起 `POST /api/a2ui_action`; 服务端用 quickModel 带工具 (`isStepCount(10)`) 处理后, 只返回针对该 surface 的原地 `updateComponents` / `updateDataModel` 消息, 前端追加渲染

红线: `@a2ui/web_core` 自带 zod v3, 不能把它的 schema 组合进应用的 `zod/v4` combinator; 应用边界一律用 `unknown[]` 承载 A2UI payload, 按 payload 直接调用 web_core 的 schema 校验.

## 知识库管理与反馈

`/knowledge` 页面管理 OnCall 知识库: `GET /api/knowledge_docs` 列出文档及 chunk 数, `GET /api/knowledge_docs/<name>` 预览分块, `POST` 重新建索引, `DELETE` 同时删文件和向量 (后两者受 `ONCALL_ADMIN_TOKEN` 门控).

用户对助手回答的点赞/点踩走 `/api/feedback`, 落 `UserFeedback` 表 (`targetType` / `targetId` / `subjectId` / `rating` / `reason`, 同键 upsert).

## 可观测性与自监控

- **Langfuse** (`lib/observability.ts`): OTEL `NodeSDK` + `LangfuseSpanProcessor`, 从 `instrumentation.ts` 启动; 仅当 `LANGFUSE_PUBLIC_KEY` + `LANGFUSE_SECRET_KEY` + `LANGFUSE_BASE_URL` 都配置时启用, 否则全部降级为 no-op. 运维图运行时挂 `CallbackHandler` trace (tags `ai-ops`), 每次 AI SDK 调用经 `observeGeneration()` 记成 generation
- **自监控**: `prom-client` 注册表 (`lib/metrics.ts`, 缓存在 `globalThis`) 由 `POST /api/log` (yukino-sentry 浏览器 SDK 上报批次) 喂数据, `GET /api/metrics` 暴露给 Prometheus; 覆盖除录屏 (ScreenRecord) 外的所有上报类型 (HTTP / 错误 / 资源 / Web Vitals / 导航与资源 timing / 长任务 / 内存 / 点击 / 曝光 / 白屏 / PV / 自定义事件), 加上 prom-client 默认缺的 Node/V8 指标 (进程与 V8 堆内存、堆使用率、detached context、event loop utilization 等); 浏览器标签值每个维度上限 50 种, 溢出归并为 `other`
- 告警规则在 `prometheus.rules.yml`; 告警名是契约, 每条规则都要在 `data/docs/alert-handling-guide.md` 有对应标题 (运维 Agent 按告警名解析 runbook)
- 改 `lib/metrics.ts` 的指标集必须 bump `METRICS_VERSION` 并重启 dev server, 否则 `globalThis` 里的旧注册表会让新增指标的 `.inc()` 抛 TypeError

## 配置与启动

配置走 `.env` + `lib/config.ts`, 无 yaml; 所有 API 响应包成 `{ message, data }` 信封, API 文案也走 next-intl (成功时的 `"OK"` 是协议常量不翻译). i18n 无 `[locale]` 路由段, 按请求解析: cookie `yukino_locale` 优先, 否则 `Accept-Language` 协商, 词表为 `messages/en.json` + `messages/zh-CN.json`.

关键探针:

- `GET /api/ready`: 数据库 / Milvus / LLM+embedding+rerank 配置 / Prometheus / MCP / 各告警源连通性逐项探测; 数据库和 Milvus 是核心依赖, 任一挂掉返回 503
- `GET /api/config_check`: 配置预期清单, 只给非敏感摘要 (DSN 打码), 不回显密钥

启动钩子 `instrumentation.ts` (`register()`, 仅 nodejs runtime): 初始化 Langfuse -> 把 `FILE_DIR` 文档建索引进 Milvus -> 启动 DevFlow 自动同步循环 (`DEV_FLOW_AUTO_SYNC_ENABLED`, 默认间隔 900s).

## 离线验证

`tests/` 下是 `npx tsx tests/*.smoke.ts` 冒烟套件. OnCall 相关: `milvus.smoke.ts` (混合检索, 需要有效 embedding key)、`chunking.smoke.ts` (离线分块语义)、`doc-extract.smoke.ts`、`a2ui.smoke.ts`、`i18n.smoke.ts`、`metrics.smoke.ts`、`ai-ops-graph.smoke.ts` (`AI_OPS_SMOKE_LIVE=1` 跑真实模型)、`oncall-ops.smoke.ts`、`oncall-chat-protocol.smoke.ts`、`migration-restoration.smoke.ts`; DevFlow 各子系统另有 `dev-flow-*.smoke.ts` 一组.
