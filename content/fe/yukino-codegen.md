---
title: "Yukino Codegen: 从自然语言需求到可运行 Web 应用"
description: "AI 全栈代码生成平台的技术解析: 服务端用 Yukino 编码 Agent 在真实磁盘上迭代产出 Vite 工程, 浏览器用 WebContainer 完成安装与预览, 二者以服务器权威文件 + WebSocket 事件溯源 + 三方合并同步闭合生成/运行/修复回路"
local_path: "$HOME/github/yukino-codegen"
---

Yukino Codegen 是一个 AI 全栈代码生成平台: 用户用一句自然语言描述想要的应用, 平台在服务器上驱动一个真实的编码 Agent 在文件系统上迭代产出 Vite + TypeScript 工程, 再把这份工程同步进浏览器的 WebContainer 里完成依赖安装与 dev server 启动, 最终在预览 iframe 中呈现一个真实可运行的 Web 应用。本文讲的是这条主链路如何被工程化: 需求如何被翻译成 Agent 的系统提示词与工具调用, 服务器与浏览器各自承担什么职责, 生成产物如何挂载与预览, 生成/运行/修复循环如何闭合, 以及沙箱、密钥、文件路径等安全边界如何划定。

平台是一个 pnpm workspace 单仓, 由 `client/`(React 19 + Vite 7 前端)与 `server/`(Hono 4 + Prisma 7 后端)两个包组成。后端把 `@yukino.js/yukino` 当作库复用——它不是自己实现一个 Agent, 而是通过引擎的远程入口 `Remote.Server.createRemoteAgent` 拿到一整套 Agent 句柄, 再把它接到自己的会话存储、WebSocket 协议与文件 API 上。理解平台的关键, 是先理解这条闭环两端各自的事实权威在哪里: **服务器磁盘是文件的权威源, 浏览器容器只是可丢弃的执行环境**。

## 一、定位: 一句话需求如何变成可运行应用

### 1.1 产品形态与核心承诺

平台对外的承诺是"描述它, 看着它自己构建出来": 用户输入一段自然语言需求, 得到的是一个能被浏览器直接打开运行的 Web 应用, 而不是一段需要人工拼装的代码片段。围绕这条主链路, 平台提供了一整套产品面:

- 认证与用户体系、应用广场(`awesome` 列表)、我的应用、聊天记录持久化与回放;
- 每个应用一个 Agent 工作区: 会话 transcript、权限模式、MCP 服务器配置、生命周期 Hook、技能、长期记忆、子代理与团队;
- 在线 IDE: 文件树、Monaco 代码编辑器、xterm.js 终端;
- 可视化编辑: 在实时预览里点选元素, 描述修改意图, 由 Agent 映射回源码;
- Git 快照安全网: 每轮对话结束后对生成项目做一次提交, 可列出快照并回滚;
- 工程侧能力: 应用 zip 导出、管理后台、Prometheus 指标与健康探针。

这些能力不是并列堆叠的, 而是围绕"生成 → 运行 → 反馈 → 再生成"这一条闭环组织的。

### 1.2 与模板填充式生成的本质区别

AI 生成应用的实现路线大致分三代。第一代是模板与低代码拼接: 模型输出 JSON 配置, 前端用固定组件渲染, 表达上限被组件库锁死。第二代是代码片段生成: 模型直接吐代码, 由人工复制到工程里, 没有运行时验证。第三代是 agentic 生成: 模型作为 Agent 在真实文件系统上循环地计划、调用工具、观察结果、继续迭代, 产出工程化项目, 并配合浏览器内运行时把"运行结果"作为下一轮的输入。

本平台属于第三代, 两个结构性选择构成了与模板方案的真正分野:

- **服务端跑的是一个完整的编码 Agent**, 拥有真实文件读写与命令执行工具(`ReadFile`/`WriteFile`/`EditFile`/`Glob`/`Grep`/`Bash`), 把项目真实写入服务器磁盘, 而不是在内存里拼字符串;
- **浏览器端用 WebContainer 承载构建与运行**, 让 `npm install` 与 Vite dev server 发生在用户自己的设备上, 服务器只负责存储文件与驱动模型。

前者决定了生成物能达到工程化项目的复杂度, 后者决定了预览的边际成本与安全模型。两者之间的文件一致性, 则是整个平台最核心的工程难题(见第六节)。

### 1.3 适用场景与形态边界

平台适合的需求形态是"从零到可交互原型"与"中小型 Web 应用的一次性生成": 落地页、表单与看板、数据展示类前端、带简单后端的 demo。它不适合需要长期演化、有严格合规要求、或依赖专有二进制与内核态能力的产品——系统提示词把技术栈钉死在 Vite + React + TypeScript(见 2.1), 生成物是一个前端 SPA, 而非任意后端服务。

设计取舍上, 平台选择了"生成速度快、预览延迟低"而不是"生成即生产可用"。服务器磁盘上的项目目录是权威数据, 浏览器容器只是可丢弃的执行环境; 一旦关闭标签页, 容器内存文件系统即消失, 权威副本始终在服务器侧。这条取舍贯穿后文的同步、冲突与快照设计。

## 二、生成流水线: 系统提示词契约与单轮循环

### 2.1 系统提示词定义的行为契约

平台不把"你应该生成一个好网站"这类模糊指令交给模型, 而是用一份系统提示词(`server/prompts/site-generator-system-prompt.md`)把生成过程约束成可预测的工程动作。提示词里有一个 `{{OUTPUT_DIR}}` 占位符, 运行时被替换成该应用的工作目录绝对路径。它承担五类契约:

| 契约         | 内容                                                                                                                                           |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 脚手架契约   | 目录为空时用 `pnpm create vite . --template <用户偏好框架, 默认 react-ts>` 建项目; 给 `Bash` 传 `timeout: 300`                                 |
| 执行位置契约 | **禁止**在服务器上跑 `pnpm install`/`build`/`dev` 或任何依赖/构建命令——"浏览器会在你完成后安装依赖并运行 Vite"                                 |
| 修改契约     | 目录已有项目时先 `Glob` 看布局、`ReadFile` 读要改的文件, 再 `EditFile` 定点改或 `WriteFile` 整文件替换; 保留用户没提到的部分                   |
| 依赖契约     | 需要新包时**直接编辑 `package.json` 的 `dependencies`**, 不要安装; 浏览器同步文件后跑 `npm install`                                            |
| 回复契约     | 可见文本是预览旁的简短进度叙述, 一两句说明在做什么, 结尾给简短总结; **不要**输出代码块、文件转储或长列表; 源文件满足需求即停止调用工具结束本轮 |

提示词还写明了质量底线: 保持合法的 Vite React TS 工程(`package.json`/`index.html`/`src/`)、应用长大后拆组件、用 CSS 文件做样式、响应式布局、真实内容而非 lorem ipsum、可访问性基础(alt/label/键盘/对比度)、交互(tabs/filters/forms)必须真的能用、TypeScript 合法。最后一条尤其关键: "浏览器会把编译与运行时错误报给用户, 用户可以发回来做后续修复"——这正是生成/修复闭环(见 6.3)的提示词侧锚点。

`WriteFile` 与 `EditFile` 要求"覆盖已有文件前先读", 这条约束由引擎的工具实现强制, 提示词只是把它显式告知模型。

### 2.2 单轮生成的迭代循环

一次"生成"就是 Agent 的一次 `runTurn`: 把用户输入(可能附带可视化编辑选中的元素与预览错误)组成提示词, 交给引擎的 `Agent.run()` 事件流, 逐事件翻译成 WebSocket 消息并落库。迭代上限由 `AI_MAX_ITERATIONS`(默认 40)控制, 即一轮里模型最多被调用 40 次; 超过则引擎报 `error` 事件。上下文压缩与恢复完全复用引擎内核(见[yukino-code](yukino-code)第四节), 平台不另做一套: 当窗口将满时引擎自动压缩历史, 平台把 `compact` 事件落库, 恢复时按引擎的锚点式估算继续。

提示词组装(`composePrompt`)很薄: 用户原文之后, 若有可视化编辑选中的元素就追加一个 `<selected-element>` 包裹的 JSON 块, 若有预览错误就追加一个 `<preview-error>` 块。这两个块让"点选元素改样式"与"把报错发回去修"复用同一条 `run` 通道, 而不需要专门的 API。

### 2.3 工具面与文件写盘

Agent 的工具面就是引擎的默认工具集(文件读写、搜索、Bash、子代理、团队、技能、记忆等), 平台不裁剪工具, 只通过 `toolFilter` 叠加 coordinator 过滤(平台默认关闭 coordinator 模式, 故过滤恒真)。所有文件写入都落在 `tmp/code_output/{appId}/` 下——这是 `buildCodeOutputDir(rootDir, appId)` 解析出的每应用工作目录, 也是系统提示词里的 `{{OUTPUT_DIR}}`。

值得强调的是: **Agent 写的是服务器真实磁盘**, 不是浏览器容器。容器里的文件是后续从服务器同步过去的副本(见第五节)。这条"服务器先落盘、浏览器后同步"的顺序, 是平台所有文件一致性设计的前提。

### 2.4 权限模式与人工介入

引擎的权限检查器按工作区的权限模式构造。数据库侧有五种模式(`DEFAULT`/`ACCEPT_EDITS`/`PLAN`/`DONT_ASK`/`BYPASS_PERMISSIONS`), 映射到引擎的四种(`default`/`acceptEdits`/`plan`/`bypassPermissions`, 其中 `DONT_ASK` 与 `BYPASS_PERMISSIONS` 都落到 `bypassPermissions`)。默认工作区用 `bypassPermissions`, 即生成过程不打断用户——这是"看着它自己构建"体验的必要条件。

当模式不是 bypass 时, 引擎的每次工具授权请求会经 `onPermissionRequest` 回调进入平台的交互代理(interaction broker): 请求被持久化成一条 `AgentInteraction` 行, 同时通过 WebSocket 推 `permission_request` 给前端, 并把运行时状态置为 `waiting`。前端弹权限对话框, 用户允许/拒绝后回 `permission_response`, 代理解析 promise 并广播 `interaction_resolved`。提问(`AskUserQuestion` 工具)走同一条通道。

交互代理是**失败关闭**的: 5 分钟超时、会话取消、连接断开或运行时销毁, 都会把待决的权限请求解析为 `deny`、把提问请求 reject, 而不是静默放行。这保证了"无人值守的生成"不会在需要人确认时偷偷继续。

### 2.5 斜杠命令的服务端子集

前端聊天框支持斜杠命令, 但服务器只可靠执行其中一个子集: `help`/`status`/`clear`/`compact`/`skills`/`skill`/`memory`/`mcp`/`rewind`(`SERVER_SUPPORTED_COMMANDS`)。其余命令返回显式的 `unsupported` 而非静默失败。几个命令的实现思路:

- `/skill <name> [args]` 被改写成一次 Agent 轮次: 先用 `Skills.Executor.runInline` 把技能体展开成提示词, 再调 `runTurn`, 因此技能能真正驱动工具调用;
- `/compact` 镜像引擎主循环的压缩: 用客户端协议渲染工具 schema(而非 Anthropic 形状的原始 schema, 以免在 OpenAI 系客户端上扭曲 token 估算), 再按活跃 `toolFilter` 收窄, 调 `Compact.Compact.forceCompact`;
- `/rewind [sha]` 不带参数时列出 git 快照, 带 sha 时回滚(见 6.7);
- `/clear` 重置会话并新建一个 session, 然后给所有连接重发 `ready`。

