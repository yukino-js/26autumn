---
title: "yukino_http 技术笔记"
description: "yukino_http Go HTTP 框架: Koa 风格洋葱模型中间件与延迟响应、按段 Trie 路由、分组 Router、SSE 与 RFC 6455 WebSocket 的实现机制与适用场景"
local_path: "$HOME/github/yukino.go/libs/yukino_http"
---

yukino_http 是一个受 Koa.js 启发的 Go HTTP 框架。它用洋葱模型 (onion model) 组织中间件, 用延迟响应 (deferred response) 把状态码、响应体与响应头的决定权推迟到整条中间件链执行完毕, 并用一棵按路径段切分的 Trie 路由树完成请求分发。框架只依赖 Go 标准库, 内置日志与 panic 恢复中间件, 还手写实现了 Server-Sent Events 与 RFC 6455 WebSocket。本文面向需要在 Go 中构建中小型 HTTP 服务、希望理解框架内部机制或需要一个零第三方依赖 Web 框架的工程师, 依次讲解分层结构、关键机制、API 能力面、并发与容错设计、性能约束与适用边界。

## 定位与设计目标

框架的三个核心决策决定了它的全部形态:

| 目标             | 具体做法                                                                        | 带来的效果                                                   |
| ---------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 统一请求处理模型 | 路由 handler 与普通中间件都是 `Middleware` 类型                                 | 分组、鉴权、日志、恢复等逻辑能以同一种形态插入任意位置       |
| 可逆的响应构造   | 中间件不直接写 `http.ResponseWriter`, 而是写 `Context` 上的 Status/Body/headers | 上游中间件能在 `next()` 返回后统一包装、压缩、改写或覆盖响应 |
| 零外部依赖       | 路由、SSE、WebSocket 全部基于标准库手写                                         | 无供应链风险, 编译产物小, 便于阅读与定制                     |

代价集中在两处: 延迟响应与流式写出的语义冲突 (SSE/WebSocket/静态文件需要 `flushed` 标志绕过统一序列化); 以及缺少 `sync.Pool` 之类的对象复用, 每请求都会分配新的 `Context`。

## 架构分层

```text
Application (yukino.go)
  |-- Router / group.go       分组前缀、分组中间件、静态文件
  |-- router + trie           路由注册、匹配、参数提取
  |-- Context                 请求上下文与延迟响应状态
  |-- response                统一序列化写出
  |-- Logger / Recovery       内置中间件
  |-- SSE                     事件流写出与心跳
  |-- WebSocket (RFC 6455)    握手、帧编解码、消息重组
```

`Application` 本身实现了 `http.Handler` 接口 (即 `ServeHTTP` 方法), 因此既能作为 `http.Server` 的 Handler 使用, 也能直接在 `httptest` 中被 `httptest.NewServer` 或 `httptest.NewRecorder` 驱动。所有 Go 模块位于仓库 `libs/` 之下, `yukino_http` 是独立模块, 仅依赖标准库。

## 请求生命周期与洋葱模型

一次请求的处理路径如下:

```text
http.Server
  -> Application.ServeHTTP
       -> 遍历 app.routers, 收集所有前缀匹配的分组中间件
       -> router.handle(ctx, middlewares)
            -> getRoute(method, path) 命中 trie 叶节点 -> 提取 Params
            -> compose(middlewares, handler)(ctx)   洋葱式执行
            -> ctx.respond()                        统一写出
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

重复调用 `next()` 会 panic, 而不是返回错误; 这个 panic 会沿栈向上传播, 由 Recovery 中间件转成 500。因此建议把 Recovery 放在洋葱链的最外层 (靠近 `Use` 的第一次调用), 这样它能覆盖所有内层中间件与 handler 的 panic。

执行顺序以 `[Logger, Recovery, Auth]` + handler 为例: 进入阶段为 Logger → Recovery → Auth → handler, 退出阶段为 Auth → Recovery → Logger。Logger 因此能在 `next()` 返回后读到最终状态码并记录耗时; Recovery 能在 `next()` 返回后捕获任何内层 panic。

分组中间件的收集发生在一个循环里, 遍历顺序就是注册顺序: 根 Router 的中间件先入列, 之后创建的子 Router 依次追加。前缀匹配使用 `matchRouterPath`, 因此 `/api` 分组的中间件只会作用于 `/api` 与 `/api/...`, 不会误伤 `/apikeys`。

## 延迟响应机制

中间件执行期间, `Context` 中的 `Status`、`Body`、`headers` 都只是待写出的状态; 只有 `respond()` 被调用时才真正触碰 `http.ResponseWriter`。这套语义由几个标志位协同实现:

| 字段        | 作用                                                                                  |
| ----------- | ------------------------------------------------------------------------------------- |
| `statusSet` | 标记状态码是否被用户显式设置 (`SetStatus` / `Throw` / `Redirect` / `SSE` / `Upgrade`) |
| `flushed`   | 标记响应是否已被接管 (SSE、WebSocket、静态文件), `respond()` 见到即直接返回           |
| `headers`   | 延迟响应头缓冲, `Set` 以 `http.CanonicalHeaderKey` 规范化键名                         |

状态码自动提升模拟了 Koa 的语义: `Context` 初始 Status 为 404, 一旦设置了 Body 且未显式设置状态码, 就提升为 200。`JSON`、`String`、`Data`、`HTML` 都会调用 `promoteStatus`, 因此"设置了 body 就等于 200"对整个洋葱链可见, 而不是等到最后才决定。

`respond()` 按 Body 的静态类型分发序列化方式:

| Body 类型     | 写出方式                     | 默认 Content-Type          |
| ------------- | ---------------------------- | -------------------------- |
| `htmlPayload` | `html/template` 渲染命名模板 | `text/html`                |
| `[]byte`      | 原样写出                     | 由 `ctx.Type` 决定, 可为空 |
| `string`      | 原样写出                     | `text/plain`               |
| `io.Reader`   | `io.Copy` 流式拷贝           | 由 `ctx.Type` 决定         |
| 其它          | `json.Marshal`               | `application/json`         |

几个边界条件值得注意:

- 若用户通过 `ctx.Set("Content-Type", ...)` 设置了响应头, 它会在推断默认值之前被刷入 `ResponseWriter`, 从而优先于框架推断的类型, 也优先于 SSE 的默认头。
- 204、205、304 这些不允许携带 body 的状态码会强制清空 Body, 并删除 Content-Type、Content-Length、Transfer-Encoding 三个头。
- JSON 序列化失败时, 直接写 500 与 `{"message":"Internal Server Error"}`, 不再二次尝试。
- 未加载任何 HTML 模板却调用 `HTML()` 时, 写出 500 与一段提示, 而不是返回错误。

## Trie 路由

路由树按 URL 路径段 (segment) 而非字符切分, 每个节点保存一段, 叶节点保存完整的注册模式:

```text
/                (root)
  users          part="users"
    |-- :id      part=":id",    isWild=true   pattern="/users/:id"
    |-- list     part="list"                   pattern="/users/list"
  static         part="static"
    |-- *filepath part="*filepath", isWild=true pattern="/static/*filepath"
```

支持三类段: 静态段 (`users`)、参数段 (`:id`, 匹配单段)、通配段 (`*filepath`, 贪婪匹配剩余所有段)。匹配时先尝试精确段, 再尝试通配段; 静态路由因此天然优先于通配路由。搜索的时间复杂度是 O(k·b), k 为路径段数, b 为每层候选子节点数; 常规应用中 b 很小, 近似线性。

注册时会做模式规范化: `parsePattern` 按 `/` 分割并丢弃空段, 因此 `/users`、`/users/`、`//users` 会归并到同一个 key。这避免了"先注册 `/users/`、后注册 `/users`, 前者被静默遮蔽"的问题。`parsePattern` 还会在遇到以 `*` 开头的段时截断后续段, 因为通配段语义上已经吃掉剩余路径。

参数提取发生在命中叶节点之后: 用注册模式的段与实际请求的段逐位对齐, `:` 段取单段值, `*` 段把剩余段用 `/` 拼接。

几个已知边界:

- 同一层可同时注册 `/users/:id` 与 `/users/:name`, 它们是两个不同的通配子节点, 匹配时按插入顺序取第一个能命中叶节点的分支, 行为不确定; 应在应用层避免这种冲突写法。
- 路由注册使用普通 map 与切片, 没有加锁, 因此必须在 `Listen` 之前完成, 这与多数 Go 框架的约定一致。

## 分组 Router 与静态文件

`Router` 保存 prefix、本组中间件、父指针与应用指针。`app.Router("/api")` 会以"父前缀 + 规范化后的新前缀"创建子 Router, 并注册进 `app.routers`。子 Router 注册路由时 pattern 为 `prefix + comp`, 中间件在 `ServeHTTP` 中按前缀边界收集, 因此嵌套分组的中间件会层层叠加。

