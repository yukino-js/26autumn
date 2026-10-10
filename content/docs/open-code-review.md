---
title: "OpenCodeReview: 确定性工程与 Agent 混合的 AI 代码评审 CLI"
description: "OpenCodeReview 的评审流水线设计: 确定性与 LLM agent 的分工、Provider 抽象、diff 与规则上下文收集、allowlist 与规则 DSL、评论定位、Action/npm 分发与插件生态, 以及成本与可靠性的取舍"
local_path: "$HOME/Downloads/open-code-review"
---

OpenCodeReview (命令名 ocr) 是一个用 Go 编写的 AI 代码评审命令行工具: 它读取本地 git diff 或整份文件, 调用大模型找出代码问题, 把评论精确定位到行, 并以 text、json 或 sarif 输出, 供人阅读或供宿主 Agent 消费。本文讲它的评审流水线是怎么搭起来的——哪些环节由确定性工程代码保证, 哪些交给 LLM Agent 决策, 两者如何拼接, 以及分发到 CI、npm、IDE 与各类 coding agent 的形态。适合需要在研发流程里落地自动化代码评审、或对 agent 工程化(把不确定的模型能力装进确定的流程)感兴趣的后端与工具链开发者阅读。

全文围绕一条主线展开: 评审里"不能出错"的部分被工程代码拿走了, 模型只负责"需要判断"的部分。理解这条分工线, 就能理解后面所有的机制取舍。

## 一、设计取向: 把能确定的环节交给工程

### 1.1 纯语言驱动架构的失效点

用通用 coding agent 做代码评审, 常见三类问题:

- 大变更集覆盖不全。上下文窗口有限, agent 容易只看开头、遗漏尾部文件, 且覆盖度不可校验。
- 报告位置漂移。模型用自然语言描述"第几行""某个函数", 行号靠猜, 挂到错误位置后评论无法在 IDE 里对齐。
- Skills 质量不稳定。评审规则若仅以自然语言提示存在, 同一提示在不同模型、不同会话下产出质量波动很大。

根因是同一件事: 纯语言驱动的架构对评审过程缺乏硬约束——覆盖了多少文件、每条评论落在哪一行, 都不是可验证的状态。

### 1.2 混合架构的分工原则

OpenCodeReview 的回应是把流程拆成两类环节:

| 环节                                | 归属                 | 理由                                     |
| ----------------------------------- | -------------------- | ---------------------------------------- |
| diff 获取、文件选择、体积与路径闸门 | 确定性工程           | 纯函数即可判定, 不应受模型影响           |
| 规则匹配、allowlist 过滤            | 确定性工程           | 有静态事实源(规则文件与 glob)            |
| 文件语义分组                        | Agent                | 需要理解改动语义, 但有文件数上限与兜底   |
| 组内多轮工具循环、评论生成          | Agent                | 需要判断与检索                           |
| 评论行号定位                        | 确定性优先, LLM 兜底 | 滑动窗口匹配可验证, LLM 重定位只是第三级 |
| 覆盖度统计、预算截断、退出码        | 确定性工程           | 交付契约必须稳定                         |

一个直接后果是 --preview: 因为文件选择是纯函数, 预览与真实运行消费同一份答案, 二者不会漂移。

### 1.3 能力边界与取舍

这套架构刻意偏向"以精确换噪声": 宁可少报, 也要让报出的评论落在正确位置、覆盖度可解释。代价是召回率不是它的强项——它不追求把 diff 里每一处潜在问题都翻出来, 而是保证已发现问题的定位与去重质量。对需要高召回的审计场景, 更合适的是全文件评审模式(scan), 而不是 diff 评审。

## 二、运行面: 命令、范围与输出契约

### 2.1 命令清单

| 命令                | 用途                                                                           |
| ------------------- | ------------------------------------------------------------------------------ |
| ocr review (别名 r) | 基于 diff 的评审, 支持 workspace、--from/--to、--commit 三种范围               |
| ocr scan            | 全文件评审, 不要求 diff                                                        |
| ocr delegate        | 只产出评审规格(不调用 LLM), 交给宿主 agent 执行                                |
| ocr session         | 会话的列举与检查: list、show、comments、compare、export、rm                    |
| ocr config          | 配置管理: set、unset, 以及交互式选 Provider、选模型                            |
| ocr llm             | LLM 工具: test(发测试会话并验证一次工具调用往返)、providers(列出内置 Provider) |
| ocr rules           | 规则检视: check 查某文件命中哪条规则                                           |
| ocr viewer (别名 v) | 本地 Web 会话查看器                                                            |
| ocr completion      | shell 补全                                                                     |

启动时先注入版本、初始化遥测并注册带超时的退出钩子, 再进入命令分发。对需要 git 的命令(review/scan/delegate), 会先检查 git 版本, 版本不足只告警不阻断。

