---
title: "yukino-cache 分布式缓存 -- 技术笔记"
description: "yukino-cache 分布式缓存 TypeScript 与 Go 双实现的源码级解析: 架构分层、一致性哈希、分桶双层 LRU、etcd 服务发现、并发模型与容错机制"
---

> 本机器路径: `$HOME/github/yukino.js/packages/cache`
> 本机器路径: `$HOME/github/yukino.go/yukino_cache`
> 基于 npm 包 `@yukino.js/cache` (Node.js / TypeScript 实现, 与 Go 版 `yukino.go/yukino_cache` 对齐, 个别细节差异在正文相应位置标注) 源码整理, 覆盖架构设计、存储引擎、一致性哈希、服务发现、并发模型、容错机制等核心主题.
> 版本事实: TS 侧 `@yukino.js/cache@0.0.1` (yukino.js HEAD `7f7277f`), 运行时依赖 `@grpc/grpc-js` ^1.14.5、`@grpc/proto-loader` ^0.7.15、`etcd3` ^1.1.2, engines 要求 Node >= 20. Go 侧模块 `github.com/hangtiancheng/yukino.go/yukino_cache` (yukino.go HEAD `573f84d`), go.mod 声明 `go 1.26.0`, 直接依赖 `google.golang.org/grpc` v1.82.1、`google.golang.org/protobuf` v1.36.11、`go.etcd.io/etcd/client/v3` v3.7.0 与 `github.com/hangtiancheng/yukino.go/yukino_http` v0.0.1 (dashboard 用).

## 1. 项目整体架构

请介绍 yukino-cache 的整体架构设计.

yukino-cache 是一个仿 Google groupcache 的分布式缓存框架 (TypeScript 实现, 依赖 `@grpc/grpc-js` 与 `etcd3`), 核心设计目标是在无中心节点的前提下, 通过一致性哈希将 key 映射到固定节点, 实现缓存的分片存储与对等访问.

整体架构分为四层:

| 层次   | 组件                                | 职责                                  |
| ------ | ----------------------------------- | ------------------------------------- |
| 接口层 | `Group`                             | 命名空间隔离, 对外暴露 get/set/delete |
| 缓存层 | `Cache -> LruStore`                 | 分桶双层 LRU, 字节预算淘汰            |
| 路由层 | `ClientPicker` + `ConHashMap`       | 一致性哈希选节点, etcd 动态发现       |
| 传输层 | `Server` / `Client` (@grpc/grpc-js) | 节点间 RPC 通信                       |

```text
  调用方
    |
    v
+----------------------------------------------------------+
| 接口层  Group (命名空间隔离, 暴露 get/set/delete)        |
+----------------------------------------------------------+
    |
    v
+----------------------------------------------------------+
| 缓存层  Cache -> LruStore (分桶双层 LRU, 字节预算淘汰)   |
+----------------------------------------------------------+
    | 未命中
    v
+----------------------------------------------------------+
| 路由层  ClientPicker + ConHashMap (一致性哈希选节点)     |
|         etcd 动态服务发现                                |
+----------------------------------------------------------+
    | 归属远端
    v
+----------------------------------------------------------+
| 传输层  Server / Client (@grpc/grpc-js 节点间 RPC 通信)  |
+----------------------------------------------------------+
    |
    v
  对等节点 (每个节点既是 Server 也是 Client)
```

关键设计决策:

- 无中心节点: 每个节点既是 Server 也是 Client, 通过对等协议互访问
- Read-Through 语义: 调用方只需提供 Getter (`(ctx: AbortSignal, key: string) => Promise<Buffer>` 回源函数), 缓存层自动处理命中/未命中/远程获取
- 最终一致性: 写操作先写本地, 异步 (fire-and-forget) 传播到拥有该 key 的节点, 其他节点不通知, 属于弱一致的最终一致性而非复制

---

## 2. 读路径 (Read-Through) 设计

详细描述一次 Get 请求的完整链路.

```text
  调用方          Group           Cache        SingleFlight        ConHashMap      远端节点/数据源
    |               |               |               |               |               |
    |-- get(key) -->|               |               |               |               |
    |               |-- get ------->|               |               |               |
    |               |               |               |               |               |
    |               |  [命中] <-----+-- 返回值 -----|               |               |
    |               |               |               |               |               |
    |               |  [未命中]     |               |               |               |
    |               |-- do(key,fn) ---------------->|               |               |
    |               |               |               |-- pickPeer -->|               |
    |               |               |               |               |               |
    |               |               |               |  [归属自己]   |               |
    |               |               |               |-- getter(ctx, key) ---------->|
    |               |               |               |               |    回源数据   |
    |               |               |               |<------------------------------|
    |               |               |               |               |               |
    |               |               |               |  [归属远端]   |               |
    |               |               |               |-- peer.get ------------------>|
    |               |               |               |<------------------------------|
    |               |               |               |               |               |
    |               |<-- 填充缓存 --+<-- 返回值 ----|               |               |
    |<-- 返回值 ----|               |               |               |               |
```

