---
title: "yukino_taskflow: 条件与定时 AI 任务的分布式执行引擎"
description: "taskflow 单体分布式后端: cron 物化 + 分布式时间轮触发、MySQL 触发器 CDC + outbox 中继、四层幂等防线、TCC 派发事务、openai-go 工具代理与结构化报告、LSM/Raft 本地审计与 MySQL→Redis 状态同步"
local_path: "$HOME/github/yukino.go/apps/taskflow"
---

taskflow 是一个用 Go 编写的单体分布式任务执行服务, 定位是把两类 "AI 任务" 变成可重复、可审计、绝不重复触发的工程对象: 一类是按 cron 表达式周期执行的定时任务, 一类是由业务表插入事件驱动的条件任务。任务定义只包含一段提示词 (prompt) 与可选的模型名, 真正的工作交给一个基于 openai-go 的工具调用代理: 模型按预设提示词多轮调用 `mysql_tool` / `redis_tool` 采集事实数据, 最终产出一份带 YAML frontmatter 的结构化 Markdown 报告。本文聚焦后端 Go 服务, 说明它的分层架构、执行状态机、四层幂等防线、定时物化与分布式时间轮、事务内 CDC 捕获与 outbox 中继、TCC 派发事务、LLM 工具沙箱、报告缓存、集群单例角色协调、状态同步与本地审计账本, 以及它的能力边界。前端是一个 Lit + Tailwind 的亮色工作台, 只消费本文描述的 HTTP API, 不在此展开。

## 定位与问题域

企业里大量 "周期性巡检" 与 "事件驱动审计" 需求有一个共同点: 触发源不可靠 (时钟漂移、节点宕机、消息重投), 但业务上要求 "某个时刻的定时任务、某条记录的条件任务恰好被执行一次"。taskflow 把这个问题拆成三层来解:

| 关注点   | 手段                                                    | 权威来源                  |
| -------- | ------------------------------------------------------- | ------------------------- |
| 触发不丢 | cron 提前物化成执行行 + 分布式时间轮回调 + 监控清扫补发 | MySQL `executions` 行     |
| 触发不重 | 确定性 fire key + 四层幂等防线                          | MySQL `fire_key` 唯一索引 |
| 状态一致 | TCC 派发事务 + 带 tx_id 的条件更新 (CAS)                | MySQL 状态机 + `tx_id`    |

核心设计原则贯穿全文: **MySQL 是执行归属与幂等历史的唯一权威, Redis 只做加速 (快速认领、Stream 队列、时间轮分片、定义缓存、心跳、诊断镜像)**。Redis 丢了一条已发布消息、一个快速认领或一个时间轮条目, 都能由 SQL 侧的恢复路径补偿; 反过来 SQL 的唯一索引与条件更新保证即使 Redis 故障也不会产生第二个执行。

## 架构总览

每个实例都是对等的: 暴露同一套 HTTP API, 同时运行调度器、变更中继、队列消费者与恢复清扫器。没有专门的 "主节点", 只有两个通过一致性哈希选出的单例角色 (migrator、monitor)。

```text
  定时任务定义                         业务表 INSERT
      |                                    |  (事务内 AFTER INSERT 触发器)
      v                                    v
+---------------------+            taskflow_changes
| Migrator (单例角色)  |                   |  Relay: fanout + outbox
| cron 展开 -> 物化    |                   v
| pending 执行行       |            taskflow_outbox
| -> 分布式时间轮注册   |                   |  red_mq (cond topic)
+---------------------+                   |
      |  到点 HTTP 回调                     |
      v  /internal/v1/fire                 v
+----------------------------------------------------------+
| Dispatcher  唯一派发漏斗                                   |
|   bloom 预检 -> Redis SETNX 认领 -> TCC 事务               |
|   (execution_reserve + mq_dispatch)                       |
+----------------------------------------------------------+
      |  ExecCommand -> red_mq (exec topic)
      v
+----------------------------------------------------------+
| Executor  消费者组                                         |
|   awaitSettled -> CAS 认领 queued->running                 |
|   -> LLM Agent (mysql_tool / redis_tool) -> 报告落盘        |
+----------------------------------------------------------+
      |                 |                    |
      v                 v                    v
 Markdown 报告文件   yukino_cache 报告组    MySQL 终态
 (原子写, 按日分目录) (字节预算, 可选 etcd)  (report_body)
```

