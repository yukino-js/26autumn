---
title: "前端构建工具与工程化技术笔记 (Vite + Webpack)"
description: "Vite 与 Webpack 核心原理对比: dev 冷启动与按需编译、HMR 机制、Rolldown 构建、代码分割与 Tree Shaking、Monorepo 与工程化实践"
---

## 一、构建工具核心原理

### Vite 为什么比 Webpack 快? dev 冷启动的本质区别是什么?

本质区别是打包时机: Webpack 是"先打包再启动", Vite 是"先启动再按需编译".

```
Webpack dev 模式:

  源码 ──> 全量扫描 ──> 构建依赖图 ──> 转译/打包 ──> bundle ──> 启动服务器
  |___________________ O(模块数) ___________________|
  项目越大, 启动越慢

Vite dev 模式:

  启动服务器 (几乎无打包)
       |
       v
  浏览器请求 /src/App.vue ──> 实时转译该模块 ──> 返回 ESM
  浏览器请求 /src/util.ts ──> 实时转译该模块 ──> 返回 ESM
  |___________ 按需编译, 冷启动接近 O(1) ___________|
```

Webpack dev 启动时要扫描所有依赖、构建完整依赖图、全量转译打包成 bundle, 项目越大启动越慢, 复杂度是 O(模块数). Vite 利用浏览器原生 ES Module 支持, 启动时不做打包, 只在浏览器请求某个模块时实时转译该模块返回, 冷启动接近 O(1).

Vite 快的三个关键点:

1. 依赖预构建: node_modules 中的 CJS/UMD 依赖被一次性转为 ESM, 缓存在 node_modules/.vite/deps, 二次启动直接读缓存; 该步骤由 Rust 编写的 Rolldown 完成.
2. 源码按需转译: 业务代码只在被请求时转译, 配合 HTTP 304 协商缓存, 未修改的模块不重复处理.
3. HMR 粒度小: 修改一个模块只需重新请求该模块的 ESM, 不需要重新计算整个依赖图 (详见「Webpack HMR 和 Vite HMR 的实现原理有何不同?」).

需要说明的边界: Vite dev 模式下首屏可能产生大量模块请求 (瀑布流), 深层依赖链的页面首次打开反而可能变慢, Vite 通过预构建合并依赖、`server.warmup` 预热高频模块来缓解. 生产构建两者都要完整打包, 差距主要在开发体验.

在模块数量大的项目上这种差异会被放大, 冷启动与 HMR 的耗时通常相差一个数量级, 具体幅度取决于模块数量、依赖预构建的缓存命中情况与机器性能.

### Webpack 的完整构建流程是怎样的? Loader 和 Plugin 的区别?

```
  初始化              编译 (make)              封装 (seal)           产出 (emit)
+------------+    +------------------+    +------------------+    +----------------+
| 合并配置   |    | entry 出发       |    | 拆分 Chunk       |    | 渲染最终代码   |
| 创建       |───>| Loader 链转译    |───>| Tree Shaking     |───>| 注入 runtime   |
| Compiler   |    | acorn 解析 AST   |    | SplitChunks      |    | 写入文件系统   |
| 注册 Plugin|    | 递归构建模块图   |    | Scope Hoisting   |    |                |
+------------+    +------------------+    +------------------+    +----------------+
```

完整流程:

1. 初始化: 合并 CLI 参数与配置文件, 创建 Compiler 实例, 注册所有 Plugin (Plugin 在此时通过 `apply(compiler)` 挂钩子).
2. 编译 (make): 从 entry 出发, 对每个模块调用匹配的 Loader 链转译, 再用 acorn 解析 AST 提取 import/require 依赖, 递归处理直到构建出完整的 Module Graph.
3. 封装 (seal): 根据入口和动态导入拆分 Chunk, 生成 Chunk Graph; 执行 Tree Shaking、SplitChunks、Scope Hoisting 等优化.
4. 产出 (emit): 用模板将 Chunk 渲染为最终代码 (注入 webpack runtime), 写入文件系统.

Loader 和 Plugin 的区别:

