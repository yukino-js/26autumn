---
title: "OpenAI Codex CLI: 产品形态、TypeScript SDK 与 app-server 协议化架构"
description: "拆解 Codex CLI 的 Rust 单体内核与多形态产品面: SQ/EQ 协议模型、app-server JSON-RPC 线、TypeScript SDK 的子进程+JSONL 设计、Seatbelt/Landlock 沙箱与 execpolicy 规则引擎、MCP 双向集成、分层配置系统、rollout 持久化与压缩策略"
local_path: "$HOME/Downloads/codex"
---

Codex CLI 是 OpenAI 的本地编码 Agent, 以 Rust 单体内核为核心, 通过协议化接口向外暴露多种产品形态: 交互式 TUI、非交互 `codex exec`、IDE/桌面嵌入的 app-server、TypeScript/Python SDK、远程执行服务 (exec-server)、云任务浏览器。本文按机制而非目录组织, 讲清这套内核如何支撑多形态分发、协议模型如何设计、沙箱与审批如何协作、配置如何分层、会话如何持久化与压缩。读者应熟悉至少一个编码 Agent 的交互形态 (如 [Pi](pi) 或 [Claude Code](claude-code)), 并对 Rust、JSON-RPC、终端程序有基本认识。

本文描述的是当前代码库的机制, 不涉及版本演进与发布记录。

## 一、产品形态与分发

### 1.1 单体内核, 多形态出口

Codex 的核心判断是: Agent 内核只写一次, 产品形态通过协议接口分化。`codex-rs/` 是一个包含约 160 个 workspace member 的 Rust 单体内核, 其中 `core` crate 承载 Agent 循环、工具编排、会话管理; `protocol` crate 定义内核与 UI 之间的 SQ/EQ (Submission Queue / Event Queue) 消息模型; `app-server` 与 `app-server-protocol` 将内核能力包装为 JSON-RPC 服务; `tui` 与 `exec` 是两个直接消费内核的 CLI 形态。

| 形态           | 入口                | 内核接入方式                               | 典型场景                   |
| -------------- | ------------------- | ------------------------------------------ | -------------------------- |
| 交互式 TUI     | `codex` (无子命令)  | 进程内 `InProcessAppServerClient`          | 开发者日常编码             |
| 非交互执行     | `codex exec`        | 进程内 app-server client                   | CI/CD、脚本自动化          |
| IDE/桌面嵌入   | `codex app-server`  | stdio/unix socket/websocket JSON-RPC       | VS Code、Cursor、桌面 App  |
| TypeScript SDK | `@openai/codex-sdk` | 子进程 `codex exec --json`                 | Node.js 应用集成           |
| Python SDK     | `openai-codex`      | 子进程 `codex app-server` (stdio JSON-RPC) | Python 应用集成            |
| 远程执行服务   | `codex exec-server` | 独立 exec-server 服务 (实验性)             | 远程/云端执行环境          |
| 云任务         | `codex cloud`       | 远程 API client                            | 浏览/应用 Codex Cloud 任务 |
| 桌面 App       | `codex app`         | 启动独立桌面应用                           | macOS/Windows 桌面体验     |

### 1.2 npm 分发与平台二进制

`codex-cli/` 是 npm 包 `@openai/codex` 的入口, 其 `bin/codex.js` 是一个平台分发器: 根据 `process.platform` 与 `process.arch` 解析目标三元组 (如 `x86_64-unknown-linux-musl`、`aarch64-apple-darwin`), 从对应的平台特定 npm 包 (`@openai/codex-linux-x64`、`@openai/codex-darwin-arm64` 等) 的 `vendor/` 目录中定位原生二进制, 然后 `spawn` 执行。这种设计让 npm 安装自动拉取正确平台的预编译二进制, 无需用户手动选择。

TypeScript SDK (`sdk/typescript/`) 复用同一套平台解析逻辑: `CodexExec` 类在构造时调用 `findCodexPath()`, 通过 `createRequire` 解析 `@openai/codex` 包的位置, 再定位平台特定包中的 `codex` 二进制。SDK 不内嵌内核, 而是作为子进程管理器存在。

### 1.3 arg0 多调用二进制

`codex-rs/arg0/` 实现了 "arg0 trick": 同一个二进制文件根据 `argv[0]` 的 basename 分发到不同的入口。例如 `codex-linux-sandbox` 会直接执行 Linux 沙箱辅助进程, `apply_patch` 会进入独立的 apply-patch 工具, `codex-execve-wrapper` (Unix) 会进入 shell 升级的 execve 包装器; 此外还通过 `argv[1]` 哨兵参数分发内部辅助进程 (如 `--codex-run-as-arg0-exec-helper`、`--codex-run-as-fs-helper` 与 Windows 沙箱包装器)。这让单个二进制可以扮演多个角色, 减少分发复杂度。

