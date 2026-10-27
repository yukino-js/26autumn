---
title: "LangGraph.js: Pregel 超步引擎、通道状态模型与检查点持久化"
description: "从 monorepo 包分层讲到 StateGraph 到 Pregel 的超步执行循环、channels 与 reducers 的状态更新语义、节点间状态与上下文传递、上下文压缩与 Store 长期记忆、checkpointer 持久化与恢复、interrupt/resume 人机协同、流式输出模式与 SDK/前端集成"
local_path: "$HOME/Downloads/langgraphjs"
---

LangGraph.js 是一个用 TypeScript 编写的低层 agent 编排 runtime。仓库对自身方向的表述很直接: LangGraph 是 runtime, 它负责四件事——图执行 (Pregel 超步循环)、检查点持久化 (checkpointer)、流式输出 (八种 stream mode 与协议事件流)、以及 interrupt/resume 人机协同; 而"如何搭一个好用的 agent"属于上一层的关注点。本文以仓库源码为唯一事实来源, 沿着一条主线展开: 一张 StateGraph 如何被编译成 Pregel 引擎, 状态如何以 channel + reducer 的模型在超步之间流转与落盘, 运行如何被暂停、恢复与回放, 以及这一切如何通过 SDK 暴露给前端。

适合已经写过基本模型调用、需要在多轮对话或长任务中引入可恢复状态与人工断点的开发者; 也适合想理解 Pregel/BSP 式图执行模型内部机制的读者。与 [langchain](./langchain) 的关系可以一句话概括: LangChain 提供模型、工具与可组合组件, LangGraph 提供把这些组件组织成有状态、可暂停、可回放图的执行运行时。

## 一、Monorepo 包分层与职责

### 1.1 工程基座

仓库使用 pnpm workspaces + turbo 组织, `package.json` 声明 node 引擎 `^22.11 || ^24 || >=26`, packageManager 为 pnpm 10.27.0。核心库 `@langchain/langgraph` (目录 `libs/langgraph-core`) 把 `@langchain/core` (`^1.1.48`) 与 zod (`^3.25.32 || ^4.2.0`) 声明为 peerDependency, 使版本冲突暴露在安装期而非运行期; 直接依赖包括 workspace 内的 checkpoint 与 sdk 包、`@langchain/protocol` (协议事件类型) 与 `@standard-schema/spec` (Standard Schema 互操作)。子路径导出划分为: `"."` (Node 全量入口)、`"./web"` (浏览器安全入口, 不含依赖 `node:async_hooks` 的部分)、`"./channels"`、`"./pregel"`、`"./prebuilt"`、`"./remote"`、`"./stream"`、`"./zod"` 与 `"./zod/schema"`。另有 `libs/langgraph` 提供无 scope 的 `langgraph` 包名, 源码只有一行 re-export。

### 1.2 核心执行与状态基座

| 包                                | 职责                                                                                                                         |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `@langchain/langgraph`            | StateGraph/Annotation、Pregel 引擎、channels、interrupt、functional API、prebuilt、stream 协议层                             |
| `langgraph`                       | 规范名包装, 仅 re-export 上一行                                                                                              |
| `@langchain/langgraph-checkpoint` | `BaseCheckpointSaver`、`MemorySaver`、Checkpoint 类型、JsonPlusSerializer、`BaseStore`、`InMemoryStore`、`AsyncBatchedStore` |

### 1.3 持久化后端

| 包                                           | 关键事实                                                                                                                          |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `@langchain/langgraph-checkpoint-sqlite`     | 静态工厂 `fromConnString` 返回实例; 连接启用 WAL; 建 `checkpoints` 等表                                                           |
| `@langchain/langgraph-checkpoint-postgres`   | 首次使用须显式 `setup()` 跑建表 migration; 同包提供 `PostgresStore` (pgvector 向量检索)                                           |
| `@langchain/langgraph-checkpoint-redis`      | `RedisSaver` 支持 TTL (以分钟配置, 内部换算为秒) 与 `refreshOnRead`; 另有每线程只存最新状态的 `ShallowRedisSaver` 与 `RedisStore` |
| `@langchain/langgraph-checkpoint-mongodb`    | MongoDB 后端 saver 与 store                                                                                                       |
| `@langchain/langgraph-checkpoint-validation` | 可复用的 saver 一致性测试夹具, 供第三方后端自证兼容                                                                               |

所有 saver 实现同一个 `BaseCheckpointSaver` 抽象, 换后端不改图定义, 只换 compile 时传入的实例。

### 1.4 SDK、前端集成与平台

| 包                                             | 职责                                                                                                                                                          |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@langchain/langgraph-sdk`                     | LangGraph Platform 客户端: `Client` 及其子客户端、`ThreadStream`/`StreamController`、SSE 与 WebSocket 双传输、`StreamOrchestrator` (`src/ui/orchestrator.ts`) |
| `@langchain/react`                             | React 集成: `useStream` hook、context provider、selectors、suspense-stream、媒体处理 hooks                                                                    |
| `@langchain/langgraph-api`                     | 基于 hono 的 LangGraph Protocol 服务端实现 (`src/protocol/service.mts`)                                                                                       |
| `@langchain/langgraph-cli`                     | CLI, bin 名 `langgraphjs`                                                                                                                                     |
| `@langchain/langgraph-ui` / `create-langgraph` | 平台配套 UI 与项目脚手架                                                                                                                                      |

### 1.5 多 agent 套件

`@langchain/langgraph-supervisor` (supervisor 模式)、`@langchain/langgraph-swarm` (带活跃 agent 记忆的群体协作)、`@langchain/langgraph-cua` (computer use agent) 都构建在核心库之上, 复用同一套超步与检查点机制。按仓库当前的方向表述, 这些 agent 级包处于维护状态, runtime 本身才是持续演进的层。

## 二、从 StateGraph 到 Pregel: 编译管线

### 2.1 状态 schema 的两种写法

状态 schema 有两种等价表达。第一种是 `Annotation`: `StateDefinition` 本质是"键 → 通道规格"的映射, `Annotation.Root(spec)` 返回 `AnnotationRoot` (以 `lc_graph_name` 提供 `isInstance` 跨包识别)。每个键不带 `reducer` 时创建 `LastValue` 通道, 只保留一步内的唯一写入; 带 `reducer` 时创建 `BinaryOperatorAggregate` 通道, `default` 提供初始值工厂。

第二种是 zod / Standard Schema: `StateGraph` 直接接受 zod object schema, reducer 与 default 通过 meta 声明。核心库为此提供 `"./zod"` 子路径 (给 zod schema 挂 `.langgraph.reducer()` 等方法) 与预置的 messages 状态:

```ts
// graph/messages_annotation.ts (节选)
export const MessagesAnnotation = Annotation.Root({
  messages: Annotation<BaseMessage[], Messages>({
    reducer: messagesStateReducer,
    default: () => [],
  }),
});

