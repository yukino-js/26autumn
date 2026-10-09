---
title: "WebContainer 运行原理与浏览器内 Vite"
description: "从 @webcontainer/api 1.6.4 发布产物出发解析 WebContainer: WASM 运行时与共享内存、COOP/COEP 跨源隔离、Atomics 与 Emscripten pthreads 的浏览器内并行化、SDK 与官方运行时的 iframe 边界, 以及 Vite dev server 为什么能在标签页内跑起来"
---

WebContainer 是 StackBlitz 提供的浏览器内 Node.js 运行时: 它把 Node 的用户态编译为 WebAssembly, 在浏览器标签页里提供一个可挂载文件、可启动进程、可监听端口的真实运行环境, 通过 @webcontainer/api 暴露给宿主应用。本文回答四个问题: 它的三层技术栈分别解决什么; 共享内存与跨源隔离(COOP + COEP)为什么是硬前提; 浏览器内的并行化是怎么实现到 POSIX 线程序级别的; 以及一个完整的 Vite dev server 为什么能在标签页内跑起来。文中引用的 API 与行为均可对照 @webcontainer/api 1.6.4 的发布产物核实; 涉及官方运行时内部实现、无法从 SDK 可观测的地方会明确标注为官方说明或推断。适合希望在产品中集成浏览器内运行时的前端与全栈工程师, 以及想理解浏览器沙箱边界的技术读者阅读。

## 一、总览:浏览器标签页如何变成一台开发机

### 1.1 三层技术栈

整个系统建立在三层技术上, 缺一层都跑不起来:

| 层     | 技术                                              | 解决的问题                                                      |
| ------ | ------------------------------------------------- | --------------------------------------------------------------- |
| 隔离层 | COOP + COEP 响应头, 使 `crossOriginIsolated` 为真 | 换取 SharedArrayBuffer 与高精度计时, 这是 WASM 多线程的准入条件 |
| 计算层 | 编译为 WASM 的 Node 用户态与 Emscripten pthreads  | 在浏览器里提供系统调用、文件系统、进程与线程                    |
| 网络层 | Service Worker 的请求拦截                         | 让"监听在某个端口上的 HTTP 服务器"对浏览器而言真实存在          |

与远程开发容器(GitHub Codespaces 一类)的本质区别在于算力归属: 远程容器的 dev server 跑在云主机上, 浏览器只是一块显示终端; WebContainer 把编译、依赖安装与 dev server 全部放进用户标签页, 平台侧只需下发静态资源, 零构建成本、零并发压力。代价是接下来各节要逐一处理的浏览器沙箱限制。

### 1.2 三个执行上下文与 iframe 边界

官方 SDK 的产物揭示了这套方案的进程拓扑: 宿主页面并不亲自持有运行时, 而是通过一个隐藏 iframe 与官方基础设施通信。SDK 的 `serverFactory` 会创建一个 `display:none` 的 iframe, 指向官方源上的无头页面(路径为 `headless`), 并带上协作参数与版本号; 宿主与它之间用 MessageChannel 建立 RPC, 此后一切容器操作(mount、spawn、fs、teardown)都是这条通道上的方法调用。

```text
宿主页面(集成方的源, 需跨源隔离响应头)
  |  postMessage 握手 -> MessageChannel -> Comlink RPC
  V
隐藏 iframe(官方基础设施源, 无头运行时页面)
  |  运行时宿主: WASM Node、Worker 群体、容器虚拟文件系统
  V
预览 iframe(官方预览子域)
  |  同源 Service Worker 拦截该源的请求并从容器虚拟文件系统应答
  V
容器内进程: 包管理器安装 -> 启动 dev server -> 监听容器内端口
```

需要强调这条边界: 宿主页与官方运行时分属不同源是刻意的。官方基础设施源自己配好了跨源隔离头, 宿主页只需通过消息通道做 RPC; 而容器的 HTTP 出口由注册在预览子域上的 Service Worker 承接。三个上下文里, 只有宿主页认识集成方自己的业务后端; 官方运行时对业务后端一无所知, 业务后端也完全不知道 WebContainer 的存在。排障时的分界线也在这里: 文件树拉不到、Agent 不产出, 查业务后端; 容器起不来、预览白屏, 查官方源与预览子域的连通性。

