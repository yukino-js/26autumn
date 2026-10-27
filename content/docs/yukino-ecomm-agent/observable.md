---
title: "可观测性和数据飞轮"
description: "从 server 源码出发, 讲清 Langfuse 双链路 tracing、防劣化的离线评测流水线与 job runner、阅读笔记、幻觉案例台账, 以及低置信问题池驱动的数据飞轮闭环"
---

一个请求对应一个 trace 树; LLM API 调用、文档检索、工具调用等, 都是 trace 树上的 span 节点。可观测性回答「这一轮对话的钱和延迟花在哪」; 评测流水线回答「系统改动之后是变好还是变差」; 数据飞轮回答「答不上来的问题怎么变成知识库」。本文按这三层展开。

## langfuse

tracing 是可选的: `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` / `LANGFUSE_BASE_URL` 三个都配置才启用 (`langfuseEnabled()`, `server/src/core/observability.ts`)。启用后 `startServer()` 里的 `initObservability()` 启动 OpenTelemetry `NodeSDK`, 只挂一个 `LangfuseSpanProcessor` (来自 `@langfuse/otel`, 传入三个 key), 进程退出时 `shutdownObservability()` 冲刷缓冲。

本地部署由 `deploy/langfuse/docker-compose.yml` 提供, `node main.js langfuse-up` / `langfuse-down` 启停 (compose project 名 `yukino-langfuse`, 等待 `http://localhost:3000/api/public/health` 健康, 最长 4 分钟)。栈包含 `langfuse-web` (:3000)、`langfuse-worker` (:3030)、clickhouse、minio、redis、postgres 六个服务; 组织和项目通过 `LANGFUSE_INIT_*` 环境变量 headless 预置, 账号 `admin@yukino.local` / `yukino123`, 密钥固定为 `pk-lf-yukino-ecomm-agent-local` / `sk-lf-yukino-ecomm-agent-local`, 启动成功后提示写入 `server/.env`。`langfuse-down` 只停容器, 数据卷保留。

数据进 langfuse 有两条并行链路:

1. LangChain 回调链路: `graphCallbacks()` 返回注入图运行的 `CallbackHandler` (来自 `@langfuse/langchain`), langgraph 逐节点执行时对每个节点的输入/输出发射信号, langfuse 接收后组装出 trace 树, 包括每个节点的 prompt 输入、输出、耗时和 token 消耗。
2. OTel 手写链路: `recordTurn()` 把每轮对话记成一个名为 `chat-turn` 的 generation (输入、输出、`model=settings.chatModel`、`usageDetails.total` 为本轮累计 token), 并把意图写入 metadata 和 `intent:xxx` 标签; `tagIntent()` 把意图分类结果和置信度记成一个名为 `intent-tagged` 的 event。

```ts
// server/src/core/observability.ts
export function graphCallbacks(
  sessionId: number,
  userId?: string,
): CallbackHandler[] {
  if (!langfuseEnabled()) {
    return [];
  }
  return [
    new CallbackHandler({
      sessionId: String(sessionId),
      ...(userId ? { userId } : {}),
      tags: ["chat-turn"],
    }),
  ];
}

// server/src/graph/runtime.ts
function graphConfig(conversationId: number, userId: string) {
  return {
    configurable: { thread_id: String(conversationId) },
    metadata: { langfuse_session_id: String(conversationId) },
    callbacks: graphCallbacks(conversationId, userId),
  };
}
```

`sessionId` 就是会话 ID (conversation id), 在 langfuse 里按 session 过滤即可看到一个用户会话的全部轮次。`recordTurn` 在每轮结束后由 runtime 调用: 非流式的 `runTurn` 用 `invoke` 的返回值记录, 流式的 `streamTurn` / `streamResume` 在流结束后从 checkpointer 读最终状态记录, 两条路径都不遗漏; `tagIntent` 则由图里的 `classify_intent` 节点在分类完成时调用。

