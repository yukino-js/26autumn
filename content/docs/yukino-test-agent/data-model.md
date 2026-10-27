---
title: "数据模型"
---

# 数据模型 (26 张表)

数据库结构定义在 `src/db/schema.ts` (Drizzle ORM + PostgreSQL, 共 721 行); 连接客户端在 `src/db/index.ts` (`drizzle-orm/node-postgres`, 读取环境变量 `DATABASE_URL`); 迁移由 drizzle-kit 按 `drizzle.config.ts` 生成到 `./drizzle` 目录 (dialect `postgresql`)。

设计约定:

- **主键**: 多为服务层生成的 32 位 uuid hex 字符串 (无连字符, `varchar(36)`, 见 `server/services/projects.ts` 的 `uuid()`); 两类例外使用人类可读 ID——`test_cases` 用 `TC-000001` 式全局序列 (`varchar(20)` + 项目内序号 `projectSeq`), `execution_records` 用 `EX-xxxxxxxx` (uuid 前 8 位)。
- **并发安全 ID**: `id_sequences` 表保存跨进程单调计数器。`server/services/testcases.ts` 的 `nextSequenceValue` 在与插入同一个事务里对计数行加 `FOR UPDATE` 行锁, 取代并发下会发放重复主键的 `max(id)+1` 扫描; 首次分配会用现存行回填计数 (数值比较而非字典序), 保证永不倒退。
- **结构化载荷**: 用 jsonb 列, 并以 `src/lib/types.ts` 中的共享领域类型约束 (Drizzle 的 `$type<T>()`)。
- **状态码**: 数据库只存稳定的英文码 (如 `passed`/`failed`/`needs_review`), 展示元数据 (label/tone/description) 统一放在 `src/lib/enums.ts`。
- **时间**: 统一 `timestamp with timezone` + `defaultNow()`。
- **反规范化快照**: 历史表冻结上下文, 用例/需求被改名或删除后仍可读——`execution_records.testCaseTitle` 与必填的 `testCaseSnapshot` (执行时刻的完整用例快照), `execution_requirements.requirementVersion/requirementName`, `workflow_runs.requirementVersion/requirementName`。

## 表清单 (按域分组)

