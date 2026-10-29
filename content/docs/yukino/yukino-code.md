---
title: "Yukino 源码解析: 终端 Coding Agent 的子系统机制"
description: "按 Agent 主循环与事件流、Provider 适配与重试、工具系统与 MCP 延迟加载、上下文压缩与恢复、检查点与 fork、长期记忆、subagents 与团队、coordinator 与持久 goal、权限、Hooks 与沙箱、运行模式与遥测等子系统, 深入论述 Yukino Code 内置核的实现思路与设计取舍, 并以三十一问的设计问答篇补充边界与取舍"
local_path: "$HOME/github/yukino-code/apps/yukino"
---

Yukino Code 是一个运行在终端里的 Coding Agent, 用 React + Ink 渲染 TUI, 通过可配置的 LLM Provider 驱动「模型到工具再回到模型」的自治循环。本文以它的内置核为对象, 按子系统逐一深潜: Agent 主循环如何把一轮推理拆成可中断、可恢复、可观测的事件流, 多种协议如何在同一接口下收敛, 工具与 MCP 如何在不破坏 prompt cache 的前提下进入上下文, 上下文满了如何压缩并在恢复时找回细节, 会话如何回退与派生, 记忆如何跨会话沉淀, 多代理又如何被组织成团队和长期目标。它不是接口手册, 也不逐文件走读, 而是解释每个机制为什么这样设计、代价是什么、在什么场景下成立。适合正在构建或维护 Agent 基础设施的工程师阅读, 也适合把它当作「把 Agent 做成产品级终端应用」的工程权衡参考。本文前半按子系统论述实现思路, 后半 (设计问答篇) 以问答形式补充取舍与边界。它的官方 MCP 工具集见 [yukino-mcp](../../fe/yukino-mcp), 把它作为库复用的全栈代码生成平台见 [yukino-codegen](../../fe/yukino-codegen)。

## 一、Agent 主循环与事件流

### 1.1 循环骨架

核心是 Agent 类的 run() 方法, 它返回一个 `AsyncGenerator<AgentEvent>`, 把整轮自治过程暴露成可订阅的事件流。这样宿主 (TUI、print、remote、ACP、A2A、teammate) 都能用同一套 `for await` 消费, 而不必各自复制循环逻辑。一次 run 的生命周期大致是:

1. restoreContext: 把项目指令、自动记忆、技能清单经会话管理器注入 (仅首次, 之后由压缩触发重注)。
2. 打文件检查点快照, 让本轮开始时的文件状态可回退。
3. goalManager.beginTurn 累计目标轮数与活跃时间, 触发 session_start 钩子。
4. 进入 while 循环。每轮先按当前工具面与工作目录重算 reminder, 再在需要时压缩上下文。
5. 发起流式请求, 处理文本、思考、工具调用、用量事件; 出现自愈信号时压缩或重试。
6. 有工具调用则分批执行, 执行结果先过溢出与聚合预算, 再写进历史; 无工具调用则检查 steering 队列与持久目标决定是否继续。
7. 收尾时打检查点快照、触发后台记忆提取、上报遥测, 并在 finally 里结算目标用时。

这个骨架的关键取舍是: 把「一轮」与「一次 run」分开。一轮是一次模型调用加可选的一批工具执行; 一次 run 可以包含许多轮 (ReAct) 或许多次续跑 (goal)。事件流里的 turn_complete 与 loop_complete 分别对应这两个层级, 宿主因此能区分「又走了一步」和「整个任务结束」。

### 1.2 每轮注入: reminder 通道而非系统提示词

系统提示词只包含与项目无关的产品定义, 由 PromptBuilder 按固定小节拼装 (身份、系统约定、任务执行、动作执行、工具使用、语气风格、输出效率、环境信息), 保持全局唯一副本, 以便跨项目命中同一份 prompt cache——环境小节里的 git 探测带 1500ms 超时, 分支名截断到 256 字符, 防止一个异常的仓库拖慢每次启动。项目指令、自动记忆、技能清单、逐工具使用指引、工作目录、plan 模式提醒、coordinator 指引、持久目标提醒、延迟工具清单, 全部改由 `<system-reminder>` 消息注入会话。原因写在多处的注释里: 系统提示词是缓存前缀, 一旦改动整段历史缓存失效; 而 reminder 本身就是对话内容, 只影响它之后的部分。

每轮的 reminder 注入有固定顺序: 工具指引 → 工作目录 → 持久目标 → plan 模式 → coordinator → 延迟工具指引, 然后排空钩子通知、外部通知与技能增量, 再触发 turn_start 与 pre_send 钩子。几个细节:

- 工具指引不是静态文本, 而是按当前可见工具面逐轮生成 (buildToolGuidance): 有文件工具就提示优先用文件工具而非 shell, 有 ReadFile 就提示 offset/limit 语义, 有 shell 工具、待办、目标、LSP、WebFetch、Workflow、Agent 委派时各自附上使用规则。为了让 reminder 不无限堆积, 会话管理器提供 addSystemReminderIfChanged: 只有与历史中同 marker 的最新一条内容不同才写新消息; 若工具面清空且历史里仍有旧清单, 还会补写一条「当前无可调用工具」兜底, 防止模型沿用过期工具名。
- 工作目录 reminder 用 `<working-directory>` 做 marker, 内容是当前 cwd、可选的 worktree 分支、一句「本条取代更早的工作目录信息」以及新目录下的项目指令。它只在两种情况下刷新: 会话正运行在 worktree 里, 或历史中已经出现过该 marker——普通会话的 cwd 不会中途变化, 没必要每轮重复。
- plan 模式与 coordinator 提醒按 REMINDER_INTERVAL=5 的节奏给全文: 第 1、6、11… 轮注入完整版, 其余轮注入精简版。约束类文本每轮全文重复既烧 token 又稀释注意力, 周期性全文重述则足以对抗「长会话里初始约束被淹没」。

这套设计把「持续约束」从「加大系统提示词」改为「周期性、内容感知、缓存友好的重述」。

### 1.3 流式事件的翻译与半成品处理

Provider 层的 stream 输出事件包括 text_delta、thinking_delta、thinking_complete、redacted_thinking_complete、tool_call_start、tool_call_delta、tool_call_complete、stream_end。主循环把它们翻译成对外的 stream_text、thinking_text、thinking_complete、tool_use、usage 事件。几个防御性设计值得注意:

- 流必须以 stream_end 收尾。若循环结束却没有收到完成事件, 直接抛 LLMError, 半成品工具调用不会进入历史。
- redacted_thinking 的处理。Anthropic 的安全系统偶尔会把思考块替换成加密数据返回, 协议要求原样回传。主循环收到 redacted_thinking_complete 后把它作为 `redacted_thinking` 块原样写进历史, 后续请求逐字回放, 但从不展示也不解析——它是密文, 展示与解析都没有意义, 丢弃或改写则会让请求非法。
- max_tokens 的恢复。模型若因输出上限停止且本轮没有工具调用, 先把请求级输出上限朝一个封顶值抬升 (上限为 `min(64000, contextWindow)`), 再把「从停止处继续」作为用户消息追加; 抬升只做一次, 其后再做多轮续写恢复 (最多 3 轮); 抬升的上限在 run 收尾时还原, 不改共享客户端的默认值。若恢复次数用尽仍以 max_tokens 结束, 则退化为正常结束; 截断发生在本轮已带工具调用时, 所有工具调用统一标上 parseError, 以错误结果退回而不执行——截断的实参不能拿去跑。
- 零输出的处理。若一轮既无文本、无思考、也无工具调用, 不写空 assistant 消息, 否则会破坏历史的角色交替, 让恢复出的会话非法。

### 1.4 自愈: 压缩与重试

模型调用可能抛出三类可自愈错误:

- ContextTooLongError: 调用 forceCompact 强制压缩, 清用量锚点, 重新注入上下文, 然后重试本轮。压缩后的新 boundary 由 Agent 自己先落会话日志, 再对外发布 compact 事件。
- 限流、服务端 5xx、网络错误: 走共享退避策略。这里有一条硬约束: 只在「本轮尚无可见输出」时重放。因为有些传输层无法撤回已经流出的 token, 一旦模型已经说出内容, 重放会造成重复。重试计数在成功进入下一阶段后清零。
- 网络与限流的分类在 Provider 层完成, 主循环只处理统一后的错误类型。

### 1.5 工具批次的并发判定与流式补全

一次模型回复里的多个工具调用先被分组成批次。并发安全不是只看工具类别, 而是按实参判断: 工具可提供自己的 isConcurrencySafe(args), 缺省回退到 category 是否为 read。源码注释举了直观例子: ls 和 rm 都是 Bash, 前者可与 ReadFile 并发, 后者必须独占。连续的安全调用并入同一并行批, 变更类调用与未知工具各自单独成批串行。

执行器是 StreamingExecutor。它按完成顺序 yield 结果 (先完成先上交, 不等整批), 主循环随即向宿主转发 tool_result 事件, 生成器关闭时在 finally 里等待所有已启动的执行。这样做让「并行批」既快又可观测, 同时保证不留悬挂任务。

多个工具调用的结果最终写回历史时, 会按模型原始调用顺序重排, 而不是完成顺序。这是为了满足工具消息与调用 id 的配对约束; 顺带也把「结果乱序」这一不确定性挡在了历史之外, 有利于 prompt cache。

权限与钩子的判定顺序是: pre_tool_use 钩子 (可 reject) → 权限检查 (deny / ask / allow) → 执行。ask 决定会与中断信号竞速, 中断即拒绝, 不悬挂等待。对经 McpCall 路由的调用, 外层工具与路由目标工具会被统一检查一次, 任一被拒整个调用被拒; post_tool_use 钩子则先按内层目标触发一次, 再按外层 McpCall 触发一次。另外, 只有成功且非富内容的 ReadFile 结果会被记入恢复快照, 保证恢复附件与模型当时实际看到的内容一致。

### 1.6 大结果溢出与聚合预算

工具结果进入历史前有两道规模控制:

- 单结果上限: 超过 50,000 字符的结果被写入会话产物目录, 历史上只保留 2,000 字符预览加文件路径。这种「落盘而不是截断」的做法避免丢失关键信息, 模型需要全文时可以再读回。
- 聚合预算: 一批并行结果落在同一条消息里, 单结果阈值管不住总和, 因此整批再按 200,000 字符做一次预算, 从最大的结果开始溢出直到回到上限内。

一个例外是读回流: 如果 ReadFile 读的正是溢出目录里的文件, 该结果豁免溢出, 否则模型刚读回的全文又被换成预览, 会在「读回」与「溢出」之间死循环。溢出目录按会话隔离; 没有 sessionId 的匿名对话会分配一个惰性匿名命名空间 (WeakMap 持有, 注册进退出清理), 跨 run 复用, 退出时清理, 且不产生可 resume 的会话文件。

## 二、Provider 适配与重试

### 2.1 三个协议收敛到同一接口

LLMClient 接口只暴露 stream 与 setSystemPrompt, 外加三个可选成员: 只读的 protocol 协议名、设置输出上限与运行时思考等级的能力接口 (都以 Partial 混入), 以及 getOutputBudget()——返回当前的输出上限与思考预算 (`{ maxOutputTokens, thinkingTokens }`), 供压缩等内部调用方了解「这次请求最多能产出多少」, 而不必复制各协议的预算推导逻辑。工厂按协议动态 import 对应实现, 因此只加载配置需要的 SDK。三个实现是 Anthropic 原生、OpenAI Responses、OpenAI 兼容 (Chat Completions)。工具 schema 也按协议导出三套形态。

三套实现共享同一套内部事件模型, 这是「同一内核适配多协议」的关键: Provider 只负责把各自 wire 格式翻译成统一的流事件, 主循环不感知协议差异。差异被压到少数地方: 输出上限字段不同 (Anthropic 用 max_tokens, Responses 用 max_output_tokens, Chat Completions 用 max_completion_tokens), 工具调用增量的组装方式不同, 思考内容的字段名不同 (Responses 是 reasoning summary 事件, Chat Completions 是非标准的 reasoning_content)。Responses 还会记录 providerItemId, 以便在多轮里正确回放推理项。配置未声明窗口与输出上限时有兜底默认值: 上下文窗口 1,000,000、最大输出 128,000。

### 2.2 思考强度的逻辑等级与映射

思考强度是一个跨 Provider 的抽象, 用七个逻辑等级 (off、minimal、low、medium、high、xhigh、max) 表达, 默认 high, 各等级对应固定 token 预算 (minimal 1024、low 2048、medium 8192、high 16384、xhigh 32768、max 65536)。能力判定不靠模型名猜测, 而是用显式的元数据: 是否支持 reasoning, 以及可选的逐等级映射表 (某等级可重映射或置 null 禁用)。off 永远关闭思考。

落地上各协议不同: Anthropic 在自适应模式下下发 `thinking: { type: "adaptive" }` 加 `output_config.effort`, 默认走 budget_tokens (预算与输出上限共享, 必须同时满足最小思考预算 1024 与最小回答空间 1024, 装不下时可用等级只剩关闭); OpenAI Responses 用 reasoning.effort 加 summary; 兼容协议用 reasoning_effort。收敛规则是「只降不升」: 不支持的请求被钳制到最近的可用等级。openai 系列原样透传全部七个等级 (包括 xhigh 与 max), 仅当 thinking_level_map 显式映射或置 null 时才改变; Anthropic 自适应模式把 minimal 抬到 low、把 xhigh 降到 high。运行时可以通过命令切换等级并持久化, 子代理启动时继承父代理当前生效等级。

