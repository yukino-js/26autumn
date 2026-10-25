---
title: "Code Review"
---

代码审查不再是独立子系统: 早期的 `src/code-review/` (确定性流水线 + 并发小审查 agent + CodeComment/FileReadDiff 工具, 约 3k 行) 已整体移除。现在审查就是一条 `/review` 命令, 委派给内置的 `review` subagent 角色, 用 `gh` CLI 读 PR、读代码, 直接返回文字发现。

为什么收敛成一个角色:

- 审查的本质是「读 diff + 读上下文 + 给结论」, 一个带只读约束的 agent 循环就够, 不需要独立的 diff 采集/分组/定位管线
- PR 的采集交给 `gh` (`gh pr list` / `gh pr view` / `gh pr diff`), 比自研 git diff 解析更省事也更准
- 发现以文字返回给主会话, 主 agent 下一轮可以直接按发现修复, 不需要专门的评论锚定机制

## `/review` 命令

`/review` 是 prompt 类型命令 (src/commands/commands.ts), `agent: REVIEW_AGENT_NAME` ("review"), handler 是 `buildReviewPrompt(args)` (src/commands/prompts.ts):

```txt
/review                 无参数: agent 先跑 gh pr list 列出开放 PR 让用户选
/review 123             审查 PR #123
/review <url>           审查指定 URL 的 PR
/review 123 重点看并发   PR 号 + 额外审查指令
```

`buildReviewPrompt` 生成的提示词要求 agent:

1. 没给 PR 号/URL 时先 `gh pr list` 返回开放 PR 供用户选择
2. 对目标 PR 跑 `gh pr view <number-or-url>` 取详情、`gh pr diff <number-or-url>` 取 diff
3. 读相关代码和项目指令, 在上下文中理解改动
4. 给出简洁但完整的审查: PR 做了什么、正确性、项目约定、性能、测试覆盖、安全; 具体问题带文件路径和行号, 说明影响并给改进建议; 如实说明没能完成的检查

提示词明确「只审查」: 不修改文件、不发布 GitHub review, 直接把发现返回。

## 执行路径

`/review` 走 prompt 命令的 subagent 分支 (src/ui/app.tsx): 命中 `cmd.agent` 时调用 `runSubagentCommand` (src/commands/subagent.ts), 以 `kind: "subagent"`、`subagent_type: "review"`、`fork: false`、`run_in_background: false` 前台跑一次 Agent 工具:

- 用户输入和 agent 返回都写进当前会话 (saveUserMessage / saveMessage), 发现直接出现在对话里
- 前台执行, 事件经 onEvent 流式渲染成 Agent 卡片; 只有 `plan` 命令会 fork 父上下文, `review` 用全新对话
- 结果作为 `stream_text` 输出, 主 agent 下一轮可基于发现继续修复

## review 角色

`review` 是四个内置角色之一 (src/subagent/constants.ts 的 BUILTIN_AGENTS):

```ts
{
  name: "review",
  description: REVIEW_AGENT_DESCRIPTION,
  disallowedTools: ["EditFile", "WriteFile", "ExitPlanMode"],
}
```

- `disallowedTools` 禁掉写文件和退出 plan 模式, 保证审查只读; 与 plan/explore 不同的是 review 不设 `permissionMode: "plan"` / `readOnly`, 因为它需要跑 `gh` 等命令
- REVIEW_AGENT_DESCRIPTION (src/subagent/prompts.ts): 从正确性、项目约定、性能、测试覆盖、安全五个角度审查 PR, 读 diff 和相关代码, 返回带文件路径、行号、影响和改进建议的简洁发现; 不修改文件、不发布 review, 缺上下文或受阻时如实汇报
- 主 agent 也可以不经 `/review`, 直接用 Agent 工具指定 `subagent_type: "review"` 委派审查 (见 subagent)

## 与其它角色的关系

- `review` 只读、面向 PR 审查; `explore` 只读、面向代码探索; `plan` 只读、面向实现计划 (见 subagent)
- 需要并发编排多个审查/验证任务时用 Workflow 脚本 (见 workflow), `/ultracode` 就是把任务交给 Workflow 编排的入口
