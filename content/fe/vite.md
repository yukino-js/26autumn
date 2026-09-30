---
title: "前端构建工具与工程化技术笔记 (Vite + Webpack)"
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

1. 依赖预构建: node_modules 中的 CJS/UMD 依赖被一次性转为 ESM, 缓存在 node_modules/.vite, 二次启动直接读缓存; Vite 8 起该步骤由 Rolldown (Rust) 完成, Vite 7 及之前由 esbuild (Go, 比 Babel 快 10-100 倍) 完成.
2. 源码按需转译: 业务代码只在被请求时转译, 配合 HTTP 304 协商缓存, 未修改的模块不重复处理.
3. HMR 粒度小: 修改一个模块只需重新请求该模块的 ESM, 不需要重新计算整个依赖图 (详见「Webpack HMR 和 Vite HMR 的实现原理有何不同?」).

需要说明的边界: Vite dev 模式下首屏可能产生大量模块请求 (瀑布流), 深层依赖链的页面首次打开反而可能变慢, Vite 通过预构建合并依赖、`server.warmup` 预热高频模块来缓解. 生产构建两者都要完整打包, 差距主要在开发体验.

在阿里妈妈的项目中, 我推动从 Webpack 迁移到 Vite 后, 开发服务器启动时间从 4 分钟降至 8 秒, HMR 响应从 2 秒降至 200ms.

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

### esbuild 和 Rollup 在 Vite 中各自承担什么角色? 为什么生产构建不直接用 esbuild?

先说现状: 这道题在 Vite 8 起已成为历史. Vite 8 用 Rust 编写的 Rolldown 作为统一打包器, dev 预构建与生产打包都由它完成; TS/JSX 转译与产物压缩默认改用 oxc (`build.minify` 默认值即 `'oxc'`, terser/esbuild 仍可显式选用). 本机安装的 vite@8.3.0 中 rollup 已不在依赖列表, 官方迁移指南的表述是 "Vite 8 uses Rolldown and Oxc based tools instead of esbuild and Rollup".

Vite 7 及之前版本的分工:

- esbuild: dev 模式的依赖预构建 (CJS 转 ESM + 合并小模块)、TS/JSX 的单文件转译 (只做语法降级, 不做类型检查)、生产构建中的代码压缩 (minify 可选 esbuild, 比 terser 快一个数量级).
- Rollup: 生产构建的打包核心. 负责完整的 bundle、Tree Shaking、代码分割 (manualChunks)、产物格式输出, Vite 的插件 API 也是 Rollup 插件接口的超集.

当时生产构建不直接用 esbuild 的原因 (Vite 团队的官方权衡):

1. 灵活性差距: esbuild 为了极致速度牺牲了很多定制能力, 当时对代码分割的控制、CSS 处理、产物细粒度优化不如 Rollup 成熟.
2. 插件生态: Rollup 插件生态成熟, Vite 大量能力 (如 legacy 降级、SSR 处理) 依赖插件链的灵活介入.
3. 输出质量: Rollup 的 Tree Shaking 更精细, Scope Hoisting 产物更紧凑; 应用构建对产物质量的要求高于对构建速度的要求.

这个权衡的结局是: Vite 团队没有继续二选一, 而是用 Rust 重写了兼具两者能力的新引擎 Rolldown, 在 Vite 8 中统一了 dev 与 build, "双引擎"正式成为历史. 另外, Vite 6 引入的 Environment API (为不同运行环境提供独立的模块图与配置) 在 Vite 8 仍处实验阶段, 官方正在推进稳定化.

### Vite 依赖预构建 (optimizeDeps) 的原理是什么? 遇到过哪些坑?

原理: Vite 启动时扫描源码中的裸模块导入 (bare import, 如 `import React from 'react'`), 用 Rolldown (Vite 7 及之前为 esbuild) 将这些 node_modules 依赖打包成 ESM 并输出到 node_modules/.vite. 目的有两个:

1. 格式统一: 很多包只发布 CJS/UMD, 浏览器 ESM 无法直接消费, 预构建统一转为 ESM.
2. 请求合并: 像 lodash-es 这种包内部有几百个小模块, 不合并的话一次导入会触发几百个 HTTP 请求, 预构建合并为单文件.

缓存失效条件: lockfile 变更、vite.config 变更、NODE_ENV 变更时自动重新预构建; 也可用 `--force` 强制.

实际踩过的坑:

1. 运行时才发现的新依赖: 动态 import 的依赖在首次扫描中漏掉, 运行时触发"new dependencies optimized"并整页 reload, 体验很差. 解决: 用 `optimizeDeps.include` 显式声明.
2. CJS/ESM 互操作: 某些包的 `exports` 字段配置不规范, 预构建后 default 导出行为与 Webpack 下不一致 (`esModuleInterop` 差异), 需要 `optimizeDeps.needsInterop` 或让包方修复.
3. monorepo 内部包: workspace 链接的内部包默认不做预构建 (被视为源码), 如果内部包是 CJS 产物就会报错, 需要将其加入 `optimizeDeps.include` 并在 `build.commonjsOptions.include` 同步配置.
4. 模块联邦场景: 在给 @module-federation/vite 提 PR 时发现, 原实现对每个 shared 依赖单独执行一次 optimizeDeps, 依赖多时预构建耗时很长, 我将多个 shared 依赖合并为一次调用, 预构建时间从约 12 秒降到 3 秒.

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

1. usedExports (Webpack) / Rollup 的导出追踪: 标记哪些导出被使用.
2. sideEffects: package.json 中声明包是否有副作用. `"sideEffects": false` 允许构建工具跳过未被引用的整个模块, 即使它被 import 过 (如 `import 'x'`). CSS 导入必须声明为副作用 (`"sideEffects": ["*.css"]`), 否则样式会被误删.

常见失效场景:

1. 引入 CJS 产物: 如 lodash (CJS) 全量进包, 改用 lodash-es 或 `lodash/xxx` 单文件导入.
2. 副作用代码: 模块顶层执行了函数调用、修改了全局对象, 构建工具无法证明删除安全, 保守保留. 可用 `/*#__PURE__*/` 注释标记纯调用.
3. 重导出桶文件 (barrel file): `export * from './a'` 层层聚合, 配合副作用不明的包会显著降低 shake 效果, 还拖慢构建.
4. Babel 配置错误: `@babel/preset-env` 未设置 `modules: false` 时会把 ESM 提前转成 CJS, 直接废掉 Tree Shaking.
5. 类的静态属性、装饰器等转译产物带副作用, 需要检查 helper 是否标记了 PURE.

验证手段: `webpack --stats` 看 usedExports、Rollup 的 `treeshake` 日志、用 rsdoctor / webpack-bundle-analyzer 对比前后产物.

### 代码分割怎么做? splitChunks 和 manualChunks 的策略如何设计?

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

Vite (Vite 7 及之前基于 Rollup) 的 manualChunks 是函数式的等价物:

```typescript
build: {
  rollupOptions: {
    output: {
      manualChunks(id) {
        if (id.includes("node_modules")) {
          if (/react|react-dom/.test(id)) return "framework";
          if (/echarts/.test(id)) return "charts";
          return "vendor";
        }
      },
    },
  },
}
```

注意点: manualChunks 手动分组容易引入循环加载问题 (chunk A 的初始化依赖 chunk B 中的模块), Rollup 会警告 circular chunk, 需要保证分组边界与依赖方向一致.

Vite 8 中的变化: `build.rollupOptions` 的类型已切换为 RolldownOptions, Rollup 的 manualChunks 不复存在, 对应能力由声明式的 `output.codeSplitting` 提供 (按 name/test 等条件分组), 过渡期 API `output.advancedChunks` 在 Rolldown 中已标记废弃.

### Source Map 有哪些类型? 生产环境如何选择与管理?

Webpack devtool 的常见取值本质是三个维度的组合: 是否独立文件、是否含列信息、是否含源码内容.

- 开发环境: `eval-cheap-module-source-map` -- 重建速度快, 能映射到 loader 处理前的源码, 行级定位够用.
- 生产环境: `hidden-source-map` -- 生成完整独立 .map 文件但不在 bundle 末尾追加 sourceMappingURL 注释, 浏览器无法发现, 专供错误监控平台还原堆栈.
- 不推荐: 生产直接用 `source-map` (源码泄漏风险)、`eval` 系列上生产 (产物含 eval, CSP 不允许).

Vite 对应 `build.sourcemap: true | 'hidden' | 'inline'`, 语义一致.

生产 Source Map 的管理是我在 yukino-sentry 监控 SDK 中实际设计过的链路:

1. CI 构建阶段, 构建插件在产物输出后将 .map 文件上传到独立的 source map 存储服务 (不随静态资源发 CDN), 上传时携带 release version (git commit hash) 和压缩文件路径.
2. .map 文件从发布产物中剔除, 线上只有压缩代码.
3. SDK 上报错误时携带页面的 release version, 服务端用 version + filename 精确匹配对应 .map, 调用 source-map 库的 `originalPositionFor` 还原出原始文件、行列号和变量名.
4. 多版本共存 (灰度) 场景也能正确匹配, 因为映射键包含版本号.

