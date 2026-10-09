---
title: "A2UI 声明式 UI 协议"
description: "A2UI 声明式 UI 协议的机制与工程实践: 消息与 Catalog 契约、数据绑定与事件回传语义、v1.0 候选版的关键变化、多语言 SDK 能力面、A2A/MCP 集成, 以及生产应用的落地形态与降级策略。"
local_path: "$HOME/Downloads/a2ui"
---

本文讲 A2UI 协议本身: 它为什么存在、用什么样的消息与契约让模型生成 UI、渲染器如何消费并回传交互、跨语言 SDK 各自覆盖哪些能力、如何接入 A2A 与 MCP 等传输层。读完之后应当能判断一个功能适合不适合用 A2UI 实现, 以及在真实系统里需要补哪些工程环节。文末给出与通用渲染方案、低代码平台的取舍, 以及两条真实落地形态。

## 协议要解决的问题

生成式模型擅长产出文本与代码, 但要让 Agent 向用户呈现富交互界面很困难, 尤其是远程 Agent、或跨越信任边界的 Agent——编排器把一个任务委托给第三方 Agent, 后者要往主聊天窗口里渲染一块 UI。

两条常见的替代路线都有硬伤。

其一是让 Agent 生成 HTML/CSS/JS, 客户端用 iframe 加载渲染。iframe 是独立的浏览上下文: 有独立的 DOM 树、样式表与 JS 执行环境, 创建与通信开销大, 对话流里每插入一块 UI 就多一个 iframe; 布局嵌套、滚动联动、高度自适应都要跨框架手工协调; iframe 内样式与宿主完全隔离, 无法继承宿主的设计系统, 视觉割裂。最关键的是安全: 模型产出的 HTML/JS 属于不可信代码, 直接执行意味着任意脚本执行的风险。

其二是让模型直接生成目标框架的组件源码 (例如 React 组件)。代码既无法在运行时安全执行, 又与客户端技术栈强耦合, 无法跨端复用。

A2UI 的取向是让 Agent 说一种 UI 语言: Agent 不产出代码, 而是产出一段声明式 JSON, 描述 UI 的结构 (组件树) 与数据 (数据模型); 客户端用自身原生组件库 (React / Lit / Angular / Flutter / SwiftUI) 渲染这段描述, 并把用户交互回传给 Agent。官方对它的概括是 safe like data, expressive like code——像数据一样安全, 像代码一样有表现力。

三个设计取向决定了后续全部机制。

| 取向             | 含义                                                                 | 对应机制                                      |
| :--------------- | :------------------------------------------------------------------- | :-------------------------------------------- |
| 安全优先         | Agent 只能请求渲染 Catalog 内的组件, 客户端永不执行 Agent 下发的代码 | Catalog 白名单 + 命名函数调用 (FunctionCall)  |
| LLM 友好、可增量 | UI 抽象为扁平组件列表 (邻接表), 结构与数据分离                       | 邻接表 + JSON Pointer 数据绑定 + 流式增量消息 |
| 框架与传输无关   | 组件树与数据模型是抽象描述, 传输层可替换                             | 传输契约 + 多语言 Core SDK 与多渲染器适配层   |

与传统方式对比:

| 维度       | Agent 生成 HTML/JS + iframe | Agent 生成框架代码 | A2UI                            |
| :--------- | :-------------------------- | :----------------- | :------------------------------ |
| UI 载体    | 可执行文档                  | 可执行源码         | 声明式 JSON                     |
| 执行面     | 有 (沙箱隔离)               | 有                 | 无 (只渲染白名单组件)           |
| 样式一致性 | 与宿主隔离, 需手工对齐      | 与宿主一致         | 原生继承宿主设计系统            |
| 跨端复用   | 仅 Web                      | 与框架绑定         | 同一份 payload 多端渲染         |
| 增量更新   | 整文档替换                  | 重新构建           | 改数据不必重发结构              |
| 生成前校验 | 无法校验                    | 无法校验           | JSON Schema 全量校验 + 纠错闭环 |

## 核心概念与消息模型

本节以当前生产版本 v0.9.1 为准 (消息形态、字段与语义均按 v0.9.1 规范); v1.0 候选版的差异在"版本族"一节之后单独展开。

五个概念贯穿整个协议。

| 概念       | 说明                                                                                  |
| :--------- | :------------------------------------------------------------------------------------ |
| Surface    | 一块独立的 UI 区域, 由 `surfaceId` 标识, 拥有独立的组件树与数据模型                   |
| Component  | 组件, 以扁平列表 + ID 引用 (邻接表) 表达父子关系, 必须存在 id 为 `root` 的根组件      |
| Data Model | 每个 Surface 一份 JSON 数据模型, 组件通过 JSON Pointer 路径绑定其中的数据             |
| Catalog    | 客户端的可信组件/函数目录, 由 `catalogId` 标识, Agent 只能使用 Catalog 内的组件与函数 |
| Message    | 一条 JSON 对象, 恰好包含消息类型的信封键之一                                          |

服务端到客户端的消息有四类, 每条消息带一个 `version` 字段。

| 消息               | 方向            | 作用                                                                                    |
| :----------------- | :-------------- | :-------------------------------------------------------------------------------------- |
| `createSurface`    | 服务端 → 客户端 | 创建 Surface, 绑定 `surfaceId` + `catalogId`, 可选 `theme` 与 `sendDataModel`           |
| `updateComponents` | 服务端 → 客户端 | 新增或更新 Surface 内的组件 (扁平列表)                                                  |
| `updateDataModel`  | 服务端 → 客户端 | 按 JSON Pointer 路径 upsert 数据模型, 省略 `value` 表示删除该路径                       |
| `deleteSurface`    | 服务端 → 客户端 | 删除 Surface 及其全部组件和数据                                                         |
| `action`           | 客户端 → 服务端 | 用户交互事件, 携带 `name` / `surfaceId` / `sourceComponentId` / `timestamp` / `context` |
| `error`            | 客户端 → 服务端 | 客户端侧错误上报                                                                        |

`createSurface` 有三个容易被忽略的约束。`surfaceId` 与 `catalogId` 在创建后不可变, 要换配置必须删除重建; 对已存在的 `surfaceId` 重复 `createSurface` 是错误; 组件列表中必须恰好有一个 id 为 `root` 的组件作为树根。

`catalogId` 是一个字符串标识而非可解析的资源地址。它约定用 URI 形态书写以避免跨组织命名冲突, 但不要求指向任何真实可下载的文件; 客户端与服务端必须就用哪些 well-known 的 catalogId 达成一致。作为 JSON Schema 文档, catalog 定义建议同时带 `$id` 与 `catalogId`, 且两者取同一个 URI。

### 传输契约

A2UI 本身传输无关, 但任何传输层承担 A2UI 时必须满足四条契约。

1. 可靠有序投递: A2UI 是有状态更新 (先 `createSurface` 才能 `updateComponents`), 乱序会破坏 UI 状态。
2. 消息分帧: 需要清晰的消息分界 (JSONL 换行、WebSocket 帧、SSE 事件)。
3. metadata 支持: 用于承载客户端能力声明与数据模型回传, 以及初始化握手时的能力交换。
4. 双向通道 (可选): 渲染流是单向的, 交互应用需要 `action` 的返回通道。

