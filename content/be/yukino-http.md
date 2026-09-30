---
title: "yukino_http 技术笔记"
---

> 本机器路径: `$HOME/github/yukino.go/yukino_http`
> 基于项目 `github.com/hangtiancheng/yukino.go/yukino_http` 源码整理, 覆盖洋葱模型中间件、延迟响应、Trie 路由、SSE、WebSocket (RFC 6455) 等核心主题.

## 项目整体架构与设计理念

请介绍 yukino_http 的整体架构, 它的核心设计理念是什么?

A: yukino_http 是一个受 Koa.js 启发的 Go HTTP 框架, 核心设计理念有三:

1. 洋葱模型中间件: 所有请求处理 (包括路由 handler) 统一为 `Middleware` 类型 `func(ctx *Context, next func())`, 通过 `compose` 函数组合成链式调用.
2. 延迟响应 (Deferred Response): 中间件执行期间不直接写 HTTP 响应, 而是将 Status、Body、Headers 暂存在 Context 中. 整条链执行完毕后, 由 `ctx.respond()` 统一序列化写出.
3. 零外部依赖: 仅使用 Go 标准库, WebSocket 和 SSE 均为手写实现.

架构分层:

```
Application (yukino.go)
  ├── router (router.go + trie.go)    -- 路由注册与匹配
  ├── Router (group.go)            -- 嵌套 Router 实现路由分组、前缀、静态文件
  ├── Context (context.go)            -- 请求上下文
  ├── Response (response.go)          -- 延迟响应序列化
  ├── Logger / Recovery               -- 内置中间件
  ├── SSE (sse.go)                    -- Server-Sent Events
  └── WebSocket (websocket.go)        -- RFC 6455 实现
```

请求生命周期:

```
http.Server -> Application.ServeHTTP
  -> 收集匹配前缀的中间件
  -> router.handle(ctx, middlewares)
    -> compose(middlewares, handler) 执行洋葱模型
    -> ctx.respond() 写出响应
```

`Application` 实现了 `http.Handler` 接口 (`ServeHTTP` 方法) , 因此可以直接作为 `http.Server` 的 Handler 使用.

---

## 洋葱模型中间件机制 (compose)

请详细解释 compose 函数的实现原理, 它如何保证洋葱模型的执行顺序? 如何防止 next() 被多次调用?

A: `compose` 函数位于 `yukino.go:132-153`, 核心实现:

```go
func compose(middlewares []Middleware, final Middleware) func(ctx *Context) {
    return func(ctx *Context) {
        index := -1
        var dispatch func(i int)
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
        dispatch(0)
    }
}
```

关键设计点:

1. 闭包递归: `dispatch` 是一个递归闭包, 每次调用 `next()` 实际上是调用 `dispatch(i+1)`, 形成洋葱的"进入"阶段. 当最内层执行完毕, 调用栈逐层返回, 形成"退出"阶段.

2. 防重入保护: `index` 变量记录当前已 dispatch 到的位置. 如果某个中间件在 `next()` 返回后再次调用 `next()`, 此时 `i <= index` 成立, 触发 panic. 这与 koa-compose 的行为一致 (koa 中是 reject Promise) .

3. final 参数: 路由 handler 作为 `final` 传入, 在所有中间件执行完后调用. final 收到的 `next` 是空函数 `func() {}`, 防止 handler 内部误调 next.

4. 执行顺序示例: 对于 `[Logger, Recovery, Auth]` + handler:
   - 进入: Logger.before -> Recovery.before -> Auth.before -> handler
   - 退出: Auth.after -> Recovery.after -> Logger.after

这使得 Logger 可以在 `next()` 后记录耗时, Recovery 可以在 `next()` 后捕获 panic.

---

## 延迟响应 (Deferred Response) 机制

什么是延迟响应? 为什么选择这种设计? respond() 如何处理不同类型的 Body?

A: 延迟响应是 Koa.js 的核心设计: 中间件不直接操作 `http.ResponseWriter`, 而是设置 `ctx.Status`、`ctx.Body`、`ctx.headers`, 最终由 `respond()` 统一写出.

设计优势:

- 上游中间件在 `next()` 返回后可以检查/修改下游设置的响应 (如统一包装、压缩、添加 header)
- 避免"header 已发送"的不可逆问题
- 错误处理中间件可以覆盖之前设置的 Body

