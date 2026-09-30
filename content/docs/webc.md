---
title: "WebContainer 与浏览器内 Vite：原理与底层技术解析"
---

本文回答四个问题：WebContainer 是什么、怎么工作；WASM 共享内存（SharedArrayBuffer）与跨源隔离是什么关系；浏览器内的并行化是怎么做的；以及为什么一个完整的 Vite dev server 能够在浏览器标签页里跑起来。

文中引用的代码有三处来源，均为真实产物，非示意代码：

- yukino-codegen 仓库（github.com/hangtiancheng/yukino-codegen）的 client 端源码，这是官方 WebContainer API 的一个完整生产级集成；
- @webcontainer/api 1.6.4 的 npm 发布产物（dist/index.js 等），即 StackBlitz 官方 SDK 的实际实现；
- yukino-codegen 仓库根目录的调研报告 yukino-codegen.md，其中包含对某同类产品自研 "webc" 运行时的线上实测证据（Service Worker 注册表、网络请求清单、控制台日志），用于对照官方方案与自研方案。

涉及实现细节但缺乏一手证据的地方，文中会明确标注"官方说法"或"推断"。

## 一、总览：浏览器标签页如何变成一台开发机

WebContainer 是 StackBlitz 推出的浏览器内 Node.js 运行时。官方博客的表述是：把 Node.js 编译为 WebAssembly 在浏览器里运行，并"virtualized TCP network stack mapped to ServiceWorkers"（将虚拟化的 TCP 网络栈映射到 Service Worker 上）。它的对外形态是 @webcontainer/api 包，暴露 `boot` / `mount` / `spawn` / `fs` 这几个 API。

整个系统建立在三层技术上，缺一层都跑不起来：

| 层     | 技术                                                | 解决的问题                                                      |
| ------ | --------------------------------------------------- | --------------------------------------------------------------- |
| 隔离层 | COOP + COEP 响应头 → crossOriginIsolated            | 换取 SharedArrayBuffer 与高精度计时，这是 WASM 多线程的准入条件 |
| 计算层 | 编译为 WASM 的 Node.js 用户态 + Emscripten pthreads | 在浏览器里提供 syscalls、文件系统、进程与线程                   |
| 网络层 | Service Worker fetch 拦截                           | 让"监听在某端口上的 HTTP 服务器"对浏览器而言真实存在            |

从 @webcontainer/api 的发布产物可以直接读出官方方案的进程拓扑（dist/index.js 的 serverFactory）：

```text
宿主页面（你的应用, 需 COI 头）
  │  window ↔ iframe postMessage + MessageChannel + Comlink RPC
  V
隐藏 iframe（https://stackblitz.com/headless, 官方基础设施源）
  │  运行时宿主: 持有 WASM Node、Worker 群、容器虚拟 FS
  V
预览 iframe（*.webcontainer.io 子域, allow="cross-origin-isolated"）
  │  同源 Service Worker 拦截该源的所有 HTTP 请求,
  │  从容器虚拟 FS 应答 → 浏览器视角下这里有一台真的 dev server
  V
容器内进程: npm install → npm run dev → Vite 监听容器内端口
```

宿主页与容器分属不同源是刻意的：StackBlitz 的基础设施域（stackblitz.com / \*.webcontainer.io）自己配好了 COOP/COEP，宿主页只需要通过 MessageChannel 做 RPC；而容器的 HTTP 出口由运行在 \*.webcontainer.io 源上的 Service Worker 承接。第五节会对照一个反例：某产品把这一切塞回同源路径的自研方案。

与"远程开发容器"（GitHub Codespaces 一类）的本质区别在于算力归属：Codespaces 的 dev server 跑在云主机上，浏览器只是一块屏幕；WebContainer 把编译、依赖安装、dev server 全部放进用户的标签页，服务器只下发静态资源，平台侧零构建成本、零并发压力。代价是后面各节要逐一处理的一系列浏览器沙箱限制。

### 1.1 完整拓扑：yukino-codegen 场景

yukino-codegen 的实际形态把官方拓扑嵌进了一个完整产品。下面这张图把浏览器内的三个执行上下文、它们之间的通道、以及独立的业务后端画在一起（依据：@webcontainer/api serverFactory 的 iframe 创建、webcontainer-runtime.ts 的 server-ready 流程、server/src/routes 的 agent-ws 路由）：

```text
用户浏览器（以下三个上下文同属一个标签页）
│
├─ 宿主页面：yukino-codegen client（你的应用域，需 COOP/COEP 头）
│    React SPA：聊天面板 / Monaco / xterm / 预览区
│    │
│    │ (1) REST + Agent WebSocket
│    V
│    业务后端（与 StackBlitz 完全无关，服务器侧）
│      Hono API + Agent WebSocket（/api/app/:id/agent/ws）
│      RuntimeManager → 每应用 AgentRuntime（@yukino.js/yukino agent）
│      tmp/code_output/{appId}/ 真实项目目录 + git 快照（权威数据）
│      PostgreSQL / Redis / MinIO / OpenAI 兼容模型端点
│
├─ 隐藏 iframe：https://stackblitz.com/headless?coep=credentialless&version=1.6.4
│    官方基础设施源，display:none，无 UI（"headless"即无头页面）
│    运行时宿主：WASM Node 用户态 + Worker 群 + 容器虚拟 FS + 进程调度
│    运行时代码由 stackblitz.com 下发，version 参数对齐 SDK 版本
│    │
│    │ (2) 握手时下发 MessagePort，此后承载全部 RPC（mount/spawn/fs/teardown）
│    │ (3) 与预览 iframe 同属官方运行时体系（内部实现未公开，见 5.2）
│    V
├─ 预览 iframe：https://<id>.webcontainer.io/（allow="cross-origin-isolated"）
│    同源 Service Worker：拦截该源全部 HTTP → 容器虚拟 FS 应答（transferSize=0）
│    容器内进程：npm install → npm run dev（Vite）→ 监听容器端口
│    HMR WebSocket：经运行时桥接回容器（SW 拦不住 WS，见 5.5）
│    │
│    └─ (4) 出站：npm registry 请求经浏览器网络栈桥接 → StackBlitz 代理
```

