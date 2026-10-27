---
title: "Pi Agent Harness: 极简内核、树形会话与 durable 运行时"
description: "拆解 Pi 的设计与实现: 极简内核与扩展机制的边界、entry 树会话模型、TypeScript SDK 的进程内嵌入、durable 运行时的持久化不变量与执行环境抽象、pi-env 的远程执行协议、chord 应用组合运行时与遥测落库、codemode 的沙箱化脚本执行、统一 provider 面与容器化、五种接口形态与 TUI 渲染工程"
local_path: "$HOME/Downloads/pi"
---

Pi 是终端里的极简、可扩展编码 Agent harness。它的设计立场非常明确: 内核只保留最小能力, 其余一切通过扩展、技能、提示模板、主题与自定义 provider 加入, 打包为 Pi package 分发。与 CLI 并行的还有三条实验性库线: durable 做"先提交存储再展示"的持久化运行时, chord 为 durable 提供复制状态与热重载的应用组合基座, pi-env 把工具执行经 SSH 部署的 Rust 守护程序落到远程机器。本文按机制而非目录来组织, 讲清这套极简内核如何支撑树形会话、如何被 TypeScript 进程直接嵌入、durable 的持久化不变量与执行环境抽象、pi-env 的帧协议、chord 的对象/引用/重载模型、codemode 如何把模型写的脚本关进沙箱, 以及 provider 与沙箱体系为何全部外置。读者应熟悉至少一个编码 Agent 的交互形态 (如 [Codex CLI](codex) 或 [Claude Code](claude-code)), 并对 Node、TypeScript 与终端程序有基本认识。

本文描述的是当前代码库的机制, 不涉及版本演进与发布记录; 其中标注为实验性的部分是维护者自己声明会随时变动的接口。

## 一、极简内核哲学与扩展机制

### 1.1 内核边界

贡献指南的第一句是 "pi 的内核是最小的"。不属于内核的功能应当做成扩展, 试图膨胀内核的 PR 会被拒绝; 就连扩展的 hook 点也要经过慎重讨论, 以免引入不可维护的复杂交互。配套的一条规则是 "你必须理解你的代码": 用 AI 写代码可以, 但不理解就提交不行。

这条哲学的直接后果是: sub-agent、plan mode 这类能力刻意不放进内核。内核提供强力默认, 同时给用户两条路——指挥 Pi 自己生成所需能力, 或安装现成的 Pi package。扩展不只是插件系统, 它是内核主动让位的结果。

内核的自我描述是最小集 (read、write、edit、bash 加会话管理), 但实际工具面更宽: 还包括 find、grep、ls 与 powershell。所有文件变更经专门的队列串行化, 扩展自己的文件写操作也可以挂进同一队列, 避免并发工具调用互相踩踏。

### 1.2 资源阶梯七层

快速上手文档维护一张"从最弱机制开始"的选择表, 复杂度递增:

| 需求                         | 使用                    |
| ---------------------------- | ----------------------- |
| 文件夹级持久指令             | `AGENTS.md`             |
| 复用菜单里的提示             | prompt template         |
| 任务专属指令加附件           | skill                   |
| 可执行的工具、命令、事件处理 | extension               |
| 自定义终端组件               | Terminal UI             |
| 接入未支持的模型服务         | custom provider         |
| 打包分发多种资源             | Pi package (npm 或 git) |

这张表的价值在于它把"该用哪一层"变成工程决策而非偏好: 能用更弱的机制解决就不上扩展。

### 1.3 扩展机制

扩展是加载进 Pi 进程的 TypeScript 模块 (经 jiti 加载)。工厂函数可以注册工具、命令、快捷键、provider、事件处理器、渲染器与终端 UI, 并声明一组面向运行时的能力:

- **生命周期事件**覆盖面很长: `input`、`before_agent_start`、`agent_start`、`turn_start`、`context`、`context_with_system`、`before_provider_headers`/`before_provider_request`、`after_provider_response`、`provider_stream_event`、`message_update`/`message_end` 等消息事件、`tool_execution_start`/`tool_execution_end`、`tool_call`、`tool_result`、`turn_end`、`agent_end`、`agent_before_settle`、`agent_settled`、`session_start`/`session_shutdown`、`session_before_switch`/`session_before_fork`、`project_trust`、`resources_discover`、`user_bash`、`cache_warming_decision`。
- **工具暴露级别**分五档: `direct` (进上下文)、`model-only`、`codemode` (只对脚本可见)、`deferred` (不预载, 由 tool search 按需加载)、`hidden`。
- **命名与元数据**: 工具可声明 namespace 与 annotations (MCP 风格的 hints), 扩展可用 `prepareLoadout` 参与工具装载, 用 `reachesTools` 声明自己是否会触达工具。
- **嵌套工具调用**: 扩展经 `ctx.executeTool` 直接调工具并可嵌套, 嵌套调用的 id 形如 `<父调用 id>/<序号>`; 嵌套记录有界——单条调用 8 KiB、单条结果 32 KiB、总计 256 条。
- **结构化输出**: 工具可声明 `outputSchema` 并以 `structuredContent` 返回, 供脚本与下游消费。
- **可替换**: 注册时声明 `replaceable: true`, 当别的扩展注册同名工具、命令或旗标时自动让位而非冲突。

仓库内置四个扩展, 与用户扩展走同一注册面: `llama.cpp` (本地模型, 不可替换)、`codemode`、`tool-search`、`mcp` (三者均为 `replaceable: true, builtin: true`), 对应设置键 `builtin:llama.cpp`、`builtin:codemode`、`builtin:tool-search`、`builtin:mcp`。内核没有为特性保留特殊通道。

### 1.4 内核纪律的外化

极简哲学还体现在代码与供应链约束上:

- 只用可擦除的 TypeScript 语法, 以配合 Node 的 strip-only 模式——禁用 enum、namespace、parameter properties 等需要 JS emit 的构造; 禁止内联动态 import, 只允许顶层 import。
- 键位不许硬编码, 必须进默认键位表以保持可配置; 生成的模型数据文件不许手改, 必须改生成脚本后重新生成。
- 多会话并发开发有明确纪律: 同一工作目录可能同时跑多个会话, git 只允许 stage 显式路径, 禁止 `git add -A`、`reset --hard`、`checkout .` 之类会波及其他会话的操作。
- 供应链加固成体系: `.npmrc` 设 `save-exact=true` 且 `min-release-age=2` (拒绝发布不足两天的包, 缩小投毒窗口); 安装锁文件由脚本生成并对依赖的 lifecycle script 做显式 allowlist; CI 以忽略脚本的方式安装; 改 lockfile 需要显式设置 `PI_ALLOW_LOCKFILE_CHANGE=1`。

这些约束与内核最小化是同一取向: 把可变性与不确定性挤到边缘。

### 1.5 monorepo 包布局

| 目录                  | npm 包                          | 职责                                                                          |
| --------------------- | ------------------------------- | ----------------------------------------------------------------------------- |
| packages/agent        | @earendil-works/pi-agent-core   | 通用 agent 运行时: 消息状态、事件流、工具执行 (并行/串行)、传输抽象与附件支持 |
| packages/ai           | @earendil-works/pi-ai           | 统一多供应商 LLM API、生成式模型目录、faux 测试 provider                      |
| packages/coding-agent | @earendil-works/pi-coding-agent | 终端 CLI 与 TypeScript SDK, 内置四个扩展                                      |
| packages/tui          | @earendil-works/pi-tui          | 差分渲染终端 UI 库                                                            |
| packages/mcp          | @earendil-works/pi-mcp          | 独立 MCP 客户端: stdio/Streamable HTTP/内存传输与 OAuth, 不依赖官方 SDK       |
| packages/codemode     | @earendil-works/pi-codemode     | QuickJS/WASI 沙箱, 唯一运行依赖是 quickjs-wasi, 无任何 pi 依赖                |
| packages/durable      | @earendil-works/pi-durable      | 持久化会话、任务与文档运行时 (实验性)                                         |
| packages/chord        | @earendil-works/chord           | 类型化宿主运行时: 契约、复制状态、热重载、JSON 链路上的 RPC 与 SQLite 遥测    |
| packages/env          | @earendil-works/pi-env          | 远程执行环境: SSH 部署的 Rust 守护程序及其 ExecutionEnv 客户端                |
| packages/telemetry    | @earendil-works/pi-telemetry    | 厂商中立的遥测契约、参考实现与类型化 schema                                   |
| packages/evals        | @earendil-works/pi-evals        | 私有评测套件, 不发布                                                          |

