---
title: "MCP 和 Skill"
description: "MCP 和 Skill: 物流/售后两个演示 MCP 服务器 (Hono + 官方 SDK, 确定性 Mock)、主服务 mcp-client 接入与 registry 合并注册、formatResult 状态码翻译、执行引擎、写前人工确认与审计, 以及测试与验收"
local_path: "$HOME/github/yukino-ecomm-agent"
local_commit: "fa5a5090930436aca0dcfb824d948036132697ef"
---

MCP (Model Context Protocol) 把工具放进独立进程, 通过标准协议暴露端点; agent 主服务用 client 连接, 动态拿到工具清单并调用. 本项目自带两个演示第三方对接的 MCP 服务器 (物流、售后), 主服务侧用统一的工具注册表 (registry) 和执行引擎 (engine) 把它们和内置工具合并成同一份工具列表, 对模型来说两者没有区别.

## 两个 MCP 服务器

两个服务器都用官方 `@modelcontextprotocol/server` 的 `McpServer` + `createMcpHandler` 和 Hono 搭建, 在 `/mcp` 暴露 MCP 端点 (Streamable HTTP), 只监听 `127.0.0.1`, 端口由 `PORT` 环境变量配置:

| 服务 | 文件                                   | 端口 (默认) | 工具                                    |
| ---- | -------------------------------------- | ----------- | --------------------------------------- |
| 物流 | `server/src/mcp-servers/logistics.ts`  | 8101        | `query_logistics`                       |
| 售后 | `server/src/mcp-servers/aftersales.ts` | 8102        | `query_warranty`、`query_return_status` |

三个工具的入参用 zod schema 定义 (经 MCP 转成 JSON Schema), 返回同时带文本 `content` 块和 `structuredContent`:

| 工具                  | 入参                      | structuredContent 字段                                                                                                                   |
| --------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `query_logistics`     | `tracking_no` (SF 运单号) | `tracking_no`、`status_code` (PICKED_UP / IN_TRANSIT / DELIVERING / DELIVERED)、`current_city`、`trace`、`carrier_code` (固定 SF-EXP-01) |
| `query_warranty`      | `order_id`                | `order_id`、`warranty_code` (IN_WARRANTY / EXPIRED)、`warranty_until`、`policy_ref` (固定 AS-POLICY-07)                                  |
| `query_return_status` | `order_id`                | `order_id`、`return_code` (AUDITING / RETURNING / REFUNDED / NONE)、`updated_at`                                                         |

两个关键设计:

- **调用顺序写进工具描述**: `query_logistics` 的 description 明确「运单号不是订单号: 先用 query_order 拿到订单的 tracking_no, 再调用本工具」, 入参描述里再强调一遍 "obtain it first via query_order", 降低模型拿错参数的概率
- **确定性 Mock**: 把输入键 (`logistics:<tracking_no>`、`warranty:<order_id>`、`return:<order_id>`) 先用 FNV-1a 散列 (offset 0x811c9dc5、prime 0x01000193) 做种子, 再喂给固定种子的 PRNG 生成状态码、城市、日期 —— 同样的输入永远得到同样的结果, 方便测试和演示; `MOCK_DELAY_SECONDS` (默认 0) 可以给每次调用注入延迟, 模拟慢接口

### 进程管理

`node server/main.js` 以守护进程方式管理两个服务器:

- `mcp-up` / `mcp-down` 一起启停两个服务器 (`dev` 命令会先 `mcp-up` 再启动 API 服务); 也有单服务命令 `mcp-logistics-up/down`、`mcp-aftersales-up/down`, 以及前台运行的 `mcp-logistics`、`mcp-aftersales`
- 启动时 detached spawn `tsx src/mcp-servers/*.ts`, stdout/stderr 写 `log/<name>.log`, pid 写 `data/<name>.pid`; 就绪检测轮询 `http://127.0.0.1:8101/` (售后同理), 超时 5 秒, 超时未应答不阻塞启动
- `mcp-down` 读 pid 文件发 SIGTERM, 然后删除 pid 文件

主服务侧的连接地址在 `server/src/config.ts`: `MCP_LOGISTICS_URL` (默认 `http://127.0.0.1:8101/mcp`)、`MCP_AFTERSALES_URL` (默认 `http://127.0.0.1:8102/mcp`).

## 主服务接入: mcp-client.ts