| 仓库组件                      | 在 taskflow 中的职责                             |
| ----------------------------- | ------------------------------------------------ |
| `libs/yukino_http`            | API 路由与中间件链                               |
| `libs/yukino_cache`           | 报告字节预算缓存、singleflight、可选 etcd 对等环 |
| `components/red_mq`           | 执行/条件 Stream、重试、死信、孤儿消息回收       |
| `components/time_wheel`       | 分布式定时回调 (Redis 分片) 与本地监控 tick      |
| `components/redis_lock`       | 调度器、监控、TCC 恢复锁                         |
| `components/consistent_hash`  | 活跃节点环与单例角色放置                         |
| `components/consistent_cache` | 任务定义缓存、失效与漂移修复                     |
| `components/tcc`              | SQL 后备的 reserve/publish 事务与恢复            |
| `components/timer`            | cron 解析、双 bit 布隆预检、有界手写 worker pool |
| `components/lsm_tree`         | 节点本地执行审计日志 (WAL)                       |
| `components/raft`             | 单成员、节点本地的有序决策账本                   |

启动顺序在 `cmd/taskflow/main.go` 中严格编排: 加载配置 -> 初始化 telemetry 与 sentry -> 连接 MySQL 并在 `GET_LOCK('taskflow:schema:migration')` 保护下 `AutoMigrate` -> 对 schema 内所有合法业务表安装捕获触发器 -> 打开 Redis -> 为每个启用的条件任务补装其监视表的触发器 -> 依次构造幂等服务、布隆过滤器、LLM 代理、LSM 日志、Raft 账本、报告缓存对等、定义缓存、TCC 管理器并注册两个参与者、执行器、条件管线、中继、监控与迁移器 -> 按唯一名称索引幂等种入两个演示定义 (每天 10:00 Asia/Shanghai 的 MySQL 巡检、`risk_records` 插入安全审计) -> 组装 HTTP 服务并按 migrator、monitor、executor、condition、relay 的顺序启动。停机按反序优雅关闭。

## 执行状态机与幂等键

`executions` 表是整个系统的心脏, 状态机如下:

```text
pending -> reserved -> queued -> running -> succeeded
   ^          |                     \----> failed
   |          +--(TCC Cancel 回滚)--+
pending / reserved / queued --(取消)--> cancelled
```

- `pending`: 已物化但尚未派发, 是所有触发路径的统一起点。
- `reserved`: TCC Try 阶段已认领, 行上写入 `tx_id` 与 `claimed_at`。
- `queued`: TCC Confirm 完成, 执行命令已在 MQ 中。
- `running`: 某个执行器消费者用 `tx_id` 条件更新抢到了归属。
- `succeeded` / `failed` / `cancelled`: 终态, 队列重投不会再触发。

幂等的锚点是确定性的 `fire_key` (唯一索引), 不同触发源生成不同形态:

| 触发源                | fire key 形态                                            |
| --------------------- | -------------------------------------------------------- |
| 定时                  | `sched:{taskId}:{plannedUnixSecond}`                     |
| 捕获的插入 (中继路径) | `cond:{taskId}:change:{eventUUID}`                       |
| 手动运行              | `manual:{taskId}:{SHA256(Idempotency-Key)}`              |
| 显式样本测试          | `condtest:{taskId}:{recordId}:{SHA256(Idempotency-Key)}` |

手动与测试路径在请求携带 `Idempotency-Key` 头时用其 SHA256 生成稳定 key (重试复用同一 key 即幂等); 未携带时退化为带随机后缀的一次性 key, 每次请求都是一次新执行。捕获路径用触发器生成的 UUID 作为事件身份, 即使业务表自增 ID 被复用、或同一条记录被插入两次, 也是两个独立事件。

## 幂等的四层防线

`Dispatcher.Dispatch` 是唯一的派发漏斗, 时间轮回调、条件事件、监控补发、手动触发全部走它, 因此幂等语义在所有路径上完全一致。它叠加了四层防线, 从便宜到昂贵:

1. **布隆预检 (最便宜)**。复用 `timer` 组件的 Redis 布隆过滤器, 每个 key 用两个 Murmur3 位位置 (每个日 key 一张 2 MiB 位图), 按 UTC 日分 key (`taskflow:bloom:exec:YYYY-MM-DD`), 同时查询今天与昨天以覆盖跨日延迟重触发。命中只是 "可能见过", 必须回查持久 `fire_key` 行确认状态非 `pending` 才抑制; 未命中绝不短路后续更强的层。错误一律 fail-open。
2. **Redis SETNX 快速认领**。`idem.Service.ClaimFire` 用 `SETNX` + TTL (默认 `claim_ttl_hours` = 72h) 抢占 fire key。抢不到时回查行: 若仍是 `pending` 且 `updated_at` 已超过 5 分钟的 stuck 阈值, 说明上一个认领者派发前崩溃了, 允许接管竞争; 否则判定为重复触发并抑制。
3. **MySQL 唯一索引**。`InsertPending` 用 GORM 的 `OnConflict{DoNothing}` 子句写入 (MySQL 上渲染为唯一键冲突时的 no-op `ON DUPLICATE KEY UPDATE`), 且**不信任驱动返回的 LAST_INSERT_ID**, 一律按 `fire_key` 回查真实行 ID —— 因为 MySQL 在 no-op 时也可能回填 LAST_INSERT_ID。这是最终的持久防线, Redis 认领丢失也不可能产生第二行。
4. **条件更新 (CAS)**。所有状态迁移都是 `WHERE id = ? AND status IN (...)` 的受限 UPDATE, 认领 running 时再叠加 `AND tx_id = ?` (`TransitionOwned`), 返回 `RowsAffected` 判定是否赢得竞争。

一个容易被忽略的细节: 派发事务若内联取消, `ExecutionReserveComponent.Cancel` 会把行回滚到 `pending` 并释放 Redis 认领, 让后续恢复清扫能重新派发; 而 `releaseIfPending` 也会在派发出错时主动释放仍被自己持有的认领, 避免恢复被自己的残留锁阻塞。

## 定时任务: 物化 + 分布式时间轮

`Migrator` 是单例角色, 只有 `registry.IsOwner(SingletonMigrator)` 的节点在拿到 `taskflow:lock:migrator` Redis 锁后才工作。它周期性地把启用的 cron 定义展开成具体执行行:

- 展开窗口为 `[now - OverdueRecoverMinutes, now + MigrateStepMinutes]`, 在任务自身时区内用 `cronx` 逐个求 `Next`。新建的定义不会回填它创建之前的时刻 (`recoverStart` 被抬到 `CreatedAt`)。
- 每个计划时刻生成 `sched:{id}:{unix}` 的执行行, 并快照 prompt/model 到行上 (物化后定义再改也不影响已物化实例)。
- 注册到分布式时间轮 `RTimeWheel`: 回调 URL 指向本进程 `/internal/v1/fire`, 头部携带内部 token、节点 ID 与计划触发时刻。若计划时刻已过期 (例如停机后重启), 实际投递时间被改为 `now + 5s`, 但原始触发时刻保留在行上供审计。
- 时间轮的 Lua pop 是原子的, 回调并发有界; API 侧拒绝未到点的未来执行。

`cronx` 包装 `timer` 的 cron 解析器 (底层 robfig/cron v3): 标准 5 字段表达式, 支持 `*`、列表、区间、步长与 `@daily` 描述符, 星期 0-6 且周日为 0; `Next` 在给定时间的时区里严格求 "之后" 的最近触发点, 五年视野内无匹配返回零值。

到点后时间轮 POST 回调, `handleFire` 校验 fire key 匹配、拒绝未到点执行 (409), 然后进入统一的 `Dispatch` 漏斗。派发前 `Dispatch` 还会对 `sched:` 行重新加载定义: 若定义已删除、被禁用或 cron 已变 (`matchesSchedule` 用当前定义重算触发点不再等于该时刻), 直接把行迁移到 `cancelled`, 防止按陈旧计划执行。

## 条件任务: 事务内捕获与 outbox 中继

条件任务的触发源是业务表的 `INSERT`。taskflow 不用 binlog 订阅, 而是用**事务内 SQL 触发器**捕获, 换取与业务事务完全一致的语义:

- `cdc.EnsureCapture` 在连接级 `GET_LOCK('taskflow:capture:{table}')` 保护下, 读取 `information_schema.columns`, 为 `INSERT` (取 `NEW`) 与 `DELETE` (取 `OLD`) 各生成一个 `AFTER ... FOR EACH ROW` 触发器, 把整行序列化成 `JSON_OBJECT` 写入 `taskflow_changes`, 事件 key 用 `UUID()`, 时间戳用 `UTC_TIMESTAMP(6)`。二进制/blob/geometry/bit 列用 `HEX()` 包裹。触发器名由 `sha256(table:op)` 前缀派生, 已存在则跳过, 保证幂等安装。
- 因为触发器与业务变更同事务, **回滚会连带删除变更记录**; 直接 SQL 插入也能被捕获; 载荷在被其他参与者更新或删除之前就已固化。
- 表名需通过白名单校验 (简单标识符, 排除 `taskflow_*` 前缀与 `condition_tasks`/`scheduled_tasks`/`tcc_tx_records`/`mq_dead_letters` 等控制表), 条件任务的监视表还额外排除 `executions`, 防止递归生成任务。

