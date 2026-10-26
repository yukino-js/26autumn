---
title: "HTTP API 和管理台"
---

# HTTP API 和管理台

## 服务拓扑

- API 服务: Hono + pino 日志, 默认 127.0.0.1:8000 (HOST / PORT); /healthz 健康检查; 启动顺序: 数据库就绪 -> 可观测性初始化 -> 上下文预算检查 -> Milvus 预热 -> 编译图 (checkpointer) -> 监听
- MCP 服务: logistics :8101、aftersales :8102 (见 MCP 一章)
- 前端控制台: Vite CSR SPA, 开发端口 5173, /api/* 代理到 8000; 生产部署 dist/ 到任意静态服务 (所有路径回退 index.html)

`node server/main.js` 是统一的任务入口: dev (MCP + API)、dev-down、mcp-up/down、kb-preview/build/mine/vectorize/repatch/reset、milvus-up/down、langfuse-up/down、seed-conv、flywheel、eval-_、smoke-_、calibrate-confidence、cost-report、bare-agent-loop 等; `node server/main.js help` 列出全部命令。

## 对话 API

### POST /api/chat (SSE)

请求: `{ user_id, message, conversation_id? }`

- 消息长度校验: 超过 MAX_USER_INPUT_TOKENS (2000 token, 约 8000 字符) 直接 400
- conversation_id 为空时创建新会话; 会话不存在返回 Conversation not found

SSE 事件流:

| 事件      | 负载                                                            | 含义                                                                   |
| --------- | --------------------------------------------------------------- | ---------------------------------------------------------------------- |
| (默认)    | `{delta}`                                                       | 流式文本                                                               |
| tool      | `{event:"tool", name}`                                          | 调用了某个工具                                                         |
| citations | `{event:"citations", items}`                                    | 证据引用列表                                                           |
| actions   | `{event:"actions", items}`                                      | 动作卡片 (select_order / refund_form / create_ticket / transfer_human) |
| interrupt | `{event:"interrupt", kind, conversation_id, orders?, preview?}` | 图中断, 等待用户操作                                                   |
| done      | `{event:"done", conversation_id}`                               | 本轮结束                                                               |
| error     | `{message}`                                                     | 错误 (数据库 / 上游模型 / 会话不存在)                                  |

以 `[DONE]` 收尾。

### POST /api/agent

与 /api/chat 相同的输入, 但同步返回整轮结果 JSON (回复文本、工具调用/结果视图、引用、动作卡片、是否中断), 供测试和联调使用。

### POST /api/actions/resume (SSE)

`{ conversation_id, order_id? | confirmed? }` —— 恢复被 select_order / confirm_ticket 中断的图, 事件流与 /api/chat 相同。order_id 和 confirmed 至少提供一个。

### POST /api/actions/create-ticket / create-refund

前端动作卡片的直连入口 (不经过 LLM): create-ticket 直接创建工单; create-refund 以 ticketType=refund 创建退款工单。

### GET /api/conversations

- GET /api/conversations?user_id=: 用户的会话列表
- GET /api/conversations/:conversation_id/messages: 会话的消息历史 (角色、内容、时间)

### POST /api/feedback

`{ conversation_id, rating: up|down, question }` —— 点赞只记日志; 点踩写入数据飞轮 (source=user_feedback), 能取到本轮检索快照时一并附上。

### POST /api/extract

售后工单字段抽取: 输入用户的售后描述文本, 结构化输出 `{order_id?, request_type, expected_solution}`; order_id 只在文本中明确出现时抽取 (如 MH20260701123), 占位值 (null/none/n/a/无) 归一化为 null, 绝不编造。

## 知识库 API (/api/kb/*)

- GET /api/kb/overview: chunk 统计 (total/pending/done/按类型/关键条款)、最近 chunk、挖掘暂存统计、Milvus 状态、双写一致性、材料清单、内容类型说明、相关 job 状态
- POST /api/kb/preview: 预览切割结果 (材料文件或粘贴的 markdown, 不写库)
- POST /api/kb/ingest: 单条录入 (text + content_type, 可选立即向量化)
- POST /api/kb/vectorize: 向量化 pending 的 chunk
- POST /api/kb/search: `{q, strategy, top_k}` 检索试验 (四种策略)
- GET /api/kb/staging + POST /api/kb/staging/approve|reject: 挖掘暂存区审核; 通过时作为 conversation_history 类型的 chunk 写入知识库并向量化, 失败回滚、状态不变可重试

## 数据飞轮与评测 API

- GET /api/review/queue?status= / GET /api/review/:id: 待审队列 (标准化问题、出现次数、AI 建议答案、关联的低置信问题与检索快照)
- POST /api/review/:id/approve `{approved_answer}`: 写回知识库并向量化 (flywheel_review 类型; 失败回滚 chunk, 状态不变可重试); 已审过的条目返回 409
- POST /api/review/:id/reject
- GET /api/rag-eval/overview: 四策略对比报告 (data/rag/reports/rag_eval.json)、幻觉台账统计、最佳策略
- GET /api/rag-eval/faith-cases / POST /api/rag-eval/faith-cases/:id/status: 幻觉案例处理 (unresolved / resolved / dismissed + 处理备注)
- GET /api/observability/overview: 按意图的 token 账单、评测趋势 (最近 10 轮)、置信度校准、阅读笔记

## 管理 API 与 job runner

- GET /api/admin/overview: 四张状态卡片 —— 知识库 / RAG 评测 / 数据飞轮 / 可观测性, 每张卡片带状态 (ok / attention / missing / error)、一句话结论和关键指标
- GET /api/admin/jobs、GET /api/jobs: 全部 job 的状态

/api/jobs/:name (POST 启动 / GET 状态 / POST 停止) 与 main.js 共用一个 job runner (`server/src/core/jobs.ts`):

- 只能提交注册过的 job 名 (kb-preview / kb-build / kb-mine / kb-vectorize / kb-repatch / kb-reset / seed-conv / milvus-up / milvus-down / eval-rag / eval-flywheel / calibrate-confidence / cost-report), 永远不会执行任意 shell 片段
- job 以 detached 子进程运行, 日志写 log/acceptance/<name>.log, 管理页可看最近 400 行
- 同一 job 不能并发运行; 状态机: idle / running / ok / failed / stopped

## 前端控制台

CSR-only SPA (`client/`): Lit + @yukino.js/lit-jsx (React 风格 JSX 编译成 lit-html) + Tailwind v4 + @lit-labs/router + Chart.js + motion + dotLottie。

六个路由:

| 路由           | 页面                                                                                      |
| -------------- | ----------------------------------------------------------------------------------------- |
| /              | 聊天页: SSE 流式渲染、引用气泡、动作卡片 (选订单/工单确认/退款表单)、点踩反馈、会话侧边栏 |
| /admin         | 管理首页: 四张状态卡片 + job 重跑按钮                                                     |
| /kb            | 知识库: 概览、材料切割预览、单条录入、向量化、检索试验、挖掘暂存审核                      |
| /rag-eval      | RAG 评测: 四策略对比图表、忠实度/拒答率、幻觉案例处理                                     |
| /review        | 待审队列: 标准化问题、出现次数、AI 建议答案、通过 (填写批准答案) / 拒绝                   |
| /observability | 可观测性: 按意图 token 账单、评测趋势、置信度校准、阅读笔记                               |

架构要点:

- 所有组件继承 LightElement (渲染到 light DOM, 全局 Tailwind 样式才能生效)
- 页面元素继承 DataLoaderElement: connect 时加载数据, reload() 支持手动刷新和 job 完成后的回调, loading / loadError / data 驱动三态 UI
- 依赖查询串的页面 (如 /review?status=) 从路由回调接收 location.search, 查询串变化时自动重新加载
