---
title: "Vite 8 与现代前端构建"
description: "Vite 8 的 dev server、依赖预构建、HMR 原理、Rolldown/Oxc/Lightning CSS 工具链、生产构建与代码分割、插件体系、环境变量与 mode、Monorepo 与库模式, 以及与 Webpack 的原理对比"
---

这份文档面向负责前端工程化的工程师: 需要为自己的项目选构建工具、排查 dev 启动与 HMR 的异常、设计生产构建的代码分割与缓存策略. 内容以 Vite 8 为基准, 讲清每个机制背后的原理与边界, 而不是罗列配置项. 框架层面的渲染与数据获取见 [Next.js](next), 运行时机制见 [React](react).

## 开发态为什么快

### 打包时机的差异

Webpack 的开发服务器是"先打包再启动": 扫描全部依赖、构建完整模块图、转译打包成 bundle, 再启动服务. 成本随模块数增长.

Vite 是"先启动再按需编译": 启动时几乎不做打包, 浏览器请求某个模块时才实时转译该模块并返回原生 ESM.

```text
Webpack dev:
  源码 ──> 全量扫描 ──> 构建依赖图 ──> 转译打包 ──> 启动服务器
  |________________ O(模块数) ________________|

Vite dev:
  启动服务器 (几乎无打包)
      |
      v
  浏览器请求模块 ──> 转译该模块 ──> 返回 ESM
  浏览器请求模块 ──> 转译该模块 ──> 返回 ESM
  |__________ 按需编译, 冷启动接近 O(1) __________|
```

这个差异的根基是浏览器已经原生支持 ES Module. 在原生 ESM 下, `import` 由浏览器自己去解析和发起请求, 构建工具不需要预先算出整个依赖图.

### 三个来源

冷启动快由三件事共同实现.

第一, 依赖预构建. `node_modules` 里的第三方依赖被一次性打包成 ESM 并缓存, 二次启动直接读缓存. 这一步把大量小文件合并成少数文件, 也把 CJS/UMD 统一成浏览器可消费的格式.

第二, 源码按需转译. 业务代码只在被请求时才转译, 并且会带上缓存信息, 未修改的模块走协商缓存.

第三, HMR 粒度小. 改一个文件只需要让浏览器重新请求该模块, 不需要重算整张依赖图.

### 快也有的边界

按需编译的代价是首屏可能产生大量模块请求. 深层依赖链的页面首次打开时, 浏览器要一层层发现并请求模块, 形成请求瀑布, 这在弱网或大量小模块的项目上反而可能比"一次打包"更慢. 缓解手段是 `server.warmup` 预热高频入口模块, 以及拆解 barrel 文件避免一次导入拉起几百个模块.

另外, 开发态与生产态的差距只在开发体验上. 生产构建两者都要完整打包, 差距主要来自工具链本身的性能.

## 依赖预构建 optimizeDeps

### 目的

Vite 启动时用打包器把裸模块导入 (bare import, 例如 `import React from "react"`) 涉及的依赖打包成 ESM, 输出到缓存目录. 目的有两个:

- 格式统一: 很多包只发布 CJS 或 UMD, 浏览器无法直接消费, 预构建统一转为 ESM.
- 请求合并: 内部由几百个小模块组成的包 (例如按模块拆分的工具库) 如果不合并, 一次导入会触发几百个 HTTP 请求.

预构建产物同时被 dev server 与生产构建复用, 因此它是构建管线的一部分, 不是 dev 专属的补丁.

### 缓存失效

以下情况会自动触发重新预构建: 包管理器 lockfile 内容变化、补丁目录时间戳变化、配置中相关字段变化、环境变量变化. 也可以显式强制: 命令行 `--force`, 或配置 `optimizeDeps.force`, 或直接删除缓存目录.

### 关键选项

