---
title: "工具调用"
description: "工具调用 (function calling): LLM 负责决策、CLI 负责执行 — 覆盖协议本身、Tool 接口与 ToolRegistry、内置工具的实现要点、各宿主的装配差异, 以及流式解析和执行管线"
local_path: "$HOME/github/yukino-code/apps/yukino"
local_commit: "bef5439b54e6510a12da61bcfa4285ecb1cd2192"
---

工具调用 (function calling) 是 Agent 的核心机制: LLM 负责决策, 请求调用工具; CLI 负责执行工具调用, 把结果回传给 LLM。本页覆盖协议本身、工具接口与注册表、内置工具的实现要点、各宿主的装配差异, 以及流式解析和执行管线。

## 协议: 告诉 LLM 有哪些工具

调用 LLM API 时, 通过 `tools` 参数声明可用工具, 每个工具包含名称 `name`、描述 `description`、参数格式 `input_schema`:

```json
{
  "tools": [
    {
      "name": "ReadFile",
      "description": "Read text with 1-based display line numbers, or images (png, jpg, jpeg, gif, webp) as visual content; not directories...",
      "input_schema": {
        "type": "object",
        "properties": {
          "file_path": { "type": "string" },
          "offset": { "type": "integer", "minimum": 0, "default": 0 },
          "limit": { "type": "integer", "minimum": 1, "default": 2000 }
        },
        "required": ["file_path"]
      }
    }
  ]
}
```

yukino 侧的 `ToolSchema` (src/tools/types.ts) 就是这个形状: `name`、`description`、`input_schema` (`type: "object"` + `properties` + 可选 `required`), 另有 `strict`、`defer_loading`、`cache_control` 等可选字段。`ToolRegistry.getAllSchemas` (src/tools/registry.ts) 按协议把它翻译成各家 API 的工具定义:

- `anthropic`: 原样展开并标注 `type: "custom"`, 延迟加载的工具附 `defer_loading: true`
- `openai` (Responses API): `type: "function"`, `input_schema` 放进 `parameters`
- `openai-compat` (Chat Completions): `type: "function"`, 包在 `function` 对象里

## LLM 决定调用工具

LLM 决定调用工具时, 响应的 assistant 消息里包含结构化的工具调用请求:

```json
{
  "role": "assistant",
  "content": [
    { "type": "text", "text": "Let me read the text content of this file." },
    {
      "type": "tool_use",
      "id": "toolu_123abc",
      "name": "ReadFile",
      "input": { "file_path": "src/main.go" }
    }
  ]
}
```

- 一条 assistant 消息可以既有 text 内容块, 又有 tool_use 内容块, 甚至同时请求调用多个工具
- 每个 tool_use 都有唯一 ID, 后续的 tool_result 靠它配对

## CLI 执行工具调用, 返回结果给 LLM API

CLI 收到 tool_use 后执行对应代码, 把结果作为 role 为 user 的消息回传:

```jsonc
{
  // 工具调用结果, role 是 user
  "role": "user",
  "content": [
    {
      "type": "tool_result",
      // 必须和 tool_use 的 ID 相同
      "tool_use_id": "toolu_123abc",
      "content": "1\tfunction main() {\n2\t  console.log(\"javascript newbie\")\n3\t}",
    },
  ],
}
```

yukino 的历史模型 (src/conversation/index.ts) 与此对应: assistant 消息携带 `toolUses` (ToolUseBlock[]), 工具结果是一条 `content` 为空的 user 消息携带 `toolResults` (ToolResultBlock[])。配对是硬约束 —— 两家 API 都会拒绝 tool_use 缺少对应 tool_result 的请求, 发送前由 `ensureToolPairing` (src/conversation/pairing.ts) 统一修复:

- 结果必须紧跟产生它的 assistant 回合, 连续的 tool_result 消息合并为一组
- 缺失的结果补一条中断占位 (INTERRUPTED_TOOL_RESULT, isError), 孤儿/重复的结果丢弃
- 修复只作用于本次请求的副本, 历史本身忠实记录实际发生的事

## LLM 靠工具描述做决策

LLM 决定是否调用某个工具时, 主要参考工具描述 (description)。工具描述的质量直接决定 LLM 的工具调用行为: 什么时候调用工具、调用哪个工具、如何传递参数。好的工具描述应该包括: 工具的核心功能、什么时候应该调用、什么时候不应该调用、输入参数的 schema、输出的结果格式、与其他工具的配合 (工作流建议, 例如大文件先 Grep 定位再 ReadFile 读取)。

