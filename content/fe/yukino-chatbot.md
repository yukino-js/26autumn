---
title: "Yukino-Chatbot 技术笔记"
---

> 本机器路径 `$HOME/github/yukino-chatbot`

## 一、项目概述与架构设计

### 请介绍 yukino-chatbot 项目的整体架构

yukino-chatbot 是一个基于 pnpm workspace 的全栈 LLM 聊天应用, 采用前后端分离架构:

| 层级     | 技术选型                                                               |
| -------- | ---------------------------------------------------------------------- |
| 前端     | React 19 + TypeScript 5.9 + Vite 8                                     |
| 状态管理 | Jotai (客户端状态) + TanStack React Query v5 (服务端状态)              |
| UI       | Base UI (@base-ui/react) + Tailwind CSS 4 + shadcn/ui 模式             |
| 后端     | Koa 3 + @koa/router                                                    |
| LLM      | LangChain (ChatOpenAI) 对接 OpenAI 兼容端点, 默认模型 qwen3            |
| 数据库   | MySQL (Knex 查询构建器)                                                |
| 缓存     | Redis (ioredis) + LRU 降级                                             |
| RAG      | LangChain MemoryVectorStore + OpenAIEmbeddings (默认 nomic-embed-text) |

项目结构为 monorepo, 包含 `client/` 和 `server/` 两个 package. 后端采用 Router -> Controller -> Service -> DAO -> DB 的经典分层架构. AI 能力通过工厂模式封装, 支持普通对话和 RAG 增强两种模型类型.

模型端点均通过环境变量配置: LLM 模型名取 `OPENAI_MODE_NAME` (默认 qwen3), `ChatOpenAI` 只传 model 名, baseURL/apiKey 遵循 OpenAI SDK 的环境变量约定 (`OPENAI_BASE_URL`/`OPENAI_API_KEY`); Embedding 取 `EMBEDDING_MODEL` (默认 nomic-embed-text) 与 `EMBEDDING_BASE_URL`/`EMBEDDING_API_KEY`, 指向 OpenAI 兼容服务 (server/src/config/index.ts:89-97, server/.env.example). qwen3、nomic-embed-text 这类模型名通常对应 Ollama 等 OpenAI 兼容推理服务.

### 为什么选择 pnpm monorepo 而非独立仓库?

选择 pnpm monorepo 的核心原因:

1. 类型同仓: 前后端代码同仓管理. 注意项目并没有共享类型 package (`pnpm-workspace.yaml` 只声明了 `client` 和 `server` 两个包), `Message`、`Session`、`ModelType` 等类型由前后端各自独立定义 (仅 ModelType 的取值 "openai"/"openai-rag" 两边一致, Message/Session 的字段形状并不相同), 靠约定保持接口兼容; monorepo 的价值在于让接口变更可以在同一仓库内原子化完成
2. 统一依赖管理: pnpm 的硬链接机制避免重复安装, 磁盘效率高
3. 原子化变更: 一次 PR 可以同时修改前后端代码, 保证接口变更的原子性
4. 开发体验: 根目录 `package.json` 通过 `concurrently` 一条命令同时启动前后端开发服务器

`pnpm-workspace.yaml` 声明了 `client` 和 `server` 两个 workspace package, 根目录脚本统一编排开发、构建流程.

### 前后端如何通信? 开发环境和生产环境有何区别?

开发环境: Vite dev server 配置了代理, 将 `/api/*` 请求转发到 `http://localhost:8088/api/v1/*`, 通过 path rewrite 去掉 `/api` 前缀并添加 `/api/v1` 版本前缀. 前端代码中统一使用 `/api/` 开头的相对路径.

生产环境: 前端构建为静态资源, 由 Nginx 或类似反向代理统一分发: 静态资源直接返回, `/api/` 请求转发到 Koa 服务.

通信协议:

- 普通请求: JSON over HTTP (POST/GET)
- 流式响应: Server-Sent Events (SSE), Content-Type 为 `text/event-stream`
- 认证: Bearer Token (Authorization header) 或 query param `?token=`

---

## 二、前端架构与状态管理

### 前端状态管理方案是如何设计的?

前端采用三层状态管理策略:

1. Jotai atoms (客户端状态): 管理 auth token、主题偏好、语言选择、模型类型等纯客户端状态. 其中 token 用普通 `atom` 创建, 初值取 `localStorage.getItem("token")`, 由写入 action atom 手动调用 `localStorage.setItem/removeItem` 持久化 (stores/auth.ts); 主题、语言、模型类型则通过 `atomWithStorage` 持久化到 localStorage (stores/settings.ts), 刷新后自动恢复. 注意模型类型的 `modelAtom` 目前只有定义、未被任何组件消费, AiChat 页面的模型选择实际由本地 useState 管理, 刷新后不保留 (pages/ai-chat/index.tsx:30-32).

2. TanStack React Query (服务端状态): 管理 sessions 列表、聊天历史等需要与后端同步的数据. 利用其缓存失效、后台重新获取、乐观更新等能力.

3. 组件本地 state (高频瞬态状态): 主聊天页面中的 messages 数组、streaming 状态等使用 `useState`, 避免高频更新穿透到全局 store.

这种分层设计确保了: 低频全局状态用 atom 共享, 服务端数据用 Query 自动同步, 高频渲染状态局部隔离.

### 为什么同时使用 Jotai 和 TanStack React Query?

两者解决的是不同维度的问题:

| 维度     | Jotai                           | TanStack React Query           |
| -------- | ------------------------------- | ------------------------------ |
| 数据类型 | 客户端状态 (token, theme, lang) | 服务端状态 (sessions, history) |
| 同步需求 | 无需同步, 本地即真相            | 需要缓存失效、重新获取         |
| 持久化   | localStorage                    | 内存缓存 + 后端                |
| 更新频率 | 低 (用户主动切换)               | 中 (路由切换时获取)            |

如果只用 Jotai, 需要手动实现缓存失效、loading/error 状态管理、请求去重等逻辑. 如果只用 React Query, 纯客户端状态 (如主题) 没有合适的缓存键和失效策略. 两者互补, 各取所长.

### HTTP 请求层是如何封装的? 401 如何统一处理?

普通请求统一走 axios 实例 `fetchClient` (api/fetch-client.ts:3-6):

```typescript
const fetchClient = axios.create({
  baseURL: "/api",
  timeout: 0,
});

fetchClient.interceptors.request.use((config) => {
  const token = localStorage.getItem("token");
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

fetchClient.interceptors.response.use(
  (response) => response,
  (err) => {
    if (err.response?.status === 401) {
      localStorage.removeItem("token");
      location.href = "/login";
    }
    return Promise.reject(err);
  },
);
```

要点:

1. baseURL 固定 `/api`, 开发环境由 Vite 代理转发, 生产环境由反向代理转发, 业务代码不感知部署形态
2. timeout 为 0 即不限时, 因为 AI 生成回答的耗时不可预估
3. 请求拦截器从 localStorage 读取 token 注入 Bearer header, 与 Jotai token atom 共享同一个 storage key, 拦截器不经过 React 体系
4. 响应拦截器统一处理 401: 清除本地 token 并跳转 /login, 各业务 mutation 无需重复编写登出逻辑 (fetch-client.ts:19-28)
5. 旧的 `api/index.ts` 已标注 `@deprecated`, 仅为向后兼容保留, 新代码统一使用 hooks/queries 下的封装

React Query 全局默认值在 api/query-client.ts:3-11 配置: retry: 1、refetchOnWindowFocus: false、staleTime 5 分钟. 流式请求则完全绕开 axios, 用原生 fetch 消费 SSE (hooks/queries/use-stream-message.ts:30-38), 因为需要手动控制 body 的 ReadableStream.

### 路由和权限控制是如何实现的?

