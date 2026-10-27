---
title: "OpenSpec: 面向 AI 编码助手的规格驱动开发协议层"
description: "解析 OpenSpec 的协议层定位、CLI 命令体系与懒加载设计、schema 与校验规则、proposal/specs/design/tasks artifacts 工作流、归档语义以及与大模型编码工具的集成方式"
local_path: "$HOME/Downloads/openspec"
---

OpenSpec 是一个轻量的规格驱动开发协议层: 它在"写代码"之前插入一个"人和 AI 先就计划达成一致"的步骤, 让人与助手审阅同一份结构化计划, 确认方向正确后再动手实现。本文说明它由哪些核心概念构成、CLI 命令体系如何组织、schema 如何定义工作流、校验器实际检查什么、proposal/specs/design/tasks 这套 artifacts 如何流转与归档, 以及它以何种方式适配众多 AI 编码工具。适合希望在 AI 辅助开发中引入可审阅、可回溯的变更包的工程师, 也适合正在评估规格驱动工具链、想知道其边界与取舍的读者。

文中行为均以源码核实为准。OpenSpec 以 npm 包 `@fission-ai/openspec` 分发, `engines` 要求 Node.js 20.19.0 及以上, CLI 入口是 `bin/openspec.js`。

## 一、协议层定位与核心概念

### 1.1 解决的问题

AI 编码助手能力很强, 但当需求只存在于聊天记录里时, 它会自信地构建错误的东西。OpenSpec 不试图替 agent 决策, 而是提供一份人和机器都能读的"协议": 把模糊提示先转成一段可审阅的 proposal, 确认后再由 agent 按计划实现, 最后归档为文档。因此它的产物是文件, 而不是某个 IDE 的专有状态——任何能读写项目文件的工具都能参与。

### 1.2 核心概念

1. Specs 是真相源。用结构化需求 (Requirement) 与场景 (Scenario) 描述系统行为, 规范性语句使用 RFC 2119 风格的关键词, 校验器以整词正则 `/\b(SHALL|MUST)\b/` 检测 `SHALL` 与 `MUST`。Spec 描述"现在是什么样", 是行为契约而非实现方案。
2. Change 是一个工作单元。一个功能、一个 bug 修复或一次重构各自一个文件夹, 多个 change 可以并行且互不冲突, 归档后保留完整上下文。
3. Delta Specs 描述变化量而非全貌。这是适配棕地开发的关键设计: 不重写整个 spec, 只写 ADDED/MODIFIED/REMOVED/RENAMED 四个区段。
4. Artifacts 相互依赖但不是门禁。依赖关系是一个有向无环图, 表示"可以做什么", 不强制"必须按什么顺序做"; 实现中发现设计有误可以直接改 design.md 继续走。schema 加载时会对 `requires` 做环检测, 发现环直接报 `Cyclic dependency detected`。
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

### 1.4 符号链接的支持与边界

叶子文件允许是符号链接: 一个 capability 的主 `spec.md` 可以指向项目内另一处的文件 (例如放在它所属的产品文档旁边), `list --specs`、`show`、`validate` 与 `archive` 都接受这种布局, OpenSpec 与那份文档因此读写同一份字节。此类链接的包含边界是项目根——持有链接的 capability 目录必须能从 specs 根之内到达 (词法上不允许借 `..` 越出), 链接必须可解析, 目标越出项目边界则拒绝; 对无法命名出项目的 specs 根 (如按路径给出的 store), 边界保持为 specs 根。归档写入路径时会把链接解析后的规范位置钉住作为信任根, 之后再把链接换指向别处的操作会被拒绝, 防止"校验"与"写入"之间目标被调换。capability 目录本身也可以是链接 (例如 monorepo 里指向另一个仓库), 发现阶段同样被支持, 但若写到项目之外会以警告形式报出真实写入位置。

## 二、命令体系与懒加载设计

### 2.1 两个执行场所

OpenSpec 的使用面分两处:

```text
终端                     AI 助手聊天框
openspec init  ──────>   /opsx:propose <change>
openspec list            /opsx:apply
openspec view            /opsx:archive
```

`openspec init` 在终端运行, 它把 slash commands 与 skills 写入所选的 AI 工具; 之后日常操作主要在 AI 聊天框中完成。没有单独的"交互模式"需要启动, `openspec` 的每个子命令都是执行即退出的, `openspec view` 也是打印一屏仪表盘后即返回。

### 2.2 命令定义与实现分离

