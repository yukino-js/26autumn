---
title: "Yukino 官方 MCP 服务器项目深挖：十连问"
description: "逐问核对源码事实与证据缺口：官方工具集合定位、ToolModule 契约把每会话注册与进程级单例分开、stdio 与无状态 Streamable HTTP 双传输、docs 本地 RAG 两阶段初始化与降级、create_app srcdoc 沙箱、github_tool 进程组回收、十一类数据后端无白名单原样透传、minio 手写 SigV4 点段兼容、量化结果的事实缺口与反思"
---

**项目事实核对型**示范答案。所有常量取自源码实读（本机 `~/github/yukino-code/apps/mcp` @ `7b9add5`）；十问中有若干「事实缺口」，文内以 ✅ **项目事实** / ⚠️ **推导或需澄清** 明确区分。这是「介绍一个你做过的 MCP 服务器 / 工具集成项目」这一高频题的完整串讲脚本。

## 事实基线

| 事实依据   | 内容                                                                                                                                                                                                                                             |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 本机检出   | `~/github/yukino-code/apps/mcp`，当前 HEAD `7b9add5`；包名 `@yukino.js/mcp`，需 Node ≥ 24.6.0（`node:sqlite`）                                                                                                                                   |
| 源码笔记   | `content/fe/yukino-mcp.md`，frontmatter `local_commit` 与本机 HEAD 一致                                                                                                                                                                          |
| 工具清单   | 实读 `src/tools/names.ts` 确认 **15 个工具**：docs_tool、docs_sync、create_app、github_tool、postgres_tool、mysql_tool、clickhouse_tool、redis_tool、mongodb_tool、prometheus_tool、grafana_tool、minio_tool、etcd_tool、milvus_tool、kafka_tool |
| 关键常量   | 均实读源码确认：`EMBED_BATCH_SIZE=10`、`INIT_TIMEOUT_MS=15000`、`DEGRADED_RETRY_MS=30000`、`MAX_CONTENT_LENGTH=8192`                                                                                                                             |
| 未归档产物 | RAG 检索效果、工具调用延迟、数据后端吞吐**均未归档**（见 Q9 事实缺口）                                                                                                                                                                           |

:::danger 事实缺口
十问里有 **3 类事实缺口**：① 数据类工具**无白名单、无只读模式、无确认步骤**（权限等于连接账号权限）——这是要主动声明的安全边界，不是疏漏；② HTTP 端点**不鉴权**，默认只绑 localhost；③ RAG 检索效果与工具延迟**无归档评测**。下面用 ✅ **项目事实** / ⚠️ **推导或需澄清** 标清。
:::

---

## Q1 · 一句话介绍这个项目 + 定位

✅ **项目事实**：`@yukino.js/mcp` 是 Yukino 官方 MCP 服务器，定位是「**官方工具集合**」——不做单一功能，而是把一批高频、彼此正交的能力打包进同一个进程，用一份配置、一次启动对外提供。它解决三类问题：① 给 Agent 一个**本地知识库入口**（docs_tool/docs_sync 把 `~/.yukino/docs` 下的文档向量化检索）；② 给 Agent 一个**渲染结果的出口**（create_app 经 MCP Apps 在对话内渲染可交互 HTML）；③ 给 Agent 一组**直连后端的手**（github_tool 覆盖全部 gh 命令，十一个数据工具原样透传 SQL/Redis/MongoDB/HTTP/S3/Kafka）。

**串讲口径**：共 **15 个工具由 14 个模块注册**（docs 模块同时注册 docs_tool 与 docs_sync）。两条鲜明取舍：数据类工具**不做任何白名单或只读模式**（安全边界交给「连的是哪个库、用什么账号」）；除文档向量索引用内置 `node:sqlite` 外**不引入任何常驻外部服务**（每次数据库调用新建并结束即关）。

## Q2 · 整体架构与 ToolModule 契约

✅ **项目事实**：所有模块实现同一个 `ToolModule` 接口，把「每会话的注册」与「进程级的状态」清晰分开：

