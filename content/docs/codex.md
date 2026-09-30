---
title: "OpenAI Codex CLI 调研: 产品形态、TypeScript SDK 与协议化架构"
description: "面向 TS/JS 开发者的 openai/codex 调研: 产品形态、TypeScript SDK 与 app-server 协议化架构"
---

仓库路径: https://github.com/openai/codex (本机克隆位于 $HOME/Downloads/codex)

> 本文面向 TS/JS 技术栈读者, 不要求 Rust 背景: 实现语言只在必要处提及, 重点放在产品形态、TypeScript SDK、进程间协议与工程规范上。

## 一、项目快照 (本机克隆 2026-10-01)

本机克隆自 org-14957082@github.com:openai/codex.git (.git/config), 2026-09-29 clone 于 c248f6d4, 2026-09-30 两次 fast-forward pull (先到 92bc601a, 再到 7219fd7), 2026-10-01 凌晨又两次 pull (先到 67727e7, 再到 fcbed04), 当前 HEAD fcbed044c8c6994c97c7387d21ff3077cf3a5812, 分支 main。7219fd7 之后的三个 commit 分别是 #49642 (允许托管 requirements 禁用 Windows MXC 沙箱)、#49675 (Responses 路由字段在大输入之前先序列化)、#49678 (恢复问题答复时对命令草稿做转义)。

| 指标        | 数值                                                                                                                                             |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 定位        | OpenAI 官方本地编码 agent (Codex CLI)                                                                                                            |
| License     | Apache-2.0                                                                                                                                       |
| 版本锚点    | Python SDK 依赖钉死 openai-codex-cli-bin==0.153.4 (sdk/python/pyproject.toml), 即此快照时期 CLI 约为 0.153.x                                     |
| 版本策略    | 0.x 语义化版本; announcement_tip.toml 显示 0.120.0 之前的版本已于 2026-05-08 停止支持                                                            |
| 官方文档    | developers.openai.com/codex (仓库 docs/ 大多是指向它的 3 行跳转存根)                                                                             |
| 安装渠道    | 官方安装脚本 (releases.openai.com, 回退 GitHub Releases)、npm i -g @openai/codex、brew install --cask codex、GitHub Release 平台二进制、DotSlash |
| 登录方式    | ChatGPT 账号 (Plus/Pro/Business/Edu/Enterprise 计划内) 或 API key                                                                                |
| Node 侧要求 | Node >= 22, pnpm >= 10.34.5 (根 package.json engines, 仅用于仓库维护)                                                                            |

产品形态是一个矩阵: 终端里的 Codex CLI (TUI)、非交互的 codex exec、编辑器扩展 (VS Code/Cursor/Windsurf)、桌面应用 (codex app)、云端 agent Codex Web (chatgpt.com/codex)。本仓库是 CLI 及其配套的开源部分。

一个重要事实: 本机快照的工作树是不完整的部分检出。git 追踪的 8841 个文件里磁盘上只保留约 1127 个 (git status 显示 7714 个文件已从工作树删除)。仓库内的 AGENTS.md、justfile、docs/install.md 大量引用 codex-core、codex-tui、codex-cli、codex-mcp、app-server-protocol、codex-hooks 等 crate (例如 scripts/run_tui_with_exec_server.sh 里 cargo run -p codex-cli --bin codex), 其中 codex-mcp/、app-server-protocol/、hooks/ 等目录在磁盘上整体缺失, core/、tui/、cli/、config/、app-server/ 只残留历次 pull 恢复的少量文件 (2026-10-01 pull 后: core 4 个、tui 7 个、cli 3 个、config 1 个、app-server 1 个), workspace 根 codex-rs/Cargo.toml 也不在磁盘上 (codex-rs/Cargo.lock 在)。下文凡涉及这些 crate 的描述, 事实来源都是仓库内的文档/脚本引用, 而非本机源码。

## 二、安装与运行 (docs/install.md)

系统要求: macOS 12+、Ubuntu 20.04+/Debian 10+、Windows 11 (经 WSL2); Git 2.23+ 可选 (内置 PR helper 用); RAM 最低 4GB、推荐 8GB。