依赖方向很说明问题: coding-agent 依赖 agent-core、ai、codemode、mcp、tui, 但**不依赖** durable、chord 与 env; durable 依赖 chord、ai、codemode、telemetry 以及 photon (图像处理)、diff、typebox; env 依赖 durable (取 ExecutionEnv 接口) 与 chord; chord 依赖 typebox 与 pi-telemetry; agent-core 依赖 pi-ai 与 typebox; telemetry 无运行依赖。CLI 线与 durable 线共享 ai 和 codemode, 其余互不依赖——durable 是独立的库级产品面, 不是 CLI 的子系统。coding-agent 的 `AgentSession` 构建在 pi-agent-core 之上: 通用循环、消息/工具事件序列、`transformContext` 变换与工具并行/串行执行都来自 agent 包, coding-agent 在其上叠加会话树、资源加载与工具实现。

## 二、树形会话模型

### 2.1 entry 树与 active branch

会话不是线性的消息数组, 而是一棵树。持久化格式是 JSONL v3, 天然追加友好: 分支不要求改写历史, 只追加指向旧 entry 的新 entry。每个 entry 有 id 并指向父 entry; 每条路径是一个分支, 以当前 entry 结尾的分支是 active branch, 为下一次模型请求提供历史。

entry 是一组判别联合, 共享树结构: 会话头、message (含系统消息)、`thinking_level_change`、`model_change`、`usage`、compaction、`context_edit`、`branch_summary`、custom、custom_message、label、`session_info`。几个值得展开:

- **系统消息**携带 `content` 与 `sections` (有序命名补丁, 值为 null 表示移除段落), 以及 `toolsAdded`/`toolsRemoved` (先删后加), 是"在 transcript 里修改系统提示与工具面"的持久化手段。
- **compaction** 存摘要, 必须带 `firstKeptEntryId` 指向它保留的第一条 entry, 还可带一个 `systemMessage` 检查点。
- **context_edit** 是对单条 entry 的上下文级编辑覆盖: `{ target: entryId }` 加 `omit` (从上下文里略去) 或 `replace` (用给定消息替换)。

关键的语义差别在于"从更早处继续": 它不会删除后续 entry, 只是把 leaf 指针移回更早的 entry, 之后追加的内容在同一文件里长出新分支; 只有 fork 与 clone 才把选中的历史拷进新的会话文件。实现上对应 `SessionManager.branch()`、`branchWithSummary()` 与 `createBranchedSession()` (packages/coding-agent/src/core/session-manager.ts), 上下文读取则由 `buildContextEntries`/`buildSessionProjection` 一类纯函数从树投影出来。

### 2.2 agent loop 与三种输入语义

一次提交的消息加入 active branch; Pi 用 system prompt、active branch、可用工具与模型设置组装请求, 经选定 provider 流式返回; 记录响应 (文本与工具调用), 执行工具并记录结果, 这算一个 turn; 若工具结果或排队消息还需要模型请求就再来一轮, 否则 run 结束。

工具批的执行语义是显式的: 默认并行——预检 (preflight) 按声明顺序串行跑, 完成事件按实际完成顺序发出, 结果仍按声明顺序回到模型; 可以把整批切成串行, 单个工具声明 `executionMode: "sequential"` 也会强制整批串行。

三种输入语义被区分得很清楚:

```text
steering   在当前 assistant turn 之后插入
follow-up  在 agent 做完 pending 工作后进入
abort      停止当前 run 并把排队消息退回编辑器
```

这种区分让"用户在 agent 工作中途插话"与"用户要求 agent 完成后接着做"不再混为一谈。

### 2.3 上下文组装

system prompt 由基础指令与发现的 context files 构成; 请求携带工具定义与技能描述; 技能的完整指令按需加载, 而不是全部预载。扩展可以追加指令或变换上下文——`context` 事件把会话消息数组交给处理器 (不含 prompt 与工具系统消息), 处理器可返回新数组或就地修改; `context_with_system` 才交出含系统消息的完整 transcript。prompt 模板在编辑器输入变成 user 消息之前展开; 选中文件、图片、粘贴文本、shell 输出都可以成为消息内容。

### 2.4 compaction 是视图不是存储

压缩会插入一条摘要 entry, 在后续模型请求中替换更老的消息, 但原始 entry 全部保留在会话树里。这是整套模型里最值得强调的取舍: 压缩是有损视图, 不是有损存储。用户仍然可以回到被压缩的分支继续工作, 历史可回溯性没有因为压缩而丢失。

### 2.5 会话管理与 shell 环境

默认会话按工作目录分组存放于用户级 agent 目录; 命令行参数 (`PI_CODING_AGENT_SESSION_DIR` 等环境变量) 与 SDK 设置都可改位置。相关开关包括: 跑临时会话 (退出即不可恢复)、直接指定路径或 ID、启动前从既有会话分叉、打开当前目录最近的会话。导出支持 HTML 与 JSONL; 分享可上传为带查看链接的产物或私有 gist, 目标可用设置固定。另有生成私有 bug 报告的路径, 报告包含环境与 provider 配置但不含凭据值。

Pi 还会把会话身份注入它启动的 shell: `PI_SESSION_ID`、`PI_SESSION_FILE`、`PI_PROVIDER`、`PI_MODEL`、`PI_REASONING_LEVEL`, 外加标记 `AI_AGENT=pi` 与 `PI_CODING_AGENT=true`, 让 shell 内的工具能识别自己跑在哪个会话里。文档反复提醒: 导出与分享之前必须自查, 内容可能包含提示、模型回复、工具参数、命令输出与文件内容。

## 三、TypeScript SDK 的嵌入方式

### 3.1 createAgentSession 与依赖注入面

包可以直接作为库嵌入 Node 或 Bun 进程, 拿到与 CLI 同款的 agent、session、工具、模型与资源。创建会话的每个默认件都可显式替换: 模型运行时 (`modelRuntime`)、模型与思考级别 (`model`、`thinkingLevel`、`scopedModels`)、设置管理器 (`settingsManager`)、会话管理器 (`sessionManager`)、资源加载器 (`resourceLoader`)、工具集 (`tools`/`noTools`/`excludeTools`/`customTools`)。默认资源加载器支持标准发现加定点覆盖 (扩展、技能、模板、主题、AGENTS 文件、系统提示各有覆盖钩子); 完全自管资源可以传自定义加载器。CLI 自己用的就是同一套创建逻辑, 因此 SDK 不是附属品, 而是内核的另一种入口。

### 3.2 SessionManager 是上下文的权威

`SessionManager` 持有持久化或内存的 entry 树并跟踪 active leaf。它是"最终模型上下文"的唯一权威: 直接给会话的 agent 状态赋消息数组不能替换持久化上下文; 要恢复外部历史, 必须构造带这些 entry 的 manager。`inMemory()` 用于不落盘场景。这条约束划清了视图与真相源的边界。

### 3.3 AgentSessionRuntime