```ts
interface ToolModule {
  name: string; // 唯一, 用于日志与去重
  register(server: McpServer): void; // 每个 server 实例调用一次
  init?(): Promise<void>; // transport 就绪后触发, 工具调用 await 同一 Promise
  shutdown?(): Promise<void>; // 进程退出时清理连接/句柄
}
```

`register` 可能被调用多次（**HTTP 传输为每个请求新建一个 McpServer**），而 `init`/`shutdown` 管理的是**进程级单例**（数据库句柄、向量缓存、嵌入 Provider）。模块加载时先跑 `assertUniqueModuleNames()`——因为 `registerTool` 遇重名会抛错，在「每请求一个 server」的 HTTP 模式下这会变成运行时错误，所以宁可启动即失败。

**采分点**：能说出「**ToolModule 契约把『每会话注册』与『进程级单例』分开，让无状态 HTTP（每请求一个 server）与进程级一份重资源共存**」——这是这个服务器最核心的架构设计。

## Q3 · 双传输层如何工作

✅ **项目事实**：两种传输共享同一 `createServer()`：

- **stdio（默认）**：stdout 完全归 JSON-RPC 帧所有，pino 日志显式定向到 fd 2（stderr），任何杂散 stdout 写入都会破坏协议流。shutdown 幂等（`shuttingDown` 标志），先关传输再逐个 `await module.shutdown?.()`，最后 `process.exit(0)`，并挂一个 `unref()` 的 5 秒兜底定时器强制退出。
- **HTTP（`--http`）**：用 h3 只暴露**无状态 Streamable HTTP**——`POST /mcp` 每请求 `createServer()` + transport，处理完在 finally 关闭；`GET /mcp` 直接 405（无状态模式没有服务端主动通知流）。

`main.ts` 入口顺序是刻意的：**传输先就绪、init 后置**——传输先就绪工具立刻可被 list，重活（打开索引、探测维度、后台同步文档）推迟到 init，工具调用内部 await 同一个 init Promise，**首个调用不会被大知识库拖到客户端超时**。

## Q4 · docs 本地 RAG 如何工作

✅ **项目事实**：docs 是服务器里最完整的子系统，一条 `扫描 → 分块 → 嵌入 → 索引 → 检索` 流水线，全部落在本地 SQLite（`node:sqlite`），不依赖外部向量库。关键设计：

- **两阶段初始化**：快阶段（await）配置检查 → 打开索引 → `ensureSchema` 维度探测（有 `INIT_TIMEOUT_MS=15000` 预算，客户端调用超时约 60 秒，卡住的 Provider 必须提前降级）；后台阶段（fire-and-forget）增量文档同步，大知识库永不阻塞首个工具调用。
- **降级而非抛错**：嵌入未配置、索引打不开、schema 超时都返回带原因的 `degraded`，工具回一句诚实的 `docs is unavailable: …`；降级状态有 `DEGRADED_RETRY_MS=30000` 重试窗口（Provider 可能会话中途恢复，无需重启 CLI）。
- **维度探测以模型实际输出为准**（`embedText("dimension probe")`），从不取静态配置；维度或 schema 不匹配就清库逼下次全量重嵌入。
- **EMBED_BATCH_SIZE=10**：兼容端点常限制单次输入条数，SDK 默认的 2048 会触发 batch size 错误。
- **检索用内存矩阵点积**：向量入库时已 L2 归一化，余弦相似度退化为纯点积；个人知识库规模（数千分块）下全量扫描个位数毫秒。

**采分点**：能说出「**两阶段初始化（快阶段 await + 后台同步）+ 降级而非抛错 + 30 秒重试窗口 + 维度以模型实际输出为准**」——「一个子系统降级不拖垮整个服务器」是工具集合服务器的关键韧性。

## Q5 · create_app（MCP Apps）如何安全渲染模型代码

✅ **项目事实**：create_app 让模型产出自包含 HTML，在对话内渲染成可交互应用，基于 `@modelcontextprotocol/ext-apps` 注册一对东西：`registerAppTool(create_app)`（入参 html ≤ 200000 字符、title ≤ 120 字符）与 `registerAppResource(ui://create-app/create-app.html)`（返回沙箱外壳）。