`server/src/tools/mcp-client.ts` 用官方 `@modelcontextprotocol/client` 的 `Client` + `StreamableHTTPClientTransport` 连接:

- `fetchMcpSpecs()` 遍历两个配置连接调 `listTools`; 某个服务器不可达时只记一条 warning 并跳过它的工具 (本轮降级为没有这批工具), 不影响整轮对话; inputSchema 非法的工具同样跳过
- 每个 MCP 工具用 `defineRawTool` 包成统一的 `ToolSpec`: `source: "mcp"`、记录 `mcpServer` 名 (logistics / aftersales), `formatResult` 按工具名从 `FORMATTERS` 查表
- 每次调用都新建连接: `withClient` 创建 `Client` + transport, 整体包在 `MCP_TOOL_TIMEOUT` (默认 10 秒) 超时里, 超时或结束后都会关闭连接; 返回 `result.isError === true` 时把文本内容抽出来抛错

### 工具注册表 registry.ts

`server/src/tools/registry.ts` 定义 `ToolSpec` 接口 (name / description / jsonSchema / invoke / permission / source / mcpServer / timeout / maxRetries / injectConversation / injectUserId / formatResult) 和注册逻辑:

- `WRITE_TOOLS = new Set(["create_ticket"])`; `permissionFor` 据此推导权限: `create_ticket` 是 `write`, 其余全部 `read`
- 两种定义入口: `defineTool` (内置工具, zod schema 经 `z.toJSONSchema` 转 JSON Schema, 可开注入开关) 和 `defineRawTool` (MCP 工具, 直接携带对方给的 JSON Schema, 注入开关固定 false)
- 内置工具在模块加载时自注册: `scanBuiltin` 按序动态 import `builtin/faq.ts`、`orders.ts`、`refunds.ts`、`tickets.ts`, 只执行一次; 重名工具记 warning 并保留第一个注册
- `getAllSpecs()` 合并内置 + MCP: 先放内置, MCP 工具名与内置冲突时丢弃该 MCP 工具并记 warning

合并后一共 8 个工具:

| 工具                  | 来源               | 说明                                                             |
| --------------------- | ------------------ | ---------------------------------------------------------------- |
| `query_faq`           | builtin faq.ts     | 搜 FAQ/政策知识库 (混合检索 + 精排); timeout 30 秒、maxRetries 0 |
| `query_order`         | builtin orders.ts  | 查订单状态/金额/时间/商品/运单号; injectUserId, 做归属校验       |
| `query_product`       | builtin orders.ts  | 查商品价格/库存/规格                                             |
| `submit_refund`       | builtin refunds.ts | 把退款表单交给用户; injectUserId, 做归属校验                     |
| `create_ticket`       | builtin tickets.ts | 创建人工工单; injectConversation, write 权限                     |
| `query_logistics`     | MCP logistics      | 查物流状态/当前城市/轨迹                                         |
| `query_warranty`      | MCP aftersales     | 查订单保修状态和到期时间                                         |
| `query_return_status` | MCP aftersales     | 查订单退货进度                                                   |

`main_agent` 节点每步都调 `registry.getAllSpecs()`, 把每个 spec 映射成 function 定义 (`name` / `description` / `parameters: jsonSchema`) 后 `bindTools` 给 chat 模型 —— MCP 工具和内置工具在模型眼里完全同构. 工具列表每步重新拉取, 增删 MCP 服务或工具不需要改 agent 代码; `AGENT_SYSTEM` 也向模型声明「工具列表可能动态变化 (物流轨迹、保修状态、退货进度由外部服务提供), 按工具描述的用途选择」.

### formatResult: 把机器状态码翻译成自然语言

MCP 服务返回的是内部状态码, 主服务侧 `FORMATTERS` 为每个 MCP 工具配一个翻译器, 把状态码翻成自然语言, 顺手裁掉内部字段, 模型和用户都不看到裸码:

| 工具                  | 翻译映射                                                                                                          | 裁掉的字段     |
| --------------------- | ----------------------------------------------------------------------------------------------------------------- | -------------- |
| `query_logistics`     | PICKED_UP -> "Picked up"、IN_TRANSIT -> "In transit"、DELIVERING -> "Out for delivery"、DELIVERED -> "Delivered"  | `carrier_code` |
| `query_warranty`      | IN_WARRANTY -> "Under warranty"、EXPIRED -> "Warranty expired"                                                    | `policy_ref`   |
| `query_return_status` | AUDITING -> "Under review"、RETURNING -> "Return in progress"、REFUNDED -> "Refunded"、NONE -> "No return record" | 无             |

