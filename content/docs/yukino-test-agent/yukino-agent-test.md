---
title: "Yukino QA 概览"
description: "Yukino QA (yukino-agent-test) 总览: 第一性原则、七阶段流水线、技术栈、快速上手、环境变量、目录结构与 npm 脚本."
local_path: "$HOME/github/yukino-test-agent"
local_commit: "939179e40f2ca6f25e141dbb5d2d5c61c49304be"
---

**Yukino QA** 是一个 AI 驱动的测试平台: 输入「一份代码库」和「一份产品需求文档 (PRD)」, 自动产出结构化测试用例, 在真实浏览器 (Playwright + Chromium) 中执行, 并结合「确定性校验」与「可选的视觉大模型」对执行证据进行复核, 最终输出覆盖率矩阵与自包含 HTML 报告.

一句话概括:

> 从代码事实与需求出发, 自动生成测试用例 → 真实浏览器执行 → 基于证据复核 → 输出覆盖率与报告.

代码仓库位于 `~/github/yukino-test-agent`. 应用本身 (UI、代码、注释、数据库状态码) 是**纯英文项目**, 本文档系列是中文学习资料.

## 第一性原则: 绝不伪造绿色结果

这是贯穿整个代码库的最高准则 (never fake a green result), 在代码中有五处强制执行点:

- **确定性结论优先于 AI 意见**: Playwright 的确定性执行判定永远压过视觉模型的判断; 视觉模型只能「确认」或「质疑」, 不能把明确的失败改成通过. 复核调用本身也有独立守卫 (`src/server/services/executions.ts`): AI 复核抛错只记录日志并保留确定性状态, 浏览器里已经通过的执行绝不因复核故障被改写.
- **无法验证的步骤诚实地标记为 skipped**: `src/server/lib/execution/runner.ts` 的 `doAssert` 是分层断言 — URL 路径与带引号的文案锚点各自独立解析、独立校验, 所有可验证维度都命中才算 `passed`, URL 命中而文案锚点缺失绝不是绿色; URL 匹配按路径段全匹配并支持 `{id}` 占位符, 杜绝 `/order` 命中 `/orders` 这类子串假绿. 预期结果里既没有可解析的 URL 路径也没有带引号锚点时, 返回 `skipped` 而不是「没有报错就算 passed」.
- **输入步骤留下可校验证据**: fill 之后 runner 回读 DOM 实际值, 生成长度、SHA-256 哈希、是否一致与预览等结构化证据 (密码等敏感字段只记长度与一致性, 绝不记明文), 写入 `execution_steps.evidence` jsonb 列并注入视觉复核提示词 — 长输入不再依赖截图猜测.
- **视觉复核只接受显式 ok**: `src/server/lib/execution/vision-review.ts` 对每张截图的判定只认字面量 `"ok"`, 其余 (空值、乱码、缺失分析) 一律记为 `suspect`; 只要发现具体问题、任一截图可疑、或分析数量少于截图数量, 总体结论就降级为 `suspect`. 截图预算随步骤结果自适应: 基础 6 张, 任一步骤未通过提高到 10 张; 若首轮仅因证据不足而 suspect 且仍有更多截图, 自动以 12 张的扩展预算复核第二轮, 不留下「假 suspect」. 模型不可用时给出 `unavailable`, 交人工复核, 绝不假装通过.
- **证据驱动的失败分类不覆盖执行状态**: 结果分析阶段把失败归类为产品缺陷/脚本问题/数据问题/环境问题/未知, 但只写 `workflow_result_analyses` 表并保存客观状态快照, **绝不修改** `execution_records.status` (见 `src/server/services/workflows.ts` 的设计注释与 `guardAnalysis`). 此外, 被取消 (cancelled) 的执行不算通过.

## 它解决什么问题

传统自动化测试的痛点:

- 用例编写成本高、与真实页面文案/选择器脱节;
- 脚本脆弱, 元素定位一旦变化就大面积失败;
- 「跑通即通过」的误判: 没有报错就被当成绿色, 掩盖真实缺陷;
- 失败原因难以归类 (产品缺陷、脚本问题、数据问题还是环境问题).

Yukino QA 用「**代码事实接地 (grounding) + 五级选择器回退 + 分层断言 + 证据驱动复核**」系统性地应对这些问题: 静态分析从源码中抽取 endpoints、实体约束、业务规则、UI 表单与状态机, 生成的用例引用的选择器与断言锚点都是代码里真实存在的文案; 执行时对每一步截图、录像, 除结构化步骤证据外还记录可校验的输入证据, 元素定位沿回退链逐级自动等待可见 (每级 2.5 秒) 而非一次性计数, 慢速异步渲染不再产生假性的元素未找到失败.

## 七阶段流水线

