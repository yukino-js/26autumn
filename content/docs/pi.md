---
title: "Pi Agent Harness: 极简内核、树形会话与 durable 运行时"
description: "拆解 Pi 的设计与实现: 极简内核与扩展机制的边界、entry 树会话模型、TypeScript SDK 的进程内嵌入、durable 运行时的持久化不变量与执行环境抽象、chord 应用组合运行时、codemode 的沙箱化脚本执行、统一 provider 面与容器化、五种接口形态与 TUI 渲染工程"
local_path: "$HOME/Downloads/pi"
---

Pi 是终端里的极简、可扩展编码 Agent harness。它的设计立场非常明确: 内核只保留最小能力, 其余一切通过扩展、技能、提示模板、主题与自定义 provider 加入, 打包为 Pi package 分发。与 CLI 并行的还有三条实验性库线: durable 做"先提交存储再展示"的持久化运行时, chord 为 durable 提供复制状态与热重载的应用组合基座, pi-env 把工具执行经 SSH 部署的 Rust 守护程序落到远程机器。本文按机制而非目录来组织, 讲清这套极简内核如何支撑树形会话、如何被 TypeScript 进程直接嵌入、durable 的持久化不变量与执行环境抽象、chord 的对象/引用/重载模型、codemode 如何把模型写的脚本关进沙箱, 以及 provider 与沙箱体系为何全部外置。读者应熟悉至少一个编码 Agent 的交互形态 (如 [Codex CLI](codex) 或 [Claude Code](claude-code)), 并对 Node、TypeScript 与终端程序有基本认识。

本文描述的是当前代码库的机制, 不涉及版本演进与发布记录; 其中标注为实验性的部分是维护者自己声明会随时变动的接口。

## 一、极简内核哲学与扩展机制

### 1.1 内核边界

贡献指南的第一句是 "pi 的内核是最小的"。不属于内核的功能应当做成扩展, 试图膨胀内核的 PR 会被拒绝; 就连扩展的 hook 点也要经过慎重讨论, 以免引入不可维护的复杂交互。配套的一条规则是 "你必须理解你的代码": 用 AI 写代码可以, 但不理解就提交不行。

这条哲学的直接后果是: sub-agent、plan mode 这类能力刻意不放进内核。内核提供强力默认, 同时给用户两条路——指挥 Pi 自己生成所需能力, 或安装现成的 Pi package。扩展不只是插件系统, 它是内核主动让位的结果。

内核的自我描述是最小集 (read、bash、edit、write 加会话管理), 但实际工具面更宽: 还包括 find、grep、ls 与 powershell。文件变更经专门的队列串行化, 避免并发工具调用互相踩踏。

### 1.2 资源阶梯七层

快速上手文档维护一张"从最弱机制开始"的选择表, 复杂度递增:

| 需求                         | 使用                    |
| ---------------------------- | ----------------------- |
| 文件夹级持久指令             | `AGENTS.md`             |
| 复用菜单里的提示             | prompt template         |
| 任务专属指令加附件           | skill                   |
| 可执行的工具、命令、事件处理 | extension               |
| 自定义终端组件               | Terminal UI             |
| 接入未支持的模型服务         | custom provider         |
| 打包分发多种资源             | Pi package (npm 或 git) |

这张表的价值在于它把"该用哪一层"变成工程决策而非偏好: 能用更弱的机制解决就不上扩展。

### 1.3 扩展机制

扩展是加载进 Pi 进程的 TypeScript 模块。工厂函数可以注册工具、命令、快捷键、provider、事件处理器、渲染器与终端 UI。仓库自带大量示例扩展, 大致分三类: 工程流程 (自动提交、git 检查点、受保护路径、权限门、计划模式、子代理、待办、结构化输出、自定义压缩等)、provider 与基础设施 (自定义 provider、调试 provider、沙箱、SSH、依赖打包、事件总线)、界面与娱乐 (用游戏验证 TUI 扩展能力的边界)。示例数量本身是设计声明: 扩展面被认为足以表达几乎任何工作流。

内核内置四个扩展: codemode、tool-search、mcp、llama (本地 llama.cpp 模型)。它们与用户扩展走同一注册面; 其中 codemode、tool-search、mcp 标记为可替换, 另一个扩展注册了同名工具、命令或旗标时内置版自动让位, llama.cpp 则不可替换。内核没有为特性保留特殊通道。

### 1.4 内核纪律的外化

极简哲学还体现在代码与供应链约束上:

- 只用可擦除的 TypeScript 语法, 以配合 Node 的 strip-only 模式——禁用 enum、namespace、parameter properties 等需要 JS emit 的构造; 禁止内联动态 import, 只允许顶层 import。
- 键位不许硬编码, 必须进默认键位表以保持可配置; 生成的模型数据文件不许手改, 必须改生成脚本后重新生成。
- 多会话并发开发有明确纪律: 同一工作目录可能同时跑多个会话, git 只允许 stage 显式路径, 禁止 `git add -A`、`reset --hard`、`checkout .` 之类会波及其他会话的操作。
- 供应链加固成体系: 直接外部依赖钉精确版本、`.npmrc` 设置只保存精确版本且拒绝刚发布不久的包 (`min-release-age`, 缩小投毒窗口)、lockfile 是依赖事实源且默认禁止提交变更、安装器承担传递依赖的钉死、依赖的 lifecycle script 需走显式 allowlist、CI 用忽略脚本的方式安装并定时审计。

这些约束与内核最小化是同一取向: 把可变性与不确定性挤到边缘。

### 1.5 monorepo 包布局

