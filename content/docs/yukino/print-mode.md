---
title: "Print Mode"
---

Print 模式是非交互的执行模式: 一条命令进去, 结果打印到 stdout, 进程退出; 用于脚本和 CI 流水线

```bash
yukino -p "explain this codebase"
yukino -p "fix the failing test" --output-format stream-json
```

## 旗标

- `-p <prompt>`: prompt 必须紧跟在 -p 之后 (多词 prompt 加引号); -p 后面直接跟另一个旗标视为错误, 打印提示并以退出码 1 结束
- `--output-format text|stream-json`: 输出格式, 默认 text; 非法值报错退出

没有 --print 长旗标, 没有其他参数: provider 使用 config.yaml 的 default_provider, 工作目录是 process.cwd()

## 与交互模式的差异

- 权限: 固定 bypassPermissions, 不弹任何确认; print 模式有意绕过权限提示, 只应在可信的 prompt 上运行 (CI 里跑不可信输入等于任意代码执行)
- 会话: 有临时 sessionId (供持久目标和会话产物使用), 但不写会话 jsonl, 不可 --resume; 退出时删除整个产物目录
- 没有 HookEngine、没有 skills、没有 AskUserQuestion、没有 file-history 快照
- 支持持久目标 (GoalManager): 单次非交互执行内目标可以自动续跑 (见 goal)
- 遥测正常初始化 (mode: print)

工具集是非交互的基础注册 (createToolRegistry 18 个, 不含 EnterPlanMode; 含 Goal、TodoWrite、LSP、WebFetch) + 团队工具 (TeamCreate、SendMessage、TeamDelete、TaskStop、leader 任务工具覆盖) + Agent + Workflow + SyntheticOutput

- 团队工具保留: 单次非交互执行内, leader 仍然可以组建 team 委派任务
- 团队不从磁盘恢复: 退出时 stopAll 会停掉所有 team, 恢复交互会话留下的外部 teammate 会误杀它们
- MCP 在内置工具全部注册后才连接: 延迟加载策略要用「全部 schema 的总大小」对比上下文窗口来决定模式 (见 mcp)

## text 输出

LLM 的流式文本直接写 stdout (边生成边输出), 结束时补换行; 之后追加后台任务的通知文本

```bash
$ yukino -p "总结 src/agent/index.ts 的职责"
Agent 循环封装: run() 是一个 AsyncGenerator...
```

## stream-json 输出

每个事件一行 JSON, 供程序消费; 除工具事件外, stream_text、thinking_text、turn_complete、loop_complete、steering_delivered、retry、compact 也逐行原样输出:

```jsonc
// 流式文本增量
{ "type": "stream_text", "text": "Agent 循环封装..." }
// 工具调用开始
{ "type": "tool_use", "tool_name": "ReadFile", "tool_id": "toolu_1", "args": { "file_path": "src/agent/index.ts" } }
// 工具调用结果
{ "type": "tool_result", "tool_name": "ReadFile", "output": "1\timport ...", "is_error": false, "elapsed": 0.02 }
// token 用量 (每次 LLM API 响应后)
{ "type": "usage", "input_tokens": 12000, "output_tokens": 340 }
// 错误
{ "type": "error", "message": "..." }
// 后台任务完成通知
{ "type": "task_notification", "notification": "<task-notification ...>" }
```

结束时输出一行汇总:

```jsonc
{
  "type": "result",
  "result": "Agent 循环封装: run() 是一个 AsyncGenerator...",
  "duration_ms": 8420,
  "num_turns": 3,
  "tool_calls": [{ "tool": "ReadFile", "tool_id": "toolu_1", "elapsed": 0.02 }],
  "usage": {
    "inputTokens": 12000,
    "outputTokens": 340,
    "cacheReadInputTokens": 0,
    "cacheCreationInputTokens": 0,
  },
}
```

## 退出行为

- 只等待后台 Agent 任务的结果 (它们参与最终答案); 后台 shell 任务 (dev server、超时自动转后台的命令) 不等待, 否则 -p 永远挂住
- finally 清理: 停止所有后台任务和 team、断开 MCP 子进程、删除本次的会话产物目录
- 退出码: 正常结束 0; error 事件或 interrupted 置 1

## 结构化交付: SyntheticOutput

脚本场景往往需要机器可读的结果而不是散文; SyntheticOutput 工具让 agent 以结构化 JSON 交付最终结果:

```bash
yukino -p "分析这个仓库的依赖, 用 SyntheticOutput 交付 { outdated: string[] }" \
  --output-format stream-json
```

coordinator 模式下 SyntheticOutput 是 leader 白名单里的交付通道 (见 agent-team)
