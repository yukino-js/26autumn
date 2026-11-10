---
title: "HTTP 框架与网关工程"
description: "53 题：yukino_http 的 trie 路由、洋葱中间件 compose、延迟响应与 TakeOver、静态文件、SSE 与 WebSocket 实现逐机制深挖，wanproxy 反向代理与 Relay 泵送架构，网关限流、负载均衡、Range 大文件、优雅关闭与可观测性"
---

:::note 事实基线
本文框架部分依据 `$HOME/github/yukino.go`（HEAD `facf5d6a8670`，子路径 `libs/yukino_http`），代理部分依据 `$HOME/github/wanproxy`（HEAD `62975591df24`，子路径 `srv.go/` 与 `wanproxy.go/proxy/`）在上述检出的源码事实撰写；文中路径、常量与 API 名称均可在对应检出中定位。
:::

本篇是 HTTP 框架与网关工程方向的带解答题库（53 题）。框架部分逐机制精读 `$HOME/github/yukino.go/libs/yukino_http`（HEAD `facf5d6a8670`）；代理部分精读 `$HOME/github/wanproxy`（HEAD `62975591df24`）的 `srv.go/`（基于 yukino_http 的业务网关）与 `wanproxy.go/proxy/`（TCP 代理与 codec 管线）。路径均为仓库根相对路径。

**主线一览**

```mermaid
flowchart LR
    REQ[http.Request] --> SH[ServeHTTP] --> MW[按前缀收集中间件] --> H[router.handle]
    H --> T[trie search + params] --> C[compose 洋葱链] --> R[ctx.respond 延迟渲染]
    R --> W[http.ResponseWriter]
```

## 一、框架架构与请求生命周期

### Q1. yukino_http 的 Application 由哪几部分组成？

**事实基线**（`libs/yukino_http/yukino.go`）：

```go
type Application struct {
    root          *Router          // 根路由分组（prefix=""）
    router        *router          // 真正的 trie 路由表
    routers       []*Router        // 所有分组，用于按前缀收集中间件
    htmlTemplates *template.Template
    funcMap       template.FuncMap
    server        *http.Server
}
```

`New()` 把 `app` 自身设为 `http.Server.Handler`（`Application` 实现 `ServeHTTP`），所以它是**标准库 handler 之上的薄层**，可直接挂到任何 `http.Server`/测试框架。`Default()` = `New()` + `Use(Logger(), Recovery())`。

### Q2. 描述一个请求从进入到写出的完整生命周期。

**事实基线**（`yukino.go` `ServeHTTP` + `router.go` `handle`）：

1. `ServeHTTP` 遍历 `app.routers`，用 `matchRouterPath(req.URL.Path, r.prefix)` 收集**所有前缀命中的分组**的中间件（root 的 prefix 为 `""`，恒命中，全局中间件总在最先）；
2. `newContext(w, req)`:`Status` 默认 **404**、`statusSet=false`、初始化 `State`/`headers` 两个 map；
3. `router.handle`:trie 查找路由节点，命中则取 `handlers[method-pattern]`，未命中构造 404 handler；
4. `compose(middlewares, handler)` 生成洋葱链并执行；
5. 链返回后统一调 `ctx.respond()` 做**延迟渲染**（把缓冲的 status/headers/Body 一次性写进 `ResponseWriter`）。

关键设计：**handler 不直接写响应，而是改 Context 状态**；`TakeOver` 是唯一绕过延迟渲染的口子。

### Q3. 为什么 Context 初始 Status 是 404 而不是 200？promoteStatus 又是什么？

初始 404 让「handler 忘记设置响应」自然落到 404 而非伪装成功。但正常写了 Body 的路径不该还是 404，于是有两级提升（`response.go`）：

- `promoteStatus()`:`JSON/String/Data/HTML` 调用时，若 `!statusSet && Status==404` → 提升为 200；
- `respond()` 兜底：`Body != nil && !statusSet && Status==404` → 200。

`statusSet` 标志区分「显式设置过状态」与「默认值」——`SetStatus(404)` 后 promote 不会把它改成 200。**采分点**：这是「默认值 + 显式标志位」解决零值歧义的经典手法（同 `time.Time` 的 IsZero 问题）。

### Q4. compose 的 dispatch 实现讲了什么？为什么 next() 调两次要 panic？

**事实基线**（`yukino.go`）：

```go
func compose(middlewares []Middleware, final Middleware) func(ctx *Context) {
    return func(ctx *Context) {
        index := -1
        var dispatch func(i int)
        dispatch = func(i int) {
            if i <= index { panic("yukino_http: next() called multiple times") }
            index = i
            if i >= len(middlewares) {
                if final != nil { final(ctx, func() {}) }
                return
            }
            middlewares[i](ctx, func() { dispatch(i + 1) })
        }
        dispatch(0)
    }
}
```

要点：① 闭包递归实现洋葱模型，`next` 就是 `dispatch(i+1)`；② `index` 单调递增检测**同一层重复调用 next**——重复调用会让下游 handler 执行两次（重复扣款、重复写响应），属于编程错误，**快速失败优于静默错乱**；③ 最终 handler 拿到的 `next` 是空函数 `func() {}`，调用无害；④ 与 Koa 的 compose 同构（返回 Promise 链 vs 同步闭包），Go 版是同步的，因为 goroutine 本身就是「每请求一线程」模型，无需 CPS 变换。

### Q5. 中间件的类型签名为什么是 `func(ctx *Context, next func())` 而不是返回 error？

**事实基线**（`context.go`）：`type Middleware func(ctx *Context, next func())`。不返回 error 的取舍：错误处理收敛到 Context（`Throw(status, msg)` 设置错误响应），中间件通过**不调用 next** 实现短路（如 `wanproxy/srv.go` 的 cors 对 OPTIONS 直接 `SetStatus(204); return`）。好处是签名简单、短路语义直观；代价是无法用 `err != nil` 强制处理错误，需要纪律。对比 gin 的 `c.Abort()` 链式中断：yukino_http 的「不调 next 即中断」更朴素，且没有 abort 索引状态机。

### Q6. 分组中间件是怎么继承的？子分组能拿到父分组的中间件吗？