### 2.2 review 的输入范围与标志

review 的三种范围:

- workspace: staged + unstaged + untracked, 默认;
- 区间: --from/--to, 取 merge-base 到目标提交;
- 单提交: --commit。

常用标志: --tools、--rule、--repo、--resume、--exclude、--format/--audience、--output、--concurrency、--timeout、--max-tools、--max-git-procs、--max-tokens、--max-tokens-budget、--background/-b、--provider、--model、--effort、--no-filter、--preview。其中 --effort(low/medium/high)控制评审轮数, 语义见第四节。

--max-git-procs 与 --concurrency 都有默认值(16 与 8)。--from/--to/--commit 的取值会走 git 校验: 必须是真实提交引用且不得以连字符开头, 以 --end-of-options 方式传给 git, 防止把修订参数注入成 git 选项。

### 2.3 退出码、输出格式与静音

退出码契约刻意宽松: 只有 run 级失败、或所有选中项都失败时才返回非零; complete/partial/skipped 一律退出 0。这意味着 token 预算导致的受控截断只要还有覆盖, 就仍算成功, 且部分结果会完整发布。

输出分三种:

- text: 人读格式, 按字符宽度折行, 建议代码用行级 diff(Myers 风格 LCS)渲染增删着色;
- json: 摘要含 files_reviewed、comments、token 用量(含缓存读写)、耗时、budget_exceeded 等字段;
- sarif: 实现 SARIF v2.1.0 的一个子集, 工具名与指纹键固定, 便于接入代码扫描平台。

输出契约上还有两条: --output 写文件时, 目标是目录或父目录缺失会提前失败; 非机读格式会剥掉 ANSI。stdout 的保护分两档: --format 为机读格式时进度整体换道 stderr; --audience 为 agent 时进度直接丢弃, 两种情况都保证 stdout 是一份可直接解析的文档。中断处理上, 第一次信号走优雅关闭, 第二次信号强制退出。

### 2.4 快速上手

```bash
# 安装(npm)
npm install -g @alibaba-group/open-code-review

# 配置 LLM: 交互式选择 Provider、填写 key、选模型并做连通性测试
ocr config provider
ocr config model
ocr llm test

# 评审
ocr review                                     # workspace
ocr review --from main --to feature            # merge-base 区间
ocr review --commit <sha>                      # 单提交
ocr review --format json --output result.json  # 机读输出
ocr review --preview                           # 只看文件选择, 不建会话不调 LLM
ocr scan --path internal/agent                 # 全文件评审某目录
ocr delegate preview                           # 只出评审规格, 不需要 LLM
```

会话数据全部落在用户主目录下的 .opencodereview/ 目录, 删除该目录即完全重置。

## 三、评审流水线: 从 diff 到评论

review 的总编排可以概括为: 解析 diff → 语义分组 → 逐组制定计划 → 组内 LLM 工具循环 → 收集并定位评论。下面按阶段展开, 并标注每个阶段属于确定性工程还是 Agent 决策。

### 3.1 diff 获取(确定性)

diff 来源分三种模式: workspace(staged + unstaged + untracked)、单 commit(对父提交)、区间(merge-base(from,to)..to)。所有 git 子进程走同一个 Runner, 内部用信号量限制并发 git 进程数, 默认 16。Provider 会缓存区间模式的公共祖先, 避免重复计算。

### 3.2 文件选择(确定性)

选择是评审唯一一次在派发前的确定性决策, 对每个变更文件套用三道静态闸门:

- 扩展名白名单: 只有受支持的文件类型进入评审;
- 路径排除: 用 doublestar 语法的 glob 排除列表(单段星号、双星跨段、花括号展开)剔除构建产物、依赖目录等;
- 单文件体积上限: 超过 prompt token 上限(模板 MaxTokens 的 80%)的文件计入 TooLarge, 全部超限则整轮 skipped。

删除文件保留在工作集里供 prompt 引用变更文件列表, 但从不派发评审。选择完成后打印一行"N file(s) changed, reviewing M in <仓库>"。选中集为空时按原因记遥测事件(体积超限/全部删除/无受支持文件)。

### 3.3 语义分组(Agent)

对较大的变更集, 先把文件元数据(不含 diff 正文)交给 LLM 做语义分组, 让相关文件(message_en.properties 与 message_zh.properties 这类)进入同一评审单元。两个工程约束:

- 返回结构用文件序号而不是路径——序号只花几个输出 token, 路径要全长度, 大变更集的响应才能留在补全上限内;
- 任何错误都兜底为每文件一组; 文件数少于阈值(4)的变更集不走 LLM: 总变更行数低于捆组阈值(200)时整体捆成一组, 否则退化为每文件一组。

每组文件数上限为 10, 超出会被拆小。

### 3.4 并发派发与 token 预算(确定性)