## 二、Rust 内核架构

### 2.1 crate 分层

内核的 crate 依赖关系呈严格分层:

```text
protocol (消息类型定义)
    ↑
core (Agent 循环、工具编排、会话管理)
    ↑
├── tui (交互式终端 UI)
├── exec (非交互执行)
├── app-server (JSON-RPC 服务)
├── codex-mcp (MCP client)
└── cloud-tasks (云任务浏览器)
```

`protocol` crate 定义 `Op` (提交队列操作) 与 `EventMsg` (事件队列消息) 两个核心枚举, 以及 `SandboxPolicy`、`AskForApproval`、`ReviewDecision` 等安全相关类型。`core` crate 消费这些类型, 实现 Agent 循环; 上层形态 crate 通过 `app-server-client` 或直接嵌入 `core` 来驱动内核。

辅助 crate 包括: `sandboxing` (Seatbelt/Landlock/bwrap 封装)、`execpolicy` (Starlark 规则引擎)、`rollout` (会话持久化)、`history` (历史项类型)、`config` (分层配置加载)、`login` (认证)、`codex-api` (Responses API client)、`model-provider` (provider 抽象)、`tools` (工具定义与路由)、`exec-server` (远程执行服务)。

### 2.2 Agent 循环: Session 与 Turn

`core/src/session/session.rs` 中的 `Session` 结构体是 Agent 循环的核心。其设计约束是: **一个 Session 同时最多只有一个 running task**。Task 由一系列 Turn 组成, 每个 Turn 是一次 "请求模型 → 流式接收响应 → 执行工具 → 产出输出" 的循环。

Turn 的生命周期:

1. 用户输入通过 `Op::TurnInput` 进入提交队列
2. Session 组装 prompt (包含历史、系统指令、工具定义)
3. 通过 `ModelClientSession` 向 Responses API 发起流式请求
4. 模型返回的 tool call 由 `ToolOrchestrator` 编排执行
5. 工具输出反馈给模型, 进入下一轮迭代
6. 模型完成或用户中断时, Turn 结束

`Session` 持有 `TurnContext` (每 Turn 设置) 与 `StepContext` (每步上下文), 以及 `WorldState` (世界状态快照)。Turn 之间通过 `response_id` 链接, 支持从任意历史点 fork 新分支。

### 2.3 工具编排

`core/src/tools/orchestrator.rs` 中的 `ToolOrchestrator` 是工具执行的中央调度器, 其职责序列是: **审批 → 沙箱选择 → 执行尝试 → 失败时升级沙箱重试**。

工具注册通过 `ToolRegistry` 管理, 路由通过 `ToolRouter` 分发。内置工具包括:

- `exec_command` / `shell` — 命令执行
- `apply_patch` — 文件变更
- `update_plan` — 计划更新
- `request_user_input` — 向用户提问
- `view_image` — 图像查看
- `mcp__*` — MCP 工具 (命名空间前缀)
- `multi_agents` — 多 Agent 协作

每个工具调用经过 `ToolOrchestrator` 时, 首先检查是否需要审批 (基于 `AskForApproval` 策略与 `execpolicy` 规则), 然后选择合适的沙箱 (基于 `SandboxPolicy` 与平台能力), 最后执行。工具发现与代码上下文检索可以结合 [CodeGraph](codegraph) 等代码知识图谱方案, 减少 Agent 的探索成本。如果沙箱内执行失败且策略允许, 会升级到更宽松的沙箱重试, 但不会重新请求审批 (审批结果被缓存)。

### 2.4 模型客户端

`core/src/client.rs` 中的 `ModelClient` 是会话级模型客户端, 持有认证、provider 选择、thread id 等稳定状态。每 Turn 创建 `ModelClientSession`, 用于流式请求 Responses API。

`codex-api` crate 封装了 Responses API 的 HTTP/WebSocket 客户端, 支持 SSE 流式响应、重试、压缩、遥测。`model-provider` crate 抽象了 provider 配置, 支持 OpenAI、Azure OpenAI、Amazon Bedrock、自定义 OpenAI 兼容端点。

WebSocket 连接支持 prewarm (预热): 在 Turn 开始前发送 `response.create` 且 `generate=false`, 等待连接建立, 以便后续请求复用同一连接与 `previous_response_id`。

