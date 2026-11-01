---
title: "Yukino 官方 MCP: 一个进程内的工具集合服务器"
description: "把本地 RAG 文档检索、MCP Apps 交互式 UI、gh CLI 与 PostgreSQL/MySQL/ClickHouse/Redis/MongoDB/Prometheus/Grafana/MinIO/etcd/Milvus/Kafka 十一类数据后端收敛成 15 个 MCP 工具, 用 stdio 与无状态 Streamable HTTP 双传输对外暴露, 并以进程级单例承载向量索引与连接生命周期。"
local_path: "$HOME/github/yukino-code/apps/mcp"
local_commit: "bef5439b54e6510a12da61bcfa4285ecb1cd2192"
---

本文拆解 Yukino 官方 MCP 服务器(`@yukino.js/mcp`): 它把一组彼此独立的能力——本地知识库的语义检索、可交互的单文件 HTML 应用、任意 `gh` 命令、以及十一种数据/消息/可观测后端——统一封装成 MCP 工具, 通过 stdio 或 HTTP 暴露给 Yukino CLI 及任何 MCP 宿主。内容以功能、实现思路与适用场景为主线, 覆盖传输层、工具模块契约、RAG 检索链路、MCP Apps UI 生成、数据库与中间件工具面与配置体系。适合正在搭建 MCP 服务器、关心工具注册与进程内状态管理的工程师阅读。

## 定位与解决的问题

MCP(Model Context Protocol)让宿主(如 Yukino CLI)以统一协议发现并调用外部工具。这个服务器的定位是"官方工具集合": 不做单一功能, 而是把一批高频、彼此正交的能力打包进同一个进程, 用一份配置、一次启动对外提供。它解决三类问题:

- **给 Agent 一个本地知识库入口**: 把 `YUKINO_DOCS_DIR`(默认 `~/.yukino/docs`)下的 Markdown/文本文档做向量化, 提供语义检索(`docs_tool`)与增量同步(`docs_sync`), 让模型能查到项目/团队私有文档, 而不必把全部内容塞进上下文。
- **给 Agent 一个"渲染结果"的出口**: 通过 MCP Apps 扩展, 让模型产出一段自包含 HTML, 在对话内以沙箱 iframe 呈现为可交互应用(`create_app`), 用于图表、仪表盘、计算器、可视化演示。
- **给 Agent 一组"直连后端"的手**: 一个 `github_tool` 覆盖全部 `gh` 子命令; 十一个数据工具(`postgres_tool`/`mysql_tool`/`clickhouse_tool`/`redis_tool`/`mongodb_tool`/`prometheus_tool`/`grafana_tool`/`minio_tool`/`etcd_tool`/`milvus_tool`/`kafka_tool`)以"无限制、原样透传"的方式执行 SQL、Redis 命令、MongoDB 命令、HTTP API 调用、S3 签名请求与 Kafka 生产/消费。

### 能力边界

服务器共暴露 **15 个工具**, 由 **14 个模块**注册(`docs` 模块同时注册 `docs_tool` 与 `docs_sync`), 工具名集中在 `src/tools/names.ts`, 模块清单在 `src/tools/index.ts`。设计上有两条鲜明取舍: 其一, 数据类工具**不做任何白名单或只读模式**, 以连接账号的完整权限原样执行, 把安全边界交给"连的是哪个库、用什么账号"; 其二, 除文档向量索引使用内置 `node:sqlite` 外, **不引入任何常驻外部服务**, 每次数据库调用都新建并在结束后关闭连接(Kafka 则是每次调用新建 Admin/Producer/Consumer, 用完即关)。

| 维度       | 选型                                                                                                                                       |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 协议       | `@modelcontextprotocol/server`(`McpServer` 与两种 transport) + `@modelcontextprotocol/ext-apps`(MCP Apps)                                  |
| 传输       | stdio(默认) / HTTP(无状态 Streamable HTTP), 由 `--http` 或 `MCP_TRANSPORT=http` 切换                                                       |
| HTTP 框架  | `h3`(`H3` + `serve`)                                                                                                                       |
| 参数校验   | `zod` v4(工具入参 schema 与环境变量 schema 共用)                                                                                           |
| RAG        | `ai` + `@ai-sdk/openai-compatible` 生成向量, `@langchain/textsplitters` 做 Markdown 分块, `node:sqlite` 存索引                             |
| 数据后端   | `pg` / `mysql2` / `redis` / `mongodb` 官方驱动 + `@platformatic/kafka` + `fetch`(ClickHouse/etcd/Milvus/Prometheus/Grafana/MinIO 签名请求) |
| 子进程     | `node:child_process` 的 `spawn` 直接拉起 `gh`                                                                                              |
| UI 构建    | `vite` + `@vitejs/plugin-react` + `@tailwindcss/vite` + `vite-plugin-singlefile`(daisyUI)                                                  |
| 服务端打包 | `tsup`(ESM, target `node24`)                                                                                                               |
| 日志       | `pino`, 只写 stderr                                                                                                                        |
| 测试       | `vitest`, 经 `@modelcontextprotocol/client` 的 `Client` + `InMemoryTransport` 连接真实 server 断言行为                                     |
| 运行时     | Node.js ≥ 24.6.0(`node:sqlite` 为前缀专属内建模块)                                                                                         |

## 架构总览

```text
   stdin/stdout(JSON-RPC)           HTTP(:3300)
        │                               │
        ▼                               ▼
   StdioServerTransport        h3 app: POST /mcp(无状态, 每请求一对
        │                      server/transport)
        │                      GET  /mcp → 405
        └───────────┬───────────────────┘
                    ▼
   createServer(): new McpServer({name, version}, {instructions})
   for (module of modules) module.register(server)   ← 14 个 ToolModule
        │
        ├─ create_app(MCP Apps UI)   ├─ docs(docs_tool + docs_sync)
        ├─ github(gh CLI)            ├─ postgres / mysql / clickhouse(SQL)
        ├─ redis / mongodb(协议驱动) ├─ prometheus / grafana(HTTP 透传)
        ├─ minio(S3 SigV4 签名)      ├─ etcd / milvus(HTTP JSON 网关)
        └─ kafka(@platformatic/kafka 原生协议)
                    │
                    ▼  进程级单例(init/shutdown, 仅 docs 模块)
        SQLite 向量索引 · 嵌入 Provider
```