### 1.3 网络依赖清单

浏览器端需要可达的端点如下(全部由浏览器发起):

| 端点                                          | 何时访问           | 承载内容                       | 不可达时的表现                |
| --------------------------------------------- | ------------------ | ------------------------------ | ----------------------------- |
| 官方无头运行时页面(基础设施源上的 `headless`) | `boot()` 时        | 运行时代码包与版本信息         | boot 失败, 预览功能整体不可用 |
| 官方预览子域                                  | 端口就绪后渲染预览 | 预览文档与 Service Worker 脚本 | 预览白屏                      |
| 包仓库(经运行时桥接出站)                      | 容器内安装依赖     | 依赖包与平台二进制             | 安装失败                      |
| 集成方业务后端                                | 全程               | 文件树、Agent 通道、业务接口   | 页面无数据、连接断开重连      |

官方 SDK 的文档还给出两条部署约束: 生产环境的页面必须通过 HTTPS 提供(localhost 在开发期被浏览器部分豁免), 以及第三方 Cookie 拦截插件可能导致运行时无法正常工作。此外运行时依赖官方的托管代理与服务端加速, 这意味着内网与离线环境无法使用官方 API——这是第七节"限制与代价"的根源之一。

## 二、隔离层:跨源隔离与 SharedArrayBuffer 的准入条件

### 2.1 为什么浏览器默认不给共享内存

SharedArrayBuffer 允许多个执行线程读写同一段内存。Spectre 一类时序侧信道漏洞公开后, 浏览器厂商发现纳秒级计时配合共享内存的读写竞争, 足以跨源窃取数据, 于是把共享内存收窄为只发给"把自己隔离干净"的页面, 这个状态叫跨源隔离。页面满足两个响应头时, `crossOriginIsolated` 才为真:

| 响应头                       | 取值                               | 语义                                                                                                 |
| ---------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Cross-Origin-Opener-Policy   | `same-origin`                      | 把当前浏览上下文从跨源 opener 关系中隔离出来                                                         |
| Cross-Origin-Embedder-Policy | `require-corp` 或 `credentialless` | `require-corp` 要求每个跨源子资源显式声明授权; `credentialless` 允许以去凭据方式加载未声明的跨源资源 |

满足隔离后浏览器开放的能力包括 SharedArrayBuffer、`WebAssembly.Memory({ shared: true })` 与更高精度的计时能力。这正是 WASM 多线程的全部硬件前提。官方 SDK 的 README 与类型定义都把这两个响应头写成硬前提: 根文档必须提供 COOP 与 COEP(文档示例取 `require-corp`, 而 boot 选项支持更宽松的 `credentialless`), 否则运行时无法工作。

### 2.2 boot 选项与真实配置

SDK 的 `BootOptions` 里, `coep` 的取值是 `require-corp`、`credentialless` 或 `none`, 并且在第一次 boot 时固定、后续重启无法更改。SDK 内部对头与选项的关系有防御逻辑: 当页面已经处于跨源隔离状态, 却传入 `coep: 'none'` 时直接打印警告, 因为容器的 iframe 需要继承隔离状态, 头不能撤销。

```js
if (window.crossOriginIsolated && options.coep === "none") {
  console.warn(
    "A Cross-Origin-Embedder-Policy header is required in cross origin isolated environments.\nSet the 'coep' option to 'require-corp'.",
  );
}
```

宿主应用通常把两个头同时挂在开发服务器与预览服务器上, 并在启动容器前显式检查隔离状态, 把"忘了配头"这种部署错误变成清晰报错而不是晦涩的启动失败:

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

`credentialless` 相对 `require-corp` 更宽容: 跨源无授权声明的资源改为去凭据加载, 不再要求对方配置 CORP, 对包仓库与外部图片更友好, 因此是预览第三方生成应用的合理选择。

### 2.3 iframe 的隔离继承

隔离状态不会自动穿过 iframe。子框架要么自己满足两个头, 要么在 iframe 标签上显式声明继承。SDK 创建运行时 iframe 时同时做了这两件事:

```js
const iframe = document.createElement("iframe");
iframe.style.display = "none";
iframe.setAttribute("allow", "cross-origin-isolated");
iframe.src = iframeSettings.url.toString();
```

`allow="cross-origin-isolated"` 是标准的特性策略开关, 让官方源上的子框架继承宿主页的隔离状态, 容器内部的 Worker 与 WASM 线程才拿得到共享内存。这也解释了为什么 boot 的 `coep` 选项必须与宿主页响应头一致: iframe 继承的是宿主页的隔离状态, 头一旦撤掉, 容器里的 WASM 线程就会失去共享内存。

### 2.4 COEP 的工程代价

COEP 是这套方案最容易被低估的摩擦点: 一旦启用, 页面里所有跨源子资源(第三方图片、字体、统计脚本)都必须配合 CORS 或 CORP, 否则直接加载失败。`credentialless` 是后来给出的折中取值。给宿主页配置 COEP 时要先把第三方资源清单过一遍; 自建静态托管时, 必须确保提供 HTML 的那一层补上这两个头, 而不是只在上游构建工具里配置。

## 三、计算层:WASM 共享内存与浏览器内并行化

### 3.1 WebAssembly.Memory 与 SharedArrayBuffer

WASM 的线性内存通过 `WebAssembly.Memory` 暴露给 JavaScript, 加上 `shared: true` 后它的缓冲区就是 SharedArrayBuffer:

```js
const memory = new WebAssembly.Memory({
  initial: 1600, // 以页为单位, 1 页 = 64 KiB
  maximum: 32768,
  shared: true, // memory.buffer 即 SharedArrayBuffer
});
```

把同一个缓冲区或同一个 Memory 对象传给多个 Worker, 得到的是同一段物理内存的多个引用: 这里不存在拷贝, 也不需要转移所有权, 结构化克隆对共享内存的语义就是共享。WASM 模块实例化时接收这份内存, C/C++/Rust 侧的全局堆于是成为所有线程可见的共享堆。这就是 Node 能在浏览器里"多线程"的关键: 线程池、平台层、工作线程等, 编译到 WASM 后统统落在这套"Worker + 共享堆 + Atomics"的原语上。

### 3.2 Atomics 与主线程约束

共享内存只把数据放在了一起, 线程同步靠 Atomics:

- `Atomics.load / store / add / compareExchange`: 原子读写与读改写操作, 对应 WASM 的原子指令;
- `Atomics.wait(typedArray, index, value, timeout)`: 阻塞当前线程直到该位置的值变化或收到通知, 对应 futex 语义;
- `Atomics.waitAsync`: 非阻塞版本, 返回 Promise。

一个关键约束是主线程禁止调用 `Atomics.wait`: 浏览器会直接抛错, 因为阻塞主线程会冻结整个页面的事件循环。所有"在主线程等待一个共享内存标志"的需求都必须改写为异步等待或消息通知。Emscripten 的 pthreads 运行时为此做了完整的降级路径, 自研运行时同样必须遵守这条纪律——容器里所有会阻塞的同步逻辑都跑在 Worker 中, 主线程只负责 RPC 与调度。

### 3.3 Emscripten pthreads:POSIX 线程到浏览器的映射

Emscripten 是把 C/C++ 编译到 WASM 的工具链, 它的 pthreads 支持是把 POSIX 线程序语义搬到浏览器的参考实现, 官方运行时的并行化同源同种。核心机制如下:

1. 编译期链接 pthread 运行时并开启共享内存;
2. 主模块启动时预创建 Worker 池(默认按需懒创建), 每个 Worker 预先收到同一份共享内存;
3. 创建线程时从池中取 Worker, 把线程入口与参数写进共享内存, 再用 `Atomics.notify` 唤醒目标 Worker, Worker 侧以相同的 Memory 实例化同一个 WASM 模块并执行入口;
4. 互斥量与条件变量用共享堆上的原子变量模拟, 以自旋与阻塞等待的混合锁实现; 线程 join 同理;
5. Worker 里可以放心使用阻塞等待, 这是把"等待"全部搬到 Worker 的结构性原因。

链条至此闭环:

```text
WASM 多线程 -> SharedArrayBuffer -> crossOriginIsolated -> COOP + COEP 响应头
```

### 3.4 共享内存的扩容语义

与非共享内存扩容后旧缓冲立即失效不同, 共享内存的扩容可以在线完成(需要实例化时预留上限), 已有缓冲不失效, 各线程通过同一 Memory 对象看到一致的容量。工程上的坑在于视图刷新: 扩容之后需要重新从内存缓冲区建立 TypedArray 视图, 持有旧视图的线程会继续用旧的字节长度判断边界。自研运行时如果绕开 Emscripten, 这是最容易踩的一处。

## 四、SDK 与官方运行时的边界

这一节的内容全部来自 SDK 产物可直接观察到的行为。

### 4.1 boot 单例与握手

一个页面只允许存在一个容器实例。SDK 用一个静态实例字段与一个"永不失约"的 boot Promise 自旋锁串行化启动: 已有实例时抛错, 已有启动中的 Promise 时先等待它结束。失败可重试的前提是调用方清空自己的缓存 Promise。`teardown()` 按"先关文件系统监听、再调运行时 teardown、最后释放 Comlink 代理"的顺序销毁实例, 重复调用抛错; 下一次 `boot` 会先等待上一次 teardown 的 Promise 落定, 因此"销毁再重建"是安全的串行流程。

启动流程是: 创建隐藏 iframe(带 `allow="cross-origin-isolated"` 与版本查询参数), 等待它发来 `init` 消息, 从事件里取出 MessageChannel 端口并用 Comlink 包成 RPC 代理, 然后调用运行时的 `build` 方法(携带宿主主机名、版本、工作目录名与预览错误转发开关), 最后并行取回文件系统、预览脚本与运行时信息三个句柄。

iframe 的源默认是官方编辑源(SDK 内唯一的源常量), 路径固定为 `headless`, 查询参数携带 coep 选项与 SDK 版本号; 全局变量 `WEBCONTAINER_API_IFRAME_URL` 可以覆写这个源(机制可核实, 用途属推断: 指向替代的运行时页面)。另有一个 `configureAPIKey(key)` 导出: 把 API key 写进 iframe URL 的 `client_id` 参数, 必须在 `boot` 之前调用, 否则抛错——SDK 用 bootCalled 标记强制这个顺序。

```js
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
      return;
    }
  };
  window.addEventListener("message", onMessage);
});
```

注意握手阶段就校验了 `event.origin`, 只接受来自官方运行时源的消息; 运行时的告警也经这条消息通道回传宿主控制台。

### 4.2 挂载:序列化、转移与内部格式

`mount` 接受三种输入: 外部的文件树对象、二进制快照字节数组, 或 ArrayBuffer。文件树对象会先被编码为 JSON 字节, 再以可转移对象的方式移交所有权(拷贝次数为零)送到容器虚拟文件系统:

```js
mount(snapshotOrTree, options) {
  const payload =
    snapshotOrTree instanceof Uint8Array
      ? snapshotOrTree
      : snapshotOrTree instanceof ArrayBuffer
        ? new Uint8Array(snapshotOrTree)
        : encoder.encode(JSON.stringify(toInternalFileSystemTree(snapshotOrTree)));
  return this._instance.loadFiles(Comlink.transfer(payload, [payload.buffer]), {
    mountPoints: options?.mountPoint,
  });
}
```

外部的文件树是一个递归结构: 目录节点用 `directory` 包裹子节点, 文件节点用 `file.contents` 承载字符串或字节数组, 还支持符号链接节点。序列化时会被压成一种紧凑的内部表示(目录、文件、文本或二进制标记、符号链接目标), 二进制内容以 latin1 字符串承载并标注二进制位。宿主传入的路径挂载点可把整棵树挂到工作目录的子目录下。

### 4.3 进程:spawn 与流桥接

`spawn` 的签名接受命令、参数数组与选项(工作目录、环境变量、是否为终端指定行列尺寸、是否回传输出):

```js
spawn(command, optionsOrArgs, options); // -> Promise<WebContainerProcess>
```

