---
title: "Agent Team"
---

## Why

### 解决的问题: 多 agent 通信

- subagent 是星型拓扑: 主 agent 在中心, subagent 在边缘, subagent 只能和主 agent 通信, 不能相互通信; 任务结束后, 执行结果作为 Agent 工具的返回值进入主 agent 的上下文窗口
- agent team 是网状拓扑: 每个 teammate 是有独立上下文窗口的 agent 实例, teammate 之间可以相互发送邮件
- 协调能力建立在两个共享结构上: 共享任务板 (`tasks.json`) + 每个成员独立的邮箱 (`inboxes/`)
- 邮件投递不走网络传输: 文件邮箱 + 轮询, leader 和 teammate 在下一轮 agent loop 迭代开始时读到邮件

### subagent 模式和 agent team 模式

- `kind: "subagent"` (一次性): ConversationManager 只存活在单次运行内; 结果内联返回 (前台) 或经 `<task-notification>` 送达 (后台); 终止后不能接收消息、不能恢复
- `kind: "teammate"` (持久成员): 跨回合复用同一个 ConversationManager; 完成一轮任务后进入空闲邮箱轮询, 读到新消息恢复完整上下文继续工作, 可以反复追加任务 (见 [subagent](./subagent))
- 两者共用 spawnSubagent 执行内核, 对话记录都落盘为 transcript.jsonl; 区别在生命周期与通信能力, 不在是否落盘

### 去中心化协调

> 共享任务列表持久化到单个 json 文件: `~/.yukino/teams/<namespace>/<team>/tasks.json`

- Yukino 把协调能力以工具的形式注入每个 teammate 的工具集 (TodoWrite + SendMessage), agent 自己查看共享任务列表、自己从独立的邮箱中接收邮件, 没有中心调度器决定「下一个该谁发言」
- 代价: 可预测性较低, agent 可能漏看消息或误认领任务
- 收益: 新增协调模式只需要修改/新增工具, 不需要复杂的调度器

## 数据结构与存储

```txt
~/.yukino/teams/<sha256(规范化项目路径)>/   # 按项目命名空间哈希隔离 (projectKey)
  <team-slug>/
    config.json        # TeamFile
    inboxes/
      leader.json      # leader 的邮箱
      jane.json        # teammate jane 的邮箱
    tasks.json         # 共享任务板 { nextId, tasks[] }
    logs/              # teammate 日志目录 (过期日志清理会扫描)
```

- 命名空间目录是规范化 cwd 的 sha256 hex, 不同项目不能恢复、列出、修改、删除彼此的 team (src/teams/team-file.ts)
- 团队名 sanitize: 非字母数字字符转 `-`, 小写, 得到目录 slug; slug 是 TeamManager 的规范键, config.json 里保留显示名
- 成员名约束 `^[A-Za-z0-9_-]+$` 且不能是 `leader` (邮箱文件名就是成员名)

config.json (TeamFile) 字段: `name`, `description?`, `createdAt` (unix 秒), `leaderAgentId` (创建时记为 `leader`), `permissionMode` (枚举 `default` / `acceptEdits` / `plan` / `bypassPermissions`), `members[]`; 每个成员条目含 `agentId`, `name`, `agentType?`, `model?`, `joinedAt`, `worktreePath?`, `isActive`

- permissionMode 跟踪 leader 的当前权限模式: TeamManager.setPermissionChecker 订阅 leader 权限变化, 每次切换同步写回所有 team 的 config.json
- config.json 的写入同样走文件锁 + 「写临时文件 + rename」, 并在锁内合并磁盘上已有成员, 持久化失败不影响内存 team 运行

### 邮箱文件

每个收件人一个 JSON 数组文件 `inboxes/<name>.json` (不是 jsonl), 消息结构 `{ from, text, timestamp, read?, type?, requestId?, approve? }` (src/teams/file-mailbox.ts):

- `read` 布尔字段是每条消息的读指针, 没有单独的 .read 文件; receiveSync 一次返回全部未读并标记已读
- 写入用「写临时文件 + rename」原子替换, 中途崩溃不会留下截断的 JSON
- 已读消息保留上限 MAX_READ_MESSAGES = 500 条, 超出从最旧删起; 未读消息永不删
- requeue: 把已消费的消息以未读状态追加回邮箱末尾; 用于 teammate 空闲轮询时同一批读到 shutdown_request 的场景 —— 其余消息重新入队, 下一轮再投递

