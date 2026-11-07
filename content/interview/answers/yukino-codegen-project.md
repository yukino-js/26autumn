---
title: "Yukino Codegen AI 代码生成平台项目深挖：十连问"
description: "逐问核对源码事实与证据缺口：核心承诺、文件权威源、claimTurn 跨节点互斥与 TurnGate 公平准入、事件溯源序列号、OS 沙箱构建与能力 URL 预览、生成-运行-报错-修复闭环、rewind 双维回退、安全边界、量化结果的事实缺口与反思"
---

**项目事实核对型**示范答案。所有常量取自源码实读（本机 `~/github/yukino-codegen` @ `da904a2`）；十问中有若干「事实缺口」，文内以 ✅ **项目事实** / ⚠️ **推导或需澄清** 明确区分。这是「介绍一个你做过的 AI 生成 / Agent 编排平台」这一高频题的完整串讲脚本。

## 事实基线

| 事实依据   | 内容                                                                                                                                                                                                                                                                                 |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 本机检出   | `~/github/yukino-codegen`，当前 HEAD `da904a2`；pnpm workspace（`client/` React 19 + Vite 7，`server/` Hono 4 + Prisma 7）                                                                                                                                                           |
| 源码笔记   | `content/fe/yukino-codegen.md`，frontmatter `local_commit` 与本机 HEAD 一致                                                                                                                                                                                                          |
| 关键常量   | 均实读源码确认：`AI_MAX_ITERATIONS=40`、`AGENT_MAX_CONCURRENT_TURNS=4`、`AGENT_MAX_CONNECTIONS_PER_WORKSPACE=8`、`WORKSPACE_BUILD_TIMEOUT_MS=300000`（5 分钟）、`MAX_REWIND_POINTS=50`、`REPLAY_LIMIT=200`、`PLAN_APPROVAL_TIMEOUT_MS=10`（分钟）、`MAX_UPLOAD_IMAGE_BYTES=32`（MB） |
| 未归档产物 | 生成成功率、构建耗时分布、修复闭环命中率等**效果指标均未归档**（见 Q9 事实缺口）                                                                                                                                                                                                     |

:::danger 事实缺口
十问里有 **3 类事实缺口**：① 指标采集面目前**只有 token 用量**，前端监控在生产构建里实际不外发（可观测性接口已就位但尚未填满）；② 生成成功率、构建耗时、一键修复命中率**无归档统计**；③ 无 A/B 实验对比不同生成/修复策略。下面用 ✅ **项目事实** / ⚠️ **推导或需澄清** 标清。
:::

---

## Q1 · 一句话介绍这个项目 + 核心承诺

✅ **项目事实**：Yukino Codegen 是一个 AI 全栈代码生成平台——用户用一句自然语言描述想要的应用，平台在服务器上驱动一个真实的编码 Agent（以库形式复用 `@yukino.js/yukino`，经 `Remote.Server.createRemoteAgent`）在文件系统上迭代产出 Vite 工程，再在 OS 沙箱内完成依赖安装与生产构建，把 `dist` 产物经独立监听器发布为静态预览，最终在预览 iframe 里呈现一个**真实可运行的 Web 应用**。

**串讲口径**：核心承诺是「**描述它，看着它自己构建出来**」——得到的不是代码片段，而是能被浏览器直接打开运行的应用。与模板填充式生成的本质区别是「驱动真实编码 Agent 在文件系统迭代写代码」，能力上限不被模板锁死。

## Q2 · 理解这个平台的关键认知是什么

✅ **项目事实**：关键是抓住闭环两端各自的**事实权威**——**服务器磁盘是文件的权威源与唯一构建场地，浏览器只消费已发布的构建快照**。两个推论：① 只有 Agent 写服务器磁盘，浏览器没有可写副本，**不存在文件同步与合并冲突**；② 代价是用户不能手工改代码，源码修改只能经 Agent 或 zip 导出后本地进行。

**采分点**：能说出「**文件权威单一在服务器磁盘，浏览器只读构建快照**」——这是整个平台设计的基石，后面所有决策（无合并冲突、集中构建、能力 URL 预览）都从这里派生。

## Q3 · 一轮生成如何被编排与准入

✅ **项目事实**：用户输入经 WebSocket `run` 进入 `submit`，按运行时状态分流（运行中走 steering 或排队，空闲时按 `!`/`/`/普通文本分流）；`executeTurn` 单轮编排做两件关键事：

- **claimTurn 跨节点互斥**：用一条原子 SQL（`updateMany` 把会话状态从 IDLE 置为 RUNNING，条件是 `status=IDLE` 或 `status=RUNNING` 但 `lastActiveTime` 早于 `AGENT_TURN_CLAIM_STALE_MS`）抢占执行权——**用数据库行级原子性替代分布式锁**，后半条件回收崩溃节点留下的「僵死 RUNNING」。更新行数为 0 即抢占失败，回 `workspace_busy`。
- **TurnGate 进程级准入**：所有运行时共享一把门，上限 `AGENT_MAX_CONCURRENT_TURNS=4`，带**用户公平调度**（优先唤醒与上一个被准入者不同用户的等待者，防止单用户占满全局名额）。

