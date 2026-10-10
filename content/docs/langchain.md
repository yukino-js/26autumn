---
title: "LangChain.js 1.x: Monorepo、Runnable 内核与 createAgent 中间件体系"
description: "拆解 LangChain.js 1.x 的 monorepo 包布局、langchain-core 的 Runnable 与消息/工具抽象、provider 集成模式、langchain 主包的 createAgent 与中间件体系, 以及构建、测试与发布设施。"
local_path: "$HOME/Downloads/langchainjs"
---

LangChain.js 是用于构建 LLM 应用的 TypeScript 框架, 1.x 起把抽象收敛到一套可组合的 Runnable 接口, 并在主包里引入基于 LangGraph 的 agent 运行时与中间件体系。本文面向要在 Node 或浏览器环境里搭建 LLM 应用与 Agent 的工程师, 按“核心抽象 → 消息与工具 → provider → agent 与中间件 → 工程设施”的顺序拆解其设计。阅读后应能判断哪些能力属于 core、哪些属于 provider 包、哪些属于主包与 classic 包。

## 定位与生态位

框架的 README 把自身定位为“agent engineering platform”, 同一生态里还有三个层次不同的项目, 边界值得先厘清:

| 项目         | 层次       | 职责                                                 |
| ------------ | ---------- | ---------------------------------------------------- |
| LangChain.js | 主框架     | 模型与工具的集成、可组合的运行抽象、agent 构建块     |
| LangGraph.js | 低层编排   | 有状态图、持久化、可控工作流、human-in-the-loop      |
| Deep Agents  | 高层封装   | 规划、子 agent、文件系统等成套能力, 构建在前两者之上 |
| LangSmith    | 开发者平台 | 调试、评测与可观测性                                 |

框架本身不负责编排拓扑: 它提供模型、工具、提示词、输出解析与回调这些组件, 以及一个内建的 ReAct 风格 agent; 需要更复杂的状态机、断点恢复或多 agent 拓扑时, 交给 LangGraph。

包布局上, 主包只保留“agent 时代”的构建块; 旧式 chains、旧式 agents、memory、retrievers 等抽象集中在 `@langchain/classic` (见下文「langchain-classic」小节)。

## Monorepo 结构与包清单

仓库用 pnpm workspace 加 Turborepo 管理, 顶层目录各司其职:

| 目录                                       | 职责                                                               |
| ------------------------------------------ | ------------------------------------------------------------------ |
| libs/langchain-core                        | 核心抽象, 所有包的地基                                             |
| libs/langchain                             | 主包, createAgent 与中间件所在                                     |
| libs/langchain-classic                     | 旧式 chains、agents、memory 等抽象                                 |
| libs/langchain-textsplitters               | 文本切分包                                                         |
| libs/langchain-mcp-adapters                | MCP 适配器                                                         |
| libs/create-langchain-integration          | 第三方集成项目的脚手架                                             |
| libs/providers                             | 一方集成包 (模型、向量库、搜索工具等)                              |
| internal                                   | 不发布的内部工具: 统一构建、tsconfig、标准测试、模型画像、测试辅助 |
| examples                                   | private 示例包, 按主题组织                                         |
| environment_tests / dependency_range_tests | 跨环境导出兼容性与依赖区间测试 (Docker)                            |

### 核心包

| 包                             | 定位                                                               |
| ------------------------------ | ------------------------------------------------------------------ |
| `@langchain/core`              | Runnable 与 LCEL、消息、工具、提示词、回调、输出解析等全部核心抽象 |
| `langchain`                    | createAgent、initChatModel、middleware、Hub、storage               |
| `@langchain/classic`           | 旧式 chains、agents、memory、retrievers 等                         |
| `@langchain/mcp-adapters`      | 把 MCP 服务器工具适配为 LangChain 工具                             |
| `@langchain/textsplitters`     | 文本切分                                                           |
| `create-langchain-integration` | 脚手架包                                                           |

### provider 集成是一个封闭集合

`libs/providers` 下的集成包按类别覆盖:

- 模型: OpenAI、Anthropic、AWS Bedrock、Cohere、DeepSeek、Fireworks、Google (Generative AI 与 Vertex AI 两条线及共享 common/auth 包)、Groq、IBM watsonx、MistralAI、Ollama、OpenRouter、Perplexity、Together AI、xAI、Cloudflare。
- 检索与搜索: Exa、Tavily、Perplexity 的 search retriever。
- 存储与向量库: MongoDB、Neo4j、pgvector、Pinecone、Qdrant、Redis、Weaviate。
- 其他: TypeSafe 分类器集成。

贡献指南明确写着一句政策: 不再接受新的集成进本仓库, 新集成必须作为独立 npm 包发布。这解释了为什么 provider 列表是一个封闭集合, 也解释了主包为何把 provider 全部做成按需动态导入。

### 根脚本与依赖治理

根脚本全部走 Turbo: 构建是 `turbo build:compile`; 单测用 filter 排除导出测试、示例与脚手架包; 完整测试串联单测与环境导出兼容 Docker 测试, 依赖版本区间 Docker 测试单独触发。发布走 Changesets, changelog 由 GitHub 插件生成。lint 与 format 用 oxlint 与 oxfmt。

依赖治理有两条值得记录的做法: 一是把核心包与主包 override 为 `workspace:^`, 保证 monorepo 内所有包都链接到本地源码; 二是一大批供应链 overrides, 既给常见易受攻击的传递依赖设版本地板, 也把一批容易被抢注的基础包替换为官方镜像包。

## langchain-core: Runnable 内核与 LCEL

