---
title: "MCP"
description: "MCP 接入: JSON-RPC 2.0 协议与 stdio / streamable http / sse 传输, MCPClient / MCPManager 生命周期, 用户级与项目级配置与环境变量展开, mcp__ 命名与权限匹配, eager / native / dispatch 三种延迟加载模式, ToolSearch / McpCall, server instructions 公告与 remote 模式的 MCP Apps"
local_path: "$HOME/github/yukino-code/apps/yukino"
local_commit: "bef5439b54e6510a12da61bcfa4285ecb1cd2192"
---

MCP (Model Context Protocol) 是一个开放协议, 定义 AI 应用 (MCP Client) 与外部工具服务 (MCP Server) 之间的标准化通信方式。Yukino 的内置工具随 CLI 静态注册, 而外部工具通过 MCP 动态接入: 配置好 server, 连接建立后工具自动进入 ToolRegistry, 供 LLM 在后续轮次调用。本页覆盖协议与传输层、MCPClient / MCPManager 的实现、配置来源与校验、工具命名与权限、三种延迟加载模式 (eager / native / dispatch)、ToolSearch / McpCall、server instructions 公告, 以及 remote 模式的 MCP Apps。

代码分布:

- src/mcp/: client.ts (MCPClient)、manager.ts (MCPManager)、strategy.ts (加载模式决策)、tool-wrapper.ts (命名与包装)、instructions.ts / prompts.ts (instructions 公告)、apps.ts / constants.ts
- src/tools/tool-search.ts、src/tools/mcp-call.ts: 延迟加载的发现与分发入口
- 传输与协议原语来自 `@modelcontextprotocol/sdk`

## 协议基础

### 角色

- Host: AI 应用, 例如 Claude Code、Claude Desktop、Yukino
- Client: Host 内部的 MCP 连接组件, 负责与 Server 建立连接、收发请求; 一个 Client 对应一个 Server
- Server: 外部工具提供方

Yukino 作为 Host, 由 MCPManager 持有一组按名称索引的 MCPClient。

### 消息格式: JSON-RPC 2.0

无论走哪种传输, 消息统一为 JSON-RPC 2.0, 只有 3 种消息类型。

请求 (Request): 带 id、method、params, 期望响应:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "search_issues",
    "arguments": { "repo": "golang/go", "query": "error handling" }
  }
}
```

响应 (Response): id 与请求对应, result 或 error:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "content": [{ "type": "text", "text": "Found 233 issues..." }]
  }
}
```

通知 (Notification): 只有 method、params, 没有 id, 不期望响应。

### 协议原语

- Server 侧原语: tools、resources、prompts。Yukino 使用 tools (核心路径)、initialize 响应中的 instructions, 以及 resources/read (仅 MCP Apps 读取 UI 资源); 不使用 prompts
- Client 侧协议定义了 roots (工作区边界)、sampling (Server 反向请求 Host 调用 LLM)、elicitation (Server 请求 Host 向用户提问) 三类能力声明; Yukino 目前都不声明, 只在 remote 模式下声明一个 UI 扩展 (见 MCP Apps)

tools/list 返回的工具定义形如:

```json
{
  "name": "search_issues",
  "description": "Search github issues",
  "inputSchema": {
    "type": "object",
    "properties": {
      "repo": { "type": "string", "description": "Format: owner/repo" },
      "query": { "type": "string" },
      "state": { "type": "string", "enum": ["all", "open", "closed"] }
    },
    "required": ["repo"]
  }
}
```

### 完整会话 (以 stdio 为例)

1. 初始化握手: MCPClient 启动子进程后发送 `initialize` 请求, 声明协议版本、能力和身份信息 (clientInfo 为 `{ name: "yukino", version }`, version 是 Yukino 自身版本); Server 响应自己的版本、能力和 instructions。SDK 当前支持的最新协议版本是 `2025-11-25`
2. Client 发送 `notifications/initialized` 通知
3. Client 发送 `tools/list` 请求, 拉取全部工具定义并注册进 ToolRegistry, LLM 下一轮即可见
4. LLM 决定调用时, Client 发送 `tools/call`, 可重复 N 次

streamable http 传输在握手后的请求中还会携带 `mcp-protocol-version` 和 `mcp-session-id` 头部。

## 传输层: stdio / streamable http / sse

