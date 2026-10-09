---
title: "OpenSpec: 面向 AI 编码助手的规格驱动开发协议层"
description: "解析 OpenSpec 的协议层定位、CLI 命令体系与懒加载设计、schema 与校验规则、proposal/specs/design/tasks artifacts 工作流、归档语义以及与大模型编码工具的集成方式"
local_path: "$HOME/Downloads/openspec"
---

OpenSpec 是一个轻量的规格驱动开发协议层: 它在"写代码"之前插入一个"人和 AI 先就计划达成一致"的步骤, 让人与助手审阅同一份结构化计划, 确认方向正确后再动手实现。本文说明它由哪些核心概念构成、CLI 命令体系如何组织、schema 如何定义工作流、校验器实际检查什么、proposal/specs/design/tasks 这套 artifacts 如何流转与归档, 以及它以何种方式适配众多 AI 编码工具。适合希望在 AI 辅助开发中引入可审阅、可回溯的变更包的工程师, 也适合正在评估规格驱动工具链、想知道其边界与取舍的读者。

文中行为以源码为准, 无法从代码核实的部分会显式标注为推断或边界。OpenSpec 以 npm 包 `@fission-ai/openspec` 分发, 运行时要求 Node.js 20.19.0 及以上。

## 一、协议层定位与核心概念

### 1.1 解决的问题

AI 编码助手能力很强, 但当需求只存在于聊天记录里时, 它会自信地构建错误的东西。OpenSpec 不试图替 agent 决策, 而是提供一份人和机器都能读的"协议": 把模糊提示先转成一段可审阅的 proposal, 确认后再由 agent 按计划实现, 最后归档为文档。因此它的产物是文件, 而不是某个 IDE 的专有状态——任何能读写项目文件的工具都能参与。

### 1.2 五个核心概念

1. Specs 是真相源。用结构化需求 (Requirement) 与场景 (Scenario) 描述系统行为, 规范性语句使用 RFC 2119 关键词。Spec 描述"现在是什么样", 是行为契约而非实现方案。
2. Change 是一个工作单元。一个功能、一个 bug 修复或一次重构各自一个文件夹, 多个 change 可以并行且互不冲突, 归档后保留完整上下文。
3. Delta Specs 描述变化量而非全貌。这是适配棕地开发的关键设计: 不重写整个 spec, 只写 ADDED/MODIFIED/REMOVED/RENAMED 四个区段。
4. Artifacts 相互依赖但不是门禁。依赖关系是一个有向无环图, 表示"可以做什么", 不强制"必须按什么顺序做"; 实现中发现设计有误可以直接改 design.md 继续走。
5. Archive 闭合循环。归档把 delta specs 合并回主 specs, 并把 change 文件夹移入 archive 目录, 使 specs 反映最新现实, 下一个 change 基于更新后的 specs 继续。

### 1.3 目录结构

整个系统围绕项目根目录下的 `openspec/` 文件夹运转:

```text
openspec/
├── specs/                    系统当前行为描述 (真相源)
│   └── <capability>/spec.md
├── changes/                  提议中的修改, 每个变更一个文件夹
│   └── <change>/
│       ├── proposal.md       为什么做、做什么
│       ├── design.md         怎么做 (技术方案与架构决策)
│       ├── tasks.md          实施清单 (checkbox)
│       ├── .openspec.yaml    变更元数据 (schema、skip_specs 等)
│       └── specs/<capability>/spec.md   delta specs
│   └── archive/<date>-<change>/        已完成的归档
├── schemas/                  自定义工作流 schema (可选)
└── config.yaml               项目配置 (可选)
```

specs 与 changes 的分工是这套结构的核心: 前者是事实, 后者是意图, 归档是两者之间的合并动作。

## 二、命令体系与懒加载设计

### 2.1 两类命令, 两个执行场所

OpenSpec 的使用面分两处:

```text
终端                     AI 助手聊天框
openspec init  ──────>   /opsx:propose <change>
openspec list            /opsx:apply
openspec view            /opsx:archive
```

`openspec init` 在终端运行, 它把 slash commands 与 skills 写入所选的 AI 工具; 之后日常操作主要在 AI 聊天框中完成。没有单独的"交互模式"需要启动, `openspec` 的每个子命令都是执行即退出的。