CLI 的架构特点是把"命令定义"和"命令实现"分开。命令定义 (名称、选项、帮助文本) 在 CLI 入口 `src/cli/index.ts` 与 `src/cli/commands/` 中急切注册, 只依赖 commander 等轻量模块; 每个命令的实现则在其 action 执行时才通过 `await import()` 动态加载, 实现文件分布在 `src/core/` 与 `src/commands/` 下。这样 `--version`、`--help` 以及任意单个命令都不会把其它命令 (及其依赖的解析、校验模块) 拉进进程。

这一约束由端到端测试 `test/cli-e2e/startup-modules.test.ts` 守护: 测试通过 module hook 记录一次 CLI 调用实际加载的模块集合, 并用一张"命令 → 实现文件"映射表断言每个命令只加载自己的实现文件; 若命令定义层重新引入实现依赖, 测试会失败。对编辑器与 agent 高频调用 CLI 的场景, 单次启动开销因此显著降低。

### 2.3 profile 与 delivery

全局配置里的 profile 决定安装哪些工作流, delivery 决定以何种形态写入工具。profile 有 core 与 custom 两种, core 固定返回六条工作流:

| 工作流  | 说明                                                                     |
| ------- | ------------------------------------------------------------------------ |
| propose | 一步创建 change 并生成全部规划 artifacts                                 |
| explore | 思考伙伴: 探索想法、调查问题、澄清需求, 决策记在对话里, 写文件需用户确认 |
| apply   | 按 tasks.md 逐项实现并勾选 checkbox                                      |
| update  | 修订已有 artifacts 并保持相互一致; 从不写代码, 也从不创建缺失的 artifact |
| sync    | 把 delta specs 合并进主 specs (不归档)                                   |
| archive | 完成变更: 合并 delta 并把 change 移入 archive                            |

custom profile 可在全部十二条工作流中任选, 即在上述基础上增加 new (创建 change 脚手架)、continue (逐个创建下一个 artifact)、ff (快进生成实现所需的全部规划 artifacts)、verify (归档前验证实现是否匹配 artifacts)、bulk-archive (批量归档多个已完成 change)、onboard (引导式走完一个完整工作流周期)。选择 custom 且包含 archive 或 bulk-archive 时, 系统会在其前面自动补上 sync 依赖。

delivery 有三个取值: both、skills、commands, 默认 both。取 skills 时只写入技能文件, 取 commands 时只写入命令文件, both 时两者都写。命令与技能是两种不同的调用入口: 前者是工具的斜杠命令机制, 后者是工具原生的 skill 机制。

### 2.4 命令清单

终端子命令按用途分为几类, 许多涉及 OpenSpec 根的命令都接受 `--store <id>` 用于选择已注册的独立规划仓库:

```bash
# 初始化与维护
openspec init [path] [--tools all|none|<ids>] [--language <lang>] [--profile core|custom]
openspec update [path] [--force] [--dry-run [--json]]
openspec install [version]        # 安装不依赖 Node.js 的独立版本
openspec version [--json] [--check]
openspec doctor [--json]

# 浏览
openspec list [--specs|--changes] [--archived|--all] [--sort recent|name] [--json]
openspec view
openspec show <name> [--type change|spec] [--json] [--diff] [--deltas-only]
openspec status [--change <name>] [--all] [--schema <name>] [--json]
openspec instructions <artifact-id|apply|archive> --change <name> [--schema <name>] [--json]
openspec context [--json] [--code-workspace <path>]
openspec schemas [--json]
openspec templates [--schema <name>] [--json]
openspec spec show|list|validate

# 创建、校验与归档
openspec new change <name> [--description <text>] [--goal <text>] [--schema <name>] [--json]
openspec validate [item] [--all|--changes|--specs|--archived] [--strict] \
        [--report full|findings] [--type change|spec] [--concurrency <n>] [--json]
openspec archive <name> [--yes] [--skip-specs] [--no-validate] [--json]

# schema 管理
openspec schema which [name] [--all] [--json]
openspec schema fork <source> [name] [--force] [--json]
openspec schema init <name> [--artifacts proposal,specs,design,tasks] [--default] [--json]
openspec schema validate [name] [--verbose] [--json]

# store 与 workset
openspec store setup [id] [--path <dir>] [--init-git|--no-init-git] [--remote <url>] [--json]
openspec store register [path] [--id <id>] [--yes] [--json]
openspec store unregister <id> | remove <id> | list [--json] | doctor [id] [--json]
openspec workset create [name] --member <path|name=path> [--tool <id>] [--json]
openspec workset list | open <name> [--tool <id>] | remove <name> [--yes]

# 配置与辅助
openspec config list|get|set|unset|reset|edit|path|profile
openspec completion generate|install|uninstall [shell]
openspec feedback <message> [--body <text>]
```

