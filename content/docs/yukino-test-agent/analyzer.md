---
title: "静态代码分析"
description: "纯规则、零 LLM 的代码事实接地层: scanner 技术栈探测、Spring/Go 后端解析、Vue/Lit 前端解析、Java/Go 状态机推断, 以及 code_analyses 持久化与流水线消费。"
---

# 静态代码分析 (analyzer)

静态分析是整个平台「代码事实接地」的源头: 纯规则、零 LLM, 从被测项目的源码树中抽取 endpoints、entities、enums、业务规则、UI 表单/文案与状态机。这些事实给后续生成的用例**接地** (grounding)——选择器与断言引用的都是真实存在的页面文案与接口, 而非凭空捏造。

分析器代码位于 `src/server/lib/analyzer/`, 共七个模块: `scanner.ts` (文件收集 + 技术栈探测)、`spring.ts` (Java 后端)、`go.ts` (Go 后端)、`vue.ts` (Vue 前端)、`lit.ts` (Lit 前端)、`state-machine.ts` (Java 状态机)、`go-state-machine.ts` (Go 状态机)。编排入口在 `src/server/services/analysis.ts`。

## 入口与编排 (services/analysis.ts)

- tRPC `analysis.trigger` → `triggerAnalysis(pid)`: 只接受 `sourceType === "local_path"` 且配置了 `sourcePath` 的项目 (否则抛 `BizError(40006)`); 先插入一条 `code_analyses` 行 (status `running`), 再 `createJob("analysis")` + `runJob` 后台执行, 立即返回 `{ analysisId, jobId }`, 前端凭 jobId 轮询进度;
- `runAnalysis(pid, analysisId, report)` 按序执行: **scan** 扫描源码树 → 按技术栈分发**后端解析** (`java-spring` → `analyzeBackend`; `go` → `analyzeGoBackend`; 都不匹配则记 warning "No supported backend detected") → 分发**前端解析** (`vue` → `analyzeFrontend`; `lit` → `analyzeLitFrontend`; 否则记 warning) → **状态机推断** (依赖后端结果, Java/Go 各走一条路径) → **持久化**: 把 `backendResult`/`frontendResult`/`warnings` 写回 `code_analyses` (status `success`), 先删后插整体替换该项目的 `state_machines` 行, 最后用 `techStackOf(scanResult)` 回填 `projects.techStack`;
- 扫描结果为空 (目录不存在或无文件) 直接失败; 任何异常都会把 status 置为 `failed`, `errorMessage` 截断到 4000 字符持久化, 便于排查;
- 读取接口: `getLatestAnalysis(pid)` 返回最近一次分析 (backendResult/frontendResult/stateMachines/warnings/errorMessage), `listStateMachines(pid)` 返回全部状态机; 对应 tRPC `analysis.latest` 与 `analysis.stateMachines`;
- `recoverInterruptedAnalyses()` 在服务启动 (bootstrap) 时执行: 分析任务只活在进程内存, 重启后残留的 `running` 行统一标记为 `failed`, 避免 UI 出现幽灵「分析中」状态。

## scanner.ts — 文件收集与技术栈探测

- `scan(root)` 递归收集源码文件 (相对路径), 排除构建/依赖目录: `.git`、`node_modules`、`target`、`build`、`dist`、`.venv`、`__pycache__`、`.idea`、`outputs`、`.next`、`.output`、`coverage`;
- 遍历时顺带记录六个标志位: `hasPom` (pom.xml)、`hasGradle` (build.gradle / build.gradle.kts)、`hasGoMod` (go.mod)、`hasPackageJson`、`hasLitJsx` (package.json 的 dependencies/devDependencies 含 `lit` 或 `@yukino.js/lit-jsx`)、`hasVue` (存在 `.vue` 文件);
- 技术栈判定: 后端 `pom/gradle → java-spring`, 否则 `go.mod → go`; 前端 `package.json + .vue → vue`, 否则 `package.json + lit 依赖 → lit`;
- 返回 `ScanResult` (root、files、backend、frontend 及上述标志位); 辅助函数 `techStackOf` (输出 `{ backend, frontend }` 供回填)、`listByExt` (按小写扩展名过滤出绝对路径)、`readFileSafe` (读文件失败返回空串, 供所有解析器复用)。

## spring.ts — Spring Boot 后端分析

纯正则逐行解析 `.java` 文件 (`parseJavaFile`), 合并入口 `analyzeBackend`, 产出 `BackendResult` (language `java-spring`):

