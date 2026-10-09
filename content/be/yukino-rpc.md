---
title: "yukino_rpc 技术笔记"
description: "yukino_rpc 自研 Go RPC 框架: 二进制线协议、单连接多路复用、Future 异步模型、服务端流式 RPC、熔断限流负载均衡与 etcd 服务发现"
local_path: "$HOME/github/yukino.go/libs/yukino_rpc"
---

yukino_rpc 是一个自研的 Go RPC 框架, 对外 API 对齐 grpc-go 的使用习惯, 底层则使用自定义的 TCP 二进制协议。它在一条 TCP 连接上实现请求多路复用, 提供 Future 形式的异步调用、服务端流式 RPC、连接池、三态熔断、令牌桶限流、三种负载均衡策略以及基于 etcd v3 的服务注册与发现。本文面向需要理解 RPC 框架内部机制、评估自研协议取舍, 或准备在此基础上二次开发的工程师, 覆盖线协议、传输层、异步模型、服务端反射分发、治理组件与容错语义。etcd 与 gRPC 的通用机制不在本文展开, 见[中间件与可观测性](middleware)。

## 定位与分层架构

框架把"对外稳定契约"与"内部可重构实现"彻底分开: 公开包只做类型别名与门面转发, 全部实现放在 `internal/` 下, 借助 Go 编译器对 `internal` 的导入限制保证外部用户只能依赖公开契约。

| 层次                                                          | 职责                                                                        |
| ------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `pkg/rpc`                                                     | 公开门面: `Server`、`ClientConn`、`Dial`、`NewServer`、类型别名、codec 标识 |
| `pkg/api`                                                     | 示例服务 (Arith) 与消息类型                                                 |
| `internal/server`                                             | Accept 循环、反射方法分发、流式处理、优雅关闭                               |
| `internal/client`                                             | 注册模式调用管线: 限流 → 发现 → 熔断 → 连接池 → 发送                        |
| `internal/transport`                                          | TCP 连接封装、帧缓冲、请求多路复用、Future、流连接、连接池                  |
| `internal/protocol`                                           | 二进制帧编解码、Magic 校验、Header 序列化                                   |
| `internal/codec`                                              | Codec 注册表、JSON/Protobuf 实现、Gzip 压缩                                 |
| `internal/breaker` `internal/limiter` `internal/load_balance` | 熔断、限流、负载均衡                                                        |
| `internal/registry`                                           | etcd v3 注册、发现、Watch                                                   |
| `internal/stream`                                             | `ServerStream`/`ClientStream` 接口定义, 避免包间耦合                        |

`internal/stream` 之所以单独成包, 是因为服务端需要用 `ServerStream` 接口做反射类型匹配, 客户端需要用 `ClientStream` 作为流调用返回类型; 若把接口定义在 server 或 client 包, 就会产生不必要的互相导入。独立的接口包让 server、client 与 `pkg/rpc` 三方都只依赖接口, 而 transport 层的流连接可以隐式实现接口而不必导入它。

```text
        pkg/rpc (类型别名 / Dial / NewServer)
        |                             |
  internal/server              internal/client
  反射分发 / 流式             熔断 / 限流 / LB / 连接池
        |                             |
        +-------------+---------------+
                      |
              internal/transport
        TCPConnection / TCPClient / Future / Stream / Pool
                      |
               internal/protocol
              Header + Message (二进制帧)
                      |
                internal/codec
              JSON / Protobuf / Gzip
```

## 公开 API 能力面

公开门面通过类型别名 (type alias) 而非类型定义暴露内部类型, 因此 `rpc.Future` 与 `transport.Future` 是同一个类型, 用户可以直接调用其全部导出方法。

| 类别     | 内容                                                                                                                  |
| -------- | --------------------------------------------------------------------------------------------------------------------- |
| 类型别名 | `CodecType`、`Registry`、`Instance`、`LoadBalancer`、`Future`、`ServerStream`、`ClientStream`                         |
| Codec    | `CodecJSON`、`CodecProto` (包级变量, 取值为 codec 类型 1 与 2)                                                        |
| 工厂     | `NewRegistry(endpoints)`                                                                                              |
| 服务端   | `NewServer(opts...)`、`Register(name, service)`、`Serve(lis)`、`GracefulStop()`、`Stop()`                             |
| 客户端   | `Dial(target, opts...)`、`Invoke(ctx, service, method, args, reply)`、`InvokeAsync(...)`、`NewStream(...)`、`Close()` |

