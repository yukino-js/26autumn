---
title: "后端中间件技术笔记"
---

> 覆盖 etcd、Kafka、groupcache、gRPC、Prometheus、Grafana、OpenTelemetry、Redis Stack 向量存储八大中间件的底层原理、生产实践与故障排查. 基于 Go 技术栈, 结合分布式系统理论与真实生产场景.

## 一、etcd 分布式键值存储

### etcd 的 Raft 一致性协议是如何保证数据强一致的?

etcd 使用 Raft 共识算法保证集群数据强一致性, 其核心机制分为 Leader 选举、日志复制和安全性保证三个层面.

Leader 选举

```
节点状态机: Follower -> Candidate -> Leader

选举触发条件:
- Follower 在 election timeout (默认 1000ms) 内未收到 Leader 心跳
- Candidate 将 currentTerm + 1, 投票给自己, 向所有节点发送 RequestVote RPC

选举规则:
- 每个节点在一个 Term 内只能投一票 (先到先得)
- Candidate 获得多数票 (N/2 + 1) 成为 Leader
- 日志较新的节点优先当选 (比较 lastLogTerm, 再比较 lastLogIndex)
- 随机化 election timeout (etcd 在 [electiontimeout, 2*electiontimeout) 区间取随机值, 默认即 [1000ms, 2000ms)) 避免活锁
```

日志复制

```go
// 客户端写入流程
// 1. 客户端请求发送到 Leader
// 2. Leader 将日志追加到本地 (uncommitted)
// 3. Leader 并行发送 AppendEntries RPC 给所有 Follower
// 4. 多数节点确认后, Leader commit 并应用到状态机
// 5. Leader 通知 Follower commit index 更新

type Entry struct {
    Term  uint64  // 任期号
    Index uint64  // 日志索引
    Type  EntryType
    Data  []byte  // 序列化后的操作
}
```

安全性保证

| 保证                 | 实现方式                                          |
| -------------------- | ------------------------------------------------- |
| Election Safety      | 每个 Term 最多一个 Leader                         |
| Leader Append-Only   | Leader 不覆盖/删除自己的日志                      |
| Log Matching         | 如果两个日志在相同 index/term, 则之前所有条目相同 |
| Leader Completeness  | 已 commit 的日志一定出现在所有后续 Leader 中      |
| State Machine Safety | 所有节点对同一 index 应用相同命令                 |

etcd 中的 Raft 优化

- PreVote: 节点在发起选举前先进行 PreVote, 避免网络分区恢复后扰乱集群
- CheckQuorum: Leader 定期检查是否仍与多数节点连通, 否则主动下台
- Learner 角色: 非投票成员, 用于新节点加入时先同步数据再提升为 Voter
- Joint Consensus: 成员变更采用两阶段 (C_old + C_new), 避免脑裂

### etcd 的 MVCC 多版本并发控制是如何实现的?

etcd 的 MVCC 基于 BoltDB 实现, 为每个 key 维护多个版本, 支持历史版本查询和 Watch 机制.

核心数据结构

```
keyIndex (内存 B-tree, Google btree 实现):
  key -> {
    generations: [
      { created: revision, revs: [modRevision1, modRevision2, ...] },
      { created: revision, revs: [...] }  // 每次 delete 后 put 产生新 generation
    ]
  }

BoltDB 存储:
  bucket "key": revision -> KeyValue{key, value, create_revision, mod_revision, version, lease}
  bucket "meta": finishedCompactRev, scheduledCompactRev
```

Revision 体系

```
Revision 是全局递增的逻辑时钟:
  main revision: 每次事务 +1 (集群全局唯一)
  sub revision:  同一事务内多个操作的序号 (从 0 开始)

示例:
  txn { put a=1; put b=2 }  -> a: {main:5, sub:0}, b: {main:5, sub:1}
```

读请求的 MVCC 处理

```go
// Range 请求处理
func (s *store) Range(ctx context.Context, key, end []byte, ro RangeOptions) (*RangeResult, error) {
    // 1. 确定读取的 revision
    //    - ro.Rev == 0: 使用当前 latest revision (线性一致性读)
    //    - ro.Rev > 0: 读取历史版本
    //    - ro.Rev < compactRevision: 返回 ErrCompacted

    // 2. 通过 keyIndex 找到目标 revision 对应的 modRevision
    //    - 在 generations 中二分查找 <= targetRev 的最大 rev
    //    - 如果该 rev 是 tombstone (delete marker), 则 key 不存在

    // 3. 用 modRevision 从 BoltDB 读取实际 KeyValue
}
```

Compaction 对 MVCC 的影响

```
Compact(rev) 会:
1. 删除 BoltDB 中 revision <= rev 的所有历史 KeyValue
2. 清理 keyIndex 中已无对应数据的旧 revision
3. 释放磁盘空间 (需要 Defrag 才能真正回收)
4. 早于 compactRev 的 Watch 会收到 ErrCompacted
```

### etcd 的 Watch 机制底层是如何工作的?

etcd 的 Watch 是基于 gRPC 流式通信和 MVCC revision 的增量事件推送机制.

整体架构

```
Client (gRPC Watch Stream)
    |
    v
watchableStore (etcd server 端)
    |
    +-- synced watcher group: 监听最新 revision 的实时事件
    |
    +-- unsynced watcher group: 需要从历史 revision 追赶的 watcher
    |
    v
BoltDB (历史事件存储)
```

Watch 建立流程

```go
// 客户端
watcher := clientv3.NewWatcher(client)
watchChan := watcher.Watch(ctx, "prefix/", clientv3.WithPrefix(), clientv3.WithRev(100))

// 服务端处理
// 1. 建立 gRPC 双向流 (WatchServer)
// 2. 创建 watcher 结构: {key, end, startRev, filters, progressNotify}
// 3. startRev < currentRev: 加入 unsynced group, 从 BoltDB 追赶
// 4. startRev >= currentRev: 加入 synced group, 等待实时事件
```

关键特性

| 特性            | 说明                                                         |
| --------------- | ------------------------------------------------------------ |
| 有序性          | 同一 key 的事件按 revision 严格有序                          |
| 可靠性          | 基于 revision 的断点续传, 网络断开重连后从上次 revision 继续 |
| 历史回放        | 支持从任意未 compact 的 revision 开始 Watch                  |
| Progress Notify | 定期发送空事件通知当前 revision, 用于检测连接活性            |
| Filter          | 支持 NOPUT / NODELETE 过滤, 减少无用事件                     |
| PrevKV          | 事件中携带变更前的旧值                                       |

