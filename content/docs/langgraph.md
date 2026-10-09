---
title: "LangGraph.js: Pregel 超步引擎、通道状态模型与检查点持久化"
description: "从 monorepo 包分层讲到 StateGraph 到 Pregel 的超步执行循环、channels 与 reducers 的状态更新语义、节点间状态与上下文传递、上下文压缩与 Store 长期记忆、checkpointer 持久化与恢复、interrupt/resume 人机协同、流式输出模式与 SDK/前端集成"
local_path: "$HOME/Downloads/langgraphjs"
---

LangGraph.js 是一个用 TypeScript 编写、用于编排有状态 agent 的低层框架。本文要回答的核心问题是: 它如何把 agent 建模成一张图, 又是如何在图的一次次超步之间持久化并恢复状态。围绕这条主线, 文章依次说明 monorepo 的包分层与职责、StateGraph 的构建 API 如何编译成 Pregel 执行引擎、通道 (channel) 与归约器 (reducer) 如何定义状态更新语义、节点之间如何传递状态与上下文、如何压缩上下文并以 Store 实现长期记忆、checkpointer 如何落盘与回放、human-in-the-loop 的 interrupt/resume 如何与检查点配合、八种流式输出模式, 以及 SDK 与各前端框架集成包的定位。

适合已经写过基本 LangChain 调用、需要在多轮对话或长任务中引入可恢复状态与人工断点的开发者阅读; 也适合希望理解 Pregel/BSP 式图执行模型、而不满足于只调用高层 `createAgent` 的读者。文中引用的行为均以仓库源码为准, 无法核实的细节会显式标注为推断或边界。

## 一、包分层与职责

### 1.1 定位与设计血统

LangGraph 自我定位是"编排", 而不是模型集成或组件库: LangChain 负责提供模型、工具与可组合组件, LangGraph 负责把这些组件组织成图, 并提供长期记忆与 human-in-the-loop。它受 Google Pregel 与 Apache Beam 的消息传递式图计算模型启发, 公开接口借鉴 NetworkX 的图操作习惯; 它由 LangChain 生态构建, 但代码层面对 `@langchain/core` 的依赖集中在 Runnable、消息模型与 zod 互操作上, 因此可以脱离 LangChain 的模型层单独使用。安装入口是 `@langchain/langgraph` 加 `@langchain/core` 两个包。

### 1.2 核心执行与状态基座

| 包                                | 职责                                                                |
| --------------------------------- | ------------------------------------------------------------------- |
| `@langchain/langgraph`            | 核心库: StateGraph、Pregel 引擎、channels、prebuilt、functional API |
| `langgraph`                       | 无 scope 的规范名包装, 源码仅 re-export 核心库                      |
| `@langchain/langgraph-checkpoint` | checkpointer 基础接口、MemorySaver、Store、Cache、序列化            |

这三者构成执行与状态的底座: 核心库负责跑图, checkpoint 包负责让状态可以被保存、列举与回放。核心库自身也依赖 workspace 内的 checkpoint 与 sdk 包, 并把 `@langchain/core` 声明为 peerDependency 而非直接依赖, 使版本冲突暴露在安装期而不是运行期。

### 1.3 持久化后端与验证套件

| 包                                           | 关键事实                                                                            |
| -------------------------------------------- | ----------------------------------------------------------------------------------- |
| `@langchain/langgraph-checkpoint-sqlite`     | 基于 better-sqlite3 的同步实现; 静态工厂 `fromConnString` 直接返回实例              |
| `@langchain/langgraph-checkpoint-postgres`   | 基于 pg 连接池; 首次使用须显式 `setup()` 建表并跑 migration; 同包提供 PostgresStore |
| `@langchain/langgraph-checkpoint-mongodb`    | MongoDB 后端                                                                        |
| `@langchain/langgraph-checkpoint-redis`      | 支持 standalone 与 cluster、可选 TTL; 另有每线程单键的 Shallow 变体                 |
| `@langchain/langgraph-checkpoint-validation` | 可复用的 saver 一致性测试夹具, 供第三方后端自证兼容                                 |

所有后端实现同一个 `BaseCheckpointSaver` 抽象, 因此换后端不改图定义, 只换编译时传入的 saver。

### 1.4 SDK、前端集成与平台

| 包                                                                                 | 职责                                                                                                       |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `@langchain/langgraph-sdk`                                                         | LangGraph API 客户端; 子路径导出覆盖 client、auth、stream、ui、react、react-ui (含 server)、logging、utils |
| `@langchain/react` / `@langchain/angular` / `@langchain/svelte` / `@langchain/vue` | 各框架集成, React 侧核心是 `useStream` hook                                                                |
| `@langchain/langgraph-api`                                                         | LangGraph Platform API 的进程内实现, 基于 hono 服务器                                                      |
| `@langchain/langgraph-cli`                                                         | CLI, bin 名为 `langgraphjs`                                                                                |
| `@langchain/langgraph-ui`                                                          | 平台配套 UI 组件                                                                                           |
| `create-langgraph`                                                                 | 项目脚手架                                                                                                 |

### 1.5 高层多 agent 套件

`@langchain/langgraph-supervisor` 提供 supervisor 模式, `@langchain/langgraph-swarm` 提供带活跃 agent 记忆的群体协作, `@langchain/langgraph-cua` 是 computer use agent 实现。三者都构建在核心库的 prebuilt 图之上, 而不是重新实现执行引擎——这也是理解本仓库的关键: 上层套件是图的组合, 底层复用同一套超步与检查点机制。

## 二、从 StateGraph 到 Pregel: 图的定义

### 2.1 状态 schema 即通道规格

状态 schema 由 Annotation 描述。`StateDefinition` 本质是键到通道的映射, `Annotation.Root(spec)` 返回的 `AnnotationRoot` 通过类型投影暴露状态类型、更新类型与节点签名, 并带 `isInstance` 静态守卫以识别跨包实例。`Annotation` 本身是一个可调用对象, 有两种用法: 不带 reducer 时创建 `LastValue` 通道, 只保留节点最近一次写入的值; 带 reducer 时创建 `BinaryOperatorAggregate` 通道, 用二元归约函数聚合写入, `default` 提供初始值工厂。

```ts
const State = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: (left, right) => left.concat(right),
    default: () => [],
  }),
  count: Annotation<number>({ reducer: (a, b) => a + b, default: () => 0 }),
});
```

仓库同时支持用 zod schema 作为状态定义, 相关互操作层在 `graph/zod/` 下, 图的 `isStateDefinitionInit` 同时接受 Annotation 与 zod 对象形态; interrupt 的 `responseSchema` 也复用同一套 zod 互操作。

### 2.2 节点与边

`StateGraph` 位于 `libs/langgraph-core/src/graph/state.ts`, 继承自 `graph/graph.ts` 的 `Graph`。`addNode` 提供多个重载: 传对象映射可一次加多个节点, 传元组数组或 `key, action, options` 可逐项配置。节点级 options 支持 `input` (节点级输入 schema) 与 `errorHandler` (仅在该节点重试策略耗尽后运行的错误处理器, 可返回状态更新或 Command)。重试、缓存、超时通过 `NodePolicyOptions` 传入, `setNodeDefaults` 可设置全图默认策略; 子图不继承这些策略。`addSequence` 顺序连线一组节点。