### 一切皆 Runnable

`Runnable` 是所有可组合单元的基类, 继承序列化基类并实现 Runnable 接口。子类只需实现 `invoke` 这一个抽象方法, `batch`、`stream` 等都有默认实现:

```ts
export abstract class Runnable {
  abstract invoke(
    input: RunInput,
    options?: Partial<CallOptions>,
  ): Promise<RunOutput>;
}
```

三个默认实现承载了框架的核心行为:

- `batch` 用并发限流器执行数组输入, 支持把异常作为结果返回 (`returnExceptions`), 适合“部分失败可接受”的批处理。
- `stream` 把子类的异步生成器包进一个带 setup 的包装器, 再转成可迭代流。注释明确说明先 `await setup` 的目的是缓冲第一个 chunk, 让初始化阶段的错误立即暴露, 而不是等到消费时才浮现。
- `pipe` 把任意可组合对象强制转换后组成序列, 于是 `prompt.pipe(model).pipe(parser)` 成为可读性很高的 LCEL (LangChain Expression Language) 写法。

组合器方法 (均为实例方法且返回新 Runnable):

| 方法                     | 返回                  | 语义                       |
| ------------------------ | --------------------- | -------------------------- |
| withRetry                | RunnableRetry         | 失败重试                   |
| withConfig               | RunnableBinding       | 绑定默认配置               |
| withFallbacks            | RunnableWithFallbacks | 主路径失败时按序回退       |
| pipe                     | RunnableSequence      | 串接                       |
| streamLog / streamEvents | 日志流 / 事件流       | 把流式输出重放为结构化事件 |

### RunnableSequence 与 RunnableMap

`RunnableSequence` 是 LCEL 管道的主角。它的 `invoke` 逐步执行首步与各个中间步: 每一步都用配置补丁挂上以 `seq:step:N` 命名的子回调, 使回调层级在嵌套组合时仍能正确对应; 全程用 `raceWithSignal` 支持中断。

序列上的 `pipe` 会做扁平化: 如果接上的仍是序列, 就把两段中间步合并, 避免嵌套加深。这一细节决定了长管道的调用栈不会线性增长。

`RunnableMap` (别名 `RunnableParallel`) 对字典里的每个键并行调用对应 Runnable, 汇总成同构的结果; 它是“同一输入分发到多条支路”的语法糖。

### 其余 Runnable 族

| 能力           | 类/机制                                                              |
| -------------- | -------------------------------------------------------------------- |
| 恒等传递       | RunnablePassthrough, 支持 assign 追加字段                            |
| 条件路由       | RunnableBranch                                                       |
| 命名路由       | RouterRunnable                                                       |
| 聊天历史注入   | RunnableWithMessageHistory                                           |
| 异步生成器包装 | RunnableGenerator                                                    |
| 绑定与重试     | RunnableBinding、RunnableRetry、RunnableWithFallbacks                |
| 配置工具       | ensureConfig、mergeConfigs、patchConfig、getCallbackManagerForConfig |
| 图与可视化     | 运行图结构与 Mermaid 输出                                            |

框架大量使用鸭子类型守卫而不是严格的类同一性判断: 例如判断一个对象是否绑定, 看它是否持有一个 Runnable 类型的 `bound` 字段; 判断是否序列, 看 `middle` 是否为数组。这种写法让跨包的组合对象仍然可识别, 代价是类型层面需要额外的守卫函数。

### 序列化基座

Runnable 继承的序列化基类定义了 `lc_serializable`、`lc_namespace`、`lc_name`、`lc_secrets`、`lc_aliases` 等静态约定。其中 `lc_secrets` 被构建插件扫描, 用来自动生成环境变量映射类型与文档, 这是“代码即配置文档”的一个例子。

### 子路径导出

core 的 package 导出提供七十余个子路径, 全部按功能域拆分, 例如 runnables、messages 及其 tool 子域、tools、prompts、output_parsers、callbacks 的 base/manager/dispatch、language_models 的 base/chat_models/structured_output、retrievers、tracers、load 与 load/serializable、embeddings、caches、documents、errors、memory、chat_history、context、indexing、example_selectors。细粒度子路径是各包 tree-shaking 与按需加载的基础。

core 的依赖面极窄: 一个浏览器可用的 JSON Schema 校验实现、标准 schema 规范、token 计数、LangSmith 客户端、mustache、p-queue 与 zod。

## 消息体系

### BaseMessage 与子类

消息体系的基类继承序列化基类, 命名空间为 `langchain_core/messages`, 内容是 `string | ContentBlock 数组`。子类按角色划分:

| 类              | 说明                                                            |
| --------------- | --------------------------------------------------------------- |
| HumanMessage    | 用户消息                                                        |
| AIMessage       | 模型消息, 携带 tool_calls、invalid_tool_calls 与 usage_metadata |
| SystemMessage   | 系统提示                                                        |
| ToolMessage     | 工具结果                                                        |
| ChatMessage     | 任意自定义 role                                                 |
| FunctionMessage | function calling 结果消息                                       |

### Chunk 与流式累加

每个消息类都有对应的 Chunk 变体, 继承 `BaseMessageChunk`。Chunk 的唯一抽象方法是 `concat`, 用于流式累加: 合并内容、`additional_kwargs` 与 `response_metadata`。这是流式输出能被拼回完整消息的机制。

`BaseMessage` 与 `BaseMessageChunk` 都覆写了 `Symbol.hasInstance`, 沿原型链做结构化判定而不是严格的类同一性。原因很直接: provider 包与 core 包可能各自持有一份类定义, 跨包 `instanceof` 必须仍然可靠。跨包判断统一使用各类的静态 `isInstance`。

