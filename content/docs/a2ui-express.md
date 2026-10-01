---
title: "A2UI Express DSL"
description: "A2UI Express DSL 实验性提案调研: 更低成本生成 A2UI 的 DSL 语法规则、编译到 v1.0 wire protocol、Python 参考实现与 Gemma 小模型评测"
---

本机路径: $HOME/Downloads/a2ui/specification/proposals/express (上游: github.com/a2ui-project/a2ui)
实现位置: a2ui/python/a2ui_agent/src/a2ui/inference_formats/experimental/express/
状态: 实验性提案 (proposal), 非正式规范; 编译目标为 A2UI v1.0 wire protocol
主要来源: 本地规范 a2ui_express.md / create_surface_design.md / README.md / express_dsl_examples.md / scripts, 以及 AGenUI 团队评测文章 "更低成本地生成A2UI协议: Express DSL 的功能特性"

## 1. 背景与定位

A2UI 应用到生产环境时绕不开的问题是: 如何让 LLM 高效、低成本、稳定地生成高质量协议。评估要素包括生成耗时、token 消耗、语法准确率 (静态规则) 与语义准确率 (满足意图)。这个问题直接决定了 A2UI 协议在真实业务落地中的成本和效果。

原生 A2UI JSON 冗长: 结构键 (id / component)、括号与重复引号占大量输出 token, 对端侧小模型尤其不友好。直观对比:

```
// 原始 A2UI 协议
{
  "id": "root",
  "component": "Card",
  "child": "main_column"
},
{
  "id": "main_column",
  "component": "Column",
  "children": ["header_row", "route_row"],
  "align": "stretch"
}

// Express DSL
root = Card(main_column)
main_column = Column([header_row, route_row], "stretch")
```

据 AGenUI 团队评测文章, Express DSL 于 2026 年 6 月由官方引入仓库。它的定位 (官方规范原文):

"A2UI Express is a compact, model-optimized declarative syntax... It acts as an intermediate, highly compressed representation that on-device large language models generate to describe user interfaces. A host-side compiler parses this syntax and compiles it into standard A2UI v1.0 wire protocol payloads."

即: Express 不是新协议, 而是一种 LLM 生成的、高度压缩的中间 DSL。模型输出紧凑的行式语法, host 侧编译器把它编译回标准 A2UI v1.0 JSON 再下发给客户端。

当前状态与收敛措施 (说明官方刻意把它与稳定基线隔离):

- 核心文档位于 specification/proposals/ 目录, 而非已认证的 specification/v1_0/ 目录, 属于提案而非正式规范
- Express 的代码导入与 CLI 工具按 README 约定由环境变量 A2UI_EXPRESS_ENABLED 门禁 (A2UI_EXPRESS_ENABLED=true 才启用); 注意这是文档层约定, 当前 Python 代码侧未见强制检查
- 实现放在 a2ui.inference_formats.experimental.express 命名空间, 不影响原有 agent 主链路

虽然该功能仍处演进和验证阶段, 但作为真实业务落地问题的探索型解法值得研究。

## 2. 设计目标 (四个, 来自规范)

1. 降低 token 消耗: 去掉结构键、括号与重复引号, 官方宣称相比原生 A2UI wire payload 输出 token 降低 55% 到 70%
2. 端侧小模型优化: 面向 Gemma 4 E2B / E4B 等上下文窗口与推理预算受限的本地模型; 位置签名可以放进很短的 prompt contract, 较少的协议闭合规则让模型在较小推理空间内完成生成
3. 流式兼容: 行式语法 (每个组件一行), 编译器可逐行解析、逐步构建组件树, 模型未输出完即可渐进渲染
4. 协议对齐: 与标准 A2UI v1.0 保持完整语义兼容, 支持数据绑定、客户端校验规则、本地事件处理

概括: 官方在保持 A2UI 协议完整性与标准化能力的基础上, 用一个中间 DSL 把 "生成 UI" 变得更便宜、更快、更适合端侧小模型。