MCPClient 构造的 transport 是三者之一 (src/mcp/client.ts):

```ts
type MCPTransport =
  StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport;
```

### stdio

- 配置了 `command` 时启用: Client 将 Server 作为子进程启动, 通过 stdin/stdout 管道通信; 不需要监听端口、服务发现或身份认证
- env 合并: `{ ...process.env }` 再叠加配置的 `env` (同名覆盖), undefined 值补空串
- stderr 配置为 `"ignore"`: Yukino 直接丢弃子进程的 stderr, 不参与协议
- 消息是按换行符分隔的 UTF-8 JSON-RPC: 写端 `JSON.stringify(message) + '\n'`, 读端按 `\n` 切分
- 退出清理: process.exit / 未捕获异常路径不会 await 异步断开, stdio 子进程会变成孤儿; 因此连接建立时向 exit-cleanup 注册一个同步钩子, 直接 SIGKILL 子进程 PID, 正常 disconnect 时解绑

### streamable http (url 默认)

- 配置了 `url` 且未指定 `transport` 时使用 StreamableHTTPClientTransport; Server 是独立 HTTP 服务, 可以在本机也可以在远程
- POST 请求的 Accept 头同时声明 `application/json` 和 `text/event-stream`; Server 结果就绪直接返回 JSON, 需要流式时用 SSE 推送
- 会话通过 `mcp-session-id` 头部维持; `config.headers` 原样透传给 requestInit.headers (Bearer token 等认证放这里)

### sse (legacy)

- 配置 `transport: "sse"` 时走 SSEClientTransport, 用于尚未迁移到 streamable http 的旧 Server

## MCPClient

MCPClient 封装一个 Server 连接的完整生命周期。

- connect: `command` → stdio; `url` → http/sse; 两者都缺时报错 "needs either 'command' (stdio) or 'url' (http/sse)"; `enabled: false` 的配置直接拒绝连接
- listTools: 按 `nextCursor` 分页拉取, 用集合检测重复 cursor, Server 陷入分页循环时抛错; `inputSchema.properties` 缺省补 `{}`; 若工具的 `_meta.ui.visibility` 是数组且不含 `"model"`, 该工具只对 UI 可见, 从模型视图中过滤掉
- callToolResult: 发送 `tools/call`, 用 CallToolResultSchema 校验响应
- callTool: 在 callToolResult 基础上做内容转换, 并把 `isError` 透传成 ToolResult (见下节); 异常由 MCPToolWrapper 捕获并转成错误输出

### 结果内容转换 (mcpContentToToolOutput)

Server 返回的 content 是内容块数组, 逐块转换:

- image 块且 mimeType 属于 png / jpeg / gif / webp: 经 maybeResizeAndDownsampleImage 缩放降采样后转成 base64 image 内容块, 文本侧附 `[Image: 媒体类型]` 占位; 缩放失败 (超出 API 限制) 降级为文本说明
- image 块但 mimeType 不支持: 替换为 `[Unsupported image: 类型]` 文本
- text 块: 文本原样透传
- 其他内容: JSON.stringify 序列化为文本

所有文本片段用 `\n` 连接成 output; 只有包含图片时才返回 contentBlocks。

## MCPManager: 串行化的连接生命周期

MCPManager (src/mcp/manager.ts) 管理全部连接, 所有生命周期变更经 runExclusive 串行执行: 启动、重试、reload 不会互相竞态。

- connectAll(configs): 按名称去重后, 跳过 `enabled === false` 和已连接的 server, 其余并行执行 connect + listTools; 两步都成功才把 client 记入连接表, 否则断开并记入 errors。已连接的 server 不受影响, 重复调用等于只重试失败的
- reconnectAll(configs): 先全量断开, 再全量连接; 不做新旧配置 diff, 这是 `/mcp reload` 的路径
- ConnectResult: `{ tools, servers, errors, instructions }` 汇总本轮连接的产出
- 查询: connectedServers、connectedInstructions (各 server 的 instructions)、missingServers (配置了但未连接的)

## 各宿主接入点