- Loader 是文件转换器: 输入源文件内容, 输出 JS 可理解的模块, 纯函数、链式执行 (从右到左), 只作用于模块加载阶段. 如 ts-loader、css-loader.
- Plugin 是流程扩展器: 基于 Tapable 的事件钩子系统, 可以介入从初始化到产出的任意阶段 (compiler hooks / compilation hooks), 能修改产物、注入资源、控制流程. 如 HtmlWebpackPlugin、DefinePlugin.

一句话概括: Loader 解决"这个文件怎么变成模块", Plugin 解决"整个构建过程中我要做什么".

### Vite 8 的构建引擎如何分工? Rolldown、Oxc 与 Lightning CSS 各做什么?

Vite 8 的构建管线由一套 Rust 工具链接管, 官方迁移指南的表述是 "Vite 8 uses Rolldown and Oxc based tools instead of esbuild and Rollup". 本机 `$HOME/github/yukino-chatbot` 的 pnpm-lock.yaml 解析出 vite@8.3.1, 它声明的 dependencies 是 `rolldown`、`lightningcss`、`postcss`、`picomatch`、`tinyglobby`, 不含 rollup.

各组件职责:

- Rolldown (打包器): dev 的依赖预构建与生产打包共用这一个引擎, 负责完整 bundle、Tree Shaking、代码分割与产物格式输出. 手动分割由声明式的 `output.codeSplitting.groups` 提供 (见「代码分割怎么做?」). Vite 插件 API 建立在 Rolldown 插件接口之上, 后者与 Rollup 插件接口高度兼容.
- Oxc Transformer (转译): JS/TS/JSX 的转换与语法降级, `build.target` 传下去的正是 Oxc 的 target 选项; 顶层 `esbuild` 配置项会自动转换为 `oxc` (可转换字段见迁移指南). 原生装饰器暂不支持下探, 需要 Babel/SWC 插件补足.
- Oxc Minifier (JS 压缩): `build.minify` 类型为 `boolean | 'oxc' | 'terser' | 'esbuild'`, 客户端构建默认 `'oxc'`, SSR 构建默认 `false`; 选 `'terser'` 或 `'esbuild'` 需要自行安装对应依赖.
- Lightning CSS (CSS 压缩): `build.cssMinify` 类型为 `boolean | 'lightningcss' | 'esbuild'`, 默认 `'lightningcss'`; 选 `'esbuild'` 需要自行安装 esbuild.
- esbuild: 不是 Vite 的运行时依赖, 而是可选 peerDependency (vite@8.3.1 的 `peerDependenciesMeta` 标记 `esbuild: { optional: true }`); 只有插件调用 `transformWithEsbuild`, 或配置 `build.minify: 'esbuild'` / `build.cssMinify: 'esbuild'` 时才需要自行安装. 官方推荐把 `transformWithEsbuild` 迁到 `transformWithOxc`.

与之配套, 依赖预构建的 `optimizeDeps.esbuildOptions` 会转换为 `optimizeDeps.rolldownOptions`.

另外, 为不同运行环境提供独立模块图与配置的 Environment API, 在 Vite 8 文档中标注为 Release Candidate: 大版本之间承诺保持 API 稳定, 但仍有部分具体 API 属于实验性, 完全稳定化计划在未来某个大版本完成.

### Vite 依赖预构建 (optimizeDeps) 的原理是什么? 遇到过哪些坑?

原理: Vite 启动时扫描源码中的裸模块导入 (bare import, 如 `import React from 'react'`), 用 Rolldown 将这些 node_modules 依赖打包成 ESM 并输出到 node_modules/.vite/deps. 目的有两个:

1. 格式统一: 很多包只发布 CJS/UMD, 浏览器 ESM 无法直接消费, 预构建统一转为 ESM.
2. 请求合并: 像 lodash-es 这种包内部有几百个小模块, 不合并的话一次导入会触发几百个 HTTP 请求, 预构建合并为单文件.

缓存失效条件: 包管理器 lockfile 内容变更、patches 目录修改时间变更、vite.config 中相关字段变更、`NODE_ENV` 变更时自动重新预构建; 也可用 `--force` 命令行参数 (或 `optimizeDeps.force`) 强制重跑, 或直接删除 node_modules/.vite 缓存目录.

实际踩过的坑:

1. 运行时才发现的新依赖: 动态 import 的依赖在首次扫描中漏掉, 运行时触发"new dependencies optimized"并整页 reload, 体验很差. 解决: 用 `optimizeDeps.include` 显式声明.
2. CJS/ESM 互操作: 某些包的 `exports` 字段配置不规范, 预构建后 default 导出行为与 Webpack 下不一致 (`esModuleInterop` 差异), 需要 `optimizeDeps.needsInterop` (实验选项, 强制对指定依赖做 ESM interop) 或让包方修复. 当前的 CJS 互操作规则在 dev 与 build 之间统一: 对 CJS 模块的 `default` 导入, 当导入方是 `.mjs`/`.mts`、或最近 `package.json` 的 `type` 为 `module`、或被导入 CJS 的 `module.exports.__esModule` 不为 `true` 时, `default` 即 `module.exports` 本身, 否则取 `module.exports.default` (见 Rolldown 文档 "Ambiguous default import from CJS modules").
3. monorepo 内部包: workspace 链接的内部包默认不做预构建 (被视为源码), 如果内部包是 CJS 产物就会报错, 需要将其加入 `optimizeDeps.include`; `build.commonjsOptions` 在当前 Vite 中是 no-op, 不需要再同步配置.
4. 模块联邦场景: shared 依赖如果逐个触发 optimizeDeps, 预构建会被重复执行, shared 数量一多耗时就明显上升; 把多个 shared 依赖合并进一次预构建调用, 是这类插件常见的优化点.

### Webpack HMR 和 Vite HMR 的实现原理有何不同?

Webpack HMR:

1. dev server 通过 WebSocket 与浏览器保持连接, 文件变更后增量编译, 生成 manifest (变更清单) 和更新 chunk.
2. 浏览器端的 HMR runtime 收到 hash 通知, 拉取 manifest 和新 chunk, 替换模块缓存中的旧模块.
3. 沿模块父链向上查找 `module.hot.accept` 边界, 找到则执行 accept 回调局部更新, 找不到则整页刷新.

关键点: Webpack HMR 的更新单位是 chunk, 即便只改一个模块也要重新构建它所在 chunk 的增量产物, 且需要遍历受影响的模块链, 项目越大越慢.

Vite HMR:

1. 基于原生 ESM, 服务端维护模块依赖图 (ModuleGraph), 文件变更后只 invalidate 该模块节点.
2. 通过 WebSocket 通知浏览器, 浏览器用带时间戳的 URL 重新 `import()` 该模块 (`/src/App.tsx?t=1234`), 天然绕过缓存.
3. HMR 边界由框架插件注入 (如 @vitejs/plugin-react 的 react-refresh), Vue SFC 和 React 组件都能做到组件级热替换且保留状态.

本质差异: Webpack 是"重新打包受影响的部分", Vite 是"重新请求单个 ESM 模块", 所以 Vite 的 HMR 耗时与项目规模基本无关.

排查 HMR 失效的思路 (两个工具通用): 确认变更模块到边界之间没有被 `accept` 遗漏; 检查循环依赖 (会导致边界查找失败退化为整页刷新); 检查导出是否满足框架刷新约束 (如 react-refresh 要求文件只导出组件).

### Tree Shaking 的原理是什么? 哪些写法会导致失效?

原理: 基于 ESM 的静态结构. ESM 的 import/export 必须出现在顶层且不可动态拼接, 构建工具因此能在编译期静态分析出每个导出是否被使用, 未使用的导出标记为 unused, 在压缩阶段由 DCE (Dead Code Elimination) 删除. CJS 的 `require` 是运行时行为, 无法静态分析, 所以 CJS 模块基本不可 shake.

两层机制配合:

1. usedExports (Webpack) / Rolldown 的导出追踪: 标记哪些导出被使用.
2. sideEffects: package.json 中声明包是否有副作用. `"sideEffects": false` 允许构建工具跳过未被引用的整个模块, 即使它被 import 过 (如 `import 'x'`). CSS 导入必须声明为副作用 (`"sideEffects": ["*.css"]`), 否则样式会被误删.

常见失效场景:

1. 引入 CJS 产物: 如 lodash (CJS) 全量进包, 改用 lodash-es 或 `lodash/xxx` 单文件导入.
2. 副作用代码: 模块顶层执行了函数调用、修改了全局对象, 构建工具无法证明删除安全, 保守保留. 可用 `/*#__PURE__*/` 注释标记纯调用.
3. 重导出桶文件 (barrel file): `export * from './a'` 层层聚合, 配合副作用不明的包会显著降低 shake 效果, 还拖慢构建.
4. Babel 配置错误: `@babel/preset-env` 未设置 `modules: false` 时会把 ESM 提前转成 CJS, 直接废掉 Tree Shaking.
5. 类的静态属性、装饰器等转译产物带副作用, 需要检查 helper 是否标记了 PURE.

验证手段: `webpack --stats` 看 usedExports、Rolldown 的 `treeshake` 日志、用 rsdoctor / webpack-bundle-analyzer 对比前后产物.

### 代码分割怎么做? splitChunks 和 codeSplitting 的策略如何设计?

代码分割的三个来源: 多入口、动态 `import()` (最主要手段, 天然分割点)、公共依赖提取.

Webpack splitChunks 的设计思路:

```javascript
optimization: {
  splitChunks: {
    chunks: "all", // 同步和异步模块都参与分割
    cacheGroups: {
      // 高频基础库单独成 chunk, 版本稳定, 缓存命中率最高
      framework: {
        test: /[\\/]node_modules[\\/](react|react-dom|react-router)[\\/]/,
        name: "framework",
        priority: 40,
      },
      // 体积大且低频变更的库 (如 echarts) 独立拆出, 避免污染公共 chunk
      charts: {
        test: /[\\/]node_modules[\\/](echarts|zrender)[\\/]/,
        name: "charts",
        priority: 30,
      },
      // 其余第三方依赖
      vendor: {
        test: /[\\/]node_modules[\\/]/,
        name: "vendor",
        priority: 10,
      },
    },
  },
}
```

核心原则:

1. 按变更频率分层: 框架 > 工具库 > 业务代码, 变更频率越低的层越应该独立成 chunk, 配合 contenthash 实现长效缓存.
2. 控制 chunk 数量与大小的平衡: chunk 太碎增加请求数与调度开销, 太大则缓存失效代价高. 经验值是单 chunk 压缩后 100-200KB 量级, 配合 HTTP/2 多路复用可以适当更碎.
3. 异步路由页独立分割: 路由级 `React.lazy(() => import(...))`, 首屏只加载框架 + 首页 chunk.

Vite 8 的对应能力是 Rolldown 的声明式 `output.codeSplitting.groups`, 用 `test` 正则与 `name` 分组:

```typescript
build: {
  rolldownOptions: {
    output: {
      codeSplitting: {
        groups: [
          // 高频基础库单独成 chunk, 版本稳定, 缓存命中率最高
          {
            test: /[\\/]node_modules[\\/](react|react-dom|react-router)[\\/]/,
            name: "framework",
          },
          // 体积大且低频变更的库 (如 echarts) 独立拆出, 避免污染公共 chunk
          {
            test: /[\\/]node_modules[\\/](echarts|zrender)[\\/]/,
            name: "charts",
          },
          // 其余第三方依赖
          { test: /[\\/]node_modules[\\/]/, name: "vendor" },
        ],
      },
    },
  },
}
```

注意点: 手动分组会把模块在 chunk 之间移动, 容易产生输出层的循环引用, 需要保证分组边界与依赖方向一致. Rolldown 会为使用了 `groups` 的构建强制生成一个只含加载与执行运行时的 `runtime.js` chunk, 保证运行时先于其他 chunk 执行; 分组还会递归捕获其依赖 (可用 `codeSplitting.includeDependenciesRecursively: false` 关闭), 这些机制兜底执行顺序, 但不改变"分组要顺着依赖方向切"的原则.

当前 Vite 的 Rolldown 接口事实:

- 打包配置入口是 `build.rolldownOptions` (对应 worker 构建的 `worker.rolldownOptions`), 类型为 RolldownOptions.
- 手动分割优先用 `output.codeSplitting.groups`; `output.manualChunks` 的对象写法不支持, 函数写法仍可用.
- `output.format` 可用 `'es'`、`'cjs'`、`'umd'`、`'iife'`; `'system'` 与 `'amd'` 不可用.
- `shouldTransformCachedModule`、`resolveImportMeta`、`renderDynamicImport`、`resolveFileUrl` 等 Rollup 插件钩子在 Rolldown 中不可用; 所有并行钩子按顺序执行.
- 解析 AST 的现行函数是 `parseSync`/`parse`; `parseAst`/`parseAstAsync` 带废弃标记, 不是推荐入口.
- 依赖 `transformWithEsbuild` 的插件需自行安装 esbuild, 推荐改用 `transformWithOxc`.
- `@vitejs/plugin-legacy` 只支持转译到 ES2015 及以上, 不再支持 ES5 及以下.

### Source Map 有哪些类型? 生产环境如何选择与管理?

Webpack devtool 的常见取值本质是三个维度的组合: 是否独立文件、是否含列信息、是否含源码内容.

- 开发环境: `eval-cheap-module-source-map` -- 重建速度快, 能映射到 loader 处理前的源码, 行级定位够用.
- 生产环境: `hidden-source-map` -- 生成完整独立 .map 文件但不在 bundle 末尾追加 sourceMappingURL 注释, 浏览器无法发现, 专供错误监控平台还原堆栈.
- 不推荐: 生产直接用 `source-map` (源码泄漏风险)、`eval` 系列上生产 (产物含 eval, CSP 不允许).

Vite 对应 `build.sourcemap: true | 'hidden' | 'inline'`, 语义一致.

生产 Source Map 的管理在 yukino-sentry 监控 SDK 里有一条完整实现:

1. 构建期: yukino-sentry/client/vite.config.ts 用 `build.sourcemap: 'hidden'` 生成不带 sourceMappingURL 注释的 map, 再由自定义插件 `moveSourcemaps` 在 `closeBundle` 阶段把所有 .map 移到 dist/.sourcemaps, 不随站点发布, 线上只有压缩代码.
2. 还原期: SDK 用 `source-map` 包的 `SourceMapConsumer` 做位置还原. `sentry/src/source-map/source-map.ts` 的 `resolveFrame()` 调用 `consumer.originalPositionFor({ line, column })` 得到原始文件与行列号 (浏览器行列号是 1-based, sourcemap 列号是 0-based, 代码里做了 `column - 1` 换算), 再用 `sourceContentFor` 取源码片段; `server/src/source-map.ts` 用同一套 `SourceMapConsumer` 在服务端还原上报堆栈.
3. 开发期: `@yukino.js/sentry/vite` 导出的是 `serve` 阶段插件 (`sentryPlugin`), 它启动一个 mock 上报端点, 并用 Vite dev server 内存 module graph 里的 sourcemap 直接还原上报帧 (`sentry/src/source-map/vite.ts` 的 `enrichReportData`), 与生产链路复用同一个 `resolveFrame`.

这套方案的诉求是两条: 线上不泄漏源码, 同时错误堆栈可还原.

---

## 二、工程化实践

### Webpack 和 Vite 的模块联邦有什么本质差异?

```
  Host (消费方)                          Remote (提供方)
+---------------------+              +---------------------+
| import('remote/App')|              | remoteEntry.js      |
|        |            |   运行时     |   |                 |
|        v            |   加载       |   v                 |
| MF Runtime 协商     |<────────────>| 暴露 ./App 模块     |
| shared 版本匹配     |              | shared 声明         |
+---------------------+              +---------------------+
         |                                    |
         +──────── shared scope ──────────────+
              react / react-dom 等共享依赖
              运行时版本协商, 避免重复加载
```

本质差异在于 runtime 基座不同:

| 维度        | Webpack MF                            | Vite MF (@module-federation/vite)            |
| ----------- | ------------------------------------- | -------------------------------------------- |
| 运行时      | 深度集成 webpack runtime (chunk 加载) | 无 Webpack runtime, 需在插件层自建           |
| remoteEntry | 构建期生成的 JS 文件                  | dev 模式下运行时动态生成的 ESM 入口          |
| 模块加载    | webpack 的 chunk loading 机制         | 原生 `import()` 动态导入                     |
| shared 依赖 | sharing scope 运行时版本协商          | 需要与依赖预构建 (optimizeDeps) 协调的协调层 |
| 开发体验    | 需要完整构建                          | dev 免打包, 即时生效                         |

