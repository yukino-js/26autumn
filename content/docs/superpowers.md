---
title: "Superpowers: 面向编码 Agent 的软件方法论与技能注入体系"
description: "拆解 Superpowers 的设计选择与实现: 为什么把开发流程写成技能并强制注入、using-superpowers 的 bootstrap 链路、15 个技能的分类与触发方式、多 harness 适配架构、零依赖 visual companion 服务器、证据化诊断流程、测试与质量体系及其适用边界"
local_path: "$HOME/Downloads/superpowers"
---

Superpowers 是一套面向编码 Agent 的软件开发方法论, 其本体不是运行时或 CLI, 而是一批可组合的 markdown 进程文档 (技能) 加上少量粘合代码。它把 "Agent 应该怎么干活" 写成技能, 再通过每个宿主自己的会话启动事件强制注入模型上下文, 让方法论在用户不做任何特殊操作的前提下自动生效。本文要回答的是这套东西由什么构成、为什么可以这样构成、各条机制具体怎么实现, 以及它在什么场景下成立、在什么条件下不成立。读者最好已经了解至少一个编码 Agent 宿主 (Claude Code、Codex、Cursor 等) 的工作方式, 并对 TDD、代码评审这类工程实践有基本认识。

与同目录的 [OpenSpec](./openspec) 不同, Superpowers 不定义文件协议, 也不提供校验器; 它的核心资产是行为规范文本与把它们送进模型上下文的注入器。

## 一、Superpowers 是什么

### 1.1 构成: 技能加注入器, 没有自己的运行时

从实现角度看, Superpowers 由三个可分离的部分组成:

1. 技能: `skills/` 下的 15 个目录, 每个含一个 `SKILL.md`, 是全部宿主逐字共享的单一事实来源。技能正文只描述动作, 例如 "invoke a skill"、"read a file"、"dispatch a subagent"、"create a todo", 从不写死具体工具名。
2. 工具映射: 把动作词表翻译成宿主真实工具名的参考文件, 位于 `skills/using-superpowers/references/` 下按宿主命名 (如 `codex-tools.md`、`pi-tools.md`), 或内联在宿主的 bootstrap 注入器与插件清单里。
3. bootstrap 注入器: 每个宿主一份, 在会话开始时把 `skills/using-superpowers/SKILL.md` 全文包进 `<EXTREMELY_IMPORTANT>` 标签注入上下文, 并附上工具映射。

仓库里没有任何 Superpowers 自己的进程在常驻运行。bash/JS/TS/Python 代码只承担三类职责: "把 markdown 送进上下文" 的注入器 (hook 脚本与各宿主插件)、brainstorming 的可视化伴侣服务器, 以及计划执行与诊断的一批小助手脚本 (workspace 解析、任务简报提取、评审 diff 打包、任务启停)。因此它的失效模式不是崩溃, 而是注入没发生——此时磁盘上的技能文件是死的, 模型不会主动去读一个它不知道存在的目录。

### 1.2 四条哲学与对应的强制机制

方法论的四条原则不是口号, 每一条都有一个技能把它落成不可绕过的流程:

```text
Test-Driven Development  永远先写测试
Systematic over ad-hoc   流程优于猜测
Complexity reduction     简单是首要目标
Evidence over claims     声明成功之前先验证
```

| 原则                    | 承载技能                         | 强制手段                                                        |
| ----------------------- | -------------------------------- | --------------------------------------------------------------- |
| Test-Driven Development | `test-driven-development`        | Iron Law: 没有失败测试就不许写生产代码, 先写的代码必须删掉重来  |
| Systematic over ad-hoc  | `systematic-debugging`           | 四阶段根因流程, 未完成根因调查不许提修复方案                    |
| Complexity reduction    | `writing-plans`、`brainstorming` | YAGNI、计划只记录决策不抄代码、按 "最小可独立测试交付物" 切任务 |
| Evidence over claims    | `verification-before-completion` | 证据必须产生于当前这条消息内, 否则不得声明通过                  |

这套 "强制" 不靠代码拦截实现, 而靠提示文本的行为塑造: 1% 规则、反合理化清单、HARD-GATE 审批语义 (见第三节)。因此它的可靠性上限取决于技能文本的质量, 这也解释了为什么仓库把大量精力投入到写作方法学与压力测试上。

### 1.3 与 OpenSpec 的定位对比

两者都在解决 "需求只存在于聊天记录时, 编码助手会自信地构建错误的东西", 但切入的层面不同:

| 维度     | OpenSpec                                        | Superpowers                                                               |
| -------- | ----------------------------------------------- | ------------------------------------------------------------------------- |
| 本质     | 协议层: 目录约定 + CLI 校验器 + artifact 体系   | 方法论层: 注入模型上下文的进程文档 + 宿主插件粘合层                       |
| 对齐载体 | 文件 (proposal/specs/tasks), 人和 AI 审阅同一份 | 对话流程 (审批门 + 计划评审), 文件是流程的产物                            |
| 交付物   | `openspec/` 目录, 归档即真相源                  | `docs/superpowers/specs/` 与 `docs/superpowers/plans/` 下的设计与计划文档 |
| 执行方式 | 交给任意 AI 工具按 tasks.md 实施                | 自带两种执行器: 每任务新子代理加评审, 或本会话内联加终审                  |
| 质量保证 | schema 校验 (关键词、场景计数)                  | 过程纪律 (Iron Law、证据引用 path:line、验证门)                           |

两者正交: OpenSpec 管 "agreement 长什么样", Superpowers 管 "agent 怎么干活"。Superpowers 的 spec/plan 文件体系本身是一套轻量 spec-driven development 产物, 只是校验靠技能内建的自审清单和评审子代理完成, 没有独立 CLI; 仓库自己的设计文档也确实存放于 `docs/superpowers/specs/` 下的日期命名文件, 与方法论要求用户做的完全一致。

## 二、为什么把流程写成技能并强制注入

### 2.1 三个被反复观察到的失效模式

Superpowers 的设计动机可以还原为对真实会话的归纳:

1. 模型会跳过流程直接动手。面对 "帮我做个 X", 模型倾向于立刻写代码, 而不是先确认 X 到底指什么。
2. 上下文压缩会冲掉方法论。长会话发生 compaction 之后, 之前注入的规则被挤掉, 行为随即退化。
3. "写在文档里" 不等于 "模型会读"。把方法论放进 README、写进项目 markdown, 模型不会主动加载它——除非它知道该文件存在且被要求读。

第一点对应技能的内容设计, 第二、三点对应注入机制的设计。移植指南的表述是: bootstrap 就是整个集成, 没有它技能文件是惰性的。

### 2.2 技能是行为塑造代码, 不是文档

仓库把 `SKILL.md` 当作需要测试的行为塑造代码来对待, 而不是给人看的说明。最直接的证据是 description 的写法: 技能 frontmatter 的 `description` 只写 "何时使用", 绝不概括 "做了什么"。这源于一次真实事故——某评审技能的 description 曾写了工作流摘要 ("任务之间的代码评审"), 结果模型只执行了摘要里提到的那一次评审, 而技能正文的流程图要求的是两次 (spec 合规评审加代码质量评审)。结论被写进技能写作规范: 概括流程的 description 会成为模型跳过正文的捷径, 正文于是退化成没人读的文档。

这条约束对任何给 Agent 编写工具或技能描述的场景都适用, 也是本文认为最值得迁移的一条经验。

### 2.3 bootstrap 技能本体: using-superpowers 的装置构成

`skills/using-superpowers/SKILL.md` 篇幅很短, 但每一段都是行为塑造装置:

- `<SUBAGENT-STOP>` 块: 被派发执行具体任务的子代理跳过 bootstrap。这防止 worker 重启 controller 的工作流 (头脑风暴、审批循环)。因为该注释只靠模型自觉, OpenCode 插件等后续用结构化信号 (会话是否带 parentID) 做了双保险。
- `<EXTREMELY-IMPORTANT>` 块与 1% 规则: 只要认为某个技能有 1% 可能适用, 就必须调用; 适用即无选择权, 不允许用 "合理化" 绕开。
- The Rule: 在任何回应或行动之前先调用相关技能, 包括提澄清问题、探索代码库、查看文件之前; 进入 plan mode 前若未头脑风暴则先调用 brainstorming; 调用后宣告 "Using [skill] to [purpose]"; 技能有 checklist 则每项建一个 todo。
- Skill Priority: 多个技能适用时 process skills 先行——"Let's build X" 路由到 brainstorming, "Fix this bug" 路由到 systematic-debugging, 然后才轮到实现类技能。
- Red Flags 表: 十二组 "合理化借口对现实" 的对照, 例如把 "这只是个简单问题" 对应到 "问题也是任务, 要检查技能", 把 "我先快速看下 git/文件" 对应到 "文件没有对话上下文, 先查技能"。这张表本身是反合理化装置, 依据来自技能写作方法学。
- Platform Adaptation: 按宿主列出六个工具映射参考文件指针 (Claude Code、Codex、Pi、Antigravity、Hermes Agent、Muse), 宿主命中才读对应文件。
- 用户指令优先级链: 用户指令文件 (CLAUDE.md/AGENTS.md/GEMINI.md 等) 与直接要求高于技能, 技能高于默认行为; 只有人类伙伴明确要求时才跳过技能工作流。

### 2.4 注入链路: session-start 的三形状输出

shell-hook 形态的宿主共用 `hooks/session-start` 脚本 (无扩展名, bash), 逻辑链路是:

1. 从脚本自身路径推导插件根: 不调用 `dirname`, 而是用 `case "$0"` 按是否含 `/` 或 `\` 做模式切分取目录部分再 `cd` 取绝对路径——这样即使脚本经 PATH 调用、即使 PATH 上没有 coreutils, 推导依然成立。
2. 用 `$(<file)` 读取并原样携带 `using-superpowers/SKILL.md` (含 frontmatter), 同样不依赖 `cat`; 读取失败回退为错误字符串。
3. 用 bash 参数替换做 JSON 转义 (反斜杠、双引号、换行、回车、制表符共五次替换), 注释说明这比逐字符循环快几个数量级。
4. 组装注入文本: `<EXTREMELY_IMPORTANT>` 包裹的 using-superpowers 全文, 前面加一句说明 "这是你的技能系统入口, 其余技能用 Skill 工具"。
5. 按环境变量检测平台, 输出三种互斥的 JSON 形状之一; 输出统一经 `emit_json` 函数——`printf` 的结果再管道给 `cat`, 用于吸收 Windows Git Bash 下宿主提前关闭管道产生的 EPIPE, `cat` 不存在时退化为直接 `printf`。

| 检测条件                                                                    | 输出形状                                                                    | 消费方                 |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ---------------------- |
| 设置了 `CURSOR_PLUGIN_ROOT` (排最前, 因 Cursor 可能同时设置 Claude 变量)    | 顶层 `additional_context` (snake_case)                                      | Cursor                 |
| 设置了 `CLAUDE_PLUGIN_ROOT` 且 `COPILOT_CLI` 与 `MUSE_PLUGIN_ROOT` 均未设置 | 嵌套 `hookSpecificOutput.hookEventName=SessionStart` 加 `additionalContext` | Claude Code 及兼容宿主 |
| 设置了 `MUSE_PLUGIN_ROOT`                                                   | 同 Claude 式嵌套                                                            | Muse                   |
| 其他 (Copilot CLI 或未知平台)                                               | SDK 标准顶层 `additionalContext`                                            | GitHub Copilot CLI 等  |

互斥是硬约束: Claude Code 会同时读 `additional_context` 与 `hookSpecificOutput` 且不去重, 所以每个平台只能输出它消费的那一个字段, 否则要么不注入要么双重注入。`tests/hooks/test-session-start.sh` 对 Claude、Cursor、Copilot CLI 三种环境变量组合逐一断言 "恰好一个形状出现、其余字段不得出现"。脚本用 `printf` 而非 heredoc 输出, 以规避 bash 5.3+ 的 heredoc 挂起问题。

注册配置因宿主而异, 两套 schema 并存:

- `hooks/hooks.json` (Claude Code 及兼容宿主): SessionStart 的 matcher 为 `startup|clear|compact`, 即会话启动、`/clear`、上下文压缩后三种事件都重新注入——这直接针对 "compaction 冲掉方法论" 的失效模式。命令声明 `"shell": "bash"`, 在 Windows 上强制走 Git Bash; `"async": false` 保证注入先于首条消息。
- `hooks/hooks-cursor.json` (Cursor): 完全不同的 schema——顶层 `"version": 1`、小写 `sessionStart` 键、相对路径命令, 没有 matcher/type/async 字段。

### 2.5 polyglot hook 分发器与 Windows 降级

`hooks/run-hook.cmd` 是一个 cmd/bash 双语文件: 第 1 行用 shell 语法 (`: << 'CMDBLOCK'`) 把整个 batch 段当作 no-op heredoc 吞掉, Windows `cmd.exe` 则把同一段当批处理执行。Windows 段按固定顺序探测 Git Bash: 两个 Program Files 安装路径、`%LOCALAPPDATA%` 用户级安装 (带 defined 守卫)、再用 `where.exe` 搜 PATH——搜索时跳过无扩展名结果, 并显式排除 System32/Sysnative/WindowsApps 下的 WSL bash 启动器 (它们是代理而非真 bash)。找到就用 bash 执行目标脚本并透传参数; 找不到 bash 则 `exit /b 0` 静默退出——插件仍可用, 只是没有 SessionStart 注入, 属于优雅降级而非报错。Unix 段最后一行是 `exec "${BASH:-bash}"` 加脚本路径, 允许宿主指定 bash 位置。

被分发的脚本刻意不带扩展名 (名为 `session-start` 而非 `session-start.sh`): 某些宿主对任何 `.sh` 命令会自动前置 bash, 反而破坏分发器自身。仓库还用 `.gitattributes` 强制 hook 与脚本使用 LF 行尾, 避免 Windows 检出时 CRLF 破坏 shell 脚本。

## 三、技能体系: 分类与触发方式

### 3.1 技能清单与分类

`skills/` 下恰好 15 个技能, 按职能分为四类:

| 分类          | 技能                                                                                                                                                                                                        |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Testing       | test-driven-development                                                                                                                                                                                     |
| Debugging     | systematic-debugging、verification-before-completion、diagnosing-superpowers                                                                                                                                |
| Collaboration | brainstorming、writing-plans、executing-plans、subagent-driven-development、dispatching-parallel-agents、requesting-code-review、receiving-code-review、using-git-worktrees、finishing-a-development-branch |
| Meta          | using-superpowers、writing-skills                                                                                                                                                                           |

其中多数技能带附属文件: 重型参考文档 (`references/`)、派发子代理时逐字使用的提示词模板 (放在技能根目录或 `prompts/` 下, 如 SDD 的 `implementer-prompt.md`、diagnosing-superpowers 的 `prompts/` 目录)、以及可执行脚本——脚本多通过解释器调用 (`bash scripts/tool.sh`、`node scripts/tool.js`), 因为部分宿主的打包器会剥掉可执行位。

### 3.2 触发与路由机制

技能路由依赖两层信息: 宿主按技能元数据 (name 加 description) 做匹配, 模型按 description 里的 "何时使用" 判断是否加载。因为加载技能本身有 token 成本, 仓库刻意让 description 只写触发条件。

进入会话后, 触发顺序由技能内的路由规则决定:

- process skills 先行。头脑风暴、系统化调试这类流程技能先于实现类技能。
- 硬门阻断。brainstorming 里定义 HARD-GATE: 人类伙伴批准设计文档 (小改动是短文档, 项目是完整文档) 之前, 任何构建动作都不许做——写产品代码、脚手架、装依赖、创建项目、调用实现技能; 读与探索不受限。Red Flags 表强调 "对想法说好不等于批准了还没写出来的描述"; 项目文档批准后下一步只许进 writing-plans, 唯二例外是用户明确跳过提问 (技能结束、门随之撤掉) 与已批准的 spike (产物保持一次性标签, 想保留它属于重新过门的新请求)。
- 反合理化。多数技能带 Common Rationalizations 或 Red Flags 表, 把 "这太简单了不用走流程" 这类借口逐条对应到现实。这类文本来自对真实失败会话的归纳, 并通过技能写作方法学的压力测试验证有效。

### 3.3 主干工作流七步

方法论的主干流程, 每一步由一个技能的自动触发点串起来:

```text
1. brainstorming        写代码前激活: 提问细化想法、分节回放理解、摆出备选方案、按尺寸档产出设计
2. using-git-worktrees  设计批准后: 建隔离工作区, 跑项目 setup, 验证干净测试基线
3. writing-plans        拿到批准的设计后: 拆成带文件路径、接口签名、验证步骤的任务
4. subagent-driven-development  拿到计划后二选一
   或 executing-plans            (每任务新子代理加评审, 或本会话内联加终审)
