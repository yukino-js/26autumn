---
title: "yukino.go/apps 基础设施演示集: 9 个分布式基础设施 Go 应用的源码级解析"
description: "yukino.go/apps 下 consistent_hash、redis_lock、consistent_cache、lsm_tree、raft_demo、red_mq、tcc_demo、time_wheel、timer_demo 九个应用的源码级技术文档: 关键数据结构、核心算法流程、入口与运行方式、模块依赖关系, 以及 README 与代码差异对照"
---

> 本机器路径: `$HOME/github/yukino.go/apps`

本文基于 yukino.go 仓库 (HEAD `573f84d`, 2026-09-30) 的源码整理, 覆盖 `apps/` 目录下九个 Go 应用. 所有结论均给出代码出处 (相对 `apps/` 的路径 + 类型/函数名), 与 README 描述不一致之处以代码为准, 并在第十一节集中列出.

## 一、项目快照

仓库信息:

| 项                | 值                                                                   | 核实方式                               |
| ----------------- | -------------------------------------------------------------------- | -------------------------------------- |
| 仓库路径          | `$HOME/github/yukino.go`                                             | 本机目录                               |
| HEAD 提交         | `573f84d` (2026-09-30)                                               | `git -C $HOME/github/yukino.go log -1` |
| 工作区文件        | 根目录 `go.work`, 声明 `go 1.26.4`                                   | `go.work` 内容                         |
| apps 模块 Go 版本 | 各模块 `go.mod` 声明 `go 1.26` (tcc_demo、timer_demo 为 `go 1.26.0`) | 各 `go.mod`                            |
| 本机工具链        | go1.26.5 darwin/arm64                                                | `go version`                           |

`go.work` 的 use 列表中, 九个 apps 模块与 yukino_agent、yukino_cache、yukino_chat、yukino_chatbot、yukino_http、yukino_orm、yukino_rpc 并列. 九个应用的一句话定位:

| 应用               | 一句话定位                                                                                        | 形态       |
| ------------------ | ------------------------------------------------------------------------------------------------- | ---------- |
| `redis_lock`       | token + compare-and-act Lua 实现的 Redis 分布式锁, 含看门狗自动续期与多节点 RedLock               | 库         |
| `consistent_hash`  | 带数据迁移计算的加权一致性哈希环, 支持本地跳表与 Redis zset 两种存储后端                          | 库         |
| `consistent_cache` | 用短暂"读路径禁写标记"解决并发读写竞态的 Redis/MySQL 缓存一致性库 (cache-aside)                   | 库         |
| `lsm_tree`         | 零外部依赖的 LSM-Tree 存储引擎: WAL、跳表 memtable、块式 SSTable、布隆过滤器、分级 compaction     | 库         |
| `raft_demo`        | 从零实现的 Raft 共识核心 (选举/复制/成员变更/ReadIndex) + Ready/Advance 驱动模型 + HTTP KV 状态机 | 可执行服务 |
| `red_mq`           | 基于 Redis Streams 消费者组的消息队列, 带逐消息重试计数与可插拔死信信箱                           | 库         |
| `tcc_demo`         | Try-Confirm-Cancel 分布式事务管理器: 先记事务日志再调用参与方, 后台监控循环驱动崩溃恢复           | 库         |
| `time_wheel`       | 双时间轮: 进程内 O(1) 时间轮与 Redis 分布式时间轮 (秒级 HTTP 回调)                                | 库         |
| `timer_demo`       | 分布式秒级定时任务系统: cron 预展开 + Redis 分片时间片 + 分布式锁调度 + HTTP 回调执行             | 可执行服务 |

模块间依赖关系 (go.mod 与 import 核实):

| 应用              | 依赖的 yukino.go 模块 | 说明                                                                                                                                                                                                               |
| ----------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `consistent_hash` | `apps/redis_lock`     | go.mod require + `replace ../redis_lock`; `redis/hash_ring.go` 用其加环锁, `local/hash_ring.go` 引用其 `utils.GetProcessAndGoroutineIDStr`                                                                         |
| `tcc_demo`        | `apps/redis_lock`     | `example/` 包用 `redis_lock.NewRedisLock` 实现 TXStore 的 Lock/Unlock; go.mod 另有 `replace github.com/hangtiancheng/yukino.go/yukino_http => ../../yukino_http`, 但源码中无任何文件 import yukino_http (历史残留) |
| `timer_demo`      | `yukino_http`         | go.mod require + `replace ../../yukino_http`; `app/webserver/` 下 4 个文件 import                                                                                                                                  |
| 其余 6 个         | 无                    | lsm_tree 与 raft_demo 的 go.mod 甚至没有任何外部依赖                                                                                                                                                               |

注意: `timer_demo` 没有复用 `apps/redis_lock`, 而是在 `timer_demo/pkg/redis/lock.go` 自带了一份独立实现 (Lua 脚本与 redis_lock 逐字相同, 见第十节).

## 二、redis_lock -- Redis 分布式锁与 RedLock

### 演示内容

单节点 Redis 分布式锁的安全性构造: 唯一 token 标识持有者, 所有变更操作 (释放、续期) 都走"先比对 token 再执行"的 Lua 脚本; 未显式指定 TTL 时启动看门狗自动续期; 另提供跨多节点的 RedLock.

### 关键数据结构与算法

`redis_lock/lock.go` 的 `RedisLock` 是核心类型:

```go
type RedisLock struct {
    LockOptions
    key    string
    token  string
    client LockClient
    runningDog atomic.Int32   // 看门狗是否在运行
    watchDogMu sync.Mutex     // 保护 stopDog
    stopDog context.CancelFunc
}
```

- token 由 `redis_lock/utils/os.go` 的 `GetProcessAndGoroutineIDStr` 生成, 格式为 "进程ID_协程ID"; 协程 ID 通过 `runtime.Stack` 输出解析得到.
- 锁键统一加前缀 `RedisLockKeyPrefix` (值为 `REDIS_LOCK_PREFIX_`).
- `redis_lock/lua.go` 定义两段 Lua: `LuaCheckAndDeleteDistributionLock` (get 比对 token 后才 del) 与 `LuaCheckAndExpireDistributionLock` (比对后才 expire). 这是"永不释放别人的锁"的原子性保证.

加锁流程 (`Lock` -> `tryLock`):

1. `tryLock` 执行 `SetNEX` (SET key token NX EX ttl), 失败返回 `ErrLockAcquiredByOthers`;
2. 非阻塞模式直接返回错误; `WithBlock()` 时进入 `blockingLock`, 每 50ms 轮询一次, 上限 `WithBlockWaitingSeconds` (option.go `repairLock` 默认 5 秒);
3. `IsRetryableErr` 区分"锁被占用可重试"与真实错误.

看门狗机制 (`option.go` + `lock.go`):