命令候选列表(自动补全)由引擎的默认命令注册表加上 `.yukino/commands` 下的用户/项目命令组成, 冲突跳过, 与 CLI 加载语义一致。

## 三、服务端运行时: 每应用一个 AgentRuntime

### 3.1 RuntimeManager: 长驻、按应用键控、空闲回收

`createRuntimeManager` 持有所有 `AgentRuntime` 实例, 以 `${ownerId}:${appId}` 为键(规范工作区属于应用 owner)。运行时**跨连接长驻**: 同一个应用的多个 WebSocket 订阅者共享一个运行时, 一个用户断开不会销毁它。空闲回收由 `AGENT_WORKSPACE_IDLE_MS`(默认 15 分钟)控制, 一个 60 秒的 `setInterval` 扫描器(已 `unref`, 不阻止进程退出)淘汰 `!isBusy && now - lastActivity > idleMs` 的运行时; 淘汰前在生命周期锁内二次确认, 避免与正在创建的运行时竞态。

所有生命周期操作(创建、销毁、淘汰)都经一把每键的 `WorkspaceLockRegistry` 串行化, 并被追踪进一个 `lifecycleTasks` 集合; `disposeAll` 会先等所有在途生命周期任务完成, 再逐个销毁。这保证了"关闭时不会留下半创建的运行时"。

### 3.2 AgentRuntime: 句柄、会话与轮次的串行化

一个 `AgentRuntime` 拥有: 引擎句柄(`RemoteAgentHandle`)、规范 DB 会话、transcript 序列计数器、已连接订阅者集合, 以及一把内部 `AsyncLock`。**每轮都串行化**: `runTurn` 整个包在 `runLockedTask` 里, 因此同一应用不会有两轮并发。每轮构造一个**全新的 `Agent` 实例**, 但复用句柄上的长驻资源(会话、注册表、客户端、文件历史、MCP 管理器、团队管理器等)。

句柄是惰性创建的(`ensureHandle` → `createHandle`), 失败时清空 promise 以便重试。创建时:

1. `mkdir` 工作目录;
2. 并行读取启用的 MCP 服务器行与 Hook 行;
3. 用 `buildProviderConfig(env, workspace.modelOverride)` 组装 Provider(端点/协议/密钥/token 上限来自服务器配置, 模型可被工作区覆盖);
4. 调 `Remote.Server.createRemoteAgent({ askUser, cwd, enableCoordinatorMode: false, forkDisabled: false, hooks, mcpServers, provider })`;
5. `rehydrate` 把 DB 里的历史灌回句柄的会话。

### 3.3 rehydrate: 让 restoreContext 成为唯一注入点

`createRemoteAgent` 会无条件把项目指令与完整长期记忆注入会话。平台在 rehydrate 时**先 `handle.conv.reset()` 抹掉这次注入**, 理由是: 引擎的 `Agent.restoreContext()` 才是唯一的注入点——它在首轮重新注入指令、技能清单, 并按工作区的 `memoryEnabled` 门控记忆。不重置的话, 一个 `memoryEnabled=false` 的工作区在 transcript 回放后仍会携带记忆(因为引擎的 `injectLongTermMemory` 一旦注入过就是 no-op)。

历史恢复有两条路径, 优先用规范路径:

- **规范路径**: 若 DB 会话存了 `context.messages`(逐字保存的 `Conversation.Message[]`, 含 thinking/tool-use/tool-result 块), 就 `appendMessages` 原样灌回;
- **回放路径**: 否则从 transcript 取最近 200 条(`REPLAY_LIMIT`), 把 `user_message`/`assistant_message` 的文本逐条 `addUserMessage`/`addAssistantFull` 灌回。

两条路径都会**丢弃持久化的 `<system-reminder>` 包裹消息**: 这些是运行时可重新派生的(记忆注入每次重建、MCP 指令经 `syncMcpInstructions` 重新播报), 留着会每次重启累积一层。活跃技能也从会话的 `activeSkills` 恢复到句柄的技能表。

### 3.4 runTurn: 一轮的完整编排

`runTurn` 是平台与引擎的主接缝, 顺序如下:

1. 落库 `user_message`(含可选的 `selectedElement`/`previewError`), 置会话状态 `RUNNING`, 广播 `runtime_status: running`;
2. 建事件适配器与权限检查器(`new Permissions.PermissionChecker(workDir, toYukinoMode(mode))`, 并同步 `sandboxEnabled`);
3. `handle.conv.addUserMessage(composePrompt(input))`;
4. `MCP.Instructions.syncMcpInstructions` 播报本会话尚未见过的 MCP 服务器指令(压缩/恢复抹掉后会重播);
5. `Skills.Catalog.buildSkillSection` 生成技能清单;
6. **构造 `Agent.Agent`**: 关键字段是 `sessionId: ""`——传空字符串禁用引擎自身的 JSONL 会话写入, 让 DB transcript 成为唯一权威; `toolFilter` 叠加 `coordinatorToolFilter(false)` 与句柄的 `toolFilter`; `skillDeltaFn` 在技能清单变化且历史里没有时补一条增量 reminder; `memoryContent` 按 `memoryEnabled` 门控; `onLoopComplete` 在 `memoryEnabled` 时触发记忆维护; `notificationFn` 排空团队 lead 与后台任务通知;
7. `for await (const event of agent.run())` 逐事件经适配器分发(落库或广播);
8. `finalizeTurn` 收尾。

