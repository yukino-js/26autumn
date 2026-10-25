---
title: "Skill"
---

skill 是写给 AI 的 SOP (Standard Operation Procedure)

背景: slash-commands 中, prompt 类型的命令可以将硬编码的代码审查 prompt 发送给 LLM, 不独立、不可更新、不可移植

1. skill 可 (热) 更新、可复用、可移植
2. 可以显式指定 skill, 提高 LLM 的准确率
3. skill 可以携带资产:
   - SKILL.md: SOP
   - API reference、docs、example、scripts
4. 执行模式: inline 或 fork
5. 参数 $ARGUMENTS

## Frontmatter

```md
---
name: skill-creator
description: Create new skills...
mode: inline # skill 执行模式, inline (默认) 或 fork
model: 可选的, 指定 fork 模式 subagent 使用的模型
fork_context: 可选的, 仅 fork 模式生效: none (默认) / recent / full
---
```

- frontmatter 解析失败或没有 `---` 包裹的 SKILL.md, 整个 skill 被跳过
- 兼容写法: `context: fork` 等价于 `mode: fork`

## skills 目录, 优先级从低到高

1. 用户级 (跨工具共享): ~/.agents/skills/
2. 用户级 (Yukino 专属): ~/.yukino/skills/
3. 项目级: ${workDir}/.agents/skills/

三层目录按顺序扫描, 同名 skill 后扫描的覆盖先扫描的, 即项目级赢; 每个 skill 是 `<目录>/<skill-name>/SKILL.md`; 扫描支持分组目录递归发现 (带 visited 集合防环), 遇到声明了 SKILL.md 的目录就停止下钻

## skill 执行模式

### inline 模式

默认执行模式, 内联 skill 的 prompt 到当前对话, 参与 agent loop

skill prompt 的组成

- 固定的 SKILL_INSTRUCTIONS 说明
- `<skill-metadata>`: skill 名称 + 目录路径 (目录型 skill 的资产相对该目录解析, 按需加载)
- `<skill-body>`: SKILL.md 的 SOP 正文
- `<skill-arguments>`: 用户参数 (可选, XML 转义)

`$ARGUMENTS` 替换规则: 对 body 做 `replaceAll("$ARGUMENTS", args)` 全量替换; 自定义命令同理, body 中没有占位符且有参数时, 参数追加到末尾

激活后的 skill 记入 activeSkills, 上下文压缩恢复时以 `## Active skill: <name>` 重新注入, 保证 SOP 在压缩后仍然有效

### fork 模式

开启新对话, 启动一个 subagent 执行 skill, 只将 subagent 的最终结果返回给主对话, 不参与主对话的 agent loop

fork 模式的实现:

- 根据 skill.fork_context 决定携带的父对话上下文, 以 `<parent-context>` 标签前缀拼在 skill prompt 前
  - none 不携带对话历史 (默认)
  - recent 携带最近的 5 条消息
  - full 携带最近的 100 条消息
- 使用 skill.model (缺省用当前 provider) spawn 一个 subagent
- 将 subagent 的最终输出作为工具调用结果返回

## 热加载

没有 fs.watch, 三层机制:

1. 每次取用 skill 时惰性比对 SKILL.md 的 mtime, 变化则重读 (解析失败保留旧缓存); frontmatter 改名触发全量 reload
2. 每次用户提交消息前比对各 skill 目录的 mtime, 检测文件的增删, 需要时全量 reload 并重新注册 slash command
3. `/skills reload` 手动重载

会话中途新增的 skill 不改 system prompt, 而是通过一条 system-reminder 增量下发: "The following skills became available: ..."

## LoadSkill 工具

意图识别的入口, 参数只有 name (required)

- skill 不存在: 返回错误, 列出全部可用 skill 名
- mode 是 fork 且有 forkHost: 走 runFork, SOP 正文不进主对话, 只返回 subagent 的最终结果
- 否则走 runInline, 返回 `Skill '<name>' activated.\n\n<SOP 正文>`

## InstallSkill 工具

从本地路径或 raw SKILL.md URL 安装 skill

- source: 本地文件路径或 SKILL.md 的原始内容 URL (拒绝 HTML 页面和仓库页面); URL 下载超时 30s
- name: 可选的名称覆盖 (校验 `^[a-zA-Z0-9_-][a-zA-Z0-9._-]*$` 且不以 `.` 结尾, 会重写 frontmatter 的 name)
- 安装位置: 用户级 `~/.yukino/skills/<name>/SKILL.md` (所有项目可用)
- 安全: 路径的 symlink 逐段拒绝; 临时文件 + rename 原子替换; 安装完成后重载 catalog 并重新注册 slash command

## 自动注册为 Slash Command

skill 加载后自动注册为 Slash Command:

- inline 模式 → prompt 类型命令, handler 执行 runInline
- fork 模式 → skill_fork 类型命令, UI 特殊处理 (构造 fork host, 结果作为 assistant 消息展示)
- 描述加 `[skill]` 后缀, 标记 isSkill 使其不出现在 /help 列表
- 注册顺序: 内置命令 → 用户自定义命令 → skills, 名字冲突保留先注册的 (用户命令优先于 skill)

## 意图识别: 让 Agent 自己选择 skill

### 两阶段加载

第一阶段: 轻量启动

Yukino 启动时, 扫描 skills 目录, 加载所有 skill 的 frontmatter 元信息 (name, description, mode), 不加载完整 SOP 正文, 将 skill 列表 (description 截断 200 字) 作为 `<system-reminder>` 注入对话历史最前, 告诉 LLM 有哪些 skill

skill 列表不进 system prompt: 列表是项目相关的, 放进 system prompt 会破坏跨项目的 prompt cache 前缀

第二阶段: 按需加载

LLM 判断用户意图匹配某个 skill 时, 调用 LoadSkill 工具

LoadSkill 工具根据该 skill 的 name, 读取 SKILL.md 的 SOP 作为工具调用结果返回, LLM 在下一轮 agent loop turn 中可以看到该 skill 的 SOP

## 渐进式披露

渐进式披露: Agent 启动时, 只加载所有 skill 的 frontmatter 元信息, 选择压力很低; LLM 判断用户意图匹配某个 skill 时, 才加载完整 SOP, 注意力集中在当前任务

## 目录型 skill

- 单文件 skill 只有 SOP
- 目录型 skill 可以携带资产: SOP、API reference、docs、example、scripts, 整套技能方便打包、移植

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

激活时 skill 目录路径通过 `<skill-metadata>` 传给模型, SOP 指令要求: 资源相对 skill 目录解析, 按需加载

## 完整流程

```txt
1. 启动时扫描 skills 目录, 加载所有 skill 的 frontmatter 元信息, 轻量启动
2. skill 列表作为 system-reminder 注入, 告诉 LLM 有哪些 skill
3. skill 加载后自动注册为 Slash Command
4. 用户输入: 做一个 react 计数器 app
5. 意图识别: LLM 判断匹配 react-best-practices skill
6. Agent 请求调用工具 LoadSkill("react-best-practices")
7. SOP 作为工具调用结果返回, 注入到 messages
8. LLM 按 SKILL.md 的规则进行开发
```

- MCP 负责接入
- 工具调用负责调用
- skill 负责编排工作流