`src/server/services/workflows.ts` 编排一条闭环流水线, 阶段常量 `STAGES` 定义了七个阶段:

| #   | 阶段              | 做什么                                                                      |
| --- | ----------------- | --------------------------------------------------------------------------- |
| 1   | `code_analysis`   | 刷新静态代码事实 (可选, 纯规则零 LLM)                                       |
| 2   | `test_points`     | 从 PRD + 代码事实抽取测试点 (LLM 优先, 规则兜底)                            |
| 3   | `case_generation` | 生成用例, 模式 `rule` / `llm` / `auto`, 由代码事实接地                      |
| 4   | `case_review`     | 确定性质量门 + LLM 评审, 最多两轮修复; 阻断性问题直接拒收, 被拒用例绝不执行 |
| 5   | `execution`       | Playwright 在真实浏览器中执行已批准的自动化用例                             |
| 6   | `result_analysis` | 证据驱动的失败分类 (产品缺陷/脚本/数据/环境/未知), 不覆写执行状态           |
| 7   | `report`          | 生成自包含 HTML 汇总报告                                                    |

每个阶段都落库 (`workflow_stages`), 某阶段失败时保留已有产物并把后续阶段标记为 `skipped`, 数据绝不静默丢失. 评审阶段确定性质量门的必填字段完整性检查有严格作用域: 只适用于实际提交表单的 positive/functional 用例, 且只检查用例导航到的那个页面的必填字段 — 负向、边界与状态用例天然不在检查范围, 不会被「必填字段未填写」误判. 除流水线外, 需求版本升级还有独立的**增量分析**链路 (`src/server/services/incremental.ts`): 冻结需求快照 → 对比基线 → 结构化变更 (endpoint/业务规则/状态迁移/权限/冲突) → 增量生成与回归建议.

编排、硬/软失败与恢复细节见[七阶段流水线](./pipeline).

## 技术栈

| 层次         | 选型                        | 说明                                                        |
| ------------ | --------------------------- | ----------------------------------------------------------- |
| 应用框架     | TanStack Start              | 基于 Vite 8 + Nitro 的 SSR 全栈框架                         |
| 路由         | TanStack Router             | 文件式路由、端到端类型安全                                  |
| 数据请求     | TanStack Query + tRPC v11   | superjson 转换器                                            |
| 数据库       | PostgreSQL + Drizzle ORM    | 26 张表, 结构化载荷用 jsonb                                 |
| 样式         | Tailwind CSS v4 + shadcn/ui | new-york 风格、zinc 基色、CSS 变量主题                      |
| 校验         | Zod                         | tRPC 入参与领域校验                                         |
| 浏览器自动化 | Playwright                  | Chromium 执行、分步截图、录像                               |
| UI           | React 19 + TypeScript 6     | 启用 React Compiler (`@rolldown/plugin-babel` 预设)         |
| 文档解析     | mammoth / unpdf             | PRD 上传解析 `.docx` / `.pdf`                               |
| 图标/通知    | lucide-react / sonner       | —                                                           |
| 监控 (可选)  | Sentry                      | `instrument.server.mjs` 中初始化, 由 `VITE_SENTRY_DSN` 控制 |

选型理由:

- **TanStack Start + Router + Query + tRPC**: 从数据库到浏览器全链路类型贯通, 服务层函数签名即 API 契约, 几乎杜绝「前后端字段对不上」.
- **Drizzle + jsonb**: 关系型骨架 (项目/需求/用例/执行/流水线) 用规范表; 高度结构化、随领域演进的载荷 (结构化步骤、步骤证据、代码事实、评审问题、变更明细) 用 jsonb, 并以共享 TS 类型 (`src/lib/types.ts`) 约束.
- **Playwright**: 真实浏览器执行是「绝不伪造绿色」的物理基础——只有真实点过、真实断言过, 才算数.

## 快速上手

前置条件: Node.js 20+、pnpm 9+、PostgreSQL 14+、Playwright 浏览器.

```bash
# 1. 安装依赖
pnpm install

# 2. 配置环境变量 (至少填 DATABASE_URL, 并先创建对应数据库)
cp .env.example .env.local

# 3. 安装浏览器并把 26 张表推送到数据库
pnpm exec playwright install chromium
pnpm db:push

# 4. 启动开发服务器, 打开 http://localhost:3002
pnpm dev
```

开发端口是 **3002** (`vite dev --port 3002`, 避开本机 docker-compose 里占用 3000 的 Grafana).

### 演示目标站点 (SUT)

仓库自带一个英文「订单管理」演示站点作为被测系统 (`scripts/demo-site/server.mjs` + 三个静态页), 其可见文案与生成器产出的锚点刻意一致 (如 `"Order created successfully"`、`"Payment successful"`、`"{Label} cannot be empty"`、`"Total of N items"`):