- 交互 UI: initClient 完成工具装配后 fire-and-forget 发起 connectMcpServers, 不阻塞启动; 连接错误以 system 消息提示
- print 模式: 内置工具全部注册完成后才连接 MCP 并决定加载模式 (模式决策依赖全量 schema 体积, 注册不全会算不准); 错误写 stderr (`MCP warning: ...`)
- remote server: 以 `new MCPManager(true)` 创建, 启用 MCP Apps; A2A / ACP 运行时复用 createRemoteAgent, 同样启用; ACP 明确拒绝客户端在会话参数里自带的 MCP server 列表, 只用 Yukino 自己的配置

## 配置

两个来源:

- 用户级: `~/.yukino/config.yaml` 的 `mcp_servers` 数组, 所有项目生效
- 项目级: 工作目录下的 `.mcp.json`, Claude Code 兼容格式, 随仓库分发, 只对当前项目生效

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
// .mcp.json
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

MCPServerConfig 字段: `name`、`enabled`、`command`、`args`、`url`、`transport`、`headers`、`env`。

### 校验 (用户级配置)

- name 非空且全局唯一
- `command` 与 `url` 必须恰好配置一个: command → stdio, url → http/sse
- command server 的 transport 只能是 stdio 或省略; url server 的 transport 只能是 http 或 sse

### .mcp.json 解析

- 条目字段: `enabled` (默认 true)、`command`、`args`、`env`、`type` (stdio | sse | http)、`url`、`headers`
- `type` 显式指定优先; 缺省时从字段推断: 有 command 为 stdio, 否则为 http; stdio 条目取 command / args / env, http/sse 条目取 url / transport / headers
- 单个条目非法 (字段缺失、command 和 url 混配等) 只跳过该条并记日志, 不影响其余条目; 整个文件非法则整体忽略, 不阻塞启动

### 合并规则

withProjectMcpServers 把项目级 server 追加到用户级列表之后, 重名时用户级条目获胜: 项目文件随仓库分发、信任度更低。

### 环境变量展开 (expandEnv)

- 三种语法: `${VAR}`、`${VAR:-default}`、`$VAR`
- 作用于 command、args、url、env 的值、headers 的值; 展开生成配置副本, 不修改 process.env
- 引用了未设置的变量且无默认值时抛错, 该 server 连接失败 (而不是静默置空成空命令或空凭证)

## /mcp 与 /mcp reload

`/mcp` 在 commands.ts 注册为占位命令, TUI 和 remote server 各自按名称拦截并实现。

- `/mcp`: 若还没有 manager 输出 "No MCP servers configured."; 否则先用 connectAll 重试所有未连接的 server (`Connecting MCP server(s): ...`), 再输出状态: `MCP servers (N):` 列表、`Tools: M total`, 以及仍失败的 `Not connected: ...`
- `/mcp reload`: 重读磁盘配置并重建全部连接:
  1. 重新执行 `withProjectMcpServers(loadConfig(), cwd)`; 配置读取失败则报 `MCP reload failed: ...` 并中止, 现有连接保持完整
  2. server 列表为空: 断开全部连接、撤回 instructions 公告、移除所有 MCP 工具
  3. 列表非空: removeMcpTools 删掉全部 `mcp__` 包装器 (连带的 discovered 状态一并清除), retractMcpInstructions 撤回已公告的 instructions
  4. `reconnectAll(servers)` 全量断开再全量连接
  5. 重新注册 MCPToolWrapper; 若本会话已决策过加载模式则不重新决策, 只 applyMode 沿用既有模式, 让新注册的工具继承 defer 标志 (避免 tools[] 中途翻转破坏缓存)
  6. syncMcpInstructions 重新公告, 输出 `MCP reloaded: N server(s) connected, M tool(s)`

remote server 有等价的 reload 流程 (MCPManager 以 apps 启用模式创建)。

## 工具命名与注册

MCP 工具命名规范: `mcp__serverName__toolName`。sanitizeSegment 把 serverName 和 toolName 中非 `[a-zA-Z0-9_]` 的字符替换为下划线 (连字符 API 虽然允许, 也统一替换): 同一份 mcp_servers 配置在各语言实现中必须产出相同的工具名, 否则切换实现后 permissions.yaml 的规则就失配了。

```ts
export function sanitizeSegment(s: string): string {
  return s.replace(/[^a-zA-Z0-9_]/g, "_");
}

export function buildMcpToolName(serverName: string, toolName: string): string {
  return mcpToolNamePrefix(serverName) + sanitizeSegment(toolName);
}
```