| 目录                  | npm 包                          | 职责                                                                          |
| --------------------- | ------------------------------- | ----------------------------------------------------------------------------- |
| packages/agent        | @earendil-works/pi-agent-core   | 通用 agent 运行时: 消息状态、事件流、工具执行 (并行/串行)、传输抽象与附件支持 |
| packages/ai           | @earendil-works/pi-ai           | 统一多供应商 LLM API、生成式模型目录、faux 测试 provider                      |
| packages/coding-agent | @earendil-works/pi-coding-agent | 终端 CLI 与 TypeScript SDK, 内置四个扩展                                      |
| packages/tui          | @earendil-works/pi-tui          | 差分渲染终端 UI 库                                                            |
| packages/mcp          | @earendil-works/pi-mcp          | 独立 MCP 客户端: stdio/Streamable HTTP/内存传输与 OAuth, 不依赖官方 SDK       |
| packages/codemode     | @earendil-works/pi-codemode     | QuickJS/WASI 沙箱, 唯一运行依赖是 quickjs-wasi, 无任何 pi 依赖                |
| packages/durable      | @earendil-works/pi-durable      | 持久化会话、任务与文档运行时 (实验性)                                         |
| packages/chord        | @earendil-works/chord           | 类型化宿主运行时: 契约、复制状态、热重载、JSON 链路上的 RPC, 仅依赖 typebox   |
| packages/env          | @earendil-works/pi-env          | 远程执行环境: SSH 部署的 Rust 守护程序及其 ExecutionEnv 客户端                |
| packages/telemetry    | @earendil-works/pi-telemetry    | 厂商中立的遥测契约、参考实现与类型化 schema                                   |
| packages/evals        | @earendil-works/pi-evals        | 私有评测套件, 不发布                                                          |

依赖方向很说明问题: coding-agent 依赖 agent-core、ai、codemode、mcp、tui, 但**不依赖** durable、chord 与 env; durable 依赖 chord、ai 与 codemode; env 依赖 durable (取 ExecutionEnv 接口) 与 chord; chord 只依赖 typebox。CLI 线与 durable 线共享 ai 和 codemode, 其余互不依赖——durable 是独立的库级产品面, 不是 CLI 的子系统。coding-agent 的 `AgentSession` 构建在 pi-agent-core 之上: 通用循环、消息/工具事件序列、`transformContext` 变换与工具并行/串行执行都来自 agent 包, coding-agent 在其上叠加会话树、资源加载与工具实现。

## 二、树形会话模型

### 2.1 entry 树与 active branch

会话不是线性的消息数组, 而是一棵树。消息与事件构成 entry, 每个 entry 有 ID 并指向父 entry; 每条路径是一个分支, 以当前 entry 结尾的分支是 active branch, 为下一次模型请求提供历史。

关键的语义差别在于"从更早处继续": 它不会删除后续 entry, 只是把 leaf 指针移回更早的 entry, 之后追加的内容在同一文件里长出新分支; 只有 fork 与 clone 才把选中的历史拷进新的会话文件。实现上对应 `SessionManager.branch()` 与 `createBranchedSession()` (packages/coding-agent/src/core/session-manager.ts), entry 类型是一组判别联合 (消息、思考级别变更、模型变更、用量、压缩、分支摘要、自定义、自定义消息、上下文编辑、标签、会话信息), 共享 id/parentId 的树结构。

持久化会话是 JSONL 文件, 天然追加友好: 分支不要求改写历史, 只追加指向旧 entry 的新 entry。

### 2.2 agent loop 与三种输入语义

一次提交的消息加入 active branch; Pi 用 system prompt、active branch、可用工具与模型设置组装请求, 经选定 provider 流式返回; 记录响应 (文本与工具调用), 逐个执行工具并记录结果, 这算一个 turn; 若工具结果或排队消息还需要模型请求就再来一轮, 否则 run 结束。

三种输入语义被区分得很清楚:

```text
steering   在当前 assistant turn 之后插入
follow-up  在 agent 做完 pending 工作后进入
abort      停止当前 run 并把排队消息退回编辑器
```

这种区分让"用户在 agent 工作中途插话"与"用户要求 agent 完成后接着做"不再混为一谈。

### 2.3 上下文组装

system prompt 由基础指令与发现的 context files 构成; 请求携带工具定义与技能描述; 技能的完整指令按需加载, 而不是全部预载。扩展可以追加指令或变换上下文——`context` 事件把会话消息数组交给处理器 (不含 prompt 与工具系统消息), 处理器可返回新数组或就地修改; `context_with_system` 才交出含系统消息的完整 transcript。prompt 模板在编辑器输入变成 user 消息之前展开; 选中文件、图片、粘贴文本、shell 输出都可以成为消息内容。

### 2.4 compaction 是视图不是存储

压缩会插入一条摘要 entry, 在后续模型请求中替换更老的消息, 但原始 entry 全部保留在会话树里。这是整套模型里最值得强调的取舍: 压缩是有损视图, 不是有损存储。用户仍然可以回到被压缩的分支继续工作, 历史可回溯性没有因为压缩而丢失。

### 2.5 持久化格式与会话管理

默认会话按工作目录分组存放于用户级 agent 目录; 命令行参数、环境变量与 SDK 设置都可改位置。相关开关包括: 跑临时会话 (退出即不可恢复)、直接指定路径或 ID、启动前从既有会话分叉、打开当前目录最近的会话。导出支持 HTML 与 JSONL; 分享可上传为带查看链接的产物或私有 gist, 目标可用设置固定。另有生成私有 bug 报告的路径, 报告包含环境与 provider 配置但不含凭据值。

文档反复提醒: 导出与分享之前必须自查, 内容可能包含提示、模型回复、工具参数、命令输出与文件内容。

## 三、TypeScript SDK 的嵌入方式

### 3.1 createAgentSession

包可以直接作为库嵌入 Node 或 Bun 进程, 拿到与 CLI 同款的 agent、session、工具、模型与资源。最小用法是创建一个会话、跑一个 prompt、读最后一条 assistant 文本、释放会话。CLI 自己用的就是同一套创建逻辑, 因此 SDK 不是附属品, 而是内核的另一种入口。

### 3.2 SessionManager 是上下文的权威

