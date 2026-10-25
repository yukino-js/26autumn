---
title: "What is an Agent"
---

agent 是 LLM 在循环中根据环境反馈自主使用工具的系统

- LLM 是大脑, 负责理解和思考
- 循环: 意味着不是一次性问答就结束, 做一步操作, 拿到结果, 再决定下一步
- 反馈: agent 每做一步操作, 都能拿到结果, 这些反馈驱动下一轮决策
  - 执行一条命令, 拿到输出
  - 读一个文件, 拿到内容
  - 跑一个测试, 拿到错误信息
- 自主使用工具: agent 自主判断使用什么工具, 是读文件还是写文件, 是 grep 搜索代码还是执行 shell 命令

## Yukino

Yukino 是一个基于终端的 AI coding agent: 单一 CLI 二进制, 连接可配置的 LLM provider (Anthropic、OpenAI 或任意 OpenAI 兼容端点), 用 React + Ink 渲染终端 UI; 除了交互式使用, 还支持脚本化、浏览器、编辑器、agent 互通等形态

## 5 层架构

1. 交互层: 终端 TUI、slash command、skill、浏览器前端 (remote)、编辑器 (ACP)
2. 引擎层: 对话管理、agent loop、system prompt、上下文压缩
3. 工具层: 内置工具、MCP、hook
4. 记忆层: context window、会话持久化、文件历史、自动记忆
5. 安全层: 权限、OS 沙箱、HITL (Human-in-the-Loop)

## 6 种运行模式

同一个 agent 内核 (Agent loop + 工具 + 会话), 六种宿主形态 (入口: src/main.tsx 的 runMode, 旗标在 src/cli.ts 解析为 typed CliMode):

| 模式            | 旗标              | 形态                                       |
| --------------- | ----------------- | ------------------------------------------ |
| 交互式          | (默认)            | 终端 TUI, 流式输出、权限对话框、slash 命令 |
| print           | `-p "..."`        | 非交互, 一次执行, 适合脚本和 CI            |
| remote          | `--remote [addr]` | HTTP + WebSocket, 浏览器聊天 UI            |
| ACP (stdio)     | `--acp`           | 编辑器集成 (Agent Client Protocol)         |
| ACP (WebSocket) | `--acp-ws [addr]` | 同上, 经 WebSocket 传输                    |
| A2A             | `--a2a [addr]`    | agent 互通服务器 (Agent2Agent Protocol)    |

agent team 的 teammate 不再是独立的 CLI 模式: 它经 Agent 工具的 `kind: "teammate"` 在同一进程内派生 (见 agent-team), 没有 `--teammate` 旗标

## 文档地图

- 核心循环: react-and-agent-loop (ReAct 与循环机制)、llm (三种协议的封装)、function-calling (工具抽象与内置工具)、system-prompt (prompt 工程)
- 扩展能力: mcp (动态工具接入)、hook (生命周期事件)、skills (可移植 SOP)、slash-command (命令系统)、lsp (语言服务器集成)、WebFetch (联网抓取, 见 function-calling)
- 记忆与上下文: context-compaction (两层压缩)、agents-md-and-memory (指令文件、会话持久化、自动记忆、文件历史)
- 任务与目标: task-tracking (任务板与后台任务)、goal (持久目标与自动续跑)、workflow (脚本编排多 subagent)
- 多 agent: subagent (主从委派)、agent-team (团队协作与 coordinator 模式)、worktree (文件系统隔离)、workflow (后台并发编排)
- 安全: permission (权限系统)、sandbox (OS 级沙箱)
- 对外集成: a2a、acp、remote、print-mode、telemetry (可观测性)
- 交互: terminal-ui (终端 TUI 交互: 原生滚动、用户 Bash、快捷键)
- 质量: code-review (/review 命令与 review 角色)

Yukino 以 npm 包发布 (`npm install -g @yukino.js/yukino`), 支持 `yukino update` 自更新到最新发布版; TUI 异步检查新版本并提示

## AI Coding 工作流

agent 驱动的开发流程中常见的制品:

- spec.md 需求文档
- plan.md 技术方案 (Yukino 的 plan 模式把方案写入 plan 文件, 经用户审批后执行, 见 react-and-agent-loop)
- task.md、checklist.md 任务清单 (Yukino 的共享任务板见 agent-team)
