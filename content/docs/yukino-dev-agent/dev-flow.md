---
title: "DevFlow"
---

# DevFlow

DevFlow 是 yukino-dev-agent 的第二个产品面: 一个 GitHub 工程副驾, UI 在 `/dev-flow`, REST 在 `/api/dev-flow/*`。它连接 GitHub 仓库, 把 issues / pull requests / CI runs 同步进 PostgreSQL, 跑「确定性优先」的 AI 分析 Agent, 维护每仓 RAG 知识库, 并提供对话、记忆、代码工作区、代码图、知识图、多 Agent workflow 编排和多仓 workspace。

核心安全原则: **Agent 从不直接写 GitHub**, 所有写操作只生成草稿, 需人工确认才执行。

## 核心能力

- **仓库健康摘要** (repo health): 同步 GitHub 仓库, 生成包含 issues、pull requests、CI 的健康摘要
- **issue 诊断** (issue triage agent): 分析 issue 的分类、优先级、复杂度, 推荐负责人, 生成需求描述和 TODO list
- **PR 风险审查** (pr review agent): 理解代码变更, 分析安全风险, 给出「同意合并」或「拒绝合并」的明确决策建议
- **CI 失败排查** (ci debug agent): 分析 CI 失败日志, 定位错误, 给出修复步骤
- **多 Agent 协同决策** (workflow): 对「PR 是否可以合并」等复杂问题, planner、PR agent、CI agent 和 observer 协作给出结论
- **长对话和记忆** (memory): 理解长上下文, 支持自动记忆、长期记忆和候选审批
- **自动周报与沉淀** (report): 自动生成周报, 写回知识库
- **安全草稿** (safety draft): 关闭 issue 等写操作只生成草稿供人工确认, 不擅自执行高风险动作
- **代码工作区 / 代码图 / 知识图**: 只读浏览仓库代码, 抽取符号依赖和实体关系

## 数据流

```text
POST /api/dev-flow/repos
  -> 通过 GitHub API 校验仓库 (fetchRepoMeta 取 github id / 描述 / 默认分支 / clone url)
  -> 加密可选 token (AES-256-GCM, lib/dev-flow/crypto.ts, 密钥 DEV_FLOW_SECRET)
  -> sync.ts 同步:
       issues
       pull requests (+ files + review comments)
       workflow runs (+ jobs; 失败的 run 还抓每个失败 job 的日志)
```

- 所有实体以复合唯一键幂等 upsert: `repoId_githubIssueId` / `repoId_githubPrId` / `repoId_githubRunId`
- 同步条数 `limit` 夹在 1–100 (默认 30); provider 目前只接受 `github` / `github_compatible`
- token 加密细节 (`lib/dev-flow/crypto.ts`): AES-256-GCM, 密钥为 `scryptSync(DEV_FLOW_SECRET, "dev-flow-token-v1", 32)`, 密文为 base64 的 `iv.tag.cipher` 用 `.` 拼接
- 失败的 run 最多抓 3 个失败 job 的日志 (`MAX_FAILED_JOB_LOGS`), 先经 `sanitize.ts` 的 `sanitizeCiLog` 脱敏 (私钥、`gh[pousr]_` token、AWS `AKIA` key、JWT、bearer、`::add-mask::`、`key=value` 形式的 secret), 再做 head/tail 各 20k 字符截断 (`LOG_HEAD_CHARS` / `LOG_TAIL_CHARS`) 后入库
- GitHub REST 客户端在 `lib/dev-flow/github.ts`: 固定 `Accept: application/vnd.github+json`、`X-GitHub-Api-Version: 2022-11-28`、`User-Agent: yukino-dev-flow`, 错误统一包成 `GitHubApiError`
- 每次同步结束 fire-and-forget 重建知识图 (`rebuildGraph`), 并更新 `lastSyncAt` / `lastSyncError`
- 自动同步: `scheduler.ts` 的 `startAutoSyncLoop()` 由 `instrumentation.ts` 启动, globalThis 守卫防止重复实例; 首次运行在启动后 5s, 间隔下限 30s; 受 `DEV_FLOW_AUTO_SYNC_ENABLED` (须为 `true`) / `DEV_FLOW_AUTO_SYNC_INTERVAL_SECONDS` (默认 900) / `DEV_FLOW_AUTO_SYNC_LIMIT` (默认 30) 控制
- GitHub webhook 入口: `POST /api/dev-flow/webhooks/github` (校验 `GITHUB_WEBHOOK_SECRET`)