**事实基线**：`group.go` `Router(prefix)` 创建子分组时只记录 `prefix = 父prefix + normalizePrefix(新prefix)` 并 append 进 `app.routers`；`ServeHTTP` 按**路径前缀匹配**收集所有命中分组的中间件。所以继承是「运行时按前缀匹配」而非「注册时拷贝」：请求 `/api/v1/x` 会依次拿到 root（prefix=""）、`/api`、`/api/v1` 三层分组的中间件，**顺序 = 分组创建顺序**（`routers` 切片序）。`matchRouterPath` 要求前缀后必须是 `/` 或恰好等长——`/apifoo` 不会命中 `/api`，防止前缀误匹配。

### Q7. normalizePrefix 处理了哪些边界？

**事实基线**（`group.go`）：空串原样；不以 `/` 开头则补；循环去掉尾部 `/`（保留长度 >1 约束）；最终若为 `"/"` 归一为 `""`。效果：`Router("api/")`、`Router("/api")`、`Router("/api/")` 等价。`addRoute` 时 `pattern = r.prefix + comp` 拼接，并 `log.Printf("Route %4s - %s", ...)` 打印路由表——启动日志即文档。

### Q8. All() 注册了哪些方法？为什么没有 TRACE/CONNECT？

**事实基线**（`group.go`）：`All` 循环注册 **GET/POST/PUT/DELETE/PATCH/HEAD/OPTIONS** 七种。TRACE（跨站追踪攻击面，绝大多数框架不支持）与 CONNECT（代理隧道语义，属于反向代理层而非应用路由层）被有意排除。需要时可单独 `Options()` 注册。

## 二、trie 路由

### Q9. 画出路由 trie 的节点结构并解释插入过程。

**事实基线**（`trie.go`）：

```go
type node struct {
    pattern  string   // 仅叶子（完整路由）非空
    part     string   // 本节点对应的路径段
    children []*node
    isWild   bool     // part 以 ':' 或 '*' 开头
}
```

`insert(pattern, parts, height)` 递归：`height == len(parts)` 时把 pattern 写到当前节点（标记为可命中叶子）；否则 `matchChild` 找**完全相等**的子节点，没有则新建（`isWild = part[0]==':' || part[0]=='*'`）。每层一个路径段，`:id`、`*filepath` 是通配段。

### Q10. 查找时精确子节点和通配子节点的优先级？

**事实基线**（`trie.go` `matchChildren`）：返回的候选列表**先放 part 完全相等的子节点，再放所有 isWild 子节点**；`search` 按序 DFS，第一个成功返回的即结果。所以 `/user/new`（精确）优先于 `/user/:id`（通配）。这是「静态路由 > 参数路由」的优先级语义，与主流框架一致。注意 `matchChild`（插入用）只匹配完全相等——**同一层可以共存 `:a` 和 `:b` 两个不同名参数节点**，查找时都会尝试，先注册先命中（DFS 序），这是该实现宽松于 gin（gin 同层冲突直接 panic）的地方。

### Q11. parsePattern 为什么遇到 `*` 就 break？

**事实基线**（`router.go`）：

```go
for _, item := range vs {
    if item != "" {
        parts = append(parts, item)
        if item[0] == '*' { break }
    }
}
```

`*filepath` 是**贪婪通配**，语义上必须位于 pattern 末尾并吞掉剩余所有段；break 保证 `*` 之后的部分不参与逐段匹配。查找侧（`node.search`）对应地用 `strings.HasPrefix(n.part, "*")` 提前终止递归：走到 `*` 节点即命中，无需继续比深度。

### Q12. 路径参数是怎么提取的？`:id` 和 `*filepath` 有何区别？

**事实基线**（`router.go` `getRoute`）：命中节点后，用**注册 pattern 的段**与**请求 path 的段**按索引对齐：`part[0]==':'` → `params[part[1:]] = searchParts[index]`（单段）；`part[0]=='*'` → `params[part[1:]] = strings.Join(searchParts[index:], "/")`（剩余全部段拼接）后 break。例：注册 `/static/*filepath`，请求 `/static/css/a.css` → `filepath = "css/a.css"`。`Static()` 正是靠这个机制把子树映射到文件系统路径。

### Q13. 路由表为什么按 method 分根（roots map[string]*node）？handler 存在哪？

**事实基线**（`router.go`）：`roots map[string]*node` 每个 HTTP 方法一棵独立 trie；`handlers map[string]Middleware` 以 `method + "-" + pattern` 为 key。分根的好处：GET 树的通配不会误命中 POST 请求，查找天然带方法过滤；`handle` 未命中时走统一 notFound（**注意：方法不匹配也返回 404 而非 405**——没有跨方法查找，这是简化取舍，可作为改进点主动提出：遍历其他 method 的树可区分 405）。

### Q14. 这个 trie 的复杂度？和 radix tree / 哈希路由比差在哪？

查找 O(路径段数 × 同层候选数)，与路由总量无关——这是 trie 系路由对 `map[pattern]handler`（无法支持通配）的本质优势。与 radix tree（httprouter/gin）比：本实现**不压缩单链节点**（每段一节点，`children` 是切片线性扫描），路由数万级时同层扫描变慢；radix tree 合并公共前缀、同层用有序数组/二分。与 `http.ServeMux`（1.22+ 也支持 `{id}` 通配）比：本实现提供分组中间件与延迟响应等应用层能力。**取舍要讲清**：教学级/中小规模服务，切片扫描的常数极小，简单性优先。

### Q15. 404 路径也走中间件链，这有什么意义？

**事实基线**（`router.go` `handle`）：未命中时构造 `notFound` handler（设 404 + `"404 NOT FOUND: " + ctx.Path`），仍然 `compose(middlewares, notFound)` 执行。意义：Logger 能记录 404 请求（安全审计需要）、Recovery 能兜住中间件自身的 panic、CORS 头在 404 上也正确（浏览器才能读到错误）。若 404 绕过中间件，监控盲区就出现了。

## 三、Context 与延迟响应

### Q16. Context 里哪些字段是公开的、哪些是私有的？为什么 headers 是私有 map？