## 三、协议模型: SQ/EQ 与 app-server JSON-RPC

### 3.1 SQ/EQ: 内核协议

`protocol` crate 定义了内核与 UI 之间的消息模型, 源自 `codex-rs/docs/protocol_v1.md`:

- **Submission Queue (SQ)**: UI → 内核, 载荷为 `Op` 枚举
- **Event Queue (EQ)**: 内核 → UI, 载荷为 `EventMsg` 枚举

`Op` 的关键变体包括:

- `TurnInput` — 提交用户输入, 启动新 Turn
- `Interrupt` — 中断当前 Turn
- `ExecApproval` / `PatchApproval` — 审批命令/补丁执行
- `Compact` — 请求上下文压缩
- `Review` — 请求代码审查
- `ThreadSettings` — 更新线程设置
- `ResolveElicitation` — 解析 MCP elicitation 请求

`EventMsg` 的关键变体包括:

- `TurnStarted` / `TurnComplete` — Turn 生命周期
- `AgentMessage` / `AgentMessageContentDelta` — 模型输出 (完整/流式)
- `ExecCommandBegin` / `ExecCommandEnd` — 命令执行生命周期
- `ExecApprovalRequest` / `ApplyPatchApprovalRequest` — 审批请求
- `PatchApplyBegin` / `PatchApplyEnd` — 补丁应用生命周期
- `McpToolCallBegin` / `McpToolCallEnd` — MCP 工具调用
- `ContextCompacted` — 上下文已压缩
- `TokenCount` — token 用量更新

SQ/EQ 是进程内 Rust 类型, 不是稳定的 serde wire contract。`Op` 标记为 `non_exhaustive`, 允许未来添加新变体; `EventMsg` 未加该标记, 但事件集合同样在持续扩展。

### 3.2 app-server: JSON-RPC 协议线

`app-server` crate 将内核能力包装为 JSON-RPC 服务, 供 IDE、桌面 App、远程客户端消费。`app-server-protocol` crate 定义了 wire contract。

Codex 使用 JSON-RPC 2.0 方言, 但**省略 `"jsonrpc": "2.0"` 字段** (既不发送也不期望)。消息类型包括:

- `JSONRPCRequest` — 带 `id`、`method`、`params`、可选 `trace` (W3C Trace Context)
- `JSONRPCNotification` — 无 `id`, 不期望响应
- `JSONRPCResponse` — 成功响应
- `JSONRPCError` — 错误响应

`ClientRequest` 枚举由 `client_request_definitions!` 宏生成, 包含 170+ 个方法, 覆盖:

- 线程生命周期: `thread/start`、`thread/resume`、`thread/fork`、`thread/archive`、`thread/delete`
- Turn 控制: `turn/start`、`turn/interrupt`、`turn/steer`、`turn/settings/update`
- 历史与搜索: `thread/read`、`thread/turns/list`、`thread/items/list`、`thread/search`
- 配置: `config/read`、`config/value/write`、`config/batchWrite`
- MCP: `mcpServer/oauth/login`、`mcpServer/tool/call`、`mcpServerStatus/list`
- 账户: `account/login/start`、`account/read`、`account/rateLimits/read`
- 文件系统: `fs/readFile`、`fs/writeFile`、`fs/watch`
- 插件与技能: `plugin/list`、`plugin/install`、`skills/list`
- 审查: `review/start`
- 实时语音: `thread/realtime/start`、`thread/realtime/appendAudio`

`ServerRequest` 枚举 (9 个方法) 用于服务端向客户端请求审批或输入:

- `item/commandExecution/requestApproval` — 命令执行审批
- `item/fileChange/requestApproval` — 文件变更审批
- `item/tool/requestUserInput` — 工具请求用户输入
- `mcpServer/elicitation/request` — MCP elicitation
- `item/permissions/requestApproval` — 权限审批

`ServerNotification` 枚举 (80+ 个通知) 用于服务端向客户端推送事件:

- `thread/started`、`turn/started`、`turn/completed` — 生命周期
- `item/started`、`item/completed` — 项生命周期
- `item/agentMessage/delta`、`item/reasoning/textDelta` — 流式输出
- `item/commandExecution/outputDelta` — 命令输出流
- `thread/compacted` — 上下文压缩
- `account/rateLimits/updated` — 速率限制更新

### 3.3 协议版本与 TypeScript 导出

`app-server-protocol` 支持 v1 与 v2 两个协议版本。v2 是当前主力协议版本。协议类型通过 `ts-rs` 与 `schemars` 导出为 TypeScript 类型与 JSON Schema, 供 IDE 扩展与 SDK 消费。