每个分组作为一个独立子任务并发执行, 用信号量限并发(默认 8)。单组超时是"分钟数 × 模板轮数", 与 effort 联动。每个 goroutine 带 panic 隔离: 一组 panic 只影响该组, 不会污染其他组的汇总。

--max-tokens-budget 在拿信号量之前做前瞻检查: 已用 token 加本组估算若超预算, 就停止调度后续组, 但允许在飞组跑完, 超支上界是在飞组数。预算耗尽刻意不算 run 级失败, 未派发项归为 failed(budget), 终态仍由覆盖度推导——这是"受控覆盖度截断", 不是错误。

每组估算用一组启发式常量(固定 prompt 开销约 2000 token、每文件约 7 轮、每轮输出约 700 token)。它只是数量级下限, 无法覆盖工具调用带来的 prompt 膨胀, 真实用量始终以 API 返回为准。

### 3.5 组内 plan 与多轮主循环

单组执行分两阶段:

- 计划阶段: 当模板配置了计划任务且改动足够大(单文件变更达到 50 行、或整组至少 2 个文件且总变更达到 100 行)时, 先让模型出一份组级预审计划; 低于阈值直接跳过, 计划失败只告警不中断。
- 主循环: 最多跑模板轮数(effort 决定)。从第二轮起把计划从 prompt 里剥掉, 防止计划变成覆盖度上限; 同时把上一轮已确认的评论渲染成 confirmed block 注入, 让模型不要重复报告。

主循环每轮把增长的会话整体重发。这看起来浪费, 实际是刻意为之: 重发的前缀正是 Provider prompt cache 的复用单元, 因此会话会被绑定到一个缓存亲和键, 让每轮路由到同一缓存节点。循环有三重预算: 工具调用次数上限、连续空轮上限(3 次后结束)、以及每轮发请求前的聚合 token 检查。异步记忆压缩由会话独占, 会话结束时取消在飞任务。

### 3.6 工具集(Agent 决策, 定义确定性)

内置工具是固定的窄集合: task_done、code_comment、file_read、file_find、file_read_diff、code_search, 外加 unknown 哨兵。工具的 JSON schema 是确定性定义, 其中 code_comment 把定位契约写进了描述:

```text
核心机制: 依据 existing_code 在 diff 文本中用动态滑动窗口匹配连续行。
因此模型的 existing_code 必须与 diff 格式完全一致, 只包含新增行。
```

也就是说, "评论要落到哪一行"这件事的一部分责任被工程化地压回了模型的输出格式约束里。每条评论要求 content、existing_code、category、severity、path 五个必填字段; category 与 severity 的枚举是工具 schema 的单一事实源, GitHub Action 的评论路由逻辑直接复用同一份枚举。

其余工具的确定性体现在: code_search 用 git grep 做全仓搜索并对文件模式做安全校验; file_read_diff 持有一份冻结的只读 diff 快照, 因此模型能读到被过滤文件的 diff; code_comment 在入收集器前做 schema 校验, 并有一层"字符串序列化到达且修复后无截断"的确定性修复。

这个窄工具面可以被 MCP 扩展: 用户配置里的 MCP 服务器表在评审启动时逐个连接 (本地 stdio 或远程 HTTP 两种形态), 收集到的工具定义被追加进计划阶段与主循环的工具集, 与内置工具一起暴露给模型。连接在评审结束时统一关闭, 子进程有终止宽限与总超时; 远程服务器缺 URL 等配置错误只告警跳过, 不阻断评审。这让"评审时顺手查一下 issue 系统或内部知识库"成为配置项, 而不需要改动评审流水线本身。

### 3.7 评论定位的三级回退(确定性优先, LLM 兜底)

这是混合架构最典型的一处。每条评论按固定顺序定位:

1. 本文件滑动窗口匹配: 用 existing_code 在当前文件 diff 里做连续行匹配, 空行不打断匹配;
2. 跨文件搜索: 若本文件匹配不到, 在全量 diff 里搜索, 把评论重新归档到真正改动的文件;
3. LLM 重定位: 前两级都失败时, 才让模型基于评论内容重新生成精确的 existing_code 片段, 再回到第一级重试。

跨文件搜索刻意排在 LLM 之前——LLM 步骤会覆写模型给出的原始 existing_code, 而跨文件搜索不依赖模型, 代价更低也更可靠。定位成功后评论进入收集器; 若配置了评论 worker 池, 定位与收集会卸载到池里异步执行, 主工具循环不被阻塞。

### 3.8 反思过滤(Agent)

每轮主循环结束后, 把本轮新增的评论连同组 diff 交给一次反思任务, 过滤低质量评论。--no-filter 可关闭。这是成本与噪声的主要调节阀之一。

### 3.9 收尾: manifest 与覆盖度

