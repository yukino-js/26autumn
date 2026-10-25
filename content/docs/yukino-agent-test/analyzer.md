---
title: "静态代码分析"
---

# 静态代码分析 (analyzer)

静态分析是整个平台「代码事实接地」的源头: 纯规则、零 LLM, 从源码树中抽取 endpoints、entities、业务规则、UI 表单与状态机。这些事实给后续生成的用例**接地** (grounding)——选择器与断言引用的都是真实存在的页面文案与接口, 而非凭空捏造。

入口: `server/services/analysis.ts` 的 `triggerAnalysis(pid)` (tRPC `analysis.trigger`, 返回 jobId), 产物写入 `code_analyses` (backendResult/frontendResult/warnings) 与 `state_machines` 表。

代码位于 `src/server/lib/analyzer/`, 四个模块:

## scanner.ts — 文件收集与技术栈探测

- `scan(root)` 递归收集源码文件, 排除构建/依赖目录: `.git`、`node_modules`、`target`、`build`、`dist`、`.venv`、`__pycache__`、`.idea`、`outputs`、`.next`、`.output`、`coverage`;
- `techStackOf` 推断技术栈: 有 `pom.xml`/`build.gradle` → 后端 `java-spring`; 有 `package.json` 且含 `.vue` 文件 → 前端 `vue`;
- 返回 `ScanResult` (files、backend、frontend、hasPom/hasGradle/hasPackageJson/hasVue);
- 提供 `readFileSafe` 供其他解析器复用。

## spring.ts — Spring Boot 后端分析

纯正则解析 (零 LLM), 抽取 `BackendResult`:

- **endpoints**: 解析 `@GetMapping`/`@PostMapping`/`@PutMapping`/`@DeleteMapping`/`@PatchMapping`; 类级 `@RequestMapping` **只作为路径前缀, 绝不单独算作 endpoint** (源码注释强调的关键陷阱); 每个 endpoint 携带 file + line 证据;
- **entities**: 从字段声明 (`private Type name;`) 抽取实体与字段, 并解析 Bean Validation 约束注解 (`@NotBlank`、`@NotNull`、`@Size`、`@Max`、`@Min`、`@Pattern`、`@Email`、`@DecimalMin/Max`、`@Digits`、`@Positive`、`@Length` 等) 得到 `FieldConstraint`;
- **enums**: 枚举定义与取值, 从构造参数/消息中用 CJK 正则提取人类可读标签;
- **businessRules**: 从 `if (...) throw new Xxx("...")` 模式抽取守卫 (guard) 与错误文案——这些文案正是负向用例断言的锚点来源;
- **uiTexts**: 后端可见文案 (如 `message = "..."`)。

## vue.ts — Vue 前端分析

纯正则解析, 抽取 `FrontendResult`:

- **pages**: 解析路由文件, 先定位 `path:`, 再向左走到开括号做**平衡括号提取** (源码注释: 绝不用 `[^{}]*` 这种懒惰正则, 避免嵌套对象截断);
- **forms**: 解析 `<el-form>` 与 `<el-form-item>`——正则带 `(?![-\w])` 守卫, 防止把 `<el-form-item>` 误判为表单; 每个表单字段抽取 label、prop、placeholder、required、`:rules`;
- **selectors**: 页面元素定位线索 (`PageSelector[]`);
- **uiTexts**: `ElMessage.success/error/warning/info("...")` 等可见文案——正向用例的成功断言与负向用例的校验断言都引用这些真实文案。

## state-machine.ts — 状态机推断

从代码推断状态机 (纯规则 + 源码证据), 流程 (源码注释):

1. 找到状态枚举 → states;
2. 找到 `setStatus(X)` / `setXxxStatus(X)` 写点;
3. 向上走到方法边界, 从方法名推断触发器 (trigger);
4. 在方法内向上找状态守卫 (含状态字面量的 `if`), 推导 `from`:
   - 否定守卫 `if(!X) throw` → from 包含 X;
   - 肯定守卫 `if(X) throw` → from = 所有状态 - X;
   - 无守卫 → from = 所有状态 - 目标状态;
5. 只有真正找到状态写行时 `verified=true`;
6. BFS 最短推进路径, 供状态用例生成前置步骤使用。

产物为 `StateMachineSpec`: states (name/label)、transitions (id/from/to/trigger/verified/evidence/guard)、confidence 置信度。每条迁移带 evidence (文件/行号), 写入 `state_machines` 表。

## 分析状态与使用

- `code_analyses.status`: `pending` → `analyzing` → `ready` / `failed` (`ANALYSIS_STATUS_META`);
- 项目详情的 **Analysis** Tab 可触发分析、查看后端/前端事实与状态机;
- 流水线阶段①可选地刷新代码事实; 生成与评审阶段都从最近一次 `ready` 的分析读取事实 (`sourceFacts`);
- 分析失败时 `warnings` 与 `errorMessage` 一并持久化, 便于排查。

> 提示: 分析器面向 Spring/Vue (Element Plus) 技术栈做了专门解析; 其他技术栈走通用路径 (文件收集 + 有限推断), 事实会偏少, 生成质量相应下降。
