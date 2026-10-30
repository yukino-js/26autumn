---
title: "yukino_cache 分布式缓存技术笔记"
description: "yukino_cache Go 分布式缓存: groupcache 风格 read-through Group、字节预算双层 LRU、singleflight 去重、一致性哈希分片、gRPC peer 通信与 etcd 服务发现"
local_path: "$HOME/github/yukino.go/libs/yukino_cache"
local_commit: "c71a35a07a47607d136b1d97c294bc64b785bf24"
---

yukino_cache 是一个用 Go 实现的分布式缓存库, API 风格对齐 Google groupcache: 用命名 Group 组织缓存命名空间, 用 Getter 描述回源逻辑, 用一致性哈希把 key 映射到归属节点, 用 singleflight 抑制缓存击穿 (cache stampede)。在 groupcache 只读模型的基础上, 它扩展了 Set/Delete 写操作与异步写传播、etcd 服务发现、按字节预算淘汰的分桶双层 LRU 本地存储, 以及一个推送实时快照的 WebSocket 仪表盘。本文面向需要在无中心节点架构下做缓存分片与对等访问的 Go 工程师, 说明其分层结构、读写数据流、存储引擎、并发模型、容错语义与适用边界。

## 定位与整体架构

核心设计目标是在没有中心协调节点的前提下, 让每个节点既服务本地请求、又能作为 peer 被其它节点访问, 从而把缓存容量与热点压力分散到整个集群。整体分为四层:

| 层次   | 组件                                 | 职责                                                                |
| ------ | ------------------------------------ | ------------------------------------------------------------------- |
| 接口层 | `Group` + `Getter`                   | 命名空间隔离, 对外暴露 Get/Set/Delete/Clear, 承载 read-through 语义 |
| 缓存层 | `Cache` → `lruStore`                 | 分桶双层 LRU, 按字节预算与条数上限淘汰, TTL 过期清理                |
| 路由层 | `ClientPicker` + `ConsistentHashMap` | 一致性哈希选节点, etcd 动态维护 peer 列表                           |
| 传输层 | `Server` / `Client`                  | 节点间 gRPC 通信, 共用同一份 protobuf 服务定义                      |

```text
   调用方
     |
     v
+-------------------------------------------------------------+
| Group   命名空间隔离 + read-through + singleflight 去重      |
+-------------------------------------------------------------+
     |  未命中
     v
+-------------------------------------------------------------+
| Cache -> lruStore   分桶双层 LRU, 字节预算 + TTL 淘汰        |
+-------------------------------------------------------------+
     |  本地未命中
     v
+-------------------------------------------------------------+
| ClientPicker + ConsistentHashMap   一致性哈希选归属节点      |
| etcd Watch 动态维护 peer 列表                                |
+-------------------------------------------------------------+
     |  归属远端
     v
+-------------------------------------------------------------+
| Server / Client   gRPC 对等通信 (每个节点既是 Server 也是 Client) |
+-------------------------------------------------------------+
```

关键架构决策:

- 无中心节点: 每个节点同时运行 gRPC Server 与 ClientPicker, 通过对等协议互相访问; 集群成员信息只存在于 etcd 的注册项中。
- read-through 语义: 调用方只提供 Getter, 命中、未命中、远端取回、回填本地都由 Group 统一处理。
- 分片而非复制: 未命中时优先向 key 的归属节点请求, 而不是广播或副本读; 写操作只写本地并异步同步给归属节点, 属于弱一致的最终一致性。

## Group 与全局注册表

`Group` 是缓存的基本单位, 持有 Getter、本地 `Cache`、可选的 `PeerPicker` (由 `peersMu sync.RWMutex` 保护)、`SingleFlightGroup`、默认 TTL 与一组原子统计计数。值统一封装为不可变的 `ByteView` (实现 `Value` 接口的 `Len()`, 提供 `ByteSlice()` 拷贝读与 `String()`)。`Getter` 接口带 context: `Get(ctx context.Context, key string) ([]byte, error)`, 普通函数可用 `GetterFunc` 适配。Group 通过全局注册表按名字去重:

| API                                           | 行为                                                                                         |
| --------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `NewGroup(name, cacheBytes, getter, opts...)` | 创建并注册 Group; `getter` 为 nil 或名字重复时 panic; `cacheBytes` 写入本地缓存的 `MaxBytes` |
| `WithExpiration(d)`                           | 设置默认 TTL, 零值表示不过期                                                                 |
| `WithPeers(picker)`                           | 注入分布式 peer 选择器                                                                       |
| `WithCacheOptions(opts)`                      | 用给定 `CacheOptions` 重新构造本地缓存 (此时 `cacheBytes` 不再起作用)                        |
| `GetGroup(name)`                              | 按名字取 Group, 不存在返回 nil                                                               |
| `GetAllGroups()` / `ListGroups()`             | 返回全部 Group 的 map 副本或名字切片                                                         |
| `DestroyGroup(name)`                          | 从注册表移除并 `Close`, 返回是否存在该 Group                                                 |
| `DestroyAllGroups()`                          | 清空注册表并逐个关闭                                                                         |
| `g.Clear()`                                   | 清空本地缓存条目并把 `Cache` 的 hits/misses 归零; 已关闭时直接返回                           |
| `g.Close()`                                   | CAS 置关闭标志、关闭本地缓存、从注册表注销; 幂等                                             |

当 `CacheOptions.DashboardAddr` 非空时, `NewGroup` 在注册完成后会调用 `StartDashboard(addr)` (进程内只启动一次, 见可观测性一节)。`RegisterPeers` 与 `WithPeers` 的区别值得注意: `RegisterPeers` 只允许调用一次, 第二次直接 panic; 而 `WithPeers` 走 `GroupOption` 路径没有这个限制, 两者行为并不一致。

## 读路径 (read-through)

一次 `Get` 的完整链路:

```text
Group.Get(ctx, key)
  |-- 已关闭 -> ErrGroupClosed;  key 为空 -> ErrKeyRequired
  |-- gets++
  |-- mainCache 命中 -> localHits++, 直接返回 ByteView
  |-- 未命中 -> localMisses++ -> load(key)
        |-- SingleFlightGroup.Do(key, fn)  同 key 并发只执行一份 fn
        |     |-- 回调内再次 mainCache.Get  防止串行调用者重复回源
        |     |-- loadsDeduped++
        |     |-- loadData(key)
        |     |     |-- peers 非空且非 peer 转发请求 -> PickPeer
        |     |     |     |-- 归属远端 -> peer.Get (客户端固定 3s 超时)
        |     |     |     |     成功 -> peerHits++, 返回远端值
        |     |     |     |     失败 -> peerMisses++, 记日志, 继续回源
        |     |     |-- getter.Get(ctx, key)
        |     |     |     失败 -> 包装为 "failed to get data: ..." 返回
        |     |     |     成功 -> loaderHits++, cloneBytes 后包装 ByteView
        |     |-- 按 expiration 写入 mainCache (Add 或 AddWithExpiration)
        |-- loads++、累计 loadDuration(纳秒); 出错或结果类型不是 ByteView 则 loaderErrors++
```

两个容易被忽略的设计点:

- singleflight 回调内部会再做一次 `mainCache.Get`。singleflight 只能合并时间上重叠的并发调用, 两个串行到达的调用者都可能先看到未命中; 二次检查让后一个执行者在真正回源前有机会命中已被前者写入的缓存。
- 统计口径: `loadsDeduped` 只在实际执行加载时自增一次, 而 `loads` 在 `Do` 返回后对每个调用方各计一次, 因此被合并的等待者也会计入 `loads`; `avg_load_time_ms` 的分母也是 `loads`, 会随去重比例被稀释。

`loadData` 的防转发检查是读路径一跳语义的关键: 若当前请求已经被标记为 peer 转发 (`isPeerRequest(ctx)`), 则跳过 `PickPeer` 强制走本地 Getter。这样即使各节点因 etcd 事件乱序而短暂持有不一致的哈希环视图, 被转发到的节点也不会把请求再弹回别的节点, 从机制上消除了环路。

## 写路径与写传播

`Set`/`Delete` 都先写本地缓存, 再在满足条件时异步传播:

| 步骤     | Set                                                    | Delete                 |
| -------- | ------------------------------------------------------ | ---------------------- |
| 前置校验 | 关闭、key 为空、value 为空分别返回三种错误             | 关闭、key 为空返回错误 |
| 本地写入 | `cloneBytes` 防御性拷贝后 `Add` 或 `AddWithExpiration` | `mainCache.Delete`     |
| 传播条件 | 非 peer 转发请求且已配置 peers                         | 同左                   |
| 传播方式 | `go syncToPeers(...)`, fire-and-forget                 | 同左                   |

`syncToPeers` 通过 `PickPeer` 找到 key 的归属节点: 若环上无节点、归属自己或 peer 为 nil 就直接返回; 否则派生一个带 peer 标记、超时 3 秒 (`peerSyncTimeout`) 的上下文: 对 `set` 调用 `peer.Set(ctx, group, key, value)`, 对 `delete` 直接调用 `peer.Delete(group, key)` (`Peer.Delete` 不接受 context, 其 3 秒超时由客户端内部上下文提供)。传播失败只记日志, 不重试、不阻塞本地写返回。

peer 标记通过私有 context key (`peerRequestContextKey`) 传递: 服务端的 `Get` 与 `Delete` 处理总是注入, `Set` 处理在尚未注入时补上, 这样 Group 收到来自 peer 的写请求时不会再二次传播, 写传播最多一跳。由此得到的一致性级别是:

- 写入是异步的, 网络故障时可能丢失, 没有重试队列或 WAL。
- 没有版本号或向量时钟, 并发写是 last-write-wins。
- 只同步给环上拥有该 key 的单个节点, 其它节点的本地副本可能仍是旧值, 直到被淘汰或过期。

因此它适合读多写少、对一致性不敏感、把缓存当作加速层的场景。

## 本地存储: 分桶双层 LRU

`Cache` 是 `Store` 接口之上的薄封装, 提供懒初始化、命中/未命中统计与幂等关闭。默认实现 `lruStore` 的核心结构是 "分桶 + 每桶两层 LRU":

```text
bucket index = HashBKRD(key) & mask          mask = 桶数 - 1 (2 的幂 - 1)
+-------------------- bucket i --------------------+
|  L1 (cap = CapPerBucket, 默认 512)               |  新写入落在这里
|  L2 (cap = Level2Cap,   默认 256)                |  L1 命中后提升到这里
|  bytes / nevict  按桶统计的存活字节与淘汰次数     |
+---------------------------------------------------+
全局: maxBucketBytes = MaxBytes / 桶数 (MaxBytes > 0 时, 结果不足 1 则取 1)
```

分桶的意义是把字节预算与淘汰循环限定在单个桶内, 写入触发的淘汰只需遍历一个桶的双层链表, 而不必扫描整个缓存; 桶数由 `MaskOfNextPowOf2` 向上取整为 2 的幂, 用 `hash & mask` 代替取模。哈希使用 BKDR (`hash = hash*131 + byte`, int32 自然溢出)。

双层 LRU 解决扫描污染问题: 新写入进入 L1; 再次被访问时从 L1 提升到 L2; 一次性扫描的数据只经过 L1, 不会被反复访问, 也就不进入 L2, 避免挤占真正频繁访问的热数据; 字节预算淘汰时优先从 L1 淘汰, L1 无可淘汰条目才轮到 L2 (`evictFromBucket` 的两段顺序)。

几个实现细节:

- 每个桶两层各用一个数组式 LRU (`cache`): 构造时预分配 `cap+1` 个 `[2]uint16` 双向链表槽与 `cap` 个节点对象。0 号槽是哨兵, `[0][p]` 与 `[0][n]` 分别保存最旧与最新节点的下标; 普通节点的两个分量分别指向更旧与更新方向的邻居。装满后新写入直接复用 `doubleLink[0][p]` 指向的 LRU 尾节点下标 (nevict++, 触发 `OnEvicted`), 稳态下不产生新分配; 写已存在的 key 则原地更新值、修正字节计数并移到最新端。
- L1 是唯一写入权威: `SetWithExpiration` 写入 L1 后会 `drop` 掉 L2 中可能存在的同名旧条目, 否则旧的提升副本可能在 L1 槽位被回收后 "复活", 读到过期值。
- 条目记账字节为 `len(key) + value.Len()` (`entryBytes`)。预算约束的是记账口径, 不含节点对象、链表数组与哈希索引的结构开销, 也不等于进程 RSS。
- 桶内淘汰是条数上限与字节预算双重约束: 条数满时 `put` 复用尾节点; 字节超预算时 `SetWithExpiration` 循环调用 `evictFromBucket` 直到 L1+L2 字节回到预算内或无可淘汰条目。

