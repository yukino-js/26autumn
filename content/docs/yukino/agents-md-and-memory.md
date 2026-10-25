---
title: "AGENTS.md and Memory"
---

- 工作记忆: 上下文窗口
- 长期记忆: 持久化到磁盘
  - 指令文件 AGENTS.md
  - 会话持久化
  - 自动记忆: Agent 在对话中自动积累的经验, 例如用户的编码偏好、项目的技术架构

## 指令文件

Yukino 开启新会话时, 自动读取指令文件, 使用 `<system-reminder />` 标签包裹, 作为上下文注入到发送给 LLM API 的 messages 字段中

一个典型的 AGENTS.md

```md
# AGENTS.md

## Project

Yukino is an AI coding assistant TUI built with React + Ink. It talks to LLM providers (Anthropic, OpenAI, OpenAI-compatible) via tool-calling conversations.

## Tech Stack

TypeScript, React, Ink, Zod, Vitest, ESLint, oxfmt, pnpm workspace deps: `@yukino.js/glob-addon`, `@yukino.js/glob-wasm`.

## Code Conventions

Enforced by `eslint.config.js`.

### Type safety

- No `any`, no `!`, no `@ts-ignore`, no `as` casts.
- All `no-unsafe-*` rules are errors.
- Validate runtime data with Zod.

### Style

- File names: kebab-case.
- Control flow: always use braces (`curly: "all"`).
- Promises: must be awaited or voided.
```

### 发现顺序

指令文件的发现顺序, 优先级从低到高

1. `~/.yukino/AGENTS.md` 用户全局级, 最先加载
2. 从 git 仓库根目录到工作目录的每一层目录, 依次加载该层的 `AGENTS.md`

指令文件按顺序加载, 后加载的指令文件不会覆盖先加载的指令文件, 多个指令文件会被拼接, 使用 `---` 分隔

prompt 中靠后的内容, 得到的 LLM 注意力更多, 冲突时优先级更高

## `@` 引用指令

可以在指令文件中使用 `@` 引用其他文件

```md
# AGENTS.md

@./docs/project.md
@./docs/tech-stack.md
@./docs/conventions.md
```

支持的路径格式

- `@./relative/path`, `@../parent/path`
- `@~/home/path`
- `@/absolute/path`

````js
const MAX_INCLUDE_DEPTH = 5;

function expandIncludes(content, baseDir, seen, depth, projectRoot) {
  if (depth > MAX_INCLUDE_DEPTH) {
    return content;
  }
  const lines = content.split("\n");
  const out = [];
  let inCode = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // 检测 markdown 代码块边界
    if (trimmed.startsWith("```")) {
      inCode = !inCode;
      out.push(line);
      continue;
    }

    if (!inCode) {
      const includePath = parseInclude(trimmed);
      if (includePath) {
        const abs = resolve(includePath, baseDir);
        if (!seen.has(abs)) {
          // 只允许 projectRoot 和 ~/.yukino
          if (!isIncludeAllowed(abs, projectRoot)) {
            out.push("<!-- @include skipped: path outside project -->");
            continue;
          }
          const data = readFileSync(abs, "utf-8");
          seen.add(abs);
          out.push(`<!-- included from ${includePath} -->`);
          out.push(
            expandIncludes(data, dirname(abs), seen, depth + 1, projectRoot),
          );
          continue;
        }
      }
    }
    out.push(line);
  }
  return out.join("\n");
}
````

安全风险

1. 无限递归: AGENTS.md 引用 CLAUDE.md, CLAUDE.md 引用 AGENTS.md, 导致无限递归; 使用 `depth` 参数限制最大递归深度
2. 重复 inline 同一个文件: 维护 `seen` 集合, 记录已 inline 的绝对路径, 遇到已 inline 的绝对路径直接跳过
3. 路径越界: `@` 引用的路径必须在项目目录或 `~/.yukino` 内, 越界的路径会被替换为注释 ``

## 会话持久化

Yukino 的会话持久化使用 JSONL 格式 (JSON lines), 每行一个 JSON 对象, 代表一条消息

为什么不使用 sqlite?

- 引入额外的依赖, 提高打包复杂度, 增大打包产物体积
- 用不上 sqlite 的条件查询能力

