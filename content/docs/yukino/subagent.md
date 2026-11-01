---
title: "Subagent"
description: "Yukino 的委派子系统: Agent 工具把有界子任务交给独立的 agent loop 执行, 覆盖参数与校验、角色定义、fork 上下文继承、五层工具过滤、后台异步任务, 以及 teammate 的多团队选择语义"
local_path: "$HOME/github/yukino-code/apps/yukino"
local_commit: "bef5439b54e6510a12da61bcfa4285ecb1cd2192"
---

一个大的重构任务中, 想插入一个小的「更新 README.md」任务: 直接在主对话里执行, 会把大量无关的工具调用和中间输出混进主 Agent 的上下文 (上下文污染)。Subagent 把这类有界子任务委派给独立的 agent loop 执行: 独立的上下文窗口、独立的工具集和权限边界, 只把一份简洁结果交回主 agent

Yukino 的委派拓扑是主从 (星型) 的: 主 agent 在中心, subagent 在边缘, subagent 只对自己的任务负责, 相互之间不通信, 执行结果作为 Agent 工具的返回值进入主 agent 的上下文 —— 没有中心化的编排器, 也不会出现 agent 之间的循环等待。需要相互通信、可反复追加任务的持久成员用 agent team (见 [agent-team](./agent-team))

代码集中在 src/subagent/: `agent-tool.ts` (Agent 工具)、`spawn.ts` (执行内核)、`definition.ts` + `loader.ts` (角色定义与加载)、`constants.ts` (内置角色与工具过滤名单)、`tool-filter.ts` (多层工具过滤)、`task-manager.ts` (后台任务)、`prompts.ts` (描述文案与任务通知)、`plan.ts` (plan 模式入口)

## 关键洞察: Agent 也是一种工具

Agent 和 Tool 抽象同构: 把 Agent 包装为 Tool (AgentTool), 注册到 ToolRegistry, 主 agent 就能像调用 Bash 一样「调用」另一个 agent。Tool 接口 (src/tools/types.ts):

```ts
export type ToolCategory = "read" | "write" | "command";

export interface Tool {
  name: string; // Subagent 的名字
  description: string; // Subagent 的描述
  category: ToolCategory;
  deferred?: boolean; // 仅 MCP 工具使用: 不进初始工具列表, 先经 ToolSearch 拉 schema
  // 按本次调用的实际参数判断能否并发 (缺省按 category: read 可并发)
  isConcurrencySafe?(args: Record<string, unknown>): boolean;
  schema(): ToolSchema; // 参数: Subagent 的任务
  // 返回 Subagent 的执行结果
  execute(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult>;
  dispose?(): Promise<void>;
}
```

`AgentTool` (src/subagent/agent-tool.ts) 实现该接口: `name = "Agent"`, `category = "command"`, `isConcurrencySafe()` 恒返回 `true` —— LLM 在同一批里请求多个 Agent 调用时, 多个 subagent 并行运行, 各自有独立的工具执行上下文, 完成序流式上报

## Agent 工具的参数

`schema()` 中 `description` 和 `prompt` 必填, 其余可选:

```jsonc
{
  "description": "", // 必填, 一句话说明这个 agent 做什么
  "prompt": "", // 必填, 任务指令 (fork=false 时应自包含: 目标、相关文件、约束、是否允许编辑、期望结果)
  "kind": "teammate", // 可选, "teammate" (默认, 所选团队的持久成员, 没有团队则自动创建) | "subagent" (一次性, 只返回工具结果)
  "team_name": "", // 可选, 仅对 kind="teammate" 有意义: 要加入的团队名 (TeamCreate/TeamList 的返回值); 只有一个团队时可省略, 多团队时必填
  "subagent_type": "general-purpose", // 可选, 枚举值来自已加载的 agent 定义, 缺省 general-purpose
  "fork": true, // 可选, true 复制父对话快照作为初始上下文 / false 全新对话; 缺省取会话配置 enable_fork (未显式 false 时为 true)
  "model": "", // 可选, 覆盖本次运行的模型
  "run_in_background": false, // 可选, 仅对 kind="subagent" 有意义: 异步执行, 立即返回 task ID
  "worktree": false, // 可选, true 时在独立 git worktree 中运行, 编辑不与父/其他并行 agent 冲突; 缺省取定义中的 worktree 字段
}
```

参数校验在 `execute` 开头完成, 非法参数直接返回 isError 的工具结果, 不会启动任何 agent:

- 缺 description/prompt → `Error: description and prompt are required`
- kind/fork/run_in_background/worktree 类型错误 → 对应的 `Error: ... must be ...` 消息 (zod 校验)
- subagent_type 不在已加载定义中 → `Error: unknown agent type '<name>'. Available: ...` (列出全部可用角色)
- `fork: true` 但没有父对话上下文 → `Forking requires parent conversation context. Set fork to false to start a fresh conversation.`

三个维度正交, 独立选择:

- `kind` 决定生命周期: `subagent` 一次性 (ConversationManager 只存活在单次运行内, 结果内联返回或经 task-notification 送达, 终止后不能接收消息、不能恢复); `teammate` 是团队持久成员 (成员名从 description 自动生成 —— kebab-case 化、截断到 30 字符、重名追加 `-2`/`-3` 后缀、避开保留名 `leader`, 完成一轮任务后进入邮箱轮询等待追加任务, 见 [agent-team](./agent-team))。加入哪个团队由 `TeamManager.resolveTeam(team_name)` 解析: 传了 `team_name` 时该团队必须已存在 (否则报 `Team '<name>' not found.`); 未传时复用唯一存在的团队, 多个团队并存则报歧义错误 (`Multiple teams match. Specify team_name; use TeamList to see available teams.`), 一个团队都没有时以 leader 身份自动创建 (`team-<uuid>`)
- `subagent_type` 决定角色: 工具白/黑名单、权限模式、模型、轮数上限
- `fork` 决定初始上下文: 继承父对话快照, 还是全新对话

## 角色与初始上下文: 两个独立维度

- 角色由 `subagent_type` 决定 (缺省 general-purpose), 决定工具/权限/模型约束
- 初始上下文由 `fork` 决定 (缺省取 `enable_fork` 配置, 未显式 false 时为 true): `fork: true` 复制父对话快照, `fork: false` 全新对话
- 两者正交: `subagent_type: "plan", fork: true` 是「plan 角色 + 继承上下文」, `subagent_type: "plan", fork: false` 是「plan 角色 + 全新上下文」; 其余角色同理
- 角色的工具限制和 max_turns 对 fork=true 和 fork=false 一视同仁
- fork 复制的永远是主对话的当前快照, 不会「恢复」某个之前 subagent 的私有对话

下文按习惯把 `fork: false` 的叫「定义式 subagent」, `fork: true` 的叫「fork 的 subagent」

### 预定义的 subagent (Definition-based)

`subagent_type` 的枚举值来自已加载的 AgentDefinition 列表 (`loadAgentDefinitions`, src/subagent/loader.ts), 两个来源, 加载顺序从低到高, 同名后者覆盖:

1. 内置级: `BUILTIN_AGENTS` (src/subagent/constants.ts), 四个角色, 见文末
2. 用户级: `~/.yukino/agents/` 目录下的所有 `.md` 文件

示例: ~/.yukino/agents/code-review.md, 一个只读的代码审查专家 (禁写文件、禁执行 Bash):

```md
---
name: code-review
description: 负责代码审查的 subagent
disallowed_tools:
  - EditFile
  - WriteFile
  - Bash
max_turns: 20
---

你是一个负责代码审查的 subagent

## 职责

...

## 规则

...
```

frontmatter 用 YAML + zod (`looseObject`, 未知键忽略) 解析, 支持的字段:

| 字段               | 含义                                                                     |
| ------------------ | ------------------------------------------------------------------------ |
| `name`             | 必填, 非空字符串, 即 subagent_type 的枚举值                              |
| `description`      | 何时使用该角色; 缺省取 body 前 200 字 (`MAX_FALLBACK_DESCRIPTION_CHARS`) |
| `tools`            | 工具白名单 (`["*"]` 关闭该层过滤)                                        |
| `disallowed_tools` | 工具黑名单                                                               |
| `system_prompt`    | 覆盖默认 system prompt                                                   |
| `max_turns`        | 正整数, agent loop 轮数上限                                              |
| `model`            | 覆盖模型                                                                 |
| `permission_mode`  | 枚举校验 (default / acceptEdits / plan / bypassPermissions)              |
| `background`       | 布尔, 缺省即后台异步运行                                                 |
| `worktree`         | 布尔, 缺省即 git worktree 隔离                                           |

markdown body 映射为 `initialPrompt`, 作为子代理指令的一部分注入。任一字段校验失败 (如 permission_mode 拼错) 时, 该文件整体跳过并记录日志, 不影响其他文件; 没有 frontmatter 块的文件直接忽略

