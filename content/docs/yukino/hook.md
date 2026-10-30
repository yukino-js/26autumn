---
title: "Hook"
description: "Hook: 在生命周期事件上挂载自动化动作 (事件/条件/动作三要素) — 写文件后自动 format、危险命令执行前拦截、会话开始时注入项目约定; 配置只来自 `~/.yukino/config.yaml` 顶层 hooks 数组"
local_path: "$HOME/github/yukino-code/apps/yukino"
local_commit: "bef5439b54e6510a12da61bcfa4285ecb1cd2192"
---

在 Agent 的生命周期事件上挂载自动化动作: 写文件后自动 format, 危险命令执行前直接拦截, 会话开始时注入项目约定

## Hook 的三要素

- 事件: 挂在哪个生命周期点上
- 条件: 可以省略, 省略则无条件触发
- 动作: 触发后做什么

配置只来自用户全局配置文件 `~/.yukino/config.yaml` 的顶层 `hooks` 数组, 没有项目级 hook 配置 — hook 的 command 动作可以执行任意 shell 命令, 项目级配置意味着 clone 一个仓库就获得了任意代码执行入口

```yaml
hooks:
  - event: post_tool_use
    condition: tool === "WriteFile"
    action:
      type: command
      command: "prettier -w $YUKINO_FILE_PATH"
```

每当 Agent 调用 WriteFile 工具写文件后, 自动 format 代码:

- 事件: post_tool_use
- 条件: tool === "WriteFile"
- 动作: 执行 `prettier -w` 格式化刚写入的文件

一个事件有多个 hook 时, 按 yaml 数组中的顺序逐个执行 (`HookEngine.fire` 顺序遍历, 源码: src/hooks/index.ts)

## 配置结构

单个 hook 的字段 (HookConfigSchema, src/config/index.ts):

| 字段        | 类型          | 说明                                                    |
| ----------- | ------------- | ------------------------------------------------------- |
| `id`        | string, 可选  | hook 标识, 用作 once 槽位 key 和校验错误的定位信息      |
| `event`     | string        | 事件名, 必须是 9 个事件之一                             |
| `condition` | string, 可选  | JS 表达式, 省略则无条件触发                             |
| `action`    | object        | 动作: `type` 加类型特有字段 (command/url/method/prompt) |
| `reject`    | boolean, 可选 | 拒绝工具调用, 只对 pre_tool_use 有拦截语义              |
| `once`      | boolean, 可选 | 每个会话只执行一次                                      |
| `async`     | boolean, 可选 | 后台执行, 不阻塞主流程                                  |
| `on_error`  | string, 可选  | 执行失败时的行为: ignore (默认) / fail / reject         |

## 事件

9 个事件 (EventName, src/hooks/index.ts), 触发点都在 Agent 主循环 (src/agent/index.ts)

### 会话级

- session_start: agent loop 的 run() 启动时触发一次, 在进入主循环之前
- session_end: run() 结束时触发, 位于外层 finally 块, 用户中断或抛错也会触发

### Agent Loop 轮次级

轮次即 [Agent Loop](./react-and-agent-loop) 主循环的一次迭代, 对应一次 LLM API 请求和随后的工具执行

- turn_start: 每轮开始时触发, 发起 LLM API 请求前
- turn_end: 每轮结束时触发, 位于该轮的 finally 块

### 消息级

- pre_send: 紧跟 turn_start 触发, 在本轮发起 LLM API 请求前
- post_receive: 收到 LLM API 完整响应后触发, message 变量携带回复全文

### 工具级

- pre_tool_use: 工具执行前触发, 在权限检查之前; 配合 reject 可以拦截工具调用
- post_tool_use: 工具执行完成后触发, message 变量携带工具输出; MCP dispatch 模式的路由调用 (McpCallTool) 会对内层目标工具和外层工具各触发一次 (pre_tool_use 同样对两者分别触发)

### 系统级

- shutdown: 已定义且能通过校验, 当前没有触发点, 预留

### 生效范围

HookEngine 只在两处创建: 交互式 UI (src/ui/app.tsx) 和 remote 的 createRemoteAgent (src/remote/server.ts); ACP 与 A2A 复用 createRemoteAgent (见 [acp](./acp) 和 [a2a](./a2a)), 因此同样生效

- print 模式不创建 HookEngine, hook 不生效 (见 [print-mode](./print-mode))
- subagent 不创建 HookEngine, hook 只作用于主 Agent 的循环 (见 [subagent](./subagent))
- remote 的 MCP Apps 工具调用在执行前也会走 firePreToolHooks (src/remote/mcp-apps.ts)

## 条件

condition 是一个 JavaScript 表达式, 使用 `new Function` 在 strict mode 下编译: 5 个作用域变量作为函数形参, 函数体是 `"use strict"; return (表达式);`, 求值结果经 Boolean 转换, truthy 时触发 hook

