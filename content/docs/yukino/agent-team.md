---
title: "Agent Team"
---

## Why

### 解决的问题: 多 agent 通信

- subagent 是星型拓扑, 主 agent 在中心, subagent 在边缘, subagent 只能和主 agent 通信, subagent 不能相互通信, subagent 的任务执行结束后, 结果加入主 agent 的上下文窗口
- agent team 是网状拓扑, 每个 teammate 有自己的上下文窗口, teammate 可以相互发送邮件
- 多 agent 协调能力: 基于共享的任务列表和每个 agent (leader + teammate) 独立的邮箱 (使用「收件箱」更准确)
- 发送邮件不使用网络传输, 而是使用文件邮箱 + 轮询, leader 和 teammate 在下一轮 agent loop turn 开始时收到邮件

### subagent 模式和 agent team 模式

- subagent 模式: subagent 对话历史不会被持久化到磁盘, 适用于一次性的、边界明确的小型任务
- agent team 模式: teammate 对话历史会被持久化到磁盘, 适用于可以拆解为多个子任务的大型任务, 例如重构 4 个相互依赖的模块

### 对比 AutoGen, CrewAI, LangGraph

_中心化编排_

- AutoGen 的 GroupChat 使用 GroupChatManager, 按策略决定 agent 发言顺序
- CrewAI 使用 Crew 对象编排 agent 和任务调度

_有向图状态机_

- LangGraph 将多 agent 协调建模为有向图状态机

_去中心化协调_

> 共享任务列表持久化到单个 json 文件: `~/.yukino/teams/<namespace>/<team>/tasks.json`

- Yukino 将多 agent 协调能力以工具的形式注入到每个 teammate 的工具集, agent 自己查看共享任务列表、自己从独立的邮箱中接收邮件
- 代价: 可预测性较低
- 收益: 新增协调模式只需要修改/新增工具, 不需要复杂的调度器

## 数据结构与存储

```txt
~/.yukino/teams/<sha256(项目路径)>/     # 按项目命名空间哈希隔离
  <team>/
    config.json        # TeamFile: name, description, createdAt, leaderAgentId, permissionMode, members[]
    inboxes/
      leader.json      # leader 的邮箱
      jane.json        # teammate jane 的邮箱
      john.json
    tasks.json         # 共享任务板 { next_id, tasks[] }
    logs/              # teammate 的结构化日志
```

- 团队名 sanitize: 非字母数字字符转 `-`, 小写
- 邮箱是 JSON 数组文件 (不是 jsonl), 每条消息带 `read` 布尔字段作读指针, 没有单独的 .read 文件; 写入用「写临时文件 + rename」原子替换
- 已读消息保留上限 500 条, 未读消息永不删; 等待 plan 审批期间误收的消息会重新入队 (requeue)
- config.json 的 permissionMode 记录创建 team 时 leader 的权限模式

### 邮箱文件锁

多个进程可能并发读写同一个邮箱, 读写前使用 Lamport bakery 式票据锁 (src/teams/file-lock.ts):

- 锁目录 `<file>.lock`, 竞争者先写 `choosing-<pid>-<rand>` 条目声明选号, 再写 `ticket-<16位票号>-<pid>-<rand>` 条目, 最小票号者获胜
- 获取超时 5000ms; 退避从 5ms 起指数翻倍封顶 80ms, 带等量随机抖动, 防止惊群
- stale 判定: 锁文件 mtime 超过 10s 且持有者 PID 已死, 才清理 (两个条件缺一不可, 防止误杀活锁)
- 递归获取同一把锁直接抛错

## Agent Team 的顶层工具

同一时刻最多存在一个 team: 创建新 team 前先清扫旧 team (停止成员 + 删磁盘残留)

- TeamCreate 工具: 创建 team, 团队名自动生成 (`team-<uuid>`), 只有可选的 `description` 参数; 创建 TeamFile、注册 leader (主 agent 自己)
- Agent 工具: `kind: "teammate"` (默认) 向当前 team spawn 一个 teammate, team 不存在时自动创建, leader 不需要先调 TeamCreate; teammate 名字从 description 自动生成
- TeamList 工具: 无参数, 输出当前 team 名和成员 (`name (active)` 逗号分隔); 没有 team 时返回提示
- TeamDelete 工具: 无参数, 停止成员、注销名字、删除当前 team 目录