Webpack 的 MF 依赖 `__webpack_init_sharing__` / `container.init` / `container.get` 这套 runtime API; Vite 没有等价 runtime, @module-federation/vite 要在插件层实现模块注册表、remoteEntry 动态生成和 shared 版本协商, 且要处理与 optimizeDeps 预构建的时序关系.

这类插件最容易踩的是 workspace 包的双格式导出: monorepo 里的 workspace 包若通过 `exports` 字段同时提供 ESM/CJS 入口, 又被配置成 shared 依赖, 解析时一旦命中 Node 的 CJS 条件 (`require`) 就会拿到 `.cjs` 入口. node_modules 里的包有 optimizeDeps 兜底做 CJS 转 ESM, 但 workspace 包是软链接、默认跳过预构建, `.cjs` 路径一旦被写进生成的 `import` 语句, 浏览器执行时就会因 `module is not defined` 崩溃. 规避方式是在插件层按 `browser`/`import`/`module`/`default` 条件重新解析 workspace 包的 ESM 入口, 非 workspace 包则原样交给 optimizeDeps.

生产实践要点: React 必须 `singleton: true` 防止多实例导致 hooks 报错; remoteEntry 加载失败要有重试 + ErrorBoundary fallback + 兜底版本 URL 三层降级.

### Vite 与 Webpack 在工程化接口上有哪些关键差异?

两套工具的能力并不一一对应, 从 Webpack 体系切入时最容易碰到以下几处 (均为当前行为):

1. 批量导入: Webpack 的 `require.context` 在 Vite 中用 `import.meta.glob` 表达; 后者默认返回懒加载函数, 需要同步拿到模块时传 `{ eager: true }`.
2. 环境变量: `process.env.X` 对应 `import.meta.env.VITE_X`, 只有 `VITE_` 前缀会暴露给客户端; 第三方库内部引用 `process.env` 的, 用 `define` 注入兜底.
3. CJS 依赖的 default 导出: 两边对 `esModuleInterop` 的处理不同, 常见症状是 `xxx.default is not a function`, 通过 `optimizeDeps` 配置或改写导入方式解决.
4. 入口: Vite 以 index.html 为入口, HtmlWebpackPlugin 那套模板注入改由 `transformIndexHtml` 钩子或对应插件承担.
5. CSS: less/sass 的全局变量注入与 `javascriptEnabled` 之类的开关放在 `css.preprocessorOptions`; 样式顺序与 Webpack 可能不同, 个别覆盖关系需要显式调整.
6. 动态 import 的路径变量: Webpack 会为部分动态路径打包整个目录, Vite 要求用 `import.meta.glob` 显式声明可选集合.

### monorepo 的工程化怎么做? 内部包如何构建和消费?

本机的 yukino 系列仓库都用 pnpm workspace 组织 monorepo: yukino-sentry 的 pnpm-workspace.yaml 声明 `packages` 为 `sentry`、`client`、`server`、`docs`; yukino-code 的 pnpm-workspace.yaml 声明 `packages: [apps/*]`, 并在 package.json 的 `pnpm.overrides` 里把 `@yukino.js/yukino`、`@yukino.js/mcp` 固定到 `workspace:*`.

核心实践:

1. 包管理: pnpm workspace + `workspace:*` 协议声明内部依赖, 硬链接节省磁盘且天然防止幽灵依赖 (依赖必须显式声明才能被解析).
2. 内部包消费的两种模式:
   - 源码直连 (推荐用于应用内共享包): 包的 exports 直接指向 src, 由消费方的 Vite/Webpack 统一转译. 优点是改动即时生效、无需 watch 构建; 代价是消费方要能处理 TS.
   - 预构建产物: 对外发布的包 (如 `@yukino.js/sentry`) 用 Rollup 构建出 ESM + CJS + d.ts (sentry/package.json 的 build 脚本是 `rollup -c ./rollup.config.ts`), 在 `exports` 里为 `.`、`./plugins`、`./react`、`./vue`、`./vite`、`./webpack` 每个子路径同时声明 `types`/`import`/`require` 入口.