`SessionManager` 持有持久化或内存的 entry 树并跟踪 active leaf。它是"最终模型上下文"的唯一权威: 直接给会话的 agent 状态赋消息数组不能替换持久化上下文; 要恢复外部历史, 必须构造带这些 entry 的 manager。`inMemory()` 用于不落盘场景。这条约束在文档里被反复强调, 因为它划清了视图与真相源的边界。

### 3.3 AgentSessionRuntime

`AgentSessionRuntime` 提供新会话、切换会话、分叉、从 JSONL 导入四类操作 (packages/coding-agent/src/core/agent-session-runtime.ts)。每次操作都会替换活跃的 AgentSession 并为目标工作目录重建服务, 因此替换后旧的事件订阅失效, 需要重新绑定。分叉还区分"在选中 entry 之前"与"包含选中 entry"两种位置。实现上它持有一个运行时工厂, 每次重建时以目标工作目录、会话管理器与必要的信任上下文重新构造整套服务, 这让"换工作目录继续"成为一等操作。

### 3.4 prompt 语义与事件

`prompt()` 先处理扩展命令、展开基于文件的 prompt 模板, 再让普通用户消息进入 agent; 对已被接受的 run, 返回的 promise 在该 run (含自动重试) 结束后 resolve。会话正在流式输出时再发 prompt 必须显式选择 steer 还是 follow-up, 不选直接 reject 而不是猜。abort 停止并等待空闲, 另有一个"只等不停"的等待接口。

事件订阅区分层次: message_update 提供增量文本 (含 assistant 消息事件), message_end 是权威的完整消息, agent_end 表示一次底层 run 结束 (后面可能还有自动恢复或排队工作), agent_settled 表示 Pi 确定不再自动继续。把"run 结束"与"彻底空闲"分开, 是编排者能正确判断下一步的前提。

### 3.5 依赖注入面与内置扩展

创建会话的每个默认件都可显式替换: 模型运行时、模型与思考级别、设置管理器、会话管理器、资源加载器、工具集 (含排除与自定义工具)。默认资源加载器支持标准发现加定点覆盖 (扩展、技能、模板、主题、AGENTS 文件、系统提示各有覆盖钩子); 完全自管资源可以传自定义加载器。

CLI 会把注册面里的内置扩展默认加载 (codemode、tool_search、MCP 与提供本地模型的 llama.cpp), SDK 会话一个都不加载; 要让 SDK 会话拿到前三者的能力, 需把对应扩展工厂 (createCodemodeExtension、createToolSearchExtension、createMcpExtension) 加进 DefaultResourceLoader 的 extensionFactories。其中 codemode 与 tool_search 注册为非活跃, 通过默认工具设置或 MCP server 的暴露策略激活; MCP 扩展在会话启动时连接 server, 因此需要显式绑定扩展。这个连接不阻塞首个 prompt: 只等待带直连工具的 server (限时 10 秒), 其余后台连接, 脚本与延迟发现的工具在真正用到时按需等待。codemode 调用不依赖当时的活跃工具集, 因此在树导航、恢复与分叉后仍然可用; tool_search 加载的工具会记录进 transcript, 在该分支上保持声明。

扩展还可以声明"可替换": 当别的扩展注册同名工具或命令时自动让位而非冲突——这是同一注册面上避免冲突的机制。仓库的 SDK 示例全部随仓库类型检查, 既可当文档也可当回归测试。

## 四、durable 运行时的持久化设计

### 4.1 核心不变量

durable 是一个实验性的持久化 agent harness, 构建在 pi-ai (模型访问) 与 chord (文档状态) 之上。它自述的原则是: 会话、模型轮次、工具调用与自定义状态先提交到存储, 然后才展示; 进程在轮次中途死掉后, 重开存储即可从中断点续跑。规范文档给出的核心规则是"一个 Session 原子地提交不可变 entry、完整 task 记录与 chord 跟踪的文档, 只有已提交状态可观察"。

最小用法展示了它的工作形态: `Harness.open()` 在存储上打开 Session, `harness.root()` 返回根 conversation, `root.submit()` 持久受理输入并返回 Submission, 内置的 generation 任务调用模型追加答案, `submission.wait()` 等到回答完成; `harness.resume()` 续跑上个进程未完成的 run。每个异步调用都携带 chord 的 Context 以承载取消。

配套的不变量值得逐条看:

1. 一次 Session 提交对所有记录与文档写入是原子的。
2. 文档更新只在存储提交成功后发布。
3. 所有可见进度都是持久的, 没有易失的发布路径。
4. 外部副作用不在提交事务内运行。
5. entry 与 ID 不可变, 提交后不复用。
6. 草稿在事务回调结束时被同步准备或中止, 写入草稿的值按值拷贝且必须是严格 JSON。
7. 变更线在存储结算与已提交状态采纳期间保持持有; 提交与关闭观察者同步运行只为捕获不可变状态。
8. 存储错误对打开的 Session 是致命的: 它不发布任何内容, 必须重新打开。

这套不变量是"先落盘再展示"能成立的前提, 也是它与"内存中跑完再持久化"最本质的区别。

### 4.2 记录模型

规范用一组明确的概念划分层次:

| 概念         | 含义                                                                     |
| ------------ | ------------------------------------------------------------------------ |
| Session      | 拥有一条变更线、若干会话、entry、task、提交请求 (submission) 与文档      |
| conversation | 一个 transcript 作用域, 可以分叉另一个 conversation                      |
| entry        | 不可变的 transcript 记录, 可携带贡献给模型上下文的消息与供应用消费的数据 |
| task         | 附着在某个 conversation 上的持久状态机                                   |
| document     | 由 chord 操作与偶发完整基底表示的可变 JSON 状态                          |
| turn / run   | 一个 assistant 响应及其工具调用 / 从受理输入到最终答案的轮次序列         |

