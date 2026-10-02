---
title: "Yukino Chat 技术笔记: 自托管 IM 平台的 Hono 实时后端与每用户内嵌 Yukino Agent"
description: "基于代码事实梳理 yukino-chat 的 Hono/Prisma/PostgreSQL 服务端、WS 聊天枢纽与消息管线、WebRTC 信令、分块断点续传、缓存双组、/agent/ws JSON-RPC 桥与 React 19 客户端"
---

> 本机器路径 `$HOME/github/yukino-chat`

yukino-chat 是一个自托管实时聊天平台: 单聊/群聊、WebRTC 音视频通话、分块断点续传文件传输, 并为每个登录用户内嵌一个 Yukino AI coding agent 作为一等聊天参与者. 前端是 React 19 + Vite 8 的 SPA (`client/`), 后端是 TypeScript/Hono 服务 (`server/`, Hono 4.13.10 + `@hono/node-server` 1.19.17 + `@hono/node-ws` 1.3.1 + Prisma 7.10.0 + PostgreSQL + ioredis 5.11.1 + ws 8.22.0), 数据落 PostgreSQL (Prisma 7), 缓存走 Redis (可降级进程内存). 本文所有结论均以仓库源码为准; 线协议的若干约定 (空列表序列化为 null、请求体零值解析、JSON-RPC 词汇) 直接由当前实现与其源码注释定义, 下文逐一说明.

## 一、项目快照

本机仓库快照: HEAD 为 `a850cce` "docs: rewrite README to match the TypeScript workspace layout" (提交日期 2026-10-01), remote 为 `git@github.com:hangtiancheng/yukino-chat.git`, 分支 `main`, 工作区干净. 下文所有实现事实均以该提交的源码与 `README.md` 为准.

