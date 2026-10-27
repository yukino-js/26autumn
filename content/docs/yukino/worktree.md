---
title: "Worktree"
---

worktree 子系统 (src/worktree/) 用 git worktree 给每个并发工作单元一份独立的检出: 独立的目录、独立的分支, 并发的文件修改互不覆盖, 产出落在各自的分支上, 是否合并由主 agent 决定

三个入口共用同一套机制:

- 主会话直接调用 EnterWorktree / ExitWorktree 工具, 进出一次性的 worktree 会话
- subagent / teammate 指定 `worktree: true` 时, 在独立 worktree 中运行 (见 [subagent](./subagent)、[agent-team](./agent-team))
- Workflow 的 agent adapter 用 `isolation: "worktree"` 为每个脚本步骤开一个 worktree (见 [workflow](./workflow))

worktree 目录放在 `~/.yukino` 下而不是仓库内, 不污染主工作区; 分支统一收在 `worktree/` 前缀下, 便于识别和清理。

## 路径与分支格式

```js
const worktreeDir = yukinoPath("worktrees", projectKey(gitRoot), slug);
// ~/.yukino/worktrees/<projectKey>/<slug>
const branch = `worktree/${slug}/work`;
```

- worktree 目录在 `~/.yukino/worktrees/<projectKey>/` 下, 其中 `projectKey` 是仓库根规范路径的 sha256 (`projectKey(cwd)`), slug 作为最后一级目录名
- 分支名固定格式 `worktree/<slug>/work`
- slug 必须匹配 `/^[a-zA-Z0-9_-]+$/` (`WORKTREE_SLUG_PATTERN`), 只允许字母、数字、连字符、下划线, 以此排除路径遍历 (如 `../../etc/passwd`) 和 shell 元字符; 不合法时报 `Invalid worktree slug`
- EnterWorktree 的 `slug` 参数可选, 缺省用随机 UUID
- subagent / teammate 的 slug 自动生成为 `agent-a<7位hex>` (`newAgentSlug` 取 4 字节随机数的前 7 个十六进制字符); 用随机串而非任务描述, 因为描述里的空格和非 ASCII 字符不能直接进分支名

## 创建 worktree

`createAgentWorktree(slug, gitRoot?, cwd?)` 负责创建, `gitRoot` 缺省时先 `git rev-parse --show-toplevel` 求仓库根:

```bash
# 分支不存在: 新建分支并挂载
git worktree add -b worktree/<slug>/work -- <worktreeDir>

# 分支已存在: 重挂现有分支 tip, 不重置
git worktree add -- <worktreeDir> worktree/<slug>/work
```

先用 `git branch --list --format=%(refname) -- <branch>` 探测分支是否存在, 再二选一。已存在时选择重挂而不是强制覆盖 (`-B`): 并发场景下另一个 agent 可能刚在这个分支上提交了工作, `-B` 会把分支重置到 base, 悄悄丢掉这些提交。

目录已存在时先验证它确实是这个 worktree 的根: 在目录内跑 `git rev-parse --show-toplevel`, 与目录的 realpath 对比, 一致才复用 (返回 `created: false`), 否则报 `Existing directory is not a worktree root`。这一步防止把无关目录当成 worktree 使用, 也防止 git 向上搜索父目录、把主仓库的 HEAD 误报成该 worktree 的提交。

## HEAD 读取: 纯文件系统优先

创建后要拿到 HEAD 的 commit SHA, 作为退出时变更检测的基准 (存入 `headCommit`)。常规做法是紧接着 `git rev-parse HEAD`, 但那要 spawn 一个子进程; 这里有一条纯文件系统的捷径 (`readWorktreeHeadSha`), 目标是把单次读取压到 10ms 以内、省掉约 15ms 的进程启动开销, 读失败再回退 `git rev-parse HEAD`:

1. 读 worktree 目录下的 `.git` 指针文件。worktree 的 `.git` 不是目录而是一个文本文件, 内容以 `gitdir:` 开头, 指向真正的 gitdir
2. 读 gitdir 下的 HEAD 文件
3. 解析 HEAD:
   - 裸 SHA (detached HEAD) 直接返回
   - 符号引用 (`ref: refs/heads/...`) 提取分支名后解析 ref: 先查 gitdir 的 loose ref 和 packed-refs, 再查 commondir 的 loose ref 和 packed-refs, 解析出 commit SHA。worktree 的分支 ref 存放在共享的 commondir 里, 所以必须两级都找
   - ref 本身又可能是符号引用, 递归解析, 深度上限 64 (`MAX_REF_RESOLUTION_DEPTH`), 防止循环引用