服务端与客户端可配置项都很少, 治理参数目前是硬编码的:

| 选项                   | 适用对象 | 说明                                     |
| ---------------------- | -------- | ---------------------------------------- |
| `WithCodec(t)`         | 服务端   | 默认 JSON, 可切 Protobuf                 |
| `WithTimeout(d)`       | Dial     | 每次调用的超时, 默认 5s                  |
| `WithDialCodec(t)`     | Dial     | 请求与响应使用的 codec                   |
| `WithRegistry(reg)`    | Dial     | 启用 etcd 发现模式, 此时 `target` 被忽略 |
| `WithLoadBalancer(lb)` | Dial     | 注册模式下的负载均衡策略, 默认轮询       |

## 线协议

每一帧的布局固定为 10 字节前缀加两段变长载荷:

```text
+--------+-----------+---------+------------------+---------------+
| Magic  | HeaderLen | BodyLen |  Header (JSON)   |  Body (bytes) |
| 2 byte |  4 byte   | 4 byte  |     N byte       |     M byte    |
+--------+-----------+---------+------------------+---------------+
  0x1234    大端 uint32  大端 uint32   长度 N            长度 M
```

| 字段                    | 取值                     | 作用                                                         |
| ----------------------- | ------------------------ | ------------------------------------------------------------ |
| `Magic`                 | `0x1234`                 | 帧同步与脏数据跳过                                           |
| `HeaderLen` / `BodyLen` | uint32 大端              | 描述后续两段长度                                             |
| `Header`                | 始终 JSON                | 控制信息: 请求 ID、服务名、方法名、错误、codec、压缩、流标志 |
| `Body`                  | 由 codec 决定, 通常 Gzip | 业务载荷                                                     |

Header 结构承载的控制字段如下:

| 字段                         | 类型            | 含义                                     |
| ---------------------------- | --------------- | ---------------------------------------- |
| `RequestID`                  | uint64          | 连接内单调递增, 多路复用的路由键         |
| `ServiceName` / `MethodName` | string          | 服务端反射分发依据                       |
| `Error`                      | string          | 非空表示错误响应或流错误                 |
| `CodecType`                  | byte            | 1=JSON, 2=Protobuf; 0 表示跟随服务端默认 |
| `Compression`                | byte            | 0=不压缩, 1=Gzip                         |
| `StreamFlag`                 | byte, omitempty | 0=unary, 1=流数据, 2=流结束, 3=流错误    |

Header 之所以不随 Body 切换 codec, 有三个原因: 一是自举问题, Header 要携带 `CodecType` 告诉对端 Body 的编码方式, 若 Header 也用 Protobuf, 双端必须在毫无协商信息时就 Header 编码达成一致; 二是可调试性, JSON Header 可以直接人工阅读; 三是收益小, Header 通常只有上百字节, 而 Body 可能是 KB 到 MB 级, 紧凑编码的收益应留给 Body。`StreamFlag` 使用 `omitempty`, unary 帧不会带上该字段, 略微减小 Header。

解码前会做溢出检查: `uint64(10) + headerLen + bodyLen > math.MaxInt` 时直接拒绝, 避免在 32 位平台上发生整数回绕导致越界。

帧同步由 `PacketBuffer` 负责。它是 TCP 字节流之上的粘包/拆包处理器, 读取逻辑分四步: 循环丢弃前导字节直到缓冲区以 Magic 开头 (恢复被脏数据破坏的同步); 不足 10 字节则返回 nil 等待更多数据; 解析长度后若帧体不完整也返回 nil; 否则拷贝出完整帧并推进缓冲区。外层 `TCPConnection.Read` 每次从 `bufio.Reader` (4096 字节) 补充数据, 直到 `PacketBuffer` 能产出一帧为止。

## 编解码与压缩