| 选项                | 作用                                             | 使用时机                                                         |
| ------------------- | ------------------------------------------------ | ---------------------------------------------------------------- |
| `include`           | 强制预构建指定依赖                               | 动态导入或条件导入导致扫描遗漏时                                 |
| `exclude`           | 排除某些依赖不预构建                             | 该依赖本身已是 ESM, 或需要走特殊插件                             |
| `noDiscovery`       | 关闭扫描, 只预构建 `include` 中的依赖            | 依赖集合完全已知, 追求确定性                                     |
| `holdUntilCrawlEnd` | 冷启动时等静态导入扫描完再产出, 避免二次全页刷新 | 默认开启; 依赖可枚举时关掉可让浏览器更早并行请求                 |
| `needsInterop`      | 强制对指定依赖做 ESM 互操作                      | 包自称 ESM 但内部使用 `require`, 或 `exports` 配置不规范的遗留包 |
| `rolldownOptions`   | 传给预构建打包器的选项                           | 需要定制预构建行为时                                             |

### 常见问题

运行时才发现的新依赖是最影响体验的一类: 首次扫描没有发现某个依赖, 页面运行到某处才触发预构建, 随之而来的是整页刷新. 根因通常是动态 `import()` 或运行时拼接的导入路径. 解决办法是把这些依赖显式写进 `include`.

CJS/ESM 互操作是第二类. 某些包对 `default` 导出的处理与打包时代不同, 症状是 `xxx.default is not a function`. 需要理解当前规则: 对 CJS 模块做 `default` 导入时, 当导入方是 `.mjs`/`.mts`、或最近的 `package.json` 声明 `type: "module"`、或被导入模块的 `__esModule` 标记不为真时, `default` 就是模块导出对象本身; 否则取导出对象的 `default` 字段. 不一致时用 `needsInterop`, 或改写导入方式, 或推动上游修复 `exports`.

Monorepo 内部包是第三类. workspace 链接的内部包默认视为源码、跳过预构建; 如果它是 CJS 产物就会报错, 需要加入 `include`. 注意 `build.commonjsOptions` 在当前版本已是空操作, 不需要再同步配置.

模块联邦类插件还会遇到第四类: shared 依赖如果逐个触发预构建, 每次都会走一遍完整流程, shared 数量一多耗时明显上升. 把多个 shared 依赖合并进一次预构建调用, 是这类插件的常见优化点.

## HMR 原理

### Vite 的流程

1. 服务端维护模块依赖图. 文件变更后, 只把受影响的模块节点标记为失效.
2. 通过 WebSocket 通知浏览器哪些模块需要更新.
3. 浏览器用带时间戳的 URL 重新发起 `import()`, 天然绕过 HTTP 缓存.
4. 更新沿着导入链向上传播, 直到某个模块声明自己接受这次更新 (accept 边界).

边界通常由框架插件注入: React 项目由 React Refresh 提供组件级热替换并在可能时保留组件状态, Vue 单文件组件同理. 没有声明边界的模块会一路传播到入口, 最终退化为整页刷新.

### 与 Webpack HMR 的对比

| 维度           | Webpack HMR                      | Vite HMR                   |
| -------------- | -------------------------------- | -------------------------- |
| 更新单位       | chunk 的增量产物                 | 单个 ESM 模块              |
| 变更后动作     | 增量编译并生成更新清单与新 chunk | 直接让浏览器重新请求该模块 |
| 依赖图         | 构建期产物                       | dev server 内存中的模块图  |
| 耗时随项目规模 | 明显增长                         | 基本无关                   |
| 缓存绕过       | 依赖 runtime 的模块替换          | URL 上的时间戳查询参数     |

本质差异是"重新打包受影响的部分"与"重新请求单个模块".

### 排查 HMR 失效

三类原因覆盖了绝大多数情况: 变更模块到边界之间存在缺失的 accept 声明; 出现了循环依赖, 导致边界查找失败并退化为整页刷新; 导出不符合框架刷新约束, 例如 React Refresh 要求文件只导出组件, 混入普通函数或常量会让边界失效.

## Vite 8 的工具链分工

Vite 8 的构建管线由一套 Rust 工具接管, 从依赖预构建到生产打包共用一个打包引擎.