引擎运行抛错时, 落一条 `error` 事件并广播 `agent_error`(标记 `recoverable: true`), 但**不中断 finalizeTurn**——收尾仍会跑, 保证状态一致。

### 3.5 事件适配器: 落库与瞬时的分流

`createEventAdapter` 是一个有状态的逐轮翻译器, 把引擎的 `AgentEvent` 分成两类输出: **持久化的 transcript 事件**(带序列号)与**瞬时的结构化消息**(流式增量)。分流原则是: 高频 token 增量走瞬时通道, 累积的助手文本在轮末作为一条 `assistant_message` 落库一次。

| 引擎事件             | 适配器输出                                    | 落库 |
| -------------------- | --------------------------------------------- | ---- |
| `stream_text`        | `assistant_delta`(瞬时), 同时累积进 narration | 否   |
| `thinking_text`      | `agent_status { phase: thinking }`(瞬时)      | 否   |
| `thinking_complete`  | `thinking` 事件                               | 是   |
| `tool_use`           | `tool_use`(含从 args 提取的 `detail` 摘要)    | 是   |
| `tool_result`        | `tool_result`(输出截断到固定长度)             | 是   |
| `usage`              | `usage`, 并累加 input/output token            | 是   |
| `compact`/`retry`    | 同名事件                                      | 是   |
| `error`              | `error`, 并把 outcome 置 `error`              | 是   |
| `turn_complete`      | `turn_complete`                               | 是   |
| `loop_complete`      | `loop_complete`, 按 `stopReason` 定 outcome   | 是   |
| `permission_request` | `agent_status { phase: permission }`(瞬时)    | 否   |

`detail` 摘要从工具参数里按优先级取第一个非空字符串字段(`file_path`/`path`/`pattern`/`command`/`name`/`query`), 折叠空白并截断到 200 字符, 让前端能在不展开完整参数的情况下显示"这个工具在干什么"。

### 3.6 finalizeTurn: 叙述、指标、快照与上下文保存

轮末收尾依次做四件事:

1. **落库叙述**: 把适配器累积的 narration 作为一条 `assistant_message` 落库(若非空);
2. **上报指标**: 把本轮 input/output token 用量记进 `metrics.recordAiTokenUsage`(`modelRole: "agent"`);
3. **git 快照**: 仅当 outcome 为 `end_turn`(模型正常结束而非中断/出错)时, 对工作目录做一次 `git.snapshot(workDir, "agent: {turnId}")`, 并广播带 revision 的 `files_changed`;
4. **保存上下文**: 把 `handle.conv.getMessages()`、活跃技能名、运行时元数据(`lastOutcome`/`lastTurnId`)存进 DB 会话(尽力而为, 失败吞掉)。

最后置会话状态 `IDLE` 并广播 `runtime_status: idle`。

### 3.7 销毁: 显式排空长驻资源

运行时是长驻的, 因此销毁路径必须显式处理在途轮次与后台任务。`disposeResources` 的顺序是: 中止当前轮 → 取消会话所有待决交互(失败关闭)→ **排空内部锁**(等当前轮结束; 销毁从不从锁内部调用, 否则会死锁)→ 等会话就绪后再取消一次交互 → 停后台任务与团队成员 → 断开所有 MCP 连接 → 触发 `shutdown` Hook → 以 1001 关闭所有 WebSocket 连接。文件快照(fileHistory)由引擎在每次变更时增量落盘, 销毁不做额外持久化。每一步都吞掉异常, 保证一个资源清理失败不阻断其余。

## 四、职责划分: 服务器与浏览器各负责什么

### 4.1 服务器磁盘是文件的权威源

生成产物只写服务器磁盘(`tmp/code_output/{appId}/`), 浏览器容器从不被当作存储。这带来三个直接结果: 刷新或重开标签页后, 项目仍能从服务器完整拉回; 多个观察者(如管理员)看到的是同一份权威文件; 容器崩溃或依赖装坏都不损失源码。服务器侧对文件的所有读(文件树)与写(增删改重命名)都收敛在一组 REST API 下(见 6.4), 并与 Agent 轮次共享同一把运行时锁, 保证"用户在 IDE 里改文件"与"Agent 在改文件"不会互相踩。

### 4.2 浏览器承担构建与运行

依赖安装与 Vite dev server 完全跑在用户浏览器的 WebContainer 里。服务器**不做任何构建**, 因此预览的算力成本与延迟都落在客户端, 服务端只为模型调用与文件存储付费。这也划定了安全模型: 生成代码的执行被隔离在用户自己的浏览器沙箱里, 服务器进程从不执行生成物(见 7.1)。

### 4.3 协议分工: WebSocket 承载 Agent 协议, REST 承载 CRUD

两类通道职责分明:

- **WebSocket**(`GET /app/:appId/agent/ws`)承载 Agent 的实时协议: 轮次运行、中止、权限/提问应答、命令、心跳、transcript 增量与回放。它是**有状态、按序列号可重放**的;
- **REST** 承载 CRUD: 应用与用户管理、聊天记录、文件树与文件变更、Agent 能力(设置/会话/技能/Hook/记忆/MCP/子代理/团队)、下载、健康与指标。它是**无状态、幂等可读**的。

这条分工让"实时协作"与"数据管理"各自用最合适的传输, 也让只读观察者可以只订阅 WebSocket 而不触发任何写。

### 4.4 连接的读写分级

WebSocket 连接按访问权限分级: owner 与管理员是**可写**连接(能 run/abort/应答交互/发命令), 其他已登录用户是**只读**连接(只能收事件与回放)。只读连接发起 `run` 或应答交互时, 服务器返回结构化的 `read_only` 错误而非静默忽略。鉴权失败(`resolveAppAccess` 抛错)的连接在 `onOpen` 时直接以 1008 关闭。

