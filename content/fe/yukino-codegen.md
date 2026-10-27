---
title: "Yukino Codegen: 从自然语言需求到可运行 Web 应用"
description: "AI 全栈代码生成平台的技术解析: 服务端用 Yukino 编码 Agent 在真实磁盘上迭代产出 Vite 工程, 浏览器用 WebContainer 完成安装与预览, 二者以服务器权威文件 + WebSocket 事件溯源 + 三方合并同步闭合生成/运行/修复回路"
local_path: "$HOME/github/yukino-codegen"
---

Yukino Codegen 是一个 AI 全栈代码生成平台: 用户用一句自然语言描述想要的应用, 平台在服务器上驱动一个真实的编码 Agent 在文件系统上迭代产出前端工程, 再把这份工程同步进浏览器的 WebContainer 里完成依赖安装与 dev server 启动, 最终在预览 iframe 中呈现一个真实可运行的 Web 应用。生成过程本身是实时可交互的: 用户可以中途 steering 纠偏、审批计划、回退对话与代码、切换模型与思考强度、上传图片与 @ 提及文件。本文讲的是这条主链路如何被工程化: 一轮生成如何被编排与准入, 服务器与浏览器各自承担什么职责, 生成产物如何挂载与预览, 生成/运行/修复循环如何闭合, 以及沙箱、密钥、文件路径等安全边界如何划定。

平台是一个 pnpm workspace 单仓, 由 `client/`(React 19 + Vite 7 前端)与 `server/`(Hono 4 + Prisma 7 后端)两个包组成。后端把 `@yukino.js/yukino` 当作库复用——它不是自己实现一个 Agent, 而是通过引擎的远程入口 `Remote.Server.createRemoteAgent` 拿到一整套 Agent 句柄, 再把它接到自己的会话存储、WebSocket 协议与文件 API 上。理解平台的关键, 是先理解这条闭环两端各自的事实权威在哪里: **服务器磁盘是文件的权威源, 浏览器容器只是可丢弃的执行环境**。

## 一、定位: 一句话需求如何变成可运行应用

### 1.1 产品形态与核心承诺

平台对外的承诺是"描述它, 看着它自己构建出来": 用户输入一段自然语言需求, 得到的是一个能被浏览器直接打开运行的 Web 应用, 而不是一段需要人工拼装的代码片段。围绕这条主链路, 平台提供了一整套产品面:

- 认证与用户体系、应用广场(`awesome` 列表)、我的应用、聊天记录持久化与回放;
- 每个应用一个 Agent 工作区: 会话 transcript、权限模式、计划模式、MCP 服务器配置、生命周期 Hook、技能、长期记忆、子代理与团队、模型与思考强度覆盖、沙箱策略;
- 实时交互: 流式叙述、运行中 steering、排队 follow-up、计划审批、对话回退检查点、提示词历史(最近 200 条)、历史会话恢复;
- 输入增强: `@` 文件提及(带补全)、图片上传、`!`/`!!` 用户 shell、斜杠命令;
- 在线 IDE: 文件树、Monaco 代码编辑器、xterm.js 终端;
- 可视化编辑: 在实时预览里点选元素, 描述修改意图, 由 Agent 映射回源码;
- Git 快照安全网: 每轮对话结束后对生成项目做一次提交, 可列出快照并连同对话一起回滚;
- 工程侧能力: 应用 zip 导出、管理后台、Prometheus 指标与健康探针。

这些能力不是并列堆叠的, 而是围绕"生成 → 运行 → 反馈 → 再生成"这一条闭环组织的。

### 1.2 与模板填充式生成的本质区别

AI 生成应用的实现路线大致分三代。第一代是模板与低代码拼接: 模型输出 JSON 配置, 前端用固定组件渲染, 表达上限被组件库锁死。第二代是代码片段生成: 模型直接吐代码, 由人工复制到工程里, 没有运行时验证。第三代是 agentic 生成: 模型作为 Agent 在真实文件系统上循环地计划、调用工具、观察结果、继续迭代, 产出工程化项目, 并配合浏览器内运行时把"运行结果"作为下一轮的输入。

本平台属于第三代, 两个结构性选择构成了与模板方案的真正分野:

- **服务端跑的是一个完整的编码 Agent**, 拥有真实文件读写与命令执行工具(`ReadFile`/`WriteFile`/`EditFile`/`Glob`/`Grep`/`Bash`), 把项目真实写入服务器磁盘, 而不是在内存里拼字符串;
- **浏览器端用 WebContainer 承载构建与运行**, 让 `npm install` 与 dev server 发生在用户自己的设备上, 服务器只负责存储文件与驱动模型。

前者决定了生成物能达到工程化项目的复杂度, 后者决定了预览的边际成本与安全模型。两者之间的文件一致性, 则是整个平台最核心的工程难题(见第六节)。

### 1.3 适用场景与形态边界

平台适合的需求形态是"从零到可交互原型"与"中小型 Web 应用的一次性生成": 落地页、表单与看板、数据展示类前端、带简单后端的 demo。它不适合需要长期演化、有严格合规要求、或依赖专有二进制与内核态能力的产品。预览链路钉在 npm 生态上: 浏览器侧固定执行 `npm install` 与 `npm run dev`, 一键修复的提示词也明确针对 React 应用(见 6.3); 超出这个形态的工程, 预览与修复回路不再适用。

设计取舍上, 平台选择了"生成速度快、预览延迟低"而不是"生成即生产可用"。服务器磁盘上的项目目录是权威数据, 浏览器容器只是可丢弃的执行环境; 一旦关闭标签页, 容器内存文件系统即消失, 权威副本始终在服务器侧。这条取舍贯穿后文的同步、冲突与快照设计。

## 二、生成流水线: 轮次编排与单轮循环

### 2.1 系统提示词与工作区指令

平台不维护自己的生成提示词模板, 也不做任何占位符注入——行为约束来自三层:

- **系统提示词**由引擎按运行环境构造(`Prompt.Builder.detectEnvironment(cwd)` + `buildSystemPrompt`, 见 [system-prompt](../docs/yukino/system-prompt)); 平台在切换模型重建 LLM 客户端时显式复用这同一组函数, 保证两处一致;
- **工作区指令**以函数形式传给每轮的 Agent: `instructions: () => Memory.Instructions.loadInstructions(handle.cwd)`, 即每一轮都从工作目录重新读取最新指令(见 [agents-md-and-memory](../docs/yukino/agents-md-and-memory));
- **长期记忆**同样以函数形式门控: `memoryContent` 在工作区 `memoryEnabled` 时返回 `memoryManager.buildSystemReminder()`, 否则返回空串。

### 2.2 submit: 一个入口, 多路流量

WebSocket 的 `run` 消息统一进入 `submit()`, 由它按运行时状态分流:

- **运行中**: 走 `steerOrQueue`。斜杠命令与用户 shell 不参与 steering, 直接排队; 其余输入若存在活跃且未被取消的 Agent 循环, 就调 `currentAgent.steer(text)` 实时注入当前轮, 落库一条 `steered: true` 的 `user_message` 并广播 `steering_queued`; 无法 steering 时转入 follow-up 队列并广播 `followup_queued`;
- **空闲时**: 输入以 `!`/`!!` 开头则走用户 shell(见 4.5), 以 `/` 开头且能解析则走命令分发(见 2.7), 否则作为一轮 `runTurn` 执行;
- **收尾**: `submit` 末尾检查是否有已批准待执行的计划(`pendingPlanExecution`), 再 `drainFollowUps` 把队列里的输入按序重放(每条先广播 `followup_started`, 再按 shell/命令/轮次分流)。

