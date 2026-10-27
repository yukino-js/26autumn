---
title: "Telemetry"
---

遥测回答的问题: 每个 agent 会话消耗了多少 token? 哪些工具调用最慢? 首 token 延迟是多少? 哪些请求失败了、为什么失败?

Yukino 的遥测默认关闭, 只通过环境变量配置, 不落配置文件 (避免密钥进入版本库); 支持三个后端, 可以叠加:

- OpenTelemetry: traces / logs / metrics 三路信号, 标准 OTLP 导出
- Langfuse: LLM 可观测平台, 与 OpenTelemetry 共享同一棵 trace 树
- Sentry: 进程级错误上报, 性能追踪仍由 OpenTelemetry 负责

所有遥测 SDK (`@opentelemetry/*`、`@langfuse/*`、`@sentry/node`) 都声明在 optionalDependencies 里; 入口 `src/telemetry/index.ts` 不静态引用它们, `initializeTelemetry()` 判定需要开启后才动态 `import("./providers.js")` 装配运行时, 导入或装配失败则静默回退到 noop 运行时 — 没配置遥测的进程不会付出任何加载成本

```txt
src/telemetry/
├── index.ts           # 生命周期 API: initialize / setMode / captureError / flush / shutdown
├── constants.ts       # 观测点与指标名、属性键、协议与超时默认值
├── providers.ts       # TracerProvider / LoggerProvider / MeterProvider / Langfuse / Sentry 装配
├── privacy.ts         # scrubTelemetryPayload 载荷清洗
└── instrumentation.ts # agent / LLM / tool 三个观测点的具体打点
```

库形态下整个模块以 `Telemetry` 命名空间从包入口导出 (`Telemetry.Constants` / `Telemetry.Instrumentation` / `Telemetry.Privacy` / `Telemetry.Providers`)

## 启用条件

`initializeTelemetry()` 里的 `shouldInitialize()` 决定是否装配运行时 (源码: src/telemetry/index.ts):

```txt
Sentry:        SENTRY_DSN 设置即启用 (不受 OTEL_SDK_DISABLED 影响)
OpenTelemetry: OTEL_SDK_DISABLED != "true" 且
               OTEL_TRACES_EXPORTER / OTEL_LOGS_EXPORTER / OTEL_METRICS_EXPORTER
               至少一个配置了非 none 的 exporter
Langfuse:      OTEL_SDK_DISABLED != "true" 且
               LANGFUSE_PUBLIC_KEY 和 LANGFUSE_SECRET_KEY 同时设置
```

满足任意一条即初始化; OTel 和 Langfuse 条件都不满足而只有 `SENTRY_DSN` 时, 运行时只带 Sentry。环境变量可以来自 shell, 也可以来自配置文件的 `env` 块 — `run()` 在分派到具体模式前先调用 `hydrateConfigEnv()` 把配置 `env` 注入 `process.env`, 因为每个模式 runner 都在加载配置之前初始化遥测 (源码: src/main.tsx)

典型的 OpenTelemetry 配置:

```bash
export OTEL_TRACES_EXPORTER=otlp
export OTEL_METRICS_EXPORTER=otlp
export OTEL_LOGS_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
export OTEL_EXPORTER_OTLP_ENDPOINT=https://collector.example.com
export OTEL_EXPORTER_OTLP_HEADERS="authorization=Bearer token"
```

## 运行时结构

`createTelemetryRuntime()` (源码: src/telemetry/providers.ts) 并行装配四部分, 每部分独立容错 — `safely()` 保证某一路信号配置错误 (比如写了不认识的 exporter) 只让该路 provider 为 null, 不影响其余信号:

- TracerProvider: 按 `OTEL_TRACES_EXPORTER` 挂 `console` / `otlp` 的 BatchSpanProcessor; Langfuse keys 存在时再追加一个 `LangfuseSpanProcessor` (`mediaUploadEnabled: false`)。所有 span processor 挂在同一个 provider 上, 因此 OTLP 后端和 Langfuse 看到的是同一棵 trace 树
- LoggerProvider: 按 `OTEL_LOGS_EXPORTER` 挂 `console` / `otlp` 的 BatchLogRecordProcessor
- MeterProvider: 按 `OTEL_METRICS_EXPORTER` 挂 reader — `otlp` / `console` 走 PeriodicExportingMetricReader (间隔 `OTEL_METRIC_EXPORT_INTERVAL`, 默认 60000ms), `prometheus` 走 pull 模式的 PrometheusExporter
- Sentry: `SENTRY_DSN` 存在时 `sentry.init()`, `tracesSampleRate` 固定为 0 (trace 导出归 OTel), `skipOpenTelemetrySetup: true`, 并移除 `OnUncaughtException` / `OnUnhandledRejection` 默认集成 — 崩溃路径由 `recover()` 统一接管 (见下文生命周期)