SDK 在宿主侧创建若干回调, 用 Comlink 把它们代理到容器侧执行, 再推入标准的 ReadableStream, 最终包装为一个进程对象。进程对象暴露:

| 成员                   | 类型                     | 语义                                         |
| ---------------------- | ------------------------ | -------------------------------------------- |
| `output`               | `ReadableStream<string>` | 合并的终端输出, 包含子进程输出, 可用选项关闭 |
| `input`                | `WritableStream<string>` | 写入附加的伪终端                             |
| `exit`                 | `Promise<number>`        | 退出码                                       |
| `kill()`               | 方法                     | 终止进程                                     |
| `resize({cols, rows})` | 方法                     | 调整终端尺寸                                 |

进程输出经 Comlink 代理回调回流, 而非把整个输出缓冲一次性取回, 这是长驻进程(安装、dev server)体验的基础。终端尺寸可调, 使交互式 shell 与终端模拟器能正确换行与重绘。

### 4.4 文件系统原语与监听

SDK 暴露的文件系统 API 模仿 Node 的 `fs.promises`, 但作用域被限定在启动时确定的工作目录内, 所有路径相对该目录解析。提供的能力包括: 列目录(可选返回目录项对象)、读文件(按编码返回字符串或字节)、写文件(字节数组走可转移对象)、创建目录、删除、重命名, 以及监听文件变更。

监听回调收到事件类型与文件名; SDK 内部维护一个监听器集合, 关闭监听时先从集合移除再释放远端代理。这套 `fs.watch` 是"浏览器内改动回流到服务器"的关键: 用户在容器终端或编辑器里的写入, 会触发宿主侧监听, 由宿主决定是否回写权威存储。

与 `mount` 对称, 实例级的 `export(path, options)` 把容器内的一棵目录序列化回宿主: `format` 取 `json`(返回与 mount 同构的文件树对象)、`binary` 或 `zip`(返回字节数组), `includes` / `excludes` 用 glob 模式过滤。"容器改动 -> export -> 权威存储"与"权威存储 -> mount -> 容器"构成完整的双向同步原语, 易失文件系统的持久化策略就建立在这一对操作之上。

### 4.5 事件面与预览消息

`on` 提供的事件面覆盖了容器运行的主要观测点:

| 事件                | 回调参数        | 用途                                     |
| ------------------- | --------------- | ---------------------------------------- |
| `server-ready`      | 端口与 URL      | 某个进程开始监听端口, 可把 iframe 指过去 |
| `port`              | 端口、状态、URL | 端口打开与关闭的状态变化                 |
| `preview-message`   | 预览消息对象    | 预览页的运行时错误转发                   |
| `error`             | 错误对象        | 运行时内部错误                           |
| `xdg-open` / `code` | 文本或代码事件  | 容器内调用打开命令时的钩子               |

`forwardPreviewErrors` 开关控制是否把预览 iframe 中的错误转发给宿主, 来源有三类, 对应三种消息类型:

- `PREVIEW_UNCAUGHT_EXCEPTION`: 页面未捕获异常, 含消息与调用栈;
- `PREVIEW_UNHANDLED_REJECTION`: 未处理的 Promise 拒绝;
- `PREVIEW_CONSOLE_ERROR`: `console.error` 调用, 含参数与调用栈。

每条消息还带预览标识、端口、路径名、查询串与哈希, 便于定位是哪个预览页的哪条路由出错。设为 `exceptions-only` 时不会转发控制台错误。

SDK 还提供 `setPreviewScript`: 向所有未来重新加载的预览页注入一段脚本(可指定 `module` / `importmap` 类型与 defer / async 属性), 但已打开的预览需要显式重新加载才生效。独立的 `/webcontainer/connect` 子路径导出 `setupConnect`, 用于"预览开在另一个标签页"的形态: 该页必须服务在 `/webcontainer/connect/` 路径下且由 opener 打开, 函数内部再挂一个指向官方源同路径的隐藏 iframe, 在 opener 与 iframe 之间双向透传 postMessage(递归收集并转移其中的 MessagePort), 收到 `close` 指令时自行关窗——多标签预览的连接由此复用同一条运行时通道。配套的 `reloadPreview` 工具函数走一条端口协议: 通过 MessageChannel 向预览页发送重载指令, 预览页回传重载完成消息; 若在很短的超时内没有回执, 则退化为直接重置 iframe 的 `src`。这条"先礼后兵"的刷新策略, 说明预览页与宿主之间不仅有单向注入, 还有一条回执通道。

