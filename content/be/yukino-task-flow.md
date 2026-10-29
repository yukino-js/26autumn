---
title: "yukino_taskflow: 条件与定时 AI 任务的分布式执行引擎"
description: "taskflow 单体分布式后端: cron 物化 + 分布式时间轮触发、MySQL 触发器 CDC + outbox 中继、四层幂等防线、TCC 派发事务、openai-go 工具代理与结构化报告、LSM/Raft 本地审计与 MySQL→Redis 状态同步; 并附组件教程: 从分布式难点入门, 逐一拆解 red_mq、time_wheel、redis_lock、consistent_hash、consistent_cache、yukino_cache、tcc、timer、lsm_tree、raft 十个本地 replace 组件的问题域、实现入口与开发坑, 给出源码阅读路线与故障实验"
local_path: "$HOME/github/yukino.go/apps/task_flow"
---

taskflow 是一个用 Go 编写的单体分布式任务执行服务, 定位是把两类 "AI 任务" 变成可重复、可审计、绝不重复触发的工程对象: 一类是按 cron 表达式周期执行的定时任务, 一类是由业务表插入事件驱动的条件任务。任务定义只包含一段提示词 (prompt) 与可选的模型名, 真正的工作交给一个基于 openai-go 的工具调用代理: 模型按预设提示词多轮调用 `mysql_tool` / `redis_tool` 采集事实数据, 最终产出一份带 YAML frontmatter 的结构化 Markdown 报告。本文分两部分: 第一部分聚焦 `apps/task_flow/server` 这个 Go 服务本身, 说明它的仓库布局、执行状态机、四层幂等防线、定时物化与分布式时间轮、事务内 CDC 捕获与 outbox 中继、TCC 派发事务、LLM 工具沙箱、报告缓存、集群单例角色协调、状态同步与本地审计账本, 以及它的能力边界; 第二部分是一份面向分布式系统新手的组件教程, 从单机并发与分布式难点讲起, 逐一拆解 `server/go.mod` 本地 `replace` 引入的十个组件 (red_mq、time_wheel、redis_lock、consistent_hash、consistent_cache、yukino_cache、tcc、timer、lsm_tree、raft) 的问题域、实现入口与开发坑, 并给出源码阅读路线与故障实验。前端 `client/` 是一个 Lit 3 + Tailwind CSS 4 + Vite 的工作台, 只消费本文描述的 HTTP API, 不在此展开。

# 第一部分: 执行引擎深度解析

## 定位与问题域

企业里大量 "周期性巡检" 与 "事件驱动审计" 需求有一个共同点: 触发源不可靠 (时钟漂移、节点宕机、消息重投), 但业务上要求 "某个时刻的定时任务、某条记录的条件任务恰好被执行一次"。taskflow 把这个问题拆成三层来解:

| 关注点   | 手段                                                    | 权威来源                  |
| -------- | ------------------------------------------------------- | ------------------------- |
| 触发不丢 | cron 提前物化成执行行 + 分布式时间轮回调 + 监控清扫补发 | MySQL `executions` 行     |
| 触发不重 | 确定性 fire key + 四层幂等防线                          | MySQL `fire_key` 唯一索引 |
| 状态一致 | TCC 派发事务 + 带 `tx_id` 的条件更新 (CAS)              | MySQL 状态机 + `tx_id`    |

核心设计原则贯穿全文: **MySQL 是执行归属与幂等历史的唯一权威, Redis 只做加速 (快速认领、Stream 队列、时间轮分片、定义缓存、心跳、诊断镜像)**。Redis 丢了一条已发布消息、一个快速认领或一个时间轮条目, 都能由 SQL 侧的恢复路径补偿; 反过来 SQL 的唯一索引与条件更新保证即使 Redis 故障也不会产生第二个执行。

## 仓库布局与启动装配

`apps/task_flow` 目录结构:

```text
apps/task_flow/
├── README.md / AGENTS.md / .env.example
├── docker-compose.yml              # 单机: mysql + redis + server + client
├── docker-compose.cluster.yml      # overlay: etcd x3、MySQL 副本、Redis Sentinel、第二 server
├── docs/architecture.md            # 项目自带架构文档
├── docs/operations.md              # 项目自带运维文档
├── deployment/
│   ├── mysql-replication.sh        # GTID 复制初始化 (mysqldump + CHANGE REPLICATION SOURCE)
│   ├── redis-sentinel.sh           # Sentinel 配置生成
│   └── nginx.cluster.conf          # least_conn 双节点反向代理
├── client/                         # Lit 3 + Tailwind 4 + Vite 工作台, Playwright e2e
└── server/
    ├── cmd/task_flow/main.go       # 唯一入口, flag -config 默认 conf.yml
    ├── conf.yml / conf.example.yml / conf.docker.yml / conf.cluster.yml
    ├── Dockerfile                  # build context 是仓库根, COPY 全部 replace 模块
    └── internal/
        ├── cdc/        capture.go, relay.go          # 触发器捕获 + outbox 中继
        ├── conf/       conf.go                       # YAML 配置、默认值与校验
        ├── consensus/  ledger.go                     # 单成员 Raft 诊断账本
        ├── cronx/      cron.go                       # robfig/cron 包装
        ├── dao/        dao.go                        # 状态机更新、任务 CRUD、对象适配
        ├── engine/     migrator / dispatcher / components / executor / condition
        │               monitor / registry / report / tccstore / definitions
        │               cache / deadletter / prompts
        ├── idem/       idem.go, bloom.go             # Redis SETNX 认领 + 每日 Bloom
        ├── journal/    journal.go                    # lsm_tree 本地审计
        ├── llm/        agent.go, tools.go, sql_policy.go
        ├── model/po/   po.go                         # 八张表的 GORM 模型
        ├── obsx/       sentry.go
        ├── server/     server.go, middleware.go, api.go
        ├── storage/    redis.go, mirror.go, status.go
        └── telemetry/  telemetry.go                  # OpenTelemetry 初始化
```

`server/go.mod` (module `github.com/hangtiancheng/yukino.go/apps/task_flow/server`, go 1.26.4) 用 11 条 `replace` 把全部基础组件指向仓库内源码, 这正是第二部分教程的对象:

| replace 模块                  | 在 taskflow 中的角色                   |
| ----------------------------- | -------------------------------------- |
| `components/red_mq`           | exec/cond 两个 Redis Streams 主题      |
| `components/time_wheel`       | 分布式时间轮 (分钟级 ZSET + HTTP 回调) |
| `components/redis_lock`       | migrator/monitor/tccstore/哈希环的锁   |
| `components/consistent_hash`  | 单例角色 (migrator/monitor) 归属       |
| `components/consistent_cache` | 任务定义缓存                           |
| `components/tcc`              | 派发事务框架                           |
| `components/timer`            | cron 解析、Bloom、worker 池、Murmur3   |
| `components/lsm_tree`         | 节点本地审计 journal                   |
| `components/raft`             | 节点本地诊断 ledger                    |
| `libs/yukino_cache`           | 报告分组缓存 (可带 etcd/gRPC peers)    |
| `libs/yukino_http`            | HTTP 路由与中间件                      |

关键三方依赖: `openai-go v1.12.0`、`go-redis v9.23.0`、`sentry-go v0.50.0`、`gorm`、`robfig/cron v3` (经 timer 间接引入)、`twmb/murmur3`、etcd client v3 (经 yukino_cache 间接引入)。

`main.go` 的装配顺序就是一条依赖链, 读懂它等于读懂整个服务:

1. `flag.String("config", "conf.yml")` 加载配置, `conf.Load` 对 YAML 标量做 `${VAR}` 展开 (`expandEnv`), 再由 `repair()` 补齐默认值、`Validate()` 校验。
2. `telemetry.Setup` 初始化 OTel (stdout/file exporter), `obsx.Setup` 初始化 Sentry (无 DSN 时为 noop)。
3. 打开 MySQL: 库不存在则 `CREATE DATABASE`; 用 `GET_LOCK('task_flow:schema:migration', 30)` 包住 `po.AutoMigrate` (八张表), 保证多节点同时启动时 DDL 串行。
4. `cdc.EnsureDatabaseCapture` 扫描当前 schema 的可捕获基表, 安装缺失的 INSERT/DELETE 触发器。
5. `storage.OpenRedis` 按 standalone/sentinel/cluster 模式构造 UniversalClient 并 Ping。
6. `dao.New` 后, 为每个 enabled 的条件任务调用 `cdc.EnsureCapture` 补装触发器; `storage.NewFleet` 打开只读副本连接池。
7. `idem.New` (SETNX 认领, TTL 取 `claim_ttl_hours`) 与 `idem.NewSharedBloomFilter` (timer bloom + 两个 Murmur3 哈希位)。
8. `llm.NewAgent` 构造 openai-go 客户端与工具运行时。
9. `journal.Open` (lsm_tree, 目录为空串则禁用)、`consensus.NewLedger` (单成员 raft)。
10. `engine.OpenReportPeers`: 配置了 `etcd_endpoints` 才启动 yukino_cache gRPC server + ClientPicker; `yukino_cache.NewGroup` 注册报告分组; 有 peers 时 `RegisterPeers`。
11. 两份 `consistent_cache.Service` (sched/cond 定义缓存) + MySQL DAO 适配 + Redis 缓存。
12. redis_lock client、red_mq producer (`WithMsgQueueLen`)、`time_wheel.NewRTimeWheel`。
13. `chredis.NewRedisHashRing("task_flow:nodes", ...)` + `consistent_hash.NewConsistentHash` (FNV 哈希器 + `engine.RingMigrator`); `SingletonRegistry.Register` 心跳并把自己加入环。
14. `engine.NewTXStore` + `tcc.NewTXManager(WithTimeout(30s), WithMonitorTick(5s))`; `NewDispatcher`、`NewReportStore`、`NewDeadLetterMailbox`; 注册两个 TCC 参与者 `execution_reserve` 与 `mq_dispatch`。
15. `NewExecutor`、`NewConditionPipeline`、`cdc.NewRelay`、`NewMonitor`、`NewMigrator`; `seedDemoTasks` (OnConflict DoNothing)。
16. `server.NewService/Build` 组装路由, `http.Server` (ReadHeaderTimeout 5s) 启动; 依次 `migrator.Start()`、`monitor.Start()`、`executor.Start(workers)`、`condition.Start(workers)`、`relay.Start(ctx)`。
17. 收到 SIGINT/SIGTERM 后按相反顺序停止, HTTP 用独立 shutdown context 排空。

种子演示任务有两个: 定时任务 "Daily MySQL Data Inspection" (cron `0 10 * * *`, 时区 Asia/Shanghai) 与条件任务 "Insert Record Security Audit (XSS Risk)" (监听 `risk_records` 表)。

## 数据模型与执行状态机

`po.AutoMigrate` 管理八张表:

| 表                  | 作用与关键列                                                                                                                                                                                                               |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scheduled_tasks`   | `name` (128, unique)、`cron_expr`、`timezone`、`prompt` (mediumtext)、`model`、`enabled` (索引)、`last_fire_at`、`next_fire_at`; `created_at` 为 `datetime(6)`, BeforeCreate 钩子用 `SELECT UTC_TIMESTAMP(6)` 取数据库时钟 |
| `condition_tasks`   | `table_name`、`event_type` (默认 `mysql_insert`)、`prompt`、`model`、`enabled`                                                                                                                                             |
| `executions`        | 状态机主表, 见下                                                                                                                                                                                                           |
| `risk_records`      | 演示业务表, 条件任务的示例数据源                                                                                                                                                                                           |
| `mq_dead_letters`   | red_mq 死信信箱落库                                                                                                                                                                                                        |
| `tcc_tx_records`    | TCC 事务记录: `status` (索引)、`component_try_statuses` (text JSON)                                                                                                                                                        |
| `task_flow_changes` | CDC 事件: `event_key` (64, unique, 触发器内 `UUID()`)、`table_name` + `occurred_at` 复合索引、`operation`、`record_json` (JSON)、`processed_at` (索引), `occurred_at` 为 `datetime(6)`                                     |
| `task_flow_outbox`  | 待发布意图: `event_key` (191, unique)、`payload` (mediumtext)、`published_at` (索引)                                                                                                                                       |

`executions` 的关键列: `fire_key` (size 191, uniqueIndex, 幂等锚点)、`tx_id` (64, 索引, 指向 TCC 事务)、`status` (索引)、`task_type`/`task_id`/`task_name`、`fire_at` (索引)、`trigger_info`/`prompt_snapshot`/`report_body` (mediumtext)、`model_snapshot`、`report_path`、`report_excerpt` (text)、`error` (text)、`trace_id` (64, 索引)、`node_id`、`claimed_at`/`started_at`/`finished_at`、`tool_calls`、`tokens_prompt`/`tokens_output`。任务类型常量: `scheduled`、`condition`、`manual`; 事件类型常量: `mysql_insert`。

状态机与合法迁移 (全部由 `dao.Transition` / `dao.TransitionOwned` 的 `WHERE id = ? AND status IN (...)` 条件更新驱动, 并检查 `RowsAffected`):

```text
pending ──(TCC Try 预留)──▶ reserved ──(Confirm)──▶ queued ──(CAS 抢占)──▶ running ──▶ succeeded / failed
   ▲                            │                     ▲                       │
   └──(TCC Cancel 回退)─────────┘                     │                       └── (超时由 monitor 标记 failed)
                                                      └── 卡住时 monitor 用原 tx_id 补发命令, 状态不变