翻译器对意外情况有明确降级: 未知状态码原样透传; payload 类型不匹配 (safeParse 失败) 时整个结果原样透传, 绝不抛错.

## 执行引擎 engine.ts

`server/src/tools/engine.ts` 的 `executeToolCall` 是所有工具调用 (内置和 MCP 一视同仁) 的统一入口, 按顺序做:

1. **未知工具**: 直接返回 failed ("unknown tool"), 写审计
2. **参数校验**: `validateArgs` 用 Ajv 编译工具的 jsonSchema (编译结果缓存在 WeakMap); 不通过返回 validation_blocked, 提示语引导模型「修正参数后重试, 缺失信息先问用户, 绝不编造」; 校验器本身崩溃 (通常是畸形 MCP schema) 也归为 failed
3. **写权限闸**: `permission === "write"` 的工具必须 `options.confirmed === true` 才放行, 否则 permission_denied (见下文「写操作」)
4. **注入参数**: `injectConversation` 写入 `args.conversation_id`, `injectUserId` 写入 `args.user_id`
5. **超时与重试**: 超时取 `spec.timeout`, 未配置时 MCP 工具取 `MCP_TOOL_TIMEOUT` (默认 10 秒)、内置工具取 `TOOL_DEFAULT_TIMEOUT` (默认 5 秒); 只有瞬时故障 (ToolTimeoutError / TypeError / AbortError) 才重试, 退避 200ms × 尝试次数, 最大次数取 `spec.maxRetries` ?? `TOOL_MAX_RETRIES` (默认 2); 写工具强制 0 次重试
6. **结果处理**: `formatContent` 把 MCP 文本块 join 成字符串、尝试 JSON 解析、跑 `formatResult`、再序列化; `capTokens` 按 `TOOL_RESULT_MAX_TOKENS` (默认 3000 tokens, 按每 token 4 字符折算成 12000 字符) 截断超长结果; 最后包成 `ToolMessage` 返回给图

### 注入参数

身份类参数由系统注入, 不让模型传, 避免模型编造或越权; 工具描述里也写明 "injected by the system, so do not pass it":

```ts
// server/src/tools/builtin/tickets.ts
register(
  defineTool({
    name: "create_ticket",
    description:
      "... the conversation id linked to the ticket is injected by the system, so do not pass it.",
    schema: createTicketSchema,
    injectConversation: true,
    handler: async (args) => {
      const { description, ticket_type } = createTicketSchema.parse(args);
      if (settings.demoTicketDelaySeconds > 0) {
        await new Promise((resolve) =>
          setTimeout(resolve, settings.demoTicketDelaySeconds * 1000),
        );
      }
      // 注入参数: engine.executeToolCall 在执行前写入 args.conversation_id
      const conversationId =
        typeof args.conversation_id === "number" ? args.conversation_id : 0;
      const ticketNo = await repository.createTicket(
        conversationId,
        description,
        ticket_type,
      );
      return { ticket_no: ticketNo, status: "transferred" };
    },
  }),
);
```

- `injectConversation` 写 `conversation_id`: create_ticket 用它把工单挂到当前会话
- `injectUserId` 写 `user_id`: query_order / submit_refund 用它调 `business.ownsOrder` 做归属校验, 非本人订单一律返回 `{ error: "No such order was found for you", code: "order_not_owned" }` (订单归属数据同样是固定种子 Mock: `DEMO_ORDER_IDS = ["1001", "2002"]` 加按 user_id 散列出的若干随机单号)
- `DEMO_TICKET_DELAY_SECONDS` (默认 0) 给 create_ticket 注入延迟, 演示慢接口

### Audit 审计

每次工具调用 (无论内置还是 MCP、无论成败) 都经 `repository.insertToolAudit` 写一条 `ToolAuditLog`:

| 字段                                    | 内容                                                                |
| --------------------------------------- | ------------------------------------------------------------------- |
| `conversationId` / `toolCallId`         | 会话 ID; 工具调用 ID (截断 64 字符)                                 |
| `toolName` / `toolSource` / `mcpServer` | 工具名 (截断 128 字符); builtin / mcp; 来自哪个 MCP server          |
| `arguments`                             | 完整调用参数 (JSON 序列化)                                          |
| `resultSummary`                         | 成功时的结果摘要 (前 500 字符, 超长追加 `… (truncated)`)            |
| `status`                                | success / failed / timeout / validation_blocked / permission_denied |
| `errorMessage`                          | 错误消息 (截断 500 字符)                                            |
| `retryCount` / `durationMs`             | 实际重试次数; 本次调用耗时                                          |