### 2.2 CLI 命令注册与实现懒加载

CLI 的架构特点是把"命令定义"和"命令实现"分开。命令定义 (名称、选项、帮助文本) 在 CLI 入口与 `commands/` 目录中急切注册, 只依赖 commander 等轻量模块; 每个命令的实现则在其 action 执行时才通过 `await import()` 动态加载。这样 `--version`、`--help` 以及任意单个命令都不会把其它命令 (及其依赖的解析、校验、网络模块) 拉进进程。

这一约束由端到端测试守护: 测试记录一次 CLI 调用实际加载的模块集合, 并要求每个命令只加载自己的实现文件; 若命令定义层重新引入实现依赖, 测试会失败。对编辑器与 agent 高频调用 CLI 的场景, 单次启动开销因此显著降低。

### 2.3 profile 与 delivery

profile 决定安装哪些工作流, delivery 决定以何种形态写入工具。profile 有 core 与 custom 两种:

| 工作流  | 说明                                                          |
| ------- | ------------------------------------------------------------- |
| propose | 一步创建 change 并生成全部规划 artifacts                      |
| explore | 无风险的思考伙伴: 读代码、比较方案, 默认不创建文件            |
| apply   | 按 tasks.md 逐项实现并勾选 checkbox                           |
| update  | 修订已有 artifacts 并保持连贯性 (不写代码, 不补缺失 artifact) |
| sync    | 把 delta specs 合并进主 specs (不归档)                        |
| archive | 完成变更: 合并 delta 并移入 archive                           |

core profile 固定返回以上六条。custom profile 可选用全部工作流, 即在上述基础上增加 new (仅创建脚手架)、continue (逐个创建 artifact)、ff (快进生成全部规划 artifacts)、verify (验证实现是否匹配 artifacts)、bulk-archive (批量归档)、onboard (引导式教学)。选择 custom 且包含 archive 或 bulk-archive 时, 系统会自动补上 sync 依赖。

delivery 有三个取值: both、skills、commands。取 skills 时只写入技能文件, 取 commands 时只写入命令文件, both 时两者都写。命令与技能是两种不同的调用入口: 前者是斜杠命令, 后者是工具原生的 skill 机制。

### 2.4 命令清单

终端子命令大致分为几类:

```bash
# 初始化与状态
openspec init                  # 选择工具、语言、profile
openspec list [--specs]        # 列出活跃 changes 或主 specs
openspec view                  # 一屏仪表盘, 打印一次即退出
openspec show <name> [--type spec]
openspec status --change <name> --json
openspec instructions <artifact-id> --change <name> --json

# 创建与校验
openspec new change <name> [--schema <schema>] [--store <id>]
openspec validate <name> [--strict]
openspec validate --archived   # 校验已归档 change 的任务是否全部勾选
openspec archive <name> --yes

# schema 管理
openspec schemas
openspec schema fork spec-driven my-workflow
openspec schema init <name>
openspec schema validate <name>
openspec schema which <name>   # 查看 schema 从哪里解析

# store 与 workset
openspec store setup <id> --path <dir>
openspec store register <dir> | list --json | doctor
openspec workset create <name> --member <path> --tool <id>

# 配置与辅助
openspec config list | get | set | unset | reset | edit
openspec config profile
openspec completion install <shell>
openspec doctor
openspec context --json
openspec update
```

命令普遍支持 `--json`: 面向 agent 的失败契约是 stdout 上恰好一份 JSON 文档, 形如命令的空形状加 status 数组, 便于程序解析而不是抓取人类可读文本。

## 三、Schema 与校验规则

### 3.1 schema 定义什么

Schema 定义 artifacts 的种类、依赖关系与模板, 默认是 spec-driven。其骨架可以概括为:

```yaml
name: spec-driven
version: 1
artifacts:
  - id: proposal
    generates: proposal.md
    requires: []
  - id: specs
    generates: "specs/**/*.md"
    requires: [proposal]
  - id: design
    generates: design.md
    requires: [proposal]
  - id: tasks
    generates: tasks.md
    requires: [specs, design]
apply:
  requires: [tasks]
  tracks: tasks.md
```

