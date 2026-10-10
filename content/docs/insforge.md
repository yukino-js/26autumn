---
title: "InsForge: 面向 Coding Agent 的开源 BaaS 平台与其 MCP 工具面"
description: "拆解 InsForge 作为 agent-native 后端平台的产品能力、Express 控制面与 PostgREST 数据面架构、鉴权与安全模型、Deno 边缘函数、S3 协议网关, 以及 insforge-mcp 的工具注册内核与远程 OAuth 设计。"
local_path: "$HOME/Downloads/insforge"
---

InsForge 是一个开源的 BaaS (Backend as a Service) 后端平台, 它把数据库、鉴权、存储、边缘计算、站点部署与 AI 网关打包成一套可自托管的服务, 并按“终端前坐着一个 coding agent”这一前提设计接口。本文面向需要为 Agent 提供后端基座的工程师, 拆解它的进程架构、控制面与数据面的分工、鉴权与安全默认值, 以及配套 MCP Server 的工具面与远程传输设计。阅读本文可以先建立整体能力图, 再按鉴权、数据库、存储、边缘函数、MCP 逐域深入。

## 定位与问题域

传统 BaaS 假设有一个人在 Web 控制台里点击: 建表、配策略、上传文件、看日志。InsForge 的设计前提相反, 它把“可被 Agent 读取与配置”当作一等需求, 具体体现在三处接口设计上:

- 后端能力本身就是 API: 元数据、schema、迁移、日志、文档都以 REST 端点暴露, Agent 不需要解析 HTML 控制台。
- 文档即 API: 平台的开发规范与 SDK 文档存放在磁盘上, 后端直接把文件内容作为 JSON 返回, Agent 用一次 `fetch-docs` 工具调用就能学会平台约定。
- 错误响应结构化: 每个错误都带错误码枚举与后续动作提示, Agent 能据此决定重试、修参数还是改 schema。

这两条接入通道支撑了 Agent 的日常工作: 读取后端上下文与状态 (文档、schema、元数据、运行时日志), 以及配置原语 (部署边缘函数、跑迁移、建存储桶、配 OAuth provider)。MCP 是自托管与云托管通用的通道; CLI 加 Skills 是云托管的增强通道。

在同类方案中的差异可以这样概括:

| 方案                    | 形态                                               | 与 InsForge 的差异                                                                                                                   |
| ----------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Supabase                | 开源 BaaS, Postgres + PostgREST + GoTrue + Storage | 数据面思路相近 (都用 PostgREST), 但 InsForge 把“Agent 工具面”与“文档/元数据 API”作为核心产品, 并额外提供 S3 线协议网关与边缘函数沙箱 |
| Firebase                | 托管 Serverless 后端                               | 强绑定 Google 云与自有数据模型, 自托管能力弱; InsForge 可完全脱离云运行                                                              |
| Appwrite                | 开源 BaaS, 自建 API 层                             | InsForge 的数据接口直接复用 PostgREST 语义, 表 CRUD 与 RLS 策略沿用 Postgres 生态                                                    |
| 自建 Express + Postgres | 全手工                                             | 需要自行实现鉴权、RLS 代理、存储签名、函数运行时、备份与迁移; InsForge 把这些做成开箱即用的产品域                                    |

## 产品能力矩阵

平台对外暴露七块能力, 每一块都有独立的 API 路由、共享 schema 与前端管理页:

| 产品            | 能力要点                                                                                                    |
| --------------- | ----------------------------------------------------------------------------------------------------------- |
| Authentication  | 邮箱密码、邮箱 OTP、魔法链接、11 家内置 OAuth provider 加自定义 OAuth, JWT 与匿名 key, 会话 refresh 与 CSRF |
| Database        | 表管理与 schema 编辑、raw SQL、迁移、备份、database advisor; 用户数据 CRUD 走 PostgREST                     |
| Storage         | 双 provider (S3 与本地文件系统), bucket/object 元数据, 预签名与代理上传协商, 完整 S3 线协议网关             |
| Edge Functions  | Deno 运行时, 本地 Worker 沙箱与 Deno Deploy 双后端, secrets 注入, 定时任务                                  |
| Model Gateway   | 统一 AI 网关, 当前 provider 为 OpenRouter, 覆盖 chat、image、embedding                                      |
| Compute         | 容器化计算驱动 (Docker / Fly / 云代理), 支持端口与域名入口、scale-to-zero                                   |
| Site Deployment | 静态站点部署到 Vercel provider, 直传文件与打包上传两种路径                                                  |

除七块主能力外, 还有 Realtime、Memory、Payments、Email、Logs、Secrets、Analytics、Webscraper 等横向域, 它们共用同一套鉴权、错误码与遥测设施。

## 部署形态与进程架构

### 自托管四容器

官方自托管栈由四个容器组成, 各自职责清晰:

```text
                    ┌──────────────────────────────┐
   agent / SDK ────▶│  insforge (Express 控制面)     │
                    │  7130 API / 7131 AUTH / 7132 UI│
                    └───────┬──────────────┬────────┘
                            │              │
              数据读写转发   │              │  元数据 / 管理操作 (直连 pg)
                            ▼              ▼
                    ┌──────────────┐  ┌──────────────┐
                    │  postgrest   │  │  postgres    │
                    │  v12 (5430)  │  │  v15 (5432)  │
                    └──────────────┘  └──────────────┘
                            ▲
                            │  边缘函数本地执行
                    ┌──────────────┐
                    │  deno (7133) │
                    └──────────────┘
```

| 服务      | 职责                            | 关键契约                                                                                                |
| --------- | ------------------------------- | ------------------------------------------------------------------------------------------------------- |
| postgres  | 定制 Postgres 15 镜像           | 启动参数注入 `app.encryption_key` GUC, 初始化挂载 schema 与 JWT 配置; 内置 pg_cron、http、pgcrypto 扩展 |
| postgrest | 数据面 REST 网关                | 匿名角色为 anon, 与后端共享 JWT secret, 监听 NOTIFY 通道实现 schema 热重载                              |
| insforge  | Express 控制面与 dashboard 前端 | 全部产品逻辑所在地, 静态托管前端并代理边缘函数                                                          |
| deno      | 边缘函数本地运行时              | 每请求新建 Worker 执行一次即终止, 带超时与 secrets 解密                                                 |

控制面是全部产品逻辑所在地: 二十余个子路由挂在 `/api` 下, 数据读写大量转发 PostgREST, 元数据与管理操作直接走 pg 连接池。

### 镜像分发与 PaaS

生产路径是 image-only 栈: 一键脚本克隆一份只含 compose 与初始化文件的目录, 生成 `JWT_SECRET`、`ENCRYPTION_KEY`、`POSTGRES_PASSWORD`、`ROOT_ADMIN_PASSWORD` 与两个 access key 写入 `.env` (权限 600), 脚本本身幂等且不启动任何服务; 四个服务全部使用现成镜像。多实例部署时每个项目一个目录, 必须改 `COMPOSE_PROJECT_NAME` 并错开五个端口, 否则第二个 `up` 会按第二份配置重建第一个项目的容器。

存储层通过 compose overlay 扩展: 可叠加 MinIO 或 RustFS 把对象存储留在 Docker 内网, 也可接任意 S3 兼容服务 (Wasabi、R2、腾讯 COS、阿里 OSS 等), 非 AWS 端点需显式设 `S3_ENDPOINT_URL`。仓库同时提供 Coolify、Dokploy、Zeabur 等自托管 PaaS 模板与一键部署按钮素材。