### 内容块体系

消息内容支持结构化块, 例如 text、image_url、tool_call、reasoning 等类型。当模型响应元数据标记版本为 v1 时, 构造器会把内容强制规整为内容块数组, 并双向同步 `tool_calls` 与内容块中类型为 tool_call 的条目。这套机制是 1.x 支持多模态与推理模型输出的基础。

## 工具体系

### StructuredTool

工具基类要求实现名称、描述、schema 与 `_call`。两个设计点值得记录:

- `_call` 可以返回 Promise 或异步生成器; 后者用于工具执行过程中发出中间事件, 每个 yield 会转成工具事件回调。
- `returnDirect` 为 true 时, 工具返回后 agent 应停止循环, 而不是把结果再喂回模型。

调用路径上, 如果输入是 ToolCall 结构, 框架会取出参数并把整个调用塞进配置; 执行后按是否存在 toolCallId 决定返回原始输出还是包装成 ToolMessage。

输入校验兼容 zod v3/v4 与 JSON Schema 两种形态, 校验失败抛出专门的解析异常。

### Tool、DynamicTool 与 tool() 工厂

- `Tool`: 字符串输入的特化工具。
- `DynamicTool`: 由名称、描述与函数动态构造, 函数接收字符串。
- `DynamicStructuredTool`: 带 schema 的动态工具, schema 可传 zod 或 JSON Schema。

面向用户的推荐入口是 `tool()` 工厂, 它有十余个重载覆盖 zod v3/v4 的字符串与对象 schema、JSON Schema, 以及带运行时上下文的变体。分派逻辑很直白: schema 缺省或退化为纯字符串时生成 DynamicTool, 否则生成 DynamicStructuredTool。两条路径都会把用户函数包进异步上下文配置, 并注册中断信号监听; core 保留的环境配置子集 (`pickRunnableConfigKeys`) 除回调、超时、信号等字段外还包含 `store` 与 `context`, 使工具内部调用的 LangGraph 助手 (`getConfig()`、`getStore()` 等) 依然能取到运行时字段。

一个典型用法如下, 工具函数的第二个参数由框架自动注入运行时上下文:

```ts
const greet = tool(
  async ({ name }, runtime) => {
    const userId = runtime.context?.userId;
    await runtime.store?.mset([["key", "value"]]);
    runtime.writer?.("Processing...");
    return `Hello, ${name}`;
  },
  {
    name: "greet",
    description: "Greet the user",
    schema: z.object({ name: z.string() }),
  },
);
```

### ToolRuntime: 自动注入的运行时上下文

当工具函数声明名为 `runtime` 的参数时, 执行系统自动注入运行上下文, 包含: 当前图状态、工具调用 ID、运行配置、应用上下文、长期存储与流式输出写入器。它把“工具需要知道的运行时信息”从参数 schema 里剥离出来, 让工具的输入 schema 保持纯净。

### 返回类型与守卫

工具返回类型是一个条件类型, 编码了“带 toolCall.id 的配置返回 ToolMessage, 否则返回工具自身输出”的语义。仓库还提供一组守卫: 判断结构化工具 (看是否存在命名空间数组)、判断 Runnable 风格工具、判断结构化工具参数等。createAgent 把工具分为客户端工具与服务端工具两类, 对应“客户端声明”与“可执行”两种角色。

## 提示词模板与输出解析器

### Prompt 体系

提示词基类本身是一个 Runnable: `invoke` 把格式化结果包进带回调的执行, 运行类型标为 prompt。构造器禁止名为 `stop` 的变量, 因为该名字被内部保留。

| 能力       | 类/机制                                 |
| ---------- | --------------------------------------- |
| 模板解析   | f-string 与 mustache 两种方言           |
| 纯文本模板 | PromptTemplate, 带 fromTemplate         |
| 聊天模板   | ChatPromptTemplate 及消息模板族         |
| 占位符     | MessagesPlaceholder, 展开为消息列表     |
| 少样本     | FewShotPromptTemplate                   |
| 图像与字典 | ImagePromptTemplate、DictPromptTemplate |
| 结构化     | StructuredPrompt, 从消息与 schema 构造  |

聊天侧的类层次里, `BaseMessagePromptTemplate` 直接继承 Runnable; 其子类包括人类、系统与 AI 消息模板。`ChatPromptTemplate.fromTemplate` 用文本模板解析后包一层人类消息模板, 等价于单条用户消息; `fromMessages` 接收消息模板或元组, 嵌套的聊天模板会被展平, 部分变量逐层合并, 输入变量汇总去重。图文模板里图像部分最多只允许一个变量。

### 输出解析器

层次关系是: 输出解析器基类继承 LLM 输出解析器, 后者继承 Runnable; 字符串与 JSON 系解析器经由变换解析器与累积变换解析器支持流式增量解析。

`BaseOutputParser` 增加 `parse` 与 `getFormatInstructions` 两个抽象方法。解析异常携带模型输出、观察值与“是否要把错误发回模型”的标志, 并打上统一错误码 —— `sendToLLM` 为 true 时要求提供观察值与输出, 便于 agent 把解析失败反馈给模型重试。

最常用的字符串解析器对内容块的处理覆盖 text、text_delta、image_url (抛错, 无法转字符串) 与 reasoning 系列 (返回空串), 与 1.x 的内容块体系对齐。JSON 系解析器是累积式的, 通过比较增量来支持流式部分 JSON 的解析; 结构化解析器基于 zod schema 生成指令; 另有标记式、列表式、字节式解析器与 tool calls 解析器。`@langchain/classic` 另提供修复解析器与路由解析器。