entry 记录把"面向模型的消息"与"面向应用的数据"分开存放, 并带一个 head 字段指向它选中的上下文首 entry, 还支持上下文级的编辑覆盖。分叉在记录模型里是显式操作: conversation 可以指向父 conversation 与分叉点。

### 4.3 存储后端与并发

| 后端                      | 特性                                                                                           |
| ------------------------- | ---------------------------------------------------------------------------------------------- |
| Memory                    | 不持久化, 是参考语义                                                                           |
| SQLite                    | 单数据库文件, WAL 模式配常规同步级别: 进程崩溃后提交仍在, 最新的提交在断电或宿主失败时可能丢失 |
| JSONL                     | 单目录追加文件, 可配置每次提交标记前 flush; 全部历史留在内存, 长跑 agent 应选 SQLite           |
| Cloudflare Durable Object | 单个 SQLite 型 Durable Object 的存储, 一次提交即其存储事务                                     |

一个存储同一时刻只被一个进程拥有, 没有跨进程锁。SQLite 存储可用前缀给表与索引命名空间化 (如 `{ prefix: "pi_" }`), 便于共享数据库; 多个 Pi 存储共用一个 Cloudflare 存储对象时自动共享操作队列。可移植的 SQLite 与 JSONL 核心不依赖 Node API, 只要给定异步的数据库 facade 或文件系统, 就能跑在 Bun 或 Cloudflare Durable Objects 之类的运行时上。自定义后端可以跑共享的一致性测试套件。SQLite 适配器实现基于 Promise 的 exec/run/get/all/transaction/close, 事务回调接收事务句柄, 句柄在回调结束时过期, 适配器必须把无关操作与其他事务排队到事务结束之后。包根因工具参数校验引入 TypeBox, 未打包约 23 MB 峰值 RSS, tree-shaken 后约 4 MB。

### 4.4 compaction 与 overflow

压缩把模型看到的内容缩小: 总结更老的 entry, 追加一条压缩 entry 持有摘要并指向它保留的第一条 entry, 更老的 entry 留在存储里。手动压缩以任务形态运行, 可附指令, 可被中止取消; 摘要生成期间会话继续工作, 摘要在会话空闲时立即放置, 否则在下一个轮次边界放置。

自动压缩按会话设置: 距保留量还差 backgroundTokens 时在后台启动, 超过上下文窗口减去 reserveTokens 时下一次请求同步等待压缩; provider 以上下文过长拒绝请求时触发溢出压缩并重试一次。阈值还可以按 `provider/modelId` 逐模型覆盖, 让一个 harness 同时伺候 32k 与 1M 窗口的模型。多个摘要并发时由 stale 规则裁决: 切到当前活动上下文开始之前的摘要在放置时落为 stale, 切在该起点或之后的摘要无论何时被选中都正常放置。阻塞阈值上的压缩若失败, generation 也一并失败, 不发请求; 无事可压或被 hook 拒绝则照常放行。运行中的压缩暴露在活动文档里, 含原因、尝试次数与重试退避; 最近一次失败也挂着, 直到产出新摘要; 摘要开销计入用量统计; 压缩任务上有一个 hook 可以拒绝或自供摘要。

### 4.5 扩展注册表与 task graph

durable 把注册面做成命名扩展注册表: 安装与卸载统一接管工具、hook、task 定义、system prompt 段与工具和段落包装器的注册; 扩展用定义函数与包装函数构建; 同名重装原地替换, 已在跑的工作用旧代码跑完, 下一个阶段、请求或调用才用新代码。每个 conversation 的 agent 配置 (模型、思考级别、扩展与工具选择、指令、工作目录) 存为可回退历史的文档, 任务拥有的会话复制 owner 的 agent 配置。

task graph 视图把每个活任务挂成可观察状态或 watch, 包含 owner 边、已提交状态、后台与中止标记、拥有的会话。生命周期一致性也做了约束: 任务运行时的时间与上报接口在其调用 (invocation) 结束后拒绝使用; 文档迁移后的第一次写事务总会写入当前版本的新基底, 即使 JSON 深相等; 打开失败时不借调用方上下文关闭会话, 而是重抛原始错误。

### 4.6 provider 会话身份

durable 还会为每个会话持久化 provider 侧身份: 内置一个 provider 文档, 每个新建、任务拥有、原始创建与分叉的会话都在创建提交里生成自己的 UUIDv7 会话 ID, 分叉从不复制父会话的身份。这个身份被传给模型请求, 供 provider 做提示缓存与会话亲和; 重置、压缩、换模型与重新打开存储都不改变它。没有该文档的存量会话会在 Session 线上于首次模型或压缩请求前惰性创建并持久化, 并发调用方只观察到一个赢家。

### 4.7 执行环境抽象与远程执行

durable 把"工具在哪台机器上跑"抽象成 ExecutionEnv (文件系统与 shell 两个接口的合集)。`HarnessOptions.env` 是一个构建器: 每次工具调用、段落渲染与显式取环境时, 以目标 conversation 的当前 cwd 与已提交读权限现场构建, 可以异步, 永不跑在 Session 变更线上; 没有配置环境时内置工具以错误结果失败, 构建器抛错则成为该调用的错误结果。环境对象本身便宜, 每次调用新建也无妨——edit 与 write 按"环境 id + 规范路径"串行化对同一文件的变更, 因此同 id 环境必须看到同一文件系统; 自定义环境要设好 id, 比如一个容器一个 id。于是"这个会话的工具进容器、那个会话进远程机"成为配置而非改码。

宿主也可以直接用环境: `openBinaryReader()` 按字节范围读已打开文件, `openDirReader()` 分页读目录, `exec()` 带 argv 数组不经 shell 跑程序并标注每个输出块的流。可选的 `listFiles()` 像 `fd --hidden --exclude .git` 那样列出目录下的树 (不跟随符号链接, 跳过 git 忽略项), 受条目数、字节数与超时约束并带 truncated 标记。默认参考实现 `NodeExecutionEnv` (durable/env/node) 不实现 listFiles, 由 pi-env 补上; 自定义环境可以用 `registerEnvConformance()` 自检, 与存储一致性套件同构。

