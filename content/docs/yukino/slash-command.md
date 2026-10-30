---
title: "Slash Command"
description: "Slash Command: / 输入在进入 agent loop 前被拦截, 解析, 匹配注册表并按类型 (local / local_ui / prompt / skill_fork) 分派; 覆盖注册顺序与优先级, 内置命令清单, 用户自定义命令与参数替换, 命名 workflow, skill 命令, 输入补全与使用频率追踪, 各前端宿主差异"
local_path: "$HOME/github/yukino-code/apps/yukino"
local_commit: "bef5439b54e6510a12da61bcfa4285ecb1cd2192"
---

Slash Command: 以 `/` 开头的输入在进入 agent loop 之前被命令系统拦截, 先解析、匹配注册表, 再按命令类型分派 —— 要么就地执行本地 UI 动作, 要么构造 prompt 发给 LLM。命令的定义、解析、注册集中在 `src/commands/`, 分派逻辑由各前端宿主 (终端 UI、remote WebSocket server 等) 各自实现

## 命令解析与注册

### 解析规则 (src/commands/commands.ts)

`parse` 把输入切成命令名 + args:

- 只有以 `/` 开头的输入才进入命令流程; 首个空白之前的部分是命令名, 其余部分去掉首尾空白后作为 `args`
- 命令名不允许包含 `/`: 名字里带 `/` 的输入被判定为文件系统路径 (如 `/path/to/file`), `parse` 返回 `null`, 按普通用户消息处理
- 注册表查找大小写不敏感 (`/HELP` 命中 `help`), `resolve` 返回注册时的规范命令名

`resolve` 还内置了 `/skill` 路由捷径:

- `/skill <name> [args]` 改写为 `/<name> [args]`, 即按名运行 skill
- `/skill reload` 路由到 `/skills reload`
- `/skill` 不带参数时不改写, 注册表里没有 `skill` 命令, 报 unknown command

### Command 结构与 CommandRegistry

```ts
interface Command {
  name: string;
  type: "local" | "local_ui" | "prompt" | "skill_fork";
  description: string;
  handler: (ctx: CommandContext) => string;
  agent?: string; // prompt 命令在指定名称的前台 subagent 里执行
  isSkill?: boolean; // skill 派生命令, 从 /help 清单中排除
  markdown?: boolean; // handler 返回 markdown 富渲染 (如 /help 的表格)
}
```

- handler 一律返回字符串, 含义随类型而变: local 型是展示文本, local_ui 型是动作 token, prompt 型是要发给 LLM 的 prompt 文本
- `CommandContext` 携带 `cwd`、`args` 和一组可选能力钩子 (`permissionMode`、`tokenCount`、`toolCount`、`memoryList`、`model`、thinking 级别的读写与持久化等), 由宿主在调用时按需注入
- `CommandRegistry.register` 遇到重名 (不区分大小写) 直接抛错 `Command '<name>' already registered`; 注册方捕获异常即可实现「先注册者赢」
- `listCommands` 按字母序排列, 供 `/help` 和输入补全使用

### 注册顺序与优先级

终端 UI (src/ui/app.tsx) 和 remote WebSocket server (src/remote/server.ts) 都以 `createDefaultRegistry()` 为底座, 再按顺序追加注册, 名字已被占用时跳过:

1. 内置命令 (src/commands/commands.ts)
2. `/provider`: 不在默认注册表里, 由 TUI 和 remote 各自单独注册 (remote 侧注释为「镜像终端注册, 让浏览器也能用 /provider」)
3. 用户自定义命令 `loadUserCommands()`; 与内置命令冲突时抛错被捕获, 保留内置命令
4. skill 命令 `wireSkillsToRegistry()`; 跳过已占用的名字, 所以用户 `*.md` 文件优先于同名 skill
5. 命名 workflow 命令 `registerNamedCommands()`; 同样跳过已占用的名字

## 四种命令类型