结束时先汇合所有可能在 run 边界后仍发请求的后台任务, 再把覆盖度冻结进不可变 manifest, 最后落盘会话结束记录。持久化失败本身算交付错误, 与评审错误合并上报——不允许评审错误掩盖"会话没写盘"。遥测记录文件数、评论数、耗时等指标。

## 四、任务模板、prompt 与 effort 体系

### 4.1 模板结构

所有 prompt 以 Markdown 内嵌进二进制, 由 JSON 模板文件引用。diff 评审模板的任务与标量:

| 任务/标量                      | 值           | 作用                 |
| ------------------------------ | ------------ | -------------------- |
| MAIN_TASK                      | 主工具循环   | 组内评审             |
| PLAN_TASK                      | 组级预审计划 | 大改动集先出计划     |
| MEMORY_COMPRESSION_TASK        | 记忆压缩     | 压缩历史             |
| REVIEW_FILTER_TASK             | 评论反思过滤 | 去噪                 |
| RE_LOCATION_TASK               | 评论重定位   | 定位兜底             |
| GROUPING_TASK                  | 文件语义分组 | 分捆                 |
| MAX_TOOL_REQUEST_TIMES         | 100          | 单组工具调用上限     |
| PLAN_MODE_LINE_THRESHOLD       | 50           | 单文件触发计划的行数 |
| PLAN_MODE_GROUP_LINE_THRESHOLD | 100          | 整组触发计划的行数   |
| GROUPING_MIN_FILES             | 4            | 小于此值不走分组 LLM |
| GROUPING_BUNDLE_LINE_THRESHOLD | 200          | 小变更集的捆组阈值   |
| MAX_REVIEW_ROUNDS              | 2            | 默认评审轮数         |
| MAX_TOKENS                     | 200000       | prompt token 上限    |
| MAX_COMPLETION_TOKENS          | 16384        | 单次补全上限         |

全文件评审(scan)共用同一套框架, 但换了模板键: 多了去重、项目总结, 以及批处理策略与批大小等标量。

### 4.2 effort 如何映射到轮数

effort 只有一个旋钮 MaxReviewRounds, 三档为 1/2/3:

- low: 一轮直出;
- medium(默认): 两轮迭代;
- high: 三轮迭代。

解析优先级为 CLI --effort 高于配置文件, 配置文件高于默认值。因为超时是"分钟数 × 轮数", 轮数同时决定了单组的时间预算——这一点在使用时容易被忽略。

### 4.3 记忆压缩与 token 预算

token 阈值按 MaxTokens 的分数统一定义: 60% 触发异步后台压缩, 80% 触发同步立即压缩。同一个 80% 上限被文件选择的体积闸门、大输入过滤与活动区间计算共用, 保证阈值只有一处定义。压缩按"assistant 消息 + 后续工具结果"的轮次结构切分消息, 保留工具调用链的完整性。

### 4.4 离线 token 计数

token 计数不依赖网络: BPE 编码数据被内嵌进二进制并在初始化时安装为加载器。默认的 tiktoken 首次使用会联网下载编码文件, 失败时静默退化为"字节数除以 4"的估算; 内嵌方案让计数在离线与测试环境都稳定, 也避免成本核算因网络抖动而失真。

## 五、LLM 客户端与 Provider 抽象

### 5.1 四种协议与客户端

协议只有四种, 客户端按协议分派:

| 协议              | 说明                                        |
| ----------------- | ------------------------------------------- |
| anthropic         | 直连 Anthropic Messages API                 |
| anthropic-bedrock | AWS Bedrock 上的 Anthropic 模型, SigV4 签名 |
| openai            | OpenAI Chat Completions 兼容协议            |
| openai-responses  | OpenAI Responses API                        |

几个实现层面的取舍:

- OpenAI 客户端基于官方 SDK, 自动补全路径、带重试与可注入的请求头; 流式开关由请求体控制, 且会默认补齐 usage 统计, 否则部分兼容服务器不返回用量、成本核算会静默丢失。
- Anthropic 客户端处理鉴权头的多种形态并互删冲突头; 因为默认 HTTP 客户端带有较短的响应头超时, 慢端点上的长超时会显式传入带超时设置的客户端。
- Bedrock 客户端不要求 api_key——凭证来自 AWS 环境链自身; 构造失败(如会话过期)延迟到首次请求报错, 而不是构造期 panic。
- Responses 客户端把会话 ID 用作 prompt cache 的键。

整体上, 会话亲和键只在需要显式缓存路由的协议里注入到请求; Anthropic 由服务端管理 prompt cache 亲和。

### 5.2 Provider 注册表

内置 Provider 共 29 个, 每条记录包含名称、显示名、协议、BaseURL、鉴权头、凭据环境变量与候选模型列表:

| 名称                | 显示名                           | 协议              |
| ------------------- | -------------------------------- | ----------------- |
| anthropic           | Anthropic Claude API             | anthropic         |
| bedrock             | AWS Bedrock (Anthropic models)   | anthropic-bedrock |
| openai              | OpenAI API                       | openai            |
| openai-responses    | OpenAI Responses API             | openai-responses  |
| openrouter          | OpenRouter                       | openai            |
| edenai              | Eden AI                          | openai            |
| gemini              | Google Gemini API                | openai            |
| dashscope           | Alibaba DashScope API            | openai            |
| dashscope-tokenplan | Alibaba DashScope Token Plan API | openai            |
| volcengine          | Volcano Engine Ark API           | openai            |
| deepseek            | DeepSeek API                     | openai            |
| tencent-tokenhub    | Tencent TokenHub API             | openai            |
| hy-tokenplan        | Tencent Hunyuan Token Plan API   | openai            |
| iflytek             | iFlytek Spark API                | openai            |
| kimi                | Kimi Moonshot API                | openai            |
| kimi-global         | Kimi Moonshot API (Global)       | openai            |
| z-ai                | Z.AI API                         | openai            |
| z-ai-coding         | Z.AI Coding Plan API             | openai            |
| mimo                | Xiaomi MiMo API                  | openai            |
| minimax             | MiniMax API                      | openai            |
| minimax-cn          | MiniMax CN API                   | openai            |
| baidu-qianfan       | Baidu Qianfan API                | openai            |
| ollama-cloud        | Ollama Cloud API                 | openai            |
| novita              | Novita API                       | openai            |
| xai                 | xAI Grok API                     | openai            |
| litellm             | LiteLLM AI Gateway               | openai            |
| siliconflow         | SiliconFlow API                  | openai            |
| siliconflow-cn      | SiliconFlow CN API               | openai            |
| mistral             | Mistral AI                       | openai            |

即 2 个 Anthropic 系协议、2 个 OpenAI 原生协议, 其余 25 个全部走 OpenAI 兼容协议, 覆盖国内外主流模型网关与订阅制 coding plan。候选模型列表刻意保持精简, 只为选择器 UI 提供种子; 用户可以把模型指向任意名称, 不必受 preset 限制。

### 5.3 端点解析优先级

端点解析按固定顺序尝试四个来源, 第一个凑齐 URL、token 与 model 的胜出: 用户配置文件(~/.opencodereview/config.json)高于 OCR 环境变量(OCR_LLM_URL/TOKEN/MODEL 等), 再高于 Anthropic 风格的环境变量(Claude Code 的 ANTHROPIC_BASE_URL/AUTH_TOKEN/MODEL)与 shell rc 文件兜底。auth token 支持"命令形式"——命令的 stdout 即 token, GitHub Action 正是用它避免把密钥写进配置文件。超时值格式错误会在解析期立即失败, 而不是拖到请求期。

### 5.4 生成物同步纪律

Provider 注册表的变化会波及前端下拉与 IDE 插件: 修改注册表后必须运行代码生成, 产出两个派生文件并一起提交——一个是前端扩展用的 TypeScript 清单, 一个是 IDEA 插件用的 Kotlin 名单。生成器会校验模型列表无重复、原子写文件, 并支持只校验不写入的模式; 持续集成里有专门步骤验证生成物没有过期。这把"多处枚举必须一致"的人工纪律变成了构建期检查。

## 六、规则体系: 四层合成与规则 DSL

### 6.1 四层优先级

规则按优先级从高到低合成:

1. custom: --rule 指定的自定义规则文件;
2. project: 仓库内的 .opencodereview/rule.json;
3. global: 用户级的 rule.json;
4. system: 内嵌的系统默认规则。

项目规则支持一个合并开关: 打开后自定义规则与系统规则合并, 而不是替换。评审工具用自己的规则引擎评审自己, 仓库内的规则文件就用了这个开关。

### 6.2 系统规则与路径映射

系统规则由两部分构成: 一份默认规则加一张路径到规则文件的映射表, 外加按语言/文件类型编写的规则 Markdown(共 54 份)。映射用 glob 把文件路径指到对应规则, 覆盖面包括:

- 主流语言(Go、Java、Rust、Python、TypeScript/JavaScript、Kotlin、C++ 等);
- 构建与包管理文件(pom.xml、build.gradle、package.json、Cargo.toml、composer.json);
- 模板与前端语言(Freemarker、Handlebars/Mustache、Jinja、Pug、Astro 等);
- IaC 与领域 DSL(Terraform、Bicep、Nix、Jsonnet、GraphQL、Prisma、Protobuf、Rego);
- CI 配置、硬件描述语言(Verilog、VHDL)、合约语言(Solidity、Vyper)、翻译文件(po/pot)。

对存在歧义的扩展名, 映射层之外还有一层内容嗅探(例如 .m 文件按内容判断是 Objective-C 还是 MATLAB)来决定用哪份规则。规则解析结果带来源元数据(custom/project/global/system)与命中的 pattern。

