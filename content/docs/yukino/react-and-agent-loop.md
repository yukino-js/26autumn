---
title: "ReAct and Agent Loop"
---

ReAct (Reasoning + Acting)

- Reasoning 解释为什么要做这一步 (text)
- Acting 选择调用一个工具 (tool_use)
- Observation (tool_result) 分析工具调用结果, 决定下一步怎么做

## ReAct 对比其他范式

- Chain-of-Thought 只推理, 不行动
- Act-only 只行动, 不推理
- ReAct 推理与行动交替
- Plan-then-execute 先生成完整计划, 再逐步执行

## Agent Loop

agent loop 是一个 `AsyncGenerator<AgentEvent>`: `Agent.run()` (src/agent/index.ts) 每消费一个 LLM API 流、每执行一批工具, 就 yield 事件给宿主 (UI / remote / ACP / A2A / print 模式都是同一份循环的宿主)

```js
async function* agentLoop(userMessage) {
  const messages = [...historyMessages, userMessage];
  while (true) {
    const response = streamLLM(systemPrompt, messages, toolSchemas);
    const toolUses = response.getToolUses();
    if (toolUses.length === 0) {
      return response;
    }
    messages.push({ role: "assistant", content: response.content });
    const results = [];
    for (const tu of toolUses) {
      const result = executeTool(tu);
      results.push(result);
    }
    messages.push({ role: "user", content: results });
  }
}
```

每轮 (iteration) 的完整流程:

1. abort 检查, 持久目标预算检查 (goal 的 status 是 budget_limited 时直接 loop_complete), maxIterations 检查 (默认 0 = 不限制)
2. 注入本轮的 system-reminder: 工具调用指南 (按当前可见工具集动态生成, 见 system-prompt)、持久目标提醒、plan 模式提醒、coordinator 提醒、延迟加载工具列表、hook 通知、外部通知 (teammate 邮件、后台任务完成通知)、skill 列表增量
3. 触发 turn_start 和 pre_send hook (输出立即补一次 drain, 本轮可见)
4. 自动上下文压缩检查 (manageContext, 见 context-compaction)
5. `client.stream()` 发起 LLM API 请求, 逐事件消费流: 文本增量累积、thinking 块收集、tool_use 收集、stream_end 记录 stopReason 和 usage
6. 错误自愈 (见下文)
7. max_tokens 处理 (见下文)
8. assistant 消息入历史并持久化到会话文件, 记录 usage anchor
9. 有 tool_use: 分批执行工具 (StreamingExecutor, 见下文) → 结果预算处理 (大结果溢出到磁盘) → tool_result 消息入历史并持久化 → turn_complete → 投递 steering
10. 无 tool_use: 投递 steering, 有 steering 则继续循环; 否则先问持久目标是否继续 (见 goal): 有续跑 prompt 则注入为 user 消息继续循环; 都没有则做文件快照, loop_complete, fire-and-forget 触发记忆提取等收尾回调

finally 块: turn_end、session_end hook、结束遥测

## 退出 Agent Loop

Yukino 的 agent loop 退出条件

1. LLM 决定退出循环: LLM API 响应中没有 tool_use, stop reason 是 end_turn (Anthropic); 退出前还要过持久目标这一关: goal 活跃且预算未耗尽时, goalManager.continuation() 生成续跑 prompt 注入为 user 消息, 循环继续而不是退出 (见 goal)
2. 设置最大循环次数 (maxIterations > 0), 超过后发 error 事件退出; 默认 0 不限制
3. 用户中断 (abortSignal): Go 使用 `context.Context`, TS 使用 `AbortController`; 循环顶部、压缩后、流事件内、工具结果入历史后都有检查点, 中断时先持久化已产出的部分内容, loop_complete 的 stopReason 是 interrupted
4. 持久目标预算耗尽: goal 的 tokenBudget 耗尽时, 循环顶部检查直接 loop_complete, stopReason 是 budget_limited, 目标状态转为 budget_limited, 等待用户显式 replace 新预算
5. 如果 LLM 请求调用的工具不存在, 返回错误结果 `Error: unknown tool '<name>'` 反馈给 LLM 自纠, agent loop 继续运行; 被 toolFilter 过滤的工具在执行前被拒绝, 同样以错误结果反馈
6. ExitPlanMode 工具执行成功: plan 模式的唯一出口, loop_complete(end_turn), UI 弹出 plan 审批对话框 (选项: YOLO 自动批准 / 手动逐项批准 / 反馈修改意见)

