---
title: "RAG"
---

RAG, Retrieval-Augmented Generation 检索增强生成

知识库: 文档库和历史聊天。历史聊天可以分批提供给 LLM, 提取为问答对 (挖掘管线见 [可观测性和数据飞轮](./observable) 的知识挖掘一节)

1. 离线建库: 对文档解析、切片、向量化、存储到向量库; 初始跑一次, 定期更新
2. 在线问答: 用户提问, 将问题转换为向量、到向量库查询, 将查到的内容提供给 LLM 生成回答

电商领域黑话词库: SKU、满减、运费险、花呗分期 —— 黑话要在知识库正文中出现过才可能被召回; 中文分词本项目用 bigram 兜底, 不依赖分词服务

## 文档切割

通用策略:

1. 按固定长度切割文档
2. 按语句边界切割文档, 加一段 overlap
3. 结构感知切割
   - 按 markdown 的标题层级切割: section_path="一级标题 > 二级标题"
   - 对于没有标题层级的长文本, 按相邻语句向量相似度找断点的语义切分
   - 每切割一个文本块后, 补充该文本块在全文中的位置和角色的上下文, 再携带上下文一起向量化, 可以提高非结构化上下文的召回率
   - 对于超长文档, 先按章节切割, 再按段落切割, 最后按语句切割
   - overlap 不是截取固定字数, 而是可以截取到最近的句号; 截取半个语句可能导致噪音
   - 按行切割表格时, 每个文本块都需要复制一份表头

本项目的实现 (`server/src/kb/chunking.ts` + `documents.ts`):

1. `splitSections` 用正则 `/^(#{1,4})(?:\s+(.*))?$/` 按 h1-h4 标题把 markdown 切成小节, 维护标题栈 (进入更浅的标题时弹掉更深层级) 产出标题路径; 代码围栏 (三个反引号或 `~~~`) 整体扫描, 围栏内的 `#` 行不会被误判为标题
2. 每个小节的正文由 `buildChunks(md, contentType, chunkSize=400, overlap=60, tableMaxRows=10)` 处理:
   - 表格块 (`|` 表头行 + `|---|` 分隔线, `isTableBlock` 识别) 用 `splitTableRows` 按行切割, 每块都复制表头和分隔线, 每块最多 10 行数据; 数据行数不超上限时整块保留, 表格前的引导文字只跟随第一块
   - 非表格文本用 `recursiveSplit` (`@langchain/textsplitters` 的 RecursiveCharacterTextSplitter, chunkSize=400, chunkOverlap=0, keepSeparator, 分隔符依次为: 空行、换行、中文句号/叹号/问号/分号、英文叹号/问号/分号、中文逗号、空格、字符)
   - 再用 `applySentenceOverlap` 加 overlap (默认 60 字符): 从前一块末尾按完整句子截取 (句读边界为 `.。！？!?…` 和换行), 拼到后一块的开头, 不截半个句子; 单句超出预算时也至少带一句
3. 每块结构化为 chunk: `sectionPath` 取标题路径 ("一级标题 / 二级标题 / 三级标题"); `questions` 取最后一级标题 (无标题时取 contentType); `category` 取标题路径去掉最后一级 (只剩一级时取该级, 无标题时取 contentType); `answer` 取正文片段
4. `isKey` 标记关键条款: 标题拼接正文前 40 字符后小写化, 命中 refund / return / timeframe / time limit / shipping fee / postage / fee / warranty / compensation / period / free shipping 之一则 `isKeyClause=1`; 该标记参与置信度计算的关键条款信号

知识库材料是 `server/data/kb/` 下的 6 份 markdown, `sources.ts` 的 `SOURCE_TYPES` 把每份文件映射到一个 contentType: product-faq → faq, returns-policy → policy, after-sales-manual → manual, product-specs → spec, member-benefits → policy, billing-shipping → policy; contentType 全集是 faq / policy / manual / spec (`CONTENT_TYPES`)。

一个文本块是一个结构化的 JSON:

```json
{
  // 被向量化的是 category, questions, answer 拼接得到的文本
  "category": "分类, 会被向量化",
  "questions": "问题, 会被向量化",
  "answer": "答案, 会被向量化",
  // 元数据
  "sectionPath": "标题层级: 一级标题 / 二级标题 / 三级标题, 不被向量化",
  "contentType": "内容类型: faq / policy / manual / spec, 不被向量化",
  // 该 chunk 是不是售后、退换货、退款等关键条款, 不被向量化
  // 如果是关键条款, 则切割时必须保证完整性
  "isKeyClause": 0,
  // 相邻的 chunk ID (关系表字段), 不被向量化
  "prevChunkId": 1,
  "nextChunkId": 3
}
```

被向量化的文本是 `category\nquestions\nanswer` 三段拼接 —— 与写入 Milvus `text` 字段的是同一个字符串。`prevChunkId` / `nextChunkId` 由 `db/repository.ts` 的 `insertKnowledgeChunks` 在事务内回填, 把同一批写入的相邻 chunk 串成双向链表。

除文档 chunk 外还有两类写回 chunk (`documents.ts`): `approvedReviewChunk` (category=flywheel_review, contentType=faq, 人工审核通过的答案写回知识库) 和 `approvedStagingChunk` (category=conversation_history, contentType=mined, sectionPath=mined, 历史会话挖掘的暂存问答经审核后写回)。

## embedding 策略

将文本块转换为数组, 语义相邻的内容在数学空间中靠的更近 (余弦相似度)

不是 embedding 模型参数越大, 检索效果越好: 文档切割的质量、有没有做重排、有没有对特定领域做微调也影响检索的质量

有些 embedding 模型会加 query: 检索前缀和 document: 文档前缀, 进一步提升检索效果

本项目通过 EMBED_MODEL / EMBED_BASE_URL / EMBED_API_KEY 接 OpenAI 兼容的 embedding 端点 (默认模型 qwen3.7-text-embedding-flash, 默认端点 `https://maas.aliyuncs.com/compatible-mode/v1`), `core/embeddings.ts` 用 openai SDK 的 `embeddings.create` 调用, 不加检索/文档前缀。`vectorizePending` 外层按 64 条一批扫库, 每批 embedding 请求最多 20 条文本 (`MAX_EMBED_BATCH=20`)。

## 向量库

Milvus: 支持 dense 向量, 也支持 BM25 全文检索

- ANN: Approximate Nearest Neighbor, 近似最相邻搜索, 在 dense 向量上快速寻找语义相邻的候选内容
  - 常见的 ANN 实现: HNSW 和 IVF
    - HNSW 建立一张多层图, 越上层越稀疏, 底层包含全部向量; 查询时从顶层入口出发, 沿着邻居一直向下找到最相似的向量; 优点是查询快, 召回率高; 缺点是多层图占用内存、写入慢, 适合读多写少的场景
    - IVF 先将向量聚成一堆一堆的簇, 查询时只在最近的几个簇中精算, 跳过其他簇; 优点是节约内存、写入快, 适合大规模场景
    - 规模适中、追求低延迟选择 HNSW; 规模特别大、可以接受调参换召回率选择 IVF

### 向量库和关系型数据库

1. 原文作为向量的权威数据源, 必须在关系型数据库中保留一份副本
2. 后续调整切割策略、更换向量维度、微调, 都要求全量重新生成向量
3. 向量库擅长相似度搜索, 业务可能对原文进行关系型查询

本项目的关系型数据库是 PostgreSQL (Prisma), 原文存 knowledge_chunk 表, 完整表设计见 [LLM 接入、表设计与工具设计](./llm)。

### 原文和向量的搭配

1. 元数据、原文、和向量存储到 Milvus
2. 元数据、原文和向量存储到 Milvus, 既可以相似度搜索、召回; 又可以在正文上使用 BM25 全文检索; 关系型数据库存储原文, 作为权威数据源, conversation 会话、ticket 人工工单、flywheel 飞轮等需要 sql 事务的业务数据也存储到关系型数据库, 通过 vectorId 和 Milvus 中的记录对应