### 邮箱文件锁

多个进程可能并发读写同一个邮箱、tasks.json、config.json, 每次读-改-写都包在 withFileSyncLock 里 (src/teams/file-lock.ts), 这是一个 Lamport bakery 式票据锁, 用 Atomics.wait 同步等待:

- 锁目录 `<file>.lock`; 竞争者先写 `choosing-<pid>-<rand>` 条目声明选号, 再写 `ticket-<16位票号>-<pid>-<rand>` 条目 (票号 = 现有最大票号 + 1, 补零到 16 位)
- 没有人在选号时, 最小票号获胜 (`ticket-` 条目按字典序排序, 取第一个)
- 获取超时 LOCK_ACQUIRE_TIMEOUT_MS = 5000ms; 退避从 LOCK_MIN_BACKOFF_MS = 5ms 起指数翻倍封顶 LOCK_MAX_BACKOFF_MS = 80ms, 每次等待 backoff + [0, backoff) 的随机抖动, 防止惊群
- stale 判定两个条件缺一不可: 条目 mtime 超过 LOCK_STALE_MS = 10s, 且持有者进程已死 (kill(pid, 0) 探测; Linux 上另读 `/proc/<pid>/stat` 的启动 tick, PID 被复用时也能识别出原持有者已退出)
- 递归获取同一把锁直接抛错

## Agent Team 的顶层工具

同一时刻最多存在一个 team: TeamCreate 先 deleteAll 清扫旧 team (停止成员、注销名字、删除 team 目录); 所有协作工具以 list()[0] 作为当前 team

- TeamCreate 工具: 只有可选的 `description` 参数; 团队名自动生成 `team-<uuid>`, 创建 TeamFile、初始化空 tasks.json
- Agent 工具: `kind` 默认就是 `"teammate"`, 向当前 team spawn 一个 teammate, team 不存在时自动创建, leader 不需要先调 TeamCreate; teammate 名字从 description 自动生成 (小写、空白转连字符、sanitize、截断 30 字符, 冲突追加 `-2` / `-3` 后缀)
- TeamList 工具: 无参数, 输出 `<team名>: name1 (active), name2`; 没有 team 时返回 `No active team.`
- TeamDelete 工具: 无参数, 注销成员名字、停止全部成员、删除当前 team 目录

```js
// 创建 team (名字自动生成)
TeamCreate.execute(ctx, {
  description: "迁移 react-router 到 @tanstack/router",
});

// Agent 工具 spawn 一个 teammate (team 不存在时自动创建)
Agent.execute(ctx, {
  kind: "teammate",
  description: "迁移 swr 到 @tanstack/query",
  prompt: "迁移 swr 到 @tanstack/query",
});
```

- team leader: 即主 agent, 负责拆解任务、分配任务、审批 plan、协调进度; leader 不在成员名册里, 只读自己的邮箱
- teammate: 任务执行者, 每个 teammate 是独立的 agent 实例, 有自己的上下文窗口、工具表和权限检查器

## 运行后端: in-process

teammate 和 leader 运行在同一个进程:

- teamRunAgentFactory 为每个 teammate 生成 RunAgent 闭包: 创建一个 ConversationManager, 每个任务回合调 spawnSubagent 在同一进程内跑一个独立的 agent loop (独立的工具注册表、PermissionChecker)
- spawnSubagent 传 backgroundTasks: false —— teammate 是「每个任务回合一次 spawnSubagent 运行」, 运行结束的 stopAll() 会杀掉它后台化的任务, 所以 teammate 纯前台执行
- 生命周期绑定 leader: 进程退出时 TeamManager.dispose() 停止所有成员; 停止 teammate 经 AbortController 中断其 loop, 不是杀进程
- 工具表从 leader 的注册表剥离而来: cloneRegistryForTeammate 移除 SUBAGENT_DISALLOWED_TOOLS (Agent / TeamCreate / TeamDelete / SendMessage / Workflow / Goal / ComputerUse / AskUserQuestion / EnterPlanMode / ExitPlanMode) 和 TaskStop, 其中 ExitPlanMode 在 plan 权限模式下保留; 然后由 AgentTool 注入以自己名字为发送者的 SendMessage 和 TeamTodoWriteTool
- teammate 不能继续 spawn teammate (Agent 已剥离), 不能停别人的任务 (TaskStop 已剥离)
- 唤醒靠邮箱轮询: teammate 完成一轮任务后进入空闲, 每 IDLE_POLL_INTERVAL_MS = 500ms 轮询自己的邮箱, 读到新消息拼为下一个任务、恢复完整上下文继续工作