export const MessagesZodMeta: SchemaMeta<BaseMessage[], Messages> = {
  reducer: { fn: messagesStateReducer },
  jsonSchemaExtra: { langgraph_type: "messages" },
  default: () => [],
};

export const MessagesZodState = z.object({
  messages: withLangGraph(z.custom<BaseMessage[]>(), MessagesZodMeta),
});
```

`new StateGraph(MessagesAnnotation)` 与 `new StateGraph(MessagesZodState)` 语义相同, 选择只取决于项目用 Annotation 还是 zod 描述状态。

### 2.2 addNode: 节点与执行策略

`addNode(name, fn | runnable, options?)` 注册节点。节点名不得使用保留名 `__start__`/`__end__`, 不得包含命名空间分隔符 `|` 与 `:`。`options` (`NodeSpec`) 可携带每节点执行策略 (`NodePolicyOptions`):

- `retryPolicy`: 节点级重试 (见 5.6);
- `cachePolicy`: 节点级写缓存 (见 5.6);
- `timeout`: 毫秒数或 `TimeoutPolicy`;
- `errorHandler`: 节点级错误处理器。传入后 StateGraph 自动注册一个名为 `` `__error_handler__${nodeName}` `` 的节点, 通过 `CONFIG_KEY_NODE_ERROR` 把失败信息路由过去; 它只在失败节点的 `RetryPolicy` 耗尽后运行, 处理器签名为 `(state, error: NodeError, config?)`, 可返回部分状态更新或 `Command` (借 `goto` 重新路由)。

`setNodeDefaults({ retryPolicy?, cachePolicy?, timeout?, errorHandler? })` 为所有常规节点设置默认策略; 默认 `errorHandler` 注册为 `__default_error_handler__` 节点。默认值不作用于自动生成的 error-handler 节点, 防止递归兜底。

### 2.3 addEdge 与条件边

`addEdge` 支持三种形态:

- 单对单: `addEdge("a", "b")`, a 完成后触发 b;
- 扇入 (fan-in): `addEdge(["a", "b"], "c")`, 编译为 `NamedBarrierValue` 通道, 等全部来源完成才触发 c; 带 `defer` 的节点用 `AfterFinish` 变体。`END` 不能作为边的起点, 数组形态的目标也不能是 `END`;
- 条件边: `addConditionalEdges(source, router, pathMap?)`, router 返回字符串 (节点名或 `END`)、`Send` 实例或两者组成的数组。每条条件边在编译期生成一个 `branch:to:<key>` 通道承接路由结果: 普通节点用 `EphemeralValue(false)`, `defer` 节点用 `LastValueAfterFinish`。

`Send(node, arg)` 是动态路由原语: 它绕过共享状态, 把 `arg` 作为目标节点的私有输入, 一次可以发出任意多个, 实现 map-reduce 式的动态并行。所有 Send 写入内部通道 `__pregel_tasks` (一个 `accumulate: false` 的 `Topic`), 由下一个超步消费成 PUSH 任务。

### 2.4 节点返回值语义

节点函数收到 `(state, config)`, 返回值经 `_getUpdates`/`_getRoot` 归一化: 返回假值 (undefined/null) 视为"无更新"; 返回对象时按键过滤到 schema 声明的通道, 出现未知键或非法形态抛 `InvalidUpdateError`; 返回 `Command` 则同时携带状态更新与路由; 返回 `Send` 数组即动态分发。节点内部也可以调用 `writer()` 拿到 custom 流写入器 (见第九章)。

### 2.5 compile: 编译为 Pregel

`compile(options?)` 接受 `{ checkpointer?, store?, cache?, interruptBefore?, interruptAfter?, name?, description?, transformers? }`, 返回 `CompiledStateGraph`。类继承链是 `CompiledStateGraph` → `CompiledGraph` → `Pregel`: 编译过程把每个状态键展开成具体 channel 实例、每个节点包装成 `PregelNode`、每条边翻译成触发通道与分支通道, 产物就是一台可以直接 `invoke`/`stream` 的 Pregel 机器。`transformers` 用于挂载自定义流转换器 (见 9.4)。编译后的图还暴露 `getState`/`getStateHistory`/`updateState`/`bulkUpdateState`、`getGraphAsync` (可绘制图结构) 与 `getSubgraphsAsync` (枚举子图)。

### 2.6 Command 与 Overwrite

`Command` 是"更新 + 路由"的复合指令: `new Command({ update?, goto?, graph? })`。`goto` 可以是节点名、`Send` 或数组; `graph: Command.PARENT` (值为 `"__parent__"`) 表示路由到父图。`isCommand` 通过内部 `lg_name` 标记识别实例, 普通对象冒充会被拒绝; 实例带 `COMMAND_SYMBOL` (`Symbol.for("langgraph.command")`)。从工具或子图返回的 `Command` 会被 `_updateAsTuples` 拆解为通道写入。`Overwrite` 是配套哨兵: 写入 `new Overwrite(value)` 时, `BinaryOperatorAggregate` 与 DeltaChannel 跳过 reducer 直接以该值整体替换通道内容。

## 三、通道系统与 reducer 语义

### 3.1 BaseChannel 契约

`BaseChannel` (`src/channels/base.ts`) 定义了状态单元格的完整生命周期: `fromCheckpoint` (从检查点值重建)、`update(values)` (消费一步内的全部写入, 返回是否变化)、`get`/`checkpoint` (读当前值 / 产出可序列化快照, 空通道抛 `EmptyChannelError`)、`consume`/`finish` (任务消费与超步收尾钩子)、`isAvailable`、`equals`。每个通道类必须提供 `lc_graph_name` 供序列化识别, 实例带 `lg_is_channel` 标记。`createCheckpoint` 产出的检查点信封固定 `v: 4`, id 用单调递增的 uuid6。

### 3.2 内置通道

| 通道                                                     | 语义                                                                                              |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `LastValue`                                              | 保存最近一次写入; 同一超步收到多个写入抛 `InvalidUpdateError` (`INVALID_CONCURRENT_GRAPH_UPDATE`) |
| `LastValueAfterFinish`                                   | 同上, 但只接受来源任务全部 finish 之后的值, 服务于 `defer` 节点                                   |
| `BinaryOperatorAggregate`                                | 用二元 reducer 聚合所有写入; `Overwrite` 哨兵可整体替换                                           |
| `Topic`                                                  | 追加式写入; `accumulate: true` 时跨超步保留历史, false 时每步清空                                 |
| `EphemeralValue`                                         | 值只在写入后的下一个超步可见, 之后自动消失, 适合一次性信号                                        |
| `AnyValue`                                               | 一步内允许多个写入不报错, 持续覆盖保留最后一个, 假定并发写入等价                                  |
| `NamedBarrierValue` / `NamedBarrierValueAfterFinish`     | 等待指定节点集合的写入 (或完成) 才变为可用, 扇入边的底层                                          |
| `DynamicBarrierValue` / `DynamicBarrierValueAfterFinish` | 同上, 但期望的来源集合在运行期动态确定                                                            |
| `UntrackedValueChannel`                                  | 内部使用的 LastValue 变体: 值不写入检查点, 恢复时重置为初始值, 适合连接句柄一类瞬态状态           |

### 3.3 messagesStateReducer

`messagesStateReducer` (`src/graph/messages_reducer.ts`) 是消息状态的标准 reducer, 也是 `MessagesAnnotation` 的默认聚合函数。语义要点:

- 输入既可以是完整消息, 也可以是流式 chunk (`AIMessageChunk` 等会被折算成对应消息), 单个对象或数组皆可;
- 缺 id 的消息自动补 uuid4, 保证按 id upsert 的确定性;
- 已存在同 id 消息时做替换 (支持消息在后续步骤被改写), 否则追加;
- `RemoveMessage` 按 id 删除; 删除不存在的 id 会抛错; 特殊常量 `REMOVE_ALL_MESSAGES` (值 `"__remove_all__"`) 一次清空整个历史。

配套的实验性 `messagesDeltaReducer` 面向 DeltaChannel: 只存消息增量, 配合 `ensureDeltaMessageIds` 保证 id 稳定。

### 3.4 DeltaChannel (Beta)

`DeltaChannel` (`src/channels/delta.ts`, 标注 Beta) 针对"状态大、每步改动小"的场景: 检查点平时只落增量写入, 每 `snapshotFrequency` 个超步 (构造参数, 默认 100, 必须为正整数) 落一次完整快照; 恢复时从最近快照出发回放增量 (`channelsFromCheckpoint` 中的 ancestor-walk)。距上次快照超过 `DELTA_MAX_SUPERSTEPS_SINCE_SNAPSHOT` (默认 5000, 可用环境变量 `LANGGRAPH_DELTA_MAX_SUPERSTEPS_SINCE_SNAPSHOT` 覆盖) 个超步会强制补一次快照, 防止回放链过长。`initialValueFactory` 默认返回空数组。

## 四、节点间的状态与上下文传递

### 4.1 节点输入与 Runtime

节点第一个参数是通道投影出的状态对象; 第二个参数是 `LangGraphRunnableConfig`, 类型为 `RunnableConfig & Partial<Runtime>`。`Runtime` (`src/pregel/runnable_types.ts`) 汇总了运行期可取的一切:

| 字段                           | 含义                                                             |
| ------------------------------ | ---------------------------------------------------------------- |
| `configurable`                 | thread_id、checkpoint 定位等配置键                               |
| `context`                      | compile 时声明 schema 的只读运行上下文 (`_validateContext` 校验) |
| `store`                        | 跨线程长期记忆 Store                                             |
| `writer`                       | custom 流写入器                                                  |
| `interrupt`                    | 当前待处理的 interrupt 载荷                                      |
| `signal`                       | 中止信号                                                         |
| `heartbeat`                    | 长任务心跳, 用于刷新 `idleTimeout`                               |
| `executionInfo` / `serverInfo` | 执行与部署环境信息                                               |
| `control`                      | `RunControl`, 可请求排空 (drain)                                 |

对应的免传参访问器: `getConfig()`、`getStore()`、`getWriter()`、`getCurrentTaskInput()`, 均从 AsyncLocalStorage 环境读取。

### 4.2 写回管线与空值语义

节点返回值不直接改状态, 而是走"写入 → 通道 → reducer"管线: 每个返回键变成一条通道写入, 超步结束统一 apply。空值语义需要精确记住: 返回 `undefined`/`null` 是合法的"本节点无更新"; 返回 `{}` 同样不产生写入; 想清空某个键必须显式写入 reducer 能理解的"删除"值 (如 `REMOVE_ALL_MESSAGES`), 或用 `Overwrite` 替换聚合通道。

### 4.3 三种传递方式

- 跨超步共享状态: 普通通道 + reducer, 所有后续节点可见;
- 步内一次性信号: `EphemeralValue`, 只活一个超步;
- 任务私有输入: `Send(node, arg)`, 目标节点收到的是 `arg` 而不是全局状态, 天然隔离并行分支。

`Command` 把"更新状态"与"决定下一步去哪"合并成一次返回, 是从工具函数内部改变图走向的唯一途径。

### 4.4 子图与命名空间

编译后的图本身就是 Pregel 实例, 可以作为另一个 `StateGraph` 的节点直接嵌入。子图与父图共享同名状态键时值会双向同步; 隔离则由检查点命名空间保证: 子图任务的 `checkpoint_ns` 按 `${parentNamespace}|${nodeName}` 组合, 单个任务再追加 `:${taskId}` (分隔符常量 `CHECKPOINT_NAMESPACE_SEPARATOR = "|"` 与 `CHECKPOINT_NAMESPACE_END = ":"`)。`getSubgraphsAsync` 可枚举声明的子图, 流式输出中命名空间以字符串数组前缀出现 (见第九章)。

### 4.5 上下文压缩

长对话的上下文控制不是引擎内置开关, 而是"reducer + 显式写回"的组合模式: 在专门的节点里对 `messages` 做裁剪或摘要, 返回 `RemoveMessage`/`REMOVE_ALL_MESSAGES` 加摘要消息的写入, 由 messages reducer 在下一超步生效。仓库 `examples/how-tos/` 下的 `delete-messages.ipynb` 与 `add-summary-conversation-history.ipynb` 就是这两种模式的完整示例。

### 4.6 Store: 跨线程长期记忆

检查点解决"单线程内可恢复", Store 解决"跨线程共享"。`BaseStore` (`libs/checkpoint/src/store/base.ts`) 的 API 是命名空间化的 KV + 向量检索: `get(namespace, key)`、`put(namespace, key, value, index?)`、`delete`、`search(namespace, { query?, filter?, limit? })`、`listNamespaces`, 全部收敛到一个抽象的 `batch(ops)` 上。约束与能力:

- 命名空间是 `string[]`, `validateNamespace` 拒绝含 `.`、`:`、NUL 或空段的命名空间, 根命名空间 `langgraph` 为保留前缀;
- `filter` 支持 `$eq`/`$ne`/`$gt`/`$gte`/`$lt`/`$lte`/`$in`/`$nin` 算子;
- 语义检索靠 `IndexConfig`: `{ dims, embeddings, fields }`, `fields` 默认 `["$"]` (整个值); 命中结果 `SearchItem` 带 `score` (余弦相似度, `cosineSimilarity`);
- `InMemoryStore` 用 Map 实现, 命名空间以 `":"` 连接为键; `AsyncBatchedStore` 给任意 store 包一层自动批处理。

生产后端: `PostgresStore` 基于 pgvector, 向量索引支持 HNSW (m=16, ef_construction=200) 与 IVFFlat (lists=100), 算子 `vector_cosine_ops`, 并支持 TTL 配置; Redis 与 MongoDB 亦有对应 store。图内通过 compile 时传入 `store`, 节点里从 `config.store` 或 `getStore()` 取用。

## 五、Pregel 超步执行循环

### 5.1 一次超步

Pregel 采用 BSP (bulk synchronous parallel) 模型: 运行被切成一个个超步 (superstep)。每个超步内, 被触发的任务并行执行, 它们的写入先挂在任务上; 超步边界统一 apply 写入、推进通道版本、落检查点, 再根据新版本决定下一超步的任务集合。`recursionLimit` (默认 `RECURSION_LIMIT_DEFAULT = 25`) 限制超步总数, 超出抛 `GraphRecursionError`。

### 5.2 _runLoop 主体

`Pregel._runLoop` (`src/pregel/index.ts`) 是引擎心脏, 结构可以浓缩为:

```ts
// pregel/index.ts (节选)
while (
  await loop.tick({ inputKeys: this.inputChannels as string | string[] })
) {
  for (const { task } of await loop._matchCachedWrites()) {
    loop.putWrites(task.id, task.writes, true);
  }
  await runner.tick({
    timeout: this.stepTimeout,
    retryPolicy: this.retryPolicy,
    onStepWrite: (step, writes) => {
      /* debug 打印 */
    },
    maxConcurrency: config.maxConcurrency,
    signal: config.signal,
  });
}
if (loop.status === "draining") {
  throw new GraphDrained(loop.control.drainReason ?? "shutdown");
}
if (loop.status === "out_of_steps") {
  throw new GraphRecursionError(/* Recursion limit of N reached ... */);
}
```

`loop.tick` 负责状态推进 (准备任务、apply 写入、落检查点), `runner.tick` 负责并发执行本超步任务; `_matchCachedWrites` 在执行前先用缓存匹配已有写入, 命中则直接 `putWrites(task.id, task.writes, true)` 跳过执行。异常统一走 `loop.finishAndHandleError`, 可被抑制的错误 (如 interrupt) 不外抛。

### 5.3 PregelLoop.tick 状态机

`PregelLoop` (`src/pregel/loop.ts`) 的 `tick()` 每次推进一个超步, 关键路径:

1. 状态必须为 `"pending"`; 首超步 (`_first`) 消费输入并落 `source: "input"` 的检查点;
2. `_prepareNextTasks` 生成任务: PULL 任务来自通道版本差 (某通道版本超前于节点的 `versions_seen`), PUSH 任务来自 `__pregel_tasks` 通道里的 Send; `skipDoneTasks` 默认 `true`, resume 时已带完成写入的任务被跳过, 这是断点续跑不重复执行的关键;
3. 命中 `interruptBefore` 断点时抛 `GraphInterrupt`, 本超步任务不执行;
4. 若所有任务都已带写入 (缓存命中或恢复场景), 直接 `_applyWrites` 进入下一超步;
5. 否则返回 true 交给 runner 执行; 执行完的下一 tick 里 apply 写入、生成新检查点 (`source: "loop"`), 且在发出 values 流事件之前先完成 `_putCheckpoint`;
6. `durability: "sync"` 时同步等待检查点落盘; 之后检查 `interruptAfter` 断点;
7. 断点检查之后轮到 drain 检查: 若 `RunControl` 被请求排空, loop 进入 `"draining"` 状态, `_runLoop` 抛 `GraphDrained`;
8. DeltaChannel 收到 `Overwrite` 写入时强制在当步落快照。

Store 与 cache 分别以 `AsyncBatchedStore`/`AsyncBatchedCache` 包装后注入 loop, 把一步内的多次读写合并成批。

### 5.4 任务准备与 _applyWrites

`_prepareNextTasks`/`_applyWrites` (`src/pregel/algo.ts`) 的细节决定了确定性:

- 任务 id 用 uuid5 从检查点命名空间、节点名、路径等派生, 同一状态下重放得到同一批 id;
- 写入排序遵循与 `writesSortKey` 一致的 `(task_path, task_id, idx)` 序, `_applyWrites` 按序列化后的 task path 排序, 保证并行任务的写入以确定顺序进通道;
- 任务写入里的保留键 `{NO_WRITES, PUSH, RESUME, INTERRUPT, RETURN, ERROR, ERROR_SOURCE_NODE}` 是引擎内部记账, apply 时被忽略 (IGNORE 集合), 不会污染用户通道;
- PUSH 写入转成新的 Send 塞回 `__pregel_tasks`; ERROR 写入记录失败; RESUME/INTERRUPT 服务于第八章的恢复机制;
- 节点缓存键由 `CachePolicy.keyFunc` (默认 `JSON.stringify`) 产出再经 XXH3 哈希, 命中则整个节点执行被替换为缓存写入。

### 5.5 PregelRunner: 并发执行与错误处理

`PregelRunner.tick` (`src/pregel/runner.ts`) 并行跑本超步全部任务, 受 `maxConcurrency` 约束。每个任务的写入实时 push 到 `task.writes`; 正常结束但没有产出的任务补一条 `[NO_WRITES, null]` 记账。错误处理有一个容易忽略的细节: 任务抛错时通常 `exceptionSignalController.abort()` 取消同超步的兄弟任务, 但 invalid resume 错误例外——`if (!isInvalidResume(error))` 才 abort, 因为无效恢复只影响单个任务, 不应连带取消其他并行分支。错误会转成 ERROR 通道写入, 交给 loop 决定重试或终止。

### 5.6 重试、超时与缓存

- `RetryPolicy` 默认值 (`src/pregel/retry.ts`): `initialInterval` 500ms、`backoffFactor` 2、`maxInterval` 128000ms、`maxAttempts` 3、`jitter` true, 重试时默认打 warning 日志;
- `TimeoutPolicy`: `runTimeout` (单次执行墙钟上限) 与 `idleTimeout` (无进展上限), `refreshOn` 取 `"auto"` 或 `"heartbeat"`——后者要求任务主动调用 `config.heartbeat()` 刷新; 超时抛 `NodeTimeoutError`, 之后由 retryPolicy 决定是否重试;
- `CachePolicy`: `keyFunc` 默认 `JSON.stringify`, 支持 `ttl`; compile 时传入 `cache` (BaseCache) 才生效。

### 5.7 durability 与 invoke 折叠

检查点落盘时机由 `durability` 控制, 取值 `"exit" | "async" | "sync"`, 默认 `"async"`: `async` 在后台并发写, `sync` 每步等待写完再继续, `exit` 只在运行退出时写。`invoke` 不是独立实现, 而是 `stream` 的折叠: `streamMode` 缺省为 `"values"`, 取最后一个 values 块作为返回值; 若运行以 interrupt 收场, 中断载荷会随 `INTERRUPT` 标记合并进输出, 调用方无需 try/catch 就能拿到"停在哪、为什么停"。

## 六、检查点持久化体系

### 6.1 Checkpoint 数据结构

`Checkpoint` (`libs/checkpoint/src/base.ts`) 固定 `v: 4`, 字段为: `id` (uuid6, 时间有序)、`channel_values` (各通道快照值)、`channel_versions` (版本计数, 驱动 PULL 触发)、`versions_seen` (每个节点已见过的通道版本, 与前者做差即得待执行任务)。`CheckpointTuple` 把它与 `config`、`metadata`、`parentConfig`、`pendingWrites` (已完成但尚未合并进检查点的任务写入, resume 时靠它跳过已完成任务) 打包。`CheckpointMetadata` 记录 `source` (`"input" | "loop" | "update" | "fork"`)、`step`、`parents` 映射, 以及 Beta 的 `counters_since_delta_snapshot` (delta 通道的 `[updates, supersteps]` 计数)。

### 6.2 BaseCheckpointSaver 契约

抽象方法: `getTuple(config)`、`list(config, options)`、`put(config, checkpoint, metadata, newVersions)`、`putWrites(config, writes, taskId, taskPath?)`、`deleteThread(threadId)`。默认 `serde` 为 `JsonPlusSerializer`; `getNextVersion` 提供版本递增; `writesSortKey` 定义 pending writes 的 `(task_path, task_id, idx)` 排序; `toJSON` 输出类名防止意外序列化遍历; `getDeltaChannelHistory` 沿 `parentConfig` 链回溯, 从最近的快照种子 + 增量写入重建 DeltaChannel 历史。

### 6.3 MemorySaver 与生产后端

`MemorySaver` (`libs/checkpoint/src/memory.ts`) 是进程内 Map 实现, 开发调试用。它做了两层原型污染防御: `POLLUTION_KEYS` (`__proto__`、`constructor`、`prototype`) 显式拦截, 内部容器用 `Object.create(null)`; `WRITES_IDX_MAP` 维护写入序号以支持幂等 put。生产选择见 1.3 的后端表: SQLite 适合单机, Postgres/Redis/MongoDB 适合服务化部署, Redis 后端额外提供 TTL 与 shallow 模式。

## 七、线程、快照与时间旅行

`configurable.thread_id` 标识一条会话线程; `checkpoint_id` 精确定位线程内某个检查点。编译后的图提供四个状态管理入口:

- `getState(config)` → `StateSnapshot`: `{ values, next, config, metadata, created_at, parent_config, tasks }`, `next` 是待执行节点名列表, `tasks` 含每个待执行任务的 id、name、interrupts 等描述;
- `getStateHistory(config)` → 沿 parent 链倒序的历史快照流;
- `updateState(config, values, asNode?)` → 以指定节点名义写入一组值, 产生 `source: "update"` 的新检查点;
- `bulkUpdateState(config, updates)` → 依序应用多组更新。

时间旅行 = 用历史 `checkpoint_id` 作为 config 重新运行: 引擎从该检查点分叉, 新检查点 metadata 标记 `source: "fork"`, 原分支保持不变。配合 `updateState` 可以先改写某个历史点的状态再分叉, 实现"修正后重跑"。

## 八、interrupt/resume: 人机协同

### 8.1 interrupt() 的控制流

`interrupt(payload)` (`src/interrupt.ts`) 只能在节点/任务执行中调用, 完整流程:

1. 从 AsyncLocalStorage 取当前任务 config, 取不到说明不在图运行中, 直接报错; 没有 checkpointer 时抛 `GraphValueError` (`MISSING_CHECKPOINTER`)——中断必须可持久化才有意义;
2. interrupt id 由 `checkpoint_ns` 的 XXH3 哈希加上任务内 `interruptCounter` 派生, 同一节点内多个 interrupt 依次编号, 且重放时 id 稳定;
3. 检查 resume 映射 (`CONFIG_KEY_RESUME_MAP`, 以 interrupt id 为键): 已有值则直接返回该值 (节点重放时前面的 interrupt 就是这样"快进"的);
4. 没有 resume 值: 把 interrupt 写入任务写入 (RESUME 切片按 `slice(0, idx + 1)` 持久化), 构造 `Interrupt` 载荷——若调用时传了 `responseSchema` (zod), 会经 `toJsonSchema` 转换挂在 `response_schema` 字段上——然后抛 `GraphInterrupt`;
5. `GraphInterrupt` 属于 `GraphBubbleUp` 错误家族 (同族还有 `NodeInterrupt`、`ParentCommand`、`GraphDrained`), 逐层冒泡到 loop, loop 把当前状态落成检查点后正常结束流, `StateSnapshot.next` 停在中断节点, `tasks[].interrupts` 携带载荷。

恢复时用 `new Command({ resume: value })` 作为输入再次 invoke/stream: 值可以是单值, 也可以是以 interrupt id 为键的映射 (一次应答多个中断)。节点从头重新执行, 已应答的 `interrupt()` 调用直接返回恢复值, 执行推进到下一个未应答的中断或正常完成。`skipDoneTasks` 保证同超步里已完成的其他任务不重跑。

### 8.2 invalid resume

对着没有待处理中断的运行发 `Command({ resume })` 会触发 `_markInvalidResume`: 错误打上 `INVALID_RESUME` 标记 (`Symbol.for("langgraph.invalid_resume")`), `isInvalidResume` 沿 cause 链识别。这类错误只终结目标任务, 不 abort 同超步兄弟任务 (见 5.5)。

### 8.3 静态断点

compile 时的 `interruptBefore`/`interruptAfter` 接受节点名数组或 `All` (`"*"`), 由 loop 在超步边界检查 (5.3 第 3、6 步), 命中即产生 `GraphInterrupt`。静态断点适合"每个节点执行前都要人审"的场景; 动态的 `interrupt()` 适合"只有特定分支需要人审"。`NodeInterrupt` 则可以在条件边/路由函数里抛出, 把"要不要停"变成运行期决定。

### 8.4 HumanInterrupt 协议类型

`@langchain/langgraph/prebuilt` 导出一组与 agent 无关的人机交互协议类型, 用于把中断载荷标准化:

```ts
interface HumanInterruptConfig {
  allow_ignore: boolean;
  allow_respond: boolean;
  allow_edit: boolean;
  allow_accept: boolean;
}
interface ActionRequest {
  action: string;
  args: Record<string, any>;
}
interface HumanInterrupt {
  action_request: ActionRequest;
  config: HumanInterruptConfig;
  description?: string;
}
type HumanResponse = {
  type: "accept" | "ignore" | "response" | "edit";
  args: null | string | ActionRequest;
};
```

`HumanInterrupt` 作为 `interrupt()` 的载荷, `HumanResponse` 作为 `Command({ resume })` 的值, 前端即可按 `config` 里四个开关渲染对应的操作按钮。

## 九、流式输出

### 9.1 八种 StreamMode

`StreamMode` (`src/pregel/types.ts`) 是八值联合: `"values" | "updates" | "debug" | "messages" | "checkpoints" | "tasks" | "custom" | "tools"`。`stream(input, { streamMode, subgraphs?, encoding? })` 返回 `IterableReadableStream` (实际是 `IterableReadableStreamWithAbortSignal`, `cancel(reason)` 会触发内部 AbortController, 把中止传播给生产任务; `signal` 属性可读取)。内部统一以 `StreamChunk = [namespace: string[], mode: StreamMode, payload]` 三元组流转:

- `values`: 每超步结束后的完整状态;
- `updates`: 每超步的增量, 形如"节点名 → 该节点写入";
- `debug`: 任务与检查点的调试事件;
- `messages`: LLM token 级消息流 (9.2);
- `checkpoints`: 每超步的检查点信封;
- `tasks`: 任务生命周期事件;
- `custom`: 节点内 `writer()`/`config.writer` 主动写入的任意数据;
- `tools`: 工具调用生命周期事件 (9.2)。

`streamMode` 传数组时输出块带 mode 前缀; `subgraphs: true` 时再带命名空间前缀。子图流通过 `createDuplexStream` 多路复用进父图流, 检查点信封 (`isCheckpointEnvelope` 识别) 无条件透传。

### 9.2 messages 与 tools 两个回调处理器

`messages` 模式由 `StreamMessagesHandler` (`src/pregel/messages.ts`) 实现, 双通道采集: chat model 的 token 回调 (`handleLLMNewToken`, 带 chunk 时原样转发, 否则包装成 `AIMessageChunk`) 与节点输出 (`handleChainEnd` 递归展开 Command/数组/对象里的消息)。发出的每条消息配 `[message, metadata]`, metadata 含 `langgraph_node` 与检查点命名空间。id 处理很细: 同一 run 的后续 chunk 没有 id 时映射到 `run-${runId}` 的稳定 id, 避免客户端把一条消息看成两条; 工具消息按 `run-${runId}-tool-${tool_call_id}` 区分; 节点输出按 `run-${runId}-out-${idx}` 区分。非流式模型 run 在 `handleLLMEnd` 补发完整消息。打标 `TAG_NOSTREAM` (`"langsmith:nostream"`) 的模型调用与打标 `TAG_HIDDEN` (`"langsmith:hidden"`) 的链路不进入该流。

`tools` 模式由 `StreamToolsHandler` (`src/pregel/stream.ts`) 实现, `awaitHandlers = true` 保证回调先于 `tool.invoke` 返回执行, 事件为 `on_tool_start` / `on_tool_event` (工具内部自定义流) / `on_tool_end` / `on_tool_error`, 均携带 `toolCallId`、`name` 与命名空间。一个重要的语义决定: 被 interrupt 或 drain 的工具不发 `on_tool_error`——暂停不是失败, 恢复后它会重新上报自己的 start 与 end。

### 9.3 SSE 编码

`stream(input, { encoding: "text/event-stream" })` 把流转换为 SSE 字节流 (`toEventStream`): 每块编码为 `event: ${mode}` 或带命名空间的 `event: ${mode}|${ns.join("|")}`, data 为 JSON (实现了 `toDict` 的对象会被展开); checkpoints/debug 块先经 `_serializeCheckpoint` 抽取 `thread_id`/`checkpoint_id` 等定位信息并剔除 `__` 开头的内部配置键; 流内异常编码成 `event: error` 后正常关闭。

### 9.4 streamEvents v3 与协议事件流

`streamEvents(input, { version: "v3", ... })` 走独立管线 `#streamEventsV3`: 以 `STREAM_EVENTS_V3_MODES` + `subgraphs: true` 采集底层流, 交给 `createGraphRunStream(source, transformers)` 生成 `GraphRunStream`——一个结构化的协议事件流 (`convertToProtocolEvent` 把内部块转成 `@langchain/protocol` 事件: messages/tools/updates/lifecycle/checkpoints 等)。compile 时的 `transformers` 选项与调用时传入的 transformers 合并生效, 可用于自定义投影 (如 UI 状态流)。`values` 事件可携带伴生检查点信封 (`StreamChunkMeta.checkpoint`), 让客户端不订阅完整 checkpoints 流也能构建分支/时间旅行 UI。`encoding: "text/event-stream"` 时经 `protocolEventsToEventStream` 转 SSE, 并把 abort 信号接到 `graphRun.abort` 上。`RemoteGraph` 复用同一套协议事件转换 (9.4 与 12.1 共享 `protocolEventsToEventStream` 的实现路径)。