## 五、生成产物的挂载与预览

### 5.1 文件树从服务器到浏览器

预览的第一步是把服务器文件树搬进容器。链路是: 前端经 REST 拉 `GET /app/files/:appId` 得到一棵 `AgentFileNode` 树(每个文件带相对路径、sha256、内联内容, utf8 或 base64; 目录带排序后的子节点), 经 `agentTreeToFileSystem` 转成 WebContainer 的 `FileSystemTree`(base64 解码成字节, 文本保持字符串), 再 `container.mount(tree)`。转换与快照都会跳过忽略段(`node_modules`/`dist`/`build`/`.git`/`.yukino`), 避免把构建产物或依赖搬进容器再搬回来。

### 5.2 预览生命周期状态机

预览有一个明确的状态机: `idle → booting → mounting → installing → starting → ready`(任一阶段失败转 `failed`)。`startPreview` 是入口, 它把整个流程包进一条**文件系统串行队列**(`queueFsTask`), 保证挂载、安装、保存、Agent 同步不会在容器 FS 上交错。状态推进由 `PreviewCallbacks` 回调给 UI, 每个状态对应一句人话文案(如 `installing` → "Installing dependencies in your browser...")。

几个关键的防御性设计:

- **代际取消**: 每次 `startPreview` 递增一个全局 `previewGeneration` 并取消上一个 pending run; 每个异步阶段后都用 `assertPreviewRunCurrent` 检查"我还是当前这一代且未被取消且组件仍在", 否则抛 `PreviewRunCancelledError`。这让"用户快速切换应用/重新生成"不会留下交错的半成品预览;
- **模块级单例**: `activePreview`/`pendingPreview`/`installedDependencyFingerprint`/`mountedAppId` 是模块级变量, dev server 因此能在组件重挂载后存活, 同一应用重新渲染不会重启预览;
- **dev server 就绪竞态**: `startDevServer` 用 `Promise.race` 同时等"spawn 结果 / `server-ready` 事件 / 进程退出 / 30 秒超时 / 取消"五种结果, 任一非就绪结果都会清理已 spawn 的进程, 避免泄漏;
- **意外退出上报**: 就绪后的 dev server 进程被持续观察, 若意外退出则把 `activePreview` 清掉并向 UI 报 `failed` 与错误信息。

### 5.3 依赖指纹与增量重启

不是每次同步都要重装依赖。`dependencyFingerprintFromTree` 对一组依赖清单文件(`package.json`/`package-lock.json`/`npm-shrinkwrap.json`/`pnpm-lock.yaml`/`yarn.lock`)逐个计算 `path:length:hash` 并拼成一个指纹; 只有当"容器里没有 `node_modules`"或"指纹与上次安装时不同"才触发 `npm install`。这把"只改了源码"的常见情形降为"直接复用已装依赖 + 重启 dev server", 大幅缩短二次预览时间。

安装本身有一个刻意的动作: **先删掉 `package-lock.json` 再执行 `npm install`**(`runInstall` 先 `removeIfPresent(container, "package-lock.json")` 再 `container.spawn("npm", ["install"])`)。这让 npm 按容器当前平台重新解析依赖与平台专有二进制: 别的平台解析出的 lockfile 可能漏掉当前平台的可选依赖(如 musl 平台的原生二进制包), 导致"安装成功但 Vite 起不来"。

### 5.4 WebContainer 在链路中的角色

WebContainer 通过一个单例 `getWebContainer()` 引导: 先检查 `crossOriginIsolated`(否则直接拒绝, 提示需要 COOP/COEP 头), 再以 `coep: "credentialless"`、`forwardPreviewErrors: true`、`workdirName: "project"` 启动。引导失败会清掉缓存的 promise 以便重试。`forwardPreviewErrors` 是预览错误回传(见 6.3)的开关; 开发服务器在 `vite.config.ts` 里给 dev/preview 都设置了 `Cross-Origin-Embedder-Policy: credentialless` 与 `Cross-Origin-Opener-Policy: same-origin` 头, 以满足隔离要求。

容器还承载 Monaco 之外的另一类交互: 文件浏览器直接读容器当前工作副本(`walkContainerTree`), 因此能反映 Agent 输出之外的、终端或预览构建产生的变化; 终端(xterm.js)也在容器里跑 shell。

## 六、与 Yukino 编码 Agent 的集成

### 6.1 引擎以库形式复用: createRemoteAgent 与句柄

平台通过 `@yukino.js/yukino` 的 `Remote.Server.createRemoteAgent` 拿到一个 `RemoteAgentHandle`, 这是集成的核心接缝。句柄暴露了引擎的全部长驻状态, 平台按需取用:

| 句柄成员                                | 平台用途                                              |
| --------------------------------------- | ----------------------------------------------------- |
| `conv` / `client` / `registry`          | 会话、LLM 客户端、工具注册表, 每轮构造 `Agent` 时传入 |
| `contextWindow` / `provider`            | 上下文窗口与 Provider 配置                            |
| `fileHistory` / `fileStateCache`        | 文件快照历史与文件状态缓存(rewind 与读文件用)         |
| `recoveryState`                         | 压缩恢复状态                                          |
| `skillCatalog` / `activeSkills`         | 技能目录与已激活技能                                  |
| `mcpManager` / `hookEngine`             | MCP 连接与 Hook 引擎                                  |
| `memoryManager` / `longTermMemory*`     | 长期记忆管理与注入内容                                |
| `teamManager` / `backgroundTaskManager` | 团队与后台任务(中止/销毁时停掉)                       |
| `toolFilter`                            | 句柄级工具过滤, 与 coordinator 过滤叠加               |

