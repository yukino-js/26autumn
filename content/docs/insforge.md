---
title: "InsForge: 面向 Coding Agent 的开源 BaaS 平台"
description: "拆解 InsForge 作为 agent-native 后端平台的产品能力、Express 控制面与 PostgREST 数据面架构、鉴权与安全模型、存储与 S3 协议网关、Deno 边缘函数沙箱与定时任务, 以及文档即 API、MCP 接入通道与 monorepo 工程化。"
local_path: "$HOME/Downloads/insforge"
---

InsForge 是一个开源的 BaaS (Backend as a Service) 后端平台, 它把数据库、鉴权、存储、边缘计算、站点部署与 AI 网关打包成一套可自托管的服务, 并按“终端前坐着一个 coding agent”这一前提设计接口。本文面向需要为 Agent 提供后端基座的工程师, 拆解它的进程架构、控制面与数据面的分工、鉴权与安全默认值, 以及面向 Agent 的文档即 API 与 MCP 接入通道。阅读本文可以先建立整体能力图, 再按鉴权、数据库、存储、边缘函数、MCP 逐域深入。

## 定位与问题域

传统 BaaS 假设有一个人在 Web 控制台里点击: 建表、配策略、上传文件、看日志。InsForge 的设计前提相反, 它把“可被 Agent 读取与配置”当作一等需求, 具体体现在三处接口设计上:

- 后端能力本身就是 API: 元数据、schema、迁移、日志、文档都以 REST 端点暴露, Agent 不需要解析 HTML 控制台。
- 文档即 API: 平台的开发规范与 SDK 文档存放在磁盘上, 后端直接把文件内容作为 JSON 返回, Agent 用一次 `fetch-docs` 工具调用就能学会平台约定。
- 错误响应结构化: 每个错误都带错误码枚举与后续动作提示, Agent 能据此决定重试、修参数还是改 schema。

这些接入通道支撑了 Agent 的日常工作: 读取后端上下文与状态 (文档、schema、元数据、运行时日志), 以及配置原语 (部署边缘函数、跑迁移、建存储桶、配 OAuth provider)。

在同类方案中的差异可以这样概括:

| 方案                    | 形态                                               | 与 InsForge 的差异                                                                                                                   |
| ----------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Supabase                | 开源 BaaS, Postgres + PostgREST + GoTrue + Storage | 数据面思路相近 (都用 PostgREST), 但 InsForge 把“Agent 工具面”与“文档/元数据 API”作为核心产品, 并额外提供 S3 线协议网关与边缘函数沙箱 |
| Firebase                | 托管 Serverless 后端                               | 强绑定 Google 云与自有数据模型, 自托管能力弱; InsForge 可完全脱离云运行                                                              |
| Appwrite                | 开源 BaaS, 自建 API 层                             | InsForge 的数据接口直接复用 PostgREST 语义, 表 CRUD 与 RLS 策略沿用 Postgres 生态                                                    |
| 自建 Express + Postgres | 全手工                                             | 需要自行实现鉴权、RLS 代理、存储签名、函数运行时、备份与迁移; InsForge 把这些做成开箱即用的产品域                                    |

## 产品能力矩阵

平台对外暴露多块能力, 每一块都有独立的 API 路由目录、共享 schema 与前端管理页。`backend/src/api/routes/` 下按域拆分为 advisor、ai、analytics、auth、compute、dashboard、database、deployments、docs、email、functions、github、logs、memory、metadata、payments、realtime、s3-gateway、schedules、secrets、storage、usage、webhooks、webscraper 等子路由:

| 产品            | 能力要点                                                                                                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Authentication  | 邮箱密码、邮箱 OTP、魔法链接、多家 OAuth provider (枚举声明 google/github/facebook/instagram/tiktok/apple/spotify/microsoft 等) 加自定义 OAuth, JWT 与匿名 key, 会话 refresh 与 CSRF |
| Database        | 表管理与 schema 编辑、raw SQL、迁移、备份、database advisor; 用户数据 CRUD 走 PostgREST                                                                                              |
| Storage         | 双 provider (S3 与本地文件系统), bucket/object 元数据, 预签名与代理上传协商, 完整 S3 线协议网关                                                                                      |
| Edge Functions  | Deno 运行时, 本地 Worker 沙箱与 Deno Deploy 双后端, secrets 注入, 定时任务                                                                                                           |
| Model Gateway   | 统一 AI 网关, 当前 provider 为 OpenRouter, 覆盖 chat、image、embedding                                                                                                               |
| Compute         | 容器化计算驱动 (Docker / Fly / 云代理), 支持端口与域名入口、scale-to-zero                                                                                                            |
| Site Deployment | 静态站点部署到 Vercel provider, 直传文件与打包上传两种路径                                                                                                                           |
| Memory          | 面向 Agent 的长期记忆存储与语义检索, 向量嵌入加相似度阈值                                                                                                                            |
| Realtime        | 数据库变更的实时订阅, Socket.IO 推送加 webhook 回调                                                                                                                                  |

## 部署形态与进程架构

一次自托管运行会拉起四类进程, 它们在同一台机器上通过内网端口协作:

| 进程             | 镜像 / 运行时                        | 端口 | 职责                                                               |
| ---------------- | ------------------------------------ | ---- | ------------------------------------------------------------------ |
| backend          | Node 20 (构建产物 `dist/server.js`)  | 7130 | 控制面: 鉴权、schema、存储、函数、部署、文档、遥测等所有产品域 API |
| postgres         | `ghcr.io/insforge/postgres:v15.13.4` | 5432 | 主数据库, 预置 `app.encryption_key` 会话级 GUC 供加密函数使用      |
| postgrest        | `postgrest/postgrest:v12.2.12`       | 内部 | 数据面: 把 Postgres 表映射成 REST 资源, 由 backend 反向代理        |
| deno (functions) | `denoland/deno:alpine-2.0.6`         | 7133 | 边缘函数运行时, 每个请求起一个隔离 Worker                          |

backend 是唯一对外的入口, 它既是控制面, 又是数据面的反向代理。数据流上, 用户数据的 CRUD 请求经 backend 鉴权后转发给 PostgREST, 由 PostgREST 直连 Postgres; 而 schema 管理、迁移、备份等控制面操作则由 backend 自己的服务层直接连 Postgres 连接池处理。这样既复用了 PostgREST 成熟的 RLS 与过滤语义, 又把管理类特权操作留在可控的服务层里。

docker-compose 只把 7130 端口暴露给公网, 前端开发服务器占用的 7131 端口被绑定到 `127.0.0.1`, PostgREST 与 Deno 运行时则完全不对外, 只在 compose 内网可达。

## Monorepo 结构

仓库用 turbo 加 npm workspaces 组织, 根 `package.json` 声明三个 workspace: `backend`、`frontend`、`packages/*`。

```text
insforge/
├── backend/            # Express 控制面 + PostgREST 代理 + Deno 函数调度
│   └── src/
│       ├── api/        # routes (按产品域) + middlewares (auth/错误处理)
│       ├── services/   # 业务服务层 (ai/auth/database/storage/functions/...)
│       ├── infra/      # database (连接池/迁移) / security (token) / config
│       ├── utils/      # sql-parser (WASM) 等工具
│       └── server.ts   # 应用装配与启动序列
├── frontend/           # Vite + React 开发外壳, 挂载 packages/dashboard
├── packages/
│   ├── dashboard/      # 实际控制台 UI (React), 被 frontend 引用
│   ├── shared-schemas/ # 前后端共享的 zod schema 与类型
│   └── ui/             # 共享组件库
├── functions/          # Deno 边缘函数运行时 (server.ts + worker-template.js)
├── docs/               # MDX 文档 (含 mcp-setup.mdx), 由 docs-as-API 提供
└── .agents/            # Agent 指令与 skills (SKILL.md)
```

`backend` 内部是清晰的三层: `api/routes` 负责 HTTP 装配与鉴权中间件绑定, `services` 负责业务逻辑, `infra` 负责数据库连接池、迁移与 token 等基础设施。构建由 tsup 完成, 目标是 ESM、Node 20, 并把 `@insforge/shared-schemas` 与 `lru-cache` 打进 bundle (`noExternal`, 后者服务于 S3 网关的 SigV4 热路径), 同时刻意把 `file-type` 保持为外部依赖以避免其 `require('tty')` 在 ESM 下失效。