`AgentSessionRuntime` 提供四类操作 (packages/coding-agent/src/core/agent-session-runtime.ts): `newSession()`、`switchSession()`、`fork()` 与 `importFromJsonl()`。每次操作都会替换活跃的 AgentSession 并为目标工作目录重建服务, 触发 `session_before_switch`/`session_before_fork` 事件; 替换后旧的事件订阅失效, 需要重新绑定。分叉还区分位置: `"before"` (在选中 entry 之前) 与 `"at"` (包含选中 entry)。实现上它持有一个运行时工厂, 每次重建时以目标工作目录、会话管理器与必要的信任上下文重新构造整套服务, 这让"换工作目录继续"成为一等操作。

### 3.4 prompt 语义与事件

`prompt()` 先处理扩展命令、展开基于文件的 prompt 模板, 再让普通用户消息进入 agent; 对已被接受的 run, 返回的 promise 在该 run (含自动重试) 结束后 resolve。会话正在流式输出时再发 prompt 必须显式选择 steer 还是 follow-up, 不选直接 reject 而不是猜; `steer()`/`followUp()` 返回 `"queued"` 或 `"handled"` 表明消息的去向。abort 停止并等待空闲, 另有一个"只等不停"的等待接口。

事件订阅区分层次: `message_update` 提供增量文本 (含 assistant 消息事件), `message_end` 是权威的完整消息, `agent_end` 表示一次底层 run 结束 (后面可能还有自动恢复或排队工作), `agent_settled` 表示 Pi 确定不再自动继续。把"run 结束"与"彻底空闲"分开, 是编排者能正确判断下一步的前提。

### 3.5 内置扩展与 MCP 启动时序

CLI 会把注册面里的内置扩展默认加载 (codemode、tool-search、MCP 与提供本地模型的 llama.cpp), SDK 会话一个都不加载; 要让 SDK 会话拿到前三者的能力, 需把对应扩展工厂 (`createCodemodeExtension`、`createToolSearchExtension`、`createMcpExtension`) 加进 DefaultResourceLoader 的 `extensionFactories`, 并对会话 `bindExtensions()`。其中 codemode 与 tool-search 注册为非活跃, 通过默认工具设置或 MCP server 的暴露策略激活; codemode 调用不依赖当时的活跃工具集, 因此在树导航、恢复与分叉后仍然可用; tool-search 加载的工具会记录进 transcript, 在该分支上保持声明。

MCP 扩展在会话启动时连接 server, 但这个连接不阻塞首个 prompt: 只等待带 `direct` 工具的 server (限时 10 秒, `DEFAULT_STARTUP_WAIT_MS`), 其余后台连接, 脚本与延迟发现的工具在真正用到时按需等待。仓库的 SDK 示例全部随仓库类型检查, 既可当文档也可当回归测试。

## 四、durable 运行时的持久化设计

### 4.1 核心规则与不变量

durable 是一个实验性的持久化 agent harness, 构建在 pi-ai (模型访问) 与 chord (文档状态) 之上。规范文档给出的核心规则是: "一个 Session 原子地提交不可变 entry、完整 task 记录与 Chord 跟踪的文档。只有已提交状态可观察。标记为 deferred 的提交可以先被观察到, 再落存储。"

最小用法展示了它的工作形态: `Harness.open()` 在存储上打开 Session, `harness.root()` 返回根 conversation, `root.submit()` 持久受理输入并返回 Submission, 内置的 generation 任务调用模型追加答案, `submission.wait()` 等到回答完成; `harness.resume()` 续跑上个进程未完成的 run。每个异步调用都携带 chord 的 Context 以承载取消。

配套的八条不变量值得逐条看:

1. 一次 Session 提交对所有记录与文档写入是原子的。
2. 文档更新只在存储提交成功后发布。
3. 所有可见进度都是持久的——唯一的例外是 deferred 提交窗口 (见下)。
4. 外部副作用不在提交事务内运行。
5. entry 与 ID 不可变, 提交后不复用。
6. 草稿在事务回调结束时被同步准备或中止, 写入草稿的值按值拷贝且必须是严格 JSON。
7. 变更线在存储结算与已提交状态采纳期间保持持有; 提交与关闭观察者同步运行只为捕获不可变状态。
8. 存储错误对打开的 Session 是致命的: 它不发布任何内容, 必须重新打开。

第 3 条的例外是显式的提交选项: 提交可以带 `{ persistence: { kind: "deferred", withinMs } }`, 此时状态先对观察者可见, 存储必须在 `withinMs` 窗口内把它持久化。这是整套系统里唯一允许"观察先于落盘"的路径, 其余一切仍是先提交再展示。

错误分级同样明确: 存储错误对打开的 Session 致命, 以 SessionFailed 呈现并体现在 `harness.closed` 上; `StorageRequestError` 只拒绝当次读请求, 不伤会话; 单个任务/文档的失败也不扩散。

### 4.2 记录模型

规范用一组明确的概念划分层次:

| 概念         | 含义                                                                     |
| ------------ | ------------------------------------------------------------------------ |
| Session      | 拥有一条变更线、若干会话、entry、task、提交请求 (submission) 与文档      |
| conversation | 一个 transcript 作用域, 可以分叉另一个 conversation                      |
| entry        | 不可变的 transcript 记录, 可携带贡献给模型上下文的消息与供应用消费的数据 |
| task         | 附着在某个 conversation 上的持久状态机                                   |
| document     | 由 chord 操作与偶发完整基底表示的可变 JSON 状态                          |
| turn / run   | 一个 assistant 响应及其工具调用 / 从受理输入到最终答案的轮次序列         |

entry 记录 (`EntryRecord`) 把"面向模型的消息"与"面向应用的数据"分开存放: `kind` 与可选 `model` 标识消息, `data` 存应用数据, `head` 指向它选中的上下文首 entry (草稿阶段允许 `"self"`), `edits` 挂上下文编辑覆盖 (omit/replace), `byTaskId` 记贡献者。分叉在记录模型里是显式操作: conversation 记录指向父 conversation 与分叉点 entry (`{ conversationId, at }`), owner 字段表示任务归属而非访问控制; 根会话 ID 是常量 `ROOT_CONVERSATION_ID = 1`。提交请求 (`SubmissionRecord`) 对输入区分 queued/placed/done/unanswered, 未回答的输入带原因。ID 是编译期品牌类型, 运行期就是字符串。

### 4.3 存储后端与并发

| 后端                      | 特性                                                                                                |
| ------------------------- | --------------------------------------------------------------------------------------------------- |
| Memory                    | 不持久化, 是参考语义                                                                                |
| IndexedDB                 | 浏览器端存储                                                                                        |
| SQLite                    | 单数据库文件, WAL 模式配 `synchronous=NORMAL`: 进程崩溃后提交仍在, 最新提交在断电或宿主失败时可能丢 |
| JSONL                     | 单目录追加文件, 可配置每次提交 fsync; 全部历史留在内存, 长跑 agent 应选 SQLite                      |
| Cloudflare Durable Object | 单个 SQLite 型 Durable Object 的存储, 一次提交即其存储事务                                          |

一个存储同一时刻只被一个进程拥有, 没有跨进程锁; 提交采纳 (`adopt(seq)`) 是同步发布。SQLite 存储可用前缀给表与索引命名空间化 (如 `{ prefix: "pi_" }`), 便于共享数据库; 多个 Pi 存储共用一个 Cloudflare 存储对象时自动共享操作队列。可移植的 SQLite 与 JSONL 核心不依赖 Node API, 只要给定异步的数据库 facade 或文件系统, 就能跑在 Bun 或 Cloudflare Durable Objects 之类的运行时上。自定义后端与自定义执行环境可以分别跑 `registerStorageConformance()`/`registerEnvConformance()` 的一致性测试套件。包根因工具参数校验引入 TypeBox, 未打包约 23 MB 峰值 RSS, tree-shaken 后约 4 MB。

### 4.4 重启限制与睡眠

