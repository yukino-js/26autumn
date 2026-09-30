---
title: "MCP App 全面解析：协议、安全模型，以及与 A2UI 的对比"
---

> 本文基于 `@modelcontextprotocol/ext-apps` v1.7.5（MCP Apps 规范草案 2026-01-26）与官方文档整理，协议仍在活跃开发中。
> 文中的工程实践均来自 `$HOME/github/yukino-code/apps/mcp` 的 MCP App 工具（一个已落地的 MCP App），可与代码对照阅读。
> 注：撰写时该工具名为 `render_app`（`src/tools/render-app/`，UI 资源 `ui://render-app/mcp-app.html`）；当前仓库中已演进为 `create_app`（`src/tools/create-app/`，UI 资源 `ui://create-app/create-app.html`）。正文保留撰写时点的名称与结构，机制不变。
> 对比对象 A2UI 的资料见 `a2ui.md`（Google 发起的声明式 UI 协议）。

---

## 1. MCP App 是什么

### 1.1 一句话定义

MCP App 是 MCP 协议的一个扩展：让 MCP 工具返回一段可交互的 HTML 应用，由 MCP 宿主（如 Claude）渲染在对话流内部的沙箱 iframe 中。用户不离开对话就能操作图表、地图、表单、3D 模型等富 UI，而这些 UI 背后仍然是普通的 MCP 工具。

它的核心组合是两个已有的 MCP 原语：

- Tool（工具）：声明 `_meta.ui.resourceUri`，指向一个 UI 资源；
- Resource（资源）：URI 以 `ui://` 开头，MIME 类型为 `text/html;profile=mcp-app`，内容是一份自包含的 HTML 文档。

宿主调用工具时，先拉取（甚至预加载）这份 HTML，渲染进沙箱 iframe，再把工具结果推送给它——UI 与数据由此接通。

### 1.2 解决什么问题

纯文本响应的表达力有限，而"做一个独立 Web 应用再发链接"又有明显的割裂感。MCP App 官方给出的四个理由：

1. 上下文保持。App 活在对话里，不切标签页、不丢对话线程，UI 与产生它的讨论天然在一起。
2. 双向数据流。App 可以通过宿主代理调用同一 MCP Server 上的任意工具（`tools/call`），宿主也会把最新的工具结果推给 App。独立 Web 应用则需要自建 API、鉴权与状态管理。
3. 复用宿主能力。App 可以把动作委托给宿主（如"打开链接""发送消息"），宿主路由到用户已连接的其他能力，App 不必自己实现每一家集成。
4. 安全保证。App 跑在宿主控制的沙箱 iframe 里：访问不了父页面 DOM、读不到 Cookie、逃不出容器。宿主因此可以放心渲染完全不受信任的第三方 Server 提供的 UI——这是整个扩展存在的前提。

### 1.3 与普通 MCP 工具的关系：增强，而非替代

MCP App 对文本-only 客户端完全向后兼容：

- 工具本身照常出现在 `tools/list`，照常被模型调用；
- 返回结果中的 `content`（文本）照常进入模型上下文；
- 只有当宿主声明了 MCP Apps 能力（`ext-apps` 的 `getUiCapability`）时，才会拉取 UI 资源并渲染 iframe。

所以"给工具加 UI"是增量增强：不支持 UI 的宿主只看到多了一段元数据；支持的宿主多渲染一块交互界面。`visibility` 还可以进一步控制工具的受众——`["model", "app"]`（默认，模型和 App 都能调用）或 `["app"]`（app-only 辅助工具，仅供 UI 轮询/取数，模型不可见）。

---

## 2. 工作原理

### 2.1 核心模式：Tool + UI Resource

服务端侧（以官方 `ext-apps` SDK 为例）只需要两个注册调用：

```typescript
import {
  registerAppTool,
  registerAppResource,
  RESOURCE_MIME_TYPE, // "text/html;profile=mcp-app"
} from "@modelcontextprotocol/ext-apps/server";

const resourceUri = "ui://render-app/mcp-app.html";

// 1) App 工具：比普通工具多一个 _meta.ui.resourceUri
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
    structuredContent: { time }, // 小体积结构化数据（模型可见）
    _meta: { html }, // UI-only 大数据（放元数据）
  }),
);

// 2) UI 资源：宿主按 resourceUri 读取这份 HTML
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
        text: bundledHtml, // vite-plugin-singlefile 打出的单文件 HTML
        _meta: {
          ui: {
            csp: { resourceDomains: ["https://cdn.jsdelivr.net"] }, // 见 §3.2
          },
        },
      },
    ],
  }),
);
```

`ui://` scheme 的路径结构是任意的（`ui://my-tool/mcp-app.html`），多个工具也可以共享同一个 UI 资源。

### 2.2 一次调用的完整生命周期