## 3. 语法与规则

### 3.1 整体结构

所有 UI 布局包裹在 \<a2ui> 和 \</a2ui> 哨兵标签内, 与对话文本分离。标签内每一行是一条赋值语句或独立生命周期命令, 语句以换行分隔, 单条赋值可跨多行:

```
<a2ui>
varname = ComponentName(arg1, arg2, param=value)
</a2ui>
```

### 3.2 变量与嵌套

- 保留变量 root 是界面树的唯一入口, 与标准协议的 root 组件要求一致
- 变量名遵循 Unicode 标识符标准 UAX #31: 字母或下划线开头, 后续为字母、数字、下划线
- 支持混合嵌套: 子组件既可以赋值给顶层变量再按名引用 (header = Text("Hello") 然后 root = Card(child=header)), 也可以直接内联 (Card(child=Text("Hello")))

### 3.3 参数传递 (省 token 的核心机制)

组件构造器同时支持位置参数与关键字参数 (param=value), 二者可混用:

- 位置参数: 按 catalog 中组件属性的严格定义顺序映射。Express 不硬编码任何组件名与属性, 属性名 (key) 全部省略; 换 catalog、扩展组件都不用改编译器代码
- 尾部可选参数可以直接省略; 中间要跳过的可选参数用下划线 \_ 占位
- 关键字参数按参数名显式传递, 可与位置参数自由混合
- static 标注: 签名中标注 (static) 的参数必须是内联字面量或数组, 不能用 $/path 动态绑定

文章中的具体例子, catalog 顺序为 children, justify, align:

```
// 原始 A2UI 协议 (children + justify + align)
{
  "id": "tc_root",
  "component": "Row",
  "children": ["tc_card"],
  "align": "stretch",
  "justify": "spaceBetween"
}

// Express DSL: justify 在 align 之前, 全部给出
tc_root = Row([tc_card], "spaceBetween", "stretch")

// justify 未指定: 中间跳过用 _ 占位
tc_root = Row([tc_card], _, "stretch")
```

适配成本提醒: 位置即契约。对 catalog 扩展新属性或调整属性顺序时, 接入 Express 必须做相应适配, 否则新属性无法被正确解析。

### 3.4 原始类型

- 标准字符串: 双引号或三引号 ("""Line 1\nLine 2"""), 支持 \n \t \\ \" 转义, 允许内嵌换行
- 原始串 (raw string): r 前缀 (r"^[a-zA-Z]+$"), 不处理转义, 反斜杠是字面量, 适合校验正则
- 数字: 42 / 3.14 / -1; 布尔: true / false; 空值: null
- 日期时间: DateTimeInput 的值必须严格使用带时区偏移的 RFC 3339 格式 (如 "2026-03-14T00:00:00Z")

### 3.5 结构列表与映射

- 数组用方括号 [child1, child2], 编译器映射到容器组件的子槽位
- 映射 (map) 用键值块 \{title: "Overview", child: contentCol\}, 键永远是字面量字符串, 不支持动态变量作键
- 动态列表模板用编译器保留的 \_template(path, templateComponent) 辅助函数 (下划线开头以区别于自定义 catalog 组件):

```
breedList = List(_template($/breeds, breedTemplate), "horizontal")
```

### 3.6 数据绑定与数据填充

- 绝对绑定: $ 前缀 + / 开头路径, 如 $/user/email, 从 DataModel 根解析
- 相对绑定: $ 前缀但不以 / 开头, 如 $lastName, 在列表模板迭代作用域内解析; 单独一个 $ 表示空相对路径, 解析到当前上下文根 (模板内代表整个迭代项)
- 数据填充: 左值为数据路径的赋值语句直接写入 dataModel, 值可以是字面量、数组或映射:

```
$/icon = "check"
$/title = "Enable notification"
$/user = {firstName: "Alice", age: 30}
```

