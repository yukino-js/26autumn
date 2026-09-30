---
title: "ClickHouse & Kafka 技术笔记"
---

> 本文覆盖 ClickHouse 列式存储引擎、MergeTree 家族、分布式架构、查询优化, 以及 Kafka 存储模型、生产者/消费者语义、高可用机制、性能调优等核心知识点.

---

## 一、ClickHouse 存储引擎

### ClickHouse 为什么选择列式存储? 与行式存储 (MySQL) 的本质区别是什么?

行式存储 (MySQL InnoDB): 数据按行连续存放, 一行所有列物理相邻. 适合 OLTP — 单行读写只需一次 I/O 即可取到完整记录.

列式存储 (ClickHouse): 数据按列连续存放, 同一列的所有值物理相邻. 适合 OLAP — 分析查询通常只涉及少数列 (如 `SELECT avg(amount) FROM orders WHERE date > '2024-01-01'`), 列存只读取需要的列, I/O 量与列数成正比而非总列数.

列存的三大优势:

1. I/O 放大消除: 100 列的表查 3 列, 行存读 100 列的数据, 列存只读 3 列, I/O 减少约 97%
2. 压缩率极高: 同列数据类型相同、值域相近 (如 status 列只有几个枚举值), 压缩率通常 5~10 倍; 行存中不同类型混在一行, 压缩率差
3. 向量化执行友好: 同列数据连续存放, CPU 可以用 SIMD 指令一次处理多个值 (如 AVX2 一次处理 8 个 int32), 充分利用 CPU cache line

列存的代价:

- 单行点查性能差: 取一行需要读 N 个列文件再拼装, 随机 I/O 多
- 写入需要按列拆分: 一行数据要拆成 N 列分别追加, 写放大
- 不适合频繁更新: 列存更新一行等于重写多个列文件

### MergeTree 引擎的核心结构是什么? 数据写入和合并的流程?

MergeTree 是 ClickHouse 最基础的表引擎, 核心组件:

```text
table/
├── 202401_1_1_0/          # 一个 part (数据分片)
│   ├── primary.idx        # 稀疏主键索引 (每 8192 行一个标记)
│   ├── column_a.bin       # 列数据 (压缩后)
│   ├── column_a.mrk2      # 标记文件 (记录每个 granule 在 .bin 中的偏移)
│   ├── count.txt          # 行数
│   ├── columns.txt        # 列元信息
│   └── checksums.txt      # 校验和
├── 202401_2_2_0/          # 另一个 part
└── ...
```

写入流程:

1. 客户端发送 INSERT 数据, ClickHouse 按 ORDER BY 键排序
2. 按 `index_granularity` (默认 8192 行) 切分为 granule
3. 每个 granule 生成一条主键索引记录 (稀疏索引, 只记首行主键值)
4. 列数据按 granule 分块压缩 (默认 LZ4) 写入 `.bin` 文件
5. 标记文件 `.mrk2` 记录每个 granule 在 `.bin` 中的解压块偏移和块内偏移
6. 整个写入生成一个新的 part 目录, 原子 rename 对读可见

合并 (Merge) 流程:

- 后台线程定期将多个小 part 合并为大 part (类似 LSM-Tree 的 compaction)
- 合并时重新排序、重建索引、重新压缩
- 合并是异步的, 不阻塞读写; 读时如果数据跨多个 part, 会做多路归并

### 稀疏索引 (primary.idx) 是如何加速查询的? 与 MySQL B+ 树索引的区别?

ClickHouse 的稀疏索引:

- 每 `index_granularity` (默认 8192) 行记录一个索引条目, 只存该 granule 首行的 ORDER BY 键值
- 索引常驻内存 (因为稀疏, 10 亿行也只有约 12 万个条目, 几 MB)
- 查询时二分查找定位到候选 granule 范围, 再顺序扫描这些 granule

```text
primary.idx:  [1, 8193, 16385, 24577, ...]   # 每 8192 行一个值
                 |      |       |
granule 0:   rows 1~8192
granule 1:   rows 8193~16384
granule 2:   rows 16385~24576
```

与 MySQL B+ 树索引的区别:

| 维度     | ClickHouse 稀疏索引             | MySQL B+ 树索引                |
| -------- | ------------------------------- | ------------------------------ |
| 粒度     | 每 8192 行一个条目              | 每行一个叶子节点               |
| 内存占用 | 极小, 全量常驻内存              | 大, 通常只有热页在 buffer pool |
| 定位精度 | 定位到 granule 范围, 需范围扫描 | 定位到具体行                   |
| 适用场景 | 范围查询、前缀匹配              | 点查、范围查询                 |
| 更新代价 | 合并时重建, 无在线维护开销      | 每次写入都要维护 B+ 树平衡     |

关键限制: 稀疏索引要求数据物理有序 (按 ORDER BY 排列), 所以 MergeTree 写入时会排序. 如果查询条件不是 ORDER BY 的前缀, 索引无法使用, 退化为全表扫描.

### ReplacingMergeTree、AggregatingMergeTree、CollapsingMergeTree 分别解决什么问题?

MergeTree 家族通过不同的合并策略解决不同场景:

ReplacingMergeTree(version):

- 问题: 同一主键的多条记录 (如 CDC 产生的多次更新), 查询时只想看最新版本
- 机制: 合并时按 ORDER BY 键去重, 保留 `version` 列最大的行; 若 version 相同保留最后写入的
- 注意: 去重只发生在合并时, 合并前查询仍会看到重复行, 需配合 `FINAL` 关键字或 `argMax` 聚合
- 典型场景: 从 MySQL binlog 同步到 ClickHouse, 用 ReplacingMergeTree 实现 upsert 语义

AggregatingMergeTree:

- 问题: 预聚合场景, 如按小时统计 UV, 原始数据量太大
- 机制: 定义 AggregateFunction 类型的列 (如 `uniqState(user_id)`), 写入时存聚合中间状态, 合并时将同主键的状态合并
- 查询时用 `uniqMerge` 从中间状态计算最终结果
- 典型场景: 实时报表的预计算, 用物化视图 + AggregatingMergeTree 增量聚合

CollapsingMergeTree(Sign):

- 问题: 需要"更新"但引擎不支持原地更新, 用"先删后插"模拟
- 机制: Sign 列 (+1 表示有效行, -1 表示取消行); 合并时将同主键的 +1 和 -1 配对抵消
- 写入更新 = 插入一条 Sign=-1 的旧值 + 一条 Sign=+1 的新值
- 查询时必须用 `GROUP BY ... HAVING sum(Sign) > 0` 或 `FINAL` 过滤未合并的脏数据
- 缺点: 写入量翻倍, 查询复杂; 实践中更常用 ReplacingMergeTree

### ClickHouse 的数据分区 (PARTITION BY) 和分片 (SHARD) 有什么区别?

分区 (PARTITION BY) — 单机内的逻辑划分:

- 将表数据按分区键 (通常是日期 `toYYYYMM(event_date)`) 切分为多个独立的数据集合
- 每个分区内的数据独立存储、独立合并
- 查询时分区裁剪 (partition pruning): WHERE 条件命中分区键时, 只扫描相关分区
- `DROP PARTITION` 可以瞬间删除整个分区的数据 (比 DELETE 快几个数量级)
- 分区数不宜过多 (建议 < 1000), 否则元数据膨胀、合并效率下降

