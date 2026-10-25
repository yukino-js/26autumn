---
title: "Worktree"
---

文件系统隔离

subagent / teammate 指定 `worktree: true` 时, 在独立的 git worktree 中工作: 并发的文件修改互不覆盖, 结果由主 agent 决定是否合并; 用户也可以直接调用 EnterWorktree / ExitWorktree 工具

## 路径与分支格式

```js
const worktreeDir = yukinoPath("worktrees", projectKey(gitRoot), slug);
// ~/.yukino/worktrees/<projectKey>/<slug>
const branch = `worktree/${slug}/work`;
```

- worktree 目录在 `~/.yukino/worktrees/<projectKey>/` 下 (projectKey 是仓库根规范路径的 sha256), 不在仓库内, 不污染工作区
- 分支名格式 `worktree/<slug>/work`
- slug 需要安全校验, 防止路径遍历 (../../etc/passwd): slug 必须匹配 `/^[a-zA-Z0-9_-]+$/`; EnterWorktree 的 `slug` 参数可选, 缺省用随机 UUID
- subagent 的 worktree slug 自动生成: `agent-a<7位hex>`

## git worktree 命令

```bash
# 分支不存在: 创建新分支
git worktree add -b worktree/<slug>/work -- <worktreeDir>

# 分支已存在: 重挂现有分支 tip, 不重置
git worktree add -- <worktreeDir> worktree/<slug>/work
```

分支已存在时用重挂而不是强制覆盖 (`-B`): 并发场景下另一个 agent 可能刚在这个分支上提交了工作, `-B` 会把分支重置到 base, 悄悄丢掉这些提交

目录已存在时的复用: 先验证它确实是这个 worktree 的根 (`git rev-parse --show-toplevel` + realpath 对比), 是则直接复用, 不是则报错; 避免把无关目录当成 worktree 使用

## HEAD 读取: 纯文件系统优先

创建 worktree 后要拿到 HEAD 的 commit SHA (退出时做变更检测的基准), `git worktree add` 之后立刻 `git rev-parse HEAD` 需要 spawn 子进程, 而读 HEAD 有纯文件系统的捷径 (目标 10ms 以内, 失败再回退 `git rev-parse HEAD`):

1. 读 worktree 目录下的 `.git` 指针文件, 得到 gitdir 路径
2. 读 gitdir 下的 HEAD 文件
3. HEAD 是符号引用 (`ref: refs/heads/...`) 时, 先查 gitdir 的 refs, 再查 commondir 的 refs 和 packed-refs, 解析出 commit SHA (支持 SHA-1 40 位和 SHA-256 64 位)

## worktree 创建后

`performPostCreationSetup` 创建后执行, 所有步骤 best-effort (失败只记日志, 不中断创建):

1. 复制 `.agents/` 的允许清单: `AGENTS.md`、`skills` (项目级配置如 permissions.yaml、agents 定义、commands、记忆已经全局存放在 `~/.yukino` 下, worktree 直接共享, 不需要复制)
2. 共享 git hooks: worktree 没有既有 `core.hooksPath` 且仓库根存在 `.husky/` 目录时, `git config extensions.worktreeConfig true` + `git config --worktree core.hooksPath <.husky 绝对路径>`; worktree 级配置, 不污染主仓库的共享配置
3. node_modules 符号链接: 源仓库有 node_modules 而 worktree 没有时, 直接 symlink, 免去重装依赖
4. 读取 `.worktreeinclude` 文件 (每行一个路径, 跳过空行和 `#` 注释, 跳过包含 `..` 的行), 将 include 的文件和目录复制到 worktree, 单项失败跳过

没有自动的依赖安装步骤 (pnpm install / go mod tidy): node_modules 靠 symlink, 其他生态靠 .worktreeinclude 或用户在 worktree 内自行安装

## 进入 worktree

- 不切换进程级 cwd: 防止后台异步 subagent、agent team 并发调用 Bash 工具时互相踩 cwd
- worktree 路径写入工具调用的 workDir 覆盖, subagent 调用 Bash、ReadFile、WriteFile 等工具时在 worktree 内解析路径
- subagent 的 prompt 前置一条 worktree 通知 (buildWorktreeNotice):

