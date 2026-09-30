---
title: "LangGraph.js 调研: Pregel 超步执行引擎、通道状态模型与检查点持久化体系"
description: "基于 langgraphjs@cca48067 本机克隆: 拆解 monorepo 包布局、StateGraph/Pregel BSP 执行循环、channels 与 reducers、checkpointer 生态、human-in-the-loop 与流式输出"
---

仓库路径: https://github.com/langchain-ai/langgraphjs (本机克隆位于 $HOME/Downloads/langgraphjs)

## 一、项目快照 (本机克隆 2026-09-30)

本机克隆于 2026-09-30 核实, 分支 main, 工作区干净 (仅含本地未跟踪的 .codegraph 索引目录)。

| 指标        | 数值                                                                                                                           |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------ |
| HEAD commit | cca48067 (完整哈希 cca48067b78fa9e3dc632c02a3431e74ff3f91b1)                                                                   |
| 提交日期    | 2026-09-29 18:07:09 -0400                                                                                                      |
| 提交信息    | fix(sdk): reconcile stream buffer with server state after cancelling a run (#2882)                                             |
| 分支        | main                                                                                                                           |
| 定位        | Low-level orchestration framework for building stateful agents (README.md 标语)                                                |
| 主 npm 包   | @langchain/langgraph 1.4.18, 源码位于 libs/langgraph-core; 根目录 README.md 是指向 libs/langgraph-core/README.md 的符号链接    |
| 规范包名    | langgraph 1.0.47 (libs/langgraph), 无 scope 便捷包装, 全量 re-export 主包                                                      |
| License     | MIT (LICENSE: Copyright (c) 2024 LangChain)                                                                                    |
| 运行时      | 仓库 engines: node ^22.11 或 ^24 或 26 及以上 (根 package.json); @langchain/langgraph 自身 engines: node 18 及以上             |
| 包管理      | pnpm@10.27.0 (packageManager 字段); workspace 范围为 docs、examples 下全部、libs 下全部、internal 下全部 (pnpm-workspace.yaml) |
| 构建工具    | turbo ^2.10.8; devDependencies 含 TypeScript ^4.9.5 或 ^5.4.5、@swc/core、oxlint ^1.55.0、oxfmt ^0.42.0、@changesets/cli       |
| 发布        | changesets (根 release 脚本 changeset publish; libs 下各包带 CHANGELOG.md)                                                     |

自我定位写在 README 首段: LangGraph 是构建可控 agent 的低层编排框架, 声称被 Replit、Uber、LinkedIn、GitLab 等使用; LangChain 提供集成与可组合组件, LangGraph 负责 agent 编排, 提供可定制架构、长期记忆与 human-in-the-loop。README 末尾的致谢明确了设计血统: 受 Google Pregel 与 Apache Beam 启发, 公开接口借鉴 NetworkX; 由 LangChain Inc 构建, 但可以脱离 LangChain 单独使用。

安装入口是 `npm install @langchain/langgraph @langchain/core`; README 同时提示更高层的 Deep Agents (规划、子 agent、文件系统) 与 Python 版对应仓库。

## 二、Monorepo 包结构

libs/ 下共 20 个包 (以下版本均来自各包 package.json 的 version 字段, 2026-09-30 核实):

核心执行与状态:

| 目录                | npm 名                          | 版本   | 职责                                                                        |
| ------------------- | ------------------------------- | ------ | --------------------------------------------------------------------------- |
| libs/langgraph-core | @langchain/langgraph            | 1.4.18 | 核心库: StateGraph、Pregel 引擎、channels、prebuilt、functional API         |
| libs/langgraph      | langgraph                       | 1.0.47 | 无 scope 规范名, src/index.ts 仅一行 `export * from "@langchain/langgraph"` |
| libs/checkpoint     | @langchain/langgraph-checkpoint | 1.1.5  | checkpointer 基础接口、MemorySaver、Store、Cache、序列化                    |

持久化后端 (均实现 BaseCheckpointSaver):

| 目录                       | npm 名                                     | 版本   | 依赖                            |
| -------------------------- | ------------------------------------------ | ------ | ------------------------------- |
| libs/checkpoint-sqlite     | @langchain/langgraph-checkpoint-sqlite     | 1.0.4  | better-sqlite3 ^12.10.0         |
| libs/checkpoint-postgres   | @langchain/langgraph-checkpoint-postgres   | 1.0.5  | pg ^8.12.0                      |
| libs/checkpoint-mongodb    | @langchain/langgraph-checkpoint-mongodb    | 1.4.1  | mongodb ^6.21.0                 |
| libs/checkpoint-redis      | @langchain/langgraph-checkpoint-redis      | 1.0.11 | redis ^4.7.0                    |
| libs/checkpoint-validation | @langchain/langgraph-checkpoint-validation | 1.1.1  | 校验任意 saver 实现的测试套件库 |

平台与部署:

| 目录                  | npm 名                   | 版本        | 职责                                                   |
| --------------------- | ------------------------ | ----------- | ------------------------------------------------------ |
| libs/langgraph-api    | @langchain/langgraph-api | 1.5.2-dev.0 | LangGraph API 的内存实现 (其 README 首句), hono 服务器 |
| libs/langgraph-cli    | @langchain/langgraph-cli | 1.5.2-dev.0 | CLI, bin 名 langgraphjs 指向 dist/cli/cli.mjs          |
| libs/langgraph-ui     | @langchain/langgraph-ui  | 1.5.2-dev.0 | 平台配套 UI                                            |
| libs/create-langgraph | create-langgraph         | 1.1.5       | 项目脚手架                                             |

SDK 与前端集成:

| 目录             | npm 名                   | 版本   | 职责                                                                                                |
| ---------------- | ------------------------ | ------ | --------------------------------------------------------------------------------------------------- |
| libs/sdk         | @langchain/langgraph-sdk | 1.12.0 | LangGraph API 客户端; exports 含 ./ui ./client ./auth ./react ./logging ./react-ui ./utils ./stream |
| libs/sdk-react   | @langchain/react         | 1.2.0  | React 集成, 含 useStream hook; peerDependencies 为 @langchain/core ^1.1.48 与 react ^18 或 ^19      |
| libs/sdk-angular | @langchain/angular       | 1.2.0  | Angular 集成                                                                                        |
| libs/sdk-svelte  | @langchain/svelte        | 1.2.0  | Svelte 集成                                                                                         |
| libs/sdk-vue     | @langchain/vue           | 1.2.0  | Vue 集成                                                                                            |

高层 agent 套件:

| 目录                      | npm 名                          | 版本  | 职责                     |
| ------------------------- | ------------------------------- | ----- | ------------------------ |
| libs/langgraph-supervisor | @langchain/langgraph-supervisor | 1.1.3 | 多 agent supervisor 模式 |
| libs/langgraph-swarm      | @langchain/langgraph-swarm      | 1.0.4 | swarm 多 agent 模式      |
| libs/langgraph-cua        | @langchain/langgraph-cua        | 1.0.4 | computer use agent 实现  |

辅助目录: docs/ 是 mkdocs 站 (mkdocs.yml + typedoc.jsonc); examples/ 约 20 个示例工程 (quickstart、chatbots、multi_agent、rag、streaming、how-tos、sql-agent、plan-and-execute、reflection、rewoo、agent_executor、chat_agent_executor_with_function_calling、chatbot-simulation-evaluation、ai-elements、assistant-ui-claude、ui-react/vue/svelte/angular、ui-multimodal、ui-react-transport 等, quickstart 本身是一个 Jupyter notebook); internal/ 含 bench (基准) 与 environment_tests (导出面环境测试); int-test-deps-docker-compose.yml 提供集成测试依赖 (Postgres、Redis 等)。

依赖方向清晰: 各 checkpoint 后端包 peer 依赖 @langchain/langgraph-checkpoint ^1.1.4 与 @langchain/core; @langchain/langgraph 直接依赖 workspace 内的 checkpoint 与 sdk, 外加 @langchain/protocol ^0.0.19 与 @standard-schema/spec 1.1.0, 并 peer 依赖 @langchain/core ^1.1.48 与 zod ^3.25.32 或 ^4.2.0。根 package.json 的 pnpm.overrides 将 @langchain/core 钉到 ^1.2.9、zod 钉到 ^4.3.5, 保证 monorepo 内版本一致。

## 三、图定义层: StateGraph、Annotation 与 channels

### Annotation 即通道规格

状态 schema 由 Annotation 描述, 定义在 libs/langgraph-core/src/graph/annotation.ts。`StateDefinition` 是一个键到通道的映射:

```ts
export interface StateDefinition {
  [key: string]: BaseChannel | (() => BaseChannel);
}
```

`Annotation` 本身是一个可调用对象 (annotation.ts:158), 两种用法:

- 不带参数: 创建 `LastValue` 通道, 只保留节点最近一次写入的值;
- 带 reducer: 创建 `BinaryOperatorAggregate` 通道, 用二元归约函数聚合写入, `default` 提供初始值工厂。

工厂函数 `getChannel` (annotation.ts:174) 完成这个分派; `SingleReducer` 类型里的 `value` 字段已标记 deprecated, 应使用 `reducer`。`Annotation.Root(spec)` 返回 `AnnotationRoot` 实例, 通过 `declare State`、`declare Update`、`declare Node` 三个类型投影暴露状态类型、更新类型与节点签名 (annotation.ts:62-70), 并带 `isInstance` 静态守卫识别跨包实例。annotation.ts 文档块给出的标准示例:

```ts
import { StateGraph, Annotation } from "@langchain/langgraph";

const AnnotationWithReducer = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    // Different types are allowed for updates
    reducer: (left: BaseMessage[], right: BaseMessage | BaseMessage[]) => {
      if (Array.isArray(right)) {
        return left.concat(right);
      }
      return left.concat([right]);
    },
    default: () => [],
  }),
});
```

除 Annotation 外, 仓库还支持 zod schema 作为状态定义: libs/langgraph-core/src/graph/zod/ 下有 meta.ts、schema.ts、plugin.ts、zod-registry.ts, graph/types.ts 的 `isStateDefinitionInit` 同时接受 Annotation 与 zod 对象形态; `StateGraphAddNodeOptions` 的 `input` 字段类型即 `StateDefinitionInit` (graph/state.ts:214), interrupt 的 responseSchema 也复用同一套 zod 互操作。

### 通道协议

所有通道继承抽象基类 `BaseChannel` (channels/base.ts:30), 它定义了 Pregel 与通道之间的完整契约 (注释引自源码):

```ts
export abstract class BaseChannel<
  ValueType = unknown,
  UpdateType = unknown,
  CheckpointType = unknown,
> {
  ValueType: ValueType;
  UpdateType: UpdateType;
  abstract lc_graph_name: string;
  lg_is_channel = true;

  abstract fromCheckpoint(checkpoint?: CheckpointType): this;
  abstract update(values: UpdateType[]): boolean;
  abstract get(): ValueType;
  abstract checkpoint(): CheckpointType | undefined;

  consume(): boolean { return false; }
  finish(): boolean { return false; }
  isAvailable(): boolean { ... }
  equals(other: BaseChannel): boolean { return this === other; }
}
```

语义要点 (逐条对应 base.ts 的文档注释):

- `update` 在每个超步结束时被 Pregel 调用, 无更新时以空序列调用; 更新顺序任意, 非法序列抛 InvalidUpdateError, 返回布尔表示是否真的变了;
- `get` 空通道抛 EmptyChannelError;
- `checkpoint`/`fromCheckpoint` 是快照与恢复对;
- `consume` 把当前值标记为已消费, 防止被再次触发;
- `finish` 通知运行即将结束, 给 AfterFinish 系列通道最后曝光的机会;
- `isAvailable` 默认实现是 try get 捕获 EmptyChannelError, 子类可覆写得更高效。

### 内置通道一览

channels/ 目录共 10 个通道实现文件:

| 通道                         | 文件                              | 语义                                                              |
| ---------------------------- | --------------------------------- | ----------------------------------------------------------------- |
| LastValue                    | channels/last_value.ts            | 保留最后一个值; 同一超步内收到多于一个写入时抛 InvalidUpdateError |
| LastValueAfterFinish         | channels/last_value.ts            | LastValue 变体, 仅在本超步 finish 后可读, 读取后清空              |
| BinaryOperatorAggregate      | channels/binop.ts                 | reducer 聚合, 支持 Overwrite 直接覆盖语义                         |
| Topic                        | channels/topic.ts                 | 列表缓冲, unique 去重、accumulate 跨步累积两个开关                |
| EphemeralValue               | channels/ephemeral_value.ts       | 只在写入后的紧邻超步可见, 步末无更新则清空                        |
| AnyValue                     | channels/any_value.ts             | 接受任意一个值, 不校验并发写, 步末清空                            |
| NamedBarrierValue            | channels/named_barrier_value.ts   | 栅栏: 等所有命名写入者到齐才可用                                  |
| NamedBarrierValueAfterFinish | channels/named_barrier_value.ts   | 栅栏 + finish 语义                                                |
| DynamicBarrierValue          | channels/dynamic_barrier_value.ts | 写入者集合动态确定的栅栏 (含 AfterFinish 变体)                    |
| UntrackedValueChannel        | channels/untracked_value.ts       | 不参与追踪的内部通道                                              |
| DeltaChannel                 | channels/delta.ts                 | 实验性增量通道, 支持稀疏重放与批量 reducer                        |

并发写入安全由 LastValue 直接体现 (last_value.ts:34-48):

```ts
update(values: Value[]): boolean {
  if (values.length === 0) {
    return false;
  }
  if (values.length !== 1) {
    throw new InvalidUpdateError(
      "LastValue can only receive one value per step.",
      { lc_error_code: "INVALID_CONCURRENT_GRAPH_UPDATE" }
    );
  }

  // eslint-disable-next-line prefer-destructuring
  this.value = [values[values.length - 1]];
  return true;
}
```

即: 若两个并行节点写同一个无 reducer 的状态键, 图会以 INVALID_CONCURRENT_GRAPH_UPDATE 失败, 这正是要求显式声明 reducer 的机制。内部用长度为 1 的数组存值, 以区分"写入了 undefined"与"从未写入"。

BinaryOperatorAggregate (binop.ts:27) 持有 `operator` 与可选 `initialValueFactory`, `update` 对每个写入依次执行 `this.value = this.operator(this.value, incoming)`; 同时识别 Overwrite 哨兵: 首个写入若是 Overwrite 则直接取内部值初始化, 后续每步最多接受一个 Overwrite, 收到即整体替换 (binop.ts:65-97), 两个 Overwrite 同步到达会抛错。Overwrite 哨兵常量 `OVERWRITE = "__overwrite__"` 与配套函数定义在 constants.ts:289 一带, 供 `updateState` 等路径绕过 reducer 整体覆写。

Topic (topic.ts:27) 构造参数为 `unique` 与 `accumulate` 两个开关: accumulate 为 false 时每步先清空再接收; unique 为 true 时用引用相等去重。它是 TASKS 通道 (承载 Send) 的实现。NamedBarrierValue 是 fan-in 边的底层实现 (named_barrier_value.ts:7-11 注释): 若节点 N 与 M 都写通道 C, C 在两者都完成前不更新; `get` 在 names 与 seen 集合不一致时抛 EmptyChannelError 阻止继续, `consume` 在栅栏满足后重置 seen 以便下轮复用。EphemeralValue (ephemeral_value.ts:7) 在步末收到空更新序列时主动清空自己, 因此 START/END 这类只在一个超步有意义的值不会残留。

### MessagesAnnotation 与消息 reducer

聊天场景的默认 schema 是 `MessagesAnnotation` (graph/messages_annotation.ts:44):

```ts
export const MessagesAnnotation = Annotation.Root({
  messages: Annotation<BaseMessage[], Messages>({
    reducer: messagesStateReducer,
    default: () => [],
  }),
});
```

包导出时还提供别名 `addMessages` (web.ts: `messagesStateReducer as addMessages`), 以及简化版 `MessageGraph`。`messagesStateReducer` (graph/messages_reducer.ts:60) 的合并规则:

1. 左右两侧都先规整为数组, 并用 `coerceMessageLikeToMessage` 转成 BaseMessage 实例;
2. 缺 id 的消息补 uuid4 (左右都补);
3. 右侧出现 id 为 `REMOVE_ALL_MESSAGES` (常量 `"__remove_all__"`, messages_reducer.ts:14) 的 RemoveMessage 时, 丢弃该标记之前的全部消息, 只返回其后的消息;
4. 常规合并按 id upsert: 已存在则原位替换 (RemoveMessage 则标记删除), 不存在则追加; 删除不存在的 id 会抛错。

另有实验性的 `messagesDeltaReducer` (messages_reducer.ts:164), 作为 DeltaChannel 的批量 reducer, 一次接收整个超步的写入批次。

### StateGraph 构建 API

`StateGraph` 位于 graph/state.ts, 继承自 graph/graph.ts 的 `Graph`。`addNode` 提供大量重载 (state.ts:933-1060 连续五个 overload 签名):

- 传对象映射一次加多个节点;
- 传 `[key, action, options?]` 元组数组;
- 传 `key, action, options`, 其中 options 可带 `input` (节点级输入 schema) 与 `errorHandler` (节点级错误处理器, 仅在该节点重试策略耗尽后运行, 可返回状态更新或 Command);

节点策略 (retry/cache/timeout) 通过 `NodePolicyOptions` 传入, `setNodeDefaults` (state.ts:719) 可设置全图默认策略 (注释说明策略不会被子图继承)。`addSequence` 顺序连线一组节点。

`addEdge` 支持 fan-in: startKey 可以是节点名数组 (state.ts:1241-1274), 数组形式记入 `waitingEdges`, 编译时生成 NamedBarrierValue 通道, 语义是"所有起点都到达才触发终点"; 校验 END 不能作为多起点之一, 且在已编译的图上继续加边会 console.warn 提示不会反映到已编译实例。

编译入口 `compile` (state.ts:1394) 接受:

| 选项                             | 类型                           | 说明                                              |
| -------------------------------- | ------------------------------ | ------------------------------------------------- |
| checkpointer                     | BaseCheckpointSaver 或 boolean | 持久化后端; false 显式关闭                        |
| store                            | BaseStore                      | 跨线程长期记忆                                    |
| cache                            | BaseCache                      | 节点结果缓存                                      |
| interruptBefore / interruptAfter | 节点名数组或 All               | 静态断点                                          |
| name / description               | string                         | 图的名称与描述                                    |
| transformers                     | 只读数组                       | 固化进编译产物的流转换器工厂 (供 streamEvents v3) |

产物 `CompiledStateGraph` (state.ts:1689) 继承 `CompiledGraph` (graph/graph.ts:688), 后者继承 `Pregel`——也就是说, 编译后的图就是 Pregel 引擎实例。addNode 传入另一个编译图或 pregel-like runnable 即构成子图: state.ts:1226 用 `isPregelLike` (pregel/utils/subgraph.ts) 探测并登记到 `subgraphs`。

## 四、边、条件边与 Send 路由

### 条件边

`addConditionalEdges` 定义在 graph/graph.ts:435-497, 两种调用形态: 位置参数 `(source, path, pathMap?)` 或单个 options 对象。实现要点:

- `path` 不是 Runnable 时用 `_coerceToRunnable` 包装;
- 条件命名取 runnable 名, 名为 RunnableLambda 时回退为字符串 condition;
- 同一 source 下条件名重复会抛错 `Condition already present for node`;
- 条件存入 `this.branches[source][name] = new Branch(options)`。

运行期, 条件边的求值结果映射到目标节点 (可返回单名、名称数组或 Send 对象); pathMap 提供返回值到节点名的显式映射。条件边读取的状态通过 `_localRead`/`_procInput` (pregel/algo.ts:1360 附近) 构造, 只反映当前节点自身写入的视图——这保证路由决策与 Pregel 的超步隔离语义一致。pregel/io.ts 的 `mapCommand` (io.ts:71) 负责把节点返回的 Command 展开成写入序列。

### Send 与 map-reduce

`Send` 类定义在 constants.ts:251-282: 携带目标节点名 `node`、任意 `args` 与可选的每任务超时策略 `timeout` (裸数字视为 runTimeout 毫秒); 构造时会对 args 做 `_deserializeCommandSendObjectGraph` 递归还原 (constants.ts:690), 把普通对象形态的 Command/Send 还原成实例并处理自引用, 保证序列化往返一致。

Send 在调度层表现为 PUSH 任务: 保留通道 `TASKS = "__pregel_tasks"` (constants.ts:101) 是一个 `Topic<Send>` 通道, `_prepareNextTasks` (pregel/algo.ts:576) 每个超步先把 TASKS 通道里的每个 Send 转成 `[PUSH, i]` 路径的任务, 再处理 PULL 任务:

```ts
const tasksChannel = channels[TASKS] as Topic<SendProtocol> | undefined;

if (tasksChannel?.isAvailable()) {
  const len = tasksChannel.get().length;
  for (let i = 0; i < len; i += 1) {
    const task = _prepareSingleTask(
      [PUSH, i],
      checkpoint,
      ...
    );
    if (task !== undefined) {
      tasks[task.id] = task;
    }
  }
}
```

条件边返回 Send 数组即官方 map-reduce 模式: 路由函数动态决定并行分支数量与各自输入。prebuilt 的 createReactAgent `version: "v2"` 也依赖该机制——工具节点按单个 tool call 拆分, 用 Send 分发到多个 ToolNode 实例并行执行 (react_agent_executor.ts:611-621 的 version 选项注释)。Send 还支持携带每任务 timeout, 覆盖目标节点自身的超时策略。

### 特殊节点与 Command 路由

`START = "__start__"`、`END = "__end__"` 定义在 constants.ts:9-11; 编译时 START 与 END 各挂一个 EphemeralValue 通道 (graph/graph.ts:569-572), 图的输入输出通道默认就是 START 与 END。

`Command` 类 (constants.ts:546 起) 是节点返回值形态的动态路由原语, 字段:

| 字段   | 语义                                                                                      |
| ------ | ----------------------------------------------------------------------------------------- |
| resume | 配合 interrupt 的恢复值                                                                   |
| graph  | 目标图; 缺省当前图; `Command.PARENT` 即 `"__parent__"` 表示最近的父图 (仅子图节点可用)    |
| update | 状态更新, 等价于节点直接返回该值; 也接受 `[string, unknown][]` 元组数组                   |
| goto   | 后续节点名、Send 对象, 或二者的数组; `_updateAsTuples` 把 update 规整成 PendingWrite 元组 |

内部通过 `COMMAND_SYMBOL = Symbol.for("langgraph.command")` (constants.ts:143) 做跨包实例识别, 基类 `CommandInstance` 只持有 symbol 键参数; `isCommand` 类型守卫与 `toJSON` 序列化齐备。工具返回 Command 时 ToolNode 会聚合处理: 指向父图的 Send 数组型 Command 合并为一个 (prebuilt/tool_node.ts:344-373)。子图节点返回 graph 指向父图的 Command 时, 运行期以 `ParentCommand` 冒泡异常承载 (errors.ts:164)。

## 五、Pregel 执行引擎: BSP 超步循环

### 类结构与入口

`Pregel` 类定义在 libs/langgraph-core/src/pregel/index.ts:445, 类头文档块 (index.ts:386-401) 自述: 实现受 Google Pregel 论文启发的消息传递图计算模型; 关键特性为离散超步内的节点间消息传递、基于 checkpointer 的持久化、values/updates/events 一流式支持、interrupt 人机协同、超步内节点并行。文档块同时声明不建议直接实例化, 应通过 StateGraph 编译或 functional API 的 entrypoint 获得。类型链为 `Pregel` 继承 `PartialRunnable` (index.ts:356), 后者继承 @langchain/core 的 `Runnable`, `lc_namespace = ["langgraph", "pregel"]`; PartialRunnable 的 invoke/stream 只是占位, 由 Pregel 覆写。

`invoke` (index.ts:2558) 是 `stream` 的折叠: streamMode 缺省 values, 消费全部 chunk; 若输出里带 `__interrupt__` 键则收集 interrupt, 最终把 interrupt 合并进返回值对象:

```ts
if (interruptChunks.length > 0) {
  const interrupts = interruptChunks.flat(1);
  if (latest == null) return { [INTERRUPT]: interrupts } as OutputType;
  if (typeof latest === "object") {
    return { ...latest, [INTERRUPT]: interrupts };
  }
}
```

`stream` (index.ts:1962) 做了两件值得注意的事: 一是合并环境配置——当某个任务体内无 config 地调用子图 invoke/stream 时 (例如工具里直接调用子 agent), 通过 AsyncLocalStorage 拿到的 ambient `configurable` 若含 `CONFIG_KEY_READ` 而调用方没传, 会把 ambient 合并进去, 保证子图嵌套关系与流命名空间不丢 (index.ts:1999-2024 的长注释解释了 createAgent/ReactAgent 总会传 configurable 导致嵌套键丢失的问题); 二是把底层流包进 `IterableReadableStreamWithAbortSignal`, encoding 为 text/event-stream 时再经 `toEventStream` 转成 SSE 字节流。

### 图内节点抽象: PregelNode

编译后的每个节点是 `PregelNode` (pregel/read.ts:104), 继承 RunnableBinding, 字段一一对应执行语义:

| 字段                                | 用途                               |
| ----------------------------------- | ---------------------------------- |
| channels                            | 订阅的通道 (键映射或数组)          |
| triggers                            | 触发该节点的通道列表               |
| bound                               | 实际执行体 Runnable                |
| writers                             | 节点写入后追加执行的 Runnable 序列 |
| retryPolicy / cachePolicy / timeout | 节点级策略                         |
| subgraphs                           | 该节点内嵌的子图列表               |
| metadata / tags                     | 追踪与流元数据                     |
| ends                                | 出边目标集合                       |
| isErrorHandler / errorHandlerNode   | 错误处理器节点标记                 |

输入侧由 `mapInput` (pregel/io.ts:138) 把图输入分发到输入通道, 输出侧由 `mapOutputValues` (io.ts:168) 与 `mapOutputUpdates` (io.ts:202) 生成 values/updates 流载荷, `readChannel`/`readChannels` (io.ts:22, 43) 负责读取通道当前值。

### 主循环

`_runLoop` (index.ts:2603) 是执行骨架:

```ts
while (
  await loop.tick({ inputKeys: this.inputChannels as string | string[] })
) {
  if (emitLifecycleEvents)
    await emitLifecycleEvents(loop.lifecycleEvents);
  for (const { task } of await loop._matchCachedWrites()) {
    loop._outputWrites(task.id, task.writes, true);
  }
  ...
  await runner.tick({
    timeout: this.stepTimeout,
    retryPolicy: this.retryPolicy,
    onStepWrite: (step, writes) => { ... },
    maxConcurrency: config.maxConcurrency,
    signal: config.signal,
  });
}
```

`loop.tick` 返回 true 表示还有下一个超步, runner.tick 负责并发执行本超步任务; 命中缓存的任务写入直接回放 (`_matchCachedWrites`)。循环结束后若 status 为 draining 抛 `GraphDrained`, 为 out_of_steps 抛 `GraphRecursionError`——后者提示递归上限可用 recursionLimit 配置调大 (index.ts:2653-2660)。默认递归上限为 `RECURSION_LIMIT_DEFAULT = 25` (constants.ts:95)。

### 超步推进: PregelLoop.tick

`PregelLoop` 单类定义在 pregel/loop.ts:292。`tick` 方法 (loop.ts:958) 的状态机:

1. 若 store 未启动则启动; status 非 pending 直接抛错;
2. input 尚未处理完 (不在 `INPUT_DONE`/`INPUT_RESUMING` 之列) 时执行 `_first`, 完成输入写入与首个超步任务准备;
3. 有待触发的静态断点 (`toInterrupt` 非空) 时, 置 status 为 interrupt_before 并抛 `GraphInterrupt`;
4. 否则若本超步所有任务都已有 writes (全部完成), 收尾该超步:

```ts
// finish superstep
const writes = finishTaskList.flatMap((t) => t.writes);
// All tasks have finished
this.updatedChannels = _applyWrites(
  this.checkpoint,
  this.channels,
  finishTaskList,
  this.checkpointerGetNextVersion,
  this.triggerToNodes,
);
```

随后产出 values 流输出、按 durability 策略落 checkpoint, 再 `_prepareNextTasks` 生成下一超步任务集; 无新任务则返回 false 结束。DeltaChannel 在收到 Overwrite 时会被登记到 `_deltaChannelsWithOverwrite`, 以便下次检查点从覆盖后的值做快照 (loop.ts:987-999); "exit" 持久性下增量写入还要进 `_exitDeltaWrites` 累加器 (loop.ts:1007-1016)。

### 写回: _applyWrites

`_applyWrites` (pregel/algo.ts:269-439) 是超步收尾的通道更新算法, 步骤:

1. 任务按 path 前三个元素排序, 保证确定性 (pathCache 避免重复 slice; 任务 id 等后续 path 元素不参与排序);
2. 遍历任务更新 `checkpoint.versions_seen[task.name]`, 记录各任务已看到的触发通道版本, 非保留通道加入待消费集合;
3. 消费触发通道 (`channel.consume()`), 用 checkpointer 的 `getNextVersion` 递增版本号;
4. 按通道分组全部写入; 对 DeltaChannel 的并发写入按任务 id 升序稳定重排, 与 checkpointer 重放顺序 (MemorySaver 与 Postgres `COLLATE "C"` 排序) 对齐 (algo.ts:352-366 注释);
5. 对每个通道调 `channel.update(vals)`; InvalidUpdateError 会被包一层通道名与写入值重新抛出 (algo.ts:382-394);
6. 更新成功的通道写入新 channel_versions 并计入 updatedChannels (不可用通道不计, 因为不会触发任务);
7. 若发生超步推进 (bumpStep), 未被更新的可用通道也要 `update([])` 感知新超步;
8. 若更新不再触发任何节点 (`triggersNextStep` 返回 false, 最后一个超步), 对所有通道调 `finish()`。

### 任务准备: _prepareNextTasks

`_prepareNextTasks` (algo.ts:576) 产出两类任务: PUSH (来自 TASKS 通道的 Send, 见第四节) 与 PULL (由通道版本变化触发的节点, `candidateNodes` 比较 channel_versions 与 versions_seen 差集)。`_prepareSingleTask` 生成确定性任务 id (uuid5, 以 checkpoint.id 为 namespace, 见 libs/checkpoint/src/id.ts:30), 使断点恢复后重建的任务 id 一致; 每个可执行任务是 `PregelExecutableTask` 结构 (pregel/types.ts:591-614): name、input、proc (Runnable)、writes 数组、config、triggers、retry_policy、cache_key、id、path、subgraphs、writers 与可选的每任务 timeout。

节点级 errorHandler 在重试策略耗尽后由 `_prepareNodeErrorHandlerTask` (algo.ts:1203) 生成处理器任务: 任务 id 包含失败任务 id 以保证恢复可重现, config 里注入 `CONFIG_KEY_NODE_ERROR` (NodeError 携带失败节点名与错误对象), 处理器节点可读取并返回状态更新或 Command 实现错误恢复路由; 保留写键 `ERROR_SOURCE_NODE = "__error_source_node__"` (constants.ts:21) 把失败来源落进 pending writes, 恢复后仍可见。

### 任务执行: PregelRunner.tick

`PregelRunner` 的 `tick` (pregel/runner.ts:123) 并发执行所有尚无 writes 的任务:

- `_executeTasksWithRetry` 按 maxConcurrency 限流, 应用 retryPolicy;
- 每个任务完成即 `_commit`;
- 错误分类处理: GraphInterrupt 聚合成一个 graphBubbleUp (合并 interrupts 数组); 其它 GraphBubbleUp 记录; 普通错误触发 `exceptionSignalController.abort()` 中止同超步其他任务并收集 (runner.ts:166-183 的大段注释解释了为什么忽略 abort 之后的次生错误);
- 被错误处理器接管的错误不进 abort 流程, 其失败溯源已检查点化;
- 单个错误原样抛出, 多个错误合成 `AggregateError`;
- 最后若存在 GraphInterrupt 则抛出, 由上层循环捕获落检查点; 子图冒泡的协作式 drain 同样向上传递。

### Durability、重试默认值与运行控制

`Durability = "exit" | "async" | "sync"` (pregel/types.ts:35), 控制检查点写入时机: 默认 `"async"`——下一个超步执行的同时异步保存检查点 (types.ts:351-354 文档注释 `@default "async"`); `"sync"` 在超步间同步等待落盘 (index.ts:2465); `"exit"` 只在运行结束时持久化。旧的 `checkpointDuring` 选项与 `durability` 互斥, 同时传会报错 (index.ts:1911-1914)。

`RetryPolicy` (pregel/utils/index.ts:56-94) 默认值: initialInterval 500ms、backoffFactor 2、maxInterval 128000ms、maxAttempts 3、jitter true, 另有 retryOn 谓词与 logWarning 开关。`CachePolicy` (pregel/utils/index.ts:100) 含 keyFunc 与 ttl (秒)。

运行期优雅停机由 `RunControl` 承担 (pregel/runtime.ts:42): 持有私有 drainReason, `requestDrain(reason = "shutdown")` 置位后, PregelLoop 在下一次超步边界把 status 置为 draining, 主循环抛出 `GraphDrained` (errors.ts:65, 注释明确检查点已保存、可稍后恢复)——这是 SIGTERM 场景下"保存现场再退场"的实现。

## 六、持久化体系: checkpoint、saver 与 Store

### Checkpoint 数据结构

定义在 libs/checkpoint/src/base.ts:18-46:

```ts
export interface Checkpoint<
  N extends string = string,
  C extends string = string,
> {
  /** The version of the checkpoint format. Currently 4 */
  v: number;
  /** Checkpoint ID {uuid6} */
  id: string;
  /** Timestamp {new Date().toISOString()} */
  ts: string;
  channel_values: Record<C, unknown>;
  channel_versions: Record<C, ChannelVersion>;
  versions_seen: Record<N, Record<C, ChannelVersion>>;
}
```

- v 当前为 4; id 用 `uuid6` (libs/checkpoint/src/id.ts:13, 时间有序), 任务级 id 用 uuid5;
- channel_values 存通道值, channel_versions 存各通道版本, versions_seen 记录每个节点看到过的通道版本——后两者是增量调度与时间旅行的依据;
- `CheckpointTuple` (base.ts:98-104) 是 saver 的统一返回单元: config、checkpoint、metadata、parentConfig、pendingWrites;
- 待写入记录 PendingWrite 形如 `[channel, value]`, CheckpointPendingWrite 前置 taskId (checkpoint/src/types.ts); 特殊通道键 ERROR、INTERRUPT、RESUME、SCHEDULED 定义在 checkpoint/src/serde/types.ts, `WRITES_IDX_MAP` 为其分配固定索引。

检查点元数据 `CheckpointMetadata` (checkpoint/src/types.ts:17) 是时间旅行语义的另一半:

| 字段         | 语义                                                                                                            |
| ------------ | --------------------------------------------------------------------------------------------------------------- |
| source       | 四值之一: input (来自 invoke/stream 输入)、loop (pregel 循环内)、update (手动状态更新)、fork (拷贝自另一检查点) |
| step         | 超步序号; 首个 input 检查点为 -1, 首个 loop 检查点为 0, 依次递增                                                |
| parents      | 命名空间到父检查点 id 的映射 (子图嵌套时各命名空间各记一条链)                                                   |
| delta 计数器 | Beta 字段: 每个 DeltaChannel 自上次快照以来的更新超步数与总超步数, 用于触发稀疏快照                             |

### BaseCheckpointSaver

抽象基类 (base.ts:113-275):

- `serde` 默认 `JsonPlusSerializer` (checkpoint/src/serde/jsonplus.ts:227), 支持 LangChain 对象的往返序列化 (loadsTyped/dumpsTyped);
- 子类须实现 `getTuple`、`list`、`put`、`putWrites` (以及 deleteThread);
- `getNextVersion` 默认整数加一 (base.ts:267-274), 子类可覆写为字符串版本 (此时必须保持单调递增);
- `toJSON` 返回类名字符串, 防止 checkpointer 混入 configurable 后被 JSON.stringify 深度遍历到后端客户端 (如 pg Pool 计时器);
- 另有 `compareChannelVersions`、`maxChannelVersion`、`getDeltaChannelHistory` 等工具支撑增量重放。

### 官方 saver 实现

| saver                          | 包                                       | 关键事实                                                                                                                                                                                                            |
| ------------------------------ | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MemorySaver                    | @langchain/langgraph-checkpoint          | checkpoint/src/memory.ts:104; 三层嵌套普通对象 thread_id 到 checkpoint_ns 到 checkpoint_id; 带原型污染防护                                                                                                          |
| SqliteSaver                    | @langchain/langgraph-checkpoint-sqlite   | checkpoint-sqlite/src/index.ts:90; 基于 better-sqlite3 的同步实现; `SqliteSaver.fromConnString(path)` 静态工厂同步返回 (index.ts:105)                                                                               |
| PostgresSaver                  | @langchain/langgraph-checkpoint-postgres | checkpoint-postgres/src/index.ts:84; 基于 pg Pool; `fromConnString` 支持 schema 选项 (默认 public); `setup()` 异步建表并跑 migration, 文档注释要求首次使用必须显式调用; 同包 store/index.ts:40 提供 `PostgresStore` |
| MongoDBSaver                   | @langchain/langgraph-checkpoint-mongodb  | checkpoint-mongodb/src/checkpoint.ts:64                                                                                                                                                                             |
| RedisSaver / ShallowRedisSaver | @langchain/langgraph-checkpoint-redis    | checkpoint-redis/src/index.ts:89 与 shallow.ts:86; 支持 standalone 与 cluster、可选 TTL (defaultTTL 分钟、refreshOnRead); Shallow 版每线程单键, 新检查点写入时清理旧的, 面向不需要历史的场景                        |

MemorySaver 值得单独展开: 它是所有 quickstart 与测试夹具的默认 saver, 因此 memory.ts 开头有一段针对原型污染的加固 (memory.ts:20-95): 显式拒绝 `__proto__`、`constructor`、`prototype` 作为 thread_id/checkpoint_ns (assertSafeStorageKey, 注释引 CWE-1321), 且所有嵌套存储对象用 null prototype 创建作为纵深防御。

SqliteSaver 的表结构 (checkpoint-sqlite/src/index.ts:113-140): `checkpoints` 表主键为 (thread_id, checkpoint_ns, checkpoint_id), checkpoint 与 metadata 以 BLOB 存储, 另记 parent_checkpoint_id 与 type; `writes` 表记录每个任务的每条写入 (task_id、idx、channel、type、value); 初始化时开启 WAL 日志模式。

checkpoint-validation 包 (libs/checkpoint-validation) 提供可复用的 saver 一致性测试夹具 (test_utils.ts 的 initialCheckpointTuple、parentAndChildCheckpointTuplesWithWrites、putTuples 等), checkpoint 格式约定 v 为 4 也在测试夹具中显式出现。

### Store: 跨线程长期记忆

`BaseStore` (checkpoint/src/store/base.ts:385) 定义命名空间化的键值存储: `put`/`get`/`delete`/`search`/`listNamespaces`, 底层通过抽象 `batch` 批处理操作。search 支持元数据过滤与语义检索 (base.ts:172 的 query 字段注释: 自然语言查询走向量相似度), `IndexConfig` (base.ts:290 附近) 配置嵌入与索引, 搜索结果带相关性分数。内存实现 `InMemoryStore` 在 checkpoint/src/store/memory.ts:49。图编译时经 `compile({ store })` 注入, 节点内可用 `getStore()` (pregel/utils/config.ts) 读取。

缓存侧另有 `BaseCache` (checkpoint/src/cache/base.ts:7) 与内存实现, 配合节点 CachePolicy (ttl、keyFunc) 使用; 循环内 `AsyncBatchedCache` (pregel/loop.ts:240) 把同超步的查询批量化。

## 七、Threads、状态快照与时间旅行

LangGraph 的会话概念是 thread: 运行配置里的 `thread_id` 标识线程, `checkpoint_ns` 标识 (子图) 命名空间, `checkpoint_id` 定位某个超步检查点; 命名空间分隔符与结束符为 `"|"` 与 `":"` (constants.ts:135-136), 子图的 checkpoint_ns 由父命名空间拼接而成。`checkpoint_map` 是公开配置键 (constants.ts:78)。

`StateSnapshot` (pregel/types.ts:616) 是对外状态视图, 含 values、next (下一批待执行节点)、config、metadata、tasks (含子图状态与错误)。三个核心方法都在 Pregel 上 (CompiledStateGraph 继承):

- `getState(config, options?)` (pregel/index.ts:1057): 要求 checkpointer, 否则抛 `GraphValueError` 且带错误码 MISSING_CHECKPOINTER; 若 config 指向子图命名空间, 先遍历 `getSubgraphsAsync` 委托给对应子图; 未指定 checkpoint_id 时 `applyPendingWrites` 为 true, 快照会应用未决写入; 对动态创建的瞬态子图 (如工具调用子图 `tools:call_...`) 有回退路径, 直接按完整 checkpoint_ns 查 checkpointer (index.ts:1091-1095 注释)。
- `getStateHistory(config, options?)` (index.ts:1121): 异步迭代器, 对 `checkpointer.list(mergedConfig, options)` 的每个 CheckpointTuple 构造快照; options 支持 limit、before、filter。
- `updateState(inputConfig, values, asNode?)` (index.ts:1804): 委托给 `bulkUpdateState` (index.ts:1194), 后者接受多个超步、每超步多个更新 (values + asNode); asNode 把更新归属到指定节点, 使后续调度如同该节点刚产生这些写入; 注释明确用途包括 human-in-the-loop、断点期间改状态、注入外部输入。无法归属到任何节点的更新抛 InvalidUpdateError。

快照构造由 `_prepareStateSnapshot` (index.ts:868 附近) 完成: 从检查点重建全部通道 (`channelsFromCheckpoint`, channels/base.ts:306), DeltaChannel 经 checkpointer 从祖先写入重建; 恢复时先应用 NULL_TASK_ID 的空写入, 再跳过 ERROR/INTERRUPT/SCHEDULED 保留键, 把已完成任务的写入回填到对应任务 (index.ts:1330-1360)。

时间旅行即: 用 `getStateHistory` 取回某个历史 config (含 checkpoint_id), 以该 config 重新 invoke/stream 即从历史点分叉重放; 仓库用专门测试覆盖 (libs/langgraph-core/src/tests/time_travel.test.ts、time_travel_extended.test.ts)。恢复中断运行则以 `Command({ resume })` 作为输入 (见下节)。RemoteGraph 与 SDK 的 `threads.updateState` (POST /threads/:id/state, libs/sdk/src/client/threads/index.ts:319) 是同一语义的远程版本。

## 八、Human-in-the-loop: interrupt 与 Command

### interrupt() 函数

`interrupt` 定义在 libs/langgraph-core/src/interrupt.ts:88, 签名 `interrupt<I, R>(value, options?)`, 在节点内同步返回恢复值。机制 (interrupt.ts:92-158):

1. 通过 AsyncLocalStorage 从 @langchain/core 取当前运行 config, 图外调用直接抛错;
2. 无 checkpointer 时抛 `GraphValueError`, 错误码 MISSING_CHECKPOINTER——interrupt 强依赖持久化;
3. 每个任务的 scratchpad (CONFIG_KEY_SCRATCHPAD) 维护 interruptCounter, 支持一个节点内多个 interrupt 依序对应;
4. 若 scratchpad.resume 里已有本次重放可用的恢复值 (idx 在范围内), 直接解析返回, 并把已消费的 resume 前缀写回 RESUME 通道持久化——注释强调只持久化到被消费的位置, 后面属于更晚 interrupt 的值不能提前固化, 否则校验失败后的重试无法覆盖 (interrupt.ts:122-131);
5. 若有 nullResume (首次恢复), 校验长度后消费并返回;
6. 否则构造挂起对象并抛出:

```ts
const id = ns ? XXH3(ns.join(CHECKPOINT_NAMESPACE_SEPARATOR)) : undefined;
const pending: Interrupt<I> = { id, value };
if (schema !== undefined) {
  pending.response_schema = toJsonSchema(schema);
}
throw new GraphInterrupt([pending]);
```

id 由检查点命名空间的 XXH3 哈希派生 (hash.ts), 子图内的 interrupt 有稳定身份。`options.responseSchema` 接受 zod schema, 经 `toJsonSchema` 转成 JSON Schema 附在 interrupt 上, 恢复值会用 `interopParse` 校验 (interrupt.ts:110-114), 不合法则抛 ZodError。`Interrupt` 类型本身 (constants.ts:407) 即 id、value、response_schema 三字段。

### 异常族与冒泡

errors.ts 定义错误基类 `BaseLangGraphError`, 支持 `lc_error_code` 并自动附排障 URL (docs.langchain.com 的 oss/javascript/langgraph/ 路径); `BaseLangGraphErrorFields` 枚举了 GRAPH_RECURSION_LIMIT、INVALID_CONCURRENT_GRAPH_UPDATE、INVALID_GRAPH_NODE_RETURN_VALUE、MISSING_CHECKPOINTER、MULTIPLE_SUBGRAPHS、UNREACHABLE_NODE 六个错误码。控制流异常继承自 `GraphBubbleUp` (errors.ts:30):

| 类型           | 位置          | 用途                                                                          |
| -------------- | ------------- | ----------------------------------------------------------------------------- |
| GraphInterrupt | errors.ts:85  | 携带 interrupts 数组向上冒泡, 触发落检查点                                    |
| NodeInterrupt  | errors.ts:100 | 节点内直接 `new NodeInterrupt(message)` 的便捷形态                            |
| ParentCommand  | errors.ts:164 | 子图节点返回指向父图的 Command 时的载体                                       |
| GraphDrained   | errors.ts:65  | RunControl.requestDrain (如 SIGTERM) 引发的协作式排空, 检查点已保存可稍后恢复 |

ToolNode 默认 `handleToolErrors = true` 会把工具异常转成 error ToolMessage 喂回模型, 但对 GraphInterrupt 例外——注释说明 interrupt 是人机断点而非可恢复错误, 即使开了错误处理也要重新抛出 (prebuilt/tool_node.ts:266-271)。

### 恢复与静态断点

恢复路径: 以 `new Command({ resume: value })` 作为图输入再次 invoke/stream, 值进入 RESUME 通道 (`"__resume__"`, constants.ts:87), 重放时经 scratchpad.resume 命中上文第 4 步直接返回; 多 interrupt 场景按顺序逐个恢复。`isInterrupted` 守卫 (constants.ts:433) 判断输出对象是否含 `INTERRUPT = "__interrupt__"` 键; invoke 的 values 模式会把 interrupts 合并进最终返回值 (index.ts:2589-2596), 因此即使不消费流也能拿到中断信息。

静态断点在编译期声明: `compile({ interruptBefore, interruptAfter })`, 支持节点名数组或 All (即 `"*"`); 运行期 PregelLoop 在对应节点执行前把 status 置为 interrupt_before 并抛 GraphInterrupt (loop.ts:970-972)。prebuilt/interrupt.ts 还定义了面向 agent 收件箱的结构化中断协议: `HumanInterruptConfig` (allow_ignore/allow_respond/allow_edit/allow_accept 四个布尔位)、`ActionRequest`、`HumanInterrupt` 与 `HumanResponse`, 配套 requestApprovalTool、reviewActionTool 等工具使用。

## 九、流式输出

### 流模式

`StreamMode` 是八种模式的联合 (pregel/types.ts:25-33):

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

- values: 每个超步后的完整状态;
- updates: 每个节点写入的增量;
- messages: LLM token 级消息流 (与 @langchain/core 的消息回调对接);
- checkpoints / tasks: 检查点元信息与任务生命周期事件 (types.ts 内 StreamCheckpointsOutput、StreamTasksOutputBase 定义载荷形状);
- custom: 节点内 `writer()` 推送的自定义负载;
- debug: 详细调试事件;
- tools: 工具调用生命周期 (pregel/stream.ts 的 ToolRunInfo 与回调处理器)。

stream 调用可传 StreamMode 数组同时订阅多路, 返回类型由 `StreamOutputMap` 按模式映射。默认值: CompiledGraph 构造时 `streamMode: "values"` (graph/graph.ts:576), stream 未显式指定时用该值; invoke 固定 values; functional API 的 entrypoint 则固定 `"updates"` (func/index.ts:384)。types.ts:106 的类型级 `DefaultStreamMode = "updates"` 用于无显式泛型时的返回类型推断。

### 流管道内部

流的基本单元是 `StreamChunk = [string[], StreamMode, unknown]` 三元组 (pregel/stream.ts:31), 即命名空间、模式、载荷; 子图流通过命名空间前缀区分, `subgraphs: true` 时携带嵌套命名空间。PregelLoop 持有 stream 发射器, `_outputWrites` 把任务写入转成 updates/values 输出, values 模式先持久化检查点再发射 (loop.ts:1019 附近注释: persist the new checkpoint BEFORE emitting values)。

自定义流用模块级 `writer(chunk)` 函数 (libs/langgraph-core/src/writer.ts): 从 AsyncLocalStorage 拿 config 再调 `conf.writer`; 配套 `getWriter`、`getStore`、`getConfig`、`getCurrentTaskInput` 都在 pregel/utils/config.ts 导出。graph/message.ts 还提供 `pushMessage` 辅助。

协议层类型在 libs/langgraph-core/src/stream/types.ts: `Namespace` 即字符串数组; `ProtocolMethod` 为 StreamMode 加 lifecycle、input 及任意扩展方法; `ProtocolEvent` 是事件信封; `StreamTransformer` (types.ts:145) 定义投影转换器接口, 编译期 transformers 与调用点 transformers 合并生效; `ChatModelStream`/`ToolCallStream`/`InterruptPayload` 支撑 messages 与 tools 模式的结构化载荷。stream/ 目录还有 convert、mux (多路复用)、run-stream、stream-channel、subscription 等实现模块。

### 事件流与 SSE

`stream` 支持 `encoding: "text/event-stream"`, 经 `toEventStream` 把 chunk 转成 SSE 字节流 (pregel/index.ts:2033-2038)。另有 `#streamEventsV3` (index.ts:2042): 以 STREAM_EVENTS_V3_MODES 加 subgraphs 全开取源流, 经 `createGraphRunStream` 与用户/编译期 transformers 合成 `GraphRunStream`, text/event-stream 编码时再经 `protocolEventsToEventStream` 输出协议化事件——这是 langgraph-api 服务器向前端推流的底座。

AbortController 语义: stream 内部建独立 abortController 并与调用方 signal 合并 (`combineAbortSignals`), 返回 `IterableReadableStreamWithAbortSignal`; sdk 侧的 `IterableReadableStream` (libs/sdk/src/utils/stream.ts:353) 扩展 ReadableStream 提供 async iterator 语义, 并在 return/throw 时正确释放 reader 锁。

## 十、Functional API: entrypoint 与 task

libs/langgraph-core/src/func/index.ts 提供与 StateGraph 等价的函数式入口, 产物同样是 Pregel 实例。

`task` (func/index.ts:115) 包装一个纯函数为可检查点化的子任务:

```ts
export function task<ArgsT extends unknown[], OutputT>(
  optionsOrName: TaskOptions | string,
  func: TaskFunc<ArgsT, OutputT>
): (...args: ArgsT) => Promise<OutputT> {
```

选项含 name、retry、cachePolicy、timeout; 生成器函数被禁止 (抛错提示流式响应改用 config.write); cachePolicy 为 true 时等价空策略对象, 并兼容 v0.3.x 误用 `cache` 别名 (func/index.ts:137-148 注释, 标注 1.x 移除)。调用时走 `call` (pregel/call.ts:62): 从 AsyncLocalStorage 取 `CONFIG_KEY_CALL` 注入的调度函数, 把 (func, name, args, 策略与 callbacks) 交给 Pregel 作为 PUSH 任务执行——这解释了为什么 task 必须在图运行期内调用。`getRunnableForFunc` (call.ts:17) 把任务结果写入保留通道 `RETURN = "__return__"` (constants.ts:91)。

`entrypoint` (func/index.ts:368) 把整个工作流定义为单节点图: 内部构造 PregelNode (triggers 与 channels 均为 START), 三个通道固定为 START 挂 EphemeralValue、END 挂 LastValue、PREVIOUS 挂 LastValue (func/index.ts:431-451); streamMode 固定 updates。返回值处理有两个专用 Runnable: `pluckReturnValue` 与 `pluckSaveValue` 分别解包 `entrypoint.final({ value, save })`——final 允许返回值与持久化状态分离 (func/index.ts:462-470 与 EntrypointFunction 接口文档)。跨次运行读取上次保存的状态用 `getPreviousState` (func/index.ts 导出, web.ts 再导出), 其值来自 PREVIOUS 通道 (`"__previous__"`, constants.ts:93)。

Pregel 类头文档给出了官方案例 (pregel/index.ts:417-440): 用 `task("add", async (x) => x + 1)` 与 `entrypoint({ name: "workflow", checkpointer: new MemorySaver() }, ...)`, 在 entrypoint 内 `Promise.all` 并行调用多个 task——functional API 的并行、检查点与重试全部复用第五节的 Pregel 机制。

## 十一、Prebuilt 与多 agent 套件

### createReactAgent 与其迁移状态

prebuilt/ 目录的导出面 (prebuilt/index.ts): createAgentExecutor、createFunctionCallingExecutor、createReactAgent、createReactAgentAnnotation、ToolExecutor、ToolNode、toolsCondition、HumanInterrupt 系列类型、withAgentName。

重要事实: `createReactAgent` 已标记 deprecated, jsdoc 明确迁移指引 (react_agent_executor.ts:624-626):

> `createReactAgent` has been moved to the `langchain` package. Update your import to `import { createAgent } from "langchain";`

`CreateReactAgentParams` (react_agent_executor.ts:485) 同样标注迁往 langchain 包改名 CreateAgentParams。当前仓库内实现的参数面:

| 参数                             | 说明                                                                                                         |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| llm                              | LanguageModelLike, 或接收 (state, runtime) 返回模型的函数 (动态模型选择)                                     |
| tools                            | ToolNode 实例或工具数组                                                                                      |
| prompt                           | 字符串 (转 SystemMessage 前置)、SystemMessage、函数或 Runnable; messageModifier/stateModifier 已废弃         |
| stateSchema / contextSchema      | 附加状态 schema / 运行时 context schema (均支持 Annotation 或 zod 对象)                                      |
| checkpointSaver / checkpointer   | 二者等价别名                                                                                                 |
| interruptBefore / interruptAfter | 透传编译选项                                                                                                 |
| store                            | BaseStore                                                                                                    |
| responseFormat                   | zod / JSON Schema / 含 prompt 的对象; 结束后额外一次结构化输出调用, 结果写入 structuredResponse 状态键       |
| preModelHook / postModelHook     | 调模型前后节点, 用于裁剪历史、护栏、人工审核等                                                               |
| version                          | v1: 工具节点一次处理整条消息内全部 tool call (节点内并行); v2: 每个 tool call 经 Send 拆到独立 ToolNode 实例 |
| includeAgentName                 | undefined 或 "inline", 控制向 supervisor 模型暴露 agent 名的方式                                             |
| name / description               | 供 supervisor 场景描述子 agent                                                                               |

默认状态由 `createReactAgentAnnotation` (react_agent_executor.ts:437) 定义: messages 用 messagesStateReducer 加空数组默认值, 外加 structuredResponse 键。图的骨架: agent 节点 (callModel, react_agent_executor.ts:829) 与 tools 节点 (ToolNode) 之间用条件边循环, 直到无 tool_calls; 静态模型管线会被缓存 (`_getStaticModel`, react_agent_executor.ts:722), prompt Runnable 与模型 pipe 组合, returnDirect 的工具会进入 `shouldReturnDirect` 集合参与路由判断。

### ToolNode 与 toolsCondition

`ToolNode` (prebuilt/tool_node.ts:210) 继承 RunnableCallable: 输入接受 BaseMessage 数组、含 messages 的状态对象或 Send 单工具调用输入 (内部 `lg_tool_call` 路由键, 执行前剥离使工具只见到状态); 从最后一条 AIMessage 提取 tool_calls, 跳过已有对应 ToolMessage 的 id, `Promise.all` 并行执行 (tool_node.ts:307-330); 每个工具经 `runTool` 调用, 工具返回 Command 或 ToolMessage 直通, 其它返回值包成 success ToolMessage; handleToolErrors 默认 true, 工具运行时上下文 ToolRuntime 携带 state、toolCallId、config、context、store、writer。`toolsCondition` (tool_node.ts:416) 是标准路由谓词: 最后一条消息有 tool_calls 返回字符串 "tools", 否则返回 END。

### 多 agent 包

- @langchain/langgraph-supervisor: `createSupervisor` 与 OutputMode (supervisor.ts:421 导出), 基于 createReactAgent 组合子 agent;
- @langchain/langgraph-swarm: `createSwarm`、`addActiveAgentRouter`、`SwarmState` (swarm.ts:162), 带活跃 agent 记忆的群体协作, handoff 逻辑复用 ToolNode 与 Command;
- @langchain/langgraph-cua: computer use agent, 节点含 call-model 与 take-computer-action (libs/langgraph-cua/src/nodes/)。

## 十二、图内省、RemoteGraph、SDK 与前端集成

### 图结构与可视化

编译后的图支持内省: `getGraph(config)` 返回可绘制的图结构 (DrawableGraph, 来自 @langchain/core/runnables/graph, pregel/types.ts:11 导入), `getGraphAsync` (pregel/index.ts:777) 是其异步版本且注释标注为推荐用法; RemoteGraph 上同步 getGraph 已标 deprecated (pregel/remote.ts:873 附近)。这是 IDE/平台渲染图拓扑的数据源。`getSubgraphs`/`getSubgraphsAsync` 枚举子图实例, 支撑 getState 的子图委托。

### RemoteGraph

`RemoteGraph` (libs/langgraph-core/src/pregel/remote.ts:196) 把远端 LangGraph Platform 上的图包装成本地 PregelInterface: invoke/stream/streamEvents 走 HTTP, `getState`/`getStateHistory`/`updateState` 分别映射到 threads 的 state/history/state 端点 (remote.ts:798-871); getStateHistory 默认 limit 10 (remote.ts:821); 远端检查点键经 `_getCheckpoint` 从 configurable 提取 thread_id/checkpoint_ns/checkpoint_id/checkpoint_map 四件套 (remote.ts:411-430)。它与本地图可以互相嵌套 (本地子图指向远端, 或远端图作为本地节点)。

### SDK

@langchain/langgraph-sdk (libs/sdk) 的 `Client` 类在 libs/sdk/src/client/index.ts:10, 按资源域拆分 assistants、threads、runs、crons、store 等子客户端; `threads.updateState` 以 POST /threads/:id/state 提交 values/checkpoint/as_node (client/threads/index.ts:319-342)。子路径导出覆盖 ui、client、auth、react、logging、react-ui、stream。流式客户端核心是 `StreamController` (libs/sdk/src/stream/controller.ts:214): 负责 SSE 解析、interrupt 收集 (`collectActiveInterruptsFromTasks`、`#recordInterrupt`) 与断线/取消后的状态对账 (`#reconcilePendingInterruptsFromServer`)——本次 HEAD 提交 (#2882) 修复的正是取消 run 后流缓冲与服务端状态的对账问题。schema.ts 定义 ThreadState、Interrupt、Config 等协议类型。

### 前端框架集成

@langchain/react 的核心是 `useStream` hook (libs/sdk-react/src/use-stream.ts:461), 配套 context、selectors、suspense-stream 与 use-audio-player/use-video-player/use-media-url/use-projection 等媒体辅助 hook; @langchain/angular、@langchain/svelte、@langchain/vue 结构对等。@langchain/langgraph-ui 与 sdk 的 ./ui、./react-ui 导出提供平台 UI 组件; libs/sdk/src/ui/orchestrator.ts 的 StreamOrchestrator 统一 values/interrupts/error/loading 状态供 UI 消费, headless-tools.ts 处理无头工具中断的过滤与识别。

## 十三、本地平台栈: langgraph-api 与 langgraph-cli

@langchain/langgraph-api 的 README 首句是 "In-memory implementation of the LangGraph.js API"——它是 LangGraph Platform API 的进程内实现。技术栈为 hono + @hono/node-server + @hono/node-ws (websocket) + @hono/zod-validator, 依赖 superjson、tsx、@typescript/vfs (源码内联加载图定义)。src/ 下 api/ 按资源分 runs、threads、assistants、store 路由 (server.mts 顶部 import), storage/ 定义运行期存储抽象 (其 storage/checkpoint.mts 的 InMemorySaver 直接继承 checkpoint 包的 MemorySaver 并加 initialize/copy 等平台行为), experimental/embed 提供进程内嵌入调用, loopback.mts 提供进程内 fetch 绑定 (getLoopbackFetch/bindLoopbackFetch)。graph/parser/ 下有类型模板, 为编译图反射出 state/update/input/output/config 类型。

@langchain/langgraph-cli 提供 bin `langgraphjs` (dist/cli/cli.mjs), 基于 commander, 命令集合来自 src/cli/ 下的模块注册 (cli.mts 逐一 import):

| 命令                                      | 定义文件        | 说明                                   |
| ----------------------------------------- | --------------- | -------------------------------------- |
| dev                                       | cli/dev.mts     | 本地开发服务器                         |
| build                                     | cli/build.mts   | 构建 LangGraph API server Docker 镜像  |
| up                                        | cli/up.mts      | 启动 LangGraph API server              |
| dockerfile                                | cli/docker.mts  | 生成 Dockerfile                        |
| new                                       | cli/new.mts     | 创建新 LangGraph 项目                  |
| deploy / list / revisions / logs / delete | cli/deploy.mts  | LangSmith Deployments 管理 (标注 Beta) |
| sysinfo                                   | cli/sysinfo.mts | 环境诊断                               |

CLI 依赖含 create-langgraph、chokidar (热重载)、execa、open、langsmith、stacktrace-parser 等。仓库另有 .devcontainer 与 int-test-deps-docker-compose.yml 支撑开发环境与集成测试依赖。

## 十四、与 LangChain 的依赖关系

依赖形态: @langchain/langgraph 对 @langchain/core 是 peerDependency (^1.1.48, libs/langgraph-core/package.json), 不是直接依赖——使用者显式安装 core, 版本冲突在明面。代码层面对 core 的借用集中在:

- Runnable/RunnableConfig/RunnableSequence/RunnableBinding (@langchain/core/runnables): Pregel 继承 Runnable, PregelNode 继承 RunnableBinding, 节点与条件边接受 RunnableLike;
- AsyncLocalStorageProviderSingleton (@langchain/core/singletons): interrupt、writer、call 全靠它取运行上下文;
- BaseMessage/AIMessage/ToolMessage/RemoveMessage (@langchain/core/messages): 消息状态与 ToolNode 的数据模型;
- 工具类型 StructuredToolInterface/DynamicTool: ToolNode 的工具面;
- toJsonSchema 与 interop zod 工具 (@langchain/core/utils): interrupt responseSchema、zod schema 状态定义与结构化输出共用同一套互操作层。

README 明确立场: LangGraph 由 LangChain Inc 构建但可脱离 LangChain 使用; LangChain 提供模型集成与组件, LangGraph 只管编排。更高层的 Deep Agents 构建在 LangGraph 之上 (README TIP 区块)。monorepo 内通过 pnpm.overrides 统一 @langchain/core 与 zod 版本, checkpoint 各后端包的 peer 约束 (^1.1.44 起) 与主包 (^1.1.48 起) 略有差异, 以主包为准。

## 十五、工程治理与测试组织

贡献流程 (CONTRIBUTING.md): fork + PR, 不鼓励直推; 新抽象必须先开 issue 讨论, 原则是 JS 与 Python 两个版本保持同一套核心 API; 发布走 changesets (根 scripts 的 changeset/release, .changeset/ 目录)。根 AGENTS.md 内容精简, 要求在有 Corridor analyzePlan 工具时先做安全分析再改代码。

代码质量工具链: oxlint (.oxlintrc.jsonc) + oxfmt (.oxfmtrc.jsonc) 替代传统 ESLint/Prettier (仓库仍保留 eslint-plugin-no-instanceof 作为开发依赖, 源码中可见大量 `// eslint-disable-next-line no-instanceof/no-instanceof` 针对跨包 instanceof 的刻意放行), lint-staged 在提交时跑 lint 与 format; TypeScript 允许 4.9.5 或 5.4.5 以上两档。

测试组织:

- 单元测试与源码同目录 (*.test.ts), 覆盖 pregel 算法 (algo.test.ts)、通道、write/read、runner、stream、messages reducer、interrupt 等;
- libs/langgraph-core/src/tests/ 下按主题分目录, 含 python_port/ (与 Python 版行为对齐的移植测试: checkpoint、graph_structure 等)、prebuilt、interrupt.test-d.ts (类型级断言)、pregel.test-d.ts、time_travel 系列;
- internal/environment_tests/ 用 Docker 验证三种消费环境下的导出面 (test-exports-tsc、test-exports-cjs、test-exports-cf 即 Cloudflare Workers), 根 scripts 的 test:exports:docker 驱动;
- 集成测试经 `pnpm test:int` 起 docker compose 依赖 (Postgres、Redis、MongoDB) 再跑 turbo test:int;
- socket.yml 表明仓库接入 Socket 供应链安全检查。

可观测性: LangSmith 作为官方调试/评测配套出现在 README; 保留标签 `TAG_HIDDEN = "langsmith:hidden"` 与 TAG_NOSTREAM 供追踪过滤 (constants.ts:97-98); 图与节点可带 name/description 供追踪面板展示。

## 附: 关键源码索引

| 主题                | 路径 (相对仓库根)                                                                                                                                                                                           |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pregel 类与主循环   | libs/langgraph-core/src/pregel/index.ts (Pregel:445, stream:1962, invoke:2558, _runLoop:2603, getState:1057, getStateHistory:1121, bulkUpdateState:1194, updateState:1804, getGraphAsync:777)               |
| 超步循环            | libs/langgraph-core/src/pregel/loop.ts (PregelLoop:292, tick:958, AsyncBatchedCache:240)                                                                                                                    |
| 调度与写回          | libs/langgraph-core/src/pregel/algo.ts (_applyWrites:269, _prepareNextTasks:576, _prepareNodeErrorHandlerTask:1203, _procInput:1360)                                                                        |
| 并发执行            | libs/langgraph-core/src/pregel/runner.ts (PregelRunner.tick:123)                                                                                                                                            |
| 节点与 IO           | libs/langgraph-core/src/pregel/read.ts (PregelNode:104), pregel/io.ts (mapCommand:71, mapInput:138, mapOutputValues:168, mapOutputUpdates:202)                                                              |
| 运行控制            | libs/langgraph-core/src/pregel/runtime.ts (RunControl:42)                                                                                                                                                   |
| 图构建              | libs/langgraph-core/src/graph/graph.ts (addConditionalEdges:453, compile:521), graph/state.ts (addNode:933, addEdge:1241, compile:1394, CompiledStateGraph:1689)                                            |
| Annotation 与通道   | libs/langgraph-core/src/graph/annotation.ts (Annotation:158, getChannel:174), channels/base.ts (BaseChannel:30), channels/ 全目录                                                                           |
| 消息模型            | libs/langgraph-core/src/graph/messages_annotation.ts:44, messages_reducer.ts (messagesStateReducer:60, messagesDeltaReducer:164)                                                                            |
| 常量与 Command/Send | libs/langgraph-core/src/constants.ts (START/END:9-11, Interrupt:407, isInterrupted:433, Send:251, Command:546)                                                                                              |
| interrupt           | libs/langgraph-core/src/interrupt.ts:88                                                                                                                                                                     |
| 错误族              | libs/langgraph-core/src/errors.ts (GraphBubbleUp:30, GraphInterrupt:85, GraphDrained:65, ParentCommand:164)                                                                                                 |
| Functional API      | libs/langgraph-core/src/func/index.ts (task:115, entrypoint:368), pregel/call.ts (call:62)                                                                                                                  |
| prebuilt            | libs/langgraph-core/src/prebuilt/react_agent_executor.ts (createReactAgent:669, CreateReactAgentParams:485), tool_node.ts (ToolNode:210, toolsCondition:416)                                                |
| checkpoint 基座     | libs/checkpoint/src/base.ts (Checkpoint:18, CheckpointTuple:98, BaseCheckpointSaver:113), types.ts (CheckpointMetadata:17), id.ts (uuid6:13, uuid5:30), memory.ts (MemorySaver:104), serde/jsonplus.ts:227  |
| saver 后端          | libs/checkpoint-sqlite/src/index.ts:90, libs/checkpoint-postgres/src/index.ts:84 与 store/index.ts:40, libs/checkpoint-mongodb/src/checkpoint.ts:64, libs/checkpoint-redis/src/index.ts:89 与 shallow.ts:86 |
| Store               | libs/checkpoint/src/store/base.ts (BaseStore:385), store/memory.ts (InMemoryStore:49)                                                                                                                       |
| 流协议              | libs/langgraph-core/src/stream/types.ts (StreamTransformer:145), pregel/stream.ts (StreamChunk:31)                                                                                                          |
| 远程图              | libs/langgraph-core/src/pregel/remote.ts (RemoteGraph:196)                                                                                                                                                  |
| SDK                 | libs/sdk/src/client/index.ts (Client:10), stream/controller.ts (StreamController:214), utils/stream.ts (IterableReadableStream:353)                                                                         |
| 前端 hook           | libs/sdk-react/src/use-stream.ts:461                                                                                                                                                                        |