5. test-driven-development      实现期间: 强制红绿重构, 先于测试写的代码删掉重来
6. requesting-code-review       任务之间: 对照计划评审, Critical 阻塞推进
7. finishing-a-development-branch  完成后: 验证测试、呈现集成选项、清理 worktree
```

### 3.4 协作类技能的设计要点

brainstorming。核心目标是在动手之前弄清用户真正想要什么、为什么。对话纪律: 第一条消息以一个问句收尾——用户已给出 spec 或详细请求时, 整条消息控制在约 200 词, 先复述请求的形状再提问, 否则就最大的未定点抛一个开放问题; 若用户的消息并非主动要求头脑风暴, 在问题之后附一句 "也可以直接开始" 的退出通道, 用户接受则技能结束、按普通流程构建; 此后每条消息只以一个问题结尾; 提问之前先自己看代码和文件 (Look Before You Ask), 能从仓库得到答案的不问用户; 理解按 200-300 词分节回放 (Play It Back), 每节结尾问 "哪里不对或缺了", 用户说过的才算数, 猜的明确标成猜测; 回放段若要描述用户会看的东西 (页面、屏幕、日程等) 且可视化伴侣还没提供过, 就先以独占一条消息发出提供, 该回放段顺延到下一条消息。理解足够后有一个独立的强制步骤 "摆出方案" (Lay out the approaches): 用单独一条消息给出两到三个备选加明确推荐, 由用户选定, 然后才做尺寸判定——尺寸结论要大声说出来供用户否决: 请求已含全部关键信息的快而清任务直接做、不进对话; 其余工作分两档, 小改动写短设计文档 (把已聊定的内容落成文字, 不做建造者检查), 项目写完整设计文档, 都提交到 `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`、都含 Approaches 一节记录备选与取舍, 批准后进 writing-plans。棘轮是单向的: 任务中途变大就停下来说明并升一档; 若实际是多个独立项目, 约定顺序逐个头脑风暴。项目档在设计文档交付前还要过一次 "建造者检查" (builder check): 派一个新鲜子代理按 `builder-check-prompt.md` 从实现者视角审文档, 把它的问题分成三堆——对话已答 (写进文档)、次要 (自行定夺并在文档标注)、必须问用户的 (按重要性一次性带回), 这是检查产生的唯一一轮提问; 宿主没有子代理能力时降级为自审。spike 作为可行性探针随时可提议: 一次性原型, 没有测试或只有极少测试, 跳过计划、实现与评审流程, 把学到的东西带回对话; 保留其产出是新请求, 须重新过 HARD-GATE。

using-git-worktrees。原则是 "先检测既有隔离, 再用宿主原生工具, 最后回退到 git, 绝不与宿主对抗"。检测用 `git rev-parse` 比较 git-dir 与 common-dir, 并有子模块守卫 (`git rev-parse --show-superproject-working-tree` 有输出即视为普通仓库)。原生 worktree 工具优先, 因为在有原生工具时绕过它手工 `git worktree add` 会制造宿主看不见也管不了的幻影状态; 回退路径要求创建前用 `git check-ignore` 确认目录被忽略, 防止把 worktree 内容意外提交进仓库; 沙箱拒绝时告知用户并就地工作。

writing-plans。计划保存为 `docs/superpowers/plans/YYYY-MM-DD-<feature-name>.md`, 读者画像是 "没见过这个代码库、也没看过这份 spec 的工程师"。计划只记录执行者无法独自做出的决策: 用哪些文件、哪些名字与签名、spec 里哪些值、哪些测试证明每个任务。关键构件包括: 任务定义前先映射文件与职责; 任务按 "承载自身测试循环、值得一个陌生评审者把关的最小单元" 切分, 步骤粒度是 "一个动作一个可检查结果" (写失败测试、跑它看它失败、实现、跑通、提交各算一步); 每个任务写明 Consumes/Produces 的确切接口, 因为实现者只看到自己的任务; 计划头除 Goal/Architecture/Tech Stack/Spec 外还有 Global Constraints (spec 的项目级约束逐字抄入, 每个任务隐式继承) 与 Review Focus (spec 隐含但无任务测试覆盖、最可能伤到用户的五类输入或失败模式, 每条随后补进归属任务的测试)。判据是 "计划是执行者无法独自做出的决策集合; 描述长于它描述的代码, 就说明计划已经把代码写了出来"。写完跑五项自审 (spec 覆盖、步骤扫描、类型一致性、Review Focus、篇幅比例), 然后向用户交接: 呈现 Subagent-driven 与 Native 两种执行方式并给出推荐, 等用户选定后才进入实现。

subagent-driven-development。全库最复杂的技能, 原则是 "每任务新子代理加任务评审加宽终审"。子代理绝不继承会话上下文, 由 controller 精确构造所需上下文。几个有代表性的设计:

- 执行纪律: 叙述至多一行; 任务之间不向人类请示; 冲突与歧义由 controller 裁决并记账, 格式为 `Ruling: 决定 — 理由 — 判断错的代价`; 只有四种情况才停下——不可逆操作、安全敏感动作、约定需先问的副作用、计划糟糕到每条路都是猜测。
- ledger: 每个计划一个 workspace (`.superpowers/sdd/<plan-basename>/`), 由 `bash scripts/sdd-workspace` 解析; ledger 文件 `progress.md` 首行是 `# SDD ledger — plan: <路径>`, 用来对抗 compaction——它是恢复地图, 记录任务完成、裁决与延期的次要问题, 首行指明所属计划以避免不同计划共享进度。
- 任务循环: 用 `bash scripts/task-brief` 生成任务简报文件, 精确值只放进简报, 禁止把累积历史贴进派发提示; 实现者报告分四种状态 (DONE / DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED), 各有处理程序; 再用 `bash scripts/review-package` 把提交列表、stat 摘要与完整 diff 打包成一个文件, 把简报、报告、评审包三个路径交给任务评审者, 同时给出 spec 合规与代码质量两个裁决。评审基线 BASE 用 `git rev-parse HEAD` 在派发前取, 绝不用 `HEAD~1` (实现者可能提交多次)。
- fix loop: 评审报告 spec 不合规、有 Critical 或 Important 发现、或 ⚠️ 项被确认为真实缺口时进入修复循环, 每任务最多五轮——第 1-3 轮恢复原实现者 (它有上下文), 第 4-5 轮换更强模型上的新鲜子代理; 触顶时不再循环, controller 逐条裁决 (breaker adjudication)。
- 成本工程: 每个角色用能胜任的最弱模型, 每次派发都显式声明模型 (缺省继承会话模型等于全用最贵); 注意回合数常常比 token 单价更贵; 工件以文件传递, 避免提示膨胀; 小的同形状编辑合并为一次派发。
- 终审与收尾: 全分支一次宽评审, 用最强模型; 终审发现只允许一波修复加恰好一次范围限定的复审; 收尾前把所有裁决行按顺序收集进最终消息的 "Rulings I made" 清单——"一个随 workspace 一起消失的裁决, 是一个秘密做出的决定"。