| 组件            | 职责                     | 备注                                                                           |
| --------------- | ------------------------ | ------------------------------------------------------------------------------ |
| Rolldown        | dev 依赖预构建与生产打包 | 负责 Tree Shaking、代码分割与产物格式; 插件接口与 Rollup 高度兼容              |
| Oxc Transformer | JS/TS/JSX 转换与语法降级 | `build.target` 最终传给它                                                      |
| Oxc Minifier    | JS 压缩                  | 客户端构建默认使用                                                             |
| Lightning CSS   | CSS 压缩与目标语法降级   | `build.cssMinify` 默认使用; CSS 转换引擎默认仍为 PostCSS                       |
| esbuild         | 可选 peer 依赖           | 只有插件调用 `transformWithEsbuild`, 或显式选择 esbuild 作为压缩器时才需要安装 |

配置入口: 生产打包配置入口是 `build.rolldownOptions`, 依赖预构建是 `optimizeDeps.rolldownOptions`, worker 构建对应 `worker.rolldownOptions`.

`build` 与 `build.minify` 的默认值可以直接从类型定义读出: `build.target` 默认 `'baseline-widely-available'`, 对应 2026-01-01 纳入 Baseline Widely Available 的浏览器版本范围; `build.minify` 在客户端构建默认 `'oxc'`, 在 SSR 构建默认 `false`, 可选 `'oxc' | 'terser' | 'esbuild'`, 选后两者需要自行安装依赖; `build.cssMinify` 默认 `'lightningcss'`.

还有两处需要留意:

- 原生装饰器等少数语法暂不支持向下转换, 需要 Babel 或 SWC 插件补足.
- 多环境构建的 Environment API 已经可用: 每个环境 (client、ssr 或自定义) 拥有独立的模块图、配置与插件容器, 通过顶层 `environments` 声明; 生产侧用 `createBuilder()` 得到 `ViteBuilder`, 由 `builder.buildApp()` 统一编排各环境的构建, `builder.build(environment)` 单独构建一个环境, `sharedConfigBuild`/`sharedPlugins` 可让多环境共享配置与插件实例以对齐 dev server 的行为. 但它内部仍有一部分子 API 标注为实验性, 例如按环境触发的文件变更钩子.

此外, `server` 侧的"完整打包模式"仍处于高度实验阶段 (`experimental.bundledDev`, 命令行对应 `--experimental-bundle`). 它的 HMR 语义与默认的按需编译不同, 不适合在生产项目上默认开启, 但值得关注: 它针对的正是按需编译在超大项目上的模块请求瀑布问题.

## 生产构建

### Tree Shaking

Tree Shaking 依赖 ESM 的静态结构: `import`/`export` 必须出现在顶层且不能动态拼接, 打包器因此能在编译期判断每个导出是否被使用. CJS 的 `require` 是运行时行为, 无法静态分析, 因此 CJS 模块基本不可摇.

两个标记决定优化效果. 一是导出使用情况, 打包器据此标出未使用的导出, 在压缩阶段删除. 二是 `sideEffects` 声明: `"sideEffects": false` 允许打包器跳过未被引用的整个模块, 即使它被 `import`; 而 CSS 等有副作用的资源必须显式保留 (`"sideEffects": ["*.css"]`), 否则样式会被误删.

常见失效场景:

| 写法                               | 后果                             | 修正                          |
| ---------------------------------- | -------------------------------- | ----------------------------- |
| 引入 CJS 产物                      | 整个包进产物                     | 改用 ESM 版本或子路径导入     |
| 模块顶层执行函数调用或修改全局对象 | 打包器无法证明删除安全, 保守保留 | 用 `/*#__PURE__*/` 标注纯调用 |
| 层层重导出的桶文件                 | 显著降低摇树效果并拖慢构建       | 直接从具体子路径导入          |
| Babel 未设置 `modules: false`      | ESM 被提前转成 CJS, 摇树直接失效 | 保留 ESM 交由打包器处理       |
| 装饰器等转译产物带副作用           | 相关 helper 无法删除             | 检查 helper 是否标记 PURE     |