### 2.3 缓存前缀与工具编排

Prompt cache 在本项目里是一等约束。工具数组在请求中位于系统提示词之后、消息之前, 因此工具面的任何变化都会让其后整段历史缓存失效。源码注释给了一个量化的实测: 两万 token 的历史里, 往工具数组尾部追加一个工具, 缓存命中率从 99.4% 跌到 9.5%, 等于整段重算。由此派生出多条设计: 系统提示词保持项目无关; 工具按协议导出但顺序稳定; MCP 加载模式一旦决定, 不在每轮重算; 每条工具消息一旦进入历史便不再修改。

在 Anthropic 协议上还有两处缓存优化: 对工具与消息内容加 ephemeral 的 cache_control 断点——工具断点落在最后一个非延迟工具上 (defer_loading 与 cache_control 同时出现在一个工具上会被 API 拒绝整个请求), 尾部用户消息断点优先落在最后一个非图像块上 (部分网关拒绝对图像块打点); 延迟加载用 beta 头 `advanced-tool-use-2025-11-20` 加 defer_loading。二者都只在需要时发送。MCP 的三种加载模式正是这一约束的直接产物 (见 3.3)。

### 2.4 错误分类与退避

Provider 层把传输层异常归类为统一的错误类型: 网络与用户中止归为 NetworkError, 429 归为带 Retry-After 的 RateLimitError, 408 与 5xx 归为带 Retry-After 的 ServerError, 已是统一错误类型的直接透传。上下文超限的识别同时覆盖 Anthropic 的「prompt is too long」与 OpenAI 系的 context_length_exceeded / maximum context length 措辞, 这样不同网关都能被同一段自愈逻辑接住。

退避策略集中在 retry 模块: 最多重试三次, Retry-After 优先 (支持秒数与 HTTP 日期两种形式, 并封顶), 否则按指数回退; 限流的基数比服务端与网络错误更大。是否重放由主循环的「本轮无可见输出」条件决定, 重试模块只负责算延迟与可中断等待。

## 三、工具系统与 MCP 延迟加载

### 3.1 Tool 契约与注册表所有权

工具统一实现一个接口: 名称、描述、类别 (read / write / command)、可选的按实参并发安全判定、可选的延迟标记、schema、execute, 以及可选的 dispose 用于释放资源 (典型是 LSP 子进程)。注册表区分两种登记方式以划分资源所有权: register 表示本注册表拥有该工具, registerBorrowed 只挂引用不接管所有权。这个区分支撑了代理派生: 子代理的克隆注册表只拥有被重新实例化的作用域工具, 继承的父级工具都是借用, 因此子代理退出时不会断开父级的 LSP 或 MCP 资源。反向的所有权转移也有显式入口: takeOwnershipFrom(source) 把源注册表里同名工具的所有权整体接过来自行管理, 供 /mcp 重载这类「新实例接管旧资源」的场景使用; unregister 会同时清掉该工具的已发现状态, 重载后模型需要重新经 ToolSearch 发现它。

dispose 是幂等的, 只对自有工具执行释放, 并把聚合失败以 AggregateError 抛出; 已注销或被替换的工具仍留在自有集合里一并清理。向已 dispose 的注册表注册工具会直接报错, 避免资源泄漏被静默吞掉。

### 3.2 工具面与调用指引

工具指引由 reminder 逐轮生成 (见 1.2)。除逐工具规则外, 还要处理「可见但不可调用」的情况: 延迟工具在被发现前不在工具数组里, 只出现在延迟指引中; dispatch 模式下还要引导模型经统一入口调用, 且延迟清单里不列 MCP 工具名 (除非入口工具 McpCall 可用)。延迟工具名列表按字典序排序, 不是为了好看, 而是为了让「工具面是否变化」的比较稳定——顺序抖动会导致同样的工具集生成不同文本, 进而误判为变化。

### 3.3 MCP 三种加载模式

MCP 工具默认延迟加载, 但具体怎么进入上下文分三种模式, 在 MCP 连接后决定一次 (交互式界面在切换 Provider 时重新决定):

- eager: MCP 工具 schema 总量不足上下文窗口的 10% (DEFAULT_EAGER_THRESHOLD_PERCENT), 全部直接进工具数组, 不做延迟。省下的上下文不值得承担额外风险。
- native: 官方 Anthropic 端点 (baseUrl 为空或指向 api.anthropic.com) 且协议为 anthropic。工具留在数组里但标记 defer_loading, 由服务端决定是否展示; ToolSearch 返回 tool_reference 让服务端展开 schema。这需要 beta 头。
- dispatch: 其他端点 (国内厂商、各类代理网关) 既不支持 defer_loading 也不支持 tool_reference, 于是模拟: MCP 工具完全不进工具数组, 统一经一个入口工具调用。

模式判定的输入是 MCP schema 的字符数、上下文窗口、协议与端点是否官方。估算用「字符除以 2.5」的经验比率, 因为 MCP schema 是符号密集的 JSON, 每 token 字符数低于对话估算用的 3.5。是否暴露 ToolSearch 与 McpCall 也在这一次决定后固化。模式可用配置项 mcp_loading 强制覆盖, 但强制 native 仅在 Anthropic 协议下有效, 否则降级为 dispatch——否则 OpenAI 协议客户端会丢掉 tool_reference 又隐藏入口工具, 使所有延迟工具不可达。

### 3.4 工具名消歧与参数归一

MCP 工具全名形如 `mcp__<服务器>__<工具>`, 两段各经 sanitizeSegment 清洗: 只保留字母、数字与下划线, 其余字符 (含连字符) 一律替换为下划线。源码注释解释了为什么连字符也要替换: Go 与 Python 实现做同样的清洗, 同一份 mcp_servers 配置必须在所有语言实现里产出相同的工具名, 否则同一份权限规则换个语言就失配。

经统一入口 McpCall 调用时, 权限规则的匹配目标不是某个参数, 而是 `服务器__工具` 形式 (传入全名会剥掉 mcp__ 前缀), 因此既能按服务器管控, 也能按具体工具管控。参数会先按目标工具的完整 schema 逐层归一 (coerceBySchema): 字符串与数字按全匹配模式互转、"true"/"false" 转布尔、单键对象解包进数组、逗号分隔字符串拆成数组、对象与数组递归处理, `__proto__` 这类危险键用 defineProperty 写入而不是直接赋值; 修不动的值原样透传, 让服务器自己报错而不是在本地猜。

ToolSearch 是延迟工具的发现入口: query 以 `select:` 开头时按名字精确取回, 否则做关键词搜索, max_results 钳制在 1..50 (默认 5)。发现的本地工具会被 markDiscovered 进入工具数组; MCP 工具在 native 模式下额外以 tool_reference 内容块返回, 交给服务端展开。

### 3.5 委派工具面的多层过滤

代理派生时工具面按固定顺序多层过滤: MCP 工具豁免全局限制但仍受角色级黑白名单约束; 一组主线程专属工具被移除——Workflow、物理设备 ComputerUse、单例对话框 AskUserQuestion、计划模式入口 EnterPlanMode 与出口 ExitPlanMode、持久目标 Goal, 再加上委派策略限制的递归派生 Agent 与团队权限类 TeamCreate/TeamDelete/SendMessage; 后台代理再套一层允许白名单; 最后应用角色定义的黑名单与白名单交集 (`tools: ["*"]` 可关掉白名单层)。plan 模式派生的 teammate 例外保留 ExitPlanMode, 但被重绑到「向团队提交计划」。

过滤不是简单复制引用: 本地任务工具被重绑到全新的私有任务列表, 工具搜索与统一入口重绑到新注册表, 技能加载换成惰性宿主, 任务停止换成「只能停自己任务」的限定版。这样普通子代理与 fork 拥有独立、初始为空的进度清单, 既不会与父代理共享进度, 也不会误动团队共享板。

## 四、上下文压缩与恢复

### 4.1 两条阈值与熔断

压缩不是按固定比例触发, 而是按 token 预算公式:

```text
effectiveWindow = contextWindow - min(maxOutput, SUMMARY_OUTPUT_RESERVE=20000)
自动压缩阈值     = effectiveWindow - 自动安全边际
强制压缩阈值     = effectiveWindow - 手动安全边际   # 硬阻塞线
```

两条安全边际名义上是 13,000 (自动) 与 3,000 (手动), 但都按有效窗口的比例封顶 (自动 25%、手动 10%)——小窗口模型上固定边际会吃掉过大比例, 比例封顶让阈值随窗口缩放。effectiveWindow 先为下一次回答的摘要输出预留空间; 自动阈值留更大安全边际, 强制阈值是硬线, 越过即压缩。连续压缩失败 3 次 (MAX_CONSECUTIVE_FAILURES) 后熔断自动压缩, 除非已经越过硬线——避免在一个持续失败的状态里反复付出昂贵调用。带上下文的模型自愈路径 (ContextTooLongError) 走强制压缩, 不受熔断限制。

### 4.2 锚点式 token 估算

每轮结束用 API 返回的真实用量打锚点: 记录当时的输入、缓存读、缓存写与输出总和, 以及消息数。之后只对锚点之后新增的消息做字符估算 (按每 token 3.5 字符), 而不是每轮重新估算整个转录。冷启动 (尚无锚点) 才全量字符估算。图像块按 7,000 字符当量 (IMAGE_CHAR_EQUIV) 计入, 否则图像密集的会话会系统性低估、压缩触发过晚。这个「锚点加增量」的设计让压缩判断既便宜又不会随轮数漂移。

### 4.3 保留尾部与配对完整

压缩不是把整段历史折成摘要, 而是保留尾部原文、只摘要更早的前缀。保留边界的确定从尾部往前走, 累积 token, 满足两个「足够」下限之一即停 (至少保留 KEEP_RECENT_TOKENS=10,000 token, 或至少保留 MIN_KEEP_MESSAGES=5 条消息), 并且不超过 KEEP_MAX_TOKENS=40,000 的上限; 最近一条消息即使自身超上限也始终保留。随后有一个关键的配对修正: 若边界落在一个承载工具结果的用户消息上, 就往前退到发起该调用的助手消息, 保证工具调用与结果不被拆开。若待摘要前缀不足 MIN_COMPACT_PREFIX=2 条, 压缩直接跳过——省下的 token 不值得一次摘要往返与缓存失效。

### 4.4 摘要生成的三条路径

摘要请求经 LLMStreamOptions 的 answerReserveTokens 声明「这次要为回答预留 16,000 token」(SUMMARY_ANSWER_RESERVE_TOKENS), Provider 结合 getOutputBudget 把输出上限与思考预算调到相应位置, 避免摘要写到一半被输出上限掐断。摘要有三条路径, 优先级递减:

1. 缓存共享路径: 保留原消息列表不做序列化, 只把摘要指令作为最后一条用户消息追加, 于是请求前缀与主对话最后一次调用一致, 从而命中 prompt cache。
2. 上下文超限重试路径: 若摘要请求本身超限, 把前缀序列化成文本 (图像块压成占位符), 按「API 轮次」分组从头部丢弃 1/5 (PTL_TRUNCATE_DIVISOR) 后重试, 最多 3 次 (MAX_PTL_RETRIES), 每次重试留下标记提示模型前文已被截断。
3. 瞬态重试: 限流、服务端、网络类失败按共享退避重试, 每次用全新缓冲区, 不拼接半成品文本。

摘要流必须收到完成事件且 stopReason 正常, 否则判失败并保留原历史。结果需抽出 `<summary>` 块; 模型若自发输出 `<analysis>` 块则剥掉; 标签未闭合或结果为空都算失败。摘要生成期间若主对话被并发修改 (steering 注入、其他压缩), 结果按 COMPACTION_CONVERSATION_CHANGED_ERROR 丢弃——基于过期前缀的摘要会静默丢掉新消息。这套「宁可保留原历史也不要坏摘要」的取向, 与压缩本身是为了安全推进上下文的目标一致。

### 4.5 压缩后的消息形态与恢复附件

压缩后历史被替换为「一条摘要用户消息加保留的尾部」。摘要消息里带一句提示: 需要压缩前的细节可以用文件读取工具读完整会话转录。除此之外还附一个恢复附件, 避免模型忘记刚读过的内容:

- 最近读过的文件快照 (最多 RECOVERY_FILE_LIMIT=5 个文件, 每文件 5,000 token 上限, 超限截断);
- 当前仍可用的工具名列表 (与工具面导出共用同一可见性判定, 保证附件里说能调的工具确实能调);
- 一条说明: 以上是重建的上下文, 需要精确内容请重读源码而不是从摘要猜。

恢复附件只进对话, 不进 boundary: Agent 在发布 compact 事件之前先把 boundary 落进会话日志, 持久化的是不含附件的版本, 恢复时附件按当时的文件快照重新生成。被激活的技能 SOP 不走这个附件, 而是压缩后由循环重新注入项目指令、记忆与技能——因为它们本就由同一套注入路径管理。

### 4.6 与 resume 的衔接

