---
title: "Workflow"
description: "Workflow 子系统: 用确定性 JavaScript 脚本编排多个 subagent, 覆盖脚本模型与注入原语、并发上限、journal 持久化与重放、生命周期回流与 /workflows 监控"
local_path: "$HOME/github/yukino-code/apps/yukino"
local_commit: "bef5439b54e6510a12da61bcfa4285ecb1cd2192"
---

Workflow (src/workflow/) 用一段确定性的 JavaScript 脚本编排多个 subagent, 在后台并发跑完一整套「拆解 → 执行 → 验证」流程, 最终结果经任务通知回流主 agent

为什么需要它: Agent 工具一次只委派一个 subagent, 主 agent 要逐个等待、逐个整合; 当任务能拆成几十上百个独立子项 (逐文件审查、批量迁移、全仓扫描) 时, 用脚本一次性编排比让主 agent 循环委派更省 token、更可控。每次启动都会落盘脚本源码和 JSON args, 已成功的 agent 调用在恢复 (resume) 时直接从 journal 回放, 流程可重放、可审计

## 三个入口

| 入口                | 形态                                                                                         |
| ------------------- | -------------------------------------------------------------------------------------------- |
| `/ultracode <task>` | prompt 命令, 注入 ULTRACODE_PROMPT, 让主 agent 自己写脚本调用 Workflow                       |
| `/<name> [args]`    | 命名工作流, 自动注册为 prompt 命令 (见下文「命名工作流」)                                    |
| `Workflow` 工具     | agent 直接调用, 传 `script` / `name` / `scriptPath` 之一, 或 `resumeFromRunId` + JSON `args` |

WorkflowTool (src/workflow/workflow-tool.ts): name = "Workflow", category command, `isConcurrencySafe()` 恒为 true, 工具描述就是 WORKFLOW_TOOL_PROMPT (src/workflow/prompts.ts, 脚本模型与原语的权威描述)。UI、print、remote 三个宿主都经 `attachWorkflow` (src/workflow/wiring.ts) 装配: 幂等地创建 WorkflowService、把 WorkflowTool 注册进 ToolRegistry, 服务挂在工具实例上; 宿主用 `getWorkflowService(registry)` 取回服务驱动 `/workflows` 面板。另有一条精简版使用规则 WORKFLOW_RULE, 在 Workflow 工具在场时注入系统提示 (src/prompt/tools.ts)

## 工具输入与启动

输入经 workflowInputSchema (src/workflow/schema.ts) 校验:

| 字段              | 说明                                                                         |
| ----------------- | ---------------------------------------------------------------------------- |
| `script`          | 自包含的脚本源码                                                             |
| `name`            | `.yukino/workflows/` 下的命名工作流, 按 `.ts` / `.js` / `.mjs` 依次匹配      |
| `scriptPath`      | 脚本文件路径, realpath 后必须位于项目内或 workflow 存储目录内                |
| `args`            | 传给脚本的真实 JSON 值 (不允许字符串化的 JSON)                               |
| `resumeFromRunId` | 复用已存的脚本、args 与 journal 恢复运行, 需匹配 `^[a-zA-Z0-9][\w-]{0,127}$` |
| `description`     | 本次调用的简述, 用作后台任务名                                               |
| `title`           | 进度面板标题, 也是 workflowName 的次级来源                                   |
| `maxConcurrency`  | 并发 agent 数, 整数 1-16, 缺省 3                                             |

`script` / `name` / `scriptPath` 必须恰好传一个; 或者只传 `resumeFromRunId` 复用已存脚本。启动成功立即返回, 不阻塞主 agent:

```txt
Workflow started in the background.
run_id: <run id>
task_id: <task id>
workflow: <name>
script: ~/.yukino/projects/<project-key>/workflow-runs/<run_id>/script.js
You will receive the result as a task notification. Use /workflows to view progress.
```

## 脚本模型