### 云与自托管双态

同一套 OSS 代码既是自托管产品, 也是云控制面下发的项目运行时, 行为由 `isCloudEnvironment()` 统一切换: 非云环境才重定向根路径到登录页、才启动定时备份调度器; OpenRouter key 轮换与云 token 签发仅云环境可用; 遥测在云环境整体关闭 (云上另有控制面遥测)。`PROJECT_ID`、`APP_KEY`、`CLOUD_API_HOST`、`DEPLOYMENT_ID`、`PARENT_APP_KEY` 这组变量构成云多租户身份, 存储 branch 模式、compute 云代理与云 token 校验都挂在这组变量上。

## Monorepo 结构与构建链

平台是一个 turbo 加 npm workspaces 管理的 monorepo, 工作区为后端、前端与 `packages/*`:

| 目录                    | 职责                                                |
| ----------------------- | --------------------------------------------------- |
| backend                 | 控制面: API、鉴权、数据库、provider、实时、定时任务 |
| frontend                | 双模式宿主壳, 自身只有云与自托管两个入口            |
| packages/dashboard      | 可发布的共享 dashboard, 按产品域组织                |
| packages/shared-schemas | 前后端与 MCP 三方共用的契约层                       |
| packages/ui             | React 组件库、设计令牌与 Tailwind preset            |

根脚本的 dev、build、test、lint、typecheck 全部委托 turbo, 另有并发起前后端调试模式的脚本。turbo 的 build 任务以 `^build` 声明依赖序: 共享包按相互依赖先后编译, 后端构建等齐其声明的依赖; 前端构建任务显式声明不依赖其它任务。后端的构建产物写到仓库根的 `dist/server.js`, 前端产物写到 `dist/frontend`, 生产镜像同时打包两者并由 Express 托管静态前端。测试任务被显式标记为不缓存。

分层纪律写在仓库自带的开发 skill 里, 可以概括为四条: 契约变更先进 shared-schemas; 后端行为按 route 到 service 到 provider/infra 分层; 共享 dashboard 行为进 packages/dashboard; 可复用 UI 原语进 packages/ui。后端 TypeScript 源码统一用 ESM 风格的 `.js` 后缀 import specifier。

Docker 构建利用了这一结构: 构建阶段会先剥掉根 package 的版本字段与工作区声明中的 MCP 条目, 目的是让版本号变化不打破下游 COPY 层的内容缓存; 同时剥掉共享 schema 包的 prepare 与 build 脚本, 避免安装期就触发编译。

## 后端启动序列与中间件栈

`createApp()` 是全栈装配点, 初始化顺序有明确依赖: 先建 pg 连接池 (最大 20 连接, 空闲 30 秒回收, 连接超时 2 秒), 再按配置初始化存储 provider、日志 provider, 最后加载 WASM SQL 解析器。

中间件注册顺序是精心安排的, 顺序本身承载语义:

| 顺序 | 中间件            | 为什么在这个位置                                                                                       |
| ---- | ----------------- | ------------------------------------------------------------------------------------------------------ |
| 1    | CORS              | 全放行 origin 且允许凭证, 显式暴露 `Content-Range` 与 `Preference-Applied` 这两个 PostgREST 风格响应头 |
| 2    | Cookie 解析       | refresh token 走 httpOnly cookie                                                                       |
| 3    | 请求日志          | 覆写响应方法统计字节数, 路径含 `/logs/` 的请求跳过以避免日志端点自我循环                               |
| 4    | 功能用量采集      | 注册在所有路由之前, 才能覆盖 API、S3 网关与边缘函数直呼; 遥测关闭时整段不注册                          |
| 5    | Webhook raw body  | 支付 webhook 必须在 JSON 解析之前拿到原始字节做签名验证                                                |
| 6    | S3 协议网关       | 同样在 JSON 中间件之前挂载, 让请求体原样流过去, 由网关自己处理流式签名                                 |
| 7    | JSON / urlencoded | 默认上限 100MB, 高默认值为开箱即用, 可经环境变量收紧                                                   |
| 8    | 业务路由          | 健康检查与二十余个子路由                                                                               |
| 9    | 边缘函数反向代理  | 优先 Deno Deploy 部署 URL, 回退本地 Deno runtime                                                       |
| 10   | 静态前端或 404    | 前端产物存在则托管 SPA, 否则返回带后续动作字段的 REST 风格 404                                         |
| 11   | 错误中间件        | 统一错误出口                                                                                           |
| 12   | 播种初始数据      | 打印 Dashboard 地址提示                                                                                |

JWKS 端点注册了两次: 根路径与 `/api` 前缀各一个, 返回同一套公钥。健康检查返回的版本字段正是 MCP 做工具注册门控的数据源。

监听端口之前会先做一次 compute 配置快照预取, 避免任何请求用纯环境变量构造驱动注册表, 失败不阻塞启动。随后按序: 监听端口、设置 keep-alive (默认 65 秒, 需高于前置负载均衡的空闲超时) 与 headers 超时、挂 Socket.IO、起 `pg_notify` 监听、非阻塞同步边缘函数到 Deno Deploy、compute 驱动探活与状态自愈、启动遥测, 以及非云环境的定时备份调度器。收到 SIGINT/SIGTERM 时按序清理备份调度器、Realtime 监听、Socket.IO、OAuth PKCE 服务、遥测与邮件冷却定时器, 最后退出。

## 鉴权与安全模型

### 三种凭据按形状分派

核心分派器 `verifyUser` 的原则是“按凭据形状分派, 绝不失败后回退”:

| 凭据         | 形状                                  | 验证方        | 得到的身份                              |
| ------------ | ------------------------------------- | ------------- | --------------------------------------- |
| 管理 API key | `ik_` 前缀 (Bearer 或 `x-api-key` 头) | SecretService | 标记为已认证且持有管理权限              |
| 匿名 key     | Bearer 以 `anon_` 开头                | SecretService | 角色 anon, 主体标识为字符串 `anonymous` |
| 用户 JWT     | 其他 Bearer                           | TokenManager  | 主体、邮箱、角色取自 claim              |

每条分支都 fail closed: 无效或过期的用户 JWT 必须返回 401, 让 SDK 触发 refresh, 绝不静默降级成匿名身份。匿名身份的主体标识不会到达数据库, `auth.uid()` 为 NULL, 因此依赖身份的 RLS 策略自动 fail closed。

管理员校验在此之上多认一种凭据: 未验证解码后 `type` claim 为项目授权类型的 token 走云授权验证器, 得到 `project_admin` 角色。类型 claim 只用来选择验证器, 云侧验证失败绝不回退本地 JWT 验证。用户上下文的语义在类型注释里写得很细: 只有已认证的 UUID 是唯一可作为行属主的身份, 管理员与匿名身份都只是 API 层标签。

### 双算法 JWT、JWKS 与 CSRF

TokenManager 是单例, 承担签发与验证:

- 签发用 RS256 密钥对, 公钥以 JWK Set 形式经 JWKS 端点导出。
- 验证优先走 RS256 公钥路径 (header 带 kid 且与本地 kid 匹配), 否则用 HS256 加共享密钥验证 —— RS256 私钥未加载时签发的 access token、以及转发 PostgREST 用的内部 token 都是 HS256; 两条路径都强制要求主体存在。
- 另一个专供 PostgREST 的匿名 token 用 HS256 签发, payload 只有 anon 角色且永不过期。
- 云 token 签发仅在云环境可用, 用项目密钥签一个主体为项目 ID 的十分钟短票; 项目 ID 未配置或为 `local` 时拒绝签发, 理由是“离开平台基础设施就不存在这种信任关系, 宁可拒绝也不签一个注定远程失败的 token”。
- 云 token 验证用远端 JWKS 并校验项目 ID claim 与本项目 ID 一致, 多种 RSA 与 ECDSA 算法都接受。