### 6.3 allowlist: 静态闸门的数据来源

文件选择用的三份数据都来自 allowlist 目录:

- 扩展名白名单: 决定哪些文件类型进入评审;
- 路径排除模式: doublestar glob 列表;
- 密钥路径模式: 挡住密钥/凭证类文件进入评审上下文。

这是一条与规则体系正交的静态防线: 规则决定"用什么标准审", allowlist 决定"审哪些文件"。

### 6.4 调试入口

ocr rules check 加文件路径会显示该文件最终命中哪条规则。这让规则合成从"黑盒猜"变成可验证的解析结果, 也是自定义规则接入时最常用的排查手段。

## 七、会话持久化、resume 与输出

### 7.1 会话落盘

会话以 JSONL 流式写入用户目录, 按仓库路径分目录, 每会话一个文件; 记录维护父链以保证顺序, 多 goroutine 安全。会话元数据包含会话 ID、仓库目录、分支、模型、LLM 来源、评审模式与 diff 参数, 以及 resume 来源。

### 7.2 resume 语义

- workspace 模式不支持 resume;
- 会校验模式与 diff 参数一致, 并拒绝输入、规则、Provider 或模型与父 run 不匹配的 resume;
- 父 run 全失败也允许 resume——它有可验证的 manifest, 整个选中集可以重新派发, 能否复用 checkpoint 由后续的身份校验决定。

### 7.3 输出格式

前面已列出 text/json/sarif 三种。delegate 模式只支持 text 与 json, 不支持 sarif。会话查看器与导出功能见下一节。

## 八、Session Viewer

ocr viewer 启动一个本地 Web 服务器, 用来查看会话与对比。路由覆盖仓库列表、会话列表、单会话与两个会话的对比; 页面用服务端模板渲染。

安全上做了三件事:

- Host 头白名单默认只认回环地址, 可用环境变量扩展, 用于抵御 DNS rebinding;
- 附加安全响应头;
- 支持把单会话导出为自包含 HTML。

## 九、scan: 全文件评审

scan 面向"没有有意义 diff"的场景: 审计陌生代码库或整个目录。它复用同一套工具循环与工具集, 但把 prompt 里的"变更文件"占位符替换为"全文件扫描模式不适用"。scan 特有机制包括:

| 机制           | 说明                              |
| -------------- | --------------------------------- |
| 批处理策略     | none、按语言、按目录三种分批方式  |
| 每文件预审计划 | 可关                              |
| 每批评论去重   | 可关                              |
| 收尾项目总结   | 可关                              |
| 单文件体积上限 | 独立常量                          |
| 路径过滤       | 逗号分隔的相对目录/文件, 默认全仓 |
| resume         | scan 会话也可续跑                 |

scan 与 review 的成本估算刻意镜像同一组启发式常量, 使两条路径对外的成本预期可比。scan 的 LLM 请求不计入 review 路径的重试报告。

## 十、delegate: 委托模式

delegate 的定位是: OCR 只做确定性部分(文件选择、规则解析), 把评审任务交给宿主 coding agent, 用它自己的 LLM 执行——也就是走宿主的订阅额度, 不需要额外配置 API key。

命令面:

- ocr delegate preview: 输出评审模式、引用元数据、可评审文件列表(路径、状态、增删行数)与被排除文件及原因;
- ocr delegate rule 加文件路径: 按内容分组输出解析后的规则。

规则分组按"来源 + 命中 pattern + 规则正文"三元组聚类: 正文相同但来源或模式不同的文件会分到不同组, 保证每组的元数据对成员都准确。输出渲染成带 Applies to 文件列表的 Markdown 段落, 直接喂给宿主 agent。配套的 skill 教宿主 agent 用 preview 的结果构造 git 命令。

## 十一、GitHub Action 与评论发布

### 11.1 Action 的组织方式

Action 是一个 composite action, 输入覆盖五类: LLM 连接、评审控制(并发、超时、effort、token 预算、语言)、安装与版本、评论发布策略、增量范围; 输出覆盖评论统计、总结评论链接与增量范围元数据。整体分三个层次: 环境准备与安装、评审执行、评论发布。

### 11.2 评审执行中的关键设计

- Fork-safe 检出: 签出受信任的 base 分支, PR head 只通过 git fetch 取 blob, 不把不可信 PR 的代码物化到工作树; 这依赖"OCR 只读 diff, 不执行 PR 代码"这一前提。
- 空 PR 号在评审前就失败: 空号会把评论发到无效的 issues 路径, 返回 404, 导致整轮发现被丢弃。
- 安装后做语义化版本校验: 使用的输入特性(effort、进度流)需要的最低版本会被检查, 旧版本直接失败而不是让 CLI 报未知标志; 实际解析出的版本会写进增量指纹, 升级 OCR 会使旧 checkpoint 失效。
- 配置步骤先清理 runner 上可能残留的 Provider 配置, 再逐项写入; 密钥用"命令取 token"的形式, 不落配置文件。
- 评审默认以 agent 受众运行, 保持 stdout 纯净; 需要把进度写入 workflow 日志时, 用管道同时落盘 stderr 供工件上传。
- 增量范围由 checkpoint 计算, checkpoint 为空时退回全量评审。

