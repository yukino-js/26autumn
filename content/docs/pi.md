---
title: "Pi Agent Harness 调研: 极简内核、可扩展资源体系与 TypeScript SDK"
description: "pi-coding-agent 调研: 极简内核、树形会话模型、TypeScript SDK 与 durable 运行时 (Package 1-23, 含实验性 durable TUI coding agent)"
---

本机克隆位于 $HOME/Downloads/pi, 调研重点为 packages/coding-agent

## 一、项目快照 (本机克隆 2026-10-02)

本机克隆 HEAD 为 88ff80b986e34d4fbd1fa94a4df65c60ae964516 (2026-10-01 17:26 +0200), 分支 main; npm 主包 @earendil-works/pi-coding-agent 0.99.2。近期提交窗口的活跃主线: pi-durable 运行时 (Package 1~23 全部落地, SQLite 存储全面异步化, 两个使用者 — 实验性 TUI coding agent 与实验性 client/server)、fullscreen 成为默认 TUI 模式 (88ff80b)、Radius 升为一等 provider (ed8b3bc + c2f65d8)、codemode 的 models.generateImages() (aab34df)、MCP OAuth 与官方 conformance 基线持续加固 (d850ede/e529a82/a4715ec)、Anthropic workload identity federation (a9424cd)。详见正文各节。

