---
title: "LangChain.js 调研: 1.x Monorepo、Runnable 内核与 createAgent 中间件体系"
description: "基于本机克隆 bc4466b22 梳理 LangChain.js 的 monorepo 结构、langchain-core 核心抽象、32 个 provider 集成、createAgent 中间件体系与构建测试设施"
---

仓库路径: https://github.com/langchain-ai/langchainjs (本机克隆位于 $HOME/Downloads/langchainjs)

## 一、项目快照 (本机克隆 2026-10-02 00:11 同步)

| 指标            | 数值                                                                                                                                                                                                                                            |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HEAD            | bc4466b22 (完整哈希 bc4466b222cac78b701fc006af1433f8d5f73569), 提交时间 2026-10-01 15:11 +0100, 提交信息 `chore: version packages (#11788)`                                                                                                     |
| 分支            | main, 与 origin/main 一致; remote 为 git@github.com:langchain-ai/langchainjs.git                                                                                                                                                                |
| 定位            | README 自称 "The agent engineering platform", 一个用于构建 LLM 应用的 TypeScript 框架                                                                                                                                                           |
| 核心包版本      | @langchain/core 1.2.14、langchain 1.5.15、@langchain/classic 1.0.52、@langchain/mcp-adapters 2.0.0、@langchain/textsplitters 1.0.2                                                                                                              |
| License         | MIT (根 LICENSE 与各 libs 包 package.json 的 license 字段)                                                                                                                                                                                      |
| 运行时要求      | 各包 package.json 的 engines 均为 node >= 20 (mcp-adapters 为 >= 20.10.0); README 列明支持 Node.js 20.x/22.x/24.x (ESM 与 CommonJS)、Cloudflare Workers、Vercel/Next.js (Browser、Serverless、Edge)、Supabase Edge Functions、浏览器、Deno、Bun |
| Monorepo 工具链 | pnpm 10.14.0 (packageManager 字段) + Turborepo ^2.10.12 + TypeScript ^7.0.2 + tsdown ^0.22.14 + oxlint ^1.80.0 / oxfmt ^0.65.0 + Changesets @changesets/cli ^3.0.0                                                                              |
| 测试            | langchain-core 使用 vitest ^4.1.11 (scripts.test 为 `vitest run`); 根 devDependencies 另有 @types/jest ^30.0.0, standard-tests 的 README 示例用 @jest/globals                                                                                   |
| Workspace 声明  | pnpm-workspace.yaml: libs/_、libs/providers/_、examples、internal/*                                                                                                                                                                             |

HEAD 之前的近期实质改动: 56a7f0b19 (#11767) 准备 @langchain/mcp-adapters 2.0.0 发布 (MCP SDK 2 迁移、README 与导出面重构), 417ddcf50 (#11749 version packages) 消费 changesets 正式发布 11 个包的新版本 (含 mcp-adapters 2.0.0 与 @langchain/core 1.2.14、@langchain/openai 1.6.1), bbed27359 (#11771) 给 ModelProfile 增加 fileMimeTypes 字段并在 @langchain/openai 侧填充, 41098120e (#11707) 让 anthropic 与 openai 支持 SystemMessage 上的工具变更块, 63ca83e58 (#11786) 是 dependabot 的 hono 升版。HEAD bc4466b22 (#11788 version packages) 是纯版本发布, 无 API 面变化: 消费 #11707 留下的 changesets, 发布 @langchain/openai 1.6.2 与 @langchain/anthropic 1.5.12 (携带 #11707 的发布说明), 以及 "Updated dependencies" 连带发布的 @langchain/classic 1.0.52、@langchain/deepseek 1.1.17、@langchain/fireworks 0.2.17、@langchain/openrouter 0.4.17、@langchain/together-ai 0.2.17、@langchain/xai 1.4.17、@langchain/neo4j 0.1.24; 消费后 .changeset/ 目录只剩 config.json 与 README.md。下面 2.2 与 2.3 的版本表均为 #11788 发布后的当前版本。

README 的生态位表述值得原样记录: LangChain.js 是主框架; Deep Agents 是构建在它之上的高层 agent 包 (规划、子 agent、文件系统); LangGraph.js 是低层 agent 编排与可控工作流框架, 用于需要更高级定制的场景; LangSmith 是配套的开发者平台 (调试、评测、可观测)。Python 侧对应仓库为 langchain-ai/langchain。

本仓库的 docs/core_docs/README.md 只有一句话: 文档已经迁移到 docs.langchain.com (源码仓库 langchain-ai/docs), 仓库内不再维护大篇幅文档。

## 二、Monorepo 结构与包清单

### 2.1 顶层目录

| 目录                              | 职责                                                                              |
| --------------------------------- | --------------------------------------------------------------------------------- |
| libs/langchain-core               | 核心抽象 @langchain/core, 所有包的地基                                            |
| libs/langchain                    | 主包 langchain, createAgent 与中间件所在                                          |
| libs/langchain-classic            | @langchain/classic, v0.x 遗留抽象的收容包                                         |
| libs/langchain-textsplitters      | 文本切分包                                                                        |
| libs/langchain-mcp-adapters       | MCP (Model Context Protocol) 适配器                                               |
| libs/create-langchain-integration | 脚手架包 create-langchain-integration 0.0.12, 用于创建第三方集成项目              |
| libs/providers                    | 32 个一方集成包 (模型、向量库、搜索工具等)                                        |
| internal                          | 非发布或内部工具包: build、tsconfig、standard-tests、model-profiles、test-helpers |
| examples                          | private 示例包 (examples 0.0.0), 按主题组织                                       |
| environment_tests                 | 跨环境导出兼容性测试 (Docker)                                                     |
| dependency_range_tests            | 依赖版本区间测试 (Docker)                                                         |
| docs                              | 仅剩 core_docs/README.md 一个指路文件                                             |

根目录还有 turbo.json、deno.json、.oxlintrc.jsonc、.oxfmtrc.jsonc、pnpm-lock.yaml。注意仓库 AGENTS.md 写的是 `.oxlintrc.json`, 实际文件名是 `.oxlintrc.jsonc`; AGENTS.md 还把 standard-tests 的路径写成 libs/langchain-standard-tests, 实际在 internal/standard-tests, 两处均与代码事实不符。

### 2.2 核心包

| 包                           | 版本   | package.json 描述                                      | 要点                                                                                                                                          |
| ---------------------------- | ------ | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| @langchain/core              | 1.2.14 | (无 description)                                       | Runnable/LCEL、消息、工具、提示词、回调、输出解析等全部核心抽象                                                                               |
| langchain                    | 1.5.15 | (无 description)                                       | createAgent、initChatModel、middleware、hub、storage                                                                                          |
| @langchain/classic           | 1.0.52 | Old abstractions from LangChain.js                     | v1.0 从主包拆出的 0.x 代码: 旧式 chains、agents、memory、retrievers 等                                                                        |
| @langchain/mcp-adapters      | 2.0.0  | LangChain.js adapters for Model Context Protocol (MCP) | 依赖 @modelcontextprotocol/client 与 core ^2.2.0、zod ^4.4.3; peer 依赖 @langchain/core ^1.2.6 与 @langchain/langgraph ^1.4.13, 均非 optional |
| @langchain/textsplitters     | 1.0.2  | Various implementations of LangChain.js text splitters | 文本切分                                                                                                                                      |
| create-langchain-integration | 0.0.12 | 脚手架                                                 | 未声明 license 与 type 字段                                                                                                                   |

### 2.3 libs/providers 下 32 个集成包

| 包                             | 版本   | package.json description                                            |
| ------------------------------ | ------ | ------------------------------------------------------------------- |
| @langchain/openai              | 1.6.2  | OpenAI integrations for LangChain.js                                |
| @langchain/anthropic           | 1.5.12 | Anthropic integrations for LangChain.js                             |
| @langchain/aws                 | 1.4.6  | LangChain AWS integration                                           |
| @langchain/cohere              | 1.1.0  | Cohere integration for LangChain.js                                 |
| @langchain/deepseek            | 1.1.17 | Deepseek integration for LangChain.js                               |
| @langchain/fireworks           | 0.2.17 | Fireworks integration for LangChain.js                              |
| @langchain/google              | 0.2.8  | Google integrations for LangChain.js                                |
| @langchain/google-common       | 2.3.2  | Core types and classes for Google services                          |
| @langchain/google-gauth        | 2.3.2  | Google auth based authentication support for Google services        |
| @langchain/google-genai        | 2.3.2  | Google Generative AI integration for LangChain.js                   |
| @langchain/google-vertexai     | 2.3.2  | LangChain.js support for Google Vertex AI                           |
| @langchain/google-vertexai-web | 2.3.2  | LangChain.js support for Google Vertex AI Web                       |
| @langchain/google-webauth      | 2.3.2  | Web-based authentication support for Google services                |
| @langchain/groq                | 1.3.1  | Groq integration for LangChain.js                                   |
| @langchain/ibm                 | 0.2.0  | IBM watsonx.ai integrations for LangChain.js                        |
| @langchain/mistralai           | 1.2.0  | MistralAI integration for LangChain.js                              |
| @langchain/ollama              | 1.3.0  | Ollama integration for LangChain.js                                 |
| @langchain/openrouter          | 0.4.17 | OpenRouter integration for LangChain.js                             |
| @langchain/perplexity          | 0.3.0  | Perplexity integration (chat models、Search retriever、Search tool) |
| @langchain/together-ai         | 0.2.17 | Together AI integrations for LangChain.js                           |
| @langchain/xai                 | 1.4.17 | xAI integration for LangChain.js                                    |
| @langchain/cloudflare          | 1.1.0  | Cloudflare integration for LangChain.js                             |
| @langchain/exa                 | 1.0.2  | Exa integration for LangChain.js                                    |
| @langchain/tavily              | 1.2.0  | Tavily integration for LangChain.js                                 |
| @langchain/mongodb             | 1.3.1  | Sample integration for LangChain.js                                 |
| @langchain/neo4j               | 0.1.24 | Neo4j integrations for LangChain.js                                 |
| @langchain/pgvector            | 0.0.1  | LangChain.js integration for PostgreSQL pgvector                    |
| @langchain/pinecone            | 1.0.3  | LangChain integration for Pinecone's vector database                |
| @langchain/qdrant              | 1.0.3  | LangChain.js integration for the Qdrant vector database             |
| @langchain/redis               | 1.1.3  | Sample integration for LangChain.js                                 |
| @langchain/weaviate            | 1.1.0  | Weaviate integration for LangChain.js                               |
| @langchain/typesafe            | 0.0.2  | TypeSafe System One integration for LangChain.js (Jev classifier)   |

CONTRIBUTING.md 明确写了 "We no longer accept new integrations to this repository": 新集成必须作为独立 npm 包发布, 仓库只保留既有的 32 个一方集成。这也是为什么 libs/providers 是一个封闭集合。

### 2.4 根脚本与依赖治理

根 package.json 的 scripts 全部走 turbo: build 是 `turbo build:compile`, test:unit 用 filter 排除 test-exports-*、examples、create-langchain-integration, test 还包含 `pnpm test:exports:docker` (environment_tests/docker-compose.yml) 与 `test:ranges:docker` (dependency_range_tests/docker-compose.yml)。发布走 changesets: release 是 `changeset publish`, 配 @changesets/changelog-github。lint 与 format 分别用 oxlint 和 oxfmt, lint-staged 在提交前对 ts/tsx 跑 `oxfmt --write`。

根 package.json 的 pnpm.overrides 有两类值得注意:

- workspace 钉死: @langchain/core 与 langchain 都 override 为 workspace:^, 保证 monorepo 内所有包链接到本地源码。
- 供应链地板价: 大量安全相关 override (form-data >= 4.0.6、undici >= 8.9.0、axios >= 0.30.3、esbuild >= 0.28.1 等), 以及一组把易被抢注的基础包替换为 @socketregistry 官方镜像的 override (es-define-property、function-bind、gopd、hasown、isarray、safe-buffer、shell-quote 等)。

## 三、langchain-core: Runnable 内核与 LCEL

### 3.1 Runnable 抽象类

Runnable 定义在 libs/langchain-core/src/runnables/base.ts:124, 是所有可组合单元的基类, 继承 Serializable 并实现 RunnableInterface。类声明 (省略了 oxlint 禁用注释):

```ts
export abstract class Runnable<
  RunInput = any,
  RunOutput = any,
  CallOptions extends RunnableConfig = RunnableConfig,
>
  extends Serializable
  implements RunnableInterface<RunInput, RunOutput, CallOptions>
{
  protected lc_runnable = true;

  name?: string;

  abstract invoke(
    input: RunInput,
    options?: Partial<CallOptions>
  ): Promise<RunOutput>;
```

子类只需实现 invoke; batch、stream 等都有默认实现, 可以按需覆写。三个关键默认实现:

batch 默认实现 (base.ts:261-289) 用 AsyncCaller 控制并发, 并支持 returnExceptions 把错误作为结果返回:

```ts
async batch(
  inputs: RunInput[],
  options?: Partial<CallOptions> | Partial<CallOptions>[],
  batchOptions?: RunnableBatchOptions
): Promise<(RunOutput | Error)[]> {
  const configList = this._getOptionsList(options ?? {}, inputs.length);
  const maxConcurrency =
    configList[0]?.maxConcurrency ?? batchOptions?.maxConcurrency;
  const caller = new AsyncCaller({
    maxConcurrency,
    onFailedAttempt: (e) => {
      throw e;
    },
  });
  const batchCalls = inputs.map((input, i) =>
    caller.call(async () => {
      try {
        const result = await this.invoke(input, configList[i]);
        return result;
      } catch (e) {
        if (batchOptions?.returnExceptions) {
          return e as Error;
        }
        throw e;
      }
    })
  );
  return Promise.all(batchCalls);
}
```

stream 默认实现 (base.ts:310-323) 把子类的 _streamIterator 异步生成器包进 AsyncGeneratorWithSetup, 再转成 IterableReadableStream; await setup 的注释写明目的是 "缓冲第一个 chunk, 让初始错误立即暴露":

```ts
async stream(
  input: RunInput,
  options?: Partial<CallOptions>
): Promise<IterableReadableStream<RunOutput>> {
  // Buffer the first streamed chunk to allow for initial errors
  // to surface immediately.
  const config = ensureConfig(options);
  const wrappedGenerator = new AsyncGeneratorWithSetup({
    generator: this._streamIterator(input, config),
    config,
  });
  await wrappedGenerator.setup;
  return IterableReadableStream.fromAsyncGenerator(wrappedGenerator);
}
```

pipe 默认实现 (base.ts:615-623) 把任意 RunnableLike (函数、对象映射、Runnable) 强制转换后组成 RunnableSequence:

```ts
pipe<NewRunOutput>(
  coerceable: RunnableLike<RunOutput, NewRunOutput>
): Runnable<RunInput, Exclude<NewRunOutput, Error>> {
  // oxlint-disable-next-line @typescript-eslint/no-use-before-define
  return new RunnableSequence({
    first: this,
    last: _coerceToRunnable(coerceable),
  });
}
```

组合器方法一览 (均为 Runnable 上的实例方法, 返回新 Runnable):

| 方法                     | 返回                  | 位置                    |
| ------------------------ | --------------------- | ----------------------- |
| withRetry                | RunnableRetry         | base.ts:156             |
| withConfig               | RunnableBinding       | base.ts:175             |
| withFallbacks            | RunnableWithFallbacks | base.ts:192             |
| pipe                     | RunnableSequence      | base.ts:615             |
| streamLog / streamEvents | 日志流 / 事件流       | base.ts:717 与 896 附近 |

### 3.2 RunnableSequence 与 RunnableMap

RunnableSequence (base.ts:1925) 是 LCEL 管道的主角。其 invoke (base.ts:1961-2008) 逐步执行 first、middle 各步, 每步用 patchConfig 挂上以 seq:step:N 命名的子回调, 最后再跑 last; 全程用 raceWithSignal 支持中断:

```ts
async invoke(input: RunInput, options?: RunnableConfig): Promise<RunOutput> {
  const config = ensureConfig(options);
  const callbackManager_ = await getCallbackManagerForConfig(config);
  const runManager = await callbackManager_?.handleChainStart(
    this.toJSON(),
    _coerceToDict(input, "input"),
    config.runId,
    undefined,
    undefined,
    undefined,
    config?.runName
  );
  delete config.runId;
  let nextStepInput = input;
  let finalOutput: RunOutput;
  try {
    const initialSteps = [this.first, ...this.middle];
    for (let i = 0; i < initialSteps.length; i += 1) {
      const step = initialSteps[i];
      const promise = step.invoke(
        nextStepInput,
        patchConfig(config, {
          callbacks: runManager?.getChild(
            this.omitSequenceTags ? undefined : `seq:step:${i + 1}`
          ),
        })
      );
      nextStepInput = await raceWithSignal(promise, config.signal);
    }
    // ...
    finalOutput = await this.last.invoke(
      nextStepInput,
      patchConfig(config, {
        callbacks: runManager?.getChild(
          this.omitSequenceTags ? undefined : `seq:step:${this.steps.length}`
        ),
      })
    );
  } catch (e) {
    await runManager?.handleChainError(e);
    throw e;
  }
  await runManager?.handleChainEnd(_coerceToDict(finalOutput, "output"));
  return finalOutput;
}
```

序列上的 pipe 会做扁平化 (base.ts:2186-2208): 如果接上的仍是 RunnableSequence, 就把两段 middle 合并, 避免嵌套加深:

```ts
pipe<NewRunOutput>(
  coerceable: RunnableLike<RunOutput, NewRunOutput>
): RunnableSequence<RunInput, Exclude<NewRunOutput, Error>> {
  if (RunnableSequence.isRunnableSequence(coerceable)) {
    return new RunnableSequence({
      first: this.first,
      middle: this.middle.concat([
        this.last,
        coerceable.first,
        ...coerceable.middle,
      ]),
      last: coerceable.last,
      name: this.name ?? coerceable.name,
    });
  } else {
    return new RunnableSequence({
      first: this.first,
      middle: [...this.middle, this.last],
      last: _coerceToRunnable(coerceable),
      name: this.name,
    });
  }
}
```

RunnableMap 的 invoke (base.ts:2299) 对 steps 字典的每个 key 并行调用对应 runnable, 汇总成同构输入输出; RunnableParallel 就是 RunnableMap 的别名 (base.ts:2852: `export class RunnableParallel<RunInput> extends RunnableMap<RunInput> {}`)。

### 3.3 其余 Runnable 族类

runnables/ 目录下的其他文件各承担一个组合语义:

| 文件                        | 类/能力                                                                                                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| base.ts                     | Runnable、RunnableBinding (batch 在 1409 处合并 kwargs 后委托 bound)、RunnableWithFallbacks、RunnableRetry、RunnableMap/Parallel、RunnableLambda、RunnableGenerator |
| passthrough.ts              | RunnablePassthrough (恒等传递, 支持 assign)                                                                                                                         |
| branch.ts                   | RunnableBranch (条件路由)                                                                                                                                           |
| router.ts                   | RouterRunnable                                                                                                                                                      |
| history.ts                  | RunnableWithMessageHistory (聊天历史注入)                                                                                                                           |
| iter.ts                     | RunnableGenerator (异步生成器包装)                                                                                                                                  |
| config.ts                   | ensureConfig、mergeConfigs、patchConfig、getCallbackManagerForConfig                                                                                                |
| graph.ts / graph_mermaid.ts | 运行图结构与 Mermaid 可视化                                                                                                                                         |
| types.ts                    | RunnableConfig (types.ts:80, 继承 BaseCallbackConfig, 含 configurable、maxConcurrency、metadata 等)、RunnableBatchOptions                                           |

streamLog 的实现细节可见 base.ts:717 附近: 消费 stream 的每个 chunk, 转成 RunLogPatch, op 为 add、path 为 /streamed_output/-, 写入 logStreamCallbackHandler, 这是把流式输出重放为结构化日志的机制。

RunnableBinding 有一个静态守卫 isRunnableBinding (base.ts:1535), 判据是 `thing.bound && Runnable.isRunnable(thing.bound)`; RunnableSequence 同样有 isRunnableSequence (base.ts:2211), 判据是 `Array.isArray(thing.middle)`。这种鸭子类型守卫在 langchain/src/agents/utils.ts 中被用于拆解用户传入的链。

### 3.4 序列化基座: Serializable

Runnable 继承的 Serializable 来自 load/serializable.ts, 定义了 lc_serializable、lc_namespace、lc_name、lc_secrets、lc_aliases 等静态约定。以消息为例 (见第四节), BaseMessage 声明 lc_namespace 为 ["langchain_core", "messages"]、lc_serializable 为 true。lc_secrets 约定被 internal/build 的 lcSecretsPlugin 扫描, 自动生成 SecretMap 类型 (见第十二节)。

### 3.5 子路径导出

@langchain/core 的 package.json exports 提供 40 多个子路径, 全部按功能域拆分, 典型条目: .、./runnables、./messages、./messages/tool、./tools、./prompts、./output_parsers、./callbacks/base、./callbacks/manager、./callbacks/dispatch、./language_models/base、./language_models/chat_models、./language_models/structured_output、./retrievers、./tracers、./load、./load/serializable、./embeddings、./caches、./documents、./errors、./memory、./chat_history、./context、./indexing、./example_selectors 等。这种细粒度子路径导出是 monorepo 各包 tree-shaking 与按需加载的基础。

依赖面极窄: @cfworker/json-schema (浏览器可用的 JSON Schema 校验)、@standard-schema/spec、js-tiktoken、langsmith (`>=0.5.0 <1.0.0`)、mustache、p-queue、zod (`^3.25.76 || ^4`)。

## 四、消息体系: BaseMessage 与内容块

### 4.1 BaseMessage

消息体系在 libs/langchain-core/src/messages/ 下。BaseMessage (base.ts:215) 是抽象基类, 继承 Serializable 并实现 Message 泛型接口; content 的类型 MessageContent 定义为 `string | Array<ContentBlock>` (base.ts:52):

```ts
export abstract class BaseMessage<
  TStructure extends MessageStructure = MessageStructure,
  TRole extends MessageType = MessageType,
>
  extends Serializable
  implements Message<TStructure, TRole>
{
  lc_namespace = ["langchain_core", "messages"];

  lc_serializable = true;
  // ...
  name?: string;

  content: $InferMessageContent<TStructure, TRole>;

  additional_kwargs: NonNullable<
    BaseMessageFields<TStructure, TRole>["additional_kwargs"]
  >;

  response_metadata: NonNullable<
    BaseMessageFields<TStructure, TRole>["response_metadata"]
  >;
```

两个细节值得注意:

- additional_kwargs 中的 function_call 与 tool_calls 字段均已标注 @deprecated, 注释要求改用 AIMessage 的 tool_calls 字段 (base.ts:75-86)。
- AIMessage 构造器在检测到 additional_kwargs.tool_calls 而 tool_calls 未设置时, 会打印一条升级提示并尝试 defaultToolCallParser 兜底解析 (ai.ts:88-112)。

### 4.2 消息子类与 Chunk 变体

| 类              | 文件                  | 说明                                                              |
| --------------- | --------------------- | ----------------------------------------------------------------- |
| HumanMessage    | messages/human.ts:18  | type 为 "human"                                                   |
| AIMessage       | messages/ai.ts:46     | type 为 "ai", 携带 tool_calls、invalid_tool_calls、usage_metadata |
| SystemMessage   | messages/system.ts:18 | type 为 "system"                                                  |
| ToolMessage     | messages/tool.ts:53   | type 为 "tool", 实现 DirectToolOutput                             |
| ChatMessage     | messages/chat.ts      | 任意自定义 role                                                   |
| FunctionMessage | messages/function.ts  | 旧 function calling                                               |

AIMessage 的关键字段声明 (ai.ts:46-56):

```ts
export class AIMessage<TStructure extends MessageStructure = MessageStructure>
  extends BaseMessage<TStructure, "ai">
  implements AIMessageFields<TStructure>
{
  readonly type = "ai" as const;

  tool_calls?: $InferToolCalls<TStructure>[] = [];

  invalid_tool_calls?: InvalidToolCall[] = [];

  usage_metadata?: AIMessageFields<TStructure>["usage_metadata"];
```

HumanMessage 是最典型的子类形态 (human.ts:18-42), 提供静态 isInstance 守卫与 Symbol.hasInstance 覆写:

```ts
export class HumanMessage<
  TStructure extends MessageStructure = MessageStructure,
> extends BaseMessage<TStructure, "human"> {
  static lc_name() {
    return "HumanMessage";
  }

  readonly type = "human" as const;

  static isInstance(obj: unknown): obj is HumanMessage {
    return super.isInstance(obj) && obj.type === "human";
  }

  static [Symbol.hasInstance](obj: unknown) {
    return this.isInstance(obj);
  }
}
```

每个消息类都有对应的 Chunk 变体 (如 HumanMessageChunk), 继承 BaseMessageChunk (base.ts:700)。Chunk 的唯一抽象方法是 concat, 用于流式累加, 例如 HumanMessageChunk.concat (human.ts:65-79) 合并 content、additional_kwargs 与 response_metadata:

```ts
concat(chunk: HumanMessageChunk<TStructure>) {
  const Cls = this.constructor as Constructor<this>;
  return new Cls({
    content: mergeContent(this.content, chunk.content),
    additional_kwargs: _mergeDicts(
      this.additional_kwargs,
      chunk.additional_kwargs
    ),
    response_metadata: _mergeDicts(
      this.response_metadata,
      chunk.response_metadata
    ),
    id: this.id ?? chunk.id,
  });
}
```

### 4.3 自定义 instanceof 语义

BaseMessageChunk 覆写了 Symbol.hasInstance 并沿原型链判定 (base.ts:706-723), 这意味着 instanceof 对消息对象做的是结构化判定而不是严格的类同一性 — 跨包 (如 provider 包与 core 包各有一份类) 时依然可靠:

```ts
static isInstance(obj: unknown): obj is BaseMessageChunk {
  if (!super.isInstance(obj)) {
    return false;
  }
  // Check if obj is an instance of BaseMessageChunk by traversing the prototype chain
  let proto = Object.getPrototypeOf(obj);
  while (proto !== null) {
    if (proto === BaseMessageChunk.prototype) {
      return true;
    }
    proto = Object.getPrototypeOf(proto);
  }
  return false;
}

static [Symbol.hasInstance](obj: unknown) {
  return this.isInstance(obj);
}
```

旧的自由函数 isBaseMessage、isBaseMessageChunk (base.ts:761、770) 已标注 @deprecated, 注释要求改用对应的静态 isInstance 方法。

### 4.4 内容块体系

messages/content/ 目录存放内容块命名空间 (content/tools.ts 定义 ToolCall 等内容块), messages/message.ts 定义 MessageStructure 泛型参数体系; AIMessage 构造器在 response_metadata.output_version 为 "v1" 时会把 content 强制规整为 contentBlocks 数组, 并双向同步 tool_calls 与 contentBlocks 里 type 为 tool_call 的块 (ai.ts:114-178)。其余辅助模块: format.ts、transformers.ts、block_translators/、metadata.ts、modifier.ts、utils.ts。

## 五、工具体系: StructuredTool 与 tool() 工厂

### 5.1 StructuredTool

工具基类在 libs/langchain-core/src/tools/index.ts。StructuredTool (index.ts:95) 继承 BaseLangChain (language_models/base.ts:240), 要求实现 name、description、schema 与 _call:

```ts
export abstract class StructuredTool<
  SchemaT = ToolInputSchemaBase,
  SchemaOutputT = ToolInputSchemaOutputType<SchemaT>,
  SchemaInputT = ToolInputSchemaInputType<SchemaT>,
  ToolOutputT = ToolOutputType,
  ToolEventT = ToolEventType,
>
  extends BaseLangChain<
    StructuredToolCallInput<SchemaT, SchemaInputT>,
    ToolOutputT | ToolMessage
  >
  implements StructuredToolInterface<SchemaT, SchemaInputT, ToolOutputT>
{
  abstract name: string;

  abstract description: string;

  abstract schema: SchemaT;

  extras?: Record<string, unknown>;

  /**
   * Whether to return the tool's output directly.
   *
   * Setting this to true means that after the tool is called,
   * an agent should stop looping.
   */
  returnDirect = false;

  protected abstract _call(
    arg: SchemaOutputT,
    runManager?: CallbackManagerForToolRun,
    parentConfig?: ToolRunnableConfig
  ): Promise<ToolOutputT> | AsyncGenerator<ToolEventT, ToolOutputT>;