| 类型       | 进入 agent loop    | 行为                                                                                                   |
| ---------- | ------------------ | ------------------------------------------------------------------------------------------------------ |
| local      | 否                 | handler 返回的字符串直接作为 system 消息展示                                                           |
| local_ui   | 否                 | handler 返回动作 token (如 `"login"`、`"compact"`), 由 UI 执行对应动作: 打开对话框、切换模式、重置会话 |
| prompt     | 是                 | handler 构造 prompt 作为用户消息发给 LLM API; 设置 `agent` 时在指定名称的前台 subagent 里执行          |
| skill_fork | 是 (隔离 subagent) | skill 加载后自动注册的 fork 型命令, UI 构造 fork host 在独立 subagent 中执行                           |

> 不参与 agent loop ≠ 不调用 LLM API。`/compact` 是 local_ui 型, 但 `forceCompact` 会调用 LLM API 生成上下文摘要; `/feedback` 的会话分析也在前台 subagent 里跑。反过来, local / local_ui 命令本身不会把用户输入送进 agent loop

## 分派流程 (终端 UI)

提交入口 `processSubmission` (src/ui/app.tsx): 先 `refreshSkillsIfNeeded` (skill 目录有变动时热重载并重接命令), 再判断输入是否以 `/` 开头; 是则走 `handleSlashCommand`, 否则作为普通用户消息进入 agent loop

`runSlashCommand` 的判定顺序:

1. `resolve` 返回 `null` (不以 `/` 开头, 或命令名含 `/`) → 返回 false, 交回普通用户消息路径
2. `/mcp` 按名字拦截: `/mcp reload` 重读配置并 reconnect; 否则先尝试连接尚未连接的 server, 再列出已连接 server 和 MCP 工具数
3. 注册表查不到 → `Unknown command: /<name>`
4. `/goal` 按名字拦截: 调用 `handleGoalCommand` 本地处理, 见 [goal](./goal)
5. `/status`、`/memory` 按名字拦截, 用实时应用状态渲染比注册表 handler 更丰富的输出
6. 之后按类型分派: local_ui 走动作 token 的 switch; local 执行 handler 并把结果作为 system 消息 (例外: 裸 `/thinking` 且 client 支持设置时打开强度选择器); prompt 型带 `agent` 的走 `runSubagentCommand`, 不带的把 handler 输出作为用户消息跑一轮 agent loop; skill_fork 走 `runFork`

所有命令经 `handleSlashCommand` 包裹 try/catch: 命令抛错会变成 `Error: ...` 系统消息展示, 界面保持可操作, 不会变成未处理的 rejection

每次命令执行都会通过 `recordInput` 记录一条带 `commandName` (解析后的规范命令名) 的输入历史, 供使用频率统计 (见下文)

## 内置命令清单