使用 react-router-dom v7 的 `createBrowserRouter` + `RouterProvider`, 定义了 5 条路由: `/` (loader 中 `redirect("/login")`)、`/login`、`/register`、`/menu`、`/ai-chat`. 页面组件均通过 `lazy` + `withLazy` 懒加载, `/menu` 和 `/ai-chat` 额外包裹 `withAuth`.

权限控制通过 `withAuth` HOC 实现:

```tsx
// hoc/with-auth.tsx
function withAuth<P extends object>(WrappedComponent: ComponentType<P>) {
  return function (props: P) {
    const isAuthenticated = useAtomValue(isAuthenticatedAtom);
    const navigate = useNavigate();
    useEffect(() => {
      if (!isAuthenticated) {
        navigate("/login", { replace: true });
      }
    }, [isAuthenticated, navigate]);

    if (!isAuthenticated) {
      return null;
    }
    return <WrappedComponent {...props} />;
  };
}
```

`isAuthenticatedAtom` 是一个派生 atom, 基于 token atom 是否存在来计算. token 用普通 `atom(localStorage.getItem("token"))` 创建, 登录/登出时通过 action atom (`setTokenAtom`) 手动调用 `localStorage.setItem("token", ...)` / `localStorage.removeItem("token")` 持久化, 刷新页面后由 atom 初值恢复登录态.

补充: `components/protected-route/index.tsx` 中还有一个逻辑相同的 `ProtectedRoute` 组件 (同样基于 `isAuthenticatedAtom` + `useEffect` 跳转), 但路由表实际挂载的是 `withAuth` HOC, 该组件目前未被引用.

### 登录/注册表单的校验是如何实现的?

前端使用 TanStack Form + zod, schema 挂在 form 的 validators.onChange 上, 每次输入即时校验:

```typescript
// pages/login/index.tsx:22-25, 41-48
const loginSchema = z.object({
  username: z.string().min(1, "auth.username_required"),
  password: z.string().min(6, "auth.password_required"),
});

const form = useForm({
  defaultValues: { username: "", password: "" },
  validators: { onChange: loginSchema },
  onSubmit: ({ value }) => {
    /* loginMutation.mutate(value) */
  },
});
```

注册表单额外用 `.refine()` 做跨字段校验, 两次密码不一致时错误挂到 confirmPassword 字段 (pages/register/index.tsx:22-33). zod 的 message 直接就是 i18n key (如 "auth.password_required"), 渲染时经 `t(error)` 翻译 (login/index.tsx:118), 校验规则与展示文案解耦.

后端在 Controller 层再做一次 zod 校验 (controller/user.ts:7-15): login 要求 username + password, register 只要求 email + password. 注意 username 并不由注册表单提交, 而是服务端用 email 派生 (`const username = email`, service/user.ts:39), 且注册成功直接签发 JWT 返回, 注册即登录.

---

## 三、SSE 流式渲染、断线恢复与性能优化

### 流式响应的完整数据链路是怎样的?

完整链路如下:

```
用户输入 -> useStreamMessage hook (Fetch API POST)
         -> Koa Controller (res.writeHead SSE headers)
         -> SessionService -> AiAgent.responseStream()
         -> ChatOpenAI.stream() (async iterator, OpenAI 兼容端点)
         -> 逐 token 回调 -> res.write(`data: ${JSON.stringify(token)}\n\n`)
         -> 客户端 ReadableStream reader.read() 循环
         -> 逐行解析 SSE data 协议
         -> fullContent 累加写入 useRef (零 React 渲染)
         -> StreamingMarkdown 通过 rAF 轮询拉取最新文本
         -> Streamdown 增量解析 -> DOM 更新
         -> 收到 data: [DONE] -> onDone 回调 -> 流结束
```

关键设计: 服务端每产生一个 token 就立即 `res.write()`, 客户端通过 `ReadableStream` 逐块读取, 解析后写入 ref 而非 state, 由独立的 rAF 循环节流渲染.

### 流式会话的页面级编排是怎样的? session_id 何时拿到? 流结束后消息如何落定?

AiChat 页面用 `currentSessionId = "temp"` + `tempSession = true` 表示尚未落库的临时会话 (pages/ai-chat/index.tsx:24-27). 发送第一条消息的时序:

1. 请求打到 create-session-and-send-message-stream 端点, 服务端 `randomUUID()` 生成 session_id 并先写入 sessions 表 (service/session.ts:47-59)
2. SSE 首帧是 `data: {"session_id": "..."}` 元数据, 客户端 `JSON.parse` 命中 object 且带 session_id 时触发 `onSessionCreated` 回调并 continue, 不写入正文 (use-stream-message.ts:76-81)
3. 回调里把真实 session_id 写入 sessions 映射, `setCurrentSessionId` 切换, `setTempSession(false)` (ai-chat/index.tsx:136-149)

流文本的落定只做一次: chunk 全程写入 `streamTextRef` (纯 ref), onDone/onError 时 `commitStreamedMessage()` 用一次 setState 把完整内容写回尾部 AI 消息并置 status 为 "done"/"error" (ai-chat/index.tsx:114-132, 154-163), onError 也保留已到达的部分回答. 另有兜底: `mutateAsync` 返回后如果 `streamTextRef.current` 仍非空 (服务端没发 [DONE] 哨兵就关流), 再补一次 commit (ai-chat/index.tsx:209-213).

页面顶部提供流式开关 checkbox, 勾选走 handleStreaming (流式端点), 不勾选走 handleNormal (非流式端点, 等待完整 answer 一次性返回) (ai-chat/index.tsx:352-356). 历史消息接口 get-chat-history-list 直接从内存中的 AiAgent 读取 (service/session.ts:115-130), 不查数据库, 能查到历史依赖的正是启动时 loadDataFromDb 的重建 (见第五章「服务重启后如何恢复对话上下文?」).

### 为什么使用 Fetch API 而非 EventSource 消费 SSE?

三个核心原因:

1. HTTP 方法限制: `EventSource` 只支持 GET 请求, 而本项目的流式接口需要 POST 发送 `{question, model_type, session_id}` 请求体.

2. 自定义 Header: `EventSource` 不支持设置 `Authorization` header. 虽然可以通过 query param 传递 token, 但 Fetch API 可以直接在 header 中携带 Bearer Token, 更安全规范.

3. 错误处理粒度: Fetch API 可以检查 `response.ok`、读取 HTTP 状态码, 而 EventSource 的错误事件不暴露 HTTP 状态码, 难以区分 401 (鉴权失败) 和 500 (服务错误).

实现上使用 `body.getReader()` 获取 `ReadableStreamDefaultReader`, 配合 `TextDecoder` 逐块解码, 手动按行分割解析 SSE 协议.

### 连接中断时会发生什么? 当前的断线恢复现状是怎样的?

先说结论: 项目没有实现流级自动重连, 但通过"生成与连接解耦 + 结果级对账"两个机制, 保证断线后回答不会丢失.

客户端行为链:

1. fetch 本身失败 (`!ok` 或无 body) 或流中途断掉 (reader.read() 抛网络错误) -> mutationFn 抛出 -> mutation 的 onError 触发 -> 页面侧 `commitStreamedMessage("error")` 把尾部 AI 消息以 status "error" 落定并 toast 提示 (ai-chat/index.tsx:158-163)
2. 已到达的部分回答不丢: commit 时 `streamTextRef` 里有什么就写回什么 (ai-chat/index.tsx:117-132)
3. 另一条兜底: 流正常结束但没见过 [DONE] 哨兵 (服务端没写完就被杀) -> `mutateAsync` resolve 后检查 `streamTextRef` 非空则补一次 commit (ai-chat/index.tsx:209-213)

服务端行为链:

1. 没有监听连接的 close/aborted 事件 (server/src 下无任何 close 监听), 客户端掉线不会中断生成
2. `ChatOpenAI.stream()` 的 async iterator 继续跑完, 全量回答经 addMessage 进入 AiAgent 内存 + write-behind 持久化到 MySQL (ai/agent.ts:44-54)
3. 后续的 `res.write` 对着已关闭的连接写入, 字节被丢弃, 但生成结果在服务端完整保留 (service/session.ts:76-88)

因此当前的恢复模型是"流是一次性的, 结果是可找回的". 用户点击 ChatHeader 的"同步历史"按钮 (chat-header/index.tsx:69-77) -> syncHistory -> useChatHistory -> POST get-chat-history-list -> 服务端从 AiAgent 内存读出完整对话 (service/session.ts:115-129), 断线那轮的回答就完整回来了. 这是一次人工触发的结果级重连.

现状的缺口 (也是演进为自动重连时的入手点):

1. 客户端没有任何 AbortController/signal: 无法主动中止流, 没有"停止生成"按钮 (ChatInput 在 loading 期间只是禁用输入, chat-input/index.tsx:44); 组件卸载或路由切走时在途 fetch 也不会被取消
2. 没有自动重试, 断线后只能人工点同步
3. 重发不幂等: 再 POST 一次同样的问题会再次执行 responseStream, 用户消息被重复 addMessage 进对话上下文 (ai/agent.ts:44), LLM 也会重新生成一遍 — 所以"直接重试原请求"是错误的重连方式

### 为什么标准 SSE 恢复机制 (id / Last-Event-ID / retry) 不能直接套用?

标准机制是 EventSource 与 SSE 协议配套的自动重连三件套:

1. 服务端给每个事件附 `id:` 字段 (`id: 42\ndata: ...\n\n`), 浏览器记住收到的最后一个 id
2. 连接断开时, EventSource 按服务端 `retry:` 字段指定的间隔自动重连 (HTML 标准把默认重连间隔交由 UA 定义、仅建议为数秒; Chrome/Firefox/Safari 的事实默认值均为 3 秒), 并在请求头自动带上 `Last-Event-ID: 42`
3. 服务端据此重放该 id 之后的事件, 完成断点续传

三件套在本项目全部失效:

| 机制                 | 失效原因                                                                                                                          |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| EventSource 自动重连 | 传输层是 fetch POST, 不是 EventSource (GET-only、无法携带 Authorization header, 见上一问)                                         |
| id: 断点             | 主数据流帧只有 data: 字段 (service/session.ts:80; 错误路径另有 event: error 帧, controller/session.ts:79), 服务端没有事件序号概念 |
| retry: 间隔          | 只对 EventSource 生效, fetch 消费者不会读取也不会遵守                                                                             |

更深一层的错位在于语义: LLM 生成场景的"断点"和普通事件推送不同. 事件推送系统 (日志流、通知流) 重连要解决的是"丢了哪几条事件, 从哪条补放"; 而 LLM 回答是一段持续增长的文本, 重连真正要做的是重新附着到仍在进行的生成过程, 拿到"到目前为止的全文 + 后续增量". 字节级重放只是实现手段之一, 而非必须形态 — 全文快照重放同样正确, 甚至更简单.

### 如果要给这个项目加真正的断点重连, 应该怎么设计?

设计目标: 弱网、切后台、服务发布导致连接断开后, 回答能自动续上, 不重头生成、不重复调用 LLM.

服务端改造三步:

1. 输出流变成可重放日志. 为每次回答分配 stream_id (可复用消息粒度的 id), 每个 chunk 单调递增 seq; chunk 除写入 res 外同时追加进重放缓冲 — 单机用 Map<streamId, events[]>, 多实例部署用 Redis Stream (XADD + MAXLEN 修剪). 本项目生成侧已天然解耦 (断连后生成不中断), 缺的只是把输出留痕.
2. 增加恢复端点, 如 POST /chat/resume-stream, 参数 {stream_id, last_seq}: 先重放缓冲中 seq > last_seq 的所有事件, 再切换到实时尾随 (新 chunk 到达即写); 若生成已结束, 重放完毕后补发 [DONE]. 同时把帧格式升级为 `id: {seq}\ndata: ...\n\n`, 与标准 SSE 语义对齐.
3. 断连清理. 监听 close 事件: 连接消失后停止 res.write 与逐 token 日志 (省 CPU), 但不停止生成、不清空缓冲; 缓冲在生成完成后保留一段时间 (如 10 分钟) 再回收.

客户端改造五项:

1. 游标 + 去重: 用 ref 维护 {streamId, lastSeq}, 只接受 seq > lastSeq 的事件, 序号去重让重放天然幂等
2. 退避重连: 未收到 [DONE] 就中断时, 指数退避 + 完全抖动重试 (如 base 500ms、每次 x2、上限 30s、最多 5 次), 重连请求携带 last_seq
3. 死连接检测: SSE 长连接最大的坑是半开连接 — TCP 未断但数据不再流动 (中间代理静默回收最常见). 客户端要设读取超时 (如 45s 没收到任何字节就 abort 并重连); 服务端可周期性发注释帧 `: ping\n\n` 作为心跳 — 现有解析器天然跳过非 data: 行 (use-stream-message.ts:58-59), 协议解析零改动
4. AbortController 补齐: fetch 传 signal; 新增"停止生成"按钮调用 abort(); 组件卸载/路由离开时 abort, 配合服务端 close 监听还可以实现"停止即取消生成"节省 token
5. 事件触发即时重试: 监听 window 的 online 事件, 网络恢复立即重连, 不等退避计时器

客户端重连循环的骨架 (放在 mutationFn 内部, 对上层的 onError/onDone 契约不变):

```typescript
async function consumeWithResume(
  params: StreamParams,
  callbacks: StreamCallbacks,
) {
  let lastSeq = 0;
  let streamId: string | undefined;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const url = streamId
        ? "/api/ai/chat/resume-stream" // 重连: 重放 + 尾随
        : chooseEndpoint(params); // 首连: 业务端点
      const body = streamId
        ? { stream_id: streamId, last_seq: lastSeq }
        : buildBody(params);

      await readSse(url, body, {
        onEvent: (seq, content) => {
          if (seq <= lastSeq) return; // 去重: 重放过的事件直接丢弃
          lastSeq = seq;
          fullContent += content;
          callbacks.onChunk(fullContent);
        },
        onStreamId: (id) => (streamId = id),
        onDone: () => callbacks.onDone(),
      });
      return; // 收到 [DONE], 正常结束
    } catch (err) {
      if (isAbortError(err)) throw err; // 用户主动停止, 不重试
      await sleep(backoffWithJitter(attempt)); // 指数退避 + 完全抖动
    }
  }
  callbacks.onError(); // 重试预算耗尽
}
```

React 侧接线要点:

1. 重连循环放在 mutationFn 内部, 上层看到的仍是一次 mutation 的语义, 重试预算耗尽才触发 callbacks.onError()
2. 本项目的 commitStreamedMessage 是覆盖式写尾部消息 (ai-chat/index.tsx:117-132), onChunk 传的又是累计全文而非增量 (use-stream-message.ts:86-87) — "全文覆盖"语义让重放绝对安全: 无论重放多少次、顺序如何, 最后一次覆盖即最新状态
3. 终态判据只有收到 [DONE], 重连过程中不要提前落定消息

低成本演进路径 (不改服务端): 把现在人工点的"同步历史"自动化 — onError 后对当前 session 轮询 get-chat-history-list, 直到完整回答出现. 这利用了"服务端生成不中断"这个既有事实, 代价是拿不回生成中的打字机体验, 只能等生成完毕后一次性取回结果.

