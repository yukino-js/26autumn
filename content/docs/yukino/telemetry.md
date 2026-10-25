---
title: "Telemetry"
---

遥测回答的问题: 每个 agent 会话消耗了多少 token? 哪些工具调用最慢? 首 token 延迟是多少? 哪些请求失败了、为什么失败?

Yukino 的遥测默认关闭, 只通过环境变量配置, 不落配置文件 (避免密钥进入版本库); 支持三个后端, 可以叠加:

- OpenTelemetry: traces / logs / metrics, 标准 OTLP 导出
- Langfuse: LLM 可观测平台, 与 Yukino 的 trace 层级共享
- Sentry: 进程级错误上报

三者的 SDK 都是 optionalDependencies, 运行时动态加载, 没有配置就不引入

## 启用条件

```txt
OpenTelemetry: OTEL_SDK_DISABLED != "true" 且
               OTEL_TRACES_EXPORTER / OTEL_LOGS_EXPORTER / OTEL_METRICS_EXPORTER
               至少一个配置了非 none 的 exporter
Langfuse:      LANGFUSE_PUBLIC_KEY 和 LANGFUSE_SECRET_KEY 同时设置
Sentry:        SENTRY_DSN 设置
```

运行模式 (TelemetryMode) 会作为 `yukino.mode` 属性附加到观测数据上: terminal / print / remote / acp / a2a (未初始化时是 unknown); 五种运行模式都初始化遥测

```bash
export OTEL_TRACES_EXPORTER=otlp
export OTEL_METRICS_EXPORTER=otlp
export OTEL_LOGS_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
export OTEL_EXPORTER_OTLP_ENDPOINT=https://collector.example.com
export OTEL_EXPORTER_OTLP_HEADERS="authorization=Bearer token"
```

## 观测点与层级

trace 树和 agent 的执行结构同构 (源码: src/telemetry/instrumentation.ts):

```txt
yukino.agent.run (一次 agent loop)
├── yukino.llm.generate (每轮 LLM API 流式请求)
└── yukino.tool.execute (每次工具调用, 并发批内并行)
```

| 观测点              | 类型         | 内容                                                                                                                                                                                  |
| ------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| yukino.agent.run    | trace/metric | agent loop 开始/结束; counter `yukino.agent.runs`, histogram `yukino.agent.duration`                                                                                                  |
| yukino.llm.generate | trace/metric | LLM 流式请求; counter `yukino.llm.requests`, histogram `yukino.llm.time_to_first_token` 和 `yukino.llm.duration`, counter `yukino.llm.tokens` (按 token 类型), log `yukino.llm.error` |
| yukino.tool.execute | trace/metric | 工具执行 (包裹在 StreamingExecutor 外层); counter `yukino.tool.calls`, histogram `yukino.tool.duration`, log `yukino.tool.error`                                                      |
| yukino.error        | log          | 进程级错误 (captureTelemetryError, 携带 context: main/config/print/remote/...)                                                                                                        |

属性维度: protocol (anthropic/openai/openai-compat)、model、session.hash、yukino.mode; LLM client 的 model/protocol 元数据在 createClient 时用 WeakMap 注册, 观测时读取

## 隐私保证

不上报: prompts、模型输出、thinking 内容、工具参数、工具结果、文件路径、API key、原始 session id

- session id 经 sha256 哈希后取前 16 位作为 `session.hash`, 可关联同一会话的观测数据但不可逆推
- 错误日志只上报错误类型和消息摘要, 不携带内容载荷
- 文本载荷经 scrubTelemetryPayload 清洗 (src/telemetry/privacy.ts): 环境变量中命中 API_KEY / TOKEN / SECRET / PASSWORD / PRIVATE_KEY / DSN 模式的值 (含 URL 编码形态) 替换为 `[redacted]`, home 目录路径替换为 `~`

## 生命周期

- 启动: `initializeTelemetry()` 在模式分派后、进入具体模式前调用; 创建 TracerProvider / MeterProvider / LoggerProvider, 按环境变量装配 exporter
- 运行: `setTelemetryMode()` 标记模式; Sentry 同步打 tag
- 退出: `shutdownTelemetry()` flush 全部信号后关闭; remote 模式用 `installRemoteTelemetrySignalHandlers` 在 Ctrl+C/SIGTERM 时先停服务器、记录真实退出码, 再等遥测 flush

## 环境变量参考

### OpenTelemetry

| 变量                                                | 值 / 用途                                                 |
| --------------------------------------------------- | --------------------------------------------------------- |
| `OTEL_SDK_DISABLED`                                 | `true` 关闭 OpenTelemetry 和 Langfuse                     |
| `OTEL_SERVICE_NAME`                                 | 服务名, 默认 `yukino`                                     |
| `OTEL_RESOURCE_ATTRIBUTES`                          | 逗号分隔的资源属性                                        |
| `OTEL_TRACES_EXPORTER`                              | 逗号分隔: `otlp`, `console`, `none`                       |
| `OTEL_LOGS_EXPORTER`                                | 逗号分隔: `otlp`, `console`, `none`                       |
| `OTEL_METRICS_EXPORTER`                             | 逗号分隔: `otlp`, `console`, `prometheus`, `none`         |
| `OTEL_EXPORTER_OTLP_PROTOCOL`                       | 默认 OTLP 协议: `grpc`, `http/json`, `http/protobuf`      |
| `OTEL_EXPORTER_OTLP_{TRACES,LOGS,METRICS}_PROTOCOL` | 按信号覆盖协议                                            |
| `OTEL_EXPORTER_OTLP_ENDPOINT`                       | 共享的 collector 端点                                     |
| `OTEL_EXPORTER_OTLP_{TRACES,LOGS,METRICS}_ENDPOINT` | 按信号覆盖端点                                            |
| `OTEL_EXPORTER_OTLP_HEADERS`                        | 共享的逗号分隔 OTLP headers (各信号也有标准 headers 变量) |
| `OTEL_METRIC_EXPORT_INTERVAL`                       | metrics 导出间隔毫秒, 默认 60000                          |

meter / logger 的标识是 `@yukino.js/yukino` + 版本号

### Langfuse

`LANGFUSE_PUBLIC_KEY` 和 `LANGFUSE_SECRET_KEY` 同时设置时启用, trace 层级和 OpenTelemetry 共享

| 变量                           | 用途                           |
| ------------------------------ | ------------------------------ |
| `LANGFUSE_BASE_URL`            | Langfuse cloud 或自部署端点    |
| `LANGFUSE_TRACING_ENVIRONMENT` | 附加到 trace 的环境            |
| `LANGFUSE_RELEASE`             | release 标识, 默认 Yukino 版本 |
| `LANGFUSE_FLUSH_AT`            | 累积多少个 span 后导出         |
| `LANGFUSE_FLUSH_INTERVAL`      | 批量 flush 间隔秒              |
| `LANGFUSE_TIMEOUT`             | 导出请求超时                   |

### Sentry

`SENTRY_DSN` 设置时启用, 只上报进程级错误, 性能追踪仍由 OpenTelemetry 负责

| 变量                 | 用途                           |
| -------------------- | ------------------------------ |
| `SENTRY_ENVIRONMENT` | 部署环境                       |
| `SENTRY_RELEASE`     | release 标识, 默认 Yukino 版本 |
| `SENTRY_DEBUG`       | `true` 开启 SDK 诊断           |
