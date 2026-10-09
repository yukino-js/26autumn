---
title: "Yukino Agent Proxy：单二进制双编码 Agent 的协议网关"
description: "一个二进制以 --agent 代理 Claude Code 或 Codex，在 Anthropic Messages、OpenAI Responses、Chat Completions 三种协议之间双向桥接，并负责 provider 选择、客户端配置注入与备份、常驻进程管理、MCP 控制面、滚动发布与凭据卫生。"
local_path: "$HOME/github/yukino.go/apps/agent_proxy"
---

编码 Agent（Claude Code、Codex）各自只会说一种线上协议，而模型供应商可能只提供另外两种中的一种。Yukino Agent Proxy 用一个 Go 二进制、一个 `--agent=claude|codex` 开关，把「客户端协议」与「上游协议」解耦：客户端只看见自己能理解的端点，网关在请求与响应两个方向做协议翻译，并顺带完成 provider 选择、连通性预检、客户端配置备份改写、常驻进程生命周期管理与 MCP 控制面。本文讲清它的协议矩阵、桥接转换规则、启动与恢复语义、配置注入的安全约束，以及发布与回退方式，适合需要接入第三方模型、做本地推理网关或研究协议互操作实现的工程师阅读。

## 定位与整体形态

它解决的是一个具体的工程问题：让 Claude Code 与 Codex 都能使用任意 OpenAI 兼容或 Anthropic 兼容的模型服务，而不修改客户端本身。两个方向恰好镜像：

| `--agent` | 客户端      | 客户端侧协议       | 默认监听          | 可用上游协议                                                                      |
| --------- | ----------- | ------------------ | ----------------- | --------------------------------------------------------------------------------- |
| `claude`  | Claude Code | Anthropic Messages | `127.0.0.1:17861` | anthropic（直连） / openai（Responses 桥） / openai-compat（Chat Completions 桥） |
| `codex`   | Codex       | OpenAI Responses   | `127.0.0.1:17862` | openai（Responses 透传）/ openai-compat（Chat 桥）/ anthropic（Messages 桥）      |

选择 anthropic 协议且代理 Claude Code 时，网关不参与推理流量：它把客户端配置直接指向真实上游地址（direct 模式），本地服务只承担管控与状态职责。其余组合都会把流量引到本地回环端点，由桥接层双向翻译。

```text
Claude Code ──Messages──► yukino-agent-proxy ──┬─► Anthropic Messages  (direct: 仅本地管控)
                                                ├─► OpenAI Responses     (本地双向翻译)
                                                └─► Chat Completions    (本地双向翻译)

Codex CLI ──Responses──► yukino-agent-proxy ───┬─► OpenAI Responses     (本地转发, 校验终态)
                                                ├─► Chat Completions    (本地双向翻译)
                                                └─► Anthropic Messages  (本地双向翻译)
```

除协议翻译外，网关承担四类职责：从统一的 provider 配置文件选择上游并做连通性预检；备份并改写客户端配置，把 base URL、模型别名、上下文窗口注入进去；以守护进程方式常驻并暴露带鉴权的本地控制面；提供 stdio MCP 工具，让其他 Agent 能启动、查看、停止代理。HTTP 服务面复用了同仓库的 `yukino_http` 应用框架（`New()` 加 `Recovery()` 中间件）。整个网关是一个独立的 Go module（`go.mod` 声明 `go 1.26.4`，经相对路径 `replace` 引用 `libs/yukino_http`），直接依赖只有八个：`anthropic-sdk-go` v1.59.0、`openai-go` v1.12.0、`modelcontextprotocol/go-sdk` v1.8.0、`klauspost/compress` v1.19.2（zstd 请求体解码）、`pelletier/go-toml/v2` v2.4.3（Codex config.toml）、`gopkg.in/yaml.v3` v3.0.1（provider 配置）、`golang.org/x/sys` v0.47.0（Windows 进程与文件锁）与 `yukino_http`。

一次代理请求的完整链路如下，转换与转发共享同一条流水线，协议选择只改变其中的翻译环节：

```text
客户端 (Claude Code / Codex)
  │  原始请求 JSON (≤32 MiB)
  ▼
服务面 (yukino_http)
  │  校验形状与 stream 类型 → 读 body
  ▼
请求桥 (bridge.Request)
  │  校验角色/参数 → 替换模型别名 → 按上游协议转换
  │  · anthropic:  原样透传
  │  · openai:     构造 Responses input / instructions / tools
  │  · openai-compat: 构造 Chat messages / tools / 推理力度
  ▼
传输层 (upstream.Client)
  │  低层 Post, 关闭重试, 透传 anthropic-* 头, 强制 identity 编码
  ▼
上游供应商
  │  非流式 JSON 或 SSE 事件流
  ▼
响应桥 (bridge.Response / bridge.Stream)
  │  · 非流式: 归一为 Messages 形状
  │  · 流式:   经 SSE 事件生成器逐块翻译
  │  · 探测到 JSON/SSE 与请求不符: 走四象限容错
  ▼
客户端 (SSE 心跳每 15s, 失败发 error 事件, 不伪造成功终态)
```