## 防劣化: 评测流水线

trace 能看到某一条请求, 但更新知识库/prompt、更换某个节点的模型, 都可能降低某一类问题的准确率, 单条 trace 看不出来。防劣化靠一组离线评测脚本, 全部能用 `node main.js <command>` 跑 (`server/main.js` 的命令表), 也能在管理页按「Re-run」触发。

前端和后端共用一个 job runner (`server/src/core/jobs.ts`): `JOBS` 注册表把 job 名映射到固定的 argv (13 个: `kb-preview`、`kb-build`、`kb-mine`、`kb-vectorize`、`kb-repatch`、`kb-reset`、`milvus-up`、`milvus-down`、`seed-conv`、`eval-rag`、`eval-flywheel`、`calibrate-confidence`、`cost-report`); `POST /api/jobs/:name` 先查注册表, 未注册的名字直接 404, 永远不会执行任意 shell 片段。每个 job 以 detached 子进程启动, stdout/stderr 写入 `log/acceptance/<name>.log`; 同名 job 同时只能跑一个 (重复启动返回 409); `stop` 对进程组发 SIGTERM, 10 秒后升级为 SIGKILL; 状态机为 `idle / running / ok / failed / stopped`。

### eval-rag: RAG 四策略对比

`scripts/eval-rag.ts`, 数据集是 `tests/data/eval_rag.jsonl`, 问题桶为 A_policy 政策、B_model 型号、C_colloquial 口语、E_multi 跨文档 (参与评分), 外加 D_absent 库外问题 (只测拒答)。支持 `--skip-gen` 只跑确定性阶段。三个阶段:

1. 检索: 4 种策略 (vector / bm25 / hybrid / hybrid_rerank) × 4 类问题桶, 每策略取 top-10, 按期望 section 在命中列表中的排名算 Recall@5 和 MRR, 分桶加 overall。检索并发 5, 单次调用 45 秒超时, 失败重试一次。
2. 证据覆盖率: 确定性机械匹配 —— 标准答案的关键点在 top-10 证据文本中出现的比例 (归一化空白后子串匹配), 不经过 LLM, 结果可复现。
3. 生成: 把各策略检出的证据喂给同一个生成 prompt (`RAG_ANSWER_PROMPT`) 产出答案。答案覆盖率由 LLM 评审数关键点; 忠实度 (faithfulness) 只对生产策略 `hybrid_rerank` 评, 用 `FAITHFULNESS_PROMPT` + `temperature: 0` 的结构化评审; D_absent 样本走生产的 `query_faq` 管线, `sufficient=false` 记为正确拒答, 得到库外拒答率。另有型号机械闸门 (`core/model-guard.ts`): 答案里出现证据中不存在的型号串会被检出并带修复提示重试一次, 统计命中数和救回数。如果生成阶段的所有调用全部失败, 脚本抛错拒绝记录零分, 避免把上游故障写进报告。

报告写 `data/rag/reports/rag_eval.json` 和 `.txt` (meta 含样本数、知识库 chunk 数、`recall_k=5`、`retrieve_k=10`、生成模型、时间)。/rag-eval 页面只读这两个产物, 不重算; 最佳策略按 overall MRR 选出。

### eval-flywheel: 趋势记录

`scripts/eval-flywheel.ts`, 固定的生产管线跑一轮 (hybrid_rerank 检索 → 生成 → 忠实度评审 → D_absent 拒答), 把 `recall_at_5` / `mrr` / `faithfulness` / `refusal_rate` 四个指标连同一轮的 `triggeredBy`、`datasetSize` 写进 `eval_run` 表。CLI 默认附加 `--triggered-by manual`。跑完打印最近 10 轮趋势表, 相邻轮差值超过 0.005 标 ↑ 或 ⚠↓, 并列出回归指标; 趋势文本写 `data/observability/reports/eval_trend.txt`。它存在的目的就是验证飞轮把人工答案写回知识库之后, 质量有没有被拖下水。