executing-plans。本会话内联执行的 Native 模式, 与 SDD 共享同一 workspace 与 ledger 格式, 因此一个计划可以在执行中途换执行器并从同一 ledger 续跑。它放弃每任务新上下文, 用别的手段补回: 简报即 spec, ledger 即记忆, TDD 是每任务的门, 终审是第二双眼睛; `scripts/task-start` 与 `scripts/task-done` 负责任务启停与 ledger 记账。它强调 "看着测试失败是一个步骤而不是形式"——实现存在之前就通过的测试是关于测试本身的发现。终审核后不再派发复审, 改为按效果给发现重新定级, 做一轮自修复, 每个修复自身走完整 RED→GREEN; 每个任务写入完成行之前要满足 completion contract 的四项证据 (简报点名的测试都在本任务跑过且读过输出、任务最终测试运行通过并由 `task-done` 把命令与结果写进 ledger、每条 `Expected:` 都与真实输出比对过、每处偏离简报都有 `Ruling:` 行)。宿主没有子代理工具时, 终审降级为对照计划与 diff 的自审。

评审两端。requesting-code-review 规定何时评审、如何取基线、如何派评审子代理, 并明确两条反合理化: 协调者不要自己 inline 评审 diff (会烧上下文), 不要给评审者会话历史 (让它面对工作产品而非你的思考过程)。receiving-code-review 则管反馈的接收纪律: 先读、再理解、再对照代码库验证、再评估、再回应、最后逐项实现; 禁止社交表演式回应 (感谢、"你说得对" 之类), 任何一项反馈不清楚就停下问清全部再动手; 外部评审者的建议要实现前先验证是否适用本库, 与本项目架构冲突时用技术推理推回。

finishing-a-development-branch。顺序是验证测试、检测环境、呈现选项、执行选择、清理。菜单必须逐字呈现, 集成决策属于用户; 丢弃工作只在明确请求时发生, 且要求键入确切的 `discard` 确认词; 只有当 worktree 位于约定的 `.worktrees/` 或 `worktrees/` 目录下时才由 Superpowers 负责清理, 否则宿主环境拥有该工作区。

dispatching-parallel-agents。用于 2 个以上无共享状态、无顺序依赖的问题域, 典型场景是并行调试。关键机制句是 "同一条响应里的多个派发调用等于并行执行; 每条响应一个等于串行"。它与 SDD 的边界很清楚: SDD 禁止并行实现者 (任务共享代码库会冲突), 本技能只用于独立问题域。

### 3.5 质量类技能

test-driven-development。Iron Law 是 "没有失败测试就不写生产代码", 违反字面规则即违反精神; 先写了代码就删掉, 从测试重新开始。红绿重构循环里有两个标注为 MANDATORY 的验证步骤: 确认测试因功能缺失而失败 (直接通过说明在测既有行为, 报错说明测试本身要修), 确认本次测试通过且项目套件仍全绿且输出干净——"只报告自己的测试通过、省略套件里的失败" 被明确定义为 "以省略作伪"。测试范围也有明确规定: "其他测试" 指项目套件而不是你自己的文件——任务里的范围界定限定交付物, 不限定验证范围。附属的 writing-good-tests 参考给出四条测试写作规则, 正文另配十一行的合理化对照表。

systematic-debugging。Iron Law 是 "未完成根因调查不许提修复"。四阶段依次为: 根因调查 (完整读错误、稳定复现、检查近期变更、在组件边界收集证据、沿数据流上溯到源头); 模式分析 (找同库可工作的相似代码、完整读参考实现、列举每一个差异); 假设与验证 (单一假设写下来、最小改动一次一个变量、失败就换新假设而不是叠加修复); 实现 (先建失败测试、只修已定位根因、修复连续失败三次则质疑架构而非继续试)。附属技术文档覆盖调用链回溯 (root-cause-tracing)、纵深防御 (defense-in-depth)、基于条件的等待 (condition-based-waiting, 用条件轮询替代任意延时, 附可复用的 TypeScript 示例) 与测试污染源定位脚本 (find-polluter.sh)。

verification-before-completion。证据门: 声明完成、修复或通过之前, 必须在本条消息内跑过验证命令并读完输出。"跳过任何一步等于撒谎而不是验证"。它为七类常见声明分别划定证据标准, 例如 "测试通过" 要求本次命令输出零失败, "构建成功" 要求退出码为零 (linter 通过不算), "回归测试有效" 要求走完红绿循环 (通过一次不算), "子代理已完成" 要求看 VCS diff 而不是采信报告, "需求满足" 要求逐条对照清单而不是测试通过。红旗清单把 "should"、"probably"、验证前的 "Great!/Perfect!" 都列为停止信号。

### 3.6 元技能 writing-skills

`writing-skills` 是整个方法论自举的支点: 写技能就是给流程文档做 TDD——test case 是压力场景, production code 是 `SKILL.md`, RED 是无技能时代理违规, GREEN 是有技能时遵从, REFACTOR 是发现新合理化借口后堵漏洞并保持遵从。它的 Iron Law 是 "没有失败测试就不写技能", 同样适用于对既有技能的编辑; 写完技能必须 STOP 并走完部署清单, 禁止批量创建而不逐个测试。

技能写作规范的要点:

- 技能是可复用的技术、模式或参考, 不是 "某次如何解决问题的叙事"。
- 是否创建看四条: 技术不显然、跨项目会再引用、模式有普适性 (非项目特有)、他人受益。用正则或校验就能强制的机械约束应当自动化, 文档只留给需要判断力的地方。
- frontmatter 只含 `name` 与 `description`, 总长上限 1024 字符 (agentskills.io 规范); description 以 "Use when..." 开头、用第三人称、只写触发条件与症状。
- 技能发现优化: 覆盖错误消息、症状、同义词、工具名等搜索词; 控制体积——getting-started 类流程每步 150 词内、高频加载技能 200 词内、其余 500 词内, 细节移入 `references/` 参考文件; 用显式的 REQUIRED SUB-SKILL 标记交叉引用, 避免会立即强制加载文件的链接语法。
- 文体要匹配失败类型 (Match the Form to the Failure): 压力下明知故犯的纪律失效用禁令加合理化表加红旗清单; 输出形状不对用正面配方 (声明输出由哪些部分按什么顺序构成); 漏掉必备元素用模板里的结构化必填槽位; 行为需随条件变化用绑定可观察谓词的条件句。两条附加规则: 不写 "除非有需要" 式的 nuance 从句 (会重开谈判空间, 真正的例外要写成绑定可观察谓词的独立条件句), 豁免条款没有范围效力 ("此限制不适用于代码块" 仍会压制代码块), 要豁免部分输出就得重构结构让规则够不到它。
- 措辞微测协议: 全压力场景测试慢且贵, 先做措辞级实验——每次一个新鲜上下文样本, 永远带无指导对照组 (对照组不出现该失败就不要写指导), 每变体至少 5 次重复 ("单样本会说谎"), 人工读每个命中 (模板回声会伪装成命中), 用方差判断措辞是否真的绑定行为 (五次重复收敛到同一形状才算生效)。
- 仓库引用的一项实证 (Meincke 等 2025 年 "Call Me A Jerk", 对 2.8 万次 AI 对话的测试) 表明, 说服技巧可以把合规率从 33% 提到 72%; 仓库自己的对照措辞微测则显示, 在塑形类场景下禁令式措辞的产出明显差于正面配方、甚至劣于无指导对照组——因此文体选择被当作经验问题而非教条。

