---
title: "Terminal UI"
---

交互式 TUI: React 19 + Ink 7 渲染的单窗格终端界面 (src/ui/)。入口是 `runUiMode()` (src/main.tsx): 装好终端输出层和 stdin 过滤层后, 用 Ink 的 `render()` 挂载 App 组件 (src/ui/app.tsx, `exitOnCtrlC: false`, 键盘语义全部自管)。流式回复、工具卡片、权限对话框、用户 Bash、slash 命令、Agents 列表都发生在这一屏里

## 主屏渲染: 原生滚动 + 实时帧

Yukino 使用终端的**主屏**, 不进 alternate screen, 启动时主动写 `\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l` 关闭鼠标上报 —— 不捕获鼠标、不翻译滚动事件。一屏分成两块 (src/ui/transcript.tsx、src/ui/terminal-layout.tsx):

- **transcript (Ink Static)**: 完成的消息 (用户消息、assistant 段落、工具卡片、思考块、系统提示) 只打印一次, 追加进终端原生 scrollback; 选择、复制、滚轮/触控板历史滚动全部交给终端
- **实时帧 (`TerminalLayout`)**: 固定在终端底部就地重绘, 自上而下四个区域: activity (运行中的流式文本、工具卡、用户 Bash 卡, 视口跟随尾部)、status (新版本提示、steering/follow-up 队列、Ctrl+C 提示、todo 进度、Agents 计数)、dock (输入框或当前打开的对话框)、footer (cwd/session id、token 统计与上下文百分比、provider/model、thinking 级别、权限模式); 各区域行数预算随终端高度伸缩: 高度不足 10 行隐藏 status, 不足 5 行压缩 footer

主屏渲染的关键是 `installTerminalOutput()` (src/ui/terminal-output.ts), 它拦截 `stdout.write`, 把输出分成两类:

- 静态输出由 `expectStaticTerminalOutput()` 预注册, 累积进 `staticOutput`, 不参与实时帧重绘
- 实时帧用关闭 autowrap 的软换行组写入 (`renderLiveFrame`), 形状不变的帧走逐行差分 (`renderFrameChanges`): 只按格覆盖变化的行, 不擦行 —— 擦掉软换行行会破坏终端原生的 resize reflow 组, 也会打断鼠标选择

写盘时机上, 检测支持 DEC 2026 synchronized output 的终端会在每次写外侧包裹 BSU/ESU (`\x1b[?2026h` / `\x1b[?2026l`), 避免半帧渲染。检测走环境变量而不是 DECRQM 查询: TERM_PROGRAM 属于 alacritty、contour、ghostty、iTerm.app、vscode、WarpTerminal、WezTerm, 或 TERM 含 kitty / ghostty / foot / alacritty, 或设置了 KITTY_WINDOW_ID / ZED_TERM / WT_SESSION, 或 VTE_VERSION ≥ 6800; tmux 下一律禁用

由此派生的行为:

- **transcript identity 变化即整体重印**: identity 是 `<sessionId>-<revision>-<expanded>`, Ctrl+O (切换 expanded)、/resume、/rewind (递增 revision) 都会改变它 —— 此时清屏 (含 scrollback) 按新状态重放全部历史; 普通重绘永远保留 scrollback
- **resize 只重绘实时帧**: 终端变宽/变高时擦掉帧自身那几行、按新高度重画; 已打印的历史保留原换行, 走终端自己的 reflow, 不为更宽的终端重建或拉伸
- **流式文本增量进历史**: 流超过 2048 字符后, `stableStreamingPrefix()` 把已完成的 Markdown 前置块提交进 scrollback (保留最后一块可编辑, 后续 delta 还能续写列表/表格/围栏代码), 其余在轮次结束时提交
- **主题检测**: config 的 `theme` 为 auto 时, 先看 `COLORFGBG` 环境变量, 再向终端发 `CSI ?996n` 和 OSC 11 背景色查询 (100 ms 超时, 无应答按 dark), 按背景色亮度选 light/dark 调色板