`main.ts` 是入口: 先选择传输(stdio 直接 `createServer()` + `StdioServerTransport`; HTTP 则 `startHttpServer(host, port)`), 连接/监听完成**之后**才 fire-and-forget 触发各模块的 `init()`。这个顺序是刻意的——传输先就绪, 工具立刻可被 `list`; 而真正的重活(打开索引、探测维度、后台同步文档)推迟到 init, 工具调用内部会 `await` 同一个 init Promise, 因此首个调用不会被大知识库拖到客户端超时。入口还在最前面依次 import `shared/quiet-sqlite-warning.js`(必须是第一个 import, 见下文)与 `dotenv/config`(加载 `.env`)。

## 工具模块契约与注册

所有模块实现同一个 `ToolModule` 接口(`src/tools/types.ts`), 把"每会话的注册"与"进程级的状态"清晰分开:

```ts
interface ToolModule {
  name: string; // 唯一, 用于日志与去重
  register(server: McpServer): void; // 每个 server 实例调用一次
  init?(): Promise<void>; // transport 就绪后触发, 工具调用 await 同一 Promise
  shutdown?(): Promise<void>; // 进程退出时清理连接/句柄
}
```

`register` 之所以可能被调用多次, 是因为 HTTP 传输会为每个请求新建一个 `McpServer`(见下文), 而 `init`/`shutdown` 管理的是**进程级单例**(数据库句柄、向量缓存、嵌入 Provider)。`server.ts` 在模块加载时先跑一次 `assertUniqueModuleNames()`: 因为 `registerTool` 遇到重名会抛错, 在"每请求一个 server"的 HTTP 模式下这会变成运行时错误, 所以宁可启动即失败。

工具名集中维护在 `names.ts`(`TOOL_NAMES` 常量 + `McpToolName` 类型), 约定 snake_case 且至少两个词: 单词工具加 `_tool` 后缀(`docs_tool`/`github_tool`), 复合名保持不变(`create_app`/`docs_sync`)。`createServer()` 还会把一段 `INSTRUCTIONS` 以 `{ instructions }` 传给 `McpServer`——它在 `initialize` 时下发给宿主, Yukino 会注入模型上下文, 用于改善工具选择(告诉模型何时该查文档、何时该渲染 App、各数据与中间件工具的用途与连接方式); 服务器名常量为 `SERVER_NAME = "yukino-mcp"`。版本号由 `version.ts` 解析: 构建期 `tsup` 通过 `define` 注入 `__YUKINO_MCP_VERSION__`; 开发态(`tsx`)则回退读取相对自身的 `../package.json` 或 `../../package.json`(用 zod 校验出 `version` 字段), 都找不到则抛错。

## 双传输层

### stdio(默认)

stdio 模式下 **stdout 完全归 JSON-RPC 帧所有**, 因此 `pino` 在 `shared/logger.ts` 里被显式定向到 fd 2(stderr), 任何杂散的 stdout 写入都会破坏协议流。SDK 的 transport 不会在 stdin EOF 时自动关闭, 所以入口同时监听 `process.stdin` 的 `end`/`close` 与 `server.server.onclose`, 触发统一的 `shutdown`。`shutdown` 是幂等的(`shuttingDown` 标志): 先关传输, 再逐个 `await module.shutdown?.()`, 最后 `process.exit(0)`, 并挂一个 `unref()` 的 5 秒兜底定时器强制退出——任何卡死的传输或模块都不能让进程吊住不退出。SIGINT/SIGTERM 走同一条路径。

### HTTP(`--http`)

HTTP 模式用 `h3` 只暴露一种远程传输——**无状态 Streamable HTTP**:

| 端点        | 行为                                                                                                                                                                                   |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /mcp` | 每请求 `createServer()` + `WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true })`, `transport.handleRequest(event.req)` 处理完在 `finally` 中关闭 transport 与 server |
| `GET /mcp`  | 直接 405(JSON `{ error: "Method Not Allowed" }`), 无状态模式没有服务端主动通知流                                                                                                       |

无状态的关键在于"每请求一对 server/transport, 用完即关": 工具模块的可共享状态都在进程级单例里, 新建实例很廉价, 无需会话簿记; `enableJsonResponse` 让响应以完整 `application/json` 返回而非 SSE 帧, 测试也验证了 `tools/list` **无需先完成 `initialize` 往返**即可直接调用。`serve(app, { hostname, port, silent: true, gracefulShutdown: false })` 关闭了 srvx 自带的优雅关闭与日志, 把关闭编排权交回 `main.ts` 的信号处理, 避免竞争; `HttpServerHandle.close()` 直接 `server.close(true)` 强制关闭监听。HTTP 端点**不做鉴权**, 默认绑定 `127.0.0.1:3300`(`HOST`/`PORT`), 只适合本机或可信网络。

## docs_tool / docs_sync: 本地 RAG 检索

这是服务器里最完整的子系统, 一条 `扫描 → 分块 → 嵌入 → 索引 → 检索` 的流水线(`src/tools/docs/`), 全部落在本地 SQLite 上, 不依赖任何外部向量库。

### 存储: node:sqlite 向量索引

索引是一个 SQLite 文件(`YUKINO_INDEX_DB`, 默认 `~/.yukino/index.sqlite`, 目录不存在会 `mkdirSync` 递归创建; `:memory:` 则跳过建目录), 通过 `node:sqlite` 的 `DatabaseSync` 打开, 构造参数带 5 秒 busy timeout。`node:sqlite` 用 `createRequire` **懒加载**而非静态 import: ESM 会在任何模块体执行前先求值 import, 静态引入会抢在 `quiet-sqlite-warning.ts` 安装过滤器之前拉起实验性模块, 导致每次调用都打印 `ExperimentalWarning`(该过滤器 patch `process.emit`, 吞掉消息匹配 `SQLite` 的 `ExperimentalWarning`, 且必须是入口的第一个 import)。打开后立即设 `journal_mode=WAL`(后台同步不阻塞读)与 `synchronous=NORMAL`, 再执行建表 schema。三张 STRICT 表:

| 表        | 作用                                                                                                           |
| --------- | -------------------------------------------------------------------------------------------------------------- |
| `meta`    | 键值对, 存 `schema_version`(当前为 `"1"`)与向量维度 `dim`                                                      |
| `sources` | `source → 内容 sha256`, 增量同步的判据                                                                         |
| `chunks`  | 分块正文、metadata(JSON 字符串)、创建时间与 `vector` BLOB(Float32 原始字节), 另有 `chunks_source_idx` 二级索引 |

索引被当作**可重建的缓存**: `ensureSchema` 发现存储的 schema 版本或维度与当前不符时, 直接 `DELETE` 全表并重写 meta, 而不做迁移。

### 分块与嵌入

分块用 LangChain 的 `RecursiveCharacterTextSplitter.fromLanguage("markdown")`, `chunkSize=1000`、`chunkOverlap=200`——远低于入库时 8192 字符的截断上限与嵌入 Provider 的输入上限, 保证"被嵌入的文本"与"被存储的文本"完全一致。每个分块附带一个 section title: 取块内第一个 Markdown 标题(`/^#{1,6} +(.+)$/` 逐行匹配), 没有则继承更早的块里最近一次出现的标题(块按文档顺序到达); 空白分块(trim 后为空)直接丢弃。嵌入走 `@ai-sdk/openai-compatible` 的 OpenAI 兼容端点, 单条用 `ai` 的 `embed`、批量用 `embedMany`, 批量大小固定为 `EMBED_BATCH_SIZE = 10`(兼容端点常限制单次输入条数, SDK 默认的 2048 会触发 batch size 错误), 每次调用带 20 秒 `AbortSignal.timeout` 与 `maxRetries: 1`。