为什么不使用普通 JSON?

- 使用普通 JSON, 新增一条消息需要:
  - 读取文件为 JSON 字符串
  - 反序列化 JSON 字符串为数组
  - 向数组中 push 一个元素
  - 序列化数组为 JSON 字符串
  - 将 JSON 字符串写回文件, 如果写崩溃, 则损坏整个会话数据
- 使用 JSONL
  - 追加写入: 新增一条消息, 直接追加到文件尾部
  - 增量加载: 恢复会话时逐行读取, 遇到解析失败的行直接跳过
  - 如果写崩溃, 只损坏最后一行

## 存储布局

所有会话和运行态统一存放在 `~/.yukino` 下 (源码: src/storage/index.ts), 项目目录不再承载运行态数据; 按项目隔离的命名空间是项目规范路径的 sha256 (`projectKey = sha256(canonicalPath(cwd))`)

```txt
~/.yukino/
  sessions/<projectKey>/           # 会话日志
    <sessionId>.jsonl
  sessions/artifacts/<sessionId>/  # 会话产物 (按 sessionId 隔离)
    file-history/                  # 文件快照和备份 (见下文)
    tool-results/                  # 溢出的大工具结果 (见 context-compaction)
    shell-<hex>.output             # 后台 shell 输出
    tasks.json                     # 私有任务板 (见 task-tracking)
  projects/<projectKey>/           # 项目命名空间
    memory/                        # 项目记忆
    permissions.yaml               # 项目权限规则 (见 permission)
  worktrees/<projectKey>/<slug>/   # git worktree (见 worktree)
  teams/<projectKey>/<team>/       # agent team (见 agent-team)
  plans/                           # plan 模式的 plan 文件
  memory/                          # 用户全局记忆
  skills/                          # InstallSkill 的安装目标 (见 skills)
  agents/                          # 用户自定义 subagent 定义 (见 subagent)
  prompts/                         # 用户自定义 slash command 的提示词模板 (见 slash-command)
```

会话日志路径是 `~/.yukino/sessions/<projectKey>/<sessionId>.jsonl`; sessionId 由 base36 时间戳和 4 字节随机 hex 组成, 例如 `munwsuxu-2d76691f`

消息使用 provider 无关的内部表示持久化, 切换 provider 后依然可以恢复会话

```json
{
  "role": "user",
  "content": "Write a WeChat",
  "timestamp": 1783277127
}
{
  "role": "assistant",
  "content": "OK, let me ...",
  "timestamp": 1783277280,
  "tool_uses": [
    {
      "tool_use_id": "toolu_abc123",
      "tool_name": "ReadFile",
      "arguments": { "file_path": "/path/to/project/main.ts" }
    }
  ]
}
{
  "role": "user",
  "timestamp": 1783277384,
  "tool_results": [
    {
      "tool_use_id": "toolu_abc123",
      "content": "import ...",
      "is_error": false
    }
  ]
}
```

- `content` 可以是纯文本字符串, 也可以是 content block 数组 (例如携带 base64 图片块的消息原样持久化)
- `tool_uses` / `tool_results` 通过 `tool_use_id` 配对
- 上下文压缩时追加一条 `type: "compact_boundary"` 的记录, payload 是 `{ summary, keep[] }`: 对话摘要和逐字保留的近期消息

追加消息时, 先写 jsonl 文件, 再更新内存

- 如果先写 jsonl 文件再更新内存, 更新内存失败进程崩溃时, 恢复会话可以从 jsonl 文件重建
- 如果先更新内存再写 jsonl 文件, 写 jsonl 文件失败进程崩溃时, 恢复会话消息丢失

多个进程可能并发读写同一个会话文件 (teammate、后台任务), 读写前使用票据式文件锁串行化: 锁文件记录一个递增的票据号, 进程先读票据、写文件、再校验票据没有被抢占

## 恢复会话

