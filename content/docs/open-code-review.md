---
title: "OpenCodeReview 调研: 确定性工程与 Agent 混合架构的 AI 代码评审 CLI"
description: "alibaba/open-code-review 调研: Go CLI ocr 的评审流水线、Provider 体系、GitHub Action、npm 分发与 IDE/Agent 插件生态"
---

仓库路径: https://github.com/alibaba/open-code-review (本机克隆位于 $HOME/Downloads/open-code-review)

## 一、项目快照 (本机克隆 HEAD a758d9c, 2026-09-29)

本机克隆 HEAD 为 a758d9c (完整哈希 a758d9cbfb689937c7857ad64b2dd66adb58c0c2, 提交主题 "feat(allowlist): add Jinja template support (#1056)", 2026-09-29), 分支 main, 上游为 git@github.com:alibaba/open-code-review.git。

| 指标       | 数值                                                                              | 出处                                                              |
| ---------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| 定位       | AI 代码评审 CLI 工具, 阿里集团内部官方 AI code review 助手开源化                  | README.md                                                         |
| 命令名     | ocr                                                                               | cmd/opencodereview/root.go rootCmd.Use                            |
| npm 包     | @alibaba-group/open-code-review, bin 字段 ocr 指向 bin/ocr.js                     | package.json                                                      |
| npm 版本   | 仓库内 package.json 版本为 0.0.0 占位, 发布时由 CI 注入 tag 版本                  | package.json、.github/workflows/release.yml npm-publish job       |
| Go module  | github.com/alibaba/open-code-review, go 1.25.5                                    | go.mod                                                            |
| License    | Apache-2.0 (Copyright 2026 Alibaba)                                               | LICENSE、README.md 末尾                                           |
| 支持平台   | darwin/linux/windows 各 amd64 与 arm64, 共 6 个                                   | .github/workflows/release.yml build matrix、npm/ 目录             |
| 运行时依赖 | Git >= 2.41 (评审依赖 git 生成 diff、搜索与仓库操作)                              | README.md Prerequisites、internal/gitcmd/version.go gitVersionMin |
| Node 要求  | npm 壳 engines.node >= 14                                                         | package.json                                                      |
| 官网       | https://open-codereview.ai                                                        | README.md                                                         |
| 代码规模   | 363 个 Go 文件 (cmd 95 个 + internal 267 个 + scripts 1 个), 其中 233 个 _test.go | find 统计, 不含 pages/ 与 node_modules                            |
| 资质徽章   | OpenSSF Best Practices Gold                                                       | README.md badge 链接                                              |

项目出身写在 README 的 "What is Open Code Review?" 一节: 它源自阿里集团内部的官方 AI code review 助手, 过去两年服务了数万名开发者、识别出数百万个代码缺陷, 经过大规模验证后孵化为开源项目。README 同时给出与通用 Agent (Claude Code) 对比的 benchmark 结论: 在相同底层模型下, OCR 的 Precision 与 F1 显著更高, token 消耗约为通用 Agent 的 1/9, 完成速度更快, 但 Recall 较低 — README 明确说这是"以精确换噪声"的刻意取舍。基准集 AACR-Bench 由 50 个流行开源仓库、200 个真实 PR、10 种编程语言构成, 经 80+ 资深工程师交叉验证出 1505 条标注 ground-truth issues, 数据集 Alibaba-Aone/aacr-bench 发布在 Hugging Face。

产品哲学 (README "Why Open Code Review?" 一节): 通用 Agent 做代码评审有三个痛点 — 大变更集覆盖不全、报告位置漂移、自然语言驱动的 Skills 质量不稳定; 根因是"纯语言驱动架构对评审过程缺乏硬约束"。OCR 的回应是确定性工程 (Deterministic Engineering) 与 Agent 混合: 文件选择、文件分捆、规则匹配、评论定位与反思这些"不能出错"的环节由工程代码保证; 场景调优的 prompt 与工具集交给 Agent。README 还强调工具集是"从大规模生产数据的工具调用 trace 蒸馏出来的", 包含调用频率分布、单工具重复率等分析结论。

## 二、仓库结构与模块划分

仓库根目录 (ls -la 核实):

| 路径                      | 内容                                                                                                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| cmd/opencodereview/       | CLI 入口, cobra 命令实现                                                                                                                                           |
| internal/                 | 全部 Go 核心逻辑 (agent、diff、llm、llmloop、session、tool、mcp、scan、delegate、viewer、telemetry、config、model、gitcmd、pathutil、stdout、suggestdiff、release) |
| bin/ocr.js                | npm 全局安装后的 JS 启动器                                                                                                                                         |
| npm/                      | 6 个平台二进制的 npm 壳包源 (darwin-arm64/darwin-x64/linux-arm64/linux-x64/win32-arm64/win32-x64)                                                                  |
| scripts/                  | install.js、update.js、version.js、platform.js 与 github-actions/、publish/ 辅助脚本                                                                               |
| action.yml                | 1094 行的 GitHub composite action                                                                                                                                  |
| extensions/               | vscode 扩展、idea 插件、frontend 共享 Preact webview                                                                                                               |
| plugins/open-code-review/ | Claude Code、Codex、Cursor、Kimi Code、OpenCode、QCA Forward 插件与共享 skills                                                                                     |
| skills/                   | 两个可移植 agent skill 的 SKILL.md                                                                                                                                 |
| pages/                    | 官网与文档站 (React + webpack 自建)                                                                                                                                |
| examples/                 | github_actions、gitlab_ci、bitbucket_pipelines、gitflic_ci、gerrit_ci、codeup_ci 六套 CI 集成示例                                                                  |
| docs/i18n/                | README 与 CONTRIBUTING 的 zh-CN、ja-JP、ko-KR、ru-RU 翻译                                                                                                          |
| imgs/                     | README 图片资源                                                                                                                                                    |

internal/ 子包职责 (参照 CONTRIBUTING.md 的 Project Structure 一节, 并与源码核实):

| 包                                  | 职责                                                                                             |
| ----------------------------------- | ------------------------------------------------------------------------------------------------ |
| internal/agent                      | diff 评审编排: 文件选择、LLM 分组、子任务派发、manifest 与覆盖度                                 |
| internal/llm                        | LLM 客户端 (Anthropic/OpenAI/Bedrock/Responses)、Provider 注册表、端点 resolver、内嵌 BPE 分词器 |
| internal/llmloop                    | LLM 工具循环 Runner: 轮次预算、工具执行、评论定位与重定位、内存压缩、评论 worker 池              |
| internal/diff                       | git diff 获取与解析、hunk 处理、评论行定位 resolver、跨文件重定位、re-location LLM 调用          |
| internal/tool                       | 内置评审工具 (code_comment、file_read、file_find、file_read_diff、code_search、task_done)        |
| internal/session                    | 会话历史、JSONL 持久化、resume、run manifest                                                     |
| internal/config                     | rules、template、allowlist、toolsconfig、testconnection 子包                                     |
| internal/scan                       | 全文件评审 Agent (ocr scan)                                                                      |
| internal/delegate                   | 委托模式: 不调 LLM, 只产出评审规格                                                               |
| internal/mcp                        | MCP stdio 客户端与工具适配                                                                       |
| internal/viewer                     | 本地 Web 会话查看器                                                                              |
| internal/telemetry                  | OpenTelemetry 封装 (console/OTLP 导出)                                                           |
| internal/gitcmd                     | git 子进程 Runner (并发信号量) 与版本检查                                                        |
| internal/model                      | Diff、LlmComment 等数据模型                                                                      |
| internal/stdout                     | 可切换的 stdout writer (机读输出时进度换道 stderr)                                               |
| internal/suggestdiff                | 建议代码的行级 diff 计算 (CLI 彩色渲染用)                                                        |
| internal/pathutil、internal/release | 路径工具与 release 资产命名                                                                      |

两个工程细节值得记录:

- pages/go.mod 是一个"假模块", 文件头注释解释了原因: 没有这个模块边界, go list ./... 会走进 pages/node_modules/flatted/golang (npm 传递依赖里的第三方 Go 包), 把 go test、go vet、govulncheck 和覆盖率门槛全部拖下水; Makefile 里另有一条 grep -v /extensions/ 过滤挡 extensions/vscode 的 eslint 依赖。
- 仓库自带 .opencodereview/rule.json, 是项目级评审规则, 给 internal/llm/providers.go 定制了严格的评审约束 (字段顺序、EnvVar 命名、文档四语言同步、必须补 TestLookupProvider 测试), 并设 merge_system_rule 为 true 与系统规则合并 — OCR 用自己的规则引擎评审自己。