完整链路 (对应 `group.ts` 中 `Group.get -> load -> loadData`):

1. 参数校验: 检查 Group 是否已关闭 (`closed` 标记)、key 是否为空
2. 本地缓存查询: `mainCache.get(key)` 返回 `[ByteView | null, boolean]`, 命中则直接返回
3. SingleFlight 去重: 未命中时进入 `SingleFlightGroup.do(key, fn)`, 相同 key 的并发请求共享同一个 Promise, 只执行一次加载
4. 路由决策: `peers.pickPeer(key)` 返回 `[Peer | null, ok, isSelf]`, 通过一致性哈希确定 key 的归属节点
   - 归属自己 (isSelf): 直接调用 `getter(ctx, key)` 回源
   - 归属远端: 调用 `peer.get(group, key)` 经 gRPC 获取
5. 降级回源: 远端调用失败时, catch 后 fallback 到本地 Getter
6. 写入缓存: 在 singleflight 回调内部, 按 `expiration` 配置写入本地 `mainCache` (`expiration > 0` 时用 `addWithExpiration`, 否则 `add`; 默认 `expiration = 0` 即不带 TTL)
7. 返回: 包装为 `ByteView` 返回给调用方

为什么统计计数和缓存填充放在 singleflight 回调内部?

`loads`、`loadDuration` 等计数以及 `mainCache.add` 都写在 `do(key, fn)` 的回调里, 而不是 `get` 的外层. 这样每次实际加载只统计一次: N 个并发等待者共享同一个 Promise, 回调只执行一次, 避免了等待方重复计数、重复写缓存. (Go 版口径不同: `loads`/`loadDuration` 在 `Do` 返回后对每个调用方各计一次, 即去重等待者也计入 loads, 且回调内多一次 `mainCache.Get` 二次检查.)

---

## 3. 写路径与写传播

Set 和 Delete 操作如何保证多节点间的数据一致性?

写路径 (对应 `group.ts` 中 `Group.set` / `Group.delete`):

1. 本地写入: 先对入参做防御性拷贝 (`cloneBytes`), 再写入本地 `mainCache`
2. 判断来源: 通过方法参数 `isPeerRequest` (默认 false) 判断请求是否来自其他节点的转发; 该标记由 Server 侧从 gRPC metadata `x-peer-request` 解析后传入
3. 异步传播: 如果不是来自 peer 的请求且已注册 peers, 调用 `syncToPeers` — 内部以立即执行的 async 闭包 (fire-and-forget) 运行, 不阻塞主流程:
   - 通过 `pickPeer(key)` 找到 key 的归属节点, 归属自己则直接返回
   - 如果归属远端, 调用 `peer.set(group, key, value)` 或 `peer.delete(group, key)`
   - Client 的所有 RPC (get/set/delete) 统一携带 per-call deadline (`deadlineMs`, 默认 3000ms)
   - ClientPicker 创建 Client 时固定设置 `peerRequest: true`, Client 会在每次调用的 metadata 中写入 `x-peer-request: true`, 防止接收方再次转发
   - 传播失败只 `log.warn` 记录, 不重试, 也不影响本地写入的返回

这种写传播方案的一致性保证是什么级别? 有什么局限?

这是最终一致性模型, 存在以下局限:

- fire-and-forget 异步传播, 不保证写入成功 (网络故障时丢失)
- 没有版本号/向量时钟, 并发写可能产生冲突 (last-write-wins)
- 3 秒 deadline 到期后直接放弃, 没有重试队列
- 只同步给环上拥有该 key 的单个节点, 其他节点的本地缓存可能读到旧值, 直到被淘汰或过期
- 适用于读多写少、对一致性要求不严格的缓存场景

---

## 4. 存储引擎: 分桶双层 LRU

LruStore 的分桶双层设计解决了什么问题?

对应 `lru.ts` 中的 `LruStore` 结构:

```ts
class LruStore implements Store {
  private caches: [InternalCache, InternalCache][]; // [桶][层], [0]=近期层, [1]=频繁层
  private onEvicted?: (key: string, value: Value) => void; // 淘汰回调
  private cleanupTimer: ReturnType<typeof setInterval> | null; // TTL 过期清理定时器
  private mask: number; // 桶选择的位掩码
  private closed = false; // 保证 close 幂等
  private bucketBytes: number[]; // 每个桶当前的存活字节数
  private bucketMaxBytes: number; // floor(maxBytes / (mask+1))
}
```