按 server 过滤工具时使用 mcpToolNamePrefix (自带 sanitize), 不要手拼字符串。

MCPToolWrapper (src/mcp/tool-wrapper.ts) 把 MCPTool 适配成 Yukino 内部的 Tool 接口:

- `name` 为全名, `schema()` 输出原始 inputSchema; `mcpInputSchema()` 供 McpCall 纠型使用
- `category: "command"`, `deferred: true` (MCP 工具默认延迟加载, 见下文策略)
- `execute` 用原始工具名调用 `client.callTool`; 抛错时包装成 `MCP tool error: ...` + isError, 不打断 agent loop
- `setDeferLoading(on)` 由加载策略切换 defer 标志

连接通道产出的每个工具都包装成 `new MCPToolWrapper(client, serverName, tool)` 注册进 ToolRegistry; tools[] 的渲染规则见 [function-calling](./function-calling)。

## 权限

权限规则形如 `Tool(pattern)`: 括号左侧的工具名做精确匹配 (或全局 `*`), 括号内的 pattern 对该工具的 "匹配内容" 做 glob (`*` 匹配任意字符、`?` 匹配单字符)。两种调用路径的匹配内容不同:

- dispatch 模式经 McpCall 调用: 工具名固定是 `McpCall`, 匹配内容由 mcpCallPermissionContent 规范化为 `server__tool` (不带 `mcp__` 前缀)。模型无论传短名还是全名, 都得到一致内容, 因此规则 `McpCall(linear__*)` 可按 server 放行/拒绝整组工具, `McpCall(linear__create_issue)` 精确到单个工具
- eager / native 模式模型按全名 `mcp__server__tool` 直接调用: 此时工具名就是全名, 匹配内容为空, 规则要写完整工具名 (如 `mcp__github__search_issues()`)。工具名段是精确匹配, 不能用 `mcp__github__*` 这种前缀通配
- agent loop 执行 McpCall 时做双重检查: 先查 McpCall 本体 (内容 `server__tool`), 再查解析出的目标工具 (内层参数一并传入); pre-tool hooks 和权限 checker 都跑两遍, 任一 deny 即拒绝。特例: 若外层 McpCall 命中规则 allow, 而内层目标工具只是模式级 ask (reason 以 Mode: 开头), 则内层沿用外层的 allow, 避免重复询问
- 规则语法与决策层次见 [permission](./permission)

## 工具延迟加载

### 问题

配置几个 MCP Server 后工具数量容易膨胀到几十个, 每个定义几百 token, 全部塞进 tools[] 每轮都携带, 既占上下文窗口, 也拉低 LLM 的工具选择准确率。

更隐蔽的代价是 prompt cache: tools 渲染在 system 之后、messages 之前, 数组任何变化 (增删工具) 都使其后整段对话历史的缓存失效。strategy.ts 注释中的实测: 20k token 历史下, 仅在 tools 末尾追加一个工具, 缓存命中率从 99.4% 掉到 9.5%。

### 三种模式

MCP 连接完成、工具全部注册后, strategy.ts 一次性决定加载模式; 配置键是 `mcp_loading`, 取值 `auto` (默认) / `eager` / `native` / `dispatch`:

| 模式     | tools[] 中                     | 发现方式                          | 调用方式                     |
| -------- | ------------------------------ | --------------------------------- | ---------------------------- |
| eager    | 全量, defer 标志清除           | 直接可见                          | 直接调用                     |
| native   | 保留但带 `defer_loading: true` | ToolSearch 返回 tool_reference    | 直接调用 (服务端展开 schema) |
| dispatch | 完全省略                       | ToolSearch 返回 schema + 路由提示 | 经 McpCall 工具分发          |

decideMode 的决策顺序:

1. `mcp_loading` 非 auto: 按指定值; 但 native 是 Anthropic 线协议的能力, protocol 不是 anthropic 时强制降级为 dispatch
2. 没有任何 MCP 工具: eager (三种模式此时行为等价, eager 最简单)
3. 估算 token (schema 序列化总字符数 / 2.5) 低于 contextWindow 的 10%: eager, 全量加载的开销可接受
4. 否则: protocol 为 anthropic 且 base_url 是官方端点 (空, 即 SDK 默认地址, 或 host 为 `api.anthropic.com`) → native; 其他端点 (各家代理网关) → dispatch

