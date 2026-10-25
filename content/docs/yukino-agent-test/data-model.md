---
title: "数据模型"
---

# 数据模型 (20 张表)

数据库结构定义在 `src/db/schema.ts` (Drizzle + PostgreSQL, 共 505 行)。设计约定:

- **主键**: 多为服务层生成的 32 位 uuid hex 字符串 (无连字符, varchar(36)); 两类例外使用人类可读 ID——`test_cases` 用 `TC-000001` 式序列 (varchar(20) + `projectSeq` 整数), `execution_records` 用 `EX-xxxxxxxx`。
- **结构化载荷**: 用 jsonb 列, 并以 `src/lib/types.ts` 中的共享领域类型约束 (Drizzle 的 `$type<T>()`)。
- **状态码**: 数据库只存稳定的英文码 (如 `passed`/`failed`/`needs_review`), 展示元数据 (label/tone/description) 统一放在 `src/lib/enums.ts`。
- **时间**: 统一 `timestamp with timezone` + `defaultNow()`。

## 表清单 (按域分组)

| 域       | 表                         | 说明                                                                                                                                                     |
| -------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 项目     | `projects`                 | 项目 (name/description/sourceType/sourcePath/gitUrl/gitBranch/techStack jsonb/prdContent/targetUrl)                                                      |
| 代码分析 | `code_analyses`            | 每次静态分析一条 (status/backendResult/frontendResult/warnings jsonb/errorMessage)                                                                       |
| 代码分析 | `state_machines`           | 推断出的状态机 (name/states/transitions jsonb/confidence real)                                                                                           |
| 需求     | `requirements`             | 需求版本 (name/version 默认 V1.0/content/sourceFile/status/errorMessage)                                                                                 |
| 需求     | `test_points`              | 测试点 (seq/title/category/priority/pageRoute/endpoint/fields jsonb/expected/source/confidence)                                                          |
| 用例     | `test_cases`               | 测试用例 (详见下节)                                                                                                                                      |
| 用例     | `test_case_versions`       | 用例版本快照 (version 整数/snapshot jsonb/changeNote), 支持回滚                                                                                          |
| 用例     | `requirement_cases`        | 需求 ↔ 用例 关联 (可带 testPointId), 多对多桥表                                                                                                          |
| 执行     | `execution_records`        | 执行记录 (testCaseSnapshot jsonb/batchId/status/mode 默认 programmatic/targetUrl/durationMs/errorCategory/errorMessage/videoPath/passedSteps/totalSteps) |
| 执行     | `execution_requirements`   | 执行 ↔ 需求版本 快照关联                                                                                                                                 |
| 执行     | `execution_steps`          | 逐步记录 (stepIndex/action/target/stepType/selectorUsed/result/screenshotBefore/screenshotAfter/error/durationMs)                                        |
| 复核     | `execution_reviews`        | 复核结论 (verdict/reason/model/imageCount/reviewer/reviewerNote/reviewedAt), AI 与人工共用                                                               |
| 复核     | `execution_review_images`  | 逐图判定 (imageIndex/stepIndex/label/screenshot/verdict/analysis/bbox jsonb)                                                                             |
| 复核     | `execution_review_issues`  | 复核发现的问题 (imageIndex/label/screenshot/bbox/problem)                                                                                                |
| 配置     | `llm_profiles`             | LLM 档案 (name/kind text 或 vision/apiKey/baseUrl/model/enabled/isDefault)                                                                               |
| 流水线   | `workflow_runs`            | 一次运行 (requirementId/status/currentStage/mode/config jsonb/summary jsonb/startedAt/finishedAt)                                                        |
| 流水线   | `workflow_stages`          | 阶段记录 (stage/status/attempt/inputSummary/outputSummary/payload jsonb/model/durationMs)                                                                |
| 流水线   | `workflow_cases`           | 运行内逐用例状态 (position/automationStatus/reviewStatus/revisionCount/qualityScore/firstReviewId/finalReviewId/executionId/analysisId)                  |
| 流水线   | `workflow_case_reviews`    | 逐轮评审 (round/reviewStatus/qualityScore/issues jsonb/missingCoverage/suggestions/deterministicIssues/source/model)                                     |
| 流水线   | `workflow_result_analyses` | 结果分析 (executionStatus 快照/failureCategory/failureReason), 只记录不改写执行状态                                                                      |

## 关系图

```
projects 1─N code_analyses / state_machines
projects 1─N requirements 1─N test_points
projects 1─N test_cases 1─N test_case_versions
requirements N─M test_cases   (requirement_cases 桥表)
test_cases 1─N execution_records 1─N execution_steps
execution_records 1─1 execution_reviews 1─N execution_review_images / issues
projects 1─N workflow_runs 1─N workflow_stages
workflow_runs 1─N workflow_cases 1─N workflow_case_reviews
workflow_runs 1─N workflow_result_analyses
```

## 重点表: test_cases