## 三、CLI 命令面与运行契约

入口 cmd/opencodereview/main.go: main 先把 Version 注入 llm.AppVersion, telemetry.Init 成功后注册 5 秒超时的 ShutdownWithTimeout, 再执行 rootCmd。root.go 的 init 注册全部子命令: version、review、scan、delegate、session、config、llm、rules、viewer、completion。rootCmd 自身带 --version/-V; PersistentPreRunE 做三件事: 校验 --color、解析颜色决策、对需要 git 的命令 (commandNeedsGit: review/scan/delegate) 检查 git 版本, 版本不足只 warning 不报错 (internal/gitcmd/version.go 的 gitVersionMin 是 2.41.0)。

命令清单 (Use/Short 取自各 *_cmd.go):

| 命令                | 说明                                                                                     |
| ------------------- | ---------------------------------------------------------------------------------------- |
| ocr review (别名 r) | Start a diff-based code review, 支持 workspace/--from --to/--commit 三种范围             |
| ocr scan            | Scan entire files (no diff required), 全文件评审                                         |
| ocr delegate        | Output review spec for host-agent delegation (no LLM required), 子命令 preview、rule     |
| ocr session         | List and inspect saved review sessions, 子命令 list、show、comments、compare、export、rm |
| ocr config          | Manage configuration settings, 子命令 set、unset 及交互式 provider、model                |
| ocr llm             | LLM utility commands, 子命令 test (发测试会话)、providers (列出内置 Provider)            |
| ocr rules           | Inspect and debug review rules, 子命令 check 查某文件命中哪条规则                        |
| ocr viewer (别名 v) | Start the WebUI session viewer, 默认 localhost:5483                                      |
| ocr completion      | shell 补全                                                                               |

review 的标志 (cmd/opencodereview/shared_flags.go registerReviewFlags): --tools、--rule、--repo、--from/--to/--commit、--resume、--exclude、--format/--audience、--output、--concurrency、--timeout、--max-tools、--max-git-procs、--max-tokens、--max-tokens-budget、--background/-b、--background-file、--provider、--model、--effort (low/medium/high)、--no-filter、--preview。其中 --effort 的补全枚举来自 internal/config/template 的 EffortNames()。

退出码契约写在 review_cmd.go 的 reviewResultError 注释里: 只有 run 级失败或所有选中项都失败时退出非零; complete/partial/skipped 都算成功退出 0, 所以 token 预算导致的受控截断只要有任何覆盖就退 0, 且部分结果仍会完整发布。

输出契约在 shared.go: resolveOutputWriter 支持 --output 写文件 (目标是目录或父目录缺失会提前 fail-fast, 非机读格式会剥掉 ANSI); newQuietHandle 规定 --audience agent 时静音进度, --format json/sarif 等机读格式时把进度整体换道 stderr, 保证 stdout 是一份可解析的文档。中断处理 (interrupt.go, review_cmd.go 注释): 第一次信号取消 context 走优雅关闭链, 第二次信号强制退出而不是被吞掉。

## 四、评审主流程: 从 diff 到评论

internal/agent/agent.go 的 Agent.Run 是总编排, 注释一句话概括: parse diffs → group → plan per group → LLM tool-loop → collect comments。下面按阶段展开, 每个阶段都标注"确定性工程"还是"Agent 决策"。

### 4.1 diff 获取 (确定性)

internal/diff/git.go 定义三种获取模式 (Mode 常量): ModeWorkspace (staged + unstaged + untracked)、ModeCommit (单 commit 对父提交)、ModeRange (merge-base(from,to)..to)。Provider 持有 repoDir、runner (gitcmd.Runner 指针) 与模式参数, mergeBase 缓存公共祖先。所有 git 子进程走 internal/gitcmd/runner.go 的 Runner — 内部信号量限制并发 git 进程, maxConcurrent 小于等于 0 时默认 16 (对应 CLI 的 --max-git-procs 默认值 16)。

### 4.2 文件选择 (确定性)