```js
// 创建 team (名字自动生成)
TeamCreate.execute({
  description: "迁移 react-router 到 @tanstack/router",
});

// 调用 Agent 工具 (kind: teammate) spawn 一个 teammate
Agent.execute({
  kind: "teammate",
  description: "迁移 swr 到 @tanstack/query",
  prompt: "迁移 swr 到 @tanstack/query",
});
```

- team leader: 即主 agent, 主 agent 创建 agent team 后自动成为 team leader, 负责创建 team、spawn teammate, 拆解任务, 协调进度
- teammate: 任务执行者, 每个 teammate 是一个独立的 agent 实例, 有自己的上下文窗口和工具集, teammate 可以是预定义的 (指定 subagent_type, 无对话历史), 也可以是 fork 的 (不指定 subagent_type, 继承 leader 的完整对话历史)

## 运行后端: in-process

teammate 和 leader 运行在同一个进程 (早期的 tmux / iterm 独立进程后端和 `--teammate` 旗标已移除):

- teammate 经 Agent 工具的 `kind: "teammate"` 派生, 由 teamRunAgentFactory 调 spawnSubagent 在同一进程内跑一个独立的 agent loop (有自己的 ConversationManager、权限检查器、工具表)
- 生命周期绑定 leader: leader 退出, 所有 teammate 都退出; 停止 teammate 经 AbortController 中断其 loop, 不是杀进程
- teammate 没有 Agent / TeamCreate / TeamDelete 工具 (委派策略剥离, 见 subagent), 不能继续 spawn teammate
- 唤醒靠邮箱轮询: teammate 完成一轮任务后进入空闲, 每 500ms (IDLE_POLL_INTERVAL_MS) 轮询自己的邮箱, 读到新消息就拼为下一个任务、恢复完整上下文继续工作

## 协调机制

agent team 给 teammate 额外注入两组协调工具

- 任务管理工具: TodoWrite (团队感知版本 TeamTodoWriteTool, 继承自 TodoWriteTool, 见 task-tracking); 工具名和 schema 与私有版本完全相同, 注册进 teammate 的工具表时覆盖继承的版本, 底层 board 换成团队共享任务板 (SharedTaskStore, tasks.json, 多 owner / blocks / blockedBy 依赖字段); teammate 以自己的名字认领 in_progress 任务
- 通信工具: SendMessage, 使得 leader/teammate 间可以相互发送邮件

```txt
teammate 注入的协调工具:
  TodoWrite (TeamTodoWriteTool)  <- 团队共享任务板 (SharedTaskStore)
  SendMessage                    <- 邮箱通信
```

leader 侧的 TodoWrite 同样被替换为团队感知版本: 存在 team 上下文时操作共享任务板, 没有 team 时回落到 leader 的私有任务板 (subscribeLeaderTasks 监听 board 切换); 因此 leader 不需要切换工具就能同时管理私有任务和团队任务

- teammate 和 leader (主 agent) 都有 SendMessage 工具
- 普通 subagent 没有 SendMessage 工具 (委派策略剥离, 见 subagent)

## SendMessage 工具

```js
SendMessage.execute({
  to: "john", // teammate 名称、'leader' 或 '*' 广播
  type: "text", // text | shutdown_request | shutdown_response | plan_approval_response
  content: "接口 YukinoConfig 的签名已变更, 新增 agentTeam 字段",
});
```

- to: teammate 名称 (经进程内 NameRegistry 解析为 agentId)、`leader` (直写 leader 邮箱)、`*` 广播 (跳过发送者本人, 逐个发送)
- type 结构化消息 (协议化通信, 避免 teammate 间通过自然语言协调生命周期和审批的模糊性):
  - shutdown_request: 请求某个 teammate 优雅退出, content 是理由; 目标 teammate 响应 shutdown_response
  - shutdown_response: 必须带 approve; 只能发送给 leader
  - plan_approval_response: teammate 写操作 plan 的审批响应, 必须带 request_id + approve, 只有 leader 可以发送; approve 缺失视为拒绝 (silence is never consent)
  - text: 普通文本 (默认)
