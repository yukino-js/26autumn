---
title: "Permission"
---

LLM 生成的每一次工具调用都是一次真实世界的动作: 执行命令、改写文件、发起网络请求。权限系统回答一个问题 — 这次调用应该直接放行 (allow)、停下来问人 (ask), 还是直接拒绝 (deny)。它要同时抵御三类攻击面:

- prompt 注入: 被污染的文件内容诱导模型执行恶意命令
- 越权: 模型做出超出用户授权范围的动作 (写坏项目外的文件、强推分支)
- 数据泄露: 读工具把敏感内容带出边界 (如 `.env` 里的密钥)

单一检查点无法同时覆盖这三类问题, 所以判定被拆成多层: 显式规则、模式矩阵、安全命令白名单、路径沙箱、OS 沙箱、hook, 层层短路, 任何一层说 "不" 都优先于放行。

## 判定入口与工具分类

判定入口是 `PermissionChecker.check(toolName, category, args)` (src/permissions/index.ts), 返回一个 `Decision`:

```ts
export interface Decision {
  effect: "allow" | "deny" | "ask";
  reason: string;
  rememberPatterns?: string[];
}
```

- `ask` 触发 HITL (人在回路) 确认, 见下文 [人在回路](#人在回路)
- `reason` 是判定的可读解释, 会展示在确认对话框里, 也拼进 deny 时返回给 LLM 的工具结果
- `rememberPatterns` 是「始终允许」时可以持久化的规则 scope 列表

`category` 不是 checker 猜的, 而是每个工具注册时声明的 `ToolCategory` (src/tools/types.ts): `read` / `write` / `command` 三类。代表性归属: ReadFile / Glob / Grep / WebFetch / LSP / TaskOutput / AskUserQuestion 是 `read`; WriteFile / EditFile / InstallSkill / EnterWorktree 是 `write`; Bash / PowerShell / ComputerUse / McpCall / Workflow / Agent 是 `command`。分类决定了模式矩阵兜底时的默认行为, 也决定路径沙箱是否介入 (只对 `write` 介入)。

`check` 内部包了一层 fail-closed: 私有方法 `checkAction` 抛出任何异常 (典型是路径解析失败), `check` 捕获后返回 `deny`, reason 为 `Permission path resolution failed: ...` — 判定链路出错时宁可拒绝也不放行。

## 判定流程: 逐层短路

`checkAction` 按以下顺序逐层判定, 前面的层命中即短路返回 (源码注释里的 Layer 编号保留在代码中):

1. **plan 模式守卫 (deny)**: `mode === "plan"` 且 `category` 不是 `read` 时, 除四类例外一律返回 `deny` (reason: `Plan mode forbids mutations`)。四类例外: teammate 协调工具、plan 协调工具、写 plan 文件、安全只读命令。这个守卫位于显式规则之前, 意味着 plan 模式下即使有显式 allow 规则也打不开写操作
2. **显式规则 (deny / ask 短路)**: 规则文件 (见 [权限规则](#权限规则)) 命中的 `deny` 或 `ask` 立即返回; 显式 `allow` 故意不在这里短路, 只记录 effect 放到后面的层, 让路径沙箱等机制可以先介入
3. **plan 协调工具放行**: plan 模式下, `PLAN_COORDINATION_TOOLS` 集合中的工具直接 allow (reason: `Plan coordination tool`)。集合成员: AskUserQuestion、EnterPlanMode、ExitPlanMode、Agent、Goal、TodoWrite、TaskStop、TeamCreate、TeamDelete, 外加 teammate 协调工具。这保证 plan 模式下的模型仍能提问、委派只读调研、退出 plan 模式
4. **teammate 协调工具放行**: checker 标记 `teammate = true` 时, `TEAMMATE_COORDINATION_TOOLS` (SendMessage、TodoWrite) 直接 allow — teammate 无人值守, 没有审批通道, 不能让团队内部的消息和共享任务板落入 ask
5. **plan 文件写例外**: plan 模式下 WriteFile / EditFile 的目标正是当前 plan 文件 (`checker.planFilePath`, 规范化后的绝对路径相等) 时直接 allow — 这是 plan 模式下唯一的写例外, 让模型可以起草和修订计划
6. **安全只读命令放行**: `command` 类工具命中 `isSafeCommand` 时直接 allow (reason: `Safe read-only command`), 见 [安全只读命令白名单](#安全只读命令白名单)
7. **危险命令拦截 (预留)**: `detectDangerous` 遍历 `DANGEROUS_PATTERNS`, 命中返回 deny。当前该数组**有意为空**, 这一层保持惰性直到填入具体模式
8. **空命令拦截**: Bash / PowerShell 的命令体为空 → ask (reason: `Approval requires a non-empty Bash command or PowerShell command`)
9. **复杂 shell 语法审批**: `analyzeShell` 判定命令 "不完整" (含变量展开、命令替换、重定向、控制结构等无法按字面分解的语法) 且非 bypassPermissions 模式 → ask (reason: `Complex shell syntax requires approval`), 见 [shell 结构分析](#shell-结构分析)
10. **沙箱自动放行**: OS 沙箱开启 (`sandboxEnabled`) 且 `auto_allow: true` 且工具是 Bash → allow (reason: `Sandbox auto-allow: OS sandbox active`)。只有 Bash 会被 OS 沙箱包裹, PowerShell 等其他 command 工具不享受这一层
11. **路径沙箱 (仅 write 类)**: write 类工具的路径越出允许的根目录 → ask; bypassPermissions 跳过; 显式 allow 规则可覆盖。见 [路径沙箱](#路径沙箱-仅-write)
12. **规则再评估**: 第 2 层记录的显式 allow 在这里生效返回
13. **权限模式矩阵兜底**: `modeDecide(mode, category)` 给出最终决策 (reason: `Mode: <mode>`), 见 [权限模式](#权限模式)

在 agent loop 一侧 (src/agent/index.ts 的 `executeBatch`), 权限判定之前还有两道闸门:

- **pre_tool_use hook**: 先于权限判定触发, hook 返回 reject 时直接产出 `Rejected by hook: <reason>` 的错误结果, 不再走权限 (见 [hook](./hook))
- **McpCall 双重判定**: McpCall 会被判两次 — 外层的 McpCall 本体和解析出的目标 MCP 工具各检查一遍。特例: 外层命中显式 allow 规则、而内层只是被模式矩阵判成 ask 时, 内层继承外层的 allow (否则 `McpCall(server__*)` 这类规则会被内层的 ask 架空)。合并决策按 `deny > ask > 第一个` 取最严

## 权限模式

`PermissionMode` 有四个值: `default` / `acceptEdits` / `plan` / `bypassPermissions`。兜底矩阵由 `modeDecide` 给出:

| 模式              | 只读工具 (read) | 写工具 (write) | 命令工具 (command) |
| ----------------- | --------------- | -------------- | ------------------ |
| default           | Allow           | Ask            | Ask                |
| acceptEdits       | Allow           | Allow          | Ask                |
| plan              | Allow           | Deny           | Deny               |
| bypassPermissions | Allow           | Allow          | Allow              |

- plan 模式下 write / command 的 Deny 来自判定流程第 1 层的守卫, 早于矩阵本身; 同时 agent loop 每轮注入 plan 模式 system-reminder (`buildPlanModeReminder`, "# Plan mode / Do not run mutating tools, change configs, or commit."), 从提示词侧约束模型只读。plan 模式和 default 模式的差别不在 ask 的多少, 而是 plan 直接 deny 变更
- bypassPermissions 在权限层放行一切; 对危险命令的防护来自权限规则 (deny)、pre_tool_use hook 的 reject 和 OS 沙箱, 而不是模式本身。源码中 `DANGEROUS_PATTERNS` 是有意为空的数组, 没有 `rm -rf` 之类的硬编码拦截

### 模式的切换与继承

- **Shift+Tab 循环**: 终端 UI 监听 Shift+Tab, 按 `PERMISSION_MODE_CYCLE` = default → acceptEdits → bypassPermissions 循环切换 (src/ui/constants.ts); plan 不在循环里, UI 上 bypassPermissions 显示为 "YOLO"
- **进入 plan**: `/plan` 斜杠命令或 EnterPlanMode 工具 (仅主 agent 可用) 都会走 `runPlanAgent`: 先 `checker.enterPlanMode()` (记录进入前的模式), 再运行内置 plan subagent。plan agent 声明 `permissionMode: "plan"` + `readOnly: true`, 且禁用 EditFile / WriteFile / ExitPlanMode, 它产出的计划文本由运行时 `savePlan` 写入 plan 文件 (src/subagent/plan.ts)
- **退出 plan**: ExitPlanMode 工具成功后弹出 plan 审批对话框, 三选一: 批准并进 YOLO (exitPlanMode → `bypassPermissions`)、批准但每步编辑仍需确认 (→ `default`)、或给出修订反馈继续留在 plan 模式
- **初始值**: 来自 config.yaml 的 `permission_mode` 键; 终端 UI 只接受 default / acceptEdits / bypassPermissions 三个合法值, 否则回落 default (plan 只能经由 /plan 进入, 不能作为初始值)
- **只读角色**: 内置 plan / explore subagent 声明 `readOnly: true`, `mode` getter 对 readOnly 的 checker 永远返回 `"plan"` — 这类角色是永久只读的
- **subagent 继承**: `forSubagent` 派生子 checker 后, 有效模式按 `mode` getter 合并: 父或子任一是 bypassPermissions → bypassPermissions; 父是 acceptEdits → acceptEdits; teammate 且要求 leader 审批计划、自身值为 plan → plan; 其余情况用子自己的值, 缺省 default。继承只会放宽不会收紧

## 安全只读命令白名单

命令分类只针对 `command` 类工具; 判定函数是 `isSafeCommand(command)`:

```ts
export function isSafeCommand(command: string): boolean {
  const trimmed = command.trim();
  // 拒绝包含 shell 元字符的命令: cat 等安全前缀不能成为管道/链式/重定向的入口
  if (/[\r\n&|;<>`(){}[\]]/.test(trimmed)) {
    return false;
  }
  return SAFE_PREFIXES.some((prefix) => {
    // 字符串前缀: 全等或后跟空格/Tab; 正则: 每次匹配前重置 lastIndex
    ...
  });
}
```

两个要点:

- **元字符拒绝集**: CR、LF、`&`、`|`、`;`、`<`、`>`、反引号、`(`、`)`、`{`、`}`、`[`、`]`, 命中任意一个即判不安全 — 防止 `cat a | rm -rf b` 这类把安全前缀当作管道/链式/重定向/命令替换入口的绕过
- **白名单内容** (`SAFE_PREFIXES`, src/permissions/constants.ts): 约 50 个字符串前缀加一条正则。字符串前缀是无危险参数的只读工具 — 查看类 (cat、head、tail、wc、stat、strings、hexdump、od、nl、diff、cmp、comm)、文本处理类 (cut、paste、tr、column、tac、rev、fold、expand、unexpand、fmt、numfmt、seq、tsort、pr)、系统信息类 (id、uname、free、df、du、locale、groups、nproc、cal、uptime)、路径类 (basename、dirname、realpath、readlink、which、type)、其他 (echo、printf、grep、expr、test、getconf、true、false、sleep); 唯一的正则覆盖 `docker ps` / `docker images` 这两个只读子命令

注意白名单刻意收得很窄: `git`、`npm`、`kubectl` 等都不在列 (会落入模式矩阵的 ask 或被显式规则覆盖), `find` 则被列入下文的 `COMPLEX_COMMANDS`, 永远要求审批。命中白名单的命令直接 allow, 不需要确认; Bash 工具的并发安全判定复用同一个函数 — `isConcurrencySafe(args)` 即 `isSafeCommand(command)`, 只有白名单命令才允许和其他工具并发执行。

## shell 结构分析

`analyzeShell(command, powershell?)` (src/permissions/shell.ts) 是权限层自研的轻量 shell 词法分析器, 把一行命令拆成字面简单命令列表 (`ShellAnalysis = { commands, complete }`)。它识别单/双引号 (PowerShell 用双写引号转义)、反斜杠转义 (PowerShell 是反引号)、注释和 `;` / `|` / `&&` / `||` 分隔, 遇到下列任一情况就标记 `complete = false`:

- 词中出现 `$`、反引号、`(`、`)`、`{`、`}`、`<`、`>`、NUL (变量展开、命令替换、子 shell、重定向)
- 引号未闭合, 或行尾是悬空的转义符
- 以 `|` / `&` 开头的管道/后台语法
- 第一个词为空、含空白 / 通配符 (`*` `?`) / 方括号 / 波浪线, 是变量赋值 (`KEY=value` 或 `KEY+=value` 形式), 或可执行文件名 (小写、去 `.exe`、取 basename) 命中 `COMPLEX_COMMANDS`

`COMPLEX_COMMANDS` 是一份控制流与提权可执行名单: if/then/else/elif/fi、for/while/until/do/done、case/esac、function、select、coproc、`!`、time、eval、exec、source、`.`、command、builtin、env、sudo、bash/sh/zsh/dash/ksh/fish、pwsh/powershell、xargs、find。

`complete = false` 的命令在两个地方起作用:

1. 判定流程第 9 层: 非 bypassPermissions 模式下一律 ask, 理由 `Complex shell syntax requires approval` — 展开和重定向的真实效果无法靠字面前缀授权, 必须人工看一眼
2. 显式规则匹配: Bash / PowerShell 的规则按拆出的子命令逐条评估, 见下节

## 路径沙箱 (仅 write)

`PathSandbox` 只管 write 类工具的路径参数; 读工具不再经过这一层 (`canReadSearchPath` 恒返回 true, 读路径由 deny 规则按需拦截), bypassPermissions 模式也跳过。

- **允许的根目录**默认两个: 项目根目录 (构造时传入的工作目录) 和系统临时目录 (`os.tmpdir()`, macOS 上是 `/var/folders/...` 而不是 `/tmp`, Linux 是 `/tmp`)
- **运行时追加**: `allowExtraRoot(path)` 追加可写根 — 典型场景是注册 worktree 时把 worktree 目录加进来 (见 [worktree](./worktree)), 主 agent 和委派 agent 共用同一份 extraRoots, 口径统一
- **检查流程**: `resolveToolPath` 展开 `~` 并相对项目目录 resolve → `canonicalPath` 解析符号链接 (尾部文件甚至父目录不存在时逐级向上回退再拼接, 最大深度受 `MAX_SYMLINK_DEPTH` 限制) → `isPathWithin` 用 `path.relative` 判断是否落在某个根内
- **越界处理**: `PathSandbox.check` 返回 `Path <filePath> is outside allowed directories`, 判定流程把它包装成 **ask** 而不是 deny — 用户可能确实需要写外部路径, deny 太激进。ask 之前会重查一次显式规则, 显式 allow 可以覆盖沙箱决策
- **worktree 隔离**: 经 `forWorktree` 派生的隔离 agent 会把沙箱根切换为 worktree 目录本身 (`isolatedRoot`), 且不再包含系统临时目录

## 权限规则

权限规则回答这类需求:

- 允许执行 `git push`, 但不允许执行 `git push --force`
- 允许读取 src/ 目录下的文件, 但不允许读取 `.env` 文件
- 允许运行 `pnpm lint`, 但不允许运行 `pnpm lint:fix`

两个规则文件, 加载后统一裁决:

- 用户级: `~/.yukino/permissions.yaml`
- 项目级: `~/.yukino/projects/<projectKey>/permissions.yaml` (projectKey 是项目规范路径的 sha256, 见 [agents-md-and-memory](./agents-md-and-memory) 的存储布局)

格式是顶层 YAML 列表, 每项两个字段:

```yaml
- rule: Bash(git *)
  effect: allow

- rule: Bash(git push --force*)
  effect: deny

- rule: ReadFile(*.env*)
  effect: deny
```

- `rule` 的语法由正则 `^(\w+|\*)\(([\s\S]+)\)$` 约束: `Tool(pattern)`, Tool 是工具名或 `*` (匹配所有工具), pattern 是 glob
- `effect` 枚举: allow / deny / ask
- glob 语义刻意与文件路径匹配不同 (更适合匹配命令行): `*` 匹配任意长度的任意字符 (**包括 `/`**), `?` 匹配单个字符, 反斜杠转义下一字符。PowerShell 的规则匹配大小写不敏感; Windows 上文件类工具和 Glob 也不敏感
- 裁决优先级: deny > ask > allow。`evaluateRules` 遍历所有命中规则, 命中 deny 立即返回, ask 会覆盖已记录的 allow, 与文件加载顺序和行顺序无关

### 匹配目标的提取

规则匹配的内容由 `extractContent` 按工具决定 (`CONTENT_FIELDS`, src/permissions/constants.ts): Bash / PowerShell 取 `command`, ReadFile / WriteFile / EditFile / LSP 取 `file_path`, Glob / Grep 取 `pattern`, WebFetch 取 `url`, ComputerUse 取 `action` (OpenAI 的批量 `actions[]` 形式则汇总各项 type), InstallSkill 取 `source`, TaskOutput 取 `task_id`。McpCall 特殊: 匹配目标不是参数而是 `server__tool` 形式 (`mcpCallPermissionContent`), 所以 `McpCall(linear__*)` 可以按服务器或按工具整批放行/拦截。

文件类工具和 Glob 在匹配前会把路径参数和 pattern 都规范化: 相对路径按当前工作目录 resolve 成规范化的绝对路径 (`normalizePathPattern`), 所以 `EditFile(src/*)` 能匹配 `src/foo.ts` 而不管调用方写的是相对还是绝对路径; wildcard 之后不允许再出现 `..` (目录穿越), 违反即报错并 fail-closed 为 deny。

### Bash / PowerShell: 按子命令逐条裁决

复合命令不会被当作一个整体字串去碰运气。`checkExplicitRules` 先用 `analyzeShell` 把命令拆成子命令, 然后:

- 整行命令和每个子命令的字面内容各评估一次规则; deny / ask 规则还额外评估一个归一化形式 — 可执行名取 basename (`/usr/bin/cat foo` → `cat foo`)。归一化只对 deny / ask 生效, allow 不参与: 绝对路径可以命中拦截规则却不能换取放行, 防止用路径绕过限制
- 任一处命中 deny → deny; 任一处命中 ask → ask
- allow 要求**每个**子命令都被显式 allow 才成立; 有一个子命令没命中 allow, 规则层就不输出 allow, 落回后续层
- 命令复杂到拆不完整 (`complete = false`) 时: 存在 deny 规则 → deny, 否则存在任何 deny/ask 规则 → ask, 一条限制性规则都没有则规则层不表态。这保证 deny 规则对复杂命令依然有威慑力, 同时复杂命令不会因为一条 `Bash(git *)` allow 就被整体放行

### 加载与缓存

- 每个规则文件按 `mtimeNs + size` 缓存解析结果 (stat 的 bigint 精度), 文件未变直接复用, 变了下次判定自动生效; 同一次判定内的多次评估 (如复合命令) 共享同一份快照
- 单条格式非法 (effect 不在枚举内、rule 不匹配 `RULE_RE`) 的条目被跳过, 不中断加载; 但整个文件的 YAML 解析失败会抛 `Cannot parse permission rules`, 被 `checkExplicitRules` 捕获后按 deny 处理 — 规则文件写坏了的结果是更严格, 不是更宽松

## 「始终允许」

HITL 确认对话框的第二项是 "Yes, remember the scopes above for all agents in this project" (仅在存在可记忆的 scope 时显示)。用户选择后, agent loop 调用 `checker.allowAlways`, 把 scope 作为 allow 规则追加到**项目级**规则文件:

`rememberPatterns(toolName, args)` 决定 scope 的形态:

- 文件类工具 (ReadFile / WriteFile / EditFile / LSP): 目标所在目录 (目标本身是目录时就是该目录) + `/*`, 如 `WriteFile(/abs/project/src/*)`
- Bash / PowerShell: 每个子命令的前两个词 + `*` (如 `Bash(git push*)`), 去重; 命令拆不完整、或前两个词含空白/通配符/反斜杠时不生成 pattern
- McpCall (server 和 tool 都非空时)、WebFetch、InstallSkill、TaskOutput: 精确内容, 如 `WebFetch(https://example.com)`
- 其他工具: 不生成 pattern; 此时即使收到 allowAlways 也会降级为一次性 allow (`requestToolPermission` 的兜底)

持久化由 `RuleEngine.appendProjectRule` 完成: 按 `{tool, pattern, effect}` 三元组去重, 整个过程持有 `withFileSyncLock` 文件锁, 新内容经 `yaml.dump` 写入临时文件后 rename 原子替换原文件, 并失效缓存。

## 人在回路

判定结果是 ask 时, `executeBatch` 阻塞在 `requestToolPermission` (src/permissions/request.ts) 上, 通过 agent 配置注入的 `onPermissionRequest` 回调发起审批 — 回调签名返回 `Promise<"allow" | "deny" | "allowAlways">`。回调与 abort signal 竞速: 用户中断 (Ctrl+C 等) 立即得到 deny。

审批界面的呈现因宿主而异, 但决策语义完全一致:

- **终端 UI**: `createPermissionRequestHandler` 把请求渲染成 PermissionDialog, 标题 `<agentName>: <toolName> requires approval`, 正文一行展示 cwd · 参数摘要 (`formatToolArgs`: command 全文, file_path / pattern / description 截断到 80 字符) · decision.reason, 并为每个 rememberPattern 打印一行 `Remember scope: <pattern>`。选项 Yes / Yes, remember... / No, Esc 等同 deny; 并发的权限请求排队, 逐个弹出 (见 [terminal-ui](./terminal-ui))
- **remote**: 服务端广播 `permission_request` WebSocket 消息, 浏览器端弹出审批卡片; 断线重连的客户端会收到 in-flight 请求的重放 (见 [remote](./remote))
- **ACP**: 向编辑器客户端发起 `session/requestPermission` 请求 (见 [acp](./acp))
- **A2A**: 任务状态转入 `TASK_STATE_INPUT_REQUIRED`, 等待调用方 agent 回传决策 (见 [a2a](./a2a))

三种决策的落地方式:

- **allow**: 本次执行, 不记规则
- **allowAlways**: 先把 `rememberPatterns` 持久化到项目级规则文件 (用的是发起请求时生成的快照, 避免审批期间路径别名变化导致 scope 漂移), 然后执行
- **deny**: 工具不执行, 向 LLM 返回 `isError: true` 的工具结果 `REJECTED_TOOL_RESULT` ("The user rejected this tool use. Nothing was changed (for file edits, the new content was NOT written)."); agent loop 继续运行, LLM 下一轮看到拒绝信息自行调整策略

另外两种 ask 的变体: ask 但 agent 没有配置审批 handler (无人值守场景) 时, 返回 "Permission required, but this agent has no approval handler. The tool was not executed."; 而规则/守卫层面的 deny (不经过人) 返回 `buildPermissionDeniedOutput(reason)` — "Permission denied: ... 告知用户命令被拒绝, 且不要描述这条命令会做什么", 防止模型借错误消息复述危险命令的内容。

## OS 级沙箱

权限系统之外, Yukino 还支持 OS 级沙箱, 把 Bash 命令放进操作系统提供的隔离环境执行 (macOS seatbelt / Linux bubblewrap), 文件系统写入被收敛到允许目录, 网络可以整体关闭。config.yaml 的 `sandbox` 段有三个键: `enabled`、`auto_allow`、`network_enabled`; 运行时也可以用 `/sandbox auto | manual | off` 切换。沙箱开启后, 判定流程第 10 层让非危险的 Bash 命令免人工确认 — 且只有当沙箱真正就绪 (seatbelt/bwrap 可用) 时 `sandboxEnabled` / `sandboxAutoAllow` 才会置位。权限层回答「要不要人确认」, 沙箱回答「命令允许碰什么」, 两者独立又协同; 沙箱内部的文件读写限制见 [sandbox](./sandbox)。