### 增量同步

`syncDocs` 先用 `scanDocsDir` 扫描目录: 递归 `readdir` 只收 `.md`/`.markdown`/`.txt` 普通文件, `source` 是归一化为 `/` 的相对路径, 结果按 `localeCompare` 排序; 目录不存在(`ENOENT`)是正常态, 返回空; 单个文件读取失败记 `content: null`(计 failed, 保留该文件的既有索引)。随后对每个文件算内容 sha256 与 `sources` 里记录的比对: 相同则跳过(skipped), 新增/变更则**先嵌入再原子替换**, 磁盘上已删除的文件从索引移除(removed)。

原子性由 `indexer.ts` 的 `transact` 封装的 `BEGIN IMMEDIATE` 事务保证——它一上来就抢写锁, 并发写者会在此处以 `SQLITE_BUSY`(errcode 5)显现并被翻译成 `LockConflictError`(在同步统计里计为 skipped 而非 failed), 一个 `COMMIT` 完成"删旧分块 → upsert 新分块 → 更新 hash"的全有或全无替换; 分块 id 是确定性的 `sha256(source):序号`, 因此重复索引同一文件是幂等的 upsert。嵌入刻意放在拿写锁**之前**, 且入库前校验向量数量一致、非空、全部有限, Provider 失败时旧分块与旧 hash 都原封不动。写入时正文截断到 `MAX_CONTENT_LENGTH = 8192` 字符。单文件失败只记录并跳过, 绝不中断整轮同步; 每次写入结束都 `invalidateCache` 让检索缓存失效。

并发控制还有一层进程内的单飞: `runSync` 复用同一个 `syncPromise`, 因此后台同步与显式 `docs_sync` 调用不会重复跑。`docs_sync` 无入参, 会 `await` 进行中的同步, 返回 `{indexed, skipped, removed, failed, chunks}` 统计(failed 非零时置 `isError`), 同时进 `structuredContent`。

### 检索: 内存矩阵 + 点积

检索不用 SQLite 做向量运算, 而是把所有向量一次性载入一块连续的 `Float32Array` 行主序矩阵(`VectorCache`, 建缓存时跳过字节长度不等于 `dim*4` 的坏行)。向量入库时已 L2 归一化, 于是余弦相似度退化为**纯点积**, 结果再夹到 `[-1, 1]`; 在个人知识库规模(数千分块)下全量扫描只需个位数毫秒, 远比往返外部索引划算。缓存失效靠 `PRAGMA data_version` 与缓存记录的版本号比对: 本进程写入已显式 `invalidateCache`, 而兄弟进程在背后提交索引也能被 data_version 变化捕捉到, 自动重建缓存。Top-K 用单趟扫描维护一个至多 K 个元素的有序数组; 分数按 `(1 + cosine) / 2` 映射回 `[0,1]`(1 为完全相同)。查询向量维度与缓存 `dim` 不符或缓存为空时直接返回空结果。命中行按 id 回查 `content`/`metadata`, 文本结果格式化为 `[i] source: … | title: … | score: x.xxx` + 正文, 以 `---` 分隔; `structuredContent` 为 `{documents, indexing}`(`indexing` 表示后台同步仍在进行)。`docs_tool` 入参为 `query`(非空)与 `top_k`(1–10, 默认 3)。

### 两阶段初始化与降级

`docs` 模块用一个进程级 `EngineState`(`ready` / `degraded`)单例, 初始化分两阶段:

- **快阶段(await)**: 配置检查 → `openStore` 打开索引 → `ensureSchema` 维度探测 + schema 校验, 其中 `ensureSchema` 有 15 秒预算(`INIT_TIMEOUT_MS`, 客户端调用超时约 60 秒, 卡住的 Provider 必须提前降级)。完成后即可对既有数据查询。
- **后台阶段(fire-and-forget)**: 增量文档同步, 大知识库永不阻塞首个工具调用。

任何失败都**降级而非抛错**: 嵌入未配置、索引打不开、schema 初始化超时, 都返回带明确原因的 `degraded`, 工具调用据此回一句诚实的 `docs is unavailable: …`。降级状态有 30 秒重试窗口(`DEGRADED_RETRY_MS`)——Provider 可能在会话中途恢复, 无需重启 CLI。维度探测(`embedText("dimension probe")`)以模型实际输出为准, 从不取静态配置; 维度或 schema 不匹配就清库, 逼下次同步全量重嵌入。查询期若发现异常且数据库句柄已关闭(`db.isOpen` 为 false), 会把状态切到 `degraded`(vector index connection lost)并关闭句柄, 走同样的重试窗口恢复。对空索引的首次搜索若后台同步仍在进行, 会提示"调用 docs_sync 等待后重试"。`shutdown` 只在状态为 ready 时关闭数据库句柄, 从不等待在途的 init/sync。