### 4.6 私有包与 OAuth 鉴权

SDK 导出一个独立的 `auth` 模块, 解决"容器内安装私有 npm 包"的凭据问题, 走 OAuth 2.0 + PKCE:

- `auth.init({ clientId, scope, editorOrigin? })` 在应用初始化时调用一次(服务端渲染则每个用到 API 的页面都要调), 从当前 URL 读取 `code` / `error` 参数完成回调侧处理, 返回 `need-auth` / `authorized` 状态或 auth-failed 错误; 必须在 `boot` 之前调用, SDK 同样用 bootCalled 标记拦截错误顺序;
- `auth.startAuthFlow({ popup? })` 重定向当前页(或弹窗)到官方编辑器源完成授权, `editorOrigin` 缺省为官方站点;
- `auth.loggedIn()` 返回一个保证永不 reject 的 Promise, 授权完成即 resolve, 适合在 spawn 安装命令前 await;
- `auth.logout({ ignoreRevokeError? })` 撤销并清空本地凭据; `on('logged-out')` 与 `on('auth-failed')` 订阅凭据被撤销或用户在别处拒绝授权的事件。

boot 之后, 容器实例把 access token 经 `setCredentials` 推进运行时, 并订阅 token 变化持续同步——私有包的拉取由运行时侧携带凭据完成, 宿主页面不经手包内容。凭据状态经 BroadcastChannel 与本地存储在多标签页间共享, 这是 SDK 内部常量的用途之一。

### 4.7 官方运行时的推断边界

官方运行时内部的 Worker 拓扑没有公开源码, SDK 只通过一条消息端口与之通信。因此可以确定的是边界: 运行时是一个独立执行域, 宿主只持有它的 RPC 代理; 全部容器操作都是跨 iframe 的方法调用; 二进制载荷走可转移对象而非拷贝; 进程输出经代理回调回流。只能推断的是内部实现: 每个容器进程对应一个或多个 Worker 中的 WASM 实例, pthread 池提供线程, Service Worker 在自己的全局作用域里承担网络入口, 彼此通过共享内存与消息总线协作。官方对外只表述为"把虚拟化 TCP 网络栈映射到 Service Worker 上"。平台层面能确定的结构是: 文件系统、进程执行、网络分属不同的执行域, 中间用共享内存与消息通道缝合——这是把 Node 用户态跑进浏览器时问题本身决定的形状, 而非某个实现的自由选择。

## 五、网络层:Service Worker 虚拟化

### 5.1 拦截模型与两条硬约束

Service Worker 是浏览器在页面之外运行的一段脚本, 注册时声明作用域, 此后该作用域下页面发出的 HTTP 请求都会先经过它的 fetch 事件, 脚本可以用 `respondWith` 自行构造 Response。WebContainer 把它从"离线缓存"用成了"浏览器内存里的虚拟 Web 服务器": 请求的路径在真实服务器上根本不存在, Service Worker 把它交给容器运行时, 容器从虚拟文件系统取内容(必要时现场编译转换)拼成 Response 返回。

两条决定性限制:

1. Service Worker 只能拦截 HTTP(S) 请求, WebSocket 等非 HTTP 通道不在 fetch 事件覆盖范围内;
2. Service Worker 只能注册在自己的源上, 只能拦截同源请求。

### 5.2 官方方案:独立预览子域

`server-ready` 事件的回调签名是 `(port, url)`, 其中 URL 指向官方托管的预览子域(官方文档公开的形态是: 凭证无凭据模式使用一类子域, 严格模式使用另一类子域)。这些预览域名不在本地 SDK 产物里: SDK 中唯一的官方源常量是无头运行时的编辑源, 预览 URL 由运行时在端口就绪后动态下发。结构上是: 预览 iframe 挂在官方预览域上, Service Worker 注册并拦截该源的全部请求, URL 到容器端口的映射由该源的子域约定完成。同源 iframe 才能被本源 Service Worker 覆盖, 因此容器必须拥有自己的源——这也是对宿主页要求跨源隔离头、对子域做独立部署的根本原因。