```ts
export interface AgentDefinition {
  name: string; // Agent type
  description: string; // When to use
  tools?: string[]; // 工具白名单
  disallowedTools?: string[]; // 工具黑名单
  systemPromptOverride?: string; // 覆盖默认 system prompt
  maxTurns?: number; // 最大 agent loop 轮数
  model?: string;
  permissionMode?: PermissionMode;
  background?: boolean; // 是否后台异步运行
  worktree?: boolean; // git worktree 文件系统隔离
  readOnly?: boolean; // 只读角色 (内置 plan/explore 为 true, 定义文件不暴露该字段)
  initialPrompt?: string; // markdown body
}
```

### fork 的 subagent (Fork-based)

`fork: true` 时 `AgentTool.forkConversation()` 构造初始对话:

1. `conversation.fork()`: structuredClone 复制父 Agent 的完整对话历史, 连同长期记忆注入标志 (`longTermMemoryInjected`)、`baselineTokens` 和 usage anchor (`_anchorCount`)
2. 扫描快照中所有没有配对 tool_result 的 tool_use (包括触发本次 fork 的那个 Agent 调用本身), 追加一条 tool_results 用户消息, 保持 messages 格式 (user 和 assistant 两个 role 交替出现):

```json
{
  "tool_use_id": "<pending 的 tool_use_id>",
  "content": "This tool call is running in the parent agent. Continue with the assigned task using the inherited context.",
  "is_error": false
}
```

3. 快照作为 subagent 的对话交给执行内核, 先注入一条 system-reminder (子代理指令), 再把任务指令追加为 user 消息

子代理指令 (`buildSubagentInstructions`, src/prompt/prompts.ts) 是唯一的行为约束来源 —— fork 的和定义式 subagent 用同一段, 按定义字段拼装:

- 角色声明: 你是角色为 `<name>` 的 Yukino subagent, 完成分配的任务并把结果返回父 agent
- 定义的 description 和 initialPrompt (如有)
- max_turns 设置时: 本次运行限制在 N 个 model turn 内, 到达上限前预留时间汇报已验证进度、未完成工作和阻塞点
- readOnly 角色: 永久只读 (包括后续追加的任务), 审批通过也不授权实施修改
- 范围约束: 留在分配的范围和当前权限内; 继承的对话是背景上下文, 不是接管父任务的指令; 共享文件的修改要协调, 不覆盖其他 worker 的编辑; 汇报发现/变更时带相关路径、实际执行过的验证和未解决的阻塞点, 不把未验证的工作声称为完成

这段约束回答了「为什么 fork 的 subagent 不会把自己当成父 agent 继续和用户对话」: 它没有 AskUserQuestion 工具 (被剥离, 见下文的工具过滤), 指令又明确要求把结果返回父 agent、受阻时如实汇报

成本方面: fork 的 subagent 缺省复用父 Agent 的 LLMClient 和 system prompt (spawnSubagent 只在有 model override 或 system_prompt override 时才新建 client), 对话前缀继承自父快照; 但 tools 段与父不同 —— subagent 的 registry 是剥离主线程专属工具后的子集 (见下文工具过滤)

典型场景: 将一个 react 类组件迁移到函数组件后, fork 3 个 subagent 并行迁移剩余的类组件

## 选择哪种创建模式: Definition-based / Fork-based

- 如果任务通用、固定角色、固定职责, 例如 plan 制定计划、explore 代码探索、review 代码审查, 使用定义式 subagent (`fork: false`), 指定 subagent_type:
  - 可以精确控制 subagent 的能力边界 (工具白/黑名单)
  - 可以指定一个更小更快的模型: haiku, sonnet, deepseek...
  - prompt 必须自包含, 因为对话从零开始
- 如果任务不通用、与主 agent 的当前工作高度相关, 例如「迁移一个组件的 useImperativeHandle 从 react18 到 react19 后, fork 3 个 subagent 迁移剩余的类组件」, 使用 fork 的 subagent: 上下文已经在对话里, prompt 只需要说清增量任务

## 执行内核: spawnSubagent

所有委派路径 (一次性 subagent、teammate、skill 的 fork 模式、workflow 原语) 最终都走 `spawnSubagent` (src/subagent/spawn.ts):