`addEdge` 支持 fan-in: startKey 可以是节点名数组, 数组形式在编译时生成 `NamedBarrierValue` 通道, 语义是"所有起点都到达才触发终点"; END 不能作为多起点之一。

编译入口 `compile` 接受 checkpointer、store、cache、`interruptBefore`/`interruptAfter`、name/description、transformers 等选项, 产物是 `CompiledStateGraph`, 它继承 `CompiledGraph`, 后者继承 `Pregel`。也就是说, 编译后的图本身就是 Pregel 引擎实例; `addNode` 传入另一个编译图或 pregel-like runnable 即构成子图。

### 2.3 条件边与 Send 路由

`addConditionalEdges` 接受 `(source, path, pathMap?)` 或单个 options 对象。运行期条件函数的返回值可映射到单个节点名、节点名数组或 `Send` 对象; pathMap 提供返回值到节点名的显式映射。同一 source 下条件名重复会抛错。条件边读取的状态只反映当前节点自身写入的视图, 这保证路由决策与超步隔离语义一致。

`Send` 携带目标节点名 `node`、任意 `args` 与可选的每任务超时策略, 在调度层表现为 PUSH 任务: 保留通道 `TASKS` (`"__pregel_tasks"`) 是一个 `Topic<Send>` 通道, 每个超步先把其中的 Send 转成任务再处理普通 PULL 任务。条件边返回 Send 数组即官方 map-reduce 模式: 路由函数动态决定并行分支数量与各自输入。prebuilt 的 `createReactAgent` 在 `version: "v2"` 下也依赖该机制, 把每个 tool call 经 Send 拆到独立 ToolNode 实例并行执行。

### 2.4 Command: 动态路由原语

`Command` 是节点返回值的动态路由原语, 字段含义如下:

| 字段   | 语义                                                                    |
| ------ | ----------------------------------------------------------------------- |
| resume | 配合 interrupt 的恢复值                                                 |
| graph  | 目标图; 缺省当前图, `Command.PARENT` 表示最近的父图 (仅子图节点可用)    |
| update | 状态更新, 等价于节点直接返回该值; 也接受 `[string, unknown][]` 元组数组 |
| goto   | 后续节点名、Send 对象, 或二者的数组                                     |

`isCommand` 守卫不用 `instanceof`: 它按字段 `lg_name === "Command"` 匹配并显式拒绝 plain object, 于是 JSON 输入解析出的 `{ lg_name: "Command", goto, update }` 形对象会被当作普通状态输入而不是控制指令, 而由另一份安装的 `@langchain/langgraph` 构造的 Command 实例仍能被识别; `COMMAND_SYMBOL` (`Symbol.for("langgraph.command")`) 在实例上保存构造参数, `toJSON` 负责序列化。工具返回 Command 时 ToolNode 会聚合处理: 指向父图的 Send 数组型 Command 合并为一个。子图节点返回 graph 指向父图的 Command 时, 运行期以 `ParentCommand` 冒泡异常承载。

## 三、通道与 reducers: 状态更新语义

### 3.1 BaseChannel 契约

所有通道继承抽象基类 `BaseChannel`, 它定义了 Pregel 与通道之间的完整契约:

```ts
export abstract class BaseChannel<ValueType, UpdateType, CheckpointType> {
  abstract fromCheckpoint(checkpoint?: CheckpointType): this;
  abstract update(values: UpdateType[]): boolean;
  abstract get(): ValueType;
  abstract checkpoint(): CheckpointType | undefined;
  consume(): boolean;
  finish(): boolean;
  isAvailable(): boolean;
}
```

语义要点:

- `update` 在每个超步结束时被 Pregel 调用, 无更新时以空序列调用; 更新顺序任意, 非法序列抛 `InvalidUpdateError`, 返回布尔表示值是否真的变化。
- `get` 在空通道上抛 `EmptyChannelError`。
- `checkpoint`/`fromCheckpoint` 是快照与恢复的一对。
- `consume` 把当前值标记为已消费, 防止被再次触发。
- `finish` 通知运行即将结束, 给 AfterFinish 系列通道最后曝光的机会。
- `isAvailable` 默认实现是 try get 捕获 `EmptyChannelError`, 子类可覆写得更高效。

### 3.2 内置通道

| 通道                           | 语义                                                                |
| ------------------------------ | ------------------------------------------------------------------- |
| LastValue                      | 保留最后一个值; 同一超步内收到多于一个写入时抛 `InvalidUpdateError` |
| LastValueAfterFinish           | LastValue 变体, 仅在本超步 finish 后可读, 读取后清空                |
| BinaryOperatorAggregate        | reducer 聚合, 并支持 Overwrite 直接覆盖语义                         |
| Topic                          | 列表缓冲, unique 去重、accumulate 跨步累积两个开关                  |
| EphemeralValue                 | 只在写入后的紧邻超步可见, 步末无更新则清空                          |
| AnyValue                       | 接受任意一个值, 不校验并发写, 步末清空                              |
| NamedBarrierValue              | 栅栏: 等所有命名写入者到齐才可用, 是 fan-in 边的底层实现            |
| NamedBarrierValueAfterFinish   | 栅栏加 finish 语义                                                  |
| DynamicBarrierValue            | 写入者集合动态确定的栅栏                                            |
| DynamicBarrierValueAfterFinish | 动态栅栏加 finish 语义                                              |
| UntrackedValueChannel          | 不参与追踪的内部通道                                                |
| DeltaChannel                   | 实验性增量通道, 支持稀疏重放与批量 reducer                          |

START 在编译时挂一个 `EphemeralValue` 输入通道, END 不挂任何通道 (`attachEdge` 对 END 直接返回), 因此这类只在一个超步有意义的值不会残留。TASKS 通道由 `Topic` 实现, fan-in 边由 `NamedBarrierValue` 实现: 若节点 N 与 M 都写通道 C, C 在两者都完成前不更新, `consume` 在栅栏满足后重置 seen 以便下轮复用。

### 3.3 并发写与 reducer

并发写入安全由 `LastValue` 直接体现: 若两个并行节点写同一个无 reducer 的状态键, 图会以 `INVALID_CONCURRENT_GRAPH_UPDATE` 失败, 这正是要求显式声明 reducer 的机制。`LastValue` 内部用长度为 1 的数组存值, 以区分"写入了 undefined"与"从未写入"。

`BinaryOperatorAggregate` 持有归约函数与可选初始值工厂, 对每个写入依次执行 `value = operator(value, incoming)`; 同时识别 Overwrite 哨兵: 首个写入若是 Overwrite 则直接取内部值初始化, 后续每步最多接受一个 Overwrite, 收到即整体替换, 两个 Overwrite 同步到达会抛错。Overwrite 哨兵常量供 `updateState` 等路径绕过 reducer 做整体覆写。

### 3.4 消息 reducer

聊天场景的默认 schema 是 `MessagesAnnotation`, 其 messages 键使用 `messagesStateReducer` 与空数组默认值。合并规则:

1. 左右两侧先规整为数组, 并把消息类对象转成 BaseMessage 实例;
2. 缺 id 的消息补 uuid4;
3. 右侧出现 id 为 `REMOVE_ALL_MESSAGES` (`"__remove_all__"`) 的 RemoveMessage 时, 丢弃该标记之前的全部消息;
4. 常规合并按 id upsert: 已存在则原位替换 (RemoveMessage 则标记删除), 不存在则追加; 删除不存在的 id 会抛错。

另有实验性的 `messagesDeltaReducer`, 作为 DeltaChannel 的批量 reducer, 一次接收整个超步的写入批次。

## 四、节点间状态与上下文传递

第三章说明了通道与 reducer 定义"状态如何被更新", 本章回答另一半问题: 节点之间究竟靠什么传递信息。传递路径分两类——一类经通道 (返回值、消息 reducer、Command/Send、输入输出投影、子图映射), 一类绕过通道直接走运行时上下文 (config/context、Store、interrupt)。最后两节讲如何压缩上下文、如何用 Store 做跨线程长期记忆。

### 4.1 节点返回值即状态更新 (reducer 合并路径)

节点函数返回的"部分状态"不是直接赋值, 而是经一条固定写回管线进入通道:

1. 节点 runnable 的输出交给 `ChannelWrite` (pregel/write.ts), 其 mapper 是 `attachNode` 生成的 `_getUpdates`/`_getRoot` (graph/state.ts)。
2. `_getUpdates` 把返回对象按 `Object.entries` 展开, 并**只保留出现在状态 schema 里的键** (`outputKeys = Object.keys(builder.channels)`); schema 之外的键被静默丢弃。返回 `Command` 时改用 `_updateAsTuples()` 展开。
3. 展开后的 `[channel, value]` 元组经 `CONFIG_KEY_SEND` 收集进 `task.writes`, 超步收尾由 `_applyWrites` (pregel/algo.ts) 按通道分组调用 `channel.update(vals)`, 各自走 reducer。

返回值的几种"空"语义需要区分:

| 返回                                | 行为                                                                                                            | 依据             |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------- |
| `undefined`/`null`/`false` 等 falsy | `_getUpdates` 开头 `if (!input) return null`, 不产生写入                                                        | graph/state.ts   |
| 空对象 `{}`                         | 展开为空数组, `ChannelWrite.doWrite` 里 `mappedResult.length > 0` 不成立, 无写入                                | pregel/write.ts  |
| 任务最终无任何写入                  | runner 补一条 `[NO_WRITES, null]` 标记                                                                          | pregel/runner.ts |
| 保留键写入                          | `NO_WRITES/PUSH/RESUME/INTERRUPT/RETURN/ERROR/ERROR_SOURCE_NODE` 在 `_applyWrites` 的 `IGNORE` 集合里, 不落通道 | pregel/algo.ts   |

因此"节点不返回"与"返回空对象"等价于不更新状态, 图仍靠触发通道推进。若某个键想绕过 reducer 整体覆盖, 用 `Overwrite` 包装 (constants.ts 的 `Overwrite` 类), `BinaryOperatorAggregate` 识别 Overwrite 哨兵直接替换 (见 3.3)。

### 4.2 消息通道的增删改: MessagesAnnotation / RemoveMessage / REMOVE_ALL_MESSAGES

`MessagesAnnotation` (graph/messages_annotation.ts) 就是 `{ messages: Annotation<BaseMessage[], Messages>({ reducer: messagesStateReducer, default: () => [] }) }` 的预置; zod 侧等价物是 `MessagesZodState`/`MessagesZodMeta`。`MessageGraph` (graph/message.ts) 则把同一 reducer 挂在 `__root__` 单通道上。

`messagesStateReducer` (graph/messages_reducer.ts) 的合并规则:

1. 左右规整为数组并 `coerceMessageLikeToMessage`; 缺 id 补 uuid4。
2. 右侧若出现 id 为 `REMOVE_ALL_MESSAGES` (`"__remove_all__"`) 的 `RemoveMessage`, 丢弃该标记之前的全部消息, 只保留其后的。
3. 否则按 id upsert: 已存在→原位替换 (是 `RemoveMessage` 则标记删除), 不存在→追加; 对不存在的 id 做 `RemoveMessage` 会抛错。

`RemoveMessage` 本身来自 `@langchain/core/messages`。删除既可在节点内返回 (程序化), 也可经 `updateState` 从外部注入 (examples/how-tos/delete-messages.ipynb)。另有实验性 `messagesDeltaReducer`: 作为 `DeltaChannel` 的批量 reducer 单趟处理整个超步写入批次并保持 batching 不变式, 对 `REMOVE_ALL_MESSAGES` 的处理与上面一致, 但不做缺 id 补 uuid 与未知 id 报错。

### 4.3 定向传递: Command、Send 与瞬态通道

除"返回部分状态"外, 节点还能用 `Command` 与 `Send` 做"状态更新 + 路由"的复合传递 (两者都定义在 constants.ts):

- `Command.update`: 等价于节点直接返回该状态; `_updateAsTuples()` 把对象转 entries、把 `[string, unknown][]` 元组数组原样保留、其它包成 `[["__root__", value]]`。
- `Command.goto`: 由 `compile()` 给 START 与每个节点挂的 `<control_branch>` (`_controlBranch`) 解析成目的地; 字符串目的地写成 `branch:to:<node>` 通道, `Send` 目的地写进保留通道 `TASKS`。指向父图 (`Command.PARENT`) 时在 `_controlBranch` 抛 `ParentCommand` 冒泡。
- `Command.resume` / `graph`: 分别用于恢复 interrupt 与跨图投递 (见第八章)。

`Send(node, args)` 是 map-reduce 的载体: `args` 可以是与主状态完全不同的任意输入。`_prepareNextTasks` 从 `TASKS` 通道 (Topic 实现) 取出每个 Send 生成 PUSH 任务, 任务 `input` 直接取 `packet.args` (pregel/algo.ts), 即"按任务输入"而非读通道; 同一节点可被并行 Send 多次, 各自写回再经 reducer 汇聚。

瞬态传递靠 `EphemeralValue` 通道 (channels/ephemeral_value.ts): 值只在写入后的紧邻超步可见, 步末无更新即清空 (内部用长度 1 数组区分"写了 undefined"与"没写")。编译时 START 挂一个 `EphemeralValue` 作输入通道, 每个普通节点的触发器是一个 `branch:to:<node>` 的 `EphemeralValue` (defer 节点则用 `LastValueAfterFinish`)。这类"只活一个超步"的控制信号因此不会残留进 checkpoint。

### 4.4 输入输出投影、私有状态与子图状态映射

图级与节点级都能对状态做投影, 编译期即决定哪些通道进入口/出口:

- 图级: `StateGraph` 构造可分别给 `state`/`input`/`output` schema (graph/types.ts 的 `StateGraphInit`)。编译时 `outputChannels` 取 output schema 的键 (单键且为 `__root__` 时退化为 ROOT), `streamChannels` 取全部通道键; `mapInput`/`mapOutputValues` (pregel/io.ts) 据此在入口/出口过滤。
- 节点级: `addNode(key, fn, { input })` 用 `_getChannelsFromSchema` 生成该节点的输入通道集 (graph/state.ts); `_procInput` (pregel/algo.ts) 只读这些通道拼成节点输入, 空通道对非触发器跳过、对触发器则中止该任务。

