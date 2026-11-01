---
title: "Claude Code 兼容实现: 构建体系、核心循环与多 Provider 兼容层"
description: "一个终端 AI 编码助手的工程实现剖析: Bun 代码分割构建、流式 Agent 循环与工具并发调度、核心白名单加延迟发现的工具系统, 以及把异构模型协议收敛到 Anthropic 内部格式的流适配器模式, 可以参考 claude-code 目录"
local_path: "$HOME/Downloads/claude-code"
local_commit: "8d80e740f764be358e265eed4250606c78fca579"
---

本文剖析一个与官方 Claude Code CLI 配置兼容的终端 AI 编码助手 (Bun 运行时, TypeScript/React monorepo) 的实现: 它如何组织构建与特性裁剪, 如何驱动"模型流式输出、工具并发执行、结果按序回吐"的核心循环, 如何设计工具注册与延迟发现, 以及如何用一层流适配器把多家模型协议收敛成同一种内部格式。适合想自建或二次开发终端编码 Agent 的工程师阅读。

## 一、它是什么, 解决什么问题

这是一个终端里的交互式 AI 编码助手, 与官方 Claude Code CLI 的配置文件保持兼容: 用户不需要改动原有配置即可替换使用。它的自我定位是复原核心功能、裁剪次要能力, 并持续追平企业版与登录态特性。

它解决的问题可以拆成三层:

| 层次   | 问题                                                                                            |
| ------ | ----------------------------------------------------------------------------------------------- |
| 接入层 | 官方实现只对接自家模型与云平台; 团队常需要接入 OpenAI 兼容端点、Gemini、Grok (xAI) 与多家云平台 |
| 编排层 | 终端 Agent 需要在流式输出中并发执行工具调用, 同时保证结果顺序、权限确认与中断语义都正确         |
| 工程层 | 一个上千文件的大型 TypeScript CLI 在 Bun 运行时下会遇到解析与内存问题, 需要构建层面的解法       |

与通用 Agent 框架相比, 它的差异在于: 它不是让用户自己搭一个 Agent, 而是一份开箱可用的完整产品形态, 包含终端 UI、权限审批、插件体系、远程控制与 IDE 协议接入。与官方实现相比, 它的差异在于可裁剪的编译期特性开关与可扩展的模型供应商层。同类终端 Agent 的另一种工程取舍可以对照 [pi](./pi) (极简内核 + durable 运行时)。

## 二、架构总览

整体是一条"入口快速路径分流, 命中则进完整 CLI"的结构。入口 (`src/entrypoints/cli.tsx`) 先处理一批零开销或低开销的快速路径: 版本查询 (零模块加载)、系统提示词导出、以独立 MCP 服务形态启动 (Chrome/Computer Use)、ACP 代理模式 (`--acp`)、微信渠道子命令、守护进程工作进程 (`--daemon-worker=<kind>`)、远程控制与桥接 (`remote-control` / `rc` / `bridge`)、后台会话管理 (`daemon` / `--bg`)、模板任务 (`job`)、`--tmux` + `--worktree` 组合等。只有这些都没命中, 才加载完整的主程序 `main.tsx`。

主程序用 Commander 注册 50 多条子命令 (MCP 服务管理、server、SSH、open、auth、plugin、agents、auto-mode、doctor、update 等), 主命令处理器负责权限初始化、MCP 连接、会话恢复与运行模式 (交互式 REPL / 打印模式 / SDK) 分发。

核心循环由三部分构成:

| 组件                   | 职责                                                                                |
| ---------------------- | ----------------------------------------------------------------------------------- |
| `src/query.ts`         | 主 API 查询: 发送消息、处理流式响应、执行工具调用、管理会话轮次循环                 |
| `src/QueryEngine.ts`   | 包裹 `query()` 的高层编排: 会话状态、上下文压缩、文件历史快照、归属标注、轮次级记账 |
| `src/screens/REPL.tsx` | 基于 React/Ink 渲染的交互界面: 输入、消息展示、工具权限确认、快捷键                 |

API 客户端 (`src/services/api/claude.ts`, 约 3600 行) 负责组装请求参数 (系统提示词、消息、工具 schema、beta 试验开关), 调用所选供应商的流式端点, 并把统一的事件流交给上层。

## 三、构建体系

### 3.1 Bun 打包与代码分割

构建由 Bun 的打包器完成 (`build.ts`), 入口是 `src/entrypoints/cli.tsx`, 开启 `splitting: true`, 输出一个主文件加大量分块文件, 并注入 `MACRO.*` 编译期常量 (版本号从 `package.json` 读取, 避免漂移) 与 `NODE_ENV=production`。构建后自动复制需要随包分发的 vendor 资源 (音频采集原生插件、搜索用的 ripgrep 二进制)。

为什么必须代码分割, 是这份实现里最有价值的工程结论之一。Bun 使用的 JavaScript 引擎 (JSC) 会全量解析单个大文件的字节码并做即时编译, 17MB 的单文件产物使进程 RSS 暴涨到约 1GB (同样产物在 Node/V8 下因懒解析只需约 220MB)。分割成 600 多个小 chunk (实测 627 个) 后按需加载, `--version` 这类只触及少量模块的路径 RSS 从 966MB 降到 30MB, 完整加载 (pipe 模式) 也从 1088MB 降到 318MB。这不是风格偏好, 而是被内存数据验证过的硬约束。

