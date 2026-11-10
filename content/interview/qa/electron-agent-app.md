---
title: "Electron 桌面 Agent 应用"
description: "60 题：Electron 三进程架构与 electron-vite 构建分层、contextIsolation 与 CSP 安全模型、IPC 通道设计与 pending-promise 模式、渲染进程驱动 agent 会话（Remote.Server.createRemoteAgent 与 CLI 复用同一核心）、工作区乐观并发与冲突检测、窗口与应用生命周期、electron-builder 多平台打包、自动更新基础设施、Playwright 冒烟测试、桌面端性能与 Electron/Tauri/Web 取舍，全部结合 yukino-code apps/app 源码佐证"
---

:::note 事实基线

- 仓库 `$HOME/github/yukino-code`, HEAD `7b9add587b16`（40 位 `7b9add587b16444631dd5ab4e2a317c9679eaf63`），证据子路径 `apps/app/`。
- 本机基线：Node `v22.23.2`, Electron `^44.9.3`, React `^19.3.1`, Tailwind CSS `^4.3.3`, TanStack Query `^5.106.1`。
- 源码目录：`src/main/`（5 文件，核心是 2342 行的 `yukino-bridge.ts`）、`src/preload/`、`src/renderer/`、`src/shared/`、`electron.vite.config.ts`、`electron-builder.yml`、`dev-app-update.yml`、`tests/`、`scripts/release.mjs`，引用路径相对 `apps/app/`。
  :::

本篇是「Electron 桌面 Agent 应用」题库精讲，聚焦**桌面壳与进程间架构**。agent 循环、权限管线、工具执行的内部机制归 [Agent 执行循环与工具体系](/interview/qa/agent-loop-and-tools)，本篇只讲桌面端如何**驱动与封装**它。

**主线一览**

```mermaid
flowchart LR
  subgraph Renderer[渲染进程 React]
    UI[chat-state reducer<br/>+ use-chat rAF 合帧]
  end
  subgraph Preload[preload 上下文隔离桥]
    API[window.api<br/>类型化 facade]
  end
  subgraph Main[主进程]
    B[YukinoBridge] --> H[RemoteAgentHandle<br/>@yukino.js/yukino 全栈]
    B --> W[Workspace 文件后端]
  end
  UI -- "invoke(32 通道)" --> API --> B
  B -- "yukino:event 推送 BridgeEvent" --> API --> UI
```

## 一、三进程架构与工程分层

### Q1. Electron 的三进程模型是什么？各自职责边界在哪？

**main 进程**：唯一特权进程，持有 Node.js 与全部 Electron 系统 API（窗口、对话框、菜单、IPC 服务端），负责应用生命周期；**renderer 进程**：每个窗口一个 Chromium 渲染进程，跑 Web 页面，默认无 Node 权限；**preload 脚本**：在 renderer 加载页面**之前**、于隔离上下文中执行的桥接层，是 renderer 唯一能触达的特权入口。边界原则：renderer 只做展示与交互状态，一切系统能力（文件、子进程、agent 运行时）经 preload 暴露的白名单 API 向 main 请求。项目严格对应：`src/main/`（5 文件）、`src/preload/index.ts`（139 行 facade）、`src/renderer/`（React 应用）。

### Q2. 项目的目录分层与「单一契约」怎么组织？

四个源码域：`src/main`（主进程）、`src/preload`（桥）、`src/renderer/src`（React UI）、`src/shared`（**跨进程共享类型**）。`src/shared/ipc-types.ts`（286 行）是唯一的 IPC 契约文件：`BridgeEvent` 联合、`InitState`、`PermissionRequestPayload`、`SessionSummary`、`YukinoApi` 接口等全部在此定义，main 与 renderer 各自 import 同一份类型。头注释就是纪律本身：_"Everything crossing the contextBridge must be plain JSON — no Error objects, no class instances, no functions."_ 类型先行让「preload 暴露什么、事件长什么样」在编译期对齐，三端漂移直接 typecheck 失败。

### Q3. electron-vite 怎么为三个目标分别构建？

`electron.vite.config.ts` 三段配置：`main` 与 `preload` 都开 `build.externalizeDeps: true`（依赖不打包，运行时从 node_modules 解析）；`renderer` 走标准 Vite（`@vitejs/plugin-react` + `@tailwindcss/vite`）。四组 alias（`@main/@preload/@renderer/@shared`）三端共享。开发态 `electron-vite dev` 起 Vite dev server 并把地址注入 `ELECTRON_RENDERER_URL`，主进程据此 `loadURL`（HMR）；生产态 `loadFile("../renderer/index.html")`（`src/main/index.ts`）。**采分点**：说得出「dev 走远程 URL、prod 走本地文件」这条分叉及其原因（HMR 需要 http 源）。

### Q4. 为什么 main 进程要 externalizeDeps 而不是全部打包？

`electron.vite.config.ts` 注释给出直接原因：`@yukino.js/yukino` 是 **ESM-only** 包，打包进 CJS 产物会破坏其模块语义；externalize 后由 Electron 内置 Node（22.12+ 支持 `require(esm)`）在运行时直接解析。附带收益：agent 核心及其庞大依赖树（SDK、MCP、telemetry 可选依赖）不进 bundle，主进程产物只有桥接代码，构建快、sourcemap 干净、依赖升级不需要改构建配置。代价是分发时必须带上 node_modules（electron-builder 的 files 规则负责）。

### Q5. 一个仓库里怎么同时类型检查 Node 端与 Web 端代码？

三套 tsconfig 三个命令（`package.json`）：`typecheck:node`（`tsconfig.node.json`:main/preload，Node lib + DOM 关闭）、`typecheck:web`（`tsconfig.web.json`:renderer，DOM lib）、`typecheck:test`（tests 独立配置），`typecheck` 串行跑三个，且都带 `--composite false` 防增量产物污染。必要性：main 里写 `document` 或 renderer 里写 `process.exit` 都必须在编译期报错——**进程边界的类型化是 Electron 项目最便宜的护栏**。`pnpm happy` = typecheck + lint + build + test 一键全检。

### Q6. agent 核心为什么跑在 main 进程而不是 renderer？

四个理由：① 权限——agent 要 spawn 子进程（Bash 工具、MCP stdio server）、读写任意项目文件，这些是 Node 特权，放进 renderer 等于给网页开 nodeIntegration；② 生命周期——renderer 随窗口刷新/崩溃重启，agent 会话、后台任务、团队进程必须活得更久（main 常驻）；③ 单例——`YukinoBridge` 持有唯一 `RemoteAgentHandle`，多窗口共享同一会话状态（`emit()` 广播到所有窗口）；④ 安全面收敛——renderer 被 XSS 攻破时，攻击者只有 `window.api` 的白名单面，没有 Node。