分桶 (Bucket Sharding) 的作用:

- 将 key 空间通过 BKDR Hash + 位掩码分散到 N 个桶 (Cache 默认 16 个)
- Node.js 单线程模型下不存在锁竞争, 分桶的意义在于: 把字节预算与淘汰循环限定在单个桶内, 写入触发的淘汰只需遍历一个桶的双层链表, 而不是整个缓存
- 桶数取 2 的幂次 (`maskOfNextPowOf2`), 用位运算 `hash & mask` 替代取模

双层 (L1/L2) 解决扫描污染问题 (类似 2Q 算法):

- L1 (近期层/probationary): 新写入的数据进入 L1, 容量较大 (Cache 层默认 `capPerBucket = 512`, LruStore 兜底默认为 1024), 类似 2Q 的 A1in
- L2 (频繁层/frequent): 被再次访问的数据从 L1 提升到 L2 (Cache 层默认 `level2Cap = 256`, LruStore 兜底默认为 1024), 类似 2Q 的 Am
- get 命中 L1 时, 数据从 L1 移除并提升到 L2 (证明该 key 有重复访问价值)
- get 命中 L2 时, 仅调整位置到最近使用端 (LRU 语义)
- 一次性扫描 (scan) 的数据只经过 L1, 不会被再次访问因此不会进入 L2, 避免挤占频繁访问的热数据
- 字节预算淘汰时优先从 L1 淘汰 (`evictTail`), L1 淘汰不出有效条目才淘汰 L2

兜底默认值的两版差异: Go 版 LruStore 的兜底默认与 Cache 层一致 (512/256), TS 版兜底为 1024/1024 — 由于 Cache 层总是显式传值, 该差异只在绕过 Cache 直接使用 LruStore 时可观察.

底层 InternalCache 为什么用数组而非链表节点?

```ts
class InternalCache {
  private doubleLink: [number, number][]; // 侵入式双向链表 (数组下标, [0] 为哨兵节点)
  private m: Node[]; // 固定容量节点池, Node = { k, v, expireAt }
  private hashMap: Map<string, number>; // key -> 1-based index
  private last: number; // 已分配的最大槽位 (单调递增直到 cap)
  private cap: number; // 容量上限
}
```

设计考量:

- 预分配: 构造函数一次性创建 `cap + 1` 个链表槽与 `cap` 个 Node 对象, 后续 put/evict 只修改索引, 不产生新分配
- 槽位复用: 装满后 (`last === cap`) 新写入直接摘下 LRU 尾节点, 复用其下标 (`hashMap.set(key, tailIdx)`), 同时完成淘汰与插入
- 哨兵节点: `doubleLink[0]` 作为环形链表头尾哨兵, 简化边界处理
- 字节统计外置: 条目大小 (`key.length + value.len()`) 由 `LruStore.bucketBytes` 按桶记账, InternalCache 自身不维护字节数

字节预算 (byte budget) 淘汰是如何工作的?

每个桶有独立的字节预算 `bucketMaxBytes = Math.max(1, Math.floor(maxBytes / (mask + 1)))` (仅当 `maxBytes > 0` 时; `maxBytes <= 0` 时预算为 0, 整体禁用字节预算淘汰; mask+1 即实际桶数):

1. `setWithExpiration` 写入新数据后, 累加该桶的 `bucketBytes`
2. 如果超出预算, 循环淘汰: 先尝试 L1 的 `evictTail()`, 返回 null 再用 L2 的 `evictTail()`
3. 每次淘汰通过 `handleEviction` 扣减桶字节数, 直到回到预算以内或无可淘汰条目

这保证了全部条目的记账字节数 (key 长度 + value 长度) 不超过配置的 `maxBytes` (Cache 默认 8MiB). 注意预算约束的是记账口径而非进程真实内存: 节点对象、双向链表数组、哈希索引等结构开销不计入记账, 也不反映进程 RSS.

---

## 5. TTL 与过期清理

TTL 过期是如何判定和清理的?

与 Go 版不同, TypeScript 实现没有粗粒度时钟, 直接使用 `Date.now()` 毫秒时间戳. 过期清理由两条路径协同:

懒清理 (读路径): `LruStore.get` 命中节点后先比较 `Date.now() >= expireAt`, 已过期则就地删除、扣减桶字节数并触发 `onEvicted`, 返回未命中. 读路径顺手完成清理, 不需要额外扫描.

