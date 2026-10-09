---
title: "A2UI Express: 用紧凑 DSL 降低 A2UI 的生成成本"
description: "A2UI Express 实验性提案的语法设计、编译到 v1.0 wire protocol 的映射规则、Python 参考实现的编译链路、小模型评测结论与适用边界"
local_path: "$HOME/Downloads/a2ui"
---

A2UI Express(下称 Express)是 A2UI 官方以实验性提案形式引入的一层中间 DSL: 模型不再直接产出冗长的 A2UI JSON, 而是输出一种紧凑的行式语法, 由宿主侧编译器翻译回标准 A2UI v1.0 协议再下发给客户端。本文讲它为什么存在(原生 JSON 的生成成本问题)、语法设计如何用位置签名与去键化压低输出 token、编译到 v1.0 信封的完整映射规则、Python 参考实现里的编译与纠错链路, 以及小模型评测给出的收益与代价。适合要评估"生成式 UI 成本优化"、或在端侧小模型上落地声明式 UI 的协议与客户端工程师阅读。A2UI 协议本身见 [A2UI](a2ui)。

需要先交代定位: Express 不是新协议, 而是一种面向模型的压缩表示。它处于提案目录而非已认证规范, 编译器产物面向 v1.0 wire protocol; 本文会明确区分"提案文档描述"与"当前实现事实"。

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

官方对它的概括是: 一种紧凑、面向模型优化的声明式语法, 作为中间表示由端侧模型生成, 宿主侧编译器把它编译成标准 A2UI v1.0 载荷。

三个关键词决定了整套设计:

- 中间表示: 模型侧只学一种更小的语言, 客户端侧只认标准协议, 双方通过编译器解耦;
- 面向模型优化: 语法规则、prompt 契约、catalog 压缩都服务于"让弱模型也能稳定产出";
- 宿主侧编译: 生成与转换封装在服务端, 客户端渲染器保持纯粹。

### 1.3 隔离与门禁

官方刻意把这套东西与稳定基线隔离:

- 文档位于提案目录而非已认证的规范目录, 属于提案;
- 导入与命令行工具按文档约定由环境变量门禁(需显式开启才启用)——这是文档层约定, 当前 Python 代码侧未见强制检查;
- 实现放在 experimental 命名空间下, 不影响原有 agent 主链路。

因此它的合理姿态是关注与小范围试点, 而不是作为稳定基线依赖。

## 二、设计目标

官方给出的四个目标:

1. 降低 token 足迹。去掉结构键、括号与重复引号, 官方宣称相比原生 wire payload 输出 token 降低 55% 到 70%。
2. 端侧小模型优化。面向上下文窗口与推理预算受限的本地模型; 位置签名可以放进很短的 prompt 契约, 较少的协议闭合规则让模型在较小推理空间内完成生成。
3. 流式兼容。行式语法(每个组件一行), 编译器可逐行解析、逐步构建组件树, 模型未输出完即可渐进渲染。
4. 协议对齐。与标准 A2UI v1.0 保持完整语义兼容, 支持数据绑定、客户端校验规则与本地事件处理。

概括: 在保持协议完整性与标准化能力的前提下, 用一个中间 DSL 把"生成 UI"变得更便宜、更快、更适合端侧模型。

## 三、语法与规则

### 3.1 整体结构

所有 UI 布局包裹在 a2ui 哨兵标签内, 与对话文本分离。标签内是一条条赋值语句或独立生命周期命令; 词法上换行、分号与普通空白都被跳过 (分号概念上充当语句分隔符), 语句边界由解析器按结构切分, 因此单条赋值可跨多行、多条语句也可共用一行。`#` 与 `//` 行注释、`/* */` 块注释在词法层直接丢弃; 数组、映射与实参列表都允许尾逗号:

```text
<a2ui>
varname = ComponentName(arg1, arg2, param=value)
</a2ui>
```

### 3.2 变量与嵌套