生产注意事项

- Watch 的 key 范围不宜过大, 避免 server 端遍历开销
- 客户端必须处理 `ErrCompacted`, 收到后执行全量同步再重新 Watch
- 大量 Watcher 监听同一 key 时, server 端使用 watcherGroup 批量分发
- gRPC stream 的 `WithProgressNotify()` 用于检测静默断连 (无参调用; 通知间隔由服务端 `--experimental-watch-progress-notify-interval` 控制, 默认 10min)

### etcd 的 Lease 和 KeepAlive 机制如何保证服务发现的可靠性?

Lease 机制

```go
// Lease 是一个带 TTL 的租约, 绑定到 key 上
// key 的生命周期与 Lease 绑定: Lease 过期 -> key 自动删除

lease, _ := client.Grant(ctx, 10)  // TTL = 10s
client.Put(ctx, "services/node-1", addr, clientv3.WithLease(lease.ID))
```

KeepAlive 实现

```go
// 客户端: 每 TTL/3 发送一次 KeepAlive RPC (gRPC 双向流批量续租)
keepAliveCh, _ := client.KeepAlive(ctx, lease.ID)
for resp := range keepAliveCh {
    // resp.TTL: 服务端确认的剩余 TTL
}

// 服务端: 最小堆管理过期检查, 后台 goroutine 定期扫描堆顶
```

服务发现完整流程

```
注册方:
  1. Grant Lease (TTL=10s)
  2. Put key with Lease: /services/{service}/{instance} = {addr, metadata}
  3. 启动 KeepAlive (每 3s 续租)
  4. 进程退出时 Revoke Lease (优雅下线)

发现方:
  1. Get prefix: /services/{service}/ (获取当前所有实例)
  2. Watch prefix: /services/{service}/ (监听实例变更)
  3. PUT 事件 -> 加入实例列表
  4. DELETE 事件 -> 从实例列表移除

可靠性保证:
  - 进程崩溃: 无法续租, TTL 后 key 自动删除
  - 网络分区: 续租失败, 但 TTL 窗口内不会误删
  - 服务端重启: Lease 持久化在 BoltDB, 重启后恢复
```

### etcd 的 BoltDB 存储引擎有什么特点? 为什么选择它?

BoltDB 核心特点

```
存储结构:
  - 单文件存储, B+ tree 索引, 页大小默认 4096 bytes
  - 读写互斥: 同一时刻只有一个写事务, 多个只读事务可并发
  - 写事务使用 Copy-on-Write (COW)
  - 使用 mmap 将整个文件映射到虚拟地址空间, 读操作零拷贝
```

为什么 etcd 选择 BoltDB

| 需求     | BoltDB 的满足方式                             |
| -------- | --------------------------------------------- |
| 强一致性 | 单写事务 + fsync 保证持久化                   |
| 读性能   | mmap 零拷贝, B+ tree O(log N) 查找            |
| 事务安全 | COW 保证崩溃一致性                            |
| 简单可靠 | 单文件, 无后台 compaction 线程                |
| 范围查询 | B+ tree 叶子节点有序链表, 天然支持 range scan |

BoltDB 的局限与应对

```
局限 1: 写放大 (COW 复制整路径) -> etcd 后端用批量事务 (默认约 100ms batch interval) 摊薄 BoltDB 提交/fsync 开销
局限 2: 单写锁 -> 写入瓶颈在 Raft 共识, 非 BoltDB
局限 3: 空间碎片 (文件只增不减) -> 定期 Defrag
局限 4: 大 value 性能差 -> etcd 限制 value 最大 1.5MB
```

### etcd 集群的线性一致性读(Linearizable Read)是如何实现的?

ReadIndex 机制

```go
// 线性一致性读流程 (默认模式)
// 1. 客户端发送 Range 请求到任意节点
// 2. 如果目标不是 Leader, 转发给 Leader
// 3. Leader 记录当前 commit index 作为 readIndex
// 4. Leader 向多数节点发送心跳确认自己仍是 Leader
// 5. 多数节点确认后, Leader 等待状态机 apply 到 readIndex
// 6. 从状态机读取数据返回客户端
```

三种读模式对比

| 模式                | 一致性        | 延迟              | 实现             |
| ------------------- | ------------- | ----------------- | ---------------- |
| Linearizable (默认) | 最强          | 最高 (需多数确认) | ReadIndex + 心跳 |
| LeaseRead           | 强 (依赖时钟) | 中                | Leader Lease     |
| Serializable        | 最终一致      | 最低              | 直接读本地       |

```go
// 可序列化读: 直接读本地数据, 不保证最新
resp, _ := client.Get(ctx, "key", clientv3.WithSerializable())
```

### etcd 在生产环境中如何做性能调优和容量规划?

关键性能指标

```
核心指标 (通过 /metrics 暴露):
  - etcd_disk_wal_fsync_duration_seconds: WAL fsync 延迟 (P99 < 10ms)
  - etcd_disk_backend_commit_duration_seconds: BoltDB commit 延迟 (P99 < 25ms)
  - etcd_server_proposals_failed_total: 提案失败数 (应为 0)
  - etcd_mvcc_db_total_size_in_bytes: 数据库文件大小
```

磁盘优化 (最关键)

```bash
# 必须使用 NVMe SSD, 独占磁盘, XFS 文件系统
--quota-backend-bytes=8589934592  # 8GB
--snapshot-count=5000
--heartbeat-interval=500
--election-timeout=5000
```

容量规划

```
数据库大小: key_count * avg(key_size + value_size + 100B overhead)
写入吞吐: 单集群 < 10k writes/s
Watch 连接: 单节点 < 10k stream
集群规模: 3 或 5 节点 (不超过 7)
```

### etcd 的 Compact 和 Defrag 机制是什么? 为什么需要它们?

Compact: 逻辑删除指定 revision 之前的历史版本, 不释放磁盘空间.

Defrag: 重建 BoltDB 文件, 真正释放磁盘空间. 生产环境必须逐节点执行.

```bash
# 碎片率 = (db_total_size - db_size_in_use) / db_total_size
# 碎片率 > 50% 时建议 defrag
etcdctl defrag --endpoints=https://node-1:2379  # 逐节点执行
```

---

## 二、Kafka 分布式消息队列

### Kafka 的整体架构是怎样的? 各组件职责是什么?

核心架构