分片 (SHARD) — 多机间的物理分布:

- 通过 Distributed 表引擎实现, 数据分散在多台机器的本地表上
- 写入: Distributed 表接收数据, 按分片键 (如 `rand()` 或 `sipHash64(user_id)`) 路由到对应分片
- 查询: Distributed 表将查询下推到各分片并行执行, 汇总结果返回
- 分片解决单机容量和算力瓶颈, 是水平扩展的手段

```sql
-- 本地表 (每台机器上创建)
CREATE TABLE events_local ON CLUSTER my_cluster (
    event_date Date,
    user_id UInt64,
    event_type String
) ENGINE = MergeTree()
PARTITION BY toYYYYMM(event_date)
ORDER BY (user_id, event_date);

-- 分布式表 (查询入口)
CREATE TABLE events_dist ON CLUSTER my_cluster AS events_local
ENGINE = Distributed(my_cluster, default, events_local, sipHash64(user_id));
```

### ClickHouse 的副本机制 (ReplicatedMergeTree) 是如何工作的? 与 ZooKeeper 的关系?

ReplicatedMergeTree 实现表级副本:

```sql
CREATE TABLE events_local (
    ...
) ENGINE = ReplicatedMergeTree(
    '/clickhouse/tables/{shard}/events',  -- ZK 路径, {shard} 是宏变量
    '{replica}'                            -- 副本名
)
PARTITION BY toYYYYMM(event_date)
ORDER BY (user_id, event_date);
```

工作原理:

1. ZooKeeper 作为协调者, 存储副本间的复制日志 (replication log): 记录每个 part 的创建、合并、变异 (mutation) 操作
2. 写入时: 数据写入当前副本的本地磁盘后, 在 ZK 的 replication log 中注册一个新 part
3. 其他副本通过 Watch 机制感知到 log 变化, 从源副本 (或任意已有该 part 的副本) 拉取数据文件
4. 合并操作: 由某个副本选举为 leader 执行, 合并结果通过 replication log 同步给其他副本, 保证所有副本的 part 结构一致

ZooKeeper 的角色:

- 不存储数据本身, 只存元数据和复制日志
- 提供分布式协调: leader 选举、part 分配、DDL 同步
- ZK 不可用时: 读不受影响 (本地有完整数据), 但副本表的 INSERT 与 DDL/ALTER 都会失败 (写入依赖 ZK 中的 replication log, 常见表现为表进入只读模式)
- ClickHouse Keeper 于 21.3 实验性引入、22.3+ 生产可用, 用 Raft 协议替代 ZK, 去掉 Java 依赖

副本 vs 分片:

- 副本解决高可用 (一个分片挂了, 副本接管)
- 分片解决水平扩展 (数据分散到多台机器)
- 生产部署: N 个分片 x M 个副本, 每个分片有 M 份数据

### ClickHouse 查询执行的向量化引擎是什么? 为什么比逐行处理快?

传统数据库 (MySQL) 的 Volcano 模型: 每个算子每次处理一行, 通过 `next()` 调用向上传递. 问题:

- 每行一次虚函数调用, CPU 分支预测失败率高
- 数据在算子间以行传递, cache 局部性差
- 无法利用 SIMD 指令

ClickHouse 的向量化执行:

- 每个算子每次处理一列的一个 block (查询执行层由 `max_block_size` 控制, 默认 65536 行; 不要与存储层的索引粒度 8192 混淆——granule 是 MergeTree 稀疏索引与标记文件的最小单元, 两者概念不同)
- 同列数据连续存放在内存中, 一次加载到 CPU cache line
- 利用 SIMD (SSE4.2 / AVX2 / AVX-512) 一条指令并行处理 4~16 个值
- 减少虚函数调用次数: 从 N 行 x M 列次降为 (N/max_block_size) x M 次

```text
Volcano (逐行):          向量化 (逐列块):
  for each row:            for each block (max_block_size rows):
    filter(row)              filter(column_block)  // SIMD 批量比较
    project(row)             project(column_block) // SIMD 批量计算
    aggregate(row)           aggregate(column_block)
```

实际收益: 在聚合、过滤等计算密集型操作上, 向量化比逐行快 5~10 倍; 配合列存的高压缩率, 解压后直接以 SIMD 友好格式处理, 进一步减少内存带宽消耗.

### ClickHouse 的物化视图 (Materialized View) 与普通视图有什么区别? 如何实现增量聚合?

普通视图 (VIEW): 只是一条保存的 SQL, 每次查询时重新执行, 不存储数据.

物化视图 (MATERIALIZED VIEW): 独立存储数据的表, 由 INSERT 触发器驱动增量更新:

```sql
-- 目标表: 存预聚合结果
CREATE TABLE hourly_stats (
    hour DateTime,
    event_type String,
    cnt UInt64
) ENGINE = SummingMergeTree()
ORDER BY (hour, event_type);

-- 物化视图: 定义从源表到目标表的转换逻辑
CREATE MATERIALIZED VIEW hourly_stats_mv TO hourly_stats AS
SELECT
    toStartOfHour(event_time) AS hour,
    event_type,
    count() AS cnt
FROM events_local
GROUP BY hour, event_type;
```

增量聚合机制:

1. 数据 INSERT 到源表 `events_local` 时, 触发物化视图的转换逻辑
2. 只对本次 INSERT 的数据块执行 GROUP BY, 产出增量聚合结果
3. 增量结果 INSERT 到目标表 `hourly_stats`
4. SummingMergeTree 在合并时将同主键的 `cnt` 列累加, 得到最终聚合值

关键特性:

- 物化视图只处理 INSERT 之后的新数据, 历史数据需要手动 `INSERT INTO hourly_stats SELECT ...`
- 源表删除数据不会级联删除目标表中已聚合的结果 (聚合不可逆)
- 多个物化视图可以挂在同一张源表上, 各自独立增量计算
- 与 AggregatingMergeTree 配合可以存更复杂的中间状态 (如 HyperLogLog 的 sketch)

### ClickHouse 的 TTL 机制和数据生命周期管理

TTL 可以设置在列级或表级:

```sql
CREATE TABLE logs (
    event_time DateTime,
    level String,
    -- 列级 TTL: 30 天后 message 列被清空 (变为空字符串), 行仍在
    message String TTL event_time + INTERVAL 30 DAY
) ENGINE = MergeTree()
ORDER BY event_time
-- 表级 TTL: 30 天后删除 DEBUG 行, 90 天后删除整行
TTL event_time + INTERVAL 30 DAY DELETE WHERE level = 'DEBUG',
    event_time + INTERVAL 90 DAY DELETE;
```

TTL 还支持:

- `TTL ... TO DISK 'cold'`: 数据冷却后迁移到廉价存储 (如 HDD / S3)
- `TTL ... TO VOLUME 'archive'`: 迁移到指定存储卷
- `TTL ... GROUP BY ... SET cnt = max(cnt)`: 过期后不是删除, 而是聚合压缩 (保留统计值, 丢弃明细)

执行机制:

- TTL 在 part 合并时检查和执行 (不是实时删除)
- 后台合并线程发现 part 中有数据超过 TTL, 在合并时过滤掉过期行
- 可以手动触发: `OPTIMIZE TABLE logs FINAL` 强制全量合并, 立即清理过期数据
- `merge_with_ttl_timeout` 控制 TTL 合并的最小间隔 (默认 4 小时), 避免频繁合并

---

## 二、ClickHouse 查询优化与实战

### ORDER BY 键的设计原则是什么? 如何影响查询性能?

ORDER BY 键决定了数据的物理排列顺序和稀疏索引的结构, 是 ClickHouse 性能优化的第一要素.

设计原则:

1. 最左前缀匹配: 查询条件必须是 ORDER BY 键的前缀才能利用索引. `ORDER BY (a, b, c)` 时, `WHERE a = 1 AND b = 2` 走索引, `WHERE b = 2` 不走
2. 高选择性列在前: 将区分度高的列放前面 (如 user_id), 低区分度的列放后面 (如 status), 可以更快缩小扫描范围
3. 常用查询模式优先: 如果有多种查询模式, 优先满足最高频的; 次要模式可以用投影 (PROJECTION) 或物化视图
4. 不要太多列: ORDER BY 键越长, 索引越大, 排序开销越高; 通常 3~5 列足够
5. 与 PARTITION BY 配合: 分区键通常是时间, ORDER BY 键通常是业务维度; 查询同时命中分区裁剪 + 索引查找时效率最高

错误示例:

```sql
-- ORDER BY (status, user_id): status 只有 5 个值, 索引几乎无法缩小范围
-- 正确: ORDER BY (user_id, status): user_id 区分度高, 先定位用户再过滤状态
```

### ClickHouse 的 JOIN 实现方式有哪些? 大表 JOIN 的性能陷阱?

ClickHouse 的 JOIN 实现:

1. Hash JOIN (默认): 将右表构建为内存中的哈希表, 左表逐行探测. 右表必须能放进内存, 否则 OOM
2. Partial Merge JOIN: 右表太大时, 分块加载右表, 排序后与左表做归并. 速度慢但不 OOM
3. Grace Hash JOIN: 右表按哈希分桶写磁盘, 逐桶加载构建哈希表. 22.3+ 引入
4. Distributed JOIN: 分布式表 JOIN 时, 数据需要在节点间 shuffle, 网络开销大

性能陷阱与优化:

- 小表放右边: `SELECT ... FROM big_table JOIN small_table ON ...` — ClickHouse 总是构建右表的哈希表
- 避免分布式 JOIN: 如果两张表按相同键分片 (colocate), 可以在本地表上 JOIN, 避免 shuffle
- 用 IN 替代 JOIN: 如果只是过滤 (不需要右表的列), `WHERE id IN (SELECT id FROM ...)` 比 JOIN 快
- 字典 (Dictionary): 维度表 (如城市名、商品类目) 加载为内存字典, 用 `dictGet` 函数替代 JOIN
- `join_algorithm` 设置: 根据数据量选择 `hash` / `partial_merge` / `grace_hash` / `auto`

### ClickHouse 的 Mutation (ALTER UPDATE / DELETE) 为什么慢? 生产上怎么替代?

Mutation 是异步的重量级操作:

```sql
ALTER TABLE events UPDATE status = 'archived' WHERE event_date < '2023-01-01';
ALTER TABLE events DELETE WHERE user_id = 12345;
```

为什么慢:

- ClickHouse 的 part 是不可变的 (immutable), UPDATE/DELETE 不是原地修改
- 实际执行: 读取包含目标行的整个 part, 重写所有列文件 (即使只改一列), 生成新 part, 旧 part 标记删除
- 一个 part 有 1 亿行, 改其中 1 行也要重写整个 part 的全部列
- 多个 mutation 排队串行执行, 不并发

生产替代方案:

1. ReplacingMergeTree: 插入新版本行, 合并时自动去重, 查询用 FINAL 或 argMax
2. CollapsingMergeTree: 插入 -1 行抵消旧行, +1 行写入新值
3. 分区级操作: `ALTER TABLE DROP PARTITION` 删除整个分区 (瞬间完成)
4. 轻量删除 (22.8+): `DELETE FROM events WHERE ...` (注意不是 ALTER TABLE DELETE), 只标记行删除, 不重写 part, 查询时过滤; 合并时物理清除. 比 mutation 快很多, 但标记期间仍占磁盘

### ClickHouse 与 MySQL 在 OLAP 场景下的性能差异根源是什么?

同样一条 `SELECT count(*) FROM orders WHERE status = 'paid' GROUP BY region` (1 亿行, 20 列):

| 环节     | MySQL (InnoDB)                                  | ClickHouse                                                     |
| -------- | ----------------------------------------------- | -------------------------------------------------------------- |
| I/O      | 读所有 20 列 (行存, 即使只需 3 列)              | 只读 status + region 两列                                      |
| 压缩     | 页级压缩, 压缩率约 2x                           | 列级 LZ4/ZSTD, 压缩率 5~10x                                    |
| 执行模型 | 逐行 Volcano, 每行一次虚函数调用                | 向量化, 按 block (max_block_size 默认 65536 行) 批量 SIMD 处理 |
| 并行度   | 单线程执行 (per query, 即使 8.0 也以单线程为主) | 多核并行, 每个 part 一个线程                                   |
| 索引     | B+ 树定位行, 回表读数据                         | 稀疏索引定位 granule, 顺序扫描                                 |
| 聚合     | 逐行累加                                        | 列数据连续, cache 友好, SIMD 加速                              |

综合效果: 典型 OLAP 聚合查询 ClickHouse 比 MySQL 快 100~1000 倍.

但 ClickHouse 不适合:

- 高并发点查 (QPS > 1000 的小查询): 每次查询都要启动多线程、读多个列文件, 延迟高
- 频繁单行更新/删除: 不可变 part 设计导致更新代价极高
- 事务: 不支持 ACID 事务, 没有行锁

---

## 三、Kafka 架构与存储

### Kafka 的整体架构是怎样的? 核心组件有哪些?

```text
                    ┌─────────────────────────────────────────────┐
                    │              Kafka Cluster                   │
                    │                                             │
  Producer ──────> │  Broker 0          Broker 1          Broker 2│
                    │  ┌──────────┐     ┌──────────┐     ┌──────┐│
                    │  │Topic A P0│     │Topic A P1│     │Topic A P2│
                    │  │(Leader)  │     │(Leader)  │     │(Leader)  │
                    │  │Topic B P1│     │Topic B P2│     │Topic B P0│
                    │  │(Follower)│     │(Follower)│     │(Follower)│
                    │  └──────────┘     └──────────┘     └──────┘│
                    └─────────────────────────────────────────────┘
                              ^                    |
                              │                    v
                         Controller           Consumer Group
                        (KRaft/ZK)           (C0, C1, C2)
```

核心组件:

- Broker: Kafka 服务节点, 负责消息存储和转发
- Topic: 逻辑上的消息分类, 一个 topic 可以有多个 partition
- Partition: topic 的物理分片, 是并行度和顺序性的基本单位; 每个 partition 是一个只追加的有序日志
- Leader / Follower: 每个 partition 有一个 leader 处理所有读写, 多个 follower 同步数据
- Controller: 集群中的一个 broker 担任, 负责 partition leader 选举、broker 上下线感知
- Consumer Group: 一组消费者共同消费一个 topic, 每个 partition 只被组内一个消费者消费
- Offset: 每条消息在 partition 内的唯一递增编号, 消费者通过 offset 记录消费进度

