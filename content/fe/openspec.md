---
title: "OpenSpec 调研文档"
description: "Fission AI OpenSpec 调研: 规格驱动开发的协议层定位、CLI 命令与 schema 体系、校验规则、proposal/specs/tasks artifacts 工作流、50 个 AI 编码工具的集成方式"
---

仓库路径: https://github.com/Fission-AI/openspec (本机克隆位于 $HOME/Downloads/openspec, 本文按 main @ 760584b, 2026-10-01 的源码核对, HEAD 提交为 "fix(validate): fail --strict on requirements over the length limit (#2020)"; package.json 版本 1.14.0; 本机克隆为浅克隆, 基点之前的提交不在本地对象库, 无法核实)

## 一、OpenSpec 是什么

OpenSpec 是一个轻量级的"协议层"(agreement layer), 由 Fission AI 开发, npm 包名为 `@fission-ai/openspec`, MIT 协议开源.

它解决的核心问题: AI 编码助手很强大, 但当需求只存在于聊天记录中时, AI 会自信地构建错误的东西. OpenSpec 在"写代码"之前插入一个"先达成一致"的步骤 — 人和 AI 共同审阅同一份计划, 确认方向正确后再动手实现.

五个词概括: agree first, then build confidently.

```
没有 OpenSpec:
  模糊提示 ──> AI 猜测意图 ──> 生成 400 行代码 ──> 发现方向错了 ──> 推倒重来

有 OpenSpec:
  模糊提示 ──> 写一段 proposal ──> 审阅确认 ──> AI 按计划实现 ──> 归档为文档
              |___ 修正成本极低 ___|
```

## 二、核心哲学

```
fluid not rigid         — 没有阶段门禁, 随时可以回头修改任何 artifact
iterative not waterfall — 边做边学, 实现中发现设计有误就直接改
easy not complex        — 轻量设置, 最少仪式感, 几秒初始化
built for brownfield not just greenfield — 为已有代码库设计, 用 delta 描述变化量而非重写全貌
scalable from personal projects to enterprises — 从个人项目到企业团队都适用
```

与同类工具的定位区别:

| 对比对象        | 特点                              | OpenSpec 的差异                                                |
| --------------- | --------------------------------- | -------------------------------------------------------------- |
| GitHub Spec Kit | 重量级, 刚性阶段门禁, Python 依赖 | OpenSpec 更轻, 无门禁, 自由迭代                                |
| Kiro (AWS)      | 锁定特定 IDE 和 Claude 模型       | OpenSpec 内置 50 个工具适配目标 (含通用 .agents 目标) , 不锁定 |
| 什么都不用      | 模糊提示, 不可预测结果            | OpenSpec 在代码前建立可预测性                                  |

## 三、目录结构与核心概念

### 3.1 两个核心目录

整个系统围绕项目根目录下的 `openspec/` 文件夹运转:

```
openspec/
├── specs/              ← 真相源 (source of truth): 系统当前的行为描述
│   ├── auth/
│   │   └── spec.md
│   ├── payments/
│   │   └── spec.md
│   └── ui/
│       └── spec.md
├── changes/            ← 提议中的修改: 每个变更一个文件夹
│   ├── add-dark-mode/
│   │   ├── proposal.md       为什么做、做什么 (intent + scope)
│   │   ├── design.md         怎么做 (技术方案 + 架构决策)
│   │   ├── tasks.md          实施清单 (checkbox 列表)
│   │   ├── .openspec.yaml    变更元数据 (schema, created, skip_specs, retire_capabilities 等)
│   │   └── specs/            delta specs (描述"变化量")
│   │       └── ui/
│   │           └── spec.md
│   └── archive/              ← 已完成的变更归档于此
│       └── 2025-01-24-add-dark-mode/
├── schemas/            ← 自定义工作流 schema (可选)
└── config.yaml         ← 项目配置 (可选)
```

specs/ 描述"现在是什么样", changes/ 描述"打算改成什么样". 归档 (archive) 把提议合并回真相源, 循环闭合.

### 3.2 五个核心概念

1. Specs 是真相