```
Producer -> Broker Cluster (Partition Leader/Follower) -> Consumer Group
                         |
                  ZooKeeper / KRaft (元数据)
```

各组件职责

| 组件           | 职责                                     |
| -------------- | ---------------------------------------- |
| Producer       | 序列化、分区选择、批量发送、重试         |
| Broker         | 消息存储和转发, 管理 Partition 副本      |
| Controller     | Partition Leader 选举、Broker 上下线处理 |
| Consumer Group | 组内 Consumer 分摊 Partition, 组间广播   |
| Partition      | 有序不可变日志, 并行度的基本单位         |
| Offset         | 消费位移, 记录消费进度                   |

消息路由

```
- 指定 key: hash(key) % partition_count
- 无 key: 粘性分区策略 (Sticky Partitioner)
- 自定义 Partitioner: 实现 Partitioner 接口
```

### Kafka 如何保证消息不丢失?

三端配合

| 端       | 关键配置                                                                   | 作用                      |
| -------- | -------------------------------------------------------------------------- | ------------------------- |
| Producer | acks=all, retries=MAX, idempotence=true                                    | 等待 ISR 确认, 重试不重复 |
| Broker   | replication.factor=3, min.insync.replicas=2, unclean.leader.election=false | 多副本, 禁止不全副本当选  |
| Consumer | enable.auto.commit=false, 手动 commitSync                                  | 处理完再提交              |

端到端保证矩阵

| 配置组合                    | 语义          |
| --------------------------- | ------------- |
| acks=1, auto.commit=true    | At-most-once  |
| acks=all, auto.commit=false | At-least-once |
| acks=all + 幂等 + 事务      | Exactly-once  |

### Kafka 的 ISR 机制和 Leader 选举是如何工作的?

ISR (In-Sync Replicas)

```
ISR: 与 Leader 保持同步的副本集合
HW (High Watermark): ISR 中所有副本的最小 LEO, Consumer 只能读到 HW 之前的消息
LEO (Log End Offset): 每个副本下一条要写入的 offset

Follower 在 replica.lag.time.max.ms (默认 30s) 内未追上 Leader 则被踢出 ISR
```

Leader 选举

```
1. Controller 检测到 Broker 下线
2. 从 ISR 列表中选择第一个存活副本作为新 Leader
3. ISR 为空时:
   - unclean.leader.election.enable=true: 从 OSR 选 (可能丢数据)
   - unclean.leader.election.enable=false: Partition 不可用
```

### Kafka 如何实现高吞吐? 零拷贝和顺序写的作用是什么?

五大核心设计

```
1. 顺序写磁盘: append-only, 顺序写速度接近内存 (600MB/s)
2. Page Cache: 写入 OS page cache, 读取热数据零磁盘 I/O
3. 零拷贝 (sendfile): Disk -> Kernel -> NIC, 减少 2 次拷贝 + 2 次上下文切换
4. 批量与压缩: Producer 攒批, 端到端压缩 (lz4/zstd)
5. 分区并行: 多 Partition 分布在不同 Broker
```

零拷贝对比

```
传统: Disk -> Kernel -> User -> Socket -> NIC (4 次拷贝, 4 次切换)
Kafka: Disk -> Kernel -> NIC (2 次 DMA 拷贝, 2 次切换)
```

### Kafka Consumer Group 的 Rebalance 机制是怎样的?

触发条件: Consumer 加入/离开、心跳超时、处理超时、Partition 数变化.

Eager 协议: Stop-the-World, 所有 Consumer 停止消费后重新分配.

Cooperative Rebalance (Kafka 2.4+): 增量式, 只迁移受影响的 Partition, 未受影响的继续消费.

```properties
# 减少不必要 Rebalance
session.timeout.ms=45000
heartbeat.interval.ms=15000
max.poll.interval.ms=600000
partition.assignment.strategy=CooperativeStickyAssignor
```

### Kafka 的 Exactly-Once 语义是如何实现的?

幂等 Producer: PID + Sequence Number, Broker 去重, 保证单 Partition 不重复.

事务: 跨 Partition 原子写入, 两阶段提交 (Prepare -> Commit/Abort).

```java
producer.initTransactions();
producer.beginTransaction();
producer.send(record1);
producer.send(record2);
producer.sendOffsetsToTransaction(offsets, groupId);
producer.commitTransaction();
```

Consumer 配合: `isolation.level=read_committed`, 只读已提交事务的消息.

### Kafka 的日志存储结构是怎样的? Segment 和 Index 如何配合工作?

目录结构

```
topic-a-0/
  00000000000000000000.log        # 数据 (RecordBatch 序列)
  00000000000000000000.index      # 偏移量稀疏索引 (每 4KB 一条)
  00000000000000000000.timeindex  # 时间戳稀疏索引
```

查找过程: 文件名定位 Segment -> .index 二分查找 -> .log 顺序扫描.

Segment 滚动: log.segment.bytes=1GB 或 log.roll.ms=7天, 满足任一触发.

### Kafka 的 Controller 机制和元数据管理(KRaft)是怎样的?

ZooKeeper 模式: Controller 通过 ZK 临时节点选举, 元数据存 ZK, 大集群瓶颈明显.

KRaft 模式 (3.3+): 去除 ZK, Controller Quorum 用 Raft 管理元数据, 存储在 `__cluster_metadata` Topic.

```
优势:
  - 元数据变更: 秒级 -> 毫秒级
  - 支持百万级 Partition
  - Controller failover: 分钟级 -> 秒级
  - Kafka 4.0 完全移除 ZK
```

---

## 三、groupcache 分布式缓存

### groupcache 的整体架构和设计哲学是什么?

设计哲学: 无中心节点、不可变数据 (只读 read-through)、自动填充、去中心化一致性哈希.

核心组件

```go
type Group struct {
    name       string
    getter     Getter              // 缓存未命中时的加载函数
    peers      PeerPicker          // 一致性哈希选节点
    mainCache  cache               // 本地 LRU (本机负责的数据)
    hotCache   cache               // 热点 LRU (远程数据的本地缓存)
    loadGroup  singleflight.Group  // 防击穿
}
```

请求流程: 查 mainCache -> 查 hotCache -> singleflight 去重 -> 一致性哈希选节点 -> 本机则 Getter 加载, 远程则 RPC 获取 -> 写缓存 -> 返回.

### groupcache 的一致性哈希是如何实现的?

