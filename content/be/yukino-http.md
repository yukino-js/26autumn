---
title: "yukino_http 技术笔记"
description: "yukino_http Go HTTP 框架: Koa 风格洋葱模型中间件与延迟响应、TakeOver 响应接管、按段 Trie 路由、分组 Router、SSE 与 RFC 6455 WebSocket 的实现机制与适用场景"
local_path: "$HOME/github/yukino.go/libs/yukino_http"
---

yukino_http 是一个受 Koa.js 启发的 Go HTTP 框架。它用洋葱模型 (onion model) 组织中间件, 用延迟响应 (deferred response) 把状态码、响应体与响应头的决定权推迟到整条中间件链执行完毕, 并用一棵按路径段切分的 Trie 路由树完成请求分发。框架只依赖 Go 标准库, 内置日志与 panic 恢复中间件, 还手写实现了 Server-Sent Events 与 RFC 6455 WebSocket。本文面向需要在 Go 中构建中小型 HTTP 服务、希望理解框架内部机制或需要一个零第三方依赖 Web 框架的工程师, 依次讲解分层结构、关键机制、API 能力面、并发与容错设计、性能约束与适用边界。

## 定位与设计目标

框架的三个核心决策决定了它的全部形态:

| 目标             | 具体做法                                                                            | 带来的效果                                                   |
| ---------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 统一请求处理模型 | 路由 handler 与普通中间件都是 `Middleware` 类型 (`func(ctx *Context, next func())`) | 分组、鉴权、日志、恢复等逻辑能以同一种形态插入任意位置       |
| 可逆的响应构造   | 中间件不直接写 `http.ResponseWriter`, 而是写 `Context` 上的 Status/Body/headers     | 上游中间件能在 `next()` 返回后统一包装、压缩、改写或覆盖响应 |
| 零外部依赖       | 路由、SSE、WebSocket 全部基于标准库手写                                             | 无供应链风险, 编译产物小, 便于阅读与定制                     |

代价集中在两处: 延迟响应与流式写出的语义冲突 (SSE/WebSocket/静态文件需要 `flushed` 标志绕过统一序列化); 以及缺少 `sync.Pool` 之类的对象复用, 每请求都会分配新的 `Context`。

## 模块结构与架构分层

模块路径为 `github.com/hangtiancheng/yukino.go/libs/yukino_http`, `go.mod` 声明 Go 1.26, 没有任何 `require` 条目, 全部 import 都来自标准库。源码按职责切分为十个文件:

```text
yukino.go      Application、compose()、ServeHTTP
context.go     Context 结构、请求访问器、State/Params、TakeOver
response.go    延迟响应渲染 (respond/promoteStatus/各序列化分支)
group.go       Router 分组、Static、前缀归一化与边界匹配
router.go      内部 router: 注册、匹配、分发、404
trie.go        按段 Trie 节点: insert/search/matchChild(ren)
websocket.go   RFC 6455 WebSocket: 握手、帧编解码、消息重组
sse.go         Server-Sent Events: SSEWriter 与心跳
logger.go      Logger 中间件
recovery.go    Recovery 中间件与栈回溯
```

`Application` 本身实现了 `http.Handler` 接口 (即 `ServeHTTP` 方法), 因此既能作为 `http.Server` 的 Handler 使用, 也能直接在 `httptest` 中被 `httptest.NewServer` 或 `httptest.NewRecorder` 驱动。`New()` 返回裸应用并在构造时就创建好内部的 `http.Server` (Handler 指向应用自身); `Default()` 在此之上预装 `Logger()` 与 `Recovery()` 两个中间件。

## 请求生命周期与洋葱模型

一次请求的处理路径如下:

```text
http.Server
  -> Application.ServeHTTP
       -> 遍历 app.routers, 收集所有前缀匹配的分组中间件
       -> newContext(w, req)                          Status 初始为 404
       -> router.handle(ctx, middlewares)
            -> getRoute(method, path) 命中 trie 叶节点 -> 提取 Params
            -> compose(middlewares, handler)(ctx)     洋葱式执行
            -> 未命中路由时 final 换成内置 notFound handler
            -> ctx.respond()                          统一写出
```

`compose` 是洋葱模型的实现核心, 它把中间件切片与最终 handler 组合成一个闭包。关键点有三: 递归闭包 `dispatch(i)` 让每个 `next()` 变成 `dispatch(i+1)`, 从而产生"进入"与"退出"两个阶段; 用 `index` 记录已派发位置, 阻止 `next()` 被重复调用; handler 作为 `final` 收到的是一个空 `next`, 避免业务代码误调。