yukino 的所有模型可见描述集中在 src/tools/prompts.ts (Bash 的描述还包含一段 Git 纪律: 只在被要求时 commit/push, 破坏性操作需显式授权, 不得绕过权限/hook 拒绝), 每个工具的 `description` 字段直接引用这些常量。

## 工具接口设计

```ts
export type ToolCategory = "read" | "write" | "command";

export interface Tool {
  // 身份信息
  name: string;
  description: string;
  schema(): ToolSchema; // 生成发给 LLM 的工具定义
  // 元信息
  category: ToolCategory; // 分类, 权限判定和并发默认值的依据
  deferred?: boolean; // 延迟加载 (只有 MCP 工具为 true, 内置工具永不 defer)
  isConcurrencySafe?(args): boolean; // 本次实参是否可并发 (缺省回退 category === "read")
  // 行为
  execute(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult>;
  dispose?(): Promise<void>;
}

export interface ToolResult {
  output: string;
  // 多模态工具调用结果: 可选的富内容块
  contentBlocks?: ToolResultContentBlock[];
  // 工具执行失败对 LLM 是有价值的反馈, 提示它调整策略
  isError: boolean;
}
```

- `category`: `read` / `write` / `command` 三档, 是权限矩阵 (见 [permission](./permission)) 和并发默认值的依据
- `deferred`: 延迟加载标记。MCP 工具按项目配置, 单个 server 动辄几十个长 schema 的工具, 全塞进 tools[] 会吃掉大块上下文; 内置工具数量固定可控, 隐藏它们只会逼模型多绕一圈 ToolSearch, 所以内置工具永不延迟、始终带完整 schema (见 [mcp](./mcp))
- `isConcurrencySafe(args)`: 按本次实参判断能否与其他调用并发, 而不只看分类。同样是 Bash, `ls` 可以和 ReadFile 并发, `rm` 必须独占; 缺省时回退到 `category === "read"`
- `contentBlocks` 支持的类型 (按 Anthropic tool_result 内容块归一化, `normalizeToolResultContentBlock` 校验): text、image (base64 的 jpeg/png/gif/webp 或 url)、document (base64 PDF / text/plain 文本 / content 块数组 / url)、tool_reference (native 延迟加载展开)、search_result
- `dispose`: 注册表释放时调用 (如 BashTool 释放其沙箱实例)

`ToolContext` 是 execute 的运行时上下文 (src/tools/types.ts):

| 字段                   | 作用                                                                                                           |
| ---------------------- | -------------------------------------------------------------------------------------------------------------- |
| `cwd`                  | 本次调用的工作目录                                                                                             |
| `toolCallId`           | 本次调用的唯一 ID                                                                                              |
| `sessionId`            | 主会话 ID, 后台命令的输出文件写进该会话的 tool-results 溢出目录                                                |
| `abortSignal`          | 中断信号 (Esc / 停止)                                                                                          |
| `taskManager`          | 后台任务注册表; subagent 循环注入自己的 manager, 显式传 `null` 表示本次调用禁用后台化 (进程内 teammate 回合用) |
| `shellTimeoutDisabled` | 禁用 shell 超时计时                                                                                            |
| `fileHistory`          | 文件快照, 支撑 /rewind 回退 (见 [worktree](./worktree) 之外的文件历史)                                         |
| `fileStateCache`       | 读写门禁缓存 (read-before-write)                                                                               |
| `permissionChecker`    | 权限检查器 (见 [permission](./permission))                                                                     |
| `onPermissionRequest`  | 需要授权时的宿主回调                                                                                           |
| `goalManager`          | 持久目标管理器 (见 [goal](./goal))                                                                             |

另有 `backgroundTaskId`、`subagentSessionId`、`onOutput`、`approvedPermissionMode` 等字段服务于后台任务和权限续判。

## ToolRegistry: 可见性与缓存稳定

`ToolRegistry` (src/tools/registry.ts) 是工具的装配点:

- `register` / `registerBorrowed` / `unregister` / `get` / `getInstanceOf` / `listTools`; `dispose` 时先跑 cleanup 回调, 再逐个 `dispose` 自己拥有的工具, 失败聚合为 AggregateError
- `getAllSchemas(protocol, filter)` 和 `listVisibleToolNames` 共用同一套可见性谓词, 保证「对外宣称可用的工具」和「实际可调用的工具」一致
- `mcpLoadingMode` (`eager` / `native` / `dispatch`) 由 mcp/strategy 在连接 server 后写入; `exposeToolSearch` / `exposeMcpCall` 在会话开始时算定一次, 不逐轮重算 —— tools 数组渲染在 system 之后、messages 之前, 数组任何变动都会使整段历史缓存失效 (实测两万 token 历史下, 往 tools 末尾追加一个工具使命中率从 99.4% 掉到 9.5%)
- 延迟工具 (`deferred && !discovered`) 的可见性: native 模式下留在 tools[] 里带 `defer_loading`, 由服务端决定是否展示给模型; dispatch 模式下直接从 tools[] 中隐藏, 走 McpCall; eager 模式没有延迟工具, ToolSearch / McpCall 也不暴露
- `searchDeferred(query, maxResults)` 按名称和描述子串匹配, `findDeferredByNames` 支持 `select:a,b` 直选, `markDiscovered` 把工具转正

## 内置工具一览

`createToolRegistry` (src/bootstrap/tool-registry.ts) 注册的基础工具, 交互式宿主 19 个, 非交互宿主 18 个 (不含 EnterPlanMode):

| 工具                         | 分类    | 并发               | 场景                                                                                                   |
| ---------------------------- | ------- | ------------------ | ------------------------------------------------------------------------------------------------------ |
| ReadFile                     | read    | 是                 | 读文本 / 读图片                                                                                        |
| WriteFile                    | write   | 否                 | 创建或重写文件                                                                                         |
| EditFile                     | write   | 否                 | 批量精确替换修改文件                                                                                   |
| Bash                         | command | 看命令             | 执行 shell 命令                                                                                        |
| PowerShell                   | command | 否                 | Windows/pwsh 命令                                                                                      |
| Glob                         | read    | 是                 | 按模式查找文件名                                                                                       |
| Grep                         | read    | 是                 | 按正则查找文件内容                                                                                     |
| WebFetch                     | read    | 是                 | 抓取 URL 转 Markdown                                                                                   |
| LSP                          | read    | 是                 | 语言服务器语义查询 (见 [lsp](./lsp))                                                                   |
| ComputerUse                  | command | 恒否               | 操作本机 GUI                                                                                           |
| Goal                         | read    | 否                 | 持久目标的查询和进度/完成/受阻汇报 (见 [goal](./goal))                                                 |
| TodoWrite                    | read    | 是                 | 任务板的原子增量读写 (见 [task-tracking](./task-tracking)); 有 team 时换成团队感知版 TeamTodoWriteTool |
| TaskOutput                   | read    | 是                 | 查看后台任务状态和结果                                                                                 |
| EnterWorktree / ExitWorktree | write   | 否                 | git worktree 隔离 (见 [worktree](./worktree))                                                          |
| EnterPlanMode / ExitPlanMode | read    | EnterPlanMode 恒否 | 进入/退出 plan 模式 (见下)                                                                             |
| ToolSearch                   | read    | 是                 | MCP 延迟工具的发现和加载通道 (见 [mcp](./mcp))                                                         |
| McpCall                      | command | 否                 | dispatch 模式下 MCP 工具的统一调用入口 (见 [mcp](./mcp))                                               |

基础注册之外, 宿主再注册交互类工具: LoadSkill / InstallSkill (见 [skills](./skills))、AskUserQuestion、Agent (见 [subagent](./subagent))、Workflow (见 [workflow](./workflow))、SyntheticOutput、团队工具 TeamCreate / SendMessage / TeamList / TeamDelete / TaskStop (见 [agent-team](./agent-team))。

### ReadFile

src/tools/read-file.ts, 参数 `file_path` (必填)、`offset` (默认 0, 0-based)、`limit` (默认 2000):

- 行号: 输出带 1-based 行号前缀 `"1\tfunction main() {\n2\t..."`, 方便 LLM 定位代码位置
- 大文件: `offset` 分段, 未读完时尾部追加 `[N more lines in file. Use offset=X to continue.]`
- 输出预算: 单次输出上限 50KB (MAX_READ_BYTES), 单行超限直接报错建议用 Bash 分段看; 整文件读取的准入上限 10MB (MAX_READ_FILE_BYTES), 超过提示改用 Grep 或 head/tail/sed —— 读取是整文件进内存再切片, 准入检查必须在 50KB 输出上限之前
- 图片: 扩展名命中 (png/jpg/jpeg/gif/webp) 或魔数嗅探命中 (无扩展名/假扩展名的图片也能识别) 时, 返回 `[Image: mediaType]` + base64 image 内容块, 忽略 offset/limit
- 读目录直接报错并提示用 Glob 列目录
- 读后校验: 重新 stat 比对 mtime/size, 读取期间文件被外部改过则报错要求重读; 成功则 `fileStateCache.record(path, mtimeMs)`, 解锁后续 EditFile/WriteFile

