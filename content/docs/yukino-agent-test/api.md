---
title: "API 与配置参考"
---

# API 与配置参考

## tRPC API 参考

根路由 `trpcRouter` (`src/integrations/trpc/router.ts`) 挂载 12 个子路由, 经 `/api/trpc/$` 暴露, superjson 序列化。过程名以源码为准 (query=读, mutation=写/触发任务)。

### projects

| 过程                           | 类型     | 说明                                                                       |
| ------------------------------ | -------- | -------------------------------------------------------------------------- |
| `list`                         | query    | 项目列表                                                                   |
| `get`                          | query    | 项目详情, 入参 `{ pid }`                                                   |
| `create` / `update` / `delete` | mutation | 增改删 (name/description/sourceType/sourcePath/gitUrl/gitBranch/targetUrl) |
| `prd`                          | query    | 读取项目 PRD                                                               |
| `updatePrd` / `uploadPrd`      | mutation | 更新 PRD / base64 上传 (仅 `.md`/`.txt`)                                   |
| `generationContext`            | query    | 生成上下文 (后端/前端事实 + 状态机)                                        |

### analysis

| 过程            | 类型     | 说明                     |
| --------------- | -------- | ------------------------ |
| `trigger`       | mutation | 触发代码分析, 返回 jobId |
| `latest`        | query    | 最近一次分析结果         |
| `stateMachines` | query    | 状态机列表               |

### requirements

`list` / `get` / `create` / `update` / `delete`、`uploadPrd` (base64)、`analyze` (抽取测试点, 返回 jobId)、`testPoints` (某需求的测试点列表)。

### testcases

`list` / `get` / `update` / `createManual` / `delete` / `deleteBulk`、`versions` / `rollback` (版本快照与回滚)、`exportCsv` / `importCsv`、`copyTo` (跨项目复制)、`forRequirement`、`clearGeneratedForRequirement` / `clearGeneratedForProject` (只清 rule/ai 来源)。

### generation

| 过程           | 类型     | 说明                                     |
| -------------- | -------- | ---------------------------------------- |
| `start`        | mutation | 启动用例生成 (后台任务, 返回 jobId)      |
| `generateSync` | mutation | 同步生成 (小批量直接返回结果)            |
| `coverageGaps` | query    | 覆盖缺口 (transitionGaps / endpointGaps) |

### executions

| 过程                                 | 类型     | 说明                                                   |
| ------------------------------------ | -------- | ------------------------------------------------------ |
| `runSingle` / `runBatch`             | mutation | 单个/批量执行 (后台任务, 返回 jobId; 批量共享 batchId) |
| `runSync`                            | mutation | 同步执行单个用例                                       |
| `cancelBatch`                        | mutation | 中止批量执行 (cancelled 不算通过)                      |
| `list` / `forCase` / `get` / `steps` | query    | 执行列表/按用例/详情/步骤                              |
| `manualReview`                       | mutation | 人工裁定                                               |
| `llmReview` / `batchLlmReview`       | mutation | 视觉复核 (单个/批量)                                   |

### settings

`info` (环境信息)、`listProfiles` / `createProfile` / `updateProfile` / `deleteProfile` / `setDefaultProfile` (LLM 档案, kind 取 text/vision)、`testLlm` (连通性测试)。

### workflows

| 过程     | 类型     | 说明                                                                    |
| -------- | -------- | ----------------------------------------------------------------------- |
| `create` | mutation | 创建并启动流水线运行 (入参见[流水线](/base/yukino-agent-test/pipeline)) |
| `list`   | query    | 某项目的运行列表 (默认 limit 20)                                        |
| `detail` | query    | 运行详情 (阶段时间线 + 逐用例评审/分析)                                 |

### stats / coverage / mindmap / jobs

- `stats.overview`: 平台级统计 (dashboard);
- `coverage.matrix`: 覆盖率矩阵, 入参 `{ pid, requirementId? }`;
- `mindmap.tree` / `mindmap.markdown`: 用例脑图树与 Markdown 导出;
- `jobs.get`: 后台任务状态轮询。

## 环境变量 (.env.local)

| 变量                                                                                | 说明                                                             |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `DATABASE_URL`                                                                      | PostgreSQL 连接串 (Drizzle, 仅服务端)                            |
| `OUTPUT_DIR`                                                                        | 执行证据目录 (截图/录像/报告), 默认 `./outputs`                  |
| `TARGET_URL_DEFAULT`                                                                | 被测系统默认 URL, 默认 `http://127.0.0.1:8200` (演示站点)        |
| `LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL`                                        | 初始文本模型配置; 首次读取设置时迁移进默认档案; 留空即纯规则模式 |
| `LLM_VISION_API_KEY` / `LLM_VISION_BASE_URL` / `LLM_VISION_MODEL`                   | 视觉模型配置; 未配置时回退文本档案                               |
| `VITE_SENTRY_DSN` / `VITE_SENTRY_ORG` / `VITE_SENTRY_PROJECT` / `SENTRY_AUTH_TOKEN` | Sentry (可选)                                                    |
| `DEMO_PORT` / `DEMO_HOST`                                                           | 演示站点端口/主机 (默认 8200 / 127.0.0.1)                        |

