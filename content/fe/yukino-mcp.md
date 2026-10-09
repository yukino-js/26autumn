---
title: "Yukino 官方 MCP: 一个进程内的工具集合服务器"
description: "把本地 RAG 文档检索、MCP Apps 交互式 UI、gh CLI 与 PostgreSQL/MySQL/Redis/MongoDB/Prometheus 五类数据后端收敛成 9 个 MCP 工具, 用 stdio 与 HTTP 双传输对外暴露, 并以进程级单例承载连接与向量索引。"
local_path: "$HOME/github/yukino-code/apps/mcp"
---

本文拆解 Yukino 官方 MCP 服务器: 它把一组彼此独立的能力——本地知识库的语义检索、可交互的单文件 HTML 应用、任意 `gh` 命令、以及五种数据/可观测后端——统一封装成 MCP 工具, 通过 stdio 或 HTTP 暴露给 Yukino CLI 及任何 MCP 宿主。内容以功能、实现思路与适用场景为主线, 覆盖传输层、工具模块契约、RAG 检索链路、MCP Apps UI 生成、数据库工具面与配置体系。适合正在搭建 MCP 服务器、关心工具注册与进程内状态管理的工程师阅读。

## 定位与解决的问题

MCP(Model Context Protocol)让宿主(如 Yukino CLI)以统一协议发现并调用外部工具。这个服务器的定位是"官方工具集合": 不做单一功能, 而是把一批高频、彼此正交的能力打包进同一个进程, 用一份配置、一次启动对外提供。它解决三类问题:

- **给 Agent 一个本地知识库入口**: 把 `~/.yukino/docs` 下的 Markdown/文本文档做向量化, 提供语义检索(`docs_tool`)与增量同步(`docs_sync`), 让模型能查到项目/团队私有文档, 而不必把全部内容塞进上下文。
- **给 Agent 一个"渲染结果"的出口**: 通过 MCP Apps 扩展, 让模型产出一段自包含 HTML, 在对话内以沙箱 iframe 呈现为可交互应用(`create_app`), 用于图表、仪表盘、计算器、可视化演示。
- **给 Agent 一组"直连后端"的手**: 一个 `github_tool` 覆盖全部 `gh` 子命令; 五个数据工具(`postgres_tool`/`mysql_tool`/`redis_tool`/`mongodb_tool`/`prometheus_tool`)以"无限制、原样透传"的方式执行 SQL、Redis 命令、MongoDB 命令与 Prometheus HTTP 调用。

### 能力边界

服务器共暴露 **9 个工具**, 由 **8 个模块**注册(`docs` 模块同时注册 `docs_tool` 与 `docs_sync`)。设计上有两条鲜明取舍: 其一, 数据类工具**不做任何白名单或只读模式**, 以连接账号的完整权限原样执行, 把安全边界交给"连的是哪个库、用什么账号"; 其二, 除文档向量索引使用内置 `node:sqlite` 外, **不引入任何常驻外部服务**, 每次数据库调用都新建并在结束后关闭连接。

| 维度       | 选型                                                                                                           |
| ---------- | -------------------------------------------------------------------------------------------------------------- |
| 协议       | `@modelcontextprotocol/sdk`(McpServer) + `@modelcontextprotocol/ext-apps`(MCP Apps)                            |
| 传输       | stdio(默认) / HTTP(Streamable HTTP + 传统 SSE), 由 `--http` 或 `MCP_TRANSPORT=http` 切换                       |
| HTTP 框架  | `h3`(H3 + `serve`), SSE 走 `fromNodeHandler` 桥接 Node 原生响应                                                |
| 参数校验   | `zod`(工具入参 schema 与环境变量 schema 共用)                                                                  |
| RAG        | `ai` + `@ai-sdk/openai-compatible` 生成向量, `@langchain/textsplitters` 做 Markdown 分块, `node:sqlite` 存索引 |
| 数据后端   | `pg` / `mysql2` / `redis` / `mongodb` 官方驱动 + `fetch`(Prometheus)                                           |
| 子进程     | `node:child_process.spawn` 直接拉起 `gh`                                                                       |
| UI 构建    | `vite` + `@vitejs/plugin-react` + `@tailwindcss/vite` + `vite-plugin-singlefile`(daisyUI)                      |
| 服务端打包 | `tsup`(ESM, target node24)                                                                                     |
| 日志       | `pino`, 只写 stderr                                                                                            |
| 运行时     | Node.js ≥ 24(`node:sqlite` 为前缀专属内建模块)                                                                 |