捕获之后由 `Relay` 中继, 它每秒 `Drain` 一次 (每轮两段各最多处理 100 条), 都用 `SELECT ... FOR UPDATE SKIP LOCKED` 让多副本并行处理互不冲突的行:

1. **fanout**: 取一条 `processed_at IS NULL` 的变更, 对每个 `enabled` 且 `created_at <= occurred_at` 的条件任务, 生成 `cond:{taskId}:change:{eventUUID}` 的 pending 执行行与一条 outbox 记录, 最后标记变更已处理。整个动作在一个事务里, 执行行与 outbox 同生共死。
2. **publish**: 取一条 `published_at IS NULL` 的 outbox, 用 5s 超时 `SendMsg` 到条件 topic, 成功后标记已发布。若在 XADD 之后、提交之前崩溃, 会重投同一 key —— 由唯一执行 key 与 CAS 吸收。

关键取舍: 中继**绝不推进时间戳游标**, 因为自增 ID 可能乱序提交; 它靠 "显式未处理行" 排空。订阅匹配用任务定义行的 `created_at <= occurred_at`, 而定时/条件任务行的 `created_at` 在 `BeforeCreate` 钩子里由 `SELECT UTC_TIMESTAMP(6)` 从数据库取 (而非主机时钟), 与触发器写入的 `occurred_at` 同源同精度, 避免时钟偏移或毫秒舍入让刚创建的任务漏掉并发插入的变更事件。

条件管线 `ConditionPipeline` 消费条件 topic。对带有 `execution_id` 的中继事件, 它校验归属后直接 `Dispatch`; 对直接发布的事件, 它会**重新读取权威行** (`GetRiskRecord`) 再构造执行, 保证分析反映的是落库状态而非发布者视图。消费者与执行器一样挂死信邮箱、孤儿回收与重试上限。

## 派发漏斗: TCC 双参与者事务

`Dispatch` 通过 `tcc.TXManager` 发起一个两参与者事务, 把 "预留执行行" 与 "发布 MQ 命令" 绑定成一个原子单元:

```go
manager.Transaction(ctx,
    &tcc.RequestEntity{ComponentID: ComponentExecutionReserve, Request: {...}},
    &tcc.RequestEntity{ComponentID: ComponentMQDispatch,       Request: {...}},
)
```

| 参与者                      | Try                                                                           | Confirm                                                           | Cancel                                             |
| --------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------- |
| `ExecutionReserveComponent` | `pending -> reserved`, 写 `tx_id`/`claimed_at`; 未命中则校验是否本事务重入    | `reserved -> queued` (带 `tx_id`), 对 queued/running/终态幂等 ack | `reserved -> pending`, 清 `tx_id`, 释放 Redis 认领 |
| `MQDispatchComponent`       | 发布 `ExecCommand{execution_id, tx_id, fire_key, trace_carrier}` 到执行 topic | no-op (Stream 条目已持久)                                         | no-op (执行器按 tx_id 与状态校验归属)              |

TCC 的持久层 `TXStore` 落在 `tcc_tx_records` 表: `CreateTX` 写入各参与者的 Try 状态 JSON, `TXUpdate` 用 `SELECT ... FOR UPDATE` 串行化并拒绝重复落定一个已 settled 的参与者, `TXSubmit` 用 CAS 把事务从 hanging 迁到 successful/failure 且幂等。`TXManager` 配 30s 超时与 5s 监控 tick, 悬挂事务由恢复路径补偿, 参与者操作全部幂等, Confirm/Cancel 都带归属 tx_id。

之所以 MQ 参与者的 Confirm/Cancel 可以是 no-op, 是因为**执行状态在发布之前就已存在**: 即使 Redis 丢掉了已发布的队列条目, 行仍是 `queued`, 监控补发能重建命令; 即使消息先于 reserve 落库到达, 执行器也会等待而不是误判。

## 执行器: 消费、认领与终态落盘