平台用 `enableCoordinatorMode: false` 与 `forkDisabled: false` 创建句柄, 即不启用 coordinator、不禁用 fork。`askUser` 回调把引擎的提问接到交互代理(见 2.4)。

### 6.2 会话与事件溯源

会话持久化是**纯 DB**的: 引擎自身的 JSONL 会话写入被 `sessionId: ""` 禁用, 权威记录是 `AgentSession`(含 `context`/`activeSkills`/`runtimeMetadata`)加一串按序递增的 `AgentTranscriptEvent`。每个事件带 `sessionId`/`sequence`(bigint)/`turnId`/`kind`/`payload`/`createdAt`。

这套设计让"回放"成为一等能力: 新连接发 `hello`(可带 `afterSequence`), 服务器经 `sendBacklog` 从高水位往回按批(每批 1000 条)推送 `transcript_batch`, 客户端据此重建完整对话。断线重连只需带上自己见过的最高序列号, 即可增量补齐, 不丢事件。

### 6.3 生成 → 运行 → 报错 → 修复闭环

闭环的"报错 → 修复"一段有两条回传路径, 都复用 `run` 通道:

- **预览运行时错误**: WebContainer 以 `forwardPreviewErrors` 把 iframe 里的错误经 `preview-message` 事件转发出来。前端 `usePreviewErrors` 订阅该事件, 用 zod 判别三种类型(`PREVIEW_UNCAUGHT_EXCEPTION`/`PREVIEW_UNHANDLED_REJECTION`/`PREVIEW_CONSOLE_ERROR`), 归一成 `{ message, stack? }`, 既显示在预览错误面板, 也经 `reportRuntimeIssue` 上报观测;
- **一键修复**: `buildPreviewFixPrompt` 把错误拼成一段提示词("修复下面这个 React 应用错误, 检查当前工程, 做最小且正确的改动, 保留无关行为……Error: …… Stack: ……"), 作为 `previewError` 随 `run` 发给 Agent, 进入 2.2 的 `<preview-error>` 块。

编译错误则由 Vite 在预览里直接呈现, 用户同样可以复制回 Agent。这样"生成 → 浏览器运行 → 报错 → 回传 → Agent 修复 → 再同步"形成完整回路, 而系统提示词里那句"浏览器会把编译与运行时错误报给用户"正是提示词侧的呼应。

### 6.4 双向文件同步与三方合并

文件有两个写入方: Agent(经服务器磁盘)与用户(经 IDE 的 Monaco 编辑器)。同步的核心是 `useWorkspaceController` 里的 `resyncAfterAgent`, 在 Agent 轮次结束或文件变更事件后触发(带 250ms 防抖 `SYNC_DEBOUNCE_MS`):

1. 拉服务器文件树, 与上一次服务器快照对比;
2. **依赖文件变化**(`dependencyFilesChanged`, 覆盖 `package.json`/lockfile/`bun.lock`/`bun.lockb`)→ 关闭现有 watcher, 重新 `startPreview`(重新挂载 + 视情况重装 + 重启 dev server);
3. 否则逐文件处理: 二进制文件按 hash 变化覆盖; 文本文件若本地 buffer 是脏的, 就做**三方合并**(`threeWayMerge(base, local, server)`): 只有一侧偏离 base 就取那一侧, 两侧相同取其一, 否则判为冲突;
4. 干净的合并直接写容器并更新 buffer; 冲突则把服务器版本写进容器、把 buffer 标记为冲突态(`{ base, local, server }`), 交给差异编辑器让用户裁决;
5. 服务器删除的文件: 本地脏的转成"本地 vs 空"的冲突, 否则从容器移除。

三方合并刻意做得"实用": 它不做行级 diff, 只在整文件层面判断"谁偏离了 base"。这把合并逻辑抽成了纯函数, 可以脱离 React 与容器单独测试(见 8.4)。用户保存文件时走 REST `PUT /app/files/:appId/file`, 带 `expectedHash`(sha256)做乐观锁; 服务器发现 hash 不匹配就返回 `conflict`, 前端据此提示而非静默覆盖。

### 6.5 文件 REST API 与路径安全

文件 API 挂在 `/app/files/:appId` 下: `GET /`(整棵树, 每文件带 sha256, 任何已认证观察者可读)、`PUT /file`、`POST /directory`、`POST /rename`、`DELETE /entry`。写操作仅 owner/管理员, 且都在 `runtime.runExclusive` 里执行——与 Agent 轮次共享同一把锁, 完成后 `notifyFilesChanged` 广播 `files_changed` 让其他连接刷新。

每个路径都过 `validateRelativePath`: 拒绝空路径、反斜杠、绝对路径、`..`/`.`/空段, 以及受保护段(`.git`/`.yukino`/`.env`/`node_modules`/`dist`/`build`); 解析后做前缀校验防拼接逃逸。写入前还检查祖先目录不是符号链接(`assertNoSymlinkAncestors`), 防符号链接逃逸。写盘用临时文件 + `rename` 原子替换。单文件上限 5MB(`MAX_PROJECT_FILE_BYTES`), 整棵树上限 20MB(`MAX_TREE_BYTES`), 超限拒绝预览。

### 6.6 权限与提问交互的桥接

2.4 已述交互代理的机制, 这里补桥接细节: 权限请求的负载由 `toPermissionPayload(toolName, args, decision, description)` 组装, 其中 `description` 来自引擎检查器的 `describeToolAction`, 是人类可读的动作描述(前端展示给用户)。每次请求/应答都伴随 `runtime_status` 在 `running`/`waiting` 间切换, 让 UI 能准确显示"Agent 在等你"。`ready` 消息会带上当前所有待决交互(`pendingInteractions`), 因此断线重连后用户仍能看到并处理未决的权限/提问。

