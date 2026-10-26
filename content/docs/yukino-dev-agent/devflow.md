---
title: "DevFlow"
---

# DevFlow

DevFlow 是 yukino-agent 的第二个产品面: 一个 GitHub 工程副驾, UI 在 `/devflow`, REST 在 `/api/devflow/*`。它连接 GitHub 仓库, 把 issues / pull requests / CI runs 同步进 PostgreSQL, 跑「确定性优先」的 AI 分析 Agent, 维护每仓 RAG 知识库, 并提供对话、记忆、代码工作区、代码图、知识图、多 Agent workflow 编排和多仓 workspace。

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

```
POST /api/devflow/repos
  -> 通过 GitHub API 校验仓库 (或挂载 localPath /  honoring cloneParentDir)
  -> 加密可选 token (AES-256-GCM, lib/devflow/crypto.ts, 密钥 DEVFLOW_SECRET)
  -> sync.ts 同步:
       issues
       pull requests (+ files + review comments)
       workflow runs (+ jobs; 失败的 run 还抓每个 job 的日志)
```

- 所有实体以 GitHub id 为键 (`repoId_githubIssueId` 等), 幂等 upsert
- CI 日志先经 `sanitize.ts` 脱敏 (Python `sanitize_ci_log` 的移植), 再做 head+tail 截断后入库
- GitHub REST 客户端在 `lib/devflow/github.ts`
- 自动同步: `scheduler.ts` 的 `startAutoSyncLoop()` 由 `instrumentation.ts` 启动, 受 `DEVFLOW_AUTO_SYNC_ENABLED` / `_INTERVAL_SECONDS` (默认 900) / `_LIMIT` (默认 30) 控制
- GitHub webhook 入口: `POST /api/devflow/webhooks/github` (校验 `GITHUB_WEBHOOK_SECRET`)

## 分析 Agent (确定性优先)

三个分析 Agent 在 `lib/devflow/agents/analysis.ts`, 提示词在 `agents/prompts.ts`, 输出 schema 在 `schemas.ts`:

- **Issue Triage**: 分类 / 优先级 / 复杂度
- **PR Review**: 关键文件覆盖 / 风险 / 合并决策
- **CI Debug**: 失败类型分类 / 定位 / 修复步骤

设计是「确定性优先」:

1. 规则引擎永远先算出基线 (分类/优先级/复杂度表、CI 失败类型分类器、PR blocking 降级、负责人 allow-list 校验)
2. LLM 输出叠加在基线之上
3. LLM 完全失败时, 持久化确定性结果并标 `generationMode: "deterministic"`, **绝不返回 500**
4. 结果落 `AnalysisResult` 表

`generateStructured()` 在首次响应未通过 schema 校验时, 会用更严格的「只输出 JSON」提醒重试一次 (部分 OpenAI 兼容网关会把 JSON 包在散文里)。

分析支持流式: `POST /api/devflow/{issues,pulls,runs}/:id/analyze/stream` 推送粗粒度 trace 帧 (context / rules / llm / merge), 最后给完整结果。

负责人 allow-list 由 `TeamMember` 表 (每仓成员, `/api/devflow/repos/:id/team-members`) 提供: assignees ∪ team ∪ authors。

## 安全草稿 (ActionDraft)

- Agent 不写 GitHub, 只创建 `ActionDraft` 行 (状态 `pending_confirmation`)
- 只有 `PATCH /api/devflow/drafts/:id { action: "execute" }` 才真正调用 GitHub API (`lib/devflow/drafts.ts`)
- UI 要求显式确认对话框
- 对话 Agent 通过 `create_action_draft` 工具走同一条路径

## 每仓 RAG 知识库

`lib/devflow/rag.ts` 维护每个仓库独立的知识库:

- 文档 SHA-256 去重 -> 结构感知分块 -> embed -> 存进共享 Milvus collection, `source = "devflow:kb:<repoId>:<docId>"`, 检索时用 `source like` 过滤限定到单仓
- 接受 text/markdown/code/JSON/CSV/log/YAML/XML/HTML (`TEXT_EXTENSIONS`) 以及 PDF/DOCX (`extractText` -> `lib/ai/doc-extract.ts`)
- `askKnowledge()` 做证据支撑的问答, 带编号引用, 拒绝伪造; **答案门控** (Python `answer_gate` 的移植) 在问题的强信号 (标识符、`#123` 引用、长数字) 一个都没出现在证据里时拒答, 对模糊指代提问要求澄清
- 周报 (`agents/report.ts`) 也写进这里; 建索引失败不会丢弃已生成的报告

结构感知分块器 `lib/devflow/chunking.ts` (Python `structure_aware_v1` 的移植): markdown 章节/代码围栏、CSV 表头感知行、JSON key path、代码符号区域, 稳定的 sha256 chunk/parent id。

定向检索走 `scopedRetrieve()` (`lib/devflow/search.ts`): 过量取回 -> 指纹 + Jaccard 近重复去除 -> 每个 parent 最多 2 个 chunk -> rerank (有 `RERANK_API_KEY` 用 DashScope, 否则用 `retrieval-post.ts` 的启发式重排) -> topK -> 通过 `metadata.sibling_ids` 做兄弟块扩展。

