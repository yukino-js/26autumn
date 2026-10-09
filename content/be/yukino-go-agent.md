---
title: "yukino_agent: 基于 Eino 的 RAG 运维 Agent 后端"
description: "yukino_agent Go 后端: 以 CloudWeGo Eino 编排 RAG 对话、Plan-Execute-Replan 告警分析与文档索引三条流水线, 打通 Milvus 向量知识库、MCP/Prometheus/MySQL 工具集与浏览器可观测性到 Prometheus 的监控桥"
local_path: "$HOME/github/yukino.go/apps/agent"
---

yukino_agent 是一个用 Go 编写的 AI 运维助手后端。它把"检索增强对话 (RAG)"、"自主告警分析 (Plan-Execute-Replan)"与"文档向量化索引"三条能力, 统一构建在 CloudWeGo Eino 编排框架之上, 对外通过 yukino_http 暴露一组 HTTP/SSE 接口, 对内以 Milvus 作为向量知识库、以 MCP/Prometheus/MySQL/时间/文档检索作为工具集。除对话与运维分析外, 它还承担一个监控桥的角色: 把浏览器 SDK (`@yukino.js/sentry`) 上报的前端可观测性事件转换成 Prometheus 指标, 供告警规则消费, 从而让"前端异常"能反过来触发"Agent 分析"。本文面向需要在 Go 中落地 LLM Agent、RAG 知识库或 AIOps 流水线的工程师, 依次讲解定位、分层架构、三条流水线的实现思路、模型与工具适配、向量库引导、HTTP 契约、监控桥、并发与容错设计, 以及适用边界。

## 定位与解决的问题

传统运维排障依赖人: 看告警、翻文档、查日志、跑 SQL、写报告。yukino_agent 试图把这条链路交给 Agent, 它要同时解决四个工程问题:

| 问题                    | 设计取向             | 落地手段                                                                   |
| ----------------------- | -------------------- | -------------------------------------------------------------------------- |
| 如何让 LLM 用上私有知识 | RAG 而非微调         | Milvus 向量库 + 文档索引流水线, 检索结果注入 system prompt                 |
| 如何让 LLM 触达真实系统 | 工具调用而非纯文本   | ReAct Agent 绑定 MCP 日志、Prometheus 告警、MySQL、时间、文档检索工具      |
| 如何完成多步复杂任务    | 规划-执行-重规划闭环 | Plan-Execute-Replan, 思考模型规划、快模型执行、思考模型复盘                |
| 如何让前端异常可被告警  | 观测数据指标化       | `/api/log` 接收 SDK 上报, 转成 `yukino_sentry_*` 指标, `/api/metrics` 暴露 |

它的核心取舍是"编排框架 + 组件适配"而非"从零造轮子": 图的编排、ReAct 循环、Plan-Execute 骨架都复用 Eino/ADK 的 prebuilt 能力, 项目自身代码集中在**把外部世界 (Milvus、MCP、Prometheus、MySQL、各家 LLM Provider) 适配成 Eino 组件**, 以及**为不可靠的 LLM 输出与外部依赖做容错兜底**。

## 架构总览

后端是一个 Go module (`github.com/hangtiancheng/yukino.go/apps/agent/server`, `go.mod` 声明 `go 1.26.0`), 通过相对路径 `replace` 引用同仓库的 `yukino_http` 库作为 HTTP 框架。核心依赖及版本: CloudWeGo `eino` v0.9.13 (图编排 / ReAct / ADK)、`eino-ext` 的 model/openai v0.1.13 与 model/claude v0.1.24、indexer/milvus 与 retriever/milvus、document/loader/file 与 splitter/markdown、libs/acl/openai v0.1.17、`anthropic-sdk-go` v1.59.0、`milvus-sdk-go/v2` v2.4.2、`modelcontextprotocol/go-sdk` v1.8.0、`eino-contrib/jsonschema` v1.0.3、`prometheus/client_golang` v1.24.1 与 `prometheus/common` v0.70.1、`gorm` v1.31.2 加 `driver/mysql` v1.6.0、`google/uuid` v1.6.0。以下目录均相对模块根 (`apps/agent/server/`):