引擎事件里的 `steering_delivered` 经适配器广播为瞬时 `agent_status`, 前端据此把已送达的 steering 从待处理列表移除。

### 2.3 executeTurn: 一轮的完整编排

`runTurn` 把 `executeTurn` 包在每运行时的内部锁里(同一应用不会有两轮并发), 顺序如下:

1. **`claimTurn` 数据库互斥**: 跨节点抢占本轮执行权(见 4.4), 失败则广播 `workspace_busy` 错误并返回;
2. 落库 `user_message`(含可选的 `selectedElement`/`previewError`), 置会话状态 `RUNNING`, 广播 `runtime_status: running`;
3. 建事件适配器与**每轮的** `Permissions.PermissionChecker`——权限模式、沙箱开关、计划文件路径每轮重新套用, 软设置变更无需重建句柄;
4. `composePrompt` 在用户原文后按需追加 `<selected-element>` JSON 块与 `<preview-error>` 块, 再经 `Conversation.AtExpand.expandAtRefsWithImages` 展开 `@` 提及的文件与图片(transcript 存原文, 会话存展开结果), `addUserMessage` 进会话;
5. `MCP.Instructions.syncMcpInstructions` 播报本会话尚未见过的 MCP 服务器指令(压缩/恢复抹掉后会重播);
6. **构造 `Agent.Agent`**: 关键字段是 `sessionId: ""`——传空字符串禁用引擎自身的 JSONL 会话写入, 让 DB transcript 成为唯一权威; `instructions`/`memoryContent` 为函数形式(见 2.1); `maxIterations` 取 `AI_MAX_ITERATIONS`(默认 40); `toolFilter` 叠加 coordinator 过滤(平台固定关闭, 恒真)与句柄过滤; Hook 启用时挂 `hookEngine` 与 `onLoopComplete`(记忆维护); `notificationFn` 排空团队与后台任务通知;
7. **`turnGate.acquire(abort.signal, actorUserId)`** 进程级准入(见 2.4);
8. `for await (const event of agent.run())` 逐事件经适配器分发; 循环中追踪 `ExitPlanMode` 工具成功与否, `usage` 事件累加并广播(含 `contextTokens`/`contextWindow`);
9. **计划审批门**: 权限模式为 `PLAN` 且 `ExitPlanMode` 成功时, 广播 `plan_approval_request`(见 2.5);
10. `finalizeTurn` 收尾(见 3.5)。

引擎运行抛错时, 落一条 `error` 事件并广播 `agent_error`(标记 `recoverable: true`), 但**不中断 finalizeTurn**——收尾仍会跑, 保证状态一致。

### 2.4 TurnGate: 进程级并发准入

所有运行时共享**一把进程级的 `TurnGate`**(由 RuntimeManager 创建后注入), 上限 `AGENT_MAX_CONCURRENT_TURNS`(默认 4), 即整个进程同时最多有 4 个 Agent 循环在烧模型:

- 超限时 `acquire(signal?, fairnessKey?)` 把调用方挂进等待队列; `takeNextWaiter` 在 FIFO 之上做公平调度——优先唤醒 `fairnessKey`(即 `actorUserId`)与上一个被准入者**不同**的等待者, 防止单一用户长时间占满全局名额;
- AbortSignal 触发时把对应等待者从队列移除并 reject, 不留幽灵排队; `release` 幂等, 重复释放不破坏计数。

它与每运行时的内部锁分工明确: 锁保证同一应用的轮次串行, 门保证进程内模型并发有全局上限。

### 2.5 计划模式与计划审批

句柄以 `enableModelPlanMode: true` 创建, 引擎为此注册 `EnterPlanMode`/`ExitPlanMode` 工具, 让模型能从浏览器端驱动完整的计划审批流:

- `/plan [args]` 或把权限模式切到 `PLAN` 都会进入计划模式: 记录进入前的权限模式(`prePlanPermissionMode`), 持久化 `PLAN`, 经 `PlanFile.getOrCreatePlanPath` 创建或复用计划文件并同步到权限检查器; 带着已有计划文件重入时会重播 re-entry reminder;
- 计划模式的轮次结束后, 若 `ExitPlanMode` 成功, 服务器读取计划文件当前内容, 广播 `plan_approval_request { planPath, planContent }` 并置 `planApprovalPending`; **10 分钟**(`PLAN_APPROVAL_TIMEOUT_MS`)未应答即过期, 广播 `plan_approval_expired`;
- 用户经 `plan_approval_response` 三选一: `yolo` → 权限模式切到 `BYPASS_PERMISSIONS` 并立即提交"Execute this plan"执行计划(忙时存为 `pendingPlanExecution`, 等槽位释放后自动执行); `manual` → 恢复进入计划模式前的权限模式; `feedback` → 把反馈意见作为新输入重新提交;
- 从 `PLAN` 切回其他模式时, 注入 `buildPlanModeExitReminder` 告知模型计划模式已结束。

### 2.6 权限模式与人工介入

引擎的权限检查器按工作区的权限模式构造。数据库侧有五种模式(`DEFAULT`/`ACCEPT_EDITS`/`PLAN`/`DONT_ASK`/`BYPASS_PERMISSIONS`), 映射到引擎的四种(`default`/`acceptEdits`/`plan`/`bypassPermissions`, 其中 `DONT_ASK` 与 `BYPASS_PERMISSIONS` 都落到 `bypassPermissions`)。默认工作区用 `bypassPermissions`, 即生成过程不打断用户——这是"看着它自己构建"体验的必要条件。权限机制细节见引擎文档 [permission](../docs/yukino/permission)。

当模式不是 bypass 时, 引擎的每次工具授权请求会经 `onPermissionRequest` 回调进入平台的交互代理(interaction broker): 请求被持久化成一条 `AgentInteraction` 行, 同时通过 WebSocket 推 `permission_request` 给前端, 并把运行时状态置为 `waiting`。前端弹权限对话框, 用户允许/拒绝后回 `permission_response`(可带 `remember`, 允许并记住时以 `allowAlways` 落库), 代理解析 promise 并广播 `interaction_resolved`。提问(`AskUserQuestion` 工具)走同一条通道。

交互代理是**失败关闭**的: 5 分钟超时、会话取消、连接断开或运行时销毁, 都会把待决的权限请求解析为 `deny`、把提问请求 reject, 而不是静默放行。这保证了"无人值守的生成"不会在需要人确认时偷偷继续。`ready` 消息会带上当前所有待决交互(`pendingInteractions`), 断线重连后用户仍能看到并处理未决的权限/提问。

### 2.7 斜杠命令: 服务端可执行子集

前端聊天框支持斜杠命令, 服务端可执行的集合是 `SERVER_SUPPORTED_COMMANDS` 的 17 个: `help`/`status`/`clear`/`compact`/`skills`/`skill`/`memory`/`mcp`/`rewind`/`goal`/`plan`/`model`/`thinking`/`sandbox`/`worktree`/`workflows`/`review`。终端专属命令(`login`/`provider`/`quit`/`feedback`/`resume`/`session`)明确不执行。不在这两个集合里的注册表命令, 只要类型是 `prompt`/`skill_fork`/`local`(如 `ultracode`、用户自定义命令、命名工作流、直接技能调用)就走 `dispatchRegistryCommand` 通用分发。命令体系见引擎文档 [slash-command](../docs/yukino/slash-command)。几个实现要点:

- `/skill <name> [args]`: fork 模式技能经 `runSkillFork` 在隔离子代理中运行; inline 技能用 `Skills.Executor.runInline` 展开成提示词后 `runTurn`, 因此技能能真正驱动工具调用; `/skill reload` 与 `/skills reload` 重载技能目录;
- `/compact [instructions]`: 用**客户端协议形状**渲染工具 schema(而非 Anthropic 原始形状, 以免在 OpenAI 系客户端上扭曲 token 估算), 按活跃 `toolFilter` 收窄后调 `Compact.Compact.forceCompact`, 支持自定义摘要指令; 压缩结果落库为 `compact` 事件。压缩与恢复本身复用引擎内核(见 [context-compaction](../docs/yukino/context-compaction));
- `/clear`: 先停后台任务与团队, 再 `handle.clearConversation()` 轮换全部会话级状态(会话 id、文件历史、文件状态缓存、任务板、恢复状态、活跃技能、MCP 播报), 重置计划模式状态, `startNewSession` 后给所有连接重发 `ready`;
- `/status`: 汇报上下文 token/窗口、模型、思考强度、权限模式、沙箱状态、技能/记忆/MCP/工具数量等;
- `/memory` 列出记忆与 auto-memory 开关, `/memory clear` 清空; `/mcp` 汇报已连接服务器与工具数, `/mcp reload` 原地重连(见 6.2);
- `/model`/`/thinking` 不带参数时广播选择器, 带参数时应用(见 6.2); `/sandbox auto|manual|off` 切换沙箱策略(见 6.2);
- `/rewind` 不带参数广播回退选择器, 带 sha 时执行 `code_only` 回滚(见 3.6); `/worktree` 列出 worktree(见 6.7); `/goal` 驱动目标跟踪; `/workflows` 管理命名工作流;
- `/review [args]`: 用内置只读评审子代理执行, `buildReviewPrompt` 把本地 git 上下文适配进评审提示词。

命令候选列表(自动补全)由 `buildCommandCandidates` 生成: 注册表中过滤掉技能派生命令、只保留可执行命令, 再补上服务端特有的 `/skill`; 兜底注册表 = 引擎默认注册表 + `Commands.Loader.loadUserCommands()` 加载的用户命令, 冲突跳过。

## 三、服务端运行时: RuntimeManager 与 AgentRuntime

### 3.1 RuntimeManager: 长驻、按应用键控、空闲回收

`createRuntimeManager` 持有所有 `AgentRuntime` 实例, 以 `${ownerId}:${appId}` 为键(规范工作区属于应用 owner), 工作目录由 `buildCodeOutputDir(rootDir, appId)` 解析为 `tmp/code_output/{appId}/`。运行时**跨连接长驻**: 同一个应用的多个 WebSocket 订阅者共享一个运行时, 一个用户断开不会销毁它。空闲回收由 `AGENT_WORKSPACE_IDLE_MS`(默认 15 分钟)控制, 一个 60 秒的 `setInterval` 扫描器(已 `unref`, 不阻止进程退出)淘汰 `!isBusy && now - lastActivity > idleMs` 的运行时; 淘汰前在生命周期锁内二次确认, 避免与正在创建的运行时竞态。

进程级 `TurnGate` 在这里创建一次, 注入给所有运行时(见 2.4)。所有生命周期操作(创建、销毁、淘汰)都经一把每键的 `WorkspaceLockRegistry` 串行化, 并被追踪进一个 `lifecycleTasks` 集合; `disposeAll` 会先等所有在途生命周期任务完成, 再逐个销毁。这保证了"关闭时不会留下半创建的运行时"。

### 3.2 AgentRuntime: 句柄与会话

一个 `AgentRuntime` 拥有: 引擎句柄(`RemoteAgentHandle`)、规范 DB 会话、transcript 序列计数器、已连接订阅者集合, 以及一把内部 `AsyncLock`。句柄是惰性创建的(`ensureHandle` → `createHandle`), 失败时清空 promise 以便重试。创建时:

1. `mkdir` 工作目录;
2. 并行读取启用的 MCP 服务器行与 Hook 行;
3. 用 `buildProviderConfig(env, workspace.modelOverride)` 组装 Provider(端点/协议/密钥/token 上限来自服务器配置, 模型可被工作区覆盖);
4. 调 `Remote.Server.createRemoteAgent({ askUser, cwd, enableCoordinatorMode: false, enableModelPlanMode: true, forkDisabled: false, hooks, mcpServers, memoryEnabled, provider, sandboxConfig?, onSubagentEvent })`——`askUser` 把引擎提问接到交互代理, `onSubagentEvent` 把子代理生命周期接到活动面板(见 8.3);
5. `rehydrate` 把 DB 里的历史灌回句柄的会话。

### 3.3 rehydrate: 让 restoreContext 成为唯一注入点

`createRemoteAgent` 会无条件把项目指令与完整长期记忆注入会话。平台在 rehydrate 时**先 `handle.conv.reset()` 抹掉这次注入**, 理由是: 引擎的 `Agent.restoreContext()` 才是唯一的注入点——它在首轮重新注入指令、技能清单, 并按工作区的 `memoryEnabled` 门控记忆。不重置的话, 一个 `memoryEnabled=false` 的工作区在 transcript 回放后仍会携带记忆。

历史恢复有两条路径, 优先用规范路径:

- **规范路径**: 若 DB 会话存了 `context.messages`(逐字保存的 `Conversation.Message[]`, 含 thinking/tool-use/tool-result 块), 就 `appendMessages` 原样灌回;
- **回放路径**: 否则从 transcript 取最近 200 条(`REPLAY_LIMIT`), 把 `user_message`/`assistant_message` 的文本逐条灌回。

两条路径都会**丢弃持久化的 `<system-reminder>` 包裹消息**: 这些是运行时可重新派生的(记忆注入每次重建、MCP 指令经 `syncMcpInstructions` 重新播报), 留着会每次重启累积一层。活跃技能也从会话的 `activeSkills` 恢复到句柄的技能表。

### 3.4 事件溯源与序列号

会话持久化是**纯 DB**的: 引擎自身的 JSONL 会话写入被 `sessionId: ""` 禁用, 权威记录是 `AgentSession`(含 `context`/`activeSkills`/`runtimeMetadata`)加一串按序递增的 `AgentTranscriptEvent`。每个事件带 `sessionId`/`sequence`(bigint)/`turnId`/`kind`/`payload`/`createdAt`。追加事件在事务里同时推高会话的 `lastEventSequence` 高水位。

这套设计让"回放"成为一等能力: 新连接发 `hello`(可带 `afterSequence`), 服务器经 `sendBacklog` 从高水位往回按批(每批最多 1000 条)推送 `transcript_batch`, 客户端据此重建完整对话。断线重连只需带上自己见过的最高序列号, 即可增量补齐, 不丢事件。

### 3.5 事件适配器与 finalizeTurn

`createEventAdapter` 是一个有状态的逐轮翻译器, 把引擎的 `AgentEvent` 分成两类输出: **持久化的 transcript 事件**(带序列号)与**瞬时的结构化消息**(流式增量)。分流原则是: 高频 token 增量走瞬时通道, 累积的助手文本在轮末作为一条 `assistant_message` 落库一次。