```go
dispatch = func(i int) {
    if i <= index {
        panic("yukino_http: next() called multiple times")
    }
    index = i
    if i >= len(middlewares) {
        if final != nil {
            final(ctx, func() {})
        }
        return
    }
    middlewares[i](ctx, func() { dispatch(i + 1) })
}
```

重复调用 `next()` 会 panic, 而不是返回错误; 这个 panic 会沿栈向上传播, 由 Recovery 中间件转成 500。因此建议把 Recovery 放在洋葱链的最外层 (靠近 `Use` 的第一次调用), 这样它能覆盖所有内层中间件与 handler 的 panic。不调用 `next()` 则会短路整条链, 这是鉴权拦截等场景的标准写法。

执行顺序以 `[Logger, Recovery, Auth]` + handler 为例: 进入阶段为 Logger → Recovery → Auth → handler, 退出阶段为 Auth → Recovery → Logger。Logger 因此能在 `next()` 返回后读到最终状态码并记录耗时; Recovery 则通过 `defer` + `recover` 捕获内层 panic —— 发生 panic 时 `next()` 不会返回, 延迟函数在栈展开过程中执行并改写响应。

分组中间件的收集发生在一个循环里, 遍历顺序就是注册顺序: 根 Router 的中间件先入列, 之后创建的子 Router 依次追加, 父分组总是先于子分组创建, 因此嵌套分组的中间件天然层层叠加。前缀匹配使用 `matchRouterPath`, 因此 `/api` 分组的中间件只会作用于 `/api` 与 `/api/...`, 不会误伤 `/apikeys`。

路由未命中时并不会绕过洋葱链: `handle` 构造一个内置的 notFound handler 作为 `final`, 它置 `Status = 404`、`statusSet = true` 并写入纯文本 body `"404 NOT FOUND: " + path`。这意味着全局中间件 (日志、鉴权、CORS) 对 404 响应同样生效。

## 延迟响应机制

中间件执行期间, `Context` 中的 `Status`、`Body`、`headers` 都只是待写出的状态; 只有 `respond()` 被调用时才真正触碰 `http.ResponseWriter`。这套语义由几个标志位协同实现:

| 字段        | 作用                                                                                             |
| ----------- | ------------------------------------------------------------------------------------------------ |
| `statusSet` | 标记状态码是否被用户显式设置 (`SetStatus` / `Throw` / `Redirect` / `SSE` / `Upgrade` / notFound) |
| `flushed`   | 标记响应是否已被接管 (`TakeOver`、SSE、WebSocket、静态文件), `respond()` 见到即直接返回          |
| `headers`   | 延迟响应头缓冲, `Set` 以 `http.CanonicalHeaderKey` 规范化键名                                    |

状态码自动提升模拟了 Koa 的语义: `Context` 初始 Status 为 404, `promoteStatus` 只在"未显式设置状态码且 Status 仍为初始 404"时把它提升为 200。`JSON`、`String`、`Data`、`HTML` 都会调用 `promoteStatus`, 因此"设置了 body 就等于 200"对整个洋葱链可见, 而不是等到最后才决定; 反过来, 直接给 `ctx.Status` 赋一个非 404 的值 (如 500) 不会被覆盖, `respond()` 里的兜底判断也遵循同一条件 (`Body != nil && !statusSet && Status == 404`)。

`respond()` 按 Body 的静态类型分发序列化方式:

| Body 类型     | 写出方式                     | 默认 Content-Type                      |
| ------------- | ---------------------------- | -------------------------------------- |
| `htmlPayload` | `html/template` 渲染命名模板 | `text/html`                            |
| `[]byte`      | 原样写出                     | 由 `ctx.Type` 决定, 可为空             |
| `string`      | 原样写出                     | `ctx.Type` 为空时取 `text/plain`       |
| `io.Reader`   | `io.Copy` 流式拷贝           | 由 `ctx.Type` 决定                     |
| 其它          | `json.Marshal`               | `ctx.Type` 为空时取 `application/json` |

`Body == nil` 时只写状态码不写内容。几个边界条件值得注意:

- 若用户通过 `ctx.Set("Content-Type", ...)` 设置了响应头, 它会在推断默认值之前被刷入 `ResponseWriter`; 各序列化分支的 `setContentType` 只在 writer 上 Content-Type 仍为空时才写入, 因此用户头优先于框架推断的类型。
- 204、205、304 这些不允许携带 body 的状态码会强制清空 Body, 并删除 Content-Type、Content-Length、Transfer-Encoding 三个头。
- JSON 序列化失败时, 记录日志并直接写 500 与 `{"message":"Internal Server Error"}`, 不再二次尝试。
- 未加载任何 HTML 模板却调用 `HTML()` 时, 写出 500 与一段 `HTML templates are not loaded` 提示, 而不是返回错误; 模板执行中途失败只记录日志, 因为状态码与部分 body 已经写出, 无法再改写。

