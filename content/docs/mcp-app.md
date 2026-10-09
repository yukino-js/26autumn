---
title: "MCP Apps: 用沙箱 iframe 把交互 UI 带进对话"
description: "MCP Apps 扩展的协议契约、UI 资源与工具声明、宿主与 iframe 的通信与安全模型、工程实践与降级路径, 以及与 A2UI 的对比"
---

MCP Apps 是 MCP 协议的一个扩展: 它让 MCP 工具返回一段可交互的 HTML 应用, 由 MCP 宿主渲染在对话流内部的沙箱 iframe 中。本文讲它的协议契约(工具怎么声明 UI 资源、资源怎么被读取与协商)、宿主与 iframe 之间的通信与安全模型(CSP、sandbox、来源校验)、工程落地时的通道划分与构建实践, 并把它与 A2UI 这条"用声明式数据描述 UI"的相反路线做详细对比。适合正在为 MCP 工具补富交互界面、或需要在"执行代码"与"渲染数据"两种 UI 方案之间做选型的协议与前端工程师阅读。

需要先说明一个前提: MCP Apps 的宿主支持是可选的, 协议仍在活跃演进; 本文描述的是可对照 SDK 产物核实的行为, 未核实之处会明确标注。

## 一、MCP Apps 是什么

### 1.1 一句话定义

MCP Apps 由两个已有 MCP 原语组合而成:

- Tool(工具): 在定义元数据里声明 _meta.ui.resourceUri, 指向一个 UI 资源;
- Resource(资源): URI 以 ui:// 开头, MIME 类型为 text/html;profile=mcp-app, 内容是一份自包含的 HTML 文档。

宿主调用工具时, 先拉取(甚至预加载)这份 HTML, 渲染进沙箱 iframe, 再把工具结果推送进去——UI 与数据由此接通。工具本身仍然是普通工具: 出现在 tools/list 里, 被模型照常调用。

### 1.2 解决什么问题

纯文本响应的表达力有限, 而"做一个独立 Web 应用再发链接"又会切断对话上下文。MCP Apps 提供四点价值:

1. 上下文保持: App 活在对话里, 用户不切标签页、不丢对话线程;
2. 双向数据流: App 可以通过宿主代理调用同一 MCP Server 上的任意工具, 宿主也会把最新的工具结果推给 App——独立 Web 应用则需要自建 API、鉴权与状态管理;
3. 复用宿主能力: App 可以把动作委托给宿主(打开链接、追加消息等), 由宿主路由到用户已连接的其他能力;
4. 安全保证: App 跑在宿主控制的沙箱 iframe 里, 访问不了父页面 DOM、读不到 Cookie、逃不出容器。宿主因此可以放心渲染不受信的第三方 Server 提供的 UI——这是整个扩展存在的前提。

### 1.3 与普通 MCP 工具的关系: 增强而非替代

对纯文本客户端没有破坏性影响:

- 工具本身照常出现在 tools/list, 照常被模型调用;
- 返回结果里的 content(文本)照常进入模型上下文;
- 只有当宿主声明了 MCP Apps 能力时, 才会拉取 UI 资源并渲染 iframe。

因此"给工具加 UI"是增量增强: 不支持的宿主只多看到一段元数据, 支持的宿主多渲染一块交互界面。

## 二、协议契约: 工具、UI 资源与能力协商

### 2.1 核心模式: Tool + ui:// 资源

服务端侧(SDK 的 server 入口)只需要两个注册调用:

```typescript
import {
  registerAppTool,
  registerAppResource,
  RESOURCE_MIME_TYPE, // "text/html;profile=mcp-app"
} from "@modelcontextprotocol/ext-apps/server";

const resourceUri = "ui://create-app/create-app.html";

registerAppTool(
  server,
  "get-time",
  {
    description: "Returns the current server time.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
    _meta: { ui: { resourceUri } },
  },
  async () => ({
    content: [{ type: "text", text: new Date().toISOString() }], // 文本降级
    structuredContent: { time }, // 小体积结构化数据(模型可见)
    _meta: { html }, // UI 专用大数据(模型不可见)
  }),
);

registerAppResource(
  server,
  "Get Time UI",
  resourceUri,
  {
    description: "Interactive shell",
  },
  async () => ({
    contents: [
      {
        uri: resourceUri,
        mimeType: RESOURCE_MIME_TYPE,
        text: bundledHtml,
        _meta: {
          ui: { csp: { resourceDomains: ["https://cdn.jsdelivr.net"] } },
        },
      },
    ],
  }),
);
```