Status 自动提升 (`response.go:34-38`) :

```go
func (ctx *Context) promoteStatus() {
    if !ctx.statusSet && ctx.Status == http.StatusNotFound {
        ctx.Status = http.StatusOK
    }
}
```

默认 Status 为 404. 当调用 `ctx.JSON()`、`ctx.String()` 等方法设置 Body 时, 如果用户未显式调用 `SetStatus()`, 则自动提升为 200. 这模拟了 Koa 中"设置 body 即意味着 200"的语义.

respond() 的类型分发 (`response.go:93-130`) :

```go
switch body := ctx.Body.(type) {
case htmlPayload:   // 模板渲染
case []byte:        // 原始字节
case string:        // 纯文本
case io.Reader:     // 流式读取
default:            // JSON 序列化
}
```

空状态码处理: 对于 204/205/304, 强制清除 Body 和 Content 相关 header, 符合 HTTP 规范.

flushed 标志: SSE 和 WebSocket 场景中, 连接已被接管 (hijack 或 header 已发送) , `ctx.flushed = true` 使 `respond()` 直接返回, 避免重复写入.

---

## Trie 路由树的设计与实现

路由匹配使用的 Trie 树是如何设计的? 支持哪些路由模式? 时间复杂度如何?

A: 路由树实现在 `trie.go`, 是一棵按 URL path 段 (segment) 分割的前缀树.

节点结构:

```go
type node struct {
    pattern  string    // 完整注册模式 (仅叶节点非空)
    part     string    // 当前段, 如 "users"、":id"、"*filepath"
    children []*node
    isWild   bool      // part 以 ':' 或 '*' 开头
}
```

支持的路由模式:

- 静态段: `/users/list`
- 参数段: `/users/:id` (匹配单段)
- 通配段: `/static/*filepath` (匹配剩余所有段)

插入 (`insert`) : 递归按 parts 逐层插入, 到达末尾时设置 `n.pattern`.

搜索 (`search`) :

1. 优先精确匹配 (`child.part == part`)
2. 其次通配匹配 (`child.isWild`)
3. 遇到 `*` 前缀的节点立即返回 (贪婪匹配剩余路径)

时间复杂度: O(k), k 为 URL 段数. 每层最多遍历 children 数组 (精确 + 通配) , 实际路由数量下 children 很少, 近似 O(1) 每层.

与 httprouter 的 radix tree 对比: yukino_http 使用按段分割的 trie, 而非按字符的 radix tree. 优势是实现简单、参数提取直观; 劣势是路由数量极大时内存占用略高 (每段一个节点 vs 路径压缩) . 对于常规 Web 应用 (几十到几百条路由) , 性能差异可忽略.

---

## 路由注册与匹配的细节问题

addRoute 中为什么要做 pattern 规范化? getRoute 如何提取路径参数?

A: Pattern 规范化 (`router.go:54-66`) :

```go
parts := parsePattern(pattern)
pattern = "/" + strings.Join(parts, "/")
key := method + "-" + pattern
```

`parsePattern` 按 `/` 分割并过滤空段, 遇到 `*` 开头段则截断后续. 规范化确保 `/users`、`/users/`、`//users` 映射到同一个 key.

如果不做规范化, 先注册 `/users/` 再注册 `/users`, 两次注册走同一条 trie 路径 (段都是 `users`) , 后一次会把 trie 叶节点的 pattern 覆盖为 `/users`; 查找时按最终 pattern 拼 key `GET-/users`, 命中的是后注册的 handler——先注册的 handler 永远不会被命中, 被静默遮蔽.

参数提取 (`router.go:68-92`) :

```go
parts := parsePattern(n.pattern)  // 注册时的模式段
for index, part := range parts {
    if part[0] == ':' {
        params[part[1:]] = searchParts[index]
    }
    if part[0] == '*' && len(part) > 1 {
        params[part[1:]] = strings.Join(searchParts[index:], "/")
        break
    }
}
```

用注册模式的段与实际请求的段逐位对比: `:` 段提取单段值, `*` 段提取剩余所有段拼接.

parsePattern 的 `*` 截断: `/static/*filepath/extra` 中 `*filepath` 之后的段被丢弃, 因为通配符语义上匹配所有剩余路径.

---

## Router 分组与前缀中间件

Router 分组如何实现前缀隔离和中间件作用域? matchRouterPath 的边界匹配为什么重要?