### Q7. YukinoBridge 的「双向适配」职责是什么？

`src/main/yukino-bridge.ts` 头注释：库入口 `Remote.Server.createRemoteAgent` 初始化完整 agent 栈（tools、LLM client、conversation、session、MCP、memory），`handle.run()` 产出 AgentEvent 异步生成器。桥做两个方向的适配：**下行**把生成器事件转成 IPC 推送（`emitAgentEvent` → `yukino:event` 通道的 `BridgeEvent`）；**上行**把 agent 的权限/提问回调转成「挂起 Promise ↔ 渲染器应答」的交换（`createPermissionCallback`/`createAsker`）。这就是「同一 agent 核心、不同宿主壳」架构的桌面实现——CLI 壳是 TUI 事件消费，WS 壳是 WebSocket 推送，桌面壳是 IPC 推送，核心零改动。

### Q8. RemoteAgentHandle 创建时传了哪些桌面端特有关切？

`createHandle()`（yukino-bridge.ts）组装 `CreateRemoteAgentOptions`:`interactionMode: "interactive"`、`enableModelPlanMode: true`、`cwd`、`enableCoordinatorMode`（来自配置）、`memoryEnabled`、`mcpLoading`、`askUser: this.createAsker()`（问题弹窗桥）、`onSubagentEvent`（子代理活动上报）、可选 `hooks/mcpServers/sandboxConfig`。创建后立刻 `handle.permissionMode = config.permission_mode ?? "default"`，并 `Workflow.Wiring.getWorkflowService(handle.registry)?.loadPersistedRuns()` 恢复持久化的 workflow run——**失败则 `handle.dispose()` 再抛**，不留半初始化句柄。权限审批回调不在这里传，而是每次 `handle.run()` 时经 `onPermissionRequest` 注入（runLoop 内）。

## 二、安全模型

### Q9. contextIsolation 与 contextBridge 是怎么用的？

`src/preload/index.ts` 末尾：`process.contextIsolated` 为真（Electron 现代默认）时走 `contextBridge.exposeInMainWorld("electron", electronAPI)` 与 `exposeInMainWorld("api", api)`；非隔离分支则直接挂 `window`。contextIsolation 的本质：preload 与页面 JS 跑在**同一进程的不同 V8 上下文**，页面拿不到 preload 作用域里的任何对象，只能通过 contextBridge 显式暴露的冻结接口通信——原型链污染无法越界。`window.api` 的每个方法都是 `ipcRenderer.invoke` 的薄包装，注释明言：_"the renderer never touches Node or Electron internals directly"_。

### Q10. 项目的 webPreferences 配置暴露了什么取舍？

`src/main/index.ts` 的 BrowserWindow:`preload: join(__dirname, "../preload/index.js")`、**`sandbox: false`**。sandbox 关闭意味着 preload 脚本拥有完整 Node 能力（本项目 preload 只 import electron API，但 @electron-toolkit/preload 的 electronAPI 需要 Node 侧能力）。这是常见工程取舍：sandbox: true 时 preload 只能用受限的 polyfilled Node。补偿控制：contextIsolation 保持默认开启、renderer 无 nodeIntegration、CSP 收紧（Q12）、window.api 白名单面。**面试立场**：能开 sandbox 就开；关它必须说清 preload 依赖了什么、补偿措施是什么。

### Q11. window.api 的白名单面设计好在哪？

preload 暴露 32 个 `ipcRenderer.invoke` 方法 + 2 个订阅（`onEvent`/`onTheme`），每个都是**具名、定参、定返回类型**的通道包装——没有 `invoke(anyChannel, ...args)` 这种万能透传。安全价值：renderer 被攻破后，攻击者能做的全部事情 = 这 32 个方法的语义集合（发消息、读项目内文件、开对话框……），且每个通道在 main 侧还有二次校验（`assertIdle`、路径沙箱、白名单枚举）。万能透传则等于把 ipcMain 的全部 handler 面暴露给页面脚本。**facade 越窄、越具体，纵深越厚**。

### Q12. renderer 的 CSP 怎么配？各指令为什么这么写？

`src/renderer/index.html` 的 meta CSP:

```text
default-src 'self'; script-src 'self' 'unsafe-inline';
frame-src 'self' about:; style-src 'self' 'unsafe-inline';
img-src 'self' data: https:; worker-src 'self' blob:; font-src 'self' data:
```

逐条理由：`frame-src about:` 放行 MCP Apps 的沙箱 iframe（about:blank/srcdoc 承载）；`worker-src blob:` 放行 Monaco 编辑器的 web worker；`img-src data: https:` 支持内联图片与远程图；`style-src 'unsafe-inline'` 是 Tailwind/ css-in-js 的现实妥协；`script-src 'unsafe-inline'` 是全配置里最弱的一环——生产化应换成 nonce 或把内联脚本移出（Vite 构建产物本身是外链 script，'unsafe-inline' 主要兜底第三方注入）。**采分点**：能指出自己配置里最弱的指令并给收敛路径。

### Q13. 窗口打开外部链接怎么治理？

`setWindowOpenHandler`（`src/main/index.ts`）：一切 `window.open`/`target=_blank` 返回 `{action: "deny"}`——**绝不在应用内新开 BrowserWindow**（新窗口意味着新的攻击面与失控的 webPreferences）；URL 匹配 `/^https?:\/\//` 才转 `shell.openExternal` 交给系统浏览器，其他协议（`file:`、自定义协议）静默丢弃。这是 Electron 安全清单的标准项：不受控的 window.open 曾被大量应用用来钓出带 nodeIntegration 的新窗口。

### Q14. will-prevent-unload 处理什么场景？

renderer 里 Monaco 草稿触发 `beforeunload` 阻止关闭时，Electron 发 `will-prevent-unload` 事件。项目弹同步对话框（`dialog.showMessageBoxSync`, `src/main/index.ts`）：按钮 `["Return to Save"=0, "Discard and Close"=1]`, `defaultId: 0`、`cancelId: 0`。**源码逐字事实**：`if (choice === 1) { event.preventDefault(); }`——即选 Discard and Close 时调用 `event.preventDefault()`。需要如实标注：Electron 语义里 `will-prevent-unload` 的 `preventDefault()` 表示**阻止关闭**(保留窗口)，源码此处「Discard and Close → preventDefault」的按钮与动作映射与该语义相反，属待复核事实，文档不替源码纠正。没有这个处理，Electron 会静默忽略 beforeunload 直接关窗，用户草稿无声丢失。README 的对应承诺：草稿在编辑器关闭后仍存活，切项目/关文件/退出前都会处理未保存内容。

### Q15. 文件后端怎么防路径穿越与 symlink 逃逸？

