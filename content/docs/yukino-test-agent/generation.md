---
title: "用例生成"
---

# 用例生成

用例生成覆盖流水线阶段②③④: 测试点抽取 → 用例生成 → 用例评审。核心引擎在 `src/server/lib/generation/`:

| 模块                 | 职责                                           |
| -------------------- | ---------------------------------------------- |
| `test-points.ts`     | Agent 1: 从 PRD 抽取测试点                     |
| `rule-cases.ts`      | 规则用例生成 (约 1100 行, 正向/负向/边界/状态) |
| `llm-cases.ts`       | Agent 2: LLM 用例生成 (按测试点分批)           |
| `count-assertion.ts` | 计数断言归一化 (运行时基线)                    |
| `quality-gate.ts`    | 质量门 (lint/打分/去重)                        |
| `prompts.ts`         | 各阶段提示词模板                               |

## 测试点抽取 (test-points.ts)

- **输入**: 需求文本 + 代码事实; **输出**: 结构化校验过的测试点;
- **LLM 优先, 规则兜底**: LLM 不可用或无产出时, 确定性规则抽取接管;
- 类别白名单: `functional` / `negative` / `boundary` / `state` / `api` / `permission`;
- 持久化、线程与降级决策留在 `requirements` 服务层, 保持既有「解析需求版本」行为不变;
- 产物落 `test_points` 表, `source` 标记 `rule` 或 `llm`, 并带 confidence。

## 三种生成模式 (generateCases)

入口 `server/services/generation.ts` 的 `generateCases` (tRPC `generation.start` 返回 jobId):

- **`rule`**: 完全确定性, 只用 `rule-cases.ts`;
- **`llm`**: 用 `llm-cases.ts` 调文本模型, 产物同样要过质量门;
- **`auto`** (默认): 先尝试 LLM; 对 LLM 未覆盖的测试点, 用规则**兜底** (`generateRuleCasesForPoints(missing, ...)`); LLM 不可用或抛错时整体降级为规则模式。

### 规则用例 (rule-cases.ts)

依据代码事实生成四类用例:

- `genPositive`: 填齐必填字段 → 提交 → 断言成功文案 (如 `"Order created successfully"`, 来自前端 `ElMessage` 文案事实);
- `genNegative`: 留空/非法输入 → 断言校验文案 (如 `"{Label} cannot be empty"`, 来自后端守卫/前端 rules 事实);
- `genBoundaryWithConstraints`: 依据 `FieldConstraint` (Size/Max/Min/Pattern 等) 生成边界值用例;
- `genState`: 驱动状态机迁移 (利用 BFS 最短推进路径构造前置步骤), 断言迁移后的状态。

`genericPointCase` 为没有专门规则路径的测试点生成通用用例。

### LLM 用例 (llm-cases.ts)

- 按测试点**分批**调用 LLM (`testCasesByPointPrompt`), 收敛响应为用例字典;
- 语义校验 (测试点 id 必须匹配、单输入 + 单断言、必填字段、选择器必须来自事实) 在此与质量门共用**同一套标准** ("one standard, not two");
- **某一批失败只让该批降级为规则生成**, 不影响其他批次。

## 计数断言归一化 (count-assertion.ts)

问题: 持久化测试数据下列表总数不是固定的 4/5, 断言 "total of 5 items" 在脏环境必然失败。正确做法是**操作前先读基线, 然后断言「基线 + 1」**。

该模块只处理结构清晰、可安全推导的场景 (源码注释):

- 用例包含 create/add 动作 (submit/create/add/save/new);
- 能在预期或页面事实中找到列表路由;
- 恰好有一个 "total/count N items" 式断言 (三组正则匹配)。

满足条件时: 插入 `capture` 步骤抓取运行时基线变量 (如 `base_count`), 把固定数字断言改写为 `${base_count+1}`。不满足的「固定总数」用例被丢弃 (`drop`), 避免生成看似动态实则无法执行的步骤。

## 质量门 (quality-gate.ts)

`runQualityGate(cases)` 对生成结果做确定性体检, 输出 `{ generated, kept[], dropped, dropReasons }`——**只有 kept 会被持久化**:

- `lintCase`: 检查复合预期 (一句话塞多个断言 `isCompoundExpected`)、单步多输入 (`stepsHaveMultipleInputs`)、缺失引号锚点 (`quotedAnchors` 为空) 等;
- `scoreCase`: 质量打分 (写入 `test_cases.qualityScore`, 默认 100 起扣);
- `similarity` / 去重: 基于场景文本相似度去重;
- 问题清单写入 `test_cases.lintIssues`。

## 覆盖引用富化 (enrichCoverageRefs)

`generateCases` 持久化前, `enrichCoverageRefs` 把用例关联到它覆盖的 endpoint/transition/rule/testPoint, 写入 `coverageRefs`, 供覆盖率矩阵使用。`generation.coverageGaps` 查询则反向计算缺口 (transitionGaps/endpointGaps), 前端 Generation Tab 展示并可针对性补生成。

## 持久化流程

1. `clearGeneratedForRequirement` / `clearGeneratedForProject`: 先清掉旧的生成用例 (rule/ai 来源), 保留 manual/import;
2. 逐条 `saveGeneratedCase`: 分配 `TC-000001` 式序列 ID (`projectSeq` 递增), 写 steps/expectedResults/structuredSteps/testData/coverageRefs;
3. 通过 `requirement_cases` 桥表关联到需求与测试点。

## 用例评审 (阶段④, 由流水线驱动)

评审逻辑在 `workflows.ts` (见[流水线](pipeline) ④): 确定性评审 → LLM 评审 → 合成 pass/revise/reject → 最多 `maxRevisions` 轮修复。质量门的函数 (`caseHasCompoundExpected`、`caseHasMultipleInputs`、`quotedAnchors`、`scoreCase`) 也被评审阶段复用, 保证生成与评审标准一致。