**采分点**：能说出「**claimTurn 用原子 updateMany + 僵死回收替代分布式锁，TurnGate 做进程级并发上限 + 用户公平**」——这是「多实例下同一工作区轮次不并发」的完整答案。

## Q4 · 事件溯源如何支持断线重连不丢事件

✅ **项目事实**：会话持久化是**纯 DB** 的（引擎自身的 JSONL 写入被 `sessionId: ""` 禁用），权威记录是 `AgentSession` + 一串按序递增的 `AgentTranscriptEvent`（每个带 `sequence` bigint）。新连接发 `hello`（可带 `afterSequence`），服务器从高水位往回按批（每批最多 1000 条）推送 `transcript_batch`。**断线重连只需带上自己见过的最高序列号即可增量补齐，不丢事件**。

事件适配器（`createEventAdapter`）把引擎事件分两类：**高频 token 增量走瞬时通道**（`assistant_delta`，不落库），**累积的助手文本在轮末作为一条 `assistant_message` 落库一次**——这是「流式体验」与「存储成本」的平衡。

**采分点**：能说出「**序列号统一实时推送与可靠回放 + 瞬时增量不落库、轮末一次性落库累积文本**」。

## Q5 · OS 沙箱构建与能力 URL 预览如何工作

✅ **项目事实**：构建在 OS 沙箱内执行（Linux bubblewrap + 用户命名空间、macOS seatbelt），`npm install` + `npm run build -- --base=./`（相对 base 让 dist 在任意能力 URL 前缀下可搬运）。**沙箱不可用时直接抛错不执行任何命令（fail-closed）**。两个安全细节：

- **环境变量白名单**：构建子进程只拿 PATH/LANG/TERM，HOME/TMPDIR/npm_config_cache 全指向 scratch 目录，**不继承服务器进程环境**——数据库连接串、会话密钥、模型 API key 都不会泄漏进不可信项目的生命周期脚本（单测专门断言）。
- **进程组回收**：子进程 detached spawn，中止/超时/退出时对整个进程组（`-pid`）发 SIGKILL，收掉构建脚本留下的后代进程。

产物经**独立监听器**发布为能力 URL（`/p/<48 位 hex token>/<revision>/<path>`），不读 API cookie（URL 即授权），多层路径防御（realpath 双重校验防符号链接逃逸、只 GET/HEAD、no-store/nosniff/no-referrer）。**只保留最近两个 revision**（旧 iframe 在下次构建期间仍能加载稳定资产）。

**采分点**：能说出「**环境白名单不继承密钥 + 进程组 SIGKILL 收孤儿 + 失败保留旧快照 + 能力 URL realpath 双重校验**」——这是「集中构建不可信代码」的安全底线。

## Q6 · 生成→运行→报错→修复闭环如何闭合

✅ **项目事实**：预览桥（注入构建 HTML 的脚本）闭合两条反馈回路：**元素选中**（用户点选元素，`ELEMENT_SELECTED` 回传带标签/id/类名/CSS 选择器/包围盒，Agent 映射回源码）与**错误回传**（iframe 的 error/unhandledrejection/console.error 经 postMessage 转发）。一键修复用 `buildPreviewFixPrompt` 把错误拼成固定提示词（「make the smallest correct change, keep unrelated behavior intact」）作为 `previewError` 随 `run` 发给 Agent。

前端对跨窗口消息做**双向校验**：发送侧优先用预览 origin，接收侧要求 `event.source === iframe.contentWindow` 且 `event.origin === previewOrigin`，再过 zod schema 判别。

**采分点**：能说出「**预览桥闭合元素选中 + 错误回传两条回路，跨窗口消息双向校验 source/origin**」——这是「可视化编辑 + 一键修复」的完整机制。

## Q7 · rewind 双维回退如何同时锚定对话与代码

✅ **项目事实**：每次 `finalizeTurn` 保存上下文时，把当前轮末的对话位置**连同对应的 git 快照 sha 一起**作为检查点追加进 `runtimeMetadata.rewindPoints`（上限 `MAX_REWIND_POINTS=50`）。回退因此能同时锚定两个维度：`rewind_action { sha, action }` 的 action 三选一——`code_and_conversation`（对话与代码一起回退）、`conversation_only`、`code_only`。服务端执行会话消息截断（`conv.truncateTo`）+ transcript 截断并重置序列高水位（`truncateAfter` + `setSequence`）+ `git rewindTo`，然后广播 `session_replaced`，客户端把本地序列归零、重发 `hello` 从序列 0 拉全量重建。

**git 快照只在 outcome 为 `end_turn` 时做**（模型正常结束而非中断/出错）——只对良态做检查点，避免半写入状态污染快照历史。

## Q8 · 安全边界如何划定

✅ **项目事实**：三层安全边界——① **生成代码的执行隔离**：从不在服务器进程内执行，只在 OS 沙箱子进程里构建；浏览器侧不执行生成代码（预览是静态 dist + iframe sandbox 属性）；② **凭据加密**：MCP 服务器的 headers/env 以 AES-256-GCM 加密落库（`iv(12)||authTag(16)||ciphertext`），返回前端的 VO 完全脱敏（只暴露 `hasHeaders`/`hasEnv`）；③ **配置 fail-fast**：生产环境下 CORS 含通配、密钥仍是默认值、未配 REDIS_URL、STORAGE_DRIVER 仍是 local 等任一条件都**拒绝启动**。