pending / reserved / queued ──(cancel API)──▶ cancelled
```

- `InsertPending`: `Clauses(clause.OnConflict{Columns: fire_key, DoNothing})` 插入后再按 `fire_key` 重新 SELECT, 返回权威 ID。冲突时 `created=false` 但 ID 仍然正确 — 这是 "同一 fire key 只有一行" 的最终保证。
- `Transition(id, from[], to, fields)`: 无主状态迁移 (monitor 标记 failed、cancel)。
- `TransitionOwned(id, txID, from[], to, fields)`: 追加 `AND tx_id = ?`, 保证旧命令/旧 worker 无法覆盖新 owner 的状态。
- 更新任务定义一律走显式 `map[string]any` (而非 struct), 让 `enabled=false`、清空字符串这类零值写入生效。

### fire key 协议

fire key 是 "逻辑执行" 的身份, 全部确定性生成, 重试不产生新 key:

| 来源            | 格式                                                                                                           | 生成处                              |
| --------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| 定时计划        | `sched:{taskId}:{fireAt.Unix()}`                                                                               | `engine.SchedFireKey`               |
| 条件 (中继路径) | `cond:{taskId}:change:{eventUUID}`                                                                             | `cdc.Relay` fanout                  |
| 条件 (直发路径) | `cond:{taskId}:{table}:{recordId}:{createdAtUnix}`                                                             | `engine.CondFireKey`                |
| 手动触发        | `manual:{taskId}:{YYYYMMDDhhmmss}:{8位hex}`; 带 `Idempotency-Key` 时 `manual:{taskId}:{sha256(key)}`           | `POST /scheduled-tasks/:id/trigger` |
| 条件测试        | `condtest:{taskId}:{recordId}:{12位hex}`; 带 `Idempotency-Key` 时 `condtest:{taskId}:{recordId}:{sha256(key)}` | `POST /condition-tasks/:id/test`    |

定时路径以计划时刻的 Unix 秒为后缀: 同一 cron 计划点永远映射到同一个 key, 即使被多个节点、多条路径重复物化。条件中继路径以 change 事件的 UUID 为后缀: 同一条 `task_flow_changes` 行无论被 relay 重试多少次, 都只会物化出同一个执行。

## 幂等的四层防线

同一个逻辑 fire 可能从多个入口同时到达 (时间轮回调、monitor 补发、手动重试), Dispatcher 用四层防线逐层收窄:

**第 1 层: Bloom 预检 (拒绝已知完成的重复)。** `idem.BloomFilter` 包装 timer 的 Redis bitmap Bloom (`task_flow:bloom:exec:{UTC日期}`, 位图大小 `1<<24` bit, 两个哈希位分别取 `murmur3.Sum128` 的高低位, SET 时一段 Lua 同时置两位并仅在无 TTL 时设置过期)。`MaybeSeen` 检查今天与昨天两个 key, Redis 出错或 key 缺失一律 fail-open 放行; 命中后再查 SQL: 同 `fire_key` 且 `status != pending` 才真正抑制。Bloom 只是省一次认领与事务, 永远不是权威。

**第 2 层: Redis SETNX 认领 (互斥快路径)。** `idem.ClaimFire` 对 `task_flow:idem:fire:{fireKey}` 执行 `SET ... NX EX`, value 是纳秒时间戳, TTL 为 `claim_ttl_hours` (默认 72h)。认领失败说明有人正在处理; 此时 Dispatcher 重新读取执行行: 如果仍是 pending 且 `updated_at` 超过 5 分钟 (`claimStuckThreshold`), 视为上一个认领者已死, 接管继续; 否则记录 "duplicate fire suppressed" 直接返回。条件事件的 `ClaimEvent`/`ReleaseEvent` (`task_flow:idem:evt:` 前缀) 是同样模式。

**第 3 层: MySQL 唯一索引 (持久去重)。** `InsertPending` 依赖 `fire_key` 唯一索引 + OnConflict DoNothing + 回查。即使前两层全部失效 (Bloom 漏判、Redis 清空), 数据库也只会有一行。集成测试 `TestTransactionalCaptureAndConcurrentRelay` 用同一 fire key 重复调用 `InsertPending` 十次, 断言每次都解析回同一个 ID。

**第 4 层: CAS 状态迁移 (运行期互斥)。** `queued → running` 用 `TransitionOwned` 附带 `tx_id` 条件: 两个消费者拿到同一条命令时, 只有一个能把状态改成 running, 另一个 `affected == 0` 后安静退出, 不跑模型、不写报告。终态写入同样是 `running → succeeded/failed` 的 CAS, 迟到的旧 worker 无法覆盖。

四层各自的失效模式不同: Bloom 有 false positive, 且 Redis 出错时按未见过处理 (fail-open); SETNX 会随 TTL 过期或被误删; 唯一索引不可绕过; CAS 依赖调用方检查 `RowsAffected`。把它们叠起来, "至多一次执行" 的最终依据始终落在 SQL。

## 定时任务: Migrator 物化与分布式时间轮

### Migrator: 把 cron 展开成执行行

Migrator 是单例角色 (见后文集群协调), 每 `migrate_tick_seconds` (默认 30s) 一个 tick, tick 的 context 超时也是这个值。拿到角色后还要抢 redis_lock `task_flow:lock:migrator` (租期 = tick 秒数 x 2), 双重互斥。

物化窗口是 `[now - overdue_recover_minutes, now + migrate_step_minutes]` (默认向前回看 2 分钟、向后展开 60 分钟), 对每个 enabled 的定时任务:

1. 用任务的 IANA `timezone` 加载时区 (空或非法时退回 `Asia/Shanghai`, 再退回 `time.Local`), `cronx.Parse` 解析 5 段标准 cron (robfig/cron `ParseStandard`)。
2. 从 `max(recoverStart, task.CreatedAt)` 开始循环 `schedule.Next(cursor)`, 把所有不超过窗口末端的计划点逐个 `registerFire`。
3. `registerFire` 先 `InsertPending` 落一行 pending 执行 (带 `prompt_snapshot`/`model_snapshot` 与 `trigger_info` JSON `{cron, timezone, scheduled_at}`), 再读回确认状态仍为 pending, 才把回调注册进分布式时间轮。
4. 回调时间 `executeAt = fireAt`; 若已过期 (不晚于 now+1s) 则改为 now+5s, 让过期计划点立刻进入派发。

时间轮回调是 `POST {BaseURL}/internal/v1/fire`, 请求体 `FireCallback{execution_id, fire_key}`, 头部携带 `Authorization: Bearer {internal token}`、`X-TaskFlow-Node`、`X-TaskFlow-Fired` (RFC3339)。`BaseURL` 里的通配 host 会被改写成 `127.0.0.1` — 这意味着多机部署必须配置一个节点间可达的地址。

每次 tick 末尾, Migrator 用 `schedule.Next(now)` 重算 `next_fire_at`, 以 `WHERE id = ? AND cron_expr = ? AND timezone = ?` 为条件写回 (定义已变则不覆盖), 并失效定义缓存。

### 分布式时间轮: 分钟桶 ZSET

`time_wheel.RTimeWheel` 按分钟切桶, 每分钟的 key 形如 `yukino_time_wheel_task_{2006-01-02-15:04}`, 另有删除集 `yukino_time_wheel_delete_set_{...}` (注意: 分钟键按传入时间的 Location 格式化, 到期扫描侧使用主机本地时间, 跨时区主机部署时要以代码实际生成的 key 为准)。后台 ticker 每秒醒一次, 用三段 Lua 完成到期扫描:

- `LuaAddTasks`: 先 `SREM` 删除集里的标记, 再 `ZADD` (score = `executeAt.Unix()`, member = 任务 JSON)。
- `LuaDeleteTask`: 向删除集 `SADD` 任务键, 首次加入时 `EXPIRE 120`。
- `LuaZrangeTasks`: 取删除集成员, `ZRANGEBYSCORE [本分钟起点, 当前秒]` 拉出到期任务并 `ZREMRANGEBYSCORE` 删除后返回。

到期任务由 16 个 worker 并发执行, 一轮到期扫描共用一个 30s 的 context; 执行方式就是按注册时的 method/URL/header/body 发出 HTTP 请求。注册前 `addTaskPreCheck` 校验 method 必须是 GET/POST 且 URL 是 http(s)。

### 触发入口与当前定义校验

`/internal/v1/fire` (`handleFire`) 收到回调后: 绑定 `FireCallback`, 加载执行行, fire key 不匹配返回 400, 尚未到期返回 409, 然后调用 `Dispatcher.Dispatch` 并返回最新状态。Dispatcher 对 task_type 为 scheduled 且 fire key 以 `sched:` 开头的执行会**重新加载当前任务定义**: 任务被删除、被禁用, 或 `matchesSchedule` 不通过 (用 `schedule.Next(fireAt-1ns)` 是否恰等于 `fireAt` 判断该时刻是否仍属于当前 cron), 就把执行从 pending 迁到 cancelled 并写入 error 文本。这让 "改 cron / 禁用任务" 对已物化但未派发的执行立即生效。

## 条件任务: 事务内 CDC 与 outbox 中继

### 捕获: AFTER INSERT/DELETE 触发器

`cdc.EnsureCapture(ctx, db, table)` 为一张表安装两个触发器:

- 表名必须通过 `ValidTable` 校验 (标识符正则, 且排除 `task_flow_` 前缀表与 `condition_tasks`/`scheduled_tasks`/`tcc_tx_records`/`mq_dead_letters`); 作为可订阅表还要通过 `ValidWatchTable` (额外排除 `executions`, 防止平台自更新引发反馈循环)。
- 用 `GET_LOCK('task_flow:capture:{table}', 10)` 串行化安装; 扫描列清单后生成 `AFTER INSERT` (用 `NEW`) 与 `AFTER DELETE` (用 `OLD`) 触发器, 把整行写进 `task_flow_changes.record_json`: `JSON_OBJECT('col', NEW.col, ...)`, 二进制/blob/bit/geometry 类型用 `HEX()` 包装; `event_key` 取 `UUID()`, `occurred_at` 取 `UTC_TIMESTAMP(6)`。
- 触发器命名 `task_flow_capture_v1_` + `hex(sha256("table:op")[:8])`; 已存在同名触发器则跳过 — 因此**改列后只重启不会刷新旧触发器的 JSON 布局**, 需要先删除再重建。
- 捕获发生在业务事务内部: 事务回滚, change 行一并回滚。集成测试 `TestTransactionalCaptureAndConcurrentRelay` 明确断言了这一点。

服务启动时 `EnsureDatabaseCapture` 对 schema 内所有基表做一遍扫描安装; 创建/更新条件任务时 API 层对 watched table 再调一次 `EnsureCapture`。

### Relay: 两阶段中继

`cdc.Relay` 每秒 tick 一次, 每次调用 `Drain(ctx, 100)` 做两件事:

1. **fanout (事件 → 执行 + outbox, 同一 SQL 事务)**: `SELECT ... FOR UPDATE SKIP LOCKED` 取一条 `processed_at IS NULL` 的 change; 仅处理 `operation = 'insert'`; 查出 `enabled` 且 `table_name` 匹配、`created_at <= occurred_at` 的条件任务; 为每个任务生成 fire key `cond:{taskID}:change:{eventKey}`, `InsertPending` 物化执行 (prompt/model 快照 + `trigger_info` 含 event_type/table/event_key/occurred_at/record), 同事务向 `task_flow_outbox` 插入发布意图 (OnConflict DoNothing, payload 含 fire_key/task_id/execution_id/table/record_json/occurred_at RFC3339Nano/trace_carrier), 最后标记 `processed_at`。多个 Relay 实例并发时靠 `SKIP LOCKED` 各抢各的行。
2. **publish (outbox → Redis Stream)**: `FOR UPDATE SKIP LOCKED` 取一条 `published_at IS NULL` 的 outbox, `SendMsg` (5s 超时) 发到 cond 主题, 成功后标记 `published_at`。Redis 不可用时发布失败, outbox 行保留, 恢复后补发 — `TestOutboxSurvivesRedisOutage` 验证了这段语义。

条件执行由此获得与业务事务一致的持久性: change 与 execution、outbox 同库同事务, 消息队列只是投递通道。

### 条件消费者

`ConditionPipeline` 启动 `cfg.Executor.Workers` 个消费者 `{node}-cond-{i}`, 订阅 cond 主题。消息 `CondEvent` 按来源分两种处理:

- **中继事件 (`execution_id != 0`)**: 校验执行行存在、fire_key 与 task_id 归属一致、状态仍为 pending, 然后 `Dispatch`。JSON 解析失败的消息直接丢弃 (返回 nil, 不重试); 执行行不存在或归属不一致时返回错误交给 MQ 重试; 状态已非 pending 则静默丢弃。
- **直发事件 (`execution_id == 0`)**: 来自 `PublishRecordInserted` 辅助路径或外部投递。加载任务定义 (已删除 → warn 丢弃; 已禁用 → 丢弃), 回查 `risk_records` 原行 (已删 → 丢弃), 组装 `trigger_info`, `fireAt` 取记录 `created_at` (缺失时用 `occurred_at`), `InsertPending` 后对新的 pending 执行 `Dispatch`。直发路径的 fire key 是 `cond:{taskId}:{table}:{recordId}:{unix}`, 与中继路径的 change UUID key 不同 — 同一 INSERT 若同时走两条路径会得到两个逻辑执行, 所以主路径只保留 trigger → changes → relay → outbox。
- `PublishRecordInserted` 自身也用 `ClaimEvent` (SETNX `task_flow:idem:evt:{eventKey}`) 防重, XADD 失败时 `ReleaseEvent`。

## 手动触发与取消

`POST /api/v1/scheduled-tasks/:id/trigger`: 快照当前 prompt/model, 生成 fire key (默认含时间戳 + 8 位随机 hex; 请求头带 `Idempotency-Key` (≤200 字符) 时改用 `sha256(key)` 的确定后缀), `InsertPending` + `Dispatch`。相同 `Idempotency-Key` 重试会命中同一行, 响应指向同一个执行。当前 API 不做 "相同 key 但请求内容不同" 的指纹冲突校验, 调用方应给一轮业务操作稳定分配 key。

`POST /api/v1/condition-tasks/:id/test` 只允许 `risk_records` 表: 指定 `record_id` 或取最新一行, fire key `condtest:{taskId}:{recordId}:...`, `trigger_info` 中带 `test: true`。

`POST /api/v1/executions/:id/cancel` 只接受 pending/reserved/queued 三个状态, 其他状态返回 409 ("execution cannot be cancelled in its current status")。running 不允许取消 — 模型与工具副作用可能已经发生, 只能等终态或等 monitor 超时标记。

## 派发漏斗: TCC 事务

`Dispatcher.Dispatch` 通过 TCC 事务完成 "预留执行 + 发布命令" 这两个必须原子化的动作。参与者有两个, 都在 `engine/components.go`:

**`execution_reserve`**: Try 用 `Transition(pending → reserved)` 并写入 `tx_id` 与 `claimed_at`; 若执行已不在 pending, 但 `tx_id` 相同且状态非 pending/cancelled, 视为同一事务重入, ACK。Confirm 是 `TransitionOwned(reserved → queued)`; 已是 queued/running/succeeded/failed 且 `tx_id` 相同也 ACK。Cancel 仅在 "归属本事务且仍为 reserved" 时回退到 pending (清空 `tx_id`/`claimed_at`) 并 `ReleaseFire`, 其余情况直接 ACK。

**`mq_dispatch`**: Try 直接把 `ExecCommand{execution_id, tx_id, fire_key, trace_carrier}` (JSON) 以 fire key 为消息 key `XADD` 到 exec 主题, `trace_carrier` 由 `telemetry.Inject` 生成; Confirm/Cancel 都是空操作 ACK — 消息一旦入流不可撤回, 去重交给 Executor 的门控。

组件的 Try 状态汇总到 `tcc_tx_records`: `engine.TXStore` 用 MySQL 实现 `tcc.TXStore` 接口 — `CreateTX` 建一行 (所有参与者 hanging, txID 即记录 ID 字符串); `TXUpdate` 在 SQL 事务里 `FOR UPDATE` 读行、解析 `component_try_statuses` JSON、拒绝给非 hanging 分支重复定论、相同状态幂等返回; `TXSubmit` 以 CAS 把 hanging 改成 successful/failure; `GetHangingTXs` 一次最多 200 行; 整个恢复过程用 redis_lock `task_flow:tcc:txstore:lock` 互斥。

`tcc.TXManager` 的运行模型:

- `Transaction(ctx, reqs...)`: 超时 = `WithTimeout` (taskflow 设 30s); `CreateTX` 后并行发起所有参与者的 Try (每个 Try 成功/失败都 `TXUpdate` 记账), 任一失败即取消其余分支; 无论成败, 紧接着用 `context.WithoutCancel` + 超时开一个二阶段, 立即 `advanceProgressByTXID` — Confirm/Cancel 不必等恢复循环。返回 `(txID, successful bool, err)`。
- 恢复循环每 `MonitorTick` (taskflow 设 5s) 一轮: 抢 TXStore 锁 → `GetHangingTXs` → 8 个 worker 并行推进 → 解锁。推进规则 (`Transaction.getStatus`): 任一分支 TryFailure → 整体 failure; 全 successful → success; 仍有 hanging 且事务创建时间早于 `now - Timeout` → 判 failure (超时未完成的 Try 不再等); 否则保持 hanging 跳过本轮。上一轮出错时 tick 指数退避 (翻倍, 上限 `MonitorTick << 3`)。
- Confirm/Cancel 逐个调用参与者并要求 ACK, 全部 ACK 后 `TXSubmit` 持久化总体状态。

已知的语义边界: Cancel 在 `execIDForTX` 查不到执行时直接 ACK (空回滚), 而 Try 晚于 Cancel 到达时仍可能把执行置成 reserved — 分支 barrier/tombstone 是这类场景的通用解法, 当前实现尚未包含; 实际链路里 Dispatcher 在 TCC 失败且执行仍为 pending 时会 `ReleaseFire`, 把执行放回可重试状态, 让下一轮派发重新建立事务。

## Executor: 从消息到报告

Executor 启动 `cfg.Executor.Workers` (默认 4, 夹紧到 1..64) 个消费者 `{node}-exec-{i}`, 消费 exec 主题, 选项: `WithMaxRetryLimit(cfg.MQ.MaxRetry)` (默认 3)、`WithReceiveTimeout` (默认 1000ms)、`WithHandleMsgsTimeout` (默认 900s)、`WithAbandonedMessageRecovery(handle 超时 + 60s)`、`WithDeadLetterMailbox` (超过重试上限的消息落 `mq_dead_letters`, reason "retry limit exceeded", 然后 ACK)。

`handle` 一条命令的路径:

1. 反序列化 `ExecCommand`, `telemetry.Extract` 恢复 trace carrier, 开 span `execution.run`; 运行 context 超时 = `executor.timeout_seconds` (默认 600s)。
2. **awaitSettled 门控**: 最多 12 次、每次间隔 500ms 轮询执行状态, 处理 "mq_dispatch.Try 先发消息、reserve 尚未落库" 的竞争:

   | 观察到的状态                  | 行为                   |
   | ----------------------------- | ---------------------- |
   | cancelled / running / 终态    | 直接结束 (不跑模型)    |
   | pending 且 `tx_id` 为空       | 等待预留落库           |
   | pending 且 `tx_id` 是别的事务 | 视为被新事务取代, 结束 |
   | `tx_id` 与命令不符            | 视为过期命令, 结束     |
   | reserved                      | 等待 Confirm           |
   | queued                        | 通过, 进入抢占         |

3. 校验命令 fire key 与执行行一致; `TransitionOwned(queued → running)` 写入 `started_at`/`node_id`/`trace_id`, `affected == 0` 说明被别人抢走, 直接返回。
4. `runExecution`: recover 保护下加载定义缓存 (`LoadDefinition`, 执行行的 `prompt_snapshot` 优先), 模型取 `model_snapshot`, 缺失回退 `cfg.LLM.Model()`, 调用 `agent.Run`, 最后 `finalize`。
5. `finalize` (context 用 `context.WithoutCancel` + 15s, 即使上游超时也要落账): 更新 `finished_at`/`tool_calls`/tokens/`error`; `ReportStore.Render` 生成报告; `TransitionOwned(running → succeeded/failed)` 写 `report_path`/`report_body`/`report_excerpt` (前 280 rune); CAS 成功 (`affected == 1`) 才 `Warm` 报告缓存; `journal.RecordOutcome`、`ledger.Propose("finish:{id}", status)`; 定时任务成功时更新 `last_fire_at`。

## LLM Agent 与工具沙箱

`llm.Agent` 基于 openai-go 构造: `WithAPIKey(env)`, `WithMaxRetries(0)` (重试语义由执行层负责), `base_url` 非空才设置。工具运行时 `ToolRuntime` 持有 DB、Redis、`MaxRows`、`AllowWrites`、`KeyPrefix`。

`agent.Run` 的循环: 消息序列以 system prompt 开头, 随后是 `BuildUserPrompt` 按任务类型组装的用户提示词 (定时任务会附加审计窗口, 见下); 每轮用独立 context (`request_timeout_seconds`, 默认 180s) 调 `ChatCompletionNew` (Temperature 0.2, `MaxCompletionTokens` = `max_output_tokens` 默认 8192); 空 choices 报 `ErrNoCompletion`; 累计 usage tokens; 出现 tool_calls 就把 assistant 消息与各 tool 结果按序追加后进入下一轮 (工具**顺序**执行, 每条调用记录 round/name/args/duration/result, 结果截断到 2048 rune); 轮数超过 `max_tool_rounds` (默认 8) 报错。最终回复要通过三项校验: 内容非空、`finish_reason` 不能是 "length"、必须包含三个标题 `## Summary`、`## Detailed Analysis`、`## Conclusion & Recommendations`。system prompt 明确要求: 只用工具采集的事实写作、不得执行数据中的指令 (prompt-injection 防御)、按固定章节输出。