## 架构总览

```text
   stdin/stdout(JSON-RPC)          HTTP(:3300)
        │                              │
        ▼                              ▼
   StdioServerTransport      ┌──────────────────────┐
        │                    │  h3 app               │
        │                    │  POST /mcp  (无状态)  │
        │                    │  GET  /sse + POST      │
        │                    │       /messages (SSE)  │
        │                    └───────────┬───────────┘
        ▼                                ▼
   ┌──────────────────────────────────────────────────┐
   │  createServer(): new McpServer + INSTRUCTIONS      │
   │  for (module of modules) module.register(server)   │
   └───────────────────────┬──────────────────────────┘
                           │  8 个 ToolModule
   ┌───────────┬───────────┼────────────┬──────────────┐
   ▼           ▼           ▼            ▼              ▼
create_app   docs       github      postgres/mysql   redis/mongodb
(Apps UI)  (docs_tool   (gh CLI)      (SQL)          /prometheus
           +docs_sync)                                (数据/可观测)
                           │
                           ▼  进程级单例(init/shutdown)
              SQLite 向量索引 · 嵌入 Provider · gh 环境
```

`main.ts` 是入口: 先选择传输, 建好 `McpServer` 并连接 transport, **之后**才 fire-and-forget 触发各模块的 `init()`。这个顺序是刻意的——传输先就绪, 工具立刻可被 `list`; 而真正的重活(打开索引、探测维度、后台同步文档)推迟到 init, 工具调用内部会 `await` 同一个 init Promise, 因此首个调用不会被大知识库拖到客户端超时。

## 工具模块契约与注册

所有模块实现同一个 `ToolModule` 接口, 把"每会话的注册"与"进程级的状态"清晰分开:

```ts
interface ToolModule {
  name: string; // 唯一, 用于日志与去重
  register(server: McpServer): void; // 每个 server 实例调用一次
  init?(): Promise<void>; // transport 连接后触发, 工具调用 await 同一 Promise
  shutdown?(): Promise<void>; // 进程退出时清理连接/句柄
}
```

`register` 之所以可能被调用多次, 是因为 HTTP 传输会为每个请求/会话新建一个 `McpServer`(见下文), 而 `init`/`shutdown` 管理的是**进程级单例**(数据库句柄、向量缓存、嵌入 Provider)。`server.ts` 在模块加载时先跑一次 `assertUniqueModuleNames()`: 因为 `registerTool` 遇到重名会抛错, 在"每请求一个 server"的 HTTP 模式下这会变成运行时 500, 所以宁可启动即失败。

工具名集中维护在 `names.ts`, 约定 snake_case 且至少两个词, 单词工具用 `_tool` 后缀(`docs_tool`/`github_tool`), 复合名保持不变(`create_app`/`docs_sync`)。`createServer()` 还会把一段 `INSTRUCTIONS` 传给 `McpServer`——它在 `initialize` 时下发给宿主, Yukino 会注入模型上下文, 用于改善工具选择(告诉模型何时该查文档、何时该渲染 App、各数据工具的用途与连接方式)。版本号由 `version.ts` 解析: 构建期 `tsup` 通过 `define` 注入 `__YUKINO_MCP_VERSION__`, 开发态(`tsx`)则回退到向上查找 `package.json`。

## 双传输层

### stdio(默认)

stdio 模式下 **stdout 完全归 JSON-RPC 帧所有**, 因此 `pino` 被显式定向到 fd 2(stderr), 任何杂散的 stdout 写入都会破坏协议流。SDK 的 transport 不会在 stdin EOF 时自动关闭, 所以入口直接监听 `process.stdin` 的 `end`/`close` 与 `server.server.onclose`, 触发统一的 `shutdown`。`shutdown` 是幂等的: 先关传输, 再逐个 `await module.shutdown?.()`, 并挂一个 `unref()` 的 5 秒兜底定时器——任何卡死的传输或模块都不能让进程吊住不退出。