Codec 通过全局工厂注册表实现插件化: `Register(type, factory)` 在重复注册或工厂为 nil 时 panic, `New(type)` 对未注册类型返回 `codec: type %d not registered`。JSON (Type=1) 与 Protobuf (Type=2) 在各自 `init()` 中注册。Protobuf codec 在 `Marshal`/`Unmarshal` 内部做 `v.(proto.Message)` 断言, 普通 struct 会返回 `proto codec: not proto.Message`, 因此使用 Protobuf 时请求与响应必须是 `.proto` 生成的结构体。

压缩同样是注册表结构, 默认只注册 Gzip。`RegisterCompressor` 虽然导出, 但其参数是未导出的 `compressor` 接口, 外部包无法实现, 因此当前实际上不可扩展。

发送路径硬编码 `Compression: CompressionGzip`: unary 请求、unary 响应、错误响应、流数据帧全部默认 Gzip。这简化了配置, 对大载荷有明显带宽收益; 代价是小载荷 (几十字节) 下 Gzip 头与压缩开销可能让帧变大, 且每帧一次 gzip writer/reader 的 CPU 开销在高 QPS 下不可忽略, 目前无法通过配置关闭。

## 传输层与多路复用

`TCPConnection` 封装 `net.Conn`, 持有一个 `bufio.Reader` 与一个 `PacketBuffer`; 写操作由 `writeMu` 串行化, 保证多 goroutine 共享连接时帧不会交错。它的 `Close` 对底层 `*net.TCPConn` 调用 `SetLinger(0)`, 使关闭发送 RST 而非 FIN: 立即释放 socket、不进入 TIME_WAIT, 代价是对端收到的是 "connection reset by peer" 而不是 EOF。

`TCPClient` 在单条连接上实现多路复用, 核心状态是:

| 字段      | 类型            | 作用                                       |
| --------- | --------------- | ------------------------------------------ |
| `seq`     | `atomic.Uint64` | 递增分配请求 ID, 从 1 开始                 |
| `pending` | `sync.Map`      | `RequestID -> *Future`, unary 响应路由     |
| `streams` | `sync.Map`      | `RequestID -> *ClientStreamConn`, 流帧路由 |
| `closed`  | `atomic.Int32`  | 关闭标志                                   |
| `writeMu` | `sync.Mutex`    | 帧写入串行化                               |

发送时先分配 `RequestID`, 把 Future 或流连接以 ID 为键存入对应 map, 再写帧; 唯一的 `readLoop` goroutine 持续读帧, 按 `Header.StreamFlag` 分用: 流数据推入对应流连接的缓冲 channel, 流结束/流错误触发终结信号, unary 响应从 `pending` 取出并 `Done`。多个 goroutine 可以并发发起调用, 各自拿到独立 Future, 所有响应由同一个 readLoop 分用, 避免每请求一个 goroutine。

有两个容易忽略的竞态处理:

- `SendAsyncWithCodec` 在 `pending.Store` 之后会再次检查 `closed`; 若连接在此期间已被关闭 (shutdown 已遍历过 pending), 就主动删除刚存入的条目并返回错误, 否则该 Future 永远不会被 `Done`, 调用者永久阻塞。
- `shutdown` 用 `closed.CompareAndSwap(0, 1)` 保证只执行一次, 然后关闭连接、遍历 `pending` 逐个 `Done(nil, err)`、遍历 `streams` 逐个 `Error(err)`。由于 `Future.Done` 自身幂等, readLoop 已经完成的响应与 shutdown 的补刀不会冲突。这保证连接断开时所有阻塞在 `Wait`/`GetResult`/`Recv` 的调用者都能返回。

`ConnectionPool` 按地址维护一组 `TCPClient`。所有调用点都传 `maxActive=1`, 即每个地址只保留一条连接、所有请求多路复用; 构造签名 `NewConnectionPool(addr, maxIdle, maxActive)` 中的 `maxIdle` 被接受却从未存储或使用, 实际只有 `maxActive` 生效。`Acquire` 在持锁状态下拨号 (`net.DialTimeout` 5s), 并在发现死连接时从切片中剔除、按住 round-robin 游标继续找可用连接, 找不到才重新拨号。这里有两个已知瓶颈: 拨号期间 `mu` 一直被持有, 目标不可达时所有并发 Acquire 会串行等待, 最坏情况是 N 个调用者各等一次 5 秒; `ctx` 只在入口做一次非阻塞检查, 不会传入拨号过程, 调用者取消后拨号仍会继续。