Refresh 会话的 CSRF 保护是 HMAC-SHA256: 以共享密钥对“版本前缀 + 会话类型 + 主体 + nonce”做 HMAC, 比较时用 `crypto.timingSafeEqual` 防时序侧信道, 不匹配返回 403。nonce 是 32 字节随机数。会话路由覆盖管理端与普通端的登录、兑换、刷新与登出。

Socket.IO 握手复刻同一套分派: 管理 key 有效则角色为 project_admin, 匿名 key 有效则标记为匿名 presence, key 提供了但无效直接拒绝, 绝不 fall through 到 JWT 路径。

### 会话端点契约

登录端点支持密码与邮箱 OTP 两种方式, `client_type` 决定凭据投递形态: web 客户端的 refresh token 进 httpOnly cookie 并在响应里返回 csrfToken, 其余客户端直接在响应体拿到 refresh token。OTP 登录对未知邮箱有明确规则: 公开注册开启时自动创建已验证的无密码用户, 关闭时有效验证码被消费但返回 403。公开注册端点受 disableSignup 配置控制, 管理员鉴权的建户不受影响。

OAuth 面内置十一家 provider (Google、GitHub、Discord、LinkedIn、Facebook、Instagram、TikTok、Apple、X、Spotify、Microsoft), 另支持自定义 OAuth 配置与原生客户端 ID, PKCE 由独立服务实现。邮件侧覆盖验证码与魔法链接双通道, 端点包括发送 OTP、发送验证、验证链接、验证、发送重置密码、兑换重置密码 token、重置密码链接与重置密码, 即验证码与魔法链接并行。这些端点都有对应的 OpenAPI 契约。

### 会话刷新的完整闭环

refresh 会话的 payload 由固定构造函数生成: 主体为用户 ID, 类型为 refresh, 签发者为平台标识, 携带 CSRF nonce 与会话类型。管理端与普通端各有一组端点:

| 端   | 端点                                | 用途                                                                       |
| ---- | ----------------------------------- | -------------------------------------------------------------------------- |
| 普通 | 创建会话、refresh、logout           | 用户登录与续期 (web 端在 cookie 里带 refresh token 并在响应返回 csrfToken) |
| 管理 | 创建会话、会话兑换、refresh、logout | 控制台登录与会话兑换                                                       |

这些路由都经“生成带 CSRF 的 refresh token”到“校验 CSRF”的闭环, 校验失败即 403。这样一个带时序安全比较的双通道设计, 保证了即使 refresh token 泄露到 cookie 之外也无法在缺少 CSRF 值的情况下换取新会话。

## 数据库产品域

### 数据面: PostgREST 代理

用户表的 CRUD 不经过后端手写 SQL, 而是转发 PostgREST。记录转发路由做三件事:

1. 表名校验, 非法表名统一映射为 400 错误码;
2. 按 PostgREST 原生方式解析 schema —— 显式 `?schema=` 查询参数被翻译成 `Accept-Profile` / `Content-Profile` 请求头并从转发查询串里剥掉, 客户端自带的 profile 头原样尊重;
3. 写入前按列类型过滤空字符串 (非文本类型的空值直接删除, 文本类型保留), 避免把 `""` 写进数值或时间列。

身份决定转发用的凭据: 管理员或持有 API key 的请求走管理员转发, 已认证用户走用户转发, 其余走匿名转发。响应头经过过滤后回传, 空响应体归一成空数组。任何写操作完成后向 dashboard 推送一次数据更新事件。

PostgREST 连接池参数有耦合约束: 转发侧最大 socket 数应与 PostgREST 自身的连接池对齐, 超过池子只是把排队挪进 PostgREST; 空闲 socket 超时必须低于 PostgREST 服务端空闲超时, 否则复用到对端已关闭的连接会触发 `ECONNRESET`。

### 控制面: 表管理、raw SQL、备份与 advisor

- 表管理: 表列表与创建、单表 schema 查询、修改与删除, 全部要求管理员权限。
- raw SQL: 裸 SQL 执行与数据导出, 语句分析用 WASM SQL 解析器; 这是 MCP `run-raw-sql` 工具的落点。
- 备份: 自托管环境启动定时备份调度器, 独立备份脚本复用 pg_dump/pg_restore; 容器镜像为此打包 Postgres 16 客户端, 而服务端是 15 —— 因为 pg_dump 17 以上会输出 15 服务端拒绝的设置项。
- database advisor: 维护安全发现与 suppression 表, Agent 可以读取安全发现 (例如过宽的 RLS 策略) 并自行修复; 另有数据库配置表。
- 迁移: 迁移列表查询与自定义迁移的创建与执行。

### 列类型与 schema 编辑

控制台建表时用户选的逻辑列类型会映射到固定的 Postgres 类型, 这张映射表就是“前端类型到 DDL”的单一定义源:

| 逻辑类型 | Postgres 类型    | 默认值            |
| -------- | ---------------- | ----------------- |
| string   | TEXT             | 无                |
| date     | DATE             | now()             |
| datetime | TIMESTAMPTZ      | now()             |
| integer  | INTEGER          | 无                |
| float    | DOUBLE PRECISION | 无                |
| boolean  | BOOLEAN          | false             |
| uuid     | UUID             | gen_random_uuid() |
| json     | JSONB            | 无                |

外键定义单独建模, 支持级联删除与更新的几种动作 (CASCADE、SET NULL、RESTRICT、NO ACTION)。列信息从 information_schema 读回后归一成内部结构, 供前端渲染与后端转发过滤共同使用。这套“逻辑类型 → DDL → 反向归一”的闭环, 保证了控制面在用户修改表结构后仍能正确判断列的文本类与非文本类行为。

### 元数据与迁移体系

元数据管理层提供列类型映射 (带过期时间的有界缓存, 支持按表失效与全量清理)、用户表清单、数据库体积与全表行数统计 (一次 UNION ALL 查询拿全部表计数)。这些能力对应 MCP 的 `get-backend-metadata` 与 `get-table-schema` 两个工具。

系统迁移用 node-pg-migrate, 固定使用独立的迁移 schema (`system`) 与迁移表; 启动时先跑 bootstrap 再执行 `migrate:up`。迁移编号有重复检测脚本防止同号冲突。当前迁移编号至 065, 覆盖基础表与辅助函数、鉴权表与 auth schema 函数、实时 schema、定时任务、函数部署表、自定义 OAuth、S3 access key 与 S3 协议扩展、compute 服务与支付域、memory schema、数据库备份、advisor、OTP 登录与 OAuth 原生客户端 ID、compute 多驱动与 scale-to-zero、公有对象所有权回收与 http 扩展权限收紧。

## 存储产品域

### 双 provider 与元数据

存储服务在构造时按配置二选一:

- S3 provider: 支持 AWS 与任意 S3 兼容存储, 可走预签名 URL 或代理模式 (后者适用于端点浏览器不可达的私网场景)。当存在父项目 app key 时进入分支模式 —— 读路径 404 时回退父项目前缀, 写路径只写分支前缀, 这是云端 backend branching 的存储层实现。
- 本地文件系统 provider: 纯文件实现, 路径校验防目录穿越, etag 取文件内容 MD5, 不支持预签名 URL, 上传策略退化为走后端代理。