```go
// 每个真实节点映射 50 个虚拟节点, 排序后二分查找
type Map struct {
    hash     Hash            // crc32
    replicas int             // 50
    keys     []int           // 排序的哈希值
    hashMap  map[int]string  // 哈希值 -> 真实节点
}

// 节点变更只影响 1/N 的数据, 对比 hash%N 几乎全部重映射
```

### groupcache 的 singleflight 机制如何防止缓存击穿?

```go
// 同一 key 的并发请求合并为一个
// 100 个并发请求 -> 1 个执行 Getter, 99 个等待共享结果
func (g *Group) Do(key string, fn func() (interface{}, error)) (v interface{}, err error, shared bool) {
    // 已有相同 key 在执行 -> Wait 共享结果
    // 第一个请求 -> 执行 fn, 完成后通知所有等待者
}
```

### groupcache 的 LRU 缓存淘汰策略和内存管理是怎样的?

经典 LRU: 双向链表 + 哈希表, 字节预算制 (非条目数限制).

双缓存设计:

- `mainCache`: 缓存本机负责的数据 (占 7/8)
- `hotCache`: 缓存远程热点数据 (占 1/8), 减少 RPC 次数

### groupcache 与 Redis 等集中式缓存相比, 适用场景和优劣是什么?

| 维度   | groupcache         | Redis            |
| ------ | ------------------ | ---------------- |
| 架构   | 去中心化, 嵌入应用 | 中心化, 独立集群 |
| 写操作 | 不支持             | 完整 CRUD        |
| 过期   | 无 TTL, LRU 淘汰   | TTL + LRU/LFU    |
| 延迟   | 本地命中微秒级     | 一次网络 RTT     |
| 持久化 | 无                 | RDB/AOF          |

适合: 读多写少的不可变数据、延迟敏感、不想引入额外中间件.

### groupcache 的分布式请求流程是怎样的? 如何处理节点故障?

故障处理: 远程请求失败时降级到本地 Getter. 原版 groupcache 不内置服务发现, 节点列表在启动时静态配置; 生产环境通常外接 etcd/ZooKeeper Watch 感知节点变化并更新哈希环 (如 yukino_cache 的做法); 节点恢复后重新加入, 缓存逐步预热.

---

## 四、gRPC 高性能 RPC 框架

### gRPC 的整体架构和调用流程是怎样的?

分层: Application -> Generated Code -> Interceptors -> Channel/Transport (HTTP/2) -> Serialization (Protobuf) -> Network (TCP/TLS).

调用流程: Client Stub 序列化 -> Interceptor 链 -> HTTP/2 HEADERS+DATA 帧 -> Server 路由 -> Interceptor 链 -> 反序列化 -> Handler -> 响应.

### HTTP/2 协议为 gRPC 带来了哪些关键能力?

```
1. 多路复用: 单连接并行多 stream, 避免队头阻塞
2. 双向流: 支持四种通信模式
3. HPACK 头部压缩: 元数据高效传输
4. 流控: 连接级 + stream 级双层 WINDOW_UPDATE
```

### Protocol Buffers 的编码原理是什么? 为什么比 JSON 高效?

编码: Tag(field_number << 3 | wire_type) + Value, Varint 变长编码, ZigZag 处理负数.

对比 JSON: 无字段名、二进制编码, 体积小 3-5 倍, 编解码快 5-20 倍, 编译时类型安全, field number 保证向后兼容.

### gRPC 的四种通信模式分别适用什么场景?

| 模式             | 适用场景                   |
| ---------------- | -------------------------- |
| Unary            | CRUD、查询                 |
| Server Streaming | 日志流、实时行情、大结果集 |
| Client Streaming | 文件上传、批量提交         |
| Bidi Streaming   | 聊天、实时协作             |

### gRPC 的拦截器(Interceptor)机制是如何实现的?

洋葱模型: 请求方向 Interceptor1 -> 2 -> 3 -> Handler, 响应方向反向. 通过链式包装实现.

生产常用: 日志、认证、Panic Recovery、限流、链路追踪.

### gRPC 的负载均衡和服务发现是如何集成的?

架构: Name Resolver (服务发现) -> Load Balancer (选地址) -> SubConn (实际连接).

etcd 集成: Resolver Watch etcd 前缀, 实时更新地址列表; 配合 round_robin 负载均衡.

### gRPC 的 KeepAlive、超时和重试机制如何保证调用可靠性?

```
KeepAlive: HTTP/2 PING 帧检测死连接
超时: context 传播, grpc-timeout header 跨服务传递剩余超时
重试: Service Config 配置, 指数退避, 只重试幂等请求
```

### gRPC 的流控(Flow Control)和连接管理是怎样的?

双层流控: 连接级 + stream 级, WINDOW_UPDATE 帧控制发送速率. 高吞吐场景调大 InitialWindowSize (1MB+).

连接管理: 默认单连接多路复用; 高并发可用连接池; GracefulStop 优雅关闭.

---

## 五、Prometheus 监控系统

### Prometheus 的整体架构和数据流是怎样的?

```
Service Discovery -> Prometheus Server (Pull -> TSDB -> HTTP API) -> Alertmanager / Grafana
Exporters (/metrics) -> Prometheus
Pushgateway (短生命周期任务) -> Prometheus
Remote Write -> Thanos/Cortex (长期存储)
```

### Prometheus 的四种指标类型有什么区别?

| 类型      | 特点               | 适用                      |
| --------- | ------------------ | ------------------------- |
| Counter   | 只增不减           | 请求总数、错误总数        |
| Gauge     | 可增可减           | 内存、连接数              |
| Histogram | 分桶 + sum + count | 延迟分布 (推荐)           |
| Summary   | 客户端分位数       | 单实例精确 P99 (不可聚合) |

### PromQL 的核心概念和常用查询模式有哪些?

```text
rate(http_requests_total[5m])                          # 速率
histogram_quantile(0.99, rate(duration_bucket[5m]))    # P99
sum(rate(errors[5m])) / sum(rate(requests[5m]))        # 错误率
predict_linear(disk_avail[1h], 4*3600) < 0             # 磁盘预测
absent(up{job="svc"})                                  # 存活检测
```

### Prometheus 的存储引擎(TSDB)是如何设计的?

```
写入: Samples -> WAL -> Head Block (内存, 2h) -> Persistent Block (磁盘)
编码: Delta-of-Delta (时间戳) + XOR (值), 1-2 bytes/sample
压缩: 2h -> 6h -> 18h -> 54h -> ... (严格 3 倍递增, 上限 min(31d, retention 的 10%))
```