## 四、多 harness 适配架构

### 4.1 三个组成部分与两条规则

移植指南 (`docs/porting-to-a-new-harness.md`, 800 余行) 把多宿主架构拆成三个组件: 宿主无关的技能、每宿主的工具映射、每宿主的 bootstrap。配套两条铁律:

1. 移植永远不改 `skills/*/SKILL.md` 正文, 唯一允许的改动是在 Platform Adaptation 指针列表加一行。技能被视为精心调校的行为塑造代码, 为 "合规" 改写它会被拒绝。
2. 一切通过宿主自己的安装机制投递, 绝不改用户的全局或个人配置文件。如果安装机制装不下 bootstrap, 那是一条要上报的限制, 而不是手改用户配置的许可。

硬性验收标准只有一条: 宿主必须能在每个会话开始时自动注入, 不允许任何 "每会话手动 opt-in"。验收测试是: 干净会话发送一句 "Let's make a react todo list", brainstorming 必须在写任何代码前自动触发。能力清单用于判断一个宿主能否被支持: 自动会话启动注入是硬要求; 技能发现与调用若无原生工具, 官方认可的回退是直接读 `SKILL.md`; 文件读写、shell 是必需; 子代理派发、todo、web 可降级。指南还提醒: 有些 "新宿主" 其实就是现有集成的另一个安装器, 仓库可能一行代码都不用加; 移植前不妨直接让目标模型枚举它自己的确切工具名。

### 4.2 三种集成形态

| 形态                      | 机制                                                              | 参考实现             | 主要坑                                                                      |
| ------------------------- | ----------------------------------------------------------------- | -------------------- | --------------------------------------------------------------------------- |
| Shape A shell-hook        | 宿主在会话开始运行 shell 命令并读其 stdout JSON                   | Cursor、Claude Code  | 环境变量、JSON 字段与嵌套、matcher、hook schema、插件根变量名全部因宿主而异 |
| Shape B in-process plugin | JS/TS/Python 模块用生命周期回调注册技能目录并在代码内变异消息数组 | OpenCode、Pi、Hermes | 依赖宿主加载器契约; 出错可能被宿主静默禁用                                  |
| Shape C instructions-file | 宿主加载由 manifest 声明的、随扩展分发的上下文文件                | Gemini               | `@` 引用在衍生宿主里可能只是提示而非保证展开                                |

形态可组合: 技能发现机制与 bootstrap 机制可以是不同形态, 但两者都必须走宿主自己的安装机制。Shape B 有一条通用经验: 注入用户消息而不是系统消息, 并按回调触发频率配去重守卫——上下文类回调往往每个 agent step 都触发。

### 4.3 宿主全景 (按机制)

| 宿主                             | 形态   | bootstrap 注入                                                                                              | 技能注册方式                                                                |
| -------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Claude Code                      | A      | SessionStart hook → 分发器 → session-start, 嵌套 `hookSpecificOutput.additionalContext`                     | 插件约定自动发现 `skills/`                                                  |
| Cursor                           | A      | `hooks-cursor.json` → 同一脚本, 顶层 `additional_context`                                                   | manifest 指向 `skills/`                                                     |
| Copilot CLI                      | A      | 共享 Claude 插件路径, 脚本按 `COPILOT_CLI` 环境变量走 SDK 标准顶层 `additionalContext`                      | 同 Claude                                                                   |
| Factory Droid / Qwen Code / Grok | A      | 直接消费 Claude Code 插件或复用同一 hook 路径                                                               | 同 Claude                                                                   |
| Antigravity                      | 元数据 | 无 session-start hook; 会话开始时宿主列出每个已装技能的 description, using-superpowers 的描述促使模型加载它 | manifest 只含市场元数据, 技能由宿主安装发现, 另配 antigravity-tools.md 映射 |
| Codex App / CLI                  | 原生   | 无 bootstrap 注入, 原生技能自触发; manifest 用字面量空 `hooks` 对象抑制自动发现回退                         | manifest 指向 `skills/`                                                     |
| Devin CLI                        | 元数据 | 无 hook; 会话开始时宿主把每个已安装技能的 name 与 description 放进系统提示词                                | 读 manifest 后自动发现同级 `skills/`                                        |
| Gemini CLI                       | C      | manifest 的 `contextFileName` 指向 `GEMINI.md`, 文件里是两条 `@` 引用                                       | 扩展打包的 `skills/` 自动发现                                               |
| Kimi Code                        | 声明式 | manifest 的 `sessionStart.skill` 声明会话开始加载的技能, 另内联 `skillInstructions` 工具映射                | manifest 指向 `skills/`                                                     |
| OpenCode                         | B      | V1 消息变换钩子 / V2 会话上下文钩子, 首条用户消息前插入 bootstrap                                           | V1 走 `config.skills.paths`, V2 走 `ctx.skill.transform` 注册               |
| Pi                               | B      | `context` 事件加会话启动、压缩、结束旗标                                                                    | `resources_discover` 返回技能目录                                           |
| Hermes Agent                     | B      | Python 的 `pre_llm_call` 钩子, 仅第一轮返回注入内容                                                         | `register_skill` 逐技能注册进原生加载器                                     |
| Muse                             | A      | 能力声明里的 hook 以 `["sh", "hooks/session-start"]` 数组直接调用同一脚本 (timeoutMs 5000)                  | 能力声明显式枚举全部 15 个技能                                              |

README 为其中 16 个宿主逐一给出安装命令; `.version-bump.json` 记录分布在各宿主 manifest 里的全部 12 个版本号位点, 发版时一处改动全量同步。

### 4.4 Shape B 参考实现

OpenCode (JS, `.opencode/plugins/superpowers.js`)。同一个模块以两种导出形态支持 OpenCode 的两代插件 API: 命名导出 `SuperpowersPlugin` 服务 V1 (config 钩子里把 `skills/` 写进 `config.skills.paths`, 再由 `experimental.chat.messages.transform` 变换消息数组); 默认导出 `{id, server, setup}` 服务 V2 (`setup` 里调用一次 `ctx.skill.transform`、在其回调内逐技能 `draft.add` 注册, 并用 `ctx.session.hook('context')` 注入上下文)。配套的 `index.js` 只有再导出一行, 供 V2 的目录形态插件注册使用。工程要点:

- 两套工具映射常量 `V1_MAPPING` 与 `V2_MAPPING` 按 API 代际取用 (V2 没有 todo 工具, 改用 markdown 计划文件, 子代理调用形态也不同); bootstrap 内容按映射做模块级缓存, 因为上下文钩子在每个 agent step 都会触发, 不能每步读盘解析。
- 子会话检测。bootstrap 驱动的是 controller 工作流, 注入到子代理会话会让 worker 重启设计循环; 因为技能里的 `<SUBAGENT-STOP>` 只靠模型自觉, 插件改用结构化信号——会话记录带 parentID 即为子会话, 跳过注入 (技能注册保留)。判定结果缓存在有界 map 里 (上限 512 条, 满了丢最旧的四分之一); 查询失败时 fail-open 按顶层会话处理且不缓存。
- 逐技能 try/catch。技能注册接口的 schema 不符会同步抛出并逃逸回调, 宿主会把整个插件异步硬禁用, 连 bootstrap 一起拆掉, 因此每个技能的注册必须隔离失败。
- 注入用户消息而非系统消息, 以避免每轮重复的 token 膨胀和多系统消息破坏某些模型的行为。

Pi (TS, `.pi/extensions/superpowers.ts`)。扩展用五个生命周期处理器编排: `resources_discover` 返回技能目录; `session_start` 与 `session_compact` 置注入旗标; `agent_end` 清旗标避免每轮重复; `context` 事件在旗标为真且现有消息不含 BOOTSTRAP_MARKER 时插入一条 user 消息, 插入位置由 `firstNonCompactionSummaryIndex` 计算、跳过开头连续的压缩摘要。`piToolMapping()` 处理 Pi 的能力缺口: Pi 有原生技能但没有 Skill 工具, 因此映射为 "技能适用时用 read 读取 SKILL.md, 或由人类显式调用"; 无标准子代理工具时在会话内做或说明缺失, 明确禁止虚构工具调用, todo 缺失时回退 TODO.md 文件。

Hermes (Python, `.hermes-plugin/__init__.py`)。插件在注册时逐技能调用 `ctx.register_skill(name, Path(skill_md), description=...)` 注册进原生加载器——路径参数必须是 `pathlib.Path`, 传字符串会被宿主静默禁用整个插件; 注入用 `pre_llm_call` 钩子且仅第一轮返回 `{"context": bootstrap}` (该宿主的会话启动钩子返回值被忽略、消息注入接口在钩子中被拒绝, 两个结论都来自实测)。技能目录解析支持两种安装布局, 都找不到就抛 RuntimeError——注释强调 "bootstrap 静默跳过会让坏安装伪装成好安装"。

### 4.5 声明式与上下文文件宿主

- Kimi: manifest 里三件事——指向现有技能目录、`sessionStart.skill` 声明式会话启动技能、内联一整段 `skillInstructions` 工具映射说明。无技能拷贝、无符号链接、无 hook。
- Muse: 能力声明显式枚举全部 15 个技能 (id 加 path), hooks 用 `["sh", "hooks/session-start"]` 数组形式直接调用同一个 session-start 脚本; 脚本按 `MUSE_PLUGIN_ROOT` 输出嵌套形状。
- Codex: manifest 指向技能目录, 并用字面量空对象 `"hooks": {}` 显式关闭 hooks——缺失字段或空数组都会触发宿主的自动发现回退, 把 Claude 的 SessionStart hook 连带注册回来, 造成双重注入。
- Devin: manifest 是纯元数据, 没有任何能力字段; 宿主读 manifest 后自动发现同级技能目录, 并在会话开始时把技能元数据放进系统提示词。
- Gemini: `gemini-extension.json` 声明 `"contextFileName": "GEMINI.md"`, 该文件内容是两条 `@` 引用, 宿主原样加载。

### 4.6 工具映射 references

`skills/using-superpowers/references/` 下的七个文件把技能动作词表翻译到各宿主工具面, 覆盖读文件、写文件、精确替换、shell、搜索、抓取、技能调用、子代理派发、todo 等动作。Claude Code 是参考宿主, 其词汇表即工具面, 因此 `claude-code-tools.md` 不含映射, 只补充 SDD 的廉价编排说明: 宿主默认支持嵌套子代理 (深度 3, 可用 `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` 调整), 整个计划可以用一个中档模型的编排子代理端到端跑完, controller 的 "Rulings I made" 清单须逐字转达。其余文件各自记录宿主特有映射与限制, 例如 Codex 的子代理派发需要 `[features] multi_agent = true` 且派发时要同时设定模型与 reasoning effort, Antigravity 的任务工件用 `write_to_file` 的 artifact 参数而非任务工具, Gemini 有原生 `activate_skill` 动作, Hermes 用 `delegate_task` 且角色取 leaf。

### 4.7 分发与 Windows

分发渠道按宿主而定: 原生市场、git URL 安装、包清单字段 (`package.json` 声明 `type: module`、main 指向 OpenCode 插件并带 `pi.extensions`/`pi.skills` 字段)、本地安装器。两条安装器怪癖值得记录: 安装器会静默丢弃未声明文件 (bootstrap 必须声明为可识别组件), 打包器会剥掉可执行位 (因此技能行文多用解释器调用脚本)。

Windows 适配分三层: hook 层用 `"shell": "bash"` 强制 Git Bash 路线并配 polyglot 分发器与无扩展名脚本; 可视化伴侣服务器在 Windows-like shell 或 `CODEX_CI` 环境下强制前台模式, 因为这些环境会回收 nohup 后台进程, 且浏览器启动经 `execFile` 参数传递而非 shell 字符串以避免命令注入; in-process 形态天然绕开 shell 脚本问题。

## 五、零依赖 visual companion 服务器

### 5.1 定位与使用判据

brainstorming 附带一个可选的可视化伴侣 (`skills/brainstorming/scripts/`): agent 把设计问题写成 HTML 屏推到本地服务器, 用户在浏览器里点选, 选择经 WebSocket 回流成 JSONL 事件文件供 agent 下一轮读取。它不是一种 "模式" 而是一件工具, 按问题逐题决策, 判据是 "用户看到比读到更容易理解吗"。浏览器用于 UI mockup、架构图、并排视觉对比、空间关系; 终端用于需求范围、概念性选择、权衡列表、技术决策。屏可以是完整 HTML 文档, 也可以是注入外框模板的片段。

它采用 just-in-time 提供策略: 第一次出现 "展示比描述更清楚" 的问题时才提供, 且提供必须是独立消息; 用户拒绝后继续纯文本且不再主动提供。启动、推屏、读事件、迭代的六步循环里, 终端反馈仍是主反馈, 事件文件是结构化交互数据。`--project-dir` 支持把屏持久化到项目内, 此时技能提醒把 `.superpowers/` 加进 gitignore。

### 5.2 server.cjs 的实现思路

`server.cjs` (700 余行) 只用 Node 内建模块, 协议、认证、文件沙箱全部手写:

- WebSocket 协议自实现 RFC 6455 的握手与帧编解码, 强制客户端帧掩码校验, 单帧负载上限 `MAX_FRAME_PAYLOAD_BYTES` 为 10MB; `computeAcceptKey`、`encodeFrame`、`decodeFrame`、`browserLauncherForPlatform`、`OPCODES` 等全部具名导出, 供协议单元测试直接导入断言。
- 端口策略: `BRAINSTORM_PORT` 环境变量优先, 其次读端口文件复用会话上次绑定的端口 (让已打开的浏览器标签自动重连), 否则随机取 49152 以上端口; 端口被占用 (EADDRINUSE) 时一次性回退随机端口, 但若 token 来自显式环境变量则拒绝回退、以退出码 1 终止, 防止抢走持有首选端口的另一会话; 只有拿到首选端口时才把端口与 token 写回文件。
- token 来源三级: 环境变量、token 文件、生成 32 字节随机 hex。认证是安全核心: token 随 URL 查询参数 `?key=` 下发, 首次加载镜像进按实际端口命名的 cookie (`brainstorm-key-<port>`); 每个请求用 `crypto.timingSafeEqual` 常数时间比较校验, 失败直接拒绝; WebSocket 升级需同时通过 token 认证与 Origin 检查。设计注释解释了为什么用 key 而不是 Host/Origin 白名单: key 统一覆盖环回、隧道、远程三种绑定, 并能击败 DNS rebinding。
- 文件沙箱 `/files/`: 只接受 basename, 拒绝空名、dotfile、非普通文件; 检查非符号链接、硬链接计数 `nlink === 1`、realpath 位于内容目录之内; MIME 白名单; 所有响应带安全头 (no-referrer、no-store、`X-Frame-Options: DENY`、CSP `frame-ancestors 'none'`、CORP same-origin)。
- 文件监听用 `fs.watch` 加 100ms 去抖, 新屏写入即向所有客户端广播 `{"type":"reload"}`; 浏览器启动按平台选 `open`/`rundll32`/`xdg-open`, 一律 `execFile` 传参不经 shell。