### Kafka 的消息存储结构是怎样的? 为什么吞吐量这么高?

存储结构:

```text
partition-0/
├── 00000000000000000000.log      # 消息数据文件 (segment)
├── 00000000000000000000.index    # 稀疏偏移量索引
├── 00000000000000000000.timeindex # 时间戳索引
├── 00000000000005367851.log      # 下一个 segment
├── 00000000000005367851.index
└── ...
```

- Segment: 日志文件按大小 (默认 1GB, `log.segment.bytes`) 或时间 (默认 7 天, `log.roll.hours`) 切分为多个 segment
- 每个 segment 以第一条消息的 offset 命名, 查找时二分定位到 segment 文件
- `.index`: 稀疏索引, 每 4KB 记录一个 (offset, 物理位置) 对, 查找时先定位到索引区间再顺序扫描
- `.timeindex`: 按时间戳查找消息 (用于 `offsetsForTimes` API)

高吞吐的原因:

1. 顺序写磁盘: 消息追加到日志文件末尾, 磁盘顺序写速度接近内存 (600MB/s vs 随机写 100KB/s)
2. Page Cache: 写入只到 OS 页缓存, 由操作系统异步刷盘; 读取热数据也命中页缓存, 不经过 JVM 堆
3. 零拷贝 (sendfile): 消费者读消息时, 数据从磁盘 -> 页缓存 -> 网卡, 不经过用户空间, 省两次内存拷贝
4. 批量 + 压缩: Producer 端将消息攒批 (默认 16KB, `batch.size`), 压缩 (lz4/zstd) 后一次网络请求发送多条消息
5. 分区并行: 多个 partition 分布在不同 broker, 读写天然并行
6. 消息格式紧凑: 二进制协议, 变长编码, 无冗余字段

### Kafka 的 ISR 机制是什么? Leader 选举的流程?

ISR (In-Sync Replicas): 与 leader 保持同步的副本集合.

同步标准:

- follower 的 LEO (Log End Offset, 已写入的最大 offset) 与 leader 的 LEO 差距在 `replica.lag.time.max.ms` (默认 30s) 以内
- 即 follower 在 30s 内有过成功拉取, 就认为同步; 超过 30s 没追上则被踢出 ISR

HW (High Watermark): ISR 中所有副本的最小 LEO, 消费者只能读到 HW 之前的消息 (保证读到的数据不会因 leader 切换而丢失).

```text
Leader:    [msg0, msg1, msg2, msg3, msg4]  LEO=5
Follower1: [msg0, msg1, msg2, msg3]        LEO=4  (在 ISR 中)
Follower2: [msg0, msg1]                    LEO=2  (在 ISR 中)
                                           HW = min(5, 4, 2) = 2
消费者只能读到 msg0, msg1
```

Leader 选举流程 (KRaft 模式, 2.8+):

1. Controller 检测到某 partition 的 leader broker 下线 (心跳超时)
2. 从该 partition 的 ISR 列表中选第一个存活副本作为新 leader
3. 如果 ISR 为空: 取决于 `unclean.leader.election.enable`
   - false (默认): partition 不可用, 等待 ISR 中的副本恢复 (保证数据不丢)
   - true: 从所有副本 (包括不同步的) 中选一个, 可能丢数据 (可用性优先)
4. Controller 将新 leader 信息写入元数据, 通知所有 broker 和消费者

### Kafka 的 Producer 发送消息的完整流程? acks 参数的含义?

发送流程:

1. 序列化: key 和 value 经过 Serializer 转为字节数组
2. 分区路由: 指定了 partition 则直接发; 指定了 key 则 `hash(key) % partition_count`; 都没有则粘性分区 (Sticky Partitioner, 2.4+): 攒满一个 batch 后换下一个 partition, 兼顾负载均衡和批量效率
3. 攒批: 消息进入 RecordAccumulator, 按 partition 分组, 每个 partition 维护一个或多个 ProducerBatch
4. 触发发送: batch 大小达到 `batch.size` (默认 16KB) 或等待时间达到 `linger.ms` (Kafka 3.0 起默认 5ms, 3.0 之前为 0; 可按吞吐需要设 5~100ms) 时, Sender 线程取出 batch
5. 压缩: 按 `compression.type` (lz4/zstd/snappy) 压缩整个 batch
6. 网络发送: Sender 线程将 batch 通过 NIO 发送到对应 partition 的 leader broker
7. 回调/重试: 收到 broker 响应后执行 Callback; 可重试的错误 (如 NOT_LEADER) 自动重试 `retries` 次

acks 参数:

| acks | 含义                                    | 可靠性        | 延迟 |
| ---- | --------------------------------------- | ------------- | ---- |
| 0    | 不等待任何确认, 发完就认为成功          | 可能丢消息    | 最低 |
| 1    | leader 写入本地日志即确认               | leader 宕机丢 | 中等 |
| -1   | 等待 ISR 中所有副本写入成功才确认 (all) | 最高          | 最高 |

生产建议: `acks=all` + `retries=Integer.MAX_VALUE` + `enable.idempotence=true`, 在保证不丢的前提下实现 exactly-once 写入.

### Kafka 的幂等 Producer 和事务 Producer 是怎么实现的?

幂等 Producer (单分区 exactly-once):

- 开启: `enable.idempotence=true`
- 机制: Producer 初始化时获取一个 PID (Producer ID), 每条消息携带 (PID, Partition, SequenceNumber)
- Broker 端为每个 (PID, Partition) 维护一个序列号, 收到消息时检查:
  - seq = 期望值: 正常写入, 期望值 +1
  - seq < 期望值: 重复消息, 直接丢弃 (返回成功)
  - seq > 期望值: 乱序, 返回错误
- 局限: 只保证单分区内不重复; Producer 重启后 PID 变化, 幂等失效

事务 Producer (跨分区 exactly-once):

- 开启: 设置 `transactional.id`, 调用 `initTransactions()`
- 机制: 引入 Transaction Coordinator (一个特殊的 broker) 管理事务状态
- 流程:

```java
producer.initTransactions();
try {
    producer.beginTransaction();
    producer.send(record1);  // 分区 0
    producer.send(record2);  // 分区 1
    producer.sendOffsetsToTransaction(offsets, groupId); // 消费位移也纳入事务
    producer.commitTransaction();
} catch (Exception e) {
    producer.abortTransaction();
}
```

- 底层: 事务协调者在 `__transaction_state` topic 中记录事务状态 (PrepareCommit -> Commit); 各分区 leader 收到 PrepareCommit 后写 COMMIT 标记; 消费者设置 `isolation.level=read_committed` 时只读 COMMIT 之前的消息
- 代价: 事务消息的延迟增加 (两阶段提交), 吞吐下降约 30~50%

### Consumer Group 的 Rebalance 机制是什么? 有什么问题? 如何优化?

Rebalance 触发条件:

- 消费者加入/离开 group (崩溃、主动 unsubscribe)
- 订阅的 topic 的 partition 数量变化
- 订阅的 topic 列表变化 (正则订阅时新 topic 创建)