ui:// 的路径结构是任意的, 多个工具也可以共享同一个 UI 资源。SDK 同时保留了历史的直接元数据键形式(把资源 URI 直接放在工具的 _meta 上), 宿主侧需要同时识别新旧两种格式; 新代码应使用 registerAppTool 的嵌套 _meta.ui.resourceUri 形式。

### 2.2 声明契约: 工具元数据与资源元数据

契约分两侧:

- 工具侧: 通过 _meta.ui.resourceUri 声明"调用这个工具时该渲染哪块 UI"; _meta.ui.visibility 声明工具暴露给谁——取值 "model" 与 "app" 的数组, 只给 app 的工具不进模型的工具列表(纯 UI 回程接口), 只给 model 的工具则不出现在 App 可调集合里, SDK 配套 getToolUiResourceUri / isToolVisibilityModelOnly / isToolVisibilityAppOnly 三个读取助手; EXTENSION_ID = "io.modelcontextprotocol/ui" 用于能力协商。
- 资源侧: 除了 MIME 类型必须为 text/html;profile=mcp-app, 资源元数据还承载 CSP 与权限申报(见第四节), 以及可选的显示偏好(如是否希望宿主为 UI 绘制外框)。

这两侧共同构成"声明"层: 服务端只声明请求, 是否授予由宿主决定。

### 2.3 能力协商与降级

宿主与 Server 之间通过客户端能力协商决定是否启用 UI: 宿主在 MCP initialize 的 ClientCapabilities.extensions 字段里登记 "io.modelcontextprotocol/ui" 键, 值为 `{ mimeTypes: [...] }`——声明它能渲染哪些 UI MIME 类型; Server 侧用 SDK 的 getUiCapability(clientCapabilities) 读出该声明, 检查 mimeTypes 是否包含 RESOURCE_MIME_TYPE。这个设计带来清晰的降级路径:

- 不支持 UI 的宿主: 只消费 content 与 structuredContent 文本, 工具照常工作;
- 支持 UI 的宿主: 拉取资源并渲染 iframe, 同时仍把 content 回灌给模型。

换句话说, UI 是叠加在普通工具结果之上的一层, 而不是替代品。

## 三、一次调用的完整生命周期

### 3.1 生命周期时序

```text
用户: "给我看个图表"
  |
  V
模型决定调用工具(带 HTML 参数)
  |
  |--(可选)宿主预加载 ui:// 资源, 甚至在参数流式生成时就挂起 iframe
  V
宿主 tools/call -> MCP Server
  |
  V
Server 返回 content / structuredContent / _meta
  |
  V
宿主读取 ui:// 资源 -> 拿到自包含 HTML
  |
  V
渲染进沙箱 iframe(postMessage 通道建立, ui/initialize 握手)
  |
  |-- ui/notifications/tool-input          完整工具入参
  |-- ui/notifications/tool-input-partial  流式部分入参(生成中预览)
  |-- ui/notifications/tool-result         工具结果(含 _meta)
  V
App 渲染数据; 用户交互时 App 反向发起 tools/call(宿主代理转发)
  |
  V
对话结束 -> ui/resource-teardown -> App 清理后卸载
```

两个值得注意的细节:

- UI 可以先于工具结果渲染。宿主允许在模型还在生成参数时就把 iframe 挂起来, 部分入参收到的是"修复过的合法 JSON", 可以拿来做生成进度预览。
- App 与 Server 之间没有直连。App 发起的工具调用全部经宿主代理转发, 宿主可以施加额外的策略控制(例如限制 App 能调用哪些工具)。

### 3.2 通信协议: postMessage 上的 MCP 方言

iframe 内外的传输是 window.postMessage, 消息格式是 JSON-RPC——一个 MCP 方言: 一部分方法直接复用核心 MCP 的线上格式——App→宿主方向有 tools/call(经宿主代理转发)、resources/read、resources/list、sampling/createMessage(需宿主声明 sampling 能力)、notifications/message 日志、ping, 宿主→App 方向有 tools/call 与 tools/list(枚举并调用 App 内注册的工具)——其余是 ui/ 前缀的新方法。扩展协议自身也有版本常量(SDK 1.7.x 内 LATEST_PROTOCOL_VERSION 为 "2026-01-26"), 在 ui/initialize 握手中协商。