## 分析 Agent (确定性优先)

三个分析 Agent 在 `lib/dev-flow/agents/analysis.ts`:

- **Issue Triage**: 分类 (bug/documentation/test/ops/refactor/feature/question, 默认 feature) / 优先级 (P0–P3, 默认 P2) / 复杂度 (S/M/L/XL) / 区域 / 负责人
- **PR Review**: 风险发现、合并决策 (reject/hold/merge_with_changes/approve); `mergePrReview` 在存在 blocking 发现时把 approve 强制降级为 merge_with_changes
- **CI Debug**: 失败类型分类 (permission/environment/dependency/lint/build/test/unknown) / 定位 / 修复步骤

设计是「确定性优先」:

1. 规则引擎永远先算出基线 (分类/优先级/复杂度表、CI 失败类型分类器、PR blocking 降级、负责人 allow-list 校验)
2. LLM 输出叠加在基线之上 (`mergeIssueAnalysis` / `mergePrReview` / `mergeCiDebug`)
3. LLM 完全失败时, 持久化确定性结果并标 `generationMode: "deterministic"`, **绝不返回 500**
4. 结果经 `saveAnalysis` 落 `AnalysisResult` 表

`generateStructured()` 在首次响应未通过 schema 校验时, 会用更严格的「只输出 JSON」提醒重试一次 (部分 OpenAI 兼容网关会把 JSON 包在散文里)。

输入有统一裁剪预算: issue body 6000 字符 (`BODY_CHARS`)、每文件 patch 4000 / 总 patch 40000 (`PATCH_CHARS_PER_FILE` / `PATCH_CHARS_TOTAL`)、CI 日志 40000 (`LOG_CHARS`)、相似 issue 上限 20 (`SIMILAR_ISSUES`)。PR review 与 CI debug 的上下文还会收到 `impactForFiles` 的一跳依赖摘要 (代码图未就绪时诚实地为 null)。

负责人 allow-list 由 `TeamMember` 表 (每仓成员, `/api/dev-flow/repos/:id/team-members`) 提供: assignees ∪ 历史 authors ∪ team logins ∪ issue 作者; LLM 推荐的负责人若不在 allow-list, 校验结果标为 replaced 并回退。

分析支持流式: `POST /api/dev-flow/{issues,pulls,runs}/:id/analyze/stream` 推送粗粒度 trace 帧 (stage: context / rules / llm / merge), 最后给完整结果帧。

## 安全草稿 (ActionDraft)

- Agent 不写 GitHub, 只创建 `ActionDraft` 行 (状态 `pending_confirmation`); 动作类型: `issue_comment` / `create_issue` / `close_issue` / `add_labels` / `send_report`
- 只有 `PATCH /api/dev-flow/drafts/:id` 带 `{ "action": "execute" }` 才真正调用 GitHub 写 API (`lib/dev-flow/drafts.ts` 的 `executeDraft`), 拒绝走 `{ "action": "reject" }`; 执行后状态变为 `executed` / `failed`
- 执行草稿要求 `draft:approve` 权限 (见下文权限节)
- 对话 Agent 通过 `create_action_draft` 工具走同一条路径

## 每仓 RAG 知识库

`lib/dev-flow/rag.ts` 维护每个仓库独立的知识库:

- 文档 SHA-256 `contentHash` 去重 (同内容不重复 embed) -> 结构感知分块 (`chunk_strategy = structure_aware_v1`, chunk 800 token / overlap 100) -> embed -> 存进共享 Milvus collection (`config.milvus.collection`, 默认 `yukino_knowledge`), `source = "dev_flow:kb:<repoId>:<docId>"`, 检索时用 `source like` 过滤限定到单仓
- 接受 `TEXT_EXTENSIONS` 里的 text/markdown/code/JSON/CSV/log/YAML/XML/HTML 以及 PDF/DOCX (`lib/ai/doc-extract.ts`)
- 检索方法 hybrid/dense/bm25, 每仓可配 (`KnowledgeBaseConfig`, 缺省回退: hybrid、rerank 开、topK 5、scoreThreshold 0.5)
- `askKnowledge()` 做证据支撑的问答, 带编号引用, 拒绝伪造; 输出结论四选一: answer / insufficient_evidence / conflict / ask_clarification。**答案门控**: 问题的强信号 (标识符类 token、`#123` 引用、3 位以上数字, 由 `STRONG_SIGNAL_RE` 提取) 若一个都没出现在证据里则拒答, 模糊指代则要求澄清
- 周报 (`agents/report.ts` 的 `generateWeeklyReport`) 经 `addKnowledgeDocument` (sourceType `weekly_report`) 写进这里, 失败时回退 `deterministicWeeklyReport`; 建索引失败不会丢弃已生成的报告

结构感知分块器 `lib/dev-flow/chunking.ts`: markdown 章节/代码围栏、CSV 表头感知行、JSON key path、其余走通用分块; 每文档最多 5000 chunk (`MAX_CHUNKS_PER_DOCUMENT`), 稳定的 sha256 chunk/parent id。

定向检索走 `scopedRetrieve()` (`lib/dev-flow/search.ts`): 过量取回 (候选数 `min(max(topK * (rerank ? 8 : 2), 20), 100)`) -> Jaccard ≥ 0.9 近重复去除 (`retrieval-post.ts`) -> 每个 parent 最多 2 个 chunk (`MAX_CHUNKS_PER_PARENT`) -> rerank (配置了 `RERANK_API_KEY` 用 DashScope, 否则启发式重排) -> topK -> 通过 `metadata.sibling_ids` 做兄弟块扩展。

文档级 RAG-studio 能力:

- chunk 预览: `GET /api/dev-flow/knowledge/:docId/chunks`
- 失败文档重试: `POST /api/dev-flow/knowledge/:docId/retry` (原文存在 `KnowledgeDocumentBody` 1:1 侧表)
- 直接建记忆笔记: `POST /api/dev-flow/knowledge/notes` (生成 `memory_note` 文档)
- 仓库 RAG 状态: `GET /api/dev-flow/knowledge/status`
- 检索参数每仓可配: `GET | PUT /api/dev-flow/knowledge/config`; 检索质量用 `RetrievalTestRun` 回归测试

## 对话 Agent

`lib/dev-flow/agents/chat.ts`, 用 `streamText` + 仓库范围工具, `stopWhen` 为 `isStepCount(12)`。`POST /api/dev-flow/chat` 流式 SSE (事件 `connected` / `message` / `tool` / `done` / `error`)。对话以会话为后端: 请求 `{ repoId, conversationId?, message }`, 服务端解析/创建会话并持久化消息。

韧性设计:

- 重复的相同工具调用, 2 次后熔断 (`MAX_REPEATED_TOOL_CALLS`)
- 工具错误分 8 类 (`ToolErrorKind`), timeout / rate_limited / transient_network 三类自动重试一次 (`TOOL_RETRY_ATTEMPTS`)
- 上下文溢出 (`isContextOverflowError`) 时用缩小的历史窗口重试 (`HISTORY_LIMIT = 30`, `HISTORY_RETRY_LIMIT = 8`)
- 空回答降级为诚实的工具轨迹摘要 (`buildEmptyAnswerFallback`)
- 失败的轮次也持久化为 assistant 消息, 保证反馈锚点不丢
- 工具结果截断上限 12000 字符 (`MAX_TOOL_RESULT_CHARS`); citations 最多 12 条 (`MAX_CITATIONS`), 持久化进消息 meta 并在 `done` 帧推送

仓库范围工具 (22 个):

| 类别       | 工具                                                                              |
| ---------- | --------------------------------------------------------------------------------- |
| 实体读取   | `list_issues` `get_issue` `list_pulls` `get_pull` `list_ci_runs` `get_ci_run`     |
| 知识检索   | `search_knowledge` `search_project_docs`                                          |
| 触发分析   | `analyze_issue` `analyze_pull` `analyze_ci_run`                                   |
| 报告/健康  | `generate_weekly_report` `repo_health`                                            |
| 写草稿     | `create_action_draft`                                                             |
| 代码工作区 | `workspace_list_files` `workspace_read_file` `workspace_search_code`              |
| 记忆       | `memory_recall` `memory_propose` `search_evidence` `read_conversation_transcript` |
| 编排       | `run_engineering_workflow`                                                        |