`app-server-protocol/src/precomputed_exports.rs` 包含预计算的 TypeScript 与 JSON Schema 导出 (zstd 压缩), 避免运行时生成开销。`export.rs` 提供完整的导出管线, 包括 experimental API 字段的处理。

### 3.4 传输层

`app-server-transport` crate 支持多种传输:

- `stdio://` — 标准输入输出 (默认)
- `unix://` — Unix domain socket
- `ws://` — WebSocket (TCP)
- `off` — 禁用传输 (用于进程内嵌入)

`app-server-client` crate 提供统一的客户端 facade, 支持两种模式:

- `InProcess` — 进程内嵌入, 通过 bounded channel 通信
- `Remote` — 远程连接, 通过 WebSocket/Unix socket 通信

TUI 默认使用 `InProcess` 模式 (Embedded), 但也可以连接到本地 daemon (`LocalDaemon`) 或远程服务器 (`Remote`)。`exec` 同样使用 `InProcess` 模式。

## 四、TypeScript SDK: 子进程 + JSONL

### 4.1 设计选择

TypeScript SDK (`sdk/typescript/`, npm 包 `@openai/codex-sdk`) 的设计选择是: **不内嵌内核, 而是作为子进程管理器**。SDK 通过 `spawn` 启动 `codex exec --json` (或 `--experimental-json`, 两者等价), 解析 stdout 的 JSONL 事件流, 将事件映射为 TypeScript 类型。

这种设计的权衡:

- 优点: SDK 体积小, 无需 N-API 绑定, 内核升级无需重新编译 SDK
- 缺点: 进程启动开销, IPC 序列化开销, 无法访问内核内部状态

### 4.2 API 面

SDK 的核心类:

- `Codex` — 主入口, 提供 `startThread()` 与 `resumeThread(id)`
- `Thread` — 对话线程, 提供 `run()` 与 `runStreamed()`
- `CodexExec` — 子进程管理器 (内部类)

`CodexOptions` 支持:

- `codexPathOverride` — 自定义 codex 二进制路径
- `baseUrl` / `apiKey` — OpenAI API 配置
- `config` — 结构化配置覆盖 (JSON 对象, 自动展平为 dotted path)
- `configOverrides` — 原始 `--config key=value` 字符串
- `env` — 环境变量 (提供时不继承 `process.env`)

`ThreadOptions` 支持:

- `model` / `modelReasoningEffort` — 模型与推理强度
- `sandboxMode` — `read-only` / `workspace-write` / `danger-full-access`
- `approvalPolicy` — `never` / `on-request` / `on-failure` / `untrusted`
- `workingDirectory` / `additionalDirectories` — 工作目录
- `networkAccessEnabled` / `webSearchMode` — 网络与搜索
- `skipGitRepoCheck` — 跳过 Git 仓库检查

`TurnOptions` 支持:

- `outputSchema` — JSON Schema, 用于结构化输出
- `signal` — `AbortSignal`, 用于取消
- `cyberAccessProgram` — 实验性 Cyber 访问计划

### 4.3 事件流与类型契约

`codex exec --json` 输出的 JSONL 事件流由 `exec/src/exec_events.rs` 定义, SDK 的 `events.ts` 与 `items.ts` 是其 TypeScript 镜像。

`ThreadEvent` 联合类型:

- `thread.started` — 线程启动, 携带 `thread_id`
- `turn.started` / `turn.completed` / `turn.failed` — Turn 生命周期
- `item.started` / `item.updated` / `item.completed` — 项生命周期
- `error` — 致命错误

`ThreadItem` 联合类型:

- `agent_message` — 模型文本输出
- `reasoning` — 推理摘要
- `command_execution` — 命令执行 (携带 `command`、`aggregated_output`、`exit_code`、`status`)
- `file_change` — 文件变更 (携带 `changes` 数组, 每项有 `path`、`kind`)
- `mcp_tool_call` — MCP 工具调用 (携带 `server`、`tool`、`arguments`、`result`/`error`、`status`)
- `web_search` — 网页搜索
- `todo_list` — 待办列表
- `error` — 非致命错误

`run()` 方法消费事件流, 收集所有 `item.completed` 的项, 提取最后一个 `agent_message` 作为 `finalResponse`, 返回 `Turn` 对象 (包含 `items`、`finalResponse`、`usage`)。`runStreamed()` 返回 `StreamedTurn` 对象, 其 `events` 字段是 `AsyncGenerator<ThreadEvent>`, 允许调用者实时处理事件。