| 方法 / 通知                             | 方向                  | 作用                                                    |
| --------------------------------------- | --------------------- | ------------------------------------------------------- |
| ui/initialize                           | App -> 宿主           | 握手, 交换能力与宿主上下文初值                          |
| ui/notifications/initialized            | App -> 宿主           | 握手完成通知                                            |
| ui/notifications/tool-input             | 宿主 -> App           | 完整工具入参                                            |
| ui/notifications/tool-input-partial     | 宿主 -> App           | 流式部分入参(已修复的合法 JSON)                         |
| ui/notifications/tool-result            | 宿主 -> App           | 工具结果(content / structuredContent / _meta / isError) |
| ui/notifications/tool-cancelled         | 宿主 -> App           | 工具执行被取消                                          |
| ui/notifications/host-context-changed   | 宿主 -> App           | 主题、样式变量、字体、安全区、显示模式变化              |
| ui/notifications/size-changed           | App -> 宿主           | App 高度变化(配合自动 resize)                           |
| ui/notifications/sandbox-proxy-ready    | App -> 宿主           | 沙箱代理就绪信号                                        |
| ui/notifications/sandbox-resource-ready | 宿主 -> App           | 向内层沙箱投递 HTML(含 sandbox 覆写、CSP 与权限)        |
| ui/notifications/request-teardown       | 宿主 -> App           | 请求 App 进入卸载流程                                   |
| ui/request-display-mode                 | App -> 宿主           | 请求 inline / fullscreen / pip 切换                     |
| ui/open-link                            | App -> 宿主           | 请求宿主打开外部链接(宿主可拒绝)                        |
| ui/update-model-context                 | App -> 宿主           | 把 App 内的结构化结果回写模型上下文                     |
| ui/message                              | App -> 宿主           | 追加一条消息到对话(受宿主策略约束)                      |
| ui/download-file                        | App -> 宿主           | 请求宿主下载文件                                        |
| ui/resource-teardown                    | 双向                  | 卸载前清理(保存状态、关闭连接)                          |
| tools/call                              | App -> 宿主 -> Server | App 反向调用 Server 工具(宿主代理)                      |

其中 sandbox-proxy-ready / sandbox-resource-ready 一对通知服务于"二级沙箱代理"模式(规范中标注为保留消息, 仅供实现双 iframe 沙箱架构的宿主使用): 外层代理 iframe 先报告就绪, 宿主再把 App 的 HTML 连同 sandbox 属性覆写、CSP 与权限配置投递给它, 由代理写入内层 iframe——承载不可信第三方内容的宿主可以借此把渲染面再压深一层。浏览器权限到 iframe allow 属性的映射由 SDK 的 buildAllowAttribute 完成。此外 SDK 提供 sendLog 方法把调试日志直达宿主, 而不是只留在 iframe 控制台; App 侧还可以经 createSamplingMessage 请求宿主代发一次 LLM sampling(sampling/createMessage), 前提是宿主声明了 sampling 能力。

### 3.3 客户端 API 与 React 接入

SDK 的 App 类是这套协议的便利封装(协议本身是标准 postMessage, 可以裸实现)。典型用法:

```typescript
import {
  App,
  PostMessageTransport,
  applyDocumentTheme,
  applyHostStyleVariables,
  applyHostFonts,
} from "@modelcontextprotocol/ext-apps";

const app = new App({ name: "My App", version: "1.0.0" });

// handler 必须在 connect() 之前注册, 否则握手期间的事件会丢
app.ontoolinput = (params) => {
  /* params.arguments */
};
app.ontoolinputpartial = (params) => {
  /* 生成中预览 */
};
app.ontoolresult = (result) => {
  /* result.content / structuredContent / _meta */
};
app.onhostcontextchanged = (ctx) => {
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
  if (ctx.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts);
};
app.onteardown = async () => ({});

await app.connect(new PostMessageTransport());
```

宿主通过 styles.variables 下发一批 CSS 自定义属性, App 用 var(--x, fallback) 消费即可与宿主主题对齐。App 的宿主绑定方法(如 callServerTool、sendMessage)在握手完成前调用会告警, 严格模式下抛错。SDK 还带 autoResize 开关(监听文档尺寸并自动上报)与 allowUnsafeEval 开关(默认让校验库走无 JIT 路径, 以适配严格 CSP)。

React 技术栈另提供 useApp、useHostStyleVariables、useHostFonts、useDocumentTheme、useAutoResize 等 hooks。需要注意: ./react 子路径的类型声明使用无扩展名的相对导入, 在 NodeNext 模块解析下 re-export 会静默失效; 已有工程因此改用主入口的 App 类自行接线。

### 3.4 服务端 SDK 与官方示例

SDK 的 server 入口除注册函数外, 还提供 App 侧工具注册的能力(允许 App 内的 UI 代码注册额外工具)。示例覆盖地图(CesiumJS)、3D(Three.js)、着色器、PDF 阅读器、乐谱、语音转写、系统监控仪表盘、预算分配器等, 并提供多种前端模板与 vanilla 用法。宿主侧有两种接入方式: 直接使用 mcp-ui 客户端的 React 组件, 或基于 SDK 的 AppBridge 模块(负责 iframe 渲染、消息转发、工具调用代理与安全策略执行)。

## 四、安全模型

