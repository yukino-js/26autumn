---
title: "yukino_rpc RPC 框架技术笔记"
---

> 本机器路径: `$HOME/github/yukino.go/yukino_rpc`
> 基于项目 `github.com/hangtiancheng/yukino.go/yukino_rpc` 源码整理, 覆盖线协议、传输层多路复用、Future 异步模型、流式 RPC、熔断/限流/负载均衡、etcd 服务发现等核心主题.
> 公开 API: `pkg/rpc` (框架门面) 与 `pkg/api` (Arith 示例服务, README Quick Start 基于它) | 实现细节: `internal/`

## 一、整体架构与设计哲学

### 请介绍 yukino_rpc 的整体架构分层

yukino_rpc 采用严格的分层架构, 从上到下分为:

| 层次       | 包路径                                                          | 职责                                                             |
| ---------- | --------------------------------------------------------------- | ---------------------------------------------------------------- |
| 公开 API   | `pkg/rpc`                                                       | 类型别名、Dial/NewServer 入口、ClientConn/Server 门面            |
| 客户端逻辑 | `internal/client`                                               | 注册模式下的完整调用管线: 限流 -> 发现 -> 熔断 -> 连接池 -> 发送 |
| 服务端逻辑 | `internal/server`                                               | Accept 循环、反射分发、流式处理、优雅关闭                        |
| 传输层     | `internal/transport`                                            | TCP 连接管理、请求多路复用、Future、流帧缓冲、连接池             |
| 协议层     | `internal/protocol`                                             | 二进制帧编解码、Magic 校验、Header 序列化                        |
| 编解码层   | `internal/codec`                                                | Codec 接口、JSON/Protobuf 实现、Gzip 压缩                        |
| 治理组件   | `internal/breaker`, `internal/limiter`, `internal/load_balance` | 熔断、限流、负载均衡                                             |
| 注册中心   | `internal/registry`                                             | etcd v3 注册、发现、Watch                                        |
| 流接口     | `internal/stream`                                               | ServerStream/ClientStream 接口定义 (避免包间耦合)                |

调用链路 (注册模式 unary):

```
ClientConn.Invoke
  -> internal/client.Client.Invoke
    -> limiter.Allow()
    -> registry.Discover() + lb.Select()
    -> breaker.Allow()
    -> pool.Acquire()
    -> codec.Marshal(args)
    -> TCPClient.SendAsyncWithCodec()
      -> TCPConnection.Write() [protocol.Encode: gzip + JSON header + magic frame]
  -> Future.GetResultWithContext()
    -> TCPClient.readLoop 收到响应 -> Future.Done()
    -> OnComplete -> breaker.RecordSuccess/RecordFailure
```

### 为什么所有实现放在 internal/ 下? pkg/rpc 如何暴露能力?

Go 编译器强制 `internal/` 目录下的包只能被同一模块内的代码导入. 这确保了:

1. API 稳定性: 外部用户只能依赖 `pkg/rpc` 暴露的类型别名和函数, 内部重构不影响下游.
2. 最小暴露面: `pkg/rpc` 通过 type alias 将必要的内部类型导出:

```go
type CodecType    = codec.Type
type Registry     = registry.Registry
type Instance     = registry.Instance
type LoadBalancer = load_balance.LoadBalancer
type ServerStream = stream.ServerStream
type ClientStream = stream.ClientStream
type Future       = transport.Future
```

type alias (`=`) 而非 type definition 意味着 `rpc.Future` 和 `transport.Future` 是同一个类型, 用户可以直接调用 Future 的所有导出方法而无需额外适配.

### internal/stream 包存在的意义是什么?

`internal/server` 需要 `ServerStream` 接口做反射类型匹配 (判断方法第二参数是否为流), `internal/client` 需要 `ClientStream` 接口作为 `InvokeStream` 的返回类型. 如果 `ServerStream` 定义在 server 包, 而 client 或 pkg/rpc 需要引用它, 就必须导入 server 包, 导致不必要的耦合:

```
server  -> stream (反射匹配 ServerStream, 实现 serverStream)
client  -> stream (InvokeStream 返回 ClientStream)
pkg/rpc -> stream (re-export 两个接口)
```

`internal/stream` 作为独立的接口包, 只定义接口不含实现, 被 server、client、pkg/rpc 同时引用, 避免了包间耦合:

```
server   -> stream (匹配 ServerStream 接口)
client   -> stream (返回 ClientStream 接口)
transport 的 ClientStreamConn 隐式实现 ClientStream (无需导入 stream)
```

---

## 二、线协议与编解码

### 请描述 yukino_rpc 的线协议帧格式

```
+--------+-----------+---------+----------------+--------------+
| Magic  | HeaderLen | BodyLen |  Header(JSON)  | Body(bytes)  |
| 2 byte | 4 byte    | 4 byte  |    N byte      |    M byte    |
+--------+-----------+---------+----------------+--------------+
  固定 10 字节前缀
```

- Magic: `0x1234`, 大端序, 用于帧同步和脏数据跳过.
- HeaderLen/BodyLen: uint32 大端序, 描述后续两段长度.
- Header: JSON 编码的 `protocol.Header` 结构体, 包含 RequestID、ServiceName、MethodName、Error、CodecType、Compression、StreamFlag.
- Body: 经 Gzip 压缩后的业务载荷.

`Decode` 在解析前执行溢出检查: `uint64(10) + uint64(headerLen) + uint64(bodyLen) > math.MaxInt` 时拒绝, 防止 32 位平台整数溢出.

StreamFlag 使用 `json:",omitempty"`, 值为 0 (StreamNone) 时不出现在序列化结果中, 减少 unary 帧的 header 体积.

### 为什么 Header 始终使用 JSON 编码而 Body 可以切换 Codec?

设计考量:

1. 协商自举: Header 携带 CodecType 字段告知对端 Body 的编码方式. 如果 Header 本身也用 Protobuf, 则双端必须在没有任何协商信息的情况下就 Header 编码达成一致, 增加了复杂度.
2. 可调试性: JSON Header 可以直接用 tcpdump 抓取后人工阅读, 便于线上排障.
3. 体积影响小: Header 通常 100-200 字节, JSON 与 Protobuf 的体积差异可忽略; 而 Body 可能是 KB-MB 级, Protobuf 的紧凑编码收益显著.

代价是每个帧都有一次 JSON Marshal/Unmarshal, 但由于 Header 体积小且使用 `encoding/json` 标准库, 实测开销在微秒级.

### PacketBuffer 如何处理粘包和脏数据?

