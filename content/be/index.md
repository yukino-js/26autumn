---
title: "后端"
description: "Go 语言、数据库、中间件与 Yukino Go 系列的技术笔记"
---

后端方向的系统性技术笔记, 按主题组织为三个部分:

- 语言基础: Go 语言核心知识点与底层原理专题, 覆盖 GMP 调度、channel、内存模型、GC 等, 并结合 yukino.go 中经核实的真实源码模式说明。
- 存储与中间件: MySQL 架构与 InnoDB 原理、Redis 数据结构与高可用、ClickHouse 列式存储、Kafka 存储与消费语义、etcd/gRPC/Prometheus 等中间件原理与生产实践, 以及 generic-pool 资源池的源码解析。
- Yukino Go 系列: yukino_http 洋葱模型 HTTP 框架、yukino_rpc 自研 RPC 框架、yukino_cache 分布式缓存 (TypeScript 与 Go 双实现) 的源码级解析, apps/ 下九个基础设施演示应用 (一致性哈希、Raft、时间轮、分布式锁等), 以及 AI 全栈代码生成平台 Yukino Codegen 的技术汇报。
