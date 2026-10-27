---
title: "Print Mode"
---

Print 模式是非交互的执行模式: 一条命令进去, agent 循环跑完, 结果打印到 stdout, 进程退出; 用于脚本、CI 流水线和「把 Yukino 当 Unix 工具用」的组合场景

```bash
yukino -p "explain this codebase"
yukino -p "fix the failing test" --output-format stream-json
```

实现集中在 `src/print-mode.ts` 的 `runPrintMode()`: 它自己组装一次完整的运行时 (config、LLM client、工具注册表、Agent), 消费 `agent.run()` 的事件流并按输出格式打印, 最后在 finally 里清理所有子进程和后台任务

## 旗标与解析

CLI 语法由 `src/cli.ts` 的 `parseCliArgs()` 统一解析, print 模式只涉及两个旗标:

- `-p <prompt>`: prompt 必须紧跟在 -p 之后, 多词 prompt 加引号; 值为空、全空白或以 `-` 开头都视为缺少 prompt, 报错退出; prompt 本身以 `-` 开头时用 `-p -- <prompt>`, 分隔符后的 token 一律当作 prompt 数据, 且其后不允许再有参数
- `--output-format text|stream-json`: 输出格式, 默认 text; 值缺失或非法报 usage 错误; 单独使用 (没有 -p) 也是错误

组合限制: `-p` 不能与 `--resume` 或任何服务器模式 (`--remote`、`--acp`、`--acp-ws`、`--a2a`) 同时出现, 也不能重复指定。所有 usage 错误打印 `Error: <message>` 到 stderr 并以退出码 1 结束。没有 `--print` 长旗标

运行时参数不从命令行取, 而是与交互模式同源:

- provider: `~/.yukino/config.yaml` 的 `default_provider` 是 providers 数组的下标, 越界时回退到第一个 (`resolveDefaultProvider`)
- 工作目录: `process.cwd()`
- 上下文窗口与输出上限: provider 的 `context_window` / `max_output_tokens`, 缺省分别是 1,000,000 和 128,000 (输出上限不会超过上下文窗口)

进程入口 (`src/main.tsx`) 在分发到 print 之前还会做三件与所有模式共享的事: 把 config 的 `env` 块灌进 `process.env` (只填空缺, 真实环境变量优先)、安装崩溃诊断 (`recover()`)、初始化遥测并 `setTelemetryMode("print")`, 结束时 `shutdownTelemetry()`; `runPrintMode` 抛出的异常被捕获后打印到 stderr 并置退出码 1 (见 [telemetry](./telemetry))

## prompt 可以是 slash command

prompt 先经过与交互模式同一套的命令解析器 `parseCommand()` (以 `/` 开头、首个空白前的部分为命令名; 见 [slash-command](./slash-command)), print 模式特判四类命令:

- `/goal ...`: 交给 `GoalManager` 本地处理, 支持 status (缺省)、clear、pause、complete、resume、continue、`replace <objective>` 和 `--budget <tokens>` 设置目标。纯查询/状态操作不启动 LLM: 打印状态消息后直接退出 (出错时退出码 1); set 与 resume/continue 会生成续跑 prompt, 继续走正常的 agent run。stream-json 下先输出一行 `{ "type": "goal", "message": ..., "goal": ... }` 事件
- `/ultracode <task>`: prompt 被替换为内置的 ULTRACODE_PROMPT 加 `Task: <args>`, 引导主 agent 用 Workflow 工具编排多 agent (见 [workflow](./workflow))
- 命名 workflow: 命令名命中 `<cwd>/.yukino/workflows/` 下的 `.ts` / `.js` / `.mjs` 脚本时, prompt 被替换为「调用 Workflow 工具执行该命名 workflow」的引导语, 用户参数原样附带
- `/workflows [list|stop <run_id>|resume <run_id>|<run_id>]`: 完全不调 LLM, 由 `WorkflowService.command()` 直接列出、查询、停止或恢复 workflow run; text 模式打印返回消息, stream-json 把消息放进最终 result 行

其余输入 (包括 `/help` 这类 print 模式不认识、或交互模式才有的命令) 不做拦截, 原样作为普通 prompt 交给模型

## 与交互模式的差异

