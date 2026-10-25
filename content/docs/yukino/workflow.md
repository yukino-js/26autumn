---
title: "Workflow"
---

Workflow: 用一段确定性的 JavaScript 脚本编排多个 subagent, 在后台并发跑完一整套「拆解 → 执行 → 验证」流程, 结果经任务通知回流主 agent

为什么需要它: Agent 工具一次委派一个 subagent, 主 agent 要逐个等待、逐个整合; 当任务能拆成几十上百个独立子项 (逐文件审查、批量迁移、全仓扫描) 时, 用脚本一次性编排比让主 agent 循环委派更省 token、更可控

## 三个入口

| 入口                | 形态                                                                   |
| ------------------- | ---------------------------------------------------------------------- |
| `/ultracode <task>` | prompt 命令, 注入 ULTRACODE_PROMPT, 让主 agent 自己写脚本调用 Workflow |
| `/<name> [args]`    | 命名工作流, 自动注册为 prompt 命令 (见下文)                            |
| `Workflow` 工具     | agent 直接调用, 传 `script` / `name` / `scriptPath` 之一 + JSON `args` |

Workflow 工具 (src/workflow/workflow-tool.ts, name = "Workflow", category command) 在 UI、print、remote 三个宿主都经 `attachWorkflow` (src/workflow/wiring.ts) 装配; 它注册进 ToolRegistry 并把 WorkflowService 挂在工具实例上, 宿主用 `getWorkflowService(registry)` 取回服务驱动 `/workflows` 面板

## 脚本模型

脚本是 AsyncFunction 函数体, 不是 ESM 模块 (src/workflow/script.ts):

- 禁止 `import`、动态 import、TypeScript 语法、额外 export
- 可选 `export const meta = { name, description, phases: [{ title }] }`, 必须是纯字面量 (用 node:vm 单独求值, 不允许变量/函数调用/插值)
- 用顶层 `return` 交付结果
- `Date.now()`、`new Date()`、`Math.random()` 被沙箱替换为抛 NonDeterministicError 的版本: 时间和随机性必须经 args 传入, 否则重放 (replay) 不可复现
- 脚本在宿主进程内执行, 不是隔离沙箱

```js
export const meta = {
  name: "review-files",
  description: "Review files independently, then collect the findings",
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

脚本作用域内可用 (src/workflow/prompts.ts 的 WORKFLOW_TOOL_PROMPT 是权威描述):

| 原语                                     | 行为                                                                                        |
| ---------------------------------------- | ------------------------------------------------------------------------------------------- |
| `agent(prompt, options?)`                | 跑一个 subagent, 返回文本或经 JSON Schema 校验的结构化值; 失败重试一次, 仍失败返回 null     |
| `parallel([() => agent(...)])`           | 并发等待全部 thunk; 单项错误变 null                                                         |
| `pipeline(items, ...stages)`             | 每个 item 顺序过多个 stage, item 之间重叠无栅栏; stage 收 `(previous, originalItem, index)` |
| `phase(title)`                           | 标记进度阶段, 驱动 /workflows 面板                                                          |
| `log(message)`                           | 写一条运行日志                                                                              |
| `workflow(name \| { scriptPath }, args)` | 嵌套调用另一个工作流, 只允许一层组合 (嵌套工作流可调 agent, 不能再嵌套 workflow)            |
| `args`                                   | 调用时传入的 JSON 值                                                                        |
| `budget`                                 | `budget.total` / `budget.spent()` / `budget.remaining()`, 输出 token 记账                   |

`agent` 的 options: `schema` (JSON Schema, 走结构化输出)、`model`、`maxTokens`、`agentType` (角色, 见 subagent)、`isolation: "worktree"`、`allowedTools`、`label`、`phase`; 角色工具限制和权限照常生效, worktree 改动留在各自分支不自动合并

## 并发与上限

- 默认并发 3 (DEFAULT_MAX_CONCURRENCY), 上限 16 (MAX_CONCURRENCY_CAP); `maxConcurrency` 参数覆盖, 用户没要求就别传
- 单次运行最多 1000 个 agent 调用 (MAX_TOTAL_AGENTS), 单次 parallel/pipeline 最多 4096 个 item (MAX_ITEMS_PER_CALL)
- 下游只需要单个 item 结果时优先 pipeline, 需要全部结果做汇总才用 parallel (真栅栏)

## 启动与回流

Workflow 工具是异步的: `service.launch` 校验输入、解析脚本、落盘源码和 args, 在 TaskManager 上建一个后台任务后立即返回, 不阻塞主 agent

```txt
run_id: <uuid>
task_id: <task id>
workflow: <name>
script: ~/.yukino/projects/<project-key>/workflow-runs/<run_id>/script.js
```

- 结果经普通任务通知通道 (`<task-notification>`) 回流主 agent (见 task-tracking 的后台任务)
- `TaskOutput` / `TaskStop` 用 `task_id` 查状态或取消
- print 模式退出前会等待 workflow 任务完成

## 持久化与重放

每次启动把源码、JSON args、journal、运行状态存到 `~/.yukino/projects/<project-key>/workflow-runs/<run_id>/` (src/workflow/persistence.ts):

| 文件            | 内容                                 |
| --------------- | ------------------------------------ |
| `script.js`     | 本次运行的脚本源码快照               |
| `request.json`  | workflowName、args、maxConcurrency   |
| `journal.jsonl` | 每个成功 agent 调用的 key/seq/result |
| `state.json`    | 运行状态                             |

`Workflow({ resumeFromRunId })` 复用已存源码和 args 重跑; 传新的 source 或 args 则覆盖。重放时匹配成功的 agent 调用直接从 journal 回放, 不再调模型; 调用序列出现分叉时保留匹配前缀、其余重新执行。普通 JavaScript 语句在重放时照常再跑一遍 —— 所以副作用要放进 agent 里, 脚本控制流必须确定性

## /workflows 监控

`/workflows` (local_ui 命令) 打开终端监控面板, 展示各运行的 phase 和 agent 进度:

- Tab 切换运行, ↑↓ 选择 agent, x 停单个 agent, K 停整个运行, r 恢复已结束的运行, Esc 关闭
- 每个宿主都支持文本控制: `/workflows list`、`/workflows <run_id>`、`/workflows stop <run_id>`、`/workflows resume <run_id>` (src/workflow/service.ts 的 command)

## 命名工作流

项目级 `.yukino/workflows/<name>.js|mjs|ts` 下的脚本是命名工作流 (WORKFLOW_DIR_NAME):

- 启动时 `registerNamedCommands` 扫描目录, 把每个脚本名注册为 prompt 命令 `/<name>`, 与内置命令冲突时保留内置
- `/<name> [args]` 注入提示让主 agent 用 `name=<name>` 调 Workflow, 用户参数转成 JSON args
- 名字经 sanitizeWorkflowName 校验 (拒绝 `/`、`\`、`\0`、`.`、`..`), 路径经 containsPath 防越界; TypeScript 语法不转译

## 与 coordinator 模式的关系

Workflow 在 coordinator 白名单里 (见 agent-team): leader 可以编排工作流把实际执行委派出去, 自己只做调度和整合; Workflow 也在 MAIN_AGENT_ONLY_TOOLS 里, 普通 subagent 不能再起 workflow (防递归编排)