`Workspace.safePath()`（`src/main/workspace.ts`）五道检查：① 非 string 或含 `\0` 直接拒；② `resolve(root, path)` 后做**词法**包含检查（`relative` 结果不得为 `..` 开头或绝对路径）；③ 对存在的目标 `realpath` 后再做一次包含检查——**防 symlink 把合法词法路径指向项目外**；④ 目标不存在（ENOENT，新建文件场景）时对父目录 realpath 再拼接重查；⑤ list 接口额外过滤 symlink 条目与 ignored 目录。冒烟测试有对应断言：`workspaceRead("../profile/state.json")` 必须失败（`tests/electron-smoke.ts`）。

### Q16. MCP Apps 的 iframe 沙箱怎么做到「每应用一策」？

渲染侧 `src/renderer/src/lib/mcp/sandbox.ts` 的 `buildAppCsp(csp)`：以 server 声明的 `resourceDomains/connectDomains/frameDomains` 构建**每个 app 独立的 CSP**——域名先过正则白名单（`^https?://(\*\.)?host(:port)?/?$`，非法项直接丢弃），然后拼 `default-src 'none'`; `script-src`/`style-src 'unsafe-inline' <resources>`; `img-src data: blob: <resources>`; `font-src data: <resources>`; `media-src data: blob: <resources>`; `connect-src <connections|'none'>`; `frame-src about: <frames>`; `object-src 'none'`; `base-uri 'none'`; `form-action 'none'`。要点：生成的 HTML 必须允许内联脚本（'unsafe-inline'），所以**隔离靠 default-src 'none' + 域名白名单 + iframe 沙箱属性**（`components/chat/mcp-app.tsx` 的 iframe `sandbox="allow-scripts"`、`referrerPolicy="no-referrer"`, srcdoc 承载，无 `allow-same-origin` 故为不透明源、访问不到宿主 cookie/storage），链接点击只放行 http/https（`MCP_APP_LINK_BLOCKED`）。初始化 20s、请求 10min、teardown 500ms 三个超时常量在 `lib/mcp/constants.ts`。

## 三、IPC 设计

### Q17. invoke/handle 与 send/on 各用在什么场景？项目的通道全景？

**请求-响应**用 `ipcRenderer.invoke` ↔ `ipcMain.handle`（Promise 语义、单返回值）：preload 侧 32 个 invoke 方法，main 侧 31 个 `ipcMain.handle` 注册，前缀分域——`workspace:list/read/save/snapshot`（文件后端）、`yukino:init/send/abort/new-session/list-sessions/resume-session/...`（agent 会话）、`yukino:get-settings/list-models/set-provider/set-model/set-thinking-level`（配置）、`yukino:respond-permission/respond-ask/respond-plan`（审批应答）。**服务端推送**用 `webContents.send` ↔ `ipcRenderer.on`：仅两个通道——`yukino:event`（BridgeEvent 事件流）与 `yukino:theme`（原生主题变化）。`registerIpc()`（yukino-bridge.ts 尾部）一次性注册全部 handler。

### Q18. 为什么事件流用单通道 + discriminated union，而不是每种事件一个通道？

`BridgeEvent`（`src/shared/ipc-types.ts`）是 20+ 成员的联合类型（`stream_text/tool_use/tool_result/permission_request/plan_approval/subagent/history/...`），全部走 `yukino:event` 单通道。收益：① **顺序保证**——单通道内事件天然有序，多通道无法保证 `tool_use` 先于 `tool_result` 到达；② 订阅面收敛——preload 只暴露一个 `onEvent`，renderer 的 reducer 是事件的唯一消费者；③ 类型穷尽——TS 对 union 的 switch 穷尽检查防漏处理。代价是通道内要按 `type` 分派，这正是 reducer 模式的本职。

### Q19. 权限审批的「挂起 Promise」模式怎么实现？

agent 核心的 `onPermissionRequest` 是异步回调，桌面端要把它变成「弹窗等人点」。`createPermissionCallback()`（yukino-bridge.ts）：生成 `perm-<randomUUID>` 的 id → `emit(permission_request)` 推给 renderer → 返回 `new Promise`，把 resolve 函数存进 `pendingPermissions` Map；renderer 用户点击后 `invoke("yukino:respond-permission", id, response)` → `respondPermission` 从 Map 取出 resolve 调用。abort 信号触发 `cancel()`：从 Map 删除（幂等守卫）→ emit `permission_resolved{deny}` → `resolve("deny")`。AskUserQuestion 同构（`ask-` 前缀、resolve `{}`）。**这是「把 UI 交互塞进回调链」的标准解法**：Promise 桥接 + id 关联 + 取消路径必须完备。

### Q20. 取消时为什么 resolve("deny") 而不是 reject？

agent 循环把权限回调的返回当作**决策**消费：`"allow" | "deny" | "allowAlways"`。reject 会让异常沿回调链上抛，把「用户取消」升级成「运行错误」——而语义上取消就是拒绝执行。resolve("deny") 让循环走正常的拒绝分支：工具不执行、配对 error result 回填、模型收到拒绝文案继续决策（权限拒绝文案见 [Agent 循环](/interview/qa/agent-loop-and-tools) Q29）。同理 ask 取消 resolve `{}`（空答案）。**原则：可预期的用户行为用值域表达，异常留给真正的故障**。

### Q21. emit() 为什么广播到所有窗口？

`emit()` 遍历 `BrowserWindow.getAllWindows()`，跳过 `isDestroyed()` 的窗口逐个 `webContents.send`。多窗口场景（主窗 + 未来可能的独立面板）共享同一 agent 会话，事件必须全量同步；isDestroyed 守卫防「窗口关闭竞态中 send 抛错」。renderer 侧的对应设计：`init()` 在已有 handle 时**重放**完整状态（init_state + history + run_state + pendingPlan，yukino-bridge.ts）——新开的窗口或刷新的页面靠重放对齐，而不是靠错过的事件。

### Q22. IPC 的类型安全怎么闭环？

三环：① `src/shared/ipc-types.ts` 定义 `YukinoApi` 接口（`window.api` 的完整签名）与全部 payload 类型；② preload 的 `api` 对象字面量按接口实现（`src/preload/shims.d.ts` 在 `declare global` 的 `Window` 接口上声明 `electron: ElectronAPI` 与 `api: YukinoApi`）；③ main 的 handler 参数与返回值使用同一批类型（`BridgeEvent`、`InitState`……）。任何一端改契约，另两端 typecheck 失败。局限要能说清：**类型只在编译期**，运行时 IPC 是结构化克隆，main 侧对 renderer 传入参数仍做运行时校验（如 permission-mode 的白名单 includes 检查、rewind mode 枚举校验）——渲染进程按不可信输入对待。

### Q23. assertIdle 闸门保护哪些操作？为什么需要它？