常见的传输绑定包括 A2A、AG-UI、MCP (作为工具输出或资源订阅)、SSE + JSON-RPC、WebSocket、REST。其中 A2A 是最完整的一种, 因为它同时解决了会话标识 (contextId) 与跨 Agent 的能力协商。

### 版本族

协议按族演进, 不同族面向不同的模型使用方式。

| 版本族 | 状态                     | 取向与关键差异                                                                                                                             |
| :----- | :----------------------- | :----------------------------------------------------------------------------------------------------------------------------------------- |
| v0.8   | 已关闭 (legacy)          | 面向支持结构化输出 (structured output) 的模型; 组件用 `{类型名: 属性}` 包裹, 表面初始化用 `beginRendering`, 数据更新用 `dataModelUpdate`   |
| v0.9   | 稳定                     | prompt-first 协议族首个版本; 组件类型字段直接是类型名, 属性平铺, 表面初始化用 `createSurface`, 数据更新用 `updateDataModel` 的 upsert 语义 |
| v0.9.1 | 当前生产版本             | 与 v0.9 差异极小, 多语言 SDK 与渲染器以此为准                                                                                              |
| v1.0   | 候选 (release candidate) | 双向函数 RPC、单消息建 Surface、多 catalog 混用、`@` 前缀指令、去 theme 化; 详见下节                                                       |

v0.8 的规范目录已明确声明 closed、不再接受变更, 仓库保留它只为存量实现; SDK 侧仍提供 v0.8 适配器以消费历史消息。v0.8 与 v0.9 的核心分野不是字段改名, 而是生成方式: v0.8 假设模型受结构化输出格式约束, 协议可以略显冗长; v0.9 假设 JSON Schema 直接嵌进 prompt 让模型仿写, 因此可以把 schema 做得更复杂可读。代价是生成结果必须经过校验与修复, 这一点在"生成可靠性"一节展开。

### v1.0 候选版的关键变化

v1.0 已有完整规范 (协议文档、JSON Schema、A2A 扩展、basic catalog) 与多语言适配器, 相对 v0.9.1 的变化集中在六个方面。

**1. 双向函数 RPC。** 消息从四类扩为六类: agent 到 renderer 增加 `callRendererFunction` 与 `agentFunctionResponse`, renderer 到 agent 增加 `callAgentFunction` 与 `rendererFunctionResponse`。函数调用有了显式的执行边界: catalog 可为每个函数声明 `allowedCallers` (`rendererOnly` / `agentOnly` / `rendererOrAgent`, 缺省 `rendererOnly`), 渲染器在运行时按 catalog 配置强制校验——收到对 `rendererOnly` 或未注册函数的远程调用时, 以 `INVALID_FUNCTION_CALL` 错误拒绝; `agentOnly` 函数不允许绑定到组件属性或由 UI 动作触发。调用必须携带 `functionCallId`, 渲染器无论返回类型是否为 void 都必须回 `rendererFunctionResponse` (携带同一个 `functionCallId` 与结果值) 或 `error` 消息。basic catalog 的 `openUrl` 标注 `requiresUserActivation: true`, 即需要用户手势激活。

**2. 单消息建 Surface。** `createSurface` 可直接内嵌 `components` 与 `dataModel` (以及 `metadata.extensions`), 一条消息完成整块 UI 的组合; `catalogId` 变为可选, 仅作为该 Surface 的缺省 catalog。这正是 [A2UI Express](a2ui-express) 编译产物的目标形态。

**3. 多 catalog 混用与解析顺序。** 组件与函数调用可各自携带 `catalogId`, 一个 Surface 内可混合多个 catalog 的组件与函数 (混用的 catalog 必须同属一个协议版本)。解析顺序是: 组件/调用自身的 `catalogId` → Surface 缺省 `catalogId` → 两者皆无则报错不渲染, 不回退到能力声明里的 catalog。

**4. `@` 前缀指令。** 动态值指令改用 `@` 前缀: 数据绑定 `{"@path": "/x"}`, 函数调用 `{"@call": "f", "args": {...}}`, 模板迭代上下文 `@index` (仅限模板作用域)。普通对象中的 `path` / `call` 键从此是字面量数据, 不再被截获为指令; 字面 `@` 开头的键用双写转义 (`"@@path"` 表示字面 `"@path"`)。注意 ChildList 模板对象与 `updateDataModel` 信封上的 `path` 是消息参数而非绑定, 保持不带前缀。

**5. 去 theme 化与命名规范。** catalog 与 `createSurface` 上的 `theme` (含 `primaryColor`) 被整体移除, 视觉品牌完全交给目标框架的原生主题; v0.9.1 中承载 Agent 身份归属的 `iconUrl` / `agentDisplayName` 也随之离开协议层。所有 catalog 实体名 (组件名、函数名、参数键) 必须符合 Unicode UAX #31 标识符规则; `ComponentCommon` 与 `createSurface` 支持扩展元数据 (UAX #31 键, 保留 `a2ui_` 命名空间)。

**6. 其余语义收紧。** `updateDataModel` 的 `value` 变为必填, 删除键要显式写 `null` (v0.9.1 的"省略 value 即删除"不再合法); `CheckRule` 支持函数直接返回动态 `ValidationResult` 对象 (`valid` / `code` / `message` / `severity`), `message` 退化为兜底文案; catalog 的 `functions` 定型为函数名到定义的对象映射, 内联 catalog 允许携带标准 JSON Schema 元数据 (`$schema` / `$id` / `title` / `description`); 术语全局改名, client → renderer、server → agent, schema 文件随之更名 (`agent_to_renderer.json` 等); basic catalog 增补 `Video.posterUrl`、`TextField.placeholder`、`Slider.steps` 等可选属性。

迁移时最危险的坑是"全局替换 `path` → `@path`": 只有处于动态值 (DynamicValue) 位置的绑定与调用才加前缀, ChildList 模板、`updateDataModel` 信封参数、以及普通数据里恰好叫 `call` 的键 (如 Icon 的名字枚举) 都必须原样保留。

### 一个最小消息序列

以下是一个联系人表单的完整消息流 (JSONL 分帧), 展示了四类消息的先后与数据绑定形态。

```jsonc
// 1. 建 Surface, 绑定 catalog
{"version": "v0.9.1", "createSurface": {"surfaceId": "contact_form", "catalogId": "https://a2ui.org/specification/v0_9_1/catalogs/basic/catalog.json"}}

// 2. 下发组件树 (扁平邻接表): root 引用子组件, 输入组件绑定数据路径
{"version": "v0.9.1", "updateComponents": {"surfaceId": "contact_form", "components": [
  {"id": "root", "component": "Column", "children": ["email_field", "submit_button"]},
  {"id": "email_field", "component": "TextField", "label": "Email", "value": {"path": "/contact/email"}, "checks": [{"condition": {"call": "email", "args": {"value": {"path": "/contact/email"}}}, "message": "Invalid email"}]},
  {"id": "submit_button", "component": "Button", "child": "submit_label", "action": {"event": {"name": "submit_form", "context": {"email": {"path": "/contact/email"}}}}},
  {"id": "submit_label", "component": "Text", "text": "Send"}
]}}

// 3. 填充数据模型 (结构化初值)
{"version": "v0.9.1", "updateDataModel": {"surfaceId": "contact_form", "path": "/contact", "value": {"email": "jane@example.com"}}}

// 4. 移除 Surface
{"version": "v0.9.1", "deleteSurface": {"surfaceId": "contact_form"}}
```