**安全底座**：真正渲染用户 HTML 的是一个 `sandbox="allow-scripts allow-forms allow-modals allow-popups"` 的 iframe，用 `srcDoc` 注入——**没有 storage、没有 cookie、无法访问宿主**。外壳还在 `_meta.ui.csp.resourceDomains` 声明 CDN 白名单（unpkg、jsdelivr、tailwindcss、cdnjs、esm.sh、Google Fonts 共 7 个），因为 srcdoc iframe 继承宿主对 app 资源的 CSP，没有白名单模型写的 CDN 脚本/字体会被静默拦截。

## Q6 · github_tool 如何执行任意 gh 命令

✅ **项目事实**：一个工具覆盖全部 GitHub CLI 能力，入参 `args` 是不带前导 `gh` 的参数数组，**每个元素原样透传、不经 shell 解析**（没有命令白名单也没有确认步骤）。执行层 `runGh` 用 `spawn("gh", args)`，**在非 Windows 上以 detached 建独立进程组**：超时或 MCP 取消时 `kill(-pid, SIGKILL)` 端掉整组再回退单进程 kill——**因为 gh 别名/扩展可能派生继承管道的子进程，只杀主进程会留下孤儿**。`gh` 不在 PATH（ENOENT）时返回安装提示且**从不阻止服务器启动**。

## Q7 · 十一类数据后端如何组织

✅ **项目事实**：十一个后端工具按实现方式分四层（SQL 层 postgres/mysql/clickhouse、协议驱动层 redis/mongodb、HTTP 透传层 prometheus/grafana/etcd/milvus、对象存储 minio、消息队列 kafka），但共享 `operations/shared.ts` 的同一套行为约定：

- **unrestrictedAnnotations**：`readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true`——如实告诉宿主「这会改数据、不可假定幂等」。
- **operationResult** 统一序列化：replacer 把 bigint 转字符串、Error 转 `{name,message}`、Map/Set 转普通结构；后端返回非 2xx/非零码时置 `isError: true` 但保留完整响应体。
- **未配置的后端在被调用时才报配置错误**（而非启动时），与文档索引完全无关。
- **每次调用新建连接、结束即关**，不维持连接池与会话状态——所以需要事务或会话语句序列时要放进同一次调用。

**采分点**：能说出「**unrestrictedAnnotations 如实标注 destructive/非幂等 + 未配置后端调用时才报错（一个后端缺失不拖垮整个服务器）+ 无常驻连接（事务要放同一次调用）**」。

## Q8 · minio_tool 为什么手写 SigV4

✅ **项目事实**：minio_tool 不用任何 SDK，而是**手写 AWS Signature V4 path-style 签名**（RFC 3986 逐段编码、查询参数排序、规范化请求串、派生签名密钥链）。一个精妙的兼容点：**`fetch` 的 URL 解析器会移除路径中的点段（`.`/`..`），而 S3 对象键完全可能含点段——那会改变被签名的路径**。`fetchS3` 检测到路径含点段时改走 Node 原生 `http`/`https` 的 `request` 并单独传 `path`，保证发出的路径与签名逐字节一致。

**采分点**：能说出「**fetch 会规范化掉点段导致签名路径不一致，含点段时改走原生 http.request**」——这是手写 S3 签名最容易踩的坑，答出这点说明真做过。

## Q9 · 量化结果与事实缺口（诚实口径）

⚠️ **这是最容易翻车的一问，必须主动声明缺口**：

| 想说的             | 诚实口径                                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------------------------ |
| 「数据工具安全」   | **无白名单、无只读模式、无确认步骤**，权限等于连接账号权限——生产库应使用最小权限账号或不配置对应环境变量     |
| 「HTTP 端点可用」  | **不鉴权**，默认只绑 localhost（127.0.0.1:3300）；仅在可信网络开启，否则任何能访问该端口的人都能调用全部工具 |
| 「RAG 检索准确率」 | **无归档评测**——检索机制完整（内存矩阵点积、Top-K），但 MRR/Recall 没有系统化评测                            |
| 「工具调用低延迟」 | 每次调用新建连接，**延迟无归档 benchmark**                                                                   |