### 4.4 配置覆盖序列化

SDK 的 `config` 选项接受 JSON 对象, 内部通过 `serializeConfigOverrides()` 展平为 dotted path 并序列化为 TOML 字面量, 以兼容 CLI 的 `--config` 解析。例如 `{ model_reasoning_effort: "high" }` 被序列化为 `--config model_reasoning_effort="high"`。

嵌套对象被展平: `{ sandbox_workspace_write: { network_access: true } }` 变为 `--config sandbox_workspace_write.network_access=true`。数组被序列化为 TOML 数组字面量。

## 五、沙箱与审批

### 5.1 平台沙箱

`sandboxing` crate 封装了平台特定的沙箱机制:

| 平台    | 沙箱类型                 | 实现                                     |
| ------- | ------------------------ | ---------------------------------------- |
| macOS   | `MacosSeatbelt`          | Seatbelt (sandbox-exec) + .sbpl 策略文件 |
| Linux   | `LinuxSeccomp`           | Landlock + seccomp + bwrap (bubblewrap)  |
| Windows | `WindowsRestrictedToken` | Restricted token sandbox                 |
| Windows | `WindowsMxc`             | MXC sandbox (实验性)                     |

`SandboxManager` 是沙箱编排器, 负责:

- 根据 `SandboxPolicy` 与平台能力选择沙箱类型
- 将命令转换为沙箱内可执行的形式
- 管理沙箱生命周期

`SandboxPolicy` 枚举:

- `DangerFullAccess` — 无限制
- `ReadOnly { network_access }` — 只读文件系统
- `WorkspaceWrite { writable_roots, network_access, ... }` — 工作区可写
- `ExternalSandbox { network_access }` — 已在外部沙箱中

macOS Seatbelt 策略由多个 .sbpl 文件组合: `seatbelt_base_policy.sbpl` (基础策略)、`seatbelt_network_policy.sbpl` (网络策略)、`seatbelt_preferences_policy.sbpl` (偏好设置策略)、`seatbelt_read_only_platform_defaults.sbpl` (只读平台默认值)。

Linux 沙箱通过 `linux-sandbox` crate 实现, 使用 Landlock 进行文件系统访问控制, seccomp 进行系统调用过滤, bwrap 进行命名空间隔离。`bwrap` crate 封装了 bubblewrap 的调用。

### 5.2 审批策略

`AskForApproval` 枚举定义审批策略:

- `UnlessTrusted` — 用于标记为不可信项目的内部策略: 命令一律需要审批, 除非有明确的 execpolicy 规则放行
- `OnRequest` (默认) — 模型决定何时请求审批
- `Granular(GranularApprovalConfig)` — 细粒度控制
- `Never` — 从不请求审批, 失败直接返回给模型

`GranularApprovalConfig` 允许分别控制:

- `sandbox_approval` — shell 命令审批
- `rules` — execpolicy `prompt` 规则触发的审批
- `skill_approval` — skill 脚本执行审批
- `request_permissions` — `request_permissions` 工具审批
- `mcp_elicitations` — MCP elicitation 审批

审批请求通过 `EventMsg::ExecApprovalRequest` 或 `EventMsg::ApplyPatchApprovalRequest` 发送到 UI, UI 通过 `Op::ExecApproval` 或 `Op::PatchApproval` 返回 `ReviewDecision` (Approved / Denied / ApprovedForSession)。

### 5.3 execpolicy: Starlark 规则引擎

`execpolicy` crate 实现了一个基于 Starlark 的规则引擎, 用于定义命令执行策略。规则文件 (`.rules`) 使用 Starlark 语法, 通过 `PolicyParser` 解析。

内置函数:

- `prefix_rule(pattern, decision, match, not_match, justification)` — 前缀匹配规则
- `network_rule(host, protocol, decision, justification)` — 网络规则

`Decision` 枚举:

- `Allow` — 允许执行, 无需审批
- `Prompt` — 请求用户审批
- `Forbidden` — 禁止执行

`Policy` 结构体持有 `rules_by_program` (按程序名索引的规则) 与 `network_rules` (网络规则)。规则评估时, 首先按命令的第一个 token 查找匹配的规则, 然后评估前缀模式与 match/not_match 条件。

规则文件是各配置层 `rules/` 目录下的 `*.rules` 文件: 用户级在 `$CODEX_HOME/rules/` (默认策略为 `default.rules`), 项目级在 `.codex/rules/`; 按层优先级从低到高加载, 高优先级层可覆盖低层的规则。`codex exec` 的 `--ignore-rules` 标志跳过用户与项目层的 `.rules` 文件加载。

