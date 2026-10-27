---
title: "OpenCodeReview: 确定性工程与 Agent 混合的 AI 代码评审 CLI"
description: "拆解 OpenCodeReview 的评审流水线: 确定性工程与 LLM Agent 的分工、Provider 抽象与端点解析、规则体系与 allowlist、评论定位的三级回退、token 预算与 grace round、GitHub Action/npm/IDE/Agent 插件分发, 以及成本与可靠性的取舍"
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

这套架构刻意偏向"以精确换噪声": 宁可少报, 也要让报出的评论落在正确位置、覆盖度可解释。仓库自述的基准测试也印证这个取向——在其 AACR-Bench 数据集(50 个真实仓库、200 个 PR、10 种语言、1505 个问题、80 多名工程师标注)上, 它以约九分之一的 token 消耗取得更高的精确率与 F1, 而召回率偏低是明说的刻意取舍。对需要高召回的审计场景, 更合适的是全文件评审模式(scan), 而不是 diff 评审。

## 二、运行面: 命令、范围与输出契约

### 2.1 命令清单

| 命令                        | 用途                                                                                                                  |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| ocr review (别名 r)         | 基于 diff 的评审, 支持 workspace、--from/--to、--commit 三种范围                                                      |
| ocr scan (别名 s)           | 全文件评审, 不要求 diff                                                                                               |
| ocr delegate (别名 d)       | 只产出评审规格(不调用 LLM), 交给宿主 agent 执行; 子命令 preview 与 rule                                               |
| ocr session (别名 sessions) | 会话管理: list(ls)、show、comments、compare(diff)、export、rm(delete/remove)                                          |
| ocr config                  | 配置管理: set、unset, 以及交互式选 Provider(provider)、选模型(model)                                                  |
| ocr auth                    | Sign in with ChatGPT: login、status、logout、select, 管理 ChatGPT 订阅凭据                                            |
| ocr llm                     | LLM 工具: test(发测试会话并验证一次工具调用往返)、providers(列出内置 Provider)、models(列出当前 ChatGPT 账号可用模型) |
| ocr rules                   | 规则检视: check 查某文件命中哪条规则                                                                                  |
| ocr viewer (别名 v)         | 本地 Web 会话查看器                                                                                                   |
| ocr completion              | shell 补全                                                                                                            |
| ocr version                 | 版本信息                                                                                                              |

进程启动时先把版本号注入 llm 包的全局变量, 再初始化遥测, 并注册一个带 5 秒超时的遥测退出钩子。命令分发前有一个持久化前置步骤: 校验 --color 取值并解析着色决策; 对需要 git 的三个命令(review/scan/delegate)检查本机 git 版本(最低要求 2.41.0), 版本不足只在 stderr 告警, 不阻断执行。

### 2.2 review 的输入范围与标志

review 的三种范围:

- workspace: staged + unstaged + untracked, 默认;
- 区间: --from/--to, 取 merge-base 到目标提交;
- 单提交: --commit/-c, 对其父提交。

标志面按用途分组:

| 分组           | 标志                                                                                                                                                |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 目标与输入     | --repo、--from、--to、--commit、--resume、--background/-b、--background-file/-B(文件优先于字符串)、--exclude                                        |
| 输出           | --format/-f(text/json/sarif)、--audience(human/agent, 默认 human)、--output/-o、--preview/-p                                                        |
| 并发与预算     | --concurrency(默认 8)、--timeout(默认 15 分钟)、--max-tools(0 = 模板默认, 非零最小 50)、--max-git-procs(默认 16)、--max-tokens、--max-tokens-budget |
| 模型           | --provider、--model、--effort(low/medium/high, 空 = 配置或默认 medium)                                                                              |
| 规则与工具定义 | --rule、--tools(自定义工具 JSON 配置, 默认内嵌)、--no-filter                                                                                        |

两条与超时相关的口径值得单独记住:

- 任务级超时: --timeout 的单位是分钟, 单个评审组的实际超时是"分钟数 × 模板轮数", 因此 effort 会同时放大时间预算(见第四节);
- 请求级超时: 独立于任务超时, 由 OCR_LLM_TIMEOUT 或 Provider 配置里的 timeout_sec 控制, 默认 300 秒。

--from/--to/--commit 的取值会走 git 校验: 不得以连字符开头, 且用 `git rev-parse --verify --end-of-options <ref>^{commit}` 确认为真实提交引用, 防止把修订参数注入成 git 选项。--preview 与 --resume 互斥。

### 2.3 退出码、输出格式与 stdout 保护

退出码契约刻意宽松: 只有 run 级失败、或所有选中项都失败时才返回非零; complete/partial/skipped 一律退出 0。这意味着 token 预算导致的受控截断只要还有覆盖, 就仍算成功, 且部分结果会完整发布。

输出分三种:

- text: 人读格式, 按字符宽度折行; 建议代码用行级 diff(Myers 风格 LCS)渲染增删; 无发现时打印 "No comments generated. Looks good to me.";
- json: 顶层含 status、llm、trace_id、summary、tool_calls(total、by_tool、failure、failure_by_tool、failure_details)、comments、groups、warnings、project_summary、resume、session_id、manifest、retry_report; summary 含 files_reviewed、comments、token 用量六项(总量/输入/输出/缓存读/缓存写)与 elapsed、budget_exceeded;
- sarif: 实现 SARIF v2.1.0 的一个子集, 工具名固定为 "OpenCodeReview", 结果指纹键固定为 "ocrFinding/v1", 便于接入代码扫描平台。