`assertIdle()`:`streaming` 为真直接 throw（"Stop the current task before switching projects, sessions, or settings"）。被保护的操作：newSession、resumeSession、selectFolder、runCommand、setModel、setProvider、setThinkingLevel、respond-plan、permission-mode 切换、rewind、save-provider、runtime-action 中的 clear_goal/reload_skills/reload_mcp/sandbox。原因：这些操作会**重建或重配 agent 句柄**（reinit 会 dispose handle），运行中执行等于抽掉正在跑循环的地基——会话状态、工具配对、后台任务全部悬空。桌面端没有 CLI 的「一次一命令」天然串行，必须显式闸门。

### Q24. main 进程 handler 抛错后 renderer 看到什么？

`ipcMain.handle` 的 handler throw → invoke 返回的 Promise 在 renderer 侧 reject，Electron 自动把 Error 序列化（message 保留、栈与自定义属性丢失，且带 "Error invoking remote method..." 前缀）。这正是 shared 契约注释「no Error objects」的由来：**跨 IPC 的错误只能是字符串语义**。项目的应对：main 侧抛业务化消息（"The file was modified by the agent or another program. Review the disk version before saving."），renderer 侧 `reportError` 统一 `toast.error(error.message)`；agent 运行错误则不走 throw，走 `BridgeEvent{type:"error"}` 事件流。

## 四、Agent 会话集成

### Q25. 桌面端怎么复用 CLI 的 agent 核心？

依赖 `"@yukino.js/yukino": "workspace:*"`（monorepo 内部包），入口是库化的 `Remote.Server.createRemoteAgent(options)` → `RemoteAgentHandle`。handle 暴露完整运行时：`run()`（事件生成器）、`steer()`、`abort()`、`conv`、`registry`、`checker`、`fileHistory`、`fileStateCache`、`backgroundTaskManager`、`teamManager`、`goalManager`、`skillCatalog`、`mcpManager`、`cmdRegistry`、`sessionId`、`permissionMode`、`dispose()`。桌面桥只做适配不复制逻辑——权限六层管线、压缩、记忆、团队全部是核心行为（见 [Agent 循环](/interview/qa/agent-loop-and-tools)）。**对照**：CLI 壳（TUI）、print-mode 壳（无头）、WS 壳（远程）、桌面壳（Electron）四壳一核。

### Q26. handle.run() 的事件怎么映射到渲染器？

`runLoop()` for-await 消费 `handle.run(expanded, {onPermissionRequest})`，每个 AgentEvent 经 `emitAgentEvent` 转 BridgeEvent:`stream_text/thinking_text/tool_use/turn_complete/loop_complete/usage/error/compact/retry` 一一映射；`tool_result` 额外做两件事——携带 `mcpApp` 时注册进 `RemoteMcpApps`（渲染器后续经 `yukino:mcp-app` 通道与之交互），`EnterPlanMode/ExitPlanMode` 成功时置 `planReady`；`thinking_complete/steering_delivered/permission_request` 显式忽略（注释：无需渲染器表示——权限走独立回调通道）。runLoop 还在 `tool_use` 时拦截 `Edit/Write/NotebookEdit` 的 file_path 做 `workspace.capture(path)`（编辑前基线快照，Q37）。

### Q27. send() 的三级分派是什么？

`send(text)`（yukino-bridge.ts）按状态分派：① **运行中**（streaming）→ 先试 `handle.steer(trimmed)`（成功即注入当前 run 的轮边界），steer 不可用则进 `followUps` 队列（run 结束后自动续发）；② **`!`/`!!` 前缀** → `Conversation.UserBash.parseUserBashCommand` 解析后走 `runUserBash`——直接从 registry 取 BashTool 实例执行，流式 `onOutput` 推 `tool_output` 事件，结果以 `user_bash` 消息存会话（`!!` 变体 `excludeFromContext`：执行但不进模型上下文）；③ **slash 命令** → `Commands.resolve` 命中则走命令分派（`/goal` 例外，进 runLoop 由核心处理），否则 ④ 普通文本进 `runLoop`。发送前先 `expandAtRefsWithImages` 展开 @ 引用与图片。

### Q28. completeRun 收尾时做哪三件事？

① `setStreaming(false)` + `broadcastUpdatedState`（重发 init_state 同步 header 徽章）；② 收 steering 残渣——`handle.takeSteeringLeftovers()`:run 结束时仍未投递的 steering 消息，非中断状态下转入 `followUps`（中断则丢弃，用户按了停止就是要停）；③ 分派下一步——`planReady && permissionMode === "plan"` 时加载 plan 文件生成 `pendingPlan` 并 emit `plan_approval`（**计划审批优先于续发**）；否则 `followUps.shift()` 有货就自动 `send(next)` 续跑。这实现了 README 说的「run 期间的后续要求」：忙时排队、闲时自动发。

### Q29. 后台任务完成后应用怎么「自动醒来」？

`startNotificationWakeup()`:500ms 的 `setInterval`（`.unref()` 不阻止进程退出），每拍检查——handle 存在、非 streaming、非 disposing、无 pendingPlan、followUps 空、非 interrupted，且 `backgroundTaskManager.hasNotifications() || teamManager.hasLeaderNotifications()` 为真时，`runLoop(handle, null)` 发起**无用户消息的续跑**（text=null 跳过 @ 展开，通知由核心在轮首以 reminder 注入）。这就是 README 的「后台工作完成时自动唤醒」：子代理/团队/后台命令的完成通知不需要用户点一下才被发现。所有跳过条件都在防「打断进行中的交互」。

### Q30. 权限请求的 payload 带了哪些桌面端增强信息？

`PermissionRequestPayload`（ipc-types.ts）：`id/toolCallId/toolName/args` 之外有三个 CLI 没有的字段——`reason`（权限系统附加的人类可读原因，直接展示给用户）、`rememberPatterns`（「always allow」将持久化的规则 pattern，UI 可预览授权范围）、`source?: {agentName, cwd}`（**请求来自哪个 subagent**——委派代理的审批要标明 origin，用户才知道是谁在要权限）。审批应答三值 `allow | deny | allowAlways` 与核心的 `requestToolPermission` 语义一一对应。

### Q31. plan 审批的桌面端闭环怎么走？

① 模型在 plan mode 完成计划 → `ExitPlanMode` 成功 → `planReady = true`；② `completeRun` 读 `PlanFile.loadPlan(handle)` 生成 `pendingPlan{id, content, path}`，emit `plan_approval`；③ 用户在 UI 审阅，`invoke("yukino:respond-plan", id, choice, feedback?)`；④ main 侧校验 `plan?.id === id`（过期报 "The plan request has expired"）+ `assertIdle`；⑤ `choice === "feedback"` → 反馈文本直接进 `runLoop`（继续规划）；`choice === "approve"` → `handle.checker.exitPlanMode("default")` + 注入 `buildPlanModeExitReminder` + `runLoop(buildPlanExecutionPrompt(plan.content))` 开始执行。`abort()` 会清空 pendingPlan 并 emit `plan_approval: null`——**中断即撤审批**。