- 不设置 `WithExpireSeconds` 时 `repairLock` 置 `watchDogMode`, 默认租约 `DefaultLockExpireSeconds = 30` 秒;
- `runWatchDog` 每 `WatchDogWorkStepSeconds = 10` 秒调用 `DelayExpire(ctx, WatchDogWorkStepSeconds+5)`, 即续期 15 秒 (多 5 秒容忍网络延迟);
- 续期时若 Lua 返回非 1, 判定 `errLockLost` (锁已不归自己), 看门狗退出而非无限重试.

`redis_lock/red_lock.go` 的 `RedLock`:

- `NewRedLock` 强制至少 3 个 `SingleNodeConf`; 并校验 "节点数 x singleNodesTimeout x 10 不超过 expireDuration", 否则报 "expire thresholds of single node is too long" (累计单节点超时预算必须远小于锁 TTL);
- `Lock` 逐节点尝试, 单节点"成功"要求 err 为 nil 且耗时不超过 `singleNodesTimeout` (默认 `DefaultSingleLockTimeout = 50ms`); 成功数达到 `len(locks)>>1 + 1` (多数派) 才算加锁成功;
- 未达多数派时用 `context.WithoutCancel` 派生新 ctx 释放已拿下的节点, 避免残留锁等待 TTL.

锁不可重入: 同一 goroutine 对同一 key 二次 `Lock` 会失败 (README Notes 明确说明, token 按 goroutine 隔离).

### 入口与运行方式

库, 无 main 包. 使用方式见 `redis_lock/lock_test.go` (集成测试需真实 Redis, 文件内有连接常量). `go test ./...` 运行.

### 与其他模块的关系

- `consistent_hash` 的 Redis 环锁 (`consistent_hash/redis/hash_ring.go`) 直接 `redis_lock.NewRedisLock`; 本地环 (`consistent_hash/local/hash_ring.go`) 引用 `redis_lock/utils` 的 token 生成函数;
- `tcc_demo/example` 用它实现 TXStore 全局锁;
- `redis_lock/redis.go` 的 `Client` 封装 `github.com/redis/go-redis/v9`, 暴露 `SetNEX`、`Eval` 等本库需要的命令子集.

## 三、consistent_hash -- 带数据迁移的一致性哈希

### 演示内容

一致性哈希环的完整工程形态: 节点加权映射为虚拟节点, 环的增删节点操作会自动计算出"哪些数据键需要从哪个节点迁移到哪个节点", 并通过用户提供的 `Migrator` 回调执行. 环本身可插拔: 进程内跳表版 (测试/单机) 或 Redis zset 版 (集群共享).

### 关键数据结构与算法

核心类型在 `consistent_hash/consistent_hash.go`:

```go
type ConsistentHash struct {
    hashRing  HashRing
    migrator  Migrator
    encryptor Encryptor
    opts      ConsistentHashOptions
}
```

`consistent_hash/hash_ring.go` 定义存储无关的 `HashRing` 接口: `Lock`/`Unlock`、环刻度操作 `Add`/`Ceiling`/`Floor`/`Rem`/`Node`/`Nodes`, 以及三套簿记: `AddNodeToReplica`/`DeleteNodeToReplica` (节点到虚拟节点数), `AddNodeToDataKeys`/`DeleteNodeToDataKeys`/`DataKeys` (节点到数据键的所有权索引).

`consistent_hash/encryptor.go` 定义 `Encryptor` 接口 (string 映射到 int32 环分数), 内置 `FnvHasher`: FNV-1a 32 位哈希后对 `math.MaxInt32` 取模. 非测试代码中目前只有这一个实现 (接口可插拔).

`consistent_hash/option.go` 默认值: `WithReplicas` 每权重单位 5 个虚拟节点; `WithLockExpireSeconds` 环锁租约 15 秒. 权重由 `getValidWeight` 钳制在 1 到 10, 虚拟节点总数 = 权重 x replicas.

AddNode 流程 (`consistent_hash.go` `AddNode`):

1. `hashRing.Lock` 拿全局环锁, defer 释放;
2. `Nodes` 查重, 重复节点返回 "repeat node";
3. `AddNodeToReplica` 登记节点;
4. 逐个虚拟节点: 键为 `nodeID_i` (`getRawNodeKey`), 分数 `encryptor.Encrypt`, `hashRing.Add` 上环, 再调 `migrateIn` 计算迁入键集;
5. `batchExecuteMigrator` 并发执行所有迁移任务, 每个任务独立 `recover`, 单任务 panic 不影响整批.

GetNode 流程: 加锁 -> `Encrypt(dataKey)` -> `Ceiling` 找顺时针第一个虚拟节点分数 -> `Node(score)` 取该分数的第一个节点 -> `AddNodeToDataKeys` 登记所有权 -> `getNodeID` 去掉 `_i` 后缀返回物理节点 ID. 登记的所有权索引正是后续迁移 diff 的数据源.

迁移算法 (`consistent_hash/migration.go`):

- `migrateIn`: 对新虚拟节点分数, 用 `Floor(decreaseScore(score))` 找前驱、`Ceiling(incrScore(score))` 找后继; 环回绕场景显式处理 -- `patternOne` (last-0-cur-next) 与 `patternTwo` (last-cur-0-next) 通过减去 `math.MaxInt32` 把分数归一到可比较的有符号空间; 读取后继节点 (`nextNodes[0]`) 的 `DataKeys`, 落在左开右闭区间 (lastScore, virtualScore] 内的键迁入新节点, 同时更新双方所有权索引;
- `migrateOut`: `RemoveNode` 的镜像. 取本节点全部数据键, 选出落在自己弧段 (lastScore, virtualScore] 内的键; 目标节点通过 `getValidNextNode` 递归查找后继 -- 跳过同节点的其他虚拟节点, 用 `ranged` 集合防止环上只剩同节点虚拟节点时无限递归; 若同分数有多个节点, 直接交给同分数列表的下一个节点;
- `incrScore`/`decreaseScore` 处理 `MaxInt32-1` 与 0 之间的环绕.

### 两种环后端

- `consistent_hash/local/hash_ring.go` `SkiplistHashRing`: 跳表实现, `virtualNode` 持有 `score`、`nodeIDs` (同分数多节点列表)、`nexts` 多层指针; 插入层数由 `roll()` 随机. 环状态由独立 `sync.RWMutex` 保护 (与锁租约解耦, 租约过期也不会产生数据竞态); 锁实体记录 owner token (复用 `redis_lock/utils.GetProcessAndGoroutineIDStr`) 并支持 TTL 自动过期;
- `consistent_hash/redis/hash_ring.go` `RedisHashRing`: 四个键 -- 锁键 `redis:consistent_hash:ring:lock:<key>` (内部就是 `redis_lock.NewRedisLock`), 环 zset `redis:consistent_hash:ring:<key>` (score 为虚拟节点分数, member 为该分数上节点 ID 列表的 JSON 数组), 副本数索引 `redis:consistent_hash:ring:node:replica:<key>`, 数据键索引 `redis:consistent_hash:ring:node:data:<nodeID>`.

`consistent_hash/pkg/os/os.go` 提供本地进程/协程标识工具.

### 入口与运行方式