```
用户: "给我看个图表"
  │
  V
模型决定调用 render_app（带 HTML 参数）
  │
  ├─(可选)宿主预加载 ui:// 资源，甚至开始流式转发工具入参
  V
宿主 tools/call → MCP Server
  │
  V
Server 返回 content / structuredContent / _meta
  │
  V
宿主读取 ui:// 资源 → 拿到自包含 HTML
  │
  V
渲染进沙箱 iframe（postMessage 通道建立，ui/initialize 握手）
  │
  ├─ ui/notifications/tool-input          完整工具入参
  ├─ ui/notifications/tool-input-partial  流式部分入参（生成中预览）
  └─ ui/notifications/tool-result         工具结果（含 _meta）
  │
  V
App 渲染数据；用户交互时 App 反向发起 tools/call（宿主代理转发）
  │
  V
对话结束 → ui/resource-teardown → App 清理后卸载
```

两个值得注意的细节：

- UI 可以先于工具结果渲染。宿主允许在模型还在生成参数时就把 iframe 挂起来，`ontoolinputpartial` 收到的是"修复过的部分 JSON"（始终合法），可以拿来做生成进度预览。
- App 与 Server 之间没有直连。App 的 `tools/call` 全部经宿主代理转发，宿主可以施加额外的策略控制（比如限制 App 能调用哪些工具）。

### 2.3 通信协议：postMessage 上的 MCP 方言

iframe 内外的传输是 `window.postMessage`，消息格式是 JSON-RPC——一个 MCP 的"方言"：部分方法与核心 MCP 共享（如 `tools/call`），多数是 `ui/` 前缀的新方法。从 SDK 源码确认的方法集合：

| 方法 / 通知                             | 方向                | 作用                                                              |
| :-------------------------------------- | :------------------ | :---------------------------------------------------------------- |
| `ui/initialize`                         | App → 宿主          | 握手，交换能力（App 能力、宿主上下文初值）                        |
| `ui/notifications/tool-input`           | 宿主 → App          | 完整工具入参（`arguments`）                                       |
| `ui/notifications/tool-input-partial`   | 宿主 → App          | 流式部分入参（已修复的合法 JSON）                                 |
| `ui/notifications/tool-result`          | 宿主 → App          | 工具结果（`content` / `structuredContent` / `_meta` / `isError`） |
| `ui/notifications/tool-cancelled`       | 宿主 → App          | 工具执行被取消（用户操作、分类器拦截等）                          |
| `ui/notifications/host-context-changed` | 宿主 → App          | 主题、样式变量、字体、安全区、显示模式变化                        |
| `ui/notifications/size-changed`         | App → 宿主          | App 高度变化（配合 `autoResize` 自适应）                          |
| `ui/notifications/sandbox-proxy-ready`  | App → 宿主          | 沙箱代理就绪信号                                                  |
| `ui/request-display-mode`               | App → 宿主          | 请求 `inline` / `fullscreen` 切换                                 |
| `ui/open-link`                          | App → 宿主          | 请求宿主打开外部链接（宿主可拒绝）                                |
| `ui/update-model-context`               | App → 宿主          | 把 App 内的结构化结果回写模型上下文                               |
| `ui/resource-teardown`                  | 双向                | 卸载前清理（保存状态、关闭连接）                                  |
| `tools/call`                            | App → 宿主 → Server | App 反向调用 Server 工具（宿主代理）                              |
| `sendLog`                               | App → 宿主          | 调试日志直达宿主（而非仅 iframe 控制台）                          |

### 2.4 客户端 API：App 类

`@modelcontextprotocol/ext-apps` 的 `App` 类是这套协议的便利封装（不是必需品——协议本身是标准 postMessage，可以裸实现）。典型的 vanilla 用法：

```typescript
import {
  App,
  PostMessageTransport,
  applyDocumentTheme,
  applyHostStyleVariables,
  applyHostFonts,
} from "@modelcontextprotocol/ext-apps";

const app = new App({ name: "My App", version: "1.0.0" });

// 所有 handler 必须在 connect() 之前注册，否则握手期间的事件会丢
app.ontoolinput = (params) => {
  /* 用 params.arguments 渲染 */
};
app.ontoolinputpartial = (params) => {
  /* 生成中预览 */
};
app.ontoolresult = (result) => {
  /* result.content / structuredContent / _meta */
};
app.onteardown = async () => ({});

app.onhostcontextchanged = (ctx) => {
  if (ctx.theme) applyDocumentTheme(ctx.theme); // 设置 data-theme + color-scheme
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables); // 注入宿主 CSS 变量
  if (ctx.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts); // 注入宿主字体
  if (ctx.safeAreaInsets) {
    const { top, right, bottom, left } = ctx.safeAreaInsets;
    document.body.style.padding = `${top}px ${right}px ${bottom}px ${left}px`;
  }
};

await app.connect(new PostMessageTransport());
```

宿主通过 `styles.variables` 下发一批 CSS 自定义属性（`--color-background-primary`、`--color-text-primary`、`--font-sans`、`--border-radius-md` 等），App 用 `var(--x, fallback)` 消费即可与宿主主题对齐。React 技术栈另有 `useApp` / `useHostStyles` / `useDocumentTheme` hooks（注意：v1.7.5 的 `./react` 子路径类型声明在 NodeNext 解析下有缺陷，实践见 §4.6）。

### 2.5 服务端生态与官方示例