### calibrate-confidence: 阈值扫描

`scripts/calibrate-confidence.ts`: 对评测集全量样本跑 hybrid_rerank 检索并算证据置信度, 先给可答样本和库外样本各出一份分位数分布 (n / min / p25 / median / p75 / max); 然后在 0.05 到 0.95 以 0.01 步长扫描候选阈值, 每个阈值记录库内可答问题的通过率 (`conf >= t` 的比例) 和库外应拒问题的漏放率, 以 Youden J (通过率 − 漏放率) 最大的点作为推荐阈值。报告写 `data/observability/reports/confidence_calibration.json` / `.txt`。

运行时实际生效的阈值是 `EVIDENCE_CONFIDENCE_THRESHOLD` (默认 0.26), /observability 页面会把 in-use 和推荐值对比, 给出 match / conservative / aggressive 三种结论; 扫描细节和置信度公式的权重 (`W_TOP1=0.5`、`W_VALID=0.2`、`W_MARGIN=0.2`、`W_KEY=0.1`) 也一并展示。阈值卡得过严时, 被误拦的可答问题会落进问题池, 成为数据飞轮的燃料。

### cost-report: 按意图分类的 token 账单

`scripts/cost-report.ts`, `--days` 默认 7, 需要 langfuse 已配置且窗口内有 trace。脚本调 langfuse 的 `GET /api/public/metrics` (Basic auth, view=observations, 度量 `sum(totalTokens)`, 维度 `tags` + `traceId`), 从 `intent:xxx` 标签聚合出每个意图的请求数、总 token、平均 token 和占比, 按总 token 降序, 头号消费者标 ← top spender; 报告写 `data/observability/reports/cost_by_intent.json` / `.txt`。

这张账单指导模型选型: 平均 token 高说明一个问题触发多次模型调用 (多步工具链), 和请求数无关; 读者据此决定先给哪个意图瘦身 prompt, 或把哪类调用换到更小的模型。代码层面, `core/llm.ts` 的 `resolveSlot` 支持按 slot 独立配置模型 —— `chat` / `intent` / `summary` 各有自己的 `*_MODEL` / `*_BASE_URL` / `*_API_KEY` (`INTENT_MODEL` 等), 未配置的 slot 回落到 chat, 所以「给某个环节换小模型」不需要改代码, 改环境变量即可。

### 阅读笔记

管理页的每张图配一条「阅读笔记」(`server/src/core/read-notes.ts`): LLM 基于该图的真实数据 payload 写一条不超过 130 字符的口语化短句。规则包括: 只引用 payload 里出现过的数字, 不计算、不估计、不编造; 不复述所有指标, 挑一两个讲故事的; 结尾落在「所以该看什么 / 该做什么」。生成后有硬性校验: `verify()` 用正则抽出笔记里的每个数字, 逐个对照 payload 里所有数字的规范化形式 (含百分比换算、补数形式), 任何一个对不上就整条丢弃; 超过 130 字符同样丢弃; 生成超时 120 秒。校验失败或生成失败时返回 null, 页面退回默认兜底句。目前有 7 种笔记: `rag_mrr`、`rag_recall`、`rag_coverage`、`rag_answer_coverage`、`cost_by_intent`、`eval_trend`、`confidence_calibration`。

### 幻觉案例台账

忠实度评审判为不忠实的案例进入 `faith_case` 表 (`upsertFaithCase`): 以评测样本 id (`evalId`) 为唯一键, 记录问题桶、query、策略、答案、评审理由、引用证据、评审模型。状态三态 `unresolved` / `resolved` / `dismissed`; 同一样本再次出现时不新增行, 而是 `seenCount` 累加并更新 `lastSeenAt`, 已经处理过又复发的案例在页面上标 reopened。