### Q32. 跨项目会话恢复怎么处理路径别名？

`resumeSession(sessionId, cwd?)`：会话可能属于另一个项目，需先切 cwd 再加载。关键细节（注释原话）：**比较 canonical project key 而非原始字符串**——应用持久化的 cwd 可能是未解析的别名（symlink、macOS `/var` vs `/private/var`），而活动注册表记录的是 canonical 路径；两边都过 `Storage.projectKey()`（sha256(canonicalPath)）再比。不同则 `reinit(cwd)`（完整重建：dispose handle/workspace → 清定时器 → abort streaming → init）。恢复序列：stopAll 后台任务与团队 → `Session.loadSession` → `handle.stopMemoryTasks()` → `Remote.SessionState.restoreRemoteSession` → `rebuildFromSession({includeExcludedUserBash: true})` 投影历史（`!!` 排除的命令恢复时也带回来展示）。

### Q33. rewind（检查点回退）的三种模式怎么实现？

`rewind(id, mode)`:mode ∈ `code_only | conversation_only | code_and_conversation`（运行时白名单校验）。代码侧：`handle.fileHistory.rewind(index)` 按快照恢复文件。会话侧：先 `stopMemoryTasks()`，快照带 `sessionLineCount` 时 `Session.truncateSessionLines` 截断 jsonl → `conv.reset()` → 从磁盘重建；否则退化 `conv.truncateTo(messageIndex)`；然后**重建 GoalManager**（goal 状态绑定会话）并走一遍 `resumeSession` 同步 UI。检查点数据来自 `handle.fileHistory.getSnapshots()`（快照字段：`id`、`messageIndex`、`userText`、`backups`、`timestamp`、可选 `sessionLineCount`）。收尾 emit `workspace_changed` + system 消息。三模式对应 [Agent 循环](/interview/qa/agent-loop-and-tools) Q78 的「代码、对话、日志三时间轴」——桌面端把选择权交给用户。

## 五、工作区与编辑器后端

### Q34. 文件监听怎么做的？防抖窗口多大？

`Workspace.start()`（`src/main/workspace.ts`）：`fs.watch(cwd, {recursive: true})`，事件回调先过滤——无 filename 或路径任一段命中 `ignored` 集合（`.git/node_modules/dist/out/.next/coverage/.turbo`）直接忽略；然后 **180ms 防抖**（clearTimeout + setTimeout 重置），到期回调 `onChange(path)` → bridge emit `workspace_changed`。watcher 出错或 watch 抛异常时 `onChange(null)`——null 表示「全量刷新」语义。取舍：recursive watch 在超大目录有平台差异（Linux inotify 上限），ignored 集合把最大的噪声源（node_modules、.git）挡在事件流外。

### Q35. 编辑器保存怎么和 agent 写文件防冲突？

**乐观并发控制**：`FileSnapshot.revision = sha256(content)`。renderer 读文件拿到 revision，保存时带回（`workspace:save(path, content, revision)`）；main 侧 `save()` 在 `FileMutationQueue.withFileMutationQueue(target, ...)` 互斥区内**重读磁盘**，`current.revision !== expectedRevision` 即抛 "The file was modified by the agent or another program. Review the disk version before saving."——agent 刚改过的文件不会被用户基于旧视图的保存静默覆盖。队列本身与 agent 核心共享（`Tools.FileMutationQueue`），编辑器写入与工具写入在**同一把文件互斥锁**下排队。

### Q36. diff 基线（baseline）怎么解析？

`read()` 的三级回落：① 内存 `baselines` Map（本轮编辑前 capture 的快照）；② git——`git rev-parse --show-prefix` 拿仓库内前缀后 `git show HEAD:<prefix><path>`（`maxBuffer` 2MB），即 README 说的「以本次编辑前内容或 Git HEAD 为基线」；③ git 失败（非 git 项目/新文件）→ 基线 = 当前内容（无 diff 可显示）。已删除文件无基线时抛 "The file no longer exists"。`capture(path)` 在 agent 的 Edit/Write/NotebookEdit `tool_use` 事件时调用（runLoop 拦截），**赶在工具执行前**存下「模型即将修改的文件长什么样」——用户因此能看到「agent 这次改了什么」而不是「相对上次 commit 改了什么」。

### Q37. beforeWrite 回调为什么同时动 fileHistory 和 fileStateCache？

Workspace 构造时注入的 `beforeWrite`:`handle.fileHistory.trackEdit(path)` + `handle.fileStateCache.delete(path)`（yukino-bridge.ts initialize）。两个动作对应 agent 核心的两个机制：trackEdit 让**用户的手动保存**也进入文件历史（否则 rewind 只能恢复 agent 的改动，用户编辑丢失）；fileStateCache.delete 使核心的 read-before-edit 缓存失效——文件被编辑器改过后，模型必须**重新 ReadFile** 才能再 EditFile（mtime 校验的桌面版协作，防模型基于过期内容做精确匹配编辑）。这是「双写者共享一致性状态」的最小实现。

### Q38. 文件读取有哪些内容级防护？

`read()` 四道：① `stat` 非文件 → "Select a file"；② `size > 2MB` → "The file exceeds 2 MB. Open it in an external editor."（README 同款承诺）；③ `bytes.includes(0)` → 二进制检测，"This file is binary and cannot be edited as text"；④ `new TextDecoder("utf-8", {fatal: true})`——非法 UTF-8 序列直接抛错而不是替换字符乱码入库。保存侧对称：content 非 string 或字节数超 2MB 拒绝。**fatal: true 是容易被忽略的细节**：宽松解码会把损坏文件「洗白」成含 U+FFFD 的新内容，保存回去就是真损坏。

### Q39. git 状态快照怎么解析？非 git 目录呢？

`snapshot()` 并行三条 git 命令：`status --porcelain=v1 -z --untracked-files=normal -- .`、`branch --show-current`、`rev-parse --show-prefix`。解析细节：`-z` 用 NUL 分隔（文件名含空格/换行安全）；每条记录前 2 字符是状态码、第 3 字符起是路径；**R/C（重命名/复制）状态占两条记录**，解析时 `index++` 跳过旧名；仓库前缀（monorepo 子目录场景）从路径剥掉，返回相对项目根的路径。detached HEAD 显示 "detached"。任何 git 失败（非 git 目录、git 未安装）→ 降级：`branch: null` + 用 watcher 积累的 `changed` 集合伪造 "M" 状态——**UI 永远有可用数据，git 只是增强**。