任务的重启次数有预算: `restartLimit` 默认 5, 超限的任务被 park (原因记为 `restart_limit`), 不再自动续跑; `retryTask()` 可以显式复活。任务还可以声明睡眠: `sleepUntil` 把它放进 sleeping 阶段, 到点经 `onWake`/`wake()` 唤醒——在 Cloudflare Durable Objects 上这就是 alarm 的接入点。这两个机制让"长跑、可暂停、可恢复"成为运行时的一等状态而不是宿主自造的轮询。

### 4.5 compaction 与 overflow

压缩把模型看到的内容缩小: 总结更老的 entry, 追加一条压缩 entry 持有摘要并指向它保留的第一条 entry, 更老的 entry 留在存储里。手动压缩以任务形态运行, 可附指令, 可被中止取消; 摘要生成期间会话继续工作, 摘要在会话空闲时立即放置, 否则在下一个轮次边界放置。

自动压缩按会话设置, 默认阈值: 距保留量还差 `backgroundTokens` (32768) 时在后台启动, 超过上下文窗口减去 `reserveTokens` (16384) 时下一次请求同步等待压缩, 摘要保留约 `keepRecentTokens` (20000) 的近期内容。阈值可以按 `provider/modelId` 逐模型覆盖, 让一个 harness 同时伺候 32k 与 1M 窗口的模型。provider 以上下文过长拒绝请求时触发溢出压缩并重试一次。多个摘要并发时由 stale 规则裁决: 切到当前活动上下文开始之前的摘要在放置时落为 stale。压缩任务上有 `beforeCompact` hook 可以拒绝或自供摘要; 运行中的压缩暴露在活动文档里, 含原因、尝试次数与重试退避; 摘要开销计入用量统计。

### 4.6 工具面与执行环境

工具用 `defineTool` 注册: TypeBox 描述参数, 可声明 `replay: "safe"` (允许跨重启重放)、`structuredOutput`、`abandonOnRestart`、`callers`、`modelTools`、`deferred` (配合内置 tool-search 按需加载)。工具实现拿到的 api 支持嵌套调用 (`api.executeTool`, 以 key 在重启后把调用重新接上)。内置工具是 read、write、edit、bash 加一组 CodingTools; durable 侧 bash 的结构化结果是 `{ output, truncated, fullOutputPath?, exitCode }` (camelCase, 与 coding-agent 里 codemode 沙箱的 snake_case 结果区分)。图像处理经 Photon: `createNodePhotonImages` 起一个 worker 线程做缩放/转码 (空闲 30 秒回收), 默认上限 2000x2000、4.5 MB。

"工具在哪台机器上跑"抽象成 ExecutionEnv (文件系统与 shell 两个接口的合集)。`HarnessOptions.env` 是一个构建器: 每次工具调用、段落渲染与显式取环境时, 以目标 conversation 的当前 cwd 与已提交读权限现场构建, 可以异步, 永不跑在 Session 变更线上; 没有配置环境时内置工具以错误结果失败, 构建器抛错则成为该调用的错误结果。环境对象本身便宜, 每次调用新建也无妨——edit 与 write 按"环境 id + 规范路径"串行化对同一文件的变更, 因此同 id 环境必须看到同一文件系统; 自定义环境要设好 id, 比如一个容器一个 id。于是"这个会话的工具进容器、那个会话进远程机"成为配置而非改码。

宿主也可以直接用环境: `openBinaryReader()` 按字节范围读已打开文件, `openDirReader()` 分页读目录, `exec()` 带 argv 数组不经 shell 跑程序并标注每个输出块的流。可选的 `listFiles()` 像 `fd --hidden --exclude .git` 那样列出目录下的树 (不跟随符号链接, 跳过 git 忽略项), 受条目数、字节数与超时约束并带 truncated 标记。默认参考实现 `NodeExecutionEnv` (durable/env/node) 不实现 `listFiles`, 由 pi-env 补上。

### 4.7 观察面与内置文档

durable 的可见状态组织成五类内置文档: `pi.agent` (会话的 agent 配置: 模型、思考级别、扩展与工具选择、指令、工作目录, 存为可回退历史的文档, 任务拥有的会话复制 owner 的配置)、`pi.provider` (provider 侧身份)、`pi.live` (进行中的 run 与工具槽位, 含 codemode 嵌套调用展示)、`pi.inbox` (输入受理队列)、`pi.usage` (用量)。

观察接口是 watch: `harness.watch()`/文档 watch 返回 `{ value, ops, retired }`——`value` 是当前视图, `ops` 是 chord 的精确操作而非要求消费者自己 reduce 的快照, `retired` 标记文档被退役。待投递操作超过 10,000 条折叠后, 改为投递一次根替换 `[["r", view]]`。会话、任务图与单个文档各有 `observeConversation`/`observeTaskGraph`/`observeDoc`。另有实验性的 `watchEvents`, 把 agent 事件流以 watch 形式重放, 落后超过 100 个批次时退化为快照。

### 4.8 文档定义与 task graph

应用文档用 `defineDoc` 定义: 历史语义选 `latest` (只跟最新值) 或 `rewindable` (可回退), 分叉行为选 `initial`、`current` 或 `asOf`, `checkpointWhen` 决定何时写完整检查点而非操作。

task graph 视图把每个活任务挂成可观察状态或 watch, 状态机为 pending/running/waiting/completing, 含 owner 边、已提交状态、后台与中止标记、拥有的会话; 重启后 running 落回 pending 再被调度。子代理就是任务所有权的组合: 新 conversation 的 owner 记为 `{ kind: "task", taskId }`, 加 `background: true` 即后台跑。任务的上报 (`onReport`) 有固定类型集, 失败 run 之后由 `afterFailedRun` 决定 continue 还是 withdraw。生命周期一致性也有约束: 任务运行时的时间与上报接口在其调用结束后拒绝使用; 文档迁移后的第一次写总会写入当前版本的新基底, 即使 JSON 深相等。

### 4.9 provider 会话身份

durable 为每个会话持久化 provider 侧身份: 每个新建、任务拥有、原始创建与分叉的会话都在创建提交里生成自己的 UUIDv7 会话 ID, 分叉从不复制父会话的身份。这个身份被传给模型请求, 供 provider 做提示缓存与会话亲和; 重置、压缩、换模型与重新打开存储都不改变它。没有该文档的存量会话会在首次模型或压缩请求前惰性创建并持久化, 并发调用方只观察到一个赢家。

## 五、pi-env: 远程执行协议

### 5.1 拓扑与帧格式

pi-env 把一个 Rust 写的小守护程序经 SSH 部署到远程机, 以 `pi-env serve --token <hex>` 启动, 客户端经该进程的 stdin/stdout 对话 (stderr 只走诊断文本)。shell 启动文件可能先打印杂散输出, 守护程序的首行 `PI-ENV <token>` 用于同步, 之前的内容全部丢弃; 之后 stdout 只走帧。

每帧 (双向同构): u32 长度、u8 类型、u32 请求号、u32 JSON 长度、UTF-8 JSON 对象、原始载荷, 整数全大端, 单帧上限 16 MiB (更大的传输由客户端拆分)。六种帧型: request、result、error、event (进行中输出, 不结束请求)、cancel、ping。错误是 `{ code, message, syscall?, path? }`, `code` 是 Node 风格错误码或执行专用码 (`shell_unavailable`、`spawn_error`、`timeout`、`aborted`、`unknown`); 消息仅供诊断, 契约只有 code。路径在客户端先解析为绝对路径再发送。

### 5.2 操作与调度

首个请求是 `hello`, 返回系统信息 (os/arch/home/tmpdir/cwd 等) 与 `features` 列表——协议 1 发布后新增的操作 (如 `listFiles`) 靠它探测, 老守护程序会拒绝未知操作。

