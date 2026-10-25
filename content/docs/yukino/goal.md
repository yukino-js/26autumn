---
title: "Goal"
---

持久目标 (Persistent Goal): 让 agent 跨轮次、跨用户消息地朝一个目标自动推进, 直到完成、受阻或预算耗尽

没有持久目标时, agent loop 在 LLM 停止调用工具的轮次就结束; 有持久目标时, 「LLM 认为当前回合说完了」不再是终点, 目标未完成就自动续跑

## 三件套

| 组件                            | 操作者 | 职责                                                                          |
| ------------------------------- | ------ | ----------------------------------------------------------------------------- |
| GoalManager (src/goal/index.ts) | 系统   | 目标状态机, 持久化到会话日志, 预算和轮次记账, 生成续跑 prompt 和每轮 reminder |
| /goal 命令                      | 用户   | 设置/替换/暂停/恢复/完成/清空目标 (见 slash-command)                          |
| Goal 工具                       | agent  | 只读查询 (action: get) 和汇报 (action: update, status: complete/blocked)      |

只有用户可以设置、替换、暂停、恢复目标; agent 不能自己改目标, 只能查询状态和汇报完成/受阻 —— 这防止 agent 为了「完成」而悄悄降低目标

## 数据模型

```ts
GoalSchema = {
  objective: string, // 目标描述, 1-4000 字符
  status:
    "active" |
    "paused" |
    "blocked" |
    "complete" |
    "budget_limited" |
    "max_turns",
  tokenBudget: number | null, // token 预算, null 不限量
  tokensUsed: number, // 已消耗 token (每轮 usage 累加)
  turnsExecuted: number, // 已执行的续跑轮数
  activeMs: number, // 累计活跃时长
  blockedAttempts: number, // 连续受阻计数
  lastBlockReason: string | null,
  lastBlockedTurn: number | null,
};
```

持久化: 每次状态变化向会话 jsonl 追加一条 `type: "goal_state"` 记录 (role: system, content 是 GoalState 的 JSON); 构造 GoalManager 时回放会话日志取最后一条有效记录, `/resume` 后目标原样恢复; content 为 null 表示已清空

## 状态转换

```txt
set/replace ---------> active
active --pause------> paused --resume--> active
active --3连受阻----> blocked --resume--> active
active --Goal工具---> complete (终态)
active --预算耗尽---> budget_limited (只能 replace 新预算)
active --150 轮-----> max_turns --continue--> active (清零 turnsExecuted)
任意状态 --clear----> (删除)
```

- 已有未完成目标时, `/goal <objective>` 报错, 必须显式 `/goal replace <objective>`
- budget_limited 不能 resume/continue: 预算耗尽后唯一出路是 replace 并给出新预算
- pause 只作用于 active; resume 只作用于 paused / blocked / max_turns (后者必须用 continue, 会清零轮次)

## 自动续跑

agent loop 本来要在「无 tool_use + 无 steering」时退出, 目标改变了这个退出条件 (src/agent/index.ts):

1. 循环每轮开始检查预算: `status === "budget_limited"` 时直接 loop_complete(stopReason: budget_limited), 输出目标格式
2. 退出前调用 `goalManager.continuation()`: 目标 active 且 `turnsExecuted < MAX_GOAL_TURNS (150)` 时返回续跑 prompt, 作为 user 消息注入历史, 先做文件快照再 `beginTurn()` 继续循环; 达到 150 轮转为 max_turns 停止
3. 续跑 prompt 固定约束: 保留完整目标、不得把「已完成部分」窄化为成功、完成前要推导全部需求并用权威证据逐条验证、检查测试覆盖、不重复已完成的工作

续跑还要过两道宿主侧的门: plan 模式不续跑; 交互式 UI 的 `shouldContinueGoal` 在有排队 follow-up 消息时返回 false (用户消息优先)

## token 预算

- `/goal --budget <tokens> <objective>` 设置预算; 目标 active 期间, 每轮 LLM 响应的 usage 经 `addTokens` 累加进 tokensUsed
- tokensUsed >= tokenBudget 时自动转为 budget_limited, 下一轮循环顶部检查立即停止
- 不设预算 (--budget 省略) 时只有 150 轮的上限兜底

## 受阻审计: 三连才停

agent 用 Goal 工具汇报 `update blocked + reason` 时:

- 同一轮重复记录: 忽略 (「本轮已记录过 blocker」)
- 与上一轮相同原因 (忽略大小写): blockedAttempts + 1; 否则重新计 1
- 连续 3 轮同一 blocker 才转为 blocked 停止续跑; 否则返回 `Blocked audit: N/3 consecutive turns.` 继续
- 设计动机: 「困难、慢、部分进展」不是受阻; 只有真正重复出现的不可逾越障碍才值得停止, 防止 agent 一遇挫折就放弃

完成审计更严: 只有 active 目标可以被标记 complete, 且必须附 reason; reminder 里要求「每项需求都有验证过的证据支撑, 包括测试覆盖检查, 不确定的工作视为未完成」

## 每轮 reminder

目标存在时每轮注入 `<persistent-goal>` system-reminder (addSystemReminderIfChanged, 内容不变不重复注入): 目标格式 (objective、status、tokens 用量、活跃时长、续跑轮数、最新 blocker) + 硬约束 (只有用户能设置/替换/暂停/恢复; 尊重 paused 和终态; 尊重用户 steering、权限和审批)

## 使用

```txt
/goal 把 src/ 下所有 React 类组件迁移为函数组件, 测试全绿
/goal status
/goal pause
/goal resume
/goal continue          # 仅 max_turns 后: 清零轮次继续
/goal replace 改为只迁移 src/components/
/goal --budget 500000 修复 CI 上的全部 flaky 测试
/goal complete          # 用户确认完成
/goal clear
```

print 模式同样支持 GoalManager (非交互单次执行内目标可以自动续跑); 交互 UI、remote、print 三个宿主的目标行为一致
