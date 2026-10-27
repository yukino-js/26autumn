---
title: "What is an Agent"
---

agent 是 LLM 在循环中根据环境反馈自主使用工具的系统。拆开这句话:

- **LLM 是大脑**: 理解任务意图、拆解步骤、决定下一步调用哪个工具, 这些判断由模型完成, 不由硬编码的流程完成
- **循环**: 不是一次性问答就结束, 而是做一步操作、拿到结果、再决定下一步, 直到任务完成或没有更多动作可做
- **反馈**: agent 每做一步操作都能拿到结果, 这些结果驱动下一轮决策 —— 执行一条命令拿到输出和退出码, 读一个文件拿到内容, 跑一个测试拿到错误信息
- **自主使用工具**: 用哪个工具由模型自行判断 —— 是读文件还是写文件, 是 Grep 搜索代码还是执行 shell 命令, 循环本身不预设路径

## Yukino

Yukino 是一个基于终端的 AI coding agent: 以 npm 包 `@yukino.js/yukino` 发布, 只有一个 bin 入口 `yukino` (package.json 的 `bin` 指向 `dist/main.js`, 由 `src/cli.ts` 构建), 要求 Node >= 20。它连接可配置的 LLM provider, 用 React + Ink 渲染终端 UI, 在单个面板里提供流式输出、工具执行反馈、权限对话框和 slash 命令; 除了交互式使用, 还支持脚本化、浏览器、编辑器、agent 互通等宿主形态。

provider 在 `~/.yukino/config.yaml` 的 `providers` 列表中配置, 支持三种协议 (`protocol` 字段):

| protocol        | 对接的 LLM API              | 客户端 (src/llm/)    |
| --------------- | --------------------------- | -------------------- |
| `anthropic`     | Anthropic Messages API      | `AnthropicClient`    |
| `openai`        | OpenAI Responses API        | `OpenAIClient`       |
| `openai-compat` | OpenAI Chat Completions API | `OpenAICompatClient` |

API key 取 provider 的 `api_key` 字段, 缺省时回落到环境变量 (`anthropic` → `ANTHROPIC_API_KEY`, `openai` 与 `openai-compat` → `OPENAI_API_KEY`)。`createClient()` 按协议懒加载对应 SDK, 三个客户端实现同一个 `LLMClient` 接口: 把 `ConversationManager` 里的对话历史翻译成协议请求, 把各家返回的流统一映射成内部 `StreamEvent` 事件流。同一份配置里可以放多个 provider, `default_provider` 指定启动时选中的下标。

## 核心循环

循环在代码里是 `src/agent/index.ts` 的 `Agent.run()` —— 一个产出 `AgentEvent` 的异步生成器。每一轮 (iteration) 做四件事:

1. 把对话历史交给 `LLMClient.stream()` 流式请求模型, 收集文本、thinking 块和工具调用
2. 工具调用经权限系统检查 (允许、拒绝或弹 HITL 对话框), 通过 `StreamingExecutor` 分批执行
3. 工具结果写回对话历史, 成为下一轮的观察输入; 单条结果超过 `MAX_OUTPUT_CHARS` (50000) 字符时落盘, 只在历史里留预览加文件路径
4. 当模型不再发出工具调用 (stop reason 为 `end_turn` / `stop`), 循环结束, 产出 `loop_complete` 事件

循环里同时处理各种自愈逻辑: 输出撞上 max_tokens 时上调输出上限并做最多 `MAX_TOKENS_RECOVERIES` (3) 次续写恢复, 上下文逼近窗口时触发压缩, 瞬态错误按有界重试重发。循环还接受运行中的转向: `steer()` 把用户消息排入队列, 在轮边界 (当前轮工具结果之后、下一次 LLM 调用之前) 注入对话, 不必等整个 run 结束。机制细节见 [react-and-agent-loop](./react-and-agent-loop)。

## 5 层架构

