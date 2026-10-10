---
title: "A2UI Express: 用紧凑 DSL 降低 A2UI 的生成成本"
description: "A2UI Express 实验性提案的语法设计、编译到 v1.0 wire protocol 的映射规则、Python 参考实现的编译链路、conformance 固化规则、小模型评测结论与适用边界"
local_path: "$HOME/Downloads/a2ui"
---

A2UI Express(下称 Express)是 A2UI 官方以实验性提案形式引入的一层中间 DSL: 模型不再直接产出冗长的 A2UI JSON, 而是输出一种紧凑的行式语法, 由宿主侧编译器翻译回标准 A2UI 协议消息再下发给客户端。本文讲它为什么存在(原生 JSON 的生成成本问题)、语法设计如何用位置签名与去键化压低输出 token、编译器如何按目标协议版本产出不同信封、Python 参考实现里的编译与纠错链路, 以及小模型评测给出的收益与代价。适合要评估"生成式 UI 成本优化"、或在端侧小模型上落地声明式 UI 的协议与客户端工程师阅读。A2UI 协议本身见 [A2UI](a2ui)。

需要先交代定位与仓库分布: Express 不是新协议, 而是一种面向模型的压缩表示。提案文档在 `specification/proposals/express/` (技术规范 `a2ui_express.md`、`surface()` 设计文档 `create_surface_design.md`、由代码再生成的 `express_dsl_examples.md`、36 个 `.a2ui` 示例与 5 个命令行脚本); ANTLR4 语法文件被放在规范目录 `specification/inference_formats/express/Express.g4`; 参考实现位于 Python Agent SDK 的 `a2ui.inference_formats.experimental.express` 命名空间, 并在 `a2ui.inference_formats.express` 顶层再导出 (ExpressFormat 类标注 `@experimental`)。TypeScript (`typescript/a2ui_agent/src/inference-formats/express`, 从 Python 编译器移植, 基于 antlr4ng) 与 Dart (`dart/a2ui_agent/lib/src/inference_formats/express`, 目标 v0.9) 各有一份实现。本文会明确区分"提案文档描述"与"当前实现事实"。

## 一、为什么需要一层中间 DSL

### 1.1 原生 A2UI JSON 的生成成本

A2UI 应用到生产环境时绕不开的问题是: 如何让 LLM 高效、低成本、稳定地生成高质量协议。评估要素包括生成耗时、token 消耗、语法准确率(能否产出合法协议)与语义准确率(是否满足用户意图)。

原生 A2UI JSON 的结构键(id、component)、括号与重复引号占用了大量输出 token, 对端侧小模型尤其不友好。直观对比:

```text
// 原始 A2UI 协议
{ "id": "root", "component": "Card", "child": "main_column" }
{ "id": "main_column", "component": "Column",
  "children": ["header_row", "route_row"], "align": "stretch" }

// Express DSL
root = Card(main_column)
main_column = Column([header_row, route_row], "stretch")
```

### 1.2 Express 的定位

官方技术规范对它的概括是: 一种紧凑、面向模型优化的声明式语法, 作为高度压缩的中间表示由端侧大模型生成, 宿主侧编译器把它编译成标准 A2UI v1.0 wire protocol 载荷。

三个关键词决定了整套设计:

- 中间表示: 模型侧只学一种更小的语言, 客户端侧只认标准协议, 双方通过编译器解耦;
- 面向模型优化: 语法规则、prompt 契约、catalog 压缩都服务于"让弱模型也能稳定产出";
- 宿主侧编译: 生成与转换封装在服务端, 客户端渲染器保持纯粹。

### 1.3 隔离与门禁

官方刻意把这套东西与稳定基线隔离:

- 提案文档位于 proposals 目录而非已认证的版本规范目录; 只有 ANTLR 语法文件进了 `specification/inference_formats/`;
- 导入与命令行工具按提案 README 约定由环境变量 `A2UI_EXPRESS_ENABLED` 门禁(所有 python 调用需显式前置 `A2UI_EXPRESS_ENABLED=true`)——这是文档层约定, Python 代码侧没有对应的强制检查;
- 实现放在 experimental 命名空间下并以 `@experimental` 标注, 不影响 agent 主链路。

因此它的合理姿态是关注与小范围试点, 而不是作为稳定基线依赖。

## 二、设计目标

技术规范给出的四个目标:

1. 降低 token 足迹。去掉结构键、括号与重复引号, 官方宣称相比原生 wire payload 输出 token 降低 55% 到 70%。
2. 端侧小模型优化。面向上下文窗口与推理预算受限的本地模型(规范点名 Gemma 4 E2B / E4B 一类); 位置签名可以放进很短的 prompt 契约, 较少的协议闭合规则让模型在较小推理空间内完成生成。
3. 流式兼容。行式语法(每个组件一行), 宿主可逐行解析、逐步构建组件层级, 模型未输出完即可渐进渲染。
4. 协议对齐。与标准 A2UI v1.0 保持完整语义兼容, 支持数据绑定、客户端校验规则与本地事件处理。