| 域       | 表                         | 说明                                                                                                                                                                                                       |
| -------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 项目     | `projects`                 | 项目 (name/description/sourceType 默认 `local_path`/sourcePath/gitUrl/gitBranch/techStack jsonb/prdContent/targetUrl)                                                                                      |
| 代码分析 | `code_analyses`            | 每次静态分析一条 (status 默认 pending/backendResult/frontendResult/warnings jsonb/errorMessage)                                                                                                            |
| 代码分析 | `state_machines`           | 推断出的状态机 (name/states/transitions jsonb/confidence real 默认 0)                                                                                                                                      |
| 需求     | `requirements`             | 需求版本 (name/version 默认 V1.0/content/sourceFile/status 默认 draft/errorMessage)                                                                                                                        |
| 需求     | `test_points`              | 测试点 (seq/title/category 默认 functional/priority 默认 P1/description/pageRoute/endpoint/fields jsonb/expected/source 默认 rule/confidence 默认 1)                                                       |
| 增量需求 | `requirement_snapshots`    | 按需求版本冻结的不可变代码事实快照 (详见「增量需求域」)                                                                                                                                                    |
| 增量需求 | `requirement_change_runs`  | 一次增量变更分析/生成运行 (status/mode/baselineSnapshotId/currentSnapshotId/summary jsonb)                                                                                                                 |
| 增量需求 | `requirement_changes`      | 两个快照之间的一条结构化变更 (entityType/changeType/matchKey/oldData/newData/confidence/requiresConfirmation/reviewStatus)                                                                                 |
| 增量需求 | `requirement_case_changes` | 增量运行中每条基线用例的去向 (action/regressionImpact/regressionStatus/dedupeKey 唯一索引保证幂等)                                                                                                         |
| 用例     | `test_cases`               | 测试用例 (详见下节)                                                                                                                                                                                        |
| 用例     | `test_case_versions`       | 用例版本快照 (version 整数/snapshot jsonb 必填/changeNote), 支持回滚                                                                                                                                       |
| 用例     | `requirement_cases`        | 需求 ↔ 用例 关联 (可带 testPointId), 多对多桥表                                                                                                                                                            |
| 用例     | `case_generations`         | 每次生成运行的归档 (mode/profileId/caseCount/summary jsonb/snapshot jsonb), 供 UI 版本下拉与只读回溯, 不改写在用用例                                                                                       |
| 用例     | `id_sequences`             | 命名计数器 (name 主键/value/updatedAt), TC 编号与项目内序号的并发安全来源                                                                                                                                  |
| 执行     | `execution_records`        | 执行记录 (testCaseTitle/testCaseSnapshot jsonb 必填/batchId/status 默认 running/mode 默认 programmatic/targetUrl/startTime/endTime/durationMs/errorCategory/errorMessage/videoPath/passedSteps/totalSteps) |
| 执行     | `execution_requirements`   | 执行 ↔ 需求版本 快照关联 (requirementVersion/requirementName), `ux_execution_requirements_exec` 唯一索引 ⇒ 一条执行至多一条                                                                                |
| 执行     | `execution_steps`          | 逐步记录 (stepIndex/action/target/stepType 默认 ui_action/selectorUsed/result 默认 passed/screenshotBefore/screenshotAfter/error/durationMs)                                                               |
| 复核     | `execution_reviews`        | 复核结论 (verdict/reason/model/imageCount/reviewer llm 或 manual/reviewerNote/reviewedAt), `ux_execution_reviews_exec` 唯一索引 ⇒ 与执行记录 1─1                                                           |
| 复核     | `execution_review_images`  | 逐图判定 (imageIndex/stepIndex/label/screenshot/verdict/analysis/bbox jsonb 四元组)                                                                                                                        |
| 复核     | `execution_review_issues`  | 复核发现的问题 (imageIndex/stepIndex/label/screenshot/bbox jsonb/problem)                                                                                                                                  |
| 配置     | `llm_profiles`             | LLM 档案 (name/kind text 或 vision/apiKey/baseUrl/model/enabled/isDefault), 索引 (kind, enabled)                                                                                                           |
| 流水线   | `workflow_runs`            | 一次运行 (requirementId/requirementVersion/requirementName/status 默认 pending/currentStage/mode 默认 auto/config jsonb/summary jsonb/startedAt/finishedAt)                                                |
| 流水线   | `workflow_stages`          | 阶段记录 (stage/status/attempt 默认 1/inputSummary/outputSummary/payload jsonb/model/durationMs)                                                                                                           |
| 流水线   | `workflow_cases`           | 运行内逐用例状态 (position/automationStatus 默认 manual/reviewStatus 默认 pending/revisionCount/qualityScore/firstReviewId/finalReviewId/executionId/analysisId)                                           |
| 流水线   | `workflow_case_reviews`    | 逐轮评审 (round/reviewStatus/qualityScore/issues jsonb/missingCoverage/suggestions/deterministicIssues/source 默认 deterministic/model)                                                                    |
| 流水线   | `workflow_result_analyses` | 结果分析 (executionStatus 客观快照/failureCategory 默认 unknown/failureReason/evidence jsonb/confidence/recommendedAction/needsHumanReview 默认 true/source/model/rawResponse), 只记录不改写执行状态       |

## 关系图

```text
projects 1─N code_analyses / state_machines
projects 1─N requirements 1─N test_points
requirements 1─N requirement_snapshots                  (每版本冻结代码事实)
requirements 1─N requirement_change_runs 1─N requirement_changes
requirement_change_runs 1─N requirement_case_changes
projects 1─N test_cases 1─N test_case_versions
requirements N─M test_cases                             (requirement_cases 桥表)
projects 1─N case_generations                           (生成历史归档)
test_cases 1─N execution_records 1─N execution_steps
execution_records 1─1 execution_requirements / execution_reviews
execution_reviews 1─N execution_review_images / execution_review_issues
projects 1─N workflow_runs 1─N workflow_stages
workflow_runs 1─N workflow_cases 1─N workflow_case_reviews
workflow_runs 1─N workflow_result_analyses
id_sequences / llm_profiles                             (全局计数与配置, 无业务外键)
```