## Future 异步调用模型

`Future` 是连接无关的异步句柄, 支持阻塞等待、带上下文等待、超时等待、完成回调与直接反序列化。`Done` 的幂等性是整套机制的基础:

```go
func (f *Future) Done(res []byte, err error) {
    f.mu.Lock()
    if f.complete {
        f.mu.Unlock()
        return
    }
    f.res, f.err, f.complete = res, err, true
    onComplete := f.onComplete
    f.mu.Unlock()

    if onComplete != nil { onComplete(err) }
    close(f.done)
}
```

需要幂等的典型场景有三类: 客户端超时后调用 `Done(nil, DeadlineExceeded)`, 之后迟到的服务端响应再次 `Done`; 连接断开触发 shutdown 遍历, 而 readLoop 可能已经处理过该响应; 异步看门狗定时器与正常响应同时到达, 两个 goroutine 竞争 `Done`, 只有第一个生效。回调在锁外执行, 避免回调内部 (例如断路器加锁) 与 Future 锁形成死锁; `OnComplete` 在 Future 已完成时会立即执行, 不会丢失。

异步调用返回 Future 后会启动一个看门狗 goroutine: 用 `time.NewTimer(c.timeout)` 等待, 正常完成则回收定时器, 超时则 `Done(nil, DeadlineExceeded)`, 从而触发 `OnComplete` 让断路器记录失败。同步 `Invoke` 则用 `context.WithTimeout` 包裹发送与等待, 但超时后的收尾在两种模式下并不一致: 注册模式的 `Client.Invoke` 在 `GetResultWithContext` 返回错误且 `callCtx.Err() != nil` 时会主动 `future.Done(nil, callCtx.Err())`, 既让断路器记录失败, 又使后续迟到的响应成为幂等 no-op; 静态模式的 `invokeStatic` 只把 `ctx.Err()` 返回给调用者, 并不主动 `Done`, 该 Future 要等 readLoop 收到迟到响应或连接 `shutdown` 遍历 `pending` 时才会被解决。

## 服务端

服务端每个连接一个 `Handle` goroutine: 循环阻塞读帧, 先过令牌桶限流, 再按 `ServiceName` 查表并交给反射分发的 `Process`。`Register` 只往 `services` map 写服务实例, 方法签名的合法性在调用时而非注册时校验, 因此注册一个形状不合法的服务不会报错, 直到客户端实际调用才返回 `unsupported method signature`。

反射分发按优先级匹配三种签名:

| 签名                | 形状                                              | 匹配要点                                                                           |
| ------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------- |
| grpc-go 风格 (推荐) | `Method(ctx context.Context, req *T) (*R, error)` | 两个输入、两个输出, 入参 0 实现 Context, 入参 1 与出参 0 为指针, 出参 1 实现 error |
| net/rpc 风格        | `Method(req *T, reply *R) error`                  | 两个输入、一个输出, 入参均为指针, 入参 1 不实现 ServerStream                       |
| 服务端流            | `Method(req *T, stream ServerStream) error`       | 形状同上, 但入参 1 实现 ServerStream                                               |

调用时先用 `reflect.New` 分配请求对象, `len(body) > 0` 才反序列化 (空 body 跳过), 再用 `safeCall` 执行。`safeCall` 用 `defer` + `recover` 把业务 panic 转成 `handler panic: <value>` 错误, 通过 `Header.Error` 写回客户端, 连接处理 goroutine 继续服务后续请求, 因此单个请求的 panic 不会拖垮进程。

Codec 协商由客户端驱动: 每次请求在 `Header.CodecType` 中声明期望 codec, 服务端优先使用它来解码请求并编码响应; `CodecType == 0` 时回退到服务端默认 codec。Header 始终 JSON, 因此 `WithDialCodec(CodecProto)` 的客户端可以透明地与默认 JSON 的服务端通信, 只要类型实现了 `proto.Message`。

单连接上的并发语义值得注意: unary 请求是串行处理的, `Process` 同步执行 handler 并写回响应后才回到读循环, 因此一个耗时 10 秒的 unary handler 会阻塞该连接上后续所有 unary 请求; 流式请求则在独立 goroutine 中运行 (由连接的 `streamWg` 追踪), `Process` 立即返回继续读循环, 因此流不会阻塞同连接上的其它请求。连接退出时 `defer` 的 LIFO 顺序保证先 `streamWg.Wait()` 等所有流完成, 再关闭连接。