A: 分组结构 (`group.go`) :

```go
type Router struct {
    prefix      string
    middlewares []Middleware
    parent      *Router
    app         *Application
}
```

`app.Router("/api")` 创建子 Router, 其 prefix 为父 prefix + 规范化后的新前缀. 子 Router 注册路由时, pattern = prefix + comp.

中间件收集 (`yukino.go:120-130`) :

```go
func (app *Application) ServeHTTP(w http.ResponseWriter, req *http.Request) {
    var middlewares []Middleware
    for _, r := range app.routers {
        if matchRouterPath(req.URL.Path, r.prefix) {
            middlewares = append(middlewares, r.middlewares...)
        }
    }
    // ...
}
```

遍历所有已注册的 Router, 将前缀匹配的 Router 的中间件按注册顺序收集. 这意味着嵌套分组的中间件会层层叠加.

matchRouterPath 边界匹配 (`group.go:186-194`) :

```go
func matchRouterPath(requestPath, routerPrefix string) bool {
    if routerPrefix == "" || routerPrefix == "/" {
        return true
    }
    if !strings.HasPrefix(requestPath, routerPrefix) {
        return false
    }
    return len(requestPath) == len(routerPrefix) || requestPath[len(routerPrefix)] == '/'
}
```

必须检查前缀后的字符是 `/` 或已到末尾. 否则 prefix `/api` 会错误匹配 `/apikeys`, 导致 `/apikeys` 请求被施加 `/api` 分组的中间件.

normalizePrefix (`group.go:50-64`) : 确保前缀以 `/` 开头、不以 `/` 结尾 (根 `/` 转为空串) . 注释说明了不做规范化会导致 trie 注册可达但中间件永远不匹配的 bug.

---

## Context 设计与 Koa 风格对比

Context 的设计有哪些 Koa 风格的特征? State 和 Params 的用途是什么? Throw 的设计意图?

A: Context 结构 (`context.go:33-57`) :

```go
type Context struct {
    Request *http.Request
    Writer  http.ResponseWriter
    Path    string
    Method  string
    Status  int
    Body    any
    Type    string
    State   map[string]any
    Params  map[string]string
    headers map[string]string
    app     *Application
    flushed bool
    statusSet bool
}
```

Koa 风格特征:

- `State`: 等价于 Koa 的 `ctx.state`, 用于中间件间传递数据 (如认证中间件写入 `ctx.State["user"]`, 下游 handler 读取)
- `Body` 为 `any`: 等价于 Koa 的 `ctx.body`, 支持任意类型, 由 respond() 根据类型分发序列化
- `Throw(status, msg)`: 等价于 Koa 的 `ctx.throw()`, 设置状态码并生成错误 Body

Throw 的统一错误格式 (`context.go:71-77`) :

```go
func (ctx *Context) Throw(status int, msg string) {
    ctx.Status = status
    ctx.statusSet = true
    ctx.Body = H{"message": msg, "data": nil}
}
```

错误响应包含 `"data": nil`, 与成功路径 `ctx.JSON()` 返回的 `{message, data}` 结构对齐, 前端可以统一解析.

statusSet 标志: 区分"用户显式设置的状态码"和"默认 404". `SetStatus()` 和 `Throw()` 设置 `statusSet = true`, 防止 `promoteStatus()` 将其覆盖为 200.

BindJSON (`context.go:108-111`) : 使用 `json.NewDecoder` 流式解码, 比 `io.ReadAll` + `json.Unmarshal` 更省内存 (不需要先读全部 body 到内存) .

---

## Recovery 中间件与 panic 恢复

Recovery 中间件如何工作? 为什么要特殊处理 http.ErrAbortHandler? trace 函数的实现细节?

A: Recovery 实现 (`recovery.go:49-70`) :

```go
func Recovery() Middleware {
    return func(ctx *Context, next func()) {
        defer func() {
            if err := recover(); err != nil {
                if err == http.ErrAbortHandler {
                    panic(err)  // 重新抛出
                }
                // 记录堆栈、设置 500 响应
            }
        }()
        next()
    }
}
```

ErrAbortHandler 特殊处理: `net/http` 内部使用 `http.ErrAbortHandler` 这个 sentinel error 来中止请求处理 (如 `httputil.ReverseProxy` 检测到客户端断开时) . 如果 Recovery 将其转为 500 响应, 会破坏标准库的中止语义. 因此必须重新 panic, 让 `net/http` 的 Server 正确处理.