## 错误自愈

一轮 stream 失败不等于 loop 失败, 三种自愈路径:

- ContextTooLongError (prompt too long): 立即 forceCompact 强制压缩上下文, continue 重试本轮
- 瞬态错误重试 (src/llm/retry.ts): RateLimitError (429)、ServerError (5xx)、NetworkError (非 API 错误、流未正常终止) 最多重试 `MAX_RETRIES = 3` 次
  - 等待时间: RateLimitError / ServerError 优先解析 `retry-after` 响应头 (支持秒数和 HTTP date 两种格式), 缺省时指数退避 (限流 5s 起步, 其他 1s 起步), 上限 `MAX_DELAY_MS = 60s`
  - 等待是可中断的 sleep, 用户按 esc 可以提前唤醒; 每次重试发 `retry` 事件 (reason: rate limited / temporary provider failure)
  - 只在还没有可见输出时重试 (没有流式文本、没有 thinking、没有 tool_use): 有些 transport 无法撤回已流出的 chunk, 重放会产生重复内容; 已有可见输出时直接持久化已流出部分并报错
  - 成功一轮后重试计数归零
- 其他错误: 持久化已流出的部分文本后, yield error 事件, 退出循环

## max_tokens 恢复

LLM 输出被 max_output_tokens 截断 (stopReason = max_tokens) 时:

1. 上限升级 (只做一次): 把 output 上限升到 `min(MAX_TOKENS_CEILING = 64000, contextWindow)`, 持久化部分输出, 追加一条 user 消息「Output token limit hit. Resume directly from where you stopped. Do not apologize or repeat previous content...」, yield retry("max_tokens escalation"), continue
2. 多轮恢复: 之后每次命中 max_tokens, 追加恢复消息「...Break remaining work into smaller pieces.」, yield retry("max_tokens recovery N/3"), 最多 `MAX_TOKENS_RECOVERIES = 3` 轮
3. 零输出轮原样重放, 不追加 user 消息 (避免破坏 user/assistant 角色交替)
4. 恢复次数耗尽后降级为正常结束; 非 max_tokens 的轮次把恢复计数归零

## AgentEvent 事件流

agent loop 期间会发射大量事件 (src/agent/events.ts 的完整联合类型):

- stream_text: LLM 流式输出的文本增量
- thinking_text: LLM 推理的文本增量
- thinking_complete: 完整的推理块, 包含 thinking 和 signature
- tool_use: LLM 请求调用工具 (toolName, toolId, args)
- tool_result: 工具调用结束 (toolName, toolId, output, contentBlocks?, isError, elapsed)
- turn_complete: 一轮 LLM 调用结束 (LLM 请求调用工具 + CLI 工具调用结束)
- loop_complete: 整个 agent loop 结束, stopReason 是 end_turn、interrupted、budget_limited (或透传 provider 的 stop reason)
- steering_delivered: 用户在流式期间追加的消息被投递到对话历史
- usage: token 用量更新
- compact: 上下文压缩完成 (携带 boundary, 供宿主持久化)
- retry: 自动重试 (max_tokens 升级/恢复或限流等待, 携带 reason 和 delay)
- error: 发生错误
- permission_request: 权限请求 (UI 弹对话框前的通知性事件)

UI 层只需要从 AgentEvent 事件流中消费事件, 根据事件更新 UI, agent 和 UI 解耦; Go 使用 channel, TS 使用 AsyncGenerator (`async function* + yield`)

ACP、A2A、remote、print 模式各自把 AgentEvent 翻译为自己的协议事件 (见 acp / a2a / remote / print-mode)

## 状态机

LLM 响应后, 只有两种可能: 继续循环 / 退出循环

```js
function classifyResponse(response) {
  const toolUses = response.getToolUses();
  if (toolUses.length > 0) {
    return "continue";
  }
  return "terminal";
}
```