服务端目前始终用 `context.Background()` 调用 handler, handler 侧拿到的 `ctx` 与客户端请求生命周期没有绑定, 客户端的取消与超时不会传播到服务端。

两种关闭方式的差异:

| 维度         | `GracefulStop`                                  | `Stop`                        |
| ------------ | ----------------------------------------------- | ----------------------------- |
| 新连接       | 关闭 listener, 不再 Accept                      | 同左                          |
| 空闲连接     | `SetReadDeadline(now)` 中断阻塞读, 连接自然退出 | `conn.Close()` 强制关闭 (RST) |
| 进行中请求   | 等待完成                                        | 不等待                        |
| 流式 handler | 等待 `streamWg` 完成                            | 不等待                        |
| 返回时机     | 所有 handler 完成后                             | 关闭连接后立即返回            |

`GracefulStop` 的流程是: `beginShutdown` (只执行一次: 关闭 `closing` 信号与 listener) → `serveWg.Wait` 等 Accept 循环退出 → 给所有连接设 `SetReadDeadline(time.Now())` 打断空闲读 → `wg.Wait` 等所有连接 goroutine (含流) 完成 → 停止限流器。`SetReadDeadline(now)` 让空闲连接立即退出, 而正在处理请求的连接会在 handler 返回后的下一次 Read 才退出。`Stop` 在 `GracefulStop` 之后调用仍然有效, 因为只有 listener 关闭受 `sync.Once` 保护。

## 流式 RPC

框架只支持服务端流 (server streaming), 协议中 `StreamFlag` 的四个取值全部用于服务端到客户端方向, 没有定义客户端发送流数据的 codepoint。这覆盖了"服务端推送多条消息"的常见场景, 同时把协议复杂度压到最低。

服务端流的生命周期: 客户端发送一个携带服务名与方法名的 unary 请求帧; 服务端匹配到流签名后构造 `serverStream`, 在独立 goroutine 中运行业务 handler; 业务代码循环 `Send`, 每个消息编码为一帧 `StreamFlag=StreamData`; handler 正常返回后框架发送 `StreamEnd` 空帧, 返回 error 则发送 `StreamError` (错误写入 Header.Error)。

客户端侧 `ClientStreamConn` 用带缓冲 channel 解耦 readLoop 与业务消费:

| 元素     | 设计                                           |
| -------- | ---------------------------------------------- |
| 数据缓冲 | `chan streamFrame`, 容量 64                    |
| 终结信号 | 独立的 `termCh`, 由 `sync.Once` 保证只关闭一次 |
| 终结错误 | `termErr`, 取值 `io.EOF` 或具体错误            |
| 上下文   | 由调用方 ctx 派生, 支持提前取消                |

终结状态为什么要走带外的 `termCh` 而不是往数据 channel 里塞特殊帧: 当 64 个数据帧填满缓冲后, 若把 `End()`/`Error()` 也写成对同一 channel 的发送, readLoop 会被阻塞, 进而阻塞该连接上所有其它请求与流的分用。`close(termCh)` 是非阻塞的, 无论缓冲是否已满都能立即送达。

`Recv` 实现了 drain-before-terminal 语义: 先非阻塞尝试取一帧 (快速路径), 再阻塞等待; 当 `termCh` 关闭时, 还会再尝试从缓冲里取一帧, 只有确实取不到才返回 `termErr`。这是必要的, 因为 readLoop 虽然按序先 Push 数据帧再 End, 但数据帧可能仍停留在 channel 缓冲中; 若一看到终结信号就返回 EOF, 已到达的数据帧会丢失。

流式调用的断路器统计由 `observedStream` 装饰器完成: `Recv` 返回 `io.EOF` 记成功, `context.Canceled` 视为调用方主动取消而不计入失败, 其它错误记失败, `sync.Once` 保证每个流最多记录一次。

## 客户端治理管线

注册模式下每次 `Invoke`/`InvokeAsync`/`InvokeStream` 都经过同一条管线:

```text
1. limiter.Allow()                         失败 -> "rate limit exceeded"
2. registry.Discover(service) + lb.Select  失败 -> "no instance available" / 空地址
3. breaker.Allow()  [key = service|addr]   失败 -> "circuit breaker open"
4. pool.Acquire(ctx)   每个地址一个连接池
5. codec.Marshal(args)
6. TCPClient.SendAsyncWithCodec / SendStream
7. future.OnComplete -> breaker.RecordSuccess / RecordFailure
```

静态模式与注册模式的差异:

| 维度     | 静态模式 (带 target 的 Dial) | 注册模式 (WithRegistry)          |
| -------- | ---------------------------- | -------------------------------- |
| 寻址     | 固定 target 地址             | etcd 发现 + 负载均衡             |
| 限流     | 无                           | 客户端令牌桶 (10000/s)           |
| 熔断     | 无                           | 三态断路器                       |
| 负载均衡 | 无 (单地址)                  | RoundRobin / Random / WeightedRR |
| 连接管理 | 单个连接池                   | 每地址一个池 (`sync.Map` 懒创建) |
| 实现     | 直接操作 transport           | 委托 `internal/client.Client`    |

断路器的三态机如下, 参数硬编码为窗口 10、失败率阈值 0.6、打开后等待 5s:

```text
           失败率 >= 60% 且窗口已满
  Closed -------------------------> Open
    ^                                |
    | 探测成功                       | openTimeout (5s) 过期
    |                                v
    +--------------------------- HalfOpen
                                     |
                                     | 探测失败
                                     v
                                    Open
```

Closed 状态累计成功与失败计数, 窗口满 (`success + failure >= 10`) 时若失败率不低于 0.6 则转 Open, 否则清零开始新一轮统计。Open 状态拒绝请求, 超过 5s 后下一次 `Allow` 转 HalfOpen 并放行一个探测请求, `halfOpenProbe` 标志确保同一时刻只有一个探测者; 探测成功转 Closed 并清零, 失败转回 Open 重新计时。所有状态转换由单个 `sync.Mutex` 保护。

令牌桶 `TokenBucket` 实际上是固定窗口限流器: 初始 tokens 等于 rate, 后台 goroutine 每秒用 ticker 把 tokens 重置为 rate, `Allow` 只是加锁减一。它不是按时间平滑补充, 因此窗口边界理论峰值可达 2x burst。服务端与注册模式客户端统一传 10000, 未通过选项暴露。

三种负载均衡策略:

| 策略         | 同步方式                   | 适用场景              | 注意点                                                                          |
| ------------ | -------------------------- | --------------------- | ------------------------------------------------------------------------------- |
| `RoundRobin` | `atomic.Uint64`, 无锁      | 实例配置均匀          | 第一次从 index 0 开始                                                           |
| `Random`     | `sync.Mutex` + `rand.Rand` | 实例多、统计均匀即可  | `rand.Rand` 非并发安全, 必须加锁                                                |
| `WeightedRR` | `sync.Mutex`               | 实例配置不均匀 (混部) | 按切片下标匹配 weights, 要求 `len(list) == len(weights)`, 权重和为 0 时返回零值 |

这三个策略都定义在 `internal/load_balance` 中, 公开门面只别名了 `LoadBalancer` 接口, 没有重新导出它们的构造函数。因此注册模式客户端要么接受默认的轮询, 要么自行实现 `Select([]rpc.Instance) rpc.Instance` 并经 `WithLoadBalancer` 注入; 内置的 `Random` 与 `WeightedRR` 对包外不可达。

`WeightedRR` 使用平滑加权轮询 (Nginx 算法): 每轮把 weights 累加到 currentWeight, 选最大者, 再把它减去总权重, 从而产出平滑交错的比例分配。它与 etcd Registry 组合时有一个实质性风险: `Registry.copyInstances` 从 `map[string]Instance` 构建切片, Go 的 map 迭代顺序是随机的, 因此每次 `Discover` 返回的实例顺序不同, `weights[i]` 对应的实例每次都可能变化, 流量分配会错乱。要让权重稳定生效, 需要保证实例列表按地址排序, 或只与静态有序列表配合。

