---
title: "A2UI 声明式 UI 协议"
description: "A2UI 声明式 UI 协议的机制与工程实现: 消息信封与 Catalog 契约、数据绑定与事件回传语义、v0.9.1 生产版与 v1.0 候选版的差异、basic/MCP/VegaChart 三份官方 catalog、多语言 SDK 与渲染器能力面、A2A 集成, 以及仓库内示例链路。"
local_path: "$HOME/Downloads/a2ui"
---

本文讲 A2UI 协议本身: 它为什么存在、用什么样的消息与契约让模型生成 UI、渲染器如何消费并回传交互、跨语言 SDK 各自覆盖哪些能力、如何接入 A2A 与 MCP 等传输层。全部事实以仓库当前代码与规范为准 (规范目录 `specification/`、catalog 目录 `catalogs/`、各语言 SDK、`conformance/` 一致性套件与 `samples/` 示例)。读完之后应当能判断一个功能适合不适合用 A2UI 实现, 以及落地时需要补哪些工程环节。

## 协议要解决的问题

生成式模型擅长产出文本与代码, 但要让 Agent 向用户呈现富交互界面很困难, 尤其是远程 Agent、或跨越信任边界的 Agent——编排器把一个任务委托给第三方 Agent, 后者要往主聊天窗口里渲染一块 UI。

两条常见的替代路线都有硬伤。其一是让 Agent 生成 HTML/CSS/JS 并由客户端执行: 模型产出的脚本属于不可信代码, 直接执行意味着任意脚本执行的风险, iframe 隔离又带来样式割裂与通信开销。其二是让模型直接生成目标框架的组件源码: 既无法在运行时安全执行, 又与客户端技术栈强耦合, 无法跨端复用。

A2UI 的取向是让 Agent "说一种 UI 语言": Agent 不产出代码, 而是产出一段声明式 JSON, 描述 UI 的结构 (组件树) 与数据 (数据模型); 客户端用自身原生组件库渲染这段描述, 并把用户交互回传给 Agent。官方对它的概括是 **safe like data, but expressive like code**——像数据一样安全, 像代码一样有表现力。

仓库 README 给出四条设计哲学, 它们决定了后续全部机制:

| 哲学                     | 含义                                                                                  | 对应机制                                       |
| :----------------------- | :------------------------------------------------------------------------------------ | :--------------------------------------------- |
| Security first           | Agent 只能请求渲染客户端 "catalog" 中预批准的可信组件, 客户端不执行任何 Agent 代码    | Catalog 白名单 + 按名引用的函数 (FunctionCall) |
| LLM-friendly、可增量更新 | UI 是带 ID 引用的扁平组件列表, 便于 LLM 增量生成与渐进渲染                            | 邻接表 + JSON Pointer 数据绑定 + 流式增量消息  |
| 框架无关、可移植         | 结构描述与实现分离, 同一份 payload 可映射到任意框架的原生组件                         | 传输契约 + 多语言 Core SDK + 框架适配层        |
| Flexibility (开放注册)   | 开发者可把任意自有组件 (含安全 iframe 容器) 注册为 "Smart Wrapper" 接入绑定与事件系统 | 自定义 catalog + 组件实现注册                  |

与传统方式对比:

| 维度       | Agent 生成 HTML/JS     | Agent 生成框架代码 | A2UI                        |
| :--------- | :--------------------- | :----------------- | :-------------------------- |
| UI 载体    | 可执行文档             | 可执行源码         | 声明式 JSON                 |
| 执行面     | 有 (需沙箱)            | 有                 | 无 (只渲染白名单组件)       |
| 样式一致性 | 与宿主隔离, 需手工对齐 | 与宿主一致         | 原生继承宿主设计系统        |
| 跨端复用   | 仅 Web                 | 与框架绑定         | 同一份 payload 多端渲染     |
| 增量更新   | 整文档替换             | 重新构建           | 改数据不必重发结构          |
| 生成前校验 | 无法校验               | 无法校验           | JSON Schema 全量校验 + 纠错 |

README 列出的典型场景有三类: 动态数据采集 (Agent 按对话上下文生成表单、日期选择、滑块)、远程子 Agent (编排器委托专业 Agent 返回 UI payload 渲染进主窗口)、自适应工作流 (企业 Agent 动态生成审批面板与数据可视化)。

## 核心概念与消息模型

本节以当前生产版本 v0.9.1 为准 (消息形态、字段与语义均按 `specification/v0_9_1/` 规范); v1.0 候选版的差异在 "版本族" 之后单独展开。

五个概念贯穿整个协议:

| 概念       | 说明                                                                                  |
| :--------- | :------------------------------------------------------------------------------------ |
| Surface    | 一块独立的 UI 区域, 由 `surfaceId` 标识, 拥有独立的组件树与数据模型                   |
| Component  | 组件, 以扁平列表 + ID 引用 (邻接表) 表达父子关系, 必须存在 id 为 `root` 的根组件      |
| Data Model | 每个 Surface 一份 JSON 数据模型, 组件通过 JSON Pointer 路径绑定其中的数据             |
| Catalog    | 客户端的可信组件/函数目录, 由 `catalogId` 标识, Agent 只能使用 Catalog 内的组件与函数 |
| Message    | 一条 JSON 对象, 恰好包含一个消息类型的信封键, 且携带 `version` 字段                   |

服务端 (Agent) 到客户端 (Renderer) 的消息有四类:

| 消息               | 作用                                                                          |
| :----------------- | :---------------------------------------------------------------------------- |
| `createSurface`    | 创建 Surface, 绑定 `surfaceId` + `catalogId`, 可选 `theme` 与 `sendDataModel` |
| `updateComponents` | 新增或更新 Surface 内的组件 (扁平列表)                                        |
| `updateDataModel`  | 按 JSON Pointer 路径 upsert 数据模型                                          |
| `deleteSurface`    | 删除 Surface 及其全部组件和数据                                               |

客户端到服务端的消息有两类:

| 消息     | 作用                                                                                    |
| :------- | :-------------------------------------------------------------------------------------- |
| `action` | 用户交互事件, 必填 `name` / `surfaceId` / `sourceComponentId` / `timestamp` / `context` |
| `error`  | 客户端错误上报, 如 `VALIDATION_FAILED` (携带 `path` 与 `message`) 或通用错误            |

`createSurface` 有几个容易被忽略的约束: `surfaceId` 与 `catalogId` 创建后不可变, 要换配置必须删除重建; 对已存在的 `surfaceId` 重复 `createSurface` 是错误; 组件列表中必须恰好有一个 id 为 `root` 的组件作为树根, `root` 未到达前, 其他组件更新被缓冲, 不产生可见效果。

`catalogId` 是用于两端匹配的字符串标识而非可解析的资源地址。约定以 URI 形态书写以避免跨组织命名冲突, 但不要求指向任何真实可下载的文件; 客户端与服务端必须就使用哪些 well-known 的 catalogId 达成一致。catalog 本身是 JSON Schema 文档, 规范建议同时携带 `$id` (给 JSON Schema 工具链) 与 `catalogId` (给 A2UI SDK 与协商), 且两者取同一个 URI。官方 basic catalog 即如此: v0.9 与 v0.9.1 共用同一份文件, `$id` 与 `catalogId` 同为 `https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json`; v1.0 版则是 `https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json`。

### 传输契约

A2UI 传输无关, 但任何传输层承担 A2UI 时必须满足四条契约 (v0.9.1 协议文档 "The transport contract"):