行业参照: Vercel AI SDK 的 resumable-stream 用 Redis 保存流快照支持重新附着; ChatGPT 网页端据社区观察在断线重连时会重放当前消息已生成的全文再继续流式. 本项目"累计全文回调 + 覆盖式 commit"的数据模型与这类方案同构, 演进阻力主要在服务端的重放缓冲与恢复端点.

### 逐 chunk setState 为什么是流式渲染的头号性能陷阱?

先算成本账. LLM 流式输出的速率常见为每秒几十到上百个 chunk (LangChain stream 回调粒度是 token 级, server/src/ai/model.ts responseStream; 网络层 TCP 段聚合还可能一次送达多帧). 如果每个 chunk 直接 setState:

1. 每次 setState 触发一次子树重渲染: React reconciliation (元素树规模随文本长度增长)、markdown 全量重解析 (O(文本长度))、浏览器布局与绘制
2. 一条 2000 token 的回答约产生上千次渲染, 且单次渲染成本随长度线性上升, 总成本 O(N x L), 是平方级
3. 主线程被 reconciliation + 解析 + 绘制占满后, 掉帧、输入延迟、滚动抖动随之而来

常见误解是 React 18/19 的自动批处理能救场. 实际边界是: 自动批处理只合并同一任务 (含其 microtask flush) 内的多次 setState; 而 reader.read() 随网络包到达在各自独立的宏任务里被唤醒, 跨包的 chunk 永远不会被合并. 即使一个 TCP 段带了多帧、被合并成一次渲染, 渲染频率仍与包到达速率成正比, 量级问题依旧. 批处理是缓解手段, 不是解法.

本项目的回答是让热路径完全不进 React, 分三层:

| 层     | 职责                                                      | 位置                               |
| ------ | --------------------------------------------------------- | ---------------------------------- |
| 写入层 | onChunk 只写 streamTextRef, mutable ref, 零渲染成本       | ai-chat/index.tsx:150-153          |
| 调度层 | StreamingMarkdown 的 rAF 循环按帧拉取, 长度变化才 setText | streaming-markdown/index.tsx:25-39 |
| 落单层 | 整个流只有一次真正的 state 提交, done/error 时写回全文    | ai-chat/index.tsx:117-132          |

渲染频率由此被钳制在"帧率" (60/秒上限) 而非"chunk 频率" (数百/秒), 且没有新内容的帧零成本.

顺带澄清一个字符串拼接的疑虑: `fullContent += content` (use-stream-message.ts:86) 看起来是每次全量复制的 O(n²), 实际 V8 对 += 采用 ConsString (rope 结构) 惰性拼接, 追加接近 O(1), 真正的全量摊平推迟到字符串被消费时 (渲染、内容比较). 因此"每帧传全文"的回调协议本身并不昂贵.

### StreamingMarkdown 组件如何实现零渲染热路径?

核心思想是将数据写入与 React 渲染解耦:

```typescript
function StreamingMarkdown({ sourceRef }: Props) {
  const [text, setText] = useState("");
  const lastLengthRef = useRef(0);

  useEffect(() => {
    let rafId = 0;
    const flush = () => {
      const latest = sourceRef.current ?? "";
      if (latest.length !== lastLengthRef.current) {
        lastLengthRef.current = latest.length;
        setText(latest);
      }
      rafId = requestAnimationFrame(flush);
    };
    rafId = requestAnimationFrame(flush);
    return () => cancelAnimationFrame(rafId);
  }, [sourceRef]);

  return <Markdown mode="streaming" isAnimating>{text}</Markdown>;
}
```

设计要点:

1. SSE 回调只写 ref: `onChunk` 回调将 fullContent 写入 `sourceRef.current`, 这是一个 mutable ref, 不触发任何 React 重渲染. 即使每秒收到数百个 chunk, React 调度器完全无感知.

2. rAF 节流拉取: 独立的 `requestAnimationFrame` 循环以最多 60fps 的频率检查 ref 是否有新内容, 有变化才调用 `setText` 触发渲染. 将数百次/秒的 chunk 折叠为最多 60 次/秒的渲染.

3. 长度比较去重: 通过 `lastLengthRef` 记录上次渲染的文本长度, 长度未变则跳过 setState, 避免无意义的 reconciliation.

### 消息列表的虚拟化和自动滚动是如何实现的?

使用 `@tanstack/react-virtual` 实现窗口化渲染:

```typescript
const virtualizer = useVirtualizer({
  count: messages.length,
  getScrollElement: () => parentRef.current,
  estimateSize: () => 120,
  overscan: 5,
});
```

自动滚动策略 (尊重用户控制权):

1. 近底检测: 通过 `onScroll` 事件计算 `scrollHeight - scrollTop - clientHeight < 80px`, 记录在 `isNearBottomRef` 中.

2. 新消息滚动: 当 `messages.length` 变化时, 如果是用户自己发的消息 (role === "user") 则强制滚到底部; 如果是 AI 消息, 仅在用户已处于底部附近时才滚动.

3. 流式增长跟踪: 使用 `ResizeObserver` 监听消息容器高度变化 (流式输出导致气泡增高), 仅在 `isNearBottomRef.current === true` 时执行 `scrollToIndex(last, {align: "end"})`.

4. 用户阅读保护: 如果用户正在翻阅历史消息 (不在底部), 自动滚动完全停止, 不会打断用户.

性能保障: `MessageItem` 使用 `React.memo` 包裹, 流式输出期间只有最后一条消息在渲染, 已定型的消息不会因父组件更新而重渲染.

### Streamdown 的增量 Markdown 解析原理是什么?

Streamdown (Vercel 出品的流式 Markdown 渲染器, 本项目使用 2.6.0) 的核心优化:

1. 块级分割: 将 Markdown 文本按语义块分割 (段落、代码围栏、标题、列表等), 每个块独立解析为 React 元素. 2.6.0 的实现是用 marked 的 Lexer 做词法切分 (导出函数 parseMarkdownIntoBlocks), 天然感知围栏边界.