`InvokeAsync` 的管线中有一个统计盲区: 若 `codec.Marshal(args)` 失败, 函数直接返回错误, 既不 `RecordFailure` 也不返回可供注册回调的 Future, 于是这次已经通过 `breaker.Allow()` 的调用不会计入窗口。其余失败路径 (Acquire 失败、写帧失败、超时、响应错误) 都能被断路器统计到。

## 服务注册与发现

注册基于 etcd v3 的租约: `Register(service, instance, ttl)` 先 `Grant(ttl)` 拿到租约, 再以 `/github.com/hangtiancheng/yukino.go/libs/yukino_rpc/services/<service>/<addr>` 为 key、租约 ID 写入实例地址, 最后启动 `KeepAlive` 并派一个 goroutine 排空续约 channel 以维持租约。需要注意, 这里的续约 goroutine 在 channel 关闭后直接退出, 没有重新 `Grant` 的逻辑: 若 etcd 抖动或网络分区导致续约失败, 实例 key 会在 TTL 到期后消失且不会自动恢复, 属于当前实现的可靠性缺口。

发现采用"全量 + Watch"的标准模式: 首次 `Discover` 用带前缀的 `Get` 拉取该服务全部实例, 建立 `map[addr]Instance` 缓存, 并启动 `watch(service)` 监听增量事件; 之后命中缓存即返回防御性拷贝。Watch 对 PUT 事件写入实例、对 DELETE 事件按 key 前缀解析地址后删除; 若 watch channel 关闭, 则退避 1 秒重建。一致性级别是最终一致: 新实例上线有事件延迟, 下线实例在 DELETE 事件到达前仍可能被选中。

## 并发模型与同步原语

| 原语             | 使用位置                                                                                  | 解决的问题                 |
| ---------------- | ----------------------------------------------------------------------------------------- | -------------------------- |
| `sync.Mutex`     | `TCPConnection.writeMu`、`TCPClient.writeMu`                                              | 帧写入原子性               |
| `sync.Mutex`     | `PacketBuffer.lock`                                                                       | 缓冲区的 append 与读取     |
| `sync.Mutex`     | `ConnectionPool.mu`                                                                       | 连接切片与拨号逻辑         |
| `sync.Mutex`     | `Future.mu`                                                                               | 结果、错误、完成标志与回调 |
| `sync.Mutex`     | `CircuitBreaker.mu`                                                                       | 三态转换                   |
| `sync.Mutex`     | `TokenBucket.mu`、`Random.m`、`WeightedRR.mu`                                             | 计数与 rand 源             |
| `sync.RWMutex`   | `Registry.mu`、codec/compressor 注册表                                                    | 读多写少的缓存与注册表     |
| `sync.Map`       | `TCPClient.pending/streams`、`Client.pools/breaker`                                       | 高并发懒初始化键值映射     |
| `sync.Once`      | `Server.shutdownOnce`、`TokenBucket.once`、`ClientStreamConn.once`、`observedStream.once` | 单次关闭/终结/统计         |
| `sync.WaitGroup` | `Server.wg/serveWg`、连接局部 `streamWg`                                                  | 关闭与流完成的等待         |
| `atomic`         | `TCPClient.seq/closed`、`RoundRobin.idx`                                                  | 无锁计数与关闭标志         |
| channel          | `Future.done`、`ClientStreamConn.termCh`、`Server.closing`、`TokenBucket.stop`            | 一次性广播与唤醒           |

`sync.Map` 被选用于两处 key 空间不重叠且读写接近 1:1 的场景 (`pending`/`streams`: 每个 RequestID 恰好一次 Store、一次 LoadAndDelete), 以及"初始化后基本只读"的场景 (`pools`/`breaker` 用 `LoadOrStore` 懒创建)。这与 `sync.Map` 的适用条件一致, 避免了在这些热路径上加全局锁。

## 错误模型