### 5.4 沙箱与审批的协作

`ToolOrchestrator` 的执行序列是: 审批 → 沙箱选择 → 执行 → 失败时升级沙箱重试。

审批决策基于:

1. `AskForApproval` 策略
2. `execpolicy` 规则评估结果
3. 命令的 `SecurityRiskScore` (如果可用)

沙箱选择基于:

1. `SandboxPolicy` (来自配置或 Turn 设置)
2. 平台能力 (`get_platform_sandbox()`)
3. 命令的权限需求

如果沙箱内执行失败且策略允许升级, `ToolOrchestrator` 会尝试更宽松的沙箱 (例如从 `ReadOnly` 升级到 `WorkspaceWrite`), 但不会重新请求审批。审批结果被缓存, 避免重复打扰用户。

## 六、MCP 双向集成

### 6.1 Codex 作为 MCP client

`codex-mcp` crate 实现了 MCP (Model Context Protocol) client, 允许 Codex 调用外部 MCP server 的工具。

配置通过 `config.toml` 的 `mcp_servers` 表:

```toml
[mcp_servers.my_server]
command = "npx"
args = ["-y", "@modelcontextprotocol/server-filesystem", "/path"]
env = { KEY = "value" }
```

`McpRuntime` 管理 MCP server 连接的生命周期, 包括启动、握手、工具发现、调用、关闭。`McpConnectionSet` 持有所有活跃连接。

MCP 工具在 Codex 内部的命名规则是 `mcp__<server_name>__<tool_name>`, 例如 `mcp__filesystem__read_file`。工具定义通过 `McpCatalogBuilder` 收集, 并注入到模型的工具列表中。

MCP server 支持 OAuth 认证, 通过 `mcpServer/oauth/login` app-server 方法或 `codex mcp login` CLI 命令触发。OAuth token 存储在 `$CODEX_HOME/secrets/mcp_oauth.age` (age 加密文件, 解密密钥存于系统 keyring, keyring 不可用时落盘)。

MCP elicitation (服务端向客户端请求用户输入) 通过 `EventMsg::ElicitationRequest` 发送到 UI, UI 通过 `Op::ResolveElicitation` 返回用户决策。关于 MCP 协议本身的更多背景, 参见 [MCP App](mcp-app)。

### 6.2 `codex mcp` 命令

`codex mcp` 子命令用于管理外部 MCP server, 而不是把 Codex 自身暴露为 MCP server。它提供 `list`/`get`/`add`/`remove`/`login`/`logout` 子命令: `add` 把一个 server 条目写入 `~/.codex/config.toml` (支持 stdio 与 streamable HTTP 两种传输), `login`/`logout` 管理该 server 的 OAuth 凭据。对 Codex 的程序化集成由 app-server JSON-RPC 线与 exec-server 远程执行服务承担。

### 6.3 Codex Apps

`codex-mcp` 还实现了 "Codex Apps" 机制: 一个宿主内置 (host-owned) 的 apps MCP server, 以 `codex_apps` 命名空间暴露, 把 ChatGPT 托管的 app connector 元数据规范化为模型可见的 MCP 工具。Apps 提供日历、邮件、文档等集成, 工具名如 `mcp__codex_apps__calendar_create_event`。

Apps 的配置通过 `config.toml` 的 `[apps]` 表管理, 支持全局默认 (`[apps._default]`) 与按 app 的配置 (如 `[apps.google_drive]`)。

## 七、配置系统

### 7.1 分层配置

`config` crate 实现了分层配置加载, 优先级从高到低:

1. `LegacyManagedConfigTomlFromMdm` — MDM 交付的 `managed_config.toml`
2. `LegacyManagedConfigTomlFromFile` — 文件系统的 `managed_config.toml`
3. `SessionFlags` — CLI 覆盖 (作为 dotted-path TOML 写入)
4. `Project` — 项目配置 (`.codex/config.toml`)
5. `User` profile — 用户 profile 配置
6. `User` — 用户配置 (`$CODEX_HOME/config.toml`)
7. `EnterpriseManaged` — 云管理配置 bundle
8. `System` — 系统配置 (`/etc/codex/config.toml` 或 Windows 系统路径)

`ConfigLayerStack` 持有所有层, 提供 `effective_config()` (合并后的 TOML) 与 `origins()` (每 key 的来源元数据)。层可以标记为 `disabled_reason`, 此时仍 surfaced 给 UI 但不参与合并。

### 7.2 config.toml 结构