**事实基线**（`context.go`）：公开 `Request/Writer/Path/Method/Status/Body/Type/State/Params`；私有 `headers map[string]string`、`app`、`flushed`、`statusSet`。`headers` 私有是为了**缓冲语义**：`Set()` 写进缓冲（经 `http.CanonicalHeaderKey` 规范化），真正落到 `Writer.Header()` 发生在 `respond()`/`TakeOver()`——这样 Recovery 可以在 panic 后整体重置缓冲头（`recovery.go` `ctx.headers = make(...)`），若直接写 ResponseWriter 就无法撤销（Go 的 Header map 在 WriteHeader 前可改，但框架无法区分「谁写的」）。

### Q17. TakeOver 的完整语义是什么？解决什么问题？

**事实基线**（`context.go` 注释 + 实现）：

```go
func (ctx *Context) TakeOver() {
    if ctx.flushed { return }        // 幂等
    ctx.flushed = true               // respond() 从此跳过
    for k, v := range ctx.headers {  // 缓冲头拷贝到 Writer
        ctx.Writer.Header().Set(k, v)
    }
}
```

解决「框架的延迟渲染」与「需要直接控制原始 Writer 的场景」的冲突：SSE 流、WebSocket 升级、`http.FileServer`、大文件 `io.Copy`、把 Writer 交给外部 `http.Handler`。三个关键承诺（注释原文）：**不写 status/body、不包装 Writer（保留 `http.Flusher` 等可选接口）、之后的 Body/Status 修改不再渲染**；`SetStatus` 仍可用于给日志中间件记录状态。`flushed` 同时被 `SSE()`、`Upgrade()`（置 `ctx.flushed = true`）复用，保证各接管路径互斥且幂等。

### Q18. respond() 的渲染规则完整过一遍。

**事实基线**（`response.go`）：

1. `flushed` → 直接返回（已接管）；
2. Body 非 nil 且未显式设状态且 Status==404 → 提升 200；
3. **空状态**（204/205/304，`emptyStatus`）→ 丢弃 Body，并从缓冲头删除 `Content-Type/Content-Length/Transfer-Encoding`（RFC 要求 204/304 不得带 body 与这些头）；
4. 缓冲头逐个 `Writer.Header().Set`；
5. `Body == nil` → 只 `WriteHeader(Status)`；
6. 按 Body 动态类型分派：`htmlPayload` → 模板执行；`[]byte`/`string` → 直写；`io.Reader` → `io.Copy`（流式，不整块进内存）；**default → JSON 序列化**。

`setContentType` 只在 Writer 尚无 Content-Type 时设置——外部已显式设置的不覆盖。

### Q19. JSON 序列化失败时框架怎么处理？为什么这时不能再用 ctx.Status？

**事实基线**（`response.go` `respondJSON`）：`json.Marshal` 失败 → 记日志，**强制** `Content-Type: application/json` + `WriteHeader(500)` + 写 `{"message":"Internal Server Error"}`。此时尚未调用过 `WriteHeader`（延迟渲染的好处：序列化在写头之前），所以还能改状态码；若已经流式写出一半才失败（如 `io.Reader` 分支），状态码已定格，只能断连——这正是 `respond()` 把「先序列化后写头」作为默认路径的原因：**错误发生在提交响应之前，才有挽回余地**。

### Q20. Redirect 为什么保留已有的 3xx 状态？

**事实基线**（`response.go`）：`Redirect(url)` 检查当前 Status 是否已在 {300,301,302,303,305,307,308} 中，是则保留，否则默认 302；置 `statusSet`、写 `Location` 头，Body 为空时补 `"Redirecting to " + url` 文本。设计意图：允许 `ctx.SetStatus(301); ctx.Redirect(url)` 表达永久重定向，而不需要 `Redirect` 再带一个状态参数（对比 gin 的 `Redirect(code, url)` 把校验推给调用方）。307/308 与 302/301 的区别（保持方法不变）是高频追问。

### Q21. Throw 和 SetStatus+JSON 有什么区别？

**事实基线**（`context.go`）：`Throw(status, msg)` = 设状态 + `statusSet` + `Body = H{"message": msg, "data": nil}`，是**统一错误形状**的快捷方式（`H` 即 `map[string]any`）。业务侧 `wanproxy/srv.go` 反而自定义了 `errJSON`（`{"error": msg}` 形状）——说明错误响应形状是 API 契约，框架只提供默认值，项目可整体替换。面试可对比：REST 错误体三流派（message 字段 / error 字段 / RFC 7807 problem+json）。

### Q22. State 和 Params 的分工？中间件如何向 handler 传值？

**事实基线**：`Params map[string]string` 由路由层填充（路径参数）；`State map[string]any` 是请求域 KV（`newContext` 初始化），供中间件→handler 传值（如鉴权中间件塞用户 ID）。类型不安全是 `any` map 的代价；更重的方案是 `context.WithValue`（yukino_http 未用，因为 Context 本身就是请求域对象，无需再套 ctx 链）。**追问预案**：为什么不用 `Request.Context()` 传值？——可以，但每层 WithValue 都分配新 ctx；State map 一次分配复用，性能与直观性更好，代价是并发写需自己保证（单 goroutine 请求内无此问题）。

## 四、静态文件、Range 与大文件

### Q23. Static() 是怎么把 URL 子树映射到文件系统的？

**事实基线**（`group.go`）：

```go
func (r *Router) Static(relativePath string, root string) {
    handler := r.createStaticHandler(relativePath, http.Dir(root))
    urlPattern := path.Join(relativePath, "/*filepath")
    r.Get(urlPattern, handler)
}
```

`createStaticHandler` 内 `http.StripPrefix(prefix+relativePath, http.FileServer(http.Dir(root)))`:FileServer 收到的是剥掉挂载前缀的相对路径，`http.Dir` 天然防 `../` 逃逸（内部 clean）。命中前先 `staticFileExists` 检查：文件存在，或目录且含 `index.html`；否则设 404 走框架渲染（而不是 FileServer 自己的 404 页），**保持错误响应形状一致**。

### Q24. statusRecorder 为什么存在？TakeOver 之后框架怎么知道状态码？

**事实基线**（`group.go`）：静态文件走 `ctx.TakeOver()` 后由 `http.FileServer` 直接写 `ctx.Writer`，框架的延迟渲染已失效，`ctx.Status` 不会再被 respond 使用——但 **Logger 中间件在 next() 之后要打印状态码**。解法：包装一层

```go
type statusRecorder struct {
    http.ResponseWriter
    status *int
    wrote  bool
}
```