| 维度         | 内容                                                                                                                             |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| 定位         | 自托管 IM: 账号/联系人/群组/会话/富消息 + WebRTC 通话 + 断点续传 + 每用户一个 Yukino AI coding agent                             |
| 仓库形态     | pnpm workspace (`pnpm-workspace.yaml`: `client` + `server`), Node 24 (`.nvmrc`)                                                  |
| 服务端语言   | TypeScript 5.9.3 (ESM, `"type": "module"`), 开发态 `tsx watch src/index.ts`, 构建 `prisma generate && tsc` (server/package.json) |
| HTTP 框架    | Hono 4.13.10 + `@hono/node-server` 1.19.17 + `@hono/node-ws` 1.3.1 (WebSocket 升级)                                              |
| ORM/数据库   | Prisma 7.10.0 (`@prisma/client` + `@prisma/adapter-pg`) -> PostgreSQL (`DATABASE_URL`, 默认库名 yukino_chat)                     |
| 缓存         | ioredis 5.11.1, `REDIS_URL` 为空时降级进程内存 (server/src/cache/cache-service.ts)                                               |
| 认证         | 手写 HS256 JWT (server/src/common/jwt.ts) + bcryptjs ^3.0.3 口令哈希 (72 字节上限)                                               |
| Agent 集成   | `@yukino.js/yukino` 0.0.4 以库形式嵌入服务进程 (非子进程), 每用户一个 AgentRuntime, 工作区 `.yukino/chat/<uid>`                  |
| 前端框架     | React 19.3.0 + react-router-dom 7.18.4 + TypeScript 6.0.3 + Vite 8.3.1 + Tailwind CSS 4.3.3 + shadcn/ui (Base UI 1.8.0)          |
| 前端状态     | Zustand 5.0.15 (auth/ws/call/agent/dashboard/preferences) + TanStack React Query 5.104.0 / Form 1.33.5 / Virtual 3.14.13         |
| 富文本/渲染  | TipTap (@tiptap/core 3.31.3, react/starter-kit 等钉 3.30.5) (输入) + Streamdown 2.6.0 (消息渲染, cjk/code/math/mermaid 插件)     |
| 可观测       | `@yukino.js/sentry` 0.0.1 (仅 DEV 初始化, Vite 插件收集报告到 logs/*.jsonl)                                                      |
| PWA          | vite-plugin-pwa 1.3.0, `registerType: "autoUpdate"`                                                                              |
| 测试         | Vitest 4.1.11 单测 4 个文件 + 2 个对运行中服务器的 smoke 脚本 (server/tests)                                                     |
| 实际部署形态 | 直接 `node dist/index.js` 或 `tsx watch src/index.ts`; 单实例部署, 前置网关终结 TLS (见第十二章)                                 |

表内精确版本为已核实的实际安装版本, 与 client/server 各自 package.json 的声明区间一致.

### 目录结构

```text
yukino-chat/
├── package.json            # workspace 根, 仅 git:commit/git:push 脚本
├── pnpm-workspace.yaml     # packages: client, server
├── client/                 # React 19 + Vite 8 SPA
│   ├── src/pages/          # chat / session-list / contact-list / own-info / manager / dashboard / login / register
│   ├── src/components/     # composer、气泡、agent 卡片、通话对话框、各类 dialog、ui/ (shadcn)
│   ├── src/store/          # zustand: auth ws call agent dashboard preferences
│   ├── src/service/        # http/api/queries/schemas/agent-schemas/upload (分块上传)
│   ├── src/utils/          # rtc (CallManager) avatar (identicon) format logout toast
│   └── src/workers/        # file-hash.worker.ts (分块 SHA-256)
└── server/                 # TypeScript/Hono 后端
    ├── src/index.ts        # 入口: 建目录 -> createDeps -> hub/agent start -> serve
    ├── src/app.ts          # Hono 装配: cors/auth 中间件、静态目录、路由注册
    ├── src/deps.ts         # Deps 依赖包 (db/cache/calls/hub/5 个 service/agent)
    ├── src/routes/         # user/group/session/contact/message/file/chatroom + 3 条 WS 路由
    ├── src/hub/            # chat-hub / message-pipeline / call-manager / frame-types
    ├── src/agent/          # agent-manager / agent-runtime / event-adapter / interaction-broker / rpc-protocol / yukino-config / agent-stores
    ├── src/services/       # user / session / message / contact / group
    ├── src/cache/          # cache-service (Redis/Memory 双实现)
    ├── src/common/         # jwt / password / envelope / body / ids / token / time
    ├── src/middleware/     # auth / admin / ratelimit / cors
    ├── prisma/             # schema.prisma + 2 个迁移 (init, drop_agent_interactions)
    ├── src/generated/      # prisma-client 生成产物 (已提交)
    └── tests/              # vitest 单测 + http/ws smoke 脚本
```

### 运行时形态

- server 是纯 Node.js 进程: 入口 `server/src/index.ts` 先建三个静态目录, 再 `createDeps()` 组装依赖, `ensureYukinoUser()`, 启动 hub/agent 的定时器, 最后 `createApp()` + `serve()`.
- 默认监听 `0.0.0.0:8000` (`PORT`/`HOST`, server/src/config/env.ts:5-6); 开发态 `tsx watch src/index.ts`, 生产态 `prisma generate && tsc` 后 `node dist/index.js` (server/package.json).
- 三个 WS 端点均以 query token 验签: `/wss` 还校验 `client_id` 与 token uuid 一致 (server/src/routes/ws-chat-route.ts:19-28), `/agent/ws` 只验 token (ws-agent-route.ts:38-42), `/dashboard/ws` 额外要求 admin (ws-dashboard-route.ts:18-25).

## 二、整体架构与启动流程

```text
┌───────────────────┐  HTTP POST (envelope JSON)  ┌─────────────────────────────┐
│  React 19 SPA     │ ──────────────────────────> │  Hono app (server/src)      │
│  client/src       │                             │  routes -> services -> Prisma│
│  zustand + query  │  /wss (聊天/信令)           │                             │
│                   │ <─────────────────────────> │  ChatHub + MessagePipeline  │ ──> PostgreSQL
│  CallManager      │                             │  CallManager (通话房间)     │ ──> Redis (可选)
│  (WebRTC mesh)    │  /agent/ws (JSON-RPC)       │                             │
│                   │ <─────────────────────────> │  AgentManager/AgentRuntime  │
│  Agent 时间线 UI  │                             │  @yukino.js/yukino 0.0.4    │
└───────────────────┘  /dashboard/ws (admin)      │  工作区 .yukino/chat/<uid>  │
                                                  └─────────────────────────────┘
```

服务端入口 `server/src/index.ts` 的启动序列:

1. `mkdirSync` 三个静态目录 (`STATIC_AVATAR_DIR`/`STATIC_FILE_DIR`/`STATIC_CHUNK_DIR`, index.ts:8-10)
2. `createDeps()` 组装依赖包 (server/src/deps.ts:27-39): PrismaDB、CacheService、CallManager、ChatHub、Session/User/Contact/Group/Message 五个 service、AgentManager, 全部通过 `Deps` 接口注入路由, 无全局单例
3. `deps.users.ensureYukinoUser()` 确保保留账号 `UYUKINOAGENT` 存在 (server/src/services/user-service.ts:125-138)
4. `deps.hub.start()` 开启心跳清扫定时器; `deps.agent.start()` 开启空闲 runtime 清扫定时器
5. `createApp(deps)` 构建 Hono 应用, `serve()` 监听 `HOST:PORT` (默认 0.0.0.0:8000), `injectWebSocket(server)` 把 `@hono/node-ws` 注入 Node server
6. SIGINT/SIGTERM 触发 `shutdownDeps`: 释放全部 agent runtime、停心跳、关 Redis、断开 Prisma (deps.ts:41-46)

应用装配 (server/src/app.ts:22-56): 全局挂 `corsMiddleware` 与 `authMiddleware`, `onError` 兜底 500; `/static/avatars/*` 与 `/static/files/*` 用 `serveStatic` 公开 (chunk 目录刻意不服务, app.ts:33 注释 "chunks must never be served"); 随后注册 7 组 HTTP 路由与 3 条 WS 路由.

### 响应封装: 全 200 + body code

所有 HTTP 接口 (含错误) 一律返回 HTTP 200, 真实状态在 body 的 `code` 字段: `{code: 200|400|401|403|429|500, message, data?}` (server/src/common/envelope.ts). 服务层返回 `(message, data, ret)` 三元组或 `(message, ret)` 二元组, 由 `back()` 翻译: `ret=0` -> code 200, `ret=-2` -> 400, 其余 -> 500. 空数组在成功响应里统一改写为 `"data": null` (envelope.ts:39-42); 客户端 zod schema 用 `wireList()` (`z.array().nullish().transform(v => v ?? [])`) 对称还原为 `[]` (client/src/service/schemas.ts:38-43).

请求体解析采用零值语义: `bindBody()` 只接受 JSON object, 字段缺失/类型错误回落零值 (`str`/`num`/`strArr`, server/src/common/body.ts), 需要区分 "未传" 与 "传空" 的字段用 `optStr`/`optNum` 的 null 指针语义.

### API 面

HTTP 路由全部为 POST, 按域分组 (server/src/routes/*.ts):

| 组        | 代表端点                                                                                                                                                                                     | 备注                                       |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| 认证/用户 | `/login`, `/register`, `/user/update-password`, `/user/search-user`, `/user/update-user-info`, `/user/get-user-info`, `/user/ws-logout`                                                      | 前三个免鉴权; login/register 限流 10 次/分 |
| 用户管理  | `/user/get-user-info-list`, `/user/able-users`, `/user/disable-users`, `/user/delete-users`, `/user/set-admin`                                                                               | `requireAdmin`                             |
| 群组      | `/group/create-group`, `/group/invite-group-members`, `/group/leave-group`, `/group/dismiss-group`, `/group/search-group` 等 15 个                                                           | 3 个管理端点需 admin                       |
| 会话      | `/session/open-session`, `/session/get-user-session-list`, `/session/get-group-session-list`, `/session/mark-session-read`, `/session/delete-session`, `/session/check-open-session-allowed` |                                            |
| 联系人    | `/contact/apply-contact`, `/contact/pass-contact-apply`, `/contact/black-contact`, `/contact/add-tag`, `/contact/update-contact` 等 15 个                                                    |                                            |
| 消息      | `/message/get-message-list`, `/message/get-group-message-list`, `/message/upload-file`, `/message/upload-avatar`                                                                             |                                            |
| 分块上传  | `/file/verify`, `/file/upload-chunk`, `/file/merge`                                                                                                                                          | 见第六章                                   |
| 聊天室    | `/chatroom/get-online-users`, `/chatroom/get-callers`                                                                                                                                        | callers 有房间可见性校验                   |

WebSocket 通道 (GET 升级):

| 通道            | 用途                                 | 鉴权                                                         |
| --------------- | ------------------------------------ | ------------------------------------------------------------ |
| `/wss`          | 主实时通道: 消息、在线状态、通话信令 | query token 验签 + client_id 一致性 (ws-chat-route.ts:19-28) |
| `/agent/ws`     | Yukino agent JSON-RPC 流             | query token 验签 (ws-agent-route.ts:38-42)                   |
| `/dashboard/ws` | 管理员缓存看板推送                   | query token + `isAdmin` (ws-dashboard-route.ts:18-25)        |

### 中间件

- auth (server/src/middleware/auth.ts:12-23): 只拦 POST, `PUBLIC_PATHS = {/login, /register, /user/update-password}` 直通; Bearer token 验签后把 uuid 写入 Hono 上下文变量 (`AppEnv.Variables.uuid`, server/src/hono-env.ts)
- ratelimit (server/src/middleware/ratelimit.ts:19-35): 每中间件实例一个 `Map<ip, timestamps[]>` 滑动窗口, IP 取 `X-Forwarded-For` 首段或 socket 地址; `/login`、`/register` 各 10 次/60s, `/user/update-password` 5 次/60s
- admin (server/src/middleware/admin.ts): 查缓存或 DB 的 `is_admin === 1`
- cors (server/src/middleware/cors.ts): 全放开 (`Access-Control-Allow-Origin: *`) + OPTIONS 204

## 三、数据层: Prisma/PostgreSQL 与缓存双组

### 数据模型

`server/prisma/schema.prisma` 定义 8 个模型, 聊天域的 uuid 均为带前缀的 12 位随机串 (`U`/`S`/`G`/`M`/`T`/`A` + `randomId(11)`, 62 字符表, server/src/common/ids.ts:14-19), 前缀即路由语义: `receiveId` 以 `U` 开头走单聊分支, 以 `G` 开头走群聊分支.

| 模型         | 表名           | 要点                                                                                                    |
| ------------ | -------------- | ------------------------------------------------------------------------------------------------------- |
| UserInfo     | user_info      | uuid 唯一; telephone 索引 (登录凭据); status/isAdmin 用 Int 线路值; lastOnlineAt/lastOfflineAt 在线轨迹 |
| Session      | session        | 每用户每对端一行 (sendId=拥有者), 软删除; lastReadAt 驱动未读计数                                       |
| Message      | message        | 冗余 sendName/sendAvatar (免 JOIN); status 0 未送达/1 已送达; avData 存通话信令 JSON                    |
| GroupInfo    | group_info     | `members String[]` (PG 原生数组); addMode 0 直接进群/1 审批                                             |
| UserContact  | user_contact   | 双向联系人边, status 0-7 (normal/black/beBlack/delete/beDelete/mute/quit/kicked)                        |
| ContactApply | contact_apply  | 好友/入群申请, status 0 applying/1 pass/2 refuse/3 black                                                |
| ContactTag   | contact_tag    | 联系人标签, 注册时默认建 "Friends" 标签 (user-service.ts register)                                      |
| AgentSession | agent_sessions | userId 唯一 (每用户一行); `context Json` 存 agent 对话快照; status 为 PG enum (IDLE/RUNNING/...)        |

聊天域的状态/类型列刻意保持 Int 而不用 PG enum, schema 注释解释了原因: 线路上传输的就是原始整数, 这些整数取值 (如 contact status 0-7) 是承重墙; enum 只用于 agent 内部状态 (schema.prisma:10-12). 消息类型常量: 0 文本 / 1 图片 / 2 文件 / 3 音视频信令 / 4 视频 / 5 系统通知 (server/src/hub/frame-types.ts:52-57), 客户端在 schemas.ts 中以 `MessageType` 常量镜像.

迁移历史两条: `20260924041225_init` 建全部表 (当时含 agent_interactions 表), `20260924050617_drop_agent_interactions` 删掉该表及两个 enum —— agent 交互 (权限/提问) 改为纯内存 broker, 不再落库. 已提交的 `src/generated/prisma/` 生成产物中仍残留 `AgentInteraction` 模型类型 (models.ts:19), 落后于当前 schema; 构建脚本 `prisma generate && tsc` 会重新生成, 不影响运行.

### 手写 JWT 与口令

- JWT (server/src/common/jwt.ts): 不依赖 jsonwebtoken 库, 用 `createHmac("sha256")` 手拼 `header.payload.signature`, header 为固定的 raw-base64url 字节 (`{"alg":"HS256","typ":"JWT"}`, jwt.ts:9-10); `parseToken` 用 `timingSafeEqual` 防时序攻击, 校验 uuid 非空与 exp 过期. claims 只有 `{uuid, iat, exp}`, 有效期 `TOKEN_EXPIRE_HOURS` 默认 336 小时 (14 天), 无 refresh 机制 —— 客户端注释 "The token never refreshes, so an expired one can only be resolved by re-login" (client/src/service/http.ts:38)
- 口令 (server/src/common/password.ts): bcryptjs cost 10, 显式拒绝超过 72 字节的口令 (`PasswordTooLongError`)
- `/user/update-password` 免鉴权按手机号重置密码, user-service.ts 的注释注明这是刻意不加鉴权的重置流程, 是已知安全缺口 (无邮件/短信验证)

### 缓存: 两个读穿组

`CacheService` (server/src/cache/cache-service.ts) 使用两个读穿组: `user_info` (按 uuid 缓存用户投影, 不含 password/deletedAt) 与 `session_list` (按拥有者 uuid 缓存会话行). 双实现:

- `RedisStore`: key 前缀 `yukino:cache:<group>:<key>`, 另维护 `idx` set 与 `meta` hash (记录 size/expire_at) 供看板枚举; TTL 取 `CACHE_TTL_SECONDS` (默认 300s); 所有读写 try/catch 吞错, Redis 故障一律降级为 miss, DB 始终是唯一事实源 (cache-service.ts:4-7 注释)
- `MemoryStore`: `REDIS_URL` 为空串时使用 (测试环境即如此, server/vitest.config.ts 强制 `REDIS_URL: ""`)

会话列表缓存的读穿在 `SessionService.loadSessions` (server/src/services/session-service.ts:250-259); 失效点包括 openSession 创建、deleteSession、markSessionRead、touchGroupSessions 等, 一律 `cache.deleteSessionList(owner)`. 消息管线解析发送者昵称/头像时也先查 user_info 组缓存 (message-pipeline.ts:153-178).

## 四、/wss 聊天枢纽: ChatHub 与 MessagePipeline

### 连接管理 (ChatHub)

`ChatHub` (server/src/hub/chat-hub.ts) 维护 `Map<uuid, ClientConn>`, 每用户至多一条连接:

- `register`: 同一 uuid 的旧连接被 `safeClose` 挤掉 (顶号登录语义, chat-hub.ts:63-77); 新连接先收到纯文本欢迎帧 `"welcome to yukino chat"`; 仅在非顶号替换 (没有旧连接) 时才向其他所有在线用户广播 `online` 系统通知并异步更新 `lastOnlineAt` (chat-hub.ts:70-76), 顶号场景不重复广播在线状态
- 心跳: 30s 定时器扫描 (chat-hub.ts:20-22, 47-61), 超过 90s 无任何帧的连接直接注销; 一个周期内未见 pong 的连接 `terminate()`; 客户端无需实现应用层 ping, 服务端用 WS 协议层 ping/pong (ws-chat-route.ts:37-42 监听 raw `pong` 事件刷新 alive/lastSeen)
- `unregister`: 若该用户还在通话中, 代其向房间剩余成员广播 `leave_call` 信令帧, 保证对端关闭死流 (chat-hub.ts:87-110); 随后广播下线 `online` 通知并更新 `lastOfflineAt`
- `pushSystem(topic, uuids)`: 构造 `{type:5, send_id:"SYSTEM", content:topic}` 帧定向推送; topic 取值 contact/group/apply/session/online (frame-types.ts:45-49), 语义是 "该列表脏了, 请重新拉取", 不携带数据

`/wss` 握手 (server/src/routes/ws-chat-route.ts): 浏览器无法在 upgrade 请求上加 header, token 走 query; `client_id` 若传则必须与 token uuid 一致, 注释解释了动机: 信任客户端自报 id 会让任何知道 uuid 的人顶掉他人 socket 并收其消息 (ws-chat-route.ts:23-28).

### 消息管线 (MessagePipeline)

`MessagePipeline` (server/src/hub/message-pipeline.ts) 是 /wss 全部入站帧的处理器, 设计上以单消费者串行链消费所有帧:

1. 串行化: 所有帧经 `chain: Promise<void>` 顺序处理; `depth` 超过 `CHANNEL_SIZE = 1024` 时回发溢出帧 `{type:-1, content:"message send failed, please retry"}` (message-pipeline.ts:18, 38-39, 62-76; 溢出帧常量在 frame-types.ts:39-40)
2. 帧解析: `coerceFrame` 采用 JSON 零值语义 —— 缺失的 string 字段取零值, 仅类型错误拒绝整帧; `type` 必须是整数 (message-pipeline.ts:534-567)
3. 防伪: `req.send_id` 强制覆写为连接属主 uuid, 昵称/头像从缓存或 DB 重取 (`resolveSender`), 客户端无法冒充他人 (message-pipeline.ts:87-94, 150-178)
4. 持久化: 普通消息 (type != 3) 先写 message 表, 失败即静默返回
5. 会话触达: 单聊消息 `touchDirectSessions` 保证双方各有一行未删除的 session (软删的自动恢复, session-service.ts:292-313); 群聊消息 `touchGroupSessions` 批量保证每个成员都有群会话行 (session-service.ts:317-361) —— 即自动创建/恢复会话
6. 扇出: `broadcast` 计算目标集 —— 单聊为 `[接收者, 发送者(回显)]`, 群聊为全体成员 (含发送者); 逐个检查 `hub.isOnline` 后 `sendRaw`; 至少送达一人且非信令帧时把消息 status 置 1 并记 sendAt (`markSent`, message-pipeline.ts:239-256). 离线用户不推送, 上线后靠会话列表的未读计数与历史接口补齐
7. Agent 分发: 收件人是 Yukino 时进入 `dispatchToYukino` (见第七章)

客户端侧 `store/ws.ts` 的帧分派 (client/src/store/ws.ts:84-116): 非 `{` 开头的帧 (欢迎文本) 忽略; `type:-1` 弹 toast; `type:3` 先于系统帧分派给信令监听器 (因为 `call_failed` 以 SYSTEM+type3 形态到达); `send_id==="SYSTEM"` 的 type5 帧按 topic 查 `staleKeysByTopic` 表, 使对应 React Query key 失效 (数据拉取模型: WS 只送 "脏了" 信号, 数据仍走 HTTP); 其余消息帧用 `uniqBy(uuid)` 追加进已缓存的会话记录 (未打开过的会话不写缓存, 避免伪造 fresh 状态抑制真实拉取, ws.ts:74-80).

WS 连接生命周期: 指数退避重连 (1s 起步 x2, 上限 30s, ws.ts:34-35, 118-124), 重连成功后 `queryClient.invalidateQueries()` 全量刷新 (ws.ts:148-152), 连接由 App 组件跟随登录 uuid 建立/断开 (client/src/app.tsx:70-76).

## 五、WebRTC 音视频: 服务器只做信令

服务器不理解 WebRTC, 只把 type-3 消息的 `av_data` 字段当作 JSON 信封路由. `AVSignal` 形状为 `{messageId, type, media, room_id}` (frame-types.ts:32-37): `messageId: "PROXY"` 表示服务器要介入的房间生命周期帧, `messageId: "PEER_LEAVE"` 表示对端断连, 其余 (sdp/candidate) 纯转发.

### 服务端: CallManager 与信令解释

`CallManager` (server/src/hub/call-manager.ts) 只有两个 Map: `rooms: Map<roomId, Set<uuid>>` 与 `users: Map<uuid, roomId>` (每用户至多一个房间, 即忙状态). 房间 id 派生规则 `roomId()`: 群聊直接用群 uuid, 1v1 用 `P:<sorted-uuid-pair>`, 保证两端算出同一 id; 客户端 `callRoomId()` 逐字复刻 (client/src/utils/rtc.ts:36-40).

`handleAVMessage` (message-pipeline.ts:261-363) 的分支表:

| 帧                                | 服务端动作                                                                                                                                                                                                                      |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PROXY/start_call`                | `handleStartCall`: 校验对端在线/不忙 (群聊则筛出在线且空闲的成员), caller 入房, 向 callee(s) 转发邀请; 任一失败向 caller 回 `call_failed` + 原因 (message-pipeline.ts:367-442); Yukino 收到呼叫直接拒绝 ("text-only assistant") |
| `PROXY/receive_call`              | 1v1 接听: callee 入房, 帧转发给 caller —— caller 收到后创建 offer, 消除 glare                                                                                                                                                   |
| `PROXY/join_call`                 | 群聊接听: 新人入房, 只通知房间既有成员, 每人与新人单独建连                                                                                                                                                                      |
| `PROXY/reject_call`               | 1v1 拒接: 房间全员释放, 帧转发 caller; 群聊拒接是纯本地行为 (客户端不发帧, rtc.ts:91-96)                                                                                                                                        |
| `PROXY/leave_call` / `PEER_LEAVE` | 挂断: `calls.leave()` 返回剩余成员并转发; 若 callee 尚未接听而 caller 已挂, 补发给 callee 关闭来电弹窗 (message-pipeline.ts:347-360)                                                                                            |
| `sdp` / `candidate` 等            | 点对点原样转发 (receive_id 指向单个 peer, 不广播)                                                                                                                                                                               |

只有 start_call/receive_call/reject_call 三种信令会落库为消息 (message-pipeline.ts:286-311), 供聊天记录保留通话痕迹; 客户端渲染时把 type-3 全部过滤 (message-bubble.tsx:128). 断连兜底在 `ChatHub.unregister` (见第四章). `/chatroom/get-callers` 返回房间内除自己外的成员, 并有可见性校验: 在房内、或属于自己参与的 1v1 房间、或群成员 (server/src/routes/chatroom-routes.ts:29-40).

### 客户端: mesh 拓扑的 CallManager 类

`client/src/utils/rtc.ts` 的 `CallManager` 类 (与 zustand store 同名概念, 但这是纯类) 持有 `links: Map<peerId, PeerLink>`, 每个 PeerLink 一条 `RTCPeerConnection` + 一个聚合远端 track 的 `MediaStream` —— 群聊是全网状 (mesh) 拓扑, 无 SFU. 关键细节:

- `new RTCPeerConnection()` 不带任何配置 (rtc.ts:216): 没有 STUN/TURN 服务器, ICE 只能靠 host candidate, 跨 NAT 场景无法打通, 适用局域网/同机部署
- 信令复用聊天 WS: `signal()` 把 `{messageId:"PROXY", type, room_id, messageData?}` 塞进 type-3 帧的 av_data (rtc.ts:326-354); sdp/candidate 的 receive_id 必须指向单个 peer, 注释解释了发群 id 会把一个人的 offer 泄露给全体成员 (rtc.ts:42-49)
- glare 消除靠角色约定: 1v1 由 caller 在收到 `receive_call` 回执后 offer, 群聊由既有成员向新人 offer, "the offering side is unambiguous" (rtc.ts:86-88, 139-142)
- candidate 竞态: remoteDescription 未就绪时 candidate 进 `queued` 数组, setRemoteDescription 后 flush (rtc.ts:268-282)
- `connectionState === "failed"` 即丢弃该 peer; 1v1 中唯一 peer 消失即整场结束, 群聊继续 (rtc.ts:284-293)
- 跨帧防串台: 携带 room_id 且与当前房间不符的迟到帧直接忽略 (rtc.ts:126-128)

UI 层 `store/call.ts` 维护 `phase: idle|ringing|dialing|active` 状态机, 拨出 45s 无应答自动挂断 (`NO_ANSWER_TIMEOUT_MS`); 信令监听在模块加载时全局订阅, 任何页面都能响铃 (call.ts:141-166). `components/call-dialog.tsx` 渲染本地+远端 video 瓦片、静音/挂断按钮与秒表; `peers.length > 0` 即进入 active 并记 connectedAt (call.ts:124-133).

## 六、分块断点续传文件传输

### 协议: verify -> upload-chunk* -> merge

服务端三个端点 (server/src/routes/file-routes.ts):

- `POST /file/verify` `{file_hash, ext_name, chunk_cnt}`: 先 `stat` 最终文件 `<hash>.<ext>`, 存在则回 `{uploaded:true, url}` (秒传); 否则逐个 `stat` chunk 目录下 `chunk-<i>`, 回缺失下标数组 `{uploaded:false, pending_chunks:[...]}` (file-routes.ts:25-57) —— 断点续传的服务器状态就是磁盘上已存在的 chunk 文件, 无 DB 记录
- `POST /file/upload-chunk` multipart: 校验 `file_hash` 为 8-64 位 hex、`ext_name` 为 1-10 位字母数字 (正则白名单, file-routes.ts:11-15), chunk 上限 10 MiB (`MAX_CHUNK_SIZE = 10 << 20`), 写入 `<STATIC_CHUNK_DIR>/<hash>/chunk-<idx>`
- `POST /file/merge`: 按 idx 排序拼接全部 chunk, 写最终文件后 `rm -rf` chunk 目录; 中途读失败会删除半成品最终文件, 注释说明是为了避免截断文件被后续 verify 误判秒传 (file-routes.ts:143-147); 最终文件已存在时直接回成功 (幂等)

最终文件以内容寻址命名 (`<sha256-hash>.<ext>`), 同内容天然去重; 服务目录是 `STATIC_FILE_DIR`, 经 `/static/files/*` 公开访问. 上传路径的 hash/ext 都过了正则, 路径穿越面被压掉.

### 客户端: worker 哈希 + 并发限流 + 重试

`client/src/service/upload.ts` 的 `uploadInChunks`:

- 参数: `CHUNK_SIZE = 5 MiB` (服务端上限的一半), `MAX_PARALLEL_CHUNKS = 3` (es-toolkit `Semaphore` 限流), `CHUNK_ATTEMPTS = 3` 次重试、线性退避 1s/2s, 总大小上限 2 GiB (upload.ts:8-15)
- 哈希在 Web Worker 中计算 (upload.ts:30-69): `workers/file-hash.worker.ts` 逐 5 MiB slice 做 `crypto.subtle.digest("SHA-256")`, 再把所有分片摘要拼接后二次 SHA-256 得到最终 hex —— 注释解释了动机: Web Crypto 没有增量摘要 API, 一次性哈希 2 GiB 需要整块 ArrayBuffer 驻留内存, 分片二次哈希把内存占用钳制在一个 slice (file-hash.worker.ts:1-6, 38-50). 哈希进度经 `postMessage` 回报, UI 显示 "Hashing x/y" 与 "Uploading x/y" 两段进度
- 流程: 哈希 -> verify -> 秒传直接返回 -> 只上传 `pending_chunks` (断点续传: 刷新页面重选同一文件, 已上传 chunk 不再传) -> merge -> 返回 `{url, file_name, file_size}`
- 中止: 全链路穿透 `AbortSignal`, worker 收到 abort 即 terminate

`components/message-composer.tsx` 中上传成功后按 MIME 派生消息类型 (image/* -> 1, video/* -> 4, 其余 -> 2) 并以帧发送 (message-composer.tsx:105-109, 125-138). 另有传统单请求上传端点 `/message/upload-file` (50 MiB 上限) 与 `/message/upload-avatar` (5 MiB + 扩展名白名单 jpg/jpeg/png/gif/webp), 头像与普通文件用 `randomId(8)_` 前缀防碰撞, `sanitizeFilename` 剥路径分量并只保留 `[a-zA-Z0-9.\-_]` (server/src/routes/message-routes.ts:15-29, 37-63), 落盘用流式 pipeline 避免 50 MiB 进内存.

## 七、每用户 Yukino Agent: AgentManager 与 AgentRuntime

这是本项目与纯 LLM 聊天应用的本质区别: 集成的不是 "调一次补全接口", 而是完整的 Yukino coding agent (工具执行、MCP、权限、计划模式、上下文压缩), 以 `@yukino.js/yukino` 0.0.4 库的形式嵌入服务进程 (无子进程), 每用户一个 runtime, 工作区 `.yukino/chat/<uid>`, 空闲 30 分钟回收.

### 配置发现 (yukino-config.ts)

`loadAgentConfig()` (server/src/agent/yukino-config.ts:18-60) 两级回退:

1. 首选 `Config.loadConfig("")` 读 yukino 库的标准配置 (查找顺序 `~/.yukino/config.yaml`, 其次工作目录 `./.yukino/config.yaml`; 传 `allowEmptyProviders: true` 容忍空 provider 列表), 取第一个 provider、`mcp_servers`、`hooks`、`permission_mode`
2. 无配置文件时用 `YUKINO_AI_PROTOCOL/BASE_URL/API_KEY/MODEL` 环境变量合成单 provider (protocol 默认 openai-compat); BASE_URL 或 MODEL 为空则返回 null
3. null 即 "agent 不可用": 聊天主流程完全不受影响, `AgentManager.available = false`, 用户私聊 Yukino 会得到一条 "not configured" 的聊天回复 (agent-manager.ts:130-139)

结果进程内缓存一次 (`cached` 变量), 运行期改配置需重启.

### AgentManager: 注册表 + 聊天落库 sink

`AgentManager` (server/src/agent/agent-manager.ts):

- `runtimes: Map<userId, AgentRuntime>` 懒创建, 每用户工作区 `path.join(process.cwd(), ".yukino", "chat", userId)` (agent-manager.ts:58-64)
- 空闲回收: 60s 定时器扫描, `!isBusy() && connectionCount === 0 && 空闲 > AGENT_IDLE_MS (默认 30 min)` 即 `dispose()` (agent-manager.ts:11, 37-49)
- `makeSink()` 是关键设计 (agent-manager.ts:70-124): agent 的最终文本回复经 `saveAssistantText` 走与人类对端完全相同的 "insert message 表 + hub.sendRaw 广播" 路径, send_id 为 `UYUKINOAGENT` —— 于是助手消息天然获得历史记录、会话预览、未读计数, 刷新后依然存在. README "finalized replies are written back into the chat transcript" 说的就是这条路径
- `dispatch(userId, chatSessionId, messageId, content)`: 消息管线把用户发给 Yukino 的文本帧路由到这里 (message-pipeline.ts:507-531); 非文本消息回复 "I can only read text messages — please describe what you need in writing."; 群聊刻意不接入 ("Yukino only takes part in one-to-one conversations", message-pipeline.ts:507-509 注释)
- 账号接线: 启动时 `ensureYukinoUser` 建保留账号 (uuid `UYUKINOAGENT`, 名字 Yukino, 签名 "Your built-in AI assistant", common/ids.ts:21-25); 注册与登录时 `ensureYukinoContact` 幂等地建立双向联系人边 + 会话行, 且该会话不可删除 (session-service.ts:264-266)

### AgentRuntime: 队列、回合与再水化

`AgentRuntime` (server/src/agent/agent-runtime.ts) 是每用户长生命周期对象:

- `ensureReady()` (agent-runtime.ts:93-113): 首次使用时创建/复用 `agent_sessions` 行, `mkdir` 工作区, 调 `Remote.Server.createRemoteAgent({provider, workDir, mcpServers, hooks, enableCoordinatorMode: false, forkDisabled: false, askUser})` 拿到完整 agent 栈句柄 (client、conversation、registry、contextWindow、teamManager、backgroundTaskManager 等), promise 缓存防并发重建
- 再水化 (agent-runtime.ts:118-125): 从 DB `context` JSON 恢复对话, 过滤掉可再生的 `<system-reminder>` 包裹消息防止跨重启累积; 每回合结束 `saveContext` 把 `conv.getMessages()` 快照写回 DB. 持久化策略是 DB-only: 构造 `Agent.Agent` 时 `sessionId: ""` 显式禁用库自身的 JSONL 会话写入 (agent-runtime.ts:268-271 注释), agent-stores.ts 头注释: "JSON is the only memory that survives restarts: DB is authoritative"
- 上下文窗口策略: 每回合构造 `Agent.Agent` 时透传 `contextWindow: handle.contextWindow` 与 `maxOutput: Config.getMaxOutputTokens(handle.provider)` (agent-runtime.ts:275-276), 窗口上限由 provider 配置决定; 主动压缩走 `/compact` 斜杠命令调 `Compact.Compact.forceCompact` (agent-runtime.ts:366-384), 与 yukino 库的自动压缩机制共用同一 conversation/recoveryState
- 提示队列 (agent-runtime.ts:186-223): `dispatch` 入队, 单 worker 串行消费; 队长超 `AGENT_QUEUE_CAP` (默认 8) 时向所有连接推 "Yukino is still working through earlier messages — please wait for it to catch up." 系统通知并丢弃 (agent-runtime.ts:190-202)
- 回合执行 `runTurn` (agent-runtime.ts:227-323): `/` 开头走斜杠命令; 否则 `agent/run_start` 通知 -> `conv.addUserMessage` -> 同步 MCP instructions -> 每回合新建 `Permissions.PermissionChecker(workDir, permissionMode)` 与全新 `Agent.Agent` 实例 -> `for await (event of agent.run())` 消费事件流, 交 EventAdapter 翻译 -> finally 中 `saveContext`
- 斜杠命令 (agent-runtime.ts:351-401): `/help` 列出命令、`/clear` 重置对话并清 MCP 公告集、`/compact` 强制上下文压缩、`/plan` 在 default/plan 两种权限模式间切换 (plan 即只读研究模式)
- 取消与销毁: `cancel()` 触发 AbortController 并让 broker 拒绝所有挂起交互 (agent-runtime.ts:413-417); `dispose()` 幂等, 存上下文、断 MCP、停后台任务与 team、以 1001 关闭所有 WS 连接 (agent-runtime.ts:420-438)

### EventAdapter: 事件流到 RPC 通知的翻译

`EventAdapter` (server/src/agent/event-adapter.ts) 是每回合有状态的翻译器, 把库的 `AgentEvent` 映射成 JSON-RPC 通知或 flush 动作:

| 库事件                                  | 产出                                                                                      |
| --------------------------------------- | ----------------------------------------------------------------------------------------- |
| `stream_text`                           | 累积进内部 buffer, 同时通知 `agent/stream_text` (瞬态, 不落库)                            |
| `thinking_text` / `thinking_complete`   | `agent/thinking_text` / `agent/thinking_complete`                                         |
| `tool_use`                              | 先 flush (已完成的文本块落库为聊天消息), 再 `agent/tool_use`                              |
| `tool_result`                           | `agent/tool_result` (output/isError/elapsed)                                              |
| `turn_complete` / `loop_complete`       | flush + `agent/turn_complete` / `agent/loop_complete` (totalTurns/elapsed/stopReason)     |
| `usage` / `error` / `compact` / `retry` | `agent/usage` / `agent/error` (取消引发的 error 被吞掉) / `agent/compact` / `agent/retry` |

flush 的落库动作在 runtime 的 `flushText` (agent-runtime.ts:327-333): 取走累积文本 -> `sink.saveAssistantText` 写消息表并广播 -> 通知 `agent/stream_end {text, messageId}`, messageId 成为客户端后续 overlay 的锚点. 语义即 "streaming deltas stay ephemeral, completed text blocks flush into one persisted chat message each" (event-adapter.ts:9-12 注释).

### InteractionBroker: 人机回环

工具权限与提问走 `InteractionBroker` (server/src/agent/interaction-broker.ts): `requestPermission`/`requestAnswers` 返回 Promise 并把 resolver 存入 Map, 超时 `AGENT_INTERACTION_TIMEOUT_MS` (默认 5 min) 后 fail-closed —— 权限超时视为 deny (interaction-broker.ts:31-39, 单测 "fails closed: permissions time out to deny"). `snapshot()` 让重连的客户端立刻重放所有挂起提示 (interaction-broker.ts:71-77). 权限请求由 runtime 的 `onPermissionRequest` 回调发起: `checker.describeToolAction` 生成人类可读描述, `notifyAll("permission/request")` 推给全部连接, 然后 await broker (agent-runtime.ts:290-299). `askUser` (提问卡片) 同构 (agent-runtime.ts:337-347).

## 八、/agent/ws: JSON-RPC 2.0 桥

### 服务端协议

`server/src/agent/rpc-protocol.ts` 定义 JSON-RPC 2.0 词汇 (RpcNotification/RpcSuccess/RpcError 与各方法的 zod schema). 方向约定: 服务器只推 notification (无 id), 客户端只发 unary request (带 id), 客户端发的 notification 被静默忽略 (ws-agent-route.ts:93-94).

握手流程 (`registerAgentWsRoute` -> `runtime.attach`, ws-agent-route.ts:44-68 + agent-runtime.ts:143-161): token 验签 -> `getOrCreate` runtime -> `attach` 依次推送 `session/connected` (model/streaming/ready/anchorId/token 用量/permissionMode)、`session/commands` (SERVER_COMMANDS: help/clear/compact/plan, rpc-protocol.ts:74-79)、broker snapshot 中的全部挂起 `permission/request` 与 `question/ask`. runtime 创建失败 (未配置) 时回 `agent/error` 通知而不中断连接.

客户端可调方法 (`dispatchControl`, ws-agent-route.ts:103-152): `ping` (保活应答)、`permission/respond {id, response: allow|deny|allowAlways}`、`question/respond {id, answers}`、`session/cancel`; 未知方法回 -32601, 参数不合法回 -32602, respond 类返回 `{applied: boolean}` (false 表示 id 未知或已过期). 入站帧上限 4 MiB —— 注意路由用的是本地常量 `MAX_MESSAGE_BYTES` (ws-agent-route.ts:20), env.ts:15 定义的 `AGENT_WS_MAX_MESSAGE_BYTES` 并无消费者, 属于声明未接线.

### 客户端 agent store: overlay 时间线与重连

`client/src/store/agent.ts` 的核心注释点明分工: "Prompts and finished replies travel the chat socket; this store holds only what the transcript cannot" —— 提示词与落库回复走 /wss 聊天通道, /agent/ws 只承载转录无法表达的东西: 流式气泡、thinking、工具卡片、等待中的权限/提问卡.

- 连接: 进入助手会话时 connect、离开即 disconnect (pages/chat.tsx:70-75); 指数退避重连 (1s 起步 x2, 上限 30s, store/agent.ts:39-40, 436-439), 重连每次都以空 overlay 开始 ("Progress is only meaningful next to the transcript it belongs to", store/agent.ts:453-456); 每 10s 发 `ping` 请求防代理闲置断连 (store/agent.ts:41, 417-423). 重连的丢数据窗口由两个机制兜住: 落库回复经 /wss + HTTP 历史重取找回, 挂起的权限/提问由 `runtime.attach` 重放 broker snapshot, 因此交互类状态不会因断连而悬空
- 状态机 `apply()` (store/agent.ts:133-370) 把通知折叠成 `items: AgentItem[]` 时间线, 每项携带 `anchorId` (应挂在哪条聊天消息之后): `agent/run_start` 设 anchor 为用户消息 id; `stream_text`/`thinking_text` 增量拼接当前流式项; `stream_end` 把流式项定格并绑定落库 messageId, 后续 anchor 前移; `tool_use` 对同名同 id 的重复公告去重 (args 只在第二次公告到达, store/agent.ts:256-268 注释); `loop_complete`/`error` 触发 `settlePrompts` 把未答的权限/提问卡定格, 防止死卡常驻
- notice 去重: 与上一条完全相同的系统/错误行直接丢弃, 防止重连风暴刷屏 (store/agent.ts:87-101)
- 响应请求 fire-and-forget: `respondPermission`/`answerQuestions`/`stop` 发出即本地更新卡片状态, 不等 `{applied}` 回执 (store/agent.ts:56-63 注释)

### 转录与 overlay 的缝合 (pages/chat.tsx)

聊天页把 agent items 按锚点缝进消息流 (chat.tsx:80-96): 落库消息 uuid 集合为 `storedUuids`; anchor 命中的 items 归入 `overlayByAnchor`, 经 `MessageBubble` 的 `renderAfter(uuid)` 回调渲染在该气泡之后; 未命中的进 `trailingOverlay` 渲染在列表尾部. 流式气泡的交接零闪烁: `stream` 项一旦其 messageId 出现在 storedUuids (即 /wss 已把落库消息推来), 该 overlay 项被跳过, 由真实消息气泡接管 (chat.tsx:77-87, 注释 "A streamed bubble hands over to its stored message"). 助手会话的 composer 关闭附件 (`allowAttachments={false}`, 服务端对非文本也只回一句话), streaming 时显示 Stop 按钮接 `session/cancel`, 斜杠命令菜单由 `session/commands` 驱动.

`components/agent/agent-item.tsx` 渲染六类 item: stream (复用 MessageContent/Streamdown, 流式光标)、thinking (Collapsible 折叠)、tool (按工具名映射图标 Bash->Terminal、Grep/Glob/WebSearch->Search、`Read*`/`Write*`/`Edit*` 前缀->FileText、其余->Wrench, args 预览取 command/file_path/pattern/path/url 首个非空键, 输出截断 5000 字符, agent-item.tsx:37-58)、notice (系统/错误/完成单行提示, 按 tone 取 AlertTriangle/CircleCheck/Info 图标, agent-item.tsx:151-164)、permission 卡 (allow/deny/allowAlways)、question 卡 (多问题多选项).

## 九、React 客户端工程化

### 请求层与数据获取

- `service/http.ts`: fetch 封装, 信封 zod 校验; 普通请求 15s 超时、上传 120s (`AbortSignal.timeout` + `AbortSignal.any` 合并调用方 signal, http.ts:33-36); code 401 时 `clearAuth()` 并跳 /login; `ApiError` 携带 body code, 网络错误统一 -1
- `lib/query-client.ts`: 全局 staleTime 30s, 关窗聚焦重取; retry 策略区分故障类型 —— 后端明确拒绝的 ApiError 不重试, 仅传输层错误重试至多 2 次; MutationCache 全局 onError toast
- `service/queries.ts`: query key 按域分层 (`keys.sessions.user(userId)` 等), WS 系统帧按 `keys.<domain>.all` 整支失效 (store/ws.ts:45-51); `openSessionQuery` 把幂等的 open-session POST 当 query 用 (`staleTime: "static"`, queries.ts:78-85)
- `service/schemas.ts`: 全部响应 zod 化, `wireList` 把 `null` 空列表还原为 `[]`; `resolveAvatar` 在 transform 里把空头像/默认头像替换为 identicon

### 状态分域 (zustand)

| store       | 持久化                              | 职责                                                                                        |
| ----------- | ----------------------------------- | ------------------------------------------------------------------------------------------- |
| auth        | sessionStorage (`yukino-auth`)      | token + userInfo; 选 sessionStorage 意味着登录态按标签页隔离                                |
| preferences | localStorage (`yukino-preferences`) | "记住手机号" (登录页 remember 勾选, 注释说明放 localStorage 以跨 sessionStorage 作用域存活) |
| ws          | 无                                  | 主聊天 socket、帧分派、重连                                                                 |
| call        | 无                                  | 通话状态机, 桥接 utils/rtc 的 CallManager                                                   |
| agent       | 无                                  | /agent/ws 时间线 (见第八章)                                                                 |
| dashboard   | 无                                  | /dashboard/ws 快照, 3s 固定间隔重试                                                         |

### UI 要点

- 路由 (client/src/app.tsx:41-64): `createBrowserRouter`, `/` 由 loader 鉴权 (`requireAuth` 未登录 redirect /login), AppShell 布局下 `/chat/sessions`、`/chat/contacts`、`/chat/profile`、`/chat/:id`、`/manager` 五个子路由, `/dashboard` 独立于 AppShell; login/register 已登录反向重定向
- 消息渲染: `MessageContent` 用 Streamdown `mode="static"` + cjk/code/math/mermaid 四插件 (message-content.tsx), 因携带 shiki/katex/mermaid 体积大, 在气泡与 agent item 中都以 `lazy()` 单独成 chunk (message-bubble.tsx:13-18 注释)
- 气泡列表: 日期分隔条、motion 入场动画、`use-stick-to-bottom` 贴底滚动 (chat.tsx:98-101)
- 输入器: TipTap StarterKit 关掉全部 mark 与输入规则, 让字面 markdown 原样入库、由渲染端还原 (message-composer.tsx:24-46 注释); Enter 发送/Shift+Enter 换行/输入法组字中不发送; 斜杠命令菜单用 `@tanstack/react-virtual` 虚拟化, 键盘导航与 hover 高亮分离 (menuKeyRef 经 ref 读最新闭包, message-composer.tsx:239-273); 拖拽上传用 react-dropzone, 助手会话干脆不挂 dropzone props (禁用会让 Stop 按钮也被读作 aria-disabled, message-composer.tsx:286-289 注释)
- identicon 头像: FNV-1a 播种 xorShift32 PRNG, canvas 画 5x5 镜像格, memoize (utils/avatar.ts)
- 命令面板: cmdk + `mod+k` 热键 (react-hotkeys-hook), 打开时才拉数据 (command-palette.tsx:24-30)
- 主题: next-themes `attribute="class"` + 系统跟随; 表格虚拟化: `lib/use-windowed-rows.ts` 用 spacer 行保持真实 `<table>` 语义
- 表单: TanStack Form + zod (lib/validation.ts: 手机号正则 `^1[3-9]\d{9}$`、密码 >=6、昵称 3-10), 登录页含封禁检测 (status===1 toast "banned") 与重置密码 dialog

### PWA 与可观测性

- vite-plugin-pwa `registerType: "autoUpdate"`, workbox 预缓存 js/css/html/svg/png/woff2 + Google Fonts CacheFirst; 注意 manifest 的 name/short_name/description 均为 "resume" (vite.config.ts:73-75), 是模板残留, 与产品名不符; 生产 scope/start_url 为 `/yukino-chat/`
- `@yukino.js/sentry` 0.0.1: 仅 DEV 初始化 (`init({dsn:"/api/log"})` + Performance/ScreenRecord 插件, main.tsx:15-20), Vite 侧 `sentryPlugin({dsn:"/api/log"})` mock 上报端点, 报告落 `client/logs/*.jsonl`; 生产构建 `sourcemap: "hidden"` 且自定义 `moveSourcemaps` 插件把 .map 挪进 `dist/.sourcemaps/` 不随站点发布 (vite.config.ts:9-40, 136-139); `fetchPriorityHints` 插件给样式与模块脚本注入 `fetchpriority="high"`
- 根级错误边界: `ReactErrorBoundary` 包 App, 路由级 `RootErrorBoundary` 展示 useRouteError

## 十、管理端与缓存看板

- `/manager` 页 (client/src/pages/manager.tsx, admin 路由挂在 AppShell 下): 用户表 (启用/禁用/批量删除/设管理员, 对应 `/user/*` admin 端点) 与群组表 (状态控制/删除, 对应 `/group/*` admin 端点), 长表用 `useWindowedRows` 虚拟化
- `/dashboard` 页 + `/dashboard/ws`: 服务端每 2s 推送 `CacheService.snapshot()` —— 两个组各自的 keys/bytes 统计与逐条 key/size/expire_at (ws-dashboard-route.ts:8, 30-44; cache-service.ts:215-239); 客户端可发 `{action:"delete", group, key}` 删除缓存键 (ws-dashboard-route.ts:45-56); 页面用 `@number-flow/react` 做数字滚动动画, 断线 3s 固定间隔重连 (store/dashboard.ts:26). 路由层 admin 校验见 ws-dashboard-route.ts:22-25

## 十一、测试

- Vitest 单测 4 个文件 (server/tests, `vitest run`, 环境强制 `REDIS_URL=""` 走内存缓存、不触 DB, vitest.config.ts 注释): `common.test.ts` (JWT 往返/错密钥/畸形、randomId、sanitizeFilename)、`call-manager.test.ts` (房间 id 派生、忙状态、leave 返回剩余成员、空房解散)、`event-adapter.test.ts` (流文本累积与 tool_use 触发 flush、回合计数)、`interaction-broker.test.ts` (fake timers 验证权限超时 fail-closed 等)
- Smoke 脚本 2 个 (对运行中的服务器, 默认 :8000): `http-smoke.mjs` 以约 30 次请求覆盖注册/登录/错误路径/联系人/群组/会话/消息/管理守卫全流程, 末尾循环 `/login` 直至 429 验证按 IP 限流 (刻意放在最后, 避免污染限流桶, 脚本注释自述); `ws-smoke.mjs` 覆盖聊天 WS 握手、在线状态、单聊/群聊扇出、顶号驱逐、call_failed、agent WS 握手+ping+私聊分发、dashboard WS (文件头注释)

## 十二、部署现状与已知约束

- 实际运行方式: server `pnpm dev` (tsx watch) 或 `pnpm build && pnpm start` (先 `prisma migrate` 建表); client `pnpm dev` (Vite, 默认 5173) 或构建后任意静态托管; `VITE_API_URL` 构建期内联 (client/src/env.ts, 默认 http://localhost:8000), `VITE_WS_URL` 可选, 缺省把 http 换成 ws
- 单实例约束 (README "Deployment Constraints" 自报 "Single instance only"): ChatHub 连接表、CallManager 房间、MessagePipeline 串行链、AgentManager runtime 表、限流桶全部在进程内存, 无跨实例总线
- 无 TLS: 明文 HTTP/WS, 需前置网关终结 (README Deployment Constraints 自报)
- `/user/update-password` 免鉴权按手机号重置 (README Deployment Constraints 自报, 无邮件/短信验证, 限流 5 次/分/IP), 公网暴露前必须加验证步骤
- WebRTC 无 STUN/TURN, 跨 NAT 通话打不通
- 声明未消费的依赖: server 的 `minio` (package.json ^8.0.7) 与 `archiver` (^7.0.1) 在 server/src 与 tests 中零引用; env 的 `AGENT_WS_MAX_MESSAGE_BYTES` 未被路由读取 (路由用本地常量, ws-agent-route.ts:20)
- `.npmrc` 当前指向 registry.npmjs.org, 注释行保留 npmmirror
- 其余杂项: 根 package.json 只有 git 便捷脚本; `client/package.json` 的 `dual` 脚本用 concurrently 把 `pnpm dev` 跑两遍 (双开联调用途); 仓库还提交了 `server/.playwright-cli/` 快照与 `server/static/` 下的示例上传文件

## 十三、小结

yukino-chat 的价值密度集中在三处工程设计:

1. 消息管线的线协议语义保真 —— 从 JSON 零值解析、空列表 null 序列化到 channel 容量溢出帧, 全部作为稳定的线协议契约保留, smoke 脚本因此有可靠的回归面
2. Agent 与聊天的合流 —— 落库回复走人类消息同一条 insert+broadcast 路径 (sink), 流式过程走独立 /agent/ws overlay 并以 anchorId/messageId 与转录缝合, 断线重连靠 broker snapshot 重放挂起交互; transcript 是事实、overlay 是过程的分工让刷新/顶号/多端都不丢结果
3. 断点续传的极简状态机 —— 服务器状态就是 chunk 目录里的文件集合, verify 返回缺失下标, merge 幂等且失败清理半成品; 客户端把哈希挪进 worker 用二次摘要规避内存峰值, Semaphore+重试控制并发

当前短板同样清晰: 无 TURN、update-password 无验证步骤、单实例内存态. 这些在 README 的 Deployment Constraints 一节大多有自我披露, 属于内网自托管定位下的自觉取舍.