用户点击 Send 时, 客户端解析 `/contact/email` 得到当前输入值, 作为 `context` 发出 `action`。若该 Surface 开启了 `sendDataModel`, 同一条消息的 metadata 还会带上整个 Surface 的数据模型。

### Surface 生命周期规则

- `createSurface` 必须先于该 Surface 的任何 `updateComponents` / `updateDataModel`。
- `surfaceId` 与 `catalogId` 创建后不可变, 要换配置必须删除重建; 对已存在的 surfaceId 重复 `createSurface` 是错误。
- 组件列表中必须恰好有一个 id 为 `root` 的组件作为树根; `root` 未到达前, 其他组件更新被缓冲, 不产生可见效果。
- `deleteSurface` 移除 Surface 及其全部组件和数据。

## 组件模型与 Catalog

### 邻接表

组件以扁平列表下发, 树结构靠 ID 引用隐式构建。客户端把所有组件存入一棵以 ID 为键的映射, 渲染时重建树。这样设计带来三个直接能力: 组件可以任意顺序到达; 可以引用尚不存在的子组件或数据路径 (渲染器先渲染占位, 等待补齐); `root` 定义后即可开始渲染, 跳过无效引用。

```text
服务端流:
  updateComponents { components: [root, title, button] }
        |
        v
客户端缓冲 (Map<ComponentId, Component>):
  root   { component: Column, children: [title, button] }
  title  { component: Text, text: "Welcome" }
  button { component: Button, child: button_label }
        |
        v
渲染树: Column -> [Text, Button]
```

组件对象只有 `id` 与 `component` 两个必填字段, 其余属性按各自类型直接平铺在对象上 (v0.8 的包裹对象与 `params` 键在 v0.9 已不存在)。容器组件用 `children` 或 `child` 引用子组件。

`ChildList` 有两种形态: 数组形态是静态的 `ComponentId` 引用列表; 对象形态是列表模板 `{ componentId, path }`, 监听 `path` 指向的数组, 为每个元素实例化模板组件。

### 组件与函数的目录: Catalog

Catalog 是 Agent 与渲染器之间的契约, 一个对象包含 catalogId、components (组件名到 JSON Schema 的映射)、functions (函数定义) 与 theme (主题属性 schema)。

官方维护一份 basic catalog, 提供 18 个通用组件与 14 个函数。它刻意保持精简以便各渲染器实现, 官方明确不追求跨客户端的标准化 catalog——UI 由 LLM 生成, LLM 可以针对每个前端解释各自的 catalog, 因此关键在于"你的设计系统是什么", 任何组件集合都能注册。

官方另提供一份 MCP catalog (`catalogs/mcp`): 定义 `callMcpTool` (按名字调用 MCP 工具, 返回原始 `CallToolResult`) 与五个数据函数 (`jmespath`、`split`、`regexCapture`、`regexReplace`、`updateDataModel`), 让 Surface 内的控件直接调用 MCP 工具、把结果变换后写回数据模型; payload 只携带工具名, 多服务器路由由宿主解析。

basic catalog 的组件:

| 分类 | 组件                                                             |
| :--- | :--------------------------------------------------------------- |
| 展示 | Text (支持简单 Markdown)、Image、Icon、Video、AudioPlayer        |
| 布局 | Row、Column、List、Card、Tabs、Divider、Modal                    |
| 交互 | Button、CheckBox、TextField、DateTimeInput、ChoicePicker、Slider |

basic catalog 的函数:

| 分类   | 函数                                                              |
| :----- | :---------------------------------------------------------------- |
| 校验   | required、regex、length、numeric、email                           |
| 格式化 | formatString、formatNumber、formatCurrency、formatDate、pluralize |
| 行为   | openUrl                                                           |
| 逻辑   | and、or、not                                                      |

theme 在 v0.9.1 支持三个属性: `primaryColor` (主色)、`iconUrl` 与 `agentDisplayName` (Agent 身份归属)。在多 Agent 或编排器场景下, 编排者负责设置或覆写后两个身份字段并校验其与真实 Agent 服务一致, 防止恶意 Agent 冒充可信服务。注意这是 v0.9.1 的机制: v1.0 把 theme 连同这三个属性整体移除, 视觉品牌交给目标框架的原生主题, 身份归属改由传输层或宿主应用自行承载。

### Catalog 扩展

有两种扩展面: 约束 Agent 的组件集合, 以及给 Agent 增加新的客户端函数。

自定义 catalog 与 basic catalog 同构, 只是把 `$ref: "catalog.json#/$defs/anyComponent"` 指向自己的组件集合。为了让校验器能检查父子引用完整性, 自定义 catalog 必须遵守两条强制规则: 任何持有子组件 ID 的属性必须使用 `common_types.json` 中的 `ComponentId` 类型 (`$ref`), 不能写成裸 string; 任何持有子列表或模板的属性必须使用 `ChildList` 类型。校验器正是靠这两个 `$ref` 识别哪些字段是结构链接——若写成裸 string, 校验器会把它当静态文本, 不再检查目标组件是否存在。

自定义函数的做法是在 catalog 的 `functions` 中声明函数 schema (参数、命名、`returnType`), 并在 `$defs.anyFunction` 的 `oneOf` 中登记。校验时按 `call` 值做判别式查找: 命中的函数按其规则校验 `args`, 未登记的 `call` 直接失败。内置函数可以通过 `$ref` 引回 basic catalog 的 `anyFunction`, 与自定义函数合并。

### 能力协商

客户端支持哪些 catalog 通过两种方式告诉服务端。

pre-shared catalog: 客户端只声明 `supportedCatalogIds` 字符串列表, 服务端预先已知这些 catalog 的内容。

inline catalog: 客户端把本地注册组件的完整 JSON Schema 内联进 `a2uiClientCapabilities` 发送给服务端, 服务端据此注入 system prompt。适合客户端有自定义组件的场景。服务端是否接受内联 catalog 由 AgentCard 中 `acceptsInlineCatalogs` 声明, 缺省为 false。

## 数据模型、绑定与更新

### 路径与作用域

数据绑定基于 JSON Pointer (RFC 6901), 并扩展支持相对路径。

- 以 `/` 开头的绝对路径始终从 Data Model 根解析, 与组件在树中的位置无关。
- 不以 `/` 开头的相对路径只在 ChildList 模板创建的子作用域内有效, 解析到当前迭代项。例如遍历 `/users` 的模板中, 相对路径 `firstName` 在第一项解析为 `/users/0/firstName`。
- 在数组段的路径段上使用非数字索引是错误。
- 模板内部仍可用绝对路径访问根作用域。

渐进渲染期间路径可能解析为 `undefined`, 渲染器应优雅处理 (空串或 loading 占位)。

非字符串值插值时的类型转换规则: 数字/布尔转标准字符串表示; null/undefined 转空串; 对象/数组转 JSON 字符串, 以保证跨语言实现一致。

### 数据模型更新

服务端的 `updateDataModel` 采用严格的 upsert 语义:

- 路径存在则更新, 不存在则创建。
- 省略 `value` 则删除该键; 数组场景下把对应索引置为 `undefined` 以保持长度。
- 省略 `path` (或为 `/`) 则替换整个数据模型。

### 双向绑定与回传