### Q40. 项目打开前的校验做什么？错误怎么分类？

`resolveProject(path)`（`src/main/project.ts`）：`realpath` 解析 → `stat().isDirectory()` → `access(R_OK | X_OK)`。失败按 errno 分类成用户可行动的文案：ENOENT/ENOTDIR → "The project folder was moved or deleted. Select it again."；EACCES/EPERM → "Cannot access the project folder. Check its permissions or choose another project."；`ProjectError` 携带 path 供 UI 展示细节。初始化错误统一走 `initError(message, {kind: "project"|"config"|"runtime", details, configPath})`——`InitState.ok:false` 带 kind 与 configPath，renderer 按 kind 给恢复引导（配置错误直接给「打开配置文件」按钮，`yukino:open-config` 通道 `shell.openPath`）。README:「不可用项目在启动前校验路径与权限；初始化错误给出简明恢复指导」。

## 六、生命周期与窗口管理

### Q41. 窗口创建有哪些体验细节？

`createWindow()`（`src/main/index.ts`）：1480×920 初始、880×540 最小；**`show: false` + `ready-to-show` 再 show**——防白屏闪烁（内容画好前不亮相）；`backgroundColor: "#f8faf7"` 与 UI 主题同色，ready 前的瞬间也是品牌色而非白；macOS `titleBarStyle: "hiddenInset"` + `trafficLightPosition: {x:16, y:16}`（自绘标题栏、红绿灯内嵌）；`autoHideMenuBar: true`；Linux 显式 icon（Windows/macOS 用打包图标）。dev/prod 加载分叉见 Q3。

### Q42. macOS 的窗口生命周期有什么特殊处理？

两条平台惯例：① `window-all-closed` → 非 darwin 才 `app.quit()`——macOS 应用关窗后常驻 Dock，Cmd+Q 才退出；② `activate` 事件（点 Dock 图标）→ `BrowserWindow.getAllWindows().length === 0` 时重建窗口。另有 `electronApp.setAppUserModelId("com.yukino.app")`（Windows 任务栏分组标识）与 `optimizer.watchWindowShortcuts`（dev 下 F12 开 DevTools、prod 下屏蔽 Cmd/Ctrl+R 刷新——**生产环境禁刷新防用户误触丢状态**，来自 @electron-toolkit/utils）。

### Q43. 退出时的异步清理怎么不丢事件？

`will-quit` 处理器（`src/main/index.ts`）：首次触发 `event.preventDefault()` **拦下退出**，`bridge.dispose()` 完成后再 `setImmediate(() => { shuttingDown = true; app.quit(); })` 重新发起退出——第二次进 handler 时 `shuttingDown` 为真直接放行。为什么必须这样：Electron 的 will-quit 不等待异步操作，直接 quit 会掐断 dispose 里的 await 链（agent 句柄、MCP 子进程、文件 watcher 都来不及清理）。`setImmediate` 而非同步递归，是让 preventDefault 的状态先落地。**这是「异步清理 × 同步退出事件」的标准解法**。

### Q44. bridge.dispose() 的清理顺序为什么重要？

`dispose()`（yukino-bridge.ts）顺序：① `disposing = true`（唤醒轮询看到即跳过）；② 清 wakeup 定时器；③ **await initPromise**——初始化进行到一半就退出时，等它完成再拆，防「创建中的 handle 泄漏」；④ `abort()`（中断流式 run、清 followUps/pendingPlan、abort commandController）；⑤ `resetSessionUi()`（清 subagents、`mcpApps` 注册表、pendingPlan 与 planReady 状态）；⑥ workspace.dispose（关 watcher、清防抖 timer）；⑦ **所有挂起权限逐个 resolve("deny")、挂起提问 resolve({})**——不让任何 Promise 悬空；⑧ `handle.dispose()`（核心释放：后台任务、MCP 子进程、telemetry 等随远程句柄一并回收）。顺序原则：先断新工作入口，再等存量收敛，最后释放资源、兑现所有等待者。

### Q45. 应用级 UI 状态持久化在哪？写失败怎么办？

`StateStore`:`app.getPath("userData")/state.json`，只存两样——`cwd`（上次打开的项目）与 `theme`（system/light/dark）。read 容错（不存在/JSON 损坏返回 `{}`）；write 是 read+patch 合并后整体写回，**try/catch 全包裹**，注释原话："Best-effort persistence; never block the UI on it."——状态盘写失败（磁盘满、权限）不值得让用户操作报错。主题链路：`setTheme` → 持久化 + `nativeTheme.themeSource = mode` → 系统主题变化触发 `nativeTheme.on("updated")` → `broadcastTheme()` 把 dark/light 推给所有窗口（`yukino:theme` 通道）——**system 模式下 UI 实时跟随 OS 切换**。

### Q46. 并发 init 与 renderer 刷新怎么防状态错乱？

`init()` 的双重路径：handle 已存在 → **状态重放**（init_state + 完整 history 投影 + run_state + pendingPlan），这是 renderer 刷新/新窗口的对齐机制；handle 不存在 → `initPromise` 单例去重（并发调用共享同一个 initialize Promise，finally 置 null）。`ensureHandle()` 是全部业务方法的惰性入口：没初始化就先 init。`reinit(cwd)` 是受控重建：等 initPromise → 清定时器 → abort streaming → dispose handle → resetSessionUi → dispose workspace → 重置 cwd/lastUsage/followUps → init。**任何时刻至多一个 handle、至多一个 init 在飞**。

## 七、打包、更新与测试

### Q47. electron-builder.yml 的关键配置有哪些？

`appId: com.hangtiancheng.yukino-code`、`productName: yukino-code-app`；`files` 用**排除式**规则：剔 `.vscode`、`src/`（源码不进包，只带 out/ 产物）、构建配置、lint/prettier 配置、`dev-app-update.yml`、`.env*`/`.npmrc`/`pnpm-lock.yaml`、三套 tsconfig——**密钥文件与开发配置绝不进分发产物**；`asarUnpack: resources/**`（资源文件解包出 asar，供文件系统直接访问）；`npmRebuild: false`（跳过原生模块重编译，配合 postinstall 的 `electron-builder install-app-deps` 显式控制时机）。

### Q48. 三平台的产物与签名配置差异？

**Windows**:NSIS 安装器，`artifactName: ${name}-${version}-setup.${ext}`、桌面快捷方式 always、卸载显示名独立配置。**macOS**:`entitlementsInherit: build/entitlements.mac.plist`（子进程继承的权限清单）、`extendInfo` 注入四个 usage description（相机/麦克风/文档/下载目录——**Info.plist 缺这些声明时系统 API 直接崩溃**）、`notarize: false`（未开启公证，分发自签）。**Linux**：三目标 AppImage + snap + deb，`category: Utility`。`publish: {provider: github, owner: hangtiancheng, repo: yukino-code}`——产物发布到 GitHub Releases，同时是 electron-updater 的更新源。