## Callbacks 与追踪

### 回调处理器

回调处理器的基类定义了一组事件方法与若干行为开关:

- `ignoreLLM`、`ignoreChain`、`ignoreAgent`、`ignoreRetriever`、`ignoreCustomEvent` 五个忽略开关。
- `raiseError` 默认 false: 处理器内部抛错只记录警告, 不影响主流程; 置 true 才抛出。
- `awaitHandlers` 默认取决于环境变量, 决定是否等待处理器完成。
- 可从普通方法对象生成处理器类; 鸭子类型判定依据是存在复制函数、名称字符串与 `awaitHandlers` 布尔值。

可挂接的事件覆盖 LLM 开始/新 token/结束/错误、聊天模型流事件、链开始/错误/结束、工具开始/事件/错误/结束、agent 动作与结束、检索器开始/结束/错误、自定义事件。另有两个能力偏好接口, 允许处理器声明“偏好流式”或“偏好聊天模型流事件”。

### CallbackManager 与 RunManager

回调管理器的核心入口是静态配置方法, 把可继承与本地两组处理器、标签与元数据合并后返回新管理器。事件方法会为每个 run 分配 ID (第一个用传入值, 其余用有序 UUID), 并对追踪类处理器同步创建 run —— 注释写明原因: 回调可能被后台化, 同步建 run 才能避免竞态。

每个事件方法返回对应的运行管理器 (链、LLM、工具、检索器), 它们都继承一个基础运行管理器, 提供 `getChild(tag)` 把可继承的处理器、标签与元数据传播给子 run。这是 Runnable 树里回调层级正确嵌套的机制。

### 追踪器

追踪器基类把回调事件聚合成 run 树, 并把工具调用 ID 记入工具 run 的附加字段, 与 Python 版本对齐, 使外部追踪后端能为工具 span 发出标准属性。LangSmith 上报由独立的 langsmith 包完成; 另有独立于对象树的自定义事件派发 API。

## 模型 Provider 集成

### 接口统一、实现分散

语言模型基类定义在 core 里, 包括基础链抽象、聊天模型、补全模型、结构化输出能力与模型能力画像。接口统一、实现分散在各 provider 包 —— 例如 provider 包会继承 core 的聊天模型基类并覆写同一套 Runnable 接口。

以 OpenAI 集成包为例, 它的集成模式是: 继承 core 的聊天模型基类, 把厂商 SDK 的调用参数映射为类字段 (temperature、topP、惩罚项、token 上限、API key 等), 通过生成与流式两个钩子接入实际调用, 并声明密钥字段到环境变量的映射。

### 当前版本值得关注的两项能力

- 模型能力画像新增可选 `fileMimeTypes` 字段, 声明模型接受的通用文件类型。OpenAI 集成把 Responses API 接受的输入文件类型清单写进每一份生成的静态画像, 再在实例的 profile getter 里用 `withoutFileMimeTypesUnlessSupported` 按需剥离: 只有走 Responses API 且画像声明 `pdfInputs` (PDF 与通用文件走同一 input_file 通道, 故以它作代表) 的实例保留清单, Chat Completions 类恒剥离, ChatOpenAI 入口类按本实例是否解析为 Responses API 判定。
- 系统消息上的工具变更支持。OpenAI 侧, 非 assistant 消息 (含系统消息) 内容中的 `additional_tools`、`configuration_update`、`mcp_approval_response` 块会被从消息中提升为 Responses API 的顶层输入项, 插入在该消息之前 (经 core 非标准包裹的块先解包; assistant 消息是模型输出的回放, 恒不提升); Chat Completions 路径的系统/developer/assistant 消息只保留文本块, 其余块被过滤。Anthropic 侧, 系统消息可携带 `tool_addition`/`tool_removal` 块 (支持内联工具定义), 请求构造时按消息转换结果自动追加 `inline-tools` 或 `mid-conversation-tool-changes` beta 头; 系统内容被收窄为 Anthropic 接受的闭集 (text 块保留 cache_control 与 citations), 其余块被丢弃, 收窄后为空则整个字段置空。

### initChatModel 与 ConfigurableModel

主包提供运行时按名称实例化模型的能力。它维护一张静态表把 provider 键映射到 npm 包与类名, 例如 openai 与 azure_openai 落到 OpenAI 包的不同类, Google 三条线各自对应不同的类 (其中两条类名相同, 注释说明因此需要按 provider 直查以避免碰撞), 以及 ollama、mistral、groq、bedrock、deepseek、xai 等。

`initChatModel` 支持 `provider:model` 字符串写法: 以冒号切分后, 若第一段命中 provider 表则视为 provider, 剩余部分为模型名。可配置字段控制哪些参数能在运行时经配置覆盖 (默认是 model 与 modelProvider), 多模型共存时可加前缀。返回值是 `ConfigurableModel`, 一个延迟绑定真实模型类的 Runnable 包装。

这解释了主包的依赖为何如此精简: 只有 LangGraph 相关包、checkpoint 包、langsmith 与 zod; provider 全部按需动态导入, 不进静态依赖。

### standard-tests: 集成一致性测试

内部的标准测试包提供聊天模型的单元测试与集成测试两个基类, 不对外发布, 供 monorepo 内使用。用法是 provider 包把它作为开发依赖, 继承基类并声明能力标志 (是否支持工具调用、是否支持结构化输出等), 运行测试返回布尔值; 单测通过环境变量注入假密钥。多个 provider 包已落地这套机制, 每个都有标准单测与标准集成测试两个文件。它解决的是“每个 provider 各写一套行为测试”的重复劳动问题。