| 命令                   | 类型     | 行为                                                                                                                                                                                                                                                                                                                      |
| ---------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| /workflows             | local_ui | 无参数打开 workflow 运行监控面板; 带参数交给 `WorkflowService.command`: `list`、`<runId>` 查看结果、`stop <runId>`、`resume <runId>` (见 [workflow](./workflow))                                                                                                                                                          |
| /ultracode [args]      | prompt   | handler 拼接 `ULTRACODE_PROMPT` + 任务描述, 引导主 agent 用 Workflow 工具编排多 subagent, 后台运行, 用 /workflows 监控 (见 [workflow](./workflow))                                                                                                                                                                        |
| /login                 | local_ui | 打开 provider 配置表单, 保存并激活一个 LLM provider                                                                                                                                                                                                                                                                       |
| /provider              | local_ui | 切换当前 provider; 配置里少于 2 个 provider 时只显示当前 provider 和模型, 否则打开 provider 选择对话框                                                                                                                                                                                                                    |
| /model [model]         | local_ui | 切换当前 provider 的模型; 无参数时打开模型选择器                                                                                                                                                                                                                                                                          |
| /help [command]        | local    | 无参数列出全部命令的 markdown 表格 (不含 skill 派生命令); 带参数显示单个命令的详情                                                                                                                                                                                                                                        |
| /clear                 | local_ui | 停掉后台任务和团队、生成新 session id、重置会话/消息/文件状态/记忆提取等状态, 重新注入长期记忆与 MCP 说明                                                                                                                                                                                                                 |
| /compact [focus]       | local_ui | 强制上下文压缩, 参数串作为附加关注点传给 `forceCompact`, 压缩边界持久化到会话文件 (见 [context-compaction](./context-compaction))                                                                                                                                                                                         |
| /status                | local    | UI 拦截后展示当前会话状态: 权限模式、模型、provider、token、工具数、沙箱、记忆、skills、MCP、session id、目录                                                                                                                                                                                                             |
| /session               | local    | 确认当前会话活跃 (`Session is active. Use /resume to list past sessions.`); 历史会话用 /resume                                                                                                                                                                                                                            |
| /plan [args]           | prompt   | 在内置 plan agent 里规划当前任务: handler 输出 `PLAN_AGENT_PROMPT` + 规划请求, `runSubagentCommand` 以 fork 方式继承父上下文; 成功后保存计划文件并进入 plan 审批 (见 [subagent](./subagent))                                                                                                                              |
| /goal [args]           | prompt   | 持久目标命令, 注册类型是 prompt 但各宿主都按名字拦截本地处理: status (默认)、pause、complete、clear 不消耗 LLM token; 设置/替换 (`replace`, `--budget <tokens>`) 和 resume / continue 才注入 prompt 启动循环 (见 [goal](./goal))                                                                                          |
| /resume [id]           | local_ui | 无参数列出有消息的历史会话并打开选择器; 带 id 时加载会话文件、重建会话 (尊重压缩边界) 并在该 session id 下继续                                                                                                                                                                                                            |
| /quit                  | local_ui | 退出                                                                                                                                                                                                                                                                                                                      |
| /memory                | local    | UI 拦截后列出自动记忆 (`[type] name — description`); `/memory clear` 清空; `enable_memory: false` 时提示记忆已禁用 (见 [agents-md-and-memory](./agents-md-and-memory))                                                                                                                                                    |
| /skills                | local_ui | 列出 skill (`/name — description`); `/skills reload` 从磁盘热重载 catalog 并重接命令, 新 skill 通过下一轮的 skillDelta 下发 (见 [skills](./skills))                                                                                                                                                                       |
| /skill `<name>` [args] | -        | 不是注册的命令, 而是 `resolve` 的路由捷径: 等价于 `/<name> [args]`; `/skill reload` 路由到 `/skills reload`                                                                                                                                                                                                               |
| /worktree              | local_ui | 执行 `git worktree list` 并展示结果; 不在 git 仓库或 worktree 不可用时给出提示 (见 [worktree](./worktree))                                                                                                                                                                                                                |
| /review [PR]           | prompt   | 在内置 review agent 里审查 PR: handler 输出审查 prompt (`gh pr list` / `gh pr view` / `gh pr diff`), 只审查不改文件、不发 GitHub review; 无参数时先列出 open PR (见 [code-review](./code-review))                                                                                                                         |
| /rewind                | local_ui | 文件历史有快照时打开检查点回退对话框, 否则提示没有可回退的检查点 (见 [agents-md-and-memory](./agents-md-and-memory) 的文件历史)                                                                                                                                                                                           |
| /mcp                   | local    | UI 拦截后展示 MCP server 连接状态与工具总数, 先重试未连接的 server; `/mcp reload` 重读配置并重新连接 (见 [mcp](./mcp))                                                                                                                                                                                                    |
| /sandbox [mode]        | local_ui | 配置 OS 沙箱: `auto` (开启 + 自动放行)、`manual` (开启 + 手动确认)、`off`; 无参数时显示当前状态和用法 (见 [sandbox](./sandbox))                                                                                                                                                                                           |
| /feedback [text]       | local_ui | 打开附件勾选对话框 (session / tools / file-history / log / env), 然后 `runFeedbackPipeline` 用 general-purpose subagent 分析会话中的 harness 异常, 去重并经用户逐条确认后, 通过 gh CLI / GitHub token 到 hangtiancheng/yukino-code 仓库提 issue (无 CLI 时打开浏览器预填页面), 附件上传为 secret Gist, 失败则导出本地 ZIP |
| /thinking [level]      | local    | 无参数打开思考强度选择器 (UI) 或显示当前强度与用法; 带参数校验强度 (off / minimal / low / medium / high / xhigh / max, 受 provider 和 client 支持范围限制), 设置成功后 `persistThinkingLevel` 写入 `~/.yukino/config.yaml` 对应 provider 条目的 `thinking` 字段; 保存失败不回滚运行时设置                                 |

