---
title: "Subagent"
---

一个大的重构任务中, 插入一个小的更新 README.md 任务: Agent 上下文污染

## 关键洞察: Agent 也是一种工具

Agent 和 Tool 抽象同构, 可以将 Agent 包装为 Tool (AgentTool), 注册到 ToolRegistry

```ts
export type ToolCategory = "read" | "write" | "command";

interface Tool {
  name: string; // Subagent 的名字
  description: string; // Subagent 的描述
  category: ToolCategory;
  deferred?: boolean;
  schema(): ToolSchema; // 参数: Subagent 的任务
  // 返回 Subagent 的执行结果
  execute(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult>;
}
```

## Agent 工具的参数

```jsonc
{
  "description": "", // 必填, 一句话说明这个 subagent 做什么
  "prompt": "", // 必填, 任务指令 (自包含: 目标、相关文件、约束、期望结果)
  "kind": "teammate", // 可选, "teammate" (默认, 当前团队的持久成员) | "subagent" (一次性, 只返回工具结果)
  "subagent_type": "general-purpose", // 可选, 预定义的 agent 角色, 缺省 general-purpose
  "fork": true, // 可选, true 复制父对话作为初始上下文 / false 全新对话; 缺省取 enable_fork 配置 (未设时 true)
  "model": "", // 可选, 覆盖本次运行的模型
  "run_in_background": false, // 可选, 异步执行, 立即返回 task ID
  "worktree": false, // 可选, true 时在独立 git worktree 中运行, 编辑不与父/其他 agent 冲突
}
```

- `kind` 和 `subagent_type` 独立选择: kind 决定「一次性 subagent 还是持久 teammate」, subagent_type 决定角色和工具/权限约束
- teammate 名字从 description 自动生成, 加入当前团队 (没有则自动创建); 不再有 team_name / name / plan_mode_required 参数 (见 agent-team)

- 多 Agent 框架 (CrewAI、AutoGen): 中心化编排
  - AutoGen 的 GroupChat 使用 GroupChatManager, 按策略决定 agent chat 顺序
  - CrewAI 使用 Crew 对象编排 agent 和任务调度
- Yukino: 主从模式, coding 场景下主从模式更稳定, 避免多 Agent 循环等待

## 角色与初始上下文: 两个独立维度

- 角色由 `subagent_type` 决定 (缺省 general-purpose), 决定工具/权限/模型约束
- 初始上下文由 `fork` 决定 (缺省取 enable_fork 配置, 未设时 true): `fork: true` 复制父对话快照, `fork: false` 全新对话
- 两者正交: `subagent_type: "plan", fork: true` 是「plan 角色 + 继承上下文」, `subagent_type: "plan", fork: false` 是「plan 角色 + 全新上下文」; 其余角色同理

下文仍按习惯把 `fork: false` 的叫「定义式 subagent」, `fork: true` 的叫「fork 的 subagent」

### 预定义的 subagent (Definition-based)

subagent_type 是预定义的 subagent 角色, 枚举值来自已加载的 agent 定义

示例: ~/.yukino/agents/code-review.md

负责代码审查的 subagent 不能再 fork 一个 subagent、不能写文件、不能执行 Bash 命令, 是只读的代码审查专家

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

frontmatter 支持的字段: name、description、tools、disallowed_tools、system_prompt、max_turns、model、permission_mode、background、worktree; permission_mode 做枚举校验 (default | acceptEdits | plan | bypassPermissions), 拼错则整个文件加载失败; description 缺省取 body 前 200 字; body 映射为 initialPrompt

Agent 定义文件, 加载顺序从低到高, 同名后者覆盖