`Executor` 为每个节点启动 `cfg.Executor.Workers` 个 `red_mq` 消费者, 共享一个消费组, 消费者 ID 形如 `{node}-exec-{i}`。每个消费者挂 `WithMaxRetryLimit`、`WithReceiveTimeout`、`WithHandleMsgsTimeout`、`WithAbandonedMessageRecovery` (处理超时 + 60s) 与死信邮箱。毒消息超过重试上限进入 `mq_dead_letters` 表, 绝不被静默丢弃。

一条命令的处理链路:

1. 反序列化 `ExecCommand`, 从 `trace_carrier` 恢复 W3C 上下文, 打开 `execution.run` span, 派生 `Executor.TimeoutSeconds` 的运行上下文。
2. **`awaitSettled` 等待派发事务可见**。TCC 的 Try 阶段并发执行参与者, MQ 命令可能先于 reserve UPDATE 落库; 若不等待, 执行器会把合法命令误判为陈旧。它最多重试 12 次、每次 500ms, 按行状态分支: `pending` 且 `tx_id` 为空 -> 继续等; `pending` -> 已被回滚/他人重预留, 消费不执行; `tx_id` 不匹配 -> 陈旧命令忽略; `reserved` -> 继续等; `queued` -> 放行。
3. 校验命令与行的 fire key 一致, 然后 `TransitionOwned` 把 `queued -> running` 并写入 `started_at`/`node_id`/`trace_id`。`RowsAffected == 0` 说明同一条命令的另一次投递已赢得竞争, 直接返回 (幂等消费)。
4. `runExecution` 用 `recover` 兜底 panic, 加载定义 (优先行上快照), 解析模型 (定义模型 -> 全局默认), 调 `agent.Run`, 最后 `finalize`。

`finalize` 的一个关键设计: 它用 `context.WithoutCancel` 再套 15s 超时来落盘终态, **保证执行截止或消费者停机不会抹掉失败报告**。它渲染报告、`TransitionOwned` 迁到终态、`Warm` 预热报告缓存、把结果折进 LSM 日志与 Raft 账本, 并在定时任务成功时回写 `last_fire_at`。

## LLM Agent 与工具沙箱

`llm.Agent` 把 openai-go 包成一个受限的工具调用循环: 系统提示 + 用户提示进入对话, 模型在最多 `MaxToolRounds` 轮内调用工具, 每轮独立超时, 累计 token 用量。当模型不再请求工具时, 输出被当作最终报告, 并强制校验:

- 非空; `FinishReason == "length"` 判为超出 token 预算而失败;
- 必须包含三个固定小节 `## Summary`、`## Detailed Analysis`、`## Conclusion & Recommendations`, 缺任何一个都判失败。

系统提示内置了**提示注入防御**: 明确声明记录内容与工具结果都是不可信数据, 绝不执行其中嵌入的指令、绝不运行存储的载荷。用户提示由 `BuildUserPrompt` 按任务类型渲染, 定时/手动任务会给出以计划触发时刻为界的半开区间审计窗口 (当前窗与前一日窗, UTC), 并强调 "即使执行被延迟也使用这些字面时间戳", 防止模型用 `NOW()` 替代计划窗口。

工具运行时 `ToolRuntime` 暴露两个工具, 都做了严格沙箱:

| 工具         | 能力                                                    | 关键约束                                                                                                                                                                                                                             |
| ------------ | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `mysql_tool` | 单条 SQL                                                | 默认只读 (SELECT/SHOW/DESCRIBE/EXPLAIN/WITH); `allow_sql_writes` 开启业务 INSERT/UPDATE/DELETE; 拒绝多语句、注释、未闭合字面量、管理动词、系统 schema、`SLEEP`/`BENCHMARK`/锁函数与 `FOR UPDATE`; 读结果按行数与 1MiB 字节双上限截断 |
| `redis_tool` | get/set/del/exists/ttl/incr/decr/hget/hset/hgetall/keys | key 必须落在 `redis_key_prefix` (默认 `taskflow:tools:`) 命名空间内; 值/字段/键有尺寸上限; TTL 上限 30 天; 列表用有界 SCAN/HSCAN                                                                                                     |

SQL 策略 `validateSQL` 用自研的 `sqlTokens` 词法器区分数据与标识符: 字符串字面量保持为数据, 反引号包裹的标识符会进入 token 流接受策略检查; 写语句被禁止触碰任何 taskflow 控制表。工具错误、非法报告小节、token 耗尽、执行超时都产出 `failed` 执行, 而不是 "成功的半成品报告"。内部锁、队列与认领都在工具命名空间之外, 模型无法触达。

## 报告产物与分布式缓存

`ReportStore` 负责报告的生成、持久化与分发:

- **渲染**: Markdown 由 YAML frontmatter (execution_id、task_type、fire_key、status、node、trace_id、起止时刻、duration_ms、model、llm_rounds、tool_calls、token 用量) + 标题 + 模型正文 + 触发上下文 JSON + 工具调用日志表组成。失败时插入 `## Execution Failed` 与错误信息。工具日志表对 `|` 转义、对 rune 安全截断, 不会切断多字节字符。
- **落盘**: 按 `reports/YYYY-MM-DD/exec-{id}.md` 分目录, 用临时文件 + `Sync` + `Rename` 原子写入。报告体同时写入执行行的 `report_body`, 因此任何节点都能从 MySQL 供报告, 即使本地文件缺失。
- **缓存**: 报告进入 `yukino_cache` 的报告 Group, 按字节预算 (`report_cache_bytes_mib`) 与 TTL (`report_expire_seconds`) 管理, key 形如 `exec:{id}`。Getter 回源到执行行的 `report_body`, 空则报 "report not ready"。配置了 `etcd_endpoints` 时, `OpenReportPeers` 启动 `taskflow.reports` 缓存服务并注册 etcd 对等环, 未命中可跨节点 read-through; 未配置则是单节点模式。终态落盘成功后 `Warm` 主动回填缓存。

任务定义走另一套缓存 `consistent_cache`: 定义读取优先命中 Redis, miss 后从 DB 读并经 `PutWhenEnable` 回填 (写入窗口内的禁回填标记会抑制旧读者回填)。API 更新路径先设置短 TTL 禁回填标记并删除缓存, 再做零值安全的显式列映射更新 (如 `enabled=false`), 标记靠 TTL 自然过期; 组件本身还提供带 "延迟重新启用" 的完整 `Service.Put` 协议 (禁标记 -> 删缓存 -> 写库 -> 独立短 context 中延迟缩短标记), taskflow 的定义创建走直接 DAO 插入, 不经过该协议。监控清扫还会做**漂移修复** (`SyncDrift`): 对每个缓存条目比对其与 DB 行的序列化, 不一致就在短禁用标记下删除, 让下次读从权威源重建, 保证旁路写入 (迁移器簿记、直接 SQL) 造成的漂移不会存活超过一个清扫周期。

## 集群协调: 一致性哈希单例角色

`SingletonRegistry` 用 `consistent_hash` 把两个单例角色 key (`taskflow:singleton:migrator`、`taskflow:singleton:monitor`) 映射到环上唯一节点, 并维护环成员:

- 节点注册时加入环并启动心跳循环: 每 15s 向 `taskflow:node:{id}` 写一次心跳 (TTL 45s), 同时驱逐心跳已过期的死节点。
- `IsOwner(roleKey)` 判断本节点是否拥有角色。它在环出错时**fail-open**: 调用方随后仍会抢 Redis 锁, 所以 fail-open 不会导致双执行, 而 fail-closed 反而可能在 Redis 抖动时让整个集群停摆。
- 于是 migrator/monitor 的实际互斥由 "一致性哈希选主 + Redis 锁兜底" 双层保证: 哈希把正常工作负载稳定地放到一个节点, 锁在哈希视图短暂不一致时兜底。

归属判定用的 Redis 读始终打到配置的主节点; 副本只被监控、不参与归属决策, 避免读到陈旧状态做出错误的归属判断。

## 监控清扫与 MySQL → Redis 状态同步

`Monitor` 在每个节点运行, 但只有 `SingletonMonitor` 的属主真正清扫。它由进程内时间轮 (`NewTimeWheel(32, 5s)`) 每 30s 驱动一次, 单次清扫 50s 超时, 拿 `taskflow:lock:monitor` (55s) 后依次执行, 逐行工作跑在有界 `timer` worker pool 上并 `WaitGroup` 等待, 保证一次清扫不超出锁预算:

| 步骤                   | 作用                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------- |
| `failStuckRunning`     | 把 running 超过 `stuck_running_minutes` 的行判为 failed (节点崩溃或 LLM 卡死)         |
| `redispatchOverdue`    | 把时间轮回调从未到达的过期 pending 行重新送入派发漏斗                                 |
| `republishStuckQueued` | 为消息丢失/被提前消费的 queued 行重发命令, 保留原 `tx_id`, 执行器的 tx 校验使重投幂等 |
| `syncData`             | MySQL -> Redis 同步: 执行状态镜像 + 定义缓存漂移修复                                  |
| `publishStats`         | 汇总当日执行统计、启用任务数、镜像大小、角色属主, 写入 Redis 供仪表盘 API             |