`Redirect` 保留调用方已选择的 3xx 状态码 (300/301/302/303/305/307/308), 未显式设置时默认 302, 置位 `statusSet` 并始终写入 `Location` 头; 若 Body 仍为空, 会补一段 `Redirecting to <url>` 的纯文本提示。

## Trie 路由

路由树按 URL 路径段 (segment) 而非字符切分, 每个方法一棵树 (`roots map[string]*node`), 每个节点保存一段, 只有注册过的完整路径对应的节点才有非空 `pattern`:

```text
/                (root)
  users          part="users"
    |-- :id      part=":id",    isWild=true   pattern="/users/:id"
    |-- list     part="list"                   pattern="/users/list"
  static         part="static"
    |-- *filepath part="*filepath", isWild=true pattern="/static/*filepath"
```

支持三类段: 静态段 (`users`)、参数段 (`:id`, 匹配单段)、通配段 (`*filepath`, 贪婪匹配剩余所有段)。匹配时 `matchChildren` 先收集精确同名的子节点, 再追加所有 `isWild` 子节点, 按此顺序逐个递归尝试; 静态路由因此天然优先于通配路由。搜索的时间复杂度是 O(k·b), k 为路径段数, b 为每层候选子节点数; 常规应用中 b 很小, 近似线性。

注册时会做模式规范化: `parsePattern` 按 `/` 分割并丢弃空段, 因此 `/users`、`/users/`、`//users` 会归并到同一个 key。这避免了"先注册 `/users/`、后注册 `/users`, 前者被静默遮蔽"的问题。`parsePattern` 还会在遇到以 `*` 开头的段时截断后续段, 因为通配段语义上已经吃掉剩余路径。handler 以 `method + "-" + pattern` 为 key 存入 map, 同一 pattern 重复注册会静默覆盖旧 handler。

参数提取发生在命中叶节点之后: 用注册模式的段与实际请求的段逐位对齐, `:` 段取单段值, `*` 段把剩余段用 `/` 拼接后终止对齐。搜索遇到 `*` 前缀节点时直接返回该节点, 因此通配段可以匹配任意数量 (包括零个) 剩余段。

几个已知边界:

- 同一层可同时注册 `/users/:id` 与 `/users/:name`, 它们是两个不同的通配子节点, 但匹配时按插入顺序逐个尝试, 总是命中先注册的分支, 后注册的路由永远不可达; 应在应用层避免这种冲突写法。
- 路由注册使用普通 map 与切片, 没有加锁, 因此必须在 `Listen` 之前完成, 之后路由表只读, 这与多数 Go 框架的约定一致。
- 每次注册都会 `log.Printf` 打印 `Route <METHOD> - <pattern>`, 启动日志即是路由清单。

`All(pattern, handler)` 是七个方法 (GET/POST/PUT/DELETE/PATCH/HEAD/OPTIONS) 的批量注册快捷方式。

## 分组 Router 与静态文件

`Router` 保存 prefix、本组中间件、父指针与应用指针。`app.Router("/api")` 会以"父前缀 + 规范化后的新前缀"创建子 Router, 并注册进 `app.routers`。子 Router 注册路由时 pattern 为 `prefix + comp`, 中间件在 `ServeHTTP` 中按前缀边界收集。

`normalizePrefix` 保证前缀以 `/` 开头、不以 `/` 结尾, 根前缀 `/` 归一为空串。若不规范化, `Router("v1")` 注册的路由可经 `parsePattern` 折叠斜杠后访问到 `/v1/...`, 但分组中间件因前缀不含 `/` 而永远不匹配, 出现"路由可达、中间件失效"的隐蔽缺陷。

静态文件服务复用通配路由: `Static("/assets", "public")` 注册 GET `/assets/*filepath`, 把请求交给 `http.StripPrefix(absolutePath, http.FileServer(fs))`, 其中 `absolutePath` 是分组前缀与相对路径的拼接。处理流程有几个设计点:

1. 先探测目标是否存在 (`staticFileExists`), 不存在就置 404 + `statusSet` 走正常的延迟响应, 不劫持连接。
2. 文件存在时, 调用 `TakeOver()` 接管响应: 把上游通过 `ctx.Set` 缓冲的 CORS 等延迟响应头刷入 `ResponseWriter`, 否则它们会在 `FileServer` 写入后被丢弃; 同时置位 `flushed`, 阻止 `respond()` 二次写出。
3. 用 `statusRecorder` 包装 `ResponseWriter`, 把 `FileServer` 实际写出的状态码回填到 `ctx.Status` (只写 body 不写头时记为 200), 让 Logger 之类的外层中间件观察到真实状态码。
4. `staticFileExists` 打开文件、取 `Stat` 后立即关闭句柄; 目录只有在包含 `index.html` 时才视为存在, 因此目录列表 (directory listing) 永远不会暴露。