## 十、Functional API: entrypoint 与 task

不想显式建图时, `src/func/index.ts` 提供函数式等价物。`task(nameOrOptions, func)` 把函数包成可调度的 Pregel 任务, options 为 `{ name, retry?, cachePolicy?, timeout? }`; 返回的代理函数调用即产生 Promise, 因此 `Promise.all` 就是并行任务; 生成器函数被明确拒绝 ("Generators are disallowed as tasks. For streaming responses, use config.write."); 启用 checkpointer 时任务入参出参必须可序列化。

`entrypoint(nameOrOptions, func)` 包装整个工作流, options 为 `{ name, checkpointer?, store?, cache?, timeout? }`, 函数最多接受 `(input, config)` 两个参数。它返回一个真正的 Pregel 实例, 内部只有三个通道: `START` (EphemeralValue, 接收输入)、`END` (LastValue, 承接返回值)、`PREVIOUS` (LastValue, 保存上次运行留下的状态), 默认 `streamMode` 为 `"updates"`。两个配套原语:

- `getPreviousState<T>()`: 在 entrypoint/task 内读取同一 thread 上次运行保存的状态;
- `entrypoint.final({ value, save })`: 返回值与持久化状态分离——`value` 给调用方, `save` 进 PREVIOUS 通道。

```ts
const addOne = task("add", async (a: number) => a + 1);

const workflow = entrypoint("example", async (numbers: number[]) => {
  return await Promise.all(numbers.map((n) => addOne(n)));
});

await workflow.invoke([1, 2, 3]); // [2, 3, 4]
```