脚本是 AsyncFunction 函数体, 不是 ESM 模块 (src/workflow/script.ts)。引擎先用正则加括号配对提取 `export const meta = {...}`, 再把剩余代码包成 `(async function(agent, parallel, pipeline, phase, log, workflow, args, budget, Date, Math) { ... })` 交 node:vm 编译 —— 原语全部以参数形式注入, 其中 Date 和 Math 两个参数是代理过的沙箱版本

- 禁止 `import` 语句、动态 `import(...)` 和 `meta` 之外的任何 `export`; 结果用顶层 `return` 交付
- `meta` 必须是纯字面量 (单独用 vm 求值, 不允许变量、函数调用、插值), schema 为: `name`、`description` 必填字符串, `whenToUse` 可选, `phases` 可选数组、元素为 `{ title, detail? }`
- `Date()` 调用、无参 `new Date()`、`Date.now()`、`Math.random()` 一律抛 NonDeterministicError —— 时间和随机性必须经 args 传入, 否则恢复重放不可复现; 带参的 `new Date(arg)` 合法
- TypeScript 语法不转译: `.ts` 扩展名的命名工作流同样按 JavaScript 解析
- 脚本在宿主进程内执行, 不是隔离沙箱; 沙箱只保证封死「显式逃生门」(import / 动态 import / 其他 export), 不承诺安全边界

```js
export const meta = {
  name: "review",
  description: "Review and verify changes",
  phases: [{ title: "Review" }],
};
phase("Review");
const results = await parallel(
  args.files.map(
    (file) => () =>
      agent("Review " + file, { agentType: "review", label: file }),
  ),
);
return results.filter(Boolean);
```

## 注入的原语

| 原语                                     | 行为                                                                                          |
| ---------------------------------------- | --------------------------------------------------------------------------------------------- |
| `agent(prompt, options?)`                | 跑一个 subagent, 返回文本或经 JSON Schema 校验的结构化值; 失败重试一次, 仍失败返回 null       |
| `parallel([() => agent(...)])`           | 并发等待全部 thunk; 单项错误变 null (WorkflowAbortedError 除外, 会向上抛)                     |
| `pipeline(items, ...stages)`             | 每个 item 顺序过多个 stage, item 之间重叠、无栅栏; stage 收 `(previous, originalItem, index)` |
| `phase(title)`                           | 标记进度阶段: 先收尾上一个阶段再开新阶段, 驱动 /workflows 面板                                |
| `log(message)`                           | 写一条运行日志, 存储最多保留 100 条                                                           |
| `workflow(name \| { scriptPath }, args)` | 嵌套调用另一个工作流, 只允许一层组合                                                          |
| `args`                                   | 调用时传入的 JSON 值                                                                          |
| `budget`                                 | 输出 token 记账: `budget.total` / `budget.spent()` / `budget.remaining()`                     |

budget 由 Budget 类 (src/workflow/budget.ts) 实现: spent() 累计成功 agent 的 outputTokens; 启动处当前恒传 `budgetTotal = null` (不设上限), 所以 `budget.total` 为 null、`remaining()` 为 Infinity; 若 total 有值, `spent >= total` 时每次启动 agent 前抛 BudgetExhaustedError

每个 `agent()` 返回的 Promise 都进引擎上下文的 inFlight 集合, runWorkflow 结束前会 await 全部 inFlight —— 脚本就算「发射后不管」, 运行也不会提前收尾

### agent 的落地过程

callAgent (src/workflow/hooks.ts) 的完整路径:

1. 分配自增 agentId; agentId 达到 MAX_TOTAL_AGENTS 直接报错
2. options 经 agentRunParamsSchema 校验; 传了 `schema` 则先用 Ajv 确认它是可编译的 JSON Schema
3. resume 时按 seq + key 查 journal, 匹配且校验通过的成功调用直接回放 (见「持久化与重放」)
4. 获取 Semaphore 许可 (可被 abort 打断), 为该 agent 建独立 AbortController 并登记进 agentControllers (供单停)
5. `budget.assertCanSpend()` 通过后发 agent_started, 经 AgentAdapterRegistry 解析适配器执行; 成功则 outputTokens 计入 budget
6. 结果 kind 为 ok / skipped / dead: 仅 ok 返回 output, 其余返回 null; 每个完成的调用 (含失败与跳过) 都追加写 journal