## 后端启动序列

`server.ts` 里的 `createApp()` 与 `initializeServer()` 把“装配中间件”和“启动后台服务”分成两步。

装配阶段先做基础设施初始化, 顺序是 `DatabaseManager` → `StorageService` → `LogService` → `initSqlParser` (加载 WASM SQL 解析器)。随后按严格顺序挂中间件, 顺序本身就是安全设计的一部分:

1. CORS: 显式 `exposedHeaders` 暴露 `Content-Range` 与 `Preference-Applied`, 让前端能读到分页与 PostgREST 回执头。
2. `cookieParser`。
3. 请求日志: 跳过 `/logs/` 前缀, 避免日志写入请求再触发日志。
4. `FeatureUsageCollector`: 仅在遥测未禁用时挂载, 统计功能使用。
5. webhooks 路由: 用 raw body, 必须排在 JSON 解析之前, 否则签名校验拿不到原始字节。
6. S3 网关 (`/storage/v1/s3`): 同样排在 JSON 解析之前, 因为它要处理 `aws-chunked` 流式上传。
7. `json` / `urlencoded` body 解析: JSON 上限 100mb, urlencoded 上限 10mb。
8. `apiRouter`: 挂载所有产品域子路由。
9. `/functions/:slug` 代理: 转发到 Deno 运行时。
10. 非云环境下根路径重定向, 之后是静态前端或 404。
11. `errorMiddleware` 兜底, 最后 `seedBackend` 做初始数据播种。

JWKS 端点注册了两次 (根路径与 `/api` 前缀), 保证不同 base 的客户端都能取到公钥。健康检查 `/api/health` 返回 `package.json` 里的版本号。

`initializeServer()` 再拉起后台服务: 预热计算配置快照 (`ComputeConfigService.primeSnapshot`), 设置 HTTP `keepAliveTimeout` 与比它大 1000ms 的 `headersTimeout`, 启动 `SocketManager` 与 `RealtimeManager`, 非阻塞地同步一次部署 (`syncDeployment`), 启动计算驱动, 开启 `TelemetryService`, 并在非云环境启动 `DatabaseBackupService.startScheduler`。进程监听 `SIGINT` / `SIGTERM` 做优雅清理。

## 鉴权与安全模型

鉴权是这个平台安全设计的核心, 因为它同时服务三类调用者: 终端用户、Agent (通过 API key)、以及云控制面。

### 三种凭证形态

`verifyUser` 中间件按凭证前缀分派到不同校验路径, 这是一种 fail-closed 设计:

- `ik_` 前缀 → API key, 经 `SecretService` 校验, 用于 Agent 与工具面。
- `anon_` 前缀 → 匿名 opaque key, 校验后把 `sub` 设为 `'anonymous'`、role 设为 `anon`。它是不可解码的随机串, 不是 JWT。
- 其它 → 按 JWT 走 `verifyToken`。

`verifyAdmin` 则接受三种来源: `ik_` API key、云环境的 `project_authorization` token (映射为 `project_admin` 角色)、或带 `project_admin` 角色的 JWT。代码里明确注释: 只有经过认证的 UUID 才能作为行级所有权身份, 匿名与 API key 请求不携带用户 UUID。

### 双算法 JWT

`token.manager.ts` 用 RS256 签发用户 token (密钥来自数据库), 并保留 HS256 作为回退。校验时优先按 `kid` 匹配 RS256 公钥, 匹配不到再尝试 HS256, 且强制要求 `sub` 存在。令牌生命周期分层:

| 令牌                       | 算法  | 有效期   | 用途                                       |
| -------------------------- | ----- | -------- | ------------------------------------------ |
| access token               | RS256 | 15 分钟  | 用户会话                                   |
| refresh token              | RS256 | 7 天     | 刷新会话                                   |
| PostgREST user token       | HS256 | 5 分钟   | 以用户身份转发数据面请求                   |
| PostgREST admin/anon token | HS256 | 永不过期 | 服务内部以管理员/匿名身份访问数据面        |
| cloud token                | RS256 | 10 分钟  | 云控制面, `sub` 为 projectId, 本地拒绝签发 |

