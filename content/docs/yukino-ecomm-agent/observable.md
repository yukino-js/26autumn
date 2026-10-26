---
title: "可观测性和数据飞轮"
---

一个请求对应一个 trace 树; 例如 LLM API、文档检索、工具调用等, 都是 trace 树的 span 节点。

## langfuse

本项目的 tracing 是可选的: LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY / LANGFUSE_BASE_URL 三个都配置才启用; 本地部署由 `deploy/langfuse/docker-compose.yml` 提供 (`node server/main.js langfuse-up / langfuse-down`)。

两条链路并行 (`server/src/core/observability.ts`):

1. OTel 链路: NodeSDK + LangfuseSpanProcessor; `recordTurn` 把每轮对话记成一个 chat-turn generation (输入/输出/模型/token 用量), `tagIntent` 把意图和置信度记成事件
2. LangChain 链路: CallbackHandler 注入图运行, langgraph 跑图时对每个节点的输入/输出发射信号, langfuse 接收这些信号, 得到 trace 树, 包括每个节点的 prompt 输入、output 输出、时间消耗和 token 消耗

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

sessionId 就是会话 ID, 在 langfuse 里可以按会话过滤出一个用户的全部轮次。

## 防劣化

trace 可以看到某一条请求, 但是更新知识库/prompt、更换某个节点的模型, 都可能降低某类问题的准确率; 通过「自动化评测流水线」防劣化。离线脚本都能用 `node server/main.js <command>` 跑, 也能在管理页按「Re-run」触发 —— 前端和 CLI 共用一个 job runner, 前端只能提交注册过的 job 名, 永远不会执行任意 shell 片段:

- eval-rag: RAG 四策略对比 —— 4 种检索策略 (vector / bm25 / hybrid / hybrid_rerank) × 4 类问题桶 (A_policy 政策 / B_model 型号 / C_colloquial 口语 / E_multi 跨文档), 输出 Recall@5、MRR、证据覆盖率 (机械匹配, 确定性)、端到端答案覆盖率、忠实度 (LLM 评审)、库外问题拒答率; 报告写 data/rag/reports/rag_eval.json
- eval-flywheel: 评测流水线, 每跑一次记录一轮趋势 (recall_at_5 / recall_at_10 / mrr / faithfulness / refusal_rate 写 eval_run 表), 用来验证飞轮写回知识库有没有把质量拖下水
- calibrate-confidence: 置信度阈值扫描 —— 每个候选阈值下, 库内可答问题的通过率和库外应拒问题的漏放率, 选出阈值线 (当前默认 EVIDENCE_CONFIDENCE_THRESHOLD=0.26); 被误拦的可答问题回落到问题池, 成为数据飞轮的燃料
- cost-report: 按意图分类统计的 token 账单 —— 从 langfuse 拉 trace, 按意图统计请求数、总 token、平均 token 和占比, 报告写 data/observability/reports/cost_by_intent.json

按意图分类统计的 token 账单指导模型选型:

- 订单、物流等高频低难度意图: 使用 flash 模型
- 商品咨询、退换货、退款、售后等高难度意图: 使用 pro 模型

管理页的每张图还配一条「阅读笔记」(`server/src/core/read-notes.ts`): LLM 基于真实数据写一条 ≤130 字符的口语化笔记, 只引用数据里出现过的数字, 不复述所有指标, 结尾落在「所以该看什么 / 该做什么」。

### 幻觉案例台账

评审发现的不忠实案例进入 faith_case 表 (问题桶、query、策略、答案、评审理由、引用、评审模型), 状态 unresolved / resolved / dismissed; 同一问题再次出现时 seenCount 累加而不是新增一行。/rag-eval 页面逐条处理, 形成「评审 -> 处理 -> 复评」的小闭环。

## bad case 处理: 数据飞轮

对于 agent 无法回答、回答错误的问题, 记录这些问题, 判断是否需要更新知识库/prompt; 这个从用户交互收集问题, 优化系统的闭环就是数据飞轮。

### 数据飞轮的入口

1. 检索置信度 (source=retrieval_low_conf): 知识检索后计算证据置信度 (`server/src/core/confidence.ts`)

   ```
   score = 0.5 * top1 精排分 + 0.2 * 有效条数/3 + 0.2 * (top1 - top2 分差) + 0.1 * 关键条款命中
   ```

   有效条数 = 精排分 >= 0.3 的候选数量 (最多计 3 条); 关键条款命中 = 前 3 条结果里是否出现 refund / return / timeframe / shipping fee / warranty / compensation 等关键词。score < 0.26 判为证据不足

2. 置信度闸 + 自检 (source=self_check): 置信度过线后还有一道 LLM 自检 (SELF_CHECK_PROMPT), 问「证据是否足以回答该问题」; 不够则回复兜底话术, 同时记录该问题, 推入数据飞轮
3. 用户对 Agent 生成的消息点踩 (source=user_feedback): /api/feedback 的 down 把问题写入飞轮, 能取到本轮检索快照时一并附上

三个入口都经过 fallback_reply 节点 (兜底话术 + 转人工选项), 写 low_confidence_question 表; 检索快照是三态语义 (非空 = 检索过且有命中, [] = 检索过但零命中, null = 没走检索), 帮审核人判断是不是「知识真缺失」。

### 数据飞轮的处理

`flywheel.processPending` (`server/src/core/flywheel.ts`), 管理页或离线脚本 flywheel.ts 触发:

1. 问题标准化: 「iPhone17 使用一周就黑屏了, 好垃圾! 能退吗」-> 「有质量问题 (例如黑屏) 的商品能否退货」—— 剥离情绪、口语和无关细节, 保留核心诉求
2. 问题去重: 将最多 200 条待审候选问题连同原始问题输入给 LLM, LLM 判断当前问题是否与某条候选同类 (matched_question_id), 如果在则 occurrenceCount + 1, 计数越多问题优先级越高; LLM 编造候选列表里没有的 id 时本轮跳过, 下轮重试
3. 同时产出 ai_suggested_answer 作为审核参考答案 (客服口吻, 不编造政策数字)

```json
{
  "normalized_question": "有质量问题 (例如黑屏) 的商品能否退货",
  "matched_question_id": 228,
  "ai_suggested_answer": "..."
}
```

4. 审核的注意点 (/review 页面)
   - 过滤垃圾样本
   - 过滤强时效性、临期/过期的样本
   - 过滤计数极少的冷门样本
   - 通过时必须填写 approved_answer
5. 写回: 通过的答案作为 flywheel_review 类型的 chunk 写入知识库并立即向量化 (双写; 失败时回滚已写入的 chunk, 审核状态不变, 可重试); 拒绝的标记 rejected

### 知识挖掘 (飞轮素材的另一个来源)

kb-mine (`server/src/kb/mining.ts`): 历史会话分批交给 LLM 提取问答对, 写入 qa_extraction_staging 暂存表, 与知识库已有问题做标准化去重 (小写 + 去标点的指纹), 保留的进入 /kb 页面暂存区人工审核, 通过后作为 conversation_history 类型的 chunk 写入知识库并向量化。