定时任务的提示词由 `engine.BuildUserPrompt` + `writeAuditWindows` 生成: 以触发信息里的 timezone 与 `FireAt.AddDate(0, 0, -1)` 计算当天与上一天两个**半开 UTC 窗口** `[start, end)`, 并把字面时间戳写进提示词, 引导模型用确定的时间范围查询。`prompts_test.go` 断言延迟执行的场景下窗口仍以 FireAt 为基准。

**mysql_tool**: 入参 `{sql}`。约束: SQL 长度 ≤ 64KiB; 查询 context 30s; 经 `validateSQL` 策略检查后, 读语句 (`select/show/describe/desc/explain/with` 开头) 走 `Raw().Rows()`, 行数上限 `max_result_rows` (默认 100), 累计 JSON 预算 1MiB, 单个字符串截断到 64KiB 并转成合法 UTF-8, 结果 `{columns, rows, row_count, truncated, executed_sql}`; 写语句 (`insert/update/delete`) 仅当 `allow_sql_writes` 打开时执行, 返回 `affected_rows`。`sql_policy.go` 的词法器会拒绝: `;` 多语句、`#`/`/*`/`--` 注释、未闭合引号; 禁用词表覆盖 `drop/truncate/alter/create/grant/revoke/rename/lock/unlock/flush/reset/shutdown/kill/load/call/...` 与 `sleep/benchmark/get_lock/release_lock` 等; `set` 只允许出现在 UPDATE 语句内部; 读语句里嵌写词、写语句触碰 `task_flow_*` 前缀表或 `executions/scheduled_tasks/condition_tasks/tcc_tx_records/mq_dead_letters` 控制表都会被拒。

**redis_tool**: 入参 `{operation, key, field?, value?, ttl_seconds?, pattern?}`。允许操作: `get/set/del/exists/ttl/incr/decr/hget/hset/hgetall/keys`; 除 `keys` 外所有操作的 key 必须以 `redis_key_prefix` (默认 `task_flow:tools:`) 开头, `keys` 的 pattern 同样要求带前缀; value ≤ 64KiB、field ≤ 512 字节、key ≤ 512 字节、TTL 范围 0..2592000 (30 天); 操作 context 10s; `get` 用 `Exists` + `GetRange 0..65535` 防大 key, `hgetall` 用有界 `HSCAN` (≤100 次迭代、≤100 字段、值截断 1024), `keys` 用有界 `SCAN` (≤100 个); 统一 `jsonOK/jsonErr` 信封返回。

## 报告产物与分布式缓存

`engine.ReportStore.Render` 生成报告:

1. Markdown 结构: YAML frontmatter (`execution_id`、`task_type`、`task_id`、`task_name`、`fire_key`、`status`、`node`、可选 `trace_id`、`fire_at`、`started_at`、`finished_at`、`duration_ms`, 有模型结果时再加 `model`、`llm_rounds`、`tool_calls`、`tokens_prompt`、`tokens_output`; 字符串一律 `strconv.Quote`), 标题 `# Execution Report #{id} - {name}`, 失败时加 `## Execution Failed` 与 error, 正文为模型 Markdown, `## Trigger Context` 放触发 JSON, `## Appendix: Tool Call Log` 是工具调用表格 (管道符转义、rune 截断 160/120、ok/error 标记), 页脚注明生成节点与时间。
2. 落盘: `{reports.dir}/{YYYY-MM-DD}/exec-{id}.md`, 目录按 `StartedAt` 切分; `writeAtomic` 先写同目录临时文件 (`.report-*`) → Write → Sync → Close → Rename。
3. 落库: `report_body` (mediumtext) 与 `report_excerpt` 随终态 CAS 写入 `executions`; 文件与 SQL 不是同一事务, 判断执行结果以 SQL 为准。

缓存读路径 `ReportStore.Load`: 先查 yukino_cache 分组 (`task-flow.reports`, key `exec:{id}`), miss 回落到 `executions.report_body`。`Warm` 在终态 CAS 成功后把报告写进分组。分组在 main 里注册: `yukino_cache.NewGroup(cfg.Cache.ReportGroup, report_cache_bytes_mib<<20, getter, WithExpiration(report_expire_seconds))`, getter 解析 `exec:%d` 从 SQL 读 `report_body`。配置了 `etcd_endpoints` + `cache_server_addr` 时, `OpenReportPeers` 启动 gRPC 缓存服务 (服务名 `task-flow.reports`) 并注册 ClientPicker, Set/Delete 会异步同步给 key 的 peer owner (见第二部分第 10 章)。

任务定义缓存走 `consistent_cache`: 两个 `Service` 分别对应前缀 `task_flow:def:sched:` 与 `task_flow:def:cond:`, 选项 `WithCacheExpireSeconds(def_cache_expire_seconds, 默认 60)` + `WithCacheExpireRandomMode` (TTL 变 60..120s 抖动, 防同时失效) + `WithDisableExpireSeconds(1)`。写路径 (`UpdateScheduledTask` 等) 先 Disable (写 1 秒过期的禁回填标记) → Del 缓存 → SQL 更新, 标记靠 TTL 自然过期, 不做显式 Enable; 读路径 miss 时回填, 且回填受 Lua 门禁保护 (见第二部分第 9 章)。`SyncDrift` (monitor 每轮调用) 对比缓存 JSON 与 `obj.Write()` 的最新值, 不一致就 Disable + Del 并计数, 是对账兜底。

## 集群协调: 心跳、哈希环与单例角色

每个节点在 `SingletonRegistry` 里维护三件事:

- **心跳**: 每 15s 向 `task_flow:node:{id}` 写当前 Unix 秒, TTL 45s。
- **注册/退出**: 启动时 `consistent_hash.AddNode(nodeID, weight=1)` 把自己挂上环; `Deregister` 停循环、`RemoveNode`、删心跳键。
- **驱逐**: 心跳循环里顺带检查环上其他节点的心跳键是否存在, 不存在即 `RemoveNode` 驱逐。

角色归属用 `IsOwner(ctx, roleKey)`: 对 roleKey (`task_flow:singleton:migrator` / `task_flow:singleton:monitor`) 调 `ring.GetNode`, 结果等于本节点才是 owner; **环查询出错时 fail-open 返回 true**, 宁可两个节点都尝试 (后面还有 redis_lock 兜底), 不可无人干活。`Members` 汇总自身 ID、两个角色的当前 owner、环上节点的 weight 与存活状态, 供 `/monitor/nodes` 展示。`RingMigrator` 回调只打日志 — taskflow 的角色没有需要搬迁的数据。

Redis 哈希环的具体表示见第二部分第 8 章; 这里只需记住环的 key 是 `task_flow:nodes`, 哈希器是 FNV-1a (`int32 = fnv32a % MaxInt32`), 环的增删查都先拿 `redis:consistent_hash:ring:lock:task_flow:nodes` 上的 redis_lock。

## Monitor 清扫与状态同步

Monitor 是另一个单例角色: 本地 `time_wheel.NewTimeWheel(32, 5s)` 驱动, 键 "monitor-sweep", 每 30s 一轮; sweep 的 context 50s; 通过 `IsOwner(SingletonMonitor)` 后抢 redis_lock `task_flow:lock:monitor` (租期 55s)。并发子任务跑在 `pool.NewGoWorkerPool(recover_workers)` (默认 8) 上, 每个任务带 panic recovery。一轮 sweep 依次做五件事:

1. **failStuckRunning**: `updated_at` 早于 `now - stuck_running_minutes` (默认 30) 的 running 执行, `Transition(running → failed)` 写 error "execution timed out (node crashed or LLM call hung); marked failed by monitor" 与 `finished_at`, 并 CaptureError。注意是标 failed 而非重新排队 — 工具副作用可能已经发生, 自动重跑有重复风险。
2. **redispatchOverdue**: `fire_at` 早于 `now - overdue_recover_minutes` (默认 2) 的 pending 执行 (limit 200), 逐个 `Dispatch`。这是时间轮丢条目/回调失败时的补偿路径。
3. **republishStuckQueued**: `updated_at` 早于 `now - overdue_recover_minutes` 的 queued 执行 (limit 200), 跳过 `tx_id` 为空的行, 用**原 `tx_id`** 重新发布 `ExecCommand` 到 exec 主题 — Executor 门控认 `tx_id`, 补发不会造成二次执行。
4. **syncData**: `storage.SyncExecutionMirror` 最多 4 批、每批 500 行 (见下); `defs.SyncDrift` 修复定义缓存漂移。
5. **publishStats**: 以 UTC 当日零点 (`Truncate(24h)`) 为起点统计各状态计数, 连同 monitor/migrator owner、`exec_mirror_size`、`migrate_step_minutes` 序列化后写入 `task_flow:monitor:stats` (TTL 2 分钟), 供 `/monitor/stats` 读取。

**执行镜像** (`storage/mirror.go`): 把 SQL 的执行状态增量同步到 Redis Hash `task_flow:exec:status` (field = 执行 ID, value = `{status, fire_key, task_type, updated_at}` JSON), 给看板类查询减压:

- 游标 `{last_id, max_id, prune}` 存在字符串键 `task_flow:exec:status:cursor` (TTL 7 天)。`max_id` 首次取 `COALESCE(MAX(id), 0)`, 然后按 `id > last_id AND id <= max_id ASC` 分批扫描 — **固定窗口轮扫**: 扫到末尾就把游标归零重来, 因为旧执行也会有状态更新。
- 每个条目用 Lua 写入: 先 `HGET` 旧值, 旧 `updated_at` 比新值大就拒绝, 防止乱序同步造成状态倒退; 管道末尾给整个 Hash `EXPIRE` 7 天。
- 超过 7 天的终态行在扫描时跳过写入 (但游标照常推进); 另有 prune 步骤用 `HSCAN` (每轮 200, 游标持久化) 对 Hash 里的终态过期条目做 compare-and-HDEL (值相同才删)。

**存储面诊断** (`storage.Fleet`): `/monitor/storage` 汇总 pending_changes / pending_outbox 计数、`information_schema.triggers` 里 `task_flow_capture_v1_` 前缀触发器覆盖的表、各 MySQL 副本的 `SHOW REPLICA STATUS` (Replica_IO_Running / Replica_SQL_Running / Seconds_Behind_Source / 错误字段, 副本连接池很小: MaxOpen 2 / MaxIdle 1)、Redis `INFO replication` 解析。

## 节点本地审计: LSM journal 与 Raft ledger

这两个组件都是**节点本地的诊断设施, 不是业务事实的权威** (业务事实在 MySQL):

**journal** (`journal.Store`, 基于 `lsm_tree`): 配置 `WithMaxLevel(4)`、`WithSSTSize(1MiB)`、`WithSSTNumPerLevel(4)`、`WithSSTDataBlockSize(16KiB)`, 目录取 `journal.dir` (空串则整个 store 为 nil 禁用)。key 为 `fk:{fireKey}`; `RecordDispatch` 在派发成功后写 `{fire_key, execution_id, task_type, task_name, dispatched_at...}`; `RecordOutcome` 在 finalize 时读改写补上终态; `Lookup` 供 `/monitor/journal?fire_key=...` 查询。所有读写有互斥锁, Close 幂等。