MCP Apps 的安全性建立在两层机制上: iframe 沙箱(隔离执行)与 CSP(限制加载)。宿主是这两层的执行者, App 声明只是"请求"。

### 4.1 沙箱边界

宿主把 App HTML 渲染进沙箱 iframe, App 天然无法:

- 访问父页面 DOM 或在父上下文执行脚本;
- 读取宿主的 Cookie / localStorage / sessionStorage(沙箱内源为 opaque origin, 存储 API 直接抛错);
- 导航父页面、逃出容器。

所有通信只能走宿主中转的 postMessage 通道, 宿主可以审查每一个请求。需要特别注意的组合陷阱: allow-scripts 与 allow-same-origin 绝不能同时授予可能与宿主同源的文档, 否则脚本可以摘掉自己的沙箱——这是所有承载不可信代码的 iframe 方案共同的红线。

### 4.2 CSP: 默认全拒, 显式申报

MCP App HTML 没有同源服务器, 所有外部来源都必须在资源元数据里申报, 漏报会静默失败(资源加载不出来、请求发不出去)。SDK 会把声明映射为宿主施加的 CSP 指令:

| 声明字段        | 映射 CSP 指令                                       | 用途                                   |
| --------------- | --------------------------------------------------- | -------------------------------------- |
| connectDomains  | connect-src                                         | fetch / XHR / WebSocket                |
| resourceDomains | img-src、script-src、style-src、font-src、media-src | 静态资源(脚本、样式、图片、字体、媒体) |
| frameDomains    | frame-src                                           | 嵌套 iframe                            |
| baseUriDomains  | base-uri                                            | 文档 base URI                          |

### 4.3 权限与能力控制

- 浏览器权限: App 可申请摄像头、麦克风、地理位置、剪贴板写入等, 映射为 Permission Policy, 由宿主决定授予与否;
- 宿主能力: openLink、可调用的工具集合等都可以被宿主逐项限制——App 拿到的是"宿主愿意给多少"而非"App 想要多少";
- 显示模式: 请求全屏时宿主可以只授予 inline。

### 4.4 信任假设与残余风险

沙箱模型的本质是"假设代码不可信, 隔离执行"。它比"根本不执行代码"的路线多出几类需要宿主持续防守的攻击面:

- 资源耗尽: 沙箱不提供 CPU/内存配额, 死循环仍能冻结渲染进程;
- 表单外泄: 若授予 allow-forms, 页面可以把用户输入提交到任意域名(CSP 的 connectDomains 不覆盖 form-action, 需要宿主补齐 form-action 'none');
- 钓鱼弹窗: allow-popups 允许打开任意新标签页;
- CSP 组合漏洞: 申报过宽的 resourceDomains(如整个 CDN)意味着信任该 CDN 的全部内容。

因此 MCP Apps 的安全是"宿主实现质量"敏感的: 同一个 App 在严谨的宿主里安全, 在粗糙的宿主里可能漏。这是它与 A2UI 安全模型最本质的差别。

## 五、工程实践: 以 create_app 工具为例

create_app 是一个完整可参照的实现: 模型传入一份自包含 HTML, 工具把它渲染成对话内的交互应用, UI 资源 URI 为 ui://create-app/create-app.html。

### 5.1 结构与数据通道

```text
create-app/
  tool.ts            # registerAppTool + registerAppResource(服务端)
  create-app.html    # UI 入口
  create-app.tsx     # React shell: App 生命周期 + 沙箱 iframe
  global.css         # 样式入口
```

结果里三个通道的分工(这是 MCP Apps 工程里最重要的可见性决策):

| 通道              | 模型可见    | 本例用途                          |
| ----------------- | ----------- | --------------------------------- |
| content(文本)     | 是          | 一句话回执加非 UI 宿主的降级说明  |
| structuredContent | 是          | 小数据(标题)                      |
| _meta             | 否(UI 专用) | 大数据(完整 HTML, 上限 20 万字符) |

大 HTML 绝不能放进 structuredContent——那是普通工具结果, 会被完整回灌给模型, 造成数万 token 的重复。UI 专属数据放 _meta, 经 tool-result 通知推给 App, 模型完全看不到。

### 5.2 App 侧渲染: 不可信 HTML 的隔离

shell 拿到 _meta.html 后渲染进二级沙箱 iframe:

```tsx
<iframe
  sandbox="allow-scripts allow-forms allow-modals allow-popups"
  srcDoc={state.phase === "ready" ? state.html : undefined}
/>
```

shell 本身已运行在宿主的沙箱 iframe(opaque origin)里, 内层 iframe 再隔离一层: 模型生成的 HTML 拿不到 shell 的 DOM, 更碰不到宿主。两个渲染时机都处理: 部分入参到达时显示生成进度(字节数), 完整入参或权威结果到达时渲染最终内容。工具被取消时切到失败态。