文件操作跑在固定线程池上: `lstat`、`realpath`、`write` (可保留句柄续写 `writeChunk`)、`truncate`、`fsync`、`rename`、`mkdir`、`rm`、`mkdtemp`、`open`/`pread`/`fstat`/`scanLines`、`opendir`/`readdir`/`close`。句柄是数字, 同时打开超过 4096 个报 `EMFILE`。`listFiles` 是目录树列举: 默认 `maxEntries` 50,000、`maxBytes` 4 MiB、`timeoutMs` 10,000, 深度优先、同层按字节序, 跳过 `.git` 与 `exclude` 名单, `hidden` 与 `gitignore` 默认开 (gitignore 用 fd/ripgrep 同款 ignore 实现), 超限返回 `truncated: true`。

`exec` 跑 shell 字符串或 argv 数组, 运行中以 event 帧流式回传解码后的输出; 可配输出窗口 `{ maxBytes, maxLines, minIntervalMs, bytesPerSecond }` 做合并与节流, 被窗口挤掉的部分以 `skipped` 摘要报告; 结果是 `{ exitCode, spillPath? }`, 超长输出落到新建 tmp 目录里的 `pi-output-<uuid>.log`。`watch` 在守护程序里跑 Durable 的 `NodeFileWatcher`, 先回 `ready` 事件再流式回 change/error。`pty` 开伪终端 (1 到 4096 行列), 不带 argv 时以登录 shell 跑 `SHELL`, 之后 `ptyWrite`/`ptyResize` 按到达顺序写输入、改窗口, `ptyForeground` 报告前台进程组 (区分"跑着编辑器"与"停在提示符"); pty 在 Windows 尚不支持 (`ENOTSUP`)。

调度规则很细: `ptyWrite`/`ptyResize`/`ptyForeground` 由读帧线程按到达顺序直接应答, 保证按键不乱序; result、error、ping 与 watch 事件排在排队的命令输出之前, 但超过 64 KiB 的大 result 也排到输出后面——慢链路延迟的是 bulk 数据, 不是应答; 一条命令未发送的输出超过 4 MiB 时其输出会等待, 效果如同管道写满, 背压回命令本身。

### 5.3 活性与取消

双方每 5 秒互发 ping。守护程序 30 秒收不到任何字节、或 stdin 结束, 就杀掉自己启动的全部进程组并退出——断线即停远程命令。客户端对丢失连接上的请求以 `{ code: "unknown", lost: true }` 失败, 并在下个请求时启动新守护程序; 句柄属于打开它的守护程序, 对旧句柄的请求会失败而不是串到新进程。

取消是命名请求的: 守护程序先登记请求再执行, 因此紧跟请求发出的 cancel 不会丢。`exec`/`pty` 杀进程组并以 `aborted` 结束 (`{ mode: "kill" }` 只杀不中止, 拿到被杀进程的状态); `scanLines`/`listFiles` 在块间/条目间停下, 以 `aborted` 结束; `watch` 停止并以空结果结束; 其余短操作正常跑完。

### 5.4 客户端与一致性

客户端侧的 `RemoteExecutionEnv` 实现与 `NodeExecutionEnv` 同一个 ExecutionEnv 接口, 结果与"在远程机上直接跑 Node 执行环境"逐项对齐, 只有错误文案可能不同, 并有差分测试背书。分工经过刻意切分: 路径解析、中止检查点、错误码映射、读取尺寸与解码留在客户端, 系统调用、进程、溢出文件与行扫描留在守护程序。

SSH 侧做了硬化: BatchMode、对应用自持 known_hosts 的严格主机密钥校验 (指纹先带外核对再接受, 配固定别名)、无任何转发、不共享连接、不转发本地 locale。守护程序按二进制的 SHA-256 命名 (取前 32 个十六进制字符), 每次启动前校验哈希, 随包附带全部支持平台的二进制。连接可以惰性创建: 首个操作才触发探测、部署与连接, 失败是该操作的错误, 下次操作重试。

平台支持 Linux、macOS、Android (Termux) 与 Windows 的 x86-64/arm64; Windows 上字符串命令经 Git Bash 执行。配套工具: `nodePlatform()` 把守护程序 hello 里的系统名映射成 Node 的 platform/arch 拼写; `LocalExecutionEnv` 是本机守护程序加 `NodeExecutionEnv`, 主要为了补上 `listFiles`; `openTerminal()` 在守护程序的伪终端里跑程序。这套设计让"durable worker、存储与凭据留在本地, 工具跑在另一台机器"成为可验证的部署形态, 而不是把整个进程搬走。

## 六、chord: durable 之下的应用组合运行时

### 6.1 对象、引用与 principal

chord 是一个独立的类型化宿主运行时, 用于构建由**对象**组成的应用——这些对象可以分布在多个进程 (server、worker、浏览器标签页) 里, 并且能在运行中**热重载**:

- 对象是地址上的状态加代码, 按需创建, 有人引用就存活。
- 所有人拿到的都是**引用**, 从不直接拿到对象; 引用在本地与跨进程行为一致, 且能活过重载。
- 每个对象知道自己的 **principal**: 属主与访客拿到的是不同对象、不同方法集 (variant)。
- **状态**是可观察的 JSON: 远端观察者先收到快照, 之后是增量。
- **热重载**在运行中换代码: 在飞的工作用它启动时的代码跑完, 状态保留, 不兼容的变更在安全点迁移。

生命周期规则很具体: 引用有明确的属主类别 (对象声明、调用期 `ctx.get`、连接、宿主、UI); 激活按地址合并, 全部请求者离开则丢弃结果; 最后一个引用释放加 linger 之后处置 (linger 上限默认 4)——中止任务、移除监听、按注册反序关闭资源、级联释放引用; 强制处置分波进行, 引用者先于被引用者, 让资源的 close 还能用到对象的引用。

### 6.2 契约、facet 与宿主

契约是运行时值, 用 TypeBox schema 描述: 名字、输入 (对象地址)、成员, 分 local 与 remote 两类; 放置用 `hostNamed` (单一宿主) 或 host family 声明, 调用方从不指名宿主; 适配器经 covers/accepts 匹配, 不匹配报 `contract_mismatch`。方法、状态 (带 version/migrate)、派生、资源、监听与任务都在工厂里经 `self` 声明; 工厂可以同步返回, 也可以异步激活 (默认 60 秒 ready 超时)。

**facet** 是插件对一种宿主的代码 (server、worker、浏览器各一份), 经 `host.serve()` 注册类型工厂; 工厂拿到的 FacetApi 提供 serve、root、registry 与一个在本轮安装失效时中止的 signal——root 与 registry 让非 Chord 方法的代码 (durable 的工具与 hook、原生库回调) 也能访问自己所在的宿主, 因此插件永远不需要进程级全局宿主。宿主之间经 link 交换 JSON 帧; 路由与 relay 把对远端宿主的 hold 按契约声明的位置解析并转发, 授权在解析前与解析后各查一次。

注册表 (defineRegistry) 是按代码版本划分的不可变表, 顺序取首次注册序, 替换保留; 宿主管理器 (createHostManager/forkDriver/childControl/processLock) 负责子宿主进程的启动、停止、替换与存活探测。

### 6.3 复制状态与 delta

chord/delta 是独立的事务性 JSON 跟踪器: `track()` 建立跟踪, `beginChange()` 开草稿, `prepare()` 产出不可变准备值, `adopt()` 校验并交换根指针; `applyImmutable(base, ops)` 在副本上重建状态。准备不改变权威; 采纳验证准备。写入草稿的值立即按值拷贝, 非严格 JSON (undefined 数组元素、非有限数、函数、symbol、稀疏数组等) 在赋值处就抛错; 未变更子树可以在版本间共享。跟踪器信任不可变所有权, 不做防御性拷贝或冻结——发布的值不冻结, 进程内消费者不得原地修改, 可变信任边界要自行克隆或序列化。