1. 逐行读取, 遇到解析失败的行直接跳过, 不中断加载
2. 如果存在 compact_boundary 记录, 取最后一条有效 boundary, 从 boundary 的摘要和保留消息重建对话历史; boundary 之前的原始消息仍在文件中, 只是不再回放
3. 恢复的历史中可能存在悬空的 tool_use (只有调用请求没有结果), 请求发送给 LLM API 前由 `ensureToolPairing` (src/conversation/pairing.ts) 修复配对
4. 加载会话时刷新文件的 mtime, 用于过期清理和「最近使用」排序

## 过期会话清理

Yukino 启动时, 惰性清理超过 30 天没有活跃 (mtime) 的会话: 删除 jsonl 日志和 `sessions/artifacts/<sessionId>/` 下的全部产物 (工具结果、文件快照、后台输出)

## 文件历史和检查点回退

EditFile 和 WriteFile 每次写文件前, 先将被修改文件的当前内容备份到 `~/.yukino/sessions/artifacts/<sessionId>/file-history/` 目录 (备份文件名是 `<文件hash>@s<序号>`), 并记录该文件首次被跟踪时的基线状态 (已存在 / 不存在)

每轮 agent loop 结束时, FileHistory 对所有被跟踪的文件做一次快照, 记录快照对应的消息序号、用户消息摘要、会话日志行数和每个文件的备份路径, 快照索引持久化到 `snapshots.json`

`/rewind` 打开检查点回退对话框, 选择一个快照后, 有三种回退范围

- code_and_conversation: 回退代码文件, 同时截断对话历史到该快照
- conversation_only: 只截断对话历史, 不回退代码
- code_only: 只回退代码文件, 保留对话历史

代码回退的规则

- 快照中记录的备份文件存在: 恢复文件内容
- 备份文件不存在 (快照时该文件不存在): 删除该文件
- 快照之后才被跟踪的文件: 恢复到首次跟踪时的基线 (已存在的恢复原内容, 新创建的删除)
- 回退后删除该快照之后的所有快照及其备份, 不能 redo 前进

对话历史的截断使用快照记录的会话日志行数, 直接截断 jsonl 文件

## 自动记忆

例如要求 Agent: 缩进用 2 个空格, 不要用 4 个空格

- 用户偏好, 存储到 `~/.yukino/memory`
- 项目知识, 存储到 `~/.yukino/projects/<projectKey>/memory`

每条记忆是一个独立的 .md 文件, 有 yaml frontmatter 描述元信息

```md
---
name: no-type-assertions
description: 禁止使用 any、非空断言、@ts-ignore 和 as 类型断言
type: user
---

(记忆正文)
```

frontmatter 支持 `name`、`description`、`type` 三个字段 (兼容 `metadata.type`), type 缺省是 `reference`

MEMORY.md 索引文件由扫描自动生成, 按 name 字母序, 每行一条记忆链接加描述; 索引注入到 messages 字段时有上限, 最多 200 行或 25KB, 先到为准, 超过截断, 防止记忆太多撑满上下文

```txt
~/.yukino/projects/<projectKey>/memory/
  MEMORY.md # 索引文件, 注入到 messages 字段
  no-type-assertions.md
  validate-runtime-data-with-zod.md
```

## 记忆加载

Yukino 开启新会话时, 自动读取指令文件和 MEMORY.md, 使用 `<system-reminder>` 标签包裹, 作为上下文注入到发送给 LLM API 的 messages 字段中; 如果某条记忆的 description 和当前任务相关, LLM 可以调用 ReadFile 读取对应的记忆文件

除了被动读索引, Yukino 还支持主动 recall: 扫描两个记忆目录的头部信息 (name + description), 请求 LLM 选出和当前任务相关的记忆, 将选中的记忆全文渲染为一条 reminder, 开头固定是 `Relevant memories: prior evidence, not current authorization.`, 并标注每条记忆的年龄; 记忆是证据不是授权, 不能覆盖用户的当前指令

`enable_memory: false` 关闭整个记忆管线: 索引注入、recall、后台记忆提取和记忆整理

## 记忆提取

每轮 agent loop 结束后, fire-and-forget 请求 LLM API 做记忆提取 (不阻塞下一轮对话的用户输入), `MemoryExtractor` 将

- 最近 40 条对话消息
- MEMORY.md 索引文件 (记忆提取的 system prompt 中包含 MEMORY.md 索引文件)
- 记忆文件的描述列表