### 11.3 评论发布引擎

评论发布是一个零第三方依赖的脚本(只用内置 crypto), 因此能在 github-script 沙箱里直接运行。要点:

- sticky summary: 用一条 HTML 注释标记找到并更新同一条总结评论, 而不是重复发;
- 增量判定: 两条多行评论的行区间 IoU 超过阈值(0.6)视为同一条;
- 批量上限 50: 单次 createReview 的 inline 评论条数上限, 对齐平台的软性限制, 避免部分成功;
- 路由策略: 按严重度与类别把低危、指定类别评论从 inline 改道 summary; 任何解析失败都退化到"不路由", 保证"发布评论"这条主路径永远可走;
- resolve_outdated 用 Map 而非对象字面量存状态, 避免 constructor 这类键从原型链上被误读为"已配置";
- checkpoint 相关输入为空时退回无 checkpoint 行为。

Action 的第三方依赖全部用提交 SHA 钉死并带版本注释, 有脚本在持续集成里校验钉扎。仓库自己用这套 Action 评审自己的 PR。

## 十二、npm 分发与安装

分发拓扑是"壳包 + 平台二进制包": 主包只含启动器与安装脚本, 二进制通过 6 个 optionalDependencies 平台包分发(darwin/linux/windows 各 amd64 与 arm64)。发布时把构建产物拷进平台包、注入版本号、逐个发布, 最后给主包注入可选依赖版本。

安装脚本的逻辑:

1. 若平台包已提供二进制则跳过下载;
2. 平台检测: 把 Node 的架构名映射到目标名, 不支持的组合直接报错;
3. 版本可取环境变量(可钉版本)或包版本;
4. 从发布地址下载二进制, 强制 HTTPS 并限制重定向上限;
5. 下载校验和文件, 比对本地 sha256, 不匹配或找不到条目都删文件报错;
6. 设置可执行权限并打印快速开始。

启动器负责解析真实二进制并转发进程: 子进程被信号杀死时, 退出码映射为 128 加信号编号, 避免流水线把 OOM kill 读成成功; Unix 转发 SIGINT/SIGTERM, Windows 上做特殊处理避免把粗暴终止信号发给子进程; 另外带一个按冷却期的自更新检查, 有新版本就在 stderr 提示。

除 npm 外还有一条二进制直装路径: 安装脚本支持指定安装目录、版本与镜像域名, Windows 有对应的 PowerShell 版本。

## 十三、IDE 扩展与 Agent 插件生态

### 13.1 IDE 扩展

- VS Code 扩展: 贡献活动栏容器与 webview 侧栏, 命令包括发起/取消评审、打开配置、应用/丢弃建议、标记误报, 评论线程菜单按状态条件渲染;
- IDEA 插件: 在 JCEF 浏览器里托管与 VS Code 同一套 Preact webview, 支持三种评审模式、待评审文件预览、自定义提示、流式日志与取消、工具窗口与编辑器内联评论双向同步、插件内配置管理与模型切换;
- 三者共享同一个前端 webview 包, Provider 清单由 Go 注册表生成(见 5.4)。

### 13.2 Agent 插件

面向 coding agent 的插件按平台各有一份清单, 统一要求 git 版本与先装 ocr:

| 平台        | 形态                                                                                 |
| ----------- | ------------------------------------------------------------------------------------ |
| Claude Code | marketplace 插件, 提供 review 与 delegate-review 两个 slash command                  |
| Codex       | 插件清单, 可调用评审 skills                                                          |
| Cursor      | 可移植 skills, 手动安装到本地插件目录                                                |
| Kimi Code   | slash commands 加 skills                                                             |
| OpenCode    | TypeScript 原生插件: 定义输入、spawn ocr、封装退出码与双通道输出, 临时目录清理带重试 |
| QCA Forward | 宿主模型走委托模式, 带可发布模板                                                     |

### 13.3 可移植 skills

两个 skill 是单一事实源, plugins 目录下是其拷贝:

- 标准评审 skill: 在第一步就要求收集业务上下文并作为背景传入; 明确"不要预检 ocr 是否安装", 以省一次工具调用, 仅在命令找不到时才按指引安装; 记录了超时口径(分钟数 × 轮数)与并发默认值;
- 委托模式 skill: 声明不需要配置 LLM 端点, 第一步就是 delegate preview。

