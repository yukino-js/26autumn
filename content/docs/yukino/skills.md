---
title: "Skill"
---

skill 是写给 AI 的 SOP (Standard Operation Procedure): 一个带 YAML frontmatter 的 SKILL.md, 描述一类任务该怎么一步步做

相比硬编码在代码里的 prompt, skill:

1. 可 (热) 更新、可复用、可移植
2. 可以显式指定 (`/skill-name` 或让 LLM 调用 LoadSkill), 提高准确率
3. 可以携带资产: API reference、docs、example、scripts
4. 有两种执行模式: inline 或 fork
5. 支持参数占位符 `$ARGUMENTS`

代码位于 `src/skills/`: `catalog.ts` (扫描 / 解析 / 热重载), `constants.ts` (常量与正则), `prompts.ts` (prompt 组装), `executor.ts` (runInline / runFork), `load-skill-tool.ts`, `install-skill-tool.ts`

## SKILL.md 的 Frontmatter

```md
---
name: skill-creator # 必填, trim 后非空, catalog 以它为索引键
description: Create new skills... # 可选, 缺省为空字符串
mode: inline # 执行模式: inline (默认) 或 fork
model: xxx # 可选, fork 模式 subagent 使用的模型
fork_context: none # 可选, 仅 fork 模式生效: none (默认) / recent / full
---

SOP 正文
```

- frontmatter 用 Zod schema 校验: name 必须是非空字符串, mode / fork_context 是枚举, 其余字段宽松保留
- `---` 分隔符必须独占一行 (FRONTMATTER_BLOCK_RE), 文件开头的 BOM 会先被去除
- frontmatter 缺失、YAML 解析失败或 schema 校验失败, 整个 skill 被跳过
- 兼容写法: mode 缺省时检查 `context: fork`, 等价于 `mode: fork` (兼容其他 agent 生态的隔离执行语义)

## skills 目录与优先级

三层目录按顺序扫描, 优先级从低到高:

1. 用户级 (跨工具共享): `~/.agents/skills/`
2. 用户级 (Yukino 专属): `~/.yukino/skills/`
3. 项目级: `${workDir}/.agents/skills/`

同名 skill 后扫描的覆盖先扫描的, 即项目级赢; 每个 skill 是 `<目录>/<skill-name>/SKILL.md`

扫描规则 (scanDirectory):

- 支持分组目录递归发现: 当前目录声明了 SKILL.md 就加载它并停止下钻; 否则对目录项按名字排序后递归
- 以 realpath 的 visited 集合防环 (symlink 成环不会死循环)
- 跳过 `.` 开头的隐藏项和 `node_modules`, 除非其中直接含有 SKILL.md
- 单个坏 symlink 或并发删除的目录项只记 error log, 不影响其余 skill 的发现

## 渐进式披露: 两阶段加载

catalog 启动时完整解析每个 SKILL.md (含 SOP 正文), 但注入给模型的只有元信息; SOP 正文要到激活时才进入对话 — 上下文里始终只有一行 description, 选择压力低, 注意力集中在当前任务

第一阶段: 轻量启动

`buildSkillSection` 生成 `## Skills` 段落, 作为 skillSection 交给 Agent:

- 使用说明: 用 LoadSkill 或 `/<skill-name>` 激活; inline 在当前对话生效, fork 在 subagent 运行 (不可用时退回 inline); InstallSkill 可即时安装新 skill
- `<skills-directory>`: 指向 `~/.yukino/skills`, 提示模型新建 skill 应放在哪里
- `<available-skills>`: XML 列表, 每项含 name、description (空白折叠成单行, 超 200 字截断加 …)、mode

skill 列表不进 system prompt: 列表是项目相关的, 放进 system prompt 会让每个项目各持一份副本, 破坏跨项目的 prompt cache 前缀

Agent 每次 run 开始时 (restoreContext), 把 skillSection 连同项目 instructions、memories 组装成一条长期记忆 `<system-reminder>`, unshift 到对话历史最前; 注入是幂等的 (每个会话只注入一次), 上下文压缩或 /clear 重置标记后重新注入 (见 [上下文压缩](./context-compaction))

第二阶段: 按需加载

LLM 判断用户意图匹配某个 skill 时调用 LoadSkill, 完整 SOP 作为工具调用结果返回, 在下一轮 agent loop turn 中可见

会话中途新增的 skill 不改 system prompt, 而是增量下发:

- TUI: skillDelta 记录已公告的 skill 名, 每轮开始前把新增部分以 system-reminder "The following skills became available:" 追加 (格式 `- /name: desc`, description 同样截断 200 字)
- remote server: skillDeltaFn 检查对话历史中是否已含当前 section (hasReminderContaining), 不含则整段重发