| 指标      | 数值                                                                                                                       |
| --------- | -------------------------------------------------------------------------------------------------------------------------- |
| 定位      | Pi Agent Harness — 终端里的可扩展 AI agent, 自称 "self extensible coding agent"                                            |
| 主 npm 包 | @earendil-works/pi-coding-agent 0.99.2 (2026-09-30 发布; bin: pi → dist/bundle/cli.js)                                     |
| 作者      | Mario Zechner (packages/coding-agent/package.json)                                                                         |
| 组织      | earendil-works; 官网 pi.dev; 长期规划走 RFC (rfc.earendil.com/keyword/pi/)                                                 |
| License   | MIT                                                                                                                        |
| 运行时    | Node >= 22.19.0; 仓库 devDependencies: TypeScript 7.0.2、esbuild 0.28.2、Biome 2.3.5、@anthropic-ai/sandbox-runtime 0.0.26 |
| Monorepo  | npm workspaces (packages/* 加五个自带依赖的示例扩展), 根版本号 0.0.3 仅占位                                                |
| 配置目录  | 项目级 .pi (package.json 的 piConfig.configDir), 用户级 ~/.pi/agent/                                                       |
| 安装      | npm install -g --ignore-scripts @earendil-works/pi-coding-agent 或 curl -fsSL https://pi.dev/install.sh \| sh              |

产品哲学写在 CONTRIBUTING.md 第一句: "pi's core is minimal" — 不属于内核的功能一律做成扩展, 膨胀内核的 PR 会被拒。README 副标题是 "Adapt Pi to your workflow, not the other way around": 让用户指挥 Pi 自己生成 prompt 模板、skill、扩展和主题, 或安装现成的 Pi package。

社区治理相当硬核: 新贡献者的 issue 和 PR 默认自动关闭, 维护者每天复查自动关闭的 issue 并重开有价值的; 维护者在回复里用 lgtmi (今后 issue 不再自动关) / lgtm (issue 和 PR 都不再自动关) 授权; 周五到周日的 issue 不保证被看; 用自动化脚本刷 issue 的账号会被永久 block。issue 质量要求: 必须用模板、一屏以内、自己的话写 (用 LLM 生成必须追加明确标注的说明)。CONTRIBUTING.md 还有一句原则: "You must understand your code" — 用 AI 写代码可以, 提交不理解的 AI 生成代码不行。

供应链加固是 README 的独立章节, 值得整段抄: 直接外部依赖全部钉精确版本; .npmrc 设 save-exact=true 与 min-release-age=2 (拒绝发布不满 2 天的包, 防投毒窗口); package-lock.json 是依赖事实源, pre-commit 默认拦截 lockfile 提交 (需 PI_ALLOW_LOCKFILE_CHANGE=1 显式放行); 发布的 CLI 包附带由根 lockfile 生成的 npm-shrinkwrap.json 钉死传递依赖; 本地发布安装、文档安装命令与 pi update --self 全部 --ignore-scripts; CI 用 npm ci --ignore-scripts 并有定时任务跑 npm audit --omit=dev 与 npm audit signatures; 依赖 lifecycle script 需走显式 allowlist, 新出现未审查的直接 fail。

## 二、Monorepo 包结构

packages/ 下 13 个目录, 构建顺序 (根 package.json 的 build 脚本链) 即依赖序: chord → tui → telemetry → codemode → mcp → ai → durable → agent → protocol → client → server → coding-agent。SQLite 存储由 pi-durable 自带的可移植 facade 承担 (packages/durable/src/storage/sqlite/, 另有 jsonl 与 memory 两个后端)。

| 包                                | npm 名                          | 职责 (README 与 package.json 描述)                             |
| --------------------------------- | ------------------------------- | -------------------------------------------------------------- |
| packages/chord                    | @earendil-works/chord           | 独立的应用组合运行时: 服务、复制状态、RPC、插件                |
| packages/tui                      | @earendil-works/pi-tui          | 终端 UI 库, 差分渲染 (differential rendering)                  |
| packages/telemetry                | @earendil-works/pi-telemetry    | 供应商中立的遥测契约 + 参考适配器 + 一致性测试 + 类型化 schema |
| packages/codemode                 | @earendil-works/pi-codemode     | 沙箱 JavaScript 执行, "唯一能力是调用注入的工具"               |
| packages/mcp                      | @earendil-works/pi-mcp          | MCP 支持                                                       |
| packages/ai                       | @earendil-works/pi-ai           | 统一多供应商 LLM API (OpenAI、Anthropic、Google 等)            |
| packages/durable                  | @earendil-works/pi-durable      | 持久化会话、任务与文档运行时 (Experimental, 见下文)            |
| packages/agent                    | @earendil-works/pi-agent-core   | 通用 agent: transport 抽象、状态管理与 attachment (自述描述)   |
| packages/protocol, client, server | @earendil-works/pi-*            | RPC 协议、客户端、服务器                                       |
| packages/coding-agent             | @earendil-works/pi-coding-agent | 交互式 coding agent CLI (本文重点)                             |
| packages/evals                    | @earendil-works/pi-evals        | 评测                                                           |

durable 值得单独展开: packages/durable (自标 Experimental, API 随版本变动不另行通知) 是一个 durable agent harness — 会话、模型轮次、工具调用与自定义状态先落盘再展示, 进程在轮次中途死掉后重开存储即可从中断点续跑; 它构建在 pi-ai (模型访问) 与 chord (文档状态) 之上。实现按 docs/pico-v5.md (规范性) 与 pico-v5-handoff.md 的工作包清单推进, Package 1~23 已全部落地 (Package 10 由 Chord 的结构 diff 实现天然满足)。Package 20 是 compaction 与 overflow (b72cf98 规范 + ed0d6b9 实现, 2026-09-30 合入): 手动 compact() 以任务形态运行, 可附指令、可被 abort() 取消, 摘要是一条带头的 pi.compaction entry, "持有它保留的第一条 entry", 更老的 entry 仍留在存储里 — 与 coding-agent 一样, 压缩是视图不是存储; 自动压缩按会话用 setCompaction({ enabled, reserveTokens, keepRecentTokens, backgroundTokens }) 配置, 低于 backgroundTokens 阈值在后台启动, 超过 contextWindow - reserveTokens 时下一次请求同步等待压缩; provider 以"上下文过长"拒绝请求时触发 overflow 压缩并重试一次; 多个摘要并发时由 stale 规则裁决 — 会切到当前上下文开始之前的摘要在放置时落为 stale, 切得最远的生效; 运行中的压缩暴露在 docs["pi.live"].compactions (含原因、尝试次数与重试退避), agent 事件面新增 compaction_start / compaction_end 与快照的 compactions 字段, 摘要开销计入 pi.usage, beforeCompact hook 可拒绝或自供摘要。

Package 21~23 三个工作包的内容: Package 21 (4bae867 规范 + b56702a 实现) 把注册面换成命名扩展注册表: registry.install(extension) / uninstall() 统一接管 tools、hooks、tasks、system prompt section、conversation 文档与各类 wrapper 的注册, 扩展用 defineExtension() / defineTool() / section() / hook() / wrapTool() / wrapSection() 构建; per-conversation 的 pi.conversation.config 文档换成可回退的 pi.agent 文档 (model、thinking level、扩展与工具选择、instructions、cwd), 经 Conversation.agent() / configure() 读写, task 拥有的会话复制 owner 的 agent; 流式、重试、压缩策略与队列模式收进 Harness 级 HarnessOptions.settings, 每次使用时读取; 随包落地 CodingTools 扩展 (@earendil-works/pi-durable/tools, read、write、edit、bash)。Package 22 (5b5ccdd 规范 + 49683a3 实现) 是 lifecycle conformance: runtime.now() / report() 在 invocation 结束后抛错, 只做文档迁移的 commit 也会发布新值, Harness.open() 失败时不借调用方 context 关闭 Session 并重抛原始错误。Package 23 (同一对规范+实现 commit) 是 task graph view: Harness.taskGraph() 与 watchTaskGraph() 把每个活任务挂成 Chord 状态或 watch (owner 边、已提交状态、background/abort 标记、拥有的会话), 随 commit 推进。storage/sqlite 的可移植 SQLite facade 是全面异步化的 (f3e68e8, PR #10232): SqliteDatabase 继承 SqliteExecutor (exec / run / get / all 按 SQL 文本执行, 语句按连接缓存), 无 prepare / SqliteStatement, transaction 回调接收事务句柄, close() 返回 Promise — 自定义 adapter 需按这套接口编写。

durable harness 的第一个使用者是实验性 TUI coding agent (packages/coding-agent/src/experimental/durable/, 5609b0d 落地, 70c0362 起 task 面板默认显示)。单进程同时持有 pi 的 model runtime、durable Harness、其 SQLite 存储与 TUI, 复用 pi 的认证、settings、system prompt、键位、主题与交互组件, agent 本体就是 Harness 加内置 CodingTools; 流式、工具、steer/follow-up、abort、模型与 thinking 切换、compaction 均可用, --continue 打开当前目录最新会话并续跑被中断的轮次 (中断的工具调用获得 interrupted 结果, 该轮次继续走完)。subagent 工具在子会话里跑任务, /agents 切换到任意会话的视图 (subagent 忙时也可 steer), /tasks 面板实时渲染 task graph。会话存于 ~/.pi/agent/experimental/durable-sessions/<cwd-hash>/<session>/session.sqlite, 锁阻止第二个进程 (崩溃残留的锁 10 秒后失效)。设计信号很明确: TUI 本身不做任何恢复处理, 只渲染 Conversation.viewState() 的结构化视图 — 持久化与中断恢复全部下压到 harness。README 自述尚未覆盖: 会话列表与 resume picker、fork 与树导航、扩展、prompt 模板、图片、/login。入口是源码直跑 (node --import source-resolver.ts packages/coding-agent/src/experimental/durable/main.ts), 没有独立 npm bin。

Slack/聊天自动化在另一个仓库 earendil-works/pi-chat。会话共享生态: badlogic/pi-share-hf 把 Pi 会话发布到 Hugging Face 数据集 (作者自己的 pi-mono 工作会话定期公开在 badlogicgames/pi-mono), 主张"真实 OSS 会话数据比玩具 benchmark 更能改进 coding agent"。

durable harness 的第二个使用者是实验性 client/server (48dd1e2), 构建在 pi-durable 之上。形态是 server/worker/presentation 三段 (src/experimental/ 的 server.ts、session-worker.ts、client.ts、client-tui.ts 与 services/ 切片, 设计记录在 src/experimental/services/README.md): server 把每个 Session 存放在会话目录下的独立子目录 (meta.json + session.sqlite, 后者即 @earendil-works/pi-durable 存储), Session worker 锁住目录、打开存储、持有 Harness 直到退役; presentation 端通过 AgentController (README 原话: "presentation-safe facade over the root durable conversation") 驱动 worker 侧的根会话, Transcript 服务直接提供 Conversation.viewState(), 由 Chord 负责副本的 hydration、定序与缺口检测。服务目录按 facet 提供物生成, 没有手写的内置服务清单; 传输在 unix socket 之外加了 radius://<uuid> 地址形态 (cli/experimental/command-options.ts), 远程接入经 Radius relay (experimental/radius-relay.ts), 认证要求先 /login radius。pi-agent-core 本身只保留通用 agent 内核 (package.json 自述 "General-purpose agent with transport abstraction, state management, and attachment support", 7fd478a); services/README 的 TODO 清单记录了四项未完成事项: 树导航 (需 fork + 摘要 entry)、next-run 队列、subagent 会话暴露、transcript 历史分页。

## 三、工作原理 (packages/coding-agent/docs/how-pi-works.md)

会话模型是树而不是列表: session 里的消息与事件构成一棵树, 每条路径是一个分支, 以当前 entry 结尾的分支是 active branch, 为下一次模型请求提供历史。从更早的 entry 继续会在同一文件里长出新分支; fork/clone 则把选中历史拷进新 session 文件。持久化 session 是 JSONL 文件, 每个树 entry 有 ID 并指向 parent。

Agent loop: 提交的消息加入 active branch → 用 system prompt + active branch + 可用工具 + 模型设置组装请求 → 选定 provider 流式返回 → 记录响应 (文本与工具调用) → 逐个执行工具调用并记录结果, 这算一个 turn → 若工具结果或排队消息还需要模型请求就再来一轮, 否则 run 结束。三种输入的语义分得很清: steering 消息在当前 assistant turn 之后插入; follow-up 在 agent 做完 pending 工作后进入; abort 停止当前 run 并把排队消息退回编辑器。

上下文组装: active branch 的 session entries 转成模型兼容的 user/assistant/tool-result 消息; system prompt 由基础指令 + 发现的 context files 构成; 请求携带工具定义与 skill 描述, skill 的完整指令按需加载; 扩展可以追加指令或变换上下文; prompt 模板在编辑器输入变成 user 消息前展开; 选中文件、图片、粘贴文本、shell 输出都可以成为消息内容。

Compaction: 插入一条 summary entry, 在后续模型请求中替换更老的消息, 但原始 entries 保留在会话树里 — 压缩是有损视图, 不是有损存储。

接口形态五种, 共用同一套 agent 与 session 机制: interactive (终端 TUI)、print (跑一个 prompt 输出最终回复)、JSON (agent 事件按 JSONL 输出)、RPC (stdin 收 JSONL 命令, stdout 回响应与事件)、TypeScript SDK (进程内直接创建与控制会话)。

信任模型: 项目 trust 在加载项目设置与资源之前解析; trust 决定与项目资源加载完成后才加载 context files; 启用的工具使用 Pi 进程的操作系统权限, 扩展就在该进程内执行 — 没有内置沙箱 (详见第八节)。

## 四、coding-agent 源码结构

src/ 顶层: cli.ts / main.ts / rpc-entry.ts / index.ts / package-manager-cli.ts / config.ts / migrations.ts, 加 cli/、core/、modes/、extensions/、client/、experimental/、bun/、utils/。

- src/cli/: 启动期职责拆分 — args.ts、auth-check.ts / auth-command.ts、project-trust.ts、session-picker.ts、config-selector.ts、startup-ui.ts、file-processor.ts、list-models.ts 等。
- src/modes/: interactive/ (TUI)、print-mode.ts、json-event.ts、rpc/ — 对应四种运行形态; package.json 的 exports 里 ./rpc-entry 单独出口, ./client 与 ./experimental/plugin 以 source 形式导出。
- src/core/: 约 55 个模块, 是内核所在 — agent-session.ts / agent-session-runtime.ts / agent-session-services.ts、session-manager.ts、settings-manager.ts、model-registry.ts / model-resolver.ts / model-runtime.ts / models-store.ts / virtual-models.ts / remote-catalog-provider.ts、resource-loader.ts、skills.ts、prompt-templates.ts、slash-commands.ts、system-prompt.ts、trust-manager.ts / project-trust.ts、mcp-servers.ts、package-manager.ts、telemetry.ts、cache-warmer.ts / cache-stats.ts、compaction/、export-html/、event-bus.ts、bash-executor.ts / exec.ts、http-dispatcher.ts、output-guard.ts、nested-tool-calls.ts、radius.ts、usage-totals.ts、crash-log.ts / bug-report.ts / bug-report-upload.ts、sdk.ts 等。
- src/extensions/: 四个内置扩展 — codemode、tool-search、mcp、llama (llama.cpp 本地模型, 配套 docs/llama-cpp.md)。

内置工具在 src/core/tools/: bash.ts、powershell.ts、read.ts、edit.ts (+edit-diff.ts)、write.ts、find.ts、grep.ts、ls.ts, 配套 file-mutation-queue.ts (文件变更串行化)、output-accumulator.ts、truncate.ts、path-utils.ts、renderers/。package.json 的自我描述 "Coding agent CLI with read, bash, edit, write tools and session management" 是最小集, 实际工具面更宽。

构建与分发: npm 包走 tsc (tsconfig.build.json) + esbuild bundle (scripts/build-coding-agent-bundle.mjs) 产出 dist/bundle/cli.js; build:binary 用 bun build --compile 打独立二进制 dist/pi, 并把 photon_rs_bg.wasm (@silvia-odwyer/photon-node, 图像缩放 worker)、主题 JSON、PNG 素材、export-html 模板一起拷进产物; GitHub Release 附带版本化源码归档 + SHA256SUMS, scripts/build-binaries.sh --offline-model-data 可从源码归档复现官方独立二进制。资源路径统一走 src/config.ts 的 helper (AGENTS.md 禁止直接用 __dirname, helper 同时兼容源码 checkout、npm 安装与独立二进制三种形态)。

代码风格硬约束 (根 AGENTS.md): 只用可擦除的 TypeScript 语法 (Node strip-only 模式) — 禁 enum、namespace、parameter properties、import =/export = 等需要 JS emit 的构造; 禁止内联 import (await import() 等), 只允许顶层 import; 非必要不写 any; 键位不许硬编码, 必须进 DEFAULT_EDITOR_KEYBINDINGS / DEFAULT_APP_KEYBINDINGS 保持可配置; packages/ai/src/models.generated.ts 不许手改, 改 scripts/generate-models.ts 后重新生成。多会话并发开发纪律: 同一 cwd 可能同时跑着多个 pi 会话, git 只允许 stage 自己改过的显式路径, 禁 git add -A / reset --hard / checkout . / clean -fd / stash / --no-verify / force push, commit message 格式 {feat,fix,docs}[(ai,tui,agent,coding-agent)]: ...。

## 五、TypeScript SDK

docs/sdk.md: @earendil-works/pi-coding-agent 可以直接作为库嵌入 Node.js 或 Bun 进程, 拿到 CLI 同款的 agent、session、工具、模型与资源。

```typescript
import { createAgentSession } from "@earendil-works/pi-coding-agent";

const { session } = await createAgentSession();
try {
  await session.prompt("What files are in the current directory?");
  console.log(session.getLastAssistantText());
} finally {
  session.dispose();
}
```

要点整理:

- AgentSession 拥有一个会话及其模型、工具、排队消息、compaction 状态与扩展运行时; 只读状态: session.messages / model / thinkingLevel / systemPrompt / getActiveToolNames()。
- SessionManager 持有持久化或内存 entry 树并跟踪 active leaf; 分支只改 leaf 不删废弃分支; 它是"最终模型上下文"的唯一权威 — 直接给 session.agent.state.messages 赋值不能替换持久化上下文, 恢复外部历史要构造带这些 entries 的 manager; SessionManager.inMemory() 用于不落盘场景。
- AgentSessionRuntime 提供 newSession() / switchSession() / fork() / importFromJsonl(), 每次替换活跃 AgentSession 并为目标工作目录重建服务; 替换后旧订阅失效需重绑。
- prompt() 先处理扩展命令、展开基于文件的 prompt 模板, 再让普通用户消息进 agent; 对已接受的 run, promise 在 run (含自动重试) 结束后 resolve。会话流式期间再发 prompt 必须显式选择 steer 还是 follow-up, 不选直接 reject 而不是猜; steer()/followUp() 返回 "queued" 或 "handled" (被扩展消费)。abort() 停止并等 idle, waitForIdle() 只等不停。
- 事件订阅: session.subscribe 收到 message_update (assistantMessageEvent.text_delta 增量)、message_end (权威的完整消息)、agent_end (一次底层 run 结束, 后面可能还有自动恢复或排队工作) 与 agent_settled (Pi 确定不再自动继续) 等。
- 依赖注入面: createAgentSession 的每个默认件都可显式替换 — modelRuntime/model/thinkingLevel/scopedModels、settingsManager、sessionManager、resourceLoader、tools/noTools/excludeTools/customTools; DefaultResourceLoader 支持标准发现 + 定点覆盖, 完全自管资源则传自定义 ResourceLoader。
- 内置扩展语义: CLI 默认加载 codemode、tool_search、MCP 三个 built-in 扩展, SDK 会话不加载, 需要时把 createCodemodeExtension() / createToolSearchExtension() / createMcpExtension() 加进 DefaultResourceLoader 的 extensionFactories; codemode 与 tool_search 注册为非活跃, 通过 defaultTools 设置 (["+codemode", "+tool_search"]) 或 MCP server 的 exposure (codemode / deferred) 激活; MCP 扩展在 session_start 时连接 server, 所以要调 session.bindExtensions()。自 e029c3e 起这个连接不再阻塞首个 prompt: 只等待带 direct 工具的 server (默认上限 10 秒), 其余 server 后台连接, codemode 脚本、tool_search 与 resource 工具在真正用到时按需等待; MCP 工具注册名为 mcp__<server>__<tool>, 自 b29db89 起名字中的连字符统一为下划线以与 codemode 标识符对齐 (冲突时加哈希后缀, 仅连字符/下划线之差的 server 名会被拒绝)。tool_search 的工具加载现在走 active tool set 并记录进 transcript, 因此像其他工具变更一样在该分支的 /tree、resume 与 fork 后存活 (c662ec7; extensions/tool-search/tool.ts 头注释) — 延迟发现的 MCP 工具不再因会话恢复或 reload 而丢失声明。命名 inline 扩展可标 replaceable: true — 当别的扩展注册了同名工具/命令/flag 时自动让位而非冲突。
- examples/sdk/ 下 14 个示例 (01-minimal 到 14-codemode-mcp) 全部随仓库 typecheck。
- MCP 认证面持续加固: v0.99.2 已发布 oauth.clientName (改变 OAuth 客户端注册时发送的 client name, 面向只接受已知客户端的 server) 与 `"auth": { "provider": "<provider>" }` (HTTP server 直接把该 provider 当前 /login 令牌作为 bearer 发送, 每次请求实时读取、provider 刷新即生效, 不复制进 mcp-auth.json; 仅允许全局 mcp.json 与扩展注册, 除 loopback 主机外要求 https, 91f9f3b)。0.99.2 之后的主线又加入: oauth.authServerMetadataUrl 配置 (d850ede, server 通告错误或没有通告授权服务器时, 以配置的元数据文档取代 RFC 9728/8414 发现) 、授权码交换前校验授权响应的 iss 参数 (RFC 9207, 指向别的授权服务器的响应在交换前被拒) 、step-up 授权请求已授予与缺失 scope 的并集 (e529a82, insufficient_scope 重新登录后新令牌不再丢失既有权限, SEP-2350) 。

## 六、扩展与资源生态

扩展是加载进 Pi 进程的 TypeScript 模块, 工厂函数可注册工具、命令、快捷键、provider、事件处理器、渲染器与终端 UI (how-pi-works.md)。资源体系五层, quickstart.md 给了一张"从最弱机制开始"的选择表: 文件夹级持久指令用 AGENTS.md; 复用 / 菜单里的 prompt 用 prompt template; 任务专属指令 + 附件用 skill; 可执行的工具/命令/事件处理用 extension; 自定义终端组件用 Terminal UI; 接未支持的模型服务用 custom provider; 打包分发多种资源用 Pi package (npm 或 git 分发)。

仓库自带 80+ 个示例扩展 (packages/coding-agent/examples/extensions/), 大致三类:

- 工程流程: auto-commit-on-exit、git-checkpoint、git-merge-and-resolve、dirty-repo-guard、protected-paths、permission-gate、confirm-destructive、timed-confirm、plan-mode、subagent、handoff、todo、structured-output、tool-override、dynamic-tools、custom-compaction、trigger-compact、reload-runtime 等;
- Provider 与基础设施: custom-provider-anthropic、custom-provider-gitlab-duo、debug-provider、provider-payload、sandbox、gondolin、ssh、with-deps、rpc-demo、event-bus、mcp 相关;
- 界面与娱乐: snake、space-invaders、tic-tac-toe、doom-overlay、rainbow-editor、custom-header/footer、status-line、titlebar-spinner、overlay-test 等 — 用游戏验证 TUI 扩展能力的边界。

codemode 是最特别的内置扩展: @earendil-works/pi-codemode 的定位是"沙箱 JavaScript 执行, 唯一能力是调用注入的工具", coding-agent 依赖 quickjs-wasi 3.6.2, 即 QuickJS 编译到 WASI 做隔离; 配套 scripts/smoke-test-codemode-binary.mjs 与 src/extensions/codemode/worker.ts。这与其他家"code mode / 用代码代替连续工具调用"的思路一致: 让模型写一段 JS 批量编排工具, 而不是每个动作一轮对话。codemode 脚本的 models 绑定含 models.generateImages() (aab34df): extensions/codemode/tool.ts:61 把 generateImages 纳入 models 能力面, execute.ts:497-500 把调用转发给 model-runtime 的图像生成 (provider 无 generateImages 能力时返回错误结果), 且与 models.classify() 共用同一个在飞调用上限 — 单脚本超量的调用自动排队 (execute.ts:50 注释)。

会话存储与共享 (docs/sessions.md): session 默认存 ~/.pi/agent/sessions/ 按工作目录分组; --session-dir / PI_CODING_AGENT_SESSION_DIR / sessionDir 设置可改位置 (CLI 参数优先); --no-session 跑临时会话 (退出即不可恢复); --session 直接指定路径或 ID; --fork 在交互模式启动前从既有会话分叉。/export 导出 HTML 或 JSONL; /share 上传拿 viewer 链接 (配置了 Radius 认证走 Radius artifact, 否则用私有 GitHub gist); /bug 生成私有报告 (环境 + provider 配置但不含凭据值, 经 radius.pi.dev 上传或导出 zip 自查)。文档反复提醒: 导出/分享前必须自查, 内容可能包含 prompt、模型回复、工具参数、命令输出与文件内容。

## 七、Provider 层: packages/ai

pi-ai 是统一多供应商 LLM API。src/providers/ 下约 45 个 provider 模块, 每个配一份 *.models.ts 模型数据: anthropic、openai、openai-codex (Codex 订阅通道)、google、google-vertex、amazon-bedrock、azure-openai-responses、deepseek、openrouter、groq、cerebras、fireworks、together、mistral、xai、zai (+zai-coding-cn)、kimi-coding、minimax (+minimax-cn)、moonshotai (+moonshotai-cn)、qwen-token-plan (+cn/individual)、xiaomi (+xiaomi-token-plan-ams/cn/sgp)、github-copilot、opencode (+opencode-go)、vercel-ai-gateway、cloudflare-ai-gateway、cloudflare-workers-ai、huggingface、baseten、nvidia、meta、ant-ling、radius、typesafe, 以及测试替身 faux (coding-agent 的 test/suite 全部用 faux provider, 不碰真实 API 与付费 token)。另有 images/ 与 image-models.ts、images-api-registry.ts 处理图像模型。

模型目录是生成物: npm run generate:models / hydrate-model-data / check-model-data / generate-model-catalog, models.generated.ts 由 scripts/generate-models.ts 生成; AGENTS.md 允许提交重新生成带来的无关上游模型元数据 diff。认证在 src/auth/ 与 oauth.ts / bun-oauth.ts / env-api-keys.ts; 用户在 Pi 内 /login 选 provider, 走订阅或存 API key, /model 切换模型。Anthropic 一侧 0.99.2 起支持 workload identity federation (a9424cd, 从 ANTHROPIC_FEDERATION_RULE_ID / ANTHROPIC_ORGANIZATION_ID / ANTHROPIC_IDENTITY_TOKEN_FILE 环境变量读取, 可选 ANTHROPIC_SERVICE_ACCOUNT_ID / ANTHROPIC_WORKSPACE_ID; API key 与 ANTHROPIC_AUTH_TOKEN 仍优先, federation client 跨请求复用以命中 SDK 令牌缓存, 且禁用 SDK 自己的凭据链使 pi 的 auth resolver 保持唯一凭据来源), OAuth 另有 copy-code 登录方式 (7a11fe1)。Radius 是一等公民 provider (ed8b3bc + c2f65d8): docs/providers.md 有 Radius 专节 — Radius 是 Earendil Works 官方为 Pi 打造的 AI 网关 (组织级管控、分析与 artifacts, 现阶段 early alpha, radius.earendil.com), 在 Pi 里 /login radius 即把 Radius 注册为 provider, 其模型随后像其他 provider 一样出现在 /model; 登录成功后 Pi 还会提议把 Radius 的 MCP server 写进全局 mcp.json, 以 auth.provider = radius 直接复用这份登录 (取代 MCP OAuth sign-in, interactive-mode.ts 的 offerRadiusMcpServer, 确认后自动 reload)。Radius 认证使用其网关目录, 并缓存刷新后的模型元数据供离线启动 (docs/providers.md); 环境侧另有 PI_RADIUS_GATEWAY 覆盖网关源 (docs/environment-variables.md)。OAuth 浏览器回调页使用彩色 Pi logo (packages/ai/src/utils/oauth-page.ts 的 LOGO_SVG, 233f174)。国内供应商 (deepseek、kimi、minimax、moonshot、qwen、xiaomi、zai 及其 -cn 变体) 覆盖之全在同类项目里少见。

## 八、安全模型与容器化

README "Permissions & Containerization" 说得非常直接: Pi 没有内置权限系统来限制文件系统、进程、网络或凭据访问, 默认以启动它的用户与进程的权限运行; 项目 trust 只控制加载哪些项目资源, 不做工具调用沙箱。需要更强边界就容器化, docs/containerization.md 给三种模式:

1. Gondolin 扩展: pi 与 provider 认证留在宿主机, 内置工具与 ! 命令路由进本地 Linux micro-VM (examples/extensions/gondolin);
2. Plain Docker: 整个 pi 进程跑本地容器, 简单隔离;
3. OpenShell: 整个 pi 进程跑在策略控制的沙箱里。

再加上根 devDependencies 里的 @anthropic-ai/sandbox-runtime 0.0.26 与 examples/extensions/sandbox, 可以看出沙箱能力全部外置为可选层, 与"内核最小化"的哲学一致。docs/security.md 要求在使用不可信文件、仓库、扩展或无人值守自动化前先读安全文档。

## 九、TUI: packages/tui

pi-tui 是差分渲染的终端 UI 库, src/ 可见其工程深度: 双屏管理 (tui-main-screen.ts / tui-alt-screen.ts / alt-screen-search.ts)、布局系统 (layout.ts / layout-node.ts)、编辑器组件 (editor-component.ts)、emacs 风格编辑原语 (kill-ring.ts、undo-stack.ts、word-navigation.ts、wheel-scroll.ts)、自动补全与模糊匹配 (autocomplete.ts / fuzzy.ts)、LaTeX 渲染 (latex.ts)、终端图像 (terminal-image.ts)、Oklab 色彩空间 (oklab.ts)、终端色彩探测 (terminal-colors.ts)、原生修饰键检测 (native-modifiers.ts / native-platform.ts, 配 build:native:darwin/linux/win32 三平台原生构建)、stdin 缓冲 (stdin-buffer.ts) 与键位系统 (keys.ts / keybindings.ts)。仓库根还有 36KB 的 tui-plan.md 设计文档。coding-agent 的交互模式资产: src/modes/interactive/theme/_.json 主题与 assets/_.png。

coding-agent 交互模式的默认 TUI 形态是 fullscreen (88ff80b): tuiMode 默认 fullscreen (settings-manager.ts:184 注释 "default: \"fullscreen\"", :1349 的 getter 仅在显式设为 regular 时返回 regular), --tui-mode regular 或设置面板可切回 (cli/args.ts:326 帮助文本 "fullscreen (default) or regular"); fullscreen 走 pi-tui 的备屏渲染器 (modes/interactive/tui-renderer.ts 的 createInteractiveTui 在 fullscreen 时返回 TuiAltScreen), 配套四项设置 — 退出时输出 (transcript 或 resume-hint)、滚动条、选中即复制、滚轮每次滚动行数 (settings-selector.ts 均有对应条目)。logo 点击彩蛋动画也只在 fullscreen 播放 (components/pi-logo-animation.ts)。启动呈现由 quietStartup 控制: true 隐藏全部, "header" 档 (f29ea3d) 只隐藏启动细节 (model scope、加载的资源) 而保留 header 的 logo/版本/键位提示 (interactive-mode.ts:1409-1416)。另有两处终端兼容细节: Apple Terminal 绘制半块 logo 会在行间留缝, isAppleTerminalSession 探测后改用文字标 (components/pi-logo.ts:29-33, ca9c925); system 主题的 palette 颜色移到另一明度时不获得 OKLCH chroma, pastel 终端配色不被加浓 (#10293, theme/system-theme.ts:7-9)。

## 十、质量与发布流水线

- 检查: npm run check 串起 Biome (error-on-warnings) + 钉版本检查 + 运行时依赖检查 + TS 相对导入检查 + entry graph 检查 + shrinkwrap/install-lock 一致性 + tsc --noEmit + 浏览器 smoke (scripts/check-browser-smoke.mjs, 保证核心包能被浏览器端 tree-shake 使用); 全部通过才允许提交。
- 测试: 根目录 ./test.sh 跑非 e2e 测试 (无 API key 时自动跳过依赖 LLM 的用例); 明令禁止直接跑完整 vitest (存在 endpoint/auth 环境变量时会激活 e2e); coding-agent 用 vitest, tui 用 node:test; ./pi-test.sh 可从任意目录以源码运行 pi; mini-test.sh 与 pi-test.bat / pi-test.ps1 覆盖 Windows。MCP 客户端另有官方一致性基准: npm run test:mcp-conformance 跑 modelcontextprotocol/conformance 套件的 client 场景 (a4715ec 进 CI, 钉住 @modelcontextprotocol/conformance@0.2.0-alpha.11 经 npx 拉取) , 对 pi 的 HTTP 连接与 OAuth 登录逐个协议版本 (2025-03-26 / 2025-06-18 / 2025-11-25) 运行, 与提交的 check-level baseline.json 对比, 基线中通过的项回归即失败 (packages/coding-agent/test/mcp-conformance/)。
- 发布: npm run release:patch/minor/major (scripts/release.mjs); release:local 在仓库外做隔离的 npm 与 Bun 安装 smoke, 通过后才打 tag; publish 走 scripts/publish.mjs; 版本同步用 scripts/sync-versions.js; 发布说明与 GitHub Release 修复有专门脚本 (release-notes.mjs fix-github-releases)。
- 统计脚本: scripts/ 下还有 tool-stats.ts、edit-tool-stats.mjs、read-tool-stats.mjs、session-context-stats.mjs、cost.ts、session-transcripts.ts — 对自身 agent 行为做数据分析的工具链。

## 十一、小结: 值得借鉴的工程点

1. 树形会话模型: entry 带 parent 指针的 JSONL 树 + active branch, 分支不删历史, compaction 只是视图层替换 — 比线性消息数组 + 截断的常见做法保留了更多可回溯性。
2. 最小内核 + 五层资源阶梯 (AGENTS.md → prompt template → skill → extension → package), 每层复杂度递增, 文档明确引导用户从最弱机制开始。
3. SDK 与 CLI 同源: createAgentSession 暴露的就是 CLI 自己用的 AgentSession/SessionManager/ResourceLoader, 依赖注入面完整, 14 个示例随仓库 typecheck — "可被 agent 自我解释" (README: 你也可以直接问 agent 它自己怎么工作)。
4. 供应链加固成体系: min-release-age、全链路 --ignore-scripts、shrinkwrap + lifecycle script allowlist、发布前隔离安装 smoke, 每一条都针对真实的 npm 投毒攻击面。
5. codemode 用 quickjs-wasi 把"模型写代码编排工具"关进只有注入工具一个能力的沙箱, 是 code mode 思路的轻量实现。
6. 治理透明且防御性强: 自动关闭 + lgtm/lgtm 授权 + 质量门槛, 是维护者对抗 agent 生成 issue 洪流的一套完整缓冲机制。
