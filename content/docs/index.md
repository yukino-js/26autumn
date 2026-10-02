---
title: "工作文档"
description: "实习与工作期间的技术记录与开源项目调研: TikTok/IEG/Data 工作实践、协议与方案调研、Coding Agent 调研、AI 框架与平台调研"
---

本部分收录实习与工作期间的技术记录, 共十五篇文档, 按主题组织为四个部分.

## 工作实践

作者亲历的工作复盘, 保留项目实测数据与决策过程:

- [TikTok 工作](tiktok): Android 设备性能采集 (perfetto 插桩与抓栈)、数据链路存储选型 (Kafka/Hive/ClickHouse/MySQL/Redis)、RPC 与 BFF 分层、手写虚拟滚动.
- [IEG 工作](ieg): 腾讯 NoSQL 管理端的四项工程实践——类组件迁移函数组件、进程池与 ffi 内存模型、TCP 连接池、闭包内存泄漏排查.
- [Data 工作](data): JSError 上报与故障现场还原 (rrweb/componentStack/sourcemap)、monaco 资源加载竞态、FSP 首屏计算、视频切片聚类标签、手写 SWR 数据请求方案.

## 协议与方案调研

- [A2UI](a2ui): A2UI 声明式 UI 协议调研——v0.9/v0.9.1 规范的组件与函数目录、扩展机制、Dart/Swift/TypeScript 多语言 SDK、A2A 集成、restaurant_finder 示例源码走读与 yukino-agent 生产级应用案例.
- [A2UI Express DSL](a2ui-express): 更低成本生成 A2UI 的实验性提案调研——DSL 语法规则、编译到 v1.0 wire protocol、Python 参考实现与 Gemma 小模型评测.
- [MCP App 全面解析](mcp-app): MCP Apps 扩展的协议机制、安全模型与工程实践, 以及与 A2UI 的详细对比.
- [WebContainer 与浏览器内 Vite](webc): 结合 yukino-codegen 客户端源码与 @webcontainer/api 1.6.4 发布产物, 解析 WebContainer 的运行原理、跨源隔离、浏览器并行化与浏览器内 Vite dev server.

## Coding Agent 调研

编码智能体与 AI 工程工具的源码级调研:

- [CodeGraph](codegraph): 给 AI 编码 Agent 的本地代码知识图谱——tree-sitter 双引擎抽取、SQLite 知识图谱、MCP 工具面设计、Rust 原生内核与企业落地分析.
- [Claude Code Best (CCB)](claude-code): claude-code-best v2.8.4 逆向复原工程调研——构建体系、核心循环、工具系统与多 Provider 兼容层.
- [OpenAI Codex CLI](codex): openai/codex 调研——产品形态、TypeScript SDK 与 app-server 协议化架构.
- [Pi Agent Harness](pi): pi-coding-agent 调研——极简内核、树形会话模型、TypeScript SDK 与 durable 运行时.
- [OpenCodeReview](open-code-review): alibaba/open-code-review 调研——Go CLI ocr 的评审流水线、Provider 体系、GitHub Action、npm 分发与 IDE/Agent 插件生态.

## AI 框架与平台调研

- [Insforge](insforge): 面向 Coding Agent 的开源 BaaS 平台与其 MCP Server——Express+PostgREST 后端、Deno 边缘函数、S3 协议网关与 18 个 MCP 工具.
- [LangChain.js](langchain): 基于本机克隆梳理 1.x Monorepo 结构、langchain-core 核心抽象与 Runnable 内核、32 个 provider 集成、createAgent 中间件体系与构建测试设施.
- [LangGraph.js](langgraph): 拆解 monorepo 包布局、StateGraph/Pregel BSP 执行循环、channels 与 reducers、checkpointer 检查点持久化生态、human-in-the-loop 与流式输出.

调研类文档均标注本机克隆路径与核对时的 HEAD 快照, 内容只呈现该快照下的当前事实; 工作实践类文档为作者亲历的工作档案, 实测数据与实现细节按当时记录保留.