压缩产生一个 boundary, 内含摘要与保留的尾部 (含工具块与思考块)。持有 sessionId 的 Agent 在发布 compact 事件之前先把 boundary 追加进会话日志; 宿主层不再重复持久化。恢复时, 若会话里有至少一个有效 boundary, 就取最后一个有效的, 重建「摘要加它的内联尾部, 再加 boundary 之后的普通消息」; boundary 之前的原始消息仍在文件里但不再回放。若没有 boundary, 就全量回放。损坏的 boundary 会回退到上一个有效 boundary, 而不是丢弃全部历史。

把保留尾部直接内联进 boundary 记录, 是为了避免恢复时还要去 boundary 之前的区域搜索这些消息——读到 boundary 就足以重建, 这让恢复逻辑不依赖对历史布局的假设。

## 五、检查点、Rewind 与 Conversation Fork

### 5.1 文件快照的三态与基线

文件检查点按会话持久化 (状态文件带 PERSISTED_STATE_VERSION 版本号), 所有读改写都包在一把跨进程文件锁里, 并且在锁内先重读磁盘状态再修改, 所以同会话目录里的多个进程 (主会话、teammate、remote) 也能安全共享。状态写入用带进程号的临时文件加原子重命名。

每条文件备份是三态判别: 文件存在则备份原内容, 文件不存在记 absent, 读取失败记 unavailable。rewind 时 absent 条目删除当前文件, unavailable 条目跳过不动。除了每条快照, 还有一份「首次追踪前的基线」: 文件首次被编辑前登记追踪并捕获一次原始内容。这样 rewind 可以安全跨越「某文件开始被追踪」的那一刻——早于目标快照才开始追踪的文件, 按其基线恢复 (原本存在则还原, 原本不存在则删除)。

快照的序号是单调递增且不回退的 (nextSnapshotSeq 永不复用), 修剪会把快照数组截到 MAX_SNAPSHOTS=100, 数组位置会被复用, 如果备份文件用数组位置命名就会覆盖仍存活的备份, 所以单独维护这个计数器。每轮无工具收尾时打一次快照, 记录当时的对话长度、用户文本摘要, 以及会话日志的行数 (sessionLineCount)——后者是 /rewind 精确截断会话文件的权威坐标, 因为它不像内存消息下标那样会被恢复与压缩改变。

### 5.2 三种回退

Rewind 提供三种粒度: 同时恢复文件与截断对话、只截断对话、只恢复文件。截断对话会清用量锚点; 截到零时重置「长期记忆是否已注入」标记, 使下一轮重新注入。会话文件的截断同样在文件锁内用临时文件加原子替换完成, 异常路径也会清理临时文件。rewind 之后快照历史被截断 (不能前进), 被移除快照的备份文件一并删除。

### 5.3 Conversation Fork: 快照继承而非对话树

这里的 fork 指派生一个继承当前对话快照的子代理, 不是把会话分叉成两个可切换的对话树; 真正的「回到过去」由 rewind 承担 (截断式, 不可前进)。fork 用深拷贝得到独立副本, 连同「长期记忆是否已注入」「用量锚点」一起复制, 好处是子代理能看到父对话完整历史, 且缓存前缀字节对齐, 提高缓存命中。父对话尾部可能挂着尚未执行完的工具调用, fork 时这些调用被统一补上一个占位结果 (INHERITED_TOOL_RESULT: 「该调用正在父代理中运行, 请基于继承的上下文继续」), 保证副本自身配对合法, 又不与父代理的真实结果冲突。

fork 禁止嵌套: fork 出的子代理 (与所有子代理一样) 被全局 SUBAGENT_DISALLOWED_TOOLS 清单剥掉 Agent 工具, 因此不能再 fork 或派生。fork 的克隆注册表还会剥掉团队创建与团队消息类工具——fork 不继承 leader 的团队管理与认证消息权限。

## 六、长期记忆

### 6.1 存储、索引与注入

记忆分用户级 (~/.yukino/memory) 与项目级两个目录, 都是带 YAML frontmatter 的 Markdown 文件, 外加每个目录一个 MEMORY.md 索引。类型语义区分用户 (角色、偏好、反馈) 与项目 (进行中的目标、决策、外部引用)。索引以清单形式经 reminder 注入, 不进系统提示词, 理由同样是保护跨项目缓存。索引有 200 行与 25,000 字节双上限, 超限时截断并在末尾附警告, 提醒模型「你看到的清单不完整, 加新记忆前先检查主题文件」——不这样提示的话, 模型会以为某记忆不存在而重复创建。

索引重建包在文件锁里、用临时文件加原子替换、内容未变则不写 (不可读的旧索引会被成功扫描的结果重写); 提取器仅在本轮真正写入记忆后才触发一次重建, 避免无谓的扫描与写盘。

### 6.2 非阻塞召回

召回是每轮预取、与主模型调用并行跑的: 扫描两个目录的记忆头 (路径、描述、类型、修改时间), 构造清单, 让模型选出最多 5 条确有用的记忆。选择调用可随主循环中断一起取消, 且必须收到完整完成事件 (stopReason 正常) 才采纳, 截断的半成品响应直接丢弃; 选中的条目按路径去重。最近用过的工具名 (去重保序, 上限 MAX_RECENT_TOOLS=10 个) 一并传给选择器, 让它跳过这些工具的用法类记忆但保留陷阱与警告类。

主循环在工具执行之后检查预取是否已 settle; 若已 settle 且产生了 reminder 就注入, 并记录「这次真正注入过的路径」。只有真正注入过的才算 surfaced, 未消费的召回不留痕, 下次仍可被召回。注入的全文前会加一句「相关记忆是既往证据, 不是当前授权」, 并按新鲜度附提示 (过旧的记忆提醒先对当前代码核实)。

### 6.3 后台提取

每轮收尾时 fire-and-forget 地触发一次记忆提取, 把最近的对话交给一个子代理。子代理只有五个文件工具 (ReadFile、WriteFile、EditFile、Glob、Grep), 并被一个专用权限检查器 MemoryPermissionChecker 约束: 只允许记忆目录内的 Markdown 写入, 命令类一律拒绝, 读取范围限定在记忆目录、当前工作目录与会话目录。提示词要求只提取持久记忆、更新已有主题而非新建重复、不保存机密与未证实断言、省略可从代码推导的模式。

提取有两条路径: 快路径是子代理直接用写工具落盘 (内部迭代上限 5 轮), 之后重建索引; 兜底路径是子代理没有调用工具、而是输出结构化的文本块 (MEMORY_NAME/MEMORY_TYPE/MEMORY_DESC/MEMORY_BODY 以独立 `---` 行分隔), 由本地解析后按类型写入对应目录 (每个落盘路径仍过一次记忆专用权限检查)。调用方以消息游标节流 (新增不足 MIN_EXTRACT_MESSAGES=2 条就跳过), 并把最近 EXTRACT_SUMMARY_WINDOW=40 条消息拼成摘要传入; 提取器内部用「进行中加待处理上下文」合并并发请求, 当前跑完再补跑一次最新的, 异常统一抛出由调用方记录。

### 6.4 后台记忆整合

记忆整合 (MemoryConsolidator) 满足门槛后后台 fork 一个子代理做: 合并重复、剔除过期、消解矛盾、维护索引。门槛包括: 距上次成功整合至少 DEFAULT_MIN_HOURS=24 小时 (取自时间记录锁文件的 mtime)、自上次以来新增会话数至少 DEFAULT_MIN_SESSIONS=5、扫描节流 SCAN_THROTTLE_MS=10 分钟, 以及一把非阻塞执行锁 (tryAcquireFileSyncLock, 拿不到就放弃本轮, 避免多进程重复整合)。执行锁与时间记录锁是分开的: 后者只用来记录上次成功时间。

整合子代理同样只拿五个文件工具加记忆专用权限检查器, 迭代上限 CONSOLIDATION_MAX_ITERATIONS=15, 可随主进程中断, dispose 时等待其结束; 成功后更新记录锁并注入一条「记忆已改进」的 reminder。整合按四阶段执行: 定向 (扫目录、读索引与相关主题, 避免重复)、取证 (对疑似漂移核对当前证据, 窄范围搜索转录而不是整文件读)、整合 (把相关事实并入带 frontmatter 的主题文件, 用户与反馈类留在用户记忆, 项目与引用类留在项目记忆, 在源头纠正被证伪的说法, 但「时间久」本身不足以证伪)、修剪与索引 (索引保持在行数与字节上限内, 单条指针有长度建议, 超长细节挪进主题文件)。

### 6.5 指令文件的发现与拼接

项目指令 (AGENTS.md) 按优先级拼接: 先用户全局指令文件 ~/.yukino/AGENTS.md, 再从 git 根到当前目录的每一级目录里的 AGENTS.md, 每段带「Contents of 相对路径:」标签、以 `---` 分隔, 越靠后优先级越高 (模型更关注后出现的内容); 同一路径出现多次按绝对路径去重。发现 git 根时把 `.git` 当作目录或文件都接受, 以兼容链接式 worktree。这个函数同时服务两处: 会话首次 restoreContext 的注入, 以及工作目录 reminder (见 1.2) 在 cwd 变化后的指令重挂。注意它与用户消息里的 `@路径` 引用是两套机制: 后者由 at-refs 展开器处理, 把引用文件内容内联进用户消息 (见 10.1)。

## 七、Subagents 与 Agent Team

### 7.1 角色与调用参数

内置角色有四个: general-purpose (研究与多步任务, 无限制)、plan (只读架构师: 调研并给实现计划, 禁 EditFile/WriteFile/ExitPlanMode, 权限模式 plan 且 readOnly)、explore (只读探索者: 找代码、追调用路径、给 file:line 证据, 限制与 plan 相同)、review (代码审查: 只禁 EditFile/WriteFile/ExitPlanMode, 不声明 readOnly 与权限模式——审查需要跑测试与命令, 只是不许改文件)。自定义角色从 ~/.yukino/agents 目录的 Markdown 文件加载并可覆盖同名内置角色, frontmatter 支持工具白名单与黑名单、系统提示词覆盖、最大轮数 max_turns、模型、后台默认、worktree 隔离等; 未写 description 时取正文前 200 字符兜底; 角色级权限模式 permission_mode 接受四种取值 (default、acceptEdits、plan、bypassPermissions), 派生时传入子代理的检查器。

派生入口是 Agent 工具, 必填 description 与 prompt, 其余参数: kind (subagent 或 teammate, 默认 teammate)、subagent_type (默认 general-purpose)、fork (是否复制父对话, 默认取会话的 enable_fork 设置, 未设置时为 true)、model 覆盖、run_in_background (默认 false)、worktree 隔离。kind 的语义写在参数描述里: teammate 是当前团队里的持久成员 (没有团队时自动创建), 适合需要通信与后续派活的场景; subagent 是一次性任务, 结果作为工具结果返回, 不可消息、不可续用。Agent 工具的并发安全判定恒为真: 多个前台委派可在同一批里并发执行, 因为子代理各自有独立会话与注册表; 但提示词要求避免并发写同一批文件, 隔离 worktree 也不自动合并。

### 7.2 前台与后台

前台调用阻塞并把结果内联返回。后台调用立即返回任务 ID, 完成后由父循环的下一轮把任务通知排空成 reminder; 可用任务查看工具查询或等待一次, 也可用任务停止工具中止。任务 ID 由进程级全局计数器分配 (形如 `agent-3`; shell 类任务用 bash-/ps- 前缀), 跨管理器唯一。后台代理的工具面额外套一层允许白名单, 与主线程能力区分。

后台任务记录持久化到会话目录下的 background-tasks JSON 文件 (每任务一个, 临时文件加原子重命名写入); 恢复时 running 状态的任务被标记为 failed 并附「会话恢复前被中断」说明, notified 标志防止重复通知。后台任务失败时, 若运行器抛出带「已格式化输出」的失败对象 (TaskFailure), 其输出被原样保留 (例如被杀的后台 shell 的捕获输出与退出事实), 普通错误才包成通用错误文本; 取消后的迟到结果丢弃, 但已格式化的失败输出仍被采纳。这个细节让「任务被取消」与「任务失败」在用户可见层面不丢证据。等待接口有 60 秒上限并在超时、中断与完成之间竞速; 排空通知后按 MAX_RETAINED_FINISHED_TASKS=200 修剪已完成记录; 仍有挂起任务时清空管理器直接报错。

### 7.3 上下文继承与工具面过滤

子代理的上下文策略按参数区分:

- fork=true: 继承父会话的完整快照 (含记忆注入标记与用量锚点, 未决工具调用补占位结果, 见 5.3)。
- fork=false: 全新会话, 只注入角色说明作为 reminder 加用户提示, 即自包含上下文, 不继承父历史。

运行参数上, 模型按「调用级覆盖大于定义级大于父代理」优先; 思考强度继承父代理当前生效等级; 上下文窗口与输出上限沿用父代理同一 Provider 的配置; 系统提示词取角色覆盖或默认构建。权限上, 调用方传入父检查器时子代理经 forSubagent 派生: 派生检查器持有独立的模式状态与一条父级引用, 按 9.1 的继承规则实时解析有效模式。迭代上限取角色定义的 maxTurns, 未声明时为 0, 表示不限制——上限是角色作者的选择, 不是全局默认值。

退出路径统一: 先停掉并等待该子代理自己的后台 shell 任务 (不允许后台 shell 比子代理活得久), 再释放其作用域注册表; 完成、失败、中断、迭代耗尽都走同一个 finally。fork 路径的克隆注册表由 fork 调用方释放, 且只释放自有工具, 不连累父级 LSP/MCP。