`replicatedState(initial)` 是同一模型的回调式封装, 独立于宿主: 一次成功的 `change()` 恰好发布一个原子修订, 回调抛错则原值与序号不变, 草稿在回调返回后即失效。公共订阅有明确的背压: 每个订阅至多保留 100 个待投递的完整值, 溢出只留最新 (未开始的初次 hydration 例外); 取消订阅立即丢弃待投递工作, 不中止也不等待正在跑的回调。

watch 是统一的观察接口 (`WatchHandle<T>`): `watch.value` 是获取时的值, `start(listener)` 安装唯一异步监听, 之后每次变更以 `(change, context)` 逐一到达, `change` 为 `{ value, ops, retired }`; 监听器运行期间累积的变更折叠成一次调用 (最新值、经 PendingOps 折叠的操作、最新的 context), 待投递操作超过 10,000 条折叠后改为一次根替换 `[["r", newest]]`。`retired` 表示所跟随的文档被退役但不结束 watch。结束原因 (`WatchEnd`) 五种: stopped、cancelled、ended、listener_error、failed。源侧用 `Watch<T>` 实现 (advance/end/endAfterDelivery/observeCancellation), `NativeWatch<T>` 是纯进程内版本——无 ops, 待投递值超过 100 个折叠成一个。

durable 的文档正是建立在这套模型上: Session 提交直接发布 chord 操作, 消费者拿到的是精确操作而非需要自己 reduce 的快照。

### 6.4 链路与热重载

链路有三种: 内存对 (测试)、Node IPC (子进程) 与 WebSocket (服务端 ws、浏览器 WebSocket)。线帧是 JSON: hello/bye、hold/release (跨链路的引用)、shape、call/result/cancel、sub/unsub/resync 与 state、gone、root_end、retire、invalidate、ping/pong、ack, 以及重载控制帧 prepare/vote/commit/abort。流控是双向的: 两端在 hello 里声明 ack 窗口并累积确认, 未确认帧超过窗口 (默认 256 KiB JSON 文本) 时状态在发送端排队, 按成员流槽位按创建顺序冲刷; 等待中的操作有上限 (默认四个窗口), 超出后最老的流转为当前值的 reset; 并发调用数也有 maxCalls 上限。协议版本写在 hello 里 (现为 4), 版本不匹配的双方不协商, 直接关链路。

热重载分四步: **prepare** 在每个受影响宿主上用新工厂以记录模式跑一遍现存对象 (可读现有 cell、写则抛错, 监听/任务/注册只记录不启动, 新资源以候选身份打开), 任何失败即整体放弃; **gate** 对版本抬升或独占资源变更的对象做准入切割——旧代码版本的新 root 拿可重试的 `upgrade_conflict`, 已持有激活租约的 root 被豁免, 等待截止 (默认 5 秒) 未到就整体中止重来; **commit** 每个宿主以一个同步步骤安装迁移后的 cell 值、把实现换为新代码版本、重启任务、推送 shape/reset; **retire** 遵循两版本规则——宿主至多保留 current 与 previous, previous 的 root 全部结束 (或任务停止截止 5 秒到期中止) 后才释放。兼容变更 (无状态版本抬升、无独占资源变更) 跳过 gate, 无需等待。状态兼容规则是刚性的: 版本抬升必须配 migrate, schema 变更不抬版本直接拒绝重载。

### 6.5 入口、遥测与 SQLite

| 导入                                    | 内容                                                                                          | 运行环境           |
| --------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------ |
| @earendil-works/chord                   | 契约、声明、宿主、链路、错误, 以及 Context/JsonValue/Draft/replicatedState、Watch 等共享基础  | Node 与浏览器      |
| @earendil-works/chord/node              | 子宿主进程: createHostManager、forkDriver、childControl、processLock; facet 加载器 nodeLoader | Node               |
| @earendil-works/chord/context           | 显式取消、遥测与调用值: BACKGROUND_CONTEXT、withCancel、withTelemetry、traceIn 等             | Node 与浏览器      |
| @earendil-works/chord/delta             | 事务性跟踪器、结构差分、不可变应用与操作批的编解码                                            | Node 与浏览器      |
| @earendil-works/chord/output            | 有界输出流 OutputBuffer 与按尺寸节流的 Progress                                               | Node 与浏览器      |
| @earendil-works/chord/telemetry-sqlite  | createSqliteTelemetry: 缓冲记录与后端无关的 TelemetryStore 查询                               | 任意 SQLite 适配器 |
| @earendil-works/chord/sqlite            | 可移植 SqliteDatabase/SqliteExecutor 与原子迁移                                               | 任意 SQLite 适配器 |
| @earendil-works/chord/sqlite/node       | NodeSqliteDatabase 与打开函数                                                                 | Node               |
| @earendil-works/chord/sqlite/cloudflare | DurableObjectSqliteDatabase                                                                   | Cloudflare DO      |

`Context` 现在总是携带一个遥测 span (与 abortSignal 并列), `BACKGROUND_CONTEXT` 用共享的 no-op span; `withTelemetry`/`traceIn` 派生带遥测的子上下文, 不修改父上下文。SQLite 遥测适配器 `createSqliteTelemetry(db, { retentionMs?, maxQueuedSpans? })` 不持有连接、记录时不做 SQL: 一秒一次的定时器把已结算 span 与完成的指标区间在一个事务里落库并顺带清理保留期 (默认 7 天); 待提交 span 上限默认 10,000, 溢出计入丢弃计数; 指标按 name/kind/unit/属性序列保留 count/sum/min/max, 不存原始样本; 写失败永久停止记录, 后续 flush/close 以原始错误拒绝。适配器实现 `TelemetryStore` (`findTraces`/`getTrace`/`findMetrics`), 关闭适配器后只要数据库还开着仍可查询; 表为 `telemetry_spans`、`telemetry_metrics`、`telemetry_schema`。

仓库内的使用者: durable 是最大的消费方——文档是 chord 跟踪的状态, Context 贯穿每一个异步调用 (BACKGROUND_CONTEXT 永不取消; 取消一个等待只取消该等待, 从不取消工作), OutputBuffer 与 Progress 用于工具输出与进度的节流提交; env 用 chord 的 Context。仓库当前不附带构建在 chord 之上的产品级消费者, 它定位为独立的应用组合运行时。

## 七、接口形态与 TUI

### 7.1 五种接口形态

所有接口共用同一套 agent 与 session 机制:

```text
interactive  终端 TUI
print        跑一个 prompt 输出最终回复
json         agent 事件按 JSONL 输出
rpc          stdin 收 JSONL 命令, stdout 回响应与事件
SDK          进程内直接创建与控制会话
```

终端 stdin/stdout 下默认打开 TUI, `--print`、`--mode text|json|rpc` 选择其他界面; 任一流被重定向且未选 JSON/RPC 时走 print 模式。常用旗标还有 `--export`、模型/会话/工具/资源选择、`--tui-mode` (默认 fullscreen)、`--offline`、`--approve`/`--no-approve`, 以及 `pi install/remove/update/list/config/auth/mcp` 子命令。RPC 客户端封装了切换会话、分叉、克隆、导出、读取树结构等命令, 并带超时等待与错误映射, 使外部程序可以用子进程形态驱动 Pi; 读消息支持以 entry id 作持久游标做增量读取, 树结构读取则暴露完整的分支与标签。

### 7.2 pi-tui 的渲染工程

`packages/tui` 是一个差分渲染的终端 UI 库, 主屏 (TuiMainScreen) 与备屏 (TuiAltScreen) 两个渲染器实现同一接口, 用 CSI 2026 同步输出消除闪烁。工程深度体现在源码清单里: 布局 (layout)、模糊匹配 (fuzzy)、emacs 风格编辑原语 (kill-ring、undo-stack、word-navigation)、LaTeX 渲染 (latex)、Oklab/OKHSL 色彩空间 (oklab)、终端色彩探测 (terminal-colors)、原生修饰键检测与输入缓冲 (native-modifiers、stdin-buffer)、滚轮滚动与备屏搜索 (wheel-scroll、alt-screen-search)、键位系统 (keybindings)。组件模型的要求很具体: 组件为可用宽度渲染行数组, 每行必须适配宽度 (按可见列而非字符串长度测量, 因为 ANSI 转义、宽字符、emoji、组合字符都会改变显示宽度), 状态变化后要让受影响组件失效并请求重渲染; 可聚焦组件以 CURSOR_MARKER 标注光标位置。