检索时, 直接到 Milvus 查询正文和元数据; 需要补全业务上下文时, 根据 vectorId 到关系型数据库查询

### 双写和状态位

先将切割得到的文本块存储到关系型数据库, vectorId 为空, 状态标记为「未向量化」(pending); 然后将该文本块输入到 embedding 模型得到向量, 将元数据、原文和向量作为一条记录存储到 Milvus, 最后将 ID 作为 vectorId 写回关系型数据库对应的记录, 状态标记为「已向量化」(done)

通过是否向量化的状态位, 可以扫描一遍关系型数据库, 拿到「未向量化」的记录, 只对未向量化的记录重新向量化, 不需要整库重新向量化

```text
切割得到的文本块存储到关系型数据库, 未向量化
-> 文本块输入到消息队列 (optional)
-> 消息队列转发文本块到 embedding 模型得到向量
-> 元数据、原文和向量存储到 Milvus 得到 vectorId
-> vectorId 写回关系型数据库对应的记录, 已向量化
```

(消息队列是大规模场景的可选设计, 本项目同步调用 embedding)

实现 (`server/src/kb/dualwrite.ts` + `db/repository.ts`):

1. `writePending` 把 chunk 写入 knowledge_chunk, `vectorizeStatus` 默认 pending, 事务内回填 prevChunkId / nextChunkId
2. `vectorizePending(batchSize=64)` 用 `listChunksForVectorization` 圈定待处理记录: `vectorizeStatus=pending`、`embeddingModel` 为空、或 `embeddingModel` 与当前 EMBED_MODEL 不一致都会入列 —— 换 embedding 模型后自动全量重嵌; 两种向量存储模式互切时 (Milvus 模式下 `embedding` 非空视为待迁移, 内置模式下 `embedding` 为空视为待嵌入) 也会入列
3. Milvus 模式: `milvus.upsert` 批量写入 (id 直接用关系表主键, 不依赖 Milvus 自增 ID), `flush` 后 `markChunkVectorizedExternal` 写回 `vectorId=String(id)` 并标记 done, 关系表的 embedding 字段保持为空; 内置模式: `markChunkVectorized` 把向量 JSON 直接存进关系表的 embedding 字段
4. `deleteChunks` / `rependChunks` 删除或变更 chunk 时同步删除 Milvus 中对应行; repend 会原地更新 questions / answer, 清空 embedding / vectorId, 状态重置回 pending, 配合 kb-vectorize 实现补丁式重嵌 (`scripts/kb-repatch.ts`: 按 (contentType, sectionPath) 分组对齐 md 与库内 chunk, 归一化比对正文, 变更的重置为 pending, md 新增的只报告不写入, 库内独有的行不动)