Agent.Run 第一步 loadDiffs 后调用 selectFiles。internal/agent/selection.go 的 selectFiles 被注释明确定义为"评审唯一的确定性预派发选择": 对每个变更文件套用静态路径/扩展名闸门、删除检查与单文件 diff 体积上限, 是纯函数 — 不输出、不变更、不碰 git 和 LLM, 因此 --preview 与真实运行消费同一份答案 (注释提到这修掉了二者漂移的 issue #782)。聚合预算耗尽、resume 复用、Provider 故障属于执行期结果, 不算选择。

静态闸门的数据在 internal/config/allowlist/: allowed_ext.go 注释说明扩展名白名单 (supported_file_types.json) 决定评审哪些文件类型, default_exclude_patterns.json 是路径 glob 排除列表 (doublestar 语法: 单段星号、双星跨段、花括号展开), default_secret_patterns.json 是密钥路径模式。删除文件保留在工作集里供 prompt 的 change-files 列表引用, 但从不派发评审 (selection.go 里 retained 与 selected 的区分)。体积闸门用 llmloop.PromptTokenLimit(template.MaxTokens), 即 MaxTokens 的 80% (internal/llmloop/compression.go tokenWarningThreshold = 0.80); 超限文件计入 counts.TooLarge, 全部超限会打出 "N file(s) exceeded the token size limit" 并走 skipped manifest。

选择完成后 Agent.Run 打出 "[ocr] N file(s) changed, reviewing M in 仓库路径" 一行 (经 stdout.Writer()), 并在选中集为空时按原因记 review.skipped 遥测事件 (too_large / deleted / no_supported_files)。

### 4.3 语义分组 (Agent)

dispatchSubtasks (internal/agent/agent.go:631) 先 registerCoverage 冻结覆盖度分母 (复用项与待跑项统一登记后 seal), 再 applyResume 过滤已复用文件, 剔除删除文件后调用 internal/agent/grouping.go 的 groupDiffs: 把文件元数据 (不含 diff 内容) 交给 LLM 的 GROUPING_TASK 产出语义分组, 每组上限 maxFilesPerGroup = 10 个文件。两个关键设计:

- 返回结构 groupingResponse 里 Files 是文件序号而不是路径 — 注释解释序号只花几个输出 token, 路径要全长度, 大变更集的响应才能留在补全上限内, 不再截断成"全集合每文件一组"的兜底。
- 任何错误都兜底为每文件一组; 小于 GROUPING_MIN_FILES (task_template.json 里是 4) 的变更集直接整体捆成一组, 标签 smallChangeSetLabel 为 "small change set" (grouping.go 注释: 它无语义, 因为没做划分)。

分捆对应 README 的 "Smart file bundling": message_en.properties 与 message_zh.properties 这类相关文件进同一评审单元, 每个 bundle 作为独立子 Agent 跑隔离上下文, 天然支持并发。

### 4.4 并发派发 (确定性)

dispatchSubtasks 用信号量限并发: concurrency 小于等于 0 时默认 8 (对应 --concurrency 默认)。每组超时 = ConcurrentTaskTimeout 分钟 × 模板评审轮数 (源码为 time.Duration(a.args.ConcurrentTaskTimeout) 乘 time.Minute 再乘 time.Duration(a.args.Template.ReviewRounds())), 与 SKILL.md 里"有效超时 = --timeout × 轮数, 默认 15 分钟 × medium 2 轮 = 30 分钟"的口径一致。

token 预算 (--max-tokens-budget) 在拿信号量之前做 lookahead: 已用 token 加本组估算超过预算就停止调度后续组, 在飞组允许跑完, 超支上界是在飞组数 (不超过并发数)。预算耗尽刻意不调 SetRunFailure — 注释写明这是"受控覆盖度截断而非 run 级失败", 未派发项由 Finalize 归为 failed(budget), 终态仍由覆盖度推导。每组估算用 internal/agent/estimate.go 的启发式: promptOverheadTokens = 2000、avgMainRoundsPerFile = 7 (注释说真实仓库观测约 6 轮向上取整)、avgOutputTokensPerRound = 700, 与 internal/scan/estimate.go 刻意保持一致 (两处重复声明避免 agent 到 scan 的依赖, 注释要求同步修改)。估算只是数量级下限, 无法覆盖工具调用膨胀, 真实用量以 API 返回为准。

每个组的 goroutine 带 panic 隔离: recover 后计入 subtaskFailed、逐文件 markFailed(FailurePanic)、打 panic 堆栈与遥测 subtask.panic — 一组 panic 不影响其他组, 全失败汇总仍然正确。

### 4.5 组内评审: plan 与多轮 main loop

executeGroupSubtask (internal/agent/agent.go:1379) 分两阶段:

Phase 1 Plan: 模板配了 PLAN_TASK 且 PlanRequired (按 PLAN_MODE_LINE_THRESHOLD = 50 行/单文件、PLAN_MODE_GROUP_LINE_THRESHOLD = 100 行/组判断, 见 task_template.json) 时执行 executeGroupPlanPhase; 低于阈值跳过并打 "[ocr] Skipping plan phase ..."。plan 失败只警告不中断 (continuing without plan)。

Phase 2 Main loop: 最多 Template.ReviewRounds() 轮 (由 effort 决定, 见第五节)。第 2 轮起把 plan 从 prompt 里剥掉 — 注释: 防止 plan 变成覆盖度上限; 同时把上一轮已确认评论渲染成 confirmed block 注入 (buildConfirmedCommentsBlock)。每轮先 checkPromptBudget (prompt 超限: 第 1 轮直接终止该组, 后续轮停止), 再进 runner.RunMainTask。预算检查也在轮级: round 大于 1 时若已用 token 超预算就跳过剩余轮。

internal/llmloop/loop.go 的 RunMainTask 是工具循环本体: 每轮把增长的会话整体重发 — 注释点明这正是 Provider prompt cache 复用的前缀扩展, 因此用 llm.SessionTaskKey(SessionID, MainTask, taskKey) 把亲和键限定到本子任务的会话, 让每轮路由到同一缓存节点。循环预算 toolReqCount 来自 Template.MaxToolRequestTimes (task_template.json 是 100); 连续空轮 maxConsecutiveEmptyRounds = 3 次后 break; 聚合 token 预算在每轮发请求前检查 (tokenBudgetExceeded), 因为一个长组每轮重发整段历史, 恰好是"组间闸门看不见的消费者"。异步内存压缩由会话独占, 会话结束时 defer 取消在飞压缩任务。

### 4.6 工具集 (Agent 决策, 定义确定性)

内置工具定义在 internal/tool/definitions.go: unknown、task_done、code_comment、file_read、file_find、file_read_diff、code_search。Registry 是 Provider 接口 (Tool() 加 Execute(ctx, args)) 的映射, Freeze 后只读; Dynamic(name) 创建 MCP 动态工具, 撞保留名直接 panic。工具的 JSON schema 在 internal/config/toolsconfig/tools.json: code_comment 要求每条评论带 content、existing_code、category、severity、path 五个必填字段, suggestion_code 可选; category 枚举 bug/security/performance/maintainability/test/style/documentation/other, severity 枚举 critical/high/medium/low。code_comment 的工具描述写明核心机制: 用"动态滑动窗口算法"按 existing_code 在 diff 文本里匹配连续行, 因此模型必须给出与 diff 格式完全一致的新增代码行 — 定位责任被工程化约束写进了 prompt 契约。

其余工具实现: internal/tool/code_search.go 用 git grep 做全仓搜索 (core.quotepath=false 保证非 ASCII 路径原样输出, 反斜杠统一转正斜杠兼容 Windows pathspec, file_patterns 含上级目录引用直接拒绝); internal/tool/file_read_diff.go 持有冻结的只读 DiffMap (NewDiffMap 深拷贝), 按 path_array 返回 "==== FILE: 路径 ====" 格式的 diff 文本; DiffMap 在过滤前由全量 diff 构建 (Agent.injectDiffMap), 所以模型能查被过滤文件的 diff。internal/tool/code_comment.go 的 Execute 走 ParseComments 校验后入 CommentCollector; comment_args_repair.go 还有一层确定性修复: 评论以字符串序列化到达且修复后无截断痕迹才接受, 并记为 schema 违规告警。

### 4.7 评论定位: 三级 fallback (确定性 + LLM 兜底)

loop.go 的 resolveAndCollect 是定位链, 注释给出明确顺序:

1. 本文件滑动窗口匹配: diff.ResolveComment(cm, d) (internal/diff/resolver.go), 注释提到空行不打断滑动窗口匹配;
2. 跨文件搜索: diff.RelocateAcrossFiles 搜全量 diff — 评论挂错文件时重新归档, 成功记 comment_refiled 警告; 注释解释它必须排在 LLM 之前, 因为 LLM 步骤会覆写模型的原始 ExistingCode, 且即便本文件无 diff (d 为 nil) 也要跑;
3. LLM 重定位: 用 RE_LOCATION_TASK 模板 (internal/diff/relocation.go 的 BuildReLocationMessages 与 ReLocateComment) 让模型重新生成精确的 existing_code 片段, 再重试 ResolveComment。

无论哪级, 最终都入 CommentCollector; 若配了 CommentWorkerPool, 定位与收集被卸载到 worker 池 (internal/llmloop/pool.go, 并发上限默认 8, SubmitFor/AwaitKey 支持按子任务 key 单独排空), 主工具循环不被阻塞 — README 所称"外部定位与反思模块"里的定位模块就是这个。

### 4.8 反思过滤 (Agent)

每轮 main loop 结束后执行 REVIEW_FILTER_TASK: executeGroupReviewFilter (internal/agent/agent.go:1794) 把本轮新增评论 (from 索引做轮级隔离) 连同组 diff 交给 LLM 过滤低质量评论; --no-filter (SkipFilter) 跳过。这是 README 所说的"评论反思模块"。

### 4.9 收尾: manifest、会话与退出

Agent.Run 末尾: runner.WaitBackground 汇合所有可能在 run 边界后仍发请求的后台任务 (注释: 否则 retry report 会看到未 finalize 的请求而被整体丢弃), finalizeManifest 把覆盖度冻结进不可变 manifest, session.Finalize 落盘 session_end; 持久化失败本身算交付错误, 与评审错误用 errors.Join 合并上报, 不允许评审错误掩盖"session_end 没写盘"。遥测记录 files_reviewed、comments_generated、review duration 等指标。

## 五、任务模板、prompt 与 effort 体系

模板在 internal/config/template/, 两份 JSON 内嵌 prompts/ 下的 Markdown, 用 go:embed 打进二进制。

task_template.json (diff 评审) 的任务与标量:

| 任务/标量                      | 值           | prompt 文件                                                        |
| ------------------------------ | ------------ | ------------------------------------------------------------------ |
| MAIN_TASK                      | 主工具循环   | main_task_system.md、main_task_user.md                             |
| PLAN_TASK                      | 组级预审计划 | plan_task_system.md、plan_task_user.md                             |
| MEMORY_COMPRESSION_TASK        | 记忆压缩     | memory_compression_task_system.md、memory_compression_task_user.md |
| REVIEW_FILTER_TASK             | 评论反思过滤 | review_filter_task_system.md、review_filter_task_user.md           |
| RE_LOCATION_TASK               | 评论重定位   | re_location_task_system.md、re_location_task_user.md               |
| GROUPING_TASK                  | 文件语义分组 | grouping_task_system.md、grouping_task_user.md                     |
| MAX_TOOL_REQUEST_TIMES         | 100          | -                                                                  |
| PLAN_MODE_LINE_THRESHOLD       | 50           | -                                                                  |
| PLAN_MODE_GROUP_LINE_THRESHOLD | 100          | -                                                                  |
| GROUPING_MIN_FILES             | 4            | -                                                                  |
| GROUPING_BUNDLE_LINE_THRESHOLD | 200          | -                                                                  |
| MAX_REVIEW_ROUNDS              | 2            | -                                                                  |
| MAX_TOKENS                     | 200000       | -                                                                  |
| MAX_COMPLETION_TOKENS          | 16384        | -                                                                  |

scan_template.json (全文件评审) 的任务键: MAIN_TASK、PLAN_TASK、DEDUP_TASK、PROJECT_SUMMARY_TASK、MEMORY_COMPRESSION_TASK、RE_LOCATION_TASK, 标量含 MAX_FILE_SIZE_BYTES、BATCH_STRATEGY、BATCH_SIZE、DEDUP_MIN_COMMENTS — 对应 scan 的批处理、去重与项目总结环节。

effort 预设 (internal/config/template/effort.go): Effort 枚举 low/medium/high, EffortDefault 为 medium; EffortPreset 只有一个旋钮 MaxReviewRounds, 分别为 1/2/3; ApplyEffort 覆写模板标量。解析优先级 (cmd/opencodereview/shared.go resolveEffort): CLI --effort 高于配置文件 effort, 配置文件高于 EffortDefault。这套机制让"effort 控制评审轮数"有了确定性解释: low 一轮直出, high 三轮迭代加 confirmed block。

内存压缩 (internal/llmloop/compression.go): 阈值按 MaxTokens 的分数算 — tokenSoftThreshold = 0.60 触发异步后台压缩, tokenWarningThreshold = 0.80 触发同步立即压缩; PromptTokenLimit 返回 80%, 被 agent/scan 的预检闸门、大输入过滤与 computeActiveZoneSize 共用, 保证阈值单一定义。压缩按"assistant 消息 + 后续 tool result"的 round 结构切分消息。

token 计数不依赖网络: internal/llm/embedded_loader.go 用 go:embed bpe_data 目录内嵌 tiktoken BPE 数据, init 时安装为 tiktoken 的 loader — 注释说明 tiktoken 默认首次使用会联网下载编码文件, 失败时静默退化为 len(text)/4 估算, 内嵌方案让计数在离线与测试环境都稳定。

## 六、LLM 客户端与 Provider 体系

### 6.1 协议与客户端

internal/llm/protocol.go 定义四种协议常量: ProtocolAnthropic (anthropic)、ProtocolOpenAIChatCompletions (openai)、ProtocolOpenAIResponses (openai-responses)、ProtocolAnthropicBedrock (anthropic-bedrock)。客户端实现在 internal/llm/client.go 与 responses_client.go:

- OpenAIClient: 基于官方 openai-go/v3 SDK, URL 自动补 /chat/completions; MaxRetries 5; ExtraHeaders 每请求展开 (SessionKey 模板变量可按请求替换); RetryCodes 走 SDK middleware; raw 中间件注册在 retry observer 之前 — 注释解释 SDK 中间件是 last-in-innermost, raw 的全量读体加写盘会虚增 observer 的 DurationToHeadersMS。io.ErrUnexpectedEOF (HTTP 200 但响应截断) 会修正重试报告后原样重试一次, 且两处修正都放在 ctx 早退之前, 避免被取消的请求留下错误记录。流式由 ExtraBody 的 stream 布尔决定, stream/stream_options 键被特殊处理 (注释引用 issue #647: 留在 body 里会让非流式路径解码失败); 默认强制 stream_options include_usage=true, 否则 OpenAI 兼容服务器不给 usage、成本核算静默丢失; 显式 extra_body 可覆盖但 include_usage 仍自动补齐, 显式 null 才整体抑制 (拒绝该字段的网关场景)。
- AnthropicClient: 基于 anthropic-sdk-go, URL 补 /v1/messages; 鉴权头走 NormalizeAuthHeader 三分支 (authorization、x-api-key、自定义头), 互删冲突头; 注释提到 SDK 默认客户端硬编码 10 分钟 ResponseHeaderTimeout, 慢端点上长 timeout_sec 会被截, 因此显式传带 header 超时的 HTTP client (issue #1161)。Anthropic API 服务端管理 prompt-cache 亲和, 不注入 session key 到 body, 但 SessionKeyTemplateVar 仍可用于 ExtraHeaders/ExtraBody。
- NewAnthropicBedrockClient: SigV4 签名走 aws-sdk-go-v2; AmbientAuth 类 Provider 不要求 api_key (Provider 结构体注释: AWS 凭证来自环境链自身, 强制要 key 会让 Provider 不可用); 构造失败 (如 AWS 会话过期) 延迟到首次请求报 initErr — 注释说明工厂函数没有错误返回通道, 而 panic (SDK 自己的 bedrock helper 的做法) 会给用户扔 Go 堆栈。BedrockContext() 返回实际解析出的 region/profile, 因为发错 region 的报错看起来像坏的 model ID。
- ResponsesClient (responses_client.go): 对应 ProtocolOpenAIResponses, ChatRequest.SessionID 注释写明它作为 Responses API 客户端的 prompt_cache_key。

### 6.2 内置 Provider 注册表

internal/llm/providers.go 的 registry 变量内嵌 29 个 Provider (字段: Name、DisplayName、Protocol、BaseURL、AuthHeader、EnvVar、Models), LookupProvider 与 ListProviders 都返回 Models 切片的独立拷贝。注册表全表 (DisplayName 与 Protocol 逐条取自源码):

| Name                | DisplayName                      | Protocol          |
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

即: 2 个 Anthropic 系协议 (直连 + Bedrock SigV4)、2 个 OpenAI 原生协议 (Chat Completions + Responses)、其余 25 个全部走 OpenAI 兼容协议, 覆盖国内外主流模型网关与订阅制 coding plan (dashscope-tokenplan、z-ai-coding、hy-tokenplan、tencent-tokenhub 等)。mistral 条目注释说明其模型列表刻意精简以降低维护成本, 用户可用 ocr config set model 指向任意模型, preset 只为选择器 UI 提供种子。EnvVar 示例: siliconflow 用 SILICONFLOW_GLOBAL_API_KEY、siliconflow-cn 用 SILICONFLOW_API_KEY、mistral 用 MISTRAL_API_KEY。

注册表的同步纪律 (AGENTS.md "Provider Presets" 一节 + providers.go 注释): 改内置 Provider 元数据或模型列表后必须 go generate ./internal/llm, 生成两个文件并一起提交 — extensions/frontend/src/shared/providers.generated.ts (前端下拉) 与 extensions/idea/src/main/kotlin/com/alibaba/opencodereview/idea/services/ProviderNames.generated.kt (IDEA Provider 名); 生成器在 internal/llm/gen (校验模型列表无重复、原子写文件、支持 -check 模式)。ci.yml 有专门步骤 go run ./internal/llm/gen -check 验证生成物不过期。

### 6.3 端点解析优先级

internal/llm/resolver.go 的 ResolveEndpointWithOptions 决定每次运行用哪个端点。无有效配置时的报错信息即优先级声明 (resolver.go:150): OCR_LLM_URL/OCR_LLM_TOKEN/OCR_LLM_MODEL 环境变量、~/.opencodereview/config.json、或 ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN/ANTHROPIC_MODEL。相关环境变量 (resolver.go:52-74): OCR_LLM_URL、OCR_LLM_TOKEN、OCR_LLM_MODEL、OCR_LLM_AUTH_HEADER、OCR_LLM_EXTRA_HEADERS、OCR_LLM_PROTOCOL (优先于 OCR_USE_ANTHROPIC)、OCR_LLM_TIMEOUT、OCR_USE_ANTHROPIC。还有一条少见的兜底路径: tryShellRC (resolver.go:750) 会解析 ~/.zshrc 与 ~/.bashrc 里的 ANTHROPIC_ 前缀 export 语句作为凭证来源 (exportRe 正则匹配单双引号与裸值)。auth token 支持命令形式: LlmConfig.AuthTokenCmd 的 stdout 即 token (config_cmd.go), GitHub Action 正是用它避免把 token 写进配置文件。OCR_LLM_TIMEOUT 打错 (如 "30s") 会在解析期 fail-fast 而不是请求期 (resolver.go:103 注释)。

## 七、MCP 集成

internal/mcp/client.go 是基于 modelcontextprotocol/go-sdk 的 stdio 客户端: NewClient 拉起 MCP 服务器子进程 (env 追加、可设工作目录), 初始化并缓存工具列表; ctx 只管初始化超时 (Connect + ListTools) 不管子进程生命周期; 关闭预算 SubprocessTerminateDuration = 800ms、CloseAllTimeout = 2800ms。internal/mcp/provider.go 把每个 MCP 工具适配成 tool.Provider (Tool() 返回 tool.Dynamic(toolName), Execute 转发 CallTool), RegisterAll 注册进评审工具 Registry — 也就是 README 说的 "MCP Server — extend the review agent with external tools"。配置入口是 config.json 的 mcp_servers 字段 (Config.MCPServers)。注意当前命令面 (root.go init) 没有 ocr mcp serve 之类的服务端命令, ROADMAP.md 把"通过 MCP 暴露 OpenCodeReview"写进 Current State, 但代码中 MCP 只有客户端方向 — 该表述与代码现状有出入, 以代码为准。

## 八、规则体系: 四层合成

internal/config/rules/system_rules.go 的 composedResolver 注释写明四层优先级:

1. custom: --rule 指定的自定义规则文件 (最高);
2. project: 仓库内 .opencodereview/rule.json;
3. global: 用户级 ~/.opencodereview/rule.json;
4. system: 内嵌系统默认规则 (最低), 外层包一层 sniffer。

系统规则 = system_rules.json (go:embed, 含 default_rule 与 path_rule_map) + rule_docs/ 下 54 个按语言/文件类型写的规则 Markdown。path_rule_map 用 doublestar glob 把路径映射到规则文件, 覆盖面很广: 主流语言 (go.md、java.md、rust.md、python.md、ts_js_tsx_jsx.md、kotlin.md、cpp.md 等)、构建与包管理文件 (pom_xml.md、build_gradle.md、package_json.md、cargo_toml.md、composer_json.md)、模板语言 (freemarker.md、handlebars_mustache.md、jinja.md、pug.md、astro.md、arkts.md)、IaC 与 DSL (terraform.md、bicep.md、nix.md、jsonnet.md、graphql.md、prisma.md、protobuf.md、rego.md)、CI 配置 (.github/workflows 下单独一条 github_workflows.md)、硬件描述 (verilog.md、vhdl.md)、合约 (solidity.md、vyper.md)、翻译文件 (po.md、pot.md) 等。sniffer (sniffer.go) 处理歧义扩展名: .m 文件按内容嗅探, 是 Objective-C 就用 objc 规则 (NewResolver 注释: 包在 system 层而非用户层)。

RuleDetail 带 Source 元数据 (custom/project/global/system) 与命中 Pattern; 项目规则支持 merge_system_rule 字段, 把自定义规则与系统规则合并而不是替换 (本仓库 .opencodereview/rule.json 就用了)。FileFilter 聚合所有 rule.json 层的 include/exclude 列表, 提供 IsUserExcluded/IsUserIncluded。调试入口是 ocr rules check 加文件路径 — 显示该路径最终命中哪条规则。

## 九、会话持久化、resume 与输出格式

internal/session/persist.go 注释给出落盘路径: $HOME/.opencodereview/sessions/ 下按编码后的仓库路径分目录, 每会话一个以 session id 命名的 .jsonl 文件; JSONL 流式写入, lastUUID 维护记录的 parentUuid 链, 多 goroutine 安全。SessionHistory (history.go) 带 UUID session id、仓库目录、git 分支、模型、LLM 来源、评审模式 (workspace/range/commit)、diff from/to/commit、scan 路径、resumed_from; SessionOptions.Operation 非空时创建 ManifestBuilder, session id 即 run_id。

resume 语义 (cmd/opencodereview/review_cmd.go):

- workspace 模式不支持 resume (loadReviewResumeState 直接报错);
- state.ValidateOptions 校验模式与 diff 参数一致;
- validateResumeIdentity 拒绝输入、规则、provider 或 model 与父 run 不匹配的 resume;
- 父 run 全失败也允许 resume — 它有可验证的 manifest, 整个选中集可以重新派发; checkpoint 能否复用由后续的输入身份校验决定。

session 子命令 (session_cmd.go): list 列当前仓库的会话、show 看元数据与逐文件项、comments 看会话里的评论、compare 对比两个会话的发现、export 导出自包含 HTML、rm 删除。

输出格式三种:

- text: 人读格式, output.go 用 wrapByRunes 按 rune 列宽折行, suggestdiff (internal/suggestdiff/diff.go, Myers 风格 LCS) 渲染 suggestion_code 的增删行着色;
- json: jsonSummary 结构含 files_reviewed、comments、total_tokens、input_tokens、output_tokens、cache_read_tokens、cache_write_tokens、elapsed、budget_exceeded 等字段;
- sarif: cmd/opencodereview/sarif.go 实现 SARIF v2.1.0 子集 (OASIS 标准), 常量声明符合 schemastore 的 sarif-2.1.0 schema, toolName 为 OpenCodeReview, 指纹键 ocrFinding/v1。

delegate 模式只支持 text 与 json (shared_flags.go registerDelegateFlags 的补全枚举注明 sarif 不支持)。

## 十、Session Viewer

ocr viewer (viewer_cmd.go) 默认监听 localhost:5483, --open 支持 auto/always/never (auto: 仅本地终端且有显示器时打开)。internal/viewer/server.go 的路由 (Go 1.22 风格 method+pattern): GET 根路径列仓库、GET `/r/{repo}` 列会话、GET `/r/{repo}/compare` 对比、GET `/r/{repo}/{sessionID}` 看单会话; 模板在 internal/viewer/templates/ (repos、sessions、session、compare、pager、app-header 六个 HTML), 图标内联 (inlineIcon)。安全设施:

- hostguard.go: Host 头白名单默认只认回环地址 (hostOnly 处理 IPv6 方括号与端口), 可用 OCR_VIEWER_ALLOWED_HOSTS 扩展 — ASSURANCE_CASE.md 威胁模型把它列为 DNS rebinding 的对策;
- securityheaders.go: 安全响应头;
- export.go 支撑 ocr session export 的单文件 HTML 导出。

## 十一、scan: 全文件评审

ocr scan (scan_cmd.go, Short 为 "Scan entire files (no diff required)") 面向"没有有意义 diff"的场景: 审计陌生代码库或整个目录。internal/scan/agent.go 是与 review Agent 并列的实现, 复用 llmloop.Runner 与工具集; 常量 changeFilesScanLiteral 以 "(not applicable in full-scan mode)" 替代 prompt 里的 change_files 占位符。scan 特有机制 (scan_template.json + shared_flags.go registerScanFlags):

| 机制                                        | 说明                                         |
| ------------------------------------------- | -------------------------------------------- |
| BATCH_STRATEGY / --batch                    | none、by-language、by-directory 三种分批策略 |
| PLAN_TASK / --no-plan                       | 每文件预审计划, 可关                         |
| DEDUP_TASK / --no-dedup                     | 每批评论去重, 可关                           |
| PROJECT_SUMMARY_TASK / --no-summary         | 收尾项目总结, 可关                           |
| MAX_FILE_SIZE_BYTES                         | 单文件体积上限                               |
| --path                                      | 逗号分隔的仓库相对目录/文件, 默认全仓        |
| --resume                                    | scan 会话也可续跑 (README 示例)              |
| --concurrency / --timeout / --max-git-procs | 默认 8 / 15 分钟 / 16                        |

scan 与 review 的成本估算刻意镜像 (internal/agent/estimate.go 注释), 两条路径对外表现一致。scan 的 LLM 请求不计入 retry report (agent.New 注释: NewRequestMeta 只在 review 路径非 nil)。

## 十二、delegate: 委托模式

internal/delegate 包注释: "deterministic spec generation for delegation mode, where OCR produces review specifications without calling any LLM"。即 OCR 只做确定性工程部分 (文件选择、规则解析), 把评审任务交给宿主 coding agent 用它自己的 LLM 执行 — 对应 ROADMAP 的 "Subscription-friendly review": 不需要单独的 API key, 走订阅额度。

命令面 (delegate_cmd.go):

- ocr delegate preview: 输出 mode (workspace/range/commit)、from/to/commit/merge_base 引用元数据、可评审文件列表 (路径、状态、增删行数)、被排除文件及原因; skills/open-code-review-delegate/SKILL.md 教宿主 Agent 用它构造 git 命令;
- ocr delegate rule 加文件路径列表: 按内容分组输出解析后的规则。

RuleGroup (rulegroup.go) 按 source、pattern、rule 文本三元组聚类: 文本相同但来源或命中 pattern 不同的文件分在不同组, 保证组的元数据对每个成员都准确; RuleGroupsMarkdown (format.go) 渲染成 "Rule Group N: source / pattern" 的 Markdown 段落, 含 Applies to 文件列表与规则正文。delegate 顶层命令与 review 一样需要 git (root.go commandNeedsGit)。

## 十三、GitHub Action 集成

action.yml 是一个 1094 行的 composite action (name: OpenCodeReview PR Review, branding: eye/green), 34 个 inputs、17 个 outputs、15 个步骤。

inputs 分类 (action.yml:11-243):

| 类别       | inputs                                                                                                                                                        |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LLM 连接   | llm_url、llm_auth_token、llm_model、llm_use_anthropic、llm_protocol、llm_auth_header、llm_extra_headers、llm_extra_body、llm_reasoning_effort、llm_timeout    |
| 评审控制   | review_concurrency、review_task_timeout (1-120 分钟)、background、rule、effort、max_tokens_budget、language                                                   |
| 安装与版本 | ocr_version (npm 版本规格, 要求 v1.9.6+)、node_version                                                                                                        |
| 评论发布   | sticky_summary、incremental、incremental_overlap_threshold、resolve_outdated、review_comment_batch_size、route_severity_below、route_categories、github_token |
| 增量范围   | checkpoint_range、full_review、base_ref、head_sha、pr_number                                                                                                  |
| 观测       | stream_progress、upload_artifacts                                                                                                                             |

outputs 覆盖评论统计 (comments_total/inline/skipped/routed/failed/resolved/resolved_preview)、summary_comment_url 与 checkpoint 范围元数据 (range_mode/summary/reason/from/to、checkpoint_before/after、ancestry、source_run)。

15 个步骤与关键设计:

1. Check git and Node.js、Install git (apt/brew/yum/apk 兜底)、Setup Node.js;
2. Resolve PR refs: base_ref/head_sha/pr_number 三级回退 (inputs、事件 payload、workflow_run.pull_requests[0]), 空 PR 号在评审前就 fail — 注释记录了一次真实事故: 空号会让评论发到 issues 下空编号的 comments 路径, 返回 404, 整轮评审发现被丢弃;
3. Checkout base 与 Fetch PR head (fork-safe): 签出受信任的 base 而非 PR head, head 只通过 git fetch origin pull/N/head 拿 blob — 注释: 不物化不可信的 PR 文件到工作树; 本仓库自己的 .github/workflows/ocr-review.yml 用 pull_request_target 触发, 注释解释安全性来自"OCR 只读 diff, 不执行 PR 代码";
4. Compute merge-base: MERGE_BASE 取 origin/BASE_REF 与 HEAD_SHA 的 merge-base, 失败退化到 HEAD_SHA;
5. Validate inputs: review_task_timeout 严格十进制 1-120、effort 枚举、max_tokens_budget 数字归一化 (空或 0 = 不限)、llm_reasoning_effort 枚举 (minimal/low/medium/high/max)、stream_progress 布尔;
6. Install OpenCodeReview: npm install -g 指定版本后解析 ocr version 输出, 语义化校验不低于 v1.9.6; effort 需要 v1.10.0+、stream_progress 需要 v1.9.8+ (66d71b2 提交把进度移到 stderr), 旧版本 fail-fast 而不是让 CLI 报未知标志; 解析出的实际版本写入 OCR_VERSION_ACTUAL 进 checkpoint 指纹 — OCR 升级会使旧版本产生的 checkpoint 失效;
7. Configure OCR: 先 ocr config unset provider、清空 auth_token/extra_headers/retry_codes 防止 runner 残留配置串味, 再逐项 ocr config set llm.url/model/use_anthropic/protocol/auth_header; 密钥用 auth_token_cmd 设为 printf 回显 OCR_LLM_TOKEN 环境变量 — token 只在运行时取, 不落配置文件; llm_reasoning_effort 用 node (而非 jq, Actions 容器运行时保证 node 在 PATH) 合并进 llm.extra_body, 显式 reasoning_effort 键优先于 input; 该字段与 Anthropic 协议互斥 (Anthropic API 拒绝未知 body 字段, fail-fast); llm_extra_body 默认值是禁用 thinking 模式 (兼容各家 Provider 的保底配置);
8. Resolve review range (checkpoint_range=true 时): actions/github-script 计算增量评审范围与配置指纹;
9. Run OpenCodeReview: ocr review --from RANGE_FROM 或 MERGE_BASE、--to HEAD_SHA、--format json、--timeout N, 默认加 --audience agent 保持 stdout 纯净; stream_progress=true 时去掉 agent audience, 用 mkfifo 加后台 tee 把人类可读进度实时打进 workflow 日志同时落盘 /tmp/ocr-stderr.log (tee 是真后台 job, wait 保证文件刷完再被读取); set +e 捕获退出码写 GITHUB_ENV;
10. Upload review artifacts (always 且 upload_artifacts=true): 以 run id 与 attempt 命名, 打包 /tmp/ocr-result.json 与 /tmp/ocr-stderr.log;
11. Fail job on OCR error: 非零退出码原样透传;
12. Post review comments (退出 0 时): actions/github-script 注入执行 scripts/github-actions/post-review-comments.js 的 runPostReviewComments。

post-review-comments.js (scripts/github-actions/) 是评论发布引擎, 无 npm 依赖 (只用内置 crypto), 保证能在 github-script 沙箱里直接跑; 文件头注释说明它是从 examples 与 in-repo workflow 的内联脚本抽出来的单一事实源。要点 (源码常量与注释):

- SUMMARY_MARKER 是一条 HTML 注释标记, sticky summary 靠它找到并更新同一条总结评论而不是重复发;
- 增量判定 DEFAULT_OVERLAP_THRESHOLD = 0.6: 两条多行评论的行区间 IoU 超过阈值视为同一条;
- DEFAULT_BATCH_SIZE = 50: 单次 createReview 的 inline 评论上限 — 注释记录生产上曾在一个 71 条的请求里遇到 GitHub Server Error (部分成功), 50 条对齐 GitHub 的软性指导;
- 路由策略 (fail-open 发布控制, issue #478): route_severity_below 与 route_categories 两个输入把低危/指定类别评论从 inline 改道 summary; CATEGORIES/SEVERITIES 枚举声明来源是 LLM 输出 schema (internal/config/toolsconfig/tools.json:55-84), 两侧保持同一事实源; 任何解析失败退化为 NO_ROUTING 哨兵策略, 保证"发布评论"这条主路径永远 open;
- resolve_outdated 用 Map 而非对象字面量存 true/report 两个模式 — 注释: 对象查找会继承 Object.prototype, constructor 这类键会静默读成"已配置", 这个 fail-closed 特性绝不能那样失败;
- checkpoint 相关输入 (checkpoint_carry/config_fingerprint/base_ref/merge_base) 为空时退回无 checkpoint 行为; checkpointNoop (same_head_noop) 时保留上次总结不改写。

action 的第三方依赖全部 SHA 钉死并带版本注释 (actions/checkout v7.0.1、actions/setup-node v7.0.0、actions/github-script v9.0.0、actions/upload-artifact v4.6.2), scripts/verify-action-pins.sh 在 CI 校验钉扎。示例工作流 examples/github_actions/ocr-review.yml 演示了 pull_request_target 自动评审 + issue_comment 里 /open-code-review 命令触发再评审, 其 concurrency 注释记录了一个真实坑: GitHub 在 job if 之前求值 concurrency, 扁平分组会让无关评论取消进行中的评审, 解法是匹配事件共享每 PR 分组、不匹配评论落入按 run id 唯一的 noop 分组。

examples/ 还覆盖 gitlab_ci、bitbucket_pipelines、gitflic_ci、gerrit_ci (Jenkins/Gerrit Trigger)、codeup_ci 五套非 GitHub CI。

## 十四、npm 分发与安装机制

分发拓扑: 主包 @alibaba-group/open-code-review 只是壳 (files 仅含 bin/ocr.js、scripts/install.js、scripts/update.js、scripts/version.js、scripts/platform.js、imgs/), 二进制通过 6 个 optionalDependencies 平台包分发 (@alibaba-group/ocr-darwin-arm64 等, npm/ 目录各有一个 package.json, 声明 os/cpu、files 为 bin/、preferUnplugged)。发布时 (.github/workflows/release.yml npm-publish job, node:24 容器): 把构建产物拷进 npm 平台包目录的 bin/、用 jq 注入版本号、逐个 npm publish --access public (先 npm view 查重跳过已发布), 再给主包用 jq 注入 version 与 optionalDependencies 版本后发布 — 仓库里的 0.0.0 占位由此变成真实版本。

平台解析 scripts/platform.js: getPlatformPackageName 优先从父包 optionalDependencies 里按平台-架构后缀匹配 (而非只查写死的 PLATFORM_PKG 表), resolveNativeBinary 先 require.resolve 平台包 bin 目录下的 opencodereview (Windows 为 opencodereview.exe), 找不到再退回壳包自带 bin/ 下的二进制 (legacy 路径, 即 postinstall 下载的兜底)。

安装脚本 scripts/install.js (postinstall):

1. 若平台包已提供二进制则直接跳过下载;
2. detectPlatform: x64 映射 amd64、arm64 保持、win32 映射 windows, 其余架构/系统报错;
3. 版本取 OCR_VERSION 环境变量 (可钉版本) 或 package.json version;
4. 按 ocrConfig.urlPattern 从 GitHub Releases 下载, URL 模式为 `releases/download/v{version}/opencodereview-{os}-{arch}`; download 函数强制 HTTPS (拒绝非 https)、重定向上限 10 次;
5. 按 checksumPattern 下载 sha256sum.txt, 找包含对应 os-arch 后缀的行比对本地 sha256, 不匹配或无匹配条目都删文件报错;
6. chmod 755, 打印 quick start。

启动器 bin/ocr.js 的职责:

- resolveNativeBinary 找到真实二进制后 spawn, stdio inherit;
- launcherExitCode: 子进程被信号杀死 (status 为 null) 时映射为 128 加信号编号 — 注释: 若 fall through 到 0, 流水线会把 OOM kill 读成成功;
- installSignalHandlers: Unix 转发 SIGINT/SIGTERM; Windows 特殊处理 — console Ctrl+C 会同时发给两个进程, wrapper 保持存活等待二进制, 但不调 child.kill("SIGINT") (Node 在 Windows 上会映射成粗暴的 TerminateProcess);
- 更新提示: 读 ~/.opencodereview/update-available 文件, 有新版本就在 stderr 打黄色提示; 每次运行 (OCR_NO_UPDATE 未设时) 按冷却期 (OCR_UPDATE_INTERVAL, 默认 18 分钟, 以 ~/.opencodereview/last-update-check 的 mtime 计) detached spawn scripts/update.js;
- update.js: 查 registry.npmjs.org (DEFAULT_REGISTRY) 比对版本, 用 wx 标志写 update.lock (EEXIST 时按 pid 探活, 死锁文件可抢占), 结果写 update-available 供下次运行提示。

另一条安装路径是 release 二进制直装: install.sh (curl -fsSL https://open-codereview.ai/install.sh | sh) 支持 OCR_INSTALL_DIR (默认 /usr/local/bin)、OCR_VERSION (默认走 GitHub API 取 latest)、OCR_GITHUB_MIRROR (镜像域名), Windows 对应 install.ps1。README 的 Quick Start 则是标准 npm install -g @alibaba-group/open-code-review。

## 十五、IDE 扩展与 Agent 插件生态

extensions/ 三个组件共享一套 Preact webview:

- extensions/frontend: open-code-review-frontend, Preact 10 + webpack 构建的 webview 源码 (src/webview、src/shared), providers.generated.ts 由 Go 注册表生成 (见 6.2);
- extensions/vscode: open-code-review-vscode 0.1.2, publisher open-code-review, engines.vscode ^1.74.0, activationEvents 为 onStartupFinished; 贡献 activity bar 容器 ocr-container 加 webview 侧栏, 命令 ocr.review.start、ocr.review.cancel、ocr.config.open、ocr.comment.apply、ocr.comment.discard、ocr.comment.falsePositive, 评论线程菜单按 commentController 与 pending 状态条件渲染;
- extensions/idea: Kotlin + Gradle 的 IntelliJ 插件 (extensions/idea/README.md): 在 JCEF 浏览器里托管同一套 VS Code 扩展的 Preact webview, 三种评审模式 (workspace、--from/--to 分支对比、--commit 单提交)、待评审文件预览 (点击看原生 diff)、--background 自定义提示、流式日志可随时取消、工具窗口与编辑器内联评论双向同步、插件内配置管理 (ocr config set 持久化) 与模型切换/连通性测试。

plugins/open-code-review/ 面向 coding agent, 每个平台一份清单 (README.md 分平台给安装指引, 统一要求 Git 2.41+ 与先装 ocr):

| 平台        | 清单/入口                                                                                         | 形态                                                                                                                                                                                                                                                 |
| ----------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code | 仓库根 .claude-plugin/marketplace.json 指向 plugins/open-code-review/claude-code                  | marketplace 插件, /open-code-review:review 与 /open-code-review:delegate-review 两个 slash commands                                                                                                                                                  |
| Codex       | plugins/open-code-review/.codex-plugin/plugin.json, skills 指向 ./skills/, capabilities 只有 Read | 可调用评审 skills, defaultPrompt 三句示例                                                                                                                                                                                                            |
| Cursor      | plugins/open-code-review/.cursor-plugin/plugin.json, skills 指向 ../skills/                       | 可移植 skills, 手动安装到 ~/.cursor/plugins/local/open-code-review/                                                                                                                                                                                  |
| Kimi Code   | 仓库根 .kimi-plugin/plugin.json (仓库本身即插件根), skills 与 commands 指向 plugins 目录          | slash commands 加 skills                                                                                                                                                                                                                             |
| OpenCode    | plugins/open-code-review/opencode/open-code-review.ts (TypeScript 插件)                           | 原生 tool: 定义 ReviewInput (commit/from/to/resume/background/exclude/model/concurrency/timeoutMinutes 等), spawn ocr, OcrExecutionError 封装退出码/信号/双通道输出, 临时目录清理带重试 (backgroundCleanupMaxRetries = 20, 注释说为杀软文件锁留时间) |
| QCA Forward | plugins/open-code-review/qca/ (template.example.json + system-prompt.md)                          | 宿主模型走委托模式 + 可发布模板                                                                                                                                                                                                                      |

skills/ 是两个可移植 skill 的单一事实源 (plugins/open-code-review/skills/ 是其拷贝):

- skills/open-code-review/SKILL.md: 标准评审 skill, frontmatter 声明四种协议依赖 (Anthropic、OpenAI Chat Completions、OpenAI Responses、AWS Bedrock); 工作流 Step 1 要求收集业务上下文经 --background 传入; 明确"不要预检 ocr 是否安装" — 跳过 command -v 之类探测以省一次工具调用, 仅在 command not found 时才按 Troubleshooting 安装; 记录了超时口径 (--timeout 乘轮数, 默认 15 分钟 × medium 2 轮 = 30 分钟) 与并发默认 8;
- skills/open-code-review-delegate/SKILL.md: 委托模式 skill, 声明不需要配置 LLM 端点; Step 1 即 ocr delegate preview --format json。

## 十六、配置体系与遥测

用户配置文件是 ~/.opencodereview/config.json (cmd/opencodereview/config_cmd.go:98 以 filepath.Join 拼接 home、.opencodereview、config.json)。Config 结构体 (config_cmd.go:349) 字段:

| 字段             | 说明                                                                                                                                                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| provider、model  | 激活的 Provider 与模型                                                                                                                                                                                              |
| max_tokens       | 每文件 prompt token 上限 (resolveMaxTokens: CLI 高于配置, 配置高于模板默认)                                                                                                                                         |
| effort           | 评审力度预设                                                                                                                                                                                                        |
| providers        | 预置 Provider 的覆盖项, 键形如 providers.名称.字段 (setProviderValue 校验预置存在)                                                                                                                                  |
| custom_providers | 自定义 Provider, 与预置重名会报错要求改名或改用 providers 段                                                                                                                                                        |
| llm              | LlmConfig: url、auth_token、auth_token_cmd (stdout 即 token)、auth_header、model、protocol (规范协议名, 优先于 use_anthropic)、use_anthropic (nil 时默认 true)、timeout_sec、extra_body、extra_headers、retry_codes |
| language         | 评审输出语言 (action.yml 的 language 输入写到这里)                                                                                                                                                                  |
| telemetry        | TelemetryConfig: enabled、exporter (console/otlp)、otlp_endpoint、content_logging                                                                                                                                   |
| mcp_servers      | MCP 服务器配置表                                                                                                                                                                                                    |

交互入口: ocr config provider 与 ocr config model 是 bubbletea TUI (charm.land/bubbletea/v2 + bubbles/v2 + lipgloss/v2, go.mod 直接依赖), 引导选 Provider、输 API key、选模型并自动连通性测试 (internal/config/testconnection/task.json 提供测试会话); 非交互用 ocr config set provider 加名称。未知 JSON 字段保留在各结构体的 unknownJSONFields 私有字段里, 写回时不丢失。

遥测 (internal/telemetry/): 默认关闭, 主开关是环境变量 OCR_ENABLE_TELEMETRY=1 (config.go resolveEnv); OTEL_SERVICE_NAME 覆盖服务名 (默认 open-code-review); exporter 支持 console 与 otlp, OTLP 协议 grpc、http/protobuf、http/json; content_logging 控制是否把 prompt/响应内容写进日志事件。go.mod 直接依赖全套 otel 1.45.0 导出器 (otlptrace/otlpmetric 的 grpc 与 http 变体加 stdout 变体)。Agent 全链路埋点: diff.parse span (files.changed、lines.inserted/deleted)、review.started 与 review.skipped 事件、每组的 subtask.execute.group span、main.loop span、review_filter.execute、plan.skipped/failed、工具调用 RecordToolCall 与重试报告。

## 十七、测试设施与工程纪律

测试规模: 233 个 _test.go (不含 pages/ 与 extensions/), cmd 层有大量 e2e 风格测试 (progress_stream_e2e_test.go、retry_report_e2e_test.go、manual_e2e_retry_test.go、retry_fake_llm_test.go — 用假 LLM 跑重试路径)。

Makefile 纪律:

| 目标                        | 内容                                                                                                                                     |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| test                        | LC_ALL=C go test -v -race -count=1, 包列表 go list ./... 过滤 /extensions/ (LC_ALL=C 保证 git 输出英文消息)                              |
| coverage                    | 覆盖率门槛 90%, 低于即 fail                                                                                                              |
| check                       | license-check + english-check + go mod tidy + gofmt -s + go vet                                                                          |
| dist                        | clean、6 平台交叉编译 (CGO_ENABLED=0, -s -w 加版本 ldflags)、shasum -a 256 生成 sha256sum.txt、写 VERSION                                |
| license-add / license-check | scripts/add-license.sh 按扩展名选注释语法补 SPDX 头; verify-license.sh 校验                                                              |
| english-check               | scripts/verify-english-only.go 强制源码纯英文 (含变音符与全角标点), docs/i18n 与 pages 翻译目录豁免, 单行可用 allow-non-english 标记豁免 |

npm 侧测试 (package.json scripts): test:github-actions 依次跑 post-review-comments.test.js、check-translation-sync.test.js、action-contract.test.js、check-plugin-contract.test.js; test:update 跑 version.test.js; test:launcher 跑 bin/ocr.test.js — JS 壳与 action 逻辑都有独立测试。

CI 工作流 (.github/workflows/, 共 12 个): ci.yml (test/windows/cross-compile 三个 job, test job 步骤含生成物校验、license、action 钉扎、english-only、格式、行尾 LF、go.mod tidy、vet、govulncheck、覆盖率门槛、构建与 smoke test)、action-contract.yml、codeql.yml、deploy-pages.yml、pages-ci.yml、frontend-ext.yml、idea-ext.yml、vscode-ext.yml、plugin-contract.yml、translation-sync.yml、release.yml、ocr-review.yml (自举: 仓库用自己的 action 评审自己的 PR)。release.yml 的 build job 在 self-hosted runner 的 golang:1.26.6 容器里跑 6 平台矩阵, ldflags 注入 main.Version/GitCommit/BuildDate (cmd/opencodereview/version.go 的三个占位变量); release job 的 permissions 带 id-token 与 attestations write 做构建溯源, 发布说明按 feat/fix/refactor/docs 分类提交信息自动生成。

AGENTS.md (给 AI 助手的项目指南) 要点: 提交前必须先跑 ocr review --audience agent --background "简述背景需求" 自评审; commit message 用英文; 行尾必须 LF (git add --renormalize . 修正); 新文件补 SPDX 头 (make license-add); 改 README 必须同步四个语言翻译; AI 使用纪律八条 — 必须在 issue/PR 披露用了 AI 及具体工具模型、必须理解 AI 写的每一行、必须能自己解释每处改动 (AI 只能润色措辞不能代答)、禁止"AI 生成→修→修→修"的循环、AI 产出必须自审后才请人评审、禁止给 AI 署名 trailer (Assisted-by、Co-developed-by 等)、commit message 不过长、做不到就关闭 issue/PR。CONTRIBUTING.md 补充: 分支前缀 feat/fix/docs/refactor/test/chore, Conventional Commits, Go 1.25+ 与 Make 为开发前提, upstream 只读、一切走 fork + PR。

## 十八、安全设计与治理文档

ASSURANCE_CASE.md 给出完整威胁模型: 系统边界是"读本地 git diff、HTTPS 送 LLM、展示评论、可选本地 web viewer"; 角色信任分级 — 本地用户可信、LLM provider API 半可信 (响应先验证再使用)、git 仓库半可信 (diff 可能含对抗内容)、网络不可信 (全 TLS)、浏览器不可信 (DNS rebinding 风险)。代码层可见的对策样本:

- validateReviewRefs (review_cmd.go, 注释引用 issue #112): --from/--to/--commit 的值必须是真实 commit 引用且不得以连字符开头, 经 git rev-parse --verify --end-of-options 校验 — 防 ref 选项注入;
- viewer hostguard 回环白名单 (见第十节);
- allowlist 的 default_secret_patterns.json 挡密钥文件进评审;
- install.js 强制 HTTPS 与 sha256 校验;
- action 第三方 action SHA 钉扎加 verify-action-pins.sh;
- delegate 与 action 配置步骤刻意不把 token 落盘 (auth_token_cmd)。

治理文档: GOVERNANCE.md 描述开放治理与决策方式 (目标: 开放、务实、透明、对公共 API 与安全敏感变更保守、多组件多维护者可持续); CODE_OF_CONDUCT.md、ROADMAP.md 齐备。ROADMAP 的 Current State (Mid-2026) 与 Planned H2 2026 值得对照代码: Planned 里的 JetBrains 插件与 Delegate Mode 在仓库里已经落地 (extensions/idea 存在且功能完整、internal/delegate 与 ocr delegate 已实现), 说明 ROADMAP 文档滞后于代码; Ultra Mode (更高召回、换 token 与时间的可选模式) 未见对应实现。ROADMAP 还把"通过 MCP 暴露 OCR"写在 Current State, 但代码里只有 MCP 客户端方向 (见第七节)。

## 十九、本地运行方式

从零开始跑通一次评审的最短路径 (综合 README Quick Start 与 Makefile):

```bash
# 安装
npm install -g @alibaba-group/open-code-review

# 配置 LLM (交互式 TUI: 选 provider、输 key、选模型、自动连通性测试)
ocr config provider
ocr config model
ocr llm test

# 评审
cd your-project
ocr review                                    # workspace: staged + unstaged + untracked
ocr review --from main --to feature           # merge-base 区间
ocr review --commit abc123                    # 单 commit
ocr review --format json --output result.json # 机读输出, 供宿主 agent 消费
ocr review --preview                          # 只看文件选择结果, 不建会话不调 LLM
ocr scan --path internal/agent                # 全文件评审某个目录
ocr delegate preview                          # 委托模式: 只出评审规格, 不需要 LLM
```

开发者路径 (CONTRIBUTING.md): fork + clone, make build 产出 dist/opencodereview, make test 跑 race 测试, make coverage 验证 90% 门槛, make check 做提交前全套; 改 Provider 注册表后 go generate ./internal/llm 并提交两个生成物。会话数据全部落在 ~/.opencodereview/ (config.json、sessions/、update 状态文件), 删除该目录即完全重置。

## 二十、总结与评价

从代码看, OCR 最鲜明的特征是"把评审流程里能确定的部分全部从模型手里拿走":

1. 流水线每个环节都有工程闸门 — 文件选择是纯函数 (--preview 与真实运行共用, issue #782 的教训), 分组有文件数上限与兜底策略, 轮数/工具请求数/token 预算全部是模板标量, 评论定位先走确定性滑动窗口与跨文件搜索、LLM 重定位只是第三级 fallback;
2. Agent 被限定在一个精调过的窄工具面上 — 7 个内置工具 (含 task_done 与 unknown 哨兵), 工具 schema 把定位契约 (existing_code 必须与 diff 精确一致) 写进 prompt, 评论的 category/severity 枚举在 tools.json 与 GitHub Action 的路由逻辑之间共享同一来源;
3. 工程质量约束罕见地严格 — 90% 覆盖率门槛、源码纯英文检查、SPDX 头检查、action SHA 钉扎检查、生成物一致性检查都在 CI 里强制执行, JS 壳与 action 脚本也各有测试;
4. 分发矩阵完整 — 6 平台二进制、npm optionalDependencies 平台包、GitHub Release 加 sha256、安装脚本、自更新提示、composite action、6 套 CI 示例、4 个以上 coding agent 插件、2 个 IDE 扩展、2 个可移植 skill;
5. 委托模式 (delegate) 是商业模式上的巧思 — OCR 退化为确定性规格生成器, 让宿主 agent 用订阅额度执行评审, 绕开"必须自备 API key"的门槛。

需要注意的点: ROADMAP.md 与代码现状有三处出入 (JetBrains 插件与 delegate 已实现、MCP 方向), 文档时效性依赖维护者更新; 仓库内 package.json 的 0.0.0 版本意味着从源码直接 npm publish 会得到占位版本, 真实版本只存在于 CI 发布链路; 34 个 action inputs 的复杂度较高, 使用者建议从 examples/github_actions 的示例起步。