## prompt 命令

prompt 型命令由 CLI 构造 prompt 发送给 LLM API, 消耗 token。来源有四类:

- 内置命令: `/plan`、`/review`、`/goal`、`/ultracode`
- 命名 workflow 命令: `.yukino/workflows/` 下的脚本自动注册 (见下文)
- 用户自定义命令: `~/.yukino/prompts/` 下的 markdown 文件 (见下文)
- inline 模式的 skill: 加载后自动注册 (见 [skills](./skills))

带 `agent` 字段的 prompt 命令 (目前是 `/plan` 和 `/review`) 走 `runSubagentCommand` (src/commands/subagent.ts): 把原始输入和 subagent 结果分别以用户/助手消息写进会话与 session 文件, 通过 `Agent` 工具执行, 并对外发 tool_use / tool_result / stream_text / loop_complete 等事件。其中 plan agent 以 `fork: true` 继承父会话上下文, 其余以独立上下文运行; `/plan` 额外经过 `runPlanAgent`: 先进入 plan 权限模式, 成功后调用 `savePlan` 保存计划文件。`/goal` 虽然注册为 prompt 型, 但所有宿主都按名字拦截, handler 本身只是兜底 (见 [goal](./goal))

不带 `agent` 的 prompt 命令 (自定义命令、inline skill、`/ultracode`、命名 workflow) 把 handler 输出直接作为用户消息加入会话, 跑一轮完整的 agent loop。inline skill 的 handler 调用 `runInline`: 先通过 host 激活 skill, 再返回 skill prompt

## 用户自定义命令

用户级单目录 `~/.yukino/prompts/` (src/commands/loader.ts), 递归扫描 `*.md` 文件, 没有项目级来源:

- 命令名由相对路径生成, 子目录命名空间化: `sub/dir/foo.md` 注册为 `sub:dir:foo`; 每段路径小写、空格转 `-`
- 同名文件冲突时按源路径字典序排序, 最小的路径胜出, 其余记录警告日志; 与内置命令冲突时保留内置命令
- 自定义命令固定是 prompt 类型, handler 渲染文件正文并做参数替换

```md
---
description: 生成周报
argument-hint: [本周重点]
---

请根据本周的 git log 生成一份周报, 重点关注:
$ARGUMENTS
```

- frontmatter 只支持 `description` 和 `argument-hint` 两个键 (js-yaml 解析 + zod 校验), 解析失败时忽略 frontmatter、保留正文
- description 缺省为 `custom command`; 有 argument-hint 时为 `custom command (args: <hint>)`; 末尾统一追加 `[custom]` 标签, 补全菜单里渲染为独立 tag

### 参数替换

`parseCommandArgs` 做带引号的位置参数解析: 支持双引号和单引号, 单引号内不处理转义, 双引号内 `\\` 和 `\"` 可转义; `"a b" c` 解析为两个参数。`renderBody` 支持的占位符 (ARGUMENT_PLACEHOLDER_RE):

- `$1`、`$2`、...: 第 N 个位置参数; `$@`: 全部位置参数拼接
- `$ARGUMENTS`: 用户参数原文, 保留引号和间距
- `${1:-main}`、`${@:-fallback}`、`${ARGUMENTS:-fallback}`: 缺省值, 取值为空时用 fallback
- `${@:2:3}`: 位置参数切片 (从第 2 个起取 3 个, 省略长度取到末尾)
- 替换只做一遍, 参数值和 fallback 里的占位符文本保持字面, 不递归展开; 模板没有任何占位符且用户给了参数时, 参数追加到正文末尾

## 命名 workflow 命令