三个执行上下文的分工与通道：

| 上下文      | 源（Origin）       | 职责                                          | 对外通道                                                          |
| ----------- | ------------------ | --------------------------------------------- | ----------------------------------------------------------------- |
| 宿主页面    | 你的应用域         | 产品 UI、RPC 发起方、预览 iframe 的持有者     | MessageChannel → headless；postMessage ↔ 预览；REST/WS → 业务后端 |
| 隐藏 iframe | stackblitz.com     | 运行时宿主：WASM Node、Worker 群、容器虚拟 FS | init 消息下发 MessagePort；与预览 iframe 同属官方运行时体系       |
| 预览 iframe | \*.webcontainer.io | 承载 Service Worker 与容器进程，展示生成应用  | SW fetch 拦截；HMR WS 桥接；预览脚本 postMessage 回宿主           |

需要强调的分界：三个上下文里只有宿主页面认识业务后端；headless 与预览两个 iframe 对 yukino-codegen 的服务器一无所知，只认识 stackblitz.com 与 webcontainer.io。反过来，业务后端也完全不知道 WebContainer 的存在——服务器只管往 tmp/code_output/\{appId\} 写文件，"怎么跑起来"纯粹是浏览器侧的事。这也是排障时的分界线：agent 不产出、文件树拉不到，查服务器；容器起不来、预览白屏，查 stackblitz.com 与 \*.webcontainer.io 的连通性。

### 1.2 网络依赖清单

浏览器端需要可达的端点如下（全部由浏览器发起，服务器侧对 StackBlitz 零依赖）：

| 端点                                                                     | 何时访问                   | 承载内容                                  | 不可达时的表现                |
| ------------------------------------------------------------------------ | -------------------------- | ----------------------------------------- | ----------------------------- |
| https://stackblitz.com/headless                                          | WebContainer.boot() 启动时 | 运行时代码 bundle（WASM 包、Worker 脚本） | boot 失败，预览功能整体不可用 |
| https://\<id\>.webcontainer.io                                           | server-ready 之后渲染预览  | 预览文档 + Service Worker 脚本            | 预览白屏                      |
| npm registry（经桥接出站）                                               | 容器内 npm install         | 依赖包与平台二进制                        | install 失败                  |
| 业务后端（dev 下经 vite.config.ts 代理 /api → localhost:3000，ws: true） | 全程                       | 文件树 REST、agent WS、会话接口           | 页面无数据、agent 断线重连    |

验证方法：DevTools 的 Elements 面板能找到 display:none、src 为 stackblitz.com/headless 的 iframe（boot 是否成功的直接观测点）；Network 面板确认该请求 200；命令行用 curl -I https://stackblitz.com/headless 测连通性。内网或离线环境无法使用官方 API——运行时托管在 StackBlitz 基础设施上，这是第八节"局限"的根源之一。

### 1.3 一次生成回合的端到端时序

把拓扑串成时间线，每一步标注所走的通道（代码走读见 6.3）：

1. 用户提交 prompt → 宿主页 `POST /api/app/add` → 跳转 /app/chat/:id。
2. 宿主页建立 Agent WebSocket → 服务端 runtime-manager.getOrCreate → 回推 ready + transcript 补发 → 宿主页发 hello\{afterSequence\} 校准断点。
3. 宿主页发 run\{input\} → 服务端 AgentRuntime.runTurn → agent 在服务器磁盘产出文件 → git 快照 → WS 推送 files_changed\{revision:sha\}。
4. 宿主页拉取 `GET /api/app/files/:appId` 得到文件树 → mount(tree)：序列化为 JSON 字节 → Comlink.transfer 零拷贝 → 隐藏 iframe → 容器虚拟 FS。
5. 依赖指纹变化则 spawn("npm", ["install"])：包下载请求经运行时桥接出浏览器，经 StackBlitz 代理访问 registry。
6. spawn("npm", ["run", "dev", "--", "--host", "0.0.0.0"]) → 容器内 Vite 监听端口 → 运行时经 Comlink 回调推送 server-ready(port, url)。
7. 宿主页把预览 iframe.src 指向 url → 预览文档加载 → 该源 Service Worker 注册并接管后续全部请求 → /@vite/client、/src/\*.tsx 等由容器虚拟 FS 应答 → 页面渲染完成。
8. 反馈回路：预览页运行时异常经 setPreviewScript 注入的脚本 postMessage 回宿主页（uncaught-exception 等，见 6.4）→ 作为下一轮 run 的 previewError 上下文；预览中点选元素同样经 postMessage 回传做可视化编辑；容器内 fs.watch 的变更反向回写服务器（见 6.3 第五阶段）。

## 二、跨源隔离：SharedArrayBuffer 的准入条件

