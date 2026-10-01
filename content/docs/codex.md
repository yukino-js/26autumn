---
title: "OpenAI Codex CLI 调研: 产品形态、TypeScript SDK 与协议化架构"
description: "面向 TS/JS 开发者的 openai/codex 调研: 产品形态、TypeScript SDK 与 app-server 协议化架构"
---

仓库路径: https://github.com/openai/codex (本机克隆位于 $HOME/Downloads/codex)

> 本文面向 TS/JS 技术栈读者, 不要求 Rust 背景: 实现语言只在必要处提及, 重点放在产品形态、TypeScript SDK、进程间协议与工程规范上。

## 一、项目快照 (本机克隆 2026-10-02)

本机克隆的时间线换过一次: 早先的完整克隆 (2026-09-29 clone 于 c248f6d4, 历次 pull 到 fcbed04) 已被整体删除; 2026-10-01 11:21 重新浅克隆 (shallow clone) 于 e53e932, 同日 16:43 git pull fast-forward 到 444da31 (#49912), 17:35 再次 pull 到 6b4daafdb445340e5af66f067ad4057e6ed9fd81 (主题 "Add per-turn Cyber access program selection to exec and the SDK (#49939)", 提交时间 2026-10-01 08:48 UTC); 2026-10-02 00:11 install.js pull 自 6b4daaf 再前进 10 个 commit, 到当前 HEAD 9552906b2b8358121f71695e1e6602791cdcecc0, 分支 main, 主题 "Protect the guardian decisions API key from environment forwarding (#50019)", 提交时间 2026-10-01 15:41 UTC。remote 是 org-14957082@github.com:openai/codex.git (.git/config); 以上时间与动作均以 git reflog 为据 (一条 clone 与三条 pull)。

浅克隆的性质要说清楚: .git/shallow 里记录的边界仍是 e53e932 (#49836, voice 会话的麦克风通道选择), 本地对象库只有 32 个 commit (444da31 时点实测 21 个, 此后 #49939 一个、本轮再加 10 个), 旧文档引用过的哈希 (fcbed04、7219fd7、67727e7、c248f6d4) 都已不在本地, 涉及更早演进的 commit 考古无法在本机复核。基点 commit e53e932 因浅嫁接呈现为一次整树导入 (8870 个文件、约 235 万行)。

与旧快照最大的不同: 工作树现在是完整检出。git ls-files 在 444da31 时点实测 8892 个文件 (6b4daaf 与 9552906 是其上的小幅增量提交, 工作树规模基本不变), git status 除未跟踪的 .codegraph/ 外干净; codex-rs/ 下全部 crate (app-server-protocol、hooks、codex-mcp、exec-server 等) 都在磁盘上。旧文档中 "部分检出、7714 个文件被删、crate 描述只能依赖文档/脚本引用" 的整段论述作废, 本文这一轮已把能对照源码的结论全部改为源码依据。

另一个重要变化: 根 AGENTS.md 与 .codex/ 目录 (旧快照记载的 22KB agent 工程规范与 11 个自用 skill) 已不在仓库中 — 浅克隆基点 e53e932 的树里就没有它们, 删除发生在旧快照 (fcbed04) 与本次克隆之间, 具体 commit 不在本地历史里。仓库现在唯一的 AGENTS.md 是 codex-rs/tui/src/bottom_pane/AGENTS.md (模块级规范); AGENTS.md 本身则成了产品特性 (codex-rs/core/src/agents_md.rs 负责读取用户仓库的 AGENTS.md, docs/agents_md.md 跳转 developers.openai.com/codex/guides/agents-md)。

| 指标        | 数值                                                                                                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 定位        | OpenAI 官方本地编码 agent (Codex CLI)                                                                                                                                                 |
| License     | Apache-2.0                                                                                                                                                                            |
| 版本锚点    | Python SDK 依赖钉死 openai-codex-cli-bin==0.153.4 (sdk/python/pyproject.toml), 即此快照时期 CLI 约为 0.153.x                                                                          |
| 版本策略    | 0.x 语义化版本; announcement_tip.toml 显示 0.120.0 之前的版本已于 2026-05-08 停止支持                                                                                                 |
| 官方文档    | developers.openai.com/codex (仓库 docs/ 大多是指向它的跳转存根)                                                                                                                       |
| 安装渠道    | 官方安装脚本 (releases.openai.com, 回退 GitHub Releases)、npm install -g @openai/codex、brew install --cask codex、GitHub Release 平台二进制、DotSlash (README.md 与 docs/install.md) |
| 登录方式    | ChatGPT 账号 (Plus/Pro/Business/Edu/Enterprise 计划内) 或 API key (README.md)                                                                                                         |
| Node 侧要求 | Node >= 22, pnpm >= 10.34.5 (根 package.json engines, 仅用于仓库维护)                                                                                                                 |

产品形态是一个矩阵: 终端里的 Codex CLI (TUI)、非交互的 codex exec、编辑器扩展 (VS Code/Cursor/Windsurf)、桌面应用 (codex app)、云端 agent Codex Web (chatgpt.com/codex)。本仓库是 CLI 及其配套的开源部分 (README.md 开头即这四条入口)。

本地 32 个 commit 的窗口 (e53e932..9552906, 前 21 个的提交时间全部落在 2026-10-01 UTC 02:59-07:08 这几个小时内, 可见上游合入速度) 能看出几条活跃主线: Daybreak 网络安全访问计划在 exec 与 TUI 落地并持久化 (#49856/#49857/#49858/#49859/#49861); 权限与审批模型收紧 — permission grants 绑定发起 turn (#49880)、extension 文件系统访问限定 callback 权限 (#49898)、临时 structured threads 尊重 approval 策略 (#49912); world-state 快照与 context 更新一起返回并持久化 (#49847/#49894); TUI 启动呈现与执行配置解耦、personality 管线移除 (#49875/#49876), usage/credit 链接指向 ChatGPT 设置 (#49874); Windows 侧 daemon 工作目录与提权嵌入模式 (#49850/#49855); 以及 voice 麦克风通道选择 (#49836) 与 TUI keybindings 校验错误保留 (#49910)。在此之上, #49939 (6b4daaf) 给 exec 与 TypeScript SDK 加了逐轮 Cyber 访问计划选择; 本轮 6b4daaf..9552906 的 10 个 commit 集中在安全与执行基础设施: guardian decisions API key 防环境转发 (#50019)、descriptor-safe 可执行测试夹具 helper (#50018)、新 TUI 线程尊重服务端 model defaults (#50013)、async Guardian 历史前缀保留为 retained context changes (#49993)、可续期 EMA HTTP 认证与凭据版本化 (#49987)、exec-server 输出块共享不可变字节缓冲 (#49972)、session index thread-name 增删测试 (#49959)、MCP hook 占位符正则缓存 (#49956)、Guardian sender review 携带前置 assistant 上下文 (#49951)、防止过期文件搜索结果被贴上新查询标签 (#49946)。

## 二、安装与运行 (README.md 与 docs/install.md)

系统要求 (docs/install.md): macOS 12+、Ubuntu 20.04+/Debian 10+、Windows 11 (经 WSL2); Git 2.23+ 可选 (内置 PR helper 用); RAM 最低 4GB、推荐 8GB。

```bash
# macOS / Linux (README.md)
curl -fsSL https://chatgpt.com/codex/install.sh | sh
# Windows
powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"
# 强制走 GitHub Releases 而非 releases.openai.com
curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_INSTALLER_USE_RELEASES_OPENAI_COM=false sh
```

安装器默认从 https://releases.openai.com/codex 下载, 元数据或资产不可用时回退 GitHub Releases (README.md)。GitHub Release 里每个平台一个 tar.gz (如 codex-aarch64-apple-darwin.tar.gz), 包内是单个带平台后缀的可执行文件; 另外提供 DotSlash 文件 (docs/install.md) — 一个轻量提交进源码库的可执行文件描述, 保证所有贡献者跨平台用同一版本的二进制。

日志与诊断 (docs/install.md): Codex 遵循 RUST_LOG 环境变量; TUI 默认只把诊断记在有界本地存储里, codex -c log_dir=./.codex-log 显式开启明文日志 (codex-tui.log); 非交互模式 codex exec 默认 RUST_LOG=error 且消息内联打印。

## 三、仓库结构: Bazel 优先的 Rust monorepo + 双 SDK

顶层布局 (本机完整工作树实测):

| 路径                                                   | 内容                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| codex-rs/                                              | Rust 代码; Cargo workspace 的 members 显式列出 155 个路径 (codex-rs/Cargo.toml, 含 exec-server/tests/support 等测试支持 crate), chatgpt、message-history、windows-sandbox-rs 三个 crate 不在显式列表而以 path 依赖并入; 磁盘上共 156 个含 Cargo.toml 的 crate 目录 (顶层 111 + ext/ 16 + utils/ 27 + memories/ 2) |
| sdk/typescript                                         | @openai/codex-sdk, TypeScript SDK (tsup 构建, jest 测试)                                                                                                                                                                                                                                                          |
| sdk/python                                             | openai-codex, Python SDK (uv_build 构建, pydantic>=2.12)                                                                                                                                                                                                                                                          |
| sdk/python-runtime                                     | Python SDK 的运行时伴生包 (hatch_build.py)                                                                                                                                                                                                                                                                        |
| codex-cli/                                             | npm 包 @openai/codex 的包装层: bin/codex.js 加少量脚本, engines node>=16                                                                                                                                                                                                                                          |
| docs/                                                  | 15 个 md; 多数是 150-730B 的跳转存根 (sandbox.md、execpolicy.md、authentication.md、getting-started.md 等), 实质内容是 install.md、contributing.md、CLA.md、config.md 的 lifecycle hooks 段与 open-source-fund.md                                                                                                 |
| bazel/ + MODULE.bazel + defs.bzl + .bazelrc + patches/ | Bazel 构建体系: rules_rust 定制、33 个第三方补丁 (rules_rust Windows MSVC/gnullvm、rusty_v8、llvm、webrtc-sys 等); codex-rs/docs/bazel.md 自述该体系仍属实验性, Cargo 是 crate 与 feature 的事实源                                                                                                                |
| justfile + scripts/ + tools/                           | Cargo 开发流 (just fmt/fix/test/bench, justfile:50-105) 与发布/打包/调试脚本 (run_tui_with_exec_server.sh、mock_responses_websocket_server.py、mcp_conformance/、test-remote-env.sh 等); tools/ 下有自研的 argument-comment-lint 与 buildifier                                                                    |
| announcement_tip.toml                                  | TUI 公告机制: [[announcements]] 按序求值、最后一条命中者展示; 字段 content/version_regex/from_date/to_date/target_app (cli、vsce 等), version_regex 匹配 env!("CARGO_PKG_VERSION")                                                                                                                                |

旧快照里的 ".codex/ 仓库自用配置 (environments + 11 个 skills)" 一行已随目录删除而失效, 见第一节。

crate 现在可以直接对照源码归类 (不再依赖文档/脚本间接推断):

| crate                                                                                                                                                               | 源码依据                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| core / cli / tui / exec                                                                                                                                             | 主引擎、CLI 入口、终端 UI、非交互执行; core/tests/suite/ 是集成测试主战场, tui/Cargo.toml 依赖 insta 做快照测试                                                                                                                                                                                                                                                                                                                                                       |
| app-server 家族                                                                                                                                                     | app-server、app-server-client、app-server-daemon、app-server-protocol (+ noop-macros/test-client/transport); daemon 的 README 自述 experimental, 支撑 `codex app-server` 生命周期命令, 面向 SSH 拉起的桌面/移动端远程客户端                                                                                                                                                                                                                                           |
| exec-server / exec-server-protocol                                                                                                                                  | 命令执行内核与其协议 (配合 scripts/run_tui_with_exec_server.sh, 见第五节)                                                                                                                                                                                                                                                                                                                                                                                             |
| codex-mcp / rmcp-client / hooks                                                                                                                                     | MCP 支持、RMCP 客户端、lifecycle hooks (hooks 带 bin/write_hooks_schema_fixtures.rs, 即根 package.json write-hooks-schema 脚本的目标); rmcp-client 同时是企业 MCP 认证 (EMA) 的落点 — ema_http_client.rs 实现可续期、端点限定的资源 bearer, oauth/ 下有 enterprise OAuth 登录与凭据版本文件 (enterprise-generation / enterprise-credential-version, #49987); MCP hook 参数展开的 `${...}` 占位符正则以 LazyLock 静态缓存 (hooks/src/engine/mcp_runner.rs:125, #49956) |
| codex-api                                                                                                                                                           | Responses API 与 Realtime 客户端: src/endpoint/ 下 responses.rs、responses_websocket.rs、realtime_call.rs、realtime_websocket/、models.rs、images.rs、search.rs、session.rs、memories.rs; SSE 解析在 sse/responses.rs; 另有 rate_limits.rs、auth.rs、safety_buffering.rs                                                                                                                                                                                              |
| code-mode / code-mode-runtime / code-mode-host / code-mode-protocol                                                                                                 | 内嵌 JS 运行时一线: code-mode-runtime 依赖 deno_core_icudata (Cargo.toml:19, 即 Deno core = V8 + ICU), 佐证是 patches/ 里成组的 rusty_v8/v8/libwebrtc 补丁                                                                                                                                                                                                                                                                                                            |
| memories/read + memories/write                                                                                                                                      | 记忆管线读写路径 (crate 名 codex-memories-read / codex-memories-write, 详见第六节; memories/README.md 仍是仓库内最完整的架构文档)                                                                                                                                                                                                                                                                                                                                     |
| login / workload-identity / keyring-store / secrets                                                                                                                 | 登录、workload identity、密钥存储与脱敏                                                                                                                                                                                                                                                                                                                                                                                                                               |
| sandboxing / mxc-sandbox / linux-sandbox / bwrap / windows-sandbox-rs / windows-sandbox-service / shell-escalation / shell-command / execpolicy / process-hardening | 沙箱与执行策略全家桶 (详见第七节)                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ext/ (16 个)                                                                                                                                                        | 扩展体系: extension-api (扩展 API 定义)、skills、image-generation、mcp、memories、web-search、connectors、goal、queue、items、agent、agent-message-board、git-attribution、guardian-reviewer、guardian-v2、history-notes                                                                                                                                                                                                                                              |
| utils/ (27 个)                                                                                                                                                      | 微工具 crate 群: absolute-path、approval-presets、audio、pty、json-to-toml、output-truncation、stream-parser、template 等                                                                                                                                                                                                                                                                                                                                             |
| voice-host / realtime-webrtc                                                                                                                                        | 语音会话: voice-host 有 30 个 src 文件, input_channel.rs 实现 #49836 的麦克风通道选择 (校验通道可用性后混音, 显式选择不回退其他通道); WebRTC 实时通道在 realtime-webrtc                                                                                                                                                                                                                                                                                               |
| thread-store / message-history / responses-api-proxy / websocket-client / state / rollout                                                                           | 会话存储、消息历史、Responses API 代理、WebSocket 客户端、状态 DB、rollout 记录                                                                                                                                                                                                                                                                                                                                                                                       |
| file-search / file-system / file-watcher / git-utils / terminal-detection / worktree                                                                                | 文件搜索、文件系统、文件监视、git 工具、终端探测、worktree                                                                                                                                                                                                                                                                                                                                                                                                            |
| cloud-tasks (+client/mock-client) / ollama / lmstudio / analytics / otel / build-info / tcp-tunnel / stdio-to-uds / external-agent-migration                        | 云任务、本地模型 (Ollama/LM Studio)、分析与遥测、构建信息、TCP 隧道、stdio→Unix socket 转发、外部 agent 迁移                                                                                                                                                                                                                                                                                                                                                          |

根 package.json 的 devDependencies 仍只有 prettier, 印证 Node 工具链在这个仓库只承担维护性工作; 但它新增了一组 resolutions/overrides 把 esbuild、rollup、hono、handlebars、path-to-regexp 等间接依赖钉到具体版本 (供应链治理)。write-hooks-schema 脚本 (cargo run -p codex-hooks --bin write_hooks_schema_fixtures) 引用的 crate 现在就在磁盘上 (codex-rs/hooks), 旧文档 "引用了本机不存在的 crate" 的说法作废; 产品侧 hooks 治理见 docs/config.md: 管理员可在 requirements.toml 设 allow_managed_hooks_only = true, 忽略用户/项目/会话级 hook 配置, 只允许 managed hooks; 该设置只认 requirements.toml, 放 config.toml 无效 (这条是 config.md 存根里唯一保留的正文)。

## 四、TypeScript SDK: @openai/codex-sdk

这是 TS/JS 开发者接入 Codex 的正门。架构一句话: SDK 不做协议实现, 它 spawn @openai/codex 的 codex CLI 子进程, 通过 stdin/stdout 交换 JSONL 事件 (sdk/typescript/README.md 原文; 实现见 src/exec.ts — spawn 来自 node:child_process, 固定参数 `exec --experimental-json`)。Node 18+ 即可 (package.json engines)。

src/ 只有 10 个文件: codex.ts (Codex 客户端, startThread/resumeThread 在 :25/:36)、thread.ts (Thread)、events.ts / items.ts (事件与条目类型)、exec.ts (子进程执行)、codexOptions.ts / threadOptions.ts / turnOptions.ts (三层选项)、outputSchemaFile.ts、index.ts。devDependencies 里有 @modelcontextprotocol/sdk 与钉死 commit 的 @modelcontextprotocol/conformance — tests/mcpConformance.test.ts 跑 MCP 官方一致性套件。

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

值得 TS 开发者抄作业的设计点 (本轮已逐条对照源码复核):

1. 结构化输出走 JSON Schema: thread.run(prompt, { outputSchema }) 让 agent 产出符合 schema 的 JSON, schema 经 outputSchemaFile.ts 落成临时文件传给 CLI; 官方示例直接给 Zod 用户指路 zod-to-json-schema 并设 target: "openAi" (README 与 samples/structured_output_zod.ts)。
2. 多模态输入是判别联合: run([{ type: "text", text }, { type: "local_image", path }]) (thread.ts:34), 文本条目拼接成最终 prompt, 图片条目转成 CLI 的 --image 参数 (exec.ts:179)。
3. 线程可恢复: 会话持久化在 ~/.codex/sessions (README), 丢失内存对象后用 codex.resumeThread(savedThreadId) 重建继续跑。
4. 环境控制面向 Electron 等沙箱宿主: new Codex({ env }) 完全接管子进程环境变量, SDK 再把必需变量叠加回去 (apiKey 落成 env.CODEX_API_KEY, exec.ts:197); baseUrl 转成 --config openai_base_url=... 覆盖 (exec.ts:109)。
5. 配置覆盖有两层: config 对象被展平成点路径、值序列化为 TOML 字面量后作为重复的 --config key=value 传入 (exec.ts 的 serializeConfigOverrides → flattenConfigOverrides); 无法用点路径表达的键走用户侧 configOverrides (string[], 在 CodexExec 内部即 rawConfigOverrides) 原样透传 (README 示例即 'permissions.audit.filesystem={":root"="read",...}'), 且在展平项之后应用; SDK 自管设置 (baseUrl、model、approvalPolicy 等) 最后应用、优先级最高 (exec.ts:95-171 的参数拼装顺序)。
6. 工作目录默认必须是 Git 仓库 (避免不可恢复错误), skipGitRepoCheck: true 可跳过检查 (exec.ts:28,138)。
7. 网络安全访问计划可逐轮选择 (#49939 的 SDK 部分): CyberAccessProgram = "standard" | "daybreak_blue" | "daybreak_red" (turnOptions.ts:1), thread.run(prompt, { cyberAccessProgram }) 经 thread.ts:89 落到 CLI 的 --cyber-access-program (exec.ts:146-148), 与第一节 Daybreak 主线呼应。

samples/ 目录提供 basic_streaming.ts、structured_output.ts、structured_output_zod.ts 三个可运行示例 (外加共用的 helpers.ts)。

Python SDK (openai-codex) 是同一套模型的镜像 (sdk/python/src/openai_codex/api.py): Codex 类 (:78) → thread_start() (:135) → thread.run() 返回 TurnResult (final_response/items/usage, _run.py:31), 另提供 login_api_key、login_chatgpt (浏览器 OAuth, :118) 与 login_chatgpt_device_code (设备码, :122) 三种显式登录, 且同步/异步双客户端并存; 它把 CLI 二进制作为依赖包 openai-codex-cli-bin 钉版本分发 (pyproject.toml: openai-codex-cli-bin==0.153.4, 并用 exclude-newer-package 钉住解析时点) — 这也是我们确定当前 CLI 版本号的依据。

## 五、协议化架构: app-server 与 exec-server

Codex 内部不是单体: TUI、IDE 扩展、桌面 app 都通过协议与 agent 内核通信。旧快照里这套 API 的开发规范写在根 AGENTS.md, 该文件现已删除; 好在规范本身几乎每条都能在 codex-rs/app-server-protocol 源码里直接验证, 这一节的事实来源已全部改为源码。先说一个实现细节: rpc.rs 开头注释明言 "We do not do true JSON-RPC 2.0" — 双方都不发送也不期待 "jsonrpc": "2.0" 字段, 是 JSON-RPC 风味的自定义线协议。

从源码可确证的 v2 规范:

- 版本分界: v1 收敛在单文件 protocol/v1.rs, v2 按资源拆成 40 多个文件 (account、thread、item、mcp、model、permissions、config 等), 演进重心在 v2 一目了然。
- 方法命名 <resource>/<method> 且 resource 用单数: protocol/common.rs 的方法注册表里有 ThreadRead => "thread/read" (:852)、AppsList => "app/list" (:966)。
- 载荷命名 *Params (请求) / *Response (响应) / *Notification (通知), 如 common.rs:2000 的 AppListUpdated => "app/list/updated" (v2::AppListUpdatedNotification)。
- 线上字段一律 camelCase: v2 类型普遍标注 serde(rename_all = "camelCase") 加 ts-rs 的 ts(export_to = "v2/") (如 v2/thread.rs:48-49), 生成的 TypeScript 落在 app-server-protocol/schema/typescript/v2/ (另有 schema/json 与 schema/precomputed fixture); 唯一例外是 config RPC 用 snake_case 以镜像 config.toml 键名 (v2/config.rs 多处 serde(rename_all = "snake_case"))。
- 判别联合在两侧都用显式 tag: serde(tag = "type") 对应 ts(tag = "type") (v2/item.rs:127-128) — 生成的 TS 就是可 switch 的 discriminated union。
- 时间戳一律 Unix 秒整数、命名 *_at: v2/account.rs 的 created_at/resets_at (:476/:757), v2/current_time.rs:17 注释 "Current time as whole Unix seconds"。
- list 方法默认游标分页: 响应带 next_cursor (v2/apps.rs:262、mcp.rs:106、model.rs:182、permissions.rs:422 等)。
- 实验性 API 有字段级门控: experimental_api.rs 定义 ExperimentalApi trait (experimental_reason 返回短标识) 并集中注册实验字段。
- 布尔字段表达"缺省即 false"用 serde(default, skip_serializing_if = Not::not) 而非 Option<bool>: Not::not 仍见于 v2/apps.rs、v2/remote_control.rs 等处。
- Schema 变更必须重新生成 fixture: justfile:177 的 write-app-server-schema recipe, 对应 crate 内 schema_fixtures.rs / schema_fixtures_tests.rs。

旧 AGENTS.md 中无法再从当前仓库复核的条目 (ID 一律用 plain String、v2 禁止 skip_serializing_if = "Option::is_none" 等) 在此标注为历史记录, 不再作为现状陈述。

exec-server 是另一条协议线: scripts/run_tui_with_exec_server.sh 展示了完整拓扑 — 先 cargo run -p codex-cli --bin codex -- exec-server --listen ws://127.0.0.1:0 启动执行服务器 (监听地址可用 CODEX_EXEC_SERVER_LISTEN_URL 覆盖), 从 stdout 第一行读出实际绑定的 ws URL, 再以 CODEX_EXEC_SERVER_URL=<url> 启动 codex-tui。也就是说 TUI 与命令执行内核之间走 WebSocket, 二者可以分离部署; 旧快照中 "app-server 与 exec-server 可跑在不同操作系统上" 的表述出自已删除的 AGENTS.md 与 .codex/skills/remote-tests, 现在仓库内的对应物是 scripts/test-remote-env.sh — 远程环境集成测试的 source-only 脚本 (用法: source 后 just test -p codex-core --test all remote_test_env_can_connect_and_use_filesystem)。scripts/ 里还有 mock_responses_websocket_server.py 与 mcp_conformance/ 目录, 分别用于 mock Responses API 的 WebSocket 与跑 MCP 一致性测试。协议层的字节传输本轮刚做过一次共享化 (#49972): 进程输出块的载荷类型是 ByteChunk — Arc<Vec<u8>> 包装的共享不可变字节, 线上编码为 base64 (exec-server-protocol/src/protocol.rs:63-66), 于是 retained 输出在 process/read 重放与事件分发各层之间克隆的是引用而不是缓冲区本身; 本地进程侧的保留回放另有条数与字节双上限 (local_process.rs 的 RETAINED_OUTPUT_CHUNKS_PER_PROCESS = 50_000)。

对模型的上下文注入, 旧 AGENTS.md 定过五条硬规则 (不改写历史、避免频繁变更上下文导致 prompt cache miss、注入条目必须有界、单条目不超过 10K tokens、可能超过 1k tokens 的新条目按 P0 高亮人工评审), 该文件已删除, 五条规则作为历史记录保留。类型化约束本身仍在: ContextualUserFragment trait 现定义于独立的 context-fragments crate (codex-rs/context-fragments/src/fragment.rs:64), 注入上下文的片段要实现它 — 类型系统兜底防止随手塞字符串进上下文。core 里的 world_state 各 section (agents_md、environment、collaboration_mode 等) 都走这条路径, 且 #49894 (08a7031) 刚把 section 的 render_diff 改为返回类型化 SectionTransition, 让 world-state 快照与模型上下文片段一起产出、可分别缺省。

## 六、Memories 子系统: 两阶段记忆管线

codex-rs/memories/README.md 是仓库里最完整的架构文档, 描述了 Codex 的长期记忆如何离线生成与固化。运行时编排在上游 codex-core/src/memories/, 本目录提供可复用的读写 crate 与提示词模板 (read/templates/memories/read_path.md、write/templates/memories/{stage_one_system, stage_one_input, consolidation}.md, 模板与使用它的 crate 放在一起; 无日期后缀的模板即运行时使用的最新版)。

触发条件: 根会话启动时, 且会话非 ephemeral、记忆功能开启、不是子 agent 会话、state DB 可用; 全程后台异步执行, Phase 1 完成后接 Phase 2。

Phase 1 (Rollout Extraction, 按线程并行): 从 state DB 里按启动认领规则挑选合格的 rollout — 来源限于允许的交互会话、在配置的年龄窗口内、闲置足够久 (避免总结仍在活跃的会话)、未被其他 in-flight worker 认领、在启动扫描/认领上限内。每个 rollout 过滤出记忆相关的 response items 后送模型 (并行, 有并发上限), 期望结构化输出三件套: 详细 raw_memory、紧凑 rollout_summary、可选 rollout_slug; 生成的字段做密钥脱敏后写回 state DB。任务结果分 succeeded / succeeded_no_output / failed (带重试退避), 认领用 DB lease 防重复劳动。

Phase 2 (Global Consolidation, 全局串行): 先拿全局锁, 再按选择规则从 DB 载入有界的 stage-1 输出 (忽略超出 max_unused_days 未使用的记忆; 无使用记录的按 generated_at 兜底; 排序按 usage_count 优先、再按最近使用/生成时间), 然后同步文件系统工件:

- raw_memories.md — 合并的原始记忆, 按 thread-id 升序稳定排列 (避免 usage 排名变化引起 diff 抖动);
- rollout_summaries/ — 每个入选 rollout 一个摘要文件, 落选的剪枝; 同时清理超出 extension 保留窗口的记忆扩展资源文件, 让清理动作也进入 workspace diff;
- phase2_workspace_diff.md — 从上次成功 Phase 2 基线到当前工作树的 git 风格 diff。

记忆根目录本身是一个 git 基线目录 (~/.codex/memories/.git, 由 codex-git-utils 初始化), 脏检查用 git 工作树状态而非 DB watermark。若工作树有变化, 就 spawn 一个内部整合子 agent: 提示词带上 diff 文件路径, 运行约束是"无审批、无网络、仅本地写", 并禁用 collab 防止递归委派; 主流程监视 agent 状态并给全局 lease 发心跳; agent 成功后重置 git 基线 (diff 文件先删除, 避免不可达 git 对象), 最后在 DB 记录成败与新的完成 watermark (取 claimed watermark 与实际载入输入的最新 source_updated_at 的较大者, 保证 watermark 不回退)。更高层的整合产物 (MEMORY.md、memory_summary.md、skills/) 留给这个 agent 更新; 入选的 stage-1 快照会被标记 selected_for_phase2 = 1 作为下次 diff 的基线。

两阶段拆分的理由写得很直白: Phase 1 面向大量 rollout 水平扩展并产出规范化的每 rollout 记忆记录; Phase 2 把全局整合串行化, 保证共享记忆工件被安全一致地更新。

## 七、沙箱与安全

沙箱环境变量现在可以直接看源码: codex-rs/core/src/spawn.rs 定义 CODEX_SANDBOX_NETWORK_DISABLED_ENV_VAR, :24 的注释说明 CODEX_SANDBOX 在 macOS 上取值 "seatbelt"; codex-rs/core/src/sandboxing/mod.rs:172,178 在网络禁用时向沙箱子进程环境插入这两个变量; core/src/exec.rs:915 的注释重申沙箱内 spawn 会带 CODEX_SANDBOX_NETWORK_DISABLED=1。旧 AGENTS.md 里 "禁止新增或修改与这两个环境变量相关的代码 (集成测试用它们判断能否在沙箱内自举运行)" 的规则随文件删除, 作为历史记录保留 — core/tests 里确实仍大量出现这两个变量。

另有一类 "绝不能到达模型的环境变量": protocol/src/shell_environment.rs:14-21 的 NON_INHERITABLE_ENV_VARS 清单当前有六项 — CODEX_EXEC_SERVER_NOISE_AUTH_TOKEN、NODE_REPL_AUTH_TOKEN、CODEX_GUARDIAN_DECISIONS_API_KEY 与 OPENAI_FEDERATION_RULE_ID / OPENAI_IDENTITY_TOKEN_FILE / OPENAI_WORKLOAD_IDENTITY_CONTEXT。scrub_non_inheritable_env_vars (:34-51) 在 spawn 前把它们从进程环境与显式覆盖里一并剥掉, 调用点覆盖 shell 快照启动、exec-server 子进程传输、git 操作 (git-utils、worktree)、hooks 注册表、shell-escalation 与 code-mode 远程会话; populate_env 还在策略求值的最后一步剥一次 (:156-158), 用户用 shell_environment.set 也无法把它们恢复回来。本轮 #50019 就是把 Guardian 决策服务的 API key 补进这份清单, 堵住它经环境变量转发进模型可达子进程的路径 (exec-server/tests/http_request.rs 有对应的 route-aware HTTP client 测试)。

crate 层面的沙箱矩阵比旧文档记载的更完整: linux-sandbox 与 bwrap (Linux 气泡wrap 沙箱)、mxc-sandbox (Windows MXC)、windows-sandbox-rs 与 windows-sandbox-service (Windows 沙箱及其服务)、sandboxing (统一编排)、shell-escalation (提权)、execpolicy (执行策略)、process-hardening、network-proxy、guardian-context。Windows 沙箱纳入托管要求 (managed requirements) 治理: codex-rs/config/src/config_requirements.rs 的 WindowsRequirementsToml 有可选项 allow_mxc (:874, doc 注释原文 "False blocks both explicit MXC configuration and automatic selection"), 设为 false 时既禁止自动选择 MXC 也拒绝显式的 windows.sandbox = "mxc" 配置, 约束求值把要求来源带进错误信息 (:1920-1990), 行为测试在 :3836 起。(引入该字段的 PR #49642 出自上一个完整克隆的历史, 不在本机浅历史中, 此处仅以现存源码为据。) 执行策略与沙箱/审批的产品文档都是跳转存根: docs/sandbox.md 指向 developers.openai.com/codex/security, docs/execpolicy.md 指向 /exec-policy, 仓库内不保留正文。

审批/权限模型是这个 commit 窗口的活跃地带, 三条可感知的收紧: #49880 (1f52d40) 把 turn 级 permission grants 与 strict review 状态移进 TurnContext (codex-rs/core/src/session/turn_context.rs), 后台 code-mode cell 与其发起 turn 的授权绑定, 不再因新 turn 开始而丢失或误用他 turn 的权限, 会话级 grants 仍跨 turn 共享; #49898 (da2e174) 让 extension 的文件系统访问限定在 callback 捕获的 EnvironmentAccess 内 (core/src/session/step_context.rs、ext/skills、ext/image-generation), skill 分页快照绑定 EnvironmentAccessKey; #49912 (444da31) 让 TUI 的临时 structured threads 继承 app server 的 approval 策略而非强制 never, 并在动态工具与交互式路由之前拒绝这类隐藏线程的意外交互请求 (tui/src/temporary_structured_request.rs)。Guardian 审查链本轮也在继续收敛: sender review 交付时携带至多三条最近用户消息及其前置 assistant 上下文 (core/src/context/guardian_sender_messages.rs — reviewer-only、入场时渲染一次、绝不进 worker prompt, assistant 消息只作为不可信上下文而非授权; 两个 reviewer 消费同一份 host 渲染的 sender 证据, guardian-context/src/sender_user_messages.rs, #49951); async Guardian 的历史前缀改为以 retained context changes 保留 (history crate 的 RetainedContext / RetainedContextEvent, guardian-v2 async_scorer 消费, #49993)。

Windows 支持的矛盾点依旧: install.md 要求 Windows 11 走 WSL2, 但 patches/ 里有大量 Windows 原生工具链补丁 (rules_rust MSVC 直连参数、abseil gnullvm、llvm windows arm64、rusty_v8 自定义 libcxx、windows-link、windows-support-native-tools 等), 本窗口的 #49850/#49855 还在继续修 Windows daemon 工作目录与提权 TUI 嵌入模式 — 代码库在为原生 Windows 铺路, 安装文档暂时保守。旧 AGENTS.md "测试与特性必须支持 Linux、macOS 和 Windows" 的要求已随文件删除, 作为历史记录保留。

## 八、工程规范: 从 AGENTS.md 到源码可证的纪律

旧快照中这份 22KB 的根 AGENTS.md (反单体、非机械性变更不超过 800 行、模块 500 LoC 目标、测试分层、破坏性变更五类清单等) 已从仓库删除, 上述具体条目在本机无法复核, 只能作为历史记录引用。当前仓库里 agent 可读的规范散落在三处: codex-rs/tui/src/bottom_pane/AGENTS.md (要求改 paste-burst/chat-composer 状态机时同步模块文档, 文档只准提及代码中真实存在的 API/行为); codex-rs/docs/bazel.md (Bazel 体系自述: 截至 2026-06-01 仍属实验性, Cargo 是 crate 与 feature 的事实源, defs.bzl 的 codex_rust_crate 包装 rust_library/rust_binary/rust_test); codex-rs/docs/protocol_v1.md (核心协议术语表: Codex/Session/SQ/EQ 提交与事件队列模型)。

工程纪律中仍能从源码与 justfile 直接验证的部分:

- 开发流入口是 justfile: fmt/fmt-check/fix/test/bench (:50-105), 测试经 cargo-nextest 驱动 (docs/install.md 要求 cargo install --locked cargo-nextest)。
- Bazel/Cargo 双构建的锁纪律: 改 Rust 依赖要 just bazel-lock-update 刷新 MODULE.bazel.lock (justfile:144), CI 侧用 bazel mod deps --lockfile_mode=error 检查漂移, 报错信息直接教人跑 just bazel-lock-update (justfile:154)。
- 协议 schema 回归: just write-app-server-schema (justfile:177) 重新生成 app-server-protocol/schema/ 下的 json/typescript fixture。
- 测试分层的实物证据: core/tests/suite/ 的集成测试群配 test_codex builder (core/tests/common/test_codex.rs) 与 ResponseMock (core/tests/common/responses.rs:40, 用于断言出站 /responses 请求); tui 依赖 insta (tui/Cargo.toml:183) 做快照测试; 独立 *_tests.rs 测试模块的模式在仓库里随处可见 (agents_md_tests.rs、tui_keymap_chord_tests.rs 等)。
- 供应链治理: 根 package.json 的 resolutions/overrides 钉死间接依赖版本, sdk/python/pyproject.toml 用 exclude-newer-package 钉住 CLI 二进制包的解析时点。

## 九、贡献模式

docs/contributing.md 明确: 不接受外部代码贡献与 PR, 社区贡献聚焦 issue — bug 报告、复现步骤、日志、根因分析、设计讨论。给出的理由: 有效变更需要架构上下文、系统级约束理解和路线图视野, 外部 PR 常聚焦低优先级问题且磨合成本高于直接实现; "理解问题、找对方案、排定优先级才是难的部分, 实现本身在 Codex 的帮助下相对简单" (原文: implementation is comparatively straightforward with the help of Codex itself)。安全漏洞走 SECURITY.md 私密通道。另有 docs/open-source-fund.md: 100 万美元开源基金, 单项最高 25,000 美元 API credits, 滚动评审。

旧快照里与之对照的 ".codex/skills/ 下 11 个自用 skill" 已随 .codex/ 目录一起删除, 无法再复核; "用 agent 维护仓库" 的现存痕迹是 justfile/scripts 的高度脚本化、tools/argument-comment-lint 这类自研 lint, 以及 codex-rs/tui/src/bottom_pane/AGENTS.md 这种写给 agent 的模块规范。

## 十、小结: TS/JS 开发者视角的要点

1. 接入路径清晰: 应用内嵌用 @openai/codex-sdk (spawn CLI + JSONL stdio), 脚本化用 codex exec, 更深的集成走 app-server (JSON-RPC 风味的 v2 协议) 或 exec-server WebSocket。
2. SDK 的"包装 CLI"策略值得学: 不重新实现协议, 用子进程 + 结构化事件流换来与 CLI 版本演进解耦; Python SDK 进一步把 CLI 二进制做成钉版本的依赖包。
3. app-server v2 规范是一份能直接跑在源码上的跨语言 API 设计 checklist: camelCase 线上格式、判别联合显式 tag、Unix 秒 *_at 时间戳、游标分页、experimental 字段级门控、schema fixture 回归 — 全部可在 codex-rs/app-server-protocol 里逐条找到实现。
4. 上下文工程的可移植经验: ContextualUserFragment 类型化约束 (context-fragments crate) 与 world-state section 的 SectionTransition 契约 (#49894); 旧 AGENTS.md 的五条注入硬规则 (增量、防 cache miss、有界、10K 上限、1k 以上 P0 评审) 作为历史记录仍有参考价值。
5. 记忆管线的两阶段设计 (并行提取 + 串行整合, DB lease + git 基线 + watermark) 展示了如何把"长期记忆"做成可审计的文件系统工件而非黑盒向量库; memories/README.md 是仓库内最好的架构文档。
6. 本机快照现在是完整工作树, 结构类结论都能直接对照源码复核; 但浅历史只有 32 个 commit 的窗口 (e53e932..9552906), 且根 AGENTS.md 与 .codex/ 在基点之前已被删除 — 涉及仓库工程文化或更早演进的问题, 需要 unshallow 或查 GitHub 上的历史。