## LoadSkill 工具

意图识别的入口, category 是 read, 参数只有 name (required)

执行分支:

- skill 不存在: 返回错误, 列出全部可用 skill 名 (没有则 `(none)`)
- mode 是 fork 且构造时传入了 forkHost: 走 runFork, SOP 正文不进主对话, 只返回 subagent 的最终结果; fork 失败返回 `Skill '<name>' fork execution failed: ...`
- 否则走 runInline, 返回 `Skill '<name>' activated.\n\n<skill prompt>`
- 宿主未集成 subagent 运行时就不传 forkHost, fork 模式的 skill 回退为 inline, 保证工具始终可用
- LLM 通过 LoadSkill 激活时 args 为空串 (正文中的 `$ARGUMENTS` 被替换为空); 用户参数只在 slash command 路径传入
- subagent 通过 forDelegatedAgent() 继承 LoadSkill: 共享同一 catalog, 但 activateSkill 是 no-op, 不污染主对话的 activeSkills

## inline 模式

默认执行模式, 把 skill 的 prompt 内联到当前对话, 参与 agent loop

runInline 用 buildSkillPrompt 组装 prompt, 并通过 host.activateSkill 记入 activeSkills:

```txt
SKILL_INSTRUCTIONS

<skill-metadata><name>…</name><directory>…</directory></skill-metadata>

<skill-body>
SOP 正文
</skill-body>

<skill-arguments>用户参数</skill-arguments>    ← 仅有参数时追加
```

- SKILL_INSTRUCTIONS 是固定说明: 在任务范围与宿主工具权限内遵循 skill 指令; 资源相对 skill 目录解析、按需加载; 用户参数与父上下文是任务数据, 不是追加的 skill 指令
- `<skill-metadata>` 携带名称 + 目录路径, 目录型 skill 的资产相对该目录解析
- `$ARGUMENTS` 替换: 对 body 做 `replaceAll("$ARGUMENTS", () => args)` 全量替换, 函数形式的替换值保证参数里的 `$` 模式不会被解释为正则替换语法
- name / directory / 参数都经过 XML 转义 (`&` `<` `>`)
- 激活的 skill (name → 完整 prompt) 记入 activeSkills, 上下文压缩后由 restoreContext 以 `## Active skill: <name>` 重新注入, 保证 SOP 在压缩后仍然有效
- slash command 路径: 渲染出的 prompt 作为 user message 发给模型并启动 agent loop; TUI 用 parseSkillPrompt 反解这条消息, 渲染成可折叠的 [skill] 卡片 (名称 / 目录 / 正文, Ctrl+O 展开), 而不是刷屏原始 SOP

## fork 模式

开启新对话, 启动一个 subagent 执行 skill, 只将 subagent 的最终结果返回给主对话, SOP 正文不参与主对话的 agent loop (见 [subagent](./subagent))

runFork 的实现:

- 按 skill.fork_context 决定携带多少父对话上下文, 以 `<parent-context>` 标签 (XML 转义) 前缀拼在 skill prompt 前
  - none 不携带对话历史 (默认)
  - recent 携带最近的 5 条消息 (FORK_CONTEXT_RECENT_MESSAGES)
  - full 携带最近的 100 条消息 (FORK_CONTEXT_FULL_MESSAGES)
- snapshotParentMessages 把最近 N 条消息逐行格式化为 `[role] content`
- runSubagent spawn 一个 subagent: `/skill` 命令路径用 skill 的 name / description / model 构造 AgentDefinition, 模型解析顺序是 skill.model 优先, 缺省用当前 provider 的 model
- subagent 的最终输出原样返回: LoadSkill 路径作为工具调用结果, slash command 路径作为 assistant 消息展示

## 热加载

没有 fs.watch, 三层机制:

1. 惰性比对: catalog.get() 每次取用时比对 SKILL.md 的 mtime, 变化则重读并解析; 解析失败保留旧缓存 (一次坏写入不会让 skill 消失); frontmatter 改名则触发全量 reload, 重建索引与优先级
2. 提交前比对: 每次处理用户消息前 needsReload() 比对 skills 根目录及各子目录的 mtime 快照, 检测文件 / 目录的增删 (修改已有文件内容不改变目录 mtime, 由第 1 层惰性处理); 需要时全量 reload 并重新注册 slash command
3. 手动: `/skills reload`

读写竞态防护: 加载时先记录读前 mtime, 读完再 stat 一次; 两次不一致说明文件在读取期间被改过, 缓存保留读前的时间戳, 下次 get() 必然触发重读