除骨架字段外, 每个 artifact 还有 description、template (指向 templates/ 下的模板文件) 与 instruction (给 AI 的详细写作指令, 大量"spec 是行为契约""delta 四区段格式""design 何时需要"的规则就写在这里)。文件末尾的 apply 块声明实现阶段的前置 artifacts 与进度追踪文件。工作流定义与模板都是可编辑文件, 不在 TypeScript 里硬编码, 因此同一个 CLI 既能跑内置 spec-driven, 也能跑项目级自定义 schema。

### 3.2 schema 解析优先级与存放位置

选择 schema 时按以下优先级解析:

```text
CLI flag (--schema) > change 元数据 (.openspec.yaml) > 项目 config.yaml > 默认 spec-driven
```

schema 文件本身按三级顺序查找:

| 级别     | 位置                                        | 说明                                        |
| -------- | ------------------------------------------- | ------------------------------------------- |
| 项目级   | `openspec/schemas/<name>/schema.yaml`       | 随版本控制, 优先级最高, 推荐                |
| 用户全局 | XDG 数据目录下的 `openspec/schemas/<name>/` | 个人复用, Unix/macOS 默认回退到用户数据目录 |
| 包内置   | 随 npm 包发布的 `schemas/`                  | spec-driven 的兜底来源                      |

`openspec schema which` 用于调试这个解析顺序, `schema fork` 可把内置 schema 复制到项目级再定制。

### 3.3 校验规则

校验器把结构解析、schema 断言与一组可量化的规则叠加起来, 产出的问题分 ERROR/WARNING/INFO 三级。核心规则:

- 规范性关键词。校验器只检测 SHALL 与 MUST 两个词, 用整词匹配的正则; schema 指令还明确要求避免 should/may。关键词必须出现在需求正文 (即 `### Requirement:` 标题之后那一行), 只出现在标题里会被提示挪到正文。
- 场景。每条需求至少要有一个带正文的 `#### ` 标题块, 约定写成 `#### Scenario:`。计数是代码围栏感知的: 围栏内出现的 `#### ` 不算场景, 只有标题没有正文的块也不计入。change 的 ADDED/MODIFIED 需求缺场景是 ERROR, 主 spec 缺场景是 WARNING。
- MODIFIED 的场景丢失检查。MODIFIED 块会与当前主 spec 对照, 若遗漏了主 spec 中仍存在的任一场景, 报 ERROR; validate 与 archive 复用同一套比较, 让问题在写作期暴露而不是归档时才失败。归档按 RENAMED 先于 MODIFIED 的顺序应用, 因此 MODIFIED 引用重命名后的标题也能对上。
- 长度与数量。需求描述超过 500 字符给 WARNING; Purpose 少于 50 字符给 WARNING; delta 的需求描述少于 10 字符, 或 ADDED/MODIFIED 区段没有任何需求, 给 WARNING; 另有 Why 段落的长度上下限与每次变更 delta 数量上限等约束。
- 零 delta 拒绝。一个 change 若没有任何 spec delta, validate 会拒绝, 除非其 `.openspec.yaml` 声明 `skip_specs: true` (适用于纯重构、工具、文档类变更)。

`--strict` 模式的通过条件是零 ERROR 且零 WARNING, 即所有警告都升级为校验失败。

### 3.4 校验强度与写作取向

规则在 change 与主 spec 上的严格度不同: change 的 delta 是本次写作的产物, 缺关键词、缺场景都更倾向于以 ERROR 拦下; 主 spec 是既有事实, 缺关键词或场景只给 WARNING, 且只有整段 body 缺失才是 ERROR。这套差异化的目的是既对新写的变更保持强约束, 又不把历史 spec 一次性判死。规范语句的推荐写法:

```markdown
### Requirement: Session Expiration

The system MUST expire sessions after 30 minutes of inactivity.

#### Scenario: Idle timeout

- GIVEN an authenticated session
- WHEN 30 minutes pass without activity
- THEN the session is invalidated
- AND the user must re-authenticate
```

快速判断一段内容是否属于 spec: 如果实现方式可以改变而不改变外部可见行为, 它大概率不属于 spec。内部类名、库选择、实现步骤应放进 design.md。

## 四、Artifacts 工作流

### 4.1 Artifact graph 与状态检测

artifacts 与它们的 requires 边构成一张有向无环图。引擎在此基础上做三件事:

- 拓扑排序。排序在依赖顺序基础上以 schema 声明顺序作为确定性 tie-break, 因此"下一个该写哪个 artifact"是可复现的。
- 状态检测。依据文件系统存在性判断每个 artifact 的状态, 取值只有四种:

| 状态    | 含义                                                                    |
| ------- | ----------------------------------------------------------------------- |
| done    | 输出文件已存在                                                          |
| skipped | 因 change 声明 skip_specs 而按设计没有该 artifact, 计入完成以免阻塞下游 |
| ready   | 依赖已满足, 可以开始                                                    |
| blocked | 仍有未满足的依赖, 附带 missingDeps                                      |

skipped 与 done 分开表示, 是让消费者能区分"确实写了"与"按标记跳过"。

- 富指令生成。把模板、项目上下文、规则、依赖与解锁信息组装成一份可执行的写作指令。

### 4.2 status 与 instructions 的信息流

agent 驱动 CLI 的典型循环是: 查询当前状态, 取就绪 artifact 的富指令, 读取依赖, 创建一个 artifact, 观察解锁了什么, 然后继续。

```json
// openspec status --change "add-auth" --json
{
  "artifacts": [
    { "id": "proposal", "status": "done" },
    { "id": "specs", "status": "ready" },
    { "id": "design", "status": "ready" },
    { "id": "tasks", "status": "blocked", "missingDeps": ["specs", "design"] }
  ]
}
```

`instructions` 的文本输出按固定段落组织: 要创建什么、项目上下文、可选的参考 store 索引、对应 artifact 的规则、依赖、输出路径、schema 指令、模板、成功标准与解锁项。JSON 形态下这些字段结构化返回, agent 无需解析散文。

### 4.3 四个 artifact 的职责

| artifact | 回答的问题       | 关键内容                                                                                         |
| -------- | ---------------- | ------------------------------------------------------------------------------------------------ |
| proposal | 为什么做、做什么 | Why、What Changes、Capabilities、Impact; 明确新能力与要修改的既有能力                            |
| specs    | 系统应该做什么   | 行为契约: 可观察行为、输入输出、错误条件、外部约束                                               |
| design   | 怎么实现         | Context、Goals/Non-Goals、Decisions 与备选方案、Risks/Trade-offs、Migration Plan、Open Questions |
| tasks    | 分几步做         | 带 checkbox 的编号任务, 每项写明如何验证完成                                                     |

design 只在确有需要时创建: 跨模块变更或新架构模式、引入新的外部依赖或显著数据模型变化、安全/性能/迁移复杂度、以及需要提前做技术决策才能消除的模糊性。

tasks 的格式有硬性约定: apply 阶段解析 checkbox 判断进度, 只有 `x` (大小写与空格宽容) 计入完成, `- [~]`、`- [-]`、空的 `- []` 都算未完成, 没有 checkbox 的行不参与追踪。任务按依赖排序, 并要求每个任务组就地落地它自己的测试与文档, 而不是把测试和文档堆到最后一组。

### 4.4 delta 四区段与合并规则

delta spec 只写变化量:

```markdown
## ADDED Requirements

### Requirement: Two-Factor Authentication

...

## MODIFIED Requirements

### Requirement: Session Expiration

The system MUST expire sessions after 15 minutes of inactivity.

## REMOVED Requirements

### Requirement: Remember Me

Reason: Replaced by 2FA
Migration: Use the new authentication flow

## RENAMED Requirements

- FROM: `### Requirement: Login Rate Limit`
- TO: `### Requirement: Authentication Rate Limit`
```

归档时的合并顺序是 RENAMED → REMOVED → MODIFIED → ADDED:

- ADDED 追加到主 spec;
- MODIFIED 替换主 spec 中对应的需求 (必须携带完整更新后的内容, 否则归档会丢失细节);
- REMOVED 从主 spec 中删除;
- RENAMED 在主 spec 中原地重命名, 只改名不改内容。

两个边界机制: 为全新 capability 写 delta 时以 `## Purpose` 开头, 归档时用它作为新主 spec 的 Purpose; 若缺失, archive 会写入一个 TBD 占位符。REMOVED 删掉某 capability 的最后一条需求时, 归档会删除该 spec 文件 (capability 退休), 但仅当 `.openspec.yaml` 声明 `retire_capabilities: true`。