## 记忆系统

`lib/dev-flow/memory.ts` + 表 `ConversationMemory` / `ThreadMemory` / `MemoryCandidate` / `RecallEvent`:

- **会话封存**: `sealConversation` / `maybeSealAndMerge` 把长对话封存并合并进线程记忆 (`mergeThreadMemory`); 封存触发阈值 8 条消息 (`SEAL_MESSAGE_THRESHOLD`), 转录上限 120 条、每条 500 字符
- **记忆种类**: decision / fact / task / preference / repo_context
- **候选审批**: `proposeMemoryCandidate` 产出待确认记忆, `approveMemoryCandidate` / `rejectMemoryCandidate` 人工裁决; 批准的候选会写成一篇 `memory_note` 知识库文档进入检索
- **证据召回**: `search_evidence` 工具对仓库知识库和同步的 GitHub 内容索引做语义召回 (`searchRepoMemory`)
- **逐字转录**: `read_conversation_transcript` 带关键词过滤和向后翻页, 能取到超出模型窗口的历史
- **召回审计**: `recordRecallEvent` 记录每次召回, `GET /api/dev-flow/repos/:id/memory/recall-events` 列出审计轨迹

GitHub 内容索引 (`lib/dev-flow/content-index.ts`) 把同步的 issues / PRs / CI 日志做语义索引 (source 前缀 `dev_flow:item:`, CI 日志按 8000 字符分块、最多 6 块), 供记忆面板搜索框和 `search_evidence` 使用; 还提供 `mapSimilarHits` (相似 issue) 与 `buildReviewChecklist`。

长对话的上下文压缩在 `lib/dev-flow/context-compression.ts`: token 压力五级分级 (normal / warning / auto_compact / aggressive / manual_path), 输入预算 `CONTEXT_MAX_INPUT_TOKENS = 24000`; LLM 压缩结果持久化为 `compact_boundary` 子类型消息 (带会话记忆/抽取式兜底)。检索结果喂给 LLM 前, `extractRelevantSnippet` + `compressRetrievalResults` 会在每条 (260 token) 和全局 (`min(1800, max(520, topK * 260))` token) 预算内, 把 chunk 压到与 query 最相关的句子。

## Workflow 编排 (多 Agent)

`lib/dev-flow/agents/workflow.ts` (Planner / Observer / Synthesis):

- 实体类型 issue / pull_request / workflow_run / repository; 任务类型 issue_analysis / pr_review / ci_debug / repo_health, 对应 agent 名 `issue_analyst_agent` / `pr_review_agent` / `ci_debug_agent` / `repo_health_agent`
- `POST /api/dev-flow/chat/plan`: 对同步实体规划有界 claim (LLM + 确定性兜底 `deterministicPlanSpec`; `validateClaims` 拒绝重复 id、空 ref、类型不匹配、越界的 claim)
- `POST /api/dev-flow/chat/plan/execute`: SSE 流式执行任务 (同实体串行, 跨实体并行 ≤3, 每任务 90s 超时, ≤2 次 replan)
- observer 的发现类型: task_failed / task_skipped / high_priority_issue / ci_merge_gate / pr_blocking_issues / cross_agent_conflict / evidence_gap / low_confidence; synthesize 决策备忘录有 `deterministicMemo` 兜底
- 运行记录持久化进 `AgentWorkflowRun` / `AgentTaskRun`
- 安全不变量结构性保留: workflow 任务只读, GitHub 写操作仍只通过确认过的 `ActionDraft`
- 对话里也可用 `run_engineering_workflow` 工具触发
- UI: `/dev-flow/workflow-runs`

## 代码工作区 / 代码图 / 知识图