panic 后的状态重置:

```go
ctx.Status = http.StatusInternalServerError
ctx.statusSet = true
ctx.Type = ""
ctx.headers = make(map[string]string)  // 清除已缓冲的 header
ctx.Body = H{"message": "Internal Server Error"}
```

清除 headers 是因为 panic 前可能已设置了不完整的 header (如部分 CORS header) , 保留它们可能导致不一致的响应.

trace 函数 (`recovery.go:31-47`) :

```go
func trace(message string) string {
    var pcs [32]uintptr
    n := runtime.Callers(3, pcs[:])  // 跳过 runtime.Callers、trace、defer 帧
    frames := runtime.CallersFrames(pcs[:n])
    // 遍历输出 file:line
}
```

使用固定大小数组 `[32]uintptr` 避免堆分配. `runtime.CallersFrames` 是 Go 1.7+ 推荐的 API, 能正确处理内联函数的栈帧.

---

## 静态文件服务实现

Static 方法如何实现静态文件服务? 为什么需要 statusRecorder? staticFileExists 的设计考量?

A: 注册 (`group.go:111-115`) :

```go
func (r *Router) Static(relativePath string, root string) {
    handler := r.createStaticHandler(relativePath, http.Dir(root))
    urlPattern := path.Join(relativePath, "/*filepath")
    r.Get(urlPattern, handler)
}
```

利用通配路由 `/*filepath` 捕获文件路径, 再交给 `http.FileServer` 处理.

createStaticHandler (`group.go:117-136`) :

```go
fileServer := http.StripPrefix(absolutePath, http.FileServer(fs))
return func(ctx *Context, next func()) {
    file := ctx.Param("filepath")
    if !staticFileExists(fs, file) {
        ctx.Status = http.StatusNotFound
        ctx.statusSet = true
        return
    }
    // 先刷新延迟 header
    for k, v := range ctx.headers {
        header.Set(k, v)
    }
    ctx.flushed = true
    fileServer.ServeHTTP(&statusRecorder{...}, ctx.Request)
}
```

关键设计:

1. 先检查文件存在性: 不存在时走正常的 404 延迟响应流程, 不 hijack 连接
2. 刷新延迟 header: 上游中间件 (如 CORS) 通过 `ctx.Set()` 设置的 header 必须在 FileServer 写入前刷到 ResponseWriter
3. 设置 flushed = true: 阻止 `respond()` 再次写入

statusRecorder (`group.go:164-184`) :

```go
type statusRecorder struct {
    http.ResponseWriter
    status *int
    wrote  bool
}
```

FileServer 内部直接调用 `WriteHeader()`, 绕过了 Context 的延迟响应. statusRecorder 拦截 `WriteHeader` 和 `Write` 调用, 将实际状态码同步回 `ctx.Status`, 使 Logger 等后续中间件能记录正确的状态码.

staticFileExists (`group.go:141-160`) :

- 打开文件后立即关闭 (避免 fd 泄漏)
- 目录仅在包含 `index.html` 时视为存在 (匹配 koa-static 行为)
- 不暴露目录列表 (安全考量)

---

## SSE (Server-Sent Events) 实现

SSE 实现如何保证线程安全? Heartbeat 的 goroutine 生命周期如何管理? Stream 方法的设计?

A: SSEWriter 初始化 (`sse.go:38-51`) :

```go
func (ctx *Context) SSE() *SSEWriter {
    flusher, _ := ctx.Writer.(http.Flusher)
    ctx.flushed = true
    ctx.Status = http.StatusOK
    ctx.statusSet = true
    ctx.Writer.Header().Set("Content-Type", "text/event-stream")
    ctx.Writer.Header().Set("Cache-Control", "no-cache")
    ctx.Writer.Header().Set("Connection", "keep-alive")
    for k, v := range ctx.headers {
        ctx.Writer.Header().Set(k, v)
    }
    ctx.Writer.WriteHeader(http.StatusOK)
    return &SSEWriter{ctx: ctx, flusher: flusher}
}
```