对象字节在 provider 里, Postgres 侧只维护元数据: bucket 与 object 记录、CORS 规则、versioning 状态、tagging、对象列表查询。上传 API 面覆盖 bucket 与 object 的增删查、上传策略协商 (预签名或代理)、下载策略协商与上传确认回执; 下载 URL 带版本戳以支持缓存失效。

### 上传协商与版本失效

上传路径不是“后端直接收字节”单一形态, 而是先协商后执行: 客户端先问上传策略, 后端根据 provider 能力返回预签名 URL 或代理端点; 客户端上传完成后回调确认上传, 后端再写对象元数据。下载侧同理, 先取下载策略再拿 URL。两条协商路径让同一套 API 既能服务直连 S3 的浏览器, 也能服务只能走后端的私网环境。

对象下载 URL 带版本戳, 因此覆盖同名对象后旧 URL 自动失效, 不需要手动清缓存。存储配置 (bucket 级) 与第三方鉴权支持各自成迁移; S3 的 CORS、tagging 与 versioning 能力也各有一组迁移与对应测试。

### S3 access key

S3 access key 有独立的签发与管理端点, 服务层负责生成与校验。它与面向 REST 的 API key 是两套凭据: 前者用于 SigV4 验签, 后者用于平台 API 鉴权, 但都归入同一套密文存储体系。这样既让 aws CLI 这类工具能用标准凭据访问对象存储, 又不会把平台管理凭据暴露给存储客户端。

### S3 协议网关

S3 网关实现了完整的 S3 线协议, 因此配置 S3 后端后可以直接用 aws CLI、rclone 或任意 AWS SDK 打 `/storage/v1/s3`。它由四部分组成: 路由分派、请求解析、S3 风格 XML 响应生成、错误体生成; 中间件做 AWS SigV4 验签, 并用 LRU 缓存加速热点验签路径, 同时支持分块签名的流式上传。

| 命令类别    | 覆盖操作                                          |
| ----------- | ------------------------------------------------- |
| Object 读写 | put / get / head / copy / delete / 批量 delete    |
| 分块上传    | 创建、上传分块、列分块、完成、中止                |
| Bucket      | 创建、删除、head、列表、位置查询、list-objects-v2 |
| Versioning  | 查询与设置 bucket 版本控制                        |
| CORS        | 查询、设置、删除 bucket CORS                      |
| Tagging     | 查询、设置、删除对象标签                          |

S3 access key 的签发与管理有独立端点与迁移。

## 边缘函数与定时任务

### 函数定义与部署链路

函数代码存 Postgres, 部署记录单独成表。每次函数增删改后异步触发部署: 取全部活跃函数与注入用 secrets, 交给 Deno Deploy provider 部署, 状态先记 pending 再轮询。服务启动时同步一次, 已有成功部署就跳过, 且不阻塞启动。

Deno Deploy provider 走 Deno Deploy v2 API (`https://api.deno.com/v2`): 保证应用存在 (部署、查状态、查日志解析同一个应用 slug, 即 `APP_KEY`, 否则会部署到一个应用却去轮询另一个), 资产由一个生成的路由器 (`main.ts`) 加各函数的用户代码 (`functions/<slug>.ts`) 组成, 函数 slug 必须匹配字母数字连字符下划线白名单, 用户代码经变换后作为资产, 运行时配置为 `{ type: 'dynamic', entrypoint: 'main.ts' }`, secrets 以 `{key, value}` 数组形式注入为环境变量。凭据从 `DENO_DEPLOY_TOKEN` 与 `DENO_DEPLOY_ORG_ID` 读取。函数提交前有 `deno check` 预校验 (CI 等无 Deno 环境时跳过)。

未配置 Deno Deploy 时函数由本地运行时执行: 后端把 `/functions/:slug` 代理到 Deno 服务。

### 本地运行时的 Worker 隔离

本地运行时 (独立 Deno 服务, 默认端口 7133) 每请求新建一个 Web Worker, 执行一次即终止。Worker 仅由固定模板的 blob 创建, 以严格权限白名单启动 (仅允许 net, env/read/write/run/ffi/sys/import 全部禁用); 函数源码 (从 `functions.definitions` 表取 `status = 'active'` 的记录) 与请求数据、解密后的 secrets 一起经 postMessage 传入, 在 worker 内用 `new Function` 包裹执行。超时由 `WORKER_TIMEOUT_MS` 配置 (默认 60 秒), 超时即终止 worker 并返回 504。

函数 secrets 以密文存表, 用 AES-GCM 解密, 密钥是环境密钥或 JWT 密钥的 SHA-256, 密文格式为 iv、authTag、ciphertext 三段 hex, 与 Node 端加密格式互通。

worker 模板开头是一段“安全黑障”: 在任何 import 发生之前, 用顶层代码把全局 Deno 对象重定义为只含 mock 环境的冻结对象 (读只返回生产环境标记, 写与删抛错), `process.env` 同样被替换成无菌副本, 失败则立即向宿主返回 500 并关闭。目的是让函数代码与其依赖库拿不到真实环境变量, 同时避免某些库在环境白名单下抛能力错误。

紧随其后的是“早到消息缓冲”, 解决一个真实竞态: 宿主 new Worker 后立即 postMessage, 而冷启动的动态 import 可能超过 200ms, Web Worker 不缓冲 handler 注册前到达的消息。模板先注册同步 onmessage 把早到消息存进缓冲, import 完成后换真 handler 并排空缓冲, 单线程保证交换与排空间不会漏消息。

### 定时任务下沉到数据库

定时任务完全下沉到 Postgres, 依赖 pg_cron、http、pgcrypto 三个扩展: 任务表存名称、cron 表达式、目标 URL、HTTP 方法、加密请求头、请求体、启用状态与 cron job id, 日志表记执行历史与状态码。校验器同时接受两种形式: 5 字段 cron, 或 pg_cron 秒级 interval 写法 (1 到 59 秒, 错误信息会直接教用户“大于等于 1 分钟请用 5 字段 cron”)。API 面覆盖任务 CRUD、配置查询与执行日志。

## 其余产品域速览

