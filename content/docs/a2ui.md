---
title: "A2UI"
description: "A2UI 协议调研: v0.9/v0.9.1 规范的组件与函数目录、扩展机制、Dart/Swift/TypeScript 多语言 SDK、A2A 集成、restaurant_finder 示例源码走读与 yukino-agent 生产级应用案例"
---

仓库路径: https://github.com/a2ui-project/a2ui (协议仓库, 本机克隆位于 $HOME/Downloads/a2ui, HEAD f8b58799f05c027533eb1bdec60b69389c53318f, 2026-10-01)
应用案例: $HOME/github/yukino-agent (HEAD 536ed8c), A2UI 集成 (catalog 组件、渲染器、prompt 生成器) 全部内联在该仓库内

## 背景与动机

生成式 AI 擅长产出文本和代码, 但 Agent 要向用户呈现富交互界面时很困难, 尤其是远程 Agent、或跨越信任边界的 Agent (例如编排器把任务委托给第三方的订票 Agent, 后者要往主聊天窗口里渲染一块 UI).

传统方式: 通过 iframe 传输 html/js -- Agent 直接生成一段 HTML/CSS/JS, 客户端用 iframe 加载渲染.

缺陷:

- 重: iframe 是独立的浏览上下文, 有独立的 DOM 树、样式表、JS 执行环境, 创建和通信开销大; 对话流里每插入一块 UI 就多一个 iframe, 页面迅速膨胀
- 结构乱: iframe 内外是两套 DOM, 布局嵌套、滚动联动、高度自适应都要跨框架手工协调
- 样式乱: iframe 内样式与宿主页面完全隔离, 无法继承宿主的设计系统 (主题、字体、间距), 视觉割裂
- 不安全: 这是最根本的问题. LLM 生成的 HTML/JS 属于不可信代码, 直接执行意味着 XSS、任意脚本执行等风险; 只能依赖 sandbox 属性做粗粒度隔离, 且隔离策略与业务组件体系脱节

此外, 直接让 LLM 输出目标框架代码 (如直接生成 React 组件源码) 也不可行: 代码无法在运行时安全执行, 且与客户端技术栈强耦合, 无法跨端复用.

## A2UI 的解法

A2UI (Agent-to-User Interface) 是 Google 开源的开放标准: 让 Agent "说 UI 语言". Agent 不产出代码, 而是产出一段声明式 JSON, 描述 UI 的意图 (组件结构 + 数据模型); 客户端用自身原生的组件库 (React / Lit / Angular / Flutter / SwiftUI) 渲染这段描述. 一句话概括: safe like data, but expressive like code -- 像数据一样安全, 像代码一样有表现力.

三大设计哲学:

- 安全 (Security first): LLM 输出结构化 JSON 数据而非可执行代码. 客户端维护一份 catalog (受信组件目录, 例如 Card / Button / TextField), Agent 只能请求渲染 catalog 内的组件; 组件如何渲染、事件如何执行完全由客户端掌控, 从根上消除 UI 注入风险
- LLM 友好、可增量更新 (LLM-friendly and incrementally updatable): UI 被抽象为扁平的组件列表 (邻接表, 靠 ID 引用建立父子关系), 而非深层嵌套树. 这种形态对 LLM 生成友好: 可以乱序输出、可以边生成边渲染 (流式 JSON + 渐进渲染, 首屏延迟低); 对话推进时 Agent 只需增量发送变更消息 (更新几个组件或几条数据), 不必重发整棵 UI
- 框架无关、可移植 (Framework-agnostic and portable): A2UI 将 UI 结构 (抽象组件树 + 数据模型) 和 UI 实现 (具体框架组件) 彻底分离. Agent 发送的 JSON 与框架无关, 同一份 payload 可以被 React、Lit、Angular、Flutter 等不同客户端各自映射到原生组件渲染; 客户端通过开放的注册机制把服务端组件类型映射到自定义实现 (smart wrapper), 甚至可以包装 iframe 等遗留内容, 并把沙箱策略掌握在自己手里

相比 iframe 方案的优势:

- 安全: 数据白名单机制 (catalog) 取代代码执行, 安全边界清晰且可由业务方自主加固
- 没有 iframe: A2UI 组件直接渲染在宿主组件树中, 无独立浏览上下文的开销, 性能更好; 样式走宿主设计系统, 主题、暗色模式、字体天然统一
- 可移植: 一份结构化 JSON 同时适用于 vanilla js / lit / react / mobile 等多端渲染器, Agent 侧零改动
- 可增量: 结构与数据分离, 改数据 (updateDataModel) 不必重发结构 (updateComponents), 传输和解析成本低
- 可校验: JSON 有完整 schema, 服务端可在下发前校验并让 LLM 自纠, iframe 方案里坏 HTML 只能直接渲染出来

Keywords: 流式传输 JSON、声明式 UI (抽象组件树/邻接表)、数据绑定 (JSON Pointer)、catalog 白名单、传输无关 (A2A / AG-UI / MCP / SSE)

本文以 React 渲染器 (@a2ui/react) + v0.9 协议为主线, 参考实现为 ~/Downloads/a2ui/samples/client/react/shell (餐厅预订 demo), 并在末尾与 Lit 实现做对比. 在此之上补充一个实践案例: yukino-agent ($HOME/github/yukino-agent, 一个不依赖 CopilotKit 的生产级 A2UI 应用, catalog、渲染器与 prompt 生成器全部内联在仓库内).

## 概念

- Surface: 一块独立的 UI 区域 (页面/卡片), 由 surfaceId 标识, 拥有独立的组件树和数据模型
- Component: 组件, 扁平列表 + ID 引用 (邻接表), 必须存在 id 为 root 的根组件
- Data Model: 每个 Surface 一份 JSON 数据模型, 组件通过 JSON Pointer 路径绑定其中的数据
- Catalog: 客户端可信组件/函数目录, 由 catalogId 标识, Agent 只能使用 Catalog 内的组件
- Message: 一条 JSON 对象, 恰好包含四种信封键之一

## v0.9 消息类型

服务端 -> 客户端 (server_to_client):

- createSurface: 创建 Surface, 绑定 surfaceId + catalogId, 可携带 theme 和 sendDataModel
- updateComponents: 新增或更新 Surface 内的组件 (扁平列表)
- updateDataModel: 按 JSON Pointer 路径 upsert 数据模型, 省略 value 表示删除该路径
- deleteSurface: 删除 Surface 及其全部组件和数据

客户端 -> 服务端 (client_to_server):

- action: 用户交互事件 (点击按钮等), 携带 name / surfaceId / sourceComponentId / timestamp / context

v0.9 消息示例 (注意与 v0.8 的字段差异, 见文末对照表):

```json
{
  "version": "v0.9",
  "createSurface": {
    "surfaceId": "default",
    "catalogId": "https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json",
    "theme": { "primaryColor": "#FF0000", "font": "Roboto" }
  }
}
```

## A2A 协议详解

A2A (Agent2Agent, a2a-protocol.org) 是 Agent 间以及 Agent 与前端应用间标准化通信的开放协议, 提供安全、认证、消息格式和传输的完整绑定. A2UI 本身传输无关, 但 A2A 是其最主流的传输层 (其余可选: AG-UI / MCP / SSE / WebSocket / REST). 在 A2UI 场景中, A2A 承担以下职责.

### AgentCard: 能力发现

每个 A2A Server 在固定路径暴露 AgentCard, 声明自身能力:

- 端点: `GET /.well-known/agent-card.json`
- 内容: 名称、描述、支持的扩展列表 (capabilities.extensions)、认证要求等

Agent 鼓励在 AgentCard 中声明 A2UI 扩展 (非强制), params 对象对应 server_capabilities.json schema:

```json
{
  "name": "Dashboard Agent",
  "description": "Agent capable of generating dynamic UI dashboards.",
  "capabilities": {
    "extensions": [
      {
        "uri": "https://a2ui.org/a2a-extension/a2ui/v0.9.1",
        "description": "Ability to render A2UI v0.9.1",
        "required": false,
        "params": {
          "supportedCatalogIds": [
            "https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json",
            "https://my-company.com/a2ui/v0.9/my_custom_catalog.json"
          ],
          "acceptsInlineCatalogs": true
        }
      }
    ]
  }
}
```

- params.supportedCatalogIds: Agent 能生成哪些 catalog 的 UI
- params.acceptsInlineCatalogs: 是否接受客户端内联 catalog (默认 false)

Client 通过 `A2AClient.fromCardUrl(url)` 读取 AgentCard 完成初始化 (见 react shell 的 middleware 与 lit shell 的 client.ts).

### 消息模型: Message 与 Part

A2A 消息 (Message) 由 role (user/agent) 和 parts 数组组成, Part 有三种 kind:

- TextPart: 纯文本 (用户的自然语言查询、Agent 的对话回复)
- DataPart: 结构化 JSON 数据, 通过 mimeType 区分用途. A2UI 消息固定使用 `mimeType: "application/a2ui+json"`, data 字段必须是 A2UI 消息数组
- FilePart: 文件内容

A2UI 消息编码为 DataPart 的示例 (服务端下发):

```json
{
  "kind": "data",
  "data": [
    { "version": "v0.9", "createSurface": { "surfaceId": "default", "catalogId": "..." } },
    { "version": "v0.9", "updateComponents": { "surfaceId": "default", "components": [...] } }
  ],
  "metadata": { "mimeType": "application/a2ui+json" }
}
```

注: 官方 A2A 扩展规范的示例把 mimeType 放在 part 的 metadata.mimeType 上 (如上方形态); 官方 sample 代码也有把 mimeType 直接平铺在 part 上的写法 (见下文中间件示例, TypeScript 类型需 as Part 强转), 偏离规范推荐形态, 两种写法并存.

处理规则 (来自 A2A 扩展规范):

- data 中的消息列表不是事务单元, 接收方必须按序逐条处理
- 单条消息校验/应用失败时, 记录错误并继续处理后续消息, 原子性只在单条消息级别保证
- 渲染器建议等列表内所有消息处理完再重绘, 避免中间状态闪烁

### JSON-RPC 方法与会话

A2A 基于 JSON-RPC, 核心方法:

- message/send: 同步发送消息, 返回完整 Task/Message 结果 (lit shell 使用)
- message/stream: 流式发送, 服务端通过 SSE 逐步返回 status-update / message 事件 (react shell 的中间件使用 sendMessageStream)

会话相关概念:

- Task: 一次请求的处理结果对象, 含 state (working / completed 等) 和 status.message.parts
- contextId: 会话标识, 同一 contextId 下的消息共享对话历史, A2UI 的一组相关 Surface 应共享同一 contextId
- messageId: 单条消息的唯一标识

status-update 事件的 parts 是累积语义 (每次事件携带截至当前的全部 parts), 这也是 react shell 需要对 createSurface 去重的原因.

### 扩展机制与 A2UI 激活

A2A 支持通过扩展 URI 协商可选能力. A2UI 扩展的 URI 显式编码版本号:

- v0.9: `https://a2ui.org/a2a-extension/a2ui/v0.9`
- v0.9.1: `https://a2ui.org/a2a-extension/a2ui/v0.9.1`

激活方式按传输层区分:

- JSON-RPC over HTTP: 请求头 `X-A2A-Extensions: <扩展 URI>` (本仓库两个 shell 都采用此方式)
- gRPC: `sendMessageParams.metadata["X-A2A-Extensions"]`

Server 端解析逻辑见 python/a2ui_agent/src/a2ui/a2a/extension.py: 读取客户端请求的版本与自身支持版本取交集, 匹配则激活 A2UI 扩展 (system prompt 注入 A2UI schema), 不匹配则按普通文本对话处理.

补充两个规范细节:

- 显式激活并非必需: 客户端也可以只在每条消息的 metadata 中携带 a2uiClientCapabilities, Agent 据此判断是否下发 UI; Agent 返回的 DataPart 带 application/a2ui+json 时客户端即知是 A2UI 消息
- 不应使用 `accepted_output_modes: ['a2ui']` 触发 A2UI, 这不是标准做法

### metadata 承载的 A2UI 状态

客户端发给 Agent 的每条 A2A 消息, 可在 message.metadata 中携带两类 A2UI 数据:

(1) a2uiClientCapabilities -- 客户端能力声明 (按版本分组):

```json
{
  "metadata": {
    "a2uiClientCapabilities": {
      "v0.9.1": {
        "supportedCatalogIds": ["https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json"],
        "inlineCatalogs": [ ... ]
      }
    }
  }
}
```

(2) a2uiClientDataModel -- 当 Surface 开启 sendDataModel 时, 客户端在每次触发消息 (action / 用户查询) 时附带该 Surface 的完整数据模型, 让 Agent 拿到 UI 当前状态:

```json
{
  "metadata": {
    "a2uiClientDataModel": {
      "version": "v0.9.1",
      "surfaces": {
        "main_surface_id": { "user_id": "12345", "email": "user@example.com" }
      }
    }
  }
}
```

数据模型只发给创建该 Surface 的 Server, 不会泄漏给其他 Agent.

## A2UI 协议详解

A2UI 是 JSON 流式 UI 协议: 服务端 (Agent) 向客户端 (Renderer) 发送 JSON 对象流, 客户端逐条解析并增量构建/更新 UI. 核心设计是 UI 结构 (Components) 与应用数据 (Data Model) 的彻底分离. 以下以 v0.9.1 规范 (specification/v0_9_1/docs/a2ui_protocol.md) 为准. 需要说明: 文末 yukino-agent 应用案例的协议栈固定使用 v0.9 (@a2ui/web_core/v0_9 子路径导入 + vendored v0.9 协议 schema), 故全文示例均以 v0.9 形态为准.

### 版本家族

- v0.8: legacy 版本族 (规范冻结), 面向支持 structured output 的 LLM; TypeScript web_core 与 React/Lit 渲染器保留了 v0_8 入口
- v0.9: prompt-first 协议族首个稳定版, SDK 已实现
- v0.9.1: 当前生产版本, 与 v0.9 差异极小 (见 evolution_guide), 多语言 SDK/渲染器/示例均以此为准
- v1.0: 候选规范 (release candidate), 待足够多渲染器移植后转稳定

v0.9 的 prompt-first 取向: schema 直接嵌入 LLM prompt 让其仿写, 不受 structured output 的表达能力限制, catalog 可以更复杂可读; 代价是生成后必须做校验和修复 (validate + retry).

### Schema 组成

v0.9.1 由三类 JSON Schema 构成 (specification/v0_9_1/json/):

- common_types.json: 可复用基础类型
  - DynamicString / DynamicNumber / DynamicBoolean / DynamicStringList: 数据绑定核心, 接受字面量、`{path}` (JSON Pointer) 或 `{call, args}` (FunctionCall) 三种形态
  - ComponentId: 组件引用
  - ChildList: 容器子节点, 数组形态 (静态 ID 列表) 或对象形态 (模板 componentId + 数据 path)
- server_to_client.json: 服务端消息信封 (顶层入口), 负责消息分发
- client_to_server.json: 客户端消息 (action / error)
- 能力与状态: server_capabilities.json / client_capabilities.json / client_data_model.json

信封 schema 是 catalog 无关的: 它通过占位文件名 `$ref: "catalog.json#/$defs/anyComponent"` 引用组件定义. 校验时把 catalog.json 映射到具体 catalog 文件即可:

- 用 basic catalog: 映射到 catalogs/basic/v1/catalog.json (v0.9/v0.9.1 的对应文件是 specification/v0_9_1/catalogs/basic/catalog.json)
- 用自定义 catalog: 映射到自己的 catalog 文件

自定义 catalog 的强制规则 (否则校验器无法检查父子引用完整性):

- 单个子组件引用属性必须用 `$ref: common_types.json#/$defs/ComponentId`, 不能用裸 string
- 子列表/模板属性必须用 `$ref: common_types.json#/$defs/ChildList`

### 传输契约

A2UI 传输无关, 但任何传输层必须满足:

1. 可靠有序投递: A2UI 是有状态更新 (先 createSurface 才能 update), 乱序会破坏 UI 状态
2. 消息分帧: 清晰分界 (JSONL 换行、WebSocket 帧、SSE 事件)
3. metadata 支持: 用于携带 a2uiClientDataModel 和能力交换 (AgentCard / 初始化握手)
4. 双向通道 (可选): 渲染流是单向的, 交互应用需要 action 回程通道

### Surface 生命周期规则

- createSurface 必须先于该 Surface 的任何 updateComponents / updateDataModel
- surfaceId + catalogId 创建后不可变, 要换配置必须删除重建; 对已存在的 surfaceId 重复 createSurface 是错误
- 组件列表中必须恰好有一个 id 为 root 的组件作为树根; root 未到达前, 其他组件更新被缓冲, 不产生可见效果
- deleteSurface 移除 Surface 及其全部组件和数据

### 组件模型: 邻接表

组件是扁平列表, 树结构靠 ID 引用隐式构建:

- 客户端把所有组件存入 Map\<ComponentId, Component>, 渲染时重建树
- 组件可以任意顺序到达, 可以引用尚不存在的子组件或数据路径, 客户端渲染占位并等待补齐 (渐进渲染)
- root 定义后即可开始渲染, 跳过无效引用

Action 机制: 交互组件 (Button 等) 通过 action 属性声明行为, 二选一:

- `{ event: { name, context } }`: 触发发往服务端的事件, context 中的 Dynamic 值在触发时解析
- `{ functionCall: { call, args } }`: 执行客户端本地注册函数 (如 openUrl)

### 数据模型: 绑定与作用域

数据绑定基于 JSON Pointer (RFC 6901), 并扩展支持相对路径:

- 绝对路径 (/ 开头): 始终从 DataModel 根解析, 与组件在树中的位置无关
- 相对路径 (不以 / 开头): 仅在 ChildList 模板创建的子作用域内有效, 解析到当前迭代项 (例如 /users/0/firstName); 数组段使用非数字索引是错误
- 模板内部可混用绝对路径访问根作用域
- 渐进渲染期间路径可能解析为 undefined, 渲染器应优雅处理 (空串或 loading)

类型转换规则 (非字符串值插值时): 数字/布尔转标准字符串表示, null/undefined 转空串, 对象/数组转 JSON 字符串. Swift BasicCatalog 的 formatString 按该规则序列化输出 (含对象/数组).

updateDataModel 的 upsert 语义:

- 路径存在则更新, 不存在则创建
- 省略 value 则删除该键; 数组场景下对应索引置为 undefined 以保持长度
- 省略 path (或为 /) 则替换整个数据模型

双向绑定 (TextField / CheckBox / Slider / ChoicePicker / DateTimeInput):

- 输入立即写回本地 DataModel, 绑定同路径的其他组件实时联动
- 本地 DataModel 是唯一数据源; 键入等被动变化不触发网络请求
- 状态只在 action 触发时回传: 通过 action.context 引用数据路径, 或开启 sendDataModel 随 metadata 附带完整模型

### 客户端函数与校验

v0.9 把客户端逻辑统一抽象为函数 (Function), 按名字引用, 绝不传输可执行代码:

- 函数与组件一起定义在 catalog 中, 客户端运行时从 catalog 读取执行边界配置
- checks: 输入组件和 Button 都可声明校验列表, 每项是 FunctionCall + 失败文案; 输入组件展示错误信息, Button 校验失败自动禁用
- basic catalog 内置 14 个函数: required / regex / length / numeric / email (校验类), formatString / formatNumber / formatCurrency / formatDate / pluralize (格式化类), openUrl (行为类), and / or / not (逻辑类)

formatString 插值语法:

- `${/user/name}` 绝对路径, `${firstName}` 相对路径
- `${formatDate(value:${/currentDate}, format:'yyyy-MM-dd')}` 函数调用, 参数支持字面量和嵌套表达式
- `\${` 转义为字面量

### Basic Catalog

basic catalog 提供 18 个组件:

- 展示: Text (支持简单 Markdown) / Image / Icon / Video / AudioPlayer
- 布局: Row / Column / List / Card / Tabs / Divider / Modal
- 交互: Button / CheckBox / TextField / DateTimeInput / ChoicePicker / Slider

theme 正式支持三个属性: primaryColor (主色), iconUrl 和 agentDisplayName (Agent 身份归属) (schema 的 additionalProperties 为 true, 正文部分示例在 theme 里写了 font 等非协议字段, 属于自定义扩展, 渲染器可忽略) . 多 Agent 场景下, 编排者负责设置或覆写这两个身份字段并校验其与真实 Agent 服务一致, 防止恶意 Agent 冒充可信服务.

### prompt-generate-validate 循环

标准使用模式是三步循环:

1. Prompt: 向 LLM 提供期望 UI 的描述 + A2UI JSON Schema (含 catalog) + 合法示例
2. Generate: LLM 输出 JSON
3. Validate: 对照 schema 校验; 通过则下发渲染, 失败则把错误回喂 LLM 自纠

校验失败的标准错误格式 (让 LLM 能理解并修复):

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

### macros: Agent 侧可编程组件与类型强制引擎