设置 `flushed = true` 阻止 `respond()` 干预; 同时设置 `Status` 和 `statusSet` 使状态码不被后续逻辑覆盖. 类型断言获取 `http.Flusher` (`net/http` 的 ResponseWriter 实现了此接口) . 设置完三个 SSE 标准 header 之后、`WriteHeader(200)` 之前, 把上游中间件通过 `ctx.Set()` 缓冲的延迟 header 刷入 ResponseWriter (如 CORS header) ; 由于延迟 header 后写, 同名 key (如上游设置过的 Content-Type) 会覆盖 SSE 的默认值.

线程安全: 每个写入方法 (Event、Data、JSON、ID、Retry、Comment) 都持有 `sync.Mutex`:

```go
func (w *SSEWriter) Event(event string, data string) {
    w.mu.Lock()
    fmt.Fprintf(w.ctx.Writer, "event: %s\n", event)
    w.writeData(data)
    w.flush()
    w.mu.Unlock()
}
```

这允许多个 goroutine 并发向同一 SSE 连接推送事件 (如多个 worker 向同一客户端推送进度) .

writeData 的多行处理 (`sse.go:160-166`) :

```go
func (w *SSEWriter) writeData(data string) {
    lines := strings.SplitSeq(data, "\n")
    for line := range lines {
        fmt.Fprintf(w.ctx.Writer, "data: %s\n", line)
    }
    fmt.Fprint(w.ctx.Writer, "\n")
}
```

SSE 协议要求多行数据每行都以 `data: ` 前缀, 最后以空行结束事件.

Heartbeat 生命周期管理 (`sse.go:106-132`) :

```go
func (w *SSEWriter) Heartbeat(interval time.Duration) func() {
    stop := make(chan struct{})
    done := make(chan struct{})
    go func() {
        defer close(done)
        ticker := time.NewTicker(interval)
        defer ticker.Stop()
        for {
            select {
            case <-ticker.C:
                // 发送 ": keepalive\n\n"
            case <-w.ctx.Request.Context().Done():
                return  // 客户端断开
            case <-stop:
                return  // 主动停止
            }
        }
    }()
    var stopOnce sync.Once
    return func() {
        stopOnce.Do(func() { close(stop) })
        <-done  // 等待 goroutine 退出
    }
}
```

返回的 stop 函数使用 `sync.Once` 保证幂等, `<-done` 确保 goroutine 完全退出 (无泄漏) . select 有三条路径: ticker 触发发送心跳、客户端断开 (Request Context Done) 退出循环、主动调用 stop 退出循环.

Stream 方法 (`sse.go:138-150`) : 阻塞式消费 channel, 适合将上游 channel (如 LLM 流式输出) 直接桥接到 SSE:

```go
func (w *SSEWriter) Stream(ch <-chan string) {
    for {
        select {
        case msg, ok := <-ch:
            if !ok { return }
            w.Data(msg)
        case <-w.ctx.Request.Context().Done():
            return
        }
    }
}
```

---

## WebSocket 实现 (RFC 6455)

WebSocket 握手过程如何实现? 为什么选择 Hijack 而非标准 ResponseWriter? CheckOrigin 的安全意义?

A: 握手流程 (`websocket.go:91-178`) :

1. 验证请求: 检查 Method == GET、Connection: upgrade、Upgrade: websocket、Sec-WebSocket-Version: 13、Sec-WebSocket-Key 非空
2. 子协议协商: `negotiateSubprotocol` 按服务端优先级匹配客户端提供的协议列表
3. Hijack 连接: `http.NewResponseController(ctx.Writer).Hijack()` 获取底层 `net.Conn`
4. 构造 101 响应: 手动拼接 HTTP 响应头 (包含 `Sec-WebSocket-Accept`)
5. 写入握手响应: 直接 `conn.Write(p)`

为什么用 Hijack: WebSocket 升级后, 连接不再是 HTTP 语义——需要双向、全双工通信. 标准 `http.ResponseWriter` 只能写响应, 无法读取后续帧. Hijack 将底层 TCP 连接的所有权从 `net/http` 转移到应用层.

Accept Key 计算 (`websocket.go:541-546`) :

```go
func computeAcceptKey(key string) string {
    h := sha1.New()
    h.Write([]byte(key))
    h.Write([]byte(wsGUID))  // "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
    return base64.StdEncoding.EncodeToString(h.Sum(nil))
}
```

RFC 6455 规定: 将客户端 Key 与固定 GUID 拼接后 SHA-1 再 Base64.