`interrupt()` 在 entrypoint/task 里同样可用, 恢复方式与图 API 完全一致 (`Command({ resume })`)。两种 API 底层是同一台 Pregel: 图 API 把控制流画在边上, 函数式 API 把控制流写在代码里。

## 十一、Prebuilt 组件

### 11.1 ToolNode

`ToolNode` (`src/prebuilt/tool_node.ts`) 是执行 AIMessage 中 tool_calls 的标准节点。行为细节:

- 输入三种形态: `BaseMessage[]`、`{ messages: BaseMessage[] }`, 以及 Send 形态 `{ lg_tool_call: ToolCall, ...state }` (路由键会被剥掉, 其余字段作为状态传给工具);
- 从后向前找最近一条 AIMessage, 其 `tool_calls` 用 `Promise.all` 并行执行; 已有对应 ToolMessage (按 `tool_call_id` 匹配) 的调用被跳过, 支持恢复场景;
- 每个工具以 `(toolCall, runtime)` 调用, `runtime: ToolRuntime` 携带 `state` (ToolNode 的输入, 在图里即当前状态)、`toolCallId`、`config`、`context`、`store`、`writer`。state 走显式参数而非 AsyncLocalStorage, 因此浏览器环境同样可用;
- 输出归一化: 字符串原样、其他值 `JSON.stringify` 后包成 `status: "success"` 的 ToolMessage; 工具直接返回 ToolMessage 或 `Command` 时原样透传;
- `handleToolErrors` 默认 `true`: 工具抛错转成 `status: "error"` 的 ToolMessage, 内容为 "Error: 消息 + Please fix your mistakes.", 让模型有机会自我修正; 但 `GraphInterrupt` 与 `GraphDrained` 永远重抛——中断与排空不是可恢复错误, 不能喂回给模型;
- 多个工具返回父级 `Command` (`graph: Command.PARENT` 且 goto 全为 Send) 时合并为一个, 其余输出按输入形态组装 (数组进 → 数组出, 对象进 → `{ messages: [...] }` 出)。