`verifyCloudToken` 走远程 JWKS, 接受 RS256/384/512 与 ES256/384/512。`signCloudToken` 只在云环境可用, 本地或未配置时直接拒绝。

### CSRF

对基于 cookie 的会话, 平台用 HMAC-SHA256 生成 CSRF token, 规范化字符串形如 `insforge:csrf:v1:${sessionType}:${sub}:${csrfNonce}`, 其中 `csrfNonce` 是 32 字节随机值。校验用 `timingSafeEqual` 防时序侧信道, 不匹配返回 403。

### SQL 执行护栏

Agent 提交 raw SQL 时, `checkSqlExecutionGuards` 先用 WASM 解析器 `parseSync` 做静态检查, 阻断四类语句: 数据库管理、角色管理、事务控制, 以及会话变量修改 (`RESET ALL`、`role`、`search_path`、`statement_timeout`)。这保证了即使 Agent 拿到执行 SQL 的能力, 也无法越权改动实例级配置。

## 数据库产品域

数据库域分两条路径: 控制面直连连接池, 数据面反代 PostgREST。

### 控制面: 连接池与元数据

`DatabaseManager` 维护一个 `max: 20` 的连接池, `idleTimeoutMillis: 30000`、`connectionTimeoutMillis: 2000`。为了减少 `information_schema` 查询压力, 它缓存列信息 (TTL 5 分钟, 上限 100 条) 与表行数 (TTL 60 秒, 上限 1000 条)。`getMetadata` 返回表清单、以 GB 计的总大小, 以及给 Agent 的 hint 文本。

迁移用 `node-pg-migrate`, 迁移记录写在 `system.migrations` 表。`migrate:up` 先跑 `migrate:bootstrap` 再执行 `up`, 迁移文件目前累积到编号 067。

### 数据面: PostgREST 代理

用户数据的 CRUD 经 `records.routes.ts` 转发到 `postgrest-proxy.service.ts`。代理链路的关键处理:

- `validateTableName` 校验表名, 非法直接 400, 不进入转发。
- `resolvePostgrestSchema`: 请求带 `?schema=` 时, 翻译成 PostgREST 的 `Accept` / `Content-Profile` 头, 实现多 schema 路由。
- 对 TEXT 类数据类型的空字符串做过滤, 避免把空串误写。
- 按调用者身份选择 `forwardAsAdmin` / `forwardAsUser` / `forwardAsAnon`。
- 转发前剥离 `host`、`content-length`、`connection` 头。
- 用 `agentkeepalive` 复用到 PostgREST 的长连接, 并针对复用了已被对端关闭的 socket 触发的 `ECONNRESET` (`isStaleSocketReset`) 做一次重试, 整体 `maxRetries` 为 3。

### 列类型映射

建表时前端选择的列类型直接映射到 Postgres 类型, 这张表就是 `types/database.ts` 里的 `COLUMN_TYPES`:

| 前端类型 | Postgres 类型    | 默认值              |
| -------- | ---------------- | ------------------- |
| STRING   | TEXT             | null                |
| DATE     | DATE             | `now()`             |
| DATETIME | TIMESTAMPTZ      | `now()`             |
| INTEGER  | INTEGER          | null                |
| FLOAT    | DOUBLE PRECISION | null                |
| BOOLEAN  | BOOLEAN          | `false`             |
| UUID     | UUID             | `gen_random_uuid()` |
| JSON     | JSONB            | null                |

## 存储产品域

存储层是双 provider 抽象: S3 与本地文件系统二选一, 上层 API 保持一致。除了常规的 bucket/object 元数据管理与预签名上传协商, 存储域最重的能力是一个完整的 S3 线协议网关。