发送给 LLM; LLM 分析对话, 决定是否提取新记忆

提取的新记忆根据类型路由到不同目录

- project 和 reference 类型的新记忆写入到 `~/.yukino/projects/<projectKey>/memory` 项目命名空间
- user 和 feedback 类型的新记忆写入到 `~/.yukino/memory` 全局目录
- 写入后自动调用 rebuildIndex 重建 MEMORY.md 索引文件

### 提取的实现: 带工具的小 subagent

`MemoryExtractor` (src/memory/extractor.ts) 不是裸 LLM 调用, 而是一个带只读/写记忆工具的小 subagent (ReadFile / WriteFile / EditFile / Glob / Grep):

- 触发: 每次 agent loop 结束 (onLoopComplete) 且新增消息 >= 2 条时, fire-and-forget 启动; 输入是最近 40 条消息的 `[role]: content` 序列化文本 (过滤过短的行)
- 去重: 提取前扫描两个记忆目录生成 manifest (`[type] 文件名: description`), 随请求发给 LLM, 避免重复提取已有记忆
- 并发合并: inProgress + pendingContext 队列, 至多排队一个待跑的摘要, 且只跑最新排队的
- 回退: subagent 没有经工具写出任何记忆文件时, 解析其流式文本中的结构化记忆块落盘

## 记忆整理

Yukino 后台定期执行「记忆整理」, fork 一个 subagent, grep 最近的会话日志 (交互式 UI 和 remote 模式都会运行)

- 收集新记忆
- 删除过时记忆
- 合并重复记忆
- 修复冲突记忆
- 更新索引文件

记忆整理的触发门槛 (每轮 agent loop 结束时检查)

- 记忆目录存在
- 距离上一次成功的记忆整理 >= 24h (上一次成功的时间记录在锁文件的 mtime 里)
- 扫描节流: 两次检查之间至少间隔 10 分钟, 避免每轮 loop 结束都去扫会话目录
- 自上次整理以来, 有 >= 5 个会话被修改过
- 获取运行锁成功

对整理 subagent 工具调用的限制

- 没有 shell 工具 (Bash 不可用)
- WriteFile/EditFile 只允许修改记忆目录中的 Markdown 文件
- 修改前必须先读取现有文件

## 防止并发冲突: 两个锁文件

如果同时打开两个 Yukino 会话 (或 remote 服务器与终端同时运行), 两个进程可能同时触发记忆整理; 项目记忆目录 (`~/.yukino/projects/<projectKey>/memory/`) 下用两个文件分工:

- `.consolidate-lock`: 不参与互斥, 只记录「上一次成功整理的时间」; 整理成功后写入空内容, mtime 即成为新的时间戳, 24h 时间门槛读的就是它的 mtime
- `.consolidate-running`: 运行锁, 使用票据式文件锁 (和 teams 邮箱同一套 Lamport bakery 锁), 非阻塞获取: 拿不到锁说明别的进程正在整理, 直接放弃本次 (不排队、不重试, 等下一个触发时机)

交互式 UI 中, 整理进度经 appendSystem 回调以系统消息展示在对话里

```js
// maybeRun() 的核心判定顺序
const lastAt = readLastConsolidatedAt(memDir); // .consolidate-lock 的 mtime
if ((Date.now() - lastAt) / 3600_000 < 24) return; // 时间门槛
if (Date.now() - lastScanAt < 10 * 60 * 1000) return; // 扫描节流
if (listSessionsSince(workDir, lastAt).length < 5) return; // 会话门槛
const releaseLock = tryAcquireFileSyncLock(join(memDir, ".consolidate-running"));
if (!releaseLock) return; // 别的进程正在整理

run(...)
  .then(() => markConsolidationSucceeded(memDir)) // 写 .consolidate-lock, 更新 mtime
  .finally(releaseLock);
```

整理失败不更新时间戳: 下一个触发窗口会重新满足时间门槛, 自动重试

## 记忆提取和记忆整理

- 记忆提取每轮 agent loop 结束后都可能触发, 频率高、消耗小、影响小
- 记忆整理每隔 24h 才可能触发, 频率低、消耗大、影响大