**ledger** (`consensus.Ledger`, 基于 `components/raft`): 单成员 raft — `MemoryStorage`, `PreVote: true`, `ElectionTick: 10`, `HeartbeatTick: 1`, `StartNode` 只给一个 peer (自身), 100ms tick。ready loop 持久化 (`Append` + `SetHardState`, 按需进行) 并记录软/硬状态、apply 已提交条目 (payload 是 `{k, v, t}` JSON, 写进内存 state map) 后 `Advance`。业务侧 `Propose` (2s 超时) 两类条目: `dispatch:{fireKey}` (值 = 执行 ID) 与 `finish:{id}` (值 = 终态)。内存里保留最近 64 条 entries 供 `Status()` 展示 (term、commit_index、raft_state、is_leader 等), 由 `/monitor/consensus` 暴露。每个节点各跑各的单成员集群, 节点间没有 raft 通信, 不构成多数派 — 它演示的是 raft 日志机的装配方式, 不承担跨节点一致性职责。

## 可观测性

- **OpenTelemetry** (`telemetry.Setup`): propagator 为 W3C TraceContext + Baggage; exporter 支持 stdout 与 file (追加 JSONL, `WithoutTimestamps`); resource 带 `service.name = "task-flow"` 与 `service.instance.id = {node id}`; sampler 为 `ParentBased(TraceIDRatioBased(sample_rate))` (默认 1.0)。`telemetry.Inject/Extract` 用 `MapCarrier` 把 trace 塞进/读出 MQ 消息的 `trace_carrier` 字段, 打通 HTTP → 派发 → 消费 → LLM 的链路。
- **HTTP Trace 中间件**: 从请求头 extract carrier, 开 span, 响应头回写 `X-Trace-Id`。
- **Sentry** (`obsx.Setup`): DSN 取自 `sentry.dsn_env` (默认 `SENTRY_DSN`), 空则 noop; 事件带 Environment/Release、`ServerName = node id`、`EnableTracing: false`。`CaptureError` 生成 type "TaskFlowError" 的事件, tags 含 `component=server` 与自定义字段; trace_id 来自 obsx 自己的 context key (`WithTraceID`), 常规 OTel context 没有自动桥接 — 想让 Sentry 事件关联 trace, 需要显式传递。`CapturePanic` 以 Fatal 级别上报并被 SentryRecover 中间件用于 panic 恢复。
- **客户端日志接入**: `POST /api/v1/telemetry/log` 接收 ≤1MiB 的合法 JSON, 加互斥锁追加到 `client_log_path` (默认 `logs/client-events.jsonl`), 每行 `{received_at, payload}`。

## HTTP API 能力面

路由由 `yukino_http` 承载, 中间件链: CORS → Trace → SentryRecover → AccessLog → BodyLimit (1MiB, `MaxBytesReader`, nosniff; `/api/` 路径加 no-store)。

认证: `/api/v1` 配置了 `api_token_env` 时要求 `Authorization: Bearer {token}`, 校验方式是把 "Bearer " + 配置 token 整体做 SHA256 后与请求头常量时间比较; 免认证路径只有 `/health`、`/ready`、`/telemetry/log`。未配置 token 时 API 全开。`/internal/v1` 配置了 `internal_token_env` 时同样走 token 校验, 未配置时要求请求来自 loopback。

| 方法与路径                                         | 说明                                                                                         |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `GET /api/v1/health` / `ready` / `overview`        | 存活 / 就绪 / 总览 (统计+任务+近期执行+节点)                                                 |
| `GET/POST /api/v1/scheduled-tasks`                 | 列表 (name/cron/prompt 必填, 时区默认 Asia/Shanghai, 计算 next_fire_at, 重名 409)            |
| `GET/PATCH/DELETE /api/v1/scheduled-tasks/:id`     | 更新走指针字段合并 + 重算 next_fire_at + 定义缓存更新                                        |
| `POST /api/v1/scheduled-tasks/:id/trigger`         | 手动触发 (见上文 fire key 协议)                                                              |
| `GET/POST /api/v1/condition-tasks`                 | 创建时校验 `ValidWatchTable` 并 `EnsureCapture`, event_type 固定 `mysql_insert`              |
| `GET/PATCH/DELETE /api/v1/condition-tasks/:id`     | 定义维护                                                                                     |
| `POST /api/v1/condition-tasks/:id/test`            | 仅 `risk_records`, 测试入口                                                                  |
| `GET /api/v1/executions` / `:id` / `:id/report`    | 列表 (页大小默认 20 上限 200, id DESC); report 返回 `text/markdown; charset=utf-8`, 空则 404 |
| `POST /api/v1/executions/:id/cancel`               | 仅 pending/reserved/queued, 否则 409                                                         |
| `GET/POST /api/v1/risk-records`                    | 演示业务表; 创建返回 `event_delivery: "durable"` (依赖触发器捕获)                            |
| `GET /api/v1/monitor/nodes                         | stats                                                                                        | cache | dead-letters | consensus | journal | mirror | storage` | 诊断面 (journal 查询要求 `fire_key` 参数) |
| `POST /api/v1/telemetry/log`                       | 前端事件落 JSONL                                                                             |
| `POST /internal/v1/fire` / `GET /internal/v1/ping` | 时间轮回调 / 内部探活                                                                        |

## 配置与部署形态

### 配置文件

单一 YAML, 所有敏感值走 `*_env` 间接层 (配置里写环境变量名), 标量支持 `${VAR}` 展开。主要段落与 `repair()` 默认值:

| 段        | 关键键与默认值                                                                                                                                                                                                                                                                                    |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| server    | host 127.0.0.1, port 8080, read 30s / write 600s, `api_token_env` / `internal_token_env`; `BaseURL()` 把通配 host 改写为 127.0.0.1                                                                                                                                                                |
| node      | `id`, 空则 `{hostname}-{pid}`                                                                                                                                                                                                                                                                     |
| mysql     | 127.0.0.1:3306, user root, `password_env` 默认 MYSQL_PASSWORD, database `task_flow`, max_open 20 / max_idle 5, `replica_addresses`; DSN 固定 `charset=utf8mb4&parseTime=True&loc=UTC&timeout=5s&time_zone=%27%2B00%3A00%27`                                                                       |
| redis     | 127.0.0.1:6379, mode standalone/sentinel/cluster, `addresses`, `master_name`, `sentinel_password_env`; 连接池 PoolSize 64 / MinIdleConns 8 / 各超时 5s                                                                                                                                            |
| llm       | `base_url_env` OPENAI_BASE_URL、`api_key_env` OPENAI_API_KEY、`model_env` OPENAI_MODEL (`Model()` 优先取环境变量, 回退 `default_model`), max_tool_rounds 8, request_timeout_seconds 180, max_output_tokens 8192, max_result_rows 100, allow_sql_writes false, redis_key_prefix `task_flow:tools:` |
| scheduler | migrate_step_minutes 60, migrate_tick_seconds 30, claim_ttl_hours 72, stuck_running_minutes 30, overdue_recover_minutes 2, recover_workers 8 (夹紧 1..64)                                                                                                                                         |
| mq        | exec_topic `task-flow.exec.commands`, cond_topic `task-flow.cond.events`, exec_group `task-flow-exec`, cond_group `task-flow-cond`, msg_queue_len 5000, max_retry 3                                                                                                                               |
| executor  | workers 4 (夹紧 1..64), timeout_seconds 600, receive_timeout_ms 1000, handle_timeout_seconds 900                                                                                                                                                                                                  |
| cache     | report_group `task-flow.reports`, report_cache_bytes_mib 64, report_expire_seconds 600, def_cache_expire_seconds 60, etcd_endpoints, cache_server_addr                                                                                                                                            |
| reports   | dir `./reports`                                                                                                                                                                                                                                                                                   |
| journal   | dir `./data/journal`                                                                                                                                                                                                                                                                              |
| consensus | id 1                                                                                                                                                                                                                                                                                              |
| sentry    | dsn_env SENTRY_DSN, environment, release                                                                                                                                                                                                                                                          |
| telemetry | enabled, exporter stdout/file, file_path, client_log_path `logs/client-events.jsonl`, sample_rate 1                                                                                                                                                                                               |

`Validate()` 强制的约束: cluster 模式必须用 DB 0; sentinel 必须同时给 `addresses` 与 `master_name`; `etcd_endpoints` 与 `cache_server_addr` 必须同时配置或同时为空; 超时时序 `0 < executor.timeout_seconds < executor.handle_timeout_seconds` 且 `executor.timeout_seconds < scheduler.stuck_running_minutes*60` (执行超时必须小于消息处理超时, 也必须小于 stuck running 判定); migrate tick/step、max_tool_rounds、max_result_rows 为正; database 名必须通过标识符检查。

### 部署形态

- **本地**: `go run ./cmd/task_flow --config conf.yml` (conf.yml 为开发默认; conf.example.yml 是完整示例)。启动会建库、迁移表、安装触发器, SQL 账号需要相应权限。
- **单机 compose** (`docker-compose.yml`, name `task-flow`): mysql 8.4 (utf8mb4, server-id 1, binlog ROW, GTID ON, sync-binlog 1, innodb_flush_log_at_trx_commit 1); redis 7-alpine (AOF appendfsync always, maxmemory-policy noeviction); server 镜像由仓库根 context 构建 (Dockerfile 先 COPY 全部 replace 模块再构建, 运行用户 task_flow, EXPOSE 8090, 入口 `./task_flow --config conf.yml`, 配置用 conf.docker.yml), 健康检查打 `/api/v1/ready`, 挂 reports/data/logs 三个卷; client 是 nginx 静态站 (80 端口, 由 `CLIENT_PORT` 默认 8080 映射)。
- **集群 overlay** (`docker-compose.cluster.yml` 与基础 compose 叠加使用): etcd 三节点 (v3.5.17, cluster-token `task-flow-cache`); mysql-replica + replication-init (校验副本无应用表后 `mysqldump --single-transaction --routines --triggers --set-gtid-purged=ON` 灌入, `CHANGE REPLICATION SOURCE ... SOURCE_AUTO_POSITION=1` 建立 GTID 复制, 副本 `read_only`/`super_read_only` 持久化, 轮询等待 IO/SQL 线程 Yes); redis 两副本 + 三 Sentinel (`sentinel monitor task-flow redis 6379 2`, down-after 5000ms, failover-timeout 15000ms, parallel-syncs 1); server 挂载 conf.cluster.yml (sentinel 模式、`replica_addresses: [mysql-replica:3306]`、etcd endpoints、`cache_server_addr: ":9100"`); server-2 第二节点 (独立 journal/logs 卷); client 挂载 nginx.cluster.conf (`least_conn` 上游 server + server-2, `/api/` 反代, 502/503/504 自动切换)。
- **环境变量模板** (`.env.example`): MYSQL_PASSWORD、REPLICATION_PASSWORD、OPENAI_API_KEY/BASE_URL/MODEL、SENTRY_DSN、TASK_FLOW_API_TOKEN、TASK_FLOW_INTERNAL_TOKEN、SERVER_PORT、CLIENT_PORT。Go 进程只读 YAML 指定的环境变量, 不会自动加载 .env; compose 加载 .env 与本地 Go 进程读环境是两件事。
- 仓库内 `docs/architecture.md` 与 `docs/operations.md` 提供更多架构与运维细节, 可与本文对照阅读。

## 保证边界与适用场景

把各层的语义边界集中说清楚, 便于判断适用场景:

- **投递**: red_mq 是 at-least-once (pending/claim/重试都可能重复投递); **执行**是 at-most-once claim (queued → running CAS 只成功一次)。业务含义: 同一条命令可能被多个消费者看到, 但模型至多跑一次; 代价是 running 崩溃后当前实现标记 failed, 需要人工分析或显式用新的 manual key 重跑。
- **外部副作用**: exactly-once 只成立于平台内部状态。模型经工具写出的数据 (尤其打开 `allow_sql_writes` 后) 不受事务保护, 平台不提供通用 fencing。
- **CDC 捕获**: 只有 INSERT/DELETE 触发器, 没有 UPDATE 捕获; 触发器安装前的历史变化没有 baseline; `enabled` 在 relay fanout 时判断, 不是事件发生时刻的订阅快照; TRUNCATE 不产生行级事件。
- **时间轮**: 分钟桶 key 按时间的 Location 格式化, 到期扫描侧使用主机本地时间; 回调依赖节点间网络可达 (BaseURL 必须配置成集群内可达地址)。
- **本地存储**: journal 的 WAL 写入不带逐条 fsync, 且不支持多进程共写一个目录; 报告文件与 SQL 终态不是同一事务。
- **诊断账本**: raft ledger 是单成员内存集群, 重启即失, 不作为持久事实。
- **观测**: Sentry 事件与 OTel trace 的关联需要显式传递 trace id, 没有自动桥接。
- **对账公平性**: monitor 各清扫都是 limit 200 的头部扫描, 若头部行持续不可处理会影响后续行的及时性。

适合的场景: 内部数据巡检、按日/按事件的安全审计、把 "查数据 + 写报告" 的重复劳动自动化。不适合: 需要严格外部 exactly-once 的资金类操作、亚秒级触发的实时系统、以平台账本为业务事实来源的系统。

# 第二部分: 组件教程 — 十个本地 replace 组件

这一部分假设读者刚接触分布式系统。每一章先讲问题域, 再读实现入口, 最后给开发坑与动手练习。非测试 Go 代码行数 (供评估阅读成本): red_mq 902、time_wheel 657、redis_lock 596、consistent_hash 1558、consistent_cache 704、yukino_cache 2301 (不含生成的 protobuf 代码)、tcc 1567、timer 3920、lsm_tree 1748、raft 1782。

## 1. 分布式问题入门 [#chapter-1]

先建立贯穿全文的几个概念, 每个都给出 taskflow 中的实例:

| 概念               | 一句话解释                            | taskflow 实例                         |
| ------------------ | ------------------------------------- | ------------------------------------- |
| 部分失败           | 一次操作可能 "做了一半", 必须设计补救 | XADD 成功但 outbox 事务提交失败       |
| 权威来源           | 冲突时以哪份数据为准                  | 执行状态以 MySQL 为准, Redis 只做加速 |
| 幂等               | 同一逻辑操作重试不产生额外效果        | 相同 fire key 复用同一 execution 行   |
| CAS                | 仅当旧值符合预期才更新                | `WHERE status='queued' AND tx_id=?`   |
| 租约               | 带过期时间的临时授权                  | migrator 的 redis_lock, 心跳 TTL 45s  |
| at-least-once      | 消息可能重复投递                      | Streams pending/claim/重试            |
| at-most-once claim | 一次逻辑执行只允许一次成功抢占        | queued → running 的 TransitionOwned   |
| outbox             | 与业务同事务落库的待发布意图          | `task_flow_outbox`                    |
| singleflight       | 同 key 并发 miss 只加载一次           | yukino_cache 的 SingleFlightGroup     |
| 对账 reconcile     | 用权威数据周期性修复派生数据          | SQL → Redis 执行镜像                  |

单机 Go 并发是这些问题的微缩版: 两个 goroutine 同时 `map[k]++` 会丢更新, 分布式下只是把 goroutine 换成进程、把内存换成网络。读组件源码时, 始终追问三件事: **并发写怎么互斥? 失败后谁负责补救? 补救动作本身是否幂等?**

## 2. replace 组件清单与阅读策略 [#chapter-2]