⚠️ **推导/需澄清**：**OS 沙箱不是完整的多租户隔离边界**（是写路径限制而非虚拟机），托管不可信项目时应以专用 OS 账户或容器运行服务——这是要主动声明的边界，不能夸大为「完全隔离」。前端 XSS 靠 `renderSafeMarkdown`（marked + DOMPurify，FORBID_TAGS script/style）消毒，因为页面要渲染模型生成的任意文本。

## Q9 · 量化结果与事实缺口（诚实口径）

⚠️ **这是最容易翻车的一问，必须主动声明缺口**：

| 想说的             | 诚实口径                                                                                        |
| ------------------ | ----------------------------------------------------------------------------------------------- |
| 「生成成功率 X%」  | **无归档统计**——机制在，但成功率没有系统化采集                                                  |
| 「构建耗时优化」   | 单次构建默认 5 分钟超时（`WORKSPACE_BUILD_TIMEOUT_MS=300000`），但**实际耗时分布无归档**        |
| 「一键修复命中率」 | 修复闭环机制完整，但**命中率无 A/B 数据**                                                       |
| 「可观测性完善」   | **指标采集面目前只有 token 用量**，前端监控在生产构建里实际不外发——可观测性接口已就位但尚未填满 |

**标准话术**：「平台的机制与阈值常量都在源码里可查（并发 4 轮、每工作区 8 连接、构建 5 分钟超时、回退检查点 50 个），但生成成功率、构建耗时、修复命中率这些效果指标我没有归档——可观测性目前只采集了 token 用量，前端监控在生产构建里还没真正外发。要复现效果数据需要补一套评测。」

**采分点**：能主动声明「**可观测性接口已就位但尚未填满，效果指标无归档**」——把「机制完整」与「效果已证」分开讲，是项目深挖里最稀缺的诚实品质。

## Q10 · 反思与扩展

⚠️ **推导**（反思题展示判断力）：

1. **可观测性补全**：当前只有 token 用量指标，应补「生成成功率、构建耗时分布、修复闭环命中率、每轮工具调用成功率」，支撑「哪个环节最慢/最易失败」的优化决策。
2. **预览链路的栈绑定**：当前钉在 npm 生态 + `npm run build`（要求产出 dist/index.html 的 Vite 兼容构建），一键修复提示词面向 React 应用；扩展到其他栈需要适配预览与修复两端。
3. **没有 dev server 与热更新**：每次修改都要经一次完整构建，换来「预览即生产构建产物」的所见即所得；若要更快迭代可引入增量构建或 dev server，但要权衡「预览与生产一致性」。
4. **多租户隔离**：OS 沙箱不是完整隔离边界，公网多租户需要专用账户/容器或 microVM（如 Firecracker）。

**采分点**：反思要具体到可执行的改进，且承认现有设计的合理性（「钉在 npm + Vite 是为了预览即生产产物，当时是对的；扩展多栈是下一步」）。

---

## 追问链与应对

| 追问                                          | 应对要点                                                                                                              |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 「claimTurn 为什么不用 Redis 分布式锁」       | 原子 updateMany 已经是数据库层的行级互斥，无需额外组件；僵死回收靠 lastActiveTime 超时，比锁的 TTL 更贴合「轮次」语义 |
| 「事件溯源的序列号会不会成为瓶颈」            | bigint 高水位 + 每批最多 1000 条回放；单工作区轮次串行（claimTurn），序列号递增无竞争                                 |
| 「沙箱不可用为什么 fail-closed 而非降级裸跑」 | 裸跑不可信代码会泄漏密钥/破坏宿主——宁可构建失败也不放弃隔离                                                           |
| 「能力 URL 的 token 泄漏怎么办」              | token 是 48 位 hex 随机、URL 即授权；泄漏可重建工作区失效旧 token；生产应放独立预览 origin                            |
| 「rewind 回退代码后构建产物怎么办」           | git rewindTo 改的是工作目录源码，预览要重新构建发布新 revision；对话与代码两个维度可独立或一起回退                    |

---

**延伸阅读**

- [Yukino Codegen AI 代码生成平台项目深挖题库](/interview/qa/yukino-codegen-project)：本项目机制的 90 题深挖。
- [Yukino Code 编码 Agent 项目深挖示范答案](/interview/answers/yukino-code-project)：本平台复用的编码 Agent 内核的项目串讲。
- [Agent 沙箱与 JS 运行时题库](/interview/qa/agent-sandbox-autofix)：OS 沙箱、构建与自动修复的通用原理。
- [实时 IM 系统设计示范答案](/interview/answers/realtime-im-system-design)：另一套系统设计型示范（实时 IM 方向）。
- [指标口径与基线定义](/interview/metrics-baseline)：量化结论的证据纪律（本篇 Q9 的方法论）。
