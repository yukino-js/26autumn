---
title: "前端"
description: "前端栏目: JavaScript/DOM/浏览器与网络、CSS 与现代布局, React/Next.js/Vite/TanStack/Priority Hints 工程实践, 以及 Yukino 前端与 Agent 系列"
---

前端方向的系统性技术笔记, 按主题分为三部分, 共 16 个页面 (含本落地页).

## 第一部分: 语言、运行时与 CSS

| 页面       | 内容概要                                                                                                                    |
| ---------- | --------------------------------------------------------------------------------------------------------------------------- |
| [fe](fe)   | JavaScript 语言核心与类型语义、DOM/BOM 与事件模型、浏览器渲染流水线与内存管理、HTTP 与 TLS、缓存与跨域、网络安全与前端弹性  |
| [css](css) | 选择器与层叠、盒模型与格式化上下文、Flex/Grid 布局、响应式与容器查询、自定义属性、动画与渲染性能、现代 CSS 特性与样式工程化 |

## 第二部分: 框架与工程化

| 页面                           | 内容概要                                                                                                                                                 |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [react](react)                 | React 19 运行时原理: 一次更新的完整生命周期、Fiber 协调与 Diff、Hooks 链表、Lanes 优先级与批处理, 以及 Actions、use、ref 作为 prop 等稳定 API 与性能边界 |
| [next](next)                   | Next.js 16 App Router: 组件边界与数据获取、缓存与重验证模型、流式渲染、路由与 Metadata、Server Actions、静态导出与 Next 16 基线要点                      |
| [vite](vite)                   | Vite 8 与现代构建: dev server、依赖预构建、HMR 原理、Rolldown/Oxc/Lightning CSS 工具链、生产构建与代码分割、插件体系, 以及与 Webpack 的原理对比          |
| [tanstack](tanstack)           | TanStack Query v5: 缓存模型、queryKey 设计、失效与乐观更新、分页与预取水合, 以及与客户端状态、表单、虚拟列表的职责边界                                   |
| [priority-hint](priority-hint) | Priority Hints 与 fetchpriority: 属性语义与取值、浏览器内置资源优先级模型、预加载与首屏优化中的正确用法、可度量收益与风险                                |

## 第三部分: Yukino 前端与 Agent 系列

以下文档均以对应仓库的真实源码为事实依据.

| 页面                             | 内容概要                                                                                                                                                                                                                                                          |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [yukino-code](yukino-code)       | Yukino Code 终端 Coding Agent 内核的子系统机制: 主循环与事件流、Provider 适配与重试、工具与 MCP 延迟加载、上下文压缩与恢复、检查点与 fork、长期记忆、subagents 与团队、coordinator 与持久 goal、权限与沙箱、OTel/Sentry/Langfuse 三支柱遥测, 附三十一问设计问答篇 |
| [yukino-codegen](yukino-codegen) | Yukino Codegen AI 全栈代码生成平台: 生成流水线与提示词契约、服务端与浏览器职责划分、产物挂载与预览、与编码 Agent 的生成/修复闭环、安全边界与可观测性                                                                                                              |
| [yukino-mcp](yukino-mcp)         | Yukino 官方 MCP 服务器: 把本地 RAG 文档检索、MCP Apps 交互式 UI、gh CLI 与 PostgreSQL/MySQL/Redis/MongoDB/Prometheus 五类数据后端收敛成 9 个 MCP 工具, 以 stdio 与 HTTP 双传输暴露                                                                                |
| [yukino-agent](yukino-agent)     | OnCall/DevFlow 双产品面应用: Next.js 16 + AI SDK、Milvus 混合检索 RAG、ReAct 与 LangGraph Plan-Execute-Replan 编排、A2UI 交互界面、MCP 工具与可观测性                                                                                                             |
| [yukino-agent2](yukino-agent2)   | 电商客服 Agent: Hono HTTP 层、LangGraph 会话图、四策略检索与两道置信度门禁、可选 Milvus 向量路径、MCP 工具执行、分层记忆与 Lit 前端                                                                                                                               |
| [yukino-chatbot](yukino-chatbot) | 全栈 LLM 聊天应用: Koa 后端的 JWT 会话、Provider 热切换、RAG 检索与 SSE 流式输出, React 前端以 Jotai 加 React Query 分层状态                                                                                                                                      |
| [yukino-chat](yukino-chat)       | 自托管 IM 平台: Hono 服务端、WebSocket 消息枢纽与投递语义、WebRTC 信令、分块断点续传、Redis 缓存降级, 以及进程内内嵌的 coding agent                                                                                                                               |
| [yukino-sentry](yukino-sentry)   | @yukino.js/sentry 浏览器监控 SDK: 错误/HTTP/轨迹/性能/点击/曝光/白屏/录屏采集, 事件总线解耦、批量上报、离线缓存、服务端恢复与 React/Vue 接入                                                                                                                      |
