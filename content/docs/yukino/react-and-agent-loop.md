---
title: "ReAct and Agent Loop"
---

ReAct (Reasoning + Acting) 是 Yukino agent loop 遵循的范式: 推理与行动交替进行, 每一步行动都建立在对上一步结果的观察之上。本页讲清这个范式如何落成代码 — `Agent.run()` 事件循环的每一轮做什么、何时退出、出错如何自愈, 以及工具如何分批执行。

## ReAct: 推理与行动交替

ReAct 的一个回合由三个角色组成:

- **Reasoning** (text): 解释为什么要做这一步, 把思考过程写出来
- **Acting** (tool_use): 选择调用一个工具去改变或观察环境
- **Observation** (tool_result): 分析工具调用的结果, 决定下一步怎么做

三者首尾相接: Observation 触发新一轮 Reasoning, Reasoning 导向下一次 Acting。LLM 的每次流式响应就是一次 Reasoning + Acting, CLI 执行工具后把 Observation 作为 user 消息回灌, 循环继续。

## ReAct 对比其他范式

| 范式              | 特点                                                   |
| ----------------- | ------------------------------------------------------ |
| Chain-of-Thought  | 只推理, 不行动; 一口气想完直接给答案                   |
| Act-only          | 只行动, 不推理; 不输出思考直接调工具                   |
| ReAct             | 推理与行动交替, 每步行动有思考依据, 每次观察反馈给推理 |
| Plan-then-execute | 先生成完整计划, 再逐步执行; 计划一旦定死不随观察调整   |

Yukino 的主循环是 ReAct; 需要长时间自主推进时再叠加持久目标 (见 [goal](./goal)), 让「推理-行动-观察」的回合一直跑到目标完成或预算耗尽。

## Agent Loop: 一个 AsyncGenerator 事件流

agent loop 的载体是 `Agent.run()` (src/agent/index.ts), 它是一个 `AsyncGenerator<AgentEvent>`: 每消费一段 LLM API 流、每执行一批工具, 就 `yield` 事件给宿主。UI、remote、ACP、A2A、print 模式都是同一份循环的宿主 (UI 和 print 直接 `new Agent`, remote/ACP/A2A 经 `createRemoteAgent` 装配), 消费的都是同一种 `AgentEvent`。subagent、记忆提取等后台任务也是同一份循环的另一个实例。

骨架可以简化成这样:

```ts
async function* agentLoop(
  userMessage: UserMessage,
): AsyncGenerator<AgentEvent> {
  const messages = [...historyMessages, userMessage];
  while (true) {
    const response = streamLLM(systemPrompt, messages, toolSchemas);
    const toolUses = response.getToolUses();
    if (toolUses.length === 0) {
      return response; // LLM 不再要工具, 循环结束
    }
    messages.push({ role: "assistant", content: response.content });
    const results = [];
    for (const tu of toolUses) {
      results.push(await executeTool(tu));
    }
    messages.push({ role: "user", content: results }); // Observation 回灌
  }
}
```

真实实现 (src/agent/index.ts 的 `Agent.run()`) 在这个骨架上叠加了中断检查、预算检查、上下文压缩、错误自愈、max_tokens 恢复、steering 投递和生命周期 hook。

### 每轮 (iteration) 的完整流程

按代码顺序, 一轮 turn 依次做这些事:

1. **abort 检查**: `abortSignal` 已触发则直接 `loop_complete(interrupted)` 退出
2. **持久目标预算检查**: goal 的 status 是 `budget_limited` 时, 要么进入一轮「预算小结」(见 [goal](./goal)), 要么直接 `stream_text` 输出小结并 `loop_complete(budget_limited)`
3. **maxIterations 检查**: `maxIterations > 0` 且已超限时, yield `error` 事件退出; 默认 0 = 不限制
4. **组装本轮工具集**: `registry.getAllSchemas` / `listVisibleToolNames` 按当前协议和 `toolFilter` 算出可见工具; goal 小结轮强制 `toolFilter = () => false` (不带任何工具)
5. **注入本轮 system-reminder** (都通过 `addSystemReminder` / `addSystemReminderIfChanged`, 见 [system-prompt](./system-prompt)):
   - 工具调用指南 `buildToolGuidance` (按当前可见工具集动态生成)
   - 工作目录提醒 `<working-directory>` (含 worktree 分支和目录级 instructions)
   - 持久目标提醒 `<persistent-goal>`
   - plan mode 提醒 `buildPlanModeReminder` (plan 模式才注入)
   - coordinator 提醒 `coordinatorReminder` (coordinator 模式才注入)
   - 延迟加载工具列表 `buildDeferredToolGuidance`
   - hook 通知 `hookEngine.drainNotifications()`
   - 外部通知 `notificationFn()` (teammate 邮件、后台任务完成通知)
   - skill 列表增量 `skillDeltaFn()`
6. **触发 turn_start 和 pre_send hook**: hook 输出再 drain 一次补进 reminder, 保证本轮可见
7. **自动上下文压缩**: `manageContext` (见 [context-compaction](./context-compaction)), 压缩成功则 yield `compact` 事件并 `restoreContext` 重新注入长期记忆和工具引导
8. **发起 LLM 流**: `client.stream(conversation, toolSchemas, abortSignal, { maxOutputTokens })`, 逐事件消费 — 文本增量累积、thinking 块收集、tool_use 收集、`stream_end` 记录 stopReason 和 usage (并 `goalManager.addTokens`)
9. **错误自愈** (见下文)
10. **max_tokens 处理** (见下文)
11. **assistant 消息入历史并持久化** 到会话文件 (`addAssistantFull` + `persistLastMessage`), 记录 usage anchor
12. **有 tool_use**: 分批执行工具 (`StreamingExecutor`, 见下文) → 大结果溢出磁盘的预算处理 → tool_result 消息入历史并持久化 → (若预取的记忆 recall 已就绪, 注入 reminder) → yield `turn_complete` → 投递 steering
13. **无 tool_use**: yield `turn_complete`, 投递 steering; 有 steering 则继续循环; 否则问持久目标是否续跑 — 有续跑 prompt 就注入为 user 消息继续循环; 都没有则做文件快照, `loop_complete`, fire-and-forget 触发 `onLoopComplete` (如后台记忆提取)

`finally` 块负责收尾: `turn_end`、`session_end` hook、恢复被升级的 maxOutput、结束遥测 (`endAgentTelemetry`)。

## 退出 Agent Loop

循环的退出条件有以下几种:

1. **LLM 决定退出**: 响应中没有 tool_use。但退出前还要过持久目标这一关 — goal 活跃且预算未耗尽时, `goalManager.continuation()` 生成续跑 prompt 注入为 user 消息, 循环继续而不是退出 (见 [goal](./goal))
2. **达到最大循环次数**: `maxIterations > 0` 时, 超过后 yield `error` 事件退出; 默认 0 不限制
3. **用户中断 (abortSignal)**: TS 用 `AbortController`, Go 侧用 `context.Context`。循环顶部、压缩后、流事件内、工具结果入历史后都有检查点; 中断时先持久化已产出的部分内容, 再 `loop_complete(interrupted)`
4. **持久目标预算耗尽**: goal 的 tokenBudget 用尽时, 循环顶部检查直接 `loop_complete(budget_limited)`, 目标状态转为 `budget_limited`, 等待用户显式 replace 新预算
5. **LLM 请求了不存在的工具**: 返回错误结果 `Error: unknown tool '<name>'` 反馈给 LLM 自纠, agent loop 继续运行; 被 `toolFilter` 过滤的工具同理, 以 `Tool '<name>' is not available to this agent.` 错误结果反馈
6. **ExitPlanMode / EnterPlanMode 工具执行成功**: 规划类工具成功即暂停循环等待用户, `loop_complete(end_turn)`; ExitPlanMode 成功后 UI 弹出 plan 审批对话框