## create_app: MCP Apps 交互式 UI

`create_app` 让模型产出一段完整、自包含的 HTML(内联 CSS/JS), 在对话内渲染成可交互应用。它基于 `@modelcontextprotocol/ext-apps`, 用其 `/server` 子路径注册**一对**东西:

- `registerAppTool(create_app)`: 入参 `html`(≤ 200000 字符)与 `title`(≤ 120 字符, 默认 `MCP App`), 工具**定义**在 `_meta.ui.resourceUri` 指向 UI 资源 `ui://create-app/create-app.html`; 处理器会先 `readAppHtml()` 确认外壳存在, 再把完整 HTML 与标题放进结果的 `_meta.html`/`_meta.title`(title 同时进 `structuredContent`); 宿主若无 MCP Apps 支持, 只看到一句文本回退说明。
- `registerAppResource(ui://create-app/create-app.html)`: 返回一个**沙箱外壳** HTML, MIME 用扩展约定的 `RESOURCE_MIME_TYPE`, 并在 `_meta.ui.csp.resourceDomains` 声明允许的 CDN 白名单(unpkg、jsdelivr、tailwindcss、cdnjs、esm.sh、Google Fonts 的 `fonts.googleapis.com` 与 `fonts.gstatic.com` 共 7 个)。外壳用同文档 `srcdoc` iframe 渲染用户 HTML, 会继承宿主对 app 资源的 CSP, 没有这份白名单, 模型写的 HTML 里任何 CDN 脚本/字体/样式都会被静默拦截。

### 单文件外壳的生成与加载

外壳本身是一个 React 应用(`create-app.tsx` + `create-app.html` 入口), 构建期由 `vite` + `vite-plugin-singlefile` 打成**一个自包含 HTML**(`dist/create-app.html`), 样式是 Tailwind + daisyUI(`global.css` 里 `@import "tailwindcss"` + `@plugin "daisyui"`)。构建顺序有讲究: `tsup` 先跑并 `clean` 掉 `dist/`, 所以 vite 的 `emptyOutDir` 必须为 `false`, 否则会抹掉 `tsup` 的产物。运行时 `readAppHtml()` 优先读 `import.meta.url` 的兄弟路径(打包产物 `dist/main.js` 旁就是 `dist/create-app.html`), 否则回退 `../../../dist/create-app.html`(源码布局); 外壳缺失时工具返回可读错误并提示 `pnpm build:app`。

### 外壳的运行时行为

外壳通过 `PostMessageTransport`(指向 `window.parent`)与宿主建立 `App` 连接(`new App({ name: "yukino create_app", version: "1.0.0" }, {}, { autoResize: false })`), 监听一串事件驱动一个 waiting/streaming/ready/failed 的 `RenderState` 状态机:

| 事件                 | 处理                                                                                                                                                             |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `toolinputpartial`   | 流式生成中, 显示已产出字节数(streaming)                                                                                                                          |
| `toolinput`          | 入参完整, 拿到 `html`/`title` 即渲染(ready), 并把入参存入 ref 备用                                                                                               |
| `toolresult`         | `isError` 则 failed; 否则经 `resolveAppDocument` 取 HTML, 取不到则 failed                                                                                        |
| `hostcontextchanged` | `applyDocumentTheme`(把宿主主题写到根元素 `data-theme` 与 `color-scheme`, daisyUI 靠它切换)、`applyHostStyleVariables`、`applyHostFonts`, 并同步宿主容器高度约束 |
| `toolcancelled`      | 置为 failed 并提示应用创建已取消                                                                                                                                 |

`toolresult` 的取值逻辑抽在 `resolve-app.ts`: HTML 依次取自结果 `_meta`、`structuredContent`、已经送达的 tool-input 参数(宿主可能丢掉工具结果里的 `_meta`); 每个字段都用带 `.catch(undefined)` 的 zod schema 解析, 类型不对或空字符串视为缺失, 避免一个坏字段拖垮整份结果。连接成功后调用 `setupSizeChangedNotifications()` 并按当前 host context 应用一次主题样式; 连接失败则渲染错误提示。顶部导航条用一个 `StatusChip` 反映 connecting/waiting/streaming/ready/failed 诸态。

高度自适应是外壳自己实现的(`frame-size.ts`): 渲染前 `withHeightReporter` 会在用户 HTML 的 `<head>` 之后(没有 head 则置于最前)注入一段带 `data-yukino-height-reporter` 标记的脚本, 它在 `load` 与 `ResizeObserver` 回调里测量 `body.offsetHeight`, 经 rAF 节流后向父窗口 `postMessage` `{source: "yukino-create-app", height}`; 外壳用 zod 校验消息后按 `resolveFrameHeight` 更新 iframe 高度——取内容高度与"宿主最大高度 − 导航条高度"的较小值, 宿主高度来自 `containerDimensions`(固定 `height` 优先于 `maxHeight`, 缺省 800), iframe 初始高度 480。真正渲染用户 HTML 的是一个 `sandbox="allow-scripts allow-forms allow-modals allow-popups"` 的 iframe, 用 `srcDoc` 注入——**没有 storage、没有 cookie、无法访问宿主**, 这是"让模型代码在对话里跑"的安全底座。

## github_tool: 任意 gh 命令

一个工具覆盖全部 GitHub CLI 能力: 仓库、issue、PR/评审/合并、Actions、release、projects, 以及经 `gh api` 的任意 REST/GraphQL。入参 `args` 是**不带前导 `gh` 的参数数组**, 每个元素原样透传、不经 shell 解析, 因此没有命令白名单也没有确认步骤; 另有可选 `cwd`(选本地仓库)、`stdin`(喂给 `--input -`/`--body-file -`)、`timeout_ms`(默认 60000)与 `response_format`(`text`/`base64`, 后者保留二进制下载)。