几个值得展开的点:

- `validate` 不带范围开关时校验单个具名项; `--all`、`--changes`、`--specs` 触发批量校验, 并发度由 `--concurrency` 或环境变量 `OPENSPEC_CONCURRENCY` 控制, 默认 6。`--archived` 面向 pre-commit 场景: 校验已归档 change 的任务是否全部勾选。
- `archive --skip-specs` 跳过主 specs 更新操作, 适用于基础设施、工具或纯文档变更; 它与 change 元数据里的 `skip_specs: true` 标记是两条独立通路。
- `init --tools` 支持 `all`、`none` 或逗号分隔的工具 id 列表; `--language` 会把语言指令写入 `openspec/config.yaml` 的 `context`。
- `schema which` 展示一个 schema 从哪一级解析而来, 是调试解析顺序的入口。

### 2.5 `--json` 的 agent 契约

命令普遍支持 `--json`。面向 agent 的失败契约是: stdout 上恰好一份 JSON 文档, 形如该命令的"空形状"载荷加一个 `status` 数组 (每项含错误信息与诊断代码), 退出码为 1, 便于程序解析而不是抓取人类可读文本。首次运行的遥测提示写在 stderr, 且 `--json` 运行会推迟它, 保证 JSON 运行下 stdout 与 stderr 都不出现意外内容。

## 三、Schema 与校验规则

### 3.1 schema 的结构

Schema 定义 artifacts 的种类、依赖关系与模板, 默认是 `spec-driven` (包内置, `DEFAULT_SCHEMA` 常量)。内置 `schemas/spec-driven/schema.yaml` 的骨架:

```yaml
name: spec-driven
version: 1
description: Default OpenSpec workflow - proposal → specs → design → tasks
artifacts:
  - id: proposal
    generates: proposal.md
    template: proposal.md
    requires: []
  - id: specs
    generates: "specs/**/*.md"
    template: spec.md
    requires: [proposal]
  - id: design
    generates: design.md
    template: design.md
    requires: [proposal]
  - id: tasks
    generates: tasks.md
    template: tasks.md
    requires: [specs, design]
apply:
  requires: [tasks]
  tracks: tasks.md
```

每个 artifact 还有 description 与 instruction 字段: instruction 是给 AI 的详细写作指令, 大量"spec 是行为契约""delta 四区段格式""design 何时需要"的规则就写在这里; template 指向同目录 `templates/` 下的模板文件。文件末尾的 apply 块声明实现阶段的前置 artifacts (`requires` 至少一项) 与进度追踪文件 `tracks`。加载时还有一组结构校验: artifact id 不得重复、`requires` 必须引用已声明的 id、`apply.requires` 同理、依赖图不得有环; 单个 schema 最多声明 1000 个 artifact。`apply.tracks` 与任何 `generates` 值不完全相等时不阻断加载, 但 `openspec schema validate` 会以警告报出——此时 list 与 status 会退化为统计顶层 `tasks.md`。工作流定义与模板都是可编辑文件, 不在 TypeScript 里硬编码, 因此同一个 CLI 既能跑内置 spec-driven, 也能跑项目级自定义 schema。

### 3.2 输出路径的安全约束

`generates`、`template` 与 `apply.tracks` 的值在 schema 解析层有一组统一约束: 只接受相对路径, 绝对路径 (含 Windows 盘符路径)、含 `..` 段与含 NUL 字节的值直接拒绝。运行期解析 artifact 输出时, `path.join(changeDir, generates)` 的结果还要通过 changeDir 的包含断言; glob 输出的约束更细:

- 花括号/圆括号嵌套超过 16 层的模式在任何匹配发生之前就被拒绝;
- 花括号展开逐组进行, 单个模式累计展开结果不得超过 1024 个候选, 检查发生在候选被推入内存之前, 约束的是分配而不仅是最终结果;
- 每个展开后的模式先通过静态目录前缀 (base) 的包含检查, 再做逐级目录遍历的包含检查 (含符号链接规范化的逐级断言与链接环路检测), 最后才交给 glob 引擎 (tinyglobby, 只匹配文件、跟随符号链接);
- 匹配结果逐个再验证一次包含关系并规范化, 全部落在 change 目录之内。

### 3.3 schema 的解析与查找