表间只有索引没有数据库级外键, 引用完整性由服务层事务维护。

## 重点表: test_cases

```ts
{
  id: varchar(20); // TC-{6 位序列}, 服务层在事务内分配
  projectSeq: integer; // 项目内序号, 必填
  projectId: varchar(36); // 索引 ix_test_cases_project / ix_test_cases_project_seq
  title: varchar(255);
  module: varchar(120); // 默认 ""
  type: varchar(20); // positive | negative | boundary | state, 默认 positive
  priority: varchar(10); // P0 | P1 | P2, 默认 P1
  preconditions: jsonb; // string[]
  steps: jsonb; // string[] 人类可读步骤
  expectedResults: jsonb; // string[] 预期结果 (含引号锚点)
  structuredSteps: jsonb; // StructuredStep[] 可执行契约
  testData: jsonb; // Record<string, string>
  coverageRefs: jsonb; // CoverageRefs 覆盖引用
  source: varchar(20); // rule | ai | manual | import, 默认 rule
  confidence: real; // 默认 1
  qualityScore: integer; // 默认 100, 质量门打分
  lintIssues: jsonb; // string[] 质量门问题清单
  executionStatus: varchar(20); // 默认 not_run
}
```

## 增量需求域 (requirement_snapshots 家族)

代码分析是项目级「最新事实」, 增量比较必须读取当时冻结的快照, 否则后续重新分析会悄悄改写基线。四张表由 `server/services/incremental.ts` 驱动, 与在用 `test_cases`/`requirement_cases` 完全隔离:

- **`requirement_snapshots`**: 每个需求版本一条不可变快照——`endpoints` (参数展开、鉴权与关联规则归一化后的接口)、`rules`、`stateTransitions`、`security` (安全配置摘要: hash + signals)、`warnings`, 外加 `fingerprint` (varchar(64)) 用于快速判等; `source` 取 `code_analysis | manual`, 可回指 `analysisId` 与 `baselineRequirementId`。
- **`requirement_change_runs`**: 一次增量运行, `status` 走 `analyzing → review → generating → completed` (或 `failed`); 同时持有 `baselineSnapshotId` 与 `currentSnapshotId`, `summary` jsonb 存接口/规则/用例变更与回归统计。
- **`requirement_changes`**: 两个快照间的一条结构化差异。`entityType`: `endpoint | business_rule | state_transition | permission | conflict`; `changeType`: `added | modified | deleted | unchanged | uncertain`; 用 `matchKey` + `oldRef/newRef` + `oldData/newData` 描述前后态; `requiresConfirmation` 标记需人工确认的项, `reviewStatus`: `auto | pending | confirmed | rejected`。
- **`requirement_case_changes`**: 每条基线用例在增量运行中的去向。`action`: `created | updated | reused | pending_delete | missing` (`missing` 时 `testCaseId` 为 null); `baselineCaseId` 指向一期历史用例; 回归建议用 `regressionImpact` (`direct | indirect | none`) + `regressionReason` + `regressionStatus` (`suggested | accepted | rejected`) 表达; `dedupeKey` (形如 `reuse:{caseId}` / `update:{caseId}:{sig}` / `gen:{endpoint}:{sig}`) 配唯一索引 `uq_requirement_case_changes_dedupe`, 使重复生成幂等。

**`case_generations`** 则是全量生成的归档: 每次运行一行, `mode` 取 `auto | rule | llm | legacy` (legacy 为回填的历史档案), `summary` jsonb 记录 mode/requestedMode/fallback/fallbackReason/counts/byType, `snapshot` jsonb 保存逐用例轻量快照 (id/title/module/type/priority/source/score/expected)。UI 据此提供版本下拉与只读检视; 在用用例仍遵循原有替换语义, 该表从不改写它们。

## 领域类型 (src/lib/types.ts)

### 代码事实 (Code Facts)

静态分析抽取的「客观事实」, 用于给生成的用例**接地** (grounding), 确保选择器与断言引用真实存在的页面文案与接口:

- **后端事实 `BackendResult`**: `language`、`endpoints: Endpoint[]` (id/method/path/controller/methodName/file/line, 可选 `params: EndpointParam[]`——name/type/source (`request_body | path_variable | request_param | unknown`)/required/constraints/dtoType, 以及 `auth: string[]` 安全注解如 `@PreAuthorize`)、`entities: Entity[]` (name/file/`EntityField[]`/`FieldConstraint[]` 字段约束)、`enums: EnumDef[]`、`businessRules: BusinessRule[]` (id/description/guard 守卫表达式/file/line)、`uiTexts: string[]`;
- **前端事实 `FrontendResult`**: `language`、`pages: Page[]` (name/route/file/forms), 每个 `Form` 含 `FormField[]` (label/prop/type/required/placeholder/rules), 另有 `selectors: PageSelector[]` (type/value/page)、`uiTexts` 与 `components`;
- **状态机 `StateMachineSpec`**: `states` (name/label)、`transitions: StateMachineTransition[]` (id/from/to/trigger/verified/evidence/guard), `confidence` 置信度。覆盖率矩阵会向 transition 回填 `planned/plannedCaseIds/executed` 三个可选字段。

### 测试点 (Test Point)

从 PRD 抽取的「应被覆盖的场景」, 是需求与用例之间的桥梁。`TestPointDraft` 含 title/category/priority/description/pageRoute/endpoint/fields/expected/source/confidence, 落库后成为 `TestPoint` (追加 id/requirementId/seq)。类别 `TestPointCategory`: `functional | negative | boundary | state | api | permission`; 优先级 `CasePriority`: P0/P1/P2; 来源 `rule | llm`。

### 结构化步骤 (StructuredStep) —— 可执行契约

连接「生成」与「执行」的核心契约:

```ts
interface StructuredStep {
  order: number;
  type: StepType | string; // "ui_action" | "input" | "state_assert" | "capture"
  action: string; // 人类可读动作描述
  target: string; // 目标元素文案/描述
  uiSelector?: UiSelector; // { type: UiSelectorType; value: string }
  expected?: string; // 断言期望 (含引号锚点)
  inputValue?: string; // input 步骤的输入值, 支持 ${var} 引用
  variable?: string; // capture 步骤: 运行时变量名, 如 base_count
  pattern?: string; // capture 步骤: 含一个捕获组的正则, 作用于页面 body 文本
}
```

- `UiSelectorType` 取值: `route | placeholder | text | label | role | testid | css | xpath`;
- **capture 步骤**: 从页面抓取运行时变量 (如列表当前总数 `base_count`), 供后续步骤以 `${name}`、`${name+1}`、`${name-1}` 引用 (`runner.ts` 的 `VARIABLE_RE`)——这是「计数断言」的基础。引用未捕获的变量、或对非整数做加减, 都以 `CASE_INVALID` 失败, 绝不静默替换。

### 锚点 (Anchors) —— 预期结果的写法约定

预期结果通过**双引号**引用页面上可见的真实文案, 例如:

```text
After submitting, the page shows "Order created successfully".
```

执行时 `runner.ts` 的三层断言按「URL 路径 → 引号锚点在 body 文本中精确查找 → 诚实 skipped」的顺序判定; 锚点由 `QUOTE_ANCHOR_RE` (`/["“]([^"”]+)["”]/g`) 提取, 直引号与弯引号均被识别 (同一正则也出现在 `quality-gate.ts` 与 `evaluation/metrics.ts`)。锚点必须来自代码事实里的真实文案; 标题、描述等散文保持英文。详见 [浏览器执行](./execution)。

### 覆盖引用 (CoverageRefs)

```ts
interface CoverageRefs {
  endpointIds: string[];
  transitionIds: string[];
  ruleIds: string[];
  testPointIds?: string[];
}
```