## teammate 主循环

spawnTeammate 内部的主循环 (src/teams/index.ts):

```txt
while member.active:
  runAgent(buildTeammatePrompt(task))          # 执行一个任务回合
  if 被中断/停止 -> break (终态消息 [idle] stopped)
  if 仍是 plan 模式且需要审批 -> plan 审批分支 (见下文)
  uiState = idle
  向 leader 邮箱发送 [idle] <name> (reason: available)
  每 500ms 轮询自己的邮箱:
    读到 shutdown_request -> 同批其他消息 requeue, 回 shutdown_response, break
    读到其他消息 -> "You have new messages from your team: ..." 作为下一个任务
finally:
  active = false, NameRegistry 注销名字
  releaseOwner 释放未完成任务 -> [tasks-released] 通知 leader
  发送终态 [idle] 消息 (stopped / failed: <错误>)
  persist() + pruneTerminatedMembers (终止成员最多保留 MAX_RETAINED_TERMINATED_MEMBERS = 200)
```

buildTeammatePrompt 把任务包在 `<assignment>` 标签里, 附带团队协议: 用共享任务板记录进度、用 SendMessage(to: "leader", ...) 汇报、以自己的名字认领任务、回合结束变空闲不是终止 (SendMessage 可以带着完整上下文恢复它)、最终响应不会自动转发给 leader (重要结果先 SendMessage 再结束回合)

## 邮件路由: leader 侧 drain

- leader 的 agent loop 配置了 notificationFn, 每轮迭代开始时 (模型调用前) drain: teamManager.drainLeaderMailbox() 读出每个 team 的 leader 邮箱未读消息, 与后台任务通知一起注入
- drainLeaderMailbox 把消息包裹为 `<task-notification team="<team名>">`, 每条消息一行 `<message from="..." type="..." requestId="..." approve="...">text</message>` (属性经 XML 转义), 作为 system-reminder 注入 leader 上下文 (见 [system-prompt](./system-prompt))
- `[idle]` 前缀的消息 (`[idle] jane (reason: available)` / `stopped` / `failed: <错误>`) 只是通知; 成员状态变更 (active = false、注销名字、释放任务) 由 teammate 运行时在退出时自动完成, 不靠 leader 解析消息

```txt
1. teammate 完成任务 -> 向 leader 邮箱发送 [idle] jane (reason: available)
2. leader 下一轮 drain 邮箱, 知道 jane 空闲, 决定补发任务
3. SendMessage(to: "jane", content: "在 tests 目录下补一个 playwright 测试")
4. jane 的轮询循环读到新消息, 拼为 "You have new messages from your team: ..." 作为下一个任务, 恢复完整上下文继续工作
```

## SendMessage 工具

```js
SendMessage.execute(ctx, {
  to: "john", // teammate 名称、'leader' 或 '*' 广播
  type: "text", // text | shutdown_request | shutdown_response | plan_approval_response (仅 coordinator 模式)
  content: "接口 YukinoConfig 的签名已变更, 新增 agentTeam 字段",
});
```

- 必填参数 to 和 content; to 是 teammate 名称 (依次按成员表、agentId、进程内 NameRegistry 解析)、`leader` (直写 leader 邮箱)、`*` 广播 (跳过发送者本人和不活跃成员, 逐个发送)
- 结构化消息协议化通信, 避免 teammate 间通过自然语言协调生命周期和审批的模糊性:
  - shutdown_request: 请求目标 teammate 优雅退出, content 是理由; 只有 leader 可以发送
  - shutdown_response: 必须带 approve; teammate 在空闲轮询里收到 shutdown_request 后回 approve: true ("acknowledged, shutting down") 再退出; 等待 plan 审批期间被停止则回 "Stopped while awaiting plan review"
  - plan_approval_response: teammate plan 的审批响应, 只有 leader 可以发送 (teammate/subagent 尝试发送直接报错), 必须带 request_id + approve + 非空 content (审查反馈); 经 team.respondToPlan 校验 (请求仍在等待、未响应过、反馈非空), 非 coordinator 模式下直接报「plan 自动批准」错误; approve 缺失或反馈为空是工具错误, 不构成有效响应 (沉默永远不是同意)
  - text: 普通文本 (默认)