## 配置模型与 provider 选择

网关只读取统一配置文件中的 provider 列表，有意忽略同一文件里其他 Yukino 配置节。Provider 共八个字段：

| 字段                | 含义                     | 约束                                                        |
| ------------------- | ------------------------ | ----------------------------------------------------------- |
| `name`              | 供应商标识               | 非空；允许重名，选择时首个匹配获胜                          |
| `protocol`          | 上游线上协议             | 枚举 `anthropic` / `openai` / `openai-compat`               |
| `base_url`          | 上游 API 根地址          | 必须 HTTP(S)、有主机名、不含凭据/query/fragment             |
| `model`             | 模型标识                 | 非空                                                        |
| `api_key`           | 凭据                     | 支持 `${ENV}` 展开；为空时按协议回退到环境变量              |
| `thinking`          | 思考力度                 | 枚举 `off`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max` 等 |
| `context_window`    | 声明给客户端的上下文窗口 | 非负；仅在大于 0 时下发                                     |
| `max_output_tokens` | 输出上限                 | 非负                                                        |

选择规则由两个可选过滤器（`--protocol`、`--name`）组合决定：

| 提供的过滤器 | 选中的 provider                                     |
| ------------ | --------------------------------------------------- |
| 都不给       | `providers[default_provider]`，索引缺省 0，越界报错 |
| 只给协议     | 第一个协议匹配项                                    |
| 只给名字     | 第一个名字匹配项（跨协议）                          |
| 两者都给     | 第一个同时匹配项                                    |

`default_provider` 必须是 YAML 裸整数：反序列化时检查节点标签，拒绝小数、引号字符串、布尔、null 与列表。校验采用「首个匹配项非法即整体失败」原则，绝不跳过非法项去选下一个，避免静默使用意料之外的供应商。

校验阶段还有几处值得注意的细节。`thinking` 统一转小写，`enabled` 与 `adaptive` 归一为 `high`。`api_key` 先做环境变量展开，仍为空则按协议回退：anthropic 读 `ANTHROPIC_API_KEY`，openai 与 openai-compat 读 `OPENAI_API_KEY`；两者都空则失败。YAML 解析错误刻意不回显原文，因为原文里可能包含 api_key。这两点合起来保证了一件事：凭据既不会因为配置校验失败而泄漏到错误输出，也不会静默缺失。

## Agent 抽象与注册表

两个 Agent 的差异被收敛到一个窄接口上，daemon、MCP、CLI 都只面向该接口：

| 方法                             | 作用                                      |
| -------------------------------- | ----------------------------------------- |
| `Name` / `SettingsLabel`         | 标识与展示名                              |
| `DefaultDir`                     | 客户端配置目录（受环境变量影响）          |
| `DefaultListen` / `StateDirName` | 默认回环端口与状态目录名                  |
| `Configure`                      | 备份并改写客户端配置，返回备份路径        |
| `NewApp`                         | 构造该 Agent 的服务面                     |
| `Check`                          | 连通性预检                                |
| `Mode` / `BaseURL`               | 直连或代理模式，以及写给客户端的 base URL |

`claude` 在 anthropic 协议下 `Mode` 为 direct、`BaseURL` 用 provider 地址，其余为 proxy；`codex` 恒为 proxy，`BaseURL` 在本地地址后追加 `/v1`。注册表方法只接受 `"claude"`、`"codex"` 两个值，空串报「必须指定 agent」，其他值报「未知 agent」。新增一个 Agent 只需实现接口并登记，进程管理、备份时序、MCP 工具无需改动。

## 守护进程生命周期

### 命令面与参数

CLI 使用标准库 `flag`，子命令为 `start`（缺省）、`status`、`shutdown`、`mcp`，另有一个隐藏的 `_serve` 供后台子进程使用。解析器允许开关写在子命令之前，例如 `--agent=codex status`。公共开关包括：

| 开关                    | 缺省与说明                                                                              |
| ----------------------- | --------------------------------------------------------------------------------------- |
| `--agent`               | `claude` 或 `codex`                                                                     |
| `--protocol` / `--name` | 可选过滤；显式空串被拒绝                                                                |
| `--config`              | `~/.yukino/config.yaml`                                                                 |
| `--agent-dir`           | Claude 取 `$CLAUDE_CONFIG_DIR` 否则 `~/.claude`；Codex 取 `$CODEX_HOME` 否则 `~/.codex` |
| `--state-dir`           | `~/.yukino/<agent>-proxy`                                                               |
| `--listen`              | 回环地址与端口；端口 0 表示自选空闲端口                                                 |
| `--foreground`          | 前台运行而非后台守护                                                                    |
| `--expected-provider`   | 仅 `_serve` 使用的 provider 指纹                                                        |

解析器先用初始 agent 计算一版默认值，解析完最终 `--agent` 后再重算 agent 相关默认值，同时保留用户显式覆盖的项。显式空串的 `--protocol=`/`--name=` 会通过 flag 访问记录与「未提供」区分开并被拒绝。配置路径与状态路径不得为空，统一转为绝对路径。进程接收 SIGINT/SIGTERM 并触发取消。

### 启动协议：先检查，后产生副作用

后台启动的时序刻意设计成「任何副作用之前先验证」：

1. 载入配置、选择 provider，并对上游做一次连通性预检。失败则零副作用退出，不碰客户端任何文件。
2. 获取跨平台文件锁 `<state-dir>/manager.lock`，避免并发启动。
3. 若已有状态文件，则按四元组判断幂等：agent 名、provider 指纹、监听地址、客户端目录全同则直接返回现状，不再备份；否则先停旧服务再启新服务。控制面不可达但进程仍存活时要求人工检查；进程已死则清理陈旧状态文件。
4. 打开 `<state-dir>/proxy.log`（0600），以脱离会话的方式启动子进程 `_serve`，参数携带 agent、配置、目录、状态目录、监听地址与 provider 指纹。
5. 以 50ms 轮询状态文件与控制端点，10 秒内未就绪即报可诊断错误；子进程提前退出同样报错。

`_serve` 子进程的顺序是「先监听、后改配置」：若带 `--expected-provider`，重新选择 provider 并比对指纹，不一致则报「校验后 provider 已变化，请重新启动」。这一步消除了父进程预检与子进程真正监听之间的 TOCTOU 窗口。随后校验监听地址必须是回环 IP、完成监听、构造服务面、注入控制中间件、改写客户端配置、写入状态文件、释放启动锁。任何早期失败都不会修改用户配置。退出时先取消服务的基础上下文，掐断在途的上游流，再以 10 秒超时优雅排水，失败则强制关闭。清理状态文件只在「控制 token 仍是自己」时执行，避免误删新一代守护进程的状态。

状态文件为 0600 原子写入，包含运行状态、控制 token、provider 指纹、请求的监听地址与客户端目录；没有独立 PID 文件。读取时会拒绝属于另一个 Agent 的状态文件。

### 停止与状态查询

`shutdown` 加锁后向控制面发送停止请求，轮询等待状态文件被服务自行删除，超时 15 秒。它打印固定文案，明示客户端配置与备份保持不动——恢复是显式的手工动作。`status` 在无状态文件时返回未运行；控制面失败但进程已死时返回存档状态并标记未运行。

### 平台差异

| 能力         | Unix                          | Windows                                                             |
| ------------ | ----------------------------- | ------------------------------------------------------------------- |
| 脱离会话     | `Setsid`                      | `DETACHED_PROCESS                                                   | CREATE_NEW_PROCESS_GROUP`，隐藏窗口 |
| 存活判定     | `kill(pid, 0)` 且非 `ESRCH`   | `OpenProcess` 加退出码；`STILL_ACTIVE` 视为存活，拒绝访问也视为存活 |
| 启动失败回收 | 发送 SIGINT                   | 直接终止                                                            |
| 文件锁       | `flock` 非阻塞独占，50ms 重试 | `LockFileEx` 独占，锁冲突时重试                                     |

## 配置注入与备份策略

两个 Agent 的配置注入共享同一套纪律：先以原始字节备份，再做最小化的字段替换；无关设置全部保留；`shutdown` 永不自动恢复；写盘一律原子替换。

### Claude Code：settings.json

Claude Code 的配置是一个 JSON 对象。注入流程为：

1. 把原始字节备份到同目录带时间戳的 `.bak` 文件（0600）。原文件不存在时备份一份 `{}`，使备份路径始终有效。
2. 删除与路由冲突的键：`env` 中的 API key、auth token、Bedrock/Vertex/Foundry 开关、子代理模型，以及顶层的 `model` 与 `apiKeyHelper`。
3. 路由注入分两种模式。anthropic 直连时写真实上游 base URL 与真实 API key；OpenAI 两种协议时写本地代理 URL，并把 auth token 设为占位符 `YUKINO_PROXY_MANAGED`，上游 key 不落盘。
4. 模型别名：把主模型、小快模型、Haiku/Sonnet/Opus 默认模型五个环境变量统一设为选中模型。
5. 上下文窗口：`context_window` 大于 0 时写入 `CLAUDE_CODE_MAX_CONTEXT_TOKENS`，让 Claude Code 对自定义模型 ID 按声明窗口做主动压缩，而不是假设默认窗口；字段缺省或为 0 时先无条件删除旧值，清除上一个 provider 的覆盖。

注意 direct 与 proxy 模式的凭据去向差异：只有 anthropic 直连会把真实 key 写进客户端配置，其余模式写占位符，真实 key 只存在于网关进程内存与 provider 配置文件中。

### Codex：config.toml 与模型目录

Codex 配置是一个 TOML 表。注入流程为：

1. 原始字节备份到带时间戳的 `.bak`（以 `O_CREATE|O_EXCL` 0600 创建，原文件不存在则备份为空文件）。TOML 非法则直接报错且不改原文件。
2. 删除保留内置 provider id（`openai`/`ollama`/`lmstudio`）的覆盖——新版 Codex 拒绝自定义项遮蔽内置 ID。
3. 写入自定义 provider：`base_url` 为本地网关加 `/v1`，`wire_api` 为 `responses`，bearer token 为占位符，`requires_openai_auth` 与 `supports_websockets` 均为 false。
4. 顶层写入 `model_provider`、`model`、指向模型目录 JSON 的 `model_catalog_json`，并禁用 `web_search`；删除旧的路由覆盖键；`context_window` 大于 0 时写 `model_context_window`。
5. 清理所有 profile 中的路由与模型覆盖键，使分层 profile 一律继承代理，同时保留命令行覆盖的可超越性。
6. 生成模型目录 JSON：声明上下文窗口、六档推理力度、shell 类型、并行工具调用、输入模态（文本与图像）、禁用搜索工具、有效上下文窗口百分比等，供 Codex 渲染模型能力。

同样地，Codex 的 `auth.json` 从不触碰。TOML 重编码会改变格式并丢失注释，原始字节在备份里保留。

两处实现各自持有一份私有的原子写入函数（同目录临时文件、chmod 0600、写、`fsync`、关闭、`rename`），语义与守护进程状态文件使用的公共私有写入一致。

## Claude Code 侧服务面与转换

### 路由与请求约束

| 路由                                   | 方法     | 行为                                                                                |
| -------------------------------------- | -------- | ----------------------------------------------------------------------------------- |
| `/v1/messages`、`/messages`            | POST     | 主推理端点                                                                          |
| `/v1/messages/count_tokens`            | POST     | anthropic 直连时改写模型后转发上游；OpenAI 两种协议返回 501，桥不声称拥有精确分词器 |
| `/health`                              | GET      | 健康响应，服务名固定为 `yukino-agent-proxy`                                         |
| `/v1/models`                           | GET      | 单模型列表                                                                          |
| `/_yukino/status`、`/_yukino/shutdown` | GET/POST | 管理面，需持有控制 token                                                            |

推理路由不校验 API key，安全模型是「只绑回环 IP」：启动时强制校验监听主机是回环地址，否则拒绝启动。请求体上限 32 MiB，要求恰好一个 JSON 对象，`stream` 必须是布尔。上游 HTTP 超时 10 分钟；SSE 每 15 秒发送心跳注释行；HTTP 服务的读头超时 10 秒、空闲超时 90 秒。

上游错误按状态码映射为 Anthropic 错误类型（400/404/422 为 `invalid_request_error`，401、403、429、529 分别映射为认证、权限、限流、过载错误，其余为 `api_error`），透传 `Retry-After`，并把错误文本中的 API key 替换为 `[redacted]`。

### 请求转换：Messages 到 Responses / Chat Completions

入口先做通用校验：消息非空、`max_tokens` 为正整数（拒绝无穷与小数）、每条消息角色合法；客户端传的模型别名一律替换为选中模型；`max_output_tokens` 大于 0 时对输出封顶。随后按上游协议分派：anthropic 原样透传，openai 走 Responses 构造，openai-compat 走 Chat 构造。

两个方向都要处理 Claude Code 的对话中间 `system` 消息：保留其角色与位置，不把它折叠进系统提示。顶层 `system` 另有专门处理：拼接文本、剥掉计费头行，Chat 侧变成首条 system 消息，Responses 侧变成 `instructions`。

Chat Completions 方向的关键映射：

| 客户端字段                         | 上游字段                            | 说明                                        |
| ---------------------------------- | ----------------------------------- | ------------------------------------------- |
| `stop_sequences`                   | `stop`                              | 直接改名                                    |
| 流式请求                           | 注入 `stream_options.include_usage` | 保证拿到用量                                |
| `max_tokens`（支持 effort 的模型） | `max_completion_tokens`             | 判定前缀包括 `o1`/`o3`/`o4`/`gpt-5`/`gpt-6` |
| `tool_use` 块                      | assistant 的 `tool_calls`           | arguments 为 JSON 字符串                    |
| `tool_result`                      | `role:"tool"` 消息                  | 其中的 image 块拆为独立 user 消息           |
| thinking                           | `reasoning_effort` 或供应商扩展     | 三层优先级见下                              |

thinking 的决策链有三层：请求级 `output_config.effort` 优先（`max` 归一为 `high`）；否则请求的 `thinking.type` 为 enabled/adaptive 时按 `budget_tokens` 分档（小于 4000 为 low，小于 10000 为 medium，否则 high）；再否则用 provider 配置的 `thinking`（低到 xhigh 直传，`true`/enabled/adaptive/max 归一为 high，其余不发）。对 DeepSeek 与 MiMo（按 base URL 与模型名识别）保留 assistant 历史的 `reasoning_content`；DeepSeek 主机按其文档写 `thinking` 扩展，阿里云 Qwen 写 `enable_thinking` 布尔；强制工具选择时禁用本次 thinking。

Responses 方向的关键映射：`max_output_tokens` 取 `max(16, max_tokens)`；`store=false` 并请求 `include=["reasoning.encrypted_content"]`——这是无状态推理回放的基础；文本、图像、文档分别映射为 input_text/input_image/input_file，`tool_use` 变成独立的 `function_call` item，`tool_result` 变成 `function_call_output`，`stop_sequences` 无对应物直接省略。此外还有两处结构性处理：Responses 要求 reasoning item 后面必须跟随 assistant 消息或函数调用，因此对每条 assistant 消息从后往前扫描，删除没有后继的孤儿 reasoning；Anthropic 托管工具（web_search 等非自定义类型）直接报错，批处理工具静默跳过，缺 schema 的工具补空对象，`tool_choice` 与并行开关按语义翻译。

### 无状态推理信封

Responses 的 reasoning item 携带加密状态（`encrypted_content`），回放历史时必须原样返回才能延续推理。Claude 侧的做法是把整个 reasoning item 的 JSON 做 base64 RawURL 编码，塞进 Anthropic 块的「签名」字段，前缀为：

```text
yukino-openai-reasoning-v1:<base64(RawURL)(reasoning item JSON)>
```

无摘要文本时放进 `redacted_thinking` 块的 data 字段；有文本时放进 `thinking` 块的 signature 字段；无加密但有文本时退化为裸 thinking 块。下一轮请求转换时逆向解信封，还原原始 reasoning item 回传。整个代理因此不需要任何持久会话状态，这是它能在无状态 HTTP 之上正确回放跨协议推理的关键。

### 响应转换：非流式与流式

非流式响应从 Chat 的 `choices[0].message` 或 Responses 的 output items 归一成 Messages 形状：function_call 变 tool_use，reasoning 变信封块，status 为 failed/cancelled 时报错，incomplete 取 incomplete 原因（缺省为输出上限）。用量字段统一归一，并把缓存读写计数折算回 Anthropic 的 cache 计数。

流式转换围绕一个 Anthropic SSE 事件序列生成器展开：`message_start`、若干 `content_block_start/delta/stop`、`message_delta`（含 stop_reason 与 usage）、`message_stop`，收尾幂等。两个上游流式解析器都汇入它：

- Chat 流解析 `chat.completion.chunk` 序列，见到 `[DONE]` 前必须出现过 finish_reason；任意 chunk 的 usage 都合并；`delta.reasoning_content` 变 thinking 流；tool_calls 按 index 缓冲，旧式 function_call 归并到索引 0。
- Responses 流维护 item_id 与输出索引的双向别名表，兼容只给其一的网关；reasoning 摘要只累积、在其 output item 完成时一次性发出；工具调用仅在 id 与 name 齐备时触发；`response.completed`/`incomplete` 时按 output 数组全量重放兜底。

并行工具调用的正确性有额外约束：每个工具调用按上游 key 独立缓冲，按创建顺序只发射就绪的块；完成时的全量参数必须与已流式部分保持前缀关系，否则报「上游替换了已流出的工具参数」，避免客户端收到错乱的参数。

网关怪癖容错构成「四象限」互补：上游对流式请求返回 JSON 时，把完整 JSON 拆成规范 SSE 事件序列；上游对非流式请求返回 SSE 时，用收集器把事件重组成 JSON（要求见到终态、块索引连续），服务面通过嗅探首字节决定走哪条路。流失败时发 Anthropic 错误事件，绝不伪造成功的 `message_stop`。

## Codex 侧服务面与转换

### 路由与请求约束

| 路径                                          | 方法 | 行为                                            |
| --------------------------------------------- | ---- | ----------------------------------------------- |
| `/responses`、`/v1/responses`                 | POST | 推理入口                                        |
| 同上                                          | GET  | 返回 426，明示不支持 WebSocket，只支持 HTTP/SSE |
| `/responses/compact`、`/v1/responses/compact` | POST | 压缩路由                                        |
| `/models`、`/v1/models`                       | GET  | 静态单模型列表                                  |
| `/health`                                     | GET  | 健康响应                                        |

请求体上限 32 MiB，支持 identity、gzip、zstd 三种内容编码（zstd 解码内存上限 64 MiB、并发 1），JSON 必须恰为一个对象。流式编排同样遵循四象限：流式请求配上游 SSE 则增量转发；流式请求配上游 JSON 则整体转换后重放为事件序列；非流式配上游 JSON 直接转换返回；非流式配上游 SSE 则聚合为完整 JSON，缺少终态即报错。流转错误且客户端未取消时补发 `response.failed` 事件；转换协议成功后写入历史缓存。

### 请求转换：Responses 到 Messages / Chat Completions

入口校验输入形状与输出上限的正性，强制替换模型名，收集工具定义（openai 原生协议容忍工具构建失败，转换协议则报错）。两条决议链值得注意：

- 输出上限：请求值、provider 值、默认 8192 依次回退，再被 provider 与上下文窗口封顶。
- 推理力度：请求的 `reasoning.effort`、provider 的 `thinking`、默认 high 依次回退，`true` 归一为 high，`off`/`false` 归一为 none。

openai 原生分支保留全部原始字段，未知字段与未知工具类型都容忍，只按需写回输出上限、注入推理力度，并处理三类信封退化：压缩触发项注入压缩提示 user 消息；压缩信封项展开为「上一轮对话摘要」文本；带自定义前缀信封的 reasoning 项退化为 assistant 文本消息，而原生 OpenAI 加密状态原样保留。

Anthropic 分支的关键规则：

- thinking 预算按力度分档：minimal/low 为 2048，high 为 16384，xhigh/max 为 24576，其余（含 medium）为 8192。非自适应模型使用 `{type:"enabled", budget_tokens}` 时，预算被限制为不超过输出上限的一半，且需不小于 1024 才启用。
- 模型族判定决定自适应行为：自适应族走 `{type:"adaptive"}` 加 `output_config.effort`；必须思考的族在强制工具选择时直接报错，其他模型强制选择时禁用 thinking。
- 力度映射把 none/minimal 抬为 low，把特定模型上的 xhigh 抬为 max。
- 启用 thinking 时删除 temperature 与 top_p。
- 工具选择与并行开关按语义翻译；首条消息不是 user 时注入续写提示。

Chat Completions 分支按模型名决定用 `max_completion_tokens` 还是 `max_tokens`，非 none 的力度写成 `reasoning_effort`，对 DeepSeek 走其 thinking 扩展，把 Responses 的文本格式映射为 `response_format`，流式时注入用量统计。

### 工具展平

Codex 的工具形态比 Chat/Anthropic 更丰富（命名空间嵌套、自定义文本工具、工具搜索）。桥接层统一展平为函数：

- 命名空间与名字拼接为 `ns__name`；超过 64 字符时截断为前缀加 sha256 前 8 字节的十六进制，保证在上游长度限制内且几乎不冲突；展平后冲突直接报错。
- 自定义工具包成函数，schema 为单个字符串入参，描述追加原始定义；工具搜索物化为查询函数；递归展开命名空间工具的 children；web_search 类工具被静默丢弃（配置层禁用与桥接层禁用双重保障）。
- 上游回调经还原函数变回 Responses item：普通调用变 `function_call`，自定义调用变 `custom_tool_call`，工具搜索变带客户端执行的 `tool_search_call`，命名空间字段复原。

### 续接缓存

Responses 协议支持用 `previous_response_id` 续接，但转换后的上游没有 OpenAI 侧的存储，网关用进程内缓存补上（重启即失）：

- 以响应 id 为键保存该轮的输入与输出；单条超过 32 MiB 不记录；FIFO 淘汰，上限 128 条或 64 MiB。
- 请求带 `previous_response_id` 且命中时，用缓存内容前置展开并删除该字段；未命中报错要求重发完整历史。
- Codex 有时只发工具结果而不带原调用。对每个输出 item，若其 call_id 不在当前输入且在历史中唯一命中，则把该次输出的签名思考与调用按原顺序插回该结果之前；非唯一命中不修复，宁可失败也不猜测。

### 三个自描述信封

| 前缀                            | 承载内容                                         |
| ------------------------------- | ------------------------------------------------ |
| `yukino-anthropic-thinking-v1:` | Anthropic 签名或脱敏 thinking 块，用于跨轮跳回放 |
| `yukino-codex-compaction-v1:`   | 压缩摘要，压缩路由的产物                         |
| `yukino-chat-reasoning-v1:`     | Chat Completions 的推理文本                      |

它们都用 base64 RawURL 编码，属于网关自定义状态，不是 OpenAI 的加密状态。把 Anthropic 的思考块包成 reasoning item，保证签名思考能在 Responses 历史中回放；流式侧把签名增量累加进源块，保证签名完整。

### 压缩路由

压缩路由在 openai 原生协议下直接转发上游压缩端点并校验响应形状；在转换协议下追加一个压缩触发项、强制非流式，让上游模型产出交接摘要，结果统一伪装为单个压缩 item（摘要文本装进压缩信封），响应对象类型标记为压缩。摘要在后续请求中经信封退化展开。

## 共享传输层与连通性预检

两个 Agent 共享同一套上游传输层，其设计目标是「不丢失未知字段」：

- base URL 规范化：anthropic 端点若以 `/v1` 或 `/messages` 结尾则剥成 messages 路径；OpenAI 仅主机名的 URL 补 `/v1`，完整端点路径则剥掉再重拼。
- 只取官方 SDK（`anthropic-sdk-go` 与 `openai-go`）的传输能力：以低层 `Post` 发送原始 JSON 并拿回原始 `*http.Response`，不解码到 SDK 类型，因此未知识别字段不会丢失；anthropic 直连的非流式响应甚至原样透传字节。
- 所有 SDK 一律关闭自动重试（重试语义由调用方负责）；Anthropic 客户端清空 auth token，确保只发 `x-api-key`；转发前删除下游的 Authorization 头并透传 `anthropic-version`、`anthropic-beta`；OpenAI 路径强制 `Accept-Encoding: identity`，防止 gzip 破坏 SSE 的逐包转发。

连通性预检在两个 Agent 上各有取舍：

| Agent  | 超时  | 请求                              | 成功判定                                                                                                                    |
| ------ | ----- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Claude | 10 秒 | 16 token 输出预算的流式小请求     | 首个有效事件（anthropic 看 `message_start`，chat 看首个 delta，responses 看创建/进行中/完成事件），见到即关闭连接以取消上游 |
| Codex  | 20 秒 | 128 token、力度 none 的流式小请求 | 非流式走响应转换；流式要求收集器拿到完整终态                                                                                |

两者都走与真实请求完全相同的转换路径，因此能发现「协议配置错误」这类只靠 TCP 可达性发现不了的问题。所有失败消息只含固定文案与 provider 名，绝不带上游响应体或凭据。该检查会产生小额账单，这是它的固有成本。

## MCP 控制面

网关以 stdio 传输暴露官方 MCP SDK 服务器，注册三个工具，让一个 MCP 会话能独立地启动、查看、停止两个 Agent：

| 工具             | 入参                       | 行为                                                            |
| ---------------- | -------------------------- | --------------------------------------------------------------- |
| `start_proxy`    | 可选 agent、protocol、name | 走与 CLI 相同的选择、预检、备份、启动或切换流程，返回结构化状态 |
| `shutdown_proxy` | 可选 agent                 | 停止所选 Agent 的服务，返回中明示「配置未恢复」                 |
| `proxy_status`   | 可选 agent                 | 返回 agent、provider、模型、PID、端点与备份路径，不含凭据       |

每个工具都接受 `agent` 参数，省略时使用服务端自身的 `--agent`；空串与未知值被拒绝。切换 Agent 时只重算 agent 相关默认值（客户端目录、状态目录、监听地址），保留显式的运行时覆盖。代理进程独立于 MCP 会话存活，因此会话断开不影响已启动的服务。注册到客户端时使用通用的 `mcpServers` JSON 配置：`command` 为二进制绝对路径，`args` 携带 `--agent=claude|codex` 与 `mcp` 子命令；服务端自身的 `--config` 在所有调用间共享。

## 安全模型与凭据卫生

- 只绑回环：监听地址非回环 IP 直接拒绝启动；推理路由因此不做 key 校验，客户端配置里的 token 只是占位符。
- 管理面隔离：控制端点要求 Bearer 控制 token，用常数时间比较；token 在启动时用加密随机数生成、只存于 0600 状态文件；CLI 的控制调用 1 秒超时、显式禁用代理与重定向、响应体限 1 MiB。
- 凭据不落错误输出：api_key 的 JSON 序列化被标记为永不输出；YAML 解析错误不含原文；错误文本统一做 key 脱敏；预检失败只报固定文案；转发上游时会删除下游 Authorization 头，防止占位 token 出网；状态文件只存 provider 指纹不存 key。
- 文件系统卫生：配置、备份、状态、日志均为 0600；所有写盘都经原子私有写（临时文件、`fsync`、`rename`）；备份在任何改写之前产生且保存原始字节。
- 流正确性即安全性：截断或失败的流绝不伪造成功终态，客户端取消会传播到上游连接。

## 构建与滚动发布

构建脚本交叉编译六个目标：linux/darwin/win32 乘 x64/arm64。每个目标使用 `-trimpath -ldflags="-s -w"`、`CGO_ENABLED=0`、按需关闭 workspace 复用（依赖模块相对替换）、编译进程数受限；产物先写临时文件再原子改名，失败保留旧产物；并发度默认为可用并行数的较小值加封顶。全部目标成功后才更新指向当前平台产物的原生链接（相对符号链接，Windows 在无符号链接权限时退化为硬链接）。Windows 产物是无 `.exe` 后缀的 PE 文件，使用前需改名。Makefile 提供 build/build-all/install/test/race/vet/release 目标，其中 `release` 即调用仓库根的 `scripts/release.js`。

发布采用「滚动发布」而非语义化版本：tag、release 标题与六个资产名全部固定为二进制名，不带版本号或时间戳。每次发布把同名 tag 指向当前提交、整组替换同名资产，下载者始终从固定 URL 取得最新构建。流程的健壮性约束包括：先把全部目标构建完并验证六个资产存在且非空，构建后再次确认提交未变，任何构建失败都使远端零改动；探测现有 release 与 tag 时只在收到明确的 404 时视为不存在，认证、网络或服务端错误一律中止；写操作通过强制更新 tag 引用与覆盖资产完成。

需要明确的是，这套机制没有灰度或分阶段放量：固定资产名意味着「最新即全部」。运行期的灰度维度在 provider 选择层——通过 `--protocol`/`--name` 切换到不同上游，连通性预检通过后才改写客户端配置，切换失败时旧服务的行为由启动时序保护。回退是手工的：备份文件保留原始配置，`shutdown` 不自动恢复，避免在用户不知情时改动其环境。

## 常见故障与排查路径

虽然网关把错误都收敛成可诊断的固定文案，但不同现象的根因往往落在不同层，下表给出按现象定位的方向：

| 现象                                 | 常见根因                                                     | 处置方向                                                |
| ------------------------------------ | ------------------------------------------------------------ | ------------------------------------------------------- |
| 启动即失败且未改配置                 | provider 选择或校验失败、连通性预检失败、监听地址非回环      | 检查 provider 字段、协议与 API key 回退变量、网络可达性 |
| 启动报「provider 已变化」            | 预检与子进程监听之间配置或指纹发生变化                       | 用同一配置重新启动，不要并发编辑 provider 文件          |
| 启动报「进程不可达，请检查状态目录」 | 有存活进程但控制面不通（权限、端口占用、状态文件损坏）       | 人工检查状态目录后再重启，不要直接删除状态文件          |
| 客户端连不上或仍然指向旧服务         | 客户端配置已被改写但代理未运行；或从未重新注入配置           | 重新 `start`（会重新备份改写）；需要还原时用手工备份    |
| 客户端拿到空回复或中途截断           | 上游流缺终态、上游返回 JSON 而客户端期望 SSE、参数前缀被替换 | 查看客户端侧 `error` 事件；这类情况网关不会伪造成功     |
| token 计数接口返回 501               | 上游协议不是 anthropic                                       | 属预期行为，桥不提供精确分词器                          |
| Codex 续接报历史不可用               | 进程内缓存被淘汰或已重启                                     | 重发完整输入历史；缓存本身有容量与生命周期上限          |
| 工具调用报参数错乱                   | 上游在流中替换了已流出的工具参数                             | 属上游行为，网关显式拒绝而不是拼接出错误参数            |

日志文件固定为状态目录下的 `proxy.log`，以追加方式写入且权限为 0600。

## 测试策略

离线测试全部基于 `httptest` 假上游加临时目录，不触网。覆盖面按包划分：

| 面         | 覆盖内容                                                                                                                            |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Claude 桥  | 三协议请求/响应往返、推理信封往返与孤儿清理、并行工具乱序参数、截断流无成功终态、DeepSeek/Qwen 思考、SSE 多行与 CRLF 与 EOF         |
| Codex 桥   | 工具形态双向往返、签名思考回放、用量归一、仅结果修复的顺序、信封回放、思考模型族矩阵、gzip/zstd、取消传播、原生字段透传、限流与脱敏 |
| 配置与设置 | 备份字节精确、冲突字段清除、代理模式 key 不落盘、上下文窗口投影、非法设置拒绝且不覆写、profile 继承、凭据文件不动、坏 TOML 不覆盖   |
| Agent 注册 | 名称解析、默认监听与状态目录、直连与代理模式                                                                                        |
| 守护进程   | 三协议完整生命周期、控制端点 401、非回环拒绝、连接失败零副作用、指纹幂等与切换                                                      |
| CLI 集成   | 测试二进制自重执行，用生产入口验证真实脱离子进程与 stdio MCP；覆盖开关顺序与按调用选择 Agent                                        |
| MCP        | 内存传输三工具、错误映射、会话退出后进程存活                                                                                        |
| 上游预检   | 三协议乘 SSE/JSON 路由正确、失败消息零凭据泄漏、首个有效事件后取消上游                                                              |

Live 层全部 opt-in 且会产生小额账单，分别覆盖对每个合法 provider 的连通/非流式/流式/工具往返、Codex 直连、以及真实 Codex CLI 端到端。

## 适用场景与取舍

适合：需要让 Claude Code 或 Codex 使用第三方 OpenAI 兼容 / Anthropic 兼容模型；需要把上游推理状态在不同协议间无损回放；希望客户端配置的注入与回滚是显式、可审计的；需要在同一台机器上并存两个 Agent 的本地网关并以 MCP 统一编排。

不适合：需要把一个上游同时服务大量客户端的高并发网关（它是本地单用户工具，安全模型依赖回环绑定）；需要精确分词计费（OpenAI 协议方向明确拒绝 token 计数，不伪造结果）；需要跨版本兼容旧客户端配置格式（项目对不兼容变更持接受态度，旧配置标识会随实现演进）。

主要取舍有三处。其一，direct 模式让 Claude Code 在 anthropic 上游下绕过本地桥，换来零额外延迟与字节级透传，代价是真实 key 进入客户端配置文件；proxy 模式相反。其二，进程内续接缓存让跨协议 Responses 续接可用，代价是重启丢失历史且内存有界，这是无持久会话状态设计的必然结果。其三，滚动发布让下载 URL 永远指向最新，简化了使用，代价是没有版本化回退——回退依赖备份与手工恢复。