"私有/中间状态"在 langgraph-core 里的正规做法就是节点级 `input` 投影, 而非下划线前缀键: 中间键写进全量 state 通道, 但只暴露给声明了它的节点, 图的 input/output schema 不含它, 因此不出现在入出口 (examples/how-tos/pass_private_state.ipynb 即此模式)。**注意**: "下划线开头的键不进输入输出通道"是上层 langchain 包 `createAgent`/ReactAgent 的约定, langgraph-core 源码里没有这层语义, 本文不将其归给 core。

子图状态映射: 把编译图直接作为节点 `addNode` 进来时, `isPregelLike` 识别出它是 Pregel 并记入 `node.subgraphs`。父图按该节点的输入投影把状态对象传给子图, 子图自己的 START 节点再按**子图 input schema 的同名键**过滤 (`_getUpdates` 只保留 input 定义的键); 子图输出按子图 output schema 投影后作为节点返回值, 又经父图 reducer 合并——父子状态按"同名通道交集"对接。子图运行在独立 `checkpoint_ns` (以 `|` 分隔、`:` 接任务 id, constants.ts 的 `CHECKPOINT_NAMESPACE_SEPARATOR/END`), `getSubgraphs`/`getSubgraphsAsync` 枚举子图实例, `getState` 对指向子图命名空间的 config 委托给对应子图 (见第六、七章)。

### 4.5 运行时上下文: config、context 与 interrupt

节点函数第二个参数是 `LangGraphRunnableConfig` (pregel/runnable_types.ts), 它 `extends RunnableConfig & Partial<Runtime>`, 因此同时携带:

| 字段                                            | 含义                                                                                                                                  |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `configurable`                                  | 用户运行时键值 (thread_id、自定义 userId 等) 与 langgraph 内部 `CONFIG_KEY_*` 键的混合                                                |
| `context`                                       | 编译期 `contextSchema` 经 `_validateContext` 校验后的运行时上下文; 未显式提供 context 时校验改作用于 `configurable` (pregel/index.ts) |
| `store`                                         | 注入的长期记忆 Store (见 4.7)                                                                                                         |
| `writer` / `interrupt` / `signal` / `heartbeat` | 自定义流写入、人机中断、取消信号、空闲心跳                                                                                            |
| `executionInfo` / `serverInfo`                  | 只读的 checkpoint/任务元信息; LangGraph Server 注入的 assistant/user 信息                                                             |

传递路径: `_prepareSingleTask` 给每个任务的 config 注入 `CONFIG_KEY_SEND/READ/SCRATCHPAD`、`checkpoint_ns`、`store: extra.store ?? config.store` 等 (pregel/algo.ts)。节点内不显式接 config 时, `getConfig`/`getStore`/`getWriter`/`getCurrentTaskInput` (pregel/utils/config.ts, 经 web.ts 导出) 通过 `AsyncLocalStorageProviderSingleton.getRunnableConfig()` 取回同一份 ambient config——这也是 `interrupt()` 能拿到 config 的原因。子图在任务体内无 config 地被调用时, `Pregel.stream` 会把 ambient `configurable` 合并进调用方 config (caller 键优先), 保住嵌套命名空间与流前缀 (pregel/index.ts)。`interrupt(value)` 向"人"传值并取回 resume 值: 无恢复值时抛 `GraphInterrupt` 挂起并落检查点, 以 `Command({ resume })` 重入时经 RESUME 通道与 scratchpad 命中直接返回 (详见第八章)。

### 4.6 上下文压缩: 删除、裁剪、摘要与状态瘦身

长对话里 messages 通道会无限增长, LangGraph 层的压缩手段都是"显式重写通道":

- **删除**: 返回 `RemoveMessage` 按 id 删, 或 id 为 `REMOVE_ALL_MESSAGES` 整体清空 (见 4.2)。delete-messages 示例在收尾节点用 `messages.slice(0, -3).map(m => new RemoveMessage({ id: m.id }))` 只留最近三条。
- **裁剪**: 节点内读全量 messages, 用 `@langchain/core/messages` 的 `trimMessages` 算出保留窗口 (strategy/tokenCounter/maxTokens/startOn/endOn/includeSystem), 再把裁剪结果写回 messages 通道。这是"读全量-算裁剪-写回"的显式模式 (docs/docs/concepts/memory.md 给出该模式; `trimMessages` 属 @langchain/core, 非 langgraph-core 本体)。
- **摘要**: 用一个 summarize 节点把旧消息折叠成一条摘要并 `RemoveMessage` 掉被折叠的旧消息。add-summary-conversation-history 示例的拓扑是: 状态在 messages 之外加一个 `summary` 键 (reducer 取最新值), callModel 时若有 summary 就前置一条 SystemMessage, summarize_conversation 节点生成摘要并返回 `{ summary, messages: 旧消息的 RemoveMessage 列表 }`。
- **覆盖**: 用 `Overwrite` 直接整体替换某通道, 绕过 reducer (见 3.3/4.1)。

压缩与持久化是同一件事: 每个超步的通道值整体进 `checkpoint.channel_values` (checkpoint 包 base.ts 的 `Checkpoint`, core 的 `createCheckpoint` 逐通道 `channel.checkpoint()` 写入), 因此压掉的消息同时从检查点体积里消失。`DeltaChannel` 是例外——它默认不进 `channel_values`, 靠重放祖先写入重建 (见 6.1)。要把信息彻底移出对话状态, 则写进 Store (见 4.7), 让它脱离按线程的 checkpoint。

### 4.7 长期记忆: Store 的契约、语义检索与持久化后端

LangGraph 支持长期记忆, 载体是 `@langchain/langgraph-checkpoint` 包的 `BaseStore` (源码在 libs/checkpoint/src/store/base.ts): 跨线程、按任意命名空间组织的键值存储, 与按线程的 checkpointer 分工互补, 两者可同时注入。

**数据模型**: 每条记忆是一个 `Item`——`value` (可过滤的 JSON 对象)、`key` (命名空间内唯一)、`namespace` (字符串数组路径, 如 `["user_123","memories"]`)、`createdAt`/`updatedAt`; 检索结果 `SearchItem` 额外带 `score`。命名空间校验 (`validateNamespace`): 标签不能含 `.`、不能为空串, 根标签保留 `langgraph` 不可用。

**接口**: 具体方法都落在抽象 `batch(operations)` 上——`get(namespace,key)`、`search(namespacePrefix,{filter,limit,offset,query})`、`put(namespace,key,value,index?)`、`delete` (即 put null)、`listNamespaces({prefix,suffix,maxDepth,limit,offset})`; 另有 `start`/`stop` 生命周期。filter 支持 `$eq/$ne/$gt/$gte/$lt/$lte/$in/$nin` 运算符 (store/utils.ts 的 `compareValues`)。