3. 任务编排: Turborepo (或 pnpm -r + topological order) 声明 build 依赖关系 `"dependsOn": ["^build"]`, 配合内容哈希的远程缓存, CI 上未变更的包直接命中缓存跳过构建.
4. 版本与发布: changesets 管理版本号与 changelog, CI 自动发布到 npm registry; 协议定义类的类型包也可以套同一条链路——上游 IDL 变更触发重新生成 TS 类型, 再按 semver 规则自动 bump 并发布.
5. 统一约束: 根目录统一 tsconfig base、ESLint、prettier; 用 syncpack 或 pnpm catalog 收敛各包的依赖版本, 避免同一依赖多版本并存.

常见坑: 内部包源码直连时 Vite 不会对 workspace 包做预构建, 若该包引用了 CJS 依赖需手动加入 optimizeDeps.include; TS 的 paths 与包 exports 需要保持一致, 否则 IDE 跳转与构建解析不同步.

### 环境变量与多环境配置在两个工具中如何管理?

机制差异:

- Webpack: 通过 DefinePlugin 在编译期做字符串替换, `process.env.NODE_ENV` 等表达式被直接替换为字面量, 配合压缩器删除死分支. EnvironmentPlugin 是其封装.
- Vite: 内置 dotenv 加载 `.env`、`.env.[mode]` 文件, 只有 `VITE_` 前缀的变量会暴露给客户端代码 (`import.meta.env.VITE_X`), 前缀机制天然防止服务端密钥泄漏进 bundle. 自定义替换用 `define` 配置.

多环境实践:

1. 环境维度用 mode 表达: `vite build --mode staging` 对应 `.env.staging`; Webpack 用 `--env` 传参在配置函数中分支.
2. 区分"构建期常量"与"运行期配置": 会随部署环境变化但不想多次构建的配置 (如 API 域名), 不要打进 bundle, 改为运行时从 `window.__CONFIG__` 或配置接口读取, 实现一次构建多环境部署.
3. 类型安全: 用 Zod 在应用入口校验 `import.meta.env`, 为环境变量补充 `env.d.ts` 类型声明, 配置缺失在启动时立即报错而不是运行时静默出错.
4. 安全底线: 任何进入前端 bundle 的变量都是公开的, 密钥类配置只能放在 BFF/服务端.

### 构建产物如何做体积优化和浏览器兼容?

体积优化按收益排序:

1. 依赖治理 (通常收益最大): bundle 分析找出大头, moment 换 dayjs、lodash 换 lodash-es 按需导入、图表库按需注册组件; 重复依赖用 dedupe/resolutions 收敛到单版本.
2. 代码分割 + 按需加载: 路由级动态 import, 低频功能 (导出 Excel、富文本编辑器) 交互时再加载.
3. Tree Shaking 保障: 见「Tree Shaking 的原理是什么? 哪些写法会导致失效?」, 重点是 sideEffects 声明和避免 CJS.
4. 压缩: Vite 8 的 JS 默认用 Oxc Minifier (可切 esbuild/terser), CSS 默认用 Lightning CSS; 产物开启 gzip/brotli (brotli 比 gzip 再小 15% 左右), 由 CDN 或网关下发.
5. 资源优化: 小图内联 base64 阈值控制、大图 WebP/AVIF、字体子集化.

浏览器兼容:

1. 统一用 browserslist 声明目标 (`.browserslistrc`), 让 Babel/SWC、autoprefixer 与构建工具的 target 共享同一份目标. 注意 Vite 自身并不读 browserslist: `build.target` 默认值是特殊值 `'baseline-widely-available'`, 在 Vite 8 中具体对应 `'chrome111'`/`'edge111'`/`'firefox114'`/`'safari16.4'`/`'ios16.4'` (对齐 2026-01-01 的 Baseline Widely Available, 转换由 Oxc Transformer 执行) ; 要支持更老的浏览器需显式覆盖 `build.target`.
2. 语法降级与 polyfill 分开考虑: 语法降级由转译器完成; polyfill 用 core-js 的 `useBuiltIns: 'usage'` 按需注入, 或交给 polyfill 服务按 UA 下发.
3. Vite 的现代/传统双产物: `@vitejs/plugin-legacy` 生成带 polyfill 的 legacy chunk, 通过 `<script type="module">` 与 `nomodule` 让新浏览器加载小的现代产物、老浏览器加载兼容产物.
4. 兼容成本要有边界: 与业务方确认最低支持版本, 每往下兼容一档都有体积与维护成本, 不做无限兼容.