## Context API 与统一错误响应

`Context` 同时承载请求信息与延迟响应状态。请求侧的读取能力包括 `Get` (请求头)、`Query`、`Param`、`PostForm`、`FormFile`、`BindJSON`, 以及直接暴露的 `Request`/`Path`/`Method`。`State` 是中间件之间的数据通道, 例如鉴权中间件写入 `ctx.State["user"]`, 下游 handler 读取; `Params` 由路由匹配填充。

错误响应统一为 `{message, data}` 结构 (`H` 即 `map[string]any`), 便于前端与成功路径共用同一套解析逻辑:

```go
func (ctx *Context) Throw(status int, msg string) {
    ctx.Status = status
    ctx.statusSet = true
    ctx.Body = H{"message": msg, "data": nil}
}
```

`Throw` 与 `SetStatus` 都会置位 `statusSet`, 从而阻止错误状态码被自动提升为 200。`Throw` 只改状态不中断执行, handler 需要在调用后自行 `return`。`BindJSON` 使用 `json.NewDecoder` 对请求体做流式解码并在结束时关闭 body, 不需要先把整个 body 读进内存; 但它没有对 body 大小设上限, 面向不可信客户端时应在外层加 `http.MaxBytesReader` 之类的限制。

响应侧的写出方法 (`JSON`/`String`/`Data`/`HTML`/`Redirect`/`Throw`/`SetStatus`) 都只修改 `Context` 上的延迟状态, 真正写出统一发生在 `respond()`; `String(format, values...)` 按 `fmt.Sprintf` 语义格式化。模板渲染由应用级的 `SetFuncMap` 与 `LoadHTMLGlob` 配置, 后者用 `template.Must` 解析 glob, 模板语法错误会在启动期 panic; `SetFuncMap` 必须在 `LoadHTMLGlob` 之前调用, 函数表在解析时注入。

## 响应接管: TakeOver 与外部 http.Handler

`ctx.TakeOver()` 把响应所有权从框架转移给业务代码, 用于 handler 需要直接写 `ctx.Writer` 或把连接委托给标准 `http.Handler` 的场景:

```go
app.All("/mcp", func(ctx *yukino.Context, _ func()) {
    ctx.TakeOver()
    mcpHandler.ServeHTTP(ctx.Writer, ctx.Request)
})
```

`TakeOver` 只做两件事: 置位 `flushed` 让 `respond()` 直接返回, 并把 `ctx.Set` 缓冲的中间件响应头拷入原始 writer。它不写状态码、不写 body、不触发 Flush, 也不包装或替换 writer —— `ctx.Writer` 仍是原始 `http.ResponseWriter`, 保留其实现的可选接口 (如 `http.Flusher` 与 `http.Hijacker`)。重复调用是幂等的。

接管之后的语义边界:

- 延迟响应机制整体失效: 此后对 `ctx.Body`/`ctx.Status`/`ctx.Set` 的修改 (包括上游中间件在 `next()` 返回后的改写) 都不会被渲染。
- `ctx.Status` 不会从直接写出中推断, 保持接管前的值; 日志类中间件需要看到真实状态码时, 由 handler 显式调用 `ctx.SetStatus` 记录。
- 流式 handler (SSE、长轮询、MCP Streamable HTTP) 必须运行到流结束或请求 context 取消才返回: writer 只在请求生命周期内有效, handler 一旦返回, 上游中间件无法再感知流的状态。

框架内置的接管路径都收敛到同一个入口: `ctx.SSE()` 先写入 SSE 标准头再调用 `TakeOver()`; `Static()` 的文件处理器在确认文件存在后调用 `TakeOver()` 再委托 `http.FileServer`; `ctx.Upgrade()` 走得更远, 直接 `Hijack` 把 TCP 连接所有权从 `net/http` 拿走, 同样置位 `flushed`。有了公开的 `TakeOver`, 外部 handler (如 MCP SDK 的 Streamable HTTP 与 HTTP+SSE 两种传输) 可以原样保留 SDK 自己选择的状态码、会话响应头、202 确认与流式 Flush 行为, 而不会与 `respond()` 的统一序列化产生重复写状态码的冲突。

## 内置中间件: Logger 与 Recovery

`Logger` 在 `next()` 前记录起始时间, 在 `next()` 后打印 `[状态码] URI in 耗时`, 因此它能观察到下游 (包括 `respond` 之前对 Status 的修改) 的最终取值; 耗时精度为整个洋葱链的墙钟时间。