LLM 客户端默认值 (`server/lib/llm.ts`): base `https://api.openai.com/v1`, 模型 `gpt-4o-mini`。运行时在 Settings 页创建并设为默认的档案优先于环境变量。

## 常见问题排查

| 现象                               | 排查方向                                                                                    |
| ---------------------------------- | ------------------------------------------------------------------------------------------- |
| `pnpm dev` 起不来 / 数据库连接失败 | 检查 `.env.local` 的 `DATABASE_URL`; 确认 PostgreSQL 已启动; 执行过 `pnpm db:push`          |
| 路由 404 / 新页面不生效            | 新增或改名路由后运行 `pnpm generate-routes` (`routeTree.gen.ts` 是自动生成的)               |
| 执行全部失败、`SELECTOR_NOT_FOUND` | 确认 `targetUrl` 指向真实可访问的被测站点; 锚点/选择器是否来自最新代码事实 (先重跑代码分析) |
| 断言总是 skipped                   | 预期结果缺少引号锚点或可验证 URL——用双引号引用真实页面文案                                  |
| 视觉复核 unavailable               | 未配置视觉模型或调用失败/无截图; 属诚实降级, 不影响确定性执行结论                           |
| 流水线卡在 running                 | 服务重启会中断运行; `recoverInterruptedRuns` 会将其标记为 cancelled, 重新发起即可           |
| `pnpm check` 失败                  | 运行 `pnpm format` (prettier --write + eslint --fix) 后重试                                 |
| `pnpm lint` 报 server 判空告警     | 既有的 `no-unnecessary-condition` (防御性代码), 非迁移引入, 可暂不处理                      |
| `intent` 命令不可用                | AGENTS.md 要求的 Intent 技能工具未安装; 如需启用 `pnpm add -D @tanstack/intent`             |

## 术语表

| 术语                         | 含义                                                                                      |
| ---------------------------- | ----------------------------------------------------------------------------------------- |
| SUT                          | System Under Test, 被测系统 (演示站点即一个 SUT)                                          |
| 代码事实 (Code Facts)        | 静态分析抽取的 endpoints/entities/rules/forms/state machines, 用于给用例接地              |
| 接地 (Grounding)             | 让选择器与断言引用真实存在的页面文案/接口, 而非凭空捏造                                   |
| 测试点 (Test Point)          | 从 PRD 抽取的应覆盖场景, 是需求与用例之间的桥梁                                           |
| 结构化步骤 (Structured Step) | 可被 Playwright 直接执行的步骤契约 (ui_action/input/state_assert/capture)                 |
| 锚点 (Anchor)                | 预期结果中用双引号引用的可见页面文案, 断言时精确查找                                      |
| 回退链 (Fallback Chain)      | 由精确到宽泛的五级选择器定位策略, 降低脚本脆弱性                                          |
| 三层断言                     | URL 断言 → 引号文本锚点断言 → 诚实 skipped                                                |
| 质量门 (Quality Gate)        | 对生成用例的确定性体检 (lint/打分/去重), 只有 kept 才持久化                               |
| 修复轮 (Repair Round)        | 对评审为 revise 的用例, 让 LLM 依据问题清单修补, 最多 maxRevisions 轮                     |
| 失败分类 (Failure Category)  | product_defect / test_script_issue / test_data_issue / environment_issue / unknown / none |
| 证据 (Evidence)              | 截图、录像、步骤记录、断言明细、Navigation Timing 等客观材料                              |
| 视觉复核 (Vision Review)     | 视觉模型逐图判断 ok/suspect, 可升级人工但绝不把失败改成通过                               |
| 任务 (Job)                   | 进程内后台任务, mutation 返回 jobId, 客户端轮询直至终态                                   |
| 覆盖率矩阵                   | 计划覆盖 vs 实际执行覆盖 (接口/状态迁移/业务规则)                                         |
| BizError                     | 服务层业务错误, code 百位为 404 映射 NOT_FOUND, 其余 BAD_REQUEST                          |
| 绝不伪造绿色                 | 最高准则: 无法验证即诚实 skipped/failed, 确定性结论压过 AI 意见                           |
