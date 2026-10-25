---
title: "Yukino QA 概览"
---

# Yukino QA (yukino-agent-test)

**Yukino QA** 是一个 AI 驱动的测试平台: 输入「一份代码库」和「一份产品需求文档 (PRD)」, 自动产出结构化测试用例, 在真实浏览器 (Playwright + Chromium) 中执行, 并结合「确定性校验」与「可选的视觉大模型」对执行证据进行复核, 最终输出覆盖率矩阵与自包含 HTML 报告。

一句话概括:

> 从代码事实与需求出发, 自动生成测试用例 → 真实浏览器执行 → 基于证据复核 → 输出覆盖率与报告。

代码仓库位于 `~/ai-test/yukino-agent-test`。应用本身 (UI、代码、注释、数据库状态码) 是**纯英文项目**, 本文档系列是中文学习资料。

## 第一性原则: 绝不伪造绿色结果

这是贯穿整个代码库的最高准则 (never fake a green result):

- **确定性结论优先于 AI 意见**: Playwright 的确定性执行判定 (passed/failed) 永远压过视觉模型的判断; 视觉模型只能「确认」或「质疑」, 不能把明确的失败改成通过。
- **无法验证的步骤诚实地标记为 skipped**, 绝不因为「没有报错」就标记为 passed。
- **证据驱动的失败分类不覆盖执行状态**: 结果分析阶段对失败归类 (产品缺陷/脚本问题/数据问题/环境/未知), 但只写自己的表, 绝不修改 `execution_records.status`。
- **被取消 (cancelled) 的执行不算通过**。

在代码中, 这条原则由 `src/server/lib/execution/runner.ts` 的三层断言、`src/server/lib/execution/vision-review.ts` 的「只接受显式 ok, 其余一律 suspect」策略, 以及 `src/server/services/workflows.ts` 的结果分析守卫共同强制执行。

## 它解决什么问题

传统自动化测试的痛点:

- 用例编写成本高、与真实页面文案/选择器脱节;
- 脚本脆弱, 元素定位一旦变化就大面积失败;
- 「跑通即通过」的误判: 没有报错就被当成绿色, 掩盖真实缺陷;
- 失败原因难以归类 (产品缺陷、脚本问题、数据问题还是环境问题)。

Yukino QA 用「**代码事实接地 (grounding) + 五级选择器回退 + 三层断言 + 证据驱动复核**」系统性地应对这些问题。

## 项目由来与版本控制

本项目从 **AITest** (Python FastAPI + Vue 3, 中文界面) 迁移而来, 目标技术栈改为 TanStack Start, 界面与代码全面英文化, 并按 shadcn 设计美学重建 UI。

- `main` 分支: 保持为原始模板基线 (commit `c1bf459`);
- `feat/aicase-migration` 分支: 承载全部迁移工作 (相对 main 约 196 个文件、+24682/-8762 行)。

## 技术栈

| 层次         | 选型                        | 说明                                |
| ------------ | --------------------------- | ----------------------------------- |
| 应用框架     | TanStack Start              | 基于 Vite 8 + Nitro 的 SSR 全栈框架 |
| 路由         | TanStack Router             | 文件式路由、端到端类型安全          |
| 数据请求     | TanStack Query + tRPC v11   | superjson 序列化                    |
| 数据库       | PostgreSQL + Drizzle ORM    | 20 张表, 结构化载荷用 jsonb         |
| 样式         | Tailwind CSS v4 + shadcn/ui | new-york 风格、zinc 基色            |
| 校验         | Zod                         | tRPC 入参与领域校验                 |
| 浏览器自动化 | Playwright                  | Chromium 执行、截图、录像           |
| UI           | React 19 + TypeScript 6     | 启用 React Compiler (babel 插件)    |
| 图标/通知    | lucide-react / sonner       | —                                   |
| 监控 (可选)  | Sentry                      | `@sentry/tanstackstart-react`       |

选型理由:

- **TanStack Start + Router + Query + tRPC**: 从数据库到浏览器全链路类型贯通, 服务层函数签名即 API 契约, 几乎杜绝「前后端字段对不上」。
- **Drizzle + jsonb**: 关系型骨架 (项目/需求/用例/执行) 用规范表; 高度结构化、随领域演进的载荷 (结构化步骤、代码事实、评审问题) 用 jsonb, 并以共享 TS 类型 (`src/lib/types.ts`) 约束。
- **Playwright**: 真实浏览器执行是「绝不伪造绿色」的物理基础——只有真实点过、真实断言过, 才算数。

## 快速上手

前置条件: Node.js 20+ (开发环境为 Node 24)、pnpm 9+、PostgreSQL 14+、Playwright 浏览器。

```bash
# 1. 安装依赖
pnpm install

# 2. 配置环境变量 (至少填 DATABASE_URL)
cp .env.example .env.local

# 3. 安装浏览器并创建 20 张表
pnpm exec playwright install chromium
pnpm db:push

# 4. 启动开发服务器, 打开 http://localhost:3000
pnpm dev
```

### 演示目标站点 (SUT)