审计写库失败只记 error 日志, 不影响工具执行本身; 同时用 pino 打一条结构化日志 `tool_run` (含 source、server、status、retry、duration_ms).

### 写操作: 写前人工确认 + 不自动重试

写工具的风险是「模型自主触发、副作用不可撤销」, 本项目用三道闸:

1. **create_ticket 走写前人工确认**: `agent_tools` 节点先校验参数, 再用 langgraph 的 `interrupt` 中断图, 向前端弹工单预览卡 (interrupt payload 为 `{ type: "confirm_ticket", preview: { ticket_type, description } }`); 用户经 `POST /api/actions/resume` 提交 `confirmed`, 图以 `Command({ resume })` 恢复后:
   - 确认: `executeToolCall(..., { confirmed: true })` 真正执行, 落库工单号并把会话状态置为 transferred
   - 取消: `executeToolCall(..., { confirmed: false, denyNote })`, 引擎按 permission_denied 拦截, 给模型的工具消息是「用户已在预览卡上点击取消, 本次不建单; 除非用户明确要求, 不要再次发起」
   - 一轮只处理一个建单请求: 同轮出现多个 create_ticket 时, 只有第一个走确认流, 其余直接以 error ToolMessage 忽略
2. **submit_refund 更保守**: 工具调用本身不落库, 只在归属校验通过后把退款表单交给用户 (`suggestedActions` 追加 `{ type: "refund_form", draft: { order_id, reason } }`); 真正的提交走 `POST /api/actions/create-refund` (reason 为五选一枚举: no_reason_7_day / quality_issue / wrong_item / no_longer_wanted / other), 由 API 创建 ticket_type 为 refund 的工单
3. **写工具从不自动重试**: 引擎里 `permission === "write"` 的工具重试次数强制为 0, 避免「超时后重试」造成重复写入

图的中断/恢复机制和 SSE 事件见 [workflow](./workflow), 各 action 端点的请求/响应契约见 [HTTP API 和管理台](./api).

## Skill

把「Skill」理解为教模型正确编排工具的能力, 本项目落在两点:

1. **明确工具调用的顺序, 提高工具选择和调用的准确率**
   - 调用前置条件写进工具描述: `query_logistics` 声明「运单号不是订单号, 先用 query_order 拿 tracking_no」, `query_order` 反向声明「要查物流轨迹, 先用本工具拿 tracking_no 再传给 query_logistics」, 两个方向互相印证
   - 系统提示兜底: `AGENT_SYSTEM` (core/prompts.ts) 的 "Tool-use principles" 写明 query_order / query_product / query_logistics / query_faq / create_ticket 各自的使用边界、工具报错时「按提示修正参数或如实告知用户, 绝不编造结果」、以及建单被用户取消后「不要自行重试」
2. **可 (热) 更新、可复用、可移植**
   - MCP 工具是独立进程 (mcp-up / mcp-down 启停), 走标准协议接入; 增删工具不需要改主力 agent 的代码, 换实现只需要换 URL
   - `main_agent` 每步重新调 `getAllSpecs()`, 模型每轮看到的都是最新工具列表; MCP 服务临时不可达时只是本轮少了这批工具, 其余工具照常
   - 所有接入异常都有显式降级策略: 服务器不可达 -> 跳过该服务器工具, schema 非法 -> 跳过该工具, 名字与内置冲突 -> 丢弃 MCP 工具, formatter 失败 -> 透传原始结果, 工具扩展不成为脆弱点

## 测试与验收

- `tests/mcp-servers.test.ts`: 以真实子进程拉起两个 MCP 服务器 (测试端口 18101 / 18102), 用真实 `Client` + `StreamableHTTPClientTransport` 验证 `listTools` 能列全三个工具、同一输入两次调用返回完全一致 (确定性 Mock)
- `tests/mcp-client.test.ts`: 验证 `FORMATTERS` 的翻译映射、未知码透传、类型不匹配透传, 以及 `fetchMcpSpecs` 在服务器不可达时跳过而不抛错
- `node main.js eval-mcp`: MCP 端到端验收评测 (工单 + 物流两条链路)
