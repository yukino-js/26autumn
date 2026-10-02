---
title: "前端"
description: "前端栏目落地页: 按语言与运行时、框架与工程化、Yukino 前端系列三部分组织, 共 17 个页面, 覆盖 React、Next.js、CSS、Vite、Formily、TanStack、Priority Hints、OpenSpec 与 Yukino 项目笔记"
---

前端方向的系统性技术笔记, 按主题组织为三个部分, 共 17 个页面 (含本落地页).

## 第一部分: 语言、运行时与 CSS

| 页面 | 内容概要                                                                                                                         |
| ---- | -------------------------------------------------------------------------------------------------------------------------------- |
| fe   | JavaScript 语言核心、DOM/BOM、浏览器原理与网络: 类型检测、事件循环与原型继承、渲染流水线与网络协议、手写实现题与 TS 编译/V8 专题 |
| css  | 55 个 CSS 核心知识点: 选择器优先级与新选择器、Flex/Grid 布局、BFC 与渲染流水线、响应式设计、动画与性能优化、跨端与现代 CSS 特性  |

## 第二部分: 框架与工程化

| 页面          | 内容概要                                                                                                                      |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| react         | React 核心知识点: 闭包陷阱、Fiber 架构与 Diff、Hooks 原理、setState 批处理、并发调度、React 19 Actions 与新增 API             |
| next          | React + Next.js 渲染模型: CSR/SSR/SSG/ISR 对比、水合机制、请求瀑布流消除、Bundle 优化、Server Components、Next.js 16 关键变化 |
| vite          | Vite 8 (Rolldown/Oxc) 与 Webpack 原理对比: dev 冷启动、HMR、Tree Shaking、模块联邦、monorepo 与 CI 工程化实践                 |
| formily       | 基于本机 formily 源码核对的入门与原理: Schema 驱动能力地图、@formily/reactive 响应式引擎、@formily/core 表单与字段体系        |
| tanstack      | TanStack Query v5 缓存模型、queryKey 设计与失效策略, 与 Form/Virtual 的职责分工 (基于 yukino-chatbot 与 yukino-codegen 源码)  |
| priority-hint | Priority Hints 与 Fetch Priority API: fetchpriority 标准化演进、浏览器内置优先级模型、各资源类型调度行为与优化实践            |
| openspec      | OpenSpec 规格驱动开发调研: 协议层定位、CLI 与 schema 体系、proposal/specs/tasks 工作流与工具集成                              |

## 第三部分: Yukino 前端系列

以下文档均基于本机对应仓库的真实源码整理, 文中标注本机器路径:

| 页面           | 内容概要                                                                                          |
| -------------- | ------------------------------------------------------------------------------------------------- |
| yukino         | 围绕 apps/yukino 终端 Coding Agent 实现细节的 104 组深度问答                                      |
| yukino-source  | 基于 apps/yukino 源码逐文件阅读整理的深度解析                                                     |
| yukino-agent   | yukino-agent AI OnCall 助手: Next.js 16 + AI SDK v7 架构、RAG 检索、LangGraph 编排与可观测性      |
| yukino-agent2  | yukino-agent2 电商客服 Agent: Hono HTTP 层、LangGraph 会话图、可插拔检索体系与 Lit 前端           |
| yukino-chatbot | yukino-chatbot 全栈 LLM 聊天应用: pnpm workspace 架构、JWT 会话、AI 热切换、SSE 流式输出          |
| yukino-chat    | yukino-chat 自托管 IM 平台: Hono/Prisma 服务端、WS 聊天枢纽、WebRTC 信令与每用户内嵌 Yukino Agent |
| yukino-sentry  | @yukino.js/sentry 框架无关浏览器端监控 SDK 的问答式技术笔记                                       |

说明: 语言与框架部分以本仓库 node_modules 实际安装版本为事实基准核对 (react@19.3.0、next@16.3.7、tailwindcss@4.3.3、TypeScript 6 等), 通用原理性内容按对应技术的当前稳定版本陈述; Yukino 系列的结论均来自对应仓库源码, 不做推测.