/api/rag-eval/faith-cases 提供分页列表 (每页最多 50 条) 和按状态过滤; 标记 resolved 必须写明怎么解决的, 标记 dismissed 必须写明为什么不需要改 (resolution 最长 300 字符), 也可以退回 unresolved 重新打开。页面顶部的幻觉汇总把本轮报告的判罚数、台账各状态计数、漏拒数放在一起, 形成「评审 → 处理 → 复评」的小闭环。

## bad case 处理: 数据飞轮

对于 agent 无法回答、回答错误的问题, 把它们记录下来, 判断是否需要更新知识库/prompt; 这个从用户交互收集问题、再反哺系统的闭环就是数据飞轮。

### 数据飞轮的入口

三个入口最终都写 `low_confidence_question` 表 (原始问题、source、reason、检索快照、会话 ID):

1. 检索置信度 (source=`retrieval_low_conf`)。意图路由到 knowledge 分支后, `retrieve_knowledge` 节点检索知识库并计算证据置信度 (`server/src/core/confidence.ts`):

   ```text
   score = 0.5 * top1 精排分
         + 0.2 * 有效条数 / 3
         + 0.2 * (top1 - top2 分差)
         + 0.1 * 关键条款命中
   ```

   有效条数 = 精排分不低于 0.3 (`VALID_SCORE_FLOOR`) 的候选数量, 最多计 3 条; 分差只有 1 条结果时取 top1 本身; 关键条款命中 = 前 3 条结果的问答文本里是否出现 `KEY_TERMS` 中的词 (refund / return / timeframe / time limit / shipping fee / postage / fee / warranty / compensation / period / free shipping)。各分量 clip 到 [0, 1] 后加权, `score` 低于 `EVIDENCE_CONFIDENCE_THRESHOLD` (默认 0.26) 判为证据不足。

2. 置信度闸 + LLM 自检 (source=`self_check`)。置信度过线后还有一道自检 (`SELF_CHECK_PROMPT`, `core/selfcheck.ts`): 结构化地问「证据是否足以准确回答该问题」, 输出 `useful` + `reason`; 自检调用本身失败时按不足处理。不够则走兜底。

3. 用户点踩 (source=`user_feedback`)。对 agent 生成的消息点踩时, `POST /api/feedback` (`rating=down`) 把问题写入飞轮; 点赞只记日志。写入前会尝试从 checkpointer 状态取本轮检索快照 (`getTurnSnapshot`): 仅当快照非空且点踩的问题与本轮最后一条用户消息一致 (忽略空白比较) 时才附带; 取快照失败不阻塞入池。

前两个入口在图内汇合: `confidence_check` 闸门判 weak 后进入 `fallback_reply` 节点, 回复固定兜底话术 (`FALLBACK_REPLY_TEXT`) 并给出转人工选项, 同时写表。reason 字段带上 `evidence_confidence` 数值、置信度信号 JSON, self_check 来源还追加自检理由。

检索快照是三态语义: 非空 = 检索过且有命中; `[]` = 检索过但零命中 (这是「知识真缺失」的强信号, /review 页面会如实展示); `null` = 没走检索。它帮审核人区分「知识库没有」和「有但没召回」。

另外, 工具链路上的 `query_faq` 内置工具 (`server/src/tools/builtin/faq.ts`) 也复用同一套门禁: top 精排分低于 `RERANK_MIN_SCORE` (默认 0.3) 返回 `retrieval_low_conf`, 否则过自检, 不足时返回 `sufficient=false` 让模型按拒答规则处理 —— 但它只影响当轮回复, 不写问题池; 问题池的写入只发生在上面三个入口。

### 数据飞轮的处理

`flywheel.processPending` (`server/src/core/flywheel.ts`) 负责把池子里的问题变成待审条目, 由离线脚本 `node main.js flywheel` 触发 (`processPending(200)`); 这一步不在 job runner 注册表里, 只能命令行跑。每轮取最多 200 条未匹配 (`matchedReviewId` 为空) 的问题, 逐条:

1. 问题标准化 + 去重 + 参考答案, 一次 LLM 结构化调用同时产出三个字段 (`FLYWHEEL_NORMALIZE_PROMPT`):
   - `normalized_question`: 剥离情绪、口语和无关细节, 保留核心诉求, 改写成 FAQ 标准问法。例如「上周买的鞋跑两次就开胶了, 太坑了, 能退吗」→「有质量问题 (例如开胶) 的商品能否退货」。
   - `matched_question_id`: 与最多 200 条候选 (`listReviewCandidates` 按更新时间取 201 条截断到 200, 超量记 truncated) 逐一比对, 同类则填候选 id。LLM 编造候选列表里没有的 id 时, 本轮跳过该条, 下一轮重试。
   - `ai_suggested_answer`: 客服口吻的参考答案, 不编造政策数字, 拿不准的写「以平台售后规则为准」。

   ```json
   {
     "normalized_question": "有质量问题 (例如黑屏) 的商品能否退货",
     "matched_question_id": 228,
     "ai_suggested_answer": "..."
   }
   ```

2. 写库在单个事务里完成 (`matchLowConfidence`): 命中候选则认领该条原始问题并把候选的 `occurrenceCount` 加 1 —— 计数越多说明该缺口被问得越多, 优先级越高; 没有同类则新建 `ReviewQueue` 条目 (初始状态 `pending_review`) 再认领。认领用「`matchedReviewId` 为空才更新」防并发重复处理。

### 审核与写回 (/review)

/api/review/queue 按 `pending_review` / `approved` / `rejected` 列出条目, 详情接口带出合并进来的全部原始问题 (来源、reason、检索快照)。/review 页面给出三道前置闸门:

1. 垃圾过滤: 乱码、随手测试输入、不当内容, 直接拒绝;
2. 时效性: 强时效问题 (促销截止时间之类) 一进知识库就过期, 不留存, 拒绝;
3. 频率: 冷门长尾问题不值得知识库空间和人工, 拒绝。页面把 `occurrence_count` 大于等于 3 的条目高亮, 提示优先补。

通过时必须填写 `approved_answer` (接口 schema 要求非空, 弹窗预填 AI 参考答案)。通过的答案经 `approvedReviewChunk` 打包成 `flywheel_review` 类型的 chunk (`contentType=faq`, `sectionPath=flywheel_review / 问题`, 按 `KEY_TERMS` 标关键条款), 双写知识库表并立即向量化 (`dualwrite.writePending` + `vectorizePending`); 任一步失败时回滚已写入的 chunk, 审核状态保持 `pending_review` 不变, 返回 502 可重试; 写回成功后状态才置为 `approved` (并发修改返回 409)。拒绝则置为 `rejected`。写回后的下一轮对话即可召回这条新知识 —— 这也是 eval-flywheel 趋势要盯住的东西。

### 知识挖掘 (飞轮素材的另一个来源)

`kb-mine` (`node main.js kb-mine`, `server/src/kb/mining.ts`): 把全部历史会话按每批 20 条交给 LLM (`MINING_PROMPT`), 提取有复用价值的问答对 (跳过闲聊和纯个案), 写入 `qa_extraction_staging` 暂存表 (batchNo 形如 `mine-20261027120000`, 初始状态 `extracted`)。随后与知识库已有问题做标准化去重: `normalizeQuestion` 小写化并去掉所有非字母数字字符, 指纹相同判为重复, 标记 `discarded`, 其余标 `kept`。

`kept` 的条目进入 /kb 页面暂存区人工审核 (页面按 extracted / kept / discarded / approved / rejected 五种状态分组展示); 批准后经 `approvedStagingChunk` 打包成 `conversation_history` 类型的 chunk (`sectionPath=mined`, `contentType=mined`), 走与审核写回相同的双写 + 立即向量化 + 失败回滚流程。