配套的 env 包把远程执行做成一等能力: 一个用 Rust 写的小守护程序经 SSH 部署到远程机, 以 `pi-env serve --token <hex>` 启动, 在 stdin/stdout 上讲一套带帧协议——首行 `PI-ENV <token>` 用于同步 (丢弃 shell 启动文件的杂散输出), 之后每帧是 u32 长度、u8 类型、u32 请求号、u32 JSON 长度、JSON 与原始载荷, 大端序, 单帧上限 16 MiB; 请求/结果/错误/事件/取消/ping 六种帧型。文件操作跑在固定线程池, exec、pty 与 watch 各有线程; 双方每 5 秒互发 ping, 守护程序 30 秒收不到任何字节就杀掉自己启动的全部进程组并退出——断线即停远程命令。

客户端侧的 RemoteExecutionEnv 实现同一个 ExecutionEnv 接口, 结果与"在远程机上直接跑 Node 执行环境"逐项对齐, 只有错误文案可能不同。分工经过刻意切分并有差分测试验证——路径解析、中止检查点、错误码映射、读取尺寸与解码留在客户端, 系统调用、进程、溢出文件与行扫描留在守护程序。SSH 侧做了硬化: BatchMode、对应用自持 known_hosts 的严格主机密钥校验 (指纹先带外核对再接受)、无任何转发、不共享连接、不转发本地 locale。守护程序按 SHA-256 命名 (取前 32 个十六进制字符) 并在每次启动前校验哈希, 随包附带所有支持平台的二进制; 支持 Linux、macOS、Android (Termux) 与 Windows 的 x86-64/arm64, Windows 上字符串命令经 Git Bash 执行。连接可以惰性创建: 首个操作才触发探测、部署与连接, 失败是该操作的错误, 下次操作重试。此外 `nodePlatform()` 把守护程序 hello 里的系统名映射成 Node 的 platform/arch 拼写; `LocalExecutionEnv` 是本机守护程序加 `NodeExecutionEnv`, 主要为了补上 listFiles; `openTerminal()` 在守护程序的伪终端里跑程序, 提供原始输出、输入、改窗口大小与退出码 (Windows 暂不支持)。

这套设计让"durable worker、存储与凭据留在本地, 工具跑在另一台机器"成为可验证的部署形态, 而不是把整个进程搬走。

## 五、chord: durable 之下的应用组合运行时

### 5.1 对象、引用与 principal

chord 是一个独立的类型化宿主运行时, 用于构建由**对象**组成的应用——这些对象可以分布在多个进程 (server、worker、浏览器标签页) 里, 并且能在运行中**热重载**:

- 对象是地址上的状态加代码, 按需创建, 有人引用就存活。
- 所有人拿到的都是**引用**, 从不直接拿到对象; 引用在本地与跨进程行为一致, 且能活过重载。
- 每个对象知道自己的 **principal**: 属主与访客拿到的是不同对象、不同方法集 (variant)。
- **状态**是可观察的 JSON: 远端观察者先收到快照, 之后是增量。
- **热重载**在运行中换代码: 在飞的工作用它启动时的代码跑完, 状态保留, 不兼容的变更在安全点迁移。

生命周期规则很具体: 引用有明确的属主类别 (对象声明、调用期 `ctx.get`、连接、宿主、UI); 激活按地址合并, 全部请求者离开则丢弃结果; 最后一个引用释放加 linger 之后处置——中止任务、移除监听、按注册反序关闭资源、级联释放引用; 强制处置分波进行, 引用者先于被引用者, 让资源的 close 还能用到对象的引用。

### 5.2 契约、facet 与宿主

契约是运行时值, 用 TypeBox schema 描述: 名字、输入 (对象地址)、成员, 分 local 与 remote 两类; 方法、状态、派生、资源、监听与任务都在工厂里经 `self` 声明。**facet** 是插件对一种宿主的代码 (server、worker、浏览器各一份), 经 `host.serve()` 注册类型工厂; 工厂拿到的 FacetApi 提供 serve、root、registry 与一个在本轮安装失效时中止的 signal——root 与 registry 让非 Chord 方法的代码 (durable 的工具与 hook、原生库回调) 也能访问自己所在的宿主, 因此插件永远不需要进程级全局宿主。宿主之间经 link 交换 JSON 帧; `host.route()` 与 relay 把对远端宿主的 hold 按契约声明的位置解析并转发, 授权在解析前与解析后各查一次。

注册表 (defineRegistry) 是按代码版本划分的不可变表, 顺序取首次注册序, 替换保留; 宿主管理器 (createHostManager/forkDriver/processLock) 负责子宿主进程的启动、停止、替换与存活探测。

### 5.3 复制状态与 delta

chord/delta 是独立的事务性 JSON 跟踪器: `track()` 建立跟踪, `beginChange()` 开草稿, `prepare()` 产出不可变准备值, `adopt()` 校验并交换根指针; `applyImmutable(base, ops)` 在副本上重建状态。准备不改变权威; 采纳验证准备。写入草稿的值立即按值拷贝, 非严格 JSON (undefined 数组元素、非有限数、函数、symbol、稀疏数组等) 在赋值处就抛错; 未变更子树可以在版本间共享。跟踪器信任不可变所有权, 不做防御性拷贝或冻结——发布的值不冻结, 进程内消费者不得原地修改, 可变信任边界要自行克隆或序列化。durable 的文档正是建立在这套模型上: Session 提交直接发布 chord 操作, 消费者 (watch、视图) 拿到的是精确操作而非需要自己 reduce 的快照。

### 5.4 链路与热重载