```ts
{
  id: varchar(20); // TC-{6 位序列}, 服务层分配
  projectSeq: integer; // 项目内序号
  projectId: varchar(36); // 索引 ix_test_cases_project
  title: varchar(255);
  module: varchar(120);
  type: varchar(20); // positive | negative | boundary | state
  priority: varchar(10); // P0 | P1 | P2, 默认 P1
  preconditions: jsonb; // string[]
  steps: jsonb; // string[] 人类可读步骤
  expectedResults: jsonb; // string[] 预期结果 (含引号锚点)
  structuredSteps: jsonb; // StructuredStep[] 可执行契约
  testData: jsonb; // Record<string, string>
  coverageRefs: jsonb; // CoverageRefs 覆盖引用
  source: varchar(20); // rule | ai | manual | import
  confidence: real; // 默认 1
  qualityScore: integer; // 默认 100, 质量门打分
  lintIssues: jsonb; // string[] 质量门问题清单
  executionStatus: varchar(20); // 默认 not_run
}
```

## 领域类型 (src/lib/types.ts)

### 代码事实 (Code Facts)

静态分析抽取的「客观事实」, 用于给生成的用例**接地** (grounding), 确保选择器与断言引用真实存在的页面文案与接口:

- **后端事实 `BackendResult`**: `endpoints: Endpoint[]` (method/path/controller/file/line)、`entities: Entity[]` (字段与 `FieldConstraint` 约束)、`enums: EnumDef[]`、`businessRules: BusinessRule[]` (含 guard 守卫表达式)、`uiTexts: string[]`;
- **前端事实 `FrontendResult`**: `pages: Page[]` (route/file/forms), 每个 `Form` 含 `FormField[]` (label/prop/type/required/placeholder/rules), 另有 `selectors: PageSelector[]` 与 `uiTexts`;
- **状态机 `StateMachineSpec`**: `states` (name/label)、`transitions` (id/from/to/trigger/verified/evidence/guard)、`confidence` 置信度。

### 测试点 (Test Point)

从 PRD 抽取的「应被覆盖的场景」, 是需求与用例之间的桥梁。类别 `TestPointCategory`: `functional | negative | boundary | state | api | permission`; 优先级 P0/P1/P2; 来源 `rule | llm`。

### 结构化步骤 (StructuredStep) —— 可执行契约

连接「生成」与「执行」的核心契约:

```ts
interface StructuredStep {
  order: number;
  type: "ui_action" | "input" | "state_assert" | "capture" | string;
  action: string; // 人类可读动作描述
  target: string; // 目标元素文案/描述
  uiSelector?: { type: UiSelectorType; value: string };
  expected?: string; // 断言期望 (含引号锚点)
  inputValue?: string; // input 步骤的输入值
  variable?: string; // capture 步骤: 运行时变量名, 如 base_count
  pattern?: string; // capture 步骤: 含一个捕获组的正则, 作用于页面文本
}
```

- `UiSelectorType` 取值: `route | placeholder | text | label | role | testid | css | xpath`;
- **capture 步骤**: 从页面抓取运行时变量 (如列表当前总数 `base_count`), 供后续步骤以 `${name}`、`${name+1}`、`${name-1}` 引用——这是「计数断言」的基础。

### 锚点 (Anchors) —— 预期结果的写法约定

预期结果通过**双引号**引用页面上可见的真实文案, 例如:

```
After submitting, the page shows "Order created successfully".
```

执行时三层断言提取引号内锚点并在页面 body 文本中精确查找。锚点必须来自代码事实里的真实文案; 标题、描述等散文保持英文。直引号与弯引号均被识别 (`runner.ts` 的 `QUOTE_ANCHOR_RE`)。

### 覆盖引用 (CoverageRefs)

每个用例携带 `coverageRefs` (覆盖的 endpoint/transition/rule/testPoint ID)。覆盖率矩阵 (`server/services/coverage.ts` + `server/lib/coverage.ts`) 据此计算「计划覆盖 vs 实际执行覆盖」, 维度包括接口、状态迁移、业务规则。

## 状态码与展示元数据 (enums.ts)

数据库存英文码, UI/报告通过 `meta(MAPPING, code)` 取得 `label/tone/description`; `tone` 取值 `info | primary | success | danger | warning`, 由 `StatusBadge` 渲染为语义色。

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
| `WORKFLOW_STATUS_META`         | pending / running / completed / partial / failed / cancelled                                                  |
| `STAGE_STATUS_META`            | pending / running / completed / failed / skipped                                                              |
| `REVIEW_STATUS_META`           | pending / pass / revise / reject                                                                              |
| `PRIORITY_META`                | P0 / P1 / P2                                                                                                  |
| `STAGE_LABELS`                 | code_analysis / test_points / case_generation / case_review / execution / result_analysis / report 的英文标签 |

几个关键语义 (来自 enums.ts 的 description):

- `skipped`: 有步骤无法验证, 证据不足以判 passed 或 failed——诚实跳过;
- `needs_review`: 证据不足、AI 判定可疑或复核不可用, 需要人工确认;
- `cancelled`: 用户中止, **不得视为通过**;
- `ok` (AI 复核): 证据支持预期, 但**绝不覆盖确定性执行失败**。