### 7.4 团队模型与进程内 teammate

团队同时最多一个: 显式的 TeamCreate 先调用 deleteAll() 清掉所有其他团队 (内存对象加磁盘残留目录) 再创建; create 本身在已有团队时直接返回现有团队。生成 teammate 的路径是 Agent 工具的 kind=teammate (默认值): 取团队列表的第一个, 一个都没有就以 leader 身份自动创建 (名字形如 `team-<uuid>`)。成员名总是由 description 派生: 空白折叠成连字符、转小写、清洗非法字符、截到 MAX_TEAMMATE_NAME_CHARS=30, 与 leader 名或现有成员重名时追加 `-2`、`-3` 后缀; 已完全回收的终态成员名字可复用。

teammate **一律进程内运行**: `Team.spawnTeammate` 接收一个 `runAgent` 回调 (由 `teamRunAgentFactory` 用 teammate 作用域的注册表与权限检查器构造), 在同一进程的事件循环里跑子代理主循环, 派生成功的回执明确标注 `(in-process)`。没有 tmux/iTerm/独立子进程那套外部 backend。进程内 teammate 共享事件循环, 因此进度 UI 能实时更新; 中止经 AbortController 直接传到成员的主循环, `stopMember` 会等成员当前循环真正停下。

派生时有一条容易被忽略的角色替换: 内置 plan 角色作为 teammate 派生时, 定义被换成 PLAN_TEAMMATE_AGENT——只保留 permissionMode plan, 去掉 readOnly 与工具黑名单。原因是 plan teammate 的使命是「先出计划、批准后执行」, 需要保留 ExitPlanMode (重绑为向团队提交计划) 与批准后的完整工具面; 而一次性 plan 子代理是纯只读调研, 从头到尾不该写。判定条件是角色名为 plan (自定义同名角色同样触发), teammatePermissionMode 相应固定为 plan。检查器随后打三个标记: teammate=true、readOnly 取角色声明、requiresLeaderPlanApproval 取团队配置。

成员之间仍用**文件邮箱**通信 (见 7.5), 团队状态也持久化到磁盘的团队文件: 这既让 `SendMessage` 能按名字解析投递 (成员名注册进一个进程级全局名字注册表), 也让团队在崩溃恢复后仍有据可查。需要 worktree 隔离的成员会拿到自己的 worktree 目录作为 `memberCwd` (worktree 路径记进成员元数据, 变更不自动合并, 由 leader 或用户手动合), 但仍在进程内运行。派生失败的每条路径都会 removeMember 加 dispose 掉刚建的注册表, 不留半截成员。

### 7.5 文件邮箱与共享任务板

成员之间用文件邮箱通信: 每个收件人一个 JSON 数组文件, 所有读改写都在跨进程文件锁内完成, 写入用临时文件加原子替换。已读消息按 MAX_READ_MESSAGES=500 修剪, 未读永不丢弃。消息目标支持广播通配 `*` (BROADCAST_TARGET)。结构化消息 (关停请求与响应、计划审批请求与响应) 带 requestId 关联请求与响应, 随机生成以避免跨进程计数器冲突; approve 用可选字段区分「未响应」与「明确拒绝」——沉默从不被当作同意。

邮箱消费有一个易错点被显式处理: 等待「某一条特定消息」时 (空闲轮询间隔 500ms), 期间到达的其他消息不能丢, 而是重新入队为未读。leader 排空邮箱时把未读格式化成带团队标签的通知文本; 成员状态与任务的回收发生在 teammate 自己的收尾 finally 里 (未完成任务重置为待办并清空负责人、注销名字注册表), 随后才发出终态 idle 通知。终态成员记录按 MAX_RETAINED_TERMINATED_MEMBERS=200 保留供查询。

共享任务板是每团队一个 JSON 文件, 任务是包含 id、主题、状态、负责人、依赖、优先级、元数据的统一模型。所有变更都在跨进程锁内 reload、克隆、操作、校验依赖、保存, 任一步失败整体回滚且不落盘。teammate 的认领在同一把锁内完成: 已有他人负责人直接拒绝, teammate 不能把任务指派给别人 (只有 leader 能), 置为进行中会自动把负责人写成自己, 已完成或已取消的任务不能直接重开, 未解决依赖被拒 (只有完成算解决), 且一个成员不能同时有两个进行中任务。成员退出或失联时, 其未完成任务被批量重置为待办并清空负责人 (releaseOwner), 保证任务不悬空。

### 7.6 plan-mode teammate 的审批流

需要计划审批的 teammate 以 plan 模式派生, 只能读 (豁免面限于团队协调工具、计划协调工具、安全只读命令与自己的计划文件写)。它的一轮结束时经 ExitPlanMode 提交计划: 计划审批请求 (带计划全文与 requestId) 先进 leader 邮箱留档可见。审批路径按团队是否处于 coordinator 模式分叉: 非 coordinator 模式下由运行时**自动批准**——不经 leader 或人工审核, 一条关联的审批回执写回同一邮箱, 成员的权限模式切到团队当前模式 (团队自身处于 plan 时退回 default), 并以「计划已自动批准, 在当前工具权限内开始执行」作为下一轮提示; coordinator 模式下 requiresLeaderPlanApproval 为真, teammate 进入阻塞轮询等待 leader 经 SendMessage (type 为 plan_approval_response) 回复 approve 与实质性反馈, leader 拒绝时 teammate 收到修订指令、停留在 plan 模式并重新提交, 批准后才切换权限模式继续执行——在等待与驳回期间, 模式解析器有一条专门规则 (见 9.1) 把它钉在 plan, 即使父级已升到 acceptEdits。批准通过不豁免后续工具调用, 每次调用仍走完整权限管线。一次性只读角色 (plan/explore 子代理, readOnly 为真) 不进入这条链路, 全程保持只读。

这条链路也解释了为什么「无人值守的 teammate 没有自己的审批通道」: 团队内的协调工具 (发消息与任务板) 在权限检查器层被直接豁免, 不会落到会被自动拒绝的 ask; 但显式 deny 或 ask 规则仍优先。teammate 遇到真正需要审批的操作 (如写目录之外) 时, 请求会路由回 leader 侧的同一个权限对话框, 且中断时把正在呈现与排队中的请求一并拒绝, 保证子代理的等待不悬挂。

## 八、Coordinator 模式与持久 Goal

### 8.1 按上下文成本切工具的 coordinator

Coordinator 模式把 leader 的工具面收窄为纯编排白名单: Workflow、Goal、Agent、SendMessage、TaskStop、SyntheticOutput、TeamDelete、TodoWrite。分界线不是读与写, 而是「会不会往 leader 上下文灌大量内容」。leader 的上下文要装任务分解、成员状态与消息历史; 一旦它能读文件或跑命令, 模型就会自己去查代码, 几千行涌进来后编排空间就没了。因此文件读取、搜索与命令类被排除, 要看代码就委派 teammate 带回结论; MCP 也被排除, 抓网页与查数据库同样会瞬间灌满上下文。TeamCreate 有意不在白名单里: teammate 派生路径会自动建团队 (见 7.4), leader 不需要显式建团的权力。

启用与否只看配置, 不看当前是否有团队: 中途切换会在历史里留下无法撤回的旧编排指令, 模型的约束认知会混乱。指引经 reminder 注入 (完整版在第 1、6、11… 轮, 其余轮给精简版), 同样是为了不动系统提示词的缓存前缀。

### 8.2 持久 goal 的状态机

目标是一个会话级的持久状态机, 驱动 Agent 在模型不再调工具时自动续跑。每次变更以一条 goal_state 记录追加进会话日志, 构造时回放最后一条有效记录, 因此跨恢复与跨进程存活。状态包括目标文本 (上限 MAX_OBJECTIVE_CHARS=4,000)、六态状态、可选的 token 预算、已用 token、已执行轮数、活跃用时与阻塞审计字段。

用户侧命令负责设定与生命周期迁移: 设定并立即以一条「朝这个目标工作」的提示触发运行; 可设预算; 未完成目标的替换必须显式声明, 否则报错; 暂停、恢复、完成各有约束 (例如只有暂停、阻塞或轮数上限的目标能恢复, 预算耗尽只能显式替换)。模型侧工具只能读取, 或报告完成与阻塞; 设定与替换目标永远是用户权限, 工具描述里明确写出这一点。委托代理拿不到目标能力 (Goal 在主线程专属工具集里), 调用会直接报错。

### 8.3 终止闸门与预算总结轮

续跑有四个终止闸门: 轮数达到 MAX_GOAL_TURNS=150 后转「轮数上限」态; 同一阻塞原因在连续续跑轮各记一次, 连续 MAX_BLOCKED_ATTEMPTS=3 轮同一阻塞才转「阻塞」态 (同轮重复调用只计一次); 预算耗尽转「预算受限」态; 用户暂停、完成或清除。区分「困难与部分进展」和「真正的阻塞」是这套审计的核心, 否则模型会把慢当成停。

预算耗尽不是直接掐断: 循环会尝试给模型一次「无工具总结轮」, 让它把已完成的工作、剩余事项与关键结论写下来。总结轮的准入条件是不在总结中、非 plan 模式、目标仍应续跑且 steering 队列为空; 满足则以一个特殊轮运行——工具过滤器恒为 false, 跳过上下文管理与延迟工具指引, 请求 maxRetries 为 0, 模型若仍尝试调工具, 调用被标 parseError 并附「目标预算已耗尽」提示。条件不满足 (比如用户正在插话) 则退而求其次: 把 goalManager.format() 的状态文本作为 stream_text 直接发给宿主, 再以 stopReason 为 budget_limited 的 loop_complete 收尾。两条路都保证预算终止时用户拿到的是一段可读的交代, 而不是无声停摆。

续跑只在无工具收尾时发生, 且 plan 模式下不续跑 (只读调研不应自动推进变更); 若宿主还在排空排队中的后续消息, 也不续跑, 避免与用户输入抢方向。plan 模式有三条入口: 用户通过 Shift+Tab 循环权限模式进入 (default → acceptEdits → bypassPermissions → plan, 终端与浏览器 UI 一致); 模型通过 EnterPlanMode 工具主动进入 (仅交互式宿主注册该工具, print/ACP/A2A 等非交互宿主不注册; 且仅主代理可用, 委派代理与 teammate 调用直接被拒); teammate 以名为 plan 的角色派生 (见 7.4)。权限模式配置与启动参数不接受 plan 作为初始模式, 但运行时可以切入。

## 九、权限、Hooks 与沙箱

### 9.1 四种模式与共享模式状态

权限有四种模式: 全放行 (bypassPermissions); plan (读放行, 其余一律拒绝); acceptEdits (命令询问, 读写放行); default (读放行, 写与命令询问)。主会话的检查器是模式源头: 换工作目录派生的检查器 (forCwd/forWorktree) 共享同一个模式状态对象, 模式变化双向实时可见; 子代理派生 (forSubagent) 则持有独立的模式状态加一条父级引用, 按继承规则实时解析有效模式。此外还有一个只读标志 (readOnly): 置位后检查器的有效模式恒为 plan, 无视模式状态与父级放行, 用于只读角色 (内置的 plan 与 explore 角色均声明 readOnly), 该标志随 forCwd 克隆传递。

有效模式的解析是一段固定顺序的 getter, 继承规则不对称:

1. readOnly 置位 → plan, 优先级最高。
2. 无父级 (主会话) → 自身模式状态。
3. teammate 且 requiresLeaderPlanApproval 且自身处于 plan → plan: 等待计划审批的成员不被父级升权带走。
4. 父级为 bypassPermissions **或自身声明为 bypassPermissions** → bypassPermissions。注意这是双向的: 角色声明的全放行会被尊重, 而不是被父级压回——委派一个「可信自动化角色」时, 父级在 default 模式也不该成为它的天花板。
5. 父级为 acceptEdits → acceptEdits: 父级放宽编辑, 子代理跟随, 否则用户刚批准的自动编辑会在每个子代理里重新弹询问。
6. 其余 → 自身模式状态, 未设置时 default。

子代理的模式切换只作用于本地, 不写回父级, 也不影响兄弟。模式变化可通过 `subscribeMode` 订阅通知外部 (团队据此把 leader 的模式同步进团队配置并持久化)。

### 9.2 分层检查

检查按固定层次推进, 前面的层级能短路后面的:

1. plan 模式闸门: 生效时非读类别一律拒绝, 除非命中后续豁免层。
2. 显式规则: deny 与 ask 直接短路; 显式 allow 故意不短路, 让后面的危险命令与路径检查仍有机会优先生效。
3. 计划协调工具豁免: 提问、进入/退出计划模式、委派、目标、任务追踪、TaskStop、团队创建与删除、发消息这组工具在 plan 模式下仍可用——它们是「讨论与组织计划」的一部分, 不是执行。
4. teammate 协调豁免: 无人值守成员的 SendMessage 与 TodoWrite 直接放行。
5. plan 模式计划文件写例外 (WriteFile 与 EditFile 指向已声明的计划文件)。
6. 安全只读命令自动放行 (SAFE_PREFIXES 命令白名单加元字符防护——命令串里出现管道、重定向等 shell 元字符即不适用)。
7. 危险命令拦截 (DANGEROUS_PATTERNS 当前为空集, 这一层处于休眠, 属于预留位)。
8. 空命令询问: Bash/PowerShell 的 command 为空时返回 ask——空命令没有可供规则匹配的内容, 自动放行等于开了一个绕过口。
9. 不完整解析询问: shell 解析器判定命令语法不完整 (如未闭合的引号) 且非全放行模式时返回 ask——解析不了的命令无法逐段核对, 交给用户裁决。
10. 沙箱自动放行: 仅对启用了 OS 沙箱的 Bash, 且复合命令按分隔符拆开后逐段查规则, 任一段 deny 则 deny、任一段 ask 则 ask, 防命令链绕过。
11. 路径沙箱: 只有写类工具且带路径时检查, 读类豁免; 出界询问, 但显式 allow 可覆盖。
12. 规则引擎: 显式 allow 在此生效, 按工具名与内容 glob 匹配, deny 优先于 ask 优先于 allow。
13. 模式矩阵: 按模式与工具类别给最终决定。

这套层次把「安全默认」和「可控豁免」分开: 大多数危险路径由后面的模式矩阵兜底询问, 而少量明确安全或明确授权的情形由前层放行; 8、9 两层则体现同一个原则的反面——无法被规则理解的输入, 宁可升级为人审。

### 9.3 规则文件与路径沙箱

规则是用户级与项目级两份 YAML, 每条形如 `Tool(pattern)` 配 allow / deny / ask。缓存以修改时间纳秒加文件大小作为变化判据——只看时间戳粒度可能不够, 只看大小则重写可能保持同尺寸。显式 allow 支持「总是允许」持久化: 文件路径规则写成父目录加通配, 命令规则写成前一两词加通配, 写入在文件锁内用临时文件加原子替换。

路径沙箱的基线是项目根与系统临时目录 (用 os.tmpdir() 取而不是硬编码 `/tmp`, 因为各平台路径不同)。路径先解析工具路径展开与规范化, 再判断是否落在允许根内。

### 9.4 Hooks

钩子事件覆盖九个时机: session_start、session_end、turn_start、turn_end、pre_send、post_receive、pre_tool_use、post_tool_use、shutdown。动作有四类: shell 命令 (POSIX 用 bash, Windows 用平台默认 shell; 超时 HOOK_TIMEOUT_MS=30 秒、输出缓冲上限 10MB, 事件名、工具名、文件路径经 YUKINO_EVENT/YUKINO_TOOL/YUKINO_FILE_PATH 注入环境)、提示文本注入、HTTP 请求 (默认 POST, GET/HEAD 不带 body, 非 2xx 抛错), 以及 agent 类型。agent 类型虽然有实现分支, 但校验层直接拒绝该配置 ("not supported yet"), 因为没有宿主注册 agent 运行器, 接受配置只会把失败推迟到运行时并被默认的错误策略吞掉。

钩子支持条件表达式 (用 new Function 以 event/tool/filePath/message/args 为参数编译求值)、仅 pre_tool_use 可 reject (且一次 reject 会跳过该事件剩余的钩子)、once (以 id 或序号为键, 执行前占位、成功后本会话不再触发, 失败则释放槽位以便重试)、async (后台执行, 结果经通知队列注入), 以及 on_error 策略 (ignore 默认、fail、reject)。reject 与 async 互斥 (校验层强制), 因为异步结果无法同步拦截。钩子产物经通知队列在下一轮排空成 reminder; 例外是 turn_start 与 pre_send 的输出在钩子触发后立即排空并持久化, 保证它作用的正是它所准备的那次请求。

### 9.5 OS 沙箱与安全边界

OS 沙箱在 macOS 用 Seatbelt (sandbox-exec)、Linux 用 bubblewrap, 其他平台返回 null 不可用; 配置是允许写目录、拒绝写目录 (拒绝优先) 与是否放行网络。接缝统一收敛到一个配置函数 (configureBashSandbox): 给 Bash 工具装上沙箱与沙箱配置, 并同步权限检查器的 sandboxEnabled 与 sandboxAutoAllow 开关。沙箱开启时可让非危险命令免确认 (对应 9.2 第 10 层), 但复合命令仍逐段查规则。沙箱声明为必需而平台不可用时按 fail closed 处理。

其余安全边界包括:

- WebSocket 升级 (remote/acp-ws 模式): 每进程随机令牌 (randomBytes(32) 的 base64url 形式) 挂在 URL 查询参数上, 校验顺序是路径不匹配回 404、令牌恒时比较 (timingSafeEqual, 先比长度) 失败回 401、携带 Origin 时必须与 Host 同源且为 http 协议否则 403; 拒绝时向 socket 写一条裸 HTTP 响应后关闭。
- 公网抓取 (用于安装技能, utils/public-http): 只允许 http/https、拒绝带凭据的 URL、DNS 解析取全部应答且每个都必须是公网地址 (BlockList 挡内网/回环/链路本地等子网)、逐跳重定向重新校验 (有次数上限)、最终把连接钉在已验证的地址上发起——解析与连接分离会给 DNS rebinding 留窗口, 钉地址是标准防御。仅支持无 body 的 GET/HEAD, 使注入的 fetcher 与钉地址实现行为一致。
- reminder 边界防伪造: 外部内容 (工具输出、引用文本) 注入 reminder 前, 把形如 `<system-reminder` 的左尖括号转义为 `&lt;`, 防止内容伪造 reminder 边界冒充系统指令。
- 遥测负载递归洗消 (见 10.5)。

## 十、运行模式、资源所有权与遥测

### 10.1 六种模式复用同一内核

同一个 Agent 内核被多种宿主复用: TUI 交互、print 非交互 (支持流式 JSON 输出)、remote 浏览器 (Express 加 WebSocket)、teammate 成员 (进程内)、ACP 与 A2A 协议服务端。CLI 语法收敛在 src/cli.ts 的 parseCliArgs——注释称其为「CLI 语法的唯一所有者」: 互斥关系 (服务端模式与 -p、--resume 不能共存)、`-p --` 分隔符、默认端口 (remote 127.0.0.1:18888、acp-ws 18889、a2a 18890) 都在这一处裁决, 解析结果是一个判别联合的 CliMode (help/version/update/print/remote/acp/acp-ws/a2a/ui)。help、version、update 三种维护模式不属于 RuntimeMode——运行时 chunk (原生依赖与配置加载) 只在真正需要时才被动态加载; 且 cli.ts 用 realpathSync 比对自身是否为进程入口, 只有作为入口时才执行分发, 被 import 时不产生副作用。main.tsx 的启动顺序是 hydrateConfigEnv() 先于 recover(): 配置文件里的 env 块可能携带遥测相关环境变量, 必须先灌进 process.env, 遥测初始化才读得到。

| 模式     | 触发方式                                      | 事件去向                              |
| -------- | --------------------------------------------- | ------------------------------------- |
| TUI      | 默认                                          | Ink/React 组件状态                    |
| print    | `-p`                                          | stdout, 支持文本或 stream-json        |
| remote   | `--remote`                                    | Express + WebSocket, 广播给浏览器前端 |
| teammate | Agent 工具 kind=teammate (默认值, 进程内派生) | 文件邮箱 / 进度通道                   |
| ACP      | `--acp` / `--acp-ws`                          | 转成 Agent Client Protocol 更新       |
| A2A      | `--a2a`                                       | 转成 Agent-to-Agent 消息              |

remote 浏览器 UI 与终端 UI 对齐: 流式回复与思考块、工具卡片实时输出、权限与提问对话框、计划审批、代码审查表单、会话选择器、运行中 steering 与后续排队、提示历史、`@file` 补全、`!`/`!!` 用户 Bash (内联输出上限 50KB/2000 行)、图片附件、todo 进度、Agents 面板、上下文用量、明暗主题, 以及 /model、/login、/thinking、Shift+Tab 权限模式循环、/rewind、/sandbox、/worktree、/mcp reload 等命令全部可在浏览器操作。用户消息里的 `@路径` 引用由 at-refs 展开器处理: 单条消息最多 MAX_AT_REFS=32 个引用、单文件内联上限 100,000 字节、总量上限 300,000 字节、支持 `#L` 行号区间; 图片转 base64 内容块并以 `<image>` 占位。各宿主共用工具注册表的统一构建入口 (createToolRegistry: 按交互模式决定任务追踪形态、有团队管理器时注册 TeamTodoWriteTool 否则 TodoWriteTool、EnterPlanMode 仅交互式注册)、沙箱接线、权限检查器与 TeamManager 接线, 差异集中在输入输出与生命周期管理上: print 模式退出前只等待 agent 类后台任务 (shell 类可能无限运行, 不等待以避免挂起), 再 stopAll 与 teamManager.dispose, 最后释放注册表与断开 MCP; A2A 的运行时惰性创建、空闲 30 分钟回收, 回收后再来的请求按持久化转录重建运行时, 空闲计时器在处理期间解除、处理完重新武装; ACP 给每轮一个独立的 AbortController, 权限请求与取消信号竞速。

### 10.2 退出清理与所有权

资源释放遵循「先排空共享工作, 再断开共享资源」: 先停后台任务与团队成员 (此时它们可能还在用注册表与 MCP), 再释放注册表与断开 MCP。注册表的所有权模型 (自有与借用) 保证子作用域释放时不会误断父级资源。

崩溃路径由 recover.ts 统一接管: crash.log 记录启动、退出、崩溃与「终端已消失」四类事件。终端设备消失 (EIO、EPIPE、ERR_STREAM_DESTROYED) 走安静退出——记录一次、跑清理、退出码 0, 这不是错误而是父终端关闭的正常信号。uncaughtException 与 unhandledRejection 的处理顺序是: 记录错误、写 fatal 日志、captureTelemetryError, 然后**先同步扫一遍退出清理注册表, 再异步 flush 遥测**, 最后 exit(1)。顺序很关键: process.exit() 不会等待异步清理, 若把杀子进程的清理排在遥测 flush 之后, flush 超时或被跳过时 detached 子进程就成了孤儿。同步清理注册表 (registerExitCleanup) 的使用方包括 MCP 客户端、匿名溢出目录、Bash/PowerShell 会话、computer-use、LSP 客户端与光标恢复。

后台任务管理器的生命周期也被收紧: runner 结束后取消闭包换成空操作, 仍有挂起任务时清空管理器直接报错, 防止「清了管理器却留下运行中的任务」; stopAll 循环到没有新的挂起任务为止。会话级后台 shell 的看门狗与输出观察器合并到同一个 tick, 用户直发命令的实时预览与体积上限共用这条旁路。

### 10.3 可观测性三支柱: OpenTelemetry、Sentry 与 Langfuse

yukino-code 的遥测子系统同时对接 OpenTelemetry、Sentry 与 Langfuse 三个后端。三者在可观测性光谱上的位置不同, 先讲清它们各自是什么、原理与设计思想如何, 才能理解本项目的埋点为什么长成这样。

**OpenTelemetry (OTel)** 是 CNCF 孵化的可观测性标准, 把链路追踪 (traces)、指标 (metrics)、日志 (logs) 三类信号的采集与导出统一到一套模型下。它的核心思想是**埋点与后端分离**: API 层只定义接口 (Tracer、Meter、Logger), 业务代码仅依赖 API; 具体采集行为由可插拔的 SDK 实现——SpanProcessor 决定 span 何时导出 (如 BatchSpanProcessor 批量异步导出以摊薄开销), Exporter 决定数据去哪里 (OTLP、console、Prometheus), 换后端不需要改一行埋点代码。追踪模型是一棵 span 树: 每个 span 带 trace id、span id 与父级引用, 描述一段工作的起止与嵌套; 指标分为 counter、histogram 等 instrument, 由 MeterProvider 进程内聚合, 再由 MetricReader 周期性推送或供 Prometheus 拉取; OTLP 协议为三类信号定义了统一的线格式, 可选 gRPC、HTTP/protobuf、HTTP/JSON 三种传输。它解决的问题是埋点的厂商锁定: 过去每家 APM 都有自己的私有 SDK, 换观测后端等于重新埋点; OTel 让一份埋点可以喂给任意多个兼容后端。etcd、Prometheus、Grafana 与 OpenTelemetry 的通用机制见[中间件与可观测性](../../be/middleware)。

**Sentry (@sentry/node)** 是应用错误监测平台的 Node SDK, 以「错误」而非「性能」为中心。`init()` 会安装一组 integrations (默认包含拦截未捕获异常与未处理 rejection、给内置模块打补丁收集上下文等), 捕获的异常经 `beforeSend` 钩子加工后按 DSN 发往 Sentry 服务, 由平台按指纹聚合成 issue, 做去重、归因、版本关联与告警; 事件可携带堆栈、tags、release 等上下文。SDK 自带完整的性能追踪能力 (由 `tracesSampleRate` 控制采样), 但 yukino-code 把它设为 0——性能与链路交给 OTel, Sentry 只承担错误通道。它解决的问题是生产环境的错误不可见、难复现、难归因: 没有错误平台, 终端应用的崩溃与异常只会消失在用户的终端里。

