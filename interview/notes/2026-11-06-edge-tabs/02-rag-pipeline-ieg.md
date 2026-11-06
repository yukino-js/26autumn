# 02 · IEG 全栈开发(秋招) 二面+三面：RAG 全链路（★ 信息量最大）

| 项     | 值                                                                                                                    |
| ------ | --------------------------------------------------------------------------------------------------------------------- |
| 来源   | `1266366764` [腾讯IEG 全栈开发(秋招) 二面+三面](https://www.nowcoder.com/discuss/927508453784850432?sourceSSR=search) |
| 形态   | **10 题带完整答案**（含 Python/伪代码片段），是本轮所有标签里最系统的一份 RAG/Agent 设计答案                          |
| 完整性 | 订阅墙在正文约 4739 字符处，**Q10 Harness 的代码断在 `tools=self.to`**，之后不可见，不补写                            |

:::warning 证据等级
这是**面经作者的方案**，不是本仓库项目做法。文中「权限过滤前置」「中间结果不入库」「证据冲突按权威等级裁决」等是通用最佳实践，答题时若要说「我们项目这么做」，须以 `content/` 源码事实为准。
:::

## Q2–Q3 · 实时转写如何进入知识库

**流式识别，不等整段音频结束**。链路：

```text
客户端 WebSocket / WebRTC 发送音频
  → 音频网关鉴权 + 分片
  → ASR 服务返回「中间结果」与「最终结果」
  → 服务端按说话人 / 时间戳 / 会议段落重组文本
  → 清洗、脱敏、结构化
  → 语义切分 Chunk → Embedding → 向量库
  → 保存原文、摘要、元数据
```

**最关键的一条**：`handle_transcript(segment)` 里只有 `segment.is_final` 才 publish `index_meeting_segment` 事件；**中间识别结果绝不直接入库**（否则同一段内容重复写入），只用于实时展示。转写记录带 `meeting_id / speaker / start_ms / end_ms / text`。

> 与 11-05 第四轮 [互娱二面](../2026-11-05-active-tabs-04.md) 的事件溯源（`segment_id + revision`、ASR 修正不覆盖审计）是同一条项目主线的**两种视角**：那边讲「前端如何收敛视图」，这边讲「后端何时落库」。合起来答才完整。

## Q4 · 一套完整 RAG 链路

| 阶段 | 步骤                                                                                                         |
| ---- | ------------------------------------------------------------------------------------------------------------ |
| 离线 | 文件解析 → 清洗 → 结构化抽取 → 分块 → Embedding → 向量索引                                                   |
| 在线 | 意图识别 → Query 改写 → 关键词检索 + 向量检索 → **权限过滤** → Rerank → 上下文压缩 → 模型生成 → **引用校验** |

**权限过滤必须尽量前置**：不能先把所有租户内容召回、再靠模型判断哪些能用（既泄漏又费 token）。生成后要有引用校验闭环。

> 项目互证：`content/docs/yukino-ecomm-agent/rag.md` 的在线管线是 `understand() 改写 → hybrid_rerank → 置信度闸 + selfcheck → 编号证据进 turn-ctx → chat 模型生成`；`category` 过滤在 `query_faq` 里落地。**项目没有显式的租户权限过滤前置**（演示项目无鉴权，见 `yukino-dev-agent.md` 的「无鉴权、CORS 全开」边界），面试别硬说有。

## Q5 · 检索结果怎样传给 Agent

**不要拼成无结构文本**，用带元数据的结构：

```json
{
  "question": "系统为什么会出现重复任务？",
  "evidence": [
    {
      "id": "doc-102#chunk-8",
      "content": "任务通过幂等键避免重复创建……",
      "source": "任务系统设计文档",
      "score": 0.91,
      "tenant_id": "tenant-a"
    }
  ],
  "constraints": ["只能依据 evidence 回答", "无法确认时必须明确说明"]
}
```

- Agent 可据此**决定是否继续检索**（对应 [第一轮摘录 Q8](../2026-11-05-active-tabs.md) 的 `retrieval_utility` 停止条件）。
- **证据相互矛盾时启动冲突处理**：按文档版本、更新时间、**权威等级**排序，而不是让模型随意选。
- 最终输出带**证据 ID**，方便引用检查与追溯（对应 `content/docs/yukino-ecomm-agent/prompts.ts` 的 `[1][2]` 编号规则与 `model-guard` 机械闸门）。

## Q6 · Chunk 切分

**结构优先，长度兜底**：先按标题 / 章节 / 段落 / 表格 / 代码块切，再按长度二次处理。要考虑：

| 风险        | 说明                                                 |
| ----------- | ---------------------------------------------------- |
| 太短        | 语义不完整                                           |
| 太长        | 检索粒度不够                                         |
| 固定重叠    | 造成大量重复内容                                     |
| 表格 / 代码 | 不适合按普通文本切；代码应优先按**函数 / 类 / 模块** |
| 章节标题    | 应保留在 chunk 的**元数据或前缀**里                  |
| 会议内容    | 结合**说话人 + 时间间隔**切分                        |

示例参数 `split_document(blocks, max_tokens=500, overlap_tokens=80)`：按 block 累积到 token 上限、超出时把上一块尾部按 token 回卷作为重叠。

> 与 [R08 Q2/Q3](../../rounds/round-08.md) 对照：项目 `yukino-ecomm-agent` 用 `splitSections`(h1–h4) + `buildChunks(chunkSize=400, overlap=60)` + 表格每组复制表头 + 句子级 overlap；**思路一致**（结构优先 + 句子级回卷），只是参数与文档形态不同。项目参数无消融实验，这点已如实记录。

## Q7 · 三种检索各适合什么场景

| 方式                   | 适合                                                          | 不适合                                                   |
| ---------------------- | ------------------------------------------------------------- | -------------------------------------------------------- |
| 向量检索               | 语义相近但关键词不一致（「任务重复执行的原因」↔「幂等问题」） | 专有名词、错误码、订单号、类名、接口名等**精确字面匹配** |
| 关键词检索 (BM25)      | 上述精确匹配、SKU/型号                                        | 口语化同义表述                                           |
| Rerank (cross-encoder) | 对初召候选做精细相关性判断；**只处理 Top 20 / Top 50**        | 全量候选（成本与延迟高）                                 |

示例管线：`BM25 Top30 + Vector Top30 → 去重 + 权限过滤 → Rerank Top50 → 保留 Top5~10`。

> 项目事实：`rag.md` 的默认 `hybrid_rerank` 是**双路各召回 50 → RRF(k=60) 粗排 → rerank 精排取 10**；`RECALL_TOP_K=50` / `RERANK_TOP_K=10` / `RERANK_MIN_SCORE=0.3`。**项目用 RRF 按排名融合，不是简单拼接**，这是可直接引用的实现细节。

## Q8 · 上下文窗口爆炸

建立**多级上下文**，而不是只依赖模型窗口：① 当前问题 + 最近几轮 ② 当前任务的结构化状态 ③ 历史消息摘要 ④ 相关长期记忆 ⑤ 本轮检索证据 ⑥ 工具执行结果。

- 长文本用**摘要 / 压缩 / 去重 / 重要性排序**；工具结果不要无限制塞回完整响应，优先返回**摘要 + 资源引用**。
- `build_context(history, summary, memories, evidences, budget)` 按 section 顺序累加，超预算就停止装入。
- **压缩必须保留**：任务约束、用户明确要求、未完成步骤、关键工具结果；不能只留最近消息。

> 项目互证：`content/docs/yukino-ecomm-agent/context.md` 的 `fixed / peak / sliding` 预算分账（证据按 `160 × 10` 计入 fixed）、`content/docs/yukino/context-compaction.md` 的两层压缩（工具结果溢出磁盘 + Auto-Compact 摘要 + 近期逐字保留 + 恢复附件），以及 `SUMMARY_INSTRUCTIONS` 六段结构。项目还额外要求「本批未提到的事实不得写入摘要」，防漂移。

## Q9 · Agent 记忆系统

| 层       | 内容                                          |
| -------- | --------------------------------------------- |
| 短期记忆 | 当前会话 / 任务：最近对话、工具结果、执行状态 |
| 长期记忆 | 稳定事实：用户偏好、组织规则、已确认业务知识  |

- **写入前筛选**：不能把模型猜测当事实保存。
- 每条记忆带 `memory_id / subject / fact / source / confidence / expires_at`（示例 `confidence: 0.96`）。
- 读取时做**权限过滤 + 相关性排序**，避免过期或不属于当前任务的内容进入上下文。

> 项目互证：[R06](../../rounds/round-06.md) 已核对 `content/docs/yukino/agents-md-and-memory.md` 的三层记忆：工作记忆（上下文窗口）、长期记忆（AGENTS.md + JSONL 会话 + 文件快照）、自动记忆（带 frontmatter 的 md + `MEMORY.md` 索引 + 每轮并行 recall ≤5 条 + 后台提取 + 24h 整合）。**面经的 `source/confidence/expires_at` 字段在 Yukino 里没有**，但「记忆是证据不是授权」「新鲜度警告」是同一思路。

## Q10 · Harness（订阅墙截断）

Harness = **包裹模型的运行控制层**，不负责单纯生成文本，而负责让模型按可控流程工作。职责清单：

`构造 Prompt · 管理上下文 · 注册工具 · 校验工具参数 · 执行工具调用 · 维护任务状态 · 处理重试与超时 · 控制 Token 与费用 · 记录 Trace · 判断是否结束`

示例骨架 `AgentHarness(model, tools, store).run(task)`：`state = store.load(task.id)` → 循环 `max_steps` 次 `model.invoke(messages=state.messages, tools=...)`。⚠️ 代码断在 `tools=self.to`，后续不可见。

> 项目互证：`content/docs/yukino-ecomm-agent/llm.md` 的执行引擎（Ajv 参数校验、写权限闸、系统注入、超时/重试/结果截断、审计）、`content/docs/yukino/react-and-agent-loop.md` 的 `Agent.run()` AsyncGenerator、`content/docs/yukino/telemetry.md` 的 trace——**这些正是 Harness 职责的逐项落地**，可以直接拿项目源码回答这题。

## 与已有练习的映射

| 本页题                   | 对应                                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------- |
| Q3 实时转写落库          | [11-05 第四轮 · 互娱二面 Q2/Q3](../2026-11-05-active-tabs-04.md) 事件溯源                         |
| Q4 完整 RAG 链路         | [R05 Q1](../../rounds/round-05.md)、`rag.md`                                                      |
| Q5 证据结构化 / 冲突裁决 | [R05 Q9](../../rounds/round-05.md) 防幻觉、[第一轮摘录 Q7](../2026-11-05-active-tabs.md) 信息分层 |
| Q6 Chunk 切分            | [R08 Q2/Q3](../../rounds/round-08.md)、`rag.md`                                                   |
| Q7 混合检索与 rerank     | [R08 Q4](../../rounds/round-08.md)、[11-05 第四轮 Q5 RRF](../2026-11-05-active-tabs-04.md)        |
| Q8 上下文预算            | [R08 Q5](../../rounds/round-08.md)、`context.md`、[R06 Q2](../../rounds/round-06.md)              |
| Q9 Agent 记忆            | [R06](../../rounds/round-06.md) 全文                                                              |
| Q10 Harness              | `yukino-ecomm-agent/llm.md` 执行引擎、`yukino/react-and-agent-loop.md`                            |

## 速记卡

- **中间结果不入库**，只持久化 ASR 最终结果；中间结果仅实时展示。
- **权限过滤前置**，不能召回全租户再让模型挑。
- 检索结果传 **结构化 evidence + constraints**，输出带证据 ID；冲突按版本/时间/权威等级裁决。
- **结构优先切分**，长度兜底；表格/代码/会议各有切法。
- 向量管语义、BM25 管精确字面、rerank 只处理 Top20/50。
- 上下文压缩必须保住**约束、明确要求、未完成步骤、关键工具结果**。
- 长期记忆写入前筛选，带 source/confidence/失效策略；读取做权限与相关性过滤。
- Harness = Prompt + 上下文 + 工具 + 校验 + 状态 + 重试 + 成本 + Trace + 终止判断。