### HTTP(`--http`)

HTTP 模式用 `h3` 在**同一个端口**上暴露两种远程传输:

| 端点                                     | 传输                                       | 语义                                                                      |
| ---------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------- |
| `POST /mcp`                              | `WebStandardStreamableHTTPServerTransport` | 无状态, 每请求新建 server + transport, `enableJsonResponse` 返回完整 JSON |
| `GET /mcp`                               | —                                          | 直接 405(无状态模式没有服务端主动通知流)                                  |
| `GET /sse` + `POST /messages?sessionId=` | `SSEServerTransport`(传统)                 | 每条 `GET /sse` 一个长连接, 消息按 `sessionId` 关联回投                   |

无状态 Streamable HTTP 的关键在于"每请求一对 server/transport, 用完即关": 因为工具模块状态都在进程级单例里, 新建实例很廉价, 无需会话簿记。传统 SSE 则用 `fromNodeHandler` 桥接——SDK 的 SSE transport 直接写 Node 原生 `ServerResponse`, 处理函数刻意"挂起"到流关闭才 resolve, 否则 h3 会在 Promise 一 resolve 就结束响应、把 SSE 流截断。`serve` 关闭了 srvx 自带的 `gracefulShutdown` 与日志(`silent: true`), 把关闭编排权交回 `main.ts`, 避免与信号处理竞争; `close()` 先关所有 SSE transport 再 `server.close(true)`, 否则长连接会让监听器永远关不掉。HTTP 端点**不做鉴权**, 默认绑定 `127.0.0.1`, 只适合本机或可信网络。

## docs_tool / docs_sync: 本地 RAG 检索

这是服务器里最完整的子系统, 一条 `扫描 → 分块 → 嵌入 → 索引 → 检索` 的流水线, 全部落在本地 SQLite 上, 不依赖任何外部向量库。

### 存储: node:sqlite 向量索引

索引是一个 SQLite 文件(`YUKINO_INDEX_DB`, 默认 `~/.yukino/index.sqlite`), 通过 `node:sqlite` 的 `DatabaseSync` 打开。`node:sqlite` 用 `createRequire` **懒加载**而非静态 import: ESM 会在任何模块体执行前先求值 import, 静态引入会抢在 `quiet-sqlite-warning.ts` 安装过滤器之前拉起实验性模块, 导致每次调用都打印 `ExperimentalWarning`(该 warning 过滤器必须是入口的第一个 import)。打开时设 `journal_mode=WAL`(后台同步不阻塞读)与 `synchronous=NORMAL`, 并给 5 秒 busy timeout。三张表:

| 表        | 作用                                                             |
| --------- | ---------------------------------------------------------------- |
| `meta`    | 键值对, 存 `schema_version` 与向量维度 `dim`                     |
| `sources` | `source → 内容 sha256`, 增量同步的判据                           |
| `chunks`  | 分块正文、metadata(JSON)、创建时间与 `vector` BLOB(Float32 小端) |

索引被当作**可重建的缓存**: schema 版本变更或维度不匹配时直接 `DELETE` 全表重来, 而不做迁移。

### 分块与嵌入

分块用 LangChain 的 `RecursiveCharacterTextSplitter.fromLanguage("markdown")`, `chunkSize=1000`、`chunkOverlap=200`——远低于 8192 的存储上限与嵌入 Provider 的输入上限, 保证"被嵌入的文本"与"被存储的文本"完全一致。每个分块附带一个 section title: 取块内第一个 Markdown 标题, 或从更早的块继承最近标题(块按文档顺序到达)。嵌入走 `@ai-sdk/openai-compatible` 的 OpenAI 兼容端点, 单条用 `embed`、批量用 `embedMany`, 批量大小固定为 10(兼容端点常限制单次输入条数, SDK 默认的 2048 会触发 "batch size is invalid"), 每次调用带 20 秒超时与 1 次重试。

### 增量同步