| 错误信息                                           | 来源                 | 说明                            |
| -------------------------------------------------- | -------------------- | ------------------------------- |
| `service not found: <Service>`                     | 服务端               | 服务名未注册                    |
| `method not found: <Service>.<Method>`             | 服务端               | 方法不存在                      |
| `unsupported method signature: <Service>.<Method>` | 服务端               | 签名不匹配三种受支持形状        |
| `handler panic: <value>`                           | 服务端 `safeCall`    | 业务 panic 被恢复               |
| `rate limit exceeded`                              | 服务端或客户端限流器 | 令牌耗尽                        |
| `circuit breaker open`                             | 客户端断路器         | Open 状态拒绝                   |
| `no instance available`                            | 客户端发现           | 注册表返回空实例                |
| `load balancer returned empty address`             | 客户端 LB            | 策略返回零值                    |
| `connection closed`                                | 传输层               | 连接已关闭                      |
| `connection pool closed`                           | 传输层连接池         | 对已 `Close` 的池调用 `Acquire` |
| `codec: type N not registered`                     | 编解码               | 未注册的 codec 类型             |
| `proto codec: not proto.Message`                   | 编解码               | Protobuf 模式下类型不满足约束   |

业务方法返回的错误会写入 `Header.Error`, 客户端以 `errors.New(headerError)` 形式暴露, 因此错误在跨进程传输后不再保留原始类型与堆栈; 需要结构化错误时应自行在 Body 或错误字符串中编码。

## 性能与资源约束

| 关注点         | 现状                                             | 影响                                         |
| -------------- | ------------------------------------------------ | -------------------------------------------- |
| 每请求开销     | Future + sync.Map 条目 + 一次 JSON Header 编解码 | 小包场景下 Header JSON 开销可观              |
| Body 压缩      | 强制 Gzip, 无阈值判断                            | 小载荷可能变大, CPU 开销固定存在             |
| 单连接多路复用 | 一个 readLoop 分用全部响应                       | 一个慢流填满 64 帧缓冲后会阻塞同连接其它请求 |
| 连接数         | 每地址一条连接 (`maxActive=1`)                   | 连接开销极小, 但吞吐受单连接读循环限制       |
| 拨号           | 持池锁拨号, ctx 不约束拨号                       | 目标不可达时并发 Acquire 串行等待            |
| 服务端 unary   | 单连接串行                                       | 单个慢请求阻塞同连接后续请求                 |
| 关闭           | `SetLinger(0)` 发 RST                            | 资源回收快, 但丢失优雅关闭语义               |
| 反射分发       | 每次调用做 `MethodByName` 与类型判断             | 相比代码生成有额外开销                       |

## 可测试性与可观测性

可测试性方面, 框架没有把监听地址写死, `Serve(lis)` 接受调用方构造的 `net.Listener`, 因此可以用 `net.Listen("tcp", "127.0.0.1:0")` 拿到随机端口并在测试中获取真实地址。已有测试覆盖礼貌关闭空连接、流式调用不阻塞 unary、panic 与非法签名不崩服务、静态模式异步调用、服务端流式调用等端到端场景。

可观测性目前主要体现在日志上: 整个框架只有两处 `log.Println`, 分别在 `GracefulStop` 与 `Stop` 收尾时打印 `server graceful stop complete` 与 `server stop complete`; `Register`、Accept 循环与请求处理路径都不产生日志, 限流与熔断错误以固定字符串回传。框架没有内建 metrics、tracing 或拦截器 (interceptor) 扩展点, 日志也不是结构化的。

## 适用场景与选型建议

适合使用 yukino_rpc 的场景:

- 需要在 Go 服务之间建立轻量 RPC, 又不希望引入 HTTP/2 与 gRPC 全量栈的学习与部署成本。
- 需要单连接多路复用、服务端流式推送, 且可以接受只有单向流的协议形状。
- 希望把熔断、限流、负载均衡、服务发现打包进框架直接使用, 而不是逐个拼装。
- 作为学习自定义 RPC 协议的完整素材。

不适合或需要谨慎评估的场景:

- 需要客户端流或双向流的场景: 当前协议没有定义相应帧, 无法表达。
- 需要严格幂等、可重试语义的场景: 框架没有请求去重、重试或至少一次/恰好一次投递保证, 重试需要业务层自行处理。
- 需要 TLS 或跨不可信网络的场景: 传输是明文 TCP 与明文等价的注册发现, 应在外层加保护。
- 需要稳定权重分配的场景: `WeightedRR` 与 etcd 发现的 map 顺序存在冲突, 需要先修正实例排序。
- 对错误类型有强依赖的场景: 跨进程错误只剩字符串, 类型信息会丢失。