- 权限: 固定 `new PermissionChecker(cwd, "bypassPermissions")`, 不弹任何确认。print 模式有意绕过权限提示, 只应在可信的 prompt 上运行 —— CI 里跑不可信输入等于任意代码执行 (权限模型见 [permission](./permission))
- 沙箱照常生效: `configureBashSandbox()` 按 config.yaml 的 `sandbox` 块给 Bash 工具挂 OS 沙箱 (写目录限制在 cwd 与系统临时目录, 网络可关), 与权限层独立 (见 [sandbox](./sandbox))
- 会话有持久化: `newSessionId()` 生成会话 id, 用户消息、每轮 assistant/tool 消息、goal 状态记录、后台任务通知都追加写入 `~/.yukino/sessions/<sha256(cwd)>/<sessionId>.jsonl` —— 与交互会话同一格式、同一位置, 因此 print 会话会出现在 `--resume` 的会话列表里, 可以被恢复续聊; 工具产物 (大输出溢写文件、后台任务状态) 同样保留, 退出时不删除
- 输入历史: prompt 经 `recordInput()` 记入全局输入历史, source 标记为 `print`
- 没有 HookEngine、没有 skills、没有 AskUserQuestion、没有 file-history 快照、没有自动记忆召回 —— 这些是交互 UI 的装配项, print 模式一概不接线
- AGENTS.md 指令仍然加载: `loadInstructions()` 拼接 `~/.yukino/AGENTS.md` 与 git root 到 cwd 沿途各级目录的 AGENTS.md, 注入 Agent (见 [agents-md-and-memory](./agents-md-and-memory))
- 支持持久目标: `GoalManager` 挂在本次 sessionId 上, 单次非交互执行内 active 的目标会自动续跑, 直到 complete / blocked / 预算耗尽或 150 轮上限 (见 [goal](./goal))
- 遥测正常初始化, mode 为 `print`

## 工具集

基座是 `createToolRegistry(cwd, taskList, { interactionMode: "non-interactive", ... })` 的 18 个内置工具: Goal、TodoWrite、TaskOutput、LSP、Bash、PowerShell、ComputerUse、EditFile、EnterWorktree、ExitPlanMode、ExitWorktree、ReadFile、ToolSearch、McpCall、WriteFile、Glob、Grep、WebFetch。与交互注册的唯一差别是 EnterPlanMode 不注册 —— 计划模式需要用户审批出口, 非交互场景没有意义

在基座之上 print 模式追加:

- 团队工具: TeamCreate、SendMessage、TeamDelete、TaskStop。单次非交互执行内 leader 仍然可以组建 team 委派任务 (见 [agent-team](./agent-team)); 团队不从磁盘恢复 —— print 模式只管理自己创建的 team 运行时, 避免退出清理时误杀交互会话留下的外部 teammate
- SyntheticOutput: 结构化交付通道 (见下文)
- Agent: subagent 委派工具, `defaultFork` 跟随 config 的 `enable_fork` (缺省开启), teammate 路径纯前台运行 (见 [subagent](./subagent))
- Workflow: `attachWorkflow()` 注册的编排工具, 与后台 TaskManager 共享
- 传入 teamManager 时 TodoWrite 实际是 TeamTodoWriteTool (工具名不变), 任务板与团队共享 (见 [task-tracking](./task-tracking))

两条接线值得单独说:

- `attachBackgroundTaskManager()` 把同一个 `TaskManager` 注入 Bash / PowerShell / TaskOutput, 于是 `run_in_background` 与超时自动转后台的命令, 和后台 agent 走同一条任务通知排水通道, 退出等待策略也能统一按任务类型区分
- MCP 在内置工具全部注册后才连接: `connectAll()` 之后每个远端工具包一层 `MCPToolWrapper` 注册, 连接失败逐个写 `MCP warning: <server>: <error>` 到 stderr 而不中断执行; 随后 `decideAndApply()` 用「全部 MCP schema 的总大小」对比上下文窗口决定 eager / native / dispatch 加载模式 —— 这个对比只有在工具全部就位后才准确 (见 [mcp](./mcp))

coordinator 模式 (`enable_coordinator_mode`) 在 print 模式同样生效: Agent 拿到 `coordinatorToolFilter` 作为 toolFilter, leader 全程只剩白名单工具 (Workflow、Goal、Agent、SendMessage、TaskStop、SyntheticOutput、TeamDelete、TodoWrite), 读文件写代码一律委派给 teammate

## Agent 装配

`runPrintMode` 用与交互模式相同的原料构造 Agent (见 [react-and-agent-loop](./react-and-agent-loop)):

- system prompt: `detectEnvironment(cwd)` 探测环境 (OS、shell、是否 git 仓库等) 并写入 `provider.model`, 再 `buildSystemPrompt()` 生成 (见 [system-prompt](./system-prompt))
- client: `createClient(provider, systemPrompt)` 按 protocol 分发到 anthropic / openai / openai-compat 实现
- conversation: 全新 `ConversationManager`, 只放入本次 prompt
- `notificationFn`: 每轮排水 leader mailbox (teammate 完成报告) 与后台任务通知, 作为 system reminder 注入下一轮
- `fileStateCache`: 新建 `FileStateCache`; `goalManager`、`abortSignal`、上下文窗口与输出上限一并传入