**语义检索**: `IndexConfig` 指定 `dims`、`embeddings` (LangChain Embeddings) 与 `fields` (默认 `["$"]` 即整条文档)。`search` 带 `query` 时把查询 embed 后与条目向量算相似度; `InMemoryStore` 的 `score` 即余弦相似度 (utils.ts 的 `cosineSimilarity`), 结果按分数降序、按 `namespace:key` 去重。

**内存实现**: `InMemoryStore` (store/memory.ts) 用 `Map<nsJoined, Map<key, Item>>` 存数据、`Map<ns, Map<key, Map<field, number[]>>>` 存向量 (命名空间以 `:` 连接); `listNamespaces` 支持 prefix/suffix 匹配且 `*` 作通配、`maxDepth` 截断、字典序排序后分页。命名空间按段边界匹配: 检索只包含精确命名空间及其后代, 不会误中共享字符前缀的兄弟命名空间; 标签不允许含 `:` (内部路径分隔符), 公开读写与直接 batch 操作都会拒绝。别名 `MemoryStore` 等价。

**注入与读取**: `compile({ store })` 把 store 挂进 Pregel; 运行时 `PregelLoop.initialize` 用 `AsyncBatchedStore` 包一层 (把同超步的操作批量进底层 `batch`) 并 `start()` (pregel/loop.ts)。任务 config 里 `store: extra.store ?? config.store` (pregel/algo.ts), 所以节点用 `config.store` 或 `getStore()` 读取, 子图经 config 继承同一 store。functional API 的 `entrypoint({ store })` 同样透传 (func/index.ts)。

**持久化后端**:

| 后端                                            | 关键事实                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PostgresStore` (checkpoint-postgres/src/store) | 继承 BaseStore; `setup()` 跑 migration 建 `store` 表 (namespace_path/key/value JSONB/expires_at) 与 GIN 索引; 配 `index` 时启用 pgvector, 建 `store_vectors` 表与 HNSW/IVFFlat 索引 (cosine/l2/inner_product); `TTLConfig` (defaultTtl 分钟、refreshOnRead 默认 true、sweepIntervalMinutes) 配 `TTLManager` 定期清扫 |
| `MongoDBStore`                                  | 继承 BaseStore 的 MongoDB 实现                                                                                                                                                                                                                                                                                       |
| `RedisStore`                                    | **不继承 BaseStore** 的独立实现; 基于 RediSearch 建 store/store_vectors 索引, `TTLConfig` (defaultTTL/refreshOnRead), 向量距离可选 cosine/l2/ip                                                                                                                                                                      |
| SqliteSaver                                     | 无对应 Store 实现                                                                                                                                                                                                                                                                                                    |

**与 checkpointer 的分工**: checkpointer 按 `thread_id` 存"这次对话的状态", 是短期/线程内记忆; Store 按自定义 namespace 存"跨对话/跨线程的知识", 是长期记忆, 语义检索 (query→向量相似度) 是它的增量能力。三个持久化 Store 的命名空间匹配都与内存实现同样锚定在段边界上: Postgres 的 prefix/suffix 列举按段匹配 (`*` 通配只匹配一段, 标签拒绝 `:`), Redis 在全文检索召回候选后逐一校验文档存储的命名空间 (全文查询忽略大小写与词序, 首个结果不可直接信任), MongoDB 的向量检索则复核结果的命名空间归属。core/prebuilt 没有内置的 Store 专用工具封装, 常见做法是把 `config.store` 直接在节点或工具里读写 (examples/how-tos/cross-thread-persistence、semantic-search 即此模式)。

## 五、Pregel 超步执行循环

### 5.1 类结构与入口

`Pregel` 实现受 Google Pregel 论文启发的消息传递图计算模型, 关键特性为离散超步内的节点间消息传递、基于 checkpointer 的持久化、values/updates/events 流式支持、interrupt 人机协同, 以及超步内节点并行。它不建议直接实例化, 应通过 StateGraph 编译或 functional API 的 `entrypoint` 获得。

`invoke` 是 `stream` 的折叠: streamMode 缺省 values, 消费全部 chunk; 若输出里带 `__interrupt__` 键则收集 interrupt, 最终合并进返回值对象。`stream` 在进入底层流之前会合并环境配置: 当某个任务体内无 config 地调用子图时, 通过 AsyncLocalStorage 拿到的 ambient `configurable` 会被合并进去, 保证子图嵌套关系与流命名空间不丢。

### 5.2 主循环

`_runLoop` 是执行骨架, 每次迭代先推进超步边界, 再并发执行本超步任务:

```ts
while (await loop.tick({ inputKeys: this.inputChannels })) {
  if (emitLifecycleEvents) await emitLifecycleEvents(loop.lifecycleEvents);
  for (const { task } of await loop._matchCachedWrites()) {
    loop._outputWrites(task.id, task.writes, true);
  }
  await runner.tick({ timeout, retryPolicy, maxConcurrency, signal });
}
```

`loop.tick` 返回 true 表示还有下一个超步, `runner.tick` 负责并发执行本超步任务; 命中缓存的任务写入直接回放。循环结束后若 status 为 draining 抛 `GraphDrained`, 为 out_of_steps 抛 `GraphRecursionError`。默认递归上限为 25, 可通过 recursionLimit 配置调大。

### 5.3 超步推进: PregelLoop.tick

`PregelLoop` 的 `tick` 是一个状态机:

1. 若 store 未启动则启动; status 非 pending 直接抛错。
2. 输入尚未处理完时执行 `_first`, 完成输入写入与首个超步任务准备。
3. 有待触发的静态断点时, 置 status 为 interrupt_before 并抛 `GraphInterrupt`。
4. 否则若本超步所有任务都已有 writes (全部完成), 收尾该超步: 用 `_applyWrites` 更新通道, 产出 values 流输出, 按 durability 策略落检查点, 再 `_prepareNextTasks` 生成下一超步任务集; 无新任务则返回 false 结束。

DeltaChannel 在收到 Overwrite 时会被登记, 以便下次检查点从覆盖后的值做快照; `"exit"` 持久性下增量写入还要进累加器。

### 5.4 写回: _applyWrites

`_applyWrites` 是超步收尾的通道更新算法, 步骤:

1. 任务按 path 前三个元素排序, 保证确定性。
2. 遍历任务更新 `checkpoint.versions_seen[task.name]`, 记录各任务已看到的触发通道版本, 并把非保留通道加入待消费集合。
3. 消费触发通道, 用 checkpointer 的 `getNextVersion` 递增版本号。
4. 按通道分组全部写入; 对 DeltaChannel 的并发写入按任务 id 升序稳定重排, 与 checkpointer 重放顺序对齐。
5. 对每个通道调 `channel.update(vals)`; `InvalidUpdateError` 会被包一层通道名与写入值重新抛出。
6. 更新成功的通道写入新 channel_versions 并计入 updatedChannels。
7. 若发生超步推进, 未被更新的可用通道也要 `update([])` 感知新超步。
8. 若更新不再触发任何节点 (最后一个超步), 对所有通道调 `finish()`。

### 5.5 任务准备与执行

`_prepareNextTasks` 产出两类任务: PUSH (来自 TASKS 通道的 Send) 与 PULL (由通道版本变化触发的节点, 比较 channel_versions 与 versions_seen 的差集)。任务 id 由 uuid5 以 checkpoint.id 为 namespace 生成, 使断点恢复后重建的任务 id 一致。每个可执行任务是 `PregelExecutableTask`, 含 name、input、proc、writes、config、triggers、retry_policy、cache_key、id、path、subgraphs、writers 与可选每任务 timeout。

节点级 errorHandler 在重试策略耗尽后生成处理器任务: 任务 id 包含失败任务 id 以保证恢复可重现, config 里注入 `CONFIG_KEY_NODE_ERROR`, 处理器节点可读取并返回状态更新或 Command 实现错误恢复路由; 失败来源经保留写键落进 pending writes。

`PregelRunner.tick` 并发执行所有尚无 writes 的任务: 按 maxConcurrency 限流并应用 retryPolicy; 每个任务完成即提交写入。错误分类处理: `GraphInterrupt` 聚合成一个 graphBubbleUp; 其它 GraphBubbleUp 记录; 普通错误触发 abort 中止同超步其他任务并收集最终合成 `AggregateError`; 存在 `GraphInterrupt` 时抛出由上层循环捕获落检查点。

### 5.6 durability、重试与运行控制

`Durability = "exit" | "async" | "sync"` 控制检查点写入时机: 默认 `"async"`, 即下一个超步执行的同时异步保存检查点; `"sync"` 在超步间同步等待落盘; `"exit"` 只在运行结束时持久化。`checkpointDuring` 选项与 `durability` 互斥。

`RetryPolicy` 默认 initialInterval 500ms、backoffFactor 2、maxInterval 128000ms、maxAttempts 3、jitter true, 另有 retryOn 谓词与 logWarning 开关。`CachePolicy` 含 keyFunc 与 ttl (秒)。

优雅停机由 `RunControl` 承担: `requestDrain(reason)` 置位后, PregelLoop 在下一次超步边界把 status 置为 draining, 主循环抛 `GraphDrained`——此时检查点已保存, 可稍后恢复。这是 SIGTERM 场景下"保存现场再退场"的实现。

## 六、持久化体系

### 6.1 Checkpoint 数据结构

检查点是对某个超步的完整快照:

```ts
export interface Checkpoint {
  v: number;
  id: string;
  ts: string;
  channel_values: Record<string, unknown>;
  channel_versions: Record<string, ChannelVersion>;
  versions_seen: Record<string, Record<string, ChannelVersion>>;
}
```

id 用 uuid6 (时间有序), 任务级 id 用 uuid5。channel_values 存通道值, channel_versions 存各通道版本, versions_seen 记录每个节点看到过的通道版本——后两者是增量调度与时间旅行的依据。`CheckpointTuple` 是 saver 的统一返回单元, 含 config、checkpoint、metadata、parentConfig、pendingWrites。检查点元数据 `CheckpointMetadata` 的另一半语义:

| 字段         | 语义                                                                                                            |
| ------------ | --------------------------------------------------------------------------------------------------------------- |
| source       | 四值之一: input (来自 invoke/stream 输入)、loop (pregel 循环内)、update (手动状态更新)、fork (拷贝自另一检查点) |
| step         | 超步序号; 首个 input 检查点为 -1, 首个 loop 检查点为 0, 依次递增                                                |
| parents      | 命名空间到父检查点 id 的映射 (子图嵌套时各命名空间各记一条链)                                                   |
| delta 计数器 | DeltaChannel 自上次快照以来的更新超步数与总超步数, 用于触发稀疏快照                                             |

### 6.2 BaseCheckpointSaver

抽象基类 `BaseCheckpointSaver` 的要点:

- `serde` 默认 `JsonPlusSerializer`, 支持 LangChain 对象的往返序列化;
- 子类须实现 `getTuple`、`list`、`put`、`putWrites` 以及 `deleteThread`;
- `getNextVersion` 默认整数加一, 子类可覆写为字符串版本, 此时必须保持单调递增;
- `toJSON` 返回类名字符串, 防止 checkpointer 混入 configurable 后被 `JSON.stringify` 深度遍历到后端客户端 (例如 pg 连接池的计时器);
- 另有 `compareChannelVersions`、`maxChannelVersion`、`getDeltaChannelHistory` 等工具支撑增量重放。

### 6.3 官方 saver 实现

| saver                          | 关键事实                                                                                                                    |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| MemorySaver                    | 三层嵌套普通对象: thread_id 到 checkpoint_ns 到 checkpoint_id; 带原型污染防护                                               |
| SqliteSaver                    | 基于 better-sqlite3 的同步实现; 初始化时开启 WAL; checkpoints 与 writes 两张表, 主键分别覆盖线程/命名空间/检查点与任务/序号 |
| PostgresSaver                  | 基于 pg Pool; 支持 schema 选项; `setup()` 异步建表并跑 migration, 首次使用必须显式调用                                      |
| MongoDBSaver                   | MongoDB 后端实现                                                                                                            |
| RedisSaver / ShallowRedisSaver | 支持 standalone 与 cluster、可选 TTL; Shallow 版每线程单键, 新检查点写入时清理旧的, 面向不需要历史的场景                    |

MemorySaver 值得单独展开: 它是所有 quickstart 与测试夹具的默认 saver, 因此在实现里显式拒绝 `__proto__`、`constructor`、`prototype` 作为 thread_id/checkpoint_ns, 并且所有嵌套存储对象用 null prototype 创建作为纵深防御。`putWrites` 用 `WRITES_IDX_MAP` 给保留通道分配固定索引, 保证同一任务的多条写入按稳定顺序持久化。

### 6.4 Store 与缓存

`BaseStore` 定义命名空间化的键值存储, 提供 put/get/delete/search/listNamespaces, 底层通过抽象 `batch` 批处理。search 支持元数据过滤与语义检索: query 字段走向量相似度, `IndexConfig` 配置嵌入与索引, 搜索结果带相关性分数。内存实现是 `InMemoryStore`。图编译时经 `compile({ store })` 注入, 节点内用 `getStore()` 读取, 因此 Store 承担的是跨线程长期记忆, 与按线程的 checkpoint 分工不同 (Store 的完整契约、语义检索与持久化后端见 4.7)。

缓存侧另有 `BaseCache` 与内存实现, 配合节点 CachePolicy 使用; 循环内的 `AsyncBatchedCache` 把同超步的查询批量化。

## 七、线程、状态快照与时间旅行

会话概念是 thread: 运行配置里的 `thread_id` 标识线程, `checkpoint_ns` 标识 (子图) 命名空间, `checkpoint_id` 定位某个超步检查点。`StateSnapshot` 是对外状态视图, 含 values、next (下一批待执行节点)、config、metadata、tasks。

三个核心方法都在 `Pregel` 上:

- `getState(config, options?)`: 解析 checkpointer; `checkpointer: false` 绝不使用 config 借来的 checkpointer, config 里的 checkpointer 优先于图自身的, `checkpointer: true` 作用在根图直接抛错。config 指向已声明子图的命名空间时委托给子图, 并把解析出的 saver 借给它; 命名空间匹配不到已声明子图时回退为按完整 checkpoint_ns 查 checkpointer。未指定 checkpoint_id 时, 快照会应用未决写入。
- `getStateHistory(config, options?)`: 异步迭代器, 对 checkpointer.list 的每个 CheckpointTuple 构造快照; options 支持 limit、before、filter。
- `updateState(inputConfig, values, asNode?)`: 委托给 `bulkUpdateState`, 后者接受多个超步、每超步多个更新。asNode 把更新归属到指定节点, 使后续调度如同该节点刚产生这些写入; 用途包括 human-in-the-loop、断点期间改状态、注入外部输入。无法归属到任何节点的更新抛 `InvalidUpdateError`。子图更新指向未声明子图命名空间时不再回退到本图, 而是直接抛 "Subgraph not found"。

快照构造由 `_prepareStateSnapshot` 完成: 它接受调用方解析好的 saver 与是否递归包含子图任务状态的标志。从检查点重建全部通道时, DeltaChannel 经 checkpointer 从祖先写入重建; 已有版本号却未传 saver 或 config 时直接抛错, 不静默水合成空值。

时间旅行即: 用 `getStateHistory` 取回某个历史 config (含 checkpoint_id), 以该 config 重新 invoke/stream 即从历史点分叉重放。恢复中断运行则以 `Command({ resume })` 作为输入。

## 八、Human-in-the-loop: interrupt 与 resume

### 8.1 interrupt() 函数

`interrupt(value, options?)` 在节点内同步返回恢复值, 机制如下:

1. 通过 AsyncLocalStorage 从 `@langchain/core` 取当前运行 config, 图外调用直接抛错;
2. 无 checkpointer 时抛 `GraphValueError` (错误码 MISSING_CHECKPOINTER)——interrupt 强依赖持久化;
3. 每个任务的 scratchpad 维护 interruptCounter, 支持一个节点内多个 interrupt 依序对应;
4. 若 scratchpad.resume 里已有本次重放可用的恢复值, 直接解析返回, 并把已消费的 resume 前缀写回 RESUME 通道持久化。注释强调只持久化到被消费的位置: 后面属于更晚 interrupt 的值不能提前固化, 否则校验失败后的重试无法覆盖;
5. 否则构造挂起对象并抛出 `GraphInterrupt`。挂起对象的 id 由检查点命名空间的哈希派生, 使子图内的 interrupt 有稳定身份; `options.responseSchema` 接受 zod schema, 经 `toJsonSchema` 转成 JSON Schema 附在 interrupt 上, 恢复值会用 `interopParse` 校验, 不合法则抛 ZodError。

### 8.2 异常族与控制流

控制流异常继承自 `GraphBubbleUp`:

| 类型           | 用途                                                             |
| -------------- | ---------------------------------------------------------------- |
| GraphInterrupt | 携带 interrupts 数组向上冒泡, 触发落检查点                       |
| NodeInterrupt  | 节点内直接 `new NodeInterrupt(message)` 的便捷形态               |
| ParentCommand  | 子图节点返回指向父图的 Command 时的载体                          |
| GraphDrained   | RunControl.requestDrain 引发的协作式排空, 检查点已保存可稍后恢复 |

ToolNode 默认 `handleToolErrors = true` 会把工具异常转成 error ToolMessage 喂回模型, 但对 `GraphInterrupt` 例外: interrupt 是人机断点而非可恢复错误, 即使开了错误处理也要重新抛出。

### 8.3 恢复与静态断点

恢复路径: 以 `new Command({ resume: value })` 作为图输入再次 invoke/stream, 值进入 RESUME 通道, 重放时经 scratchpad.resume 命中直接返回; 多 interrupt 场景按顺序逐个恢复。`isInterrupted` 守卫判断输出对象是否含 `__interrupt__` 键; invoke 的 values 模式会把 interrupts 合并进最终返回值, 因此即使不消费流也能拿到中断信息。子图借用父图的恢复值, 由 `_first` 写进 RESUME 通道, 且这次写入位于时间旅行过滤之后——过滤会丢弃检查点里陈旧的 RESUME 写入, 但不能连父图刚递进来的恢复值一起丢掉。

静态断点在编译期声明: `compile({ interruptBefore, interruptAfter })`, 支持节点名数组或 `All` (`"*"`); 运行期 PregelLoop 在对应节点执行前把 status 置为 interrupt_before 并抛 `GraphInterrupt`。prebuilt 还定义了面向 agent 收件箱的结构化中断协议: `HumanInterruptConfig` (allow_ignore/allow_respond/allow_edit/allow_accept 四个布尔位)、`ActionRequest`、`HumanInterrupt` 与 `HumanResponse`。

## 九、流式输出

### 9.1 八种流模式

`StreamMode` 是八种模式的联合:

```ts
export type StreamMode =
  | "values"
  | "updates"
  | "debug"
  | "messages"
  | "checkpoints"
  | "tasks"
  | "custom"
  | "tools";