```text
cmd/            六个可执行入口
  agent         HTTP 服务 (生产主进程)
  chat          交互式 RAG 对话 (演示多轮记忆)
  ai_ops        命令行跑一次告警分析
  knowledge     批量索引 file_dir 下所有 .md
  recall        直接查询 Milvus 检索器
  llm_tool      验证模型的工具绑定能力
        |
        v
internal/app    HTTP 应用层 (yukino_http)
  /api/chat  /api/chat_stream  /api/upload
  /api/ai_ops  /api/log  /api/metrics
        |
        v
internal/ai/agent        三条 Eino 流水线
  chat_pipeline          RAG + ReAct 对话图
  plan_execute_replan    规划-执行-重规划 (ADK)
  knowledge_index_pipeline  加载-切分-索引图
        |
        +-- internal/ai/models      Think/Quick 模型工厂 (OpenAI 兼容 / Anthropic)
        +-- internal/ai/embedder    OpenAI 兼容向量化 + 维度探测
        +-- internal/ai/retriever   Milvus COSINE 检索 (TopK=1, 空库容错)
        +-- internal/ai/indexer     Milvus 行式写入 (FloatVector)
        +-- internal/ai/loader      文件加载器
        +-- internal/ai/tools       MCP / Prometheus / MySQL / 时间 / 文档工具
        |
        v
internal/utility         milvus 引导与缓存 · mem 会话记忆 · logger · log_callback
internal/config          JSONC 配置加载与默认值
internal/consts          Milvus 字段名与长度上限常量
```

外部依赖: Milvus standalone (向量库, 由 docker-compose 拉起 etcd+minio+milvus+attu)、Prometheus (抓取 `/api/metrics` 并评估告警规则)、Grafana (看板), 以及一个 MCP 日志服务器。前端 (`client/`, Lit + lit-jsx + Tailwind + Vite) 通过 Vite 代理访问 `/api/*`, 本文只在契约处提及。

## 三条流水线之一: RAG 对话图

`chat_pipeline.BuildChatAgent` 用 `compose.NewGraph[*UserMessage, *schema.Message]` 声明一张有向图, 输入是携带会话 ID、当前问题与历史的 `UserMessage`, 输出是一条 `schema.Message`。图的关键在于**检索与对话变量准备并行**, 二者汇聚到同一个 ChatTemplate:

```text
            +--> InputToRag --> MilvusRetriever --+
START ------+                                     +--> ChatTemplate --> ReactAgent --> END
            +--> InputToChat ---------------------+
```

- `InputToRag` 是一个 Lambda, 只把 `UserMessage.Query` 抽成字符串, 作为检索输入。
- `MilvusRetriever` 是 Eino 的 Retriever 节点, 用 `compose.WithOutputKey("documents")` 把检索结果写进模板变量 `documents`, 与 system prompt 里的 `{documents}` 占位符对应。
- `InputToChat` 是另一个 Lambda, 产出 `map[string]any{content, history, date}`, 分别填充用户问题、历史占位符与当前日期。
- `ChatTemplate` 用 `schema.FString` 格式, 由三段组成: 固定 system prompt、`MessagesPlaceholder("history")`、`UserMessage("{content}")`。
- `ReactAgent` 是终点, 内部是一个 Eino ReAct Agent。

图以 `compose.WithNodeTriggerMode(compose.AllPredecessor)` 编译, 意味着 ChatTemplate 必须等两条入边 (检索结果 + 对话变量) 都就绪才触发, 这正是"并行准备、汇聚渲染"的语义保证。

system prompt 由 `buildSystemPrompt` 组装, 定义了"对话助手"角色、交互准则与输出要求 (只输出 markdown), 并把检索到的文档夹在 `==== Documents Start/End ====` 之间。其中有一行日志主题上下文 (`log topic region` / `log topic ID`) 是**条件注入**的: 只有当配置里 `log_topic_region` 与 `log_topic_id` 都非空时才拼进去, 否则整行省略——这样 prompt 不会带着空占位符污染模型。

ReAct Agent 由 `newReactAgentLambda` 构建, `MaxStep` 设为 25 以限制推理-行动循环的步数, 工具集与 Plan-Execute 的执行器完全一致 (见后文工具集一节)。最后用 `compose.AnyLambda(agent.Generate, agent.Stream, nil, nil)` 把 Agent 包成 Lambda 节点, 同时支持 `Invoke` (一次性) 与 `Stream` (流式) 两种调用, 分别服务于 `/api/chat` 与 `/api/chat_stream`。

## 三条流水线之二: Plan-Execute-Replan

`plan_execute_replan.BuildPlanAgent` 面向"分析所有活跃告警并产出运维报告"这类多步任务, 复用 Eino ADK 的 `planexecute` prebuilt, 把三个角色拼成一个闭环:

| 角色      | 模型       | 职责                         | 关键约束                          |
| --------- | ---------- | ---------------------------- | --------------------------------- |
| Planner   | Think 模型 | 把目标拆成 `steps` 列表      | 结构化输出 JSON, 非工具调用       |
| Executor  | Quick 模型 | 逐步执行, 每步可多轮工具调用 | 单步 `MaxIterations=10`           |
| Replanner | Think 模型 | 复盘进度, 决定继续或收尾     | 输出 `{done, remaining, summary}` |

整体 `MaxIterations=20` 封顶, 由 `adk.NewRunner` 驱动。`BuildPlanAgent` 消费 Runner 的事件流时有一个**刻意的克制**: 它只把"执行器产出的、不含工具调用的、非空的 assistant 消息"收进 `detail` 列表, 而把 Planner/Replanner 的 JSON、工具调用轮次、`Message.String()` 调试转储全部丢弃。原因是这些中间产物若直接渲染到前端步骤列表里会变成乱码, 所以只保留每一步的最终自然语言答案。事件日志也只记录 `agent`/`path`/`has_output`/`err` 等元信息, 而不去读 `MessageStream`——因为一旦读取就会把流抽干, 导致后续 `adk.GetMessage` 拿不到内容。

Planner 与 Replanner 都不走工具调用, 而是走**基于 prompt 的结构化输出**。这是为兼容性做的妥协: 部分模型 (如 Qwen 系) 对 Anthropic 的 `tool_choice: forced` 支持不完整, 强行用工具调用做结构化输出会失败。于是 `structuredOutputModel` 包装了 `ToolCallingChatModel`, 在 `Generate` 返回后对内容跑一遍 `extractJSONObject`, 剥掉模型可能套上的 ` ```json ` 代码围栏或前置的推理文字, 保证下游 `plan.UnmarshalJSON` 永远看到一个干净的 JSON 对象。

`extractJSONObject` 是这套容错的核心工具函数, 逻辑是: 先去掉单层 markdown 围栏, 再定位第一个 `{`, 然后用一个带"字符串字面量感知"和"转义字符感知"的扫描器找到配平的 `}`。它能正确处理字符串内部的花括号 (不计入嵌套深度) 与 `\"`、`\\` 转义, 但不支持 JSON 注释 (JSON 本就不允许)。找不到配平对象时, 它返回裁剪后的尾部**连同错误**, 让调用方把原始模型输出一并暴露出来便于调试。

Replanner (`customReplanner.Run`) 自己实现了一个 `adk.Agent`: 它在一个 goroutine 里跑, 用 `defer recover()` 把 panic 转成 `AgentEvent{Err}` 再关闭迭代器, 避免单个步骤的崩溃掀翻整个 Runner。它从 ADK 会话里取出"已执行步骤结果""当前计划""历史步骤""原始用户输入", 拼成一个复盘 prompt, 让模型判断目标是否达成: 达成则发出 `summary` 并触发 `NewBreakLoopAction` 跳出循环; 未达成则用 `remaining` 构造新计划写回会话, 进入下一轮。

## 三条流水线之三: 文档索引图

`knowledge_index_pipeline.BuildKnowledgeIndexing` 是一张 `compose.NewGraph[document.Source, []string]`, 把"一个文件路径"变成"一批写入 Milvus 的文档 ID":

```text
Source --> FileLoader --> MarkdownSplitter --> MilvusIndexer --> IDs
```

- `FileLoader` 用 eino-ext 的文件加载器读取纯文本/Markdown。
- `MarkdownSplitter` 用 eino-ext 的 `markdown.NewHeaderSplitter`, 按 `#` 一级标题切分, 把标题文本写进 `title` 元数据, 并为每个切片用 `uuid.New()` 生成 ID。
- `MilvusIndexer` 把切片向量化后写入 Milvus。

这张图以 `AnyPredecessor` 触发模式编译 (线性链, 与对话图的并行汇聚不同)。真正对外的入口是 `IndexFile`, 它被 HTTP 上传处理器与 `cmd/knowledge` 批量 CLI **共享**, 以保证两条路径的索引行为一致。`IndexFile` 的关键动作是**先删后插的去重**: 它先加载文档拿到 `_source` 元数据, 取其 basename 作为去重键, 调用 `DeleteBySource` 删掉同名旧切片, 再跑索引图。这样重复索引同一个文件不会产生重复条目。去重键统一用 basename, 是为了让"在不同工作目录下索引同一个文件"得到稳定的键。

`cmd/knowledge` 则用 `filepath.WalkDir` 遍历 `file_dir`, 对每个 `.md` 文件调用 `IndexFile`, 非 Markdown 文件跳过并打印提示。

## 模型层: Think/Quick 双模型与 Provider 适配