`Recovery` 用 `defer` + `recover` 捕获内层 panic。它有一个重要的例外: 当 panic 值为 `http.ErrAbortHandler` 这个由 `net/http` 内部使用的哨兵错误时, 必须原样重新 panic, 否则会破坏标准库的中止语义 (例如 `httputil.ReverseProxy` 在客户端断开时依赖它静默结束请求)。其余 panic 会被转换为 500 响应, 并打印带栈帧的堆栈: 用固定大小数组 `[32]uintptr` 收集调用者以避免堆分配, 再用 `runtime.CallersFrames` 展开 (能正确处理被内联的函数帧), 逐帧输出 `文件:行号`。

转换为 500 时, Recovery 会重置状态: 置位 `statusSet`、清空 `Type`、重建 `headers`、把 Body 换成 `{"message":"Internal Server Error"}`。重建 headers 是为了丢弃 panic 前可能已写入的不完整响应头 (例如只设了一半的 CORS 头)。

## SSE (Server-Sent Events)

`ctx.SSE()` 是事件流的入口。它把连接状态切换为"已接管": 置 Status 为 200、`statusSet = true`, 写入 SSE 标准头 (`Content-Type: text/event-stream`、`Cache-Control: no-cache`、`Connection: keep-alive`), 然后调用 `TakeOver()` 刷入延迟响应头并显式 `WriteHeader(200)`。延迟响应头在标准头之后刷入, 因此同名 key 会覆盖框架的默认值。`flusher` 在接管前由类型断言获得, 若底层 `ResponseWriter` 不实现 `http.Flusher`, 刷新会退化为空操作。

`SSEWriter` 的事件写出方法 (Event/Data/JSON/ID/Retry/Comment 及心跳) 都持有同一个 `sync.Mutex`, 因此多个 goroutine 可以安全地向同一连接推送事件; `Flush` 只触发底层刷新, 不写事件内容, 因此不加锁。能力面如下:

| 方法                 | 写出内容                            | 说明                                       |
| -------------------- | ----------------------------------- | ------------------------------------------ |
| `Event(event, data)` | `event:` + 多行 `data:` + 空行      | 命名事件                                   |
| `Data(data)`         | 多行 `data:` + 空行                 | 默认 message 事件                          |
| `JSON(event, obj)`   | 可选 `event:` + 单行 `data: <json>` | 序列化在加锁前完成, 失败时静默返回         |
| `ID(id)`             | `id: <id>`                          | 不追加空行, 归属下一个事件                 |
| `Retry(ms)`          | `retry: <ms>` + 空行                | 建议客户端重连间隔                         |
| `Comment(text)`      | 每行 `: <text>` + 空行              | 心跳与调试, 多行安全                       |
| `Flush()`            | 触发一次底层刷新                    | 手动控制推送时机                           |
| `Done()`             | `data: [DONE]`                      | 对齐 OpenAI 风格流式结束约定               |
| `Closed()`           | 返回请求 Context 的 Done channel    | 供外部等待客户端断开                       |
| `Stream(ch)`         | 消费 `<-chan string`, 逐个 `Data`   | channel 关闭或客户端断开时返回, 桥接上游流 |

`writeData` 会把数据按 `\n` 切分, 每行都加 `data: ` 前缀, 最后补一个空行结束事件, 符合 SSE 多行数据的编码要求。

心跳由 `Heartbeat(interval)` 管理: 它启动一个 goroutine 按 `time.Ticker` 周期在互斥锁保护下发送 `: keepalive`, 同时监听客户端断开 (请求 Context 的 Done) 与主动停止信号。返回的停止函数用 `sync.Once` 保证幂等, 并通过等待 done channel 确认 goroutine 完全退出, 不留泄漏。

## WebSocket 握手 (RFC 6455)

`ctx.Upgrade(opts)` 完成握手并返回 `*WSConn`, 校验顺序如下:

| 步骤 | 校验/动作                                                    | 失败行为                                               |
| ---- | ------------------------------------------------------------ | ------------------------------------------------------ |
| 1    | `opts.CheckOrigin` 非 nil 时执行来源校验                     | `Throw(403)`                                           |
| 2    | 方法必须为 GET                                               | `Throw(405)`                                           |
| 3    | `Connection` 头包含 token `upgrade` (大小写不敏感, 逗号分隔) | `Throw(400)`                                           |
| 4    | `Upgrade` 头包含 token `websocket`                           | `Throw(400)`                                           |
| 5    | `Sec-WebSocket-Version` 含 token `13`                        | 缓冲 `Sec-WebSocket-Version: 13` 响应头并 `Throw(400)` |
| 6    | `Sec-WebSocket-Key` 非空                                     | `Throw(400)`                                           |
| 7    | 按服务端优先级协商子协议                                     | 无匹配则不写协议头                                     |
| 8    | `http.NewResponseController(...).Hijack()` 接管连接          | `Throw(500)`                                           |
| 9    | 清空读写 deadline, 计算 Accept Key, 拼接并直接写 101 响应    | 写失败则关闭连接并返回错误                             |