`normalizePrefix` 保证前缀以 `/` 开头、不以 `/` 结尾, 根前缀归一为空串。若不规范化, `Router("v1")` 注册的路由可经 `parsePattern` 折叠斜杠后访问到 `/v1/...`, 但分组中间件因前缀不含 `/` 而永远不匹配, 出现"路由可达、中间件失效"的隐蔽缺陷。

静态文件服务复用通配路由: `Static("/assets", "public")` 注册 `/*filepath` 并把请求交给 `http.FileServer`。处理流程有几个设计点:

1. 先探测目标是否存在 (`staticFileExists`), 不存在就走正常的 404 延迟响应, 不劫持连接。
2. 文件存在时, 先把手动缓冲的延迟响应头刷入 `ResponseWriter`, 否则上游通过 `ctx.Set` 设置的 CORS 等头会在 `FileServer` 写入后被丢弃。
3. 设置 `flushed = true`, 阻止 `respond()` 二次写出。
4. 用 `statusRecorder` 包装 `ResponseWriter`, 把 `FileServer` 实际写出的状态码回填到 `ctx.Status`, 让 Logger 之类的外层中间件观察到真实状态码。
5. `staticFileExists` 打开文件后立即关闭句柄; 目录只有在包含 `index.html` 时才视为存在, 不暴露目录列表。

## Context API 与统一错误响应

`Context` 同时承载请求信息与延迟响应状态, 对外暴露的读取能力包括 `Get`/`Query`/`Param`/`PostForm`/`FormFile`/`BindJSON`。`State` 是中间件之间的数据通道, 例如鉴权中间件写入 `ctx.State["user"]`, 下游 handler 读取; `Params` 由路由匹配填充。

错误响应统一为 `{message, data}` 结构, 便于前端与成功路径共用同一套解析逻辑:

```go
func (ctx *Context) Throw(status int, msg string) {
    ctx.Status = status
    ctx.statusSet = true
    ctx.Body = H{"message": msg, "data": nil}
}
```

`Throw` 与 `SetStatus` 都会置位 `statusSet`, 从而阻止错误状态码被自动提升为 200。`BindJSON` 使用 `json.NewDecoder` 对请求体做流式解码, 不需要先把整个 body 读进内存; 但它没有对 body 大小设上限, 面向不可信客户端时应在外层加 `http.MaxBytesReader` 之类的限制。

`Redirect` 保留调用方已选择的 3xx 状态码, 未显式设置时默认 302, 并始终写入 `Location` 头; 若 Body 仍为空, 会补一段纯文本提示。

## 内置中间件: Logger 与 Recovery

`Default()` 返回的应用预装了 `Logger()` 与 `Recovery()`。`Logger` 在 `next()` 前记录起始时间, 在 `next()` 后打印状态码、请求 URI 与耗时, 因此它能观察到下游 (包括 `respond` 之前对 Status 的修改) 的最终取值; 耗时精度为整个洋葱链的墙钟时间。

`Recovery` 用 `defer` + `recover` 捕获内层 panic。它有一个重要的例外: 当 panic 值为 `http.ErrAbortHandler` 这个由 `net/http` 内部使用的哨兵错误时, 必须原样重新 panic, 否则会破坏标准库的中止语义 (例如 `httputil.ReverseProxy` 在客户端断开时依赖它静默结束请求)。其余 panic 会被转换为 500 响应, 并打印带栈帧的堆栈: 用固定大小数组 `[32]uintptr` 收集调用者以避免堆分配, 再用 `runtime.CallersFrames` 展开 (能正确处理被内联的函数帧)。

转换为 500 时, Recovery 会重置状态: 置位 `statusSet`、清空 `Type`、重建 `headers`、把 Body 换成 `{"message":"Internal Server Error"}`。重建 headers 是为了丢弃 panic 前可能已写入的不完整响应头 (例如只设了一半的 CORS 头)。

## SSE (Server-Sent Events)

`ctx.SSE()` 是事件流的入口。它把连接状态切换为"已接管": 置 `flushed = true`、Status 为 200、`statusSet = true`, 写入 SSE 标准头 (`Content-Type: text/event-stream`、`Cache-Control: no-cache`、`Connection: keep-alive`), 然后刷入延迟响应头并显式 `WriteHeader(200)`。延迟响应头在标准头之后刷入, 因此同名 key 会覆盖框架的默认值。`flusher` 由类型断言获得, 若底层 `ResponseWriter` 不实现 `http.Flusher`, 刷新会退化为空操作。

