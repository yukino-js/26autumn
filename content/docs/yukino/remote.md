---
title: "Remote"
---

Remote 模式把 Yukino 变成一个本地 Web 服务: Express HTTP 服务器 + WebSocket 桥, 浏览器打开一个 React 前端, 与终端 UI 功能对齐的聊天界面

场景: 手机/平板访问开发机上的 agent、长跑任务放到服务器上跑、把 Yukino 嵌进自己的 Web 工作台

## 启动

```bash
yukino --remote                  # 监听 127.0.0.1:18888
yukino --remote 9000             # 自定义 loopback 端口 (":9000" 也可以)
yukino --remote 0.0.0.0:9000     # 显式暴露到所有网卡 (没有内置鉴权)
yukino --remote 0                # OS 分配端口, 实际地址打印到 stderr
```

- 默认只绑定 loopback; 绑定非 loopback 地址必须显式写 host
- 端口 0 时 OS 选空闲端口, 启动后 stderr 打印 `Remote server listening at http://127.0.0.1:<port>/#token=<accessToken>`
- WS 接入控制 (src/websocket-security.ts): 每次启动生成 32 字节 base64url 的一次性访问 token, 升级请求必须携带 (时序安全比较); Origin 存在时必须与 Host 同源 (http:), 防浏览器跨站 WebSocket 劫持; token 只经 stderr/URL fragment 本地分发, HTTP 层仍没有账号体系, 暴露到公网需要自己套反向代理 + 认证
- HTTP 服务器托管打包好的浏览器前端 (src/remote/browser 单独构建, `pnpm build:browser`, 发布时随 CLI dist 一起打包), WebSocket 挂在同端口

## 架构

```txt
浏览器 (React 前端)
   |  WebSocket (JSON 帧, zod discriminated union 校验)
   v
RemoteServer (Express + ws)
   |  bridgeEvent: AgentEvent -> WS 消息
   v
RemoteAgentHandle (封装全部 agent 状态)
   ├── LLMClient (provider 可切换)
   ├── ToolRegistry (19 个基础工具 + LoadSkill + teams + Agent + Workflow + MCP)
   ├── ConversationManager + 会话持久化
   ├── PermissionChecker (权限请求转发到浏览器)
   ├── HookEngine / SkillCatalog / MemoryExtractor+Consolidator
   └── TeamManager (teammate 管理)
```

- agent 装配延迟创建: 启动时尝试 createRemoteAgent, 失败 (例如 provider 未配置) 则推迟到第一条消息时重试
- 与交互式 UI 共享同一套 Agent 循环和会话文件, remote 会话可以被 --resume 恢复
- 记忆的后台整理 (consolidation) 在 remote 和交互式 UI 都会运行 (同一套 24h/锁/会话数门槛)
- 工具装配: `createToolRegistry` 以交互模式给出 19 个基础工具 (见 function-calling), remote 再注册 LoadSkill、AskUserQuestion、TeamCreate、SendMessage、TeamDelete、TaskStop、SyntheticOutput、Agent、Workflow (attachWorkflow) 和 MCP 工具包装; 与终端 UI 的差异是 remote 不注册 InstallSkill / TeamList

## WebSocket 协议

JSON 帧 `{ type, data }`, 双向都有 zod 运行时校验 (前端侧 schema 在 src/remote/browser/src/types.ts)

### client → server (18 种)

| type                   | 用途                                    |
| ---------------------- | --------------------------------------- |
| user_message           | 发送用户消息                            |
| permission_response    | 权限请求应答 allow / deny / allowAlways |
| ask_user_response      | AskUserQuestion 应答                    |
| plan_approval_response | plan 审批应答 yolo / manual / feedback  |
| set_permission_mode    | 切换权限模式                            |
| model_list_request     | 请求当前 provider 的模型列表            |
| model_select           | 切换模型                                |
| provider_list_request  | 请求 provider 列表                      |
| provider_select        | 切换 provider                           |
| provider_save          | 保存 provider 配置                      |
| rewind_list_request    | 请求可回退的快照列表                    |
| rewind_action          | 执行回退                                |
| file_complete_request  | 文件路径补全                            |
| image_upload           | 上传图片附件                            |
| background_shells      | 查询后台 shell                          |
| mcp_app_request        | MCP app 交互请求                        |
| cancel                 | 中断当前 agent loop                     |
| ping                   | 心跳, 回 pong                           |

### server → client (44 种)

- 连接与会话: connected (session/cwd/streaming)、commands (slash 命令列表)、status (model/provider/permissionMode/thinkingLevel/thinkingLevels/sandbox/contextWindow 快照)、session_list、clear、command_done、run_state (streaming)、pong、system (记忆整理等系统消息)
- 历史回放: replay_user、replay_assistant
- 流式输出: stream_text、stream_end、thinking_text
- 工具: tool_use (toolId/toolName/args)、tool_result (output/isError/elapsed/mcpApp)、tool_output (增量输出)
- 交互: permission_request (id/toolName/description/rememberPatterns)、ask_user (questions)、plan_approval_request (id/planPath/planContent)、plan_approval_closed、request_expired (待决请求失效)
- steering: steering_queued、steering_delivered (流式期间追加消息)
- 生命周期: turn_complete (turn)、loop_complete (stopReason/totalTurns/elapsed)、usage (inputTokens/outputTokens/contextTokens/contextWindow)、error、compact、retry (reason/waitMs)
- 面板与状态: history、todo_update (boardId/tasks)、subagents、background_tasks、teammates、followups
- 配置与选择器: model_list、provider_list、rewind_list、thinking_form、file_complete_response、image_saved、image_error
- MCP: mcp_app_response

AgentEvent 到 WS 消息的转换在 bridgeEvent: agent loop 的事件流被逐条翻译成前端消息, 前端不感知 agent 内部结构

## 浏览器前端

技术栈: React 19 + tsup 构建 + Tailwind CSS v4, 打包为静态资源由 Express 托管

组件与终端 UI 的功能对齐 (src/remote/browser/src/components):

- 消息流: message-list、user-message、assistant-message、system-message、error-message、thinking-block、streaming-cursor、tool-block (可折叠的工具调用卡片)、collapsible、diff-lines、markdown
- 交互对话框: permission-dialog、ask-user-dialog、plan-approval-dialog、session-picker、rewind-dialog、provider-dialog、modal、picker-list
- 输入与导航: input-area、slash-menu (斜杠命令补全)、welcome、status-bar、done-indicator、activity-panel、todo-progress、model-picker、thinking-picker、mcp-app
- hooks: use-web-socket (连接与重连)、use-chat (消息 reducer, ChatItem 模型)、use-auto-scroll / use-scroll-follow (跟随滚动, 用户上翻时暂停)、use-theme、offline-queue

WebSocket 断开自动重连, 连接状态 connecting / connected / reconnecting 展示在状态栏

## 生命周期

`run()` 阻塞直到服务器停止; Ctrl+C/SIGTERM 的优雅关闭链:

1. 停止 HTTP/WS 服务器
2. 杀掉 detached 的后台 shell 和 teammate 进程
3. 断开 MCP 子进程
4. 记录真实退出码, 等遥测 flush
