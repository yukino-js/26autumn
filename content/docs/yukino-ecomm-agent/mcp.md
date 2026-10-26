---
title: "MCP 和 Skill"
---

# MCP 和 Skill

## MCP

本项目自带两个 MCP 服务器, 都用官方 @modelcontextprotocol/server + Hono 搭建, 在 /mcp 暴露 StreamableHTTP 端点:

| 服务       | 端口 | 工具                | 说明                                            |
| ---------- | ---- | ------------------- | ----------------------------------------------- |
| logistics  | 8101 | query_logistics     | 按运单号 tracking_no 查物流状态、当前城市、轨迹 |
| aftersales | 8102 | query_warranty      | 查订单保修状态和到期时间                        |
|            |      | query_return_status | 查订单退货进度                                  |

- 工具描述里写明调用顺序: query_logistics 说明「运单号不是订单号: 先用 query_order 拿到订单的 tracking_no, 再调用本工具」
- Mock 数据用固定种子的伪随机数 (FNV-1a 散列做种子 + xorshift) 生成, 同样的输入永远得到同样的结果, 方便测试和演示; DEMO_TICKET_DELAY_SECONDS / MOCK_DELAY_SECONDS 可以注入延迟模拟慢接口
- 由 `node server/main.js` 以守护进程管理 (mcp-up / mcp-down), pid 写 data/, 日志写 log/; API 服务通过 MCP_LOGISTICS_URL / MCP_AFTERSALES_URL 连接

主服务侧 (`server/src/tools/mcp-client.ts`) 用官方 @modelcontextprotocol/client 的 StreamableHTTPClientTransport 连接, `listTools` 拿到工具后用 `defineRawTool` 注册进同一个工具 registry (source=mcp、记录 mcpServer 名), 对模型来说 MCP 工具和内置工具没有区别。每个 MCP 工具配一个 formatResult, 把机器状态码翻译成自然语言 (IN_TRANSIT -> "In transit"、EXPIRED -> "Warranty expired"、AUDITING -> "Under review"), 模型和用户都不看到裸码。

### MCP 的注入参数

身份类参数由系统注入, 不让模型传, 避免模型编造或越权:

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
      // 注入参数
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

注入发生在 `engine.executeToolCall` 内部: injectConversation 写入 conversation_id; injectUserId 写入 user_id (query_order / submit_refund 用它做 ownsOrder 归属校验, 查别人的订单直接返回错误)。

### Audit 审计

每次工具调用 (无论内置还是 MCP、无论成败) 都写 tool_audit_log:

- 什么时候调用什么工具、来自哪个 MCP server
- 工具调用参数、结果摘要 (前 500 字符)
- 状态 (success / failed / timeout / validation_blocked / permission_denied)、错误消息
- 重试次数、工具调用耗时

### 写操作: 幂等键与人确认

1. 请求的幂等键 (设计方案): 携带幂等键 (Idempotency-Key) 的请求, 幂等有效期内, 保证副作用只执行一次
2. 本项目的实际方案是「写前人工确认」: create_ticket 在 agent_tools 节点用 langgraph 的 interrupt 中断, 弹出工单预览卡 (confirm_ticket), 用户经 /api/actions/resume 确认后才真正执行; 用户取消时告诉模型「除非用户明确要求, 不要再次发起」
3. submit_refund 更保守: 工具调用本身只把退款表单交给用户 (suggestedActions: refund_form), 真正的提交走 /api/actions/create-refund
4. 写工具从不自动重试, 避免超时后重试造成重复写入

## Skill

1. 明确工具调用的顺序, 提高工具选择和调用的准确率 —— 本项目把调用前置条件写进工具描述 (query_logistics 先查 tracking_no) 和系统提示 (AGENT_SYSTEM 的工具使用原则)
2. 可 (热) 更新、可复用、可移植 —— MCP 工具是独立进程, 增删不需要改主力 agent 的代码; 工具列表动态变化时, 模型按描述选择工具