### 11.2 toolsCondition

`toolsCondition(state)` 是配套条件边: 最后一条消息带非空 `tool_calls` 返回 `"tools"`, 否则返回 `END`。与 ToolNode 组合即经典的 agent 循环: `agent → toolsCondition → tools → agent`。

### 11.3 多 agent 套件

- `@langchain/langgraph-supervisor`: `createSupervisor({ agents, model, ... })` 生成"主管分派"图, `OutputMode` 控制子 agent 结果回传方式 (`"full_history"` 全量 / `"last_message"` 只传最后一条);
- `@langchain/langgraph-swarm`: `createSwarm` 生成平等协作图, `SwarmState` 在状态里记住 `active_agent`, `addActiveAgentRouter` 把控制权路由回活跃 agent, 交接由工具返回 `Command` 完成;
- `@langchain/langgraph-cua`: computer use agent, 图由三个节点组成——`call-model` (模型决策)、`create-vm-instance` (通过 Scrapybara 创建虚拟桌面, 需 `SCRAPYBARA_API_KEY`)、`take-computer-action` (执行鼠标键盘动作)。

## 十二、SDK、前端与部署平台

### 12.1 Client 与 RemoteGraph

`@langchain/langgraph-sdk` 的 `Client` 按资源分子客户端: `assistants`、`threads`、`runs`、`crons`、`store`。状态改写如 `threads.updateState(threadId, { values, checkpoint?, checkpointId?, asNode? })`, 对应 `POST /threads/{thread_id}/state`。核心库 `"./remote"` 导出的 `RemoteGraph` (`src/pregel/remote.ts`) 则以 `{ graphId, client? | url?, apiKey?, headers?, streamResumable? }` 把一个远端部署的图包装成本地 Pregel 形态的可运行对象——实现 `PregelInterface`, 支持 invoke/stream/getState 等, 可以像本地子图一样嵌进另一张图。