| 组件             | 问题域                   | taskflow 用法                    | 建议入口文件                                                                           |
| ---------------- | ------------------------ | -------------------------------- | -------------------------------------------------------------------------------------- |
| red_mq           | 消息队列                 | exec/cond 两个主题               | `consumer.go`, `producer.go`, `redis/redis.go`                                         |
| time_wheel       | 延迟任务调度             | 定时触发回调; monitor 本地轮     | `time_wheel.go`, `redis_time_wheel.go`, `time_wheel_lua.go`                            |
| redis_lock       | 分布式锁                 | 四处互斥                         | `lock.go`, `lua.go`, `option.go`                                                       |
| consistent_hash  | 分片/角色归属            | migrator/monitor 单例            | `consistent_hash.go`, `redis/hash_ring.go`                                             |
| consistent_cache | 缓存一致性               | 任务定义缓存                     | `service.go`, `redis/cache.go`, `redis/lua.go`                                         |
| yukino_cache     | 带预算的分组缓存         | 报告缓存                         | `group.go`, `lru.go`, `single_flight.go`, `peers.go`                                   |
| tcc              | 分布式事务               | 派发事务                         | `txmanager.go`, `model.go`, `txstore.go`                                               |
| timer            | 工具集 (cron/bloom/pool) | cron 解析、Bloom、清扫 worker 池 | `pkg/cron/parser.go`, `pkg/bloom/filter.go`, `pkg/pool/pool.go`, `pkg/hash/murmur3.go` |
| lsm_tree         | 本地持久 KV              | 节点审计 journal                 | `tree.go`, `tree_restore.go`, `wal/writer.go`, `tree_compact.go`                       |
| raft             | 共识日志机               | 节点诊断 ledger                  | `raft/node.go`, `raft/raft.go`, `raft/storage.go` + `internal/consensus/ledger.go`     |

阅读策略: 不要从 README 顺序读。先在第一部分里跟一条执行的路径 (下一章), 遇到组件调用再跳进对应组件, 只读被用到的那条链路。相关组件的更完整教程可参考 [yukino-go-components](./yukino-go-components), yukino_cache 的独立文档在 [yukino-cache-go](./yukino-cache-go)。

## 3. 状态机与门禁: 一条执行的全链路 [#chapter-3]

以定时任务 "Daily MySQL Data Inspection" 的 10:00 计划点为例, 把组件串起来:

1. **物化**: Migrator (提前最多 60 分钟) `InsertPending` 一行 `sched:{id}:{unix}` 的 pending 执行, `RTimeWheel.AddTask` 注册分钟桶 ZSET 条目。
2. **回调**: 到点后时间轮 Lua 拉出任务, HTTP POST `/internal/v1/fire`。
3. **门禁 1 (定义)**: Dispatcher 重读任务定义, 校验 enabled 与 `matchesSchedule`。
4. **门禁 2 (Bloom)**: `MaybeSeen` 命中则查 SQL 确认是否已完成。
5. **门禁 3 (认领)**: `ClaimFire` SETNX; 失败时判断是否为 5 分钟无进展的 stuck pending, 决定接管或放弃。
6. **门禁 4 (TCC)**: `execution_reserve.Try` 把 pending → reserved; `mq_dispatch.Try` XADD 命令; 两者记账进 `tcc_tx_records`; 二阶段 Confirm 把 reserved → queued。
7. **门禁 5 (settle)**: Executor 收到命令, `awaitSettled` 等到 queued (容忍 Try 可见性延迟), 校验 fire key 与 tx_id。
8. **门禁 6 (抢占)**: `TransitionOwned(queued → running)` CAS, 败者退出。
9. **运行**: agent 多轮工具调用, 产出 Markdown。
10. **落账**: finalize 的 `TransitionOwned(running → 终态)` CAS 写报告; Warm 缓存; journal/ledger 审计; ACK 消息 (handler 正常返回即 XACK)。

条件任务链路在第 6 步之前换成: 触发器 → `task_flow_changes` → Relay fanout (同事务物化执行 + outbox) → outbox publish → cond 消费者 → Dispatch。每一步失败后由谁补救:

| 故障               | 补救者                                                                 |
| ------------------ | ---------------------------------------------------------------------- |
| 时间轮条目丢失     | monitor redispatchOverdue (pending 超期重派发)                         |
| 回调发出但节点宕机 | 同上 (执行仍是 pending)                                                |
| TCC Try 悬挂       | TXManager 恢复循环超时判 failure → Cancel                              |
| 命令发布后无人消费 | monitor republishStuckQueued 用原 tx_id 补发                           |
| 消费者处理中崩溃   | XAUTOCLAIM 由其他消费者认领; running 卡死由 failStuckRunning 标 failed |
| 重试次数耗尽       | 死信信箱落 `mq_dead_letters`                                           |

## 4. red_mq: Redis Streams 消费组 [#chapter-4]

**问题域**: 多消费者可靠投递 — 消息不能丢, 处理失败要重试, 反复失败要隔离, 消费者崩溃后未确认的消息要能被别人接管。Redis Streams 的 consumer group + PEL (Pending Entries List) 正好提供原语。

**Producer**: `SendMsg(ctx, topic, key, val)` 就是 `XADD topic MAXLEN {msg_queue_len} * {key: val}` (taskflow 把 MaxLen 设成 5000; 组件默认 500)。注意这是严格 MAXLEN 裁剪, 未启用 `~` 近似裁剪: 每次 XADD 都把流精确裁剪到上限。

**Consumer 主循环** (`NewConsumer(client, topic, group, name, handler, opts...)`, 创建时 `XGROUP CREATE`):

```text
loop:
  XAUTOCLAIM topic group consumer min-idle 0-... (claimIdle 游标)   // 接管闲置超时的 pending
  XREADGROUP group consumer COUNT 1 BLOCK receiveTimeout STREAMS topic ">"
  handlerMsgs: 逐条调用 handler (context = handleMsgsTimeout)
      panic → 视为 error; 成功 → XACK; 失败 → failureCnts[msgID]++
  deliverDeadLetter: failureCnts >= maxRetryLimit → mailbox.Deliver → XACK
  receivePending: XREADGROUP STREAMS topic "0-0" 重读自己的 PEL
```

组件默认值: receiveTimeout 2s、maxRetryLimit 3、handleMsgsTimeout 1s、deadLetterDeliverTimeout 1s。taskflow 覆盖为: receive 1000ms、handle 900s、retry 3、abandoned recovery = handle + 60s。

**关键机制**:

- **XAUTOCLAIM** 把空闲超过阈值的 pending 消息转给当前消费者, 这是崩溃接管的全部魔法; `TestAbandonedMessageRecovery` 用 1ms 阈值演示了这一点。
- **失败计数在内存**: `failureCnts` 是消费者本地 map, 消费者重启会丢计数 — 死信判定不是持久的。
- **ACK 不删 entry**: XACK 只把消息移出 PEL, Stream 里的 entry 靠 MAXLEN/XTRIM 修剪; 所以 XLEN 包含已 ACK 的旧消息, 不能当 "待执行数"。

**开发坑**: 不要绕开消费组从头 XRANGE 再自己 DEL — 会失去 pending/ack/claim 机制; 业务处理失败 (模型跑错) 不该无限重试, taskflow 的做法是 handler 成功返回 (ACK), 把失败写进 SQL 终态; 调大 MaxLen 不能解决积压, 还要看吞吐、pending age 与内存 (noeviction 满内存会让 XADD 失败, 此时 outbox 保留意图)。

## 5. 幂等专题: 四层防线逐层拆 [#chapter-5]

**问题域**: 重试是分布式的常态, "再试一次" 不能变成 "再做一次"。通用解法 = 确定性身份 + 多级去重 + 权威兜底。

**确定性身份**: 重试必须沿用同一个 key。taskflow 的 fire key 由业务语义推导 (计划时刻 Unix 秒、change UUID), 绝不使用随机 UUID 当执行身份 — 重试时换新 UUID 等于创建新执行。

**Bloom (`idem/bloom.go` + timer/pkg/bloom)**: 每日一个 key `task_flow:bloom:exec:{UTC 日}`, bitmap `1<<24` bit; 两个哈希位取 `murmur3.Sum128` 的高 64 位与低 64 位分别模 `1<<24`; `Exist` 两位都为 1 才报存在 (任一位为 0 短路返回); `Set` 一段 Lua 置两位, 且只在 `TTL < 0` 时 `EXPIRE` (TTL 只设一次, 避免反复续命)。`MaybeSeen` 查今天 + 昨天两个 key, Redis 出错 fail-open。Bloom 有 false positive (两位被别的 key 置过), 所以命中后必须查 SQL 复核; 没有 false negative 语义依赖 — 它只是优化。`TestBloomRequiresBothBitsAndBoundsMemory` 断言: 只置一位不算存在、bitmap 不超过 2MiB、必须有 TTL。

**SETNX 认领 (`idem/idem.go`)**: `SET key val NX EX ttl` 一条命令完成互斥 + 租约。value 是纳秒时间戳, 仅作诊断。TTL 到期认领自动消失 — 这不是 bug: 权威在 SQL, 认领只是快路径。

**唯一索引 + 回查**: `OnConflict DoNothing` 之后必须重新 SELECT 拿权威 ID, 因为冲突时 `RowsAffected == 0`, 插入方拿不到已有行的 ID。

**CAS**: 所有状态迁移都带 `WHERE status IN (...)` (可选 `AND tx_id = ?`), 且检查 `RowsAffected`; `affected == 0` 不是错误, 是 "别人先到了"。

**开发坑**: TTL 过期不等于可以再跑一次 (SQL 终态仍在); 修复投递沿用原 key, 明确 "重新运行" 才新建 manual key; 不把 terminal 改回 pending 当通用修复 (旧 worker 的副作用可能已发生); 更新不带旧状态/tx_id 会让过期命令覆盖新 owner。

## 6. time_wheel: 本地时间轮与分布式时间轮 [#chapter-6]

**问题域**: 海量延迟任务 ("N 秒后做某事") 如果每个都开一个 timer/协程, 内存与调度开销不可控; 时间轮用固定数量的槽位按时间组织它们, 插入与取消近似 O(1)。

**本地轮 (`time_wheel.go`)**: `NewTimeWheel(slotNum, tick)`; `slots []*list.List` + `keyToETask map[string]*taskElement{task, pos, cycle, key, executeAt}`; 单个 run goroutine 多路 select (stopChan / addTaskCh / removeTaskCh / ticker)。`getPosAndCircle` 把延迟换算成槽位与圈数: `pos = (当前槽 + delay/tick) % slotNum`, `cycle = delay/tick / slotNum`; 负延迟钳制到立即; 同 key 重复 Add 是**替换**。到期时 cycle 大于 0 就减一再等下一圈, 否则起新 goroutine 执行 (带 recover)。taskflow 的 Monitor 用它安排 30s 一轮的清扫。

**分布式轮 (`redis_time_wheel.go`)**: 没有中心进程, 靠 Redis 分片 + 多节点扫描。每分钟一个 ZSET 桶 (`yukino_time_wheel_task_{分钟}`) + 同分钟的删除集 (`yukino_time_wheel_delete_set_{分钟}`); 后台 1s ticker 用三段 Lua (见第一部分) 原子完成 "扣除删除集 → 范围查询 → 删除已取任务"。到期任务交给 16 个 worker、每轮扫描共用一个 30s context 执行 HTTP 回调; 注册前 pre-check method/URL。

**开发坑**:

- 分钟桶 key 按传入时间的 Location 格式化, 到期扫描侧使用主机本地时间 — 不同主机时区不同会产生不同的 key 空间, 部署要对齐时区或以代码生成的 key 为准; 计划语义 (cron/物化) 用 IANA 时区 + UTC 持久化, 与桶 key 是两回事。
- 时间轮只决定 "何时尝试触发", 不知道逻辑事件是否已执行 — 去重必须另靠 SQL 唯一索引。
- 回调地址必须可达: loopback 指向当前进程的网络命名空间, A 节点注册的 `127.0.0.1:端口` 在 A 宕机后无人监听, 与 B 是否存活无关。

## 7. redis_lock: 一把最小正确的分布式锁 [#chapter-7]

**问题域**: 多进程互斥一段操作。陷阱全在细节: 锁要有租约 (持有者崩溃要能释放), 释放要验证持有者 (不能解别人的锁), 续约要原子。

**实现 (`lock.go`)**:

- key = `REDIS_LOCK_PREFIX_` + 业务 key; **token = 进程 PID + goroutine ID 字符串** (`utils.GetProcessAndGoroutineIDStr`)。
- 加锁: `SET key token NX EX expire`; 阻塞模式每 50ms 重试直到成功或 context 结束。
- 看门狗: **仅在未显式指定过期时间时启用** — 默认锁 30s, 每 `WatchDogWorkStepSeconds` (10s) 用 compare-and-expire Lua 续期; 显式给了 `WithExpireSeconds` 就纯租约, 不续期。taskflow 的所有调用都显式给租期。
- 解锁: compare-and-delete Lua (token 匹配才 DEL); token 不匹配返回 "can not unlock without ownership of lock" 错误 (`ErrLockAcquiredByOthers` 只用于加锁路径)。

**taskflow 的用法**: `task_flow:lock:migrator` (租期 = 2 个 tick)、`task_flow:lock:monitor` (55s)、`task_flow:tcc:txstore:lock` (恢复循环持有)、哈希环的 `redis:consistent_hash:ring:lock:{key}` (租期默认 15s)。

**开发坑**:

- token 用 PID + goroutine ID, 跨进程存在碰撞可能 (容器里 PID 常相同); 更稳的做法是每次加锁生成唯一 token 并在句柄里保存。
- 哈希环的 `Lock`/`Unlock` 每次新建锁对象, 依赖 token 生成规则稳定才能解开同一把锁; 若改成每锁随机 token, 必须让 Unlock 使用持有 token 的同一对象。
- 租期要覆盖临界区最坏耗时, 但不能远大于它 — 持有者崩溃后, 租期就是恢复延迟。

## 8. consistent_hash: ZSET 实现的哈希环 [#chapter-8]

**问题域**: N 个节点分摊 M 个 key, 节点增减时尽量少搬数据; 分布式场景还要解决 "环本身存哪、并发改环怎么互斥"。

**数据结构 (redis 实现)**: 环本身是一个 ZSET `redis:consistent_hash:ring:{key}`, score = 虚拟节点的哈希值, member = **同一 score 的节点 key JSON 数组** (哈希碰撞的节点共存于一个 score); 另有 HASH `redis:consistent_hash:ring:node:replica:{key}` (节点 → 虚拟节点数) 与 STRING `redis:consistent_hash:ring:node:data:{nodeID}` (该节点当前负责的 dataKey 集合, 供迁移用)。所有环操作先拿环锁 (redis_lock)。

**核心操作 (`consistent_hash.go`)**:

- `AddNode(id, weight)`: 重复节点报错; `replicas = clamp(weight,1,10) * opts.replicas` (默认 5, taskflow weight=1 即 5 个虚拟节点); 逐个虚拟节点: `score = encrypt("{id}_{i}")` 写入 ZSET, 再 `migrateIn` — 用 Ceiling 找顺时针邻居, 把落在新区间的 dataKey 交给 `Migrator` 回调。
- `GetNode(dataKey)`: `score = encrypt(dataKey)` → `Ceiling` 取不小于 score 的最小虚拟节点, **没有就环绕取最小 score** (环为空返回 -1) → 反查 member 数组取第一个节点 key → `strings.LastIndex("_")` 还原节点 ID → 把 dataKey 记进该节点的 dataKeys。
- `RemoveNode`: 逆操作, 逐个虚拟节点 `migrateOut` 后从 ZSET 删除。

