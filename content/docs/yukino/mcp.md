---
title: "MCP"
---

## 背景

Tool 的接入和 Agent CLI 是耦合的

MCP: 动态接入 Tools

## MCP

MCP (Model Context Protocol) 是一个开放协议, 定义 AI 应用 (MCP 客户端) 和外部 Tools Server (MCP 服务器) 的标准化通信方式

### 角色

- Host: AI 应用, 例如 Claude Code、Claude Desktop、Codex、Yukino
- Client: Host 的 MCP 连接组件, 负责和 MCP Server 建立连接, 发送请求, 接收响应
- Server: 外部 Tools 提供方

Yukino 这个 Host 会创建一个或多个 MCP Client, 每个 Client 对应一个 MCP Server

### 协议分层

- Data Layer 数据层: 定义消息格式、初始化握手、工具发现/工具调用, 核心是 JSON-RPC 2.0, lifecycle, tools, resources, prompts 等原语 (primitives)
- Transport Layer 传输层: 使用 stdio 还是 streamable http

```ts
type MCPTransport =
  StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport;
```

- tools: 一个 MCP Server 可以暴露一组工具, 每个工具有 name, description, input_schema, required
- resources: 可读的数据源, 例如数据库 MCP Server 可以暴露表结构作为 resources
- prompts: MCP Server 提供的预定义提示词模版函数 (prompt 字符串插值)

tools

```json
{
  "name": "search_issues",
  "description": "Search github issues",
  "inputSchema": {
    "type": "object",
    "properties": {
      "repo": {
        "type": "string",
        "description": "Repository name, format: owner/repo"
      },
      "query": {
        "type": "string",
        "description": "Search keyword"
      },
      "state": {
        "type": "string",
        "enum": ["all", "open", "closed"]
      }
    },
    "required": ["repo"]
  }
}
```

MCP Client 可以声明

- roots: 项目根目录, 或者工作区边界
- sampling: 允许 MCP Server 反过来请求 Host 调用 LLM
- elicitation: 允许 MCP Server 请求 Host, 向用户提问

## stdio / streamable http

- stdio: Host 中的 MCP Client 将 MCP Server 作为子进程启动, 通过 stdin/stdout 管道通信 (env 合并 process.env + 配置的 env, stderr 不参与通信, 用于输出调试日志)
  - 不需要: 监听端口、网络连接、服务发现、身份认证
  - stdio 的消息格式是 UTF-8 编码的 JSON-RPC 消息, 以换行符分隔
- streamable http: MCP Server 是一个独立的 HTTP 服务器, MCP Client 通过 HTTP post/get 通信, 必要时使用 SSE 流式传输; MCP Server 可以在本机, 也可以在远程
  - MCP Server 有两种响应方式: 结果 ready 直接返回 application/json; 需要流式传输则返回 text/event-stream, 使用 SSE 推送
  - MCP Client 发送请求时, Accept 头必须同时声明 `Accept: application/json, text/event-stream`
  - 配置的 transport 是 `sse` 时走 legacy SSE transport (deprecated 兼容)

## JSON-RPC 2.0

不管是使用 stdio 还是 streamable http, MCP 的消息格式统一使用 JSON-RPC 2.0

JSON-RPC 2.0 只有 3 种消息类型

### 请求 (Request)

字段: id, method, params

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "search_issues",
    "arguments": {
      "repo": "golang/go",
      "query": "error handling"
    }
  }
}
```

### 响应 (Response)

字段: id (响应 id 和请求 id 对应), result 或 error

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "Found 233 issues matching 'error handling'..."
      }
    ]
  }
}
```

### 通知 (Notification)

字段: method, params

通知和请求的区别是: 通知没有 id, 不期望响应; 请求有 id, 期望响应

## 完整的 MCP 会话

以 stdio 为例

### 1. 初始化握手

MCP Client 将 MCP Server 作为子进程启动后, 发送 `initialize` 请求, 声明自己的协议版本、能力和身份信息 (clientInfo: `{ name: "yukino", version }`); MCP Server 响应自己的协议版本、能力和身份信息

握手成功后, MCP Client 发送 `notifications/initialized` 通知

如果底层 transport 不是 stdio 而是 streamable http, 则后续 http 请求还需要携带 `MCP-Protocol-Version` http 头部字段