`WriteHeader` 首次调用时把 code 写回 `*ctx.Status`；`Write` 未先 WriteHeader 时记 200（Go 的隐式 200 语义）。`wrote` 防重复记录。**采分点**：这是「接管后保留可观测性」的通用模式（同 OpenTelemetry 的 ResponseWriter 包装）；注意它只嵌入接口、**不透传 Flusher/Hijacker**——静态文件不需要，但 SSE 场景就不能这样包（对照 TakeOver 注释「不包装 Writer，保留可选接口」）。

### Q25. HTTP Range 请求的完整语义？项目里怎么实现的？

**事实基线**（`wanproxy/srv.go/internal/server/server.go` `content` handler）：

- 响应恒带 `Accept-Ranges: bytes`；
- 解析 `Range: bytes=(\d*)-(\d*)`（regexp，支持 `bytes=100-`、`bytes=-500` 后缀形式的解析分支）；
- **非法区间**（`start >= total || end >= total || start > end`）→ `TakeOver()` + 416 + `Content-Range: bytes */total`（告知总长供客户端修正）；
- 合法 → 206 + `Content-Range: bytes start-end/total` + `Content-Length: end-start+1` + `f.Seek(start)` + `io.CopyN(w, f, end-start+1)`；
- 无 Range → 200 + Content-Length + `io.Copy` 全量。

用途（README 事实）：视频拖动播放（browser video seeking）。**追问预案**：多区间 `bytes=0-1,2-3` 需要 multipart/byteranges 响应（项目未支持，单区间是常见取舍）；`If-Range` 条件请求防陈旧缓存；CopyN 的 N 来自解析结果，天然限制读放大。

### Q26. 4 GiB 大文件上传下载，这个网关怎么保证不被打爆内存？

**事实基线**（`wanproxy/srv.go`）：`maxTransferSize = 4 * 1024 * 1024 * 1024` 只是**尺寸上限校验**（generate/source 的 size 参数），内存安全靠全链路流式：

- 上传：`files.Store(name, ctx.Request.Body)` 直接消费 Body 流，不进内存；
- 下载：`os.Open` + `io.Copy`/`io.CopyN`（32KB 内部缓冲）；
- 生成下载：`source` handler `io.Copy(ctx.Writer, payload.NewReader(pattern, size, seed))`——**数据按需生成、边生成边写**，4GiB 文件常驻内存只有缓冲；
- 校验：`sink` handler `io.Copy(sha256.New(), ctx.Request.Body)` 流式哈希。

配合 `TakeOver` 绕过框架的 Body 缓冲（框架 `Data([]byte)` 会整块持有）。**采分点**：说出「框架延迟响应默认缓冲 Body，大 payload 必须 TakeOver 走流式」这一层，才算真读懂了这个框架。

### Q27. Content-Length 在流式响应里什么时候能设、什么时候不能？

能设：总长先验可知——`source` handler 生成前就知道 size，显式 `ctx.Set("Content-Length", ...)`；Range 响应 `end-start+1`。不能设：长度依赖生成过程（如 SSE、gzip 动态压缩）→ 交给 net/http 用 `Transfer-Encoding: chunked`（HTTP/1.1）或 DATA 帧（HTTP/2）。**陷阱**：TakeOver 后自己 WriteHeader，若既没设 Content-Length 又没关连接，Go 会在响应结束时补 chunked；若手动设了错误的 Content-Length，客户端会截断或挂起——`statusRecorder` 场景里 FileServer 自己算长度，框架不插手。

### Q28. encodeURIComponent 为什么要在 Go 里手写？

**事实基线**（`wanproxy/srv.go` `encodeURIComponent`）：`Content-Disposition: inline; filename="..."` 里的文件名若含非 ASCII/特殊字符会破坏头语法。Go 标准库的 `url.QueryEscape` 编码规则与 JS 的 `encodeURIComponent` 不同（空格→`+` vs `%20`、`!'()*` 处理差异），而前端（web/ React）按 JS 语义解码，所以服务端**逐字节对齐 JS 的 unreserved 集合**（`A-Za-z0-9-_.!~*'()` 之外全部 `%XX`）。这是全栈项目里「两端编码契约」的典型细节。

## 五、SSE 与 WebSocket

### Q29. SSE() 做了哪几件事？为什么必须先 TakeOver？

**事实基线**（`sse.go`）：

```go
func (ctx *Context) SSE() *SSEWriter {
    flusher, _ := ctx.Writer.(http.Flusher)
    ctx.Status = http.StatusOK; ctx.statusSet = true
    ctx.Writer.Header().Set("Content-Type", "text/event-stream")
    ctx.Writer.Header().Set("Cache-Control", "no-cache")
    ctx.Writer.Header().Set("Connection", "keep-alive")
    ctx.TakeOver()
    ctx.Writer.WriteHeader(http.StatusOK)
    return &SSEWriter{ctx: ctx, flusher: flusher}
}
```

SSE 是**长连接增量写**，与「链结束后一次性 respond」根本冲突，所以：先抓 `http.Flusher`（TakeOver 不包装 Writer，类型断言仍有效），直接设三个协议头到 Writer（不走缓冲，因为 TakeOver 只拷贝缓冲头、此处顺序是先设后 TakeOver 亦兼容），TakeOver 关掉延迟渲染，立即 WriteHeader(200) 提交响应头——**头必须在第一个事件前提交**，否则客户端 EventSource 一直等。

### Q30. SSE 帧格式在项目里怎么生成？多行 data 怎么处理？

**事实基线**（`sse.go` `writeData`）：数据按 `\n` 逐行写 `data: %s\n`，最后补一个空行 `\n` 触发事件派发——**多行 payload 必须拆成多个 data：行**，直接嵌 `\n` 会破坏帧边界（SSE 规范）。`Event()` 先写 `event: %s\n` 再 writeData；`JSON()` 把对象 marshal 后作为单行 data（JSON 无裸换行，安全）；`ID()` 写 `id:` 字段（配合断线重连的 `Last-Event-ID`）；`Retry(ms)` 写 `retry: %d\n\n` 控制客户端重连间隔；`Comment()` 写 `: ` 前缀行。`Done()` 约定俗成发 `data: [DONE]`（OpenAI 风格终止哨兵）。