链路有三种: 内存对 (测试)、Node IPC (子进程) 与 WebSocket (服务端 ws、浏览器 WebSocket)。线帧是 JSON: hello/bye、hold/release (跨链路的引用)、shape、call/result/cancel、sub/unsub/resync 与 state、gone、root_end、retire、invalidate、ping/pong、ack, 以及重载控制帧 prepare/vote/commit/abort。流控是双向的: 两端在 hello 里声明 ack 窗口并累积确认, 未确认帧超过窗口 (默认 256 KiB JSON 文本) 时状态在发送端排队, 按成员流槽位按创建顺序冲刷; 等待中的操作有上限 (默认四个窗口), 超出后最老的流转为当前值的 reset。协议版本 (现为 4) 写在 hello 里, 版本不匹配的双方不协商, 直接关链路。

热重载分四步: **prepare** 在每个受影响宿主上用新工厂以记录模式跑一遍现存对象 (可读现有 cell、写则抛错, 监听/任务/注册只记录不启动, 新资源以候选身份打开), 任何失败即整体放弃; **gate** 对版本抬升或独占资源变更的对象做准入切割——旧代码版本的新 root 拿可重试的 upgrade_conflict, 已持有激活租约的 root 被豁免, 等待截止 (默认 5 秒) 未到就整体中止重来; **commit** 每个宿主以一个同步步骤安装迁移后的 cell 值、把实现换为新代码版本、重启任务、推送 shape/reset; **retire** 遵循两版本规则——宿主至多保留 current 与 previous, previous 的 root 全部结束后才释放, 超时则中止它们并强制退役。兼容变更 (无状态版本抬升、无独占资源变更) 跳过 gate, 无需等待。状态兼容规则是刚性的: 版本抬升必须配 migrate, schema 变更不抬版本直接拒绝重载。

### 5.5 入口与使用者

| 导入                          | 内容                                                                                          | 运行环境      |
| ----------------------------- | --------------------------------------------------------------------------------------------- | ------------- |
| @earendil-works/chord         | 契约、声明、宿主、链路、错误, 以及 Context/JsonValue/Draft/replicatedState 等共享基础         | Node 与浏览器 |
| @earendil-works/chord/node    | 子宿主进程: createHostManager、forkDriver、childControl、processLock; facet 加载器 nodeLoader | Node          |
| @earendil-works/chord/context | 显式取消与调用值: BACKGROUND_CONTEXT、withCancel、withAbortSignal 等                          | Node 与浏览器 |
| @earendil-works/chord/delta   | 事务性跟踪器、结构差分、不可变应用与操作批的编解码                                            | Node 与浏览器 |
| @earendil-works/chord/output  | 有界输出流 OutputBuffer 与按尺寸节流的 Progress                                               | Node 与浏览器 |

仓库内的使用者: durable 是最大的消费方——文档是 chord 跟踪的状态, Context 贯穿每一个异步调用 (BACKGROUND_CONTEXT 永不取消; 取消一个等待只取消该等待, 从不取消工作), OutputBuffer 与 Progress 用于工具输出与进度的节流提交; env 用 chord 的 Context。仓库当前不附带构建在 chord 之上的产品级消费者, 它定位为独立的应用组合运行时。

## 六、接口形态与 TUI

### 6.1 五种接口形态

所有接口共用同一套 agent 与 session 机制:

```text
interactive  终端 TUI
print        跑一个 prompt 输出最终回复
json         agent 事件按 JSONL 输出
rpc          stdin 收 JSONL 命令, stdout 回响应与事件
SDK          进程内直接创建与控制会话
```

终端 stdin/stdout 下默认打开 TUI, `--print`、`--mode json`、`--mode rpc` 选择其他界面; 任一流被重定向且未选 JSON/RPC 时走 print 模式。RPC 客户端封装了切换会话、分叉、克隆、导出、读取树结构等命令, 并带超时等待与错误映射, 使外部程序可以用子进程形态驱动 Pi; 读消息支持以 entry id 作持久游标做增量读取, 树结构读取则暴露完整的分支与标签。

### 6.2 pi-tui 的渲染工程

`packages/tui` 是一个差分渲染的终端 UI 库, 主屏与备屏两个渲染器实现同一接口, 用 CSI 2026 同步输出消除闪烁。工程深度体现在: 双屏管理、布局系统、编辑器组件、emacs 风格编辑原语 (kill ring、撤销栈、按词导航)、自动补全与模糊匹配、LaTeX 渲染、终端图像 (Kitty/iTerm2 图形协议)、Oklab/OKHSL 色彩空间、终端色彩探测、原生修饰键检测与输入缓冲、键位系统。组件模型的要求很具体: 组件为可用宽度渲染行数组, 每行必须适配宽度 (按可见列而非字符串长度测量, 因为 ANSI 转义、宽字符、emoji、组合字符都会改变显示宽度), 状态变化后要让受影响组件失效并请求重渲染。

TUI 文档给出的集成点建议也是分层的: 优先用扩展上下文里的选择、确认、输入、编辑器、通知、状态、组件替换等 API; 只有在需要自己的渲染、键盘或鼠标输入、焦点、布局或生命周期时才自建组件; 不要在扩展里再建一套终端渲染器。

### 6.3 fullscreen 默认与交互资产

交互模式的默认 TUI 形态是全屏, 走备屏渲染器 (应用持有滚动视口, 停止时恢复主缓冲并打印完整最终文档), 可用参数或设置切回常规模式。配套设置包括退出时输出内容 (全文或仅续跑提示)、滚动条、选中即复制、滚轮每次滚动行数。启动呈现可配置为隐藏全部或只隐藏启动细节而保留头部。另有两处终端兼容细节值得记录: 某些终端 (如 Apple Terminal) 绘制半块图形会在行间留缝, 探测后改用文字标; 系统主题的颜色调整不做色度增强——调色板颜色不会获得额外的 OKLCH chroma, 以免加浓柔和终端配色。

## 七、provider 与工具/沙箱体系

### 7.1 统一 provider 面