| 变量       | 类型   | 值                                                 |
| ---------- | ------ | -------------------------------------------------- |
| `event`    | string | 事件名, 例如 pre_tool_use                          |
| `tool`     | string | 工具名, 非工具事件是 ""                            |
| `filePath` | string | 工具参数中的 file_path, 没有则取 path, 都没有是 "" |
| `message`  | string | 事件消息, 没有时是 ""                              |
| `args`     | object | 工具参数字典, 例如 args.command, 非工具事件是 {}   |

示例

```yaml
condition: 'tool === "EditFile"'
condition: '["EditFile", "WriteFile", "Bash"].includes(tool)'
condition: '/\.ts$/.test(filePath)'
condition: 'event.endsWith("tool_use") && !tool.startsWith("Read")'
condition: 'args.command.includes("rm ")'
```

- 编译失败 (语法错误) 或求值抛错 (拼错方法名、访问未定义变量): 记日志并按 false 处理, hook 被跳过, 不中断 Agent
- 为什么直接用 JS 表达式而不是自定义 DSL: 配置文件本来就能通过 command 动作执行任意 shell, 同源表达式不增加新的权限面, 而自定义 DSL 需要独立的解析器、转义规则和文档

## 动作

action.type 四种取值, 对应 HookEngine.executeAction 里的四个执行分支

### command

```yaml
action:
  type: command
  command: "prettier -w $YUKINO_FILE_PATH"
```

- 基于 node:child_process 的 exec; POSIX 上强制使用 bash 执行, Windows 上使用 Node 默认 shell (ComSpec/cmd), 因为 Windows 不保证装有 bash
- 超时 30s (HOOK_TIMEOUT_MS), 输出缓冲上限 10MB (HOOK_MAX_BUFFER_BYTES), 两个常量在 src/hooks/constants.ts
- 工作目录是会话的 workDir; 会话的 abortSignal 接入 exec, 用户中断时命令随之终止
- 执行环境是完整的 process.env, 额外注入 YUKINO_EVENT, YUKINO_TOOL, YUKINO_FILE_PATH 三个环境变量
- stdout trim 后作为 hook 输出; 非零退出码或超时按执行失败处理 (走 on_error 语义)
- 输出进入通知队列, 在下一轮 drain 时用 `<system-reminder>` 标签包裹注入对话历史, LLM 可以读到

### prompt

```yaml
action:
  type: prompt
  prompt: 先阅读 ARCHITECTURE.md 了解项目架构, 再开始工作
```

- prompt 原文作为 hook 输出, 和 command 的 stdout 走同一条注入通道: `<system-reminder>` 标签包裹, 以 user 消息追加到对话历史
- system prompt 不变、prompt cache 前缀不变 (见 [system-prompt](./system-prompt))
- 配合执行控制 `once: true` 可以只在会话中注入一次

### http

```yaml
action:
  type: http
  url: https://api.example.com
  method: POST
```

- method 默认 POST, 会被统一转大写; header 固定 `Content-Type: application/json`
- 请求体是 HookContext 的 json 字符串 (event, toolName, args, filePath, message 字段, undefined 字段被 JSON.stringify 省略); GET/HEAD 不带 body
- 超时 30s: `AbortSignal.timeout(HOOK_TIMEOUT_MS)`, 存在会话 abortSignal 时用 `AbortSignal.any` 合并, 中断和超时都能终止请求
- 非 2xx 响应抛错 `HTTP hook failed with status <状态码>` (按 on_error 处理); hook 输出是响应文本
- 场景: 发送 App 通知、日志收集、监控报警

### agent

```yaml
action:
  type: agent
  prompt: "review 刚刚写入的文件是否有安全漏洞"
```

保留给未来的 hook runner: HookEngine 上有可注入的 agentRunner 扩展点, 但没有任何宿主注册它, 配置校验直接报错 `action.type "agent" is not supported yet — use "command" or "prompt" instead`, 该类型当前不可用

## pre_tool_use 拦截

```yaml
hooks:
  - event: pre_tool_use
    condition: 'tool === "WriteFile" && filePath.endsWith("pnpm-lock.yaml")'
    action:
      type: command
      command: "echo 'Never manually edit pnpm-lock.yaml'"
    reject: true
```

- reject: true 且动作执行成功时, 工具调用被拒绝, 不执行; hook 的输出作为拒绝理由, Agent 将其包装为工具调用结果 `Rejected by hook: <reason>` (isError: true) 返回给 LLM, LLM 在下一轮调整策略
- 拦截发生在权限检查之前 (见 [permission](./permission)): 被 hook 拒绝的调用不会再进入权限弹窗
- 某个 hook 拒绝后, 该事件的后续 hook 不再执行 (fire 循环 break)
- reject 只对 pre_tool_use 有拦截语义; 其他事件的 hook 配置 reject 会被忽略, 输出仍然作为通知注入
- pre_tool_use 的动作默认同步执行 (async 缺省或 false), 阻塞等待返回值, 检查是否拒绝
- on_error: "reject" 时, 动作执行失败也视为拒绝 (同样只在 pre_tool_use 拦截)
- firePreToolHooks 返回第一个拒绝结果的输出作为理由; 拒绝之前的其他 hook 输出照常进入通知队列

## hook 执行控制