概括: 在保持协议完整性与标准化能力的前提下, 用一个中间 DSL 把"生成 UI"变得更便宜、更快、更适合端侧模型。注意目标 3 是语法层属性: conformance 套件里逐块流式解析的用例(`response_streaming.yaml`)只覆盖 direct_json, Python 参考实现的 Express 解析器不实现分块解析, Express 响应按整块缓冲后解析。

## 三、语法与规则

### 3.1 词法与整体结构

所有 UI 布局包裹在 `<a2ui>` 哨兵标签内, 与对话文本分离。标签内是一条条赋值语句或独立语句(生命周期命令、独立函数调用)。`Express.g4` 在词法层直接丢弃: `#` 与 `//` 行注释、`/* */` 块注释、分号(概念上充当语句分隔符, 但与普通空白一样被跳过)与所有空白含换行——因此单条赋值可跨多行、多条语句也可共用一行。数组、映射与实参列表都允许尾逗号:

```text
<a2ui>
varname = ComponentName(arg1, arg2, param=value)
</a2ui>
```

### 3.2 变量与嵌套

- 保留变量 root 是界面树的唯一入口, 与标准协议的 root 组件要求一致;
- 提案规范要求变量名遵循 Unicode 标识符标准(UAX #31): 字母或下划线开头, 后续为字母、数字、下划线; 参考实现的词法规则目前是 ASCII 子集(`[a-zA-Z_][a-zA-Z0-9_]*`);
- 变量名默认就是组件的 A2UI `id`; 要产出含连字符等非法字符的 id, 用保留关键字参数 `id="content-grid"` 覆写;
- 引用先前轮次已创建、本块未定义的组件 id 时, 合法变量名写裸标识符, 含特殊字符写引号字符串: `main_column = Column([earlier_header, "earlier-body"])`;
- 支持混合嵌套: 子组件既可以赋值给顶层变量再按名引用(header = Text("Hello") 后 root = Card(child=header)), 也可以直接内联(Card(child=Text("Hello")))。

### 3.3 参数传递(省 token 的核心机制)

组件构造器同时支持位置参数与关键字参数, 二者可混用:

- 位置参数按 catalog 中组件属性的定义顺序映射(checks 属性不参与位置映射, 由 `?` 校验表达式单独收集)。Express 不硬编码任何组件名与属性, 属性名全部省略; 换 catalog、扩展组件都不用改编译器代码;
- 尾部可选参数可以直接省略; 中间要跳过的可选参数用下划线 `_` 占位;
- 关键字参数按参数名显式传递;
- 标注为 static 的参数必须是内联字面量或数组, 不能用 `$` 动态绑定, 违反时编译器抛 `ExpressForbiddenDatabindingError`;
- 保留关键字参数由编译器自身处理, 不进 catalog 映射: `id=`(组件 id)、`catalogId=`(组件/函数调用显式指定 catalog)、`functionCallId=`(独立调用的 RPC id)、`sendDataModel=` 与 `update=`(surface 语句)。

举例, catalog 顺序为 children、justify、align:

```text
// 原始 A2UI 协议(children + justify + align)
{ "id": "tc_root", "component": "Row",
  "children": ["tc_card"], "align": "stretch", "justify": "spaceBetween" }

// Express: justify 在 align 之前, 全部给出
tc_root = Row([tc_card], "spaceBetween", "stretch")

// justify 未指定: 中间跳过用下划线占位
tc_root = Row([tc_card], _, "stretch")
```

代价提醒: 位置即契约。catalog 扩展新属性或调整属性顺序时, 接入 Express 必须做相应适配, 否则新属性无法被正确解析。

### 3.4 原始类型

- 标准字符串: 双引号或三引号, 支持 \n、\t、\\、\" 转义, 允许内嵌换行;
- 原始串: r 前缀(大小写均可), 不处理转义, 反斜杠是字面量, 适合校验正则; 单行原始串不含换行, 多行用三引号原始串;
- 数字: 42 / 3.14 / -1; 布尔: true / false; 空值: null;
- 日期时间: 日期时间输入的值必须严格使用带时区偏移的 RFC 3339 格式(如 "2026-03-14T00:00:00Z")。

### 3.5 结构列表与映射

- 数组用方括号, 编译器映射到容器组件的子槽位;
- 映射用键值块, 键是字面量(标识符或字符串), 不支持动态变量作键;
- 动态列表模板用编译器保留的 `_template(path, templateComponent)` 辅助函数(恰好两个实参, 第一个必须是 `$` 数据绑定; 下划线开头以区别于自定义 catalog 组件), 编译为协议的 ChildList 模板形态 `{"path": ..., "componentId": ...}`——模板对象上的 `path` 是消息参数而非数据绑定, 在所有目标版本都保持不带 `@` 前缀:

```text
breedList = List(_template($/breeds, breedTemplate), "horizontal")
```

### 3.6 数据绑定与数据填充

- 绝对绑定: `$` 前缀加 `/` 开头路径, 从数据模型根解析;
- 相对绑定: `$` 前缀但不以 `/` 开头, 在列表模板迭代作用域内解析; 词法上 PATH 是 `$` 后跟字母数字下划线斜杠, 因此单独一个 `$` 是零长度路径, 解析到当前上下文根(模板内代表整个迭代项);
- 数据填充: 左值为数据路径的赋值语句直接写入数据模型, 值可以是字面量、数组或映射:

```text
$/icon = "check"
$/title = "Enable notification"
$/user = {firstName: "Alice", age: 30}
```

编译去向按作用域形态区分: 定义了 root 的作用域在 v1.0 目标下把数据模型嵌进 `createSurface.dataModel`, 在 v0.9 族目标下作为独立的 `updateDataModel` 消息追加; 只含数据路径赋值、完全没有组件的作用域产出独立的 `updateDataModel` 消息——若恰有一条赋值且指针深于一级, 消息带该精确 `path`, 否则以 `path: "/"` 携带聚合后的整个数据模型。

### 3.7 函数与事件

- 客户端函数按注册在 catalog 中的确切函数名嵌套调用, 例如 `Text(formatString("Welcome, ${/user/firstName}!"))`——好处是 catalog 换名时无需改编译器;
- 本地行为(如 openUrl)用同一套调用签名表达; 出现在组件 action / submitAction 属性位置时, 编译为标准的 `{"functionCall": {...}}` 客户端函数动作;
- 服务端事件用保留签名 `Event("name", context)`, 编译为 `{"event": {"name": ..., "context": ...}}`; 第二个映射实参成为 context; 未写 context 时省略该键, 显式写了空映射则保留 `"context": {}`;
- 必填 action 规则(prompt 契约第 14 条): 名为 action 的参数严格必填, 用户请求未描述动作时必须给哑事件 Event("click"), 不允许传 null 或省略。

### 3.8 校验规则

校验用 `?` 前缀表达, 编译为 `checks` 数组里的标准 `{"condition": <函数调用>, "message": <文案>}` 规则:

- 简单校验: ?required;
- 带参校验: `?regex("^[0-9]{5}$", "Must be a valid zip code")`——当校验函数首参名为 value 且未显式传绑定时, 编译器自动注入所在组件 value 属性绑定的路径; 追加在参数表之外的字符串实参成为失败提示文案; 不写文案时实现会补一条(措辞不由 conformance 固定);
- 组合: [?required, ?email];
- 多 catalog 场景下, 校验可以用 `{catalogId: "..."}` 映射实参显式指定所属 catalog。

### 3.9 独立语句: surface / deleteSurface / 函数调用

- `surface(surfaceId)` 或 `surface(surfaceId, catalogId)`: 声明后续组件定义的目标 Surface; 省略 surface() 时编译器回退到调用方传入的默认 surface id(缺省 `"default_surface"`); 关键字参数 `sendDataModel=true` 设置 createSurface 的同名标志, `update=true` 强制本作用域编译为 updateComponents(详见第四节);
- `deleteSurface("id")`: 独立命令, 编译为标准 deleteSurface 消息;
- 其他独立函数调用行: 编译为 `callRendererFunction` RPC 消息(仅 v1.0 目标支持, v0.9 族目标直接报错)。块内第 n 个独立调用的 `functionCallId` 为 `call_<n>`(从 1 计数), 可用保留关键字参数 `functionCallId=` 覆写; `functionCallId` 与 `callFunction` 都包在 `callRendererFunction` 信封内, `callFunction` 必须携带 `catalogId`:

```json
{
  "version": "v1.0",
  "callRendererFunction": {
    "functionCallId": "call_1",
    "callFunction": {
      "catalogId": "https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json",
      "@call": "openUrl",
      "args": { "url": "https://example.com" }
    }
  }
}
```

### 3.10 规则速查表

| 维度         | 写法                                                   | 说明                                   |
| ------------ | ------------------------------------------------------ | -------------------------------------- |
| 组件定义     | varname = ComponentName(arg1, ...)                     | 位置参数加可选关键字参数               |
| 字符串       | "文本" / """多行""" / r"正则\d+"                       | 标准串支持转义, 原始串不处理转义       |
| 数字/布尔/空 | 42 / true / null                                       |                                        |
| 列表         | [child1, child2]                                       | 映射到容器子槽位                       |
| 映射         | `{title: "Overview", child: contentCol}`               | 键是字面量                             |
| 数据绑定     | $/user/email / $lastName / $                           | 绝对路径 / 模板内相对路径 / 整个迭代项 |
| 数据填充     | $/title = "启用通知"                                   | 直接给数据路径赋值                     |
| 动态列表模板 | List(_template($/breeds, tpl), "horizontal")           | 生成 ChildList 模板                    |
| 服务端事件   | `Event("save_deal", {rep: $/form/rep})`                | 第二实参成为 context                   |
| 客户端函数   | openUrl("https://...")                                 | 按 catalog 签名直接调用                |
| 校验         | ?required / ?regex(pattern, msg) / [?required, ?email] | 编译为 checks 规则                     |
| 删除 surface | deleteSurface("surface-1")                             | 独立语句, 无需赋值                     |
| 目标 surface | surface("surface-1", update=true)                      | 独立语句, 声明组件归属与信封           |
| 组件 id 覆写 | Row([left, right], id="content-grid")                  | 变量名不是合法 id 时使用               |

## 四、surface() 指令与生命周期抽象

标准 wire protocol 区分初始化(createSurface)与更新(updateComponents)。为避免模型跟踪 surface 生命周期状态出错, Express 把这个区分抽象为单个 surface() 指令, 由编译器按块内结构推断信封, 而不是按会话状态:

- 模型侧: surface("id") 只声明目标 Surface, 之后所有组件赋值都归属该作用域; 一个 DSL 块可用连续 surface() 调用切换或创建多个 Surface;
- 编译器侧: 定义了 root 的作用域编译为 createSurface(v0.9 族目标下是裸 createSurface 加 updateComponents 加 updateDataModel 三条消息); 定义了组件但没有 root 的作用域编译为 updateComponents(有数据赋值再追加 updateDataModel); `update=true` 让作用域即使定义了 root 也编译为 updateComponents, 用于更新既有 Surface 的根容器; 作用域在下一个 surface() 调用、deleteSurface 调用或 DSL 块结束时终止;
- deleteSurface 保持显式独立命令;
- 省略 surface() 时回退到默认 surface id。

设计原则六条(来自 create_surface_design.md): 统一的 Surface 定向、多 Surface 支持、缺省回退、deleteSurface 显式化、catalog 规则(见下节)、模型简单性。它的价值在于把"缺 createSurface / 杂散 createSurface"这类生命周期失败从模型侧彻底移走——createSurface 与 updateComponents 的选择由 root 是否存在加 `update=` 标志结构化推断, 模型不需要维护跨轮次的状态; conformance 用例也明确"一个块背后没有会话", 声明 root 的块即创建 Surface。

catalog 在 surface 层的规则: 单 catalog 时 createSurface 携带该 catalog 的 catalogId, surface(id, catalogId) 可选; 多 catalog(仅 v1.0 及以上目标)时 createSurface 不带 catalogId, surface 行上点名 catalog 是错误, 每个编译出的组件与函数调用各自携带所属 catalogId。名字在多个 catalog 中重复定义时必须用 `catalogId=` 显式指定, 唯一时自动解析。v0.9 族 schema 只允许 catalogId 出现在 createSurface 上, 因此编译器对 v0.9 族目标拒绝多 catalog 与逐组件/逐函数的 catalogId 覆写。多 catalog 行为目前只在 Python SDK 完整实现; TypeScript 与 Dart 编译器仍回退到第一个 catalog(TypeScript 侧记录在 `typescript/a2ui_agent/KNOWN_GAPS.md`)。

## 五、编译产物与信封

编译目标版本可以是 v0.9、v0.9.1 或 v1.0; 未显式指定时取 catalog 声明的协议版本。

v1.0 目标下, 含 root 的作用域编译结果是单个 createSurface 消息, 内嵌 components 与 dataModel:

```json
{
  "version": "v1.0",
  "createSurface": {
    "surfaceId": "surface_id",
    "catalogId": "catalog_identifier",
    "components": [],
    "dataModel": {}
  }
}
```

这里有一处需要按代码事实校准: 提案技术规范的信封示例里还有一个 `surfaceParams` 字段, 但已认证的 v1.0 schema 中 CreateSurfaceMessage 只有可选的内嵌 `components`、`dataModel` 与 `metadata.extensions`, 不存在 surfaceParams; 参考编译器的产物同样不含 surfaceParams。也就是说, "内嵌单 createSurface 信封"约定里 components 与 dataModel 已被认证 schema 接纳, 仅 surfaceParams 一处仍停留在提案层面。

v0.9 族目标下, 同一作用域退回三条独立消息: 裸 createSurface、updateComponents(全部组件)、updateDataModel(有数据赋值时)。

编译示例(通知授权卡片), DSL 输入:

```text
<a2ui>
root = Card(main_column)
main_column = Column([icon, title, description, actions], _, "center")
icon = Icon($/icon)
title = Text($/title, "h3")
description = Text($/description, "body")
actions = Row([yes_btn, no_btn], "center")
yes_btn_text = Text("Yes")
yes_btn = Button(yes_btn_text, _, Event("accept"))
no_btn_text = Text("No")
no_btn = Button(no_btn_text, _, Event("decline"))
</a2ui>
```

输出要点(以参考编译器 v1.0 目标的实际输出为准): 邻接表扁平化后 root 引用 main_column; Column 的 align 为 "center", 被 `_` 占位的 justify 直接省略(提案 worked example 把它写作 `null`, 实际编译器先记 null 再在输出前统一过滤, conformance 夹具同样要求省略); Icon 绑定 `{"@path": "/icon"}`——v1.0 目标输出 `@path` / `@call` 保留键, v0.9 族目标输出 `path` / `call`; Button 的 action 编译为 `{"event": {"name": "accept"}}`(未写 context 时省略空 context, 提案示例写作 `"context": {}`); 全部组件(含被引用的 Text)位于同一个扁平 components 数组。

再看一个较完整的行程卡片示例, 它同时展示数据填充、格式化函数与相对/绝对绑定:

```text
<a2ui>
$/arrivalTime = "2025-12-15T14:30:00Z"
$/date = "2025-12-15"
$/departureTime = "2025-12-15T10:15:00Z"
$/destination = "New York"
$/flightNumber = "OS 87"
$/origin = "Vienna"
$/status = "On Time"
root = Card(main_column)
main_column = Column([header_row, route_row, divider, times_row], _, "stretch")
header_row = Row([header_left, date], "spaceBetween", "center")
header_left = Row([flight_indicator, flight_number], _, "center")
flight_indicator = Icon("send")
flight_number = Text($/flightNumber)
date = Text(formatDate($/date, "E, MMM d"), "caption")
route_row = Row([origin, arrow, destination], _, "center")
origin = Text(formatString("## ${/origin}"))
arrow = Text("## →")
destination = Text(formatString("## ${/destination}"))
</a2ui>
```

## 六、生成链路

### 6.1 端到端链路

```text
LLM 输出(对话文本 + a2ui 标签内的 DSL 块)
  -> 宿主(server agent)侧编译器
       Lexer / 解析 -> AST -> Schema mapper(位置参数映射)
       -> AST 扁平化 -> 标准 A2UI JSON(按目标版本选信封)
  -> 以标准协议下发到客户端渲染
```

部署位置的选择带来职责分离: 服务端 agent 加 LLM 负责生成完整协议, 内部可实现规则检测、循环验证; 客户端渲染器保持纯粹, 只面向 A2UI 协议, 不引入其他协议规则。

### 6.2 编译器内部(五阶段)

1. Lexer 与解析: 剥掉哨兵标签, ANTLR 词法/语法分析, 把块解析为语句列表;
2. AST 构建(访问器把语法树转成赋值/独立语句的结构化节点);
3. Schema mapper: 在 catalog schema 中查组件名, 丢弃 component / id 结构键; 按严格定义顺序读属性; 位置参数按序映射; 尾部可选可省略; 中间跳过用下划线占位;
4. AST 扁平化: 遍历变量引用, 变量名即组件 id, 子数组打包成标准 ChildList, 输出单个扁平 components 数组;
5. 信封构造: 按作用域形态与目标版本包装 createSurface / updateComponents / updateDataModel / deleteSurface / callRendererFunction。

参考实现另有几处确定性转换值得注意:

- 内联组件被提升到父组件之后, 并分配由"父组件 id + 属性名"拼成的稳定 id (数组内再加下标), 没有父上下文时回退为 `_inline_<n>` 计数;
- 被 `_` 跳过的位置先记为 null, 输出前统一过滤(conformance 夹具要求省略; 提案 worked example 写 null, 但 basic catalog 的可选枚举属性不接受 null, 以编译器输出与自身 catalog 的取值约束为准);
- 只有持有组件调用的变量才产出组件; 持有映射、Event 或校验表达式的变量在被引用处就地替换, 自身不产出任何组件;
- 静态属性(schema 不允许数据绑定)收到 `$` 绑定时报 `ExpressForbiddenDatabindingError`; 字符串实参落在期望选项对象的列表槽位时归一化为 `{"label": ..., "value": ...}`;
- 枚举属性收到不在枚举内的字符串值、组件缺必填属性、未知属性名/参数名、重复属性/参数, 都是编译期 ValidationError。

错误分两大类(每类下有细分的子类, 子类携带 help_message 修复提示): `ExpressParseError` 针对格式读不动的文本(含缺 root、引用未定义子组件), `ExpressValidationError` 针对读得动但引用了 catalog 未声明内容或值不合法的载荷。conformance 套件的注释还固化了一条容易漏的规则: "组件携带 catalog 未声明的属性是非法的"这条约束住在消息信封层——发布 catalog 的组件 schema 是开放的, `agent_to_renderer.json` 在补上信封自己的 id 之后才用 `unevaluatedProperties` 收口, 实现必须校验将要发出的整条消息而不是裸 catalog schema。

### 6.3 prompt 契约与 catalog 压缩

喂给模型的不再是原始 JSON Schema catalog, 而是由 prompt 生成器把 catalog 编译成紧凑的位置签名文本——压缩 catalog 同时也是节省输入 token 的手段。签名生成规则: 读取 catalog schema, 跳过 component / id 结构键, 按属性定义顺序输出"名字(参数列表)"签名, 可选参数加 `?` 后缀; schema 不允许数据绑定的参数标注 `(static)`, `$ref` 指向 ComponentId 的参数标注 `(component ID)`。

实际生成的 prompt 契约(EXPRESS_RULES)包含三部分:

- 工作流描述与 15 条语法规则: 哨兵标签、root 必需、原始类型与 RFC 3339 日期、列表与映射、$ 绑定(含裸 `$`)、? 校验与错误文案、Event、嵌套函数、数据填充、_template、deleteSurface、static 参数、必填 action 哑事件、surface 指令; 多 catalog 时追加一段由 catalog id 与重名清单生成的专用规则;
- basic catalog 全部组件的位置签名, 每个参数带描述、枚举值与 static 标注, 对象/数组参数还展开映射键说明。例如:

```text
Button(child (static), variant? (static), action (static), weight? (static), checks? (static))
  - child: The ID of the child component. Use a 'Text' component for a labeled button...
  - variant: ... Must be one of: 'default', 'primary', 'borderless'
```

- 客户端函数的位置签名(and、email、formatCurrency、formatDate、formatNumber、formatString、length、not、numeric、openUrl、or、pluralize、regex、required), 各带参数描述。

签名与规则都严格从 catalog JSON 派生(单一事实源), prompt 生成器不做任何硬编码的字符串替换或正则过滤; 参数描述需要调整时改 catalog schema 本身。few-shot 示例由反编译器把标准 A2UI JSON 示例机械转回 DSL 生成, 保证示例与当前 catalog/协议版本一致。

### 6.4 推理与验证流程

端到端评测脚本(`scripts/run_inference.py`)的流程:

1. 加载标准 A2UI JSON 示例, 提取其中 updateComponents 的 components 列表作为翻译目标(评测路线是"标准 JSON -> Express -> 标准 JSON"的往返对照);
2. 用 ExpressFormat 的 prompt 生成器生成 system instruction(catalog 缺省为 `catalogs/basic/v1/catalog.json`);
3. 构造翻译任务的 user prompt: 按位置签名逐行输出变量赋值, 不输出 createSurface 信封;
4. 提交给模型(三种模式: 缺省远程 Gemini API——默认模型名 gemma-4-31b-it、`--local` 本地 Ollama(:11434)、`--mlx` 本地 Apple MLX-LM(:8080, 默认模型 mlx-community/gemma-4-e2b-it-4bit); 温度统一 0.1);
5. 返回的 DSL 经编译器编译回 pretty-printed 标准 JSON; 编译本身即校验, 未定义的组件引用、未知属性与非法枚举值会在此被拒。

### 6.5 错误恢复与微修复循环

技术规范描述了编译器遇到语法错误或 catalog schema 不匹配时的结构化错误恢复(比整块校验-重试更细粒度):

1. 隔离: 标记非法行, 只丢弃该行所在的 AST 子分支, 继续解析其余行, 避免整个界面崩塌;
2. agent 侧微修复: 把非法行、目标组件签名与解析器错误信息打包成一个很小的纠正 prompt;
3. 快模型修正: 在转 JSON 之前发给一个快模型; 由于 prompt 小且只针对单行, 执行很快;
4. 热替换: 修正后的语句热替换进活动 AST, 再最终化渲染输出。

这套机制的意义在于把一次错误的影响面从"整块 UI 重试"缩小到"单行修补", 对延迟敏感与调用量大的场景尤其有价值。参考实现里与之对应的部分是错误监听器与"非最终轮"解析: `compile(dsl_text, is_final=False)` 时解析错误被吞掉返回空语句表, 最终轮才抛出带行列号的 SyntaxError 或 ExpressParseError; 行级微修复循环本身是提案层的编排设计, 由 agent 侧代码围绕编译器组织。

## 七、工具链与实现

提案目录下的命令行脚本已覆盖完整开发闭环(全部经 `A2UI_EXPRESS_ENABLED=true uv run --project python/a2ui_agent` 调用):

| 脚本                             | 用途                                                                                                                                |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| scripts/run_inference.py         | 端到端推理 + 编译 + 校验(Gemini API / Ollama / MLX-LM 三模式)                                                                       |
| scripts/run_prompt_generator.py  | 从 catalog JSON 生成模型 prompt 契约                                                                                                |
| scripts/run_compiler.py          | 把 .a2ui DSL 文件直接编译为标准 JSON(可指定 surface id, 块内无 surface() 语句时生效)                                                |
| scripts/run_decompiler.py        | 反向: 把示例的完整消息序列(surface 创建、增量更新、删除与 renderer 函数调用)反编译为 Express DSL 打印, catalog 缺省为 basic catalog |
| scripts/recreate_dsl_examples.py | 从当前代码重新生成 express_dsl_examples.md 的示例与 prompt 契约                                                                     |

Python 实现(`a2ui/inference_formats/experimental/express/`)包含 ANTLR 生成的词法/语法/访问器(generated/), 以及 compiler、decompiler、prompt_generator、parser、format、constants、errors 模块。ExpressCompiler 接受一个或多个 catalog, `compile()` 返回按语句顺序排列的协议消息模型列表(经 `to_message_models` 校验), 每个 surface 作用域、deleteSurface、独立调用是一个编译单元。测试覆盖编译器、解析与反编译、prompt 生成、集成、CLI 工具、catalog 与更新语义、往返与版本合规(`python/a2ui_agent/tests/express/`)。

跨语言一致性由 `conformance/agent/express/` 的一组语言无关 YAML 用例固化(compiler / decompiler / prompt_generator / response_parser 四套), 关键规则包括: 变量名即组件 id; 内联组件提升到父组件之后、id 由父 id 与属性名(数组内加下标)拼成; 省略或 `_` 跳过的参数不出现在编译产物里; 无 surface() 的块编译到 default_surface; Event(name) 按 catalog 声明的动作形态编译, 第二个映射实参成为 context; `_template` 编译为 `{"componentId": ..., "path": ...}`; `?check` 隐式传入组件自身绑定值, 尾部字符串成为 message; 独立函数调用编译为 callRendererFunction, 调用 id 块内从 call_1 计数并带上 Surface 的 catalogId。TypeScript 与 Dart 实现各自跑同一组用例, Python 是唯一全绿基准。

反编译器有两个实用价值: 一是把存量标准 A2UI JSON(如 few-shot 示例、历史会话)机械转换为 Express DSL, 作为迁移或构造示例的基座(prompt 生成器的 few-shot 正是这样产出的); 二是它对细节的处理暴露了 DSL 的无损边界——非法变量名的组件 id 转写为 `id=` 参数, 与编译器默认生成值相同的 `functionCallId` 与无歧义的 `catalogId` 不写出。

## 八、小模型评测结论

下列数据来自外部评测文章, 不是仓库内产物, 本地无法复核原始样本与统计过程。评测配置为轻量模型、47 个样本, 对比"标准 A2UI"与"Express DSL"两种策略:

| 策略        | 语法准确率 | 语义准确率 | 平均延迟      | 输出 token    | 总 token        |
| ----------- | ---------- | ---------- | ------------- | ------------- | --------------- |
| 标准 A2UI   | 87.23%     | 93.62%     | 4.99s         | 35,022        | 527,882         |
| Express DSL | 91.49%     | 84.04%     | 1.09s(降 78%) | 9,912(降 72%) | 232,748(降 56%) |

指标口径: 语法准确率指生成协议的静态规则准确性; 语义准确率由另一个更高级的 LLM 对生成协议与输入需求打分, 评估满足意图的程度。

解读:

- 协议生成延迟与 token 消耗大幅下降, 达成设计目标; 总 token 降 56% 说明输入侧(紧凑 prompt 契约)也有贡献;
- 语法准确率不降反升(87.23% -> 91.49%): 简化、清晰的位置签名规则降低了弱模型的语法出错率, 属于意外收益;
- 语义准确率反而下降(93.62% -> 84.04%): 静态规则层面的语法更准了, 反映模糊意图的语义更模糊了, 这是 Express 最主要的风险;
- 与官方宣称的"输出 token 降低 55% 到 70%"同量级。

端侧运行的配套建议(技术规范给出): 按界面复杂度配置模型的 thinking budget——单视图仪表盘或基础数据表用 70 到 140 token 保证低延迟; 含嵌套布局的交互表单用 280 到 560 token 防止层级错误与绑定断裂。

需要标注的边界: 上述统计样本量不大, 且对照模型与评测口径只在该文章范围内成立; 引用时应视为方向性证据, 而不是可外推的基准。

## 九、优缺点与适用边界

优点:

- 省 token、低延迟;
- 端侧友好: 支持端侧小模型, 适合离线、隐私、边缘场景;
- 降低模型门槛: 编译器做规则检测与转换, 语法准确率提升, 降低对强模型的依赖;
- 行式语法为流式渐进渲染留出空间(参考实现的解析器目前整块缓冲, 见第二节);
- 端侧渲染器零侵入: 生成与转换封装在服务端, 保持渲染层纯净。

缺点与风险:

- 语义准确率下降, 可能不适合复杂样式生成;
- 含 root 的作用域在 v1.0 目标下编译为单 createSurface 内嵌 components/dataModel, 不产出独立 updateComponents 事件(updateComponents 需要显式 `update=true` 或无 root 的作用域), 且提案信封示例里的 surfaceParams 未获认证 schema 支持;
- 协议理解成本: 开发者在理解 A2UI 协议后, 还要掌握 Express 规则;
- 适配成本: 新增事件、属性或修改规则后可能要继续适配编译器;
- 位置即契约: catalog 属性顺序变化会直接破坏映射;
- 多 catalog 支持只有 Python 实现完整, TypeScript / Dart 落后;
- 仍是实验特性, 有可能变动。

推荐接入场景: 调用量大、对 token 成本敏感; 或倾向使用端侧/离线小模型; 生成的样式较简单、可接受一定程度的语义差异; 能够接受在服务端加一道"编译 + 校验 + 重试"能力以适配弱模型。

不推荐接入场景: 主要使用前沿大模型、对 token 消耗没有过多限制; 需要生成复杂样式、对语法与语义准确性有同等要求; 对协议做了扩展且持续演进、不希望引入额外维护成本; 需要稳定性与标准化保证。

## 十、与主线 A2UI 的关系

- 版本基线: 主线 A2UI 应用通常固定在 v0.9 族(当前生产版本 v0.9.1, 渲染端消费 createSurface / updateComponents / updateDataModel 三类消息)。Express 编译器的目标版本可以是 v1.0(缺省, 当 catalog 声明 protocolVersion 1.0 时)、v0.9 或 v0.9.1: v1.0 目标是内嵌 components/dataModel 的单 createSurface 加 `@path`/`@call` 保留键, v0.9 族目标退回三条独立消息与 `path`/`call` 键, 独立函数调用 callRendererFunction 仅 v1.0 支持。v1.0 产物的消费端: Core(web_core)已提供 v1.0 运行时(`./v1_0`、`./catalogs/basic/v1`、`./universal`、`./rpc` 子路径), Angular 渲染器自带 v1.0 basic catalog 实现, Lit 基于 universal 层可挂载 v1.0 catalog, React 渲染器仍只有 v0.8/v0.9 入口。
- 推理格式同源: Express 与 DirectJson、Elemental、Atom 是同一族"prompt 契约驱动"方案, Python SDK 的 `a2ui.inference_formats` 同时提供 direct_json(顶层)、express(顶层再导出 experimental 实现)与 experimental 下的 atom/elemental; 推理格式实现规范(inference_formats/README.md)要求所有格式从 catalog schema 动态派生签名、禁止硬编码字符串修补。有的工程实现早期只移植了"catalog -> 位置签名纯文本"一层, 当前 TypeScript 与 Dart 的 prompt 生成器也都改用反编译器生成 few-shot 示例; 两边实现是否同步需以各自代码为准。
- 生命周期错误消除: surface() 指令把 createSurface/updateComponents 的区分移到编译器的结构化推断, 模型侧不再产生生命周期失败, 对应主线降级策略里的一类失败形态。
- 更细粒度的纠错: 行级隔离加单行快模型修正加热替换, 是比"整块重试"更细的修复层, 可作为降级策略的演进方向。
- 与可编程组件的组合: 仓库的 community/macros 示例把 Express DSL 用作模型输出格式, 让 DSL 引用 `@macro` 注册的高层组件, 编译后由服务端同步展开为原语组件子树再下发标准 wire 消息, 客户端仍只见标准 catalog 组件。Express 压缩语法层 token, 可编程组件压缩组件层语义空间, 二者正交可叠加。

## 十一、总结

Express 是 A2UI 官方在"生成式 UI 成本优化、业务落地友好"方向上的一次务实探索: 它不解决"让模型生成得更对更好看", 而解决"让模型生成的成本更低"。四个设计目标中 token 足迹、端侧模型两项已由评测数据在方向上验证, 流式项目前停留在语法层属性(参考实现整块解析), 代价是语义准确率的下降与额外的编译器维护面。由于它仍处提案阶段, 合理的姿态是保持关注与小范围试点: 在调用量大、token 敏感、样式简单的场景先行, 同时保留标准 A2UI JSON 生成链路作为对照与兜底。