### Prometheus 的服务发现机制是如何工作的?

抓取目标不写死在配置里, 而是 SD 机制动态生成 target 列表, 每个 scrape_interval 重新评估:

```
scrape_config (job)
  -> SD 机制 生成候选项 (每个带 __meta_* 标签)
  -> relabel_configs 过滤/重写 (丢弃不满足条件的候选项)
  -> 最终 target (__address__ = host:port)
  -> 抓取后 metric_relabel_configs 再过滤指标
```

常见 SD 机制:

| 机制          | 来源                              | 典型 \__meta_ 标签                        |
| ------------- | --------------------------------- | ----------------------------------------- |
| static        | 配置文件写死                      | 无                                        |
| kubernetes_sd | kube-apiserver (Pod/Service/Node) | kubernetes*pod_name, pod_label*\*, pod_ip |
| consul_sd     | Consul catalog                    | consul_address, consul_tags               |
| etcd_sd       | etcd keys                         | etcd_key                                  |
| dns_sd        | SRV/A 记录                        | dns_name                                  |
| file_sd       | JSON/YAML 文件 (可热更新)         | 自定义 labels                             |

Relabeling 是 SD 的核心配套, 发生在抓取前:

```yaml
relabel_configs:
  - action: keep # 只保留带注解的 Pod
    source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_scrape]
    regex: "true"
  - action: replace # 用 Pod 注解覆盖抓取端口
    source_labels:
      [__address__, __meta_kubernetes_pod_annotation_prometheus_io_port]
    regex: ([^:]+)(?::\d+)?;(\d+)
    replacement: $1:$2
    target_label: __address__
  - action: labelmap # 把 meta 标签映射成业务标签
    regex: __meta_kubernetes_pod_label_(.+)
  - action: drop # 丢弃指标 (在 metric_relabel_configs 中)
```

与 Spring Cloud/Consul 这类"注册中心推送"的区别: Prometheus 是拉模型, SD 只是回答"该去哪里抓", 服务本身不感知监控; target 消失 (Pod 删除) 后 instance 自动从 target 列表移除, up 指标随之消失, `absent(up{job=...})` 可用于"目标整个不见了"的告警.

### Prometheus 的告警规则和 Alertmanager 是如何协作的?

```
告警状态: Inactive -> Pending (for 计时) -> Firing -> Resolved
Alertmanager: 分组 -> 抑制 -> 静默 -> 路由 -> 通知 (Email/Slack/PagerDuty)
```

### Prometheus 在高基数场景下如何优化?

```
- Relabeling 丢弃高基数标签 (user_id, trace_id)
- 聚合 URL 路径 (/api/users/123 -> /api/users/:id)
- Recording Rules 预聚合
- 架构: 分片 + Thanos/VictoriaMetrics 长期存储
- 设计原则: 标签值有限, 避免无界标签
```

---

## 六、Grafana 可视化平台

### Grafana 的架构设计和插件体系是怎样的?

架构: Frontend (React) + Backend (Go) + Storage (SQLite/MySQL/PG).

三类插件: Data Source (对接数据源)、Panel (可视化组件)、App (完整应用扩展). 后端插件通过 gRPC 通信, 数据格式 Apache Arrow.

### Grafana 的 Dashboard 数据查询和渲染流程是怎样的?

```
打开 Dashboard -> 解析 JSON Model -> 每个 Panel 替换变量 -> POST /api/ds/query
-> Data Source Plugin 转换查询 -> 执行 -> 返回 DataFrame -> 前端渲染
```

### Grafana 的告警系统(Unified Alerting)是如何工作的?

```
Alert Rules -> Scheduler (定期评估) -> State Manager -> Notification -> Contact Points
支持跨数据源查询, Reduce/Math/Threshold 表达式, for 持续时间
```

### 如何设计一个生产级的 Grafana 监控大盘?

分层: L0 全局概览 (Golden Signals: Traffic/Latency/Errors/Saturation) -> L1 服务详情 -> L2 基础设施.

最佳实践: 模板变量、Threshold 标注 SLA、Annotation 标记部署、Dashboard as Code.

---

## 七、OpenTelemetry 可观测性

### OpenTelemetry 的整体架构和核心概念是什么?

三大支柱: Metrics + Traces + Logs, 统一采集/处理/导出.

核心概念: API (接口定义) -> SDK (实现) -> Collector (独立进程) -> OTLP (标准协议).

### OpenTelemetry 的 Trace 数据模型和上下文传播是怎样的?

数据模型: Trace (128-bit trace_id) -> Span (64-bit span_id, parent, attributes, events, status).

上下文传播: W3C Trace Context (`traceparent` header), Go 通过 propagation.TraceContext\{\} 注入/提取.

### OpenTelemetry Collector 的架构和 Pipeline 是怎样的?

Pipeline: Receiver (输入) -> Processor (处理: batch/filter/attributes) -> Exporter (输出).

部署模式: Agent (DaemonSet) -> Gateway (集中处理) -> Backend. 推荐混合模式.

### OpenTelemetry 的采样策略有哪些? 生产环境如何选择?

```
Head Sampling: TraceIDRatioBased(0.1), ParentBased
Tail Sampling: 错误全采 + 慢请求全采 + 正常 1-5%

低流量: 100% | 中流量: 10% + 错误全采 | 高流量: Tail Sampling
```

### 如何在 Go 微服务中落地 OpenTelemetry?

```go
// 初始化: otlptracegrpc Exporter + Resource + TracerProvider + Propagator
// HTTP: otelhttp.NewHandler 自动埋点
// gRPC: otelgrpc.NewServerHandler / NewClientHandler
// DB: otelsql.Open 或 GORM tracing.Plugin
// 手动: tracer.Start(ctx, "operation") + span.RecordError + span.SetStatus
```

### OpenTelemetry 的 Metrics 和 Logs 信号是如何与 Trace 关联的?

```
Metrics -> Trace: Exemplar (Histogram 样本中嵌入 trace_id)
Logs -> Trace: 日志中注入 trace_id/span_id
统一 Resource: 所有信号共享 service.name, instance 标签
Grafana: 指标图表点击 Exemplar -> Trace 详情 -> 关联 Logs
```

---

## 八、Redis Stack 向量存储

### Redis Stack 的向量搜索(RedisSearch)架构是怎样的?

Redis Stack 在 Redis 核心之上集成了 RediSearch (全文搜索 + 向量搜索)、RedisJSON、RedisTimeSeries、RedisBloom 等模块.