measureSchemaChars 统计全部 `mcp__` 工具 `JSON.stringify(schema()).length` 之和, 序列化失败时用 name + description 长度兜底。

### applyMode 与稳定性约束

- 设置 `registry.mcpLoadingMode`; 对每个 MCP 工具 `setDeferLoading(!eager)`
- `exposeToolSearch = 模式非 eager`, `exposeMcpCall = 模式为 dispatch`; 两个开关只在模式决策时设定, 不逐轮重算 — 运行中工具可能被禁用, 重算会让工具从 tools[] 中途消失, 同样破坏缓存
- ToolSearch 和 McpCall 在 createToolRegistry (bootstrap/tool-registry.ts) 中注册, 先于任何 MCP 连接; McpCall 必须在连接建立前就在 tools[] 里, 否则连接后追加也是数组变更
- 交互 UI 在切换 provider、切换 model、载入登录配置时重新决策 (decideAndApply); 此后的重试通道和 reload 只 applyMode 沿用既有模式

### native 的线协议细节

- `defer_loading` / `tool_reference` 是 Anthropic 的 beta 能力: 工具留在 tools[] 中但服务端不向模型展示, 模型必须先经 ToolSearch 拿到 tool_reference 才能调用。请求需携带 `anthropic-beta: advanced-tool-use-2025-11-20`, 且仅当本批工具里确实存在 `defer_loading` 时才发送 — 不认识的端点见到该头部会直接拒绝
- MCP 工具被发现后也不标记 discovered, 保持 `defer_loading: true` 留在 tools[] 中, 数组字节级不变, 新工具发现不破坏缓存
- markToolsForCache 把 cache breakpoint 打在最后一个非 deferred 工具上: `defer_loading` 与 `cache_control` 同时出现在一个工具上会被 API 拒绝整个请求; MCP 工具注册在内置工具之后, 数组尾部常常是 deferred 工具, 所以要倒着找, 内置工具永不 defer, 断点必然存在
- OpenAI / openai-compat 协议没有 defer_loading: decideMode 层面 native 降级为 dispatch; getAllSchemas 层面也把未发现的 deferred 工具直接隐藏, 改由 ToolSearch + McpCall 兜底

## ToolSearch

ToolSearch (src/tools/tool-search.ts) 是延迟工具的发现入口, schema 为 query (必填) + max_results (默认 5, 夹取到 1..50)。

- `select:name1,name2`: 在延迟池中按名称精确查找, 大小写不敏感
- 其他 query: 对 name + description 做小写子串匹配, 按注册顺序返回前 max_results 个
- 命中的本地工具 (非 `mcp__`) 标记 discovered, 下一轮进入 tools[]
- native 模式: MCP 工具不做文本 schema 输出, 而是返回 `tool_reference` 内容块交给服务端展开; dispatch 模式: 返回完整 schema, 并追加 "经 McpCall 调用" 的路由提示; 其余情况提示可按全名直接调用
- 无命中: `No deferred tools matched the query.`

### 延迟工具引导 (system-reminder)

- 每个 agent loop 构建请求前, buildDeferredToolGuidance 生成引导: marker 为 `# Deferred tool guidance`, 内容含未发现延迟工具的排序名称列表和 `select:<name>[,<name>...]` 用法说明; dispatch 模式下若 McpCall 不可见, 不列出 `mcp__` 工具 (列了也无法调用)
- 经 addSystemReminderIfChanged 注入: 只有当同名 marker 的上一次 reminder 内容变化时才追加新消息, 避免每轮重复浪费窗口
- 延迟池清空时, 若历史中存在该 marker, 补发一条 "当前没有可发现的延迟工具" 的 reminder 覆盖旧列表, 防止模型继续引用已失效的名称

## McpCall

McpCall (src/tools/mcp-call.ts) 是 dispatch 模式的唯一调用通道, schema 为 server / tool / arguments 三者必填。

- resolveTarget: tool 接受短名或全名; 全名必须能在 registry 中找到且归属声明的 server, 防止借全名绕过路由; 未知工具报错并列出当前全部可用的 `mcp__` 工具
- prepareArguments: LLM 隔着 ToolSearch 返回的 schema 描述自由生成参数, JSON 类型漂移常见, coerceBySchema 按目标工具的 mcpInputSchema 逐层纠型:

| schema 声明      | 模型给了             | 纠型结果                       |
| ---------------- | -------------------- | ------------------------------ |
| string           | 数字 (非布尔)        | 转字符串                       |
| integer / number | 纯数字字符串         | 转整数 / 浮点 (不截断小数)     |
| boolean          | `"true"` / `"false"` | 转布尔                         |
| array            | 单键对象包裹的数组   | 解包内层数组                   |
| array            | 逗号分隔字符串       | 按逗号拆分并 trim              |
| object / array   | 对象 / 数组          | 按 properties / items 递归纠型 |

- 纠不动的值原样透传, 交给 MCP Server 报领域错误 — 服务端错误对模型比本地类型错误更有指导性; 四种语言的纠型规则逐条一致
- agent loop 在执行 McpCall 前先跑 prepareArguments, 再按双重权限检查 (见权限一节)

## Server instructions 公告

MCP Server 可以在 initialize 响应中携带 instructions (使用说明), 这是模型无法从工具 schema 推断的指引, 必须进入对话。Yukino 以增量方式公告 (src/mcp/instructions.ts):

- 不进 system prompt: MCP 连接晚于首轮请求, 动 system prompt 会破坏整段缓存前缀; 公告走 system-reminder
- marker 是 `# MCP Server Instructions`; syncMcpInstructions 计算增量: 新增 = 已连接且未公告的 server (按名称排序), 撤回 = 已公告但不再连接的 server; 无增量则不发任何消息
- 历史是公告状态的唯一事实来源: `/clear`、`/resume`、上下文压缩都会丢掉 reminder, marker 一旦从历史中消失就清空已公告集合并全量重发
- retractMcpInstructions 用空连接源调用 sync, 用于 `/mcp reload` 重建连接前撤回旧公告

## MCP Apps (remote 模式)

MCP Apps 让 Server 的工具返回可交互的 HTML UI, 只在 remote (浏览器) 场景启用: remote server 及 A2A / ACP 共用的 createRemoteAgent 以 `new MCPManager(true)` 创建, 交互 UI 和 print 模式都是 false。

### 协商与载荷

- appsEnabled 的 client 在 initialize 中声明扩展 `io.modelcontextprotocol/ui`, mimeTypes 为 `["text/html;profile=mcp-app"]`
- 工具通过 `_meta.ui` 声明 UI 元数据: `visibility` 是数组时, 不含 `"model"` 的工具不暴露给模型 (UI-only, listTools 阶段过滤); `resourceUri` 以 `ui://` 开头表示该工具带 app 资源
- callTool 成功且 appsEnabled、resourceUri 合法时, ToolResult 附带 mcpApp 载荷 (serverName、toolName、resourceUri、arguments、原始 result), 随 agent 事件和 remote WS 的 tool_result 消息传到浏览器

### 浏览器渲染 (McpAppView)

- 经 `read_resource` 请求拉取 resourceUri 对应的 HTML (mimeType 必须匹配), 清洗: 移除 `<base>` 元素, 注入由 `_meta.ui.csp` 构造的 CSP meta
- 以 `sandbox="allow-scripts"` 的 iframe + srcdoc 加载, 通过 `@modelcontextprotocol/ext-apps/app-bridge` 的 AppBridge (postMessage 传输) 握手, 有初始化超时; 握手成功后把工具输入和 result 推送给 app
- app 的回调经浏览器转发: oncalltool / onreadresource → `mcp_app_request` WS 消息; onmessage → 送入聊天输入框; onopenlink 只放行 http/https 并在新窗口打开; sizechange 事件在上下限之间调整 iframe 高度

### 服务端网关 (RemoteMcpApps)

remote server 的 `mcp_app_request` 消息统一经 RemoteMcpApps.request 处理:

- 前置校验: 请求所属 sessionId 与当前一致、对应 server 的 client 实例未被替换, 否则判定过期
- read_resource: 直接转发 MCPClient.readResource
- call_tool: 目标工具必须存在; `visibility` 是数组时必须包含 `"app"`; 通过会话的 toolFilter; 触发 pre-tool hooks; 权限 checker 决策 — deny 拒绝、ask 走交互式审批 (allowAlways 持久化规则) — 全部通过后才执行 callToolResult

WS 消息类型与 remote 架构见 [remote](./remote)。