`internal/ai/models` 提供两个工厂: `NewThinkChatModel` (规划/复盘, 深度推理) 与 `NewQuickChatModel` (对话/工具执行, 快响应), 二者都返回 Eino 的 `model.ToolCallingChatModel`。底层实现由配置 `model_provider` 选择:

- `openai` (默认): 走 eino-ext 的 OpenAI 兼容实现, `base_url` 原样使用 (通常含 `/v1`)。任何 OpenAI 兼容端点 (OpenAI 本体、阿里 DashScope 兼容模式、本地 vLLM/Ollama 网关) 都可用。
- `anthropic`: 走 eino-ext 的 Claude 实现, `base_url` **不能**含 `/v1` (SDK 会自己追加 `/v1/messages`)。当 `thinking=true` 且 `max_tokens>1` 时开启扩展思考, `budgetTokens = max_tokens - 1`。

Anthropic 路径上有一个值得注意的兼容补丁 `signaturePatchingTransport`: 它包装 `http.RoundTripper`, 对 `Content-Type: application/json` 的**非流式**响应, 解析出 `type=message` 的 body, 给任何缺失 `signature` 字段的 `thinking` 内容块补一个空字符串。原因是官方 Anthropic API 总会在思考块上带 `signature`, 但一些第三方网关会省略它, 导致 Anthropic SDK 以 "Invalid JSON response" 拒绝整个响应。流式 (SSE) 响应原样透传, 不做改写。补丁后会同步修正 `Content-Length` 与 `resp.ContentLength`。

向量化由 `internal/ai/embedder` 负责, 只支持 OpenAI 兼容的 `/v1/embeddings` 协议 (经 eino-ext 的 `libs/acl/openai` 客户端), HTTP 超时 60s。它额外提供 `ProbeDimension`: 用一个临时 embedder 对一段探针文本做向量化, 以**实际输出长度**作为权威维度。这个维度会在 Milvus 引导时决定 collection 的 `DIM`, 因此配置里无需、也不应手写维度。

## 工具集: 把外部系统适配成 Eino Tool

对话图与 Plan-Execute 执行器共享同一套工具, 保证两条流水线能力对等 (注册顺序略有差异, 集合一致)。四个内置工具 (`query_prometheus_alerts`、`mysql_crud`、`get_current_time`、`query_internal_docs`) 都用 `utils.InferOptionableTool` 从 Go 函数签名与 struct tag (`jsonschema` / `jsonschema_description`) 反推 JSON Schema; MCP 工具则不经推断, 由适配器直接携带服务器下发的 `InputSchema`。

| 工具                      | 能力                                     | 容错取向                             |
| ------------------------- | ---------------------------------------- | ------------------------------------ |
| MCP 日志工具 (动态)       | 连接 MCP 服务器, 枚举其工具并逐个适配    | 连不上则降级为空工具集, 不阻断构建   |
| `query_prometheus_alerts` | 拉取活跃告警, 按 alertname 去重          | `prometheus_url` 为空则返回空结果    |
| `mysql_crud`              | 对 MySQL 执行 query/insert/update/delete | 运行期错误转成 JSON 错误载荷回喂模型 |
| `get_current_time`        | 返回多格式当前时间                       | 无参工具, 容忍空 Arguments           |
| `query_internal_docs`     | 对知识库做 RAG 检索                      | 运行期错误转成 JSON 错误载荷         |

几个实现要点:

**MCP 适配** (`mcp_tool.go`) 支持三种传输: `streamable_http` (默认)、`sse`、`stdio` (拉起子进程, 继承当前环境并叠加配置的 `env`)。连接成功后, 它用 go-sdk 的 `session.Tools` 迭代器 (自动翻页) 枚举服务器工具, 把每个 MCP 工具的 `InputSchema` 经 JSON round-trip 转成 Eino 的 `jsonschema.Schema`, 再包成 `mcpToolAdapter`。适配器 `InvokableRun` 时把参数 JSON 解成 `map[string]any` 调 `session.CallTool`, 结果用 `formatCallResult` 渲染: 文本内容直接透传, 图片/资源/结构化输出回退成 JSON, 被标记 `IsError` 的结果转成 Go error 让模型自我纠正。整个 MCP 工具集按配置做缓存 (`mcpCacheKey` 用 `json.Marshal` 派生稳定键, 因为 encoding/json 会对 map 键排序), **但失败不缓存**, 以便服务器恢复后下次请求能重连。