CheckOrigin 安全意义: WebSocket 不受同源策略限制 (浏览器不会自动拦截跨域 WS 请求) . 如果不校验 Origin, 恶意网站可以建立到服务器的 WebSocket 连接, 利用用户的 Cookie 进行 CSRF 攻击. 默认不设置 CheckOrigin 时跳过检查 (开发便利) , 生产环境应配置.

bufio.Reader 复用 (`websocket.go:139-150`) :

```go
if brw.Reader.Buffered() > 0 {
    br = brw.Reader  // 有未读数据, 必须复用
} else if brw.Reader.Size() >= readBufSize {
    br = brw.Reader  // 缓冲区够大, 复用
} else {
    br = bufio.NewReaderSize(conn, readBufSize)  // 新建更大缓冲区
}
```

如果 Hijack 时 bufio.Reader 中已有缓冲数据 (HTTP 请求的尾部) , 必须复用它, 否则会丢失数据.

---

## WebSocket 帧解析与消息重组

readFrame 如何解析 WebSocket 帧? readMessage 如何处理分片消息? 有哪些安全校验?

A: 帧格式 (RFC 6455 Section 5.2) :

```
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-+-+-+-+-------+-+-------------+-------------------------------+
|F|R|R|R| opcode|M| Payload len |    Extended payload length    |
|I|S|S|S|  (4)  |A|     (7)     |             (16/64)           |
|N|V|V|V|       |S|             |                               |
| |1|2|3|       |K|             |                               |
+-+-+-+-+-------+-+-------------+-------------------------------+
|     Masking-key (0 or 4 bytes)      |     Payload Data ...    |
+-------------------------------------+-------------------------+
```

readFrame 实现 (`websocket.go:378-443`) :

安全校验:

1. RSV1-3 必须为 0: 未协商扩展 (如 permessage-deflate) , 非零则拒绝
2. opcode 合法性: 仅允许 0(continuation)、1(text)、2(binary)、8(close)、9(ping)、10(pong)
3. 控制帧约束: 必须 FIN=1 (不可分片) 、payload <= 125 字节
4. Mask 必须存在: RFC 6455 要求客户端到服务端的帧必须 mask (防止缓存投毒攻击)
5. 最大帧大小: 单帧 payload 不得超过 `messageLimit()` (默认 maxFrameSize = 65536) , 防止内存耗尽攻击

Unmask:

```go
for i := range payload {
    payload[i] ^= maskKey[i%4]
}
```

readMessage 分片重组 (`websocket.go:448-486`) :

```go
func (ws *WSConn) readMessage() (opcode int, payload []byte, err error) {
    var msgType int
    var buf []byte
    for {
        opcode, fin, data, err := ws.readFrame()
        if err != nil { return 0, nil, err }
        switch opcode {
        case CloseMessage, PingMessage, PongMessage:
            return opcode, data, nil  // 控制帧立即返回
        case continuationFrame:
            if msgType == 0 { return 0, nil, ErrWSInvalidFrame }  // 无前导帧
            if len(buf)+len(data) > ws.messageLimit() {
                return 0, nil, ErrWSInvalidFrame  // 重组后超限
            }
            buf = append(buf, data...)
            if fin { return msgType, buf, nil }
        default:  // Text/Binary
            if msgType != 0 { return 0, nil, ErrWSInvalidFrame }  // 分片中途出现新数据帧
            if fin { return opcode, data, nil }  // 未分片, 直接返回
            msgType = opcode
            buf = append(buf, data...)
        }
    }
}
```

关键规则 (RFC 6455 Section 5.4) :

- 分片消息中间可以插入控制帧 (ping/pong/close) , 控制帧立即返回
- continuation 帧必须跟在数据帧之后
- 分片中途不能出现新的数据帧
- 重组后总大小不超过 `messageLimit()` (默认 maxFrameSize = 64KB, 可通过 `UpgradeOptions.MaxMessageSize` 配置)

writeFrame (`websocket.go:488-518`) : 服务端到客户端不 mask (RFC 规定) . 根据 payload 长度选择 7-bit、16-bit、64-bit 长度编码.

---

## 并发安全设计

框架中有哪些并发安全的设计? WSConn 的读写锁如何工作?

A: WSConn 的锁设计 (`websocket.go:68-82`) :