TUI 文档给出的集成点建议也是分层的: 优先用扩展上下文里的选择、确认、输入、编辑器、通知、状态、组件替换等 API; 只有在需要自己的渲染、键盘或鼠标输入、焦点、布局或生命周期时才自建组件; 不要在扩展里再建一套终端渲染器。调试有 `PI_TUI_WRITE_LOG` 记录写入序列。

### 7.3 fullscreen 默认、主题与终端兼容

交互模式的默认 TUI 形态是全屏 (设置 `tuiMode` 默认 `"fullscreen"`), 走备屏渲染器 (应用持有滚动视口, 停止时恢复主缓冲并打印完整最终文档), 可用参数或设置切回常规模式。配套设置包括退出时输出内容 (全文或仅续跑提示)、滚动条、选中即复制、滚轮每次滚动行数。

主题系统接受五种颜色形式: RGB 十六进制、OKLCH、OKHSL (饱和度相对该色相/亮度下 sRGB 色域的最大值, 因此等饱和看起来等鲜艳)、256 色索引与变量引用; 变量可链式解析, 缺失或成环使主题非法。有 truecolor 时用真彩, OKLCH 做色域映射落到 sRGB, 256 色终端取近似; HTML 导出把 OKHSL 转十六进制 (CSS 不支持)。终端兼容细节也有记录: Pi 启用增强按键上报, Apple Terminal 仍对 `Shift+Enter` 发普通回车时, 用本地 macOS 修饰键回退识别。

## 八、provider 与工具/沙箱体系

### 8.1 统一 provider 面

`packages/ai` 是统一的多供应商 LLM API, 四十多个 provider 模块各配一份模型数据, 覆盖面从主流闭源与开源通道到国内厂商及其区域变体, 另含若干网关与订阅通道。测试替身 faux provider 被用于全部测试套件, 使 CI 不接触真实 API 与付费 token。

模型目录是生成物而非手写文件: `models.generated.ts` 由生成脚本产出, 贡献指南允许提交重新生成带来的无关上游模型元数据差异, 但禁止手改。采样参数支持按思考级别覆盖: 模型可以携带以 Pi 思考级别为键的采样参数, 解析时先按模型支持的级别钳制, 再按 `{ ...model.samplingParams, ...thinkingLevelParams, ...requestParams }` 的顺序逐键合并; 只有 OpenAI 兼容适配器应用这套参数, 其余 API 忽略。

### 8.2 认证模型

用户在 Pi 内登录选择 provider, 走订阅或存 API key, 再切换模型。API key 可以直接写, 也可以用 `!command` 前缀从命令输出取; 凭据文件支持 `env` 对象引用环境变量。OAuth 登录支持把最终重定向 URL 或授权码粘回 Pi 的方式。Anthropic 支持工作负载身份联合: 从环境变量读取联合规则、组织 ID 与身份令牌文件, 由 SDK 自行换取并刷新短期令牌, 联合客户端跨请求复用以命中令牌缓存。

官方 AI 网关 Radius 作为一等 provider: 登录后其模型像其他 provider 一样出现在模型列表, 认证用网关目录并缓存刷新过的模型元数据以支持离线启动; 登录成功还会提议把网关的 MCP server 写进全局 MCP 配置, 形如 `{ url: RADIUS_MCP_URL, auth: { provider: providerId } }`, 以同一份登录取代 MCP 的 OAuth 登录。

### 8.3 MCP

MCP 客户端是独立包 (pi-mcp): 传输无关的客户端核心、stdio 与 Streamable HTTP 传输 (SSE 传输被明确拒绝)、内存测试传输与 OAuth 子集, 不依赖官方 MCP SDK。coding-agent 里的 MCP 支持是可替换内置扩展, 也可以用 `registerMcpServer()` 编程注册。

接入模型有几层策略: server 级暴露默认 `codemode` (工具只对脚本可见, 由脚本编排), 可改为 `deferred` (经 tool search 按需加载)、`direct` (直接进上下文) 或 `hidden`, 还可以用 `toolExposure` 逐工具覆盖; 工具命名统一为 `mcp__<server>__<tool>`。MCP 资源面也接了进来: 内置 `list_mcp_resources`、`list_mcp_resource_templates`、`read_mcp_resource` 三个资源工具; 连接的 server 会出现在 `mcp_servers` 系统提示段里。文本结果超过 20 KB 会截断并把全文落到临时文件给出路径; 408/429/5xx 自动重试两次。项目级 MCP 配置里不带连接信息的条目只覆盖同名全局 server 的启用、暴露与工具暴露策略, 便于在受信任项目里开关全局 server。

### 8.4 内置工具与 codemode

内置工具是 read、write、edit、bash (加 powershell、find、grep、ls), 配套文件变更串行化、输出累积、截断与路径处理。工具注册进统一注册面, 因此扩展可以包装、替换或动态生成工具。

codemode 是最特别的内置扩展, 其沙箱内核已抽成独立包 pi-codemode: 在编译到 WASI 的 QuickJS 虚拟机里运行模型写的 JavaScript, 能力被限定为调用注入的工具与运行非 LLM 模型, 脚本本身没有 Node API、文件系统、网络、定时器, 也没有模块与 WebAssembly; `eval` 与 `Function` 可用, 但只能产出同一 VM 内的更多代码。嵌套工具调用从不进入 LLM 上下文, 只有脚本的输出与返回值进入。包本身没有任何 pi 依赖, 可以独立使用, 把任意函数 (远程 API、MCP server、应用服务) 暴露给模型脚本。

沙箱按运行环境分三种, 共享同一 API、同一脚本环境与同一结果格式:

| 环境                        | 沙箱类                | 脚本运行位置                        |
| --------------------------- | --------------------- | ----------------------------------- |
| Node 与 Bun                 | CodemodeSandbox       | 每次执行一个 worker 线程            |
| Cloudflare Workers/DO       | RemoteCodemodeSandbox | 另一部署 Worker 里的 Durable Object |
| 其他运行时 (或可阻塞调用方) | InlineCodemodeSandbox | 调用线程                            |

coding-agent 对沙箱的约束: VM 堆上限 256 MB (`CODEMODE_MEMORY_LIMIT_BYTES`); 一个 pi 进程内所有会话合计最多 `PI_CODEMODE_MAX_WORKERS` (默认 2) 个 codemode worker 存活, 该值每次调用时读取; 满额时新脚本**按到达顺序等待**, 等待上限 60 秒 (`CODEMODE_WORKER_WAIT_MS`), 超时才失败——容量不足是排队而不是立即拒绝。等待永不落定 promise 的脚本 (没有挂起工具调用且 VM 无定时器) 会立即失败而不是挂死。Cloudflare 侧另有中断预算 (默认 100,000 次轮询) 兜底失控循环。

脚本首行可写 `// @options:` 注释调整行为 (不在首行直接失败): `max_output_tokens` 是软预算 (默认 10000), 超预算时保留首尾、把完整文本落到临时文件并在结果里给出路径; `timeout_ms` 是整个脚本的硬截止。硬上限则是失败线——文本加 base64 图像数据超过 16,777,216 字符, 或 text()/image()/console 调用超过 100,000 次, 脚本直接失败, 打印循环无法耗尽宿主内存。