### 5.3 同源作用域的两条推论

同源约束推出两个形态选择:

- 容器需要独立的源。宿主页的源上没法同时承载"产品应用"与"容器虚拟服务器": 作用域会互相干扰, 而宿主页自身的 URL 又不能随容器端口变化。官方因此把容器出口放到独立子域, 按实例与端口映射到不同子域。
- 若要把容器塞回宿主站点自己的源(例如内网部署、不愿引入官方预览域), 唯一可行形态是把实例与端口编码进路径, 由站点根作用域的 Service Worker 按路径前缀分流: 容器请求前缀交给虚拟文件系统应答, 站点自身资源与真实接口放行。代价是 Service Worker 必须自行区分多类请求, 多实例要靠路径里的实例标识隔离。

选择路径方案时还有一个必须注意的 sandbox 细节: 当预览 iframe 与宿主同源时, `allow-same-origin` 与 `allow-scripts` 同时开启会形成沙箱逃逸组合(脚本可以摘掉自己的沙箱)。因此同源承载容器产物时, 要么让 iframe 落到独立源或子域, 要么在 sandbox 中收紧同源许可。这与承载不受信第三方代码的 iframe 方案遵循的是同一条浏览器规则。

无论选子域还是路径, 预览 iframe 都只能被它自己源上的 Service Worker 接管, 因此 iframe 的 `src` 必须落在该 Service Worker 的作用域内。

### 5.4 出站网络:依赖安装怎么出去

Service Worker 解决的是入站请求。容器进程也有出站需求: 安装依赖要访问包仓库。WASM 环境没有真实 TCP socket, 官方的说法是把虚拟化 TCP 栈映射到 Service Worker 通道, 出站调用最终被桥接到浏览器侧以 fetch 方式发出, 经官方代理服务访问外网。这带来两个直接影响: 出站能力受宿主浏览器网络栈约束, 且受官方代理可用性约束。

### 5.5 WebSocket 例外与 HMR

fetch 事件只覆盖 HTTP(S) 请求, WebSocket 升级请求不经过它——这是平台规则, 任何基于 Service Worker 的网络虚拟化都必须单独处理 WebSocket。官方运行时在预览文档内桥接 WebSocket, 因此 Vite 的热更新能正常工作。这条桥接发生在官方运行时内部, 本地 SDK 产物中不可见, 此处按官方行为陈述而非逐行核实。对自研运行时而言, 这是最容易被低估的缺口: HTTP 通道被 Service Worker 接管后看起来一切正常, 但热更新的 WebSocket 直连容器内端口却无人应答, 只能靠文件变更全量写盘加页面重载兜底。

## 六、为什么 Vite 能在标签页里跑起来

### 6.1 Vite dev server 的请求模型

Vite 开发模式不做整包打包, 而是按需编译、以原生 ES 模块直出。一个 Vite + 前端框架项目冷启动后, 浏览器发出的请求大致是这几类:

```text
/@vite/client                           热更新客户端(注入每个页面, 负责连接与模块热替换)
框架插件的刷新前导脚本                    例如 React 的 refresh 前导脚本
/node_modules/.vite/deps/<pkg>.js       依赖预构建产物(打包器把包打成单文件模块)
/node_modules/.vite/deps/_metadata.json 预构建清单
/src/main.tsx  /src/App.tsx             业务源码, 现场转译直出
/src/index.css                          按需处理的样式
```

关键性质是: 这些请求全都是无状态的 HTTP GET——给路径、回文件。没有会话、没有数据库、没有跨请求的服务端状态, 所有状态都在 Vite 进程的内存(模块图与转译缓存)与磁盘(依赖目录、预构建缓存)里。这个模型天然适合被 Service Worker 虚拟化: 只要进程与文件系统在浏览器里真实存在, 每个请求就能被逐个应答。

### 6.2 Vite 是纯 Node 程序