1. 可靠有序投递: A2UI 是有状态更新 (先 `createSurface` 才能 `updateComponents`), 乱序会破坏 UI 状态。
2. 消息分帧: 需要清晰的消息分界 (JSONL 换行、WebSocket 帧、SSE 事件)。
3. metadata 支持: 承载 `sendDataModel` 的数据模型回传, 以及能力交换 (客户端 capabilities 与服务端 capabilities, 或 A2A Agent Card 之类的握手)。
4. 双向通道 (可选): 渲染流是单向的, 交互应用需要 `action` 的返回通道。

规范列举的传输绑定包括: A2A (消息映射为 DataPart, `a2uiClientCapabilities` 与 `a2uiClientDataModel` 放 message metadata, Surface 会话映射到 `contextId`)、AG-UI、MCP (作为工具输出或资源订阅)、SSE + JSON-RPC、WebSocket、REST。v1.0 规范把 AG-UI 称为 "Agent-to-User Interaction 的标准传输绑定", 把 A2A 收敛为独立的扩展规范 (`specification/v1_0/extensions/a2a/`), 并补充了 MCP 绑定: A2UI 可经 MCP 工具调用、工具输出或资源订阅承载。v1.0 还显式定义了两种传输交互模式: 请求-响应 (如 HTTP POST) 与双向流 (如 WebSocket/gRPC), 函数 RPC 在两种模式下各有对应的时序。

### 版本族

协议按族演进, 各版本规范目录的自述声明了状态:

| 版本族 | 状态                                   | 取向与关键差异                                                                                                  |
| :----- | :------------------------------------- | :-------------------------------------------------------------------------------------------------------------- |
| v0.8   | closed, 不再活跃开发 (目录自述 v0.8.2) | 面向支持结构化输出的模型; 消息动作键为 `beginRendering` / `surfaceUpdate` / `dataModelUpdate` / `deleteSurface` |
| v0.9   | stable, closed                         | prompt-first 协议族首个版本: schema 直接嵌进 prompt 让模型仿写; `createSurface` + `updateDataModel` upsert 语义 |
| v0.9.1 | 当前生产版本, closed                   | v0.9 族的 patch 版本, 与 v0.9 共享消息形态与组件 schema (basic catalog 两份文件完全一致)                        |
| v1.0   | 候选 (candidate, 曾名 v0.10 草案)      | 双向函数 RPC、单消息建 Surface、多 catalog 混用、`@` 前缀指令、去 theme 化; 对候选版接受破坏性变更的门槛很高    |

v0.8 与 v0.9 的核心分野是生成方式: v0.8 假设模型受结构化输出格式约束; v0.9 把 schema 嵌进 prompt, 换来更丰富可读的 catalog 结构, 代价是生成结果必须经过校验与修复 (见 "生成可靠性" 一节)。

SDK 按消息的 `version` 字段分流各版本。Python Core 的版本适配器工厂 (`a2ui.core.processing.adapters`) 注册了 v0.8 / v0.9 / v0.9.1 / v1.0 四个适配器 (v0.9.1 复用 `V0Point9Adapter`), 支持 `register_adapter` 动态注册自定义适配器; `resolve_from_payload` 先看 `version` 字段, 无 version 但携带 v0.8 动作键 (`beginRendering` / `surfaceUpdate` / `dataModelUpdate` / `deleteSurface`) 的消息识别为 v0.8, 两者皆无则抛 `A2uiValidationError` 而不是默认到某版本。TypeScript 的 `@a2ui/web_core` 则以版本子路径并存 (`./v0_8` / `./v0_9` / `./v1_0`), 渲染器按所用协议版本选择入口。

### v1.0 候选版的关键变化

v1.0 已有完整规范 (协议、JSON Schema、A2A 扩展、basic catalog) 与多语言适配器, 相对 v0.9.1 的变化集中在七个方面 (依据 `specification/v1_0/docs/a2ui_protocol.md` 与 `evolution_guide.md`)。

**1. 双向函数 RPC。** agent 到 renderer 的消息从四类扩为六类: 增加 `callRendererFunction` 与 `agentFunctionResponse`; renderer 到 agent 增加 `callAgentFunction` 与 `rendererFunctionResponse`。执行边界由 catalog 声明并在运行时强制: 函数定义携带 `allowedCallers` (`rendererOnly` / `agentOnly` / `rendererOrAgent`, 缺省 `rendererOnly`) 与 `requiresUserActivation` (缺省 false)。渲染器收到远程调用时按 catalog 配置校验——函数配置为 `rendererOnly`、需要用户手势却无手势、参数不合 schema 或未注册, 一律以 `INVALID_FUNCTION_CALL` 拒绝; `requiresUserActivation: true` 的函数出现在被动属性绑定或 `CheckRule.condition` 中时, 渲染器阻止执行并报 `EXPRESSION_ERROR`; `@index` 在列表模板之外求值报 `EXECUTION_ERROR`; 对已存在 `surfaceId` 重复建 Surface 报 `INTEGRITY_ERROR`。`callRendererFunction` 必须携带 `functionCallId`, 且 `callFunction` 内的 `catalogId` 必填; 可选携带 `surfaceId`——指定时 `args` 里的 `@path` 绑定在该 Surface 数据模型的根作用域求值 (Surface 不存在时拒绝), 省略时在空数据模型的 surface 无关根上下文执行。无论返回类型是否为 void, 渲染器都必须回 `rendererFunctionResponse` (携带同一个 `functionCallId` 与 `value` 或 `error`)。信封按到达顺序分发: 排在一个 RPC 信封之前的同步 Surface 变更先生效, 而 RPC 的异步执行不阻塞后续信封。`allowedCallers` 与 `returnType` 只存在于 catalog 函数定义, 不允许出现在 wire 层的 `FunctionCall` 载荷里——边界检查与返回类型校验完全交给运行时。basic catalog 的 `openUrl` 标注 `requiresUserActivation: true`。

**2. 单消息建 Surface 与 Surface 容器。** `createSurface` 可直接内嵌 `components` 与 `dataModel` (以及 `metadata.extensions`), 一条消息完成整块 UI 的组合; `catalogId` 变为可选, 仅作为该 Surface 的缺省 catalog。`createSurface` 会隐式实例化规范的 `Surface` 容器组件 (`common_types.json#/$defs/Surface`), 恒定持有 `"child": "root"`, 不能被 `updateComponents` 修改。`surfaceId` 必须在渲染器整个生命周期内全局唯一, 编排器负责给子 Agent 的 surfaceId 加前缀或要求其用 UUID 以避免冲突。

**3. 多 catalog 混用与解析顺序。** 组件与函数调用可各自携带 `catalogId`, 一个 Surface 内可混合多个 catalog 的组件与函数 (混用的 catalog 必须同属一个协议版本)。解析顺序是: 组件/调用自身的 `catalogId` → Surface 缺省 `catalogId` → 两者皆无则报错不渲染, 不回退到能力声明里的 catalog; 一个 Surface 可用的 catalog 包括 `supportedCatalogIds` 与协商通过的 `inlineCatalogs`。catalog 之间可通过 `$ref` 复用本地已持有的 peer catalog 定义 (按 `catalogId`、`$id` 或文件名匹配), 不要求网络可达。catalog 定义新增 `protocolVersion` 字段 (缺省按 `"0.9"` 兼容处理, 目标 1.0 及以上的 catalog 必须显式声明)、可选 `instructions` 字段 (把设计指南直接嵌进 catalog, 取代外置 rules 文件), 组件定义还可声明 `allowedParents` / `allowedChildren` 组合约束——以 `"Surface"` 为规范根组件类型, 该名字被协议保留 (`components` 映射在 schema 层禁止使用), 违反时渲染器报 `UNALLOWED_PARENT` / `UNALLOWED_CHILD` 错误。