## TTL 与过期清理

过期时间以纳秒时间戳记录: `SetWithExpiration` 在 `expiration > 0` 时令 `expireAt = Now() + expiration`, 否则记为 `maxExpireAt` (`math.MaxInt64`, 即不过期)。条目有效性以 `expireAt > 0` 判定, 删除或淘汰时把槽位 `expireAt` 重置为 0 并释放 value 引用。

清理由两条路径协同:

| 路径     | 触发时机                                      | 行为                                                              |
| -------- | --------------------------------------------- | ----------------------------------------------------------------- |
| 懒清理   | 每次 `Get` 命中时比较 `Now() >= expireAt`     | 过期则删除 L1/L2 中的条目、扣减字节、触发 `OnEvicted`, 返回未命中 |
| 定时清理 | 后台 goroutine 按 `CleanupTime` (默认 1 分钟) | 逐桶 walk L1/L2 收集过期 key 后批量删除                           |

`Cache.AddWithExpiration` 在传入时间已过期 (`time.Until(expirationTime) <= 0`) 时直接跳过写入, 不会缓存已过期的值。存储层的时间源不是 `time.Now()`, 而是一个粗粒度时钟: 全局 `int64` 时钟由一个后台 goroutine 维护, 每约 1 秒用真实时间重新校准一次, 期间每 100ms 按 +100ms 的步长原子累加推进; 读路径的 `Now()` 只做一次 `atomic.LoadInt64`。这样规避了高 QPS 下 `time.Now()` 的 vDSO 开销, 代价是时间精度只有约 100ms。

## SingleFlight 去重

`SingleFlightGroup.Do(key, fn)` 保证同一个 key 的并发调用只执行一次 `fn`, 其余调用者阻塞等待并共享结果。实现用 `sync.Map`: 每个调用者先构造 `call{wg, val, err}` 并 `wg.Add(1)`, 然后 `LoadOrStore`; 加载者 (loaded == false) 执行 `fn` 并 `defer g.m.Delete(key)` 让后续请求触发新一次加载, 等待者取出同一个 `call` 后 `wg.Wait()` 再读结果。`fn` 内部 panic 会被 recover 并转换为错误 (`singleflight: panic during call: ...`) 返回给所有调用者, 因此一次回源失败会让该 key 的所有并发等待者一起失败, 下一个请求会重新加载。

## 一致性哈希

`ConsistentHashMap` 是带虚拟节点的并发哈希环:

| 参数/行为              | 值                                                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 每个物理节点虚拟节点数 | `DefaultReplicas`, 默认 50                                                                                          |
| 哈希函数               | 默认 `crc32.ChecksumIEEE`, 可用 `WithConsistentHashConfig` 替换整个 `ConHashConfig`                                 |
| 虚拟节点键             | `<node>-<i>` (i = 0..replicas-1)                                                                                    |
| 查找                   | 对 key 哈希后在排序哈希值数组上二分 (`sort.Search`), 找第一个 `>= hash` 的位置, 越界回绕到 0; 空 key 或空环返回空串 |
| 新增节点               | 追加其虚拟节点后对全数组重新排序; 哈希冲突时跳过该虚拟点而不是覆盖已有归属; 节点已存在则直接返回                    |
| 删除节点               | 移除其全部虚拟节点、哈希项与计数器, 节点不存在时返回错误                                                            |
| 流量统计               | `GetStats()` 返回各节点命中次数占总请求数的比例                                                                     |

虚拟节点解决数据倾斜: 只有 3 个物理节点时 key 分布极不均匀, 50 个虚拟点能让分布趋近均匀; 节点增删时理论上只迁移约 `1/N` 的 key。每个物理节点的虚拟节点数固定为 `DefaultReplicas`, 不做动态再均衡: 这样 key 到归属节点的映射只随节点增删而变, 不会因为负载波动而在环上漂移, 与 groupcache 的稳定归属语义一致。