文档级 RAG-studio 能力:

- chunk 预览: `GET /api/devflow/knowledge/:docId/chunks` (用标量过滤精确读回入库的行)
- 失败文档重试: `POST /api/devflow/knowledge/:docId/retry` (原文存在 `KnowledgeDocumentBody` 1:1 侧表)
- 直接建记忆笔记: `POST /api/devflow/knowledge/notes` (生成 `memory_note` 文档)
- 仓库 RAG 状态: `GET /api/devflow/knowledge/status`
- 检索参数 (方法/rerank/topK/分数阈值/chunk 大小+overlap) 每仓可配: `GET|PUT /api/devflow/knowledge/config` (`KnowledgeBaseConfig` 表); 检索质量用 `RetrievalTestRun` 测试

## 对话 Agent

`lib/devflow/agents/chat.ts`, 用 `streamText` + 仓库范围工具。`POST /api/devflow/chat` 流式 SSE (`connected` / `message` / `tool` / `done` / `error`), 与 OnCall 的 `/api/chat_stream` 同帧格式。对话以会话为后端: 请求 `{ repoId, conversationId?, message }`, 服务端解析/创建会话并持久化消息。

从老项目移植的韧性设计:

- 重复的相同工具调用, 2 次后熔断
- 工具错误分 8 类, timeout/network/rate-limit 类自动重试一次
- 上下文溢出时用缩小的历史窗口重试
- 空回答降级为诚实的工具轨迹摘要
- 失败的轮次也持久化为 assistant 消息, 保证反馈锚点不丢

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

对话答案会带 `citations` (从检索工具收集的知识命中, 持久化进消息 meta 并在 `done` 帧推送)。

## 记忆系统

`lib/devflow/memory.ts` + 表 `ConversationMemory` / `ThreadMemory` / `MemoryCandidate` / `RecallEvent`:

- **会话封存**: `sealConversation` / `maybeSealAndMerge` 把长对话封存并合并进线程记忆 (`mergeThreadMemory`)
- **候选审批**: `proposeMemoryCandidate` 产出待确认记忆, `approveMemoryCandidate` / `rejectMemoryCandidate` 人工裁决
- **证据召回**: `search_evidence` 工具 (老项目 `devflow_search_evidence`) 对仓库知识库和同步的 GitHub 内容索引做语义召回
- **逐字转录**: `read_conversation_transcript` (老项目 `devflow_get_thread_context`) 带关键词过滤和向后翻页, 能取到超出 30 条模型窗口的历史
- **召回审计**: `recordRecallEvent` 记录每次召回, `GET /api/devflow/repos/:id/memory/recall-events` 列出审计轨迹

GitHub 内容索引 (`lib/devflow/content-index.ts`) 把同步的 issues / PRs / CI 日志做语义索引, 供记忆面板搜索框和 `search_evidence` 使用。

长对话的上下文压缩在 `lib/devflow/context-compression.ts` (Python `ProgressiveContextManager` 的移植): token 压力分级、按 token 预算裁剪历史窗口、LLM 压缩成持久化的 compact-boundary 消息 (带会话记忆/抽取式兜底)、关键事实保留和失败熔断。检索结果喂给 LLM 前, `extractRelevantSnippet` + `compressRetrievalResults` 会在每条 (260 token) 和全局 (`min(1800, max(520, topK*260))` token) 预算内, 把 chunk 压到与 query 最相关的句子。

## Workflow 编排 (多 Agent)

`lib/devflow/agents/workflow.ts` (老项目 Planner / Observer / Synthesis):

- `POST /api/devflow/chat/plan`: 对同步实体规划有界 claim (LLM + 确定性兜底; 超出仓库数据的 claim 被拒绝)
- `POST /api/devflow/chat/plan/execute`: SSE 流式执行任务 (同实体串行, 跨实体并行 ≤3, 每任务 90s 超时, ≤2 次 replan)
- observer 的发现 (blocker/warning + 置信度综合) 和决策备忘录持久化进 `AgentWorkflowRun` / `AgentTaskRun`
- 安全不变量结构性保留: workflow 任务只读, GitHub 写操作仍只通过确认过的 `ActionDraft`
- 对话里也可用 `run_engineering_workflow` 工具触发
- UI: `/devflow/workflow-runs`

## 代码工作区 / 代码图 / 知识图

**代码工作区** (`lib/devflow/workspace.ts`): 每仓一个服务端浅克隆 (`git clone --depth 1`, 或 `fetch` + `pull --ff-only` 刷新), 通过 `execFile` 的 argv 数组执行 (无 shell, repo/branch/token 无法注入命令), 落在 `config.devflow.workspace.checkoutDir` (默认 `./data/workspaces/<repoId>-<owner>__<name>`, 已 git-ignore 且从 tsconfig/eslint 排除)。暴露路径守卫的只读文件工具 (`listFiles` / `readCodeFile` / `searchCode` 打分词法扫描), 拒绝路径穿越、VCS/构建目录、二进制和密钥文件 (`.env`、`.npmrc` 等)。`lib/devflow/project-index.ts` 发现仓库文档/清单 (README、package.json、docs/、CI 配置), 分块 + embed 进 Milvus (`source = "devflow:project:<repoId>:<docHash>"`), 用 `ProjectIndex` 行跟踪状态/指纹/摘要/陈旧度。UI: `/devflow/code`。