## stdin 过滤

`TerminalInput` (src/ui/terminal-input.ts) 是夹在真实 stdin 和 Ink 之间的 Transform 流:

- OSC 11 背景色应答和 `CSI ?997` 配色方案应答从按键流里摘出, 作为 `terminal-response` 事件发给主题检测, 不进入 Ink 的按键分发
- bracketed paste 定界符 (`\x1b[200~` / `\x1b[201~`) 原样转发给 Ink 的粘贴处理; 粘贴体内按整段一次转发, 多 MB 粘贴保持 O(n)
- 孤立 ESC 由 25 ms 超时冲刷, 保证 Esc 键可用

## 输入框

InputBox (src/ui/input.tsx) 是主输入:

- 多行编辑: Shift+Enter / Ctrl+J 换行 (Ink 把 Ctrl+J 的裸 LF 解码为带 `\n` 的 return, 单独的 `\n` 永远是换行而不是提交), Home/End 与 Ctrl+A/Ctrl+E 行首行尾, 光标和删除按字素边界移动
- **粘贴折叠**: bracketed paste 走 Ink 的 `usePaste`; 不支持 bracketed paste 的终端用兜底启发式 —— 单个 chunk 含换行且带其他内容, 或不带 Ctrl/Meta 且超过 1000 字符, 判定为粘贴而非回车。超过 10 行或 1000 字符的文本折叠为 `[paste #1 +124 lines]` (按行数) 或 `[paste #1 1580 chars]` (按字符数) 占位符
- **剪贴板图片**: Ctrl+V (Windows 是 Alt+V, 那里终端保留了 Ctrl+V 做文本粘贴) 或空文本粘贴触发读图 —— macOS 走 osascript, Linux 走 wl-paste (Wayland) 或 xclip (X11), Windows 走 PowerShell; 必须是 PNG, 上限 32 MiB。图片存进 `~/.yukino/sessions/artifacts/<session-id>/file-history/`, 文件名取内容 sha256 前 16 位 hex (重复粘贴复用同一文件), 输入框里显示为 `[Image #1]`; 提交时还原成 cwd 相对的带引号 `'@path'` 引用, 经 @ 展开作为内联图片块发送
- 占位符按整体移动/删除 (`inputBoundary` 让光标和退格跳过整个标记), 提交时 `expandPastes` 一次还原, 标记内部的类标记文本不会被二次展开
- **补全菜单**: 单行 `/` 开头弹出 slash 命令菜单 —— 先精确、再前缀、再 Fuse.js 模糊; 空查询把最近使用的 5 个命令排在 RECENTLY USED 区; 输入行尾部显示 ghost 补全文本; `/think`/`/thinking` 后接 thinking 级别候选。`@` 弹出文件菜单 (`scanCwdFiles` 扫描 cwd 相对路径, 跳过隐藏文件和依赖目录; 结果缓存 30 s, 文件写入或 agent 轮次结束通过 fileFactsVersion 立即失效), 对光标所在行的 `@` 前缀匹配。slash 菜单只在单行时出现; `@` 菜单在 `/` 开头和 `!`/`!!` 输入下禁用
- **提交路由** (src/ui/app.tsx): `!`/`!!` 前缀先走用户 Bash (不经模型); `/` 走 [slash-command](./slash-command); 模型流式期间的普通文本 steering 进运行中的轮次 (在下一个轮次边界注入, status 区显示 `Steering:` 行), 其余情况进 follow-up 队列, 空闲时按序发送 (显示 `Follow-up:` 行); 空输入按 ↑ 把最近一条队列消息弹回编辑器
- 草稿由 InteractionDock 的 `draftRef` 持有: 权限对话框、Agents 列表等接管输入位时 InputBox 卸载, 未发送的文本、光标和粘贴占位符原样保留

## 快捷键

