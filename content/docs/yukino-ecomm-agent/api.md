---
title: "HTTP API 和管理台"
---

# HTTP API 和管理台

yukino-ecomm-agent 的对外表面分三块: API 服务 (Hono)、两个 MCP 服务 (见 [MCP 和 Skill](./mcp)) 和前端控制台。API 服务是唯一连接 agent 图、知识库、数据飞轮和管理页面的入口, 所有路由都挂在 `server/src/server.ts` 的 `createApp()` 里。

## 服务拓扑与启动

### API 服务

Hono + hono-pino 请求日志, 默认监听 `127.0.0.1:8000` (`HOST` / `PORT` 环境变量), `GET /healthz` 返回 `{ ok: true }`。

进程入口是 `server/src/index.ts`, 启动顺序:

1. `missingRuntimeConfig()` 检查 `CHAT_MODEL`、`CHAT_BASE_URL`、`CHAT_API_KEY`、`EMBED_API_KEY`、`RERANK_API_KEY` 五个必填项, 缺失直接退出 (提示填 `.env`);
2. `scanBuiltin()` 扫描内置工具;
3. `assertDbReady()` 等待数据库就绪;
4. `initObservability()` 初始化可观测性;
5. 上下文预算检查: 预算不足时打 error 日志, 提示调大 `MODEL_CONTEXT_WINDOW` 或调小 `MAX_AGENT_STEPS` / `TOOL_RESULT_MAX_TOKENS` / `MAX_OUTPUT_TOKENS` / `RERANK_TOP_K`;
6. Milvus 预热: 仅在配置了 `MILVUS_URI` 时执行, 以 BM25 探针轮询最多 15 次 (间隔 1 秒), 超时或失败只告警不阻塞;
7. `runtime.initGraph()`: 自动创建 checkpointer 数据库、`PostgresSaver.setup()`、编译图;
8. 开始监听。

`SIGINT` / `SIGTERM` 触发优雅退出: 关闭 HTTP 服务 → `closeGraph()` → `shutdownObservability()` → `closeDb()` → `flushLogs()` → 进程退出。

### 任务入口 main.js

`node server/main.js <command>` 是统一的离线任务入口, `node main.js help` 列出全部命令。常用命令:

- `dev` / `dev-down`: dev 先拉起两个 MCP 服务再 `pnpm dev` (即 `tsx watch src/index.ts`);
- `mcp-up` / `mcp-down`, `mcp-logistics(-up/-down)` / `mcp-aftersales(-up/-down)`: MCP 服务管理 (logistics :8101、aftersales :8102);
- 知识库: `kb-preview` / `kb-build` / `kb-mine` / `kb-vectorize` / `kb-repatch` / `kb-reset`;
- 基础设施: `milvus-up` / `milvus-down` (systemd 或 docker compose)、`langfuse-up` / `langfuse-down`;
- 数据与评测: `seed-conv`、`flywheel`、`eval-rag` (附加参数直通, 如 `--skip-gen`)、`eval-flywheel` (默认 `--triggered-by manual`)、`eval-retrieval`、`eval-judge`、`calibrate-confidence`、`cost-report` (默认 `--days 7`)、`eval-extract`、`eval-workflow`、`eval-intent`、`eval-intent2`、`eval-context`、`eval-mcp`、`eval-agent`、`eval-mining`、`eval-coref`、`eval-expand`、`eval-check`、`flywheel-samples`、`bare-agent-loop`;
- 冒烟: `smoke-embed` / `smoke-toolcall` / `smoke-langgraph` / `smoke-interrupt` / `smoke-milvus` / `smoke-bm25` / `smoke-rerank` / `smoke-rag` (bm25 + rerank 两个红线依次跑)。

### 统一错误约定

请求体 / 查询串统一经 zod 校验 (`server/src/api/http.ts` 的 `parseJsonBody` / `parseQuery` / `parseParamInt`), 非法参数返回 `400` + `{ detail }` (含字段路径); `HTTPException` 返回 `{ detail: message }` + 对应状态码; 未捕获异常返回 `500` + `{ detail: "Internal server error; please try again later" }`; 未匹配路径返回 `404` + `{ detail: "Not Found: <path>" }`。

## 对话 API