库. 测试分两层: `consistent_hash/consistent_hash_test.go` 用本地跳表环, 无外部依赖; `consistent_hash/example_test.go` 需要可达的 Redis (文件内有连接常量). `go test ./...` 运行.

### 与其他模块的关系

- go.mod 显式依赖 `apps/redis_lock` (`replace ../redis_lock`), 是 apps 内部依赖关系的起点;
- 仓库另有 `yukino_cache/consistent_hash.go` 的 `ConsistentHashMap` (内存版、groupcache 风格、固定虚拟节点数、无迁移), 两者互不 import, 可视为同一主题的两种形态: apps 版本强调分布式存储后端与迁移计划.

## 四、consistent_cache -- 缓存与数据库一致性

### 演示内容

经典 cache-aside 在并发下的竞态 (写者删缓存后, 早先 miss 的慢读者把旧值回填) 的解决方案: 写路径设置一个短暂的"读路径禁写标记", 标记存在期间读路径的回填被抑制, 从而关闭旧值窗口. 正确性来自抑制而非加锁, 读路径永不阻塞.

### 关键数据结构与算法

`consistent_cache/interface.go` 定义四个契约接口与错误哨兵:

- `Cache`: `Enable` / `Disable` / `Get` / `Del` / `PutWhenEnable`;
- `DB`: `Put` / `Get` (以 `Object` 为单位);
- `Object`: `KeyColumn` / `Key` / `Write` / `Read` (序列化由业务对象自己负责);
- `Logger`: 四级日志;
- 错误: `ErrorDataNotExist` / `ErrorCacheMiss` / `ErrorDBMiss`; 防穿透哨兵常量 `NullData` (值 `Err_Syntax_Null_Data`).

`consistent_cache/option.go` 默认值: 缓存 TTL `DefaultCacheExpireSeconds = 60` 秒; 禁写标记 TTL `DefaultDisableExpireSeconds = 10` 秒; 重新启用延迟 `DefaultEnableDelayMillis = 1000` 毫秒. `WithCacheExpireRandomMode` 开启后, `CacheExpireSeconds()` 在 1 倍到 2 倍基础 TTL 之间加抖动 (`rand.Rand` 由互斥锁保护), 打散过期时间防止集中失效.

写路径 (`consistent_cache/service.go` `Service.Put`):

1. `cache.Disable(key, disableExpireSeconds)` 写禁写标记;
2. defer 一个异步 goroutine: 用新的 1 秒超时 context 调 `cache.Enable(key, enableDelayMillis)` (延迟重新启用, 让在途读先落库);
3. `cache.Del(key)` 删除旧缓存;
4. `db.Put(obj)` 落库.

读路径 (`Service.Get`, 返回 `useCache` 布尔值):

1. `cache.Get`; 命中且值为 `NullData` 返回 `ErrorDataNotExist` (负缓存命中); 命中则 `obj.Read(v)`;
2. miss 回源 `db.Get`; 库中不存在 (`ErrorDBMiss`) 时 `PutWhenEnable(NullData)` 写入哨兵防穿透;
3. 库命中则 `PutWhenEnable(obj.Write())` 回填 -- 只有禁写标记不存在时才真正写入.

Redis 适配层 (`consistent_cache/redis/cache.go` + `redis/lua.go`):

- 禁写标记键为 `Enable_Lock_Key_{key}` -- 花括号 hash tag 保证 cluster 模式下标记键与数据键同槽;
- `Disable` = SetEx 标记值 "1"; `Enable` = `PExpire` 把标记寿命缩到 enableDelayMillis, 标记过期即视为读路径启用;
- `PutWhenEnable` = Eval `LuaCheckEnableAndWriteCache`: get 标记键, 存在返回 0, 否则 `set key value ex ttl` 返回 1. 检查与写入在一段 Lua 内原子完成.

MySQL 适配层 (`consistent_cache/mysql/db.go`): 基于 GORM; `Put` 模拟 upsert -- 先 `Create`, 遇唯一键冲突 (`mysql/mysql.go` `IsDuplicateEntryErr`) 转为按 `KeyColumn` `Updates`; `Get` 按 key 列 `First`, `gorm.ErrRecordNotFound` 映射为 `ErrorDBMiss`.

### 入口与运行方式

库. `consistent_cache/example/example_test.go` 是对真实 Redis + MySQL 的集成测试, 三个用例: `Test_consistent_Cache` (单轮读写), `Test_Consistent_Cache_Correct` (100 并发写后校验正确性与缓存命中率), `Test_Consistent_Cache_Read_Write` (单键读写交错, 断言禁写机制使并发读全部回源). 运行前需填写文件顶部的连接常量.

### 与其他模块的关系

独立模块 (go-redis v9 + GORM). 与 `red_mq`、`redis_lock` 一样以"精简 Redis 客户端封装 + Lua 原子操作"为套路, 但互不 import. 与 `yukino_cache` (分布式缓存框架) 无代码关系.

## 五、lsm_tree -- LSM-Tree 存储引擎

### 演示内容

完整的日志结构合并树: 预写日志保证持久性、跳表 memtable 承接写入、块式 SSTable 落盘、布隆过滤器裁剪无效读、后台分级 compaction. `lsm_tree/go.mod` 无任何依赖, 纯标准库实现.

### 配置与目录结构

`lsm_tree/config.go` `Config` 及默认值 (`repair`):

| 配置                  | 默认值                        | 说明                                       |
| --------------------- | ----------------------------- | ------------------------------------------ |
| `MaxLevel`            | 7                             | 层数                                       |
| `SSTSize`             | 1 MiB                         | L0 单表大小预算, 每深一层乘 10             |
| `SSTNumPerLevel`      | 10                            | 每层 SSTable 数量阈值, 超过触发 compaction |
| `SSTDataBlockSize`    | 16 KiB                        | SSTable 内数据块大小                       |
| `SSTFooterSize`       | 32 字节固定                   | 4 个 uvarint 指向 filter/index 块          |
| `Filter`              | `filter.NewBloomFilter(1024)` | 可插拔                                     |
| `MemTableConstructor` | `memtable.NewSkiplist`        | 可插拔                                     |

`NewConfig` 会确保 sst 目录与 `walfile/` 子目录存在. 磁盘布局: sst 文件命名 `层级_序号.sst`, WAL 文件为 `walfile/<memtable索引>.wal` (`lsm_tree/tree_compact.go` `walFile()`), 一个 memtable 世代对应一个 WAL.

### 核心数据结构

`lsm_tree/tree.go` `Tree` 字段: 全局 `dataLock` (RWMutex) + 每层 `levelLocks`; 活跃 `memTable` 与只读待刷列表 `rOnlyMemTable`; `walWriter`; 拓扑 `nodes [][]*Node` (层到 sst 节点); 两个信号通道 `memCompactC` (memtable flush) 与 `levelCompactC` (层间合并); `memTableIndex` (与 WAL 文件名一一对应); `levelToSeq` 每层 sst 序号原子计数; `compactDone` 通道与 `destroyWG` 保证 `Close` 时收尾完整.