全局快捷键在 src/ui/use-terminal-controls.ts, 输入类快捷键在 input.tsx:

| 键                   | 行为                                                                                                 |
| -------------------- | ---------------------------------------------------------------------------------------------------- |
| Ctrl+C               | 有前台工作时单次按下中断 (用户命令优先于模型); 空闲时清空输入并提示, 2 秒内再按退出应用              |
| Esc                  | 先关补全菜单; 否则中断前台工作 (不影响后台任务和 teammate)                                           |
| Ctrl+O               | 切换工具输出/思考块/skill 卡片的完整与截断展示, 重印 transcript                                      |
| Ctrl+B               | 把运行中的前台 Bash/PowerShell 任务移到后台; 模态对话框占用键盘时禁用; tmux 下第一下被前缀键吃掉     |
| Ctrl+V               | 粘贴剪贴板图片 (Windows 是 Alt+V)                                                                    |
| Shift+Tab            | 循环 default → acceptEdits → bypassPermissions; plan 模式回到 default 并注入 plan 退出提醒           |
| ↑ / ↓                | 依次服务补全菜单、多行光标移动、历史导航; 输入最后一行按 ↓ 打开 Agents 列表, 空输入按 ↑ 弹回队列消息 |
| Shift+Enter / Ctrl+J | 换行                                                                                                 |
| Tab / Enter          | 补全菜单中选中当前项; Enter 其余情况提交                                                             |

「前台工作」由 `isForegroundBusy()` (src/ui/interrupt-scope.ts) 定义: 流式 agent 轮次、[上下文压缩](./context-compaction)、同步 subagent。后台 shell、后台 subagent 和 teammate 刻意不响应单次中断, 只在退出应用 (双击 Ctrl+C、/quit) 时随 `interruptAll()` 一并停止。任何键按下都会取消空闲状态的 2 秒退出窗口; 开始新工作会使未完成的退出提示失效

## 用户 Bash: ! 和 !!

主输入以 `!` 或 `!!` 开头时直接执行 Bash, 不经模型: 命令由用户显式输入, 不受 agent 权限模式 (含 plan) 约束 ([permission](./permission)); 已开启的 OS [sandbox](./sandbox) 仍然生效, 沙箱不可用时命令失败关闭、不执行。解析和执行逻辑与 remote server 共享 (src/conversation/user-bash.ts):

- `! git status`: 命令和结果**进入**下一次模型上下文 (以 `User executed Bash (<status>):` + 命令 + 输出的形式)
- `!! pnpm test`: **不进入**模型上下文, 重建上下文时也被排除; 卡片进度行分别标注 `User command · included/excluded in next model context`
- 命令是字面 shell 输入: `@` 引用、slash 命令、skill 都不展开; plan 反馈等其他入口不解释这些前缀
- 超时和后台: `!` 用 Bash 工具的 120 s 默认超时, 超时先尝试自动转后台而不是杀掉; `!!` 关闭超时 (`shellTimeoutDisabled`) 且不能后台 (`taskManager: null`)
- 结果预算: 输出去掉 ANSI 后内联保留最后 2000 行 / 50 KiB, 更大的全量写入 `~/.yukino/sessions/artifacts/<session-id>/tool-results/` 下的文件, 卡片显示尾部加文件路径
- 同时只能有一条用户命令, 重复提交显示警告; 可以和模型轮次并行跑。完成的结果先进 pending 队列, 等当前模型轮次或压缩结束后再写会话文件并追加进对话, 保住 tool_use/tool_result 配对
- 两种模式都持久化卡片, /resume 和 /rewind 会重放它们; `!` 命令可以 Ctrl+B 转后台, 成为普通的后台 shell 任务, 完成时和别的后台任务一样通过 task notification 进入模型上下文
- Esc / Ctrl+C 优先取消用户命令, 不影响模型和后台 agent; 输入框以 `!` 开头时边框切换为 bash 模式色

