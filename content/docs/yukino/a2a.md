---
title: "A2A"
description: "A2A (Agent2Agent) 互通协议: `--a2a` 模式下 Yukino 作为 A2A 服务器运行 (默认监听 127.0.0.1:18890), 基于 `@a2a-js/sdk` 以标准化服务暴露能力, 供其他 agent 或编排器发现、派发任务并消费流式状态更新"
local_path: "$HOME/github/yukino-code/apps/yukino"
local_commit: "bef5439b54e6510a12da61bcfa4285ecb1cd2192"
---

A2A (Agent2Agent) 是一个开放的 agent 互通协议: 一个 agent 以标准化服务的形式对外暴露能力, 其他 agent 或编排器可以发现它、给它派发任务、消费它的流式状态更新

MCP 解决「agent 接入工具」, A2A 解决「agent 接入 agent」: `--a2a` 模式下 Yukino 作为 A2A 服务器运行, 任何 A2A 兼容的客户端都能把编码任务派发给它; 服务端基于 `@a2a-js/sdk` 实现, 源码集中在 src/a2a/ (card、server、executor、conversion、constants、prompts 六个模块)

## 启动

```bash
yukino --a2a            # 默认监听 127.0.0.1:18890
yukino --a2a 9000       # 自定义 loopback 端口 (host:port、[IPv6]:port 也可以)
yukino --a2a 0          # 端口 0 由 OS 分配, 实际地址启动后打印
```

- `--a2a` 是服务器模式旗标, 不能与 `--remote` / `--acp` / `--acp-ws` 组合
- 只允许绑定 loopback 地址 (127.0.0.1 / ::1 / localhost), 非 loopback 地址直接抛错 `A2A server must listen on a loopback address.`; 服务器没有内置鉴权 (SDK 侧挂的是 `UserBuilder.noAuthentication`), 暴露到网络上等于把代码执行能力暴露到网络上
- 服务器先绑定端口, 再用实际绑定地址生成 Agent Card 中的 URL, 所以端口 0 也能对外公布可达地址 (IPv6 地址会带 `[]` 包裹)
- 启动成功后向 stderr 打印 `A2A server listening at <url>` 和 `Agent card at <cardUrl>`, 随后阻塞直到 SIGINT/SIGTERM; 退出时关闭 HTTP 服务器并 dispose 所有 agent runtime (src/a2a/server.ts 的 runA2aServer)

## 端点与线协议

| 端点                               | 协议                  |
| ---------------------------------- | --------------------- |
| `GET /.well-known/agent-card.json` | Agent Card (服务发现) |
| `POST /`                           | JSON-RPC 2.0          |
| `/v1/...`                          | HTTP+JSON (REST)      |

JSON-RPC 方法: `SendMessage`、`SendStreamingMessage`、`GetTask`、`CancelTask`、`SubscribeToTask`; REST 侧对应 `POST /v1/message:send`、`POST /v1/message:stream`、`GET /v1/tasks/:taskId`、`POST /v1/tasks/:taskId:cancel`、`GET|POST /v1/tasks/:taskId:subscribe`, 另有 `GET /v1/card` 返回 Agent Card

- 请求必须带 `A2A-Version: 1.0` 头: SDK 用 card 公布的协议版本做校验, 缺省时按 0.3 处理, 而本服务器只公布 1.0, 会被直接拒绝
- 流式: `SendStreamingMessage` / `message:stream` 配合 `accept: text/event-stream`, 响应是 SSE 流, 依次推送 task 快照与 TaskStatusUpdateEvent
- task 对象存在内存 (InMemoryTaskStore), 重启即清空; 对话内容经 session 文件持久化, context 映射也在磁盘上, 重启后同一 contextId 仍能恢复历史

## Agent Card

Agent Card 是 A2A 的服务发现文档, 描述这个 agent 是谁、能做什么、从哪里调用 (源码: src/a2a/card.ts 的 buildAgentCard):

```jsonc
{
  "name": "yukino",
  "description": "Yukino is a terminal-based AI coding agent...",
  "supportedInterfaces": [
    // JSON-RPC 与 HTTP+JSON 两种绑定同源部署, 共享同一个 URL
    {
      "url": "http://127.0.0.1:18890/",
      "protocolBinding": "JSONRPC",
      "protocolVersion": "1.0",
    },
    {
      "url": "http://127.0.0.1:18890/",
      "protocolBinding": "HTTP+JSON",
      "protocolVersion": "1.0",
    },
  ],
  "version": "0.0.18", // 跟随当前运行的 Yukino 版本 (src/version.ts)
  "capabilities": { "streaming": true, "pushNotifications": false },
  "defaultInputModes": ["text/plain"],
  "defaultOutputModes": ["text/plain"],
  "skills": [
    {
      "id": "coding",
      "name": "Coding",
      "description": "Executes software engineering tasks...",
      "tags": ["code", "development", "programming"],
      "examples": [
        "Fix the failing tests in this repository.",
        "Add a dark mode toggle to the settings page.",
      ],
    },
  ],
}
```

`streaming: true` 对应 SSE 状态流; `pushNotifications: false` 表示不支持 webhook 推送, 客户端需要自己订阅流或轮询 task

## 任务模型: context 到 session 的映射

A2A 的核心对象是 Task: 客户端发消息 (SendMessage 或流式 SendStreamingMessage), 服务器创建或续跑一个 Task, 以状态更新流式回推进度; Yukino 侧的执行器是 YukinoA2aExecutor (src/a2a/executor.ts), 一个 A2A contextId 对应一个 Yukino session

