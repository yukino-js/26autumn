---
title: "后端"
description: "后端栏目: Go 语言与运行时、MySQL/Redis/ClickHouse/Kafka 与后端中间件、generic-pool 源码解析, 以及 Yukino Go 系列的 HTTP/RPC/ORM/缓存/网关、基础设施组件与 AI 应用"
---

后端方向的系统性技术笔记, 按主题分为三部分, 共 16 个页面 (含本落地页).

## 第一部分: 语言基础

| 页面     | 内容概要                                                                                                                                                             |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [go](go) | Go 语言核心与底层原理: 值语义与内置结构、方法集与接口、泛型与迭代器、GMP 调度与 channel、context 与 sync、内存分配与逃逸分析、GC, 以及测试、性能诊断与跨平台构建实践 |

## 第二部分: 存储与中间件

| 页面                                 | 内容概要                                                                                                                                                          |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [mysql](mysql)                       | MySQL 与 InnoDB: 连接与 SQL 执行流程、物理结构与索引体系、MVCC 与锁、redo/undo/binlog 与崩溃恢复、主从复制、分库分表与在线 DDL、缓存一致性与慢查询调优            |
| [redis](redis)                       | Redis 7.x: 数据结构与底层编码、单线程与 IO 多线程模型、RDB/AOF/混合持久化、过期与淘汰、主从哨兵与 Cluster、缓存设计、分布式锁、限流与延时队列、大 key/热 key 治理 |
| [clickhouse-kafka](clickhouse-kafka) | ClickHouse 列式存储、MergeTree 家族、稀疏索引、副本与分布式查询, 与 Kafka 的存储模型、ISR 与 Leader 选举、投递语义、事务与调优, 以及两者的联合实时数仓架构        |
| [middleware](middleware)             | etcd、Kafka、groupcache、gRPC、Prometheus、Grafana、OpenTelemetry 与 Redis Stack 向量存储的核心机制、生产注意事项与选型建议                                       |
| [node-pool](node-pool)               | generic-pool 3.9.0 源码解析: 借还生命周期、工厂契约、超时排队、双向链表与优先级队列、空闲驱逐与配置默认值                                                         |

## 第三部分: Yukino Go 系列

以下文档均以对应仓库的真实源码为事实依据.

| 页面                                       | 内容概要                                                                                                                                                                                                                                                                   |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [yukino-http](yukino-http)                 | yukino_http HTTP 框架: Koa 风格洋葱模型中间件与延迟响应、按段 Trie 路由、分组 Router、SSE 与 RFC 6455 WebSocket 的实现机制与适用场景                                                                                                                                       |
| [yukino-rpc](yukino-rpc)                   | yukino_rpc 自研 RPC: 二进制线协议、单连接多路复用、Future 异步模型、服务端流式 RPC、熔断限流负载均衡与 etcd 服务发现                                                                                                                                                       |
| [yukino-orm](yukino-orm)                   | yukino_orm: 构建在 MongoDB 官方驱动之上的 Knex 风格链式 ORM, 覆盖引擎与连接管理、链式查询构建、聚合分组、流式查询、事务与自增序列                                                                                                                                          |
| [yukino-cache](yukino-cache)               | yukino_cache 分布式缓存: groupcache 风格 read-through Group、字节预算双层 LRU、singleflight 去重、一致性哈希分片、gRPC peer 通信与 etcd 服务发现                                                                                                                           |
| [yukino-agent-proxy](yukino-agent-proxy)   | yukino_agent_proxy: 单二进制以 --agent 代理 Claude Code 或 Codex, 在 Anthropic 与 OpenAI 三类协议间双向桥接, 负责配置注入与备份、常驻进程、MCP 控制面与滚动发布                                                                                                            |
| [yukino-components](yukino-components)     | 九个分布式基础设施组件: redis_lock、consistent_hash、consistent_cache、red_mq、tcc、time_wheel、timer、lsm_tree、raft 的问题域、关键算法、设计取舍与适用边界                                                                                                               |
| [yukino-go-agent](yukino-go-agent)         | yukino_agent Go 后端: 以 CloudWeGo Eino 编排 RAG 对话、Plan-Execute-Replan 告警分析与文档索引三条流水线, 打通 Milvus 向量知识库、MCP/Prometheus/MySQL 工具集与浏览器可观测性到 Prometheus 的监控桥                                                                         |
| [yukino-go-taskflow](yukino-go-taskflow)   | yukino_taskflow 条件与定时 AI 任务的分布式执行引擎: cron 物化 + 分布式时间轮触发、MySQL 触发器 CDC + outbox 中继、四层幂等防线、TCC 派发事务、openai-go 工具代理与结构化报告、LSM/Raft 本地审计与 MySQL→Redis 状态同步                                                     |
| [yukino-go-taskflow2](yukino-go-taskflow2) | yukino_taskflow 后端组件教程: 面向分布式系统新手, 从单机并发讲到分布式难点, 逐一拆解 red_mq、time_wheel、redis_lock、consistent_hash、consistent_cache、yukino_cache、tcc、timer、lsm_tree、raft 十个本地 replace 组件的问题域、实现入口与开发坑, 附源码阅读路线与故障实验 |