```

_call 可以返回 Promise 或 AsyncGenerator — 后者用于工具在执行过程中发出中间事件 (每个 yield 会转成 handleToolEvent 回调, 见下)。responseFormat 支持 "content" 与 "content_and_artifact" 两种 (index.ts:145), 后者要求返回二元组。

invoke 路径 (index.ts:175-209): 若输入是 ToolCall 结构, 取出 args 并把整个 toolCall 塞进 config.toolCall; 随后进入 call。call 的核心流程 (index.ts:222-360):

1. 输入校验: schema 是 zod 时走 interopParseAsync (同时兼容 zod v3/v4), 否则走 validate (基于 @cfworker/json-schema)。校验失败抛 ToolInputParsingException, verboseParsingErrors 开启时附带详情。
2. 回调接线: CallbackManager.configure 合并本地与继承回调, handleToolStart 携带 toolCallId。
3. 执行: _call 返回 AsyncGenerator 时逐 chunk 调用 runManager.handleToolEvent。
4. 输出整形: responseFormat 为 content_and_artifact 时解包二元组; 最终 _formatToolOutput 按是否存在 toolCallId 决定返回原始输出还是包装成 ToolMessage。

### 5.2 Tool、DynamicTool、DynamicStructuredTool

- Tool (index.ts:366): 字符串输入的特化 StructuredTool。
- DynamicTool (index.ts:422): 由 name、description、func 动态构造, func 接收字符串输入。
- DynamicStructuredTool (index.ts:488): 带 schema 的动态工具, schema 可传 zod 或 JSON Schema。

### 5.3 tool() 工厂函数

tool() 是面向用户的推荐入口, 定义了 12 个重载 (index.ts:652-872), 分别覆盖 ZodStringV3/V4、ZodObjectV3/V4、JSONSchema 以及带 ToolRuntime 参数的变体; 实现从 index.ts:898 开始, 分派逻辑 (index.ts:924-935):

```ts
const isSimpleStringSchema = isSimpleStringZodSchema(fields.schema);
const isStringJSONSchema = validatesOnlyStrings(fields.schema);

