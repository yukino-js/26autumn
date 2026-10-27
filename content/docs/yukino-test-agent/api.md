---
title: "API 与配置参考"
---

# API 与配置参考

本页是平台对外接口的完整参考: tRPC 过程清单、后台任务模型、非 tRPC HTTP 端点、环境变量与错误约定, 以及排障速查与术语表。

## tRPC API 总览

根路由 `trpcRouter` 定义在 `src/integrations/trpc/router.ts`, 挂载 13 个子路由、共 79 个过程:

- **HTTP 挂载**: `src/routes/api.trpc.$.tsx` 用 `fetchRequestHandler` 处理 GET/POST, endpoint 为 `/api/trpc`; 每个请求先触发 `ensureRecovered()` (启动恢复, 见下文);
- **序列化**: superjson (`src/integrations/trpc/init.ts` 中 `initTRPC.create({ transformer: superjson })`);
- **错误中间件**: 所有过程都经 `publicProcedure`, 服务层抛出的 `BizError` 被映射为 tRPC 错误——`Math.floor(code / 100) === 404` 时取 `NOT_FOUND`, 否则 `BAD_REQUEST`, message 原样透传;
- **入参校验**: 全部用 Zod 描述; 查询为 query, 写操作与后台任务触发为 mutation。

客户端通过 `src/integrations/trpc/react.ts` 的 `createTRPCContext<TRPCRouter>()` 获得端到端类型 (`TRPCProvider` / `useTRPC`)。

### projects (9 个过程)

| 过程                           | 类型     | 说明                                                                                                  |
| ------------------------------ | -------- | ----------------------------------------------------------------------------------------------------- |
| `list`                         | query    | 项目列表                                                                                              |
| `get`                          | query    | 项目详情, 入参 `{ pid }`                                                                              |
| `create` / `update` / `delete` | mutation | 增改删, 字段 name/description/sourceType/sourcePath/gitUrl/gitBranch/targetUrl (update/delete 需 pid) |
| `prd`                          | query    | 读取项目 PRD (`{ pid }` → `{ content }`)                                                              |
| `updatePrd`                    | mutation | `{ pid, content }` 直接覆盖 PRD 文本                                                                  |
| `uploadPrd`                    | mutation | `{ pid, filename, base64 }` 上传解析                                                                  |
| `generationContext`            | query    | 生成上下文: 后端/前端代码事实 + 状态机                                                                |

`uploadPrd` 由 `parsePrdText` 解析, 支持 `.md`/`.markdown`/`.txt`/`.pdf` (unpdf)/`.docx` (mammoth), 上限 20 MB (`MAX_PRD_BYTES`); 不支持的类型或空文档分别报 `BizError` 40009/40008。

### analysis (3 个过程)

| 过程            | 类型     | 说明                                           |
| --------------- | -------- | ---------------------------------------------- |
| `trigger`       | mutation | 触发静态代码分析, 返回 `{ analysisId, jobId }` |
| `latest`        | query    | 最近一次分析结果                               |
| `stateMachines` | query    | 状态机列表                                     |

分析器本身见[静态代码分析](./analyzer)。

### requirements (8 个过程)

| 过程                           | 类型     | 说明                                                                                                                                |
| ------------------------------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `list`                         | query    | 某项目的版本列表 (`{ pid }`)                                                                                                        |
| `get`                          | query    | 版本详情 (`{ rid }`)                                                                                                                |
| `create` / `update` / `delete` | mutation | 增改删 (name/version/content)                                                                                                       |
| `uploadPrd`                    | mutation | `{ rid, filename, base64 }`, 与项目级共用 `parsePrdText`; 上传后清空测试点并作废已生成用例                                          |
| `testPoints`                   | query    | 该版本的测试点列表                                                                                                                  |
| `analyze`                      | mutation | 抽取测试点, 入参 `{ rid, mode: "auto"/"rule"/"llm" (默认 auto), profileId? }`, 返回 `{ requirementId, status: "analyzing", jobId }` |

### testcases (17 个过程)