输入组件 (TextField、CheckBox、Slider、ChoicePicker、DateTimeInput) 与数据模型建立双向绑定:

- 读 (Model → View): 渲染时从绑定路径读值; 服务端更新数据模型后组件自动重渲染。
- 写 (View → Model): 用户输入立即写回本地数据模型, 绑定同一路径的其他组件实时联动。
- 本地数据模型是唯一数据源; 键入等被动变化不触发网络请求。

状态回传只在 `action` 触发时发生: 通过 `action.context` 引用数据路径, 或对 Surface 开启 `sendDataModel`——开启后客户端在每次发给创建该 Surface 的服务的消息里附带该 Surface 完整数据模型。数据模型只投递给创建者, 不会泄漏给其他 Agent。

## 事件、函数与校验

### action

交互组件通过 `action` 属性声明行为, 二选一。

| 形态           | 语义                                                                               | 示例                                                                                    |
| :------------- | :--------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------- |
| `event`        | 触发发往服务端的事件, 携带 `name` 与可选 `context`; context 中的动态值在触发时解析 | `{"event": {"name": "submit_form", "context": {"email": {"path": "/formData/email"}}}}` |
| `functionCall` | 执行客户端本地注册的函数                                                           | `{"functionCall": {"call": "openUrl", "args": {"url": {...}}}}`                         |

服务端事件的标准处理流程是: 捕获组件动作 → 解析动作所需的数据上下文 → 发给服务端 → 处理返回的消息。

### 客户端逻辑与校验

v0.9 把客户端逻辑统一抽象为函数 (Function), 按名字引用, 绝不传输可执行代码。函数与组件一起定义在 catalog 中, 客户端运行时从 catalog 读取执行边界配置。

输入组件与 Button 都可以声明 `checks` 校验列表, 每项是一个布尔条件 (通常为 FunctionCall) 加失败文案。输入组件展示错误信息; Button 校验失败会自动禁用, 因此按钮状态可以依赖数据模型的有效性。校验函数必须返回布尔值。

### formatString

`formatString` 是唯一支持内嵌表达式的字符串函数, 语法为 `${...}`:

- `${/user/profile/name}` 绝对路径插值, `${firstName}` 相对路径插值。
- `${formatDate(value:${/currentDate}, format:'yyyy-MM-dd')}` 函数调用, 参数支持字面量与嵌套表达式。
- 要输出字面量 `${`, 需转义为 `\${`。

### 服务端扩展: 可编程组件 (macros)

组件扩展通常意味着客户端要新增渲染实现。Python Agent SDK 提供了另一条路径: 用 `@macro` 装饰器注册高层布局函数, 模型像写 catalog 组件一样写 macro 组件, 服务端在下发前把它们同步展开为标准原语组件子树, 客户端零改动。

宏的注册读取 Python 函数的签名与类型提示, 把参数类型逐条映射为协议 JSON Schema (Dynamic\* 映射 common types 中的同名 `$defs`, 单子槽位映射 `ComponentId`, 组件节点列表映射 `ChildList`, Action/CheckRule 等各映射对应 `$ref`); docstring 被解析为参数描述。执行前, 类型强制引擎把模型产出的 JSON 参数强制转换为 builder AST 类型 (字符串对单子槽位转 ComponentRef, `{"path": ...}` 转 DataBinding, action 的三种 wire 形态归一为 Action), 宏函数返回的节点经扁平化 (ID 命名空间化 + root 拼接) 后成为标准组件子树。展开器支持宏中嵌套宏的递归展开, 单个宏展开失败时记日志并保留原组件, 不丢弃整批消息。

这条通道的价值在于把"高层语义"留在服务端: 例如一个只接收 `employeeId` 的宏, 可以由服务端 resolver 回调查询内部数据库后注入敏感数值, 敏感数据不进入模型上下文。

## 渲染与事件回传语义

不同语言、不同框架的渲染器差异很大, 但它们共享一套语义分层。以下是从消息到像素的通用链路。

```text
A2UI 消息流 (JSON)
  -> MessageProcessor: 校验、分发、维护 Surface 状态
  -> SurfaceModel: 每个 Surface 的 DataModel + ComponentsModel (可观察状态)
  -> 解析层: 把组件模型解析为响应式的节点树, 未到达组件生成占位
       - 按 catalog schema 解析属性, 订阅数据路径
       - 动态属性成为已解析绑定, action 属性成为可调用闭包
       - child 属性成为活的子节点引用
  -> 框架适配层: 订阅节点树, 分发到各组件实现
  -> 原生组件 (React / Lit / Angular / Flutter / SwiftUI)
```

这条链路有几个关键语义。

渐进渲染: 组件可乱序到达、可引用尚不存在的子组件或数据路径, 未到达时渲染占位, 到达后原位替换。`root` 未到达前, 其他组件更新被缓冲, 不产生可见效果。

细粒度更新: 节点只在自身已解析属性变化时发出信号, 子节点内部属性变化不触发父节点。更新范围被限制在单个组件粒度, 避免整棵树重渲染。框架适配层通常把信号系统桥接到框架的外部存储订阅模型 (例如 React 的 `useSyncExternalStore`、Lit 的信号混入)。

属性绑定分类: 渲染器按组件 schema 把属性分为几类处理。动态属性建立数据订阅; action 属性创建可调用的动作闭包; 结构属性 (children / child) 构建子组件列表并订阅数组路径; 可校验属性执行 catalog 注册的校验函数; 静态属性直接赋值。这个分类是 schema 驱动的, 因此新增组件不需要改渲染器内核。

事件回传: 渲染器触发动作闭包时先解析 context 中的数据绑定 (相对路径在当前列表项作用域内解析), 再把事件汇聚到全局 action 处理器。应用层通常有两种处理方式:

- 回到对话流: 把 action 作为一条新消息发回 Agent, 由模型决定下一步。
- 带外原地更新: 把 action 单独发给一个动作管线, 服务端返回针对同一 Surface 的增量消息 (只含 `updateComponents` / `updateDataModel`), 客户端把它们追加到该 Surface 的消息列表, 在原位更新 UI, 不产生新的对话气泡。

### 渲染期的占位 (loading)

协议本身没有 loading 语义——四类消息中没有任何 loading 状态字段。渐进渲染期间的占位完全是渲染器或宿主侧的实现问题。协议提供的基础是: 未到达组件默认渲染占位; `root` 未到达前其余更新被缓冲; 绑定路径解析为 `undefined` 时建议按空串或 loading 优雅处理。

据此可以把 loading 分三层, 分别对应三类消息的到达状态。

| 层级       | 触发状态                                   | 可渲染的形状                              | 移除条件                                   |
| :--------- | :----------------------------------------- | :---------------------------------------- | :----------------------------------------- |
| Surface 级 | `createSurface` 已到, 组件与数据未到       | 整体骨架卡 (标题条 + 文本条 + 图块)       | 根组件到达并被解析替换                     |
| 组件级     | `updateComponents` 部分到达                | 通用灰块或脉冲占位 (此时还不知道组件类型) | 该组件 id 到达, 快照从"缺失"切换为"已解析" |
| 数据级     | 组件已到, `updateDataModel` 未到或部分到达 | 精确形状骨架 (文本条 / 图块 / 圆形)       | 数据定型 (settled) 且值非 undefined        |