`syncDocs` 扫描目录(`.md`/`.markdown`/`.txt`, 递归; 目录不存在是正常态, 返回空), 对每个文件算内容 sha256 与 `sources` 里记录的比对: 相同则跳过, 新增/变更则**先嵌入再原子替换**, 磁盘上已删除的文件从索引移除。原子性由 `BEGIN IMMEDIATE` 事务保证——它一上来就抢写锁, 并发写者会在此处以 `SQLITE_BUSY` 显现并被翻译成 `LockConflictError`(计为 skipped 而非 failed), 无需额外的分布式锁, 一个 `COMMIT` 就完成"全有或全无替换"。嵌入刻意放在拿写锁**之前**: Provider 失败时旧分块与旧 hash 都原封不动。分块 id 是确定性的 `sha256(source):序号`, 因此重复索引同一文件是幂等的 upsert。单文件失败只记录并跳过, 绝不中断整轮同步。

### 检索: 内存矩阵 + 点积

检索不用 SQLite 做向量运算, 而是把所有向量一次性载入一块连续的 `Float32Array` 行主序矩阵(`VectorCache`)。向量入库时已 L2 归一化, 于是余弦相似度退化为**纯点积**; 在个人知识库规模(数千分块)下全量扫描只需个位数毫秒, 远比往返外部索引划算。缓存失效靠 `PRAGMA data_version`: 它只在**其他连接**提交时递增, 因此本地写入必须显式 `invalidateCache`, 而兄弟进程在背后重建索引则能被 data_version 变化捕捉到。Top-K 用单趟扫描维护一个至多 K 个元素的有序数组; 分数按 `(1 + cosine) / 2` 映射回 `[0,1]`(1 为完全相同)。查询向量维度与缓存 `dim` 不符或缓存为空时直接返回空结果。

### 两阶段初始化与降级

`docs` 模块用一个进程级 `EngineState`(`ready` / `degraded`)单例, 初始化分两阶段:

- **快阶段(await)**: 配置检查 → 打开索引 → 维度探测 + schema 校验, 有 15 秒预算(客户端调用超时约 60 秒, 卡住的 Provider 必须提前降级)。完成后即可对既有数据查询。
- **后台阶段(fire-and-forget)**: 增量文档同步, 大知识库永不阻塞首个工具调用。

任何失败都**降级而非抛错**: 嵌入未配置、索引打不开、schema 初始化超时, 都返回带明确原因的 `degraded`, 工具调用据此回一句诚实的错误。降级状态有 30 秒重试窗口——Provider 可能在会话中途恢复, 无需重启 CLI。维度探测(`embedText("dimension probe")`)以模型实际输出为准, 从不取静态配置; 维度或 schema 不匹配就清库, 逼下次同步全量重嵌入。`docs_sync` 无参, 会 `await` 进行中的同步; 对空索引的首次搜索若仍在建索引, 会提示"调用 docs_sync 等待后重试"。`shutdown` 从不等待在途的 init/sync(CLI 约 4 秒后强杀), 只关已连接的句柄。

## create_app: MCP Apps 交互式 UI

`create_app` 让模型产出一段完整、自包含的 HTML(内联 CSS/JS), 在对话内渲染成可交互应用。它基于 `@modelcontextprotocol/ext-apps`, 注册**一对**东西:

- `registerAppTool(create_app)`: 入参 `html`(≤ 200000 字符)与 `title`, 工具**定义**在 `_meta.ui.resourceUri` 指向 UI 资源, 工具**结果**把完整 HTML 与标题放进 `_meta.html`/`_meta.title`(title 同时进 `structuredContent`); 宿主若无 MCP Apps 支持, 只看到一句文本回退说明。
- `registerAppResource(ui://create-app/create-app.html)`: 返回一个**沙箱外壳** HTML, MIME 用扩展约定的 `RESOURCE_MIME_TYPE`, 并在 `_meta.ui.csp.resourceDomains` 声明允许的 CDN 白名单(unpkg、jsdelivr、tailwindcss、cdnjs、esm.sh、Google Fonts)。因为外壳用同文档 `srcdoc` iframe 渲染用户 HTML, 会继承宿主对 app 资源的 CSP, 没有这份白名单, 模型写的 HTML 里任何 CDN 脚本/字体/样式都会被静默拦截。