- **endpoints**: 解析方法级 `@GetMapping`/`@PostMapping`/`@PutMapping`/`@DeleteMapping`/`@PatchMapping`; 类级 `@RequestMapping` (类声明上方 20 行内最近的一个) **只作为路径前缀, 绝不单独算作 endpoint** (源码注释强调的关键陷阱); 每个 endpoint 携带 controller 类名、方法名、file + line 证据, id 在合并时全局连续编号 (`ep-1`, `ep-2`, ...);
- **params**: 方法签名向下最多拼接 12 行, 用**平衡括号扫描** (跳过字符串字面量) 取出参数列表, 再按顶层逗号切分 (忽略泛型尖括号、注解圆括号与字符串内的逗号); 每个参数解析出 `EndpointParam`: `source` 由 `@RequestBody`/`@PathVariable`/`@RequestParam` 注解决定 (request_body / path_variable / request_param / unknown); `required` 规则——request_body 与 path_variable 恒必填, 带 `@NotBlank`/`@NotNull`/`@NotEmpty` 必填, `@RequestParam` 除非参数里出现 `required=false` 否则必填; Bean Validation 注解 (notblank、notnull、notempty、size、max、min、pattern、email、decimalmin、decimalmax、digits、positive、positiveorzero、negative、negativeorzero、length) 收集进 `constraints`; 大写开头且不在简单类型集合内的参数类型记为 `dtoType` (候选 DTO);
- **auth**: 收集 mapping 注解前 3 行到方法声明之间的安全注解 (`@PreAuthorize`、`@Secured`、`@RolesAllowed`、`@PermitAll`、`@DenyAll`);
- **entities**: 仅当文件声明的是 `class` (非 interface/enum)、类名大写开头且不以 `Controller`/`Service`/`ServiceImpl`/`Repository`/`Config`/`Application`/`Handler`/`Exception`/`Response` 结尾时才当作实体; 字段来自 `private Type name;` 声明; 约束注解**累积绑定到下一个字段声明** (一个字段可同时有 `@NotBlank` + `@Size`), 方法/类声明会清空累积 (避免跨字段泄漏); `@Size` 提取 `max`、`@Max`/`@Min` 提取数值、其余注解提取首个引号字面量, 得到 `FieldConstraint { field, rule, value }`;
- **enums**: 文件声明 `enum` 时, 用 ALL_CAPS 正则提取枚举常量 ( `\b` 边界避免误匹配构造器名), 构造参数中首个引号字面量作为人类可读 label, 否则 label 回退为常量名;
- **businessRules**: 从 `throw new Xxx("...")` 出发, 向上 15 行内找最近的 `if (...)` 守卫, 组成 `{ id: br-N, description: 错误文案, guard: 条件, file, line }`——这些错误文案正是负向用例断言的锚点来源;
- **uiTexts**: 错误文案 + 约束注解上的 `message = "..."` 校验消息, 去重且保序。

## go.ts — Go 后端分析 (yukino_http)

面向 `github.com/hangtiancheng/yukino.go/libs/yukino_http` 风格的 Go 服务, 合并入口 `analyzeGoBackend`, 产出 `BackendResult` (language `go`):

- **两遍扫描**: 第一遍跨文件收集三类事实——导出 struct (实体)、字符串枚举、`regexp.MustCompile` 变量——这样 `Validate()` 方法即使与 struct 声明不在同一文件也能正确归类约束; 第二遍逐文件解析 endpoints/约束/业务规则;
- **enums** (`collectGoEnums`): 先收集 `type X string` 声明的字符串枚举类型, 再收集引用这些类型的 const 值 (单行 `const Ident Type = "value"` 与 `const (...)` 块) 以及 `var m = map[X]string{...}` 标签映射, 产出 `EnumDef` (value 为常量字符串值, label 取映射否则回退 value) 和 `identToValue` (Go 常量标识符 → 枚举值, 供状态机使用);
- **endpoints**: 路由组 `api := app.Router("/prefix")` 的前缀可嵌套拼接; 路由注册 `api.Post("/path", h.Method)` 支持 Get/Post/Put/Delete/Patch/Head/Options 七个动词; `:param` 路径段归一化为 `{param}` 保持语言无关; controller 取所在函数的接收者类型, 每条 endpoint 带 file + line;
- **entities**: 导出 struct 的字段, 字段名优先取 `json:"..."` tag (无 tag 回退 Go 字段名), 类型取声明类型; 同样排除 Controller/Service 等非数据类后缀;
- **constraints**: 实体方法内的守卫形态归类——`x.F == ""` → `required`; `len(x.F) > N` → `size` (value 为 N); `!re.MatchString(x.F)` → `pattern` (value 为正则源码); 守卫中可能先经过 `strings.TrimSpace` 等辅助调用, 因此按「第一个能映射到已知 struct 字段的引用」定位字段; 同一 (field, rule) 组合去重 (DTO 镜像实体时不重复);
- **businessRules**: 未被归类为约束的 `if 守卫 + 错误字面量` 对——错误字面量来自 `errors.New("...")`、`fmt.Errorf("...")`、`ctx.Throw(code, "...")`; 守卫查找限定在所在 func 内、最多向上 15 行;
- **uiTexts**: 所有错误字面量都同时收集为后端可见文案, 去重保序。