### 12.2 ThreadStream 与双传输

面向 UI 的 `ThreadStream` + `StreamController` (`src/client/stream/`) 提供带中断应答能力的事件流: `hydrate()` 重连并回放既有运行的缓冲事件, `respond()`/`respondAll()` 在流上直接应答 interrupt。传输层两个适配器:

- SSE: HTTP 长连接单向流;
- WebSocket: 连接 `/threads/:thread_id/stream/events`, 双向, 支持在流上发送命令 (如 `subscription.subscribe`)。断线后指数退避重连 (`maxReconnectAttempts` 上限, 超限抛 `MaxWebSocketReconnectAttemptsError`), 服务端在新连接上回放缓冲事件, SDK 按 `event_id` 去重, 重连成功后回调 `onReconnected` 重发订阅。

两个传输共享同一套"可重试性"判定: HTTP 4xx (除 408/429) 视为不可重试直接以带 `status` 的错误终止; WebSocket 服务端用 4000+HTTP 状态的 close code 表达同类错误 (如 4403/4404/4422 → `status` 403/404/422), 客户端 `closeError` 还原出 status 后走同一判定。

### 12.3 React 集成

`@langchain/react` 的核心是 `useStream` hook: 管理一次 thread 运行的消息流、中断应答与重连水合, 配套 context provider、状态 selectors、suspense-stream 与媒体 hooks。SDK 内的 `StreamOrchestrator` (`src/ui/orchestrator.ts`) 承担跨框架的流编排逻辑。

