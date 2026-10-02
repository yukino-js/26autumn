---
title: "Insforge 调研: 面向 Coding Agent 的开源 BaaS 平台与其 MCP Server"
description: "insforge/insforge turbo monorepo 与 insforge/insforge-mcp 双仓库调研: Express+PostgREST 后端、Deno 边缘函数、S3 协议网关与 18 个 MCP 工具"
---

仓库路径: https://github.com/insforge/insforge 与 https://github.com/insforge/insforge-mcp (本机克隆分别位于 $HOME/Downloads/insforge 与 $HOME/Downloads/insforge-mcp)

## 一、项目快照 (本机克隆 2026-10-02 同步)

| 指标          | insforge (主仓库)                                                                                                                                                         | insforge-mcp                                                                                        |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| HEAD          | f3df24d4 (完整哈希 f3df24d483f02c9938bdd1abb14ab9681e3545f0), 提交日期 2026-10-01                                                                                         | 094a1f3, 提交日期 2026-09-10                                                                        |
| 分支          | main                                                                                                                                                                      | master                                                                                              |
| 定位          | "The all-in-one, open-source backend platform for agentic coding" — 给 coding agent 提供数据库、鉴权、存储、计算、托管与 AI 网关的开源 BaaS (README.md 首屏)              | InsForge 后端的 MCP (Model Context Protocol) server, 把平台操作面暴露为 agent 可调用的工具          |
| 主包名/版本   | 根 package.json name 为 insforge, version 2.3.2                                                                                                                           | @insforge/mcp 1.2.12 (mcpName: io.github.InsForge/insforge-mcp)                                     |
| License       | Apache-2.0 (LICENSE)                                                                                                                                                      | Apache-2.0 (LICENSE)                                                                                |
| 运行时        | Node 20 (Dockerfile node:20-alpine, tsup target node20) + Deno 2.0.6 (边缘函数) + PostgreSQL 15                                                                           | Node (tsx 开发 / tsup 构建, package.json 未声明 engines)                                            |
| Monorepo 结构 | turbo 2.9.16 + npm workspaces: backend, frontend, packages/* (dashboard / shared-schemas / ui); 另有 functions, openapi, docker, deploy, docs, examples, scripts 顶层目录 | 单包仓库, src 分 stdio / http / shared / integration 四区                                           |
| 关键框架      | Express 4.22 (backend), React 19.2.1 + Vite 8.1.5 + Tailwind 4.1.11 (frontend)                                                                                            | Express 5.1 (HTTP server), @modelcontextprotocol/sdk 1.27.1                                         |
| 官方远程形态  | 云托管 insforge.dev; 自托管 Docker Compose                                                                                                                                | stdio (npx @insforge/mcp) 与远程 streamable-http https://mcp.insforge.dev/mcp (server.json remotes) |

主仓库版本沿革 (CHANGELOG.md): 2.0.0 发布于 2026-03-06, 2.0.1 于 2026-03-09, 当前根版本号已到 2.3.2。MCP 仓库的 CLAUDE.md 是一份发布手册: dev 渠道用预发布版本号加 npm dist-tag dev, 生产渠道走 latest tag, 并要求 AI 助手"未经用户明确确认绝不发布生产版本"。

产品哲学写在 docs/agent-native/overview.mdx 第一句: "Most backends assume a human in a dashboard. InsForge assumes a coding agent at a terminal." — 多数后端假设人在 dashboard 里点击, InsForge 假设终端前坐着一个 coding agent。README 给出的两条 agent 接入通道: MCP Server (自托管与云均可) 和 CLI + Skills (仅云)。agent 通过它们做两类事: 读后端上下文与状态 (文档、schema、元数据、运行时日志), 以及配置原语 (部署边缘函数、跑迁移、建存储桶、配 OAuth provider)。README Core Products 列出七个产品: Authentication、Database、Storage、Model Gateway、Edge Functions、Compute (标注 private preview)、Site Deployment。

## 二、架构总览

自托管形态由四个容器组成 (docker-compose.yml services 段):

| 服务      | 镜像/构建                                                                  | 端口                                              | 职责                                                                                                                                                  |
| --------- | -------------------------------------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| postgres  | ghcr.io/insforge/postgres:v15.13.4                                         | 5432 (POSTGRES_PORT)                              | 定制 Postgres 15 镜像, 启动参数注入 app.encryption_key GUC; initdb 挂载 deploy/docker-init/db/db-init.sql 与 jwt.sql 及 postgresql.conf               |
| postgrest | postgrest/postgrest:v12.2.12                                               | 5430 (POSTGREST_PORT)                             | 数据面 REST 网关: PGRST_DB_ANON_ROLE 为 anon, PGRST_JWT_SECRET 与后端共享, PGRST_DB_CHANNEL 为 pgrst 支持 NOTIFY 热重载 schema, PGRST_DB_POOL 默认 50 |
| insforge  | 本仓库 Dockerfile (dev 构建 / 生产用 ghcr.io/insforge/insforge-oss:latest) | 7130 (APP_PORT), 7131 (AUTH_PORT), 7132 (UI_PORT) | Express 控制面 + dashboard 前端                                                                                                                       |
| deno      | denoland/deno:alpine-2.0.6                                                 | 7133 (DENO_PORT)                                  | 边缘函数本地运行时, 运行 functions/server.ts, WORKER_TIMEOUT_MS 默认 60000                                                                            |

控制面 (backend) 是全部产品逻辑所在地: 22 个子路由经 apiRouter.use 挂在 /api 下, webhooks 单独直挂 /api/webhooks (backend/src/server.ts createApp), 数据读写大量转发给 PostgREST, 元数据与管理操作直接走 pg 连接池。分层纪律写在 .agents/skills/insforge-dev/SKILL.md 的 Core Rules: 契约变更先进 packages/shared-schemas, 后端行为按 route → service → provider/infra 分层, 共享 dashboard 行为进 packages/dashboard, 可复用 UI 原语进 packages/ui, 后端 TS 源码用 ESM 风格 .js import specifier。

MCP server 不在主 monorepo 内 (根 package.json 的 workspaces 不含 mcp, Dockerfile package-prep 阶段还显式从 workspaces 数组里剔除 mcp), 它是独立仓库 insforge-mcp, 通过 HTTP 调用主仓库后端的 /api/* 接口。两仓库的耦合点是: MCP 启动时 GET /api/health 拿后端版本号做工具注册门控, 以及 MCP 依赖精确钉死的 @insforge/shared-schemas 1.1.49 (insforge-mcp/package.json dependencies)。

## 三、Monorepo 与构建链

### 3.1 工作区与 turbo 任务图

根 package.json: workspaces 为 backend, frontend, packages/*; 脚本 dev/build/test/lint/typecheck/clean 全部委托 turbo run, 另有 dev:debug 用 concurrently 同时起前后端调试模式 (DEBUG_MODE / VITE_DEBUG_MODE)。turbo.json 的关键配置:

```json
{
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "inputs": [
        "src/**",
        "tsconfig*.json",
        "package.json",
        "vite.config.*",
        "tsup.config.*"
      ],
      "env": ["VITE_*"]
    },
    "@insforge/backend#build": {
      "outputs": ["../dist/server.js", "../dist/server.js.map"]
    },
    "frontend#build": { "dependsOn": [], "outputs": ["../dist/frontend/**"] },
    "@insforge/dashboard#build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**"]
    },
    "test": { "dependsOn": ["^build"], "outputs": [], "cache": false }
  }
}
```

构建顺序即依赖序: shared-schemas → ui → dashboard → backend/frontend。后端产物写到仓库根的 dist/server.js (backend/tsup.config.ts outDir 为 ../dist), 前端产物写到 dist/frontend (turbo.json outputs), 生产镜像同时打包两者, 由 Express 托管静态前端 (server.ts 中 express.static(frontendPath) 加 /cloud* 与 /dashboard* 的 SPA catch-all)。

### 3.2 后端构建 (tsup)

backend/tsup.config.ts 有几个值得注意的决定:

- format esm, target node20, entry src/server.ts, sourcemap true, clean false (dist 里还有前端产物);
- noExternal 只收编 @insforge/shared-schemas 与 lru-cache — 注释解释 lru-cache 是 SigV4 校验热路径缓存, 因根目录有 devDep 把 v5 钉在根 node_modules, workspace 副本被嵌套到 backend/node_modules, 而 Docker runner 只带根级 hoisted node_modules, 所以直接打进 bundle;
- file-type 刻意保持 external: 打包它会内联其传递依赖 debug, debug 里的 require('tty') 在 esbuild ESM shim 下会崩;
- esbuildOptions 配 @ → ./src 别名; 与 .agents/skills/insforge-dev/SKILL.md Core Rules 第 3 条呼应: 后端源码一律 .js 后缀的 ESM import specifier。

### 3.3 Docker 镜像 (六阶段)

根 Dockerfile 分六个阶段:

1. deno-bin: denoland/deno:alpine-2.0.6, 只为取 deno 二进制 (与 compose 的 deno 运行时版本钉齐);
2. package-prep: 用 jq 剥掉根 package.json 的 version 字段并从 workspaces 里删掉 mcp — 目的是让版本号变化不打破下游 COPY --from 的内容缓存;
3. deps: npm ci 全量依赖 (dev+prod), 先剥掉 shared-schemas 的 prepare/build 脚本防止 install 期跑 tsc;
4. build: COPY 全部源码, ARG 注入 VITE_API_BASE_URL 与 VITE_PUBLIC_POSTHOG_KEY, npm run build;
5. prod-deps: npm ci --omit=dev, 同样剥掉 shared-schemas 脚本;
6. runner: node:20-alpine, apk 装 tini (PID 1 信号转发)、postgresql16-client (备份用 pg_dump/pg_restore; 注释解释为何 client 钉 16 而 server 是 15 — pg_dump 17+ 会输出 15 服务端拒绝的 transaction_timeout 设置)、su-exec (entrypoint 降权用, su 会在 tini 与 node 之间多留一层 shell 破坏信号投递)。

runner 阶段细节: EXPOSE 7130 7131; 环境变量默认 STORAGE_DIR=/insforge-storage, LOGS_DIR=/insforge-logs, MAX_JSON_BODY_SIZE=100mb, NODE_ENV=production, INSFORGE_DEPLOYMENT_METHOD=docker; 全局安装 tsx (migrate:bootstrap 运行时需要); 运行时文件包括 dist (server.js + frontend 静态文件)、docs 与 .agents/docs (供 /api/docs 端点读取)、backend/src 与 backend/tsconfig.json (迁移运行时需要 tsx 解析 @ 别名并读 .sql 文件)、shared-schemas 的 dist+src。CMD 是 `sh -c "cd backend && npm run migrate:up && exec node ../dist/server.js"` — 容器启动先跑迁移再起服务, exec 直连 node 避免 npm 包装链常驻两个进程 (注释: 512MB 机器上省 20-40MB)。

非 root 的落点在 docker/entrypoint.sh 而非镜像 USER 指令:

```bash
# docker/entrypoint.sh (节选)
if [ "$(id -u)" = '0' ]; then
  if [ -S "$SOCKET" ]; then
    socket_gid="$(stat -c '%g' "$SOCKET")"
    # ...按 socket 的 group id addgroup/adduser 把 node 加入该组
  fi
  exec su-exec node "$@"
fi
exec "$@"
```

容器以 root 启动, 读取挂载进来的 Docker socket 的 group id (注释: Amazon Linux 2023 上是 993, Debian/Ubuntu 常见 999, Docker Desktop 是 0, 无法烘焙进镜像), 把 node 用户加入该组, 再 exec su-exec node 降权 — 这是给可选的 Docker compute 驱动准备的。镜像注释明确说了代价: 覆盖 entrypoint 就会以 root 运行, 与官方 postgres/redis 镜像同形, 若覆盖 entrypoint 需自行加 user: node。

另有 dev target: 拷贝 deno 二进制、预建各 node_modules 挂载点、不设 USER node (bind mount 继承宿主属主, 注释解释 root 下跑 npm install 才不会在 CI 的 root-only bind mount 上失败)。根目录 docker-compose.yml 用 dev target + 全量源码 bind mount + named volume 装五份 node_modules, command 里先 npm install、turbo 构建三个共享包、跑 migrate:up, 再用 concurrently 同时起 backend 与 frontend 开发服务器; postgres 与 postgrest 都带 no-new-privileges:true, postgres 有 pg_isready 健康检查, 存储与日志用 named volume (storage-data, shared-logs) 跨容器共享。

## 四、后端启动序列与中间件栈

backend/src/server.ts 的 createApp() 是全栈装配点, 初始化顺序有明确依赖:

1. DatabaseManager.getInstance().initialize() — 建 pg Pool (backend/src/infra/database/database.manager.ts: max 20, idleTimeoutMillis 30000, connectionTimeoutMillis 2000);
2. StorageService.getInstance().initialize() — 按配置选 S3 或本地文件系统 provider;
3. LogService.getInstance().initialize() — 连云端 CloudWatch 或落本地文件;
4. initSqlParser() — 加载 libpg-query 的 WASM SQL 解析器 (backend/package.json 依赖 libpg-query ^17.6.0)。

中间件注册顺序是精心安排的 (server.ts 内注释直接写明理由):

| 顺序 | 中间件                      | 说明                                                                                                                                          |
| ---- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | cors                        | origin true 全放行 + credentials true, exposedHeaders 暴露 Content-Range 与 Preference-Applied (PostgREST 风格头)                             |
| 2    | cookieParser                | refresh token 走 httpOnly cookie                                                                                                              |
| 3    | 请求日志                    | 覆写 res.send/res.json 统计响应字节数, finish 事件后记 method/path/status/size/duration/ip/UA; 路径含 /logs/ 的请求跳过, 防止日志端点自我循环 |
| 4    | FeatureUsageCollector       | 匿名遥测的功能计数器, 注册在所有路由之前以覆盖 /api、S3 网关与边缘函数直呼; 遥测关闭时整段不注册                                              |
| 5    | /api/webhooks + express.raw | 支付 webhook 必须在 JSON 解析之前拿到原始字节做签名验证                                                                                       |
| 6    | /storage/v1/s3              | S3 协议网关同样在 JSON 中间件之前挂载, 让请求体原样流过去, 网关自己处理流式签名 (含 STREAMING-AWS4-HMAC-SHA256-PAYLOAD 分块签名)              |
| 7    | express.json / urlencoded   | 默认 100mb / 10mb (appConfig.server.maxJsonBodySize), 注释称高默认值是为开箱即用, 可经环境变量收紧                                            |
| 8    | apiRouter                   | /api/health (返回根 package.json 的 version 字段) 与 22 个子路由                                                                              |
| 9    | ALL /functions/:slug        | 边缘函数反向代理: 优先 Deno Deploy 部署 URL, 回退本地 Deno runtime; 注释标注该路径为兜底, SDK 会直连边缘函数                                  |
| 10   | 静态前端或 404              | dist/frontend 存在则托管 SPA, 否则 REST 风格 404 (带 nextActions 字段)                                                                        |
| 11   | errorMiddleware             | 统一错误出口                                                                                                                                  |
| 12   | seedBackend()               | 播种初始数据 (backend/src/utils/seed.ts), 控制台打印 Dashboard 地址提示                                                                       |

apiRouter.use 挂载的 22 个子路由 (server.ts): auth, database, storage, metadata, logs, docs, functions, secrets, usage, ai, memory, realtime, email, deployments, schedules, payments, compute/services, analytics, github, webscraper, advisor, dashboard。JWKS 端点注册了两次: 根路径 /.well-known/jwks.json 与 /api/.well-known/jwks.json, 同一个 handler 返回 TokenManager 的公钥集。/api/health 返回 status/version/service/timestamp, version 取自根 package.json — 这正是 MCP 版本门控的数据源。

initializeServer() 在 listen 之前先做 ComputeConfigService.primeSnapshot() (server.ts 注释: 赶在监听端口前完成, 避免任何请求用纯环境变量构造 compute registry; 失败不阻塞启动), 之后按序: app.listen (默认 7130, appConfig.app.port 由 PORT 环境变量解析) → keepAliveTimeout (默认 65000ms, .env.example 注释要求高于前置 LB 的空闲超时) 与 headersTimeout (keepAlive+1000) → SocketManager.initialize(server) 挂 Socket.IO → RealtimeManager.initialize() 起 pg_notify 监听 → FunctionService.syncDeployment() 非阻塞同步边缘函数到 Deno Deploy → compute 驱动探活与状态自愈 (非阻塞, 注释明确 compute 是可选功能, 不许拖住服务; 并先 resetForConfigChange 载入已保存的 Fly 凭据) → TelemetryService.start() → 非云环境启动 DatabaseBackupService 定时备份调度器 (云环境备份由控制面负责, 备份路由在云环境根本不挂载)。SIGINT/SIGTERM 触发 cleanup(): 依次停备份调度器、关 RealtimeManager、关 Socket.IO、销毁 OAuth PKCE 服务、关遥测、清邮件冷却定时器, 最后 process.exit(0)。

## 五、鉴权与安全模型

### 5.1 三种凭据、按形状分派

backend/src/api/middlewares/auth.ts 的 verifyUser 是核心分派器, 注释写明"按凭据形状分派, 绝不失败后回退":

```typescript
// backend/src/api/middlewares/auth.ts verifyUser
const apiKey = extractApiKey(req); // Bearer ik_... 或 x-api-key 头
if (apiKey) return verifyApiKey(req, res, next);

const bearerToken = extractBearerToken(req.headers.authorization);
if (bearerToken && bearerToken.startsWith("anon_")) {
  return verifyAnonKey(req, res, next); // 不透明匿名 key → anon 角色
}
return verifyToken(req, res, next); // 其余一律走 JWT 验证
```

| 凭据         | 形状                                              | 验证方                      | 得到身份                                                                                                                          |
| ------------ | ------------------------------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 管理 API key | ik_ 前缀 (Bearer 或 x-api-key 头, 后者为兼容保留) | SecretService.verifyApiKey  | req.authenticated + req.hasApiKey, 管理权限                                                                                       |
| 匿名 key     | Bearer anon_ 前缀                                 | SecretService.verifyAnonKey | UserContext 中 sub 为字符串 anonymous, role 为 anon; 注释强调 sub 不会到达数据库, auth.uid() 为 NULL, 身份型 RLS 策略 fail closed |
| 用户 JWT     | 其他 Bearer                                       | TokenManager.verifyToken    | sub/email/role, role 取自 claim, 缺省 authenticated                                                                               |

每条分支 fail closed: 无效或过期的用户 JWT 必须返回 401 (让 SDK 触发 refresh 流程), 绝不静默降级成 anon — 这是 verifyUser 文档注释里的原话。verifyAdmin 在此之上多认一种凭据: 未验证解码后 type claim 为 project_authorization 的 token 走 verifyCloudProjectAuthorization (云签发的项目授权), 得到 project_admin 角色且 sub 形如 cloud:userId; 注释强调 type claim 只用来选验证器, 云验证失败绝不回退本地 JWT 验证。另有 verifyCloudBackend 中间件给云端回调路由用 (校验 JWKS + projectId claim 后把 projectId 放进 req)。

UserContext 的 id 语义在类型注释里写得很细 (auth.ts 顶部): authenticated 的 UUID 是唯一可作为行属主的身份; admin id 与 anonymous 只是 API 层标签, 数据库边界 (claims、owner 列) 只认 role === 'authenticated'。

### 5.2 TokenManager: 双算法 JWT + JWKS + CSRF

backend/src/infra/security/token.manager.ts (单例):

- 签发: RS256 密钥对 (kid 标识), 公钥经 getJwks() 以 JWK Set 形式导出 (alg RS256, use sig), 挂 /.well-known/jwks.json;
- 验证 verifyToken: header 带 kid 且 alg 为 RS256 且 kid 匹配时用公钥验证; 否则回退 HS256 + JWT_SECRET (兼容旧 token 与 PostgREST 场景); 两条路径都强制要求 sub 存在;
- generatePostgrestAnonToken: HS256、payload 只有 role anon、不带 expiresIn 永不过期 — 给 PostgREST 的匿名访问 token, 注释说明旧客户端持有型 anon JWT 继续走普通验证路径;
- signCloudToken: 仅云环境可用 (否则抛 AppError), 用项目的 JWT_SECRET 签 sub=projectId 的 10 分钟短票, 用于回调 api.insforge.dev; PROJECT_ID 未配置或为 local 时拒绝签发, 注释解释"离开我们的基础设施就不存在这种信任关系, 宁可拒绝也不签一个注定远程失败的 token";
- verifyCloudToken: 用 jose 的 jwtVerify + 云端 JWKS 验证 api.insforge.dev 签发的 token, 允许 RS256/384/512 与 ES256/384/512, 并校验 projectId claim 与本机 PROJECT_ID 一致;
- verifyCloudProjectAuthorization: 要求 type 恰为 project_authorization 且 userId 非空, 是云授权凭据的统一边界。

CSRF 保护 refresh 会话:

```typescript
// backend/src/infra/security/token.manager.ts
generateCsrfToken(payload: RefreshTokenPayload): string {
  return crypto
    .createHmac('sha256', JWT_SECRET)
    .update(`insforge:csrf:v1:${payload.sessionType}:${payload.sub}:${payload.csrfNonce}`)
    .digest('hex');
}
```

verifyCsrfToken 以 crypto.timingSafeEqual 比较请求头与重算值, 不匹配抛 403; nonce 是 32 字节 base64url 随机数 (generateCsrfNonce)。refresh 会话 payload 由 createRefreshTokenPayload 构造: sub 为 userId, type 为 refresh, iss 为 insforge, 携带 csrfNonce 与 sessionType。配套路由在 backend/src/api/routes/auth/admin.routes.ts (POST /admin/sessions、/admin/sessions/exchange、/admin/refresh、/admin/logout) 与 index.routes.ts (POST /refresh、/logout), codegraph 调用图显示它们都经 generateRefreshTokenWithCsrf → verifyCsrfToken 闭环。

Socket.IO 握手鉴权 (backend/src/infra/socket/socket.manager.ts setupMiddleware) 复刻同一套分派: API key 有效则 id 为 api-key、role 为 project_admin; anon_ key 有效则 id 为 anonymous、role 为 anon, presence 类型标记 anonymous; key 提供了但无效直接拒绝, 注释强调"绝不 fall through 到 JWT 路径"。

### 5.3 会话端点契约 (openapi/auth.yaml, 38 个路径)

POST /api/auth/sessions 是登录端点, 支持密码或邮箱 OTP 两种方式 (method 缺省 password)。client_type 查询参数取 web/mobile/desktop/server: web 客户端的 refresh token 进 httpOnly cookie 并在响应里返回 csrfToken, 其余客户端直接在响应体返回 refreshToken。OTP 登录对未知邮箱的处理有明确规则: 公开注册开启时自动创建已验证的无密码用户; 关闭时有效验证码被消费但返回 403。POST /api/auth/users 是公开注册端点, disableSignup 配置开启时公开注册 (含首次 OAuth) 返回 403 AUTH_SIGNUP_DISABLED, 管理员鉴权的建户不受影响 (auth.yaml 对应 description 原文)。

OAuth 面 (auth.yaml paths + backend/src/api/routes/auth/oauth.routes.ts / custom-oauth.routes.ts): 内置 provider 枚举为 google, github, discord, linkedin, facebook, instagram, tiktok, apple, x, spotify, microsoft 共 11 家, 另有 custom OAuth 配置端点 (/api/auth/oauth/custom/*) 与 native client id 支持 (migration 062_add-oauth-native-client-ids.sql), PKCE 服务在 backend/src/services/auth/oauth-pkce.service.ts。邮件侧端点覆盖 send-otp、send-verification、verify-link、verify、send-reset-password、exchange-reset-password-token、reset-password-link、reset-password, 即验证码与魔法链接双通道 (verifyEmailMethod/resetPasswordMethod 枚举 code|link)。管理端点 /api/auth/admin/sessions 与 /api/auth/admin/sessions/exchange 对应 dashboard 登录的会话兑换。根目录 GITHUB_OAUTH_SETUP.md 与 GOOGLE_OAUTH_SETUP.md 是两份 OAuth 应用配置指南。

## 六、数据库产品域

### 6.1 系统迁移: 67 个 SQL 文件

backend/src/infra/database/migrations/ 下 67 个 .sql (编号 000 至 064, 其中 033 与 047 各有两个同号文件) + bootstrap 目录 (bootstrap-migrations.js 与 baseline-migrations.js)。迁移工具是 node-pg-migrate, npm scripts 固定参数 --migrations-schema system --migrations-table migrations, migrate:up 前先跑 migrate:bootstrap; migrate:create 生成新迁移, backend/scripts/check-migration-duplicates.js 查重复编号。完整清单:

```text
000_create-base-tables                        001_create-helper-functions
002_rename-auth-tables                        003_create-users-table
004_add-reload-postgrest-func                 005_enable-project-admin-modify-users
006_modify-ai-usage-table                     007_drop-metadata-table
008_add-system-tables                         009_add-function-secrets
010_modify-ai-config-modalities               011_refactor-secrets-table
012_add-storage-uploaded-by                   013_create-auth-schema-functions
014_add-updated-at-trigger-user-table         015_create-auth-config-and-email-otp-tables
016_update-auth-config-and-email-otp          017_create-realtime-schema
018_schema-rework                             019_create-deployments-table
020_add-audio-modality                        021_create-schedules-schema
022_create-function-deployments               023_ai-configs-soft-delete
024_add-realtime-message-retention            025_create-storage-config-table
026_create-custom-oauth-configs               027_add-redirect-url-whitelist
028_secure-schedules-encryption-functions     029_create-smtp-config-and-email-templates
030_rename-code-to-token-in-email-templates   031_create-deployment-files
032_create-custom-migrations                  033_create-s3-access-keys
033_relax-custom-migrations-version-check     034_extend-storage-objects-for-s3-protocol
035_fix-secrets-deduplicate-and-unique        036_storage-third-party-auth-support
037_schedules-http-timeout                    038_create-compute-services
039_create-payments-schema                    040_create-payments-customers-table
041_consolidate-retention-jobs                042_add-disable-signup-flag
043_drop-deprecated-ai-configs-and-usage      044_prefer-request-jwt-claims
045_project-admin-public-privileges           046_transfer-public-object-ownership
047_compute-services-add-protocol             047_harden-internal-runtime-defaults
048_project-admin-database-create-privilege   049_add-multi-provider-payments-foundation
050_create-memory-schema                      051_create-database-backups
052_add-s3-cors-tagging-versioning            053_fix-realtime-channel-name-helper
054_grant-system-database-backups-select      055_grant-internal-schema-select-defaults
056_expose-custom-schemas-to-postgrest        057_create-database-advisor
058_compute-services-add-scale-to-zero        059_create-advisor-suppressions
060_add-email-otp-sign-in                     061_add-database-config
062_add-oauth-native-client-ids               063_reassign-root-owned-public-objects
064_compute-services-multi-driver
```

迁移史就是产品演进史: 021 引入 schedules, 022 函数部署, 026 自定义 OAuth, 031 部署文件表, 033 S3 access key, 034/052 S3 协议与 CORS/tagging/versioning, 038/047/058/064 compute 四连, 039/040/049 支付, 050 memory, 051 备份, 057/059 database advisor, 060 OTP 登录。Postgres 扩展 pg_cron、http、pgcrypto 由定制镜像 ghcr.io/insforge/postgres:v15.13.4 提供 (deploy/Dockerfile.postgres 是其构建文件)。

### 6.2 数据面: PostgREST 代理

用户表的 CRUD 不经过后端手写 SQL, 而是转发 PostgREST。backend/src/api/routes/database/records.routes.ts 的 forwardToPostgrest 用 axios 把 /api/database/records/:tableName/:path* 转成对 PostgREST 的请求, 转发前做表名校验 (validateTableName), 并按 PostgREST 原生方式解析 schema: 显式 ?schema= 查询参数被翻译成 Accept-Profile/Content-Profile 头再从转发查询串里剥掉, 客户端自带的 profile 头原样尊重 (函数内注释原文)。PostgREST 连接池参数在 app.config.ts database 段: POSTGREST_MAX_SOCKETS 默认 50, .env.example 注释要求与 PGRST_DB_POOL 对齐 — 超过池子只是把排队挪进 PostgREST; 空闲 socket 超时默认 4000ms, 必须低于 PostgREST 服务端空闲超时, 否则复用到对端已关闭的连接会 ECONNRESET ("socket hang up")。migration 056 把自定义 schema 暴露给 PostgREST。

### 6.3 控制面: 表管理、raw SQL、备份、advisor

- tables.routes.ts: GET / POST /api/database/tables, GET schema、PATCH 与 DELETE 单表 — 全部 verifyAdmin;
- advance.routes.ts: POST /rawsql (verifyAdmin) 执行裸 SQL, 即 MCP run-raw-sql 工具的落点; POST /export (verifyAdmin) 导出; SQL 解析与语句分析用 libpg-query WASM (单元测试 analyze-query.test.ts);
- backups.routes.ts + DatabaseBackupService (migration 051): 自托管环境的定时备份调度器 (server.ts 仅非云环境启动), runner 镜像为此打包 postgresql16-client, deploy/backup.sh 是独立备份脚本;
- advisor: migration 057/059 建 database advisor 与 suppression 表, backend/src/api/routes/advisor/ 提供路由 — 对应 docs/agent-native/diagnostics.mdx 描述的"agent 读取安全发现 (如过宽的 RLS 策略) 并自行修复"; migration 061 另有 database config 表;
- migrations.routes.ts: GET 迁移列表与两个 POST 端点 (创建/执行自定义迁移, migration 032 建表, 033_relax 放宽版本检查)。

### 6.4 DatabaseManager 元数据

database.manager.ts 提供 getColumnTypeMap (information_schema 查询 + 带过期时间的有界缓存, setBoundedCache 限制 MAX_CACHE_SIZE, 支持按表失效与全量 clear)、getUserTables、getDatabaseSizeInGB、getMetadata (并发取表清单与数据库 GB 大小, 再用 UNION ALL 一次查询拿全部表行数)。MetadataSchema 类型来自 shared-schemas 的 metadata.schema.ts, /api/metadata 与 /api/metadata/:tableName 是 MCP get-backend-metadata 与 get-table-schema 两个工具的落点。

## 七、存储产品域: 双 provider + S3 协议网关

### 7.1 Provider 选择

backend/src/services/storage/storage.service.ts 构造函数按配置二选一:

```typescript
// backend/src/services/storage/storage.service.ts constructor
if (s3Bucket) {
  this.provider = new S3StorageProvider(
    s3Bucket,
    appKey,
    appConfig.storage.s3Region,
    parentAppKey,
  );
} else {
  this.provider = new LocalStorageProvider(appConfig.storage.storageDir);
}
```

LocalStorageProvider (backend/src/providers/storage/local.provider.ts) 是纯文件系统实现: 路径校验防目录穿越 (getValidatedPath), etag 用文件内容 MD5, supportsPresignedUrls() 返回 false, 上传策略退化为走后端代理的 direct 上传。S3 侧支持 AWS 与任意 S3 兼容存储 (README: Wasabi、MinIO、RustFS、R2、腾讯 COS、阿里 OSS 等), S3_ENDPOINT_URL 指自定义端点, S3_USE_PRESIGNED_URLS=false 时走代理模式 (端点浏览器不可达的私网场景)。parentAppKey 触发 branch 模式: 读路径 404 时回退父项目 S3 前缀, 写路径只写分支前缀 — 这是云端 backend branching 的存储层实现 (注释原话)。storage.service.ts 还维护 Postgres 侧的 bucket/object 元数据: CORS 规则、versioning 状态、tagging、listObjectsV2Db 等, 对象字节在 provider 里。

上传 API 面 (storage.yaml): buckets CRUD、objects 列表/上传/下载/删除、upload-strategy 与 download-strategy (协商 presigned 或代理)、confirm-upload 回执, 对象下载 URL 带版本戳 (storage-url-versioning.test.ts)。storage config 与第三方鉴权分别见 migration 025 与 036。

### 7.2 S3 协议网关

backend/src/api/routes/s3-gateway/ 实现了完整的 S3 线协议: dispatch.ts 路由分派, request.ts 请求解析, xml.ts 生成 S3 风格 XML 响应, errors.ts 错误体, 中间件 backend/src/api/middlewares/s3-sigv4.ts 做 AWS SigV4 验签 (tsup 注释提到 lru-cache 就是它的热点缓存), commands/ 下 25 个命令文件按类分组:

| 类别        | 命令                                                                                                |
| ----------- | --------------------------------------------------------------------------------------------------- |
| Object 读写 | put-object, get-object, head-object, copy-object, delete-object, delete-objects                     |
| 分块上传    | create-multipart-upload, upload-part, list-parts, complete-multipart-upload, abort-multipart-upload |
| Bucket      | create-bucket, delete-bucket, head-bucket, list-buckets, get-bucket-location, list-objects-v2       |
| Versioning  | get-bucket-versioning, put-bucket-versioning                                                        |
| CORS        | get-bucket-cors, put-bucket-cors, delete-bucket-cors                                                |
| Tagging     | get-object-tagging, put-object-tagging, delete-object-tagging                                       |

README 宣称配了 S3 后端后可以直接用 aws CLI、rclone 或任意 AWS SDK 打 /storage/v1/s3。S3 access key 的签发管理在 /api/storage/s3/access-keys 端点与 backend/src/services/storage/s3-access-key.service.ts (migration 033)。

## 八、边缘函数: 本地 Deno Worker 沙箱 + Deno Deploy

### 8.1 函数定义与部署链路

函数代码存 Postgres functions.definitions 表 (slug, code, status), 部署记录在 functions.deployments (migration 022_create-function-deployments.sql)。backend/src/services/functions/function.service.ts 的 triggerDeployment 在每次函数 CRUD 后异步触发: 取全部 active 函数与注入用 secrets, 交给 deno-subhosting provider 部署, 状态先记 pending 再轮询 (pollDeploymentStatus)。syncDeployment 在服务启动时跑一次, 已有成功部署就跳过 (server.ts 非阻塞调用)。getDeploymentUrl 查最近一次 status=success 的部署 URL 并做内存缓存。示例函数在 functions/examples/ (demo-hello-world.js, demo-whoami.js)。

Deno Deploy provider (backend/src/providers/functions/deno-subhosting.provider.ts) 走 Deno Deploy v2 API: ensureApp 保证应用存在 (app slug 统一取 appConfig.cloud.appKey, 注释强调部署/查状态/查日志必须解析同一个 slug, 否则会部署到一个 app 却去轮询另一个), assets 由一个生成的 main.ts 路由器加每个函数的 functions/ 目录下的用户代码文件组成, slug 必须匹配字母数字连字符下划线白名单, 用户代码经 transformUserCode 变换后作为资产; runtime 配置 type dynamic、entrypoint main.ts; v2 的环境变量是 `{key, value}` 数组形态 (v1 是 Record), 通过 Deno.env.get 读取。域名默认 function2.insforge.app (app.config.ts denoSubhosting.domain 注释: CloudFront 代理域, 把 appkey 子域转发到 appkey.insforge.deno.net; v1 域名 functions.insforge.app 可由控制面按部署钉住, 详见 docs/deno-subhosting.md)。凭据为 DENO_DEPLOY_TOKEN + DENO_DEPLOY_ORG_ID, 从旧 DENO_SUBHOSTING_* 更名以便 v1→v2 迁移期两套凭据在 .env 里共存 (app.config.ts 注释)。CHANGELOG 还记录了函数提交前的 deno check 预校验 (1.5.8 feature: add deno check pre-validation for edge functions)。

未配置 Deno Deploy 时函数由本地运行时执行: compose 的 deno 服务跑 functions/server.ts, 主后端 /functions/:slug 代理到 DENO_RUNTIME_URL (默认 http://deno:7133)。

### 8.2 本地运行时的 Worker 隔离

functions/server.ts (Deno, 默认端口 7133, PORT 非法值回退并告警) 每请求新建一个 Web Worker 执行一次即终止 (executeInWorker), worker 代码来自 functions/worker-template.js 加数据库里取出的函数源码, 超时 WORKER_TIMEOUT_MS 默认 60000ms。函数 secrets 从 system.secrets 表取密文, 用 AES-GCM 解密, 密钥是 SHA-256(ENCRYPTION_KEY 或 JWT_SECRET), 密文格式为 iv:authTag:ciphertext 三段 hex — decryptSecret 的实现与 Node 端加密格式互通 (注释: compatible with Node.js encryption)。

worker-template.js 开头是一段 SECURITY BLACKOUT: 在任何 import 发生前用顶层代码把 globalThis.Deno 重定义为只含 mock env 的冻结对象 (get 只返回 NODE_ENV=production, set/delete 抛错, configurable 与 writable 均为 false, 注释标注这是审计发现的加固), process.env 同样被替换成无菌副本, 失败则立即向宿主回 500 并 self.close() — 目的是让函数代码与其依赖库拿不到真实环境变量, 同时避免 debug 之类的库在 env: false 白名单下抛 NotCapable。紧随其后是 EARLY MESSAGE BUFFERING 竞态修复: 宿主 new Worker 后立即 postMessage, 而冷启动的动态 import 可能超过 200ms, Web Worker 不缓冲 handler 注册前到达的消息, 模板先注册同步 onmessage 把早到消息存进 __earlyMessages, import 完成后换真 handler 并排空缓冲 (单线程保证交换与排空间不会漏消息)。

### 8.3 定时任务: pg_cron 而非 Node 定时器

schedules 域完全下沉到数据库 (migration 021_create-schedules-schema.sql): 启用 pg_cron、http、pgcrypto 三个扩展; schedules.jobs 表存 name、cron_schedule、function_url、http_method、encrypted_headers (加密头, 配套 migration 028_secure-schedules-encryption-functions.sql)、body、is_active、cron_job_id; schedules.job_logs 记执行历史与状态码。backend/src/services/schedules/schedule.service.ts 的 validateCronExpression 同时接受两种形式: 5 字段 cron (cron-parser 校验), 或 pg_cron 1.5+ 的秒级 interval 写法 (1-59 秒, 错误信息直接教用户"大于等于 1 分钟请用 5 字段 cron")。API 面: /api/schedules CRUD、/config、`/{id}/logs` (schedules.yaml)。migration 037 增加 HTTP 超时字段。

## 九、其余产品域速览

| 域              | 关键事实 (出处)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Realtime        | backend/src/infra/realtime/realtime.manager.ts: 专用 pg 连接 LISTEN realtime_message (注释: 不能用池化连接), 消息由 SQL 函数 realtime.publish() 发出; 投递双通道 — Socket.IO room 与 webhook HTTP POST (webhook-sender.ts); 断线重连最多 10 次、基础退避 5s; 投递统计写回消息记录; 消息保留策略见 migration 024。服务层拆 auth/channel/message/presence 四个 service; channel 名修复见 053                                                                                                                                                                                                                           |
| AI 网关         | 唯一 provider 是 OpenRouter (backend/src/providers/ai/openrouter.provider.ts): OpenAI SDK client 指向 https://openrouter.ai/api/v1, 请求头带 HTTP-Referer insforge.dev 与 X-Title InsForge; key 解析顺序为云托管 key (仅云环境) → Model Gateway secret store (自托管), 轮换仅云环境可用 (rotateManagedApiKey 显式拒绝自托管); /api/ai 暴露 config、models、overview、provider 级 api-key (含 rotate)、chat/completion、image/generation、embeddings (openapi/ai.yaml 8 个 path); 服务层 chat-completion / embedding / image-generation / ai-model / model-gateway-config 五个 service                                |
| Memory          | backend/src/services/memory/memory.service.ts (migration 050 建 schema): agent 记忆库, 固定用 openai/text-embedding-3-small (1536 维) 与 openai/gpt-4o-mini; 记忆类型 fact/decision/preference/reference; 召回阈值 0.45、去重合并阈值 0.5 (注释: 离线 eval 调优, F1 0.96@0.45 对 0.68@0.35); LLM 输出被视为不可信, sanitizeCandidates 逐条 coerce、UUID 正则校验后才入库                                                                                                                                                                                                                                             |
| Compute         | backend/src/providers/compute/: docker.provider (挂 Docker socket 即启用, compose 注释警告 socket 等同 root、驱动自行构造容器规格不转发调用方选项)、fly.provider (FLY_API_TOKEN + FLY_ORG 齐备自动启用)、cloud.provider (PROJECT_ID + CLOUD_API_HOST + JWT_SECRET 齐备走云代理); ingress 模式 none/port/host 通配域 (COMPUTE_DOMAIN), 发布端口默认只绑 127.0.0.1; 构建上下文有大小上限与上传空闲超时 (COMPUTE_BUILD_MAX_CONTEXT / COMPUTE_BUILD_UPLOAD_IDLE_TIMEOUT, compose 注释解释这是内存边界不只是策略); scale-to-zero 见 migration 058, 多驱动见 064; 私有预览状态 (README Core Products 标注 private preview) |
| Site Deployment | Vercel provider (backend/src/services/deployments/deployment.service.ts): 状态机 WAITING → UPLOADING → QUEUED/BUILDING/READY/ERROR/CANCELED (shared-schemas/deployments.schema.ts 注释); APP_KEY 存在时部署 URL 换成自定义域 appKey.insforge.site; 文件数/总字节/单文件字节三个上限走 appConfig.deployments; 支持 direct 文件上传与 legacy zip 两条路 (MCP 工具描述亦区分 direct-capable 与 older backends); migration 031 建部署文件表                                                                                                                                                                              |
| Payments        | Stripe 与 Razorpay 双 provider (backend/src/providers/payments/), 服务层按渠道再分: stripe 下 checkout/config/customer-portal/price/product/subscription/sync/transaction/webhook 九个 service, razorpay 下 catalog/config/order/subscription/sync/transaction/webhook 七个; webhook-store.service 存原始事件, payments-advisory-lock 用 PG advisory lock 串行化; webhook 路由以 raw body 挂载供签名验证 (server.ts); 多 provider 地基见 migration 049; payments.yaml 是 openapi 里最大的文件 (3854 行)                                                                                                              |
| Email           | provider 二选一: smtp.provider (nodemailer, SMTP 配置存库, migration 029) 或 cloud.provider (云代发); 邮件模板存库可改 (email-templates 端点); OTP/验证/重置邮件全走这里; 有发送冷却定时器 (destroyEmailCooldownInterval 参与优雅退出)                                                                                                                                                                                                                                                                                                                                                                               |
| Logs            | provider 双实现: CloudWatchProvider 与 LocalFileProvider (backend/src/providers/logs/, 共同基类 BaseLogProvider); LOGS_DIR 默认 /insforge-logs; /api/logs 查询端点在请求日志中间件里被特意跳过防循环                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Secrets         | system.secrets 表存 AES-GCM 密文 (backend/src/infra/security/encryption.manager.ts), API key 与 anon key 也在此体系内管理, /api/secrets/api-key/rotate 与 /anon-key/rotate 支持轮换 (secrets.yaml); ACCESS_API_KEY/ACCESS_ANON_KEY 未设时后端自动生成一对 (README 自托管章节: "left empty, the backend generates a pair only it knows"); 去重修复见 migration 035                                                                                                                                                                                                                                                    |
| Usage/遥测      | /api/usage/mcp 接收 MCP 工具调用上报, /api/usage/stats 汇总 (usage.yaml); 匿名遥测走 PostHog (telemetry.service.ts): 事件只有 oss_instance_started 与 oss_heartbeat (24h 间隔), CI 环境自动识别, INSFORGE_TELEMETRY_DISABLED=1 或云环境整体关闭 (isTelemetryRuntimeDisabled); FeatureUsageCollector 按请求路径计数功能使用                                                                                                                                                                                                                                                                                           |
| 其他            | webscraper (Apify 集成, apify-config.service.test.ts)、analytics (posthog 三件套 schema)、github 路由、dashboard events (产品内埋点)、docs 路由 (见第十一节)                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

## 十、前端与共享包

### 10.1 frontend: 双模式宿主壳

frontend/package.json name 为 insforge-dashboard, 自我描述是 "Self-hosting host app for the shared InsForge dashboard package" — 它只是壳, 依赖仅 @insforge/dashboard + react/react-dom。frontend/src/App.tsx 全部逻辑:

```tsx
// frontend/src/App.tsx
function App() {
  if (isCloudHosting()) return <CloudHostingDashboard />;
  return <SelfHostingDashboard />;
}
```

cloud-hosting 目录含 CloudHostingDashboard.tsx、partner.service.ts、useCloudHosting.ts (云控制台与伙伴体系), self-hosting 目录只有 SelfHostingDashboard.tsx (挂载共享 dashboard 包)。开发工具链: Vite 8 + @vitejs/plugin-react + @tailwindcss/vite + vite-plugin-svgr。

### 10.2 packages/dashboard: 可发布的共享 dashboard

@insforge/dashboard 版本 0.0.0-dev.11 (尚未 1.0, 但 publishConfig access public 且定位是"self-hosting 与 cloud-hosting 两种宿主的共享 dashboard 包"), package.json 用 Node subpath imports 组织内部结构: #app/_、#assets/_、#components(/)、#features/_、#layout/_、#lib/_、#navigation/_、#router/*、#types(/), exports 仅 "." 与 "./styles.css" (sideEffects 声明样式表)。

src/features 按产品域切 15 个目录: ai, analytics, auth, compute, dashboard, database, deployments, functions, login, logs, payments, realtime, storage, visualizer, webscraper。路由在 src/router/AppRoutes.tsx: /dashboard/login 与 /cloud/login 两个公开页, 其余全部包在 RequireAuth 里; AuthenticatedRoutes 内 /dashboard 嵌套数据库子路由 (migrations、backups 等), /dashboard/sql-editor 与 /dashboard/storage 各有独立 Layout; 首页组件由 PostHog feature flag DASHBOARD_V4_EXPERIMENT 决定 (D_TEST 变体渲染 DTestDashboardPage) — dashboard 在做 A/B 改版。数据访问统一走 src/lib/api/client.ts 的 ApiClient (apiClient.request + withAccessToken), 例如 compute 服务层全部以 /compute/services 前缀请求。编辑器组件依赖 CodeMirror (lang-javascript/lang-python/lang-sql) 与 Radix UI 原语。测试配置分 unit/component 两套 vitest config 外加 playwright.config.ts; 构建为 vite build + tsc -p tsconfig.build.json 双步。

### 10.3 packages/shared-schemas 与 packages/ui

@insforge/shared-schemas 1.2.0 是前后端与 MCP 三方的契约层: 38 个文件, 模式是"域 schema + 域 API schema"成对出现 (如 database.schema.ts 与 database-api.schema.ts), 域覆盖 ai、auth、compute-services、database、deployments、email、functions、logs、memory、payments、realtime、schedules、secrets、storage、webscraper、posthog、dashboard-events、agent-telemetry、cloud-events, 外加 metadata.schema.ts、s3-access-key.schema.ts、docs.schema.ts、error-codes.schema.ts (ERROR_CODES 枚举, 后端每个 AppError 都带) 与 index.ts 汇总; 唯一运行时依赖 zod ^3.23.8; 构建就是 tsc, prepare 钩子保证被安装时先编译。

@insforge/ui 0.1.9: "React UI component library, design tokens, and Tailwind preset", src 下 components/lib/styles.css/test, 附 tailwind-preset.js 供宿主 Tailwind 4 消费, 测试同样分 vitest unit/component 两套配置。

## 十一、OpenAPI 契约与 docs 服务

openapi/ 下 17 个 YAML 共 15015 行, 全部 OpenAPI 3.0.3, 按产品域拆分:

| 文件             | 行数 | 覆盖                                                                                                                                                   |
| ---------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| payments.yaml    | 3854 | Stripe/Razorpay 支付全链                                                                                                                               |
| auth.yaml        | 2571 | 38 个路径: sessions/refresh/logout、admin sessions、tokens/anon、email OTP 全家桶、11 家 OAuth + custom OAuth + id-token、smtp-config、email-templates |
| storage.yaml     | 1519 | bucket/object/upload-strategy/download-strategy/s3 config/access-keys 与 `/storage/v1/s3/{path}` 通配                                                  |
| deployments.yaml | 1099 | 站点部署                                                                                                                                               |
| ai.yaml          | 854  | AI 网关 8 端点                                                                                                                                         |
| realtime.yaml    | 833  | channels/messages/permissions/config                                                                                                                   |
| functions.yaml   | 651  | /api/functions CRUD + `/functions/{slug}` 调用                                                                                                         |
| schedules.yaml   | 620  | 定时任务                                                                                                                                               |
| tables.yaml      | 604  | 表管理与 migrations                                                                                                                                    |
| logs.yaml        | 591  | 日志查询                                                                                                                                               |
| secrets.yaml     | 500  | 密钥与 key 轮换                                                                                                                                        |
| metadata.yaml    | 384  | 元数据 (MCP 工具落点)                                                                                                                                  |
| records.yaml     | 381  | PostgREST 记录代理                                                                                                                                     |
| usage.yaml       | 307  | /api/usage/mcp 与 /api/usage/stats                                                                                                                     |
| email.yaml       | 163  | 邮件发送                                                                                                                                               |
| dashboard.yaml   | 55   | dashboard 事件                                                                                                                                         |
| health.yaml      | 29   | 健康检查                                                                                                                                               |

这些 YAML 与 docs/ 目录 (Mintlify 站点, docs.json 为配置, 主色 #07C983, 默认深色) 一起构成"agent 可读文档面": 后端 /api/docs 路由直接从磁盘读 mdx 返回给调用方。backend/src/api/routes/docs/index.routes.ts 两级端点: GET /api/docs/:docType 走 LEGACY_DOCS_MAP (zod 枚举校验 docType), GET /api/docs/:docFeature/:docLanguage 走 SDK_DOCS_MAP (feature 如 realtime/payments, language 如 typescript/kotlin/rest-api); 文件路径做安全校验 — resolve 后必须落在 docs/ 或 .agents/docs 内, 否则 403; 返回前 processSnippets 展开 mdx 的 snippet 引用。docs/sdks 下有 typescript、kotlin、swift、rest 四种语言的 SDK 文档, 后端 SDK_DOCS_MAP 在 db、storage、functions、auth、ai、realtime 六个 feature 上都映射了全部四种语言, 仅 payments 只有 typescript 一种; docs 站点有 es、zh、zh-Hant 三个 i18n 目录, scripts/check-docs-i18n-parity.sh 与 build-docs-langs.py 维护多语言同步。core-concepts 目录按 12 个产品域组织 (ai、analytics、authentication、compute、database、functions、messaging、payments、realtime、sites、storage、webscraper)。

MCP 的 fetch-docs 工具就是打 GET /api/docs/instructions, fetch-sdk-docs 打 feature/language 组合端点 — 后端把"教 agent 用自己"的文档做成了 API。

## 十二、部署形态

### 12.1 自托管主路径: setup.sh + image-only compose

README Quickstart 的一键脚本:

```bash
curl -fsSL https://raw.githubusercontent.com/InsForge/InsForge/main/deploy/setup.sh | sh -s ~/insforge
cd ~/insforge && $EDITOR .env && docker compose up -d
```

deploy/setup.sh (POSIX sh) 的行为: 克隆或 HTTPS 拉取 image-only 栈所需文件清单 (git 路径支持 sparse checkout 与 INSFORGE_REF 指定 tag/branch/commit, INSFORGE_NO_GIT=1 退化为纯 HTTPS 拉取但失去更新通道; RAW 地址从 REPO 推导, fork 不会静默拉官方文件); 生成 JWT_SECRET、ENCRYPTION_KEY、POSTGRES_PASSWORD、ROOT_ADMIN_PASSWORD 与两个 access key 写入 .env (mode 600); 幂等 — 重跑保留已设值, 只补写或纠正 COMPOSE_FILE; 不启动任何服务。COMPOSE_FILE 指向 deploy/docker-compose/docker-compose.yml, 该文件四个服务全部用现成镜像: ghcr.io/insforge/insforge-oss:latest、ghcr.io/insforge/postgres:v15.13.4、postgrest/postgrest:v12.2.12、denoland/deno:alpine-2.0.6。

多实例: 每项目一个目录跑 setup.sh, .env 里必须改 COMPOSE_PROJECT_NAME (README 警告: 两个目录同名会共享容器, 第二次 up 会按第二份配置重建第一份的容器), 并按 README 示例错开 POSTGRES_PORT/POSTGREST_PORT/APP_PORT/AUTH_PORT/DENO_PORT 五个端口。

从源码构建的路径用根目录 docker-compose.prod.yml (与开发 compose 读同一组变量但不生成任何 secret, README 要求暴露公网前自行设置)。

### 12.2 存储 overlay 与 PaaS

- docker-compose.minio.yml: 捆绑 MinIO, store 留在 Docker 内网; docker-compose.rustfs.yml: Apache-2.0 的 RustFS 替代。用法是往 COMPOSE_FILE 追加冒号分隔的 overlay (README: 只能保留一行, 该文件按 shell 赋值语义读取)。overlay 自带默认凭据, 生产前必须改 MINIO_ROOT_USER/PASSWORD 或 RUSTFS_ACCESS_KEY/SECRET_KEY;
- 自带 S3 兼容存储: 设 S3_BUCKET/S3_REGION/S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY (+ 非 AWS 加 S3_ENDPOINT_URL);
- deploy/coolify/docker-compose.yml 与 deploy/dokploy/docker-compose.yml: 两个自托管 PaaS 的模板; deploy/zeabur/template.yml + README.md: Zeabur 模板; deploy/buttons: 部署按钮素材;
- README 一键部署矩阵: Railway、Zeabur、Sealos、RepoCloud、ZopDay 五家 (ZopDay 直接用 ghcr.io/insforge/insforge-oss:latest 镜像 + 7130 端口);
- deploy/Dockerfile.deno 与 deploy/Dockerfile.postgres: 定制 deno/postgres 镜像的构建文件; deploy/backup.sh: 备份脚本; deploy/docker-init/db: db-init.sql、jwt.sql、postgresql.conf 三个初始化挂载件。

### 12.3 云/自托管双态开关

代码里大量行为由 isCloudEnvironment() (backend/src/utils/environment.ts) 切换: 根路径重定向到 /dashboard/login 仅非云; 备份调度器仅非云; OpenRouter key 轮换仅云; signCloudToken 仅云; 遥测在云环境整体关闭 (云上另有控制面遥测)。PROJECT_ID/APP_KEY/CLOUD_API_HOST/DEPLOYMENT_ID/PARENT_APP_KEY 等变量构成云多租户身份, 存储 branch 模式、compute cloud provider、云 token 验证都挂在这组变量上。同一套 OSS 代码即云控制面下发的项目运行时。.env.example 约 450 行, 注释密度极高, 大量条目直接解释参数间的耦合约束 (PostgREST 池对齐、keep-alive 与 LB 超时、compose 项目名语义), 本身就是自托管运维手册。

## 十三、Agent 原生配套 (docs / skills / plugin)

- docs/agent-native/: overview、cli-harness、config-as-code、branching、diagnostics、vscode-extension 六篇。overview 描述的标准工作循环: `npx @insforge/cli metadata` 读现状 → 开 backend branch 写迁移或改 insforge.toml → `cli db migrations up --all` 或 `config apply` 先打分支再打父项目 → `cli diagnose` (可加 --ai 解读) 查 advisor 发现与错误日志 → 修复、复查、合并分支。CLI 与 Skills 是云端专属通道 (README: CLI + Skills, cloud only);
- .agents/skills/insforge-dev/: 面向 InsForge 维护者自己的 skill 集 (SKILL.md + backend/dashboard/docs/e2e-testing/shared-schemas/ui 六个子 skill), 内容是本仓库的贡献纪律: 包边界判定 (backend 是 API/auth/database/providers/realtime/schedules; packages/dashboard 是可发布 dashboard; frontend 是挂载它的本地壳)、代码放最窄正确层、ESM .js 后缀约定; docs/DOCS_I18N.md 管多语言文档规则; e2e-testing 是跨仓库发布流程 skill;
- .claude-plugin/marketplace.json: 把本仓库注册为 Claude Code plugin marketplace, 插件 insforge v1.2.0 的源指向另一个仓库 InsForge/insforge-skills, 描述覆盖 database CRUD with RLS、auth、storage、edge functions、AI、realtime、Stripe payments、deployments、CLI 基础设施管理与 Auth0/Clerk/Kinde/Stytch/WorkOS 集成指南;
- CLAUDE_PLUGIN.md、CONTRIBUTING.md、SECURITY.md、CODE_OF_CONDUCT.md 齐备; examples/ 有 oauth、python-ml-experiment-tracker 与 response-examples.md。

## 十四、测试与工程纪律 (主仓库)

backend/tests 分 unit (207 个 *.test.ts 文件, 其中 10 个在 compute/ 子目录)、integration、cloud、local、manual 五类, 配 run-all-tests.sh (npm run test:e2e 入口)、preflight.sh、cleanup-all-test-data.sh 与 test-config.sh; vitest 承担 unit/integration (test:integration 单独 30s 超时), supertest 打 HTTP 层, devDependency 里有 insforge-test ^0.2.0 (自家测试辅助包)。单元测试文件名透露了大量回归场景: ai-streaming-token-double-count.reproduction.test.ts (流式 token 重复计数的复现测试)、token-manager-csrf / token-manager-jwks / cloud-token、s3-gateway-cors-tagging-versioning、s3-gateway-list-objects-v2、storage-url-versioning、verify-admin、schedule.service.delete-not-found、app.config.test.ts 等。

根目录 eslint.config.js (9KB) + prettier + typescript-eslint; CI 在 .github 下; .prettierignore 单独维护。CHANGELOG 由 release-please 风格自动生成 (compare 链接 + conventional commits)。仓库还有 .gstack、.idea、.codex、.claude、.archive 等工具目录未纳入本文范围。

## 十五、insforge-mcp: 包结构与双传输

### 15.1 包定义

@insforge/mcp 1.2.12 (insforge-mcp/package.json):

- bin 三个入口: mcp 与 insforge-mcp 都指 dist/index.js (stdio), insforge-mcp-server 指 dist/http-server.js (HTTP);
- npm start 即 `node dist/http-server.js --host 0.0.0.0`; dev:stdio 用 tsx watch src/stdio/index.ts, dev:http 用 tsx watch src/http/server.ts;
- 依赖: @modelcontextprotocol/sdk ^1.27.1、express ^5.1.0 (注意主仓库后端是 Express 4, MCP 用 5)、@insforge/shared-schemas 精确钉死 1.1.49、commander (CLI 参数)、archiver (zip 部署)、form-data、node-fetch、zod ^3.23.8、mixpanel (HTTP 模式分析)、dotenv;
- overrides 段钉了十余个传递依赖下限 (hono、lodash、qs、rollup、esbuild、brace-expansion、minimatch 等), 是供应链加固;
- files 只发布 dist、mcp.json、server.json; server.json 遵循 MCP registry schema (2025-12-11), 声明远程端点 https://mcp.insforge.dev/mcp (streamable-http) 与 npm 包 stdio 传输, 必填环境变量 API_KEY (isSecret) 与 API_BASE_URL; mcp.json 与 glama.json 署名维护者 InsForge 与 tonychang04;
- 构建 tsup, 测试 vitest (含 coverage), verify:deploy 与 verify:paths 两个发布前校验脚本 (scripts/verify-deploy.mjs、verify-platform-paths.mjs, 另有 verify-handshake.mjs)。

安装通道 (README): 自动安装用 `npx @insforge/install --client <客户端> --env API_KEY=... --env API_BASE_URL=...`, 支持 claude-code、cursor、windsurf、cline、roocode、trae 六种客户端, --dev 装 dev tag; 手动安装把 mcpServers 配置写进客户端设置, command 为 npx -y @insforge/mcp@latest。

### 15.2 stdio 入口

src/stdio/index.ts 全文 54 行: commander 解析 --api_key 与 --api_base_url, new McpServer (name insforge-mcp), registerInsforgeTools(sdkToolHost(server), `{ mode: 'local' }`) 完成后才 connect StdioServerTransport — 注释明确"注册完再接传输"; 启动信息全部走 console.error, stdout 留给 MCP 协议。

### 15.3 工具注册内核

src/shared/tools/index.ts 的 registerInsforgeTools 是两种传输共享的装配器, 几个关键机制:

1. 强制健康检查: fetchBackendVersion 打 GET `{API_BASE_URL}/api/health` (10 秒 AbortController 超时), 后端不可达直接抛错终止注册 (错误信息带超时提示 "is the backend running at ...");
2. ToolHost 抽象 (src/shared/tools/host.ts): 工具层只依赖 registerTool(name, description, inputSchema, handler) 四参契约, sdkToolHost() 把它适配到 MCP SDK 的 server.tool — 注释说明这个缝是为换底层 server 实现准备的;
3. 版本门控:

```typescript
// src/shared/tools/index.ts
const TOOL_VERSION_REQUIREMENTS: Record<string, ToolVersionRequirement> = {
  "create-deployment": { minVersion: "1.4.7" },
  "fetch-sdk-docs": { minVersion: "1.5.1" },
};
const LOCAL_ONLY_TOOLS = new Set(["bulk-upsert"]);
```

compareVersions 自实现 semver 比较, 剥 v 前缀与预发布段; 不满足的工具跳过注册并向 stderr 说明原因 (requires backend 或 deprecated);

4. remote 模式裁剪: LOCAL_ONLY_TOOLS 里的 bulk-upsert 在 remote 模式跳过 (需要读本地文件);
5. 用量上报: withUsageTracking 包装每个 handler, 成功与结构化错误 (isError true) 都上报, fire-and-forget; UsageTracker (src/shared/usage-tracker.ts) POST 到 `{API_BASE_URL}/api/usage/mcp`, payload 为 tool_name/success/timestamp, 首次调用附带一次性 agent-connected 上报; parseAppKey 从形如 `https://{app-key}.{region}.insforge.app` 的 URL 提取项目 key (PLATFORM_API_BASE 为 https://api.insforge.dev);
6. 凭据语义: getApiKey 在 remote 模式刻意忽略调用方传入的 per-call apiKey — 注释解释远程会话的凭据在登录时绑定, 接受调用方替换会让会话凭据失去权威性; local (stdio) 模式允许 per-call key 覆盖全局 key;
7. 旧后端补偿: addBackgroundContext 在后端版本低于 1.1.7 时自动拉 GET /api/docs/instructions 并把 INSFORGE DEVELOPMENT RULES 附加到每个工具响应尾部 (新版后端由 SDK/skills 承担此职责)。

## 十六、insforge-mcp: 18 个工具的面板

工具按域分布在五个注册器 (registerDocsTools / registerDatabaseTools / registerStorageTools / registerFunctionTools / registerDeploymentTools, src/shared/tools/index.ts 尾部按此顺序调用)。唯一工具名共 18 个; local stdio 模式实际注册 17 个 (无 start-deployment), remote 模式注册 17 个 (无 bulk-upsert), 再受后端版本门控削减。

| 工具                 | 域 (文件)     | 模式                       | 行为与后端落点                                                                                                                                                                                  |
| -------------------- | ------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| fetch-docs           | docs.ts       | 双模                       | 拉平台文档, 描述标注 instructions 为 MANDATORY FIRST; GET /api/docs/:docType                                                                                                                    |
| fetch-sdk-docs       | docs.ts       | 双模, 后端不低于 1.5.1     | 按 feature+language 拉 SDK 文档; GET /api/docs/:feature/:language                                                                                                                               |
| get-anon-key         | docs.ts       | 双模                       | 生成永不过期的匿名 JWT (需管理 key); POST /api/auth/tokens/anon                                                                                                                                 |
| get-table-schema     | database.ts   | 双模                       | 单表 schema 含 RLS/索引/约束; GET /api/metadata/:tableName                                                                                                                                      |
| get-backend-metadata | database.ts   | 双模                       | 全量后端元数据索引; GET /api/metadata?mcp=true                                                                                                                                                  |
| run-raw-sql          | database.ts   | 双模                       | 裸 SQL 执行, 描述自称 "Admin access required. Use with caution"; POST /api/database/advance/rawsql                                                                                              |
| download-template    | database.ts   | 双模异构                   | local: 先取 anon key, 在临时目录 execFile 执行 `npx create-insforge-app` (校验 projectName 防路径穿越与 shell 注入), 返回拷贝指令; remote: 取 anon key 后返回让 agent 在本地自行执行的 npx 命令 |
| bulk-upsert          | database.ts   | 仅 local                   | 从本地 CSV/JSON 文件批量 upsert (LOCAL_ONLY_TOOLS 注释: filePath 必填)                                                                                                                          |
| create-bucket        | storage.ts    | 双模                       | 建桶; POST /api/storage/buckets                                                                                                                                                                 |
| list-buckets         | storage.ts    | 双模                       | 列桶; GET /api/storage/buckets                                                                                                                                                                  |
| delete-bucket        | storage.ts    | 双模                       | 删桶; DELETE /api/storage/buckets/:name                                                                                                                                                         |
| create-function      | functions.ts  | 双模异构                   | local: 要求代码先写进本地文件再按路径读取 (描述: "for version control"); remote: 直接收内联 code 字符串; Deno 边缘函数创建                                                                      |
| get-function         | functions.ts  | 双模                       | 函数详情含代码                                                                                                                                                                                  |
| update-function      | functions.ts  | 双模异构                   | 同 create 的文件路径/内联代码分叉                                                                                                                                                               |
| delete-function      | functions.ts  | 双模                       | 永久删除                                                                                                                                                                                        |
| get-container-logs   | deployment.ts | 双模                       | 拉最近容器/服务日志, 描述定位为调试工具                                                                                                                                                         |
| create-deployment    | deployment.ts | 双模异构, 后端不低于 1.4.7 | local: zip 打包目录并行 direct 上传 (旧后端回退 legacy zip 流); remote: 准备部署并返回上传指令, direct-capable 后端返回直传命令                                                                 |
| start-deployment     | deployment.ts | 仅 remote                  | 上传完成后触发构建, 描述明言"在执行完 create-deployment 给出的上传命令后调用"                                                                                                                   |

请求侧统一用 x-api-key 头携带凭据 (各 handler 的 fetch headers), 响应统一经 src/shared/response-handler.ts 的 handleApiResponse/formatSuccessMessage 包装成 MCP content 数组; 错误一律返回带 isError: true 的结构化对象。deployment.ts 是最大单文件 (889 行), 内含 createDirectDeploymentSession/uploadDeploymentFileContent/startDeployment 等直传会话逻辑。

src/shared/tools/ 下测试文件覆盖三个要害: api-key-binding.test.ts (remote 模式忽略调用方 key)、published-surface.test.ts (发布工具面快照)、integration-bridge.test.ts, 另有 host.test.ts。src/integration/real-project.test.ts 打真实项目 (INTEGRATION_TEST_ENABLED=true 门控, .env.example 提供模板)。

## 十七、insforge-mcp: HTTP server 与 OAuth 2.1

src/http/server.ts (2053 行) 是远程 MCP 的实现, Express 5 + trust proxy, 端点分四组 (src/http/config.ts):

| 组     | 端点                                                                                                                                                               | 说明                                                        |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| MCP    | /mcp                                                                                                                                                               | StreamableHTTP 主端点: POST 消息、GET SSE 流、DELETE 关会话 |
| 旧协议 | /sse + /messages                                                                                                                                                   | 协议版本 2024-11-05 的 legacy SSE 传输                      |
| OAuth  | /.well-known/oauth-authorization-server (RFC 8414)、/.well-known/oauth-protected-resource、/oauth/register (RFC 7591 动态客户端注册)、/oauth/authorize、token 端点 | 授权服务器元数据、受保护资源元数据、DCR、授权与换票         |
| API    | /health、/api/projects、/api/projects/:projectId/bind                                                                                                              | 健康检查、列项目、把 token 绑定到项目                       |

配置来自环境变量与 CLI: PORT 默认 3000、HOST 默认 127.0.0.1 (npm start 显式 --host 0.0.0.0)、MCP_SERVER_URL (对外公告 URL)、INSFORGE_API_BASE 默认 https://api.insforge.dev、INSFORGE_FRONTEND_URL 默认 https://insforge.dev、INSFORGE_CLIENT_ID/SECRET (平台 OAuth 凭据)、MCP_SSE_KEEPALIVE_MS 默认 25s、MCP_SESSION_SWEEP_MS 默认 5min、MIXPANEL_TOKEN + ENABLE_ANALYTICS 控制分析。未授权请求由 auth-challenge.ts 的 sendUnauthorized + protectedResourceMetadata 按 MCP 规范回 401 与资源元数据。

这套 HTTP server 最有阅读价值的是它的无状态化设计, session-manager.ts 顶部注释把边界讲得很透:

- 客户端注册不是存储, 是签名 client id (oauth-manager.ts 注释提到签名 id 约 171 字符, 上限 4096);
- 授权状态不是存储, 是密封 cookie (auth-state.ts 的 sealAuthState/openAuthState), cookie 里带 handle 与平台回传的 state 参数绑定校验 — "没有这个绑定, 任何带着 cookie 的回调都能通过授权";
- 授权码与 access token 都是密封信封 (sealed envelope); refresh token 捕获与校验在 refresh-token.ts / refresh-token-capture.test.ts;
- 唯独 MCP session 做不到无状态: 它持有一个 McpServer 实例和一条打开的 TCP 连接, 注释原话"连接不能密封进 token, 因为要持久化的不是信息而是 socket"; 并顺带复盘了曾有的 Redis 方案为何被移除 — Redis 只是在连接旁边存了副本, restoreSession 围绕复用的 session id 重建 server 与 transport, 只对重连时发 POST 的客户端有效, 而这种客户端本来就可以重新 initialize;
- 会话 id 是 bearer 凭据, 日志只允许出现 sessionFingerprint (SHA-256 前 8 位), 注释解释运行时日志经 API 暴露, 裸 id 落日志等于凭据落盘。

OAuth 流程本体 (oauth-manager.ts): 对 MCP 客户端做标准授权码 + PKCE (S256), 对 InsForge 平台再发起一层 OAuth (自生成 code verifier/challenge), AuthorizationState 同时保存 MCP 客户端原始请求参数与平台侧 PKCE verifier; 平台 token 的 validateToken/getProjectAccess/getAllUserProjects 走 insforge-api.ts, 支持 exchangePlatformCode/refreshPlatformToken/revokePlatformToken; 多项目用户会看到 renderProjectSelectionPage 渲染的项目选择页 (templates/project-selection.ts); 选定项目后 project-key-cache.ts 缓存项目 key, access token 经 issueAccessToken 签发 (ACCESS_TOKEN_TTL_SECONDS), 会话建立时 registerInsforgeTools 以 mode remote + projectId + accessToken 装配工具。凭据防滥用有 credential-guards.test.ts、session-binding.test.ts、oauth-state-binding.test.ts、session-fingerprint.test.ts 等测试压阵。

## 十八、两仓库协作全景与评估

把两仓库拼起来, 一次典型的 agent 工作流是:

1. 自托管者跑 deploy/setup.sh 生成 .env 并 docker compose up -d, 打开 http://localhost:7130 按引导接 MCP (README 第 2 步);
2. agent 客户端以 npx -y @insforge/mcp@latest + API_KEY/API_BASE_URL 环境变量起 stdio server, 或用 @insforge/install 给六种客户端自动写入配置;
3. MCP 启动即打 /api/health 拿后端版本 (当前为根 package.json 的 2.3.2), 按版本门控注册 17 个工具;
4. agent 先 fetch-docs instructions 学平台约定, download-template 用 create-insforge-app 起前端脚手架 (anon key 自动注入), 之后 run-raw-sql 建表、create-function 部署 Deno 函数、create-deployment 发站点、get-container-logs 排障;
5. 每次工具调用 POST /api/usage/mcp 回流用量, 后端 FeatureUsageCollector 与 PostHog 遥测 (可关) 记录功能使用; 验证安装的官方提示词是让 agent 调 fetch-docs 学习 InsForge 用法 (README 第 3 步)。

工程观感上有三点突出。其一, 注释密度与质量罕见: server.ts 中间件顺序、Dockerfile 每个 apk 包、compose 每个安全开关、MCP session 的无状态边界, 都有解释"为什么"而非"是什么"的长注释, 不少直接写出踩过的坑 (ECONNRESET 的 socket 竞态、worker 冷启动丢消息、pg_dump 17 对 15 服务端的 transaction_timeout)。其二, 安全默认值明确: 三种凭据按形状分派且 fail closed、anon 身份不下传数据库、compute 的 Docker socket 必须显式挂载、发布端口默认绑 127.0.0.1、worker 环境全量 blackout、CSRF 用 timingSafeEqual、MCP remote 拒绝调用方替换会话凭据。其三, agent-native 不是口号而是接口设计: 文档经 /api/docs 变成 API、错误响应统一带 ERROR_CODES 与 nextActions、openapi 目录 17 个 YAML 与 shared-schemas 38 个 zod 文件双轨固化契约、仓库自带 marketplace.json 与 skill 集。

局限与注意点: packages/dashboard 版本号仍是 0.0.0-dev.11, 共享 dashboard 的对外契约未定型; MCP 钉死的 shared-schemas 1.1.49 落后于主仓库的 1.2.0, 跨仓库契约靠版本门控与人工同步; 本地 Deno worker 每请求冷启动且靠环境 blackout 与数据库取码做隔离, 与真正的 V8 isolate 方案 (如 Deno Deploy 侧) 隔离强度不同档; 根 compose 的开发栈在容器内跑 npm install + turbo build, 首次启动成本高, 生产应走 deploy/docker-compose 的 image-only 栈。

## 附录: 本文事实核对清单 (抽样)

| 声明                                                                 | 出处                                                                                                                                           |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 根版本 2.3.2, workspaces backend/frontend/packages/*                 | insforge/package.json                                                                                                                          |
| 中间件顺序: webhooks raw 与 s3 网关在 JSON 解析前                    | backend/src/server.ts createApp 注释与 app.use 序列                                                                                            |
| 三种凭据按形状分派、fail closed                                      | backend/src/api/middlewares/auth.ts verifyUser 及其文档注释                                                                                    |
| CSRF 为 HMAC-SHA256 + timingSafeEqual                                | backend/src/infra/security/token.manager.ts generateCsrfToken/verifyCsrfToken                                                                  |
| pg Pool max 20                                                       | backend/src/infra/database/database.manager.ts initialize                                                                                      |
| 67 个 SQL 迁移, 最后为 064_compute-services-multi-driver             | backend/src/infra/database/migrations/ 目录清单                                                                                                |
| records 经 axios 转发 PostgREST, ?schema= 翻译为 Profile 头          | backend/src/api/routes/database/records.routes.ts forwardToPostgrest                                                                           |
| Storage 双 provider 与 branch 模式                                   | backend/src/services/storage/storage.service.ts constructor 注释                                                                               |
| S3 网关 25 个命令                                                    | backend/src/api/routes/s3-gateway/commands/ 目录清单                                                                                           |
| worker 环境 blackout 与早到消息缓冲                                  | functions/worker-template.js 头两段注释                                                                                                        |
| secrets AES-GCM, 密钥为 SHA-256(ENCRYPTION_KEY 或 JWT_SECRET)        | functions/server.ts decryptSecret/getFunctionSecrets                                                                                           |
| Deno Deploy v2 assets/runtime/env 形态与 function2.insforge.app 域名 | backend/src/providers/functions/deno-subhosting.provider.ts deployFunctions; backend/src/infra/config/app.config.ts denoSubhosting.domain 注释 |
| schedules 依赖 pg_cron/http/pgcrypto                                 | backend/src/infra/database/migrations/021_create-schedules-schema.sql 头注释                                                                   |
| Realtime LISTEN realtime_message 专用连接                            | backend/src/infra/realtime/realtime.manager.ts initialize                                                                                      |
| OpenRouter key 解析顺序与轮换限制                                    | backend/src/providers/ai/openrouter.provider.ts getApiKey/rotateManagedApiKey                                                                  |
| Memory 模型与阈值 (0.45/0.5, F1 注释)                                | backend/src/services/memory/memory.service.ts 常量区                                                                                           |
| Vercel 部署状态机与 appKey.insforge.site                             | packages/shared-schemas/src/deployments.schema.ts; backend/src/services/deployments/deployment.service.ts getDeploymentUrl                     |
| 前端双模式壳                                                         | frontend/src/App.tsx; frontend/package.json description                                                                                        |
| dashboard 15 个 feature 与 PostHog V4 实验 flag                      | packages/dashboard/src/features 目录; packages/dashboard/src/router/AppRoutes.tsx AuthenticatedRoutes                                          |
| openapi 17 文件 15015 行, auth.yaml 38 路径                          | openapi/ 目录 wc -l 与 grep 实测                                                                                                               |
| docs 路由路径穿越防护限 docs/ 与 .agents/docs                        | backend/src/api/routes/docs/index.routes.ts 安全检查段                                                                                         |
| runner 镜像 CMD 先迁移后 exec node                                   | 根 Dockerfile runner 阶段                                                                                                                      |
| setup.sh 生成六个 secret (含两个 access key)、幂等、不启动服务       | deploy/setup.sh gen_secret 调用与头注释; README Quickstart                                                                                     |
| 单测 207 个 (顶层 197 加 compute/ 子目录 10)                         | backend/tests/unit/**/*.test.ts glob 计数                                                                                                      |
| MCP bin 三入口与 start 命令                                          | insforge-mcp/package.json bin/scripts                                                                                                          |
| 健康检查 10s 超时且失败即终止注册                                    | insforge-mcp/src/shared/tools/index.ts fetchBackendVersion/registerInsforgeTools                                                               |
| 版本门控两条与 LOCAL_ONLY_TOOLS                                      | insforge-mcp/src/shared/tools/index.ts TOOL_VERSION_REQUIREMENTS/LOCAL_ONLY_TOOLS                                                              |
| 18 个唯一工具名及 local/remote 分叉                                  | insforge-mcp/src/shared/tools/ 五个注册器逐行核对                                                                                              |
| usage 上报端点 /api/usage/mcp 与 app-key 解析                        | insforge-mcp/src/shared/usage-tracker.ts                                                                                                       |
| OAuth 端点四组与 RFC 编号                                            | insforge-mcp/src/http/config.ts OAUTH_ENDPOINTS/API_ENDPOINTS 注释                                                                             |
| session 不可无状态的论证与 Redis 复盘                                | insforge-mcp/src/http/session-manager.ts 顶部注释                                                                                              |
| 远程端点 mcp.insforge.dev/mcp                                        | insforge-mcp/server.json remotes                                                                                                               |