## langchain 主包: createAgent 与中间件体系

### 包面

主包的源码结构为: `agents/` (核心)、聊天模型的通用入口 (initChatModel)、Hub (提示词拉取)、序列化加载、提示词的再导出加选择器、storage (内存、本地文件、编码器支持的存储), 以及无头工具与浏览器入口。导出的子路径覆盖根、浏览器、通用聊天模型、Hub、加载、序列化加载、三种 storage、tools 等。

### ReactAgent 与三节点模型

`createAgent` 有十余个重载, 覆盖结构化输出格式的各种组合, 实现体只有一句 `return new ReactAgent(params)`。ReactAgent 的类注释描述了 ReAct 三节点模型:

```text
model_request ──▶ 模型调用
tools         ──▶ 工具调用 (每个工具调用可拆分为独立任务)
END           ──▶ 结束
```

这三者是图中唯二可从其他节点跳转到的目标 (加上 END)。前后还有四个钩子节点: 代理前、模型前、模型后、代理后, 它们就是中间件的挂载点。

ReactAgent 用一个类型配置包承载全部类型信息 (响应、状态、上下文、中间件、工具、流转换器)。运行时底座是 LangGraph: 从 LangGraph 引入 StateGraph、START、END、Send、Command、编译图与流模式类型; 从 checkpoint 包引入检查点保存器与 Store 基类。状态原语 (StateSchema、消息值、非追踪值、归约值) 也来自 LangGraph。

图的节点在 `agents/nodes/` 下分别对应模型请求、工具、前后钩子。状态模式上, 用户 stateSchema 与各中间件 stateSchema 会合并; `jumpTo` 字段用非追踪值承载内部跳转控制; 下划线开头的字段是私有状态, 留在图状态中但不暴露为输入输出通道; zod 的归约元数据会被包成归约值; 最终输出状态、输入、输出三个 schema, 消息一律用消息值。

流式 API 提供 v1/v2/v3 三个版本的重载, v3 返回运行流并支持调用点传入流转换器; 还提供直接渲染图结构的 Mermaid 字符串与 PNG 方法。

### createAgent 参数

| 参数                        | 说明                                 |
| --------------------------- | ------------------------------------ |
| model                       | 字符串 (走 initChatModel) 或模型实例 |
| tools                       | 工具数组                             |
| systemPrompt                | 字符串或 SystemMessage               |
| stateSchema / contextSchema | 会话状态 schema 与只读上下文 schema  |
| checkpointer                | 检查点保存器, 或布尔开关             |
| store                       | 长期存储                             |
| responseFormat              | 结构化输出格式                       |
| middleware                  | 中间件数组                           |
| name / streamTransformers   | 代理名与流转换器                     |

### createMiddleware 与钩子

`createMiddleware` 是工厂函数, 接受名称、状态 schema (跨调用持久化)、上下文 schema (只读且不持久化)、附加工具、流转换器, 以及六个钩子 —— 两个包装钩子加四个生命周期钩子:

- `wrapModelCall`: 包装模型调用, 可改请求、重试或返回 Command 控制流向。
- `wrapToolCall`: 包装工具执行, 用途包括改参数、错误处理与重试、结果后处理、缓存、日志、鉴权, 以及返回 Command 做高级控制。
- `beforeAgent` / `afterAgent`: agent 调用开始与结束时各跑一次, 可改状态; 对应图里的代理前与代理后钩子节点。
- `beforeModel` / `afterModel`: 每次模型调用前后运行; beforeModel 在 wrapModelCall 之前执行, afterModel 在模型调用之后、工具调用之前执行, 二者都返回状态更新。

中间件链在运行时被串成一条链, 并有一个容易忽略但很重要的语义: 每个中间件的包装函数看到的始终是进入链条前的完整原始状态, 即使请求被内层中间件修改过, 每个中间件仍按自己的 schema 解析原始状态。注释解释这样做的原因 —— schema 解析必须稳定, 否则内层对工具的覆盖会让外层解析出错。此外, 链条会跟踪下游处理器实际抛出的异常对象, 避免“原样向上传递”被误判为本中间件的失败。

### 内置中间件

| 中间件                           | 职责                                          |
| -------------------------------- | --------------------------------------------- |
| hitl                             | 人工介入中断                                  |
| summarization                    | 上下文摘要压缩                                |
| dynamicSystemPrompt              | 运行时动态系统提示词                          |
| llmToolSelector                  | 用 LLM 预选工具子集                           |
| pii / piiRedaction               | PII 检测与脱敏, 附带邮箱、信用卡、IP 等检测器 |
| contextEditing                   | 上下文编辑, 含清除工具调用结果的编辑          |
| toolCallLimit / modelCallLimit   | 工具调用与模型调用次数上限                    |
| todoList                         | 待办清单工具与系统提示词                      |
| modelFallback / modelRetry       | 模型降级与重试                                |
| toolRetry / toolError            | 工具重试与错误处理                            |
| toolEmulator                     | 工具模拟执行                                  |
| providerToolSearch               | provider 侧工具搜索                           |
| openAIModeration                 | OpenAI 内容审核                               |
| anthropic / bedrockPromptCaching | 提示词缓存                                    |

另有一个近似 token 计数的工具函数。toolRetry 在重试分类之前会把 LangGraph 控制流异常 (`isGraphBubbleUp`, 含人机中断) 原样重新抛出, 保证 MCP elicitation 这类工具中断不会被当成普通工具错误吞掉。这套中间件把“生产环境常见横切关注点”从用户代码里剥离出来, 用户只需按需组合。