其中 5 属于「不退出, 把错误交给 LLM 自己修」, 循环仍然存活。

## 错误自愈

一轮 stream 失败不等于整个 loop 失败, 有三种自愈路径:

- **ContextTooLongError (prompt too long)**: 立即 `forceCompact` 强制压缩上下文, `clearUsageAnchor` 后 `continue` 重试本轮
- **瞬态错误重试** (src/llm/retry.ts 的 `llmRetryDelay`): `RateLimitError` (429)、`ServerError` (5xx)、`NetworkError` 最多重试 `MAX_RETRIES = 3` 次
  - 等待时间: `RateLimitError` / `ServerError` 优先解析 `retry-after` 响应头 (支持秒数和 HTTP date 两种格式), 缺省时指数退避 (限流 5s 起步即 `RATE_LIMIT_BASE_DELAY_MS`, 其他 1s 起步即 `BACKOFF_BASE_DELAY_MS`), 上限 `MAX_DELAY_MS = 60s`
  - 等待是可中断的 `interruptibleSleep`, abortSignal 触发可提前唤醒
  - 每次重试发 `retry` 事件, reason 为 `rate limited` 或 `temporary provider failure`
  - **只在还没有可见输出时重试** (没有流式文本、没有 thinking、没有 tool_use): 有些 transport 无法撤回已流出的 chunk, 重放会产生重复内容; 已有可见输出时直接持久化已流出部分并报错
  - 成功一轮后重试计数 `transientRetries` 归零
- **其他错误**: 持久化已流出的部分文本后, yield `error` 事件, 退出循环

## max_tokens 恢复

LLM 输出被 max_output_tokens 截断 (stopReason = `max_tokens`) 且本轮没有 tool_use 时, 进入恢复流程:

1. **上限升级 (只做一次)**: 把 output 上限升到 `min(MAX_TOKENS_CEILING = 64000, contextWindow)`, 持久化部分输出并记录 usage anchor, 追加一条 user 消息 `MAX_TOKENS_RESUME_PROMPT`「Output token limit hit. Resume directly from where you stopped. Do not apologize or repeat previous content. Pick up mid-thought if needed.」, yield `retry("max_tokens escalation")`, `continue`
2. **多轮恢复**: 之后每次再命中 max_tokens, 追加恢复消息 `MAX_TOKENS_RECOVERY_PROMPT`「...Break remaining work into smaller pieces.」, yield `retry("max_tokens recovery N/3")`, 最多 `MAX_TOKENS_RECOVERIES = 3` 轮
3. **零输出轮原样重放**: 没有产出任何文本或 thinking 时不追加 user 消息, 直接重放 (避免破坏 user/assistant 角色交替)
4. **恢复耗尽后降级为正常结束**; 非 max_tokens 的轮次把恢复计数 `outputRecoveries` 归零

若被截断的轮里仍带了 tool_use, 这些调用的参数可能被截断, 循环会给它们打上 `MAX_TOKENS_TRUNCATED_ARGS_NOTICE` 标记, 以错误结果反馈让 LLM 重新完整发起调用。

## AgentEvent 事件流

agent loop 期间发射的事件都来自 src/agent/events.ts 定义的 `AgentEvent` 联合类型:

| 事件                 | 含义                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------ |
| `stream_text`        | LLM 流式输出的文本增量                                                                                       |
| `thinking_text`      | LLM 推理的文本增量                                                                                           |
| `thinking_complete`  | 完整的推理块, 包含 thinking 和 signature                                                                     |
| `tool_use`           | LLM 请求调用工具 (toolName, toolId, args)                                                                    |
| `tool_result`        | 工具调用结束 (toolName, toolId, output, contentBlocks?, isError, elapsed)                                    |
| `turn_complete`      | 一轮 LLM 调用 + 工具执行全部结束                                                                             |
| `loop_complete`      | 整个 agent loop 结束, stopReason 为 end_turn / interrupted / budget_limited (或透传 provider 的 stop reason) |
| `steering_delivered` | 用户在流式期间追加的消息被投递到对话历史                                                                     |
| `usage`              | token 用量更新                                                                                               |
| `compact`            | 上下文压缩完成 (携带 boundary, 供宿主持久化)                                                                 |
| `retry`              | 自动重试 (max_tokens 升级/恢复或限流等待, 携带 reason 和 delay)                                              |
| `error`              | 发生错误                                                                                                     |
| `permission_request` | 权限请求 (UI 弹对话框前的通知性事件)                                                                         |