### 2.1 为什么浏览器默认不给共享内存

SharedArrayBuffer（SAB）允许多个执行线程读写同一段内存。2018 年初 Spectre / Meltdown 漏洞公开后，浏览器厂商发现：纳秒级计时 + 共享内存的时序差足以跨源窃取信息（经典攻击是靠共享内存的读写竞争做时间侧信道，再配合猜测执行把跨源数据"挤"出来）。于是 Chrome 率先把 SAB 从所有页面收走，改为只发给"把自己隔离干净"的页面，这个状态的正式名字叫 cross-origin isolation。

页面满足以下两个响应头时，`window.crossOriginIsolated` 才为 true：

| 响应头                       | 取值                           | 语义                                                                                                                                                                                    |
| ---------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cross-Origin-Opener-Policy   | same-origin                    | 把当前浏览上下文从跨源 opener 关系中隔离出来，其他标签页无法通过 window.opener 与自己共享进程组                                                                                         |
| Cross-Origin-Embedder-Policy | require-corp 或 credentialless | require-corp 要求页面加载的每个跨源子资源都显式声明 CORP/CORS 授权，否则加载失败；credentialless 是宽松版，跨源无 CORS 声明的资源改为"去凭据"加载（不带 cookie），不再要求对方配置 CORP |

满足隔离后浏览器开放的能力：SharedArrayBuffer、WebAssembly.Memory(\{ shared: true \})、高精度 performance.now() 计时（精确到 5 微秒级而非 100 微秒级粗化）。这正是 WASM 多线程的全部硬件前提。

### 2.2 yukino-codegen 中的真实配置

client/vite.config.ts 把两个头同时挂在了 dev server 和 preview server 上：

```ts
const crossOriginIsolationHeaders = {
  "Cross-Origin-Embedder-Policy": "credentialless",
  "Cross-Origin-Opener-Policy": "same-origin",
};

export default defineConfig({
  // ...
  server: {
    headers: crossOriginIsolationHeaders,
    proxy: {
      // Dev-only: keep API + agent WebSocket same-origin with the Vite app so
      // credentialed requests skip cross-origin CORS. Forwarded to the backend.
      "/api": { target: "http://localhost:3000", changeOrigin: true, ws: true },
    },
  },
  preview: { headers: crossOriginIsolationHeaders },
});
```

boot 入口（client/src/shared/webcontainer/boot.ts）在调 `WebContainer.boot` 之前显式检查隔离状态，不满足就直接拒绝启动，而不是等到深处报一个莫名其妙的地洞错误：

```ts
export function getWebContainer(): Promise<WebContainer> {
  if (bootPromise !== undefined) return bootPromise;
  if (Reflect.get(globalThis, "crossOriginIsolated") !== true) {
    return Promise.reject(
      new Error(
        "WebContainer requires cross-origin isolation. Reload after enabling COOP/COEP headers.",
      ),
    );
  }
  bootPromise = WebContainer.boot({
    coep: "credentialless",
    forwardPreviewErrors: true,
    workdirName: "project",
  }).catch((error: unknown) => {
    bootPromise = undefined;
    throw error;
  });
  return bootPromise;
}
```

SDK 内部对这两个头的关系也有防御逻辑。@webcontainer/api dist/index.js 第 211 行：页面已经隔离、却传了 `coep: 'none'` 时直接打警告，因为容器的 iframe 需要继承隔离状态，头不能撤：

```js
if (window.crossOriginIsolated && options.coep === "none") {
  console.warn(
    `A Cross-Origin-Embedder-Policy header is required in cross origin isolated environments.\nSet the 'coep' option to 'require-corp'.`,
  );
}
```

### 2.3 iframe 的隔离继承

隔离状态不会自动穿过 iframe。子框架要么自己满足 COOP/COEP，要么在 iframe 标签上显式声明继承。官方 SDK 在创建运行时 iframe 时同时做了两件事（dist/index.js serverFactory）：

```js
const iframe = document.createElement("iframe");
iframe.style.display = "none";
iframe.setAttribute("allow", "cross-origin-isolated");
const url = iframeSettings.url; // https://stackblitz.com/headless?coep=credentialless&...
iframe.src = url.toString();
```

`allow="cross-origin-isolated"` 是 W3C Feature Policy 体系里的标准开关，让官方源上的子框架继承宿主页的隔离状态，容器内部的 Worker 与 WASM 线程才拿得到 SAB。yukino-codegen.md 实测报告里，同类产品自研方案的预览 iframe 也带同样的属性，且主页面响应头完全一致（COOP same-origin + COEP credentialless）。

### 2.4 COEP 的工程代价

COEP 是这套方案最容易被低估的摩擦点：一旦启用，页面里所有跨源子资源（第三方图片、字体、统计脚本）都必须配合 CORS 或 CORP，否则直接加载失败。credentialless 取值是 Chrome 后来给的折中方案（参考 Chrome 官方博客 coep-credentialless-origin-trial），yukino-codegen 与实测产品都选了它而不是更严的 require-corp。给宿主页配 COEP 时，要把第三方资源清单过一遍，这也是 README 特别提醒"自己托管构建产物时必须补上这两个头"的原因。

## 三、WASM 与共享内存

### 3.1 WebAssembly.Memory 与 SharedArrayBuffer

WASM 的线性内存通过 WebAssembly.Memory 对象暴露给 JS。加上 `shared: true` 后，它的 `.buffer` 就是一个 SharedArrayBuffer：