| 引擎事件             | 适配器输出                                                              | 落库 |
| -------------------- | ----------------------------------------------------------------------- | ---- |
| `stream_text`        | `assistant_delta`(瞬时), 同时累积进 narration                           | 否   |
| `thinking_text`      | `agent_status { phase: thinking }`(瞬时)                                | 否   |
| `steering_delivered` | `agent_status`(瞬时)                                                    | 否   |
| `permission_request` | `agent_status { phase: permission }`(瞬时)                              | 否   |
| `thinking_complete`  | `thinking` 事件                                                         | 是   |
| `tool_use`           | `tool_use`(含从 args 提取的 `detail` 摘要)                              | 是   |
| `tool_result`        | `tool_result`(输出截断到固定长度)                                       | 是   |
| `usage`              | `usage`, 并累加 input/output token                                      | 是   |
| `compact`/`retry`    | 同名事件                                                                | 是   |
| `error`              | `error`, 并把 outcome 置 `error`                                        | 是   |
| `turn_complete`      | `turn_complete`                                                         | 是   |
| `loop_complete`      | `loop_complete`, 按 `stopReason` 定 outcome(end_turn/interrupted/other) | 是   |

`detail` 摘要从工具参数里按优先级取第一个非空字符串字段(`file_path`/`path`/`pattern`/`command`/`name`/`query`), 折叠空白并截断到 200 字符, 让前端能在不展开完整参数的情况下显示"这个工具在干什么"。

轮末 `finalizeTurn` 依次做四件事:

1. **落库叙述**: 把适配器累积的 narration 作为一条 `assistant_message` 落库(若非空);
2. **上报指标**: 把本轮 input/output token 用量记进 `metrics.recordAiTokenUsage`(`modelRole: "agent"`);
3. **git 快照**: 仅当 outcome 为 `end_turn`(模型正常结束而非中断/出错)时, 对工作目录做一次 `git.snapshot(workDir, "agent: {turnId}")`, 并广播带 revision 的 `files_changed`;
4. **保存上下文**: 把 `handle.conv.getMessages()`、活跃技能名、运行时元数据存进 DB 会话, 其中包含本轮新写入的 **rewind 检查点**(见 3.6, 上限 50 个)。

最后置会话状态 `IDLE` 并广播 `runtime_status: idle`。

### 3.6 对话回退: rewind 检查点

每次 `finalizeTurn` 保存上下文时, 会把当前轮末的对话位置连同对应的 git 快照 sha 一起, 作为一个检查点追加进会话的 `runtimeMetadata.rewindPoints`(上限 `MAX_REWIND_POINTS = 50`)。回退因此能同时锚定"对话"与"代码"两个维度:

- `/rewind` 或 UI 触发 `rewind_list` 广播: 每个快照带 sha/消息/日期, 以及 `conversation` 布尔(该检查点是否也能回退对话);
- 客户端回 `rewind_action { sha, action }`, `action` 三选一: `code_and_conversation`(对话与代码一起回退)、`conversation_only`(只回退对话)、`code_only`(只回退代码, `/rewind <sha>` 命令默认走这个);
- 服务端按动作组合执行: 会话消息截断(`truncateTo`/`truncateAfter`)、transcript 截断并重置序列高水位(`truncateAfter` + `setSequence`)、`git rewindTo`(见 6.7), 然后向所有连接广播 `session_replaced { sessionId, highWatermark }`;
- 客户端收到 `session_replaced` 后把本地序列归零、递增 `resyncCounter`, 重新发 `hello` 从序列 0 拉全量, 本地 transcript 完整重建。

### 3.7 销毁: 显式排空长驻资源

运行时是长驻的, 因此销毁路径必须显式处理在途轮次与后台任务。`disposeResources` 的顺序是: 中止当前轮 → 取消会话所有待决交互(失败关闭)→ **排空内部锁**(等当前轮结束; 销毁从不从锁内部调用, 否则会死锁)→ 等会话就绪后再取消一次交互 → 停后台任务与团队成员 → 断开所有 MCP 连接 → 触发 `shutdown` Hook → 以 1001 关闭所有 WebSocket 连接。文件快照(fileHistory)由引擎在每次变更时增量落盘, 销毁不做额外持久化。每一步都吞掉异常, 保证一个资源清理失败不阻断其余。

## 四、连接层: WebSocket 协议与准入

### 4.1 端点、鉴权分级与连接上限

Agent 实时协议走 `GET /app/:appId/agent/ws`(WebSocket 升级)。连接按访问权限分级: owner 与管理员是**可写**连接(能 run/abort/应答交互/发命令), 其他已登录用户是**只读**连接(只能收事件与回放)。只读连接发起 `run` 或应答交互时, 服务器返回结构化的 `read_only` 错误而非静默忽略。鉴权失败的连接在 `onOpen` 时直接以 1008 关闭。每个工作区还有连接数上限 `AGENT_MAX_CONNECTIONS_PER_WORKSPACE`(默认 8), 超限的连接以 1013(服务过载)关闭。

客户端消息里的 `runtime_action`(start/stop/restart/install)会被显式拒绝并返回错误"Preview runtime is controlled by the client, not the server"——预览运行时的生命周期权在浏览器, 服务器从不代管。

### 4.2 心跳与重连

服务器每 30 秒向所有连接发 ping 并清扫: 超过 75 秒没有活动的连接直接 terminate。客户端每 20 秒发一次 `heartbeat`(服务器回 `heartbeat_ack`), 10 秒内没有 ack 就判定断线; 重连退避从 500ms 起逐步拉长到 15s, 重连后带上本地最高序列号增量补齐(见 3.4)。

### 4.3 消息协议一览

双端消息全部由 zod schema 严格定义(两端共享类型)。客户端 → 服务器:

| 消息                                        | 说明                                                                                                        |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `hello`                                     | 订阅并可带 `afterSequence` 触发增量回放                                                                     |
| `run`                                       | 提交输入(`input` 上限 50000 字符, 可附 `selectedElement`、`previewError`(上限 20000)、`clientFileRevision`) |
| `abort`                                     | 中止当前轮                                                                                                  |
| `permission_response` / `question_response` | 应答权限(`allow`/`deny`, 可 `remember`)与提问                                                               |
| `command_complete`                          | 回传命令执行结果(exitCode + 输出, 上限 1MB)                                                                 |
| `heartbeat` / `background_shells`           | 心跳; 把前台 shell 转后台(对齐终端 Ctrl+B)                                                                  |
| `plan_approval_response`                    | 计划审批(`yolo`/`manual`/`feedback`, 可附 feedback 文本)                                                    |
| `rewind_action`                             | 回退(sha + 三种动作)                                                                                        |
| `file_complete_request`                     | `@` 提及的文件名补全(query 上限 1024)                                                                       |
| `image_upload`                              | 图片上传(clientId + name + base64 数据, 上限 64MiB)                                                         |

服务器 → 客户端的消息按职能分组:

- **会话与回放**: `ready`(sessionId、序列高水位、readOnly、权限模式、运行时状态、当前 turnId、待决交互、模型/思考强度、上下文 token/窗口、沙箱/记忆/Hook 开关、计划审批挂起标志)、`event`、`transcript_batch`、`session_replaced`;
- **流式增量**: 结构化瞬时帧 `agent_status`(thinking/steering/follow-up/权限/模型变更等 phase)、`assistant_delta`、`tool_output`;
- **交互**: `permission_request`、`question_request`、`interaction_resolved`(outcome 含 `expired`);
- **命令**: `command_result`(supported + result/error)、`candidates`(自动补全);
- **状态**: `runtime_status`(idle/running/waiting/stopped/error)、`files_changed`、`permission_mode`、`usage`;
- **选择器**: `plan_approval_request`、`model_list`、`thinking_form`、`rewind_list`;
- **输入辅助**: `file_complete_response`(最多 50 个匹配)、`image_saved`/`image_error`、`history`(提示词历史);
- **活动面板**: `subagent`/`team`/`task` 帧(见 8.3);
- **错误**: `error { code, message, recoverable }`, 典型 code 有 `read_only`、`bad_json`、`bad_message`、`workspace_busy`、`model_switch_failed`。

### 4.4 claimTurn: 跨节点轮次互斥

多实例部署下, 同一个工作区的轮次不能并发执行。`claimTurn` 用一条原子 SQL 抢占: `updateMany` 把会话状态从 `IDLE` 置为 `RUNNING`, 条件是 `status = IDLE`, 或者 `status = RUNNING` 但 `lastActiveTime` 早于 `AGENT_TURN_CLAIM_STALE_MS`(默认 30 分钟)——后者是对崩溃节点留下"僵死 RUNNING"的回收。更新行数为 0 即抢占失败, 服务器给连接回 `workspace_busy`。追加事件的事务同时刷新 `lastActiveTime`, 使正常执行的轮次不会被误判为僵死。

### 4.5 输入增强: @ 提及、图片、用户 shell、历史与恢复

- **`@` 文件提及**: 输入框键入 `@` 触发 `file_complete_request`, 服务器在工作目录里匹配(30 秒文件缓存, `FILE_CACHE_TTL_MS`)并经 `file_complete_response` 回最多 50 个路径; 提交时 `AtExpand.expandAtRefsWithImages` 把提及的文件内容(与图片)内联进会话消息;
- **图片上传**: `image_upload` 的 base64 解码后上限 32MB(`MAX_UPLOAD_IMAGE_BYTES`, 协议帧上限 64MiB), 按魔数嗅探只接受 png/jpeg/gif/webp, 以 0o600 权限写入该应用专属的 `{appId}.uploads` 目录, 成功回 `image_saved { clientId, path }`——路径随后可被 `@` 引用进对话;
- **用户 shell**: `!` 与 `!!` 前缀经 `Conversation.UserBash.parseUserBashCommand` 解析, 复用工作区的 `Bash` 工具在工作目录执行, 输出经 `tool_output` 帧流式推送并落库 `tool_use`/`tool_result`; `!` 的执行结果(命令/耗时/状态/输出)会以 user message 形式进入模型上下文, `!!` 则执行但不进上下文, 均支持中止;
- **提示词历史**: 前端请求后, 服务器从 transcript 取最近 200 条(`HISTORY_LIMIT`)用户消息, 以 `history` 帧下发(协议上限 500 条);
- **会话恢复**: REST 列出并可恢复历史会话, `resumeAndSetCurrent` 对 `RUNNING`/`WAITING` 状态的会话返回忙错误, 防止两个客户端同时接管一个活跃会话。

## 五、生成产物的挂载与预览

### 5.1 文件树从服务器到浏览器

预览的第一步是把服务器文件树搬进容器。链路是: 前端经 REST 拉 `GET /app/files/:appId` 得到一棵 `AgentFileNode` 树(每个文件带相对路径、sha256、内联内容, utf8 或 base64; 目录带排序后的子节点), 经 `agentTreeToFileSystem` 转成 WebContainer 的 `FileSystemTree`(base64 解码成字节, 文本保持字符串), 再 `container.mount(tree)`。转换与快照都会跳过忽略段(`node_modules`/`dist`/`build`/`.git`/`.yukino`), 避免把构建产物或依赖搬进容器再搬回来。工作区没有 `package.json` 时直接跳过预览引导。

### 5.2 预览生命周期状态机

预览有一个明确的状态机: `idle → booting → mounting → installing → starting → ready`(任一阶段失败转 `failed`)。`startPreview` 是入口, 它把整个流程包进一条**文件系统串行队列**(`queueFsTask`), 保证挂载、安装、保存、Agent 同步不会在容器 FS 上交错。状态推进由 `PreviewCallbacks` 回调给 UI, 每个状态对应一句人话文案(如 `installing` → "Installing dependencies in your browser...")。

几个关键的防御性设计:

- **代际取消**: 每次 `startPreview` 递增一个全局 `previewGeneration` 并取消上一个 pending run; 每个异步阶段后都用 `assertPreviewRunCurrent` 检查"我还是当前这一代且未被取消且组件仍在", 否则抛 `PreviewRunCancelledError`。这让"用户快速切换应用/重新生成"不会留下交错的半成品预览;
- **模块级单例**: `activePreview`/`pendingPreview`/`installedDependencyFingerprint`/`mountedAppId` 是模块级变量, dev server 因此能在组件重挂载后存活, 同一应用重新渲染不会重启预览;
- **dev server 就绪竞态**: dev server 以 `npm run dev -- --host 0.0.0.0` 启动, `Promise.race` 同时等"spawn 结果 / `server-ready` 事件 / 进程退出 / 30 秒超时 / 取消"五种结果, 任一非就绪结果都会清理已 spawn 的进程, 避免泄漏;
- **意外退出上报**: 就绪后的 dev server 进程被持续观察, 若意外退出则把 `activePreview` 清掉并向 UI 报 `failed` 与错误信息。

### 5.3 依赖指纹与增量重启

不是每次同步都要重装依赖。客户端的 `dependencyFingerprintFromTree` 对一组依赖清单文件(`package.json`/`package-lock.json`/`npm-shrinkwrap.json`/`pnpm-lock.yaml`/`yarn.lock`)逐个计算 `path:length:hash` 并拼成一个指纹; 只有当"容器里没有 `node_modules`"或"指纹与上次安装时不同"才触发 `npm install`。这把"只改了源码"的常见情形降为"直接复用已装依赖 + 重启 dev server", 大幅缩短二次预览时间。服务器侧的变更检测(`workspace-tree` 的 `dependencyFilesChanged`)覆盖更宽的 7 个文件(额外包含 `bun.lock`/`bun.lockb`), 一旦依赖文件变化, 同步逻辑会整体重启预览(重新挂载 + 视情况重装)。

安装本身有一个刻意的动作: **先删掉 `package-lock.json` 再执行 `npm install`**(`runInstall` 先 `removeIfPresent(container, "package-lock.json")` 再 `container.spawn("npm", ["install"])`)。这让 npm 按容器当前平台重新解析依赖与平台专有二进制: 别的平台解析出的 lockfile 可能漏掉当前平台的可选依赖(如 musl 平台的原生二进制包), 导致"安装成功但 dev server 起不来"。

### 5.4 WebContainer 在链路中的角色

WebContainer 通过一个单例 `getWebContainer()` 引导: 先检查 `crossOriginIsolated`(否则直接拒绝, 提示需要 COOP/COEP 头), 再以 `coep: "credentialless"`、`forwardPreviewErrors: true`、`workdirName: "project"` 启动。引导失败会清掉缓存的 promise 以便重试。`forwardPreviewErrors` 是预览错误回传(见 6.3)的开关。客户端 `vite.config.ts` 给 dev 与 preview 都设置了 `Cross-Origin-Embedder-Policy: credentialless` 与 `Cross-Origin-Opener-Policy: same-origin` 头, 以满足隔离要求; 开发态还把 `/api` 代理到 `http://localhost:3000`(含 WebSocket 升级)。