脚本经 `models` 绑定可列出聊天、图像与分类三类模型, 但聊天模型只能列出、不能从脚本运行; 真正可执行的是分类与图像生成两类非 LLM 调用, 它们共用同一个在飞调用上限 (每脚本 4 个), 超量的调用自动排队。脚本从工具拿到的结果按工具能力分层: 带输出 schema 的工具解析为结构化值 (bash 给 `{ output, truncated, full_output_path?, exit_code, wall_time_seconds }`, output 上限 1 MiB, 超长保留首尾各 512 KiB), MCP 工具给完整 CallToolResult, read 对图像给图像块。`store(key, value)`/`load(key)` 在多次 codemode 调用间保存小 JSON 状态 (单值至多 262,144 字符, 合计至多 1,048,576), 成功脚本的写入以自定义 entry 追加进会话, 因此分支各见其路径上的值。工具声明以 TypeScript 声明的形式内联进描述, 按命名空间分组, 共享 3000 token 的预算; 超出的工具由脚本内的 `searchTools()` (BM25 排序, 默认取 8 条)、`describeTool()`、`describeNamespace()` 或过滤 `ALL_TOOLS` 发现。codemode 自身有 `mode` 设置 (on/only) 控制它与普通工具调用的配比。

durable 侧另有配套的 codemode 扩展: 每次脚本调用是嵌套工具调用, 脚本本身可跨重启续跑。做法是让沙箱确定性运行 (虚拟时钟、种子化随机、UTC、结果按序、指纹), 工具把脚本得到的每个结果先写日志再交付; 重启后重跑脚本, 按日志顺序交付结果, 脚本发出同样调用并按 key 重新接上未完成的嵌套调用; 脚本走了不同路径、指纹或版本变化、或超时已过, 则以错误结束。设计意图与"用代码代替连续工具调用"一致: 让模型写一段脚本批量编排工具, 而不是每个动作一轮对话。

### 8.5 权限模型与容器化

安全文档的表述非常直接: Pi 没有内置权限系统来限制文件系统、进程、网络或凭据访问, 默认以启动它的用户与进程的权限运行, 且不在每次工具调用前请求批准; 项目 trust 只控制加载哪些项目资源 (且不是完整的启动边界——sessionDir 在信任建立之前就会被读取), 不做工具调用沙箱。信任决定落在 trust.json, 默认策略是 `defaultProjectTrust: "ask"`。启用的工具使用进程的操作系统权限, 扩展就在该进程内执行。

需要更强边界就容器化, 文档给出四种模式:

1. Gondolin 扩展: Pi 与 provider 认证留在宿主机, 内置工具与 shell 命令路由进本地 Linux micro-VM (覆盖 read/write/edit/bash/grep/find/ls, 需 Node 23.6+ 与 QEMU)。
2. 纯 Docker: 整个 Pi 进程跑本地容器, 简单隔离。
3. Docker Sandboxes (sbx): 托管沙箱, provider 凭据留在宿主机并由代理替换, 不把真实 key 暴露给容器。
4. OpenShell: 整个 Pi 进程跑在策略控制的沙箱里, 对文件系统、进程、网络与凭据施加策略。

此外根仓库还带一个沙箱运行时依赖 (@anthropic-ai/sandbox-runtime) 与一个沙箱示例扩展。可以看出沙箱能力全部外置为可选层, 与内核最小化是同一取向。

## 九、适用场景与边界

### 9.1 适用场景

- 希望把 Agent 嵌进自己工具链的团队。TypeScript SDK 暴露的就是 CLI 自己用的会话、资源加载器与运行时, 依赖注入面完整, 示例随仓库类型检查, 因此嵌入成本低且不易被内部改动打断。
- 需要长期可回溯的交互式编码。entry 树加 active branch 的模型让"回到更早的分支继续"不影响历史; 压缩只替换模型可见视图, 原始 entry 保留。
- 需要严格崩溃恢复的自动化。durable 的"先提交再展示"与原子提交不变量 (deferred 窗口是唯一显式例外), 加上任务重启预算、睡眠/唤醒与 codemode 脚本的确定性重放, 适合把 Agent 放进无人值守流程; 表现层需要宿主自建, 库提供的是结构化视图、精确操作 watch 与仿 coding-agent 的事件流。
- 多形态驱动。同一套会话机制支撑 TUI、打印、JSON 事件、RPC 与 SDK 五种形态, RPC 客户端让外部程序以子进程形态驱动完整会话。
- 需要广覆盖模型通道。统一 provider 面与生成式模型目录让"接一个新模型服务"成为数据而非代码工作。
- 需要把工具执行移出本机。pi-env 让 durable 的工具跑在经 SSH 部署的远程守护程序上, 语义与本地 Node 环境逐项对齐, 断线即停远程进程, 并有差分测试背书。

### 9.2 边界与未完成项

- 权限边界全靠外置。没有内置沙箱时, 工具调用与扩展拥有与 Pi 进程相同的操作系统权限; 处理不可信文件、仓库、扩展或无人值守自动化前必须先读安全文档并选择容器化模式。
- durable、chord 与 pi-env 都是实验性接口, 声明会随版本变动; 仓库当前不附带构建在 durable/chord 之上的产品级消费者, CLI 也不依赖它们, 基于 durable 构建应用需要自行解决表现层与编排。
- 内核最小化是双刃剑。默认不带 sub-agent、plan mode 等能力, 用户需要自己组合或安装扩展; 大量示例扩展示范了可能性, 但也意味着这些能力的成熟度取决于生态而非内核。
- 贡献门槛高。新贡献者的 issue 与 PR 默认自动关闭, 维护者按质量复查后决定是否重开; 这降低了维护噪音, 也提高了外部参与成本。
- 两条安装通道的安全级别不同。官方安装器从生成的安装锁文件装传递依赖并钉死它们, 而直接经 npm 全局安装不会钉死传递依赖; 文档明示这一差别, 迁移建议也由此而来。

### 9.3 值得借鉴的工程点

1. 树形会话模型: entry 带 parent 指针的 JSONL v3 树加 active branch, 分支不删历史, 压缩只是视图层替换——比线性消息数组加截断保留了更多可回溯性。
2. 最小内核加分层资源阶梯: 从指令文件到 package 每层复杂度递增, 文档明确引导用户从最弱机制开始, 把"该用哪一层"变成可讨论的工程问题。
3. SDK 与 CLI 同源: 嵌入方拿到的是 CLI 自己用的会话、资源加载器与运行时, 依赖注入完整, 示例随仓库类型检查, 因此 Agent 也能自我解释自己的工作原理。
4. durable 的提交不变量: 原子提交、外部副作用移出事务、存储错误即致命——这套约束是"进程死掉能续跑"可验证的原因; deferred 提交作为唯一例外被显式建模 (可见在先、落盘有窗口), 而不是藏在实现里。
5. 供应链加固成体系: 精确版本、发布年龄门槛、全链路忽略脚本、传递依赖钉死与 lifecycle script allowlist, 每条都针对真实的包投毒攻击面。
6. codemode 把"模型写代码编排工具"关进只暴露注入工具与非 LLM 模型的沙箱, 并抽成无 pi 依赖的独立包: 输出硬上限让打印循环无法耗尽宿主, 容量不足排队而非拒绝, 确定性运行加日志交付让脚本跨重启续跑。
7. pi-env 把远程执行做成帧协议而非 RPC 框架: 16 MiB 帧、六帧型、5 秒 ping/30 秒自杀、取消命名请求、大载荷让路小应答——每条都对应真实 SSH 链路上的失败模式, 且客户端语义与本地环境差分测试对齐。
8. chord 把"提交 → 操作 → 副本"做成基础设施: 持久层直接发布结构化操作, 消费者无需自建 reducer; 热重载用 prepare/gate/commit/retire 四步与两版本规则做到在飞工作不丢、状态可迁移、失败可整体回退; 遥测经独立 SQLite 入口落库, 记录路径不碰 SQL。