### 2. 工具发现

- MCP Client 发送 `tools/list` 请求, 获取 MCP Server 提供的所有工具定义
- MCP Client 将工具定义包装为 Yukino 内部的 Tool 接口 (MCPToolWrapper, 适配器模式), 注册到 ToolRegistry; 下一轮对话, LLM 在工具列表中就能看到这些工具, 决定是否调用

### 3. 工具调用

当 LLM 决定调用某个 MCP 工具时, MCP Client 发送 `tools/call` 请求; MCP Server 返回的 content 是一个数组, 每个元素是一个内容块 (content block):

- image 内容 (png/jpeg/gif/webp): resize 后转为 base64 image block, 超限降级为文本占位
- 其他内容: JSON 序列化为文本
- isError 透传

> 整个流程是: initialize (client request, server response) -> notifications/initialized (client notification) -> tools/list (client request, server response) -> tools/call \* N

## MCP 配置

两个来源

- 用户级配置 `~/.yukino/config.yaml` 的 `mcp_servers` 数组, 所有项目生效
- 项目级配置 `${workDir}/.mcp.json`, 当前项目生效, Claude Code 兼容格式 (随仓库分发)

```yaml
# ~/.yukino/config.yaml
mcp_servers:
  # stdio: command 字段 -> 启动子进程
  - name: github # Server 名称, 全局唯一
    command: npx
    args: ["-y", "@modelcontextprotocol/server-github"]
    env:
      GITHUB_TOKEN: "${GITHUB_TOKEN}"
  # streamable http: url 字段 -> 发送 http 请求
  - name: remote-tool
    url: "https://api.example.com/mcp"
    transport: http # http (默认) | sse (legacy)
    headers:
      Authorization: "Bearer ${API_TOKEN}"
```

```json
// ${workDir}/.mcp.json
{
  "mcpServers": {
    "yukino-mcp": {
      "command": "npx",
      "args": ["-y", "@yukino.js/mcp@latest"],
      "env": { "API_KEY": "${YUKINO_MCP_API_KEY}" }
    },
    "remote": {
      "type": "http",
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer ${TOKEN}" }
    }
  }
}
```

- command 和 url 恰好配置一个: command → stdio, url → http/sse
- 环境变量展开支持 `${VAR}`、`${VAR:-default}`、`$VAR` 三种语法, 作用于 command、args、url、env 值、headers 值; 引用了未设置的变量且无默认值时, 该 server 连接失败 (而不是静默置空)
- 合并规则: 两个来源按名称合并, 重名时用户级配置获胜 (项目文件随仓库分发、信任度更低)
- 容错: `.mcp.json` 文件非法整体忽略 (记日志); 单个 server 条目非法跳过, 不影响其余条目

### /mcp reload

编辑配置后, `/mcp reload` 重读两个来源并 reconcile 现有连接:

- unchanged: 配置深比较相同, 连接保持不动
- changed: 配置变化, 断开重连 (client 实例复用)
- removed: 配置消失, 断开并移除其注册的工具
- new: 新增配置, 建立连接并注册工具

reload 输出四类计数; 重连的 server 会清除已公告的 instructions 并重新注册工具; reload 期间配置非法则中止, 现有连接保持完整

连接生命周期由 MCPManager 串行化管理 (runExclusive): 启动、重试、reload 不竞态; 连接成功且 tools/list 拿到工具后才记录 client, 失败记入 errors

## 工具命名与权限

MCP 工具命名规范: `mcp__serverName__toolName`

sanitizeName 函数将 serverName 和 toolName 中的非字母数字下划线字符替换为下划线 (连字符也替换), 并使用 `mcp__` 前缀和双下划线连接; 四语言实现一致, 保证 permissions.yaml 的规则通用

```js
function sanitizeName(serverName, toolName) {
  const clean = (s) => s.replace(/[^a-zA-Z0-9_]/g, "_");
  return `mcp__${clean(serverName)}__${clean(toolName)}`;
}
```

MCPToolWrapper 默认配置:

- category: "command"
- deferred: true

```yaml
# 允许 GitHub MCP 工具
- rule: mcp__github__*(*)
  effect: allow

# 禁止所有 MCP 工具的删除操作
- rule: mcp__*__delete__*(*)
  effect: deny
```

## 工具延迟加载: 80 个工具塞不进上下文