容器还承载 Monaco 之外的另一类交互: 文件浏览器直接读容器当前工作副本(`walkContainerTree`), 因此能反映 Agent 输出之外的、终端或预览构建产生的变化; 终端(xterm.js)也在容器里跑 shell。

## 六、与 Yukino 编码 Agent 的集成

### 6.1 引擎以库形式复用: createRemoteAgent 与句柄

平台通过 `@yukino.js/yukino` 的 `Remote.Server.createRemoteAgent` 拿到一个 `RemoteAgentHandle`, 这是集成的核心接缝(引擎整体见 [yukino-code](../docs/yukino/yukino-code))。句柄暴露了引擎的全部长驻状态, 平台按需取用:

| 句柄成员                                | 平台用途                                              |
| --------------------------------------- | ----------------------------------------------------- |
| `conv` / `client` / `registry`          | 会话、LLM 客户端、工具注册表, 每轮构造 `Agent` 时传入 |
| `contextWindow` / `provider`            | 上下文窗口与 Provider 配置(切模型时重建)              |
| `fileHistory` / `fileStateCache`        | 文件快照历史与文件状态缓存(rewind 与读文件用)         |
| `recoveryState`                         | 压缩恢复状态                                          |
| `skillCatalog` / `activeSkills`         | 技能目录与已激活技能                                  |
| `mcpManager` / `hookEngine`             | MCP 连接与 Hook 引擎                                  |
| `memoryManager`                         | 长期记忆管理(list/clear/buildSystemReminder)          |
| `teamManager` / `backgroundTaskManager` | 团队与后台任务(中止/销毁时停掉)                       |
| `goalManager`                           | 目标跟踪(`/goal` 命令)                                |
| `checker`                               | 句柄级权限检查器(与每轮检查器同步)                    |
| `toolFilter`                            | 句柄级工具过滤, 与 coordinator 过滤叠加               |

平台用 `enableCoordinatorMode: false`、`enableModelPlanMode: true`、`forkDisabled: false` 创建句柄, 即不启用 coordinator、启用模型驱动的计划模式、不禁用 fork。

### 6.2 运行时切换: 模型、思考强度、沙箱与 MCP

- **模型**: `/model` 不带参数触发 `LLM.ModelDiscovery.discoverModels` 探测 Provider 的模型列表, 广播 `model_list`(loading → ready/empty/error); 选定后 `applyModel` 在运行时锁内重建 LLM 客户端(显式复用 `detectEnvironment` + `buildSystemPrompt`), 更新 `contextWindow` 并重算 MCP 工具策略, 把 `modelOverride` 持久化到工作区; 失败广播 `model_switch_failed`;
- **思考强度**: `/thinking` 广播 `thinking_form`(当前级别 + Provider 支持的级别列表), `applyThinkingLevel` 调 `client.setThinkingLevel` 并持久化 `thinkingLevel`;
- **沙箱**: `/sandbox auto|manual|off`(见引擎文档 [sandbox](../docs/yukino/sandbox))。`auto`/`manual` 创建沙箱并挂到 `Bash` 工具上(`sandboxRequired: true`, 允许写工作目录与系统临时目录, 放行网络), 分别对应"自动放行"与"逐次询问"; `off` 释放沙箱并清掉 Bash 上的沙箱绑定。两种状态都持久化为 `sandboxEnabled`/`sandboxAutoAllow` 并同步到权限检查器; 不带参数时汇报当前状态;
- **MCP 热重载**: `/mcp reload` 重读工作区启用的 MCP 配置行并原地重连(配置清空时断开全部连接并撤回已播报的 MCP 指令), 返回连接数/工具数/错误列表, 无需重建句柄。

### 6.3 生成 → 运行 → 报错 → 修复闭环

闭环的"报错 → 修复"一段有两条回传路径, 都复用 `run` 通道:

- **预览运行时错误**: WebContainer 以 `forwardPreviewErrors` 把 iframe 里的错误经 `preview-message` 事件转发出来。前端 `usePreviewErrors` 订阅该事件, 用 zod 判别三种类型(`PREVIEW_UNCAUGHT_EXCEPTION`/`PREVIEW_UNHANDLED_REJECTION`/`PREVIEW_CONSOLE_ERROR`), 归一成 `{ message, stack? }`, 既显示在预览错误面板, 也经 `reportRuntimeIssue` 上报观测;
- **一键修复**: `buildPreviewFixPrompt` 把错误拼成一段固定提示词("Fix the generated React app error below. Inspect the current project, make the smallest correct change, and keep all unrelated behavior intact.", 后接 Error 与 Stack), 作为 `previewError` 随 `run` 发给 Agent, 在 2.3 第 4 步被包进 `<preview-error>` 块。

编译错误则由构建工具在预览里直接呈现, 用户同样可以复制回 Agent。这样"生成 → 浏览器运行 → 报错 → 回传 → Agent 修复 → 再同步"形成完整回路。

### 6.4 双向文件同步与三方合并

文件有两个写入方: Agent(经服务器磁盘)与用户(经 IDE 的 Monaco 编辑器)。同步的核心是 `useWorkspaceController` 里的 `resyncAfterAgent`, 在 Agent 轮次结束或文件变更事件后触发(带 250ms 防抖 `SYNC_DEBOUNCE_MS`):

1. 拉服务器文件树, 与上一次服务器快照对比;
2. **依赖文件变化**(`dependencyFilesChanged`, 覆盖 `package.json`/lockfile/`bun.lock`/`bun.lockb`)→ 关闭现有 watcher, 重新 `startPreview`(重新挂载 + 视情况重装 + 重启 dev server);
3. 否则逐文件处理: 二进制文件按 hash(客户端为 FNV-1a 32 位)变化覆盖; 文本文件若本地 buffer 是脏的, 就做**三方合并**(`threeWayMerge(base, local, server)`): 只有一侧偏离 base 就取那一侧, 两侧相同取其一, 否则判为冲突;
4. 干净的合并直接写容器并更新 buffer; 冲突则把服务器版本写进容器、把 buffer 标记为冲突态(`{ base, local, server }`), 交给差异编辑器让用户裁决;
5. 服务器删除的文件: 本地脏的转成"本地 vs 空"的冲突, 否则从容器移除。

三方合并刻意做得"实用": 它不做行级 diff, 只在整文件层面判断"谁偏离了 base"。这把合并逻辑抽成了纯函数, 可以脱离 React 与容器单独测试(见 8.5)。用户保存文件时走 REST `PUT /app/files/:appId/file`, 带 `expectedHash`(sha256)做乐观锁; 服务器发现 hash 不匹配就返回 `conflict`, 前端据此提示而非静默覆盖。

### 6.5 文件 REST API 与路径安全

文件 API 挂在 `/app/files/:appId` 下: `GET /`(整棵树, 每文件带 sha256, 任何已认证观察者可读)、`PUT /file`、`POST /directory`、`POST /rename`、`DELETE /entry`。写操作仅 owner/管理员, 且都在 `runtime.runExclusive` 里执行——与 Agent 轮次共享同一把锁, 完成后 `notifyFilesChanged` 广播 `files_changed` 让其他连接刷新。