```txt
You are working in a git worktree at: <wtPath>
The parent project is at: <parentCwd>
Changes made here are isolated from the parent working tree.
```

- 你 (subagent) 继承父 agent 的对话历史
- 你 (subagent) 在 git worktree 工作, 你需要翻译父 agent 对话历史中的路径为 worktree 中的路径, 修改文件前重新读取文件

## 退出 worktree

ExitWorktree 工具的参数: `action` 必填 (`keep` | `remove`), `discard_changes` 可选 (布尔)。worktree 的路径、分支、创建时 HEAD 都由 PermissionChecker 的 worktreeSession 内部记录, 工具不需要也不接受这些参数

- `action: "keep"`: 保留 worktree 和分支, 输出 `Your work is preserved at <path> on branch <branch>`, 会话退回原工作目录
- `action: "remove"`: 先做变更检测和身份校验, 再决定是否真正删除

变更检测 `countWorktreeChanges(path, headCommit)`:

```bash
# 未 commit 的修改 (含 untracked)
git status --porcelain --untracked-files=all

# 相对创建基准新增的 commit 数
git rev-list --count <headCommit>..HEAD
```

`action: "remove"` 且未给 `discard_changes: true` 时的安全闸:

- 变更状态无法核实: 拒绝删除, 提示与用户确认后重试 `discard_changes: true` 或改用 `action: "keep"`
- 有未 commit 文件或新增 commit: 拒绝删除, 报告具体数量, 提示确认后重试 `discard_changes: true` 或改用 `action: "keep"`
- 确无变更: 执行清理

```bash
# discard_changes=false: git 自己复查 dirty/locked; -d 在分支有未合并提交时拒绝删除
git worktree remove -- <path>
git branch -d -- <branch>

# discard_changes=true: 强制删除, 丢弃未 commit 修改和未合并 commit
git worktree remove --force -- <path>
git branch -D -- <branch>
```

删除前还有一层身份校验: worktree 的 gitdir / commondir / 当前分支必须仍与创建时的记录一致, 被外部改动过就拒绝清理, 防止误删不属于自己的 worktree

## 清理

没有按前缀扫描的定时 GC: worktree 的唯一自动删除路径是 ExitWorktree 判定无变更时的清理; subagent 结束后 worktree 显式保留 (输出 `Worktree retained at: <path>`), 有变更的 worktree 永远不自动删除

> 进程崩溃、用户强制退出, 会导致 ~/.yukino/worktrees/<projectKey>/ 下残留 worktree 目录; 用户可以调用 Bash 工具执行 `git worktree list` / `git worktree remove` 手动清理, 或 /worktree 命令查看列表

## worktree 与 subagent

subagent 使用 `worktree: true` 时, subagent 的启动流程

1. 创建 worktree (slug 自动生成为 `agent-a<7位hex>`, 分支 `worktree/agent-a.../work`)
2. subagent 的 PermissionChecker 切到 worktree (forWorktree), 工具调用的 workDir 覆盖为 worktree 路径
3. prompt 前置一条 worktree 通知 (buildWorktreeNotice)
4. 运行 subagent
5. 结束后 worktree 原样保留 (不自动 commit、不自动删除), 返回结果附 `Worktree retained at: <path>`
6. 主 agent review, 决定是否合并

> 考虑以下场景

subagent 在 worktree 中修改并提交了 server.ts, 主 agent 期望将该 subagent 的变更 merge/rebase/cherry-pick 到主分支; Yukino 没有内置的 merge/rebase/cherry-pick 工具, 主 agent 调用 Bash 工具, 执行 `git merge/rebase/cherry-pick`

为什么 Yukino 没有将 merge/rebase/cherry-pick 作为内置工具?

- merge/rebase/cherry-pick 不是 Agent 的原子操作
- 主 agent 可以调用 Bash 工具执行 git 命令
- 主 agent 需要调用 ReadFile 工具查看冲突文件, 以确定 merge/rebase/cherry-pick 顺序和冲突解决策略
- merge/rebase/cherry-pick 失败时, 主 agent 需要调用 Bash 工具 abort