```bash
# macOS / Linux
curl -fsSL https://chatgpt.com/codex/install.sh | sh
# Windows
powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"
# 强制走 GitHub Releases 而非 releases.openai.com
curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_INSTALLER_USE_RELEASES_OPENAI_COM=false sh
```

安装器默认从 https://releases.openai.com/codex 下载, 元数据或资产不可用时回退 GitHub Releases。GitHub Release 里每个平台一个 tar.gz (如 codex-aarch64-apple-darwin.tar.gz), 包内是单个带平台后缀的可执行文件; 另外提供 DotSlash 文件 — 一个轻量提交进源码库的可执行文件描述, 保证所有贡献者跨平台用同一版本的二进制。

日志与诊断: Codex 遵循 RUST_LOG 环境变量; codex -c log_dir=./.codex-log 可开启 TUI 明文日志 (codex-tui.log); 非交互模式 codex exec 默认 RUST_LOG=error 且消息内联打印。

## 三、仓库结构: Bazel 优先的 Rust monorepo + 双 SDK

顶层布局 (本机工作树实测):

| 路径                                                   | 内容                                                                                                                                                                                                |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| codex-rs/                                              | Rust 代码; 本机快照含 29 个带 Cargo.toml 的 crate (27 个顶层 + memories/read 与 memories/write), 外加 chatgpt/ (仅 3 个 src 文件, 无 Cargo.toml) 与 memories/README.md (仓库内最完整的架构文档之一) |
| sdk/typescript                                         | @openai/codex-sdk, TypeScript SDK (tsup 构建, jest 测试)                                                                                                                                            |
| sdk/python                                             | openai-codex, Python SDK (uv 构建, pydantic v2)                                                                                                                                                     |
| sdk/python-runtime                                     | Python SDK 的运行时伴生包                                                                                                                                                                           |
| docs/                                                  | 15 个 md, 多为跳转存根; 实质内容是 install.md、config.md 的 hooks 段、contributing.md、CLA.md                                                                                                       |
| bazel/ + MODULE.bazel + defs.bzl + .bazelrc + patches/ | Bazel 构建体系: rules_rust 定制、33 个第三方补丁 (rules_rust Windows MSVC/gnullvm、rusty_v8、llvm、webrtc-sys 等)                                                                                   |
| justfile + scripts/                                    | Cargo 开发流 (just fmt/test/fix/bench) 与发布/打包/调试脚本                                                                                                                                         |
| .codex/                                                | 仓库自用配置: environments/environment.toml + 11 个 skills (code-review 系列、babysit-pr、codex-pr-body、remote-tests、test-tui、update-v8-version 等) — 用自己的产品维护自己的仓库                 |
| announcement_tip.toml                                  | TUI 公告机制: [[announcements]] 按序求值、最后一条命中者展示; 字段 content/version_regex/from_date/to_date/target_app (cli、vsce 等), version_regex 匹配 env!("CARGO_PKG_VERSION")                  |

本机快照可见的 crate 按名字与仓内文档可归为几类 (仅列可确证用途的):

| crate                                                                                                | 用途证据                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| memories/read + memories/write                                                                       | 记忆管线读写路径 (详见第六节, memories/README.md 是仓库内最完整的架构文档之一)                                                                                                                                           |
| exec-server-protocol                                                                                 | exec-server 的协议定义 (配合 run_tui_with_exec_server.sh)                                                                                                                                                                |
| codex-api                                                                                            | Responses API 与 Realtime WebSocket 客户端: endpoint/{responses, responses_websocket, realtime__}、SSE 解析 (sse/responses_.rs)、rate_limits、auth; 本轮 #49675 在其中调整了 Responses 路由字段的序列化顺序 (先于大输入) |
| app-server-daemon                                                                                    | app-server 守护进程 (AGENTS.md 有 app-server JSON-RPC 开发规范)                                                                                                                                                          |
| code-mode-runtime                                                                                    | 内嵌 JS 运行时: 依赖 deno_core_icudata (Deno core, 即 V8 + ICU), 佐证是 patches/ 里成组的 rusty_v8/v8/libwebrtc 补丁与 BUILD.bazel 的 rusty_v8_from_source 开关                                                          |
| login / workload-identity                                                                            | 登录与 workload identity                                                                                                                                                                                                 |
| mxc-sandbox / shell-escalation / shell-command                                                       | 沙箱与 shell 执行相关                                                                                                                                                                                                    |
| thread-store / message-history / responses-api-proxy / websocket-client                              | 会话存储、消息历史、Responses API 代理、WebSocket 客户端                                                                                                                                                                 |
| file-search / file-system / git-utils / terminal-detection                                           | 文件搜索、文件系统、git 工具、终端探测                                                                                                                                                                                   |
| cloud-tasks / ollama / analytics / build-info / tcp-tunnel / stdio-to-uds / external-agent-migration | 云任务、Ollama 支持、分析、构建信息、TCP 隧道、stdio→Unix socket 转发、外部 agent 迁移                                                                                                                                   |