每个路径都过 `validateRelativePath`: 拒绝空路径、反斜杠、绝对路径、`..`/`.`/空段, 以及受保护段(`.git`/`.yukino`/`.env`/`node_modules`/`dist`/`build`); 解析后做前缀校验防拼接逃逸。写入前还检查祖先目录不是符号链接(`assertNoSymlinkAncestors`), 防符号链接逃逸。写盘用临时文件 + `rename` 原子替换, 重命名与删除同样要求 `expectedHash`。单文件上限 5MB(`MAX_PROJECT_FILE_BYTES`), 整棵树上限 20MB(`MAX_TREE_BYTES`), 超限拒绝。

### 6.6 能力 REST: 设置、会话、技能、记忆、Hook、团队与 MCP

每个应用工作区都能配置引擎的全套扩展能力, 经一组 REST(`/:appId/agent/*`)管理:

- **Settings**: `GET`/`PATCH` 工作区设置(`permissionMode`/`sandboxEnabled`/`sandboxAutoAllow`/`memoryEnabled`/`hooksEnabled`/`modelOverride`/`thinkingLevel`);
- **Sessions**: 列出与恢复历史会话(见 4.5);
- **Skills**: 列出、`reload`、从源安装;
- **Memory**: 查看与清空长期记忆(运行时的 `Memory.Manager.MemoryManager` 暴露 name/description/type/path);
- **Hooks**: 生命周期钩子的增删改查; 事件枚举为 `session_start`/`session_end`/`turn_start`/`turn_end`/`pre_send`/`post_receive`/`pre_tool_use`/`post_tool_use`/`shutdown`, 超时 100–120000ms(默认 10000ms), 由 `hooksEnabled` 总开关门控;
- **Subagents / Teams**: 只读列出子代理定义(来自引擎的 `Subagent.Loader.loadAgentDefinitions()`, 含 model/background/worktree 等字段)与团队及其共享任务(读 `{teamDir}/tasks.json`);
- **MCP 服务器**: 支持 `stdio`/`http`/`sse` 三种传输; `headers` 与 `env` 里的敏感值以 AES-256-GCM 加密落库(见 7.2); 返回给前端的 VO 是脱敏的(只有 `hasHeaders`/`hasEnv` 布尔); 任一写操作后 `invalidate` 运行时; 专门的 `POST /:mcpId/test` 端点做连接测试, 结果(`CONNECTED`/`ERROR` + 错误信息)回写配置行。

设置的生效方式分两类: **软设置**(`permissionMode`/`sandboxEnabled`/`sandboxAutoAllow`/`memoryEnabled`)经 `applySoftSettings` 直接打到存活运行时, 下一轮即生效; **需要重建的**(`hooksEnabled`/`modelOverride`/`thinkingLevel`)则 `invalidate` 运行时, 下次访问时按新配置重建句柄。这条区分避免了"改个权限模式就要重建整个 Agent"的浪费, 同时保证真正影响 Agent 栈的配置一定走重建。

### 6.7 Git 快照与 worktree

`git-runtime` 在生成项目目录里维护一个尽力而为的 git 仓库: `ensureRepo` 首次 `git init`, 随后 `add -A` + `commit --allow-empty`(消息 `chore: initial project snapshot`)打下基线; `snapshot` 在 `end_turn` 时 `add -A`, 若 `status --porcelain` 无变更则跳过, 否则提交(消息 `agent: {turnId}`); `listSnapshots` 用 `git log -n 50 --pretty=format:%H%x1f%s%x1f%cI` 解析出 sha/消息/日期; `rewindTo` 用 `git checkout {sha} -- .` + `add -A` + 提交(`chore: rewind to {sha}`)实现回滚。所有 git 调用都带 16MB 的 `maxBuffer`, 并吞掉失败(缺 git、非仓库), 因为版本快照只是叠在引擎文件历史之上的便利层。提交者身份由 `GIT_SNAPSHOT_AUTHOR_NAME`(默认 "Yukino Agent")/`GIT_SNAPSHOT_AUTHOR_EMAIL`(默认 "agent@yukino.local")配置。

在此之上, 平台还经引擎的 Worktree 能力提供 `listWorktrees`/`createWorktree`/`removeWorktree`(见引擎文档 [worktree](../docs/yukino/worktree)), `/worktree` 命令即列出当前工作区的全部 worktree。

## 七、安全边界

### 7.1 生成代码的执行隔离

生成代码**从不在服务器进程里执行**: 服务器只把它当文件存储, 构建与运行都发生在用户浏览器的 WebContainer 沙箱里。这条隔离把"运行不可信生成物"的风险从服务器转移到了用户自己的设备。需要清醒认识的是, 浏览器沙箱保护的是服务器而非用户——容器内的代码仍能消耗用户算力、访问被容器放行的网络出口, 这是所有预览型产品的固有风险面。服务器侧对生成物的唯一"执行"是 git 命令(快照/回滚)与用户 shell, 且都在受控的工作目录内。

### 7.2 密钥与凭据

MCP 服务器的 `headers` 与 `env` 以 AES-256-GCM 对称加密落库: 密钥来自 `MCP_SECRET_KEY`(base64 编码的 32 字节), 密文打包成 `iv(12) || authTag(16) || ciphertext` 再 base64 存储; 解密时校验长度并 `setAuthTag`, 篡改会导致认证失败。比较用 `timingSafeEqual` 恒定时间比较。返回给前端的 MCP VO 完全脱敏, 只暴露 `hasHeaders`/`hasEnv`。

部署密钥同样受保护: `MCP_SECRET_KEY`、`SESSION_SECRET`、`PASSWORD_SALT` 在生产环境使用默认值会被拒绝启动(见 7.4)。模型端点密钥(`AI_API_KEY`)只存在于服务器环境, 从不下发前端。

### 7.3 文件路径安全

6.5 已详述文件 API 的多层校验。这里强调它防御的攻击面: 路径穿越(`..`、绝对路径、反斜杠)、受保护目录访问(`.git`/`.yukino`/`.env`/`node_modules`/`dist`/`build`)、路径拼接逃逸(解析后前缀校验)、符号链接逃逸(祖先目录 `lstat` 检查)、并发覆盖(sha256 乐观锁)。Agent 自身的文件工具也受引擎的路径沙箱约束(见 [yukino-code](../docs/yukino/yukino-code)), 两层叠加。

### 7.4 配置 fail-fast 与传输防护

平台在启动时对环境变量做结构校验(zod)与语义校验(`superRefine`)。生产环境(`NODE_ENV=production`)下, 以下任一条件都会**拒绝启动**: CORS 含通配 `*`、`PASSWORD_SALT`/`SESSION_SECRET`/`MCP_SECRET_KEY` 仍是默认值、未配置 `REDIS_URL`、`STORAGE_DRIVER` 仍是 `local`、未配置 MinIO 的 access/secret key。把部署错误暴露在启动期而非运行期, 是这套校验的核心价值。

传输层防护: WebSocket 消息有大小上限(`AGENT_WS_MAX_MESSAGE_BYTES`, 默认 512KB; 图片上传帧单独放宽到 64MiB), 解析失败与 schema 校验失败返回结构化错误(`bad_json`/`bad_message`), 未鉴权连接被关闭, 只读连接不能发起运行或应答交互, 单工作区连接数超上限以 1013 关闭; HTTP 层有请求体大小限制(`REQUEST_BODY_LIMIT_BYTES`, 默认 1MB; 文件写入的 `PUT` 单独放宽到可容纳 5MB base64 的尺寸)、CORS 白名单与签名会话。轮次执行权由 `claimTurn` 在数据库层互斥(见 4.4)。