这套方案同时满足了"线上不泄漏源码"和"错误堆栈可还原"两个诉求.

---

## 二、工程化实践

### Webpack 和 Vite 的模块联邦有什么本质差异? 你给 @module-federation/vite 贡献了什么?

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

我的贡献 (以 PR #860 为例, 已合并):

修复 workspace 包双格式导出在浏览器端崩溃: monorepo 里的 workspace 包若通过 `exports` 字段同时提供 ESM/CJS 入口, 并被配置为 shared 依赖, 浏览器运行时会抛 `ReferenceError: module is not defined`. 根因是插件用 `createRequire().resolve()` 解析 shared 包路径, 走的是 Node CJS 条件 (`["node", "require"]`), 命中 `.cjs` 入口; node_modules 里的包有 Vite optimizeDeps 兜底做 CJS 转 ESM, 但 workspace 包是软链接、跳过了预构建, `.cjs` 路径被直接写进生成的 `import` 语句, 浏览器加载后遇到 `module.exports` 即崩溃. 我在 `virtualShared_preBuild.ts` 中新增 `resolveWorkspaceEsmEntry()` 辅助函数: 对 workspace 包改用 `['browser', 'import', 'module', 'default']` 条件重解析到 ESM 入口, 非 workspace 包原样返回交给 optimizeDeps 处理, ESM 解析失败则优雅回退到原路径; 并在三个 `createRequire().resolve()` 调用点统一接入, 补充了对应测试用例.

生产实践要点: React 必须 `singleton: true` 防止多实例导致 hooks 报错; remoteEntry 加载失败要有重试 + ErrorBoundary fallback + 兜底版本 URL 三层降级.

### 从 Webpack 迁移到 Vite 的完整过程? 遇到了哪些兼容性问题?

在阿里妈妈的项目中主导过这次迁移, 整体分四步:

1. 摸底: 清点 webpack.config 中的 loader/plugin 清单, 逐项找 Vite 等价物; 统计 CJS 依赖和使用 webpack 特有 API 的代码 (如 `require.context`).
2. 双轨并行: 保留 Webpack 配置, 新增 vite.config, 先让 dev 模式跑通, 生产构建仍走 Webpack, 降低风险.
3. 生产切换: Vite build 产物与 Webpack 产物做对比验证 (体积、chunk 结构、运行时行为、异常监控对比), 灰度切流后全量.
4. 清理: 移除 Webpack 依赖与配置, CI 流水线切换.

实际遇到的兼容性问题:

1. `require.context` 批量导入: 改为 Vite 的 `import.meta.glob`, 注意后者默认懒加载, 需要 `{ eager: true }` 对齐原行为.
2. 环境变量: `process.env.X` 改为 `import.meta.env.VITE_X`; 第三方库内部引用 process.env 的, 用 `define` 注入兜底.
3. CJS 依赖的 default 导出差异: esModuleInterop 行为不一致导致 `xxx.default is not a function`, 通过 optimizeDeps 配置或改写导入方式解决.
4. index.html 地位变化: Vite 以 html 为入口, HtmlWebpackPlugin 的模板注入逻辑改为 vite-plugin-html 或 transformIndexHtml 钩子.
5. CSS 处理: less 的 javascriptEnabled、全局变量注入改到 `css.preprocessorOptions`; 样式顺序与 Webpack 略有差异, 个别覆盖关系要修正.
6. 动态 import 的路径变量: Webpack 支持部分动态路径 (会打包整个目录), Vite 需要 import.meta.glob 显式声明可选集合.

收益: dev 启动 4 分钟降到 8 秒, HMR 从 2 秒降到 200ms, 新人本地环境搭建时间明显缩短.

### monorepo 的工程化怎么做? 内部包如何构建和消费?

我在个人项目 (yukino-sentry、yukino-code 均为多包结构) 和公司项目中都使用 pnpm workspace 组织 monorepo.

核心实践:

1. 包管理: pnpm workspace + `workspace:*` 协议声明内部依赖, 硬链接节省磁盘且天然防止幽灵依赖 (依赖必须显式声明才能被解析).
2. 内部包消费的两种模式:
   - 源码直连 (推荐用于应用内共享包): 包的 exports 直接指向 src, 由消费方的 Vite/Webpack 统一转译. 优点是改动即时生效、无需 watch 构建; 代价是消费方要能处理 TS.
   - 预构建产物: 对外发布的包 (如 @yukino/sentry 的 core 与各 plugin 子包) 用 tsup/Rollup 构建出 ESM + CJS + d.ts 双格式, 配置规范的 exports 条目.
3. 任务编排: Turborepo (或 pnpm -r + topological order) 声明 build 依赖关系 `"dependsOn": ["^build"]`, 配合内容哈希的远程缓存, CI 上未变更的包直接命中缓存跳过构建.
4. 版本与发布: changesets 管理版本号与 changelog, CI 自动发布到 npm registry. 在字节的 Thrift IDL 类型包链路中也是类似思路: IDL 变更触发 CI 重新生成 TS 类型、按 semver 规则自动 bump 并发布.
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
4. 压缩: JS 用 oxc/esbuild/terser, CSS 用 cssnano/lightningcss; 产物开启 gzip/brotli (brotli 比 gzip 再小 15% 左右), 由 CDN 或网关下发.
5. 资源优化: 小图内联 base64 阈值控制、大图 WebP/AVIF、字体子集化.

浏览器兼容:

1. 统一用 browserslist 声明目标 (`.browserslistrc`), 让 Babel/SWC、autoprefixer、esbuild target 共享同一份目标.
2. 语法降级与 polyfill 分开考虑: 语法降级由转译器完成; polyfill 用 core-js 的 `useBuiltIns: 'usage'` 按需注入, 或交给 polyfill 服务按 UA 下发.
3. Vite 的现代/传统双产物: `@vitejs/plugin-legacy` 生成带 polyfill 的 legacy chunk, 通过 `<script type="module">` 与 `nomodule` 让新浏览器加载小的现代产物、老浏览器加载兼容产物.
4. 兼容成本要有边界: 与业务方确认最低支持版本, 每往下兼容一档都有体积与维护成本, 不做无限兼容.

### 大型项目的构建性能优化手段有哪些?

先度量再优化: Webpack 用 `--profile` + speed-measure-plugin / rsdoctor 定位耗时在哪个 loader/plugin; Vite 用 `vite --profile`、`DEBUG=vite:*` 观察预构建与转译耗时.

Webpack 侧:

1. 持久化缓存 (Webpack 5 核心手段): `cache: { type: 'filesystem' }`, 二次构建通常快 5 倍以上, CI 上挂载缓存目录跨任务复用.
2. 换更快的转译器: babel-loader 换 swc-loader/esbuild-loader, 类型检查移交 fork-ts-checker 并行进程 (transpileOnly).
3. 缩小处理范围: loader 配置 include 只处理 src; 合理设置 resolve.extensions 顺序; DllPlugin 的思路已被持久化缓存取代, 不再推荐.
4. 并行: thread-loader 对重 loader 并行化 (注意进程通信开销, 小项目反而变慢); terser 默认并行.
5. sourcemap 降级: 开发环境用 eval-cheap-module-source-map 而非完整 source-map.

Vite 侧:

1. 减少首屏模块瀑布: `server.warmup` 预热高频入口模块; barrel file 拆解, 避免一个 import 拉起几百个模块.
2. 预构建稳定性: 显式 optimizeDeps.include 避免运行时二次预构建 reload.
3. 生产构建: Vite 8 的 `build.minify` 默认即 oxc, 无需额外配置; 追求更高压缩率可评估 terser (需显式安装); 关闭不必要的 `build.reportCompressedSize` (大项目上 gzip 计算很耗时).

组织级手段: monorepo 任务缓存 (Turborepo 远程缓存) 让 CI 只构建受影响的包; 产物增量发布, 未变更的 chunk 命中 CDN 缓存. 终极手段是换 Rust 工具链 (Rspack/Rolldown), 对存量 Webpack 项目 Rspack 基本兼容配置且构建速度提升 5-10 倍.

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
   - Source map 随构建上传监控平台并与 release version 绑定 (见「Source Map 有哪些类型? 生产环境如何选择与管理?」), 发布后观察错误率, 异常自动告警回滚.

在字节的 Thrift IDL 类型包链路中还有一层契约关卡: IDL 变更时 CI 自动做新旧版本 diff, 识别 breaking change 并强制 major 版本升级, 防止接口契约漂移流入下游 BFF.

---

以上内容基于本人在阿里妈妈 (Webpack/Vite 模块联邦接入、@module-federation/vite 开源贡献、Vite 迁移)、字节跳动 (Thrift IDL npm 包 CI 链路) 以及 yukino-sentry / yukino-code 个人项目中的实际工程经验整理.