同时提供另一条基于 Vite/Rollup 的备选管线 (`vite.config.ts`), 同样开启代码分割, chunk 输出到 `dist/chunks/`; 构建后处理脚本 (`scripts/post-build.ts`) 对仅 Bun 支持的运行时 API 做兼容处理并复制 vendor 资源。

产物对运行时做了双向兼容: 构建后处理把 Bun 专属的 `import.meta.require` 替换为在 Node 下也能工作的等价实现 (回退到 `createRequire`), 并把第三方依赖里未加保护的 `globalThis.Bun` 解构改写为带 `typeof` 守卫的版本。因此同一份产物既可用 Bun 直接运行, 也可用 Node 运行; 包同时提供两个可执行入口 (`ccb` 走 Node, `ccb-bun` 走 Bun), 都指向同一个 `cli.js`。vendor 路径解析统一走 `src/utils/distRoot.ts` — 基于 `import.meta.url` 中最后一个 `dist` 或 `src` 目录段定位根, 保证源码运行与打包运行都能找到资源。

### 3.2 特性开关机制

代码统一通过编译期特性开关判断功能是否启用: `import { feature } from 'bun:bundle'`, 调用 `feature('FLAG_NAME')` 返回布尔值, 开关由环境变量按 `FEATURE_<NAME>` 前缀注入。构建默认启用的特性集中定义在 `scripts/defines.ts` 的 `DEFAULT_BUILD_FEATURES` (当前 35 项, 覆盖桥接模式、守护进程、ACP、工作流脚本、协调者模式、后台会话、语音模式等); 开发模式 (`scripts/dev.ts`) 以同一份清单加环境变量增量, 通过 `--feature` 旗标逐个传入。Bun 对 `feature()` 的使用位置有编译期限制: 它只能直接出现在 `if` 条件或三元表达式的位置, 不能赋值给变量、不能放进箭头函数体或逻辑与链。

这套机制的价值在于: 复原型项目需要在保留全部代码路径的同时, 按构建裁剪功能面。未启用的特性以注释形式保留在清单里并注明原因 (例如跨实例收件箱 `UDS_INBOX` 与局域网管道 `LAN_PIPES` 会导致构建后 Node 环境卡住、上下文折叠 `CONTEXT_COLLAPSE` 的实现是空壳、技能学习 `SKILL_LEARNING` 默认关闭), 需要时用环境变量显式打开, 无需改动代码。`feature()` 判定为假时, 配合条件 `require` 的写法可以让整块代码在构建期被死代码消除。

### 3.3 质量闸门

- 静态检查与格式化用 Biome, 覆盖 `src/`、`scripts/` 与全部子包。由于代码来源包含反编译产物, 42 条规则被关闭, 只保留推荐基线; `.tsx` 文件用 120 列宽加强制分号, 其他文件 80 列宽加按需分号。
- 提交时由 husky + lint-staged 钩子自动执行 `biome check --fix` 与 JSON 格式化。
- TypeScript 严格模式且必须零错误; `bun run precheck` 把类型检查、检查修复与测试串成一条命令, 任务完成后必须通过。
- 未使用的导出用 knip (`check:unused`) 检查。

值得注意的是, 这份实现对自己代码的完整度做了诚实标注: 仓库维护一张 Stubbed/Deleted Modules 表, 逐模块标注状态 (Restored 已复原 / Empty implementations 空实现 / Removed 已移除 / Simplified 简化), 例如 Analytics、GrowthBook、Sentry 三大遥测组件被明确标注为空实现、不上报不拉取。对二次开发者而言, 这比任何宣传都可靠。

## 四、核心 Agent 循环

### 4.1 消息到工具再到消息的循环

`query()` 是一个异步生成器, 内部包一个 `queryLoop` 轮次循环。一轮迭代的流程是: 取出压缩边界之后的消息 → 依次经过工具结果预算、历史修剪 (snip)、微压缩 (microcompact)、上下文折叠与自动压缩这条上下文整理管线 → 组装请求 (系统提示词、历史消息、工具定义、模型设置) → 选定供应商流式返回 → 边接收边累积文本与工具调用块 → 工具调用块流到的同时交给流式执行器开始执行 (不等整条消息结束) → 收集工具结果与排队命令附件 → 若本轮出现过工具调用 (`needsFollowUp`), 进入下一轮 → 否则以终态结束本次运行。

有两个值得注意的工程细节:

- 循环的继续/终止信号不是 `stop_reason`。代码里明确注释 `stop_reason === 'tool_use'` 不可靠 (各家实现不保证正确设置), 真正的信号是"流式过程中是否出现过 tool_use 块"。轮次的结束原因被建模成显式的联合类型: `completed`、`max_turns`、`aborted_streaming`、`aborted_tools`、`prompt_too_long`、`stop_hook_prevented` 等; 继续下一轮的原因同样显式 (下一轮、token 预算续跑、stop hook 阻塞重试、输出上限恢复等)。
- 关键设计是流式工具执行: 大多数实现会等模型把整条消息输出完, 解析出全部工具调用, 再依次执行; 这里在工具调用块刚流到时就开始执行, 把模型剩余输出时间与工具执行时间重叠起来, 长尾任务里能显著压缩墙钟时间。该行为由配置门控, 关闭时回退到批量的 `runTools` 路径。