### 5.3 生命周期与 PID 所有权

服务器在空闲超时 (默认 4 小时, `--idle-timeout-minutes` 可调) 或所有者进程死亡时退出。60 秒周期的 watchdog 检查所有者 PID 是否存活, `kill -0` 报 EPERM 视为存活 (进程在、只是不属于当前用户); 启动时若所有者进程已死 (某些跨用户或远程场景 PID 解析错误), 则禁用监控、只靠空闲超时。

`start-server.sh` 接收 `--project-dir`、`--host`、`--url-host`、`--idle-timeout-minutes`、`--open`、`--foreground`、`--background` 等旗标, 以 `umask 077` 建临时会话目录, 从 `/dev/urandom` 生成 SERVER_ID 并以 `--brainstorm-server-id=` 传给 node 进程, OWNER_PID 默认取祖父进程 (Windows-like 下清空、交给空闲超时)。`stop-server.sh` 的核心是 "确认 PID 属于本会话才发信号": 读状态文件里的 PID 后, 在 `/proc/PID/cmdline` 或 `ps` 输出里精确匹配 server-id 参数串, 任何歧义都按失败处理并视为陈旧 PID (fail-closed), 防止服务器重启后 PID 回卷误杀无关进程; 停止时先 SIGTERM 再 SIGKILL, 且只删除 `/tmp` 下的会话目录, 项目内持久目录保留供回看 mockup。

### 5.4 浏览器端

`helper.js` 注入浏览器, 并把纯函数 `nextReconnectDelay` 与三个常量 (基础延迟 500ms、上限 30000ms、断连 15000ms 后视为暂停) 在 Node 环境下导出供测试。运行时行为: 从 sessionStorage 读 key 构造带 key 的 WebSocket 地址; 断线指数退避重连; 断连超过 15 秒显示 "Companion paused" 覆盖层; 恢复后若曾暂停, 用带 key 的地址整页重载以刷新 cookie; 捕获所有 `[data-choice]` 元素的点击并发送结构化选择事件 (支持多选); 暴露显式 API `window.brainstorm = {send, choice}` 供屏内脚本调用。外框模板 `frame-template.html` 提供跟随系统的明暗主题、连接状态 pill 与一组可直接使用的组件样式 (选项、卡片、并排对比、优缺点列表、线框元件)。

品牌区默认从远程加载一张带 `?v=<version>` 查询参数的 logo 图片, 仅用于粗略估计用户量与版本分布; 设置 `SUPERPOWERS_DISABLE_TELEMETRY`、`DISABLE_TELEMETRY` 或 `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` 中任一环境变量即切换为纯文字品牌且零远程请求。

## 六、证据化诊断流程

### 6.1 定位与职责边界

`diagnosing-superpowers` 是元技能, 用于会话表现异常时 (技能该触发没触发、无视计划、重复工作、token 消耗离谱) 产出带证据的报告。它完全由提示词模板 (`prompts/` 下十余个) 驱动, 没有脚本。

核心原则是 "每个发现都引用 path:line, 没有引用就没有发现; 每个数字都来自 transcript 或你运行过的命令, 绝不来自记忆"。职责边界刻意收窄: 它只报告 (You report), 不诊断 Superpowers 本身, 也不提议修改——报告出来后由分诊者决定 Superpowers 是否要改, 用户施压也不例外。分析工作区建在 `~/.superpowers/diagnosing-superpowers/<session-id>/`。

### 6.2 七步工作流

1. 问题受理: 一次一问, 直到能写出问题陈述 (点名会话、轮次范围、期望、实际、关心的可观察量); 记录目标是否是 bug 报告。伙伴不在场就把问题写下来并停住, 因为 "替对方重建出来的陈述不是答案"。
2. 定位: 把会话解析为经验证的绝对路径, 身份确认要求会话 ID、工作目录、时间戳、内容匹配共同成立; 列出全部被拒候选及原因; 枚举子代理记录; 建工作区并登记发现的记录语义。
3. 分诊: 先亲自读被报告问题附近的区域, 再按七个维度并行派发分析子代理。
4. 报告: 按模板逐节填写并展示路径。
5. 提交 issue: 仅在报告判定相关或用户要求时, 先搜既有 issue, 填好模板并展示确切文本, 批准后才创建。
6. 导出: 仅在用户索要时, 询问脱敏级别 (skeleton/evidence/full 三级), 用脱敏代理加独立审计代理的循环直到审计返回 CLEAN, 展示脱敏日志与文件清单后再归档。
7. 相似会诊: 被要求时把确认的发现转成签名, 在历史会话中并行检索并追加报告。

### 6.3 七个分析维度

| 维度              | 找什么                                                                                                      |
| ----------------- | ----------------------------------------------------------------------------------------------------------- |
| skill-timeline    | 逐人类轮的技能使用记录, 把请求文本与已装技能的触发条件比对, 报告调用了的、匹配但未调用的、迟到的            |
| plan-adherence    | 恢复会话商定的计划, 标记计划与执行之间的结构事件, 逐步映射跳过、乱序、静默修改、臆造与结构事件后的漂移      |
| repeated-work     | 把工具调用抽成键值分组计数, 区分编辑后重读 (不算)、压缩后重读 (算) 与无事重读                               |
| stumbles          | 所有停止前进的点: 错误与非零退出、同轮重试、被回滚的编辑、人类纠正、权限拒绝、hook 失败、限流、任务中途压缩 |
| quality-evidence  | 用会话自己的声明审判过程: 每次测试运行及结果, done/fixed/passing 声明在同轮内向前找支撑                     |
| request-conflicts | 抽取每条人类提示的指令, 报告互斥的人类指令、人类指令与指令文件的冲突、要求跳过步骤的指令及后果              |
| cost-and-time     | 只按给定语义解读用量记录, 报最长轮次与事件间隙、最大工具结果、压缩计数与定位, 不推测原因                    |

每个分析子代理只读、不改文件、不评 Superpowers, 返回固定结构: 发现、证据 (绝对 path:line 加不超过 200 字符的引文)、轮次、置信度, 外加一行 "Checked" 说明查过什么; 没发现也要返回明确的 `- none found`, 沉默不是结果。

### 6.4 脱敏与导出

脱敏策略定义了八类占位符 (邮箱、人名、组织、密钥、主机、home 路径、仓库名、专有名词), 保留会话 ID、工具名、技能名、相对安装根路径、模型 ID、宿主版本与行号, 因为 "没有它们这份 bundle 就没用"。两条原则值得单独指出: 私有仓库名不代表其每条命令或结果都涉密; 如果脱敏移除了某个发现的支撑, 就记录受影响的发现与限制, 绝不为通过证据检查而保留敏感值。

