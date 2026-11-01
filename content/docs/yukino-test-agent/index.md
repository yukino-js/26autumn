---
title: "Yukino 测试 Agent"
overview: true
description: "Yukino QA (yukino-test-agent) AI 测试平台源码解析: 静态代码分析接地、测试点抽取、规则/LLM 用例生成与质量门评审、Playwright 真实浏览器执行、视觉复核与证据驱动的失败分类、覆盖率矩阵与自包含报告"
local_path: "$HOME/github/yukino-test-agent"
local_commit: "a088648ff62effa6cf1fe9652221fb26328891e8"
---

本栏目基于 `~/github/yukino-test-agent` 的真实源码, 系统拆解 AI 测试平台 **Yukino QA**: 输入一份代码库与一份产品需求文档 (PRD), 自动产出结构化测试用例, 在真实浏览器中执行, 并用确定性校验与可选视觉模型复核证据. 全平台的最高准则是**绝不伪造绿色结果**——无法验证的步骤诚实标记 skipped, 确定性结论永远压过 AI 意见, 结果分析只分类不覆写执行状态.

全部 10 个页面 (含本落地页), 按阅读顺序:

| 页面                                     | 内容概要                                                                                                                                                 |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [yukino-agent-test](./yukino-agent-test) | 平台总览: 第一性原则、七阶段流水线、技术栈 (TanStack Start + tRPC + Drizzle + Playwright)、快速上手、环境变量、目录结构与 npm 脚本                       |
| [architecture](./architecture)           | 架构总览: 分层视图与请求数据流、进程内 job 任务系统 (jobs.ts + useJobPoller)、启动恢复、BizError 映射、证据文件服务、LLM 客户端与档案、Sentry 与构建配置 |
| [data-model](./data-model)               | 数据模型: 26 张 Drizzle 表按域分组、主键与并发安全序列 (id_sequences)、领域类型 (types.ts)、状态码展示元数据 (enums.ts)                                  |
| [pipeline](./pipeline)                   | 七阶段流水线: workflows.ts 编排逻辑、硬/软失败与最终状态判定、createRun 配置项、各阶段要点、结果分析与报告、中断恢复                                     |
| [analyzer](./analyzer)                   | 静态代码分析: scanner 技术栈探测、Spring/Go 后端解析、Vue/Lit 前端解析、Java/Go 状态机推断, 以及 code_analyses 持久化与消费方                            |
| [generation](./generation)               | 用例生成: 测试点抽取 (LLM 优先规则兜底)、rule/llm/auto 三模式、计数断言归一化、四道质量门、覆盖引用富化与生成版本归档                                    |
| [execution](./execution)                 | 浏览器执行: Playwright 运行器 (五级选择器回退 + 三层断言)、执行服务与状态裁决、视觉复核、证据驱动的失败分类与证据存储                                    |
| [frontend](./frontend)                   | 前端架构: React 19 + TanStack Start 文件式路由、应用外壳、项目详情九 Tab、组件分层、tRPC + TanStack Query 数据模式与主题系统                             |
| [api](./api)                             | API 与配置参考: tRPC 13 个子路由共 79 个过程清单、Job 模型、非 tRPC 端点、环境变量、错误约定、启动恢复与排障速查                                         |