| 过程                                                        | 类型             | 说明                                                                                                                                           |
| ----------------------------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `list`                                                      | query            | `{ pid, filters? }`, filters 支持 requirementId/type/priority/executionStatus/source/keyword                                                   |
| `get`                                                       | query            | 用例详情 (`{ cid }`)                                                                                                                           |
| `update`                                                    | mutation         | `{ cid, ... }`, 可改 title/module/type/priority/preconditions/steps/expectedResults/structuredSteps/testData/executionStatus/source/changeNote |
| `createManual`                                              | mutation         | `{ pid, ... }` 同上字段, 手工建用例                                                                                                            |
| `delete` / `deleteBulk`                                     | mutation         | 单删 (`{ cid }`) / 批删 (`{ cids }`)                                                                                                           |
| `versions` / `rollback`                                     | query / mutation | 版本快照列表 (`{ cid }`) / 回滚到指定版本 (`{ cid, vid }`)                                                                                     |
| `exportCsv`                                                 | query            | 导出项目用例为 CSV 字符串 (`{ pid }`)                                                                                                          |
| `importCsv`                                                 | mutation         | `{ pid, csv }` 导入                                                                                                                            |
| `copyTo`                                                    | mutation         | 跨项目复制 (`{ sourcePid, targetPid, cids }`)                                                                                                  |
| `forRequirement`                                            | query            | 某需求版本的用例映射 (`{ rid }` → `[{ caseId, testPointId }]`)                                                                                 |
| `clearGeneratedForRequirement` / `clearGeneratedForProject` | mutation         | 只清理 rule/ai 来源的生成用例                                                                                                                  |
| `aiReview`                                                  | mutation         | 对选中用例做 AI 质量评审 (`{ pid, cids }`, 单次最多 20 条 `MAX_REVIEW_CASES`), 同步返回逐用例 verdict/issues/score                             |
| `aiFix`                                                     | mutation         | 按问题清单修补用例 (`{ pid, cid, issues? }`), 返回 `{ summary, testCase }`, 修补写回前需通过源事实校验并记新版本                               |
| `rerunGate`                                                 | mutation         | 重跑质量门 (`{ pid, cid }` → `{ qualityScore, lintIssues }`)                                                                                   |

质量门与评审逻辑详见[用例生成](./generation)。

### generation (5 个过程)

| 过程           | 类型     | 说明                                                                                                        |
| -------------- | -------- | ----------------------------------------------------------------------------------------------------------- |
| `start`        | mutation | 后台生成用例, 入参 `{ pid, mode (auto/rule/llm, 默认 auto), requirementId?, profileId? }`, 返回 `{ jobId }` |
| `generateSync` | mutation | 同入参同步生成, 直接返回结果                                                                                |
| `coverageGaps` | query    | 覆盖自查 (`{ pid }` → `{ transitionGaps, endpointGaps }`): 已验证但无用例覆盖的状态迁移                     |
| `versions`     | query    | 某需求的生成历史 (`{ rid, limit 1-100 默认 50 }`)                                                           |
| `version`      | query    | 单次生成详情 (`{ rid, generationId }`)                                                                      |

### executions (11 个过程)

| 过程             | 类型     | 说明                                                                                                                                |
| ---------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `runSingle`      | mutation | 单个执行 (后台), `{ pid, cid, targetUrl? }` → `{ jobId, executionHint }`                                                            |
| `runBatch`       | mutation | 批量执行 (后台), `{ pid, cids, targetUrl? }` → `{ jobId, batchId }`, 同批共享 batchId                                               |
| `runSync`        | mutation | 同步执行单个用例, 直接返回执行记录                                                                                                  |
| `cancelBatch`    | mutation | 中止批量执行 (`{ batchId }` → `{ cancelled }`), 已置 cancelled 的记录不算通过                                                       |
| `list`           | query    | 执行列表: `{ pid, requirementId?, status?, batchId?, testCaseId?, page?, pageSize? (≤200, 默认 20), groupBy?: "case"/"execution" }` |
| `forCase`        | query    | 按用例查执行 (`{ pid, cid }`)                                                                                                       |
| `get` / `steps`  | query    | 执行详情 / 步骤明细 (`{ eid }`)                                                                                                     |
| `manualReview`   | mutation | 人工裁定 (`{ eid, verdict: "passed"/"failed", note? }`)                                                                             |
| `llmReview`      | mutation | 视觉复核单个执行 (`{ eid }`)                                                                                                        |
| `batchLlmReview` | mutation | 批量视觉复核 (`{ eids }` → `{ jobId }`)                                                                                             |