4. SHA 同时支持 SHA-1 (40 位十六进制) 与 SHA-256 (64 位十六进制) (`SHA_RE`)

`getCurrentBranch(repoRoot)` 复用同一套读取逻辑, 返回当前分支名, detached HEAD 或非 git 仓库返回空串, 供退出时的身份校验使用。

## 创建后准备

`performPostCreationSetup` 在 `git worktree add` 之后执行, 把主仓库的环境带进新 worktree。所有步骤都是 best-effort: 失败只记日志, 不中断创建:

1. 复制 `.agents/` 的允许清单: `AGENTS.md` 和 `skills` (`SHARED_AGENTS_ENTRIES`)。项目级的 agent 定义等已全局存放在 `~/.yukino` 下、worktree 直接共享, 因此只需把仓库本地的 `.agents/` 条目复制过来
2. 共享 git hooks: worktree 没有既有 `core.hooksPath` 且仓库根存在 `.husky/` 目录时, 执行 `git config extensions.worktreeConfig true` + `git config --worktree core.hooksPath <.husky 绝对路径>`。这是 worktree 级配置, 不改动主仓库共享的 hooks 路径; 已有配置一律优先
3. node_modules 符号链接: 源仓库有 node_modules 而 worktree 没有时, 直接 symlink 过去, 免去重装依赖
4. 读取 `.worktreeinclude` (每行一个路径, 跳过空行和 `#` 注释, 跳过包含 `..` 的行), 把列出的文件和目录复制到 worktree, 单项失败跳过、继续处理其余项

没有自动的依赖安装步骤 (pnpm install / go mod tidy): node_modules 靠 symlink, 其他生态靠 `.worktreeinclude` 或用户在 worktree 内自行安装。

## 进入 worktree

关键设计是不切换进程级 cwd —— 整个代码库没有 `process.chdir`。后台异步 subagent、agent team 成员会并发调用 Bash 工具, 如果共享并改写同一个进程 cwd, 会互相踩踏; 因此 worktree 只是一个「会话级工作目录」:

- 主会话: `PermissionChecker.enterWorktree` 记录一个 `worktreeSession`; agent loop 的 cwd 取值器优先返回 `worktreeSession.path`, 于是每次工具调用 (Bash、ReadFile、WriteFile 等) 拿到的 cwd 都是 worktree 路径, 路径在 worktree 内解析。同时注入一条 working-directory 系统提醒, 告知模型新的工作目录和 worktree 分支
- 派生的 subagent / teammate: 用 `forWorktree` 生成一个隔离的 PermissionChecker (`isolatedRoot` 设为 worktree 路径), 工具的 cwd 覆盖为 worktree 路径, 并在 prompt 前置一条 worktree 通知 (`buildWorktreeNotice`)

```txt
You are working in a git worktree at: <wtPath>
The parent project is at: <parentCwd>
Changes made here are isolated from the parent working tree.
```

所有权把关: `enterWorktree` 只采纳本运行时创建或进入过的 worktree, 手工创建的、或别的运行时创建的 worktree 一律不接管 (报 `Cannot enter a worktree that was not created by this runtime`); `forWorktree` 更进一步, 只能认领新建的 worktree, 因为隔离 agent 不允许接管现成目录。

## 退出 worktree

ExitWorktree 的参数: `action` 必填 (`keep` | `remove`), `discard_changes` 可选 (布尔)。worktree 的路径、分支、创建时的 HEAD 都记录在 PermissionChecker 的 `worktreeSession` 里, 工具不需要也不接受这些参数。没有活跃会话时是 no-op, 明确提示未做任何文件系统改动。

- `action: "keep"`: 保留 worktree 和分支, 输出 `Your work is preserved at <path> on branch <branch>`, 会话退回原工作目录
- `action: "remove"`: 先做身份校验和变更检测, 再决定是否真正删除

退出前要求原工作目录仍然存在; 删除成功后 `leaveWorktree` 把会话 cwd 还原到 `originalCwd`。

### 变更检测

`countWorktreeChanges(path, headCommit)` 并发跑两条命令:

```bash
# 未 commit 的修改 (含 untracked)
git status --porcelain --untracked-files=all

# 相对创建基准新增的 commit 数
git rev-list --count <headCommit>..HEAD
```