### Q31. SSEWriter 为什么每个方法都加 mutex？

**事实基线**：`SSEWriter{mu sync.Mutex}`，`Event/Data/JSON/ID/Retry/Comment/Heartbeat` 全部锁内写+flush。场景：业务 goroutine 推事件的同时，`Heartbeat` 的 ticker goroutine 在写 `: keepalive\n\n`——两个 writer 交错会把帧写劈（半个 data 行插入 keepalive 中间）。锁保证**一帧的原子性**。`flusher.Flush()` 也在锁内：确保「写完即冲」不被另一帧插队。

### Q32. Heartbeat 的停止协议是怎么设计的？

**事实基线**（`sse.go`）：`Heartbeat(interval)` 起 goroutine，三路 select:ticker 到点写 keepalive；`ctx.Request.Context().Done()`（客户端断开，net/http 取消请求 ctx）自动退出；`stop` chan 手动退出。返回的停止函数：

```go
var stopOnce sync.Once
return func() { stopOnce.Do(func() { close(stop) }); <-done }
```

`Once` 保证幂等，`<-done` **同步等待 goroutine 真正退出**——调用方 defer stop() 后可以安全释放资源，不存在「函数返回了心跳还在写已关闭连接」的窗口。

### Q33. Stream(ch) 的退出条件？为什么 select 里不需要超时？

**事实基线**：`Stream(ch <-chan string)` 循环 select:`ch` 关闭（`!ok`）→ 正常结束；`Request.Context().Done()` → 客户端断开退出。不需要超时因为**两个退出条件已覆盖全部终态**：生产者结束或消费者消失。若业务需要空闲超时，应在生产侧实现（往 ch 发终止哨兵），而不是在框架层加轮询——分层清晰。

### Q34. WebSocket 握手的校验链与 accept key 计算？

**事实基线**（`websocket.go` `Upgrade`），按序校验：

1. `CheckOrigin`（可选回调）不过 → 403 `origin not allowed`（CSWSH 防线）；
2. 非 GET → 405；
3. `Connection` 头不含 `upgrade` → 400（`headerContains` 逗号拆分 + EqualFold，兼容 `keep-alive, Upgrade`）；
4. `Upgrade` 头不含 `websocket` → 400；
5. `Sec-WebSocket-Version` 不含 `13` → 400 且**回设 `Sec-WebSocket-Version: 13`**（RFC 6455 要求的版本协商响应）；
6. 缺 `Sec-WebSocket-Key` → 400。

accept key = `base64(sha1(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))`（`computeAcceptKey`，GUID 是协议常量 `wsGUID`）。子协议协商 `negotiateSubprotocol`：**服务端偏好序优先**（外层循环服务端列表）。

### Q35. Hijack 之后框架做了哪些「接管」动作？

**事实基线**：`http.NewResponseController(ctx.Writer).Hijack()` 拿到裸 `net.Conn` 与 `*bufio.ReadWriter`（用 ResponseController 而非直接断言 `http.Hijacker`，能穿透中间包装层）；置 `ctx.flushed = true`（跳过 respond）、`Status = 101`（供日志）；`conn.SetDeadline(time.Time{})` 清掉 server 可能设过的读写超时（长连接不能被 ReadTimeout 掐死）；手写 101 响应（256 字节预分配 buffer 拼接）；bufio 复用三分支（见 [Go 语言与运行时](/interview/qa/go-language-runtime) Q66）。`UpgradeOptions.WriteBufferSize` 字段存在但**写路径直接 `conn.Write` 未缓冲**——写帧本身是「header+payload 一次 Write」，无需 bufio。

### Q36. WebSocket 帧的读取校验有哪些？为什么客户端帧必须 masked？

**事实基线**（`readFrame`）：RSV1-3 必须为 0（`header[0]&0x70 != 0` → 非法帧）；opcode 只认 0/1/2/8/9/10；控制帧（Close/Ping/Pong）**必须 fin=1 且 payload ≤125**（RFC 6455 禁止分片控制帧）；`masked` 位必须为 1——**客户端→服务端帧强制掩码**，目的是打破「攻击者可控字节直接命中中间设备协议解析」的缓存投毒类攻击（proxy 把 WebSocket 流量误认为 HTTP）；长度三档：≤125 内联、126→uint16、127→uint64；超过 `messageLimit()`（默认 `maxFrameSize=65536`，可由 `MaxMessageSize` 覆盖）→ 非法帧，**先校验长度再分配 payload**，防内存放大攻击；4 字节掩码 XOR 解码。

### Q37. 分片消息（continuation）怎么重组？控制帧插在分片中间怎么办？

**事实基线**（`readMessage`）：首帧记 `msgType`，后续 `continuationFrame(0)` 追加进 buf，**每片都检查累计长度 ≤ messageLimit**（防分片炸弹）；fin=1 时返回完整消息。控制帧（Ping/Pong/Close）**不排队、立即返回**——RFC 允许控制帧插在分片流中间，`Listen` 循环处理完（自动回 Pong/Close 应答）后继续读下一帧，重组状态不受影响。continuation 无首帧（`msgType==0`）→ 非法帧。

### Q38. Listen() 和 ReadMessage() 两种消费模式怎么选？

**事实基线**：`Listen()` 是回调驱动死循环（OnMessage/OnPing/OnPong/OnClose/OnError 注册），Ping 自动回 Pong，Close 自动回 Close 帧并 `once.Do(close(closed))`；`ReadMessage()` 是拉模式（`readMu` 串行化，内部同样自动处理 Ping/Close，Close 后返回 `ErrWSClosed`）。两者**不可混用**（都消费同一个读路径）。回调模式适合事件驱动（聊天室广播），拉模式适合同步协议（请求-应答子协议）。写侧统一 `writeMu` 串行 + `writeFrame` 单次 `conn.Write`（帧原子性）。

### Q39. WSConn 的关闭路径有几条？closed channel 起什么作用？