```js
const memory = new WebAssembly.Memory({
  initial: 1600, // 页为单位, 1 页 = 64 KiB
  maximum: 32768,
  shared: true, // memory.buffer 即 SharedArrayBuffer
});
```

把同一个 `memory.buffer`（或 Memory 对象本身）postMessage 给多个 Worker，得到的是同一段物理内存的多个引用——这里不存在拷贝，也不需要 transferable，structured clone 对 SAB 的语义就是共享。WASM 模块在实例化时接收这份 memory，C/C++/Rust 侧的全局堆就成了所有线程可见的共享堆。

这就是 Node.js 能"多线程"的关键：libuv 的线程池、V8 平台层、node:worker_threads，编译到 WASM 后统统落在这套"Worker + 共享堆 + Atomics"的原语上。

### 3.2 Atomics：等待与唤醒

共享内存只是把数据放到了一起，线程同步靠 Atomics：

- `Atomics.load / store / add / compareExchange`：原子读写与 RMW 操作，对应 WASM 的原子指令；
- `Atomics.wait(typedArray, index, value, timeout)`：阻塞当前线程，直到该位置的值变化或被 `Atomics.notify` 唤醒，对应 futex 语义；
- `Atomics.waitAsync`：非阻塞版本，Promise 风格的等待。

一个关键约束：主线程禁止调用 `Atomics.wait`。浏览器会直接抛错（"Atomics.wait cannot be called in this context"），因为阻塞主线程会冻结整个页面的事件循环。所有"在主线程等一个共享内存标志"的需求都必须改写为 `Atomics.waitAsync` 或消息通知。Emscripten 的 pthreads 运行时为此做了完整的降级路径（见下节），自研运行时也要遵守同一条纪律——WebContainer 容器内所有"会阻塞"的同步逻辑都跑在 Worker 里，主线程只做 RPC 与调度。

### 3.3 Emscripten pthreads：C/C++ 线程到浏览器的映射

Emscripten（把 C/C++ 编译到 WASM 的工具链）的 pthreads 支持是把 POSIX 线程序语义搬到浏览器的参考实现，WebContainer 的运行时同源同种。核心机制：

1. 编译期加 `-pthread`，链接器注入 pthread 运行时（worker.js）与共享内存配置；
2. 主模块启动时预创建一个 Worker 池（`-s PTHREAD_POOL_SIZE=N`，默认按需懒创建），每个 Worker 预先收到同一份 SharedArrayBuffer；
3. `pthread_create` 不新建 Worker 时从池里取，把线程入口函数指针和参数写进共享内存，再用 `Atomics.notify` 唤醒目标 Worker，Worker 侧以相同 memory 实例化同一个 WASM 模块并执行入口；
4. pthread_mutex / pthread_cond 用共享堆上的原子变量模拟（自旋 + `Atomics.wait` 混合锁）；`pthread_join` 同理；
5. Worker 里可以放心用 `Atomics.wait`（Worker 允许阻塞），这是把"等待"全部搬到 Worker 的结构性能原因。

web.dev 的 WebAssembly threads 一文给出的结论相同：pthreads 全部构建在 Web Workers 与 SharedArrayBuffer 之上，而 SAB 要求页面处于跨源隔离，链条至此闭环：

```text
要 WASM 多线程 → 要 SharedArrayBuffer → 要 crossOriginIsolated → 要 COOP + COEP 头
```

### 3.4 共享内存的 grow 语义

与非共享内存 grow 后旧 buffer 立即 detach 不同，共享内存的 grow 允许在线完成（需要实例化时预留 maximum），已有 buffer 不失效，各线程通过同一 Memory 对象看到一致的容量。工程上的坑在于视图刷新：grow 之后需要重新从 `memory.buffer` 建立 TypedArray 视图（Emscripten 的 updateMemoryViews 负责此事），持有旧视图的线程会继续用旧的 byteLength 判断边界。自研运行时如果绕开 Emscripten，这是最容易踩的一处。

## 四、浏览器并行化技术

### 4.1 并发原语清单

浏览器给的单线程 JS 提供了一批并行原语，WebContainer 是它们的高强度组合使用方：

| 原语                         | 特性                                         | 在 WebContainer 中的角色                |
| ---------------------------- | -------------------------------------------- | --------------------------------------- |
| Web Worker                   | 独立线程、独立全局作用域、不能直接碰 DOM     | 容器进程的载体、pthread 的载体          |
| MessageChannel / MessagePort | 两条队列的私有双工通道，可嵌套转移           | 宿主页 ↔ 运行时 iframe 的 RPC 通道      |
| Transferable objects         | ArrayBuffer / MessagePort 转移所有权，零拷贝 | mount 文件树、fs.writeFile 的二进制载荷 |
| structured clone             | postMessage 的默认序列化，SAB 共享语义       | 状态与消息同步                          |
| Service Worker               | 带独立生命周期的可编程网络代理               | 容器的虚拟 HTTP 服务器（第五节）        |
| Atomics + SAB                | 共享内存与阻塞同步                           | WASM 线程、进程管道                     |

Comlink 是把 postMessage 变成 RPC 的薄封装：`Comlink.wrap(port)` 把对端对象代理成本地 Promise 风格接口，`Comlink.proxy(fn)` 把回调反向派到对端执行，`Comlink.transfer(payload, [payload.buffer])` 声明转移列表。@webcontainer/api 把 Comlink 打包进了自己的 dist（vendor/index.js）。

