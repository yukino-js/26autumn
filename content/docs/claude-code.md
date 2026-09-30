---
title: "Claude Code Best (CCB): Anthropic Claude Code 的开源复原工程调研"
description: "claude-code-best v2.8.4 逆向复原工程调研: 构建体系、核心循环、工具系统与多 Provider 兼容层"
---

本机器位置 $HOME/Downloads/claude-code

## 一、项目快照 (本机克隆 2026-09-29)

本机克隆 commit 77a7934e, 分支 main, clone 后无 pull 记录 (reflog 只有一条 clone 条目)。

| 指标       | 数值                                                                                                                         |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------- |
| npm 包名   | claude-code-best                                                                                                             |
| 版本       | 2.8.4 (package.json)                                                                                                         |
| 自我定位   | "Reverse-engineered Anthropic Claude Code CLI — interactive AI coding assistant in the terminal"                             |
| 可执行命令 | ccb / ccb-bun / claude-code-best, 入口 dist/cli-node.js 与 dist/cli-bun.js                                                   |
| 运行时     | Bun >= 1.3.0 (package.json engines; README 环境要求写 >= 1.3.11), 构建产物亦可用 Node.js 直接运行                            |
| 构建       | build.ts (Bun.build code splitting) 或 vite.config.ts (备选管线)                                                             |
| 语言工具   | TypeScript ^6.0.3, React 19, Biome 2.4.12, bun:test                                                                          |
| Workspaces | packages/_, packages/@ant/_, packages/@anthropic-ai/*                                                                        |
| 文档站     | ccb.agent-aura.top (Mintlify, 源码在 docs/ 目录), DeepWiki 有镜像                                                            |
| 社区       | Discord 群组; README 末尾声明 "本项目仅供学习研究用途, Claude Code 的所有权利归 Anthropic 所有"; 仓库根目录未见 LICENSE 文件 |

CCB 是社区对 Anthropic 官方 Claude Code CLI 的逆向复原项目 (CLAUDE.md 原文: "reverse-engineered / decompiled", 目标是 "restore core functionality while trimming secondary capabilities")。它声明完全兼容官方 CC 的配置文件, 用户不需要改原始配置, 并持续追平企业版/登录态特性, 同时关闭了所有外部封控点 (遥测上报类依赖保留空实现)。同生态还有作者推荐的 Peri Code (github.com/KonghaYao/peri) — 一个 Claude Code 兼容的 Rust Agent。

依赖清单本身就是信息量: dependencies/devDependencies 混排 (全部参与 bundle), 包含 @anthropic-ai/sdk ^0.81.0、bedrock-sdk、vertex-sdk、foundry-sdk、claude-agent-sdk、@modelcontextprotocol/sdk ^1.29.0、@agentclientprotocol/sdk ^0.19.0 (ACP)、openai ^6.34.0、google-auth-library、@azure/identity、AWS SDK、整套 OpenTelemetry (OTLP grpc/http/proto × traces/metrics/logs) + Prometheus exporter、@sentry/node、@growthbook/growthbook、@langfuse/otel + @langfuse/tracing、react 19 + react-reconciler、zod 4、commander、chokidar、execa、undici、marked、sharp、turndown、qrcode、fuse.js 等; optionalDependencies 有 doubaoime-asr (豆包语音识别, 给 Voice Mode 提供免 Anthropic OAuth 的方案)。

## 二、特性矩阵 (README 功能表整理)

| 特性                    | 说明                                                                                                                                                               | 源码位置                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------- |
| Goal 持续驱动           | /goal 设定目标后跨轮自动驱动 agent 直至完成; 带 token budget、completion/blocked audit、pause/resume/continue/clear 子命令, 网络中断自动暂停                       | src/commands/goal/, src/services/goal/    |
| Artifacts (HTML 上传)   | 复刻官方 Artifacts: 模型把 HTML/数据看板/报告上传到公开 URL (7d/30d 自动过期), /artifacts 集中管理; Cloudflare Worker + R2 完全开源可自托管                        | packages/cloud-artifacts/                 |
| Ultracode 多 Agent 编排 | /ultracode 注入 workflow 编排手册 + Workflow 工具跑确定性 JS 脚本 (agent/pipeline/parallel/phase) + /workflows 双栏监控; 支持 journal 重放、token budget、并发 cap | src/workflow/, packages/workflow-engine/  |
| 多实例协作 (Pipe IPC)   | 同机 main/sub 自动编排 + LAN 跨机零配置发现通讯, /pipes 选择面板 + Shift+Down 交互 + 消息广播路由                                                                  | (UDS_INBOX / LAN_PIPES feature, 默认关闭) |
| ACP 协议一等支持        | 接入 Zed、Cursor 等 IDE; 会话恢复、Skills、权限桥接                                                                                                                | src/services/acp/, packages/acp-link/     |
| Remote Control 私有部署 | Docker 自托管远程界面 (RCS), 支持手机端查看 CC                                                                                                                     | packages/remote-control-server/           |
| Langfuse 监控           | 企业级 Agent 监控, 观察每次 agent loop 细节, 一键转数据集                                                                                                          | @langfuse/* 依赖                          |
| Web Search              | 内置网页搜索, 支持 bing/brave                                                                                                                                      | src/commands/web-tools/                   |
| Poor Mode               | /poor 穷鬼模式: 关闭记忆提取与键入建议, 大幅减少并发请求                                                                                                           | src/commands/poor/                        |
| Channels 频道通知       | MCP 服务器推送外部消息到会话 (飞书/Slack/Discord/微信等), --channels plugin:name@marketplace 启用                                                                  | docs/features/channels                    |
| 自定义模型供应商        | /login 配置 OpenAI/Anthropic 兼容/Gemini/Grok                                                                                                                      | src/services/api/                         |
| Voice Mode              | 语音输入, /voice doubao 接豆包 ASR                                                                                                                                 | src/voice/, packages/audio-capture-napi/  |
| Computer Use            | 屏幕截图、键鼠控制                                                                                                                                                 | packages/@ant/computer-use-*              |
| Chrome Use              | 浏览器自动化、表单填写、数据抓取 (自托管 MCP 或原生版)                                                                                                             | packages/@ant/claude-for-chrome-mcp/      |
| Sentry / GrowthBook     | 企业级错误追踪 / 特性开关 (保留空实现)                                                                                                                             | (stubbed)                                 |
| /dream 记忆整理         | 自动整理和优化记忆文件                                                                                                                                             | src/services/autoDream/, src/memdir/      |

一个值得注意的事实差: README 把 Pipe IPC 群控列为卖点, 但 CLAUDE.md 的 Feature Flag 清单里 UDS_INBOX、LAN_PIPES 在 Build 默认 features 中标记为"已禁用", 需要环境变量显式开启; CONTEXT_COLLAPSE、FORK_SUBAGENT、REVIEW_ARTIFACT、TEAMMEM、SKILL_LEARNING 同样是默认关闭的。

## 三、运行时与构建

运行时是 Bun 而非 Node: 所有 import、构建、执行都走 Bun API; 产物经过 build.ts 后处理 import.meta.require, 所以 node dist/cli.js 也能跑 (package.json 同时提供 cli-node.js / cli-bun.js 两个 bin)。

构建要点 (CLAUDE.md "Runtime & Build" 一节):

- build.ts 执行 Bun.build() with splitting: true, 入口 src/entrypoints/cli.tsx, 输出 dist/cli.js + 大量 chunk 文件; 构建后自动复制 vendor/audio-capture/ 与 src/utils/vendor/ripgrep/ 到 dist/vendor/。README 说产物约 450 个 chunk, CLAUDE.md 说 600+, 两处口径不一, 以实际构建为准。
- 为什么必须代码分割: Bun/JSC 会全量解析单个大 JS 文件的 bytecode 和 JIT, 单文件 17MB 产物导致 RSS 暴涨到约 1GB; 分割后 Bun 按需加载, --version RSS 从 966MB 降到 35MB, 完整加载从 1GB+ 降到约 500MB。
- Vite 备选管线: vite.config.ts + scripts/post-build.ts, chunk 输出 dist/chunks/, post-build 对 globalThis.Bun 解构做 patch 并复制 vendor。
- Vendor 路径解析统一走 src/utils/distRoot.ts, 通过 import.meta.url 中 lastIndexOf('dist'|'src') 定位根目录。
- Dev mode: scripts/dev.ts 通过 Bun -d flag 注入 MACRO.* defines 运行 cli.tsx, 默认启用全部 feature; README 说开发模式看到版本号 888 即正确。
- Feature flag 机制: 代码统一 import { feature } from 'bun:bundle', feature('FLAG_NAME') 返回 boolean, 由环境变量 FEATURE_<FLAG_NAME>=1 启用。Build 默认 features 集中在 build.ts 的 DEFAULT_BUILD_FEATURES (CLAUDE.md 正文一处写 "19 个 feature", Feature Flag 一节又写 "65+ 个", 以后者与 build.ts 为准), Dev mode 全部启用。
- feature() 只能直接出现在 if 条件或三元表达式位置 (Bun 编译器限制), 不能赋值给变量或放进 && 链。
- Lint/Format: Biome 覆盖 src/、scripts/、packages/ (含 @ant), 42 条规则因 decompiled 代码被关闭仅保留 recommended 基线; .tsx 120 列 + 强制分号, 其他 80 列; husky + lint-staged 提交时自动 biome check --fix / format --write; CI 在类型检查前跑 bunx biome ci .。
- 质量闸门: bun run precheck = typecheck + lint fix + test, TypeScript strict 必须零错误, 这是 CLAUDE.md 反复强调的验收标准。

## 四、启动链与命令系统

入口 src/entrypoints/cli.tsx 的 main() 按优先级处理一批零/低开销快速路径, 命中才进完整 CLI:

- --version / -v: 零模块加载直接返回
- --dump-system-prompt (DUMP_SYSTEM_PROMPT flag)、--claude-in-chrome-mcp、--chrome-native-host、--computer-use-mcp (独立 MCP server 模式)
- --daemon-worker=<kind> (DAEMON flag)、daemon 子命令
- remote-control / rc / remote / sync / bridge (BRIDGE_MODE flag)
- ps / logs / attach / kill / --bg (BG_SESSIONS flag, 后台会话)
- new / list / reply (Template job 命令)、environment-runner / self-hosted-runner (BYOC runner)
- --tmux + --worktree 组合
- 默认路径: 加载 src/main.tsx 启动完整 CLI

src/main.tsx 约 5674 行, 用 Commander.js 注册大量子命令: mcp (serve/add/remove/list)、server、ssh、open、auth、plugin、agents、auto-mode、doctor、update 等; 主 .action() 负责权限、MCP、会话恢复与 REPL/Headless 模式分发。REPL 内部另有约 150 个斜杠命令入口 (src/commands/), 覆盖 goal、artifacts、workflows、pipes、buddy、bughunter、thinkback、torch、ultraplan、rewind、teleport、stickers 等长尾功能。

## 五、核心循环与 API 层

核心循环三件套 (CLAUDE.md "Core Loop"):

| 文件                 | 职责                                                                                                 |
| -------------------- | ---------------------------------------------------------------------------------------------------- |
| src/query.ts         | 主 API 查询函数: 发送消息、处理流式响应、执行工具调用、管理会话轮次循环                              |
| src/QueryEngine.ts   | 包裹 query() 的高层编排器: 会话状态、compaction、文件历史快照、attribution、轮次级记账; 被 REPL 使用 |
| src/screens/REPL.tsx | 交互式 REPL 屏幕 (React/Ink): 输入、消息展示、工具权限确认、快捷键                                   |

API 客户端 src/services/api/claude.ts 组装请求参数 (system prompt、messages、tools、betas) 调 Anthropic SDK 流式端点, 处理 BetaRawMessageStreamEvent 事件流。

共 7 个 provider: firstParty (Anthropic 直连)、bedrock (AWS)、vertex (GCP)、foundry、openai、gemini、grok (xAI)。选择逻辑在 src/utils/model/providers.ts, 优先级: modelType 参数 > 环境变量 > 默认 firstParty。

第三方 API 兼容层全部采用流适配器模式 — 把第三方协议格式转成 Anthropic 内部格式, 下游代码零改动:

- OpenAI 兼容: CLAUDE_CODE_USE_OPENAI=1, 支持 Ollama/DeepSeek/vLLM 等任意 Chat Completions 端点, 含 DeepSeek thinking mode; 环境变量 OPENAI_API_KEY / OPENAI_BASE_URL / OPENAI_MODEL (src/services/api/openai/)
- Gemini: CLAUDE_CODE_USE_GEMINI=1, GEMINI_API_KEY 必填; 模型映射优先级 GEMINI_MODEL > GEMINI_DEFAULT_SONNET_MODEL/GEMINI_DEFAULT_OPUS_MODEL > ANTROPIC_DEFAULT_*_MODEL (已废弃) > 原样返回 (src/services/api/gemini/)
- Grok: CLAUDE_CODE_USE_GROK=1, 自定义模型映射对接 xAI API (src/services/api/grok/)

首次配置走 REPL 内 /login, 支持 Anthropic Compatible (任意兼容 Messages API 的服务, 如 OpenRouter、Bedrock 代理)、OpenAI、Gemini 三类栏目, 字段为 Base URL / API Key / Haiku / Sonnet / Opus 模型 ID。

## 六、工具系统

- src/Tool.ts: Tool 接口定义与 findToolByName / toolMatchesName 等工具函数。
- src/tools.ts: 工具注册表, 从 @claude-code-best/builtin-tools 包导入组装; 部分工具按 feature() 或 process.env.USER_TYPE 条件加载。
- src/constants/tools.ts: CORE_TOOLS 白名单 (38 个核心工具名), 供 isDeferredTool 白名单判定 — 不在白名单里的工具走"延迟加载", 按需发现。
- packages/builtin-tools/src/tools/: 60 个工具目录 (含 shared/testing), 主要分类:
  - 文件操作: FileEditTool、FileReadTool、FileWriteTool、GlobTool、GrepTool
  - Shell/执行: BashTool、PowerShellTool、REPLTool
  - Agent 系统: AgentTool、TaskCreateTool、TaskUpdateTool、TaskListTool、TaskGetTool
  - 规划: EnterPlanModeTool、ExitPlanModeV2Tool、VerifyPlanExecutionTool
  - Web/MCP: WebFetchTool、WebSearchTool、MCPTool、McpAuthTool
  - 调度: CronCreateTool、CronDeleteTool、CronListTool
  - 延迟工具发现: SearchExtraToolsTool、ExecuteExtraTool、SyntheticOutput
  - 其他: LSPTool、ConfigTool、SkillTool、EnterWorktreeTool、ExitWorktreeTool 等

延迟工具的语义搜索由 src/services/searchExtraTools/ 的 TF-IDF 工具索引 (toolIndex.ts) 提供, 它复用 localSearch.ts 导出的 computeWeightedTf / computeIdf / cosineSimilarity; 工具预取与 skill 预取共用 extractQueryFromMessages 但各用独立的去重集合 (discoveredToolsThisSession)。这是从官方 Claude Code 复刻来的"工具太多就按需召回"的工程方案。

## 七、UI 层 (Ink)

- 终端渲染用 forked 的 Ink 框架, 位于 packages/@ant/ink/ (components、core、hooks、keybindings、theme、utils), 注意不是 src/ink/ (该目录不存在)。
- src/components/ 约 149 个组件: App.tsx 是根 provider (AppState、Stats、FpsMetrics); Messages.tsx / MessageRow.tsx 渲染会话; PromptInput/ 处理输入; permissions/ 是工具权限审批 UI; design-system/ 提供 Dialog、FuzzyPicker、ProgressBar、ThemeProvider 等复用件。
- 组件带 React Compiler 产物特征: 到处都是 const $ = _c(N) 记忆化样板 (decompiled output), 属正常现象。
- 老控制台兼容: packages/@ant/ink/src/core/legacyConsole.ts 检测 Windows build < 17763 (无 ConPTY 的老系统) 时自动启用, 渲染循环每约 1 秒 (LEGACY_CONSOLE_RESET_MS) 用一次全量重绘替换增量 diff, 自愈老 conhost 光标漂移花屏; CLAUDE_CODE_LEGACY_CONSOLE=1/0 可强制开关。
- 状态管理: src/state/AppState.tsx (中央状态类型 + context provider)、AppStateStore.ts (默认状态与 store 工厂)、store.ts (Zustand 风格 createStore)、selectors.ts; src/bootstrap/state.ts 提供模块级单例 (session ID、CWD、project root、token 计数、model override、client type、permission mode)。

调试方式 (README "VS Code 调试"): TUI 需要真实终端, 不能直接 launch, 用 attach 模式 — bun run dev:inspect 输出 ws://localhost:8888/xxx (BUN_INSPECT=9229 可换端口), VS Code F5 选 "Attach to Bun (TUI debug)"。

## 八、Monorepo Workspace 包

| 包                                  | 说明                                                                                                                        |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| packages/@ant/ink                   | Forked Ink 框架                                                                                                             |
| packages/@ant/computer-use-mcp      | Computer Use MCP server (截图/键鼠/剪贴板/应用管理)                                                                         |
| packages/@ant/computer-use-input    | 键鼠模拟 (dispatcher + darwin/win32/linux 后端)                                                                             |
| packages/@ant/computer-use-swift    | 截图 + 应用管理 (dispatcher + 平台后端)                                                                                     |
| packages/@ant/claude-for-chrome-mcp | Chrome 浏览器控制 (--chrome 启用)                                                                                           |
| packages/@ant/model-provider        | Model provider 抽象层                                                                                                       |
| packages/builtin-tools              | 内置工具集 (60 个工具实现)                                                                                                  |
| packages/agent-tools                | Agent 工具集                                                                                                                |
| packages/acp-link                   | ACP 代理服务器 (WebSocket → ACP agent 桥接)                                                                                 |
| packages/mcp-client                 | MCP 客户端库                                                                                                                |
| packages/remote-control-server      | 自托管 RCS (Docker 部署, React 19 + Vite + Radix UI Web 控制台, 支持 ACP agent 接入)                                        |
| packages/cloud-artifacts            | Cloudflare Worker + R2 的 HTML Artifacts 托管服务 (独立部署, 不被主 CLI import)                                             |
| packages/audio-capture-napi         | 原生音频捕获 (已恢复)                                                                                                       |
| packages/color-diff-napi            | 颜色差异计算 (完整实现, 11 tests)                                                                                           |
| packages/image-processor-napi       | 图像处理 (已恢复)                                                                                                           |
| packages/modifiers-napi             | 键盘修饰键检测 (macOS FFI)                                                                                                  |
| packages/url-handler-napi           | URL scheme 处理                                                                                                             |
| packages/weixin                     | 微信集成                                                                                                                    |
| packages/workflow-engine            | 多 agent 工作流的确定性 JS 脚本编排引擎 (Ultracode 的 Workflow 工具底座); 零核心层运行时依赖, 通过 port adapters 与外界交互 |

辅助目录 (无 package.json, 非 workspace 包): langfuse-dashboard、shared-web-ui、highlight-code、claude-pencil、vscode-ide-bridge、pokemon。

## 九、平台化能力: ACP、Daemon、Bridge、Artifacts

ACP (Agent Client Protocol): src/services/acp/ 实现 ACP agent (agent.ts 的 AcpAgent 类、bridge.ts 的 Claude Code ↔ ACP 桥接、permissions.ts、entry.ts); packages/acp-link 提供独立 CLI 把 WebSocket 客户端桥接到 ACP agent, 支持自定义端口/HTTPS/认证/会话管理与 RCS 集成 (REST 注册 + WS identify 两步流程)。权限管道统一为 createAcpCanUseTool, applySessionMode 同步模式, bypassPermissions 可用性检测 (非 root/sandbox 环境); Plan 可视化支持 session/update plan 消息 (PlanView 组件, 进度条/状态图标/优先级标签)。

Daemon 模式: src/daemon/ (main.ts + workerRegistry.ts), DAEMON flag 门控, 长驻 supervisor 管理 worker。

Bridge / Remote Control: src/bridge/ (BRIDGE_MODE flag), 含 bridge API、会话管理、JWT 认证、消息传输、权限回调, 入口 bridgeMain.ts。自托管 RCS 支持 ACP agent 经 acp-link 接入 (ACP WebSocket handler、relay handler、SSE event stream), bun run rcs 启动; 官方托管版 remote-control.claude-code-best.win, 也可 CLAUDE_BRIDGE_BASE_URL=... CLAUDE_BRIDGE_OAUTH_TOKEN=... ccb --remote-control 指向自部署。

Cloud Artifacts 托管: Cloudflare Worker 处理 POST /upload (Bearer token 鉴权 + text/html 校验 + 10MB 上限 + ttl ∈ {7,30}) 与 GET /<7d|30d>/<id>.html (从 R2 读 + Cache-Control max-age=86400); TTL 由 R2 prefix + lifecycle rule 实现, Worker 不参与过期; ID 默认 nanoid(21) (126 bit 熵), ?hash= 可自定义 (覆盖语义: 先删旧 key 再写新 key); 生产出口经 Deno Deploy 边缘代理, 副作用是 HTTP status 被抹平为 200 (错误信息保留在 body error 字段)。部署: npm create cloudflare@latest + bun run setup + bun run deploy。

## 十、测试与工程纪律

- 框架 bun:test; 单元测试就近放 src/**/**tests**/; tests/integration/ 有 6 个集成测试文件 (cli-arguments、context-build、message-pipeline、tool-chain、autonomy-lifecycle-user-flow、dependency-overrides); tests/mocks/ 共享 fixture。
- Mock 规范很严格: 只 mock 有副作用的依赖链, 不 mock 纯函数; log.ts / debug.ts 必须用 tests/mocks/ 下的共享 mock。
- 关键陷阱: Bun 的 mock.module 是进程全局的 (last-write-wins), 一个测试文件的 mock 会污染同进程所有其他文件的 require/import; 测试执行顺序不保证字母序。核心规则是"不要 mock 被测模块的上层业务模块" — 集成测试 (launch*.test.ts) 应 mock axios 而非源 API 模块, 保证同目录 api.test.ts 能测到真实 HTTP 逻辑。
- 类型纪律: 生产代码禁止 as any; 优先 as unknown as SpecificType 双重断言或补 interface; 未知结构用 Record<string, unknown>; 联合类型用类型守卫收窄。
- CI: ci.yml (biome ci + 构建 + 测试)、release-rcs.yml、update-contributors.yml (自动更新贡献者图)。
- 提交规范: Conventional Commits (feat/fix/docs/chore/refactor)。
- 其他工具: knip 查未用导出 (check:unused)、health-check 脚本、scripts/rcs.ts 启动 RCS。

