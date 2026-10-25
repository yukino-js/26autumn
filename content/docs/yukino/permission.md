---
title: "Permission"
---

## 三种攻击

- prompt 注入
- 越权
- 数据泄露

## 多层防御

权限系统 (src/permissions/index.ts) 的判定入口是 `PermissionChecker.check(toolName, args)`, 返回 `allow / ask / deny` 三种决策, ask 会触发 HITL 确认

判定按以下顺序逐层进行, 前面的层命中即短路

1. 显式规则 (deny / ask 短路): 权限规则文件中命中的 deny 或 ask 规则立即返回; 显式 allow 规则故意不在这里短路, 放行到后面的层, 使得沙箱等层可以先介入
2. teammate 协调工具放行: teammate 的检查器 (teammate = true) 对团队内部协调工具 (SendMessage、共享任务板) 直接 allow: 无人值守的 agent 没有审批通道, 不能让协调工具落入自动拒绝的 ask
3. plan 模式文件例外: plan 模式下, WriteFile/EditFile 的目标是 plan 文件 (`~/.yukino/plans/`) 时直接 allow (只读模式的唯一写例外)
4. 安全只读命令放行: command 类工具 (Bash) 命中安全命令白名单时直接 allow
5. 危险命令拦截: 预留层, 当前 `DANGEROUS_PATTERNS` 有意为空数组 (见下文)
6. 沙箱自动放行: OS 沙箱开启且 `auto_allow: true` 时, Bash 命令在沙箱内执行, 免人工确认 (deny/ask 规则仍然生效)
7. 路径沙箱 (仅 write 类): 写工具的路径参数越出允许的根目录时返回 ask; 读工具不再经过路径沙箱层 (读路径由 deny 规则按需拦截); bypassPermissions 模式跳过; 显式规则可以覆盖
8. 规则再评估: 第 1 层放行的显式 allow 规则在这里生效
9. 权限模式矩阵兜底

## 权限模式

四种权限模式 (Shift+Tab 循环切换 default → acceptEdits → bypassPermissions, plan 不在循环里: 经 /plan 进入、退出时回到 default; 初始值来自 config.yaml 的 `permission_mode`)

| 模式              | 只读工具 (read) | 写工具 (write) | 命令工具 (command) |
| ----------------- | --------------- | -------------- | ------------------ |
| default           | Allow           | Ask            | Ask                |
| acceptEdits       | Allow           | Allow          | Ask                |
| plan              | Allow           | Ask            | Ask                |
| bypassPermissions | Allow           | Allow          | Allow              |

- plan 模式和 default 模式的权限矩阵相同, 区别在于 plan 模式通过每轮注入的 system-reminder 约束 LLM 只读, 并且 plan 文件的写入不需要确认
- bypassPermissions 在权限层放行一切; 对危险命令的防护来自权限规则 (deny)、hook (pre_tool_use reject) 和 OS 沙箱, 而不是权限模式本身

> 注意: 源码中 `DANGEROUS_PATTERNS` 是有意为空的数组, 没有 `rm -rf /` 之类的硬编码危险命令拦截; detectDangerous 层保持惰性, 直到添加具体的模式

## 第 3 层: 安全命令白名单

命令分类只针对 command 类工具 (Bash); WriteFile 有路径沙箱保护, ReadFile 不再受路径沙箱约束

`SAFE_PREFIXES` 包含约 110 个字符串前缀和约 70 条正则:

- 字符串前缀: cat, echo, grep, head, ls, pwd, stat, tail, wc, diff, find 之外的只读命令 (basename, cksum, cut, df, du, jq, md5, ps, uname, which, ...)
- 正则项覆盖带子命令语义的只读形态: `git status/log/diff/show/blame/ls-files/rev-parse` 等只读子命令、`npm/pnpm/yarn` 的查询子命令、各语言工具链的 `--version`、`docker/kubectl` 的只读子命令、`find` (禁止 -delete/-exec)、PowerShell 只读 cmdlet (Get-\*/Select-\*/Test-Path, 大小写不敏感) 等