按 src/ 目录的职责划分:

1. **交互层** —— 终端 TUI (`src/ui/`, Ink 渲染、流式输出、权限对话框、快捷键)、slash 命令 (`src/commands/`, `/compact` `/review` `/rewind` `/mcp` 等内置命令加自定义 prompt 模板)、skill (`src/skills/`, 以 `SKILL.md` 声明的可移植 SOP)、浏览器前端 (`src/remote/browser/`, React 实现)、编辑器集成 (`src/acp/`, Agent Client Protocol)
2. **引擎层** —— 对话管理 (`src/conversation/` 的 `ConversationManager`)、agent loop (`src/agent/` 的 `Agent.run()`)、system prompt 组装 (`src/prompt/`)、上下文压缩 (`src/compact/`)
3. **工具层** —— 内置工具 (`src/tools/`, 在 `src/bootstrap/tool-registry.ts` 统一注册)、MCP 动态工具 (`src/mcp/`, 工具名带 `mcp__` 前缀)、hook 生命周期 (`src/hooks/`, `session_start` / `turn_start` / `pre_tool_use` / `post_tool_use` 等 9 个事件)
4. **记忆层** —— 上下文窗口管理 (`src/compact/`)、会话持久化 (`src/session/`, JSONL 存到 `~/.yukino/sessions/` 下按 cwd 哈希分目录)、文件历史与回滚 (`src/file-history/`)、自动记忆 (`src/memory/`, `MEMORY.md` 索引与后台抽取)
5. **安全层** —— 权限系统 (`src/permissions/`, `default` / `acceptEdits` / `plan` / `bypassPermissions` 四种模式加 allow/deny 规则)、OS 沙箱 (`src/sandbox/`, macOS 用 seatbelt、Linux 用 bubblewrap 包裹 shell 命令)、HITL (权限对话框与 `AskUserQuestion` 工具)

## 6 种运行模式

同一个 agent 内核 (Agent loop + 工具 + 会话) 装在六种宿主里。入口是 `src/main.tsx` 的 `runMode()`, 旗标在 `src/cli.ts` 的 `parseCliArgs()` 里解析为 typed `CliMode`; 模式之间互斥, 组合使用会报用法错误:

| 模式            | 旗标              | 形态                                                                                                   |
| --------------- | ----------------- | ------------------------------------------------------------------------------------------------------ |
| 交互式          | (默认)            | 终端 TUI: 流式输出、权限对话框、slash 命令; `--resume [session-id]` 恢复历史会话, 省略 id 时打开选择器 |
| print           | `-p <prompt>`     | 非交互一次执行, 结果打印到 stdout; `--output-format` 取 `text` (默认) 或 `stream-json`, 适合脚本和 CI  |
| remote          | `--remote [addr]` | Express HTTP + WebSocket 服务器 (默认 `127.0.0.1:18888`), 托管浏览器聊天 UI                            |
| ACP (stdio)     | `--acp`           | 经 stdio 服务 Agent Client Protocol, 供编辑器集成                                                      |
| ACP (WebSocket) | `--acp-ws [addr]` | 同上, 经 WebSocket 传输 (默认 `127.0.0.1:18889`)                                                       |
| A2A             | `--a2a [addr]`    | Agent2Agent Protocol 服务器 (默认 `127.0.0.1:18890`), 供 agent 互通                                    |

`-h` / `--help`、`-v` / `--version` 和 `yukino update [--tag <tag>]` 是维护命令, 不加载运行时。agent team 的 teammate 不是独立的 CLI 模式: 它经 `Agent` 工具的 `kind: "teammate"` (也是默认值) 在同一进程内派生, 没有 `--teammate` 旗标, 见 [agent-team](./agent-team)。

## 内置工具概览

`createToolRegistry()` 注册常驻工具, `Agent`、`Workflow` 与团队协作类工具由宿主模式 (UI / print / remote 等) 按需追加。按用途分组 (完整参数与行为见 [function-calling](./function-calling)):