### 4.2 工具并发调度

`StreamingToolExecutor` 维护一个被跟踪工具列表, 每项带状态 (queued、executing、completed、yielded) 与并发安全性标记。并发规则是:

| 场景                 | 行为                                                   |
| -------------------- | ------------------------------------------------------ |
| 标记为并发安全的工具 | 可以与其他并发安全工具并行执行                         |
| 非并发安全工具       | 必须独占执行, 队列遇到它就停, 等待其他工具结束         |
| 结果回吐             | 无论执行先后, 结果一律按工具调用被接收的顺序发出       |
| 进度消息             | 不进结果缓冲, 产生即刻透传, 由信号量唤醒等待中的生成器 |

并发安全性由工具自身根据解析后的入参判定 (例如读取不同文件可并发, 写入同一路径不可), 判定抛错或入参校验失败则保守地视为不安全。错误传播是选择性的: 只有 Bash 出错才中止兄弟工具 (Bash 命令常有隐式依赖链, 一步失败后续多半无意义), 被连带取消的工具收到合成的 "parallel tool call errored" 错误结果; Read/WebFetch 等相互独立的工具失败不影响其余。流式回退 (fallback) 发生时执行器提供 `discard()` — 中止在跑的子进程、清空全部缓冲并释放引用, 防止重试路径累积泄漏。

中断语义由工具级的 `interruptBehavior` 决定: `'cancel'` 表示用户提交新消息时停止并丢弃结果, `'block'` (默认) 表示继续跑、新消息排队。界面只有在所有在执行的工具都支持 cancel 时才把当前状态标记为可中断。每个工具批次会创建一个 Langfuse 追踪区间, 用于观测与成本归属。

这套设计解决的是"并发与顺序"这对矛盾: 执行可以乱序, 但呈现给模型的结果必须与调用顺序一致, 否则模型无法把结果与调用对应起来。工具调用的一般原理可以对照 [工具调用](./yukino/function-calling), 循环整体形态即 ReAct, 见 [ReAct and Agent Loop](./yukino/react-and-agent-loop)。

### 4.3 会话状态、压缩与队列

会话状态集中在 React 上下文 (`src/state/AppState.tsx` 中央状态类型与 provider)、Zustand 风格 store (`store.ts` 工厂 + `selectors.ts` 选择器) 中, 另有模块级单例 (`src/bootstrap/state.ts`) 保存会话 ID、工作目录、项目根、token 计数、模型覆盖、客户端类型与权限模式。状态更新一律通过更新函数进行, 而不是直接改对象。

上下文压缩把较早的消息替换为摘要, 并在消息流里插入 `compact_boundary` 边界标记; 读取时只取边界之后的消息 (`getMessagesAfterCompactBoundary`)。这使压缩成为视图层替换而不是破坏性存储, 保留了回溯能力。一个精细的配套设计: 压缩时会把"已发现的延迟工具集合"快照到边界标记的元数据上, 重放消息历史时从边界恢复, 避免压缩之后模型丢失工具发现记录。压缩策略的通用讨论见 [上下文压缩](./yukino/context-compaction)。

用户输入有明确的排队语义。`messageQueueManager` 提供入队、条件出队 (`dequeue`/`dequeueAllMatching`)、移除 (`remove`/`removeByFilter`)、窥视、可编辑弹出 (`popAllEditable` 配合 `isQueuedCommandEditable` 判断哪些排队项可以被弹回输入框编辑), 并通过订阅信号驱动界面更新; 轮次循环在工具执行完毕后按优先级快照排队命令, 以附件形式让模型在本轮就能看到。队列是进程全局单例, 协调者与进程内子代理共享, 每个循环只排空属于自己 agentId 的命令 — 主线程排空无归属项, 子代理只排空发给自己的任务通知。交互式界面下, 排队中的命令有专门的展示组件 (PromptInputQueuedCommands)。

## 五、工具系统

### 5.1 工具接口契约

`Tool` 类型 (`src/Tool.ts`) 的契约相当厚: 名称与别名、动态描述函数 (`description(input, options)`, 可以根据会话是否非交互、权限上下文、当前工具集动态生成)、参数 schema (zod) 或直接给出的 JSON Schema、执行函数 `call`、并发安全性判定、是否只读、是否破坏性、是否启用、中断行为、工具结果落盘阈值 (`maxResultSizeChars`, 超限后结果持久化到文件并只给模型预览与路径)、延迟发现搜索提示词 (`searchHint`, 3-10 个词的能力短语), 以及一整套渲染回调 (工具调用消息、结果消息、进度消息、拒绝与错误消息、分组渲染)。

所有工具导出统一经过 `buildTool()` 工厂, 它为常被省略的方法填充**保守默认值**: `isEnabled` 默认 true, `isConcurrencySafe` 默认 false (假定不安全), `isReadOnly` 默认 false (假定会写), `checkPermissions` 默认放行到通用权限系统。安全相关的默认值全部 fail-closed, 默认值集中在一个地方, 调用方永远不需要写 `?.() ?? default`。

