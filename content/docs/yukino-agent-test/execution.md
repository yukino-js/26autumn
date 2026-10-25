---
title: "浏览器执行"
---

# 浏览器执行与复核

执行域是「绝不伪造绿色」原则的物理落点: Playwright 真实浏览器执行 + 三层断言 + 视觉复核 + 证据驱动的失败分类。

## Playwright 运行器 (runner.ts)

`src/server/lib/execution/runner.ts` (约 500 行) 的自述: **uiSelector 映射 + 五级回退 + 三层断言 + 截图与录像**。铁律: 没有假绿——无法验证的标记 skipped, 绝不因「没报错」而 passed; 失败分类使用六个 `ERROR_CATEGORY` 枚举值。

### 步骤执行

- 步骤超时 `STEP_TIMEOUT_MS = 10_000` (10 秒);
- `ui_action`: 定位元素并点击/操作; `input`: 定位表单控件并填充 `inputValue`;
- `state_assert`: 执行三层断言 (见下);
- `capture`: 用 `pattern` (含一个捕获组的正则) 在页面文本中抓取运行时变量 `variable`, 供后续步骤引用;
- **运行时变量**: `${name}`、`${name+1}`、`${name-1}` 在输入值与预期中展开 (`VARIABLE_RE`), 是计数断言的执行侧支撑;
- 刷新类步骤 (`refresh the page` 等, `REFRESH_RE`) 有专门处理;
- 每步记录 before/after 截图、实际使用的选择器、耗时与结果; 整场执行录制视频。

### 五级选择器回退链 (fallbackChain)

定位失败是脚本脆弱性的主因。运行器按「由精确到宽泛」的顺序尝试 (源码 `fallbackChain`):

1. **精确 uiSelector 匹配**: 按 `uiSelector.type` 映射 (placeholder/label/role/testid/css/xpath); `text` 类型映射为 `button/a/[role=button]/input[value]/summary` 的 `:has-text` 组合;
2. **target 文案在按钮类元素上**: `button/a/[role=button]` 的 `:has-text(target)`;
3. **target 文案在全页任意位置**: `body :not(option):not(script):not(style):has-text(target)`;
4. **normalize-space XPath**: `//button[normalize-space(.)=target]` (两个词的按钮渲染可能带间隙);
5. 全部失败 → `SELECTOR_NOT_FOUND` (诚实失败, 归入失败分类)。

所有尝试过的选择器都记录在步骤的 `attempted` 中, 便于排查。

### 三层断言 (state_assert)

源码注释: "Three-layer assertion: URL -> quoted text anchors -> honest skipped":

1. **URL 断言**: 预期含可验证 URL/路由时, 精确匹配页面 URL;
2. **引号文本锚点断言**: 用 `QUOTE_ANCHOR_RE` 提取预期中双引号 (直引号与弯引号均可) 内的锚点, 在页面 body 文本中精确查找;
3. **诚实 skipped**: 既无可验证 URL 也无引号锚点时, 该步标记 skipped——证据不足, 不判通过也不判失败。

断言命中时会把证据写进步骤记录 (如 "assertion evidence: Text anchors hit" / "URL hit"), 供视觉复核与结果分析引用。

### 错误分类 (ERROR_CATEGORY)

| 码                   | 含义                                     |
| -------------------- | ---------------------------------------- |
| `SELECTOR_NOT_FOUND` | 回退链全部失败, 找不到可操作元素         |
| `ASSERT_FAILED`      | URL 或引号锚点断言未满足                 |
| `NAVIGATION_FAILED`  | 页面打不开或目标返回 4xx/5xx             |
| `TIMEOUT`            | 步骤超时                                 |
| `CASE_INVALID`       | 用例缺少结构化步骤/输入/选择器等必要字段 |
| `ENV_ERROR`          | 浏览器启动失败等非业务环境问题           |

## 执行服务 (executions.ts)

`src/server/services/executions.ts` (约 800 行):

- `runCaseExecution`: 执行单个用例, 写 `execution_records` (EX-xxxxxxxx ID) 与 `execution_steps`, 更新 `test_cases.executionStatus`; `decideStatus` 由步骤结果汇总最终状态;
- `startSingleExecution` / `startBatchExecution`: 后台任务方式启动 (返回 jobId); 批量执行共享 `batchId`, 可用 `cancelBatch` 中止 (cancelled 不算通过);
- `manualReview(eid, verdict, note)`: 人工裁定, 写 `execution_reviews` (reviewer 标记);
- `llmReview(eid)` / `startBatchLlmReview`: 触发视觉复核;
- `listExecutions` / `getExecution` / `getExecutionSteps`: 读取时在边界上把磁盘绝对路径转成 `/api/files/...` URL (`toFileUrl`)。

执行记录状态: `running` / `passed` / `failed` / `skipped` / `needs_review` / `cancelled`。

## 视觉复核 (vision-review.ts)

规则 (源码文件头注释):

- **未配置视觉模型** → 不复核 (返回 null), 执行保持原状态;
- **配置了但调用失败/无截图** → verdict = `unavailable`, 交人工复核;
- 判断只依据截图与步骤记录; **证据不足一律 suspect, 绝不假通过**。

实现要点:

- 最多取 `MAX_IMAGES = 6` 张截图, 单张上限 8MB;
- 提示词要求逐图输出 `ok` / `suspect`: 截图显示错误 toast、空白页、登录页、与预期矛盾的页面/文案/数据 → suspect; 截图不足以证明关键结果 (未捕获、模糊) → suspect, 不放过;
- **尊重确定性结论**: 步骤记录含 "assertion evidence: Text anchors hit" 或 "URL hit" 时, Playwright 已做过精确校验, 除非截图明确矛盾 (报错/空白/错页/相反状态), 不因分辨率或文案不显眼而判 suspect;
- **刷新类步骤**: 页面刷新通常无法从截图看出; 若步骤记录含 "browser reloaded" 或 Navigation Timing 显示 reload, 视为客观刷新证据, 只用截图验证刷新后的页面状态;
- 逐图判定写 `execution_review_images`, 发现的问题写 `execution_review_issues` (含 bbox 定位), 汇总结论写 `execution_reviews`;
- **视觉复核永远不能把确定性失败改成通过**; 可疑结论会把执行推向 `needs_review` (人工确认)。

## 结果分析 (阶段⑥)

证据驱动的失败分类 (只针对失败执行, 详见[流水线](/base/yukino-agent-test/pipeline) ⑥):

- 汇总客观证据 (`buildEvidence`): 步骤记录、错误类别、断言明细、截图清单;
- LLM 分类优先 (`resultAnalysisPrompt`), 不可用时规则分类 (`ruleAnalysis` + `buildRuleEvidence`);
- `guardAnalysis` / `hasGroundedEvidence` 守卫: 分类必须有接地证据, 不臆断;
- 分类: `product_defect` / `test_script_issue` / `test_data_issue` / `environment_issue` / `unknown` / `none`;
- 只写 `workflow_result_analyses`, **绝不覆盖** `execution_records.status`。

## 证据与展示

- 证据 (截图/录像/报告) 存于 `OUTPUT_DIR` (默认 `./outputs`), 数据库存绝对路径, 读取边界转 `/api/files/...`;
- 前端 `/executions/$executionId` 展示步骤时间线、前后截图对比 (`ScreenshotViewer`)、视频、AI 复核逐图判定与问题标注、人工裁定入口。