**MySQL 工具** (`mysql_crud.go`) 用 GORM 执行 SQL。`normalizeDsn` 同时接受 go-sql-driver 格式与 `mysql://` URL 格式, 并强制补上 `parseTime=true` (否则时间列会以 `[]byte` 返回, GORM 扫描进 `time.Time` 会报 "unsupported Scan")。`execMysqlSql` 按 `operate_type` 只执行一次 (query 走 `db.Raw().Scan`, 写操作走 `db.Exec`), 每次调用开新连接池并在结束时关闭以防泄漏。

**无参工具的兼容** (`empty_arguments.go`): `TolerateEmptyArguments[T]` 是一个自定义的 `utils.UnmarshalArguments`, 把空/纯空白的 Arguments 归一成 `"{}"` 再解码。因为 Eino 默认的 sonic 反序列化会把空串当语法错误, 而部分模型 (如 Qwen) 对无参工具就是返回空串而非规范的 `"{}"`。`get_current_time` 与 `query_prometheus_alerts` 都挂了这个选项。

**错误即观测**: MySQL 与文档检索工具在运行期失败时, 不返回 Go error, 而是返回一个 `{success:false, error, message}` 的 JSON 字符串 (error 为 nil)。这样错误会作为"工具观测结果"回喂给模型, 让 Agent 有机会推理并重试 (比如修正 DSN), 而不是直接中断整个 ReAct 流。

## 向量知识库: Milvus 引导与读写

`internal/utility/milvus` 负责把 Milvus 从零引导到可用, 并缓存连接。`NewClient` 按 Milvus 配置做缓存 (键同样是 `json.Marshal` 派生), 因为**对话处理器每个请求都会重建流水线**, 不能每次都付一遍引导成本 (两次 gRPC 连接 + 一次维度探测 + collection 建库建表 + 加载)。

`bootstrap` 的引导顺序经过精心安排:

1. 先连 `default` 库——目标库可能还不存在, 而 Milvus 拒绝连接不存在的库。
2. `ListDatabases` 检查目标库 (默认 `agent`), 不存在则 `CreateDatabase`。
3. 关掉 default 连接, 重连到目标库。
4. 用 `embedder.ProbeDimension` 探测真实维度。
5. 检查 collection (默认 `biz`): 若已存在但存储维度与探测维度**不一致**, 直接 `DropCollection` 重建 (并打 warn 日志); 不存在则按 `Fields(dim)` 建表。
6. 建 `AUTOINDEX` + `COSINE` 向量索引。
7. 检查加载状态, 未加载则 `LoadCollection` (collection 必须先加载才能搜索)。

collection 的 schema 由 `Fields(dim)` 定义, 四个字段与 `internal/consts` 的常量一一对应:

| 字段       | 类型               | 说明                                |
| ---------- | ------------------ | ----------------------------------- |
| `id`       | VarChar(255), 主键 | 文档/切片 ID                        |
| `vector`   | FloatVector(dim)   | 内容向量, COSINE 度量               |
| `content`  | VarChar(8192)      | 文档内容, 上限即 `MaxContentLength` |
| `metadata` | JSON               | 序列化的元数据, 含去重键 `_source`  |

**写入** (`internal/ai/indexer`): `documentToRows` 把 Eino 文档 + 向量映射成行式记录 `docRow` (用 `milvus:"name:..."` tag 绑定字段)。它做三件事: 把向量转成原生 `[]float32` (而非 Eino 组件默认打包的 BinaryVector, 后者与 FloatVector schema 不匹配); 把 `metadata["_source"]` 归一成 basename 以稳定去重键; 把 content 截断到 `MaxContentLength` 以匹配 schema。

**检索** (`internal/ai/retriever`): `NewMilvusRetriever` 用 COSINE 度量、`AUTOINDEX` 搜索参数 (不设 radius/range_filter——Eino 默认会从 collection 维度推一个, 反而会把所有 COSINE 结果静默过滤掉)、`TopK=1`, 输出 `id`/`content`/`metadata` 三字段, 并用 `floatVectorConverter` 保证查询向量也是 FloatVector。它外面套了一层 `emptyTolerantRetriever`: 当 collection 还没有任何行时, Eino 组件会抛 "no results found" 错误, 这个包装器把它映射成空文档列表而非错误——否则"在索引第一篇文档之前就聊天"会让整条流水线失败。

**去重删除** (`DeleteBySource`): 先用布尔表达式 `metadata["_source"] == "<source>"` 查出所有匹配 ID, 再按 500 一批拼 `id in [...]` 表达式删除, 以保持表达式短小。字符串经 `escapeMilvusString` 转义反斜杠与双引号。

## HTTP 应用层与前端契约

`internal/app.New` 用 `yukino_http.Default()` 建引擎, 挂一个 CORS 中间件 (允许 `*` 源、GET/POST/OPTIONS、Content-Type 头, 预检直接返回 204), 然后在 `/api` 分组下注册六个路由:

| 方法 | 路径               | 处理器             | 说明                                           |
| ---- | ------------------ | ------------------ | ---------------------------------------------- |
| POST | `/api/chat`        | `handleChat`       | 同步 RAG 对话, 返回 `{message, data:{answer}}` |
| POST | `/api/chat_stream` | `handleChatStream` | SSE 流式对话                                   |
| POST | `/api/upload`      | `handleFileUpload` | 上传文档入知识库                               |
| POST | `/api/ai_ops`      | `handleAIOps`      | 跑一次告警分析, 返回 `{result, detail[]}`      |
| POST | `/api/log`         | `handleSentryLog`  | 监控上报汇聚点 (SDK 的 dsn)                    |
| GET  | `/api/metrics`     | `handleMetrics`    | Prometheus 文本暴露                            |

所有响应统一用 `{message, data}` 信封, 出错时 `data` 为 `null`——这是前端依赖的契约。

**对话处理器**每次请求都重建流水线 (`BuildChatAgent`), 从 `mem` 取历史, 以 `ctx.Request.Context()` 驱动整条图, 成功后把"用户问题 + 助手回答"追加进会话记忆。`handleChat` 走 `Invoke` 一次性返回; `handleChatStream` 走 `Stream`, 用 yukino_http 的 SSE 能力依次发出 `connected` (含 client_id)、若干 `message` (内容分片)、`done` 或 `error` 事件, 并在 `defer` 里把累积的完整回答写回记忆。SSE 帧格式是 `event: <name>\ndata: <payload>\n\n`, 没有单独的 id 行也没有 `[DONE]` 尾帧; `connected` 载荷用 `json.Marshal` 编码而非字符串拼接, 以保证会话 ID 里的特殊字符安全。

**上传处理器** (`file_handler.go`) 的安全设计较密: 客户端文件名先经 `safeUploadName` 归一——把反斜杠也替换成正斜杠 (Unix 上反斜杠是普通字符, 否则 `filepath.Base` 会漏掉 Windows 风格的 `..\..\evil.md` 穿越), 取 basename, 拒绝空名与不支持的扩展名 (只允许 `.txt`/`.md`/`.markdown`); 再经 `confinedPath` 验证解析后的目标确实落在上传目录内; 最后用 `writeLimited` 流式落盘, 通过"多读一字节" (`io.LimitReader(src, limit+1)`) 证明是否超过 50MB 上限, 超限或出错时删除半成品文件。落盘后调用共享的 `IndexFile` 完成去重索引。

**错误信封** (`errors.go`): `structuredErrorMessage` 用反射从 LLM/API 错误里抽取诊断字段, 拼成 `{name, message, statusCode, url, responseBody}` 的 JSON。之所以用反射, 是为了让 app 包不必 import 各家 Provider SDK——它对任何暴露 `StatusCode`/`Request.URL`/`RawJSON()` 的错误类型都生效 (尤其是 `*anthropic.Error`), 对其它 Provider 的 `fmt.Errorf` 包装错误则回退到 name+message, 还能用 `errors.As` 兜底 `*url.Error` 的 URL。

## 监控桥: 浏览器可观测性到 Prometheus

`sentry_metrics_handler.go` 是一个独立的子系统, 把 `@yukino.js/sentry` 浏览器 SDK 的上报转成 Prometheus 指标。它维护一个**私有 registry** (`sentryRegistry`), 与全局默认 registry 隔离, 在 `init()` 里注册三类东西:

1. **Go 运行时指标**: 用 `collectors.NewGoCollector` 并显式开启 `runtime/metrics` 的 GC/内存/调度器规则, 外加 `/cpu/classes/*`、`/sync/*`、`/cgo/*`。默认的 GoCollector 只暴露 `go_memstats_*` 等少量指标, 这里补上了排查 Go 服务真正需要的调度延迟、GC 暂停、各状态 goroutine 数、互斥锁竞争等; `/godebug/*` 被排除 (五十多条恒为零的序列没有排查价值)。还注册了进程指标、构建信息, 以及两个自定义 Gauge: `yukino_go_memory_limit_bytes` (GOMEMLIMIT, 未设时为 0) 与 `yukino_go_heap_used_ratio` (存活堆 / GOMEMLIMIT, 未设 GOMEMLIMIT 时报 0 而非臆造一个)。
2. **一批 `yukino_sentry_*` 指标**: 覆盖 SDK 的几乎每种上报类型 (唯独不含只携带 rrweb 不透明 blob 的 ScreenRecord)。
3. 指标命名与标签集**保持稳定**, 以便一个 Prometheus 实例能用同一套 `prometheus.rules.yml` 抓取多个生产者。