数据级占位的难点是区分"数据未到"与"值确实为空", 协议消息不区分这两者, 需要渲染器自建 settled 信号 (一批消息处理完成、流结束事件, 或窗口内无新消息的超时)。骨架是渲染器本地行为, 不进 catalog、不污染协议: Agent 不能也不需要请求骨架。

## 多语言 SDK 能力面

SDK 生态分为三层, 各语言共用同一套结构。

```text
Framework Adapter (把 Surface 状态渲染为原生 UI)
      | 依赖
      v
A2UI Core SDK (Surface 状态、消息处理、校验、增量快照)
      ^ 依赖
      |
Inference SDK (用 LLM 生成 server-to-client 消息: prompt 构造、解析、纠错重试)
```

Core SDK 提供协议的语言原生表示: 强类型的 Catalog 声明 (Catalog / ComponentApi / FunctionApi) 与消息类型; Surface 状态的可变模型 (SurfaceModel / ComponentModel / DataModel); 处理层 (MessageProcessor 求值消息数组、解析相对指针、更新状态); 校验; 增量快照 (把更新折叠为扁平的节点树)。Inference SDK 负责引导模型按 catalog 生成合法消息, 包括 prompt 构造、消息解析与修复、错误重试。

各语言的能力面 (以仓库当前实现为准):

| 平台       | Core                                            | Inference                                                  | 渲染/适配层                                                      |
| :--------- | :---------------------------------------------- | :--------------------------------------------------------- | :--------------------------------------------------------------- |
| TypeScript | `@a2ui/web_core` (含 v0.8 / v0.9 / v1.0 子路径) | `@a2ui/agent`                                              | `@a2ui/react`、`@a2ui/lit`、`@a2ui/angular`、`@a2ui/markdown-it` |
| Python     | `a2ui-core`                                     | `a2ui-agent-sdk` (含 a2a、adk、macros、四种推理格式)       | 无独立渲染器 (服务端为主)                                        |
| Dart       | `a2ui_core`                                     | `a2ui_agent` (v0.9 协议 API, 含 DirectJson / Express 格式) | `a2ui_flutter` 仍是占位包, Flutter 渲染由独立的 GenUI SDK 提供   |
| Swift      | `A2UICore`                                      | —                                                          | `A2UISwiftUI` 适配层 + `BasicCatalog`                            |
| Kotlin     | —                                               | 仅存 `agent_sdk_legacy`                                    | —                                                                |

TypeScript 与 Dart 的 Core 都实现了同构的解析层 (节点解析器 / 组件节点 / 已解析绑定), 仓库的 conformance 套件以同一组用例钉住两者的行为: 节点解析、表达式解析、数据模型与数据上下文 (路径 upsert/删除语义、作用域相对路径解析) 逐语言对齐。Core 的对外 API 面刻意收窄, 渲染器统一经节点解析器读取组件, 不直接接触绑定器内部。

Python Core 用版本适配器工厂消化协议差异: v0.8 / v0.9 / v0.9.1 / v1.0 各注册一个适配器 (v0.9.1 复用 v0.9 适配器), 按消息的 `version` 字段解析, 缺失时回退 v0.9, 也支持动态注册自定义适配器。TypeScript 的 web_core 则以版本子路径并存 (`@a2ui/web_core/v0_8` / `v0_9` / `v1_0`), 渲染器按所用协议版本选择入口; v1.0 basic catalog 在 web_core 中还以通用 custom elements 提供 (`./v1_0` 与 `./catalogs/basic/v1` 子路径), 但 React / Lit / Angular 渲染器尚未开放 v1.0 入口。

Python Core 同时是 wire schema 的生成源: specification 目录下 v0.8 / v0.9 / v0.9.1 的 `server_to_client.json` 与 v1.0 的 `agent_to_renderer.json` 由 `a2ui.core.schema` 的 Pydantic 模型重建 (模型本身由代码生成工具从 spec schema 产出), conformance 套件 (`core/agent_to_renderer.yaml`) 断言各版本重建结果与已发布 spec 文件完全一致; catalog 的 `catalog_schema` 同样从模型重建后与已发布 `catalog.json` 比对 (`core/catalog.yaml`)。模型与 spec 文件由此互相钉住, 不会单边漂移。

Dart 的 Core 还有一个值得注意的设计: 动态属性以"可写绑定"承载, 写入走绑定的 set; 事件载荷分两类——`event` 型派发为动作, `functionCall` 型由节点的动作闭包在本地执行。这个区分保证了"本地函数绝不出网"。

### 框架适配层的行为契约

同一个 Core 状态模型要映射到不同框架, 适配层必须实现同一组行为契约, 否则跨端表现会不一致。

| 契约         | 说明                                                               | 典型实现手段                                        |
| :----------- | :----------------------------------------------------------------- | :-------------------------------------------------- |
| 外部状态订阅 | 把 Core 的信号桥接到框架的调度模型, 避免手动重渲染                 | React 的 `useSyncExternalStore`; Lit 的信号侦听混入 |
| 节点分发     | 按节点状态分发到具体组件实现, 处理未知类型 / 占位 / 无实现三种分支 | 一个薄分发视图, 递归渲染已解析子节点                |
| 子节点构建   | 把解析器的子节点引用转换为框架可渲染的子元素                       | 由适配层提供 `buildChild` 回调                      |
| 卸载清理     | 组件与绑定器卸载时释放数据订阅, 防止内存泄漏                       | 订阅对象 + `dispose`                                |
| 并发安全     | 并发渲染下被丢弃的渲染不应构造解析器或建立订阅                     | 在订阅建立函数内惰性创建, 由卸载函数回收            |

### 扩展机制总览

A2UI 的扩展点分布在几个层次, 选择哪一层取决于要改变什么。

| 扩展点              | 改变什么                               | 客户端改动        | 服务端改动                |
| :------------------ | :------------------------------------- | :---------------- | :------------------------ |
| 自定义 catalog      | 限制或增加可渲染的组件集合             | 注册新组件实现    | prompt 换成自定义 catalog |
| 自定义函数          | 增加客户端可调用的校验/格式化/行为函数 | 注册函数实现      | catalog `functions` 声明  |
| 内联 catalog        | 把客户端能力全量告知服务端             | 导出组件 schema   | 接受并在 prompt 中注入    |
| 可编程组件 (macros) | 服务端展开的高层组件抽象               | 无                | 注册宏 + 展开             |
| 协议版本族          | 生成方式与消息形态                     | 升级 Core SDK     | 升级 SDK 与 prompt        |
| A2A 扩展            | 能力协商与会话绑定                     | 声明 clients 能力 | 声明 AgentCard 扩展       |

## 与 A2A 的集成

A2A (Agent2Agent) 是 Agent 间以及 Agent 与前端应用间标准化通信的开放协议, 提供消息格式、认证、传输与扩展协商的完整绑定。A2UI 传输无关, 但 A2A 是最主流的传输层, 因为 A2A 同时提供了会话标识与跨 Agent 能力协商。

### 能力发现: AgentCard

A2A Server 在固定路径暴露 AgentCard, 声明自身能力。A2UI 以 A2A 扩展的形式登记:

- 扩展 URI 显式编码版本, 形如 `https://a2ui.org/a2a-extension/a2ui/v0.9.1`。
- `params.supportedCatalogIds` 声明 Agent 能生成哪些 catalog 的 UI。
- `params.acceptsInlineCatalogs` 声明是否接受客户端内联 catalog, 缺省 false。