## 十四、配置体系与遥测

### 14.1 配置

用户配置是一个 JSON 文件, 字段覆盖: 激活的 Provider 与模型、prompt token 上限、effort、预置 Provider 的覆盖项、自定义 Provider、LLM 连接(url、token、token 命令、鉴权头、协议、超时、额外请求体/头、重试码)、输出语言、遥测选项、MCP 服务器表。

交互入口是 TUI: ocr config provider 与 ocr config model 引导选 Provider、输入 key、选模型并自动连通性测试; 非交互场景用 ocr config set。未知 JSON 字段会被保留, 写回时不丢失, 以避免不同版本间配置被截断。

### 14.2 遥测

遥测默认关闭, 由环境变量开关控制, 可导出到 console 或 OTLP(grpc 与 http 多种协议)。埋点覆盖全链路: diff 解析、评审开始与跳过、每组子任务、主循环、反思、计划、工具调用与重试报告。内容日志可选, 默认不把 prompt/响应正文写进日志。

## 十五、质量保障体系

工程质量约束是这套工具链里比重很大的一块, 且大多在持续集成里强制执行:

- 覆盖率门槛: 覆盖率低于 90% 即失败;
- 源码纯英文检查: 强制源码与注释不含未批准的非英文文本, 翻译目录豁免, 单行可标记豁免;
- 许可证头检查: 按扩展名补 SPDX 头并校验, 新增文件必须带;
- 生成物一致性: 校验 Provider 生成的前端与插件清单没有过期;
- Action 依赖钉扎: 校验第三方 Action 全部用提交 SHA 引用;
- 依赖与静态检查: go mod tidy、格式检查、行尾 LF 检查、go vet、govulncheck;
- 构建与冒烟: 多平台交叉编译加最小冒烟测试。

测试面覆盖三层: Go 核心层大量使用假 LLM 跑重试与进度路径; JS 壳与 Action 脚本各自有独立测试(包括评论发布、契约校验、插件契约、翻译同步); 树外还有插件与扩展的独立流水线。

提交侧还有一套人工纪律(写在给 AI 助手的项目指南里): 提交前必须先自评审; 新文件补许可证头; 行尾统一 LF; 改动文档必须同步多语言翻译; 披露是否使用了 AI、必须理解 AI 写的每一行、禁止"生成→修→修→修"的循环、不给 AI 加署名 trailer。

## 十六、安全设计

完整威胁模型把角色按信任分级: 本地用户可信、LLM Provider 半可信(响应先验证再使用)、git 仓库半可信(diff 可能含对抗内容)、网络不可信(全 TLS)、浏览器不可信(DNS rebinding 风险)。可核对的代码级对策:

- 修订参数校验: --from/--to/--commit 必须是真实提交引用且不得以连字符开头, 以 --end-of-options 传给 git, 防选项注入;
- viewer 的 Host 头回环白名单;
- allowlist 的密钥路径模式挡住密钥文件进评审;
- 安装脚本强制 HTTPS 加 sha256 校验;
- Action 依赖 SHA 钉扎加校验脚本;
- delegate 与 Action 配置步骤刻意不把 token 落盘。

一个需要如实指出的边界: diff 内容可能包含来自仓库的对抗性文本(如注释里的提示注入), 而评审结果最终会作为评论发布。系统的对策是把 LLM 响应当作半可信数据处理(先校验再使用), 但提示注入本身不是这条流水线能彻底消除的风险。

## 十七、总结: 成本与可靠性的取舍

把这条流水线压缩成几个判断:

1. 覆盖度与定位必须是可验证状态, 所以文件选择是纯函数、覆盖度进不可变 manifest、评论定位先走后两级确定性回退;
2. Agent 被限定在窄工具面上, 工具 schema 把定位契约(必须给出与 diff 一致的新增行)写进 prompt, 让"行号"从模型的能力问题变成输出格式约束问题;
3. 成本控制是显式的: effort 控制轮数、token 预算做前瞻截断、记忆压缩有软硬两级阈值、离线 token 计数保证核算不失真; 代价是低召回与"以精确换噪声"的定位;
4. 交付形态刻意做宽: 三种输出格式、composite action、6 平台二进制与 npm 平台包、IDE 扩展与 coding agent 插件、可移植 skills, 以及"只出规格不调 LLM"的 delegate 模式, 让集成方能按自己的额度与合规约束选择接入点;
5. 工程质量靠持续集成强制: 覆盖率、纯英文源码、许可证头、生成物一致性、依赖钉扎都在流水线里卡口, 而不是靠约定。

使用时的现实提醒: Action 的输入面较宽, 建议从仓库内附的 CI 示例起步; 官方路线图与代码现状可能存在滞后, 以代码为准; 从源码直接发布会得到占位版本, 真实版本只存在于发布链路。