Rebalance 流程 (Eager 协议, 默认):

1. 所有消费者向 Group Coordinator (某个 broker) 发送 JoinGroup 请求
2. Coordinator 选出第一个加入的消费者为 Leader, 将 group 信息发给 Leader
3. Leader 根据分配策略 (Range / RoundRobin / Sticky) 计算分配方案, 发给 Coordinator
4. Coordinator 将分配结果发给所有消费者
5. 所有消费者按新方案消费

Eager 协议的问题:

- Stop-the-world: Rebalance 期间所有消费者停止消费, 等待重新分配
- 重复消费: 消费者在 Rebalance 前未提交的 offset 会被重新分配给其他消费者
- 频繁 Rebalance: 消费者处理慢导致心跳超时 (`session.timeout.ms` 默认 45s, Kafka 3.0 之前为 10s), 被 Coordinator 认为死亡, 触发 Rebalance, 形成恶性循环

优化:

1. Cooperative Rebalance (增量式, 2.4+): 只迁移需要变动的 partition, 不涉及的 partition 继续消费, 大幅减少停顿
2. Static Membership (2.3+): 消费者设置 `group.instance.id`, 短暂离线 (如 GC、重启) 不触发 Rebalance, 在 `session.timeout.ms` 内重连则恢复原分配
3. 调参: 增大 `session.timeout.ms` (如 45s)、增大 `max.poll.interval.ms` (如 5min)、减小 `max.poll.records` 避免处理超时
4. 手动提交 offset: 处理完再提交, 避免自动提交导致的重复消费

### Kafka 如何保证消息不丢失? 端到端 exactly-once 怎么实现?

消息可能在三个环节丢失:

1. Producer -> Broker: 网络抖动、broker 宕机
   - 解决: `acks=all` + 重试; 幂等 Producer 防重复
2. Broker 存储: leader 宕机, 未同步到 follower 的消息丢失
   - 解决: `replication.factor >= 3` + `min.insync.replicas >= 2` + `acks=all`
   - `min.insync.replicas`: ISR 中副本数低于此值时, leader 拒绝写入 (宁可不可用也不丢数据)
3. Consumer 处理: 消费者拉到消息后崩溃, offset 已提交但处理未完成
   - 解决: 手动提交 offset, 处理成功后再 commit; 或事务性消费

端到端 exactly-once (Kafka Streams 的 read-process-write 场景):

```text
Consumer (read_committed) --> 处理逻辑 --> Transactional Producer
     |                                          |
     └── sendOffsetsToTransaction() ────────────┘
         (将消费 offset 纳入 producer 事务)
```

- 消费 offset 的提交和生产消息在同一个事务中原子完成
- 要么都成功 (消息产出 + offset 前进), 要么都回滚
- 局限: 只适用于 Kafka -> Kafka 的场景; 如果下游是外部系统 (如 MySQL), 需要业务层幂等 (唯一键去重) 或两阶段提交

---

## 四、Kafka 高级特性与调优

### Kafka 的消息顺序性如何保证? 什么场景下会乱序?

Kafka 的顺序保证:

- 单 partition 内: 消息严格按写入顺序排列, 消费者按 offset 顺序消费, 天然有序
- 跨 partition: 无顺序保证, 不同 partition 可能分布在不同 broker, 消费速度不同

保证全局有序:

- 将 topic 设为单 partition (牺牲并行度)
- 或将需要有序的消息用相同 key 路由到同一 partition (如订单 ID 作为 key, 同一订单的消息有序)

乱序场景:

1. Producer 重试: 消息 A 发送失败触发重试, 消息 B 先到达 broker, 导致 B 在 A 前面
   - 解决: 幂等 Producer (序列号去重) + `max.in.flight.requests.per.connection=1` (牺牲吞吐) 或开启幂等后设为 5 (broker 端排序)
2. 多 partition: 不同 partition 的消费速度不同, 跨 partition 的消息到达下游的顺序不确定
3. Consumer 多线程处理: 一个 partition 的消息被分发到多个线程, 处理完成顺序不确定
   - 解决: 单 partition 单线程; 或按 key 哈希分发到固定线程

### Kafka 的零拷贝 (Zero-Copy) 原理是什么? 对比传统 I/O 省了哪些步骤?

传统 I/O (read + write):

```text
磁盘 --> 内核缓冲区 --> 用户空间缓冲区 --> Socket 缓冲区 --> 网卡
         (DMA)          (CPU 拷贝)         (CPU 拷贝)       (DMA)
```

4 次拷贝 (2 次 DMA + 2 次 CPU), 4 次上下文切换.

Kafka 使用 sendfile 系统调用:

```text
磁盘 --> 内核缓冲区 --> 网卡
         (DMA)          (DMA, 直接从页缓存到网卡)
```

2 次拷贝 (都是 DMA, 无 CPU 拷贝), 2 次上下文切换.

实现:

- Java 中通过 `FileChannel.transferTo()` 调用底层 `sendfile`
- Kafka 的 `LogSegment.read()` 返回 `FileRecords`, 底层用 `FileChannel.transferTo` 将日志文件内容直接传输到 SocketChannel
- 数据不经过 JVM 堆内存, 不触发 GC, 不占用应用缓冲区

补充: 如果开启了压缩 (producer 端压缩), 消息在 broker 端是压缩存储的, 消费者也是压缩接收后自行解压, 所以 broker 转发时不需要解压, 零拷贝仍然有效.

### Kafka 与 RocketMQ、RabbitMQ 的对比? 各自适用场景?

| 维度       | Kafka                 | RocketMQ                     | RabbitMQ                  |
| ---------- | --------------------- | ---------------------------- | ------------------------- |
| 设计目标   | 高吞吐日志/流处理     | 业务消息, 金融级可靠         | 灵活路由, 企业集成        |
| 吞吐量     | 百万级 TPS            | 十万级 TPS                   | 万级 TPS                  |
| 延迟       | 毫秒级 (批量优化)     | 毫秒级                       | 微秒级 (单条)             |
| 消息模型   | Pull (消费者拉取)     | Pull + 长轮询                | Push (broker 推送)        |
| 顺序消息   | 分区内有序            | 队列内有序 + 严格顺序模式    | 单队列有序                |
| 延迟消息   | 不原生支持            | 18 个等级 (5.x 支持任意时间) | 插件支持                  |
| 事务消息   | 支持 (事务 Producer)  | 支持 (半消息 + 回查)         | 不原生支持                |
| 消息回溯   | 支持 (按 offset/时间) | 支持 (按时间)                | 不支持 (消费即删除)       |
| 消息过滤   | 不支持 (需消费端过滤) | Tag / SQL92 过滤             | Routing Key / Header 匹配 |
| 死信队列   | 不原生支持            | 支持                         | 支持                      |
| 协议       | 自定义二进制协议      | 自定义协议                   | AMQP / MQTT / STOMP       |
| 运维复杂度 | 中 (依赖 ZK/KRaft)    | 中 (NameServer 轻量)         | 低 (Erlang 单节点)        |

选型建议:

- 日志收集、指标监控、流计算 (Flink/Spark): Kafka
- 电商交易、金融支付、需要延迟消息和事务回查: RocketMQ
- 中小规模、复杂路由、多协议接入: RabbitMQ