2. 已定型块缓存: 一旦某个块被完整接收 (例如代码围栏的 ` ``` ` 闭合), 该块的解析结果被 memoize, 后续渲染直接复用, 不再重新解析. Block 组件用 memo 包裹并带自定义比较函数 (只比较 content/index/isIncomplete 等 props), 已定型块在父组件更新时直接跳过 diff.

3. 仅解析尾部块: 每次文本更新时, 只有最后一个未完成的块需要重新解析. 例如一段 2000 字的回复, 当第 1900 字到达时, 前 1800 字对应的块全部命中缓存, 只解析最后 200 字.

4. 未闭合标记修复: 流式文本中大量出现写到一半的代码围栏、粗体标记、链接, Streamdown 通过 remend 包 ("self-healing markdown") 把未闭合的标记智能补全, 避免半个围栏把后续所有内容吞进代码块. 本项目的 Markdown 组件经 mode="streaming" 启用该行为 (components/markdown/index.tsx).

5. 代码高亮: 通过 `@streamdown/code` (1.1.1) 集成 Shiki, 代码块在流式过程中也能实时高亮, 且围栏闭合后高亮结果随块缓存一起固化.

这使得渲染成本与消息总长度解耦, 只与当前增量成正比, 长消息的流式渲染不会越来越卡.

### 节流与更新方案对比: 为什么本项目选 rAF 拉取?

把"高频数据流转换成可控渲染频率"的设计空间完整摆开:

| 方案                               | 原理                                  | 渲染频率                     | 后台标签页行为                     | 适用场景                               |
| ---------------------------------- | ------------------------------------- | ---------------------------- | ---------------------------------- | -------------------------------------- |
| 逐 chunk setState                  | 数据到即渲染                          | 等于 chunk 频率 (数百/秒)    | 持续渲染                           | 反面教材                               |
| setInterval 节流                   | 定时器周期采样最新值                  | 由间隔决定 (如 100ms)        | 被浏览器钳制到 1s+ 但仍在跑        | 需要固定节奏、不关心帧对齐             |
| rAF 拉取 (本项目)                  | 每动画帧检查 ref, 有变化才 setState   | 60/秒上限, 空闲帧零成本      | 自动暂停, 恢复可见后首帧拉全文补齐 | 单一组件消费流式文本                   |
| useSyncExternalStore               | 外部 store 推送, 订阅者收到通知再渲染 | 等于通知频率, 仍需自行节流   | 持续通知                           | 多组件共享同一条流                     |
| startTransition / useDeferredValue | 标记为非紧急更新, React 可丢弃合并    | React 自行调度, 可能长期滞后 | 持续                               | 不想引入 ref 层、可接受显示滞后        |
| 直接 DOM 写入                      | 绕过 React 命令式设置 textContent     | 无 React 成本                | 取决于实现                         | 纯文本场景, 与声明式 markdown 渲染冲突 |

rAF 胜出的三个决定性理由:

1. 帧对齐: 渲染只发生在浏览器即将绘制下一帧的时刻, 永远不会做超出显示能力的无效渲染; setInterval 的回调可能落在一帧中间, 同一帧内多次 setState 会引发多轮布局绘制
2. 后台零成本: 页面不可见时 rAF 自动暂停 — SSE 继续写 ref, 回到前台第一帧就拉到最新全文一次性补齐, 既没有后台空转渲染, 也没有恢复时的补渲染风暴; setInterval 与推送式方案都不具备这个特性
3. 实现极简: 一个 effect + 一个循环 + 长度比较 (streaming-markdown/index.tsx:25-39), 不需要 store 的 subscribe/getSnapshot 管道

几个取舍细节:

1. useSyncExternalStore 若采用, getSnapshot 必须返回缓存的稳定引用, 否则每次返回新值会引发无限重渲染; 本项目的流只被尾部一条消息消费 (message.status === "streaming" 分支, message-item/index.tsx:71-73), 没有共享需求, rAF 更合适
2. transition/deferred 的卖点是"保输入响应", 主线程吃紧时 React 会持续丢弃过期的 transition 渲染 — 代价是显示可能明显滞后, 且最终仍需一次紧急提交落定全文. 本项目用"热路径零渲染"直接达成同一目标, 不需要 transition
3. MessageList 顶部的 "use no memo" 指令 (message-list/index.tsx:18) 是 React Compiler 的组件级退出标记; 本项目当前未启用 React Compiler (vite.config.ts 是裸 @vitejs/plugin-react), 该指令目前是预留的空操作

### 流式渲染性能的系统性检查清单

按数据流动方向逐层检查, 以及本项目每一项的落地状态:

| 层     | 手段                                  | 本项目状态                                                                                                          |
| ------ | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 数据层 | 高频数据走 ref/外部 store, 不进 state | 已实现 (streamTextRef, ai-chat/index.tsx:114)                                                                       |
| 数据层 | 覆盖式语义的回调协议, 重放/去重安全   | 已实现 (onChunk 传累计全文, use-stream-message.ts:86-87)                                                            |
| 调度层 | rAF/节流钳制渲染频率                  | 已实现 (rAF + 长度去重)                                                                                             |
| 落单层 | 流结束单次 setState 落定              | 已实现 (commitStreamedMessage, ai-chat/index.tsx:117-132)                                                           |
| 组件层 | memo + 稳定引用隔离已定型消息         | 已实现 (MessageItem 为 memo, message-item/index.tsx:21; 流式期间只有尾部气泡渲染)                                   |
| 组件层 | 虚拟化控制 DOM 规模                   | 已实现 (useVirtualizer, estimateSize 120, overscan 5, message-list/index.tsx:27-31)                                 |
| 滚动层 | ResizeObserver 驱动贴底, 近底门控     | 已实现 (isNearBottomRef, 阈值 80px, message-list/index.tsx:15)                                                      |
| 渲染层 | 块级增量解析, 已定型块缓存            | 已实现 (Streamdown: marked Lexer 分块 + memo 化 Block, remend 修复未闭合标记)                                       |
| 渲染层 | 代码高亮与流式热路径解耦              | 已实现 (@streamdown/code 集成 Shiki, 高亮结果随已定型块缓存)                                                        |
| 服务端 | 关闭代理缓冲                          | 已实现 (X-Accel-Buffering: no, controller/session.ts:69, 138)                                                       |
| 服务端 | 避免逐 token 日志                     | 未实现 (service/session.ts:79 每 chunk 一条 logger.info, 高并发下日志 IO 成为热路径负担, 生产建议降为 debug 或移除) |
| 渲染层 | content-visibility: auto 跳过屏外绘制 | 未实现 (虚拟化已把 DOM 规模压下来, 收益有限, 可选项)                                                                |

验证手段同样重要, 没有测量的优化是盲调:

1. React DevTools Profiler: 录制一次完整的流式回答, 确认 commit 次数约等于帧数而非 chunk 数, 单次 commit 耗时保持稳定 — 若 commit 耗时随文本长度线性增长, 说明块级缓存没有生效
2. Chrome Performance 面板: 观察流式输出期间的长任务与掉帧; 长任务若恰好对齐 chunk 到达时刻, 说明有代码绕过 ref 层直接 setState
3. 交互响应: 流式输出期间在输入框打字应无卡顿; 若卡顿, 说明渲染负载已挤占主线程, 可进一步把 rAF 降频 (如隔帧 flush) 或提高长度变化阈值
4. 极限场景压测: 用超长回答 (1 万字符以上) 观察流式过程中尾部块的解析耗时是否恒定 — 这正是"渲染成本只与增量成正比"这个目标的直接验证

---

## 四、后端分层架构

### 后端的分层架构是怎样的? 各层职责是什么?

```
Router (@koa/router)
  -> Controller (参数校验 + 响应格式化)
    -> Service (业务编排)
      -> DAO (数据访问, Knex 查询)
        -> MySQL / Redis
```

| 层级       | 目录              | 职责                                     |
| ---------- | ----------------- | ---------------------------------------- |
| Router     | `src/router/`     | URL 到 Controller 的映射, 中间件挂载     |
| Controller | `src/controller/` | Zod 参数校验, 调用 Service, 格式化响应体 |
| Service    | `src/service/`    | 业务逻辑编排, 协调 DAO 和 AI Agent       |
| DAO        | `src/dao/`        | 纯数据访问, 封装 Knex 查询               |
| Model      | `src/model/`      | TypeScript 类型定义                      |
| Middleware | `src/middleware/` | JWT 鉴权等横切关注点                     |
| AI         | `src/ai/`         | Agent 系统 (独立于业务分层)              |
| RAG        | `src/rag/`        | 检索增强生成管线                         |

响应格式统一: 所有接口返回 `{code: number, message: string, ...data}` 结构, 通过 `success()` 和 `codeOf()` 工具函数生成.

### SSE 流式接口在服务端是如何实现的?

以 `createStreamSessionAndSendMessageStream` 为例:

```typescript
export async function createStreamSessionAndSendMessageStream(ctx: Context) {
  // 1. 参数校验
  const parsed = questionModelSchema.safeParse(ctx.request.body);

  // 2. 直接操作 Node.js 原生 res, 绕过 Koa
  const res = ctx.res;
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
    "X-Accel-Buffering": "no", // 禁止 Nginx 缓冲
  });
  res.flushHeaders();

  // 3. 创建会话: randomUUID() 生成 session_id 并写入 sessions 表
  const [sessionId, sessionCode] = await sessionService.createStreamSession(
    username,
    question,
  );

  // 4. 先发送 session_id 元数据
  res.write(`data: ${JSON.stringify({ session_id: sessionId })}\n\n`);

  // 5. 流式生成, 逐 token 写入
  await sessionService.sendMessageStream2session(
    username,
    question,
    model_type,
    sessionId,
    res,
  );

  // 6. 结束连接
  res.end();
}
```

Service 层内部调用 `AiAgent.responseStream()`, 该方法接收一个 `StreamCallback`, 每产生一个 token 就执行 ``res.write(`data: ${JSON.stringify(chunk)}\n\n`)``, 即 token 以 JSON 字符串编码写入 (客户端 `JSON.parse` 还原, 避免特殊字符破坏 SSE 帧). 全部完成后发送 `data: [DONE]\n\n` 作为结束哨兵.

### 为什么 SSE 要绕过 Koa 的响应处理直接操作 res?

1. Koa 的响应模型是一次性的: Koa 在中间件链执行完毕后, 将 `ctx.body` 一次性序列化发送. SSE 需要在请求生命周期内持续写入数据, 与 Koa 的 "设置 body -> 自动响应" 模型根本冲突.

2. 流式写入需求: SSE 要求 `res.write()` 后立即 flush 到客户端, 不能等所有数据就绪. 直接操作 `ctx.res` (Node.js 原生 `ServerResponse`) 可以逐块写入.

3. Header 控制: 需要设置 `X-Accel-Buffering: no` 等非标准 header 来禁止反向代理缓冲, 通过 `res.writeHead()` 更直接.

4. 连接生命周期: SSE 连接的关闭时机由业务逻辑决定 (收到 `[DONE]` 或出错), 而非 Koa 中间件链的结束.

---

## 五、AI Agent 系统设计

### AiAgent、AiAgentManager、AiModelFactory 三者的关系和职责?

```
AiModelFactory (工厂 + 注册表)
  |-- 注册模型创建器: registerModel(type, creator)
  |-- 创建模型实例: createAiModel(type, config)
  |-- 创建 Agent: createAiAgent(type, sessionId, config)
  |