- 特殊规则: 若 DSL 块只含数据路径赋值、完全省略 root, 编译器产出独立的 updateDataModel 消息而非 createSurface 布局载荷

### 3.7 函数与事件

- 客户端函数: 按注册在 catalog 中的确切函数名嵌套调用, 如 Text(formatString("Welcome, $\{/user/firstName\}!")) —— 好处是 catalog 换名时无需改编译器
- 本地行为: openUrl("https://example.com")
- 服务端事件: 保留签名 Event("name", context), 如 Event("save_deal", \{rep: $/form/rep\})
- 必填 action 规则 (prompt contract 第 14 条): 名为 action 的参数严格必填, 用户请求未描述动作时必须给哑事件 Event("click"), 不允许传 null 或省略

### 3.8 校验规则

校验用 ? 前缀表达, 编译为标准客户端校验函数:

- 简单校验: ?required
- 带参校验: ?regex("^[0-9]\{5\}$", "Must be a valid zip code") —— 追加的字符串参数是失败提示文案
- 组合: [?required, ?email]

### 3.9 独立语句 (surface / deleteSurface / callFunction)

- surface(surfaceId) 或 surface(surfaceId, catalogId): 声明后续组件定义的目标 Surface; 省略时编译器回退到默认 "default_surface"
- deleteSurface("dashboard-surface-1"): 独立命令, 编译为标准 deleteSurface 消息
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

| 维度             | 写法                                                   | 说明                                         |
| :--------------- | :----------------------------------------------------- | :------------------------------------------- |
| 组件定义         | varname = ComponentName(arg1, ...)                     | 位置参数 + 可选关键字参数                    |
| 字符串           | "文本" / """多行""" / r"正则\d+"                       | 标准串支持转义, 原始串不处理转义, 正则很方便 |
| 数字 / 布尔 / 空 | 42 / true / null                                       |                                              |
| 列表             | [child1, child2]                                       | 映射到容器子槽位                             |
| 数据绑定         | $/user/email / $lastName                               | 绝对路径 / 模板内相对路径                    |
| 数据填充         | $/title = "启用通知"                                   | 直接给数据路径赋值, 写进 dataModel           |
| 动态列表模板     | List(\_template($/breeds, tpl), "horizontal")          | \_template 辅助函数生成模板子列表            |
| 服务端事件       | Event("save_deal", \{rep: $/form/rep\})                |                                              |
| 客户端函数       | openUrl("https://...")                                 | 直接按 catalog 签名调用                      |
| 校验             | ?required / ?regex(pattern, msg) / [?required, ?email] | 编译为客户端校验函数                         |
| 删除 surface     | deleteSurface("surface-1")                             | 独立语句, 无需赋值                           |

## 4. surface() 指令与 Surface 生命周期

标准 wire protocol 区分 createSurface (初始化) 与 updateComponents (更新)。为避免模型跟踪 surface 生命周期状态出错, Express 把这个区分抽象为单个 surface() 指令 (create_surface_design.md 子提案):

- 模型侧: surface("id") 只声明目标 Surface, 之后所有组件赋值都归属该作用域; 一个 DSL 块可用连续 surface() 调用切换/创建多个 Surface
- 编译器侧: 按会话状态决定信封 —— 会话中不存在该 Surface 时发 createSurface, 已存在时发 updateComponents; 作用域在下一个 surface() 调用、deleteSurface 调用或 DSL 块结束时终止
- deleteSurface 保持显式独立命令

设计原则五条 (子提案原文): 模型简单性、编译器状态处理、多 Surface 支持、向后兼容 (缺省 default_surface)、deleteSurface 显式化。

## 5. 编译产物与 v1.0 信封形态