### 大型项目的构建性能优化手段有哪些?

先度量再优化: Webpack 用 `--profile` + speed-measure-plugin / rsdoctor 定位耗时在哪个 loader/plugin; Vite 用 `vite --profile` (`--profile [name]` 会启动内置 Node inspector 并写出 `<name>.cpuprofile`) 与 `--debug` 日志观察预构建与转译耗时.

Webpack 侧:

1. 持久化缓存 (Webpack 5 核心手段): `cache: { type: 'filesystem' }`, 二次构建通常快 5 倍以上, CI 上挂载缓存目录跨任务复用.
2. 换更快的转译器: babel-loader 换 swc-loader/esbuild-loader, 类型检查移交 fork-ts-checker 并行进程 (transpileOnly).
3. 缩小处理范围: loader 配置 include 只处理 src; 合理设置 resolve.extensions 顺序.
4. 并行: thread-loader 对重 loader 并行化 (注意进程通信开销, 小项目反而变慢); terser 默认并行.
5. sourcemap 降级: 开发环境用 eval-cheap-module-source-map 而非完整 source-map.

Vite 侧:

1. 减少首屏模块瀑布: `server.warmup` 预热高频入口模块; barrel file 拆解, 避免一个 import 拉起几百个模块.
2. 预构建稳定性: 显式 optimizeDeps.include 避免运行时二次预构建 reload.
3. 生产构建: Vite 8 的 `build.minify` 默认即 oxc, 无需额外配置; 追求更高压缩率可评估 terser (需显式安装); 关闭不必要的 `build.reportCompressedSize` (大项目上 gzip 计算很耗时).

组织级手段: monorepo 任务缓存 (Turborepo 远程缓存) 让 CI 只构建受影响的包; 产物增量发布, 未变更的 chunk 命中 CDN 缓存. 终极手段是换 Rust 工具链: Rolldown 已内置在 Vite 8, Rspack 的配置面与 Webpack 高度重合, 迁移时可以大量复用既有的 loader/plugin 约定.

### CI/CD 中如何保障构建产物质量?

我把产物质量保障分为四道关卡:

1. 构建前静态关卡: lint + tsc --noEmit + 单元测试作为流水线前置步骤; 依赖安装用 lockfile 严格模式 (`pnpm install --frozen-lockfile`), 保证构建可复现.
2. 产物体积关卡:
   - size-limit / bundlesize 对关键 chunk 设置体积阈值, 超限直接让 PR 失败.
   - PR 上自动输出 bundle diff 评论 (本次改动让哪个 chunk 增大了多少), 让体积变化在 review 时可见.
3. 运行质量关卡:
   - Lighthouse CI 对预发环境跑分, LCP/CLS/INP 低于基线阻止合并.
   - E2E 冒烟测试验证核心路径在真实构建产物上可用 (dev 模式跑通不代表生产产物没问题, 比如 Tree Shaking 误删副作用、动态 import 路径错误都只在 build 后暴露).
4. 发布与回滚关卡:
   - 产物带 contenthash 全量上传 CDN 后再切换 html 引用, 保证原子发布; 旧版本产物保留, 回滚只需切回旧 html.
   - Source map 在构建后上传监控平台并与 release version 绑定, 同时从发布产物中剔除 (见「Source Map 有哪些类型? 生产环境如何选择与管理?」), 发布后观察错误率, 异常自动告警回滚.

对协议/IDL 类型包还可以加一层契约关卡: 定义变更时 CI 自动做新旧版本 diff, 识别 breaking change 并强制 major 版本升级, 防止接口契约漂移流入下游.

---

以上内容基于本机 yukino 系列仓库 (yukino-chatbot 的 Vite 8 配置与 lockfile、yukino-codegen 的 Vite 7 配置、yukino-sentry 的 sourcemap 与构建链路、yukino-code 的 pnpm workspace 结构) 与通用构建工具原理整理; Vite 8 相关的配置事实逐条对照 vite.dev 的 Config Reference 与 Migration from v7 文档, Rolldown 的 codeSplitting 行为对照 rolldown.rs 的 Manual Code Splitting 文档.