1. 内置级: Yukino 内置 (BUILTIN_AGENTS)
2. 用户级: ~/.yukino/agents/

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
  readOnly?: boolean; // 只读角色 (plan/explore 内置为 true)
  initialPrompt?: string; // markdown body
  // ...
}
```

### fork 的 subagent (Fork-based)

- fork 缺省取 `enable_fork` 配置 (未设时启用, 显式 false 关闭); 显式 `fork: true` 复制父对话快照, `fork: false` 全新对话, 与 subagent_type 无关
- 典型场景: 将一个 react 类组件迁移到函数组件后, fork 3 个 subagent 迁移剩余的类组件
- 降低成本: fork 的 subagent 和父 Agent 使用相同的 tools、system、messages (prompt cache 按前缀匹配, 顺序是 tools -> system -> messages), fork 的 subagent 首次 LLM API 请求可以命中 prompt cache, 降低 input_tokens 成本

> 继承父 Agent 的完整对话历史

1. `conversation.fork()`: structuredClone 复制父 Agent 的完整对话历史 (连同长期记忆注入标志和 usage anchor)
2. 对话历史的最后一条 assistant 消息中, 对「请求调用 AgentTool 的 tool_use 内容块 tu」, push 一个 tool_result 内容块, 保持 messages 格式 (user 和 assistant 两个 role 交替出现)
3. 将 Agent 的任务指令作为 user 消息追加, 使用 fork boilerplate 包裹对 subagent 的行为约束

```json
{
  "tool_use_id": "${tu.tool_use_id}",
  "content": "(tool execution interrupted by fork)",
  "is_error": false
}
```

> 为什么需要 fork boilerplate 约束 subagent 的行为?

fork 的 subagent 继承父 Agent 的 system prompt, system prompt 可能包含: "你可以创建 subagent", "你需要向用户确认" 等; boilerplate 覆盖继承的默认行为: 你是 fork 出来的 worker, 不是父 agent; 继承的对话是背景上下文, 只做随后分配的任务; 不要再次 fork; 不要和用户对话或请求确认; 尊重当前权限, 受阻时向父 agent 汇报; 返回简洁的发现/变更报告、相关路径、实际跑过的检查和剩余工作

fork 的 subagent 默认前台同步运行, 结果内联返回; `run_in_background: true` 时先取对话快照再启动后台任务 (父对话继续演进, 不影响快照)

> 定义式 subagent 默认前台同步运行

定义式 subagent 默认前台同步运行, 除非

- subagent 配置的 frontmatter 中指定 `background: true`
- 调用 Agent 工具时指定 `run_in_background: true`

## 选择哪种创建模式: Definition-based / Fork-based

- 如果任务通用、固定角色、固定职责, 例如 plan 指定计划、explore 代码探索、review 代码审查, 使用定义式 subagent, 指定 subagent_type:
  - 可以精确控制 subagent 的能力边界
  - 可以限制 subagent 调用的工具
  - 可以指定一个更小更快的模型: haiku, sonnet, deepseek...
- 如果任务不通用、与主 agent 的当前工作高度相关, 例如: 迁移一个组件的 useImperativeHandle 从 react18 到 react19, fork 3 个 subagent 迁移剩余的类组件, 使用 fork 的 subagent, subagent_type 为空

## 上下文隔离

- 基础设施共享: API Key、LLM API 连接、工具集、MCP、Skill、Hook
- 权限 (permissionMode): subagent 缺省继承 acceptEdits (定义或调用参数可以指定; options 的 plan 强制生效)
- 对话历史: 定义式 subagent 无历史, fork 的 subagent 继承快照
- 文件系统: 默认共享, 使用 `worktree: true` 时隔离
- maxIterations: subagent 默认 200 轮, 主 agent 默认不限制

## Subagent Loop

subagent loop 和主 agent loop 的区别

1. subagent loop turn 不等待用户输入 (没有 AskUserQuestion 工具)
2. LLM 不再调用工具, subagent loop 结束, 返回执行结果 (前台: 累积的流式文本作为工具调用结果, 空则 `[No output]`, 中断则附 `[Interrupted]` 标记)
3. pre_tool_use hook -> 调用 AgentTool -> subagent loop -> post_tool_use hook
4. 子代理指令以 system-reminder 注入 (角色 + 描述 + initialPrompt + 范围/协调/诚实汇报约束)

## Subagent 不能继续 spawn

工具过滤 (src/subagent/tool-filter.ts) 按五层顺序组合:

1. 主 agent 专属工具 `MAIN_AGENT_ONLY_TOOLS`: Workflow (防递归编排)、ComputerUse (独占物理屏幕/键鼠)、AskUserQuestion (独占模态对话框)、EnterPlanMode、ExitPlanMode (需要主线程审批对话框)、Goal (持久目标是会话级状态); 所有委派 agent (fork 和定义式) 都剥离
2. 委派策略限制 `SUBAGENT_EXTRA_TOOLS`: Agent (递归 spawn, 调用树在 subagent 层终止)、TeamCreate、TeamDelete (只有 leader 管理 team)、SendMessage (委派 agent 不继承 leader 的通信权限); mcp\_\_\* 工具豁免这两层
3. 后台异步 subagent: 白名单 `ASYNC_AGENT_ALLOWED_TOOLS` (18 个): TodoWrite, TaskOutput, TaskStop, LSP, ReadFile, WebFetch, Grep, Glob, Bash, PowerShell, EditFile, WriteFile, LoadSkill, SyntheticOutput, ToolSearch, EnterWorktree, ExitWorktree, McpCall; 没有交互式工具, 后台任务不能阻塞等用户
4. 定义的 disallowedTools 黑名单
5. 定义的 tools 白名单 (`["*"]` 关闭该层)

TaskStop 保留给委派 agent: 它只能停自己启动的任务, 不会越权

fork 不改变工具边界: fork 的 subagent 和定义式 subagent 走同一套工具过滤 (filterToolsForAgent), fork 继承的只是父对话快照; Agent 工具对所有委派 agent 剥离, 所以 fork 出来的 subagent 没有 Agent 工具, 无法再 spawn, 调用树在 subagent 层终止 (早期的 querySource 打标 + fork boilerplate 扫描的双重检测已移除)

## 后台异步运行模式

1. 调用 AgentTool 时指定 `run_in_background: true`, subagent 以后台异步任务启动, 主 agent 立即收到 task ID: `Background agent '<desc>' started (task_id: agent-N). Its result will arrive as a task notification.`
2. 后台任务由 TaskManager 管理: 任务 id 前缀区分类型 (agent- / bash- / ps-), 状态 running | completed | failed | cancelled, 完成的任务保留上限 200 条; TaskOutput 工具可以按 task_id 查看运行中的后台任务或等待一次完成 (有界超时, 见 task-tracking)
3. 任务结束后, 结果使用 `<task-notification />` 标签包裹, 经 agent loop 的通知 drain 作为 system-reminder 注入主 agent 的上下文:

```xml
<task-notification task_id="agent-1" status="completed">
name=explore-agent
(执行结果)
</task-notification>
```

4. TaskStop 工具停止后台任务: `task_id` (先查本轮的 TaskManager, 再回退宿主级) 或 `teammate` (按名停团队成员) 二选一

> 注意: Bash/PowerShell 有「超时自动转后台」和 Ctrl+B 手动转后台; Agent 没有超时自动后台化, esc 对前台 Agent 是中断而不是转后台

Agent 工具的 isConcurrencySafe 恒 true: LLM 在同一批里请求多个 Agent 调用时, 多个 subagent 并行运行 (各自独立的工具执行上下文), 完成序流式上报

## 内置 subagent_type

BUILTIN_AGENTS 四个内置角色 (源码: src/subagent/constants.ts):

### general-purpose

通用研究和多步任务执行; 无工具限制、无权限模式覆盖; fork 也使用这个角色承载

### plan

软件架构师, 只读规划任务: 调查现有架构, 提出带文件、约束、验证步骤的实现计划; `disallowedTools: ["EditFile", "WriteFile", "ExitPlanMode"]`, `permissionMode: "plan"`, `readOnly: true`

### explore

代码探索专家, 只读: 找代码、追调用链、报告带 file:line 的证据 (用 Glob/Grep/ReadFile 和只读 shell 命令); `disallowedTools: ["EditFile", "WriteFile", "ExitPlanMode"]`, `permissionMode: "plan"`, `readOnly: true`

### review

代码审查专家: 读 PR diff 和相关代码, 从正确性、项目约定、性能、测试覆盖、安全五个角度给出带 file:line、影响和改进建议的发现; `disallowedTools: ["EditFile", "WriteFile", "ExitPlanMode"]`; 不修改文件、不发布 GitHub review, 缺上下文或受阻时如实汇报; `/review` 命令委派给这个角色 (见 code-review)