执行与复核语义详见[浏览器执行](./execution)。

### settings (7 个过程)

| 过程                                                | 类型     | 说明                                                                                                         |
| --------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------ |
| `info`                                              | query    | 环境信息: 档案列表、text/vision 是否可用、env 掩码、targetUrlDefault、outputDir                              |
| `listProfiles`                                      | query    | LLM 档案列表 (kind 取 text/vision, apiKey 只返回掩码)                                                        |
| `createProfile` / `updateProfile` / `deleteProfile` | mutation | 档案增改删 (name/kind/apiKey/baseUrl/model/enabled/isDefault)                                                |
| `setDefaultProfile`                                 | mutation | 设为该 kind 的默认档案                                                                                       |
| `testLlm`                                           | mutation | 连通性测试 (`{ profileId?, kind 默认 "text" }`); vision 测试会真实发送一张 1×1 PNG, 防止纯文本 ping 伪装成功 |

档案约定: 每个 kind 有且仅有一个默认; 删除时每种 kind 至少保留一个 (否则 40032, 建议 disable); 更新时把掩码串 (`xxxx***yyyy`) 原样传回表示保留已存 key。

### workflows (3 个过程)

| 过程     | 类型     | 说明                                                       |
| -------- | -------- | ---------------------------------------------------------- |
| `create` | mutation | 创建并启动流水线运行, 返回 `{ run, jobId }`                |
| `list`   | query    | 某项目的运行列表 (`{ pid, limit? }`, 默认 20)              |
| `detail` | query    | 运行详情 (`{ runId }`): 七阶段时间线 + 逐用例评审/结果分析 |

`create` 入参 (除 `pid`/`requirementId` 必填外均有默认值): `mode` (auto/rule/llm, 默认 auto)、`autoExecute` (默认 true)、`maxRevisions` (0-2, 默认 2)、`maxCases` (1-100, 默认 20)、`reuseExistingCases` (默认 true)、`reanalyzePoints` (默认 false)、`targetUrl`、`testPointLlmProfileId` / `caseLlmProfileId`、`analyzeCode` (默认 true)、`reanalyzeCode` (默认 false)、`reviewEnabled` (默认 true)、`analyzeEnabled` (默认 true)。七阶段语义见[流水线](./pipeline)。

### stats / coverage / mindmap / jobs (6 个过程)

| 过程               | 类型  | 说明                                                                                                                                |
| ------------------ | ----- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `stats.overview`   | query | 平台级统计 (dashboard): projects/testCases/executions 计数、passRate、executionStatuses/caseTypes 分组、recentExecutions/recentRuns |
| `coverage.matrix`  | query | 覆盖率矩阵 (`{ pid, requirementId? }`): 计划覆盖 vs 实际执行 (接口/状态迁移/业务规则)                                               |
| `mindmap.tree`     | query | 用例脑图树 (`{ pid, requirementId? }`), 模块 → 类型 → 用例 → 前置/步骤/预期四级                                                     |
| `mindmap.markdown` | query | 脑图 Markdown 导出                                                                                                                  |
| `mindmap.xmind`    | query | XMind 导出, 返回 base64 字符串 (保证经 superjson 传输无损)                                                                          |
| `jobs.get`         | query | 后台任务状态轮询 (`{ jobId }`); 注册表查不到时报 `BizError` 40408                                                                   |

### incremental (10 个过程)

需求增量分析子系统: 把某需求版本的代码事实冻结为不可变快照, 与基线版本对比出端点级变更, 只对变更部分增量生成用例, 并给出回归建议。持久结果在独立的 snapshot/change-run/change/case-change 表中 (见[数据模型](./data-model))。

