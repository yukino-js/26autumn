---
title: "A2A"
---

A2A (Agent2Agent) 是一个开放的 agent 互通协议: 一个 agent 以标准化服务的形式对外暴露能力, 其他 agent 或编排器可以发现它、给它派发任务、消费它的流式状态更新

MCP 解决「agent 接入工具」, A2A 解决「agent 接入 agent」: Yukino 既可以作为 A2A 客户端调用别的 agent, 也可以作为 A2A 服务器被别的 agent 调用; `--a2a` 模式实现的是后者

## 启动

```bash
yukino --a2a            # 默认监听 127.0.0.1:18890
yukino --a2a 9000       # 自定义 loopback 端口 (host:port 也可以)
```

- 服务器只绑定 loopback 地址 (127.0.0.1 / ::1 / localhost), 非 loopback 地址直接抛错 `A2A server must listen on a loopback address.`; A2A 模式没有内置鉴权, 暴露到网络上等于把代码执行能力暴露到网络上
- 启动成功后向 stderr 打印 `A2A server listening at <url>`

## 端点

| 端点                               | 协议                  |
| ---------------------------------- | --------------------- |
| `GET /.well-known/agent-card.json` | Agent Card (服务发现) |
| `POST /`                           | JSON-RPC 2.0          |
| `/v1/...`                          | HTTP+JSON (REST)      |

服务器先绑定端口, 再用实际地址重写 Agent Card 中的 URL (支持端口 0 由 OS 分配)

## Agent Card

Agent Card 是 A2A 的服务发现文档, 描述这个 agent 是谁、能做什么、从哪里调用 (源码: src/a2a/card.ts):

```jsonc
{
  "name": "yukino",
  "description": "Yukino is a terminal-based AI coding agent...",
  "supportedInterfaces": [
    // JSONRPC 和 HTTP+JSON 两种绑定, 协议版本 1.0
    // 每个绑定再镜像一份 0.3 版本 (duplicateInterfacesForLegacy), 旧客户端走兼容层
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
  "version": "0.0.12", // 跟随当前运行的 Yukino 版本
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

## 任务模型: context 到 session 的映射

A2A 的核心对象是 Task: 客户端发消息 (message/send 或流式 message/stream), 服务器创建或续跑一个 Task, 以状态更新 (TaskStatusUpdateEvent) 流式回推进度

Yukino 的映射关系: 一个 A2A context 对应一个 Yukino session

- 文本消息触发 agent loop, 复用 remote 模式的 agent 装配 (createRemoteAgent: 工具注册、skills、hooks、MCP、记忆全套)
- runtime 按需创建 (ensureRuntime), 空闲 30 分钟 (DEFAULT_IDLE_TIMEOUT_MS) 后释放
- 会话持久化、上下文压缩、恢复和交互式模式一致

## 事件转换

Yukino 的 AgentEvent 转换为 A2A 的 working 状态更新消息 (源码: src/a2a/conversion.ts):

| AgentEvent    | A2A 消息                                                                                                         |
| ------------- | ---------------------------------------------------------------------------------------------------------------- |
| stream_text   | text part (assistant 文本增量)                                                                                   |
| thinking_text | data part `{ yukino: "thinking", text }`                                                                         |
| tool_use      | data part `{ yukino: "tool-call", toolCallId, toolName, args }`                                                  |
| tool_result   | data part `{ yukino: "tool-result", toolCallId, toolName, isError, elapsed, output }`, output 超过 8000 字符截断 |
| 其他事件      | 不转换                                                                                                           |

结构化数据统一放在 data part 里, 用 `yukino` 作为判别键 (discriminator), 客户端按这个键识别 Yukino 的扩展语义

## 权限请求: input-required

工具权限请求走 A2A 的 input-required 状态, 把决策权交回调用方 agent:

```txt
1. 权限层返回 ask -> task 进入 input-required 状态,
   携带 data part: { yukino: "permission-request", permissionId, toolName, args, ... }
2. 客户端在同一个 task 上回发 data part:
   { yukino: "permission-response", permissionId, decision }
   decision 枚举: allow | deny | allowAlways
3. Yukino 应用决策, agent loop 继续
```

一条消息只处理一个待决权限: 多个工具同时等待审批时, 只有消息中的第一个 permission-response 被应用, 其余的重新发 input-required, 客户端需要逐个应答

## 使用场景

- 另一个 agent (或编排器) 把「修复这个仓库的失败测试」作为一个 task 派发给 Yukino
- CI 系统把 Yukino 作为一个可编程的修复执行器
- 多 agent 系统中, Yukino 作为 coding 专家节点被发现和调用

与 ACP 的分工: ACP 面向编辑器 (人驱动, 编辑器是客户端), A2A 面向 agent (程序驱动, 调用方也是 agent), 见 acp