macros (#2519, python/a2ui_agent/src/a2ui/transformers/macros/) 为 Python Agent SDK 与 generate-validate 循环提供了 "可编程组件" 通道: 服务端用 @macro 注册高层布局函数, LLM 像写 catalog 组件一样写 macro 组件, 服务端在下发前把它们同步展开为标准原语组件子树——客户端零改动、零自定义组件。三个模块分工:

- macro.py (@macro 装饰器): 支持裸用、@macro("Name") 与 @macro(name=..., description=...) 三种写法, 缺省取函数名的 PascalCase 作为组件名; 读取签名与类型提示 (get_type_hints) 并解析 Google/Sphinx 风格 docstring 提取参数描述, \_map_type_hint_to_schema 把 Python 类型逐条映射为协议 JSON Schema——DynamicString/Number/Boolean/StringList 映射 common_types.json 同名 $defs, 单子槽位 (ComponentBuilderNode/ComponentRef) 映射 ComponentId, 组件节点列表映射 ChildList, Action/CheckRule/AccessibilityAttributes/FunctionCall/DataBinding 各映射对应 $ref, Literal/Enum 映射 enum, Optional 展开; \_MacroMetadata.to_json_schema() 输出组件 schema
- processor.py (类型强制引擎): \_MacroProcessor.expand 在执行宏前把 LLM 产出的 JSON 参数强制转换为 builder AST 类型——字符串对单子槽位转 ComponentRef (外部 ID 原样保留, 不做命名空间化) 、字符串数组对多子槽位转 ComponentRef 列表、\{"path": ...\} 转 DataBinding、dict 转 AccessibilityAttributes; action 的三种写法统一归一为 Action (wire 形态 \{"event": \{name, context\}\}、简写 \{"event": "name"\}、裸事件体 \{name, context\}; functionCall 本身即 wire 形态, 直接交 Pydantic 校验) 。Action 刻意不接受字符串简写——接受它的 before-validator 对类型检查器不可见, 因此把 LLM 的自然输出改在 processor 层显式映射。宏函数必须返回 ComponentBuilderNode 或节点序列, 再经 flatten_component_tree 压平 (ID 命名空间化 + root 拼接)
- expander.py (MacroExpander, catalog 与消息变换器): transform_to_inference_catalog 把宏 schema 注入 base catalog 的 components 与 $defs.anyComponent.oneOf, 得到 LLM 据以写作的 "推理 catalog" (宏与现有组件重名即报 A2uiCatalogError; passthrough_components 可裁剪 base catalog, 传空列表则只暴露宏) ; transform_to_transport 扫描 surfaceUpdate/createSurface/updateComponents 信封里的 components 列表, 把宏调用展开为原语子树, 支持宏中嵌套宏的递归展开 (深度上限 16 层, 超限抛 A2uiRecursionError; 单个宏展开失败记日志并保留原组件, 不丢弃整批) ; transform_to_inference 为恒等直通; to_catalog 另可导出独立 macros catalog (catalogId https://a2ui.org/catalogs/macros, v0.9.1 基线)

跨语言一致性由 conformance/agent/macros/macros.yaml 钉住: 参考宏用声明式 builder AST 模板定义 (三个哨兵 \{$param: "name"\} 注入参数、\{$spreadParam: "name"\} 展开数组参数、$\{name\} 字符串插值) , 配 8 个黄金用例 (root 拼接与 ID 命名空间化、单子槽位强制保留外部 ID、多子槽位列表强制、action 字符串强制、数据绑定强制、原语/字典参数、嵌套宏组合、完整 surface 生命周期信封) , 每例双重断言: 展开结果等于黄金文件, 且黄金文件通过 A2UI 校验器。

社区示例 samples/community/macros (#2520) 把 macros 与 Express DSL 接成完整链路: server.py (FastAPI, uvicorn 默认端口 8000) 用 MacroAgentRuntime (macro_runtime.py) 组合 BasicCatalog 0.9.1 + MacroExpander + ExpressFormat, 模型输出 \<a2ui> 标签内的 Express DSL, compile_dsl 经 parser.compile → transform_to_transport 同步展开后下发 v0.9.1 wire 消息; macros/ 包按一宏一模块注册 13 个宏 (SalaryCard / UserProfile / FeedbackItem / GoalItem / SectionCard / TeamCard / TeamRoster / TeamGoalList / TeamFeedbackBoard / TeamMemberKnowledgePanel / TwoColumnLayout / EmployeeSalaryCard / PayrollSummary) , 其中 EmployeeSalaryCard 演示 "动态 server resolver"——模型只传 employeeId, 薪酬等敏感数值由服务端 Python resolver 回调查询内部数据库后注入, 敏感数据不进入模型上下文; React 客户端 (client/, yarn dev, 端口 5173) 提供带延迟/token 指标的交互聊天与三阶段 Dynamic Macro Studio (输入参数 → 底层布局结构 → 实时渲染输出) , Playwright e2e 见 test_e2e.mjs。

与 Express DSL 的分工是正交的: Express 压缩输出 token (语法层) , macros 压缩语义空间 (组件层) ——一行 root = UserProfile("usr_101", "Alice Smith", "Lead Architect") 展开为整个 Card 子树; 二者可叠加, 该示例即组合使用 (Express 负责紧凑生成, macros 负责高层抽象与服务端数据注入) .

### 安全模型小结

- 声明式数据格式而非代码: Agent 只能请求渲染 catalog 内组件, 客户端永远不执行 Agent 下发的代码
- catalog 白名单: 生产应用通常自定义 catalog, 把 Agent 限制在自己的设计系统内
- sendDataModel 定向投递: UI 状态只回传给创建该 Surface 的 Server
- 身份归属防伪: 编排者校验/覆写 iconUrl 与 agentDisplayName
- 自定义组件的 smart wrapper 模式: 接入第三方内容 (如 iframe) 时由组件自身实施沙箱与信任策略
- 双 iframe 隔离: 对需要运行不受信第三方代码的场景 (MCP Apps) , 内层 iframe 严格排除 allow-same-origin, 防止 allow-scripts + allow-same-origin 组合导致沙箱逃逸, 同时维持结构化 JSON-RPC 通道 (实现见 samples/community/client/shared/mcp_apps_inner_iframe/, 内层 sandbox 为 allow-scripts allow-forms allow-modals; A2UI 官方规范只声明了 "A2UI 可经 MCP 传输" 的绑定, 未规定 iframe 承载细节)

## 生态与定位

协议出处: A2UI 由 Google 发起, CopilotKit 与开源社区共建, Apache 2.0 许可, 仓库 a2ui-project/a2ui, 包含规范 (v0.9.1 当前, v1.0 候选) 、多端渲染器实现与 A2A 等传输绑定.

与周边项目的关系:

- AG-UI 是传输协议 (连接 Agent 后端与前端, 负责实时状态同步) , A2UI 是 UI 格式 (描述渲染什么的有效载荷) . 二者互补: AG-UI 是管道, A2UI 是内容. AG-UI 由 CopilotKit 团队发起, 对 A2UI 有 day-zero 兼容
- CopilotKit 是基于 AG-UI 的全栈 agentic 框架, 提供 A2UI 渲染的开箱集成 (CopilotKitProvider 传 a2ui catalog 即可) . 但 A2UI 不依赖 CopilotKit, 完全可以自建链路 (见文末 yukino-agent 案例)
- 对比 OpenAI ChatKit: 设计哲学相近 (基础组件 + 可配置声明式抽象层) , 但 A2UI 平台无关, 面向跨 web/移动/桌面自建 agentic 界面, 以及需要跨信任边界渲染的多 Agent 系统
- 采用案例: Google 内部团队、AG2 多 Agent 框架 (A2UIAgent, 可经 A2A 服务 Flutter GenUI 客户端) 、CopilotKit 生态应用等

渲染器生态: 官方渲染器覆盖 React、Lit、Angular、Markdown (仓库 renderers/ 目录) 与 Flutter (GenUI SDK, 独立仓库 flutter/genui); 仓库内另有面向 Apple 平台的 Swift SDK (swift/core 的 A2UICore + BasicCatalog, swift/swiftui 的 SwiftUI 适配层 A2UISwiftUI, 示例 Gallery App 位于 swift/sample (A2UISampleClient), 对齐 v0.9.1 规范) 与 Dart SDK (模型层 dart/a2ui_core、agent 层 dart/a2ui_agent; dart/a2ui_flutter 目前是占位包, 官方 Flutter 渲染器仍指向 GenUI SDK), kotlin/ 目录只剩 agent_sdk_legacy; 社区有基于 shadcn 的 React 渲染器 (如 @xpert-ai/a2ui-react) 及实验性 3D 渲染器. 配套工具: A2UI Composer (可视化编辑器, 无需安装即可生成 A2UI JSON) 、A2UI Theater (预置流式场景的演示场) .

## 完整流程 (React + v0.9)

整体链路:

```
React Shell (浏览器)
  -> fetch POST /a2a (纯文本查询 或 action JSON)
  -> Vite Dev Middleware (协议转换, 注入 X-A2A-Extensions 头)
  -> A2A Server (AgentCard + JSON-RPC, ADK Agent + LLM)
  -> LLM 生成 <a2ui-json> -> Server 校验
  -> SSE (text/event-stream) 流式回传 A2UI 消息
  -> React Shell 增量解析 -> MessageProcessor -> SurfaceModel -> A2uiSurface 渲染
```

### 阶段 1: Server 启动

Server 使用 A2A 协议暴露 HTTP 端点 (restaurant_finder 示例, Python ADK):

```js
// 伪代码, 对应 samples/agent/adk/restaurant_finder
const agent = new RestaurantAgent(); // Agent, 包含 systemPromptBuilder + tools
const executor = new RestaurantAgentExecutor(agent); // 封装 Agent Loop 的执行器
const handler = new DefaultRequestHandler(executor); // A2A JSON-RPC 请求处理器 (配 InMemoryTaskStore)
const app = new A2AStarletteApplication(agent, handler); // Starlette HTTP 应用, uvicorn 运行

app.listen(10002, "localhost"); // CLI 默认 --port 10002 / --host localhost, 均可覆盖
```

Server 启动后提供以下端点:

- `GET /.well-known/agent-card.json` AgentCard, 声明 Server 能力 (支持的 A2A 扩展、MIME 类型等); AgentCard.url 指向服务根地址 (默认 http://localhost:10002)
- JSON-RPC 端点, 处理 `message/send` / `message/stream` 请求 —— 请求发往 AgentCard.url 声明的地址 (本例为 POST 到根路径); 注意 `/a2a` 是 Vite 开发中间件的浏览器侧入口 (见阶段 5), 不是 Server 端点

AgentCard 中声明支持的 A2UI 扩展 (例如 `https://a2ui.org/a2a-extension/a2ui/v0.9`), Client 通过读取 AgentCard 得知 Server 支持 A2UI.

### 阶段 2: React Client 启动

入口是 samples/client/react/shell/src/App.tsx, 启动时做四件事:

(1) 创建 MessageProcessor (核心处理器), 传入 catalog 和全局 action 处理器:

```tsx
// App.tsx
import { A2uiSurface, basicCatalog } from "@a2ui/react/v0_9";
import { MessageProcessor } from "@a2ui/web_core/v0_9";

const processor = useMemo(() => {
  return new MessageProcessor([basicCatalog], (action) => {
    // 全局 action 处理器: 所有 Surface 的用户交互都会汇聚到这里
    sendAndProcessRef.current?.({ version: "v0.9", action });
  });
}, []);
```

MessageProcessor 内部持有:

- SurfaceGroupModel: 所有 Surface 的容器 (surfacesMap)
- 全局 action 订阅: `this.model.onAction.subscribe(actionHandler)`

```ts
// MessageProcessor 伪代码 (typescript/web_core/src/processing/message-processor.ts)
class MessageProcessor<T extends ComponentApi> {
  readonly model: SurfaceGroupModel<T>;

  constructor(catalogs: Catalog<T>[], actionHandler?: ActionListener) {
    this.model = new SurfaceGroupModel<T>();
    if (actionHandler) {
      this.model.onAction.subscribe(actionHandler);
    }
  }

  // 生成渲染端能力声明 (supportedCatalogIds, 可选 inlineCatalogs)
  // 必须显式传非空 options.versions, 否则抛 A2uiValidationError;
  // 返回的能力键由入参 versions 逐个生成, 而非硬编码某个版本
  getRendererCapabilities(options: CapabilitiesOptions): RendererCapabilities {
    if (!options?.versions || options.versions.length === 0) {
      throw new A2uiValidationError(
        "At least one protocol version must be provided...",
      );
    }
    const result = {};
    for (const ver of options.versions) {
      result[ver] = {
        supportedCatalogIds: this.catalogs.map((c) => c.id),
        // => ["https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json"]
        // includeInlineCatalogs: true 时再附加 inlineCatalogs
      };
    }
    return result;
  }

  // 消息分发
  processMessages(messages: A2uiMessage[]): void {
    for (const msg of messages) {
      if (msg.createSurface) this.processCreateSurface(msg);
      if (msg.updateComponents) this.processUpdateComponents(msg);
      if (msg.updateDataModel) this.processUpdateDataModel(msg);
      if (msg.deleteSurface) this.processDeleteSurface(msg);
    }
  }
}
```

(2) 订阅 Surface 生命周期, 同步到 React state:

```tsx
// App.tsx -- ShellContent
const [surfaces, setSurfaces] = useState<SurfaceModel[]>(() =>
  Array.from(processor.model.surfacesMap.values()),
);

useEffect(() => {
  const sub1 = processor.onSurfaceCreated((surface) => {
    setSurfaces((prev) => [...prev, surface]);
  });
  const sub2 = processor.onSurfaceDeleted((id) => {
    setSurfaces((prev) => prev.filter((s) => s.id !== id));
  });
  return () => {
    sub1.unsubscribe();
    sub2.unsubscribe();
  };
}, [processor]);
```

注意分层: Surface 的增删由 React state 驱动 (粗粒度), Surface 内部组件和数据的变化由 web_core 的信号/订阅机制驱动 (细粒度), 不需要手动触发 React 重渲染.

(3) 提供 Markdown 渲染器 (Text 组件支持简单 Markdown):

```tsx
// App.tsx
import {MarkdownContext} from "@a2ui/react/v0_9";
import {renderMarkdown} from "@a2ui/markdown-it";

<MarkdownContext.Provider value={renderMarkdown}>
  <ShellContent ... />
</MarkdownContext.Provider>;
```

(4) 渲染所有 Surface:

```tsx
// App.tsx
{
  surfaces.map((surface) => <A2uiSurface key={surface.id} surface={surface} />);
}
```

A2uiSurface 内部从 id 为 root、basePath 为 "/" 的组件开始递归渲染 (见阶段 12).

### 阶段 3: 用户输入

用户在搜索框输入查询 (例如 "Top 5 Chinese restaurants in New York"), 提交表单:

```tsx
// App.tsx
const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
  e.preventDefault();
  const body = new FormData(e.currentTarget).get("body") as string;
  sendAndProcess(body); // 字符串 => 自然语言查询
};
```

sendAndProcess 在发送前会先清空旧 Surface, 再发起请求:

```tsx
// App.tsx
const sendAndProcess = async (message: A2uiClientMessage | string) => {
  // 清空上一轮的 Surface
  Array.from(processor.model.surfacesMap.keys()).forEach((id) => {
    processor.model.deleteSurface(id);
  });

  // 流式发送, 每收到一个 chunk 立即交给 processor 处理 (渐进渲染)
  const response = await client.send(message, (chunkMessages) => {
    processor.processMessages(chunkMessages);
  });
};
```

### 阶段 4: Client 发送请求

React shell 的 A2UIClient 非常薄, 只做一件事: 把消息 POST 给同源的 /a2a 端点:

```ts
// src/client.ts
export class A2UIClient {
  async send(
    message: A2uiClientMessage | string,
    onChunk?: (messages: A2uiMessage[]) => void,
  ): Promise<A2uiMessage[]> {
    // 字符串 => 自然语言查询; 对象 => action 等 UI 事件 (JSON.stringify)
    const body =
      typeof message === "string" ? message : JSON.stringify(message);

    const response = await fetch("/a2a", { method: "POST", body });
    // ... SSE 流式解析, 见阶段 9
  }
}
```

action 消息的结构 (v0.9 client_to_server):

```json
{
  "version": "v0.9",
  "action": {
    "name": "book_restaurant",
    "surfaceId": "default",
    "sourceComponentId": "template-book-button",
    "timestamp": "2026-08-11T08:00:00.000Z",
    "context": {
      "restaurantName": "Hwa Yuan Szechuan",
      "address": "40 E Broadway, New York, NY 10002"
    }
  }
}
```

catalog 协商有两种模式:

- pre-shared catalog: Client 只通过 supportedCatalogIds 声明支持哪些 catalog (catalogId 字符串), Server 预先已知其内容. Restaurant Finder 示例使用此模式
- inlineCatalogs: Client 通过 `processor.getClientCapabilities({ versions: ["v0.9"], includeInlineCatalogs: true })` 导出本地注册组件的完整 JSON Schema, 放入消息 metadata 的 a2uiClientCapabilities 中发送给 Server, Server 注入 system prompt. 适合自定义组件场景

### 阶段 5: Vite 中间件代理 (HTTP -> A2A, SSE 流式)

浏览器直接 fetch('/a2a'), 但 Agent Server 要求 A2A JSON-RPC 协议. React shell 用 Vite 插件做协议转换 (samples/client/react/shell/middleware/a2a.ts):

```ts
// middleware/a2a.ts
const A2UI_MIME_TYPE = "application/a2ui+json";

// 自定义 fetch: 注入 X-A2A-Extensions 头, 声明 Client 支持的 A2UI 版本
const fetchWithCustomHeader: typeof fetch = async (url, init) => {
  const headers = new Headers(init?.headers);
  headers.set("X-A2A-Extensions", "https://a2ui.org/a2a-extension/a2ui/v0.9");
  return fetch(url, { ...init, headers });
};

export const plugin = (): Plugin => ({
  name: "a2a-handler",
  configureServer(server: ViteDevServer) {
    server.middlewares.use("/a2a", async (req, res) => {
      const body = await readBody(req); // 带 1MB 上限保护

      // 判断请求类型: JSON 对象 (UI 事件) 或 纯文本 (用户查询)
      let sendParams: MessageSendParams;
      if (isJson(body)) {
        // JSON 请求 (action): 包装为 A2A DataPart, 携带 a2ui MIME 类型
        sendParams = {
          message: {
            messageId: crypto.randomUUID(),
            role: "user",
            parts: [
              {
                kind: "data",
                data: JSON.parse(body),
                mimeType: A2UI_MIME_TYPE,
              },
            ],
            kind: "message",
          },
        };
      } else {
        // 纯文本请求: 包装为 A2A TextPart
        sendParams = {
          message: {
            messageId: crypto.randomUUID(),
            role: "user",
            parts: [{ kind: "text", text: body }],
            kind: "message",
          },
        };
      }

      // 懒初始化 A2A Client (模块级单例, 读取 Server 的 AgentCard)
      const client = await A2AClient.fromCardUrl(
        "http://localhost:10002/.well-known/agent-card.json",
        { fetchImpl: fetchWithCustomHeader },
      );

      // 流式转发: A2A stream -> SSE
      const stream = await client.sendMessageStream(sendParams);
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      for await (const chunk of stream) {
        if (res.destroyed) break; // 浏览器断开则停止拉取
        if (chunk.kind === "status-update" && chunk.status.message?.parts) {
          res.write(`data: ${JSON.stringify(chunk.status.message.parts)}\n\n`);
        } else if (chunk.kind === "message" && chunk.parts) {
          res.write(`data: ${JSON.stringify(chunk.parts)}\n\n`);
        }
      }
      res.end();
    });
  },
});
```

X-A2A-Extensions 的作用: A2A 协议的扩展协商机制. Server 读取此头, 与自身支持的版本取交集, 选择匹配的 A2UI 版本激活. 如果版本不匹配, A2UI 功能不会被激活, LLM 不会生成 A2UI JSON.

协议转换总结:

- Client 发送: `POST /a2a` 简单 JSON (action) 或纯文本 (查询)
- 中间件转换为: A2A JSON-RPC `message/stream` 请求, 包含 TextPart 或 DataPart (mimeType: application/a2ui+json)
- 附加: `X-A2A-Extensions` 头声明 A2UI v0.9
- Server 流式返回: status-update / message 事件, 中间件逐块转写为 SSE `data:` 帧

### 阶段 6: Server 接收请求, 组装 Prompt

Server 收到 A2A 请求后:

(1) A2UI 扩展激活

```js
// 伪代码
function tryActivateA2uiExtension(clientRequested, serverSupported) {
  // 取交集, 选择最新版本
  const activated = intersect(clientRequested, serverSupported);
  // => 例如激活 v0.9, 返回 AgentExtension 对象
  return getA2uiAgentExtension(activatedVersion);
}
```

(2) 读取 Client 能力

```js
// 伪代码
const a2uiCapabilities = message.metadata?.a2uiClientCapabilities ?? {};
const inlineCatalogs = a2uiCapabilities["v0.9"]?.inlineCatalogs ?? [];
// 若有 inlineCatalogs, 解析后注入 system prompt 的 Catalog Schema 部分
```

(3) 组装 System Prompt

```md
<!-- Role Description -->

You are a helpful assistant. Your final output MUST be a a2ui UI JSON response.

## Workflow Description

- The response can contain one or more A2UI JSON blocks.
- Each A2UI JSON block MUST be wrapped in `<a2ui-json>` and `</a2ui-json>` tags.
- The JSON MUST validate against the provided A2UI JSON SCHEMA.

---BEGIN A2UI JSON SCHEMA---

### Server To Client Schema:

(createSurface / updateComponents / updateDataModel / deleteSurface 的完整 JSON Schema)

### Common Types Schema:

(ComponentId, ChildList, DynamicString, ActionEvent 等公共类型定义)

### Catalog Schema:

(从 inlineCatalogs 或 pre-shared catalog 注入的组件类型定义)
---END A2UI JSON SCHEMA---

### Examples:

(完整的 A2UI JSON 示例, 包含数据绑定的用法)
```

v0.9 是 prompt-first 设计: schema 直接嵌入 prompt 让 LLM 仿写, 不依赖 structured output, 代价是生成后必须做校验和修复.

### 阶段 7: LLM ReAct 推理循环

ADK Agent 内部执行 ReAct (Reason + Act) 循环:

```
LLM 第 1 轮:
  思考: 用户想查找纽约的中餐馆, 我需要调用 get_restaurants 工具
  行动: tool_use("get_restaurants", { cuisine: "chinese", location: "new york" })

Server 执行工具:
  get_restaurants() 读取 restaurant_data.json, 返回 5 家餐厅的 JSON 数据

LLM 第 2 轮:
  思考: 拿到了餐厅数据, 现在生成 A2UI JSON 响应
  行动: 输出包含 <a2ui-json> 标签的 A2UI 消息列表
```

LLM 最终输出的文本示例:

```
根据查询结果, 为您找到纽约排名前 5 的中餐厅:

<a2ui-json>
[
  { "version": "v0.9", "createSurface": { "surfaceId": "default", "catalogId": "..." } },
  { "version": "v0.9", "updateComponents": { "surfaceId": "default", "components": [...] } },
  { "version": "v0.9", "updateDataModel": { "surfaceId": "default", "path": "/", "value": {...} } }
]
</a2ui-json>
```

### 阶段 8: Server 校验 A2UI JSON

Server 从 LLM 输出中提取 `<a2ui-json>` 标签内的 JSON, 进行 Schema 校验:

```js
// 伪代码 (对应 python/ 目录 a2ui_agent 的 parser + schema/validator)
function extractAndValidate(llmOutput) {
  // 1. 正则提取 <a2ui-json>...</a2ui-json> 内容
  const jsonStr = llmOutput.match(/<a2ui-json>([\s\S]*?)<\/a2ui-json>/)[1];

  // 2. 解析 JSON (流式场景下有 payload_fixer 自动修复常见 LLM 输出问题)
  const messages = JSON.parse(jsonStr);

  // 3. 对照 A2UI JSON Schema 校验:
  //    消息类型是否合法、组件类型是否在 catalog 中、
  //    ComponentId 引用是否存在、数据绑定格式是否正确
  const result = validate(messages, a2uiSchema);

  // 4. 校验失败时, 将 VALIDATION_FAILED 错误回喂 LLM 重试
  if (!result.valid && retryCount < 1) {
    return retryWithErrorFeedback(messages, result.errors);
  }
  return messages;
}
```

校验通过后, A2UI 消息列表被包装为 A2A 响应的 parts (kind: data), 通过流式 status-update 事件逐步下发.

Python SDK 侧一个与 schema 相关的细节: 从 JSON Schema 代码生成 Pydantic 模型时 (python/a2ui_core 的 codegen), schema 的 default 关键字只被保留为描述性 hint——注入 "Defaults to X when absent." 到字段 description——而不物化为模型默认值, 属性仍是 Optional/None; 运行时校验器 (payload_validator) 则按 schema 语义在函数调用缺参时从 default 补全. 二者分工明确: 代码生成不固化默认值, 校验与补全留在运行时.

### 阶段 9: Client 流式解析 SSE, 增量渲染

A2UIClient.send 内部按 SSE 帧增量解析, 每个 chunk 立即回调 onChunk:

```ts
// src/client.ts
const contentType = response.headers.get("Content-Type");
if (contentType?.includes("text/event-stream")) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  // A2A status-update 事件携带的是累积 parts, createSurface 会在每个 chunk
  // 中重复下发. 用 Set 记录已转发的 surfaceId, 避免 processMessages 抛
  // "Surface already exists"
  const seenSurfaceIds = new Set<string>();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // 按 SSE 空行切帧, 最后一段不完整的留在 buffer
    const lines = buffer.split(/\r?\n\r?\n/);
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const parts = JSON.parse(line.slice(6)) as Part[];
      const chunkMessages: A2uiMessage[] = [];
      for (const part of parts) {
        if (part.kind === "error") throw new Error(part.text);
        if (part.kind === "data" && part.data) {
          const msg = part.data as A2uiMessage;
          if (msg.createSurface) {
            if (seenSurfaceIds.has(msg.createSurface.surfaceId)) continue;
            seenSurfaceIds.add(msg.createSurface.surfaceId);
          }
          chunkMessages.push(msg);
        }
      }
      onChunk?.(chunkMessages); // => processor.processMessages(chunkMessages)
    }
  }
}
```

要点:

- 渐进渲染: chunk 到达即处理, createSurface 先到就先挂载占位, 组件和数据随后补齐
- 累积 parts 去重: A2A 的 status-update 是累积语义, 客户端必须自行对 createSurface 去重
- 非流式降级: Content-Type 为 application/json 时, 一次性读取 parts 数组

### 阶段 10: MessageProcessor 处理三类消息

以餐厅列表为例, 一个完整响应包含三条消息.

消息 1 -- createSurface (挂载 Surface):

```json
{
  "version": "v0.9",
  "createSurface": {
    "surfaceId": "default",
    "catalogId": "https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json",
    "theme": { "primaryColor": "#FF0000", "font": "Roboto" }
  }
}
```

处理: 校验 catalogId 在本地 catalogs 中存在, 创建 SurfaceModel (含空 DataModel 和 ComponentsModel), 触发 onSurfaceCreated, React 侧 setSurfaces 追加, A2uiSurface 挂载.

消息 2 -- updateComponents (扁平组件列表, 邻接表):

```json
{
  "version": "v0.9",
  "updateComponents": {
    "surfaceId": "default",
    "components": [
      {
        "id": "root",
        "component": "Column",
        "children": ["title-heading", "item-list"]
      },
      {
        "id": "title-heading",
        "component": "Text",
        "variant": "h1",
        "text": { "path": "/title" }
      },
      {
        "id": "item-list",
        "component": "List",
        "direction": "vertical",
        "children": { "componentId": "item-card-template", "path": "/items" }
      },
      {
        "id": "item-card-template",
        "component": "Card",
        "child": "card-layout"
      },
      {
        "id": "card-layout",
        "component": "Row",
        "children": ["template-image", "card-details"]
      },
      {
        "id": "template-image",
        "component": "Image",
        "url": { "path": "imageUrl" },
        "weight": 1
      },
      {
        "id": "template-name",
        "component": "Text",
        "variant": "h3",
        "text": { "path": "name" }
      },
      {
        "id": "template-book-button",
        "component": "Button",
        "child": "book-now-text",
        "variant": "primary",
        "action": {
          "event": {
            "name": "book_restaurant",
            "context": {
              "restaurantName": { "path": "name" },
              "imageUrl": { "path": "imageUrl" },
              "address": { "path": "address" }
            }
          }
        }
      },
      { "id": "book-now-text", "component": "Text", "text": "Book Now" }
    ]
  }
}
```

v0.9 组件对象的结构要点:

- id + component 为必填字段, 其余属性 (text / children / action / variant...) 直接平铺在组件对象上, 没有 v0.8 的 params 包裹
- children 两种形态 (ChildList):
  - 数组: 静态 ComponentId 引用列表, 如 `["a", "b"]`
  - 对象: 列表模板 `{ componentId, path }`, 监听 path 指向的数组, 为每个元素实例化模板组件
- child: 单个 ComponentId 引用 (如 Card 的 child、Button 的 child)
- 组件可以乱序到达、可以引用尚不存在的子组件或数据路径, 客户端渲染占位 (React 中是 `[Loading {id}...]`), 这就是渐进渲染

消息 3 -- updateDataModel (填充数据):

```json
{
  "version": "v0.9",
  "updateDataModel": {
    "surfaceId": "default",
    "path": "/",
    "value": {
      "title": "Top 5 Chinese Restaurants in New York",
      "items": [
        {
          "name": "Xi'an Famous Foods",
          "rating": "★★★★☆",
          "imageUrl": "https://...",
          "address": "81 St Marks Pl..."
        },
        {
          "name": "Han Dynasty",
          "rating": "★★★★☆",
          "imageUrl": "https://...",
          "address": "90 3rd Ave..."
        }
      ]
    }
  }
}
```

处理: 按 JSON Pointer (RFC 6901) 路径做 upsert 写入 DataModel: 路径存在则更新, 不存在则创建, 省略 value 则删除该键. DataModel 变化自动触发绑定了该路径的组件更新.

注: 上例的 rating 字段是评分数据的字符串值 (★ 表示一星, 共五格), 属于示例数据内容而非正文装饰.

### 阶段 11: 数据绑定与双向绑定

数据绑定是 A2UI 的核心设计, 将组件属性与 DataModel 中的数据关联. v0.9 中任何 Dynamic\* 属性都接受三种取值: 字面量、`{ path }` 绑定、`{ call, args }` 函数调用.

(1) 绝对路径绑定 -- 以 "/" 开头, 从 DataModel 根节点解析

```json
{ "id": "title-heading", "component": "Text", "text": { "path": "/title" } }
```

(2) 相对路径绑定 -- 不以 "/" 开头, 在列表模板作用域内解析

```json
{ "id": "template-name", "component": "Text", "text": { "path": "name" } }
```

当 template-name 位于 item-list 的模板中时, 每个列表项有独立的作用域 (例如第 0 项的 DataContext.path 是 `/items/0`), 相对路径 `name` 解析为 `/items/0/name`. 模板内部仍可用绝对路径访问根作用域.

(3) 列表模板绑定 -- ChildList 对象形态

```json
{
  "id": "item-list",
  "component": "List",
  "children": { "componentId": "item-card-template", "path": "/items" }
}
```

内部处理流程:

```
DataModel 中 /items = [{ name: "A" }, { name: "B" }]
  => GenericBinder 订阅 /items 路径
  => 数组变化时, 为每个元素实例化模板, basePath 分别为 "/items/0"、"/items/1"
  => 模板内 "name" 相对路径解析为 "/items/0/name"
  => 渲染 Card, 文本为 "A"
```

(4) 双向绑定 -- 输入组件直接写本地 DataModel

预订表单 (booking-form Surface) 中的输入组件:

```json
{ "id": "party-size-field", "component": "TextField", "label": "Party Size", "value": { "path": "/partySize" }, "variant": "number" },
{ "id": "datetime-field", "component": "DateTimeInput", "label": "Date & Time", "value": { "path": "/reservationTime" }, "enableDate": true, "enableTime": true },
{ "id": "dietary-field", "component": "TextField", "label": "Dietary Requirements", "value": { "path": "/dietary" } }
```

读写契约:

- Read (Model -> View): 渲染时从绑定路径读值; 服务端 updateDataModel 更新后组件自动重渲染
- Write (View -> Model): 用户输入时立即写回本地 DataModel 对应路径, 不发网络请求
- 反应式: 本地 DataModel 是唯一数据源, 绑定同一路径的其他组件实时联动

GenericBinder 的 Schema 驱动机制:

GenericBinder 绑定属性时读取组件的 Zod schema, 将属性分类处理:

- DYNAMIC: 需要数据绑定的属性 (text / url / value) -> 创建订阅, 值变化时更新 snapshot
- ACTION: 事件属性 (action) -> 创建闭包, 触发时解析 context 中的绑定并派发事件
- STRUCTURAL: 结构属性 (children / child) -> 构建子组件列表, 订阅数组路径
- CHECKABLE: 可校验属性 (checks) -> 执行 catalog 注册的校验函数 (required / regex / email...)
- STATIC: 静态属性 (variant / label) -> 直接赋值

### 阶段 12: React 渲染器内部机制

@a2ui/react/v0_9 把 web_core 的模型层桥接到 React, 核心是 NodeResolver / NodeView 的 node layer 架构 (renderers/react/src/v0_9/A2uiSurface.tsx:52-100): A2uiSurface 构造一个 NodeResolver (由 @a2ui/web_core/v0_9 导出, 实现在 typescript/web_core/src/resolution/node-resolver.ts), 渲染它维护的已解析 ComponentNode 树. 组件解析、数据作用域与属性绑定全部下沉到 web_core 的 node layer, React 侧只做分发渲染:

```tsx
// A2uiSurface: 入口, 用 useSyncExternalStore 订阅 NodeResolver 的 rootNode
export const A2uiSurface = ({ surface }) => {
  // resolver 在 subscribe 内创建: React 只对已提交的渲染调用它,
  // 被丢弃的渲染 (并发模式 / Suspense) 不会构造 resolver, unsubscribe 负责 dispose
  const subscribe = useCallback(
    (onChange) => {
      const resolver = new NodeResolver(surface, surface.defaultCatalog);
      box.resolver = resolver;
      const stopEffect = effect(() => {
        getValue(resolver.rootNode);
        onChange();
      });
      return () => {
        stopEffect();
        resolver.dispose();
      };
    },
    [surface, box],
  );
  const getSnapshot = useCallback(
    () => (box.resolver ? peekValue(box.resolver.rootNode) : undefined),
    [box],
  );
  const root = useSyncExternalStore(subscribe, getSnapshot);

  if (!root) return <LoadingPlaceholder componentId="root" />;
  return (
    <NodeSurfaceContext.Provider value={surface}>
      <NodeView surface={surface} node={root} />
    </NodeSurfaceContext.Provider>
  );
};
```

(1) NodeResolver -- 把组件模型解析为响应式 ComponentNode 树

NodeResolver (typescript/web_core/src/resolution/node-resolver.ts) 把 SurfaceModel 中的每个 ComponentModel 解析为 ComponentNode (typescript/web_core/src/resolution/component-node.ts): 节点 props 是 Signal 驱动的已解析值——动态绑定为 ResolvedBinding, action 属性为可直接调用的闭包, child 属性为活的 ComponentNode 引用 (或其数组) ; 节点另暴露只读的 context (resolver 绑定该节点所用的 ComponentContext, 占位期间为 undefined, 对渲染器公开, 供视图查询数据作用域与执行边界) . 组件尚未到达时生成 isPlaceholder 占位节点, 到达后原位替换, 渐进渲染由 node layer 统一承担; 属性绑定由 GenericBinder (resolution/generic-binder.ts) 按 catalog schema 刮取的行为 (DYNAMIC / ACTION / STRUCTURAL / CHECKABLE / STATIC, 见阶段 11 分类) 建立订阅.

该 node layer 是框架无关的契约, 并且已跨语言复制: Dart 的 a2ui_core 实现了同构的 resolution 层 (dart/a2ui_core/lib/src/resolution/ 下的 component_node / node_resolver / ref_fields / resolved_binding), 仓库 conformance 套件以 core/node_resolution.yaml 用例钉住, Dart 与 TypeScript web_core 对各自的 NodeResolver 跑同一套用例; 同一 conformance 目录还覆盖 core/expressions.yaml (formatString 背后的客户端表达式解析器) 与 core/data_model.yaml、core/data_context.yaml (DataModel/DataContext 跨语言 parity: 路径 upsert/删除语义与作用域相对路径解析逐语言对齐) . Dart 侧对外的 API 面很窄——GenericBinder / Behavior / BehaviorNode / ComponentContext 不再导出 (lib/a2ui_core.dart 对 contexts.dart hide ComponentContext, 对 binder.dart 只 show ChildNode 等少量符号) , 渲染器一律经 NodeResolver / ComponentNode 读组件, 动态属性以 ResolvedBinding 承载 (可写绑定是 WritableBinding, 写入走 WritableBinding.set), SurfaceModel.dispatchAction 只对 event 载荷派发动作, functionCall 由节点的 action 闭包本地执行 (闭包先识别 {functionCall: {call, args}} 与展开的 {call, args} 形态并经 dataContext.resolveSync 本地求值, 其余才走 dispatchAction 发往 agent) . web_core 的 universal elements (Lit/Web Components 形态的 basic catalog 实现, typescript/web_core/src/universal/) 同样接入 node layer: renderA2uiNode 有 ComponentNode 重载, 把已解析节点直接渲染为实现的自定义元素并传入 .node 与 .context, 占位、已 dispose 或非 Web Component 实现一律返回 nothing; 另一重载仍是 (context, catalog) 形态.

要点: 组件树解析、存在性与数据作用域 (dataPath) 管理不再由 React 组件逐层订阅事件完成, 而是集中在 NodeResolver 内; 节点仅在自身已解析属性变化时发出信号 (子节点内部属性变化不触发父节点), 更新范围被限制在单个组件粒度, 避免整棵树重渲染.

(2) NodeView -- 按节点状态分发渲染, 递归构建子节点

```tsx
// renderers/react/src/v0_9/node-view.tsx (节选, NodeView 在 331 行起)
const NodeView = memo(({ surface, node }) => {
  // buildChild: 已解析的子节点递归渲染; 解析器未能归类的 id 报告具体原因
  const buildChild = useCallback(
    (child, basePath) => {
      if (isComponentNode(child)) {
        return (
          <NodeView key={child.instanceId} surface={surface} node={child} />
        );
      }
      return (
        <UnresolvedChildReference surface={surface} id={child} /* ... */ />
      );
    },
    [surface, node],
  );

  if (node.state === "unknown-type")
    return <div>Unknown component type: {node.type}</div>;
  if (node.isPlaceholder)
    return <LoadingPlaceholder componentId={node.componentId} />; // 渐进渲染占位
  const impl = node.impl;
  const View = impl?.view;
  if (!View)
    return <RenderFallback node={node} impl={impl} buildChild={buildChild} />;
  return <View node={node} buildChild={buildChild} />;
});
```

要点: NodeView 只做分发——把每个实现的 view 拿到自己的 node 与渲染已解析子节点的 buildChild. node-view.tsx 中的 useNodeView (renderers/react/src/v0_9/node-view.tsx:240) 通过 useSignalValue 订阅 node.props (仍以 useSyncExternalStore 把 web_core 的信号系统接入 React 18 的外部存储模型), 把解析后的 props 适配回现有视图实现的 ReactA2uiComponentProps 形状, 并构造 ComponentContext 与字符串 id 的 buildChild, 数据变化只重渲染受影响的组件.

(3) createComponentImplementation -- GenericBinder 接入 useSyncExternalStore

basic catalog 中的每个组件 (Text / Button / TextField...) 都通过此工厂包装 (renderers/react/src/v0_9/adapter.tsx):

```tsx
const ReactWrapper = ({ context, buildChild }) => {
  const bindingRef = useRef<GenericBinder | null>(null);
  if (!bindingRef.current) {
    // 按组件的 Zod schema 创建绑定器
    bindingRef.current = new GenericBinder(context, api.schema);
  }
  const binding = bindingRef.current;

  // binder 内部订阅 DataModel, 任何绑定值变化都会 bump snapshot
  const subscribe = useCallback(
    (callback: () => void) => {
      const sub = binding.subscribe(callback);
      return () => sub.unsubscribe();
    },
    [binding],
  );
  const getSnapshot = useCallback(() => binding.snapshot, [binding]);
  // snapshot 是已解析好的 props: 字面量/绑定值/函数结果/action 闭包
  const props = useSyncExternalStore(subscribe, getSnapshot);

  useEffect(() => () => binding.dispose(), [binding]); // 卸载时释放 DataModel 订阅

  return (
    <MemoizedRender props={props} buildChild={buildChild} context={context} />
  );
};
```

整体数据流:

```
A2UI 消息流
  -> MessageProcessor.processMessages
  -> SurfaceModel (DataModel + ComponentsModel, 信号/事件驱动)
  -> NodeResolver: 解析为响应式 ComponentNode 树, 未到达组件生成 isPlaceholder 占位
  -> GenericBinder: 按 schema 解析属性, 订阅 DataModel 路径
  -> A2uiSurface / NodeView: useSyncExternalStore 订阅 rootNode, 按节点分发渲染
  -> 具体 React 组件 (memo) 渲染
```

细粒度更新的本质: React 只负责组件实例的挂载/卸载决策, 属性级别的响应式更新由 web_core 的订阅机制 + useSyncExternalStore 完成, 不依赖 React 的自顶向下 diff.

### 阶段 13: 用户交互 (Action 事件)

用户点击 "Book Now" 按钮, 触发完整链路:

(1) Button 组件的 action 闭包被触发, GenericBinder 先解析 context 中的数据绑定 (相对路径在当前列表项作用域内解析), 得到:

```json
{
  "name": "book_restaurant",
  "context": {
    "restaurantName": "Hwa Yuan Szechuan",
    "imageUrl": "https://...",
    "address": "40 E Broadway, New York, NY 10002"
  }
}
```

(2) 事件冒泡到 SurfaceGroupModel.onAction, 进入 App.tsx 的全局 actionHandler, 封装为 v0.9 action 消息并发送:

```tsx
// App.tsx
const processor = new MessageProcessor([basicCatalog], (action) => {
  sendAndProcessRef.current?.({ version: "v0.9", action });
});
```

(3) 中间件检测到 body 是 JSON 对象, 包装为 A2A DataPart (mimeType: application/a2ui+json) 转发给 Server.

(4) Server 将 UI 事件翻译为 LLM 可理解的自然语言, 注入下一轮对话:

```
USER_WANTS_TO_BOOK: The user clicked "Book" on restaurant "Hwa Yuan Szechuan"
at address "40 E Broadway, New York, NY 10002". They want to make a reservation.
```

(5) LLM 生成预订表单的 A2UI JSON (新的 booking-form Surface, 含 TextField / DateTimeInput / 提交按钮), 走相同的消息流返回渲染.

(6) 用户填写表单 (双向绑定只更新本地 DataModel), 点击 Submit Reservation, 提交按钮的 context 直接引用表单数据路径:

```json
{
  "id": "submit-button",
  "component": "Button",
  "child": "submit-reservation-text",
  "variant": "primary",
  "action": {
    "event": {
      "name": "submit_booking",
      "context": {
        "restaurantName": { "path": "/restaurantName" },
        "partySize": { "path": "/partySize" },
        "reservationTime": { "path": "/reservationTime" },
        "dietary": { "path": "/dietary" },
        "imageUrl": { "path": "/imageUrl" }
      }
    }
  }
}
```

点击时客户端解析这些路径 (拿到用户刚输入的值), 随 action 发回 Server, LLM 再生成确认卡片 (confirmation Surface). 这就是 列表 -> 表单 -> 确认 的三轮闭环.

### 阶段 14: Session 管理

多轮对话在 A2A 协议中通过 contextId 标识: 同一 contextId 下的消息共享对话历史. Server 端的 restaurant_finder 直接消费这个标识 —— agent_executor.py 把 task.context_id 作为 session_id 传给 RestaurantAgent.stream, agent 侧 InMemorySessionService 按 session_id 不存在则创建、存在则复用会话, DirectJsonStreamParser 也按 session_id 缓存; 一旦 contextId 稳定, LLM 就能在后续轮次看到之前的对话上下文 (包括之前生成的 A2UI 消息和工具调用结果).

需要说明: 本仓库两个 shell 的中间件都没有显式传 contextId —— 每次请求只携带新的 messageId, 不附加 configuration.contextId, 也不捕获 Server 返回的 contextId 复用, 因此 demo 中每一轮实际都是全新上下文, 多轮连续性 (列表 -> 表单 -> 确认) 不依赖服务端会话记忆, 而是靠 action 消息的 context 自带全部所需数据 (restaurantName / address / imageUrl / 表单字段值等). 显式传递 `configuration: { contextId }` (或把 status-update 中获得的 contextId 在后续请求回传) 共享对话历史是 A2A 的通用能力, 生产接入需自行实现.

## 组件加载时的 Loading (骨架) 实现

A2UI 协议本身没有 loading 语义 (四类消息中没有任何 loading 状态字段) , 渐进渲染期间的占位完全是渲染器/宿主侧的实现问题。协议现状已提供的基础: node layer 对未到达组件以 LoadingPlaceholder (renderers/react/src/v0_9/node-view.tsx:63-64) 渲染 `[Loading {id}...]` 纯文本占位; root 未到达前其余组件更新被缓冲, 不产生可见效果; 绑定路径解析为 undefined 时规范建议按空串或 loading 优雅处理。据此可以把 loading 分为三层, 分别对应三类消息的到达状态:

### 第一层: Surface 级 (createSurface 已到, 组件与数据未到)

createSurface 到达即触发 onSurfaceCreated, 宿主立即挂载该 Surface 并渲染整体骨架卡 (标题条 + 文本条 + 图块的 Skeleton 组合) ; root 组件到达后由 NodeResolver 原位替换占位节点、NodeView 接管渲染, 骨架消失。yukino-agent 链路中 a2ui 块校验后一次性下发, message 事件与 a2ui 事件之间的等待窗口即对应这一层。

### 第二层: 组件级 (updateComponents 部分到达)

组件乱序/流式到达时, 父组件已挂载而子组件 id 尚未到达。LoadingPlaceholder 是天然挂载点, 把官方的纯文本占位替换为骨架块:

```tsx
if (!componentModel) return <Skeleton className="h-4 w-full animate-pulse" />;
```

此层不知道组件类型 (组件还没到) , 用通用灰块/脉冲; 占位块位于父布局的子槽位中, 天然保持最终布局位置。组件到达后 useSyncExternalStore 的 snapshot 从 missing-$\{version\} 切到 $\{type\}-$\{version\}, 骨架自动替换为真实渲染, 无需任何额外状态管理。可选优化: 依据已到达的父组件类型改进骨架形状 (父为 List 时渲染列表骨架)。

### 第三层: 数据级 (组件已到, updateDataModel 未到或部分到达)

组件结构已知而 Dynamic 绑定值解析为 undefined。此层可渲染精确形状的骨架: Text -> 文本条, Image -> 图块, Avatar -> 圆形。关键在于区分 "数据未到" 与 "值确实为空" —— 协议消息不区分这两者, 需要渲染器自建 settled (数据定型) 信号:

- 信号源: MessageProcessor 单批 processMessages 处理完成 / yukino-agent SSE 的 done 事件 / 短超时 (窗口内无新消息视为定型, 工程选择)
- 在 SurfaceModel 上维护 settled 标志并传入渲染上下文: 绑定值为 undefined 且未 settled 时渲染骨架, settled 后渲染空串 —— 正好对应规范 "空串或 loading" 的两个合法选项

### 工程要点

1. 骨架是渲染器本地行为, 不进 catalog、不污染协议: Agent 不能也不需要请求骨架。骨架视觉可直接复用组件库现成的 Skeleton / Spinner 原语, 但作为渲染器内部实现使用, 不注册进 catalog.json
2. 防闪烁: 骨架与内容切换加 fade 过渡; 骨架设最短显示时长, 避免数据瞬间到达时的闪烁
3. 三层共用同一 settled 信号与骨架视觉: Surface 级骨架在 root 到达时移除, 组件级在 snapshot 切换时移除, 数据级在 settled 且值非 undefined 时移除
4. Lit 渲染器同理: 在组件缺失分支渲染骨架, 信号机制复用 web_core 的订阅事件

## A2UI 与 Schema-driven UI、低代码的对比

术语约定: 本节的 "Schema-driven UI" 指 "用 JSON Schema (或等价结构化 schema) 描述数据与字段约束, 由通用渲染器映射为表单/界面" 的方案, 代表实现有 react-jsonschema-form (JSON Schema + uiSchema) 、JSONForms (JSON Schema + UI Schema, scope 用 JSON Pointer 定位) 、Formily、form-render (阿里 XRender 家族) 等; "低代码" 指 "人在可视化编辑器中搭建, 平台产出专有 DSL/JSON, 运行时渲染完整应用" 的平台, 代表实现有 amis (百度开源的 JSON 配置驱动低代码前端框架) 、Retool、OutSystems、Mendix. amis 介于两者之间: 它以 JSON 为载体 (类似 Schema-driven) , 但覆盖整页应用且配有可视化编辑器 (更像低代码) , 官方自我定位即低代码前端框架. 与 OpenAI ChatKit 的对比见前文 "生态与定位" 一节, 本节不再重复.

### 一句话定位

- A2UI: 运行时由 LLM 按请求生成的、面向跨信任边界的流式声明式 UI 协议
- Schema-driven UI: 设计时由开发者或后端接口下发的数据 schema, 渲染器生成表单, 表达范围以表单为主
- 低代码: 设计时由人在可视化编辑器中搭建的专有 DSL, 运行时渲染完整应用, 表达力最强但 DSL 封闭

三者共享同一个祖先思想 — "UI 即数据, 由统一渲染器解释", 这正是 A2UI 第二设计哲学 (声明式组件) 的来源; 差异集中在四个问题: 描述由谁产出、何时产出、能表达什么、要不要信任产出者.

### 概念对照表

| 维度        | A2UI                                                                                             | Schema-driven UI                                        | 低代码                                                                    |
| :---------- | :----------------------------------------------------------------------------------------------- | :------------------------------------------------------ | :------------------------------------------------------------------------ |
| UI 描述载体 | A2UI 消息流 (createSurface / updateComponents / updateDataModel)                                 | JSON Schema + uiSchema (或 Formily schema 等等价物)     | 平台专有 DSL/JSON                                                         |
| 描述的作者  | LLM/Agent, 运行时按请求生成                                                                      | 开发者或后端接口, 设计时产出                            | 人, 在可视化编辑器中搭建                                                  |
| 组件契约    | catalog (catalogId + 组件 JSON Schema + 函数表) , 支持 supportedCatalogIds / inlineCatalogs 协商 | 渲染器内置控件集, uiSchema 指定 widget 或注册自定义组件 | 平台物料库, 由平台固定                                                    |
| 结构与数据  | 彻底分离: 组件树 (邻接表) 与 DataModel (JSON Pointer 绑定) 是两类消息                            | 分离: schema 描述字段结构, formData 承载数据            | 通常混合: DSL 中同时描述结构、数据源与联动                                |
| 更新模型    | 流式增量消息, 单条原子, 支持渐进渲染与乱序到达                                                   | 整份 schema 一次性渲染, 值更新由表单库内部管理          | 运行时整体渲染, 联动/刷新由平台事件机制管理                               |
| 逻辑表达    | 仅 catalog 函数 (校验/格式化/逻辑组合) + 声明式 action (event/functionCall) , 无代码执行面       | JSON Schema 约束表达校验, 表达力限于数据约束            | 最强: 事件编排、数据源编排, 多数平台提供自定义 JS 扩展点 (引入代码执行面) |
| 信任假设    | Agent 可能不可信, 白名单渲染, 为跨信任边界设计                                                   | schema 由可信方产出                                     | DSL 由平台内可信用户产出                                                  |
| 可校验性    | JSON Schema 全量校验 + generate-validate-repair 闭环                                             | JSON Schema 原生校验                                    | 编辑器内校验                                                              |
| 表达范围    | 对话内动态卡片/表单/图表 (官方 basic catalog 18 组件, catalog 可由客户端按需扩展)                | 以表单为核心                                            | 完整应用 (页面/流程/权限)                                                 |
| 生态开放度  | 开放标准, 官方多渲染器 (React/Lit/Angular/Flutter/Markdown)                                      | 开源渲染器各自为政, schema 形态互不完全兼容             | DSL 平台封闭, 不可跨平台移植                                              |

### 关键差异展开

1. 生成时机决定工程形态. 低代码与 Schema-driven UI 的描述都是设计时产物, 可以反复调试、测试、缓存; A2UI JSON 是运行时产物, 天然携带 LLM 的错误率, 因此必须配套 "校验 + 有限次纠错 + 诚实降级" 的运行时兜底 (见下一节) . 这是低代码平台根本不需要考虑的问题.
2. 信任边界决定逻辑表达上限. 低代码平台敢于提供自定义 JS 与表达式引擎, 是因为 DSL 由自家可信用户产出; A2UI 显式假设 Agent 可能不可信 (跨组织的多 Agent 场景) , 协议层面不提供任何代码执行通道, 逻辑被收紧为 catalog 函数与声明式 action. 低代码的强表达力是以放弃跨信任边界安全为代价的, 两者不能简单互相替代.
3. 组件契约的协商性. 低代码的物料库是平台事实标准; Schema-driven UI 的控件集由渲染器决定; A2UI 把 "客户端支持什么" 协议化为 catalog 并支持两种协商模式 (pre-shared catalogId 与 inlineCatalogs 全量 schema 注入) , Agent 在生成前就知道边界. 官方明确不追求跨客户端的标准化 catalog, 理由是 UI 由 LLM 生成, LLM 可以针对每个前端解释各自的 catalog.
4. 更新模型为流式而生. Schema-driven UI 与低代码都假设 "一次给全, 渲染一次"; A2UI 的扁平邻接表、乱序可达、root 缓冲、模板绑定, 全部为 "LLM 边生成边渲染" 服务. 反过来看, 若把 A2UI 的三类消息一次性发全, 其形态与一份低代码页面配置已非常接近 — 本质区别在于数据模型独立成消息、所有动态值都有 \{path\} / \{call\} 绑定形态.
5. 数据绑定思想同源. A2UI 的 Dynamic 三态 (字面量 / \{path\} / \{call\}) 与 Schema-driven UI 的 "schema 描述结构、formData 承载值" 是同一种结构与状态分离思想; JSON Pointer (RFC 6901) 直接复用 JSON 生态标准. 可以说 A2UI 的数据绑定子集约等于 Schema-driven UI 的核心, 而 Schema-driven UI 缺少 A2UI 的组件树流式协议与 catalog 协商.

### 关系与选型

- A2UI 可以理解为: 把低代码的产出物从 "设计时人工 DSL" 变成 "运行时 LLM 产物", 并为此把 DSL 收紧 — 无代码执行、白名单 catalog、schema 全量可校验
- catalog.json 本身就是 JSON Schema 集合, 与 Schema-driven UI 的 schema 在数据层面同构, 因此 A2UI 消息可以确定性转换为 JSON Schema 表单 (见下一节 L5)
- 选型参考: 表单为主且字段由后端定义, 用 Schema-driven UI (成熟, 零 LLM 成本) ; 已有可视化搭建/专有 DSL 平台, 继续用低代码, A2UI 仅在需要 LLM 动态生成界面的对话场景引入; Agent 生成 UI、跨信任边界、多端渲染, 用 A2UI

---

## LLM 生成 A2UI JSON 失败时的降级策略

本文档主线链路已经内建了最小降级闭环: extractA2ui 提取标签块 -> A2uiMessageListSchema.safeParse 校验 -> correctA2uiBlock 一次纠错重试 -> 失败降级为 notice 提示, 绝不伪造 UI 数据. 本节把这条闭环展开为完整体系: 先分类失败形态, 再给出降级原则与六级降级阶梯, 重点补充两类确定性转换降级 (A2UI -> Markdown 与 A2UI -> Schema-driven 表单/低代码 JSON) .

### 失败形态分类

1. 截断类: 流式输出中断导致 JSON 不完整、a2ui-json 标签未闭合. createA2uiStreamFilter 对未闭合块已在 flush 时还原为纯文本而非静默丢弃, 这本身就是一种被动降级
2. 语法类: 尾逗号、单引号、未转义换行等 JSON 语法错误. 官方 agent SDK 的解析环节包含 payload_fixer, 自动修复常见 LLM 输出问题 (见阶段 8) ; 社区有同类开源实现 (如 jsonrepair)
3. Schema 类: 字段形态错误 (校验错误形如 "Expected stringOrPath, got integer") 、组件不在 catalog、未知属性
4. 引用类: ComponentId 悬空、数据路径错误. 协议对这类错误有内建容忍 — 组件可乱序到达、可引用尚不存在的子组件或数据路径, 客户端渲染占位等待补齐
5. 生命周期类: 缺 createSurface、root 缺失、杂散 createSurface (触发 "Surface already exists" 整批丢弃) 、surfaceId 不一致. 这类错误破坏协议状态机, yukino-agent 的 filterInPlaceMessages 就是针对它的服务端防御

协议自身对失败的最小要求 (A2A 扩展规范) : 单条消息校验/应用失败时记录错误并继续处理后续消息, 原子性只在单条消息级别保证; 渐进渲染期间路径解析为 undefined 时渲染器应优雅处理. 超出这个范围的部分 (整批失败怎么办、如何转格式) 是应用层策略, 即本节内容.

### 降级原则

1. 永不崩溃、永不渲染非法状态: 客户端 A2uiView 的逐条 safeParse 丢弃是最后一道闸, 所有降级手段都必须保证最终下发的是可渲染数据
2. 语义保真度逐级下降, 安全性绝不下降: 任何降级目标 (Markdown、JSON Schema 表单、低代码 JSON) 仍必须是纯声明式数据, 不引入代码执行面
3. 保数据优先于保结构: updateDataModel 与 markdown 正文往往独立合法; 结构损坏时数据还在, DataModel 本身就能支撑降级渲染
4. 确定性转换优先于 LLM 修复, LLM 修复优先于放弃: 确定性转换零成本、无额外幻觉面、可单测
5. 诚实降级: 降级必须对用户可见 (提示当前为降级视图) , 绝不伪造 UI 数据

一个关键观察: direct-json 模式下, LLM 的 markdown 正文与 a2ui 块共用同一输出通道, 正文天然存在. 因此降级的本质是 "交互增强失效, 文字回答仍在"; 降级策略的全部目标是尽量保住增强, 而不是保住回答.

### 降级阶梯

| 级别          | 手段                                                                                          | 是否需要 LLM     | 触发条件                   | 产物                         |
| :------------ | :-------------------------------------------------------------------------------------------- | :--------------- | :------------------------- | :--------------------------- |
| L0 预防       | prompt 注入 schema 契约 + few-shot builder 示例                                               | - (生成侧工程)   | 常驻                       | 降低失败率, 是后续一切的前提 |
| L1 解析级修复 | 流式过滤器 + JSON 修复 (补截断/去尾逗号等, payload_fixer 思路)                                | 否               | JSON 语法错误或截断        | 语法合法的消息数组           |
| L2 纠错重试   | correctA2uiBlock: 关闭工具, 回喂校验错误, 只重试一次                                          | 是 (一次)        | safeParse 失败             | 通过校验的消息数组           |
| L3 消息级抢救 | 逐条 (必要时逐组件) safeParse, 保留合法消息并重排 (createSurface 置于该 Surface 其余消息之前) | 否               | 重试后仍失败               | 部分合法的消息数组           |
| L4 数据直出   | 放弃组件树, 将 DataModel 渲染为 Markdown (键值/列表/表格)                                     | 否               | 组件树不可修复             | Markdown                     |
| L5 格式转换   | 组件树 + DataModel 确定性转换为 Markdown / JSON Schema 表单 / 低代码 JSON                     | 否 (可 LLM 补充) | 组件树可解析但整体校验失败 | 等价声明式 UI                |
| L6 诚实降级   | notice 提示 + 保留纯文本正文                                                                  | 否               | 全部失败                   | 纯文本回答                   |

L3 与协议的最小要求对齐 (逐条处理、单条原子) , 是从 "整批成败" 切换到 "逐条成败" 的关键一步; L4/L5 是转换降级, 详见下文.

决策流程:

```
<a2ui-json> 块提取
  -> L1 语法修复 (未闭合块已在流式过滤器还原为纯文本)
  -> 整批 safeParse
       通过 -> 正常下发
       失败 -> L2 纠错重试 (一次)
                通过 -> 正常下发
                失败 -> L3 逐条抢救
                         存在合法 createSurface + 可解析组件树 -> L5 确定性转换 (Markdown / 表单 / 低代码 JSON)
                         仅剩合法 updateDataModel            -> L4 DataModel 直出 Markdown
                         全部不可用                          -> L6 notice + 纯文本正文
```

### A2UI 到 Markdown 的转换规则

适用: 只需要展示层兜底; 宿主已有 Markdown 渲染 (Text 组件本身支持简单 Markdown, yukino-agent 正文即 Markdown, @a2ui/markdown-it 可复用) . 转换器输入是 L3 抢救后的消息数组, 步骤:

1. 用邻接表 Map\<ComponentId, Component> 从 root 递归重建组件树
2. 合并所有合法 updateDataModel 的 upsert 得到 DataModel
3. 展开列表模板: children 为 \{componentId, path\} 时读取 DataModel[path] 数组, 逐元素实例化模板, 相对路径按 /items/0/name 形式展开, 与协议模板作用域语义一致
4. 按下表映射输出 Markdown:

| A2UI 组件               | Markdown 输出                                 |
| :---------------------- | :-------------------------------------------- |
| Text (variant h1/h2/h3) | # / ## / ### 标题                             |
| Text                    | 段落                                          |
| Image                   | `![](url)`                                    |
| List + 模板             | 列表项 (每个数据元素一项)                     |
| Table (rows 绑定)       | Markdown 表格                                 |
| Card                    | 引用块或拍平                                  |
| Row / Column / Divider  | 拍平为线性内容                                |
| Button                  | 省略, 或以文字注明可执行操作及其参数          |
| TextField 等输入组件    | 列出字段名与 DataModel 当前值, 注明交互不可用 |

5. Dynamic 值解析: 字面量直接输出; \{path\} 从 DataModel 解析, 解析为 undefined 时按协议类型转换规则输出空串; \{call\} 可执行 BASIC_FUNCTIONS 中的纯函数 (formatDate/formatNumber 等) , 无法执行时输出空串

安全说明: 输出是纯文本, 渲染走宿主既有 Markdown 管线 (sanitization 职责与渲染 Text 组件时一致) , 不引入新的安全面.

### A2UI 到 Schema-driven 表单的转换规则

适用: 希望保留表单交互能力 (A2UI 生成的典型交互形态就是表单: 预订表单、静默表单) , 且宿主已有 JSON Schema 表单渲染器 (react-jsonschema-form / JSONForms / Formily / form-render 任一) . 产出 JSON Schema + uiSchema:

| A2UI 组件                                           | JSON Schema / uiSchema                         | 说明                                                                                                                                                                          |
| :-------------------------------------------------- | :--------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TextField (value.path = /partySize, variant number) | \{ partySize: \{ type: number \} \}            | 字段名取绑定路径末段                                                                                                                                                          |
| TextField                                           | \{ type: string \}                             |                                                                                                                                                                               |
| CheckBox                                            | \{ type: boolean, default: DataModel 当前值 \} |                                                                                                                                                                               |
| ChoicePicker (选项为字面量)                         | \{ type: string, enum: [...] \}                | 选项为 \{path\} 时先从 DataModel 解析                                                                                                                                         |
| DateTimeInput                                       | \{ type: string, format: date 或 date-time \}  | 由 enableDate/enableTime 决定                                                                                                                                                 |
| Slider (若携带 min/max 属性)                        | \{ type: number, minimum/maximum \}            |                                                                                                                                                                               |
| checks 数组                                         | 同义 JSON Schema 关键字                        | required -> required; regex -> pattern; length -> minLength/maxLength; email -> format: email; numeric -> type: number. BASIC_FUNCTIONS 校验函数与 JSON Schema 关键字一一对应 |
| label                                               | uiSchema 标题                                  |                                                                                                                                                                               |

数据填充: DataModel 中对应路径的值作为 formData 初始值 — 协议中双向绑定的输入组件本来就以 DataModel 为唯一数据源, 语义等价.

交互回传: 表单提交时, 从 action.context 中引用的路径 (相对路径按模板作用域展开为绝对路径) 从 formData 取值, 还原出与 A2UI action 完全同构的 \{name, surfaceId, sourceComponentId, context\} 事件发给 Agent, Agent 侧无感知. 前提是 context 绑定均为简单路径引用 (实际生成中绝大多数如此) ; 含 \{call\} 的 context 值退化为空串或省略.

不能无损转换的部分: 布局 (Row/Column/weight) 、Tabs/Modal 等容器、Chart 可视化 — 一律降级为字段列表或说明文字. 因此该路径适合作为表单类 surface 的降级目标, 而非全部 surface.

### A2UI 到低代码 JSON 的转换

适用: 团队已有 amis 等低代码渲染资产, 复用其渲染器兜底. 以 amis 为例的示意映射: Card -> card, Table -> table, TextField -> input-text, CheckBox -> checkbox, ChoicePicker -> select, DateTimeInput -> input-datetime, Slider -> slider, Button -> button (声明式 actionType, 如 ajax/url) .

安全红线: 低代码平台普遍提供表达式引擎与自定义 JS 扩展点; 从 LLM 产出的消息转换而来的字段, 只允许映射到声明式能力 (组件属性、数据映射、声明式动作) , 严禁生成 script/eval/自定义函数类字段 — 否则 LLM 输出会经转换器获得代码执行通道, 击穿 A2UI 的白名单安全模型. 落地方式是维护封闭的 A2UI -> 平台组件映射白名单, 未映射组件丢弃或转文字说明.

成本评估: 低代码平台 schema 的语义 (事件编排、数据链、作用域) 与 A2UI catalog 并非一一对应, 映射器需要长期维护; 只建议已有对应资产的团队采用. 没有低代码资产的业务, 用前两条 Markdown / JSON Schema 路径更划算.

### LLM 辅助转换 (与纠错重试同构的补充)

确定性转换器无法处理时 (组件树语义混乱、大量未知组件) , 可复用 correctA2uiBlock 的模式: 关闭工具, 把原始 JSON + 校验错误 + 目标格式说明交给模型, 要求只输出转换结果. 目标格式越简单, 成功率越高 (Markdown > JSON Schema 表单 > 修复后的 A2UI) . 产物仍须通过目标格式自身的校验, 失败则落入下一级. 顺序原则: 先确定性转换后 LLM 转换 — 前者零成本可单测, 后者引入额外推理成本与新的失败面.

### 落地位置

- 服务端 (推荐) : 在 yukino-agent 链路中, 转换器插在 extractA2ui / correctA2uiBlock 之后、SSE 下发之前, 校验失败触发 L3-L5, 降级产物经现有 SSE 事件下发 (markdown 正文走 message 事件; 转换后的表单/低代码数据可沿用 event: a2ui 通道或并入正文) . 服务端拥有重试能力与完整上下文, 转换失败也不消耗客户端资源
- 客户端 (兜底) : A2uiView 逐条 safeParse 已是最后一道闸; 可再加 "丢弃后本地转换渲染" 逻辑, 但客户端没有 LLM 重试能力, 通常只做 L4 级数据直出
- action 回传链路: runA2uiAction 返回的 patch 校验失败时不追加 patch, surface 保持原状 (filterInPlaceMessages 已保证杂散消息不破坏客户端) , 并在 surface 内提示操作未生效

## Lit 实现对比

Lit shell (samples/client/lit/shell) 与 React shell 跑同一个协议, 差异集中在三处:

| 维度         | React shell                                                                     | Lit shell                                                                    |
| :----------- | :------------------------------------------------------------------------------ | :--------------------------------------------------------------------------- |
| 传输层       | 浏览器 fetch /a2a, Vite 中间件做协议转换 + SSE 流式                             | 浏览器内直接用 @a2a-js/sdk 的 A2AClient 连 Server, 非流式 sendMessage        |
| 响应式       | useSyncExternalStore 订阅 web_core 事件/快照                                    | SignalWatcher(LitElement) 混入 @lit-labs/signals, 信号驱动细粒度更新         |
| Surface 渲染 | A2uiSurface + NodeResolver/NodeView node layer, useSyncExternalStore 同步节点树 | `<a2ui-surface .surface=${surface}>` 自定义元素, repeat 指令遍历 surfacesMap |

Lit 侧关键代码:

```ts
// app.ts
import * as v0_9 from "@a2ui/web_core/v0_9";
import { basicCatalog } from "@a2ui/lit/v0_9";

@customElement("a2ui-shell")
export class A2UILayoutEditor extends SignalWatcher(LitElement) {
  private _processor = new v0_9.MessageProcessor(
    [basicCatalog],
    async (action: v0_9.A2uiClientAction) => {
      // action -> userAction 消息 -> sendAndProcessMessage
      await this.#sendAndProcessMessage({
        userAction: {
          name: action.name,
          surfaceId: action.surfaceId,
          sourceComponentId: action.sourceComponentId,
          timestamp: new Date().toISOString(),
          context: { ...action.context },
        },
      });
    },
  );

  #maybeRenderData() {
    const surfaces = Array.from(this._processor.model.surfacesMap.entries());
    return html`<section id="surfaces">
      ${repeat(
        surfaces,
        ([id]) => id,
        ([, surface]) =>
          html`<a2ui-surface .surface=${surface}></a2ui-surface>`,
      )}
    </section>`;
  }
}
```

```ts
// client.ts -- 浏览器直连 A2A Server
this.#client = await A2AClient.fromCardUrl(
  `${baseUrl}/.well-known/agent-card.json`,
  {
    fetchImpl: async (url, init) => {
      const headers = new Headers(init?.headers);
      headers.set(
        "X-A2A-Extensions",
        "https://a2ui.org/a2a-extension/a2ui/v0.9",
      );
      return fetch(url, { ...init, headers });
    },
  },
);
```

结论: MessageProcessor / SurfaceModel / GenericBinder 全部来自框架无关的 @a2ui/web_core, React 和 Lit 只是两种适配层. 业务接入时选择与自身技术栈一致的渲染器即可, 协议层代码完全复用.

## 真实前端业务接入示例

以一个真实场景为例: 电商 App 的智能客服对话流中, Agent 需要动态下发 "退款申请表单" 和 "订单卡片", 前端是 React 18 + Vite 技术栈.

### 接入清单 (5 步)

第 1 步: 安装依赖

```bash
yarn add @a2ui/react @a2ui/web_core @a2ui/markdown-it
```

第 2 步: 创建全局 MessageProcessor (单例, 挂在对话页顶层)

```tsx
// a2ui/processor.ts
import { basicCatalog } from "@a2ui/react/v0_9";
import { MessageProcessor } from "@a2ui/web_core/v0_9";
import { refundCatalog } from "./refund-catalog"; // 业务自定义 catalog (可选)

export const processor = new MessageProcessor(
  [basicCatalog, refundCatalog],
  (action) => {
    // 统一出口: 把 A2UI action 翻译成业务请求
    if (action.name === "submit_refund") {
      api.submitRefund(action.context).then(showSuccessToast);
      return;
    }
    // 其余 action 回传给 Agent 继续对话
    chatStore.sendToAgent({ version: "v0.9", action });
  },
);
```

第 3 步: 在消息流中渲染 Surface

```tsx
// ChatMessage.tsx -- 对话气泡内嵌 A2UI 区域
function useSurfaces() {
  const [surfaces, setSurfaces] = useState<SurfaceModel[]>([]);
  useEffect(() => {
    const sub1 = processor.onSurfaceCreated((s) =>
      setSurfaces((p) => [...p, s]),
    );
    const sub2 = processor.onSurfaceDeleted((id) =>
      setSurfaces((p) => p.filter((s) => s.id !== id)),
    );
    return () => {
      sub1.unsubscribe();
      sub2.unsubscribe();
    };
  }, []);
  return surfaces;
}

// 渲染
{
  surfaces.map((surface) => <A2uiSurface key={surface.id} surface={surface} />);
}
```

第 4 步: 打通传输层. 生产环境通常已有 SSE/WebSocket 网关, 只需保证:

- Agent 下发的每条 A2UI 消息 (JSON 对象) 按序、完整地交给 `processor.processMessages`
- 用户 action 通过 `{version: "v0.9", action}` 结构发回 Agent
- 若走 A2A 传输, 参考 react shell 的 middleware: 注入 X-A2A-Extensions 头, 处理累积 parts 的 createSurface 去重

第 5 步: 与 Agent 约定 catalog. 两种方式任选:

- pre-shared: 双方约定 catalogId, Agent 的 system prompt 内置该 catalog schema
- inline: 请求时携带 `processor.getClientCapabilities({includeInlineCatalogs: true})`, Agent 动态注入

### 自定义组件注册

业务往往需要超出 basic catalog 的组件 (例如订单卡片). 用 createComponentImplementation 把现有 React 组件包装为 A2UI 组件:

```tsx
// a2ui/components/OrderCard.tsx
import { createComponentImplementation } from "@a2ui/react/v0_9";
import { z } from "zod";

// schema 即该组件对 Agent 暴露的属性契约 (Zod 定义, 自动转 JSON Schema)
const orderCardApi = {
  name: "OrderCard",
  schema: z.object({
    orderId: z.string(), // 静态属性
    amount: z.custom<{ path?: string }>(), // 动态属性: 支持 {path} 绑定
    status: z.enum(["paid", "shipped", "refunding"]),
  }),
};

export const OrderCardImpl = createComponentImplementation(
  orderCardApi,
  ({ props }) => {
    // props 已被 GenericBinder 解析: 绑定路径替换为 DataModel 中的实际值
    return (
      <div className="order-card">
        <span>订单号: {props.orderId}</span>
        <span>金额: {props.amount}</span>
        <StatusTag status={props.status} />
      </div>
    );
  },
);
```

注册进自定义 catalog 后, Agent 即可在 JSON 中引用:

```json
{
  "id": "order-1",
  "component": "OrderCard",
  "orderId": "2026081100001",
  "amount": { "path": "/order/amount" },
  "status": "refunding"
}
```

安全边界提醒:

- Agent 只能渲染已注册组件, 永远不执行 Agent 下发的代码; 自定义组件内部如需加载第三方内容 (如 iframe), 由组件自己实施沙箱策略 (smart wrapper 模式)
- 对 Agent 下发的 url / html 类属性, 在自定义组件内做白名单校验
- 校验类逻辑用 catalog 函数 (checks) 声明, 在客户端本地执行, 不依赖 Agent 自觉

## yukino-agent: 生产级 A2UI 应用案例

$HOME/github/yukino-agent 是一个 AI OnCall 运维助手 (RAG 对话、告警分析、日志查询、Prometheus 运维问答), 通过 A2UI 让 LLM 直接生成交互式 UI (告警列表卡片、指标图表、静默表单). 它最重要的架构选择是不用 CopilotKit, 完全自建"生成 -> 渲染 -> 交互 -> 原地更新"闭环; A2UI 集成全部内联在仓库内: catalog/ 组件目录、components/a2ui-view.tsx 渲染器、lib/a2ui/prompt 提示词生成器 (均仓库内 vendored, server-safe), 没有任何外部 A2UI 组件包依赖.

### 技术栈

- Next.js 16.2.9 (App Router) + React 19.2.4 + TypeScript 6; 页面: app/page.tsx (主聊天) 、app/gallery/page.tsx (组件画廊)
- Vercel AI SDK v7 (ai ^7.0.122): streamText/generateText + tools + stopWhen: isStepCount(n); provider 为 @ai-sdk/openai 与 @ai-sdk/anthropic, lib/ai/models.ts 按 LLM_PROVIDER 切换, 区分 thinkModel/quickModel
- A2UI: @a2ui/web_core ^0.10.7、@a2ui/react ^0.10.2、@a2ui/markdown-it ^0.1.2, 全部经 /v0_9 子路径消费 v0.9 协议; catalog、渲染器与 prompt 生成器均为仓库内 vendored 代码, 无外部 A2UI 组件包依赖
- AI Ops 与遥测: @langchain/langgraph ^1.4.18 (StateGraph 编排) 、@langfuse/langchain + @langfuse/otel + @langfuse/tracing ^5.11.1、@opentelemetry/sdk-node
- 其他: Redis Stack 向量检索 (RAG) 、knex + mysql2、MCP SDK (日志工具) 、prom-client、Tailwind v4、@base-ui/react 与 shadcn CLI 维护的 components/ui/ 原语

一个配套配置 (next.config.ts): reactStrictMode: false. 原因是 MessageProcessor 是有状态外部存储, StrictMode 的开发态双执行会重放已创建的 surface.

### 本地 catalog 与渲染器 (vendored)

catalog/ 目录是仓库内 vendored 的 shadcn catalog 实现 (AGENTS.md 约定保持最小改动), 注册表 catalog/index.ts:

```ts
export const SHADCN_CATALOG_ID =
  "https://raw.githubusercontent.com/hangtiancheng/a2ui/main/packages/shadcn/catalog.json";

export const shadcnCatalog = new Catalog<ReactComponentImplementation>(
  SHADCN_CATALOG_ID,
  components, // 18 个 basic 组件 + shadcnExtensionComponents (47 个)
  BASIC_FUNCTIONS,
);
```

组件规模: catalog/components/ 的 18 个 basic 组件 (Text / Image / Icon / Video / AudioPlayer / Row / Column / List / Card / Tabs / Divider / Modal / Button / TextField / CheckBox / ChoicePicker / Slider / DateTimeInput) 复用官方 basic_catalog 的 zod Api schema, 只替换视觉层为 shadcn/ui; catalog/shadcn/ 另有 47 个扩展组件按七个家族分组: display (Alert / AspectRatio / Avatar / Badge / Empty / Item / Kbd / Label / Progress / ScrollArea / Skeleton / Spinner) 、structure (Accordion / ButtonGroup / Carousel / Collapsible / Resizable / Table) 、overlays (AlertDialog / ContextMenu / Drawer / DropdownMenu / HoverCard / Popover / Sheet / Tooltip) 、navigation (Breadcrumb / Menubar / NavigationMenu / Pagination) 、forms (Calendar / Combobox / Command / Field / InputGroup / InputOtp / NativeSelect / Select / Switch / Toggle) 、chat (Attachment / Bubble / Marker / Message / MessageScroller / Questionnaire) 、data (Chart) , 合计 65 个. 源码注释明确排除了 sidebar (属于应用骨架) 、toast (命令式 API) 、direction (provider 性质).

渲染器 components/a2ui-view.tsx 的 A2uiView 接收 messages: unknown[] 与 onAction/onRawAction 回调, 内部流程:

1. A2uiMessageSchema.safeParse 逐条校验, 非法消息丢弃并打日志
2. new MessageProcessor([shadcnCatalog], actionHandler), actionHandler 优先走 onRawAction, 否则用 buildQueryFromAction 转成文本 "[a2ui_action] \{name\}\ncontext: \{JSON\}"
3. processedCount ref 记录已处理条数, 只把新增消息交给 processor.processMessages —— 增量处理是支持"原地更新"(action 回传后追加 update 消息) 的基础
4. 订阅 onSurfaceCreated/onSurfaceDeleted 维护 surfaces 状态, MarkdownContext 注入 @a2ui/markdown-it 的 renderMarkdown, 逐个渲染 A2uiSurface (外包一层 motion 入场动画)

求值由 web_core 的 generic binder 按 zod schema 结构化完成: Dynamic\* 标注的 prop 解析为实际值并自动生成 setX 回写函数 (双向绑定) ; ActionSchema 标注的 prop 变成可调用函数; ComponentId/ChildList 变成 buildChild 能力; z.any() 保持静态不参与绑定. .strict() schema 使 MessageProcessor 运行时拒绝未知 prop.

### 生成侧: vendored prompt + direct-json 模式

lib/a2ui/prompt 把 A2UI Python agent SDK 的四种推理格式提示词生成器移植为 TypeScript (DirectJsonPromptGenerator / ElementalPromptGenerator / AtomPromptGenerator / ExpressPromptGenerator, 分别在 direct-json.ts / elemental.ts / atom.ts / express.ts) , 内嵌 schemas/\{catalog,common_types,server_to_client\}.json (catalog.json 与客户端 catalog 同一 catalogId; 另两份是 https://a2ui.org/specification/v0_9/json/ 发布 schema 的逐字节 vendored 副本) , 对外提供 generateSystemPrompt(format, options, catalog)、applySchemaModifiers、removeStrictValidation、withPruning 等工具, server-safe 无 React 依赖.

lib/ai/a2ui/prompt.ts 用它构造系统提示词:

```ts
import { applySchemaModifiers, generateSystemPrompt, removeStrictValidation,
  SHADCN_PROMPT_CATALOG } from "@/lib/a2ui/prompt";

// 与客户端 shadcnCatalog 注册一致的 catalogId; 不一致时 renderer 抛 "Catalog not found"
export const A2UI_CATALOG_ID = SHADCN_PROMPT_CATALOG.catalogSchema.catalogId as string;

const PROMPT_CATALOG = applySchemaModifiers(SHADCN_PROMPT_CATALOG, [removeStrictValidation]);

export const A2UI_PROMPT_SECTION = generateSystemPrompt("direct-json", {
  roleDescription: `## Interactive UI (A2UI v0.9) ...`,
  workflowDescription: `- WHEN: only when the answer presents structured data ...`,
  includeSchema: true,
  examples: [renderExample("ALERT_LIST_EXAMPLE", buildAlertListExample()), ...].join("\n"),
}, PROMPT_CATALOG);
```

要点:

- direct-json 模式: LLM 在 markdown 回复后追加一个 `<a2ui-json>[...]</a2ui-json>` 标签块 (JSON 消息数组) , 与文本共用同一输出通道
- prompt 内嵌完整 schema 契约 + 3 个由 builder 函数生成的 few-shot 示例 (告警列表、QPS 指标报告、静默表单) . builder 化的好处: 改 UI 结构只需改 builder, prompt 自动同步
- removeStrictValidation 去掉 closed-object 约束, 避免 LLM 因无害的额外字段被过度拒绝
- A2UI_ACTION_SYSTEM_PROMPT 通过 allowedMessages: ["UpdateComponentsMessage", "UpdateDataModelMessage"] 裁剪 schema, 使 action 场景下 createSurface/deleteSurface 根本无法通过校验

两条生成管线 (lib/ai/pipelines/chat.ts):

- 非流式 POST /api/chat: RAG 检索 (lib/redis/retriever.ts) + 历史记忆 -> generateText (tools + 25 步上限) -> extractA2ui 切出标签块并用 @a2ui/web_core/v0_9 的 A2uiMessageListSchema.safeParse 校验 -> 返回 \{ answer, a2ui \} . Memory 保存带标签的原始文本, 使后续轮次保留渲染过什么的上下文
- 流式 POST /api/chat_stream: chatStream() async generator 中 createA2uiStreamFilter() (lib/ai/a2ui/extract.ts) 是一个有状态流过滤器 —— 普通文本即时透传 (仅扣留可能是标签前缀的尾部, partialTagSuffixLength 处理跨 chunk 切分) , `<a2ui-json>` 块静默缓冲直到闭合标签; 完整块经 parseA2uiBlock 校验后以 \{type:"a2ui", messages\} 事件 yield, 由 SSE 路由以 event: a2ui 下发. SSE 共 connected/message/a2ui/done/error 五种事件, connected 最先发送; 多行文本拆成多条 data: 行, 客户端按 SSE 规范以 "\n" 重组

纠错重试: 块校验失败时调用 correctA2uiBlock (lib/ai/a2ui/correct.ts) —— 关闭工具的一次重试, 把错误信息回灌模型要求只输出修正块; 仍失败则流式管线降级为 notice ("> Failed to render the interactive view for this reply.") , 绝不伪造 UI 数据. 流末尾未闭合的块由 flush() 还原开头标签后当作无效块进入同一条校验/纠错/降级路径, 不泄漏原始 JSON 也不静默丢弃. 这正是 v0.9 prompt-first 取向 (schema 嵌入 prompt, 生成后校验修复) 在应用层的标准落地.

### 消费侧: unknown[] 边界 + 增量渲染

hooks/use-chat.ts 中 ChatMessage.a2ui?: unknown[] 挂在助手消息上, 随对话历史持久化到 localStorage (读取时经 zod 校验) . SSE 解析器处理 event: a2ui 事件时以 z.array(z.unknown()).min(1).safeParse(JSON.parse(payload)) 做形状校验后追加到最后一条助手消息的 a2ui 数组. 设计红线: web_core 自带 zod v3, 不得与应用层 zod/v4 混用 schema, 边界一律 unknown[], 渲染时才由 web_core schema 逐条校验.

components/msg-list.tsx 中每条带 a2ui 数据的助手消息渲染一个 A2uiView (import 自 "@/components/a2ui-view"), onRawAction 接到动作后走独立的 action 管线.

### 交互回传: out-of-band 原地更新

这是本应用最有特色的设计 —— surface 内的动作不走聊天消息流:

1. 用户点击 surface 内按钮 -> MessageProcessor 回调 -> A2uiView.onRawAction(action), action 为 \{name, surfaceId, sourceComponentId, context\}
2. sendA2uiAction POST /api/a2ui_action, body 为 \{ action, a2ui: 该消息当前的完整 a2ui 消息列表 \} (surface 的权威状态随请求带上)
3. 服务端 runA2uiAction (lib/ai/a2ui/action.ts): buildA2uiActionPrompt 把 action payload + surface 全量消息组成 user prompt; generateText 使用 quickModel + A2UI_ACTION_SYSTEM_PROMPT + MCP/内置工具 + 10 步上限; 输出经 extractA2ui + correctA2uiBlock 纠错重试
4. filterInPlaceMessages 只保留针对同一 surfaceId 的 updateComponents/updateDataModel —— 杂散的 createSurface 会让客户端 MessageProcessor 抛 "Surface already exists" 并丢弃整批消息
5. 客户端把返回的 patch 追加到原消息的 a2ui 数组并写回历史, A2uiView 增量 processMessages 原地更新 surface (如表单提交后在原卡片内显示状态行)

更新不产生新的聊天气泡, 交互体验收敛在 surface 内部.

### AI Ops 管线: LangGraph 编排 + uiify 后处理

POST /api/ai_ops 走 plan-execute-replan 管线 (lib/ai/pipelines/plan-execute-replan/), 核心是一张 LangGraph StateGraph (graph.ts), 节点为 planner -> executor -> replanner 循环 -> uiify | exhausted:

- 状态: Annotation.Root 声明的 OpsState (query、plan、stepIndex、detail (concat reducer)、iteration、done、report). 用 Annotation.Root 是因为本仓库 zod 走 zod/v4 入口, 其 ~standard 缺少 langgraph StateSchema 所需的 JSON-Schema 属性
- planner: thinkModel + Output.object 结构化输出 steps (plan_created 事件); executor: 每次节点运行执行一个 plan step, quickModel + 工具 + 10 步上限 (step_start / step_done 事件); replanner: thinkModel 结构化输出 \{done, remaining, summary\} (replan 事件), 条件边路由 —— done -> uiify, 有剩余步数 -> executor, 预算耗尽 -> exhausted
- 循环护栏: MAX_ITERATIONS = 20 是 replan 轮数的真实预算; RECURSION_LIMIT = 525 (MAX_ITERATIONS*25+25) 仅是兜底, 二者需同步调整
- 事件流: 节点经 getWriter() 向 "custom" 流发布 PlanExecuteEvent; 驱动 index.ts 以 streamMode: "custom" 消费, 用 events.ts 的 zod discriminatedUnion (plan_created / step_start / step_done / replan / done / error 六种) 对每个 chunk 逐条重校验后才 yield. 必须用 getWriter() 而非 writer() 助手: langgraph 1.4.x 的 writer() 读 configurable.writer, 而 Pregel 已不再填充它, 会静默丢失全部事件
- uiify 节点执行 uiifyReport(): thinkModel 做一次无工具的"UI 化"后处理, 系统提示词即 A2UI_PROMPT_SECTION, 报告是唯一数据源 (没有结构化内容时回复 NONE), 输出经 extractA2ui + 一次纠错重试; surface 随 done 事件的 a2ui 字段返回, /api/ai_ops 放入 data.a2ui —— 失败绝不影响报告本身

遥测 (lib/observability.ts): Langfuse 仅在 LANGFUSE_PUBLIC_KEY、LANGFUSE_SECRET_KEY、LANGFUSE_BASE_URL 三者齐备时启用, 否则全部 no-op. initObservability 以 OTEL NodeSDK + LangfuseSpanProcessor 启动 (SDK 实例缓存在 globalThis 上, 抗 Next dev HMR 的模块重载); instrumentation.ts 在知识库 embedding 之前调用它 (仅 nodejs runtime); aiOpsCallbacks 给每次图运行挂一条 CallbackHandler trace (graph/node 级 span), observeGeneration 把每次 AI SDK 调用记录为 generation (含 token 用量), withAiOpsTrace 传播 session/tags. 离线验证: scripts/ai-ops-graph-smoke.ts (schema round-trip + 图结构断言, AI_OPS_SMOKE_LIVE=1 走真实 LLM 验证事件序列).

### 其他后端与界面示例

工具三层拆分 (lib/ai/tools/) : schemas.ts (zod) -> operations.ts (纯函数) -> index.ts (AI SDK tool) , 含 get_current_time、mysql_crud、query_internal_docs (RAG) 、query_prometheus_alerts, 另有经 MCP SDK 引入的 SSE 日志工具. instrumentation.ts 启动时把 data/docs/ 文档全部 embedding 入 Redis 向量库 (失败不阻塞启动). 其余 API: upload (知识库上传) 、log/metrics (sentry 上报与 Prometheus 指标), 与 chat/chat_stream/a2ui_action/ai_ops 一样采用统一响应形状 \{ message, data \}.

界面示例 (prompt few-shot builder, lib/ai/a2ui/prompt.ts) :

- 告警列表: Column/Text/List (模板绑定 children:\{componentId, path:"/alerts"\}) /Card/Row/Badge/Button (action ack_alert, context 用相对路径绑定)
- QPS 指标报告: Chart (variant:"line") + Table (rows 绑定 /rows)
- 告警静默表单: Card + TextField x3 (value 绑定数据模型) + Button (action create_silence, context 携带表单值)
- action 原地更新示例 (buildSilenceActionUpdateExample): upsert form-body 加入 status-text, updateDataModel \{path:"/status"\}, 无 createSurface、同一 surfaceId

验证手段: /gallery 页面无后端渲染全部扩展组件 —— createGalleryMessages() 构造一个引用每个 shadcn 扩展组件的 surface (消息顺序 createSurface -> updateDataModel -> updateComponents), 走真实 catalog 管线渲染.

### 工程坑位清单

1. zod 版本红线: web_core 内置 zod v3, 应用层 zod/v4 不得混用 schema, 边界用 unknown[] 隔离
2. MessageProcessor 有状态: React StrictMode 双执行会重放 surface, 需关闭或妥善处理
3. catalogId 两端必须一致, 否则 "Catalog not found"; 服务端从 vendored schemas/catalog.json 取, 客户端 catalog/index.ts 注册, 同一 catalogId 的两份载体改动需同步
4. action 回传的 patch 中杂散 createSurface 会导致整批消息被丢弃, 服务端必须先过滤
5. LLM 生成的 A2UI 块天然存在格式错误概率, 必须有校验 + 有限次纠错重试 + 诚实降级的完整兜底
6. LangGraph 1.4.x 发布 custom 事件必须用 getWriter(), writer() 助手会静默丢失事件
7. 仓库 AGENTS.md 的 "A2UI integration (v0.9)" 一节仍有一处过时描述: 它称 surface action 序列化为 [UI_ACTION] 走聊天通道 —— 现行代码是 onRawAction -> /api/a2ui_action 带外链路; 它引用的 scripts/a2ui-smoke.ts 也不存在 (scripts/ 下只有 ai-ops-graph-smoke.ts), 以代码为准

### 小结

A2UI 把"Agent 发 UI"从发代码变成发数据, 用 catalog 契约 + 数据绑定 + 扁平组件树换取 LLM 生成的可靠性与跨信任边界的安全性; yukino-agent 把协议落地所需的两侧能力 (65 组件 catalog、A2uiView 渲染器、四格式 prompt 生成器) 全部内联进应用仓库, 验证了从 prompt 生成、流式渲染到交互原地更新的完整工程闭环, 其自建链路 (而非 CopilotKit) 为自建 agentic 应用提供了可复用的参考实现.

## 版本族之间的消息形态对照 (v0.8 与 v0.9)

A2UI 同时维护多个版本族, 各自的消息形态不同; 本节给出对照, 供阅读不同版本的规范与示例时定位 (本文正文全部采用 v0.9 形态):

| 维度         | v0.8 (legacy, 规范冻结)                                                     | v0.9 / v0.9.1 (当前)                                          |
| :----------- | :-------------------------------------------------------------------------- | :------------------------------------------------------------ |
| 组件类型字段 | 无 componentType 字段; 仍是 component 键, 值为 \{类型名: props\} 的包裹对象 | component 键直接是类型名字符串 (相当于 componentType)         |
| 组件属性     | 嵌在类型名包裹对象内, 无 params 键                                          | 按实际 schema 直接平铺在组件对象上                            |
| 表面初始化   | beginRendering; 组件经 surfaceUpdate 下发                                   | createSurface 必须携带 catalogId, 数据由 updateDataModel 下发 |
| 数据更新     | dataModelUpdate: path + contents (key/value 条目) 数组                      | updateDataModel: path + value, upsert 语义                    |
| 设计取向     | 面向 structured output                                                      | prompt-first, schema 嵌入 prompt, 生成后校验修复              |

## A2UI 调研: 协议与 yukino-agent 应用

事实来源:

- $HOME/Downloads/a2ui (A2UI 协议仓库, HEAD f8b58799): 规范、多语言 SDK 与示例
- $HOME/github/yukino-agent (A2UI 应用案例, HEAD 536ed8c): catalog、渲染器与 prompt 生成器全部内联在该仓库内

---

### 摘要

A2UI (Agent to UI) 是一个面向 agent 驱动界面的声明式 UI 协议: AI agent 不返回纯文本, 也不向客户端注入 HTML/JS, 而是发送一组 JSON 消息来描述界面, 客户端用本地组件库把消息渲染成原生 UI. 协议由 Google 发起、CopilotKit 与开源社区共建, Apache 2.0 许可, 当前版本 v0.9.1 (v1.0 候选中) .

本次调研的两个部分构成一条完整链路: 协议本身回答"agent 和 UI 之间说什么"; yukino-agent 回答"一个真实应用怎么把整条链路跑起来"——它是一个 AI OnCall 运维助手, 不依赖 CopilotKit, 把渲染端 (65 组件 catalog + A2uiView 渲染器) 与生成端 (vendored prompt 生成器) 全部内联在仓库内, 自研了从 prompt 注入、流式提取、校验纠错到交互回传的全套管线.

核心结论: A2UI 的关键设计 (扁平邻接表组件、结构与状态分离、catalog 契约化) 都是围绕"让 LLM 可靠地生成 UI"这个目标做的取舍; 而 yukino-agent 的实践则补齐了协议落地中最难的工程环节——catalog 与 prompt 的 catalogId 一致性、流式输出的有状态过滤、以及 surface 交互的原地更新闭环.

---

### 一、A2UI 协议

#### 1.1 定位与要解决的问题

A2UI 的定义: 一个声明式 UI 协议, 让 AI agent 生成富交互 UI, 并在 web、移动端、桌面端原生渲染, 全程不执行任意代码.

它针对两个痛点:

第一, 纯文本交互低效. 典型例子是订位: 用户说"帮我订明天晚上 7 点两个人的位子", agent 如果只能文本追问"哪一天? 几点? 几位?", 就要来回多轮; 更好的做法是 agent 直接生成一个带日期选择器、时间选择器和提交按钮的表单, 用户用 UI 而不是文本来交互.

第二, 多 agent 系统中的信任边界问题. agent 往往运行在远端 (不同服务器、不同组织) , 不能直接操作用户的 UI, 只能发消息. 传统做法是发 HTML/JavaScript 塞进 iframe, 代价是体积重、视觉割裂、安全复杂、无法匹配宿主应用样式. A2UI 的目标是: 传输一种"像数据一样安全、像代码一样有表现力"的 UI 描述.

一句话概括官方表述: A2UI 解决的是"AI agent 如何跨信任边界安全地发送富 UI". agent 发送的是声明式组件描述, 客户端用自己的原生控件渲染, 相当于让 agent 说一种通用的 UI 语言.

#### 1.2 三个核心设计思想

协议围绕三个核心概念构建:

1. 流式消息 (Streaming Messages) : UI 更新以 JSON 消息序列的形式从 agent 流向客户端, 任何消息都可能处于"未完成" (部分送达) 状态, 天然适配 LLM 的流式输出, 支持渐进式渲染——用户看着 UI 一块块长出来, 而不是盯着转圈.
2. 声明式组件 (Declarative Components) : UI 被描述为数据, 而不是被编程为代码.
3. 数据绑定 (Data Binding) : UI 结构与应用状态分离, 状态变化驱动响应式更新.

#### 1.3 消息类型与格式

所有 A2UI 消息都是 JSON 对象, 以 JSON Lines (JSONL) 传输, 每行恰好一条消息.

v0.8 (Legacy) 消息类型:

- beginRendering: 通知客户端渲染一个 surface
- surfaceUpdate: 新增或更新组件
- dataModelUpdate: 更新应用状态
- deleteSurface: 删除 surface

v0.9 (当前) 消息类型, 所有消息都带 "version": "v0.9" 字段:

- createSurface: 创建 surface 并指定其 catalog
- updateComponents: 新增或更新组件
- updateDataModel: 更新应用状态
- deleteSurface: 删除 surface

一个 v0.8 风格的简化示例 (订位表单) :

```json
{
  "surfaceUpdate": {
    "surfaceId": "main",
    "components": [
      {
        "id": "header",
        "component": {
          "Text": {
            "text": { "literalString": "Book Your Table" },
            "usageHint": "h1"
          }
        }
      },
      {
        "id": "date-picker",
        "component": {
          "DateTimeInput": {
            "label": { "literalString": "Select Date" },
            "value": { "path": "/reservation/date" },
            "enableDate": true
          }
        }
      },
      {
        "id": "submit-btn",
        "component": {
          "Button": {
            "child": "submit-text",
            "action": { "name": "confirm_booking" }
          }
        }
      }
    ]
  }
}
```

#### 1.4 组件结构: 邻接表模型

A2UI 用邻接表 (adjacency list) 而非嵌套树来表达组件层级: 组件是一个扁平列表, 父子关系靠 ID 引用.

```json
{
  "surfaceUpdate": {
    "surfaceId": "main",
    "components": [
      {
        "id": "root",
        "component": {
          "Column": { "children": { "explicitList": ["header", "body"] } }
        }
      },
      {
        "id": "header",
        "component": { "Text": { "text": { "literalString": "Welcome" } } }
      },
      { "id": "body", "component": { "Card": { "child": "content" } } },
      {
        "id": "content",
        "component": { "Text": { "text": { "path": "/message" } } }
      }
    ]
  }
}
```

为什么不用嵌套树:

- 嵌套树要求 LLM 一次性生成完美嵌套, 容错差; 扁平列表对 LLM 友好.
- 扁平结构可以增量流式发送组件.
- 任何组件都能按 ID 单独更新, 不必重发整棵树.
- 结构与数据清晰分离.

#### 1.5 数据绑定: 结构与状态分离

数据绑定用 JSON Pointer 路径 (RFC 6901) 把组件连接到应用状态. 每个 surface 持有一个分层的 JSON 数据模型 (Data Model) , 它是可观察的、由 renderer 与 agent 共享、双方都可更新:

```json
{
  "user": { "name": "Alice", "email": "alice@example.com" },
  "cart": {
    "items": [{ "name": "Widget", "price": 9.99, "quantity": 2 }],
    "total": 19.98
  }
}
```

这个设计带来的能力: 响应式更新、数据驱动 UI、可复用模板、双向绑定. 组件绑定到数据模型节点后, 值变化时自动更新; 用户交互被捕获进状态对象回传 agent, agent 也可以反向推送数据更新. 由于结构与状态分离, 大数组数据的布局可以高效定义, 内容更新不必从头重新生成.

#### 1.6 用户动作: Function 与 Event

组件通过 action 属性触发两类行为:

- Function: 在 renderer 本地执行的函数, 保证交互的即时响应.
- Event: 派发给 agent 的事件, 携带上下文数据.

客户端处理用户动作的标准流程: 捕获组件的动作事件 → 解析动作所需的数据上下文 → 发送给 agent → 处理 agent 返回的消息.

此外还有数据模型同步机制, 保证 agent 始终能拿到完整 UI 状态, 从而支持语音指令等多模态交互.

#### 1.7 Catalog: agent 与 renderer 的契约

Catalog (组件目录) 是 A2UI 的关键抽象: renderer 向 agent 提供"我支持哪些组件和函数"的清单及使用说明, agent 据此生成 UI. 交互循环是:

1. Renderer 把 catalog 与使用说明交给 agent.
2. Agent 循环: 依据 catalog 生成 UI 与函数调用 → 接收 renderer 回传的用户输入 → 更新要展示的数据.

Catalog 的 JSON Schema 结构: 一个对象包含 catalogId (唯一标识) 、components (组件定义, 值为 JSON Schema) 、functions (函数定义数组) 、theme (主题属性 schema) .

官方维护一个 Basic Catalog (位于规范目录 specification/v0_9_1/catalogs/basic/catalog.json) , 包含 Button、TextField、Card 等 18 个通用组件. 它不是什么特殊类型, 只是一个官方写好 schema 且有开源 renderer 的现成目录, 刻意保持精简以便各 renderer 实现. 官方明确: 不追求跨客户端的标准化 catalog——因为 UI 由 LLM 生成, LLM 可以针对每个前端解释各自的 catalog, 所以"你的设计系统才是重点", 任何组件集合都能注册, catalog 就是 agent 与 renderer 之间的契约.

#### 1.8 安全模型

安全是协议的一等原则:

- 沙箱化执行: 禁止 agent 注入任意代码 (如原始 JavaScript) , agent 只能触发预先注册的行为. functionCall 机制是 agent 与 renderer 环境交互的唯一安全通道.
- 对不受信的第三方代码, A2UI 仓库提供了运行 MCP Apps 的双 iframe 隔离实现 (samples/community/client/shared/mcp_apps_inner_iframe/ 的 double-iframe isolation pattern): 同源外层代理 iframe 负责消息中继, 内层 iframe 默认 sandbox 为 allow-scripts allow-forms allow-modals (不含 allow-same-origin), 防止"allow-scripts + allow-same-origin"组合导致的沙箱逃逸, 同时维持结构化 JSON-RPC 通道. (A2UI 官方规范只声明了 "A2UI 可经 MCP 传输" 的绑定, 未规定 iframe 承载细节, 双 iframe 属于该示例的实现选择)

#### 1.9 传输层与生态

A2UI 与传输层解耦, 任何能送 JSON 的通道都行: A2A 协议、AG-UI、REST/SSE、WebSocket、gRPC、消息队列等.

生态定位上的两个关键对照:

- AG-UI 是传输协议 (连接 agent 后端与前端、实时状态同步) , A2UI 是 UI 格式 (描述渲染什么的有效载荷) . 二者互补: AG-UI 是管道, A2UI 是内容. AG-UI 由 CopilotKit 团队发起, 对 A2UI 有 day-zero 兼容.
- 对比 OpenAI ChatKit: 设计哲学相近 (基础组件 + 可配置声明式抽象层) , 但 A2UI 是平台无关的, 面向跨 web/移动/桌面自建 agentic 界面, 以及需要跨信任边界渲染的多 agent 系统.

官方 renderer 覆盖 Angular、Flutter、Lit、Markdown、React 等; 社区有基于 ShadCN 的 React renderer (如 @xpert-ai/a2ui-react) . 实际采用案例包括 Google 内部团队、AG2 多 agent 框架 (A2UIAgent) 、CopilotKit 全栈框架等. 配套工具有 A2UI Composer (可视化编辑器, 无需安装即可生成 A2UI JSON) 和 A2UI Theater (预置流式场景的演示场) .

---

### 二、yukino-agent: 一个完整的 A2UI 应用

路径: $HOME/github/yukino-agent (HEAD 536ed8c)

#### 2.1 定位与技术栈

定位: AI 智能 OnCall 运维助手 (AGENTS.md 自述 "AI intelligent OnCall assistant"; README 自述 "An AI OnCall assistant — RAG chat, interactive A2UI surfaces, and a plan-execute-replan AI Ops pipeline for alert analysis") , 核心场景是告警分析、日志查询、Prometheus 运维问答, 并通过 A2UI 让 LLM 直接生成交互式 UI (告警列表卡片、指标图表、静默表单等) .

技术栈 (package.json) :

- 框架: Next.js 16.2.9 (App Router) + React 19.2.4 + TypeScript 6; 入口 app/layout.tsx、app/page.tsx (主聊天界面) 、app/gallery/page.tsx (A2UI 组件画廊)
- AI SDK: Vercel AI SDK v7 (ai ^7.0.122) , streamText/generateText + tools + stopWhen: isStepCount (n) ; provider 为 @ai-sdk/openai 与 @ai-sdk/anthropic, lib/ai/models.ts 按 LLM_PROVIDER 切换, 区分 thinkModel/quickModel
- A2UI 依赖: @a2ui/web_core ^0.10.7、@a2ui/react ^0.10.2、@a2ui/markdown-it ^0.1.2 (均经 /v0_9 子路径消费) ; catalog (catalog/) 、渲染器 (components/a2ui-view.tsx) 、prompt 生成器 (lib/a2ui/prompt) 全部内联在仓库内, 无外部 A2UI 组件包依赖
- AI Ops 与遥测: @langchain/langgraph ^1.4.18 (StateGraph 编排) 、@langfuse/langchain + @langfuse/otel + @langfuse/tracing ^5.11.1、@opentelemetry/sdk-node
- 其他: Redis Stack 向量检索 (RAG) 、knex+mysql2、MCP SDK (日志工具) 、prom-client、Tailwind v4、streamdown、@base-ui/react 与 shadcn CLI 维护的 components/ui/ 原语

目录约定 (AGENTS.md) : app/ (路由+API) 、lib/ (服务端: lib/ai/\{a2ui,pipelines,tools\}、lib/redis) 、components/、hooks/.

#### 2.2 集成方式: 自研链路, 不用 CopilotKit, 全部内联

这是本应用最重要的架构选择: 没有使用 CopilotKit, 而是服务端用仓内 vendored 的 lib/a2ui/prompt 生成提示词, 客户端用仓内的 components/a2ui-view.tsx 渲染. A2UI 相关代码 (catalog/ 组件目录、渲染器、prompt 生成器) 均自 a2ui 仓库的 shadcn catalog 移植而来, AGENTS.md 约定保持最小改动.

一个配套的关键配置 (next.config.ts) :

```ts
// The A2UI MessageProcessor is a stateful external store; StrictMode's dev
// double-effect replays already-created surfaces on re-subscription.
reactStrictMode: false,
```

即 MessageProcessor 是有状态外部存储, StrictMode 的开发态双执行会重放已创建的 surface, 所以关闭 StrictMode.

客户端渲染入口 (components/msg-list.tsx) : 每条带 a2ui 数据的助手消息渲染一个 A2uiView:

```tsx
import { A2uiView } from "@/components/a2ui-view";

{
  message.a2ui && message.a2ui.length > 0 && (
    <A2uiView
      messages={message.a2ui}
      onRawAction={(action) => onA2uiAction(index, action)}
    />
  );
}
```

A2uiView 内部用 processedCount ref 记录已处理条数, 只把新增消息交给 processor.processMessages——这个增量处理机制正是支持"原地更新" (action 回传后追加 update 消息) 的基础; 消息先经 A2uiMessageSchema.safeParse 逐条校验, 非法消息丢弃并打日志.

Catalog 一致性: 服务端 lib/ai/a2ui/prompt.ts 从 vendored 的 SHADCN_PROMPT_CATALOG.catalogSchema.catalogId 取出 catalogId (导出为 A2UI_CATALOG_ID), 与客户端 catalog/index.ts 注册的 SHADCN_CATALOG_ID 相同, 保证 createSurface.catalogId 与客户端注册一致 (源码注释明确: 不一致时 renderer 会抛 "Catalog not found") .

#### 2.3 生成侧: LLM 如何产出 A2UI 消息

Prompt 构造 (lib/ai/a2ui/prompt.ts, 生成器来自仓内 vendored 的 lib/a2ui/prompt) :

```ts
import { A2UI_CLOSE_TAG, A2UI_OPEN_TAG, applySchemaModifiers, generateSystemPrompt,
  removeStrictValidation, SHADCN_PROMPT_CATALOG } from "@/lib/a2ui/prompt";

export const A2UI_CATALOG_ID = SHADCN_PROMPT_CATALOG.catalogSchema.catalogId as string;

const PROMPT_CATALOG = applySchemaModifiers(SHADCN_PROMPT_CATALOG, [removeStrictValidation]);

export const A2UI_PROMPT_SECTION = generateSystemPrompt("direct-json", {
  roleDescription: `## Interactive UI (A2UI v0.9) ...`,
  workflowDescription: `- WHEN: only when the answer presents structured data ...`,
  includeSchema: true,
  examples: [renderExample("ALERT_LIST_EXAMPLE", buildAlertListExample()), ...].join("\n"),
}, PROMPT_CATALOG);
```

要点:

- 采用 "direct-json" 生成模式: LLM 在 markdown 回复之后追加一个 `<a2ui-json>[...]</a2ui-json>` 标签块 (JSON 消息数组) , 与文本共用同一输出通道, 而非独立通道.
- 生成器本体是 vendored 的 lib/a2ui/prompt: A2UI Python agent SDK 四种推理格式 (DirectJsonPromptGenerator / ElementalPromptGenerator / AtomPromptGenerator / ExpressPromptGenerator) 的 TypeScript 移植, 内嵌 schemas/\{catalog,common_types,server_to_client\}.json (catalog.json 与客户端 catalog 同一 catalogId; 另两份是 a2ui.org 发布的 v0.9 协议 schema 的逐字节副本) , server-safe 无 React 依赖.
- prompt 内嵌完整的 server-to-client schema + common types + catalog schema 契约, 外加 3 个由 builder 函数生成的 few-shot 示例 (告警列表、QPS 指标报告、静默表单) . builder 化的好处是: 改 UI 结构只需改 builder, prompt 自动同步.
- removeStrictValidation 去掉 closed-object 约束, 避免 LLM 因无害的额外字段被过度拒绝.
- 另有 A2UI_ACTION_SYSTEM_PROMPT: 通过 allowedMessages: ["UpdateComponentsMessage", "UpdateDataModelMessage"] 裁剪 schema, 使 action 场景下 createSurface/deleteSurface 根本无法通过校验.

两条生成管线:

- 非流式 POST /api/chat → lib/ai/pipelines/chat.ts: RAG 检索 (lib/redis/retriever.ts) + 历史记忆 → generateText (tools + 25 步上限) → extractA2ui (raw) 从完整输出中切出 `<a2ui-json>` 块并用 @a2ui/web_core/v0_9 的 A2uiMessageListSchema.safeParse 校验 → 返回 \{ answer: cleanText, a2ui \} . Memory 保存带标签的原始文本, 使后续轮次保留渲染过什么的上下文.
- 流式 POST /api/chat_stream → chatStream() async generator, 其中 createA2uiStreamFilter() (lib/ai/a2ui/extract.ts) 是一个有状态流过滤器: 普通文本即时透传 (仅扣留可能是标签前缀的尾部, partialTagSuffixLength 处理跨 chunk 切分) , `<a2ui-json>` 块内容静默缓冲直到闭合标签; 完整块经 parseA2uiBlock 校验后以 \{type:"a2ui", messages\} 事件一次性 yield; SSE 用 event: a2ui + data 发送 (共 connected/message/a2ui/done/error 五种事件, connected 在流开始时最先发送; 多行文本拆成多条 data: 行, 客户端按 SSE 规范以 "\n" 重组) . 流末尾未闭合的块由 flush() 还原开头标签后当作无效块进入校验/纠错/降级路径, 不泄漏原始 JSON 也不静默丢弃.

纠错重试: 块校验失败时调用 correctA2uiBlock (lib/ai/a2ui/correct.ts) ——关闭工具的一次重试, 把错误信息回灌给模型要求只输出修正块; 仍失败则降级为 notice ("> Failed to render the interactive view for this reply.") , 绝不伪造 UI 数据.

#### 2.4 消费侧: 前端如何接收与渲染

hooks/use-chat.ts:

- ChatMessage.a2ui?: unknown[] 挂在助手消息上, 随对话历史经 zod 校验后持久化到 localStorage.
- SSE 解析器处理 event: a2ui: z.array (z.unknown()) .min (1) .safeParse (JSON.parse (payload)) 后追加到最后一条助手消息的 a2ui 数组.
- 设计红线 (AGENTS.md) : web_core 自带 zod v3, 不得与应用层 zod/v4 混用, 边界一律 unknown[], 渲染时才由 web_core schema 逐条校验.
- A2uiView 内部 MessageProcessor 消费 createSurface → updateComponents → updateDataModel, 生成 SurfaceModel 交给 A2uiSurface 渲染.

#### 2.5 交互回传: out-of-band action 原地更新闭环

这是本应用最有特色的设计——surface 内的动作不走聊天消息流:

1. 用户点击 surface 内按钮 → MessageProcessor 回调 → A2uiView.onRawAction (action) (A2uiClientAction: \{name, surfaceId, sourceComponentId, context\}) .
2. msg-list.tsx → use-chat.ts 的 sendA2uiAction (messageIndex, action) : POST /api/a2ui_action, body 为 \{ action, a2ui: 该消息当前的完整 a2ui 消息列表 \} (即 surface 的权威状态) .
3. 服务端 app/api/a2ui_action/route.ts → lib/ai/a2ui/action.ts 的 runA2uiAction: buildA2uiActionPrompt 把 action payload + surface 全量消息作为 user prompt; generateText (quickModel + A2UI_ACTION_SYSTEM_PROMPT + tools + 10 步) → extractA2ui + 纠错重试; filterInPlaceMessages 只保留针对同一 surfaceId 的 updateComponents/updateDataModel (注释: 杂散的 createSurface 会让客户端 MessageProcessor 抛 "Surface already exists" 并丢弃整批) .
4. 客户端把返回的 patch 追加到原消息的 a2ui 数组并写回历史, A2uiView 增量 processMessages 原地更新 surface (例如表单提交后在原表单卡片内显示状态行) .

由此形成"生成 → 渲染 → 交互 → 原地更新"的完整闭环, 且更新不产生新的聊天气泡, 交互体验收敛在 surface 内部.

#### 2.6 AI Ops 管线与其他后端

POST /api/ai_ops → lib/ai/pipelines/plan-execute-replan: 核心是一张 LangGraph StateGraph (graph.ts), 节点为 planner → executor → replanner 循环 → uiify | exhausted: planner 用 thinkModel + Output.object 结构化输出 steps; executor 每次节点运行执行一个 plan step (quickModel + 工具 + 10 步上限); replanner 用 thinkModel 结构化输出 \{done, remaining, summary\}, 条件边路由决定继续执行、进入 uiify 还是预算耗尽终止. MAX_ITERATIONS = 20 是 replan 轮数的真实预算, RECURSION_LIMIT = 525 (MAX_ITERATIONS*25+25) 仅是兜底. 节点经 getWriter() 向 "custom" 流发布 PlanExecuteEvent (plan_created / step_start / step_done / replan / done / error 六种), 驱动 index.ts 以 streamMode: "custom" 消费并对每个 chunk 用 events.ts 的 zod discriminatedUnion 逐条重校验后才 yield; 必须用 getWriter() 而非 writer() 助手 (langgraph 1.4.x 的 writer() 读 configurable.writer, 而 Pregel 已不再填充它, 会静默丢失事件); 状态用 Annotation.Root 声明 (detail 为 concat reducer), 因仓库 zod 走 zod/v4 入口, 其 ~standard 缺少 langgraph StateSchema 所需的 JSON-Schema 属性. uiify 节点执行 uiifyReport(): think 模型做一次无工具的"UI 化"后处理 (系统提示词即 A2UI_PROMPT_SECTION, 报告是唯一数据源, 没有结构化内容时回复 NONE), 输出经 extractA2ui + 一次纠错重试, surface 随 data.a2ui 返回; 失败绝不影响报告本身.

遥测 (lib/observability.ts): Langfuse 仅在 LANGFUSE_PUBLIC_KEY、LANGFUSE_SECRET_KEY、LANGFUSE_BASE_URL 三者齐备时启用, 否则全部 no-op; initObservability 以 OTEL NodeSDK + LangfuseSpanProcessor 启动 (SDK 实例缓存在 globalThis 上, 抗 dev HMR 模块重载), instrumentation.ts 在知识库 embedding 之前调用它 (仅 nodejs runtime); aiOpsCallbacks 给每次图运行挂一条 CallbackHandler trace (graph/node 级 span), observeGeneration 把每次 AI SDK 调用记录为 generation (含 token 用量), withAiOpsTrace 传播 session/tags. 离线验证: scripts/ai-ops-graph-smoke.ts (schema round-trip + 图结构断言, AI_OPS_SMOKE_LIVE=1 走真实 LLM 验证事件序列).

其他 API: chat (非流式) 、chat_stream (SSE) 、a2ui_action、ai_ops、upload (知识库上传) 、log/metrics (sentry/Prometheus) ; 统一响应形状 \{ message, data \} . 工具三层拆分 (lib/ai/tools/) : schemas.ts (zod) → operations.ts (纯函数) → index.ts (AI SDK tool) , 含 get_current_time、mysql_crud、query_internal_docs (RAG) 、query_prometheus_alerts, 另有经 MCP SDK 引入的 SSE 日志工具. instrumentation.ts 启动时把 data/docs/ 文档全部 embedding 入 Redis 向量库 (失败不阻塞启动).

文档要点: README.md 逐字列出各条管线的 prompt 并给出架构图; AGENTS.md 的 "A2UI integration (v0.9)" 一节记录关键约定 (单 `<a2ui-json>` 块、safeParse 校验、zod v3/v4 红线、纠错只重试一次且失败诚实降级、Memory 保存带标签的原始文本、reactStrictMode 关闭、catalog/ 与 components/ui/ 移植自 a2ui 仓库保持最小改动), 与现行代码基本一致; 但仍有一处过时: 它称 action 序列化为 [UI_ACTION] 走聊天通道——现行代码已改为 onRawAction → /api/a2ui_action 带外链路; 它引用的 scripts/a2ui-smoke.ts 也不存在 (scripts/ 下只有 ai-ops-graph-smoke.ts), 以代码为准.

验证手段: /gallery 页面无后端渲染全部扩展组件 (createGalleryMessages() 构造一个引用每个 shadcn 扩展组件的 surface, 消息顺序 createSurface → updateDataModel → updateComponents, 走真实 catalog 管线渲染) .

#### 2.7 具体 A2UI 界面示例

prompt few-shot builder 覆盖三类运维界面 (lib/ai/a2ui/prompt.ts):

- buildAlertListExample: Column/Text/List (模板绑定 children:\{componentId, path:"/alerts"\} ) /Card/Row/Badge/Button (action ack_alert, context 用相对路径绑定) ——告警卡片列表.
- buildMetricsReportExample: Chart (variant:"line", series/xKey) + Table (columns/rows 绑定 /rows) ——QPS 指标报告.
- buildSilenceFormExample: Card + TextField×3 (value 绑定数据模型) + Button (action create_silence, context 携带表单值) ——告警静默表单.
- buildSilenceActionUpdateExample: action 原地更新示例 (upsert form-body 加入 status-text, updateDataModel \{path:"/status"\} ) ——"只发 update、同一 surfaceId" 契约的样板.

---

### 三、调研结论

#### 3.1 协议层面的关键取舍

1. A2UI 的所有核心设计都服务于"让 LLM 可靠生成 UI": 扁平邻接表降低一次性生成的结构难度并支持增量流式; JSON Pointer 数据绑定把"结构"与"状态"拆开, 更新数据不必重发 UI; catalog 契约化让 LLM 只在已知组件集合内发挥, 把开放式代码生成收敛为受约束的 schema 填充.
2. 安全模型是"白名单式"的: 没有任意代码执行通道, agent 能做的只有声明组件、绑定数据、触发预注册的 function 与 event. 这让跨组织、跨信任边界的多 agent UI 成为可能.
3. 协议与传输、与组件库都是解耦的: 传输可以是 SSE/WebSocket/A2A/AG-UI, 组件库可以是任何设计系统. 官方甚至明说不追求跨客户端的标准 catalog, 因为解释 catalog 的本来就是 LLM.

#### 3.2 yukino-agent 的实践价值

1. 它示范了不依赖 CopilotKit 的完整自建链路: prompt 注入 (direct-json 模式) → 流式有状态过滤 → zod 校验 → 一次纠错重试 → 诚实降级, 每个环节都有明确失败语义.
2. out-of-band action 管线 (/api/a2ui_action + filterInPlaceMessages + 增量 processMessages) 是协议文档里没有现成答案、但真实应用必须解决的问题——surface 交互如何原地更新而不污染聊天流. 其防御性细节 (只允许 updateComponents/updateDataModel、只保留同一 surfaceId、防 "Surface already exists") 都是踩过坑后的经验.
3. 它把协议落地所需的两侧能力 (65 组件 catalog、A2uiView 渲染器、四格式 prompt 生成器、协议 schema 的逐字节副本) 全部内联进应用仓库 (server-safe, 无 React), 在单仓库内维护组件实现、catalog 契约与 LLM prompt 的对应关系; 代价是 catalog.json 与组件实现需手工保持同步, 仓库 AGENTS.md 以"保持最小改动"约定约束.

#### 3.3 需要注意的风险与坑

1. zod 版本红线: @a2ui/web_core 内置 zod v3, 应用层若用 zod/v4 不得混用 schema, 边界必须用 unknown[] 隔离.
2. MessageProcessor 有状态: React StrictMode 双执行会重放 surface, 开发态需关闭或妥善处理.
3. catalogId 必须两端一致, 否则 renderer 抛 "Catalog not found"; 服务端从 vendored schemas/catalog.json 取契约, 客户端 catalog/index.ts 注册实现, 同一 catalogId 的两份载体改动需同步.
4. 消息批次中杂散的 createSurface 会导致整批消息被丢弃 ("Surface already exists") , 服务端回传 patch 前必须过滤.
5. 文档漂移: yukino-agent 的 AGENTS.md 仍有与现行代码不一致的描述 ([UI_ACTION] 走聊天通道的旧设计、不存在的 scripts/a2ui-smoke.ts), 以代码为准.
6. LLM 生成的 A2UI 块天然存在格式错误概率, 必须有校验 + 有限次纠错重试 + 诚实降级的完整兜底, 不能假设模型永远输出合法 JSON.
7. LangGraph 1.4.x 发布 custom 事件必须用 getWriter() 而非 writer(), 否则事件被静默丢弃.

#### 3.4 一句话总结

A2UI 把"agent 发 UI"这件事从发代码变成了发数据, 用 catalog 契约 + 数据绑定 + 扁平组件树换取了 LLM 生成的可靠性与跨信任边界的安全性; yukino-agent 把渲染端与生成端能力 (catalog、A2uiView、四格式 prompt 生成器) 全部内联进应用仓库, 用一个运维助手应用验证了从 prompt 生成、流式渲染到交互原地更新的完整工程闭环, 其自研管线 (而非 CopilotKit) 为自建 agentic 应用提供了可复用的参考实现.