`PacketBuffer` 内部维护一个 `[]byte` 缓冲区, `Read()` 方法的核心逻辑:

```go
// 1. 跳脏数据: 循环丢弃前导字节直到缓冲区以 Magic 开头
for len(pb.buf) >= 2 && binary.BigEndian.Uint16(pb.buf[0:2]) != protocol.Magic {
    pb.buf = pb.buf[1:]
}

// 2. 帧头不完整: 不足 10 字节, 返回 nil 等待更多数据
if len(pb.buf) < 10 { return nil }

// 3. 解析长度, 帧体不完整: 返回 nil
headerLen := int(DecodeHeaderLen(pb.buf[2:6]))
bodyLen := int(DecodeBodyLen(pb.buf[6:10]))
totalLen := 10 + headerLen + bodyLen
if len(pb.buf) < totalLen { return nil }

// 4. 提取完整帧, 推进缓冲区
packet := make([]byte, totalLen)
copy(packet, pb.buf[:totalLen])
pb.buf = pb.buf[totalLen:]
return packet
```

TCP 是字节流, 一次 `Read` 可能包含多个完整帧 (粘包) 或半个帧 (拆包). 外层 `TCPConnection.Read()` 循环调用 `PacketBuffer.Read()`, 每次提取一个完整帧; 缓冲区不够时从 `bufio.Reader` (4096 字节) 补充数据. 脏数据 (如连接建立前的随机字节) 通过 Magic 跳跃循环自动恢复.

### 为什么 Body 强制 Gzip 压缩? 有什么代价?

所有发送路径 (unary、stream、error response) 都硬编码 `Compression: codec.CompressionGzip`:

```go
msg := &protocol.Message{
    Header: &protocol.Header{
        Compression: codec.CompressionGzip,
        // ...
    },
    Body: bodyBytes,
}
```

设计意图: 简化配置, 确保所有通信都经过压缩, 对大载荷 (如批量查询结果) 有显著带宽节省.

代价:

- 小载荷 (几十字节的 Args/Reply) 下, Gzip 头部 (约 20 字节) + 压缩开销可能使帧体积反而增大.
- 每帧一次 `gzip.Writer` + `gzip.Reader`, CPU 开销在高 QPS 场景下不可忽略.
- 无法通过配置关闭, 对延迟敏感的小包场景不友好.

改进方向: 增加阈值判断 (如 Body < 256 字节时不压缩) 或暴露 `WithCompression(None)` 选项.

### Codec 注册机制是怎样的? Protobuf Codec 有什么约束?

Codec 通过全局工厂注册表实现插件化:

```go
var factories = make(map[Type]Factory)  // sync.RWMutex 保护

func Register(t Type, f Factory) {
    // nil factory -> panic
    // 重复注册 -> panic
}

func New(t Type) (Codec, error) {
    // 未注册 -> error "codec: type %d not registered"
}
```

JSON (Type=1) 和 Protobuf (Type=2) 在各自文件的 `init()` 中注册.

Protobuf 约束: `Marshal`/`Unmarshal` 内部做类型断言 `v.(proto.Message)`, 非 `proto.Message` 的普通 struct 会返回 `"proto codec: not proto.Message"` 错误. 这意味着使用 Protobuf Codec 时, 请求和响应类型必须是 `.proto` 文件生成的结构体.

压缩器同样有注册表 (`map[CompressionType]compressor`), 默认只注册 Gzip. `RegisterCompressor` 函数虽然导出, 但其参数类型 `compressor` 接口未导出 (小写开头), 因此外部包无法实现该接口, 实际上不可扩展.

---

## 三、传输层

### TCPClient 如何在单连接上实现请求多路复用?

`TCPClient` 封装一个 TCP 连接, 核心数据结构:

```go
type TCPClient struct {
    conn    *TCPConnection
    addr    string
    writeMu sync.Mutex      // 写串行化
    seq     atomic.Uint64   // 递增, 起始 1
    pending sync.Map        // map[uint64]*Future (unary)
    streams sync.Map        // map[uint64]*ClientStreamConn (stream)
    closed  atomic.Int32    // 关闭标志
}
```

多路复用原理:

1. 每次发送分配唯一 RequestID (`nextSeq()` 内部 `c.seq.Add(1)`).
2. 将 Future/ClientStreamConn 以 RequestID 为 key 存入对应 Map.
3. 帧写入共享连接 (writeMu 保证帧完整性).
4. 唯一的 `readLoop` goroutine 读取响应帧, 按 RequestID 路由到对应 Future/Stream.

多个 goroutine 可以并发调用 `SendAsyncWithCodec`, 各自拿到独立的 Future, 互不阻塞. 所有响应由一个 readLoop 统一分用, 避免了每请求一个 goroutine 的开销.

### readLoop 的分用逻辑是怎样的? 如何区分 unary 和 stream 帧?

```go
func (c *TCPClient) readLoop() {
    for {
        msg, err := c.conn.Read()
        if err != nil { c.fail(err); return }

        seq := msg.Header.RequestID
        switch msg.Header.StreamFlag {
        case protocol.StreamData:
            // 流数据帧: 推入 ClientStreamConn 的缓冲 channel
            if v, ok := c.streams.Load(seq); ok {
                v.(*ClientStreamConn).Push(msg.Body)
            }
        case protocol.StreamEnd:
            // 流正常结束: 从 map 删除, 发送终结信号
            if v, ok := c.streams.LoadAndDelete(seq); ok {
                v.(*ClientStreamConn).End()
            }
        case protocol.StreamError:
            // 流错误结束: 从 map 删除, 发送错误信号
            if v, ok := c.streams.LoadAndDelete(seq); ok {
                v.(*ClientStreamConn).Error(errors.New(msg.Header.Error))
            }
        default: // StreamNone (0)
            // unary 响应: 从 pending 删除, 完成 Future
            if v, ok := c.pending.LoadAndDelete(seq); ok {
                if msg.Header.Error != "" {
                    v.(*Future).Done(nil, errors.New(msg.Header.Error))
                } else {
                    v.(*Future).Done(msg.Body, nil)
                }
            }
        }
    }
}
```

区分依据是 `Header.StreamFlag`: 0=unary, 1=流数据, 2=流结束, 3=流错误. unary 响应走 `pending` map, stream 帧走 `streams` map, 两个 map 完全隔离.

### shutdown 机制如何保证所有阻塞调用者被唤醒?