taskflow 的 `RingMigrator` 只打日志 (角色归属没有实体数据要搬); `IsOwner` 失败时 fail-open。

**开发坑**:

- GetNode 也会写 Redis (记录 dataKey), 不是纯读操作; 高频调用要评估。
- 心跳驱逐依赖 "别人替我删" — 每个存活节点都在心跳循环里检查并驱逐死节点; Redis 被整体清空后, 环不会因心跳存在而自动重建, 需要重新 AddNode。
- 虚拟节点默认 5 个/单位权重, 节点很少时分布偏差可观; 组件另有 local 内存环实现可对比阅读。

## 9. consistent_cache: 带写禁窗口的 cache-aside [#chapter-9]

**问题域**: 缓存与 DB 并发更新时的经典竞态 — "先删缓存再写库" 会被慢读者回填旧值; "先写库再删缓存" 仍有窗口。组件的答案: 给每个 key 一个短暂的**禁回填标记**。

**结构**: `Service{cache Cache, db DB, opts}`; `Object` 接口 (Key/Read/Write, taskflow 用 `ScheduledTaskObject`/`ConditionTaskObject`, KeyColumn "id", JSON 序列化)。选项: `cacheExpireSeconds` 默认 60、`disableExpireSeconds` 默认 10、`enableDelayMillis` 默认 1000、`WithCacheExpireRandomMode` 让 TTL 变 `[base, 2*base]` 随机 (防雪崩)。

**写路径 `Put`**:

```text
Disable(key): SETEX Enable_Lock_Key_{key} "1" disableExpireSeconds   // 禁回填窗口
Del(key)
db.Put(obj)
异步 goroutine (1s context): Enable(key) = PEXPIRE 标记到 enableDelayMillis
```

**读路径 `Get`**: cache hit → `obj.Read(v)`; 值是 `NullData` 哨兵 → 返回 `ErrorDataNotExist` (空值也缓存, 防穿透); miss → `db.Get`, DB 也没有 → `PutWhenEnable(key, NullData, ttl)`; DB 有 → `PutWhenEnable(key, value, ttl)`。`PutWhenEnable` 是一段 Lua: 检查禁回填标记存在就返回 0 放弃写入, 否则 `SET key value EX ttl` — **慢读者在窗口内的回填会被拒绝**。

taskflow 的配置: TTL 60s + 随机模式, `WithDisableExpireSeconds(1)`。`SyncDrift` 定期对比缓存与 DB 序列化值修复漂移。

**开发坑**: 先删后写允许读者回填旧值; 先写后删仍可能被更早出发的慢读者回填 — 禁回填标记把窗口压缩到毫秒级, 但不能消除所有竞态, 对状态敏感的字段应以 SQL 条件更新为准; 缓存 TTL 到期本身也是一次被动失效, 随机化只缓解并发热点。

## 10. yukino_cache: 带预算与 peers 的分组缓存 [#chapter-10]

**问题域**: 进程内缓存要回答四个问题 — 内存上限怎么控 (预算)? 同 key 并发 miss 怎么防击穿 (singleflight)? 多节点怎么共享 (peers)? 过期怎么清?

**Group 模型 (`group.go`)**: `NewGroup(name, cacheBytes, getter, opts...)` 注册进全局 map (重名 panic); `WithExpiration` 设条目过期; `WithPeers`/`RegisterPeers` 挂 PeerPicker。`Get` 路径:

```text
mainCache.Get → hit 返回
miss → loader.Do(key, fn)          // singleflight: sync.Map + WaitGroup, panic 也包装成 error
  fn: 再查一次 mainCache (double-check)
      → peers.PickPeer(key): 命中非自身 peer → peer.Get
      → 否则 getter.Get(ctx, key)  // 真正的加载
      → 写回 mainCache (带过期)
```

`Set` 写本地后, 非 peer 请求会异步 (3s 超时) `syncToPeers` 把 set/delete 推给 key 的 owner 节点 — 这是 "owner 缓存" 模型: 每个 key 由一致性哈希选一个节点主缓存, 其他节点 miss 时去 owner 拿。peer 请求带内部 context 标记, 防止节点间互相转发成环。

**存储 (`lru.go`)**: 16 个 bucket (不足则取 2 的幂), BKDR 哈希分桶, 每桶两档 LRU (L1 cap 512 / L2 cap 256); 字节预算 `MaxBytes` 平均分到每个 bucket (`maxBucketBytes`), 超预算先淘汰 L1 最旧条目, 不足再淘汰 L2; 每分钟一轮清理过期条目。默认选项 `MaxBytes 8MiB`, taskflow 给报告分组 64MiB。

**统计**: `Stats()` 输出 gets/loads/loads_deduped/local_hits/local_misses/peer_hits/peer_misses/loader_hits/loader_errors 与 hit_rate、avg_load_time_ms, 经 `/monitor/cache` 暴露。

**taskflow 的装配**: getter 解析 `exec:{id}` 从 SQL 读 `report_body`; 配置 etcd 后 `NewServer(cache_server_addr, "task-flow.reports", WithEtcdEndpoints(...))` 起 gRPC 服务并注册到 etcd, `NewClientPicker` 按服务名发现 peers。

**开发坑**: 不要在 handler 里反复 `NewGroup` 同名分组 (会 panic, 也无法复用缓存); 单 bucket 预算 = 总预算/桶数, 热点 key 集中在一个桶时会持续淘汰; peer 同步是异步尽力而为, 不是全节点广播事务 — 报告这类不可变终态内容正适合这个模型, 如果内容会修订, 应把版本放进 key。

## 11. tcc: 两阶段事务与恢复循环 [#chapter-11]

**问题域**: 多个资源操作要么都生效要么都不生效, 且不能长时间持锁。TCC 把 "预留 (Try) → 确认/取消 (Confirm/Cancel)" 建模成业务接口, 框架负责记账与恢复。

**模型 (`model.go`)**: `RequestEntity{ComponentID, Request map}`; `Transaction{TXID, Components []*ComponentTryEntity, Status, CreatedAt}`; 状态 hanging/successful/failure, 分支状态 hanging/successful/failure。`getStatus(now-Timeout)` 的判定: 任一分 failure → failure; 全 success → success; 有 hanging 且事务已超时 → failure; 否则 hanging。

**TXManager (`txmanager.go`)**: 选项默认 Timeout 5s、MonitorTick 10s (taskflow 30s / 5s)。`Transaction`: 建事务 (TXStore.CreateTX) → `twoPhaseCommit` 并行 Try (每个分支 Try 完立即 `TXUpdate` 记账; 首个错误触发 cancel) → 无论成败立刻用 `WithoutCancel` 上下文执行 `advanceProgressByTXID` (Confirm/Cancel + `TXSubmit`), 所以正常情况下二阶段不等恢复循环。恢复循环每 tick: 抢 TXStore 锁 → `GetHangingTXs` (≤200) → 8 个 worker 并行 `advanceProgress` → 解锁; 出错时 tick 翻倍退避, 上限 `MonitorTick << 3`。

**TXStore 接口** 由使用方实现。taskflow 的 `engine.TXStore`: MySQL 表 `tcc_tx_records` + redis_lock; `TXUpdate` 在 SQL 事务里 `FOR UPDATE` 读行、JSON 合并分支状态, 拒绝给非 hanging 分支改状态, 相同状态幂等; `TXSubmit` CAS hanging → 终态; 锁的 Unlock 用 `WithoutCancel` + 3s 清理 context, 保证释放动作不受调用方取消影响。

**开发坑**:

- `Transaction` 返回 `bool=true` 只表示 Try 全成功, Confirm 可能仍在进行或已交给恢复循环 — 判断最终状态要看 TX 记录与业务表。
- Cancel 查不到分支记录就直接 ACK (空回滚), 晚到的 Try 随后仍可能创建预留; 通用解法是分支 barrier/tombstone (持久记录 "本事务已决定"), 当前框架与 taskflow 实现都未包含。
- `WithMonitorTick` 过短会放大恢复循环对存储的压力; `GetHangingTXs` 一轮 200 行, 悬挂事务更多时需要多轮。

## 12. timer: cron、Bloom、worker 池与 Murmur3 [#chapter-12]

timer 是 taskflow 的工具箱, 四个子包各解决一个小问题。

**cron (`pkg/cron/parser.go`)**: 对 `robfig/cron/v3` 的薄封装, `ParseStandard` (5 段标准表达式)。`NextAfter(expr, t)` 返回**严格在 t 之后**的下一个触发点; `NextsBetween` 枚举区间内所有触发点; 解析失败或 Next 为零值都转成 error。taskflow 的 `cronx.Parse` 再包一层: 解析时校验、`Next` 出错返回零值。**坑**: 判断 "某时刻是否是合法触发点" 不能用 `Next(fireAt) == fireAt` (严格之后永远不成立), taskflow 用 `Next(fireAt - 1ns) == fireAt`。

**bloom (`pkg/bloom/filter.go`)**: 见第 5 章。两位哈希 = `murmur3.Sum128` 的两个 64 位半值分别取模, bitmap `1<<24` bit (2MiB 上限), Set 的 Lua 仅在无 TTL 时设置过期。

**hash (`pkg/hash/murmur3.go`)**: `Murmur3Encryptor` 取 `Sum128` 的 h1, `Murmur3AltEncryptor` 取 h2 — 一次哈希出两个独立位, 是 Bloom 两位的来源。

**pool (`pkg/pool/pool.go`)**: `GoWorkerPool{queue chan func()}` — 队列容量 `size*4`; `Submit` 在队列满时**阻塞** (天然背压), 池关闭返回 `ErrClosed`; worker 循环里每个任务单独 recover, 单个 panic 不杀池; `Close` 只关一次并等待全部 worker 退出。taskflow 的 monitor 用它并发跑清扫子任务。

**开发坑**: 背压意味着调用方会被拖慢 — 如果 Submit 在持锁路径上, 要评估阻塞时长; cron 语义里的时区由调用方决定 (`Next` 用传入 time 的 Location), taskflow 显式把任务 timezone 加载成 Location 再计算。

## 13. lsm_tree: 从 WAL 到 SSTable [#chapter-13]

**问题域**: 本地 KV 要同时满足写快 (顺序写)、读可接受 (分层查找)、崩溃可恢复 (预写日志)。LSM 树是标准答案。

**写路径 (`tree.go`)**: `Put(key, value)` 持 dataLock: 先 `walWriter.Write` (记录格式 = uvarint(lenK) + uvarint(lenV) + K + V, 追加写), 再 `memTable.Put` (skiplist); 当 `memTable.Size()*5/4 > SSTSize` 时冻结: 当前 memtable + WAL 文件进 `rOnlyMemTable`, 新建 WAL 与 skiplist, 冻结项异步送入 compaction 通道变成 L0 SSTable; L0 文件数超限再向更高层压实。

**读路径**: 活动 memtable → 冻结 memtables (逆序) → L0 节点 (逆序, 允许 key 范围重叠) → L1+ 用 startKey/endKey 二分定位唯一节点。新值永远在更 "年轻" 的结构里, 所以这个顺序就是版本顺序。

**恢复 (`tree_restore.go`)**: 打开时重放 WAL 到 memtable, 读取各层 SSTable 索引。

**taskflow 的配置**: MaxLevel 4, SSTSize 1MiB, 每层 4 个文件, data block 16KiB; key 前缀 `fk:`, 存派发与结果审计。

**开发坑**: WAL 写入没有逐条 fsync — 进程崩溃基本没问题, 机器断电可能丢最后一批; 多个进程不能共写一个目录 (WAL 追加互不感知); compaction 是后台 goroutine, Close 会等它完成, 不要跳过 Close 直接删目录。

## 14. raft: 从 Raft 到节点本地 ledger [#chapter-14]

**问题域**: 多个节点对 "操作的顺序" 达成一致。`components/raft` 实现了完整的日志机: leader/follower/candidate 状态文件、progress、Ready/Advance 驱动。

**Node 循环 (`raft/node.go`)**: `StartNode(conf, peers)` 后, 单个 run goroutine 用 channel 多路处理: proc (本地提案)、recvChan (网络消息)、confChan (成员变更)、tickChan (逻辑时钟)、readyChan/advanceChan (Ready 交付与应用确认)。Ready 携带 SoftState/HardState/待持久化 Entries/Messages/CommittedEntries (另有 ReadStates); 应用方持久化后 `Advance` 才产出下一个 Ready — 这是 etcd/raft 的经典背压设计。

**taskflow 的 ledger (`consensus/ledger.go`)**: 单成员装配 — `MemoryStorage`、`Config{ID: consensus.id, PreVote: true, ElectionTick: 10, HeartbeatTick: 1}`、`StartNode` 只传自己一个 peer; 100ms tick; ready loop 做 `Append` + `SetHardState` (按需)、记录软/硬状态、apply 已提交条目 (payload 为 `{k,v,t}` JSON → 写内存 state map, 保留最近 64 条) 后 `Advance`; `Propose` 2s 超时。`Status()` 输出 enabled、term、commit_index、raft_state、leader_id、is_leader、recent_entries 等供诊断。

**开发坑 / 边界**: 三个节点各自跑单成员集群**不构成**多数派集群 — 没有共同 membership 与跨节点 transport, 它展示的是 raft 状态机的装配与 Ready 协议; MemoryStorage 不落盘, 重启归零, 所以 ledger 只是审计线索不是事实来源。要把它变成真集群, 需要给每个节点配置真实 peers、实现 transport、换成持久 Storage, 并重新评估 Propose 的失败语义。

## 15. Redis 与 MySQL 一致性专题 [#chapter-15]

把散落在各章的一致性手段按模式归纳:

**模式 1: 权威 + 派生。** MySQL 是权威, Redis 的每份数据 (fire 认领、Bloom、定义缓存、执行镜像、统计) 都是派生视图, 允许丢失, 丢了由 SQL 侧重建或下一轮对账修复。判断任何状态先看 SQL。

**模式 2: 同事务意图 (outbox)。** 要发布的消息先和业务事实同事务落库 (`task_flow_outbox`), 发布是独立的可重试步骤。它回答 "XADD 成功但事务提交失败怎么办" — 意图在库里, 重发即可; 代价是可能重复发布, 消费侧靠 fire_key/tx_id 去重。

**模式 3: compare-and-write Lua。** 所有 "可能乱序到达" 的 Redis 写入都用 Lua 比较再写: 镜像写入比 `updated_at`、Bloom Set 检查 TTL、缓存回填检查禁回填标记、锁的释放/续期比较 token、镜像 prune 比较完整值。**只要写入路径可能并发, 就不要裸 SET。**

**模式 4: SKIP LOCKED 分队。** Relay 的 fanout 与 publish 都用 `SELECT ... FOR UPDATE SKIP LOCKED` 取一行, 多实例天然分工, 不需要额外的任务分配器; 注意 SKIP LOCKED 取的是 "当前未被锁住的行", 不是严格 FIFO。

**模式 5: 租约 + 接管。** 认领 (SETNX + TTL) 与锁 (redis_lock) 都是租约; 接管必须带条件判断 (Dispatcher 的 5 分钟 stuck 判断、XAUTOCLAIM 的 min-idle), 不能仅凭租约过期就行动。