`handleSentryLog` 接收 SDK 批量上报 (`[]sentryReportItem`, 每项含 `type`/`name`/`status`/`projectId`/`payload`)。由于 SDK 的 `sendBeacon` 发 `text/plain`、`fetch` 发 `application/json`, 处理器用 `BindJSON` 解码——它不嗅探 Content-Type, 两种都能吃。解码失败计入 `report_batches_total{outcome="invalid"}` 并返回 400; 成功则 `recordSentryReportBatch` 逐条按 `type` 分派:

| 上报 type                                      | 落到的指标 (节选)                                                                                                                                                                                                            |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `XMLHttpRequest`/`fetch`                       | `http_requests_total`、`http_request_duration_ms`                                                                                                                                                                            |
| `Error`/`React`/`Vue`/`OtherFrameworks`        | `errors_total`、`batch_error_groups_total`                                                                                                                                                                                   |
| `Resource`                                     | `resource_errors_total` (按失败标签)                                                                                                                                                                                         |
| `Performance`                                  | `web_vitals`、`navigation_timing_ms`、`resource_*`、`long_tasks_*`、`browser_memory_*`；名为 `HTTP <method>` 的性能事件落到 `http_requests_total`/`http_request_duration_ms`，其余非 Web Vitals 事件落到 `performance_value` |
| `Click`/`Exposure`/`PV`/`WhiteScreen`/`Custom` | `clicks_total`、`exposures_total`、`page_views_total`、`white_screens_total`、`custom_events_total`                                                                                                                          |

由于上报载荷是异构的, `decodePayload` 把"字段不匹配"当作预期情况静默跳过而非报错; 高基数标签 (如点击事件名、资源标签) 经 `boundedLabel` 收敛: 每个标签键最多保留 `maxLabelValues=50` 个不同取值, 超出的统一折叠成 `other`, 空值归一为 `unknown`, 防止标签爆炸。`handleMetrics` 则 `Gather` 私有 registry, 用 `expfmt` 编码成文本暴露格式写出。`prometheus.rules.yml` 在此之上定义了五组告警: `targets` (抓取目标离线 ServiceOffline)、`go-runtime` (goroutine 泄漏、调度延迟、GC STW、GC CPU 占比、堆逼近 GOMEMLIMIT、互斥锁竞争、线程增长)、`telemetry-pipeline` (批量上报被持续拒绝、遥测停滞)、`client-errors` (React 崩溃、错误率突增、白屏、资源加载失败) 与 `client-performance` (接口失败率、p95 延迟、Web Vitals 劣化、导航缓慢、长任务压力、浏览器内存)——这些告警一旦触发, 又能被 `query_prometheus_alerts` 工具拉回给 Agent 分析, 形成闭环。

## 会话记忆、并发与容错

**会话记忆** (`internal/utility/mem`) 是一个带 LRU 的进程内存储: 全局 `memMap` + `container/list` 双向链表, `MaxSessions=100` 封顶, 超限时淘汰最久未用会话。每个 `ConversationMemory` 维护一个 `MaxWindowSize=6` 的滑动窗口, `Append` 超窗时**成对**丢弃最旧消息 (excess 向上取偶), 以保持 user/assistant 配对不被破坏。`All()` 返回快照拷贝而非内部切片, 防止调用方透过引用篡改状态。全局 map 与每个 memory 各自用 `sync.Mutex` 保护, 并发安全。

**缓存**: Milvus 客户端与 MCP 工具集都按配置做进程级缓存 (各自一把 `sync.Mutex` 保护), 避免每请求重建。二者的缓存键都由 `json.Marshal(config)` 派生, 借助 encoding/json 对 map 键排序的特性保证稳定。MCP 的失败**不进缓存**, 以支持服务器恢复后重连。

**优雅降级**是贯穿全局的容错主线: MCP 连不上降级为空工具集; Prometheus 未配置则告警工具返回空; 知识库为空则检索返回空列表而非报错; 工具运行期错误转成 JSON 载荷回喂模型而非中断; Replanner 的 panic 被 recover 成事件错误。这些设计共同保证"任何一个外部依赖缺席, 都不会让整个 Agent 构建或请求失败"。