**Langfuse** 是开源的 LLM 工程可观测平台, 专注模型调用的成本、时延与质量分析。它的数据模型是 trace 加嵌套 observation, 提供 generation (一次模型调用: 模型名、token 用量、首 token 时间)、agent、tool 等语义类型——这些概念在通用 APM 里根本不存在。v5 的 `@langfuse/tracing` 直接构建在 OTel 之上: `startObservation` 创建的 observation 内部持有一个 OTel span, `LangfuseSpanProcessor` 作为标准 SpanProcessor 挂在 TracerProvider 上, 导出时把 span 翻译成 Langfuse 后端格式。这意味着 Langfuse 不是一条独立的埋点通道, 而是复用同一条 OTel 管线——未配置 Langfuse 时, 这些 span 照样作为标准 OTel span 从已配置的 exporter 导出。它解决的问题是传统 APM 不懂 token、模型与用量: LLM 应用需要按模型调用做成本与时延归因, 需要按会话回放整条 agent 轨迹。

三者在 yukino-code 中的分工:

| 后端          | 定位         | 承担职责                                                         |
| ------------- | ------------ | ---------------------------------------------------------------- |
| OpenTelemetry | 标准与管线   | 三类信号的统一埋点与扇出导出 (OTLP/console/Prometheus), 可自托管 |
| Sentry        | 错误平台     | 异常捕获、聚合与告警 (`tracesSampleRate` 为 0, 不做性能采样)     |
| Langfuse      | LLM 可观测性 | agent/generation/tool 观测树的语义分析、模型与 token 用量归因    |

### 10.4 统一遥测运行时: 一份埋点, 三路扇出

埋点层不直接接触三个 SDK。`src/telemetry` 定义了 `TelemetryRuntime` 接口——`startObservation`、`recordMetric`、`emitLog`、`captureError`、`setMode`、`flush`、`shutdown`——默认运行时是 noop 实现: 不配置任何后端时, 所有埋点调用都是空操作, 零开销。`shouldInitialize()` 检测到 `SENTRY_DSN`, 或 `OTEL_SDK_DISABLED` 不为 true 且配置了任一 OTEL exporter 或 Langfuse 密钥对时, `initializeTelemetry()` 才动态 import providers 模块组装真实运行时; 组装失败静默回退 noop。遥测永远不阻塞、不影响主流程。

观测模型只有三种 kind——agent、generation、tool, 与 Langfuse 的语义类型一一对应, 构成一棵三层观测树:

- Agent 循环开始时 `startAgentTelemetry` 创建根观测 `yukino.agent.run` (agent kind), 记 `yukino.agent.runs` 计数器; 会话 id 经 SHA-256 哈希取前 16 位十六进制作为 `session.hash` 上报, 原值不出进程。循环结束时 `endAgentTelemetry` 把 outcome (completed、interrupted、error 三态) 写入观测并收尾, 出错时观测标记为 ERROR 级别, 同时记录 `yukino.agent.duration` 直方图。
- `observeLlmStream` 把 LLM 流包成 generation 子观测 `yukino.llm.generate`: 首个非 stream_end 事件到达时记 `completionStartTime` 与 `yukino.llm.time_to_first_token` 直方图; `stream_end` 时把 `usageDetails` (input、output、cacheReadInput、cacheCreationInput) 与 stopReason 写入观测, 并按 token 类型拆分记录 `yukino.llm.tokens` 计数器 (只记大于 0 的项)。
- `observeToolExecution` 把每次工具调用包成 tool 子观测 `yukino.tool.execute`, 按结果的 `isError` 区分 completed 与 error。

这棵树经 `LangfuseSpanProcessor` 导出为 Langfuse 的 LLM trace, 同时作为标准 span 树走 OTLP 或 console exporter。指标统一 `yukino` 前缀: 除上述外还有 `yukino.llm.requests`、`yukino.llm.duration`、`yukino.tool.calls`、`yukino.tool.duration`, 直方图一律毫秒单位。日志走 OTel LoggerProvider, 共 `yukino.error`、`yukino.llm.error`、`yukino.tool.error` 三种。错误是双写的: `captureError` 既向 Sentry 发 `captureException` (带 context 与 mode 标签), 又发一条 `yukino.error` OTel 日志——没配 Sentry 时自建管线也看得到错误; `AbortError` 直接忽略, 用户中断不是错误。

三个后端的装配完全由环境变量驱动。`OTEL_TRACES_EXPORTER`、`OTEL_LOGS_EXPORTER`、`OTEL_METRICS_EXPORTER` 声明 exporter 列表 (console、otlp, 指标额外支持 prometheus 拉取模式), exporter 模块只在配置时才动态 import; OTLP 协议默认 `http/protobuf`, 可选 grpc 与 `http/json`, 三类信号可各自覆盖; 指标导出间隔默认 60 秒。Resource 的 `service.name` 固定为 yukino (`OTEL_SERVICE_NAME` 可覆盖), `OTEL_RESOURCE_ATTRIBUTES` 追加自定义键值。Langfuse 在 public 与 secret 密钥齐备时, 向同一个 TracerProvider 追加 `LangfuseSpanProcessor` (关闭媒体上传, release 取 `LANGFUSE_RELEASE` 或应用版本)。Sentry 在 `SENTRY_DSN` 存在时初始化: 关闭 `includeLocalVariables` 与 `sendDefaultPii`, 不注册 ESM loader 钩子, `skipOpenTelemetrySetup` 保持 OTel 独立, 并从默认 integrations 里移除 `OnUncaughtException` 与 `OnUnhandledRejection`——应用自己在 recover 入口装处理器 (见 10.2), 未捕获异常先 `captureTelemetryError` 再清理、flush 遥测后退出, 退出码与清理顺序由应用而非 SDK 掌控。每条信号线都被 `safely()` 包裹: traces 初始化失败不妨碍 metrics 与 Sentry 正常工作, 失败带标签记日志。

六种运行模式 (a2a、acp、print、remote、terminal、unknown) 经 `setTelemetryMode` 写入运行时, 所有指标与日志自动携带 `yukino.mode` 属性, Sentry 也设同名 tag——同一份观测数据可以按宿主形态切片分析。生命周期与进程退出绑定: `beforeExit` 触发 flush; remote 服务器额外安装 SIGINT 与 SIGTERM 处理器, 先执行业务清理 (后台任务、teammate、MCP 子进程) 并保留真实退出码 (SIGINT 130、SIGTERM 143), 再 shutdown 遥测后退出; flush 与 close 统一有 2 秒超时上限 (SHUTDOWN_TIMEOUT_MS), 遥测永不阻塞退出。

### 10.5 隐私洗消

遥测管线的前提是「提示词内容不出本机」: 埋点只记录名称、时延、用量、错误类型等元数据, 从不记录提示词、模型输出、工具参数与文件路径。出口处还有一道兜底: Sentry 的 `beforeSend` 会先删掉事件里的请求体与 cookie, 再交给 `scrubTelemetryPayload` 递归洗消, 三层规则:

1. 环境密钥值: 遍历 process.env, 变量名命中敏感模式 (`SENSITIVE_ENV_KEY_RE`, 覆盖 API_KEY、TOKEN、SECRET、PASSWORD、PRIVATE_KEY、DSN 等) 且值长度大于 3 的, 把值本身与其 URL 编码形态都替换为 `[redacted]`——日志里的密钥常被 URL 编码过一遍。替换时按长度降序, 防止短密钥先替换把长密钥切碎留下残片。
2. 字段名模式: 对象里键名命中 authorization、api key、password、secret、credential、各类 token、private key、dsn、cookie 等模式的字段, 值整体置为 `[redacted]`; Bearer 令牌另有正则单独脱敏。
3. 家目录路径替换为波浪线 (原值与 URL 编码形态都替换)。

递归用 WeakSet 防环。这层「源头不采集 + 出口再洗消」的双重设计, 是一个要接触用户代码与凭据的终端工具敢于内置遥测的答案。

## 十一、设计取舍与边界

回看这些子系统, 有几条贯穿全局的取舍:

- 缓存优先。系统提示词保持项目无关、工具面顺序稳定、消息进入历史后不再修改、压缩保留尾部而非全部摘要、摘要走缓存共享路径——这些看似分散的决定, 都在服务同一个目标: 让 prompt cache 尽可能命中。99.4% 到 9.5% 的实测落差说明了这不是锦上添花。
- 失败要显式。OS 沙箱不可用就 fail closed 拒绝执行命令而不静默放行; 上下文超限就压缩而不硬塞; 摘要不完整或对话已变就保留原历史; 解析不了的 shell 命令升级为人审; 任务被取消与失败在输出上都留证据。宁可显式失败, 也不让模型在无声的降级里给出错误结论。
- 人负责方向, 机器负责推进。权限默认询问、主会话计划审批阻塞等待 (teammate 计划在非 coordinator 模式下由运行时自动批准, coordinator 模式下由 leader 审核)、目标设定与替换只属于用户、预算耗尽前给一次总结轮、团队消息里的沉默不算同意——自治循环的边界由人划定。
- 资源所有权显式建模。注册表的自有与借用、takeOwnershipFrom 的显式移交、作用域工具的重新实例化、退出时「先同步清理再异步 flush」的顺序, 让「多个代理共享一个进程」这件事不靠约定而是靠类型与生命周期保证。

需要标注的边界: 本文描述的是内置核的机制, 具体阈值与上限以源码常量为准, 可能随版本调整; 目标状态与检查点依赖会话文件, 无 sessionId 的一次性调用不具备这些能力; 危险命令模式集当前为空, 那一层拦截处于休眠状态, 属于预留而非生效的防护。把内核做成「可被多种宿主、多种协议、多种协作规模复用」的形态, 代价是概念与生命周期显著增多; 本文希望呈现的正是这些代价换来的确定性。

以下为设计问答篇, 与前面的子系统论述互为补充: 前半按子系统顺序论述实现思路, 问答篇按主题逐条拆解设计取舍与边界, 回答"为什么这样设计、边界在哪里、怎么取舍"。涉及的文件与符号只作为设计锚点出现, 不逐文件走读。

## 十二、设计问答: 定位与总体架构

### 1. Yukino 与普通 CLI 工具的本质区别是什么?

普通 CLI 是"输入 → 执行 → 输出"的一次性映射; Yukino 是一个 LLM 驱动的多轮闭环: 用户给出目标, 模型推理, 调用工具, 观察结果, 再推理, 直到不再调用工具为止。这个闭环叫 Agent 循环 (agent loop), 它才是产品内核, 终端只是它的一种宿主。

从分层看, 系统大致分为:

```text
入口分发层    解析参数, 选择 TUI / print / remote / ACP / A2A
Agent 循环层  run(): AsyncGenerator<AgentEvent>, 多轮推理与工具执行
LLM 抽象层    统一 LLMClient, 适配 anthropic / openai / openai-compat
工具层        统一 Tool 接口, 按 category 分类并支持并行调度
表现层        Ink/React 终端 UI, 或把事件转成 WebSocket/协议消息
横切支撑      权限、压缩、会话、记忆、目标、钩子、MCP、技能、多智能体
```

关键点是表现层与领域层彻底解耦: 所有宿主消费的都是同一个事件流, Agent 核心不知道 UI 是否存在。这决定了后续几乎所有设计——测试可以无头运行, 宿主可以替换, 交互可以注入。

### 2. 为什么 Agent 循环用 AsyncGenerator 而不是 EventEmitter 或回调?

`run()` 的签名是一个返回事件流的异步生成器, 消费侧统一写成 `for await (const event of agent.run())`。相比推送式的事件总线, 它带来四个结构性好处:

1. 拉取式背压。只有消费方 `await` 下一个事件时, 循环才前进一步; 渲染慢时 Agent 自然减速, 不存在事件积压与缓冲队列。
2. 控制流即代码。多轮推理、错误恢复、退避重试都能用普通 `while` 与 `try/catch` 线性表达, 不必拆成状态机。
3. 中断语义天然。调用方 `break` 或触发底层 `AbortController`, 生成器帧连同流式连接、睡眠定时器一起回收, 不需要手动摘除监听器。
4. 统一消费接口。TUI、print、remote 用完全相同的 `for await` 循环, 差别只在如何渲染或序列化事件。

代价是生成器只能推一条主线, 所以并行信息 (子代理进度、团队邮箱消息、钩子输出) 走回调旁路, 再由主循环在每轮开头排空成 system-reminder。主线用生成器、旁路用回调, 是这个架构明确的分工。

### 3. AgentEvent 是如何建模的? 为什么用判别联合而不是类继承?

事件被定义成一个以 `type` 为判别字段的联合类型, 成员覆盖正文与思考增量、思考块完成、工具调用开始与结果、轮结束、循环结束、steering 投递、用量、错误、压缩、重试、权限询问。核心字段大致如下:

| 事件                            | 关键载荷                                                                   | 语义                               |
| ------------------------------- | -------------------------------------------------------------------------- | ---------------------------------- |
| `stream_text` / `thinking_text` | `text`                                                                     | 正文 / 思考增量                    |
| `thinking_complete`             | `thinking`、`signature`                                                    | 思考块完成, 签名供回传             |
| `tool_use`                      | `toolName`、`toolId`、`args`                                               | 工具调用开始                       |
| `tool_result`                   | `toolName`、`toolId`、`output`、`isError`、`elapsed`、可选 `contentBlocks` | 工具结果, 富内容走 `contentBlocks` |
| `turn_complete`                 | 无                                                                         | 一轮结束                           |
| `loop_complete`                 | `stopReason`                                                               | 整个循环结束                       |
| `steering_delivered`            | `text`                                                                     | 排队的用户插话已在轮次边界注入     |
| `usage`                         | `UsageInfo`                                                                | token 用量                         |
| `error`                         | `Error`                                                                    | 错误                               |
| `compact`                       | `message`、可选 `boundary`                                                 | 发生压缩, 带边界负载时需持久化     |
| `retry`                         | `reason`、`delay`                                                          | 自愈重试                           |
| `permission_request`            | `toolName`、`args`                                                         | 需要人机确认                       |