**4. `@` 前缀指令。** 动态值指令改用 `@` 前缀: 数据绑定 `{"@path": "/x"}`, 函数调用 `{"@call": "f", "args": {...}}`。`@` 前缀保留给协议的系统级上下文求值, 自定义 catalog 不得定义 `@` 开头的函数名; 内置 `@index` 系统函数返回模板迭代的 0 基索引, 接受可选 `offset` 参数, 且只允许在列表模板的 Collection Scope 内求值。普通对象中的 `path` / `call` 键从此是字面量数据, 不再被截获为指令; 动态对象里未识别的单 `@` 键会被拒绝, 字面 `@` 开头的键用前缀双写转义 (`"@@path"` 表示字面 `"@path"`, `"@@"` 表示字面 `"@"`)。ChildList 模板对象的 `path` 与 `updateDataModel` 信封的 `path` 是消息参数而非绑定, 保持不带前缀。

**5. 去 theme 化与命名规范。** catalog 与 `createSurface` 上的 `theme` (含 `primaryColor`) 被整体移除, 视觉品牌交给目标框架的原生主题; v0.9.1 中承载 Agent 身份归属的 `iconUrl` / `agentDisplayName` 也随之离开协议层。所有 catalog 实体名 (组件名、函数名、参数键) 必须符合 Unicode UAX #31 标识符规则; `ComponentCommon`、`createSurface`、catalog 的 `ComponentDefinition` 与 `action` 支持扩展元数据 (`$defs/Extensions`, UAX #31 键, 保留 `a2ui_` 命名空间)。术语全局改名: client → renderer、server → agent, schema 文件随之更名 (`agent_to_renderer.json` / `renderer_to_agent.json` / `renderer_capabilities.json` / `agent_capabilities.json` / `renderer_data_model.json` 及对应的 list / list wrapper 文件)。

**6. 其余语义收紧。** `updateDataModel` 的 `value` 变为必填, 删除键要显式写 `null` (v0.9 族的 "省略 value 即删除" 不再合法); `CheckRule` 支持函数或数据绑定直接返回动态 `ValidationResult` 对象 (`valid` / `code` / `message` / `severity`, 允许附加自定义扩展键), 布尔值会被强制为 `ValidationResult`, 反向地 `DynamicBoolean` 把 `ValidationResult` 强制为其 `valid` 布尔; 标准校验函数 (`required` / `regex` / `length` / `numeric` / `email`) 的 returnType 从 boolean 改为 `validationResult`, `CheckRule.message` 退化为可选兜底文案; catalog 的 `functions` 定型为函数名到定义的对象映射, catalog 对象允许携带标准 JSON Schema 元数据 (`$schema` / `$id` / `title` / `description`); `ComponentCommon` 统一挂载 `AccessibilityAttributes` (WAI-ARIA `label` / `description` / `live` 区域 `"off"|"polite"|"assertive"` / `hidden`), 并要求 catalog 与渲染器实现贯通无障碍属性; basic catalog 增补 `Video.posterUrl`、`TextField.placeholder` (同时移除 `TextField.validationRegexp`, 改用 `regex` 校验函数)、`Slider.steps` 等可选属性, 对标准类型的 `$ref` 改为不带版本号的相对路径 (`common_types.json#/$defs/...`)。

**7. 函数调用的多态执行与 userMessage。** 组件属性绑定、校验规则与 action 里的函数调用语法完全一致, 渲染器按 catalog 解析结果决定本地执行还是发出 `callAgentFunction` 走远程; `action.event` 新增可选 `userMessage` (`DynamicString`, 由渲染器解析后放进出站 `action` 消息, 描述用户做了什么), 出站 `action` 还可携带 `metadata.extensions`。

迁移时最危险的坑是 "全局替换 `path` → `@path`": evolution guide 明确警告, 只有处于 DynamicValue 位置的绑定与调用才加前缀, ChildList 模板、`updateDataModel` 信封参数、以及普通数据里恰好叫 `call` 的键 (如 basic catalog `Icon` 的名字枚举) 都必须原样保留。

### 一个最小消息序列

以下是一个联系人表单的完整消息流 (JSONL 分帧, 形态取自 v0.9.1 规范的 Example Stream), 展示了四类消息的先后与数据绑定形态:

```jsonc
// 1. 建 Surface, 绑定 catalog
{"version": "v0.9.1", "createSurface": {"surfaceId": "contact_form", "catalogId": "https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json"}}

// 2. 下发组件树 (扁平邻接表): root 引用子组件, 输入组件绑定数据路径
{"version": "v0.9.1", "updateComponents": {"surfaceId": "contact_form", "components": [
  {"id": "root", "component": "Column", "children": ["email_field", "submit_button"]},
  {"id": "email_field", "component": "TextField", "label": "Email", "value": {"path": "/contact/email"}, "checks": [{"call": "email", "args": {"value": {"path": "/contact/email"}}, "message": "Please enter a valid email address."}]},
  {"id": "submit_button", "component": "Button", "child": "submit_label", "action": {"event": {"name": "submit_form", "context": {"email": {"path": "/contact/email"}}}}},
  {"id": "submit_label", "component": "Text", "text": "Send"}
]}}

// 3. 填充数据模型 (结构化初值)
{"version": "v0.9.1", "updateDataModel": {"surfaceId": "contact_form", "path": "/contact", "value": {"email": "jane@example.com"}}}

// 4. 移除 Surface
{"version": "v0.9.1", "deleteSurface": {"surfaceId": "contact_form"}}
```

用户点击 Send 时, 客户端解析 `/contact/email` 得到当前输入值, 作为 `context` 发出 `action`。若该 Surface 开启了 `sendDataModel`, 客户端还会在每条发往创建者的消息 metadata 里附带该 Surface 的完整数据模型。

### Surface 生命周期规则

- `createSurface` 必须先于该 Surface 的任何 `updateComponents` / `updateDataModel`。
- `surfaceId` 与 `catalogId` 创建后不可变; 对已存在的 surfaceId 重复 `createSurface` 是错误。
- 组件列表中必须恰好有一个 id 为 `root` 的组件; `root` 未到达前, 其他组件更新被缓冲。
- `deleteSurface` 移除 Surface 及其全部组件和数据。

## 组件模型与 Catalog

### 邻接表

组件以扁平列表下发, 树结构靠 ID 引用隐式构建。客户端把所有组件存入一棵以 ID 为键的映射 (如 `Map<String, Component>`), 渲染时重建树。由此带来三个直接能力: 组件可以任意顺序到达; 可以引用尚不存在的子组件或数据路径 (渲染器渲染占位, 等待补齐); `root` 定义后即可开始渲染, 跳过无效引用。

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

组件对象只有 `id` 与 `component` 两个必填字段, 其余属性按各自类型直接平铺在对象上。容器组件用 `children` 或 `child` 引用子组件。`ChildList` 有两种形态: 数组形态是静态的 `ComponentId` 引用列表; 对象形态是列表模板 `{ componentId, path }`, 监听 `path` 指向的数组, 为每个元素实例化模板组件。

### 官方 Catalog

Catalog 是 Agent 与渲染器之间的契约。仓库根的 `catalogs/` 目录存放官方维护的 catalog (catalog 以自身声明的 `$id` 而非仓库路径被识别, 独立于协议版本演进):

```text
catalogs/
├── basic/v1/            # Basic catalog, major v1, 面向 v1.0 协议
├── mcp/                 # MCP catalog
│   ├── catalog.json     # v0.9 形态
│   └── v1/              # v1.0 形态 (含 McpApp 组件)
└── vegachart/           # VegaChart catalog
    ├── v0_9/            # v0.9 形态
    └── v1/              # v1.0 形态
```