根 package.json 几乎是空的 (只有 prettier), 印证 Node 工具链在这个仓库只承担维护性工作; 有意思的是它的 write-hooks-schema 脚本 cargo run -p codex-hooks — 引用了本机不存在的 crate, 且暗示产品支持 lifecycle hooks (docs/config.md: 管理员可在 requirements.toml 设 allow_managed_hooks_only = true, 忽略用户/项目/会话级 hook 配置, 只允许 managed hooks; 该设置只认 requirements.toml, 放 config.toml 无效)。

## 四、TypeScript SDK: @openai/codex-sdk

这是 TS/JS 开发者接入 Codex 的正门。架构一句话: SDK 不做协议实现, 它 spawn @openai/codex 的 codex CLI 子进程, 通过 stdin/stdout 交换 JSONL 事件 (sdk/typescript/README.md 原文)。Node 18+ 即可。

src/ 只有 10 个文件: codex.ts (Codex 客户端)、thread.ts (Thread)、events.ts / items.ts (事件与条目类型)、exec.ts (子进程执行)、codexOptions.ts / threadOptions.ts / turnOptions.ts (三层选项)、outputSchemaFile.ts、index.ts。devDependencies 里有 @modelcontextprotocol/sdk 与钉死 commit 的 @modelcontextprotocol/conformance — SDK 测试跑 MCP 官方一致性套件。

核心 API (README 示例):

```typescript
import { Codex } from "@openai/codex-sdk";

const codex = new Codex();
const thread = codex.startThread();
const turn = await thread.run("Diagnose the test failure and propose a fix");
console.log(turn.finalResponse); // 最终回复
console.log(turn.items); // 结构化条目 (工具调用、文件变更等)

// 流式: run() 缓冲到轮次结束, runStreamed() 返回异步事件生成器
const { events } = await thread.runStreamed("...");
for await (const event of events) {
  switch (event.type) {
    case "item.completed":
      console.log("item", event.item);
      break;
    case "turn.completed":
      console.log("usage", event.usage);
      break;
  }
}
```

值得 TS 开发者抄作业的设计点:

1. 结构化输出走 JSON Schema: thread.run(prompt, { outputSchema }) 让 agent 产出符合 schema 的 JSON; 官方示例直接给 Zod 用户指路 zod-to-json-schema 并设 target: "openAi"。
2. 多模态输入是判别联合: run([{ type: "text", text }, { type: "local_image", path }]), 文本条目拼接成最终 prompt, 图片条目转成 CLI 的 --image 参数。
3. 线程可恢复: 会话持久化在 ~/.codex/sessions, 丢失内存对象后用 codex.resumeThread(savedThreadId) 重建继续跑。
4. 环境控制面向 Electron 等沙箱宿主: new Codex({ env }) 完全接管子进程环境变量, SDK 再把必需变量 (如 CODEX_API_KEY) 叠加回去; baseUrl 转成 --config openai_base_url=... 覆盖。
5. 配置覆盖有两层: config 对象被展平成点路径、值序列化为 TOML 字面量后作为重复的 --config key=value 传入; 无法用点路径表达的键走 configOverrides 原样透传 (如 'permissions.audit.filesystem={":root"="read",...}'), 且优先级更高; SDK 自管设置最后应用、优先级最高。
6. 工作目录默认必须是 Git 仓库 (避免不可恢复错误), skipGitRepoCheck: true 可跳过检查。

samples/ 目录提供 basic_streaming.ts、structured_output.ts、structured_output_zod.ts 三个可运行示例。