网关挂在 `/storage/v1/s3`, 直接实现 AWS S3 的 REST 语义: 校验 SigV4 签名, 用 LRU 缓存加速鉴权热路径, 支持 `aws-chunked` 流式上传。因为它是线协议兼容的, 标准 AWS SDK 与 `aws-cli` 可以直接把 InsForge 当作 S3 端点使用。这也是它在中间件顺序里必须排在 JSON 解析之前的原因——流式分块上传不能被 body parser 提前消费。

对读取, 平台支持 CloudFront 签名 URL, 且做到“每日稳定”: 同一对象在同一天内生成一致的签名地址, 便于缓存。存储还支持分支模式 (通过 `parentAppKey` 关联父应用), 让 Agent 能在隔离分支里操作对象而不影响主环境。

## 边缘函数与定时任务

### 本地 Deno Worker 沙箱

`functions/server.ts` 是独立的 Deno 服务, 监听 7133。收到请求后按 slug 从 `functions.definitions` 表取 `status = 'active'` 的函数代码, 然后为这一个请求起一个全新的 Worker, 执行完即 `terminate`。Worker 权限被收到最紧: `env: false`、`net: true`, 其余 (`read`/`write`/`run`/`ffi`/`sys`/`import`/`hrtime`) 全部关闭——只放开网络, 供函数调用 SDK 与外部 API。

`worker-template.js` 里有几处值得注意的健壮性设计:

- 安全黑屏 (Security Blackout): 在任何 import 之前用顶层 await 把 `globalThis.Deno` 冻结成只提供受控 `env` 的假对象, 并覆写 `process.env` 为无菌环境, 防止依赖库 (如 `debug`) 触发权限错误。这一步失败会立即回 500 并 `self.close()`, 绝不泄漏宿主环境。
- 早期消息缓冲 (Early Message Buffering): Web Worker 不会缓存 `onmessage` 注册前到达的消息, 而冷启动 `import` 可能超过 200ms。模板先同步注册一个把消息塞进缓冲区的 handler, 等 import 完成再切换到真实 handler 并 drain 缓冲区, 避免请求被静默丢弃导致 504。
- 导入失败快速失败: 若 `npm:@insforge/sdk` 或 std base64 导入失败 (如受限出网下 registry 不可达), 显式回一个 500, 而不是挂到运行时的 60 秒超时。

用户函数通过 `new Function` 包装执行, 注入的是 mock 过的 `Deno` (只提供 `env.get` 读取显式传入的 secrets, `run`/`spawn`/`Command` 一律抛错)、`createClient`、以及 base64 工具。函数以 `module.exports = async function(req) { ... }` 形式导出, 返回标准 `Response`; 对 204/205/304 不序列化 body。

### Secrets 注入

Secrets 不以明文进数据库。`server.ts` 从 `system.secrets` 取密文, 用 AES-GCM 解密: 密钥是把 `ENCRYPTION_KEY` (或回退 `JWT_SECRET`) 做 SHA-256 得到, 密文格式是 `iv:authTag:encrypted` 的十六进制拼接。解密后的 secrets 通过 `postMessage` 显式传给 Worker, Worker 内的 mock `Deno.env.get` 只能读到这些被明确允许的值。`WORKER_TIMEOUT_MS` 默认 60000, 超时则 `terminate` 并回 504。

### Deno Deploy 后端

除本地 Worker 运行时外, 函数还支持部署到 Deno Deploy, 走其 v2 API (`api.deno.com/v2`), 作为托管型边缘后端。

### 定时任务

调度域基于 Postgres 扩展实现: `pg_cron` 负责定时触发、`http` 扩展负责回调、`pgcrypto` 提供加密能力。调度表达式支持标准 5 段 cron, 也支持亚分钟级 interval, 触发记录带运行详情并做保留策略清理。

## 其余产品域速览