### POST /api/chat (SSE)

请求: `{ user_id, message, conversation_id? }` (`user_id` / `message` 非空, `conversation_id` 为正整数, 默认 `null`)。

- 消息长度校验: 按 `EN_CHARS_PER_TOKEN` (默认 4) 估算 token 并加固定开销, 超过 `MAX_USER_INPUT_TOKENS` (默认 2000) 直接 `400`, 报错文案给出约 8000 字符的上限;
- `conversation_id` 为空时创建新会话; 会话不存在时以 SSE error 帧返回 "Conversation not found"。

SSE 事件流 (一帧一行 `data:`, 见 `chatRouter`):

| 事件      | 负载                                                               | 含义                                                                                                                                         |
| --------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| (默认)    | `{ delta }`                                                        | 流式文本; 来自 `main_agent` 节点的流式输出, 或确定性节点 (`script_reply` / `complaint_reply` / `fallback_reply`) 一次性给出的整段 answer     |
| tool      | `{ event: "tool", name }`                                          | `agent_tools` 节点执行了某个工具 (不含 `submit_refund`)                                                                                      |
| citations | `{ event: "citations", items }`                                    | 证据引用列表; 由 `retrieve_knowledge` / `retrieve_policy` 节点产出, 每项为 `{ n, id, section_path, question, answer, content_type }`         |
| actions   | `{ event: "actions", items }`                                      | 动作卡片, 发送前按 type 去重; 四种: `select_order` (带 `orders`)、`create_ticket` (带 `draft`)、`refund_form` (带 `draft`)、`transfer_human` |
| interrupt | `{ event: "interrupt", kind, conversation_id, orders?, preview? }` | 图中断, 等待用户操作; `kind` 有两种: `select_order` (带订单列表)、`confirm_ticket` (带 `preview: { ticket_type, description }`)              |
| done      | `{ event: "done", conversation_id }`                               | 本轮结束                                                                                                                                     |
| error     | SSE 帧 `event: error`, 负载 `{ message }`                          | 数据库 (Prisma 错误统一为 "The database is temporarily unavailable...")、上游模型或会话不存在                                                |

流以 `data: [DONE]` 收尾。被 interrupt 中断时不再发 `done` 事件, 直接以 `[DONE]` 结束, 后续走 `/api/actions/resume`。

### POST /api/agent

与 `/api/chat` 相同的输入, 但同步返回整轮结果 JSON, 供测试和联调使用:

```json
{
  "conversation_id": 1,
  "answer": "…",
  "tool_calls": [{ "id": "…", "name": "…", "args": {} }],
  "tool_results": [
    { "tool_call_id": "…", "name": "…", "ok": true, "content": "…" }
  ],
  "suggested_actions": [{ "type": "refund_form", "draft": {} }],
  "interrupt": null
}
```

错误映射: 会话不存在 `404`、Prisma 错误 `503`、其余 `502`。

### POST /api/actions/resume (SSE)

请求 `{ conversation_id, order_id?, confirmed? }`, `order_id` 和 `confirmed` 默认都是 `null`, 至少提供一个 (否则 `400`)。传给图的 resume 值: 有 `order_id` 时为订单号字符串, 否则为 `{ confirmed: boolean }`。用于恢复被 `select_order` / `confirm_ticket` 中断的图, 事件流与 `/api/chat` 完全相同; 错误帧只区分 "Conversation not found" 与上游不可用两种文案。

### POST /api/actions/create-ticket / create-refund

前端动作卡片的直连入口, 不经过 LLM:

- create-ticket: `{ conversation_id, description, ticket_type: "after_sales" | "complaint" | "inquiry" }`, 直接创建工单并把会话状态置为 transferred, 返回 `{ ticket_no, status: "transferred" }`; 数据库错误 `503`;
- create-refund: `{ conversation_id, order_id, reason: "no_reason_7_day" | "quality_issue" | "wrong_item" | "no_longer_wanted" | "other" }`, 以 `ticket_type = "refund"` 创建退款工单, description 为 `Refund request order_id=... reason=...`, 返回 `{ ticket_no, status: "Refund request submitted" }`。

### GET /api/conversations