### 7.5 前端 XSS 与跨源消息校验

Agent 回复的 Markdown 在渲染前经 `renderSafeMarkdown` 消毒: `marked`(gfm + breaks)解析后用 `DOMPurify.sanitize`(`USE_PROFILES: { html: true }`, `FORBID_TAGS: ["script", "style"]`)清洗, 再做代码高亮。前端安全在这里的重要性高于常规应用, 因为页面要渲染模型生成的任意文本。

可视化编辑的跨源消息双向校验: 发给 iframe 的 `postMessage` 优先用预览 origin(解析不到时回退 `*`); 收 iframe 回传的消息时, 校验 `event.source === iframe.contentWindow`, 预览 origin 可解析时还要求 `event.origin === previewOrigin`, 再过 `visualEditorIncomingMessageSchema`。预览错误回传同样过 zod 判别。用户输入与模型输出在进入数据库与渲染路径前都有类型校验。

## 八、可观测性与工程化

### 8.1 健康探针与指标

平台提供四个管理端点: `/health`(存活探针, 恒返回 ok)、`/management/health`(依赖健康, 检查 database/modelProvider/redis/storage 四项, 任一非 up 则整体 503)、`/management/info`(应用名与版本)、`/management/prometheus`(Prometheus 文本格式指标)。指标定义了四个计数器: `ai_model_requests_total`、`ai_model_errors_total`、`ai_model_tokens_total`、`ai_model_response_duration_seconds_sum`。

需要如实指出: 这四个计数器里**目前只有 token 用量被实际记录**——`finalizeTurn` 在每轮结束调 `recordAiTokenUsage` 上报 input/output token; 请求数、错误数、响应耗时的记录点尚未接线。指标服务的接口已就位, 但采集面还窄。

### 8.2 请求上下文与前端监控

中间件为每个请求注入请求标识与日志上下文(`createRequestContextMiddleware`), 日志级别可配(`LOG_LEVEL`)。前端接入了 [yukino-sentry](./yukino-sentry) 监控 SDK: `main.tsx` 里 `init` 后启用 `PerformancePlugin`/`ScreenRecordPlugin`/`ExposurePlugin`, 并用 `ReactErrorBoundary` 包裹根组件; `vite.config.ts` 用 `sentryPlugin` 做 dev 态 source map 解析。预览运行时错误经 `reportRuntimeIssue` 一并上报, 使"用户看到白屏"与"哪个预览错误导致白屏"能在同一处关联。

一个诚实的边界: SDK 的 `beforeSend` 在生产构建里返回 `false`, 即**生产环境实际上不外发上报**(DSN 也仍是占位符); 前端监控当前主要在开发态生效。`reportRuntimeIssue` 本身只是 `console.error("[release-safety]", ...)` 的薄封装(四种问题类型), 是一个不依赖外部服务的兜底记录点。

### 8.3 活动面板与通知轮次

运行时经 `attachActivityBridge` 把引擎的并行活动持续广播给前端:

- **子代理**: 引擎的 `onSubagentEvent` 生命周期事件(started/tool_use/tool_result/turn_complete/finished)被折叠进 `subagentStates` 映射, 每次变化广播一帧 `subagent` 状态(角色、后台标志、活跃工具、轮次计数);
- **团队与后台任务**: 后台任务走订阅推送, 团队成员列表以 500ms 周期轮询并按内容签名去重(定时器 `unref`, 不阻止进程退出), 分别广播 `task`/`team` 帧;
- **通知轮次**: 后台任务与团队成员的通知只在引擎循环内投递, 因此空闲运行时由一个 250ms 的唤醒定时器驱动"仅通知轮次"(`runNotificationTurn`), 让通知不依赖用户输入也能送达。

### 8.4 优雅关闭

进程收到 `SIGINT`/`SIGTERM` 后: 先 `closeServer`(停止接受新请求), 再 `runtimeManager.disposeAll()`(逐个销毁运行时: 中止在途轮次、取消待决交互、停后台任务与团队成员、断开 MCP、触发 shutdown Hook、关闭连接), 最后断开 Redis 与数据库。因为运行时是长驻的, 关闭路径必须显式处理在途轮次与后台任务, 否则会留下半写入的文件状态。`disposeAll` 会先等所有在途生命周期任务完成, 保证不销毁一个正在创建的运行时。

### 8.5 测试与类型纪律

双端都是 TypeScript strict。测试把并发、取消、合并这类易错的**纯逻辑**从 API 副作用里抽出来单独测: 服务端有 `agent-runtime-concurrency`(轮次串行化)、`turn-gate`(准入与公平性)、`command-dispatcher`、`event-adapter`、`mcp-config`、`mcp-crypto`、`project-files`(路径安全)、`protocol`(schema)、`common` 等用例; 客户端有 `webcontainer-runtime`(代际判断、依赖指纹)、`workspace-tree`(三方合并、树转换)、`workspace-paths`、`agent-protocol`、`use-agent-transcript`、`build-error-context`、`agent-socket-url`、`ansi-log` 等。副作用集中在薄封装层, 这让浏览器运行时这类难以端到端测试的代码仍有可靠的回归保障。

## 九、适用场景与边界

**适合**: 在既有产品里加入"AI 生成可交互 Web 应用"能力; 需要"描述即预览"的低延迟原型生成; 希望复用一套成熟编码 Agent 引擎(而非自研循环)去驱动全栈生成的团队; 需要把生成/运行/修复闭环、文件双向同步、git 快照、计划审批与权限交互一并产品化的场景。

**边界与注意**:

- 预览链路钉在 **npm 生态 + `npm run dev`** 上, 一键修复提示词面向 React 应用; 其他技术栈需要自行适配预览与修复两端;
- 服务器**不做构建**, 预览算力全在用户浏览器, 因此依赖用户设备性能与 WebContainer 的跨源隔离要求(COOP/COEP);
- 文件一致性靠"服务器权威 + 三方合并 + sha256 乐观锁", 但三方合并是**整文件级**的实用合并, 不做行级 diff, 两侧同时改同一文件会判冲突交人工裁决;
- 容量与并发: 进程级 TurnGate 默认最多 4 个并发轮次(带用户公平调度), 每工作区最多 8 条 WebSocket 连接, 空闲 15 分钟回收运行时, 僵死的跨节点轮次声明 30 分钟后回收; 这些阈值分别由 `AGENT_MAX_CONCURRENT_TURNS`/`AGENT_MAX_CONNECTIONS_PER_WORKSPACE`/`AGENT_WORKSPACE_IDLE_MS`/`AGENT_TURN_CLAIM_STALE_MS` 调整;
- 指标采集面目前只有 token 用量, 前端监控在生产构建里实际不外发——可观测性接口已就位但尚未填满;
- 权限默认 `bypassPermissions`(无人值守生成), 需要人工把关时应切到 `default`/`plan` 等模式, 并接受交互代理 5 分钟超时后失败关闭(拒绝)、计划审批 10 分钟过期的行为;
- 对话回退检查点上限 50 个, 提示词历史上限 200 条, transcript 回放路径只恢复最近 200 条消息——超长会话的细粒度回退能力有明确边界。
