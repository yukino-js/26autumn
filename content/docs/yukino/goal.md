---
title: "Goal"
---

持久目标 (Persistent Goal): 让 agent 跨轮次、跨用户消息地朝一个目标自动推进, 直到完成、受阻或预算耗尽

没有持久目标时, agent loop 在 LLM 停止调用工具的轮次就结束; 有持久目标时, 「LLM 认为当前回合说完了」不再是终点 —— 只要目标还处于 active, 循环退出前会先问 GoalManager 要不要续跑 (见 [react-and-agent-loop](./react-and-agent-loop))

## 三件套

| 组件                            | 操作者 | 职责                                                                                                         |
| ------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------ |
| GoalManager (src/goal/index.ts) | 系统   | 目标状态机, 持久化到会话日志, token 和轮次记账, 生成续跑 prompt、预算总结和每轮 reminder                     |
| /goal 命令                      | 用户   | 设置/替换/暂停/恢复/继续/完成/清空目标 (见 [slash-command](./slash-command))                                 |
| Goal 工具 (src/tools/goal.ts)   | agent  | 只读查询 `action: get` 和汇报 `action: update` (status: `in_progress` / `complete` / `blocked`, 必附 reason) |

权限边界是单向的: 只有用户可以设置、替换、暂停、恢复、清空目标; agent 不能修改目标本身, 只能查询状态和汇报进展/完成/受阻 —— 这防止 agent 为了「完成」而悄悄降低或改写目标。Goal 是主会话专属工具, 列在 `MAIN_AGENT_ONLY_TOOLS` 里 (src/subagent/constants.ts), subagent 和 teammate 的工具注册表在过滤时直接剔除它; 即使绕过过滤调用, 缺少 goalManager 的上下文也会得到 `Goals belong to the main session and are unavailable to delegated agents.` 错误 (见 [subagent](./subagent))

## 数据模型

```ts
GoalSchema = {
  objective: string, // 目标描述, 1-4000 字符 (MAX_OBJECTIVE_CHARS)
  status:
    "active" |
    "paused" |
    "blocked" |
    "complete" |
    "budget_limited" |
    "max_turns",
  tokenBudget: number | null, // token 预算, null 不限量, 正整数
  tokensUsed: number, // 已消耗 token
  turnsExecuted: number, // 已执行的续跑轮数 (上限 MAX_GOAL_TURNS = 150)
  activeMs: number, // 累计活跃时长
  blockedAttempts: number, // 连续受阻计数 (阈值 MAX_BLOCKED_ATTEMPTS = 3)
  lastBlockReason: string | null,
  lastBlockedTurn: number | null,
  budgetSummaryPending: boolean, // 预算耗尽后的最终总结是否还没做
};
```

两个记账字段的语义值得注意:

- `activeMs` 只累计「在跑」的时间: `beginTurn()` 启动计时, `endRun()` / 状态转换时结算。轮次之间的空闲、paused 期间、进程重启都不计入
- `tokensUsed` 只在计时窗口内累加: 每轮 LLM 响应的 `stream_end` 事件到达时, 把 usage 的四项 (input、output、cache read、cache creation) 求和后经 `addTokens` 计入; 不在计时窗口内的 usage 一律忽略。预算总结轮由 `takeBudgetSummary` 重新开启记账, 所以这一轮的 token 也算数

## 持久化: goal_state 记录

每次状态变化, GoalManager 向会话 jsonl 追加一条 `role: "system"`、`type: "goal_state"` 的记录, content 是当前 GoalState 的 JSON; `clear()` 写入 JSON `null` 作为墓碑

恢复逻辑: 构造 `GoalManager(cwd, sessionId)` 时用 `loadSession` 扫描整份会话日志, 取最后一条能解析的 `goal_state` 记录作为当前状态, `null` 墓碑表示已清空。这带来三个性质:

- `/resume` 恢复会话后目标原样恢复; 会话日志被回退 (truncate) 时目标状态也跟着回退
- 对话重建 (rebuildFromSession) 只回放 user/assistant 消息, system 记录被丢弃, 所以 `goal_state` 永远不会进入对话历史, 也不受上下文压缩影响 —— 压缩边界前后的目标状态都能找回 (见 [context-compaction](./context-compaction))
- 解析失败的记录被跳过, 保留上一条有效状态

## 状态转换

```txt
/goal <obj> 或 /goal replace <obj>  ──> active
active   --/goal pause----------------> paused    --/goal resume--> active
active   --连续 3 轮同一 blocker------> blocked   --/goal resume--> active
active   --Goal update complete-------> complete  (终态)
任意存在状态 --/goal complete---------> complete  (终态)
active   --tokensUsed >= tokenBudget--> budget_limited
active   --turnsExecuted >= 150------> max_turns --/goal continue--> active (turnsExecuted 清零)
任意状态 --/goal clear----------------> (删除, 写入 null 墓碑)
```