### 上下文压缩策略

agent 长对话里消息历史只增不减, 迟早撞上模型上下文上限。主包把“压缩”做成中间件, 且都挂在模型调用前后, 走两条路线: 要么有损地把旧历史摘成一段文字 (summarization), 要么结构化地把占大头的工具结果就地清空 (contextEditing)。两者共享同一套触发/保留配置原语与近似 token 计数, 但落点不同 —— 一个改图状态, 一个只改本次请求。

**消息级原语。** 压缩中间件不重新发明轮子, 底层复用 core 的消息变换函数:

| 原语                | 位置 (core messages/) | 作用                                                                                       |
| ------------------- | --------------------- | ------------------------------------------------------------------------------------------ |
| trimMessages        | transformers.ts       | 按 token 预算裁剪消息数组; strategy first/last、allowPartial、includeSystem、startOn/endOn |
| filterMessages      | transformers.ts       | 按消息类型/条件过滤                                                                        |
| RemoveMessage       | modifier.ts           | type 为 remove, 按 id 标记删除单条消息                                                     |
| REMOVE_ALL_MESSAGES | @langchain/langgraph  | 哨兵 id; 配 RemoveMessage 使用, 消息 reducer 遇到即丢弃此前累积的全部消息                  |

trimMessages 的 tokenCounter 既可以是函数, 也可以直接传模型 (用其 getNumTokens)。RemoveMessage 本身不删, 真正的删除发生在 LangGraph 的消息 reducer: 收到 id 等于 REMOVE_ALL_MESSAGES 的 RemoveMessage 时清空已累积消息, 收到普通 id 时按 id 定位并删除。

**summarization: 摘要式有损压缩。** summarizationMiddleware 挂在 beforeModel 钩子, 触发时返回一条状态更新, 用摘要替换旧历史。触发 (trigger) 与保留 (keep) 共用 fraction/tokens/messages 三个维度:

| 配置                          | 说明                                                           |
| ----------------------------- | -------------------------------------------------------------- |
| model                         | 摘要模型; 字符串走 initChatModel, 或直接给模型实例             |
| trigger                       | 单条件对象 (内部各字段 AND) 或条件数组 (条件之间 OR)           |
| keep                          | 保留量, fraction/tokens/messages 三选一; 缺省 { messages: 20 } |
| tokenCounter                  | 默认 countTokensApproximately                                  |
| summaryPrompt / summaryPrefix | 默认 DEFAULT_SUMMARY_PROMPT 与固定前缀                         |
| trimTokensToSummarize         | 送入摘要模型前的裁剪预算, 默认 4000                            |

实现思路:

- fraction 需要模型画像才能换算成 token: getProfileLimits 先读 model.profile.maxInputTokens, 回退到按模型名查 getModelContextSize, 再取 floor(上限 × fraction)。用了 fraction 却拿不到画像时直接报错, 要求改用绝对 token。
- token 计数默认是近似的: countTokensApproximately 按“1 token ≈ 4 字符”累加消息文本、工具调用 JSON 与 tool_call_id, 除以 4 向上取整。
- 决定切点时保护工具调用对完整性: 若切点落在 ToolMessage, 向前回溯找到带对应 tool_calls 的 AIMessage 一并纳入摘要段 (搜索窗口 SEARCH_RANGE_FOR_TOOL_PAIRS=5); token 型 keep 用二分查找定位最早的可保留后缀。
- 摘要消息构造为 HumanMessage, 复用被替换段首条消息的 id (在 reducer 里投影为“更新”而非“新增”), 打上 lc_source: summarization 标记; 最终返回 { messages: [RemoveMessage(REMOVE_ALL_MESSAGES), 摘要, ...保留消息] }。
- 送摘要前先 trimMessagesForSummary (strategy last、allowPartial、includeSystem), 失败回退到最后 15 条; 用 getBufferString 把消息压成紧凑文本, 避免元数据膨胀 token。

**contextEditing: 结构化编辑。** contextEditingMiddleware 挂在 wrapModelCall 钩子, 把编辑策略抽象成 ContextEdit 接口, apply 就地修改 messages 数组:

```ts
interface ContextEdit {
  apply(params: {
    messages: BaseMessage[];
    countTokens: TokenCounter;
    model?: BaseLanguageModel;
  }): void | Promise<void>;
}
```

默认策略 ClearToolUsesEdit 对齐 Anthropic 的 clear_tool_uses 行为:

| 配置            | 默认               | 说明                                             |
| --------------- | ------------------ | ------------------------------------------------ |
| trigger         | { tokens: 100000 } | 触发条件, 同样支持 fraction/tokens/messages 组合 |
| keep            | { messages: 3 }    | 保留最近 N 个工具结果 (也可按 tokens/fraction)   |
| placeholder     | "[cleared]"        | 替换工具输出的占位文本                           |
| clearToolInputs | false              | 是否同时把对应 AIMessage 的工具入参清成 {}       |
| excludeTools    | []                 | 豁免不清理的工具名                               |

语义要点: 无论是否触发, 都先清掉没有对应 AIMessage 的孤儿 ToolMessage; 清理时保留 tool_call_id 与调用结构, 只把内容换成占位符, 并在 response_metadata.context_editing 标记 cleared。tokenCountMethod 可选 approx (默认, 近似计数) 或 model (调模型的 getNumTokensFromMessages, 目前仅 OpenAI 支持)。