AiAgentManager (单例, 生命周期管理)
  |-- Map<username, Map<sessionId, AiAgent>>
  |-- getOrCreateAiAgent(): 获取或创建 Agent
  |-- 模型热切换: 检测 modelType 变化时调用 agent.setModel()
  |
AiAgent (单个会话实例)
  |-- messages: Message[] (内存中的对话历史)
  |-- model: AiModel (当前使用的模型)
  |-- response(): 非流式对话
  |-- responseStream(): 流式对话
  |-- addMessage(): 追加消息 + 异步持久化到 MySQL
```

设计原则: Factory 负责 "如何创建", Manager 负责 "在哪里、给谁", Agent 负责 "如何对话". 三者职责单一, 通过组合协作.

### 对话上下文是如何管理的? 为什么选择内存存储?

每个 `AiAgent` 实例在内存中维护一个 `messages: Message[]` 数组, 记录完整对话历史. 每次调用 LLM 时, 通过 `toAiMessages()` 将历史转换为 LangChain 的消息格式传入.

选择内存存储的原因:

1. 延迟: LLM 调用需要完整上下文, 从内存读取是 O(1), 从 MySQL 读取需要网络 I/O
2. 简化实现: 无需序列化/反序列化, 无需处理数据库连接池竞争
3. 写后读一致性: 消息写入内存后立即可用于下一次 LLM 调用, 无需等待 MySQL 写入完成

持久化策略: 采用 write-behind 模式, `addMessage()` 先写入内存, 然后异步 (fire-and-forget) 调用 `saveMessage()` 写入 MySQL, 失败只记日志不阻塞主流程.

代价: 服务重启后内存丢失, 需要从 MySQL 重建 (见下文「服务重启后如何恢复对话上下文?」).

### 模型热切换是如何实现的?

在 `AiAgentManager.getOrCreateAiAgent()` 中:

```typescript
let agent = sessionId2agent.get(sessionId);
if (agent) {
  if (agent.getModelType() !== modelType) {
    agent.setModel(factory.createAiModel(modelType, config));
  }
  return agent;
}
```

当用户在前端切换模型类型 (如从 OpenAI 切换到 OpenAI with RAG) 时:

1. 请求携带新的 `model_type` 参数
2. Manager 发现已有 Agent 的 modelType 与请求不匹配
3. 通过 Factory 创建新模型实例
4. 调用 `agent.setModel()` 替换模型引用
5. 对话历史 (messages) 保持不变, 新模型继承完整上下文

这实现了无缝切换: 用户切换模型后, 对话不中断, 历史上下文完整保留.

### 服务重启后如何恢复对话上下文?

服务启动时 `main.ts` 中的 `loadDataFromDb()` 执行上下文重建:

1. 调用 `getAllMessages()` 从 MySQL `messages` 表按 `created_at` 升序加载全部历史消息 (不查询 `sessions` 表, session 按消息中携带的字段隐式恢复)
2. 逐条消息调用 `AiAgentManager.getOrCreateAiAgent(username, session_id, ...)` 获取或创建对应 session 的 `AiAgent` 实例
3. 通过 `agent.addMessage(..., false)` 将消息注入 `messages` 数组, 第 4 个参数传 `false` 表示仅恢复内存状态, 不再重复写回数据库

这确保了即使服务崩溃重启, 用户再次进入对话时, AI 仍然 "记得" 之前的对话内容. 代价是启动时间随历史消息量线性增长. 另外, 恢复时统一使用 `ModelType.OPENAI_MODEL` 创建 Agent, 若用户上次使用的是 RAG 模型, 需等下一次请求携带新 `model_type` 时通过热切换纠正.

---

## 六、RAG 检索增强生成

### RAG 管线的完整流程是怎样的?

```
用户上传文件 (.md/.txt/.json)
  -> multer 接收, CRC32 命名去重, 存入 uploads/{username}/

用户发送消息 (model_type = "openai-rag")
  -> DocumentLoader.loadFromDirectory() 读取用户目录下所有文件
  -> RecursiveCharacterTextSplitter 分块 (chunkSize=1000, overlap=200)
  -> OpenAIEmbeddings (默认模型 nomic-embed-text) 向量化
  -> MemoryVectorStore.fromDocuments() 构建内存向量索引
  -> similaritySearchWithScore(query, k=5) 检索 Top-5 相关文档
  -> buildRagPrompt() 将检索结果注入 Prompt
  -> ChatOpenAI 基于增强 Prompt 生成回答
```

容错设计: `ragEnhanceMessages()` 在用户未上传文件 (newDocumentRetriever 抛错) 或检索/embedding 失败时直接返回原始消息, 对话降级为普通问答; 检索结果为空同样不注入 Prompt (server/src/ai/model.ts:69-97). 增强方式是用 RAG Prompt 替换最后一条用户消息, 历史消息保持原样 (model.ts:91).

Prompt 模板:

```
Answer the user's question based on the following reference document.
If the document does not contain the relevant information, please state
that the information could not be found.

Reference Document:
[Document 1]: ...
[Document 2]: ...

User Question: {原始问题}

Please provide an accurate and complete answer:
```

### 文件上传链路是如何实现的? 前后端文件类型白名单一致吗?

完整链路:

```
ChatHeader 隐藏 input (accept=".md,.txt")
  -> useFileUpload 前端校验扩展名 (.md/.txt)
  -> useUploadFile: FormData + POST /api/file/upload
  -> @koa/multer (dest: uploads/tmp/, upload.single("file"))
  -> validateFile 服务端白名单校验 (.md/.txt/.json)
  -> CRC32 内容哈希命名 -> copyFileSync 到 uploads/{username}/ -> unlinkSync 清理临时文件