### 6.7 能力扩展: MCP、Hooks、Skills、Memory、子代理与团队

每个应用工作区都能配置引擎的全套扩展能力, 经一组 REST(`/:appId/agent/*`)管理:

- **MCP 服务器**: 支持 `stdio`/`http`/`sse` 三种传输; `headers` 与 `env` 里的敏感值以 AES-256-GCM 加密落库(见 7.2); 返回给前端的 VO 是脱敏的(只有 `hasHeaders`/`hasEnv` 布尔); 支持连接测试;
- **Hooks**: 生命周期钩子的增删改查, `hooksEnabled` 总开关;
- **Skills**: 列出、`reload`、从源安装;
- **Memory**: 查看与清空长期记忆, `memoryEnabled` 门控注入/提取/整合;
- **Subagents / Teams**: 只读列出子代理与团队及其任务;
- **Settings**: `permissionMode`/`sandboxEnabled`/`memoryEnabled`/`hooksEnabled`/`modelOverride`。

设置的生效方式分两类: **软设置**(`permissionMode`/`sandboxEnabled`/`memoryEnabled`)直接 `applySoftSettings` 打到存活运行时, 下一轮即生效; **需要重建的**(`hooksEnabled`/`modelOverride`)则 `invalidate` 运行时, 下次访问时按新配置重建句柄。这条区分避免了"改个权限模式就要重建整个 Agent"的浪费, 同时保证真正影响 Agent 栈的配置一定走重建。

### 6.8 Git 快照安全网

`git-runtime` 在生成项目目录里维护一个尽力而为的 git 仓库: `ensureRepo` 首次 `git init`, 随后 `add -A` + `commit --allow-empty`(消息 `chore: initial project snapshot`)打下基线; `snapshot` 在 `end_turn` 时 `add -A`, 若 `status --porcelain` 无变更则跳过, 否则提交(消息 `agent: {turnId}`); `listSnapshots` 用 `git log --pretty=format:%H%x1f%s%x1f%cI` 解析出 sha/消息/日期; `rewindTo` 用 `git checkout {sha} -- .` + `add -A` + 提交(`chore: rewind to {sha}`)实现回滚。所有操作都吞掉失败(缺 git、非仓库), 因为版本快照只是叠在引擎文件历史之上的便利层。提交者身份由 `GIT_SNAPSHOT_AUTHOR_NAME`/`GIT_SNAPSHOT_AUTHOR_EMAIL` 配置。

## 七、安全边界

### 7.1 生成代码的执行隔离

生成代码**从不在服务器进程里执行**: 服务器只把它当文件存储, 构建与运行都发生在用户浏览器的 WebContainer 沙箱里。这条隔离把"运行不可信生成物"的风险从服务器转移到了用户自己的设备。需要清醒认识的是, 浏览器沙箱保护的是服务器而非用户——容器内的代码仍能消耗用户算力、访问被容器放行的网络出口, 这是所有预览型产品的固有风险面。服务器侧对生成物的唯一"执行"是 git 命令(快照/回滚), 且都在受控的工作目录内。

### 7.2 密钥与凭据

MCP 服务器的 `headers` 与 `env` 以 AES-256-GCM 对称加密落库: 密钥来自 `MCP_SECRET_KEY`(base64 编码的 32 字节), 密文打包成 `iv(12) || authTag(16) || ciphertext` 再 base64 存储; 解密时校验长度并 `setAuthTag`, 篡改会导致认证失败。比较用 `timingSafeEqual` 恒定时间比较。返回给前端的 MCP VO 完全脱敏, 只暴露 `hasHeaders`/`hasEnv`。

部署密钥同样受保护: `MCP_SECRET_KEY`、`SESSION_SECRET`、`PASSWORD_SALT` 在生产环境使用默认值会被拒绝启动(见 7.4)。模型端点密钥(`AI_API_KEY`)只存在于服务器环境, 从不下发前端。

### 7.3 文件路径安全

6.5 已详述文件 API 的多层校验。这里强调它防御的攻击面: 路径穿越(`..`、绝对路径、反斜杠)、受保护目录访问(`.git`/`.yukino`/`.env`/`node_modules`/`dist`/`build`)、路径拼接逃逸(解析后前缀校验)、符号链接逃逸(祖先目录 `lstat` 检查)、并发覆盖(sha256 乐观锁)。Agent 自身的文件工具也受引擎的路径沙箱约束(见[yukino-code](yukino-code)第九节), 两层叠加。

### 7.4 配置 fail-fast 与传输防护

平台在启动时对环境变量做结构校验(zod)与语义校验(`superRefine`)。生产环境(`NODE_ENV=production`)下, 以下任一条件都会**拒绝启动**: CORS 含通配 `*`、`PASSWORD_SALT`/`SESSION_SECRET`/`MCP_SECRET_KEY` 仍是默认值、未配置 `REDIS_URL`、`STORAGE_DRIVER` 仍是 `local`、未配置 MinIO 的 access/secret key。把部署错误暴露在启动期而非运行期, 是这套校验的核心价值。

传输层防护: WebSocket 消息有大小上限(`AGENT_WS_MAX_MESSAGE_BYTES`, 默认 512KB), 解析失败与 schema 校验失败返回结构化错误(`bad_json`/`bad_message`), 未鉴权连接被关闭, 只读连接不能发起运行或应答交互; HTTP 层有请求体大小限制(`REQUEST_BODY_LIMIT_BYTES`, 默认 1MB)、CORS 白名单与签名会话。