仓库自带一个英文「订单管理」演示站点作为被测系统, 其可见文案与生成器产出的锚点刻意一致 (如 `"Order created successfully"`、`"Payment successful"`、`"{Label} cannot be empty"`、`"Total of N items"`):

```bash
pnpm demo-site   # 服务于 http://127.0.0.1:8200
```

路由: `/` → index、`/orders/create` → 创建订单、`/orders/list` → 订单列表, 其他路径 SPA 回退到首页。随后在平台中创建项目, **Target URL** 填 `http://127.0.0.1:8200`, 附上 PRD, 即可运行流水线。

### 纯规则模式 (无需 LLM)

`LLM_*` 环境变量留空时, 平台以**纯规则模式**运行: 代码分析、规则用例生成、确定性评审、Playwright 执行、规则化结果分析全部可用, 只跳过 LLM 生成与视觉复核。本地零成本即可体验完整链路。

## 目录结构

```
yukino-agent-test/
├─ src/
│  ├─ db/                 Drizzle 客户端 (index.ts) 与表结构 (schema.ts, 20 张表)
│  ├─ env.ts              环境变量校验 (@t3-oss/env-core)
│  ├─ router.tsx          TanStack Router 实例 + Sentry 错误采集
│  ├─ routeTree.gen.ts    路由树 (tsr generate 自动生成, 勿手改)
│  ├─ styles.css          Tailwind v4 + shadcn 主题变量
│  ├─ integrations/
│  │  ├─ trpc/            init.ts (BizError 映射) / router.ts (API) / react.ts (客户端)
│  │  └─ tanstack-query/  root-provider.tsx, devtools.tsx
│  ├─ routes/             文件式路由 (dashboard/projects/testcases/pipeline/executions/settings + 3 个 api 路由)
│  ├─ components/
│  │  ├─ ui/              shadcn/ui 基础组件 (22 个)
│  │  ├─ project/         项目详情 7 个 Tab 面板
│  │  ├─ executions/      执行面板与截图查看器
│  │  └─ *.tsx            AppSidebar/PageHeader/StatusBadge/EmptyState/ProjectPicker/...
│  ├─ hooks/              use-job-poller.ts, use-theme.ts, use-mobile.ts
│  ├─ lib/                enums.ts (状态码→展示元数据) / types.ts (领域类型) / format.ts / utils.ts
│  └─ server/
│     ├─ env.ts           服务端配置 (OUTPUT_DIR/TARGET_URL/LLM_*)
│     ├─ services/        业务编排层 (11 个服务模块)
│     └─ lib/             领域引擎 (analyzer/generation/execution/coverage/jobs/llm/mindmap/files)
├─ scripts/demo-site/     内置英文订单系统演示站点 (Node 静态服务器)
├─ docs/STUDY_GUIDE.zh-CN.md  项目内中文学习指南 (单文件版)
├─ drizzle.config.ts / vite.config.ts / tsconfig.json / package.json
```

路径别名: `#/*` 与 `@/*` 都指向 `./src/*` (见 `package.json#imports` 与 `tsconfig.json#paths`), 代码中统一使用 `#/...`。

## npm 脚本

| 脚本                                                                    | 说明                                                                     |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `pnpm dev`                                                              | dotenv 加载 `.env.local` + Sentry instrumentation + vite dev (端口 3000) |
| `pnpm build`                                                            | vite build 并把 `instrument.server.mjs` 拷入 `.output/server`            |
| `pnpm start`                                                            | 以生产模式运行 `.output/server/index.mjs`                                |
| `pnpm demo-site`                                                        | 启动演示被测站点 (端口 8200)                                             |
| `pnpm generate-routes`                                                  | `tsr generate` 重新生成路由树                                            |
| `pnpm db:push` / `db:generate` / `db:migrate` / `db:pull` / `db:studio` | drizzle-kit 系列                                                         |
| `pnpm lint` / `format` / `check`                                        | ESLint (TanStack 严格配置) / Prettier + eslint --fix / prettier --check  |

已知 lint 状况: 迁移后的 UI、hooks、routes 与共享 lib 是干净的; 部分既有 server 模块在刻意的防御性判空上仍会触发 `@typescript-eslint/no-unnecessary-condition`。

## 文档目录

- [架构总览](/base/yukino-agent-test/architecture): 分层、请求数据流、异步任务、错误处理、LLM 档案
- [数据模型](/base/yukino-agent-test/data-model): 20 张表、领域类型、状态码元数据
- [七阶段流水线](/base/yukino-agent-test/pipeline): 编排逻辑、硬/软失败、恢复与报告
- [静态代码分析](/base/yukino-agent-test/analyzer): scanner/spring/vue/状态机
- [用例生成](/base/yukino-agent-test/generation): 测试点、rule/llm/auto、质量门、计数断言
- [浏览器执行](/base/yukino-agent-test/execution): 五级回退、三层断言、视觉复核、结果分析
- [前端架构](/base/yukino-agent-test/frontend): 路由、外壳、Tab、请求模式、主题
- [API 与配置参考](/base/yukino-agent-test/api): tRPC 路由、环境变量、FAQ、术语表