- 已有未完成目标时, `/goal <objective>` 报 `An unfinished goal already exists.`, 必须显式 `/goal replace <objective>`; 上一个目标已 complete 时可以直接设置新目标
- budget_limited 后 resume/continue 都报 `The token budget is exhausted; replace the goal with an explicit new budget.`, 唯一出路是 replace 并给出新预算
- pause 只作用于 active; resume 只作用于 paused / blocked / max_turns 三种状态, 且会重置受阻计数; max_turns 必须用 continue (普通 resume 报 `Use /goal continue to reset the continuation limit.`), continue 又只认 max_turns, 用错状态会互相指路
- `/goal complete` 不要求 active, 用户对任何存在的目标都有最终确认权

## 命令处理: 谁返回 prompt, 谁立即起跑

`handleGoalCommand(manager, args)` 是所有宿主共用的分发器, 返回 `{ message, prompt?, isError? }`。message 永远有 (成功时是 `formatGoalStatus` 的状态报告, 失败时是 `Error: ...`); 关键在于 prompt —— 带 prompt 的命令会让宿主把 prompt 作为 user 消息注入对话并立即启动 agent loop:

| 命令                               | prompt                                     |
| ---------------------------------- | ------------------------------------------ |
| `/goal <obj>`、`/goal replace ...` | `Work toward this persistent goal: <obj>`  |
| `/goal resume`、`/goal continue`   | 续跑 prompt (目标 active 且未达轮次上限时) |
| status / pause / complete / clear  | 无, 只改状态不出声                         |

预算参数可以和子命令组合: `BUDGET_ARG_PATTERN` 解析 `--budget <正整数>`, 位置在 objective 之前, 例如 `/goal replace --budget 500000 <obj>`; 参数形状不匹配 (如缺 objective) 时返回 usage 提示 `Usage: /goal [replace] [--budget <positive integer>] <objective>`, 数值不满足 GoalSchema 校验 (如 0) 时返回 Error

三个宿主的行为:

- 交互 UI: `currentGoal()` 按 sessionId 持有 GoalManager, 会话切换时重建。**流式运行中** 输入 `/goal`、`/goal status|pause|clear|complete` 会被正则识别并立即执行 (这几条都不产生 prompt, 不打断当前轮); 其余目标命令 (resume、continue、replace、设置) 进 follow-up 排队, 等当前轮结束再跑
- [print-mode](./print-mode): 非交互单次执行同样支持 /goal; 无 prompt 的命令直接打印结果退出 (isError 时 exit code 1, stream-json 输出 `{ type: "goal", message, goal }`), 有 prompt 的命令把 prompt 作为输入正常跑 agent
- [remote](./remote) / ACP: 会话运行时在 `run()` 入口识别 /goal 命令, 流式输出 message 后把 prompt 当作本轮 user 文本继续; 运行中同样支持 `/goal status|pause|clear|complete` 快捷控制

## 自动续跑

agent loop 本来要在「无 tool_use + 无 steering」时退出, 目标改变了这个退出条件 (src/agent/index.ts)。退出路径上依次检查:

1. steering 队列非空则先投递 steering, 用户插话优先于续跑
2. stopReason 是 end_turn / stop 时, 只有同时满足「不是 plan 模式」和「`shouldContinueGoal()` 为真」才调用 `goalManager.continuation()`。交互 UI 传入 `() => !followUps.hasPending()`: 有排队消息时不续跑, 把下一轮让给用户; print / remote 不传, 默认放行
3. `continuation()` 在目标 active 且 `turnsExecuted < MAX_GOAL_TURNS` 时返回续跑 prompt; 达到 150 轮则转为 max_turns 并返回 null, 循环正常退出
4. 拿到续跑 prompt 后: 先做文件快照 (fileHistory), 把 prompt 作为 user 消息注入历史并持久化, `beginTurn()` 轮次 +1、重启计时和记账, 然后 continue 循环

续跑 prompt 固定携带硬约束 (`CONTINUATION_INSTRUCTION`): 保留完整目标、不得把「已完成部分」窄化为成功; 标记 complete 之前要推导全部需求并用权威证据逐条验证、检查测试覆盖、不确定视为未完成; 同一 blocker 每个续跑轮只记一次, 连续三轮才停止续跑, 困难、慢、部分进展不算 blocker; 尊重用户 steering、当前权限和待审批项; 不重复已完成的工作

## token 预算与最终总结