- **文件**: `ReadFile` `WriteFile` `EditFile` `Glob` `Grep`
- **执行**: `Bash` `PowerShell`, 长任务可转后台, `TaskOutput` 取后台任务输出
- **网络**: `WebFetch` 抓取网页
- **代码智能**: `LSP` (语言服务器诊断、引用等)
- **规划与任务**: `EnterPlanMode` / `ExitPlanMode` (plan 模式只读, 方案经审批后执行)、`Goal` (持久目标)、`TodoWrite` (任务清单, 团队模式下换用共享任务板版本)
- **多 agent**: `Agent` (派生 subagent / teammate)、`Workflow` (脚本编排)、`TeamCreate` / `TeamList` / `SendMessage` / `TeamDelete` / `TaskStop`
- **上下文与扩展**: `ToolSearch` / `McpCall` (按需发现和调用 MCP 工具)、`LoadSkill` / `InstallSkill`、`AskUserQuestion`、`EnterWorktree` / `ExitWorktree` (git worktree 隔离)、`ComputerUse`、`SyntheticOutput`

## 文档地图

- 核心循环: [react-and-agent-loop](./react-and-agent-loop) (ReAct 范式与循环机制)、[llm](./llm) (三种协议的封装)、[function-calling](./function-calling) (工具抽象与内置工具)、[system-prompt](./system-prompt) (prompt 工程)
- 扩展能力: [mcp](./mcp) (动态工具接入)、[hook](./hook) (生命周期事件)、[skills](./skills) (可移植 SOP)、[slash-command](./slash-command) (命令系统)、[lsp](./lsp) (语言服务器集成)
- 记忆与上下文: [context-compaction](./context-compaction) (自动与手动压缩)、[agents-md-and-memory](./agents-md-and-memory) (AGENTS.md 指令文件、会话持久化、自动记忆、文件历史)
- 任务与目标: [task-tracking](./task-tracking) (任务板与后台任务)、[goal](./goal) (持久目标与自动续跑)、[workflow](./workflow) (脚本编排多 subagent)
- 多 agent: [subagent](./subagent) (主从委派)、[agent-team](./agent-team) (团队协作与 coordinator 模式)、[worktree](./worktree) (文件系统隔离)
- 安全: [permission](./permission) (权限系统)、[sandbox](./sandbox) (OS 级沙箱)
- 对外集成: [a2a](./a2a)、[acp](./acp)、[remote](./remote)、[print-mode](./print-mode)、[telemetry](./telemetry) (可观测性)
- 交互: [terminal-ui](./terminal-ui) (终端 TUI: 原生滚动、用户 Bash、快捷键)
- 质量: [code-review](./code-review) (/review 命令与 review 角色)

## 分发与更新

`npm install -g @yukino.js/yukino` 全局安装后, `yukino update` 检查 npm dist-tag (默认 `latest`, `--tag` 可指定 canary 等) 并自更新到更高版本; 版本相同或更低时不做任何操作。TUI 启动时经 `checkForUpdate()` 异步检查新版本, 有可用更新时给出提示, 网络错误不打断界面。

## Agent 驱动开发中的制品

Yukino 的循环围绕几类一等公民制品组织工作:

- **plan 文件**: plan 模式 (`permissionMode` 为 `plan`, 只读) 下模型把技术方案写入 `~/.yukino/plans/` 的 markdown 文件, `ExitPlanMode` 提交方案, 经用户审批后进入执行
- **任务清单**: `TodoWrite` 维护当前会话的任务列表; 团队模式下改用共享任务板 (JSON 文件, 文件锁保护, 支持跨进程 teammate 并发读写), 见 [task-tracking](./task-tracking)
- **持久目标**: `Goal` 工具设定带 token 预算的目标, 循环结束后若目标未完成可自动续跑, 见 [goal](./goal)