主题同步上要注意: daisyUI 这类依赖 data-theme 属性的库需要显式把宿主主题写到该属性上, 而宿主样式变量与字体走 CSS 自定义属性。

### 5.3 构建管线

```text
tsup(清空 dist, 产出 dist/main.js)
  -> vite + vite-plugin-singlefile(emptyOutDir: false, 产出自包含的 dist/create-app.html)
```

- UI 依赖(React、Tailwind、daisyUI、vite 插件)全部进 devDependencies——它们只参与打包, 服务端运行时不需要; ext-apps 是例外: 服务端运行时 import 其 server 入口, 因此位于 dependencies;
- 前端构建单独成脚本, 开发与测试流程都先跑它, 保证运行时读到的是构建产物;
- 服务端从构建产物目录读 HTML: 源码运行时取包级的单文件产物, 打包后取与入口同级的文件; 文件缺失时抛错而不是降级——静默返回占位 HTML 会把"没构建"伪装成"渲染成功"。

### 5.4 测试与验证

- 协议层: 用内存传输成对连接, 断言 tools/list 里的资源 URI 元数据、resources/read 的 MIME 与 bundle 内容、tools/call 的结果通道;
- 宿主层: 可用官方附带的参考宿主实现本地调试, 或用隧道把本地 Server 注册为支持 MCP Apps 的宿主的自定义连接器。

### 5.5 已踩过的坑

1. React 子路径的类型声明在 NodeNext 解析下失效(无扩展名相对导入), 改用主入口的 App 类自行接线;
2. 打包器把 CJS 依赖打进 ESM bundle 时, 动态 require 会抛错, 需要在 banner 里补 createRequire(import.meta.url);
3. 打包器的清空行为会删掉构建目录, 前端构建必须后跑且不重复清空;
4. 依赖 data-theme 的组件库需要手动镜像宿主主题。

## 六、宿主与生态现状

MCP Apps 是核心 MCP 规范之外的扩展, 宿主支持可选。定位上最接近的同类物:

- Claude Artifacts: 体验相似, 但 Artifacts 是宿主内建功能、无法由第三方 Server 提供; MCP Apps 把这个能力开放给了整个 MCP 生态;
- OpenAI Apps SDK: 同为"工具返回 UI", MCP Apps 走开放规范路线, 社区已有从专有 API 迁移到 MCP Apps 的路径。

生态件包括宿主侧渲染组件、SDK 内置的 AppBridge(自建宿主用, 与 App 类共享同一套协议实现), 以及一批官方示例与多语言模板; 官方还提供 create-mcp-app、migrate-oai-app、add-app-to-server、convert-web-app 四个 Agent Skill, 分别用于从零脚手架、从 OpenAI Apps SDK 迁移、给已有 MCP server 的工具补 UI、把存量 web 应用改造成混合形态。本地可核对的 SDK 版本为 @modelcontextprotocol/ext-apps 1.7.4 / 1.7.5(分别搭配 @modelcontextprotocol/sdk 1.29 与 1.32), 扩展协议版本为 2026-01-26; 该规范版本已标注为稳定, 另有 draft 版本并行演进, 2.x SDK 线的 wire protocol 与 1.x 互相兼容。

## 七、与 A2UI 的对比

A2UI 的完整机制见 [A2UI](a2ui); 本节只做取向与工程差异的对照。

### 7.1 同一个问题域, 相反的两条路

两者的目标一致: Agent 如何跨越信任边界, 向用户呈现富交互 UI——尤其是远程 Agent、或编排器委托给第三方 Agent 的场景。

但信任策略相反:

> MCP Apps: UI 是代码。代码不可信, 所以用浏览器沙箱加 CSP 把它关起来执行。
> A2UI: UI 是数据。数据永远不该被执行, 所以只发声明式 JSON, 客户端按白名单组件渲染。

这个根本分歧派生出下面所有差异。

### 7.2 架构对比

```text
MCP Apps(代码沙箱路线):
Agent 产出完整 HTML/CSS/JS
  -> MCP 宿主写入沙箱 iframe(独立 DOM / 样式 / JS 上下文)
  -> postMessage 双向通道(tools/call 经宿主代理)
  -> 安全 = iframe sandbox + CSP, 宿主执行

A2UI(数据白名单路线):
Agent 产出声明式 JSON 消息流
  -> 客户端校验并增量应用到 SurfaceModel
  -> 用本地组件库在宿主组件树内原生渲染
  -> 安全 = catalog 白名单, 永不执行 Agent 下发的代码
```

### 7.3 逐维度对照