`packages/ai` 是统一的多供应商 LLM API, 四十多个 provider 模块各配一份模型数据。覆盖面从主流闭源与开源通道到国内厂商及其区域变体一应俱全, 另含若干网关与订阅通道。测试替身 faux provider 被用于全部测试套件, 使 CI 不接触真实 API 与付费 token。

模型目录是生成物而非手写文件: 生成、补全、校验各有独立脚本, 贡献指南允许提交重新生成带来的无关上游模型元数据差异。采样参数支持按思考级别覆盖: 模型可以携带以 Pi 思考级别为键的采样参数, 解析时先按模型支持的级别钳制, 再按"模型默认、生效级别覆盖、请求级参数"的顺序逐键合并; 只有 OpenAI 兼容适配器应用, 其余 API 忽略。

### 7.2 认证模型

用户在 Pi 内登录选择 provider, 走订阅或存 API key, 再切换模型。认证支持环境变量、OAuth (含把最终重定向 URL 或授权码粘回 Pi 的登录方式) 与工作负载身份联合 (从环境变量读取联合规则、组织 ID 与身份令牌文件, 由 SDK 自行换取并刷新短期令牌; 联合客户端跨请求复用以命中令牌缓存)。官方 AI 网关 Radius 作为一等 provider: 登录后其模型像其他 provider 一样出现在模型列表, 认证用网关目录并缓存刷新过的模型元数据以支持离线启动; 登录成功还会提议把网关的 MCP server 写进全局 MCP 配置, 以同一份登录 (auth.provider) 取代 MCP 的 OAuth 登录。

MCP 认证面也有较完整的支持: OAuth 客户端名、让 HTTP server 直接以某个 provider 的当前令牌作 bearer、自定义授权服务器元数据地址、授权码交换前校验授权响应的签发者、升权授权时请求已授予与被质询权限的并集、以及用客户端 ID 元数据文档替代动态客户端注册。MCP 客户端本身是独立包 (pi-mcp): 传输无关的客户端核心、stdio 与 Streamable HTTP 传输、内存测试传输, 不依赖官方 MCP SDK。项目级 MCP 配置里不带连接信息的条目只覆盖同名全局 server 的启用、暴露与工具暴露策略, 便于在受信任项目里开关全局 server。

### 7.3 内置工具与 codemode

内置工具是 read、write、edit、bash (加 powershell、find、grep、ls), 配套文件变更串行化、输出累积、截断与路径处理。工具注册进统一注册面, 因此扩展可以包装、替换或动态生成工具。

codemode 是最特别的内置扩展, 其沙箱内核已抽成独立包 pi-codemode: 在编译到 WASI 的 QuickJS 虚拟机里运行模型写的 JavaScript, 能力被限定为调用注入的工具与运行非 LLM 模型, 脚本本身没有 Node API、文件系统、网络、定时器, 也没有模块与 WebAssembly; `eval` 与 `Function` 可用, 但只能产出同一 VM 内的更多代码。嵌套工具调用从不进入 LLM 上下文, 只有脚本的输出与返回值进入。包本身没有任何 pi 依赖, 可以独立使用, 把任意函数 (远程 API、MCP server、应用服务) 暴露给模型脚本。

沙箱按运行环境分三种, 共享同一 API、同一脚本环境与同一结果格式:

| 环境                        | 沙箱类                | 脚本运行位置                        |
| --------------------------- | --------------------- | ----------------------------------- |
| Node 与 Bun                 | CodemodeSandbox       | 每次执行一个 worker 线程            |
| Cloudflare Workers/DO       | RemoteCodemodeSandbox | 另一部署 Worker 里的 Durable Object |
| 其他运行时 (或可阻塞调用方) | InlineCodemodeSandbox | 调用线程                            |

coding-agent 对沙箱的约束: VM 堆上限 256 MB; 一个 pi 进程内所有会话合计最多两个 codemode worker 存活, 满额时新脚本立即失败; 等待永不落定 promise 的脚本 (没有挂起工具调用且 VM 无定时器) 会立即失败而不是挂死。脚本首行可写 `// @options:` 注释调整行为 (不在首行直接失败): `max_output_tokens` 是软预算 (默认 10000), 超预算时保留首尾、把完整文本落到临时文件并在结果里给出路径; `timeout_ms` 是整个脚本的硬截止。硬上限则是失败线——文本加 base64 图像数据超过 16777216 字符, 或 text()/image()/console 调用超过 10 万次, 脚本直接失败, 打印循环无法耗尽宿主内存。

脚本经 `models` 绑定可列出聊天、图像与分类三类模型, 但聊天模型只能列出、不能从脚本运行; 真正可执行的是分类与图像生成两类非 LLM 调用, 它们共用同一个在飞调用上限 (每脚本 4 个), 超量的调用自动排队。脚本从工具拿到的结果按工具能力分层: 带输出 schema 的工具解析为结构化值 (bash 给 `{ output, truncated, full_output_path?, exit_code, wall_time_seconds }`, output 上限 1 MiB, 超长保留首尾各 512 KiB), MCP 工具给完整 CallToolResult, read 对图像给图像块。`store(key, value)`/`load(key)` 在多次 codemode 调用间保存小 JSON 状态 (单值至多 262144 字符, 合计至多 1048576), 成功脚本的写入以自定义 entry 追加进会话, 因此分支各见其路径上的值。工具声明以 TypeScript 声明的形式内联进描述, 按命名空间分组, 共享 3000 token 的预算; 超出的工具由脚本内的 `searchTools()` (BM25 排序)、`describeTool()`、`describeNamespace()` 或过滤 `ALL_TOOLS` 发现。能力足够的模型写脚本时走受约束采样 (OpenAI Lark 语法), 直接产出原始文本而非 JSON 转义字符串。

