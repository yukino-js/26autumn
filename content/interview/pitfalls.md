---
title: "高频易错点"
description: "24 条高频概念误用、实现陷阱与证据边界错误, 每条给出正确结论与对应专题卡, 用于考前纠偏"
---

按「概念纠偏 → 实现细节 → 证据边界」三类整理。**只收录可复现、可验证的错误**，每条给出一句话正确结论与回查路径。

## 一、概念纠偏

| #   | 常见错误                                          | 正确结论                                                                                                             | 回查                                                                 |
| --- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 1   | 把「20 MB 单个 JSON」当成 JSONL 逐行解析          | JSONL 每行是独立 JSON 值；单个大 JSON 必须先拆行或换 SAX 式流式 parser                                               | [大 Body 与并发容量](/interview/answers/large-payload-capacity)      |
| 2   | 高并发大 body 题一上来就谈「换个更快的 parser」   | 先算量级（400 GB / 320 Gbps / TB 级堆），判定为容量题，再分层防守                                                    | [大 Body 与并发容量](/interview/answers/large-payload-capacity)      |
| 3   | 说出「cookie 的 same origin」                     | 没有这个属性；分清 Same-Origin（`scheme+host+port`）/ Same-Site（eTLD+1）/ Cookie 作用域（`Domain+Path`）            | [CSRF 与 SameSite](/interview/answers/csrf-and-samesite)             |
| 4   | 拿 CORS 或 `HttpOnly` 当 CSRF 防线                | CORS 只控读响应、请求已到服务端；`HttpOnly` 防 XSS 窃取，不防 CSRF                                                   | [Web 安全与可观测性](/interview/fundamentals/security-observability) |
| 5   | 只靠「接口只收 JSON」防伪造                       | 表单可用 `text/plain` 拼出 JSON 字符串；须叠 Token / 自定义头 / `Sec-Fetch-*`                                        | [CSRF 与 SameSite](/interview/answers/csrf-and-samesite)             |
| 6   | 以为 `SameSite=Strict` 万事大吉                   | GET 副作用、同站子域被接管、WebSocket 需服务端单独校验 `Origin`                                                      | [Web 安全与可观测性](/interview/fundamentals/security-observability) |
| 7   | 用 `Range` 回答「上传续传」                       | `Range` / `206` / `Content-Range` / `If-Range` 是 GET 下载语义；上传续传要 `PATCH + Content-Range`、tus 或应用层分块 | [续传与虚拟滚动](/interview/answers/upload-scroll-alerting-deadlock) |
| 8   | 认为虚拟滚动减少了传输量                          | 它只减少 DOM 节点；传输量靠服务端分页与字段裁剪                                                                      | [浏览器与 React](/interview/fundamentals/frontend-browser)           |
| 9   | 用并查集判等待图有环                              | 等待图是**有向图**，须用 DFS 三色 / Kahn 拓扑 / Tarjan SCC                                                           | [Web 安全与可观测性](/interview/fundamentals/security-observability) |
| 10  | 把 SSE 当成降低 TTFT                              | SSE 只让已生成的字尽早出现；TTFT 由前置串行链路与 prefill 决定                                                       | [RAG 全链路](/interview/fundamentals/rag-pipeline)                   |
| 11  | 把 MCP 传输模式说成「stdio / SSE / Memory」       | JSON-RPC 2.0 + `stdio` / `Streamable HTTP` / `SSE`；`Memory` 不是传输模式                                            | [Agent 执行链路与 MCP](/interview/fundamentals/agent-and-mcp)        |
| 12  | 声称 MCP tool 由 Server「自动执行」               | Host/Client 发起 → Server 执行；工具描述与资源内容不可信，Host 仍要校验与清洗                                        | [Agent 执行链路与 MCP](/interview/fundamentals/agent-and-mcp)        |
| 13  | 说 React v16 把 Diff 复杂度从 `O(n³)` 降到 `O(n)` | 三条启发式在 v16 之前就降到近似 `O(n)`；Fiber 变的是**可中断 / 可分片**，不是量级                                    | [浏览器与 React](/interview/fundamentals/frontend-browser)           |
| 14  | 认为 Redis 与 DB 之间可以强一致                   | 预扣减 + MQ 落库只能是**最终一致**，靠 outbox、幂等、对账与补偿收敛                                                  | [存储一致性](/interview/fundamentals/storage-consistency)            |

## 二、实现细节