- **Model Gateway (AI)**: 统一 AI 网关, 当前 provider 是 OpenRouter, 通过 OpenAI SDK 接入, 请求带 `HTTP-Referer` 与 `X-Title` 头做归因, 覆盖 chat、image、embedding 三类能力。
- **Memory**: 面向 Agent 的长期记忆。嵌入模型是 `text-embedding-3-small` (1536 维), 生成模型是 `gpt-4o-mini`, 相似度阈值取 0.45 / 0.5, 记忆分 fact、decision、preference、reference 四种 kind。
- **Compute**: 容器化计算, 提供 docker、fly、cloud 三种驱动。docker 驱动用“重命名-替换”做安全更新 (先起新容器再原子切换), 并支持 scale-to-zero 按需拉起。
- **Site Deployment**: 静态站点部署到 Vercel provider, 支持直传文件与打包上传两种路径, 可部署区域从 `vercel.json` 读取, 单站点文件数上限 `maxDeploymentFiles` 为 5000。
- **Realtime**: 用一个专用的 Postgres LISTEN 连接监听变更 (PostgREST 通过 `pgrst` NOTIFY 通道广播), 再经 Socket.IO 推给前端, 或经 webhook 回调外部; 断线最多重连 10 次。
- **Telemetry**: 基于 PostHog, 上报 `instance_started` 与 24 小时心跳, 并能识别 CI 环境以抑制噪声; 用户可通过运行时开关整体禁用。

## 契约层与文档即 API

`packages/shared-schemas` 用 zod 定义前后端共享的请求/响应契约, 既做运行时校验又导出 TypeScript 类型, 让 backend、frontend、dashboard 三端对同一份 schema 达成一致。

文档即 API 由 `docs/index.routes.ts` 实现: 平台把开发规范与多语言 SDK 文档以 MDX 存在磁盘上, 后端读文件、跑 `processSnippets` 展开代码片段, 再以 JSON 返回。它维护两张映射表——一张 legacy 映射 (如 `instructions` 指向 `.agents/docs/insforge-instructions-sdk.md`, 以及 db/auth/storage/functions/ai/realtime/deployment/payments 等), 一张 SDK 映射 (db/storage/functions/auth/ai/realtime 六域 × typescript/swift/kotlin/rest-api 四语言, payments 仅 typescript)。路径做安全校验, 越界访问返回 403。Agent 因此能用一次 `fetch-docs` 调用把整份平台约定读进上下文。

## 前端与共享包

`frontend` 是一个 Vite + React 开发外壳, 通过 alias 把 `packages/dashboard` 的源码直接挂进来 (而非消费构建产物), 开发服务器监听 7131, 并把 `/api`、`/functions`、`/socket.io` 三个前缀代理到 backend 的 7130, 构建产物输出到 `../dist/frontend`。应用入口按 `isCloudHosting()` 分流: 云环境渲染 `CloudHostingDashboard`, 自托管渲染 `SelfHostingDashboard`。

`packages/dashboard` 是实际控制台 UI, `packages/ui` 提供共享组件, `packages/shared-schemas` 提供契约。三者与 backend 同处一个 turbo 管线, 共享类型与 lint 规则。

## MCP 接入通道

MCP Server 本体位于独立仓库, 不在本代码库内; 本文只描述本仓库里可验证的接入面。Agent 通过 MCP 连接 InsForge 有两条路径:

- 远程 MCP: 端点 `https://mcp.insforge.dev/mcp`, 可用 `npx add-mcp` 一键接入。
- 本地进程: dashboard 的连接向导为 14 种 Agent 客户端预置了安装命令。生成的命令形如 `npx @insforge/install --client <id> --env API_KEY=<key> --env API_BASE_URL=<url>`; 直接写 MCP JSON 时, 服务器配置是 `npx -y @insforge/mcp@latest` (Windows 下用 `cmd /c npx` 包一层), 环境变量注入 `API_KEY` 与 `API_BASE_URL`。

被预置的客户端包括 cursor、claude-code、trae、cline、windsurf、roo-code、qoder、github-copilot、google-antigravity、codex、kiro、opencode、openclaw, 以及手填 JSON 的 manual 项。云环境还提供 CLI 增强通道 (`npx @insforge/cli link --project-id`) 与配套 Skills。

从平台侧文档 (`docs/mcp-setup.mdx`) 看, MCP 暴露的工具按域划分:

| 域         | 工具                                                                    |
| ---------- | ----------------------------------------------------------------------- |
| Database   | `get-table-schema`、`run-raw-sql`、`bulk-upsert`                        |
| Storage    | `create-bucket`、`list-buckets`、`delete-bucket`                        |
| Functions  | `create-function`、`get-function`、`update-function`、`delete-function` |
| Deployment | `create-deployment`、`start-deployment`、`get-container-logs`           |
| Setup/Docs | `fetch-docs`、`get-anon-key`、`get-backend-metadata`                    |

其中 `run-raw-sql` 受前述 SQL 执行护栏约束, `get-anon-key` 返回的是匿名 opaque key (非 JWT)。backend 侧对 MCP 使用量做统计: `POST /api/usage/mcp` (走 `verifyApiKey`) 记录一次 MCP 使用并发布 `mcp-connected` 事件, `GET /api/usage/mcp` 走 `verifyAdmin`, `GET /api/usage/stats` 限云后端。

## 容器化与打包

根 `Dockerfile` 是多阶段构建, 分为 deno-bin、package-prep、deps、build、prod-deps、runner 六个阶段, 另有一个 dev target。package-prep 阶段用 `jq` 从 `package.json` 里删掉 `version` 字段并剔除 `mcp` workspace, 使镜像内构建不依赖外部 MCP 包。runner 阶段基于 `node:20-alpine`, 用 `tini` 做 1 号进程回收僵尸, 装 `postgresql16-client` (以 pg_dump 16 兼容服务端 15 的备份), 用 `su-exec` 降权运行。容器 CMD 先 `npm run migrate:up` 跑迁移, 再 `exec node ../dist/server.js` 启动, 保证 schema 与代码版本对齐。

纯镜像自托管则直接使用 `ghcr.io/insforge/insforge-oss:latest`。

## 工程化与 Agent 原生配套

`.agents/skills/insforge-dev/SKILL.md` 给在此仓库里干活的 Agent 定了四条核心规则: 严守包边界、改动落在最窄的层、遵循仓库约定 (含 ESM 下 import 需带 `.js` 后缀)、以及不要把“仓库开发”与“应用开发”混为一谈。仓库还通过 `.claude-plugin/marketplace.json` 引用了独立的 `InsForge/insforge-skills` 插件源。这些配套让 Agent 在修改平台自身代码时也有明确的行为边界。

## 安全默认值一览

把散落各处的安全默认集中起来, 便于评估自托管暴露面:

| 维度      | 默认值 / 行为                                                                  |
| --------- | ------------------------------------------------------------------------------ |
| 端口暴露  | 仅 7130 对外; 7131 绑 `127.0.0.1`; PostgREST 与 Deno (7133) 仅内网可达         |
| 函数沙箱  | 每请求一 Worker, 用后即焚; 权限仅 `net: true`, `env`/`read`/`write`/`run` 全关 |
| Secrets   | AES-GCM 密文入库, SHA-256 派生密钥, 运行时经消息显式注入, 不进环境变量         |
| SQL       | WASM 静态护栏阻断 DB 管理、角色管理、事务控制与会话变量修改                    |
| 凭证分派  | fail-closed, 按 `ik_` / `anon_` / JWT 前缀分派; 匿名与 API key 不携带用户 UUID |
| CSRF      | HMAC-SHA256 + `timingSafeEqual`, 不匹配 403                                    |
| JWT       | RS256 签发, HS256 回退, 强制 `sub`; cloud token 本地拒绝签发                   |
| Body 上限 | JSON 100mb, urlencoded 10mb                                                    |
| 备份      | pg_dump 16 client, 非云环境由调度器周期性备份                                  |

## 适用场景

InsForge 适合这几类需求: 需要一个可完全自托管、不绑定特定云的 Postgres 后端; 希望把 schema、存储、函数、部署等操作都以 API 暴露给 coding agent, 而非人工点控制台; 想直接复用 PostgREST 的 RLS 与过滤语义而不重写数据层; 以及需要 S3 线协议兼容网关或 Deno 边缘函数沙箱的场景。反过来, 如果只需要一个托管的、无需自运维的 Serverless 后端, 或已深度绑定某云厂商的自有数据模型, 那么它的自托管复杂度与 Postgres 中心设计就不一定划算。
