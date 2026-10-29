---
title: "电商客服 Agent"
overview: true
description: "yukino-ecomm-agent 栏目: Node.js/TypeScript 电商客服 Agent (Yukino Select) 的系统性技术笔记, 覆盖 Hono + LangGraph 服务端与 Lit 控制台的总体组织、会话上下文分层、LLM 接入与表设计、MCP 工具、可观测性与数据飞轮、RAG 检索、图编排 workflow 与 HTTP API"
local_path: "$HOME/github/yukino-ecomm-agent"
---

围绕 yukino-ecomm-agent 仓库的系统性技术笔记, 共 9 个页面 (含本落地页). 仓库是一个 pnpm workspace: `server/` 是 Hono + LangChain/LangGraph + Prisma/PostgreSQL 的客服 Agent 服务端, `client/` 是 Lit 单页控制台; 全部文档以该仓库源码为唯一事实依据.

| 页面                                       | 内容概要                                                                                                                                                                                                                            |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [yukino-ecomm-agent](./yukino-ecomm-agent) | 总体组织方式: 一次对话如何穿过 HTTP、LangGraph 会话图、四策略检索与两道置信度门禁、可选 Milvus 向量路径、MCP 工具执行、分层记忆与上下文预算、知识库运营与数据飞轮, 以及各层的设计取舍与适用边界                                     |
| [context](./context)                       | 会话上下文管理: 三层记忆结构 (层 1 原文 / 层 2 规则压缩 / 摘要层)、token 估算、上下文预算分账与启动自检、层降级与异步摘要的轮末结算, 以及模型上下文注入方式和 LangGraph state 字段清单                                              |
| [llm](./llm)                               | LLM 接入、表设计与工具设计: OpenAI 兼容 Chat Completions 上游与 chat/intent/summary 三模型槽位、structured() 结构化输出、系统提示词集, Prisma 12 个模型的四组表, 以及工具注册表与执行引擎                                           |
| [mcp](./mcp)                               | MCP 和 Skill: 物流/售后两个演示 MCP 服务器 (Hono + 官方 SDK, 确定性 Mock)、主服务 mcp-client 接入与 registry 合并注册、formatResult 状态码翻译、执行引擎、写前人工确认与审计, 以及测试与验收                                        |
| [observable](./observable)                 | 可观测性和数据飞轮: Langfuse 双链路 tracing 与本地 compose 部署、防劣化的离线评测流水线 (eval-rag / eval-flywheel / calibrate-confidence / cost-report) 与 job runner、阅读笔记与幻觉案例台账, 以及低置信问题池驱动的知识库写回闭环 |
| [rag](./rag)                               | RAG 检索: Markdown 文档切割 (标题分节 / 表格按行 / 句子级 overlap)、embedding 策略、关系库与向量库双写状态位、可选 Milvus 与进程内 BM25/稠密检索, 以及召回 → RRF 粗排 → rerank 精排管线与置信度闸                                   |
| [workflow](./workflow)                     | LangGraph 会话图编排: 12 个节点的拓扑与九意图五出口的表驱动路由、指代消解 / 意图识别 / 知识检索 / 退款确定性子流程 / ReAct 主力循环 / 确定性出口各节点实现, 以及 Postgres checkpointer、SSE 流式事件翻译与中断恢复                  |
| [api](./api)                               | HTTP API 和管理台: API 服务拓扑与启动顺序、main.js 离线任务入口、统一错误约定, 对话 / 知识库 / 数据飞轮与评测 / 管理各端点的请求响应契约、job runner, 以及 Lit 前端控制台的路由与架构要点                                           |