- requestId 生成: `req-<16位hex>` (randomBytes(8)), 请求与响应按 requestId 配对
- 向活跃 teammate 发信会把它标记为 running; 向已终止的 teammate 发信报错 (`Teammate 'x' is <status> and cannot receive work`)

## 协调机制: 共享任务板

agent team 给 teammate 额外注入两组协调工具:

```txt
TodoWrite   <- TeamTodoWriteTool, 底层换成团队共享任务板
SendMessage <- 邮箱通信 (以 teammate 自己的名字为发送者)
```

- TeamTodoWriteTool 继承 TodoWriteTool, 工具名和 schema 与私有版本完全相同, 注册进 teammate 的工具表时覆盖继承的版本 (见 [task-tracking](./task-tracking))
- 权限层的 teammate 协调放行: SendMessage 和 TodoWrite 属于 TEAMMATE_COORDINATION_TOOLS, 权限检查器对 teammate 自动放行 (显式 deny/ask 规则优先), plan 模式的禁写检查也不拦这两个工具

TeamTaskBoard (src/teams/task-tools.ts):

- board() 优先取指定 teamName 的 team, 否则取 list()[0]; 没有 team 时回落到 fallback 私有任务板
- boardId 前缀 `team:`; leader 私有板前缀 `private:`
- leader 侧同样被替换: createToolRegistry 传入 teamManager 时注册 TeamTodoWriteTool(manager, undefined, undefined, taskList) —— 存在 team 时操作共享任务板, 没有 team 时回落到 leader 的私有任务板, leader 不需要切换工具; subscribeLeaderTasks 以 500ms 周期 + 代数 (generation) 监听 board 切换, 保证 UI 始终显示正确的板

SharedTaskStore (src/teams/shared-task.ts):

- 持久化为 tasks.json, 结构 `{ nextId, tasks[] }`, tasks 元素是 SharedTask = StoredTask + `createdBy` (字段与依赖语义见 [task-tracking](./task-tracking))
- 每次变更先拿文件锁、在锁内重新从磁盘加载再改, 跨进程写入不会撞 ID 或互相覆盖; 校验依赖图后「写临时文件 + rename」落盘
- 写入带 actor / createdBy: teammate 把 in_progress 任务的 owner 原子地写成自己的名字 (认领); 不能改别人 owner 的任务 ("already claimed by ..."); 只有 leader 能把 owner 指派给别人; 每个 teammate 同时最多一个 in_progress 任务; completed / cancelled 的任务不能直接改回 in_progress
- 指派即通知: 写入 owner 为其他 teammate 的任务时, TeamTaskBoard 自动向该 teammate 的邮箱发一封任务分配邮件 ("Task assignment: #id ... Use TodoWrite({}) to inspect dependencies, then ... to claim it")
- releaseOwner: 该名字名下未完成、未取消的任务重置为 owner: "" + status: "pending", 并向 leader 邮箱发 `[tasks-released] <name> exited. Unassigned tasks: #...` 请求重新分配

## plan 审批

`subagent_type: "plan"` 且 `kind: "teammate"` 时, 内置 plan 定义被替换为 PLAN_TEAMMATE_AGENT: 以 plan 权限模式启动 (读放行、写只准写 plan 文件), 先规划、批准后继续执行; 而一次性的 plan / explore 角色是永久只读 (readOnly: true), 批准对它们无意义。

流程 (src/teams/index.ts, src/tools/exit-plan-mode.ts):

1. teammate 分析任务, 把执行计划写入 plan 文件 (`~/.yukino/plans/<slug>.md`, 由 plan-file 模块分配)
2. 提交有两条路径: teammate 调用 ExitPlanMode 工具 (plan 模式下保留, 内部调 team.submitPlan, 返回 requestId 并提示结束回合); 即使没调用, 回合结束时运行时发现它仍在 plan 模式, 会读取 plan 文件 (为空则取最终响应, 再为空记 "(The teammate returned no plan.)") 自动提交
3. submitPlan 把 plan 全文包为 plan_approval_request (附新生成的 requestId) 发到 leader 邮箱, teammate 进入等待
4. coordinator 模式下 requiresLeaderPlanApproval 为 true: teammate 每 500ms 轮询自己的邮箱, 只消费 shutdown_request 和 requestId 匹配的 plan_approval_response (要求来自 leader、approve 是布尔值、反馈非空); 等待期间到达的其他文本消息保持未读, 恢复执行时随审批结果一起拼进 prompt (buildPlanReviewResumePrompt)
   - approve: true + 审查反馈: teammate 的权限模式就地切换为 leader 当前模式 (leader 仍是 plan 时写 default), 开始执行; 批准不授权后续工具调用, 每次写操作仍按权限检查
   - approve: false + 审查反馈: teammate 留在 plan 模式, prompt 携带反馈, 要求修订计划重新提交
   - 期间收到 leader 的 shutdown_request: 回 shutdown_response 后退出