执行层 `runner.ts` 的 `runGh` 用 `spawn("gh", args)` 直接拉起进程(`stdio: "pipe"`, 启动前先 `throwIfAborted`), 在非 Windows 上以 `detached` 建独立进程组: 超时或 MCP 取消(`extra.mcpReq.signal` abort)时 `kill(-pid, SIGKILL)` 端掉整组再回退到单进程 kill, 因为 gh 别名/扩展可能派生继承管道的子进程。返回 `stdout`(Buffer)、`stderr`、`exit_code`、`signal`、`timed_out`、`cancelled`; 非零退出、超时或取消都置 `isError: true` 但保留部分输出, stdout 按 `response_format` 解码为 utf8 或 base64。`ghEnvironment()` 负责鉴权与环境: 在继承 `process.env` 的基础上强制 `GH_PROMPT_DISABLED=1`、`GH_PAGER=cat`(禁交互与分页器); 从 `GH_HOST` 或回退 `GITHUB_BASE_URL` 的主机名推导 Enterprise host(`api.github.com` 归一为 `github.com`); 配置了 token 时, host 既非 `github.com`/`api.github.com` 也不以 `.ghe.com` 结尾才注入 `GH_ENTERPRISE_TOKEN`(且仅在环境里没有 `GH_ENTERPRISE_TOKEN`/`GITHUB_ENTERPRISE_TOKEN` 时), 否则注入 `GH_TOKEN`(同样不覆盖已有值)。`gh` 不在 PATH(`ENOENT`)时返回安装/鉴权提示, 且**从不阻止服务器启动**。

## 数据与可观测工具面

十一个后端工具按实现方式分为四层, 但共享 `operations/shared.ts` 的同一套行为约定:

- `unrestrictedAnnotations`: `readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true`——如实告诉宿主"这会改数据、不可假定幂等"。
- `operationResult`: 统一序列化, `JSON.stringify` 的 replacer 把 `bigint` 转字符串、`Error` 转 `{name, message}`、`Map`/`Set` 转普通结构, 且 `structuredContent` 由同一份 JSON 反解析而来, 保证文本结果与结构化结果一致; 后端返回非 2xx/非零码时置 `isError: true` 但保留完整响应体。
- `operationError`: 工具级异常统一翻译成 `<tool> failed: <message>` 错误结果。
- 未配置的后端在**被调用时**才报配置错误(`requireConnection` 或工具内同等的内联检查, 指明该设哪个环境变量; `kafka_tool` 例外, brokers 未配置时直接回落 `localhost:9092`), 从不影响启动; 每个工具都接受逐调用的连接覆盖参数(`connection_url`/`base_url`/`endpoint`/`brokers` 等)。

### SQL 层: postgres_tool / mysql_tool / clickhouse_tool

`postgres_tool` 与 `mysql_tool` 共享 `sqlInputSchema`(`connection_url` 可选覆盖 + `sql` + `params` 默认 `[]`)与 `requireConnection`, 每次调用新建专用连接、结束即关, 会话状态不跨调用保留。

| 工具              | 驱动/协议         | 入参要点                                                                                            | 输出                                                                             |
| ----------------- | ----------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `postgres_tool`   | `pg` Client       | `$1/$2` 占位; 多语句需 `params` 为空; 连接超时 10 秒                                                | 每条语句的 `command`/`row_count`/`rows`/`fields`(字段仅 `name` + `data_type_id`) |
| `mysql_tool`      | `mysql2/promise`  | `?` 占位; `multipleStatements`/`supportBigNumbers`/`bigNumberStrings` 开启; 连接超时 10 秒          | 驱动 `results` + 规范化 `fields`                                                 |
| `clickhouse_tool` | HTTP 接口 `fetch` | `params` 映射 `param_<name>` 设置; `settings` 直传查询参数; `format` 即 `default_format`, 默认 JSON | `{status_code, format, data}`; JSON 族格式(`/^JSON/i`)输出自动解析               |

两处值得展开的细节:

- MySQL 的 `fields` 经 `normalizeFields` 只发布协议元数据——`catalog/schema/name/orgName/table/orgTable/characterSet/columnLength/type/flags/decimals`(其中 `type` 取 `columnType ?? type`), 而不是 mysql2 私有的 `FieldPacket`(内部带协议缓冲区与偏移量)。
- ClickHouse 的凭据**只走单一通道**: 传了 `api_key` 就发 `x-clickhouse-key`(另有 user 时附 `x-clickhouse-user`), 否则用 HTTP basic 头; 绝不与查询串里的 `user` 参数并存——ClickHouse 会因双通道凭据直接 `AUTHENTICATION_FAILED`。`INSERT ... FORMAT <fmt>` 的数据经 `data`/`data_base64` 放请求体, SQL 移入 `query` 参数; 另有 `database`/`user`/`password`/`headers`/`stacktrace` 等逐调用覆盖, `timeout_ms` 默认 30000。

### 协议驱动层: redis_tool / mongodb_tool

`redis_tool` 与 `mongodb_tool` 直接用官方驱动, 每次调用新开专用连接、结束即关, 与文档索引(SQLite)完全无关。

| 工具           | 驱动      | 入参要点                                                                                                                                                           | 输出                                                                    |
| -------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| `redis_tool`   | `redis`   | `commands` 为参数数组的数组, 单连接顺序执行(支持 `SELECT`/`MULTI`/`EXEC` 等状态性操作); `connectTimeout` 10 秒且 `reconnectStrategy: false`                        | 有序 `results`; 首个失败即停并给 `failed_command_index`, 保留已完成回复 |
| `mongodb_tool` | `mongodb` | 原始 `command` 文档(zod refine 拒绝空文档), Extended JSON 表达 BSON; `database:"admin"` 做管理(默认取 `MONGODB_DATABASE` 或 URL); `serverSelectionTimeoutMS` 10 秒 | `data` 为 canonical Extended JSON, 保留 ObjectId/时间戳/游标批次        |

两个细节: Redis 的 `EXEC` 可能整体成功而队列中个别命令返回错误, 故 `hasReplyError` 递归检查回复(含嵌套数组)里的 `Error`; 连接在 `finally` 中 `destroy()`。MongoDB 用 `BSON.EJSON.deserialize/serialize`(均 `relaxed: false`)在 Extended JSON 与 BSON 间无损往返。

### HTTP 透传层: prometheus_tool / grafana_tool / etcd_tool / milvus_tool