| 域              | 关键机制                                                                                                                                                                                                                                                                      |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Realtime        | 专用 pg 连接监听消息通道 (不能用池化连接), 消息由 SQL 函数发出; 投递双通道为 Socket.IO room 与 webhook HTTP POST; 断线重连最多 10 次带退避; 服务层拆为 auth、channel、message、presence 四个服务                                                                              |
| AI 网关         | 唯一 provider 是 OpenRouter, 用 OpenAI SDK client 指向其端点并带平台标识头; key 解析顺序为云托管 key (仅云) 再到 Model Gateway secret store; 轮换仅云可用, 自托管显式拒绝; 暴露配置、模型列表、概览、provider 级 api-key、chat 补全、图像生成与 embedding                     |
| Memory          | Agent 记忆库, 固定使用 3-small 嵌入模型 (1536 维) 与 mini 级别生成模型; 记忆类型分 fact、decision、preference、reference; 召回阈值 0.45、去重合并阈值 0.5, 注释说明这是离线 eval 调优的结果; LLM 输出被视为不可信, 逐条 coerce 与 UUID 正则校验后才入库                       |
| Compute         | 三种驱动: 挂 Docker socket 即启用 (socket 等同 root, 驱动自行构造容器规格, 不转发调用方选项)、Fly (凭据齐备自动启用)、云代理 (项目 ID 等齐备走云); 入口模式覆盖 none/port/通配域, 发布端口默认只绑 127.0.0.1; 构建上下文有大小与上传空闲超时上限; 支持 scale-to-zero 与多驱动 |
| Site Deployment | Vercel provider, 状态机为等待 → 上传 → 排队/构建/就绪/错误/取消; 有 app key 时部署 URL 换成自定义域; 文件数、总字节、单文件字节三个上限走配置; 支持直传文件与打包 zip 两条路                                                                                                  |
| Payments        | Stripe 与 Razorpay 双 provider, 服务层按渠道再分: Stripe 下有 checkout、配置、客户门户、价格、商品、订阅、同步、交易、webhook 九个服务, Razorpay 下七个; 原始事件落库, 用 PG advisory lock 串行化 webhook 处理                                                                |
| Email           | SMTP 与云代发双 provider, 模板存库可改, 覆盖 OTP、验证与重置邮件; 有发送冷却定时器参与优雅退出                                                                                                                                                                                |
| Logs            | CloudWatch 与本地文件双实现, 共用基类; 日志查询端点在请求日志中间件里被特意跳过防循环                                                                                                                                                                                         |
| Secrets         | AES-GCM 密文存表, API key 与 anon key 同体系管理并支持轮换; 未配置时后端自动生成一对只有它自己知道的 key                                                                                                                                                                      |
| Usage / 遥测    | MCP 工具调用上报与统计聚合; 匿名遥测走 PostHog, 事件只有实例启动与 24 小时心跳, CI 环境自动识别, 可按环境变量整体关闭; 功能用量采集器按请求路径计数                                                                                                                           |
| 其他            | webscraper 集成、基于 PostHog 的分析三件套、GitHub 路由、dashboard 内埋点与文档路由                                                                                                                                                                                           |

### 支付与 webhook 的幂等

支付域是双 provider 加分层服务的典型: 按渠道先分 Stripe 与 Razorpay 两套, 每套内部再按职责拆服务, 共享一张原始事件表。幂等由两层保证: 原始 webhook 事件先落库再处理, 且用 PG advisory lock 串行化同一资源的并发处理。webhook 路由在中间件栈里被挂在 JSON 解析之前, 以保证签名验证拿到的是原始字节而不是被重新序列化的对象 —— 这是所有第三方回调入口的通用要求。

### 邮件、日志与密钥

邮件 provider 二选一: SMTP (基于 nodemailer, 配置存库) 或云代发。邮件模板存库可改, 因此改文案不需要重新部署; 发送侧有冷却定时器, 并参与优雅退出。日志 provider 有 CloudWatch 与本地文件两个实现, 共享基类; 日志目录可配, 查询端点被特意从请求日志中排除以避免日志风暴。

密钥体系里所有敏感值都以 AES-GCM 密文存表, API key 与匿名 key 同属该体系并支持轮换。若启动时未设访问 key 与匿名 key, 后端会自动生成一对“只有它自己知道”的凭据; 并有一次去重与唯一性修复迁移。

## 数据流与请求生命周期

把上述域串起来看, 一次请求在控制面内的路径是固定的: 中间件栈先完成 CORS、cookie、日志与遥测计数, 再进入鉴权分派器确定身份, 然后交给业务路由; 路由只做参数校验与编排, 实际逻辑在 service 层, service 再调 provider 或基础设施。数据读写在这一层分流:

```text
请求 ──▶ 鉴权分派 ──▶ 业务路由 ──┬── 用户数据 CRUD ──▶ PostgREST 代理 ──▶ Postgres
                                ├── 元数据 / 管理 ──▶ pg 连接池 ──▶ Postgres
                                ├── 对象读写 ──▶ S3 或本地 provider
                                ├── 函数调用 ──▶ Deno Deploy 或本地 Deno
                                └── 事件推送 ──▶ Socket.IO room / webhook
```

写入完成后控制面会向 dashboard 推送数据更新事件, 前端据此刷新对应资源。错误在出口被统一包装, 带上错误码与后续动作提示。这种“路由薄、服务厚、基础设施在底层”的分层, 使得同一个 provider 可以被多个路由复用, 也让 MCP 工具与 REST 路由共用同一批服务。

## 契约层与“文档即 API”

### 共享 schema

契约层的模式是“域 schema 加域 API schema 成对出现”, 覆盖 AI、auth、compute、database、deployments、email、functions、logs、memory、payments、realtime、schedules、secrets、storage、webscraper 等域, 外加元数据、S3 access key、docs、错误码枚举等单文件。唯一运行时依赖是 zod; 构建就是 tsc, 安装时由 prepare 钩子保证先编译。错误码枚举被后端每个应用错误携带。

### OpenAPI 与文档端点

平台按产品域拆分维护十余份 OpenAPI 3.0.3 契约, 其中支付、鉴权、存储三份最大。这些契约与文档站点一起构成“Agent 可读文档面”:

- 后端从磁盘直接读文档文件返回给调用方, 两级端点分别按文档类型、以及按 feature 加 language 组合寻址。
- 文件路径做安全校验, resolve 后必须落在允许目录内, 否则 403; 返回前展开文档中的 snippet 引用。
- SDK 文档覆盖 TypeScript、Kotlin、Swift、REST 四种语言, 数据库、存储、函数、鉴权、AI、实时六个 feature 全语言映射, 支付只有 TypeScript。

MCP 的 `fetch-docs` 与 `fetch-sdk-docs` 就是打这两个端点 —— 后端把“教 Agent 用自己”的文档做成了 API。

文档资产本身也按产品域组织: 核心概念目录按数据库、鉴权、存储、函数、实时、支付、站点、计算、分析、Webscraper 等域各成一组; 站点支持多语言 (含简体与繁体中文), 用脚本检查各语言目录的平移一致性; 文档与 OpenAPI 契约是两条并行的事实源 —— 前者面向人与 Agent 阅读, 后者面向 SDK 生成与接口校验。两者都被平台自己消费 (文档端点与 SDK 生成), 因此不会陷入“文档写了没人看、过时了没人发现”的典型困境: Agent 每学一次平台用法, 都会先走一遍文档端点。

## 前端与共享包

前端宿主是双模式壳: 云托管渲染云控制台与伙伴体系, 自托管只挂载共享 dashboard 包, 逻辑入口就是一句按环境二选一的分支。开发工具链用 Vite 加 React 插件与 Tailwind 插件。

共享 dashboard 包按产品域切十余个 feature 目录 (ai、analytics、auth、compute、database、deployments、functions、login、logs、payments、realtime、storage、visualizer、webscraper 等), 路由把登录页放在公开侧, 其余全部包在鉴权守卫里; 数据库子路由包含迁移、备份等页, SQL 编辑器与存储各有独立布局; 首页组件由 PostHog feature flag 决定 A/B 版本。

数据访问统一走一个 API client: 请求方法接收路径、方法与请求体, 并用一个辅助方法注入 access token; 各 feature 的服务层 (如函数服务、存储服务、计算服务) 都基于它封装领域调用, 不直接依赖 fetch。编辑器依赖 CodeMirror 的 JavaScript、Python、SQL 语言包与 Radix UI 原语; 表格组件 (如存储文件列表) 把列定义与单元格渲染拆分, 支持排序、缩列宽与逐行动作。测试分 unit 与 component 两套 vitest 配置外加 Playwright 配置, 构建是 vite build 加类型检查双步。

