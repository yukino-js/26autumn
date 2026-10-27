---
title: "前端"
overview: true
description: "前端栏目: JavaScript/DOM/浏览器与网络、CSS 与现代布局, React/Next.js/Vite/TanStack/Priority Hints 工程实践, 以及 Yukino 前端与 Agent 系列"
---

前端方向的系统性技术笔记, 按主题分为三部分, 共 13 个页面 (含本落地页).

## 第一部分: 语言、运行时与 CSS

| 页面       | 内容概要                                                                                                                    |
| ---------- | --------------------------------------------------------------------------------------------------------------------------- |
| [fe](fe)   | JavaScript 语言核心与类型语义、DOM/BOM 与事件模型、浏览器渲染流水线与内存管理、HTTP 与 TLS、缓存与跨域、网络安全与前端弹性  |
| [css](css) | 选择器与层叠、盒模型与格式化上下文、Flex/Grid 布局、响应式与容器查询、自定义属性、动画与渲染性能、现代 CSS 特性与样式工程化 |

## 第二部分: 框架与工程化

| 页面                                   | 内容概要                                                                                                                                                 |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [react](react)                         | React 19 运行时原理: 一次更新的完整生命周期、Fiber 协调与 Diff、Hooks 链表、Lanes 优先级与批处理, 以及 Actions、use、ref 作为 prop 等稳定 API 与性能边界 |
| [next](next)                           | Next.js 16 App Router: 组件边界与数据获取、缓存与重验证模型、流式渲染、路由与 Metadata、Server Actions、静态导出与 Next 16 基线要点                      |
| [vite](vite)                           | Vite 8 与现代构建: dev server、依赖预构建、HMR 原理、Rolldown/Oxc/Lightning CSS 工具链、生产构建与代码分割、插件体系, 以及与 Webpack 的原理对比          |
| [tanstack](tanstack)                   | TanStack Query v5: 缓存模型、queryKey 设计、失效与乐观更新、分页与预取水合, 以及与客户端状态、表单、虚拟列表的职责边界                                   |
| [fetchpriority-swr](fetchpriority-swr) | Priority Hints 与 fetchpriority: 属性语义与取值、浏览器内置资源优先级模型、预加载与首屏优化中的正确用法、可度量收益与风险, 以及手写 SWR 数据请求方案     |

## 第三部分: Yukino 前端与 Agent 系列

以下文档均以对应仓库的真实源码为事实依据.

| 页面                                                                | 内容概要                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [yukino-code](../docs/yukino/yukino-code)                           | Yukino Code 终端 Coding Agent 源码解析: 主循环与事件流、Provider 适配与重试、工具与 MCP 延迟加载、上下文压缩与恢复、检查点与 fork、长期记忆、subagents 与团队、coordinator 与持久 goal、权限、Hooks 与沙箱、运行模式与遥测, 附三十一问设计问答篇  |
| [yukino-codegen](yukino-codegen)                                    | Yukino Codegen AI 全栈代码生成平台: 服务端用 Yukino 编码 Agent 在真实磁盘上迭代产出 Vite 工程, 浏览器用 WebContainer 完成安装与预览, 以服务器权威文件 + WebSocket 事件溯源 + 三方合并闭合生成/运行/修复回路                                       |
| [yukino-mcp](yukino-mcp)                                            | Yukino 官方 MCP 服务器: 把本地 RAG 文档检索、MCP Apps 交互式 UI、gh CLI 与 PostgreSQL/MySQL/ClickHouse/Redis/MongoDB/Prometheus/Grafana/MinIO/etcd/Milvus/Kafka 十一类数据后端收敛成 15 个 MCP 工具, 以 stdio 与无状态 Streamable HTTP 双传输暴露 |
| [yukino-dev-agent](../docs/yukino-dev-agent/yukino-dev-agent)       | OnCall/DevFlow 双产品面应用: Next.js 16 + AI SDK、Milvus 混合检索 RAG、ReAct 与 SSE 流式 Plan-Execute-Replan 编排、A2UI 交互界面、多源告警聚合、MCP 工具体系、Langfuse 可观测性与 Prometheus 指标桥                                               |
| [yukino-ecomm-agent](../docs/yukino-ecomm-agent/yukino-ecomm-agent) | 电商客服 Agent: Hono HTTP 层、LangGraph 会话图、四策略检索与两道置信度门禁、可选 Milvus 向量路径、MCP 工具执行、分层记忆与上下文预算, 组织成可中断、可审计的对话                                                                                  |
| [yukino-chatbot](yukino-chatbot)                                    | pnpm 全栈 LLM 聊天应用: Koa 3 后端的 JWT 会话、Provider 热切换、即时构建的 RAG 检索与 SSE 流式输出, React 19 前端以 Jotai 加 React Query 分层状态, 流式渲染热路径移出 React                                                                       |
| [yukino-chat](yukino-chat)                                          | 自托管 IM 平台: Hono 服务端、WebSocket 消息枢纽与投递语义、WebRTC 信令、分块断点续传、Redis 缓存双实现降级, 以及为每个用户进程内嵌入的只读 coding agent 与其 JSON-RPC 桥                                                                          |
| [yukino-sentry](yukino-sentry)                                      | @yukino.js/sentry 浏览器监控 SDK: 错误/HTTP/页面轨迹/性能/声明式点击/曝光/白屏/错误前录屏采集, 发布订阅事件总线解耦、批量上报、离线缓存、服务端恢复、采样过滤与 React/Vue 接入                                                                    |