### 12.4 langgraph-api 与 CLI

`@langchain/langgraph-api` 用 hono 实现 LangGraph Protocol 服务端。一个值得记住的协议约束在 `run.start` 的处理里: 当线程存在多于一个待处理 interrupt 且新输入没有按 interrupt_id 键控时, 返回 `invalid_argument`——多中断场景必须用 `input.respond` 逐个应答, 服务端把 `{ interrupt_id, response }` 组装成以 interrupt id 为键的 resume 映射交给引擎 (对应 8.1 的 `CONFIG_KEY_RESUME_MAP`)。`@langchain/langgraph-cli` (bin: `langgraphjs`) 提供 `new`、`dev`、`build`、`up`、`dockerfile`、`deploy`、`list`、`revisions`、`logs`、`delete`、`sysinfo` 命令, 覆盖从脚手架到部署运维的链路。

## 十三、适用场景与边界

适合交给 LangGraph.js 的问题特征: 多步、长时、需要中途暂停 (人工审批、外部回调)、需要崩溃后从断点恢复、需要审计每一步状态 (时间旅行)、或需要多个 agent/工具分支并行再汇合。此时你得到的是: 确定性超步执行、每步落盘的检查点、八种粒度的流式输出与标准化的中断协议。

同样要认清边界: 它是 runtime 而非 agent 框架——不内置模型选择、提示词管理或 agent 策略, 这些属于上一层 (仓库方向明确把 agent 构建指向更高层的 harness, 核心库内的 prebuilt 与多 agent 套件处于维护状态); `MemorySaver`/`InMemoryStore` 是进程内实现, 生产必须换持久后端; 每超步全量检查点对大状态有成本, DeltaChannel 的稀疏快照是缓解手段但仍标注 Beta; `interrupt()` 依赖 AsyncLocalStorage 获取环境 config, 脱离图运行上下文调用会直接报错, 而工具访问状态应走 `ToolRuntime.state` 显式参数以兼容浏览器环境。把这几条边界放进选型清单, LangGraph.js 的定位就清晰了: 当你需要"可暂停、可恢复、可回放的图执行"时, 它是 TypeScript 生态里把 Pregel 模型、通道状态与检查点持久化结合得最完整的运行时。