### 4.2 官方 SDK 里的并行与零拷贝（真实代码）

boot 的握手。宿主页等待运行时 iframe 发来的 init 消息，从事件里取出 MessageChannel 端口并用 Comlink 包成 RPC 代理，此后一切容器操作都是这条通道上的方法调用：

```js
// @webcontainer/api dist/index.js (serverFactory)
cachedServerPromise = new Promise((resolve) => {
  const onMessage = (event) => {
    if (event.origin !== origin) return;
    const { data } = event;
    if (data.type === "init") {
      resolve(Comlink.wrap(event.ports[0]));
      return;
    }
    if (data.type === "warning") {
      console[data.level].call(console, data.message);
    }
  };
  window.addEventListener("message", onMessage);
});
```

mount 的零拷贝。文件树先序列化为 JSON 字节，再以 transferable 方式移交所有权（拷贝次数为零），跨 iframe 送到容器虚拟 FS：

```js
mount(snapshotOrTree, options) {
  const payload = snapshotOrTree instanceof Uint8Array
    ? snapshotOrTree
    : snapshotOrTree instanceof ArrayBuffer
      ? new Uint8Array(snapshotOrTree)
      : encoder.encode(JSON.stringify(toInternalFileSystemTree(snapshotOrTree)));
  return this._instance.loadFiles(Comlink.transfer(payload, [payload.buffer]), {
    mountPoints: options?.mountPoint,
  });
}
```

spawn 的流桥接。进程的 stdout/stderr 是运行时 Worker 里持续产生的数据，SDK 用 Comlink.proxy 把三个回调送到容器侧、再 push 进标准 ReadableStream：

```js
const process = await this._instance.run(
  { command, args, cwd, env, terminal },
  wrappedStdout,
  wrappedStderr,
  wrappedOutput,
);
return new WebContainerProcessImpl(
  process,
  outputStream,
  stdoutStream,
  stderrStream,
);
```

`WebContainerProcessImpl` 再把这些桥成 `output: ReadableStream<string>`、`input: WritableStream`、`exit: Promise<number>`，客户端用 `process.output.pipeTo(...)` 就能拿到容器进程的实时输出。fs API 同理：writeFile 对 Uint8Array 做 `Comlink.transfer`，readdir 把对端返回的 'Symbol(type)' 映射回 DirEnt。

### 4.3 运行时内部的并行模型

官方运行时内部的 Worker 拓扑没有公开源码，但可以从公开描述与行为推出框架：每个容器进程（npm、vite、bash）对应一个或多个 Worker 中的 WASM 实例，pthread 池提供线程，Service Worker 在自己的全局作用域里承担网络入口，彼此通过共享内存与消息总线协作。此为推断，官方只说了"virtualized TCP network stack mapped to ServiceWorkers"。

对照组是实测报告里的自研 webc 运行时，它的 Worker 分工是被实测证据（SW 脚本导出的协议符号名、控制台日志）钉死的：

```text
webc_service_worker   Service Worker: 整站 scope, 拦 /_i/{instanceId}/_p/{port}/** 交给容器
webc_worker           进程执行 (控制台可见 "run wasm /bin/bash @ blob:...")
webc_lite_worker      轻量进程
webc_io_worker        文件系统 IO
webc_monitor_worker   调度/监控 (对应 Monitor2Main 消息通道)
+ 5 个 wasm 包: wasm-webc-sys / wasm-bash / wasm-git / wasm-coreutils / wasm-npm-tools
```

SW 脚本头部的导出符号（isWasmPipe / isJSPipe / SWTopic / SWActions / Worker2MainAsks / Main2FSWorkerAsks ...）勾勒出与 Emscripten pthreads 同构的消息总线：按方向定义 Ask/Tell 消息对，FS 与 Monitor 各占独立通道，进程管道分 WASM 与 JS 两种实现。两套实现殊途同归，说明这类运行时的并行结构由问题本身决定：文件系统一个执行域、进程执行一个执行域、网络一个执行域，中间用共享内存与消息总线缝合。

## 五、Service Worker 网络虚拟化

### 5.1 拦截模型

Service Worker 是浏览器在页面之外运行的一段脚本，注册时声明 scope，此后该 scope 下页面发出的所有 HTTP 请求都先经过它的 fetch 事件，脚本可以用 `respondWith` 自行构造 Response。WebContainer 把它从"离线缓存"用成了"浏览器内存里的虚拟 Web 服务器"：请求的路径在真实服务器上根本不存在，SW 把它交给容器运行时，容器从虚拟 FS 取内容（必要时现场编译转换）拼成 Response 返回。

两个决定性限制：

1. SW 只能拦截 HTTP(S) 请求。WebSocket、postMessage 等 非 HTTP 通道不在 fetch 事件覆盖范围内（5.5 节展开）。
2. SW 只能注册在自己源上、拦截同源请求。这直接决定了官方与自研方案在 URL 形态上的分野。

### 5.2 官方方案：独立子域

@webcontainer/api 的 server-ready 事件回调签名是 `(port, url)`，url 指向 `*.webcontainer.io` 子域。结构上是：预览 iframe 挂在 \*.webcontainer.io 源上，SW 注册并拦截该源的全部请求，URL 到容器端口的映射由该源的路径/子域约定完成。同源 iframe 才能被本源 SW 覆盖，因此容器"必须"拥有自己的源，这也是 WebContainer 对宿主页要求 COI 头、对子域做独立部署的根本原因。