### 代码分割

分割点有三个来源: 多入口、动态 `import()` (最主要的手段)、公共依赖提取.

手动分组通过打包器的声明式配置完成:

```typescript
build: {
  rolldownOptions: {
    output: {
      codeSplitting: {
        groups: [
          { test: /[\\/]node_modules[\\/](react|react-dom)[\\/]/, name: "framework" },
          { test: /[\\/]node_modules[\\/](echarts|zrender)[\\/]/, name: "charts" },
          { test: /[\\/]node_modules[\\/]/, name: "vendor" },
        ],
      },
    },
  },
}
```

设计原则有三条. 按变更频率分层: 框架、工具库、业务代码, 变更越慢的越应独立成 chunk, 配合内容哈希实现长效缓存. 控制 chunk 数量与大小的平衡: 太碎增加请求与调度开销, 太大则一次改动就让整块缓存失效. 路由级异步页面独立分割, 首屏只加载框架与当前页面.

配置上有两点约束值得记住: 手动分组统一用 `output.codeSplitting.groups`; 分组会把模块在 chunk 之间移动, 容易产生输出层的循环引用, 因此分组边界应当顺着依赖方向切. 分组会递归捕获其依赖, 可以用 `codeSplitting.includeDependenciesRecursively: false` 关闭这一行为.

### 目标与兼容

浏览器目标由 `build.target` 控制, 默认值直接对齐 Baseline Widely Available, 因此大多数项目不需要自定义. 需要支持更老浏览器时显式覆盖.

注意 Vite 不读 `browserslist`: 它是构建工具的转换目标, 而 autoprefixer 等工具的浏览器范围来自 `browserslist` 配置, 两者需要手动保持一致, 否则会出现"语法降级了但 CSS 前缀没加"这类错配.

语法降级与 polyfill 要分开考虑: 语法降级由转换器完成, API 缺失需要 polyfill. 现代/传统双产物的方案仍然可用, 但要注意 plugin-legacy 的转换下限是 ES2015, 不支持 ES5 及以下的语法层级.

### 产物体积

按收益排序的处理顺序是: 依赖治理 (识别并替换体积异常的库、把多版本收敛到单版本)、路由级按需加载、保证 Tree Shaking 有效、开启压缩与传输层压缩 (内容编码通常比再压一遍 JS 更划算)、图片与字体优化.

## 插件体系

### 钩子与执行顺序

Vite 插件同时可以扩展 dev server 与打包器, 因此既有打包器风格的转换钩子, 也有 dev server 专属钩子.

插件调用顺序是固定的: 别名解析、`enforce: 'pre'` 插件、Vite 核心插件、普通插件、Vite 构建插件、`enforce: 'post'` 插件、Vite 构建后置插件. 单个钩子内部还可以用 `order` 属性细分.

dev 相关的高频钩子是: `configureServer` (注入中间件)、`configurePreviewServer` (预览服务注入中间件)、`transformIndexHtml` (改写入口 HTML)、`handleHotUpdate` / 文件变更钩子 (干预 HMR). 构建相关的是 `transform`、`generateBundle`、`closeBundle`.

### 一个真实的自定义插件

下面这个插件把入口 HTML 里的样式与模块脚本标记为高优先级, 同时增加两个开发期中间件端点与两个静态产物:

```typescript
function fetchPriorityHints(): Plugin {
  return {
    name: "fetch-priority-hints",
    enforce: "post",
    transformIndexHtml(html) {
      return html
        .replace(
          /<link rel="stylesheet"/g,
          '<link rel="stylesheet" fetchpriority="high"',
        )
        .replace(
          /<script type="module" crossorigin/g,
          '<script type="module" crossorigin fetchpriority="high"',
        );
    },
  };
}

function endpoints(): Plugin {
  let base = "/";
  return {
    name: "endpoints",
    configResolved(config) {
      base = config.base;
    },
    configureServer(server) {
      server.middlewares.use(handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler);
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "file.txt", source: "content" });
    },
  };
}
```