**代码工作区** (`lib/dev-flow/workspace.ts`): 每仓一个服务端浅克隆 (`git clone --depth 1`, 或 `fetch` + `checkout` + `pull --ff-only` 刷新), 通过 `execFile` 的 argv 数组执行 (无 shell, repo/branch/token 无法注入命令), 落在 `config.devFlow.workspace.checkoutDir` (env `DEV_FLOW_REPO_CHECKOUT_DIR`, 默认 `./data/workspaces`), 路径为 `<repoId>-<owner>__<name>`。守卫参数: git 超时 180s、单文件上限 300000 字节、单次扫描上限 2000 文件。暴露路径守卫的只读文件工具 (`listFiles` / `readCodeFile` / `searchCode` 打分词法扫描), 拒绝路径穿越、VCS/构建目录 (`SKIP_DIRS`) 和密钥文件 (`SECRET_FILENAMES`: `.env`、`.npmrc` 等)。UI: `/dev-flow/code`。

**项目索引** (`lib/dev-flow/project-index.ts`): `discoverProjectDocs` 发现仓库文档/清单 (README、package.json 等 manifest、docs/ 目录、CI 配置), 按 1800/180 分块 + embed 进 Milvus (source 前缀 `dev_flow:project:`, 文档键为 `dev_flow:project:<repoId>:<sha256(相对路径)[0:16]>`), 用 `ProjectIndex` 行跟踪状态/指纹/摘要/陈旧度。对应工具 `search_project_docs`。

**代码图** (`lib/dev-flow/code-graph.ts`): 在托管 checkout 上用正则抽取符号/关系 (关系: imports / calls / defines; 符号族覆盖 TS/JS/Py/Go/Rust/Java/SQL/shell) 进 `CodeSymbol` / `CodeRelation`。`POST /api/dev-flow/repos/:id/code-graph` 重建, GET 符号搜索, `impact` 返回改动文件的一跳依赖方 (`IMPACT_MAX_FILES = 50`, 列表上限 1000); PR review 和 CI debug 的上下文会收到 impact 摘要。UI: `/dev-flow/code-graph`。

**知识图** (`lib/dev-flow/knowledge-graph.ts`): 从同步数据派生关系边 (`#N` 引用 references、closing-keyword 解决 resolves、assigned_to / authored_by、周报文档 documents、会话决策 decides, 带置信度) 进 `KnowledgeGraphEdge`; 节点类型 issue / pull_request / team_member / github_user / knowledge_document / conversation; 每次同步后重建 (`rebuildGraph`)。`graphSummary` 限 500 节点, `subgraph` 端点做 BFS ≤2 跳 / 72 节点上限 (`GRAPH_NODE_LIMIT`), 最近边限 20 条。UI: `/dev-flow/graph`。

## Skills

`lib/dev-flow/skills.ts` + `data/dev-flow-skills/*/SKILL.md`: 六个带 YAML frontmatter (`SkillManifest`) 的工程剧本: ci-debug、issue-triage、pr-review、project-investigation、safety-draft、weekly-report。对话 Agent 的系统提示永远携带技能目录, 并注入触发匹配的技能的完整 workflow 说明 (显式点名优先, 自动注入最多 3 个, `MAX_AUTO_SKILLS`); 激活按触发词打分 (ASCII 词边界 + CJK 子串), `references | templates | scripts | assets/...` 资源路径守卫加载 (最多 8 个资源、单个 64KB), 提示块渲染上限 24000 字符。`GET /api/dev-flow/skills(+/:name)` 列出/查看。

## 多仓 Workspace

`lib/dev-flow/workspaces.ts`: 多仓分组 (`Workspace` 表), 聚合统计 (`aggregateWorkspaceStats`, prisma groupBy)。跨仓报告 `generateMultiRepoReport`: 确定性风险分级 (P0/P1/P2, `classifyRepoRisk`; 阈值 `STALE_PR_DAYS = 14`、`OPEN_PR_BACKLOG = 5`、`OPEN_ISSUE_BACKLOG = 5`) + LLM 叙述, 带模板兜底; 每仓周报 fire-and-forget 存进知识库。路由 `/api/dev-flow/workspaces(+/:id/report)`, UI `/dev-flow/workspaces`。

## 反馈与推荐