v1.0 之前的 basic catalog 留在各自规范目录 (`specification/v0_9/catalogs/basic` 与 `specification/v0_9_1/catalogs/basic`, 两份文件完全一致)。

**Basic catalog** 提供 18 个通用组件与 14 个函数, 刻意保持精简以便各渲染器实现:

| 分类 | 组件                                                             |
| :--- | :--------------------------------------------------------------- |
| 展示 | Text (支持简单 Markdown)、Image、Icon、Video、AudioPlayer        |
| 布局 | Row、Column、List、Card、Tabs、Divider、Modal                    |
| 交互 | Button、CheckBox、TextField、DateTimeInput、ChoicePicker、Slider |

| 分类   | 函数                                                              |
| :----- | :---------------------------------------------------------------- |
| 校验   | required、regex、length、numeric、email                           |
| 格式化 | formatString、formatNumber、formatCurrency、formatDate、pluralize |
| 行为   | openUrl                                                           |
| 逻辑   | and、or、not                                                      |

theme 在 v0.9 族定义在 catalog 的 `$defs/theme`, 支持三个属性: `primaryColor` (主色)、`iconUrl` 与 `agentDisplayName` (Agent 身份归属)。在多 Agent 或编排器场景下, 编排者负责设置或覆写后两个身份字段并校验其与真实 Agent 服务一致, 防止恶意 Agent 冒充可信服务。v1.0 把 theme 连同这三个属性整体移除。

**MCP catalog** 让 Surface 直接调用 MCP 工具并把结果写回数据模型。v0.9 形态 (`catalogs/mcp/catalog.json`, catalogId `https://a2ui.org/specification/v0_9/catalogs/mcp/mcp_catalog.json`) 无组件, 声明六个函数: `callMcpTool` 接受 `name` (DynamicString, 必填) 与 `arguments` (对象, 缺省 `{}`), 返回原始 MCP `CallToolResult`; 客户端无法解析、无结果或结果 `isError: true` 时抛 `A2uiExpressionError`。payload 只携带工具名不携带服务器名, 多服务器路由由宿主在 `getMcpClientForTool` 回调里解析 (TypeScript 实现见 `@a2ui/catalog-mcp`, `typescript/catalogs/mcp`)。另有五个数据变换函数用于把工具结果加工后写回数据模型:

| 函数              | 参数                              | 作用                                                                           |
| :---------------- | :-------------------------------- | :----------------------------------------------------------------------------- |
| `jmespath`        | `expression`, `data`              | 对数据求值 JMESPath 表达式, 缺失字段返回 `null`                                |
| `split`           | `value`, `separator`              | 按分隔符切分字符串或字符串数组                                                 |
| `regexCapture`    | `value`, `pattern`                | 取首个 RE2 匹配的捕获组, 无匹配返回 `null`                                     |
| `regexReplace`    | `value`, `pattern`, `replacement` | 把所有 RE2 匹配替换为字面文本                                                  |
| `updateDataModel` | `updates`                         | 把键值对写入 Surface 数据模型 (`/` 开头为绝对路径, 相对键按当前数据上下文解析) |

v1.0 形态 (`catalogs/mcp/v1/catalog.json`, catalogId `https://a2ui.org/specification/v1_0/catalogs/mcp/catalog.json`, 声明 `protocolVersion: "1.0"`) 保留 `callMcpTool` 并新增 `McpApp` 组件: 在 Surface 内渲染一个沙箱化的第三方 MCP App。`McpApp` 的属性包括 `htmlContent` (必填, `url_encoded:` 前缀的值会先解码, 经 `srcdoc` 渲染)、`title`、`allowedTools` (app 可调用的 MCP 工具白名单)、`allowedFunctions` (app 可通过 `ui/requests/function-call` 调用的 catalog 函数及其参数 schema)、`data.paths` (状态键到数据模型 JSON Pointer 的映射, 含保留键 `toolInput` / `toolResult` / `modelContext`, 宿主与 app 双向同步)、`csp` 与 `permissions` (来自 `_meta.ui` 的资源域白名单与摄像头等权限委托)。未列入白名单的工具调用与函数调用以 JSON-RPC 错误拒绝。双 iframe 沙箱代理由 `typescript/catalogs/shared/sandbox/` 实现: 外层是代理页, 不带 `sandbox` 属性, 靠 `document.referrer` 与 origin 检查确认嵌入者身份并中继消息; 内层承载不可信内容, 默认沙箱位为 `allow-scripts allow-forms allow-modals` (`DEFAULT_INNER_SANDBOX`), 刻意不含 `allow-same-origin` (隔离存储与 origin)、`allow-popups` (防一键链接外泄)、`allow-top-navigation` 系列 (防顶层窗口劫持)。代理页默认由宿主同源提供 (`/a2ui-sandbox/`), 生产环境建议用 `configureSandbox({baseUrl})` 指向专用 origin; 跨帧 payload 还有结构化校验 (原型污染键、嵌套深度、序列化大小)。完整安全约束见 `catalogs/mcp/v1/mcp_app_specification.md`。

**VegaChart catalog** 渲染 Vega / Vega-Lite 图表。v0.9 形态 (`catalogs/vegachart/v0_9/`) 与 v1 形态 (`catalogs/vegachart/v1/`, 声明 `protocolVersion: "1.0"`) 都只声明一个 `VegaChart` 组件: `spec` (DynamicValue, 必填, 接收 Vega-Lite/Vega spec 对象或数据绑定) 与 `height` (DynamicNumber, 缺省 290 像素)。TypeScript 包为 `@a2ui/catalog-vegachart`。

### Catalog 扩展

有两种扩展面: 约束 Agent 的组件集合, 以及给 Agent 增加新的客户端函数。

自定义 catalog 与 basic catalog 同构。为了让校验器能检查父子引用完整性, 任何持有子组件 ID 的属性必须使用 `common_types.json` 中的 `ComponentId` 类型 (`$ref`), 不能写成裸 string; 任何持有子列表或模板的属性必须使用 `ChildList` 类型。校验器正是靠这两个 `$ref` 识别哪些字段是结构链接——写成裸 string 会被当作静态文本, 不再检查目标组件是否存在。

自定义函数在 catalog 的 `functions` 中声明函数 schema (`call` 为 const、`args` 逐项引用 `Dynamic*` 类型), 并在 `$defs/anyFunction` 的 `oneOf` 中登记; 校验器按 `call` 值做判别式查找, 命中的函数按其规则校验 `args`, 未登记的 `call` 直接失败。内置函数可以通过 `$ref` 引回 basic catalog 的 `anyFunction` 与自定义函数合并。v1.0 中函数定义还可声明 `allowedCallers` / `requiresUserActivation` / `returnType` 等执行边界元数据, 由运行时读取。

### 能力协商

客户端支持哪些 catalog 通过两种方式告诉服务端:

- pre-shared catalog: 客户端只声明 `supportedCatalogIds` 字符串列表, 服务端预先已知这些 catalog 的内容。
- inline catalog: 客户端把组件的完整 JSON Schema 内联进能力对象发送给服务端, 服务端据此注入 prompt。服务端是否接受由 AgentCard 中 `acceptsInlineCatalogs` 声明, 缺省 false。

能力对象按协议版本分组: v0.9/v0.9.1 渲染器发 `{"v0.9": {"supportedCatalogIds": [...], "inlineCatalogs": [...]}}` (v0.9.1 复用 `v0.9` 键, 两个版本的 `client_capabilities.json` 都只定义 `v0.9` 这一个顶层键); v1.0 渲染器发 `{"v1.0": {...}}` (`renderer_capabilities.json`); v0.8 规范是唯一的例外, 能力对象本身就是 `{"supportedCatalogIds": [...]}` 不带版本键, Python 的 `resolve_catalogs` 同时接受裸形态与 `"v0.8"` 键形态。仓库内各 sample 客户端按版本键发送自己渲染器真实注册的 catalog——Lit shell 直接调 `MessageProcessor.getRendererCapabilities({versions: ['v0.9']})` 拿所渲染 catalog 的能力。