如果用户配置了 4 个 MCP Server, 每个提供 15-20 个工具, 加上内置工具, 工具数量膨胀到 80 个; 每个工具定义大约 100-300 个 token, 80 个工具定义就是 8000-24000 个 token, 每轮对话都需要携带, 占用大量的上下文窗口, 也影响 LLM 的工具选择准确率

更隐蔽的代价是 prompt cache: tools 数组渲染在缓存前缀的最前面 (tools -> system -> messages), 数组任何变化 (增删工具) 会使整个后续历史缓存失效; 20k token 历史的实测命中率从 99.4% 掉到 9.5%

### 三种加载模式

MCP 连接完成后, strategy (src/mcp/strategy.ts) 一次性决定加载模式:

1. 环境变量覆盖: `YUKINO_MCP_LOADING=eager|native|dispatch`
2. 没有 MCP 工具: eager
3. 估算 token (schema 总字符数 / 2.5) < contextWindow 的 10%: eager (全量放进 tools[], 开销可接受)
4. 否则: protocol 是 anthropic 且 base_url 是官方端点 (空或 api.anthropic.com) → native; 其他 → dispatch

| 模式     | tools[] 中                     | 发现方式                          | 调用方式                     |
| -------- | ------------------------------ | --------------------------------- | ---------------------------- |
| eager    | 全量, defer_loading 清除       | 直接可见                          | 直接调用                     |
| native   | 保留但带 `defer_loading: true` | ToolSearch 拉取 tool_reference    | 直接调用 (服务端隐藏 schema) |
| dispatch | 完全省略                       | ToolSearch 返回 schema + 路由提示 | 经 McpCall 工具分发          |

- native 依赖 Anthropic 的 beta 能力 (`anthropic-beta: advanced-tool-use-2025-11-20`): 工具留在 tools[] 中但服务端不向模型展示, 模型必须先经 ToolSearch 获取 tool_reference 才能调用; tools[] 数组字节级不变, 新工具被发现也不破坏缓存
- OpenAI 协议没有 defer_loading 概念, native 强制降级为 dispatch
- ToolSearch / McpCall 是否暴露给模型在模式确定时一次性设定 (exposeToolSearch = 非 eager, exposeMcpCall = dispatch), 不逐轮重算: 运行中重算会让工具从 tools[] 中途消失, 同样破坏缓存
- McpCall 必须在 MCP 连接之前就注册进 tools[] (缓存前缀稳定)

### ToolSearch

```txt
1. 每个 agent loop 构建工具列表时, 跳过延迟加载且未发现的工具
2. 延迟加载工具的名称列表以 system-reminder 注入 (仅当工具池变化, 或上一条列表被压缩移除时重注入, 避免每轮重复浪费窗口)
3. LLM 判断需要某个工具时, 调用 ToolSearch:
   - "select:name1,name2" 按工具名精确加载 (大小写不敏感)
   - 其他 query 做关键词子串搜索 (name + description), max_results 默认 5
4. 命中的工具标记为 discovered:
   - 本地工具进入下一个 agent loop 的 tools[]
   - native 模式的 MCP 工具返回 tool_reference 内容块, 由服务端展开 schema
   - dispatch 模式返回完整 schema 并提示经 McpCall 调用
```

### McpCall

dispatch 模式的调用通道, 参数 server / tool / arguments 三者必填:

- tool 接受短名或全名 (mcp\_\_server\_\_tool)
- 参数按目标工具的 inputSchema 逐层纠型: string↔number、"true"/"false"→bool、单键对象包裹的数组解包、逗号串拆为数组、object/array 递归纠型; LLM 隔着 schema 描述传参, 类型漂移常见
- 权限检查的内容规范化为 `server__tool`; 对目标 MCP 工具做双重权限检查
- 未知工具报错并列出可用的 mcp\_\_ 工具

### Server instructions 公告

MCP Server 可以在 initialize 响应中携带 instructions (使用说明), Yukino 以增量方式公告到对话:

- marker 是 `# MCP Server Instructions`, 新增 = 已连接且未公告的 server, 撤回 = 已公告但断连的 server
- 历史中 marker 消失 (/clear、/resume、上下文压缩) 时, 全量重发
- 不进 system prompt (会破坏缓存前缀), 走 system-reminder