## Agents 列表

teammate spawn 卡片和后台 subagent 卡片随 transcript 滚动, 当前进度在 Agents 列表 (src/ui/agents-dialog.tsx, 标题 "Agents & tasks") 里查看, 前台 agent 流式期间也可以打开:

- 列表条目是 teammates (队名、状态、工具数、token 数) 和运行中的后台任务 (subagent、workflow、后台 Bash/PowerShell)
- Enter 打开详情: teammate 显示运行时长、轮次数、最近活动树和最后一条消息; 后台任务显示角色、轮次、活跃工具和输出尾部
- `k` 停止 (teammate 用 `stopMember`, 后台任务用 `stopAndWait`), `s` 向 teammate 发收尾退出请求, ← / Esc 返回上一级, Esc 关闭
- 列表变空自动关闭; 有条目时 status 区显示计数提示 ("N teammates · M background commands · ↓ on last input line to view"), 见 [agent-team](./agent-team)、[subagent](./subagent)

## Prompt 历史

输入历史持久化在 `~/.yukino/activity.jsonl` (src/history/index.ts): 每次提交记一条 JSONL (文本、cwd、sessionId、来源、slash 命令名), 上限 10,000 条, 滚动淘汰最旧; 累计追加 20,000 条后重写为单个 checkpoint。历史跨项目全局, 载入时去掉相邻重复项。↑/↓ 在补全菜单、多行输入可视行、历史之间按优先级切换: 进入历史时保留未发送草稿, ↓ 逐条回到草稿, 恢复草稿后再按 ↓ 打开 Agents 列表

## 退出摘要

退出 (双击 Ctrl+C、/quit) 时先中断前台、停掉后台任务和 teammates、断开 MCP 子进程, Ink 卸载后把交互摘要打印到 stdout (src/bootstrap/interaction-summary.ts 生成 Markdown, src/ui/interaction-summary.ts 渲染为两条横线之间的块):

- `### Session <session-id>` 标题
- **Tools**: 工具调用总数、✓ 成功、✗ 失败、成功率
- **Time**: wall (启动至退出) 与 active (agent 活跃时长); **Breakdown** 把 active 拆成 API 时间与工具时间两段占比
- **Tokens**: ↑ input / ↓ output; **Cache**: prompt cache 读/写量; **Cache hit**: cache 读取占 prompt token 的百分比
- 末尾给出 `yukino --resume <session-id>` 提示; 若已知有新版本, 摘要后追加新版本通知

## 版本检查与自更新

- TUI 启动时异步查询一次 npm 上 `@yukino.js/yukino` 的 latest dist-tag (10 s 超时), 有新版本就在 status 区提示 "New Yukino version vX is available. Run yukino update"; 检查失败 (网络错误等) 静默忽略、不打断 UI; 任何提交都会关掉这条提示
- `yukino update [--tag <tag>]` CLI 子命令 (src/update/): `getLatestVersion()` 查询 dist-tag 对应版本 (tag 需 URL 安全, 404/非 2xx 报错), `isNewerVersion()` 做 semver 比较 (含 prerelease 规则); 已是最新则直接打印并退出
- 升级命令由 `getSelfUpdateCommand()` 生成: 安装路径含 `.pnpm`/`pnpm` 视为 pnpm, 含 `.yarn`/`yarn` 视为 yarn, 否则 npm; 然后校验安装目录确实在该包管理器的全局根内 (`npm root -g` / `yarn global dir`), npm 全局布局还会从路径推断自定义 prefix 并附加 `--prefix`; 不在受管全局布局内的安装直接报错, 提示改用 install.sh / install.ps1
- 实际执行 `npm install -g @yukino.js/yukino@<精确版本> --registry=https://registry.npmjs.org/` (yarn 用 `global add`, pnpm 用 `install -g`); Windows 上整体包进 PowerShell 执行以保留参数并跑 .cmd 启动器