为一个 change 选择 schema 时按以下优先级解析:

```text
CLI flag (--schema) > change 元数据 (.openspec.yaml 的 schema) > 项目 config.yaml 的 schema > 默认 spec-driven
```

schema 文件本身按三级顺序查找:

| 级别     | 位置                                                 | 说明                                                                                          |
| -------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 项目级   | `openspec/schemas/<name>/schema.yaml`                | 随版本控制, 优先级最高, 推荐                                                                  |
| 用户全局 | `$XDG_DATA_HOME/openspec/schemas/<name>/schema.yaml` | 个人复用, Unix/macOS 回退 `~/.local/share/openspec/`, Windows 回退 `%LOCALAPPDATA%\openspec\` |
| 包内置   | 随 npm 包发布的 `schemas/`                           | spec-driven 的兜底来源                                                                        |

schema 目录本身可以是符号链接 (指向目录即可, 悬空链接被排除), `schema fork`/`schema init` 换入 schema 时使用的暂存与备份目录 (带 `.fork-staging-`、`.init-backup-` 一类点号前缀/后缀) 不会被发现逻辑列出。`openspec schema which` 用于调试这个解析顺序, `schema fork` 可把内置 schema 复制到项目级再定制。

### 3.4 校验规则

校验器把结构解析、Zod schema 断言与一组可量化规则叠加起来, 产出的问题分 ERROR/WARNING/INFO 三级。普通模式通过条件是零 ERROR, `--strict` 的通过条件是零 ERROR 且零 WARNING。核心规则:

- 规范性关键词。校验器只检测 `SHALL` 与 `MUST` 两个词, 用整词匹配的正则; schema 指令还明确要求避免 should/may。关键词必须出现在需求正文 (即 `### Requirement:` 标题之后的描述文本), 只出现在标题里会被提示挪到正文。
- 场景。每条需求至少要有一个带正文的场景块。场景识别是代码围栏感知的: 围栏内出现的 `#### ` 标题不算场景, 只有标题没有正文的块也不计入。change 的 ADDED/MODIFIED 需求缺场景是 ERROR, 主 spec 缺场景是 WARNING。
- MODIFIED 的场景丢失检查。MODIFIED 块会与当前主 spec 对照, 若遗漏了主 spec 中仍存在的任一场景, 报 ERROR, 提示把遗漏的场景补回——因为 MODIFIED 是整块替换, 归档拒绝丢场景。validate 与 archive 复用同一套比较, 让问题在写作期暴露而不是归档时才失败。同一比较还要求: 存在 RENAMED 时 MODIFIED 必须引用重命名后的新标题。
- 重复与冲突。同一区段内重复的需求名是 ERROR; 跨区段冲突 (如 MODIFIED 与 REMOVED 同名、ADDED 与 REMOVED 同名) 也是 ERROR; RENAMED 的 FROM/TO 必须成对出现, 未配对的行报 ERROR。
- 长度与数量。需求描述超过 500 字符给 WARNING (change 侧只检查 ADDED, MODIFIED 保留既有全文不受长度规则约束); 主 spec 的 Purpose 少于 50 字符给 WARNING; delta 的需求描述少于 10 字符, 或 ADDED/MODIFIED 区段没有任何需求, 给 WARNING; Why 段长度须在 50–1000 字符之间、What Changes 不得为空、每个 change 的 delta 数量不得超过 10, 这几条由 Zod schema 断言, 违反即 ERROR。
- 零 delta 拒绝。一个 change 若没有任何 spec delta, validate 报 ERROR, 除非其 `.openspec.yaml` 声明 `skip_specs: true` (适用于纯重构、工具、文档类变更); 反过来, 声明了 `skip_specs: true` 却存在 spec 文件也会报错, 二者必须择一。
- 元数据键名。`.openspec.yaml` 的已知顶层键是 `schema`、`created`、`goal`、`affected_areas`、`initiative`、`skip_specs`、`retire_capabilities`; 未知键会收到警告并列出已知键。以小写 `x-` 开头且后接非空、不含空白名称的键 (如 `x-tracker`、`x-jiraKey`) 被视为其它工具的扩展字段而静默忽略, 仿照 OpenAPI 的 `x-` 扩展约定, 且仅限顶层。大写的 `X-Foo`、带空格的 `x- foo` 与裸 `x-` 都不构成扩展键, 仍会被告警。
- 归档不携带的文本。archive 只把需求块合并进主 spec, delta 中的其它文本——Purpose 与四个 delta 区段以外的 `## ` 小节、第一个 `## ` 标题之前的文本、ADDED/MODIFIED 中第一个需求之前的散文——会被 validate 与 archive 以 WARNING 报出, 提示挪进需求或 proposal.md/design.md, 避免静默丢失; 写在四个区段之外的孤立需求块同样以 WARNING 提示搬移。`--strict` 下这些警告升级为失败。
- 目的占位符。主 spec 的 Purpose 若仍是归档时写入的 `TBD - created by archiving change ...` 占位符或手写的 `TBD`/`TODO` 标记, 报 WARNING 并提示直接编辑主 spec。