向量搜索架构

```
数据层:
  - Redis Hash / JSON 存储原始文档和向量字段
  - 向量以 BLOB 格式存储 (FLOAT32/FLOAT64)

索引层 (RediSearch):
  - FT.CREATE 创建索引, 指定 VECTOR 字段
  - 支持 HNSW 和 FLAT 两种索引算法
  - 索引在内存中构建, 支持增量更新

查询层:
  - FT.SEARCH 执行 KNN 查询
  - 支持预过滤 (pre-filter) 和后过滤 (post-filter)
  - 支持混合查询: 向量相似度 + 标签过滤 + 全文搜索
```

创建向量索引

```bash
FT.CREATE idx:docs ON HASH PREFIX 1 "doc:" SCHEMA
  title TEXT
  category TAG
  embedding VECTOR HNSW 6
    TYPE FLOAT32
    DIM 1536
    DISTANCE_METRIC COSINE
```

### Redis 向量索引的 HNSW 和 FLAT 算法有什么区别?

FLAT (暴力搜索)

```
原理: 逐一计算查询向量与所有文档向量的距离, 返回 Top-K
时间复杂度: O(N * D), N=文档数, D=维度
准确率: 100% (精确搜索)
内存: 只存原始向量, 无额外索引结构
适用: 小数据集 (< 10 万), 对准确率要求极高
```

HNSW (Hierarchical Navigable Small World)

```
原理: 多层跳表结构的图索引
  - 底层 (Layer 0): 包含所有节点, 每个节点与 M 个邻居连接
  - 高层: 稀疏节点, 用于快速定位搜索起点
  - 搜索: 从最高层贪心搜索, 逐层下降到底层

参数:
  M: 每个节点的邻居数 (默认 16, 越大越准但越慢)
  EF_CONSTRUCTION: 建索引时搜索宽度 (默认 200)
  EF_RUNTIME: 查询时搜索宽度 (默认 10, 越大越准但越慢)

时间复杂度: O(log N * EF_RUNTIME)
准确率: 近似 (95-99%, 取决于参数)
内存: 原始向量 + 图结构; 图开销每向量约 150-250B (与维度无关), 高维向量下仅占原始向量 3-5%, 低维短向量下占比才接近 1.5-2 倍
适用: 大数据集 (> 10 万), 对延迟敏感
```

对比

| 维度       | FLAT       | HNSW                  |
| ---------- | ---------- | --------------------- |
| 准确率     | 100%       | 95-99%                |
| 查询延迟   | O(N), 慢   | O(log N), 快          |
| 内存       | 1x         | 1.5-2x                |
| 建索引速度 | 无需建索引 | 较慢                  |
| 增量更新   | 天然支持   | 支持 (但可能降低质量) |
| 适用规模   | < 10 万    | > 10 万               |

### Redis 向量搜索的查询语法和 KNN 检索是如何工作的?

基本 KNN 查询

```bash
# 查询最相似的 10 个文档
FT.SEARCH idx:docs "*=>[KNN 10 @embedding $BLOB]"
  PARAMS 2 BLOB "\x00\x01\x02..."
  SORTBY __vector_score
  DIALECT 2

# 带标签预过滤
FT.SEARCH idx:docs "(@category:{tech})=>[KNN 10 @embedding $BLOB]"
  PARAMS 2 BLOB "\x00\x01\x02..."
  DIALECT 2

# 带全文搜索的混合查询
FT.SEARCH idx:docs "(@title:redis)=>[KNN 5 @embedding $BLOB]"
  PARAMS 2 BLOB "\x00\x01\x02..."
  DIALECT 2
```

查询执行流程

```
1. 解析查询: 分离过滤条件和 KNN 子句
2. 预过滤 (Pre-filter):
   - 先执行标签/全文过滤, 得到候选集
   - 在候选集上执行 KNN
   - 优点: 减少 KNN 搜索范围
   - 缺点: 候选集太小时可能错过全局最优
3. KNN 搜索:
   - FLAT: 遍历候选集计算距离
   - HNSW: 从图索引中贪心搜索
4. 排序: 按向量距离排序
5. 后过滤 (Post-filter): 应用额外条件
6. 返回 Top-K 结果 + 分数
```

距离度量

```
COSINE: 余弦相似度 (归一化后的内积), 适合文本语义
L2: 欧氏距离, 适合图像特征
IP: 内积 (Inner Product), 适合已归一化的向量
```

### Redis 向量存储与其他专用向量数据库(Milvus/Pinecone)相比有何优劣?

对比分析

| 维度     | Redis Stack         | Milvus         | Pinecone      |
| -------- | ------------------- | -------------- | ------------- |
| 定位     | 通用缓存 + 向量扩展 | 专用向量数据库 | 托管向量服务  |
| 延迟     | 亚毫秒 (内存)       | 毫秒级         | 毫秒级        |
| 数据规模 | 百万级 (受内存限制) | 十亿级         | 十亿级        |
| 持久化   | RDB/AOF             | 分布式存储     | 托管          |
| 混合查询 | 向量 + 全文 + 标签  | 向量 + 标量    | 向量 + 元数据 |
| 运维     | 已有 Redis 则零成本 | 独立集群       | 全托管        |
| 成本     | 内存贵              | 磁盘 + 内存    | 按量付费      |
| 生态     | Redis 生态          | AI/ML 生态     | API 简单      |

Redis 向量存储的优势

```
1. 极低延迟: 纯内存操作, P99 < 1ms
2. 统一存储: 文档、缓存、向量在同一个 Redis 中
3. 混合查询: 向量 + 全文 + 标签 + JSON 一次查询完成
4. 运维简单: 已有 Redis 基础设施直接复用
5. 实时性: 写入即可搜索, 无索引构建延迟
```

Redis 向量存储的劣势

```
1. 内存成本高: 所有数据和索引都在内存中
   - 100 万条 1536 维 FLOAT32 向量 = 约 6GB 内存
   - 加上 HNSW 图结构 (每向量约 150-250B, 与维度无关) 仅约 0.2GB, 总计约 6.2-6.5GB
2. 数据规模受限: 单机内存上限
3. 分布式能力弱: Redis Cluster 对 FT.SEARCH 支持有限
4. 无 GPU 加速: 纯 CPU 计算
```

选型建议