## 服务发现与注册

注册 (`register.go`): `Register(svcName, addr, stopCh)` 使用全局 `DefaultRegisterConfig` 创建 etcd 客户端; `:port` 形式的地址用 `getLocalIP()` 返回的本机第一个非 loopback IPv4 补全; 申请 10 秒 TTL 的租约, 以 `/services/<svc>/<addr>` 为 key、地址为 value 写入并绑定租约, 然后启动 `KeepAlive`, `Register` 随即返回。一个后台 goroutine 监听 `stopCh` 与续约 channel: 收到停止信号时用 3 秒超时的上下文撤销租约并退出; 续约 channel 关闭 (etcd 抖动或网络分区) 时进入 `reRegister`, 以 1 秒起步、失败翻倍 (仅当退避小于 30 秒时翻倍, 实际上限 32 秒) 的退避重新注册, 直到成功或收到停止信号。

发现 (`ClientPicker`): 构造时先把自身地址加入哈希环 (保证 key 归属在全局视角下一致), 再通过 `startServiceDiscovery` 做全量拉取 + 增量监听。`fetchAllServices` 用 3 秒超时的前缀 Get 拉取 `/services/<svc>/` 下的注册项, 跳过空地址与自身后, 对缺失地址 `NewClient` 建立 gRPC 连接入环, 并关闭、移除 etcd 中已不存在的多余连接, 最后返回 etcd revision; 随后启动 watch 循环:

```text
watchServiceChanges:
  rev = fetchAllServices()          全量对账 (幂等: 补齐缺失, 关闭多余)
  watchOnce(fromRev = rev)          从 rev+1 开始增量监听 (WithPrefix)
     PUT    -> 新地址: NewClient + 入环
     DELETE -> 从 key 去掉前缀解析地址: Close + 出环
  channel 关闭/取消/出错 -> 等 1s 后重新 fetch + watch; picker Close 则退出
```

先全量、再带 revision 增量监听, 并在重连后重新全量对账, 这是 etcd 服务发现的标准 List+Watch 模式: 断线窗口内可能错过事件, 甚至可能遭遇 etcd compaction, 纯增量 Watch 无法保证本地视图与 etcd 一致, 而对账后的最终一致性是可达成的。整体一致性是最终一致: 新节点不会立刻被发现, 下线节点在 delete 事件到达前仍可能被路由到。

`PickPeer(key)` 返回三元组 `(peer, ok, self)`: 哈希环返回空串或选中的地址没有对应客户端时 `ok == false`; `ok && self` 表示 key 归属本节点 (返回的 peer 为 nil), 调用方应走本地路径; `ok && !self` 表示返回的是远端 gRPC 客户端。`Close` 会取消发现协程、关闭所有 peer 连接与 etcd 客户端。

服务名默认是 `yukino_cache` (`defaultSvcName`), 可用 `WithServiceName` 覆盖, 注册侧与发现侧必须使用同一个名字, 否则双方落在不同的 etcd 前缀下互相看不见。这里有一个容易踩的配置不对称: `NewServer` 的 etcd 端点来自 `ServerOptions.EtcdEndpoints` (由 `WithEtcdEndpoints`/`WithDialTimeout` 覆盖), 而 `NewClientPicker` 没有暴露任何 etcd 选项, 它直接读取全局变量 `DefaultRegisterConfig` 的 `Endpoints` 与 `DialTimeout`。要让发现侧连到非默认 etcd, 必须在构造 picker 之前改写这个全局变量; 若只改了 `ServerOptions` 而漏改 `DefaultRegisterConfig`, 节点会注册到一个 etcd、却从另一个 etcd 做发现, 集群退化成互不可见的一组本地缓存。

## 节点间通信

跨节点通信基于 gRPC, protobuf 服务 `YukinoCache` 只定义三个方法, 共用一个请求消息:

| RPC               | 请求 (`Request`)    | 响应                              |
| ----------------- | ------------------- | --------------------------------- |
| `Get(Request)`    | group + key         | `ResponseForGet`: 字节值          |
| `Set(Request)`    | group + key + value | `ResponseForGet`: 回显 value      |
| `Delete(Request)` | group + key         | `ResponseForDelete`: 布尔是否成功 |