Delta 的价值在于三项: 一眼看出改了什么; 两个 change 改同一 spec 的不同需求不会冲突; 天然适配棕地, 无需先补全历史文档。

## 五、归档语义

### 5.1 归档做了什么

归档把提议合并进真相源并保留历史:

```text
归档前:
  specs/auth/spec.md              ← 没有 2FA
  changes/add-2fa/specs/auth/     ← delta: ADDED 2FA

归档后:
  specs/auth/spec.md              ← 包含 2FA
  changes/archive/<date>-add-2fa/ ← 保留完整历史
```

归档文件夹带日期前缀, 使历史按时间排列。sync 与 archive 共享"把 delta 合并进主 specs"这一步, 区别是 sync 不移动 change 文件夹, change 保持活跃。

### 5.2 归档的安全校验

归档会改写主 specs 与移动目录, 因此实现上有一组防护:

- 路径约束: 归档涉及的项目根、changes 目录、archive 目录与主 specs 目录必须都落在 OpenSpec 根之内, 否则以 blocked 错误拒绝。
- 内容指纹: 移动目录前后对源 delta 与目标 delta 计算内容指纹, 若在最终移动期间发生变化则中止, 避免把被并发修改过的内容当成已验证结果。
- 退休授权: capability 退休需要 `.openspec.yaml` 的显式声明, 归档时校验该授权标记与内容指纹一致。
- 非交互 JSON 模式: 未提供 change 名称时不会弹交互提示, 而是以一条阻塞诊断结束, 保证 agent 调用可预期。

`openspec validate --archived` 是面向 pre-commit 的补充: 校验已归档 change 的任务是否全部勾选。

## 六、与大模型编码工具的集成

### 6.1 两种适配层

集成由两条线组成:

- 命令适配器。`command-generation` 下注册了一批工具适配器, 每个适配器负责两件事: 给出命令文件的路径, 以及把与工具无关的 `CommandContent` 格式化成带 frontmatter 的文件内容。适配器决定命名位置, 从而决定调用形态:

| 工具                                                  | 调用形态     | 生成位置 (示意)             |
| ----------------------------------------------------- | ------------ | --------------------------- |
| Claude Code、Gemini CLI 等                            | `/opsx:<id>` | 目录式命名的 `opsx/<id>`    |
| Cursor、GitHub Copilot、Devin Desktop、Code Studio 等 | `/opsx-<id>` | `opsx-<id>.md`              |
| Amazon Q Developer                                    | `@opsx-<id>` | 适配器声明前缀为 `@`        |
| Codex、Kimi Code                                      | skill 调用   | 只写 skills, 不生成命令文件 |

- 技能文件。`skills/` 下有与工作流一一对应的技能 (openspec-propose、openspec-apply-change 等), 技能通过 CLI 查询结构化数据, 因而跨编辑器兼容。

一个特殊点是共享技能目录: 多个工具使用同一个 `.agents` 技能根 (例如 Amp、Codex、Zed Agent 与通用目标), 系统通过共享目标标记与对账逻辑避免重复写入与互相覆盖。

### 6.2 工具检测与漂移检查

`openspec init` 会探测项目里哪些工具已存在 (依据各工具声明的 detectionPaths, 例如某工具的配置目录或指令文件), 并据此给出默认选择。已配置工具的状态由技能文件计数决定: 全部技能存在才算 fullyConfigured。

命令文件不带版本戳, 因此判断"是否最新"只能靠内容比较: 漂移检查会比较磁盘上的命令文件与当前生成内容 (容忍 BOM 与 CRLF 差异), 并检查是否存在已取消工作流遗留的多余命令文件。`openspec update` 依据这些检查结果补写或清理。

### 6.3 内置目标数量

内置工具目标共 50 个, 覆盖主流 IDE 与 CLI agent, 并含一个通用目标用于"未列出的工具" (写入共享 `.agents` 技能目录)。命令适配器注册表中的适配器数量少于此, 因为部分工具只支持 skills 而没有命令文件形态。

## 七、项目配置与跨仓库规划

### 7.1 config.yaml

`openspec/config.yaml` 提供项目级定制, 主要字段:

```yaml
schema: spec-driven

context: |
  Tech stack: TypeScript, React, Node.js, PostgreSQL
  API style: RESTful

rules:
  proposal:
    - Include rollback plan
  specs:
    - Use Given/When/Then format for scenarios

operations:
  apply:
    guidance:
      - Run focused tests before the full suite
  archive:
    guidance:
      - Keep the completion summary concise

store: team-plans
references:
  - team-plans
```