设计文档规定编译结果是单个 createSurface 消息, 内嵌 components、dataModel 与 surfaceParams 字段 (下方 JSON 即提案文档 a2ui_express.md 中的信封示例)。需要注意两处与现状的出入: (1) 已认证的 v1.0 schema (specification/v1_0/json/agent_to_renderer.json) 中 CreateSurfaceMessage 的 createSurface 现已含可选内嵌 components ($ref ComponentsList) 与 dataModel 属性, 这部分与提案一致 (schema 描述仍期待渲染端随后接收同 surfaceId 的 updateComponents / updateDataModel 消息来定义组件树), 但 schema 中不存在 surfaceParams; (2) express compiler.py 的实际编译产物同样不含 surfaceParams。也就是说, "内嵌单 createSurface 信封"约定中 components / dataModel 已被认证 schema 接纳, 仅 surfaceParams 一处仍停留在 Express 提案层面:

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

编译示例一 (规范中的通知授权卡片), DSL 输入:

```
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

编译输出要点: 邻接表扁平化后 root 引用 "main\_column", Column 的 justify 为 null、align 为 "center" (\_ 占位的结果), Icon 绑定 \{path: "/icon"\}, Button 的 action 编译为 \{event: \{name: "accept", context: \{\}}\}; 全部组件 (含被引用的 Text) 位于同一个 components 扁平数组。

编译示例二 (官方 FlightStatus 飞机行程卡片, 评测文章引用):

```
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

## 6. 生成链路

### 6.1 端到端链路

```
LLM 输出 (对话文本 + <a2ui>...</a2ui> DSL 块)
  -> host (server agent) 侧编译器
       逐行 Lexer / 行解析 -> AST -> Schema mapper (位置参数映射) -> AST 扁平化 -> 标准 A2UI v1.0 JSON
  -> 以标准 v1.0 协议下发到客户端渲染
```

部署位置: 官方设计是模型直接输出 Express DSL, server agent 侧编译器转换为标准 v1.0 协议, 再下发到客户端渲染。好处是职责分离: server agent + LLM 负责生成完整协议, 内部可实现规则检测、循环验证保证准确性; 客户端渲染器保持纯粹, 只面向 A2UI 协议, 不引入其他协议规则。

### 6.2 编译器内部 (规范描述的五阶段)

1. Lexer 与行解析: 逐行读入, 丢弃空行, 把赋值解析为 token
2. AST 构建
3. Schema mapper: schema-driven key mapping —— 在 catalog schema 中查组件名, 丢弃 component / id 结构键; 按严格定义顺序读属性; 位置参数按序映射; 尾部可选可省略; 中间跳过用 \_ 占位
4. AST 扁平化: 从 root 变量遍历引用, 为每个子组件变量生成唯一稳定字符串 ID, 子数组打包成标准 ChildList, 输出单个扁平 components 数组
5. 信封构造: 组件列表与提取的默认 dataModel 包装进 createSurface 信封 (见第 5 节)

### 6.3 Prompt 契约与 catalog 压缩

喂给模型的不再是原始 JSON Schema catalog, 而是由 ExpressPromptGenerator 把 catalog 编译成紧凑的位置签名文本 (压缩 catalog 同时也是节省输入 token 的手段)。规范提供了 CatalogSignatureCompiler 参考实现: 读取 catalog JSON, 跳过 component / id 结构键, 按属性定义顺序输出 "名字(参数列表)" 签名, 可选参数加 ? 后缀。

实际生成的 prompt contract (express_dsl_examples.md, 由 recreate_dsl_examples.py 从当前代码再生成) 包含三部分:

- 工作流描述 + 15 条语法规则 (哨兵标签、root 必需、原始类型、RFC 3339 日期、map 键字面量、$ 绑定、? 校验与错误文案、Event、数据填充、\_template、deleteSurface、static 参数、必填 action 哑事件、surface 指令)
- 18 个组件的位置签名 (v1.0 basic catalog): AudioPlayer / Button / Card / CheckBox / ChoicePicker / Column / DateTimeInput / Divider / Icon / Image / List / Modal / Row / Slider / Tabs / Text / TextField / Video, 每个参数带描述、枚举值与 (static) 标注, 如:

```
Button(child (static), variant? (static), action (static), weight? (static), checks? (static))
  - child: The ID of the child component. Use a 'Text' component for a labeled button...
  - variant: ... Must be one of: 'default', 'primary', 'borderless'
```

- 14 个函数的位置签名: and / email / formatCurrency / formatDate / formatNumber / formatString / length / not / numeric / openUrl / or / pluralize / regex / required

签名生成命令 (README, 与评测文章 3.5 节一致):

```bash
cd specification/proposals/express
A2UI_EXPRESS_ENABLED=true uv run --project ../../../python/a2ui_agent \
  scripts/run_prompt_generator.py --catalog ../../../catalogs/basic/v1/catalog.json
```

### 6.4 推理与验证脚本 (run_inference.py 实际流程)

1. 加载标准 A2UI JSON 示例, 提取其中 updateComponents 的 components 列表作为翻译目标 (评测路线是 "标准 JSON -> Express -> 标准 JSON" 的往返对照)
2. 用 ExpressFormat(catalog).prompt_generator.generate(role_description, include_schema=True) 生成 system instruction (catalog 经 Catalog.from_json 加载, 脚本内 protocol_version 传 0.9.1)
3. 构造翻译任务 user prompt: "You are an advanced UI compiler agent... 按位置签名逐行输出变量赋值, 不输出 createSurface 信封"
4. 三种模式提交 (temperature 0.1):
   - Gemini API: GEMINI_API_KEY, 评测模型经参数指定 (run_inference.py 的 argparse 默认值为 gemma-4-31b-it, 并按 local/mlx 模式动态改写; gemini-3.1-flash-lite 只是 README 中的示例)
   - 本地 Ollama (is_local): http://localhost:11434/api/generate
   - 本地 MLX-LM (is_mlx): http://localhost:8080/v1/chat/completions (Apple Silicon 端侧路线)
5. 返回的 DSL 经 ExpressCompiler 编译回 pretty-printed 标准 v1.0 JSON, 并校验组件树父子引用与数据指针路径

### 6.5 错误恢复与微修复循环 (micro-refinement)

编译器遇到语法错误或 catalog schema 不匹配时, 触发结构化错误恢复 (比整块校验-重试更细粒度):

1. 隔离 (Isolation): 标记非法行, 只丢弃该行所在的 AST 子分支, 继续解析其余行, 避免整个界面崩塌
2. agent 侧微修复: 把非法行 + 目标组件签名 + 解析器错误信息打包成一个很小的纠正 prompt
3. 快模型修正: 在 Express 转 JSON 之前发给一个快模型; 由于 prompt 小且只针对单行, 执行很快
4. 热替换 (Hot swapping): 修正后的语句热替换进活动 AST, 再最终化渲染输出

## 7. 工具链与实现位置

CLI 脚本 (specification/proposals/express/scripts/, 全部需 A2UI_EXPRESS_ENABLED=true, 用 uv --project ../../../python/a2ui_agent 运行):

| 脚本                     | 用途                                                            |
| :----------------------- | :-------------------------------------------------------------- |
| run_inference.py         | 端到端推理 + 编译 + 校验 (Gemini API / Ollama / MLX-LM 三模式)  |
| run_prompt_generator.py  | 从 catalog JSON 生成模型 prompt contract                        |
| run_compiler.py          | 把 .a2ui DSL 文件直接编译为标准 v1.0 JSON (可指定 --surface-id) |
| run_decompiler.py        | 反向: 标准 A2UI v1.0 JSON 信封转回 Express DSL                  |
| recreate_dsl_examples.py | 从当前代码再生成 express_dsl_examples.md 文档                   |