用结构化需求 (Requirement) 和场景 (Scenario) 描述系统行为. 规范性语句遵循 RFC 2119 关键词, 但校验器只检测 SHALL 与 MUST 两个词 (正则 `\b(SHALL|MUST)\b`, src/core/parsers/requirement-text.ts 的 containsShallOrMust) , schema 指令还明确要求避免 should/may. 校验强度 (src/core/validation/validator.ts) : change 的 delta spec 缺关键词时, 整段 body 缺失是 ERROR, 否则给 "should contain SHALL or MUST (RFC 2119 best practice for English specs)" 式的 WARNING 引导; 主 spec 缺关键词同样是 WARNING (body 缺失才是 ERROR) ; --strict 模式的通过条件是零 ERROR 且零 WARNING, 即所有警告都升级为校验失败. 每条 Requirement 至少要有一个带正文的四级标题块: 场景计数器匹配任意 `#### ` 开头的标题 (约定写成 `#### Scenario:`), 三级标题、列表、以及只有标题没有正文的块都不计入. change 的 ADDED/MODIFIED 需求缺场景是 ERROR, 主 spec 缺场景是 WARNING (src/core/parsers/requirement-text.ts 的 SCENARIO_HEADER, hasScenarioBody 与 countScenarios) . 另有几条量化规则 (src/core/validation/constants.ts) : 需求描述 (### Requirement: 到第一个 scenario 之间的文本) 超过 500 字符 (MAX_REQUIREMENT_TEXT_LENGTH) 给 WARNING, --strict 直接失败, 该限制作用于 ADDED 需求与主 spec, MODIFIED 要求保留现有文本整体不动故不检查; ## Purpose 少于 50 字符 (MIN_PURPOSE_LENGTH) 给 WARNING (--strict 报太简短) , archive 生成的 TBD 占位符另有专门的 WARNING; delta 的需求描述少于 10 字符 (MIN_DELTA_DESCRIPTION_LENGTH) 、或 ADDED/MODIFIED 区段没有任何需求, 均给 WARNING. Spec 是行为契约, 不是实现方案.

```markdown
### Requirement: Session Expiration

The system MUST expire sessions after 30 minutes of inactivity.

#### Scenario: Idle timeout

- GIVEN an authenticated session
- WHEN 30 minutes pass without activity
- THEN the session is invalidated
- AND the user must re-authenticate
```

Spec 中应该有的: 可观察行为、输入输出、错误条件、外部约束 (安全/隐私/兼容性).
Spec 中不该有的: 内部类名/函数名、库/框架选择、实现步骤 (那些属于 design.md).

2. Change 是一个工作单元

一个功能 / 一个 bug 修复 / 一次重构 = 一个文件夹. 所有相关文档放在一起, 可并行多个 change 互不冲突, 归档后保留完整上下文供回溯.

3. Delta Specs 描述差异而非全貌

这是 OpenSpec 适配棕地开发的关键设计. 不需要重写整个 spec, 只写四个区段:

```markdown
## ADDED Requirements

### Requirement: Two-Factor Authentication

...

## MODIFIED Requirements

### Requirement: Session Expiration

The system MUST expire sessions after 15 minutes of inactivity.
(Previously: 30 minutes)

## REMOVED Requirements

### Requirement: Remember Me

(Replaced by 2FA)

## RENAMED Requirements

- FROM: `### Requirement: Login Rate Limit`
- TO: `### Requirement: Authentication Rate Limit`
```

归档时的合并规则 (源码按 RENAMED → REMOVED → MODIFIED → ADDED 的顺序应用):

- ADDED → 追加到主 spec
- MODIFIED → 替换主 spec 中对应的需求
- REMOVED → 从主 spec 中删除
- RENAMED → 主 spec 中对应需求原地重命名 (只改名, 不改内容)

三个相关机制:

- 为全新 capability 写 delta 时以 `## Purpose` 区段开头 (一两句话), 归档时用它作为新主 spec 的 Purpose; 已有 capability 的 delta 不需要它
- 一个 change 若没有任何 spec delta, `openspec validate` 会拒绝, 除非其 .openspec.yaml 声明 `skip_specs: true` (适用于纯重构、工具、文档类变更)
- REMOVED 删掉某 capability 的最后一条需求时, 归档会删除该 spec 文件 (capability 退休), 但仅当 .openspec.yaml 声明 `retire_capabilities: true`

Delta 的好处: 清晰 (一眼看出改了什么)、避免冲突 (两个 change 改同一 spec 的不同需求不冲突)、审阅高效、天然适配棕地.

4. Artifacts 相互依赖但非门禁

依赖关系是一个 DAG (有向无环图):

```
                proposal
               (root node)
                   │
       ┌───────────┴───────────┐
       │                       │
       v                       v
    specs                   design
 (requires:              (requires:
  proposal)               proposal)
       │                       │
       └───────────┬───────────┘
                   │
                   v
                tasks
            (requires:
            specs, design)
```

依赖只表示"可以做什么", 不强制"必须按什么顺序做". 这就是"enablers, not gates"的含义. 实现中发现设计有误? 直接改 design.md 继续走. 发现范围该缩小? 更新 proposal. 没有什么被锁定.

5. Archive 闭合循环

归档时: delta specs 合并进主 specs → change 文件夹移入 archive/ 带日期前缀 → specs 反映最新现实 → 下一个 change 基于更新后的 specs 继续.

```
归档前:
  specs/auth/spec.md          ← 没有 2FA
  changes/add-2fa/specs/auth/ ← delta: ADDED 2FA

归档后:
  specs/auth/spec.md          ← 包含 2FA 了
  changes/archive/2025-01-24-add-2fa/  ← 保留完整历史
```

## 四、命令体系

### 4.1 两种命令, 两个地方

```
    终端 (Terminal)                    AI 助手聊天框
┌──────────────────────┐          ┌──────────────────────────────┐
│  $ openspec init     │  安装    │  /opsx:propose add-dark-mode │
│  $ openspec list     │ ──────>  │  /opsx:apply                 │
│  $ openspec view     │  命令    │  /opsx:archive               │
└──────────────────────┘          └──────────────────────────────┘
     在这里运行 openspec               在这里运行 /opsx:*
```

`openspec init` 在终端运行, 它会把 slash commands 和 skills 写入所选的 AI 工具 (取决于工具和 delivery 设置, 可能只有 skills、只有 commands 或两者都有). 之后日常操作主要在 AI 聊天框中完成. 没有单独的"交互模式"需要启动.

### 4.2 Core Profile (默认安装)

| 命令          | 作用                                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------------------- |
| /opsx:explore | 无风险的思考伙伴: 读代码、比较方案、厘清需求, 默认不创建任何文件 (写入需用户逐项确认或明确要求捕获结论) |
| /opsx:propose | 一步创建 change 并生成全部规划 artifacts (proposal + specs + design + tasks)                            |
| /opsx:apply   | 按 tasks.md 逐项实现, 勾选 checkbox                                                                     |
| /opsx:update  | 修订已有 artifacts 并保持连贯性 (不写代码, 不创建缺失 artifact)                                         |
| /opsx:sync    | 将 delta specs 合并进主 specs (不归档, change 保持活跃)                                                 |
| /opsx:archive | 完成变更: 合并 delta + 移入 archive/                                                                    |

### 4.3 Expanded Profile (手动开启)

通过 `openspec config profile` + `openspec update` 启用:

| 命令               | 作用                                              |
| ------------------ | ------------------------------------------------- |
| /opsx:new          | 仅创建 change 脚手架, 不生成 artifacts            |
| /opsx:continue     | 逐个创建 artifact (适合边探索边推进)              |
| /opsx:ff           | 快进: 一次生成全部规划 artifacts (适合需求明确时) |
| /opsx:verify       | 验证实现是否匹配 artifacts (完整性/正确性/一致性) |
| /opsx:bulk-archive | 批量归档多个已完成的 changes                      |
| /opsx:onboard      | 引导式教学: 在你自己的代码库上走一遍完整流程      |

### 4.4 典型使用流程

```
TERMINAL   $ npm install -g @fission-ai/openspec@latest
TERMINAL   $ cd your-project && openspec init

AI CHAT    /opsx:explore              ← 可选: 先想清楚再动手
AI CHAT    /opsx:propose add-feature  ← AI 起草全部规划文档
           (你审阅、调整计划)
AI CHAT    /opsx:apply                ← AI 按 tasks 逐步实现
AI CHAT    /opsx:archive              ← delta 合并进 specs, change 归档
```

### 4.5 不同 AI 工具的命令语法

| 工具                           | 语法                    | 示例                                                |
| ------------------------------ | ----------------------- | --------------------------------------------------- |
| Claude Code, Gemini CLI        | /opsx:propose           | 冒号分隔                                            |
| Cursor, Copilot, Devin Desktop | /opsx-propose           | 连字符分隔                                          |
| Amazon Q                       | @opsx-propose           | @ 前缀                                              |
| Codex                          | $openspec-propose       | skill 调用, $ 前缀                                  |
| Kimi Code                      | /skill:openspec-propose | skill 调用, /skill: 前缀                            |
| Code Studio (Syncfusion)       | /opsx-propose           | prompt 文件 (.codestudio/prompts/opsx-\*.prompt.md) |

两类形态要分清: Claude Code/Gemini、Cursor/Copilot/Devin、Amazon Q、Code Studio 这几行是"命令文件", 由 src/core/command-generation/ 下 34 个工具适配器生成, 命名规则决定调用形态 — 写成 `opsx/<id>.md` 的工具 (Claude Code, Gemini, Crush 等) 注册成 `/opsx:<id>`, 写成 `opsx-<id>.md` 的工具 (Cursor, Copilot, Devin Desktop, Code Studio 等) 注册成 `/opsx-<id>`, 前缀默认是 `/`, 只有 Amazon Q 声明为 `@`; Codex 与 Kimi Code 属于 skills-only 工具, 不生成命令文件, 只写 skills, 对应两行是各自的 skill 调用语法 (skill 名为 openspec-propose 等, 与仓库 skills/ 目录一一对应) .

## 五、Schemas: 可定制的工作流

### 5.1 Schema 是什么

Schema 定义了 artifacts 的种类、依赖关系和模板. 默认是 `spec-driven`:

```yaml
name: spec-driven
artifacts:
  - id: proposal
    generates: proposal.md
    requires: []

  - id: specs
    generates: specs/**/*.md
    requires: [proposal]

  - id: design
    generates: design.md
    requires: [proposal]

  - id: tasks
    generates: tasks.md
    requires: [specs, design]
```

以上是骨架摘要. 真实的 schemas/spec-driven/schema.yaml 还包含: 顶层 version: 1 与 description; 每个 artifact 的 description、template (指向 templates/ 下的模板文件) 和 instruction (给 AI 的详细写作指令, spec-driven 的四段 instruction 就是"spec 是行为契约"、"delta 四区段格式"、"design 何时需要"等规则的出处) ; 以及文件末尾的 apply 块 (requires: [tasks], tracks: tasks.md) , 声明实现阶段的前置 artifacts 与进度追踪文件.

### 5.2 自定义 Schema

```bash
# 从已有 schema fork
openspec schema fork spec-driven my-workflow

# 从零创建
openspec schema init research-first

# 验证
openspec schema validate my-workflow
```

自定义 schema 示例 — 在 proposal 前加一个 research 阶段:

```yaml
name: research-first
artifacts:
  - id: research
    generates: research.md
    requires: []

  - id: proposal
    generates: proposal.md
    requires: [research]

  - id: tasks
    generates: tasks.md
    requires: [proposal]
```

Schema 存放位置 (src/core/artifact-graph/resolver.ts 的三级解析顺序) :

- 项目级: `<projectRoot>/openspec/schemas/<name>/schema.yaml` (随代码版本控制, 优先级最高, 推荐)
- 用户全局: `$XDG_DATA_HOME/openspec/schemas/<name>/` (遵循 XDG Base Directory 规范; Unix/macOS 默认回退 `~/.local/share/openspec/`, Windows 为 `%LOCALAPPDATA%/openspec/`)
- npm 包内置: 随包发布的 `schemas/` 目录 (spec-driven 就在这里, 兜底)

### 5.3 Schema 解析优先级

```
CLI flag (--schema) > change 元数据 (.openspec.yaml) > 项目 config.yaml > 默认 (spec-driven)
```

## 六、项目配置

`openspec/config.yaml` 提供项目级定制:

```yaml
schema: spec-driven

context: |
  Tech stack: TypeScript, React, Node.js, PostgreSQL
  API style: RESTful
  Testing: Vitest + Playwright

rules:
  proposal:
    - Include rollback plan
    - Identify affected teams
  specs:
    - Use Given/When/Then format for scenarios

operations:
  apply:
    guidance:
      - Run focused tests before the full suite
  archive:
    guidance:
      - Keep the completion summary concise
```

注入机制 (src/core/project-config.ts 与 src/commands/workflow/instructions.ts) :

- context 注入到所有 artifact 的 AI 提示中 (用 `<project_context>` 标签包裹) , 硬上限 50KB, 超限整段忽略并告警
- rules 只注入到对应 artifact 的提示中 (用 `<rules>` 标签包裹) ; rules 的 key 会对照所有可用 schema 的 artifact id 校验, 未知 id 给出警告
- operations guidance 在 openspec instructions apply / archive 时作为 artifact 提示的一部分注入, 文本模式下的标题是 "Operation Guidance (advisory)"

除这三个字段外, config.yaml 还认识: store: (声明本项目默认使用的 store id) 、references: (引用的 store 列表, 字符串或 \{id, remote\} 形式) 、githubCopilot: (目前只有 cloudAgent 布尔开关) ; 文件名 config.yaml 优先, 不存在时才回退 config.yml.

## 七、Stores (beta): 跨仓库规划

### 7.1 解决什么问题

当一个功能横跨多个代码仓库 (API server + web app + shared lib), 或者需求由一个团队拥有、被其他团队消费时, 单仓库的 openspec/ 不够用了.

### 7.2 Store 的形态

Store 是一个独立的 git 仓库, 专门用来做规划:

```
        team-plans (store: 独立规划仓库)
        ├── .openspec-store/store.yaml    身份标识
        └── openspec/
            ├── specs/
            └── changes/
                 ▲
    ┌────────────┼────────────┐
    │            │            │
web-app     api-server    mobile-app
(代码仓库)   (代码仓库)    (代码仓库)
```

### 7.3 使用方式

```bash
# 创建 store
openspec store setup team-plans --path ~/openspec/team-plans

# 在 store 中创建 change
openspec new change add-login --store team-plans

# 代码仓库声明引用 (只读)
# web-app/openspec/config.yaml:
references:
  - team-plans
```

核心原则:

- Store 就是一个 git 仓库, 通过 git push/pull 共享
- OpenSpec 永远不会自动 clone/pull/push
- 引用 (references) 是只读上下文, 不移动任何人的工作
- 命令解析优先级 (src/core/root-selection.ts) : --store flag > 最近的 openspec/ 目录 (若它是真正的规划根就直接用, 否则若其 config 里有 store: 指针就解析该 store) > 全局 config 的 defaultStore > 当前目录兜底

### 7.4 Worksets

个人级的命名视图, 记录你经常一起打开的文件夹:

```bash
openspec workset create platform \
  --member ~/openspec/team-plans \
  --member ~/src/api-server \
  --tool code

openspec workset open platform   # 在 VS Code 中一起打开
```

Worksets 不共享、不提交, 纯粹是个人便利.

## 八、架构设计

### 8.1 Schema Definitions + Artifact Graph

```
┌────────────────────────────────────────────────────────────┐
│  Schema Definitions (YAML)                                 │
│  ├── schema.yaml          工作流定义 (artifacts + 依赖)     │
│  └── templates/*.md       AI 生成模板 (可编辑)              │
│                    │                                       │
│                    v                                       │
│  Artifact Graph Engine                                     │
│  ├── 拓扑排序 (依赖顺序)                                    │
│  ├── 状态检测 (文件系统存在性)                               │
│  └── 富指令生成 (模板 + context + rules)                    │
│                    │                                       │
│                    v                                       │
│  Skill Files (.claude/skills/openspec-*/SKILL.md)          │
│  跨编辑器兼容, 技能通过 CLI 查询结构化数据                    │
└────────────────────────────────────────────────────────────┘
```

工作流定义与模板都是可编辑的文件 (schema.yaml 与 templates/*.md) , 不在 TypeScript 里硬编码; 因此同一个 CLI 既能跑内置的 spec-driven, 也能跑项目级自定义 schema. 相关实现集中在 src/core/artifact-graph/ (schema.ts 解析校验, graph.ts 负责拓扑排序与状态, resolver.ts 负责 schema 查找, instruction-loader.ts 组装富指令与 ArtifactStatus) .

### 8.2 信息流

agent 查询 CLI 获取当前状态 → 获取就绪 artifact 的富指令 → 读取依赖 → 创建一个 artifact → 展示解锁了什么 → 循环.

```
$ openspec status --change "add-auth" --json
{
  "artifacts": [
    {"id": "proposal", "status": "done"},
    {"id": "specs", "status": "ready"},
    {"id": "design", "status": "ready"},
    {"id": "tasks", "status": "blocked", "missingDeps": ["specs", "design"]}
  ]
}

$ openspec instructions specs --change "add-auth" --json
{
  "template": "# Specification\n\n## ADDED Requirements...",
  "dependencies": [{"id": "proposal", "path": "...", "done": true}],
  "unlocks": ["tasks"]
}
```

status 的取值共四种: done / skipped / ready / blocked (src/core/artifact-graph/instruction-loader.ts 的 ArtifactStatus) . skipped 专门用于声明了 skip_specs 的 change: 其 specs artifact 按设计没有 delta 文件, 直接计入完成以免阻塞下游 tasks, 但在状态里渲染为 skipped 而不是 done. instructions 的文本输出按固定顺序组织成若干段: `<task>` (要创建什么) → `<project_context>` (config 的 context) → 可选的参考 store 索引 → `<rules>` (对应 artifact 的 rules) → `<dependencies>` → `<output>` → `<instruction>` (schema 的 instruction) → `<template>` → `<success_criteria>` → `<unlocks>` (实现见 src/commands/workflow/instructions.ts 的 printInstructionsText 与 printOperationInputsText) .

## 九、工作流模式

### 9.1 快速功能 (需求明确)

```
/opsx:propose ──> /opsx:apply ──> /opsx:archive
```

### 9.2 探索式 (需求模糊)

```
/opsx:explore ──> /opsx:propose ──> /opsx:apply ──> /opsx:archive
```

explore 默认不创建任何文件, 纯粹是思考: 读代码、分析瓶颈、比较方案; 要把探索结论捕获为 change/artifacts, 需要用户明确要求, 或由 agent 说明写入范围并得到用户的 yes/no 确认 (当前版本 skill 的约定) . 当想法清晰后自然过渡到 propose.

### 9.3 并行变更

```
Change A: propose ──> apply (进行中)
                         │
                    上下文切换 (紧急 bug)
                         │
Change B: propose ──> apply ──> archive
                         │
                    切回来
                         │
Change A:            apply (继续) ──> archive
```

### 9.4 何时更新 vs 何时新建

```
                    这是同一个工作吗?
                         │
          ┌──────────────┼──────────────┐
          │              │              │
     意图相同?      重叠 >50%?     原 change 能
     问题相同?      范围相同?      独立完成吗?
          │              │              │
    YES → 更新      YES → 更新     NO → 更新
    NO  → 新建      NO  → 新建     YES → 新建
```

原则: 更新保留上下文, 新建提供清晰度.

## 十、Spec 编写指南

### 10.1 渐进式严格

Lite spec (默认, 大多数变更):

- 短小的行为优先需求
- 明确的范围和非目标
- 几个具体的验收检查

Full spec (高风险场景):

- 跨团队/跨仓库变更
- API/契约变更、数据迁移、安全/隐私相关
- 模糊性可能导致昂贵返工的场景

### 10.2 人机协作模型

```
1. 人提供意图、上下文、约束
2. Agent 将其转化为行为优先的需求和场景
3. Agent 把实现细节放在 design.md 和 tasks.md, 不放在 spec.md
4. 验证确认结构和清晰度, 然后才实现
```

### 10.3 判断什么属于 Spec

快速测试: 如果实现方式可以改变而不改变外部可见行为, 那它大概率不属于 spec.

## 十一、CLI 命令速查

```bash
# 初始化 (--language 可指定 artifacts 语言, --tools 非交互选择工具, --profile 覆盖全局 profile)
openspec init

# 查看版本与更新可用性 (--check 查询 npm registry, --json 机器可读)
openspec version [--check] [--json]

# 查看活跃 changes (--specs 列出主 specs, --archived/--all 含归档, --json 机器可读)
openspec list [--specs]

# 查看 change 或 spec 详情 (重名时用 --type change|spec 消歧)
openspec show <name>

# 查看状态 (JSON, 供 agent 消费)
openspec status --change <name> --json

# 获取 artifact 创建指令 (也接受 apply / archive 两个操作 id)
openspec instructions <artifact-id> --change <name> --json

# 创建 change 脚手架 (工作流模板要求走它创建, 不要手建目录)
openspec new change <name> [--schema <schema>] [--store <id>]

# 验证 spec 格式
openspec validate <name>

# 校验已归档 change 的任务是否全部勾选 (适合 pre-commit 钩子)
openspec validate --archived

# 交互式仪表盘
openspec view

# 归档
openspec archive <name> --yes

# 查看 artifact 模板解析路径
openspec templates [--schema <name>]

# Schema 管理
openspec schemas
openspec schema fork spec-driven my-workflow
openspec schema init <name>
openspec schema validate my-workflow
openspec schema which <name>          # 查看 schema 从哪里解析 (调试优先级)

# Store 管理
openspec store setup <id> --path <dir>
openspec store register <dir>
openspec store unregister <id>
openspec store remove <id> --yes
openspec store list --json
openspec store doctor

# 个人工作集
openspec workset create <name> --member <path> --tool <id>
openspec workset list
openspec workset open <name>
openspec workset remove <name> --yes

# 全局配置 (profile/delivery/defaultStore/telemetry 等)
openspec config list | get <key> | set <key> <value> | unset <key> | reset | edit
openspec config path                    # 打印全局配置文件位置
openspec config profile [core]        # 交互式选择 delivery 与 workflows

# shell 补全
openspec completion generate <shell>  # bash/zsh/fish/powershell, 输出到 stdout
openspec completion install <shell>

# 健康检查
openspec doctor

# 工作上下文 (agent 简报, 可顺带生成 .code-workspace)
openspec context --json

# 向维护者提交反馈 (GitHub issue)
openspec feedback "<message>" [--body <text>]

# 更新 agent 指令 (升级后执行; 会顺带检查 npm registry 上是否有新版)
openspec update
```

## 十二、设计取舍与适用边界

适合用 OpenSpec 的场景:

- 需要人和 AI 先对齐方向再动手的功能开发
- 多人协作、需要可审阅的变更包
- 棕地项目上描述对已有行为的修改
- 跨仓库/跨团队的需求管理

不太适合的场景:

- 真正简单的一行修复 (仪式感不值得)
- 纯探索性原型 (还不确定要不要做)

关键取舍:

- 自由度的代价是纪律: 没有门禁意味着需要自己保持 change 聚焦
- Spec 只描述可观察行为: 实现细节属于 design.md, 两者不混
- 没有自动同步: Store 的共享完全靠 git, OpenSpec 永远不会自动 clone/pull/push store (store 代码里唯一的 git 写操作是 setup 时可选的 git init + 初始 commit, 见 src/core/store/git.ts) . 被动网络行为只有两种: 匿名遥测上报和 npm registry 版本检查 (后者发生在 openspec update 与 openspec version --check, 可用 OPENSPEC_NO_UPDATE_CHECK 跳过) ; 唯一的主动联网命令是 openspec feedback, 它经 gh CLI 创建 GitHub issue, gh 不可用时降级为打印一个预填好的 issue URL 让用户手动提交

## 十三、技术细节

- 运行时要求: Node.js >= 20.19.0
- 安装: `npm install -g @fission-ai/openspec@latest`
- 包管理: 也支持 Homebrew, pnpm, yarn, bun, nix (仓库含 flake.nix)
- 遥测: 只收集命令名和版本 (无参数、路径、内容或 PII, 事件里显式设置 $ip: null 关闭 IP 追踪) , CI 环境自动禁用; 首次运行的隐私提示未展示过之前什么都不上报 (noticeSeen 机制) ; 事件发往自家域名 edge.openspec.dev 反代的 PostHog batch 接口; 可通过 `openspec config set telemetry.enabled false`、`OPENSPEC_TELEMETRY=0` 或 `DO_NOT_TRACK=1` 关闭
- 多语言: `openspec init --language "<语言>"` 会把语言指令写入 config.yaml 的 context, 之后 artifacts 用该语言生成; 结构性标题和 SHALL/MUST 关键词保持英文 (校验依赖它们), 已有项目则直接编辑 context 字段
- 推荐模型: 高推理能力模型 (文档推荐 Codex 5.5 和 Opus 4.7)
- 上下文卫生: 建议在开始实现前清理上下文窗口