- 对话反馈: `ChatFeedback` 表, rating helpful/unhelpful, 原因 inaccurate / not_relevant / missing_context / unreliable_citation / tool_error / other; 人工 review 状态 open / in_review / resolved / dismissed; 路由 `/api/dev-flow/feedback(+metrics/trace)`, 可选飞书 webhook (`DEV_FLOW_FEISHU_WEBHOOK_URL`), trace 链接基址 `DEV_FLOW_FEEDBACK_TRACE_BASE_URL`
- 推荐问题: `GET /api/dev-flow/repos/:id/recommendations` 返回纯规则 (`buildRecommendations`) 生成的上下文相关建议问题, 作为对话空状态的芯片

## 权限与审计

`lib/dev-flow/permissions.ts`: 权限集 `repo:read` / `repo:sync` / `agent:run` / `draft:create` / `draft:approve` / `eval:read` / `settings:manage`, 角色 owner / maintainer / developer / viewer; 本地开发由 `ensureDemoUser` 提供 `demo-owner` 用户。敏感操作经 `writeAuditLog` 落 `AuditLog` 表, `GET /api/dev-flow/audit-logs` 可查。

## 数据模型

DevFlow 相关的 Prisma 表 (`prisma/schema.prisma`):

`Repository` `Issue` `PullRequest` `PrFile` `PrReviewComment` `WorkflowRun` `AnalysisResult` `ActionDraft` `KnowledgeDocument` `KnowledgeDocumentBody` `KnowledgeBaseConfig` `RetrievalTestRun` `ProjectIndex` `Conversation` `ChatMessage` `ChatFeedback` `ConversationMemory` `ThreadMemory` `MemoryCandidate` `RecallEvent` `AgentWorkflowRun` `AgentTaskRun` `CodeSymbol` `CodeRelation` `KnowledgeGraphEdge` `Workspace` `TeamMember` `User` `AuditLog`

Milvus 侧用 source 前缀隔离三类内容: `dev_flow:kb:` (知识库文档)、`dev_flow:project:` (项目索引)、`dev_flow:item:` (GitHub 内容索引); 仓库删除时按这三个前缀清理 (`repoMilvusCleanupPrefixes`)。

## API 与 UI 一览

UI 页面 (`app/dev-flow/`): 概览、`chat`、`issues`、`pulls`、`ci`、`repos`、`knowledge`、`code`、`code-graph`、`graph`、`drafts`、`workflow-runs`、`workspaces`、`reports`、`feedback`。

REST 路由 (`app/api/dev-flow/`): repos (+ 子资源 issues/pulls/runs/sync/reindex/graph/subgraph/code-graph/impact/workspace/project-index/memory/recall-events/memory-candidates/team-members/recommendations/conversations)、chat (+ plan / plan/execute)、knowledge (+ ask/search/config/notes/status/retrieval-tests/:docId/chunks/retry)、drafts、feedback (+ metrics/trace)、analyses、reports (+ repo-health)、skills (+/:name)、workspaces (+/:id/report)、workflow-runs (+/:id)、audit-logs、stats、webhooks/github、content-index、memory、conversations/:id/messages、issues/:id/analyze (+stream/similar)、pulls/:id/analyze (+stream/review-checklist)、runs/:id/debug (+stream/failed-jobs)。

所有响应包成 `{ message, data }` (`lib/dev-flow/http.ts`), 且本地化: `fail(status, key, args?)` 按 key 取 `api.devFlow` 命名空间译文, `failRaw()` 是动态诊断 (异常/GitHub API 文本) 的显式逃生口; 成功的 `"OK"` 是协议常量, 不翻译。

## 离线验证

`npx tsx tests/*.smoke.ts` 系列覆盖各子系统: `dev-flow-analysis` (分析 Agent)、`dev-flow-skills` (技能注册)、`dev-flow-workflow` (编排)、`dev-flow-memory` (记忆)、`dev-flow-code-graph`、`dev-flow-graph` (知识图)、`dev-flow-content-index`、`dev-flow-context-compression`、`dev-flow-chat-resilience`、`dev-flow-workspaces`、`dev-flow-github-schemas`、`dev-flow-defects`、`dev-flow-b` (工作区发现/分类/分块, 无需 embedding)、`chunking`、`doc-extract`。