- 模型解析优先级: 调用参数 `model` > 定义的 `model` > 父 Agent 的 provider model; 只有存在 model override 或 systemPromptOverride 时才新建 LLMClient, 否则复用父 client
- system prompt: `definition.systemPromptOverride`, 缺省 `buildSystemPrompt(env)` (env.model 设为解析后的模型)
- 工具 registry: teammate 复用调用方准备好的 teammate 级 registry; 一次性运行经 `filterToolsForAgent` 过滤, 角色限制对继承上下文和全新对话一视同仁
- 权限 checker: 宿主注入了就用宿主的, 否则 `new PermissionChecker(cwd, options.permissionMode)`; 一次性运行再经 `forSubagent(cwd, definition.permissionMode)` 派生; `checker.readOnly ||= definition.readOnly`
- 对话装配: `options.conversation` (teammate 持久对话) > `contextSnapshot` (fork) > 全新 ConversationManager; 一次性运行总是注入子代理指令 system-reminder, teammate 只在首轮注入; 随后追加任务 prompt 为 user 消息; AGENTS.md 指令 (`loadInstructions`) 与主 agent 一样注入
- 轮数上限: `maxIterations: definition.maxTurns` —— 缺省 0 表示不限制, 角色没有默认轮数上限, max_turns 是唯一的显式限制来源
- 每次运行有独立 session id 和 transcript: `~/.yukino/sessions/artifacts/<sessionId>/transcript.jsonl`; 运行抛错时写入一条 `subagent_error` 记录, 错误消息附 Partial output (如有) 和 Transcript 路径
- 每次运行自带一个 TaskManager (teammate 的进程内回合例外, `backgroundTasks: false`): subagent 后台化的 Bash/PowerShell 注册在这里, 完成通知在 subagent 自己的 loop 内 drain; loop 结束的 finally 中 `stopAll()`, 后台 shell 不会活得比 subagent 长
- `worktree: true` 时 (调用参数或定义缺省): 先 `createAgentWorktree` 建独立工作副本 (slug 自动生成 `agent-a<7位hex>`, 分支 `worktree/<slug>/work`), cwd 切换、权限 checker 经 `forWorktree` 派生, prompt 前置一条 worktree 通知 (工作目录、父项目路径、修改与父工作树隔离), 详见 [worktree](./worktree)

结果收集 (`loop_complete` 事件):

- 正常结束: 返回累积的流式文本, 空则 `[No output]`
- 被中断: 输出后附 `[Interrupted]` 标记
- 运行中 ExitPlanMode 成功提交过 plan (仅 plan 模式的 teammate 可能): plan 文本附在输出后
- worktree 运行的输出末尾附 `Worktree retained at: <path>` (出错时也附, 便于人工合并)

## 上下文隔离

- 基础设施共享: API Key、LLM API 连接 (缺省同一个 client)、MCP 工具 (`mcp__` 前缀)、Skill、AGENTS.md 指令文件
- 权限模式: subagent 的 checker 从父派生 (`forSubagent`), `mode` getter 的解析顺序: `readOnly` → 强制 plan; 父或自身任一为 bypassPermissions → bypassPermissions; 父为 acceptEdits → acceptEdits; 否则取定义的 permissionMode, 未设时 default —— 即定义可以把 subagent 收紧到 plan, 但父会话的 acceptEdits/bypassPermissions 会向下传导, 规则细节见 [permission](./permission)
- 对话历史: 定义式 subagent 无历史, fork 的 subagent 继承快照; 各自独立的上下文窗口和独立的 transcript 文件
- 文件系统: 默认共享, `worktree: true` 时隔离
- 轮数: 主 agent 默认不限制, subagent 默认也不限制, 只有定义的 max_turns 提供显式上限
- Hook: 子代理 loop 不传 hookEngine, `pre_tool_use` / `post_tool_use` 只在主 loop 中包裹 Agent 工具调用本身 (pre_tool_use hook -> 调用 AgentTool -> subagent loop -> post_tool_use hook), 见 [hook](./hook)

## Subagent Loop

subagent loop 和主 agent loop 是同一个 Agent 类, 区别在装配:

1. subagent loop 的 turn 不等待用户输入: AskUserQuestion 工具被剥离, 权限请求经 `onPermissionRequest` 转发宿主的审批 UI
2. LLM 不再调用工具时 loop 结束, 执行结果作为 Agent 工具的返回值: 前台运行内联返回累积的流式文本 (空则 `[No output]`, 中断则附 `[Interrupted]`); 后台运行经 task-notification 送达
3. 子代理指令以 system-reminder 注入 (角色声明 + description + initialPrompt + 轮数/只读提示 + 范围/协调/诚实汇报约束), 任务 prompt 是普通 user 消息
4. subagent 自己后台化的 shell 任务在它的 loop 内通知和回收, 不外溢到主线程

