---
title: "后端"
description: "后端栏目落地页: 按语言基础、存储与中间件、Yukino Go 系列三部分组织, 共 12 个页面, 覆盖 Go 语言与运行时、MySQL/Redis/ClickHouse/Kafka、etcd/gRPC/可观测性等中间件与 generic-pool 源码解析, 以及 yukino_http/yukino_rpc/yukino_cache 与 Yukino Codegen"
---

后端方向的系统性技术笔记, 按主题组织为三个部分, 共 12 个页面 (含本落地页).

## 第一部分: 语言基础

| 页面 | 内容概要                                                                                                                                                                |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| go   | Go 语言核心知识点与底层原理: slice/map/interface、GMP 调度、channel、context、sync、错误处理、内存分配与 GC, 以 Go 1.26 为基准, 并给出 yukino.go 中经核实的真实源码模式 |

## 第二部分: 存储与中间件

| 页面             | 内容概要                                                                                                                                             |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| mysql            | MySQL 8.0 与 InnoDB 核心笔记: 架构与执行流程、索引、事务 MVCC、锁、日志、复制、分库分表与缓存一致性                                                  |
| redis            | Redis 核心笔记: 数据结构与底层编码、线程模型、持久化、过期与淘汰、高可用架构、缓存设计与分布式锁两种实现                                             |
| clickhouse-kafka | ClickHouse 列式存储、MergeTree 家族、分布式架构与查询优化, Kafka 存储模型、消息语义、高可用与调优                                                    |
| middleware       | etcd、Kafka、groupcache、gRPC、Prometheus、Grafana、OpenTelemetry 与 Redis Stack 向量存储的原理与生产实践                                            |
| node-pool        | generic-pool 3.9.0 源码解析: acquire/release/destroy 生命周期、工厂契约、Deferred 超时排队、双向链表 Deque 与 PriorityQueue、DefaultEvictor 空闲回收 |

## 第三部分: Yukino Go 系列

以下文档均基于本机对应仓库的真实源码整理, 文中标注本机器路径:

| 页面           | 内容概要                                                                                                                                                        |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| yukino-http    | yukino_http Go HTTP 框架源码级解析: 洋葱模型中间件、延迟响应、Trie 路由、SSE 与 WebSocket (RFC 6455)                                                            |
| yukino-rpc     | yukino_rpc 自研 RPC 框架源码级解析: 线协议、传输层多路复用、Future 异步模型、流式 RPC、熔断/限流/负载均衡与 etcd 服务发现                                       |
| yukino-cache   | yukino-cache 分布式缓存 TypeScript 与 Go 双实现的源码级解析: 架构分层、一致性哈希、分桶双层 LRU、etcd 服务发现、并发模型与容错机制                              |
| yukino-go-apps | yukino.go/apps 下 consistent_hash、redis_lock、consistent_cache、lsm_tree、raft_demo、red_mq、tcc_demo、time_wheel、timer_demo 九个基础设施演示应用的源码级解析 |
| yukino-codegen | AI 全栈代码生成平台 Yukino Codegen 的技术汇报, 重点覆盖 WebContainer 深度解析与浏览器内运行链路                                                                 |

说明: 语言与存储部分以对应技术的当前稳定版本为事实基准陈述; Yukino Go 系列的结论均来自本机仓库源码 (yukino.go、yukino.js/packages/cache、yukino-codegen) , 并在各文档头部标注核对时的 HEAD 快照, 不做推测.