```go
type WSConn struct {
    conn           net.Conn
    br             *bufio.Reader
    writeMu        sync.Mutex   // 写锁
    readMu         sync.Mutex   // 读锁
    closed         chan struct{}
    once           sync.Once
    maxMessageSize int          // 最大消息大小限制
    onMessage      func(...)    // 消息回调
    onClose        func(...)    // 关闭回调
    onError        func(...)    // 错误回调
    onPing         func(...)    // Ping 回调
    onPong         func(...)    // Pong 回调
}
```

- `writeMu`: 保护所有写操作 (WriteMessage、Ping、Close、writeCloseFrame) , 确保帧不会交错写入
- `readMu`: 保护 ReadMessage, 确保分片重组的中间状态不被并发读取破坏
- 读写分离: 一个 goroutine 读、另一个 goroutine 写是安全的 (全双工)
- 事件回调: 支持注册 onMessage/onClose/onError/onPing/onPong 回调, 便于事件驱动风格的业务处理

closed channel + sync.Once:

```go
func (ws *WSConn) Close() error {
    ws.once.Do(func() { close(ws.closed) })
    // ...
}
```

`sync.Once` 保证 `closed` channel 只被关闭一次 (多次 close channel 会 panic) . `Closed()` 方法返回该 channel, 外部可以 `select` 等待连接关闭.

SSEWriter 的 Mutex: 所有写入方法加锁, 支持多 goroutine 并发推送.

Heartbeat 的 sync.Once: stop 函数可被多次调用而不会 panic (重复 close channel) .

Application 层面的隐含约束: 路由注册 (addRoute) 应在 Listen 之前完成. ServeHTTP 中只读访问 router, 无锁. 这是 Go HTTP 框架的常见约定 (Gin 同理) .

---

## 优雅关闭 (Graceful Shutdown)

Application 的 Shutdown 如何实现? 为什么 server 在 New() 中构造而非 Listen() 中?

A: 实现 (`yukino.go:64-74`) :

```go
func (app *Application) Listen(addr string) error {
    app.server.Addr = addr
    return app.server.ListenAndServe()
}

func (app *Application) Shutdown(ctx context.Context) error {
    if app.server == nil {
        return nil
    }
    return app.server.Shutdown(ctx)
}
```

server 在 New() 中构造的原因 (注释 `yukino.go:42-44`) :

```go
// Constructed here (not in Listen) so a concurrent Shutdown never races
// with the server field assignment or silently no-ops before Listen runs.
app.server = &http.Server{Handler: app}
```

如果在 Listen() 中构造 server, 存在竞态:

1. goroutine A 调用 `Listen()`, 正在执行 `app.server = &http.Server{...}`
2. goroutine B 调用 `Shutdown()`, 此时 `app.server` 仍为 nil, 直接返回 nil (静默 no-op)
3. 服务实际未关闭

在 New() 中构造消除了这个竞态窗口.

典型使用模式:

```go
app := yukino.Default()
go app.Listen(":8000")

// 等待信号
sig := make(chan os.Signal, 1)
signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
<-sig

ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
defer cancel()
app.Shutdown(ctx)
```

`http.Server.Shutdown` 会停止接受新连接, 等待已有请求完成 (或 ctx 超时) , 然后返回.

---

## 与 Gin/Echo 等框架的对比

yukino_http 与 Gin、Echo 相比, 设计哲学有何不同? 各自的适用场景?

A:

| 维度       | yukino_http         | Gin                         | Echo       |
| ---------- | ------------------- | --------------------------- | ---------- |
| 中间件模型 | 洋葱模型 (Koa 风格) | 洋葱模型 (类 Koa)           | 洋葱模型   |
| 响应方式   | 延迟响应            | 即时写入                    | 即时写入   |
| 路由       | 按段 Trie           | Radix Tree (httprouter)     | Radix Tree |
| 依赖       | 零依赖              | 少量依赖                    | 少量依赖   |
| WebSocket  | 内置 (RFC 6455)     | 需第三方 (gorilla)          | 需第三方   |
| SSE        | 内置                | 需手动实现                  | 需手动实现 |
| 性能       | 中等                | 高 (sync.Pool 复用 Context) | 高         |

设计哲学差异:

1. 延迟响应 vs 即时写入: yukino_http 的延迟响应允许上游中间件在 `next()` 返回后修改下游设置的响应, 但牺牲了流式写入的灵活性 (SSE/WS 需要 flushed 标志绕过) . Gin 的 `c.JSON()` 立即写入, 更直观但不可逆.