**模式 6: 快照而非引用。** 执行行存 `prompt_snapshot`/`model_snapshot`, change 行存 `record_json` — 事件语义以发生时刻的快照为准, 后续定义修改不影响已物化的执行 (取消与校验是显式产品决策, 见 Dispatcher 的定义校验)。

## 16. 集群同步与对账专题 [#chapter-16]

集群里没有主节点, 协调全靠三样东西: 心跳、哈希环、清扫器。

**成员生命周期**: Register (心跳 + AddNode) → 15s 心跳循环 (顺带驱逐死节点) → Deregister (停循环 + RemoveNode + 删心跳)。IsOwner fail-open 保证环故障时角色不真空, redis_lock 保证同一时刻实际只有一个节点在跑 migrator/monitor 的临界区。

**执行镜像的对账算法** (值得逐行读 `storage/mirror.go`): 固定窗口轮扫而非增量 binlog 订阅 — 因为旧行也会更新。每轮: 读游标 → 首扫确定 `max_id` → `id > last_id AND id <= max_id ASC LIMIT 500` → Lua 版本化写入 (拒绝旧 updated_at) → Hash 续期 7 天 → 扫满或到尾归零游标 → HSCAN prune 过期终态条目 (compare-and-HDEL) → 持久化游标。`TestMirrorReconcilesBeyondFirstPage` 验证了两点: 601 行分两轮 (每轮 500) 全部同步, 以及最旧行的后续状态变更仍会被扫到。

**统计快照**: publishStats 每轮把当日状态计数 + 角色 owner + 镜像大小写进 `task_flow:monitor:stats` (TTL 2 分钟) — 读侧永远拿到 "至多 2 分钟前" 的视图, 且 Redis 丢失时自动重新生成。

**副本观测**: Fleet 持有只读副本的小连接池, `/monitor/storage` 汇总复制线程状态与延迟 — 报告里引用副本数据时要意识到读的是副本。

**开发坑**: 心跳存在不等于环完整 (Redis 清空后要重新注册); limit 200 的头部扫描在头部行持续失败时会让后部行饥饿, 需要分页/公平游标改进; 统计 TTL 到期窗口内的查询会 miss, 读侧应容忍空值。

## 17. LLM 工具、并发与可观测性专题 [#chapter-17]

**工具沙箱的设计取舍**: 给模型 DB 权限, 就用策略把伤害面收窄 — 读有行数/字节预算, 写有白名单动词 + 控制表黑名单, Redis 有前缀隔离 + 操作白名单 + 大小上限。词法器拒绝注释与多语句是为了堵住 "注释里藏指令" 这类绕过; 数据 (行内容) 永远可能被污染, 所以 system prompt 显式要求不执行数据中的指令。**坑**: `allow_sql_writes` 打开后, 工具写出的数据没有事务边界与幂等保护, 应默认关闭。

**goroutine 生命周期**: 长驻循环 (migrator/monitor/relay/registry/consumer) 都是 "Start 起 goroutine + stopChan + doneChan, Stop 等待 done" 的模式; 临时并发走 pool (monitor) 或每任务一 goroutine (时间轮回调执行)。所有循环体都有 recover → CapturePanic。

**context 纪律**: 请求 context 取消后仍必须完成的动作用 `context.WithoutCancel` + 新超时 — finalize (15s)、TCC 二阶段、TXStore Unlock、派发后的审计 (bloom/journal/ledger)。反例: 用请求 ctx 做落账, 客户端断连就会丢终态。`TestDuplicateCommandsRunToolsOnceAndPersistMarkdown` 专门验证了 "已取消的 context 仍能把 failed + 报告写进去"。

**可观测性边界**: trace 经 MQ carrier 跨进程; Sentry 与 OTel 不自动互通 (trace_id 需要显式进入 obsx context); telemetry exporter 的 file 模式是 JSONL 追加, 无轮转。

## 18. 动手实验 [#chapter-18]

所有实验只依赖仓库自带文件。用隔离的 MySQL schema 与 Redis DB, 不要用共享环境。

### 18.1 实验 1: 单机 compose 起步

```sh
cd apps/task_flow
cp .env.example .env        # 填入 OPENAI_API_KEY 等
docker compose up -d --build
curl -sS http://127.0.0.1:8090/api/v1/health
curl -sS http://127.0.0.1:8090/api/v1/ready
```

server 健康检查打 `/api/v1/ready`, 客户端在 `CLIENT_PORT` (默认 8080)。未配置 `TASK_FLOW_API_TOKEN` 时 API 无需认证; 配置后:

```sh
curl -sS -H "Authorization: Bearer $TASK_FLOW_API_TOKEN" http://127.0.0.1:8090/api/v1/scheduled-tasks
```

### 18.2 实验 2: 跑单元测试

```sh
cd apps/task_flow/server
go test ./internal/engine/ -run 'TestScheduleEditsInvalidateOnlyNonMatchingFires|TestDelayedScheduledWindowUsesFireTime' -v
```

前者验证 `matchesSchedule`: `0 10 * * *` (Asia/Shanghai) 认 UTC 02:00 的 fire, 改成 `0 11 * * *` 或非法 cron 后拒绝; 后者验证延迟执行时审计窗口仍以 FireAt 为基准。

### 18.3 实验 3: 集成测试 (受控故障)

集成测试在 `//go:build integration` 之后, 需要真实 MySQL + Redis:

```sh
cd apps/task_flow/server
TASK_FLOW_INTEGRATION=1 MYSQL_PASSWORD=*** go test -race -tags integration ./internal/engine -count=1
```

fixture 会为每次运行创建 `task_flow_it_{纳秒}` 数据库与按库名隔离的主题/组, Redis 用 DB 15, 结束时删库清键。六个测试与观察点:

| 测试                                                  | 观察什么                                                                                                                                                       |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TestTransactionalCaptureAndConcurrentRelay`          | 回滚事务不产生事件; 4 个并发 Relay 对 20 条 INSERT 恰好物化 20 个执行; 重复 `InsertPending` 解析回同一 ID; 无主键 + POINT 列的新表也能捕获                     |
| `TestDuplicateCommandsRunToolsOnceAndPersistMarkdown` | 32 并发 Dispatch 只落一条 queued; 32 并发 handle 只跑一次模型 (mock provider 恰被调用 2 次); 迟到的 finalize 覆盖不了终态; 已取消 context 仍能落 failed + 报告 |
| `TestOutboxSurvivesRedisOutage`                       | Redis 离线时发布失败但 outbox 保留; 恢复后恰好补发一条且不重复执行                                                                                             |
| `TestAbandonedMessageRecovery`                        | 崩溃消费者未 ACK 的消息被 XAUTOCLAIM 接管                                                                                                                      |
| `TestBloomRequiresBothBitsAndBoundsMemory`            | 单个位不构成存在性; bitmap ≤ 2MiB; 有 TTL                                                                                                                      |
| `TestMirrorReconcilesBeyondFirstPage`                 | 601 行跨页全部同步; 最旧行的更新仍被对账                                                                                                                       |

### 18.4 实验 4: 观察触发器的事务边界

连接隔离库:

```sql
BEGIN;
INSERT INTO risk_records (title, content, source, created_at)
VALUES ('tutorial-rollback', '<script>alert(1)</script>', 'tutorial', UTC_TIMESTAMP(6));

SELECT id, event_key FROM task_flow_changes
WHERE table_name = 'risk_records'
  AND JSON_UNQUOTE(JSON_EXTRACT(record_json, '$.title')) = 'tutorial-rollback';

ROLLBACK;
-- 再查一次: 事务内可见的 change 行应随回滚消失
```

再提交一条并观察 Relay 处理:

```sql
INSERT INTO risk_records (title, content, source, created_at)
VALUES ('tutorial-commit', '<img src=x onerror=alert(1)>', 'tutorial', UTC_TIMESTAMP(6));

SELECT id, event_key, operation, occurred_at, processed_at
FROM task_flow_changes WHERE table_name = 'risk_records' ORDER BY id DESC LIMIT 10;

SELECT id, task_type, fire_key, status, tx_id FROM executions ORDER BY id DESC LIMIT 10;
```

条件任务必须 enabled 且监听 `risk_records`。处理完成后 execution 的 fire_key 形如 `cond:{taskId}:change:{eventUUID}`。注意: 把相同内容再 INSERT 一次是两个独立事件 (两个 UUID), 不是 "重试"。

### 18.5 实验 5: 用同一 Idempotency-Key 重试手动触发

```sh
curl -sS -X POST -H "Authorization: Bearer $TASK_FLOW_API_TOKEN" \
  -H 'Idempotency-Key: tutorial-manual-001' \
  http://127.0.0.1:8090/api/v1/scheduled-tasks/1/trigger