- `GET /api/conversations?user_id=`: 会话列表 (`user_id` 必填, 缺失 `400`), 返回 `{ items: [{ id, status, preview, has_summary, updated_at }] }`, 最近 50 条, `preview` 取第一条用户消息的前 40 字符;
- `GET /api/conversations/:conversation_id/messages`: 会话消息历史, 返回 `{ items: [{ role, content, created_at }] }`; 会话不存在 `404`。

### POST /api/feedback

`{ conversation_id, rating: "up" | "down", question }`:

- `up`: 只记日志, 返回 `{ ok: true, pooled: false }`;
- `down`: 写入低置信池 (source 为 `user_feedback`), 返回 `{ ok: true, pooled: true }`。若 question 与该会话最后一条用户消息比对一致 (去空白比较) 且图中存有本轮检索快照, 则一并附带快照, 供后续飞轮分析。

### POST /api/extract

售后工单字段抽取: 输入 `{ text }`, 结构化输出 `{ order_id, request_type, expected_solution }`。`request_type` 为 `refund` / `exchange` / `repair` / `complaint` / `other` 之一; `order_id` 只在文本中明确出现时抽取, 占位值 (空串、`null`、`none`、`n/a`、`无`, 大小写不敏感) 归一化为 `null`, 绝不编造。实现是 `EXTRACT_PROMPT` 管道接 zod structured output; 上游失败返回 `502`。

## 知识库 API (/api/kb/*)

- `GET /api/kb/overview`: chunk 统计 `{ total, pending, done, by_content_type, key_clause }`、最近 12 条 chunk、挖掘暂存统计、`db_error`、向量库状态 `{ online, count, collection }` (`count` 为本地向量库向量数)、`consistent` (`pending == 0` 且 `done ==` 向量库数量)、材料清单 `sources` (`data/kb/` 下 6 个文件: product-faq.md → faq、returns-policy.md → policy、after-sales-manual.md → manual、product-specs.md → spec、member-benefits.md → policy、billing-shipping.md → policy)、`content_types` 说明 (faq / policy / manual / spec) 以及 7 个知识库相关 job 的状态;
- `POST /api/kb/preview`: `{ text?, file?, content_type? }` 预览切割结果, 不写库。`file` 必须属于材料清单 (读取 `data/kb/<file>`); 粘贴文本要求非空、不超过 40000 字符且 `content_type ∈ faq / policy / manual / spec`。响应含切割特征 `features` (sections、table_split、overlap、multi_piece_sections)、与库内及本批次指纹比对的 `duplicate` 标记和 `dedup_known`;
- `POST /api/kb/ingest`: 单条录入, 校验规则同 preview 的文本分支。与库内指纹重复的 chunk 跳过 (响应 `skipped` + 最多 5 条 `skipped_samples`); 查重和落库都依赖本地库, 不可达返回 `503`。非重复部分以 pending 状态双写, `vectorize` (默认 `true`) 时立即向量化; 向量化失败返回 `502` 但 chunk 仍保留 pending, 修好 embedding 上游后重新向量化即可, 无需重录;
- `POST /api/kb/vectorize`: 向量化所有 pending chunk, 返回 `{ vectorized, chunk_stats, milvus }`; embedding 上游失败 `502`;
- `POST /api/kb/search`: `{ q, strategy?, top_k? }` 检索试验, `strategy` 四种 (默认 `vector`: `vector` / `bm25` / `hybrid` / `hybrid_rerank`, 见 [RAG](./rag)), `top_k` 1-20 默认 5, 返回 `{ q, strategy, top_k, hits: [{ id, question, answer, score, rerank_score, section_path, content_type, category }] }`; 检索失败 `502`;
- `GET /api/kb/staging?limit=30`: 挖掘暂存区, 按 `extracted` / `kept` / `discarded` / `approved` / `rejected` 五种状态分组返回 (answer 截断 160 字符) + 统计;
- `POST /api/kb/staging/approve` `{ ids: [...] }`: 仅 `kept` 状态的行可审 (无匹配 `409`); 通过后作为 `mined` 类型 chunk 写入知识库并向量化, 失败时回滚已写 chunk、返回 `502`, 状态保持 `kept` 可重试;
- `POST /api/kb/staging/reject` `{ ids: [...] }`: 同样仅针对 `kept` 行, 置为 `rejected`。