**事实基线**：① 对端 Close 帧 → 回 Close 帧 → `once.Do(close(closed))` → onClose；② 本地 `Close()`/`CloseWithMessage(code,text)` → close(closed) → 写 Close 帧（`closeNormal=1000`）→ `conn.Close()`；③ 读错误 → `handleError`：未关闭才回调 onError，然后 close(closed)。`closed chan struct{}` 是**统一的死亡广播**：`Closed()` 暴露给业务 select；`Heartbeat` goroutine 监听它自动停跳；`handleError` 用它抑制「关闭后读错误再报 onError」的噪音。Close payload 解析（`parseClosePayload`）：不足 2 字节按 1000 处理，文本非 UTF-8 则丢弃——严格按 RFC。

### Q40. SSE、WebSocket、HTTP 长轮询怎么选？

| 维度     | SSE                         | WebSocket                    | 长轮询       |
| -------- | --------------------------- | ---------------------------- | ------------ |
| 方向     | 服务端→客户端单向           | 全双工                       | 半双工（伪） |
| 协议     | 纯 HTTP，过代理友好         | 需 Upgrade，部分中间件不透明 | 纯 HTTP      |
| 重连     | 内建（Last-Event-ID/retry） | 自己实现                     | 天然无状态   |
| 二进制   | 需 base64                   | 原生                         | 需编码       |
| 典型场景 | LLM token 流、通知          | 聊天、协同、游戏             | 兼容性兜底   |

**项目事实**：yukino_http 两者都是一等公民（`sse.go`/`websocket.go`），LLM 网关类服务通常 SSE 为主（单向流 + 自动重连语义刚好），双向工具确认/语音才上 WS。

## 六、中间件工程实战

### Q41. Logger 和 Recovery 的注册顺序为什么是 Use(Logger(), Recovery())？

**事实基线**（`yukino.go` `Default()`）：Logger 在外层。洋葱顺序决定：Recovery 在**内层**捕获 handler panic 并转 500 后，控制流回到外层 Logger，`ctx.Status` 已是 500——**日志能记录到 panic 请求**。若反过来（Recovery 在外），Logger 自身 panic 无人兜底，且 Recovery 渲染的 500 不会被记录。原则：**可观测性中间件最外层，兜底中间件次外层，业务中间件在内**。

### Q42. wanproxy 的 cors 中间件为什么在 next() 前后各 apply 一次头？

**事实基线**（`wanproxy/srv.go/internal/server/server.go`，注释原文解释）：

```go
app.Use(httpLog, cors, yukino.Recovery())
// cors: apply(); if OPTIONS { SetStatus(204); return }; next(); apply()
```

注册序 httpLog → cors → Recovery，即 **Recovery 在 cors 内层**。panic 时 Recovery 会 `ctx.headers = make(map[string]string)` **清空缓冲头**再写 500——cors 在 `next()` 返回后的第二次 `apply()` 把 CORS 头重新塞回缓冲，`respond()` 渲染时 500 响应仍带 `Access-Control-Allow-Origin`，**浏览器端才能读到错误**（否则表现为 CORS 错误掩盖真实 500）。注释还点明：TakeOver 后二次 apply 是无害 no-op（缓冲头不再渲染）。这是「中间件与框架错误路径交互」的深度案例。

### Q43. OPTIONS 预检为什么直接 204 短路而不调 next？

**事实基线**：cors 中 `if ctx.Method == http.MethodOptions { ctx.SetStatus(http.StatusNoContent); return }`。预检是浏览器与网关之间的**协议握手**，与业务无关：不该进业务 handler（可能 405/404）、不该被鉴权中间件拦截（预检不带凭据）。204 + Allow-* 头即完整应答。`emptyStatus` 机制保证 204 不带 body。追问：简单请求（GET+标准头）不触发预检；`Access-Control-Allow-Headers: Content-Type,Range` 是白名单——Range 在列是因为前端视频拖动会带自定义读取需求（配合 Expose-Headers 的 `Content-Range,Content-Length,Accept-Ranges` 让 JS 能读响应头）。

### Q44. 设计一个鉴权中间件：短路、传值、错误形状三要素怎么写？

**方案推导**（基于本框架机制）：

```go
func Auth(validate func(token string) (*User, error)) yukino.Middleware {
    return func(ctx *yukino.Context, next func()) {
        token := strings.TrimPrefix(ctx.Get("Authorization"), "Bearer ")
        u, err := validate(token)
        if err != nil {
            ctx.Throw(http.StatusUnauthorized, "invalid token") // 统一错误形状
            return                                              // 不调 next 即短路
        }
        ctx.State["user"] = u // State 传值给下游 handler
        next()
    }
}
```

要点：短路后 `respond()` 仍会渲染 Throw 设置的 401（延迟响应保证）；注册在 `/api` 分组则静态资源不受影响（前缀匹配收集）；`Throw` 的 message 不泄漏内部错误细节（`err` 只进日志不进响应）。

## 七、反向代理与网关架构（wanproxy）

### Q45. wanproxy 的整体架构？Listener/Relay 各管什么？

**事实基线**（`wanproxy.go/proxy/listener.go`、`relay.go`，README）：这是 C++ WANProxy 的 **Go 移植**：`Listener` 对应 C++ ProxyListener/ProxyConnector 对——在 interface endpoint 接受 TCP 连接，为每条连接 dial peer endpoint，然后交给 `Relay` 双向泵送；两端可各自配置 codec 管线（`pipeline.CodecSpec`，模式 `none/zlib/xcodec/zlib+xcodec`）。`handle` 流程：`dialPeer` → `track`（连接登记，Stop 时可中断）→ 可选 SSH 握手 → `NewRelay(...).Run()`。它是 **L4 代理**（字节流），不解析 HTTP——与 L7 网关（解析请求、按路由转发）是两类网关，面试要先分清。

### Q46. Relay 的 goroutine 拓扑？为什么纯转发和 codec 转发走两条路径？

**事实基线**（`relay.go` `RunContext`）：

```mermaid
flowchart LR
    subgraph 纯转发（无 codec）
        C1[client] -- io.Copy --> U1[upstream]
        U1 -- io.Copy --> C1
    end
    subgraph codec 转发（6 goroutine + 4 队列）
        C2[client 读] --> RS1[readSource] --> Q1[toUpstream flowQueue] --> F1[forward+encode] --> W1[wireWriter → upstream]
        U2[upstream 读] --> RS2[readSource] --> Q2[toClient flowQueue] --> F2[forward+encode] --> W2[wireWriter → client]
        RS1 -. ASK/LEARN 立即 .-> Q3[controlsI] --> W2
        F1 -. ADVANCE/EOS_ACK 延迟 .-> Q3
        RS2 -.-> Q4[controlsP] --> W1
        F2 -.-> Q4
    end
```