```go
func (c *TCPClient) shutdown(err error) {
    if !c.closed.CompareAndSwap(0, 1) {
        return  // 只执行一次
    }
    c.conn.Close()

    c.pending.Range(func(key, value any) bool {
        value.(*Future).Done(nil, err)
        c.pending.Delete(key)
        return true
    })

    c.streams.Range(func(key, value any) bool {
        value.(*ClientStreamConn).Error(err)
        c.streams.Delete(key)
        return true
    })
}
```

保证机制:

1. CAS 单次执行: 无论是读失败 (`fail`) 还是主动 `Close`, 都走 `shutdown`, CAS 保证只执行一次.
2. 遍历 pending: 每个未完成 Future 被 `Done(nil, err)` 唤醒, 阻塞在 `<-f.done` 的调用者立即返回.
3. 遍历 streams: 每个活跃流被 `Error(err)` 终结, `termCh` 关闭后阻塞在 `Recv` 的调用者立即返回.
4. Future.Done 幂等: 即使 readLoop 在 shutdown 之前已经收到部分响应并调用了 Done, shutdown 的再次 Done 是 no-op, 不会 panic.

这确保了连接断开时, 所有阻塞在 `Wait()`、`GetResult()`、`Recv()` 上的 goroutine 都能在有限时间内返回.

### SendAsyncWithCodec 中 Store 之后的二次 closed 检查解决什么竞态?

```go
func (c *TCPClient) SendAsyncWithCodec(msg, cc) (*Future, error) {
    if c.closed.Load() == 1 {
        return nil, errors.New("connection closed")
    }
    seq := c.nextSeq()
    msg.Header.RequestID = seq
    future := NewFutureWithCodec(cc)
    c.pending.Store(seq, future)

    // 关键: Store 之后再次检查
    if c.closed.Load() == 1 {
        if _, loaded := c.pending.LoadAndDelete(seq); loaded {
            return nil, errors.New("connection closed")
        }
    }
    // ... 写帧 ...
}
```

竞态窗口: 在 `Store` 和实际写帧之间, 另一个 goroutine 可能触发 `shutdown`. shutdown 遍历 `pending` map 并 Done 所有 Future. 如果 Store 发生在 shutdown 遍历之后:

- 没有二次检查: Future 被存入 map 但永远不会被 Done (shutdown 已经遍历完了), 调用者永久阻塞.
- 有二次检查: 发现 closed=1, 主动从 map 删除并返回错误, 避免泄漏.

如果 shutdown 在二次检查之后才发生, 那么 shutdown 的遍历会覆盖到这个 Future 并 Done 它, 同样安全.

### ConnectionPool 的设计有什么特点? 存在什么瓶颈?

```go
type ConnectionPool struct {
    addr      string
    maxActive int              // 所有调用点都传 1
    conns     []*TCPClient
    mu        sync.Mutex
    closed    bool
    next      int              // round-robin 游标
}
```

特点:

- `maxActive=1`: 每个地址只维护一个 TCP 连接, 所有请求多路复用.
- 死连接驱逐: Acquire 时发现 `conn.closed==1`, 从切片中 splice 删除; 若切片仍非空则继续 round-robin 检查下一个连接, 直到切片为空才重新拨号.
- `maxIdle` 参数被接受但从未使用 (预留接口).

瓶颈:

1. Acquire 持锁拨号: `mu` 锁跨越 `net.DialTimeout(5s)`, 如果目标不可达, 所有并发 Acquire 串行等待, 最坏情况 N 个调用者等待 N\*5s.
2. Context 不约束拨号: ctx 只在 Acquire 入口做非阻塞检查, 不传入 DialTimeout, 调用者取消后拨号仍在进行.
3. 单连接瓶颈: 所有 unary + stream 共享一个 readLoop, 一个慢 stream 填满 64 帧缓冲后会阻塞 readLoop 的 Push, 进而阻塞该连接上所有其他请求的响应分用.

### TCPConnection.Close 为什么调用 SetLinger(0)?

```go
func (tc *TCPConnection) Close() error {
    if tcp, ok := tc.conn.(*net.TCPConn); ok {
        tcp.SetLinger(0)
    }
    return tc.conn.Close()
}
```

`SetLinger(0)` 使 `Close()` 发送 TCP RST 而非 FIN:

- 立即释放: 不等待对端 ACK, 不进入 TIME_WAIT, 内核立即回收 socket 资源.
- 适用场景: 服务端 `Stop()` 强制关闭所有连接时, 不希望等待大量 TIME_WAIT; 连接异常断开时, 快速释放资源.
- 代价: 对端正在 `Read` 的 goroutine 收到 "connection reset by peer" 而非 EOF, 无法区分"对端正常关闭"和"网络异常".

这是一个偏向资源回收速度的设计选择, 牺牲了优雅关闭的语义. `GracefulStop` 通过 `SetReadDeadline` 打断空闲连接的阻塞读, 让正在处理中的 handler (含活跃流) 自然完成后再退出连接 goroutine, 避免了 `Stop` 那样在请求处理中途强拆连接; 但连接最终仍经 `Handle` 的 `defer conn.Close()` 走 `TCPConnection.Close` 的 `SetLinger(0)`, 客户端在 TCP 层收到的仍是 RST 而非 EOF.

---

## 四、Future 异步调用模型

### Future 的 Done 幂等性是如何实现的? 为什么需要幂等?

```go
func (f *Future) Done(res []byte, err error) {
    f.mu.Lock()
    if f.complete {
        f.mu.Unlock()
        return  // 第二次及之后的调用是 no-op
    }
    f.res, f.err, f.complete = res, err, true
    onComplete := f.onComplete
    f.mu.Unlock()

    if onComplete != nil { onComplete(err) }
    close(f.done)
}
```

需要幂等的场景:

1. 超时 + 迟到响应: 客户端超时后调用 `future.Done(nil, context.DeadlineExceeded)` 记录失败; 之后服务端响应到达, readLoop 再次调用 `future.Done(body, nil)`. 第二次是 no-op, 不会覆盖超时错误.
2. shutdown + 正常响应: 连接断开触发 shutdown 遍历 Done 所有 Future; 如果 readLoop 在 shutdown 之前已经处理了某个响应, 两次 Done 不冲突.
3. InvokeAsync 看门狗 + 正常完成: 超时定时器触发 Done; 如果响应恰好在同一时刻到达, 两个 goroutine 竞争 Done, 只有一个生效.

幂等性由 `mu + complete flag` 保证, 无需 atomic (因为还需要保护 res/err 的写入).

### Future 的 OnComplete 回调与断路器如何协作?

注册模式客户端在发送后注册回调:

```go
future.OnComplete(func(err error) {
    if err != nil {
        br.RecordFailure()
    } else {
        br.RecordSuccess()
    }
})
```

关键设计:

1. 恰好一次: `OnComplete` 存储在 Future 的单一 slot 中, `Done` 幂等保证回调最多触发一次.
2. 锁外执行: `Done` 在释放 `mu` 之后才调用 `onComplete`, 避免回调内部 (断路器加锁) 与 Future 锁形成死锁.
3. 即时触发: 如果注册 `OnComplete` 时 Future 已经完成, 回调立即执行, 不会丢失.
4. 完整覆盖: 响应错误、超时 (通过强制 Done) 都会触发回调; 发送失败 (连接池 Acquire 失败或 `SendAsyncWithCodec` 返回 err) 时 Future 尚未创建, 直接在 `invokeAsync` 中调用 `br.RecordFailure()` (invoke.go:163-166, 183-186), 不经回调. 断路器统计基本不遗漏, 唯一盲区是 `codec.Marshal(args)` 序列化失败 (invoke.go:169-172, InvokeStream 同理) : 既不 RecordFailure 也不创建 Future, 该次已通过 `breaker.Allow()` 的调用不会计入窗口.

### InvokeAsync 的超时看门狗是如何工作的?

```go
func (c *Client) InvokeAsync(ctx, service, method, args) (*Future, error) {
    future, err := c.invokeAsync(ctx, service, method, args)
    if err != nil { return nil, err }

    go func() {
        timer := time.NewTimer(c.timeout)
        defer timer.Stop()  // 无论哪个分支都回收定时器
        select {
        case <-future.DoneChan():
            // 正常完成, defer 回收定时器
        case <-timer.C:
            future.Done(nil, context.DeadlineExceeded)  // 超时强制完成
        }
    }()
    return future, nil
}
```

设计要点:

- 看门狗是独立 goroutine, 不阻塞调用者. timer 在 goroutine 内部创建, 避免跨 goroutine 共享.
- `defer timer.Stop()` 保证无论正常完成还是超时, 定时器资源都被回收.
- 超时后 `Done(nil, context.DeadlineExceeded)` 触发 OnComplete -> 断路器记录失败.
- 与 `Invoke` (同步) 的区别: Invoke 使用 `context.WithTimeout` + `GetResultWithContext`, 超时后主动 Done; InvokeAsync 使用独立定时器, 调用者可以在任意时刻通过 `future.Wait()` 系列方法获取结果.

---

## 五、服务端

### 服务端如何通过反射支持三种方法签名?

`Handler.invoke` 按优先级匹配:

签名 1 - grpc-go 风格 (推荐):

```go
Method(ctx context.Context, req *T) (*R, error)
```

匹配条件: `numIn==2 && numOut==2 && In(0) implements context.Context && In(1).Kind()==Ptr && Out(0).Kind()==Ptr && Out(1) implements error`

签名 2 - net/rpc 风格:

```go
Method(req *T, reply *R) error
```

匹配条件: `numIn==2 && numOut==1 && Out(0) implements error && In(0).Kind()==Ptr && In(1).Kind()==Ptr` (且 In(1) 不实现 ServerStream)

签名 3 - 流式:

```go
Method(req *T, stream ServerStream) error
```

匹配条件: 与签名 2 相同的外在形状, 但 `In(1) implements serverStreamType`

反射调用流程:

1. `reflect.New(methodType.In(1).Elem())` 分配请求对象.
2. `len(body) > 0` 时 `codec.Unmarshal(body, req.Interface())` 反序列化, 空 body 跳过 (handler.go:161-165, 188-192) .
3. `safeCall(method, args)` 执行 (带 panic 恢复).
4. 流式: 启动独立 goroutine, 返回 `(nil, true, nil)` 告知 Process 跳过响应写入.
5. Unary: 返回结果值, 由 Process 序列化并写回.

注意: 方法签名验证发生在调用时而非注册时. 注册一个方法形状不合法的服务不会报错, 直到客户端实际调用才返回 `"unsupported method signature"`.

### safeCall 的 panic 恢复机制是怎样的?

```go
func safeCall(method reflect.Value, args []reflect.Value) (results []reflect.Value, err error) {
    defer func() {
        if r := recover(); r != nil {
            err = fmt.Errorf("handler panic: %v", r)
        }
    }()
    return method.Call(args), nil
}
```

设计意图: 反射调用 `method.Call` 时, 业务代码的 panic 会沿调用栈传播. 如果不 recover, 单个请求的 panic 会杀死整个连接处理 goroutine, 甚至导致进程崩溃.

效果:

- panic 被转换为 `"handler panic: <value>"` 错误字符串.
- 该错误通过 `Header.Error` 写回客户端.
- 连接处理 goroutine 继续服务后续请求.
- 流式 handler 的 panic 同样被恢复, 通过 `sendError` 发送 StreamError 帧.

### GracefulStop 和 Stop 的区别是什么? 各自如何保证正确性?

| 维度         | GracefulStop                                    | Stop                          |
| ------------ | ----------------------------------------------- | ----------------------------- |
| 新连接       | 关闭 listener, 不再 Accept                      | 同左                          |
| 空闲连接     | `SetReadDeadline(now)` 中断阻塞读, 连接自然退出 | `conn.Close()` 强制关闭 (RST) |
| 进行中请求   | 等待完成 (`wg.Wait()`)                          | 不等待                        |
| 流式 handler | 等待 streamWg 完成                              | 不等待                        |
| 返回时机     | 所有 handler 完成后                             | 关闭连接后立即返回            |

GracefulStop 流程:

```
beginShutdown() [once: close(closing), close(listener)]
  -> serveWg.Wait() [等待 accept 循环退出]
  -> 遍历 conns: SetReadDeadline(time.Now()) [中断空闲读]
  -> wg.Wait() [等待所有连接 goroutine, 含 streamWg]
  -> limiter.Stop()
```

关键细节: `SetReadDeadline(now)` 使阻塞在 `conn.Read()` 的空闲连接立即收到超时错误退出, 而正在处理请求的连接在 handler 返回后的下一次 Read 才退出. `wg.Wait()` 确保所有 in-flight 请求和流都完成后才返回.

Stop 在 GracefulStop 之后仍有效: 只有 listener 关闭由 `shutdownOnce` 保护, 连接遍历和关闭不受 once 限制.

### 为什么 unary 请求在单连接上串行处理而 stream 可以并发?

服务端每个连接一个 `Handle` goroutine:

```go
func (s *Server) Handle(conn *transport.TCPConnection) {
    var streamWg sync.WaitGroup
    defer conn.Close()
    defer streamWg.Wait()  // LIFO: 先等流完成, 再关连接

    for {
        msg, err := conn.Read()  // 阻塞读
        if err != nil { return }
        // ... 限流检查 ...
        s.handler.Process(conn, msg, service, &streamWg)
    }
}
```

Unary: `Process` 同步调用 handler, 写回响应后才回到 `Read` 循环. 下一个请求必须等当前 handler 完成. 这是简化设计: 避免并发写同一连接的复杂性 (虽然 writeMu 已经保证了写安全).

Stream: `invoke` 检测到流式签名后, 启动独立 goroutine:

```go
streamWg.Go(func() {
    run()  // 执行 handler, 发送 StreamEnd/StreamError
})
return (nil, true, nil)  // Process 立即返回, 继续 Read 循环
```

流式 handler 在独立 goroutine 中运行, 不阻塞 Read 循环, 后续请求 (unary 或其他 stream) 可以立即被处理. `streamWg.Wait()` 在连接退出前确保所有流完成.

影响: 一个耗时 10s 的 unary handler 会阻塞该连接上后续所有 unary 请求 10s. 改进方向是为每个 unary 请求也启动 goroutine, 但需要处理并发写和背压.

### 服务端的 Codec 协商是如何工作的?

```go
func (h *Handler) Process(conn, msg, service, streamWg) {
    cc := h.codec  // 服务端默认 codec
    if ct := msg.Header.CodecType; ct != 0 {
        // 客户端在 Header 中声明了 codec 类型
        cc, err = codec.New(codec.Type(ct))
        if err != nil { writeError; return }
    }
    // 用 cc 解码请求, 也用 cc 编码响应
}
```

协商规则:

- 客户端每次发送都在 `Header.CodecType` 中携带自己期望的 codec (JSON=1, PROTO=2).
- 服务端尊重客户端的选择: 用同一个 codec 解码请求和编码响应.
- Header 中 CodecType=0 (未设置) 时, 回退到服务端配置的默认 codec.

这意味着一个 `WithDialCodec(CodecProto)` 的客户端可以透明地与默认 JSON 服务端通信, 只要请求/响应类型实现了 `proto.Message`.

---

## 六、流式 RPC

### 服务端流 (Server Streaming) 的完整生命周期是怎样的?

服务端:

1. 客户端发送一个 unary 请求帧 (携带 ServiceName + MethodName).
2. `Handler.invoke` 匹配流式签名, 构造 `serverStream{conn, requestID, codec, ctx}`.
3. 启动独立 goroutine 执行业务 handler.
4. 业务代码循环调用 `stream.Send(msg)`:
   - Marshal msg -> 构造 `StreamFlag=StreamData` 帧 -> Write.
5. Handler 返回 nil -> 框架发送 `StreamFlag=StreamEnd` 帧 (空 body).
6. Handler 返回 error -> 框架发送 `StreamFlag=StreamError` 帧 (Header.Error 携带错误).

客户端:

1. `NewStream` 发送请求, 创建 `ClientStreamConn` 存入 `streams` map.
2. readLoop 收到 StreamData 帧 -> `Push(body)` 到 64 帧缓冲 channel.
3. 业务代码循环 `stream.Recv(&msg)`:
   - 从 channel 取帧 -> Unmarshal -> 返回.
4. readLoop 收到 StreamEnd -> `End()` -> `terminate(io.EOF)` -> close(termCh).
5. `Recv` 排空缓冲后检测到 termCh 关闭 -> 返回 `io.EOF`.

终结保证: 无论 handler 正常返回、panic、还是连接断开, 客户端的 Recv 最终都会返回 (io.EOF 或 error), 不会永久阻塞.

### ClientStreamConn 的 64 帧缓冲和带外终结状态是如何设计的?

```go
type ClientStreamConn struct {
    ctx     context.Context
    cancel  context.CancelFunc
    ch      chan streamFrame   // cap=64, 数据帧缓冲
    codec   codec.Codec
    once    sync.Once
    termCh  chan struct{}      // 终结信号 (关闭即通知)
    termErr error              // io.EOF 或具体错误
}
```

为什么终结状态走 termCh 而非 ch?

如果终结信号也放入 `ch` (作为特殊帧), 当 64 个数据帧填满缓冲后, `End()`/`Error()` 的 Push 会阻塞 readLoop, 导致该连接上所有其他请求/流的帧无法被分用.

带外设计:

```go
func (s *ClientStreamConn) terminate(err error) {
    s.once.Do(func() {
        s.termErr = err
        close(s.termCh)  // 永远不阻塞
    })
}
```

`close(termCh)` 是非阻塞操作, 无论 `ch` 是否满, 终结信号都能立即送达. `sync.Once` 保证 End 和 Error 只有一个生效.

Push 的阻塞问题: 数据帧的 `Push` 仍然可能阻塞 (当 ch 满且未终结/取消时):

```go
func (s *ClientStreamConn) Push(body []byte) {
    select {
    case s.ch <- streamFrame{body}:  // 可能阻塞
    case <-s.ctx.Done():             // 调用者取消
    case <-s.termCh:                 // 已终结, 丢弃
    }
}
```

### Recv 的 drain-before-terminal 语义是什么? 为什么需要?

```go
func (s *ClientStreamConn) Recv(msg any) error {
    // 第一次非阻塞尝试: 快速路径
    select {
    case frame := <-s.ch:
        return s.codec.Unmarshal(frame.body, msg)
    default:
    }

    // 阻塞等待
    select {
    case frame := <-s.ch:
        return s.codec.Unmarshal(frame.body, msg)
    case <-s.termCh:
        // 终结到达, 但先排空缓冲
        select {
        case frame := <-s.ch:
            return s.codec.Unmarshal(frame.body, msg)  // 还有数据!
        default:
            return s.termErr  // 真正结束
        }
    case <-s.ctx.Done():
        return s.ctx.Err()
    }
}
```

为什么需要 drain-before-terminal?

readLoop 处理帧是顺序的: 先 Push 数据帧, 再 End/Error. 但由于 `ch` 是 buffered channel, 数据帧可能还在缓冲中未被消费, 而 `termCh` 已经关闭. 如果 Recv 看到 termCh 关闭就直接返回 io.EOF, 缓冲中已到达的数据帧就丢失了.

drain 语义保证: 在 StreamEnd 之前发送的所有数据帧, 客户端都能收到, 不会丢失任何一帧.

### 为什么只支持 Server Streaming 而不支持 Client/Bidirectional Streaming?