## 数据飞轮与评测 API

- `GET /api/review/queue?status=`: 待审队列 `{ items: [{ id, normalized_question, ai_suggested_answer, occurrence_count, review_status, created_at }] }`;
- `GET /api/review/:review_id`: 条目详情 + `approved_answer` + `raws` (归并进该标准化问题的每条原始问题: `{ raw_question, source, reason, retrieved_chunks, created_at }`); 不存在时 `404` "Knowledge gap not found";
- `POST /api/review/:review_id/approve` `{ approved_answer }`: 仅 `pending_review` 可审 (否则 `409`); 批准答案以 `faq` 类型 chunk 写入知识库并向量化, 写回失败回滚 chunk、返回 `502`, 状态不变可重试; 状态更新遇并发冲突返回 `409` (知识已写入, 需人工核对); 成功返回 `{ ok, chunk_ids }`;
- `POST /api/review/:review_id/reject`: 仅 `pending_review` 可拒, 否则 `404` / `409`;
- `GET /api/rag-eval/overview`: 读取 `data/rag/reports/rag_eval.json` (报告不存在时返回 `present: false` 与重跑提示)。有报告时返回 `meta`、`retrieval` (四策略)、`evidence_coverage`、`generation`、`read_notes`、`best` (MRR 最高的策略)、`strategies`、`buckets` (`A_policy` / `B_model` / `C_colloquial` / `E_multi`) 以及产物文件状态与 `eval-rag` job 状态; 页面只读产物, 从不重算;
- `GET /api/rag-eval/faith-cases?status=&page=&size=`: 幻觉案例台账分页 (`page` ≥ 1 默认 1, `size` 1-50 默认 5, `status` ∈ `unresolved` / `resolved` / `dismissed`), 返回 `items`、`total`、`pages`、`counts` 与 `hallucination` 汇总 (evaluated、judged_rate、confirmed_rate、ledger 等); resolved 后又变回 unresolved 的案例带 `reopened: true`;
- `POST /api/rag-eval/faith-cases/:case_id/status` `{ status, resolution }`: 标记 `resolved` 必须写明如何解决, 标记 `dismissed` 必须写明为何无需改动 (`resolution` ≤ 300 字符, 否则 `400`); 案例不存在 `404`;
- `GET /api/observability/overview`: 三个块 —— `cost` (读取 `data/observability/reports/cost_by_intent.json`, 对应 `cost-report` job, 含按意图的 token 账单 rows / total_tokens / total_requests / top)、`trend` (数据库中最近 10 轮评测运行, 指标为 `recall_at_5` / `recall_at_10` / `mrr` / `faithfulness` / `refusal_rate`, 对应 `eval-flywheel` job)、`calibration` (读取 `confidence_calibration.json`, 对应 `calibrate-confidence` job; `in_use` 为 `EVIDENCE_CONFIDENCE_THRESHOLD` 默认 0.26, 权重 top1 = 0.5、valid_count = 0.2、margin = 0.2、key_clause = 0.1, `in_sync` ∈ `match` / `conservative` / `aggressive`)。

## 管理 API 与 job runner

- `GET /api/admin/overview`: 四张状态卡片 `modules[]` —— 知识库 (`kb`, 指向 `/kb`)、RAG 评测 (`rageval`, `/rag-eval`)、数据飞轮 (`review`, `/review`)、可观测性 (`observability`, `/observability`)。每张卡片含 `{ key, title, page, lede, status, headline, metrics, note }`, `status` 为 `ok` / `attention` / `missing` / `error` (读取指标失败时兜底为 error), 一句话结论 `headline` 由指标现场推导;
- `GET /api/admin/jobs` 与 `GET /api/jobs` 等价: `statusAll()`, 不含日志;
- `GET /api/jobs/:name`: 单个 job 状态 + 日志末尾 400 行; 未注册的名字 `404`;
- `POST /api/jobs/:name`: 启动, 已在运行时 `409`;
- `POST /api/jobs/:name/stop`: 停止, 未在运行时 `409`。

job runner 在 `server/src/core/jobs.ts`, API 与 `main.js` 共用:

- 只接受注册过的 13 个 job 名: `kb-preview` / `kb-build` / `kb-mine` / `kb-vectorize` / `kb-repatch` / `kb-reset` / `seed-conv` / `milvus-up` / `milvus-down` / `eval-rag` / `eval-flywheel` / `calibrate-confidence` / `cost-report`。每个 job 的 argv 是固定的 (`node scripts/<name>.ts` 或 `node main.js ...`), 永远不会执行任意 shell 片段;
- job 以 detached 子进程运行 (cwd 为 server 目录), stdout / stderr 重定向到 `log/acceptance/<name>.log`, 日志文件起始写入 `$ <argv>` 和启动时间;
- 同一 job 不能并发运行; 状态机为 `idle → running → ok / failed / stopped`, 退出码 0 记 `ok`, 被停止记 `stopped`;
- 停止时向整个进程组发 `SIGTERM`, 10 秒未退出升级为 `SIGKILL`;
- 状态视图含 `name` / `title` / `cmd` / `needs` / `heavy` / `status` / `pid` / `started_at` / `finished_at` / `returncode` / `log_mtime` (以及可选的 `log`)。

## 前端控制台

CSR-only SPA (`client/`): Lit + @yukino.js/lit-jsx (React 风格 JSX 编译成 lit-html) + Tailwind v4 (@tailwindcss/vite) + @lit-labs/router + Chart.js + motion + @lottiefiles/dotlottie-web + lucide-static。

入口: `index.html` → `app/main.ts`, 以 `createRoot` 渲染 `<app-shell>` (Router 挂载处) 并追加 `<toast-host>`。主题存 localStorage key `yukino_agent2_theme`, `index.html` 内联脚本在首帧前恢复 dark class。开发时 vite 将 `/api` 代理到 `BACKEND_URL ?? http://127.0.0.1:8000`; 构建输出 `dist/`。客户端使用 history 路由, 静态部署需将所有路径回退到 `index.html`。

路由 (`app/components/app-shell.tsx`):

| 路由             | 页面                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------ |
| `/`              | 聊天页: SSE 流式渲染、引用气泡、动作卡片 (选订单 / 工单确认 / 退款表单 / 转人工)、点踩反馈、会话侧边栏 |
| `/admin`         | 管理首页: 四张状态卡片 + job 状态与重跑                                                                |
| `/kb`            | 知识库: 概览、材料切割预览、单条录入、向量化、检索试验、挖掘暂存审核                                   |
| `/rag-eval`      | RAG 评测: 四策略对比图表、忠实度 / 拒答率、幻觉案例处理                                                |
| `/review`        | 待审队列: 标准化问题、出现次数、AI 建议答案、通过 (填写批准答案) / 拒绝                                |
| `/observability` | 可观测性: 按意图 token 账单、评测趋势、置信度校准、阅读笔记                                            |
| 其他路径         | `not-found-page` 兜底                                                                                  |

架构要点:

- 所有组件继承 `LightElement` (`app/lib/light-element.ts`): `createRenderRoot()` 返回 `this`, 渲染到 light DOM, 全局 Tailwind 样式才能生效;
- 页面组件继承 `DataLoaderElement<T>` (`app/lib/page-element.tsx`): `connectedCallback` 设置 `document.title` (统一前缀 "Yukino Select")、滚动到顶部, 首次 connect 自动调用 `load()`; `loading` / `loadError` / `data` 三个 `@state` 驱动三态 UI, `reload()` 支持手动刷新和 job 完成后的回调;
- 依赖查询串的页面从路由接收属性: `/review` 把 `location.search` 作为 `search` 属性传入, `search` 变化时自动重新加载, 页内切换 `?status=` 即切换队列视图;
- `user_id` 来自 localStorage key `yukino_agent2_session_id`, 首次访问用 `crypto.randomUUID()` 生成;
- API 客户端 `app/lib/api.ts`: 非 2xx 时从响应体提取 `detail` 作为错误消息 (与服务端统一错误约定对齐); SSE 解析在 `app/lib/sse.ts`: 按 `\n\n` 分帧、读 `data:` 行, `[DONE]` 结束, `event: error` 帧直接抛错;
- 导航用 `app/lib/router.ts` 的 `navigate()`: `history.pushState` + `router.goto`。