`operations/http.ts` 提供"鉴权 HTTP 透传"的共享管道, Prometheus 与 Grafana 直接复用它: `buildHttpPassthroughSchema` 生成统一入参(`base_url` 覆盖、`path`(各工具自带默认路径, 可为绝对 URL)、`method` 七种默认 GET、`params`(字符串/数字/布尔或数组, 数组值重复键, 支持 `match[]` 这类参数)、`body`(非字符串 JSON 自动设 `content-type: application/json` 并序列化, 字符串原样发送)、`headers`(可覆盖鉴权)、`timeout_ms` 默认 30000); `runHttpPassthrough` 负责解析基址(基址缺失且 path 非绝对 URL 时报配置错误)、注入 bearer/basic 认证、发请求、尝试 JSON 解析响应, 并经 `isApiError` 钩子标记带内错误。两个工具都**没有端点白名单**, 能调什么取决于服务端 RBAC 与账号权限; 反向代理路径前缀原样保留。

| 工具              | 默认路径                        | 鉴权                                                                             | 特有行为                                                                                         |
| ----------------- | ------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `prometheus_tool` | `/api/v1/alerts`                | bearer(`PROMETHEUS_TOKEN`)或 basic                                               | 响应 `status: "error"` 置 `isError`                                                              |
| `grafana_tool`    | `/api/health`                   | bearer(service-account token/API key)或 basic                                    | 覆盖 dashboard/folder/datasource/`ds/query`/告警/管理 API, 支持 `X-Grafana-Org-Id` 等自定义头    |
| `etcd_tool`       | `/v3/kv/range`                  | 调用方先 `/v3/auth/authenticate` 拿 token, 经 `headers.authorization` 传入       | 自动 base64 编解码(见下), 不支持流式端点(`/v3/watch`、`/v3/maintenance/snapshot`)                |
| `milvus_tool`     | `/v2/vectordb/collections/list` | Bearer(逐调用 `token` 或配置的 `MILVUS_TOKEN`/`MILVUS_USERNAME:MILVUS_PASSWORD`) | `database` 注入 body 的 `dbName`(已存在则不覆盖); Milvus `code` 非 0 或 HTTP 非 2xx 置 `isError` |

etcd 的 v3 JSON 网关把 proto3 `bytes` 字段映射为 base64 字符串, 直接传 `"mykey"` 这类明文要么被拒绝、要么被静默按 base64 解码成无关字节。`etcd/codec.ts` 因此做双向翻译: `encodeRequestBytes` 递归把请求体里 `key`/`range_end`/`value` 字段的 UTF-8 字符串编成 base64 上线(已是合法 base64 的字符串也按其 UTF-8 字节重编码, 想原样收发请用 `raw_base64`); `decodeResponseBytes` 把响应里这三类字段用严格 UTF-8(`TextDecoder` fatal)解回字符串, 解不出的二进制值保留 base64 原样; 合法性判定用 base64 往返相等。配置侧 `normalizeEtcdUrl` 容忍 `ETCD_ENDPOINTS` 的逗号分隔多端点列表, 取第一项并在无协议时补 `http://`。

Milvus 的 RESTful API v2 与 gRPC 共用同一端口(默认 19530), 所以 `MILVUS_URL` 直接指向 gRPC 端口即可; 9091 上的健康/指标端点可用绝对 `base_url` 访问。请求头固定 `content-type`/`accept` 均为 `application/json`, GET 不带 body。

### 对象存储: minio_tool(S3 协议)

`minio_tool` 不用任何 SDK, 而是手写 **AWS Signature V4 path-style** 签名(`minio/s3.ts`): RFC 3986 逐段编码桶与对象键(保留 `/`, 另转义 `!'()*`), 查询参数按键再按值排序编码, 规范化请求串依次是方法、URI、查询、小写化并压缩空白后的签名头(`host`、`x-amz-content-sha256`、`x-amz-date`, 有会话令牌时加 `x-amz-security-token`)与载荷哈希, 再派生 `AWS4 + secret → 日期 → 区域 → s3 → aws4_request` 签名密钥链。载荷哈希支持 `unsigned_payload`(以 `UNSIGNED-PAYLOAD` 签名代替内容哈希)与空体的预计算哈希。入参面向"任意 S3 REST 操作": `method`(GET/PUT/POST/DELETE/HEAD/PATCH)、`bucket`、`key`、`query`(子资源参数, 无值子资源如 `location`/`uploads`/`delete` 传空串, 值可为数组)、`headers`、三种请求体来源(`body_path` 本地文件直读优先, 其次 `body_base64`, 最后 `body` UTF-8 字符串); GET/HEAD 或空载荷不发 body。

响应侧: 返回 `status_code`/`headers`/`size`; `response_format` 四态——`auto` 按 content-type 判定文本(`text/*` 与 xml/json/javascript/html/x-www-form-urlencoded 等子类型, 无 content-type 时按 UTF-8 严格解码试探)返回 `body`、否则 base64; `text`/`base64` 强制; `none` 不内联。内联上限 `max_bytes`(默认 1,000,000)超出截断并置 `truncated`; 给 `save_path` 则全量落盘并回 `saved_to`/`saved_bytes`。文本体即使落盘也始终内联, 二进制体只在显式要求 base64 或无 `save_path` 兜底时才内联。非 2xx 保留响应体并置 `isError`。

一个精妙的兼容点: `fetch` 的 URL 解析器会**移除路径中的点段**(`.`/`..`), 而 S3 对象键完全可能含点段——那会改变被签名的路径。`minio/http.ts` 的 `fetchS3` 检测到路径含点段时改走 Node 原生 `http`/`https` 的 `request` 并单独传 `path`, 保证发出的路径与签名逐字节一致(响应再包回 `Response`, HEAD/204/205/304 不带 body)。

### 消息队列: kafka_tool(@platformatic/kafka)

`kafka_tool` 基于 `@platformatic/kafka`(纯 TypeScript 的 Kafka 协议客户端, 非 kafkajs/librdkafka, 无需原生构建), 通过 `operation` 枚举暴露十个操作, 结果统一为 `{operation, data}`:

| 操作                | 说明                                                                                                                 |
| ------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `produce`           | 发消息; 任一消息指定 `partition` 时先查元数据校验分区存在; `value: null` 写 tombstone; 支持 `timestamp` 与 `headers` |
| `consume`           | 按 `topics` 订阅消费, 或按 `assignments` 显式分区直取(不加入消费组)                                                  |
| `list_topics`       | 含内部主题的全量列表(排序)                                                                                           |
| `describe_topics`   | 分区 `id`、leader、replicas 与 ISR(可按 `topic` 过滤)                                                                |
| `describe_cluster`  | broker 列表、`controller_id`、`cluster_id`                                                                           |
| `create_topic`      | `num_partitions`/`replication_factor`(均默认 1)/`topic_config`(topic 级配置, 如 `retention.ms`)                      |
| `delete_topic`      | 删除主题                                                                                                             |
| `create_partitions` | 扩分区至 `num_partitions` 目标总数                                                                                   |
| `watermark_offsets` | 每分区低/高水位(并行两次 `listOffsets`, 时间戳 `-2`/`-1`; 可用 `partitions` 限定分区)                                |
| `committed_offsets` | 消费组已提交位点(需 `group_id` + `partitions`); 组不存在(`GROUP_ID_NOT_FOUND`)或无提交记录返回哨兵值 `-1001`         |

连接配置由 `buildConfig` 裁决: 拒绝任何含 `.` 的遗留 librdkafka 风格配置键(直接报错要求用 `@platformatic/kafka` 的 camelCase 客户端选项, 如嵌套 `sasl`/`tls`, 经入参 `config` 透传); `KAFKA_SECURITY_PROTOCOL` 大写后限定 `PLAINTEXT`/`SSL`/`SASL_PLAINTEXT`/`SASL_SSL` 四种取值, `SSL`/`SASL_SSL` 启用 `tls: {}` 与 `tlsServerName`; 出现用户名、SASL 机制或 SASL 协议即装配 SASL(机制默认 `PLAIN`); broker 列表按逗号切分并拒绝空项; `retries: 0`、`strict: true`, 并把 `timeout_ms` 同时灌给 `timeout`/`requestTimeout`/`connectTimeout`。broker 的缺省值在工具层回落: 逐调用 `brokers` → `KAFKA_BROKERS` → `localhost:9092`; client id 缺省 `yukino-mcp`。

消费语义: 订阅模式用 `MessagesStreamModes.COMMITTED` 加回退模式(`from_beginning` 决定 `EARLIEST`/`LATEST`), 消费组 id 缺省为 `yukino-mcp-<uuid>`; 从流上收集至多 `max_messages`(默认 50)条或耗尽 `timeout_ms`(默认 15000)时间窗后暂停流并断开; `auto_commit` 时只提交本次实际返回的分区位点(offset + 1, 带 leader epoch)。显式 `assignments` 模式**不加入消费组**, 直接发 Fetch 请求: 起始位点按"显式 offset > 组内已提交位点(≥0)> 按时间戳查水位"三级解析, 逐批跳过控制批次(`IS_CONTROL`), 每分区 `partitionMaxBytes` 与请求 `maxBytes` 均为 1048576, 提交则走 `admin.alterConsumerGroupOffsets`。bigint 位点经 `jsonInteger` 安全落为 number(超出安全整数转十进制字符串); 消息键值按 `encoding`(`utf8` 默认/`base64`)解码。每次调用新建 Producer/Consumer/Admin, `finally` 中全部关闭。

## 配置体系

配置由 `shared/config.ts` 用一个 zod `EnvSchema` 统一解析。两个细节体现"降级优先于崩溃": `dropEmptyValues` 把空字符串视作未设置(占位用的空 env 不会掩盖默认值); `PORT` 用 `.catch(3300)` 兜底, 环境里写了非法端口也退回默认而非让 stdio 服务器启动即挂。嵌入配置由 `resolveEmbedding` 单独裁决: 只实现 `openai` 协议(其他值直接带原因失败), 缺失 `EMBEDDING_MODEL`/`EMBEDDING_BASE_URL`/`EMBEDDING_API_KEY`(可回退 `OPENAI_API_KEY`)也返回带原因的 `ok: false`, 让 `docs` 工具优雅降级而非抛配置解析错。所有基址类配置统一去尾部斜杠。

| 变量                                                                                                                           | 用途                                                                                                                                                                                                                          | 默认                     |
| ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| `EMBEDDING_PROTOCOL`                                                                                                           | 嵌入协议, 仅实现 `openai`(OpenAI 兼容); 其他值使 `docs` 工具降级                                                                                                                                                              | `openai`                 |
| `EMBEDDING_MODEL` / `EMBEDDING_BASE_URL` / `EMBEDDING_API_KEY`                                                                 | 嵌入模型、OpenAI 兼容端点、密钥(可回退 `OPENAI_API_KEY`)                                                                                                                                                                      | —                        |
| `YUKINO_DOCS_DIR`                                                                                                              | 知识库目录                                                                                                                                                                                                                    | `~/.yukino/docs`         |
| `YUKINO_INDEX_DB`                                                                                                              | 向量索引 SQLite 文件(可删以强制全量重嵌)                                                                                                                                                                                      | `~/.yukino/index.sqlite` |
| `POSTGRES_URL`                                                                                                                 | PostgreSQL 连接(回退 `POSTGRESQL_URL` → `DATABASE_URL`)                                                                                                                                                                       | —                        |
| `MYSQL_URL` / `MONGODB_URL` / `MONGODB_DATABASE`                                                                               | MySQL / MongoDB 连接与默认库                                                                                                                                                                                                  | —                        |
| `REDIS_URL`                                                                                                                    | 仅 `redis_tool` 使用                                                                                                                                                                                                          | `redis://localhost:6379` |
| `CLICKHOUSE_URL` / `CLICKHOUSE_USER` / `CLICKHOUSE_PASSWORD` / `CLICKHOUSE_DATABASE`                                           | ClickHouse HTTP 接口地址(回退 `CLICKHOUSE_HTTP_URL`)、凭据与默认库                                                                                                                                                            | —                        |
| `ETCD_URL`(回退 `ETCD_ENDPOINTS`)                                                                                              | etcd v3 JSON 网关地址; 逗号列表取第一项, 无协议补 `http://`                                                                                                                                                                   | —                        |
| `MILVUS_URL`(回退 `MILVUS_ADDRESS`)                                                                                            | Milvus REST/gRPC 共用地址; `MILVUS_TOKEN` 或 `MILVUS_USERNAME`:`MILVUS_PASSWORD` 合成凭据; `MILVUS_DATABASE` 为默认库                                                                                                         | —                        |
| `KAFKA_BROKERS` / `KAFKA_CLIENT_ID` / `KAFKA_USERNAME` / `KAFKA_PASSWORD` / `KAFKA_SASL_MECHANISM` / `KAFKA_SECURITY_PROTOCOL` | Kafka broker 列表与 SASL/TLS 配置(broker 缺省值在 `kafka_tool` 层回落 `localhost:9092`)                                                                                                                                       | client id `yukino-mcp`   |
| `PROMETHEUS_BASE_URL`                                                                                                          | Prometheus 基址(回退 `PROMETHEUS_URL`), 另有 `PROMETHEUS_TOKEN`/`PROMETHEUS_USERNAME`/`PROMETHEUS_PASSWORD`                                                                                                                   | —                        |
| `GRAFANA_BASE_URL`                                                                                                             | Grafana 基址(回退 `GRAFANA_URL`); bearer 用 `GRAFANA_TOKEN`(回退 `GRAFANA_API_KEY`), 或 `GRAFANA_USERNAME`/`GRAFANA_PASSWORD` basic                                                                                           | —                        |
| `MINIO_URL`(回退 `S3_ENDPOINT`)                                                                                                | S3 端点; `MINIO_ACCESS_KEY`/`MINIO_SECRET_KEY`(回退 `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`); `MINIO_REGION`(回退 `AWS_REGION` → `AWS_DEFAULT_REGION`, 默认 `us-east-1`); `MINIO_SESSION_TOKEN`(回退 `AWS_SESSION_TOKEN`) | —                        |
| `GITHUB_TOKEN` / `GH_TOKEN` / `GH_HOST` / `GITHUB_BASE_URL`                                                                    | gh 鉴权与 Enterprise 主机(token 取 `GITHUB_TOKEN` 优先 `GH_TOKEN`; `GITHUB_BASE_URL` 在 `GH_HOST` 缺失时提供主机名)                                                                                                           | —                        |
| `HOST` / `PORT`                                                                                                                | HTTP 传输绑定地址/端口(仅 `--http`)                                                                                                                                                                                           | `127.0.0.1` / `3300`     |