### Q49. 发布流程怎么脚本化？

`scripts/release.mjs`:`node release.mjs` 无参数 = **dry-run**（只构建不发布）；`win/mac/linux/all` 指定平台发布；发布需要 `GH_TOKEN`（GitHub PAT，经 dotenv 注入）。dry-run 默认是防误发的好设计——发布是不可逆动作（GitHub Release 一旦带 latest 标记，更新客户端就会拉到）。构建命令链：`pnpm build`（typecheck + electron-vite build）→ `electron-builder --<platform>`；`build:unpack` 出未打包目录供本地冒烟。

### Q50. 项目的自动更新配置到什么程度了？

**事实基线**（要如实区分）：基础设施三件套齐备——`electron-updater@^6.8.9` 在 dependencies、`dev-app-update.yml`（`provider: github, owner: hangtiancheng, repo: yukino-code, updaterCacheDirName: yukino-code-app-updater`，开发态更新测试配置）、electron-builder 的 `publish: github`（构建时生成 `latest.yml` 等更新元数据）。但 **`src/main` 没有任何 `autoUpdater` 接线**（全仓 grep 无命中）——运行时检查/下载/安装流程未实现，当前分发靠 GitHub Releases 手动下载。面试表述：「更新源与元数据已按 electron-updater 约定配好，主进程接线是留白」——把配置存在与代码缺失分开说，才是证据纪律。

### Q51. electron-updater 接线的标准流程是什么？

**方案推导**（补齐 Q50 的留白）：① 启动后延迟 `autoUpdater.checkForUpdatesAndNotify()`（或手动检查入口）；② 事件流——`checking-for-update → update-available → download-progress → update-downloaded`，错误走 `error` 事件；③ `update-downloaded` 后提示用户，`quitAndInstall()` 在下次退出时安装（配合本项目的 will-quit 异步清理要先 dispose bridge）；④ 平台前提——macOS 必须签名+公证（当前 `notarize: false` 是阻塞项），Windows 校验签名，Linux AppImage 才支持自更新（deb/snap 走系统包管理器）；⑤ 开发态用 `dev-app-update.yml` + `forceDevUpdateConfig` 测试。差分更新（blockmap）由 builder 产物自动携带。

### Q52. asar 是什么？为什么 resources 要 unpack？

asar 是 Electron 的只读归档格式：把应用文件打成单文件减少磁盘寻址、加快启动（Windows 上尤其明显）、并提供轻度源码聚合（**不是加密，不是安全边界**）。`asarUnpack: resources/**` 的原因：归档内文件没有真实路径，凡是要被**文件系统 API 或子进程按路径访问**的资源（图标、二进制、模板）必须解包到 `app.asar.unpacked/`。判断标准：`__dirname` 拼出来给 Node fs 用的路径在 asar 内可透明工作（Electron patch 过 fs），但交给外部进程（如 seatbelt/bwrap、gh）的路径必须 unpack。

### Q53. 项目的测试金字塔长什么样？

三层（`package.json` + `tests/`）：① **单元测试** `pnpm test` = `tsx --test tests/*.test.ts`（Node 内置 test runner）——`workspace.test.ts`（safePath/冲突/基线）、`project.test.ts`（错误分类）、`agent-runtime.test.ts`（RuntimeAction 分派）、`chat-state.test.ts`（reducer 纯函数）；② **UI 测试** `pnpm test:ui` = Playwright——README：用 **mock Agent**，不发真实模型请求；③ **Electron 冒烟** `tests/electron-smoke.ts` = `_electron.launch` 真起应用——临时项目目录 + 隔离 userData（预写 state.json 指定 cwd/theme）、launcher 脚本 `app.setPath("userData", ...)`、等 `window.api` 就绪、断言读写往返、**路径穿越必须失败**、过期 revision 保存必须冲突。README:Electron 测试用临时项目与隔离应用数据目录，不发模型请求——**桌面测试的关键是把「贵且不确定」的 LLM 从回路里拿掉**。

### Q54. postinstall 为什么跑 install-app-deps？

`postinstall: "install-electron && electron-builder install-app-deps"`。两步：下载 Electron 二进制（国内网络可经镜像变量）；`install-app-deps` 把依赖树里的**原生模块**（node-gyp 编译产物）按 Electron 的 ABI 重编译——npm/pnpm 默认按系统 Node ABI 编译，直接装进 Electron 会 `NODE_MODULE_VERSION` 不匹配崩溃。builder 主配置里 `npmRebuild: false` 关掉打包期的自动重编译，把重编译时机收敛到 install 阶段一次做对——**两处配置是配套的，不是矛盾**。

## 八、性能与架构取舍

### Q55. 流式事件的渲染端怎么防止「每 token 一次 re-render」？

`use-chat.ts` 的合帧策略：`stream_text`/`thinking_text` 事件进 `pending` 缓冲——若与队尾事件同类型则**直接字符串拼接**（`last.data.text += event.data.text`），并 `requestAnimationFrame` 调度一次 flush；其他事件（tool_use、permission_request 等状态性事件）立即 flush 缓冲后同步应用。效果：token 级事件被合并到帧级（60fps 下每 16ms 一次 dispatch），而交互关键事件零延迟。reducer 侧（`chat-state.ts`）把事件流归约成**扁平 ChatItem 列表**（user/assistant/tool/system/error/marker/permission 等 kind），组件保持纯展示（头注释："Components stay presentational"）。

### Q56. 启动路径上做了哪些懒加载？

① agent 栈懒初始化——`ensureHandle()` 首次被业务调用才 `init()`，窗口先出来（ready-to-show）再后台装配；② LLM client 按 protocol 动态 `await import`（`apps/yukino/src/llm/client.ts` 的 anthropic/openai 分支）；③ main/preload `externalizeDeps` 免打包大依赖树；④ telemetry 相关 SDK 落在核心包 `optionalDependencies`，缺装不阻塞主链路；⑤ workflow 持久化 run 的恢复在 handle 创建后异步进行。度量口径（**方案推导**）：冷启动 = 进程 spawn → ready-to-show → init_state 到达 renderer 三段，应分别打点；本项目未在源码中发现启动打点，属可补的观测项。

### Q57. 内存与载荷控制有哪些显式预算？

盘点源码里的硬预算：后台任务输出进 RuntimeSnapshot 前 `task.output.slice(-100_000)`（只留尾部 100KB）；文件读写 2MB 上限（编辑器侧）；`git status` maxBuffer 4×2MB；MCP App 高度 100–1200px（默认 480）防巨型 iframe；chat-state 是扁平列表（无嵌套树累积）；agent 侧的工具结果 spill 在核心层已挡掉大头：单结果字符阈值 `MAX_OUTPUT_CHARS = 50000`（`apps/yukino/src/agent/constants.ts`，超限写磁盘只留预览+路径，见 [Agent 循环](/interview/qa/agent-loop-and-tools) Q25）。**桌面端内存问题的主源是「把无限流式内容堆进 DOM/状态」**，本项目在事件合帧（Q55）与载荷截断两侧同时设防。