### 7.5 前端 XSS 与跨源消息校验

Agent 回复的 Markdown 在渲染前经 `renderSafeMarkdown` 消毒: `marked` 解析后用 `DOMPurify.sanitize`(`USE_PROFILES: { html: true }`, `FORBID_TAGS: ["script", "style"]`)清洗, 再做代码高亮。前端安全在这里的重要性高于常规应用, 因为页面要渲染模型生成的任意文本。

可视化编辑的跨源消息双向校验: 发给 iframe 的 `postMessage` 优先用预览 origin(解析不到时回退 `*`); 收 iframe 回传的消息时, 校验 `event.source === iframe.contentWindow`, 预览 origin 可解析时还要求 `event.origin === previewOrigin`, 再过 `visualEditorIncomingMessageSchema`。预览错误回传同样过 zod 判别。用户输入与模型输出在进入数据库与渲染路径前都有类型校验。

## 八、可观测性与工程化

### 8.1 健康探针与指标

平台提供三个管理端点: `/management/health`(依赖健康, 检查 database/modelProvider/redis/storage 四项, 任一 down 则整体 503)、`/health`(存活探针, 恒返回 ok)、`/management/info`(应用名与版本)。指标以 Prometheus 文本格式暴露在 `/management/prometheus`, 定义了四个计数器: `ai_model_requests_total`、`ai_model_errors_total`、`ai_model_tokens_total`、`ai_model_response_duration_seconds_sum`。

需要如实指出: 这四个计数器里**目前只有 token 用量被实际记录**——`finalizeTurn` 在每轮结束调 `recordAiTokenUsage` 上报 input/output token; 请求数、错误数、响应耗时的记录点尚未接线。指标服务的接口已就位, 但采集面还窄。

### 8.2 请求上下文与前端监控

中间件为每个请求注入请求标识与日志上下文(`createRequestContextMiddleware`), 日志级别可配(`LOG_LEVEL`)。前端接入了 `@yukino.js/sentry` 监控 SDK: `main.tsx` 里 `init` 后启用 `PerformancePlugin`/`ScreenRecordPlugin`/`ExposurePlugin`, 并用 `ReactErrorBoundary` 包裹根组件; `vite.config.ts` 用 `sentryPlugin` 做 dev 态 source map 解析。预览运行时错误经 `reportRuntimeIssue` 一并上报, 使"用户看到白屏"与"哪个预览错误导致白屏"能在同一处关联。

一个诚实的边界: SDK 的 `beforeSend` 在生产构建里返回 `false`, 即**生产环境实际上不外发上报**(DSN 也仍是占位符 `/path/to/server/dsn`); 前端监控当前主要在开发态生效。`reportRuntimeIssue` 本身只是 `console.error("[release-safety]", ...)` 的薄封装, 是一个不依赖外部服务的兜底记录点。

### 8.3 优雅关闭

进程收到 `SIGINT`/`SIGTERM` 后: 先 `closeServer`(停止接受新请求), 再 `runtimeManager.disposeAll()`(逐个销毁运行时: 中止在途轮次、取消待决交互、停后台任务与团队成员、断开 MCP、触发 shutdown Hook、关闭连接), 最后断开 Redis 与数据库。因为运行时是长驻的, 关闭路径必须显式处理在途轮次与后台任务, 否则会留下半写入的文件状态。`disposeAll` 会先等所有在途生命周期任务完成, 保证不销毁一个正在创建的运行时。

### 8.4 测试与类型纪律

双端都是 TypeScript strict。测试把并发、取消、合并这类易错的**纯逻辑**从 API 副作用里抽出来单独测: 服务端有 `agent-runtime-concurrency`(轮次串行化)、`command-dispatcher`、`event-adapter`、`mcp-config`、`mcp-crypto`、`project-files`(路径安全)、`protocol`(schema)等用例; 客户端有 `webcontainer-runtime`(代际判断、依赖指纹)、`workspace-tree`(三方合并、树转换)、`workspace-paths`、`agent-protocol`、`build-error-context` 等。副作用集中在薄封装层, 这让浏览器运行时这类难以端到端测试的代码仍有可靠的回归保障。

## 九、适用场景与边界

**适合**: 在既有产品里加入"AI 生成可交互 Web 应用"能力; 需要"描述即预览"的低延迟原型生成; 希望复用一套成熟编码 Agent 引擎(而非自研循环)去驱动全栈生成的团队; 需要把生成/运行/修复闭环、文件双向同步、git 快照、权限与提问交互一并产品化的场景。

**边界与注意**:

- 生成物被系统提示词钉在 **Vite + React + TypeScript 前端 SPA**, 不是任意后端或任意框架; 需要其他技术栈要改提示词契约;
- 服务器**不做构建**, 预览算力全在用户浏览器, 因此依赖用户设备性能与 WebContainer 的跨源隔离要求(COOP/COEP);
- 文件一致性靠"服务器权威 + 三方合并 + sha256 乐观锁", 但三方合并是**整文件级**的实用合并, 不做行级 diff, 两侧同时改同一文件会判冲突交人工裁决;
- 指标采集面目前只有 token 用量, 前端监控在生产构建里实际不外发——可观测性接口已就位但尚未填满;
- 权限默认 `bypassPermissions`(无人值守生成), 需要人工把关时应切到 `default`/`plan` 等模式, 并接受交互代理 5 分钟超时后失败关闭(拒绝)的行为;
- 每应用一个长驻运行时 + 15 分钟空闲回收, 高并发应用数下需关注运行时数量与内存; 空闲阈值与扫描周期可经 `AGENT_WORKSPACE_IDLE_MS` 调整。