状态镜像 `SyncExecutionMirror` 是 "最终一致、带版本、分页、独立保留" 的诊断结构, 明确**不**用于执行归属:

- 用持久游标 `{last_id, max_id, prune}` 反复扫描一个**固定的 ID 边界** (`max_id` 一次性取 `MAX(id)`), 新插入不会饿死旧状态变更; 批次失败不推进游标, 重放安全; 扫完一轮归零再来, 因此会反复回访旧行。
- 写入用 Lua 做版本校验: 若镜像里已有 `updated_at` 更新的版本则放弃本次写, 保证单调。
- 清理用 Lua compare-and-HDEL, 只删除与本次检视完全一致的终态旧版本, 且终态条目超过 7 天才剪除。

## 节点本地审计: LSM 日志与 Raft 账本

两套节点本地结构为幂等与决策提供审计证据, 都是 best-effort、绝不阻塞主流程:

- **LSM 日志** (`journal`): 基于 `lsm_tree` 存储引擎, 每条记录先写 WAL 再进 memtable, 后台 flush 成分层 SSTable 并压缩, 因此 fire key -> 执行的映射在节点崩溃重启后仍在。`RecordDispatch` 在派发时落 `dispatched` 条目, `RecordOutcome` 在终态时折叠状态 (缺失条目会就地补建), `Lookup` 供监控 API 按 fire key 查询。`journal.Open` 对空目录返回 nil store (合法 no-op), 但配置修复会把空的 `journal.dir` 默认为 `./data/journal`, 因此实践中默认启用。
- **Raft 账本** (`consensus`): 内嵌 `raft` 核心作为**单成员、节点本地**的有序提交日志, 每次派发与完成都 `Propose` 一条 KV, 经 leader 选举、日志复制、Ready/Advance 驱动落到内存状态机, 保留最近条目、term、commit index 供监控 API 展示。它纯粹是诊断用途 —— **执行归属由 MySQL 协调, 不由这个账本决定**, 它也不替代数据库复制。

## 可观测性

- **分布式追踪**: OpenTelemetry 贯穿 HTTP、派发、MQ、执行、LLM 与工具各跳, W3C traceparent 通过 HTTP 头与 MQ 载荷里的 carrier 传播。导出器可配 `none`/`stdout`/`file` (JSONL), 采样率可配。报告 frontmatter 里带 trace_id, 便于从报告反查链路。
- **错误上报**: sentry-go 在配置 `SENTRY_DSN` 时捕获执行错误与 panic, 事件带组件、trace_id 等结构化 tag; DSN 为空时 SDK 处于 noop, 本地开发安静而埋点仍在。
- **HTTP 中间件**: Trace 中间件开服务端 span 并回写 `X-Trace-Id`; SentryRecover 把 panic 转 500 并上报; AccessLog 记录结构化访问日志; BodyLimit 限 1MiB 并加 `nosniff`/`no-store`。
- **前端遥测**: `/api/v1/telemetry/log` 作为前端 sentry SDK 的 dsn 接收事件, 追加写入 JSONL 文件。
- **集群仪表盘 API**: 暴露节点成员与角色属主、执行统计、报告缓存统计、死信、Raft 状态、LSM 日志查询、状态镜像、存储健康 (副本 lag、pending change/outbox 计数、捕获表清单)。

## API 能力面

HTTP 服务由 `yukino_http` 组装, 中间件链为 CORS -> Trace -> SentryRecover -> AccessLog -> BodyLimit。公开端点 (`/health`、`/ready`、`/telemetry/log`) 免鉴权, 其余 `/api/v1` 端点要求 Bearer token (常量时间比较 SHA256), 内部回调 `/internal/v1` 要求内部 token, 未配置 token 时退化为仅允许回环地址。

| 分组     | 端点                                                                             | 说明                                    |
| -------- | -------------------------------------------------------------------------------- | --------------------------------------- |
| 概览     | `GET /overview` `/health` `/ready`                                               | 聚合统计、存活、就绪 (探测 SQL + Redis) |
| 定时任务 | `GET/POST /scheduled-tasks`, `GET/PATCH/DELETE /:id`, `POST /:id/trigger`        | CRUD + 手动触发 (支持 Idempotency-Key)  |
| 条件任务 | `GET/POST /condition-tasks`, `GET/PATCH/DELETE /:id`, `POST /:id/test`           | CRUD + 显式样本测试                     |
| 执行     | `GET /executions`, `GET /:id`, `GET /:id/report`, `POST /:id/cancel`             | 列表/详情/报告 (text/markdown)/取消     |
| 风险记录 | `GET/POST /risk-records`                                                         | 插入样本记录, 触发持久条件事件          |
| 监控     | `GET /monitor/{nodes,stats,cache,dead-letters,consensus,journal,mirror,storage}` | 集群与诊断只读视图                      |
| 内部     | `POST /internal/v1/fire`, `GET /internal/v1/ping`                                | 时间轮回调与健康                        |