## vue.ts — Vue 前端分析 (Element Plus)

纯正则解析, 合并入口 `analyzeFrontend`, 产出 `FrontendResult` (language `vue`):

- **pages/路由**: 只解析路由文件 (basename 为 `index.js` 或 `router.js` 且路径含 `router`); `parseRouter` 先定位 `path:`, 再向左回退到最近的 `{` 做**平衡括号提取** (源码注释: 绝不用 `[^{}]*` 这种懒惰正则, 避免嵌套对象截断), 取出 path/component/name; 路由文件只构建 pageName → route 映射, 真正的页面 (含表单) 来自 `.vue` 文件解析——**每个 .vue 文件都是一个 page** (列表页表单可为空), 若页面名在映射中则回填 route, 最后按 (file, name) 去重;
- **forms**: `<el-form` 正则带 `(?![-\w])` 守卫, 防止把 `<el-form-item>` 误判为表单; 用开闭标签计数提取完整表单块; 每个 `<el-form-item>` 片段解析出 `FormField`: label、prop、placeholder、required (`required` 属性或 `:required="true"`)、`:rules` (按逗号切分); type 依据片段内组件推断——`el-input` + textarea → textarea, `el-select` → select, `el-switch` → switch, 其余 input; 无 prop 也无 label 的空 form-item (纯按钮行) 跳过;
- **selectors**: 每个字段生成一条 `PageSelector`, 优先 placeholder、其次 label;
- **uiTexts**: `ElMessage.success/error/warning/info("...")` 与 `ElMessageBox.*` 文案——正向用例的成功断言与负向用例的校验断言都引用这些真实文案。

## lit.ts — Lit 前端分析 (@yukino.js/lit-jsx)

面向 Lit + JSX 技术栈, 合并入口 `analyzeLitFrontend`, 产出 `FrontendResult` (language `lit`):

- **路由文件**: `router.tsx/jsx/ts/js` 或 `router/index.tsx/jsx/ts/js`; `parseLitRouter` 同样用平衡括号提取路由条目 `{ path: '/x', element: <SomePage /> }`, 页面名取 `name:` 字段, 否则取 element/component 的组件标识符;
- **视图文件**: `views/` 目录下的 `.tsx/.jsx/.ts/.js`; 每个视图文件是一个 page, 解析其中的 `<form>` 块 (表单不嵌套, 跳过自闭合标签); 字段判定为**块内任何带 `label="..."` 属性的元素**——元素正则允许属性跨多行且引号内可含 `>` (源码注释强调的陷阱); prop 取 `prop` 或 `name` 属性, required 排除 `required="false"` 与 `required={false}`, type 由标签名 + `type` 属性提示推断 (textarea/select/switch/input);
- **页面合并**: 路由派生的占位页被真实视图页替换; 有路由但无视图模块的页面仍保留 (route-only page, file 为空串); 按 (file, name) 去重;
- **selectors**: 同 Vue, 优先 placeholder、其次 label;
- **uiTexts**: `showToast("...")` 与 `toast.success/error/warning/info("...")` 文案。

## state-machine.ts — Java 状态机推断

从代码推断状态机 (纯规则 + 源码证据), `extractStateMachines(backend, javaFiles, root)` 流程 (源码注释):

1. 找状态枚举: 优先名字含 `status`/`state` 的枚举, 回退到第一个有值的枚举 → states;
2. 找 `setStatus(X)` / `setXxxStatus(X)` 写点, 目标状态必须在枚举值中; **写初始状态 (枚举第一个值) 视为对象初始化** (如 `create()` 里 `setStatus(CREATED)`), 不算迁移, 跳过;
3. 向上走到方法签名 (public/private/protected) 确定方法边界, 从方法名推断触发器: `triggerFor` 查 `TRIGGER_MAP` (pay → Pay, ship/deliver → Ship, cancel → Cancel, approve → Approve, receive → Confirm Receipt, finish/complete → Complete 等), 查不到则原样使用方法名;
4. 在方法内向上找状态守卫——含状态字面量 (引号内 ALL_CAPS 或 `XxxStatus.CONST`) 的 `if`, 且守卫与写点之间必须出现 `throw`/`continue`/`return`/`break` 之一 (确认守卫真的拦截了流程), 据此推导 `from`:
   - 否定守卫 (`!X.equals(...)`、`status != OrderStatus.X`) → from = 守卫中点名的状态;
   - 肯定守卫 → from = 所有状态 - 点名状态;
   - 无守卫 → from = 所有状态 - 目标状态;
   - 无论哪种情况, from 中都剔除目标状态自身;