批量校验的 spinner 只在可交互且列宽非零的流上渲染: 报告 0 列的 pty (如从 lefthook 一类 pre-commit 运行器继承而来, 或 `script -qec` 创建) 会让 ora 算出无穷大的清行数而无限循环, 此类流直接退化为普通输出; 非 TTY 流则由 ora 自行降级为单行输出。

### 3.5 校验强度与写作取向

同一组规则在 change 与主 spec 上的严格度不同: change 的 delta 是本次写作的产物, ADDED/MODIFIED 需求缺场景或整段正文缺失是 ERROR, 正文存在但缺 `SHALL`/`MUST` 给 WARNING (附带把关键词挪到正文的指引); 主 spec 是既有事实, 缺关键词或缺场景只给 WARNING, 整段 body 缺失才是 ERROR。这套差异化的目的是既对新写的变更保持强约束, 又不把历史 spec 一次性判死。规范语句的推荐写法:

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

### 4.1 图、排序与状态检测

artifacts 与它们的 `requires` 边构成一张有向无环图。引擎在此基础上做三件事:

- 拓扑排序。Kahn 算法按依赖顺序出队, 平级节点以 schema 中的声明顺序作为确定性 tie-break——spec-driven 里 specs 与 design 都只依赖 proposal, 声明顺序保证推荐顺序与 schema 作者写下的 proposal → specs → design → tasks 一致, 因此"下一个该写哪个 artifact"是可复现的。
- 状态检测。依据文件系统存在性判断每个 artifact 的状态, 取值只有四种:

| 状态    | 含义                                                                   |
| ------- | ---------------------------------------------------------------------- |
| done    | 输出文件已存在 (glob 输出至少有一个匹配文件)                           |
| skipped | change 声明 `skip_specs` 而按设计没有该 artifact, 计入完成以免阻塞下游 |
| ready   | 依赖已满足, 可以开始                                                   |
| blocked | 仍有未满足的依赖, 附带 `missingDeps`                                   |

skipped 的判定标准是 `generates` 路径以 `specs/` 开头 (路径前缀是约定, 不是 artifact id), 与 done 分开表示, 让消费者能区分"确实写了"与"按标记跳过"。

- 富指令生成。把模板、项目上下文、规则、依赖与解锁信息组装成一份可执行的写作指令。

### 4.2 status 与 instructions 的信息流

agent 驱动 CLI 的典型循环是: 查询当前状态, 取就绪 artifact 的富指令, 读取依赖, 创建一个 artifact, 观察解锁了什么, 然后继续。

```json
// openspec status --change "add-auth" --json (节选)
{
  "changeName": "add-auth",
  "schemaName": "spec-driven",
  "artifacts": [
    { "id": "proposal", "status": "done", "requires": [] },
    { "id": "specs", "status": "ready", "requires": ["proposal"] },
    { "id": "design", "status": "ready", "requires": ["proposal"] },
    {
      "id": "tasks",
      "status": "blocked",
      "requires": ["specs", "design"],
      "missingDeps": ["specs", "design"]
    }
  ],
  "isPlanningComplete": false
}
```

`status --json` 还会给出 `changeRoot`、`artifactPaths` (每个 artifact 的输出路径模式、解析后的具体路径与已存在的匹配文件列表)、`nextSteps` 与 `planningHome` 等字段; `--all` 则以 `changes` 数组批量返回, 单个 change 加载失败只携带诊断信息, 不中断整批。

`instructions` 的文本输出以一个 `<artifact>` 信封组织, 依次是: `<task>` (要创建什么)、`<project_context>` (项目上下文)、引用的 store 索引、`<rules>` (对应 artifact 的规则)、`<dependencies>` (要先读哪些文件)、`<output>` (写入路径)、`<instruction>` (schema 写作指令)、`<template>` (模板)、`<success_criteria>` 与 `<unlocks>` (完成后解锁什么)。JSON 形态下这些字段结构化返回, agent 无需解析散文。对 glob 输出的 artifact, 指令同时给出解析后的输出路径与已存在的匹配文件列表; 被 `skip_specs` 跳过的 artifact 不会收到创建指令, 只收到一条说明, 避免 agent 去写校验必然拒绝的文件。