| 维度        | MCP Apps                                           | A2UI                                            |
| ----------- | -------------------------------------------------- | ----------------------------------------------- |
| 协议身份    | MCP 的扩展(tool + ui:// 资源 + ui/* JSON-RPC 方言) | 独立的声明式 UI 协议, 与 MCP 平级               |
| UI 载体     | 自包含 HTML/CSS/JS 单文件                          | 声明式 JSON(组件树 + 数据模型)                  |
| 信任模型    | 假设代码不可信, 沙箱内隔离执行                     | 假设输出不是代码, 白名单渲染                    |
| 隔离机制    | iframe sandbox + CSP(宿主执行)                     | JSON Schema 校验 + 组件白名单(客户端执行)       |
| 渲染位置    | 独立浏览上下文(iframe), 每块 UI 一个               | 宿主组件树内, 无 iframe                         |
| 表达上限    | 整个 Web 平台(任意 JS 库)                          | catalog 组件集, 可自定义注册                    |
| 样式体系    | 与宿主隔离, 靠注入的 CSS 变量近似对齐              | 原生继承宿主设计系统                            |
| 数据交互    | App 主动调用 Server 工具(RPC, 宿主代理)            | 数据模型双向绑定 + action 事件                  |
| 更新模型    | 整文档替换                                         | 流式增量消息                                    |
| 可校验性    | HTML 无法在渲染前校验, 坏了只能白屏                | Schema 全量校验, 可纠错可降级                   |
| 流式能力    | 仅工具入参流式, HTML 本体原子到达                  | 为流式而生, 支持渐进渲染                        |
| 端覆盖      | 仅 Web 宿主(iframe 是 Web 概念)                    | Web / 移动 / 桌面同一份 payload                 |
| 传输耦合    | 强耦合 MCP                                         | 传输无关                                        |
| UI 状态归属 | App 内部, 宿主不可见                               | 数据模型是双方共享的唯一数据源                  |
| token 成本  | 高(完整 HTML, 动辄数万 token)                      | 中(结构化 JSON 加 prompt 内嵌 schema)           |
| 生成可靠性  | 无法静态校验, 坏 HTML 只能在沙箱里"安全地烂掉"     | 校验失败可回喂纠错、可降级                      |
| 典型场景    | 地图、3D、PDF/富媒体查看器、复杂可视化             | 对话内卡片、表单、图表、多 Agent 编排的 UI 委托 |

### 7.4 关键差异展开

1. 信任模型: 运行时隔离 vs 生成时约束。MCP Apps 把安全责任压在宿主的沙箱与 CSP 实现质量上, 存在需要持续防守的缺口; A2UI 把安全责任前移到数据格式本身——"Agent 只能请求渲染 catalog 内组件"是一条可静态验证的不变量, 没有代码执行面。前者表达力上限高但攻击面大, 后者永远安全但表达力有天花板。

2. 表达能力: 全 Web 平台 vs catalog 上限。MCP App 可以跑 3D 场景、完整的 PDF 阅读器, 而 catalog 模式下这些需要逐个封装成自定义组件。反过来, A2UI 生成的 UI 永远与宿主 App 视觉一致, 而 MCP App 的 iframe 是样式孤岛。

3. 渲染与性能: iframe 的代价。iframe 是独立浏览上下文, 创建与通信开销大, 高度自适应、滚动联动都要跨框架协调; A2UI 组件直接渲染在宿主树里。UI 数量多的对话场景, A2UI 的成本结构更优。

4. 数据流: RPC 拉取 vs 声明式绑定。MCP App 拿数据靠主动调用工具(每次一个往返), UI 状态锁在 iframe 里宿主看不见; A2UI 的数据模型是双方共享的可观察状态, 服务端可随时推送, 输入组件双向绑定本地写回。A2UI 的数据架构天然贴合"对话推进、UI 跟着变"的交互形态。

5. 流式与增量: 为 LLM 而生的设计差异。A2UI 的扁平邻接表、乱序可达、模板绑定, 都为"边生成边渲染"服务, 首屏延迟低; MCP App 的 HTML 是一个原子文档, 只有参数是流式的, 内容必须等生成完、且无法在渲染前校验。

6. 可校验性与失败语义。A2UI 有完整的失败工程学: 校验、纠错、降级、诚实提示; MCP App 的失败语义只有一种——沙箱保证坏代码"安全地"什么都不显示, 渲染前无法知道它会白屏。对无人监督的自动化场景, 这是可靠性上的实质差距。

7. 可移植性。iframe 决定了 MCP Apps 只存在于 Web 宿主; A2UI 的一份 JSON 可以同时驱动 Web、桌面与移动端渲染器。

8. 协议耦合与生态位。MCP Apps 天然被"MCP 宿主是否实现了这个扩展"卡住; A2UI 传输无关。两者还可以互相嵌套: A2UI 仓库给出了可核对的参考实现, 用"同源外层代理 iframe + 受限内层 iframe"的双 iframe 隔离运行不受信的第三方内容(外层维持与宿主的结构化通道, 内层固定授予 allow-scripts allow-forms allow-popups allow-modals, 刻意不含 allow-same-origin 与 allow-top-navigation 一族; 因此内层源序列化为 null, postMessage 只能以通配 origin 为目标), 并复用了 MCP Apps 的 sandbox-proxy-ready / sandbox-resource-ready 通知。需要说明: 双 iframe 承载属于示例中的实现选择, 不是 A2UI 规范本身的要求——在 A2UI 的世界观里, MCP App 是一种"需要双 iframe 隔离的富组件", 两者互补而非互斥。反向嵌套(在 MCP Apps 里嵌入 A2UI 渲染器)同样可行。

9. 上下文经济学: 同一笔账, 四种费率。两个协议的 UI 描述都"进上下文一次", 没有谁天然更省。分野在完整生命周期的四笔账:

| 成本项                  | A2UI                                       | MCP Apps                                             |
| ----------------------- | ------------------------------------------ | ---------------------------------------------------- |
| 固定契约(system prompt) | 重: 需要内嵌协议 schema 与 catalog 契约    | 轻: 只多一个工具定义                                 |
| 首帧生成                | 声明式 JSON 进上下文, 通常比等价 HTML 紧凑 | 完整文档进上下文, 动辄几万 token                     |
| 更新                    | 便宜: 一条增量 patch 消息进历史            | 贵: 全量重生成整页 HTML                              |
| 交互                    | 贵: 每次 action 把 surface 状态回传服务端  | 免费: 本地交互与工具调用走协议旁路, 不增上下文 token |

交互成本的方向性差异还带来语义差别: 留在上下文里的 A2UI JSON 是"活"的, 后续轮次模型能读到并修改它; MCP Apps 留在历史里的 HTML 是"死"的, 生成之后无人引用, 只等上下文压缩清走。

一句话: A2UI 把 UI 状态放进上下文(交互围绕模型转), MCP Apps 把 UI 状态放进沙箱(交互绕开模型转)——前者买到"更新的便宜", 后者买到"交互的免费"。

### 7.5 选型建议

选 MCP Apps, 当:

- 需要富媒体/重型可视化(地图、3D、PDF、音视频、图表库全家桶), catalog 组件表达不了;
- 产物只面向 MCP 宿主, 且宿主的沙箱实现可信;
- UI 是"查看器/工作台"形态, 不需要与宿主产品设计系统严格一致。

选 A2UI, 当:

- UI 是对话内卡片、表单、列表、图表这类结构化交互, catalog 组件足够覆盖;
- 要求 UI 与宿主设计系统完全一致、无 iframe 开销、支持渐进渲染;
- 需要跨信任边界的多 Agent 委托, 或需要跨端渲染同一份 payload;
- 生成链路需要可校验、可纠错、可降级的可靠性工程。

两者同时用的形态: A2UI 宿主通过双 iframe 承载 MCP App(富组件), MCP 宿主也可以把 A2UI JSON 作为工具结果交给自定义渲染器。

## 八、完整闭环: 从需求到渲染, 从交互到更新

以 create_app 为例走一遍闭环。场景: 用户说"画一个每周 QPS 的柱状图", 之后又改需求、又在图里点了按钮。四个角色: 用户、模型、宿主(协议端点兼沙箱执行者)、MCP Server、App。

### 8.1 第一圈: 需求到首帧渲染

```text
阶段一  生成与预加载(与工具执行并行推进)
  用户 -> 模型: "画一个 QPS 柱状图"
  模型 -> 流式生成 tool_use: create_app { html, title }
    HTML 唯一进入模型上下文的位置——它是模型自己的输出
  宿主 -> resources/read "ui://create-app/create-app.html" -> Server
    触发源不是"调用发生", 而是会话建立时 tools/list 已带回映射;
    流里刚出现工具名时宿主查表即知渲染哪个 UI, 无需等参数生成完
  宿主 -> 挂载沙箱 iframe + ui/initialize 握手 -> shell
  宿主 -> tool-input-partial -> shell(状态条显示生成进度)

阶段二  工具执行
  宿主 -> tools/call create_app -> Server
    <- { content, structuredContent:{title}, _meta:{html} }

阶段三  结果分叉与渲染(一次结果, 两条通道)
  宿主 -> 一行文本回执(tool_result) -> 模型上下文
    只含 content, 模型由此知道"渲染成功", 看不到 HTML
  宿主 -> tool-result(含 _meta.html) -> shell
    HTML 走 UI 专用通道, 模型不可见
  shell -> 内层 iframe srcDoc = html -> 沙箱执行 JS
  UI 首帧呈现
```

要点: 入参即产物(HTML 是模型现场写出来的); 准备与生成交错(资源拉取、iframe 挂载、流式预览都不必等 HTML 生成完); 结果一分为二(文本回模型、_meta 给 UI); shell 的两个渲染时机(完整入参先到就先渲染, 权威结果到达后校准)。

### 8.2 第二圈 A: 用户更新需求(经过模型)

用户接着说"改成折线图, 加上环比"。这条更新走对话正向链路: 模型生成新的 tool_use, 引用同一个资源 URI。因为资源未变、iframe 已挂载, 宿主不重拉资源也不重建 iframe, 只把新的工具结果推给 shell; shell 用整体替换文档的方式更新 UI, 内层状态清零。

三个关键语义:

- 资源复用: 新调用引用同一 ui:// 资源, 宿主不再发起读取;
- 全量替换: 内层文档整体重建, 用户的滚动位置、未提交表单、JS 内存状态清零——这与"新版本来就是重画的页面"是自洽的, 但长交互不该依赖这条路保留状态;
- 上下文成本: 每次"改需求"模型都要重新生成整份 HTML, 旧版入参仍留在历史里。

### 8.3 第二圈 B: App 内交互(绕过模型)

用户直接在图里点了按钮, 这一圈不经过模型, 按交互形态分三种:

- 本地交互: 排序、筛选、tab 切换、hover 提示——内层 JS 直接改自己的 DOM, 不发生任何协议消息, 模型无感知, 状态自然保留。
- 回程取数: 需要新数据的按钮。直连型 App(App 代码本身就是 App bridge 的持有者)直接调用服务器的工具; 托管型 App(如 create_app, bridge 在外层 shell 手里, 内层是不可信 srcdoc)必须经 shell 中转——内层 postMessage 给 shell, shell 先校验消息确实来自自己的 iframe(沙箱下 origin 恒为 null, 只能靠 source 比对)并核对工具白名单, 再代理调用宿主, 结果原路返回。
- 通知模型: 若 App 内发生的事需要模型知道, 调 ui/update-model-context 把结构化摘要注入模型上下文。这是唯一一条"App 到模型"的显式通道。

### 8.4 收束: teardown

宿主卸载 UI 或 App 主动请求关闭时, 会发 teardown 通知, shell 有机会保存状态或关闭连接, 随后 iframe 被移除、渲染进程释放。

### 8.5 闭环全景

| 触发源         | 通道                                 | 经过模型              | UI 更新方式 | 内层状态 |
| -------------- | ------------------------------------ | --------------------- | ----------- | -------- |
| 首次需求       | tools/call + tool-result 推送        | 是(生成 HTML 入参)    | 首次挂载    | -        |
| 更新需求       | 新 tool_use + 推送(资源/iframe 复用) | 是(重新生成整页 HTML) | 整体替换    | 清零     |
| App 内本地交互 | 无(内层 JS 直改 DOM)                 | 否                    | 局部更新    | 保留     |
| App 内回程取数 | postMessage -> shell -> 宿主代理     | 否                    | 局部更新    | 保留     |
| App 通知模型   | ui/update-model-context              | 注入(受控)            | 不直接改 UI | 保留     |
| 结束           | teardown 通知                        | -                     | 卸载        | -        |

整条闭环的设计意图可以压缩成一句: 模型负责"决定 UI 长什么样"(唯一进上下文的部分); 一旦 UI 活起来, 后续交互与数据刷新尽量留在沙箱内、走协议旁路, 模型只在被显式叫到时才回到对话里。

## 九、总结

MCP Apps 用"工具加 ui:// 资源加沙箱 iframe"这个极小的协议增量, 把 Artifacts 式的交互体验开放给了整个 MCP 生态: 模型照常调用工具, 宿主多渲染一块 UI, 不受信的 HTML 被沙箱和 CSP 关在笼子里。工程成本集中在两端: 宿主要把沙箱和 CSP 做严, Server 作者要处理好大数据通道(用 _meta 而非 structuredContent)、单文件构建与文本降级路径。

与 A2UI 相比, 两者是同一问题域的两个极点: MCP Apps 信任沙箱, A2UI 信任数据。前者用表达力换攻击面, 后者用 catalog 天花板换安全与一致性; 前者绑定 MCP 宿主, 后者传输无关、多端可渲染, 且两者可以互相嵌套。理解"这条 UI 是代码还是数据"这一个问题, 就能推演出两者全部的设计差异与选型边界。