# 再执行一次完全相同的请求
```

两次响应应指向同一执行 (相同 fire key `manual:{id}:{sha256}`)。查询与报告:

```sh
curl -sS -H "Authorization: Bearer $TASK_FLOW_API_TOKEN" http://127.0.0.1:8090/api/v1/executions/{id}
curl -sS -H "Authorization: Bearer $TASK_FLOW_API_TOKEN" http://127.0.0.1:8090/api/v1/executions/{id}/report
```

此实验会调用真实模型; 只想验证协议用 mock 集成测试。

### 18.6 实验 6: 观察 MQ 状态而不修改消息

```sh
redis-cli XLEN task-flow.exec.commands
redis-cli XINFO GROUPS task-flow.exec.commands
redis-cli XPENDING task-flow.exec.commands task-flow-exec
redis-cli XLEN task-flow.cond.events
```

区分三种数量: XLEN 是 Stream 保留的消息总数 (含已 ACK); XPENDING 是已投递未 ACK; 组 lag 是尚未投递的积压。ACK 不会删除 entry, 不要用 XLEN 当待执行数。

### 18.7 实验 7: 按层排查 pending 不运行

```sql
SELECT id, fire_key, status, tx_id, fire_at, claimed_at, started_at, updated_at, error
FROM executions WHERE id = {id};
SELECT id, event_key, published_at FROM task_flow_outbox ORDER BY id DESC LIMIT 10;
SELECT id, status, created_at FROM tcc_tx_records ORDER BY created_at DESC LIMIT 10;
```

| SQL 状态                | 下一步查什么                                                    |
| ----------------------- | --------------------------------------------------------------- |
| 没有 execution          | 任务 enabled / cron / CreatedAt、capture 触发器、Relay 是否运行 |
| pending, fire_at 在未来 | 正常等待                                                        |
| pending 已过期          | 时间轮回调、Dispatcher、角色 owner、Redis 认领、monitor 补发    |
| reserved                | TCC 分支状态与恢复循环 (`tcc_tx_records`)                       |
| queued                  | exec 消费组、命令 tx_id、monitor 是否补发                       |
| running                 | 模型/工具耗时、executor 超时、节点存活                          |
| failed                  | SQL error 与报告, 区分业务失败与基础设施失败                    |
| succeeded               | report_body / 报告文件 / 缓存                                   |

### 18.8 实验 8: 观察镜像与副本状态

```sh
redis-cli HSCAN task_flow:exec:status 0 COUNT 20
redis-cli GET task_flow:exec:status:cursor
curl -sS -H "Authorization: Bearer $TASK_FLOW_API_TOKEN" http://127.0.0.1:8090/api/v1/monitor/mirror
curl -sS -H "Authorization: Bearer $TASK_FLOW_API_TOKEN" http://127.0.0.1:8090/api/v1/monitor/storage
curl -sS -H "Authorization: Bearer $TASK_FLOW_API_TOKEN" http://127.0.0.1:8090/api/v1/monitor/nodes
```

观察同一执行从 SQL 终态到 Redis Hash 更新的延迟; 游标一轮扫完归零是设计行为, 不是进度丢失。

### 18.9 实验 9: 多节点与故障恢复

在专用环境进行, 每次只制造一种故障:

1. A/B 两节点指向同一 SQL 与 Redis, 不同 `node.id`、不同端口与 journal 目录。
2. 同一 `Idempotency-Key` 并发触发, SQL 里只应有一条执行。
3. 暂停一个正在消费但未 ACK 的节点, 观察另一节点经 XAUTOCLAIM 接管。
4. 暂停 Redis 发布路径, 提交业务 INSERT, 确认 changes/execution/outbox 完好。
5. 恢复 Redis, 观察 outbox 补发与执行终态。
6. 让 worker 在 running 时退出, 观察 failStuckRunning 最终标记 failed 且不会自动重跑模型。

多节点部署要额外核对时间轮 callback 地址: `BaseURL` 必须指向集群内可达的入口 (单节点的 loopback 地址在多机不可用), 且收到回调的节点必须跑同一套 SQL 校验逻辑。故障注入命令取决于你的进程管理方式, 优先复用集成测试的受控 fixture。

### 18.10 实验 10: 修改 cron/prompt, 理解快照语义

创建一个每分钟触发的定时任务, 等 Migrator 物化出执行后分别验证:

- 改 prompt: 已物化执行保持 `prompt_snapshot`, 新执行才用新 prompt。
- 禁用任务: 计划派发时 Dispatcher 的定义校验会把 pending 执行迁到 cancelled。
- 改 cron: 已物化且仍匹配新 cron 的 fire 保留 (`matchesSchedule`), 不匹配的被取消。
- `POST /condition-tasks/:id/test` 可以对禁用任务做明确的单条测试。

这是调度产品语义而非缓存失效问题; 若需求变成 "未运行执行一律用最新 prompt", 应设计受控的批量修订与审计。

## 19. 开发常见坑与解法清单 [#chapter-19]

按开发场景给出定位顺序。

### 19.1 修改任务定义

- **GORM struct 更新忽略零值**: `Updates(po.ScheduledTask{Enabled: false})` 可能跳过 false/空串。当前实现全部走显式 map 更新, 新字段延续这种方式。
- **读对象后整体 Save**: 两个并发写者互相覆盖。只更新自己拥有的字段, 敏感变化加 WHERE 旧状态 — `next_fire_at` 的更新带 `cron_expr`/`timezone` 条件就是这个模式。
- **拿缓存的 enabled 做执行决策**: 缓存可能短暂滞后。scheduled 派发在 SQL 重查定义与 cron; 新增执行入口也必须经过 Dispatcher 的权威校验。

### 19.2 新增一种条件事件

- **API 写入后手动发消息, 而触发器已捕获**: 两条路径若用不同 fire key, 同一 INSERT 变成两个执行。主路径是 trigger → changes → relay → outbox; `PublishRecordInserted` 是辅助路径, 接入前必须分析 key 协议。
- **用行 ID 当事件 ID**: 同一行会多次变化, 提交顺序不等于 ID 分配顺序。insert 事件用 UUID; 新增 update 事件要定义每次变化的 event key 与新旧快照。
- **给 executions 装捕获触发器**: 平台自更新会引发反馈循环。`ValidWatchTable` 排除 `executions` 等控制表。
- **只看当前业务行**: 行可能被删改。主路径在事件时刻保存 `record_json` 快照。

### 19.3 修改 schema 或 capture

当前捕获边界: 触发器安装前的历史无 baseline; 只有 INSERT/DELETE; `enabled` 在 relay 时判断。

- **新表不会自动被发现**: 启动扫描发生在一个时刻, 新表要显式安装或重启触发启动扫描; 没有公开的 "重建全部 capture" API。
- **新增列不会自动进入旧触发器**: 触发器 JSON 在安装时按列生成, 同名触发器存在即跳过。改列的受控步骤: 停写入 → 查 `information_schema.TRIGGERS` 确认触发器名 → 删除这两个触发器 → 应用 DDL → 重启服务或更新 condition definition 触发 EnsureCapture → 核对 ACTION_STATEMENT 的列布局与 INSERT/DELETE 各一 → 用 BEGIN/INSERT/ROLLBACK 验证事务边界后恢复写入。
- **TRUNCATE 不是行级事件**: 不能用它推导删除数; 需要 DDL 审计或禁用此类操作。
- **自增 ID 差值不是新增条数**: rollback/删除/并发都影响 ID, 统计以 `changes.operation` 计数。

### 19.4 修改调度与时间

- **本地时间字符串直接写 UTC 字段**: 用 IANA timezone 解析计划, 瞬间以 UTC 持久化; 前端显示的 10:00 与 SQL 的 02:00 可以是同一时刻。
- **固定减 24 小时算上一自然日**: 夏令时地区一天可能不是 24 小时; 日界用 Location 的 `AddDate` 日历语义再转 UTC (提示词窗口就是这么算的)。
- **`cron.Next` 包含当前时刻**: 它是严格之后; 匹配判断用 `Next(fireAt - 1ns) == fireAt`。
- **拉长停机后期待自动补全**: 物化只回看 `overdue_recover_minutes` (默认 2 分钟); 更早的计划需要显式 backfill, 沿用 sched fire key。
- **`last_fire_at` 被晚完成者覆盖**: 两个计划可逆序完成, 当前更新不是单调条件; 需要 "显示不倒退" 时用 `WHERE last_fire_at IS NULL OR last_fire_at < ?` 类条件。

### 19.5 修改幂等与状态

- **认领 TTL 过期就当可重跑**: SQL 唯一索引与终态仍在; TTL 只是快标记生命周期。
- **重试换新 UUID/fire key**: 这是新执行。修复投递沿用原 key, 明确重跑用新 manual key 并保留原执行。
- **terminal 改回 pending 当修复**: 旧 worker 副作用可能已发生; running 崩溃标 failed 不自动重启是有意设计。
- **UPDATE 不带旧状态与 tx_id**: 用 `TransitionOwned` 并检查 `RowsAffected`, 0 行不是成功。
- **删 fire_key 历史省空间**: 去重依赖事实保留; 归档也应保留唯一键 tombstone。

### 19.6 修改 MQ / 消费者

- **绕开消费组自己 XRANGE + DEL**: 失去 pending/ack/claim 机制。
- **模型失败让消息无限重试**: Executor 认领后, 模型失败写 SQL failed 并正常 ACK; MQ 重试针对 handler 未完成的基础设施错误。
- **调大 MaxLen 解决积压**: 还要看吞吐、pending age、lag 与内存; noeviction 满内存会让发布失败, outbox 保留意图。
- **死信等于可靠一次写入**: 先落 SQL 再 ACK 仍有重复窗口, 处理死信前检查同一 message ID 是否重复。

### 19.7 修改锁与 TCC

- **只看锁过期不校验 token**: 必须 compare-and-delete/compare-and-expire; 当前 token (PID+goroutine) 有跨进程碰撞风险, 修法是唯一 token + 句柄持有。
- **改 token 生成后环的 Lock/Unlock 仍新建对象**: Unlock 必须能拿到加锁时的 token。
- **Cancel 查不到预留就视为完成**: 晚到 Try 可能随后创建 reserved; 完整方案需要分支 barrier/tombstone。
- **`Transaction` 返回 true 当 Confirm 已完成**: 二阶段可能交给恢复循环; 用 TX 记录与业务状态判断, `TXSubmit` 才是总体状态的持久化点。

### 19.8 修改缓存、报告与本地存储

- **每请求 NewGroup**: 同名注册会 panic, 缓存也无法复用; 进程初始化一次。
- **单 key 很大就安全**: 16 桶共享预算, 热点桶会持续淘汰; 预算只计缓存数据, 不等于进程 RSS。
- **peer Set 后全节点立即一致**: peer 同步是异步尽力而为; 不可变内容 (报告终态) 才适合这个模型。
- **本地有 .md 就判断 succeeded**: 文件与 SQL 不是事务, 以 SQL 终态为准。
- **多节点 journal 指向同一目录**: LSM 不支持多进程共写 WAL, 用节点独立卷。
- **WAL Write 返回即断电安全**: 无逐条 fsync; 业务事实留 SQL。

### 19.9 调试多节点部署

- **node id 相同**: 心跳、角色、诊断身份互相覆盖; 默认 `{hostname}-{pid}`, 容器里显式配置唯一 id。
- **localhost 理解成别的容器**: 它指当前进程的网络命名空间; callback、cache advertised address、MySQL/Redis 地址要分别验证。
- **只复制 server 目录构建镜像**: replace 指向仓库组件目录, Dockerfile 的 build context 是仓库根并逐个 COPY 这些模块。
- **Redis 空库恢复后以为环正常**: 心跳存在不会重建环, 需要注册重对账。
- **limit 200 的对账不会饿死**: 头部行持续不可处理会影响后部行, 需要分页游标与退避隔离。

### 19.10 先修什么, 如何验证

| 优先问题            | 改法                              | 验证                                     |
| ------------------- | --------------------------------- | ---------------------------------------- |
| 锁 token 唯一性     | 每次加锁唯一 token, Unlock 持句柄 | 两进程 PID 相同也无法互解                |
| TCC 空回滚/晚到 Try | 分支 barrier + 幂等阶段记录       | Cancel 先于 Try 时迟到 Try 不留 reserved |
| 环数据丢失恢复      | 周期性重建本节点登记并核对        | 清空环后自动恢复 owner                   |
| 镜像/缓存版本       | SQL 单调 revision + Redis CAS     | 乱序写入不倒退                           |
| 对账公平性          | 分页游标 + 退避 + 隔离异常行      | 头部故障不饿死后部                       |
| Sentry trace 关联   | 从 OTel SpanContext 桥接          | 错误事件可关联执行 trace                 |
| 时间轮桶时区        | UTC/Unix 分钟键统一切片           | 跨时区主机 + DST 用例                    |

测试要围绕故障窗口与业务结果 ("两条消息但一次模型运行"、"发布后 SQL 回滚仍能恢复"、"旧 worker 无法覆盖终态"), 而不是只验证函数被调用。

## 20. 术语、自测题与源码阅读路线 [#chapter-20]

### 20.1 术语表

| 术语                     | 初学者解释                            | taskflow 中的例子                            |
| ------------------------ | ------------------------------------- | -------------------------------------------- |
| 权威来源 source of truth | 冲突时以哪份事实为准                  | execution 状态以 MySQL 为准                  |
| 原子性                   | 一组动作整体发生或整体不发生          | relay fanout 的同事务写入                    |
| 持久性                   | 重启后仍能恢复的已确认事实            | MySQL 数据; 内存 ledger 不算                 |
| 幂等                     | 同一逻辑操作重试不产生额外效果        | 相同 fire key 复用 execution                 |
| CAS                      | 仅当旧值符合时更新                    | `WHERE status='queued' AND tx_id=?`          |
| 租约                     | 带过期时间的临时授权                  | migrator 锁、fire 认领 TTL                   |
| at-least-once            | 消息可能重复投递                      | Streams pending/claim/重试                   |
| at-most-once claim       | 一次执行只允许一次成功抢占            | queued → running CAS                         |
| outbox                   | 与业务同事务的待发布意图              | `task_flow_outbox`                           |
| CDC                      | 捕获数据库变化                        | INSERT/DELETE 触发器                         |
| PEL                      | 消费组已投递未确认列表                | XPENDING                                     |
| dead letter              | 反复失败后隔离的消息                  | `mq_dead_letters`                            |
| 时间轮                   | 按时间槽组织延迟任务                  | monitor 本地轮; Redis 分钟桶轮               |
| jitter                   | TTL 加随机偏移                        | 定义缓存 60..120s                            |
| singleflight             | 同 key 并发 miss 只加载一次           | 报告 getter                                  |
| LRU                      | 淘汰最近最少使用                      | 报告缓存桶                                   |
| consistent hash          | 节点变化尽量少改映射                  | migrator/monitor owner                       |
| 虚拟节点                 | 一个真实节点占多个环上点              | 默认 replicas = 5                            |
| Bloom filter             | 固定 bitset 的有误判集合预检          | 每日 fire key 预检                           |
| false positive           | 不在集合却报可能存在                  | Bloom 命中后仍要查 SQL                       |
| TCC                      | Try 预留 / Confirm 确认 / Cancel 取消 | reserve + mq_dispatch                        |
| barrier                  | 持久记录分支阶段防晚到步骤            | 当前 TCC 的可增强项                          |
| WAL                      | 更新前写的恢复日志                    | journal 的 LSM WAL                           |
| MemTable                 | 内存中的近期写入有序结构              | LSM skiplist                                 |
| SSTable                  | 不可变按 key 排序的磁盘文件           | LSM 落盘层                                   |
| compaction               | 合并文件并丢弃旧版本                  | LSM 后台压实                                 |
| Raft term                | 选举代次                              | ledger Status 的 term                        |
| quorum                   | 决议所需法定数量                      | 多节点 raft 多数派; taskflow ledger 无跨节点 |
| replica lag              | 副本暂时落后主库                      | SHOW REPLICA STATUS                          |
| hash slot                | Redis Cluster 路由单位                | 16384 slots                                  |
| Trace/Span               | 因果链 / 链中一步                     | HTTP → 派发 → 工具                           |
| snapshot                 | 某时刻使用内容的留存                  | prompt_snapshot / record_json                |
| reconcile                | 用权威修复派生状态                    | SQL → Redis 镜像                             |
| backpressure             | 下游慢时限制上游堆积                  | pool.Submit 阻塞                             |

### 20.2 自测题与参考答案

先不看答案自己答一遍。

1. 两个节点同时收到同一个 10:00 回调, 最终靠什么保证只创建一条执行? — 同一计划点生成同一 sched fire key, SQL 唯一索引保证一行; queued → running 的 CAS 再保证一次抢占; Redis 层只是前置优化。
2. SETNX 认领过期或丢失, 为什么不能把 succeeded 再跑一次? — SQL 的 fire key 行与终态仍是权威, TTL 不是业务授权。
3. XADD 成功但 outbox 事务提交失败, 丢消息还是重复? — outbox 未提交意味着意图仍在库里 (或随业务回滚一并消失); 重发路径可能重复投递, 消费侧靠 fire_key/tx_id 去重。
4. running worker 崩溃为什么标 failed 而不是重回 queued? — 工具副作用可能已发生, 自动重跑有重复风险; 需要重跑时用新的 manual key。
5. 时间轮解决什么问题, 为什么不能替代唯一索引? — 它高效组织 "何时尝试触发", 不知道逻辑事件是否已执行。
6. 定义缓存先删后写、先写后删各剩什么问题? — 前者允许慢读者回填旧值; 后者仍可能被更早出发的慢读者回填; 禁回填标记 + TTL + 对账压缩窗口。
7. Bloom 报 "可能存在" 能直接丢弃任务吗? — 不能, 有 false positive, 必须查 SQL 复核。
8. mq_dispatch.Try 先发了消息、reserve 还没落库, Executor 怎么办? — awaitSettled 轮询等待, 验证 execution_id/fire_key/tx_id, 门控不通过不跑模型。
9. 两个事务先分配 ID 100/101, 101 先提交, CDC 为什么不能只扫 id 大于 101? — ID 是分配序不是提交序, 低 ID 迟提交会被永久跳过; relay 按 `processed_at IS NULL` + 行锁取任务。
10. 镜像游标为什么到末尾又从头扫? — 旧执行也会有状态更新, 固定窗口轮扫保证老 ID 再被看到。
11. 三个节点各自的 raft ledger 是三成员集群吗? — 不是, 各自单成员 + MemoryStorage, 无共同 membership 与 transport。
12. 昨天 10:00 的计划今天才运行, 报告窗口按哪个时刻? — 按 `FireAt` 及其 timezone 计算计划窗口再转 UTC。
13. 09:59 的 INSERT 在 10:00 报告后才提交, 一定在原报告里吗? — 不一定, `occurred_at` 是触发器时刻, 未提交行不可见; 精确结算需要水位或修订机制。
14. 有 Sentry 和 OTel, error 事件就自带 trace_id 吗? — 不一定, obsx 读自己的 context key, 需要显式传递; 空 DSN 时根本不上报。
15. 相同内容 INSERT 两次算重复消息吗? — 不算, 每次成功提交都是独立 change UUID; 重复是同一事件被运输多次。

### 20.3 推荐源码阅读顺序

先沿一条执行追踪, 再进入组件内部:

| 顺序 | 文件                                                 | 阅读时找什么                                   |
| ---- | ---------------------------------------------------- | ---------------------------------------------- |
| 1    | `cmd/task_flow/main.go`                              | 依赖装配顺序、Start/Stop                       |
| 2    | `internal/model/po/po.go`                            | fire_key/status/tx_id/快照列、唯一索引         |
| 3    | `internal/dao/dao.go`                                | InsertPending 回查、Transition/TransitionOwned |
| 4    | `internal/engine/migrator.go`                        | 物化窗口、先落库再挂轮、next_fire_at 条件写    |
| 5    | `internal/cdc/capture.go`                            | 触发器安装、列快照、控制表排除                 |
| 6    | `internal/cdc/relay.go`                              | SKIP LOCKED、fanout 事务、发布阶段             |
| 7    | `internal/engine/dispatcher.go`                      | 定义校验、四层防线入口、TCC 调用               |
| 8    | `internal/engine/tccstore.go`                        | SQL 记账、FOR UPDATE、恢复锁                   |
| 9    | `internal/engine/executor.go`                        | awaitSettled 门控、抢占 CAS、finalize          |
| 10   | `internal/engine/monitor.go`                         | 五步清扫与各自阈值                             |
| 11   | `internal/storage/mirror.go`                         | 固定窗口、Lua 版本比较、游标与 prune           |
| 12   | `internal/engine/definitions.go`                     | 缓存前缀、更新包装、漂移修复                   |
| 13   | `internal/engine/report.go`                          | 原子写、frontmatter、Warm/Load                 |
| 14   | `internal/llm/agent.go`、`tools.go`、`sql_policy.go` | 工具循环、预算与策略                           |
| 15   | `internal/engine/integration_test.go`                | 故障如何构造、业务结果如何断言                 |

组件入口见第 2 章表格。官方资料可配合阅读: [MySQL trigger syntax](https://dev.mysql.com/doc/refman/8.4/en/trigger-syntax.html)、[MySQL locking reads](https://dev.mysql.com/doc/refman/8.4/en/innodb-locking-reads.html)、[Redis XREADGROUP](https://redis.io/docs/latest/commands/xreadgroup/)、[Redis XACK](https://redis.io/docs/latest/commands/xack/)、[Redis XAUTOCLAIM](https://redis.io/docs/latest/commands/xautoclaim/)、[Redis distributed locks](https://redis.io/docs/latest/develop/clients/patterns/distributed-locks/)、[Redis Cluster specification](https://redis.io/docs/latest/operate/oss_and_stack/reference/cluster-spec/)、[MySQL GTID concepts](https://dev.mysql.com/doc/refman/8.4/en/replication-gtids-concepts.html)、[Raft paper](https://raft.github.io/raft.pdf)。项目自带的 `docs/architecture.md`、`docs/operations.md` 与 `README.md` 可与本文对照。

代码变化后, 优先重新核对四处: `go.mod` 的 replace 清单、main 的装配顺序、DAO 的状态迁移条件、各恢复循环的阈值 — 它们共同决定每个组件如何影响业务可靠性。