在 AgentCard 中声明 A2UI 扩展是可选的 (鼓励但不强制), 用于告知客户端是否值得发送能力声明。客户端读取 AgentCard 完成初始化。

### 激活与协商

显式激活方式按传输层区分: JSON-RPC over HTTP 用请求头 `X-A2A-Extensions` 携带扩展 URI; gRPC 把 URI 放入 `sendMessageParams.metadata["X-A2A-Extensions"]`。

服务端的解析逻辑是: 读取客户端请求的扩展 URI 与自身声明的扩展列表取交集, 从中选择最新版本激活, 否则按普通文本对话处理。不匹配时 A2UI 功能不激活, 模型不会生成 A2UI JSON。

显式激活并非必需。客户端也可以在每条消息的 metadata 中携带 `a2uiClientCapabilities`, Agent 据此判断是否下发 UI; Agent 返回的 DataPart 带 `application/a2ui+json` 时客户端即知是 A2UI 消息。不应使用 `accepted_output_modes: ['a2ui']` 触发 A2UI, 这不是标准做法。

### 消息映射

A2UI 消息编码为 A2A 的 DataPart:

- 标记方式为 `DataPart.data.metadata["mimeType"] = "application/a2ui+json"`。
- `data` 字段必须是 A2UI 消息数组。
- 服务端下发时 `data` 需通过 server-to-client 消息列表 schema 校验; 客户端上行时需通过 client-to-server 消息列表 schema 校验。

处理规则 (来自扩展规范):

- 消息列表不是事务单元, 接收方必须按序逐条处理。
- 单条消息校验或应用失败时, 记录错误并继续处理后续消息; 原子性只在单条消息级别保证。
- 渲染器建议等列表内所有消息处理完再重绘, 避免中间状态闪烁。

### metadata 承载的能力与状态

客户端发给 Agent 的每条 A2A 消息, 可在 `message.metadata` 中携带两类 A2UI 数据。

| 字段                     | 内容                                                           | 作用                          |
| :----------------------- | :------------------------------------------------------------- | :---------------------------- |
| `a2uiClientCapabilities` | 按协议版本分组的 `supportedCatalogIds` 与可选 `inlineCatalogs` | 让 Agent 知道客户端能渲染什么 |
| `a2uiClientDataModel`    | 开启数据同步的 Surface 的完整数据模型 (按 surfaceId 组织)      | 让 Agent 拿到 UI 当前状态     |

数据模型只发给创建该 Surface 的 Server, 不会泄漏给其他 Agent。

v1.0 扩展沿用同一套机制, 只做了术语对齐: metadata 键改名为 `a2uiRendererCapabilities` 与 `a2uiRendererDataModel`, 扩展 URI 为 `https://a2ui.org/a2a-extension/a2ui/v1.0`。

### 会话与流式

A2A 基于 JSON-RPC, 核心方法为 `message/send` (同步) 与 `message/stream` (流式, 服务端通过 SSE 逐步返回 status-update / message 事件)。

会话相关概念: Task 是一次请求的处理结果对象 (含状态与 `status.message.parts`); `contextId` 是会话标识, 同一 contextId 下的消息共享对话历史; `messageId` 标识单条消息。A2UI 的一组相关 Surface 应共享同一 `contextId`。

一个实现细节值得注意: status-update 事件的 parts 是累积语义 (每次事件携带截至当前的全部 parts), 因此流式客户端必须自行对重复出现的 `createSurface` 去重, 否则会触发"Surface 已存在"错误。

完整链路:

```text
客户端 (浏览器)
  -> fetch 到本地代理端点 (可选的协议转换层)
  -> A2A JSON-RPC message/stream, 头部 X-A2A-Extensions: <a2ui 扩展 URI>
  -> Agent Server: 激活 A2UI 扩展 -> 组装 prompt (内嵌 schema + catalog)
  -> LLM ReAct 循环: 调工具取数据 -> 生成 A2UI JSON
  -> 服务端校验 (失败则回喂错误自纠)
  -> 编码为 DataPart (application/a2ui+json), 经 SSE status-update 流式下发
  -> 客户端逐帧解析 -> MessageProcessor.processMessages -> 渲染
```

若省去 A2A, 用 SSE/WebSocket 直连服务端也能跑, 但需要自行实现能力协商与会话标识。

## 示例应用与典型链路

仓库内的示例覆盖了从最小可运行到产品级集成的不同层次。

- restaurant_finder (ADK Agent): 一个搜索餐厅、推荐、预订的多轮 Agent。它演示了 ReAct 循环与 A2UI 生成如何结合——第一轮模型调用工具取餐厅数据, 第二轮生成"餐厅卡片列表"的 A2UI 消息, 用户点"预订"按钮触发 action, 服务端据此生成预订表单 (新的 Surface), 提交后再生成确认卡片。这条"列表 → 表单 → 确认"的链路说明了结构 (updateComponents) 与数据 (updateDataModel) 分离的价值: 改数据不必重发结构。
- React / Lit 客户端 shell: 两个 shell 跑同一个协议, 差别只在传输层与响应式桥接。React shell 用浏览器 fetch 到本地开发中间件, 由中间件做协议转换与 SSE 流式转发; Lit shell 直接在浏览器里用 A2A 客户端连 Server。两者的 MessageProcessor、SurfaceModel、绑定器全部来自框架无关的 Core SDK, 适配层只是两种技术栈的桥接。这印证了"协议层代码可复用, 渲染器按技术栈选择"的设计。
- custom-components-example: 演示自定义 catalog。服务端用内联 catalog 声明一组自定义组件 (如联系人卡片), 客户端注册对应实现——Agent 只能请求渲染这些已注册组件。
- community/macros: 社区 macros 示例——演示服务器与交互式 React 客户端: 用 `@macro` 注册高层布局宏, 模型输出走 Express DSL, 服务端同步展开为标准组件, 含服务端 resolver 注入敏感数值的演示。
- A2UI over MCP: 把 A2UI 消息作为 MCP 工具的返回内容, 由支持 A2UI 的客户端渲染。
- MCP Apps in A2UI: 反过来让 A2UI 客户端承载不受信的第三方 MCP App。仓库把这条路径做成一个可复用的双 iframe 隔离件 (samples/client/shared/mcp_apps_inner_iframe, Angular 与 Lit 客户端共用): 同源、不加沙箱的外层代理 iframe 负责消息中继 (顺带消除 Angular DevTools 与浏览器扩展触发的 SecurityError), 内层 iframe 固定 `sandbox="allow-scripts allow-forms allow-popups allow-modals"`, 刻意不含 `allow-same-origin` (隔离存储与 cookie), 也不含 `allow-top-navigation` 一族 (防止内层脚本劫持顶层窗口), 防止"allow-scripts + allow-same-origin"组合导致的沙箱逃逸。示例里内层 App 再把收到的 A2UI JSON 渲染为 Surface, 验证了"MCP App 内嵌 A2UI 渲染"的组合。需要注意, A2UI 官方规范只声明了"A2UI 可经 MCP 传输"的绑定, 双 iframe 承载是实现选择而非协议规定。