### 单文件外壳的生成与加载

外壳本身是一个 React 应用(`create-app.tsx`), 构建期由 `vite` + `vite-plugin-singlefile` 打成**一个自包含 HTML**(`dist/create-app.html`), 样式用 Tailwind + daisyUI。构建顺序有讲究: `tsup` 先跑并 `clean` 掉 `dist/`, 所以 vite 的 `emptyOutDir` 必须为 `false`, 否则会抹掉 `tsup` 的产物。运行时 `readAppHtml()` 从 `import.meta.url` 的兄弟路径(或回退到 `../../../dist/`)读取这个文件——同一份产物既服务 `dist/` 也服务源码布局。外壳缺失时工具返回可读错误并提示 `pnpm build:fe`。

### 外壳的运行时行为

外壳通过 `PostMessageTransport` 与宿主建立 `App` 连接, 监听一串事件驱动一个 `RenderState` 状态机:

| 事件                 | 处理                                                              |
| -------------------- | ----------------------------------------------------------------- |
| `toolinputpartial`   | 流式生成中, 显示已产出字节数(`streaming`)                         |
| `toolinput`          | 入参完整, 拿到 `html`/`title` 即渲染(`ready`)                     |
| `toolresult`         | 从 `_meta`/`structuredContent` 取 HTML; `isError` 则 `failed`     |
| `hostcontextchanged` | 镜像宿主主题到 `data-theme`(daisyUI 靠它切换), 应用样式变量与字体 |
| `toolcancelled`      | 置为 `failed` 并提示应用创建已取消                                |

连接成功后调用 `setupSizeChangedNotifications()` 让 iframe 随内容自适应高度。真正渲染用户 HTML 的是一个 `sandbox="allow-scripts allow-forms allow-modals allow-popups"` 的 iframe, 用 `srcDoc` 注入——**没有 storage、没有 cookie、无法访问宿主**, 这是"让模型代码在对话里跑"的安全底座。顶部导航条用一个 `StatusChip` 反映 waiting/streaming/ready/failed 四态。

## github_tool: 任意 gh 命令

一个工具覆盖全部 GitHub CLI 能力: 仓库、issue、PR/评审/合并、Actions、release、projects, 以及经 `gh api` 的任意 REST/GraphQL。入参 `args` 是**不带前导 `gh` 的参数数组**, 每个元素原样透传、不经 shell 解析, 因此没有命令白名单也没有确认步骤; 另有可选 `cwd`(选本地仓库)、`stdin`(喂给 `--input -`/`--body-file -`)、`timeout_ms`(默认 60000)与 `response_format`(`text`/`base64`, 后者保留二进制下载)。

执行层 `runGh` 用 `spawn("gh", args)` 直接拉起进程, 在 POSIX 上以 `detached` 建独立进程组: 超时或 MCP 取消时 `kill(-pid, SIGKILL)` 端掉整组, 因为 gh 别名/扩展可能派生继承管道的子进程。返回 `stdout`(Buffer)、`stderr`、`exit_code`、`signal`、`timed_out`、`cancelled`; 非零退出、超时或取消都置 `isError: true` 但保留部分输出。`ghEnvironment()` 负责鉴权与环境: 强制 `GH_PROMPT_DISABLED=1`、`GH_PAGER=cat`(禁交互与分页器), 从 `GH_HOST` 或回退 `GITHUB_BASE_URL` 的主机名推导 Enterprise host(`api.github.com` 归一为 `github.com`), 并据 host 是否为 Enterprise 把 token 注入 `GH_ENTERPRISE_TOKEN` 或 `GH_TOKEN`。`gh` 不在 PATH(`ENOENT`)时返回安装/鉴权提示, 且**从不阻止服务器启动**。

## 数据与可观测工具面

五个后端工具共享 `operations/shared.ts` 的一层薄抽象, 保证行为一致:

- `sqlInputSchema`: `connection_url`(可选覆盖) + `sql` + `params`(默认 `[]`)。
- `unrestrictedAnnotations`: `readOnlyHint:false, destructiveHint:true, idempotentHint:false, openWorldHint:true`——如实告诉宿主"这会改数据、不可假定幂等"。
- `requireConnection`: 每次调用解析连接串(优先 `connection_url`, 否则环境变量), 缺失就报出该设哪个变量。
- `operationResult`: 统一序列化, 把 `bigint` 转字符串、`Error` 转 `{name,message}`、`Map`/`Set` 转普通结构, 使文本结果与 `structuredContent` 一致。

共同点是**每次调用新建专用连接、结束即关**, 会话状态不跨调用保留; 未配置的后端在被调用时才报错, 不影响启动。

| 工具              | 驱动/协议        | 入参要点                                                                                                              | 输出                                                             |
| ----------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `postgres_tool`   | `pg` Client      | `$1/$2` 占位; 多语句需 `params` 为空                                                                                  | 每条语句的 `command`/`row_count`/`rows`/`fields`                 |
| `mysql_tool`      | `mysql2/promise` | `?` 占位; `multipleStatements` 开启; 大整数转字符串保精度                                                             | 驱动 `results` + `fields`(含 `affectedRows`/`insertId`)          |
| `redis_tool`      | `redis`          | `commands` 为参数数组的数组, 单连接顺序执行(支持 `SELECT`/`MULTI`/`EXEC`)                                             | 有序 `results`; 首个失败即停并给 `failed_command_index`          |
| `mongodb_tool`    | `mongodb`        | 原始 `command` 文档, Extended JSON 表达 BSON; `database:"admin"` 做管理                                               | `data` 为 canonical Extended JSON, 保留 ObjectId/时间戳/游标批次 |
| `prometheus_tool` | `fetch`          | `path`(默认 `/api/v1/alerts`)/`method`/`params`(数组重复键, 支持 `match[]`)/`body`/`headers`/`timeout_ms`(默认 30000) | `{status_code, data}`; HTTP 错误或 `status:"error"` 置 `isError` |

几个值得注意的细节: Redis 的 `EXEC` 可能整体成功而队列中个别命令返回错误, 故 `hasReplyError` 递归检查回复; Redis 工具用**自己的连接**, 与文档索引(SQLite)完全无关, 后者根本不需要 Redis。Prometheus 支持 bearer 或 basic 鉴权, 自定义 `headers` 可覆盖配置, JSON body 自动设 `content-type`、字符串 body 原样发送, 并保留反向代理路径前缀。MongoDB 用 `BSON.EJSON.deserialize/serialize`(relaxed:false)在 Extended JSON 与 BSON 间无损往返。

## 配置体系

配置由 `shared/config.ts` 用一个 zod `EnvSchema` 统一解析。两个细节体现"降级优先于崩溃": `dropEmptyValues` 把空字符串视作未设置(占位用的空 env 不会掩盖默认值); `PORT` 用 `.catch(3300)` 兜底, 环境里写了非法端口也退回默认而非让 stdio 服务器启动即挂。嵌入配置由 `resolveEmbedding` 单独裁决: 只实现 `openai` 协议, 其他值或缺失 `EMBEDDING_MODEL`/`EMBEDDING_BASE_URL`/`EMBEDDING_API_KEY`(可回退 `OPENAI_API_KEY`)都返回带原因的 `ok:false`, 让 `docs` 工具优雅降级而非抛配置解析错。

| 变量                                                           | 用途                                                                                  | 默认                     |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------ |
| `EMBEDDING_PROTOCOL`                                           | 嵌入协议, 仅实现 `openai`(OpenAI 兼容); 其他值使 `docs` 工具降级                      | `openai`                 |
| `EMBEDDING_MODEL` / `EMBEDDING_BASE_URL` / `EMBEDDING_API_KEY` | 嵌入模型、OpenAI 兼容端点、密钥(可回退 `OPENAI_API_KEY`)                              | —                        |
| `YUKINO_DOCS_DIR`                                              | 知识库目录                                                                            | `~/.yukino/docs`         |
| `YUKINO_INDEX_DB`                                              | 向量索引 SQLite 文件(可删以强制全量重嵌)                                              | `~/.yukino/index.sqlite` |
| `POSTGRES_URL`                                                 | PostgreSQL 连接(回退 `POSTGRESQL_URL`→`DATABASE_URL`)                                 | —                        |
| `MYSQL_URL` / `MONGODB_URL` / `MONGODB_DATABASE`               | MySQL / MongoDB 连接与默认库                                                          | —                        |
| `REDIS_URL`                                                    | 仅 `redis_tool` 使用                                                                  | `redis://localhost:6379` |
| `PROMETHEUS_BASE_URL`                                          | Prometheus 基址(回退 `PROMETHEUS_URL`), 另有 `PROMETHEUS_TOKEN`/`USERNAME`/`PASSWORD` | —                        |
| `GITHUB_TOKEN` / `GH_TOKEN` / `GH_HOST` / `GITHUB_BASE_URL`    | gh 鉴权与 Enterprise 主机                                                             | —                        |
| `HOST` / `PORT`                                                | HTTP 传输绑定地址/端口(仅 `--http`)                                                   | `127.0.0.1` / `3300`     |

