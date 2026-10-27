---
title: "LSP"
---

LSP (Language Server Protocol) 集成: 给 agent 语义级的代码导航能力

Grep/Glob 是文本级发现 (正则和文件名), 命中靠字符串匹配, 会被同名符号、注释、字符串巧合欺骗; LSP 是语义级查询: 定义、引用、类型定义、实现、调用链、诊断 —— 由 language server 基于语法和类型信息回答, 精确到符号

Yukino 内置一个只读的 stdio JSON-RPC 客户端 (src/lsp/client.ts) 和一个 LSP 工具 (src/tools/lsp.ts): 客户端负责和 server 进程通信, 工具把 11 种语义查询暴露给 agent; 二者都不编辑文件、不执行任意 server 命令

## 配置

`~/.yukino/config.yaml` 的 `lsp_servers` 数组 (schema: src/lsp/config.ts, 装配: src/config/index.ts, zod 校验):

```yaml
lsp_servers:
  - name: typescript
    command: typescript-language-server
    args: ["--stdio"]
    languages:
      .ts: typescript
      .tsx: typescriptreact
      .js: javascript
    env: {} # 可选, 合并进 server 子进程的环境变量
    initialization_options: {} # 可选, initialize 请求的 initializationOptions
    settings: {} # 可选, workspace/didChangeConfiguration 和 workspace/configuration 的取值来源
    timeout_ms: 15000 # 可选, 单次请求超时, 整数 100-60000, 缺省 15000
```

字段约束 (LspServerConfigSchema):

- `name` / `command`: 非空字符串; `command` 是 server 可执行程序, 由 Yukino 直接 spawn
- `args`: 可选字符串数组, 作为命令行参数传给 `command`
- `languages`: 文件扩展名到 language id 的映射, 决定哪些文件走这个 server
  - key 必须匹配 `^\.[\w-]+$` (以 `.` 开头, 只含单词字符和连字符), 至少配置一个, 否则报 `At least one file extension is required`
  - value 是 LSP languageId (如 `typescript`), 在 `textDocument/didOpen` 时回传给 server
- `env` / `initialization_options` / `settings`: 可选; `env` 是字符串到字符串, 另两个是任意 JSON 对象
- `timeout_ms`: 可选整数, 范围 100-60000, 缺省用 `DEFAULT_REQUEST_TIMEOUT_MS` = 15000

数组级约束: 各 server 的 `name` 必须唯一, 否则报 `LSP server names must be unique`

**显式配置, 不自动安装**: Yukino 不探测、不下载、不安装任何 language server (工具描述里明确声明 `no automatic installation`); `lsp_servers` 未配置时数组为空, 目标扩展名没有匹配的 server 时, LSP 工具直接返回配置提示, 不静默降级:

```txt
No LSP server configured for '.rs'. Add an installed server to lsp_servers.
```

配置在所有宿主间一致装配: 交互式 UI、print 模式、remote、ACP、A2A 都把 `cfg.lsp_servers` 传进共享的 `createToolRegistry`, LSP 工具始终注册 (见 [function-calling](./function-calling))

## LspClient

src/lsp/client.ts 是标准的 stdio JSON-RPC 2.0 客户端, 每个 (工作目录, server) 组合对应一个实例

**进程与线路协议**:

- 构造时 `spawn(command, args, { cwd, env: { ...process.env, ...config.env }, shell: false, detached: <非 win32>, stdio: "pipe" })`; detached 让 killTree 能按进程组 `process.kill(-pid, "SIGKILL")` 清理整棵子进程树 (win32 走 `taskkill /t /f`)
- 消息按 LSP base protocol 分帧: 请求体前加 `Content-Length: N` 头, 以 `\r\n\r\n` 分隔; 头部上限 8KB (`MAX_HEADER_BYTES`), 单条消息上限 16MB (`MAX_MESSAGE_BYTES`), 超限报 `LSP header exceeds 8KB` / `LSP message exceeds 16MB`
- server 的 stderr 被截留最后 4000 字符 (`MAX_STDERR_CHARS`), 进程异常退出时拼进错误信息

**生命周期**: 首次查询某个 (cwd, server) 时才创建会话, 构造函数 spawn 子进程, 随后 `initialize()` 握手:

1. 发 `initialize` 请求, 携带 `processId`、`clientInfo: { name: "yukino" }`、`rootUri` / `workspaceFolders` (都是 cwd 的 file URI)、`initializationOptions` (来自 config), 以及客户端能力:

```jsonc
{
  "general": { "positionEncodings": ["utf-16"] },
  "workspace": {
    "configuration": true,
    "workspaceFolders": true,
    "applyEdit": false,
  },
  "textDocument": {
    "synchronization": { "dynamicRegistration": false },
    "publishDiagnostics": { "versionSupport": true },
    "diagnostic": { "dynamicRegistration": false },
  },
}
```

2. 校验响应: `capabilities` 缺失报 `Invalid LSP initialize response`; server 若声明了非 `utf-16` 的 `positionEncoding`, 报 `Only UTF-16 LSP positions are supported` —— 客户端只支持 UTF-16 位置编码
3. 发 `initialized` 通知; config 有 `settings` 时再发 `workspace/didChangeConfiguration`

**请求与超时**: `request(method, params, signal, timeoutMs)` 分配自增 id、登记到 pending 表, 超时 (`timeout_ms` 缺省 15000) 或 AbortSignal 触发时发 `$/cancelRequest` 并 reject (`LSP <method> timed out after <N>ms` / `LSP request interrupted`); server 返回 `error` 对象时以 `error.message` reject

**只读保证**: 客户端声明 `applyEdit: false`, 并对 server 反向发起的请求做只读应答 (respond 方法):

| server → client 请求                                           | 客户端应答                                                                                           |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `workspace/applyEdit`                                          | `{ applied: false, failureReason: "Yukino LSP is read-only; use authorized file tools for edits." }` |
| `workspace/configuration`                                      | 按 `item.section` 从 config 的 `settings` 逐层取值, 缺失回 `null`                                    |
| `workspace/workspaceFolders`                                   | 单个 cwd 文件夹                                                                                      |
| `window/showMessageRequest` / `window/workDoneProgress/create` | `null`                                                                                               |
| 其他                                                           | JSON-RPC 错误 `-32601` (`Unsupported read-only client method`)                                       |

**关闭**: `dispose()` 幂等, 先发 `shutdown` (超时 500ms) 再发 `exit`, 关闭 stdin; pending 请求统一以 `LSP client disposed` 失败; 500ms (`KILL_DELAY_MS`) 内进程未退出则 killTree 强杀; 进程注册了 `registerExitCleanup`, Yukino 退出时兜底清理

## LSP 工具

LspTool (src/tools/lsp.ts) `name = "LSP"`, `category = "read"` (只读, 见 [permission](./permission)), 注册在基础工具集里; 参数经 zod `strict()` 校验 (多余字段报错):

- `operation` (必填): 11 种, 见下表
- `file_path` (必填): 相对工作目录或绝对路径, 也支持 `~` / `~/...` 展开 (resolveToolPath)
- `line` / `character`: 位置类操作必填, **1-based UTF-16** 偏移 (`line` 与 ReadFile 显示行号一致); 缺任一个报 `This operation requires 1-based line and character (UTF-16).`
- `query`: 仅 `workspaceSymbol` 使用, 且必须非空

operation 到 LSP 方法的映射 (query 方法):

| operation              | LSP 方法                                               | 需要位置 | 说明                                                     |
| ---------------------- | ------------------------------------------------------ | -------- | -------------------------------------------------------- |
| `definition`           | `textDocument/definition`                              | 是       | 跳定义                                                   |
| `references`           | `textDocument/references`                              | 是       | 查引用, 固定带 `context.includeDeclaration: true`        |
| `hover`                | `textDocument/hover`                                   | 是       | 悬停文档和类型                                           |
| `implementation`       | `textDocument/implementation`                          | 是       | 查实现                                                   |
| `typeDefinition`       | `textDocument/typeDefinition`                          | 是       | 跳类型定义                                               |
| `prepareCallHierarchy` | `textDocument/prepareCallHierarchy`                    | 是       | 取该位置的调用层级项                                     |
| `incomingCalls`        | `prepareCallHierarchy` → `callHierarchy/incomingCalls` | 是       | 谁调用它; 对每个层级项各发一次, 返回 `[{ item, calls }]` |
| `outgoingCalls`        | `prepareCallHierarchy` → `callHierarchy/outgoingCalls` | 是       | 它调用谁; 同上                                           |
| `documentSymbol`       | `textDocument/documentSymbol`                          | 否       | 文件符号大纲                                             |
| `workspaceSymbol`      | `workspace/symbol`                                     | 否       | 全库符号搜索, 用 `query`                                 |
| `diagnostics`          | `textDocument/diagnostic` 或 `publishDiagnostics` 缓存 | 否       | 文件的编译/静态诊断                                      |