协议层面的限制: `StreamFlag` 只有 4 个值 (None/Data/End/Error), 且所有流帧都是服务端 -> 客户端方向. 没有定义客户端发送流数据帧的 codepoint.

Server Streaming 的简化假设:

- 客户端只发一次请求 (unary 帧), 然后只接收.
- 服务端只接收一次请求, 然后持续发送.
- 不需要客户端流控 (flow control) 或半关闭语义.

如果要支持 Bidirectional Streaming, 需要:

1. 新增 StreamFlag 值区分客户端发送的流帧.
2. 服务端需要并发读写同一连接上的同一 RequestID.
3. 需要流控机制 (如 HTTP/2 的 WINDOW_UPDATE) 防止快发送者压垮慢消费者.
4. 需要半关闭语义: 一方发完但还在接收.

当前设计选择了最简的单向流模型, 覆盖了"服务端推送多条消息"的常见场景 (如订阅通知、批量查询结果分页).

---

## 七、客户端治理

### 注册模式客户端的调用管线 (pipeline) 是怎样的?

每次 `Invoke`/`InvokeAsync`/`InvokeStream` 都经过完整的治理管线:

```
1. limiter.Allow()
   |-- 拒绝 -> "rate limit exceeded"
   v
2. registry.Discover(service)
   |-- 空 -> "no instance available"
   v
3. lb.Select(instances)
   |-- 空 -> "load balancer returned empty address"
   v
4. breaker.Allow()  [key: "service|addr"]
   |-- 拒绝 -> "circuit breaker open"
   v
5. pool.Acquire(ctx)  [per-addr ConnectionPool]
   |-- 失败 -> 连接错误
   v
6. codec.Marshal(args)
   v
7. TCPClient.SendAsyncWithCodec(msg, codec)
   v
8. future.OnComplete -> breaker.RecordSuccess/RecordFailure
```

资源生命周期:

- `pools` (sync.Map): 每个 addr 一个 ConnectionPool, 懒创建 (LoadOrStore).
- `breaker` (sync.Map): 每个 "service|addr" 一个 CircuitBreaker, 懒创建.
- `Close()`: 停止 limiter, 遍历关闭所有 pool.

### 静态模式和注册模式的区别是什么?

| 维度     | 静态模式 (Dial with target)            | 注册模式 (Dial with WithRegistry) |
| -------- | -------------------------------------- | --------------------------------- |
| 寻址     | 固定 target 地址                       | etcd 发现 + LB 选择               |
| 限流     | 无                                     | TokenBucket(10000)                |
| 熔断     | 无                                     | 三态断路器 (10, 0.6, 5s)          |
| 负载均衡 | 无 (单地址)                            | RoundRobin/Random/WeightedRR      |
| 连接管理 | 单 ConnectionPool                      | 每地址一个 Pool (sync.Map)        |
| 实现路径 | `pkg/rpc/client.go` 直接操作 transport | 委托 `internal/client.Client`     |

静态模式适合开发测试或已知固定地址的场景; 注册模式适合生产环境多实例部署.

### 断路器的三态状态机是如何工作的?

```
         失败率 >= 60%
Closed ─────────────────> Open
  ^                         |
  |    探测成功             | openTimeout (5s) 过期
  |                         v
  +──────────────────── HalfOpen
                           |
                           | 探测失败
                           v
                          Open
```

参数 (硬编码): `windowSize=10, failureThreshold=0.6, openTimeout=5s`

Closed 状态:

- 每次调用记录 Success/Failure, 累计到窗口.
- 当 `successCount + failureCount >= windowSize` 时:
  - `failureCount / total >= 0.6` -> 转 Open.
  - 否则重置窗口 (清零计数), 开始新一轮统计.

Open 状态:

- `Allow()` 返回 false, 请求被拒绝 ("circuit breaker open").
- 当 `time.Since(lastStateChange) > 5s` 时, 下一次 `Allow()` 转 HalfOpen 并放行一个探测请求.

HalfOpen 状态:

- `halfOpenProbe` 标志确保只有一个探测请求通过.
- 探测成功 -> Closed (重置所有计数).
- 探测失败 -> Open (重新开始计时).

同步: 单个 `sync.Mutex` 保护所有状态转换, 无 atomic.

### 断路器在流式调用中如何记录成功/失败?

通过 `observedStream` 装饰器:

```go
type observedStream struct {
    inner stream.ClientStream
    br    *breaker.CircuitBreaker
    once  sync.Once
}

func (s *observedStream) Recv(msg any) error {
    err := s.inner.Recv(msg)
    switch {
    case err == nil:
    case errors.Is(err, io.EOF):
        s.once.Do(s.br.RecordSuccess)
    case errors.Is(err, context.Canceled):
        // 调用者主动取消, 不算服务失败
    default:
        s.once.Do(s.br.RecordFailure)
    }
    return err
}
```

设计决策:

- `io.EOF` (流正常结束) -> 记录成功, 使用 `errors.Is` 匹配.
- `context.Canceled` (调用者主动取消) -> 忽略, 不算服务失败.
- 其他错误 (网络断开、服务端错误) -> 记录失败.
- `sync.Once` 保证每个流最多记录一次, 避免一个流的多次 Recv 错误重复计入.

### 令牌桶限流器的实现有什么特点?

```go
type TokenBucket struct {
    tokens int
    rate   int
    mu     sync.Mutex
    stop   chan struct{}
    once   sync.Once
}
```

实现:

- 初始 tokens = rate (burst 容量等于一秒的速率).
- 后台 goroutine 每秒 `time.Ticker` 重置 `tokens = rate` (固定窗口, 非平滑补充).
- `Allow()`: 加锁, tokens > 0 则减一返回 true, 否则 false.
- `Stop()`: `once.Do(close(stop))` 停止补充 goroutine.
- 负 rate 钳位为 0 (永远拒绝).

特点: 这是固定窗口限流器而非经典令牌桶. 经典令牌桶按时间平滑补充 (如每 100us 补一个), 而这里每秒一次性补满. 效果是窗口边界可能出现 2x burst (上一秒末尾 + 下一秒开头).

调用方约定: `NewTokenBucket(rate int)` 接受任意正整数参数, 但当前服务端 (`internal/server/server.go`) 和注册模式客户端 (`internal/client/client.go`) 统一传 10000, 未通过 ServerOption/DialOption 暴露给外部用户.

---

## 八、负载均衡

### 三种负载均衡策略的实现细节和适用场景?

RoundRobin (轮询):