### 5.3 实测：自研同源方案

yukino-codegen.md 报告记录了一个把整套运行时塞回同源的实现，URL 形态完全不同：

```text
预览 iframe: https://站点域名/_i/<instanceId:7>/_p/3000/
             sandbox: allow-scripts allow-forms allow-popups allow-modals
                      allow-storage-access-by-user-activation allow-same-origin
             allow="cross-origin-isolated"
```

- SW scope 是整站根路径，因此必须自行区分三类请求（实测规则）：`/example-app/api/**` 是真后端，透传（transferSize 非 0）；`/_i/{instanceId}/_p/{port}/**` 是容器请求，交给虚拟 FS 应答（transferSize 为 0，即没有真实网络传输）；其余是站点自身资源，放行。
- 端口编码进路径（`_p/3000`）而非子域，是同源方案的必然选择：同源下无法按端口或域名区分路由，只能靠路径。instanceId 隔离多会话，避免多应用互相串扰。
- SW 的升级策略是"先注销再注册"（保证发版立即换新，不进 waiting 队列）：

```js
let regs = await navigator.serviceWorker.getRegistrations();
for (let r of regs)
  if (r.active.scriptURL === WebCSystem.getServiceWorkerUrl())
    await r.unregister();
let reg = await navigator.serviceWorker.register(
  WebCSystem.getServiceWorkerUrl(),
);
```

最硬的证据是流量形态：预览 iframe 内 36 个资源中，Vite 开发态产物（/@vite/client、/src/_.tsx、node_modules/.vite/deps/_）的 transferSize 全部为 0——`fetch('/_i/<hash>/_p/3000/@vite/client')` 没有产生任何真实网络传输，全部被 SW 用容器内存里的内容直接应答。报告甚至从虚拟 FS 里直接读到了 Vite 依赖预构建的 `_metadata.json`，证明浏览器内存里确实存在一个完整的 Vite 工作目录。

### 5.4 出站网络：npm install 怎么出去

SW 解决的是"入站"（浏览器请求容器）。容器进程也有"出站"需求：npm install 要访问 registry。WASM 环境没有真实 TCP socket，官方的说法是虚拟化 TCP 栈映射到 SW 通道，出站调用最终被桥接到浏览器侧以 fetch 方式发出、经 StackBlitz 的代理服务访问外网；自研 webc 则显式配置了两个代理出口（chat.js 内嵌配置原文）：

```js
cors_proxy: 'https://webc-net-helper.example-company.com/cors/',
ws_proxy:   'https://webc-net-helper.example-company.com',
```

即容器内外网请求改写到代理域转发，绕开浏览器 CORS；这也是自研方案必须有独立代理域名的原因。对 yukino-codegen 的实际影响在后文 6.6 节：npm 在"浏览器网络栈"里跑，包的平台二进制选择与常规服务器不同。

### 5.5 WebSocket 的例外与 HMR

SW 拦不住 WebSocket，于是出现了实测报告里最能说明架构差异的一条控制台日志（自研 webc）：

```text
[vite] failed to connect to websocket.
your current setup:
  (browser) example-app.example-company.com/_i/<hash:7>/_p/3000/ <--[HTTP]-->  localhost:3000/ (server)
  (browser) example-app.example-company.com:/ <--[WebSocket (failing)]-->  localhost:3000/ (server)
```

HTTP 通道被 SW 桥接得天衣无缝，WS 直连 localhost:3000 却无人监听，HMR 推送通道断了；该产品靠"文件改动全量写盘 + 页面重载"兜底。官方 WebContainer 的做法是在预览文档内桥接/补丁 WebSocket（ws 请求经运行时转交容器），因此 Vite HMR 能正常工作。yukino-codegen 的日常体验（改一行代码预览热更新）依赖的正是这条官方桥接。

## 六、为什么 Vite 能在浏览器里跑

### 6.1 Vite dev server 的请求模型

Vite 开发模式不做整包打包，按需编译、原生 ESM 直出。一个 Vite + React 项目冷启动后，浏览器发出的全部请求是这几类：

```text
/@vite/client                          HMR 客户端 (注入每个页面, 负责 WS 连接与模块热替换)
/@react-refresh                        react 插件的刷新前导脚本
/node_modules/.vite/deps/react.js?v=…  依赖预构建产物 (esbuild 把 npm 包打成单文件 ESM)
/node_modules/.vite/deps/_metadata.json 预构建清单
/src/main.tsx  /src/App.tsx            业务源码, 现场转译 TSX → JS 直出
/src/index.css                         按需处理的样式
```

关键性质：这些请求全都是无状态的 HTTP GET——"给路径、回文件"。没有会话、没有数据库、没有跨请求的服务端状态，所有状态都在 Vite 进程的内存（模块图、转译缓存）与磁盘（node_modules、.vite 缓存）里。这个模型天然适合被 SW 虚拟化：只要"进程 + 文件系统"在浏览器里真实存在，每个请求就能被逐个应答。

### 6.2 Vite 是一个纯 Node 程序

Vite dev server 是 connect 风格的中间件链跑在 Node http server 上，依赖的 Node API 是 fs（读源码、写预构建缓存）、net/http（监听端口）、以及少量 os/path。这些恰好都是编译到 WASM 的 Node 用户态能覆盖的部分：fs 落在虚拟文件系统，net 的"监听"被映射成 SW 通道。当 Vite 在容器里打印 "Local: http://localhost:5173/" 时，运行时通过 server-ready 事件把端口和可用的预览 URL 回传给宿主页（SDK 类型签名 `(port: number, url: string): void`），宿主页把 iframe 指向该 URL，请求随即落入 SW 的拦截范围。