UI 层只需从 `AgentEvent` 事件流中消费事件、据此更新界面, agent 与 UI 完全解耦。Go 用 channel、TS 用 AsyncGenerator (`async function*` + `yield`) 表达同一条流。ACP、A2A、remote、print 模式各自把 `AgentEvent` 翻译成自己的协议事件 (见 [acp](./acp) / [a2a](./a2a) / [remote](./remote) / [print-mode](./print-mode))。

## 状态机

LLM 响应后, 走向只有两种: 有 tool_use 就继续循环, 否则准备退出。

```ts
function classifyResponse(response: LLMResponse): "continue" | "terminal" {
  const toolUses = response.getToolUses();
  return toolUses.length > 0 ? "continue" : "terminal";
}
```

「准备退出」之后还要过 steering 和持久目标两道闸 (见上文退出条件), 才真正 `loop_complete`。

## Steering: 流式期间追加消息

agent loop 运行中 (LLM 正在流式输出或工具正在执行), 用户输入的新消息不会打断当前轮, 而是进入 steering 队列 (`Agent.steer`):

- 投递时机是 **turn 边界**: 工具结果入历史之后、下一次 LLM API 请求之前; 不在流式传输中途插入
- 每条 steering 作为一条 user 消息入历史并持久化, yield `steering_delivered` 事件
- LLM 响应没有 tool_use 但有排队的 steering 时, 循环继续而不是结束
- 投递前可以撤回 (`removeSteering`), 用于 UI 中编辑尚未投递的排队消息

## 执行工具

### 分批: partitionToolCalls

按工具的 `isConcurrencySafe` 分批 (分批逻辑在 agent 层, src/agent/index.ts 的 `partitionToolCalls`): 连续的并发安全调用合并为一个 parallel 批, 并发不安全的调用各自单独成批, 批次按 LLM 给出的顺序保持相邻。

安全性判定是 `tool.isConcurrencySafe?.(args) ?? tool.category === "read"`: 按本次实参判断 (Bash 的 `isConcurrencySafe` 是 `isSafeCommand(command)`, `ls` 可并发而 `rm` 必须独占), 未声明时 read 类工具默认并发安全; Agent 工具的 `isConcurrencySafe` 恒为 true, 主 agent 可以并行跑多个 subagent (工具接口和 category 见 [function-calling](./function-calling))。

```ts
/**
 * e.g. LLM returns [Read, Read, Edit, Read, Read]
 *
 * Batches:
 *   [Read, Read]   <- parallel 批, 并发执行
 *   [Edit]         <- 顺序批, 提交一个收集一个
 *   [Read, Read]
 */
```

### 执行前的逐层检查

每个工具调用在执行前依次过这些关卡:

1. **参数解析失败 (parseError)**: 短路为错误结果 `Error: <parseError>. The tool was not executed.`, 不执行
2. **abort**: 已中断时尚未执行的调用返回取消错误结果 (`Error: command interrupted` 或 `Tool execution was cancelled before it started.`), 保证每个 tool_use 都有配对的 tool_result
3. **toolFilter**: 本次 run 不可见的工具被拒绝, 返回 `Tool '<name>' is not available to this agent.`
4. **pre_tool_use hook**: reject 时返回 `Rejected by hook: <reason>` 错误结果
5. **权限检查**: `PermissionChecker.check` 给出 allow / ask / deny (见 [permission](./permission)); McpCall 会对目标 MCP 工具做第二次权限检查 (双重检查); ask 时经 `onPermissionRequest` 回调等用户决策, `allowAlways` 写入规则, deny 返回拒绝结果
6. **执行**: `tool.execute({ ...ctx, toolCallId }, args)`, 遥测包裹计时; 抛错被捕获为错误工具结果, 循环不中断