除文档索引外, 每个数据工具都接受**逐调用的 `connection_url`/`base_url` 覆盖**, 因此同一进程可在多个后端间切换, 无需重启。

## 构建与打包

服务器有**两条并行的构建产物**, 由 `pnpm build`(= `tsup && vite build`)一次产出, 二者对 `dist/` 的写入顺序被刻意编排:

- **`tsup` 打服务端**: 入口 `src/main.ts`, 输出 ESM、`target: node24`、`clean: true`(先清空 `dist/`)。两个非默认配置是关键: `removeNodeProtocol: false` 保留 `node:` 前缀——tsup 默认会剥掉它, 对 `fs`/`path` 无妨(Node 也能裸解析), 但 `sqlite` 是**前缀专属内建模块**, 剥前缀后 `import ... from "sqlite"` 会在启动时 `ERR_MODULE_NOT_FOUND`; banner 注入 shebang 与一段 `createRequire` 垫片, 因为被打进 bundle 的 CJS 依赖(如 `dotenv`)会动态 `require()`, ESM 产物里没有 `require` 会抛 "Dynamic require of ... is not supported"。版本号也在此通过 `define` 注入 `__YUKINO_MCP_VERSION__`。
- **`vite` 打 UI 外壳**: 因为 tsup 已经 `clean` 过 `dist/`, vite 的 `emptyOutDir` 必须为 `false`, 否则会抹掉刚产出的 `main.js`。它用 `vite-plugin-singlefile` 把 React 外壳连同 Tailwind/daisyUI 样式内联成单个 `dist/create-app.html`。

`package.json` 只发布 `dist/`, 并声明 `bin.yukino-mcp → dist/main.js`, 因此 `npx`/全局安装后可直接作为 MCP 服务器命令启动。开发态 `pnpm dev` 先 `build:fe` 再用 `tsx` 跑源码; `pnpm test` 同样先构建 UI(外壳读取依赖 `dist/create-app.html` 存在)再跑 vitest。

## 适用场景与边界

**适合**: 给 Yukino CLI 或任意 MCP 宿主一次性接入"本地文档 RAG + 结果可视化 + GitHub 操作 + 多数据库直连"的复合能力; 需要在对话内交付可交互 HTML 应用(图表、仪表盘、演示)的场景; 希望以完整权限让 Agent 直接操作开发/测试环境数据库与 Prometheus 的运维/排障流程。

**边界与注意**:

- 数据类工具**无白名单、无只读模式、无确认步骤**, 权限等于连接账号的权限; 生产库应使用最小权限账号, 或干脆不配置对应环境变量。
- HTTP 端点**不鉴权**, 默认只绑 localhost; 仅在可信网络开启, 否则任何能访问该端口的人都能调用全部工具。
- 文档 RAG 依赖外部 OpenAI 兼容嵌入端点, 未配置时 `docs_tool`/`docs_sync` 降级为诚实报错, 其余工具不受影响。
- 需要 Node.js ≥ 24(`node:sqlite`); `create_app` 的 UI 外壳需先 `build:fe` 生成 `dist/create-app.html`, 且只在支持 MCP Apps 的宿主里可视化。
- 每次数据库调用新建并关闭连接, 不维持连接池与会话状态; 需要事务或会话相关语句序列时, 应放进**同一次调用**。