对上层暴露的是统一的 `TelemetryRuntime` 接口: `startObservation` / `recordMetric` / `emitLog` / `captureError` / `setMode` / `flush` / `shutdown`。observation 通过 `@langfuse/tracing` 的 `startObservation` 建在上面那个共享 TracerProvider 上, 类型分三种: `agent` / `generation` / `tool`; 没有 TracerProvider 时 `startObservation` 返回结构相同但什么都不做的占位对象, 调用方无需判空

meter 和 logger 的 instrumentation scope 是 `@yukino.js/yukino` + 当前版本号; resource 上 `service.name` 默认 `yukino`, `service.version` 为版本号

## 运行模式

`TelemetryMode` 取值为 `terminal` / `print` / `remote` / `acp` / `a2a` / `unknown` (未设置时的初始值)。五种运行模式 (ui / print / remote / acp+acp-ws / a2a) 的 runner 都会先 `await initializeTelemetry()` 再 `setTelemetryMode()`; ui 模式标记为 `terminal`, acp 和 acp-ws 都标记为 `acp`。模式以 `yukino.mode` 属性附加到每个 observation、每条 metric 和每条 log 上, 并通过 `setTag` 同步给 Sentry

## 观测点与层级

trace 树和 agent 的执行结构同构 (源码: src/telemetry/instrumentation.ts):

```txt
yukino.agent.run (一次 agent loop, kind=agent)
├── yukino.llm.generate (每轮 LLM API 流式请求, kind=generation)
└── yukino.tool.execute (每次工具调用, kind=tool, 并发批内并行)
```

| 观测点                | 类型         | 内容                                                                                                                                                                                                                                                                                                                                            |
| --------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `yukino.agent.run`    | trace/metric | `Agent.run()` 开始时由 `startAgentTelemetry` 创建, finally 中 `endAgentTelemetry` 收尾; counter `yukino.agent.runs`, histogram `yukino.agent.duration`, 属性含 outcome (completed / interrupted / error, abort 时强制 interrupted) 与 protocol                                                                                                  |
| `yukino.llm.generate` | trace/metric | `observeLlmStream` 包裹 LLM 流式响应, 记录首事件时刻; counter `yukino.llm.requests`, histogram `yukino.llm.time_to_first_token` 与 `yukino.llm.duration` (outcome: completed / error / incomplete), counter `yukino.llm.tokens` (按 token.type 分维度), 失败时 log `yukino.llm.error`; span 上还写入 completionStartTime、model 与 usageDetails |
| `yukino.tool.execute` | trace/metric | `observeToolExecution` 在 StreamingExecutor 中包裹每次 `tool.execute`; counter `yukino.tool.calls`, histogram `yukino.tool.duration`, 结果 `isError` 或抛异常都记 outcome=error, 失败时 log `yukino.tool.error`                                                                                                                                 |
| `yukino.error`        | log          | 进程级错误 (`captureTelemetryError`), 携带 context: main / config / print / remote / uncaught exception / unhandled rejection; 同一错误同时以 tags 形式发给 Sentry; `AbortError` 直接跳过                                                                                                                                                       |

histogram 单位统一为 `ms`。属性维度: `protocol` (anthropic / openai / openai-compat)、`model`、`tool`、`session.hash`、`token.type` (input / output / cache_creation / cache_read, 值为 0 的类型不上报)、`yukino.mode`。LLM client 的 model / protocol 元数据在 `createClient` 时通过 `registerLlmClient` 写入 WeakMap (源码: src/llm/client.ts), 打点时按 client 实例读取, 避免把配置对象传进观测层

## 隐私保证

不上报: prompts、模型输出、thinking 内容、工具参数、工具结果、文件路径、API key、原始 session id

- session id 经 sha256 哈希后取前 16 位十六进制作为 `session.hash`, 可关联同一会话的观测数据但不可逆推
- 错误观测只写 `error.type` (Error 的 name 或 typeof), 日志只带类型与 context, 不携带内容载荷
- 文本载荷经 `scrubTelemetryPayload` 清洗 (源码: src/telemetry/privacy.ts): 递归遍历对象与数组 (WeakSet 防环), 键名命中 `SENSITIVE_KEY_PATTERN` (authorization / api key / password / secret / credential / token / access token / refresh token / private key / dsn / cookie) 的值整体替换为 `[redacted]`; 字符串值则替换掉环境变量中键名命中 `api[_-]?key|token|secret|password|private[_-]?key|credential|dsn` 且长度大于 3 的秘密值 (含 URL 编码形态)、`Bearer` 后的 token, 并把 home 目录路径 (含 URL 编码形态) 替换为 `~`
- Sentry 侧再收紧一层: `beforeSend` 删除 `event.request.data` 与 `event.request.cookies` 后对整个 event 跑一遍 `scrubTelemetryPayload`; `sendDefaultPii: false`、`includeLocalVariables: false`
- Langfuse 侧 `mediaUploadEnabled: false`, 不上传任何媒体附件