选判别联合而不是继承, 有三个原因。第一是穷尽性: 消费侧 `switch (event.type)` 配合 `never` 兜底, 新增事件类型会在编译期暴露所有未处理分支, 这对多宿主消费尤其重要。第二是零运行时开销: 事件是纯数据, print 模式可以直接序列化。第三是风格一致: 工具、权限、压缩都是"接口加纯数据"的写法, 没有深类层次。

### 4. 六种运行模式如何复用同一套核心? 这种设计对可测试性意味着什么?

复用的关键是 Agent 核心只依赖注入的接口, 不依赖宿主环境 (模式与触发的对照表见 10.1)。各宿主共享 Agent 循环、对话管理器、工具注册表、权限检查器、压缩与会话模块; 宿主只负责三件事: 构造依赖、消费事件流、处理人机交互 (权限确认与提问)。

对测试的意义有两层。一是核心可无头测试: 注入一个返回预置流事件的假客户端, 就能在没有终端的情况下驱动完整循环。二是 print 模式本身就是端到端载体: 它与 TUI 共享同一核心, 非交互跑通即可认为核心逻辑跑通。权限这类交互则通过注入 `onPermissionRequest` 回调替换策略——测试注入"总是允许", TUI 注入"弹对话框", 走的是同一条代码路径。

### 5. 为什么不把产品做成"库加插件", 而是应用加多协议服务端?

如果核心是库, 那么 UI、持久化、权限、压缩这些横切关注点就要由调用方各自实现, 行为无法一致, 安全边界也无法统一。Yukino 的选择是: 内核 (循环、工具、权限、压缩、会话) 是一等公民, 运行模式是内核的薄适配层。

这样做的收益是安全与行为一致——无论从终端、浏览器还是 ACP 客户端进入, 同一个工具都要过同一个权限管线, 同一份上下文都要走同一套压缩规则。代价是内核必须保持"宿主无关": 任何直接读写终端、直接调用进程退出、直接假设单会话的代码都不能进内核, 只能通过注入的回调完成。这也是为什么内核里到处都是 `onPermissionRequest`、`notificationFn`、`onLoopComplete` 这类回调, 而没有一个全局单例 UI。

### 6. 一次 run 的单轮迭代依次做什么?

单轮 (turn) 的执行顺序是固定的:

1. 迭代守卫: 超过 `maxIterations` 时发出错误并结束 (主代理与 Agent 工具默认 0, 表示不限制; 自定义角色可用 max_turns 收紧)。
2. 注入运行时提醒, 顺序固定: 按当前工具面重算的工具指引 (含"无可调用工具"兜底) → 工作目录提醒 (仅 worktree 会话或历史已有该 marker 时) → 持久目标提醒 → 计划模式提醒与协调者提醒 (第 1、6、11… 轮给完整版, 其余给精简版) → 延迟工具指引。
3. 排空旁路通知: 钩子通知、团队邮箱消息、新技能增量, 统一转成 system-reminder。
4. 生命周期钩子: 依次触发 turn_start 与 pre_send 钩子, 两者的输出立即排空注入, 保证作用于本次请求; 活跃目标累加续跑轮数。
5. 上下文管理: 估算 token, 超过自动阈值就压缩; 压缩真正改写转录时先持久化边界再发布事件。
6. 发起流式请求, 把内部流事件映射为 AgentEvent 转发给宿主, 同时累积正文、思考块、工具调用与停止原因。
7. 错误自愈: 上下文超长触发强制压缩重试; 限流 / 服务端 / 网络错误走共享退避; `max_tokens` 触发输出上限升级与续写。
8. assistant 消息落历史, 然后分支: 有工具调用就进入工具执行 (分批、权限、钩子、流式回报), 无工具调用则先看 steering 队列, 再看持久目标是否续跑, 都不满足才收尾。
9. 收尾: 打文件历史快照, 触发后台记忆提取, 按结果三态上报遥测, 结算目标用时。

这里最重要的位置设计是: 工具结果预算处理发生在"结果入历史时", 而不是"每轮请求前"。一旦处理完成, 历史消息就是终态, 此后永不修改, prompt cache 前缀天然稳定, token 估算也可以直接按转录尺寸计算。

### 7. turn_complete 与 loop_complete 的边界语义是什么?

turn 是"一次模型响应加它引发的全部工具执行"; loop 是"从用户提问到模型不再调用工具的整个过程"。`turn_complete` 每轮发一次, `loop_complete` 只在循环退出时发一次, 后者的 stopReason 区分自然结束与预算受限 (budget_limited) 等终止原因。

UI 对两者的处理完全不同:

| 时机            | UI 行为                                                                                      |
| --------------- | -------------------------------------------------------------------------------------------- |
| `turn_complete` | 冲刷流式节流、清空流式文本, 把本轮内容提交为若干条消息 (思考摘要、正文、工具摘要) 进不可变区 |
| `loop_complete` | 冲刷并提交最后一段正文; 计划模式下弹出审批对话框                                             |

工具结果的流式到达也在这条链路上兑现: 结果按完成顺序逐条到达时, 对应卡片立即点亮完成态与耗时, 而不是整批结束后一次性刷新。这个双层边界的价值是 turn 作为渲染提交单元、loop 作为交互单元: 把思考和工具调用折叠成摘要再进不可变区, 显著减少回滚区的条目数量。

### 8. 为什么事件流消费端要维护"可变 ref 镜像"?

这是一个陈旧闭包 (stale closure) 问题。事件循环是长生命周期的 `for await`, 它持有的回调闭包捕获的是循环开始时的状态快照。节流渲染的回调在几十毫秒后才执行, 其间可能又到达了多个文本增量; 如果回调直接读局部累积变量或 React state, 就会读到旧值而丢帧。

Yukino 的做法是写时双写: 状态既写进 React state (驱动渲染), 也写进一个可变 ref (供异步逻辑读取最新值)。权限模式、流式正文、流式思考文本都遵循这个模式。经验法则可以概括为: 事件源驱动的异步代码里, "驱动渲染"读 state, "读最新值"读 ref。

## 十三、设计问答: Agent 循环与流式执行

### 9. 工具调用的分批并行是如何实现的?

实现分两层。分批算法遍历本轮工具调用列表, 对每个调用先查工具自带的"按实参判断是否并发安全"方法, 缺省回退到 `category === "read"`; 连续的安全调用合并进同一个并行批, 任何不安全调用单独成批串行。

```ts
const safe = tool.isConcurrencySafe?.(args) ?? tool.category === "read";
if (safe && lastBatch?.concurrent) lastBatch.blocks.push(call);
else batches.push({ concurrent: safe, blocks: [call] });
```

执行引擎采用提交 / 运行两段式: 提交阶段只把调用压入待执行队列 (解析失败的直接判死), 运行阶段一次性并发启动整批, 结果按完成先后唤醒生成器逐条上报。生成器被提前关闭时, 收尾会等待所有已启动的执行, 不留孤儿 Promise。并行批先提交完整批再运行; 串行批每提交一个就运行一个, 退化为逐个执行。

### 10. 为什么 read 类工具可以并行, 而 write/command 不行?

三个理由。第一, 读操作没有副作用, 并发执行的结果与顺序无关 (可交换)。第二, 写操作必须保序: 编辑与命令之间可能相互依赖, 而且模型生成调用的顺序本身隐含因果序, 打乱会破坏语义。第三, 未知工具保守降级: 注册表里查不到的工具一律判为不安全, 单独成批串行, 宁可慢也不冒险。

值得注意的是判定不是按工具类别一刀切, 而是按实参。`ls` 与 `rm` 都是 Bash, 但前者可以与读取工具并行, 后者必须独占; 多个 `Agent` 委托调用则可以真正并行 (其 isConcurrencySafe 恒为真), 因为每个子代理拥有独立会话与工具注册表。这样就能把模型输出的扁平调用列表还原成带偏序关系的执行计划, 而不需要引入完整的 DAG 调度器。

### 11. "完成顺序上报、调用顺序落库"是怎么做到的?

上报路径与数据路径是分离的。执行器按完成顺序把结果推给主循环, 主循环一边即时把 `tool_result` 事件转发给宿主, 一边用 `Map<toolId, result>` 收集。等全部结果收齐后, 再严格按 assistant 消息里的调用顺序组装工具结果消息并落历史。

这样做的收益是双重的: 用户能尽早看到先完成的工具结果, 而对话历史保持确定的顺序。确定的顺序又保证了 tool_use 与 tool_result 的配对不会因完成顺序而错位——这既满足 API 的配对要求, 也是 prompt cache 前缀稳定的前提。

### 12. 循环有哪些自愈机制?

四类, 触发条件与恢复策略各不相同:

| 故障       | 触发                                     | 恢复策略                             |
| ---------- | ---------------------------------------- | ------------------------------------ |
| 上下文超长 | 413, 或 400 且消息命中上下文长度错误判定 | 强制压缩后重试本轮                   |
| 瞬态故障   | 429 / 408 / 5xx / 网络与连接错误         | 共享退避重试, 最多 3 次              |
| 输出截断   | 停止原因是 `max_tokens` 且本轮无工具调用 | 抬升输出上限一次, 其后至多 3 轮续写  |
| 未知工具   | 模型调用了不存在的工具                   | 返回错误结果让模型自我纠正, 不做熔断 |

所有恢复路径都会发出事件让 UI 可见 (重试提示、压缩提示), 而不是静默处理。设计取向是: 可恢复故障优先"修正上下文后重试", 而不是直接失败; 而无法撤回已输出内容的情况 (已有可见输出、流未正常结束) 则宁可报错也不重复。

### 13. 瞬态重试为什么要限制"本轮无可见输出才重放"?

传输层无法撤回已经流式输出的片段。如果模型已经吐出一段正文或发起了一个工具调用后连接中断, 重放会产生重复内容或重复调用。所以重试的前置条件是本轮尚未产生任何正文、思考或工具调用事件。

退避策略本身是共享的: 限流错误优先解析 `Retry-After` 头 (支持秒数与 HTTP 日期两种形式), 缺省与其余瞬态错误一样用指数退避, 延迟封顶后进入可中断睡眠。睡眠期间用户中断则优雅退出并发出中断结束事件, 而不是粗暴杀死进程。非瞬态错误 (如鉴权失败) 不重试。

### 14. max_tokens 截断的恢复路径是如何设计的?

前提是停止原因为 `max_tokens` 且本轮没有产生任何工具调用; 若本轮带着工具调用, 则不做续写恢复, 而是把这些调用统一标上解析错误并按错误结果退回 (见本节末), 不执行它们。

恢复分两阶段: 抬升只做一次, 其后至多 3 轮续写。阶段一抬升输出上限: 朝 `min(64000, contextWindow)` 的封顶值抬升, 把已生成的部分文本作为 assistant 消息落历史, 追加一条"从断点继续"的用户消息, 然后重试。抬升是请求级的, Agent 只改自己的上限并在后续请求里传入, 不触碰共享客户端的默认值, 因此并发 Agent 之间互不干扰; run 收尾时恢复自己的初始值。阶段二是多轮续写: 若抬升后仍截断, 继续有限轮续写, 提示词改为"把剩余工作拆成更小的块"。

一个重要的安全细节: 若截断轮带着工具调用 (即调用很可能被截断), 这些调用会被统一标上解析错误并作为错误结果退回, 而不是执行——防止被截断的实参被误执行。

### 15. 工具结果的预算与落盘边界在哪里?

工具结果进入对话历史前要过两道预算。第一道是单条结果上限: 超过 50,000 字符的结果写入磁盘, 历史里只留 2,000 字符预览加文件路径, 模型可以用读取工具回读全文。第二道是整批聚合上限: 同一条消息内全部结果的字符总数超过 200,000 时, 从最大的结果开始逐个落盘, 直到总量达标。

落盘只作用于进入历史的副本。工具结果事件在落盘之前已经按完成顺序实时发给宿主, 用户看到的是完整输出, 对话历史里才是预览加路径。这个区分让"无损落盘"和"有损压缩"成为两级降级: 显式的大结果先落盘 (廉价、无损、可回读), 只有窗口将满时才动用会丢细节的摘要压缩。

### 16. 溢出结果的"回读豁免"防御的是什么死循环?

防御"落盘—回读—再落盘"的循环。模型读回落盘文件的全文后, 这个读取结果本身可能又超过单条上限。如果对新结果再执行一次落盘, 模型就永远只能看到预览, 永远拿不到全文, 于是不断重复"回读"与"落盘"两个动作。

因此判定逻辑是: 如果本次工具调用本身就是对某个会话产物落盘文件的回读, 那么它的结果豁免再落盘。豁免判定基于工具名、实参与产物命名空间 id, 与溢出目录的归属判断共用同一套命名空间, 所以并行批里既落盘又回读的调用也能被正确识别。没有 sessionId 的匿名对话用 WeakMap 持有一个惰性匿名命名空间并注册退出清理, 保证豁免判定在无会话场景下同样成立。

