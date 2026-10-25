---
title: "Yukino Agent"
---

# Yukino Agent

yukino-agent 是一个 AI 智能运维 (OnCall) 助手, 把两个产品面合并进单一 Next.js 16 + AI SDK 应用:

- **OnCall** (`/`): 基于 RAG 的运维问答, LLM 生成 A2UI 交互界面, LangGraph Plan-Execute-Replan 运维 Agent 把 Prometheus 告警转成排查报告
- **DevFlow** (`/devflow`): GitHub 工程副驾, 见 [DevFlow](/base/yukino-agent/devflow)

两个面都公开、无登录、单租户。它由两个 Python 老项目 (`agent_py` 的 OnCall 后端 + Vue, `DevFlow-AI` 的 FastAPI + Next) 迁移整合而来。代码仓库 `~/github/yukino-agent`。

## 技术栈

| 层        | 选型                                                                                   |
| --------- | -------------------------------------------------------------------------------------- |
| 框架      | Next.js 16 App Router + React 19 + TypeScript strict                                   |
| AI SDK    | Vercel AI SDK v7 (`ai`): `streamText` / `generateText` / `tool` / `embed`              |
| LLM       | OpenAI 兼容 (`@ai-sdk/openai`) 或 Anthropic (`@ai-sdk/anthropic`), `LLM_PROVIDER` 切换 |
| Embedding | text-embedding-v4 (`@ai-sdk/openai-compatible`), 批次上限 10 条                        |
| 向量库    | Milvus Standalone (`@zilliz/milvus2-sdk-node`, gRPC :19530)                            |
| 数据库    | PostgreSQL + Prisma 7 (`@prisma/adapter-pg`)                                           |
| 编排      | LangGraph (`@langchain/langgraph`)                                                     |
| 工具协议  | MCP (`@modelcontextprotocol/sdk`)                                                      |
| 可观测    | Langfuse (OTEL) + prom-client + yukino-sentry                                          |
| 前端      | Tailwind v4 + streamdown + A2UI + next-intl v4                                         |

模型分两档 (`lib/ai/models.ts`):

- `thinkModel`: 复杂推理, 用于运维 Agent 规划、A2UI 界面生成
- `quickModel`: 轻量快速, 用于对话、信息抽取

Anthropic 分支还会在 fetch 层给缺失 `signature` 的 thinking 块补空签名 (`patchAnthropicThinkingSignatures`), 规避 SDK 解析报错。

## LLM 基础

token: 大模型处理文本的基本单位

- 中文 1 个汉字约 1 个 token
- 英文约 4 个字母 1 个 token

消息角色:

- `system`: 系统提示, 定义角色、能力边界、输出格式
- `user`: 用户输入
- `assistant`: 模型输出

结构化输出用 AI SDK v7 的 `output: Output.object({ schema })`, 结果在 `.output` 上; `generateObject` 已弃用。运行时未知数据一律用 zod `safeParse` / `parse` 校验。

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

OnCall 的知识库由 `FILE_DIR` (默认 `./data/docs`) 支撑: 启动时 `instrumentation.ts` 把目录下所有文档 embed 进 Milvus (`lib/ai/pipelines/knowledge-index.ts`); 通过 `POST /api/upload` 上传的 `.txt/.md/.markdown/.pdf/.docx` 会立即建索引 (PDF/DOCX 用 unpdf/mammoth 抽文本, 见 `lib/ai/doc-extract.ts`)。索引时给每份文档分类 `knowledgeType` (`sop` / `document` / `diagnostic-case`), 供前端引用芯片展示。

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

单个 collection (`MILVUS_COLLECTION`, 默认 `yukino_knowledge`) 同时承载两条召回路:

- **dense 路**: `vector` 字段, AUTOINDEX + COSINE 相似度
- **BM25 全文路**: 开启 analyzer 的 `content` 字段绑定一个 BM25 Function, 自动填充 `sparse` 稀疏向量

`retrieve()` (`lib/milvus/retriever.ts`) 的流程:

1. **双路召回**: `hybridSearch()` (`lib/milvus/client.ts`) 同时发 dense (`vector`, COSINE) 和 sparse (`sparse`, BM25) 两路 ANN 请求
2. **粗排 (RRF 融合)**: 两路结果在 Milvus 内用 RRF 倒排融合 (`RRF_K = 60`), 融合输出 `limit = max(topK, recall)` (recall 默认 50); 因为向量余弦相似度 `[-1,1]` 和 BM25 分数量纲不同, RRF 只比排名不比分数, 每份文档贡献 `1 / (k + 排名)`, k=60
3. **过量取回**: 开启 rerank 或需要排除 DevFlow 源时, 候选池放大到 `max(topK * 4, 20)` (默认 topK=5 时为 20 条)
4. **精排 (optional)**: 设置了 `RERANK_API_KEY` 时, 用阿里云 DashScope text-rerank 接口 (默认 `qwen3-vl-rerank`, `lib/ai/rerank.ts`) 对候选重排, 失败则退化为融合顺序
5. **截断**: 取 topK (默认 `DEFAULT_TOP_K = 5`)

两条隔离规则:

- 未带 `filter` 的 `retrieve()` 是 OnCall 视角, 融合后会剔除 `devflow:*` 来源, DevFlow 的仓库知识不会泄漏进 OnCall 答案; 需要定向检索的调用方显式传 `filter`
- chunk 的 `metadata._source` 被提升为标量 `source` 字段, 支持按来源过滤和删除; embedding 维度从第一条向量推断, 维度不匹配时自动重建 collection

`retrieveDense()` 是仅 COSINE 的 dense 检索, 需要绝对分数阈值时用它 (RRF 分数是基于排名的, 不能当绝对分)。

## 对话 Agent (ReAct)

ReAct: Reasoning -> Acting -> Observation, 模型边推理边调用工具, 观察工具结果后继续。

对话管线在 `lib/ai/pipelines/chat.ts`: 系统提示词注入当前日期、RAG 召回的文档、技能目录和可选自定义提示, 用 `streamText` 流式输出。`chatStream()` 产出 `ChatStreamEvent` (`text` / `a2ui` / `notice` / `references` / `reasoning` / `tool`), SSE 逐帧推给前端; `references` 携带知识库来源 (标题/来源/分数/摘要/类型), 在回复下方渲染成引用芯片, 并带 vector/BM25/rerank 各阶段的排名。

记忆: 滑动窗口保留最近 `MEMORY_WINDOW_SIZE = 6` 轮; 滑出窗口的对话对被 LLM 折叠成滚动摘要 (≤1200 字符, `MEMORY_SUMMARY_ENABLED`), 作为 `## Conversation summary` 注入系统提示, 而不是直接丢弃 (`lib/memory.ts`)。

## 运维 Agent (Plan-Execute-Replan)

Plan-Execute-Replan 是一种多 Agent 协作的任务执行模式, 核心是先拆分步骤, 再按计划执行, 动态调整。

| 角色       | 对应组件  | 做什么                         |
| ---------- | --------- | ------------------------------ |
| 计划者     | Planner   | 拿到目标后, 拆解为分步骤的计划 |
| 执行者     | Executor  | 按计划、分步骤地执行           |
| 计划调整者 | Replanner | 审查执行结果, 决定是否调整计划 |

- Planner: 接收用户需求, 用结构化输出 (`planSchema`) 生成 `{ steps: string[] }`
- Executor: 把每一步的文本直接作为 prompt, 带工具调用 `generateText` (`stopWhen: isStepCount(10)`)
- Replanner: Executor 每执行完一步就介入, 用 `replanSchema` 输出 `{ done, remaining, summary }`
  1. 步骤完成、结果正确 -> 继续执行
  2. 步骤未完成、结果错误 -> 调整计划 (replan)
  3. 所有步骤完成 -> 任务结束, 输出报告

实现在 `lib/ai/pipelines/plan-execute-replan/`, 用 LangGraph `StateGraph` 编排, `MAX_ITERATIONS = 20` 防止死循环。告警排查的典型流程:

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

两个收尾环节:

- **UI-ify**: replanner 结束后, 用 think 模型 (无工具) 把报告可选地渲染成 A2UI 界面 (`uiifyReport`); 失败不会丢弃报告
- **沉淀**: 完成的报告作为诊断案例文档写回知识库 (`DiagnosticCaseRecord`), 后续对话和诊断能检索到历史故障

每次工具调用都记录到 `ToolCallAudit` 表 (session `aiops:<runId>`), `AiOpsRun.events` 持久化一条截断的 PlanExecuteEvent 时间线 (plan / step_start / step_done / replan), 在运维面板的运行历史里渲染。

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

工具定义遵循三层拆分: `lib/ai/tools/schemas.ts` (zod) -> `operations.ts` (纯函数) -> `index.ts` (AI SDK `tool` 包装)。

内置工具 (`lib/ai/tools/index.ts`):