| 过程                      | 类型     | 说明                                                                                                                   |
| ------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------- |
| `createSnapshot`          | mutation | 为 `{ rid, analysisId? }` 构建代码事实快照 (缺省取最近成功分析)                                                        |
| `snapshot`                | query    | 最新快照 (`{ rid }`)                                                                                                   |
| `analyze`                 | mutation | 对比分析 (`{ rid, baselineRequirementId, mode 默认 auto, profileId? }`), 同步返回 change run; 基线必须同项目且不同版本 |
| `runs` / `latest` / `run` | query    | 变更运行列表 (`{ rid, limit 默认 20 }`) / 最新一次 / 按 runId 详情                                                     |
| `generate`                | mutation | 增量生成 (后台), `{ runId, mode, profileId? }` → `{ jobId }`                                                           |
| `generateSync`            | mutation | 同入参同步生成                                                                                                         |
| `reviewChange`            | mutation | 人工裁定变更点 (`{ runId, changeId, status: "confirmed"/"rejected" }`)                                                 |
| `reviewRegression`        | mutation | 人工裁定回归建议 (`{ caseChangeId, status: "accepted"/"rejected" }`)                                                   |

## 后台任务 (Job) 模型

长耗时操作 (分析、生成、执行、复核、流水线、增量生成) 统一走进程内任务注册表 `src/server/lib/jobs.ts`:

- mutation 创建任务并**立即返回 jobId**, 客户端轮询 `jobs.get` 直至终态; 持久化结果始终落库, 注册表只承载 UI 进度;
- `JobState` 字段: `id`/`kind`/`status`/`message`/`current`/`total`/`result?`/`error?`/`createdAt`/`updatedAt`; status 为 `pending` → `running`, 终态 `completed` 或 `failed`;
- 八种 kind: `analysis`、`requirement-analysis`、`generation`、`workflow`、`execution`、`batch-execution`、`llm-review`、`incremental-generation`;
- 容量上限 `MAX_JOBS = 500`, 超限时淘汰最早完成的一半 finished 任务; 任务异常被捕获写入 `error`, 绝不向调用方抛出;
- 注册表只存在于进程内存: 服务重启后旧 jobId 全部失效 (查询报 40408), 需要改从对应数据表读取结果。

## 非 tRPC HTTP 端点

| 端点            | 方法 | 说明                                                                                                                                                                                 |
| --------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/api/files/$`  | GET  | 按相对路径回读 `OUTPUT_DIR` 下的证据文件 (截图/录像/报告); `resolveOutputPath` 拒绝任何越出 OUTPUT_DIR 的路径; 命中时带 `Cache-Control: public, max-age=3600`, 否则 404              |
| `/api/report/$` | GET  | 自包含 HTML 报告: `/api/report/project/:pid` (可选查询参数 `requirementId`/`workflowRunId`, `buildProjectReport`) 与 `/api/report/execution/:eid` (`buildExecutionReport`), 其余 404 |

数据库中的证据存绝对路径, 由 `toFileUrl` (`src/server/lib/files.ts`) 换算成 `/api/files/...` URL 后再下发给浏览器。

## 环境变量

配置写入 `.env.local` (`pnpm dev` 经 dotenv-cli 加载; drizzle-kit 也读 `.env.local`/`.env`), 模板见仓库根目录 `.env.example`。

| 变量                                                                                | 说明                                                                                                                                          |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                                                      | PostgreSQL 连接串 (Drizzle, 仅服务端)                                                                                                         |
| `OUTPUT_DIR`                                                                        | 执行证据目录 (截图/录像/报告), 相对 `process.cwd()` 解析, 默认 `./outputs`                                                                    |
| `TARGET_URL_DEFAULT`                                                                | 被测系统默认 URL, 默认 `http://127.0.0.1:8200` (内置演示站点)                                                                                 |
| `LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL`                                        | 初始文本模型配置; 首次读取设置时迁移进默认档案; 全部留空即纯规则模式                                                                          |
| `LLM_VISION_API_KEY` / `LLM_VISION_BASE_URL` / `LLM_VISION_MODEL`                   | 视觉模型配置; 缺项逐字段回退文本模型配置                                                                                                      |
| `LLM_EXTRA_BODY`                                                                    | 额外 JSON 字段, 合并进每个 LLM chat 请求体 (厂商私有开关, 如 `{"enable_thinking": false}`); `model`/`messages` 键始终忽略, 非法 JSON 静默丢弃 |
| `VITE_SENTRY_DSN` / `VITE_SENTRY_ORG` / `VITE_SENTRY_PROJECT` / `SENTRY_AUTH_TOKEN` | Sentry (可选); `instrument.server.mjs` 仅消费 `VITE_SENTRY_DSN`——缺失时告警并跳过初始化, 配置时 `tracesSampleRate: 0.1`                       |
| `DEMO_PORT` / `DEMO_HOST`                                                           | 演示站点端口/主机 (`scripts/demo-site/server.mjs`), 默认 8200 / 127.0.0.1                                                                     |