与 summarization 的关键边界: contextEditing 就地编辑 request.messages 后直接调用 handler, 不返回任何状态更新, 改动只作用于本次模型调用看到的输入; summarization 则返回显式状态更新, 经消息 reducer 持久化进图状态。一个管“这次让模型看什么”, 一个管“历史里到底留什么”。

**取舍与组合。** 工具结果占大头、且后续很少回看时优先 contextEditing —— 无损于对话结构、几乎零成本; 需要真正缩短历史、接受信息损失时用 summarization。两者可同时挂在一个 agent 上, 也可与工具侧裁剪 (llmToolSelector / providerToolSearch)、动态系统提示 (dynamicSystemPrompt) 等正交策略组合; 更底层的消息裁剪属于 LangGraph 层, 见 [LangGraph](langgraph)。

### Context 与 State 的边界

官方示例把这对概念定义得很清楚, 值得原样记住:

```text
Context: 静态运行时参数 (用户 ID、数据库连接、配置)
  - 每个会话或请求设置一次
  - 会话期间不变
  - 用于查用户信息、配置行为

State: 动态会话数据 (消息、记忆、会话变量)
  - 交互过程中被修改
  - 随会话持久化并演化
  - 由 agent 框架管理
```

示例的组织方式是能力地图: 访问外部上下文 (在工具内外)、访问长期记忆、访问线程级状态、控制消息准备、自定义系统提示、流式、结构化输出、supervisor、工具、调用前更新模型、调用前更新工具、动态工具与中间件子目录。多 agent 示例另有 handoffs 与 subagents 等场景。

### 长期记忆

createAgent 支持跨会话的长期记忆, 载体是 store 参数, 与只记录单次对话的短期消息历史分工明确。

**store 参数与类型。** createAgent 的 store 类型是 @langchain/langgraph-checkpoint 的 BaseStore (与 checkpointer 的 BaseCheckpointSaver 同包)。ReactAgent 在编译 StateGraph 时把它原样传入 compile({ checkpointer, store, ... }), 并暴露 get/set store 代理到内部编译图。

**谁拿得到 store。** 运行期有一个 Runtime 对象 (agents/runtime.ts 里是 LangGraph Runtime 的只读投影), 字段包括 context、store、configurable、writer、interrupt、signal 等。中间件钩子都能读 runtime.store: beforeModel 的第二个参数是 runtime, wrapModelCall / wrapToolCall 则通过 request.runtime 拿到。工具侧由 ToolRuntime 注入 runtime.store (见上文「ToolRuntime」小节, 此处不重复)。

**工具内读写。** 典型路径是工具按命名空间经 runtime.store 存取: get(namespace, key)、put(namespace, key, value)、search(namespacePrefix, options), 另有 delete 与 listNamespaces。命名空间常用 userId 这类可配置键 (config.configurable) 区分租户。

**与短期记忆的分工。** checkpointer 存“线程内”的消息历史 (同一 thread_id 的多轮对话), store 存“跨线程/跨会话”的长期事实。BaseStore 的内部实现与 InMemoryStore、持久化后端属于 LangGraph 范畴, 详见 [LangGraph](langgraph)。

**适用场景。** 官方示例区分两类: 程序性记忆 (固定偏好/指令, 用 store.get 确定性取出后经 dynamicSystemPrompt 注入系统提示, 始终生效) 与语义记忆 (按相似度检索, 交给工具按需 search, 问到才查)。前者适合用户偏好、行为约定, 后者适合历史事实与过往交互。

## langchain-classic: 旧式 chains 与 agents

`@langchain/classic` 是主包之外的独立包, 汇集主包未涵盖的抽象: 旧式 agent 与执行器 (react、chat、conversation、xml、openai functions 等多种实现)、chains (LLMChain、检索问答链等)、memory (BufferMemory、BufferWindowMemory、EntityMemory 等)、retrievers、vectorstores、文档加载与转换、evaluation、experimental (autogpt、openai assistant、plan-and-execute 等)、smith、indexes、cache、输出解析器 (含修复解析器与路由解析器)、prompts、tools、hub、storage、stores、SQL 数据库与文本切分。

它与 Runnable 体系的桥是 `AgentRunnableSequence`: 继承 `RunnableSequence`, 附加流式 Runnable 与单动作标志, 并提供静态守卫, 使旧式 agent 对象仍可作为 Runnable 参与 LCEL 组合。

## langchain-mcp-adapters: MCP 适配器

适配器把 MCP 工具接入 LangChain 工具协议, 基于 MCP SDK 新版构建, 同一适配器内可混用现代与旧版协议的服务器 (每个服务器独立协商, 模式可取 auto、modern 或 legacy); 对核心包与 LangGraph 都是必需的同级依赖。

公开能力面:

- `MCPAdapter` 是主类。
- 工具发现双入口: `listTools()` 返回可执行的动态结构化工具扁平列表, `listToolsets()` 按服务器分组。
- 工具名默认带服务器名前缀: 服务器上名为 search 的工具会暴露为 `docs_search` (服务器名与工具名之间是单下划线); 另有一个 `additionalToolNamePrefix` 选项, 它用双下划线拼接 (如 `mcp__docs_search`)。关闭服务器名前缀时, 两个服务器暴露同名工具或同一服务器重复列名都会抛错。独立辅助函数 `loadMcpTools` 默认不加前缀。
- 配置经 zod 严格校验: 未知选项、与服务器模式或传输不匹配的选项、空服务器映射、同时设置两套配置键都会抛错。