除文档索引外, 每个数据工具都接受**逐调用的连接覆盖**, 因此同一进程可在多个后端间切换, 无需重启。`.env.example` 给出全部可选后端的注释模板, 提示取消注释并与自己的 docker-compose 端口对齐。

## 构建、打包与分发

服务器有**两条并行的构建产物**, 由 `pnpm build`(= `tsup && vite build`)一次产出, 二者对 `dist/` 的写入顺序被刻意编排:

- **`tsup` 打服务端**: 入口 `src/main.ts`, 输出 ESM、`platform: node`、`target: node24`、`clean: true`(先清空 `dist/`)。两个非默认配置是关键: `removeNodeProtocol: false` 保留 `node:` 前缀——tsup 默认会剥掉它, 对 `fs`/`path` 无妨(Node 也能裸解析), 但 `sqlite` 是**前缀专属内建模块**, 剥前缀后 `import ... from "sqlite"` 会在启动时 `ERR_MODULE_NOT_FOUND`; banner 注入 shebang 与一段 `createRequire` 垫片, 因为被打进 bundle 的 CJS 依赖(如 `dotenv`)会动态 `require()`, ESM 产物里没有 `require` 会抛 "Dynamic require of ... is not supported"。版本号也在此从 `package.json` 读出并经 `define` 注入 `__YUKINO_MCP_VERSION__`。
- **`vite` 打 UI 外壳**: `root` 指向 `src/tools/create-app`, 入口 `create-app.html`, 插件为 react + tailwindcss + `viteSingleFile`; 因为 tsup 已经 `clean` 过 `dist/`, vite 的 `emptyOutDir` 必须为 `false`, 否则会抹掉刚产出的 `main.js`。最终把 React 外壳连同样式内联成单个 `dist/create-app.html`。

`package.json` 只发布 `dist/`, 并声明 `bin.yukino-mcp → dist/main.js`, 因此 `npx`/全局安装后可直接作为 MCP 服务器命令启动。开发态 `pnpm dev` 先 `build:app`(= `vite build`)再跑 `tsx ./src/main.ts`; `pnpm test` 同样先构建 UI(`create_app` 的用例依赖 `dist/create-app.html` 存在)再跑 vitest; `pnpm happy` 串联 typecheck、lint、build 与 test。测试通过 `@modelcontextprotocol/client` 的 `Client` 与 `InMemoryTransport` 连接真实 `createServer()` 产物做端到端断言, 工具集与入参 schema 因此可被机器校验。

## 适用场景与边界

**适合**: 给 Yukino CLI 或任意 MCP 宿主一次性接入"本地文档 RAG + 结果可视化 + GitHub 操作 + 多数据库/中间件直连"的复合能力; 需要在对话内交付可交互 HTML 应用(图表、仪表盘、演示)的场景; 希望以完整权限让 Agent 直接操作开发/测试环境数据库、对象存储、消息队列与可观测栈的运维/排障流程。

**边界与注意**:

- 数据类工具**无白名单、无只读模式、无确认步骤**, 权限等于连接账号的权限; 生产库应使用最小权限账号, 或干脆不配置对应环境变量。
- HTTP 端点**不鉴权**, 默认只绑 localhost; 仅在可信网络开启, 否则任何能访问该端口的人都能调用全部工具。
- 文档 RAG 依赖外部 OpenAI 兼容嵌入端点, 未配置时 `docs_tool`/`docs_sync` 降级为诚实报错(30 秒后自动重试初始化), 其余工具不受影响。
- 需要 Node.js ≥ 24.6.0(`node:sqlite`); `create_app` 的 UI 外壳需先 `build:app` 生成 `dist/create-app.html`, 且只在支持 MCP Apps 的宿主里可视化。
- 每次数据库调用新建并关闭连接, 不维持连接池与会话状态; 需要事务或会话相关语句序列时, 应放进**同一次调用**(Redis 的 `SELECT`/`MULTI`/`EXEC` 同理)。Kafka 消费是"有界轮询窗口"(`max_messages` + `timeout_ms`), 不是常驻消费者。
- etcd 的流式端点(`/v3/watch`、`/v3/maintenance/snapshot`)与 Kafka 的遗留 librdkafka 风格配置键被明确拒绝, 属于协议透传的边界外。