```bash
pnpm demo-site   # 服务于 http://127.0.0.1:8200 (可用 DEMO_HOST/DEMO_PORT 覆盖)
```

路由: `/` → index、`/orders/create` → 创建订单、`/orders/list` → 订单列表, 其余路径 SPA 回退到首页. 随后在平台中创建项目, **Target URL** 填 `http://127.0.0.1:8200`, 附上 PRD, 即可运行流水线.

### 纯规则模式 (无需 LLM)

`LLM_*` 环境变量留空时, 平台以**纯规则模式**运行: 代码分析、规则用例生成、确定性评审、Playwright 执行、规则化结果分析全部可用, 只跳过 LLM 生成与视觉复核. 本地零成本即可体验完整链路.

### 端到端自检

```bash
pnpm e2e
```

`scripts/e2e.mts` 用 `scripts/sample-src` (一个 Go + yukino_http 后端、Lit + @yukino.js/lit-jsx 前端的分析夹具) 跑一遍「静态分析 → 规则生成 → 对演示站点真实执行 → 覆盖率矩阵」的完整链路, 自动创建并清理临时项目, 证据写入临时目录. 验收标准: 生成用例不少于 12 条、通过率不低于 90%、每次执行有录像. 另有只读的 `scripts/evaluate.mts`, 按项目或需求版本输出用例质量指标 JSON.

## 环境变量

服务端配置在 `src/server/env.ts` 中读取, `.env.example` 提供模板; 演示站点与 e2e 脚本另行读取 `DEMO_HOST`/`DEMO_PORT` 与 `E2E_TARGET_URL`:

| 变量                                                                                | 说明                                                                                                     |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                                                      | PostgreSQL 连接串, Drizzle 使用 (仅服务端)                                                               |
| `OUTPUT_DIR`                                                                        | 执行证据 (截图/录像/报告) 输出目录, 默认 `./outputs`                                                     |
| `TARGET_URL_DEFAULT`                                                                | 被测系统默认 URL, 默认 `http://127.0.0.1:8200`                                                           |
| `LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL`                                        | 可选的初始文本模型配置; 首次读取设置时迁移为默认 LLM 档案, 留空即纯规则模式                              |
| `LLM_VISION_API_KEY` / `LLM_VISION_BASE_URL` / `LLM_VISION_MODEL`                   | 可选视觉模型配置, 未配置时回退到文本档案                                                                 |
| `LLM_EXTRA_BODY`                                                                    | 合并进每次 LLM 请求体的额外 JSON 字段 (如 `{"enable_thinking": false}`), `model`/`messages` 键始终被忽略 |
| `VITE_SENTRY_DSN` / `VITE_SENTRY_ORG` / `VITE_SENTRY_PROJECT` / `SENTRY_AUTH_TOKEN` | 可选 Sentry 监控; 运行时初始化只读取 `VITE_SENTRY_DSN`, 其余三个仅列于 `.env.example`                    |
| `DEMO_HOST` / `DEMO_PORT`                                                           | 演示站点监听地址/端口, 默认 `127.0.0.1` / `8200`                                                         |
| `E2E_TARGET_URL`                                                                    | e2e 自检的目标站点, 默认 `http://127.0.0.1:8200`                                                         |

LLM 档案 (文本/视觉两类) 也可以在运行时于 **Settings** 页面管理, 存于 `llm_profiles` 表; 被标记为默认的档案优先于环境变量.

## 目录结构