### 17. 中断时如何保证每个 tool_use 都有配对的 tool_result?

这是 API 的硬要求: 缺失配对会导致请求被直接拒绝。循环在多处做了保证。执行器对每个待执行调用先做中断检查, 已中断的调用立即产出中断错误结果; 工具执行期间用户中断时, 已经产出的结果照常入历史, 未启动的剩余调用逐个回报"命令已中断"的错误结果。如果整个循环因为中断提前退出, 收尾也会把未处理的调用补成错误结果。此外, 每次请求前还会做一次配对修复 (ensureToolPairing), 处理中断、会话恢复与并发交错留下的悬空调用: 缺结果的调用补上"已中断"错误结果, 无主或重复的结果消息直接丢弃, 修复只作用于发出的请求副本, 不写回历史。

### 18. 如何防止模型陷入工具调用死循环?

多层防线, 软硬结合:

| 防线     | 机制                                                 | 性质 |
| -------- | ---------------------------------------------------- | ---- |
| 迭代上限 | 超过配置的最大迭代数即终止 (需角色显式配置)          | 硬   |
| 压缩熔断 | 自动压缩连续失败 3 次后暂停 (除非已过硬阻塞线)       | 硬   |
| 目标闸门 | 续跑轮数上限 150、同一阻塞原因连续 3 轮转阻塞态      | 硬   |
| 自我纠正 | 未知工具与执行错误作为结果回灌, 模型通常一两轮内改正 | 软   |
| 可见成本 | 每轮流出的用量事件让用户随时中断                     | 人工 |

关键原则是硬防线必须独立于模型行为——不能指望模型自己停下来。软防线的作用是让大多数潜在死循环在早期被模型自己化解, 而不是频繁触发硬终止。

### 19. steering 队列是什么? 为什么在轮次边界投递?

steering 是用户在 Agent 运行中插入的补充消息。它们不会立刻打进对话, 而是先进入队列; 主循环在轮次边界 (工具结果之后、下一次模型调用之前) 统一排空, 逐条作为用户消息注入并发出 steering_delivered 事件。

在边界投递有两个原因。第一是配对安全: 如果在工具执行中途插入用户消息, 会破坏 tool_use 与 tool_result 的相邻关系。第二是缓存友好: 边界处插入不会让模型对当前批工具结果的理解错位。队列还支持在投递前撤回 (用户把消息召回编辑器), 以及退出时的排空, 保证不丢用户输入。steering 队列非空同时是目标续跑与预算总结轮的抑制条件——用户在说话时, 机器不抢方向。

### 20. 为什么说"观察流无序、数据流有序"是这套并发的核心不变量?

因为并发只发生在观察层。工具结果按完成顺序流向宿主, 这是给人看的部分, 先后无关紧要; 而进入对话历史与持久化的顺序严格按模型调用顺序, 这是给模型和缓存看的部分, 必须确定。两层用同一个结果集合, 只是遍历顺序不同。

这条不变量带来三个好处: 用户即时反馈、模型看到稳定顺序、prompt cache 前缀不被并发打乱。它也是"读并行、写串行"策略能安全落地的前提——如果写操作的观察顺序被当成执行顺序, 并行读就会破坏语义。

## 十四、设计问答: LLM 抽象与协议适配

### 21. LLMClient 接口是如何设计的?

接口刻意保持最小化:

```ts
export interface LLMClient
  extends Partial<MaxTokensSetter>, Partial<ThinkingLevelControl> {
  readonly protocol?: ToolProtocol;
  getOutputBudget?(): LLMOutputBudget;
  stream(
    conversationManager: ConversationManager,
    toolSchemas: ProviderToolSchema[],
    abortSignal?: AbortSignal,
    options?: LLMStreamOptions,
  ): AsyncGenerator<StreamEvent>;
  setSystemPrompt(prompt: string): void;
}
```

它只承诺四件事: 能流式产出事件、能替换系统提示词、可选地暴露协议名与运行时控制 (输出上限、思考强度), 以及可选地报告当前输出预算 (`LLMOutputBudget` 含 maxOutputTokens 与 thinkingTokens——压缩器靠它给摘要请求算出"预留 16,000 token 回答空间"之后还剩多少可用)。客户端实例由工厂按协议动态加载对应的 SDK 模块, 只有被配置的协议会被加载, 未配置的供应商 SDK 不进运行时。未知协议直接抛错, 不做隐式回退。

### 22. 三套协议 (anthropic / openai / openai-compat) 的差异被如何收敛?

差异集中在三处, 其余全部下沉到各自的客户端实现:

| 维度         | anthropic                 | openai (Responses)         | openai-compat (Chat Completions) |
| ------------ | ------------------------- | -------------------------- | -------------------------------- |
| 系统提示词   | 独立 system 字段          | input 里第一条 system 消息 | messages 里 system 消息          |
| 思考强度     | budget 或 adaptive effort | `reasoning.effort`         | `reasoning_effort`               |
| 输出上限参数 | `max_tokens`              | `max_output_tokens`        | `max_completion_tokens`          |
| 思考内容来源 | thinking 块 (带签名)      | 推理摘要增量               | 非标准 `reasoning_content` 字段  |
| 缓存         | 显式缓存断点              | 由服务端处理               | 由服务端处理                     |

统一后的抽象包括文本增量、思考增量、思考块完成、redacted_thinking_complete, 以及工具调用开始 / 增量 / 完成与一次正常的流结束。工具调用参数的 JSON 解析被抽到一个共享函数里, 解析失败会带上解析错误标记, 交给上层决定是否执行。三套实现都提供 getOutputBudget, 思考预算的推导规则因此对压缩器透明。

### 23. Anthropic 消息构造里的"user 消息合并"解决什么问题?

Anthropic 的消息角色必须严格交替。而 Yukino 的历史里经常出现连续的 user 消息: 工具结果消息、紧随其后的 system-reminder、steering 注入, 都可能连续落在 user 角色上。构造请求时会把连续的 user 轮合并为一条消息的多个内容块, 避免因角色不交替被 API 拒绝。

合并时还要处理三种边界: assistant 的思考块必须原样回传 (thinking 块含签名, redacted_thinking 块含密文 data, 都逐字回放), 工具调用要转成对应内容块 (对话工具名映射为供应商约定名), 空 assistant 消息要补一个空文本块满足协议。这些细节如果分散在各处, 极易在协议升级时漏改, 所以集中在一个构造函数里。

### 24. 为什么请求前必须做工具配对修复?

悬空的工具调用可能来自三个场景: 用户中断导致调用未执行、会话恢复时历史被截断、并发交错。API 对配对的检查是硬性的, 一旦缺失整次请求会被拒绝, 表现为"莫名其妙的 400"。

配对修复 (ensureToolPairing) 在每次构造请求前运行: 把连续的结果消息按调用分组, 给缺少结果的调用补一个说明性的"已中断"错误结果, 丢弃无主与重复的结果消息。修复只作用于即将发出的请求, 不写回对话历史——历史保持原始事实, 修复是传输层的职责。它同时承担了"会话恢复后的自愈", 因此不需要在恢复路径里单独处理损坏的配对。

### 25. Prompt caching 的断点放在哪里? 为什么这样放?

三个位置:

1. 系统提示词整体打一个缓存断点。系统提示词是会话内唯一的稳定块 (项目指令、记忆、技能都走 reminder 通道), 所以能跨轮命中。
2. 工具 schema 末尾打一个 ephemeral 断点, 但必须避开带 defer_loading 的工具 (二者同存会被 API 拒绝整个请求, 而 MCP 工具注册在内置工具之后、常居数组尾部), 所以从尾部反向扫描, 落在最后一个非延迟工具上。工具数组渲染在系统与消息之间, 只要它不变, 断点之前的前缀就稳定。
3. 最后一条 user 消息的尾部打一个断点, 让多轮对话的滚动前缀可以复用; 断点优先放在该消息的最后一个非图像内容块上, 因为部分网关拒绝对图像块打缓存标记。

这套安排的直接动机是可测量的: 源码注释记录了一次实测, 在约两万 token 的历史上往工具数组末尾追加一个工具, 缓存命中率从 99.4% 跌到 9.5%, 相当于整段历史重新计算。所以"工具数组稳定"不是洁癖, 而是缓存契约。defer_loading 所需的 beta 头 (`advanced-tool-use-2025-11-20`) 也只在工具面上确实存在延迟工具时才发送, 避免无谓地声明实验特性。

### 26. 错误分类为什么做得这么细?

因为不同错误的恢复策略不同, 而恢复策略决定了用户体验与成本。分类至少区分: 上下文超长 (可压缩后重试)、限流 (可退避且优先遵循服务端建议)、服务端错误 (可退避)、网络与连接错误 (可退避)、鉴权与请求错误 (不可重试)、流未正常结束 (不可重试, 因为无法撤回已输出内容)。

两个供应商的错误分类器各自把 SDK 异常映射到同一套内部错误类型, 例如把连接错误与主动中止统一成网络错误, 把 408 与 5xx 归类为可重试的服务端错误并尽量携带建议延迟; 上下文超长的识别同时覆盖两家不同的报错措辞。上层只依赖内部类型, 不依赖任何 SDK 的异常类名。

### 27. 用量锚点 (UsageAnchor) 解决了 token 估算的什么痛点?

纯字符估算误差会累积。模型每轮结束会返回真实用量, 这套机制在每轮结束记录一个锚点: 记录当时四类真实 token (输入、缓存读、缓存创建、输出) 与消息数量。之后估算只需要算锚点之后新增消息的字符数, 用固定比例换算, 再加上锚点本身的真实 token。

这样误差只来自"锚点之后的那一小段", 不会随会话变长而放大。冷启动 (还没有任何真实用量) 时退回全量字符估算。图像块按 7,000 字符等效值计入, 避免 base64 体积把估算炸掉。缓存读与缓存创建的 token 也被计入真实基线, 因为它们同样占据窗口预算。rewind 截断对话时锚点被清空, 强制下一轮重新全量估算——过期的锚点比没有锚点更危险。

### 28. token 估算为什么用固定的字符 / token 比例?

因为它是估算, 不是精确计数; 目标是触发阈值判断, 不是计费。自然语言与代码的字符 / token 比例不同, 用一个偏保守的单一比例 (对话按每 token 3.5 字符) 可以覆盖大多数情况, 真正的偏差由锚点机制吸收。压缩阈值本身也留了安全余量, 所以估算偏低一点不会导致溢出, 估算偏高一点只会稍微提前压缩。

需要注意的是不同地方的估算比例并不相同: 对话消息用面向自然语言的 3.5, 而 MCP 工具 schema 是符号密度很高的 JSON, 单独用 2.5 估算, 才能准确判断"schema 是否小到可以全量加载"(eager 阈值判定, 见 3.3)。

### 29. 工具 schema 在不同协议间如何转换?

工具内部只有一种声明形式 (名称、描述、JSON Schema), 导出时按协议转换成各自的结构 (getAllSchemas 接受协议参数)。转换中值得注意的点:

| 关注点   | 处理方式                                                          |
| -------- | ----------------------------------------------------------------- |
| 协议差异 | Anthropic 形态附加 `type: "custom"` 等字段, 其余协议各按 SDK 类型 |
| 延迟加载 | 只有 Anthropic 原生支持 `defer_loading` 字段, 且需要 beta 头      |
| 可见性   | 与延迟指引、恢复附件共用同一 isToolVisible 判定                   |
| 缓存影响 | schema 一旦变化会破坏前缀缓存, 所以工具数组不随每轮变化           |

只有当工具面上存在延迟工具时才会发送对应的 beta 头, 避免无谓地声明实验特性。

### 30. 思考强度是如何做到"不靠模型名猜能力"的?

能力声明是显式元数据, 不是从模型名推断。配置里为每个 provider 声明是否支持 reasoning, 以及可选的逐等级映射表; 逻辑等级有七档 (`off` 到 `max`), 默认 `high`, 每档对应固定 token 预算 (1024 到 65536)。映射规则:

1. `off` 永远显式关闭思考 (不能靠省略字段, 否则会启用服务端默认值)。
2. 声明不支持推理时, 返回空表示不下发思考字段。
3. 映射表可以逐等级重写, 也可以映射为空来禁用某一等级。
4. Anthropic 的自适应模式把 minimal 抬到 low、把 xhigh 降到 high; OpenAI 协议原样透传全部等级 (包括 xhigh 与 max), 仅当 thinking_level_map 显式映射或置 null 时才改变。
5. 降级只降不升: 请求了 provider 不支持的等级时, 钳制到最近的可用低档。

Anthropic 的预算模式下, 思考预算与输出上限共享额度, 必须同时满足最小思考预算 1024 与最小回答空间 1024; 输出上限装不下"最小思考预算加最小回答"时, 可用等级只剩关闭。

### 31. 运行时切换思考强度后, 子代理如何继承?

当前会话切换时写入配置并应用到客户端, 保存失败不回滚运行时变更 (避免"看起来切换了其实没生效"的错觉)。子代理派生时继承父客户端当前的有效等级, 而不是父 provider 的初始配置, 所以主代理运行中调低强度, 新起的子代理也随之降低。

需要区分"用户设置的等级"与"生效的等级": 客户端保存钳制后的有效值并暴露给调用方, 子代理继承的是这个有效值, 否则会继承一个 provider 根本不支持的请求值。
