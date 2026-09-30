---
title: "Data 工作: JSError 自动修复、视频切片聚类标签与手写 SWR"
---

## JSError 自动修复与故障现场还原

### 背景

Tiktok 搜索推荐平台是一个 React SPA, 页面报错后排查链路长: 用户反馈模糊、错误堆栈被压缩、无法复现操作路径. 该工作的目标是建立「JSError 上报 -> 现场还原 -> 大模型自动修复」的闭环:

1. 前端接入监控 SDK 上报 JSError, 携带尽可能完整的错误信息
2. 使用 rrweb 录制错误发生前的页面操作, 还原故障现场
3. 错误数据配合 sourcemap 反解后交给大模型分析, 产出修复建议

补充: 错误发生时机不可预测, 如何录制错误发生「前」的信息?

核心思路: 不是「错误发生后去补录之前」, 而是「一直在录, 但只在内存里保留最近 N 秒」. 录制是常态化的, 错误触发时直接从内存缓冲区取快照即可. 这就是滚动窗口 (rolling window / 环形缓冲) 策略, 类似行车记录仪: 一直在录, 出事时保存最近一段, 其余丢弃.

对应 yukino-sentry ScreenRecordPlugin 的三步实现:

1. 常态录制, 内存缓冲: rrweb 的 record() 启动后, 每产生一个事件 (DOM 增量、点击、滚动) 就通过 emit 回调推进一个数组. rrweb 录的是结构化增量事件而非视频, 开销很小, 所以「全程录」是可行的
2. 滚动淘汰, 只留最近 3 秒: 每次 emit 时调用 getRollingWindow(), 按 event.timestamp - screenRecordDurationMs 作为截止线, 把更早的事件从数组里丢掉. 内存占用恒定, 也不会记录用户完整操作历史 (隐私 + 体积)
3. 错误触发, 取快照上报: 上报事件命中触发类型 (Error/Xhr/Fetch/Resource/UnhandledRejection) 时置 shouldScreenRecord = true, 插件把当前窗口内的事件 JSON -> gzip -> base64 附在错误数据里. 错误发生的那一刻, 窗口里装的恰好就是「错误前 3 秒」的事件流

配套细节: rrweb 的 checkoutEveryNms 按窗口长度定期生成新的全量 DOM 快照. 回放必须从一个全量快照开始重建 DOM, 如果不做 checkout, 滚动窗口裁掉旧事件后可能把唯一的全量快照也裁掉, 窗口就无法独立回放.

方案的边界 (延伸点):

- 录制启动前的错误录不到: rrweb 是 dynamic import 异步加载的, 首屏极早期的报错可能赶不上录制. 缓解手段是尽早预加载 (idle 时 import), 或接受这部分损失, 靠面包屑和堆栈兜底
- 窗口长度是权衡: 3 秒是体积/隐私与还原能力的折中, 想还原更长链路可以调大 screenRecordDurationMs, 代价是上报体积线性增长

本质上是用「持续低成本录制 + 定长内存缓冲」把「预测错误时机」的问题转化成了「取快照」的问题.

监控与现场还原能力的实现参考自研项目 @yukino.js/sentry (github.com/hangtiancheng/yukino-sentry), 下文知识点均结合该项目的真实实现展开.

### JSError 上报应该携带哪些错误信息?

原则是「能定位、能归因、能复现」, 信息分四层组织.

第一层: 错误本身 (定位到代码行)

| 字段          | 来源                               | 作用                                  |
| ------------- | ---------------------------------- | ------------------------------------- |
| message       | ErrorEvent.message / Error.message | 错误描述, 聚合与检索的主键之一        |
| name          | ErrorEvent.filename / Error.name   | 出错脚本 URL 或错误类型名             |
| line / column | ErrorEvent.lineno / colno          | 出错行列号, 配合 sourcemap 反解到源码 |
| stack         | Error.stack                        | 完整调用栈, 反解后还原调用链          |

代码错误 (window error 事件) 直接能拿到 filename/lineno/colno; 运行时抛出的 Error 对象没有行列号, 但 stack 字符串里带帧信息, 两种都要覆盖.

补充: 为什么存在两条捕获路径?

- window error 事件 (未捕获的运行时异常): 浏览器派发 ErrorEvent, HTML 规范规定事件对象直接携带 filename/lineno/colno 三个属性 (出错脚本 URL、行号、列号), 采集时直接解构取值, 无需解析
- 运行时抛出的 Error 对象 (try-catch 捕获、Promise 拒绝的 reason、框架错误处理器的入参等): ECMAScript 规范只规定了 name 和 message, 没有 line/column 属性, 拿不到行列号; 但 stack 字符串 (非标准但 V8/SpiderMonkey/JSC 都实现) 里带帧信息, 每帧格式为 `at 函数名 (文件:行:列)`, 行列号藏在字符串里, 需要正则解析提取

两类错误在实际页面中同时存在, 采集逻辑必须是两套兜底: 有 ErrorEvent 时优先用它的 filename/lineno/colno, 只有 Error 对象时退回解析 error.stack 的帧信息, 归一化成同一套数据模型 (name/message/line/column/stack) 后, 再交给 sourcemap 反解定位到源码 (见「Sourcemap 反解与堆栈聚合策略是怎样的?」). 只写一种分支会漏掉另一类错误的行列号信息.

第二层: 事件上下文 (归因)

- url: 错误发生时的 location.href, SPA 中报错页面和当前页面可能已不同, 必须在事件产生时快照
- timestamp / time: 毫秒时间戳 + ISO 字符串, 便于和后端日志对齐
- type: 错误来源分类 (Error / Resource / unhandledrejection / React / Vue), 决定后端处理管道
- status: Error/OK 状态枚举
- 框架上下文: React ErrorBoundary 的 ErrorInfo (含 componentStack, 组件层级栈), Vue errorHandler 的 info 字符串 (如 "mounted hook") 与组件实例信息. componentStack 对 React 尤其关键, 它给出的是组件树路径而不是 JS 调用栈

补充: componentStack 是什么?

componentStack 是 React 16 引入 ErrorBoundary 时配套的能力, 全称组件栈 (Component Stack), 本质是一串描述「出错组件在组件树里的层级路径」的字符串.

从哪来: ErrorBoundary 的 componentDidCatch(error, info) 接收两个参数, 第二个参数 info 是 ErrorInfo 对象, componentStack 是它的属性:

```tsx
class MyBoundary extends React.Component {
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    reportError(error, info.componentStack);
  }
  render() {
    return this.props.children;
  }
}
```

长什么样: 比如组件树是 App -> MessagePanel -> Chat, Chat 渲染时抛错, componentStack 的格式随 React 版本和 JS 引擎变化.

React 16 (dev 模式):

```
    in Chat (at Chat.tsx:10)
    in MessagePanel (at MessagePanel.tsx:15)
    in App (at App.tsx:18)
```

React 17+ (V8 / Chrome / Node.js 环境, dev 和 prod 均为此格式):

```
    at Chat (http://localhost:3000/static/js/bundle.js:1234:5)
    at MessagePanel (http://localhost:3000/static/js/bundle.js:5678:10)
    at App (http://localhost:3000/static/js/bundle.js:9012:3)
```

React 17+ (SpiderMonkey / Firefox 环境):

```
    Chat@http://localhost:3000/static/js/bundle.js:1234:5
    MessagePanel@http://localhost:3000/static/js/bundle.js:5678:10
    App@http://localhost:3000/static/js/bundle.js:9012:3
```

每一行是组件树里的一层, 从出错组件一路向上到最近的 ErrorBoundary. React 16 附带源码文件与行号 (仅 dev 模式, 见下节). React 17 起, componentStack 的生成机制改为从原生 JS 栈帧拼接, 格式前缀随 JS 引擎变化 (V8 用 at, SpiderMonkey 无前缀), 括号内是 bundle 文件的完整 URL + 行列号, dev 和 prod 均有位置信息. dev 模式下浏览器经 sourcemap 映射后控制台可显示为 Chat.tsx:10 并可点击跳转, 但 componentStack 字符串本身的原始内容是 bundle URL 格式——监控侧解析时不能假设线上报上来的 componentStack 里直接就有源码文件名.

与 error.stack 的区别: 同一个错误, JS 调用栈是这样的:

```
TypeError: Cannot read properties of undefined (reading 'data')
    at Chat.render (Chat.tsx:10)
    at finishClassComponent (react-dom.development.js:17186)
    at performUnitOfWork (react-dom.development.js:17452)
    at workLoopSync (react-dom.development.js:17405)
```

| 维度     | error.stack (JS 调用栈)                   | componentStack (组件树路径)                         |
| -------- | ----------------------------------------- | --------------------------------------------------- |
| 描述对象 | JavaScript 函数的调用路径                 | React 组件的层级结构                                |
| 帧内容   | Chat.render 被 react-dom 内部渲染流程调用 | Chat 被 MessagePanel 渲染, MessagePanel 被 App 渲染 |
| 业务价值 | 大部分帧是 react-dom 实现细节, 噪声多     | 一眼看出业务组件层级, 直接可读                      |

对监控为什么关键:

1. 生产代码压缩混淆后, 函数名被改写, error.stack 里的业务信息基本不可读; 但 React 组件名 (类名/displayName) 可以保留, componentStack 在线上仍是业务可读的
2. 它给出了「哪个组件挂的」这个维度, 可以做按组件归因: 同一组件树的错误聚合在一起, 比按 message 聚合更准确 (呼应「Sourcemap 反解与堆栈聚合策略是怎样的?」)
3. 它和 sourcemap 反解互补: JS 栈反解定位到代码行, componentStack 定位到组件层级, 两者一起用还原度更高

注意点:

1. getDerivedStateFromError 只接收 error, 拿不到 info, 想上报 componentStack 必须走 componentDidCatch
2. 事件处理器里和异步代码 (setTimeout/Promise) 抛的错误不会触发 ErrorBoundary, 只有渲染、生命周期、构造函数阶段的错误才进得来
3. componentStack 的内容形态 (有无位置信息、格式前缀) 取决于 React 版本和构建环境, 详见下节

补充: componentStack 的生成机制——React 16 vs React 17+

componentStack 的实现经历了根本性变化, 分水岭是 React 17. 不能用一套机制解释所有版本.

React 16: 依赖构建期注入的 \_\_source

以下描述的是 React 16 的机制. React 16 的 componentStack 生成依赖一条构建期注入链路:

Babel 的 JSX 转换插件 (@babel/plugin-transform-react-jsx-source, Vite 的 @vitejs/plugin-react / CRA 默认都启用) 在编译时给每个 JSX 元素注入 `__source` 属性:

```jsx
// 编译前
<MessagePanel />;

// 编译后 (dev)
jsx(MessagePanel, {
  __source: { fileName: "MessagePanel.tsx", lineNumber: 15, columnNumber: 5 },
});
```

React 运行时在 fiber 协调阶段把 `__source` 存到 fiber 的 `_debugSource` 上, 出错时遍历 fiber 树生成 componentStack, 从每个祖先 fiber 的 `_debugSource` 读取文件名和行号拼出来.

dev 模式下该插件启用, fiber 上有 `_debugSource`, componentStack 带源码位置:

```
    in Chat (at Chat.tsx:10)
    in MessagePanel (at MessagePanel.tsx:15)
    in App (at App.tsx:18)
```

生产构建下该插件被禁用 (dev-only), JSX 编译结果里没有 `__source`, fiber 上拿不到 `_debugSource`, 生成 componentStack 时拼不出文件行号. 以下是线上真实采集到的 React 16 生产环境 componentStack:

```
    in zu
    in Fu
    in Bu
    in div
    in ut
    in Yu
    in t
    in t
```

所有组件名被 mangle 成无意义的短标识符 (zu/Fu/Bu/ut/Yu/t), 没有任何位置信息. 几个值得注意的细节:

- `div` 是原生 DOM 元素 (host component), 不走组件名 mangle, 所以保留了标签名
- 出现了两个 `in t`——两个不同的组件被 terser 压缩成了同一个单字符名, 连区分都做不到. 这是 React 16 生产环境 componentStack 完全丧失归因能力的典型表现: 不仅没有位置信息, 连组件名都不可靠
- 整份 componentStack 唯一能提供的信息是「层级深度」和「中间有一个 div」, 对定位和归因几乎没有帮助

即 React 16 的 componentStack 源码位置信息是「构建期注入、只在 dev 保留」的产物, 不是运行时自己推导的. 生产环境没有任何行列号, sourcemap 无从反解.

React 17+: 运行时从原生 JS 栈帧重建

React 17 引入了全新的 componentStack 生成机制, 不再依赖 `__source` / `_debugSource` 来获取位置信息. 核心思路: 捕获错误后, 沿 fiber 树向上, 对每个祖先组件在其 render 函数 (或 class constructor) 内部抛出一个临时 Error, 从 error.stack 里提取该组件对应的原生栈帧 (包含 bundle 文件 URL + 行列号), 再拼成 componentStack.

React 源码中的关键函数是 describeNativeComponentFrame (位于 packages/shared/ReactComponentStackFrame.js), 它负责执行这个「抛临时 Error -> 提取栈帧」的过程. 同时 React 检测当前 JS 引擎的栈帧前缀 (V8 用 at, SpiderMonkey 无前缀), 确保 componentStack 格式与原生栈帧对齐.

这个机制不区分 dev/prod, 在生产环境同样生效. 以下是线上真实采集到的 React 17+ 生产环境 componentStack (Vite 构建, V8 环境):

```
    at jd (http://localhost:4173/assets/index-W4hlOKTv.js:73:29266)
    at Dd (http://localhost:4173/assets/index-W4hlOKTv.js:73:28881)
    at Md (http://localhost:4173/assets/index-W4hlOKTv.js:73:29391)
    at div
    at qt (http://localhost:4173/assets/index-W4hlOKTv.js:10:42281)
    at Pd
    at st (http://localhost:4173/assets/index-W4hlOKTv.js:10:32267)
    at Fd (http://localhost:4173/assets/index-W4hlOKTv.js:73:30540)
    at St (http://localhost:4173/assets/index-W4hlOKTv.js:10:36625)
    at Nt (http://localhost:4173/assets/index-W4hlOKTv.js:10:38198)
```

组件名同样被压缩成了 jd/Dd/Md/qt 等无意义标识符 (terser 默认 mangle), 但位置信息是有的——每帧都带 bundle 文件 URL + 行列号. 配合 sourcemap 反解, 可以还原出原始组件的源码位置. 这正是 React 官方所说的 "fully symbolicated React component stack traces in a production environment".

与 React 16 那份对比, 几个关键差异:

- 位置信息可用: 即使组件名全是 jd/Dd/Md, 拿到 index-W4hlOKTv.js:73:29266 就能走 sourcemap 反解出原始 .tsx 文件和行号. React 16 那份完全没有这个能力
- URL 中的 content hash (W4hlOKTv) 天然就是版本标识: 监控平台可以直接用它匹配对应构建产物上传的 sourcemap, 不需要额外的版本关联逻辑
- 行号集中在 73 和 10 两行、列号很大 (29266、42281 等): 这是产物被压缩成少量长行的典型形态, 正是 sourcemap 反解的标准输入
- `at div` 没有位置信息: div 是原生 DOM 元素 (host component), 没有 render 函数可供 React 抛临时 Error 提取栈帧, 所以只输出标签名. 这和 React 16 中 div 保留标签名的原因一致
- `at Pd` 也没有位置信息: 这是一个实际边界情况. 某些组件 (如 Context Provider/Consumer、Suspense 边界、或预编译库中 React 无法重新执行 render 的组件) 在 describeNativeComponentFrame 机制下拿不到栈帧, 退化为只输出组件名. 监控侧解析时需要对「有位置」和「无位置」的帧分别处理

Breaking Change 提示: 重建组件栈涉及重新执行组件的 render 函数和 class constructor, 如果这些函数有副作用, 可能会在错误处理路径中被再次触发. 这是 React 17 的一个已知 breaking change.

对比总结:

| 维度                  | React 16                                 | React 17+                                      |
| --------------------- | ---------------------------------------- | ---------------------------------------------- |
| 位置信息来源          | 构建期 \_\_source -> fiber \_debugSource | 运行时临时 Error 的原生栈帧                    |
| dev 模式格式          | in Chat (at Chat.tsx:10)                 | at Chat (http://...bundle.js:1234:5)           |
| prod 模式格式         | in s (仅组件名, 无位置)                  | s@http://...bundle.js:1:470 (有 bundle 行列号) |
| prod 是否可用于定位   | 仅组件层级, 无定位价值                   | 配合 sourcemap 可反解到原始源码                |
| 格式前缀              | 固定 in                                  | 随 JS 引擎变化 (V8: at, SpiderMonkey: 无前缀)  |
| 对 \_debugSource 依赖 | 强依赖                                   | 不依赖                                         |

对监控侧的结论:

React 16 项目:

1. 线上报上来的 componentStack 没有行列号, 只有被压缩的组件名, 它只提供「组件层级路径」这个维度
2. 组件名在线上也可能被压缩工具改写 (terser 默认 mangle 函数/类名), 想保住可读性需要在构建时配 keep_classnames/keep_fnames 或依赖 displayName (见下节)
3. componentStack 定位为纯辅助维度 (归因、聚合), 不作为主定位依据, 主定位依据始终是 error.stack + sourcemap

React 17+ 项目:

1. 线上报上来的 componentStack 带有 bundle 文件行列号, 配合 sourcemap 反解可以直接定位到原始源码的组件位置
2. 组件名仍可能被压缩 (s、i、u), 但位置信息不依赖组件名, 两者独立
3. componentStack 从「纯辅助维度」升级为可独立参与定位的维度——即使 error.stack 的业务帧被压缩到不可读, componentStack 的 bundle 行列号 + sourcemap 仍能提供完整的组件级定位
4. 仍然建议配 displayName (见下节), 因为可读的组件名对归因聚合仍有价值, 但不再是定位的前置条件

补充: 保住组件名可读性——displayName 与 keep_classnames/keep_fnames

terser 默认 mangle 函数/类名, 线上 componentStack 里的组件名会变成 s、i、u. 保住可读性有几种方案, 适用场景不同:

keep_classnames / keep_fnames 的局限:

- keep_classnames: true 只保护 class 声明的名称, 对函数组件无效
- keep_fnames: true 保护函数声明 (function Chat() \{\}) 和具名函数表达式 (const Chat = function Chat() \{\}) 的名称, 但对箭头函数赋值 (const Chat = () => \{\}) 无效——箭头函数是匿名函数赋值给变量, 变量名 Chat 仍会被 mangle
- 现代 React 项目中函数组件大量使用箭头函数, keep_fnames 也救不了

displayName 是最实用的方案:

React 生成 componentStack 时优先读组件的 displayName 属性, 它作为普通字符串属性不会被 terser mangle, 无论组件怎么写 (箭头函数、匿名函数都行), componentStack 里都能保留可读名称:

```tsx
// 手动设置
const Chat = () => { ... };
Chat.displayName = 'Chat';

// 或用 Babel 插件自动注入 (零侵入, 编译期自动补)
// babel-plugin-add-react-displayname
```

displayName 对 React 16 的意义远大于 React 17+:

- React 16 生产环境 componentStack 只有组件名、没有行列号, sourcemap 无从反解. displayName 是唯一能让组件名可读的手段, 是刚需
- React 17+ 生产环境 componentStack 带 bundle 行列号, 即使组件名被压缩, sourcemap 也能反解出源码位置. displayName 的价值降级为: 运行时直接可读 (不用走反解流程)、聚合质量更好 (监控平台按组件名聚合时直接拿到可读名称)、sourcemap 丢失时的兜底

displayName 的额外作用域 (sourcemap 管不到的地方):

- React DevTools: 组件树面板直接显示 displayName, 没有它 HOC/memo 包裹后名称会变成 Memo 或匿名
- React Profiler: 性能分析面板按组件名聚合渲染耗时
- React 警告信息: 如 "Each child in a list should have a unique key prop" 会带上 displayName
- 监控聚合: 聚合发生在 sourcemap 反解之前, displayName 让采集阶段就能用可读名称做归因

体积代价对比:

| 方案                           | 体积代价                        | 维护代价          |
| ------------------------------ | ------------------------------- | ----------------- |
| keep_fnames: true              | 中 (保留所有函数名, 几~几十 KB) | 低                |
| keep_classnames: true          | 中 (保留所有类名)               | 低                |
| displayName 手动设置           | 极低 (几个字符串字面量)         | 中 (需逐个设置)   |
| Babel 插件自动注入 displayName | 极低                            | 零 (编译期自动补) |

建议: 如果只是为了 componentStack 的可读性, displayName 方案 (推荐 Babel 插件自动注入) 的体积代价极低 (仅注入若干字符串字面量), 比 keep_fnames/keep_classnames 更划算. keep_fnames/keep_classnames 更适合确实需要保留函数/类名用于其他用途 (如 error.name、反射场景) 的情况.

displayName 自动注入的三种工程方案:

方案一: Webpack — webpack-react-component-name

安装:

```bash
npm install webpack-react-component-name -D
# Webpack 4 项目请用 4.x 版本:
# npm install webpack-react-component-name@4 -D
```

webpack.config.js:

```js
const path = require("path");
const WebpackReactComponentNamePlugin = require("webpack-react-component-name");

module.exports = {
  mode: "production",
  entry: "./src/index.js",
  output: {
    path: path.resolve(__dirname, "dist"),
    filename: "bundle.js",
  },
  module: {
    rules: [
      {
        test: /\.(js|jsx|ts|tsx)$/,
        exclude: /node_modules/,
        use: {
          loader: "babel-loader",
          options: {
            presets: [
              "@babel/preset-env",
              "@babel/preset-react",
              "@babel/preset-typescript",
            ],
          },
        },
      },
    ],
  },
  resolve: {
    extensions: [".js", ".jsx", ".ts", ".tsx"],
  },
  plugins: [
    // 核心: 自动为所有 React 组件注入 displayName
    new WebpackReactComponentNamePlugin({
      // 是否处理 node_modules 中的组件 (默认 false)
      parseDependencies: false,
      // 包含规则 (支持 glob 字符串、RegExp、函数)
      include: ["src/**/*.{js,jsx,ts,tsx}"],
      // 排除规则
      exclude: [
        "src/**/*.test.{js,jsx,ts,tsx}",
        "src/**/*.spec.{js,jsx,ts,tsx}",
      ],
    }),
  ],
};
```

效果: 转换前源码中的箭头函数组件, 构建产物中会自动追加 displayName 赋值:

```jsx
// 转换前 (源码)
const Button = ({ children, onClick }) => {
  return <button onClick={onClick}>{children}</button>;
};
export default Button;

// 转换后 (构建产物)
const Button = ({ children, onClick }) => {
  return React.createElement("button", { onClick: onClick }, children);
};
Button.displayName = "Button";  // 插件自动注入
export default Button;
```

该插件支持 Webpack 5 (5.x 版本), Webpack 4 项目需使用 4.x 版本.

方案二: Babel 插件 — babel-plugin-add-react-displayname

安装:

```bash
npm install babel-plugin-add-react-displayname -D
```

.babelrc:

```json
{
  "presets": [
    "@babel/preset-env",
    "@babel/preset-react",
    "@babel/preset-typescript"
  ],
  "plugins": ["add-react-displayname"]
}
```

babel.config.js (如果用 config 文件而非 .babelrc):

```js
module.exports = {
  presets: [
    "@babel/preset-env",
    ["@babel/preset-react", { runtime: "automatic" }],
    "@babel/preset-typescript",
  ],
  plugins: ["add-react-displayname"],
};
```

搭配 Vite 使用 (切换为 Babel 模式):

```js
// vite.config.js
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [
    react({
      // 关键: 使用 babel 模式而非默认的 esbuild
      babel: {
        plugins: ["add-react-displayname"],
      },
    }),
  ],
});
```

效果: 函数组件和 class 组件均自动追加 displayName:

```jsx
// 转换前
const Header = () => (
  <header>
    <h1>Title</h1>
  </header>
);
class Sidebar extends React.Component {
  render() {
    return <aside>Sidebar content</aside>;
  }
}

// 转换后
const Header = () =>
  React.createElement("header", null, React.createElement("h1", null, "Title"));
Header.displayName = "Header";

class Sidebar extends React.Component {
  render() {
    return React.createElement("aside", null, "Sidebar content");
  }
}
Sidebar.displayName = "Sidebar";
```

注意: 该插件最后发布于约 2018 年, 处于不活跃维护状态. 虽然周下载量仍有百万级且无已知安全漏洞, 但可能不兼容最新的 Babel 版本, 建议在使用前做好测试.

方案三: Vite / Rollup — 自定义插件

目前没有成熟的 Vite/Rollup 专用 displayName 插件, 以下提供一个完整的自定义实现, 利用 @babel/core + @babel/traverse 做 AST 转换.

安装依赖:

```bash
npm install @babel/core @babel/parser @babel/traverse @babel/types @babel/generator @rollup/pluginutils -D
```

插件代码 vite-plugin-react-displayname.js:

```js
const { transformSync } = require("@babel/core");
const { createFilter } = require("@rollup/pluginutils");

/**
 * 支持的组件定义方式:
 * 1. 函数声明: function MyComponent() { return <div/> }
 * 2. 箭头函数赋值: const MyComponent = () => <div/>
 * 3. 函数表达式赋值: const MyComponent = function() { return <div/> }
 * 4. Class 组件: class MyComponent extends React.Component {}
 * 5. forwardRef: const MyComponent = React.forwardRef((props, ref) => <div/>)
 * 6. memo: const MyComponent = React.memo(() => <div/>)
 */
function reactDisplayNamePlugin(options = {}) {
  const {
    include = "**/*.{js,jsx,ts,tsx}",
    exclude = [
      "node_modules/**",
      "**/*.test.{js,jsx,ts,tsx}",
      "**/*.spec.{js,jsx,ts,tsx}",
    ],
  } = options;

  const filter = createFilter(include, exclude);

  return {
    name: "vite-plugin-react-displayname",
    enforce: "pre",

    transform(code, id) {
      if (!filter(id)) return null;

      // 快速预检: 文件中没有 JSX 也没有 React 相关代码就跳过
      if (
        !/\b(React|createElement|jsx|jsxs|forwardRef|memo)\b/.test(code) &&
        !/</.test(code)
      ) {
        return null;
      }

      try {
        const result = transformSync(code, {
          filename: id,
          presets: [
            ["@babel/preset-typescript", { isTSX: true, allExtensions: true }],
          ],
          parserOpts: {
            plugins: [
              "jsx",
              "typescript",
              "decorators-legacy",
              "classProperties",
            ],
          },
          plugins: [
            function injectDisplayNamePlugin() {
              return {
                visitor: {
                  FunctionDeclaration(path) {
                    const name = path.node.id?.name;
                    if (!name || !isComponentName(name)) return;
                    if (!containsJSX(path)) return;
                    injectDisplayName(path, name);
                  },

                  VariableDeclarator(path) {
                    const name = path.node.id?.name;
                    if (!name || !isComponentName(name)) return;

                    const init = path.node.init;
                    if (!init) return;

                    if (
                      init.type === "ArrowFunctionExpression" ||
                      init.type === "FunctionExpression"
                    ) {
                      if (containsJSX(path.get("init"))) {
                        injectDisplayName(path, name);
                      }
                      return;
                    }

                    if (init.type === "CallExpression") {
                      if (isReactHOC(init, ["forwardRef", "memo", "lazy"])) {
                        injectDisplayName(path, name);
                      }
                    }
                  },

                  ClassDeclaration(path) {
                    const name = path.node.id?.name;
                    if (!name || !isComponentName(name)) return;
                    if (!extendsReactComponent(path)) return;
                    injectDisplayName(path, name);
                  },

                  ExportDefaultDeclaration(path) {
                    const decl = path.node.declaration;
                    if (decl.type === "FunctionDeclaration" && decl.id) {
                      const name = decl.id.name;
                      if (
                        isComponentName(name) &&
                        containsJSX(path.get("declaration"))
                      ) {
                        injectDisplayName(path, name);
                      }
                    }
                    if (decl.type === "ClassDeclaration" && decl.id) {
                      const name = decl.id.name;
                      if (
                        isComponentName(name) &&
                        extendsReactComponent(path.get("declaration"))
                      ) {
                        injectDisplayName(path, name);
                      }
                    }
                  },
                },
              };
            },
          ],
          ast: true,
          babelrc: false,
          configFile: false,
          generatorOpts: {
            retainLines: true,
            compact: false,
          },
        });

        if (result && result.code !== code) {
          return { code: result.code, map: result.map };
        }
      } catch (e) {
        this.warn(
          `[react-displayname] Failed to transform ${id}: ${e.message}`,
        );
      }

      return null;
    },
  };
}

function isComponentName(name) {
  return /^[A-Z]/.test(name);
}

function containsJSX(path) {
  let found = false;
  path.traverse({
    JSXElement() {
      found = true;
    },
    JSXFragment() {
      found = true;
    },
    CallExpression(innerPath) {
      const callee = innerPath.node.callee;
      if (
        (callee.type === "MemberExpression" &&
          callee.object.name === "React" &&
          callee.property.name === "createElement") ||
        (callee.type === "Identifier" && callee.name === "createElement")
      ) {
        found = true;
      }
    },
  });
  return found;
}

function extendsReactComponent(path) {
  const superClass = path.node.superClass;
  if (!superClass) return false;

  if (superClass.type === "MemberExpression") {
    const obj = superClass.object?.name;
    const prop = superClass.property?.name;
    return (
      obj === "React" && (prop === "Component" || prop === "PureComponent")
    );
  }

  if (superClass.type === "Identifier") {
    return ["Component", "PureComponent"].includes(superClass.name);
  }

  return false;
}

function isReactHOC(node, hocNames) {
  const callee = node.callee;

  if (callee.type === "MemberExpression") {
    return (
      callee.object?.name === "React" &&
      hocNames.includes(callee.property?.name)
    );
  }

  if (callee.type === "Identifier") {
    return hocNames.includes(callee.name);
  }

  return false;
}

function injectDisplayName(path, name) {
  const statementPath = path.getStatementParent();
  if (!statementPath) return;

  // 检查是否已存在 displayName 赋值, 避免重复注入
  const nextSibling = statementPath.getNextSibling();
  if (
    nextSibling &&
    nextSibling.isExpressionStatement() &&
    nextSibling.node.expression?.type === "AssignmentExpression" &&
    nextSibling.node.expression.left?.object?.name === name &&
    nextSibling.node.expression.left?.property?.name === "displayName"
  ) {
    return;
  }

  const displayNameStatement = {
    type: "ExpressionStatement",
    expression: {
      type: "AssignmentExpression",
      operator: "=",
      left: {
        type: "MemberExpression",
        object: { type: "Identifier", name },
        property: { type: "Identifier", name: "displayName" },
        computed: false,
      },
      right: { type: "StringLiteral", value: name },
    },
  };

  statementPath.insertAfter(displayNameStatement);
}

module.exports = reactDisplayNamePlugin;
```

在 Vite 项目中使用:

```js
// vite.config.js
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
const reactDisplayNamePlugin = require("./vite-plugin-react-displayname");

export default defineConfig({
  plugins: [
    // 自定义插件放在 react 插件之前
    reactDisplayNamePlugin({
      include: "src/**/*.{js,jsx,ts,tsx}",
      exclude: [
        "node_modules/**",
        "src/**/*.test.{js,jsx,ts,tsx}",
        "src/**/*.spec.{js,jsx,ts,tsx}",
      ],
    }),
    react(),
  ],
});
```

在纯 Rollup 项目中使用:

```js
// rollup.config.js
const reactDisplayNamePlugin = require("./vite-plugin-react-displayname");

module.exports = {
  input: "src/index.js",
  output: { dir: "dist", format: "es" },
  plugins: [
    reactDisplayNamePlugin({
      include: "src/**/*.{js,jsx,ts,tsx}",
    }),
  ],
};
```

效果:

```tsx
// 转换前
const Card = ({ title, children }) => {
  return (
    <div className="card">
      <h2>{title}</h2>
      {children}
    </div>
  );
};
export default Card;

// 转换后
const Card = ({ title, children }) => {
  return (
    <div className="card">
      <h2>{title}</h2>
      {children}
    </div>
  );
};
Card.displayName = "Card"; // 自动注入
export default Card;
```

三种方案对比:

| 维度         | Webpack 插件          | Babel 插件                       | Vite/Rollup 自定义插件    |
| ------------ | --------------------- | -------------------------------- | ------------------------- |
| 接入成本     | 极低 (一行配置)       | 极低 (一行配置)                  | 中等 (需添加插件文件)     |
| 维护状态     | 活跃 (支持 Webpack 5) | 已停更 (约 8 年未更新)           | 自主可控                  |
| 兼容性风险   | 低                    | 中 (可能不兼容新版 Babel)        | 低 (依赖稳定)             |
| 可定制性     | 中 (include/exclude)  | 低                               | 高 (完全自主)             |
| 适用构建工具 | 仅 Webpack            | Webpack + Vite (需切 Babel 模式) | Vite / Rollup             |
| 性能影响     | 小                    | 小                               | 小 (可加预检跳过无关文件) |

选型建议:

- Webpack 项目: 方案一, 开箱即用
- Vite 项目且已用 Babel 模式: 方案二, 最省事
- Vite 项目用 esbuild/SWC: 方案三, 不牺牲构建速度 (esbuild 处理 JSX, 自定义插件仅做轻量 AST 追加)

补充: React 17+ componentStack 的 sourcemap 反解

React 17+ 生产环境的 componentStack 带 bundle 行列号, 可以走 sourcemap 反解. 落地流程:

1. 构建时: 生成 sourcemap (webpack 配 devtool: 'hidden-source-map', Vite 配 build.sourcemap: true), 上传至监控平台 (Sentry、ARMS 等), 不要部署到公网
2. 运行时: SDK 采集到含 bundle URL + 行列号的 componentStack
3. 服务端: 监控平台按 URL 匹配对应版本的 sourcemap, 逐帧将 bundle 行列号反解为原始文件路径和行号

sourcemap 的还原能力边界:

- 能将 bundle 的行列号还原为原始 .tsx 文件路径和行号
- 若 map 包含 sourcesContent, 可还原出错行附近的原始源码
- 无法可靠还原被 terser mangle 掉的组件名 (sourcemap 的 names 字段是位置相关的符号映射, 不等同于组件的语义名称)

因此 React 17+ 的 componentStack 经 sourcemap 反解后, 文件路径 + 行号是主定位依据, 组件名 (如 s) 仅作辅助. 这正是 displayName 仍有价值的原因: 它提供的是不依赖反解流程的运行时可读名称.

高频踩坑点:

- sourcemap 版本必须严格对应: 源码小改动会导致偏移量剧变, 用错版本还原结果全错
- CDN 跨域拦截: 若 SDK 在浏览器端拉取 sourcemap, CDN 需配 Access-Control-Allow-Origin
- sourceRoot 干扰: sourcemap 中 sourceRoot 指向本地开发路径会导致解析器找不到原始文件, 构建时应置空
- 多工具链断链: TS -> Babel -> Terser 多层转换时, 需确保每层正确传递 inputSourceMap, 否则映射链断裂

补充: componentStack 与 CodeGraph 的配合 (运行时组件栈 + 静态代码图)

本节分析 componentStack 与本地代码知识图谱 CodeGraph (见 docs/docs/codegraph) 的互补关系. 结论: 两者结构性互补, 不是简单的「能接上」.

1. 信息形态同构: 组件栈字符串本身就是图上的一条路径

componentStack 的本质是「出错组件一路向上到 ErrorBoundary 的组件名序列」. CodeGraph 恰好把组件建模为一等节点 (NodeKind 含 component 节点), 且 callback-synthesizer 专门生成 JSX 子组件边 (见 docs/docs/codegraph). 因此 componentStack 里的每一行都能映射成图上一个节点和一条父链边——两者是同一结构信息的两种表示: 一个是运行时 React 打印的文本, 一个是静态图里可查询的路径. agent 拿到 componentStack, 等于拿到一条现成的图遍历起点序列, 不需要再 grep 找入口.

2. 查询入口互补: 覆盖 CodeGraph 的多种命中方式

componentStack 在不同 React 版本和构建模式下有不同的信息形态, CodeGraph 恰好支持多种入口:

| componentStack 形态                                | CodeGraph 查询入口                                    | 命中方式         |
| -------------------------------------------------- | ----------------------------------------------------- | ---------------- |
| React 16 dev, 带 (at File.tsx:15)                  | codegraph_node 带 file + line 参数                    | 行号命中包围符号 |
| React 17+ dev/prod, 带 bundle URL + 行列号         | 先 sourcemap 反解得原始 file + line -> codegraph_node | 行号命中包围符号 |
| 任何版本, 只有组件名 (prod 被压缩或 React 16 prod) | codegraph_node 按符号名查询 (歧义名返回全部重载)      | 名字命中符号     |

各种形态都有对应入口, 恰好补上了「生产没有可读组件名」的短板: 名字本身就是符号, bundle 行列号经 sourcemap 反解后也能落到源码位置.

3. 归因维度互补: 扁平组件列表 → 结构化子树聚合

componentStack 的价值之一是按组件归因; 有了 CodeGraph, 归因可从扁平列表升级为结构化分析: 多个错误上报的 componentStack 都经过 UserList 这一层时, 可沿 JSX 子组件边确认它们属于同一个子树, 而不是只看名字是否相同.

4. 边界互补: ErrorBoundary 捕不到的错误反而靠 CodeGraph

事件处理器、异步代码 (setTimeout/Promise) 抛的错误不会触发 ErrorBoundary, 没有 componentStack (见前文注意点). 而 CodeGraph 的 callback-synthesizer 恰好覆盖 React 的 setState→render、JSX 子组件、事件绑定等动态分发边——没有 componentStack 的错误, 还能沿事件绑定边把错误关联回触发它的组件. 两边各自强调的「事件/异步链路盲区」, 拼起来反而闭环.

5. 修复闭环: 出错组件名作为探索入口

componentStack 顶行的出错组件名, 可替代「栈帧→符号」的第一步: codegraph_node(出错组件) 拿源码 → explore 摸数据链路 → impact 评估波及 → affected 选测试. 入口从行列号换成组件名, 后续链路复用 codegraph.md 第七章的自动修复流程.

6. 前置条件与边界

- 组件名保留: 按组件名查询依赖组件名在生产不被压缩改写, 需要构建时配 keep_classnames/keep_fnames 或依赖 displayName 兜底; 名字被 mangle 后按名查询即断. 但对于 React 17+ 项目, 即使组件名被压缩, bundle 行列号 + sourcemap 反解仍然可以走通行号命中路径, 因此 keep_classnames 不再是唯一的入口保障
- componentStack 覆盖范围: 只覆盖渲染/生命周期/构造函数阶段的错误, 事件与异步错误要退回 error.stack + sourcemap 或 CodeGraph 动态分发边
- React 版本感知: 监控 SDK 在解析 componentStack 时需要识别 React 版本——React 16 的 in 前缀格式和 React 17+ 的 at/@ 前缀格式的解析逻辑不同; React 17+ 的 bundle 行列号需要额外的 sourcemap 反解步骤才能映射到原始源码位置

第三层: 用户与设备维度 (缩小排查范围)

- deviceId: localStorage 持久化的设备 ID, 跨会话聚合同一设备的错误
- sessionId: sessionStorage 的会话 ID, 串联一次会话内的行为
- userId / projectId / sdkVersion: 归属与版本维度
- deviceInfo: 浏览器名与版本、操作系统与版本、UA、设备型号、语言、屏幕分辨率. 用于判断「是否只在 Chrome 120 / iOS 上出现」这类环境相关问题

第四层: 行为与现场 (复现)

- 面包屑 (breadcrumbs): 错误前的用户行为序列, 按类型分为路由切换、HTTP 请求、点击、资源加载、代码错误等, 回答「报错前用户做了什么」
- 录屏事件 (rrweb): 错误前 N 秒的 DOM 变更与交互事件流, 可直接回放, 见「rrweb 是什么? 有什么作用?」
- 关联 HTTP 数据: 错误前失败的接口请求 (状态码、耗时、请求响应体摘要), 很多前端报错的根因是接口异常

yukino-sentry 中的实际组装过程:

```typescript
// 采集时: getBaseData() 附带 id/deviceId/sessionId/timestamp
// 错误处理: handleCodeError 提取 filename/message/line/column
const { filename, colno: column, lineno: line, message } = err;
const codeError = {
  ...getBaseData(),
  type: EventType.Error,
  name: filename,
  message,
  line,
  column,
};

// 入队时: payloadToReportData 包上外层检索维度
return {
  type,
  name,
  message,
  status,
  id,
  url: location.href,
  userId,
  projectId,
  sdkVersion,
  deviceInfo, // UA 解析 + 屏幕分辨率 + Canvas 指纹
  payload, // 原始采集数据整体保留
};
```

此外还有两个工程化细节:

1. 错误去重: 用 base64 编码的 `type-message-filename-line-column` 作为错误签名, 放入容量 1000 的 LRU Set, 相同错误只上报一次, 防止循环报错打爆上报通道
2. 批量聚合: 每条错误入队都会重置 2000ms 的防抖窗口, 窗口内无新错误后批量 flush; 按 type-name-message 分组的同一错误达到 5 次及以上时, 折叠为一条带 batchErrorLength 和最后发生时间的聚合记录

### rrweb 是什么? 有什么作用?

rrweb (record and replay the web) 是一个录制/回放用户浏览器操作的开源库, 由 record、replay、snapshot 三部分组成.

工作原理:

1. 录制时不录视频, 而是录「DOM 与事件的增量描述」:
   - 首帧做全量 DOM 快照: 深度遍历 DOM 树, 把每个节点序列化为自定义的序列化节点 (含标签、属性、文本、样式), 生成一份可脱离原页面重建页面的数据
   - 后续帧只录增量: 基于 MutationObserver 捕获 DOM 增删改, 基于事件监听捕获鼠标移动、点击、滚动、输入、视口尺寸变化等, 每条事件带时间戳
2. 回放时在一个沙箱 iframe 中按时间戳重放: 先用全量快照重建 DOM, 再按时间轴应用增量变更和交互事件, 还原出与真实页面一致的动态过程

相比录屏视频的优势:

- 体积: 文本化的增量事件远小于视频流, 压缩后通常只有几十 KB
- 清晰: 回放是矢量渲染, 任意分辨率下文字都清晰, 视频会糊
- 可检索: 事件是结构化数据, 可以统计点击次数、输入内容 (脱敏后)、滚动深度
- 隐私可控: 可以在录制侧配置 mask 规则, 对 input 内容、密码框做脱敏

在 JSError 现场还原中的作用:

yukino-sentry 的 ScreenRecordPlugin 采用「滚动窗口 + 事件触发」策略, 而不是全程上传:

```typescript
// 1. 动态加载 rrweb 与 pako, 启动录制
const [{ record }, pako] = await Promise.all([
  import("@rrweb/record"),
  import("pako"),
]);

// 2. 滚动窗口: 每次 emit 只保留最近 screenRecordDurationMs (默认 3s) 内的事件
recordWindow = getRollingWindow([...recordWindow, event], event.timestamp);

// 3. 触发: 上报的事件类型命中 screenRecordEventTypes
//    (默认 Error/Xhr/Fetch/Resource/UnhandledRejection) 时置 shouldScreenRecord = true
// 4. 打包: 窗口内事件 JSON -> pako.gzip -> base64, 作为 ScreenRecord 事件上报
// 5. checkoutEveryNms 按窗口长度做 checkout, 保证全量快照定期刷新, 窗口可独立回放
```

回放侧用 `unzipScreenRecord()` 逆过程还原: base64 -> Uint8Array -> pako.ungzip -> JSON.parse -> rrweb events, 交给 rrweb 的 Replayer 在监控平台里回放.

设计考量:

1. 只录错误前 3 秒: 兼顾现场还原与隐私、带宽, 不记录用户完整操作历史
2. gzip 压缩: rrweb 事件是高度冗余的 JSON, gzip 后约为原始体积的 10-20%
3. 按需附带: 只有命中触发类型的事件才附带录屏, 常规 PV/点击事件不携带
4. checkout 机制: rrweb 的 checkoutEveryNms 定期生成新的全量快照, 保证任意滚动窗口都能独立回放, 不依赖更早的事件

### react-router 改造为文件路由, 怎么做?

背景是配置式路由在页面多了以后维护成本高: 路由表与页面文件两处维护、新增页面要手动注册、容易漏配懒加载. 改造目标是约定式 (文件) 路由: 目录结构即路由结构.

yukino-sentry 的 client demo 给出了完整实现, 核心是自研构建插件 vite-plugin-page-routes (另有 webpack 版本).

约定:

```
src/pages/
├── page.tsx                 -> /
├── behavior/page.tsx        -> /behavior
├── errors/page.tsx          -> /errors
├── network/page.tsx         -> /network
└── performance/page.tsx     -> /performance
```

实现方案选择: 代码生成 (build-time codegen), 而不是运行时扫描文件系统. 构建期插件扫描目录, 生成一个静态的 routes.tsx, 交给 react-router 消费:

```typescript
// vite 插件核心钩子
export default function pageRoutes(): Plugin {
  return {
    name: "vite-plugin-page-routes",
    configResolved(config) {
      root = config.root;
    },
    // 构建/启动时扫描生成
    buildStart() {
      generateRoutes(
        join(root, "src/pages"),
        join(root, "src/generated/routes.tsx"),
      );
    },
    // dev 时监听 pages 目录, 文件增删自动重新生成
    configureServer(server) {
      server.watcher.add(pagesDir);
      server.watcher.on("all", (event, filePath) => {
        if (!filePath.startsWith(pagesDir)) return;
        if (event === "add" || event === "unlink")
          generateRoutes(pagesDir, outputFile);
      });
    },
  };
}
```

生成逻辑的三个关键函数:

```javascript
// 1. 递归扫描所有 page.tsx
// 2. 目录相对路径 -> 路由路径: pages/behavior/page.tsx -> /behavior
// 3. 路由路径 -> PascalCase 组件名: /behavior -> Behavior, / -> Home
// 4. 每个页面生成 React.lazy 动态导入
```

生成产物:

```tsx
// Auto-generated by page-routes plugin — DO NOT EDIT!!!
const Behavior = lazy(() => import("../pages/behavior/page"));
const Errors = lazy(() => import("../pages/errors/page"));
const Network = lazy(() => import("../pages/network/page"));
const Home = lazy(() => import("../pages/page"));
const Performance = lazy(() => import("../pages/performance/page"));

export const routes: RouteObject[] = [
  { path: "/behavior", element: <Behavior /> },
  { path: "/errors", element: <Errors /> },
  { path: "/network", element: <Network /> },
  { path: "/", element: <Home /> },
  { path: "/performance", element: <Performance /> },
];
```

工程细节:

1. lazy 默认路由级分包: 每个页面独立 chunk, 首屏只加载当前路由代码
2. 写入幂等: 生成内容与现有文件一致时跳过 writeFileSync, 避免无意义的 HMR 抖动
3. 双构建复用: 扫描与生成逻辑抽成纯 Node 模块 page-routes.js, vite 插件和 webpack 插件共享
4. 生成文件纳入 gitignore 或标注 DO NOT EDIT, 避免人工修改被覆盖

为什么不用运行时方案 (如 import.meta.glob 动态构建路由表): 代码生成的产物是纯静态 import, 打包工具的 tree-shaking、chunk 命名、依赖分析都最完整; 运行时方案需要额外的路由表构建代码且类型推导更弱.

### 跨域脚本错误只有 Script error, 如何解决?

问题成因:

浏览器同源策略对 window error 事件做了保护: 当出错的脚本来自跨域 (如 CDN), 且该脚本请求未通过 CORS 校验时, error 事件的 message 只有 "Script error.", filename/lineno/colno 全部为空, 防止跨域脚本的内部信息泄露给页面.

解决的核心是让「脚本加载」和「错误上报」都通过 CORS 校验, 需要两步同时满足:

1. script 标签加 crossorigin 属性:

```html
<!-- anonymous: 不需要凭证; 若 CDN 需要 cookie 则用 use-credentials -->
<!-- integrity: SRI 子资源完整性校验, 防止 CDN 被篡改后在原站执行恶意代码 -->
<script
  src="https://cdn.example.com/app.js"
  crossorigin="anonymous"
  integrity="sha384-xxxx"
></script>
```

2. CDN 响应头返回 Access-Control-Allow-Origin:

```
Access-Control-Allow-Origin: *
# 或精确回源站域名
Access-Control-Allow-Origin: https://www.example.com
```

两者缺一不可: 只加 crossorigin 而 CDN 没有 CORS 头, 脚本会直接加载失败 (比 Script error 更糟); 只配 CDN 头不加 crossorigin, 错误信息依然是模糊的.

配套的工程手段:

1. SDK 侧过滤: 对确实无法修复的跨域错误 (如第三方广告脚本) 配置忽略规则, 避免污染错误数据:

```typescript
init({ dsn: "/api/log", ignoreErrors: ["Script error."] });
```

2. 区分处理未知来源错误: yukino-sentry 中 filename 为空或 unknown 的错误会跳过去重逻辑始终上报 (hasUnknownSource 分支), 因为这类错误没有可靠的签名, 去重键会误合并不同的错误

3. 兜底定位手段 (CDN 不可控时的替代方案):
   - try-catch 包裹关键调用, 主动上报带堆栈的错误, 不依赖 window error
   - 给关键异步边界加 unhandledrejection 捕获, Promise 链中的错误不受 Script error 限制, 能拿到完整堆栈
   - sourcemap 反解: 即使只有模糊的行号, 只要脚本是自己的 (只是走了 CDN), 配好 CORS 后结合 hidden sourcemap 仍可反解到源码
   - 自建 CDN 域名与页面同域, 从根上消除跨域. 注意: 「子域 + document.domain」的旧做法已过时——Chrome 109 起默认禁用 document.domain setter (仅当页面显式返回 Origin-Agent-Cluster: ?0 响应头主动退出 origin-keyed agent cluster 时才可恢复), 不建议再依赖; 优先选择同域部署, 或保留跨域但配齐 CORS

4. 资源加载错误不受此限制: img/script/link 加载失败走 capture 阶段的 error 事件, 能拿到 target.src/href, 可以直接定位是哪个资源挂了

### rrweb 引入导致包体积膨胀, 如何解决?

rrweb 全量引入约 100KB+ (gzip 后), 对一个目标体积只有几 KB 的监控 SDK 来说不可接受. 解决思路按优先级:

1. 插件化解耦 (架构层)

把录屏做成独立插件而非核心能力:

- 独立的子路径入口: `@yukino.js/sentry/plugins`, 核心包 `@yukino.js/sentry` 完全不 import rrweb, 不启用录屏的项目打包产物里根本没有 rrweb
- 插件通过事件总线与核心通信 (shouldScreenRecord 标记), 核心不感知录屏实现
- package.json exports 多入口 + ESM 输出, 保证 tree-shaking 生效

2. 动态导入分级加载 (加载时机层)

yukino-sentry 的 recorder 使用运行时 dynamic import:

```typescript
const [{ record }, pako] = await Promise.all([
  import("@rrweb/record"), // 独立 chunk, 不进首屏 bundle
  import("pako"),
]);
```

效果: rrweb 和 pako 各自成为独立 chunk, 首屏 JS 不包含任何录屏代码, 插件 init 时才异步拉取. 加载失败 (如弱网) 走 catch 降级为 noop, 不影响其他监控能力.

可以进一步做分级加载策略:

- 首屏不加载: 等页面 idle (requestIdleCallback) 或首屏指标 (LCP) 上报完成后再 import, 避免和业务代码抢带宽与主线程
- 按采样加载: 只对命中采样比例的用户加载录屏 chunk, 例如 10% 的用户开启录屏能力
- 按环境加载: 内部员工/灰度用户全量开启, 线上大盘只保留错误上报

3. 压缩与传输优化 (数据层)

- 滚动窗口: 只保留最近 3 秒事件, 而不是全程录制, 从源头控制数据量
- gzip + base64: pako.gzip 压缩后体积约为原始 JSON 的 10-20%
- 触发式上报: 只有错误类事件才附带录屏, 正常浏览不产生录屏流量

4. 依赖本身的裁剪

- rrweb 提供配置项关闭不需要的采集 (如不录 canvas 时去掉 recordCanvas 相关逻辑)
- 打包工具侧确认 rrweb 内部未被引用的模块被 tree-shake; 必要时用 alias 替换其依赖的较大子包

5. 体积防线

- CI 中对各入口产物做 size limit 检查 (如 size-limit / bundlesize), 核心包超过预算即失败, 防止有人不小心把 rrweb 静态 import 回核心
- 构建报告 (rollup-plugin-visualizer 等) 定期确认 chunk 划分符合预期: 核心、plugins、rrweb、pako 各自独立

总结: 插件化保证「不用就不打包」, 动态导入保证「用了也不进首屏」, 滚动窗口与压缩保证「产生了也不大」, 三层叠加后录屏能力对首屏体积的影响为零.

### monaco editor 发版后资源加载错误, 如何分析与解决?

真实业务场景: Tiktok 搜索推荐平台内有大量基于 monaco editor 的 web 编辑器页面 (规则配置、DSL 编辑等). monaco 的运行时资源分两部分: 编辑器本体 (editor.main, 提供 UI 与编辑能力) 和各语言的 web worker (editor.worker 基础 worker、ts.worker/json.worker/css.worker 等语言服务 worker, 承载语法高亮、代码补全、类型检查). 这些脚本平时命中浏览器缓存, 体验无感; 但前端发版后集中出现资源加载错误, 且问题集中在一种路径上: 用户不是从 / 根路径跳转进来, 而是直接访问 /path/to/web/editor 直连进入编辑器页面, 此时语法高亮等 worker 脚本尚未就绪, monaco 抛出资源加载错误.

这类错误的本质是「懒加载资源在需要的那一刻还没下载完」: 文件都存在 (版本一致), 但 monaco 的 worker 是按需创建的独立请求, 直连进入编辑器页面时脚本还没下载完就被 monaco 调用, 抛出 worker 不可用错误. 发版后缓存失效需要重新请求, 把这个竞态暴露得更明显.

#### 为什么直连进入会触发竞态型错误

1. monaco 的语言能力由 web worker 异步承载: 语法高亮、代码补全运行在 worker 里, 通过 MonacoEnvironment.getWorkerUrl 或打包工具的 worker 插件按需创建. 这些脚本只在编辑器组件挂载、worker 被创建时才发起请求, 属于典型的懒加载资源
2. SPA 入口 HTML 不预置所有路由的脚本: 入口 HTML 只加载首屏必需的 chunk, 编辑器页面代码与 monaco 依赖靠路由级 lazy (动态 import) 在访问时才拉取
3. 从 / 跳转与直连 /path/to/web/editor 的差异, 本质是资源下载有没有"时间余量":
   - 从 / 跳转: SPA 内部导航, 不重新请求 HTML, 只触发编辑器 chunk 与 monaco 依赖的动态 import. 这些下载与页面渲染并行, 且用户在前序页面停留期间浏览器有较多空闲带宽, 下载大概率先于用户操作完成, 竞态被掩盖
   - 直连 /path/to/web/editor: HTML 返回后立刻渲染编辑器路由, 入口 chunk、编辑器 chunk、monaco 本体、worker 脚本全部要现下载. 弱网或 CDN 抖动时, 编辑器组件已挂载并调用 monaco, 而 worker 脚本还没下载完, monaco 拿不到 worker 就抛错

注意: 从 / 跳转能掩盖竞态, 并不是因为浏览器"预取"了编辑器 chunk (SPA 默认不会预取其他路由, 除非主动配 link rel=prefetch 或框架级 prefetch); 真正原因是内部导航不重载 HTML, 资源下载有前序停留时间做缓冲. 直连路径把这个时间余量压缩到零, 竞态就暴露了.

#### 如何解决

1. monaco worker 的正确加载方式 (针对 worker 的脆弱性)
   - 当时业务的做法: webpack 构建主体产物, monaco worker 脚本不参与打包, 而是通过 MonacoEnvironment.getWorkerUrl 直接拼 CDN URL 从 CDN 拉取:

```typescript
// 版本号硬编码在 URL 路径里, worker 文件名是 monaco 官方的固定文件名
const MONACO_CDN = "https://cdn.example.com/monaco/0.34.0/min/vs";

self.MonacoEnvironment = {
  getWorkerUrl(_, label) {
    if (label === "json") return `${MONACO_CDN}/language/json/json.worker.js`;
    if (label === "typescript" || label === "javascript")
      return `${MONACO_CDN}/language/typescript/ts.worker.js`;
    return `${MONACO_CDN}/editor/editor.worker.js`;
  },
};
```

这种方式的特点: worker 文件名是 monaco 官方的固定文件名 (editor.worker.js 等), 不带 content hash, 版本管理完全靠 URL 里的版本号路径 (0.34.0). 问题在于: worker 是按需创建的懒加载请求, 直连进入时脚本还没下载完就被 monaco 调用

- worker 创建加容错: getWorkerUrl 加载失败时降级, monaco 会回退到主线程提供基础编辑能力, 编辑器不至于整体崩溃. 但回退能力有限——基础编辑、简单高亮可保留, TypeScript 的语义检查、跨文件类型推导等强依赖 worker 的能力会降级或缺失, 容错是保住编辑器不整体崩溃, 不是等价替代

2. 错误兜底与重试 (治标, 与「JSError 上报应该携带哪些错误信息?」「跨域脚本错误只有 Script error, 如何解决?」的监控链路衔接)
   - 资源错误捕获: script/link 加载失败不冒泡到 window error, 需在 capture 阶段监听 error 事件 (yukino-sentry 的核心错误监听即这样做: decorates.ts 里 globalThis.addEventListener("error", listener, true) 注册捕获阶段监听, 错误进入 handleError 后由 reportResourceError 从 target 上取 src/href 归为 Resource 类型事件). 资源错误与 JS 运行时错误的捕获机制不同: 运行时错误触发 window.onerror 并携带 message/stack; 资源错误只触发目标元素的 error 事件, 且被标记为不冒泡, 只能在捕获阶段拦住:

```typescript
window.addEventListener(
  "error",
  (event) => {
    const target = event.target as HTMLElement;
    // 只处理资源加载错误 (script/link/img), 跳过运行时错误
    if (
      target instanceof HTMLScriptElement ||
      target instanceof HTMLLinkElement
    ) {
      const src =
        (target as HTMLScriptElement).src || (target as HTMLLinkElement).href;
      reportResourceError({ src, tagName: target.tagName });
    }
  },
  true, // 必须 capture 阶段, bubbling 阶段收不到
);
```

这样拿到失败的 src 就能精确定位是哪个 worker 脚本挂了 (是 editor.worker.js 还是 ts.worker.js), 而不是只看到一个模糊的“monaco 初始化失败”

- 路由级 ErrorBoundary: React.lazy 的动态 import reject 时会被 ErrorBoundary 捕获, 但关键是要区分两种失败——chunk 加载失败 (网络/缓存问题, 重试有意义) 和业务代码运行时错误 (重试无意义, 代码本身有 bug). 判断方式是检查 error.message 是否包含加载失败特征:

```typescript
const CHUNK_LOAD_ERRORS = [
  "Loading chunk", // webpack 动态 import 失败
  "Failed to fetch dynamically imported module", // 浏览器原生 ESM
  "Importing a module script failed",
];

function isChunkLoadError(error: Error): boolean {
  return CHUNK_LOAD_ERRORS.some((kw) => error.message.includes(kw));
}

class EditorErrorBoundary extends React.Component {
  state = { hasError: false, isChunkError: false };

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, isChunkError: isChunkLoadError(error) };
  }

  handleRetry = () => {
    // 重试时给页面 URL (location.pathname) 附加时间戳并整页刷新,
    // 以全新导航地址重新加载页面; 时间戳只作用于页面地址,
    // 不改变 chunk URL, 因此绕不过也不影响 chunk 自身的 HTTP 缓存
    window.location.href = `${window.location.pathname}?t=${Date.now()}`;
  };

  render() {
    if (this.state.hasError) {
      return this.state.isChunkError
        ? <RetryPrompt onRetry={this.handleRetry} />
        : <GenericError />;
    }
    return this.props.children;
  }
}
```

- 动态 import 重试: 在 ErrorBoundary 整页重试之前, 先在 import 层面做有限次自动重试, 消化偶发的网络抖动, 避免用户感知到错误页:

```typescript
function retryImport<T>(
  importer: () => Promise<T>,
  retries = 3,
  delay = 1000,
): Promise<T> {
  return importer().catch((error) => {
    if (retries <= 0 || !isChunkLoadError(error)) throw error;
    // 指数退避: 避免短时间密集重试加重 CDN 负担
    return new Promise((resolve) =>
      setTimeout(
        () => resolve(retryImport(importer, retries - 1, delay * 2)),
        delay,
      ),
    );
  });
}

// 路由配置中用 retryImport 包裹 lazy import
const EditorPage = lazy(() => retryImport(() => import("./pages/Editor")));
```

三层防御的层次关系: import 重试 (静默消化抖动) → ErrorBoundary (重试失败后交互式提示) → 资源错误上报 (监控 SDK 记录与定位). 用户能感知到的只有最后一层, 前两层尽量无声解决

3. 预加载 (缓解直连路径的竞态型错误)
   - modulepreload 预取编辑器核心 chunk: modulepreload 是专门为 ES module 设计的资源提示, 相比 preload 它不仅提前下载脚本, 还会在浏览器中提前解析和编译模块 (但不执行), 使得真正 import 时省去了网络往返和编译开销:

```html
<!-- 在入口 HTML 中声明, 浏览器会在首屏渲染后尽快加载 -->
<link rel="modulepreload" href="/assets/editor-chunk.[hash].js" />
<link rel="modulepreload" href="/assets/monaco-vendor.[hash].js" />
```

webpack 中可配合 html-webpack-plugin 的注入或用 preload-webpack-plugin 自动为路由 chunk 生成 modulepreload 标签

适用场景: modulepreload 不阻塞 HTML 解析和首屏渲染, 但默认优先级并不低 (Chrome 中 modulepreload 与动态 import 的模块预载同属中等优先级, 且会提前解析编译模块), 会和首屏资源竞争带宽. 如果首屏本身包含编辑器, modulepreload 能让它和首屏一起尽早下载, 值得用. 但 Tiktok 平台首屏是搜索推荐页, 编辑器是其他路由, 首屏不包含编辑器——此时 modulepreload 几百 KB 的 monaco-vendor 会挤占首屏资源带宽, 弱网下间接拖慢首屏, 不建议用, 改用 requestIdleCallback 在首屏完成后再预取

- requestIdleCallback 时机预取: 相比 modulepreload 在 HTML 渲染后立即开始下载, requestIdleCallback 在首屏渲染完成、浏览器空闲后才触发, 不和首屏资源竞争带宽, 适合首屏不包含编辑器的场景. 在首屏指标 (LCP) 上报完成后的空闲时机预取编辑器相关资源: 编辑器页面 chunk 是 webpack chunk 用 import() 预取, worker 脚本是 CDN URL 不在 webpack 打包体系里, 用 fetch() 预取到 HTTP 缓存. requestIdleCallback 带 timeout 兜底参数, 避免页面一直不空闲导致预取被无限延迟:

```typescript
function prefetchEditorAssets() {
  const schedule = (cb: () => void) => {
    if ("requestIdleCallback" in window) {
      requestIdleCallback(cb, { timeout: 2000 }); // 2s 内必须执行
    } else {
      setTimeout(cb, 2000);
    }
  };

  schedule(() => {
    // 1. 预取编辑器页面 chunk (webpack 动态 import, 进 HTTP 缓存)
    import("./pages/Editor").catch(() => {});

    // 2. 预取 monaco worker 脚本 (CDN URL, 用 fetch 预取到 HTTP 缓存)
    // worker 是竞态根源, 预取 worker 是最直接的缓解
    const workers = [
      `${MONACO_CDN}/editor/editor.worker.js`,
      `${MONACO_CDN}/language/typescript/ts.worker.js`,
    ];
    workers.forEach((url) => fetch(url).catch(() => {}));
  });
}

// 首屏 LCP 上报完成后触发
reportLCP().then(prefetchEditorAssets);
```

两者的选择取决于首屏是否包含编辑器: 首屏包含编辑器时用 modulepreload 让它和首屏一起尽早下载; 首屏不包含编辑器时 (Tiktok 平台场景) 用 requestIdleCallback 在首屏完成后预取, 不与首屏竞争带宽. requestIdleCallback 回调里同时预取编辑器页面 chunk (import()) 和 worker 脚本 (fetch CDN URL), 竞态根源是 worker 脚本没就绪, 预取 worker 是最直接的缓解

- monaco 本体拆为独立 vendor chunk: webpack 的 splitChunks 把 monaco-editor 单独拆出来, 编辑器页面 chunk 只剩业务代码 (React 组件、页面布局、调用后端 API 等), 不再包含 monaco 库:

```javascript
// webpack.config.js
optimization: {
  splitChunks: {
    cacheGroups: {
      monaco: {
        test: /[\\/]node_modules[\\/]monaco-editor[\\/]/,
        name: "monaco-vendor",
        chunks: "all",
      },
    },
  },
},
```

monaco 体积大 (几百 KB), 拆成独立 chunk 后跨多个编辑器页面共享缓存——用户从规则配置页跳到 DSL 编辑页, monaco-vendor chunk 已在缓存, 不重复下载, 只有业务代码 chunk 变化

总结: 竞态型错误靠「预加载 + worker 容错降级」缓解, 其余错误靠监控 SDK 的资源错误捕获与现场还原兜底. 这类问题无法百分之百消除 (用户可能离线、CDN 可能故障), 最终依赖前文的 JSError 上报、rrweb 录屏还原、跨域错误解析等能力闭环排查.

### SPA 首屏渲染时间 (FSP) 如何计算?

真实业务场景: Tiktok 搜索推荐平台是 React SPA, 首屏内容由 JS 执行后动态渲染, 不是 HTML 直出的. 传统的 DOMContentLoaded 只表示 HTML 解析完成, load 事件表示所有资源 (包括非首屏图片、iframe) 加载完毕, 都不能准确反映用户看到首屏内容的时间. LCP (Largest Contentful Paint) 虽然更接近, 但浏览器按元素面积自动选“最大内容元素”, 候选元素仅限视口内 (视口外的大图不会成为候选), 仍可能选到骨架屏占位等不代表首屏真正完成的元素. yukino-sentry 用 MutationObserver 自行计算 FSP (First Screen Paint), 只关心首屏视口内可见元素的出现时间.

#### FSP 的计算原理

核心思路: 用 MutationObserver 监听 DOM 变化, 每次首屏视口内新增可见元素就记录一个时间戳 (performance.now()), 最终取最大的时间戳作为 FSP——因为只有最后一个首屏元素出现, 首屏才算“完整”.

#### 实现步骤

对应 yukino-sentry first-screen-paint.ts 的实现:

```typescript
// 1. 判断元素是否在首屏视口内: getBoundingClientRect 与视口有交集
function isInViewport(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();
  return (
    rect.right > 0 &&
    rect.bottom > 0 &&
    rect.left < globalThis.innerWidth &&
    rect.top < globalThis.innerHeight
  );
}

// 2. MutationObserver 监听 DOM 变化, 过滤并记录首屏可见元素
const excludedElementNames = new Set(["link", "script", "style"]);
const entries: RenderEntry[] = [];

observer = new MutationObserver((mutationList) => {
  checkDomChange(callback); // 每次变化都检查是否加载完成
  const children: HTMLElement[] = [];
  for (const mutation of mutationList) {
    if (!isHTMLElement(mutation.target) || !isInViewport(mutation.target))
      continue;
    for (const node of Array.from(mutation.addedNodes)) {
      // 过滤: 必须是 HTMLElement、不是 link/script/style、在视口内
      if (
        isHTMLElement(node) &&
        !excludedElementNames.has(node.tagName.toLowerCase()) &&
        isInViewport(node)
      ) {
        children.push(node);
      }
    }
  }
  if (children.length) {
    // 记录这批元素 + 当前时间戳
    entries.push({ children, startTime: performance.now() });
  }
});
observer.observe(document, {
  childList: true,
  subtree: true,
  characterData: true,
  attributes: true,
});

// 3. rAF 轮询检测页面加载完成, 取最后一批首屏元素的时间作为 FSP
function checkDomChange(callback: Callback): void {
  cancelAnimationFrame(requestId);
  requestId = requestAnimationFrame(() => {
    if (document.readyState === "complete") {
      observer?.disconnect();
      // 首屏完成 = 最后一批首屏元素出现的时间; entries 为空时返回 0
      const fsp =
        entries.length === 0 ? 0 : Math.max(...entries.map((e) => e.startTime));
      callback(fsp);
      return;
    }
    checkDomChange(callback); // 未完成, 下一帧继续
  });
}

// 4. requestIdleCallback 延迟启动, 避免影响首屏性能本身
export function getFirstScreenPaint(callback: Callback): void {
  if ("requestIdleCallback" in globalThis) {
    requestIdleCallback((deadline) => {
      if (deadline.timeRemaining() > 0) observeFirstScreenPaint(callback);
    });
    return;
  }
  observeFirstScreenPaint(callback);
}
```

#### 关键设计决策

- 为什么取最大 startTime: entries 中每个 entry 的 startTime 是该批元素插入的时间, 首屏渲染完成 = 最后一批首屏元素出现的时间, 所以取 max. 比如 React 渲了三批元素 (骨架屏 -> 列表头部 -> 列表内容), FSP 取列表内容出现的时间
- 为什么用 rAF 轮询而不是 onload 事件: onload 等待所有资源 (包括非首屏图片、iframe), 可能远晚于首屏完成; rAF 每帧检查 readyState, 能在 DOM 稳定后尽快得出 FSP
- 为什么排除 link/script/style: 这些元素在 head 中, 不产生视觉渲染, 不应计入首屏时间
- 为什么用 requestIdleCallback 启动: MutationObserver 的 observe 调用和回调执行有开销, 在首屏关键渲染路径上启动会影响性能本身 (你正在测首屏性能, 不能让测试工具本身拖慢首屏). 延迟到空闲时启动, 代价是可能漏掉极早期的首屏元素, 但 SPA 首屏元素通常在 JS 执行后才出现, 时序上能覆盖

#### FSP vs LCP

- LCP: PerformanceObserver 监听浏览器自动选的“最大内容元素”的渲染时间, 实现简单 (浏览器内置) 但选择标准是面积, 候选虽仅限视口内元素, 仍可能选到不代表首屏完成的元素 (如大面积骨架屏占位)
- FSP: MutationObserver 自行统计首屏视口内所有新增元素, 取最后一个出现的时间, 更贴近用户真实体验, 代价是实现复杂度更高

#### 边界与局限

- 骨架屏干扰: 如果首屏先出现骨架屏再出现真实内容, FSP 会把骨架屏出现的时间计入, 导致 FSP 偏小. 这是所有 DOM 变化监听方案的通病, 缓解手段是结合 FCP (First Contentful Paint) 判断骨架屏 vs 真实内容
- SSR 场景退化: 如果首屏元素由服务端直出, MutationObserver 在 readyState 变为 complete 前可能来不及观察到 (元素在 HTML 解析阶段就存在了), entries 为空返回 0. 缓解手段是在 SSR 场景 fallback 到 LCP 或直接用 DOMContentLoaded
- SPA 路由切换不算首屏: FSP 只计算 document 初始化阶段的首屏, 路由切换后的渲染不在观察范围内 (MutationObserver 在 readyState complete 后断开)

总结: FSP 用 MutationObserver 自行统计首屏视口内元素的出现时间, 取最后一批元素出现的时间作为首屏完成时间, 比浏览器自动选的 LCP 更贴近用户真实体验. 代价是实现复杂度高, 且对 SSR 和骨架屏场景有局限. 核心取舍是“用更精确的统计换取更复杂的实现”.

### Sourcemap 反解与堆栈聚合策略是怎样的?

这两个问题分别解决「定位到源码行」和「把同类错误归为一组」, 是 JSError 监控从「能捕获」到「能消费」的关键环节. 以下整理自字节 Slardar 前端监控的实践.

#### Sourcemap 反解

线上代码经过压缩混淆, 上报的堆栈行列号对应的是产物代码, 无法直接定位源码. Sourcemap 维护了产物行列到源码行列的映射关系, 输入产物行列号即可获得源码行列号.

反解过程涉及 VLQ (Variable-Length Quantity) 编码, 它是一种将映射关系压缩为类 base64 编码的手段. 实际工程中直接当黑盒使用, 业界有成熟的解析工具:

```javascript
const { SourceMapConsumer } = require("source-map");

const consumer = await new SourceMapConsumer(rawSourceMap);
const pos = consumer.originalPositionFor({
  line: 1, // 产物行号
  column: 328, // 产物列号
});
// => { source: "src/app.ts", line: 42, column: 8, name: "handleClick" }
```

Sourcemap 的上传时机有三种方案:

| 方案             | 做法                                               | 问题                                     |
| ---------------- | -------------------------------------------------- | ---------------------------------------- |
| 事后反解         | 异常发生后拿堆栈去本地或线上反解                   | 效率低, 定位慢                           |
| sourceMappingURL | 在产物末尾声明 map 文件 URL, 浏览器自动关联        | 等于把源码逻辑暴露给所有用户, 有保密风险 |
| 构建时上传       | 打包插件/CLI 在 CI 构建阶段把 sourcemap 上传到后端 | 主流方案, Sentry-CLI 和字节内部均采用    |

构建时上传的流程: 发版构建 -> 插件生成 sourcemap -> 上传到监控后端 (关联项目 + 版本) -> 线上异常上报后, 后端自动用对应版本的 map 文件反解 -> 用户看到的已经是源码堆栈. 用户不需要操心反解工作.

#### 堆栈聚合 (Fingerprint)

如果每条上报都独立展示, 错误列表会被大量重复上报淹没, 无法做统计和分配. 需要把「同一种错误」归为一组, 只展示聚合后的异常.

一个 JS 异常通常携带:

- name: 错误类型, 如 TypeError、SyntaxError、DOMError
- message: 错误描述, 如 "Cannot read properties of undefined (reading 'b')"
- stack (非标准): 调用栈字符串

最朴素的聚合方式是 name + message, 但这远远不够: 两个不同文件、不同代码段抛出的 TypeError 可能有完全相同的 message, 会被错误聚合到一起, 导致修了一个以为全修了.

Slardar 参考 Sentry 的策略, 利用 stack 信息做更精确的聚合:

1. 反解后的 stacktrace 拆分为一系列 Frame
2. 每个 Frame 提取三个关键信息: 调用函数名 (function)、文件名 (filename)、当前执行行 (context_line)
3. 每个提取部分称为一个 GroupingComponent, 自上而下递归检测, 自下而上生成嵌套的 GroupingComponent 树
4. 顶层调用 GroupingComponent.getHash() 得到最终哈希值, 即 fingerprint

相同 fingerprint 的上报归为同一异常. 相比 name + message, 利用 stacktrace 能区分不同文件下触发相同 message 的情况, 聚合精度显著提高.

与 yukino-sentry 的对比: yukino-sentry 在 SDK 侧用 `type-message-filename-line-column` 的 base64 编码做错误签名 (「JSError 上报应该携带哪些错误信息?」中提到的 LRU 去重), 这是客户端侧的轻量去重; Slardar/Sentry 的 fingerprint 是服务端侧的聚合, 基于反解后的完整 Frame 信息, 粒度更细. 两者解决不同层面的问题: 客户端去重防止循环报错打爆上报通道, 服务端聚合把同类错误归组供人消费.

### 异常报警机制如何设计?

异常反解和聚合完成后, 用户访问监控平台可以看到错误, 但问题的发现仍依赖人工「走查」. 对严重线上问题这不够, 需要主动通知. Slardar 的报警分宏观和微观两类.

#### 宏观报警 (数量/比率报警)

统计某一类指标是否超出阈值, 不关心具体是什么错误. 三个关键配置:

1. 样本量/用户数阈值: 防止小样本导致比率剧烈波动产生误报. 例如配置「错误率 > 20% 报警」, 如果 JS 错误数从 0 涨到 1, 增长率的计算因分母为 0 而无定义, 需要特殊处理 (如直接视为新增异常走微观报警); 小样本下的比率波动同样不可靠. 设置「影响用户数 > 5 时才触发」可过滤这类噪声

2. 归因维度: 仅知道「错误率超了」没有行动力. 配置归因维度后, 报警信息会附带 top3 关键错误 (绝对量最大) 和 top3 增长最快错误, 帮助快速定位原因

3. 时间窗口与运行频率: 数量/比率需要一个统计范围 (时间窗口), 报警不是实时盯着数据的, 而是定时器定期检查窗口内数据是否超阈值. 运行频率决定检查间隔. 这种方式做到类实时监测, 但不会带来过大资源开销

#### 微观报警 (新增异常报警)

关注每一个具体问题: 只要该问题此前没出现过, 就主动通知. 与宏观报警的区别:

- 宏观报警是定时查找, 有运行频率和窗口限制, 实时性有限
- 微观报警是主动推送, 实时性更高
- 适用于发版、灰度等对新问题极敏感的阶段

如何判断「新增」: 基于版本维度. 业务代码关联版本概念 (「Sourcemap 反解与堆栈聚合策略是怎样的?」中 sourcemap 上传时携带的版本), 错误也关联版本:

- 指定版本/最新版本: 分析该 fingerprint 是否为该版本代码中首次出现
- 全体版本: 在「首次」基础上增加时间限制. 某个错误长期未出现后又突然出现, 仍有通知意义; 如果不加时间限制, 这个错误因为历史上出现过就不会通知, 可能遗漏

#### 处理人自动分配

异常定位后, 如果能直接分配给这行代码的提交者, 可进一步提升处理效率. 实现依赖 git blame:

需要的信息:

- 线上报错项目对应的源代码仓库名 (如 toutiao-fe/slardar)
- 线上报错代码的版本, 及该版本关联的 git commit

为什么需要版本关联: 默认 blame 的文件是最新版本, 但线上跑的不一定是最新代码. 不同版本可能发生行的变动, 影响行号. 必须确保 blame 的文件和线上报错的文件处于同一版本.

落地方式: 通过 CLI 工具在发布脚本中提供当前版本和关联的代码仓库信息 (Sentry-CLI 也提供此能力). 数据采集侧携带相同版本. 线上异常发生后, 通过版本找到对应时期的源文件, 调用 Gitlab/Github 的 open-api 获取 blame 历史, 确定 author/committer, 自动分配.

### 性能监控的瓶颈定位与品质度量怎么做?

采集到性能指标只是第一步, 关键问题是: 如何找出性能瓶颈的根因? 如何判断指标好不好? 以下整理自 Slardar 的实践.

#### 瓶颈定位: 慢会话 + 性能时序分析

参考 Kibana / Datadog 的数据洞察思路, Slardar 设计了数据探索能力: 针对用户上报的任意维度对一类日志进行过滤, 而不只是获得聚合后的列表.

好处:

- 可以直接定位到一条具体日志, 找到真实的 data point 来分析
- 视图状态可保存, 通过链接发送给他人, 直接还原现场

慢会话筛选: 对某一类 PV 上报关联的性能指标做数值筛选, 不需要预设「慢会话阈值」. 例如 FCP > 3000ms 筛选, 获得一系列 FCP > 3s 的 PV 日志现场.

性能时序瀑布图: 每次 PV 上报后, SDK 设置全局 view_id, 只要没有页面切换就保持不变. 后续的请求、异常、静态资源上报通过 view_id 在后端做时序串联, 形成资源加载瀑布图. 瀑布图由真实用户上报形成, 比统计值产生的甘特图更能帮助解决实际问题.

#### 瓶颈定位: Longtask + 用户行为分析

瀑布图能定位网络/资源因素导致的加载迟缓, 但卡顿不一定来自网络. 例如 head 中插入一段耗时同步脚本 (while N 次), 卡顿来自主线程代码执行.

浏览器提供 Longtask API 收集占据主线程时间过长的任务. 同样通过 view_id 串联到页面访问中, 用户可观察性能指标是否受繁重主线程任务影响.

局限: 目前 Longtask 只能获得执行时间信息, 无法像 DevTools Performance 面板一样定位到具体代码段.

交互卡顿: 页面卡顿不一定发生在加载阶段, 也可能来自点击、滚动等交互. RUM / Navigation 指标无法定位这类问题. 通过对操作行为计时, 将计时范围内触发的请求、资源和 Longtask 以瀑布图方式收敛到一起, 可定位「慢操作」.

#### 品质度量: 指标评分

采集到指标后需要结论: 好还是不好?

两个前提:

1. 以单页面为维度判定: 整站视角的置信度受诸多因素影响. 一个站点包含轻量登录页和功能丰富的中后台, 性能要求和用户容忍度不一致, 简单平均会观察不到重点

2. 需要参照系: FMP = 4000ms 对逻辑较重的 PC 页面 (数据平台、在线游戏) 可能符合业务要求; FMP = 2000ms 对做了 SSR 优化的回流页可能远达不到预期. 不同业务场景有不同的性能基准, 转化为具体的指标基准线

评分方案: 参考 Lighthouse 的做法. Lighthouse 通过大量线上页面的性能数据, 对每个性能指标用对数正态分布将指标值转化为百分制分数, 再给予每个指标权重, 计算整体分数. Slardar 对 RUM 指标、异常指标、资源加载指标采取类似方案.

达标率: 给整体性能分数制定基准分数线, 超过分数线才认为「达标」. 整站达标水平 = 达标子页面数 / 全站页面数. 通过达标率, 不熟悉技术的运营、产品同学也可以定期巡检页面品质状况.

### 请求与静态资源监控的两种采集方案?

页面能否正常响应用户操作、信息能否正确展示, 和 API 请求、静态资源息息相关. 主流监控方案有两种: 手动 hook 和 ResourceTiming.

#### 方案一: 手动 hook

通过 hook XHR 和 Fetch 的原型方法, 记录请求参数、状态、耗时:

```javascript
// XHR: hook open 记录 method 和 url, hook send 在 onreadystatechange 时打点计算耗时
hookObjectProperty(XMLHttpRequest.prototype, "open", hookXHROpen);
hookObjectProperty(XMLHttpRequest.prototype, "send", hookXHRSend);

// Fetch: 直接 hook global.fetch
hookObjectProperty(global, "fetch", hookFetch);
```

优势: 无关兼容性, 采集方便, 能拿到请求响应体等业务信息.
劣势: 打点计时包含了事件队列处理耗时等非服务端因素, 与后端口径对不齐.

#### 方案二: ResourceTiming

利用浏览器内置的 Performance Resource Timing API, 采集更精准的资源加载各阶段耗时:

```javascript
// pageLoad 前: 获取已完成的 resource 信息
performance.getEntriesByType("resource");

// pageLoad 后: 用 PerformanceObserver 持续监控
const observer = new PerformanceObserver((list) => {
  list.getEntries().forEach((entry) => {
    // entry 包含 DNS、TCP、TLS、TTFB、下载等各阶段精确耗时
  });
});
observer.observe({ type: "resource", buffered: false });
```

优势: 更精准, 记录中避开了额外的事件队列处理耗时.
劣势: 拿不到请求响应体等业务信息.

#### ResourceTiming 的阶段划分

实际工作中常遇到前端请求上报时间极长但后端日志正常的情况, 通常是打点方案计入了太多非服务端因素 (网络、前端代码执行排队). 从 ResourceTiming 中分离这些因素有两种方案:

1. Chrome 方案 (阿里 ARMS 也采用): 将线上采集的 ResourceTiming 和 Chrome timing 面板指标类比, 还原出近似的各部分耗时. 问题是 Chrome 实际计算 timing 的方式不明, 近似值可能和面板数据对不上

2. 标准方案 (W3C 规范): 按规范划分阶段, 通用性好, 数据一定符合规范. 问题是阶段划分较粗, 无法判断浏览器排队耗时, 无法完全区分网络下载和下载完成后的资源加载阶段

Slardar 以标准方案为主、Chrome 方案为辅. 与服务端对齐耗时: 标准方案的 request 阶段减去 serverTiming 中的 CDN、网关部分耗时.

### 监控 SDK 的插件化架构如何设计?

字节存在大量移动端页面, 对首包体积和主线程占用极为苛刻; 同时有 node、小程序、electron 等多平台场景. 如果每种场景重新开发一套 SDK, 人力损耗大. 解决思路: 框架平台无关, 数据采集以插件形式存在, 可插拔.

#### 整体架构

把 SDK 看作一条流水线 (Client):

- 输入: 用户配置 (config), 通过 ConfigManager 管理
- 处理: 具体事件 (Event), 通过 Plugins 采集和产出
- 输出: 上报数据, 通过 Sender 批处理, Transporter 发送

流水线是平台无关的, 不关心事件是什么、从哪来, 将组件交互抽象为 client 上的事件, 数据采集器可介入数据流转的每个阶段. Transporter 是平台强相关的: Web 用 xhr/fetch, node 用 request.

生命周期钩子: 利用 beforeSend 等钩子, 用户可在适当阶段处理流水线上的事件 (如修改即将发送的上报内容).

#### 插件机制

框架是平台无关的数据流 (类似精简版 Rx.js), 各平台只需设计对应的采集或数据处理插件. 插件实现了某种程度的 IOC: 开发者不需要关心事件怎么处理、参数从哪来, 只利用传入的参数获取配置、启动插件.

#### 同步/异步加载分离

为降低首包体积, 插件分两种加载方式:

- 可以预收集的监控代码: 不出现在首包中, 以异步插件方式接入
- 无法预收集的监控代码 (如错误监听、请求 hook): 以同步形式和首包打在一起, 尽早启动

异步插件采用约定式加载: 主包加载时在全局初始化注册表和注册方法, 读取用户配置后拉取远端插件, 利用全局注册方法获取插件实例, 传入 client 执行. 用户在使用层面完全无感.

#### 预收集机制

监控 SDK 通常需要尽早执行, 但若异常先于监控代码加载发生, 监控就位后无法捕获历史异常. 解决: 同步加载一段精简代码 (JS Snippets), 在其中启动 addEventListener 采集先于主逻辑发生的错误, 存储到全局队列. 监控代码就位后读取队列缓存并上报, 不会漏报.

同时, 通过 JS 代码创建的 script 标签默认携带 async 属性, 下载阶段不阻塞页面加载, 提升首屏性能.

经过插件化和体积改造, Slardar SDK 首包从 63KB 降到 34KB.

### 监控 SDK 体积优化的具体手段有哪些?

监控 SDK 通常作为第一个脚本加载, 体积膨胀不仅增加下载时间, 还增加浏览器解析脚本的时间. 以下整理自 Slardar SDK 的体积优化实践, 分微观和宏观两个层面.

#### 微观: 精简代码表达

1. 避免过多 class 和过长属性方法名

class 定义会被 TS 转换成 function 声明 + prototype 赋值, 且压缩工具无法压缩 object 属性名:

```javascript
// class 写法, 压缩后长命名保留
class ClassWithLongName {
  methodWithALongLongName() {}
}
// 压缩: var ClassWithLongName=function(){function n(){}return n.prototype.methodWithALongLongName=function(){},n}();

// 函数式写法, 压缩后体积减小 50% 以上
function functionWithLongName() {
  return function MethodWithALongLongName() {};
}
// 压缩: function n(){return function(){}}
```

2. 内部函数传参用数组代替对象

对象字段名不会被压缩工具压缩. 配合 TS named tuple 类型保证可维护性:

```typescript
// 对象传参: optionA/optionB/optionC/optionD 字段名保留
function report(event, { optionA, optionB, optionC, optionD }: ObjectType) {}

// 数组传参: 压缩后无字段名
function report(event, [optionA, optionB, optionC, optionD]: NamedTupleType) {}
```

3. 避免 ?. ?? ??= 等操作符

TS 编译成 ES5 时, `a?.b` 会转换成 `a === null || a === void 0 ? void 0 : a.b`, 过多的 nullish 操作符显著增加体积. 同理, spread 操作符、generator 等新语法编译后可能引入额外 polyfill.

#### 宏观: 减少产物包含的内容

1. 拆分文件: 分离非必须提前执行的逻辑为异步加载文件, 不同功能拆分成不同文件按需加载

2. 避免 polyfill: 尽可能不使用存在兼容性的方法, 不需要兼容低端浏览器时可以不引入 polyfill

3. 减少重复常量字符串

```javascript
// 优化前: 'addEventListener' 和 'load' 重复出现
a.addEventListener("load", cb);
b.addEventListener("load", cb);
c.addEventListener("load", cb);

// 优化后: 提取公共变量
let ADD = "addEventListener";
let LOAD = "load";
a[ADD](LOAD, cb);
b[ADD](LOAD, cb);
c[ADD](LOAD, cb);
// 压缩: let d="addEventListener",e="load";a[d](e,cb),b[d](e,cb),c[d](e,cb);
```

注意: 这个方法在 Web 端收益有限, 因为浏览器传输时做 gzip 压缩, 已经将重复信息高效压缩了. 但对嵌入移动端 app 的监控 SDK (不走 gzip), 能减少约 10-15% 产物体积. 可用 TSTransformer 或 babel plugin 自动完成提取.

### 监控 SDK 性能如何衡量与优化?

监控 SDK 影响数以亿计用户的体验, 自身性能必须达到极致水准. 以下整理自 Slardar 的性能衡量与优化实践.

#### 性能衡量: Benchmark + Puppeteer

SDK 最可能影响性能的地方: 初始化时执行各类监听、事件上报请求对业务的影响、数据缓存的内存使用.

使用 benny 等 benchmark 工具测试各模块方法耗时, 分两个维度:

- 接入 SDK 后自动运行的各类监控 (页面加载之初执行, 劣化会严重影响首屏)
- 开发者调用的 client 方法 (由用户控制, 可能频繁调用)

由于前端监控 SDK 依赖大量浏览器环境对象, 无法在 Node 中模拟, 因此将 benchmark 代码打包后放入 Puppeteer 的 headless Chrome 中执行:

```javascript
const browser = await puppeteer.launch();
const page = await browser.newPage();
const cdp = await page.target().createCDPSession();

// 收集结果的通信机制
await page.evaluate(() => (window.benchmarks = []));
await page.exposeFunction("pushResult", (result) =>
  benchmark.results.push(result),
);

// 启动 Profiler 用于绘制火焰图
await cdp.send("Profiler.enable");
await cdp.send("Profiler.start");

// 执行 benchmark
await page.addScriptTag({ content: file.toString() });
await Promise.race([timeout, allBenchmarksDone()]);

// 获取 profile, 可用 speedscope 绘制火焰图
const { profile } = await cdp.send("Profiler.stop");
```

实际 benchmark 发现: 开启性能监听 (各 PerformanceObserver.observe) 最大耗时达 21ms, 和其他监听同时执行加上移动端更弱的 CPU, 极可能成为 longtask 的根源. 其中 fp/fcp/lcp/cls 监控加在一起超过 10ms, 占一半以上.

#### 真实环境衡量: Perfsee Lab

Benchmark 是理想化的方法调用性能, 实际浏览器环境中 SDK 对性能影响有多大? 用 Perfsee Lab 做对照实验:

- 基准页面 (空白组): 逻辑简单、性能好、无外部请求的 SPA (如 React Server Component Demo)
- 实验组: 通过 URL 参数注入监控 SDK 的同一页面

Lab 用 headless 浏览器运行页面, 收集运行时数据, 产出性能指标分数、网络请求信息、主线程 JS/渲染/Longtask 信息.

实际扫描结果: SDK 注入在 mobile profile (4 倍降频) 下给业务带来 FCP 70ms、LCP 90ms、LOAD 200ms 的劣化. Breakdown 时间线显示 SDK 在 load 之前执行了 30ms 主线程占用.

#### 性能优化手段

1. 监控任务切片运行, 区分优先级

除必要的监听和事件预收集外, 其他任务不应阻碍业务代码执行. 异常和请求监听为必须前置执行的任务, 其他事件监听拆分为单独任务, 采样、数据运算、上报等后处理逻辑通过 requestIdleCallback 在空闲时执行.

2. 减少重复监听

多个性能指标监听同一事件的公用监听器只做一次 addEventListener. 例如 CLS 和 LCP 都需要监听 onBFCacheRestore (pageshow 事件), 合并为一次监听.

3. 可延迟的方法延迟执行

高版本 Chrome 中 PerformanceObserver 有 buffer 机制, 可直接获取调用之前的性能指标. 这些方法调用可等页面完全加载完成后执行, 减少对首屏的影响.

4. 请求数量优化

- 插件脚本: 通过 CDN combo 服务将多个异步插件请求合并为一个
- 事件上报: 内部维护缓存, 达到一定时间间隔或累计数量后统一上报
- 页面卸载时的上报: 浏览器在 unload 时会忽略异步 ajax 请求, 同步 ajax 在现代浏览器中已被禁用, 使用 navigator.sendBeacon 解决. sendBeacon 专为统计和诊断代码设计, 保证在文档卸载期间仍能发送数据

经过以上优化后, SDK 对业务 FCP、LCP、LOAD 等性能的影响降到了最低.

## 视频切片与 LLM 聚类标签: 真实实现记录

> 本机器 demo 路径: $HOME/github/26autumn/packages/tags

### 项目背景

需求来自抖音 Debug 平台的"评估算法消费质量": 推荐算法分发视频/直播间内容, 需要回答算法消费的内容质量到底怎么样. 直接对整条视频或整场直播做分析不现实 (一场直播动辄 4~8 小时), 所以链路是:

视频/直播录制文件 -> 切片 -> 每个切片产出聚类标签 -> 标签与消费指标关联, 评估算法消费质量

为了验证这条链路, 在 packages/tags 下用 Golang 实现了一个完整可运行的单机版本 (Go module 路径是 github.com/hangtiancheng/26autumn/docs/tags, 与目录名不一致, 代码中的 import 路径以此为准): 输入一个长视频 (实测 24 分 08 秒的 React Conf 演讲视频), 按固定时长切片, 每个切片抽代表帧调用多模态大模型, 产出 1 到多个简短中文聚类标签, 输出 JSON 结果和 Markdown 报告. 实测 25 个切片全部产出标签, 端到端耗时约 3 分钟.

### 一. 技术选型

#### 1. 大模型调用: eino 框架

大模型调用方式参考 yukino_agent (internal/ai/models), 使用字节 cloudwego 的 eino 框架:

- eino 核心库定义统一的 model.ChatModel 接口和 schema.Message 消息结构
- eino-ext/components/model/openai 提供任意 OpenAI 兼容端点的实现 (base_url 原样使用, 通常带 /v1)
- eino-ext/components/model/claude 提供 Anthropic 实现 (SDK 自动追加 /v1/messages, base_url 不带 /v1)
- 通过配置文件的 model_provider 字段在两者之间切换, 业务代码只依赖 model.ChatModel 接口, 不感知具体供应商

llm 工厂 (internal/llm/model.go) 的职责就是根据配置构造 ChatModel, 后续所有调用方只面对接口. 实测接入了阿里云 MaaS 的 OpenAI 兼容端点, 模型 qwen3.7-flash (多模态).

#### 2. 视频处理: Go 编排 + ffmpeg 子进程

Go 社区没有成熟的纯 Go 视频编解码库, 社区共识是 "Go 负责编排, ffmpeg 负责切割":

- 时长探测: ffprobe -show_entries format=duration, 输出纯数字, Go 侧 ParseFloat
- 抽帧: ffmpeg -ss <时间戳> -i <视频> -frames:v 1 -vf "scale=768:-2,format=yuvj420p" -q:v 4 -f image2 out.jpg
- Go 侧用 exec.CommandContext 驱动子进程, 捕获 stderr 便于排错, ctx 取消可级联杀掉 ffmpeg 进程

不选 cgo 绑定 (goav、gmf) 的原因: 交叉编译困难, 与 ffmpeg 版本强耦合, 生产环境维护成本高. 生产项目也可以用 u2takey/ffmpeg-go 这类进程封装库, 本项目为了透明直接用 exec.

#### 3. 项目结构

```
packages/tags/
├── main.go                      # CLI: -config -input -output -segment -frames -concurrency
├── go.mod / go.sum              # module github.com/hangtiancheng/26autumn/docs/tags
├── Makefile                     # build + release, 6 平台交叉编译 (darwin/linux/windows x amd64/arm64)
├── config.json                  # 模型端点 + 切片参数 (gitignore, 含 api_key)
├── config.example.jsonc         # 带注释的配置参考
├── internal/
│   ├── config/config.go         # 配置加载、默认值、校验
│   ├── llm/model.go             # eino ChatModel 工厂 (openai/anthropic 双供应商)
│   ├── slicer/slicer.go         # ffprobe 时长、分段规划、ffmpeg 抽帧
│   ├── labeler/labeler.go       # 多模态消息构造、JSON 解析、重试、兜底
│   └── pipeline/pipeline.go     # 并发编排、结果聚合、JSON/Markdown 输出
├── dist/                        # make release 产出的跨平台二进制
└── output/
    ├── frames/                  # 每个切片的代表帧 (seg0000_f0.jpg ...)
    ├── tags_result.json         # 结构化结果
    └── tags_report.md           # 人读的时间线报告
```

### 二. 切片实现 (internal/slicer)

#### 1. 时长探测与分段规划

ProbeDuration 用 ffprobe 拿容器时长 (实测视频 1447.72 秒). PlanSegments 按 segment_seconds (默认 60 秒) 把 [0, duration] 切成等长区间, 两个细节:

- 最后一个切片允许短于粒度 (实测最后一片只有 8 秒)
- 尾部碎片小于 1 秒时并入前一个切片, 避免产生无意义的超短切片

24 分 08 秒的视频切成 25 个切片. 固定时长切片的好处是天然幂等: 切片序号和时间区间可以由时长直接算出, 重跑不需要任何状态.

#### 2. 代表帧抽取: 中点采样

每个切片不做逐帧分析, 抽 frames_per_segment (默认 3) 张代表帧, 采样位置是:

```
t(k) = start + span * (k + 0.5) / n,  k = 0, 1, ..., n-1
```

即把切片等分成 n 段, 每段取中点. 中点采样刻意避开切片边界, 因为边界处常见转场黑帧、上一场景残影.

抽帧命令的关键参数:

- -ss 放在 -i 之前: 快速 seek 模式, 先定位到最近关键帧再解码, 速度远快于逐帧解码
- scale=768:-2: 缩放到宽 768px, 高等比, -2 保证偶数 (编码器要求); 降低分辨率直接降低 VLM 的 token 成本
- format=yuvj420p: 强制转成全范围 JPEG 色彩空间, 否则 ffmpeg 9 的 mjpeg 编码器会拒绝 limited-range YUV 输入 (实测踩坑, 见第四节)
- -q:v 4: JPEG 质量, 4 在清晰度和体积之间平衡, 单帧实测约 12~36KB

#### 3. 损坏尾部的回退重试

实测发现视频文件尾部 H264 流损坏 (容器声明时长 1447.7 秒, 实际约 1440.5 秒后不可解码), 最后一个切片的 3 个采样点全部落在不可解码区. 更隐蔽的是: ffmpeg 此时退出码为 0, 只是输出空文件, 不检查文件大小就会误判成功.

对策是时间戳回退重试: 某采样点抽不出帧 (输出文件为空) 时, 时间戳减 1 秒重试, 最多 8 次, 允许回退到切片起点之前 5 秒 (保证尾部被截断的切片仍能拿到邻近帧). 修复后最后一个切片成功产出标签"React 2025 大会 / 技术会议 / 会议标题页".

### 三. 聚类标签生产 (internal/labeler)

#### 1. 多模态消息构造

eino 的 schema.Message 用 UserInputMultiContent 字段承载多模态输入, 每个切片的用户消息由 1 个文本 part + N 个图片 part 组成:

- 文本 part: 说明切片序号、时间范围、帧数, 要求按时间顺序分析
- 图片 part: 代表帧读成 bytes 后 base64 编码, 填入 MessageInputImage 的 Base64Data 字段, MIMEType 为 image/jpeg, Detail 设为 auto 让服务端自行决定图像质量档位

System Prompt 定义角色和输出规范:

```
你是一名视频内容分析专家, 负责分析视频切片的代表帧, 产出聚类标签.

要求:
1. 只输出严格的 JSON, 不要输出任何其他内容, 格式: {"labels": ["标签1", "标签2"], "summary": "一句话描述"}
2. labels 为该切片的聚类标签数组, 必须包含 1 到 3 个标签
3. 每个标签是简短的中文描述, 不超过 12 个字, 概括画面内容、场景或主题
4. 标签应具备聚类价值, 同类内容应产出相同或相近的标签, 避免过于具体的专有名词
5. summary 为对该切片内容的一句话中文总结, 不超过 50 字
```

第 4 条是聚类标签和普通标签的区别: 提示词显式要求标签可复用、可归并, 抑制模型输出过于具体的专有名词, 为后续标签归并减轻压力.

#### 2. 结构化输出的解析与校验

模型回复不保证干净, parseResult 做三层防御:

1. 提取: 取回复中第一个 \{ 到最后一个 \} 之间的子串, 容忍 markdown 代码围栏和前后废话
2. 反序列化: json.Unmarshal 到 \{labels, summary\} 结构
3. 归一化校验: 每个标签 trim、去空、去重, 数量上限 5 个; labels 为空视为非法

#### 3. 重试与兜底: 保证每片必有标签

需求是每个切片必须有 1 到多个标签, 实现上用两级保障:

- 解析失败时最多重试 2 次, 重试消息里附带上一次的错误原因, 让模型纠正
- 重试仍失败则返回兜底标签"未能识别内容", summary 记录失败原因

同理, pipeline 层面抽帧失败、LLM 网络错误等硬失败也不中止整个任务, 该切片降级为兜底标签, 其余切片照常产出. 单次失败只损失一个切片, 不损失整个任务.

### 四. 真实踩坑记录

#### 1. 文本模型拒绝图片输入 (400)

第一次接入的模型 (idealab 的 Peach) 是纯文本模型, 多模态请求直接 400: "The current model only supports text modality and does not support image input". 教训: 接入前必须确认模型是多模态 (VLM); 如果只有文本模型, 需要先在外部做 OCR/图像描述, 把视觉信息转成文本再进提示词.

#### 2. mjpeg 编码器拒绝 limited-range YUV

ffmpeg 9 抽帧报错 "Non full-range YUV is non-standard", 原因是源视频是 limited-range 色彩, 而 mjpeg 编码器要求全范围. 修复: 滤镜链追加 format=yuvj420p 强制转换. 这类问题与 ffmpeg 大版本强相关, 升级 ffmpeg 后回归测试抽帧环节是必要的.

#### 3. ffmpeg 退出码 0 但输出为空

文件尾部损坏时, ffmpeg seek 过去解不出帧, 退出码仍是 0, 输出 0 字节文件. 只看退出码会误判成功, 必须 stat 文件大小. 这是"子进程封装"模式的典型盲区: 退出码不等于业务成功, 产物校验不可少.

#### 4. 并发乱序与结果对齐

25 个切片并发 2 处理, 完成顺序完全乱序 (日志里 segment 9 先于 segment 1 完成). 结果数组按切片下标写入而非追加, 最后按 index 排序输出, 报告时间线始终有序.

### 五. 实测结果

24 分 08 秒视频, 60 秒粒度, 25 个切片, 每片 3 帧, 并发 2, 端到端约 3 分钟, 25/25 产出标签. 标签质量摘录:

| 切片 | 时间范围            | 聚类标签                                               |
| ---- | ------------------- | ------------------------------------------------------ |
| 1    | 00:00:00 - 00:01:00 | React大会 / 赞助商列表 / 并发技术                      |
| 4    | 00:03:00 - 00:04:00 | React会议演讲 / 性能测试演示 / 交互界面展示            |
| 10   | 00:09:00 - 00:10:00 | React技术大会 / React编译器优化 / React Forest原型     |
| 16   | 00:15:00 - 00:16:00 | React技术大会 / React Fir介绍 / 增量渲染技术           |
| 24   | 00:23:00 - 00:24:00 | React大会技术演讲 / React更新机制与未来 / 演讲结束致谢 |
| 25   | 00:24:00 - 00:24:08 | React 2025 大会 / 技术会议 / 会议标题页                |

可以看到: 场景语义识别准确 (赞助商页、代码演示、架构图、致谢页都能区分); 标签具备聚类价值 ("React会议演讲"、"性能对比分析"在多个切片复现); 连只出现一次的项目名 (React Forest、React Fir) 也从画面文字中读了出来, 说明 VLM 自带 OCR 能力, 对演讲类视频尤其有效.

### 六. 大型企业项目中的优化方向

单机验证版跑通后, 放到大型企业场景 (日均数万小时直播录制、标签供算法在线消费) 下, 以下每个方向都有明确的优化空间.

#### 1. 切片层: 从固定时长到内容感知

- 现状: 固定 60 秒切片, 会把完整事件拦腰切断
- 优化: 两级切片. 先固定时长粗切控制成本, 再用内容信号精切: ffmpeg 的 scene 滤镜检测场景突变、blackdetect/freezedetect 检测黑场冻结、音轨 VAD 检测静音段; 直播场景还可叠加互动信号 (弹幕密度突增、礼物事件、上链接时间戳), 这些业务事件比画面信号更能定义"内容段落"
- 切点吸附到最近 I 帧后流拷贝, 无损且速度接近磁盘 IO; 需要帧级精度时才对小段重编码

#### 2. 标签层: 从逐片打标到 embedding 聚类

##### 2.1 逐片打标的三个问题

单机验证版采用的是逐片打标: 每个切片独立调用一次 VLM, 直接产出标签. 这条路线有三个结构性问题:

- 成本线性增长: N 个切片就是 N 次多模态调用, 每次携带 3 张图片 (base64 后每张图片几百到上千 token), 调用量和 token 消耗都与切片数严格成正比, 没有任何规模效应
- 标签措辞不稳定: 模型每次调用都看不到其他切片, 没有全局视角, 同类内容会产出不同措辞的标签. 实测 25 个切片里同一个"React 大会演讲"场景就出现了 "React技术大会"、"React Conf 2025 演讲"、"React大会演讲" 三种写法, 直接按字符串聚合会把同类内容拆成三个簇
- 无法发现未知模式: 标签完全依赖提示词引导, 数据里存在什么内容分布, 系统自己暴露不出来

##### 2.2 embedding 聚类的总体架构

改造方向是 BERTopic 式链路, 核心思想: 标签不是"生成"出来的, 而是先让数据自己聚成簇, 再让 LLM 给每个簇"命名". 五步流水线:

```
切片代表帧 -> 多模态表示 -> embedding 向量 -> UMAP 降维 -> HDBSCAN 聚类 -> LLM 簇级命名
```

关键转变: LLM 从"每个切片的标注员"变成"每个簇的命名者", 调用量从切片数量级降到簇数量级.

##### 2.3 切片表示: 两条路线

路线 A, 视觉 embedding: 代表帧直接过多模态 embedding 模型 (CLIP 类, 例如 OpenAI CLIP、中文场景的 Chinese-CLIP、BGE-VL), 输出定长向量. 优点是便宜、可批量、完全离线; 缺点是画面相似但语义不同的内容会靠得很近 (两页不同的代码截图视觉 embedding 几乎一样).

路线 B, 描述转文本 embedding: 先用 VLM 对代表帧生成结构化描述 (画面内容、是否有人出镜、屏幕文字/OCR 结果、图表类型), 描述文本再过文本 embedding 模型 (BGE、text-embedding 类). 优点是语义密度高, 演讲、代码、图表类视频效果尤其好 (实测 VLM 能读出屏幕上的项目名); 缺点是多一次模型调用.

选型建议:

- 演讲、教程、代码演示类内容: 路线 B 为主, 语义都在屏幕文字里
- 秀场、带货直播: 路线 A 为主, 画面本身就是内容, 再叠加 ASR 转写文本 embedding
- 混合场景: 两路向量拼接 (或分别聚类再交叉验证), 视觉和语义互补

注意路线 B 里 VLM 仍然被使用, 但职责从"打标签"降级为"生成描述": 描述不要求措辞稳定 (稳定性交给聚类), 可以用更便宜的小模型, 也可以走批量推理接口, 单价远低于在线多模态打标.

##### 2.4 降维与聚类

embedding 维度通常 768~2048, 高维空间里距离区分度差 (维度灾难), 直接聚类效果不稳定, 先降维:

- UMAP: n_components 取 5~20, metric 用 cosine. UMAP 保留局部邻域结构, 比 PCA 更适合聚类前置降维
- 距离度量必须用 cosine: embedding 的模长无意义, 方向才承载语义

聚类算法选型:

| 算法                      | 是否需要预设簇数 | 噪声处理             | 适用场景                                    |
| ------------------------- | ---------------- | -------------------- | ------------------------------------------- |
| HDBSCAN                   | 不需要           | 离群点标为 -1 噪声簇 | 首选, 内容分布未知时让数据自己暴露结构      |
| K-Means / MiniBatchKMeans | 需要             | 无                   | 簇数可控的运营场景, 用轮廓系数/肘部法则选 k |
| 层次聚类 + 余弦阈值       | 不需要           | 单样本簇即离群       | 小规模数据, 且能产出标签层级树              |

HDBSCAN 的关键参数 min_cluster_size 按数据量定: 万级切片设 10~50, 含义是"少于这个数的模式不值得单独成簇", 过小的簇并入噪声簇走人工审查或二次归并. 噪声簇不是垃圾, 它往往就是新出现的内容模式 (新梗、新玩法), 是运营最关心的部分.

##### 2.5 LLM 簇级命名

对每个簇:

1. 采样: 取离簇质心最近的 K 个切片 (medoid, 比 centroid 附近随机采样更有代表性), 连同它们的文本描述、时间分布、簇规模组成上下文
2. Prompt 要求输出 JSON: \{label, definition, boundary\}, label 是简短中文标签, definition 是簇的定义 (什么样的切片属于这个簇), boundary 给出边界判例 (什么样的内容不算这个簇). definition 和 boundary 是留给后续增量归簇和人工抽检用的
3. 注入已有标签体系, 优先复用已有标签, 控制标签膨胀

调用次数 = 簇数. 内容平台的自然簇数通常在几百到几千量级, 与切片总量 (百万级) 相差三到四个数量级.

##### 2.6 成本量化对比

以"日均 1 万场直播, 平均 2 小时, 1 分钟切片粒度"估算, 日增切片 120 万:

| 项目             | 逐片打标                              | embedding 聚类                                                       |
| ---------------- | ------------------------------------- | -------------------------------------------------------------------- |
| 多模态大模型调用 | 120 万次/日                           | 约 2000 次/日 (簇级命名)                                             |
| token 消耗       | 每次约 1500 token (3 帧), 约 18 亿/日 | 约 300 万/日                                                         |
| embedding 计算   | 0                                     | 120 万次, 但走自部署模型或批量接口, 单价比在线大模型低两到三个数量级 |
| 标签稳定性       | 需要事后归并                          | 天然收敛                                                             |

LLM 在线调用量从 120 万次/日降到约 2000 次/日, 约 600 倍, 接近三个数量级 (簇数随内容多样性增长, 且增量场景下新簇命名还有长尾调用).

##### 2.7 增量归簇与标签漂移治理

全量重聚是标签漂移的根源: 每天重新聚类, 同一个内容模式今天的簇编号和标签都可能变, 下游消费方 (算法、报表) 无法对齐历史. 治理方式:

- 簇质心作为固定锚点: 新切片算 embedding 后, 与已有簇质心算 cosine 相似度, 高于阈值 τ (典型 0.75~0.85) 直接归入已有簇, 复用该簇标签, 零 LLM 调用
- 低于阈值的切片进缓冲池, 缓冲池积累到一定量后局部聚类: 成簇的走 LLM 命名流程产出新标签, 不成簇的标记为噪声待审
- 周期性 (例如每周) 全量校准: 检查簇间是否出现合并机会 (两个簇质心过近) 或分裂迹象 (簇内方差过大), 维护旧标签到新标签的映射表, 历史数据可回溯
- τ 的取值用抽检标定: 抽 100 对"相似度在阈值附近"的切片对让人工判断是否同类, 调整 τ 使误归簇率可接受

这套机制下, 标签体系是单调生长的: 老标签永远稳定, 新内容模式以新标签的形式被显式发现, 而不是在全量重聚中悄悄漂移.

##### 2.8 工程分工

embedding 和聚类的生态在 Python (sentence-transformers、umap-learn、hdbscan、scikit-learn), Go 侧没有成熟的 HDBSCAN 实现, 合理的分工是:

- Python 微服务: 负责 embedding 计算、降维、聚类、增量归簇, 对外暴露两个接口: 批量切片归簇 (输入切片 id + 代表帧/描述, 输出簇 id)、触发簇命名 (对新簇调用 LLM 产出标签)
- Go 服务: 负责任务编排、切片元数据管理、标签结果落库、对外提供查询, 与 Python 服务之间走 RPC/HTTP
- LLM 调用放在哪一侧都可以, 保持与 yukino_agent 一致的 eino 调用方式则放在 Go 侧, Python 服务只产出"待命名簇 + 代表样本"

单机验证版 (packages/tags) 可以看作这条链路的第 1 步和第 5 步的直连 (表示 -> LLM), 省略了中间的 embedding/聚类层; 企业版把中间层补齐, 就得到完整的成本与稳定性收益.

#### 3. 标签体系治理

- 现状: 标签完全自由生成, 会无限膨胀
- 优化: 维护标签体系表 (taxonomy). Prompt 中注入已有标签列表, 要求优先复用, 确实无法归类才新建并走审核; 标签分层级 (一级类目 + 二级细分), 一次调用同时产出; 定期跑标签归并任务 (embedding 相似度 + LLM 判断同义), 合并后维护旧标签到新标签的映射, 历史数据可回溯

#### 4. 任务调度: 从进程内 goroutine 到分布式队列

- 现状: 单机 goroutine + 信号量限并发, 进程挂了全部重来
- 优化: 切片级任务进消息队列 (Kafka 或内部队列), 无状态 worker 池消费, 按 (video_id, segment_index) 幂等; 任务表记录状态机 (pending/extracting/labeling/done/failed), 支持断点续跑: 已完成的切片直接跳过, 重跑成本从全量降到增量
- 长视频 (小时级) 按切片粒度分散到多台 worker, 单机串行的瓶颈被彻底消除

#### 5. 可靠性: 重试、限流、熔断、死信

- 现状: 解析失败重试 2 次, 无网络层退避, 无限流
- 优化:
  - LLM 调用加指数退避重试, 区分可重试错误 (429、5xx、超时) 和不可重试错误 (400 参数错误)
  - 按供应商 QPS/TPM 配额做令牌桶限流, 多模型多端点间做故障转移 (主端点熔断后切备用端点)
  - 多次失败的任务进死信队列, 人工介入而不是无限重试烧钱
  - ffmpeg 子进程加超时 (context 级联取消), 防止个别损坏文件卡死 worker

#### 6. 成本控制

- 模型分层: 轻量 VLM 或规则先过滤明显低价值切片 (纯黑场、静态挂机画面直接打规则标签), 只有有价值的切片进大模型
- 缓存: 代表帧感知哈希 (pHash) 作为缓存键, 相同画面的切片 (挂机直播大量存在) 直接复用标签
- 抽帧降采样: 分辨率 (768px 够用的场景不用 1080p)、帧数 (静态片段 1 帧足够)、JPEG 质量都是可调的成本杠杆
- 离线资源: 大批量任务调度到低峰时段或竞价实例, 与在线服务资源隔离

#### 7. 可观测性

- 指标: 切片耗时分布、抽帧失败率、LLM 调用成功率/延迟/token 消耗、兜底标签占比 (兜底率突增就是链路出问题的信号)
- 追踪: 每个切片一条 trace, 串起抽帧、LLM 调用、解析各环节, 排障时能定位到具体切片的具体环节
- 采样审计: 按一定比例保存代表帧 + 模型原始回复, 供人工回查 badcase

#### 8. 质量评估闭环

- 自动评估: LLM-as-judge 用独立 prompt 复核"标签与画面是否一致", 不一致率作为线上质量指标; 聚类侧监控轮廓系数、簇大小分布, 超大簇和单样本簇告警
- 人工抽检: 按簇分层抽样标注, 人工准确率是最终验收指标
- 漂移监控: 每日标签分布与前一周对比, 新标签占比、兜底占比、簇数突变都触发告警

#### 9. 安全与合规

- api_key 不进配置文件明文, 走密钥管理服务 (KMS/配置中心加密下发), 按环境隔离
- 视频内容可能含用户隐私, 代表帧和中间产物落对象存储要设生命周期自动过期, 访问走最小权限
- 标签结果对外输出前过敏感词过滤

#### 10. 消费侧: 标签与算法指标关联

- 标签的最终用途是评估算法消费质量: 切片标签与消费数据 (曝光、点击、停留时长、负反馈率) 按切片 id join, 按标签聚合
- 看两个维度: 算法分发内容的标签分布 (算法在消费什么), 每个标签下的消费质量 (这类内容用户买不买账)
- 识别问题簇 (例如"挂播无人直播"仍有大量曝光说明过滤有漏洞), 反馈给算法侧调整召回和过滤规则, 形成闭环

### 小结

| 环节   | 单机验证版做法                      | 企业级演进方向                          |
| ------ | ----------------------------------- | --------------------------------------- |
| 切片   | 固定 60s + 中点抽 3 帧 + 回退重试   | 内容感知精切, I 帧对齐无损切割          |
| 标签   | 逐片 VLM 调用, JSON 约束 + 重试兜底 | embedding 聚类 + 簇级总结, 标签体系治理 |
| 调度   | 单机 goroutine + 信号量             | 消息队列 + 无状态 worker + 断点续跑     |
| 可靠性 | 解析重试 2 次, 失败降级兜底标签     | 指数退避、限流熔断、死信队列            |
| 成本   | 缩帧 + 并发控制                     | 模型分层、感知哈希缓存、低峰调度        |
| 质量   | 人工看报告                          | LLM-as-judge、抽检、漂移监控            |

## 手写 SWR: 预加载 + 请求去重 + Stale-While-Revalidate

> 本机器路径 $HOME/github/26autumn/packages/swr-demo
> 本文基于 packages/swr-demo 项目, 梳理手写 SWR 数据请求方案的实现思路、与 vercel/swr 等现成方案的选型权衡, 以及 SWR 模式对前端性能的优化原理.

### 1. 业务背景: 这个方案解决什么问题

中后台系统中存在大量公用选择器数据源: Staff 用户选择器、推荐算法选择器、向量库选择器. 这类数据有三个共同特征:

1. 多个页面、多个组件同时消费同一份数据
2. 数据变化频率低 (分钟级甚至小时级) , 短时间内拿到旧数据完全可接受
3. 首屏渲染强依赖: 选择器没有数据, 页面就没法交互

传统做法是在每个组件的 useEffect 里各自发请求, 会带来三个问题:

- 请求发起时机晚: 要等 JS bundle 下载、解析、React mount 之后才开始, 网络请求与脚本加载串行
- 同一份数据被多个组件重复请求, 浪费带宽和后端资源
- 页面切换后组件卸载、内存状态丢失, 再次进入页面又要重新等待完整请求

手写 SWR 方案用约 155 行核心代码 (src/swr.ts) 解决这三个问题, 不引入任何第三方数据请求库.

### 2. 手写 SWR 的实现思路

#### 2.1 整体结构: 两阶段设计

方案分为预加载阶段和消费阶段, 对应 swr.ts 中的 preload 与 swrFetch 两个函数.

数据结构是一个全局 Map 缓存, 每个 key 对应一条缓存记录:

```typescript
interface SWREntry<T> {
  promise: Promise<T>; // 在途请求的 promise (去重锚点)
  result: T | undefined; // 已返回的结果 (缓存锚点)
  timestamp: number; // 请求发起时间
}

const cache = new Map<string, SWREntry<unknown>>();
```

一条记录同时持有 promise 和 result 两个锚点, 这是整个方案的关键设计: promise 用于请求在途时的去重, result 用于请求完成后的缓存命中. 真实场景里这两个锚点对应挂在 window 上的 window.xxxPromise 和 window.xxxResult.

#### 2.2 预加载阶段: preload

preload 模拟 index.html 的 header 内联脚本. 浏览器解析 HTML 到这段脚本时立即执行, 此时 React 的 bundle 可能还在下载中, fetch 请求与 bundle 下载并行进行:

```typescript
export function preload() {
  const startTime = performance.now();
  const staffPromise = fetchStaff();
  // ... 三个请求并行发起

  cache.set("staff", {
    promise: staffPromise,
    result: undefined,
    timestamp: startTime,
  });
  // ...

  // promise resolve 后把 result 挂载到缓存记录上
  staffPromise.then((result) => {
    cache.get("staff")!.result = result;
  });
}
```

要点:

1. 三个请求同时发起, 互不等待, 总耗时取决于最慢的那个
2. promise 先入缓存, result 在 then 回调中补充, 这样无论消费方什么时候到达, 都能命中 promise 或 result 二者之一
3. 预加载脚本不依赖任何框架, jQuery 页面、原生 JS 页面都可以写同样的逻辑

#### 2.3 消费阶段: swrFetch 的三级降级

swrFetch 是消费侧唯一的入口函数, 按优先级依次判断:

第一级, result 已就绪 (缓存命中) . 立即返回已有数据, 耗时接近 0ms, 同时后台静默发起 revalidate 请求, 新数据回来后更新缓存. 这就是 stale-while-revalidate 的含义: 宁可先给旧数据, 也不让用户等待.

```typescript
if (entry?.result !== undefined) {
  const data = entry.result;
  const revalidate = fetcherMap[key](); // 后台刷新, 不阻塞返回
  revalidate.then((newResult) => {
    entry.result = newResult;
    entry.promise = revalidate;
    entry.timestamp = performance.now();
  });
  return {
    data,
    fromCache: true,
    fromPromise: false,
    waitedMs: ~0, // 示意, 实际返回 performance.now() - callTime
  };
}
```

第二级, promise 在途 (请求去重) . 预加载的请求还没返回, 但 promise 已经存在, 直接 await 复用这个 promise, 只等待剩余的网络时间. 多个组件同时消费时共享同一个 promise, 天然去重, 不会发出重复请求.

```typescript
if (entry?.promise) {
  const data = await entry.promise;
  // 示意, 实际 waitedMs 返回 performance.now() - callTime
  return { data, fromCache: false, fromPromise: true, waitedMs: 剩余时间 };
}
```

第三级, 冷启动兜底. 缓存里什么都没有 (预加载没执行、或缓存被清) , 重建完整流程: 发请求、写入缓存、等待完整 RTT. 这保证了方案在任何接入状态下都能正确工作, 降级路径完备.

#### 2.4 对照组: normalFetch

normalFetch 不做任何缓存和去重, 每次调用都发全新请求, 模拟组件挂载时才在 useEffect 中请求的传统写法. App.tsx 用它与 swrFetch 做同屏对比, 通过 performance.now() 测量各自的 waitedMs, 并在时间线图表里可视化.

#### 2.5 Demo 的运行流程

App.tsx 的 run 函数还原了真实时序:

1. clearCache 清空缓存, 模拟页面冷启动
2. 调用 preload, 模拟 header 脚本提前发请求
3. await 100ms, 模拟 bundle 下载与 React mount 的耗时, 给预加载留出并行窗口
4. swrFetch 消费三个数据源, 此时大概率命中 promise 复用甚至 result 缓存
5. normalFetch 对照组从零发请求, 等待完整 800ms+ 网络延迟
6. 二次消费按钮再次调用 swrFetch, 此时 result 已就绪, 耗时接近 0ms, 对照组则必须重新等待完整请求

mock-api.ts 用 800ms 加随机 200ms 的延迟模拟网络耗时, 延迟越大, 预加载并行带来的收益越直观.

### 3. 为什么大型存量项目选择手写 SWR 而不是 vercel/swr

这是最核心的问题. 答案不是"vercel/swr 不好", 而是"存量项目的约束条件让现成方案接不进去, 而手写方案恰好绕开了这些约束".

#### 3.1 架构约束: MPA 与多技术栈共存

大型存量中后台项目的典型现状:

- 构建产物是多个独立 HTML 入口的 MPA, 不是单页应用. 每个页面是独立的加载单元, 页面之间跳转就是整页刷新
- jQuery、原生 JS 写的老页面与 React 新页面长期共存, 迁移是逐页进行的
- React 版本可能停留在 16/17, 无法使用 Suspense data fetching 等新特性

vercel/swr 是一个 React hook 库, useSWR 只能在 React 组件内使用, 且官方推荐搭配 SWRConfig Provider 做全局缓存配置. 这意味着:

- jQuery 页面、原生 JS 页面完全无法消费它的缓存
- MPA 下每个页面都要单独引入并初始化, 页面之间跳转时内存缓存随整页刷新而丢失
- 老版本 React 上部分能力受限

手写方案把缓存锚点放在 window 上 (demo 里是模块级 Map, 语义等价) , 缓存的生命周期与页面文档绑定而不是与某个框架实例绑定, 任何技术栈的页面都能用同一个 swrFetch(key) 消费.

#### 3.2 接入成本: 不动构建、不动框架、不改组件树

现成数据请求库的接入路径通常是: 安装依赖、在应用根部包 Provider、把组件里的 useEffect + fetch 逐个改写成 useSWR hook、处理 loading/error 状态的渲染逻辑. 对一个几百个页面的存量项目, 这是全量改造, 风险和排期都不可接受.

手写方案的接入路径是渐进式的:

1. 在需要优化的那个页面的 header 里加一段内联脚本, 发起预加载并挂载 promise/result
2. 消费侧调用 swrFetch(key), 一行代码
3. 不需要 Provider、不需要 hook、不需要改构建配置、不需要升级 React
4. 哪个页面收益大就先改哪个, 改坏了也只是回退那一个页面

这种"单页面粒度、可灰度、可回退"的接入方式, 是存量项目选型时权重最高的因素.

#### 3.3 能力匹配: 只需要三个能力, 不需要整个库

vercel/swr 提供轮询、重试、指数退避、focus 重新校验、乐观更新、分页、无限滚动、依赖请求等完整能力, React Query 还要再加重. 但本场景只需要三件事: 预加载、请求去重、缓存命中后立即返回加后台刷新.

引入完整库属于过度设计, 代价是:

- 包体积: 手写方案核心约 0.5 KB, vercel/swr 约 4.5 KB gzip, React Query 约 12 KB gzip. 对微前端子应用、SDK 类场景这个差距很敏感
- 心智负担: 团队要学习 hook API、缓存 key 规范、失效策略, 而手写方案的全部逻辑一个文件读完
- 升级维护: 第三方库的版本升级、breaking change 都要跟进, 手写代码没有外部依赖

要点: 选型看的是能力覆盖度与接入成本的比值, 不是功能数量. 当需求是三个能力、而库提供三十个能力时, 多出来的二十七个能力不是收益, 是体积、复杂度和维护成本.

#### 3.4 预加载时机: header 内联脚本是现成库覆盖不到的

这是技术上最本质的一点. vercel/swr 的请求生命周期从 React 组件渲染时才真正开始 (即使有 prefetch 能力, 也要等 bundle 加载并执行) . 而手写方案把请求发起点提前到 HTML 解析阶段的 header 内联脚本, 此时 bundle 还在下载, 网络请求与脚本加载并行.

这个时间窗口是任何运行在 JS bundle 内部的库都无法利用的, 因为库本身就是 bundle 的一部分. 要让请求早于 bundle 发出, 只能用不依赖 bundle 的内联脚本, 而消费侧需要一个能"认领"这个早期 promise 的机制, 这正是手写 swrFetch 做的事.

#### 3.5 什么时候应该选 vercel/swr

保持客观, 说明边界:

- 纯 SPA、React 18+、团队已经统一使用数据请求库的新项目
- 需要乐观更新、mutation 后缓存失效、轮询、请求重试等复杂能力
- 需要 devtools、缓存生命周期管理 (LRU 淘汰、gcTime)

手写方案明确不覆盖这些场景, 它的定位是"存量项目里低成本拿到预加载、去重、缓存三个收益"的战术工具, 不是 React Query 的替代品.

### 4. SWR 对前端性能的优化

#### 4.1 关键路径并行化: 请求与 bundle 下载并行

传统时序是串行的: HTML 解析、bundle 下载、bundle 执行、React mount、useEffect 触发 fetch、等待完整 RTT、渲染数据. 网络请求排在整条链路的尾部.

SWR 时序把 fetch 提前到 HTML 解析阶段, 与 bundle 下载、解析、执行并行. 以 demo 的数据估算 (网络延迟 800ms, bundle 下载加执行约 100ms, 即 demo 模拟的 mount 延迟) :

| 阶段         | SWR 组                                | 对照组                         |
| ------------ | ------------------------------------- | ------------------------------ |
| 数据就绪时间 | 约 800ms (请求与 bundle 并行, 取 max) | 约 900ms (100ms 加 800ms 串行) |
| 二次消费     | 约 0ms (缓存命中)                     | 约 800ms (重新请求)            |

网络延迟越大、bundle 越大, 并行化收益越大. 弱网环境下差距可达数秒. 这本质上是把关键路径上的两段串行等待改成了并行, 与 HTTP 资源 preload 提示、script defer 是同一类优化思路.

#### 4.2 请求去重: 共享在途 promise

多个组件同时消费同一 key 时, 第一个消费者创建 promise 并写入缓存, 后续消费者直接 await 同一个 promise. N 个组件只产生 1 个网络请求.

收益有两层: 前端层面减少了 N-1 次响应解析和状态更新; 后端层面减少了 N-1 次接口调用, 对公用选择器这种被全系统高频消费的接口, 去重直接降低了后端 QPS.

实现上依赖 promise 的可共享性: promise 是惰性求值的句柄, 多次 await 同一个 promise 不会重新执行请求逻辑, 只会各自注册 then 回调.

#### 4.3 Stale-While-Revalidate: 用缓存消除等待

命中 result 缓存时立即返回旧数据, 耗时接近 0ms, 同时后台静默发起新请求更新缓存. 性能收益和体验收益叠加:

- 用户永远看不到 skeleton 和 loading 态, 二次进入页面瞬间有数据
- 后台 revalidate 不阻塞当前渲染, 新数据在下次消费时生效
- 对变化频率低的数据 (选择器选项、配置项) , 绝大多数消费拿到的数据其实都是新的, stale 窗口极短

这个策略成立的前提是业务能容忍短暂的旧数据. 需要注意这一点: SWR 是拿一致性换延迟的权衡, 适合读多写少、容忍最终一致的场景; 下单、支付、库存这类强一致场景不能用.

#### 4.4 对核心 Web 指标的影响

- LCP / FCP 相关的首屏可交互时间: 选择器数据就绪前页面不可交互, 预加载直接缩短这段时间
- TBT 不受影响: 方案只是提前和合并网络请求, 不增加主线程长任务
- 带宽: 去重减少了重复请求的响应体积传输

#### 4.5 与其他预加载手段的对比

可能进一步延伸"为什么不直接用 link rel=preload", 可以对比:

- link rel=preload 只能预加载资源 (脚本、字体、图片) , 无法预加载 XHR/fetch 接口数据
- HTTP 缓存 (Cache-Control) 能覆盖二次访问, 但首次访问仍需完整 RTT, 且无法与 bundle 下载并行调度, 也没有 promise 级别的去重
- React 18 的 useDeferredValue、Suspense 都不解决"请求早于 bundle"的问题
- header 内联 fetch 加 window 挂载 promise, 是接口数据预加载的最直接形态, SWR 消费机制让它能被框架代码无缝认领

### 5. 延伸要点

延伸一: 缓存挂 window 上不怕污染全局吗?

回答: 真实项目会用带命名空间的 key (如 `window.__SWR__.staff`) , demo 里用模块级 Map 是等价的封装. 全局挂载是手段不是目的, 目的是让缓存脱离任何框架实例的生命周期, MPA 页面跳转、jQuery 与 React 混用都能共享.

延伸二: revalidate 失败怎么办, 缓存会一直是旧数据吗?

回答: demo 里 revalidate 的 then 只在成功时更新缓存, 失败保留旧数据, 下次消费再重试. 生产实现应补 catch, 并可加 timestamp 判断数据陈旧程度, 超过阈值 (如 10 分钟) 就降级为阻塞式重新请求, 避免无限使用过期数据.

延伸三: 两个组件几乎同时调用 swrFetch, 会不会竞态发两个请求?

回答: 不会. 判断 promise 是否存在和写入缓存都在同一个同步代码块里完成, JS 单线程加事件循环模型保证了 swrFetch 的同步判断段不会被打断, 第二个调用进入时缓存里已有 promise, 走复用分支.

延伸四: 这个方案怎么做缓存失效?

回答: 当前实现是"每次命中都后台刷新"的激进策略, 适合低频变化数据. 可扩展的方向: 基于 timestamp 的 TTL 判断, TTL 内不 revalidate; 暴露 invalidate(key) 方法供 mutation 后主动失效; 按 key 配置不同的过期策略. 这些都是几十行代码内可以完成的演进, 不需要引入完整库.

延伸五: 如果项目后来升级到了 React 18 的 SPA, 这个方案还有价值吗?

回答: 预加载部分依然有价值, header 内联请求早于 bundle 的时间窗口与框架无关; 消费侧可以逐步替换为 useSWR 或 React Query, 并用它们的初始数据注入能力 (SWR 的 fallbackData、React Query 的 initialData) 认领 window 上的预加载结果, 两套机制可以平滑过渡.

延伸六: 和 React Query 的 prefetchQuery 有什么区别?

回答: prefetchQuery 运行在 bundle 内部, 最早也只能在应用初始化时触发, 无法早于 bundle 下载; 且强依赖 QueryClientProvider, 非 React 页面无法使用. 手写方案的预加载发生在 HTML 解析阶段, 消费入口是普通函数, 这两点差异正是存量 MPA 项目选择它的原因.

### 6. 手写前端性能监控: 思路与选型

本节基于对外部生产项目 boot.ts 监控代码的转述 (该文件不在 swr-demo 仓库中) , 梳理手写性能监控的实现思路、大型企业项目选择手写而非第三方 SDK 的原因, 以及在 swr-demo 中的等价实现.

#### 6.1 boot.ts 的监控思路拆解

boot.ts 的监控代码由五个部分组成, 全部基于浏览器原生 Performance API, 没有依赖任何监控 SDK 的采集能力.

第一部分, 启动打点. 脚本入口第一行就执行 performance.mark('boot-start'), 在整个启动流程 (加载库文件、登录校验、菜单预取、prepare 执行) 完成后打 boot-end, 再用 performance.measure 计算启动总耗时. measure 封装了 try/catch, mark 不存在时不会抛错中断业务.

第二部分, 长任务监听. 用 PerformanceObserver 观察 longtask 类型的条目, 只上报 duration 超过 50ms 的任务 (50ms 是 Long Tasks 与 TBT 的阈值, INP 的处理延迟同样按长任务边界分段) , 上报内容附带当前页面路径和业务码 bizCode, 便于按页面维度归因卡顿. 监听在启动采集完成时 disconnect, 避免后续用户交互的长任务污染启动阶段数据.

第三部分, 资源加载采样. 记录前 12 秒内执行的模块, 按 0.003 的采样率上报模块路径, 用于离线分析"哪些模块值得做预加载". 这是监控反哺优化的典型用法: 先采样观测, 再决定预加载清单.

第四部分, 关键指标采集. 启动完成后一次性采集三类数据:

- Navigation Timing: 从 navigation 条目拆解文档自身的 DNS 耗时、请求排队时间、请求耗时
- Resource Timing: 先 setResourceTimingBufferSize(500) 扩大缓冲区防止条目被丢弃, 再从 resource 条目中按 URL 匹配找出关键接口请求 (checkAccess、findMenuList 等) 的耗时, 并对并行发起的四个菜单请求排序找出最慢的那个, 定位启动链路的瓶颈
- 自定义 measure: 启动总耗时与启动起点

第五部分, 队列化上报. 所有数据推入 window 上的队列, 格式统一为 action 加 arguments 的事件结构, 由后加载的监控 SDK 异步消费. 上报动作全部包在 try/catch 中, 监控代码的任何异常都不会影响业务启动.

#### 6.2 为什么大型企业项目选择手写而非第三方监控 SDK

boot.ts 的监控只用了 performance.mark/measure、PerformanceObserver、Navigation/Resource Timing 等浏览器原生 API, 不依赖任何第三方监控 SDK 的采集能力 (swr-demo 的 perf-monitor.ts 头部注释同样声明这一点). 选择手写有三个现实原因:

1. 采集时机必须早于 SDK 本身. 监控对象是启动链路 (加载库文件、登录校验、菜单预取、prepare 执行), 而第三方 SDK 是 JS bundle 的一部分, 只有 bundle 下载执行后才就位; 依赖 SDK 就意味着 SDK 加载之前的启动阶段全部测不到. 引导脚本手写采集 + window 队列暂存, 让数据先于 SDK 产生, SDK 就位后异步消费队列——这与「监控 SDK 的插件化架构如何设计?」中 Slardar 的预收集机制 (同步 JS Snippets + 全局队列) 是同一思路, 只是这里预收集的是性能打点而非错误.

2. 指标是业务启动链路的私有定制. bizCode 归因长任务、指定接口 (checkAccess、findMenuList 等) 的单独耗时、四个并行菜单请求中找最慢的一个、0.003 采样率的模块路径上报——这些指标描述的是本系统特有的启动流程, 通用监控 SDK 的标准采集项 (PV、JS 错误、通用 Web Vitals) 覆盖不到, 硬套 SDK 的自定义事件 API 反而绕远.

3. 引导脚本有严格的体积与稳定性约束. 它运行在关键路径上, 每多一个依赖都会拖慢被测量的启动过程, 监控代码自身异常更不能中断业务启动 (所以 mark/measure/上报全部包 try/catch). 几十行原生 API 代码可控性远好于引入一个完整 SDK.

这与第 3 节手写 SWR 的选型逻辑同构: 在存量约束下 (MPA、多技术栈共存、引导脚本先于框架执行), 用最小的自研代码精准采集业务真正关心的指标, 公共底座都是浏览器原生能力 (Performance API、promise、全局挂载), 这也是它能在 jQuery、原生 JS、React 页面里通用的原因.

#### 6.3 swr-demo 的监控接入实现

swr-demo 按 boot.ts 的同构思路接入了等价的手写监控, 核心文件是 src/perf-monitor.ts, 对应关系如下:

| boot.ts                          | swr-demo                         | 说明                                                                                                                 |
| -------------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| window.PERF_QUEUE                | PERF_QUEUE 数组                  | 队列化上报, demo 中打印到控制台                                                                                      |
| longTaskObserver                 | observeLongTasks                 | PerformanceObserver 观察 longtask, 50ms 阈值上报                                                                     |
| performance.mark boot-start/end  | swr-boot-start/end               | main.tsx 入口打起点, 每轮 run 会 resetBootMarks 后在 run 内重打, measure 实际以 run 内的起点为准; SWR 数据就绪打终点 |
| performanceMeasure 封装          | 同名函数                         | measure 加 try/catch, 取最后一条同名条目                                                                             |
| seedAemlog                       | collectAndReport                 | 启动完成后一次性采集 Navigation/Resource Timing 并上报                                                               |
| setResourceTimingBufferSize(500) | setResourceTimingBufferSize(200) | 扩大缓冲区防条目丢弃                                                                                                 |
| 监测 checkAccess.json 耗时       | fetchPerfPing 探测请求           | preload 中并行发起真实 fetch, 从 resource 条目中按 URL 匹配采集耗时                                                  |
| PluginPerf.markWithEntry         | report 函数                      | 统一事件格式 p1/c1-c5/p4                                                                                             |

接入点分布:

- src/main.tsx: 入口最早时机调用 initPerfMonitor 启动长任务监听, 并打 swr-boot-start (该点每轮实验前被 resetBootMarks 清除, 实际参与 measure 的起点是 run 内重打的点)
- src/swr.ts 的 preload: 并行发起 perf-ping 探测请求, 模拟 boot.ts 中被单独监测的登录校验接口
- src/App.tsx 的 run: 每轮实验前 resetBootMarks 清除旧打点, SWR 组数据就绪时打 swr-boot-end 并调用 collectAndReport, 采集结果渲染为页面底部的监控面板

实测输出 (本地 dev 环境) : 启动总耗时约 883ms, 即最慢网络请求的等待时间 (800ms 基础延迟加至多 200ms 随机) , 100ms 模拟 mount 延迟与网络请求并行而被覆盖; perf-ping 探测请求约 25ms, 启动期间捕获 1 个长任务 (React 首次渲染) , PERF_QUEUE 单轮上报 3 条 (每长任务 1 条 main-thread-blocking, 加 swr-demo-boot 与 performance-index 各 1 条; 队列不清空, 多轮运行会累计) . 控制台可见 main-thread-blocking、swr-demo-boot、performance-index 三类事件, 与 boot.ts 的上报结构一致.

要点: 这套监控和手写 SWR 体现的是同一个工程判断, 在存量约束下, 用最小的自研代码精准采集业务真正关心的指标, 比引入通用重型方案更合适; 两者的公共底座都是浏览器原生能力 (Performance API、promise、全局挂载) , 这也是它们能在任何技术栈里工作的原因.

### 7. 一句话总结

手写 SWR 的本质是把"接口数据预加载"从框架生命周期里解放出来: 用 header 内联脚本让请求与 bundle 下载并行, 用 promise 挂载实现跨组件请求去重, 用 result 缓存加后台刷新实现零等待的二次消费. 在大型存量 MPA 项目里, 它以约 0.5 KB 的体积、零框架依赖、单页面粒度的渐进接入成本, 拿到了 vercel/swr 这类 hook 库在该架构下拿不到的收益, 是典型的"约束驱动选型"案例.