## 十一、上下文与设计

上下文构建: src/context.ts 组装 system/user context (git status、日期、CLAUDE.md 内容、memory 文件); src/utils/claudemd.ts 按项目层级发现并加载 CLAUDE.md。穷鬼模式 /poor 持久化到 settings.json, 启用后跳过 extract_memories、prompt_suggestion、verification_agent 以减少 token 消耗 (src/commands/poor/poorMode.ts)。

Stubbed/Deleted 模块状态 (CLAUDE.md 表格): Computer Use (@ant/*) 已恢复但各平台后端完整度不一; 全部 *-napi 包已恢复/实现; Voice Mode 已恢复 (Push-to-Talk); OpenAI/Gemini/Grok 兼容层已恢复; RCS 已恢复; packages/shell、packages/swarm、packages/mcp-server、packages/cc-knowledge 已删除 (功能合并或废弃); Analytics/GrowthBook/Sentry 为空实现; Magic Docs 与 LSP Server 管理器已恢复; Plugins/Marketplace 已恢复; MCP OAuth 做了简化。

设计上下文保存在 .impeccable.md: 五条原则 (Considered over clever、Warmth through subtlety、Density with clarity、Community voice、Anthropic's shadow); 品牌色 Claude Orange #D77757 与 Claude Blue #5769F7; 暗色模式用温暖深色表面; 明确避免 AI 产品常见套路 (渐变文字、玻璃态、霓虹色)。

## 十二、学习与上手项目本身

仓库自带学习入口 teach-me (改造自 sanyuan0704/sanyuan-skills 的 sigma skill): REPL 内 /teach-me <主题> [--level beginner] [--resume], 能力包括诊断水平、把主题拆成 5-15 个原子概念按依赖排序、苏格拉底式提问、错误概念追踪、断点续学; 学习进度存 .claude/skills/teach-me/, 支持跨主题学习者档案。

日常命令速查: bun install; bun run dev; bun run build; echo "say hello" | bun run src/entrypoints/cli.tsx -p (pipe/headless 模式); bun test [file] [--coverage]; bun run precheck (任务完成后必跑); bun run rcs; bun run docs:dev (Mintlify)。

## 十三、小结: 值得借鉴的工程点

1. Bun 大型 CLI 必须代码分割 — 这是被 RSS 数据 (966MB → 35MB) 验证过的硬约束, 不是风格偏好。
2. feature('FLAG') 编译期 flag + FEATURE_* 环境变量, 让复原项目可以按构建裁剪功能面, 同时保留全部代码路径。
3. 第三方 API 兼容统一走流适配器模式, 把异构协议收敛到内部格式, 下游零改动。
4. 工具数量膨胀后用 CORE_TOOLS 白名单 + TF-IDF 延迟发现, 而不是全量注册。
5. mock.module 进程全局污染的应对纪律 (共享 mock、只 mock 底层 HTTP、不 mock 上层业务模块) 是 Bun 测试生态里少见的系统性总结。
6. 逆向项目的诚实标注: CLAUDE.md 明确哪些模块 restored、哪些 stubbed、哪些 deleted, 对二次开发者是可靠的地图。
