---
title: "ACP"
---

ACP (Agent Client Protocol) 是编辑器与外部 agent 之间的集成协议: 编辑器作为 ACP 客户端拉起一个 agent 进程, 通过 JSON-RPC 驱动它完成初始化、会话、提示词、权限确认等交互

如果说 MCP 解决「agent 接入工具」, 那 ACP 解决的就是「编辑器接入 agent」: 在 `--acp` 模式下, Yukino 把自己实现成一个 ACP agent, 供 ACP 兼容的编辑器 (例如 Zed) 拉起并驱动

## 启动与传输

```bash
yukino --acp            # stdio 传输 (服务端模式, 不能与其他模式旗标组合)
yukino --acp-ws         # WebSocket 传输, 默认监听 127.0.0.1:18889
yukino --acp-ws 9000    # 自定义端口 (裸数字视为端口; host:port / [IPv6]:port 也可以)
yukino --acp-ws 0       # 端口 0 由 OS 分配, 实际可达地址打印到 stderr
```

两种传输背后是同一套 agent 实现 (`src/acp/agent.ts` 的 `YukinoAcpAgent`), 由 `createYukinoAcpApp` 装配成 `AgentApp` 后挂到不同的通道上:

- **stdio 传输** (`--acp`, `runAcpStdio`): 编辑器把 Yukino 作为子进程启动, 经 stdin/stdout 通信。消息以 NDJSON (逐行 JSON) 帧承载 JSON-RPC。启动时会把 `console.log/info/warn/debug` 全部重定向到 stderr, 保证 stdout 上只有协议帧, 日志不会污染协议流。这是编辑器的标准接入方式。
- **WebSocket 传输** (`--acp-ws`, `runAcpWebSocket`): 独立监听一个 HTTP 端口, WebSocket 升级路径固定为 `/acp`, 非 `/acp` 的请求返回 404。地址解析与 [remote](./remote) 共用 `parseRemoteAddress`: 裸数字视为端口 (缺省 host 为 `127.0.0.1`), 裸 host 保留 ACP 自己的默认端口 18889 (而不是 remote 的 18888), 端口 0 表示由 OS 分配临时端口。只允许绑定 loopback host (`127.0.0.1` / `::1` / `localhost`), 其他 host 直接抛 `ACP WebSocket must listen on a loopback address.`。启动成功后把实际可达地址 (含访问 token) 打印到 stderr: `ACP WebSocket listening at ws://<host>:<port>/acp?token=<accessToken>`。

WebSocket 升级的接入控制复用 remote 模式的同一套 `src/websocket-security.ts` 机制 (见 [remote](./remote)): 每次启动生成 32 字节 base64url 的一次性访问 token, 升级请求必须在 `token` 查询参数中携带 (时序安全比较), Origin 存在时必须与 Host 同源 (`http:`), 分别拦截无 token 的探测 (401) 和浏览器跨站 WebSocket 劫持 (403)。

## 能力协商

`initialize` 是协议握手, 返回协议版本和能力声明 (源码: `src/acp/agent.ts` 的 `initialize`):

```jsonc
{
  "protocolVersion": 1, // SDK 的 PROTOCOL_VERSION
  "authMethods": [], // 本地 agent, 不提供鉴权方法
  "agentInfo": { "name": "yukino", "title": "Yukino", "version": "..." },
  "agentCapabilities": {
    "loadSession": true, // 支持 session/load
    "promptCapabilities": { "embeddedContext": true }, // prompt 可携带 resource 内容块
    "sessionCapabilities": { "list": {}, "resume": {}, "close": {} },
  },
}
```

- `agentInfo.name` / `title` 来自常量 `AGENT_NAME = "yukino"` / `AGENT_TITLE = "Yukino"`, `version` 是当前运行的 Yukino 版本
- 只声明 Yukino 实际实现的能力; SDK 里的 `providers/*`、`session/set_mode`、`session/delete`、`session/fork` 等方法未实现, 因此不出现在能力中

## 方法清单

agent 侧 (`YukinoAcpAgent`) 实现的方法:

| 方法             | 行为                                                   |
| ---------------- | ------------------------------------------------------ |
| `initialize`     | 协议握手, 返回上面声明的能力                           |
| `authenticate`   | 空实现 (返回 `{}`), 本地 agent 无鉴权                  |
| `session/new`    | 新建会话, 绑定 `cwd`, 生成新的 session id              |
| `session/load`   | 加载已有会话并把历史回放给编辑器 (见「会话管理」)      |
| `session/resume` | 加载已有会话但不回放历史, 直接续跑                     |
| `session/list`   | 列出某个 `cwd` 下的历史会话 (不支持分页)               |
| `session/prompt` | 发送提示词, 运行 agent loop, 流式回推 `session/update` |
| `session/cancel` | 取消当前 prompt (通知, 无需应答)                       |
| `session/close`  | 关闭会话, 等待在途 turn 结束后释放 runtime             |