`ext-apps` 仓库提供了覆盖典型场景的示例：地图（CesiumJS）、3D（Three.js）、shader、PDF 阅读器、乐谱、语音转写、系统监控仪表盘、预算分配器等，以及 React / Vue / Svelte / Preact / Solid / vanilla 六种模板。宿主侧有两种接入方式：直接用 `@mcp-ui/client` 的 React 组件，或基于 SDK 的 AppBridge 模块（负责 iframe 渲染、消息转发、工具调用代理与安全策略执行）。

---

## 3. 安全模型

MCP App 的全部安全性建立在两层机制上：iframe 沙箱（隔离执行）与 CSP（限制加载）。宿主是这两层的执行者，App 声明的只是"请求"。

### 3.1 沙箱边界

宿主把 App HTML 渲染进沙箱 iframe，App 天然无法：

- 访问父页面 DOM 或在父上下文执行脚本；
- 读取宿主的 Cookie / localStorage / sessionStorage（沙箱内源为 opaque origin，存储 API 直接抛错）；
- 导航父页面、逃出容器。

所有通信只能走宿主中转的 postMessage 通道，宿主可以审查每一个请求。需要特别注意的组合陷阱：`allow-scripts` + `allow-same-origin` 绝不能同时给到可能与宿主同源的文档，否则脚本可以摘掉自己的沙箱——这是所有承载不可信代码的 iframe 方案（包括 A2UI 的双 iframe 模式）共同的红线。

### 3.2 CSP：默认全拒，显式申报

MCP App HTML 没有同源服务器，所有外部来源都必须在资源的 `_meta.ui.csp` 里申报，漏报会静默失败（资源加载不出来、请求发不出去）。SDK 会把声明映射为宿主施加的 CSP 指令：

| 声明字段          | 映射 CSP 指令                                             | 用途                                     |
| :---------------- | :-------------------------------------------------------- | :--------------------------------------- |
| `connectDomains`  | `connect-src`                                             | fetch / XHR / WebSocket                  |
| `resourceDomains` | `img-src` `script-src` `style-src` `font-src` `media-src` | 静态资源（脚本、样式、图片、字体、媒体） |
| `frameDomains`    | `frame-src`                                               | 嵌套 iframe                              |
| `baseUriDomains`  | `base-uri`                                                | 文档 base URI                            |

### 3.3 权限与能力控制

- 浏览器权限：App 可通过资源的 `_meta.ui.permissions` 申请摄像头、麦克风、地理位置、剪贴板写入等，映射为 Permission Policy，由宿主决定授予与否。
- 宿主能力：`openLink`、可调用的工具集合等宿主能力都可以被宿主逐项限制。App 拿到的是"宿主愿意给多少"而非"App 想要多少"。
- 显示模式：`requestDisplayMode` 申请全屏，宿主可以只授予 inline。

### 3.4 信任假设与残余风险

沙箱模型的本质是"假设代码不可信，隔离执行"。它比 A2UI 的"根本不执行代码"多出几类需要宿主持续防守的攻击面：

- 资源耗尽：沙箱不提供 CPU/内存配额，`while(true)` 仍能冻结渲染进程；
- 表单外泄：若授予 `allow-forms`，页面可以把用户输入提交到任意域名（CSP 的 `connectDomains` 不覆盖 form-action，需要宿主补齐 `form-action 'none'`）；
- 钓鱼弹窗：`allow-popups` 允许打开任意新标签页；
- CSP 组合漏洞：申报过宽的 `resourceDomains`（如整个 CDN）意味着信任该 CDN 的全部内容。

因此 MCP App 的安全是一个"宿主实现质量"敏感的模型：同一个 App 在严谨的宿主里安全，在粗糙的宿主里可能漏。这是它与 A2UI 安全模型最本质的差别（详见 §6.5）。

---

## 4. 工程实践：以 `render_app` 为例

`$HOME/github/yukino-code/apps/mcp/src/tools/render-app/`（现为 `create-app/`）是一个完整可参照的实现：模型传入一份自包含 HTML，工具把它渲染成对话内的交互应用。

### 4.1 结构与数据通道

```
src/tools/render-app/          # 现为 src/tools/create-app/
├── tool.ts                    # registerAppTool + registerAppResource（服务端）
├── mcp-app.html               # UI 入口（现为 create-app.html）
├── mcp-app.tsx                # React shell：App 生命周期 + 沙箱 iframe（现为 create-app.tsx）
└── global.css                 # @import "tailwindcss"; @plugin "daisyui";
```

结果里三个通道的分工（这是 MCP Apps 工程里最重要的可见性决策）：

| 通道                | 模型可见      | 本例用途                            |
| :------------------ | :------------ | :---------------------------------- |
| `content`（文本）   | 是            | 一句话回执 + 非 UI 宿主的降级说明   |
| `structuredContent` | 是            | 小数据（`{ title }`）               |
| `_meta`             | 否（UI-only） | 大数据（完整 HTML，最大 200K 字符） |