描述是动态的而不是静态字符串, 这一点值得注意: 同一个工具在只读会话与可写会话里可以给出不同描述, 也可以根据当前可用工具集调整描述, 从而让模型知道哪些动作在当前上下文里是可行的。

### 5.2 工具注册与分类

工具注册表 (`src/tools.ts`) 的 `getAllBaseTools()` 是全部工具的单一事实来源, 工具实现放在独立的 `builtin-tools` 工作区包里, 按 `feature()` 开关、`process.env` 与运行时条件 (REPL 模式、工作树模式、Todo V2 等) 条件装配。主要分类:

| 类别         | 代表工具                                                                     |
| ------------ | ---------------------------------------------------------------------------- |
| 文件与检索   | Read、Edit、Write、Glob、Grep、NotebookEdit                                  |
| 执行         | Bash、PowerShell、REPL (交互式虚拟机包装)                                    |
| 子代理与任务 | Agent、TaskCreate/TaskGet/TaskUpdate/TaskList/TaskOutput/TaskStop、TodoWrite |
| 规划         | EnterPlanMode、ExitPlanMode、VerifyPlanExecution                             |
| Web 与外部   | WebFetch、WebSearch、MCP 资源列举/读取、MCP 认证                             |
| 代码智能     | LSP、Skill                                                                   |
| 调度与监控   | CronCreate/CronDelete/CronList、Monitor、Sleep                               |
| 延迟发现     | SearchExtraTools、ExecuteExtraTool、StructuredOutput                         |
| 协作         | TeamCreate/TeamDelete/SendMessage                                            |
| 环境         | EnterWorktree/ExitWorktree、Config、Artifact                                 |

装配后还有一层与提示缓存强相关的排序纪律: `assembleToolPool()` 把内置工具与 MCP 工具各自按名字排序, 内置工具保持为连续前缀再拼接 MCP 工具 — 服务端的系统提示缓存策略在最后一个前缀匹配的内置工具后放置全局缓存断点, 扁平排序会让 MCP 工具插进内置工具中间, 使下游全部缓存键失效。

### 5.3 核心白名单与延迟发现

工具数量膨胀后的选择是"白名单加延迟发现", 而不是全量注册。`CORE_TOOLS` 白名单 (`src/constants/tools.ts`, 约 29 个工具名) 里的工具 — 文件操作、执行、子代理、任务管理、规划、Web、LSP、Skill、Workflow、Sleep, 加上发现机制三件套 (SearchExtraTools、ExecuteExtraTool、StructuredOutput) — 始终加载并直接可见; 其余内置工具与全部 MCP 工具由 `isDeferredTool()` 判定为延迟工具, 单个工具可以用 `alwaysLoad: true` (MCP 侧通过 `_meta['anthropic/alwaysLoad']`) 显式退出延迟。

当前的实现是**统一的自建工具搜索**, 不再依赖任何 API 侧的延迟加载特性 (没有 `defer_loading` 字段、没有 `tool_reference` 块、没有相关 beta 头): 延迟工具的 schema 根本不进入 API 请求的 tools 数组, 只有核心工具与 SearchExtraTools 本身被发送。这样做换来一个直接的收益 — tools 数组跨轮次保持稳定, 提示缓存不会因为"发现的工具越来越多"而被撑爆。模型要用延迟工具, 走两步流程: 先用 SearchExtraTools 发现, 再用 ExecuteExtraTool 按名字调用; ExecuteExtraTool 在执行前会校验目标工具确实已被发现过 (扫描消息历史中的发现记录), 未发现则拒绝并提示正确的发现语法, 从协议上防止模型跳过发现直接猜名字。

延迟工具清单的通告有两条路径: 默认在请求前把一个 `<available-deferred-tools>` 系统提醒注入消息尾部, 且只对增量 (相对上次通告有新增) 注入, 避免每轮重复; 另一条路径用持久化的 `deferred_tools_delta` 附件消息记录增删, 供消息重放时重建"已通告集合"。两条路径都刻意规避同一个问题: 工具池变化不应该反复打破提示缓存。

### 5.4 延迟搜索的检索实现

检索是自研的**关键词加 TF-IDF 混合评分**, 没有向量:

- 关键词侧: 精确名快速路径 (裸工具名直接命中, 兼容模型不用 `select:` 前缀的情况)、`mcp__server` 前缀匹配、`+term` 必需词硬过滤, 然后按词打分 — 名称分词完全匹配 10 分 (MCP 工具 12 分)、名称子串 5 分 (MCP 6 分)、`searchHint` 词边界匹配 4 分、描述词边界匹配 2 分。
- TF-IDF 侧 (`src/services/searchExtraTools/toolIndex.ts`): 对每个延迟工具的名称、`searchHint` 与描述分别分词, 按字段权重 (名称 3.0、hint 2.5、描述 1.0) 计算加权词频, 乘 IDF 后与查询向量做余弦相似度; 名称整体包含时给 0.75 的保底分, 低于最小展示分 (默认 0.10) 的结果被丢弃。CJK 查询有专门处理: 中文按二元组分词, 至少要有 2 个二元组命中, 否则除非有 ASCII 词命中, 分数清零 — 防止"单个汉字碰巧出现"造成的高分误报。
- 融合: 关键词得分乘 0.4 加 TF-IDF 得分乘 0.6, 两个权重都可用环境变量 (`SEARCH_EXTRA_TOOLS_WEIGHT_KEYWORD` / `SEARCH_EXTRA_TOOLS_WEIGHT_TFIDF`) 覆盖。查询语法支持 `select:` 精确名 (含逗号多选)、`discover:` 只看名称/描述/schema 不触发加载、多词关键词。
- 工具描述按名字记忆化, 延迟工具集合变化时缓存键失效; TF-IDF 索引同样按集合键缓存。