`NewServer` 在构造时就注册该服务与 gRPC 健康检查服务 (按服务名置 `SERVING`), 并把 `MaxRecvMsgSize` 设为 `ServerOptions.MaxMsgSize` (默认 `4 << 20` = 4 MiB), 防止超大 value 打爆内存; 当前 `ServerOption` 只有 `WithEtcdEndpoints` 与 `WithDialTimeout`, 没有消息大小选项, 要调整只能改写全局 `DefaultServerOptions`。`Start` 监听 TCP 地址, 并在后台 goroutine 里用 `ServerOptions` 的端点与超时做 etcd 注册 (复用 `register.go` 的租约逻辑), 然后阻塞在 `grpcServer.Serve`。`Stop` 时先把健康状态置为 `NOT_SERVING`、关闭停止信号 (触发注册侧撤销租约), 再 `GracefulStop` 并关闭 etcd 客户端。

请求进入后按 group 名字查全局注册表, 找不到返回 `group %s not found`; `Get` 请求在自增 `serverRequests` 后注入 peer 标记再交给 Group, 从而强制归属节点本地回源; `Set`/`Delete` 同样注入 peer 标记, 保证写传播不再二次扩散。

客户端 `Client` 用 `grpc.NewClient` 建立明文连接 (`insecure.NewCredentials`) 并启用 `WaitForReady(true)`, 使请求在连接重建期间等待而不是立即失败。`Get`/`Delete` 使用固定 3 秒超时; `Set` 复用调用方传入的上下文 (因此继承了写传播的 3 秒超时)。每个 peer 地址一条长连接。

## 并发模型

| 组件                | 同步手段                          | 说明                                                        |
| ------------------- | --------------------------------- | ----------------------------------------------------------- |
| `lruStore`          | 每桶一个 `sync.Mutex`             | 不同桶完全独立, 同一桶内的 L1/L2 读写互斥                   |
| `Cache`             | `sync.RWMutex` + 原子标志         | 懒初始化用双检锁; hits/misses/closed/initialized 用原子操作 |
| `Group`             | `peersMu sync.RWMutex` + 原子统计 | peer picker 可读多写少; 所有统计计数无锁                    |
| 全局注册表          | `groupsMu sync.RWMutex`           | 读多写少的 group 名字映射                                   |
| 粗粒度时钟          | `int64` + atomic 读写             | 后台 goroutine 写, 读路径 `atomic.LoadInt64`                |
| `SingleFlightGroup` | `sync.Map` + `sync.WaitGroup`     | key 生命周期短, 读写 1:1                                    |
| `ConsistentHashMap` | `sync.RWMutex` + 原子计数         | 环结构读多写少; 每节点命中计数与总请求数原子累加            |

`Cache` 是惰性初始化的: 只有写路径 (Add/AddWithExpiration) 会创建底层 store, 因此首次 `Get` 必然未命中并继续走回源流程, 回源写入时 store 才被真正创建。`Cache.Close` 用 CAS 保证幂等: 关闭后 `Add` 只记录日志, `Get` 直接返回未命中。`Group.Close` 同样用 CAS, 关闭后 Get/Set/Delete 返回 `ErrGroupClosed`。

## 容错与降级

| 故障场景              | 行为                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------- |
| 远端 peer 不可达      | `peer.Get` 3 秒超时后记 `peerMisses`, 回退到本地 Getter 回源                          |
| peer 返回错误         | 同上, 不缓存错误结果                                                                  |
| Getter 回源失败       | 包装为 `failed to get data: ...`, 记 `loaderErrors`, 不写缓存                         |
| singleflight 内 panic | recover 转换为错误返回给所有等待者                                                    |
| 写传播失败            | 记日志后丢弃, 不影响本地写成功返回                                                    |
| 注册续约中断          | `reRegister` 指数退避 (1s → 32s 封顶) 重新注册                                        |
| etcd 完全不可用       | 已建立的 gRPC 长连接继续工作; 无法发现新节点或感知下线, 新节点无法注册                |
| 节点优雅下线          | `Stop` 关闭停止信号触发撤销租约, etcd 删除注册 key, peer 收到 delete 事件后将其移出环 |
| 节点崩溃              | 租约 10 秒后过期, etcd 自动删除 key, peer 收到 delete 事件                            |