连接类型覆盖 stdio、流式 HTTP 与 SSE; SSE 传输只走旧协议协商 (`versionNegotiation` 置为 legacy), modern 模式把协议版本钉在 `2026-07-28`, auto 模式先尝试协商。现代 MCP 的 elicitation 默认开启: 服务器请求用户输入时以 LangGraph 中断暂停运行, 恢复值按产生中断的任务 ID 组键、配合 Command 使用; 仅当工具真正请求输入时才需要检查点保存器, 恢复后工具从头重跑。

工具结果与错误有统一映射: 服务器返回错误结果时, agent 场景得到状态为 error 的 ToolMessage, 直接调用仍抛异常; 图像与音频内容转成标准内容块, resource link 变成 file 块; 结构化内容与元数据保留在 artifact 的固定键下。包还转导出 OAuth 相关类型。

## 构建、测试与发布设施

### 统一构建

内部构建包为所有包提供预配置的 tsdown 构建。默认配置是: 双格式 (CommonJS 加 ESM)、目标 ES2022、Node 平台、固定扩展名策略 —— 注释解释了为什么刻意不让 ESM 产物输出 `.mjs`, 因为 `"type": "module"` 的包需要稳定的 `.js` ESM 产物。类型声明并行生成, 产物再经三个校验: 类型解析测试 (ATTW)、包发布规范检查 (publint) 与未使用导出检查。

四个构建插件承载框架特有的生成逻辑:

| 插件         | 产物                       | 作用                                                                          |
| ------------ | -------------------------- | ----------------------------------------------------------------------------- |
| 密钥插件     | 密钥映射类型               | 扫描所有密钥声明, 收集环境变量名并校验命名规范                                |
| 导入常量插件 | 可选导入入口数组           | 声明可选依赖入口点                                                            |
| 导入映射插件 | 导入映射文件               | 为所有入口生成带命名空间别名的再导出, 别名用双下划线 (如 `tools__calculator`) |
| CJS 兼容插件 | 各入口的 cjs 与类型 barrel | 双格式包的模块解析兼容                                                        |

包名到别名前缀的映射规则固定: 主包 `langchain` 生成 `langchain/...` 前缀, `@langchain/openai` 生成 `langchain_openai/...`, 规则是把 `@langchain/` 作用域名的后缀用下划线接到 `langchain` 之后 (无作用域的主包后缀为空)。

### 测试矩阵

- 单测: 走 Turbo, 用 filter 排除导出测试、示例与脚手架; core 用 vitest, 并带依赖分析工具。
- 导出兼容: 一组 Docker 测试目录, 分别验证 ESM、CommonJS、TypeScript 编译、esbuild、Vite、Vercel、Cloudflare、Bun 与 classic 包等形态下的包导出; 另有 zod 兼容测试 (v3、v4 与混合失配三种变体), 验证双版本 zod 互操作。
- 依赖区间: 用 Docker 对依赖版本区间做回归。
- 集成一致性: 聊天模型标准测试。
- 命名约定: 单测 `*.test.ts`、集成 `*.int.test.ts`、类型测试 `*.test-d.ts`、标准测试 `.standard.test.ts` 与 `.standard.int.test.ts`, 测试与被测模块同目录的 tests 下。

### 发布流程

发布入口是 npm 的可信发布通道 (基于 OIDC), 推主分支时走 Changesets 的版本与发布动作, 手动触发时走开发版发布。开发版默认 npm tag 为 dev, 版本由 Changesets 的 snapshot 生成, 形如“基础版本 + dev + 时间戳”, 安装方式为 `npm install @langchain/core@dev` 或按发布说明给出的精确 snapshot 版本安装。每个发布包有独立 changelog。

### 编码规范

- TypeScript 共享配置: 目标 ES2022、模块 ESNext、bundler 解析、严格模式。
- lint 规则: 禁止 `process.env` (测试除外)、禁止显式 any、优先模板字符串、导入必须带文件扩展名。
- 导入约定: 本地导入一律带 `.js` 扩展名 (ESM), 只用命名导出。
- zod 双版本: 同时支持 v3 与 v4, 分别以 `zod/v3` 与 `zod/v4` 子路径导入。
- 文件命名: 源文件 snake_case, 索引 index.ts, 类型 types.ts。

## 适用场景与选型建议

适合使用:

- 需要在同一套抽象下接入多家模型与工具, 且希望切换 provider 不改调用代码;
- 需要即时可用的 agent 运行时 (ReAct 循环、结构化输出、人工介入、上下文压缩), 又不想从零搭图;
- 需要在流式、回调与追踪上与生态 (LangSmith、OpenTelemetry 风格的属性) 对接;
- 需要 MCP 工具接入, 并希望现代与旧版 MCP 服务器能在同一进程内混用。

需要谨慎或不太适合:

- 需要高度定制的多步状态机、断点恢复或人机协作拓扑: 直接用 LangGraph 更贴合, 主包的 agent 只是它的一个封装;
- 只需要调用模型 API: 直接用厂商 SDK 的体积与依赖更小, 框架的抽象成本在这种情况下是净负担;
- 维护依赖旧式 chains 的代码: `@langchain/classic` 提供这些抽象, 新代码应使用主包的 `createAgent`;
- 对类型推断极其敏感: 框架的中间件与状态合并大量使用条件类型与 const 泛型, 复杂组合下类型错误信息可能不易读, 需要拆分中间件与显式标注。

与相邻方案的取舍可以这样看: 需要“组件库加开箱 agent”时用 LangChain.js; 需要“可控编排引擎”时用 LangGraph.js; 两者可以组合 —— LangChain 负责集成与组件, LangGraph 负责拓扑与持久化, 这也正是官方推荐的协作方式。