定时清理 (后台): 构造函数按 `cleanupInterval` (默认 60s, 来自 `defaultCacheOptions.cleanupTime`) 启动 `setInterval`, `cleanupLoop` 遍历所有桶的双层链表, 收集过期 key 后批量 `deleteInternal`. 定时清理负责回收从未被再次读取的过期条目.

存储细节:

- `setWithExpiration` 计算 `expireAt = Date.now() + expirationMs`; `expirationMs <= 0` 时写入 `MAX_EXPIRE_AT` (`Number.MAX_SAFE_INTEGER`), 即永不过期
- `InternalCache.get` 以 `expireAt > 0` 作为有效条目的判据, 删除/淘汰时把槽位重置为 `expireAt = 0`
- `Cache.addWithExpiration` 发现 `expirationTime - Date.now() <= 0` 时等价于一次 delete, 不会写入已过期的值

为什么这里直接用 Date.now() 就够了?

Go 版引入粗粒度时钟是为了规避高 QPS 下 `time.Now()` 的 vDSO 开销. Node.js 单线程模型下, TTL 判断本身不是热点 (每次 get 一次调用), `Date.now()` 的开销可以忽略, 没有引入自定义时钟的必要. 代价是精度完全依赖系统时钟, 且 60s 级别的清理周期意味着过期条目最多会在内存中多停留一分钟.

---

## 6. SingleFlight 并发去重

SingleFlightGroup 的实现原理是什么? 与 Go 版 x/sync/singleflight 有何异同?

对应 `single-flight.ts`:

```ts
interface Call<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

class SingleFlightGroup {
  private m: Map<string, Call<unknown>> = new Map();
  async do<T>(key: string, fn: () => Promise<T>): Promise<T>;
}
```

实现原理:

1. 先 `m.get(key)`: 已有 call 则直接返回其 `promise`, 后续到达的请求全部共享这一个 Promise
2. 首个到达者创建一个 deferred Promise (通过 executor 回调解出 `resolve` / `reject`), 登记进 map
3. 预先挂 `promise.catch(() => {})`, 避免失败时没有任何等待者而触发 unhandledRejection
4. `await fn()`: 成功则 `resolve(result)`, 失败则 `reject(err)` 并重新抛出 (执行者自身也能感知错误)
5. `finally` 中 `m.delete(key)`, 后续请求会触发全新的一次执行

与 x/sync/singleflight 的差异:

| 维度        | yukino-cache (TS)        | x/sync/singleflight (Go)  |
| ----------- | ------------------------ | ------------------------- |
| 底层结构    | `Map` + 共享 Promise     | `sync.Mutex` + `map` + WG |
| 等待机制    | await 同一个 Promise     | `wg.Wait()`               |
| 错误处理    | reject 传播给所有等待者  | panic 传播给所有等待者    |
| Forget 方法 | 无 (finally 自动 delete) | 有                        |
| 适用场景    | 高并发读缓存             | 通用                      |

如果 fn 内部抛异常会怎样?

共享的 Promise 被 reject, 所有 await 它的调用方同时收到同一个错误 (执行者一侧还会 rethrow). 与 Go 版把 recover 包装成 error 的做法不同, 这里没有吞异常的逻辑 — JS 的异常本身就是一等错误值, 每个调用方可以自行 catch 处理; 预挂的空 catch 只是保证无等待者时进程不会因为 unhandledRejection 告警. 对缓存场景而言, 一次回源失败会让该 key 的所有并发等待者一起失败, 下一个请求会重新触发加载.

---

## 7. 一致性哈希

ConHashMap 的实现细节? 虚拟节点的作用是什么?

对应 `consistent-hash.ts`:

```ts
class ConHashMap {
  private config: ConHashConfig; // 副本数、哈希函数、自动再均衡配置
  private keys: number[] = []; // 排序的虚拟节点哈希值
  private hashMap: Map<number, string>; // 哈希值 -> 物理节点
  private nodeReplicas: Map<string, number>; // 物理节点 -> 当前副本数
  private nodeCounts: Map<string, number>; // 物理节点 -> 命中次数
  private totalRequests = 0; // 总请求次数
  private balancerTimer: ReturnType<typeof setInterval> | null; // 自动再均衡定时器 (可选)
}
```

虚拟节点 (默认 `defaultReplicas = 50` 个/物理节点):

- 解决数据倾斜: 3 个物理节点只有 3 个哈希点, key 分布极不均匀
- 50 个虚拟节点使分布趋近均匀 (标准差随虚拟节点数增加而减小)
- 哈希函数: 默认 `crc32` (`crc32.ts` 中手写的查表实现, IEEE 多项式 0xEDB88320), 对模板串 `` `${node}-${i}` `` 计算