输出契约上还有两条: --output 指向的路径延迟到首次写入才创建(失败的 run 不会截断已存在的文件), 但目标是目录或父目录缺失会提前失败; 非机读格式会剥掉 ANSI 控制序列。stdout 的保护分两档: --format 为机读格式时进度整体换道 stderr; --audience 为 agent 时进度直接丢弃——两种情况都保证 stdout 是一份可直接解析的文档。中断处理上, 第一次信号走优雅关闭, 第二次信号强制退出。

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
ocr review --commit abc1234                    # 单提交
ocr review --format json --output result.json  # 机读输出
ocr review --preview                           # 只看文件选择, 不建会话不调 LLM
ocr scan --path internal/agent                 # 全文件评审某目录
ocr delegate preview                           # 只出评审规格, 不需要 LLM
```

会话、配置与凭据数据全部落在用户主目录下的 .opencodereview/ 目录, 删除该目录即完全重置。

## 三、评审流水线: 从 diff 到评论

review 的总编排可以概括为: 解析 diff → 文件选择 → 语义分组 → 并发派发 → 逐组 plan 与多轮工具循环 → 定位并收集评论 → 反思过滤 → 冻结覆盖度。下面按阶段展开, 并标注每个阶段属于确定性工程还是 Agent 决策。

### 3.1 diff 获取(确定性)

diff 来源分三种模式: workspace(staged + unstaged + untracked)、单 commit(对父提交)、区间(merge-base(from,to)..to)。所有 git 子进程走同一个 Runner, 内部用信号量限制并发 git 进程数, 默认 16(--max-git-procs 可调, 0 表示回到默认)。区间模式的公共祖先会被缓存, 避免重复计算。

### 3.2 文件选择(确定性)

选择是评审派发前唯一一次全量确定性决策, 实现为纯函数, 对每个变更文件按固定顺序套用闸门:

1. 二进制文件剔除;
2. 密钥路径模式命中即排除——这道闸门排在用户规则之前, 用户的 include 规则不能把密钥文件放进来;
3. 用户 exclude(命令行 --exclude 与规则文件的排除模式合并);
4. 用户 include;
5. 扩展名白名单: 只有受支持的文件类型进入评审;
6. 默认路径排除(doublestar glob 剔除测试、生成物、testdata 等);
7. 删除文件保留在工作集里供 prompt 引用变更文件列表, 但从不派发评审;
8. 体积闸门: diff 的 token 计数超过 prompt 上限(模板 MaxTokens 的 80%)的文件计入 TooLarge, 全部超限则整轮 skipped。

选择完成后打印一行 `[ocr] N file(s) changed, reviewing M in <仓库>`。选中集为空时按原因记遥测事件(too_large / deleted / no_supported_files), 跳过原因也会出现在 delegate preview 的输出里。

### 3.3 语义分组(Agent, 有兜底)

对较大的变更集, 先把文件元数据(不含 diff 正文)交给 LLM 做语义分组, 让相关文件(message_en.properties 与 message_zh.properties 这类)进入同一评审单元。工程约束有四条:

- 文件数少于 GROUPING_MIN_FILES(4)时不走 LLM: 总变更行数低于 GROUPING_BUNDLE_LINE_THRESHOLD(200)时整体捆成一组("small change set"), 否则退化为每文件一组;
- LLM 返回结构用文件序号而不是路径——序号只花几个输出 token, 路径要全长度, 大变更集的响应才能留在补全上限内;
- 分组调用出任何错都兜底为每文件一组;
- 每组文件数上限为 10, 超出会被拆小; 组内 token 估算超限时也会拆回每文件一组。

### 3.4 并发派发与 token 预算(确定性)

每个分组作为一个独立子任务并发执行, 用信号量限并发(--concurrency, 默认 8)。单组超时是"--timeout 分钟数 × 模板轮数", 与 effort 联动。每个 goroutine 带 panic 隔离: 一组 panic 只标记该组失败(FailurePanic), 不会污染其他组的汇总。

--max-tokens-budget 在拿信号量之前做前瞻检查: 已用 token 加本组估算若超预算, 就停止调度后续组(SetPendingFailureCause 标记为 budget 失败, 而不是 run 级失败), 但允许在飞组跑完, 超支上界是在飞组数。未派发项归为 failed(budget), 终态仍由覆盖度推导, 部分结果照常发布, 退出码为 0——这是"受控覆盖度截断", 不是错误。

每组估算用一组启发式常量: 固定 prompt 开销约 2000 token、每文件约 7 轮主循环、每轮输出约 700 token。它只是数量级下限, 无法覆盖工具调用带来的 prompt 膨胀, 真实用量始终以 API 返回为准; 估算值只在设置了预算时才打印。

### 3.5 组内 plan 与多轮主循环

单组执行分两阶段:

- 计划阶段: 当模板配置了计划任务且改动足够大——单文件变更达到 PLAN_MODE_LINE_THRESHOLD(50)行, 或整组至少 2 个文件且总变更达到 PLAN_MODE_GROUP_LINE_THRESHOLD(100)行——先让模型出一份组级预审计划; 低于阈值直接跳过, 计划失败只告警不中断。计划阶段的工具面是主循环的子集(code_search、file_read_diff、file_find)。
- 主循环: 最多跑 effort 决定的轮数。从第二轮起把计划从 prompt 里剥掉, 防止计划变成覆盖度上限; 同时把上一轮已确认的评论渲染成 confirmed block 注入(最多 30 条, 每条的 existing_code 与 content 分别截断到 200/300 字符), 让模型不要重复报告。组内已确认数达到 30 条, 或某轮没有新发现, 都会提前结束迭代。

主循环每轮把增长的会话整体重发。这看起来浪费, 实际是刻意为之: 重发的前缀正是 Provider prompt cache 的复用单元, 因此会话被绑定到一个缓存亲和键(模板变量 `{ocr_session_key}`: 8 字符会话前缀 + 任务类型 + 16 字符范围摘要, 总长不超过 64 字符), 让每轮路由到同一缓存节点。

循环有三重预算: 工具调用次数上限(MAX_TOOL_REQUEST_TIMES, review 模板为 100)、连续空轮上限(3 次后结束)、以及每轮发请求前的聚合 token 检查——后者把 --max-tokens-budget 的闸门放进了循环内部, 因为一个长分组会在轮间不断膨胀, 只在分组派发前检查的闸门看不见它。

两类声明式预算(工具轮数、聚合 token)耗尽后进入 grace round: 再发一轮只带 code_comment 与 task_done 两个工具的请求, 给模型最后一次机会提交已发现但未报告的评论。grace round 里的成功 task_done 计入任务完成(否则 resume 会把模型已声明完成的文件重跑一遍), 失败的 task_done 两者都不算。无论 grace round 是否完成任务, 都会记录一条 `review_limit_reached` 警告——没有它, 一个由 grace round 完成的任务看起来就和未被截断的评审无法区分。

停止原因由 MainLoopStop 枚举在触发点结构化记录(StopNone/StopMaxRounds/StopEmptyRounds/StopCompression/StopTokenBudget), 其 Reason() 文本是单一事实源: diff 评审的 manifest 与 scan 的子任务警告渲染同一句话。--format json 下丢弃了进度行后, 它是唯一能离开 CI runner 的停止诊断。

### 3.6 工具面(定义确定性, 调用 Agent)

内置工具是固定的窄集合: task_done、code_comment、file_read、file_find、file_read_diff、code_search, 外加 unknown 哨兵。注册表在装配完成后被冻结(Freeze), 运行期不可变更; MCP 动态工具经 Dynamic() 构造, 与保留名冲突直接 panic。

工具的 JSON schema 是确定性定义, 其中 code_comment 把定位契约写进了描述(原文为英文): 核心机制是依据模型给出的 existing_code, 在 diff 文本中用动态滑动窗口匹配连续行, 因此 existing_code 必须与 diff 格式完全一致、只包含新增行。也就是说, "评论要落到哪一行"这件事的一部分责任被工程化地压回了模型的输出格式约束里。每条评论要求 content、existing_code、category、severity、path 五个必填字段; category 枚举(bug/security/performance/maintainability/test/style/documentation/other)与 severity 枚举(critical/high/medium/low)以工具 schema 为单一事实源, GitHub Action 的评论路由逻辑直接复用同一份枚举。task_done 的状态只有 DONE 与 FAILED 两种。

其余工具的确定性体现在: code_search 用 git grep 做全仓搜索并对文件模式做安全校验; file_read_diff 持有一份冻结的只读 diff 快照, 因此模型能读到被过滤文件的 diff——快照按"有效路径"键入, 被删除的文件以其原路径可查, 变更文件列表也把删除文件列在自己的路径下而不是 /dev/null; code_comment 在入收集器前做 schema 校验, 并有一层"工具参数以字符串形式到达且修复后无截断"的确定性修复; 工具参数解析失败时会用括号平衡法从文本里截取 JSON 重试。

这个窄工具面可以被 MCP 扩展: 用户配置里的 mcp_servers 表在评审启动时逐个连接(本地 stdio 或远程 HTTP 两种形态, 初始化超时 5 分钟、请求超时 30 秒), 收集到的工具定义被追加进计划阶段与主循环的工具集, 与内置工具一起暴露给模型。远程服务器缺 URL 等配置错误只告警跳过, 不阻断评审。评审结束时统一关闭: 每个子进程有 800 毫秒终止宽限, 整体关闭上限 2800 毫秒。这让"评审时顺手查一下 issue 系统或内部知识库"成为配置项, 而不需要改动评审流水线本身。

### 3.7 评论定位的三级回退(确定性优先, LLM 兜底)

这是混合架构最典型的一处。每条评论按固定顺序定位:

1. 本文件滑动窗口匹配: 用 existing_code 在当前文件 diff 的 hunk 里做连续行匹配(先新侧后旧侧), hunk 未命中再退化到全文件内容匹配; 空行不打断匹配;
2. 跨文件搜索: 若本文件匹配不到, 在全量 diff 里搜索该片段; 恰好唯一命中时把评论重新归档到真正改动的文件与行(记 `comment_refiled` 警告), 零命中或多命中都拒绝, 且跳过评论自己声明的文件; 探测在副本上做, 不污染原评论;
3. LLM 重定位: 前两级都失败时, 才把 diff、原 existing_code 与评论内容交给 RE_LOCATION_TASK 让模型重新生成精确片段(只取响应的第一个 fenced 代码块), 再回到第一级重试; 重定位失败则恢复原始内容。

跨文件搜索刻意排在 LLM 之前——LLM 步骤会覆写模型给出的原始 existing_code, 而跨文件搜索不依赖模型, 代价更低也更可靠。定位成功后评论进入收集器; 若配置了评论 worker 池, 定位与收集会卸载到池里异步执行, 主工具循环不被阻塞。

### 3.8 反思过滤(Agent)

每轮主循环结束后, 把本轮新增的评论连同组 diff 交给一次反思任务, 过滤低质量评论。--no-filter 可关闭。这是成本与噪声的主要调节阀之一。

### 3.9 收尾: manifest 与覆盖度

结束时先汇合所有可能在 run 边界后仍发请求的后台任务, 再把覆盖度冻结进不可变 manifest, 最后落盘会话结束记录。持久化失败本身算交付错误, 与评审错误用 errors.Join 合并上报——不允许评审错误掩盖"会话没写盘"。重试报告在 run 边界冻结后才渲染。遥测记录文件数、评论数、耗时等指标。

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

全文件评审(scan)共用同一套框架, 但换了模板: 任务集变为 MAIN、PLAN(逐文件预审)、DEDUP(批内去重)、PROJECT_SUMMARY(收尾总结)、MEMORY_COMPRESSION 与 RE_LOCATION, 各自带独立超时(180/90/90/120/120/180 秒); 标量也整体收紧——MAX_TOKENS 58888、MAX_TOOL_REQUEST_TIMES 60、单文件体积上限 2 MiB(MAX_FILE_SIZE_BYTES 2097152)、BATCH_STRATEGY 默认 by-language、BATCH_SIZE 50、批内评论达到 DEDUP_MIN_COMMENTS(4)才触发去重。

### 4.2 effort 如何映射到轮数

effort 只有一个旋钮 MaxReviewRounds, 三档为 1/2/3:

- low: 一轮直出;
- medium(默认): 两轮迭代;
- high: 三轮迭代。

解析优先级为 CLI --effort 高于配置文件, 配置文件高于默认值。因为任务超时是"分钟数 × 轮数", 轮数同时决定了单组的时间预算——这一点在使用时容易被忽略。

### 4.3 记忆压缩与 token 预算

token 阈值按 MaxTokens 的分数统一定义: 60% 触发异步后台压缩, 80% 触发同步立即压缩。同一个 80% 上限(PromptTokenLimit)被文件选择的体积闸门、大输入过滤与活动区间计算共用, 保证阈值只有一处定义。压缩按"assistant 消息 + 后续工具结果"的轮次结构切分消息, 保留工具调用链的完整性; 异步压缩由会话独占, 会话结束时取消在飞任务。

### 4.4 离线 token 计数

token 计数不依赖网络: BPE 编码数据被内嵌进二进制, 并在包初始化时安装为 tiktoken 的加载器。需要注意内嵌范围——只有 cl100k_base 一份编码数据被嵌进二进制; 计数函数按模型名把 o1/o3/o4 系列映射到 o200k_base, 但该编码未内嵌, 加载器会报"未内嵌且离线不可获取"的错误, 此时退化为"字节数除以 4"的估算。内嵌方案让默认编码的计数在离线与测试环境都稳定, 避免成本核算因网络抖动而失真。

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

- OpenAI 客户端基于官方 SDK(openai-go v3), 构造时固定 5 次内部重试(WithMaxRetries), 流式请求默认补发 stream_options.include_usage——否则部分兼容服务器不返回用量、成本核算会静默丢失, 该默认值可被 extra_body 显式覆盖; HTTP 层的响应头超时按"任务超时 + 余量"设置, 与请求级超时解耦。
- Anthropic 客户端处理鉴权头的多种形态(x-api-key 与 authorization)并互删冲突头。
- Bedrock 客户端基于 aws-sdk-go-v2 做 SigV4 签名, 不要求 api_key——凭证来自 AWS 环境链自身(注册表用 AmbientAuth 标记); 构造失败(如会话过期)延迟到首次请求报错, 而不是构造期 panic。
- Responses 客户端以无状态方式工作, 把缓存亲和键作为 prompt_cache_key 发送; 是否发送采样参数(temperature 等)由端点能力标记(RejectsSamplingParams)决定。

整体上, 会话亲和键只在需要显式缓存路由的协议里注入到请求; Anthropic 由服务端管理 prompt cache 亲和。

### 5.2 Provider 注册表

内置 Provider 共 30 个, 每条记录包含名称、显示名、协议、BaseURL、鉴权头、凭据环境变量与候选模型列表:

| 名称                | 显示名                                      | 协议              |
| ------------------- | ------------------------------------------- | ----------------- |
| anthropic           | Anthropic Claude API                        | anthropic         |
| bedrock             | AWS Bedrock (Anthropic models)              | anthropic-bedrock |
| chatgpt             | ChatGPT plan (Sign in with ChatGPT preview) | openai-responses  |
| openai              | OpenAI API                                  | openai            |
| openai-responses    | OpenAI Responses API                        | openai-responses  |
| openrouter          | OpenRouter                                  | openai            |
| edenai              | Eden AI                                     | openai            |
| gemini              | Google Gemini API                           | openai            |
| dashscope           | Alibaba DashScope API                       | openai            |
| dashscope-tokenplan | Alibaba DashScope Token Plan API            | openai            |
| volcengine          | Volcano Engine Ark API                      | openai            |
| deepseek            | DeepSeek API                                | openai            |
| tencent-tokenhub    | Tencent TokenHub API                        | openai            |
| hy-tokenplan        | Tencent Hunyuan Token Plan API              | openai            |
| iflytek             | iFlytek Spark API                           | openai            |
| kimi                | Kimi Moonshot API                           | openai            |
| kimi-global         | Kimi Moonshot API (Global)                  | openai            |
| z-ai                | Z.AI API                                    | openai            |
| z-ai-coding         | Z.AI Coding Plan API                        | openai            |
| mimo                | Xiaomi MiMo API                             | openai            |
| minimax             | MiniMax API                                 | openai            |
| minimax-cn          | MiniMax CN API                              | openai            |
| baidu-qianfan       | Baidu Qianfan API                           | openai            |
| ollama-cloud        | Ollama Cloud API                            | openai            |
| novita              | Novita API                                  | openai            |
| xai                 | xAI Grok API                                | openai            |
| litellm             | LiteLLM AI Gateway                          | openai            |
| siliconflow         | SiliconFlow API                             | openai            |
| siliconflow-cn      | SiliconFlow CN API                          | openai            |
| mistral             | Mistral AI                                  | openai            |

即 1 个 Anthropic 协议与 1 个 Bedrock 变体、2 个 Responses 协议(openai-responses 与 chatgpt), 其余 26 个全部走 OpenAI 兼容协议, 覆盖国内外主流模型网关与订阅制 coding plan。候选模型列表刻意保持精简, 只为选择器 UI 提供种子; 用户可以把模型指向任意名称, 不必受 preset 限制(chatgpt 除外, 见 5.3)。

### 5.3 chatgpt: 订阅制 Provider 与凭据恢复

chatgpt provider 把评审接到用户的 ChatGPT 订阅额度上, 走公共 Responses 端点(https://api.openai.com/v1), 不需要另外的 API key。它在注册表里用三个能力标记区别于其它 Provider: ExternalAuth(凭据来自外部登录而非环境变量或配置文件)、RequiresStreaming(强制流式)与 RejectsSamplingParams(拒绝采样参数)。解析路径上它被硬约束: url、protocol 与任何凭据覆盖字段(api_key、api_key_cmd、auth_header)都不可配置——只允许受保护的凭据存储加公共端点; extra_body 只接受 reasoning、text、prompt_cache_key 三个键, extra_headers 不能覆盖保留头与 Host; 候选模型列表为空——可用模型来自当前账号的目录(ocr llm models 拉取), 配置里没写模型时自动取目录第一项, 目录为空则报错让用户显式配置。

登录面是 ocr auth 命令组: login(本地浏览器 loopback OAuth, --no-browser 改打一次性 URL, 预览期不支持 device 流)、status、logout、select(在多个已保存注册间切换), 均带 --provider chatgpt 与 --account 选择器。凭据存在 ~/.opencodereview/auth/chatgpt 下(accounts.json 加文件锁), OAuth 发现文档的 issuer 与端点同源校验后才使用。

刷新与恢复的约束比"到期就刷新"严得多:

- 刷新窗口由过期时间与 issuer 下发的 earliest_refresh_at 共同决定, 早于后者不刷新;
- 刷新响应先落盘为 PendingRefresh 再验证身份: ID token 的主体变化或 nonce 不一致会被拒绝并标记, 后续直接要求重新登录而不是无限重试; 身份验证通过前, 新凭据不暴露给推理使用;
- 终止性刷新错误(invalid_grant、token_expired、refresh_token_reused 等)直接清空本地凭据;
- 验证后发现 access token 仍需刷新时, 重试一次凭据获取;
- plan 用量未授权(PlanEnabled 为假)时, 所有报错都指向同一句修复指引: 用 --enable-plan 重新登录或改用 API-key provider。

诊断输出经过脱敏: 错误体按形状分类, 敏感字段(access/refresh/id token)在任何诊断文本中都不出现, 控制字符被清洗、长度被截断。

### 5.4 端点解析优先级

端点解析按固定顺序尝试四个来源, 第一个凑齐"URL + token + model"的胜出(AmbientAuth 端点如 bedrock 只需 model 即算完整):

1. 用户配置文件(~/.opencodereview/config.json);
2. OCR 环境变量: OCR_LLM_URL、OCR_LLM_TOKEN、OCR_LLM_MODEL、OCR_LLM_AUTH_HEADER、OCR_LLM_PROTOCOL、OCR_USE_ANTHROPIC;
3. Anthropic 风格环境变量(即 [claude-code](./claude-code) 使用的 ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN/ANTHROPIC_MODEL);
4. shell rc 文件兜底(在 ~/.zshrc、~/.bashrc 里找 Anthropic 风格导出)。

显式 --provider 绕过这套顺序, 直接要求配置文件中存在对应 provider 条目; chatgpt 命中时走 5.3 的订阅凭据路径。全局环境覆盖(OCR_LLM_TIMEOUT、OCR_LLM_EXTRA_HEADERS)在任何策略运行前先解析——避免 api_key_cmd 已经弹出凭据提示后才因格式错误丢弃整个解析。auth token 支持"命令形式"(api_key_cmd / auth_token_cmd): 命令的 stdout 即 token, GitHub Action 正是用它避免把密钥写进配置文件。

### 5.5 生成物同步纪律

Provider 注册表的变化会波及前端下拉与 IDE 插件: 修改注册表后必须运行代码生成(go generate ./internal/llm), 产出两个派生文件并一起提交——一个是前端扩展用的 TypeScript 清单(providers.generated.ts), 一个是 IDEA 插件用的 Kotlin 名单(ProviderNames.generated.kt)。生成器会校验模型列表无重复、原子写文件, 并支持只校验不写入的模式; 持续集成里有专门步骤验证生成物没有过期。这把"多处枚举必须一致"的人工纪律变成了构建期检查。

## 六、规则体系: 四层合成与 allowlist

### 6.1 四层优先级

规则按优先级从高到低合成:

1. custom: --rule 指定的自定义规则文件;
2. project: 仓库内的 .opencodereview/rule.json;
3. global: 用户级的 ~/.opencodereview/rule.json;
4. system: 内嵌的系统默认规则。

规则条目支持 merge_system_rule 开关: 打开后自定义规则与命中的系统规则合并, 而不是替换。评审工具用自己的规则引擎评审自己, 仓库内的规则文件(例如针对 providers.go 的"注册表改动必须同步生成物与测试"规则)就用了这个开关。文件过滤器(include/exclude)取自优先级最高的一层。

### 6.2 系统规则与路径映射

系统规则由三部分构成: 一份默认规则(default.md)、一张路径 glob 到规则文件的映射表(path_rule_map), 以及按语言/文件类型编写的规则 Markdown(共 57 份)。映射覆盖面包括:

- 主流语言(Go、Java、Rust、Python、TypeScript/JavaScript、Kotlin、C++ 等);
- 构建与包管理文件(pom.xml、build.gradle、package.json、Cargo.toml、composer.json);
- 模板与前端语言(Freemarker、Handlebars/Mustache、Jinja、Pug、Astro 等);
- IaC 与领域 DSL(Terraform、Bicep、Nix、Jsonnet、GraphQL、Prisma、Protobuf、Rego);
- CI 配置、硬件描述语言(Verilog、VHDL)、合约语言(Solidity、Vyper)、翻译文件(po/pot)。

对存在歧义的扩展名, 映射层之外还有一层内容嗅探: .m 文件默认指向 matlab.md, 嗅探器按内容特征改判为 Objective-C 时切到 objc.md。规则解析结果带来源元数据(custom/project/global/system)与命中的 pattern, 这正是 delegate rule 分组(见第十节)与 ocr rules check 的数据基础。

### 6.3 allowlist: 静态闸门的数据来源

文件选择用的三份数据都来自 allowlist 目录:

- 扩展名白名单: 决定哪些文件类型进入评审;
- 路径排除模式: doublestar glob 列表(单段星号、双星跨段、花括号展开), 覆盖测试、生成物、testdata 等;
- 密钥路径模式: 独立成文件, 覆盖 SSH 目录、私钥文件(id_rsa/id_dsa/id_ecdsa/id_ed25519)、.netrc/_netrc、.npmrc、.pypirc、.dockercfg 等。与排除模式分开存放是刻意的: 排除模式可以被用户 include 规则豁免, 密钥模式无条件生效, include 无法把它放进来。

这是一条与规则体系正交的静态防线: 规则决定"用什么标准审", allowlist 决定"审哪些文件"。

### 6.4 调试入口

`ocr rules check <文件路径>` 会显示该文件最终命中哪条规则、来自哪一层。这让规则合成从"黑盒猜"变成可验证的解析结果, 也是自定义规则接入时最常用的排查手段。

## 七、会话持久化、resume 与输出

### 7.1 会话落盘

会话以 JSONL 流式写入 `$HOME/.opencodereview/sessions/<编码后的仓库路径>/<会话id>.jsonl`, 按仓库分目录、每会话一个文件; 记录维护父链以保证顺序, 多 goroutine 安全。记录种类覆盖 session_start、逐条评审结果(review_item_done/reused/failed)、LLM 请求与响应(llm_request/response/error)与工具调用(tool_call)。会话元数据包含会话 ID、仓库目录、分支、模型、LLM 来源、评审模式与 diff 参数, 以及 resume 来源。

### 7.2 resume 语义

- workspace 模式不支持 resume(工作区内容会变, 没有可复现的输入); range 与 commit 模式支持, scan 也支持;
- 恢复前校验身份: 模式与 diff 参数必须一致, 输入、规则、Provider 或模型与父 run 不匹配的 resume 被拒绝;
- 父 run 全失败也允许 resume——它有可验证的 manifest, 整个选中集可以重新派发, 能否复用 checkpoint 由身份校验决定;
- resume 后输入被"封印": file_read 等工具固定在父 run 的提交引用上读文件, 工作区后续改动不会渗进恢复的评审;
- 失败时 stderr 打印 `retry with: --resume <会话id>`, 也可以事后用 ocr session list 找回。

### 7.3 输出与查看

text/json/sarif 三种格式见 2.3; delegate 模式只支持 text 与 json, 不支持 sarif。历史会话的回看走 session 子命令(list/show/comments/compare/export/rm)或第八节的 Web Viewer。

## 八、Session Viewer

ocr viewer(别名 v)启动一个本地 Web 服务器, 默认监听 localhost:5483(--addr 可改), --open 控制浏览器行为(auto 只在带显示的本地终端打开、always 强制、never 只打印 URL)。路由用标准库的 ServeMux 模式注册:

| 路由                        | 用途           |
| --------------------------- | -------------- |
| `GET /`                     | 仓库列表       |
| `GET /r/{repo}`             | 单仓库会话列表 |
| `GET /r/{repo}/compare`     | 两个会话的对比 |
| `GET /r/{repo}/{sessionID}` | 单会话详情     |
| `GET /static/`              | 内嵌静态资源   |

安全上做了三件事:

- Host 头白名单默认只认回环地址, 可用 OCR_VIEWER_ALLOWED_HOSTS 扩展, 用于抵御 DNS rebinding;
- 附加安全响应头;
- 支持把单会话导出为自包含 HTML, 离线可读。

## 九、scan: 全文件评审

scan 面向"没有有意义 diff"的场景: 审计陌生代码库或整个目录。它复用同一套工具循环与工具集, 但把 prompt 里的"变更文件"占位符替换为固定文案 "(not applicable in full-scan mode)"。scan 特有的机制与标志:

| 机制           | 说明                                                                        |
| -------------- | --------------------------------------------------------------------------- |
| 路径过滤       | --path 接逗号分隔的仓库相对目录/文件, 默认全仓; 路径不存在直接报错          |
| 批处理策略     | --batch 覆盖模板 BATCH_STRATEGY: none、by-language、by-directory, 批大小 50 |
| 每文件预审计划 | PLAN_TASK 逐文件出检查清单, --no-plan 可关                                  |
| 每批评论去重   | DEDUP_TASK 聚合近似重复评论, 批内评论达到 4 条才触发, --no-dedup 可关       |
| 收尾项目总结   | PROJECT_SUMMARY_TASK 汇总跨文件模式, --no-summary 可关                      |
| 单文件体积上限 | 独立常量 2 MiB, 且渲染后的提示词也受 80% token 上限约束                     |
| resume         | scan 会话可续跑, 没有已完成项的会话拒绝恢复                                 |

scan 与 review 的成本估算刻意镜像同一组启发式常量, 使两条路径对外的成本预期可比; scan 的 LLM 请求不计入 review 路径的重试报告。失败语义上有两条明确的规则:

- 渲染后的提示词溢出(组装规则、计划与全文件内容后超过 MaxTokens 的 80%)记为该文件的失败评审: 它进 `token_threshold_exceeded` 警告与 `scan_subtask_error`, 写入失败记录, 并计入"全部失败"判定——不是静默跳过;
- 循环内部的 token 预算停止(StopTokenBudget)会上报到 run 级的 BudgetExceeded() 与 token_budget_reached 警告, 与 review 路径对齐, 否则 --format json 下的 budget_exceeded 字段会谎报 false。

## 十、delegate: 委托模式

delegate 的定位是: OCR 只做确定性部分(文件选择、规则解析), 把评审任务交给宿主 coding agent, 用它自己的 LLM 执行——也就是走宿主的订阅额度, 不需要额外配置 API key。

命令面有两个子命令:

- `ocr delegate preview`: 输出评审模式、引用元数据、可评审文件列表(路径、状态、增删行数)与被排除文件及原因(too_large/deleted/no_supported_files);
- `ocr delegate rule <路径...>`: 按内容分组输出解析后的规则。

规则分组按"来源 + 命中 pattern + 规则正文"三元组聚类: 正文相同但来源或模式不同的文件会分到不同组, 保证每组的元数据对成员都准确; 没有命中任何规则的文件归入 system/default 组。输出渲染成带 Applies to 文件列表的 Markdown 段落, 直接喂给宿主 agent。配套的 skill 教宿主 agent 用 preview 的结果构造 git 命令执行评审(见 13.3)。

## 十一、GitHub Action 与评论发布

### 11.1 Action 的组织方式

Action 是一个 composite action, 输入覆盖五类: LLM 连接、评审控制(并发、超时、effort、token 预算、语言)、安装与版本、评论发布策略、增量范围; 输出覆盖评论统计、总结评论链接与增量范围元数据。整体分三个层次: 环境准备与安装、评审执行、评论发布。

### 11.2 评审执行中的关键设计

- Fork-safe 检出: 签出受信任的 base 分支, PR head 只通过 `git fetch origin "pull/<PR号>/head"` 取 blob, 不把不可信 PR 的代码物化到工作树; 这依赖"OCR 只读 diff, 不执行 PR 代码"这一前提。
- PR 号为空或非法在评审前就失败: 空号会把评论发到无效的 issues 路径, 返回 404, 导致整轮发现被丢弃。
- 安装后做语义化版本校验: 有全局最低版本(v1.9.6), 各输入特性再叠加自己的门槛——effort 需要 v1.10.0, 进度流需要 v1.9.8; 版本不满足直接失败而不是让 CLI 报未知标志。实际解析出的版本会写进增量 checkpoint 指纹, 升级 OCR 会使旧 checkpoint 失效。
- 任务超时输入(review_task_timeout)限定在 1–120 分钟; llm_reasoning_effort 接受 minimal/low/medium/high/max。
- 配置步骤先清理 runner 上可能残留的 Provider 配置, 再逐项写入; 密钥用"命令取 token"(auth_token_cmd)的形式, 不落配置文件。
- 评审默认以 agent 受众运行, 保持 stdout 纯净; 需要把进度写入 workflow 日志时, 用管道同时落盘 stderr 供工件上传。
- 增量范围由 checkpoint_range 计算, checkpoint 为空时退回全量评审。

### 11.3 评论发布引擎

评论发布是一个零第三方依赖的脚本(只用 Node 内置模块与 crypto), 因此能在 github-script 沙箱里直接运行。要点:

- sticky summary: 用一条 HTML 注释标记找到并更新同一条总结评论, 而不是重复发;
- 增量判定: 两条多行评论的行区间 IoU 超过阈值(0.6)视为同一条;
- 批量上限 50: 单次 createReview 的 inline 评论条数上限, 对齐平台的软性限制, 避免部分成功;
- 路由策略: 按严重度与类别把低危、指定类别评论从 inline 改道 summary; 任何解析失败都退化到"不路由", 保证"发布评论"这条主路径永远可走;
- resolve_outdated 等模式表用 Map 而非对象字面量存状态, 避免 constructor 这类键从原型链上被误读为"已配置";
- checkpoint 相关输入为空时退回无 checkpoint 行为。

Action 的第三方依赖全部用提交 SHA 钉死并带版本注释, 有脚本在持续集成里校验钉扎。仓库自己用这套 Action 评审自己的 PR。

## 十二、npm 分发与安装

分发拓扑是"壳包 + 平台二进制包": 主包 @alibaba-group/open-code-review 只含启动器与安装脚本, 二进制通过 6 个 optionalDependencies 平台包分发(darwin/linux/win32 各 arm64 与 x64)。发布时把构建产物拷进平台包、注入版本号、逐个发布, 最后给主包注入可选依赖版本。发布凭据走 npm trusted publishing: CI 用 GitHub OIDC token 换取 npm 发布凭据, 取代长期的 NPM_TOKEN secret; 发布命令带 `--access public --provenance`。另有一条手动触发的校验任务, 逐个包验证 trusted publisher 配置是否可用而不实际发布——npm 只接受云托管 runner 的 OIDC 交换, 因此这两个 JS 侧任务跑在 ubuntu-latest, Go 构建矩阵保持 self-hosted。

安装脚本的逻辑:

1. 若平台包已提供二进制则跳过下载;
2. 平台检测: 把 Node 的架构名映射到目标名(x64→amd64、win32→windows), 不支持的组合直接报错;
3. 版本可取环境变量 OCR_VERSION(可钉版本)或包版本;
4. 从 GitHub Releases 下载二进制, 强制 HTTPS 并限制重定向上限(10 次);
5. 下载校验和文件, 比对本地 sha256, 不匹配或找不到条目都删文件报错;
6. 设置可执行权限并打印快速开始。

启动器负责解析真实二进制并转发进程: 子进程被信号杀死时, 退出码映射为 128 加信号编号, 避免流水线把 OOM kill 读成成功; Unix 转发 SIGINT/SIGTERM, Windows 上把 SIGINT 注册为 no-op 避免把粗暴终止信号发给子进程; 另外带一个按冷却期的自更新检查, 有新版本就在 stderr 提示。

除 npm 外还有一条二进制直装路径: 安装脚本支持指定安装目录、版本与镜像域名, Windows 有对应的 PowerShell 版本。版本号由发布链路经 ldflags 注入, 从源码直接构建得到的二进制报告占位版本 "dev"。

## 十三、IDE 扩展与 Agent 插件生态

### 13.1 IDE 扩展

- VS Code 扩展: 贡献活动栏容器与 webview 侧栏(ocr.sidebar), 命令包括发起/取消评审(ocr.review.start / ocr.review.cancel)、打开配置(ocr.config.open)、应用/丢弃建议与标记误报(ocr.comment.apply / discard / falsePositive), 评论线程菜单按状态条件渲染; 界面文案带日/韩/俄/中四语 nls 资源;
- IDEA 插件: Kotlin 实现, 在 JCEF 浏览器里托管与 VS Code 同一套 Preact webview, 支持评审模式选择、待评审文件预览、自定义提示、流式日志与取消、工具窗口与编辑器内联评论双向同步、插件内配置管理与模型切换;
- 两者共享 extensions/frontend 这个 Preact(10.29.x)webview 包, 按目标宿主(OCR_TARGET)构建; Provider 清单由 Go 注册表生成(见 5.5)。

### 13.2 Agent 插件

面向 coding agent 的插件按平台各有一份清单, 统一要求 git 版本达标并先安装 ocr:

| 平台        | 形态                                                                                                 |
| ----------- | ---------------------------------------------------------------------------------------------------- |
| Claude Code | marketplace 插件, 提供 review 与 delegate-review 两个 slash command, 见 [claude-code](./claude-code) |
| Codex       | .codex-plugin 清单, 可调用评审 skills                                                                |
| Cursor      | .cursor-plugin, 可移植 skills 手动安装到本地插件目录                                                 |
| Kimi Code   | .kimi-plugin 清单, slash commands 加 skills                                                          |
| OpenCode    | TypeScript 原生插件: 定义输入、spawn ocr、封装退出码与双通道输出, 临时目录清理带重试                 |
| QCA Forward | 宿主模型走委托模式, 带可发布模板(template.example.json 与 system-prompt.md)                          |
| ACP 客户端  | 独立模块 acp/ 提供 Agent Client Protocol 适配器(见 13.4)                                             |

### 13.3 可移植 skills

skills/ 目录下的两个 skill 是单一事实源, plugins/ 目录下各平台的版本是其拷贝:

- 标准评审 skill: 第一步就要求分析评审目标、收集业务上下文并经 --background 传入; 明确"不要预检 ocr 是否安装"(省一次工具调用, 命令找不到再按 Troubleshooting 安装); 记录了超时口径(分钟数 × 轮数, 默认 15 × 2)、并发默认值(8); 要求 --audience agent 保持输出干净、大评审用 --output 落盘防止截断, 并给出按 severity 分组呈现、丢弃 low 级噪声项的报告模板与"先问再修"的修复流程;
- 委托模式 skill: 声明不需要配置 LLM 端点, 第一步就是 delegate preview。

### 13.4 ACP 适配器

acp/ 是一个独立的 Go 模块, 把 OCR 包装成 Agent Client Protocol 服务(ocr-acp 二进制), 供支持 ACP v1 stdio 的客户端接入。当前标记为实验性且不稳定, 只支持从源码构建(make -C acp build), 不参与根仓库的 CI(嵌套模块由专属 workflow 覆盖, 覆盖率门槛同为 90%)。

架构上它不修改 OCR 的评审引擎、prompt 或进度输出, 而是通过进程编排复用 CLI:

- transport 层实现 SDK agent 接口与原子命令发现, 通过 available_commands_update 暴露 /review 与 /scan 两个命令(带参数提示: --commit、--from/--to、--effort、--path、--batch);
- intent 层把自然语言提示解析成结构化意图、澄清或拒绝(配独立的模型配置);
- orchestrator 拥有 OCR 进程生命周期与结果解码的决策权, process 子包只负责跨平台的进程树操作(macOS/Linux 用进程组, Windows 用 Job Objects 加可取消 stdio);
- adapter/workspace 提供结果根、安全文件位置与文件 URL: review 相对 Git 根解析、scan 相对会话 cwd 解析; 评审发现只在最终消息中一次性输出, 可安全导航的位置渲染成 Markdown 文件链接。

## 十四、配置体系与遥测

### 14.1 配置

用户配置是 ~/.opencodereview/config.json, 字段覆盖: 激活的 provider 与 model、prompt token 上限(max_tokens)、effort、预置 Provider 的覆盖项(providers)、自定义 Provider(custom_providers)、LLM 连接(llm: url、auth_token、auth_token_cmd、auth_header、model、protocol、use_anthropic、timeout_sec、extra_body、extra_headers、retry_codes)、评论语言(language, 默认 English, 接受任意语言名)、遥测选项(telemetry)、MCP 服务器表(mcp_servers)。

交互入口是 TUI: ocr config provider 与 ocr config model 引导选 Provider、输入 key、选模型并自动连通性测试; 非交互场景用 ocr config set/unset。未知 JSON 字段会被保留, 写回时不丢失, 以避免不同版本间配置被截断。

ocr config set 的键路径解析支持名称含点的自定义 Provider: `providers.<name>.<field>` 与 `custom_providers.<name>.<field>` 以最后一个点分割名称与字段(而非固定切三段), 因此像 my.company 这样的 Provider 名不会把第一段错当成字段名; 名称中每个以点分隔的段不得为空或纯空白。预置 Provider 走其固定字段, 非预置名称则当作自定义 Provider 字段写入。

### 14.2 遥测

遥测基于 OpenTelemetry, 默认关闭, 解析优先级为默认值低于 config.json 的 telemetry 段、再低于环境变量: OCR_ENABLE_TELEMETRY=1 打开总开关; OTEL_SERVICE_NAME 覆盖服务名(默认 open-code-review); OTEL_EXPORTER_OTLP_ENDPOINT 非空时自动切到 otlp 导出器; OTEL_EXPORTER_OTLP_PROTOCOL 支持 grpc(默认)、http/protobuf、http/json; OCR_CONTENT_LOGGING=1 才把 prompt/响应正文写进日志事件(默认不写)。span 上下文可从 TRACEPARENT 环境变量接续, 便于嵌进已有的分布式追踪。主进程退出前有带超时的遥测冲刷钩子(见 2.1)。埋点覆盖全链路: diff 解析、评审开始与跳过、每组子任务、主循环、反思、计划、工具调用与重试报告。

## 十五、质量保障体系

工程质量约束是这套工具链里比重很大的一块, 且大多在持续集成里强制执行:

- 覆盖率门槛: 低于 90% 即失败;
- 源码纯英文检查: 强制源码与注释不含未批准的非英文文本, 翻译目录豁免, 单行可标记豁免;
- 许可证头检查: 按扩展名补 SPDX 头并校验, 新增文件必须带;
- 生成物一致性: 校验 Provider 生成的 TypeScript 与 Kotlin 清单没有过期;
- Action 依赖钉扎: 校验第三方 Action 全部用提交 SHA 引用;
- 依赖与静态检查: go mod tidy、格式检查、行尾 LF 检查、go vet、govulncheck;
- 构建与冒烟: 多平台交叉编译加最小冒烟测试。

测试面覆盖三层: Go 核心层大量使用假 LLM 跑重试与进度路径; JS 壳与 Action 脚本各自有独立测试(包括评论发布、契约校验、插件契约、翻译同步); 树外还有插件与扩展的独立流水线。

提交侧还有一套人工纪律(写在仓库根目录给 AI 助手的项目指南 AGENTS.md 里): 提交前必须先用自己的评审工具自评审; 新文件补许可证头; 行尾统一 LF; 改动文档必须同步 README 的多语言版本; 披露是否使用了 AI、必须理解 AI 写的每一行、禁止"生成→修→修→修"的循环、不给 AI 加署名 trailer。

## 十六、安全设计

完整威胁模型把角色按信任分级: 本地用户可信、LLM Provider 半可信(响应先验证再使用)、git 仓库半可信(diff 可能含对抗内容)、网络不可信(全 TLS)、浏览器不可信(DNS rebinding 风险)。可核对的代码级对策:

- 修订参数校验: --from/--to/--commit 不得以连字符开头, 且必须通过带 --end-of-options 的 rev-parse 验证为真实提交, 防选项注入;
- viewer 的 Host 头回环白名单(OCR_VIEWER_ALLOWED_HOSTS 可扩展);
- allowlist 的密钥路径模式排在用户 include 之前, 密钥文件进不了评审上下文;
- 安装脚本强制 HTTPS 加 sha256 校验、限制重定向;
- Action 依赖 SHA 钉扎加校验脚本, fork PR 的代码不物化到工作树;
- delegate 与 Action 配置步骤用 auth_token_cmd 形式取密钥, 刻意不把 token 落盘;
- chatgpt 凭据的身份验证、终止性错误清库与诊断脱敏(见 5.3)。

一个需要如实指出的边界: diff 内容可能包含来自仓库的对抗性文本(如注释里的提示注入), 而评审结果最终会作为评论发布。系统的对策是把 LLM 响应当作半可信数据处理(先校验再使用), 但提示注入本身不是这条流水线能彻底消除的风险。

## 十七、总结: 成本与可靠性的取舍

把这条流水线压缩成几个判断:

1. 覆盖度与定位必须是可验证状态, 所以文件选择是纯函数、覆盖度进不可变 manifest、评论定位先走两级确定性回退再轮到 LLM;
2. Agent 被限定在窄工具面上, 工具 schema 把定位契约(existing_code 必须与 diff 一致且只含新增行)写进 prompt, 让"行号"从模型的能力问题变成输出格式约束问题;
3. 成本控制是显式的: effort 控制轮数、token 预算在派发前与循环内双重前瞻截断、grace round 保证截断不丢已发现的评论、记忆压缩有 60%/80% 两级阈值、离线 token 计数保证核算不失真; 代价是低召回与"以精确换噪声"的定位;
4. 交付形态刻意做宽: 三种输出格式、composite action、6 平台二进制与 npm 平台包、IDE 扩展与 coding agent 插件、可移植 skills, 以及"只出规格不调 LLM"的 delegate 模式, 让集成方能按自己的额度与合规约束选择接入点;
5. 工程质量靠持续集成强制: 覆盖率、纯英文源码、许可证头、生成物一致性、依赖钉扎都在流水线里卡口, 而不是靠约定。

使用时的现实提醒: Action 的输入面较宽, 建议从仓库内附的 CI 示例起步; 从源码直接构建的二进制报告 "dev" 版本, 真实版本号只存在于发布链路, 依赖版本门槛的 Action 用户应通过安装步骤取得正式版本。
