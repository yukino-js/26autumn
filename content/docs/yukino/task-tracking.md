---
title: "Task Tracking"
description: "两套同名不同义的 task 机制: TodoWrite 任务板 (私有板与团队共享板、原子增量编辑、依赖校验) 与 TaskManager 后台任务 (登记、通知、TaskOutput/TaskStop), 含多团队下的板选择语义"
local_path: "$HOME/github/yukino-code/apps/yukino"
local_commit: "bef5439b54e6510a12da61bcfa4285ecb1cd2192"
---

任务跟踪在 Yukino 里是两套互不相干的机制, 只是碰巧都叫「task」:

- 任务板 (Task Board): agent 给自己建的显式工作清单 —— 把复杂任务的拆解、进度、依赖从对话里搬进结构化存储, 是模型自己维护的外部记忆, 也是多 agent 协作时的共享调度面
- 后台任务 (TaskManager): 「现在正在后台跑什么」的运行时登记表 —— 后台 subagent、后台 Bash/PowerShell、Workflow 都在这里面 (见 [subagent](./subagent))

为什么需要任务板: LLM 在长对话里容易忘记做过什么、漏掉子任务; 把「要做什么」外化成一块可读写的板子, 模型每轮都能刷新它、按依赖推进它。两者共享 `Task*` 工具命名空间但语义完全不同: 任务板跟踪计划, TaskManager 跟踪执行。

## 私有任务板

每个会话一块私有任务板, 由 `TaskList` (src/todo/index.ts) 在内存里持有, 通过 `TaskStore` (src/todo/store.ts) 持久化到会话产物目录:

```txt
~/.yukino/sessions/artifacts/<sessionId>/tasks.json
```

- 落盘格式是 `{ nextId, tasks }` 快照: `nextId` 是下一个待分配的整数 id, `tasks` 是 `StoredTask[]`
- 写入走「临时文件 + 原子 rename」(临时名带随机 UUID 后缀), 读者和崩溃都不会看到半截 JSON
- 加载时用 `TaskSnapshotSchema` 校验, 并要求每个 task 的 id 都小于 `nextId`, 否则拒绝加载
- `/resume` 或切换会话时对同一个 `TaskList` 调 `useStore(new TaskStore(sessionId))` 重新载入, 任务板随会话恢复 (src/ui/app.tsx)

板子用 `boardId` 标识来源: 私有板是 `private:<sessionId>` (前缀 `PRIVATE_BOARD_ID_PREFIX = "private:"`); 没有绑定 store 的纯内存板是 `private:<随机 UUID>`; 团队共享板是 `team:<团队名>` (前缀 `TEAM_BOARD_ID_PREFIX`, 见 [agent-team](./agent-team))。

## 任务模型

任务的结构由 `StoredTaskSchema` 定义 (src/todo/store.ts), 对应类型 `StoredTask` / `Task`:

```ts
interface Task {
  id: string; // 正十进制整数字符串 ("1"、"2"...), 会话内递增, 删除后不复用
  subject: string; // 简短标题, 创建时必填 (trim 后非空)
  description: string; // 需要做什么, 缺省空串
  status: "pending" | "in_progress" | "completed" | "blocked" | "cancelled";
  priority?: "high" | "medium" | "low";
  owner?: string; // 认领者 (团队场景), 空串表示未认领
  blocks: string[]; // 本任务阻塞哪些任务
  blockedBy: string[]; // 本任务被哪些任务阻塞
  metadata: Record<string, unknown>; // 顶层上下文键
}
```

id 由 `nextId` 单调分配: 每创建一个任务消耗一个整数并落进快照, 删除不会回收, 所以 id 在会话内始终唯一且递增。

## 唯一的任务工具: TodoWrite

任务板只暴露一个工具 `TodoWrite` (src/todo/tools.ts), 既能刷新也能原子编辑。它的 schema 由 `TodoWriteSchema` (src/todo/write.ts) 转成 JSON Schema, 所有实际改动都收敛到纯函数 `applyTodoWrite`。

一次调用的输入是 `{ todos?, deleteIds? }`, 两个数组各自最多 `MAX_TODO_WRITE_ITEMS = 200` 条:

- `TodoWrite({})`: 既没有 `todos` 也没有 `deleteIds` 时直接返回当前板快照, 不写入 —— 用来「刷新看一眼」
- `todos` 里每一项是增量编辑:
  - 无 `id` → 创建任务, 必须带 `subject`; `status` 缺省 `pending`, `description` 缺省空串
  - 有已存在的 `id` → 只更新提交的字段, 未提交的字段保持不变
  - 创建和更新都接受 `description`、`status`、`owner`、`priority`、`metadata`、`blocks`、`blockedBy`
  - 板子上被省略的任务原样保留; 空数组什么都不做
- `deleteIds: ["1"]`: 显式删除任务, 同时把其它任务里指向它的依赖边一并移除

返回结果是一段 JSON, 含 `boardId`、完整的 `todos` 快照, 以及 `progress` 字符串 (`TODO completed/total`, 来自 `taskProgress`, 只有 `completed` 计入分子, src/todo/progress.ts)。

原子性: `applyTodoWrite` 在 `structuredClone` 的副本上操作, 任一条目非法就整体抛错; `TaskList.write` 只有在成功返回后才 `store.save` 并更新 `this.tasks` / `this.nextId`。所以整批要么全成、要么全废 —— 不产生部分写入, 也不消耗 id。

字段语义:

- `blocks` / `blockedBy` 替换该任务的依赖列表并维护双向链接; 被引用的依赖 id 必须在本次调用前就已存在, 否则报 `Unknown dependency`。拒绝自依赖、成环, 也拒绝启动被阻塞的工作 (由 `validateTaskDependencies` 校验, src/todo/dependencies.ts)。只有 `completed` 的依赖才算解除阻塞; `cancelled` 的依赖仍视为未解决, 直到被显式移除
- `metadata` 按顶层键合并: `null` 删除一个键, 省略的键保留, 嵌套值整体替换 (`mergeTaskMetadata`)
- `priority` 在创建和更新时都可用

## 后台任务: TaskManager

TaskManager (src/subagent/task-manager.ts) 登记的是运行时后台任务, 和任务板没有 id 上的关系:

- 任务 id 用前缀区分类型, 计数器是模块级全局 `nextTaskId` (从 1 开始):
  - `agent-` 后台 subagent (默认前缀 `DEFAULT_TASK_ID_PREFIX = "agent"`)
  - `bash-` 后台 Bash 命令 (src/tools/bash.ts)
  - `ps-` 后台 PowerShell 命令 (src/tools/powershell.ts)
  - `workflow-` 后台 Workflow 运行 (src/workflow/service.ts)
- 每条任务带一个 `kind`: `agent` | `shell` | `workflow`; 宿主据此决定等待策略 —— 例如 print 模式收尾时 `waitAll(task => task.kind !== "shell")` 只等 agent/workflow, 不等可能永远运行的 shell (dev server), 那些留到退出时 kill (src/print-mode.ts)
- 状态是 `running` | `completed` | `failed` | `cancelled`; 已结束且已通知的任务在内存里最多保留 `MAX_RETAINED_FINISHED_TASKS = 200` 条, 超出时淘汰最旧的, running 任务永不淘汰
- 后台任务还会落盘到 `~/.yukino/sessions/artifacts/<sessionId>/background-tasks/<task_id>.json` (`BackgroundTaskStore`, src/subagent/task-store.ts); 会话恢复时 `running` 记录被改判为 `failed` 并附「session restored」错误

任务结束后, 结果被 `formatAgentTaskNotification` 包成一段 XML:

```txt
<task-notification task_id="..." status="...">
name=...
transcript_path=...   // 有 transcript 时才有这行
<任务输出>
</task-notification>
```

agent loop 每轮通过 `notificationFn` 调 `drainNotifications()` 取出所有「已结束、未通知」的任务, 格式化成上面这段, 作为 `<system-reminder>` 注入主 agent 上下文 (src/agent/index.ts)。`drainNotifications` 只标记一次, 不会重复推送。

## 查询与控制: TaskOutput / TaskStop

两个工具操作的是后台任务, 不是任务板:

- `TaskOutput` (src/tools/task-output.ts): 按 `task_id` 查看后台任务状态与结果, 或用 `wait: true` 有界等待一次 (`timeout_ms` 取值 0–60000, 缺省 30000)。它不消费完成通知、超时也不会停任务, 返回里带 `timed_out`。推荐等 `<task-notification>` 而不是反复轮询。任务板的整数 id 不能在这里用
- `TaskStop` (src/teams/task-stop.ts): `task_id` 和 `teammate` 二选一, 传其它组合直接报错
  - `task_id`: 停后台任务, 先查本轮上下文的 TaskManager (`ctx.taskManager`) 再回退宿主级 —— 委派出去的 loop 不能取消属于父 agent 的任务
  - `teammate`: 按名停团队成员 (leader 专属; 委派出去的 subagent 版工具没有这个参数)。成员名可能跨团队重名, 团队解析走 `resolveTeam(team_name, teammate)`: 传了 `team_name` 时团队必须存在且含该成员; 未传时选中唯一含该成员的团队, 多个团队匹配则报歧义错误

## 用法约定

工具的行为边界靠每轮注入的运行时工具指南维持 (`buildToolGuidance` 把 `TODO_WRITE_RULE`、`TASK_OUTPUT_RULE`、`BACKGROUND_TASK_STOP_RULE` 等规则拼进一条 `<system-reminder>`, src/prompt/tools.ts, 见 [system-prompt](./system-prompt)):

- 只跟踪复杂工作, 琐碎请求不建任务; 开始前标 `in_progress`, 验证通过后才标 `completed`, `blocked` / `cancelled` 如实使用
- 计数只认 `completed` (`TODO completed/total`); 已完成的任务在显式删除前一直留在板上
- `TodoWrite` 只做跟踪, 绝不启动 Agent 或后台任务 —— 执行是 Agent 的事, 跟踪是任务板的事
- 团队协作时: leader 和 teammates 共享团队任务板 —— 每个 teammate 拿到的 `TodoWrite` 底层是绑定本团队的 `TeamTodoWriteTool`, leader/主 agent 的版本则在无团队时回退到私有板; 普通 subagent 和 fork 永远用各自独立的私有清单 (见 [agent-team](./agent-team))
- 团队板选择: `TeamTodoWriteTool` 在基础 schema 上追加 `team_name` 参数, 多个团队并存时用它选择目标团队的板; 未传且多团队并存时报 `Multiple teams match. Specify team_name; use TeamList to see available teams.`; teammate 被限制在本团队的板, 传其它团队名报 `Teammates can only access their own team.`
- leader 侧的板订阅 (`subscribeLeaderTasks`, src/teams/task-tools.ts, UI 与 remote 共用) 在多团队时聚合全部团队板: 任务 id 变成 `["<团队名>", "<id>"]` 的 JSON 字符串做命名空间, subject 加 `[<团队名>]` 前缀, boardId 含团队名数组; 单团队时原样展示, 无团队时回退私有板
- teammate 以自己的名字认领 `in_progress` 任务; 只有 leader 能把任务指派给别人, 且同一时刻一个 teammate 只能有一个 `in_progress` 任务

## 宿主差异

`TodoWrite` + `TaskOutput` + `TaskStop` 三个工具在各宿主都注册, 差别在底层任务板指向哪里:

- 交互式 UI / remote: `createToolRegistry` 传入 `teamManager`, 于是 `TodoWrite` 实际是 `TeamTodoWriteTool`, 有团队时切到共享任务板、无团队时用私有 `TaskList` 兜底; `TaskOutput` / `TaskStop` 绑定后台 `TaskManager` (src/ui/app.tsx、src/remote/server.ts)
- print 模式: 同一套注册, 单次非交互执行内也可用; 收尾只等 agent/workflow 后台任务, shell 任务在退出时统一 kill (src/print-mode.ts, 见 [print-mode](./print-mode))
- 后台异步 subagent: 工具白名单 `ASYNC_AGENT_ALLOWED_TOOLS` 含 `TodoWrite` / `TaskOutput` / `TaskStop` (src/subagent/constants.ts); 过滤时 `TodoWrite` 被 `forList` 换成 subagent 自己的私有清单, `TaskStop` 被 `forSubagent` 降级为只能停自己的后台任务 (见 [subagent](./subagent))