```
选 Redis Stack:
  - 数据量 < 500 万
  - 对延迟要求极高 (< 1ms)
  - 已有 Redis 基础设施
  - 需要混合查询 (向量 + 缓存 + 全文)
  - RAG 应用的在线检索层

选 Milvus:
  - 数据量 > 1000 万
  - 需要分布式水平扩展
  - 有复杂索引需求 (IVF, PQ, GPU)
  - 离线批量检索

选 Pinecone:
  - 不想运维
  - 快速原型验证
  - 按需付费
```

### 如何在生产环境中设计基于 Redis 的 RAG 检索增强生成系统?

RAG 系统架构

```
用户提问
    |
    v
+-------------------+
| Embedding Service |  (OpenAI / 本地模型)
| 问题 -> 向量       |
+-------------------+
    |
    v
+-------------------+     +-------------------+
| Redis Vector      |---->| Document Store    |
| Search (KNN)      |     | (Redis Hash/JSON) |
| Top-K 相似文档     |     | 原始文本内容       |
+-------------------+     +-------------------+
    |
    v
+-------------------+
| Prompt Builder    |
| 系统提示 + 上下文  |
| + 用户问题        |
+-------------------+
    |
    v
+-------------------+
| LLM (GPT/本地)    |
| 生成回答          |
+-------------------+
    |
    v
用户回答 + 引用来源
```

数据入库流程

```go
// 1. 文档分块
chunks := splitDocument(doc, 512, 64)  // 512 token 块, 64 重叠

// 2. 生成 Embedding
for i, chunk := range chunks {
    embedding := embeddingClient.Embed(ctx, chunk.Text)

    // 3. 存入 Redis
    key := fmt.Sprintf("doc:%s:chunk:%d", doc.ID, i)
    redis.HSet(ctx, key, map[string]interface{}{
        "text":      chunk.Text,
        "doc_id":    doc.ID,
        "chunk_idx": i,
        "embedding": vectorToBytes(embedding),  // FLOAT32 BLOB
        "metadata":  json.Marshal(chunk.Meta),
    })
}

// 4. 创建索引 (一次性)
// FT.CREATE idx:chunks ON HASH PREFIX 1 "doc:" SCHEMA
//   text TEXT
//   doc_id TAG
//   embedding VECTOR HNSW 6 TYPE FLOAT32 DIM 1536 DISTANCE_METRIC COSINE
```

检索流程

```go
func retrieve(ctx context.Context, question string, topK int) ([]Chunk, error) {
    // 1. 问题向量化
    qVec := embeddingClient.Embed(ctx, question)

    // 2. Redis KNN 搜索
    results, err := redisClient.FTSearch(ctx, "idx:chunks",
        fmt.Sprintf("*=>[KNN %d @embedding $BLOB]", topK),
        &redis.FTSearchOptions{
            Params: map[string]interface{}{"BLOB": vectorToBytes(qVec)},
            SortBy: "__vector_score",
            Dialect: 2,
        })
    if err != nil {
        return nil, err
    }

    // 3. 解析结果
    chunks := make([]Chunk, 0, topK)
    for _, doc := range results.Docs {
        chunks = append(chunks, Chunk{
            Text:  doc.Fields["text"],
            DocID: doc.Fields["doc_id"],
            Score: doc.Fields["__vector_score"],
        })
    }
    return chunks, nil
}
```

生产优化要点

```
1. Embedding 缓存: 相同问题不重复调用 Embedding API
2. 分块策略: 512 token 块 + 64 重叠, 平衡上下文和精度
3. 混合检索: 向量搜索 + BM25 全文搜索, RRF 融合排序
4. 重排序 (Reranker): Top-K 结果用 Cross-Encoder 重排
5. 元数据过滤: 按文档类型、时间、权限预过滤
6. 连接池: Redis 连接池避免频繁建连
7. 降级策略: Embedding 服务不可用时降级到全文搜索
```

### Redis 向量索引的内存优化和性能调优策略有哪些?

内存优化

```
1. 量化 (Quantization):
   - FLOAT32 (4 bytes/dim) -> FLOAT16 (2 bytes/dim) -> INT8 (1 byte/dim)
   - 1536 维: 6KB -> 3KB -> 1.5KB per vector
   - RediSearch 2.6+ 支持 FP16/BF16 向量类型 (文中 FLOAT16 即 FP16)

2. 降维:
   - PCA / 自编码器将 1536 维降到 256-512 维
   - 内存减少 3-6 倍, 精度损失 < 2%

3. HNSW 参数调优:
   - M: 16 -> 8 (邻居数减半, 内存减少, 精度略降)
   - EF_CONSTRUCTION: 200 -> 100 (建索引更快, 图质量略降)

4. 数据分层:
   - 热数据 (最近 30 天): Redis 向量索引
   - 冷数据 (历史): 对象存储 + 离线检索

5. 内存估算:
   100 万条 1536 维 FLOAT32:
   - 原始向量: 1M * 1536 * 4 = 6 GB
   - HNSW 图 (M=16, 每向量约 150-250B 且与维度无关): 约 0.2 GB
   - 总计: 约 6.2-6.5 GB
```

性能调优

```
1. EF_RUNTIME 调优:
   - 默认 10, 增大到 50-200 提高准确率
   - 权衡: 延迟 vs 准确率
   - 推荐: 先设 100, 根据 recall 调整

2. 批量查询:
   - Pipeline 批量发送 FT.SEARCH
   - 减少网络 RTT

3. 预过滤优化:
   - 标签过滤缩小候选集, 减少 KNN 搜索范围
   - 但候选集太小 (< 1000) 时 FLAT 可能比 HNSW 快

4. 索引构建:
   - 批量写入后统一建索引 (比逐条插入快)
   - 使用 FT._CREATEIFNX 避免重复创建

5. 监控指标:
   - ft_search_duration: 查询延迟
   - ft_index_size: 索引内存
   - ft_index_num_docs: 索引文档数
```

---

## 九、综合与生产实践

### 如何设计一个完整的微服务可观测性体系?

三大支柱统一架构

```
+------------------+     +-------------------+     +------------------+
| Application      |     | OTel Collector    |     | Backends         |
| - OTel SDK      |---->| - Agent (DS)     |---->| - Prometheus     |
| - Prometheus    |     | - Gateway (DP)   |     | - Grafana Tempo  |
|   client        |     |                  |     | - Grafana Loki   |
| - slog/zap      |     |                  |     | - Grafana        |
+------------------+     +-------------------+     +------------------+

Metrics: Prometheus + Grafana (指标 + 大盘 + 告警)
Traces:  OTel SDK + Tempo/Jaeger (链路追踪)
Logs:    slog + Loki (日志聚合)
关联:    Exemplar + trace_id 注入 + 统一 Resource 标签
```