durable 侧另有配套的 codemode 扩展: 每次脚本调用是嵌套工具调用, 脚本本身可跨重启续跑。做法是让沙箱确定性运行 (虚拟时钟、种子化随机、UTC), 工具把脚本得到的每个结果先写日志再交付; 重启后重跑脚本, 按日志顺序交付结果, 脚本发出同样调用并按 key 重新接上未完成的嵌套调用; 脚本走了不同路径、指纹或版本变化、或超时已过, 则以错误结束。设计意图与"用代码代替连续工具调用"一致: 让模型写一段脚本批量编排工具, 而不是每个动作一轮对话。

### 7.4 权限模型与容器化

安全文档的表述非常直接: Pi 没有内置权限系统来限制文件系统、进程、网络或凭据访问, 默认以启动它的用户与进程的权限运行, 且不在每次工具调用前请求批准; 项目 trust 只控制加载哪些项目资源 (且不是完整的启动边界), 不做工具调用沙箱。启用的工具使用进程的操作系统权限, 扩展就在该进程内执行。

需要更强边界就容器化, 文档给出四种模式:

1. Gondolin 扩展: Pi 与 provider 认证留在宿主机, 内置工具与 shell 命令路由进本地 Linux micro-VM。
2. 纯 Docker: 整个 Pi 进程跑本地容器, 简单隔离。
3. Docker Sandboxes: 托管沙箱, provider 凭据留在宿主机并由代理替换, 不把真实 key 暴露给容器。
4. OpenShell: 整个 Pi 进程跑在策略控制的沙箱里, 对文件系统、进程、网络与凭据施加策略。

此外根仓库还带一个沙箱运行时依赖与一个沙箱示例扩展。可以看出沙箱能力全部外置为可选层, 与内核最小化是同一取向。

## 八、适用场景与边界

### 8.1 适用场景

- 希望把 Agent 嵌进自己工具链的团队。TypeScript SDK 暴露的就是 CLI 自己用的会话、资源加载器与运行时, 依赖注入面完整, 示例随仓库类型检查, 因此嵌入成本低且不易被内部改动打断。
- 需要长期可回溯的交互式编码。entry 树加 active branch 的模型让"回到更早的分支继续"不影响历史; 压缩只替换模型可见视图, 原始 entry 保留。
- 需要严格崩溃恢复的自动化。durable 的"先提交再展示"与原子提交不变量, 加上 codemode 脚本的确定性重放, 适合把 Agent 放进无人值守流程; 表现层需要宿主自建, 库提供的是结构化视图、精确操作 watch 与仿 coding-agent 的事件流。
- 多形态驱动。同一套会话机制支撑 TUI、打印、JSON 事件、RPC 与 SDK 五种形态, RPC 客户端让外部程序以子进程形态驱动完整会话。
- 需要广覆盖模型通道。统一 provider 面与生成式模型目录让"接一个新模型服务"成为数据而非代码工作。
- 需要把工具执行移出本机。pi-env 让 durable 的工具跑在经 SSH 部署的远程守护程序上, 语义与本地 Node 环境逐项对齐, 并有差分测试背书。

### 8.2 边界与未完成项

- 权限边界全靠外置。没有内置沙箱时, 工具调用与扩展拥有与 Pi 进程相同的操作系统权限; 处理不可信文件、仓库、扩展或无人值守自动化前必须先读安全文档并选择容器化模式。
- durable、chord 与 pi-env 都是实验性接口, 声明会随版本变动; 仓库当前不附带构建在 durable/chord 之上的产品级消费者, CLI 也不依赖它们, 基于 durable 构建应用需要自行解决表现层与编排。
- 内核最小化是双刃剑。默认不带 sub-agent、plan mode 等能力, 用户需要自己组合或安装扩展; 大量示例扩展示范了可能性, 但也意味着这些能力的成熟度取决于生态而非内核。
- 贡献门槛高。新贡献者的 issue 与 PR 默认自动关闭, 维护者按质量复查后决定是否重开; 这降低了维护噪音, 也提高了外部参与成本。
- 两条安装通道的安全级别不同。官方安装器从生成的安装锁文件装传递依赖并钉死它们, 而直接经 npm 全局安装不会钉死传递依赖; 文档明示这一差别, 迁移建议也由此而来。

### 8.3 值得借鉴的工程点

1. 树形会话模型: entry 带 parent 指针的 JSONL 树加 active branch, 分支不删历史, 压缩只是视图层替换——比线性消息数组加截断保留了更多可回溯性。
2. 最小内核加分层资源阶梯: 从指令文件到 package 每层复杂度递增, 文档明确引导用户从最弱机制开始, 把"该用哪一层"变成可讨论的工程问题。
3. SDK 与 CLI 同源: 嵌入方拿到的是 CLI 自己用的会话、资源加载器与运行时, 依赖注入完整, 示例随仓库类型检查, 因此 Agent 也能自我解释自己的工作原理。
4. durable 的提交不变量: 原子提交、无易失发布路径、外部副作用移出事务、存储错误即致命——这套约束是"进程死掉能续跑"可验证的原因, 而不只是口号。
5. 供应链加固成体系: 精确版本、发布年龄门槛、全链路忽略脚本、传递依赖钉死与 lifecycle script allowlist, 每条都针对真实的包投毒攻击面。
6. codemode 把"模型写代码编排工具"关进只暴露注入工具与非 LLM 模型的沙箱, 并抽成无 pi 依赖的独立包: 输出硬上限让打印循环无法耗尽宿主, 确定性运行加日志交付让脚本跨重启续跑。
7. fail-closed 与可移植并存: 存储核心不依赖 Node API, 便于换运行时; 而存储错误直接判定为致命, 避免"看起来成功但状态不明"的持久化。
8. chord 把"提交 → 操作 → 副本"做成基础设施: 持久层直接发布结构化操作, 消费者无需自建 reducer; 热重载用 prepare/gate/commit/retire 四步与两版本规则做到在飞工作不丢、状态可迁移、失败可整体回退。