前 8 步的失败都走延迟响应 (此时尚未接管), `Throw` 设置的 `{message, data}` JSON 错误体会由 `respond()` 正常写出。为什么用 Hijack 而不是标准 `ResponseWriter`: 升级完成后连接不再是 HTTP 语义, 需要双向、全双工读写帧, 而 `ResponseWriter` 只能写响应。Hijack 把底层 TCP 连接的所有权从 `net/http` 转移到应用层。

Accept Key 遵循 RFC 6455: 将客户端 Key 与固定 GUID `258EAFA5-E914-47DA-95CA-C5AB0DC85B11` 拼接, 做 SHA-1 后 Base64。101 响应绕过 `bufio.Writer` 直接 `conn.Write` 写出。升级成功后立即置 `flushed = true`、`Status = 101`、`statusSet = true`, 并用 `SetDeadline(time.Time{})` 清掉 HTTP Server 可能遗留的读写超时。

读缓冲区的选择考虑到了 Hijack 时可能已有缓冲数据: 若 `bufio.Reader` 中还有未读字节, 必须直接复用它, 否则会丢失 HTTP 请求尾部; 否则在其容量不小于目标大小 (默认 4096, 可由 `ReadBufferSize` 覆盖) 时复用, 过小时新建一个指定大小的 reader。

`CheckOrigin` 的安全意义在于: 浏览器不会像同源策略那样自动拦截跨域 WebSocket 连接, 服务端若不校验 Origin, 恶意站点可能借用户的 Cookie 建立连接并发起 CSRF 式操作。因此 `CheckOrigin` 为 nil 时框架跳过校验 (便于开发), 生产环境应显式配置。

## WebSocket 帧解析与消息重组

RFC 6455 帧布局:

```text
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-+-+-+-+-------+-+-------------+-------------------------------+
|F|R|R|R| opcode|M| Payload len |    Extended payload length    |
|I|S|S|S|  (4)  |A|     (7)     |            (16/64)            |
|N|V|V|V|       |S|             |                               |
| |1|2|3|       |K|             |                               |
+-+-+-+-+-------+-+-------------+-------------------------------+
|     Masking-key (0 or 4 bytes)      |     Payload Data ...     |
+-------------------------------------+--------------------------+
```

单帧读取 `readFrame` 的安全校验覆盖了 RFC 6455 的强制要求:

1. RSV1-3 必须为 0; 框架未协商任何扩展 (如 permessage-deflate), 非零即拒绝。
2. opcode 仅允许 continuation (0)、text (1)、binary (2)、close (8)、ping (9)、pong (10), 其余拒绝。
3. 控制帧必须 FIN=1 且 7 位长度不超过 125 字节。
4. 客户端到服务端的帧必须带 mask, 防止代理缓存投毒。
5. 扩展长度按大端序解析 (126 对应 16 位, 127 对应 64 位), 单帧长度不得超过 `messageLimit()` (默认 65536 字节, 由 `MaxMessageSize` 覆盖)。
6. 读取后按 4 字节 mask key 循环异或解掩码。

违规帧统一返回导出的 `ErrWSInvalidFrame`。`readMessage` 负责分片重组, 规则与 RFC 6455 5.4 一致: continuation 帧必须跟在数据帧之后; 分片进行中不得出现新的数据帧; 分片之间允许插入控制帧, 控制帧立即返回给调用者处理; 重组后的总长度同样受 `messageLimit()` 约束。写方向 `writeFrame` 始终置 FIN 且不做分片, 按 payload 长度选择 7/16/64 位长度编码, header 与 payload 拼成单个缓冲后一次 `conn.Write` 写出, 避免半帧的 TCP 分片; 服务端到客户端的帧按规范不加 mask。

消息消费有两种模式:

| 模式     | 接口                            | 行为                                                                                                                                              |
| -------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 拉取式   | `ReadMessage()` / `ReadJSON(v)` | 持读锁, 自动回 Pong、吞掉 Pong, 收到 Close 时回写 Close、触发 OnClose 并返回 `ErrWSClosed`; `ReadJSON` 是 `ReadMessage` + JSON 反序列化的便捷封装 |
| 事件驱动 | `Listen()`                      | 阻塞读循环, 分发到 OnMessage/OnClose/OnError/OnPing/OnPong, Ping 自动回 Pong                                                                      |