- requestId 生成: `req-<16位hex>`, 跨进程安全

## plan 审批

coordinator 模式下, `subagent_type: "plan"` 的 teammate 以 plan 权限模式启动 (读放行、写确认, 确认方是 leader); 内置 plan 角色作为 teammate 时先规划再执行 (PLAN_TEAMMATE_AGENT), 一次性 plan subagent 和所有 explore worker 则永久只读:

1. teammate 分析任务、将执行计划写入 plan 文件
2. teammate 没有 ExitPlanMode 工具, 以回合结束作为提交信号: leader 侧检测到 teammate 的权限模式仍是 plan 且回合结束, 读取 plan 文件
3. plan 全文作为 plan_approval_request 发送到 leader 邮箱 (requestId 配对); 等待期间 teammate 收到的其他消息挂起并重新入队
4. leader 审批后, 使用 SendMessage `type: plan_approval_response` + request_id + approve + content (审查反馈) 响应
   - approve: teammate 的权限模式就地写入 leader 当前模式 (leader 仍是 plan 时写 default), 恢复执行; 批准不授权后续工具调用, 每次写操作仍按权限走
   - reject + feedback: teammate 留在 plan 模式, prompt 携带反馈, 要求修订计划重新提交

非 coordinator 模式下, 提交的执行计划自动批准

## 邮件路由与生命周期

teammate 每轮 agent loop turn 开始时, leader 侧 drain leader 邮箱: 未读消息包裹为 `<task-notification team="...">from=<name>: <text></task-notification>` 注入上下文; `[idle]` 前缀的消息同时更新成员状态 (failed/stopped 的成员标记不活跃并注销名字)

```txt
1. teammate 完成任务 -> 向 leader 邮箱发送 [idle] jane (reason: available)
2. leader 下一轮 drain 邮箱, 知道 jane 空闲, 决定补发任务
3. SendMessage(to: "jane", content: "在 tests 目录下补一个 playwright 测试")
4. jane 的轮询循环读到新消息, 拼为 "You have new messages from your team: ..." 作为下一个任务, 恢复完整上下文继续工作
```

- teammate 空闲后不需要重新 spawn: 完成一轮后进入 500ms 邮箱轮询等待, 读到新消息恢复完整上下文继续工作
- 停止 teammate: TaskStop 工具按名停 (team.stopMember), 或 SendMessage 发 shutdown_request 让其优雅退出 (teammate 在空闲轮询里收到后回 shutdown_response 再退出); 底层经 AbortController 中断 loop, 不是杀进程
- leader 重启恢复: 遍历项目命名空间目录重建 team, 标记旧 runtime 不活跃并重新认领未完成的工作; 编辑过的 worktree 保留待显式整合, 不随 runtime 清理删除

### teammate 对比 subagent

- teammate 是特殊的 subagent
- teammate 对话历史会被持久化到磁盘
- subagent 对话历史不会被持久化到磁盘

## leader 的任务拆解策略

leader 的任务拆解策略, 直接决定 team 的效率:

- 拆解的太粗, 会导致子任务的工作量太大, 并发度低
- 拆解的太细, 会导致子任务间的依赖过多, teammate 等待

### 任务拆解原则

- 明确子任务间的依赖关系: leader 拆解任务时, 如果 task C 需要等待 task A 完成 (task C 依赖 task A 的输出), 则用 TodoWrite 的 `blocks` / `blockedBy` 字段创建结构化的任务依赖图, 同时将依赖关系写到任务描述; 不要指望 teammate 知道先做 task A 后做 task C
- 按文件边界拆解子任务: 只读子任务 (例如探索代码库) 可以并行, 如果两个子任务同时修改同一个文件, 则很容易冲突; 尽量让不同的子任务操作不同的文件, 如果不可避免的 task A、task B 两个子任务修改同一个文件, 则可以:
  - 对 task A、task B 两个子任务建立依赖关系, 串行执行
  - leader spawn teammate 时指定 `worktree: true`, 为 teammate 创建独立的 worktree, 文件系统隔离