**文件同步**: 每次查询前 `stat` + `readFile` 目标文件, 与缓存比对; 首次发 `textDocument/didOpen` (带 languageId、version、全文), 内容变化时发 `textDocument/didChange` (全文替换), 未变则只刷新 LRU 顺序 —— server 始终拿到磁盘最新内容

**会话与缓存**: 会话按 `[cwd, config.name]` 缓存, 命中则复用已握手的客户端 (进程已退出时自动重建); 每个会话内:

- 一条 `queue` promise 串行化所有查询, 保证 didOpen/didChange 与后续请求的顺序
- `documents` 缓存打开的文档 (上限 40 个 / 8MB, `MAX_CACHED_DOCUMENTS` / `MAX_CACHED_DOCUMENT_BYTES`), 超限按 LRU 逐出并发 `textDocument/didClose`, 同时丢弃其诊断缓存
- `diagnostics` 缓存 `publishDiagnostics` 推送 (上限 2MB, `MAX_CACHED_DIAGNOSTIC_BYTES`), 按 version 对齐文档, 超限逐出

**诊断的两种模型**: server 声明 `diagnosticProvider` 能力时走 pull (`textDocument/diagnostic` 直接请求); 否则走 push —— 命中缓存立即返回, 未命中则等待一次 `publishDiagnostics` (最长 `min(2000, timeout_ms)` ms), 返回结构:

```jsonc
{ "items": [], "pending": false, "truncated": false }
```

`pending: true` 表示等待窗口内 server 还没推送, **不代表文件健康**; `truncated: true` 表示诊断条目超过 2MB 预算被截断; `items` 为空也不等于编译通过 (取决于 server 是否真的分析了该文件)

**边界与校验**:

- 目标必须是常规文件; 会话前限制 10MB (`LSP requires a regular file no larger than 10MB`), 打开文档时再限制 8MB (`... no larger than 8MB`)
- `line` / `character` 越过文档实际行/列范围报 `LSP position is outside the document`
- 客户端已关闭报 `LSP server exited; retry to start a fresh server`; 工具已 dispose 报 `LSP tool is disposed`; AbortSignal 中断报 `LSP operation interrupted`

**返回约定**:

- 结果是 server 原样返回的 JSON, `JSON.stringify(result, null, 2)` 缩进 2 空格; 超过 100000 字符截断并追加 `[Truncated; narrow the query.]`
- 结果范围用 LSP 标准 (**0-based UTF-16**) 和文件 URI 表示, 与输入的 1-based 约定不同 —— 工具描述和 system prompt 都显式声明这一点, agent 需要 +1 才能对上 ReadFile 的行号
- 无法编辑文件、无法执行任意 server 命令: LSP 工具只做查询

## 与其他工具的关系

- 文本发现用 Grep/Glob, 语义导航用 LSP: 先 Grep 找到入口文件和大致行号, 再用 LSP 追定义、引用和调用链
- 运行时工具指南在工具集含 LSP 时注入 `LSP_RULE` (src/prompt/tools.ts): 配置了 language server 就优先语义查询, 输入 1-based、返回 0-based, `pending=true` 不是健康证明, LSP 从不授权编辑或任意 server 命令 (见 [system-prompt](./system-prompt))
- LSP 是只读工具, 后台异步 subagent 白名单 `ASYNC_AGENT_ALLOWED_TOOLS` 包含它, explore 等只读角色可以完整使用 (见 [subagent](./subagent))