## 可观测性

`Group.Stats()` 返回的 map 覆盖了从请求到回源的全链路指标:

| 分组      | 键                                                                                                                                         |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 基本信息  | `name`、`closed`、`expiration`                                                                                                             |
| 请求计数  | `gets`、`local_hits`、`local_misses`、`hit_rate` (local_hits / (local_hits + local_misses), 无请求时不出现)                                |
| 回源计数  | `loads`、`loads_deduped`、`loader_hits`、`loader_errors`、`avg_load_time_ms` (无加载时不出现)                                              |
| peer 计数 | `peer_hits`、`peer_misses`、`server_requests`                                                                                              |
| 缓存指标  | 以 `cache_` 为前缀, 来自 `Cache.Stats()`: `initialized`、`closed`、`hits`、`misses`, 初始化后另有 `size`、`hit_rate`、`bytes`、`evictions` |

`Cache.Stats` 中的 `bytes` 与 `evictions` 直接来自 `lruStore` 的全桶聚合 (`Bytes()`/`Evictions()`), 可用于容量规划与淘汰速率监控; `size` 是桶内 L1/L2 两层去重后的存活条目数 (`Len()`)。

在 `CacheOptions.DashboardAddr` 非空时, `StartDashboard(addr)` 会启动一个独立的 yukino_http 应用, 在 `/dashboard/ws` 暴露 WebSocket 端点 (`dashboardOnce` 保证同一进程只启动一次)。连接建立后先立即推送一次 JSON 快照, 之后每 2 秒推送一次, 并每 30 秒发送心跳; 快照结构为 `{"type":"snapshot","groups":[...]}`, 内容为所有启用了仪表盘 (`DashboardAddr` 非空) 的 Group 的 `Stats()` 与当前存活条目 (key、size、expire_at、level, level 1 为 L2、0 为 L1)。客户端可以回传 JSON 命令, 目前支持 `{"action":"delete","group":"...","key":"..."}` 删除指定条目 (走 `Group.Delete`, 同样触发写传播)。`DashboardHandler()` 也可以作为中间件挂载到任意 [yukino-http](./yukino-http) 应用上, 复用同一处理器 —— 这正是 yukino_cache 对 yukino_http 的唯一依赖点, WebSocket 握手、帧编解码与心跳全部来自该框架。

## 配置项

| 配置                                | 默认值               | 说明                                                                      |
| ----------------------------------- | -------------------- | ------------------------------------------------------------------------- |
| `CacheOptions.MaxBytes`             | 8 MiB                | 本地缓存字节预算, 按桶均分                                                |
| `CacheOptions.BucketCount`          | 16                   | 桶数, 向上取整为 2 的幂                                                   |
| `CacheOptions.CapPerBucket`         | 512                  | 每桶 L1 条数上限                                                          |
| `CacheOptions.Level2Cap`            | 256                  | 每桶 L2 条数上限                                                          |
| `CacheOptions.CleanupTime`          | 1 分钟               | 后台过期清理周期                                                          |
| `CacheOptions.OnEvicted`            | nil                  | 淘汰/删除回调                                                             |
| `CacheOptions.DashboardAddr`        | 空                   | 非空则启动 WebSocket 仪表盘                                               |
| `WithExpiration`                    | 0                    | Group 默认 TTL, 0 表示不过期                                              |
| `ConHashConfig.DefaultReplicas`     | 50                   | 每节点虚拟节点数                                                          |
| `ConHashConfig.HashFunc`            | crc32 IEEE           | 哈希函数                                                                  |
| `WithServiceName`                   | `yukino_cache`       | 注册与发现共用的 etcd 服务名                                              |
| `ServerOptions.EtcdEndpoints`       | `["localhost:2379"]` | `NewServer` 注册侧 etcd 端点                                              |
| `ServerOptions.DialTimeout`         | 5 秒                 | etcd 拨号超时                                                             |
| `ServerOptions.MaxMsgSize`          | 4 MiB                | gRPC 最大接收消息大小                                                     |
| `DefaultRegisterConfig.Endpoints`   | `["localhost:2379"]` | `Register` 与 `NewClientPicker` 发现侧共用的全局 etcd 端点                |
| `DefaultRegisterConfig.DialTimeout` | 5 秒                 | 同上, 全局 etcd 拨号超时                                                  |
| 注册租约 TTL                        | 10 秒                | 由 KeepAlive 续约                                                         |
| 写传播/读 peer/全量对账超时         | 3 秒                 | `peerSyncTimeout`、`Client.Get/Delete`、`fetchAllServices` 各自的固定超时 |