两种模式都独占读方向: `ReadMessage` 持 `readMu`, `Listen` 不加锁但语义上是唯一的读循环, 二者不可混用。写出 API 包括 `WriteMessage`、`WriteJSON`、`Send`、`WriteText`、`WriteBinary`、`Ping`、`Close`、`CloseWithMessage`, 以及 `SetReadDeadline`/`SetWriteDeadline`/`NetConn`。`Heartbeat(interval)` 周期发送 Ping 帧 (Ping 出错即停止), 返回幂等停止函数, 与 SSE 心跳同构, 但监听的是连接自身的 `closed` channel。

Close 帧 payload 按规范解析: 前 2 字节为大端序状态码, 不足 2 字节视为正常关闭 (1000); 其余部分为原因文本, UTF-8 校验失败时置空。

## 并发模型与安全约束

| 组件                 | 同步手段                     | 允许的并发使用方式                                                |
| -------------------- | ---------------------------- | ----------------------------------------------------------------- |
| `WSConn`             | `writeMu` + `readMu`         | 一个 goroutine 读、另一个写; 多个 goroutine 写由 `writeMu` 串行化 |
| `WSConn` 生命周期    | `closed chan` + `sync.Once`  | `Close` 幂等; `Closed()` 供外部 `select` 等待                     |
| `SSEWriter`          | `sync.Mutex`                 | 多 goroutine 并发推送事件                                         |
| 心跳 (WS/SSE)        | `sync.Once` + `done` channel | 停止函数可重复调用, 且会等待 goroutine 退出                       |
| `Application` 路由表 | 无锁                         | 注册必须在 `Listen`/`Serve` 之前完成, 之后只读                    |

读循环里自动回写的 Pong 帧不经过 `writeMu`, 但由于每帧都是单次 `conn.Write` 原子写出, 不会与其它写方向产生半帧交错。`WSConn.handleError` 在连接已被本地或对端关闭时不会触发 `OnError`, 因为此时尾随的读错误 ("use of closed network connection") 不是应用层错误; 处理完后统一由 `sync.Once` 关闭 `closed` channel。`Close`/`CloseWithMessage` 先关闭 `closed` channel 再写 Close 帧、最后关闭 TCP 连接, 保证关闭广播与帧写出都不会重复。

## 优雅关闭

`Application.Listen` 设置地址后调用 `http.Server.ListenAndServe`; `Shutdown(ctx)` 直接委托 `http.Server.Shutdown`, 停止接收新连接并等待在途请求完成或上下文超时。`server` 字段在 `New()` 中构造而非 `Listen()` 中构造, 目的是消除一个竞态窗口: 若在 `Listen` 里赋值, 并发的 `Shutdown` 可能观察到 `server == nil` 而静默返回 nil, 服务实际未关闭。

```go
app := yukino.Default()
go app.Listen(":8000")
<-sigCh
ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
defer cancel()
_ = app.Shutdown(ctx)
```

`Listen` 只封装了明文的 `ListenAndServe`, 没有内置 TLS 入口; 但 `Application` 实现了 `http.Handler`, 需要 TLS、HTTP/2 或自定义超时时, 可以像 agent_proxy 那样把应用挂到自己构造的 `http.Server` 上, 由外层负责 `Serve`/`Shutdown`。

## 配置项

`UpgradeOptions` 是唯一成体系的配置结构:

| 字段              | 默认   | 作用                                             |
| ----------------- | ------ | ------------------------------------------------ |
| `ReadBufferSize`  | 4096   | Hijack 后读缓冲区大小; reader 已有数据时必须复用 |
| `WriteBufferSize` | 未使用 | 结构体中保留, 当前实现不读取                     |
| `MaxMessageSize`  | 0      | 单帧与重组消息的上限, 0 表示 65536               |
| `CheckOrigin`     | nil    | 来源校验回调, nil 表示跳过                       |
| `Subprotocols`    | nil    | 服务端优先的子协议列表                           |

模板渲染相关的配置是 `SetFuncMap` 与 `LoadHTMLGlob`。其它行为 (忽略 body 的 JSON 序列化、默认 404→200 提升、SSE 三个标准头) 都是内置约定, 没有开关。

## 可测试性与可观测性

- `Application` 实现 `http.Handler`, 可以直接被 `httptest.NewRecorder` 或 `httptest.NewServer` 驱动, 单元测试无需真实端口。
- 每个组件都有对应的单元测试覆盖: Context 辅助方法与 State/Throw、响应序列化的状态提升与空状态码处理、延迟响应被中间件改写的可见性、Trie 匹配与静态段优先、未命中路由的 404、SSE 多行数据/JSON/注释/Stream/自定义头/心跳并发/Closed、WebSocket 握手与回显、JSON 读写、分片重组、拒绝未掩码帧、版本校验、子协议协商、Accept Key、Close payload 解析、TakeOver 的幂等/writer 身份/流式推送、嵌套分组与前缀归一化、静态目录列表禁用与句柄关闭、`next()` 重复调用转 500。
- 可观测性目前依赖 `log.Printf`: Logger 输出状态码与耗时, Recovery 输出带栈帧的 panic 详情, 路由注册时打印 method 与 pattern, JSON 序列化与模板执行失败也会记录。框架没有内建结构化日志、请求 ID 或指标 (metrics) 集成点。