5. 非 coordinator 模式下自动批准: 运行时向 leader 邮箱投递一条 "Plan automatically approved" 通知, 然后切换权限模式、恢复执行

权限检查器对「等待审批的 teammate」有专门保护: teammate && requiresLeaderPlanApproval && 自身处于 plan 时, mode 固定返回 plan, 不会因 leader 退出 plan 模式而被带出

## 停止 teammate

- TaskStop 工具 (leader 侧): teammate 和 task_id 必须且只能传一个; 传 teammate 按名停止 (team.stopMember), 找不到时把所有已知成员名列进错误信息; 传 task_id 停后台任务 (见 [subagent](./subagent))
- stopMemberRuntime: 标记 active = false、NameRegistry 注销名字、AbortController 中断 loop 并等待退出、释放其任务、修剪终止成员
- 优雅退出: leader 用 SendMessage 发 shutdown_request, teammate 在空闲轮询里读到后回 shutdown_response (approve: true) 再退出, 同批的其他消息 requeue 留待下次投递

## leader 重启恢复

- 启动时 restoreFromDisk(): 遍历项目命名空间目录下的所有 team 目录, 从 config.json 重建 Team
- 崩溃时 isActive 的成员恢复为 failed 状态, 其余为 stopped, 统一不活跃
- 对每个恢复的成员立即 releaseMemberTasks: 未完成的任务回到 owner: "" + pending, 并给 leader 邮箱发 `[tasks-released]` 通知其重新分配
- teammate 的 worktree 路径记录在 config.json 的 worktreePath; worktree 本身存放在 `~/.yukino/worktrees/<projectKey>/<slug>` (分支 `worktree/<slug>/work`), 不在 team 目录内, 删除 team 不会删除 worktree, 保留待显式整合 (见 [worktree](./worktree))

## leader 的任务拆解策略

leader 的任务拆解直接决定 team 的效率: 拆得太粗, 子任务工作量太大、并发度低; 拆得太细, 子任务间依赖过多、teammate 相互等待

- 明确子任务间的依赖关系: 如果 task C 依赖 task A 的输出, 拆解时用 TodoWrite 的 `blocks` / `blockedBy` 字段建结构化依赖图 (依赖 ID 必须先存在、不能成环、只有 completed 的依赖解除阻塞), 同时把依赖关系写进任务描述; 不要指望 teammate 自己知道先做 A 后做 C
- 按文件边界拆解子任务: 只读子任务 (例如探索代码库) 可以并行; 两个子任务同时修改同一个文件很容易冲突。不可避免时二选一: 给两个任务建立依赖关系串行执行, 或 spawn teammate 时指定 `worktree: true` 做文件系统隔离
- 控制每个 teammate 的子任务数: 每个 teammate 安排 2-4 个子任务 (经验值); in_progress 任务自动挂 owner, 同一时刻一个 teammate 只能有一个 in_progress 任务
- 安排一个验证任务: 所有子任务完成后验证结果: typecheck + lint、test、build

## 预防冲突

多个 teammate 并发修改很容易冲突, agent team 在三个层面预防:

1. 任务拆解层: 按文件边界拆解, 每个共享文件集合只安排一个写者; coordinator 模式下 leader 被工具白名单约束为纯调度, 不写代码, 进一步减少写入点
2. worktree 隔离层: `worktree: true` 的 teammate 在 `~/.yukino/worktrees/<projectKey>/<slug>` 的独立工作副本上工作 (分支 `worktree/<slug>/work`), prompt 前置 buildWorktreeNotice 说明隔离关系; 权限检查器经 forWorktree 切换到 worktree 沙箱
3. 结果收集层: worktree 的改动不会自动合并 —— worktree 路径记录在成员元数据 (worktreePath), spawn 出错时也会在错误信息里带出 "Worktree retained at: ..."; 由 leader 决定 merge/rebase/cherry-pick 顺序和冲突解决策略进行整合 (coordinator 模式下 git 操作只能委派给 teammate)