大 HTML 绝不能放进 `structuredContent`——那是普通工具结果，会被完整回灌给模型，造成数万 token 的重复。UI 专属数据放 `_meta`，经 `ui/notifications/tool-result` 推给 App，模型完全看不到。

### 4.2 App 侧渲染：不可信 HTML 的隔离

shell 拿到 `_meta.html` 后渲染进二级沙箱 iframe：

```tsx
<iframe
  sandbox="allow-scripts allow-forms allow-modals allow-popups"
  srcDoc={html}
/>
```

shell 本身已运行在宿主的沙箱 iframe（opaque origin）里，内层 iframe 再隔离一层：模型生成的 HTML 拿不到 shell 的 DOM，更碰不到宿主。两个渲染时机都处理：`ontoolinputpartial` 显示生成进度，`ontoolresult` 渲染最终内容。主题同步上要注意 daisyUI 这类依赖 `data-theme` 属性的库需要手动调用 `applyDocumentTheme`（宿主 hooks 只设 `color-scheme`）。

### 4.3 构建管线

```
tsup（清空 dist，产出 dist/main.js）
  → vite + vite-plugin-singlefile（emptyOutDir: false，产出自包含的 dist/mcp-app.html）
```

- UI 依赖（react / tailwind / daisyui / ext-apps）全部进 devDependencies——它们只参与打包，服务器运行时不需要；
- `build:ui` 单独成脚本，`dev` / `test` 都先跑它，保证源码运行时读到的也是构建产物；
- 服务端从 `dist/` 读 HTML：打包后取 `dist/main.js` 的同级文件，tsx 源码运行时取包级 `dist/mcp-app.html`；文件缺失时抛错而不是降级——静默返回占位 HTML 会把"没构建"伪装成"渲染成功"。

### 4.4 测试与验证

- 协议层：`InMemoryTransport` 成对连接，断言 `tools/list` 里的 `_meta.ui.resourceUri`、`resources/read` 的 MIME 与 bundle 内容、`tools/call` 的结果通道；
- 宿主层：官方 `ext-apps/examples/basic-host` 是本地调试宿主（`SERVERS='["http://localhost:3300/mcp"]' npm start`），或用 cloudflared 隧道把本地 Server 注册为 Claude 的自定义 connector。

### 4.5 已踩过的坑（v1.7.5）

1. `ext-apps/react` 子路径的 d.ts 用了无扩展名相对导入，NodeNext 下 re-export 静默失效（`skipLibCheck` 掩盖了根因）——改用主入口的 `App` 类自行接线；
2. tsup 把 CJS 依赖（dotenv）打进 ESM bundle 时，动态 `require` 会抛 `Dynamic require of "fs"`——banner 里补 `createRequire(import.meta.url)`；
3. tsup `clean: true` 会清掉 dist，vite 必须后跑且 `emptyOutDir: false`；
4. daisyUI 主题靠 `data-theme` 属性切换，而宿主样式 hooks 只设置 `color-scheme`，需要在 `onhostcontextchanged` 里补 `applyDocumentTheme`。

---

## 5. 宿主与生态现状

MCP Apps 是核心 MCP 规范之外的扩展，宿主支持是可选的。当前支持矩阵：Claude（网页）、Claude Desktop、VS Code GitHub Copilot、Microsoft 365 Copilot、Goose、Postman、MCPJam、Archestra.AI。定位上最接近的同类物：

- Claude Artifacts：体验相似，但 Artifacts 是宿主内建功能、无法由第三方 Server 提供；MCP App 把这个能力开放给了整个 MCP 生态。
- OpenAI Apps SDK：同为"工具返回 UI"，MCP Apps 走开放规范路线，社区已有从 `window.openai` / skybridge 迁移到 MCP Apps 的指南。

生态件：`@mcp-ui/client`（宿主侧 React 渲染组件）、SDK 内置 AppBridge（自建宿主用）、ext-apps 仓库的十余个官方示例与六语言模板。

---

## 6. MCP Apps 与 A2UI 的详细对比

### 6.1 同一个问题域，相反的两条路

A2UI（Agent-to-User Interface，Google 发起、CopilotKit 共建）与 MCP Apps 解决的是同一个问题：Agent 如何跨越信任边界，向用户呈现富交互 UI——尤其是远程 Agent、或编排器委托给第三方 Agent 的场景（第三方要往主聊天窗口渲染一块 UI）。

但两者选了方向相反的信任策略：

> - MCP Apps："UI 是代码，代码不可信 → 用浏览器沙箱 + CSP 把它关起来执行。"
>   —— safe like sandbox，expressive like the web
> - A2UI："UI 是数据，数据永远不该被执行 → 只发声明式 JSON，客户端按白名单 catalog 渲染。"
>   —— safe like data，expressive like code

这个根本分歧派生出下面所有差异。

### 6.2 架构对比