同一套能力也用于提示输入框的预取建议 (`prefetch.ts`, 由 `EXPERIMENTAL_SEARCH_EXTRA_TOOLS` 开关门控): 从最近的用户消息提取查询词, 在轮次之间异步预取可能相关的工具, 界面上给出最多 3 条提示, 把"模型自己发起一次搜索往返"提前变成"用户输入时就准备好"。

### 5.5 延迟搜索的开关模式

延迟搜索由环境变量 `ENABLE_SEARCH_EXTRA_TOOLS` 控制, 支持三种模式:

| 模式     | 取值                           | 行为                                                                                                                                                    |
| -------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 始终开启 | 未设置 / true / `auto:0`       | 非核心工具一律延迟, 需要发现后调用 (默认)                                                                                                               |
| 自动     | `auto` 或 `auto:N` (N 取 1-99) | 当延迟工具定义的 token 规模超过阈值时才启用延迟, 阈值按上下文窗口的百分比配置 (默认 10%), token 计数 API 不可用时退化为字符数启发式 (约 2.5 字符/token) |
| 关闭     | false / `auto:100`             | 全部工具内联暴露, SearchExtraTools 从工具列表中移除                                                                                                     |

另有一个总开关 (`CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS`) 可以强制关闭延迟搜索。token 计数结果按延迟工具名集合记忆化, MCP 服务器连接/断开时缓存自然失效。这里有一条容易被忽略的工程细节: 阈值判定按**实际调用的模型**判断而不是按会话主模型判断, 事件里专门记录 checkedModel — 因为子代理可能使用更小的模型 (例如 haiku), 上下文窗口不同, 二者的工具搜索决策可能不同。

## 六、多 Provider 兼容层

### 6.1 供应商选择

内部供应商类型共七种: `firstParty` (Anthropic 官方 API)、`bedrock` (AWS)、`vertex` (Google Cloud)、`foundry` (Microsoft), 以及通过兼容层接入的 `openai`、`gemini`、`grok` (xAI)。选择逻辑在 `src/utils/model/providers.ts` 的 `getAPIProvider()`, 优先级是:

1. 登录流程写入设置的 `modelType` (支持 openai/gemini/grok 三值) 最高;
2. 云平台环境变量 `CLAUDE_CODE_USE_BEDROCK` / `USE_VERTEX` / `USE_FOUNDRY`;
3. 兼容层环境变量 `CLAUDE_CODE_USE_OPENAI` / `USE_GEMINI` / `USE_GROK`;
4. 都未设置时默认直连 `firstParty`。

新增供应商只需在这个函数注册, `isThirdPartyAPIProvider()` 一个谓词即可区分直连与三方。

### 6.2 流适配器模式

这是整个兼容层最重要的设计: 第三方协议格式全部通过"流适配器"转换成 Anthropic 的内部流事件格式, 下游代码零改动。适配器 (`@ant/model-provider` 包) 是一个异步生成器, 输入是供应商的原生数据块流, 输出是统一的 `BetaRawMessageStreamEvent` 事件 (message_start、content_block_start、content_block_delta、content_block_stop、message_delta、message_stop)。OpenAI 与 Grok 共用同一个适配器 (`adaptOpenAIStreamToAnthropic`, Grok 本就是 OpenAI 兼容 API, 只有客户端与模型映射不同), Gemini 有独立适配器 (`adaptGeminiStreamToAnthropic`)。

以 OpenAI 适配器为例, 它需要处理的差异包括:

- **思考内容的映射**: DeepSeek 等供应商把推理内容放在独立字段 `delta.reasoning_content` 里, 需要映射为内部的 thinking 块; 且空字符串也是有效信号 — 某些模型的思考模式会返回空推理内容, 必须原样回传一个空 thinking 块, 否则后续请求会被拒绝 (400)。
- **工具调用的增量组装**: 工具调用按 index 分片到达, 适配器为每个 index 维护一个块 (id、名称、参数缓冲), 参数片段累积并以 `input_json_delta` 增量发出, 缺失的 id 用随机 UUID 补齐。
- **内容块的开合管理**: 一段回复里思考块、文本块与多个工具块可能交替出现, 适配器负责在切换时正确关闭当前块再打开新块, 循环结束后还有一次兜底清扫, 保证没有块悬空。
- **结束原因的映射**: `stop`→`end_turn`、`tool_calls`→`tool_use`、`length`→`max_tokens`、`content_filter`→`end_turn`; 且有工具块存在时强制 `tool_use`, 不信任供应商的枚举。
- **用量统计的归一化**: 缓存读取、缓存写入与普通输入是三个不相交的分量 (输入 = prompt_tokens 减去缓存读、缓存写), 分别映射到内部字段; 最终用量在 message_delta 而非 message_start 里发出, 以捕获某些兼容端点在 finish_reason 之后才补发的尾部 usage 块。