Python SDK 实现: python/a2ui_agent/src/a2ui/inference_formats/experimental/express/, 含 ANTLR 生成的 express_parser / express_lexer / express_visitor (generated/ 子目录), 以及 compiler.py、decompiler.py、prompt_generator.py、parser.py、visitor.py、format.py、schema_helper.py、errors.py、constants.py。测试位于 python/a2ui_agent/tests/express/ (test_compiler、test_parser_decompile、test_integration、test_prompt_generator、test_cli_tools、test_version_compliance)。agent 侧 conformance 套件另为 Express 单列四套用例 conformance/agent/express/ (compiler.yaml 约千行, 把变量名即组件 id、内联组件提升、ParseError/ValidationError 两类错误等编译规则固化为跨语言用例; decompiler.yaml、prompt_generator.yaml、response_parser.yaml 各司反向编译、签名生成与响应块解析)。

反编译器 (JSON -> Express) 的一个实用价值: 可以把存量标准 A2UI JSON (如 few-shot 示例、历史会话) 机械转换为 Express DSL, 作为迁移或构造示例的基座。

## 8. 实测数据

官方提案评测数据 (AGenUI 评测): 轻量模型 gemini-3.1-flash-lite, 47 个样本, 对比 "标准 A2UI" 与 "Express DSL" 两种策略:

| 策略        | 语法准确率 | 语义准确率 | 平均延迟       | 输出 token     | 总 token         |
| :---------- | :--------- | :--------- | :------------- | :------------- | :--------------- |
| 标准 A2UI   | 87.23%     | 93.62%     | 4.99s          | 35,022         | 527,882          |
| Express DSL | 91.49%     | 84.04%     | 1.09s (降 78%) | 9,912 (降 72%) | 232,748 (降 56%) |

指标口径 (评测文章): 语法准确率指生成协议的静态规则准确性; 语义准确率由另一个更高级的 LLM 对生成协议与输入需求打分, 评估满足意图的程度。

解读:

- 协议生成延迟与 token 消耗大幅下降, 达成设计目标; 总 token 降 56% 说明输入侧 (紧凑 prompt contract) 也有贡献
- 语法准确率不降反升 (87.23% -> 91.49%): 简化、清晰的位置签名规则降低了弱模型的语法出错率, 属于意外收益
- 语义准确率反而下降 (93.62% -> 84.04%): 反映静态规则的语法更准了, 反映模糊意图的语义更模糊了, 这是 Express 最主要的风险
- 规范另一处宣称: 相比原生 wire payload 输出 token 降低 55% 到 70% (与上表 72% 同量级)
- AGenUI 团队实地验证过 Express 的优化效果, 与官方结论基本一致 (文章原述)

端侧运行的配套建议 (规范 "Local performance profiles"): 按界面复杂度配置模型 thinking budget —— 单视图仪表盘或基础数据表用 70 到 140 token 保证低延迟; 含嵌套布局的交互表单用 280 到 560 token 防止层级错误与绑定断裂。

## 9. 优缺点与适用场景

优点:

- 省 token、低延迟
- 端侧友好: 支持端侧小模型 (Ollama / MLX-LM 脚本路线), 适合离线、隐私、边缘场景
- 降低模型门槛: 编译器做规则检测与转换, 语法准确率提升, 降低对强模型的依赖
- 流式渐进渲染: 每个组件单独一行的定义方式天然支持流式渲染
- 端侧渲染器零侵入: 生成与转换封装在服务端, 保持渲染层纯净

缺点与风险:

- 语义准确率下降, 可能不适合复杂样式生成
- 编译产物为单 createSurface 内嵌 components/dataModel, 不产出独立 updateComponents 事件, 不太符合固有使用习惯
- 协议理解成本: 开发者在理解 A2UI 协议后, 还要掌握 Express DSL 规则
- 适配成本: 新增事件、属性或修改规则后可能要适配编译器
- 仍是实验特性 (proposal), 有可能变动

推荐接入场景: 调用量大, 对 token 成本敏感; 或倾向使用端侧 / 离线小模型; 生成的样式较为简单, 接受一定程度的语义差异; 能够接受在服务端加一道 "编译 + 校验 + 重试" 能力以适配弱模型。