2. 零依赖 vs 生态: yukino_http 手写 WebSocket 和 SSE, 代码量约 760 行 (websocket.go 590 行 + sse.go 172 行), 覆盖了核心场景. Gin 生态依赖 gorilla/websocket 等成熟库, 边界情况处理更完善.

3. Context 复用: Gin 使用 `sync.Pool` 复用 Context 对象减少 GC 压力. yukino_http 每请求新建 Context, 实现简单但在极高 QPS 下 GC 压力更大.

适用场景:

- yukino_http: 学习框架原理、中小型项目、需要 SSE/WS 且不想引入额外依赖
- Gin: 生产环境高并发 API 服务
- Echo: 需要丰富中间件生态的项目

---

## 零依赖设计的取舍

零依赖带来了哪些优势和限制? WebSocket 实现相比 gorilla/websocket 缺少什么?

A: 优势:

- 无供应链风险 (无第三方 CVE 影响)
- 编译产物小, 无版本冲突
- 代码完全可控, 便于调试和定制
- 学习价值: 完整展示 HTTP 框架 internals

限制与缺失 (对比 gorilla/websocket) :

1. 无 permessage-deflate 压缩: RSV1 非零直接拒绝, 不支持消息压缩
2. 无写超时自动管理: 需要用户手动调用 SetWriteDeadline
3. 无并发写缓冲: gorilla 有 `NextWriter` 支持流式写入大消息, yukino_http 的 WriteMessage 是一次性写入
4. maxFrameSize 默认 64KB: 可通过 `UpgradeOptions.MaxMessageSize` 覆盖, 但单帧上限与重组消息上限耦合为同一个 `messageLimit()` 值, 无法独立配置
5. 无 CloseHandler 超时: 发送 Close 帧后不等待对端回复即关闭连接
6. 无 TLS/代理支持: 依赖底层 net.Conn, 不处理 X-Forwarded-For 等

SSE 的限制:

- 无自动重连 ID 管理 (需用户手动调用 ID())
- 无连接池/广播机制 (需用户自行实现 pub/sub)

---

## 潜在改进方向

如果要将 yukino_http 用于生产环境, 你认为有哪些需要改进的地方?

A:

1. Context 对象池: 引入 `sync.Pool` 复用 Context, 减少高 QPS 下的 GC 压力. 需要 `reset()` 方法清理所有字段.

2. 路由性能: 当前 Trie 的 children 是 slice, 路由数量大时线性扫描. 可改为 map[string]\*node + 通配子节点分离, 或迁移到 radix tree.

3. 路由冲突检测: 当前 `/users/:id` 和 `/users/:name` 可以同时注册但行为未定义 (先注册的优先) . 应在注册时检测冲突并 panic.

4. WebSocket 增强:
   - 将单帧上限与重组消息上限分离为独立配置 (当前共用 `messageLimit()`)
   - 写超时 (防止慢客户端阻塞写 goroutine)
   - Close 握手超时 (发送 Close 后等待对端回复, 超时强制断开)
   - permessage-deflate 支持

5. 中间件错误传播: 当前 panic 是唯一的错误传播机制. 可考虑在 Context 中增加 `Err error` 字段, 允许中间件返回错误而非 panic.

6. HTTP/2 支持: 当前依赖 `http.Server` 的默认行为. 框架只导出了 `Listen` (内部调 `ListenAndServe`), `server` 是未导出字段, 包外无法调 `ListenAndServeTLS`; 若要启用 HTTP/2 需框架新增导出的 TLS 监听方法, 且 SSE 在 HTTP/2 下的行为需要验证.

7. 请求体大小限制: `BindJSON` 没有限制 body 大小, 恶意客户端可以发送超大 body 耗尽内存. 应包装 `http.MaxBytesReader`.

8. 结构化日志: Logger 使用 `log.Printf`, 生产环境需要结构化输出 (JSON 格式、请求 ID、trace ID) .

9. 指标暴露: 缺少 Prometheus metrics 集成点 (请求计数、延迟直方图、活跃连接数) .

10. 测试覆盖: 当前有单元测试 (context_test、router_test、sse_test、websocket_test、yukino_test、response_test) , 但缺少基准测试 (Benchmark) 和竞态检测 (`go test -race`) 的 CI 集成.