离线管线的入口是 `node main.js` 的子命令: kb-preview (干跑切割预览, 不写库)、kb-build (从 data/kb 建库, 与库内完全一致的 chunk 跳过, 部分命中时报错并提示改用 kb-repatch)、kb-vectorize、kb-repatch、kb-reset (清空知识表和向量库, 但把已审核通过的飞轮答案和暂存问答保留为 pending chunk)、kb-mine (历史会话挖掘问答对)。管理台的 /api/kb/* 端点 (overview 的双写计数校验、preview、ingest 单篇录入、search 调试) 见 [HTTP API 和管理台](./api)。

### 内置检索 (无 Milvus)

未配置 MILVUS_URI 时 (`milvusEnabled()` 为 false), dense 向量存在关系表的 embedding 字段, 检索在进程内完成 (`server/src/kb/store.ts`):

- dense: 全量余弦相似度打分; 向量缓存按知识库 revision (`knowledgeRevision` = 行数:最大 id:最大 updatedAt) 失效
- BM25: 进程内实现, K1=1.5、B=0.75, 打分是标准 BM25 形式 —— idf 取 `ln(1 + (N - df + 0.5) / (df + 0.5))`, 词频项带饱和和文档长度归一化, 只保留得分大于 0 的结果; 分词对英文/数字大小写不敏感 (连续字母数字段整体一个 token), 中文用 bigram (相邻两字一个 token, 单字保留), 不依赖分词服务
- hybrid: dense 和 BM25 各召回一批 (recall 默认 50), 进程内做 RRF 融合 (k=60, 每份文档每路贡献 `1 / (60 + rank + 1)`, rank 从 0 起)
- 四种检索策略 (vector / bm25 / hybrid / hybrid_rerank) 在没有向量数据库时照常工作

### Milvus 模式

配置 MILVUS_URI 后, Milvus 是权威向量库 (`server/src/kb/milvus.ts`, 官方 Node SDK @zilliz/milvus2-sdk-node 直连 gRPC :19530, 无桥接进程; 本机部署由 `node main.js milvus-up` 拉起 systemd 的 milvus.service 或 `deploy/milvus/docker-compose.yml`, 健康检查 `http://127.0.0.1:9091/healthz`)。所有请求 15s 超时, 任何一步返回错误码直接抛异常, 不静默降级回内置检索。

collection 名取 MILVUS_COLLECTION (默认 knowledge), 在第一次 upsert 时懒创建, 维度从首条向量推断 (模型无关, 不硬编码), Strong 一致性 (这样管理台的双写计数校验 `stats.done == milvus.count` 是确定性的), MILVUS_TOKEN 可选:

- id: Int64 主键, autoID=false, 直接用 knowledge_chunk 的主键
- dense: FloatVector, AUTOINDEX + COSINE
- text: VarChar(16384), 开启 analyzer (standard), 写入建库时的被向量化文本
- sparse: SparseFloatVector, is_function_output, 由绑定在 text 上的 BM25 Function (`text_bm25`, 输入 text 输出 sparse) 自动派生, SPARSE_INVERTED_INDEX + BM25
- question / answer / section_path / content_type / category: VarChar 标量字段 (max_length 依次 2048 / 8192 / 512 / 32 / 255)

Milvus 的 BM25 Function 自动给 text 字段生成稀疏向量, 应用侧不需要维护分词器。使用前 `describeCollection` 做 schema 校验: collection 必须同时含 text 和 sparse 字段, 否则拒绝服务并给出重建步骤 (kb-reset → kb-build → kb-vectorize)。

## 在线问答

用户的问题输入到 embedding 模型得到向量, 再到 Milvus 对问题向量做相似度搜索, 取 topK 排名前 k 个

缺陷: 用户有时可能给出商品 SKU (Stock Keeping Unit, 最小库存管理单元) 编号, 这时查询要求字面量精确匹配, 不适合相似度搜索

## 混合检索

```text
商品 (SPU)
├── SKU-iPhone16White128: iPhone16 / White / 128G
├── SKU-iPhone16White256: iPhone16 / White / 256G
├── SKU-iPhone17White256: iPhone17 / White / 256G
└── SKU-iPhone17White512: iPhone17 / White / 512G
```

商家提问: SKU-iPhone17White256 支持快充吗? 知识库中有一份 SKU-iPhone16White256 的参数表, 也有一份 SKU-iPhone17White256 的参数表, 相似度搜索很容易出错 (型号字面高度相似, 向量模型未必分得清); BM25 字面匹配才能精确命中。

## BM25 关键词检索

搜索引擎、ElasticSearch 等都使用了 BM25 关键词检索

查询的关键词在某份文档中命中数量越多、命中的关键词在某份文档中越稀有, 该文档的 BM25 打分越高

1. 词频饱和: 一份文档中反复出现「iPhone」10 次, 不代表该文档和用户问题的相关程度是只出现 1 次时的 10 倍; 某个词出现到一定次数时, 次数越多加分越缓慢
2. 文档长度归一化: 对于一份长的售后手册和一份短的 FAQ, 不能因为售后手册字数更多, 打分就越高

BM25 关键词检索的缺点: 依赖字面量精确匹配, 例如「退换货」和「退款」对于 BM25 关键词检索是没有相似度的两个词

## 召回 → 粗排 → 精排

**召回**

Milvus SDK 的 `hybrid_search` 在一次请求里同时发出两路召回: 稀疏路走倒排索引 + BM25 关键词检索, 稠密路走 ANN + 余弦相似度; 每路最多召回 50 条候选 (RECALL_TOP_K=50, limit 取 `max(topK, recall)`); 再将两批候选输入到 RRF 倒排融合 (k=60) 进行粗排, 得到倒排融合的候选池; 最后使用更慢、质量更高的 rerank 模型精排 (RERANK_TOP_K=10)

另一种实现是使用 ElasticSearch 进行 BM25 关键词检索, 依赖 ES 集群、Milvus 向量库和 ES 的数据一致性

召回前, 可以使用元数据筛选, 例如用户提问的商品有明确的 category 分类, 以缩小候选范围, 进一步提升召回精度和速度 (本项目 query_faq 支持 category 参数, 生成 `category == "..."` 的过滤表达式; 过滤后结果为空或 top1 精排分低于 RERANK_MIN_SCORE=0.3 时, 自动去掉过滤重试一次)

**粗排**

- 向量相似度搜索给出的是余弦相似度, 取值范围是 [-1, 1]
- BM25 关键词检索给出的得分可能是 [0, 10] 甚至 1x 分

一类方法是「分数级融合」例如都归一化到 [0, 1], 再按权重相加, 缺点是不够灵活, 需要按场景微调; 对于粗排 (分数级融合), 权重可以按 query 类型指定, 例如对于商品 SKU、优惠券码, 应该更偏向 BM25 关键词检索; 对于口语化的模糊问题, 应该更偏向向量相似度搜索

另一类方法是「RRF 倒排融合」, 不比较分数, 只比较排名: 一路召回中, 每份文档贡献 `1 / (k + 排名)` 分数; 两路召回贡献分数相加, k 通常取 60。本项目 Milvus 模式的 RRF 在服务端完成 (`RANKER_TYPE.RRF`, `k=60`), 内置模式在进程内用同样的参数融合

**精排**

精排使用更慢、质量更高的 cross-encoder 交叉编码 rerank 模型, 拼接 query 和文档块输入到 rerank 模型。本项目实现在 `server/src/core/rerank.ts`: RERANK_MODEL 默认 qwen3.7-text-rerank, RERANK_BASE_URL 默认与 embedding 同一个 compatible-mode 端点; RERANK_PROTOCOL 切换两种协议:

- jina (默认): base 缺版本段时才补 `/v1`, 请求 `{base}/rerank`, body 为 `{ model, query, documents, top_n }`
- dashscope: base 先剥掉 /v1、/v2、/compatible-mode、/compatible-api 后缀再补 /api, 请求 `/api/v1/services/rerank/text-rerank/text-rerank`, body 为 `{ model, input: { query, documents }, parameters: { top_n, return_documents: false } }`

响应用 zod 解析 (兼容 `results` 与 `output.results` 两种形态, relevance_score 支持数字字符串); 429/500/502/503/504 自动重试 3 次, 指数退避从 1.5s 起; 单次请求 60s 超时。精排分低于 RERANK_MIN_SCORE=0.3 视为证据不足。

### 本项目的检索管线

`searchKnowledge` (`server/src/core/retrieval.ts`), 选项 `{ strategy, topK, category, bm25Text, split }`, strategy 默认 hybrid_rerank, topK 默认 RERANK_TOP_K=10:

1. 子查询拆分 (SUBQUERY_SPLIT 默认开启): 问题按逗号/分号/问号/句号 (中英文) 切分, 每段 `>=` 4 字符算一个子句, 切出至少 2 段才触发; 每个子句单独检索, 结果按轮转 (round-robin) 合并去重: 按 chunk id 去重 (无 id 时退化为 section_path:question), 同一 section_path 的首个结果保留原位、后续结果降权到队尾, 避免单个子句霸榜, 最后截取 topK。触发拆分时每个子句以自身文本检索, 调用方传入的 bm25Text 不再下传
2. 四种策略: vector (embedQuery 后 denseSearch)、bm25 (用 `bm25Text || query` 直接 bm25Search)、hybrid (RRF 融合后截取 topK)、hybrid_rerank (召回 `max(topK, RECALL_TOP_K)`=50 条候选, 把每条的 "question answer" 拼接后送 rerank 精排取前 10, 结果附 rerank_score)
3. 查询改写 (`core/query-understanding.ts`): `understand()` 用 QUERY_REWRITE_PROMPT 做结构化输出 `{ standard, expanded }` —— standard 是把口语化、情绪化表述改写成的标准问题, expanded 是 3-6 个同义词/别名扩展 (如 postage ↔ shipping fee), LLM 调用失败时降级为原问题; 调用方把 expanded 拼进 bm25Text, 向量一路只用 standard, 扩写不污染 dense 检索。`expandQueries()` 用 EXPAND_QUERIES_PROMPT 产出恰好 3 条检索友好的英文查询, 供退款流程的 retrievePolicy 节点使用: 对每条查询独立检索, 按 chunk id 取最大 rerank_score 合并后排序
4. 结果排布 `arrangeHeadTail`: 把第 2 名挪到队尾 (1, 3, 4, ..., 2), 利用首因/近因效应让模型更关注头部证据

调用方有三处: 会话图 retrieve_knowledge 节点 (knowledge 路由, 见 [workflow](./workflow))、主力 agent loop 里的 query_faq 内置工具 (注册 timeout 30s、maxRetries 0, 系统提示词要求政策/规则/时效/费用类问题必须走它)、管理台的 /api/kb/search (暴露全部四种策略)。前两处都是先 `understand()` 改写, 再以 hybrid_rerank + bm25Text 调 `searchKnowledge`, 然后做证据充分性判定。

## 置信度闸

进入主力 agent loop 前, 有一道置信度闸: 判断检索到的知识是否足够回答该问题, 如果不够, 则回复兜底话术, 同时记录该问题, 推入到数据飞轮。实现分布在 `core/confidence.ts`、`core/selfcheck.ts` 和 `graph/routing.ts`:

1. `computeEvidenceConfidence` 对精排结果加权打分: top1 精排分 (权重 0.5, clip 到 [0, 1])、有效条数 (精排分 `>=` 0.3 的条数封顶 3, 权重 0.2)、top1 对 top2 的分差 margin (权重 0.2)、关键条款命中 (前 3 条结果的问答文本含 KEY_TERMS 之一, 权重 0.1)
2. 总分低于 EVIDENCE_CONFIDENCE_THRESHOLD (默认 0.26) 直接判 weak, 记录 `fallbackSource=retrieval_low_conf`
3. 过了分数闸还有一道 LLM 自检 `selfcheck.checkSufficient` (SELF_CHECK_PROMPT 结构化输出 `{ useful, reason }`), 判定证据不足以精确回答则 weak, `fallbackSource=self_check`; 自检调用失败一律按证据不足处理
4. 图中 confidence_check 节点按 `confidenceGate` 分流: strong → main_agent, 证据以 "[n] question: answer" 的编号引用注入回合上下文, 要求模型引用 [1][2] 编号、照抄型号、证据不足时明说; weak → fallback_reply, 回复固定兜底话术并附转人工建议, 同时把问题、原因和 top3 检索快照写入 low_confidence_question 表, 成为数据飞轮的燃料

query_faq 工具走同样的判定 (`evaluateHits`: top1 精排分低于 RERANK_MIN_SCORE 或自检不通过 → sufficient=false, agent 按提示词规则拒答)。置信度权重的展示、阈值校准 (calibrate-confidence) 和飞轮闭环见 [可观测性和数据飞轮](./observable)。