```

关键实现 (service/file.ts:16-24):

```typescript
const fileBuffer = readFileSync(file.path);
const crc32Value = crc32.buf(fileBuffer) >>> 0;
const filename = crc32Value.toString(16).padStart(8, "0");
const dstPath = join(userDir, filename + extName);
copyFileSync(file.path, dstPath);
unlinkSync(file.path);
```

设计要点:

1. 内容寻址去重: 文件名是文件内容的 CRC32 十六进制表示 (补齐 8 位), 同内容重复上传得到相同路径, copyFileSync 直接覆盖, 天然去重
2. 用户隔离: 目标目录为 uploads/\{username\}/, 与 RAG 检索时的 `join("uploads", username)` 一一对应 (rag/index.ts:87)
3. 白名单不一致是事实: 服务端 `ALLOWED_EXTENSIONS` 为 \{".md", ".txt", ".json"\} (utils/fs.ts:14-23), 但前端 input 的 accept 与 useFileUpload 的校验只放行 .md/.txt (chat-header/index.tsx:126, use-file-upload.ts:19-24), .json 文件实际传不进来. 服务端白名单是最终防线, 前端校验只是第一道体验过滤
4. multer 先落临时目录 uploads/tmp/, 校验通过后再拷贝到用户目录并删除临时文件, 失败请求不会污染用户目录

### 为什么选择 MemoryVectorStore 而非持久化向量数据库?

当前选择的合理性:

1. 项目规模: 单用户文档量有限 (几个 .md/.txt 文件), 向量数量在百到千级别, 内存完全可以承载
2. 部署简化: 无需额外部署 Chroma/Pinecone/Weaviate 等向量数据库, 降低运维复杂度
3. 数据隔离: 每个用户的向量索引独立构建, 天然隔离, 无需在向量库中做 namespace 管理

已知局限:

1. 每次请求都重建向量索引, 存在重复计算 (Embedding 调用有延迟)
2. 无法跨请求复用, 文档未变时也会重新向量化
3. 文档量大时 (数万页) 内存和延迟都不可接受

改进方向: 引入持久化向量库 + 增量索引, 仅在文档变更时重新向量化, 查询时直接检索.

### 文档分块策略的参数选择依据是什么?

使用 `RecursiveCharacterTextSplitter`, 参数为 `chunkSize=1000, chunkOverlap=200`:

- chunkSize=1000: 平衡检索精度和上下文完整性. 过小 (如 200) 会丢失段落语义; 过大 (如 5000) 会引入噪声, 降低相似度匹配的准确性. 1000 字符约覆盖一个完整段落或代码块.

- chunkOverlap=200: 20% 的重叠率确保跨块边界的信息不丢失. 如果一个关键概念恰好在第 1000 字符处被截断, 重叠部分保证下一个块仍包含完整语境.

- Recursive 分割: 按 `\n\n` -> `\n` -> ` ` -> `""` 的优先级递归分割 (@langchain/textsplitters 的默认 separators), 尽量在自然语义边界切分; 最后的空字符串分隔符是兜底, 保证超长无分隔符文本也能被硬切分.

---

## 七、认证与安全

### JWT 认证流程是怎样的? SSE 场景下如何处理鉴权?

标准流程:

1. 用户登录/注册 -> 服务端验证凭据 -> 签发 JWT (payload: `{id, username}`, 有效期 8760h)
2. 前端将 token 存入 localStorage (Jotai atom 的写入 action 手动调用 `localStorage.setItem`)
3. 后续请求在 `Authorization: Bearer <token>` header 中携带
4. 服务端 `auth` 中间件解析验证 token, 将 `username` 注入 `ctx.state`

SSE 场景的特殊处理:

```typescript
// middleware/auth.ts
let token = "";
const authHeader = ctx.get("Authorization");
if (authHeader?.startsWith("Bearer ")) {
  token = authHeader.slice(7);
} else {
  token =
    (Array.isArray(ctx.request.query.token)
      ? ctx.request.query.token[0]
      : ctx.request.query.token) ?? "";
}
```

SSE 使用 Fetch API (非 EventSource), 因此可以直接设置 Authorization header. 但中间件同时支持 `?token=` query param 作为后备方案, 兼容 EventSource 等无法自定义 header 的场景.

### 当前安全方案有哪些已知弱点和改进方向?

| 弱点              | 风险                       | 改进方向                             |
| ----------------- | -------------------------- | ------------------------------------ |
| MD5 哈希密码      | 彩虹表攻击, 无盐值         | 改用 bcrypt/argon2 + 随机盐          |
| JWT 有效期 1 年   | token 泄露后长期有效       | 缩短有效期 + refresh token 机制      |
| JWT secret 默认值 | 未配置时使用应用名作为密钥 | 启动时强制要求配置, 否则拒绝启动     |
| 无速率限制        | 暴力破解、资源耗尽         | 引入 rate limiter (如 koa-ratelimit) |
| CORS 全开         | 跨域攻击面                 | 配置白名单域名                       |
| body 限制 100MB   | 大 payload DoS             | 按接口设置合理限制                   |

---

## 八、数据层设计

### 数据库 Schema 是如何设计的?

三张核心表, 服务启动时通过 Knex 自动建表 (hasTable 检查):

users 表:

- `id` BIGINT 主键
- `name`, `email` (索引), `username` (唯一约束), `password`
- `created_at`, `updated_at`, `deleted_at` (软删除)

sessions 表:

- `id` VARCHAR 主键 (UUID)
- `username` (索引, 关联用户)
- `title` (会话标题)
- `created_at`, `updated_at`, `deleted_at` (软删除)

messages 表:

- `id` INT 自增主键
- `session_id` (索引, 关联会话)
- `username`, `content` (TEXT), `is_user` (BOOLEAN)
- `created_at`

设计要点:

- sessions 主键为 UUID, 由服务端 `randomUUID()` 生成 (service/session.ts:21, 51), 不依赖数据库自增协调; 流式建会话接口先落库, 再通过 SSE 首帧 `data: {"session_id": ...}` 把 ID 下发给前端 (controller/session.ts:84), 前端临时会话以 `"temp"` 占位, 收到真实 ID 后切换 (pages/ai-chat/index.tsx:136-149)
- messages 使用自增 INT, 保证插入顺序和查询性能
- 软删除 (deleted_at) 用于 users 和 sessions 两张表, 查询统一加 `whereNull("deleted_at")`; messages 表无软删除字段
- username 冗余存储在 messages 中, 避免跨表 JOIN

### 缓存层的抽象设计是怎样的? Redis 不可用时如何降级?

`db/cache.ts` 提供统一的缓存抽象层. 实现上没有抽象类/接口, 而是导出模块级函数 `cacheGet` / `cacheSet` / `cacheDelete`, 内部通过 `isRedisEnabled()` 布尔分发:

```
db/cache.ts
  ├── cacheGet / cacheSet / cacheDelete (模块级函数, 统一入口)
  ├── saveMessage (消息落库 MySQL 的 knex insert, 被 AiAgent 调用)
  ├── isRedisEnabled() ? Redis (db/redis.ts 的独立函数) : LRU (lru-cache 实例)