// If the schema is not provided, or it's a simple string schema, create a DynamicTool
if (!fields.schema || isSimpleStringSchema || isStringJSONSchema) {
  return new DynamicTool<ToolOutputT, ToolEventT>({
    ...fields,
    description:
      fields.description ??
      (fields.schema as { description?: string } | undefined)?.description ??
      `${fields.name} tool`,
```

schema 缺省或退化为纯字符串时生成 DynamicTool, 否则生成 DynamicStructuredTool。两种路径都会把用户函数包进 AsyncLocalStorageProviderSingleton.runWithConfig (保证回调上下文在异步边界内可取), 并注册 config.signal 的 abort 监听。

### 5.4 ToolRuntime: 自动注入的运行时上下文

tools/types.ts:541 定义 ToolRuntime, 其官方文档注释 (types.ts:466 起) 说明: 工具函数声明名为 runtime 的 ToolRuntime 参数时, 执行系统自动注入 state (当前图状态)、toolCallId、config、context、store (BaseStore) 与 writer (流式输出)。注释内附完整示例:

```ts
import { tool, type ToolRuntime } from "@langchain/core/tools";
import { z } from "zod";

const stateSchema = z.object({
  messages: z.array(z.any()),
  userId: z.string().optional(),
});

const greet = tool(
  async ({ name }, runtime: ToolRuntime<typeof stateSchema>) => {
    const messages = runtime.state.messages;
    console.log(`Tool call ID: ${runtime.toolCallId}`);
    const userId = runtime.context?.userId;
    await runtime.store?.mset([["key", "value"]]);
    runtime.writer?.("Processing...");
    return `Hello! User ID: ${runtime.state.userId || "unknown"} ${name}`;
  },
  {
    name: "greet",
    description: "Use this to greet the user once you found their info.",
    schema: z.object({ name: z.string() }),
    stateSchema,
  },
);
```

### 5.5 返回类型与守卫

ToolReturnType (types.ts:64-75) 是一个条件类型, 编码了 "传入带 toolCall.id 的 config 时返回 ToolMessage, 否则返回工具自身输出" 的语义:

```ts
export type ToolReturnType<TInput, TConfig, TOutput> =
  TOutput extends DirectToolOutput
    ? TOutput
    : TConfig extends { toolCall: { id: string } }
      ? ToolMessage
      : TConfig extends { toolCall: { id: undefined } }
        ? TOutput
        : TConfig extends { toolCall: { id?: string } }
          ? TOutput | ToolMessage
          : TInput extends ToolCall
            ? ToolMessage
            : TOutput;
```

types.ts 还提供 ToolInterface (312)、StructuredToolInterface、isStructuredTool (405, 判据是存在 lc_namespace 数组)、isRunnableToolLike、isStructuredToolParams 等守卫。createAgent 的参数里工具被分为 ClientTool 与 ServerTool 两类 (ReactAgent.ts:36 从 @langchain/core/tools 引入), 对应客户端声明的工具与可执行的服务端工具。

## 六、提示词模板与输出解析器

### 6.1 Prompt 体系

BasePromptTemplate (prompts/base.ts:48) 继承 Runnable, 实现 BasePromptTemplateInput, 提供 inputVariables、outputParser、partialVariables。构造器禁止名为 stop 的变量 (base.ts:87-91, 注释说明该名字内部保留)。invoke (base.ts:133-147) 把 formatPromptValue 包进 _callWithConfig, runType 标为 "prompt":

```ts
async invoke(
  input: RunInput,
  options?: BaseCallbackConfig
): Promise<RunOutput> {
  const metadata = {
    ...this.metadata,
    ...options?.metadata,
  };
  const tags = [...(this.tags ?? []), ...(options?.tags ?? [])];
  return this._callWithConfig(
    (input: RunInput) => this.formatPromptValue(input),
    input,
    { ...options, tags, metadata, runType: "prompt" }
  );
}
```

prompts/ 目录分工:

| 文件          | 内容                                                                                   |
| ------------- | -------------------------------------------------------------------------------------- |
| prompt.ts     | PromptTemplate (113), 静态 fromTemplate                                                |
| template.ts   | 解析器: parseFString (32) 与 parseMustache (119), 即 f-string 与 mustache 两种模板方言 |
| chat.ts       | 聊天提示词全家桶, 见下                                                                 |
| few_shot.ts   | FewShotPromptTemplate                                                                  |
| image.ts      | ImagePromptTemplate                                                                    |
| dict.ts       | DictPromptTemplate                                                                     |
| structured.ts | StructuredPrompt (46) 与 fromMessagesAndSchema (105), 带 schema 的结构化提示词         |
| pipeline.ts   | 提示词流水线                                                                           |
| string.ts     | 字符串工具                                                                             |
| serde.ts      | 序列化支持                                                                             |

聊天侧的类层次: BaseMessagePromptTemplate (chat.ts:50) 直接继承 Runnable, invoke 委托 formatMessages 并把 runType 标为 "prompt"; 其子类包括 MessagesPlaceholder (占位符展开消息列表)、_StringImageMessagePromptTemplate 派生的 HumanMessagePromptTemplate、SystemMessagePromptTemplate、AIMessagePromptTemplate; ChatPromptTemplate 继承 BaseChatPromptTemplate。

两个常用入口:

- ChatPromptTemplate.fromTemplate (chat.ts:1134 重载, 实现在 1176-1182): 用 PromptTemplate 解析后包一层 HumanMessagePromptTemplate, 等价于单条用户消息。

```ts
static fromTemplate(
  template: T,
  options?: Omit<
    PromptTemplateInput<RunInput, string, TemplateFormat>,
    "template" | "inputVariables"
  >
): ChatPromptTemplate<ExtractedFStringParams<T, RunInput> | InputValues> {
  const prompt = PromptTemplate.fromTemplate(template, options);
  const humanTemplate = new HumanMessagePromptTemplate({ prompt });
  return this.fromMessages<
    RunInput extends Symbol ? ParamsFromFString<T> : RunInput
  >([humanTemplate]);
}
```

- ChatPromptTemplate.fromMessages (chat.ts:1190-1222): 接收消息模板或元组, 嵌套的 ChatPromptTemplate 会被展平 (取 promptMessages), partialVariables 逐层合并, inputVariables 汇总去重。

_StringImageMessagePromptTemplate.fromTemplate (chat.ts:506 起) 支持字符串、text 块、image_url 块与任意对象模板混排; image 模板里最多只允许一个变量, 超过即抛错 (chat.ts:558-563)。

### 6.2 Output Parser 体系

层次关系: BaseOutputParser 继承 BaseLLMOutputParser, 后者继承 Runnable; StringOutputParser 与 JSON 系解析器经由 BaseTransformOutputParser、BaseCumulativeTransformOutputParser 支持流式增量解析。

BaseLLMOutputParser (output_parsers/base.ts:19) 是 Runnable, 输入 string 或 BaseMessage, 输出解析结果 T; invoke 把输入包成 Generation 再交给 parseResult。BaseOutputParser (base.ts:105) 增加 parse 与 getFormatInstructions 两个抽象方法, parseResult 默认取第一个 generation 的 text。OutputParserException (base.ts:170) 携带 llmOutput、observation、sendToLLM 字段, 并通过 addLangChainErrorFields 打上 OUTPUT_PARSING_FAILURE 错误码 — sendToLLM 为 true 时要求 observation 与 llmOutput 必须提供, 便于 agent 把解析失败反馈给模型重试。

StringOutputParser (output_parsers/string.ts:22) 是最常用的解析器, lc_name 为 StrOutputParser, 其文档注释给出的正是 LCEL 管道示例:

````ts
/**
 * OutputParser that parses LLMResult into the top likely string.
 * @example
 * ```typescript
 * const promptTemplate = PromptTemplate.fromTemplate(
 *   "Tell me a joke about {topic}",
 * );
 *
 * const chain = RunnableSequence.from([
 *   promptTemplate,
 *   new ChatOpenAI({ model: "gpt-4o-mini" }),
 *   new StringOutputParser(),
 * ]);
 *
 * const result = await chain.invoke({ topic: "bears" });
 * console.log("What do you call a bear with no teeth? A gummy bear!");
 * ```
 */
export class StringOutputParser extends BaseTransformOutputParser<string> {
  static lc_name() {
    return "StrOutputParser";
  }
````

它对内容块的处理 (_messageContentToString, string.ts:59-86) 覆盖 text、text_delta、image_url (抛错, 无法转字符串)、reasoning/thinking/redacted_thinking (返回空串) 等类型, 与 1.x 的内容块体系对齐。

其余解析器: JsonOutputParser (json.ts:10, 累积式, 用 parseJsonMarkdown 与 _diff 增量比较)、StructuredOutputParser (structured.ts:31, 基于 zod schema 生成指令)、standard_schema.ts (Standard Schema 支持)、xml.ts、list.ts、bytes.ts、transform.ts 里的 BaseTransformOutputParser (20) 与 BaseCumulativeTransformOutputParser (69), 以及 output_parsers/openai_tools/ 下的 JsonOutputToolsParser (json_output_tools_parsers.ts:123) 与 JsonOutputKeyToolsParser (241)。libs/langchain-classic/src/output_parsers/ 下还保留了 OutputFixingParser、RouterOutputParser、CombiningOutputParser 等旧式实现。

## 七、Callbacks、RunManager 与追踪

### 7.1 BaseCallbackHandler

callbacks/base.ts:352 定义抽象类 BaseCallbackHandler, 继承 BaseCallbackHandlerMethodsClass 并实现 BaseCallbackHandlerInput 与 Serializable。关键行为位:

- ignoreLLM、ignoreChain、ignoreAgent、ignoreRetriever、ignoreCustomEvent 五个开关 (base.ts:402-410)。
- raiseError 默认 false: handler 内部抛错只记录 console.warn, 不影响主流程; 置 true 才抛出。
- awaitHandlers 默认取决于环境变量 LANGCHAIN_CALLBACKS_BACKGROUND 是否为 "false" (base.ts:414-415)。
- 静态 fromMethods (base.ts:447) 可从普通方法对象生成 handler 类。
- isBaseCallbackHandler (base.ts:460) 做鸭子类型判定: 有 copy 函数、name 字符串、awaitHandlers 布尔。

可挂接的事件方法 (CallbackHandlerMethods, base.ts:58-314 区域): handleLLMStart、handleLLMNewToken、handleChatModelStreamEvent、handleLLMEnd/Error、handleChatModelStart、handleChainStart/Error/End、handleToolStart/Event/Error/End、handleAgentAction、handleAgentEnd、handleRetrieverStart/End/Error、handleCustomEvent。另有能力偏好接口: CallbackHandlerPrefersStreaming (lc_prefer_streaming, base.ts:321) 与 CallbackHandlerPrefersChatModelStreamEvents (base.ts:333-334)。

### 7.2 CallbackManager

CallbackManager (callbacks/manager.ts:779) 继承 BaseCallbackManager (manager.ts:200), 核心入口是静态 configure (manager.ts:1336-1354), 合并 inheritable 与 local 两组 handlers/tags/metadata 后返回新 manager:

```ts
static configure(
  inheritableHandlers?: Callbacks,
  localHandlers?: Callbacks,
  inheritableTags?: string[],
  localTags?: string[],
  inheritableMetadata?: Record<string, unknown>,
  localMetadata?: Record<string, unknown>,
  options?: CallbackManagerOptions
): CallbackManager | undefined {
  return this._configureSync(
    inheritableHandlers,
    localHandlers,
    inheritableTags,
    localTags,
    inheritableMetadata,
    localMetadata,
    options
  );
}
```

Callbacks 类型 (manager.ts:41-43) 即 CallbackManager 或 handler 数组。handleLLMStart (manager.ts:831) 对每个 prompt 分配 runId (第一个可用传入值, 其余用 uuidv7), 对 tracer 类 handler 同步创建 run, 注释写明原因: 回调可能被后台化, 同步建 run 避免竞态。每个事件方法最终返回对应的 RunManager: CallbackManagerForChainRun (manager.ts:517)、CallbackManagerForLLMRun、CallbackManagerForToolRun、CallbackManagerForRetrieverRun, 它们都继承 BaseRunManager, 提供 getChild(tag) 把 inheritable handlers/tags/metadata 传播给子 run (manager.ts:521-531) — 这是 Runnable 树里回调层级正确嵌套的机制。

Runnable 与回调的桥在 runnables/config.ts: getCallbackManagerForConfig (33) 与 mergeConfigs (49); Runnable._callWithConfig (base.ts:359 附近) 在每次 invoke/stream 时建立 run 上下文。

### 7.3 追踪器

tracers/ 目录提供 BaseTracer (tracers/base.ts, 其 handleChainStart 在 444 行), 把回调事件聚合为 run 树; LangSmith 上报由 langsmith 包完成 (langchain-core 的 dependencies 中声明为 `>=0.5.0 <1.0.0`)。callbacks/dispatch 提供独立于对象树的自定义事件派发 API。

## 八、模型 Provider 集成: BaseChatModel、initChatModel 与 standard-tests

### 8.1 BaseChatModel 抽象

语言模型基类在 libs/langchain-core/src/language_models/: base.ts 定义 BaseLangChain (240) 与 BaseLangChainParams (230)、ToolDefinition (358); chat_models.ts 定义 BaseChatModel; llms.ts 是补全式 BaseLLM; structured_output.ts 提供 withStructuredOutput 能力; profile.ts 定义 ModelProfile (模型能力画像); compat.ts、event.ts、stream.ts、openai_completions_stream.ts、utils.ts 为辅助。

codegraph 的静态分析显示 invoke 接口运行时分派到 35 个 BaseChatModel 实现, 例如 ConfigurableModel.invoke (libs/langchain/src/chat_models/universal.ts:566)、BaseChatOpenAI.invoke (libs/providers/langchain-openai/src/chat_models/base.ts:814) 等 — 这正是 "接口统一、实现分散在各 provider 包" 的证据。

### 8.2 以 @langchain/openai 为例

package.json: description 为 "OpenAI integrations for LangChain.js", 依赖 openai ^7.10.0、js-tiktoken ^1.0.12、zod (^3.25.76 || ^4), peerDependencies 为 @langchain/core workspace:^。

聊天模型基类 BaseChatOpenAI (providers/langchain-openai/src/chat_models/base.ts:274) 继承 BaseChatModel 并实现 `Partial<OpenAIChatInput>`, 字段声明节选:

```ts
export abstract class BaseChatOpenAI<
  CallOptions extends BaseChatOpenAICallOptions,
>
  extends BaseChatModel<CallOptions, AIMessageChunk>
  implements Partial<OpenAIChatInput>
{
  temperature?: number;

  topP?: number;

  frequencyPenalty?: number;

  presencePenalty?: number;

  n?: number;

  logitBias?: Record<string, number>;

  model = "gpt-3.5-turbo";

  streaming = false;

  streamUsage = true;

  maxTokens?: number;

  apiKey?: OpenAIApiKey;
```

可见 provider 包的集成模式: 继承 core 的 BaseChatModel, 把厂商 SDK 的调用参数映射为类字段, 通过 _generate/_streamResponseChunks 等钩子接入生成与流式, 并声明 lc_secrets 把 apiKey 映射到环境变量 (该映射由 lcSecretsPlugin 生成文档, 见第十二节)。

两个实质提交落在本小节覆盖的 provider 上, 行为值得记录 (HEAD bc4466b22 正是把两者发布为 @langchain/openai 1.6.2 与 @langchain/anthropic 1.5.12 的版本提交):

- #11771 (bbed27359): ModelProfile 新增可选字段 `fileMimeTypes?: readonly string[]`, 声明模型接受的通用文件 MIME 类型集合 (libs/langchain-core/src/language_models/profile.ts:86)。@langchain/openai 用自动生成的 profiles.ts 内置 Responses API 接受为 input_file 的 MIME 类型清单 (FILE_MIME_TYPES, libs/providers/langchain-openai/src/chat_models/profiles.ts); ChatOpenAIResponses 与 AzureChatOpenAIResponses 的 profile 恒带该清单, ChatOpenAI 与 AzureChatOpenAI 仅在实例选用 Responses API (useResponsesApi、reasoning.summary 或模型本身偏好 Responses API) 且 profile 有 pdfInputs 时携带 (utils/file_mime_types.ts 的 withoutFileMimeTypesUnlessSupported), Chat Completions 的 profile 不变 (三个类各自 override profile getter: chat_models/responses.ts 恒保留、chat_models/index.ts 依 _useResponsesApi(undefined) 判定、chat_models/completions.ts 恒剥离)。
- #11707 (41098120e): SystemMessage 上的工具变更支持。OpenAI 侧, SystemMessage 的 additional_tools 块被提升为 Responses API 顶层 input item, non_standard 包裹的 configuration_update 与 mcp_approval_response 块同样提升 (converters/responses.ts, toHoistedInputItem); Chat Completions 路径不再静默丢弃, 而是经 assertAdditionalToolsPlacement 直接抛错 (converters/completions.ts, 辅助函数 unwrapNonStandard 与 assertAdditionalToolsPlacement 在 utils/misc.ts)。Anthropic 侧, SystemMessage 可携带 tool_addition / tool_removal 块 (支持内联工具定义), _buildMessagesRequest (chat_models.ts) 依消息转换结果自动追加 beta header: 按引用变更工具加 mid-conversation-tool-changes-2026-07-01, 内联定义工具时加 inline-tools-2026-09-15; _formatSystemContent (utils/message_inputs.ts) 把 system 内容收窄为 Anthropic 接受的闭集 (text 与工具变更块, non_standard 包裹先经 _unwrapNonStandard 解包), 其余块被丢弃, 收窄后为空则整个 system 字段置空。

### 8.3 initChatModel 与 ConfigurableModel

libs/langchain/src/chat_models/universal.ts 提供运行时按名称实例化模型的能力:

- MODEL_PROVIDER_CONFIG (universal.ts:86 起) 是一张静态表, 把 provider 键映射到 npm 包与类名, 节选: openai 对应 @langchain/openai 的 ChatOpenAI, azure_openai 与 langsmith 同样落到 @langchain/openai (AzureChatOpenAI / ChatOpenAI), cohere、google (ChatGoogle)、google-vertexai 与 google-vertexai-web (两者类名同为 ChatVertexAI, 注释说明因此需要 modelProvider 直查以避免类名碰撞)、google-genai (ChatGoogleGenerativeAI)、ollama、mistralai/mistral、groq、bedrock/aws (ChatBedrockConverse)、deepseek、xai、cerebras (@langchain/cerebras, 不在本仓库内)、fireworks 等。
- SUPPORTED_PROVIDERS (universal.ts:174) 即该表的键集合。
- initChatModel (813-827 起有多个重载, 实现在 1084) 支持 "provider:model" 字符串写法: 以冒号切分后, 若第一段命中 SUPPORTED_PROVIDERS 则视为 provider, 剩余为 model 名。configurableFields 控制哪些参数可在运行时经 config.configurable 覆盖 (默认 model 与 modelProvider), configPrefix 为多模型共存时加前缀。返回值是 ConfigurableModel (universal.ts:350), 一个延迟绑定真实模型类的 Runnable 包装。

这解释了主包 langchain 的 dependencies 为何如此精简: 只有 @langchain/langgraph ^1.4.13、@langchain/langgraph-checkpoint ^1.1.5、langsmith 与 zod, provider 全部按需动态 import, 不进静态依赖。

### 8.4 standard-tests: 集成一致性测试

internal/standard-tests (@langchain/standard-tests 0.0.23) 提供 ChatModelUnitTests 与 ChatModelIntegrationTests 两个基类。其 README 自述不对外发布 (仅供 monorepo 内使用), 用法: provider 包把它作为 devDependency, 在 src/tests/chat_models.standard.test.ts 与 chat_models.standard.int.test.ts 里继承基类, 构造参数声明 chatModelHasToolCalling、chatModelHasStructuredOutput 等能力标志, 运行 runTests() 返回布尔值; 单测通过 process.env.CHAT_MODEL_API_KEY 注入假密钥。仓库内已落地该机制的 provider 包括 langchain-cloudflare、langchain-google-vertexai、langchain-aws、langchain-cohere 等 (每个都有 chat_models.standard.test.ts 与 chat_models.standard.int.test.ts 两个文件)。

## 九、langchain 主包: createAgent 与中间件体系

### 9.1 包面

langchain 1.5.15 的 src 结构: agents/ (核心)、chat_models/universal.ts (initChatModel)、hub/ (LangChain Hub 提示词拉取)、load/ (序列化加载)、prompts/ (对 core 提示词的再导出加 selectors)、storage/ (InMemoryStore、LocalFileStore、EncoderBackedStore)、tools/headless.ts、browser.ts (浏览器入口)、index.ts。package.json 的 exports 子路径: .、./browser、./chat_models/universal、./hub、./hub/node、./load、./load/serializable、./storage/encoder_backed、./storage/file_system、./storage/in_memory、./tools、./package.json。

### 9.2 createAgent 与 ReactAgent

createAgent (agents/index.ts:672 实现) 有十余个重载, 覆盖 responseFormat 为 undefined 与各结构化格式的组合, 实现体只有一句 `return new ReactAgent(params);`。ReactAgent (agents/ReactAgent.ts:164) 的类注释描述了 ReAct 三节点模型 (ReactAgent.ts:86-93):

```ts
/**
 * In the ReAct pattern we have three main nodes:
 * - model_request: The node that makes the model call.
 * - tools: The node that calls the tools.
 * - END: The end of the graph.
 *
 * These are the only nodes that can be jumped to from other nodes.
 */
```

ReactAgent 用一个 AgentTypeConfig 类型包承载全部类型信息 (Response、State、Context、Middleware、Tools、StreamTransformers), 其运行时底座是 @langchain/langgraph: ReactAgent.ts 从 @langchain/langgraph 引入 StateSchema、MessagesValue、ReducedValue、UntrackedValue、Command 等, 从 @langchain/langgraph-checkpoint 引入 BaseCheckpointSaver、BaseStore。图节点在 agents/nodes/ 下: AgentNode (model_request)、ToolNode (tools)、BeforeAgentNode、BeforeModelNode、AfterModelNode、AfterAgentNode — 前后四个钩子节点就是中间件的挂载点。

CreateAgentParams (agents/types.ts:565) 的关键字段: model (595, string 或 AgentLanguageModelLike)、tools (618)、systemPrompt (689, string 或 SystemMessage)、stateSchema (735)、contextSchema (769)、checkpointer (774, BaseCheckpointSaver 或 boolean)、store (779, BaseStore)、responseFormat (833)、middleware (841)、name (846)、streamTransformers (923)。

状态模式 (agents/annotation.ts:24 createAgentState): 用户 stateSchema 与各中间件 stateSchema 合并; jumpTo 字段用 UntrackedValue 承载内部跳转控制 ("model_request"、"tools"、"end"); 下划线开头的字段是私有状态, 留在图状态中但不暴露为输入输出通道; zod v4 的 reducer 元数据 (schemaMetaRegistry) 会被包成 ReducedValue; 最终输出 state、input、output 三个 StateSchema, messages 一律用 MessagesValue。

流式 API: streamEvents 提供 v1/v2/v3 重载 (ReactAgent.ts:1383-1533), v3 返回 AgentRunStream 并支持调用点传入 stream transformers; 还提供 drawMermaid 与 drawMermaidPng (ReactAgent.ts:1545-1578) 直接渲染图结构; 1580 行的注释说明存在一组 LangGraph Platform 专用的内部方法。

### 9.3 内置中间件

createMiddleware (agents/middleware.ts:76) 是工厂函数, 接受 name、stateSchema (持久化状态)、contextSchema (只读上下文)、tools、streamTransformers 与 wrapToolCall (拦截工具调用, 可改参数、重试、缓存、鉴权或返回 Command) 等钩子。middleware/index.ts 导出的内置中间件清单:

| 中间件                                 | 文件                                | 职责                                                                  |
| -------------------------------------- | ----------------------------------- | --------------------------------------------------------------------- |
| hitl (human-in-the-loop)               | hitl.ts                             | 人工介入中断                                                          |
| summarizationMiddleware                | summarization.ts                    | 上下文摘要压缩                                                        |
| dynamicSystemPromptMiddleware          | dynamicSystemPrompt.ts              | 运行时动态系统提示词                                                  |
| llmToolSelectorMiddleware              | llmToolSelector.ts                  | 用 LLM 预选工具子集                                                   |
| piiMiddleware / piiRedactionMiddleware | pii.ts / piiRedaction.ts            | PII 检测与脱敏, 附带 detectEmail、detectCreditCard、detectIP 等检测器 |
| contextEditingMiddleware               | contextEditing.ts                   | 上下文编辑, 含 ClearToolUsesEdit                                      |
| toolCallLimitMiddleware                | toolCallLimit.ts                    | 工具调用次数上限                                                      |
| todoListMiddleware                     | todoListMiddleware.ts               | 待办清单工具与系统提示词                                              |
| modelCallLimitMiddleware               | modelCallLimit.ts                   | 模型调用次数上限                                                      |
| modelFallbackMiddleware                | modelFallback.ts                    | 模型降级                                                              |
| modelRetryMiddleware                   | modelRetry.ts                       | 模型调用重试                                                          |
| toolRetryMiddleware                    | toolRetry.ts                        | 工具重试                                                              |
| toolErrorMiddleware                    | toolError.ts                        | 工具错误处理                                                          |
| toolEmulatorMiddleware                 | toolEmulator.ts                     | 工具模拟执行                                                          |
| providerToolSearchMiddleware           | providerToolSearch.ts               | provider 侧工具搜索                                                   |
| openAIModerationMiddleware             | provider/openai/moderation.ts       | OpenAI 内容审核                                                       |
| anthropicPromptCachingMiddleware       | provider/anthropic/promptCaching.ts | Anthropic 提示词缓存                                                  |
| bedrockPromptCachingMiddleware         | provider/aws/promptCaching.ts       | Bedrock 提示词缓存                                                    |

utils.ts 还导出 countTokensApproximately 近似 token 计数。

### 9.4 官方示例口径

examples/src/createAgent/ 下 28 个示例文件, 命名即能力地图: accessExternalContext、accessExternalContextInTools、accessLongTermMemory(InTools)、accessThreadLevelState(InTools)、controlOverMessagePreparation、customSystemPrompts、streaming、structuredOutput、supervisor、tools、updateModelBeforeCall、updateThreadLevel(InTools)、updateToolsBeforeModelCall, 以及 dynamicTools/ 与 middleware/ 两个子目录。

accessExternalContext.ts 开头的注释把 Context 与 State 的边界定义得很清楚, 值得摘录:

```ts
/**
 * Context vs State Distinction:
 * - Context: Static runtime parameters (user ID, DB connections, config)
 *   - Set once per session/request
 *   - Doesn't change during conversation
 *   - Used to look up user info, configure behavior
 *
 * - State: Dynamic conversation data (messages, memory, session variables)
 *   - Modified over time during interaction
 *   - Persists and evolves through the conversation
 *   - Managed by the agent framework
 */
```

示例的导入写法是 `import { createAgent, dynamicSystemPromptMiddleware, tool } from "langchain";`, 模型则来自 @langchain/openai。examples/src/multi-agent/ 另有 5 个多 agent 示例 (含 handoffs-customer-support.ts、subagents-personal-assistant.ts)。

## 十、langchain-classic: v0.x 遗留抽象的归宿

@langchain/classic 1.0.52 的 README 第一段说明定位: 这是 v1.0 发布时从主包迁出的 v0.x 功能, 用于向后兼容。README 列明适用场景: 维护使用旧式 chains (LLMChain、ConversationalRetrievalQAChain、RetrievalQAChain) 的代码、依赖 indexing API、依赖原从 langchain 再导出的 @langchain/community 功能; 并明确新项目应使用 langchain v1.0 的 createAgent。

src 目录是 0.x 时代的完整地图: agents/ (agent.ts 的 AgentRunnableSequence 继承 RunnableSequence, executor.ts 的 AgentExecutor, react/、chat/、chat_convo/、xml/、openai_functions/、toolkits/)、chains/、memory/、retrievers/、vectorstores/、document_loaders/、document_transformers/、evaluation/、experimental/ (autogpt、openai_assistant、plan_and_execute 等)、smith/、indexes/、cache/、output_parsers/、prompts/、tools/、hub/、storage/、stores/、sql_db.ts、text_splitter.ts。

dependencies 也反映了它的身份: @langchain/openai 与 @langchain/textsplitters (workspace:*), 加上 handlebars、js-yaml、jsonpointer、openapi-types、yaml、zod。examples/src/langchain-classic/ 下保留了 323 个 ts 示例, 是仓库内最大的示例语料 (含 guides/expression_language 的 LCEL 指南)。libs/langchain-classic/src/agents/agent.ts 中 AgentRunnableSequence 是旧 agent 与 RunnableSequence 的桥: 继承序列, 附加 streamRunnable 与 singleAction 字段, 并提供 isAgentRunnableSequence 静态守卫 (agent.ts:180-207)。

## 十一、langchain-mcp-adapters: MCP 适配器

@langchain/mcp-adapters 2.0.0 把 MCP 工具接入 LangChain 工具协议。2.0.0 由 56a7f0b19 (#11767) 准备、经 417ddcf50 (#11749 version packages) 正式发布: 迁移到 MCP SDK 2 (@modelcontextprotocol/client 与 core 均升到 ^2.2.0, zod ^4.4.3), 同一适配器内可混用 modern 与 legacy 协议的服务器 (每个服务器独立协商, mode 取 "auto"、"modern"、"legacy"); peerDependencies 为 @langchain/core ^1.2.6 与 @langchain/langgraph ^1.4.13, 均非 optional; engines 仍要求 node >= 20.10.0。这是 major 版本, 包内 CHANGELOG.md 的 2.0.0 条目给出完整迁移说明 (官方迁移页在 docs.langchain.com 的 migrate/langchain-mcp-adapters)。

index.ts 的公开导出:

- MCPAdapter 类定义在 client.ts:61; MultiServerMCPClient 是同一实现的别名导出 (client.ts:1187) 且已标 @deprecated, 新代码用 MCPAdapter 与 `{ servers: { ... } }` 配置, 配置类型 ClientConfig 对应改名 MCPAdapterConfig。
- 工具发现双入口: listTools() 返回可执行的 DynamicStructuredTool 扁平列表 (client.ts:334-339), listToolsets() 按服务器分组 (client.ts:196); getTools() 与 initializeConnections() 保留为 deprecated 别名 (client.ts:349-356、204-205)。
- 工具名默认带服务器名前缀: prefixToolNameWithServerName 默认 true (types.ts:934, client.ts:159-160 处生效), docs 服务器上名为 search 的工具暴露为 docs__search; 关闭前缀时, 两个服务器暴露同名工具或同一服务器重复列名都会抛 MCPClientError (client.ts:1206、1211)。独立辅助函数 loadMcpTools 保持不加前缀的旧默认 (tools.ts:472)。
- 配置经 zod 4 严格校验: 未知的 adapter/server 选项、与服务器 mode 或 transport 不匹配的选项、空 server 映射、同时设置 servers 与 mcpServers 均抛错 (types.ts 的 clientConfigSchema/mcpAdapterConfigSchema/adapterConfigSchema)。
- tools.ts 导出 loadMcpTools (483) 与 convertMcpTools (495), 并再导出 ToolException 与 isToolException (tools.ts:62, 定义于 utils/errors.ts:26); MCPClientError 出自 utils/errors.ts:7。hooks.ts 定义 ToolCallRequest (12)、ToolCallModification (46) 与 ToolHooks (131); 1.x 的 ToolResult 类型已移除, afterToolCall 钩子的结果参数改用 content.ts 的 ToolResultBefore (hooks.ts:5、115), state 参数类型为 unknown。
- 连接类型: StdioConnection、StreamableHTTPConnection、SSEConnection、HTTPConnection 与统一的 Connection、ResolvedConnection; index 仅再导出 HTTPConnectionSchema 一个 zod schema, StdioConnectionSchema (types.ts:643)、StreamableHTTPConnectionSchema (692)、ConnectionSchema (732) 等仍在 types.ts 定义但不再从包入口导出。SSE 保留为 legacy 传输, 拒绝 mode: "modern"、elicitation 与 logLevel。
- elicitation: modern MCP elicitation 默认开启, 服务器请求用户输入时以 LangGraph interrupt 暂停运行 (elicitation.ts:19-23 从 @langchain/langgraph 引入 interrupt、isGraphInterrupt 与 Interrupt 类型); index 导出 MCPElicitationContext、MCPElicitationHandler、MCPElicitationInterrupt、MCPElicitationResponses、MCPElicitationResume 五个类型与 createMCPElicitationResume (elicitation.ts:183), 恢复值按产生 interrupt 的任务 id 组键, 配合 LangGraph Command 使用; 仅当工具真正请求输入时才需要 checkpointer, 恢复后工具从头重跑 (含 beforeToolCall)。
- 工具结果与错误: MCP 服务器返回 isError 的结果时, agent 场景的工具调用得到 status: "error" 的 ToolMessage, 直接调用仍抛 ToolException (error.result 携带 MCP 响应); 图像/音频内容转成标准 LangChain 内容块, resource link 变 file 块; structuredContent 与 _meta 保留在 artifact 的 mcp_structured_content 与 mcp_meta 条目 (content.ts:179、185)。
- 还从 @modelcontextprotocol/client 转导出 OAuth 相关类型 (AuthProvider、OAuthClientProvider、UnauthorizedError)。

## 十二、构建、测试与发布设施

### 12.1 internal/build: tsdown 统一构建

@langchain/build 0.1.1 是所有包的构建中枢, README 自述为 "Pre-configured build system for LangChain packages using tsdown"。getBuildConfig (internal/build/src/index.ts) 默认值:

```ts
export function getBuildConfig(options?: Partial<BuildOptions>): BuildOptions {
  return {
    format: ["cjs", "esm"],
    target: "es2022",
    platform: "node",
    // rolldown/tsdown can emit `.mjs` for ESM when `fixedExtension` is enabled.
    // We want stable `.js` ESM output for `"type": "module"` packages.
    fixedExtension: false,
```

即双格式 (CommonJS + ESM)、目标 ES2022、Node 平台, 类型声明由 tsgo 并行生成, 产物经 ATTW (node16 profile)、publint (strict) 与未使用依赖检查三重验证。

四个 tsdown 插件承载 LangChain 特有的生成逻辑:

| 插件                  | 产物                                                           | 作用                                                                                            |
| --------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| lcSecretsPlugin       | src/load/import_type.ts 的 SecretMap 接口                      | 扫描所有 lc_secrets getter, 收集环境变量名并校验命名规范                                        |
| importConstantsPlugin | src/load/import_constants.ts 的 optionalImportEntrypoints 数组 | 声明可选依赖入口点                                                                              |
| importMapPlugin       | src/load/import_map.ts                                         | 为所有入口生成带命名空间别名的再导出, 别名用双下划线 (如 tools/calculator 变 tools__calculator) |
| cjsCompatPlugin       | 每个入口的 .cjs、.d.cts、.d.ts、.js barrel 文件                | 双格式包的模块解析兼容                                                                          |

包名到别名前缀的映射规则: @langchain/core 生成 langchain/... 前缀, @langchain/openai 生成 langchain_openai/...。

### 12.2 测试矩阵

- 单测: turbo test, test:unit 过滤掉 test-exports-*、examples、create-langchain-integration; langchain-core 用 vitest run, devDependencies 含 vitest ^4.1.11 与 dpdm (依赖分析)。
- 导出兼容: environment_tests/ 下 10 个目录, 用 Docker 验证各形态的包导出: test-exports-esm、cjs、tsc、esbuild、vite、vercel、cf (Cloudflare)、bun、node-classic (针对 @langchain/classic), 以及 test-zod-compat (zod-v3、zod-v4、zod-mismatch 三个变体, 验证双版本 zod 互操作)。
- 依赖区间: dependency_range_tests 用 Docker 对依赖版本区间做回归。
- 集成一致性: internal/standard-tests 的聊天模型标准测试 (见 8.4)。
- 测试命名约定 (AGENTS.md): 单测 *.test.ts、集成 *.int.test.ts、类型测试 *.test-d.ts、标准测试 *.standard.test.ts / *.standard.int.test.ts, 测试与被测模块同目录的 tests/ 下。

### 12.3 发布流程

CONTRIBUTING.md 描述为 ad hoc: 开发者高频切版本并发布到 npm, 用 changesets 管理。dev release 走 GitHub Actions 的 Publish workflow, 版本格式 x.y.z-tag.short-sha (如 1.1.0-dev.abc1234), npm tag 默认 dev, 安装方式为 `npm install @langchain/core@dev`。每个发布包有独立 CHANGELOG.md (internal/build、internal/standard-tests 等目录内均可见)。

### 12.4 编码规范 (仓库 AGENTS.md)

- TypeScript 共享配置 internal/tsconfig/base.json: 目标 ES2022、模块 ESNext、bundler 解析、strict。
- lint 规则 (实际文件 .oxlintrc.jsonc): 禁止 process.env (测试除外)、禁止显式 any、优先模板字符串、导入必须带文件扩展名。
- 导入约定: 本地导入一律 .js 扩展名 (ESM); 只用命名导出。
- zod 双版本: 代码库同时支持 zod v3 与 v4, 分别以 "zod/v3" 与 "zod/v4" 子路径导入。
- 文件命名: 源文件 snake_case, 索引 index.ts, 类型 types.ts。
- 核心抽象速览 (AGENTS.md 给出): Runnable (@langchain/core/runnables)、消息 (@langchain/core/messages)、工具 (StructuredTool/DynamicTool/tool)、聊天模型 (BaseChatModel)。

## 十三、示例与文档组织

examples 是 private workspace 包 (examples 0.0.0), src 下按主题分目录, 各目录 ts 文件数:

| 目录              | 文件数 | 内容                                                             |
| ----------------- | ------ | ---------------------------------------------------------------- |
| createAgent       | 28     | 1.x agent API 全场景 (见 9.4)                                    |
| langchain-classic | 323    | 0.x API 的最大示例库, 含 guides/expression_language 的 LCEL 系列 |
| multi-agent       | 5      | handoffs、subagents、supervisor 等                               |
| llms              | 5      | LLM 用法                                                         |
| cache             | 4      | 缓存                                                             |
| extraction        | 1      | 结构化抽取                                                       |
| provider          | 1      | provider 示例                                                    |

包根还有三个测试资产文件: hotdog.jpg、openai_openapi.yaml、state_of_the_union.txt。examples/src/README.md 是目录说明。

文档本体不在仓库: docs/core_docs/README.md 指向 https://docs.langchain.com/oss/javascript/ (仓库 langchain-ai/docs)。README 与 CONTRIBUTING 是仓库内的主要文字材料。

## 十四、值得记住的工程事实小结

- 抽象收敛: 一切皆 Runnable — prompt、消息工具、parser、模型、链全是同一个可调用接口, 序列化、回调、流式、图可视化因此可以复用同一套机制 (libs/langchain-core/src/runnables/base.ts)。
- 跨包兼容靠结构化判定: 消息类的 Symbol.hasInstance 覆写与工具的 lc_namespace 鸭子类型, 而非 instanceof 类同一性 (messages/base.ts:706、tools/types.ts:405)。
- v1 与 v0 物理隔离: langchain 1.x 只保留 agent 时代的构建块, 旧抽象整体迁入 @langchain/classic, 依赖关系在 package.json 层清晰可见。
- provider 封闭 + 按需加载: 32 个一方集成不再扩容, initChatModel 通过 MODEL_PROVIDER_CONFIG 动态 import, 主包依赖面保持最小 (libs/langchain/package.json 仅 4 个依赖)。
- 质量基建完备: tsdown 双格式构建 + 自动生成 import map/secrets 文档 + ATTW/publint 验证 + 10 环境导出测试 + zod v3/v4 兼容测试 + 聊天模型标准测试, 均在仓库内可见源码。
- 仓库自带 AGENTS.md 面向 AI 编码代理的规范 (含 Corridor 安全分析流程), 与本文调研对象 createAgent 形成互文 — 该仓库本身就是 agent 友好代码库的实践样本。