### WriteFile / EditFile

WriteFile (src/tools/write-file.ts), 参数 `file_path`、`content`:

- 创建或整体重写, 创建时递归建父目录, 空字符串创建/截断为空文件
- 读写门禁: 文件已存在 (或已在缓存中) 时必须先 ReadFile (`fileStateCache.check` 给出 `file has not been read yet` / `modified since last read` / `deleted` 三类错误), 全新文件跳过门禁
- 写前 `fileHistory.trackEdit` 备份原内容, 写后 `fileStateCache.update` 同步缓存
- 成功输出 `Successfully wrote to <path> (N lines)`

EditFile (src/tools/edit-file.ts), 参数 `file_path`、`edits[]` (每项 `old_string` / `new_string` / `replace_all` 默认 false, 数组至少一项):

- 批量编辑: 所有条目针对原始文件匹配, 一次写盘; 替换按起点排序后拼接, 重叠条目在写盘前被拒绝 `edits[N] overlaps another edit. Merge overlapping changes into one edit`
- `old_string` 必须非空; `replace_all === false` 时必须唯一匹配, 匹配多个报 `edits[N].old_string occurs more than once in file. It must be unique. Add more surrounding context, or set replace_all to true`, 没找到报 `edits[N].old_string not found in file` 并附失配诊断 (edit-file-diagnostics 分析 LLM 记忆的内容为何对不上)
- 替换前后文本相同 (行尾归一后) 直接报错 `edits[N] would not change the file`; `new_string` 为空表示删除 `old_string`
- 匹配容错: LF 和 CRLF 行尾等价匹配 (行间以 `(?:\r\n|(?<!\r)\n)` 连接); 匹配失败时剔除 old_string/new_string 中的游离回车 (CR) 后重试 —— LLM 常把 CRLF 文件读成 LF 记忆; 替换文本沿用匹配处的行尾
- 成功输出包含 diff: `Updated <path> with N additions and M removals (K replacements)` + 前后缀公共行算法生成的行号 diff (上下文 3 行, 超过 200 行截断, 行号按新文件编号以便后续编辑定位)
- 门禁复查: 匹配前后各 `fileStateCache.check` 一次; 写操作按 realpath 经文件互斥队列串行化 (file-mutation-queue), 不同文件互不阻塞

两个写工具都经 `withWorkspaceMutation`: 按规范化 cwd 取工作区互斥锁, 写类操作同一时刻只有一个在跑; 取锁后、执行前还会重查一次权限 (等待排队期间权限模式可能已变, 变了就报 `Permission changed while waiting`)。

### Bash / PowerShell

Bash (src/tools/bash.ts), 参数 `command` (必填)、`timeout` 秒 (默认 120, 上限 600, 超过钳制)、`run_in_background` (仅当注入了 TaskManager 才出现在 schema 里):