```

降级策略: `initCache()` 在服务启动时按配置尝试连接 Redis (`initRedis` + `testRedisConnection`), 连接成功则置 `redisEnabled = true`; 连接失败则回退, 初始化进程内 LRU 缓存实例:

- 最大条目数: 10,000
- 最大内存: 256MB
- TTL: 10 分钟

设计意义: 开发环境无需安装 Redis 即可运行 (`REDIS_ENABLED` 不为 "true" 时直接走 LRU, config/index.ts:66), 生产环境使用 Redis 实现跨进程/跨实例缓存共享. 目前业务代码尚未接入 `cacheGet`/`cacheSet` (全仓检索仅 `AiAgent.addMessage` 调用了同文件中的 `saveMessage` 做落库, ai/agent.ts:71), 缓存函数属于预留的基础设施; 未来接入时上层只需调用统一函数, 无需感知底层是 Redis 还是 LRU.

---

## 九、工程化与构建

### 前后端的构建方案分别是什么? 为什么服务端用 Rollup?

| 端   | 构建工具                                          | 输出                   |
| ---- | ------------------------------------------------- | ---------------------- |
| 前端 | Vite 8 (@vitejs/plugin-react + @tailwindcss/vite) | 静态资源 (HTML/JS/CSS) |
| 后端 | Rollup (TypeScript plugin)                        | 单个 ESM bundle        |

服务端选择 Rollup 的原因:

1. Tree-shaking: 移除未使用的代码路径, 减小部署体积
2. 单文件输出: 将所有本地模块打包为一个 ESM 文件, 简化部署 (无需 node_modules 中的源码)
3. external 配置: 所有 node_modules 依赖标记为 external (node: 内建、@langchain/ 与 @koa/ 前缀走正则, 其余逐个列名, rollup.config.js:13-32), 不打包进 bundle, 运行时再从 node_modules 加载
4. TypeScript 编译: 通过插件在构建时完成类型擦除, 产物为纯 JS

开发模式: 使用 `tsx watch` 直接运行 TypeScript, 无需构建步骤, 文件变更自动重启.

### 开发环境是如何组织的?

根目录 `package.json` 使用 `concurrently` 并行启动:

```json
{
  "scripts": {
    "dev": "concurrently \"pnpm dev:client\" \"pnpm dev:server\"",
    "dev:client": "pnpm --filter client dev",
    "dev:server": "pnpm --filter server dev"
  }
}
```

- client: `vite` (HMR, 端口 5173, 代理 /api -> localhost:8088)
- server: `tsx watch src/main.ts` (文件监听自动重启, 端口 8088)

代码规范:

- 前端: ESLint + Prettier
- 后端: Biome (更快的 lint + format 一体化工具)

---

## 十、设计模式与扩展性

### 项目中用到了哪些设计模式? 解决了什么问题?

| 模式        | 应用位置                                    | 解决的问题                                         |
| ----------- | ------------------------------------------- | -------------------------------------------------- |
| 工厂模式    | AiModelFactory                              | 解耦模型创建与使用, 新增模型类型只需 registerModel |
| 单例模式    | AiAgentManager, AiModelFactory              | 全局唯一的 Agent 管理器和模型注册表                |
| 策略模式    | AiModel 接口 (OpenAIModel / OpenAIRagModel) | 同一 Agent 可切换不同推理策略                      |
| 观察者/回调 | StreamCallback                              | 解耦 token 生成与 SSE 写入                         |
| 中间件模式  | Koa auth middleware                         | 横切关注点 (鉴权) 与业务逻辑分离                   |
| 分层架构    | Router->Controller->Service->DAO            | 关注点分离, 各层可独立测试和替换                   |
| 适配器模式  | 缓存层模块级函数 (Redis/LRU 布尔分发)       | 统一入口, 底层实现可替换                           |

扩展新模型示例:

```typescript
// 注册新模型只需一行 (MyModel 为新增的 AiModel 实现类)
factory.registerModel("my-model", (config) => new MyModel(config));
```

无需修改 Agent、Manager、Controller 的任何代码.

### 如果要支持水平扩展, 当前架构需要做哪些改造?

当前架构的水平扩展瓶颈及解决方案:

| 瓶颈           | 原因                   | 解决方案                                     |
| -------------- | ---------------------- | -------------------------------------------- |
| Agent 内存状态 | 对话历史存在进程内存中 | 迁移到 Redis/共享存储, 或使用 sticky session |
| RAG 向量索引   | 每次请求重建, 无共享   | 引入独立向量数据库服务 (Milvus/Qdrant)       |
| 文件存储       | 本地磁盘 uploads/      | 迁移到对象存储 (S3/OSS)                      |
| SSE 长连接     | 连接绑定到特定进程     | 使用 Redis Pub/Sub 或消息队列广播            |

最小改造路径 (Sticky Session):

1. 负载均衡器按 username 做一致性哈希, 同一用户的请求始终路由到同一实例
2. 无需改造 Agent 内存模型, 但牺牲了故障转移能力

完整改造路径 (无状态服务):

1. Agent 对话历史存入 Redis (List 结构)
2. 每次请求从 Redis 加载上下文, 响应后写回
3. 服务完全无状态, 可任意扩缩容

---

## 十一、UI 与国际化

### UI 组件体系是如何构建的?

采用 shadcn/ui 模式 (非 npm 依赖, 而是源码拷贝到项目中):

- 基础原语: Base UI (@base-ui/react, 无样式、可访问性优先的 headless 组件, Radix UI 的继任者)
- 样式层: Tailwind CSS 4 + CVA (class-variance-authority) 管理变体
- 工具函数: `tailwind-merge` 解决类名冲突, `clsx` 条件组合
- 组件目录: `components/ui/` 包含 button, card, input, select, textarea, dropdown-menu, skeleton, sonner (toast) 等

优势:

1. 组件源码在项目中, 可任意定制, 不受库版本约束
2. Base UI 保证 WAI-ARIA 可访问性
3. Tailwind 原子化样式避免 CSS 命名冲突
4. CVA 提供类型安全的变体管理

### 国际化方案是如何实现的?

使用 i18next + react-i18next:

- 语言包: `src/i18n/locales/zh.json` 和 `en.json`
- 语言检测: 通过 `navigator.language` 自动检测浏览器语言
- 持久化: `SettingsBar` 切换语言时写入 `languageAtom` (`atomWithStorage`, key 为 `language`), 同时调用 `i18n.changeLanguage()` 即时生效. 刷新页面后 `i18n/index.ts` 的 `getSavedLanguage()` 从 `language` key 读取 (atomWithStorage 写入的是 JSON 编码字符串, 读取端用 `JSON.parse` 解析并校验 zh/en), 命中则恢复用户选择, 否则回落 `navigator.language` 浏览器语言检测
- 使用方式: 组件中 `const { t } = useTranslation()`, 模板中 `t("chat.empty_title")`
- 切换组件: `SettingsBar` 提供语言下拉选择器, 切换后全局即时生效, 无需刷新

支持中文和英文两种语言, 覆盖所有用户可见文本 (按钮、提示、空状态等).

### 主题系统 (亮色/暗色/跟随系统) 是如何实现的?

状态层 (stores/settings.ts):

- `themeAtom` 用 `atomWithStorage<Theme>("theme", ...)` 创建, 三态 "light" | "dark" | "system", localStorage key 为 "theme" (settings.ts:6-15)
- `resolvedThemeAtom` 是派生 atom: theme 为 "system" 时通过 `window.matchMedia("(prefers-color-scheme: dark)")` 把它解析成实际亮暗 (settings.ts:18-29)

应用层 ThemeProvider (components/theme-provider/index.tsx):

1. 监听 resolvedTheme, 在 documentElement 上切换 `.light`/`.dark` 类, Tailwind 的 dark 变体消费该类 (theme-provider/index.tsx:9-17)
2. 同步更新 `<meta name="theme-color">` 为 #292120 (暗) 或 #fdf3f1 (亮), 适配移动端浏览器状态栏颜色 (theme-provider/index.tsx:19-25; 该更新以页面已声明此 meta 为前提, 当前 index.html 并未包含 theme-color meta, 这段逻辑暂不生效)
3. theme 为 "system" 时额外监听 prefers-color-scheme 的 change 事件, 系统主题切换即时生效, 卸载时移除监听 (theme-provider/index.tsx:29-45)

代码高亮联动: Markdown 组件给 Streamdown 传 `shikiTheme={["github-light", "github-dark"]}` 双主题, 高亮主题跟随 `.dark` 类自动切换 (components/markdown/index.tsx:25). App 的组件层级为 QueryClientProvider > ThemeProvider > RouterProvider + Toaster (App.tsx:10-17).