另有 `SERVER_URL` (服务端可选) 与 `VITE_APP_TITLE` (客户端可选) 经 `src/env.ts` 的 `@t3-oss/env-core` 校验, 客户端变量强制 `VITE_` 前缀。

### LLM 客户端默认值与档案优先级

`src/server/lib/llm.ts` 的 `LlmClient` 默认 base `https://api.openai.com/v1`、模型 `gpt-4o-mini` (`DEFAULT_BASE_URL`/`DEFAULT_MODEL`); `available()` 只看是否配置了 apiKey。客户端自带一层韧性: 回复解析容忍 markdown 围栏/散文夹杂/尾逗号/截断, `finish_reason=length` 时把 `max_tokens` 翻倍重试一次 (上限 32768), json_mode 被拒 (400/422) 时降级 plain 模式再试, GLM-5.2/5.3 自动补 `reasoning_effort=low`。

模型选择优先级 (`src/server/services/settings.ts`):

- **文本**: 显式 `profileId` → 默认 text 档案 → env (`LLM_*`); 指定档案不存在/被禁用报 40033;
- **视觉**: 默认 vision 档案 (须同时有 model 与 apiKey) → 默认 text 档案 → env (`LLM_VISION_*`, 逐字段回退 `LLM_*`);
- `ensureSeedProfiles` 在首次读取设置时把 env 单套配置迁移为默认档案, 并在每种 kind 无默认时把最早创建的档案设为默认。运行时在 Settings 页创建并设为默认的档案因此优先于环境变量。

## 错误约定

服务层统一抛 `BizError(code, message)` (`src/server/services/settings.ts` 定义)。code 为五位数字, 前三位承载类 HTTP 语义: `404xx` 由 tRPC 中间件映射为 `NOT_FOUND`, 其余映射为 `BAD_REQUEST`。常见例子: 40008 空文档、40009 不支持的文档类型、40025 评审未选用例、40030 缺档案名/API key、40031 连通性失败、40032 缺模型名/档案数不足、40033 档案不存在或被禁用、40402 用例不属于该项目、40404 档案不存在、40408 job 不存在、40410 分析记录不存在。

## 启动恢复

后台工作只活在进程内存中, 服务重启会把数据库行卡在 `pending`/`running`。首个服务端请求触发 `ensureRecovered()` (`src/server/bootstrap.ts`), 并行执行四路恢复:

- `recoverInterruptedRuns`: 中断的流水线运行标记 `failed` (错误信息 "Interrupted by server restart; re-run the pipeline")。只回收**最新活动时间超过 `staleSeconds = 7200` (2 小时)** 的运行——多 worker 同时启动时不会误杀他人正在跑的流水线;
- `recoverInterruptedExecutions`: `running` 执行记录标记 `failed` (errorCategory `ENV_ERROR`), 并把用例的 executionStatus 从 running 写回 failed;
- `recoverInterruptedAnalyses`: 中断的代码分析行标记 failed;
- `recoverInterruptedIncrementalRuns`: 卡在 `generating`/`analyzing` 的增量运行标记 failed。

## 常见问题排查