options (AgentRunParams, src/workflow/types.ts): `schema` (JSON Schema, 走结构化输出)、`model` (模型覆盖)、`maxTokens` (输出 token 上限)、`agentType` (角色名)、`isolation: "worktree"`、`allowedTools` (工具白名单)、`label` (面板展示名)、`phase` (阶段归属, 缺省继承当前 phase)。`label` 与 `phase` 不参与 journal key 计算

### yukino 后端

service 每次 launch 新建一个 AgentAdapterRegistry, 注册 createYukinoBackend 并设为默认 (id "yukino", capabilities: structuredOutput + tools); 注册表支持按 agentType / model 前缀 / 自定义谓词路由, 无匹配时抛 AdapterNotFoundError (src/workflow/agent-adapter.ts)

yukino 后端的 run (src/workflow/backend.ts):

1. 角色解析: `loadAgentDefinitions().find(name === agentType) ?? BUILTIN_AGENTS[0]`, 找不到回落 general-purpose; 内置角色为 general-purpose / plan / explore / review, `~/.yukino/agents/` 的 markdown 定义可覆盖 (见 [subagent](./subagent))
2. `isolation: "worktree"` 时为该 agent 建专用 worktree: createAgentWorktree(`wf_<runId>_<agentId>`), 分支名 `worktree/wf_<runId>_<agentId>/work` (见 [worktree](./worktree)); 建失败则本次调用记为 dead / worktree-failed
3. 工具过滤 filterToolsForAgent: `allowedTools` 白名单、角色的 disallowedTools、权限检查照常生效; worktree 场景使用 `checker.forWorktree`
4. `spawnSubagent` 以 `background: true` 执行; 传了 `schema` 时由 buildStructuredOutputPrompt 在 prompt 末尾要求「以纯文本输出一个符合 schema 的 JSON 值收尾」; usage / tool_use 事件转成 agent_progress 进度事件 (tokenCount 取最近一次 usage 事件的输入+输出 token, toolCount 累计工具调用次数), 驱动面板上的实时计数
5. 结构化输出提取 extractStructuredOutput: 先整段 JSON.parse, 再扫代码围栏, 最后做平衡括号扫描、候选倒序尝试; 提取不到记 dead / no-structured-output; 提取到的值再经 Ajv (allErrors, strict 关闭) 按 schema 校验, 不合记 dead / invalid-structured-output, 触发一次重试
6. 收尾: worktree 无改动则删除, 有改动则保留在各自分支, 不自动合并

## 并发与上限

- Semaphore (src/workflow/concurrency.ts) 全 run 共享 (子工作流复用同一引擎上下文): FIFO 排队、许可直接转交、acquire 可被 abort 打断
- `clampMaxConcurrency`: undefined / NaN 回落 DEFAULT_MAX_CONCURRENCY = 3, 否则截断并夹到 [1, MAX_CONCURRENCY_CAP = 16]; `maxConcurrency` 参数覆盖, 用户没要求就别传
- 单次运行最多 MAX_TOTAL_AGENTS = 1000 个 agent 调用; 单次 parallel / pipeline 最多 MAX_ITEMS_PER_CALL = 4096 个 item, 超限立即抛 WorkflowError
- 按数据流选型: 下游只需要单个 item 的结果就用 pipeline (无栅栏、重叠更好), 需要全部结果做汇总才用 parallel (真栅栏)

## 生命周期与回流

WorkflowService.launch (src/workflow/service.ts) 校验输入、解析脚本、落盘后, 在 TaskManager 上建一个后台任务并立即返回:

1. runId: resume 时复用 `resumeFromRunId`, 否则 randomUUID(); runId 已在运行则抛 "This workflow run is already running"
2. 解析源码: `script` 原样; `name` 查 `.yukino/workflows/`; `scriptPath` 经 realpath 后必须位于项目或 workflow 存储目录内; resume 读已存的 script.js。resume 时 args、maxConcurrency 缺省沿用已存的 request.json, 传新值则覆盖
3. workflowName 优先级: input.name → input.title → meta.name → 已存的 workflowName → "workflow"
4. saveRequest 落盘 script.js 与 request.json; 运行前先把 running 状态写进 state.json
5. `taskManager.create(description ?? workflowName, runner, cancel, { idPrefix: "workflow", kind: "workflow", originToolCallId })`, 任务 ID 形如 `workflow-<n>`; cancel 回调 abort 整个运行的 AbortController
6. 向 WorkflowProgressStore 写入初始 run 记录, 返回 `{ runId, taskId, workflowName, scriptPath }`

runner 在后台任务内执行 runWorkflow (src/workflow/run-workflow.ts):

- 解析脚本、建引擎上下文 (resume 时读入 journal), 发 run_started (meta.phases 变成面板上的 pending 阶段列表)
- 执行脚本, 等 inFlight 清空; 正常结束 status = completed、returnValue 为脚本的 return 值
- 异常 → status = failed 带错误串; 被中止 (TaskStop、`/workflows stop`、宿主 shutdown) → status = killed
- 收尾时补发当前阶段的 phase_done, 再发 run_done; state.json 在运行前后各写一次

回流路径:

- 结果经普通任务通知通道回流: 宿主 drainNotifications 把完成的任务格式化为 `<task-notification task_id=... status=...>` 注入对话 (见 [task-tracking](./task-tracking) 的后台任务一节)
- `TaskOutput` 用 task_id 查状态 (支持 wait / timeout_ms), `TaskStop` 取消 (src/tools/task-output.ts、src/teams/task-stop.ts)
- print 模式退出前会 `waitAll` 等待全部非 shell 后台任务 (含 workflow) 完成, 再把通知打印出来 (见 [print-mode](./print-mode))
- 停整个运行: kill 走 taskManager.stop(taskId) → abort 控制器 → status killed; 停单个 agent: killAgent 只 abort 该 agent 的控制器, 对应调用结果变 skipped (脚本拿到 null), 运行继续
- 运行失败时 runner 抛 TaskFailure 使后台任务状态为 failed; completed / killed 正常返回 formatWorkflowResult 文本。WorkflowTool.dispose → service.shutdown: 停止并等待所有活跃 run, 关闭后拒绝新启动

## 持久化与重放

每次启动把运行材料存到 `~/.yukino/projects/<project-key>/workflow-runs/<run_id>/` (projectPath 的 project-key 是规范化 cwd 的 sha256; src/workflow/persistence.ts):

| 文件            | 内容                                                                  |
| --------------- | --------------------------------------------------------------------- |
| `script.js`     | 本次运行的脚本源码快照                                                |
| `request.json`  | workflowName、args、maxConcurrency                                    |
| `journal.jsonl` | 每个完成 agent 调用的 key / seq / result (含失败与跳过, 回放只用 ok)  |
| `state.json`    | WorkflowRun 快照: status、phases、agents、logs、returnValue、error 等 |

journal 的 key (src/workflow/journal.ts): agentCallKey 取 `prompt + "\n" + 规范化 options` 的 sha256 —— options 剔除 label / phase、对象键递归排序, 因此纯展示性参数不会使回放失效。journal 写入经 Promise 队列串行化, replace 用临时文件加原子 rename; state.json 同样临时文件加 rename

重放规则 (src/workflow/hooks.ts 的 callAgent 回放分支):

- 按 seq (即 agentId) 加 key 匹配, 且仅 kind === ok、仍能通过 schema 校验的结果被回放 —— 回放不调模型、不占 Semaphore
- 一旦出现不匹配 (分叉), 置 journalInvalidated, journal 被替换为匹配前缀 (seq 小于当前 agentId 的条目), 该调用及之后的调用全部重新执行并续写 journal
- 普通 JavaScript 语句在重放时照常再跑一遍 —— 所以副作用要放进 agent 调用里, 脚本控制流必须确定性 (这也是 Date / Math 沙箱的由来)