### Kafka 的 Controller 是怎么选举的? KRaft 模式与 ZooKeeper 模式的区别?

ZooKeeper 模式 (旧):

- 所有 broker 启动时在 ZK 的 `/controller` 节点创建临时节点, 先创建成功的成为 Controller
- Controller 宕机后, ZK 的 Watch 通知其他 broker, 它们竞争创建临时节点, 新 Controller 产生
- 元数据 (topic、partition、ISR) 存在 ZK 中, Controller 负责变更并同步

KRaft 模式 (2.8+, 3.3 生产就绪):

- 去掉 ZooKeeper 依赖, 用 Raft 共识协议管理元数据
- 集群中部分 broker 配置为 Controller 角色 (`process.roles=controller`), 组成 Raft 组
- 元数据存在内部 topic `__cluster_metadata` 中, 通过 Raft 日志复制到多数派 Controller
- Leader Controller 处理元数据变更, Follower Controller 同步日志

KRaft 的优势:

1. 去掉 ZK 依赖: 运维简化, 不需要额外维护 ZK 集群
2. 元数据管理更高效: 元数据作为 Kafka 内部日志, 利用 Kafka 自身的复制机制
3. 启动更快: 不需要与 ZK 交互, 元数据从本地日志恢复
4. 支持更大规模: ZK 的 Watch 机制在大量 partition 时性能下降, KRaft 无此问题
5. 元数据变更可追溯: 所有变更是 Raft 日志, 天然有审计能力

### Kafka 消费者的 Offset 管理策略? 自动提交和手动提交的区别?

Offset 存储: 消费者的 offset 存在内部 topic `__consumer_offsets` 中 (默认 50 个 partition), key 是 (group, topic, partition).

自动提交 (`enable.auto.commit=true`, 默认):

- 每 `auto.commit.interval.ms` (默认 5s) 自动提交上次 poll 返回的最大 offset
- 问题:
  - 消息处理失败但 offset 已提交 -> 消息丢失
  - Rebalance 时上次自动提交的 offset 之后、当前处理位置之前的消息被重复消费

手动提交:

```java
while (true) {
    ConsumerRecords<String, String> records = consumer.poll(Duration.ofMillis(100));
    for (ConsumerRecord<String, String> record : records) {
        process(record);  // 业务处理
    }
    consumer.commitSync();  // 同步提交, 阻塞直到成功
    // 或 consumer.commitAsync();  // 异步提交, 不阻塞, 通过回调处理失败
}
```

更精细的控制:

- `commitSync(offsets)`: 提交指定 partition 的指定 offset, 而非全部
- 每处理完一条就提交: 可靠性最高, 但频繁提交影响性能
- 批量处理后提交: 一批处理完统一提交, 平衡可靠性和性能
- 异步 + 同步兜底: 平时 `commitAsync` 提高吞吐, 在 `poll` 循环结束或 Rebalance 回调中 `commitSync` 保证最后一次提交成功

Rebalance 时的 offset 处理:

```java
consumer.subscribe(topics, new ConsumerRebalanceListener() {
    @Override
    public void onPartitionsRevoked(Collection<TopicPartition> partitions) {
        consumer.commitSync();  // 交出 partition 前提交当前进度
    }
    @Override
    public void onPartitionsAssigned(Collection<TopicPartition> partitions) {
        // 初始化新 partition 的状态 (如 seek 到指定位置)
    }
});
```

### Kafka 的日志清理策略有哪些? Log Compaction 的原理?

两种清理策略 (`log.cleanup.policy`):

1. delete (默认): 按时间 (`log.retention.hours`, 默认 7 天) 或大小 (`log.retention.bytes`) 删除过期 segment
2. compact: 保留每个 key 的最新值, 删除旧值 (类似 LSM-Tree 的 compaction)

Log Compaction 原理:

```text
清理前:
offset 0: key=A, value=1
offset 1: key=B, value=2
offset 2: key=A, value=3
offset 3: key=C, value=4
offset 4: key=B, value=5

清理后:
offset 2: key=A, value=3   (A 的最新值)
offset 3: key=C, value=4   (C 的最新值)
offset 4: key=B, value=5   (B 的最新值)
```

- 后台 Log Cleaner 线程维护一个 offset map (key -> 最大 offset), 扫描日志时只保留每个 key 的最后一条
- 活跃 segment (正在写入的) 不会被 compact, 只有非活跃 segment 参与
- Compaction 不保证立即执行, 有延迟 (`log.cleaner.min.cleanable.ratio` 控制触发阈值)

适用场景:

- `__consumer_offsets` topic 本身就是 compact 策略 (只保留每个消费者的最新 offset)
- 数据库变更日志 (CDC): 只关心每行的最终状态
- 配置/缓存同步: 每个 key 只需要最新值

### Kafka 生产环境的关键配置和调优参数有哪些?

Broker 端:

| 参数                          | 建议值                | 说明                               |
| ----------------------------- | --------------------- | ---------------------------------- |
| `num.io.threads`              | 8~16                  | 磁盘 I/O 线程数, 与磁盘数量相关    |
| `num.network.threads`         | 4~8                   | 网络处理线程数                     |
| `log.flush.interval.messages` | 不设置 (依赖 OS 刷盘) | 强制刷盘会严重降低吞吐             |
| `num.partitions`              | 按吞吐估算            | 默认 1, 生产建议 >= 6              |
| `default.replication.factor`  | 3                     | 副本数                             |
| `min.insync.replicas`         | 2                     | 配合 acks=all, 保证至少 2 副本写入 |
| `log.retention.hours`         | 按业务                | 默认 168 (7 天)                    |
| `message.max.bytes`           | 按需                  | 默认 1MB, 大消息需调大             |

Producer 端:

| 参数                                    | 建议值          | 说明                         |
| --------------------------------------- | --------------- | ---------------------------- |
| `acks`                                  | all             | 最高可靠性                   |
| `batch.size`                            | 65536 (64KB)    | 攒批大小, 太小浪费网络       |
| `linger.ms`                             | 10~50           | 攒批等待时间, 0 表示立即发送 |
| `compression.type`                      | lz4 或 zstd     | lz4 速度快, zstd 压缩率高    |
| `buffer.memory`                         | 67108864 (64MB) | 发送缓冲区, 太小会阻塞 send  |
| `max.in.flight.requests.per.connection` | 5               | 幂等模式下最大 5, 保证顺序   |

Consumer 端:

| 参数                   | 建议值        | 说明                                   |
| ---------------------- | ------------- | -------------------------------------- |
| `fetch.min.bytes`      | 1024~65536    | 最少攒够多少数据再返回, 减少请求次数   |
| `fetch.max.wait.ms`    | 500           | 攒不够时的最大等待时间                 |
| `max.poll.records`     | 500           | 单次 poll 最大条数, 防处理超时         |
| `max.poll.interval.ms` | 300000 (5min) | 两次 poll 最大间隔, 超时触发 Rebalance |
| `session.timeout.ms`   | 45000         | 心跳超时, 太短容易误判死亡             |

---

## 五、ClickHouse + Kafka 联合架构

### ClickHouse 如何消费 Kafka 数据? Kafka Engine 的工作原理?