前者按非空行计数得到 `changedFiles`, 后者得到 `commits`; 任一失败返回 null, 表示状态无法核实。`hasWorktreeChanges` 是更保守的布尔判断: `git status --porcelain` 非空、或当前 HEAD 偏离创建基准即为有变更, 检查失败时也按有变更处理。

### 删除安全闸

`action: "remove"` 且未给 `discard_changes: true` 时:

- 变更状态无法核实 (count 返回 null): 拒绝删除, 提示与用户确认后重试 `discard_changes: true` 或改用 `action: "keep"`
- 有未 commit 文件或新增 commit: 拒绝删除, 报告具体数量 (`Worktree has N uncommitted files and M commits`), 给出同样的两条出路
- 确无变更: 执行清理

```bash
# discard_changes=false: git 自己复查 dirty/locked; -d 在分支有未合并提交时拒绝删除
git worktree remove -- <path>
git branch -d -- <branch>

# discard_changes=true: 强制删除, 丢弃未 commit 修改和未合并 commit
git worktree remove --force -- <path>
git branch -D -- <branch>
```

即便走到删除, 仍有一层身份校验: worktree 的 gitdir、commondir、gitdir 里的 gitdir 反向指针 (必须指回 `<path>/.git`)、主仓库的 commondir、当前分支, 都要与创建时的记录一致; 任何一项被外部改动过就拒绝清理 (`Worktree Git identity changed` / `Worktree registration or branch changed`), 防止误删不属于自己的 worktree。

## 所有权记录

`OwnedWorktrees` 是运行时持有的登记表, 只登记本运行时创建的 worktree (`created: true`), 记录 gitdir、commondir、分支和一个 0700 的临时目录, 并派生一组沙箱写根: 该 worktree 自己的 gitdir、共享的 objects 目录、以及这个分支独占的 refs / logs 目录。git 在 worktree 里运行需要写这些位置 (加锁、写 reflog、存对象), 于是它们被并入沙箱允许写入的根集合 (见 [sandbox](./sandbox)); 共享的 git 目录本身和兄弟分支的 ref 永远不授权。登记时会预先 `mkdir` 出这个分支对应的 refs / logs 目录, 让这些沙箱写根真实存在。

## 清理

没有按前缀扫描的定时 GC, 不同入口的收尾策略不同:

- 主会话 worktree: 唯一的删除路径是 ExitWorktree 判定可删时的清理
- subagent (一次性) worktree: 结束后原样保留, 不自动 commit、不自动删除, 返回结果附 `Worktree retained at: <path>`
- teammate worktree: 保留, 路径记入成员元数据, 供 Leader / 用户手动合并
- Workflow adapter (`isolation: "worktree"`): agent 步骤结束后检查变更, 无变更则删除、有变更则保留并记日志

共同点是: 有变更的 worktree 永远不自动删除。

> 进程崩溃、用户强制退出, 会在 `~/.yukino/worktrees/<projectKey>/` 下残留 worktree 目录; 用户可以调用 Bash 工具执行 `git worktree list` / `git worktree remove` 手动清理, 或用 /worktree 命令查看列表

## worktree 与 subagent

subagent 使用 `worktree: true` 时的启动流程:

1. 创建 worktree (slug 自动生成 `agent-a<7位hex>`, 分支 `worktree/agent-a.../work`)
2. 用 `forWorktree` 给 subagent 一个隔离的 PermissionChecker, 工具调用的 cwd 覆盖为 worktree 路径
3. prompt 前置一条 worktree 通知 (`buildWorktreeNotice`)
4. 运行 subagent
5. 结束后 worktree 原样保留 (不自动 commit、不自动删除), 返回结果附 `Worktree retained at: <path>`
6. 主 agent review, 决定是否合并

> 考虑以下场景

subagent 在 worktree 中修改并提交了 server.ts, 主 agent 期望把这些变更 merge / rebase / cherry-pick 到主分支。Yukino 没有内置的 merge / rebase / cherry-pick 工具, 主 agent 调用 Bash 工具执行对应的 git 命令:

- merge / rebase / cherry-pick 不是 agent 的原子操作, 中途可能要解冲突、要 abort
- 主 agent 需要调用 ReadFile 查看冲突文件, 决定合并顺序和冲突解决策略
- 失败时主 agent 需要调用 Bash 工具 abort

把这些留给 Bash + ReadFile 组合, 比封装成一个半成品工具更灵活, 也更贴合「worktree 负责隔离、合并由主 agent 决策」的分工。