- 保留变量 root 是界面树的唯一入口, 与标准协议的 root 组件要求一致;
- 变量名遵循 Unicode 标识符标准(UAX #31): 字母或下划线开头, 后续为字母、数字、下划线;
- 支持混合嵌套: 子组件既可以赋值给顶层变量再按名引用(header = Text("Hello") 后 root = Card(child=header)), 也可以直接内联(Card(child=Text("Hello")))。

### 3.3 参数传递(省 token 的核心机制)

组件构造器同时支持位置参数与关键字参数, 二者可混用:

- 位置参数按 catalog 中组件属性的定义顺序映射。Express 不硬编码任何组件名与属性, 属性名全部省略; 换 catalog、扩展组件都不用改编译器代码;
- 尾部可选参数可以直接省略; 中间要跳过的可选参数用下划线占位;
- 关键字参数按参数名显式传递;
- 标注为 static 的参数必须是内联字面量或数组, 不能用动态绑定。

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
- 原始串: r 前缀, 不处理转义, 反斜杠是字面量, 适合校验正则;
- 数字: 42 / 3.14 / -1; 布尔: true / false; 空值: null;
- 日期时间: 日期时间输入的值必须严格使用带时区偏移的 RFC 3339 格式(如 "2026-03-14T00:00:00Z")。

### 3.5 结构列表与映射

- 数组用方括号, 编译器映射到容器组件的子槽位;
- 映射用键值块, 键永远是字面量字符串, 不支持动态变量作键;
- 动态列表模板用编译器保留的 _template(path, templateComponent) 辅助函数(下划线开头以区别于自定义 catalog 组件):

```text
breedList = List(_template($/breeds, breedTemplate), "horizontal")
```

### 3.6 数据绑定与数据填充

- 绝对绑定: $ 前缀加 / 开头路径, 从数据模型根解析;
- 相对绑定: $ 前缀但不以 / 开头, 在列表模板迭代作用域内解析; 单独一个 $ 表示空相对路径, 解析到当前上下文根(模板内代表整个迭代项);
- 数据填充: 左值为数据路径的赋值语句直接写入数据模型, 值可以是字面量、数组或映射:

```text
$/icon = "check"
$/title = "Enable notification"
$/user = {firstName: "Alice", age: 30}
```

特殊规则: 若 DSL 块只含数据路径赋值、完全省略 root, 编译器产出独立的 updateDataModel 消息, 而不是 createSurface 布局载荷。

### 3.7 函数与事件

- 客户端函数按注册在 catalog 中的确切函数名嵌套调用, 例如 `Text(formatString("Welcome, ${/user/firstName}!"))`——好处是 catalog 换名时无需改编译器;
- 本地行为(如 openUrl)用同一套调用签名表达, 编译为标准客户端函数动作;
- 服务端事件用保留签名 `Event("name", context)`, 例如 `Event("save_deal", {rep: $/form/rep})`;
- 必填 action 规则(prompt 契约第 14 条): 名为 action 的参数严格必填, 用户请求未描述动作时必须给哑事件 Event("click"), 不允许传 null 或省略。

### 3.8 校验规则

校验用 ? 前缀表达, 编译为标准客户端校验函数:

- 简单校验: ?required;
- 带参校验: `?regex("^[0-9]{5}$", "Must be a valid zip code")`, 追加的字符串参数是失败提示文案;
- 组合: [?required, ?email]。

### 3.9 独立语句: surface / deleteSurface / 函数调用

- surface(surfaceId) 或 surface(surfaceId, catalogId): 声明后续组件定义的目标 Surface; 省略时编译器回退到默认 surface id;
- deleteSurface("id"): 独立命令, 编译为标准 deleteSurface 消息;
- 其他独立函数调用行: 编译为 callRendererFunction RPC 消息, 自动生成 functionCallId; functionCallId 与 callFunction 都包在 callRendererFunction 信封内, 且 callFunction 必须携带 catalogId:

```json
{
  "version": "v1.0",
  "callRendererFunction": {
    "functionCallId": "call_1",
    "callFunction": {
      "catalogId": "https://a2ui.org/catalog.json",
      "call": "openUrl",
      "args": { "url": "https://example.com" }
    }
  }
}
```

### 3.10 规则速查表

| 维度         | 写法                                                   | 说明                             |
| ------------ | ------------------------------------------------------ | -------------------------------- |
| 组件定义     | varname = ComponentName(arg1, ...)                     | 位置参数加可选关键字参数         |
| 字符串       | "文本" / """多行""" / r"正则\d+"                       | 标准串支持转义, 原始串不处理转义 |
| 数字/布尔/空 | 42 / true / null                                       |                                  |
| 列表         | [child1, child2]                                       | 映射到容器子槽位                 |
| 映射         | `{title: "Overview", child: contentCol}`               | 键是字面量字符串                 |
| 数据绑定     | $/user/email / $lastName                               | 绝对路径 / 模板内相对路径        |
| 数据填充     | $/title = "启用通知"                                   | 直接给数据路径赋值               |
| 动态列表模板 | List(_template($/breeds, tpl), "horizontal")           | 生成模板子列表                   |
| 服务端事件   | `Event("save_deal", {rep: $/form/rep})`                |                                  |
| 客户端函数   | openUrl("https://...")                                 | 按 catalog 签名直接调用          |
| 校验         | ?required / ?regex(pattern, msg) / [?required, ?email] | 编译为客户端校验函数             |
| 删除 surface | deleteSurface("surface-1")                             | 独立语句, 无需赋值               |
| 目标 surface | surface("surface-1")                                   | 独立语句, 声明组件归属           |

## 四、surface() 指令与生命周期抽象

标准 wire protocol 区分初始化(createSurface)与更新(updateComponents)。为避免模型跟踪 surface 生命周期状态出错, Express 把这个区分抽象为单个 surface() 指令:

- 模型侧: surface("id") 只声明目标 Surface, 之后所有组件赋值都归属该作用域; 一个 DSL 块可用连续 surface() 调用切换或创建多个 Surface;
- 编译器侧: 按会话状态决定信封——会话中不存在该 Surface 时发 createSurface, 已存在时发 updateComponents; 作用域在下一个 surface() 调用、deleteSurface 调用或 DSL 块结束时终止;
- deleteSurface 保持显式独立命令;
- 省略 surface() 时回退到默认 surface id。

设计原则五条: 模型简单性、编译器状态处理、多 Surface 支持、缺省回退、deleteSurface 显式化。它的价值在于把"缺 createSurface / 杂散 createSurface"这类生命周期失败从模型侧彻底移走——模型不再需要维护跨轮次的状态。

## 五、编译产物与 v1.0 信封

设计文档规定编译结果是单个 createSurface 消息, 内嵌 components、dataModel 与 surfaceParams 字段:

```json
{
  "version": "v1.0",
  "createSurface": {
    "surfaceId": "surface_id",
    "catalogId": "catalog_identifier",
    "components": [],
    "dataModel": {},
    "surfaceParams": {}
  }
}
```

这里有两处需要按代码事实校准:

- 已认证的 v1.0 schema 中, CreateSurfaceMessage 的 createSurface 含可选的内嵌 components 与 dataModel 属性, 这部分与提案一致; 但 schema 中不存在 surfaceParams, 且 schema 描述仍期待渲染端随后接收同 surfaceId 的 updateComponents / updateDataModel 消息来定义组件树;
- 参考实现的 compiler 实际产物同样不含 surfaceParams。

也就是说, "内嵌单 createSurface 信封"约定里 components 与 dataModel 已被认证 schema 接纳, 仅 surfaceParams 一处仍停留在提案层面; 若要把编译产物直接喂给现有 v1.0 渲染器, 需确认其对内嵌 components 的支持程度。

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

输出要点(以参考编译器实际输出为准): 邻接表扁平化后 root 引用 main_column; Column 的 align 为 "center", 被 `_` 占位的 justify 直接省略(提案 worked example 把它写作 `null`, 实际编译器会过滤掉); Icon 绑定 `{"path": "/icon"}`(编译器目前输出 v0.9 风格的 `path`, 而非 v1.0 的 `@path` 前缀指令); Button 的 action 编译为 `{"event": {"name": "accept"}}`(无 context 时省略空 context, 提案示例写作 `"context": {}`); 全部组件(含被引用的 Text)位于同一个扁平 components 数组。

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
       逐行 Lexer / 行解析 -> AST -> Schema mapper(位置参数映射)
       -> AST 扁平化 -> 标准 A2UI v1.0 JSON
  -> 以标准 v1.0 协议下发到客户端渲染
```

部署位置的选择带来职责分离: 服务端 agent 加 LLM 负责生成完整协议, 内部可实现规则检测、循环验证; 客户端渲染器保持纯粹, 只面向 A2UI 协议, 不引入其他协议规则。

### 6.2 编译器内部(五阶段)

1. Lexer 与行解析: 逐行读入, 丢弃空行, 把赋值解析为 token;
2. AST 构建;
3. Schema mapper: 在 catalog schema 中查组件名, 丢弃 component / id 结构键; 按严格定义顺序读属性; 位置参数按序映射; 尾部可选可省略; 中间跳过用下划线占位;
4. AST 扁平化: 从 root 变量遍历引用, 为每个子组件变量生成唯一稳定字符串 ID, 子数组打包成标准 ChildList, 输出单个扁平 components 数组;
5. 信封构造: 组件列表与提取的默认数据模型包装进 createSurface 信封。

参考实现另有几处确定性转换值得注意: 内联组件会被提升到父组件之后, 并分配由"父组件 id + 属性名"拼成的稳定 id (数组内再加下标), 没有父上下文时回退为 `_inline_<n>` 计数; 校验表达式识别为校验函数; 需要选项对象的属性结构会被归一化。被 `_` 跳过的组件属性在参考实现里直接省略 (编译器先把跳过位置记为 `null`, 输出前再统一过滤掉), conformance 夹具同样要求省略; 提案文档的 worked example 把跳过位写成 `null`, 但 basic catalog 的可选枚举属性不接受 `null`, 实际以编译器输出与自身 catalog 的取值约束为准。这些都是"编译器负责把 DSL 揉成合法协议"的体现。

### 6.3 prompt 契约与 catalog 压缩

喂给模型的不再是原始 JSON Schema catalog, 而是由 prompt 生成器把 catalog 编译成紧凑的位置签名文本——压缩 catalog 同时也是节省输入 token 的手段。签名生成规则: 读取 catalog JSON, 跳过 component / id 结构键, 按属性定义顺序输出"名字(参数列表)"签名, 可选参数加 ? 后缀。

实际生成的 prompt 契约包含三部分:

- 工作流描述与 15 条语法规则: 哨兵标签、root 必需、原始类型与 RFC 3339 日期、映射键字面量、$ 绑定、? 校验与错误文案、Event、数据填充、_template、deleteSurface、static 参数、必填 action 哑事件、surface 指令等;
- basic catalog 全部组件的位置签名, 每个参数带描述、枚举值与 static 标注。例如:

```text
Button(child (static), variant? (static), action (static), weight? (static), checks? (static))
  - child: The ID of the child component. Use a 'Text' component for a labeled button...
  - variant: ... Must be one of: 'default', 'primary', 'borderless'
```

- 客户端函数的位置签名(and、email、formatCurrency、formatDate、formatNumber、formatString、length、not、numeric、openUrl、or、pluralize、regex、required 等)。

### 6.4 推理与验证流程

端到端评测脚本的流程:

1. 加载标准 A2UI JSON 示例, 提取其中 updateComponents 的 components 列表作为翻译目标(评测路线是"标准 JSON -> Express -> 标准 JSON"的往返对照);
2. 用 ExpressFormat 的 prompt 生成器生成 system instruction;
3. 构造翻译任务的 user prompt: 按位置签名逐行输出变量赋值, 不输出 createSurface 信封;
4. 提交给模型(评测默认温度 0.1), 支持三种模式: 远程 Gemini API、本地 Ollama、本地 MLX-LM(Apple Silicon 端侧路线);
5. 返回的 DSL 经编译器编译回 pretty-printed 标准 v1.0 JSON, 并校验组件树父子引用与数据指针路径。

### 6.5 错误恢复与微修复循环

编译器遇到语法错误或 catalog schema 不匹配时, 触发结构化的错误恢复(比整块校验-重试更细粒度):

1. 隔离: 标记非法行, 只丢弃该行所在的 AST 子分支, 继续解析其余行, 避免整个界面崩塌;
2. agent 侧微修复: 把非法行、目标组件签名与解析器错误信息打包成一个很小的纠正 prompt;
3. 快模型修正: 在转 JSON 之前发给一个快模型; 由于 prompt 小且只针对单行, 执行很快;
4. 热替换: 修正后的语句热替换进活动 AST, 再最终化渲染输出。

这套机制的意义在于把一次错误的影响面从"整块 UI 重试"缩小到"单行修补", 对延迟敏感与调用量大的场景尤其有价值。

## 七、工具链与实现

提案目录下的命令行脚本已覆盖完整开发闭环:

| 脚本            | 用途                                                          |
| --------------- | ------------------------------------------------------------- |
| 推理脚本        | 端到端推理 + 编译 + 校验(Gemini API / Ollama / MLX-LM 三模式) |
| prompt 生成脚本 | 从 catalog JSON 生成模型 prompt 契约                          |
| 编译器脚本      | 把 .a2ui DSL 文件直接编译为标准 v1.0 JSON(可指定 surface id)  |
| 反编译脚本      | 反向: 标准 A2UI v1.0 JSON 信封转回 Express DSL                |
| 文档再生成脚本  | 从当前代码重新生成 DSL 示例与 prompt 契约文档                 |

Python 实现位于 agent SDK 的 experimental 命名空间, 包含 ANTLR 生成的词法/语法/访问器, 以及编译器、反编译器、prompt 生成器、解析器、格式化、schema 辅助与错误定义等模块; 测试覆盖编译器、解析与反编译、集成、prompt 生成与版本合规。跨语言一致性另有一组 conformance 用例, 把编译规则固化为语言无关的断言: 变量名即组件 id; 内联组件提升到父组件之后、id 由父 id 与属性名拼成; 无 surface() 的块编译到 default_surface; Event(name) 按 catalog 声明的动作形态编译, 第二个映射实参成为 context; 独立函数调用编译为 callRendererFunction, 调用 id 在块内从 call_1 起计数、并带上 Surface 的 catalogId。错误分两类: ParseError 针对格式读不动的文本, ValidationError 针对读得动但引用了 catalog 未声明内容的载荷。

反编译器有一个实用价值: 可以把存量标准 A2UI JSON(如 few-shot 示例、历史会话)机械转换为 Express DSL, 作为迁移或构造示例的基座。

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

端侧运行的配套建议: 按界面复杂度配置模型的 thinking budget——单视图仪表盘或基础数据表用 70 到 140 token 保证低延迟; 含嵌套布局的交互表单用 280 到 560 token 防止层级错误与绑定断裂。

需要标注的边界: 上述统计样本量不大, 且对照模型与评测口径只在该文章范围内成立; 引用时应视为方向性证据, 而不是可外推的基准。

## 九、优缺点与适用边界

优点:

- 省 token、低延迟;
- 端侧友好: 支持端侧小模型, 适合离线、隐私、边缘场景;
- 降低模型门槛: 编译器做规则检测与转换, 语法准确率提升, 降低对强模型的依赖;
- 流式渐进渲染: 每个组件单独一行的定义方式天然支持流式渲染;
- 端侧渲染器零侵入: 生成与转换封装在服务端, 保持渲染层纯净。

缺点与风险:

- 语义准确率下降, 可能不适合复杂样式生成;
- 编译产物为单 createSurface 内嵌 components/dataModel, 不产出独立 updateComponents 事件, 与固有使用习惯不符, 且 surfaceParams 未获认证 schema 支持;
- 协议理解成本: 开发者在理解 A2UI 协议后, 还要掌握 Express 规则;
- 适配成本: 新增事件、属性或修改规则后可能要继续适配编译器;
- 位置即契约: catalog 属性顺序变化会直接破坏映射;
- 仍是实验特性, 有可能变动。

推荐接入场景: 调用量大、对 token 成本敏感; 或倾向使用端侧/离线小模型; 生成的样式较简单、可接受一定程度的语义差异; 能够接受在服务端加一道"编译 + 校验 + 重试"能力以适配弱模型。

不推荐接入场景: 主要使用前沿大模型、对 token 消耗没有过多限制; 需要生成复杂样式、对语法与语义准确性有同等要求; 对协议做了扩展且持续演进、不希望引入额外维护成本; 需要稳定性与标准化保证。

## 十、与主线 A2UI 的关系

- 版本基线: 主线 A2UI 应用通常固定在 v0.9 族(当前生产版本 v0.9.1, 渲染端消费 createSurface / updateComponents / updateDataModel 三类消息), 而 Express 默认面向 v1.0 wire protocol, 编译产物是内嵌 components 与 dataModel 的单 createSurface。参考编译器的 version 参数也可改打 v0.9 / v0.9.1(此时退回三条独立消息, 且独立函数调用 callRendererFunction 仅 v1.0 支持); 但默认 v1.0 产物现有 v0.9 渲染链路不能直接消费: Core(web_core)已提供 v1.0 运行时与 v1.0 basic catalog 的通用 custom elements, React / Lit / Angular 渲染器的 v1.0 适配层尚未开放, 仍需切到 v1.0 渲染链路或做协议转换。
- 推理格式同源: Express 与另几种推理格式(DirectJson、Elemental、Atom)是同一族"prompt 契约驱动"方案; 有的工程实现只移植了"catalog -> 位置签名纯文本"这一层, 未移植 few-shot 反编译, 两边实现是否同步需以各自代码为准。
- 生命周期错误消除: surface() 指令把 createSurface/updateComponents 的区分移到编译器, 模型侧不再产生生命周期失败, 对应主线降级策略里的一类失败形态。
- 更细粒度的纠错: 行级隔离加单行快模型修正加热替换, 是比"整块重试"更细的修复层, 可作为降级策略的演进方向。
- 与可编程组件的组合: 有些实现把 Express DSL 用作模型输出格式, 让 DSL 引用注册的高层宏, 编译后由服务端展开为原语组件子树再下发标准 wire 消息, 客户端仍只见标准 catalog 组件。Express 压缩语法层 token, 可编程组件压缩组件层语义空间, 二者正交可叠加。

## 十一、总结

Express 是 A2UI 官方在"生成式 UI 成本优化、业务落地友好"方向上的一次务实探索: 它不解决"让模型生成得更对更好看", 而解决"让模型生成的成本更低"。四个设计目标中前三个(token 足迹、端侧模型、流式)已由评测数据在方向上验证, 代价是语义准确率的下降与额外的编译器维护面。由于它仍处提案阶段, 合理的姿态是保持关注与小范围试点: 在调用量大、token 敏感、样式简单的场景先行, 同时保留标准 A2UI JSON 生成链路作为对照与兜底。