```text
yukino-test-agent/
├─ src/
│  ├─ db/                 Drizzle 客户端 (index.ts) 与表结构 (schema.ts, 26 张表)
│  ├─ env.ts              客户端环境变量校验 (@t3-oss/env-core)
│  ├─ router.tsx          TanStack Router 实例 (SSR Query 集成)
│  ├─ routeTree.gen.ts    路由树 (tsr generate 自动生成, 勿手改)
│  ├─ styles.css          Tailwind v4 + shadcn 主题变量
│  ├─ integrations/
│  │  ├─ trpc/            init.ts (BizError 映射) / router.ts (13 个子路由) / react.ts (客户端代理)
│  │  └─ tanstack-query/  root-provider.tsx, devtools.tsx
│  ├─ routes/             文件式路由: 11 个页面路由 + 3 个 API 路由
│  ├─ components/
│  │  ├─ ui/              shadcn/ui 基础组件 (27 个)
│  │  ├─ project/         项目详情 8 个 Tab 面板 + 用例编辑/评审对话框 (第 9 个 executions Tab 复用 executions/ExecutionsPanel)
│  │  ├─ executions/      执行面板与截图查看器
│  │  └─ *.tsx            AppSidebar/PageHeader/StatusBadge/EmptyState/ProjectPicker/
│  │                      ProjectDialog/QuickStartDialog/ThemeToggle
│  ├─ hooks/              use-job-poller.ts, use-theme.ts, use-mobile.ts
│  ├─ lib/                types.ts (领域类型) / enums.ts (状态码→展示元数据) /
│  │                      format.ts / prd.ts (上传校验) / utils.ts
│  └─ server/
│     ├─ bootstrap.ts     启动恢复: 首个请求时把中断的 run/执行/分析/增量运行标记为 failed
│     ├─ env.ts           服务端配置 (OUTPUT_DIR/TARGET_URL_DEFAULT/LLM_*)
│     ├─ services/        业务编排层 (14 个服务模块)
│     └─ lib/             领域引擎 (analyzer/generation/execution/evaluation/
│                         coverage/jobs/llm/mindmap/files/text-list)
├─ scripts/
│  ├─ demo-site/          内置英文订单系统演示站点 (Node 静态服务器 + 3 个页面)
│  ├─ e2e.mts             端到端自检脚本
│  ├─ evaluate.mts        用例质量指标评估 (只读)
│  └─ sample-src/         分析夹具: Go/yukino_http 后端 + Lit 前端
├─ instrument.server.mjs  Sentry 初始化 (可选, dev/start 均通过 --import 加载)
├─ drizzle.config.ts / vite.config.ts / tsconfig.json / components.json / package.json
```

路径别名: `#/*` 与 `@/*` 都指向 `./src/*` (见 `package.json#imports` 与 `tsconfig.json#paths`), 代码中统一使用 `#/...`.

页面路由: `/dashboard` (平台统计)、`/projects` 与 `/projects/$projectId` (项目详情, 搜索参数 `tab` 切换 overview/analysis/requirements/incremental/generation/cases/mindmap/executions/coverage 九个 Tab)、`/projects/$projectId/cases/$caseId` (用例详情)、`/testcases`、`/pipeline` 与 `/pipeline/$runId`、`/executions` 与 `/executions/$executionId`、`/settings`; `/` 重定向到 `/dashboard`. API 路由: `/api/trpc/$` (tRPC HTTP 处理)、`/api/files/$` (从 `OUTPUT_DIR` 提供证据文件)、`/api/report/$` (提供生成的 HTML 报告).

## npm 脚本

| 脚本                                                                    | 说明                                                                     |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `pnpm dev`                                                              | dotenv 加载 `.env.local` + Sentry instrumentation + vite dev (端口 3002) |
| `pnpm build`                                                            | vite build 并把 `instrument.server.mjs` 拷入 `.output/server`            |
| `pnpm start`                                                            | 以生产模式运行 `.output/server/index.mjs` (同样 --import Sentry 初始化)  |
| `pnpm preview`                                                          | 预览生产构建                                                             |
| `pnpm demo-site`                                                        | 启动演示被测站点 (默认端口 8200)                                         |
| `pnpm e2e`                                                              | 端到端自检: 分析夹具 → 规则生成 → 对演示站点真实执行                     |
| `pnpm generate-routes`                                                  | `tsr generate` 重新生成路由树                                            |
| `pnpm db:push` / `db:generate` / `db:migrate` / `db:pull` / `db:studio` | drizzle-kit 系列                                                         |
| `pnpm lint` / `format` / `check`                                        | ESLint 自动修复 (`--fix --quiet`) / Prettier 写入 / prettier --check     |

没有专门的 `typecheck` 脚本, 类型检查用 `pnpm exec tsc --noEmit`. lint 配置在 TanStack 严格配置之上关闭了少数规则, 其中 `@typescript-eslint/no-unnecessary-condition` 是刻意关闭的 — 服务端代码对数据库信任边界 (JSONB 列、`rows[0]` 访问、持久化的分析载荷) 保留防御性判空; 忽略清单覆盖 `.legacy`、构建产物、生成的路由树与 `scripts/sample-src` 夹具. 当前全仓 `eslint . --quiet` 零报错.

## 文档目录

- [架构总览](./architecture): 分层、请求数据流、异步任务、错误处理、LLM 档案
- [数据模型](./data-model): 26 张表、领域类型、状态码元数据
- [七阶段流水线](./pipeline): 编排逻辑、硬/软失败、恢复与报告
- [静态代码分析](./analyzer): scanner/spring/go/vue/lit/状态机
- [用例生成](./generation): 测试点、rule/llm/auto、质量门、计数断言
- [浏览器执行](./execution): 五级回退、分层断言、视觉复核、结果分析
- [前端架构](./frontend): 路由、外壳、Tab、请求模式、主题
- [API 与配置参考](./api): tRPC 路由、环境变量、FAQ、术语表