## 生命周期

- 启动: `initializeTelemetry()` 幂等 (缓存同一个 Promise); 装配成功后注册 `process.once("beforeExit")` 钩子兜底 flush
- 运行: `setTelemetryMode()` 标记模式; 打点全部经由 `getTelemetryRuntime()` 拿当前运行时, 未初始化时是 noop
- 退出: `shutdownTelemetry()` 幂等, 并行 shutdown 三路 provider 并 `sentry.close()`, 整体套 `withTimeout` 上限 2000ms (`SHUTDOWN_TIMEOUT_MS`), 超时也要放行退出; 完成后运行时替换回 noop。`flushTelemetry()` 只 forceFlush 不关闭, 供 beforeExit 使用
- 崩溃: `recover()` 安装的 uncaughtException / unhandledRejection 处理器先 `captureTelemetryError` 再 `shutdownTelemetry()`, flush 完成后 `process.exit(1)` (源码: src/recover.ts)
- remote 模式: `installRemoteTelemetrySignalHandlers` 监听 SIGINT (退出码 130) 与 SIGTERM (退出码 143), 先跑 `onShutdown` 回调 — 停服务器 (关 WS/HTTP、杀后台 shell 与 teammate、断 MCP 子进程) 并 `recordExit` 记录真实退出码 — 再等遥测 shutdown, 最后 `process.exit` (源码: src/main.tsx)

## 环境变量参考

### OpenTelemetry

| 变量                                    | 值 / 用途                                                                                              |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `OTEL_SDK_DISABLED`                     | `true` 关闭 OpenTelemetry 和 Langfuse (不影响 Sentry)                                                  |
| `OTEL_SERVICE_NAME`                     | 服务名, 默认 `yukino`                                                                                  |
| `OTEL_RESOURCE_ATTRIBUTES`              | 逗号分隔的 `key=value` 资源属性, URL 编码会被解开                                                      |
| `OTEL_TRACES_EXPORTER`                  | 逗号分隔: `otlp`, `console`, `none`                                                                    |
| `OTEL_LOGS_EXPORTER`                    | 逗号分隔: `otlp`, `console`, `none`                                                                    |
| `OTEL_METRICS_EXPORTER`                 | 逗号分隔: `otlp`, `console`, `prometheus`, `none`                                                      |
| `OTEL_EXPORTER_OTLP_PROTOCOL`           | 默认 OTLP 协议: `grpc`, `http/json`, `http/protobuf`, 缺省 `http/protobuf`; 其他值报错并只禁用该路信号 |
| `OTEL_EXPORTER_OTLP_TRACES_PROTOCOL` 等 | 按信号覆盖协议 (TRACES / LOGS / METRICS)                                                               |
| `OTEL_EXPORTER_OTLP_ENDPOINT`           | collector 端点, 由 OTLP exporter SDK 按标准语义读取                                                    |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` 等 | 按信号覆盖端点                                                                                         |
| `OTEL_EXPORTER_OTLP_HEADERS`            | 逗号分隔的 OTLP headers, 各信号也有标准 headers 变量                                                   |
| `OTEL_METRIC_EXPORT_INTERVAL`           | push 型 metrics 导出间隔毫秒, 默认 60000                                                               |

### Langfuse

`LANGFUSE_PUBLIC_KEY` 和 `LANGFUSE_SECRET_KEY` 同时设置时启用, trace 层级和 OpenTelemetry 共享。除 `LANGFUSE_RELEASE` 由 Yukino 读取并传给 `LangfuseSpanProcessor` 外, 其余变量由 Langfuse SDK 自行消费:

| 变量                           | 用途                           |
| ------------------------------ | ------------------------------ |
| `LANGFUSE_BASE_URL`            | Langfuse cloud 或自部署端点    |
| `LANGFUSE_TRACING_ENVIRONMENT` | 附加到 trace 的环境标识        |
| `LANGFUSE_RELEASE`             | release 标识, 默认 Yukino 版本 |
| `LANGFUSE_FLUSH_AT`            | 累积多少个 span 后导出         |
| `LANGFUSE_FLUSH_INTERVAL`      | 批量 flush 间隔秒              |
| `LANGFUSE_TIMEOUT`             | 导出请求超时                   |

### Sentry

`SENTRY_DSN` 设置时启用, 只上报进程级错误 (`captureTelemetryError`), `tracesSampleRate` 固定为 0:

| 变量                 | 用途                           |
| -------------------- | ------------------------------ |
| `SENTRY_ENVIRONMENT` | 部署环境                       |
| `SENTRY_RELEASE`     | release 标识, 默认 Yukino 版本 |
| `SENTRY_DEBUG`       | `true` 开启 SDK 诊断日志       |