`ConfigToml` 结构体定义了 `config.toml` 的 schema, 关键字段包括:

| 字段                     | 类型                                     | 说明                                    |
| ------------------------ | ---------------------------------------- | --------------------------------------- |
| `model`                  | `Option<String>`                         | 默认模型                                |
| `model_provider`         | `Option<String>`                         | provider id (指向 `model_providers` 表) |
| `approval_policy`        | `Option<AskForApproval>`                 | 审批策略                                |
| `sandbox_mode`           | `Option<SandboxMode>`                    | 沙箱模式                                |
| `mcp_servers`            | `HashMap<String, McpServerConfig>`       | MCP server 配置                         |
| `model_providers`        | `HashMap<String, ModelProviderInfo>`     | 自定义 provider                         |
| `model_reasoning_effort` | `Option<ReasoningEffort>`                | 推理强度                                |
| `web_search`             | `Option<WebSearchMode>`                  | 网页搜索模式                            |
| `history`                | `Option<History>`                        | 历史配置                                |
| `projects`               | `Option<HashMap<String, ProjectConfig>>` | 项目特定配置                            |

### 7.3 Profiles

Profile 是命名的配置预设, 通过 `--profile <name>` 激活: 对应配置放在独立的 `$CODEX_HOME/<name>.config.toml` 文件中, 作为第二个 user 层叠加在用户配置之上, 因此只需写要覆盖的字段。Profile 可以覆盖 model、provider、approval_policy、sandbox_mode、reasoning_effort 等字段。

### 7.4 Model Providers

`ModelProviderInfo` 定义了自定义 model provider 的配置:

- `base_url` — API 端点
- `env_key` — 存储 API key 的环境变量名
- `wire_api` — wire protocol (仅 `responses`)
- `capabilities` — API 能力覆盖
- `http_headers` / `env_http_headers` — 自定义 HTTP 头
- `request_max_retries` / `stream_max_retries` — 重试配置
- `auth` — 命令 backed bearer token 配置
- `aws` — AWS SigV4 认证配置

内置 provider 包括 `openai`、`amazon-bedrock`、`amazon-bedrock-runtime`、`ollama`、`lmstudio`。自定义 provider 通过 `model_providers` 表定义。

### 7.5 认证

`login` crate 实现了多种认证方式:

- `ApiKey` — OpenAI API key
- `Chatgpt` — ChatGPT OAuth (PKCE flow)
- `ChatgptAuthTokens` — ChatGPT auth tokens
- `Headers` — 自定义 HTTP 头
- `AgentIdentity` — Agent identity (用于企业部署)
- `PersonalAccessToken` — 个人访问令牌
- `BedrockApiKey` / `BedrockAccessKeys` — AWS Bedrock 认证

`codex login` 命令触发 OAuth PKCE flow, 启动本地 HTTP server 接收回调, 将 token 存储在 `$CODEX_HOME/auth.json`。`codex logout` 清除存储的凭证。

## 八、会话持久化与压缩

### 8.1 Rollout 持久化

`rollout` crate 实现了会话持久化, 将会话历史写入 JSONL 文件。文件路径为 `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<timestamp>-<thread_id>.jsonl` (按日期分桶), 归档会话移至 `$CODEX_HOME/archived_sessions/`。

`RolloutLine` 是每行的结构:

```rust
pub struct RolloutLine {
    pub timestamp: String,
    pub ordinal: Option<u64>,
    #[serde(flatten)]
    pub item: RolloutItem,
}
```

`RolloutItem` 枚举:

- `SessionMeta` — 会话元数据
- `ResponseItem` — 模型响应项 (带 harness 元数据 envelope)
- `InterAgentCommunication` — Agent 间通信
- `InterAgentCommunicationMetadata` — Agent 间通信元数据
- `Compacted` — 压缩标记
- `TurnContext` — Turn 上下文
- `TokenUsageRecord` — token 用量记录
- `WorldState` — 世界状态快照
- `SecurityRiskScore` — 安全风险评分
- `RetainedContext` — 保留上下文
- `EventMsg` — 事件消息
- `RealtimeItem` — 实时项

`InitialHistory` 枚举描述会话的初始历史状态:

- `New` — 新会话
- `Cleared` — 已清空
- `Resumed(ResumedHistory)` — 从 rollout 恢复
- `Forked(Vec<RolloutItem>)` — 从其他会话 fork

### 8.2 恢复与 Fork

`codex resume` 命令允许恢复之前的会话, 通过 picker 选择或 `--last` 恢复最近会话。`codex fork` 命令允许从历史点 fork 新分支。