Python SDK (openai-codex) 是同一套模型的镜像: Codex() → thread_start() → thread.run() 返回 TurnResult (final_response/items/usage), 另提供 login_chatgpt() (浏览器 OAuth) 与 login_chatgpt_device_code() (设备码) 两种显式登录; 它把 CLI 二进制作为依赖包 openai-codex-cli-bin 钉版本分发 — 这也是我们确定当前 CLI 版本号 (0.153.4) 的依据。

## 五、协议化架构: app-server 与 exec-server

Codex 内部不是单体: TUI、IDE 扩展、桌面 app 都通过协议与 agent 内核通信, AGENTS.md 用整整一节规定了 app-server JSON-RPC API 的开发规范。对 TS 读者, 这节几乎就是一份"如何设计跨语言 RPC API"的范文:

- 所有新 API 只加在 v2, v1 冻结; 方法命名 <resource>/<method> 且 resource 用单数 (thread/read、app/list)。
- 载荷命名 *Params (请求) / *Response (响应) / *Notification (通知)。
- 线上字段一律 camelCase (Rust 侧 serde rename_all, 同时用 ts-rs 标注生成 TypeScript 类型, #[ts(export_to = "v2/")] 决定生成的 TS 命名空间); 唯一例外是 config RPC 用 snake_case 以镜像 config.toml 键名。
- 判别联合在两侧都用显式 tag: serde(tag = "type") 对应 ts(tag = "type") — 生成的 TS 就是可 switch 的 discriminated union。
- ID 在 API 边界一律用 plain String (UUID 解析放内部); 时间戳一律 Unix 秒整数、命名 *_at (created_at、resets_at)。
- 新 list 方法默认游标分页: 请求 cursor/limit, 响应 data/next_cursor。
- 实验性 API 用 #[experimental("method/or/field")] 标注, 支持字段级门控 (ExperimentalApi derive / inspect_params)。
- 布尔字段想表达"缺省即 false"时用 serde(default, skip_serializing_if = Not::not) 而非 Option<bool>; v2 载荷禁止 skip_serializing_if = "Option::is_none"。
- Schema 变更必须重新生成 fixture (just write-app-server-schema) 并跑协议包测试。

exec-server 是另一条协议线: scripts/run_tui_with_exec_server.sh 展示了完整拓扑 — 先 cargo run -p codex-cli --bin codex -- exec-server --listen ws://127.0.0.1:0 启动执行服务器, 从 stdout 第一行读出实际绑定的 ws URL, 再以 CODEX_EXEC_SERVER_URL=<url> 启动 codex-tui。也就是说 TUI 与命令执行内核之间走 WebSocket, 二者可以分离部署; AGENTS.md 平台支持一节明确 "Codex 支持 app-server 与 exec-server 跑在不同操作系统上" (配套 $remote-tests skill, 就在 .codex/skills/remote-tests)。scripts/ 里还有 mock_responses_websocket_server.py 与 mcp_conformance/ 目录, 分别用于 mock Responses API 的 WebSocket 与跑 MCP 一致性测试。

对模型的上下文注入, AGENTS.md 定了五条硬规则 (Model visible context 一节), 对任何做 agent 的团队都适用:

1. 不改写历史 — 上下文必须增量构建;
2. 避免频繁变更上下文导致缓存失效 (prompt cache miss);
3. 无界条目禁止 — 注入上下文的任何东西都要有界且有硬上限;
4. 单条目不超过 10K tokens;
5. 可能超过 1k tokens 的新条目按 P0 高亮, 需要额外人工评审。

所有注入片段必须定义为 core/context 下的结构体并实现 ContextualUserFragment trait — 类型系统兜底防止随手塞字符串进上下文。

## 六、Memories 子系统: 两阶段记忆管线

codex-rs/memories/README.md 是快照里最完整的架构文档, 描述了 Codex 的长期记忆如何离线生成与固化。运行时编排在上游 codex-core/src/memories/, 本目录提供可复用的读写 crate 与提示词模板 (read_path.md、stage_one_system.md、stage_one_input.md、consolidation.md, 模板与使用它的 crate 放在一起)。

触发条件: 根会话启动时, 且会话非 ephemeral、记忆功能开启、不是子 agent 会话、state DB 可用; 全程后台异步执行, Phase 1 完成后接 Phase 2。

Phase 1 (Rollout Extraction, 按线程并行): 从 state DB 里按启动认领规则挑选合格的 rollout — 来源限于允许的交互会话、在配置的年龄窗口内、闲置足够久 (避免总结仍在活跃的会话)、未被其他 in-flight worker 认领、在启动扫描/认领上限内。每个 rollout 过滤出记忆相关的 response items 后送模型 (并行, 有并发上限), 期望结构化输出三件套: 详细 raw_memory、紧凑 rollout_summary、可选 rollout_slug; 生成的字段做密钥脱敏后写回 state DB。任务结果分 succeeded / succeeded_no_output / failed (带重试退避), 认领用 DB lease 防重复劳动。

Phase 2 (Global Consolidation, 全局串行): 先拿全局锁, 再按选择规则从 DB 载入有界的 stage-1 输出 (忽略超出 max_unused_days 未使用的记忆; 无使用记录的按 generated_at 兜底; 排序按 usage_count 优先、再按最近使用/生成时间), 然后同步文件系统工件:

- raw_memories.md — 合并的原始记忆, 按 thread-id 升序稳定排列 (避免 usage 排名变化引起 diff 抖动);
- rollout_summaries/ — 每个入选 rollout 一个摘要文件, 落选的剪枝;
- phase2_workspace_diff.md — 从上次成功 Phase 2 基线到当前工作树的 git 风格 diff。

记忆根目录本身是一个 git 基线目录 (~/.codex/memories/.git, 由 codex-git-utils 初始化), 脏检查用 git 工作树状态而非 DB watermark。若工作树有变化, 就 spawn 一个内部整合子 agent: 提示词带上 diff 文件路径, 运行约束是"无审批、无网络、仅本地写", 并禁用 collab 防止递归委派; 主流程监视 agent 状态并给全局 lease 发心跳; agent 成功后重置 git 基线 (diff 文件先删除, 避免不可达 git 对象), 最后在 DB 记录成败与新的完成 watermark (取 claimed watermark 与实际载入输入的最新 source_updated_at 的较大者, 保证 watermark 不回退)。

两阶段拆分的理由写得很直白: Phase 1 面向大量 rollout 水平扩展并产出规范化的每 rollout 记忆记录; Phase 2 把全局整合串行化, 保证共享记忆工件被安全一致地更新。

## 七、沙箱与安全

本机可确证的事实: AGENTS.md 规定 agent 的 shell 工具运行在沙箱中, 沙箱内会设置 CODEX_SANDBOX_NETWORK_DISABLED=1; 经 Seatbelt (/usr/bin/sandbox-exec) 派生的子进程会带 CODEX_SANDBOX=seatbelt; 仓库规则明令禁止新增或修改与这两个环境变量相关的代码 (集成测试用它们判断能否在沙箱内自举运行)。crate 层面有 mxc-sandbox 与 shell-escalation; Windows 沙箱也纳入了托管要求 (managed requirements) 治理: #49642 (2026-09-30 合入) 在 codex-rs/config/src/config_requirements.rs 的 WindowsRequirementsToml 里新增可选项 windows.allow_mxc, 设为 false 时既禁止 prefer_mxc 自动选择 MXC, 也拒绝显式的 windows.sandbox = "mxc" 配置 (报 ConstraintError 并指明要求来源); 执行策略 (execpolicy) 与沙箱/审批 (sandbox & approvals) 的产品文档都跳转 developers.openai.com/codex/security 与 /exec-policy, 仓库内不保留正文 — AGENTS.md 甚至明文规定"不要往 docs/ 添加产品或用户文档, 官方文档在别处"。

Windows 支持是个矛盾点: install.md 要求 Windows 11 走 WSL2, 但 patches/ 里有大量 Windows 原生工具链补丁 (rules_rust MSVC 直连参数、gnullvm、llvm windows arm64、rusty_v8 自定义 libcxx 等), AGENTS.md 也要求"测试与特性必须支持 Linux、macOS 和 Windows, 除非特性显式限定 OS" — 代码库在为原生 Windows 铺路, 安装文档暂时保守。

## 八、工程规范精选 (AGENTS.md)

这份 22KB 的 AGENTS.md 本身就是给 coding agent 读的, 几条对任何语言的团队都有参考价值:

- 反单体: codex-core 已经是最大的 crate, 规则是"抵制往 codex-core 加代码" — 新功能先找现有 crate 或开新 crate, review 时对不必要的 core 扩张直接 push back。
- 变更规模: 非机械性变更总行数不超过 800 行, 复杂逻辑变更控制在 500 行以内; 超了就拆分出最小可先行落地的阶段。
- 模块规模: Rust 模块目标 500 LoC 以内 (不含测试), 超过约 800 LoC 就开新模块而不是继续膨胀; 点名了 tui/src/app.rs、chatwidget.rs 等高频文件。
- 测试分层: agent 行为变更优先写集成测试 (上游 core/suite, 用 test_codex builder 起测试实例, ResponseMock + mount_sse_once 断言出站 /responses 请求体); UI 变更必须带 insta 快照测试, 快照 diff 作为 PR review 材料; 断言用 pretty_assertions 且优先整对象深比较; 新测试模块放独立 *_tests.rs 文件。
- 破坏性变更清单: app-server API、rawResponseItem/* 事件 (即使在 experimental 期)、CLI 参数、配置加载、既有 rollout 的会话恢复 — 这五类外部集成面必须专门排查。
- Bazel/Cargo 双构建的锁纪律: 改 Rust 依赖必须 just bazel-lock-update 刷新 MODULE.bazel.lock 并随同一变更提交, CI 检查 lockfile 漂移; 加 include_str!/sqlx::migrate! 之类编译期文件读取必须同步更新 BUILD.bazel 的 compile_data, 否则 Cargo 过了 Bazel 也会挂。

## 九、贡献模式

docs/contributing.md 明确: 不接受外部代码贡献与 PR, 社区贡献聚焦 issue — bug 报告、复现步骤、日志、根因分析、设计讨论。给出的理由: 有效变更需要架构上下文、系统级约束理解和路线图视野, 外部 PR 常聚焦低优先级问题且磨合成本高于直接实现; "理解问题、找对方案、排定优先级才是难的部分, 实现本身在 Codex 的帮助下相对简单"。安全漏洞走 SECURITY.md 私密通道。另有 docs/open-source-fund.md (开源基金) 与 CLA.md。

与之对照, 仓库对"用 agent 维护仓库"的投入是实打实的: .codex/skills/ 下 11 个自用 skill (code-review 拆成 breaking-changes/change-size/context/testing 四个专项, 外加 babysit-pr、codex-pr-body、remote-tests、test-tui、update-v8-version), AGENTS.md 全文以"你 (agent) 应该怎么做"的口吻书写。

## 十、小结: TS/JS 开发者视角的要点

1. 接入路径清晰: 应用内嵌用 @openai/codex-sdk (spawn CLI + JSONL stdio), 脚本化用 codex exec, 更深的集成走 app-server JSON-RPC (v2) 或 exec-server WebSocket。
2. SDK 的"包装 CLI"策略值得学: 不重新实现协议, 用子进程 + 结构化事件流换来与 CLI 版本演进解耦; Python SDK 进一步把 CLI 二进制做成钉版本的依赖包。
3. app-server v2 规范是一份现成的跨语言 API 设计 checklist: camelCase 线上格式、判别联合显式 tag、String ID、Unix 秒 *_at 时间戳、默认游标分页、experimental 字段级门控、schema fixture 回归。
4. 上下文注入的五条硬规则 (增量、防 cache miss、有界、10K 上限、1k 以上 P0 评审) 与 ContextualUserFragment 类型化约束, 是 agent 上下文工程的可移植经验。
5. 记忆管线的两阶段设计 (并行提取 + 串行整合, DB lease + git 基线 + watermark) 展示了如何把"长期记忆"做成可审计的文件系统工件而非黑盒向量库。
6. 使用本机快照做二次调研时注意: core/tui/cli 等主 crate 在这份工作树里只有历次 pull 恢复的零星文件, 相关结论需以 AGENTS.md 与脚本引用为据, 或补齐完整克隆后复核。