落地步骤

```
Phase 1: 基础设施 (1-2 周)
  - 部署 Prometheus + Grafana + Alertmanager
  - 部署 OTel Collector (Agent + Gateway)
  - 部署 Loki + Tempo

Phase 2: 应用接入 (2-4 周)
  - 统一 OTel SDK 初始化 (TracerProvider + MeterProvider)
  - HTTP/gRPC 自动埋点
  - 日志注入 trace_id
  - 自定义业务指标

Phase 3: 大盘与告警 (1-2 周)
  - L0/L1/L2 分层 Dashboard
  - 告警规则 (Golden Signals)
  - On-call 流程

Phase 4: 持续优化
  - 采样策略调优
  - 高基数治理
  - 故障复盘驱动指标补充
```

### 分布式系统中如何选型消息队列? Kafka vs etcd Watch vs Redis Pub/Sub?

对比分析

| 维度       | Kafka                      | etcd Watch                     | Redis Pub/Sub      |
| ---------- | -------------------------- | ------------------------------ | ------------------ |
| 定位       | 分布式消息队列             | 配置/服务发现变更通知          | 轻量级发布订阅     |
| 消息持久化 | 磁盘持久化, 可回溯         | 基于 MVCC, 可回溯 (未 compact) | 不持久化, 即发即弃 |
| 消费模式   | Consumer Group, 偏移量管理 | 每个 Watcher 独立              | 广播, 无消费确认   |
| 吞吐       | 百万级/s                   | 万级/s                         | 十万级/s           |
| 消息大小   | MB 级                      | 1.5MB 限制                     | 无硬性限制         |
| 顺序保证   | Partition 内有序           | 同一 key 按 revision 有序      | 无保证             |
| 适用场景   | 事件流、日志、异步任务     | 配置变更、服务发现             | 实时通知、聊天     |

选型决策

```
选 Kafka:
  - 需要消息持久化和回溯
  - 高吞吐 (万级/s 以上)
  - 需要 Consumer Group 和偏移量管理
  - 事件驱动架构、日志收集、流处理

选 etcd Watch:
  - 配置/元数据变更通知
  - 服务发现
  - 需要强一致性
  - 数据量小, 变更频率低

选 Redis Pub/Sub:
  - 实时性要求高, 允许丢失
  - 轻量级通知 (在线状态、聊天)
  - 已有 Redis 基础设施
  - 不需要持久化

注意: Redis 5.0+ 的 Redis Streams 是更完整的消息队列实现,
支持 Consumer Group、消息确认、持久化, 适合中等吞吐场景.
```

### 如何设计一个高可用的服务注册与发现体系?

基于 etcd 的方案

```
注册:
  1. 服务启动 -> Grant Lease (TTL=10s)
  2. Put /services/{name}/{instance} with Lease
  3. KeepAlive 后台续租 (TTL/3 间隔)
  4. 优雅退出 -> Revoke Lease

发现:
  1. 初始全量 Get (带 revision)
  2. Watch 增量变更 (从 revision+1 开始)
  3. 本地缓存实例列表
  4. 定期全量同步兜底 (防止 Watch 断连丢事件)

高可用:
  - etcd 集群 3/5 节点, 跨 AZ 部署
  - 客户端多 endpoint, 自动故障转移
  - 本地缓存兜底: etcd 不可用时使用最后一次已知列表
  - 健康检查: 主动 (KeepAlive) + 被动 (gRPC Health Check)
```

客户端容错

```go
// 本地缓存 + 定期同步
type ServiceDiscovery struct {
    mu       sync.RWMutex
    instances map[string][]string  // service -> addrs
    etcd     *clientv3.Client
}

func (sd *ServiceDiscovery) GetInstances(service string) []string {
    sd.mu.RLock()
    defer sd.mu.RUnlock()
    return sd.instances[service]  // 即使 etcd 不可用也有数据
}

// 后台: Watch + 定期全量同步 (每 5 分钟)
// 降级: etcd 全部不可用时, 使用本地缓存 + 告警
```

### 中间件的容量规划和故障演练方法论是什么?

容量规划方法论

```
1. 基线测量:
   - 压测确定单节点/单集群的吞吐上限
   - 记录 P50/P95/P99 延迟 vs QPS 曲线
   - 确定资源瓶颈 (CPU/内存/磁盘/网络)

2. 业务预估:
   - 当前流量 * 增长系数 (通常 2-3 倍)
   - 峰值流量 (大促/活动) * 安全系数 (1.5 倍)
   - 按 Partition/分片 拆分到单节点

3. 资源计算:
   - Kafka: 磁盘 = 日消息量 * 消息大小 * 副本数 * 保留天数
   - etcd: 内存 = key 数 * 平均大小 * 2 (索引开销)
   - Redis: 内存 = 数据量 * 1.5 (碎片 + 索引)
   - Prometheus: 磁盘 = series 数 * 采集频率 * 保留时间 * 1.5B

4. 冗余设计:
   - N+1 或 N+2 冗余
   - 单节点故障不影响整体 (Kafka ISR, etcd 多数派)
   - 跨 AZ 部署
```

故障演练 (Chaos Engineering)

```
演练层级:
  L1 - 单点故障:
    - Kill 单个 Broker/etcd 节点
    - 验证: 自动 failover, 数据不丢失, 延迟可接受

  L2 - 网络故障:
    - 网络分区 (iptables/tc)
    - 延迟注入 (100ms/500ms)
    - 验证: 脑裂处理, 超时重试, 降级策略

  L3 - 集群故障:
    - 同时 Kill 多数节点
    - 整个 AZ 不可用
    - 验证: 数据恢复, 服务降级

  L4 - 依赖故障:
    - DNS 解析失败
    - 下游服务超时
    - 验证: 熔断, 降级, 兜底策略

工具:
  - ChaosBlade / Chaos Mesh (K8s)
  - tc netem (网络延迟/丢包)
  - kill -9 / docker stop (进程故障)
  - 自定义脚本 (磁盘满、CPU 打满)

演练流程:
  1. 制定假设 (如: "Kill Kafka Leader 后, 消费延迟 < 5s")
  2. 小范围验证 (测试环境)
  3. 生产灰度 (低峰期, 单节点)
  4. 全量演练 (定期, 如季度)
  5. 复盘改进 (修复发现的问题)
```