不推荐接入场景: 主要使用前沿大模型, 对 token 消耗没有过多限制; 需要生成复杂样式, 对语法准确性与语义准确性有同等要求; 对协议进行了扩展且持续演进, 不希望引入额外维护成本; 需要稳定性 / 标准化保证。

## 10. 与 a2ui.md 主线 (v0.9 direct-json) 的关系

- 版本基线不同: a2ui.md 主线 (@yukino.js/a2ui-shadcn + yukino-agent) 固定 A2UI v0.9, 渲染端消费 createSurface / updateComponents / updateDataModel 三类消息; Express 面向 v1.0 wire protocol, 编译产物是内嵌 components + dataModel 的单 createSurface。现有 v0.9 渲染链路不能直接消费 Express 编译产物, 需等 v1.0 渲染器或做协议转换
- 推理格式同源: a2ui.md 记录 @yukino.js/a2ui-shadcn/prompt 移植了 Python agent SDK 的四种推理格式提示词生成器 (DirectJson / Elemental / Atom / Express), 其中的 Express 与本目录 experimental/express 是同名推理格式, 两边实现是否同步需以各自仓库代码为准
- 生命周期错误消除: Express 的 surface() 指令把 createSurface/updateComponents 的区分移到编译器按会话状态处理, 模型侧不再产生 "缺 createSurface / 杂散 createSurface" 这类生命周期失败 (对应 a2ui.md 降级策略一节的失败形态第五类)
- 更细粒度的纠错: micro-refinement (行级隔离 + 单行快模型修正 + 热替换) 是比 correctA2uiBlock 整块重试更细的 L2 修复, 可作为降级策略的演进方向
- prompt 契约同构: ExpressPromptGenerator 的 catalog -> 位置签名编译, 与 @yukino.js/a2ui-shadcn 的 "组件实现 -> zod schema -> catalog.json -> LLM prompt" 单一事实源链路是同一思想 (catalog 契约驱动 prompt), 差别只在目标语法
- 与 macros 的组合 (2026-10-01 快照新增): Python Agent SDK 新增 macros 可编程组件与类型强制引擎 (transformers/macros, @macro 装饰器 + MacroExpander, 详见 a2ui.md 的 macros 一节), 社区示例 samples/community/macros 直接把 Express DSL 用作模型输出格式——MacroAgentRuntime 组合 ExpressFormat 与 MacroExpander, 模型输出的 DSL 可引用注册的高层宏 (如 root = UserProfile("usr_101", "Alice Smith", "Lead Architect")), parser.compile 之后由 transform_to_transport 在服务端同步展开为原语组件子树再下发 v0.9.1 wire 消息, 客户端仍只见标准 basic catalog 组件。Express 压缩语法层 token, macros 压缩组件层语义空间, 二者正交可叠加

## 11. 总结

Express DSL 是 A2UI 官方在 "生成式 UI 的成本优化、业务落地友好型" 方向上的一次务实探索: 它不解决 "让模型生成得更对更好看", 而解决 "让模型生成的成本更低"。四个设计目标 (token 足迹、端侧模型、流式、协议对齐) 中前三个已由实测数据验证, 代价是语义准确率的下降与额外的编译器维护面。由于它仍处提案阶段, 合理的姿态是保持关注与小范围试点验证: 在调用量大、token 敏感、样式简单的场景先行, 同时保留标准 A2UI JSON 生成链路作为对照与兜底。

## 参考

- specification/proposals/express/README.md: 开发者指南与 CLI 用法
- specification/proposals/express/a2ui_express.md: 技术规范 (语法、编译管线、错误恢复、性能画像)
- specification/proposals/express/create_surface_design.md: surface() 指令设计子提案
- specification/proposals/express/express_dsl_examples.md: 完整 prompt contract 与编译对照示例
- specification/proposals/express/examples/: 36 个 .a2ui 示例 (flight-status、child-list-template、incremental-dashboard、advanced-form-validator 等)
- AGenUI 评测: 更低成本地生成A2UI协议: Express DSL 的功能特性