| 工具                      | 作用                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------- |
| `get_current_time`        | 获取当前时间                                                                                      |
| `query_internal_docs`     | RAG 文档检索 (走 Milvus 混合检索)                                                                 |
| `query_prometheus_alerts` | 查询活跃告警, 调用 Prometheus `GET /api/v1/alerts`, 结构化输出 alertname / description / activeAt |
| `postgres_query`          | 只读 SQL 查询, 用独立受限的 `ONCALL_DATABASE_URL` (DSN 不作为工具参数), 拒绝管理角色              |
| `load_skill`              | 按名称读取技能的完整说明                                                                          |

日志工具走 MCP: `getLogMcpTools()` (`lib/ai/tools/query-log.ts`) 合并内置 `MCP_URL` 和管理员添加的多个连接 (`McpConnection` 表, SSE 或 Streamable HTTP), 重名工具改名为 `<connection>__<tool>`。日志查询参数需带 region 和 log topic。

所有对话和运维的工具调用都 fire-and-forget 记录到 `ToolCallAudit` (session/turn/tool/来源 builtin|mcp/截断的输入输出/状态/耗时), 通过 `GET /api/tool_audits?session=` 读取。

## A2UI (LLM 生成 UI)

LLM 在 markdown 回答之后, 可选地追加一个 `<a2ui-json>[...]</a2ui-json>` 块 (A2UI v0.9 消息的 JSON 数组), 用来渲染告警列表、指标表格、表单等交互界面:

- `lib/ai/a2ui/extract.ts` 的流式过滤器把块从文本流里剥离 (跨 chunk 保留未闭合的标签尾部); 校验只用 `@a2ui/web_core/v0_9` 的 schema
- 校验失败时给一次无工具的纠正重试 (`lib/ai/a2ui/correct.ts`), 仍失败则降级为诚实提示, 绝不伪造 UI 数据
- `catalog/` (18 个基础 + 47 个 shadcn 扩展组件) 和 `components/ui/` 从 a2ui 仓库内联, 尽量小改; `/gallery` 页面无后端预览全部组件
- 组件 action 序列化为 `[UI_ACTION] <name>\ncontext: <json>`, 走 `POST /api/a2ui_action` 原地更新界面

红线: web_core 自带 zod v3, 不能把它的 schema 组合进应用的 zod/v4 combinator, 应用边界用 `unknown[]` 承载, 按 payload 直接调用 web_core schema 校验。

## 可观测性与自监控

- **Langfuse** (`lib/observability.ts`): OTEL `NodeSDK` + `LangfuseSpanProcessor`, 从 `instrumentation.ts` 启动; 仅当 `LANGFUSE_PUBLIC_KEY` + `LANGFUSE_SECRET_KEY` + `LANGFUSE_BASE_URL` 都配置时启用, 否则全部降级为 no-op
- **自监控**: `prom-client` 注册表 (`lib/metrics.ts`) 由 `POST /api/log` (yukino-sentry 浏览器上报的 DSN) 喂数据, `GET /api/metrics` 暴露给 Prometheus; 覆盖除录屏外的所有上报类型, 加上 prom-client 默认缺的 Node/V8 指标 (堆上限、event loop utilization 等); 浏览器标签值上限 50 种, 溢出归并为 `other`
- 告警规则在 `prometheus.rules.yml`; 告警名是契约, 每条规则都要在 `data/docs/alert-handling-guide.md` 有对应标题 (运维 Agent 按告警名解析 runbook)
- 改 `lib/metrics.ts` 的指标集必须 bump `METRICS_VERSION` 并重启 dev server (注册表缓存在 `globalThis`)

## 配置与启动

配置走 `.env` + `lib/config.ts`, 无 yaml。关键探针:

- `GET /api/ready`: 数据库 / Milvus / LLM+embedding+rerank 配置 / Prometheus / MCP 连通性, 核心依赖挂掉返回 503
- `GET /api/config_check`: 配置预期清单, 只给非敏感摘要, 不回显密钥

启动钩子 `instrumentation.ts`: 初始化 Langfuse -> 把 `FILE_DIR` 文档建索引进 Milvus -> 启动 DevFlow 自动同步循环。

## 离线验证

`tests/` 下是 `npx tsx tests/*.smoke.ts` 冒烟套件, 覆盖 Milvus 检索、chunking、A2UI、i18n、metrics、AI Ops 图、DevFlow 各子系统。例如 `npx tsx tests/milvus.smoke.ts` (需要有效 embedding key)、`npx tsx tests/chunking.smoke.ts` (离线分块语义)。