纯转发路径**故意只用 `io.Copy`**（注释：让 net.TCPConn 走平台优化拷贝路径，即 sendfile/splice 零拷贝），2 个 goroutine 搞定。codec 路径必须过用户态变换（解压/去重编码），拆成「读源 / 转发编码 / 写控制帧」三类 goroutine，用 `flowQueue` 衔接——**读 socket 的 goroutine 永远不等 socket 写**（注释：ASK/LEARN 控制帧与应用数据共享同一条 wire，读写耦合会死锁：A 等 B 读走控制帧才能继续写，B 等 A 读走数据才能继续写）。

### Q47. splitResponses 为什么把 ADVANCE/EOS_ACK 延迟、ASK/LEARN 立即发送？

**事实基线**（`wanproxy.go/proxy/flow.go`）：xcodec 去重协议中，`ADVANCE` 告知对端「你发的前 N 帧我已处理完，可以释放引用」——它是**发送窗口的释放凭证**。若 ADVANCE 抢在对应明文数据转发之前到达对端，对端会认为窗口已放开而继续猛发，**本地队列里积压的明文就超出了窗口约束**（内存失控）。所以 `splitResponses` 把 ADVANCE/EOS_ACK 挂到数据 delivery 的 `responses` 字段，`forward` 在**数据写出之后**才 push 进控制队列；ASK/LEARN（缓存查询/学习）与流量控制无关，走立即通道，保证读侧不被应用背压卡住（否则死锁，见 Q46）。

### Q48. flowQueue 的容量控制与背压策略？

**事实基线**（`flow.go`）：字节配额 `relayQueueLimit = 16 << 20`（16 MiB）。两种入队策略：

- `push`（codec 路径）：超限**立即返回 `xcodec.ErrSessionLimit` 断流**——因为读侧不能停（要继续处理交叉控制帧，停了就死锁），只能失败整条连接；
- `pushContext`（纯数据源）：超限时**等待 `changed` 信号重试**（select ctx.Done），即普通读背压——源没有交叉流量，停下来安全。

出队 `pop` 阻塞在 `changed`（close-重建广播模式）。**采分点**：同一个队列类型，按「源是否有交叉控制流量」选择 fail-fast 或 backpressure，这是协议感知的流控设计，不是拍脑袋。

### Q49. wireWriter 怎么保证「帧原子性 + 立即上 wire」？

**事实基线**（`wanproxy.go/proxy/wire.go`）：`wireWriter` 持 `mu sync.Mutex` 串行化所有写（数据帧与控制帧共享一条 socket，交错即损坏）；可选 zlib deflate 时**每次 Write 后 `zw.Flush()`**——注释对齐 C++ DeflatePipe 的 `Z_SYNC_FLUSH` 语义：压缩流不 flush 会滞留在压缩器内部缓冲，交互协议（ASK 等应答）延迟不可控；无压缩时 `writeFull` 循环处理**短写**（`io.Writer` 契约允许 n < len(p)，`n<=0 || n>len(p)` 判 `io.ErrShortWrite`）。`Close` = 压缩器 Close（flush 尾部）+ `closeWrite`（探测 `CloseWrite() error` 接口做 TCP 半关闭）；半关后再写返回 `errWireClosed`。

### Q50. 网关的可观测性在这个项目里怎么落地？

**事实基线**：

- **字节级计数器**：`relay.go` 的 `countCodecToIncoming/Outgoing`、`countBoundarySend/Receive` 在管线四个边界（incoming↔codec、codec↔outgoing）用 atomic 计数（`spec.Stats.CodecToIncoming.Add(int64(n))`），`TrackStatistics` 开关控制是否套 countingReader/Writer（不统计时零开销、且保住 io.Copy 优化路径）——**压缩率/去重率 = 边界字节数之比**，README 的 Dashboard 直接展示 codec compression ratios；
- **监控端点**：proxy 进程暴露 HTTP monitor `:9901/status`（README），srv.go 的 `monitorStatus` handler 把它**原样透传**（`ctx.Data(raw)` + 显式 `Content-Type: application/json`，失败映射 502 Bad Gateway——上游监控不可达是网关错误不是客户端错误）；
- **请求日志**：`httpLog` 记录状态/方法/URI/耗时（Round 到微秒）；框架自带 `Logger()` 同构。

**方案推导**（面试延伸）：生产网关再加 RED 指标（Rate/Errors/Duration 直方图）、连接级指标（活跃连接、relay 时长分布）、按路由/租户维度打标签，以及 416/409/502 这类**语义状态码的告警分级**——本项目已把状态码用得很准（409=bench 忙、501=daemon 不可用、502=监控上游失败），这是可观测性的前提。

### Q51. 网关限流算法怎么选型？项目里的 TokenBucket 是真正的令牌桶吗？

| 算法     | 突发容忍            | 实现成本       | 缺陷                    |
| -------- | ------------------- | -------------- | ----------------------- |
| 固定窗口 | 差（临界双倍）      | 最低           | 窗口边界突刺            |
| 滑动窗口 | 中                  | 中（时间分格） | 内存随精度上升          |
| 漏桶     | 无（恒速流出）      | 低             | 无法利用空闲期配额      |
| 令牌桶   | 好（桶容量=突发量） | 低             | 参数（速率+容量）需调优 |

**事实基线（命名与实现的差异，主动指出是采分点）**：`libs/yukino_rpc/internal/limiter/token_bucket.go` 的 `TokenBucket` 实现是——`NewTokenBucket(rate)` 初始 `tokens=rate`，后台 ticker **每秒把 tokens 重置为 rate**，`Allow()` 有令牌则减一。这是**固定窗口计数**（每秒刷新配额），不是经典令牌桶（按时间连续滴入、桶容量独立于速率）：它允许窗口开头的 `rate` 个请求瞬时突发，但**跨窗口不能累积配额**，也没有独立的 burst 参数。yukino_rpc 的 server/client 都以 `NewTokenBucket(10000)` 作为默认自保护（每秒 1 万次）。面试表述：「项目里叫 TokenBucket，实现语义是每秒重置的固定窗口，够用且无锁竞争外的开销；若要真令牌桶，把重置改为 `tokens = min(cap, tokens + rate*elapsed)` 的惰性计算即可」——既尊重代码事实，又展示算法理解。