`NewTree` 启动顺序 (`tree.go`): `constructTree` (`tree_restore.go` 扫描目录, 按 (层, 序号) 排序加载 sst) -> 启动 `compact` goroutine -> `constructMemtable` (重放 WAL 恢复 memtable).

SSTable 三件套:

- `lsm_tree/sst_writer.go` `SSTWriter`: data/filter/index 三个块缓冲, `Index` 结构存分隔键 (`Key`, 保证不小于前一数据块最大键、小于下一块最小键) 与前块偏移/大小; `Finish` 返回 (size, blockToFilter, index) 供树缓存;
- `lsm_tree/sst_reader.go` `SSTReader`: 从 footer 定位 filter/index 块偏移, `mu` 串行化文件读 (并发读场景下共享文件偏移是临界资源);
- `lsm_tree/node.go` `Node`: 单个 sst 的运行时句柄, `Get` 三步 -- 索引块二分定位数据块 (`binarySearchIndex`) -> 该块的布隆过滤器判定 (`conf.Filter.Exist`) -> 读块逐条比对.

辅助组件:

- `lsm_tree/memtable/memtable.go` `MemTable` 接口: `Put` / `Get` / `All` (有序遍历供建 sst) / `Size` / `EntriesCnt`; `memtable/skiplist.go` 为跳表实现;
- `lsm_tree/filter/filter.go` `Filter` 接口 (`Add`/`Exist`/`Hash`/`Reset`/`KeyLen`); `lsm_tree/filter/bloom_filter.go` `BloomFilter`: FNV-1a 基哈希 h1, h2 为 h1 循环移位, 第 i 个哈希函数 gi = h1 + i*h2, 哈希函数个数 k 存在 bitmap 最后一字节;
- `lsm_tree/wal/writer.go` `WALWriter` / `lsm_tree/wal/reader.go` `WALReader`: 记录格式为 uvarint keyLen | uvarint valLen | key | value, 追加写 (`O_APPEND`, 重开不覆盖); `RestoreToMemtable` 全量重放; 注意代码中没有 CRC/校验和字段;
- `lsm_tree/util/string.go`: `SharedPrefixLen` 与 `GetSeparatorBetween` (求满足 a 不大于 x 且 x 小于 b 的分隔键, 用于索引块).

### 读写与 compaction 流程

写 (`Tree.Put`): `dataLock.Lock` -> `walWriter.Write` (先 WAL 后 memtable) -> `memTable.Put` -> 若 `memTable.Size()*5/4` 超过 `SSTSize` (多算四分之一覆盖 sst 元数据开销) 则 `refreshMemTableLocked`: 活跃 memtable 转只读、关闭其 WAL、投入 `memCompactC`、memTableIndex 自增并新建 memtable 与 WAL.

读 (`Tree.Get`): 活跃 memtable -> 只读 memtable 逆序 (新者优先) -> L0 节点逆序 -> L1 至 Ln 每层 `levelBinarySearch` (层内有序不重叠, 每层至多命中一个 sst).

后台合并 (`lsm_tree/tree_compact.go` `compact`): select 三个通道; `compactMemTable` 把只读 memtable 刷成 L0 sst; `compactLevel` 对超限层做归并 -- `pickCompactNodes` 取当前层前半段的键范围并收集与 level+1 重叠的节点, 归并写出新的 level+1 sst (单文件上限 `SSTSize * 10^(level+1)`), `removeNodes` 清理旧节点后 `tryTriggerCompact(level+1)` 级联向下.

### 入口与运行方式

库, 无 main. `go test ./...` 覆盖块编码、跳表、布隆过滤器误判率上界、WAL 写/恢复、端到端读写与 compaction. README 自述: 教学参考实现, 无 MVCC 快照、无 range tombstone、无 fsync 策略调优.

## 六、raft_demo -- Raft 共识与 HTTP KV 状态机

### 演示内容

从零实现的 Raft 状态机 (追随者/预候选/候选/领导者四态、随机化选举超时、PreVote、日志复制、成员变更、ReadIndex 线性一致读), 按 etcd/raft 的 `Ready`/`Advance` 驱动模型封装, 上层接一个 HTTP KV 应用. 定位是教学演示: 传输层被置空 (消息会生成但不会真正发送), 存储为内存版.

### 分层结构

```text
HTTP API (http_api.go, :8091)
   | proposeC / confChangeC
raftProxy (proxy.go) --Tick/Ready/Advance--> raft.Node (raft/node.go)
   | commitC                                    |
kvStore (kv_store.go)                    raft.Storage: MemoryStorage
```

`raft_demo/main.go` 装配: `proposeC` (string 通道) 与 `confChangeC` (`raft.ConfChange` 通道), `newRaftProxy(1, []string{"node1"}, ...)` 返回 `commitC`, `newKVStore` 消费 commitC, `newService` + `serveHttpApi(8091, s)`.

`raft_demo/proxy.go` `raftProxy.run`: 构造 `raft.Config` (ID 1, ElectionTick 10, HeartbeatTick 1, `NewMemoryStorage()`), `raft.StartNode`; `listen` 循环: 100ms ticker 调 `node.Tick()`, 从 `node.Ready()` 收到就绪状态后直接 `node.Advance()` -- 持久化硬状态、持久化日志、发送消息等步骤均为注释占位 (传输层未实现); `listenRequest` 把 proposeC 转 `node.Propose`, confChangeC 转 `node.ProposeConfChange`.

`raft_demo/kv_store.go` `kvStore`: `core` 为字符串键值 map, 配 `RWMutex`; `readCommit` 从 commitC 读 JSON `kv` (Key/Val) 应用到 map, 跳过 nil 与解析失败的载荷; `Propose` 把 key/val 序列化后投入 proposeC.

`raft_demo/http_api.go` `service.ServeHTTP`: `PUT /<键>` (body 为值) 走 `kvStore.Propose`; `POST /<节点ID>` 构造 `raft.ConfChange` (类型 `ConfChangeAddNode`, Context 为请求体), 对缺少斜杠的路径做了防御性校验.

### raft 核心包

`raft_demo/raft/model.go`: `Entry`/`EntryType` (`EntryNormal`、`EntryConfChange`); `Message`/`MessageType` (MsgHup、MsgProp、MsgApp、MsgVote、MsgHeartbeat、MsgReadIndex, 以及 PreVote 的 MsgPreVote/MsgPreVoteResp); `SoftState` (Lead + RaftState)、`HardState` (Term/Vote/CommitIndex)、`ConfState`、`Config` (含 PreVote 开关).

`raft_demo/raft/raft.go` `raft` 结构体: 角色行为用函数指针表达 -- `tick` 与 `step stepFunc`; 每 peer 复制进度 `prs` (uint64 到 `*Progress` 的 map)、投票记录 `votes`、出站队列 `msgs`、线性读追踪器 `readOnly`、随机化选举超时 `randomizedElectionTimeout`. `Step` 先按 term 分派: 更高 term 的消息 (除 PreVote 相关) 使本节点退位为 follower; `campaign`/`poll`/`quorum` 处理选举计票; `appendEntry`/`maybeCommit` 处理领导者日志推进; `applyConfChange`/`addNode`/`removeNode` 处理成员变更.