## text 输出

LLM 的流式文本 (`stream_text` 事件) 直接写 stdout, 边生成边输出; 循环结束后若输出非空且不以换行结尾则补一个换行, 之后追加后台任务的完成通知文本。错误不走 stdout: `error` 事件打印 `Error: <message>` 到 stderr

```bash
$ yukino -p "总结 src/agent/index.ts 的职责"
Agent 循环封装: run() 是一个 AsyncGenerator...
```

## stream-json 输出

每个事件一行 JSON, 供程序消费。四类事件做字段映射 (camelCase 转 snake_case), 其余逐行原样输出:

```jsonc
// 流式文本增量 (thinking_text、turn_complete、loop_complete、
// steering_delivered、retry 同样原样输出)
{ "type": "stream_text", "text": "Agent 循环封装..." }
// 工具调用开始
{ "type": "tool_use", "tool_name": "ReadFile", "tool_id": "toolu_1", "args": { "file_path": "src/agent/index.ts" } }
// 工具调用结果
{ "type": "tool_result", "tool_name": "ReadFile", "tool_id": "toolu_1", "output": "1\timport ...", "is_error": false, "elapsed": 0.02 }
// token 用量 (每次 LLM API 响应后)
{ "type": "usage", "input_tokens": 12000, "output_tokens": 340, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0 }
// 上下文压缩 (只保留消息文本)
{ "type": "compact", "message": "..." }
// 错误
{ "type": "error", "message": "..." }
// 后台任务完成通知
{ "type": "task_notification", "notification": "<task-notification ...>" }
```

`thinking_complete` 与 `permission_request` 事件不输出 (前者含签名细节, 后者在 bypassPermissions 下没有消费方)。

结束时的最后一行永远是汇总:

```jsonc
{
  "type": "result",
  "result": "Agent 循环封装: run() 是一个 AsyncGenerator...",
  "duration_ms": 8420,
  "num_turns": 3,
  "tool_calls": [{ "tool": "ReadFile", "tool_id": "toolu_1", "elapsed": 0.02 }],
  "usage": {
    "inputTokens": 12000,
    "outputTokens": 340,
    "cacheReadInputTokens": 0,
    "cacheCreationInputTokens": 0,
  },
}
```

`result` 是全程 `stream_text` 的拼接, `num_turns` 数 `turn_complete` 事件, `tool_calls` 按 tool_id 配对开始/结果事件回填耗时, `usage` 累加每次 API 响应的用量。即使中途出错, 已产生的部分文本也会出现在 result 行里

## 退出行为

- 等待策略: 主循环结束后 `waitAll(task => task.kind !== "shell")` —— 只等后台 Agent 与 workflow 任务 (它们的结果参与最终答案); 后台 shell 任务 (dev server、超时自动转后台的命令) 可能无限运行, 等它们会让 -p 永远挂住, 所以不等, 已完成的照常被排水, 剩下的由 finally 的 `stopAll()` 停掉
- 排水到的任务通知在打印前还会作为 system reminder 写回会话 jsonl, 保证恢复会话时能看到这些结果
- 信号处理: SIGINT 置退出码 130, SIGTERM 置 143, 同时 abort 主循环并停掉所有在跑的后台任务; 监听器在 finally 里移除, 不泄漏到宿主进程
- 退出码: 正常结束 0; `error` 事件或 `loop_complete` 的 stopReason 为 interrupted 且非本次 abort 引起时置 1; 信号终止为 130/143
- finally 清理顺序: 停后台任务 (`stopAll`) 与团队 (`teamManager.dispose()`, 内部 stopAll 所有 team) 并行 → 释放工具注册表 (`registry.dispose()`, 关掉 LSP 等长连接工具) → 断开 MCP 子进程 (`disconnectAll`)。清理失败被吞掉, 不掩盖执行本身的错误、不改变已打印的结果; 会话文件与产物目录保留

## 结构化交付: SyntheticOutput

脚本场景往往需要机器可读的结果而不是散文; SyntheticOutput 工具让 agent 以结构化 JSON 交付最终结果, 工具输出即 JSON 文本, 在 stream-json 下随 `tool_result` 事件原样可见:

```bash
yukino -p "分析这个仓库的依赖, 用 SyntheticOutput 交付 { outdated: string[] }" \
  --output-format stream-json
```

构造时可以带一份 JSON Schema 做交付校验 (顶层 type + required 字段), 但 print 模式注册的是无 schema 版本, 校验交给 prompt 约定。coordinator 模式下 SyntheticOutput 是 leader 白名单里的交付通道 —— leader 不动手干活, 汇总各 teammate 的结果后用它输出终稿 (见 [agent-team](./agent-team))