查找过程:

1. 对 key 计算 `config.hashFunc(key)` 哈希
2. 在排序的 `keys` 数组上手写二分查找, 找到第一个哈希值大于等于目标 hash 的虚拟节点
3. 环形语义: 二分结果等于 `keys.length` 时回绕到 `keys[0]`
4. 通过 `hashMap.get(keys[idx])` 得到物理节点, 同时累加该节点的命中计数

节点增删时如何最小化数据迁移?

- 增加节点: 只影响新节点在环上 "接管" 的区间, 其他节点的 key 映射不变
- 删除节点: 该节点的虚拟点被移除, 其 key 顺时针漂移到下一个节点
- 理论上每次增删只迁移 `1/N` 的数据 (N 为节点数)

自动再均衡 (auto-rebalance) 是怎么工作的?

这是相对 Go 版的扩展能力, 默认关闭 (`autoRebalance: false`):

- 开启后每 1 秒检查一次: 总请求数达到 1000 且最大节点负载偏离均值超过 `loadBalanceThreshold` (默认 0.25) 时触发再均衡
- 按各节点的负载比例缩放其副本数 (过载则除以比例, 欠载则放大), 并钳制在 `[minReplicas=10, maxReplicas=200]` 区间
- 调整后清空计数重新统计; 本质是 "让热节点减少虚拟节点、冷节点增加虚拟节点", 使部分 key 在环上漂移到邻居, 从而摊匀请求压力, 并不迁移已缓存的数据

---

## 8. etcd 服务发现与注册

服务注册和发现的完整流程是什么?

基于 `etcd3` npm 库实现. 注册 (Server 侧, `register.ts` 中 `register` 函数):

1. 地址规范化: `resolveAdvertiseAddr` 把 `:port` 或 `0.0.0.0:port` 形式的地址, 通过 `getLocalIP()` (取第一个非 internal 的 IPv4 网卡) 改写为 `IP:port`, 失败时退化为 `127.0.0.1`; Server 也可通过 `advertiseAddr` 选项显式指定对外地址
2. 申请 Lease: `client.lease(leaseTTL)`, 默认 TTL 10 秒, etcd3 库内部自动续租
3. 写入注册项: `lease.put(key).value(addr)`, key 为 `/services/{svcName}/{addr}`
4. 租约丢失处理: 监听 lease 的 `lost` 事件, 未停止时延迟 1 秒后重新 acquire (固定间隔, 无指数退避; Go 版此处为指数退避 — 1s 起步、失败翻倍、封顶 30s, 属两版差异之一)
5. 优雅下线: `stopSignal` (AbortSignal) 触发 abort 时, revoke lease、删除 key、关闭 etcd 客户端

发现 (Client 侧, `ServiceDiscovery` + `ClientPicker`):

1. 初始化: `ClientPicker.start()` 先把自身地址加入哈希环 (保证 key 归属在全局视角下一致), 再 `fetchAll()` 全量拉取 `/services/{svcName}` 前缀下所有注册项, 过滤自身地址与非法地址 (`validPeerAddr` 校验) 后逐个建连入环
2. 持续监听: `watch()` 基于 `watch().prefix(...).create()` 创建 Watcher
3. 事件处理:
   - put 事件: 地址取自 `kv.value` (缺失时从 key 后缀解析), 创建 gRPC Client 并加入哈希环
   - delete 事件: 删除事件不携带 value, 地址从 key 后缀解析; 关闭 Client 并从哈希环移除
   - 始终跳过自身地址
4. 断线重连: etcd3 库内部自动重连; Watcher 触发 `connected` 事件时执行一次 `fetchAll()` 全量 resync, 对每个地址回调 onPut (已存在的连接会被 ClientPicker 去重)

为什么用 Watch + 重连后全量 Reconcile 而不是纯 Watch?

- 断线窗口内可能错过事件 (etcd 侧还可能发生 compaction), 纯 Watch 无法保证本地视图与 etcd 一致
- 全量 Reconcile 保证最终一致: 重连成功后重新 fetch, 对比本地状态增补缺失节点 (删除由 delete 事件单独驱动)
- 这是 etcd 服务发现的标准模式 (类似 Kubernetes Informer 的 List+Watch)

---

## 9. gRPC 传输层

gRPC 通信层是如何设计的?

基于 `@grpc/grpc-js` + `@grpc/proto-loader` (运行时动态加载 .proto). Proto 定义 (`proto/yukino.proto`):

```protobuf
service YukinoCache {
  rpc Get(Request) returns (ResponseForGet);
  rpc Set(Request) returns (ResponseForSet);
  rpc Delete(Request) returns (ResponseForDelete);
}
```