```go
type RoundRobin struct { idx atomic.Uint64 }

func (r *RoundRobin) Select(list []Instance) Instance {
    if len(list) == 0 {
        return Instance{}  // 空列表防御 (round_robin.go:39-41)
    }
    i := r.idx.Add(1)
    return list[(i-1) % uint64(len(list))]
}
```

- 无锁 (atomic), 高并发下性能最优.
- 第一次选择 index=0.
- 适用: 实例配置均匀, 无需权重.

Random (随机):

```go
type Random struct { r *rand.Rand; m sync.Mutex }

func (r *Random) Select(list []Instance) Instance {
    if len(list) == 0 {
        return Instance{}  // 空列表防御 (random.go:43-45)
    }
    r.m.Lock()
    defer r.m.Unlock()
    return list[r.r.Intn(len(list))]
}
```

- 有锁 (rand.Rand 非并发安全).
- 适用: 实例数量大, 统计上均匀即可; 或需要避免同步请求模式.

WeightedRR (平滑加权轮询, Nginx 算法):

```go
// 每次 Select (前置防御: len(list)==0、len(list)!=len(weights)、totalWeight<=0 均返回零值 Instance, weighted_rr.go:56-69):
for i := range weights { currentWeight[i] += weights[i] }
maxIdx := index of max(currentWeight)
currentWeight[maxIdx] -= totalWeight
return list[maxIdx]
```

- 有锁 (sync.Mutex).
- 负权重钳位为 0.
- 产出平滑交错分布: weights=[1,2,3] 在 6 次调用中精确产出 1:2:3 比例, 不会连续命中同一实例.
- 适用: 实例配置不均匀 (如 4C8G 和 8C16G 混部).

### WeightedRR 与 etcd Registry 组合使用会有什么问题?

`WeightedRR.Select` 按位置 (index) 匹配 weights 和 instances:

```go
if len(r.weights) != len(list) { return Instance{} }
// weights[i] 对应 list[i]
```

但 `registry.copyInstances` 从 `map[string]Instance` 构建切片, Go map 迭代顺序是随机的:

```go
func (r *Registry) copyInstances(service string) []Instance {
    r.mu.RLock()
    defer r.mu.RUnlock()
    var instances []Instance
    for _, ins := range r.services[service] {  // map 迭代, 顺序随机!
        instances = append(instances, ins)
    }
    return instances
}
```

后果: 每次 Discover 返回的实例顺序不同, weights[0] 对应的实例每次都不一样, 流量分配完全错乱.

解决方案: WeightedRR 只应与静态有序实例列表配合; 或者在 Registry 层增加按 addr 排序, 保证顺序稳定.

---

## 九、服务注册与发现

### etcd 注册发现的完整流程是怎样的?

注册 (服务端):

```
reg.Register("Math", Instance{Addr: "10.0.0.5:8080"}, ttl=10)
  1. client.Grant(ctx, 10)  -> 获取 10s Lease
  2. client.Put(ctx, key, addr, WithLease(leaseID))
     key = "/github.com/hangtiancheng/yukino.go/yukino_rpc/services/Math/10.0.0.5:8080"
  3. client.KeepAlive(ctx, leaseID) -> 获取 keepAliveCh
  4. go func() { for range keepAliveCh {} }()  // 只排空 channel
```

发现 (客户端):

```
reg.Discover("Math")
  1. RLock 检查本地缓存 -> 命中则返回防御性拷贝
  2. 未命中: Lock, double-check, etcd Get(prefix) 全量拉取
  3. 填充缓存 map[addr]Instance
  4. 启动 watch goroutine 监听增量变更
  5. 返回缓存拷贝
```

Watch 增量更新:

```
watch(service):
  for {
    watchCh := client.Watch(ctx, prefix, WithPrefix())
    for event := range watchCh {
        PUT    -> cache[addr] = Instance{addr}
        DELETE -> delete(cache, addr)
    }
    // watchCh 关闭: 1s 退避后重连
    select { case <-ctx.Done(): return; case <-time.After(1s): }
  }
```

### KeepAlive 的设计有什么隐患? 如何改进?

当前实现:

```go
ch, err := client.KeepAlive(ctx, leaseID)
if err != nil {
    return err  // 初始错误有处理
}
go func() {
    for {
        _, ok := <-ch
        if !ok {
            return  // channel 关闭后静默退出, 无重注册
        }
    }
}()
```

隐患:

1. Lease 过期无感知: 如果 etcd 重启或网络分区导致 KeepAlive 失败, channel 关闭, goroutine 退出, 但没有任何重注册逻辑. 实例的 key 在 TTL 后自动删除, 服务从发现中消失, 且永远不会恢复.
2. 无健康检查: 即使服务本身已经不可用 (如 handler 死锁), 只要 etcd 连接正常, 实例仍然注册.
3. 排空 goroutine 静默退出: channel 关闭后 goroutine 直接 return, 无日志、无指标、无重连, 运维难以感知注册失效.

改进方向:

```go
go func() {
    for {
        ch, err := client.KeepAlive(ctx, leaseID)
        if err != nil { /* 重新 Grant + Put + KeepAlive */ }
        for range ch {}
        // channel 关闭, 重新注册
        select {
        case <-ctx.Done(): return
        case <-time.After(backoff):
            // 重新 Grant, Put, KeepAlive
        }
    }
}()
```

### Discover 的缓存与 Watch 机制是如何协作的?

首次 Discover (冷启动):

1. RLock 检查 `services[service]` -> nil.
2. 升级为 Lock, double-check (防止并发初始化).
3. etcd `Get` with prefix: 全量拉取该服务所有实例.
4. 构建 `map[addr]Instance` 存入缓存.
5. 启动 `watch(service)` goroutine: 监听该 prefix 的增量事件.
6. 返回防御性拷贝.

后续 Discover (热路径):

1. RLock 读缓存 -> 命中.
2. 构建新切片拷贝 (防止调用者修改内部状态).
3. 返回.

Watch 持续更新:

- PUT 事件: 新实例上线 (显式 client.Put 注册) -> 更新缓存. 注意: Lease 续约 (KeepAlive) 只刷新 TTL, 不产生 Watch PUT 事件.
- DELETE 事件: 实例下线或 Lease 过期 -> 删除缓存.
- Watch 断开: 1s 退避后重建 Watch (期间缓存可能过期).

一致性保证: 最终一致. Watch 事件有延迟 (通常 <100ms), 新上线的实例不会立即被发现, 下线的实例在事件到达前仍会被路由到.

---

## 十、并发模型与同步原语

### 整个框架使用了哪些同步原语? 各自解决什么问题?