`Workflow({ resumeFromRunId })` 复用已存源码和 args 重跑, 传新的 source 或 args 则覆盖; 被中断的运行同样可用 `/workflows resume <run_id>` 重新拉起

## /workflows 监控

`/workflows` 是 local_ui 命令 (描述 "Monitor, stop and resume workflow runs", src/commands/commands.ts)。UI 里不带参数调用会打开终端面板 WorkflowsDialog (src/ui/workflows-dialog.tsx), 带参数走文本命令; remote 宿主转交 service.command 并广播结果; print 模式在启动 agent 前执行 service.command 并打印。prompt 命令的机制见 [slash-command](./slash-command)

面板 (最多展示 MAX_VISIBLE_RUNS = 20 个运行; 终端宽 ≥ 65 列时显示 Phases 列):

- Tab / Shift+Tab 切换运行, ↑↓ 选择 agent
- x 停选中的 agent、K 停整个运行, 都只对 running 生效且需 y / Enter 确认 (n / Esc 取消)
- r 恢复已结束的运行 (等价 resumeFromRunId)
- Esc 或 q 关闭

文本命令 (WorkflowService.command, 三个宿主通用):

| 命令                              | 行为                                               |
| --------------------------------- | -------------------------------------------------- |
| `/workflows list` (或不带 action) | 列出全部运行: runId、名称、状态、agent 数、task_id |
| `/workflows <run_id>`             | 打印该运行的状态与结果                             |
| `/workflows stop <run_id>`        | 停止运行                                           |
| `/workflows resume <run_id>`      | 恢复运行                                           |

`loadPersistedRuns` 从历次运行的 state.json 载入记录: 上次退出时仍在 running 的运行改判 killed (附 "Workflow interrupted before shutdown"), 其 running 的 agent 改判 cancelled, 与当前会话的运行一起展示

## 命名工作流

项目级 `.yukino/workflows/<name>.ts|js|mjs` 下的脚本是命名工作流 (WORKFLOW_DIR_NAME = ".yukino/workflows"; 解析按 `.ts`、`.js`、`.mjs` 顺序尝试):

- 名字经 sanitizeWorkflowName 校验: 拒绝 `/`、`\`、`\0`、`.`、`..`; containsPath 防路径越界; resolveNamedWorkflow 还经 realpath 校验符号链接不指向 workflows 目录之外
- UI 与 remote 启动时 `registerNamedCommands` 扫描目录, 把每个脚本名注册为 prompt 命令 `/<name>`, 与已存在命令冲突时保留已存在者; print 模式不注册命令, 而是启动 agent 前比对 listNamedWorkflows, 命中则直接拼装提示
- `/<name> [args]` 注入提示让主 agent 以 `name=<name>` 调 Workflow, 用户参数转成 JSON args

嵌套组合: 脚本内 `workflow(name | { scriptPath }, args)` 调用另一个工作流。子工作流在进程内复用同一引擎上下文 (共享 Semaphore、budget、journal), 可以调 agent 但不能再调 workflow —— depth ≥ 1 抛 "workflow() nesting allows only one level"; scriptPath 必须位于项目内

## 与委派体系的关系

- Workflow 在 MAIN_AGENT_ONLY_TOOLS (src/subagent/constants.ts) 里: 所有受委派 agent 都被剥掉该工具, 普通 subagent 不能再起 workflow, 防递归编排; 完整黑名单 SUBAGENT_DISALLOWED_TOOLS 在此基础上另加 Agent / TeamCreate / TeamDelete / SendMessage
- Workflow 也在 coordinator 白名单 COORDINATOR_ALLOWED_TOOLS (src/teams/constants.ts, 见 [agent-team](./agent-team) 的 Coordinator Mode 一节): coordinator 模式下 leader 仍可用工作流把实际执行委派出去, 自己只做调度和整合