这段代码说明三件事: `enforce: 'post'` 保证在核心插件处理完 HTML 之后才改写; dev 与 preview 是两套服务器, 想要一致行为需要分别注入中间件; `configResolved` 拿到的最终解析结果 (例如 `base`) 应当通过闭包传给钩子, 而不是在钩子里重复推导. 生产环境下另一个常见做法是用 `generateBundle` 直接产出静态文件, 让不方便按请求分支的托管环境也能拿到同样的内容.

### 常用插件

| 插件                            | 解决的问题                               |
| ------------------------------- | ---------------------------------------- |
| 框架插件 (React / Vue / Svelte) | 转译 JSX 或单文件组件, 注入 HMR 边界     |
| CSS 方案插件 (Tailwind 等)      | 接入对应 CSS 处理链, 参与 HMR 与生产压缩 |
| 传统浏览器兼容插件              | 产出带 polyfill 的降级产物               |
| 产物分析插件                    | 输出模块体积构成, 定位大依赖             |
| 压缩增强插件                    | 生成 gzip/brotli 产物或做更激进的压缩    |
| 校验类插件                      | 在 dev 与 build 阶段运行类型检查或 lint  |

## 环境变量与 mode

Vite 内置 dotenv 支持, 按 mode 加载 `.env`、`.env.local`、`.env.[mode]` 等文件, 并暴露到 `import.meta.env`. 其中 `BASE_URL`、`MODE`、`DEV`、`PROD`、`SSR` 由 Vite 提供, 自定义变量只有带 `envPrefix` (默认 `VITE_`) 前缀的才会暴露给客户端代码, 前缀可以用配置改写.

前缀机制是安全设计: 服务端密钥即使写在环境变量里, 也不会因为一次误导入而进入客户端产物. 需要替换的常量用 `define` 显式声明.

实践上建议区分两类配置:

- 构建期常量: 展开与否会影响产物内容, 例如是否启用某个功能开关.
- 运行期配置: 会随部署环境变化但不想多次构建, 例如接口域名. 这类配置不要打进 bundle, 改为运行时从全局对象或配置接口读取, 实现一次构建多环境部署.

类型安全则用声明文件补充 `ImportMetaEnv`, 并在应用入口做一次校验, 让配置缺失在启动时暴露而不是在运行时静默出错.

需要明确的安全底线: 任何进入前端 bundle 的值都是公开的, 密钥类配置只能放在服务端或边缘层.

## Monorepo 与库模式

### 内部包的两种消费方式

源码直连适合应用内的共享包: 包的 `exports` 直接指向源码, 由消费方的构建工具统一转译. 好处是改动即时生效、不需要 watch 构建, 代价是消费方要能处理 TypeScript.

预构建产物适合对外发布的包: 构建出 ESM 加类型声明, 在 `exports` 里为每个子路径声明入口, 消费方按需导入也在子路径级别生效. 需要注意包管理器是否会为了兼容 CJS 再产出一份入口, 如果会, 就要防止解析时命中 CJS 分支——workspace 包是软链接, 默认跳过预构建, 一旦解析到 `.cjs` 入口, 浏览器执行时会因为 `module is not defined` 直接崩溃.

### 工程化配套

- 依赖声明用 workspace 协议, 强制显式声明, 天然防止幽灵依赖.
- 任务编排声明包之间的构建依赖关系, 配合内容哈希缓存, CI 上只重建受影响的包.
- 共享的基础配置 (TypeScript、lint、格式化) 收敛到根目录, 避免各包漂移.
- 依赖版本收敛: 同一依赖出现多个版本时, 除了体积增加, 还可能导致单例被破坏 (例如需要全局唯一的运行时实例).

常见坑与包内直连有关: 内部包引用 CJS 依赖时需要手动加入预构建的 `include`; TypeScript 的路径别名与包 `exports` 需要保持一致, 否则编辑器跳转与实际解析会不同步. 一个更省事的做法是开启配置解析里的 tsconfig 路径支持, 让别名在运行时与类型检查中来自同一份配置.

## 与 Webpack 的对应与取舍