| 原语               | 位置                         | 解决的问题                               |
| ------------------ | ---------------------------- | ---------------------------------------- |
| `sync.Mutex`       | TCPConnection.writeMu        | 保证帧写入原子性 (多 goroutine 共享连接) |
| `sync.Mutex`       | TCPClient.writeMu            | 同上 (冗余的双层锁)                      |
| `sync.Mutex`       | PacketBuffer.lock            | 保护缓冲区的 append/read                 |
| `sync.Mutex`       | ConnectionPool.mu            | 保护连接切片和拨号逻辑                   |
| `sync.Mutex`       | Future.mu                    | 保护 res/err/complete/onComplete         |
| `sync.Mutex`       | CircuitBreaker.mu            | 保护状态机转换                           |
| `sync.Mutex`       | TokenBucket.mu               | 保护令牌计数                             |
| `sync.Mutex`       | Random.m                     | rand.Rand 非并发安全                     |
| `sync.Mutex`       | WeightedRR.mu                | 保护 currentWeight 数组                  |
| `sync.RWMutex`     | Registry.mu                  | 读多写少的服务缓存                       |
| `sync.RWMutex`     | codec/compressor 注册表      | init 时写, 运行时只读                    |
| `sync.Map`         | TCPClient.pending/streams    | 高并发读、偶尔写的请求映射               |
| `sync.Map`         | Client.pools/breaker         | 懒初始化的 per-addr 资源                 |
| `sync.Once`        | Server.shutdownOnce          | beginShutdown 只执行一次                 |
| `sync.Once`        | TokenBucket.once             | Stop 只关闭 channel 一次                 |
| `sync.Once`        | ClientStreamConn.once        | 终结信号只发送一次                       |
| `sync.Once`        | observedStream.once          | 断路器只记录一次                         |
| `sync.WaitGroup`   | Server.wg                    | 等待所有连接 goroutine                   |
| `sync.WaitGroup`   | Server.serveWg               | 等待 accept 循环退出                     |
| `sync.WaitGroup`   | Handle.streamWg (局部)       | 等待该连接上所有流 handler               |
| `atomic.Uint64`    | TCPClient.seq                | 无锁 RequestID 分配 (.Add(1))            |
| `atomic.Uint64`    | RoundRobin.idx               | 无锁轮询计数 (.Add(1))                   |
| `atomic.Int32`     | TCPClient.closed             | 无锁关闭标志                             |
| `chan struct{}`    | Future.done                  | 阻塞唤醒 (close 广播)                    |
| `chan struct{}`    | ClientStreamConn.termCh      | 终结信号广播                             |
| `chan struct{}`    | Server.closing               | 关闭信号广播                             |
| `chan struct{}`    | TokenBucket.stop             | 停止补充 goroutine                       |
| `chan streamFrame` | ClientStreamConn.ch (cap=64) | 流帧生产者-消费者缓冲                    |

### sync.Map 在框架中的使用场景和选择理由?

使用场景:

1. `TCPClient.pending`: RequestID -> Future, 高并发读写 (每次请求 Store+Delete, readLoop 频繁 LoadAndDelete).
2. `TCPClient.streams`: RequestID -> ClientStreamConn, 同上.
3. `Client.pools`: addr -> ConnectionPool, 懒初始化 (LoadOrStore).
4. `Client.breaker`: "service|addr" -> CircuitBreaker, 同上.

选择理由:

- `pending`/`streams`: key 空间不重叠 (每个请求恰好一次 Store + 一次 LoadAndDelete, 读写 1:1, 每个 RequestID 只被一个 goroutine 写入), 这是 sync.Map 的最优场景, 避免了锁竞争.
- `pools`/`breaker`: 典型的"初始化后只读"模式, LoadOrStore 保证并发安全的懒创建, 之后全是 Load 快路径.

不适用场景: 如果 key 集合频繁变化且读写均匀, 普通 map + RWMutex 可能更优 (sync.Map 的 dirty promotion 有额外开销).

---

## 十一、设计权衡与已知局限

### 框架有哪些已知的设计局限? 如何改进?

| 局限                             | 影响                       | 改进方向                       |
| -------------------------------- | -------------------------- | ------------------------------ |
| 强制 Gzip                        | 小包 CPU 浪费, 无法关闭    | 增加阈值或配置选项             |
| 硬编码 10000 RPS                 | 无法适配不同规模服务       | 暴露为 ServerOption/DialOption |
| 硬编码断路器参数 (10, 0.6, 5s)   | 无法按服务特性调优         | 暴露为配置                     |
| 单连接池 (maxActive=1)           | 慢 stream 阻塞整条连接     | 支持多连接 + 流级别隔离        |
| Acquire 持锁拨号                 | 冷启动串行化               | 异步拨号或 singleflight        |
| 静态模式无治理                   | 直连无熔断限流             | 统一走 internal/client         |
| WeightedRR + Registry 顺序不稳定 | 权重分配错乱               | Registry 返回排序切片          |
| 无 Context 传播                  | 客户端超时后服务端继续执行 | Header 携带 deadline           |
| 仅 Server Streaming              | 无法双向流                 | 扩展 StreamFlag + 流控         |
| KeepAlive 无重注册               | Lease 过期后实例消失       | 检测 channel 关闭后重注册      |
| 错误字符串传输                   | 无法 errors.Is/As          | 定义错误码体系                 |
| 注册时不验证方法签名             | 调用时才发现错误           | Register 时反射检查            |
| NewServer panic                  | 不安全的初始化             | 返回 error                     |

### 错误为什么以字符串形式跨线传输? 有什么影响?

实现:

```go
// 服务端写错误
msg.Header.Error = err.Error()

// 客户端读错误
err = errors.New(msg.Header.Error)
```

原因: 简单直接, 不需要双端共享错误类型定义, 不需要错误码注册表, 任何 error 都能透传.

影响:

1. 无法类型匹配: `errors.Is(err, os.ErrTimeout)` 失败, 因为客户端拿到的是 `errors.New("i/o timeout")` 新值.
2. 只能字符串匹配: `strings.Contains(err.Error(), "rate limit exceeded")` 是唯一判断方式, 脆弱且不利于国际化.
3. 无结构化信息: 无法携带错误码、重试建议、详细上下文等元数据.
4. 版本耦合: 服务端修改错误消息文本会破坏客户端的字符串匹配逻辑.

改进方向: 定义 protobuf 错误结构 (code + message + details), 或至少引入数值错误码:

```go
type RPCError struct {
    Code    int
    Message string
}
```
