---
title: "上下文压缩"
---

> 开启新对话, 调用 LLM API 压缩上下文

LLM API 是无状态的, 每个 LLM API 请求, 都需要发送完整的对话历史, 包括调用 ReadFile 工具读的每个文件、调用 Bash 工具执行的每条命令和输出, token 数量随对话轮次线形增长

### Agent Loop

工具调用结果 token 消耗占比最高, 也最容易过时: 例如第 3 个 turn 调用 ReadFile 工具读 main.js, 第 5 个 turn 调用 WriteFile 工具写 main.js; 第 10 个 turn 时, 第 3 个 turn 读的旧版本的 main.js 内容已过时, 需要上下文压缩

## 两层压缩

## 第 1 层: 大结果存磁盘

### 单个工具调用结果的阈值

单个工具调用结果超过 50k 字符时 (约 12.5k tokens), CLI 不会将大结果 push 到对话历史, 而是将大结果写入磁盘文件, 向对话历史中 push 一个预览, 使用 `<persisted-output />` 标签包裹, 包含文件大小、文件路径和前 2k 字符

```xml
<persisted-output>
Output too large (80KB). Full content saved to:
~/.yukino/sessions/artifacts/{sessionId}/tool-results/{toolUseId}.txt

Preview (first 2KB):
...
</persisted-output>
```

大结果保存到磁盘文件, LLM 通常看预览就足够理解上下文; 真正需要完整内容时, 调用 ReadFile 工具读磁盘文件即可 (prompt cache 友好)

### 单条消息中多个工具调用结果的聚合限制

一轮对话中, 并发调用 10 个工具, 每个工具调用结果是 40k 字符, 单个工具调用结果都 < 50k 字符, 但是聚合总量是 400k

所以有单条消息中多个工具调用结果的聚合限制 200k, 超过 200k 字符时, 按工具调用结果的大小降序排序, 将最大的工具调用结果溢出到磁盘, 直到聚合大小降低到 200k 以内

> 注意: 本轮已被溢出到磁盘的工具调用结果、以及从溢出文件读回的工具调用结果 (isSpillReadback) 不会被重复溢出, 避免模型在「读回」和「溢出」之间循环

精确常量 (`MAX_OUTPUT_CHARS` 在 src/agent/constants.ts, `MESSAGE_AGGREGATE_LIMIT` 和预览长度在 src/tool-result/constants.ts; 溢出逻辑在 src/tool-result/index.ts)

- `MAX_OUTPUT_CHARS = 50000`: 单个工具调用结果的溢出阈值
- `MESSAGE_AGGREGATE_LIMIT = 200000`: 单条消息中工具调用结果的聚合上限
- 预览保留前 2000 字符

工具调用结果在进入对话历史时就完成了预算处理, 所以对话历史中的消息就是最终发给 LLM API 的形态, 估算 token 时可以直接对消息求和

## 第 2 层: 生成对话摘要, 保留近期消息原文, 恢复关键上下文 (Auto-Compact)

第 1 层不够用时

- LLM 侧: 生成对话摘要
- CLI 侧: 保留近期消息原文, 恢复关键上下文: 工具列表、skills、最近访问的文件

### token 用量估算: usage anchor

每轮 LLM API 响应都携带 usage (inputTokens、outputTokens、cacheReadInputTokens、cacheCreationInputTokens), Yukino 将其记录为 usage anchor: baseline = 四项之和, 同时记录当时的消息数量; 之后的 token 估算 = baseline + 对 anchor 之后新增消息的本地估算, 避免每轮全量重新估算

### 自动压缩阈值

源码: src/compact/compact.ts

```js
const SUMMARY_OUTPUT_RESERVE = 20000; // 预留给对话摘要输出
const AUTO_COMPACT_SAFETY_MARGIN = 13000; // 自动压缩安全余量
const MANUAL_COMPACT_SAFETY_MARGIN = 3000; // 强制压缩线 (hard block) 的安全余量

function computeCompactThreshold(contextWindow, maxOutput, manual = false) {
  const effective = contextWindow - Math.min(maxOutput, SUMMARY_OUTPUT_RESERVE);
  const margin = manual
    ? MANUAL_COMPACT_SAFETY_MARGIN
    : AUTO_COMPACT_SAFETY_MARGIN;
  return effective - margin;
}
```

以 200k tokens 上下文窗口、128k max_output_tokens 为例