`SSEWriter` 的事件写出方法 (Event/Data/JSON/ID/Retry/Comment 及心跳) 都持有同一个 `sync.Mutex`, 因此多个 goroutine 可以安全地向同一连接推送事件; `Flush` 只触发底层刷新, 不写事件内容, 因此不加锁。能力面如下:

| 方法                 | 写出内容                            | 说明                         |
| -------------------- | ----------------------------------- | ---------------------------- |
| `Event(event, data)` | `event:` + 多行 `data:` + 空行      | 命名事件                     |
| `Data(data)`         | 多行 `data:` + 空行                 | 默认 message 事件            |
| `JSON(event, obj)`   | 可选 `event:` + 单行 `data: <json>` | 序列化失败时静默返回         |
| `ID(id)`             | `id: <id>`                          | 不追加空行, 归属下一个事件   |
| `Retry(ms)`          | `retry: <ms>` + 空行                | 建议客户端重连间隔           |
| `Comment(text)`      | 每行 `: <text>` + 空行              | 心跳与调试                   |
| `Flush()`            | 触发一次底层刷新                    | 手动控制推送时机             |
| `Done()`             | `data: [DONE]`                      | 对齐 OpenAI 风格流式结束约定 |
| `Closed()`           | 返回请求 Context 的 Done channel    | 供外部等待客户端断开         |
| `Stream(ch)`         | 消费 `<-chan string`, 逐个 `Data`   | 桥接上游流                   |

`writeData` 会把数据按 `\n` 切分, 每行都加 `data: ` 前缀, 最后补一个空行结束事件, 符合 SSE 多行数据的编码要求。

心跳由 `Heartbeat(interval)` 管理: 它启动一个 goroutine 按 `time.Ticker` 周期发送 `: keepalive`, 同时监听客户端断开 (请求 Context 的 Done) 与主动停止信号。返回的停止函数用 `sync.Once` 保证幂等, 并通过 `<-done` 等待 goroutine 完全退出, 不留泄漏。

## WebSocket 握手 (RFC 6455)

`ctx.Upgrade(opts)` 完成握手, 校验顺序如下:

| 步骤 | 校验/动作                                                    | 失败行为                                         |
| ---- | ------------------------------------------------------------ | ------------------------------------------------ |
| 1    | `opts.CheckOrigin` 非 nil 时执行来源校验                     | `Throw(403)`                                     |
| 2    | 方法必须为 GET                                               | `Throw(405)`                                     |
| 3    | `Connection` 头包含 token `upgrade` (大小写不敏感, 逗号分隔) | `Throw(400)`                                     |
| 4    | `Upgrade` 头包含 token `websocket`                           | `Throw(400)`                                     |
| 5    | `Sec-WebSocket-Version` 含 token `13`                        | 回写 `Sec-WebSocket-Version: 13` 并 `Throw(400)` |
| 6    | `Sec-WebSocket-Key` 非空                                     | `Throw(400)`                                     |
| 7    | 按服务端优先级协商子协议                                     | 无匹配则不写协议头                               |
| 8    | `http.NewResponseController(...).Hijack()` 接管连接          | `Throw(500)`                                     |
| 9    | 清空读写 deadline, 计算 Accept Key, 拼接并直接写 101 响应    | 关闭连接并返回错误                               |

为什么用 Hijack 而不是标准 `ResponseWriter`: 升级完成后连接不再是 HTTP 语义, 需要双向、全双工读写帧, 而 `ResponseWriter` 只能写响应。Hijack 把底层 TCP 连接的所有权从 `net/http` 转移到应用层。

Accept Key 遵循 RFC 6455: 将客户端 Key 与固定 GUID `258EAFA5-E914-47DA-95CA-C5AB0DC85B11` 拼接, 做 SHA-1 后 Base64。升级成功后立即置 `flushed = true`、`Status = 101`、`statusSet = true`, 并用 `SetDeadline(time.Time{})` 清掉 HTTP Server 可能遗留的读写超时。

读缓冲区的选择考虑到了 Hijack 时可能已有缓冲数据: 若 `bufio.Reader` 中还有未读字节, 必须直接复用它, 否则会丢失 HTTP 请求尾部; 否则在缓冲区足够大时复用, 过小时新建一个指定大小的 reader。

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
2. opcode 仅允许 continuation、text、binary、close、ping、pong。
3. 控制帧必须 FIN=1 且 payload 不超过 125 字节。
4. 客户端到服务端的帧必须带 mask, 防止代理缓存投毒。
5. 单帧长度不得超过 `messageLimit()` (默认 65536 字节, 由 `MaxMessageSize` 覆盖)。
6. 读取后按 4 字节 mask key 循环异或解掩码。

