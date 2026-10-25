---
title: "RAG"
---

RAG, Retrieval-Augmented Generation 检索增强生成

知识库: 文档库和历史聊天

历史聊天可以分批提供给 LLM, 提取为问答对 (见可观测性一章的知识挖掘)

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

1. `splitSections` 按 h1-h4 标题把 markdown 切成小节, 维护标题栈产出 section_path ("一级标题 / 二级标题 / 三级标题"); 代码块 (三个反引号或 ~~~ 围栏) 整体扫描, 块内的 # 行不会被误判为标题
2. 每个小节的正文:
   - 表格块 (识别 | 表头 + 分隔线) 用 `splitTableRows` 按行切割, 每块都复制表头和分隔线, 默认每块最多 10 行
   - 非表格文本用 `recursiveSplit` (RecursiveCharacterTextSplitter, chunkSize=400, 分隔符依次为: 段落、换行、中文句号/叹号/问号/分号、英文句号/叹号/问号/分号、中文逗号、空格、字符)
   - 再用 `applySentenceOverlap` 加 overlap (默认 60 字符): 从前一块的末尾按完整句子截取 (截到最近的句读), 拼到后一块的开头, 不截半个句子
3. 每块结构化为 chunk: category 取标题路径 (去掉最后一级), questions 取最后一级标题, answer 取正文
4. `isKey` 标记关键条款: 标题或正文前 40 字符命中 refund / return / timeframe / time limit / shipping fee / postage / fee / warranty / compensation / period / free shipping 之一, 标记 isKeyClause=1, 切割时保证完整性, 检索时参与置信度计算

知识库材料是 `server/data/kb/` 下的 6 份 markdown (product-faq、returns-policy、after-sales-manual、product-specs、member-benefits、billing-shipping), 每份文件映射一个 contentType (faq / policy / manual / spec)。

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

## embedding 策略

将文本块转换为数组, 语义相邻的内容在数学空间中靠的更近 (余弦相似度)

不是 embedding 模型参数越大, 检索效果越好: 文档切割的质量、有没有做重排、有没有对特定领域做微调也影响检索的质量

有些 embedding 模型会加 query: 检索前缀和 document: 文档前缀, 进一步提升检索效果

本项目通过 EMBED_MODEL / EMBED_BASE_URL / EMBED_API_KEY 接 OpenAI 兼容的 embedding 端点 (默认 qwen3.7-text-embedding-flash); 向量化按 64 块一批, 每批 embedding 请求最多 20 条文本。被向量化的文本是 "category\nquestions\nanswer" —— 与写入 Milvus text 字段的是同一个字符串。

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

本项目的关系型数据库是 PostgreSQL (Prisma), 原文存 knowledge_chunk 表 (Python 原版用 MySQL, 迁移后统一为 PostgreSQL)。

### 原文和向量的搭配

1. 元数据、原文、和向量存储到 Milvus
2. 元数据、原文和向量存储到 Milvus, 既可以相似度搜索、召回; 又可以在正文上使用 BM25 全文检索; 关系型数据库存储原文, 作为权威数据源, conversation 会话、ticket 人工工单、flywheel 飞轮等需要 sql 事务的业务数据也存储到关系型数据库, 通过 vectorId 和 Milvus 中的记录对应

检索时, 直接到 Milvus 查询正文和元数据; 需要补全业务上下文时, 根据 vectorId 到关系型数据库查询

### 双写和状态位

先将切割得到的文本块存储到关系型数据库, vectorId 为空, 状态标记为「未向量化」(pending); 然后将该文本块输入到 embedding 模型得到向量, 将元数据、原文和向量作为一条记录存储到 Milvus, 最后将 ID 作为 vectorId 写回关系型数据库对应的记录, 状态标记为「已向量化」(done)

通过是否向量化的状态位, 可以扫描一遍关系型数据库, 拿到「未向量化」的记录, 只对未向量化的记录重新向量化, 不需要整库重新向量化

```
切割得到的文本块存储到关系型数据库, 未向量化
-> 文本块输入到消息队列 (optional)
-> 消息队列转发文本块到 embedding 模型得到向量
-> 元数据、原文和向量存储到 Milvus 得到 vectorId
-> vectorId 写回关系型数据库对应的记录, 已向量化
```

(消息队列是大规模场景的可选设计, 本项目同步调用 embedding)

实现 (`server/src/kb/dualwrite.ts`):

1. `writePending` 把 chunk 写入 knowledge_chunk (vectorizeStatus=pending)
2. `vectorizePending` 按 64 条一批扫描 pending 记录, embedding 每批最多 20 条文本
3. Milvus 模式: 批量 upsert (id 直接用关系表主键, 不依赖 Milvus 自增 ID), flush 后写回 vectorId 并标记 done; legacy 模式: 向量直接存关系表的 embedding 字段
4. kb-repatch 支持补丁式重嵌: md 正文变更后原地更新对应 chunk 的文本并重置为 pending, 再跑向量化, 不整库重建

### legacy 模式 (无 Milvus)

未配置 MILVUS_URI 时, dense 向量存在关系表的 embedding 字段, 检索在进程内完成 (`server/src/kb/store.ts`):

- dense: 全量余弦相似度打分 (向量缓存按知识库 revision 失效)
- BM25: 进程内实现, K1=1.5、B=0.75; 分词对英文/数字大小写不敏感, 中文用 bigram (相邻两字一个 token), 不依赖分词服务
- 四种检索策略 (vector / bm25 / hybrid / hybrid_rerank) 在没有向量数据库时照常工作