注入机制有三条:

- context 注入到所有 artifact 的指令中, 用 `<project_context>` 包裹; 有 50KB 的硬上限。
- rules 只注入到对应 artifact 的指令中, 用 `<rules>` 包裹。rules 的 key 会对照所有可用 schema 的 artifact id 校验, 只匹配不到任何 schema 的 key 才会告警。
- operations guidance 在 `instructions apply` 或 `instructions archive` 时作为指令的一部分注入, 文本模式下明确标为建议性。

文件名 config.yaml 优先, 不存在时才回退 config.yml。除上表字段外, 还认识 store (本项目默认使用的 store id)、references (引用的 store 列表) 与 githubCopilot (目前只识别 cloudAgent 布尔开关)。

### 7.2 store: 跨仓库规划

当一个功能横跨多个代码仓库, 或需求由一个团队拥有、被其他团队消费时, 单仓库的 openspec 不够用。store 是一个独立的 git 仓库, 专门用来做规划:

```text
team-plans (独立规划仓库)
├── .openspec-store/store.yaml   身份标识
└── openspec/
    ├── specs/
    └── changes/
        ▲
   web-app / api-server / mobile-app (代码仓库)
```

代码仓库通过 config.yaml 的 `references` 声明只读引用, 也可用 `store:` 声明默认 store。核心原则:

- store 就是 git 仓库, 通过 git push/pull 共享;
- OpenSpec 永远不会自动 clone/pull/push store; 它唯一的 git 写操作是 `store setup` 时可选的 git init 与初始 commit;
- 引用是只读上下文, 不移动任何人的工作。

根解析优先级是: `--store` flag 高于最近的本地 openspec 根 (若该根是真正的规划根则直接使用, 否则若其 config 有 store 指针则解析该 store), 高于全局配置的 defaultStore, 最后才是当前目录的隐式根。一个重要的失败语义是: 若机器上已注册 store 但都解析不到, 命令会报根选择错误而不是兜底到隐式根, 避免工作静默落到错误的位置。

### 7.3 workset: 个人工作集

workset 是个人级的命名视图, 记录经常一起打开的文件夹:

```bash
openspec workset create platform \
  --member <store-path> \
  --member <repo-path> \
  --tool code
openspec workset open platform
```

workset 不共享、不提交, 纯粹是个人便利, 与 store 的团队共享定位互补。

## 八、适用场景与边界

适合使用 OpenSpec 的场景:

- 需要人和 AI 先对齐方向再动手的功能开发;
- 多人协作、需要可审阅变更包的团队;
- 棕地项目上描述对已有行为的修改, 用 delta 避免重写全貌;
- 跨仓库、跨团队的需求管理, 借助 store 把规划与实现分离。

不太适合的场景:

- 真正简单的一行修复, 仪式感不值得;
- 纯探索性原型, 尚未确定要不要做。

关键取舍:

- 自由度的代价是纪律。依赖是 enabler 而非 gate, 意味着需要自己保持每个 change 聚焦, 否则并行 change 会失控。
- Spec 只描述可观察行为。实现细节属于 design.md, 两者混写会同时降低两边的价值。
- 没有自动同步。store 的共享完全靠 git, 工具不会替你拉取或推送。
- 网络行为有限且可关闭。被动行为只有匿名遥测与 npm registry 版本检查 (后者发生在 update 与 version --check, 可用环境变量跳过); 唯一的主动联网命令是提交反馈, 它经 `gh` CLI 创建 issue, `gh` 不可用时降级为打印一个预填好的 URL 让用户手动提交。
- 多语言支持通过 `init --language` 把语言指令写入 config 的 context, artifacts 会用该语言生成, 但结构性标题与 SHALL/MUST 关键词保持英文, 因为校验依赖它们。

从定位上看, OpenSpec 更接近"变更包的协议与工作流引擎", 而不是代码生成器: 它约束的是人与 AI 之间如何对齐、如何留痕、如何回收, 真正的实现仍由你所选的编码工具完成。这一点决定了它的集成策略——适配尽可能多的工具, 而不是要求用户迁移到某一个 IDE。