## 性能与资源约束

| 关注点           | 现状                                  | 影响                                            |
| ---------------- | ------------------------------------- | ----------------------------------------------- |
| Context 分配     | 每请求新建, 无对象池                  | 高 QPS 下 GC 压力高于使用 `sync.Pool` 的框架    |
| 路由匹配         | 每层线性扫描 children 切片            | 路由数量极大时可考虑 map 索引或 radix tree      |
| 路由冲突         | 不检测 `:id`/`:name` 冲突             | 需要应用层规避                                  |
| 请求体大小       | `BindJSON` 无上限                     | 面向不可信客户端需自行限制                      |
| 静态文件         | 每次请求先探测文件存在性              | 多一次 open+stat, 换来正确的 404 与目录列表防护 |
| WebSocket 写     | 一次性 `conn.Write`, 无写缓冲与写超时 | 慢客户端可能阻塞写 goroutine                    |
| WebSocket 帧上限 | 单帧与重组消息共用同一上限            | 无法分别为两者配置                              |
| SSE              | 有 flusher 检测, 无自动重连 ID 管理   | 断线续传需业务层实现                            |

延迟响应让上游中间件拥有对最终响应的最后修改权, 这正是 Koa 风格的表达力所在; 代价是框架必须为流式场景维护一套旁路机制 (SSE/WebSocket/静态文件的 `flushed`), 并且无法像即时写入的框架那样边算边发 (除非显式接管)。

## 零依赖的取舍与已知边界

自行实现 WebSocket 与 SSE 换来了零供应链依赖, 代价是与成熟的第三方 WebSocket 库相比存在若干能力缺口:

- 不支持 permessage-deflate 消息压缩, RSV1 非零一律拒绝。
- 不自动管理写超时, 慢客户端的写阻塞需要业务层用 `SetWriteDeadline` 自行兜底。
- 没有 `NextWriter` 式的流式分片写入, `WriteMessage` 一次性构造并写出整帧。
- 单帧上限与重组消息上限共用同一个 `messageLimit()`, 无法独立配置。
- 发送 Close 帧后不等待对端回复即关闭连接, 没有 Close 握手超时。
- 不处理 TLS、代理头与 `X-Forwarded-For`, 这些交给底层 `net.Conn` 与部署层。

SSE 侧则没有自动重连 ID 管理 (不读取 `Last-Event-ID`)、订阅广播或连接池, 这些语义需要业务层基于 `ID()`、`Closed()` 与 `Stream()` 自行组合。

## 适用场景与选型建议

适合使用 yukino_http 的场景:

- 需要零第三方依赖、希望完全掌控供应链的小型或内部服务。
- 需要把响应包装、错误统一化、鉴权等横切逻辑放在洋葱链任意位置, 并希望在 `next()` 返回后仍能改写响应。
- 需要内置的 SSE 或 WebSocket 而不想引入额外库。
- 用于学习 HTTP 框架内部机制。

不适合或需要补强的场景:

- 需要极高 QPS 与稳定低延迟的公开 API 网关: 缺少 Context 池、指标与结构化日志, 建议使用成熟框架。
- 需要框架层内置 TLS/HTTP2、请求体限额、permessage-deflate 压缩、写超时或 Close 握手超时的场景, 当前实现未覆盖, 需要在外层 `http.Server` 或业务代码中自行扩展。
- 需要大量路由且对匹配延迟敏感的场景: 按段 Trie 的每层线性扫描会成为瓶颈。

相关主题: 框架的内置能力已被同仓库多个模块直接复用 —— [yukino_cache](./yukino-cache-go) 的实时仪表盘就是一个挂载在本框架上的 WebSocket 端点, 用 `ctx.Upgrade` 完成握手、用 `WSConn` 的 30 秒心跳与 `WriteJSON` 推送缓存快照; [yukino_taskflow](./yukino-task-flow) 用本框架组装 API 路由与中间件链; [yukino_agent_proxy](./yukino-agent-proxy) 用 `New()` 加 `Recovery()` 搭建本地控制面, 借助 `ctx.TakeOver()` 挂载 MCP SDK 官方的 Streamable HTTP (`/mcp`) 与 HTTP+SSE (`/sse`) 传输端点, 并把 `Application` 作为 `http.Handler` 挂到自带超时配置的外部 `http.Server` 上。接口、方法集与并发原语等语言层基础见 [Go 语言核心](./go)。