`WorkflowService.registerNamedCommands` (src/workflow/service.ts) 扫描项目下的 `.yukino/workflows/` 目录 (`WORKFLOW_DIR_NAME`), 把每个 `.ts` / `.js` / `.mjs` 脚本按文件名注册为 prompt 命令 (名字已被占用时跳过)。handler 输出 `buildNamedWorkflowPrompt`: 指示 agent 以 `name=<文件名>` 调用 Workflow 工具运行该脚本, 用户参数附在后面供 agent 转换为 JSON args。print 模式 (src/print-mode.ts) 也支持按名运行这些 workflow (见 [workflow](./workflow))

## skill 命令

`wireSkillsToRegistry` (src/bootstrap/tool-registry.ts) 把 catalog 里每个 skill 注册为命令, description 后缀 `[skill]`, 并标记 `isSkill: true` 以排除在 `/help` 清单之外 (见 [skills](./skills)):

- `mode` 为 `fork` 时注册为 skill_fork 型, handler 为空实现; 执行时 UI 构造 `SkillForkHost` (快照父会话消息 + 拉起 subagent), 调用 `runFork` 在隔离 subagent 中运行。`forkContext` 决定是否携带父上下文: `recent` 取最近 5 条消息、`full` 取最近 100 条、`none` (默认) 不带上下文
- 其余 (默认 inline) 注册为 prompt 型, handler 调用 `runInline`: 通过 host 激活 skill 后返回 skill prompt, 作为用户消息跑一轮 agent loop

skill 目录变动时, 每轮提交前 `refreshSkillsIfNeeded` 自动重载 catalog 并重接命令; `/skills reload` 手动触发同样的流程

## 输入补全与使用频率追踪

### 补全 (src/ui/input.tsx)

输入框第一行以 `/` 开头且为单行时显示命令补全:

- 查询为空: 按使用得分取最近使用的 5 个命令置顶 (RECENTLY USED 区), 其余命令跟在后面
- 查询非空: 三层匹配依次去重合并 —— 命令名全等、命令名前缀、模糊匹配 (Fuse.js, threshold 0.4, 名称权重高于描述)
- `/thinking ` 或 `/think ` 后跟部分级别时, 下拉列表改为展示匹配的思考强度级别
- 首选项以 ghost text 形式续写在光标后; Tab 或回车把选中项补全为 `/<name> `

### 使用频率追踪

命令使用记录随输入历史持久化在 `~/.yukino/activity.jsonl` (src/history/index.ts): 每次执行命令都会 `recordInput` 追加一条带 `commandName` 的记录, 重放状态时聚合为 `commandUsage[name] = { usageCount, lastUsedAt }`, 未知命令记 `null` 不计入

`CommandUsageTracker` (src/commands/usage-tracker.ts) 据此计算得分:

```text
得分 = usageCount × max(0.5 ^ (距上次使用的天数 / 7), 0.1)
```

半衰期 7 天 (`COMMAND_RECENCY_HALF_LIFE_DAYS`), recency 权重下限 0.1 (`COMMAND_MIN_RECENCY_WEIGHT`); `getRecentlyUsed(5)` 按得分取前 5 个命令名, 供输入补全置顶

## 前端差异

同一套解析与注册逻辑在不同宿主里的分派深度不同:

- 终端 TUI (src/ui/app.tsx): 完整四类型分派, 本文「分派流程」一节即其行为
- remote WebSocket / 浏览器 (src/remote/server.ts): 同一注册表加 `/provider` 镜像注册, `handleSlashCommand` 同样按类型分派, 并为 status / memory / mcp / thinking 提供浏览器侧的等价渲染; `/login` 和 `/provider` 在 agent 初始化之前直接广播 provider 列表 (见 [remote](./remote))
- print 模式 (src/print-mode.ts): 只解析 `/goal`、`/ultracode`、`/workflows` 和命名 workflow 命令, 其余 `/` 开头的输入原样作为 prompt 发给模型 (见 [print-mode](./print-mode))
- SDK / ACP 运行时 (`AgentHandleImpl.run`): 只拦截 `/goal` (本地处理后若有 prompt 再进入 agent loop), 其他 slash 输入原样进入对话 (见 [acp](./acp))