### Q58. 渲染层的技术选型是什么？各解决什么问题？

README 与 package.json:React 19 + **Base UI/shadcn**（组件基元）、**cmdk**（⌘K 命令中心）、**TanStack Query**（runtime 快照轮询与事件驱动的查询失效，`queryKey: ["runtime", sessionId]`，流式 2s / 空闲 5s 轮询）+ **TanStack Virtual**（长会话虚拟滚动）、**Monaco**（代码编辑器，worker-src blob：的 CSP 来源）、**Streamdown**（流式 Markdown 渲染，含 `@streamdown/code` 高亮）、**react-resizable-panels**（聊天区与编辑器左右可拖拽分栏）、**Sonner**（toast）、lucide-react（图标）、Tailwind CSS 4（`@tailwindcss/vite`）。选型逻辑一句话：**流式 AI 工作台的每个高频难点（虚拟列表、流式 MD、编辑器、命令面板）都用成熟专件，不自研**。

### Q59. Electron vs Tauri vs 纯 Web 怎么取舍？

| 维度     | Electron                 | Tauri                    | 纯 Web     |
| -------- | ------------------------ | ------------------------ | ---------- |
| 运行时   | Chromium + Node 全量捆绑 | 系统 WebView + Rust 核心 | 浏览器     |
| 体积     | 大（百 MB 级）           | 小（十 MB 级）           | 零安装     |
| 后端能力 | Node 生态直接复用        | Rust 侧写或 sidecar      | 无本地能力 |
| 一致性   | 三平台同 Chromium 版本   | 各系统 WebView 有差异    | 浏览器差异 |
| 安全模型 | 进程隔离 + contextBridge | 权限清单（allowlist）    | 同源策略   |

本项目选 Electron 的决定性理由：**agent 核心是 TypeScript/Node 库**（`@yukino.js/yukino` workspace 包直接 import），Electron main 进程零成本复用；Tauri 则要把核心重写为 Rust 或塞进 sidecar 进程再套一层 IPC。代价是体积与内存——对开发者工具类应用可接受。**选型的第一性问题：你的核心逻辑活在哪个运行时里**。

### Q60. 桌面壳、CLI 壳、WS 远程壳怎么做到「一核多壳」？

对照三处事实：CLI/print-mode 壳直接装配 Agent（`apps/yukino/src/print-mode.ts` 的装配链）；WS 远程壳经 `apps/yukino/src/remote/`（心跳 `HEARTBEAT_INTERVAL_MS = 30_000`、失联阈值 `HEARTBEAT_STALE_MS = 75_000`，见 [MCP 与安全](/interview/qa/mcp-and-agent-security)）；桌面壳经 `Remote.Server.createRemoteAgent` 库入口（本篇 Q25）。核心暴露的稳定面是：**AgentEvent 生成器 + 权限/提问回调 + handle 生命周期方法**，三壳各自把这套接口适配到自己的传输（stdout、WebSocket、IPC）。slash 命令分派在桥内复刻了 WS server 的语义（send() 注释 "WS server parity"）。**采分点**：一核多壳的前提是核心不依赖任何壳的概念——agent 核心里没有一行 Electron import，方向永远是壳依赖核心。

## 速记卡

- **分层**：main（特权+agent 运行时）/ preload（contextBridge facade）/ renderer（React 纯展示）/ shared（唯一 IPC 契约，plain JSON 纪律）。
- **构建**：electron-vite 三目标；main/preload externalizeDeps（ESM-only 核心 + Node 22.12 require(esm)）；dev 走 ELECTRON_RENDERER_URL、prod 走 loadFile；三套 tsconfig 分检 Node/Web/test。
- **安全**：contextIsolation + 窄 facade（32 个 invoke 具名通道，无万能透传）；sandbox:false 是有补偿的取舍；CSP frame-src about：给 MCP Apps、worker-src blob：给 Monaco；window.open 全 deny + http(s) 转系统浏览器；safePath 词法+realpath 双查防 symlink 逃逸；MCP App 每应用独立 CSP（default-src 'none' + 域名白名单）。
- **IPC**：请求-响应 invoke/handle ×32（main 侧 31 个 handle），推送单通道 `yukino:event`（BridgeEvent union 保序）；权限/提问 = pending-promise（randomUUID id + Map + abort→resolve("deny")）；handler 抛错到 renderer 只剩 message。
- **会话集成**：createRemoteAgent 一核多壳；send 三级分派（steer→followUps / ！与！! user bash / slash 命令）；completeRun 收 steering 残渣 + plan 审批优先 + followUps 自动续发；500ms 通知唤醒轮询（unref）跑空 turn。
- **工作区**：revision=sha256 乐观并发 + FileMutationQueue 与 agent 共锁；baseline 三级（capture→git HEAD→当前内容）；beforeWrite 同步 fileHistory+fileStateCache；2MB/二进制/UTF-8 fatal 三防；git status -z 解析 R/C 双记录、非 git 降级。
- **生命周期**：show:false+ready-to-show；will-quit preventDefault→dispose→setImmediate 重退；dispose 顺序=断入口→等 init→abort→deny 全部挂起→释放 handle；StateStore best-effort；init 单例去重 + 状态重放对齐刷新窗口。
- **打包**：files 排除式（.env/src/tsconfig 不进包）；asarUnpack resources；mac 四个 usage description + notarize:false（更新阻塞项）；publish github + release.mjs dry-run 默认。
- **更新事实**：electron-updater 依赖 + dev-app-update.yml + publish 配置齐备，**src/main 无 autoUpdater 接线**——配置存在与代码留白分开表述。
- **测试**：node:test 单测 + Playwright mock-agent UI 测 + _electron.launch 冒烟（隔离 userData、穿越必须失败、过期 revision 必须冲突）；LLM 不在测试回路。
- **性能**：stream/thinking 事件 rAF 合帧拼接、状态事件即时；后台输出截尾 100KB；agent 栈懒初始化。

## 延伸阅读

[Agent 执行循环与工具体系](/interview/qa/agent-loop-and-tools) · [MCP 协议与 Agent 安全](/interview/qa/mcp-and-agent-security) · [LLM 与推理基础](/interview/qa/llm-fundamentals) · [AI 流式前端专题](/interview/qa/ai-streaming-ui) · [前端工程化](/interview/qa/frontend-engineering) · [全量题库](/interview/question-bank)
