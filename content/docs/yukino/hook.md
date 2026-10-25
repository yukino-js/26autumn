---
title: "Hook"
---

在 Agent 的生命周期事件上挂载自动化动作

## Hook 的三要素

- 事件
- 条件, 可以省略, 如果省略则无条件触发
- 动作

配置只来自用户全局配置文件 `~/.yukino/config.yaml` 的顶层 `hooks` 数组, 没有项目级 hook 配置 (hook 的 command 动作可以执行任意 shell 命令, 项目级配置意味着 clone 一个仓库就获得了任意代码执行入口)

```yaml
hooks:
  - event: post_tool_use
    condition: tool === "WriteFile"
    action:
      type: command
      command: "prettier -w $YUKINO_FILE_PATH"
```

每当 Agent 调用 WriteFile 工具写文件后, 自动 format 代码

- 事件: post_tool_use
- 条件: tool === "WriteFile"
- 动作: format 代码

一个事件有多个 hook 时, 按 yaml 中的顺序逐个执行

## 事件

9 个事件 (源码: src/hooks/index.ts)

### 会话级

- session_start agent loop 启动时触发
- session_end agent loop 结束时触发 (finally 块, 中断也会触发)

### Agent Loop 轮次级

- turn_start 每轮 agent loop turn 开始, 发起 LLM API 请求前触发
- turn_end 每轮 agent loop turn 结束触发

### 消息级

- pre_send 用户消息发送给 LLM API 前触发 (紧跟 turn_start)
- post_receive 收到 LLM API 响应后触发, message 变量携带完整的回复文本

### 工具级

- pre_tool_use 工具调用前触发, 可以拦截工具调用
- post_tool_use 工具调用后触发, message 变量携带工具输出

### 系统级

- shutdown Yukino 退出时触发 (已定义, 当前版本没有触发点, 预留)

> print 模式不创建 HookEngine, hook 只在交互式 UI、remote、ACP、A2A 模式下生效

## 条件

condition 是一个 JavaScript 表达式, 使用 `new Function` 在 strict mode 下编译, 求值结果为 truthy 时触发 hook

作用域内的 5 个变量

| 变量       | 类型   | 值                                       |
| ---------- | ------ | ---------------------------------------- |
| `event`    | string | 事件名, 例如 pre_tool_use                |
| `tool`     | string | 工具名, 非工具事件是 ""                  |
| `filePath` | string | 工具参数中的 file_path/path, 没有时是 "" |
| `message`  | string | 事件消息, 没有时是 ""                    |
| `args`     | object | 工具参数字典, 例如 args.command          |

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

四种动作执行器

- command: 执行 shell 命令
- prompt: 注入静态文本
- http: 发送 http 请求
- agent: 启动 subagent (保留字段, 当前版本配置校验直接拒绝)

### command

```yaml
action:
  type: command
  command: "prettier -w $YUKINO_FILE_PATH"
```

- POSIX 上强制使用 bash 执行, Windows 上使用 Node 默认 shell (ComSpec/cmd)
- 超时 30s, 输出缓冲上限 10MB, 工作目录是会话的 workDir
- 执行前注入环境变量 YUKINO_EVENT, YUKINO_TOOL, YUKINO_FILE_PATH
- stdout trim 后作为 hook 输出, 在下一轮 agent loop turn 开始时作为 `<system-reminder />` 注入对话历史, LLM 可以读到

### prompt

```yaml
action:
  type: prompt
  prompt: 先阅读 ARCHITECTURE.md 了解项目架构, 再开始工作
```

- prompt 原文作为 hook 输出, 和 command 的 stdout 走同一条注入通道: `<system-reminder />` 标签包裹, 追加到对话历史
- system prompt 不变、prompt cache 前缀不变
- 配合执行控制 `once: true` 可以只在会话中注入一次

### http

```yaml
action:
  type: http
  url: https://api.example.com
  method: POST
```

- method 默认 POST; header 固定 `Content-Type: application/json`
- 请求体是 HookContext 的 json 字符串 (event, toolName, args, filePath, message 字段), GET/HEAD 不带 body
- 超时 30s; 非 2xx 响应抛错 (按 on_error 处理); hook 输出是响应文本
- 场景: 发送 App 通知、日志收集、监控报警

### agent

```yaml
action:
  type: agent
  prompt: "review 刚刚写入的文件是否有安全漏洞"
```

保留给未来的 hook runner, 当前版本配置校验直接报错: `action.type "agent" is not supported yet — use "command" or "prompt" instead`

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

- reject: true 时, 工具调用被拒绝, 不执行; hook 的输出作为拒绝理由, CLI 将其包装为工具调用结果 `Rejected by hook: <reason>` (isError: true) 返回给 LLM, LLM 在下一轮调整策略
- reject 只对 pre_tool_use 有拦截语义; 其他事件的 hook 配置 reject 会被忽略 (输出仍然作为通知注入)
- pre_tool_use 的动作默认同步执行 (async: false), 阻塞等待返回值, 检查是否拒绝
- on_error: "reject" 时, 动作执行失败也视为拒绝 (同样只在 pre_tool_use 拦截)

## hook 执行控制

- once: 每个会话只执行一次; slot key 是 hook 的 id (缺省用数组下标); 执行前先占位, 执行失败时释放 slot, 下一次匹配的事件可以重试
- async: 后台执行, 不阻塞主流程; 成功时输出作为通知在下一轮注入; 失败时输出加 `Async hook error:` 前缀; reject 和 async 互斥 (校验报错)
- on_error: hook 执行失败时的行为, 枚举值:
  - ignore: 默认, 只记日志
  - fail: 追加一条失败结果, 输出 `Hook error: ...` 反馈给 LLM
  - reject: 视为拒绝 (pre_tool_use 时拦截工具调用), 输出 `Hook error (rejecting): ...`
- 错误捕获: hook 执行错误不能中断 Agent

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

hook 输出统一进入通知队列, agent loop 在每轮开始时 drain 队列, 逐条包装为 `<system-reminder />` 注入对话历史; turn_start 和 pre_send 的输出会在本轮发起 LLM API 请求前立即补一次 drain, 保证同轮可见

## 上下文变量

事件触发时, 创建一个 HookContext 对象, 包含事件的上下文信息:

- event 事件名 $YUKINO_EVENT
- toolName 工具名 $YUKINO_TOOL
- args 工具参数字典
- filePath 文件路径 $YUKINO_FILE_PATH
- message 消息内容

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

启动时 validate 全部 hook 配置, 校验失败抛错阻断启动 (交互式 UI 和 remote 模式)

- event 必须是 9 个事件之一
- reject 和 async 互斥
- command 动作必须有非空 command 字段
- prompt 动作必须有非空 prompt 字段
- http 动作必须有非空 url 字段
- agent 动作直接拒绝 (not supported yet)