客户端侧 Yukino 会调用的编辑器方法:

- `session/update` (通知): 流式推送 agent 状态更新
- `session/request_permission` (请求): 工具权限确认, 阻塞等待编辑器用户决策

> 线上方法名是 `session/request_permission` (下划线), 源码里的 `requestPermission` 只是 SDK 的驼峰访问器。

## 会话管理

一个 ACP session 对应一个 Yukino session, runtime 由 `createRuntime` 经 `createRemoteAgent` 装配, 复用完整的 agent 栈 (工具注册、skills、hooks、MCP、记忆、上下文窗口)。ACP 模式下 `enableModelPlanMode` 固定关闭。

### 入参校验

`session/new` / `session/load` / `session/resume` 都会经过 `validateWorkspaceInputs`:

- `cwd` 必须是绝对路径, 否则报 `invalidParams` (`Session cwd must be absolute.`)
- 客户端自带的 `mcpServers` 不支持 (`Client-provided MCP servers are not supported.`)
- 额外的 `additionalDirectories` 不支持 (`Additional workspace directories are not supported.`)

`session/load` / `session/resume` 还会用 `SESSION_ID_PATTERN` (`^[a-z0-9]+-[a-f0-9]{8}$`) 校验 sessionId, 不匹配报 `Invalid session ID.`。`session/list` 若带 `cursor` 分页参数则报 `Session pagination is not supported.`。

### load 与 resume

两者都走同一个 `loadSession`, 区别只在是否回放:

- `session/load` 以 `replay = true` 调用: 从磁盘恢复历史, 并把历史逐条转成 `session/update` 通知回放给编辑器, 供编辑器重建界面
- `session/resume` 以 `replay = false` 调用: 只重建 runtime 和会话上下文, 不向编辑器回推历史, 用于直接续跑
- 若 sessionId 对应的会话已在内存中且 `replay = false`, `session/resume` 是幂等的空操作

恢复路径:

1. `loadSessionForResume` 读取 `~/.yukino/sessions/<projectKey>/<sessionId>.jsonl` (`<projectKey>` 是项目 cwd 规范化后的 sha256), 并把文件 mtime 刷新为当前时间
2. 若是全新加载且该文件不存在, 返回 `resourceNotFound`
3. 新建 runtime, `rebuildFromSession` 把持久化记录重建为会话消息 (尊重压缩边界), 写入 runtime 的 `ConversationManager`
4. `replay = true` 时, `historyNotifications` 把历史展开为 `session/update` 通知逐条回推 (见「事件转换」)

对已在内存中的会话, `session/load` / `session/resume` 还会校验 `cwd` 一致性, 不匹配报 `Session cwd does not match.`。

### list 与 close

- `session/list`: `cwd` 缺省取 `process.cwd()`; 返回的每一项含 `sessionId`、`cwd`、`title` (取会话首条消息) 和 `updatedAt` (文件 mtime 的 ISO 时间)
- `session/close`: 校验 sessionId, 标记会话关闭, 递增 generation, 中止在途 turn, 等待当前 turn 收尾, 调用 `runtime.dispose()` 释放资源并从会话表中移除

连接断开 (或进程侧 `dispose`) 会对所有会话执行与 `close` 相同的清理链。

### 提示词的排队与取消

`session/prompt` 不是简单的一次性调用, 而是一个会话内串行执行的任务:

- 每个会话维护一条 `tail` 承诺链, 新的 prompt 追加到链尾, 同一会话的多个 prompt 依次执行, 不会并发跑 agent loop
- 会话持有一个 `generation` 计数: `session/cancel` 和 `session/close` 都会递增它, 使排队中尚未开跑的 prompt 在轮到自己时直接以 `cancelled` 结束
- 正在运行的 turn 由一个组合 `AbortSignal` (请求信号 + 会话的 `turnAbort`) 控制: 请求被取消、`session/cancel` 或 `session/close` 的中止, 都会触发 `runtime.abort()` 打断 agent loop

`session/cancel` 是通知 (无返回值): 递增 generation、中止当前 turn、并调用 `runtime.abort()`。

## 事件转换

Yukino 的 `AgentEvent` 逐条转换为 ACP 的 `SessionUpdate`, 通过 `session/update` 推送 (源码: `src/acp/conversion.ts`):

| AgentEvent      | SessionUpdate                                                                      |
| --------------- | ---------------------------------------------------------------------------------- |
| `stream_text`   | `agent_message_chunk` (assistant 文本增量)                                         |
| `thinking_text` | `agent_thought_chunk` (推理增量)                                                   |
| `tool_use`      | `tool_call` (`title` = 工具名, `kind`, `status: pending`, `rawInput`, `locations`) |
| `tool_result`   | `tool_call_update` (`status: completed/failed`, `content`, `rawOutput`)            |
| `usage`         | `usage_update` (`used` = input + cacheRead + cacheCreation, `size` = 上下文窗口)   |
| 其他事件        | 不转换 (压缩边界等由 agent 侧自行持久化)                                           |

