---
title: "工作文档"
description: "工作实践与开源项目调研: TikTok/IEG/Data 工作复盘、A2UI/MCP Apps/WebContainer 协议与方案调研、Coding Agent 调研, 以及 AI 框架与平台调研"
---

本部分收录工作期间的技术复盘与开源项目调研, 按主题分为四个部分, 共 18 个页面 (含本落地页).

## 工作实践

工作期间亲历的技术实践, 保留实测数据与决策过程:

- [tiktok](tiktok): 移动端性能采集与数据链路. 设备端插桩与抓栈两种范式、JS 运行时采集、Kafka/Hive/ClickHouse/MySQL/Redis 的链路分工、RPC 与 BFF 分层, 以及不定高虚拟滚动的实现与取舍.
- [ieg](ieg): NoSQL 管理端工程实践. 类组件迁移函数组件的语义映射与请求竞态、ffi 调用的内存模型与进程池隔离、TCP 连接池的四类异常处理、闭包引用导致的内存泄漏排查.
- [data](data): 前端监控与数据请求工程实践. JSError 上报的数据模型、rrweb 滚动窗口的故障现场还原、componentStack 与 sourcemap 定位、资源加载竞态、FSP 首屏计算、视频切片聚类与手写 SWR 方案.

## 协议与方案调研

- [a2ui](a2ui): A2UI 声明式 UI 协议. 消息与 Catalog 契约、数据绑定与事件回传语义、多语言 SDK 能力面、A2A/MCP 集成, 以及生产应用的落地形态与降级策略.
- [a2ui-express](a2ui-express): A2UI Express 实验性提案. 紧凑 DSL 的语法设计、编译到 v1.0 wire protocol 的映射规则、Python 参考实现的编译链路、conformance 固化规则, 以及小模型评测结论与适用边界.
- [mcp-app](mcp-app): MCP Apps 扩展. 工具与 UI 资源的声明契约、宿主与 iframe 的通信与安全模型、以真实工具为例的工程实践与降级路径, 以及与 A2UI 的对比.
- [webc](webc): WebContainer 与浏览器内 Vite. WASM 运行时与共享内存、COOP/COEP 跨源隔离、Atomics 与 Emscripten pthreads 的浏览器内并行化、SDK 与官方运行时的 iframe 边界.

## Coding Agent 调研

- [codegraph](codegraph): 面向 AI 编码 Agent 的本地代码知识图谱. 把代码库预计算成 SQLite 知识图谱, 通过 MCP 查询面提供结构化上下文, 替代 grep 加逐文件读取的探索循环, 并明确静态分析的边界.
- [claude-code](claude-code): 一个终端 AI 编码助手的工程实现剖析. Bun 代码分割构建、流式 Agent 循环与工具并发调度、工具白名单加延迟发现、把异构模型协议收敛到 Anthropic 内部格式的流适配器模式, 以及消息渠道接入.
- [codex](codex): OpenAI Codex CLI 的协议化架构. Rust 单体内核与 TUI/exec/app-server/SDK/MCP 多形态产品面、SQ/EQ 事件协议与 app-server JSON-RPC 线、以子进程加 JSONL 暴露的 TypeScript SDK、Seatbelt/Landlock 沙箱与 execpolicy 规则引擎、MCP 双向集成、分层配置与 rollout 持久化.
- [pi](pi): Pi Agent Harness. 极简内核与扩展机制的边界、entry 树会话模型、TypeScript SDK 的进程内嵌入、durable 运行时的持久化不变量、执行环境抽象与远程执行, 以及 TUI 与 client/server 两种形态.
- [open-code-review](open-code-review): OpenCodeReview 的评审流水线. 确定性与 LLM agent 的分工、Provider 抽象、diff 与规则上下文收集、allowlist 与规则 DSL、评论定位, 以及 Action/npm 分发与插件生态.

## AI 框架与平台调研

- [insforge](insforge): 面向 Coding Agent 的开源 BaaS 平台. Express 控制面与 PostgREST 数据面、鉴权与安全模型、Deno 边缘函数、S3 协议网关, 以及 insforge-mcp 的工具注册内核与远程 OAuth 设计.
- [langchain](langchain): LangChain.js 1.x. monorepo 包布局、langchain-core 的 Runnable 与消息/工具抽象、provider 集成模式、createAgent 与中间件体系, 以及构建、测试与发布设施.
- [langgraph](langgraph): LangGraph.js. 从包分层讲到 StateGraph 到 Pregel 的超步执行循环、channels 与 reducers 的状态更新语义、checkpointer 持久化与恢复、interrupt/resume 人机协同与流式输出.
- [openspec](openspec): OpenSpec 规格驱动开发协议层. CLI 命令体系与懒加载设计、schema 与校验规则、proposal/specs/design/tasks artifacts 工作流、归档语义, 以及与大模型编码工具的集成方式.
- [superpowers](superpowers): 面向编码 Agent 的软件方法论与技能注入体系. 为什么把开发流程写成技能并强制注入、bootstrap 链路、技能分类与触发方式、多 harness 适配架构、证据化诊断与质量体系.