三层技术在这里拼合成完整闭环：

```text
Vite 的 http server 监听容器内端口 (WASM net)
        ↓ server-ready
宿主页 iframe 指向预览 URL (*.webcontainer.io 或 /_i/{id}/_p/{port}/)
        ↓ fetch
Service Worker 拦截 → 容器虚拟 FS + Vite 现场转译 → Response
        ↓
浏览器渲染, Vite client 建立 HMR 通道 (WS 桥接)
```

### 6.3 yukino-codegen 全链路真实代码走读

yukino-codegen 的 client/src/pages/app-chat/workspace/webcontainer-runtime.ts 是官方 API 生产级用法的完整样本。一次预览启动分五个阶段（UI 上对应 booting → mounting → installing → starting → ready 的状态条）：

第一阶段，文件系统操作全局串行。所有 FS 变更（mount、install、编辑器保存、agent 同步）都压进单条 Promise 队列，避免 mount 和写入交错：

```ts
export function queueFsTask<T>(task: () => Promise<T>): Promise<T> {
  const run = fsQueue.catch(() => undefined).then(task);
  fsQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
```

第二阶段，挂载前清空工作目录，但同应用重启动时保留 node_modules（重装依赖是分钟级开销，值得特判）：

```ts
async function clearProject(
  container: WebContainer,
  preserveNodeModules: boolean,
) {
  const names = await container.fs.readdir(".");
  await Promise.all(
    names
      .filter((name) => !preserveNodeModules || name !== "node_modules")
      .map((name) => container.fs.rm(name, { force: true, recursive: true })),
  );
}
```

随后 `container.mount(tree)`，tree 即 SDK 的 FileSystemTree（`{ 路径: { file: { contents } } | { directory: FileSystemTree } }`，见 entities.d.ts），来源是服务端 agent 产出、经 `GET /api/app/files/:appId` 拉取的项目文件树。

第三阶段，依赖安装按指纹跳过。对 package.json 及各种 lockfile 的内容做哈希指纹，指纹没变且 node_modules 存在就直接跳过 install：

```ts
const dependencyFingerprint = dependencyFingerprintFromTree(tree);
const hasNodeModules = await containerHasNodeModules(container);
const needsInstall =
  !hasNodeModules || dependencyFingerprint !== installedDependencyFingerprint;
if (needsInstall) {
  callbacks.onStatus("installing");
  await runInstall(container, run, callbacks);
  installedDependencyFingerprint = dependencyFingerprint;
}
```

第四阶段，安装与启动都以普通进程形态 spawn，输出流直接进终端面板：

```ts
async function runInstall(container, run, callbacks) {
  // npm has a long-standing optional-dependency bug (npm/cli#4828): a
  // package-lock.json resolved on another OS/libc omits the WebContainer's
  // musl-specific optional deps (e.g. @rollup/rollup-linux-x64-musl), so the
  // install "succeeds" but Vite then fails to start. Drop the lockfile first.
  await removeIfPresent(container, "package-lock.json");
  const process = await container.spawn("npm", ["install"]);
  streamProcessOutput(process, callbacks.onLog);
  const exitCode = await process.exit;
  if (exitCode !== 0)
    throw new Error(`npm install exited with code ${exitCode}`);
}
```

启动 dev server 时用 Promise.race 把四条路径竞速：server-ready、进程退出、30 秒超时、用户取消，任何一条先到就收敛，避免悬挂：

```ts
unsubscribe = container.on("server-ready", (_port, url) => {
  resolveReady?.({ kind: "ready", url });
});
const process = await container.spawn("npm", [
  "run",
  "dev",
  "--",
  "--host",
  "0.0.0.0",
]);
streamProcessOutput(process, callbacks.onLog);
const outcome = await Promise.race([
  readyOutcome, // server-ready
  exitOutcome, // process.exit
  timeoutOutcome, // 30s
  run.cancelledOutcome,
]);
```

`--host 0.0.0.0` 不是装饰：容器内 Vite 必须显式监听所有接口，运行时的端口探测与预览代理才能可靠发现这个 server，这也是众多框架在 WebContainer 里需要 host 参数的同款原因。

第五阶段，双向同步。agent 改文件后客户端重拉文件树做三方合并写入容器；反向地，用户在容器里（终端、编辑器）产生的变更通过 fs.watch 回流到服务端：

```ts
// use-workspace-controller.ts:351
watcherRef.current = container.fs.watch(
  ".",
  { recursive: true },
  (_event, filename) => {
    const raw =
      typeof filename === "string" ? filename : decoder.decode(filename);
    const path = normalizePath(raw);
    if (path === "" || isIgnoredPath(path)) return;
    if (suppressRef.current.has(path)) {
      suppressRef.current.delete(path);
      return;
    }
    scheduleTerminalSync(path);
  },
);
```

### 6.4 预览脚本注入与错误回传