### Q52. HTTP 网关与 RPC 服务的优雅关闭有何异同？

**事实基线**：

- HTTP 侧（`libs/yukino_http/yukino.go`）：`Shutdown(ctx)` 直接委托 `http.Server.Shutdown`——停止 Accept、**等待在途请求完成**（或 ctx 超时后强制），长连接（SSE/WS 已 Hijack 的除外）会被标记关闭。
- RPC 侧（`libs/yukino_rpc/internal/server/server.go`）：`GracefulStop` 四步——`beginShutdown`（`shutdownOnce` 保证幂等：close(closing) + 关 listener）→ `serveWg.Wait()`（accept 循环退出）→ **对所有在册连接 `SetReadDeadline(time.Now())`** → `wg.Wait()`（连接 goroutine 退出）→ 停限流器。

差异的根源：HTTP 有「请求」边界，Server 能数在途请求；自定义 TCP 协议里连接是长驻的，`Read` 永久阻塞，**没有事件能自然唤醒它**——所以用「已过期的读 deadline」人为制造读错误，让 `Handle` 循环退出。`Stop()`（强制版）则直接 `conn.Close()`。追问预案：正在流式推送的 stream 怎么办？——`Handle` 里 `defer streamWg.Wait()` 在 `conn.Close()` 之前执行，流式方法先收敛再断连（见 [RPC 与网络编程](/interview/qa/rpc-and-network)）。

### Q53. 这个仓库的压测与 A/B 实验体系是怎么设计的？网关容量结论如何得出？

**事实基线**（`wanproxy/srv.go`，README）：

- **确定性负载**：`payload.NewReader(pattern, size, seed)` 生成 mixed/repeat/text/random 四种模式的字节流，默认 `seed=42`——**同参数必同字节**，A/B 各臂传输完全相同的 payload，排除数据差异干扰；
- **实验编排**：`POST /api/bench/experiment` 多臂对照（direct vs passthrough/zlib/XCodec/WAN 链/SOCKS/SSH 链），每臂多次迭代、含 warm-up 曲线，产出 wire-byte 判决（相对 baseline 臂）；`ErrAlreadyRunning` → 409 保证**同一时刻只有一个实验**（避免互相干扰测量）；
- **冷缓存控制**：`POST /api/daemon/restart` 带 `clearCache` 选项删除 XCDFS 卷——去重缓存的冷热直接决定 XCodec 臂的压缩率，**不控制缓存状态的去重对比是无效实验**；
- **测量点**：Q50 的四边界字节计数器给出应用字节 vs wire 字节，压缩率/去重率是**计数器之比**而非估算。

**方案推导**（面试表述容量结论的口径）：任何「网关能扛 X Gbps / Y QPS」都必须带：硬件与内核参数、并发连接数、payload 模式与尺寸、codec 配置、测量边界（应用层还是 wire 层）、迭代次数与方差。这个仓库的实验框架恰好把这些变量全部显式化（seed/pattern/size/arm/iteration/clearCache），是「容量数字怎么来的」的标准答案模板。

## 速记卡

- **生命周期**：ServeHTTP 按前缀收集中间件 → newContext（默认 404）→ trie 查找 → compose 洋葱 → 链后统一 `respond()` 延迟渲染。
- **compose**:`index` 单调检测 next 重入，重复调用直接 panic；final 的 next 是空函数。
- **trie**：每 method 一棵树；`matchChildren` 精确优先、通配兜底；`*` 段 break + HasPrefix 提前命中；`:x` 单段、`*x` 贪婪拼接；404 也走中间件链。
- **TakeOver**：幂等、拷缓冲头、不写状态不包 Writer（保 Flusher）；SSE/WS/FileServer/大文件全靠它；配 statusRecorder 保住日志状态码。
- **respond**:flushed 跳过；204/205/304 清 body 与三个头；Body 类型分派 htmlPayload/[]byte/string/io.Reader/JSON；marshal 失败还能改 500（头未提交）。
- **SSE**：三头 + TakeOver + 立即 WriteHeader(200)；多行 data 拆行；mutex 保帧原子；Heartbeat 三路 select + once/done 停止协议；`[DONE]` 哨兵。
- **WS**：六步握手校验（Origin/GET/Connection/Upgrade/Version13/Key）；accept = base64(sha1(key+GUID))；客户端帧必须 masked；控制帧 fin 且 ≤125；默认消息上限 65536；Hijack 后清 deadline、接续 bufio 预读。
- **cors 双 apply**:Recovery 清缓冲头，next 后重设保住 500 的 CORS 头；OPTIONS 204 短路。
- **Relay**：纯转发 io.Copy 保零拷贝；codec 路径 6 goroutine + 4 flowQueue，读侧永不等写侧；ADVANCE/EOS_ACK 延迟到数据之后（窗口语义），ASK/LEARN 立即（防死锁）。
- **flowQueue**:16MiB 字节配额；codec 源 fail-fast（ErrSessionLimit），纯源背压等待；小读合并 32KB 块，控制帧不拆分。
- **wireWriter**:mutex 串行 + 每写必 Flush（Z_SYNC_FLUSH 语义）+ writeFull 短写循环 + CloseWrite 半关。
- **大文件**：全链路流式（Store/io.Copy/CopyN/sha256），4GiB 只是参数上限；Range 非法 → 416 + `bytes */total`。
- **限流**：项目 TokenBucket 实为每秒重置的固定窗口（rate=10000 默认）；优雅关闭用 SetReadDeadline(now) 唤醒阻塞读。
- **压测口径**：seed=42 确定性 payload、单实验互斥（409）、clearCache 冷启动控制、四边界字节计数器出压缩率。

## 延伸阅读

[Go 语言与运行时](/interview/qa/go-language-runtime) · [RPC 与网络编程](/interview/qa/rpc-and-network) · [服务架构与任务系统](/interview/qa/service-architecture) · [Go 并发模型与 AI 网关工程](/interview/fundamentals/backend-go-gateway) · [大 Body 与并发容量](/interview/answers/large-payload-capacity) · [全量题库](/interview/question-bank)