Gemini 适配器额外处理: 思考 token 计入输出用量 (candidates + thoughts)、思考签名 (thought signature) 的回传, 以及 part 级 (text/thought/functionCall) 到内容块的切换。

把差异全部收敛在适配器里, 换来的是: 会话循环、工具执行、权限检查、UI 渲染等所有下游逻辑都不需要知道当前用的是哪家模型。

### 6.3 模型名映射

由于内部逻辑以 Anthropic 的模型家族 (haiku、sonnet、opus) 为语义基准, 接入其他供应商时需要把家族名映射到目标模型名 (映射前先剥掉 `[1m]` 长上下文后缀)。三家的优先级统一为"供应商专属覆盖 → 按家族覆盖 → 内置默认 → 透传", 细节各有不同:

| 供应商 | 解析链                                                                                                                                                             |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| OpenAI | `OPENAI_MODEL` → `OPENAI_DEFAULT_<家族>_MODEL` → `ANTHROPIC_DEFAULT_<家族>_MODEL` → 内置映射表 (sonnet→gpt-4o, opus→o3, haiku→gpt-4o-mini 等) → 原样透传           |
| Grok   | `GROK_MODEL` → `GROK_MODEL_MAP` (JSON 字符串整体替换家族映射) → `GROK_DEFAULT_<家族>_MODEL` → `ANTHROPIC_DEFAULT_<家族>_MODEL` → 内置映射表与家族默认表 → 原样透传 |
| Gemini | `GEMINI_MODEL` → `GEMINI_DEFAULT_<家族>_MODEL` → `ANTHROPIC_DEFAULT_<家族>_MODEL` → **报错**                                                                       |

Gemini 一侧更严格: 能识别出家族、却既没有指定模型也没有家族覆盖时, 直接抛错而不是猜; 无法识别家族的模型名才原样透传。此外仓库内置一份国内模型供应商预设 (`chinaLlmProviders.ts`: DeepSeek、智谱 GLM 等各家 OpenAI 兼容端点、定价、上下文窗口与 coding plan 分档), 登录界面按"选供应商 → 选 API/coding-plan 接入方式 → 选模型 → 填 key"的向导式流程使用它。

### 6.4 登录与配置

首次配置走 REPL 内的登录流程 (`ConsoleOAuthFlow`), 提供若干栏目: Anthropic 兼容端点 (任意兼容 Messages API 的服务)、OpenAI 兼容端点 (Ollama、DeepSeek、vLLM、One API、国内厂商、自建网关等)、国内供应商向导、Gemini 原生接口 (REST/SSE), 前几类的字段是基线地址、API key 与三个家族对应的模型 ID; 另有云平台栏目引导设置对应环境变量。登录成功后有一串状态刷新纪律: 清除费用状态、刷新远端托管设置与策略限额、失效用户缓存、刷新特性开关、重新注册可信设备 — 换账号时旧状态一律显式作废, 防止跨账号泄漏。

## 七、UI 层

终端渲染基于一份分叉的 Ink 框架 (`packages/@ant/ink`), 而不是原版库, 内含 components、core (渲染器、reconciler、布局、帧调度)、hooks、keybindings 与 theme。组件目录 (150 余个) 里有根 provider (应用状态、统计、帧率指标)、消息与会话行渲染、输入处理 (PromptInput 目录)、权限审批界面 (permissions 目录), 以及一组设计系统复用件 (Dialog、Byline、KeyboardShortcutHint、ListItem、ThemedText)。

状态管理方面, 中央状态与应用状态 store、默认状态工厂、轻量 store 工厂与选择器分离; 模块级单例保存跨组件的会话级信息。源码组件本身是干净的 React/TSX, 用标准 hooks (useMemo/useCallback) 做记忆化; React Compiler 的记忆化样板 (`const $ = _c(N)`) 只出现在编译后的 dist/ 产物里, 不影响设计判断。

一个值得单独记录的兼容性处理: ConPTY 之前的老版本 Windows 控制台 (build 号小于 17763) 上, conhost 的 VT 解析器处理增量更新会产生光标漂移, 残影会持续累积。实现 (`legacyConsole.ts`) 自动检测并启用兼容模式, 以约一秒 (默认 1000ms, `CLAUDE_CODE_LEGACY_CONSOLE_RESET_MS` 可调, 钳制在 100-10000ms) 的周期做一次全量重绘替代增量 diff 自愈; `CLAUDE_CODE_LEGACY_CONSOLE` 可强制关闭 (0)、强制周期重绘 (1) 或强制每帧全量重绘 (2, 牺牲闪烁换正确性)。更精细的一招是渲染宽度收缩: 老 conhost 在行写满最后一列时会立即折行 (现代终端延迟折行), 每条满宽行都会把真实光标顶偏一行, 于是兼容模式下每行少渲染一列, 让那条 buggy 代码路径根本不触发。

此外还有基于 OSC 9;4 转义序列的终端进度/状态上报 (running、completed、error、indeterminate 四态, 可带百分比), ConEmu、Ghostty 1.2+ 与 iTerm2 3.6.6+ 支持; Windows Terminal 会把该序列误解为通知而被显式排除。配套的桌面通知支持 iTerm2、Kitty、Ghostty 各自的转义协议与 BEL 响铃兜底。