`tool_result` 的 `rawOutput` 形如 `{ output, isError, elapsed? }`; 有输出时 `content` 承载一个 text 内容块。`usage_update` 反映的是「上下文窗口占用」(`used` / `size`), 和 `PromptResponse` 里累计的用量是两个概念 (见下)。

### tool_call 的 kind 分类

`toolKind` 按工具名归类 (源码: `conversion.ts`):

```text
ReadFile                                  -> read
WriteFile | EditFile                      -> edit
Glob | Grep | ToolSearch | LSP            -> search
Bash | PowerShell | ComputerUse           -> execute
Agent | TaskStop | TaskOutput | TodoWrite -> think
ExitPlanMode                              -> switch_mode
WebFetch                                  -> fetch
其他                                      -> other
```

`locations` 从参数里的 `file_path` 或 `path` 提取, 相对路径按当前会话的 cwd 解析成绝对路径, 供编辑器高亮相关文件。

### 用量与停止原因

- 用量在整个 prompt 生命周期内累加 (`addUsage`): `inputTokens`、`outputTokens`、`cachedReadTokens`、`cachedWriteTokens`、`totalTokens`。prompt 结束时随 `PromptResponse` 返回 `{ stopReason, usage }` (`usage` 仅在出现过 usage 事件时携带)
- agent loop 抛出的 `error` 事件会转成 JSON-RPC `internalError`, 让 prompt 请求以错误结束
- `stopReason` 的映射: `max_tokens` / `max_turn_requests` / `refusal` 原样透传, `cancelled` 与 `interrupted` 归一为 `cancelled`, 其余归为 `end_turn`

## 提示词内容块

`session/prompt` 的 `prompt` 是一组内容块, 由 `promptToText` 拍平成纯文本 (这也对应 `initialize` 里声明的 `embeddedContext` 能力):

- `text`: 直接采用 (空白块被跳过)
- `resource_link`: 转为 `Resource: <name> (<uri>)`
- `resource`: 文本资源内联为 `Resource: <uri>\n<text>`; 二进制资源报 `invalidParams` (`Binary resources are not supported.`)
- `image` / `audio`: 不支持, 分别报 `Image prompts are not supported.` / `Audio prompts are not supported.`

拍平结果为空时报 `Prompt must contain text or a resource link.`。

## 权限请求

工具权限经 `session/request_permission` 发给编辑器, 由编辑器里的用户决策 (HITL 的编辑器侧形态):

```jsonc
{
  "sessionId": "...",
  "toolCall": {
    "toolCallId": "toolu_123abc",
    "title": "main · /path/to/project · WriteFile: Mode: default",
    "kind": "edit",
    "status": "pending",
    "rawInput": { "file_path": "src/index.ts", "content": "..." },
    "locations": [{ "path": "/path/to/project/src/index.ts" }],
  },
  "options": [
    { "optionId": "allow", "name": "Allow once", "kind": "allow_once" },
    {
      "optionId": "allowAlways",
      "name": "Remember for all project agents: WriteFile(/path/to/project/src/*)",
      "kind": "allow_always",
    },
    { "optionId": "deny", "name": "Reject", "kind": "reject_once" },
  ],
}
```

- `title` 形如 `<agentName> · <cwd> · <toolName>: <reason>`: 前缀标识发起调用的 agent (主线程为 `main`, 子代理为其名字) 及其工作目录, `reason` 是权限层的决策说明 (如 `Mode: default`); `kind` 与 `locations` 由 `toolKind` / `toolLocations` 给出
- `Allow once` (`allow`) 与 `Reject` (`deny`) 始终存在; `allowAlways` 选项仅当权限层能给出可记忆的规则模式 (`decision.rememberPatterns` 非空) 时才出现, 其文案为 `Remember for all project agents: <pattern, ...>` (上例中 `WriteFile` 记忆到所在目录的 `/*` 通配)
- 等待期间若用户取消 (`outcome: cancelled`) 或请求被中止, 视为 `deny` 并中止 agent loop
- 用户选择 `allowAlways` 时, agent loop 会调用权限层的 `allowAlways`, 把展示的那些模式持久化为项目级规则 (`~/.yukino/projects/<projectKey>/permissions.yaml`), 之后同类调用不再弹窗; 没有可记忆模式时 `allowAlways` 会退化为一次性的 `allow`

## 与其他模式的关系

- [remote](./remote) 面向浏览器 (自带前端), ACP 面向编辑器 (前端是编辑器自己的)
- [a2a](./a2a) 面向其他 agent (程序驱动), ACP 面向编辑器里的人 (人驱动)
- 三种模式共享同一个 agent 装配 (`createRemoteAgent`) 和会话持久化 (`~/.yukino/sessions/<projectKey>/<sessionId>.jsonl`), 因此切换模式不会丢失上下文; ACP 会话也能被 `--resume` 恢复