## Coordinator Mode: 让 leader 专注调度

场景: 任务复杂、teammates 数量较多时, 如果不约束 leader, 它 spawn 完所有 teammates 后可能自己写代码、自己执行命令 (leader 有完整的工具集)

回顾 Plan Mode: 用 prompt 约束 LLM「只规划不做事」。Coordinator Mode 同理, 用「限制工具集 + prompt 注入」约束 leader「只调度不做事」: 纯配置项 `enable_coordinator_mode` (默认 false), 独立于当前是否存在 team, 整个会话生效 —— 会话中途切模式会留下无法撤回的陈旧指令, 配置从第一轮到最后一轮都是权威 (src/teams/coordinator.ts)

> 对于复杂任务, 推荐配合使用 Agent Team 和 Coordinator Mode

### 限制工具集

coordinator 模式下 leader 的工具白名单 (COORDINATOR_ALLOWED_TOOLS, src/teams/constants.ts):

```js
const COORDINATOR_ALLOWED_TOOLS = new Set([
  "Workflow", // 脚本编排多 subagent (见 workflow)
  "Goal", // 持久目标状态
  "Agent", // spawn 和管理 teammate
  "SendMessage", // 向 teammate 发送邮件
  "TaskStop", // 停止 teammate 或后台任务
  "SyntheticOutput", // 交付结构化结果
  "TeamDelete", // 删除 team
  "TodoWrite", // 共享任务板调度
]);
// MCP 工具同样被排除 (不在白名单内)
```

分界不是读/写, 而是「是否会把大量内容灌进 leader 的上下文」: ReadFile / Glob / Grep / Bash 的输出会占用 leader 的上下文窗口, 探索和执行都应该委派给 teammate, leader 消化结论、写下一步规格; 共享任务板是调度元数据, 属于编排而不是探索, 所以 TodoWrite 保留; TeamDelete 保留用于收尾; TeamCreate 不需要 —— Agent 的 `kind: "teammate"` 路径会自动建 team。只保留让 leader 能调度、通信、停止、交付结果的最小工具集

### Coordinator 提醒

coordinator 模式激活时, leader 每轮迭代注入 coordinator reminder (以 system-reminder 注入而不是改 system prompt: system prompt 是缓存前缀, 改动会使整个缓存失效, 见 [system-prompt](./system-prompt)):

- 第 1 轮和每 5 轮 (REMINDER_INTERVAL = 5) 注入全文 coordinatorPrompt: 工具用法、委派纪律、结果审查、验证要求
- 其余轮次注入精简版 coordinatorSparseReminder, 只保留最容易被模型遗忘的硬约束

plan 审批闸门随 coordinator 模式一起打开 (Team.requiresLeaderPlanApproval = coordinatorMode): leader 必须审查每个 plan_approval_request 并用 `type: "plan_approval_response"` 响应; 非 coordinator 模式下 plan 由运行时自动批准。SendMessage 的 type 枚举反映这一点: 只有 coordinator 模式才包含 plan_approval_response

### Coordinator 工作流

```txt
   leader spawn teammate (Agent kind: "teammate")
-> teammate 探索代码库 / 执行任务
-> teammate 用 SendMessage(to: "leader") 汇报证据 ([idle] 状态通知也走 leader 邮箱)
-> leader drain 邮箱, 整合、分析结果, 用 TodoWrite 在共享任务板上拆解子任务
-> leader 用 SendMessage 恢复空闲的 teammate 或 spawn 新 teammate, looping...
```

teammate 的最终响应不会自动转发, 证据经 SendMessage 进入 leader 邮箱; leader 侧 drainLeaderMailbox 把这些邮件包成 `<task-notification team="...">` 注入上下文, 与后台 subagent 的任务通知走同一个 notificationFn。coordinatorPrompt 的委派纪律: 并行独立任务、每个共享文件集合一个写者并串行化依赖变更、worktree 隔离但需要显式整合、不要通过另一个 agent 轮询某个 worker、不要臆测结果、git 操作只在用户授权范围内委派