| 现象                                                     | 排查方向                                                                                                                                          |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm dev` 起不来 / 数据库连接失败                       | 检查 `.env.local` 的 `DATABASE_URL`; 确认 PostgreSQL 已启动; 执行过 `pnpm db:push`; dev 端口为 3002                                               |
| 路由 404 / 新页面不生效                                  | 新增或改名路由后运行 `pnpm generate-routes` (`src/routeTree.gen.ts` 由 tsr 生成, 勿手改)                                                          |
| 执行全部失败、`SELECTOR_NOT_FOUND` / `NAVIGATION_FAILED` | 确认 `targetUrl` 指向真实可访问的被测站点 (演示站点 `pnpm demo-site`); 锚点/选择器是否来自最新代码事实——先重跑代码分析                            |
| 断言总是 skipped                                         | 预期结果缺少双引号文本锚点或可验证 URL——引用真实页面文案                                                                                          |
| 视觉复核 unavailable                                     | 未配置可用视觉档案或调用失败/无截图; 属诚实降级, 不影响确定性执行结论                                                                             |
| 流水线卡在 running                                       | 服务重启会中断进程内任务; 静置超过 2 小时后启动恢复会将其标记为 failed, 重新发起即可                                                              |
| 轮询 jobId 报 40408                                      | job 注册表在进程内存中, 重启即失效; 持久结果改查对应数据表 (分析/执行/流水线运行)                                                                 |
| LLM 返回无法解析 / 频繁超时                              | 换更大的 `max_tokens` 余量或用 `LLM_EXTRA_BODY` 关闭厂商思考模式; 客户端已内置截断修复与降级重试, 仍失败会抛 `LlmUnavailableError` 并降级规则模式 |
| `pnpm check` 失败                                        | 运行 `pnpm format` (prettier -w) 后重试; `pnpm lint` 单独跑 eslint                                                                                |

## 术语表

| 术语                         | 含义                                                                                      |
| ---------------------------- | ----------------------------------------------------------------------------------------- |
| SUT                          | System Under Test, 被测系统 (内置演示站点即一个 SUT)                                      |
| 代码事实 (Code Facts)        | 静态分析抽取的 endpoints/entities/rules/forms/state machines, 用于给用例接地              |
| 接地 (Grounding)             | 让选择器与断言引用真实存在的页面文案/接口, 而非凭空捏造                                   |
| 测试点 (Test Point)          | 从 PRD 抽取的应覆盖场景, 是需求与用例之间的桥梁                                           |
| 结构化步骤 (Structured Step) | 可被 Playwright 直接执行的步骤契约, `StepType` 取 ui_action/input/state_assert/capture    |
| 锚点 (Anchor)                | 预期结果中用双引号引用的可见页面文案, 断言时精确查找                                      |
| 回退链 (Fallback Chain)      | 由精确到宽泛的五级选择器定位策略 (`fallbackChain`), 降低脚本脆弱性                        |
| 三层断言                     | URL 断言 → 引号文本锚点断言 → 诚实 skipped                                                |
| 质量门 (Quality Gate)        | 对生成用例的确定性体检 (lint/打分/去重), 只有 kept 才持久化                               |
| 修复轮 (Repair Round)        | 对评审为 revise 的用例, 让 LLM 依据问题清单修补, 最多 maxRevisions 轮                     |
| 失败分类 (Failure Category)  | product_defect / test_script_issue / test_data_issue / environment_issue / unknown / none |
| 证据 (Evidence)              | 截图、录像、步骤记录、断言明细等客观材料, 存于 OUTPUT_DIR                                 |
| 视觉复核 (Vision Review)     | 视觉模型逐图判断 ok/suspect, 可升级人工但绝不把失败改成通过                               |
| 任务 (Job)                   | 进程内后台任务, mutation 返回 jobId, 客户端轮询 `jobs.get` 直至终态                       |
| 覆盖率矩阵                   | 计划覆盖 vs 实际执行覆盖 (接口/状态迁移/业务规则)                                         |
| 代码快照 (Snapshot)          | 为需求版本冻结的不可变代码事实, 增量对比只读快照, 后续重新分析不会改写基线                |
| 增量运行 (Change Run)        | 一次「当前版本 vs 基线版本」的变更检测及其派生的用例变更/回归建议                         |
| BizError                     | 服务层业务错误, code 前三位为 404 映射 NOT_FOUND, 其余 BAD_REQUEST                        |
| 绝不伪造绿色                 | 最高准则: 无法验证即诚实 skipped/failed, 确定性结论压过 AI 意见                           |