- `/goal --budget <tokens> <obj>` 设置预算 (正整数, 省略则只有 150 轮上限兜底); `tokensUsed >= tokenBudget` 的瞬间自动转为 budget_limited, 同时置 `budgetSummaryPending = true`
- 预算耗尽的那一轮响应里, 所有 tool call 直接打上 `Goal token budget reached; no further tools will be executed. Report existing progress.` 的错误标记, 不执行 —— 包括 agent 试图提交的 `Goal complete`

下一轮循环顶部是预算闸门 (`goalManager.get()?.status === "budget_limited"`):

- 满足总结条件 —— 不在总结轮、非 plan 模式、`shouldContinueGoal()` 放行、steering 队列为空、`budgetSummaryPending` 为 true —— 进入一次性的总结轮: 工具集被过滤为空 (连 deferred 工具都不暴露), 注入 `<goal-budget-limit>` prompt (状态报告 + 指令: 停止实质工作、这是唯一一次最终总结请求、报告已完成/已验证的内容和未完成项与 blocker、不得把未完成说成完成、目标保持 budget_limited 等用户决定), 发起一次 `maxRetries: 0` 的 LLM 调用。派发前 (pre-send hook 之后) 会重查 plan / shouldContinueGoal / steering 三道门, 期间到达的 steering 会让本轮放弃总结, `budgetSummaryPending` 原样保留
- 总结轮是特殊轮: 不计 maxIterations、跳过自动压缩、跳过 max_tokens 升级/恢复、跳过瞬时错误重试和 ContextTooLong 自愈 —— 失败就报 error 退出, 总结机会按已消耗处理
- 不满足总结条件 (plan 模式、steering 排队、follow-up 排队、被中断) 时, `budgetSummaryPending` 保持 true 并持久化: 循环直接把状态报告 stream 出来, 以 `loop_complete(stopReason: budget_limited)` 退出, 总结留到下一次 run 补做, 且只补一次

总结轮结束后同样打印状态报告并以 budget_limited 收尾。此后目标停在 budget_limited, 既不能 resume/continue, 也不会再消耗总结轮, 等用户 replace 新预算或 clear

## 受阻审计与 in_progress

agent 用 Goal 工具汇报时, 三种 status 都要附非空 reason, 且只有 active 目标可以汇报 (其余状态报 `Only an active goal can be updated by the agent.`):

- `in_progress`: 汇报进展, 清零 blockedAttempts / lastBlockReason / lastBlockedTurn, 目标保持 active。这是「虽然难但有进展」的出口, 避免误触发受阻停止
- `blocked`: 进入受阻审计
  - 同一轮重复记录: 忽略, 返回 `A blocker was already recorded for this turn; reassess on the next continuation turn.`
  - 与上一轮原因相同 (trim + 忽略大小写) 且轮次相邻: blockedAttempts + 1; 否则重新计 1
  - 连续 3 轮同一 blocker (`>= MAX_BLOCKED_ATTEMPTS`) 才转为 blocked 停止续跑; 否则返回 `Blocked audit: N/3 consecutive turns.` + 状态报告, 循环继续
- `complete`: 转为 complete 终态。工具描述和 reminder 都要求「全部需求达成且有验证过的证据, 包括测试覆盖检查, 不确定的工作视为未完成」

设计动机: 「困难、慢、部分进展」不是受阻; 只有真正重复出现的不可逾越障碍才值得让 agent 停下来等用户, 防止它一遇挫折就放弃, 也防止它无限重试

## 每轮 reminder

目标存在时, 每轮循环开始向历史注入 `<persistent-goal>` system-reminder (经 `addSystemReminderIfChanged`, 内容不变不重复注入), 结构是: 状态报告 (Goal / Status / `Tokens: used / budget` / `Active time: Ns` / `Continuation turns: N / 150` / 最新 Blocker) + `REMINDER_INSTRUCTION` 硬约束 (只有用户能设置/替换/暂停/恢复; in_progress 汇报进展并重置受阻审计; 完成需要全部需求验证; 同一 blocker 每轮只记一次; 尊重 paused 和终态、用户 steering、权限与审批)

目标被 clear 后, 若历史里还留着旧的 `<persistent-goal>` reminder, 会注入一条 `No persistent goal is set. Follow the current user request.` 把它盖掉, 防止模型按已删除的目标继续行动

## 使用

```txt
/goal 把 src/ 下所有 React 类组件迁移为函数组件, 测试全绿
/goal status
/goal pause
/goal resume
/goal continue          # 仅 max_turns 后: 清零轮次继续
/goal replace 改为只迁移 src/components/
/goal --budget 500000 修复 CI 上的全部 flaky 测试
/goal complete          # 用户确认完成 (任意状态下可用)
/goal clear
```

交互 UI、print、remote / ACP 共享同一套 GoalManager + `handleGoalCommand`, 目标行为一致: 设置/恢复目标后立即起跑, 运行中可随时 status / pause / clear / complete, 预算和轮次账目全程持久化在会话日志里