角色文件: `raft_demo/raft/follower.go` (`becomeFollower`、`handleAppendEntries`、`handleHeartbeat`)、`candidate.go` (`becomePreCandidate`、`becomeCandidate`)、`leader.go` (`becomeLeader`、`sendAppend`、`broadcastHeartbeat`). 领导者处理 `MsgReadIndex` (leader.go stepLeader): 记录当前 commitIndex, `readOnly.addRequest(ctx, readIndex, m)` 后 `broadcastHeartbeatWithCtx(ctx)`, 收到多数派心跳应答后回 `MsgReadIndexResp`.

`raft_demo/raft/progress.go` `Progress` (Match/Next + Probe/Replicate 两态): `maybeUpdate` 推进, `mayDecreaseTo` 依据 `RejectHint` 回退 Next.

`raft_demo/raft/read.go`: `ReadState` (Index + RequestCtx); `readOnly` 维护 pendingReadIndex 映射与 readIndexQueue 队列, `advance` 按入队顺序批量完成读请求.

`raft_demo/raft/log.go` raftLog (commitIndex、`appliedTo`、`stableTo`、`nextEntries`、`unstableEntries`); `storage.go` `Storage` 接口 (InitialState、Entries 左闭右开区间、Term、LastIndex、FirstIndex、Append、SetHardState) 与 `MemoryStorage` (错误哨兵 `ErrCompacted`/`ErrUnavailable`).

`raft_demo/raft/ready.go` `Ready` 聚合一次交付: SoftState、HardState、ReadStates、待持久化 Entries、待应用 CommittedEntries、待发送 Message; `containsUpdates` 决定是否通知上层.

`raft_demo/raft/node.go` `Node`: 七个通道 (proc/recvChan/confChan/confStateChan/readyChan/advanceChan/tickChan) 把外部驱动串行化进单 goroutine `run`; `Advance` 分支里完成真正的持久化语义: `storage.SetHardState(prevHard)`、`appliedTo(CommitIndex)`、`storage.Append(Entries)`、`stableTo`. 对外方法: `Tick`、`Campaign`、`Propose`、`ProposeConfChange`、`ReadIndex`、`ApplyConfChange`、`Ready`、`Advance`.

### 入口与运行方式

可执行 main 包:

```bash
go run .   # HTTP API 监听 :8091
curl -X PUT http://localhost:8091/name -d 'yukino'        # 提议一次写
curl -X POST http://localhost:8091/2 -d 'node-2-context'  # 提议增加节点 2
```

单元测试: `go test ./raft/...` (raft 核心无外部依赖).

### 与其他模块的关系

独立模块, go.mod 无任何依赖. 是 apps 中唯一的共识算法实现; 若需要生产级强一致协调, redis_lock 的 README 建议改用 etcd/ZooKeeper 一类共识系统.

## 七、red_mq -- Redis Streams 消息队列

### 演示内容

在 Redis Streams 原生能力 (追加写、消费者组、PEL、XACK) 之上补齐"策略层": 逐消息失败计数、超限转死信、优雅停机、全链路超时控制.

### 关键数据结构与算法

生产端 `red_mq/producer.go` `Producer`: `SendMsg(ctx, topic, key, val)` 即 `client.XADD(topic, msgQueueLen, key, val)`; `WithMsgQueueLen` 默认 500. 注意代码事实: `red_mq/redis/redis.go` 的 `XADD` 只设置 `go_redis.XAddArgs.MaxLen`, 未设置 `Approx`, 因此是精确 MAXLEN 截断 (README 描述为近似 MAXLEN, 与代码不符, 见第十一节).

消费端 `red_mq/consumer.go` `Consumer`:

```go
type Consumer struct {
    ctx  context.Context
    stop context.CancelFunc
    callbackFunc MsgCallback
    client *redis.Client
    topic, groupID, consumerID string
    failureCnts map[redis.MsgEntity]int  // 逐消息失败计数
    opts *ConsumerOptions
}
```

`NewConsumer` 先 `checkParam` (callback、client、topic/groupID/consumerID 均不可空), 应用选项后 `go run()`. 主循环 `run`:

1. `receive`: `XReadGroup` 以 `>` 读新消息, 阻塞时长为 receiveTimeout 毫秒; 出错 `backoff` 1 秒防止热错误循环;
2. `handlerMsgs` (handleMsgsTimeout 的 ctx): 回调失败 -> `failureCnts` 对应消息计数加一; 成功 -> `XACK` 并清除计数;
3. `deliverDeadLetter` (deadLetterDeliverTimeout 的 ctx): 失败次数达到 `maxRetryLimit` 的消息交给 `DeadLetterMailbox.Deliver`, 投递成功后才 `XACK` 并从计数表移除 -- 投递失败则保留消息不 ack, 保证毒消息不会静默丢失;
4. `receivePending`: `XReadGroupPending` 以 `0-0` 读本消费者已分配未确认的消息 (PEL), 再走一遍 `handlerMsgs` -- 每轮都清空 PEL, 崩溃消费者遗留的消息按消费者组语义被重新处理.

死信接口 `red_mq/dead_letter.go`: `DeadLetterMailbox` 只有一个 `Deliver(ctx, msg)` 方法; 默认实现 `DeadLetterLogger` 仅打日志.

`red_mq/option.go` 消费者默认值: receiveTimeout 2 秒 (小于等于 0 会被修正, 因为 0 在 XREADGROUP 语义里是永久阻塞)、maxRetryLimit 3、deadLetterDeliverTimeout 1 秒、handleMsgsTimeout 1 秒.

`red_mq/redis/redis.go`: 精简客户端, 流命令 `XADD`/`XACK`/`XReadGroup`/`XReadGroupPending`/`XGroupCreate` 加通用 `Get`/`Set`/`SetNX`/`SetNEX`/`Del`/`Incr`/`Eval`; `MsgEntity` 携带 MsgID/Key/Val; `ErrNoMsg` 表示空轮询.

### 入口与运行方式

库. 测试两套: `red_mq/fakeredis_test.go` 内置一个最小 RESP2 假 Redis 服务器 (仅覆盖 red_mq 用到的流命令), 使生产者/消费者路径可以在无真实 Redis 的环境下跑 `go test -race`; `red_mq/example/` 为真实 Redis 集成测试 (`Test_Consumer` 等, 需填连接常量).

### 与其他模块的关系

独立模块 (go-redis v9). 与 `time_wheel` 的 Redis 客户端封装思路一致 (各自维护精简命令子集), 互不 import.

## 八、tcc_demo -- TCC 分布式事务

### 演示内容

Try-Confirm-Cancel 事务管理器: 事务在任何网络调用发生之前先落日志 (`TXStore.CreateTX`), 每个参与方 Try 结果即时持久化; 协调者崩溃后可由后台监控循环重放 hanging 事务推进到终态. Confirm/Cancel 要求幂等.

### 关键数据结构与算法