UI 包是 React 组件库加设计令牌与 Tailwind preset, 供宿主消费。它把可复用原语 (按钮、表格、对话框等) 从 dashboard 中抽出, 避免业务 feature 目录直接沉淀通用组件。

## 面向 Coding Agent 的 MCP 工具面

MCP Server 是独立仓库, 不在主 monorepo 内, 通过 HTTP 调用后端的 `/api/*`。两仓库的耦合点是: MCP 启动时拉健康检查取后端版本号做工具注册门控, 以及 MCP 依赖精确钉死版本的共享 schema 包。tsup 构建有两个入口 (stdio 与 HTTP server), 包元数据声明三个 bin 名: `mcp` 与 `insforge-mcp` 指向 stdio 入口, `insforge-mcp-server` 指向 HTTP server 入口; npm start 直接起 HTTP server 并显式绑 `0.0.0.0`, 开发时用 tsx watch。

### 工具注册内核

两种传输共享同一个装配器, 关键机制有五条:

1. 强制健康检查: 启动即请求健康端点 (10 秒超时), 后端不可达直接抛错终止注册, 错误信息带超时提示。
2. ToolHost 抽象: 工具层只依赖“注册工具需要名称、描述、输入 schema、处理器”这一个四参契约, 再由 `sdkToolHost()` 适配到 MCP SDK。这个缝是为换底层 server 实现预留的。
3. 版本门控: 一张工具到版本区间的映射表声明最小与最大后端版本, 不满足的工具跳过注册并向 stderr 说明原因 (要求更高版本或已废弃)。版本比较自实现 semver 语义, 剥 `v` 前缀与预发布段。
4. 传输裁剪: 需要读本地文件的工具 (如 `bulk-upsert`) 在远程模式跳过注册。
5. 用量上报: 每个处理器被包装为成功与结构化错误都上报, fire-and-forget 发到用量端点; 首次调用附带一次性的 agent 连接上报。

凭据语义上, `getApiKey` 在远程模式刻意忽略调用方传入的 per-call key: 远程会话的凭据在登录时绑定, 接受调用方替换会让会话凭据失去权威性; 本地 stdio 模式则允许 per-call key 覆盖全局 key。

另有指令文档自动注入: 后端版本低于 1.1.7 时, 每个工具响应尾部自动附加从 `/api/docs/instructions` 拉取的开发规则文本。

### 18 个工具的面板

工具按域分布在五个注册器 (文档、数据库、存储、函数、部署) 中。唯一工具名共 18 个; 本地 stdio 模式实际注册 17 个 (无 start-deployment), 远程模式注册 17 个 (无 bulk-upsert), 再受后端版本门控削减。

| 工具                 | 域         | 模式               | 行为与后端落点                                                                                                                                                        |
| -------------------- | ---------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| fetch-docs           | docs       | 双模               | 拉平台文档, 描述标注 instructions 为强制第一步; 打文档类型端点                                                                                                        |
| fetch-sdk-docs       | docs       | 双模, 版本门控     | 按 feature 加 language 拉 SDK 文档                                                                                                                                    |
| get-anon-key         | docs       | 双模               | 生成永不过期的匿名 JWT (需管理 key)                                                                                                                                   |
| get-table-schema     | database   | 双模               | 单表 schema 含 RLS、索引与约束                                                                                                                                        |
| get-backend-metadata | database   | 双模               | 全量后端元数据索引                                                                                                                                                    |
| run-raw-sql          | database   | 双模               | 裸 SQL 执行, 描述自称需要管理员权限并提示谨慎使用                                                                                                                     |
| download-template    | database   | 双模异构           | 本地模式取匿名 key 后在临时目录执行脚手架命令 (校验项目名防路径穿越与 shell 注入) 并返回拷贝指令; 远程模式只返回让 Agent 自行执行的命令                               |
| bulk-upsert          | database   | 仅本地             | 从本地 CSV 或 JSON 文件批量 upsert                                                                                                                                    |
| create-bucket        | storage    | 双模               | 建桶                                                                                                                                                                  |
| list-buckets         | storage    | 双模               | 列桶                                                                                                                                                                  |
| delete-bucket        | storage    | 双模               | 删桶                                                                                                                                                                  |
| create-function      | functions  | 双模异构           | 本地模式要求代码先写进本地文件再按路径读取 (便于版本控制); 远程模式直接收内联代码字符串                                                                               |
| get-function         | functions  | 双模               | 函数详情含代码                                                                                                                                                        |
| update-function      | functions  | 双模异构           | 同 create 的文件路径与内联代码分叉                                                                                                                                    |
| delete-function      | functions  | 双模               | 永久删除                                                                                                                                                              |
| get-container-logs   | deployment | 双模               | 拉最近容器或服务日志, 定位为调试工具                                                                                                                                  |
| create-deployment    | deployment | 双模异构, 版本门控 | 本地模式 zip 打包目录并并行直传 (直传能力按后端 2.0.6 门控, 低于该版本改走 zip 上传, 并发默认 8、上限 32); 远程模式准备部署并返回上传指令, 支持直传的后端返回直传命令 |
| start-deployment     | deployment | 仅远程             | 上传完成后触发构建                                                                                                                                                    |

请求统一用 `x-api-key` 头携带凭据, 响应经统一处理器包装成 MCP content 数组, 错误一律返回带 `isError: true` 的结构化对象。部署域是最大单文件, 内含直传会话、文件内容上传与启动部署逻辑。

### 响应处理与安装通道

所有工具的返回都走同一条响应管线: 解析 HTTP 响应、判断是否为错误形态、把成功结果格式化成文本 content 数组; 结构化错误统一带 `isError: true`。这样上层 Agent 不需要针对每个工具学一套错误格式, 只需要记住“content 数组加 isError 标志”这一种契约。

安装侧提供两条路: 自动安装器支持 claude-code、cursor、windsurf、cline、roocode、codex、trae 七种客户端, 只需传入客户端名与环境变量即可写入配置 (加 `--dev` 开关安装开发版); 手动安装则把 command 为 `npx -y @insforge/mcp@latest` 的服务器条目写进客户端设置。远程形态的声明注册在包元数据里: 声明流式 HTTP 端点与 stdio 两种传输, 并把 API key 标为必需且敏感的环境变量。包只发布构建产物与几份清单文件, 构建用 tsup, 发布前有部署校验、平台路径校验与握手校验三个脚本兜底。

### 远程 MCP 的 OAuth 2.1 与无状态化设计

远程传输基于 Express 5, 端点分四组:

| 组    | 端点                                                           | 说明                                                        |
| ----- | -------------------------------------------------------------- | ----------------------------------------------------------- |
| MCP   | `/mcp`                                                         | StreamableHTTP 主端点: POST 消息、GET SSE 流、DELETE 关会话 |
| SSE   | `/sse` 与 `/messages`                                          | SSE 流建立与消息发送分离的双端点 (协议版本 2024-11-05)      |
| OAuth | 授权服务器元数据、受保护资源元数据、动态客户端注册、授权与换票 | 标准 OAuth 2.1 授权码加 PKCE                                |
| API   | 健康检查、列项目、把 token 绑定到项目                          | 会话建立与项目选择                                          |

未授权请求按 MCP 规范返回 401 与受保护资源元数据。

这套实现最有价值的是无状态化边界:

- 客户端注册不是存储, 是签名 client id;
- 授权状态不是存储, 是密封 cookie, cookie 里带 handle 且与平台回传的 state 参数绑定校验 —— 没有这个绑定, 任何带着 cookie 的回调都能通过授权;
- 授权码与 access token 都是密封信封; refresh token 有独立的捕获与校验逻辑;
- 唯独 MCP 会话做不到无状态: 它持有一个 McpServer 实例与一条打开的 TCP 连接。文档注释的原话是“socket 不能密封进 token, 也不能复制到另一台机器, 所以会话只存在于本进程”。代价是进程重启丢弃所有存活会话, 客户端的恢复路径是看到会话 ID 返回 404 后重新 initialize; 多实例部署的答案是粘性路由或共享传输层, 而不是在外部存储里放会话副本——副本无法让连接变得可移植;
- 会话 ID 是 bearer 凭据, 日志只允许出现指纹 (SHA-256 前 8 位), 因为运行时日志会经 API 暴露, 裸 ID 落日志等于凭据落盘。

OAuth 流程本身是两层: 对 MCP 客户端做标准授权码加 PKCE, 对 InsForge 平台再发起一层 OAuth (自生成 code verifier/challenge)。授权状态同时保存客户端原始请求参数与平台侧 PKCE verifier; 多项目用户会看到项目选择页, 选定后缓存项目 key 并签发 access token, 会话建立时以远程模式加项目 ID 与 access token 装配工具。凭据防护有专门的测试覆盖 (会话绑定、state 绑定、会话指纹、凭据不匹配拒绝等)。

## 实时、AI 与记忆

实时域的服务层拆为 auth、channel、message、presence 四块, 核心机制有两条: 服务端用专用 pg 连接执行 LISTEN (不能用连接池里的连接, 否则监听会随连接的归还而失效), 客户端通过 Socket.IO room 或 webhook HTTP POST 双通道接收。重连带最多 10 次尝试与基础退避, 投递统计写回消息记录, 消息保留策略单独成表。频道命名有专门的辅助函数并经历修复。

AI 网关对外暴露配置、模型列表、概览、provider 级 API key (含轮换)、chat 补全、图像生成与 embedding 八类端点, 服务层拆为 chat 补全、embedding、图像生成、模型目录与网关配置五个服务。轮换在自托管环境显式拒绝, 因为托管 key 只存在于云侧。

记忆域把 Agent 的长期记忆做成后端能力: 记忆被分成 fact、decision、preference、reference 四类; 写入前对 LLM 输出做逐条 coerce 与 UUID 正则校验, 明确把模型输出当作不可信输入; 召回与去重合并各有阈值, 阈值来自离线评测调优。这条链路展示了一个通用原则: 凡是模型产出的结构化数据, 都应在入库前做一次格式与语义校验。

## 计算与站点部署

计算域提供三种驱动, 由配置自动启用, 能力面与限制都很明确:

| 驱动   | 启用条件                  | 说明                                                         |
| ------ | ------------------------- | ------------------------------------------------------------ |
| Docker | 挂 Docker socket          | socket 权限等同 root, 驱动自行构造容器规格, 不转发调用方选项 |
| Fly    | 凭据齐备                  | 走外部平台, 服务端只做编排                                   |
| 云代理 | 项目 ID、云主机与密钥齐备 | 请求转发到云控制面执行                                       |

入口模式覆盖无入口、单端口与通配域三种; 发布端口默认只绑 127.0.0.1, 避免把内部服务直接暴露到公网; 构建上下文有大小上限, 上传有独立空闲超时 (这是内存边界而不只是策略); 支持 scale-to-zero 与多驱动并存。Docker 驱动的容器更新采用安全切换: 替换容器先以临时名启动并轮询健康就绪 (有界超时, 镜像定义 HEALTHCHECK 时等 healthy), 通过后用 rename-swap 接管主名 —— 旧容器在新容器就位前不被销毁, 切换失败会把旧容器改回主名, 消除更新期的永久数据丢失窗口。计算能力在能力矩阵里被标注为预览状态。

站点部署走 Vercel provider, 状态机为“等待 → 上传 → 排队/构建/就绪/错误/取消”, 上传阶段区分直传文件的逐文件上传与旧式打包上传两条路径 (MCP 工具描述也据后端版本区分“支持直传”与“较旧后端”)。Vercel 只把 API 函数放在创建部署请求里发送的 region (vercel.json 的 regions 字段对 API 部署无效), 因此启动部署请求可带可选的函数 `regions`, 缺省时回退读取已上传 vercel.json 的 regions (尊重 rootDirectory 设置), 实际分配的 region 记入运行元数据。有 app key 时部署 URL 换成自定义域。文件数、总字节与单文件字节三个上限走部署配置, 部署文件另表存储以支持中断后续传。

## Agent 原生配套与运维

平台自身把“教 Agent 使用平台”的资产也纳入仓库:

- 面向维护者自己的技能集, 内容是本仓库的贡献纪律: 包边界判定、代码放最窄正确层、ESM 后缀约定, 并附文档多语言规则与跨仓库发布流程技能。
- Claude Code 插件市场清单把仓库注册为插件市场, 插件源指向独立的 skills 仓库, 描述覆盖 RLS 下的数据库 CRUD、鉴权、存储、边缘函数、AI、实时、支付、部署、CLI 基础设施管理与第三方鉴权集成指南。
- Agent 原生文档描述的标准工作循环是: 读现状元数据 → 开 backend branch 写迁移或改配置即代码文件 → 先打分支再打父项目 → 跑诊断 (可加 AI 解读) 查安全发现与错误日志 → 修复、复查、合并分支。CLI 与 Skills 是云托管专属通道。

运维侧, 配置文件的注释密度极高, 大量条目直接解释参数间的耦合约束 (转发池与 PostgREST 池对齐、keep-alive 与负载均衡超时、compose 项目名语义), 因此它本身可以当自托管运维手册使用。可观测性由三层构成: 请求级日志中间件记录方法、路径、状态、响应字节数、耗时、来源 IP 与 UA; 日志 provider 落 CloudWatch 或本地文件; 匿名遥测只发实例启动与心跳两个事件, 可按环境变量或 CI 检测关闭。

## 工程化要点

### 构建与分发

后端用 tsup 打包: ESM 格式、目标 Node 20、开启 sourcemap。打包策略里有几处针对性决定 —— 只把共享 schema 与某个热路径缓存库收编进 bundle, 后者是因为工作区副本被嵌套安装而生产镜像只带根级依赖; 另一个包刻意保持 external, 因为打包它会内联其传递依赖并在 ESM shim 下因 `require('tty')` 崩掉。

Dockerfile 分六阶段: 取 Deno 二进制、剥掉根 package 的版本字段与工作区里的 MCP 条目 (让版本号变化不打破下游缓存)、全量依赖、构建 (注入前端环境变量)、生产依赖、运行时。运行时以 node alpine 为基础, 装 tini (PID 1 信号转发)、Postgres 16 客户端与 su-exec; 因为生产镜像只携带根级 node_modules, 运行时阶段在构建期跑一次运行时依赖检查, 验证后端每个运行时依赖都能相对产物解析, 防止被 npm 嵌套安装的依赖在启动时缺失; 入口先跑迁移再 `exec node` 直接起服务, 避免 npm 包装链常驻两个进程以节省内存。容器以 root 启动, 入口脚本读取挂载进来的 Docker socket 的 group id 把 node 用户加入该组再降权 (socket 的 group id 因宿主而异, 无法烘焙进镜像); 覆盖入口会以 root 运行, 需要自行加 `user: node`。另有 dev target 供开发 compose 使用。