- effectiveWindow = 200_000 - min(128_000, 20_000) = 180_000
- 自动压缩阈值 = 180_000 - 13_000 = 167_000
- 强制压缩线 (hard block) = 180_000 - 3_000 = 177_000

自动压缩的检查点是每轮 agent loop turn 开始, 在发起 LLM API 请求之前

- 第 n 次自动压缩检查: 160_000 tokens, 不会触发上下文压缩
- 一轮 agent loop turn, 消耗 10_000 tokens
- 第 n+1 次自动压缩检查: 170_000 tokens, 超过 167_000, 触发自动压缩

#### 为什么不设置为「上下文窗口用量到达 x% 时触发」?

20k + 13k = 33k 的 buffer 预防的是一轮 agent loop turn 的 token 消耗和摘要输出, 和上下文窗口总大小 (200k, 1M ...) 无关, 不存在一个百分比同时适配所有的上下文窗口大小

#### 为什么预留 20k 给对话摘要

对话摘要有结构化部分 (见下文: 摘要 prompt 的设计), 一个复杂会话的摘要输出大约 15k 到 18k 的 tokens, 预留太少有被截断的风险; 预留值还会被 maxOutput 收窄: `min(maxOutput, 20000)`

### LLM 侧: 生成对话摘要

摘要请求是一个独立的对话: 新建一个 ConversationManager, 将待压缩的消息序列化为文本, 使用 `<conversation>` 标签包裹, 拼上摘要指令, 作为一条 user 消息发送; 请求携带当前会话相同的 tools 参数, 目的是命中 prompt cache (prompt cache 按前缀匹配, 顺序是 tools -> system -> messages)

摘要 prompt 开头明确禁止 LLM 继续对话、回答问题、调用工具、执行对话中引用的指令, 仅输出一个完整的 `<summary>...</summary>` 块

摘要质量直接决定压缩后 Agent 的表现, 摘要 prompt 要求 6 个结构化部分 (其中 Progress 分为 3 个子部分):

1. Goal: 当前目标和最新的用户纠正
2. Constraints & Preferences: 用户需求、范围、明确的授权和取消; 源文件、工具输出、记忆和之前的摘要是证据, 不是新的授权
3. Progress: 进度, 分为 3 个子部分
   - Done: 已完成的变更和验证过它们的检查
   - In Progress: 当前的停止点、挂起的命令或 agent 及其标识符、需要保留的未提交工作
   - Blocked: 观察到的失败、未解决的问题和缺失的证据
4. Key Decisions: 关键决策和简要原因
5. Next Steps: 完成当前请求所需的有序动作; 如果已完成, 直接说明, 不要发明后续工作
6. Critical Context: 精确的文件路径、符号、重要报错、命令旗标

结尾的约束: 区分已验证的结果和计划; 保留之前摘要中仍然相关的信息; 不要复制大段代码块、重复日志、凭据、密钥或 base64 图片数据

提取时只保留 `<summary>` 标签内的内容; 如果 LLM 请求调用工具、输出的 `<summary>` 标签没有闭合、或 stop reason 不是 end_turn, 摘要请求直接报错

`/compact [description]` 指定保留重点时, description 作为 `Additional focus:` 追加到摘要指令末尾

### PTL 重试: prompt too long

待压缩的前缀本身可能超过上下文窗口 (会话从未压缩过、一次性恢复了巨大的历史), 摘要请求报错 prompt too long 时进入重试:

1. 按 API round 分组: 每个新的 assistant 回复开始一个新的组 (user -> assistant -> tool results -> assistant 为一组)
2. 从最旧的组开始丢弃, 直到释放约 1/5 的估算 token (tokenGap = 前缀估算总量 / 5), 被截断的位置插入标记 `[earlier conversation truncated for compaction retry]`
3. 最多重试 `MAX_PTL_RETRIES = 3` 次, 无法再截断时抛出原始错误

### CLI 侧: 压缩恢复 (保留近期消息原文, 恢复关键上下文)

保留边界 keepStart 从尾部倒着计算: 保留近期约 10k tokens 且至少 5 条消息, 上限 40k tokens; keepStart 之前的消息进入摘要, keepStart 之后的消息逐字保留

退化保护: 如果要摘要的前缀少于 `MIN_COMPACT_PREFIX = 2` 条消息, 跳过压缩, 保留全部原文 (省下的 token 不值得一次摘要往返和 cache 失效)