Webpack 体系与 Vite 的概念对应关系如下:

| 概念     | Webpack                     | Vite                                                                |
| -------- | --------------------------- | ------------------------------------------------------------------- |
| 入口     | 配置项或默认 `src/index.js` | 以 `index.html` 为入口                                              |
| 模板注入 | 模板插件                    | `transformIndexHtml` 钩子或插件                                     |
| 批量导入 | `require.context`           | `import.meta.glob` (默认返回懒加载函数, 需要同步时传 `eager: true`) |
| 环境变量 | 编译期字符串替换            | `import.meta.env`, 仅特定前缀暴露                                   |
| 中间件   | 自定义 dev server           | `configureServer` 钩子                                              |
| 模块分割 | 分割配置与缓存组            | `output.codeSplitting.groups`                                       |

取舍可以按场景判断:

| 场景                                     | 更合适的选择                                   |
| ---------------------------------------- | ---------------------------------------------- |
| 常规 Web 应用, 重视 dev 启动与 HMR       | Vite                                           |
| 深度依赖 Webpack 生态的既有项目          | 继续 Webpack, 或评估配置兼容度更高的 Rust 方案 |
| 需要在同一套工具里定制极其复杂的打包行为 | 取决于团队对插件接口的熟悉程度                 |
| 对外发布的库                             | 两者都可, 重点是输出格式与类型声明的完备性     |

## 性能与 CI 实践

### 开发与构建性能

先度量再优化. Vite 提供 `--profile` 与 `--debug` 观察预构建与转译耗时; 打包器侧则看分组与摇树的诊断输出.

可用的手段按收益排序:

1. 减少首屏模块请求瀑布: 预热高频入口模块, 拆解桶文件.
2. 保证预构建稳定: 显式声明 `include`, 避免运行时二次预构建导致整页刷新.
3. 关闭不必要的构建期计算: 例如在大项目上关掉产物体积的压缩前后对比统计.
4. 依赖治理: 分析产物构成, 替换或按需引入体积异常的库.
5. 组织级缓存: monorepo 任务缓存让 CI 只构建受影响的包; 产物按内容哈希命名, 未变更的 chunk 直接命中 CDN 缓存.

### CI 中的产物质量关卡

建议把保障分成四层:

- 构建前: 类型检查、lint、单元测试作为前置步骤; 用严格的 lockfile 模式安装依赖, 保证构建可复现.
- 体积: 对关键 chunk 设置体积阈值, 超限则让变更失败; 在评审中输出产物体积差异, 让体积变化可见.
- 运行质量: 对预发环境跑性能基线, 在真实构建产物上做核心路径的冒烟测试. dev 模式通过不代表生产产物没问题, 摇树误删副作用、动态导入路径错误这类问题只在构建后暴露.
- 发布与回滚: 产物先全量上传再切换入口引用, 保证原子发布; 保留旧版本以便快速回滚; 源码映射上传到错误监控平台后从发布产物中剔除.

## 适用场景与选型建议

适合选 Vite 的情形: 以单页应用或可静态部署的站点为主, 重视开发启动与热更新速度; 团队希望配置面小、约定清晰, 把复杂逻辑放进插件; 需要对外发布库并同时产出 ESM 与类型声明; monorepo 内多个包共享同一套构建约定.

不适合或需要额外评估的情形:

- 项目深度依赖 Webpack 特有的 loader/plugin 行为, 切换成本高于收益.
- 需要把一个页面拆成多个独立部署单元、且必须与既有运行时契约严格一致, 这类场景要先确认插件对模块注册与依赖协商的支持程度.
- 对 dev 与 build 的产物一致性有极高要求, 且项目模块数量极大——此时值得评估完整打包模式, 但它在当前仍是实验能力.

无论选哪个工具, 下面三件事的收益通常高于换工具本身: 明确浏览器的支持下限并让所有工具链共享同一份目标; 治理依赖体积与重复版本; 让 CI 对产物体积与运行性能设置可见的门槛. 工具决定的是上限, 这些工程约束决定的是实际结果.