负责写入的工作流模板 (propose、ff-change、continue-change、explore 等) 遵循同一条纪律: 先在 changeRoot 之内挑选具体路径, 解析符号链接化的父目录后验证它仍在 changeRoot 之内, 逃逸就停下并告知用户; 若 instruction 把创建委托给另一个 skill 或命令, 委托也必须落在这个已验证的输出路径上——验证永远发生在写盘之前。

### 4.3 四个 artifact 的职责

| artifact | 回答的问题       | 关键内容                                                                                         |
| -------- | ---------------- | ------------------------------------------------------------------------------------------------ |
| proposal | 为什么做、做什么 | Why、What Changes、Capabilities、Impact; 明确新能力与要修改的既有能力                            |
| specs    | 系统应该做什么   | 行为契约: 可观察行为、输入输出、错误条件、外部约束                                               |
| design   | 怎么实现         | Context、Goals/Non-Goals、Decisions 与备选方案、Risks/Trade-offs、Migration Plan、Open Questions |
| tasks    | 分几步做         | 带 checkbox 的编号任务, 每项写明如何验证完成                                                     |

design 只在确有需要时创建: 跨模块变更或新架构模式、引入新的外部依赖或显著数据模型变化、安全/性能/迁移复杂度、以及需要提前做技术决策才能消除的模糊性。

tasks 的格式有硬性约定: apply 阶段解析 checkbox 判断进度, 任务行兼容 `-`、`*`、`+` 与有序列表标记, 允许缩进的子任务; 只有框内是 `x` (大小写与空格宽容, `[ x]` 也算) 才计入完成, `- [~]`、`- [-]`、空的 `- []` 都算未完成, 没有 checkbox 的行不参与追踪。任务按依赖排序, 并要求每个任务组就地落地它自己的测试与文档, 而不是把测试和文档堆到最后一组。

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
- MODIFIED 替换主 spec 中对应的需求 (必须携带完整更新后的内容, 否则归档会拒绝或丢失细节);
- REMOVED 从主 spec 中删除;
- RENAMED 在主 spec 中原地重命名, 只改名不改内容。

两个边界机制: 为全新 capability 写 delta 时以 `## Purpose` 开头, 归档时用它作为新主 spec 的 Purpose; 若缺失, archive 会写入一个 TBD 占位符 (占位符本身会被 validate 识别并提示替换)。REMOVED 删掉某 capability 的最后一条需求时, 归档会删除该 spec 文件 (capability 退休), 但仅当 `.openspec.yaml` 声明 `retire_capabilities: true`——删除无法从工作区恢复、只能从 git 找回, 所以这是作者的显式决定, 而不是从 delta 形状推断的行为。对尚不存在的主 spec 只允许 ADDED, MODIFIED 与 RENAMED 会报错。

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

归档文件夹带 `YYYY-MM-DD-` 日期前缀 (若 change 名本身已带该前缀则不重复添加), 使历史按时间排列。sync 与 archive 共享"把 delta 合并进主 specs"这一步 (同一份 specs-apply 实现), 区别是 sync 不移动 change 文件夹, change 保持活跃。

### 5.2 归档的安全校验

归档会改写主 specs 与移动目录, 因此实现上有一组防护:

- 路径约束: 归档涉及的项目根、changes 目录、archive 目录与主 specs 目录必须都落在 OpenSpec 根之内, 否则以 `ArchiveBlockedError` 拒绝。
- 内容指纹: 移动目录前后对源与目标的 delta 内容计算指纹 (目录级为逐文件 SHA-256 聚合), 若在最终移动期间发生变化则中止, 避免把被并发修改过的内容当成已验证结果。
- 目标占用: 归档开始前用 claim 文件声明目标路径, 同名 archive 已存在或正被另一进程创建时报错。
- 退休授权: capability 退休需要 `.openspec.yaml` 的显式 `retire_capabilities` 标记, 归档时校验该授权与内容一致; 退休过程中的清理失败会以专门的错误码报出。
- 非交互 JSON 模式: `archive --json` 不提供交互提示, 未给出 change 名称时以一条阻塞诊断结束, 保证 agent 调用可预期。