**标准话术**：「15 个工具的机制与常量都在源码里可查（EMBED_BATCH_SIZE=10、INIT_TIMEOUT_MS=15000、DEGRADED_RETRY_MS=30000），但我要主动声明两个安全边界：数据类工具是无白名单原样透传，权限等于连接账号；HTTP 端点不鉴权、默认只绑 localhost。这是『官方工具集合面向可信开发环境』定位下的自觉取舍，不是疏漏——公网或生产库场景必须用最小权限账号或干脆不配置。」

**采分点**：能主动声明「**无白名单 + HTTP 不鉴权是自觉取舍而非疏漏，并给出最小权限账号的缓解**」——把安全边界讲清比假装安全更可信。

## Q10 · 反思与扩展

⚠️ **推导**（反思题展示判断力）：

1. **数据工具的只读模式**：当前无白名单是「面向可信开发环境」的取舍，若要接生产库，应加一个「只读模式」开关（拦截 INSERT/UPDATE/DELETE/DDL）或语句白名单。
2. **HTTP 端点鉴权**：当前不鉴权 + 只绑 localhost，若要远程访问应加 token 鉴权或 mTLS。
3. **连接池**：每次调用新建连接，高频场景可加连接池（但要权衡「无常驻连接」的简洁性）。
4. **RAG 评测闭环**：补一套检索评测数据集（MRR/Recall），把「机制完整」升级为「效果可证」。

**采分点**：反思要具体到可执行的改进，且承认现有设计的合理性（「无白名单 + 只绑 localhost 在当时面向可信开发环境是对的，接生产库才需要只读模式与鉴权」）。

---

## 追问链与应对

| 追问                                         | 应对要点                                                                                                                          |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 「为什么 HTTP 用无状态 Streamable HTTP」     | 每请求一对 server/transport，请求间不共享会话状态——简化部署、天然水平扩展，代价是没有服务端主动通知流（GET /mcp 直接 405）        |
| 「docs 为什么用 node:sqlite 不用外部向量库」 | 零外部依赖、索引是可重建缓存（源文档才是事实源）、个人知识库规模下内存矩阵点积个位数毫秒——引入外部向量库是过度设计                |
| 「create_app 的 srcdoc 沙箱能防什么」        | 防模型生成的任意 JS 访问宿主 storage/cookie/DOM——sandbox 属性 + CSP 白名单是「让模型代码在对话里跑」的安全底座                    |
| 「github_tool 为什么不经 shell 解析」        | args 数组原样透传给 spawn，不经 shell 就没有命令注入面（shell 元字符不会被解释）——但仍无命令白名单，gh 本身的能力边界就是工具边界 |
| 「15 个工具会不会撑爆上下文」                | MCP 工具默认延迟加载（eager/native/dispatch 三模式，见 yukino-code 内核），schema 总量不足窗口 10% 才全量进工具数组               |
| 「etcd 为什么要 base64 双向翻译」            | etcd v3 JSON 网关把 proto3 bytes 字段映射为 base64，直接传明文会被拒或静默错解——codec 做双向翻译，不支持流式端点（/v3/watch）     |

---

**延伸阅读**

- [Yukino 官方 MCP 服务器项目深挖题库](/interview/qa/yukino-mcp-server-project)：本项目机制的 85 题深挖。
- [MCP 协议与 Agent 安全题库](/interview/qa/mcp-and-agent-security)：MCP 传输、工具注解、宿主校验的通用协议机制。
- [生成式 UI 协议（A2UI 与 MCP Apps）题库](/interview/qa/generative-ui-protocols)：create_app 所属的 MCP Apps 扩展。
- [Yukino Code 执行内核与上下文工程题库](/interview/qa/yukino-code-engine)：MCP 三加载模式（eager/native/dispatch）与工具延迟加载。
- [RAG 与检索深挖题库](/interview/qa/rag-and-retrieval)：分块、嵌入、向量检索的通用原理。
- [指标口径与基线定义](/interview/metrics-baseline)：量化结论的证据纪律（本篇 Q9 的方法论）。