```

| 模式                | 载荷                                                    |
| ------------------- | ------------------------------------------------------- |
| values              | 每个超步后的完整状态                                    |
| updates             | 每个节点写入的增量                                      |
| messages            | LLM token 级消息流, 与 `@langchain/core` 的消息回调对接 |
| checkpoints / tasks | 检查点元信息与任务生命周期事件                          |
| custom              | 节点内 `writer()` 推送的自定义负载                      |
| debug               | 详细调试事件                                            |
| tools               | 工具调用生命周期                                        |

stream 调用可传 StreamMode 数组同时订阅多路, 返回类型由 `StreamOutputMap` 按模式映射。默认值: 编译图构造时 streamMode 为 `"values"`, invoke 固定 values, functional API 的 entrypoint 则固定 `"updates"`。

### 9.2 流管道内部

流的基本单元是 `[string[], StreamMode, unknown]` 三元组, 即命名空间、模式、载荷; 子图流通过命名空间前缀区分, `subgraphs: true` 时携带嵌套命名空间。PregelLoop 持有 stream 发射器, `_outputWrites` 把任务写入转成 updates/values 输出; values 模式先持久化检查点再发射。

自定义流用模块级 `writer(chunk)` 函数: 它从 AsyncLocalStorage 拿 config 再调用其中的 writer; 配套 `getWriter`、`getStore`、`getConfig`、`getCurrentTaskInput` 都从同一处导出。

### 9.3 事件流与 SSE

`stream` 支持 `encoding: "text/event-stream"`, 经 `toEventStream` 把 chunk 转成 SSE 字节流。另有 v3 事件流入口: 以全开的流事件模式加 subgraphs 取源流, 经 `createGraphRunStream` 与用户/编译期 transformers 合成 `GraphRunStream`, text/event-stream 编码时再经 `protocolEventsToEventStream` 输出协议化事件——这是 langgraph-api 服务器向前端推流的底座。

AbortController 语义: stream 内部建独立 abortController 并与调用方 signal 合并, 返回带 abort signal 的 IterableReadableStream; sdk 侧的 `IterableReadableStream` 扩展 ReadableStream 提供 async iterator 语义, 并在 return/throw 时正确释放 reader 锁。

## 十、Functional API

`libs/langgraph-core/src/func/` 提供与 StateGraph 等价的函数式入口, 产物同样是 Pregel 实例。

`task` 把纯函数包装为可检查点化的子任务, 选项含 name、retry、cachePolicy、timeout; 生成器函数被禁止 (抛错提示流式响应改用 config.write)。调用时走 `call`: 从 AsyncLocalStorage 取注入的调度函数, 把 (func, name, args, 策略与 callbacks) 交给 Pregel 作为 PUSH 任务执行——这解释了为什么 task 必须在图运行期内调用。

`entrypoint` 把整个工作流定义为单节点图: 内部构造 PregelNode (triggers 与 channels 均为 START), 三个固定通道分别挂 START、END、PREVIOUS, streamMode 固定 updates。返回值处理有两个专用 Runnable 分别解包 `entrypoint.final({ value, save })`——final 允许返回值与持久化状态分离。跨次运行读取上次保存的状态用 `getPreviousState`, 其值来自 PREVIOUS 通道。

## 十一、Prebuilt 与多 agent 套件

### 11.1 createReactAgent 与 ToolNode

prebuilt 目录导出 createAgentExecutor、createFunctionCallingExecutor、createReactAgent、createReactAgentAnnotation、ToolExecutor、ToolNode、toolsCondition、HumanInterrupt 系列类型与 withAgentName。其中 createReactAgent 标注为 deprecated, 指向 langchain 包的 `createAgent`。其参数面覆盖 llm (可为接收 state/runtime 返回模型的函数, 实现动态模型选择)、tools (ToolNode 实例或工具数组)、prompt (字符串/SystemMessage/函数/Runnable)、stateSchema 与 contextSchema、checkpointer、interruptBefore/After、store、responseFormat (zod/JSON Schema/含 prompt 的对象, 结束后额外一次结构化输出调用写入 structuredResponse)、preModelHook/postModelHook (调模型前后的护栏与人工审核节点)、version 与 includeAgentName 等。

默认状态由 `createReactAgentAnnotation` 定义: messages 用 messagesStateReducer 加空数组默认值, 外加 structuredResponse 键。图骨架是 agent 节点与 tools 节点之间用条件边循环, 直到无 tool_calls; 静态模型管线会被缓存, prompt Runnable 与模型 pipe 组合, returnDirect 的工具会进入集合参与路由判断。

`ToolNode` 继承 RunnableCallable: 输入接受 BaseMessage 数组、含 messages 的状态对象, 或 Send 单工具调用输入; 从最后一条 AIMessage 提取 tool_calls, 跳过已有对应 ToolMessage 的 id, 并行执行; 工具返回 Command 或 ToolMessage 直通, 其它返回值包成 success ToolMessage。`toolsCondition` 是标准路由谓词: 最后一条消息有 tool_calls 返回字符串 "tools", 否则返回 END。

### 11.2 多 agent 包

- `@langchain/langgraph-supervisor`: `createSupervisor` 与 OutputMode, 基于 createReactAgent 组合子 agent;
- `@langchain/langgraph-swarm`: `createSwarm`、`addActiveAgentRouter`、SwarmState, 带活跃 agent 记忆的群体协作, handoff 逻辑复用 ToolNode 与 Command;
- `@langchain/langgraph-cua`: computer use agent, 节点含 call-model 与 take-computer-action。

## 十二、SDK、前端集成与远程图

### 12.1 图内省与 RemoteGraph

编译后的图支持内省: `getGraph(config)` 返回可绘制的图结构, `getGraphAsync` 是其异步版本且为推荐用法; `getSubgraphs`/`getSubgraphsAsync` 枚举子图实例, 支撑 getState 的子图委托。

`RemoteGraph` 把远端 LangGraph Platform 上的图包装成本地 Pregel 接口: invoke/stream/streamEvents 走 HTTP, getState/getStateHistory/updateState 分别映射到 threads 的 state/history/state 端点; 远端检查点键从 configurable 提取 thread_id/checkpoint_ns/checkpoint_id/checkpoint_map 四件套。它与本地图可以互相嵌套。

### 12.2 SDK

`@langchain/langgraph-sdk` 的 `Client` 按资源域拆分 assistants、threads、runs、crons、store 等子客户端; `threads.updateState` 以 POST 提交 values/checkpoint/as_node。流式客户端核心是 `StreamController`: 负责 SSE 解析、interrupt 收集与断线/取消后的状态对账。协议 SSE 传输适配器的重试语义值得注意: 4xx 响应 (排除 408 与 429) 不进入重连循环, 立即以该错误终结事件流; 重连计数在每次成功连接后归零。

### 12.3 前端框架集成

`@langchain/react` 的核心是 `useStream` hook, 配套 context、selectors、suspense-stream 与媒体辅助 hook; `@langchain/angular`、`@langchain/svelte`、`@langchain/vue` 结构对等。`StreamOrchestrator` 统一 values/interrupts/error/loading 状态供 UI 消费, 并处理无头工具中断的过滤与识别。前端集成的价值在于把"图在每个超步产生的状态与中断"直接映射成 UI 可订阅的响应式状态, 而不需要调用方手工拼装流。

### 12.4 平台栈

`@langchain/langgraph-api` 是 LangGraph Platform API 的进程内实现, 技术栈为 hono 加 node 适配, src 下按资源分 runs、threads、assistants、store 路由, storage 层定义运行期存储抽象, experimental/embed 提供进程内嵌入调用。`@langchain/langgraph-cli` 提供 bin `langgraphjs`, 基于 commander, 命令集合覆盖 dev、build、up、dockerfile、new 以及面向部署平台的 deploy/list/revisions/logs/delete (标注 Beta) 与 sysinfo。

## 十三、适用场景与边界

适合 LangGraph 的场景:

- 需要多轮、可恢复的对话与长任务: checkpointer 让状态按 thread 落盘, 进程重启后可继续;
- 需要人在关键节点介入: interrupt/resume 与静态断点把"停下来问人"变成图的一等公民;
- 需要把复杂流程拆成可组合、可并行、可回放的步骤: 超步模型天然表达 fan-out/fan-in 与 map-reduce;
- 需要跨线程长期记忆: Store 提供命名空间化的键值检索, 与按线程的 checkpoint 互补。

需要谨慎评估的边界:

- 单次无状态调用: 引入 checkpointer 与图模型的收益有限;
- 对延迟极敏感且无需持久化的流程: durability 设为 async 已尽量降低落盘阻塞, 但状态序列化仍有成本;
- DeltaChannel 与稀疏重放相关 API 当前标注为实验/Beta, 行为可能变化;
- prebuilt 的 createReactAgent 已指向 langchain 包的 createAgent, 新项目应优先使用后者。

设计上的核心取舍是: 把"状态"提升为图的显式组成部分 (通道与 reducer), 用超步边界换取确定性与可恢复性。代价是必须显式声明 reducer、理解超步隔离与子图命名空间; 收益是任何一次运行都能被检查点化、列举、回放与人工干预。对 [LangChain.js](langchain) 的组件生态而言, LangGraph 是编排层, 而它自身又可以脱离 LangChain 的模型层单独使用。