## Subagent 不能继续 spawn

工具过滤 (`filterToolsForAgent`, src/subagent/tool-filter.ts) 按五层顺序组合:

1. `mcp__*` 工具豁免第 2、3 层, 仍受第 4、5 层 (定义级黑/白名单) 约束
2. 全局禁用 `SUBAGENT_DISALLOWED_TOOLS` = 主 agent 专属 `MAIN_AGENT_ONLY_TOOLS` + 委派策略 `SUBAGENT_EXTRA_TOOLS`:
   - MAIN_AGENT_ONLY_TOOLS: Workflow (防递归编排)、ComputerUse (独占物理屏幕/键鼠)、AskUserQuestion (独占模态对话框, 并行 subagent 会互相劫持)、EnterPlanMode、ExitPlanMode (需要主线程审批对话框)、Goal (持久目标是会话级状态); 所有委派 agent (fork 和定义式) 都剥离
   - SUBAGENT_EXTRA_TOOLS: Agent (递归 spawn, 调用树在 subagent 层终止)、TeamCreate、TeamDelete (只有 leader 管理 team)、SendMessage (委派 agent 不继承 leader 的通信权限)
   - 例外: `ExitPlanMode` 在权限模式为 plan 时保留 (plan teammate 靠它提交计划), 但仍可被定义的 disallowedTools 剥掉 —— 内置 plan/explore/review 角色正是这么做的
3. 后台异步 subagent (`isAsync`) 再过白名单 `ASYNC_AGENT_ALLOWED_TOOLS` (18 个): TodoWrite, TaskOutput, TaskStop, LSP, ReadFile, WebFetch, Grep, Glob, Bash, PowerShell, EditFile, WriteFile, LoadSkill, SyntheticOutput, ToolSearch, EnterWorktree, ExitWorktree, McpCall —— 没有交互式工具, 后台任务不能阻塞等用户; ToolSearch 只读出 schema、实际调用靠 McpCall, 两者必须成对放行
4. 定义的 disallowedTools 黑名单
5. 定义的 tools 白名单 (`["*"]` 关闭该层)

通过过滤的工具还会做作用域重绑定 (`registerScopedTool`): TodoWrite 绑定一份全新的独立 TaskList (subagent 的任务板不污染主 agent); ToolSearch/McpCall 重绑到过滤后的 registry; LoadSkill 换成 `forDelegatedAgent()` 变体; TaskStop 换成 `forSubagent()` 变体 —— 只剩 `task_id` 参数 (teammate 参数是 leader 专属), 且只查 subagent 自己的 TaskManager, 只能停自己启动的后台任务, 不会越权停父任务

teammate 走 `cloneRegistryForTeammate`: 剥离 SUBAGENT_DISALLOWED_TOOLS (同样有 ExitPlanMode 的 plan 豁免) 和 TaskStop, 然后由 AgentTool 注入团队级任务板工具 (`TeamTodoWriteTool`, 绑定所在团队名)、以自己名字署名且绑定团队名的 SendMessage (teammate 只能向本团队发消息)、以及提交计划用的 ExitPlanMode (`team.submitPlan`)

结论: Agent 工具对所有委派 agent 剥离, fork 出来的 subagent 无法再 spawn, 调用树在 subagent 层终止; fork 继承的只是父对话快照, 不改变工具边界

## 后台异步运行模式

1. 调用 AgentTool 时指定 `run_in_background: true` (定义 frontmatter 的 `background: true` 是缺省来源), subagent 以后台异步任务启动, 主 agent 立即收到 task ID: `Background agent '<desc>' started (task_id: agent-N). Its result will arrive as a task notification.` 后台化不影响 fork: `fork: true` 时先同步取对话快照, 再启动后台任务, 父对话继续演进不影响快照
2. 后台任务由 TaskManager 管理 (src/subagent/task-manager.ts): 任务 id 前缀区分类型 (agent- / bash- / ps-), 状态 running | completed | failed | cancelled; 任务记录随会话持久化, 恢复会话时遗留的 running 任务被标记为 failed; 已通知的完结任务内存保留上限 200 条 (`MAX_RETAINED_FINISHED_TASKS`), 超出淘汰最旧, 运行中的任务永不淘汰; TaskOutput 工具可按 task_id 查看或等待一次完成 (超时上限 60s), 细节见 [task-tracking](./task-tracking)
3. 任务结束后, 结果用 `<task-notification>` 标签包裹 (`formatAgentTaskNotification`), 经 agent loop 的 notificationFn drain 作为 system-reminder 注入主 agent 的上下文:

```xml
<task-notification task_id="agent-1" status="completed">
name=explore-agent
transcript_path=~/.yukino/sessions/artifacts/<sessionId>/transcript.jsonl
(执行结果)
</task-notification>
```

(transcript_path 行仅在任务记录了 transcript 路径时出现, 所有字段经 XML 转义) 4. 失败语义: runner 抛 `TaskFailure` (携带预格式化输出, 例如被 kill 的后台 shell 的捕获输出和退出码) 时 output 原样保留; 普通 Error 包成 `Error: <message>`; 取消的任务 output 为 `Stopped by user`, 取消后迟到的结果被丢弃 5. TaskStop 工具停止后台任务: leader 用 `task_id` (先查本轮 loop 的 TaskManager, 再回退宿主级) 或 `teammate` (按名停团队成员) 二选一; 委派 agent 手里的 subagent 变体只有 `task_id` 6. 前台/后台的边界: Bash/PowerShell 有「超时自动转后台」和 Ctrl+B 手动转后台 (`BACKGROUNDABLE_TOOL_NAMES` 只有这两个), Agent 没有 —— Esc/Ctrl+C 对前台 Agent 调用是中断 (输出附 `[Interrupted]`), 不是转后台

## 内置 subagent_type

`BUILTIN_AGENTS` 四个内置角色 (src/subagent/constants.ts):

### general-purpose

通用研究和多步任务执行 (researching complex questions, exploring codebase, executing multi-step tasks); 无工具限制、无权限模式覆盖; fork 的 subagent 缺省也由这个角色承载

### plan

软件架构师, 只读规划任务: 调查现有架构, 提出带文件、约束、验证步骤的实现计划; `disallowedTools: ["EditFile", "WriteFile", "ExitPlanMode"]`, `permissionMode: "plan"`, `readOnly: true`。同一个名字有两种形态:

- `kind: "subagent"`: 保持永久只读, 计划以文本返回
- `kind: "teammate"`: 定义被替换为 `PLAN_TEAMMATE_AGENT` (只保留 `permissionMode: "plan"`, 无 disallowedTools) —— 先调查并通过 ExitPlanMode 向团队提交计划, 审批通过后在当前工具权限下继续实施

`/plan` 命令和 EnterPlanMode 工具走 `runPlanAgent` (src/subagent/plan.ts): 先 `checker.enterPlanMode()`, 再以 `runBuiltin("plan")` 前台 fork 运行, 返回的计划经 `savePlan` 写入 plan 文件进入审批流; 输出为空报 `The plan agent returned no plan.`, 委派上下文 (subagent/teammate) 中调用直接拒绝

### explore

代码探索专家, 只读: 找代码、追调用链、报告带文件路径和行号的证据 (用 Glob/Grep/ReadFile 和只读 shell 命令), 缺失的上下文和阻塞点交回父 agent; `disallowedTools: ["EditFile", "WriteFile", "ExitPlanMode"]`, `permissionMode: "plan"`, `readOnly: true`

### review

代码审查专家: 读 PR diff 和相关代码, 从正确性、项目约定、性能、测试覆盖、安全五个角度给出带文件路径、行号、影响和改进建议的发现; `disallowedTools: ["EditFile", "WriteFile", "ExitPlanMode"]`, 无 permissionMode/readOnly (可以跑 `gh` 等命令, 但不能编辑文件); 不修改文件、不发布 GitHub review, 缺上下文或受阻时如实汇报; `/review` 命令委派给这个角色 (见 [code-review](./code-review))

## 其他调用入口

带 `agent` 字段的内置 prompt 型 slash command (`/plan`、`/review`) 经 `runSubagentCommand` (src/commands/subagent.ts) 以固定参数前台跑一次: `kind: "subagent"`, `fork` 仅对 plan 为 true, 结果作为 assistant 消息写回主对话, 见 [slash-command](./slash-command); skill 的 fork 执行模式和 workflow 的任务原语也直接复用 `spawnSubagent` (分别见 [skills](./skills) 和 [workflow](./workflow))