```js
// 源码: src/permissions/index.ts
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

- 元字符拒绝集: CR、LF、`&`、`|`、`;`、`<`、`>`、反引号、`(`、`)`、`{`、`}`、`[`、`]`, 命中任意一个即不安全, 防止通过管道/链式/重定向/命令替换绕过白名单
- 命中 `isSafeCommand` 的命令直接 allow (reason: "Safe read-only command"), 不需要用户确认
- Bash 工具的并发安全判定复用同一个函数: `isConcurrencySafe(args) = isSafeCommand(command)`

## 第 7 层: 路径沙箱 (仅写)

- 只对 write 类工具生效: ReadFile 等读工具不经过路径沙箱层, bypassPermissions 模式也跳过该层
- 允许的根目录默认两个
  - 项目根目录 (启动 Agent 的工作目录)
  - 系统临时目录 (`os.tmpdir()`, macOS 是 /var/folders/... 而不是 /tmp, Linux 是 /tmp)
- 额外的根: `allowExtraRoot(path)` 运行时追加可写根 (例如 subagent 的 worktree 目录), 主 agent 和委派 agent 的路径沙箱口径统一
- 检查流程: `path.resolve(projectDir, filePath)` 计算绝对路径 → `realpathSync` 解析符号链接 (支持尾部不存在的父目录逐级回退) → `path.relative` 判断是否在某个根内
- write 类工具先查 deny-write 列表 (默认为空)
- 越界时返回 ask (deny 会太激进, 用户可能确实需要写外部路径); ask 之前先重查一次显式规则, 显式规则可以覆盖沙箱决策

## 权限规则

权限规则回答这类需求

- 允许执行 git push, 但不允许执行 `git push --force`
- 允许读取 src/ 目录下的文件, 但不允许读取 .env 文件
- 允许运行 pnpm lint, 但不允许运行 pnpm lint:fix

两个规则文件, 按顺序加载后统一裁决

- 用户级 `~/.yukino/permissions.yaml`
- 项目级 `~/.yukino/projects/<projectKey>/permissions.yaml` (projectKey 是项目规范路径的 sha256, 见 agents-md-and-memory 的存储布局)

格式是顶层 YAML 列表, 每项三个字段

```yaml
- rule: Bash(git *)
  effect: allow

- rule: Bash(git push --force*)
  effect: deny

- rule: ReadFile(*.env*)
  effect: deny

- rule: EditFile(src/*)
  effect: allow
```

- `rule` 的语法是 `Tool(pattern)`, Tool 是工具名或 `*`, pattern 是 glob
- `effect` 枚举: allow / deny / ask
- 裁决优先级: deny > ask > allow, 跨文件、跨行统一裁决 (deny 立即返回, ask 覆盖 allow), 与文件加载顺序和行顺序无关
- glob 语义: `*` 匹配任意字符串 (包括 `/`), `?` 匹配单个字符
- 格式非法的条目跳过, 不中断加载; 规则文件按 mtime+size 缓存

### 「始终允许」

HITL 确认对话框提供「Yes, and don't ask again for this pattern」选项; 用户选择后, CLI 生成一条 allow 规则追加到项目级规则文件 (`~/.yukino/projects/<projectKey>/permissions.yaml`):

- ReadFile/WriteFile/EditFile: pattern 是目标文件的父目录 + `/*`
- 其他工具: pattern 是参数内容的前 1-2 个词 + `*`
- 追加前按 `{tool, pattern, effect}` 去重, 整个文件用 yaml.dump 重写

## HITL 人在回路

前面的层都无法确认时 (决策是 ask), agent loop 阻塞, 通过 `onPermissionRequest` 回调发起权限请求:

1. `describeToolAction` 从工具参数中提取人类可读的描述 (Bash → command、ReadFile/WriteFile/EditFile → file_path、Glob/Grep → pattern、ComputerUse → action、McpCall → server\_\_tool), 展示在确认对话框中
2. 权限请求作为 `permission_request` 事件进入事件流, UI 层弹出对话框 (终端 UI 的 PermissionDialog、remote 的 permission_request WS 消息、ACP 的 session/requestPermission、A2A 的 input-required)
3. 用户决策三选一: `allow` (本次允许) / `deny` (拒绝) / `allowAlways` (始终允许, 写入项目级规则文件)
4. 拒绝时, 将拒绝理由包装为 `isError: true` 的工具调用结果返回给 LLM, agent loop 继续运行; LLM 在下一轮看到这个工具调用错误, 调整策略

## OS 级沙箱

权限系统之外, Yukino 还支持 OS 级沙箱, 把 Bash 命令放进操作系统提供的隔离环境执行 (macOS seatbelt / Linux bubblewrap), 沙箱开启后可以配置 auto_allow 免人工确认; 详见 sandbox