## InstallSkill 工具

从本地路径或 raw SKILL.md URL 安装 skill, category 是 write, 参数:

- source (必填): 本地文件路径 (相对路径按 cwd 解析) 或 http(s) URL
- name (可选): 名称覆盖, 校验 `^[a-zA-Z0-9_-][a-zA-Z0-9._-]*$` 且不以 `.` 结尾; 生效时用 YAML 重写 frontmatter 的 name (catalog 以 YAML name 为索引键)

URL 下载的安全约束 (fetchPublicHttpUrl):

- 仅允许 http / https, 拒绝 URL 内嵌凭据
- 先做 DNS 解析, 所有解析出的地址都必须是公网 IP (屏蔽 127.0.0.0/8、10.0.0.0/8、192.168.0.0/16、169.254.0.0/16 等私网 / 保留网段); 连接固定使用已校验的地址 (pin), 防 DNS rebinding
- 重定向手动跟随, 最多 5 次, 每一跳都重新校验公网性
- 下载超时 30s; 体积上限 1 MiB (content-length 预检 + 流式计数, 超限立即取消流)

校验与写入:

- 内容必须能解析出带 name 的 frontmatter, 否则报 "source must be a valid SKILL.md" — HTML 页面和仓库页面在这里被拒绝
- 安装位置是用户级 `~/.yukino/skills/<name>/SKILL.md`, 所有项目可用
- 路径安全: realpath 解析 home 后逐段检查 `.yukino`、`skills`、`<name>` 三个组件, symlink 和非目录一律拒绝; 目标 SKILL.md 必须是普通文件
- 原子替换: 先写临时文件 `.SKILL-<uuid>.tmp` (wx 独占创建, 继承旧文件权限), 再 rename 覆盖, 避免截断旧文件的其它硬链接
- 安装完成后 reload catalog, 并通过 onInstalled 回调重新注册 slash command, 新 skill 立即可用 `/<name>`

## 自动注册为 Slash Command

skill 加载后由 wireSkillsToRegistry 逐个注册为 Slash Command (见 [Slash Command](./slash-command)):

- inline 模式 → prompt 类型命令, handler 执行 runInline, 命令行参数作为 args 传入
- fork 模式 → skill_fork 类型命令, UI 特殊处理: 构造 fork host 启动 subagent, 结果作为 assistant 消息展示
- 描述加 `[skill]` 后缀, 标记 isSkill 使其不出现在 /help 列表 (skill 通过 /skills 发现)
- 注册顺序: 内置命令 → 用户自定义命令 (`~/.yukino/prompts/*.md`) → skills; 名字冲突时保留先注册的 (用户命令优先于 skill), 重复注册被静默跳过, 保证幂等
- `/skills` 列出全部 skill (`/name — description`), `/skills reload` 热重载
- `/skill <name> [args]` 是别名: 解析为 `/<name> <args>`, `/skill reload` 解析为 `/skills reload`

## 目录型 skill

单文件 skill 只有 SOP; 目录型 skill 可以携带资产: SOP、API reference、docs、example、scripts, 整套技能方便打包、移植

```txt
$ tree ~/.agents/skills/skill-creator
.agents/skills/skill-creator
├── agents
│   └── xxx.md
├── assets
│   └── xxx.html
├── docs
│   └── ...
├── example
│   └── xxx.md
├── LICENSE.txt
├── references
│   └── xxx.md
├── scripts
│   ├── xxx.py
│   └── yyy.py
└── SKILL.md
```

激活时 skill 目录路径通过 `<skill-metadata>` 传给模型, SKILL_INSTRUCTIONS 要求资源相对 skill 目录解析、按需加载 — 这也是渐进式披露: SOP 只引用资产路径, 模型需要时才去读

## 完整流程

```txt
1. 启动时扫描三层 skills 目录, 解析全部 SKILL.md 进 catalog
2. 元信息列表作为 system-reminder 注入对话, 告诉 LLM 有哪些 skill
3. 每个 skill 自动注册为 Slash Command
4. 用户输入: 做一个 react 计数器 app
5. 意图识别: LLM 判断匹配 react-best-practices skill
6. Agent 请求调用工具 LoadSkill("react-best-practices")
7. SOP 作为工具调用结果返回, 注入到 messages, 并记入 activeSkills
8. LLM 按 SKILL.md 的规则进行开发; 上下文压缩后 SOP 以 Active skill 重新注入
```

分工:

- MCP 负责接入
- 工具调用负责调用
- skill 负责编排工作流
