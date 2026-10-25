---
title: "Slash Command"
---

Slash Command: 以 / 开头的输入会被命令解析器拦截

## 命令的分类

四种命令类型 (源码: src/commands/commands.ts)

- local: 不参与 agent loop, 不需要重新渲染 UI, handler 返回的字符串直接作为系统消息展示
- local_ui: 不参与 agent loop, 需要 UI 处理 (打开对话框、切换模式、重载状态)
- prompt: 参与 agent loop, handler 构造 prompt 作为用户消息发送给 LLM API
- skill_fork: skill 加载后自动注册的 fork 型命令, UI 构造 fork host 执行

> 不参与 agent loop != 不调用 LLM API
>
> 例如 /compact 命令调用 LLM API 生成摘要, 但是不参与 agent loop

命令拦截时机: 消息发送给 LLM API 前, 用户按下回车, 先判断输入是不是命令, 如果是命令则走命令处理逻辑, 不是命令才发送给 LLM API

解析规则: 以 `/` 开头; 首个空白之前是命令名, 之后是 args; 命令名包含 `/` 时视为文件路径, 按普通用户消息处理; 同名注册直接抛错 (先注册者赢)

## 内置命令清单

| 命令                   | 类型     | 行为                                                                                                                                                                                     |
| ---------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| /workflows             | local_ui | 打开 workflow 运行监控面板 (见 workflow)                                                                                                                                                 |
| /ultracode [args]      | prompt   | 把任务交给 Workflow 工具编排多 subagent (ULTRACODE_PROMPT + 任务), 后台运行, /workflows 监控 (见 workflow)                                                                               |
| /login                 | local_ui | 打开表单配置、保存并激活一个 LLM provider                                                                                                                                                |
| /provider              | local_ui | 切换当前 provider (终端 UI 和 remote 注册)                                                                                                                                               |
| /model [model]         | local_ui | 切换当前 provider 的模型; 无参数时打开模型选择器                                                                                                                                         |
| /help [command]        | local    | 列出全部命令 (不含 skill), 或单个命令的详情                                                                                                                                              |
| /status                | local    | 当前会话状态: 模式、模型、provider、token、工具、沙箱、记忆、skills、MCP、会话、目录                                                                                                     |
| /session               | local    | 确认当前会话活跃; 历史会话用 /resume                                                                                                                                                     |
| /memory                | local    | 列出记忆; `/memory clear` 清空记忆                                                                                                                                                       |
| /skills                | local_ui | 列出 skills; `/skills reload` 从磁盘热重载                                                                                                                                               |
| /skill `<name>` [args] | -        | 按名运行 skill (等价于 `/<name> [args]`; `/skill reload` 路由到 /skills reload)                                                                                                          |
| /plan [args]           | prompt   | 在前台 plan agent 里规划当前任务 (fork 父上下文), 成功后进入 plan 审批                                                                                                                   |
| /goal [args]           | prompt   | 设置/查看持久目标 (status、pause、resume、continue、complete、clear、replace, `--budget <tokens>`); UI 拦截本地处理, 不消耗 LLM token, 只在目标设置/替换时注入 prompt 启动循环 (见 goal) |
| /compact               | local_ui | 强制上下文压缩                                                                                                                                                                           |
| /clear                 | local_ui | 重置会话并清屏                                                                                                                                                                           |
| /resume [id]           | local_ui | 列出或恢复历史会话                                                                                                                                                                       |
| /rewind                | local_ui | 打开检查点回退对话框 (见 agents-md-and-memory 的文件历史)                                                                                                                                |
| /sandbox [mode]        | local_ui | 配置沙箱: auto (开启+自动放行) / manual (开启+手动确认) / off                                                                                                                            |
| /worktree              | local_ui | 列出 git worktrees                                                                                                                                                                       |
| /review [PR]           | prompt   | 委派给内置 review agent 审查 PR (`gh pr view` / `gh pr diff`), 只读返回发现 (见 code-review)                                                                                             |
| /mcp                   | local    | 显示 MCP server 连接状态; `/mcp reload` 重读配置并 reconnect                                                                                                                             |
| /feedback `<text>`     | local_ui | 在前台 agent 里分析当前会话, 审查问题后提交到 yukino 仓库                                                                                                                                |
| /thinking [level]      | local    | 无参数打开思考强度选择器; 带参数设置 (off...max), 持久化到 config.yaml                                                                                                                   |
| /quit                  | local_ui | 退出                                                                                                                                                                                     |

## 用户自定义命令

用户级单目录: `~/.yukino/prompts/` (src/commands/loader.ts, 递归扫描 `*.md`, 没有项目级)

- 子目录命名空间化 (`sub/dir/foo.md` 注册为 `sub:dir:foo`); 路径段小写、空格转 `-`; 与内置命令冲突时保留内置
- 自定义命令固定是 prompt 类型

```md
---
description: 生成周报
argument-hint: [本周重点]
---

请根据本周的 git log 生成一份周报, 重点关注:
$ARGUMENTS
```

- frontmatter 只支持 `description` 和 `argument-hint` (解析失败时忽略 frontmatter, 保留正文)
- description 缺省是 "custom command" (有 argument-hint 时附带参数提示)

### 参数替换

模板支持带引号的位置参数解析 (`"a b" c` 解析为两个参数) 和一组占位符:

- `$1`, `$2`, ...: 第 N 个位置参数; `$@`: 全部位置参数拼接
- `$ARGUMENTS`: 保留用户参数的原文, 包括引号和间距
- `${1:-main}`: 缺省值; `${@:2:3}`: 位置参数切片 (从第 2 个起取 3 个)
- 替换只做一遍, 参数内的占位符文本保持字面; 模板没有任何占位符时, 参数追加到正文末尾

## 使用频率追踪

`CommandUsageTracker` 将命令使用记录持久化到 `~/.yukino/command_usage.json` (用户全局, usageCount + lastUsedAt):

- 得分 = 使用次数 × recency 权重 (半衰期 7 天, 下限 0.1)
- 输入补全时按得分取最近使用的 5 个命令优先展示

## prompt 命令

prompt 类型的命令由 CLI 构造 prompt 发送给 LLM API, 消耗 token; 来源有三类: 内置命令 (/plan、/goal、/review、/ultracode)、用户自定义命令 (上文) 和自动注册的 inline skill (见 skills)