## Steering: 流式期间追加消息

agent loop 运行中 (LLM 正在流式输出或工具正在执行), 用户输入的新消息不会打断当前轮, 而是进入 steering 队列:

- 投递时机是 turn 边界: 工具结果入历史之后、下一次 LLM API 请求之前; 不在流式传输中途插入
- 每条 steering 作为一条 user 消息入历史并持久化, yield steering_delivered 事件
- LLM 响应没有 tool_use 但有排队的 steering 时, 循环继续而不是结束
- 投递前可以撤回 (removeSteering), 用于 UI 中编辑尚未投递的排队消息

## 执行工具

按工具的 isConcurrencySafe 分 batch (分批在 agent 层, src/agent/index.ts 的 partitionToolCalls): 连续的并发安全调用并为一个 parallel 批, 并发不安全的调用各自单独成批, 按 LLM 给出的顺序保持批次相邻性

安全性判定: `tool.isConcurrencySafe?.(args) ?? tool.category === "read"`, 即按本次实参判断 (Bash 的 isConcurrencySafe 是 isSafeCommand(command)), 未声明时 read 类工具默认并发安全; Agent 工具的 isConcurrencySafe 恒 true, 主 agent 可以并行跑多个 subagent

```js
/**
 * e.g. LLM returns [Read, Read, Edit, Read, Read]
 *
 * Batches:
 *   [Read, Read]   <- parallel 批, Promise.all 并发执行
 *   [Edit]         <- 顺序批, 提交一个收集一个
 *   [Read, Read]
 */
```

每个工具调用在执行前逐层检查:

1. 参数解析失败 (parseError): 短路为错误结果, 不执行
2. abort: 未启动的调用返回 "Tool execution was cancelled before it started."
3. toolFilter: 本次 run 不可见的工具被拒绝
4. pre_tool_use hook: reject 时返回 `Rejected by hook: <reason>` 错误结果
5. 权限检查: McpCall 会对目标 MCP 工具做第二次权限检查 (双重检查); ask 时经 onPermissionRequest 回调等用户决策, allowAlways 写入规则, deny 返回拒绝结果
6. 执行: `tool.execute({...ctx, toolCallId}, args)`, 遥测包裹计时; 抛错被捕获为错误工具结果, 循环不中断

执行后: ReadFile 的成功结果快照进压缩恢复状态 (recoveryState), yield tool_result 事件, 触发 post_tool_use hook

批内的执行由 StreamingExecutor (src/agent/streaming-executor.ts) 完成: parallel 批的所有调用先 submit 再并发执行, 哪个先完成就先 yield 哪个的 tool_result 事件 (UI 即时渲染, 不必等整批); 顺序批 submit 一个收集一个; 对话历史和会话日志仍按 LLM 给出的原始调用顺序写入 tool_result 块, 事件流的完成序和历史中的调用序互不影响

## System Prompt 与环境信息

每轮 agent loop turn 都需要发送 System Prompt 给 LLM API, System Prompt 包含用户信息、环境信息 (操作系统、工作目录) 和模式指令; 模式相关的动态约束 (plan mode / coordinator mode) 不放 system prompt, 而是每轮注入 system-reminder (保 prompt cache, 见 system-prompt)

## Plan Mode 只规划不做事

通过每轮注入的 reminder 约束 LLM 行为, plan mode 的权限矩阵和 default mode 相同: read=allow, write=ask, command=ask, 特殊的是 plan 文件 (`~/.yukino/plans/<slug>.md`) 的 write=allow, 不需要用户确认

plan mode 的提醒策略: 第 1 轮和之后每 5 轮注入全文 (只读约束、探索建议、plan 文件写法、审批规则), 其余轮次注入单行稀疏版; plan 文件已存在时提示用 EditFile 增量编辑, 不存在时提示用 WriteFile 创建

plan 的唯一出口是 ExitPlanMode 工具: LLM 写完 plan 后调用 ExitPlanMode, 工具成功即结束本轮 loop, UI 弹出 plan 审批对话框; reminder 中明确禁止用 prose 或 AskUserQuestion 请求审批