恢复时, `rollout` crate 读取 JSONL 文件, 重建 `Vec<RolloutItem>`, 然后 `Session` 从该历史继续。Fork 时, 选中历史被拷贝到新会话文件, 原会话保持不变。

`thread/resume` 与 `thread/fork` app-server 方法提供相同的能力, 供 IDE 与桌面 App 消费。

### 8.3 上下文压缩

`core/src/compact.rs` 实现了上下文压缩, 当会话历史超过 token 限制时自动触发, 或用户通过 `Op::Compact` 手动触发。

压缩策略:

- `CompactionTrigger`: `Auto` (自动) / `Manual` (手动)
- `CompactionReason`: `UserRequested` / `ContextLimit` / `ModelDownshift` / `CompHashChanged`
- `CompactionImplementation`: `Responses` (本地模型摘要) / `ResponsesCompactionV2` (远程压缩)
- `CompactionStrategy`: `Memento` (保留关键信息) / `PrefixCompaction` (前缀压缩)

压缩流程:

1. 运行 pre-compact hooks
2. 发射 `ContextCompaction` turn item started 事件
3. 执行压缩 (模型摘要或 token-budget 截断)
4. 安装新的 context window
5. 发射 `ContextCompaction` turn item completed 事件
6. 运行 post-compact hooks
7. 发射 `EventMsg::ContextCompacted`

Token-budget 压缩 (`compact_token_budget.rs`) 跳过模型摘要, 直接安装新的 context window, 适用于快速截断场景。

远程压缩 (`compact_remote_v2.rs`) 将压缩任务委托给远程服务, 适用于大上下文或需要高质量摘要的场景。

### 8.4 历史项类型

`history` crate 定义了历史项的类型系统:

- `ResponseItemEnvelope` — 模型响应项 + harness 元数据
- `CodexHarnessMetadata` — harness 拥有的元数据 (guardian sources、review ids 等)
- `CompactionCheckpoint` — 压缩检查点
- `RetainedContext` — 保留上下文
- `Heartbeat` — 心跳项

`TurnItem` 枚举 (在 `protocol` crate) 定义了 Turn 内的项类型:

- `AgentMessage` — 模型消息
- `Reasoning` — 推理
- `CommandExecution` — 命令执行
- `FileChange` — 文件变更
- `McpToolCall` — MCP 工具调用
- `WebSearch` — 网页搜索
- `Plan` — 计划 (待办列表)
- `ContextCompaction` — 上下文压缩

## 九、适用场景与边界

### 9.1 适用场景

Codex CLI 适合:

- **本地编码 Agent**: 在开发者机器上运行, 直接访问文件系统与终端
- **CI/CD 自动化**: `codex exec` 提供非交互执行, 适合脚本与流水线
- **IDE 集成**: app-server JSON-RPC 线供 VS Code、Cursor 等 IDE 消费
- **桌面 App**: `codex app` 启动独立桌面应用
- **MCP 生态**: 作为 MCP client 调用外部工具, 作为 MCP server 被其他 Agent 调用
- **企业部署**: 分层配置、MDM 管理、Agent identity 认证

### 9.2 边界与限制

- **单 Task 约束**: 一个 Session 同时最多一个 running task, 并行任务需要多个 Session
- **子进程开销**: TypeScript/Python SDK 通过子进程通信, 有启动与序列化开销
- **平台沙箱差异**: macOS Seatbelt、Linux Landlock、Windows Restricted Token 的能力与粒度不同
- **协议稳定性**: SQ/EQ 是进程内类型, 不是稳定 wire contract; app-server v2 是当前主力协议版本
- **实验性功能**: 多 Agent 协作、实时语音、code-mode 等标记为实验性, 接口可能变动

### 9.3 值得借鉴的工程点

- **单体内核 + 协议化出口**: 内核只写一次, 产品形态通过协议分化, 避免重复实现
- **arg0 多调用二进制**: 单个二进制扮演多个角色, 减少分发复杂度
- **子进程 + JSONL SDK**: SDK 不内嵌内核, 通过子进程通信, 降低绑定复杂度
- **分层配置 + 来源追踪**: 每 key 记录来源层, 支持 UI 展示与冲突检测
- **沙箱升级重试**: 失败时升级沙箱但不重新审批, 平衡安全与体验
- **Starlark 规则引擎**: 用 Starlark 定义执行策略, 比 JSON/YAML 更表达力强
- **预计算协议导出**: TypeScript/JSON Schema 预计算并压缩存储, 避免运行时开销