`openspec validate --archived` 是面向 pre-commit 的补充: 校验已归档 change 的任务是否全部勾选。

## 六、与 AI 编码工具的集成

### 6.1 命令适配器与调用形态

集成由两条线组成。第一条是命令适配器: `command-generation` 的注册表里登记了 34 个工具适配器, 每个适配器负责两件事: 给出命令文件的路径, 以及把与工具无关的 `CommandContent` (名称、描述、分类、标签、正文) 格式化成带 frontmatter 的文件内容。调用形态由路径决定: 目录式命名 (`.../commands/opsx/<id>.md`) 的工具把命令注册为 `/opsx:<id>`, 文件名式命名 (`opsx-<id>.md`) 的工具注册为 `/opsx-<id>`; 前缀则是适配器自己的声明, 默认 `/`。几个典型:

| 工具                                               | 调用形态     | 生成位置 (示意)                                 |
| -------------------------------------------------- | ------------ | ----------------------------------------------- |
| Claude Code、Gemini CLI、Crush 等                  | `/opsx:<id>` | `.claude/commands/opsx/<id>.md` 等目录式命名    |
| Cursor、GitHub Copilot、OpenCode、Devin Desktop 等 | `/opsx-<id>` | `opsx-<id>.md` 文件名式命名                     |
| Amazon Q Developer                                 | `@opsx-<id>` | `.amazonq/prompts/opsx-<id>.md`, 前缀声明为 `@` |

### 6.2 技能文件与共享技能根

第二条线是技能文件: `skills/` 下与十二条工作流一一对应 (openspec-propose、openspec-apply-change、openspec-sync-specs 等, 共 12 个), 由 init/update 按 profile 选中的工作流写入各工具的 skills 目录。技能的内容驱动 `openspec` CLI 查询结构化数据, 因而跨编辑器兼容, 也是检测与漂移检查的对账基准。

内置工具目标共 50 个, 覆盖主流 IDE 与 CLI agent。其中部分工具只支持 skills 而没有命令文件形态 (如 Codex、Kimi Code、Amp、GSD、Zed 等只写技能), 因此命令适配器数量少于目标数量。一个特殊点是共享技能目录: Amp、Antigravity、Codex、GSD、Zed Agent 与通用目标都使用同一个 `.agents` 技能根, 系统通过写入 `<skillsDir>/skills/.openspec-target` 归属标记与对账逻辑避免重复写入与互相覆盖。列表末尾还有一个名为 `agents` 的通用目标 (写入共享 `.agents` 技能目录), 供未列出的工具使用, 在工具选择器里可以用 universal、other 等别名搜到。

### 6.3 工具检测与漂移检查

`openspec init` 会探测项目里哪些工具已存在 (依据各工具声明的 detectionPaths, 例如某工具的配置目录、指令文件或工作流目录), 并据此给出默认选择。已配置工具的状态由技能文件计数决定: 12 个技能全部存在才算 fullyConfigured。

命令与技能文件不带版本戳, 因此判断"是否最新"靠内容比较: 比较时容忍 UTF-8 BOM 与 CRLF 行尾这类 checkout 层面的差异; 漂移检查还会找出缺失的文件、当前 delivery 不应存在的文件、以及从 profile 中取消选择的工作流遗留的文件。`openspec update` 依据这些检查结果补写或清理, 并支持 `--dry-run [--json]` 只输出计划不落盘。

## 七、项目配置与跨仓库规划

### 7.1 `openspec/config.yaml`

`openspec/config.yaml` 提供项目级定制 (文件名 config.yaml 优先, 不存在时回退 config.yml):

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

- context 注入到所有 artifact 的指令中, 用 `<project_context>` 包裹并标注"不要写进产物"; 有 50KB 的硬上限, 超限则忽略并告警。
- rules 只注入到对应 artifact 的指令中, 用 `<rules>` 包裹。rules 的 key 会对照所有可用 schema 的 artifact id 校验 (因为不同 change 可以用不同 schema), 只匹配不到任何 schema 的 key 才会告警。
- operations guidance 只支持 apply 与 archive 两个操作 id, 在 `instructions apply` 或 `instructions archive` 时作为指令的一部分注入, 文本模式下明确标为 advisory (建议性)。

此外还认识两个字段: `store` (声明本项目默认使用的 store id, 仅当本目录只是配置壳、没有 specs/ 或 changes/ 时才被根解析采用) 与 `references` (引用的 store 列表, 条目可以是纯 id 字符串或带 `remote` 克隆源的映射); `githubCopilot` 目前只识别 `cloudAgent` 布尔开关, 控制是否生成 Copilot 云端 coding-agent 文件。解析是弹性的: 单个字段无效只丢弃该字段并告警, 不会让整个配置失效。