```
MCP Apps（代码沙箱路线）:
Agent 产出完整 HTML/CSS/JS
  → MCP 宿主写入沙箱 iframe（独立 DOM / 样式 / JS 上下文）
  → postMessage 双向通道（tools/call 经宿主代理）
  → 安全 = iframe sandbox + CSP，宿主执行

A2UI（数据白名单路线）:
Agent 产出声明式 JSON 消息流
  （createSurface / updateComponents / updateDataModel，扁平邻接表 + JSON Pointer 绑定）
  → 客户端 MessageProcessor 校验并增量应用到 SurfaceModel
  → 用本地组件库（React/Lit/Angular/Flutter）在宿主组件树内原生渲染
  → 安全 = catalog 白名单，永不执行 Agent 下发的代码
```

### 6.3 逐维度对照表

| 维度           | MCP Apps                                                     | A2UI                                                              |
| :------------- | :----------------------------------------------------------- | :---------------------------------------------------------------- |
| 提出方 / 许可  | Anthropic / MCP 社区，MIT（SDK），规范草案 2026-01-26        | Google 发起、CopilotKit 共建，Apache 2.0，v0.9.1 当前 / v1.0 候选 |
| 协议身份       | MCP 的扩展（tool + `ui://` resource + `ui/*` JSON-RPC 方言） | 独立的声明式 UI 协议（四类消息信封），与 MCP 平级                 |
| UI 载体        | 自包含 HTML/CSS/JS 单文件                                    | 声明式 JSON（抽象组件树 + 数据模型）                              |
| 信任模型       | 假设代码不可信，沙箱内隔离执行                               | 假设输出不是代码，白名单 catalog 渲染                             |
| 隔离机制       | iframe sandbox + CSP（宿主执行）                             | JSON Schema 校验 + 组件白名单（客户端执行）                       |
| 渲染位置       | 独立浏览上下文（iframe），每块 UI 一个                       | 宿主组件树内，无 iframe                                           |
| 表达上限       | 整个 Web 平台（ECharts / Three.js / Cesium / PDF.js 任意库） | catalog 组件集（basic 18 个；shadcn 扩展 65 个），可自定义注册    |
| 样式体系       | 与宿主完全隔离，靠注入的 CSS 变量近似对齐主题                | 原生继承宿主设计系统（主题、暗色、字体天然统一）                  |
| 数据交互       | App 主动 `callServerTool`（RPC），宿主代理转发               | JSON Pointer 双向绑定 + action 事件；DataModel 双方可观察         |
| 更新模型       | 整文档替换（重设 srcdoc）                                    | 流式增量消息（改数据不必重发结构）                                |
| 可校验性       | HTML 无法在渲染前校验，坏了只能白屏                          | Schema 全量校验 + generate-validate-repair 闭环 + 降级阶梯        |
| 流式能力       | 仅工具入参流式（`tool-input-partial`）；HTML 本体原子到达    | 为流式而生：邻接表乱序可达、root 缓冲、渐进渲染                   |
| 端覆盖         | 仅 Web 宿主（iframe 是 Web 概念）                            | Web / 移动 / 桌面（React、Lit、Angular、Flutter 同一份 payload）  |
| 传输耦合       | 强耦合 MCP（必须是 MCP Apps 宿主）                           | 传输无关（A2A / AG-UI / MCP / SSE / WebSocket）                   |
| UI 状态归属    | App 内部（宿主不可见，localStorage 不可用）                  | DataModel 是双方共享的唯一数据源，服务端可随时推送                |
| LLM token 成本 | 高（完整 HTML 文档，动辄数万 token）                         | 中（结构化 JSON + prompt 内嵌 schema 契约）                       |
| 生成可靠性     | 无法静态校验，坏 HTML 只能沙箱里"安全地烂掉"                 | 校验失败可回喂 LLM 纠错、可降级（Markdown / 表单）                |
| 宿主支持       | Claude、VS Code Copilot、Goose、Postman 等 MCP Apps 宿主     | CopilotKit 生态、自建 renderer（React/Lit/Angular/Flutter）       |
| 典型场景       | 地图、3D、PDF/富媒体查看器、复杂可视化、游戏                 | 对话内卡片、表单、图表、多 Agent 编排的 UI 委托                   |

### 6.4 关键差异展开

1. 信任模型：运行时隔离 vs 生成时约束。
   MCP Apps 把安全责任压在宿主的沙箱/CSP 实现质量上——模型复杂、存在需要持续防守的缺口（form-action、资源耗尽、钓鱼弹窗、过宽的 CDN 白名单）。A2UI 把安全责任前移到数据格式本身——"Agent 只能请求渲染 catalog 内组件"是一条可以静态验证的不变量，没有代码执行面，安全边界清晰且业务方可自行加固。前者表达力上限高但攻击面大，后者永远安全但表达力有天花板。

2. 表达能力：全 Web 平台 vs catalog 上限。
   一个 MCP App 可以跑 Cesium 地球仪、Three.js 场景、完整的 PDF 阅读器——catalog 模式下这些需要逐个封装成自定义组件。反过来，A2UI 生成的 UI 永远与宿主 App 视觉一致，而 MCP App 的 iframe 是样式孤岛，只能靠宿主注入的 CSS 变量近似模仿主题。选哪个取决于你要"富到什么程度"和"像不像产品本身"。