Server 侧 (`server.ts`):

- 注册 `YukinoCache` 服务 + gRPC Health 服务 (Check 方法按 service 名查 servingStatuses, 已注册服务返回 SERVING=1, 未知返回 UNKNOWN=0)
- `grpc.max_receive_message_length` 默认 4MiB (`maxMsgSize: 4 << 20`), 防止大 value 打爆内存
- 凭据: 配置 `tls` 且提供 `certFile` / `keyFile` 时用 `ServerCredentials.createSsl`, 否则 `createInsecure`
- 只有 Set/Delete handler 解析 `x-peer-request` metadata, 并以 `isPeerRequest` 布尔参数传给 `group.set` / `group.delete`; Get 不需要该标记
- 通过 `requestSignal(call)` 把 gRPC 调用的 cancelled 事件转成 AbortController signal, 作为 ctx 传给 Group 方法, 实现取消传播

Client 侧 (`client.ts`):

- `new proto.pb.YukinoCache(addr, grpc.credentials.createInsecure())` — 客户端固定 insecure, 不支持 TLS (生产部署需自行扩展)
- 三个方法 (get/set/delete) 统一携带 per-call deadline: `{ deadline: new Date(Date.now() + deadlineMs) }`, `deadlineMs` 默认 3000ms
- 构造时若 `peerRequest: true` (ClientPicker 总是这样创建), 每次调用的 metadata 都会写入 `x-peer-request: true`
- 响应处理: Get 返回 `Buffer.from(response.value)`; Delete 返回布尔 `response.value`

为什么选择 gRPC 而非 HTTP/REST?

- 二进制序列化 (protobuf) 比 JSON 更紧凑, 减少网络带宽
- HTTP/2 多路复用, 单连接支持并发请求
- 强类型接口定义, 编译期发现错误
- 内建 Health Check 协议, 配合 etcd 实现健康感知

---

## 10. 防转发环路机制

如何防止节点间的请求无限转发?

问题场景: A 收到用户请求, pickPeer 指向 B, 转发给 B. B 收到后如果再次转发给 C (或 A), 就会形成转发链甚至环路.

解决方案: 通过 gRPC metadata 标记 + 环归属判定双重保证.

```ts
// client-picker.ts:99-102 创建 Client 时固定 peerRequest: true; client.ts:33-39 将标记写入 gRPC metadata
private callMetadata(): grpc.Metadata {
  const metadata = new grpc.Metadata();
  if (this.peerRequest) metadata.set("x-peer-request", "true");
  return metadata;
}

// server.ts: Set/Delete handler 解析标记并透传给 Group
function isPeerRequest(call: grpc.ServerUnaryCall<any, any>): boolean {
  const meta = call.metadata.get("x-peer-request");
  return meta.length > 0 && meta[0] === "true";
}
```

规则:

- 写路径: Server 收到远端 Set/Delete 时, 把 `isPeerRequest = true` 传给 `group.set` / `group.delete`; 方法内部只要该标记为 true 就跳过 `syncToPeers`, 不再二次传播
- 读路径: Get handler 不读该标记, `loadData` 中也没有防转发检查; 一跳语义由环归属保证 — 所有节点基于同一份 etcd 数据构建哈希环, 被转发到的节点正是 key 的归属节点, 它 `pickPeer` 会得到 `isSelf = true`, 直接走本地 Getter
- 读路径一跳成立的前提是各节点的环视图一致; 若 etcd 事件乱序导致视图短暂不一致, 理论上可能出现二次转发, 这是最终一致服务发现的固有代价. 对照: Go 版在读路径做了显式防转发 — server 侧对 Get 注入 peer-request 标记 (`withPeerRequest(ctx)`), `loadData` 检测到标记则跳过 `pickPeer` 强制本地回源, 把"环视图短暂不一致导致的二次转发"从理论上消除; TS 版没有该检查, 这是两版当前的一处实质性不对齐

写传播最多一跳、读路径依赖环一致性, 两者结合在正常状态下杜绝了环路.

---

## 11. 并发模型

Node.js 单线程模型下, 这个项目如何处理并发?

TypeScript 实现没有任何互斥锁 (与 Go 版形成鲜明对比), 并发安全由事件循环模型天然保证:

| 关注点   | 做法                                                                                                |
| -------- | --------------------------------------------------------------------------------------------------- |
| 共享状态 | 同步代码段 (LRU 读写、哈希环查找、计数累加) 在事件循环中原子执行, 无数据竞争                        |
| 让出点   | 唯一的交错发生在 `await` 处; SingleFlight 在 Promise 层面去重, 同 key 并发只加载一次                |
| 写传播   | `syncToPeers` 用立即执行的 async 闭包 (fire-and-forget), 不阻塞主流程, 失败只记日志                 |
| 取消传播 | Server 把 gRPC call 的 cancelled 转成 AbortSignal 传给 Getter; Client 用 per-call deadline 控制超时 |
| 后台任务 | TTL 清理 (`setInterval`, 默认 60s) 与自动再均衡 (1s, 默认关闭) 以宏任务形式与请求处理交错           |
| 关闭幂等 | 各组件用 `closed` 布尔标记防重复清理 (单线程下读改写本身是原子的)                                   |

没有锁, 会不会出现 "读到写了一半的状态"?

不会. JS 的同步函数不会在执行中途被打断 — `LruStore.setWithExpiration` 里 "删旧条目、put 新条目、累加字节、触发淘汰" 这一整段都是同步的, 事件循环只在遇到 `await` (如 gRPC 调用、Getter 回源) 时才切换任务. 需要警惕的反而是跨 await 的状态一致性: SingleFlight 正是为此而设, 它保证两次 await 之间共享的加载结果只产生一份.

---

## 12. ByteView 不可变语义

ByteView 的设计意图是什么?

```ts
class ByteView implements Value {
  private b: Buffer;
  len(): number; // 实现 Value 接口, 供字节预算记账
  byteSlice(): Buffer; // 防御性拷贝 (Buffer.from(this.b))
  toString(): string; // b.toString()
}
```

设计意图:

- 缓存的 value 会被多个请求并发读取, 如果直接暴露 `Buffer`, 调用方可能意外修改, 污染缓存
- `ByteView` 封装底层 Buffer, 只暴露只读视图; `byteSlice()` 返回拷贝, 保证缓存内部数据不被外部篡改
- 实现 `Value` 接口的 `len()` 后, `LruStore` 的字节预算可以直接用 `key.length + value.len()` 记账, 存储引擎不感知具体 value 类型
- `toString()` 走 `b.toString()`, JS 字符串同样不可变, 天然安全

拷贝发生在哪些边界?

拷贝策略是 "信任内部、防御边界":

- `Group.set` 写入时先 `cloneBytes(value)`, 防止调用方后续修改入参影响缓存
- `loadData` 回源成功与 `getFromPeer` 拿到远端响应后, 都 `cloneBytes` 再包成 ByteView
- 本地 get 命中时直接返回内部 ByteView 引用, 零拷贝; 只有调用方显式调 `byteSlice()` 才复制 (如 Server 的 Get handler 返回 `view.byteSlice()` 给 gRPC)

这样只读场景 (序列化到网络等) 不产生额外分配, 真正需要可修改 `Buffer` 时才付出拷贝成本.

---

## 13. Group 注册表与生命周期

Group 的全局注册表如何工作? 重复注册会怎样?

```ts
const groups: Map<string, Group> = new Map();
```

- `newGroup(name, cacheBytes, getter, ...opts)`: 注册到全局 map; 与 Go 版不同, 重复名称不会 panic, 而是 `log.warn` 提示后直接替换旧实例 (旧实例未被 close, 使用方需自行管理)
- `getGroup(name)`: 按名称查找, 未找到返回 `undefined` (Server handler 据此返回 gRPC NOT_FOUND)
- `listGroups()`: 返回所有已注册 Group 名称
- `destroyGroup(name)`: 先从 map 移除再 `close()`, 返回是否存在
- `destroyAllGroups`: 快照所有 Group, 清空 map 后逐个 close

Group.close() 做了什么?

1. `closed` 布尔标记保证幂等, 重复调用直接返回
2. 关闭 `mainCache` (清理 TTL 定时器, 释放 store)
3. 从全局注册表 `groups` 中移除自身

注意: `Group.close` 不关闭 `peers`. `PeerPicker` 接口定义了 `close()` (`ClientPicker.close` 会关闭所有 gRPC Client、哈希环的再均衡定时器与 etcd Watcher), 但 Group 并不持有其生命周期: 销毁 Group 后, 若调用方没有单独 close picker, peer 连接与 etcd Watch 仍在运行. 这是当前实现的一个缺口.

另外 `registerPeers` 只允许调用一次, 重复调用会抛错; 而 functional option `withPeers` 走 `_setPeers` 则没有该限制, 两者行为不一致, 也值得留意.

---

## 14. 容错与降级策略

系统在各种故障场景下的行为是什么?