### once

- 每个会话只执行一次; slot key 是 `id:<hook的id>`, 没有 id 时用 `index:<数组下标>`
- 执行前先占位, 执行失败时释放 slot (同步和异步路径都释放): 出错的 once-hook 不算 "已执行", 下一次匹配的事件可以重试

### async

- 后台执行, 不阻塞主流程, fire 循环立即处理下一个 hook
- 成功时输出进入通知队列, 在下一轮注入
- 失败时记日志、释放 once slot; on_error 不是 ignore 时, 输出加 `Async hook error:` 前缀进入通知队列
- reject 和 async 互斥 (校验报错): 异步 hook 的结果无法同步拦截工具调用

### on_error

hook 执行失败时的行为, 默认 ignore:

- ignore: 只记日志
- fail: 追加一条失败结果, 输出 `Hook error: ...` 进入通知队列反馈给 LLM
- reject: 视为拒绝, 输出 `Hook error (rejecting): ...`; 在 pre_tool_use 上拦截工具调用并结束该事件的 hook 循环

错误捕获的总原则: hook 执行错误不能中断 Agent, 所有异常都在 fire 内被捕获并转为日志或通知

```yaml
hooks:
  - event: session_start
    action:
      type: prompt
      prompt: "使用英文注释"
    once: true

  - event: post_tool_use
    condition: tool === "WriteFile"
    action:
      type: http
      url: https://api.example.com
      method: POST
    async: true
```

## 通知的注入时机

hook 输出统一进入通知队列 (recordNotification, 空输出被丢弃), 注入路径:

- agent loop 在每轮开始时 (turn_start 之前) drain 队列, 逐条用 `<system-reminder>` 标签包裹, 以 user 消息追加到对话历史并持久化到会话文件; 内容中嵌套的 system-reminder 标签会被转义, 保证包裹边界不混淆
- turn_start 和 pre_send 触发完后立即补一次 drain, 保证这两个事件的输出能进入本轮的同一个 LLM API 请求
- post_tool_use、turn_end 的输出等到下一轮 drain; session_end 的输出在本次 run 结束后留在队列里, 同一会话的下一次 run 首轮可见 (交互式 UI 和 remote 中 HookEngine 都是会话级实例, 跨 run 存活)

## 上下文变量

事件触发时创建一个 HookContext 对象, 包含事件的上下文信息, 同时服务于条件求值和 http 请求体:

| 字段       | command 动作的环境变量 | 内容                                                        |
| ---------- | ---------------------- | ----------------------------------------------------------- |
| `event`    | `$YUKINO_EVENT`        | 事件名                                                      |
| `toolName` | `$YUKINO_TOOL`         | 工具名, 非工具事件为空                                      |
| `args`     | -                      | 工具参数字典                                                |
| `filePath` | `$YUKINO_FILE_PATH`    | args 中的 file_path, 没有则取 path                          |
| `message`  | -                      | 事件消息: post_receive 是回复全文, post_tool_use 是工具输出 |

## 示例配置

```yaml
hooks:
  - id: auto-format
    event: post_tool_use
    condition: 'tool === "WriteFile" && /\.ts$/.test(filePath)'
    action:
      type: command
      command: "prettier -w $YUKINO_FILE_PATH"

  - id: readonly-vendor
    event: pre_tool_use
    condition: 'tool === "WriteFile" && filePath.includes("node_modules/")'
    action:
      type: command
      command: "echo 'Never manually edit node_modules/*'"
    reject: true

  - id: project-context
    event: session_start
    action:
      type: prompt
      prompt: |
        - Tech Stack: TypeScript, React, Ink, Zod, Vitest, ESLint, oxfmt.
        - Code Conventions: Enforced by `eslint.config.js`.
    once: true

  - id: block-dangerous-rm
    event: pre_tool_use
    condition: 'tool === "Bash" && /rm\s+-rf\s+\//.test(args.command)'
    action:
      type: command
      command: "echo 'Dangerous rm command detected'"
    reject: true

  - id: app-notify
    event: post_tool_use
    condition: tool === "WriteFile"
    action:
      type: http
      url: https://api.example.com
      method: POST
    async: true
```

## 配置校验

启动时 validate 全部 hook 配置 (src/hooks/index.ts), 校验失败抛错阻断启动, 两个调用点:

- 交互式 UI: 初始化 LLM 客户端前 (src/ui/app.tsx)
- remote 的 createRemoteAgent: 创建 agent handle 时 (src/remote/server.ts), [acp](./acp) 和 [a2a](./a2a) 共用这个入口

校验规则:

- event 必填, 且必须是 9 个事件之一
- action.type 必填, 且必须是 command / prompt / http / agent 之一
- command 动作必须有非空 command 字段
- prompt 动作必须有非空 prompt 字段
- http 动作必须有非空 url 字段
- agent 动作无条件拒绝 (not supported yet)
- reject 和 async 互斥

所有错误一次性收集, 用 `; ` 拼接成一条 Error 抛出, 每条带 `hook[i]` 或 `hook[i] (id="...")` 前缀定位