契约 (`tcc_demo/component.go`、`tcc_demo/txstore.go`):

- `TCCComponent` 接口: `ID()`、`Try(ctx, *TCCReq)`、`Confirm(ctx, txID)`、`Cancel(ctx, txID)`; 请求 `TCCReq` 携带 ComponentID/TXID/Data, 响应 `TCCResp` 以 `ACK` 布尔位确认;
- `TXStore` 接口: `CreateTX` / `TXUpdate` / `TXSubmit` / `GetHangingTXs` / `GetTX` / `Lock` / `Unlock` -- 后两个方法要求分布式锁实现, 防止多协调者实例并发推进同一事务.

状态模型 (`tcc_demo/model.go`): `Transaction` 持有 TXID、组件 Try 状态列表 `Components`、Status、CreatedAt; `getStatus(createdBefore)` 从事务记录推导状态: 任一组件 TryFailure 则 failure; 存在 hanging 组件且 CreatedAt 早于 (now - Timeout) 则 failure (超时推断失败, 防止资源预留永久泄漏); 仍有 hanging 则 hanging; 全部成功则 successful.

管理器 (`tcc_demo/txmanager.go` `TXManager`): 组合 txStore、`registryCenter` (`tcc_demo/tccregister.go`, map 加 RWMutex, 拒绝重复组件 ID)、后台 ctx; `NewTXManager` 即启动 `run()` 监控 goroutine.

事务主流程 `Transaction`:

1. 以 `opts.Timeout` (默认 5 秒) 派生超时 ctx;
2. `getComponents` 校验请求: 拒绝重复 ComponentID, 从注册中心解析组件;
3. `txStore.CreateTX` 生成 txID 并持久化 (所有组件初始状态 hanging);
4. `twoPhaseCommit`: `sync.WaitGroup.Go` 并发执行各组件 Try -- 失败或 ACK 为 false 则 `TXUpdate(false)` 并投递 errCh; 成功则 `TXUpdate(true)`; 主协程收到第一个错误即 cancel ctx 通知其余 Try; 随后排空 errCh 等待全部 Try 协程结束 (保证日志状态完整), 再 `advanceProgressByTXID` 推进二阶段; 返回 committed 布尔值.

推进函数 `advanceProgress`: 推导状态; hanging 直接跳过; successful 对每个组件调 `Confirm`, failure 调 `Cancel`, 全部 ACK 后 `TXSubmit(txID, true/false)` 落终态. 二阶段失败只记日志不返回给调用方 -- 交给监控循环兜底重试.

监控循环 `run`: 间隔 `opts.MonitorTick` (默认 10 秒); 出错时 `backOffTick` 翻倍退避, 上限 `MonitorTick << 3` (8 倍); 每轮先 `txStore.Lock(ctx, MonitorTick)` (拿不到锁直接跳过且不视为错误 -- 多半是别的实例在干活), 再 `GetHangingTXs` -> `batchAdvanceProgress` (每事务一个 goroutine, 收集第一个错误).

`example/` 参考实现: `example/txstore.go` `MockTXStore` 用 MySQL 表 (`example/dao/txrecord.go` `TXRecordPO`, 组件状态以 JSON 存列) 承载事务日志, `Lock`/`Unlock` 用 `redis_lock.NewRedisLock` 实现; `example/tcc_component.go` `MockComponent` 用 Redis 记录预留状态 (`DataFrozen`/`DataSuccessful`, 事务侧 `TXTried`/`TXConfirmed`/`TXCanceled`), Try 按 txID 加分布式锁. `example/example_test.go` `TestTCCExample` 串联全流程.

### 入口与运行方式

库. 测试栈: `go-sqlmock` 加 `go.uber.org/mock` 生成的假 DAO/Redis/TXStore, 无需真实中间件即可 `go test ./...`.

### 与其他模块的关系

example 包依赖 `apps/redis_lock` (go.mod `replace ../redis_lock`). go.mod 中还有 yukino_http 的 replace 指令, 但源码中没有任何文件 import yukino_http, 属于历史残留.

## 九、time_wheel -- 内存时间轮与 Redis 分布式时间轮

### 演示内容

两种延迟调度原语: 进程内时间轮 `TimeWheel` (O(1) 插入/删除, 单 goroutine 驱动) 与 Redis 分布式时间轮 `RTimeWheel` (分钟分片 zset + Lua 原子弹出, 秒级精度触发 HTTP 回调, 可多实例部署).

### 进程内时间轮

`time_wheel/time_wheel.go` `TimeWheel`:

```go
type TimeWheel struct {
    sync.Once
    interval     time.Duration
    ticker       *time.Ticker
    stopChan     chan struct{}
    addTaskCh    chan *taskElement
    removeTaskCh chan string
    slots        []*list.List
    curSlot      int
    keyToETask   map[string]*list.Element
}
```

设计要点:

- 单 goroutine `run` 通过 select 串行处理 tick/add/remove 三类事件, slots 与索引 map 无需加锁, 状态全由这一个 goroutine 独占;
- `NewTimeWheel(slotNum, interval)` 默认 10 槽、1 秒间隔;
- `getPosAndCircle`: delay 取 `time.Until(executeAt)` 并钳制不小于 0 (过期任务不产生负槽位); cycle 为 delay 除以 (槽数 x 间隔) 的整商; pos 为 (curSlot + delay/间隔) 对槽数取模; 超过一圈的任务携带 cycle 计数, 游标每经过一圈减一, 归零才执行;
- `execute` 中每个任务以独立 goroutine 执行并 `recover`, 单任务 panic 不影响轮体;
- `Stop` 由 `sync.Once` 保证幂等: 停 ticker、关 stopChan; AddTask/RemoveTask 先 select stopChan, 停止后不阻塞.

### Redis 分布式时间轮

`time_wheel/redis_time_wheel.go` `RTimeWheel`: 任务体 `RTaskElement` (Key、CallbackURL、Method、Req、Header), `addTaskPreCheck` 只允许 GET/POST 与 http(s) 前缀的回调地址.

分钟分片键约定 (`pkg/util/time.go` 格式 `2006-01-02-15:04`):

- 任务 zset: `yukino_time_wheel_task_{分钟串}`, score 为执行时刻的 unix 秒;
- 删除标记 set: `yukino_time_wheel_delete_set_{分钟串}`.

三个原子 Lua 脚本 (`time_wheel/time_wheel_lua.go`):

| 脚本             | 语义                                                                                                                       |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `LuaAddTasks`    | 先 `srem` 删除标记集中的 key, 再 `zadd` 任务 -- 重新调度同 key 任务时自动撤销旧删除标记                                    |
| `LuaDeleteTask`  | `sadd` 删除标记; 当集合大小首次变为 1 时设置 120 秒过期 (限制标记内存, 覆盖时钟偏差)                                       |
| `LuaZrangeTasks` | 读删除标记集, `zrange byscore` 取窗口内任务, `zremrangebyscore` 弹出 -- 读取与弹出在同一脚本内原子完成, 多实例不会重复触发 |