```txt
submitted ──> working ──┬──> completed        agent loop 正常结束
                        ├──> failed           error 事件 / 运行异常 / 请求被拒
                        ├──> canceled         CancelTask, 或 stopReason 为 cancelled/interrupted
                        └──> input-required   工具权限等待调用方审批
                                 │  permission-response 回发
                                 └────────> working
```

- runtime 按需惰性创建 (ensureRuntime): 只有合法且非 busy 的消息才会触发; 空消息 (既无 text 也无 permission-response data part) 直接 fail, 不会创建 session 或拉起 runtime
- 默认工厂 createA2aRuntime 复用 remote 模式的 agent 装配 (createRemoteAgent, non-interactive): 工具注册、skills、hooks、MCP、LSP、沙箱、记忆全套; agent 的工作目录是服务器启动进程的 cwd
- 用户文本经 saveMessage 写入 session transcript, 与交互式模式同一套会话存储; 上下文压缩、恢复行为一致
- 空闲驱逐: 30 分钟无活动 (DEFAULT_IDLE_TIMEOUT_MS) 后 dispose runtime, 释放 MCP 连接和后台资源; contextId→sessionId 映射持久化在 `~/.yukino/projects/<sha256(cwd)>/a2a-contexts/<sha256(contextId)>` (临时文件 + rename 原子写入), 下一条消息按 sessionId 重建 runtime 并用 rebuildFromSession 回放 transcript, 驱逐对对话透明
- 容量上限: 最多跟踪 256 个 context (MAX_TRACKED_SESSIONS), 超出时按 LRU 驱逐完全空闲的 session (进行中或等待权限的绝不驱逐), 无法驱逐则报 `A2A session capacity reached; retry when an active context finishes.`
- 单并发: 同一 context 同时只允许一个 run, busy 期间的新消息被拒绝: `Context <contextId> is busy with task <taskId>. Cancel it or wait for it to finish before sending a new message.`
- 取消: CancelTask 把所有 pending 权限自动 resolve 为 deny, abort runtime, task 进入 canceled 并携带文本 `Task canceled by user request.`

## 事件转换

Yukino 的 AgentEvent 转换为 A2A working 状态的 TaskStatusUpdateEvent 消息 (源码: src/a2a/conversion.ts):

| AgentEvent    | A2A 消息                                                                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| stream_text   | text part (assistant 文本增量)                                                                                                              |
| thinking_text | data part `{ yukino: "thinking", text }`                                                                                                    |
| tool_use      | data part `{ yukino: "tool-call", toolCallId, toolName, args }`                                                                             |
| tool_result   | data part `{ yukino: "tool-result", toolCallId, toolName, isError, elapsed, output }`, output 超过 8000 字符截断并追加 `… [truncated]` 标记 |
| 其他事件      | 不转换                                                                                                                                      |

- 结构化数据统一放在 data part 里, 用 `yukino` 作为判别键 (discriminator), 客户端按这个键识别 Yukino 的扩展语义; 各类 data part 的形状由 zod schema 定义并校验 (PermissionRequestDataSchema、PermissionResponseDataSchema、ThinkingDataSchema、ToolCallDataSchema、ToolResultDataSchema)
- 终态映射: loop_complete 的 stopReason 为 cancelled/interrupted 时 task 进入 canceled; error 事件或异常进入 failed, 错误文本作为终态消息的 text part

## 权限请求: input-required

工具权限请求走 A2A 的 input-required 状态, 把决策权交回调用方 agent:

```txt
1. 权限层返回 ask -> executor 生成 permissionId (perm-<自增计数>-<8 位随机>),
   task 进入 input-required, 消息携带当前全部待决的 data part:
   { yukino: "permission-request", permissionId, toolCallId, toolName, reason, args }
2. 客户端在同一个 task 上回发 data part (taskId 必须与当前 run 一致):
   { yukino: "permission-response", permissionId, decision }
   decision 枚举: allow | deny | allowAlways
3. executor 应用决策, task 回到 working, agent loop 继续
```

- 一条消息只处理一个待决权限: 只有消息中的第一个 permission-response 被应用, 其余 pending 权限重新发 input-required, 客户端需要逐个应答
- reason 字段是权限层给出的理由; 请求来自子 agent 时前置一行 `agentName · cwd` 标明来源
- 各类错误都以拒绝消息返回: taskId 不匹配、permissionId 未知或已解决、run 已结束 (`No active run is awaiting a permission response.`); run 进行中时拒绝以独立 Message 发布, 不扰动进行中 task 的持久化状态, 否则把本次请求的 task 置为 failed
- CancelTask、服务器 dispose、子 agent 的 abort signal 都会把 pending 权限自动 resolve 为 deny; 之后若还有剩余待决权限则重新推 input-required, 否则回到 working

## 使用场景

- 另一个 agent (或编排器) 把「修复这个仓库的失败测试」作为一个 task 派发给 Yukino
- CI 系统把 Yukino 作为一个可编程的修复执行器
- 多 agent 系统中, Yukino 作为 coding 专家节点被发现和调用
- 库形式嵌入: 包 `@yukino.js/yukino` 导出 `A2A` 命名空间, `A2A.Server.startA2aServer({ address, runtimeFactory, cwd })` 返回 `{ url, cardUrl, close }`, runtimeFactory 可替换成自定义 runtime (测试即用它注入假 runtime)

与 ACP 的分工: ACP 面向编辑器 (人驱动, 编辑器是客户端), A2A 面向 agent (程序驱动, 调用方也是 agent), 见 [acp](./acp); 浏览器聊天界面则是 [remote](./remote) 模式的职责
