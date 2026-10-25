---
title: "ACP"
---

ACP (Agent Client Protocol) 是编辑器与外部 agent 的集成协议: 编辑器 (ACP 客户端) 启动一个外部 agent 进程, 通过 JSON-RPC 驱动它完成会话、提示词、权限确认等交互

MCP 让 agent 接入工具, ACP 让编辑器接入 agent: `--acp` 模式下 Yukino 作为 ACP agent, 被 ACP 兼容的编辑器 (例如 Zed) 拉起和使用

## 启动与传输

```bash
yukino --acp           # stdio 传输 (不能与其他旗标组合)
yukino --acp-ws        # WebSocket 传输, 默认监听 127.0.0.1:18889
yukino --acp-ws 9000   # 自定义端口 (host:port 也可以)
yukino --acp-ws 0      # OS 分配端口, 实际 ws:// 地址打印到 stderr
```

- stdio 传输: 编辑器把 Yukino 作为子进程启动, 经 stdin/stdout 通信, 是编辑器的标准用法
- WebSocket 传输: 独立监听, 路径 `/acp`; 和 A2A / remote 一样只绑定 loopback 地址; 升级握手经 websocket-security 校验: 启动时生成一次性访问 token (URL 携带, 时序安全比较) + Origin 同源检查 (见 remote)
- 两种传输背后是同一套 agent 实现 (src/acp/agent.ts)

## 方法清单

agent 侧实现的 ACP 方法:

| 方法           | 行为                                                |
| -------------- | --------------------------------------------------- |
| initialize     | 协议握手, 交换能力                                  |
| authenticate   | 空实现 (本地 agent 不需要鉴权)                      |
| session/new    | 新建会话 (绑定 cwd)                                 |
| session/load   | 加载已有会话 (可带 replay, 回放历史)                |
| session/resume | 恢复会话 (load 的别名入口)                          |
| session/list   | 列出历史会话                                        |
| session/close  | 关闭会话, 释放 runtime                              |
| session/prompt | 发送提示词, 运行 agent loop, 流式返回 SessionUpdate |
| session/cancel | 取消当前 prompt (通知, abort agent loop)            |

客户端侧 Yukino 使用的编辑器方法:

- `session/update` (通知): 流式推送 agent 状态更新
- `session/requestPermission` (请求): 工具权限确认, 阻塞等待编辑器用户决策

## 会话管理

- 一个 ACP session 对应一个 Yukino session, 复用完整的 agent 装配 (createRemoteAgent: 工具、skills、hooks、MCP、记忆)
- session/load 校验 cwd 一致性 (不匹配报 invalidParams); 从 `~/.yukino/sessions/<projectKey>/<id>.jsonl` 恢复历史, replay 参数控制是否把历史作为 session/update 通知回放给编辑器
- 每个 session 的 runtime 独立持有 ConversationManager、权限检查器、上下文窗口; dispose 时统一清理

## 事件转换

Yukino 的 AgentEvent 转换为 ACP 的 SessionUpdate (源码: src/acp/conversion.ts):

| AgentEvent    | SessionUpdate                                                              |
| ------------- | -------------------------------------------------------------------------- |
| stream_text   | agent_message_chunk (assistant 文本增量)                                   |
| thinking_text | agent_thought_chunk (推理增量)                                             |
| tool_use      | tool_call (标题 = 工具名, kind, status: pending, rawInput, locations)      |
| tool_result   | tool_call_update (status: completed/failed, content, rawOutput)            |
| usage         | usage_update (used = input + cacheRead + cacheCreation, size = 上下文窗口) |
| 其他事件      | 不转换 (compact boundary 在 agent 侧持久化)                                |

tool_call 的 kind 分类:

```js
ReadFile                                  -> "read"
WriteFile | EditFile                      -> "edit"
Glob | Grep | ToolSearch | LSP            -> "search"
Bash | PowerShell | ComputerUse           -> "execute"
Agent | TaskStop | TaskOutput | TodoWrite -> "think"
ExitPlanMode                              -> "switch_mode"
WebFetch                                  -> "fetch"
其他                                      -> "other"
```

locations 从参数中的 file_path/path 提取 (相对路径按 workDir 解析), 编辑器可以据此高亮相关文件

usage 在整个 prompt 生命周期内累加 (addUsage: inputTokens, outputTokens, cachedReadTokens, cachedWriteTokens, totalTokens), 随 loop_complete 返回 stopReason 和最终 usage

## 权限请求

工具权限请求经 `session/requestPermission` 发给编辑器, 由编辑器用户决策 (HITL 的另一张脸):

```jsonc
{
  "sessionId": "...",
  "toolCall": {
    "toolCallId": "toolu_123abc",
    "title": "Bash: Run shell command",
    "kind": "execute",
    "status": "pending",
    "rawInput": { "command": "pnpm test" },
    "locations": [{ "path": "/path/to/project" }],
  },
  "options": [
    { "optionId": "allow", "name": "Allow once", "kind": "allow_once" },
    {
      "optionId": "allowAlways",
      "name": "Always allow",
      "kind": "allow_always",
    },
    { "optionId": "deny", "name": "Reject", "kind": "reject_once" },
  ],
}
```

- 三个选项: Allow once (本次允许) / Always allow (始终允许, 写入项目级规则文件) / Reject (拒绝)
- 等待期间用户取消 (outcome: cancelled) 或 prompt 被 cancel: 中止 agent loop, 决策按 deny 处理
- allowAlways 由权限层持久化规则, 下次同类调用不再弹窗

## 与其他模式的关系

- remote 模式面向浏览器 (自建前端), ACP 面向编辑器 (前端是编辑器自己的)
- A2A 模式面向其他 agent (程序驱动), ACP 面向编辑器里的人 (人驱动)
- 三种模式共享同一个 agent 装配和会话持久化, 切换模式不丢上下文