运行循环: 1 秒 ticker, 每 tick 派生 goroutine `executeTasks` (30 秒超时 ctx): `getExecutableTasks` 以当前秒和下一秒为 score 窗口调 `LuaZrangeTasks`, 解析应答首元素 (删除标记集) 与任务列表, 跳过已删除任务; 每个任务并发 `executeTask`, 经 `httpClient.JSONDo` 回调 (`time_wheel/pkg/http/http.go`), 逐任务 recover.

使用约束: `RemoveTask` 必须传入与 `AddTask` 相同的 executeAt -- 删除标记写在该时刻所属的分钟分片里.

### 入口与运行方式

库. `time_wheel/time_wheel_test.go` 的本地用例 (`Test_timeWheel`、`Test_TimeWheel_RemoveTask`、`Test_TimeWheel_PastExecuteAt`、`Test_TimeWheel_ConcurrentAddRemove`、`Test_TimeWheel_StopThenAddDoesNotBlock`、`Test_TimeWheel_StopReleasesGoroutines`) 无外部依赖; `Test_redis_timeWheel` 需要真实 Redis 与回调端点.

### 与其他模块的关系

独立模块 (go-redis v9). 与 `timer_demo` 是同一主题 (Redis zset 按分数调度) 的两种独立实现: time_wheel 面向通用 HTTP 回调延迟任务, timer_demo 是完整的定时任务平台; 二者代码互不引用.

## 十、timer_demo -- 分布式秒级定时任务系统

### 演示内容

生产形态的分布式定时器平台: cron 定义预先展开为任务行 (热路径只读 zset), 按 (分钟, 桶) 分片加分布式锁实现多实例水平扩展, 执行器以 HTTP 回调通知业务方, 布隆过滤器加数据库状态双重去重, Prometheus 指标上报, REST API 管理定时器.

### 进程装配

`timer_demo/main.go`: 从 `app` 包取四个应用实例, 依次 Start migrator、scheduler、monitor (三者均 `defer Stop()`), web server 最后 Start; 另起 pprof 服务 (`:9999`), 等待 SIGINT.

`timer_demo/app/provider.go`: 全部依赖注入在 `init()` 中用 `go.uber.org/dig` 完成, 分五组 Provide -- conf 提供器、pkg (bloom、hash、redis、mysql、cron、xhttp、promethus)、dao (timer、task、taskCache)、service、app; `GetSchedulerApp` 等函数通过 `container.Invoke` 拉取根对象, 依赖图由 dig 解析.

### 六个角色

Migrator (`timer_demo/service/migrator/worker.go`): 每 `MigrateStepMinutes` (默认 60 分钟) tick 一次; 先拿小时级锁 `migrator_lock_<小时>` (`utils.GetMigratorLockKey`, 尝试锁 20 分钟、成功后续期 120 分钟); `migrate` 读取全部启用定时器, 对每个 cron 表达式用 `cronParser.NextsBetween` 展开窗口 [hour(now+step), hour(now+2*step)) 内的触发时刻, `BatchCreateRecords` 写任务行 (每个定时器间 `time.Sleep(5*time.Second)` 限速), 最后 `migrateToCache` 预热 Redis.

Scheduler (`timer_demo/service/scheduler/worker.go`): 每 `TryLockGapMilliSeconds` (默认 100ms) tick; 遍历 `BucketsNum` 个桶, 对当前分钟与上一分钟各提交一次 `asyncHandleSlice` 到 worker pool; 每个 (分钟, 桶) 切片先抢分布式锁 `time_bucket_lock_<分钟>_<桶>` (`utils.GetTimeBucketLockKey`, `TryLockSeconds` 默认 70 秒), 成功后 `trigger.Work(sliceKey, ack)`, ack 回调把锁续期到 `SuccessExpireSeconds` (默认 130 秒) -- 两段 TTL 区分"抢占窗口"与"持有租约", 防止慢任务被抢; `getValidBucket` 当前直接返回静态桶数, 动态扩桶逻辑整体被注释停用.

Trigger (`timer_demo/service/trigger/worker.go`): 拿到切片键后按 `ZRangeGapSeconds` (默认 1 秒) 步长扫完一分钟窗口, 每个秒级窗口调 `TaskService.GetTasksByTime`, 每个任务提交 worker pool 执行 `executor.Work(timerID_unix毫秒)` (`utils.UnionTimerIDUnix` 编码); 任务源 (`timer_demo/service/trigger/task.go`) 先查 Redis 缓存 (`dao/task/cache.go` `TaskCache.GetTasksByTime` 即 ZRANGEBYSCORE), 未命中回源数据库并按 "timerID 对 BucketsNum 取模等于 bucket" 过滤本桶任务. Redis 侧结构: zset 键 `<分钟串>_<timerID % BucketsNum>`, member 为 `timerID_unixMilli`, score 为 `RunTimer.UnixMilli()`, 过期时间为任务时刻加 24 小时.

Executor (`timer_demo/service/executor/worker.go`): `Work` 先 `SplitTimerIDUnix`; 布隆过滤器 `Exist` (按天键) 命中或出错时回查数据库任务状态防止重复执行; `executeAndPostProcess` 取定时器定义 (`timer_demo/service/executor/timer.go` `TimerService` 维护内存缓存 map, 每 `TimerDetailCacheMinutes` 分钟刷新), 定时器已禁用则跳过; `execute` 按 `NotifyHTTPParam.Method` 发起回调 -- 代码 switch 支持 GET、POST、PATCH、DELETE 四种 (未实现 PUT); `postProcess` 异步上报指标、`bloomFilter.Set` 写当天去重位 (TTL 24 小时)、回写任务状态 Succeed/Failed 与响应 Output.

Monitor (`timer_demo/service/monitor/worker.go`): 每分钟拿锁 `monitor_lock_<分钟>` (2 分钟租约), 上报上一分钟未执行任务数 (`timer_no_exceed_cnt` gauge) 与启用定时器总数 (`timer_enabled_cnt` gauge).

WebServer (`timer_demo/app/webserver/app.go` 加 `timer_demo/service/webserver/`): 基于 `yukino_http` 的 `Application` 与 `Router`; 全局 CORS 中间件 (`app/webserver/fitler.go`, 文件名为代码中的既有拼写); 路由注册于 `RegisterTimerRouter`/`RegisterTaskRouter`/`RegisterMockRouter`/`RegisterMonitorRouter`:

| 路由                       | 方法                        | 说明                               |
| -------------------------- | --------------------------- | ---------------------------------- |
| `/api/timer/v1/def`        | GET / POST / DELETE / PATCH | 定时器定义 CRUD                    |
| `/api/timer/v1/defs`       | GET                         | 按 app 列出定时器                  |
| `/api/timer/v1/defsByName` | GET                         | 按名称搜索                         |
| `/api/timer/v1/enable`     | POST                        | 启用定时器                         |
| `/api/timer/v1/unable`     | POST                        | 禁用定时器                         |
| `/api/task/v1/records`     | GET                         | 任务执行记录                       |
| `/api/mock/v1/mock`        | 全部                        | 回调测试回显                       |
| `/metrics`                 | 全部                        | 以 httptest recorder 桥接 promhttp |