- 控制每个 teammate 的子任务数: 每个 teammate 安排 2-4 个子任务 (经验值)
- 安排一个验证任务: 所有子任务完成后, 验证结果: typecheck + lint、test、build

## 预防冲突

多个 teammate 并发修改, 很容易冲突, agent team 在三个层面预防冲突

### 第一层: 任务拆解

按文件边界拆解子任务: 只读子任务 (例如探索代码库) 可以并行, 如果两个子任务同时修改同一个文件, 则很容易冲突; 尽量让不同的子任务操作不同的文件, coordinator 模式通过限制工具集和 prompt 约束 leader 专注调度, 不写代码

### 第二层: 可选的 worktree 文件隔离

如果不可避免的 task A、task B 两个子任务修改同一个文件, 则可以:

- 对 task A、task B 两个子任务建立依赖关系, 串行执行
- spawn teammate 时指定 `worktree: true`, 为 teammate 创建独立的 worktree, 文件系统隔离

### 第三层: 收集结果

如果 teammate 使用了 worktree 文件隔离, 则需要合并到主分支; leader 调用 Bash 工具执行 git 命令, 调用 ReadFile 工具查看冲突文件, 以确定 merge/rebase/cherry-pick 顺序和冲突解决策略; leader 不确定冲突解决策略时, 调用 AskUserQuestion 工具弹出对话框让用户确认 (HITL)

## Coordinator Mode: 让 leader 专注调度, 不写代码

场景: 任务复杂、teammates 数量较多时, leader spawn 所有的 teammates 后, 如果不约束 leader, 则 leader 可能自己调用 WriteFile 工具写代码、自己调用 Bash 工具执行命令 (leader 有完整的工具集)

回顾 Plan Mode: 只规划不做事, 通过 prompt 约束 LLM 行为

Coordinator Mode: 只调度不做事, 通过限制工具集和 prompt 约束 leader 行为, coordinator 模式独立于 Agent Team (纯配置项 `enable_coordinator_mode`, 不取决于当前是否存在 team; 会话中途切模式会留下无法撤回的陈旧指令), 进入 coordinator 模式后, 收窄 leader 的工具集, 注入 coordinator 指令, 让 leader 专注调度

> 对于复杂任务, 推荐配合使用 Agent Team 和 Coordinator Mode

### 限制工具集

coordinator 模式下 leader 的工具白名单 (src/teams/coordinator.ts):

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
// MCP 工具同样被排除
```

分界不是读/写, 而是「是否会把大量内容灌进 leader 的上下文」: ReadFile/Glob/Grep/Bash 的输出会占用 leader 的上下文窗口, 探索和执行都应该委派给 teammate; 共享任务板是调度元数据, 属于编排而不是探索, 所以 TodoWrite 保留; 只保留让 leader 能调度、通信、停止、交付结果的最小工具集 (TeamCreate 不需要: Agent 的 kind:teammate 路径会自动建 team)

### Coordinator 工作流

coordinator 模式还会每轮注入 coordinator reminder (第 1 轮和每 5 轮注入全文, 其余轮次注入精简版硬约束, 见 system-prompt 的周期性提醒), 提示 leader 使用 4 阶段工作流

| 阶段           | 执行者                                                                     |
| -------------- | -------------------------------------------------------------------------- |
| Research       | teammate 探索代码库, 可以并行                                              |
| Synthesis      | leader (coordinator 模式), 整合、分析 teammate 的探索/执行结果, 拆解子任务 |
| Implementation | teammate 执行子任务                                                        |
| Verification   | leader 收集结果、解决冲突、teammate 验证结果                               |

> 回顾 subagent 的 `<task-notification />` 通知机制

相同的, teammate 子任务执行结束后, 使用 `<task-notification />` 标签包裹执行结果, 作为 system-reminder 注入 leader 的上下文

```txt
   leader spawn teammate
-> teammate 探索代码库/执行任务
-> leader 收到 teammate 的探索/执行结果 (task-notification)
-> leader 整合、分析 teammate 的探索/执行结果, 拆解子任务
-> leader 恢复空闲的 teammate, looping...
```