**代码图** (`lib/devflow/code-graph.ts`): 在托管 checkout 上用正则抽取符号/关系 (imports/calls/defines; 支持 TS/JS/Py/Go/Rust/Java/SQL/shell 符号族) 进 `CodeSymbol` / `CodeRelation`。`POST /api/devflow/repos/:id/code-graph` 重建, GET 符号搜索, `impact` 返回改动文件的一跳依赖方; PR review 和 CI debug 的上下文会收到 impact 摘要 (重建前诚实地为 null)。UI: `/devflow/code-graph`。

**知识图** (`lib/devflow/knowledge-graph.ts`): 从同步数据派生关系边 (#N 引用、closing-keyword 解决、assignee/author、周报文档、会话决策) 进 `KnowledgeGraphEdge`; 每次同步后重建; `subgraph` 端点做 BFS ≤2 跳 / 72 节点上限。UI: `/devflow/graph` (静态分层 SVG + 邻接表)。

## Skills

`lib/devflow/skills.ts` + `data/devflow-skills/*/SKILL.md`: 六个带 YAML frontmatter 的工程剧本 (issue-triage、pr-review、ci-debug、weekly-report、safety-draft、project-investigation)。对话 Agent 的系统提示永远携带技能目录, 并注入触发匹配的技能的完整 workflow 说明 (显式点名优先); 激活按触发词打分 (ASCII 词边界 + CJK 子串), `references|templates|scripts|assets/...` 资源路径守卫加载。`GET /api/devflow/skills(+/:name)` 列出/查看。

## 多仓 Workspace

`lib/devflow/workspaces.ts`: 多仓分组 (`Workspace`), 聚合统计 (prisma groupBy), 跨仓报告 (确定性风险分级 P0/P1/P2 + LLM 叙述, 带模板兜底; 每仓周报 fire-and-forget 存进知识库)。路由 `/api/devflow/workspaces*`, UI `/devflow/workspaces`。

## 反馈与推荐

- 对话反馈: `ChatFeedback` 表, `/api/devflow/feedback*` (含 `metrics` 和按 messageId 的 `trace`), 可选飞书 webhook (`DEVFLOW_FEISHU_WEBHOOK_URL`)
- 推荐问题: `GET /api/devflow/repos/:id/recommendations` 返回上下文相关的建议问题 (老项目 RecommendationAgent 的纯规则移植), 作为对话空状态的芯片

## 数据模型

DevFlow 相关的 Prisma 表 (`prisma/schema.prisma`):

`Repository` `Issue` `PullRequest` `PrFile` `PrReviewComment` `WorkflowRun` `AnalysisResult` `ActionDraft` `KnowledgeDocument` `KnowledgeDocumentBody` `KnowledgeBaseConfig` `RetrievalTestRun` `ProjectIndex` `Conversation` `ChatMessage` `ChatFeedback` `ConversationMemory` `ThreadMemory` `MemoryCandidate` `RecallEvent` `AgentWorkflowRun` `AgentTaskRun` `CodeSymbol` `CodeRelation` `KnowledgeGraphEdge` `Workspace` `TeamMember` `User` `AuditLog`

## API 与 UI 一览

UI 页面 (`app/devflow/`): 概览、`chat`、`issues`、`pulls`、`ci`、`repos`、`knowledge`、`code`、`code-graph`、`graph`、`drafts`、`workflow-runs`、`workspaces`、`reports`、`feedback`。

REST 路由 (`app/api/devflow/`): repos (+ 子资源 issues/pulls/runs/sync/reindex/graph/code-graph/workspace/project-index/memory/team-members/recommendations/conversations)、chat (+ plan / plan/execute)、knowledge (+ ask/search/config/notes/status/retrieval-tests/:docId/chunks/retry)、drafts、feedback、analyses、reports、skills、workspaces、workflow-runs、audit-logs、stats、webhooks/github。

所有响应包成 `{ message, data }` (`lib/devflow/http.ts`), 且本地化: `fail(status, key, args?)` 按 key 取译文, `failRaw()` 是动态诊断 (异常/GitHub API 文本) 的显式逃生口; 成功的 `"OK"` / `"ok"` 是协议常量, 不翻译。

## 离线验证

`npx tsx tests/devflow-*.smoke.ts` 系列覆盖各子系统: `devflow-analysis` (分析 Agent)、`devflow-skills` (技能注册)、`devflow-workflow` (编排)、`devflow-memory` (记忆)、`devflow-code-graph`、`devflow-graph` (知识图)、`devflow-content-index`、`devflow-context-compression`、`devflow-chat-resilience`、`devflow-workspaces`、`devflow-github-schemas`、`devflow-defects`、`devflow-b` (工作区发现/分类/分块, 无需 embedding)、`chunking`、`doc-extract`。