## 八、平台化能力

### 8.1 ACP 接入

实现了 Agent Client Protocol 的一端 (`src/services/acp/`, 入口快速路径 `--acp`), 使 Zed、Cursor 等 IDE 可以接入; 另有独立桥接包 (acp-link) 把 WebSocket 客户端桥接到该 Agent, 支持自定义端口、HTTPS、认证、会话管理与权限模式透传。权限管道统一为一条"是否允许使用某工具"的回调, 会话模式可动态同步; 计划可视化把 TodoWrite 待办映射为计划更新消息 (sessionUpdate: 'plan'), 每条条目带状态 (pending/in_progress/completed) 与优先级。

### 8.2 守护进程与后台会话

守护进程模式由 `DAEMON` 特性开关门控, 是一个长驻 supervisor (`src/daemon/main.ts` 入口 + `workerRegistry.ts` 工作进程注册): supervisor 以 `--daemon-worker=<kind>` 派生精简的工作进程, 工作进程不加载配置与分析层, 需要什么在自己的 run 函数里初始化。后台会话 (BG_SESSIONS) 与守护进程共用 `daemon` 子命令命名空间, 提供 start/stop 与 bg/attach/logs/kill 管理, 顶层还有 `--bg` 快捷方式。

### 8.3 远程控制与桥接

桥接模块 (`src/bridge/`) 包含桥接 API、会话管理、JWT 认证、消息传输与权限回调。启动纪律有明确的检查顺序: 先验证本地有 OAuth 令牌或桥接访问令牌 (没有认证时特性开关服务拿不到用户上下文, 会返回过期的默认值), 再查运行时开关, 再查最低版本, 最后查组织策略限制。配套的自托管远程控制服务器 (remote-control-server 包, `bun run rcs` 启动) 提供 Web 控制台 (React + Vite + Radix UI), 支持 ACP Agent 经桥接包接入, 含 WebSocket 处理器、中继处理器与 SSE 事件流。用户也可以把客户端指向自部署的桥接地址。

### 8.4 构件托管

构件功能 (ArtifactTool) 让模型把 HTML 页面、数据看板或报告上传到公开地址, 并设置自动过期。服务端 (cloud-artifacts 包) 实现为 Cloudflare Worker 加 R2 对象存储: 上传接口做 Bearer 令牌鉴权、`text/html` 内容类型校验、大小上限 (默认 10MB, 环境变量可调) 与有效期选择 (仅允许 7 或 30 天); 读取接口从 R2 读取并设置 `Cache-Control: max-age=86400`; 过期由存储层的 `7d/`、`30d/` 前缀加生命周期规则实现, 计算层不参与。标识符默认用 `nanoid(21)` 高熵随机串, 也支持自定义 hash (覆盖语义为先删各前缀下旧键再写新键)。部署只需标准脚手架加两条命令 (建桶与生命周期规则的 setup、deploy)。这套服务是独立部署的, 不被主 CLI 导入。

### 8.5 消息渠道接入

除终端、IDE 与远程控制外, 主程序还有一条"消息渠道"通路: 会话可以挂接到即时通讯平台, 让外部消息进入会话、把权限审批请求发到渠道上。渠道以带 channel 能力的 MCP 服务器形态接入 (服务器必须声明 `capabilities.experimental['claude/channel']`), 用 `--channels` 标志按名字组成允许清单, 在交互式与打印/SDK 模式下都可用。权限审批在渠道上是结构化事件而非文本: 服务端解析用户的确认回复后, 必须刻意发出带请求 ID 与行为结论的权限通知 (声明 `claude/channel/permission` 实验能力才参与审批), 主程序才认账 — 纯文本回复不构成批准。裁决是竞速模型: 渠道回复与本地界面、桥接、钩子、分类器几路同时注册 resolver, 先到达者通过 claim 赢得这次裁决, 后到者静默失效。仓库内置一份微信渠道集成 (weixin 包), 以默认启用的内建插件形态注册: 它起一个 stdio MCP 服务接收微信消息并暴露回复与输入状态工具, 用独立的登录命令配置账号, 再按会话用渠道标志启用。

## 九、Monorepo 包结构

Bun workspaces 按职责划分, 主 CLI 依赖其中一部分:

| 包                           | 说明                                                                        |
| ---------------------------- | --------------------------------------------------------------------------- |
| `@ant/ink`                   | 分叉的 React 终端渲染框架 (components、core、hooks、keybindings、theme)     |
| `@ant/model-provider`        | 供应商定义、模型映射与流适配器                                              |
| `builtin-tools`              | 全部内置工具实现 (60 个工具目录)                                            |
| `agent-tools`                | 子代理相关工具                                                              |
| `mcp-client`                 | MCP 协议客户端库                                                            |
| `acp-link`                   | WebSocket 到 ACP 的桥接服务                                                 |
| `remote-control-server`      | 自托管远程控制 Web 控制台                                                   |
| `cloud-artifacts`            | Worker + R2 的无服务器上传服务                                              |
| `@ant/computer-use-*`        | 截图、键鼠、剪贴板与应用管理 (input/swift/mcp 三包, 各平台后端)             |
| `@ant/claude-for-chrome-mcp` | Chrome 浏览器自动化 MCP 服务                                                |
| `workflow-engine`            | 确定性 JS 脚本编排引擎, 核心层零运行时依赖, 通过端口适配器与外界交互        |
| `weixin`                     | 微信消息通道集成, 内建插件形态注册, 提供收消息与回复的 MCP 服务             |
| `*-napi`                     | 原生插件: 音频采集、图像处理、颜色差异计算、键盘修饰键检测、URL scheme 处理 |

