---
title: "CodeGraph 深度解析: 给 AI 编码 Agent 的本地代码知识图谱"
description: "基于本机克隆源码逐条核实的 CodeGraph 调研快照: tree-sitter 双引擎抽取、SQLite 知识图谱、MCP 工具面设计、Rust 原生内核与企业落地分析"
---

本机器位置 $HOME/Downloads/codegraph

复核说明: 本文首次调研于 2026-08-12、2026-08-26 复核; 2026-09-30 对照克隆 (HEAD 791ae39) 逐条重新核实; 2026-10-01 克隆两次 pull, 先到 aa0c73c、再前进到 HEAD 34ede4de (自 791ae39 以来新增 74 个 commit, #2170~#2248, 全部是解析精度修复, 逐条记入 CHANGELOG Unreleased 段落; package.json 版本仍为 1.6.1), 下文所有关于仓库结构、文件路径、行数的论断均以该克隆当前代码为准; 时点性数据 (star 数、基准、发布日期) 保留原时点标注.

## 一、项目快照 (截至 2026-08-26)

CodeGraph (colbymchenry/codegraph) 是 2026 年 1 月 18 日由独立开发者 Colby McHenry 创建的开源项目, 他在 Medium 个人介绍中自我描述为自学软件工程师. 项目定位是给 AI 编码 agent 做"前置索引"的本地 MCP 服务器: 预先把代码库的符号、调用边、依赖关系构建成一张知识图谱, 让 agent 一次查询拿到精确上下文, 而不是用 grep + Read 逐文件爬. 创建后 4 个月登上 GitHub Trending 前列 (5 月 23 日单日新增 2,434 star) .

仓库当前状态 (GitHub API, 2026-08-26) :

| 指标         | 数值                                                                |
| ------------ | ------------------------------------------------------------------- |
| stars        | 68,137                                                              |
| forks        | 4,336                                                               |
| contributors | 42                                                                  |
| open issues  | 448                                                                 |
| 创建时间     | 2026-01-18                                                          |
| 最近推送     | 2026-08-25                                                          |
| 当前版本     | v1.5.0 (2026-07-21 发布, "The Rust engine release")                 |
| License      | MIT                                                                 |
| npm 包       | @colbymchenry/codegraph                                             |
| 官网/文档    | colbymchenry.github.io/codegraph (Astro/Starlight, 仓库 site/ 目录) |
| 托管产品候补 | getcodegraph.com (README 顶部 "The CodeGraph platform is coming")   |

上表为 2026-08-26 时点数据. 同日 v1.6.0 发布 (CHANGELOG 标注 2026-08-26) , 9 月 29 日 v1.6.1 发布 (前端路由导航图谱、explore 条件标注与大量解析精度修复) , 本机克隆于 2026-09-30 pull 到 v1.6.1 之后的 main (HEAD 791ae39) , 2026-10-01 两次 pull, 先到 aa0c73c、再前进到 34ede4de——两批共新增 74 个 commit (#2170~#2248) , 全部是尚未随版本发布的解析精度修复; 后一批 63 个 commit 的构成是 60 个 fix、1 个 perf (成员类型推断只读一次类成员行, #2181) 与 2 个 ui-server 测试调整, 正文结构描述均按克隆当前代码核实.

技术栈: TypeScript (主程序) + Rust (原生解析内核 codegraph-kernel) + SQLite (Node 内建 node:sqlite) . 没有 Neo4j、没有向量数据库、索引链路没有任何 LLM 调用. 支持 Windows / macOS / Linux 共 6 个平台架构组合, 自 0.9.0 起捆绑自己的 Node 运行时 (当前捆绑 Node 24) , 裸机无需安装 Node.js.

已适配的 agent (README, 共 9 个产品、11 个安装目标) : Claude Code、Cursor、Codex CLI、opencode、Hermes Agent、Gemini CLI、Antigravity IDE、Kiro、GitHub Copilot (VS Code / CLI / JetBrains 三个变体) .

从 5 月底 (约 29.1k stars、v0.9.4) 到 8 月下旬 (68k stars、v1.5.0) , 近三个月里项目完成了三次质变: 6 月 12 日 1.0.0 引入遥测与 MCP 工具面收窄; 7 月 7 日 1.3.0 把语言数从 22 扩到 30+ (含 COBOL、VB.NET、ArkTS、CUDA、Solidity、Terraform) ; 7 月 21 日 1.5.0 上线 Rust 原生解析内核; 8 月 26 日 1.6.0 以可靠性修复与 explore 回答质量为主 (GitHub Copilot 三变体支持、explore 会话内去重、索引漂移修复、WAL 泄漏修复) ; 9 月 29 日 1.6.1 把 Expo Router、Next.js、React Router、TanStack Router、Vue Router/Nuxt、SvelteKit 的页面与导航拉进图 (routes 节点与 navigates 边) , Flow 的每一跳开始携带触发条件. 发布节奏极快: 克隆当前 CHANGELOG 共 33 个块 (0.7.6 至 1.6.1 共 32 个版本块, 外加一个内容庞大的 Unreleased 区块, 截至 34ede4de 已累计 134 条解析精度修复条目) , 5 月中旬以来平均约 4 天一个版本.

## 二、它到底要解决什么问题

任何用过 Claude Code 或 Cursor agent 模式的人都见过这一幕: 你问"用户认证流程是怎么走的? ", agent 立刻派出 Explore subagent, 开始 grep、ls、逐段 Read 文件的循环. 作者在 Medium 长文里量化过这件事: "我在自己的项目上计时——60 次 tool call、157,800 tokens、近 2 分钟的探索, Claude 才真正开始处理我的请求. "

CodeGraph 的核心立论是: 这种探索本质上是把"静态结构信息"用 LLM 的工作记忆反复重算. 文件之间的调用、import、继承关系是确定性的、AST 可推导的, 没有任何理由每次会话都让 agent 用 grep 重新发现. 提前算一次、放在本地 SQLite 里、通过 MCP 直接喂给 agent, 就够了.

## 三、架构总览

代码分层管线 (CLAUDE.md "Layered pipeline" 节) :

```text
files → ExtractionOrchestrator (tree-sitter 抽取) → DB (nodes/edges/files)
              ↓
       ReferenceResolver (import 解析、名字匹配、框架模式)
              ↓
       GraphQueryManager / GraphTraverser (callers, callees, impact)
              ↓
       ContextBuilder (面向 AI 的 markdown/JSON 输出)
```

src/ 顶层模块职责 (均经源码核实) :

| 模块              | 职责                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| src/extraction/   | 抽取编排: 文件扫描→解析→入库. 含 wasm 抽取器 (tree-sitter.ts, 7644 行) 、languages/ 下 28 个语言配置、kernel/ 子目录 (Rust 内核路由/加载/解码) 、worker 线程流水线 (parse-pool / parse-worker / store-writer / store-worker) 、SFC 抽取器 (vue/svelte/astro/razor/liquid/mybatis/dfm/cfml)                                                                              |
| src/resolution/   | 引用解析: import-resolver、name-matcher (9594 行) 、动态分发合成器 (callback-synthesizer 4141 行、c-fnptr-synthesizer、goframe-synthesizer、swift-objc-bridge) 、跨层 tier-synthesizer (fetch→路由、队列→消费者、事件→handler) 、七个路由器合成器 (expo-router/next-router/react-router/sveltekit/tanstack-router/vue-router/angular-template) 、frameworks/ 框架解析器 |
| src/db/           | SQLite 层: sqlite-adapter.ts (node:sqlite 薄适配) 、schema.sql、migrations.ts (CURRENT_SCHEMA_VERSION = 11) 、预编译查询 (queries.ts, 4086 行) 、WAL checkpoint 阀门 (wal-valve.ts)                                                                                                                                                                                     |
| src/sync/         | 文件监听与增量同步: watcher.ts (原生 fs.watch) 、watch-policy.ts (WSL2 等禁用策略) 、git-hooks.ts (钩子兜底) 、worktree.ts (git worktree 错位检测)                                                                                                                                                                                                                      |
| src/mcp/          | MCP server: tools.ts (工具定义+Handler, 8452 行) 、Direct/Proxy/Daemon 三种运行模式、查询 worker 池、explore 会话状态/去重/诊断、server-instructions.ts (initialize 响应中的 agent 指引) 、watchdog                                                                                                                                                                     |
| src/graph/        | BFS/DFS 图遍历与图查询管理, 以及多渲染面共享的查询期推导 (named-symbol-flow、dynamic-boundary-report、type-hierarchy、dead-code、branch-guards)                                                                                                                                                                                                                         |
| src/context/      | ContextBuilder: 混合检索 + 图扩展 + markdown/json 格式化                                                                                                                                                                                                                                                                                                                |
| src/search/       | 查询解析 (kind:/lang:/path:/name: 字段过滤) 、停用词/词干/驼峰拆词                                                                                                                                                                                                                                                                                                      |
| src/installer/    | 11 个 agent 安装目标 (targets/registry.ts: claude/cursor/codex/opencode/hermes/gemini/antigravity/kiro/copilot-vscode/copilot-cli/copilot-jetbrains) , MCP 配置写入                                                                                                                                                                                                     |
| src/telemetry/    | 匿名遥测客户端 (index.ts, 584 行)                                                                                                                                                                                                                                                                                                                                       |
| src/bin/          | CLI 入口 codegraph.ts (commander, 2892 行) , 另有 uninstall、node-version-check、fatal-handler 等辅助                                                                                                                                                                                                                                                                   |
| src/ui/           | 终端 UI: shimmer 进度动画与 worker                                                                                                                                                                                                                                                                                                                                      |
| src/ui-server/    | `codegraph ui` 浏览器查看器后端: api/ 只读 JSON 端点 (node/flow/map/screens/steps/deadcode/trails 等) + 静态资源服务, 仅监听 127.0.0.1                                                                                                                                                                                                                                  |
| src/upgrade/      | 自更新: 版本检查与旧二进制清理                                                                                                                                                                                                                                                                                                                                          |
| ui/               | 仓库顶层 Svelte + Vite 查看器前端, 构建产物进 dist/viewer/; 同一份源码以 svelte-package 编译为 @colbymchenry/codegraph-ui 组件库 (private: true, 已准备但未发布)                                                                                                                                                                                                        |
| codegraph-kernel/ | Rust 原生解析内核 (独立 Cargo crate, 编译为 .node 动态库)                                                                                                                                                                                                                                                                                                               |

## 四、核心技术深挖

### 4.1 抽取: tree-sitter 双引擎 (wasm 基线 + Rust 原生内核)

先交代背景. tree-sitter 是 GitHub 2018 年开源的增量解析器生成器, 原本为 Atom 编辑器做代码高亮, 工作就一件事: 把源代码变成语法树 (AST) . 三个特点让它特别受欢迎: 增量解析 (改一行只重算受影响子树) 、容错 (语法错误照样解析, agent 写到一半的代码也能工作) 、纯语法不懂语义 (知道 add(a,b) 是调用, 不知道 add 定义在哪, 不做类型推断、不做跨文件引用解析) .

与之相对的是 LSP (Language Server Protocol) 路线: 微软 2016 年为 VS Code 设计的协议, 把"编辑器 × 语言"的 N×M 问题拆成两半, 语言服务器 (rust-analyzer / pyright / tsserver / clangd) 真正懂类型系统、import resolution、泛型实例化, 能回答"这个调用跳转到哪个定义、这个变量什么类型、谁真正调用了这个函数"这类语义问题, 但通常要求项目能编译、每种语言一个独立服务器进程、大项目首次加载几秒到几十秒.

CodeGraph 选 tree-sitter 是明确的工程权衡: 放弃类型级精度 (obj.foo() 里 obj 到底是哪个类的实例, tree-sitter 答不上来) , 换来三件事——不要求项目可编译、一份 wasm 二进制覆盖所有平台、增量解析快到可以毫秒级响应文件保存. 对面向 agent 的探索性查询工具, 这个折中是合理的.

1.5.0 的关键演进是在 tree-sitter 之上叠加了一层 Rust 原生内核 (codegraph-kernel/) . 动机记录在 docs/design/native-extraction-kernel.md: 作者用排除法测量发现, RAM-backed DB 无效 (parse 是 CPU-bound) 、TreeCursor 重写无效——wasm 路径的成本下限是逐节点 JS-WASM 边界 marshaling, 遍历 AST 时每个节点的 kind、childForFieldName、text 都要跨一次边界. 唯一剩余杠杆是把整个 parse + walk 移到原生侧.

内核的设计一句话概括 (Cargo.toml 描述原文) : "tree-sitter parse+extract with one JS boundary crossing per file"——每个文件只调用一次 extractFile(filePath, content, language), 整个解析和遍历在 Rust 内完成, 返回 5 块扁平类型化 Buffer:

| Buffer             | 内容                                                             |
| ------------------ | ---------------------------------------------------------------- |
| meta (36 字节)     | 版本字节 + 各表计数 + arena 长度 + errors JSON 偏移 + 耗时       |
| nodes (96 字节/行) | 定宽小端行                                                       |
| edges (44 字节/行) | 定宽小端行                                                       |
| refs (40 字节/行)  | 未解析引用                                                       |
| arena              | UTF-8 字符串池, 行内以 (offset, len) 引用, 0xFFFFFFFF 为缺失哨兵 |

NodeKind/EdgeKind 以数组下标过界, 因此 src/types.ts 里 NODE_KINDS/EDGE_KINDS 两个 as const 数组的顺序本身就是线协议的一部分 (只能 append, 不许重排; loader 加载时还会校验内核自带的 kind 表) . 当前 KERNEL_ABI_VERSION = 2 (src/extraction/kernel/layout.ts) . TS 侧的 ParseWorkerPool 已经按文件并行, 每个 worker 线程各自驱动自己的内核调用, 所以内核调用是同步的、不在 Rust 侧重建线程池——这是刻意设计. 还有 direct-to-store 优化: buffer 从 parse worker 直达 store worker 解码, 主线程从不物化逐节点对象.

Spike 数据 (dubbo 仓库 4,048 个 Java 文件、17MB、359 万 AST 节点, Apple M3 Pro) : 现有 7 个 wasm worker 的 parse-loop 耗时 4,700ms; Rust parse+walk 单线程 1,067ms, 多线程 202ms. 即单个原生线程击败整个 7-worker wasm 池 4.4 倍. 落地后的实测 (docs/design/rust-kernel-migration-plan.md, 93KB 的迁移记录) : excalidraw 643 文件抽取 487ms vs wasm 1,255ms (2.6 倍) ; 收益的主战场在 CPU 受限环境——2 核/6GB 容器上 django 快 1.32 倍、prometheus 快 1.46 倍. 文档里也有诚实修正: 多核 Mac 上 dubbo 的瓶颈其实是单写者 SQLite ingest (占 94% wall) , 内核收益集中在 worker CPU 受限场景. resolution/synthesis/frameworks 明确不移植原生——实测仅约 1.4 倍收益, 不值得破坏 2,444 个测试构成的正确性护城河.

内核依赖 (codegraph-kernel/Cargo.toml) : napi 3 (napi-rs) 、tree-sitter 0.25、sha2 (节点 ID 与 TS 侧 generateNodeId 字节一致, 测试钉死) 、regex, 外加 14 个 grammar crate (typescript/javascript/java/python/go/c/cpp/rust/c-sharp/ruby/php/swift/r/luau, 多数精确锁版) 、tree-sitter-language 版本无关 shim, 以及 4 个用 cc 直接编译的 vendored C grammar (kotlin、lua、scala、dart——都因 crates.io 版本不可用或血缘不符而自维护, build.rs 里记录了每份 parser.c/scanner.c 的 sha256 溯源) ; 其中 Kotlin grammar 在 2026-10-01 快照前又打了 scanner 补丁 (wasm 与内核 C 源两侧同步, #2173: 同一行内 infix 函数名后的 e 开头单词不再被误插自动分号, Exposed 的 `eq` 调用因此可解析, docs/grammars/tree-sitter-kotlin.{md,patch} 记录补丁与溯源) , 随后 #2182 又在解析前对 grammar 0.3.8 不认识的更新语法做保偏移的 preParse 重写 (`when` guard、`..<` 区间、multi-dollar 字符串、可空函数类型接收者) , 错误恢复不再把周围的类拆散, 内核与 wasm 解析同一份重写后的文本; unix 目标另加 libc 依赖 (walker 栈守卫的栈边界查询, issue #1581) . release profile 开了 lto + codegen-units=1 + strip.

内核与 wasm 的关系是永久共存、按语言路由 (src/extraction/kernel/index.ts 的 DEFAULT_ROUTED 列出 20 种语言: typescript/tsx/javascript/jsx/java/python/go/c/cpp/rust/csharp/ruby/php/swift/kotlin/r/lua/luau/scala/dart, Metal 和 CUDA 映射到 cpp 路径) . 五种情况回退 wasm:

1. 语言不在路由集
2. 平台没有预编译 .node
3. ABI 不匹配 (loader 校验 abiVersion + kind 表)
4. 解析树含 ERROR 的文件逐文件 defer (UTF-8 与 UTF-16 错误恢复行为不同, wasm 的恢复是 canonical, 一般代码发生率 0-0.42%, C/C++ 宏密集代码可达 10-40%)
5. 内核调用抛异常

CODEGRAPH_KERNEL=0 是全局开关.

一致性保障体系是这个项目最值得看的工程实践之一:

- scripts/kernel-parity.mjs: 逐文件 kernel-wasm 对比, 全对象、顺序敏感的多重集 diff (顺序不同会改变 DB rowid 进而影响 resolution) , deferral 率超过 10% 判内核损坏
- scripts/dump-graph.mjs: 按自然键全库 dump, 两种模式各 init 一次后字节级 cmp——所有语言上线门都是 byte-identical
- kernel-grammar-parity 测试: 断言原生 grammar 与 wasm grammar 的 node-kind/field 表逐 id 相等, 为此 29 个 wasm grammar 重新 vendor 到与 crate 同 tag、parser.c sha 匹配的版本
- release workflow 中 CODEGRAPH_KERNEL_EXPECT=1 下缺预编译二进制直接 FAIL

### 4.2 语言支持: 34 种语言, 三层抽取策略

README 语言表列出 34 种: TypeScript、JavaScript、ArkTS (鸿蒙) 、Python、Go、Rust、Java、C#、VB.NET、PHP、Ruby、C、C++、CUDA、Objective-C、Metal、Swift、Kotlin、Scala、Dart、Lua、Luau (Roblox) 、R、Nix、Erlang、CFML、COBOL、Solidity、Terraform/OpenTofu、Svelte、Vue、Astro、Liquid (Shopify) 、Pascal/Delphi.

抽取分三层:

1. 20 种走 Rust 内核 (wasm 兜底)
2. 长尾语言只有 wasm 实现 (objc、pascal、cobol、vbnet、erlang、solidity、terraform、arkts、nix、cfml/cfscript/cfquery 等——多为 vendored/打过补丁的 grammar, 移植风险高, 迁移计划里标注"可能永远留在 TS"; Metal 与 CUDA 走 C++ 解析路径)
3. 模板/混合格式走自定义抽取器 (svelte/vue/astro 的 script 块委托 TS/JS 抽取器, liquid/razor 用正则, MyBatis mapper 走 XML 抽取器, DFM/FMX 表单有专门处理)

图的节点类型 (NodeKind, 23 种, src/types.ts 的 NODE_KINDS 数组) :

```text
file, module, class, struct, interface, trait, protocol, function, method,
property, field, variable, constant, enum, enum_member, type_alias, namespace,
parameter, import, export, route, component, union
```

其中 union 是 1.5.0 后新增 (PR #1515) , 1.6.0 起 C/C++/Objective-C/Rust 的 union 声明也按一等 union 节点入库. 边类型 (EdgeKind, 13 种) :

```text
contains, calls, imports, exports, extends, implements, references,
type_of, returns, instantiates, overrides, decorates, navigates
```

navigates 是 1.6.1 (2026-09-29 发布) 新增的边类型, 表示"导航到某个屏幕/路由", 当前由 Expo Router、Next.js、React Router、TanStack Router、Vue Router/Nuxt、SvelteKit、Angular 七个路由器解析器产生 (Angular 的路由与导航是 1.6.1 之后、尚未随版本发布的 #2113/#2114/#2133 补齐的) . 每条边携带 provenance 字段, 取值 tree-sitter / scip / heuristic.

覆盖率不是宣称而是测量的. README 的 "Measured cross-file coverage" 定义"公平覆盖率"= 有至少一个已解析跨文件依赖方的含符号源文件占比, 每语言一个真实基准仓库. 克隆当前 README 的表已扩到 22 行: TypeScript/JavaScript 95.8% (本仓库) 、Python 100% (requests) 、Go 96.6% (gin) 、Rust 86.7% (ripgrep) 、Java 93.3% (gson) 、C# 85.2% (MediatR) 、PHP 100% (guzzle) 、Ruby 100% (sidekiq) 、C 92.2% (redis) 、C++ 94.8% (leveldb) 、Objective-C 91.6% (SDWebImage) 、Swift 95.3% (Alamofire) 、Kotlin 96.2% (okhttp) 、Scala 91.2% (gatling) 、Dart 92.4% (flutter/packages) 、Svelte/SvelteKit 100% (sveltejs/realworld) 、Vue/Nuxt 93.5% (nuxt/movies) 、Astro 93.0%、Lua 84.2% (telescope.nvim) 、Luau 92.2% (Fusion) 、Liquid 73.8% (Shopify dawn) 、Pascal/Delphi 77.4% (PascalCoin) . 框架路由覆盖率同样实测: Express 100%、FastAPI 98%、Flask 100%、NestJS 96.8%、Gin 96.5%、Axum 100%、Rocket 93.8%、Vapor 100%、Laravel 92%、Rails 89.6%、React Router 100%, 约定/反射密集型的诚实报出静态分析天花板: ASP.NET 83.9%、Spring 83.3%、Drupal 78.9%、Play 76.3%、Django 74.1%. README 原话: 残余部分"永远是真正的静态分析前沿——运行时动态分发、反射/DI 容器、框架约定入口、vendored 第三方代码——绝不通过操纵分母来隐藏".

### 4.3 存储: node:sqlite + WAL + FTS5, 没有图数据库

这是 CodeGraph 与 Neo4j 路线 (如 Potpie) 最大的体系差异. 0.9.0 起存储后端切换为 Node 内建的 node:sqlite (DatabaseSync) , src/db/sqlite-adapter.ts 是一个薄适配层, 文件头注释写明"无原生构建步骤、无 wasm 回退". 这个选择与捆绑 Node 运行时的决策互为因果: 捆绑 Node 24 就意味着自带真正的 SQLite (含 WAL + FTS5) , 从而删掉 better-sqlite3 依赖、实现零原生 addon、根治早期 "database is locked" 问题 (issue #238) .

Schema (src/db/schema.sql 基线 + migrations 到 v11; v10 为合成输入追踪表 synthesis_inputs 与索引重建 (#1988) , v11 给合成元数据查找加畸形 JSON 防护) :

| 表                 | 要点                                                                                                                                                                                                                          |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| nodes              | id(PK), kind, name, qualified_name, file_path, language, start/end_line, start/end_column, docstring, signature, visibility, is_exported/is_async/is_static/is_abstract, decorators(JSON), type_parameters(JSON), return_type |
| edges              | source, target, kind, metadata(JSON), line, col, provenance; 外键级联删除; 唯一索引 (source,target,kind,line,col) 去重 (issue #1034)                                                                                          |
| files              | path(PK), content_hash, language, size, modified_at, indexed_at, node_count, errors(JSON), generated                                                                                                                          |
| unresolved_refs    | 待解析引用队列, status pending/failed, candidates(JSON), name_tail 后缀索引                                                                                                                                                   |
| name_segment_vocab | (segment, name) 复合主键 WITHOUT ROWID——自然语言词到符号段的查找表, 服务 prompt-hook                                                                                                                                          |
| project_metadata   | key/value                                                                                                                                                                                                                     |
| nodes_fts          | FTS5 虚表 (content= 外部内容表模式 + 三个同步触发器) , 全文搜索                                                                                                                                                               |

连接配置 (src/db/index.ts configureConnection) : busy_timeout=5000 最先设置, journal_mode=WAL、synchronous=NORMAL、cache_size=-64000 (64MB) 、temp_store=MEMORY、mmap_size=256MB. 围绕 WAL 有一整套工程设施: 批量索引期间关闭 wal_autocheckpoint (issue #1231) , 由 WalCheckpointValve 在 worker 线程定时做 PASSIVE checkpoint, 索引期软阈值为"256MB 与索引大小四分之一取大"、上限 2GB (CODEGRAPH_WAL_VALVE_MB 可调) , 超过时背压暂停写入; 每次打开连接时 healOversizedWal() 修复被 kill 进程遗留的超大 WAL, 静息阈值默认 64MB (CODEGRAPH_WAL_HEAL_MB 可调, 1.6.0 修复的 issue #1431) ; 批量写入窗口临时 DROP 二级索引、结束后一次性重建, FTS 触发器同样先删后整体 rebuild.

向量检索的结局值得记录: 仓库早期设计过 vectors/ 模块 (@xenova/transformers 跑 ONNX、384 维 nomic-embed-text-v1.5 embeddings、sqlite-vss 索引, IMPLEMENTATION_PLAN.md 里有完整设计) , 在 CHANGELOG 记录范围之前就被整体移除, issue #87 里有用户直接问"为什么把整个向量搜索和 embedding 模块删掉? ". 当前代码里只剩命名残留: src/errors.ts 有一个从未使用的 VectorError 类, src/context/index.ts 沿用 "semantic search" 术语但实现是精确符号查找 + FTS5 + 词干扩展 + 图遍历的混合检索. src/mcp/tools.ts 第 3877 行注释明确自证: "deterministic, no embeddings". 作者用实测得出的结论是: 对"找调用链、找定义、找路由"这类 agent 问题, 符号名 + FTS5 + 图遍历已经足够, 向量检索引入的延迟和不确定性反而是负担.

### 4.4 引用解析: 三阶段流水线 + 启发式合成边

解析流程 (src/resolution/index.ts, 3070 行) : 抽取阶段把未解析引用写入 unresolved_refs (status=pending) , ReferenceResolver 用 worker 池批量解析. 三个阶段:

1. imports → 文件: tsconfig/jsconfig path alias、JVM 全限定名、C/C++ include 目录、PHP include、COBOL copybook、Nix path import、Go module、monorepo workspace packages
2. calls → 定义: name-matcher 多策略匹配 (qualified-name、exact-name、file-path、链式调用 matchDottedCallChain、回调值引用 matchFunctionRef) ; 对同名定义超过 500 个的"泛在名"拒绝出边, 防止噪声
3. inheritance: extends/implements 双向边, 随后二遍解析——链式工厂调用靠 conforms 边解析、this.member 引用沿超类型 BFS

name-matcher 是这套流水线里演进最快的模块 (当前 9594 行) . 791ae39 之后的 74 个未发布修复 (#2170~#2248, CHANGELOG Unreleased 段落) 几乎全部投在接收者 (receiver) 解析的收敛上, 方向一致——"名字猜测"退让给"类型事实"与"作用域事实": 经字段/属性/参数声明类型的调用 (C#/Java/Kotlin, 含继承来的泛型实参、for-each 声明、C# using 别名、类型参数上界) 落到声明类型自己的方法, 不再回退到项目内同名方法猜测; 经类名的调用 (Pascal/Python/Ruby/PHP/TS/JS/Java 系) 到达该类继承来的类方法; 标准库/库类型的调用留在库内 (Rust 的 Vec::new 与模块路径、Go 的 net/http、JS 的 fetch Response.text()/.json()、R 的基础函数) ; 接收者名猜测不再命中 web 框架派发的请求 handler (Django/DRF view 的 get/post、控制器 CRUD) 与测试文件里的匿名替身; C# 接口成员按语言定义视为 public、无修饰符类型为 internal; Swift 的无接收者/self./super. 调用只到达所在类型及其继承与遵循的成员, 最近覆写优先; Kotlin infix 调用被记录为调用、无接收者调用只到达"可及范围内"的成员 (error/require/check 等标准函数不再错连项目方法) ; Objective-C 发给 super 的消息到达超类实现; Solidity 无接收者调用留在合约及其继承链内, Erlang 跨模块调用跟随文件的 -import 声明; C/C++ 的限定名可进入宏展开的命名空间 (fmt 的 FMT_BEGIN_NAMESPACE、pybind11 的 PYBIND11_NAMESPACE_BEGIN 等) 与命名空间别名. 后 63 个 commit (#2181~#2248) 把同一方向推向语言作用域本身: 裸名只解析到引用处可见的符号 (Java 的包/import/嵌套可见性、PHP 的命名空间与 use、C# 的 namespace 块作用域、Rust 的 module/use、Scala 的 package object 与块内局部 val、Lua 的 local 与文件私有) ; 调用落到实参个数/参数标签匹配的那个重载 (Java/C#/Kotlin/Swift/Scala/Dart/VB.NET/C++) ; 框架命名约定 (NestJS provider、Express middleware、React hook/context、Django/FastAPI/Flask/ASP.NET/Gin/SwiftUI/Vapor) 收敛为"只挑引用所在文件自己的声明", 统一进新增的 frameworks/name-heuristic.ts 共享挑选模块 (#2225) ; 生产代码不再连到测试套件里的同名符号, minified 产物里的同名函数不参与名字解析, 外部导入 (Java/Kotlin import、Go 外部包限定名) 拥有自己的名字; Python 的包再导出 (`__init__.py` re-export) 被跟随到真实定义 (#2247/#2248) . 这些条目普遍标注 "Re-index after upgrading", 即精度提升需要重建索引才能生效.

最有特色的是动态分发桥接 (synthesizers) . callback-synthesizer.ts (4141 行) 识别的模式包括: 字符串键 EventEmitter (.on/.once 与 .emit/.fire 按事件名对接, fan-out 上限 6) 、React setState→render 重渲染边、JSX 子组件边、Vue 模板组件事件绑定/composable 解构/Nuxt 自动导入、Flutter setState→build、ArkUI (鸿蒙) state→build 与 Emitter 事件、C++ virtual override、Go interface→struct 与 gRPC stub→impl、Kotlin expect/actual (KMP) 、闭包集合分发 (Swift/Kotlin 的 coll.forEach \{ $0() \}) . c-fnptr-synthesizer 处理 C/C++ 函数指针分发, 包括宏构建的命令表 (redis、SQLite、Vim 风格的注册表, issue #932/#991) . goframe-synthesizer 处理 GoFrame 反射路由. swift-objc-bridge 处理 Swift-ObjC selector 桥接. 克隆当前 main 还新增了 tier-synthesizer (跨层合成: 客户端字面量 fetch/axios 路径接到本仓路由、队列任务接到消费者、总线/socket 事件接到 handler, 边带 channel/tier/registeredAt 元数据) 与七个前端路由器合成器 (含 Angular 模板合成器, 见 4.5) . 所有合成边一律标记 provenance:'heuristic' 并带 metadata.synthesizedBy 通道名与 registeredAt 注册点, agent 可以分辨某条边是怎么进入图中的. 这是让 trace 能跨越"事件分发、回调、运行时绑定"这些 grep 永远穿不过的边界的关键.

另有查询期的 dynamic-boundaries 机制 (src/mcp/dynamic-boundaries.ts) : explore 的静态路径断开时, 检测并如实播报动态分发点 (计算成员调用、getattr、反射、字符串总线) , 但不猜测合成边.

### 4.5 框架感知路由

src/resolution/frameworks/ 当前共 34 个文件 (不含 index.ts, 其中 name-heuristic.ts 是 #2225 抽出的共享命名约定挑选模块, 其余 33 个是 resolver) , 覆盖 17 个以上 web 框架: Express、NestJS、React、Angular Router、Svelte、Vue、Astro、Django、Flask、FastAPI、Rails、Spring、Play、Go 标准路由 (net/http、Gin 等) 、GoFrame、Axum/Actix 等 Rust 框架、ASP.NET、Laravel、Drupal、SwiftUI/UIKit/Vapor, 以及 CICS (COBOL TRANSID 跳转) 和 Terraform, 另有 cargo-workspace、object-literal (zustand 风格 store action) 、package-deps 等非 web 解析器. 路由声明被抽成 kind:'route' 的图节点并连向 handler, 因此 agent 可以问"POST /api/users 的实现在哪、影响哪些下游", 一次 impact 查询直接出结果. 克隆当前 main 把七个前端路由器升级为"路由 + 导航"双向解析 (expo-router、nextjs、react-router、tanstack-router、vue-router、sveltekit-router、angular-router, docs/design/framework-coverage.md 将此七者记为 "Routers — routes AND navigation (done)") : 屏幕/页面文件成为绑定组件的 route 节点, router.push、navigate、redirect、模板 Link 等字面量导航调用产生 navigates 边, "点击这里会去哪个页面"变成一跳查询; Angular 的模板不作为符号索引, 而在合成期读 templateUrl/内联模板, 额外产生组件树边与 routerLink 导航边; 计算型目标与无路由匹配的路径如实留空而不是猜测. 企业技术栈 (Spring/MyBatis 自 0.9.6 起专门优化, 1.3.0 把大型 Java/Kotlin Spring monorepo 的解析从近 1 小时降到几分钟) 是明确的支持目标.

### 4.6 自动同步: 原生 fs.watch, 保存后亚秒级更新

src/sync/watcher.ts 不用 chokidar, 直接用 Node 内建 fs.watch (头注释: "no third-party watcher, no native addon") . macOS/Windows 用单个递归 watch (一条 FSEvents 流 / 一个 ReadDirectoryChangesW 句柄, O(1) 描述符, 修复了 issue #644 macOS 文件表耗尽) ; Linux 递归 watch 不可用, 改为每目录一个 inotify watch, 默认上限 50,000 个目录, EMFILE/ENFILE 自动降级.

防抖策略分三档: 默认 2 秒静默窗口; pending 文件数不超过 2 时走 300ms 快通道 (单次保存近实时) ; pending 超过 500 (分支切换、大规模 checkout) 放弃按事件同步, 改全量 scan-diff. 连续 5 次锁冲突或失败后降级关闭自动同步并回调 onDegraded. 兜底机制: watch 被禁用的环境 (如 WSL2 的 /mnt 挂载) 可安装 git post-commit/post-merge/post-checkout 钩子后台跑 codegraph sync; worktree.ts 检测 git worktree 借用别处索引的错位.

效果 (README) : 保存文件后图在 1 秒内更新——4,400 文件项目约 0.3 秒, 27,000 文件的 Swift 编译器仓库约 0.4 秒, 从不重扫文件树. 对 31 个仓库、30 种语言的对比基准中, 变更重索引比"最快的竞品 indexer"快 2-7 倍, 且差距随仓库规模扩大——因为对方成本随仓库增长, CodeGraph 成本随变更增长.

### 4.7 MCP 接口: 从 10 个工具收窄到默认 1 个

src/mcp/tools.ts 当前定义 8 个工具 (早期是 10 个, codegraph_context 与 codegraph_trace 在 0.9.9 被裁撤) :

| 工具                                  | 语义                                                                                     |
| ------------------------------------- | ---------------------------------------------------------------------------------------- |
| codegraph_explore                     | 主工具: 自然语言或符号名集合, 一次返回相关符号按文件分组的逐字源码 + 调用路径 + 影响半径 |
| codegraph_search                      | 按名字找符号, 只返回位置                                                                 |
| codegraph_callers / codegraph_callees | 调用方 / 被调方                                                                          |
| codegraph_impact                      | 改动影响半径 (重构前用)                                                                  |
| codegraph_node                        | 双模式: 单符号详情 (可附源码) , 或传 file 替代 Read 工具读文件                           |
| codegraph_files                       | 索引内文件树, 支持 glob 过滤                                                             |
| codegraph_status                      | 索引健康度                                                                               |

关键设计: 默认只暴露 codegraph_explore 一个工具 (DEFAULT_MCP_TOOLS, tools.ts 第 1850 行) , 其余 7 个可用环境变量 CODEGRAPH_MCP_TOOLS 重新启用. 所有工具声明 readOnlyHint 与 idempotentHint (为 Cursor Ask 模式, issue #1018) , 全部支持 projectPath 参数实现 monorepo 多项目查询 (issue #964) .

CLAUDE.md 里的 MCP 设计哲学是整个项目最有借鉴价值的部分, 摘录要点:

- 优化目标是 wall-clock 延迟 + 工具调用数, 不是 token 成本. 行为目标: flow 类问题小仓库 1 次 explore 解决、大仓库 3-5 次, Read/Grep 归零. 唯一判据: "codegraph 的回答是否足够好, 好到让 agent 不去读文件? "
- "Adapt the tool to the agent——不要试图改变 agent". 影响 agent 的渠道 (initialize 指引、工具描述) 都是低显著性的, 改措辞无法可靠改变工具选择 (trace-first 指引试了 3 种措辞均未复现效果) . 可行的是让 agent 本来就会调的工具在给定输入下做更多事.
- 充分性原则: codegraph_node 对歧义名一次返回所有重载的完整函数体, 杜绝 agent 去 Read 找重载.
- 错误即弃用: 早期一两次 isError 就会让 agent 永久弃用 codegraph. isError 只留给真正的故障与安全拒绝; 一切预期内状态 (未索引、找不到符号) 返回"成功形态的指引".
- 失败教训: 模糊输入工具必败. codegraph_context 收描述不收符号名、无法定位端点, 已删; codegraph_trace 因 agent 不选它而删. 精确输出需要精确输入.
- explore 预算按仓库规模分档: 500 文件以下 1 次调用、5000 以下 2 次、15000 以下 3 次、25000 以下 4 次、更大 5 次; 每档输出预算有单调性不变量 (大档位 maxCharsPerFile 不得小于小档位——曾因此回归导致 excalidraw 415KB 的 App.tsx 只返回不到 1% 内容, 逼 agent 去 Read) . explore 输出永远不许说 "use Read".
- 动态分发覆盖: "partial coverage is WORSE than none"——半截桥接会让 agent 钻进去读文件补齐 (excalidraw 实测 react-render 单独上线反而把 Read 提到 5-7 次, 补齐 jsx-child 后才降到 0-1) .
- 验证方法论: 每新增语言/框架强制跑小/中/大真实仓库加 3 个以上 flow prompt; agent A/B 每臂至少 2 次、禁止 n=1 下结论; 模型政策一律 Sonnet + effort high、绝不用 Opus——Sonnet 是刻意的"地板模型", 在弱模型上成立的 affordance 才能向上泛化到所有宿主; 所有对照组封锁 codegraph CLI 防污染.

运行模式上, MCP server 支持 Direct/Proxy/Daemon 三种形态; 0.9.5 引入的共享后台 daemon 让多个 agent 共用一个 watcher 和 SQLite 连接.

除面向 agent 的 MCP 面之外, 克隆当前 main 包含尚未随正式版本发布的面向人的图查看器 `codegraph ui` (代码已随包分发, 但命令默认隐藏并拒绝执行, 需 CODEGRAPH_UI=1 启用, 门控逻辑在 src/bin/viewer-gate.ts): 本地只读 web 服务, 默认监听 127.0.0.1:4747 (别名 `codegraph web`, 支持 --port/--no-open/--read-only, CODEGRAPH_BROWSER 可指定浏览器) , 前端是仓库顶层 ui/ 目录的 Svelte + Vite 应用, 后端是 src/ui-server/ 的只读 JSON API. 视图包括: 符号三栏页 (左侧按文件分组的调用方、中间带调用行标记的逐字源码、右侧与调用行对齐的 callee) 、Flow (两个符号之间的路径, 静态图没有记录的动态分发跳以虚线呈现并标注接线点, 走不通时如实报告 "Where the graph stops") 、Map (模块粒度全仓依赖图, 由图布局生成, 环被列出而非抹平) 、Screens/Steps (前端应用的屏幕导航图与单个屏幕/端点触发的事件链, 每条边带触发条件, 覆盖 Expo Router/Next.js/React Router/TanStack/Vue Router/SvelteKit/Angular——Screens 视图是 route 节点与 navigates 边的纯函数, 任何产生这两者的框架自动落进该标签页) 、Entry points (每个路由及其 handler、import 即执行的文件、测试覆盖面排序) 、dead code 与类型层级. 查看器只读已存在的索引、绝不建索引或改代码, 唯一的写盘是用户主动保存的 trail (JSON 存于 .codegraph/ui/trails/) , 无任何数据外发. 这是托管产品 (getcodegraph.com) 方向在本地端的对应物.

### 4.8 分发与供应链: 捆绑 Node 24、零原生 addon、SLSA 签名

BUNDLING.md 记录的核心决策: 随包捆绑 vendored Node 运行时 (scripts/build-bundle.sh 默认 Node v24.16.0) . 因为 Node 22.5+ 内置真正的 SQLite, 捆绑 Node 意味着去掉 better-sqlite3、零原生 addon、无需编译/rebuild、不依赖用户机器上的 Node 版本. 打包没有用 SEA/pkg 类工具——由于零原生 addon, 打包就是纯文件拼装 (下载目标平台官方 Node + 拷贝 dist + npm ci --omit=dev) , 任意 OS 可构建任意 target. 6 个平台目标: darwin-arm64/x64、linux-x64/arm64、win32-x64/arm64. 四个安装通道: curl | sh (install.sh) 、npm (薄 shim + 按 os/cpu 的平台 optionalDependencies) 、Windows irm | iex (install.ps1) 、Homebrew/Scoop (TODO) . install.sh 本身不检测 agent, 只装 bundle; agent 检测与 MCP 注册发生在 codegraph install CLI (src/installer/, 11 个目标各自实现 detect 逻辑, MCP 条目统一为 `{ type: 'stdio', command: 'codegraph', args: ['serve', '--mcp'] }`) .

供应链安全是 1.5.0 前后的重点建设 (README "Verified releases" 节) : npm 包通过 trusted publishing (OIDC, 不存在可被窃取的长期 npm token) 发布, 带 provenance attestation, 可用 npm audit signatures 验证; GitHub Release 捆绑包带签名的 build attestation (SLSA v1.0 Build Level 2) , 可用 gh attestation verify 验证; 所有产物由公开的 Release workflow 构建发布, "never from a laptop". 2026 年 7 月之前的发布不带 attestation. 对一个要装进开发者机器、接管 agent 工具链的软件, 这套密码学溯源是企业安全审计能接受的前提.

### 4.9 遥测: 第一方、allowlist、可审计

遥测在 1.0.0 (2026-06-12) 引入, 1.6.0 (2026-08-26) 起转为完全第一方存储 (接收端点不做任何出站请求) . TELEMETRY.md 逐字段文档化收集内容: 信封字段 (machine_id 本地随机 UUID、版本、os/arch、node 主版本、是否 CI) 加四类事件——install (配置了哪些 agent) 、index (仅语言名列表 + 文件数/耗时的粗分桶) 、usage_rollup (本地按天聚合的工具调用计数, prompt hook 只记 gate 决策计数、绝不读 prompt 内容) 、uninstall. 明确不收集: 源码、路径/文件名/符号名/查询词、IP (端点不读 IP) 、任何个人数据.

工程契约 (docs/design/telemetry.md) : 改 schema 必须同一 PR 同时改设计文档 + TELEMETRY.md + Worker allowlist; 遥测永不增加 MCP 热路径延迟、零依赖、stdout 零字节. 存储用自家 Cloudflare D1, 无第三方分析商, 原始事件 90 天删除, 只留匿名日汇总. 关闭机制: "Off means off"——codegraph telemetry off 或 CODEGRAPH_TELEMETRY=0 或 DO_NOT_TRACK=1, 关闭即删除未发送缓冲, 连"已退出"的 ping 都不发. 接收端 Worker (telemetry-worker/) 和管理看板 (telemetry-dashboard/) 的源码都公开在仓库内供审计.

## 五、基准数据 (2026-08-05 最新一轮)

README 当前数字来自 2026-08-05 用 Claude Opus 4.8 对当前构建的重测. 方法: 7 个真实开源仓库 (VS Code 约 11k 文件、Excalidraw、Django、Tokio、OkHttp、Gin、Alamofire, 跨 7 种语言) ; claude -p headless + --strict-mcp-config; WITH 组启用 CodeGraph MCP, WITHOUT 组空 MCP 配置; 两边都保留内建 Read/Grep/Bash; 每臂 4 次取中位数.

关键方法论升级: 两组都封锁 codegraph CLI (净化 PATH + PreToolUse hook) . 不封锁时对照组 28 次运行中 26 次会通过 Bash 偷用 CLI, 污染对比; 本次 28/28 全部封锁成功. 早期发布的数字没有这个封锁.

总结论: 工具调用减少 88%、快 53%、token 减少 62%、成本降低 44%, 7 个仓库的文件读取全部归零.

| 仓库       | 语言/规模      | 工具调用 | 时间                    | token | 成本 |
| ---------- | -------------- | -------- | ----------------------- | ----- | ---- |
| VS Code    | TS 约 11k 文件 | 2 vs 28  | 2.2 倍快 (58s vs 2m10s) | -77%  | -71% |
| Excalidraw | TS 约 640      | 2 vs 43  | 3.6 倍快                | -84%  | -78% |
| Django     | Python 约 3k   | 3 vs 14  | 快 35%                  | -41%  | -13% |
| Tokio      | Rust 约 790    | 3 vs 29  | 2.6 倍快                | -65%  | -64% |
| OkHttp     | Java 约 645    | 1 vs 6   | 快 43%                  | -54%  | -21% |
| Gin        | Go 约 110      | 1 vs 7   | 快 39%                  | -52%  | 持平 |
| Alamofire  | Swift 约 110   | 4 vs 33  | 2.6 倍快                | -59%  | -57% |

两条诚实声明值得注意. 其一, 成本节省取决于问题的"发现量"而非仓库大小: 需要对照组 28-43 次工具调用才能回答的问题省 57-78%, 对照组 7-14 次就到答案的问题 (Django、Gin) 基本持平. 其二, "A note on context": 上述数字测的是吞吐 (处理的 token、调用的工具、花的钱) , 不测答完之后上下文窗口里还留着什么——在这个维度上 CodeGraph 更贵: 多轮会话下 CodeGraph 的响应比 file-reading agent 平均多残留约 80% 的检索内容 (7 仓库平均; VS Code 单仓最悬殊, 67k vs 18k token, 约为其 3.7 倍) . 机制与它快的原因相同: 一次返回致密的逐字载荷, 答完仍驻留在窗口里. 小窗口长会话要为此做预算 (详见 docs/benchmarks/residual-context-occupancy.md) .

规模数据 (README "Built for speed" 节) : Linux kernel——70k 文件、2M 符号、6.4M 关系——在 2 核/6GB VPS 上 12 分钟内完成索引 ("RAM-first 设计在 1% 前就 OOM") ; Swift 编译器仓库 27k 文件新索引约 100 秒; 机器自适应——worker 池、并行 resolution、分析缓存按真实核数 (容器/cgroup 感知) 、真实可用内存、每项目实测解析成本定规模.

## 六、大型企业的工程意义

这一章回答一个问题: 一个独立开发者的开源工具, 对企业级工程组织意味着什么. 以下每条都对应前文验证过的事实.

### 6.1 Agent 规模化的成本工程

企业推广 AI 编码 agent 的瓶颈正在从"能不能用"转向"用不用得起". 探索性消耗是可量化的固定开销: 作者实测的 60 次工具调用、157,800 tokens、近 2 分钟, 发生在每个会话的开始, 且随代码库复杂度增长. CodeGraph 把这部分从 LLM 推理转移到本地预计算——索引一次, 此后每次查询的边际成本是亚毫秒级 SQLite 查询.

最新基准给出的企业级账本: 平均成本 -44%、token -62%、工具调用 -88%、文件读取归零. 需要注意口径: 收益集中在"发现密集"型任务 (架构理解、跨模块修改、影响分析) , 这恰恰是企业里资深工程师才敢接、agent 最难替代的任务类型; 简单任务 (对照组 7 次调用内解决) 收益趋近于零. 对拥有数千名工程师、按 token 结算 agent 账单的组织, 这个比例直接换算成预算. 另一个常被忽略的维度是延迟: agent 工作流的真实约束是 wall-clock (CLAUDE.md 明确把优化目标定为延迟 + 调用数而非 token) , 53% 的提速改变的是"工程师是否愿意等"这件事.

### 6.2 合规、数据主权与供应链可审计性

这是 CodeGraph 相对云端方案最硬的企业优势. 索引链路 100% 本地: 无 API key、无外部服务、.codegraph/codegraph.db 单个 SQLite 文件不离开开发机. 对金融、政务、军工、医疗等源码出域即违规的行业, Cursor (远端 Turbopuffer 向量库) 、Augment Code (远端 Context Engine) 、Sourcegraph Cody (中心化实例) 都需要走数据出境/第三方处理评估, 而 CodeGraph 不产生新的数据流——安全评审的对象只剩软件本身.

软件本身的可审计性也做到了开源工具的天花板: npm trusted publishing (OIDC, 无长期令牌) + provenance attestation; Release 捆绑包带 SLSA v1.0 Build Level 2 签名 attestation, gh attestation verify 可验证; 全部产物由公开 workflow 构建. 遥测默认开启但设计克制——allowlist 强制、不收代码/路径/符号名/查询词、不读 IP、第一方 Cloudflare D1 存储、90 天删除、接收端源码公开、DO_NOT_TRACK 优先、"Off means off". 这套设计几乎逐条对应企业隐私评审的检查项. MIT 协议无商用限制. 需要提醒: 遥测默认开启这一点, 在严格的安全基线下可能需要通过 CODEGRAPH_TELEMETRY=0 统一预置关闭.

### 6.3 多语言与遗留资产覆盖

企业的代码资产不是单一技术栈的绿色田野, 而是十几二十年积累的异构地层. CodeGraph 的语言清单明显冲着这个现实去的: 除了现代主流语言, 还有 COBOL (含 CICS TRANSID 跳转桥接) 、VB.NET、Pascal/Delphi (含 DFM/FMX 表单) 、CFML、Erlang、Objective-C、ArkTS——这些恰恰是银行核心系统、保险理赔、制造业 ERP、电信计费里最常见的"没人敢动"的资产. 把遗留代码纳入同一张图, 意味着 agent 第一次能在这些系统上做有依据的问答和影响分析, 而不是靠口口相传.

企业框架同样是明确目标: Spring/MyBatis 流 (0.9.6 起) 、Laravel、Drupal、GoFrame、NestJS、ASP.NET; 跨语言桥接覆盖 Swift-ObjC、React Native (legacy bridge + TurboModules + Fabric) 、Expo Modules、Kotlin expect/actual, 对应大型移动团队的混合栈. 对遗留系统常见的"约定大于配置"入口 (路由、事件、反射注册表) , 启发式合成边带着 provenance 标记给出尽力而为的连接, 覆盖率表则诚实标出静态分析天花板 (Spring 路由 83.3%、Django 74.1%) ——企业评估时可以直接拿自己技术栈对应的数字做预期管理.

### 6.4 确定性: 可复现、零边际成本、无模型漂移

CodeGraph 的抽取"源自 AST, 不被 LLM 总结" (CLAUDE.md 原话) . 这带来三个企业属性: 其一, 索引完全可复现, 同一 commit 永远得到同一张图, 这对 CI 一致性和事故复盘是前提; 其二, 索引零边际成本, 不调用模型、不产生费用、不受模型下线/涨价影响; 其三, 无漂移, 不存在"换了 embedding 模型导致检索结果变化"这类非确定性. 对比走 LLM 语义增强路线的竞品 (如 Potpie 给每个函数写 LLM 生成的 docstring 入图) , CodeGraph 用确定性换取了图本身不携带语义注解的代价——这个取舍在需要审计输出的企业场景里通常是加分项.

### 6.5 CI/CD 与变更治理

CLI 提供直接嵌入流水线的原语: codegraph affected 基于图反向追踪"改了这些源文件, 哪些测试文件会被影响", README 给出的用法是 `git diff --name-only HEAD | codegraph affected --stdin --quiet | xargs vitest run`——在大型测试套件里只跑相关测试, 直接压缩 CI 机时. codegraph impact 给出符号级改动影响半径, 可以用在重构审批和 PR 风险评估. codegraph.json 支持提交到仓库共享扩展名映射 (README 原话: "Commit the file to share the mapping with your team") .

更值得关注的是方向: README 顶部的 getcodegraph.com 候补名单描述的产品形态是"对每个 PR, 知道该测什么、什么可能坏、影响哪些业务流、业务逻辑是否被破坏"——这是把本地图谱能力上升为团队级变更治理平台, 1.1.0 的 monorepo 多项目 MCP (projectPath) 已经在为这个方向铺路. 如果落地, 它对标的是企业目前靠人工 review 和覆盖率报表勉强维持的变更风险控制.

### 6.6 部署与运维经济学

零基础设施: 没有服务器、没有数据库、没有密钥, 每仓库一个 SQLite 文件, 任何团队可以不经平台审批自行启用——这与需要部署实例/采购 SaaS 的 Sourcegraph、Augment、Potpie 形成鲜明对比, 试点摩擦几乎为零. 资源特性对 CI 友好: 容器/cgroup 感知让 2 核/6GB 的流水线容器能完成 Linux kernel 规模 (70k 文件/2M 符号/6.4M 关系) 的索引, 而 RAM-first 设计在 1% 进度前 OOM. 增量经济学是大仓库的关键: 同步成本随变更大小增长而非随仓库大小增长 (单文件保存后亚秒级更新) , 31 仓库基准中领先最快竞品 indexer 2-7 倍且差距随规模拉大.

### 6.7 组织与 agent 治理层面的启示

即使不采用 CodeGraph 本身, 它的若干实践对企业构建内部 agent 基础设施有直接参考价值: 默认只暴露一个工具面 (explore) 降低治理面积和 prompt 注入面; "地板模型"验证政策 (在 Sonnet 级别验证 affordance 才允许上线) 保证在异构模型栈上的稳定性; readOnlyHint/idempotentHint 注解让工具能被 Ask 模式安全消费; "错误即弃用"的响应形态设计 (预期内状态永不返回 isError) 是 agent 工具可用性的通用教训; kernel-parity 的字节级一致性门 + 逐文件回退, 是"性能优化不破坏正确性"的教科书式工程范式.

### 6.8 企业采用的缺口与风险 (如实列出)

- 单仓边界: CodeGraph 是单仓本地索引, 不做跨仓图谱. 微服务架构下每仓一个实例, 跨服务的端到端链路推理仍需 Sourcegraph/Augment 类中心化方案
- 无集中管控: 没有 RBAC、SSO、集中配置下发、使用量报表, 也没有 SLA. 安全基线需要自行用环境变量 (CODEGRAPH_TELEMETRY=0、CODEGRAPH_KERNEL=0 等) 预置
- 项目风险: 核心由单一作者驱动 (42 位 contributor、发布极快) , bus factor 偏低; MIT 协议下企业可自维护, 但内核线协议、parity 体系的维护门槛不低
- 能力边界: 反射/DI 容器/框架约定是静态分析的天花板 (覆盖率表如实标注) ; 无类型级语义, 安全级污点分析仍需 CodeQL/SCIP 路线; Objective-C 为部分支持; 默认跳过大于 1MB 的文件
- 上下文驻留: 多轮会话残留检索内容平均比 file-reading 多约 80% (VS Code 单仓约为其 3.7 倍) , 小窗口长会话需要预算
- 遥测默认开启: 严格环境需预置关闭

## 七、场景分析: Sentry JS error 的大模型自动修复闭环

本章分析一个具体的企业落地场景: 前端 Sentry SDK (如 sentry/react) 上报 JS error, 服务器端用 sourcemap 还原源码位置, 配合 SDK 上报的上下文信息, 再叠加企业级 AGENTS.md 指令文件与 skills 建设, 由大模型 agent 自动完成错误分析、创建修复分支、写代码、提交 MR. 在这个闭环里, codegraph 解决的是"agent 如何在大代码库里又快又准地定位根因、并安全地评估改动"这一环.

### 7.1 流程定义: 从错误上报到修复 MR

```text
浏览器运行时 (sentry/react SDK 捕获)
  → 上报: 错误类型/消息、压缩栈、breadcrumbs、release、环境、tags
  → Sentry 服务端: 按 release 对应的 sourcemap 符号化, 还原源文件/行/列/函数名
  → issue 聚合: fingerprint 分组去重, 按频次/影响用户数/in_app 帧筛选自动修复候选
  → 上下文组装: 错误元数据 + 符号化栈 + 代码结构上下文 (codegraph)
                + AGENTS.md 行为约束 + skills 修复模式
  → headless agent: 定位根因 → 创建修复分支 → 写修复代码
  → 验证: codegraph affected 选测试 → 定向执行 → lint/typecheck
  → 提交 MR: 附 Sentry issue 链接与影响分析摘要
  → 反馈闭环: 观察发版后 issue 是否消失, 判定修复有效性
```

这个流程的自动化难点全部集中在中间三步: 定位根因 (大型 monorepo 里从一个栈帧找到真正的 bug) 、安全评估 (这个改动会影响什么) 、验证 (怎么证明改对了) . 这三步恰好都是代码结构问题, 而不是模型智力问题.

### 7.2 codegraph 在流程各环节的角色

| 环节               | 无图时的痛点                                                      | codegraph 能力                                                                                                            | 对应接口                                                  |
| ------------------ | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| 栈帧 → 符号        | sourcemap 只给文件+行号, agent 要读文件才知道落在哪个函数/组件    | nodes 表带 file_path + start/end_line; codegraph_node 的文件读取模式直接替代 Read, symbol 模式可用 file/line 提示钉住重载 | codegraph_node (file 或 symbol+line) / 库 API searchNodes |
| 根因定位           | grep 穿不过异步、事件、React 渲染边界                             | 启发式合成边桥接动态分发: React setState→render、JSX 子组件、EventEmitter、回调注册                                       | codegraph_explore                                         |
| 调用链重建         | agent 逐文件读、人工重建调用路径, 作者实测单次探索 157,800 tokens | callers/callees 一跳出结果, 向上追数据来源、向下追副作用                                                                  | codegraph_callers / codegraph_callees                     |
| 修复风险评估       | 不知道改动波及范围, 企业不敢放开自动修复                          | 影响半径 + route 节点 (波及哪些对外接口/页面)                                                                             | codegraph_impact                                          |
| 测试选择           | 全量测试套件小时级, CI 成本高                                     | 图反向追踪变更文件影响的测试文件                                                                                          | CLI codegraph affected                                    |
| monorepo 多包      | 跨包引用解析复杂, 错误常出在包边界                                | projectPath 多项目查询 + workspace packages 解析                                                                          | MCP projectPath 参数                                      |
| 索引新鲜度         | 修复针对 HEAD, 索引过期导致误判                                   | 原生 fs.watch 事件, 保存后亚秒级同步                                                                                      | sync/watcher 自动运行                                     |
| 多修复 worker 并发 | 每个 worker 各建一份索引, 浪费 CPU/磁盘                           | 共享 daemon: 多 agent 共用一个 watcher 与 SQLite 连接                                                                     | daemon 模式                                               |
| 同源错误合并       | 多个 issue 其实是同一根因, 重复修复                               | 多个 issue 的栈帧映射到同一符号即可识别合并                                                                               | 行号→符号查询去重                                         |

两个与前端场景直接相关的事实: 其一, files 表带 generated 标记, generated 文件检测 (docs/design/generated-file-detection.md) 自动跳过 minified 产物与构建产物——sourcemap 负责"压缩产物 → 源码"的映射, codegraph 负责"源码内部结构", 两者职责天然互补、不重叠. 其二, React 相关的动态分发 (setState→render、JSX 父子组件、事件绑定) 正是 callback-synthesizer 覆盖最完整的模式之一, 而 sentry/react 捕获的错误大量发生在渲染与状态更新链路里.

### 7.3 一个走查示例

设想 sentry/react 上报: TypeError: Cannot read properties of undefined (reading 'map'), release web@1.4.2, issue 日触发 3,000 次, 符号化后栈顶帧 src/components/UserList.tsx:45, in_app. agent 的查询序列:

1. `codegraph_node(symbol=UserList, file=src/components/UserList.tsx, line=45)` → 命中符号: UserList 组件渲染逻辑, 返回带行号源码、签名与调用轨迹, 无需 Read 文件 (栈帧没有函数名时, 也可只传 file 走文件读取模式拿带行号源码)
2. `codegraph_explore("UserList 数据加载与渲染链路")` → 一次返回: useUserList hook 的实现、经 JSX 子组件边找到渲染 UserList 的父组件、按文件分组的逐字源码
3. 根因浮现: useUserList 在数据返回前的首帧返回 undefined, 第 45 行直接 data.map()
4. 修复: 加空值守卫或默认值 (skills 里沉淀的"异步数据首帧竞态"模式直接命中)
5. `codegraph_impact(UserList)` → 3 个调用方、1 个 route 节点 (dashboard 页面) ——blast radius 小, 符合自动 MR 门槛
6. `codegraph affected` → UserList.test.tsx、Dashboard.test.tsx, 定向跑测试
7. 测试通过 → 按 AGENTS.md 约定创建 fix/sentry-WEB-1234 分支 → 提交 MR, 描述附 Sentry issue 链接与 impact 摘要

整个过程 2-3 次图查询替代几十次文件读取. 对照基准数据 (工具调用 -88%、文件读取归零) , 这正是收益密度最高的任务形态.

### 7.4 与 AGENTS.md、skills 的协同: 三角模型

企业级自动修复的可控性来自三类知识的分工, codegraph 是其中不可替代的一条边:

| 知识载体  | 回答的问题                                                                                               | 性质                       |
| --------- | -------------------------------------------------------------------------------------------------------- | -------------------------- |
| AGENTS.md | 如何规范地干活: 分支命名、commit 格式、MR 模板、代码风格、测试要求、禁止事项                             | 行为约束, 静态、跨项目     |
| skills    | 已知问题怎么修: 按错误类别沉淀的修复模式 (可选链缺失、异步状态竞态、effect 依赖泄漏、hydration 不一致等) | 程序性知识, 可复用、可演进 |
| codegraph | 代码现状是什么: 这个符号在哪、谁调用它、改它影响谁                                                       | 结构性事实, 动态、仓库专属 |

AGENTS.md 和 skills 都回答不了结构性问题——前两者是静态知识, 代码结构却是动态且仓库专属的. 没有 codegraph, agent 每个 issue 都要用 grep/Read 重新发现结构 (每次支付约 157k tokens 的探索成本, 且大仓库里经常找不全) ; 有了 codegraph, AGENTS.md 里的规则才能落成可执行的门——例如"影响半径超过 5 个符号禁止自动 MR"这条约定, 只有图查询能给出判定值. 反过来, skills 里的修复模式也可以引用图概念 ("先查 callers 确认无其他调用方依赖旧行为, 再改签名") , 让模式从经验描述变成操作规程.

### 7.5 自动化门控: 影响半径作为风控主轴

企业放开 LLM 自动修复的最大顾虑是二次事故. codegraph 提供的是可量化的门控, 而不是模糊的"模型自评置信度":

1. impact (depth=2) 波及符号数低于阈值 → 自动 MR (打标签, 人工 approve)
2. 波及 route 节点 (对外接口/页面入口) 或高扇出符号 → 降级为 draft MR 或转人工认领
3. dynamic-boundaries 报告动态分发断点 (反射、字符串总线、计算成员) → 如实标注低置信度, 不强行合成结论
4. affected 测试全绿是 MR 提交的硬性前置条件
5. 修复分支独立、MR 可回滚, 发版后 Sentry issue 复发率作为闭环指标回流

门控的意义在于: 把"是否信任 LLM"从主观判断变成工程规则, 自动化的边界可以随图覆盖率数据 (README 实测表) 逐语言、逐框架地调整.

### 7.6 企业规模的经济账

以大型前端团队日均 1,000 个 Sentry issue、10% 进入自动修复管线 (100 个/天) 为例:

- 无图基线: 每个 issue 的 agent 会话从探索开始, 作者实测量级为 60 次工具调用 / 157,800 tokens / 近 2 分钟, 且大仓库里经常探索不全导致修复失败
- 有图 (2026-08 基准) : token -62%、成本 -44%、工具调用 -88%、文件读取归零、快 53%
- 月度口径: 3,000 次自动修复尝试, 成本与延迟差异线性放大; 53% 的提速意味着修复 MR 当天产出, 错误暴露窗口从"天"压缩到"小时"

两点口径提醒: 其一, 自动修复是短会话、单轮任务, 恰好是 codegraph 吞吐优势最大化的形态——多轮会话残留上下文平均多约 80% 的问题在此场景不显著. 其二, 收益密度与 issue 的"发现量"正相关: 栈帧清晰、根因浅的 issue 无图也不贵; 真正昂贵的是跨模块、跨包的深层 issue, 而那也正是人工处理最贵、最值得自动化的一类.

### 7.7 集成落地建议

codegraph 提供三种集成形态, 对应修复服务的不同架构:

1. 库 API (推荐, 修复服务是后端常驻进程) : `CodeGraph.init(repo)` → `indexAll()` → `buildContext` / `getCallers` / `getImpactRadius`, 直接嵌入 issue 分派服务; 要求 Node 22.5+
2. MCP server: headless agent (Claude Code / Codex 的 -p 模式) 直接拉起 `codegraph serve --mcp`; 默认只暴露 explore 一个工具, 治理面小、行为可预期
3. CLI: `codegraph affected` 嵌入验证流水线, `codegraph status` 嵌入索引健康监控

工程细节:

- 索引策略二选一: 索引 Sentry 事件 release 对应的 commit (忠实复现错误现场) 或索引 HEAD (直接向前修复) ; files 表以 content_hash 做增量, 两种策略切换成本低
- 多个修复 worker 用 daemon 模式共享同一份索引, 避免重复建图
- codegraph.json 提交进仓库, 扩展名映射全团队统一
- 安全基线预置 CODEGRAPH_TELEMETRY=0 (严格环境) ; 供应链侧用 npm audit signatures / gh attestation verify 验收
- 与 sourcemap 体系的分工写进 runbook: sourcemap 缺失的 release 先在 CI 补齐上传, 否则栈帧无法落到图节点

### 7.8 边界与注意事项

- codegraph 不理解运行时值: undefined 从哪个数据流来, 需要 agent 结合错误语义与 breadcrumbs 判断; 图保证的是结构上下文的完整与精确, 不是答案本身
- 反射/字符串动态分发仍是静态分析前沿, dynamic-boundaries 会如实报告断点, 管线必须为此设计降级路径 (转人工)
- 单仓边界: 错误若涉及 BFF/后端仓库, 每仓各建索引、各起 agent, 跨仓链路不可见——微服务架构下要在 issue 分派层做仓库路由
- 该场景与 CodeGraph 官方预告的托管平台方向 (getcodegraph.com: "对每个 PR, 知道该测什么、什么可能坏") 互为上下游——错误驱动的修复是 PR 影响分析的上游输入, 企业自建时可评估与官方平台的演进关系

## 八、横向对比: code RAG 赛道的五派

按"如何表示代码"分类, CodeGraph 处在"图派 + 本地优先"格:

| 工具             | 核心表示                                            | 索引位置                       | 给 agent 的接口      | 主要场景                  |
| ---------------- | --------------------------------------------------- | ------------------------------ | -------------------- | ------------------------- |
| CodeGraph        | tree-sitter AST (Rust 内核/wasm) → SQLite 图 + FTS5 | 本地                           | MCP (默认 1 个工具)  | 各 agent 的探索加速       |
| Aider repo map   | tree-sitter tags + PageRank                         | 本地                           | 拼到 prompt          | 终端 pair programming     |
| Cursor 内建索引  | 文件分块 → embedding                                | 远端 Turbopuffer + Merkle 同步 | @Codebase            | Cursor IDE 内             |
| Continue.dev     | tree-sitter 分块 + embedding + FTS                  | 本地                           | @Codebase/@Folder    | IDE 插件                  |
| Sourcegraph Cody | SCIP + embedding                                    | 远端 Sourcegraph 实例          | 内建 + MCP           | 企业代码搜索              |
| Augment Code     | 专有 Context Engine                                 | 远端                           | MCP (远端 HTTPS)     | 企业级 agent, 跨仓        |
| Potpie.ai        | Neo4j 属性图                                        | 服务端                         | FastAPI + 专用 agent | 企业 spec-driven 大代码库 |
| Greptile         | 仓库依赖图                                          | 远端 SaaS                      | PR review agent      | AI code review            |
| Repomix / yek    | 整库拼大文本                                        | 本地                           | 复制粘贴 / MCP       | 长上下文一次性 dump       |
| CodeQL           | 数据流/控制流 facts → Datalog                       | 本地                           | QL 查询              | 安全分析                  |
| Glean (Meta)     | 通用代码事实库 + SCIP                               | 服务端                         | Glass API            | Meta 内部 IDE/RAG         |

对比要点 (延续初版分析, 按现状更新) :

对 Aider: 同样是 tree-sitter 路线的开山者, Aider 用 PageRank 在 token 预算内把全库符号摘要拼进 prompt (官方文档: --map-tokens 默认 1k tokens, 随对话状态动态调整) , 是"预算化的单次上下文"; CodeGraph 是"按需图查询", agent 自己决定问哪一片. 对 Aider 这种一次会话改几个文件的 pair programming 模式, PageRank 静态摘要足够好; 对 Claude Code 这种先派 Explore subagent 摸架构的 agent 流水线, 按需查询更省 token.

对 Cursor/Continue (embedding 派) : 根本差异在精确性. Cursor 的做法是教科书级 RAG (本地 tree-sitter 切块 → 上传服务器算 embedding → 存 Turbopuffer 向量库 → Merkle 树同步差异, 见 cursor.com/blog/secure-codebase-indexing) . embedding 擅长语义模糊查询 ("哪里在处理用户限流") , 但"谁调用了 validateToken"这类精确结构问题不可靠, 相似度排序会把名字相近但无关的函数排上来. CodeGraph 反过来: 结构关系精确, 模糊语义靠 FTS5 + 词干扩展尽力而为. README 的 Alamofire 基准 (一次查询还原完整 9 跳调用链) 是 embedding 路线几乎不可能完成的任务.

对 Sourcegraph Cody: 精确性维度类似 (Cody 用 SCIP——scip-typescript、scip-java、rust-analyzer 等真正的编译器/类型检查器抽取, 比 tree-sitter 更准, 懂泛型实例化和 import resolution 的所有边角, 代价是每种语言一个专门 indexer 且要能编译) , 部署模型相反——Cody 中心化 (数据上实例) , CodeGraph 本地化. 对需要跨百仓导航的大型组织 Sourcegraph 仍是天花板; 对不愿外传源码的团队 CodeGraph 是硬性优势.

对 Potpie.ai: 同为图派, 一轻一重. Potpie 走 Neo4j + FastAPI + Celery + CrewAI 的重型路线, 目标是百万行级企业 (据 itbrief.asia 融资公告, 2026 年 3 月完成 220 万美元 Pre-Seed, Emergent Ventures 领投, 已服务财富 500 强与受监管行业上市公司) ; CodeGraph 是一个 npm 包 + 一个 SQLite 文件. Potpie 的图更"语义化" (LLM 生成 docstring 入图) , CodeGraph 坚持确定性抽取——可复现、零成本、无漂移.

对 Augment Code: 商业 Context Engine, 官方口径上限"50 万文件、数十仓库同时索引", 主打 200K 上下文 + 智能检索而非百万 token 暴力填充; 企业合规 (SOC 2 Type II、ISO/IEC 42001) 、单租户、BYOK 是 CodeGraph 没有的; 代价是远端架构和按 credits 计费 (官方文档 docs.augmentcode.com: 平均每次查询 40-70 credits) .

对 Repomix/code2prompt/yek (整库 dump 派) : 哲学相反——它们假设长上下文模型能自己挑相关内容, CodeGraph 假设 agent 应该被引导只看相关子图. Next.js 仓库纯文本 5600 万 tokens, dump 派在大仓库瞬间失效 (yek 用 git history 排序部分缓解) ; 即使在 1M 上下文模型上, "应付得了"和"花得起"也是两回事.

对 CodeQL/Glean: 不同层次的目标. 它们是可查询的精确语义事实库 (CodeQL 用 QL 查数据流污点、Glean 用 Datalog 风格查 facts) , 表达力远超 CodeGraph, 但面向静态分析工程师而非 LLM agent. 安全分析场景两者互补而非竞争.

## 九、上手

安装 (自带 Node 运行时, 无需预装) :

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.sh | sh

# Windows
irm https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.ps1 | iex

# 或 npm
npm i -g @colbymchenry/codegraph
```

初始化:

```bash
codegraph install        # 检测已装 agent 并注册 MCP (只接线, 不索引)
cd your-project
codegraph init           # 建 .codegraph/ 并构图; 自动同步默认开启
```

CLI 主要命令 (src/bin/codegraph.ts, 克隆当前共 24 个) : install / uninstall / init / uninit / index / sync / status / ui (别名 web) / unlock / query / explore / context / node / files / callers / callees / impact / affected / daemon / telemetry / upgrade / version, 另有隐藏的 serve --mcp (MCP 传输入口) 与 prompt-hook. 相对上一版本新增的是 ui (浏览器查看器) 、unlock (清理残留锁) 与 context (为任务构建 markdown/json 上下文包, 恢复了外部集成依赖的命令契约) . 其中 affected 的 CI 用法:

```bash
git diff --name-only HEAD | codegraph affected --stdin --quiet | xargs vitest run
```

作为库使用 (需 Node 22.5+, node:sqlite 限制) :

```typescript
import CodeGraph from "@colbymchenry/codegraph";

const cg = await CodeGraph.init("/path/to/project");
await cg.indexAll();

const results = cg.searchNodes("UserService");
const callers = cg.getCallers(results[0].node.id);
const impact = cg.getImpactRadius(results[0].node.id, 2);
cg.watch();
```

## 十、结论与建议

适合采用 CodeGraph 的情形: 主力 agent 在 Claude Code / Codex / Cursor agent 模式等已适配的 9 款工具之内; 经常在万级文件项目工作 (收益随发现密度增长) ; 源码不能出域 (合规、隐私) ; 重视调用链、影响分析等精确结构化查询; 希望零基础设施试点; 计划建设 Sentry 错误自动修复等 agent 流水线 (第七章场景) .

不建议的情形: 需要跨仓推理与集中治理 (Sourcegraph、Augment) ; 主要诉求是语义模糊检索 (embedding 派更稳) ; 需要类型级精确性做安全分析 (SCIP/CodeQL) ; 需要 SLA 与 RBAC 的强管控环境 (当前无此能力面) .

给企业决策者的三句话总结: 第一, CodeGraph 证明了 agent 的探索成本可以用确定性预计算大幅压缩 (最新基准 -44% 成本/-88% 工具调用) , 这是 agent 规模化账单上最直接的杠杆; 第二, 它的本地架构 + SLSA 供应链签名 + 可审计遥测, 恰好落在"受监管行业也能过安全评审"的窄窗口里; 第三, 它目前是单仓工具而非平台, 企业落地姿态应当是"团队级自助试点 + 环境变量基线预置", 跨仓治理等待其托管平台 (getcodegraph.com) 成熟或另选中心化方案.

无论是否采用, 这个项目 7 个月 68k stars 的真正原因值得记住: 它没有发明新算法, 而是把"静态可推导的代码结构"从 LLM 的工作记忆里搬了出来——先吃掉 AST 能给的一切, 再谈语义层. CLAUDE.md 里那句判据——"你的回答是否好到让 agent 不去读文件"——值得所有做 agent 基础设施的团队记住.

## 附录: 调研方法与来源

本文更新基于以下一手材料 (首次调研 2026-08-12, 2026-08-26 复核, 2026-09-30 对照克隆核实, 2026-10-01 对照新 HEAD 复核) :

- 仓库克隆 colbymchenry/codegraph, HEAD 34ede4de (main, 完整哈希 34ede4de888c55aab170c3d6349c60d8dc56e7f2, package.json 1.6.1, CHANGELOG Unreleased 区块含 #2170~#2248 共 134 条解析精度修复条目), 源码级阅读
- GitHub API / gh CLI: stars 66,003、forks 4,156、contributors 42、open issues 409、created 2026-01-18、release 列表 (v0.9.5 至 v1.5.0) (2026-08 时点)
- 2026-08-26 复核 (GitHub API 与 npm registry) : stars 68,137、forks 4,336、open issues 448、最近推送 2026-08-25; 当时最新 release 与 npm 包均为 v1.5.0, License MIT
- 关键文件: package.json、README.md、CHANGELOG.md (当前 33 个块) 、CLAUDE.md、TELEMETRY.md、BUNDLING.md、src/db/schema.sql、src/db/migrations.ts、src/mcp/tools.ts、src/mcp/server-instructions.ts、src/types.ts、src/extraction/kernel/、src/resolution/name-matcher.ts、src/resolution/frameworks/ (含 name-heuristic.ts) 、codegraph-kernel/Cargo.toml 及 build.rs、src/bin/codegraph.ts、src/sync/watcher.ts、ui/ 与 src/ui-server/、docs/design/native-extraction-kernel.md、docs/design/rust-kernel-migration-plan.md、docs/design/framework-coverage.md、docs/design/generated-file-detection.md、docs/design/codegraph-ui-design-spec.md、docs/benchmarks/residual-context-occupancy.md、scripts/build-bundle.sh、.github/workflows/release.yml、install.sh
- 初版文章: 陶刚《CodeGraph 深度解析》 (知乎, 2026 年 5 月) , 本文保留其问题定义与赛道分类框架, 全部数据与架构描述已按克隆当前源码重新核实