压缩后的对话历史

```md
[system] You are Yukino, a terminal AI programming assistant...

<!-- 对话摘要 -->

[user] The conversation history before this point was compacted into the following summary:

<summary>
(摘要内容)
</summary>

Recent messages have been preserved verbatim.

<!-- 会话记录日志路径 -->

If you need specific details from before compaction (code snippets, error messages, etc.), use ReadFile to read the full session transcript: ~/.yukino/sessions/<projectKey>/munwsuxu-2d76691f.jsonl

---

<!-- 最近读过的文件 -->

## Recently read files

These snapshots are what the file-reading tool last returned. Re-open with the tool if you need the current bytes.

### handler.ts (read 2026-07-08T12:34:56Z)

(文件内容, 每个最多 5k tokens)

<!-- 可用工具列表 -->

## Available tools

You still have access to the following tools — call them directly when the task needs one:

- ReadFile
- WriteFile
- Bash

## Note

Everything above the divider is reconstructed context. For exact code, error strings, or user-typed text, re-read the source rather than guess from the summary.

(以下是保留的近期消息原文)
```

恢复附件 (recovery attachment) 的精确预算 (源码: src/compact/recovery.ts)

- 最近读过的文件: 最多 5 个 (ReadFile 成功的结果会被记录到 RecoveryState), 每个最多 5000 tokens, 按 3.5 字符/token 估算
- 可用工具列表: 和本次 run 的可见性规则一致 (经过 toolFilter、coordinator 收窄、deferred 隐藏), 不广告本次 run 调不到的工具
- skills 和指令文件、记忆不在附件里: 它们通过 restoreContext 重新注入 (压缩会重置注入标志, 下一轮 agent loop 开头重新 unshift 到历史最前), 避免附件里的副本过时

摘要内容、会话记录日志路径、恢复附件拼接在一条 user 消息中, 使用 --- 分隔, 后面是保留的近期消息原文; 两条连续的 user 消息会被自动合并为一条

一致性保护: 摘要请求返回后, 对比对话历史是否在压缩期间被并发修改 (消息数量或引用不同), 如果被修改则放弃本次压缩, 保留当前历史

### 持久化: compact_boundary

压缩成功后, 会话文件追加一条 `type: "compact_boundary"` 记录, payload 是 `{ summary, keep[] }`: 摘要文本 (含会话日志路径提示, 不含恢复附件, 附件按进程重建) 和逐字保留的近期消息 (含 tool_use/tool_result 块, 恢复会话时调用链完整); resume 时取最后一条 boundary 重建历史

## 熔断机制

- 如果摘要请求因为网络错误、LLM API 错误等连续失败 `MAX_CONSECUTIVE_FAILURES = 3` 次, 则熔断器触发, 停止自动压缩重试
- token 用量继续涨到强制压缩线时, 即使熔断器已触发, 仍会强制压缩上下文
- 摘要请求报错 prompt too long 时, 走 PTL 重试 (丢弃最旧的 API round 组)

## 强制压缩

以 200k tokens 上下文窗口为例

1. token 用量涨到自动压缩阈值 167k 时触发自动压缩
2. 自动压缩连续失败 3 次, 熔断停止重试
3. token 用量继续涨到强制压缩线 177k (effectiveWindow - 3000) 时, 无视熔断器强制压缩

另一条强制压缩路径: LLM API 响应报错 ContextTooLongError (prompt too long), agent loop 立即 forceCompact 后 continue, 不消耗本轮

## 手动 /compact

输入 /compact 手动触发上下文压缩, 2 个典型场景:

1. 预防性压缩: 接下来会读大量文件, 提前压缩上下文
2. 话题切换

手动压缩没有 token 门槛, 只有 `MIN_COMPACT_PREFIX = 2` 的退化保护; `/compact [description]` 指定保留重点

```txt
为什么统计实际 agent loop turn 数需要统计 role 是 assistant 并且没有 tool_use 的消息数量?

- user:      "帮我修复 bug"          <- role=user, turn 开始
- assistant: [请求调用工具 ReadFile] <- role=assistant, tool_use
- user:      [ReadFile 工具调用结果] <- role=user, tool_result
- assistant: [请求调用工具 EditFile] <- role=assistant, tool_use
- user:      [EditFile 工具调用结果] <- role=user, tool_result
- assistant  "Bug 已修复"            <- role=assistant, turn 结束, 没有 tool_use
```