workflow-engine 值得单独一提: 编排脚本是普通 JS 函数体 (以 `new AsyncFunction` 包装执行, 不经转译器, 连 TS 类型语法也会被拒绝), `agent()`、`phase()`、`parallel()`、`pipeline()` 等原语作为参数注入; 所有非确定性来源 (LLM、文件系统、时钟) 被隔离到端口后面, 同一份脚本每次重放产生相同的 journal — 编排本身因此是确定性、可重放、可测试的。

## 十、工程纪律

- 测试框架用 Bun 自带测试; 单元测试就近放置于 `__tests__/`, 集成测试单独成组 (`tests/integration/`), 共享 fixture 集中在 `tests/mocks/`。
- Mock 规范严格: 只 mock 有副作用的依赖链, 不 mock 纯函数; 日志与调试模块必须使用共享 mock, 源文件导出变更时只改共享 mock 一处。
- 有一个重要的测试陷阱被系统性总结: Bun 的 `mock.module` 是进程全局的 (last-write-wins), 一个测试文件的 mock 会污染同进程其他文件, 且测试执行顺序不保证。核心规则是"不要 mock 被测模块的上层业务模块", 集成测试应 mock 底层 HTTP 客户端 (axios) 而非源 API 模块, 从而保证同目录的单元测试仍能测到真实逻辑。
- 类型纪律: 生产代码禁止 `as any`, 优先用 `as unknown as T` 双重断言或补 interface; 未知结构用 `Record<string, unknown>`; 联合类型用类型守卫收窄, 不强转。
- CI 覆盖静态检查、构建与测试, 另有远程控制服务器发布等独立工作流; CI 里 `biome ci` 必须零警告。
- 提交信息遵循约定式提交规范; 另用 knip 检查未使用的导出。
- 仓库还维护一份内存峰值分析文档, 把每个已修复/待修复的内存热点标注到文件与行号, 并列出被证伪的怀疑项 — 性能结论有据可查。

## 十一、适用与不适用

适合的场景:

- 需要在终端里获得完整的 Agent 编码体验, 同时要求能接入多家模型供应商或自建网关;
- 需要自托管远程控制界面或构件托管服务, 而不是依赖厂商托管;
- 想在一个成熟的产品级代码库上做二次开发, 且能接受反编译产物带来的可读性代价。

不适合的场景:

- 只要一个轻量可嵌入的 Agent 内核, 不需要终端 UI、权限审批与插件体系: 这份实现体量偏大;
- 需要厂商级别的稳定 API 契约与长期支持: 复原型项目的接口稳定性弱于官方;
- 对遥测与特性开关的默认行为有严格合规要求的场景: 需要预置环境变量裁剪。

与替代方案的取舍:

| 方案            | 优势                       | 代价                                  |
| --------------- | -------------------------- | ------------------------------------- |
| 官方 CLI        | 稳定、完整、官方支持       | 供应商选择受限, 不可自托管扩展        |
| 本实现          | 多供应商、可裁剪、可自托管 | 代码可读性差, 接口稳定性弱            |
| 从零自建        | 完全可控, 体积最小         | 需要自行实现循环、并发调度、权限与 UI |
| 通用 Agent 框架 | 抽象清晰, 生态广           | 没有成品终端产品形态, 需要自行搭建    |

## 十二、小结: 可借鉴的工程点

1. 大型 CLI 必须代码分割。这是被内存数据验证过的硬约束: JSC 全量解析下, 单文件产物的常驻内存可以是分割后的数倍到数十倍。
2. 编译期特性开关加环境变量注入, 让一份代码支持按构建裁剪功能面; 关闭的开关在清单里注明原因, 条件 `require` 配合死代码消除让未启用的代码不占产物。
3. 第三方模型协议统一走流适配器, 把异构格式收敛到内部格式, 下游零改动; 适配器里最容易被忽略的是"空思考块也是有效信号"与"尾部 usage 块要等到 message_delta 再报"这类协议边角。
4. 工具数量膨胀后用"核心白名单加延迟发现": 延迟工具干脆不进 API 请求, tools 数组跨轮稳定, 提示缓存友好; 发现记录随消息历史持久化, 压缩时快照到边界标记上跨压缩存活。
5. 流式工具执行把模型剩余输出时间与工具执行时间重叠; 结果仍按调用顺序回吐, 错误传播按工具语义分级 (只有 Bash 连坐), 兼顾延迟与正确性。
6. 工具契约的安全默认值全部 fail-closed (默认非并发安全、默认非只读), 由统一的构建工厂集中兜底。
7. 权限裁决做成多路 resolver 竞速、先到者赢得, 渠道/界面/钩子/分类器共用同一套 claim 语义, 是分布式审批的干净解法。
8. 在缺乏稳定外部契约时, 用"进程全局 mock 的污染纪律"保证测试隔离, 是一条值得写进规范的经验。