5. 每条 from 展开为一条迁移, `verified=true` (找到了真实状态写行), evidence 为 `文件#行号` (写点行; 若方法名能匹配到某个 endpoint, 追加该 endpoint 的 `文件#行号`), guard 记录守卫原文;
6. 一条迁移都没有则不产出状态机; 产出时 `confidence = 1`。

另导出 `bfsPaths(states, transitions, initialState)`: 从初始状态 BFS 到每个可达状态的最短推进路径 (`{ state: [initial, ..., state] }`), 规则用例生成 (`generation/rule-cases.ts`) 用它为状态用例编排前置步骤。

## go-state-machine.ts — Go 状态机推断

`extractGoStateMachines` 与 Java 版逐步对应:

1. 状态枚举来自 `collectGoEnums` 的结果 (const 值 + label 映射), 选择逻辑同 Java (status/state 命名优先);
2. 写点匹配 `x.Status = Ident` 赋值——正则用 `=(?!=)` 只匹配赋值、跳过 `==` 比较, 且 `!=` 因前导 `!` 永不命中; 目标常量经 `identToValue` 换成枚举值; 写初始状态同样视为初始化跳过;
3. 向上走到 `func` 声明确定函数边界, 触发器复用 Java 的 `triggerFor`;
4. 守卫: 函数内最近的、含状态常量 (Go 标识符或 ALL_CAPS 字符串字面量) 的 `if`, 且守卫与写点之间必须出现错误发射 (`errors.New` / `fmt.Errorf` / `.Throw`); `!=` 守卫 → from = 点名状态, 其余 → from = 所有状态 - 点名状态, 无守卫 → 所有状态 - 目标状态, 最后剔除目标状态;
5. `verified=true` (写点本身即证据), evidence/confidence/展开规则与 Java 版一致。

## 产物模型与持久化

分析产物类型定义在 `src/lib/types.ts`:

- `BackendResult`: language、endpoints (`Endpoint`: id/method/path/controller/methodName/file/line/params/auth)、entities (`Entity`: name/file/fields/fieldConstraints)、enums (`EnumDef`: name/values)、businessRules (`BusinessRule`: id/description/guard/file/line)、uiTexts;
- `FrontendResult`: language、pages (`Page`: name/route/file/forms)、selectors (`PageSelector`: type/value/page)、uiTexts、components;
- `StateMachineSpec`: name、states (name/label)、transitions (`StateMachineTransition`: id/from/to/trigger/verified/evidence/guard)、confidence。

持久化到两张表 (详见[数据模型](./data-model)): `code_analyses` (status、backend_result、frontend_result、warnings、error_message) 与 `state_machines` (name、states、transitions、confidence, 每次成功分析整体替换)。`code_analyses.status` 取值 `pending` → `running` → `success` / `failed` (`ANALYSIS_STATUS_META`, 定义在 `src/lib/enums.ts`)。

## 消费方

- 项目详情的 **Analysis** Tab (`components/project/AnalysisTab.tsx`): 触发 `analysis.trigger` 后凭 jobId 轮询进度条, 完成后展示后端/前端事实与状态机, 并显示 warnings 与错误信息;
- [七阶段流水线](./pipeline)的**阶段 0 code_analysis** (`workflows.ts` 的 `stageCodeAnalysis`): 配置项 `analyzeCode` (默认 true) 关闭时跳过; `reanalyzeCode` (默认 false) 关闭且最近一次分析已 `success` 时直接复用; 若有分析正在 `running` 则每秒轮询等待 (上限 120 秒); 阶段产出 payload 统计 endpoints/pages/selectors/stateMachines/uiTexts 数量;
- [用例生成](./generation)与用例评审都经 `getGenerationContext` 读取最近一次 `success` 的分析 (无则抛 `BizError(40010)` "Run code analysis before generating cases"); `sourceFacts` 把 pages/selectors/uiTexts/endpoints/entities/businessRules/enums/stateMachines 打包进 LLM 提示词与规则引擎输入; 规则用例的状态分支用 `bfsPaths` 编排前置步骤。

> 提示: 分析器对 Spring Boot、Go (yukino_http)、Vue (Element Plus)、Lit (@yukino.js/lit-jsx) 四类技术栈做了专门解析; 未识别的栈只记 warning, backendResult/frontendResult 为 null, 事实缺失会直接阻断生成 (40010), 需先保证项目属于受支持的技术栈。