## 数据模型、绑定与更新

### 路径与作用域

数据绑定基于 JSON Pointer (RFC 6901), 并扩展支持相对路径:

- 以 `/` 开头的绝对路径始终从 Data Model 根解析, 与组件在树中的位置无关。
- 不以 `/` 开头的相对路径只在 ChildList 模板创建的子作用域内有效, 解析到当前迭代项。例如遍历 `/users` 的模板中, 相对路径 `firstName` 在第一项解析为 `/users/0/firstName`。
- 在数组段的路径段上使用非数字索引是错误。
- 模板内部仍可用绝对路径访问根作用域。

渐进渲染期间路径可能解析为 `undefined`, 渲染器应优雅处理 (空串或 loading 占位)。非字符串值插值时的类型转换规则: 数字/布尔转标准字符串表示; null/undefined 转空串; 对象/数组转 JSON 字符串, 以保证跨语言实现一致。

### 数据模型更新

`updateDataModel` 采用严格的 upsert 语义:

- 路径存在则更新, 不存在则创建。
- v0.9 族: 省略 `value` (或置为 `undefined`) 则删除该键; 数组场景下把对应索引置为 `undefined` 以保持长度。
- v1.0: `value` 必填, 删除键要显式写 `null`, 省略 `value` 是 schema 校验错误。
- 省略 `path` (或为 `/`) 则替换整个数据模型。

### 双向绑定与回传

输入组件 (TextField、CheckBox、Slider、ChoicePicker、DateTimeInput) 与数据模型建立双向绑定:

- 读 (Model → View): 渲染时从绑定路径读值; 服务端更新数据模型后组件自动重渲染。
- 写 (View → Model): 用户输入立即写回本地数据模型, 绑定同一路径的其他组件实时联动。
- 本地数据模型是唯一数据源; 键入等被动变化不触发网络请求。

状态回传只在 `action` 触发时发生: 通过 `action.context` 引用数据路径, 或对 Surface 开启 `sendDataModel`——开启后客户端在每次发给创建该 Surface 的服务的消息 metadata 里附带该 Surface 完整数据模型 (payload 遵循 `client_data_model.json`, v1.0 为 `renderer_data_model.json`)。数据模型只投递给创建者, 不会泄漏给其他 Agent。

## 事件、函数与校验

### action

交互组件通过 `action` 属性声明行为, 二选一:

| 形态           | 语义                                                                                                             | 示例                                                                                    |
| :------------- | :--------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------- |
| `event`        | 触发发往服务端的事件, 携带 `name` 与可选 `context` (v1.0 另有可选 `userMessage`); context 中的动态值在触发时解析 | `{"event": {"name": "submit_form", "context": {"email": {"path": "/formData/email"}}}}` |
| `functionCall` | 在客户端本地执行 catalog 函数, Agent 不会收到本地函数调用的通知                                                  | `{"functionCall": {"call": "openUrl", "args": {"url": {...}}}}`                         |

### 客户端逻辑与校验

v0.9 把客户端逻辑统一抽象为函数 (Function), 按名字引用, 绝不传输可执行代码。函数与组件一起定义在 catalog 中, 客户端运行时从 catalog 定义读取每个函数的执行边界配置。

输入组件可以声明 `checks` 校验列表, 每项是一个条件 (通常为 FunctionCall) 加失败文案, 校验失败时展示对应错误信息; Button 的 `checks` 失败会自动禁用按钮, 因此按钮状态可以依赖数据模型的有效性。v0.9 族校验函数必须返回布尔值; v1.0 改为可返回 `ValidationResult` 对象 (并在需要布尔的 `DynamicBoolean` 位置自动强制为其 `valid` 字段)。

### formatString

`formatString` 是唯一支持内嵌表达式的字符串函数, 语法为 `${...}`:

- `${/user/profile/name}` 绝对路径插值, `${firstName}` 相对路径插值。
- 函数调用以括号识别, 如 `${formatDate(value:${/currentDate}, format:'yyyy-MM-dd')}`, 参数支持字面量与嵌套表达式。
- 要输出字面量 `${`, 需转义为 `\${`。

### 服务端扩展: 可编程组件 (macros)

组件扩展通常意味着客户端要新增渲染实现。Python Agent SDK 提供了另一条路径: 用 `@macro` 装饰器 (`a2ui/transformers/macros/macro.py`) 注册高层布局函数, 模型像写 catalog 组件一样写 macro 组件, 服务端在下发前把它们同步展开为标准原语组件子树, 客户端零改动。

宏的注册读取 Python 函数的签名与类型提示, 把参数类型逐条映射为协议 JSON Schema (Dynamic\* 类型映射 common types 中的同名 `$defs`, 单子槽位映射 `ComponentId`, 组件节点列表映射 `ChildList`, Action/CheckRule 等各映射对应 `$ref`); docstring 被解析为参数描述。展开器 (`expander.py`) 支持宏中嵌套宏的递归展开 (受最大递归深度限制), 处理器 (`processor.py`) 把宏函数返回的节点经 `flatten_component_tree` 扁平化为标准组件子树。

这条通道的价值在于把 "高层语义" 留在服务端: `samples/community/macros` 中的 `EmployeeSalaryCard` 宏只接收标识符, 由服务端 resolver 回调查询内部数据库后注入敏感数值, 敏感数据不进入模型上下文。

## 渲染与事件回传语义

不同语言、不同框架的渲染器差异很大, 但仓库蓝图 (`blueprints/modules/a2ui_core.blueprint.md` 与 `a2ui_framework_adapter.blueprint.md`) 定义了同一套语义分层:

```text
A2UI 消息流 (JSON)
  -> MessageProcessor: 校验、分发、维护 Surface 状态
  -> SurfaceModel: 每个 Surface 的组件模型 + DataModel (可观察状态)
  -> NodeResolver: 把组件模型解析为 ComponentNode 树, 未到达组件生成占位
       - GenericBinder 按 catalog schema 逐属性分类绑定
       - 动态属性成为已解析绑定, action 属性成为可调用闭包
       - child 属性成为活的子节点引用
  -> 框架适配层: 订阅节点树, 分发到各组件实现
  -> 原生组件 (React / Lit / Angular / Flutter / SwiftUI)
```

关键语义:

- **渐进渲染**: 组件可乱序到达、可引用尚不存在的子组件或数据路径, 未到达时渲染占位, 到达后原位替换; `root` 未到达前其余更新被缓冲。
- **属性绑定分类**: Core 的 `GenericBinder` 按组件 schema 把每个属性分类为 dynamic、action、structural 或 checkable, 产出渲染器消费的已绑定属性集, 包括双向 setter 与 action 闭包。这个分类是 schema 驱动的, 新增组件不需要改渲染器内核。
- **细粒度更新**: 节点只在自身已解析属性变化时发出信号, 框架适配层把信号桥接到框架的调度模型 (React 渲染器用 `useSyncExternalStore` 订阅外部存储)。
- **事件回传**: 触发动作闭包时先解析 context 中的数据绑定 (相对路径在当前列表项作用域内解析), 再把事件汇聚发出。本地 `functionCall` 型动作由闭包在本地执行, 不出网; `event` 型动作派发为发往 Agent 的消息。
- **框架适配层契约**: 蓝图要求适配层实现统一的节点分发 (处理未知类型/占位/无实现分支)、`buildChild` 子节点构建、卸载时释放解析器与订阅 (`dispose`)、以及并发渲染下的惰性创建。Dart Core 的动态属性以可写绑定 (`WritableBinding`) 承载, 写入走绑定的 set, 输入组件在自身 widget 状态与绑定值之间同步。