| 故障场景            | 处理方式                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------- |
| 远端 peer 不可达    | per-call deadline (默认 3s) 到期后, `loadData` catch 并 fallback 到本地 Getter 回源         |
| etcd 不可用 (注册)  | lease lost 事件触发重注册, 固定 1s 延迟, 服务本身不中断                                     |
| etcd 不可用 (发现)  | etcd3 Watcher 自动重连, connected 后 fetchAll 全量 resync; 期间沿用最后一次已知的 peer 列表 |
| Getter 回源失败     | 包装为 `failed to get data: ...` 抛出, 计入 loaderErrors, 不缓存错误结果                    |
| SingleFlight 内异常 | 共享 Promise reject, 所有等待者收到同一错误; finally 删除 key, 下个请求重新加载             |
| 节点优雅下线        | abort 信号触发 revoke lease + 删除注册 key, peer 收到 delete 事件移除该节点                 |
| 节点崩溃            | Lease 10s 过期, etcd 自动删除 key, peer 收到 delete 事件                                    |
| 写传播失败          | `log.warn` 记录后静默丢弃 (3s deadline), 不影响本地写入的成功返回                           |

如果 etcd 完全宕机, 缓存还能工作吗?

可以. 已建立的 gRPC 连接是长连接, 不依赖 etcd 持续可用. 影响仅限于:

- 无法发现新加入的节点
- 无法感知下线节点 (对已下线节点的请求会 deadline 到期后 fallback)
- 新节点无法注册 (但不影响其本地缓存功能)

---

## 15. 性能优化要点

项目中有哪些值得学习的性能优化?

1. 分桶存储: 字节记账与淘汰循环限定在单桶内, 写入触发的淘汰不必扫描全缓存
2. 数组式 LRU: 构造时预分配节点池, 装满后复用 LRU 尾节点下标, 稳态下零新增分配
3. BKDR Hash + 位掩码选桶: `hash & mask` 位运算替代取模, 且哈希分布均匀
4. 共享 Promise 的 SingleFlight: 同 key 并发请求只触发一次回源, 等待方零成本
5. 双层 LRU 抗扫描污染: 一次性扫描数据止步于 L1, 热数据在 L2 中受保护
6. ByteView 边界拷贝: 命中读取零拷贝, 仅在 set 入参、回源结果、RPC 出参等边界复制
7. 单线程无锁计数: stats 用普通字段累加, 无原子操作开销
8. per-call deadline: 每个 RPC 统一 3s 超时, 避免个别慢节点拖垮回源链路
9. Watch + 重连 resync: 正常运行只做增量 watch, 全量拉取仅在启动和重连时发生

---

## 16. 与 groupcache 的对比

yukino-cache 相比 Google groupcache 有哪些扩展?

| 维度         | groupcache                            | yukino-cache (TS)              |
| ------------ | ------------------------------------- | ------------------------------ |
| 存储引擎     | 单层 LRU (Group 层 sync.RWMutex 保护) | 分桶双层 LRU, 字节预算淘汰     |
| 服务发现     | 静态 peer 列表                        | etcd 动态发现 + Watch          |
| 写操作       | 不支持 (纯 read-through)              | 支持 set/delete + 异步写传播   |
| 传输层       | HTTP                                  | 纯 gRPC (@grpc/grpc-js)        |
| TTL          | 无内建 TTL                            | 内建 TTL + 懒清理 + 定时清理   |
| 负载均衡     | 静态哈希                              | 可选 auto-rebalance 动态副本数 |
| 并发模型     | 锁 + goroutine                        | 单线程事件循环 + Promise       |
| SingleFlight | Mutex + map + WaitGroup               | Map + 共享 Promise             |
| 健康检查     | 无                                    | gRPC Health Service            |

---

## 17. 可能的改进方向

如果让你继续演进这个项目, 会考虑哪些方向?

1. 一致性保证: 引入 Raft 或基于 etcd 的分布式锁实现强一致写
2. 写传播可靠性: 引入 WAL (Write-Ahead Log) + 重试队列, 避免异步写丢失
3. 热点探测: 对高频访问 key 自动复制到多个节点, 缓解热点问题
4. 客户端 TLS: Server 侧已支持 TLS 选项, 但 Client 固定 `createInsecure`, 生产环境需要双向 TLS/mTLS
5. 多副本: 一致性哈希支持 N 副本, 提高可用性
6. 指标暴露: 集成 Prometheus metrics (命中率、延迟分位数、淘汰速率)
7. LRU 改进: 考虑 TinyLFU (Caffeine 风格) 替代纯 LRU, 提高命中率
8. 序列化优化: 对大 value 支持 Snappy/LZ4 压缩存储
9. 生命周期闭环: Group.close 级联关闭 PeerPicker, 消除连接与 Watch 泄漏的缺口