执行后 (`processToolResult`): ReadFile 的成功结果快照进压缩恢复状态 (`recoveryState.recordFileRead`), yield `tool_result` 事件, 触发 post_tool_use hook。

### StreamingExecutor

批内的执行由 `StreamingExecutor` (src/agent/streaming-executor.ts) 完成: parallel 批的所有调用先 `submit` 再并发执行, 哪个先完成就先 yield 哪个的 `tool_result` 事件 (UI 即时渲染, 不必等整批); 顺序批 submit 一个收集一个。

对话历史和会话日志仍按 LLM 给出的原始调用顺序写入 tool_result 块 (先收集进 Map, 再按 `toolUses` 顺序重组), 事件流的完成序和历史中的调用序互不影响。

大结果在入历史前做预算处理: 单个结果超过 `MAX_OUTPUT_CHARS = 50000` 字符就溢出到磁盘, 历史里只留预览加文件路径; 并行批的合计体积也由 `applyBudget` 统一兜底 (见 [context-compaction](./context-compaction))。

## System Prompt 与每轮注入

每轮 agent loop turn 都要带上 System Prompt。它由固定的 8 个模块拼接 (`buildSystemPrompt`, 见 [system-prompt](./system-prompt)), 包含身份设定、行为准则、工具使用指引、语气风格和一段环境信息 (工作目录、操作系统平台、git 状态、日期)。

模式相关的动态约束 (plan mode / coordinator mode) 和工具引导 **不** 放进 system prompt, 而是每轮注入 system-reminder: system prompt 是缓存前缀, 一旦改动会使整段 prompt cache 失效、重付成本; 放进可变的 reminder 里既保住了缓存, 又能在长会话中反复把模型拉回当前约束。

## Plan Mode: 只规划不做事

plan mode 通过每轮注入的 `buildPlanModeReminder` 约束 LLM 行为。它的权限矩阵与 default mode 不同 (见 [permission](./permission)): `modeDecide` 对 plan 模式返回「read 放行, 其余拒绝」, 再叠加一条前置守卫 — 非 read 类的调用除非命中例外, 一律以「Plan mode forbids mutations」拒绝。例外是:

- **plan 文件写入放行**: WriteFile / EditFile 指向当前 plan 文件 (`~/.yukino/plans/<slug>.md`) 时直接 allow, 不需要用户确认
- **plan 协调工具放行**: AskUserQuestion、EnterPlanMode、ExitPlanMode、Agent、Goal、TodoWrite、TaskStop、TeamCreate、TeamDelete 等 `PLAN_COORDINATION_TOOLS`
- **安全的只读命令放行**: `isSafeCommand` 判定的只读 Bash 命令

### 提醒策略

第 1 轮和之后每 5 轮 (`REMINDER_INTERVAL = 5`) 注入全文提醒 (只读约束、探索建议、plan 文件写法、审批规则), 其余轮次注入单行稀疏版「Plan mode still active.」; plan 文件已存在时提示先读再用 EditFile 增量编辑, 不存在时提示用 WriteFile 创建。

### 唯一出口: ExitPlanMode

plan 的唯一出口是 ExitPlanMode 工具: LLM 写完 plan 后调用 ExitPlanMode, 工具成功即结束本轮 loop, `loop_complete(end_turn)`, UI 弹出 plan 审批对话框 (选项: 进入 YOLO 自动批准 / 手动逐项批准编辑 / 反馈修改意见)。reminder 中明确约束「call ExitPlanMode for approval; never request approval through prose」, AskUserQuestion 也只允许用于澄清、不允许用于请求审批。