- 工作目录是本次调用的 `ctx.cwd`; 每次调用都是全新独立 shell, cd、变量、函数不跨调用保留 (描述里明示)
- 并发安全: `isConcurrencySafe(args) = isSafeCommand(command)`, 复用权限层的安全命令白名单; 重定向、管道、命令链、命令替换一律不算安全命令
- 执行: `spawn("bash", ["-c", command])`, `detached` 独立进程组; stdout+stderr 直写同一个输出文件的 fd (POSIX 以 O_APPEND 原子交错, O_NOFOLLOW 防符号链接劫持), 输出不经过 JS 堆 —— 后台化因此只是记账切换, 不需要重新 spawn 或移交缓冲
- 沙箱: 宿主可给 BashTool 注入 OS 沙箱 (seatbelt/bwrap), 沙箱配置允许写输出文件所在目录; `sandboxRequired` 而沙箱不可用时拒绝执行 (见 [sandbox](./sandbox))
- 终止: 先 SIGTERM 整个进程组, 3s 宽限后 SIGKILL; `exited` 标志防止子进程回收后按陈旧 pid 误杀; 不用 spawn 自带的 timeout/signal 选项 —— 那只发给直接子进程, 会 spawn 孙进程或 trap SIGTERM 的命令杀不干净
- 输出: 500ms 轮询文件大小的 watchdog, 超过 5GB 磁盘上限直接终止 (输出附 `Command killed: output file exceeded 5GB`); 前台结果内联上限 10MB —— 以内联全文并删除文件, 超过则全文留在磁盘, 结果里只放 2000 字符预览 + 文件路径 (模型可以 ReadFile 读回), 截断按 UTF-8 字符边界
- 退出码提示: 非零退出码附语义提示 (exit-code-hints): 按管道/命令链的最后一段命令名查表 —— grep/rg/findstr 的 1 是没有匹配, diff/cmp 的 1 是文件有差异, test/`[`/expr/find/robocopy 各有解释; 通用信号码 126/127/129/130/137/141/143; POSIX 129-159 回退 `terminated by signal N-128`
- 后台机制: 三种触发 —— `run_in_background: true` 显式后台 / Ctrl+B 手动转后台 (遍历 Bash + PowerShell 的前台任务) / 超时自动转后台; 后台输出写会话目录的 `shell-<16位hex>.output`, 完成通知正文预算 30KB, 超过则通知携带文件路径 + 预览; 后台化会释放工作区锁、摘除 abort 监听 (命令从此不受 Esc 牵连, 只能被 TaskStop、会话退出或 5GB 上限终止); 进程退出清理注册在 exit-cleanup, 崩溃路径也不会留下孤儿进程组; 没有 TaskManager 时退化为纯前台: 无 run_in_background 参数, 超时直接杀, Ctrl+B 无效

PowerShell (src/tools/powershell.ts) 与 Bash 共享同一套 shell-background 基础设施 (输出文件、watchdog、后台化、通知格式), 差异:

- win32 用 `powershell.exe` (命令前缀强制 `[Console]::OutputEncoding` 为 UTF-8), 其他平台用 `pwsh` (缺失时 spawn 错误附安装提示); 参数 `-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command`
- 进程树终止: Windows 走 `taskkill /pid N /T` (SIGKILL 等价时加 `/F`), POSIX 才需要 `detached` 进程组
- 不做 OS 沙箱包装 (两种沙箱都只包 bash), Windows 本身也没有沙箱支持
- 提示词标记 `PS> `, 后台任务 id 前缀 `ps`

### Glob

src/tools/glob.ts, 参数 `pattern` (必填)、`path` (默认 "."):

- 按 glob 查找文件名, 结果相对 `path`; 无 `/` 的模式按 basename 匹配任意深度 (matchBase), 有 `/` 的按相对路径匹配
- 排序: 修改时间倒序, 同 mtime 字典序; stat 失败的按最旧处理
- 最多 1000 个匹配, 总输出另受 50KB 预算约束, 截断时附提示; 无匹配输出 `No files matched the pattern.`
- 默认包含 dotfiles (`dot: true`, agent 需要 .github/workflows、.eslintrc 这类隐藏文件); 遍历跳过固定目录集 SKIP_DIRS (.git、.yukino、.agents、.next、.venv、.mypy_cache、\_\_pycache\_\_、dist、node_modules), 不读 .gitignore 规则; 符号链接目录不下钻
- 扫描根从 pattern 的静态前缀推导, 权限检查器可再按路径过滤

### Grep

src/tools/grep.ts, 参数 `pattern` (必填)、`path` (默认 ".")、`include`:

- 输出格式 `文件相对路径:行号:匹配内容` (1-based); 最多 500 个匹配行, 总输出 50KB 预算; 单行超 2000 字节截断加省略号并计数提示; 无匹配输出 `No matches found.`
- 正则是 JS 风格: 先经 `toUnicodePattern` 把 `\w`、`\W`、`\d`、`\D`、`\b`、`\B` 重写为 Unicode property escapes (JS 的这些元字符默认只认 ASCII, 重写后 `\w+` 能匹配中文, `\b` 在 CJK 旁也成立), `\x{FFFF}` 转成 `\u{FFFF}`; 再以 `iu` 标志编译 (大小写不敏感), u-mode 拒绝的模式 (如孤立的 `{`) 退化为不带 u 编译, 都失败报 `invalid regex pattern`
- `include` 是 minimatch glob: 裸模式 (无 `/`) 匹配任意深度的文件名, 含 `/` 匹配 workDir 相对路径; 同样 dot:true
- 二进制检测: 前 8KB 嗅探 NUL 字符; 超过 25MB 的文件跳过; 遍历上限 10000 个条目 / 深度 25; 文件符号链接跟读, 目录符号链接不下钻
- 灾难性回溯防护: 逐行匹配放在 worker 线程, 每个文件给 2-10s 的预算 (按文件大小折算), 超时终止 worker 并报 `the pattern timed out while matching (likely catastrophic backtracking)`, 主循环的 UI 心跳和取消始终可用

