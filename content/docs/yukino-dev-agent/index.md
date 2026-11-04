---
title: "Yukino Dev Agent"
overview: true
description: "yukino-dev-agent 栏目: Next.js 16 + AI SDK 全栈 AI 应用的深度技术笔记, 覆盖 OnCall 值班助手与 DevFlow 工程副驾两个产品面的 RAG 检索、Agent 编排、A2UI 交互界面、MCP 工具体系与可观测性"
local_path: "$HOME/github/yukino-dev-agent"
local_commit: "424a270590659dfbea804384d4fd1e14ba1111a5"
---

:::note 事实基线
本文依据 `$HOME/github/yukino-dev-agent` 在 `424a27059065` 的源码事实撰写；文中的路径、常量与 API 名称均可在该检出中定位。
:::

**主线一览**

```mermaid
flowchart TB
  A[Next.js 16 单应用] --> B[OnCall 值班助手]
  A --> C[DevFlow 工程副驾]
  B --> D[RAG 与 ReAct]
  C --> E[多 Agent Workflow]
  A --> F[A2UI 交互界面]
  A --> G[MCP 与可观测性]
```

yukino-dev-agent 仓库的系统性技术笔记, 共 4 个页面 (含本落地页).

:::note 单应用双产品面
该仓库是单个 **Next.js 16** App Router 全栈应用, 同进程承载两个产品面: 面向值班运维的 AI <u>OnCall</u> 助手 (根路径) 与面向 GitHub 协作的 <u>DevFlow</u> 工程副驾 (`/dev-flow`), 共用 **Milvus** 混合检索、双槽位模型工厂与 **Langfuse** / **Prometheus** 可观测性.
:::

| 页面                                   | 内容概要                                                                                                                                                                        |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [yukino-dev-agent](./yukino-dev-agent) | 深度技术笔记: 分层架构与端到端数据流、Milvus 混合检索 RAG、ReAct 与 Plan-Execute-Replan 编排、A2UI 交互界面、MCP 工具体系、数据模型与记忆、指标桥与告警闭环、配置部署与安全边界 |
| [agent](./agent)                       | OnCall 视角入门: 技术栈与双档模型、RAG 建库与在线问答、Milvus 混合检索流程、ReAct 对话 Agent、Plan-Execute-Replan 运维 Agent 与报告护栏、Tool/MCP、A2UI、知识库管理与自监控     |
| [dev-flow](./dev-flow)                 | DevFlow 视角入门: GitHub 同步与调度、确定性优先的分析 Agent、ActionDraft 安全草稿、每仓 RAG 与答案门禁、对话 Agent 韧性与记忆系统、多 Agent workflow、代码工作区/代码图/知识图  |