**配置加载** (`internal/config`) 读 `config.json` (而非环境变量), 但允许 JSONC: `stripJSONC` 在解码前剥掉 `//` 行注释、`/* */` 块注释与尾随逗号。剥离器**逐字符扫描并感知字符串字面量**, 因此字符串里的 `//` (如 `https://api.example.com/v1`) 不会被误判成注释; 尾随逗号的判定用 `nextSignificant` 跳过空白与注释后看下一个有效 token 是否为 `}`/`]`。`applyDefaults` 为缺省字段填默认值 (`:8123`、`openai`、`max_tokens=4096`、`./data/docs`、`localhost:19530`、`agent`/`biz`、`streamable_http` 等)。`config.example.jsonc` 逐字段注释了每个配置项, 可原样拷贝成 `config.json` (后者因含真实密钥而被 git 忽略)。

**日志与可观测**: `internal/utility/logger` 用 `log/slog` 的文本 handler 统一结构化日志 (取代散落的 `fmt.Printf`); `internal/utility/log_callback` 是一个 Eino 回调 handler, 把流水线各组件的 start/end/error 生命周期事件经 slog 打出, 默认开启输入载荷详情。

## 部署形态

- **本地**: `cp config.example.jsonc config.json` 后 `go run ./cmd/agent`, 或 `make dev` (air 热重载: 监听 `go`/`tpl`/`tmpl`/`html` 扩展名, 排除 `tmp`/`bin`/`data`/`node_modules` 目录与 `_test.go`, 构建产物落 `tmp/main`; 注意 config.json 只在启动时读一次, 改配置需手动重启)。
- **基础设施**: `docker compose up -d` 拉起 Milvus standalone v2.5.10 (etcd+minio+milvus+attu)、Prometheus v2.55.1、Grafana 11.4.0。Milvus 监听 19530, 后端首连时自动建库建表; Prometheus 经 `host.docker.internal:8123` 抓取宿主机上的 `/api/metrics`。
- **容器**: Dockerfile 是多阶段构建 (golang:1.25-alpine 构建, alpine 运行; `go.mod` 声明 `go 1.26.0`, 构建依赖默认的 `GOTOOLCHAIN=auto` 在镜像内拉取匹配工具链)。因为 `go.mod` 用相对路径 `replace` 了同仓库的库, **构建上下文必须是仓库根**, 且构建时设 `GOWORK=off` 让本模块脱离 go.work 独立编译。镜像只内置 `config.example.jsonc` 作参考, 真实 `config.json` 需运行时挂载, 缺失则进程以清晰的加载错误退出。
- **Makefile** 统一了 build/run/dev/test/vet/tidy/fmt/clean 与 docker-up/down/build 入口; `make test` 即 `go test ./... -race -cover`。单元测试集中在纯函数与可离线验证的边界上: JSONC 剥离与默认值、上传文件名归一/路径限制/限长写盘、Milvus 转义与 schema、索引行转换与内容截断、检索器的空库容错与向量转换、MySQL DSN 归一与工具 schema、MCP 传输选择与降级, 以及监控桥的指标族完整性、事件明细、标签收敛与畸形载荷存活。

## 适用场景与边界

适合用 yukino_agent 作为参考或起点的场景:

- 需要在 Go 里落地一个**带私有知识库的对话 Agent**, 且希望复用成熟编排框架 (Eino) 而非手写图引擎。
- 需要把 LLM 接到**真实运维系统** (日志、告警、数据库) 做 AIOps, 并要一个能自主多步排障的 Plan-Execute-Replan 闭环。
- 需要把**前端可观测性数据指标化**, 让浏览器异常进入 Prometheus 告警体系, 再被 Agent 消费。
- 需要对接**多家 LLM Provider** (OpenAI 兼容 / Anthropic) 与 **MCP 工具生态**, 并要一套针对不可靠模型输出的容错范式 (结构化输出剥离、空参容忍、错误回喂)。

需要注意的边界:

- 会话记忆是**进程内**的, 多副本部署时不共享, 重启即丢; 生产级多实例需要外置存储。
- 检索 `TopK=1` 且按一级标题切分, 偏向"精确命中单篇文档"的运维问答, 不是通用大规模语义搜索的调参起点。
- Milvus 维度不匹配时会**直接 drop 重建 collection**, 换 embedding 模型即清空知识库, 需重新索引。
- `mysql_crud` 工具把 DSN 与 SQL 都交给模型生成并直接执行, 无交互确认、无语句白名单, 接到生产库前必须自行加权限与审计约束。
- 监控桥的指标是**进程内累积**的, 与对话/分析能力同进程; 若要把可观测性独立扩缩, 需要把 `/api/log`+`/api/metrics` 拆成单独服务。

本服务的路由、中间件与 SSE 能力由同仓库的 [yukino_http](yukino-http) 框架提供, 其 API 与中间件模型见该专文。