| #   | 常见错误                             | 正确结论                                                                                        | 回查                                                            |
| --- | ------------------------------------ | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| 15  | JSONL 只追加、不轮转                 | 按大小 / 时间轮转 + 压缩 + checkpoint（`activity.jsonl` 的 10,000 条上限）                      | [大 Body 与并发容量](/interview/answers/large-payload-capacity) |
| 16  | 把「一定时间范围」直接当固定窗口     | 边界可放行 `2×limit`；严格语义要用滑动窗口日志                                                  | [JS 手写限流器](/interview/code/rate-limiter)                   |
| 17  | 用 `shift()` 裁时间戳、只裁不清 key  | `head` 指针均摊 `O(1)` + 压缩；`sweep()` 清空闲 key 防 Map 泄漏                                 | [JS 手写限流器](/interview/code/rate-limiter)                   |
| 18  | 进程内计数器直接上多实例             | 各进程计数独立失效 → Redis zset + Lua 原子（检查与写入竞态）                                    | [JS 手写限流器](/interview/code/rate-limiter)                   |
| 19  | 把检索证据塞进 system prompt         | 项目放在当前用户消息之后的 **turn-ctx user 消息**，为保住前缀缓存                               | [电商 RAG 项目深挖](/interview/answers/ecomm-rag-project)       |
| 20  | 声称 Kafka 以业务 Key 分区就全局有序 | 只保证分区内有序；扩容需 Epoch + 冻结路由 + 版本校验                                            | [RAG 全链路](/interview/fundamentals/rag-pipeline)              |
| 21  | 把中间 ASR 结果直接写进知识库        | 只有 `is_final` 才落库；中间结果仅实时展示，避免重复写入                                        | [RAG 全链路](/interview/fundamentals/rag-pipeline)              |
| 22  | 深分页用大 `OFFSET` 优化             | 用游标 `WHERE id > 上一页末尾实际 ID ORDER BY id LIMIT n`；别把「第 100 万条」当成 `id=1000000` | [存储一致性](/interview/fundamentals/storage-consistency)       |

## 三、证据边界

:::warning 最容易翻车的一类
把**方案推导**讲成**项目已做**，或现场编造未归档的数字。面试官的连续追问通常就是在验证这两类证据能否分清。
:::

| #   | 常见错误                                         | 正确结论                                                                               | 回查                                                                             |
| --- | ------------------------------------------------ | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 23  | 把「4 策略检索消融」说成「模型选型实验」         | 前者是 ablation（Recall@5 / MRR），跨模型 A/B 需另做控制变量对照                       | [指标口径与基线定义](/interview/metrics-baseline)                                |
| 24  | 现场编造「改造前分数」或「rerank 提升幅度」      | `rag_eval.json` 是运行时产物且未归档；如实说重跑同数据集对比                           | [RAG 六连问](/interview/answers/rag-deep-dive)                                   |
| 25  | 声称意图分类用了某参数量级小模型                 | `INTENT_MODEL` 未配置、回落 chat 组 `deepseek-flash`；API 模型无参数规模               | [电商 RAG 项目深挖](/interview/answers/ecomm-rag-project)                        |
| 26  | 把「读过同类源码」说成「做过方案选型 benchmark」 | 有 Claude Code / Pi / LangChain / LangGraph 源码调研，但无正式对照表与实验             | [Coding Agent 记忆与基线](/interview/answers/coding-agent-memory)                |
| 27  | 拿 99.4% → 9.5% 当「输入 token 降低」的证据      | 那是 tools 数组追加一个工具导致 cache 命中率掉落的单次实测，只解释设计动机             | [指标口径与基线定义](/interview/metrics-baseline)                                |
| 28  | 现场给「写入率提升 X%」                          | 仓库无 eval / bench 脚本、无 baseline、无报告；先澄清写入率口径（cache / 记忆 / 会话） | [指标口径与基线定义](/interview/metrics-baseline)                                |
| 29  | 把「告警归属率」当项目已落地的指标               | 知识库无该指标记录；框架可讲，但须标为推导                                             | [续传、虚拟滚动、告警与死锁](/interview/answers/upload-scroll-alerting-deadlock) |
| 30  | 编「我们对比过多种分块长度」                     | `400/60/10` 是 `buildChunks` 的源码默认常量，无配置化、无消融实验                      | [RAG 六连问](/interview/answers/rag-deep-dive)                                   |

## 速记卡

- **先拆陷阱再作答**：格式陷阱、题型陷阱、概念误用，开口澄清即得分。
- **先算量级再谈方案**：容量题的采分点在数量级，不在技术名词。
- **三层证据**：项目事实（路径 + 常量 + 实测） / 方案推导 / 未归档产物，口径必须分开。
- **数字三问**：baseline 是谁、分子分母是什么、报告产物在哪。
- **边界四件套**：异常、安全、规模、降级；缺一件就掉「边界意识」分。