```text
A2UI 传输无关的分层 (以流式 Agent 为例)

  Agent 侧                       传输层                     客户端侧
  -------                       ------                     --------
  prompt + catalog 契约  -->    A2A / AG-UI / MCP / SSE  -->  MessageProcessor
  LLM 生成 JSON 消息            (分帧 + metadata)             | 校验/分发
  校验 + 纠错重试                                            v
  (失败降级为纯文本)                                     SurfaceModel
                                                              | 节点解析
                                                              v
                                                         原生组件渲染
        <--  action (event / functionCall)  <--  transport  <-- 用户交互
```

## 生产集成形态: yukino-agent

一个 AI OnCall 运维助手把 A2UI 落到了生产系统里, 它最有价值的经验是给出了"不依赖任何上层框架"的完整自建链路。渲染端与生成端能力全部内联在应用仓库内: 自定义 catalog、A2uiView 渲染器、四种推理格式的 prompt 生成器都可独立使用, 不引入外部 A2UI 组件包。

```text
生成侧 (服务端)                              消费侧 (客户端)
---------------                              ---------------
system prompt 内嵌协议 schema + catalog 契约    A2uiView 接收 unknown[] 消息
   + 由 builder 生成的 few-shot 示例
        |                                            |
   LLM 输出 markdown 正文 + <a2ui-json> 块     逐条 safeParse, 丢弃非法消息
        |                                            |
   流式过滤器: 正文即时透传, a2ui 块静默缓冲     MessageProcessor (增量处理)
        |                                            |
   safeParse 校验 -> 失败一次纠错重试 -> 降级      SurfaceModel -> A2uiSurface
        |                                            |
   SSE: message / a2ui / ... 事件              用户交互 -> 带外 action 管线
```

### 渲染端

自定义 catalog 把官方 basic catalog 的 18 个组件用另一套 UI 原语重新实现 (契约与 basic catalog 一致, 只是替换视觉层), 再扩展一批组件, 合计 65 个。组件实现按家族组织; 明确排除不适合作为声明式 Surface 组件的项 (应用骨架、命令式 API、纯 provider)。

渲染器 A2uiView 的输入是 `unknown[]` (未经校验的消息数组), 内部流程是: 逐条按协议 schema 校验, 非法消息丢弃并打日志; 用 catalog 创建 MessageProcessor; 维护已处理条数的计数, 只把新增消息交给处理器——这个增量处理正是支持"原地更新"的基础; 订阅 Surface 的创建与删除同步到 React 状态; 逐个渲染 Surface, 并注入 Markdown 渲染器 (Text 组件的简单 Markdown 支持)。

### 生成端

prompt 生成器移植了服务端 SDK 的四种推理格式 (direct-json、elemental、atom、express), 内嵌协议 schema 与 catalog schema, 对外提供"生成 system prompt / 应用 schema 修饰 / 移除严格校验 / 裁剪 schema"等工具, 无前端依赖。

生产链路采用 direct-json 模式: 模型在 markdown 回复之后追加一个 `<a2ui-json>[...]</a2ui-json>` 标签块, 与文本共用同一输出通道。这个选择的好处是正文天然存在——降级时交互增强失效但文字回答仍在。prompt 内嵌完整 schema 契约与由 builder 函数生成的 few-shot 示例 (告警列表、指标报告、静默表单); builder 化的意义是改 UI 结构只需改 builder, prompt 自动同步。

流式路径用一个有状态过滤器: 普通文本即时透传 (只扣留可能是标签前缀的尾部, 处理跨 chunk 切分), a2ui 块静默缓冲直到闭合标签, 完整块经校验后作为独立事件下发。流末尾未闭合的块被还原为纯文本而不是静默丢弃, 既不泄漏原始 JSON 也不吞掉用户可见内容。

### 动作回传与原地更新

这是该集成最有特色的部分: Surface 内的动作不走聊天消息流。用户点击按钮后, 客户端把动作载荷连同该 Surface 当前完整的消息列表 (即它的权威状态) 发给一个独立的动作端点; 服务端用较快的模型生成针对同一 Surface 的增量消息, 过滤掉任何 `createSurface`, 只保留 `updateComponents` / `updateDataModel`; 客户端把返回的增量追加到原消息的消息列表, 渲染器增量应用, 在原位更新 (例如表单提交后在原卡片内显示状态行)。

更新不产生新的对话气泡, 交互体验收敛在 Surface 内部。这里有一个必须的防御: 回传的增量里若混入 `createSurface`, 客户端处理器会因"Surface 已存在"丢弃整批消息, 因此服务端下发前必须过滤。

AI Ops 管线 (一个 plan-execute-replan 图) 在报告完成后追加一次"UI 化"后处理: 用系统提示词把报告渲染成一个 Surface, surface 失败绝不影响报告本身。

### 落地时的工程约束

| 约束                  | 原因与做法                                                                                                                           |
| :-------------------- | :----------------------------------------------------------------------------------------------------------------------------------- |
| 校验库版本隔离        | Core SDK 内置一份 zod v3, 应用层的 zod v4 不得与其 schema 组合; 应用边界一律用 `unknown[]` 承载, 渲染时才逐条校验                    |
| 状态存储与 StrictMode | MessageProcessor 是有状态外部存储, 开发态严格模式的双执行会重放已创建的 Surface, 需要关闭严格模式或妥善处理                          |
| catalogId 两端一致    | 服务端 prompt 里的 catalogId 与客户端注册的 catalogId 必须相同, 否则渲染器抛"Catalog not found"; 同一 catalogId 的两份载体改动需同步 |
| 增量消息过滤          | 动作回传的增量中杂散 `createSurface` 会导致整批消息被丢弃, 服务端必须先过滤                                                          |
| 生成必有失败率        | LLM 生成的块天然存在格式错误概率, 必须有校验 + 有限次纠错 + 诚实降级的完整兜底                                                       |
| 流式事件发布          | 状态图节点发布自定义事件时要用当前版本正确的写入器 API, 旧助手函数可能静默丢失事件                                                   |

## 生成可靠性: 校验、纠错与降级

v0.9 是 prompt-first 设计: schema 嵌入 prompt, 生成后必须校验与修复。标准使用模式是一个三步循环。

1. Prompt: 向模型提供期望 UI 的描述 + 协议 JSON Schema (含 catalog) + 合法示例。
2. Generate: 模型输出 JSON。
3. Validate: 对照 schema 校验; 通过则下发渲染, 失败则把错误回喂模型自纠。