### WebFetch

src/tools/web-fetch.ts, 参数 `url`:

- 仅 http/https; 重定向自动跟随, 最终 URL 与请求不同时输出前缀 `[Redirected to ...]`
- 上限: 单响应 10MB (content-length 预检 + 流式读取时按字节复检), fetch 超时 60s, Markdown 截断 100k 字符 (代理对安全, 截断附 `[Content truncated due to length...]`)
- HTML → Markdown 用 turndown (懒加载单例, 移除 script/style); 其他文本格式原样返回; 二进制 content-type 拒绝 (text/*、JSON、XML、application/javascript 等视为文本)
- 缓存: 按 URL 15 分钟 TTL, 总预算 50MB, 插入序最旧先逐出, 过期条目访问时删除

### ComputerUse

src/tools/computer-use.ts, 操作本机 GUI: 截图、点击、输入、滚动、缩放:

- 两种调用风格: Anthropic 风格单动作 (`action` 取 key、hold_key、type、left_click、double_click、left_click_drag、scroll、screenshot、zoom、wait、cursor_position 等), OpenAI 风格批量 `actions[]` (type 取 click、double_click、drag、keypress、move、screenshot、scroll、type、wait, 单批 1..100 个, 顶层还接受平铺的 OpenAI 别名); 两者互斥, 混传或缺失都报错
- 批量顺序执行, 失败时报错并列出已执行的动作; 批后必带截图 —— 批内最后一个 screenshot 动作的结果, 没有则补拍一张 (补拍失败降级为纯文本结果); `status` / `pendingSafetyChecks` 原样回执
- 坐标空间: 截图缩放到 ≤1366x900, 截图结果注明 `Use this coordinate space for subsequent actions`; 动作坐标以缩放空间给出, 内部按最近一次截图记录的缩放比例换算回物理像素
- 平台实现: macOS 用 Swift helper (swiftc 现编) + `/usr/sbin/screencapture`; Windows 用 PowerShell 编译 C# helper; Linux 输入用 xdotool, 截图依次尝试 gnome-screenshot / scrot / ImageMagick import
- 独占: 进程间文件锁 (tmpdir 下的 yukino-computer-use) 保证同一时刻只有一个调用控制屏幕/键盘/鼠标, 抢不到锁报 `the computer is being controlled by another Yukino call`; `isConcurrencySafe` 恒 false; 分类 command
- 每个子命令 15s 超时, 输出上限 32MB

### 其他基础工具

- LSP (src/tools/lsp.ts): operation 取 definition、references、hover、documentSymbol、workspaceSymbol、implementation、typeDefinition、prepareCallHierarchy、incomingCalls、outgoingCalls、diagnostics; 行/列是 1-based UTF-16 输入, 返回 LSP 标准的 0-based 范围; 详见 [lsp](./lsp)
- Goal (src/tools/goal.ts): `action` 取 get/update, update 必须带 status (in_progress/complete/blocked) 和 reason; 详见 [goal](./goal)
- TodoWrite (src/todo/tools.ts): schema 由 zod 定义转 JSON Schema, 输出 boardId + todos + 进度标签; 详见 [task-tracking](./task-tracking)
- TaskOutput (src/tools/task-output.ts): `task_id` 必填, `wait` 可选等待一次, `timeout_ms` 默认 30000、上限 60000; 返回 JSON 化的任务快照 (status/output/error/transcript_path 等), 不消耗完成通知; 与 TodoWrite 的任务板是两套 ID
- EnterPlanMode (src/tools/enter-plan-mode.ts): 无参数 (strict 空 schema), 同步跑内置 plan agent 做只读调研并产出计划文件, 仅交互式宿主注册 (`enableModelPlanMode ?? interactionMode !== "non-interactive"`), 委派 agent 不可用
- ExitPlanMode (src/tools/exit-plan-mode.ts): 要求当前处于 plan 模式且计划文件非空; 主 agent 提交给用户审批, teammate 走团队审批策略, 一次性 subagent 交回父级; EnterPlanMode/ExitPlanMode 任一成功后, agent 循环本轮暂停等待审批
- EnterWorktree / ExitWorktree: 分类 write; 进入时 slug 缺省随机生成, 每个 agent 同时只能有一个 worktree 会话, 进入后清空 fileStateCache; 详见 [worktree](./worktree)
- ToolSearch (src/tools/tool-search.ts): `query` 支持 `select:name1,name2` 直选或关键词检索延迟工具, `max_results` 默认 5 (钳制 1..50); 命中后 `markDiscovered` 转正, native 模式对 MCP 工具返回 `tool_reference` 内容块交给服务端展开, dispatch 模式在输出里指引走 McpCall; 详见 [mcp](./mcp)
- McpCall (src/tools/mcp-call.ts): `server` / `tool` / `arguments` 必填, 分类 command, 自身永不 defer (它是 dispatch 模式的入口); 参数先经 `coerceBySchema` 按目标工具的完整 schema 逐层纠偏 (number→string、数字字符串→integer/number、"true"/"false"→boolean、单键对象包裹的数组解包、逗号分隔字符串切分、object/array 递归), 纠不动的原样透传让 MCP server 报自己的领域错误; 权限匹配内容统一归一为 `server__tool` 形式
- AskUserQuestion (src/tools/ask-user.ts): `questions[1..4]`, 每题 `{ question, options[2..4] { label, description? }, multiSelect }` (schema 禁止额外字段); 宿主注入的 asker 弹出选择对话框并自动追加 "Other" 自定义输入项, 返回 `Record<问题文本, 答案>` 拼成 `User has answered your questions: "q" = "a", ...`; 用户取消时返回错误结果; 只在材料性歧义时使用, 不重复请求已给出的授权
- SyntheticOutput (src/tools/synthetic-output.ts): 让 agent 以结构化 JSON 交付最终结果, 可选 jsonSchema 做顶层类型 + required 字段校验, 字符串直接返回不再包一层 JSON

## 工具注册的装配

`createToolRegistry(cwd, taskList, options)` 的注册顺序: Goal、TodoWrite (有 teamManager 时换成 TeamTodoWriteTool)、TaskOutput、LSP、Bash、PowerShell、ComputerUse、EditFile、EnterPlanMode (条件注册)、EnterWorktree、ExitPlanMode、ExitWorktree、ReadFile、ToolSearch、McpCall、WriteFile、Glob、Grep、WebFetch。options 包括 `enableModelPlanMode`、`interactionMode` ("interactive" / "non-interactive")、`lspServers`、`teamManager`。

宿主在基础注册之上的差异:

- 交互式 UI (src/ui/app.tsx): + LoadSkill、InstallSkill、AskUserQuestion、Agent、Workflow、SyntheticOutput、TeamCreate、SendMessage、TeamList、TeamDelete、TaskStop; `attachBackgroundTaskManager` 把后台任务注册表共享给 Bash/PowerShell/TaskOutput, 使 run_in_background、Ctrl+B 和后台 agent 走同一个通知管道
- remote (src/remote/server.ts): 与 UI 相同的装配, 但没有 InstallSkill; LoadSkill 额外带 fork host (fork 模式 skill 在隔离子代理中执行); AskUserQuestion 仅在提供 askUser 处理器时注册; 浏览器端的 Ctrl+B 等价能力通过同样的 backgroundAllForegroundTasks 实现
- print 模式 (src/print-mode.ts): + Agent、Workflow、SyntheticOutput、TeamCreate、SendMessage、TeamList、TeamDelete、TaskStop (无 skills、无 AskUserQuestion); 权限检查器固定 bypassPermissions, 没有审批通道 (见 [print-mode](./print-mode))
- teammate / subagent: `filterToolsForAgent` / `cloneRegistryForTeammate` (src/subagent/tool-filter.ts) 分层过滤 —— MCP 工具豁免全局层, 但仍受定义级黑白名单约束; 全局禁用 SUBAGENT_DISALLOWED_TOOLS (Workflow、ComputerUse、AskUserQuestion、EnterPlanMode、ExitPlanMode、Goal、Agent、TeamCreate、TeamDelete、SendMessage —— 主线程独占设备或防递归); 后台 Agent 再过一道 ASYNC_AGENT_ALLOWED_TOOLS 白名单; 最后叠加定义级 disallowedTools 黑名单和 tools 白名单 (`"*"` 关闭白名单层); TodoWrite/ToolSearch/McpCall/LoadSkill/TaskStop 换成委派作用域的实例。详见 [subagent](./subagent)

## 流式 tool_use 解析: 拼接 partial_json 碎片

Anthropic 流式协议里, 工具参数以碎片形式到达 (src/llm/anthropic.ts):

```txt
# tool_use 块开始
content_block_start -> type: "tool_use", id: "toolu_123abc", name: "ReadFile"

# 传输 JSON 碎片
content_block_delta -> type: "input_json_delta", partial_json: "{"
content_block_delta -> type: "input_json_delta", partial_json: "\"path\""
content_block_delta -> type: "input_json_delta", partial_json: ": \"/main.js\"}"

# tool_use 块结束
content_block_stop
```

- `content_block_start` 要求 tool_use 块带有效 id 和 name, 否则抛 NetworkError; 官方 `computer` 工具名在这里映射为内部的 `ComputerUse`
- 每个 `input_json_delta` 追加进累加器, 同时以 `tool_call_delta` 事件透传给 UI 做流式展示; 没有先收到合法 tool_use 就到达的参数碎片同样抛 NetworkError
- `content_block_stop` 时统一 `parseToolArguments` (src/llm/events.ts) 一次性 JSON.parse: 空串视为 `{}`; 解析失败或结果不是对象时不中断循环, 而是把 parseError 挂在 tool_call_complete 上, 最终作为错误工具结果 (`Error: <parseError>. The tool was not executed.`) 反馈给 LLM 自纠
- OpenAI 系协议 (Responses / Chat Completions) 的 function arguments 流也收敛到同一组 StreamEvent (tool_call_start / tool_call_delta / tool_call_complete), 复用同一个 parseToolArguments

历史侧的配对规则:

- tool_use 的 role 是 assistant, tool_result 的 role 是 user
- 一条 assistant 消息里的 text 块和 tool_use 块必须在同一条消息中, 不能拆成两条 assistant 消息 (ConversationManager.addAssistantFull 整条写入)
- 一条 assistant 消息有多个 tool_use 时, 对应的多个 tool_result 必须在同一条 user 消息中, 通过 id 配对 (addToolResultsMessage 一次写入整批)

## 工具执行的完成流

agent 循环 (src/agent/index.ts, 见 [react-and-agent-loop](./react-and-agent-loop)) 把一批 tool_use 交给执行管线:

1. 分批 (partitionToolCalls): 按 `tool.isConcurrencySafe(args) ?? tool.category === "read"` 判断单次调用是否可并发, 连续的可并发调用并进一个 parallel 批, 其余各自成串行批
2. 批内逐个过检查 (executeBatch): 中断检查 → 工具过滤器检查 (委派 agent) → McpCall 参数预处理与目标解析 → hook 引擎 PreToolUse 钩子, 被拒则回 `Rejected by hook: ...` (见 [hook](./hook)) → 权限判定: McpCall 同时检查包装器和目标工具两条规则, deny 优先, ask 次之; ask 而无审批处理器直接报错不执行; ask 走 onPermissionRequest, allowAlways 时把展示过的模式持久化 (见 [permission](./permission))
3. 执行 (StreamingExecutor, src/agent/streaming-executor.ts): 批内调用并发提交, `runPending` 谁先完成先 yield 谁的 tool_result 事件, UI 即时渲染每个工具的完成; parseError 直接变成错误结果, 未知工具名报 `Error: unknown tool '<name>'` 让模型换工具重试, 中断报 `Tool execution was cancelled before it started.`; 每次执行包一层 telemetry 观测
4. 回写历史: 主循环一边把完成事件即时 yield 给 UI, 一边按 toolId 收集进 Map; 整批完成后按 LLM 给出的原始调用顺序重建 tool_result 块数组, 一条 user 消息写入历史 —— 完成顺序负责交互的实时性, 原始顺序负责配对和回放的稳定性
5. 结果预算: 单条结果超 50000 字符 (MAX_OUTPUT_CHARS) 落盘换成预览 + 路径, 整批再过一遍 200000 字符的聚合预算 (MESSAGE_AGGREGATE_LIMIT), 防止并发扇出的多个「合规」结果加起来撑爆上下文; 刚从溢出文件读回的结果豁免再次落盘, 避免读回-溢出死循环