3. 渲染与性能：iframe 的代价。
   iframe 是独立浏览上下文：独立 DOM 树、样式表、JS 执行环境。对话流里每插一块 UI 就多一个 iframe，创建与通信开销大，高度自适应、滚动联动都要跨框架协调；A2UI 组件直接渲染在宿主树里，配合信号订阅实现单组件粒度的细粒度更新。UI 数量多的对话场景，A2UI 的成本结构明显更优。

4. 数据流：RPC 拉取 vs 声明式绑定。
   MCP App 拿数据靠主动 `callServerTool`（每次一个往返），UI 状态锁在 iframe 里宿主看不见；A2UI 的 DataModel 是双方共享的可观察状态——服务端可以 `updateDataModel` 随时推送，输入组件双向绑定本地写回，action 触发时按路径回传上下文（或整个模型）。A2UI 的数据架构天然贴合"对话推进、UI 跟着变"的交互形态。

5. 流式与增量：为 LLM 而生的设计差异。
   A2UI 的扁平邻接表、乱序可达、root 缓冲、模板绑定，全部为"LLM 边生成边渲染"服务，首屏延迟低；MCP App 的 HTML 是一个原子文档，只有参数是流式的，内容必须等生成完、校验不了、整体替换。对交互延迟敏感的长 UI，A2UI 的体验上限更高。

6. 可校验性与失败语义。
   A2UI 有完整的失败工程学：schema 校验 → 错误回喂纠错 → 逐条抢救 → 降级（Markdown/表单）→ 诚实提示。MCP App 的失败语义只有一种：沙箱保证坏代码"安全地"什么都不显示，你无法在渲染前知道它会白屏。对无人监督的自动化场景，这是可靠性上的实质差距。

7. 可移植性。
   iframe 决定了 MCP Apps 只存在于 Web 宿主；A2UI 的一份 JSON 可以同时驱动 React 网页、Angular 控制台和 Flutter 移动端。若产品要跨端复用 Agent 的 UI 输出，A2UI 是唯一现成答案。

8. 协议耦合与生态位。
   MCP Apps 是 MCP 扩展，天然被"MCP 宿主是否实现了这个扩展"卡住；A2UI 传输无关，A2A（AgentCard 扩展协商）只是其最主流的传输层。两者还可以嵌套：按调研资料（yukino-mcp 的文档副本）的说法，A2UI 生态下的承载方式是——自定义组件用 smart wrapper 模式包装 MCP App 的 iframe，外层维持结构化 JSON-RPC 通道，内层严格排除 `allow-same-origin` 防沙箱逃逸（注意：A2UI 官方规范本身只声明了"A2UI 可经 MCP 传输"的绑定，并未规定 iframe 承载细节，上述描述属于生态实践转述）。也就是说在 A2UI 的世界观里，MCP App 是一种"需要双 iframe 隔离的富组件"；两者是互补而非互斥。

9. 上下文经济学：同一笔账，四种费率。
   两个协议的 UI 描述都"进上下文一次"——A2UI 的 `<a2ui-json>` 块是助手回复正文的一部分，MCP Apps 的 HTML 是 tool_use 入参，都是模型亲手写的输出并驻留历史，没有谁天然更省。分野在完整生命周期的四笔账上：

| 成本项                    | A2UI                                                                                                             | MCP Apps                                                           |
| :------------------------ | :--------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------- |
| 固定契约（system prompt） | 重：prompt-first 设计要求内嵌协议 schema + catalog 契约                                                          | 轻：只多一个工具定义                                               |
| 首帧生成                  | 声明式 JSON 进上下文（同一界面的 JSON 描述通常比等价 HTML+CSS+JS 紧凑得多）                                      | 完整文档进上下文，动辄几万 token                                   |
| 更新                      | 便宜：增量 patch——一条 `updateComponents` / `updateDataModel` 小消息进历史                                       | 贵：全量重生成整页 HTML，旧版仍驻留待压缩                          |
| 交互                      | 贵：每次 action 把 surface 全量消息列表回传服务端（如 yukino-agent 的 out-of-band 管线），成本随交互次数线性增长 | 免费：本地交互与 `callServerTool` 走协议旁路，不增一个上下文 token |

交互成本的方向性差异还带来语义差别：留在上下文里的 A2UI JSON 是"活"的——后续轮次模型能读到并修改它，服务端 action 管线也依赖它作为权威状态；MCP Apps 留在历史里的 HTML 是"死"的——生成之后无人引用，只等上下文压缩清走。

一句话：A2UI 把 UI 状态放进上下文（交互围绕模型转），MCP Apps 把 UI 状态放进沙箱（交互绕开模型转）——前者买到"更新的便宜"，后者买到"交互的免费"。选型时估一下预期对话里"改需求"和"点按钮"哪个更频繁，这笔账就算清楚了。

### 6.5 选型建议

选 MCP Apps，当：

- 需要的是富媒体/重型可视化（地图、3D、PDF、音视频、图表库全家桶），catalog 组件表达不了；
- 产物只面向 MCP 宿主（Claude / IDE Copilot 等），且宿主的沙箱实现可信；
- UI 是"查看器/工作台"形态，不需要与宿主产品设计系统严格一致。