Vite dev server 本质上是一条 connect 风格的中间件链, 跑在 Node HTTP 服务器上, 依赖的 Node 能力是文件读取与预构建缓存写入、网络监听, 以及少量路径与系统信息。这些恰好都是编译到 WASM 的 Node 用户态能覆盖的部分: 文件系统落在虚拟文件系统, 网络监听被映射成 Service Worker 通道。当 Vite 在容器里打印监听地址时, 运行时通过端口就绪事件把端口与可用的预览 URL 回传给宿主, 宿主把 iframe 指向该 URL, 请求随即落入 Service Worker 的拦截范围。

启动 dev server 时需要显式让它监听所有接口, 而不是只绑定本地回环。这不是装饰性参数: 运行时的端口探测与预览代理按容器网络层发现服务, 只绑定回环地址会导致端口就绪事件迟迟不触发, 这也是众多框架在 WebContainer 里需要额外传入主机参数的同一原因。

### 6.3 三层拼合的闭环

三层技术在 Vite 场景下拼合成完整闭环:

```text
Vite 的 HTTP 服务器监听容器内端口 (WASM 网络层)
        -> 端口就绪事件 (server-ready)
宿主页把预览 iframe 指向预览 URL (官方预览子域)
        -> 浏览器发起 fetch
Service Worker 拦截 -> 容器虚拟文件系统 + Vite 现场转译 -> Response
        -> 浏览器渲染, 热更新客户端建立通道 (WebSocket 经运行时桥接)
```

### 6.4 平台二进制与 musl 陷阱

Vite 生态大量依赖平台原生二进制(打包器与压缩器都有按操作系统与 C 库分发的可选依赖), 包管理器按 `os/cpu/libc` 选择。容器模拟的是 Linux + musl 环境, 而开发者机器通常是 glibc(macOS、Windows、多数 Linux 发行版)。如果依赖清单是在 glibc 机器上解析的, 里面就没有 musl 变体条目, 装出来的依赖看起来装好了, 启动时却找不到原生绑定而直接崩溃。

这是 AI 代码生成产品特有的问题: 依赖清单可能在服务器上产生、在浏览器容器里消费, 两个环境的平台三元组不一致。常见解法是安装前删除锁文件, 让包管理器在容器内现场解析; 更彻底的路线是把依赖外置(预置文件加 CDN), 让冷启动根本不需要装包。两条路线解决的是同一个约束: 浏览器容器的安装速度决定产品体验。

## 七、限制与代价

- 文件系统易失。容器文件系统在内存里, 刷新页面即重置, 必须与服务器侧存储做同步, 权威数据不能放在容器里。
- 单标签页单实例、算力受限。所有编译、安装与 dev server 都消耗用户标签页的 CPU 与内存, 大依赖树或全量打包构建的体验会明显衰减。
- 网络面窄。没有真实 TCP socket, 出站靠浏览器网络栈桥接并经官方代理, WebSocket 靠桥接; 任何依赖原始 socket、非包管理器分发的本机二进制、长驻守护进程的东西都跑不起来。
- 隔离的连带成本。宿主页自身也要开启跨源隔离, 第三方资源接入需逐个审查并补授权头。
- 运行时的托管依赖。官方 API 依赖 StackBlitz 的托管代理与服务端加速, 并在其服务条款下提供; 离线与内网环境不可用, 重度商用需要评估授权与水印条款。自研运行时本质上是把这笔外部成本换成了自建 Worker、WASM 与代理域的研发成本。
- 预览错误只覆盖三类。转发到宿主的错误仅限未捕获异常、未处理拒绝与控制台错误, 不包含网络失败与框架内部的静默降级, 产品侧仍需自行补充诊断手段。

## 八、延伸阅读

- StackBlitz 官方博客: Introducing WebContainers
- WebContainer 官网与 API 参考(webcontainers.io 及其 API 文档)
- web.dev: Make your website cross-origin isolated using COOP and COEP
- web.dev: Using WebAssembly threads from C, C++ and Rust
- MDN: Cross-Origin-Embedder-Policy 与 Cross-Origin-Opener-Policy
- Emscripten 文档: Pthreads support
- StackBlitz 博客: Cross-Browser support with Cross-Origin isolation