校验失败的标准错误格式让模型能理解并修复:

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "surfaceId": "user_profile_card",
    "path": "/components/0/text",
    "message": "Expected stringOrPath, got integer"
  }
}
```

失败形态可以分成几类: 截断类 (流式中断导致 JSON 不完整或标签未闭合)、语法类 (尾逗号、单引号、未转义换行)、Schema 类 (字段形态错误、组件不在 catalog、未知属性)、引用类 (ComponentId 悬空、数据路径错误)、生命周期类 (缺 `createSurface`、缺 `root`、杂散 `createSurface`、surfaceId 不一致)。其中引用类错误协议本身有内建容忍 (组件可乱序到达、可引用尚不存在的目标, 渲染占位等待补齐); 生命周期类会破坏状态机, 必须由应用层防御。

协议对失败的最小要求是逐条处理、单条原子、`undefined` 优雅处理。超出这个范围的部分属于应用层策略。一个务实的降级阶梯:

| 级别       | 手段                                                        | 需要 LLM   | 触发条件                   | 产物               |
| :--------- | :---------------------------------------------------------- | :--------- | :------------------------- | :----------------- |
| 预防       | prompt 注入 schema 契约 + few-shot 示例                     | 生成侧工程 | 常驻                       | 降低失败率         |
| 解析级修复 | 流式过滤器 + JSON 修复 (补截断、去尾逗号)                   | 否         | JSON 语法错误或截断        | 语法合法的消息数组 |
| 纠错重试   | 关闭工具, 回喂校验错误, 只重试一次                          | 是 (一次)  | 校验失败                   | 通过校验的消息数组 |
| 消息级抢救 | 逐条 (必要时逐组件) 校验, 保留合法消息并重排                | 否         | 重试后仍失败               | 部分合法的消息数组 |
| 数据直出   | 放弃组件树, 把数据模型渲染为 Markdown                       | 否         | 组件树不可修复             | Markdown           |
| 格式转换   | 组件树 + 数据模型确定性转换为 Markdown / 表单 / 低代码 JSON | 否         | 组件树可解析但整体校验失败 | 等价声明式 UI      |
| 诚实降级   | 提示 + 保留纯文本正文                                       | 否         | 全部失败                   | 纯文本回答         |

几条原则贯穿这个阶梯: 永不崩溃、永不渲染非法状态 (客户端逐条校验丢弃是最后一道闸); 语义保真度逐级下降, 安全性绝不下降 (任何降级目标仍是纯声明式数据, 不引入代码执行面); 保数据优先于保结构 (数据模型与正文往往独立合法); 确定性转换优先于 LLM 修复, LLM 修复优先于放弃; 降级必须对用户可见, 绝不伪造 UI 数据。

其中"消息级抢救"与协议的最小要求直接对齐: 从"整批成败"切换到"逐条成败"。确定性转换是比纠错更省成本的一档——例如把 A2UI 组件树与数据模型转换为 Markdown (标题、段落、图片、列表、表格都有直接对应), 或转换为 JSON Schema 表单 (输入组件映射到字段类型, 校验函数映射到 schema 关键字)。低代码 JSON 的转换也能做, 但必须维护封闭的映射白名单, 严禁生成表达式或自定义函数类字段, 否则从模型产出的数据会借转换器获得代码执行通道, 击穿白名单安全模型。

## 与其他声明式方案的对比

把 A2UI 放到"UI 即数据、由统一渲染器解释"的同一思想谱系里, 与两类成熟方案对比会更清楚。这里的 Schema-driven UI 指用 JSON Schema 描述数据与字段约束、由通用渲染器生成表单的方案 (代表如 JSON Schema 表单类库); 低代码指人在可视化编辑器中搭建、平台产出专有 DSL 并在运行时渲染完整应用的平台。

| 维度        | A2UI                                                 | Schema-driven UI             | 低代码                       |
| :---------- | :--------------------------------------------------- | :--------------------------- | :--------------------------- |
| UI 描述作者 | LLM/Agent, 运行时按请求生成                          | 开发者或后端接口, 设计时产出 | 人在编辑器中搭建             |
| 组件契约    | catalog (catalogId + 组件 schema + 函数表), 支持协商 | 渲染器内置控件集             | 平台物料库                   |
| 结构与数据  | 彻底分离 (组件树 + 数据模型两类消息)                 | 分离 (schema + formData)     | 通常混合                     |
| 更新模型    | 流式增量消息, 支持渐进渲染与乱序到达                 | 整份 schema 一次渲染         | 运行时整体渲染               |
| 逻辑表达    | 仅 catalog 函数 + 声明式 action, 无代码执行面        | 限于数据约束                 | 强 (事件编排, 常有自定义 JS) |
| 信任假设    | Agent 可能不可信, 白名单渲染                         | schema 由可信方产出          | DSL 由平台内可信用户产出     |
| 可校验性    | 全量 schema 校验 + 纠错闭环                          | schema 原生校验              | 编辑器内校验                 |
| 表达范围    | 对话内卡片/表单/图表                                 | 以表单为核心                 | 完整应用                     |

三条结论。第一, 生成时机决定工程形态: 低代码与 Schema-driven 的描述是设计时产物, 可反复调试缓存; A2UI 的消息是运行时产物, 天然带模型错误率, 必须配套校验与降级。第二, 信任边界决定逻辑表达上限: 低代码敢于提供自定义 JS, 因为 DSL 由可信用户产出; A2UI 显式假设 Agent 可能不可信, 协议层面不提供任何代码执行通道, 逻辑被收紧为 catalog 函数与声明式 action。第三, 更新模型为流式而生: 扁平邻接表、乱序可达、root 缓冲、模板绑定, 全部服务于"模型边生成边渲染"。

反过来看, 若把 A2UI 的消息一次性发全, 它的形态与一份低代码页面配置已很接近; 本质区别是数据模型独立成消息、所有动态值都有字面量 / 路径绑定 / 函数调用三种形态。理解这一点, 就能判断在什么场景该用谁。

## 安全模型小结

安全是协议的一等原则, 它由几条相互独立的机制共同保证。

- 声明式数据而非代码: Agent 只能请求渲染 catalog 内组件, 客户端永远不执行 Agent 下发的代码。`functionCall` 是 Agent 与渲染环境交互的唯一通道。
- catalog 白名单: 生产应用通常自定义 catalog, 把 Agent 限制在自己的设计系统内。
- 定向投递: 开启 `sendDataModel` 时, UI 状态只回传给创建该 Surface 的服务端。
- 身份归属防伪: 编排者负责校验或覆写 `iconUrl` 与 `agentDisplayName`, 防止冒充。
- 自定义组件的隔离责任: 接入第三方内容 (如 iframe) 时, 由组件自身实施沙箱与信任策略; 承载不受信 HTML 的参考做法是双 iframe 隔离, 内层沙箱为 `allow-scripts allow-forms allow-popups allow-modals`, 不含 `allow-same-origin` 与 `allow-top-navigation`。
- 校验在执行边界完成: 校验类逻辑用 catalog 函数声明并在客户端本地执行, 不依赖 Agent 自觉。

## 适用场景与选型建议

适合 A2UI 的场景:

- Agent 需要在对话内动态生成结构化交互界面 (卡片、列表、表单、图表), 且组件集可由 catalog 覆盖。
- UI 由远程或第三方 Agent 产出, 需要跨信任边界安全渲染, 不希望执行对方下发的代码。
- 需要跨端渲染同一份 UI 描述 (Web / 移动 / 桌面), 或要求 UI 与宿主设计系统完全一致。
- 生成链路需要可校验、可纠错、可降级, 且有会话/流式体验要求。

不适合的场景:

- 需要承载任意 Web 应用或重型可视化库 (地图、3D、PDF 阅读器) ——超出 catalog 表达能力, 更适合 MCP Apps 这类代码沙箱路线, 取舍见 [MCP Apps](mcp-app)。
- 界面结构固定、由开发者设计时产出——用 Schema-driven UI 或低代码更省成本。
- 只需要一张静态图片或一段富文本——普通消息即可。

落地时的最小闭环是: 一份明确的 catalog (作为客户端与服务端的共同契约)、一个把 catalog schema 编进 prompt 的生成器、一次校验加一次纠错、一条诚实降级路径, 以及一个支持增量应用与动作回传的渲染器。若还需要降低生成成本, 可以进一步用 [A2UI Express DSL](a2ui-express) 压缩模型输出。