选 A2UI，当：

- UI 是对话内卡片、表单、列表、图表这类结构化交互，catalog 组件足够覆盖；
- 要求 UI 与宿主设计系统完全一致、无 iframe 开销、支持渐进渲染；
- 需要跨信任边界的多 Agent 委托（编排者渲染第三方 Agent 的 UI 并校验其身份归属）、或需要跨端渲染（Web/移动/桌面同一份 payload）；
- 生成链路需要可校验、可纠错、可降级的可靠性工程。

两者同时用的形态：A2UI 宿主通过 smart wrapper + 双 iframe 承载 MCP App（富组件），MCP 宿主也可以把 A2UI JSON 作为工具结果交给自定义渲染器。数据形状简单、追求安全与一致性 → A2UI；内容复杂、追求表达力与生态工具 → MCP Apps。

---

## 7. 总结

MCP Apps 用"工具 + `ui://` 资源 + 沙箱 iframe"这个极小的协议增量，把 Claude Artifacts 式的交互体验开放给了整个 MCP 生态：模型照常调用工具，宿主多渲染一块 UI，不受信的 HTML 被沙箱和 CSP 关在笼子里。它的工程成本集中在两端——宿主要把沙箱和 CSP 做严，Server 作者要处理好大 payload 通道、构建单文件与降级路径。

与 A2UI 相比，两者是同一问题域的两个极点：MCP Apps 信任沙箱，A2UI 信任数据。前者用表达力换攻击面，后者用 catalog 天花板换安全与一致性；前者绑定 MCP 宿主，后者传输无关、多端可渲染。它们甚至能互相嵌套。理解"这条 UI 是代码还是数据"这一个问题，就能推演出两者全部的设计差异与选型边界。

---

## 8. 完整流程闭环：从需求到渲染，从交互到更新

以上述 `render_app` 工具为例走一遍完整闭环。场景：用户说 _"画一个 2026 年 Q3 每周 QPS 的柱状图"_，之后又改需求、又在图里点了按钮。四个角色：用户、模型（住在宿主里）、宿主（协议端点 + 沙箱执行者）、MCP Server、App（宿主挂载的 iframe）。

### 8.1 第一圈：需求 → 首帧渲染

```
阶段一　生成与预加载（与工具执行并行推进）
────────────────────────────────────────────────────────────
①  用户 ── "画一个 QPS 柱状图" ──> 模型

②  模型 ── 流式生成 tool_use: render_app
            { html: "<!doctype html>…", title }
            ★ HTML 唯一进入模型上下文的位置——它是模型自己的输出

③  宿主 ── resources/read "ui://render-app/mcp-app.html" ──> Server
            <── 自包含单文件 HTML（宿主已缓存时本步跳过）
            ★ 触发源不是"调用发生"，而是会话建立时 tools/list 已带回映射
              （render_app 的 _meta.ui.resourceUri）；流里刚出现工具名
              （name 字段先于参数生成），宿主查表即知该渲染哪个 UI，
              无需等 ② 完成。资源是静态声明的容器，与 html 参数内容无关。

④  宿主 ── 挂载沙箱 iframe + ui/initialize 握手 ──> shell
⑤  宿主 ── ui/notifications/tool-input-partial ──> shell
            shell 状态条："Generating app… N KB"
            （③④⑤ 只依赖参数在流式生成这一事实，不必等 ② 完成）

阶段二　工具执行
────────────────────────────────────────────────────────────
⑥  宿主 ── tools/call render_app ──> Server
            <── { content, structuredContent:{title}, _meta:{html} }

阶段三　结果分叉与渲染（一次结果，两条通道）
────────────────────────────────────────────────────────────
⑦  宿主 ── 一行文本回执（tool_result）──> 模型上下文
            只含 content："Rendered interactive app …"
            ★ 模型由此只知道"渲染成功"，看不到也不需要看到 HTML

⑧  宿主 ── ui/notifications/tool-result（含 _meta.html）──> shell
            ★ HTML 走 UI 专用通道，模型不可见

⑨  shell ── frame.srcDoc = html ──> 内层沙箱执行 JS
⑩  UI 首帧呈现：柱状图出现在对话流中（用户可见）
```

分步要点：

1. 入参即产物（②）。HTML 不是 Server 准备的，是模型在 tool_use 入参里现场写出来的——这是 HTML 唯一一次进入模型上下文的位置。
2. 准备与生成交错（③④⑤）。资源拉取、iframe 挂载、流式参数预览都不必等 HTML 生成完；宿主可以预加载 `ui://` 资源、甚至在参数还在生成时就挂好 iframe，这是"首帧快"的关键。
3. 结果一分为二（⑦⑧）。同一次调用的结果，`content` 一行文本回给模型、`_meta.html` 经通知推给 shell——两条通道、两种受众（呼应 §4.1 的可见性表）。
4. shell 的两个渲染时机都生效：`ontoolinput`（完整入参先到就先渲染）与 `ontoolresult`（权威结果到达后校准）。

### 8.2 第二圈 A：用户更新需求（对话驱动，经过模型）