覆盖率矩阵 (`server/services/coverage.ts` 组装 + `server/lib/coverage.ts` 的 `buildCoverageMatrix` 计算) 据此产出 `CoverageMatrix`: `apiEndpoint`/`stateTransition`/`businessRule` 三个覆盖块加 `caseExecution` 状态统计。语义固定: **计划覆盖** = coverageRefs 引用了真实存在的接口、已验证的状态迁移或业务规则; **执行覆盖** = 只有 `passed` 的执行记录计入, 且优先读取执行时刻的用例快照; 不在最新代码事实中的过期 id 一律不计, 比率钳制在 0~1。

### 执行证据与运行态类型

- `ExecutionStepRecord` / `RunnerResult`: 执行器产出的逐步记录与整案结果 (status/errorCategory/errorMessage/videoPath/passedSteps/totalSteps/steps), 与 `execution_steps`、`execution_records` 列一一对应;
- `ImageReview` / `ReviewIssue`: 视觉复核的逐图判定与问题清单, 对应 `execution_review_images` / `execution_review_issues`;
- `LlmKind` (`text | vision`) 与 `LlmProfileDict` (含 `apiKeyConfigured` 布尔, 前端不回传明文 key);
- `JobState` / `JobStatus`: 内存态后台任务进度 (id/kind/status/message/current/total), 不落库, 由 `server/lib/jobs.ts` 管理。

## 状态码与展示元数据 (enums.ts)

数据库存英文码, UI/报告通过 `meta(MAPPING, code)` 取得 `label/tone/description`; 未收录的码回退为 `Uncategorized` + tone `info`。`tone` 取值 `info | primary | success | danger | warning`, 由 `StatusBadge` 组件映射为语义色边框/背景/圆点。

| 映射表                         | 取值                                                                                                          |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `CASE_EXECUTION_STATUS_META`   | not_run / running / passed / failed / skipped / needs_review / cancelled                                      |
| `EXECUTION_RECORD_STATUS_META` | 同上但去掉 not_run (由前者过滤派生)                                                                           |
| `AI_REVIEW_VERDICT_META`       | ok / suspect / unavailable                                                                                    |
| `ERROR_CATEGORY_META`          | SELECTOR_NOT_FOUND / ASSERT_FAILED / NAVIGATION_FAILED / TIMEOUT / CASE_INVALID / ENV_ERROR                   |
| `FAILURE_CATEGORY_META`        | product_defect / test_script_issue / test_data_issue / environment_issue / unknown / none                     |
| `CASE_TYPE_META`               | positive / negative / boundary / state                                                                        |
| `CASE_SOURCE_META`             | rule / ai / manual / import                                                                                   |
| `REQUIREMENT_STATUS_META`      | draft / analyzing / ready / failed                                                                            |
| `ANALYSIS_STATUS_META`         | pending / running / success / failed                                                                          |
| `WORKFLOW_STATUS_META`         | pending / running / completed / partial / failed / cancelled                                                  |
| `STAGE_STATUS_META`            | pending / running / completed / failed / skipped                                                              |
| `REVIEW_STATUS_META`           | pending / pass / revise / reject                                                                              |
| `PRIORITY_META`                | P0 / P1 / P2                                                                                                  |
| `STAGE_LABELS`                 | code_analysis / test_points / case_generation / case_review / execution / result_analysis / report 的英文标签 |

对应的联合类型 (`ExecutionStatusCode`、`ReviewVerdict`、`ErrorCategory`、`FailureCategory`、`WorkflowStatus`、`WorkflowStageName`、`StageStatus`、`ReviewStatus`、`AutomationStatus`) 都定义在 `src/lib/types.ts`, schema 通过 `$type`/导出别名 (`ExecutionStatusColumn`、`LlmKindColumn`) 与之对齐。

几个关键语义 (来自 enums.ts 的 description):

- `skipped`: 有步骤无法验证, 证据不足以判 passed 或 failed——诚实跳过;
- `needs_review`: 证据不足、AI 判定可疑或复核不可用, 需要人工确认;
- `cancelled`: 用户中止, **不得视为通过**;
- `ok` (AI 复核): 证据支持预期, 但**绝不覆盖确定性执行失败**;
- `partial` (流水线): 部分阶段失败但产出了可用结果; `unknown` (失败分类): 证据不足或多因难辨, 需人工复核。