`readMessage` 负责分片重组, 规则与 RFC 6455 5.4 一致: continuation 帧必须跟在数据帧之后; 分片进行中不得出现新的数据帧; 分片之间允许插入控制帧, 控制帧立即返回给调用者处理; 重组后的总长度同样受 `messageLimit()` 约束。写方向 `writeFrame` 始终置 FIN 且不做分片, 并按 payload 长度选择 7/16/64 位长度编码; 服务端到客户端的帧按规范不加 mask。

消息消费有两种模式:

| 模式     | 接口                            | 行为                                                                                                                                |
| -------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 拉取式   | `ReadMessage()` / `ReadJSON(v)` | 持读锁, 自动回 Pong、吞掉 Pong, 收到 Close 时回写 Close 并返回 `ErrWSClosed`; `ReadJSON` 是 `ReadMessage` + JSON 反序列化的便捷封装 |
| 事件驱动 | `Listen()`                      | 阻塞读循环, 分发到 OnMessage/OnClose/OnError/OnPing/OnPong, Ping 自动回 Pong                                                        |

写出 API 包括 `WriteMessage`、`WriteJSON`、`Send`、`WriteText`、`WriteBinary`、`Ping`、`Close`、`CloseWithMessage`, 以及 `SetReadDeadline`/`SetWriteDeadline`/`NetConn`。`Heartbeat(interval)` 周期发送 Ping 帧并返回幂等停止函数, 与 SSE 心跳同构, 但监听的是连接自身的 `closed` channel。

## 并发模型与安全约束

| 组件                 | 同步手段                     | 允许的并发使用方式                                                |
| -------------------- | ---------------------------- | ----------------------------------------------------------------- |
| `WSConn`             | `writeMu` + `readMu`         | 一个 goroutine 读、另一个写; 多个 goroutine 写由 `writeMu` 串行化 |
| `WSConn` 生命周期    | `closed chan` + `sync.Once`  | `Close` 幂等; `Closed()` 供外部 `select` 等待                     |
| `SSEWriter`          | `sync.Mutex`                 | 多 goroutine 并发推送事件                                         |
| 心跳                 | `sync.Once` + `done` channel | 停止函数可重复调用, 且会等待 goroutine 退出                       |
| `Application` 路由表 | 无锁                         | 注册必须在 `Listen`/`Serve` 之前完成, 之后只读                    |

`WSConn.handleError` 在连接已被本地或对端关闭时不会触发 `OnError`, 因为此时尾随的读错误 ("use of closed network connection") 不是应用层错误。`Close`/`CloseWithMessage` 先关闭 `closed` channel 再写 Close 帧, 保证关闭广播与帧写出都不会重复。

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

由于 `Listen` 只封装了明文的 `ListenAndServe`, 包外无法访问未导出的 `server`, 因此当前不提供内置的 TLS/HTTP2 监听入口; 需要在框架层面新增导出方法或在 `http.Server` 层自行扩展。

## 可测试性与可观测性

- `Application` 实现 `http.Handler`, 可以直接被 `httptest.NewRecorder` 或 `httptest.NewServer` 驱动, 单元测试无需真实端口。
- 每个组件都有对应的单元测试覆盖: Context 辅助方法、响应序列化的状态提升与空状态码处理、Trie 匹配与静态优先、SSE 多行数据/JSON/注释/Stream/自定义头/心跳并发/Closed、WebSocket 握手与回显、分片重组、拒绝未掩码帧、版本校验、子协议协商、Close payload 解析。
- 可观测性目前依赖 `log.Printf`: Logger 输出状态码与耗时, Recovery 输出带栈帧的 panic 详情, 路由注册时也会打印注册的 method 与 pattern。框架没有内建结构化日志、请求 ID 或指标 (metrics) 集成点。

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

## 性能与资源约束