ClickHouse 内置 Kafka 引擎, 可以将 Kafka topic 作为数据源:

```sql
-- 1. 创建 Kafka 引擎表 (消费入口)
CREATE TABLE events_kafka (
    event_time DateTime,
    user_id UInt64,
    event_type String,
    payload String
) ENGINE = Kafka()
SETTINGS
    kafka_broker_list = 'broker1:9092,broker2:9092',
    kafka_topic_list = 'user_events',
    kafka_group_name = 'clickhouse_consumer',
    kafka_format = 'JSONEachRow',
    kafka_num_consumers = 4;

-- 2. 创建目标存储表
CREATE TABLE events (
    event_time DateTime,
    user_id UInt64,
    event_type String,
    payload String
) ENGINE = MergeTree()
PARTITION BY toYYYYMMDD(event_time)
ORDER BY (user_id, event_time);

-- 3. 创建物化视图, 将 Kafka 数据持续导入目标表
CREATE MATERIALIZED VIEW events_mv TO events AS
SELECT * FROM events_kafka;
```

工作原理:

1. Kafka 引擎表不存储数据, 它是一个虚拟的消费者
2. 物化视图触发时, ClickHouse 从 Kafka 引擎表 poll 一批消息
3. 消息经过物化视图的 SELECT 转换后 INSERT 到目标表
4. 消费 offset 由 ClickHouse 管理, 提交到 Kafka 的 `__consumer_offsets`

注意事项:

- `kafka_num_consumers` 不要超过 topic 的 partition 数 (多出的消费者分不到 partition)
- 消息解析失败不会重试, Kafka 引擎也没有内建死信队列: 默认按 `kafka_skip_broken_messages` (默认 0, 即一条坏消息即报错) 跳过并记日志; 配置 `kafka_handle_error_mode='stream'` 可把错误与原始消息写入 `_error`/`_raw_message` 虚拟列由下游自行处理. 需自行监控 system.kafka_consumers 表与日志
- 每批消费的数据量由 `kafka_max_block_size` 控制 (默认 65536 行)
- ClickHouse 重启后从上次提交的 offset 继续消费, 可能重复消费 (需目标表去重)

### 实时数仓架构中 ClickHouse + Kafka 的典型分层设计?

```text
数据源 (MySQL/日志/API)
        │
   Kafka (原始层, ODS)
   topic: raw_events, raw_orders, ...
        │
   Flink / ClickHouse 物化视图 (清洗 + 转换)
        │
   Kafka (明细层, DWD) 或直接写入 ClickHouse
   topic: dwd_events, dwd_orders, ...
        │
   ClickHouse (汇总层, DWS / 应用层, ADS)
   - 明细表: MergeTree, 保留全量明细
   - 聚合表: AggregatingMergeTree / SummingMergeTree, 预计算指标
   - 物化视图: 实时增量聚合
        │
   BI 报表 / API 服务 / 实时大屏
```

各层职责:

- ODS (原始层): Kafka 保存原始数据, 保留 7 天, 作为数据回溯和重放的基础
- DWD (明细层): 清洗 (去重、补全、格式化) 后的明细数据, 可以仍在 Kafka (流处理中间态) 或落入 ClickHouse
- DWS (汇总层): 按维度预聚合 (如每小时 UV、每日 GMV), 用 AggregatingMergeTree 存储
- ADS (应用层): 面向具体业务的宽表或指标表, 直接服务查询

关键设计决策:

- 是否需要 Flink: 简单 ETL 用 ClickHouse 物化视图即可; 复杂的多流 JOIN、窗口计算、状态管理需要 Flink
- 去重策略: Kafka 的 at-least-once 语义导致 ClickHouse 端必须去重, 用 ReplacingMergeTree 或查询时 `GROUP BY + argMax`
- 数据回溯: Kafka 保留期内可以重置 offset 重新消费, 重建 ClickHouse 中的聚合表

### ClickHouse 写入性能优化的关键点? 为什么不能高频小批量写入?

写入模型:

- 每次 INSERT 生成一个新的 part (数据分片)
- 后台线程将小 part 合并为大 part (类似 LSM-Tree compaction)
- 合并有 I/O 和 CPU 开销, 且合并期间占用额外磁盘空间

高频小批量写入的问题:

- 每秒 INSERT 一次, 每次 100 行 -> 每秒产生一个 part
- 后台合并跟不上 part 产生速度 -> part 数量爆炸 (Too many parts 错误)
- 每个 part 都有独立的索引文件、标记文件, 元数据膨胀
- 合并时大量小文件随机 I/O, 效率远低于少量大文件的顺序 I/O

优化方案:

1. 攒批写入: 客户端攒够一批 (如 10000~100000 行) 再 INSERT, 或用 Buffer 表引擎缓冲
2. Buffer 表引擎: 在内存中攒批, 达到阈值后刷入目标 MergeTree 表

```sql
CREATE TABLE events_buffer AS events
ENGINE = Buffer(default, events, 16, 10, 100, 10000, 100000, 1000000, 10000000);
-- 16 个 buffer, 最短 10s / 最长 100s 刷一次, 最少 10000 行 / 最多 100000 行刷一次
```

3. 异步 INSERT (21.11+): `SET async_insert = 1`, ClickHouse 服务端攒批, 多个客户端的小 INSERT 合并为一次写入
4. 分区设计: 分区键不要太细 (按天或按月), 避免同一批数据写入太多分区
5. 写入时排序: 数据按 ORDER BY 键预排序后再写入, 减少合并时的排序开销
6. 避免写入时更新: 用 ReplacingMergeTree 追加新版本, 不要 ALTER UPDATE

### ClickHouse 的分布式查询是如何执行的? 有哪些性能瓶颈?

分布式查询执行流程 (以 `SELECT count() FROM events_dist WHERE date = '2024-01-01' GROUP BY region` 为例):

1. 客户端将 SQL 发送到任意节点 (协调者)
2. 协调者解析 Distributed 表引擎, 确定涉及哪些分片
3. 将查询改写为本地表查询, 发送到各分片:
   `SELECT count() FROM events_local WHERE date = '2024-01-01' GROUP BY region`
4. 各分片在本地并行执行, 返回部分聚合结果
5. 协调者汇总各分片的部分结果, 做最终聚合, 返回客户端

性能瓶颈:

1. 网络传输: 各分片返回中间结果到协调者, 如果中间结果集很大 (如 GROUP BY 基数高), 网络成为瓶颈
   - 优化: 尽量在本地完成聚合, 减少返回数据量; 使用 `distributed_aggregation_memory_efficient` 模式
2. 数据倾斜: 分片键选择不当导致某些分片数据量远大于其他, 查询时间取决于最慢的分片
   - 优化: 用 `sipHash64` 等均匀哈希作为分片键
3. 协调者瓶颈: 所有结果汇聚到一个节点, 高并发查询时协调者 CPU 和内存压力大
   - 优化: 多节点轮询作为协调者; 或用 `distributed_group_by_no_merge` 让客户端自行合并
4. JOIN 的 shuffle: 分布式 JOIN 需要将右表数据广播或按 key shuffle 到各分片, 数据量大时极慢
   - 优化: 表 colocate (相同分片键); 字典替代 JOIN; 全局临时表 (`GLOBAL IN/JOIN`)