SDK 提供的 `setPreviewScript` 会把一段脚本注入未来所有预览页面的 HTML 响应里。yukino-codegen 用它注入可视化编辑脚本（use-visual-editor.ts:20：`.then((container) => container.setPreviewScript(editScriptSource))`），预览里点选元素经 postMessage 回传宿主页，映射回源码位置交给 agent。boot 时开的 `forwardPreviewErrors: true` 则让预览页的运行时异常以 PreviewMessage（uncaught-exception / unhandled-rejection / console-error 三种，见 entities.d.ts）回流，作为下一轮对话的上下文喂给 agent。这条"预览报错 → agent 修复 → 文件变更 → 容器重载"的回路，是 AI 生成应用产品闭环的关键一环。

### 6.5 平台二进制：npm/cli#4828 的由来

6.3 节 install 前删除 package-lock.json 的注释值得单独展开。Vite 生态大量依赖平台原生二进制（esbuild、@rollup/rollup-\*），npm 用 optionalDependencies 按 os/libc 选择。容器里的环境是 linux-x64-musl（WASM Node 用户态的 libc 模拟），而 lockfile 如果是在 macOS 或 glibc 机器上解析的，里面就没有 musl 变体条目；npm 按这份 lockfile 装出来的依赖"看起来装好了"，Vite 启动时却找不到原生绑定直接崩。这是 AI 代码生成产品的独特问题：lockfile 在服务器（agent 的 tmp 目录）上产生、在浏览器（WebContainer）里消费，两个环境的平台三元组不一致。yukino-codegen 的解法是装之前删锁文件让 npm 在容器内现场解析；实测报告中同类产品的解法更激进——vite-plugin-externals 把 react 系依赖指向项目内预置文件、HTML 直接从 CDN 引 UMD 包，让"冷启动"根本不需要装包。两条路线解决的是同一个约束：浏览器容器的安装速度决定产品体验。

## 七、工程实践要点（yukino-codegen 实录）

- 全局单例。@webcontainer/api 的 boot 强制单实例（`Only a single WebContainer instance can be booted`，内部用 bootPromise 自旋锁等前一次 boot 结束），yukino-codegen 用模块级 bootPromise 缓存启动 Promise、失败时清空重试，组件随便重挂载 dev server 不重启。
- 预览生命周期自成一代数系统。每次 startPreview 递增 generation，五个阶段每过一个 await 都断言"本代仍是最新的且宿主组件仍挂载"，取消、超时、新预览抢占统一走 cancelledOutcome 竞速，进程一律 safelyKill 兜底。这是浏览器单实例容器上多应用切换的正确写法。
- 日志钳制。容器进程输出流进 xterm 前 clamp 到 12000 字符（MAX_LOG_LENGTH），防止长会话内存膨胀。
- 冷启动三板斧：node_modules 跨次保留、依赖指纹跳过安装、npm install 前删锁文件。对照实测报告，同类产品还有第四板斧（依赖外置 + CDN UMD）与列表页的服务端快照预览（/preview/snapshot），按需取用。
- 服务端照常备份。容器的 FS 是内存文件系统，标签页一关就没了；yukino-codegen 在服务端维护真实项目目录（tmp/code_output/\{appId\}）与 git 快照，容器只是"预览执行环境"，权威数据永远在服务器侧。

## 八、局限与边界

- 文件系统易失。容器 FS 在内存里，刷新页面即重置，必须像 yukino-codegen 那样与服务器侧存储做同步。
- 单标签页单实例、算力受限。所有编译、安装、dev server 都消耗用户标签页的 CPU 与内存，复杂项目（大依赖树、全量打包构建）体验会明显衰减。
- 网络面窄。没有真实 TCP socket，出站靠浏览器网络栈桥接（官方经其代理服务），WS 靠桥接，任何依赖原始 socket、本机二进制（非 npm 分发的平台包）、长驻守护进程的东西都跑不了。
- COOP/COEP 的连带成本。宿主页自身也要隔离，第三方资源接入需逐个审查（第二、二.4 节）。
- 官方 API 的商业边界。运行时托管在 StackBlitz 基础设施（stackblitz.com/headless + \*.webcontainer.io），官方文档对商用规模、水印与授权有单独条款，重度使用需要评估这一点；自研运行时（如实测报告的 webc）本质上是把这笔成本换成了自建 Worker/WASM/代理域的研发成本。

## 九、参考资料

- StackBlitz 官方博客：Introducing WebContainers（blog.stackblitz.com/posts/introducing-webcontainers/）
- WebContainer 官网与 API 参考（webcontainers.io/、webcontainers.io/api）
- web.dev：Make your website "cross-origin isolated" using COOP and COEP（web.dev/articles/coop-coep）
- web.dev：Using WebAssembly threads from C, C++ and Rust（web.dev/articles/webassembly-threads）
- Chrome 官方博客：Load cross-origin resources without CORP headers using COEP credentialless（developer.chrome.com/blog/coep-credentialless-origin-trial）
- MDN：Cross-Origin-Embedder-Policy（developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cross-Origin-Embedder-Policy）
- Emscripten 文档：Pthreads support（emscripten.org/docs/porting/pthreads.html）
- StackBlitz 博客：Cross-Browser support with Cross-Origin isolation（blog.stackblitz.com/posts/cross-browser-with-coop-coep/）
- 本机源码：yukino-codegen 仓库 client/src（boot.ts、vite.config.ts、webcontainer-runtime.ts、webcontainer-fs.ts、use-workspace-controller.ts、use-visual-editor.ts）；@webcontainer/api 1.6.4 dist（index.js、entities.d.ts、internal/iframe-url.js、internal/constants.js）；yukino-codegen 仓库根目录调研报告 yukino-codegen.md（webc 运行时实测证据，第三、四、五节）