| 关注点           | 现状                                  | 影响                                         |
| ---------------- | ------------------------------------- | -------------------------------------------- |
| Context 分配     | 每请求新建, 无对象池                  | 高 QPS 下 GC 压力高于使用 `sync.Pool` 的框架 |
| 路由匹配         | 每层线性扫描 children 切片            | 路由数量极大时可考虑 map 索引或 radix tree   |
| 路由冲突         | 不检测 `:id`/`:name` 冲突             | 需要应用层规避                               |
| 请求体大小       | `BindJSON` 无上限                     | 面向不可信客户端需自行限制                   |
| 静态文件         | 每次请求先探测文件存在性              | 多一次 stat, 换来正确的 404 与目录列表防护   |
| WebSocket 写     | 一次性 `conn.Write`, 无写缓冲与写超时 | 慢客户端可能阻塞写 goroutine                 |
| WebSocket 帧上限 | 单帧与重组消息共用同一上限            | 无法分别为两者配置                           |
| SSE              | 有 flusher 检测, 无自动重连 ID 管理   | 断线续传需业务层实现                         |

## 与 Gin / Echo 的对比

| 维度         | yukino_http                   | Gin         | Echo        |
| ------------ | ----------------------------- | ----------- | ----------- |
| 中间件模型   | 洋葱模型 (Koa 风格)           | 洋葱模型    | 洋葱模型    |
| 响应方式     | 延迟响应                      | 即时写入    | 即时写入    |
| 路由         | 按段 Trie                     | Radix Tree  | Radix Tree  |
| 第三方依赖   | 无                            | 少量        | 少量        |
| WebSocket    | 内置 RFC 6455                 | 需第三方    | 需第三方    |
| SSE          | 内置                          | 需自行实现  | 需自行实现  |
| Context 复用 | 无                            | `sync.Pool` | `sync.Pool` |
| 流式语义     | 需要 `flushed` 绕过统一序列化 | 直接写      | 直接写      |

延迟响应让上游中间件拥有对最终响应的最后修改权, 这正是 Koa 风格的表达力所在; 代价是框架必须为流式场景维护一套旁路机制 (SSE/WebSocket/静态文件的 `flushed`), 并且无法像即时写入的框架那样边算边发。

## 零依赖的取舍与已知边界

自行实现 WebSocket 与 SSE 换来了零供应链依赖, 代价是与成熟的 `gorilla/websocket` 相比存在若干能力缺口:

- 不支持 permessage-deflate 消息压缩, RSV1 非零一律拒绝。
- 不自动管理写超时, 慢客户端的写阻塞需要业务层用 `SetWriteDeadline` 自行兜底。
- 没有 `NextWriter` 式的分片写入, `WriteMessage` 一次性构造并写出整帧。
- 单帧上限与重组消息上限共用同一个 `messageLimit()`, 无法独立配置。
- 发送 Close 帧后不等待对端回复即关闭连接, 没有 Close 握手超时。
- 不处理 TLS、代理头与 `X-Forwarded-For`, 这些交给底层 `net.Conn` 与部署层。

SSE 侧则没有自动重连 ID 管理、订阅广播或连接池, 这些语义需要业务层基于 `ID()`、`Closed()` 与 `Stream()` 自行组合。

## 适用场景与选型建议

适合使用 yukino_http 的场景:

- 需要零第三方依赖、希望完全掌控供应链的小型或内部服务。
- 需要把响应包装、错误统一化、鉴权等横切逻辑放在洋葱链任意位置, 并希望在 `next()` 返回后仍能改写响应。
- 需要内置的 SSE 或 WebSocket 而不想引入额外库。
- 用于学习 HTTP 框架内部机制。

不适合或需要补强的场景:

- 需要极高 QPS 与稳定低延迟的公开 API 网关: 缺少 Context 池、指标与结构化日志, 建议使用成熟框架。
- 需要 HTTP/2、TLS、请求体限额、permessage-deflate 压缩、写超时或 Close 握手超时的场景, 当前实现未覆盖, 需要自行扩展。
- 需要大量路由且对匹配延迟敏感的场景: 按段 Trie 的每层线性扫描会成为瓶颈。

相关主题: 框架的内置能力已被同仓库多个模块直接复用 —— [yukino_cache](yukino-cache) 的实时仪表盘就是一个挂载在本框架上的 WebSocket 端点, 用 `ctx.Upgrade` 完成握手、用 `WSConn` 的心跳与 JSON 写出推送缓存快照; [yukino_taskflow](yukino-go-taskflow) 用本框架组装 API 路由与中间件链; [yukino_agent_proxy](yukino-agent-proxy) 用 `New()` 加 `Recovery()` 搭建本地控制面。接口、方法集与并发原语等语言层基础见 [Go 语言核心](go)。