### Milvus 模式

配置 MILVUS_URI 后, Milvus 是权威向量库 (官方 Node SDK @zilliz/milvus2-sdk-node 直连 gRPC :19530, 无桥接进程); Milvus 挂掉直接报错, 不静默降级。collection 在第一次 upsert 时懒创建, 维度从数据推断 (模型无关, 不硬编码), Strong 一致性 (双写计数校验是确定性的):

- id: Int64 主键 (关系表的 chunk ID, 非自增)
- dense: FloatVector, AUTOINDEX + COSINE
- text: VarChar, 开启 analyzer (standard), 写入建库时的被向量化文本
- sparse: SparseFloatVector, 由绑定在 text 上的 BM25 Function 自动派生, SPARSE_INVERTED_INDEX + BM25
- question / answer / section_path / content_type / category: 标量字段

Milvus 的 BM25 Function 自动给 text 字段生成稀疏向量, 应用侧不需要维护分词器。旧版本创建的 dense-only collection 会被 schema 检查拒绝, 并给出重建步骤 (kb-reset -> kb-build -> kb-vectorize)。

## 在线问答

用户的问题输入到 embedding 模型得到向量, 再到 Milvus 对问题向量做相似度搜索, 取 topK 排名前 k 个

缺陷: 用户有时可能给出商品 SKU (Stock Keeping Unit, 最小库存管理单元) 编号, 这时查询要求字面量精确匹配, 不适合相似度搜索

## 混合检索

```
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

## Milvus

Milvus 支持 BM25 全文检索, 建库时给正文字段绑定一个 BM25 函数, Milvus 会自动给正文字段生成稀疏向量; 查询时使用 hybrid_search 同时得到两路查询结果

### 召回 -> 粗排 (融合) -> 精排

**召回**

Milvus SDK 发送两路召回请求, 稀疏路走倒排索引 + BM25 关键词检索, 稠密路走 ANN + 余弦相似度; 每个请求返回一批最多 50 条候选 (RECALL_TOP_K=50); 再将两批候选输入到 RRF 倒排融合 (k=60) 进行粗排, 得到倒排融合的候选池; 最后使用更慢、质量更高的 rerank 模型精排 (RERANK_TOP_K=10)

另一种实现是使用 ElasticSearch 进行 BM25 关键词检索, 依赖 ES 集群、Milvus 向量库和 ES 的数据一致性

召回前, 可以使用元数据筛选, 例如用户提问的商品有明确的 category 分类, 以缩小候选范围, 进一步提升召回精度和速度 (本项目 query_faq 支持 category 参数; 过滤后结果为空或分数过低时自动去掉过滤重试一次)

**粗排**

- 向量相似度搜索给出的是余弦相似度, 取值范围是 [-1, 1]
- BM25 关键词检索给出的得分可能是 [0, 10] 甚至 1x 分

一类方法是「分数级融合」例如都归一化到 [0, 1], 再按权重相加, 缺点是不够灵活, 需要按场景微调; 对于粗排 (分数级融合), 权重可以按 query 类型指定, 例如对于商品 SKU、优惠券码, 应该更偏向 BM25 关键词检索; 对于口语化的模糊问题, 应该更偏向向量相似度搜索

另一类方法是「RRF 倒排融合」, 不比较分数, 只比较排名: 一路召回中, 每份文档贡献 `1 / (k + 排名)` 分数; 两路召回贡献分数相加, k 通常取 60

**精排**

精排使用更慢、质量更高的 rerank 模型 (默认 qwen3.7-text-rerank), 使用 cross-encoder 交叉编码, 拼接 query 和文档块输入到 rerank 模型。本项目支持两种协议: jina (/v1/rerank) 和 dashscope (compatible-mode, RERANK_PROTOCOL 切换); 429/5xx 自动重试 3 次, 指数退避 (1.5s 起)。精排分低于 RERANK_MIN_SCORE=0.3 视为证据不足。

### 本项目的检索管线

`searchKnowledge` (`server/src/core/retrieval.ts`):

1. 子查询拆分: 问题包含多个标点分隔的子句 (逗号/分号/问号/句号, 每段 >= 4 字符) 时, 每个子句单独检索, 结果按轮转 (round-robin) 合并去重, 避免单个子句霸榜 (SUBQUERY_SPLIT 开关)
2. 四种策略: vector / bm25 / hybrid (RRF 融合) / hybrid_rerank (RRF + 精排, 默认)
3. 查询改写: 检索前用 QUERY_REWRITE_PROMPT 把口语化表述改写成标准问题并给出同义词扩展; 扩展词只拼进 BM25 一路 (bm25Text), 向量一路用标准问题 —— 扩写会导致检索、粗排、精排耗时翻倍, 只在核心业务场景下使用
4. 结果排布 `arrangeHeadTail`: 把第 2 名挪到队尾 (1, 3, 4, ..., 2), 利用首因/近因效应让模型更关注头部证据

## 置信度闸

进入主力 agent loop 前, 有一道置信度闸: 判断检索到的知识是否足够回答该问题, 如果不够, 则回复兜底话术, 同时记录该问题, 推入到数据飞轮。置信度公式和飞轮闭环见「可观测性和数据飞轮」一章。