用户接着说：_"改成折线图，加上环比。"_ 这条更新走的是对话正向链路：

```
用户 ──"改成折线图，加环比"──> 模型
模型 ── 新的 tool_use: render_app { html: <新版整页 HTML> } ──> 宿主
宿主：resourceUri 未变 → 不重拉资源、不重建 iframe
宿主 ── ui/notifications/tool-result ──> shell
shell ── setState(ready) ── srcDoc 整体替换 ──> 新版 UI（内层状态清零）
```

三个关键语义：

- 资源复用：新调用引用同一个 `ui://render-app/mcp-app.html`，宿主已持有该资源，不再发起 `resources/read`；iframe 也已挂载，只是收到新的 tool-result 推送。
- 全量替换：shell 的更新方式是重设 `srcDoc`——内层文档整体重建，用户在内层积累的运行时状态（滚动位置、未提交的表单输入、JS 内存状态）会清零。这是"对话驱动改版"的合理语义（新版本来就是重画的页面），但意味着任何需要保留状态的长交互都不该依赖这条路。
- 上下文成本：每一次"改需求"，模型都要重新生成整份 HTML（输出 token），旧版 tool_use 入参仍留在历史里。

### 8.3 第二圈 B：App 内交互（绕过模型）

用户没说话，直接在图上点了"刷新数据"按钮。这一圈的更新不经过模型，按交互形态分三种：

B1 — 本地交互（零回程，最常见）：排序、筛选、tab 切换、hover 提示——内层 JS 直接改自己的 DOM。不发生任何协议消息，模型无感知，状态自然保留。

B2 — 回程取数（callServerTool 代理）：点击需要新数据的按钮（如"刷新"）。MCP App 的标准能力是 App 反向调 Server 工具：

```
内层 HTML 按钮 onclick
  ── window.parent.postMessage({type:"render_app:callTool", name, arguments}) ──> shell
shell：校验 event.source === frame.contentWindow（opaque origin 下 origin 恒为 "null"，
       只能靠 source 比对确认消息来自自家 iframe；并对可调工具名做白名单）
  ── app.callServerTool({ name, arguments }) ──> 宿主
宿主 ── tools/call（代理转发）──> Server
Server 结果原路返回：宿主 → shell → postMessage 回内层
内层 JS ── 局部更新 DOM（图表重绘，不重载页面，状态保留）
```

需要区分两种 App 形态：

- 直连型（官方 map-server / system-monitor 这类）：App 代码本身就是 `App` bridge 的持有者，按钮 onclick 里直接 `app.callServerTool(...)`，不需要任何中转。
- 托管型（`render_app` 这类）：bridge 在外层 shell 手里，内层是隔离的不可信 srcdoc。内层要回程取数，必须经 shell 中转——即上面的 postMessage 桥。当前 shell 尚未内置这座桥，需要按上述模式扩展（约 30 行：监听 message → 校验 source 与工具白名单 → `callServerTool` → 回发结果；内层配一个 `callTool(name, args)` 的 Promise helper）。

B3 — 通知模型（让对话接续）：如果 App 内发生的事需要模型知道（例如用户在 App 里完成了提交，希望对话继续），App 调 `ui/update-model-context` 把结构化摘要注入模型上下文。这是唯一一条"App → 模型"的显式通道；没有它，内层发生的一切对对话是不可见的。

### 8.4 收束：teardown

对话推进导致宿主卸载这块 UI，或 App 主动请求关闭时：

```
宿主 ── ui/resource-teardown ──> shell
shell onteardown() { return {} }   ← 保存状态/关闭连接的机会
宿主 ── 移除 iframe，释放渲染进程
```

### 8.5 闭环全景

| 触发源         | 通道                                      | 经过模型？              | UI 更新方式     | 内层状态 |
| :------------- | :---------------------------------------- | :---------------------- | :-------------- | :------- |
| 首次需求       | tools/call + tool-result 推送             | 是（生成 HTML 入参）    | srcdoc 首次挂载 | —        |
| 更新需求       | 新 tool_use + 推送（资源/iframe 复用）    | 是（重新生成整页 HTML） | srcdoc 整体替换 | 清零     |
| App 内本地交互 | 无（内层 JS 直改 DOM）                    | 否                      | 局部更新        | 保留     |
| App 内回程取数 | postMessage → shell → callServerTool 代理 | 否                      | 局部更新        | 保留     |
| App 通知模型   | ui/update-model-context                   | 注入（受控）            | 不直接改 UI     | 保留     |
| 结束           | ui/resource-teardown                      | —                       | 卸载            | —        |

整条闭环的设计意图可以压缩成一句话：模型负责"决定 UI 长什么样"（生成/更新 HTML，唯一进上下文的部分）；一旦 UI 活起来，后续的交互与数据刷新尽量留在沙箱内、走协议旁路，模型只在被显式叫到时才回到对话里。 这也是 MCP Apps 与 A2UI 的分野在流程层的体现——A2UI 的每一步交互天然经过 DataModel 这条共享通道，而 MCP Apps 的默认姿态是"能用旁路就别打扰模型"。