协议本身没有 loading 语义——消息中没有 loading 状态字段。渐进渲染期间的占位完全是渲染器或宿主侧的实现问题: 协议提供的基础是未到达组件渲染占位、`root` 未到达前缓冲、绑定路径解析为 `undefined` 时按空串或 loading 优雅处理。区分 "数据未到" 与 "值确实为空" 需要渲染器自建 settled 信号 (一批消息处理完成、流结束事件, 或窗口内无新消息的超时)。骨架是渲染器本地行为, 不进 catalog, Agent 不能也不需要请求骨架。

## 多语言 SDK 能力面

SDK 生态分为三层 (`specification/*/docs/sdks_spec.md` 的 Unified SDK Architecture):

```text
Framework Adapter (把 Surface 状态渲染为原生 UI)
      | 依赖
      v
A2UI Core SDK (Surface 状态、消息处理、校验、增量快照)
      ^ 依赖
      |
Inference SDK (用 LLM 生成 agent-to-renderer 消息: prompt 构造、解析、纠错重试)
```

Core SDK 提供协议的语言原生表示: 强类型的 Catalog 声明 (`Catalog` / `ComponentApi` / `FunctionApi`) 与消息类型; Surface 状态模型 (`SurfaceModel` / `ComponentModel` / `DataModel`); 处理层 (`MessageProcessor` 求值消息数组、解析相对指针、更新状态); 严格校验 (含 v1.0 的 `AccessibilityAttributes` 检查); 增量快照 (把更新折叠为扁平的节点树)。Inference SDK 负责引导模型按 catalog 生成合法消息。

各语言的能力面 (以仓库当前实现为准):

| 平台       | Core                                                                                                            | Agent/Inference                                                                                                                                                       | 渲染/适配层                                                         |
| :--------- | :-------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------ |
| TypeScript | `@a2ui/web_core` (含 `./v0_8` / `./v0_9` / `./v1_0` / `./universal` / `./rpc` / `./catalogs/basic/v1` 等子路径) | `@a2ui/agent`: 支持 v1.0 / v0.9 / v0.9.1, Direct JSON 与 Express 两种格式                                                                                             | `@a2ui/react`、`@a2ui/lit`、`@a2ui/angular`、`@a2ui/markdown-it`    |
| Python     | `a2ui-core`                                                                                                     | `a2ui-agent-sdk` (macros、builder、skill 生成器; direct_json 与 express 两种格式, 另有 experimental 的 atom / elemental); A2A 与 ADK 集成拆为 `a2ui-a2a` / `a2ui-adk` | 无独立渲染器 (服务端为主)                                           |
| Dart       | `a2ui_core`                                                                                                     | `a2ui_agent` (实现完整蓝图 API, 覆盖 v0.9 与 v1.0, DirectJson / Express 格式); `a2ui_cli` 代码生成工具                                                                | `a2ui_flutter`: Flutter 框架适配层, 内置 basic catalog 全套组件实现 |
| Swift      | `A2UICore` (+ `A2UIJSON` schema 层, v0.9.1/v1.0)                                                                | —                                                                                                                                                                     | `A2UISwiftUI` 适配层 + `BasicCatalogSwiftUI` 组件实现               |
| Kotlin     | —                                                                                                               | 仅存 `agent_sdk_legacy`                                                                                                                                               | —                                                                   |

三个语言的 Agent SDK 都按同一份蓝图 (`blueprints/modules/a2ui_agent.blueprint.md`) 分层: 底层是可独立使用的原语——catalog 供给 (`CatalogProvider` / `CatalogConfig`, 如 `FileSystemCatalogProvider` / `InMemoryCatalogProvider` / `CatalogConfig.fromPath`)、catalog 变换 (`ComponentPruningTransformer` / `FunctionPruningTransformer` 剪枝)、推理格式 (`DirectJsonFormat` / `ExpressFormat`, 每种格式配套 prompt 生成器与解析器)、载荷校验; 上层是应用门面 `A2uiGenerator` (持注册的 catalog 集, 按渲染器能力生成请求处理器) 与 `A2uiRequestProcessor` (绑定一次请求协商出的活跃 catalog, 输出 prompt 片段并解析模型响应)。`conformance/agent/` 套件 (catalog_provider / catalog_resolution / catalog_transformer / request_processor / multi_catalog_formats / skill / builder / macros, 另保留 `legacy/` 套件) 按这份蓝图编写。

落地程度各语言不一:

- **Dart** 已实现蓝图全部 API。注册的 catalog 可跨版本, 每个 processor 与渲染器协商出双方共有 catalog 的最新协议版本; `resolveCatalogs` 支持无能力请求 (取 null 时激活全部注册 catalog)。v1.0 下 `createSurface` 内嵌组件与数据模型、绑定写作 `@path` / `@call`、组件与函数调用可各自点名 catalog; agent 侧会按 catalog 的 `allowedCallers` 与用户激活要求预检, 经 `a2ui_core` 的 `MessageProcessor.forAgent` (只校验不执行的专用构造) 检查, 渲染器会拒绝的调用在 `parseChunk` 阶段就不会发出。
- **TypeScript** `@a2ui/agent` 支持 v1.0 / v0.9 / v0.9.1 (v0.9.1 共享 v0.9 schema), 实现 Direct JSON 与 Express; `KNOWN_GAPS.md` 记录 v0.8 与 Elemental / Atom 格式不在范围、Express 不做流式。`parseResponse` 解析失败时抛 `A2uiError` 并以 `partialResults` 返回失败块之前的部分; `RendererState` 区分 chat (每轮独立 Surface) 与 canvas (跨轮更新同一批 Surface) 两种校验模式, `validatePayload` 可独立校验单个 payload (如工具调用参数)。
- **Python** `a2ui_agent` 提供同款 facade (`A2uiGenerator` / `A2uiRequestProcessor`, 位于 `a2ui/processor/`), 缺省格式工厂是 `ExpressFormatFactory`; `create_processor` 要求渲染器能力 (缺能力时报 `A2uiCatalogError`), `resolve_catalogs` 按版本键读取能力对象 (v0.8 兼容裸形态), 内联 catalog 无论是否被接受都会被解析——格式非法即报错。

Core 侧的关键设计:

- **TypeScript Core** (`@a2ui/web_core` 0.14.0) 按版本子路径并存 (`./v0_8` / `./v0_9` / `./v1_0`), 另有 `./catalog` / `./state` / `./processing` / `./resolution` / `./validation` / `./reactivity` / `./expressions` / `./adapters` / `./rpc` / `./errors` / `./events` / `./semver` 等模块入口; `./universal` 子路径提供框架无关的 Lit custom element 渲染层 (`A2uiLitElement` / `registerUniversalElement`), 其 basic catalog 组件按每组件的 API 联合类型同时覆盖 v0.9 与 v1 catalog API (如 `ButtonSupportedApis = typeof v0_9.ButtonApi | typeof v1.ButtonApi`); `./catalogs/basic/v1` 提供 v1 basic catalog 的类型安全 API。依赖内置 zod v3 与 `@preact/signals-core`。
- **渲染器版本入口不一**: `@a2ui/react` 只开放 `./v0_8` / `./v0_9` 入口; `@a2ui/lit` 开放 `./0.8` / `./ui` / `./v0_8` / `./v0_9`, basic catalog 组件复用 web_core 的 universal 实现; `@a2ui/angular` 自带 v1.0 basic catalog 的 universal 实现 (`src/basic-catalog.ts`, 基于 `@a2ui/web_core/catalogs/basic/v1`, 缺省 `useUniversalComponents: true`), README 另文档化 `@a2ui/angular/v0_9` 入口; `@a2ui/markdown-it` 提供 Text 组件的 Markdown 渲染支持。
- **Python Core** 用版本适配器工厂消化协议差异 (见 "版本族" 一节), 同时是 wire schema 的生成源: `a2ui.core.schema` 的 Pydantic 模型重建 specification 目录下 v0.8 / v0.9 / v0.9.1 的 `server_to_client.json` 与 v1.0 的 `agent_to_renderer.json`, conformance 套件 (`core/agent_to_renderer.yaml`) 断言各版本重建结果与已发布 spec 文件完全一致。catalog 侧由 `core/catalog.yaml` 覆盖四个入口点: `from_json` (已发布 catalog 必须与 SDK 自带 basic catalog 实现等价)、`to_json` (与已发布文件整体比对)、round-trip (往返不变)、`validation_schema` (原 `catalogSchema` 的继任者, allOf 展平、组件补 id 信封、公共类型内联)。
- **Swift Core** 分三个 SPM target: `A2UIJSON` (JSON Schema 2020-12 数据结构与 `$ref` 解析, 支持 v0.9.1 与 v1.0 schema)、`A2UICore` (`SurfaceGroupModel`、带自动创建的 `DataModel`、双向 RPC 的 `RPCHandler`、action 分发)、`BasicCatalog` (v0.9 / v0.9.1 / v1.0 三个版本的 schema API 与 `formatString`、`@index` 等函数实现)。
- **一致性套件** (`conformance/`) 是语言无关的 YAML 用例, 分 core / agent / extensions 三类: core 覆盖 catalog 四入口、wire schema 重建、三个版本的 validator (重复 ID、缺 root、悬空引用、环、可达性、嵌套深度上限、非法路径、多 Surface、增量更新)、数据模型指针与删除语义、节点解析、表达式解析、函数求值、`@index`、RPC 函数、多 catalog、组合约束、无障碍、保留键等; agent 按格式分目录 (direct_json 与 express 各自拥有 prompt 生成、编译、反编译、响应解析断言, direct_json 另有流式解析与 scaling 套件——Express 解析器整块缓冲后解析)。模型与 spec 文件互相钉住, 不会单边漂移。

## 与 A2A 的集成

A2UI 传输无关, 但 A2A 是最完整的传输层, 因为它同时提供了会话标识与跨 Agent 能力协商。A2UI 以 A2A 扩展的形式登记:

- 扩展 URI 显式编码版本: v0.9.1 为 `https://a2ui.org/a2a-extension/a2ui/v0.9.1`, v1.0 为 `https://a2ui.org/a2a-extension/a2ui/v1.0`。
- `params.supportedCatalogIds` 声明 Agent 能生成哪些 catalog 的 UI; `params.acceptsInlineCatalogs` 声明是否接受客户端内联 catalog, 缺省 false。

在 AgentCard 中声明 A2UI 扩展是可选的 (鼓励但不强制), 用于告知客户端是否值得发送能力声明。

**激活与协商。** 显式激活按传输层区分: JSON-RPC over HTTP 用请求头 `X-A2A-Extensions` 携带扩展 URI; gRPC 把 URI 放入 `sendMessageParams.metadata["X-A2A-Extensions"]`。显式激活并非必需: 客户端也可以在每条消息的 metadata 中携带 `a2uiClientCapabilities`, Agent 据此判断是否下发 UI; Agent 返回的 DataPart 带 `application/a2ui+json` 时客户端即知是 A2UI 消息。规范明确: 不应使用 `accepted_output_modes: ['a2ui']` 触发 A2UI, 这不是标准做法。

**消息映射。** A2UI 消息编码为 A2A 的 DataPart: `DataPart.data.metadata["mimeType"] = "application/a2ui+json"`; `data` 字段必须是 A2UI 消息数组; 服务端下发时须通过 server-to-client 消息列表 schema 校验, 客户端上行时须通过 client-to-server 消息列表 schema 校验。处理规则: 消息列表不是事务单元, 接收方必须按序逐条处理; 单条消息校验或应用失败时记录错误并继续处理后续消息, 原子性只在单条消息级别保证; 渲染器建议等列表内所有消息处理完再重绘, 避免中间状态闪烁。

**metadata 承载的能力与状态。** 客户端发给 Agent 的每条 A2A 消息可在 `message.metadata` 中携带两类 A2UI 数据:

| 字段 (v0.9.1)            | 内容                                                           | 作用                          |
| :----------------------- | :------------------------------------------------------------- | :---------------------------- |
| `a2uiClientCapabilities` | 按协议版本分组的 `supportedCatalogIds` 与可选 `inlineCatalogs` | 让 Agent 知道客户端能渲染什么 |
| `a2uiClientDataModel`    | 开启数据同步的 Surface 的完整数据模型 (按 surfaceId 组织)      | 让 Agent 拿到 UI 当前状态     |

v1.0 扩展沿用同一套机制, 只做术语对齐: metadata 键改名为 `a2uiRendererCapabilities` 与 `a2uiRendererDataModel`。

**会话与流式。** A2A 基于 JSON-RPC, 核心方法为 `message/send` (同步) 与 `message/stream` (流式, 服务端经 SSE 逐步返回事件)。A2UI 会话映射到 A2A 的 `contextId`: 一组相关 Surface 的所有消息应共享同一 `contextId`, 单条消息由 `messageId` 标识。若省去 A2A, 用 SSE/WebSocket 直连服务端也能跑, 但需要自行实现能力协商与会话标识。

## 示例应用与典型链路

仓库内的示例覆盖了从最小可运行到多服务集成的不同层次:

- **restaurant_finder**: 餐厅搜索、推荐、预订的多轮 Agent, 是最完整的官方 demo。Python ADK 版在 `samples/agent/adk/restaurant_finder` (A2A 服务, 默认端口 10002, agent card 位于 `/.well-known/agent-card.json`, 即官方 Quickstart 所用); Node 版在 `samples/agent/node/restaurant_finder`, 用 `@a2ui/agent` 按请求 metadata 里的能力对象回答对应版本——带 `"v1.0"` 键的 `a2uiRendererCapabilities` 回 v1.0 消息, 带 `"v0.9"` 键的 `a2uiClientCapabilities` 回 v0.9 消息, 无能力声明默认 v0.9; 生成格式由 `A2UI_FORMAT` 环境变量在 `direct_json` 与 `express` 之间切换, `STUB_LLM=true` 可不打模型走固定响应。这条 "列表 → 表单 → 确认" 的链路说明了结构 (`updateComponents`) 与数据 (`updateDataModel`) 分离的价值: 改数据不必重发结构。仓库另有 Flutter 版客户端 (`samples/client/flutter/restaurant_finder`) 与 Angular 版客户端 (`samples/client/angular`)。
- **React / Lit 客户端 shell** (`samples/client/react/shell` 与 `samples/client/lit/shell`): 两个 shell 跑同一个协议。React shell 用浏览器 fetch 到 Vite 中间件 (`middleware/a2a` 插件) 做协议转换与流式转发; Lit shell 在浏览器里直接用 `@a2a-js/sdk` 的 `A2AClient` 连接 Agent, 请求头携带 `X-A2A-Extensions: https://a2ui.org/a2a-extension/a2ui/v0.9`。两者的 MessageProcessor、SurfaceModel、绑定器全部来自框架无关的 Core SDK, 适配层只是两种技术栈的桥接。
- **custom-components-example** (`samples/agent/adk/custom-components-example`): 演示自定义 catalog——服务端用自定义组件集合声明 catalog, 客户端注册对应实现, Agent 只能请求渲染这些已注册组件。社区侧另有 `samples/community/custom-lit-components` 演示自定义 Lit 组件注册。
- **macros** (`samples/community/macros`): Python `@macro` + 类型安全 builder 的高层布局宏 (UserProfile、TeamCard、EmployeeSalaryCard 等), 模型输出走 Express DSL, 服务端同步展开为标准组件; 含服务端 resolver 注入敏感数值的演示与 Playwright e2e 测试。
- **A2UI over MCP** (`samples/community/mcp/a2ui-over-mcp-recipe` 与 `a2ui-over-mcp-filesystem`): 把 A2UI 消息作为 MCP 工具输出或资源 (`_meta.ui.resourceUri` + `application/a2ui+json`) 的返回内容。filesystem 示例在 `client/functions/` 里实现了 `jmespath` / `split` / `regexCapture` / `regexReplace` / `updateDataModel` 五个数据变换函数, 配合 `callMcpTool` 把文件系统 MCP 服务器的纯文本结果加工成数据模型——所有按钮交互全部由声明式的 catalog 函数链完成, 没有自定义客户端逻辑。
- **MCP Apps in A2UI** (`samples/community/mcp/a2ui-in-mcpapps`、`mcp-apps-calculator`、`a2ui-kanban` 与 `samples/community/client/lit/mcp-apps-in-a2ui-sample`): 反过来让 A2UI 客户端承载不受信的第三方 MCP App。仓库把这条路径做成可复用的双 iframe 隔离件 (`samples/community/client/shared/mcp_apps_inner_iframe`, 内层沙箱位同为 `allow-scripts allow-forms allow-modals`), 其正式化实现是 `typescript/catalogs/shared/sandbox/`, 供 v1.0 MCP catalog 的 `McpApp` 组件使用。kanban 示例是一个三进程完整链路: MCP server 提供看板 App 资源与工具, Python A2A agent 流式下发 v1.0 消息, Lit 聊天宿主注册 basic 与 mcp 两个 catalog 并桥接 `callMcpTool`。
- **vegachart** (`samples/vegachart`): 无 LLM 的静态分析面板, 从一份 v0.9 JSON payload 渲染 VegaChart + basic catalog 的混合 UI, 演示多 catalog 组合 (`VegaChart` 组件按 `catalogId` 点名自己的 catalog) 与响应式数据绑定。
- **pong** (`samples/community/web/pong`): 把一个标准 Web 游戏经 web frame bridge 嵌入 A2UI 客户端。

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

## 生成可靠性: 校验、纠错与评测

v0.9 是 prompt-first 设计: schema 嵌入 prompt, LLM 不受结构化输出格式强约束。协议文档明确这是该方案的代价——生成后必须做校验与修复: 系统要能识别差异并在渲染前尝试修正, 或请求 LLM 重试/纠错。标准使用模式是一个三步循环: Prompt (期望 UI 描述 + 协议 JSON Schema + catalog + 合法示例) → Generate (模型输出 JSON) → Validate (对照 schema 校验, 通过则下发, 失败则回喂错误)。

校验失败的标准错误形态即客户端 `error` 消息的 `VALIDATION_FAILED` 变体, 带 JSON Pointer 级别的路径信息, 便于模型理解并定位修复:

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

conformance 的三个 validator 套件 (`validator_v0_8` / `validator_v0_9` / `validator_v1_0`) 以同一套严格模式钉住了校验器必须覆盖的失败类: 信封与组件 schema 检查、重复 ID、缺 root、悬空引用、环、可达性 (含列表模板)、嵌套深度上限、非法路径、多 Surface、增量更新。协议对失败的最小处理要求是: 逐条处理、单条原子、`undefined` 优雅处理; 引用类问题 (组件乱序、引用未到达) 由渐进渲染天然容忍, 生命周期类问题 (缺 `createSurface`、杂散 `createSurface`) 会破坏状态机, 必须由应用层防御。

仓库为生成质量提供了专门的评测基础设施 (`eval/`): 基于 Inspect AI 框架的评测 harness (`eval/a2ui_eval`), 检查 prompt 或对话历史产出的 UI payload 是否符合 A2UI schema 与场景语义规则; 数据集 (`datasets/*.yaml`) 在 Git 中以 Transcrypt 加密防止基座模型污染, 运行需要 `GEMINI_API_KEY`; `bin/run_ci_evals.py` 接入 CI (`.github/workflows/run_evals.yml`), `baselines/` 存有 direct_json 基线。各语言 SDK 的解析与纠错能力也经由 conformance 的 response parser / streaming 套件跨语言对齐。

## 安全模型小结

安全是协议的一等原则, 由几条相互独立的机制共同保证:

- **声明式数据而非代码**: Agent 只能请求渲染 catalog 内组件, 客户端永远不执行 Agent 下发的代码; `functionCall` 是 Agent 与渲染环境交互的唯一通道, 且 v1.0 下执行边界 (`allowedCallers` / `requiresUserActivation`) 由渲染器在运行时强制。
- **catalog 白名单**: 生产应用通常自定义 catalog, 把 Agent 限制在自己的设计系统内。
- **定向投递**: 开启 `sendDataModel` 时, UI 状态只回传给创建该 Surface 的服务端。
- **身份归属防伪** (v0.9 族): 编排者负责校验或覆写 `iconUrl` 与 `agentDisplayName`, 防止冒充; v1.0 把身份归属移出协议层。
- **不可信内容的沙箱化承载**: `McpApp` 与共享双 iframe 代理 (`typescript/catalogs/shared/sandbox/`) 用外层代理页 (referrer/origin 检查、消息中继) + 内层沙箱 iframe (`allow-scripts allow-forms allow-modals`, 不含 `allow-same-origin` / `allow-popups` / `allow-top-navigation`) 隔离第三方内容, 跨帧 payload 还有原型污染与深度的结构化校验; 工具与函数调用按白名单放行。
- **校验在执行边界完成**: 校验类逻辑用 catalog 函数声明并在客户端本地执行, 不依赖 Agent 自觉。

## 适用场景与选型建议

适合 A2UI 的场景:

- Agent 需要在对话内动态生成结构化交互界面 (卡片、列表、表单、图表), 且组件集可由 catalog 覆盖。
- UI 由远程或第三方 Agent 产出, 需要跨信任边界安全渲染, 不希望执行对方下发的代码。
- 需要跨端渲染同一份 UI 描述 (Web / Angular / Lit / React / Flutter / SwiftUI), 或要求 UI 与宿主设计系统完全一致。
- 生成链路需要可校验、可纠错, 且有会话/流式体验要求。

不适合的场景:

- 需要承载任意 Web 应用或重型可视化库 (地图、3D、完整游戏)——超出 catalog 表达能力, 可走 MCP Apps 这类代码沙箱路线 (A2UI 客户端以 `McpApp` 组件或双 iframe 代理承载), 取舍见 [mcp-app](./mcp-app)。
- 界面结构固定、由开发者设计时产出——直接用框架组件更省成本。
- 只需要一张静态图片或一段富文本——普通消息即可。

落地时的最小闭环是: 一份明确的 catalog (作为客户端与服务端的共同契约)、一个把 catalog schema 编进 prompt 的生成器 (如 `@a2ui/agent` 或 Python `A2uiGenerator`)、校验加纠错重试、一条诚实降级路径 (生成块失败时保留纯文本正文), 以及一个支持增量应用与动作回传的渲染器。若还需要压缩模型输出成本, 可以进一步用 A2UI Express DSL (官方 ANTLR4 语法在 `specification/inference_formats/express/Express.g4`) 作为生成格式, 由宿主编译器展开为标准 wire payload。