发布走语义化版本加 changesets 风格自动生成 changelog; lint 用 typescript-eslint 加 prettier。

### 测试体系

测试分 unit、integration、cloud、local、manual 五类, 配统一 runner、preflight 与清理脚本。unit 与 integration 用 vitest (集成另设超时), HTTP 层用 supertest, 还有自家测试辅助包。单元测试文件名透露了大量回归场景: 流式 token 重复计数的复现测试、CSRF 与 JWKS 与云 token、S3 网关的 CORS 与 tagging 与 versioning、对象下载 URL 版本戳、管理员校验、删除不存在任务等。

MCP 侧的工具测试覆盖三个要害: 远程模式忽略调用方 key、发布工具面回归、集成桥接, 另有真实项目集成测试 (由环境变量门控)。远程 MCP 侧另有凭据防护、会话绑定、OAuth state 绑定、会话指纹等一组测试压阵。

### 版本与契约协同

主仓库与 MCP 仓库存在天然的契约漂移风险: MCP 依赖精确钉死版本的共享 schema 包, 而主仓库的 schema 会继续演进。当前的处理方式是版本门控加人工同步 —— MCP 在注册工具前先探测后端版本, 不满足版本区间的工具直接不注册, 同时用具名映射表记录每个工具的最低版本要求。这种“运行时探测加能力裁剪”的模式, 比让旧客户端对着新后端报错更友好, 也是多版本后端共存的通用做法。

## 一次典型的 Agent 工作流

```text
自托管者      运行一键脚本生成 .env → docker compose up -d → 打开控制台按引导接 MCP
Agent 客户端  npx @insforge/mcp + API_KEY/API_BASE_URL 起 stdio server, 或用安装器写入客户端配置
MCP 启动      请求 /api/health 取后端版本 → 按版本门控注册 17 个工具
Agent 动作    fetch-docs 学平台约定 → download-template 起前端脚手架 (匿名 key 自动注入)
              → run-raw-sql 建表 → create-function 部署 Deno 函数
              → create-deployment 发站点 → get-container-logs 排障
用量回流      每次工具调用上报 → 后端功能采集与 PostHog 遥测 (可关)
```

验证安装的官方提示词就是让 Agent 调 `fetch-docs` 学习 InsForge 用法。

## 安全默认值汇总

把分散在各处的安全决策集中起来看, 平台的默认值取向非常明确 —— 任何歧义都按失败处理:

| 面           | 默认行为                                                                       |
| ------------ | ------------------------------------------------------------------------------ |
| 凭据分派     | 按形状选验证器, 绝不失败后回退; 无效 JWT 返回 401 而非降级为匿名               |
| 匿名身份     | 主体标识不下传数据库, `auth.uid()` 为 NULL, 身份型 RLS 自动 fail closed        |
| CSRF         | HMAC-SHA256 加时序安全比较, 不匹配 403                                         |
| 云凭据       | 云验证失败绝不放行本地 JWT 验证; 离开平台基础设施拒绝签发云 token              |
| 本地函数沙箱 | 环境变量全量黑障, 函数及其依赖拿不到真实 env; 代码从数据库取, 不在宿主文件系统 |
| 计算驱动     | Docker socket 必须显式挂载 (权限等同 root); 发布端口默认只绑 127.0.0.1         |
| 对象存储     | 本地 provider 做目录穿越校验; S3 网关做 SigV4 验签                             |
| 管理操作     | 表管理、raw SQL、导出全部要求管理员权限                                        |
| 远程 MCP     | 拒绝调用方替换会话凭据; 会话 ID 落日志前先哈希                                 |

这套取向带来一个副作用: 配置写错的代价是“显式报错”而不是“静默跑在降级模式”, 调试时看到 403 或启动失败, 通常意味着某个安全前置条件没满足, 而不是配置被忽略了。

## 适用场景与选型建议

适合使用:

- 需要给 Coding Agent 或自动化流程提供一个完整的后端基座, 又希望完全自托管、数据不出内网;
- 团队已在 Postgres 与 RLS 生态里, 希望表 CRUD 直接用 PostgREST 语义, 不想为每个 CRUD 手写接口;
- 需要对象存储同时兼容 S3 线协议 (aws CLI、rclone、任意 SDK) 的场景;
- 需要在平台内直接跑 Deno 边缘函数与定时任务, 并把 secrets 注入链路一并解决;
- 希望 Agent 通过 MCP 直接管理后端 (建表、部署函数、发站点、查日志), 而不是让人类在控制台代劳。

需要谨慎或不太适合:

- 只需要一个简单 REST API 的小项目: 引入完整的 BaaS 栈与四个容器可能过重;
- 对边缘函数隔离强度有强要求: 本地 Worker 沙箱每请求冷启动, 隔离强度与真正的 V8 isolate 方案不同档, 生产应依赖 Deno Deploy 侧;
- 追求稳定对外契约的平台: 共享 dashboard 包仍处于早期版本阶段, 跨仓库契约依赖版本门控与人工同步, 升级需要两侧协同;
- 期望“一次 compose 就绪”的开发体验: 开发栈在容器内跑安装与构建, 首次启动成本较高, 生产应走 image-only 的自托管栈。

选型时的核心判断是: 如果需求集中在“给 Agent 一个可编程、可自托管的完整后端”, InsForge 的 MCP 工具面与文档即 API 的设计能显著降低 Agent 的接入成本; 如果只需要数据库与几个接口, Supabase 或直接在 Postgres 上自建往往更轻。

### 需求到能力的映射

把常见需求直接映射到平台能力, 可以快速判断是否值得引入:

| 需求                   | 对应能力                         | 替代方案                          |
| ---------------------- | -------------------------------- | --------------------------------- |
| 表 CRUD 不改代码       | PostgREST 代理加 RLS             | Supabase PostgREST, 或自建 ORM 层 |
| 邮箱与 OAuth 登录      | 鉴权域 (11 家 provider 加自定义) | 外部 IdP, 或 Auth.js 等库         |
| 对象存储兼容 S3 工具链 | S3 线协议网关                    | 直接用 MinIO 或云对象存储         |
| 无服务器函数与 secrets | Deno Deploy 加本地 Worker 双后端 | 云厂商函数服务                    |
| 定时任务               | pg_cron 下沉到数据库             | 独立调度器 (cron、Temporal 等)    |
| Agent 直接管后端       | MCP 18 工具加文档 API            | 自建 MCP Server 包装内部 API      |
| 多环境/多租户后端      | backend branching 与云多租户变量 | 每环境一套 Postgres 加配置管理    |
| 站点部署               | Vercel provider                  | 直接用 Vercel 或其他托管          |

### 组合使用建议

几个可以由小到大的引入路径:

1. 只把它当“带 RLS 的 PostgREST 加鉴权”: 跑四个容器, 只用数据库与鉴权域, 前端自行对接, 引入成本最低。
2. 在此基础上加存储: 对象存储与 S3 网关自成一域, 可独立启用, 不需改动数据库层。
3. 再引入边缘函数与定时任务: 把需要 secrets 的短任务从自建服务搬到平台内, 统一密钥管理。
4. 最后接入 MCP: 让 Coding Agent 负责建表、部署函数与排障, 人类只在审阅环节介入。

反向的取舍同样清楚: 若团队已经有成熟的后端框架与发布流水线, 只缺少前端快速建表的场景, 引入 InsForge 的全栈产品域可能带来重复的部署与运维面; 此类场景更适合只借它的契约层思路 (逻辑类型映射、文档即 API、结构化错误) 而非整套运行时。