`service/webserver/timer.go`: 创建/删除定时器先抢 app 级频控锁 (`utils.GetCreateLockKey`, `defaultEnableGapSeconds = 3` 秒); 创建时 `cronParser.IsValidCronExpr` 校验 cron 表达式.

### 关键机制

分布式锁 (`timer_demo/pkg/redis/lock.go` `ReentrantDistributeLock`): token 为 `utils.GetProcessAndGoroutineIDStr`; `Lock` 先 GET, 值等于自己的 token 则走 `ExpireLock` 续期实现可重入, 否则 SetNX; `Unlock`/`ExpireLock` 用 `pkg/redis/lua.go` 的 check-and-act Lua (与 `apps/redis_lock/lua.go` 内容逐字相同, 键前缀为 `FTIMER_LOCK_PREFIX_`). 这是该应用不复用 `apps/redis_lock` 的自建副本.

布隆过滤器去重 (`timer_demo/pkg/bloom/filter.go`): k = 2 (`pkg/hash/sha1.go` SHA1 与 `pkg/hash/fnv.go` FNV-1a 64 位, 位位置为哈希值 mod MaxInt32); 按天隔离, 键 `task_bloom_<2006-01-02>` (`utils.GetTaskBloomFilterKey`), TTL `BloomFilterKeyExpireSeconds` 24 小时; 源码注释给出参数推导: Redis bitmap 提供 2^32 位 (m), 按每天 100 万任务 (n), k=2 时误判率约 2e-7. 注意 `pkg/hash/fnv.go` 的构造函数名为 `NewMurmur3Encryptor` 但返回的是 `*FNVEncryptor` (FNV-1a), 属命名残留.

其他 pkg: `pkg/pool/pool.go` `WorkerPool` 接口加 `GoWorkerPool` (bytedance/gopkg 的 gopool, 池名 timer_demo); `pkg/cron/parser.go` `CronParser` (`IsValidCronExpr`/`NextFromNow`/`NextsBetween`/`NextAfter`); `pkg/promethus/reporter.go` (包名沿用代码拼写) 指标: `timer_exec_total_cnt` (counter)、`timer_delay_cnt` (summary, 执行延迟毫秒)、`timer_enabled_cnt`、`timer_no_exceed_cnt` (gauge), app 标签值 `timer_demoApp`; `pkg/xhttp` JSON 客户端.

配置 (`timer_demo/common/conf/init.go` 默认值):

| 段        | 配置                                                                                                            | 默认                      |
| --------- | --------------------------------------------------------------------------------------------------------------- | ------------------------- |
| migrator  | workersNum / migrateStepMinutes / migrateTryLockMinutes / migrateSuccessExpireMinutes / timerDetailCacheMinutes | 1000 / 60 / 20 / 120 / 2  |
| scheduler | workersNum / bucketsNum / tryLockSeconds / tryLockGapMilliSeconds / successExpireSeconds                        | 100 / 10 / 70 / 100 / 130 |
| trigger   | zrangeGapSeconds / workersNum                                                                                   | 1 / 10000                 |
| webserver | port                                                                                                            | 8092                      |

`timer_demo/conf.yml` 中仅 `mysql.dsn` 与 `redis.address` 标为必填 (另有一个 `redis.password` 占位符也需按环境填写), 其余段落有默认值. 状态常量见 `common/consts/timer.go`: 任务 NotRun/Running/Succeed/Failed, 定时器 Unable=1/Enable=2, 时间格式 `MinuteFormat` 为 "2006-01-02 15:04" 等.

### 入口与运行方式

可执行 main 包: 编辑 conf.yml 后 `./start.sh` (内容即 `nohup go run main.go &`) 或 `go run .`; 进程同时启动 migrator、scheduler、monitor 与 web server, pprof 在 `:9999`, `/metrics` 供 Prometheus 抓取. `go test ./...` 运行单元测试. README 自述: 动态桶逻辑存在但停用; 建表与索引由运维负责.

### 与其他模块的关系

apps 中唯一 import `yukino_http` 的应用 (go.mod `replace ../../yukino_http`, import 集中在 `app/webserver/` 的 app.go、timer.go、task.go、fitler.go 四个文件). 调度思想与 `time_wheel` 的 Redis 轮同源但独立实现; 分布式锁与 `apps/redis_lock` 同构但自带副本.

## 十一、README 与代码差异对照

以下条目为撰写本文时逐文件核对发现的 README 描述与代码实现不一致之处, 本文正文均以代码为准:

| 位置                   | README 描述                             | 代码事实                                                                                                                |
| ---------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| consistent_hash README | 内置 FNV 与 SHA-1 两种哈希实现          | `consistent_hash/encryptor.go` 非测试代码仅有 `FnvHasher`; SHA-1 实现存在于 `timer_demo/pkg/hash/sha1.go`, 与本模块无关 |
| lsm_tree README        | WAL 记录带 CRC 校验                     | `lsm_tree/wal/writer.go` 记录格式为 uvarint 长度前缀加原始字节, 全模块无 crc/checksum 代码                              |
| red_mq README          | XADD 使用近似 MAXLEN (带波浪号)         | `red_mq/redis/redis.go` 仅设置 `XAddArgs.MaxLen`, 未置 `Approx`, 为精确截断                                             |
| timer_demo README      | Executor 支持 GET/POST/PUT/PATCH/DELETE | `service/executor/worker.go` `execute` 的 switch 仅 GET/POST/PATCH/DELETE, 无 PUT                                       |
| timer_demo README      | 配置示例 bucketsNum 为 20               | `common/conf/init.go` 默认 `BucketsNum = 10` (20 仅为示例值)                                                            |
| timer_demo 代码        | --                                      | `pkg/hash/fnv.go` 构造函数名为 `NewMurmur3Encryptor`, 实际返回 `*FNVEncryptor` (FNV-1a 64)                              |

## 十二、阅读建议

按依赖与难度递进的推荐顺序:

1. `redis_lock` -- 最小完整闭环, 理解 token 加 Lua 的所有权语义 (consistent_hash 与 tcc_demo 的前置);
2. `consistent_hash` -- 环上迁移的区间推导与回绕处理是全套代码中最精巧的算法部分;
3. `consistent_cache` -- 短小, 展示并发一致性的一种非锁解法;
4. `red_mq` 与 `time_wheel` -- Redis 流/有序集合的工程化封装, 互为对照;
5. `lsm_tree` -- 独立存储引擎, 建议按 WAL、memtable、SSTable 读写、compaction 顺序读;
6. `tcc_demo` -- 理解"日志先行加监控推进"的崩溃恢复模式;
7. `raft_demo` -- raft/ 包按 model、raft、角色文件、node/ready/storage 顺序读;
8. `timer_demo` -- 集大成者, 建议从 main.go 与 app/provider.go 的 dig 依赖图入手, 再沿 Migrator、Scheduler、Trigger、Executor 数据流走读.