### 7.2 全局配置

全局配置位于 `$XDG_CONFIG_HOME/openspec/` (Unix/macOS 回退 `~/.config/openspec/`, Windows 回退 `%APPDATA%\openspec\`), 由 `openspec config` 子命令管理: `path`、`list`、`get`、`set`、`unset`、`reset`、`edit`, 以及 `profile` (交互式选择器或 preset 快捷方式)。可设置的顶层键有 `featureFlags`、`profile` (core/custom, 默认 core)、`delivery` (both/skills/commands, 默认 both)、`workflows`、`defaultStore` 与 `telemetry.enabled`。键路径校验会拒绝未知顶层键与 `__proto__`、`constructor`、`prototype` 一类不安全段。

### 7.3 store: 跨仓库规划

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

代码仓库通过 config.yaml 的 `references` 声明只读引用 (解析只深入一层, 不跟随被引用 store 自己的 references; 自引用被忽略; 解析失败一律降级为警告), 也可用 `store:` 声明默认 store。核心原则:

- store 就是 git 仓库, 通过 git push/pull 共享;
- OpenSpec 永远不会自动 clone/pull/push store; 它对 store 的全部 git 写操作就是 `store setup` 时可选的 `git init` 与一次初始 commit (可用 `--no-init-git` 完全跳过);
- 引用是只读上下文, 不移动任何人的工作。store 的本地登记由 `store register/unregister/remove/list/doctor` 管理。

根解析优先级是: `--store` flag 选择的注册 store 高于最近的祖先 `openspec/` 根 (该根若是真正的规划根则直接使用, 否则若其 config 有 store 指针则解析该 store), 高于全局配置的 `defaultStore`, 最后才轮到当前目录的隐式根。一个重要的失败语义是: 若机器上已注册 store 但都解析不到根, 命令会报根选择错误并给出诊断代码, 而不是兜底到隐式根, 避免工作静默落到错误的位置。

### 7.4 workset: 个人工作集

workset 是个人级的命名视图, 记录经常一起打开的文件夹, 保存在全局数据目录的 `worksets/worksets.yaml`:

```bash
openspec workset create platform \
  --member <store-path> \
  --member <repo-path> \
  --tool code
openspec workset open platform
```

`--member` 可重复, 第一个成员是主成员, 支持 `<name>=<path>` 形式命名; `open` 用所选工具打开整个视图, `remove` 只删除记录、从不触碰成员文件夹。workset 不共享、不提交, 纯粹是个人便利, 与 store 的团队共享定位互补。

## 八、网络行为、遥测与适用边界

网络行为有限且可关闭:

- 遥测是匿名且最小化的: 只记录命令名与版本, 不含参数、路径或内容, 匿名 id 是随机 UUID; 首次运行会在 stderr 打印一次提示。可用 `OPENSPEC_TELEMETRY=0`、`DO_NOT_TRACK=1` 或 `openspec config set telemetry.enabled false` 关闭, CI 环境与测试环境自动关闭。
- npm registry 版本检查只发生在 `openspec version --check` 与 `openspec update` (源码检出运行时跳过); 设置 `OPENSPEC_NO_UPDATE_CHECK`、处于 CI 或已按遥测规则退出, 都会跳过这次检查。
- 唯一的主动联网命令是 `openspec feedback <message>`: 它经 `gh` CLI 向上游仓库创建 issue, `gh` 缺失或未认证时降级为打印一个预填好标题与正文的 issue URL 让用户手动提交。

多语言支持通过 `init --language` 把语言指令写入 config 的 context, 内容包含"所有 artifacts 用该语言书写"与"OpenSpec 结构性标题和 SHALL/MUST 关键词保持英文"两条, 因为校验器与解析器依赖后者。

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
- 工作流是文件而非状态。所有真相都在 `openspec/` 目录的 markdown 里, 换工具、换机器都不丢上下文, 但也意味着没有哪份产物是工具替你自动维护的——归档、同步都需要显式触发。

从定位上看, OpenSpec 更接近"变更包的协议与工作流引擎", 而不是代码生成器: 它约束的是人与 AI 之间如何对齐、如何留痕、如何回收, 真正的实现仍由你所选的编码工具完成。这一点决定了它的集成策略——适配尽可能多的工具, 而不是要求用户迁移到某一个 IDE。