取消仅允许从 `pending`/`reserved`/`queued` 迁到 `cancelled`, 已 running 或终态的执行返回 409。报告端点经缓存 read-through 返回 Markdown。创建条件任务会为其监视表安装捕获触发器, 因此需要 schema 迁移与 TRIGGER 权限。

## 配置与部署形态

配置是单一 YAML 源, 机密 (MySQL 密码、LLM key、Sentry DSN、API token) 通过 `*_env` 字段名从环境变量解析, 值内支持 `${VAR}` 展开。MySQL DSN 固定 `loc=UTC` 并把会话时区设为 `+00:00`, 应用内所有时间以 UTC 持久化。主要段落: `server`、`node`、`mysql` (含 `replica_addresses`)、`redis` (`mode` 支持 standalone/sentinel/cluster)、`llm`、`scheduler`、`mq`、`executor`、`cache`、`reports`、`journal`、`consensus`、`sentry`、`telemetry`。Redis standalone、Sentinel 与 Cluster 客户端共享同一配置连接池, 手写组件全部复用。

Docker 一键部署: 基础 compose 起前端 Nginx 容器 (8080, 反代 `/api` 到后端 8090) + 单后端 + MySQL 8.4 + Redis 7; 集群叠加层 (`docker-compose.cluster.yml`) 增加三节点 etcd (报告缓存发现)、MySQL GTID 副本 + 复制初始化、两个 Redis 副本 + 三 Sentinel、第二个后端实例, 并把前端 Nginx 换成对两个后端做负载均衡的配置。节点日志与 trace 文件用独立卷, 报告用共享卷且同时落 MySQL, 因此任意节点都能供报告。`deployment/` 下提供 MySQL 复制与 Redis Sentinel 的初始化脚本及集群 Nginx 配置。

## 保证边界与适用场景

taskflow 提供的核心保证是: **一条持久执行行只会被认领并执行一次**。由此推出几条明确的边界:

- 进程崩溃或外部响应不确定时, 无法保证 "一定完成", 只能保证 "不会重复"; 悬挂的 pending/queued 由监控补偿, 卡死的 running 被判失败但不会自动重跑。
- 运维要求的 "重新跑一次" 是一次新执行 (新的请求 key), 不是对旧行的重试。
- 还原一个不含执行历史的数据库备份, 也会一并丢掉幂等历史, 因此备份必须把执行 key、事务记录、变更事件与 outbox 状态同源数据一起保留。
- 部署不提供 MySQL 多主写入与自动主提升, MySQL 主从切换是运维显式操作; Redis Sentinel 在集群部署里会自动完成主提升。提升之后, 应用靠 SQL 的 pending/queued 行与 outbox 恢复丢失的协调数据。

适用场景: 需要把 "周期巡检 + 事件驱动审计" 交给 LLM 自动产出结构化报告, 且对触发幂等、可审计、可恢复有硬性要求的企业内部系统; 希望复用一套手写分布式组件 (时间轮、TCC、一致性哈希、Stream MQ、LSM、Raft) 而不引入重型外部调度器的场景。不适合的场景: 需要毫秒级精确定时、需要跨数据中心强一致、或把执行归属寄托在 Redis/账本而非关系型数据库上的架构。

验证方面, 单测 `go test -race ./...` 之外, 带 `integration` 标签的集成测试在隔离的数据库与 Redis 命名空间里覆盖回滚捕获、直接 SQL 增删、并发中继/派发/消费、32 路重复投递、超时终态、Redis 发布故障与恢复、孤儿 pending 消息、布隆成员与内存上限、跨页状态对账等场景; 模型协议测试用进程内 OpenAI 兼容 fixture, 无需付费 API key。

本文所组装的九个手写分布式组件 (redis_lock、consistent_hash、consistent_cache、red_mq、tcc、time_wheel、timer、lsm_tree、raft) 各自的设计原理、关键数据结构与适用边界, 见 [yukino_components](yukino-components)。