## 性能与资源约束

| 关注点   | 设计                                      | 边界                                               |
| -------- | ----------------------------------------- | -------------------------------------------------- |
| 锁竞争   | 每桶独立锁, 桶数可调                      | 热点集中在同一 key 时仍会竞争该桶                  |
| 内存分配 | 数组式 LRU 预分配节点池, 装满后复用尾节点 | 条目数由 CapPerBucket/Level2Cap 与字节预算共同约束 |
| 时间读取 | 粗粒度时钟 + 原子加载                     | 精度约 100ms, 不适用对过期精度敏感的语义           |
| 字节记账 | `len(key) + value.Len()`, 按桶均分预算    | 不含结构开销, 不等同进程内存                       |
| 网络开销 | 每地址一条 gRPC 长连接                    | 明文传输, 无 TLS                                   |
| 请求放大 | 单跳语义 + 防转发标记                     | 环视图不一致时也不会二次转发                       |
| 写传播   | fire-and-forget, 3 秒超时                 | 可能丢失, 无重试                                   |

## 与 groupcache 的对比

| 维度         | groupcache               | yukino_cache                             |
| ------------ | ------------------------ | ---------------------------------------- |
| 命名空间     | Group + Getter           | Group + Getter (带 context)              |
| 全局注册表   | 有                       | 有, 另提供 List/Destroy/Clear 等管理函数 |
| 不可变值类型 | ByteView                 | ByteView                                 |
| 击穿防护     | singleflight             | SingleFlightGroup                        |
| 一致性哈希   | consistenthash           | ConsistentHashMap, 固定虚拟节点          |
| 写操作       | 不支持 (只读)            | Set/Delete + 异步写传播                  |
| peer 抽象    | PeerPicker + ProtoGetter | PeerPicker + Peer (Get/Set/Delete)       |
| 传输         | HTTP/Protobuf            | gRPC                                     |
| 服务发现     | 调用方静态注入           | 内置 etcd Watch                          |
| 本地存储     | 单层 LRU                 | 分桶双层 LRU + 字节预算                  |
| 监控         | 无                       | WebSocket 仪表盘 + Stats                 |

它保留了 groupcache 的核心心智模型 (Group + Getter + PeerPicker + singleflight), 并面向需要写传播、自动服务发现与可观测性的微服务场景做了扩展。groupcache 原始设计与 etcd、gRPC 的通用机制见[中间件与可观测性](./middleware); 一个完整的落地样例 (报告字节预算缓存、singleflight 回源与可选 etcd 对等环) 见 [yukino_taskflow](./yukino-task-flow)。

## 适用场景与选型建议

适合使用 yukino_cache 的场景:

- 需要按 key 分片的进程内缓存, 且希望用一致性哈希把每类 key 的归属固定到单个节点, 避免全量复制。
- 读多写少、能接受最终一致: 写操作只保证本地立即生效, 远端靠异步传播。
- 需要内置 etcd 服务发现与节点间对等访问, 不想自己实现 peer 管理。
- 需要监控缓存命中率、淘汰速率与回源延迟。

不适合或需要谨慎评估的场景:

- 需要强一致或线性一致的读写: 当前模型是 last-write-wins 的最终一致, 没有版本与冲突解决。
- 对写传播可靠性有硬要求: 传播是 fire-and-forget, 没有重试队列或 WAL。
- 跨不可信网络的部署: gRPC 为明文, 需要在外层加安全通道。
- 需要多副本容错: 一致性哈希是单副本, 节点下线时其区间内的 key 会全部回源, 没有副本兜底。
- 对 TTL 精度要求高于百毫秒: 粗粒度时钟与分钟级清理周期会带来额外滞留。