### 如何设计 ClickHouse 表结构以支撑高并发查询? 生产中的常见坑?

高并发查询设计:

1. 预聚合: 用物化视图 + SummingMergeTree / AggregatingMergeTree 将明细数据预聚合为指标, 查询直接读聚合表, 避免实时扫描海量明细
2. 投影 (PROJECTION): 为同一张表定义不同排序的副本, 不同查询模式走不同投影

```sql
ALTER TABLE events ADD PROJECTION proj_by_type (
    SELECT * ORDER BY (event_type, event_time)
);
```

3. 合理设置 `max_threads`: 默认用所有 CPU 核, 高并发时每个查询用少量核 (如 4), 避免资源争抢
4. 读写分离: 写入走一个副本, 查询走其他副本
5. 缓存: 对重复查询开启 query cache (23.1+): `SET use_query_cache = true`

常见坑:

1. 分区过多: 按小时分区 + 数据保留一年 = 8760 个分区, 元数据膨胀, 合并效率低; 建议按天或按月
2. ORDER BY 键选了低基数列: 如 `ORDER BY (status)` 只有 5 个值, 索引几乎无效
3. 用 ClickHouse 做高频点查: 单行查询延迟 50~200ms, QPS 上限约几百; 点查场景用 Redis / MySQL
4. 频繁 ALTER UPDATE/DELETE: Mutation 是重写 part, 生产上应尽量避免
5. 不设置 `max_memory_usage`: 单个查询可能吃光内存导致 OOM, 影响其他查询
6. Distributed 表上直接 INSERT: 数据先写本地临时文件再异步分发, 可能丢数据; 应直接写本地表, 或用 `insert_distributed_sync=1`

---

## 六、综合设计题

### 设计一个实时用户行为分析系统, 从数据采集到查询展示的全链路?

需求: 日活千万级 App, 采集用户点击/浏览/购买事件, 支持实时看板 (分钟级延迟) 和历史明细查询.

架构设计:

```text
App SDK / 服务端埋点
        │
Kafka (ODS, 3 副本, 按 user_id 分 64 个 partition)
  topic: user_events_raw
  保留: 7 天 (支持回溯重放)
        │
        ├──> Flink (实时 ETL)
        │      - 清洗: 去重 (event_id 唯一键)、补全 (IP -> 城市)
        │      - 窗口聚合: 1 分钟滚动窗口计算 PV/UV
        │      - 输出到 Kafka DWD topic + ClickHouse 聚合表
        │
        ├──> ClickHouse Kafka Engine (明细入库)
        │      - 物化视图 -> events_detail (MergeTree, 按天分区)
        │      - 物化视图 -> events_hourly (SummingMergeTree, 小时级聚合)
        │
ClickHouse 集群 (3 分片 x 2 副本)
  - events_detail: 明细查询, 保留 90 天 (TTL)
  - events_hourly: 实时看板, 保留 1 年
  - events_daily: 日报/趋势, 永久保留
        │
Grafana / 自研 BI / API Gateway
```

关键设计决策:

1. Kafka 分 64 partition: 支撑消费并行度, 按 user_id 分区保证同一用户事件有序
2. Flink 和 ClickHouse Kafka Engine 双通道: Flink 做复杂计算 (多流 JOIN、窗口), ClickHouse 直接消费做简单入库, 两者消费不同 consumer group 互不影响
3. 去重: Kafka at-least-once + ClickHouse ReplacingMergeTree(event_id) 双重保障
4. 分层存储: 明细 90 天后 TTL 删除, 聚合数据长期保留, 控制存储成本
5. 查询路由: 实时看板查 events_hourly (数据量小, 毫秒响应); 明细分析查 events_detail (按需扫描)

### Kafka 消费积压 (Consumer Lag) 如何排查和解决?

排查步骤:

1. 确认积压程度:

```bash
kafka-consumer-groups.sh --bootstrap-server broker:9092 \
  --describe --group my_group
# 关注 LAG 列, 即 (log-end-offset - current-offset)
```

2. 定位原因:
   - 消费速度 < 生产速度: 消费者处理能力不足
   - 消费者频繁 Rebalance: 查看日志中是否有 `Attempt to heartbeat failed` / `Rebalance`
   - 下游阻塞: 消费者处理逻辑中调用外部 API 超时、数据库慢查询
   - 分区数不足: 消费者数 > 分区数时, 多出的消费者空闲

解决方案:

| 原因           | 解决方案                                                                        |
| -------------- | ------------------------------------------------------------------------------- |
| 消费能力不足   | 增加消费者实例 (不超过 partition 数); 增加 partition 数                         |
| 处理逻辑慢     | 异步化 (消息放入队列, 多线程处理); 批量处理; 优化下游调用                       |
| 频繁 Rebalance | 增大 `session.timeout.ms`; 增大 `max.poll.interval.ms`; 减小 `max.poll.records` |
| 分区数不足     | 扩 partition (注意: 扩分区后按 key 的路由会变化, 顺序性被打破)                  |
| 突发流量       | 临时扩容消费者; 非核心消息降级 (跳过或写入死信 topic 后续处理)                  |

紧急处理 (积压数百万条):

1. 临时新建一个 topic, partition 数翻倍
2. 原消费者改为"转发模式": 只将消息转发到新 topic, 不做业务处理
3. 新消费者消费新 topic, 有足够并行度处理积压
4. 积压消化后恢复正常架构

### ClickHouse 集群扩容和数据迁移怎么做? 如何保证扩容期间服务不中断?

扩容流程 (以从 3 分片扩到 4 分片为例):

1. 新增节点部署 ClickHouse, 加入集群 (修改 remote_servers 配置)
2. 在新节点上创建本地表 (与现有分片结构一致)
3. 修改 Distributed 表的分片配置, 加入新分片
4. 数据再平衡:
   - 方案 A: 新数据自动路由到新分片 (Distributed 表写入时按分片键分配), 旧数据不动 — 简单但数据不均匀
   - 方案 B: 用 `INSERT INTO new_shard SELECT ... FROM old_shard WHERE sipHash64(user_id) % 4 = 3` 手动迁移部分数据 — 均匀但有 I/O 开销
   - 方案 C: 用脚本自动化方案 B (按分片键计算目标分片、批量 INSERT SELECT、校验行数后清理源数据); 注意 ClickHouse 没有"跨分片数据再平衡"的命令——`SYSTEM REBALANCE QUEUE` 只用于副本间复制队列的再平衡, 不迁移分片数据

保证不中断:

- 扩容期间 Distributed 表的读请求: 新分片无数据时返回空, 不影响正确性 (只是新分片暂时没贡献数据)
- 扩容期间写入: 修改 Distributed 配置后新数据自动写入新分片, 旧分片继续接收数据
- 数据迁移: 在低峰期执行, 限制 `INSERT SELECT` 的并发 (`max_threads`) 和速率 (`max_insert_bytes_per_second`)
- 副本保障: 迁移期间如果某分片压力大, 查询可以路由到该分片的副本

缩容 (更复杂):

- 先将待下线分片的数据迁移到其他分片
- 修改 Distributed 配置移除该分片
- 确认无流量后下线节点
- 注意: 缩容前必须确保数据已完整迁移, 否则数据丢失