上下文安全应对 "一条记录可达兆字节" 的情况: 读任何文件先用 `wc` 测量, 绝不 `cat` 或 grep 出正文, 先取行号与计数再取小字段, 单条输出超过 500 字符就收紧。脱敏代理重写 bundle 内每个文件并记录占位符计数 (任何地方都不写明文映射表), 独立审计代理全文查找漏网内容, 只有无遗漏且无未决分类才返回 CLEAN——审计通过只证明隐私, 不证明结论正确。

## 七、测试与质量体系

### 7.1 两层分工

仓库把测试分成两层 (`docs/testing.md`): `tests/` 测插件的非 LLM 代码是否正确 (bash 加 node 加 python 的集成测试, 确定性、可进 CI); agent 在真实 LLM 会话中的行为则走独立的 eval harness——`superpowers-evals` 仓库及其 CLI Quorum, 本仓库显式 gitignore `evals/` 目录并按需克隆。Quorum 在 tmux 里驱动真实的编码 Agent CLI, 由 LLM QA agent (Gauntlet) 扮演用户并按场景验收标准与确定性后置检查评判技能遵从; 单个场景耗时约 3 到 30 分钟以上且跑在宽松权限下, 因此只有静态检查适合公共 CI, 真实会话扫描放在夜间或按需运行。

### 7.2 基础设施测试覆盖

`tests/` 下的目录按被测对象划分, 常见的模式是 bash 自带的通过/失败计数器加 trap 清理临时 fixture, 用 python 逐字段断言 JSON manifest, 用 node:test 或手写 runner。覆盖面包括:

- 可视化伴侣服务器: WebSocket 协议单元测试、浏览器端重连逻辑、token 认证、品牌与遥测开关、Windows 生命周期、浏览器启动器选择、启停脚本的 PID 所有权。
- 各宿主注入器: session-start 在三种环境变量组合下的输出互斥、Claude hook 注册必须声明 `"shell": "bash"`、polyglot 分发器正确派发; OpenCode 的 bootstrap 缓存与子会话判定; Pi 扩展的处理器契约; Hermes 的注入路径与 bootstrap 大小上限 (`HERMES_CONTEXT_SPILL_LIMIT`)。
- manifest 断言: 用 python 逐字段检查各宿主的插件清单, 包括确认 Codex 的 `hooks` 恰为空对象、Devin 清单不含能力字段、Kimi 的声明式启动与内联工具映射、Codex 打包产物完整、Antigravity 品牌资源就位。
- 技能静态检查: 技能体积预算、frontmatter 合法性、被引用文件存在性、流程图渲染、诊断技能提示词不泄漏本地路径与个人信息; 行为验证全部在仓库外的场景 eval 里。
- 版本与发布工程: `.version-bump.json` 的 12 个位点同步脚本在 fixture 仓上的行为、shell lint 的收集与过滤、find-polluter 等辅助脚本自身的测试。

### 7.3 行为测试与真实 CLI

需要真实模型判断的部分走真实 CLI 加输出字符串断言, 并保留少量 bash 测试补 eval 未覆盖的场景。典型如 SDD 集成测试: 文件头注明保留理由是 Quorum 场景暂不覆盖 "至少 3 次提交、至少 2 次子代理派发、任务跟踪、token 用量统计" 这些可数指标, 于是用真实会话加断言补位。断言库 (`test-helpers.sh`) 对大小写不敏感, 因为模型会随意大写技能术语。一个反复出现的经验与措辞微测协议同源: 同一个 prompt 变体要多次重复, 单样本会说谎; 对照组不可或缺。

## 八、适用场景与边界

### 8.1 适用场景

- 需要长时自主执行的中大型功能开发。主干流程从 brainstorming 到 subagent-driven-development 把 "人类只做决策、Agent 连续执行" 变成有门禁、有账本的过程。
- 多人或多 Agent 协作的工程。ledger、Rulings 清单、completion contract 解决的是 "工作随上下文一起丢失" 和 "裁决死在参与者记忆里" 这两类协作失效。
- 对交付质量而非速度敏感的场景。强制 TDD、每任务评审、终审、证据门都会增加成本; writing-plans 的交接菜单里明确写了 Subagent-driven 是最彻底但也最贵的选项 (每任务一个新上下文加一个新评审者), Native 最便宜最快但要到最后才有独立评审。
- 需要把方法论分发给多种宿主。三形态适配架构与单一技能来源让同一套内容可以在十几个宿主上逐字运行。

### 8.2 边界与前提

- 它不是运行时。没有 CLI、没有守护进程, 全部效果取决于注入是否发生、模型是否遵从技能文本以及宿主能力是否够用; 子代理、todo、web 等能力缺失时相应技能降级。个别宿主还有已知的注入盲区, 例如 Hermes 没有压缩后钩子, compaction 之后到会话结束之间不会重注入。
- 强制是软的。审批门、Iron Law、证据门都由提示文本驱动, 没有代码级拦截; 遵从率通过措辞实验与压力测试提升, 但不能保证。
- 成本与纪律正相关。每任务新子代理加评审、终审用最强模型、显式声明模型分档都是成本工程, 但在小改动上这套流程明显过重, brainstorming 的尺寸分档 (快而清的任务直接做、小改动写短设计文档、项目写完整设计文档) 与一次性 spike 正是为此设的降级通道。
- 宿主差异是持续的维护负担。hook schema、JSON 字段、工具名、Windows shell 行为各不相同, 且宿主会变; 因此描述机制的不变量比描述具体实现更耐久。
- 诊断能力只报告不裁决。它能产出带证据的会话分析, 但明确不判断方法论本身是否有缺陷, 也不提议修改。
- 遥测默认开启但极小。唯一的外部请求是品牌 logo 的版本号查询, 三个环境变量任一即可关闭。

### 8.3 可借鉴的设计

1. bootstrap 注入模式: 方法论必须在会话开始事件 (含 clear 与 compaction 后) 强制注入, 而不是写在文档里指望模型去读。三形状互斥输出、每步触发的去重守卫、压缩后重注入、用结构化信号 (parentID) 识别子会话而非依赖模型自觉, 这套注入器工程可以直接借用。
2. description 只写何时使用: 概括流程的描述会成为模型跳过正文的捷径。这条对任何给 Agent 编写工具或技能描述的场景都成立。
3. 证据纪律: "无 path:line 引用即无发现"、"新鲜验证"、"回归测试自身要过红绿循环"、"数字要么从记录里算出来要么是编的", 把 Agent 的输出验收从主观判断变成可检查的形式要求。
4. 反合理化设计: Red Flags 表、Common Rationalizations 表、"违反字面即违反精神" 的表述、审批门只推进一阶段的语义, 全部来自对真实失败会话的归纳, 并有压力测试方法论支撑。
5. 措辞微测协议: 对照组、每变体 5 次以上重复、人工读命中、方差作指标, 是一套可直接复用的提示工程实验方法; "文体匹配失败类型" (纪律失效用禁令表、形状问题用正面配方) 是它的产出物。
6. fail-closed 工程: PID 所有权校验、评审包的范围守卫 (空 diff 视为错误而非 "评审干净")、插件逐技能隔离失败、脱敏双代理审计、EADDRINUSE 时持显式 token 拒绝回退, 统一原则是 "任何歧义按失败处理"。
7. 成本工程: 显式声明模型、注意回合数常比 token 单价更贵、工件以文件传递防提示膨胀、按每计划建 workspace 防恢复取证开销、廉价编排 (一个中档模型编排子代理端到端跑完整个计划)——这套子代理编排的成本手册与计划执行器实现同等重要。
