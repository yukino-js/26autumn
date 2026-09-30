---
title: "@yukino.js/sentry 前端监控 SDK 技术笔记"
---

> 本机器路径 `$HOME/github/yukino-sentry/sentry`, 基于 `@yukino.js/sentry` 0.0.1 源码

## 项目整体架构设计是怎样的? 核心模块有哪些?

@yukino.js/sentry 是一个框架无关的浏览器端监控与分析 SDK, 采用分层架构设计, 核心模块如下:

```
┌───────────────────────────────────────────────------──────┐
│                   Public API Layer                        │
│  init / destroy / isInitialized / enablePlugin            │
│  + traceError / tracePerformance / traceCustomEvent       │
│  + tracePageView / reportFrameworkError                   │
│  + setUserId / setVisitorId / getIdentity                 │
│  + beforeSend / beforeSendBatch / afterSend               │
│  + flushOfflineCache  (以及全部类型/枚举 re-export)       │
├───────────────────────────────────────────────────------──┤
│                   Core Layer                              │
│  sdk-lifecycle / setup / bus / decorates / handlers       │
│  + pv-lifecycle / white-screen / identity                 │
├───────────────────────────────────────────────────------──┤
│                  Reporter Layer                           │
│  DataReporter / transports / offline-cache /              │
│  server-recovery / flush-scheduler / send-preflight       │
├────────────────────────────────────────────────────------─┤
│                  Plugin Layer                             │
│  PerformancePlugin / ScreenRecordPlugin / ExposurePlugin  │
├──────────────────────────────────────────────────------───┤
│                  Framework / Node Layer                   │
│  react.ts / vue.ts / vite.ts / webpack.ts                 │
│  + node/dev-endpoint / source-map  (Node-only)            │
├──────────────────────────────────────────────────------───┤
│                  Utils Layer                              │
│  data-structures / session / uuid / throttle /            │
│  click-data / dom2str / logger                            │
└──────────────────────────────────────────────────------───┘
```

核心模块职责:

| 模块         | 路径                      | 职责                                                   |
| ------------ | ------------------------- | ------------------------------------------------------ |
| SDK 生命周期 | `core/sdk-lifecycle.ts`   | init/destroy/enablePlugin 入口                         |
| 事件总线     | `core/bus.ts`             | 基于 Map\<EventType, Set`<Handler>`> 的发布订阅        |
| 猴子补丁调度 | `core/decorates.ts`       | 统一安装/卸载浏览器 API 拦截                           |
| HTTP 拦截    | `core/decorate-http.ts`   | XHR/Fetch 请求监控                                     |
| 路由拦截     | `core/decorate-route.ts`  | History 路由变化监听 (Hash 模式在 `core/decorates.ts`) |
| PV 生命周期  | `core/pv-lifecycle.ts`    | PageLoad/路由 PV/停留时长                              |
| 白屏检测     | `core/white-screen.ts`    | 视口采样点检测 (setup 直接启动, 不走总线)              |
| 数据上报器   | `reporter/index.ts`       | 批量队列、传输选择、离线缓存                           |
| 插件注册     | `core/plugin-registry.ts` | 插件 Set 管理与生命周期                                |
| 配置校验     | `core/options-schema.ts`  | Zod schema 运行时校验                                  |

设计原则:

1. 发布订阅解耦: 数据采集 (Producer) 与数据处理 (Consumer) 通过事件总线完全解耦
2. 可插拔插件: 性能、录屏、曝光等重功能以插件形式按需加载
3. 框架无关核心: 核心不依赖任何框架, 通过独立入口文件提供框架集成
4. 多出口构建: package.json exports 提供 `.`、`./plugins`、`./react`、`./vue`、`./vite`、`./webpack` 六个入口, 每个入口都有 ESM/CJS/类型三套产物

---

## SDK 的初始化流程是怎样的? 有哪些防护机制?

初始化入口为 `init(options)` 函数 (`core/sdk-lifecycle.ts`) , 完整流程:

```typescript
export function init(options: InitOptions): void {
  // 1. 单例守卫 (最先检查, 避免重复 parse 开销)
  if (isInitialized()) return;

  // 2. 剔除显式 undefined 字段 (防止 { userId: undefined } 覆盖默认值)
  const provided = Object.fromEntries(
    Object.entries(options).filter(([, value]) => value !== undefined),
  );

  // 3. 合并默认配置 + Zod 校验
  const parsedOptions = optionsSchema.parse({
    ...DEFAULT_OPTIONS,
    ...provided,
  });
  sentry.setOptions(parsedOptions);

  // 4. 防护检查
  if (sentry.options.disabled) return; // 用户主动禁用
  if (dsn === "") return; // DSN 为空拒绝初始化

  // 5. 设置面包屑容量, 启动事件订阅和猴子补丁
  breadcrumb.capacity = sentry.options.maxBreadcrumbs;
  cleanupSetup = setup();

  // 6. 异步初始化身份识别
  void initIdentity();
}
```

防护机制:

1. 单例守卫: `isInitialized()` 通过 `cleanupSetup !== null` 判断, 防止重复初始化. 放在最前面是因为重复调用 init 是常见场景 (如 HMR), 提前返回避免不必要的 zod parse 开销
2. 显式 undefined 剔除: `InitOptions` 类型允许字段为 `T | undefined`, init 在合并前过滤掉值为 undefined 的键, 保证它们回落到默认值而不是把默认值冲掉
3. Zod 运行时校验: 所有配置项通过 `optionsSchema.parse()` 校验, 非法配置会抛出明确错误
4. disabled 开关: 支持通过配置完全禁用 SDK (适用于 A/B 测试或环境区分)
5. DSN 非空检查: 上报地址为空时拒绝初始化, 避免无效运行
6. destroy 完整清理: 销毁时依次执行 `destroyPlugins()` -> `cleanupSetup()` -> `destroyBatchErrorManager()` -> `resetReporter()`, 再清空面包屑缓冲、错误去重集合并复位 `shouldScreenRecord` 标记, 确保无内存泄漏且下一次 init 从全新状态开始

setup() 做了什么:

`setup()` 按开关安装各事件类型的总线订阅和猴子补丁, 当 `enableWhiteScreen: true` 时直接启动白屏采样, 调用 `initPageView()` 立即上报 PageLoad, 并注册 `pagehide` 监听在页面隐藏时补发当前页停留时长. 它返回一个 cleanup 函数, 内部收集了所有取消订阅函数和补丁还原函数, `destroy()` 时按注册的逆序一次性还原, 保证 SDK 可以安全地从页面中移除.

---

## 事件总线 (Pub/Sub) 是如何设计的? 为什么选择这种模式?

事件总线实现在 `core/bus.ts`, 核心数据结构为 `Map<EventType, Set<TEventHandler>>`:

```typescript
// 核心结构
const event2handlers = new Map<EventType, Set<TEventHandler>>();

// 发布 (每个 handler 单独 try/catch, 单个消费者抛错不影响其他消费者)
function pub(type: EventType, data: TReportPayload): void {
  const handlers = event2handlers.get(type);
  if (!handlers) return;
  for (const handler of handlers) {
    try {
      handler(data);
    } catch (err) {
      sentryLogger.error("Error executing event handler", err);
    }
  }
}

// 订阅 (返回清理函数)
function sub(type: EventType, handler: TEventHandler): Cleanup {
  if (!event2handlers.has(type)) event2handlers.set(type, new Set());
  event2handlers.get(type)!.add(handler);
  return () => event2handlers.get(type)?.delete(handler);
}
```

选择 Pub/Sub 模式的原因:

1. 解耦采集与处理: 猴子补丁 (Producer) 只负责发布原始事件, 不关心后续如何处理 (上报、面包屑、录屏触发等)
2. 一对多分发: 一个 HTTP 事件可以同时触发上报、面包屑记录、屏幕录制标记等多个消费者
3. 可测试性: 可以独立测试采集层和处理层, mock 总线即可
4. 动态订阅: 插件可以在运行时订阅/取消订阅, 无需修改核心代码
5. 异常隔离: pub 对每个 handler 单独 try/catch, 一个消费者抛错不会中断其余消费者, 也不会把异常抛回生产者
6. 清理友好: 每个 `sub()` 返回 cleanup 函数, `destroy()` 时调用 `clearSubscriptions()` 一次性清空

与 EventEmitter 的区别:

- 使用 `Set` 而非数组存储 handler, 天然去重且删除为 O(1)
- 类型约束为 `EventType` 枚举, 编译期即可发现事件名拼写错误
- 不继承 Node.js EventEmitter, 零依赖且体积更小 (TMD 浏览器 SDK 怎么能继承 Node.js EventEmitter?)

---

## HTTP 请求监控是如何实现的? XHR 和 Fetch 的拦截有什么区别?

HTTP 监控通过猴子补丁 (Monkey Patching) 实现, 位于 `core/decorate-http.ts`.

XHR 拦截 (原型链装饰) :

```typescript
// 装饰 open: 记录请求元信息
const cleanupOpen = decorateProp(xhrProto, "open", (oldPropVal) => {
  return function (this, method, url, async, ...rest) {
    this.__sentry__ = {
      ...getBaseData(),
      name: "XMLHttpRequest",
      type: EventType.Xhr,
      method: method.toUpperCase(),
      api: url,
    };
    return oldPropVal.call(this, method, url, async, ...rest);
  };
});

// 装饰 send: 在 loadend 事件中收集响应数据
const cleanupSend = decorateProp(xhrProto, "send", (oldPropVal) => {
  return function (this, body) {
    this.addEventListener("loadend", () => {
      this.__sentry__.statusCode = this.status;
      this.__sentry__.serverTiming = parseServerTiming(
        this.getResponseHeader("server-timing"),
      );
      this.__sentry__.elapsedTime = Date.now() - this.__sentry__.timestamp;
      pub(EventType.Xhr, this.__sentry__);
    });
    return oldPropVal.call(this, body);
  };
});
```

Fetch 拦截 (全局函数包装) :

```typescript
const cleanup = decorateProp(globalThis, "fetch", (oldFetch) => {
  return function (input, options) {
    const api = getRequestUrl(input); // string | URL.href | Request.url
    const method = getRequestMethod(input, options); // options.method > Request.method > GET
    if (shouldIgnoreRequest(method, api)) {
      return oldFetch.call(globalThis, input, options); // 零开销直通
    }
    const httpData = {
      ...getBaseData(),
      type: EventType.Fetch,
      method,
      api,
      statusCode: 200,
    };
    const startedAt = httpData.timestamp;
    return oldFetch
      .call(globalThis, input, options)
      .then((res) => {
        httpData.elapsedTime = Date.now() - startedAt;
        httpData.statusCode = res.status;
        httpData.serverTiming = getServerTimingFromHeaders(res.headers);
        if (isErrorStatusCode(res.status)) {
          // 仅错误状态 (0 或 >= 400) 捕获请求/响应体
          httpData.requestData = { body: options?.body };
          res
            .clone()
            .text() // clone 后台读取, 不消费也不延迟业务方的 body
            .then((text) => {
              httpData.responseData = truncateBody(text);
            }) // 截断到 8KB
            .catch(() => undefined) // 流式响应 clone 读取失败也照常发布
            .finally(() => pub(EventType.Fetch, httpData));
        } else {
          pub(EventType.Fetch, httpData);
        }
        return res; // 返回原始 response 给业务代码
      })
      .catch((err) => {
        httpData.elapsedTime = Date.now() - startedAt;
        httpData.statusCode = 0;
        httpData.requestData = { body: options?.body };
        httpData.message = err instanceof Error ? err.message : "Network error";
        pub(EventType.Fetch, httpData);
        throw err; // 继续抛出, 不吞异常
      });
  };
});
```

两者的核心区别:

| 维度      | XHR                                  | Fetch                          |
| --------- | ------------------------------------ | ------------------------------ |
| 拦截位置  | `XMLHttpRequest.prototype.open/send` | `globalThis.fetch`             |
| 响应获取  | `loadend` 事件回调                   | Promise `.then()`              |
| Body 处理 | 直接读取 `this.response`             | 必须 `res.clone()` 后台读取    |
| 错误捕获  | loadend 中 status=0 或 >=400         | `.catch()` 中设置 statusCode=0 |
| 存储方式  | 挂在实例 `this.__sentry__`           | 闭包变量 `httpData`            |
| 过滤时机  | loadend 回调内检查后跳过发布         | 调用前检查, 直接透传原始 fetch |
| 计时起点  | send() 时刷新 timestamp (非 open)    | 发起请求时的 timestamp         |

共同设计要点:

1. 自身请求过滤: `shouldIgnoreRequest()` 过滤发往 DSN 的 POST 上报请求, 避免死循环
2. excludeApis 配置: 支持用户配置排除特定 API 路径 (字符串严格相等, 正则 test)
3. Server-Timing 解析: 从响应头提取服务端性能数据
4. 错误才带 body: `requestData` (`{ body }`) 与 `responseData` 仅在 statusCode 为 0 或 >= 400 时捕获, 字符串响应截断到 8KB, 单个错误不会撑爆上报载荷
5. 状态归一化: `transformHttpData()` 按状态码段生成 status (OK/Error) 与 message, 返回新对象不改入参; 默认只有 Status.Error 的请求会被上报, `enableHttpPerformance: true` 时成功请求额外转为 Performance 事件
6. 可逆装饰: `decorateProp` 返回 cleanup 函数, destroy 时还原原始方法

---

## 错误捕获体系包含哪些类型? 如何做到去重和批量聚合?

错误类型覆盖:

| 类型               | 来源                     | 实现方式                                                    |
| ------------------ | ------------------------ | ----------------------------------------------------------- |
| 运行时 JS 错误     | `window.onerror`         | capture 阶段监听 `error` 事件                               |
| 资源加载错误       | img/script/link 加载失败 | capture 阶段判断 `target.src/href`                          |
| Promise 未捕获异常 | `unhandledrejection`     | 全局事件监听, 解包 `reason` 再分类                          |
| console.error      | 开发者主动输出           | 装饰 `console.error` 提取 Error 对象                        |
| React 组件错误     | ErrorBoundary            | `componentDidCatch` 生命周期                                |
| Vue 组件错误       | errorHandler             | `app.config.errorHandler`                                   |
| 其他框架错误       | 业务方主动调用           | `reportFrameworkError({ type: EventType.OtherFrameworks })` |

去重机制 (reportOncePerError + BoundedSet) :

```typescript
// error-dedup.ts: 每个唯一错误键只上报一次
export function reportOncePerError(errorId: string, report: () => void): void {
  if (!sentry.options.repeatCodeError && sentry.codeErrors.has(errorId)) {
    return;
  }
  sentry.codeErrors.add(errorId);
  report();
}

// handle-code-error.ts: 键为原始字符串拼接, 不做哈希
reportOncePerError(
  `${EventType.Error}-${message}-${filename}-${line}-${column}`,
  () => {
    batchErrorManager.push(codeError);
  },
);
```

- 去重键为原始字符串拼接: window.onerror 路径为 `Error-message-filename-line-column` (handle-code-error.ts) , Error 实例/未知错误路径为 `Error-name-message` (handle-error.ts) , 资源错误路径为 `Resource-localName-src|href` (handle-error.ts)
- filename 缺失或为 "unknown" 的错误视为来源不明, 跳过去重直接进入批量聚合 (handle-code-error.ts)
- `BoundedSet` 容量上限 1000, 超出时淘汰最早插入的条目 (基于 Map 的插入顺序)
- 可通过 `repeatCodeError: true` 配置关闭去重
- 面包屑写入发生在去重检查之前: 被去重 (未上报) 的错误依然会留下面包屑, 供后续错误的上下文还原

批量聚合 (BatchErrorManager) :

```typescript
class BatchErrorManager {
  push(error) {
    this.cacheError.push(error);
    clearTimeout(this.timeoutID);
    this.timeoutID = setTimeout(() => this.flush(), 2000); // 2s 窗口
  }

  flush() {
    // 按 type-name-message 分组
    const groups = groupBy(
      this.cacheError,
      (err) => `${err.type}-${err.name}-${err.message}`,
    );
    for (const items of Object.values(groups)) {
      if (items.length >= 5) {
        // 5 次以上聚合为单条 BatchError
        reporter.send({
          ...items[0],
          batchError: true,
          batchErrorLength: items.length,
        });
      } else {
        items.forEach((item) => reporter.send(item));
      }
    }
  }
}
```

设计意图:

- 防止循环错误 (如 `setInterval` 中抛错) 导致上报风暴
- 2 秒时间窗口 + 5 次阈值的组合, 既保证单次错误及时上报, 又避免高频重复错误打满带宽
- `batchErrorLastHappenTime` 记录最后一次发生时间, 便于后端判断错误持续性

---

## 数据上报管道的完整流程是怎样的?

DataReporter 的上报管道分为 send (入队) 和 flush (发送) 两个阶段:

Send 阶段 (入队) :

```
payload 进入
    │
    V
shouldQueuePayload() ─── DSN 非空 + 采样率检查 + 设置录屏标记
    │ (通过)
    V
runBeforeReportHook() ─── 转换为 IReportData (附加 url/userId/anonymousId/visitorId/
    │                      projectId/sdkVersion/deviceInfo, 错误类事件附加 breadcrumbs)
    │                      执行 beforeSend 钩子 (可修改/返回 false 拒绝)
    V
events.push(data) ─── 入队
    │
    ├── 离线? ──> 裁剪到 maxQueueLength + 写入 localStorage
    │
    ├── immediate 或 队列 >= cacheMaxLength? ──> 立即 flush()
    │
    └── 否则 ──> 延迟 cacheWaitingTime(2s) 后 flush()
```

Flush 阶段 (发送) :

```
flush() 调用
    │
    ├── events 为空 或 isFlushing? ──> 返回 (防并发)
    │
    V
isFlushing = true
    │
    ├── 离线? ──> 裁剪 + 持久化 + 返回
    │
    V
takeBatch() ─── 取前 cacheMaxLength 条 + 执行 beforeSendBatch 钩子
    │
    V
sendBatch() ─── 选择传输通道 (见下一节)
    │
    ├── 失败 (fetch 拒绝或非 2xx) ──> 数据回插 events 头部 + 持久化 + 触发 serverRecovery
    │
    ├── 成功 ──> 清除 localStorage 持久化镜像 + 执行 afterSend 钩子
    │
    V
isFlushing = false
    │
    V
scheduleNextFlush() ─── 队列仍有数据则 100ms 后继续 flush
```

关键设计点:

1. 防并发锁: `isFlushing` 标志位防止多个 flush 同时执行
2. 批量分片: 每次最多取 `cacheMaxLength` (默认 10) 条, 避免单次请求过大
3. 失败回插: 发送失败的数据回插到队列头部, 不丢失; 发送成功后清除 localStorage 镜像 (`hasPersistedCache` 标记) , 避免下个会话重放已送达的数据
4. 连续 flush: 一批发完后如果还有数据, 100ms 后继续, 形成流水线
5. 钩子系统: `beforeSend` (单条修改/拒绝) 、`beforeSendBatch` (批量修改/整批丢弃) 、`afterSend` (发送成功后回调) , 三者都可在 init options 或同名导出函数中注册, 后写覆盖先写
6. 同步快路径: 无异步钩子时整条管道从 send() 到传输层保持同步 (`isPromise` 守卫代替无条件 await) , 保证 pagehide 时 sendBeacon 能在页面销毁前拿到批次
7. 跨会话恢复: DataReporter 构造时安装 online/offline 监听 (初始状态取 `navigator.onLine`) , 并把上个会话持久化但未发出的离线缓存重新装回队列

---

## 上报传输层如何选择通道? 为什么需要双通道策略?

传输选择逻辑在 `sendBatch()` 方法中 (`reporter/index.ts` + `reporter/transports.ts`) :

```typescript
// transports.ts
export const MAX_KEEPALIVE_BYTES = 60 * 1024; // 60KB

export function getBodyByteLength(body: string): number {
  return new TextEncoder().encode(body).byteLength; // 字节数而非字符数
}

// reporter/index.ts
private sendBatch(finalSendData: readonly IReportData[]): Promise<boolean> | boolean {
  const body = JSON.stringify(finalSendData); // 只序列化一次, beacon/fetch 复用
  const withinKeepaliveBudget = getBodyByteLength(body) <= MAX_KEEPALIVE_BYTES;

  // 优先级 1: sendBeacon (<= 60KB 且入队成功)
  if (withinKeepaliveBudget && sendBeacon(body)) return true;

  // 优先级 2: fetch POST (兜底, keepalive 视体积而定)
  return reportByFetch(body, withinKeepaliveBudget, () => this.handleServerError());
}
```

两种通道对比:

| 通道                   | 大小限制       | 优势                                            | 劣势                                      | 适用场景              |
| ---------------------- | -------------- | ----------------------------------------------- | ----------------------------------------- | --------------------- |
| `navigator.sendBeacon` | ~64KB 在途预算 | 页面卸载时仍可靠发送、不阻塞页面、浏览器调度    | 仅 POST、无法自定义 header、无法获取响应  | 常规批量上报          |
| `fetch POST`           | 无硬限制       | 可自定义 header、可获取响应状态、支持 keepalive | 页面卸载时可能中断 (大载荷关闭 keepalive) | 大数据量/需要确认送达 |

为什么需要双通道:

1. 页面关闭场景: pagehide 时 fetch 可能被取消, sendBeacon 由浏览器保证发出; 配合上报管道的同步快路径, 停留时长能在页面销毁前入队发送
2. 降级容错: sendBeacon 返回 false (浏览器队列满) 或载荷超 60KB 时自动落到 fetch
3. 结果可观测: 只有 fetch 能拿到响应状态, 非 2xx 响应会触发失败回插与服务端恢复探测; beacon 的返回值只代表入队成功

fetch 通道的特殊处理:

- 条件性 `keepalive`: 载荷 <= 60KB 时设置 `keepalive: true` (页面卸载时仍尝试完成请求) ; 超过 60KB 则关闭——Chromium 对 keepalive fetch 有约 64KB 的在途预算, 大载荷 (如屏幕录制) 若强制 keepalive 会被浏览器拒绝, 导致请求永远失败并阻塞队列头部 (`transports.ts`)
- 失败 (拒绝或 `!res.ok`) 时触发 `handleServerError()`, 启动定时 HEAD 探测恢复机制

---

## 离线缓存和断网恢复机制是如何实现的?

离线容错由三个模块协作完成:

1. 网络状态监听 (network-listener.ts) :

```typescript
callbacks.setOnline(navigator.onLine !== false); // 构造时取初始状态
globalThis.addEventListener("offline", () => setOnline(false));
globalThis.addEventListener("online", () => {
  setOnline(true);
  flush(); // 立即尝试发送 (离线事件从未离开内存队列, 无需重新加载)
});
```

2. 离线缓存持久化 (offline-cache.ts) :

- 存储介质: `localStorage`, key 为 `yukino_sentry_offline_cache` (可配置 offlineCacheKey)
- 写入时机: send 阶段发现离线时 (裁剪后写入) 、flush 阶段发现离线或发送失败回插后 (各写入一次) ; localStorage 只是内存队列的镜像, 事件本体始终留在队列中
- 清除时机: 下一次发送成功后清除镜像 (`hasPersistedCache` 标记) , 防止后续会话重放已送达数据
- 读取时机: DataReporter 构造时 (恢复上个会话未发出的数据) 和 `flushOfflineCache()` 手动调用时
- 读取校验: 从 localStorage 加载时用 Zod schema (reportDataListSchema) 校验; 校验通过才删除缓存键, schema 不合法的缓存原样保留便于排查, 只有 JSON.parse 抛错才直接删除
- 容量控制: `events.slice(-maxQueueLength)` 限制最大 200 条, 防止撑爆 localStorage

3. 服务端故障恢复 (server-recovery.ts) :

```typescript
export function scheduleServerRecovery(
  retryTimer: ReturnType<typeof setTimeout> | undefined,
  callbacks: ServerRecoveryCallbacks,
): ReturnType<typeof setTimeout> {
  callbacks.setOnline(false);
  if (retryTimer) clearTimeout(retryTimer);
  // setTimeout 单次调度, 失败后递归重新安排下一轮; 定时器 unref, 不阻止 Node 进程退出
  const nextRetryTimer = setTimeout(() => {
    testServerAvailable(callbacks);
  }, sentry.options.retryIntervalMilliseconds); // 默认 60s
  unrefTimer(nextRetryTimer);
  callbacks.setRetryTimer(nextRetryTimer);
  return nextRetryTimer;
}

function testServerAvailable(callbacks: ServerRecoveryCallbacks): void {
  fetch(sentry.options.dsn, { method: "HEAD" })
    .then((res) => {
      if (!res.ok) {
        scheduleServerRecovery(undefined, callbacks); // 不可用: 递归安排重试
        return;
      }
      callbacks.setOnline(true);
      void callbacks.flush(); // 恢复后直接冲刷内存队列
    })
    .catch(() => {
      scheduleServerRecovery(undefined, callbacks); // 异常: 递归安排重试
    });
}
```

完整离线场景流程:

```
网络断开
  │
  V
offline 事件 ──> isOnline = false
  │
  V
后续 send() ──> 数据入队 + 裁剪到 maxQueueLength + 写入 localStorage 镜像
  │
  V
网络恢复
  │
  ├── online 事件 ──> isOnline = true ──> flush() 内存队列
  │                                        │ (成功)
  │                                        V
  │                                   清除 localStorage 镜像
  │
  └── 或 上报失败 (fetch 拒绝/非 2xx) ──> scheduleServerRecovery() ──> 60s HEAD 探测
                                                       │
                                                       V (200 OK)
                                                   flush() 内存队列
```

设计亮点:

- 区分「客户端离线」和「服务端不可达」两种故障, 分别用 online 事件和 HEAD 探测处理
- 数据回插机制: flush 失败时 `events = [...finalSendData, ...events].slice(-maxQueueLength)`, 失败批次回插队头; 但总量超过 200 条时最旧数据仍会被淘汰
- 页面中途刷新也不丢数据: 失败/离线期间 localStorage 始终镜像内存队列, 新会话的 DataReporter 构造时把镜像装回队列继续发送
- localStorage 有 5MB 限制, 通过 `maxQueueLength=200` 和单条数据大小控制总量

---

## 白屏检测算法的原理是什么? 如何处理骨架屏场景?

白屏检测实现在 `core/white-screen.ts`, 核心思想是视口采样点检测.

算法原理:

```typescript
const SAMPLE_X_RATIOS = [0.1, 0.5, 0.9] as const;
const SAMPLE_Y_RATIOS = [0.1, 0.26, 0.42, 0.58, 0.74, 0.9] as const;
const SAMPLE_POINT_COUNT = SAMPLE_X_RATIOS.length * SAMPLE_Y_RATIOS.length;

let sampleCount = 0;

const countEmptyPoints = (): number => {
  const { innerWidth, innerHeight } = globalThis;
  let emptyPoints = 0;
  // 3 x 6 网格共 18 个采样点, 外层按行 (y )内层按列 (x )遍历
  for (const yRatio of SAMPLE_Y_RATIOS) {
    for (const xRatio of SAMPLE_X_RATIOS) {
      const elem = document.elementFromPoint(
        innerWidth * xRatio,
        innerHeight * yRatio,
      );
      if (!elem || isRoot(elem)) emptyPoints++;
    }
  }
  return emptyPoints;
};

const sample = () => {
  sampleCount++;
  const isWhiteScreen = countEmptyPoints() === SAMPLE_POINT_COUNT; // 18/18 个点都是空/根元素

  if (!isWhiteScreen) {
    stopWhiteScreenCheck(); // 出现真实内容, 立即停止采样, 不上报
    return;
  }
  // 连续 10 次全白才上报 (单次全白可能只是渲染慢)
  if (sampleCount >= MAX_WHITE_SCREEN_SAMPLE_COUNT) {
    report(); // 上报后同样停止采样
  }
};
```

采样策略:

- 采样点为确定性的 3 x 6 网格布局: x 轴取 `SAMPLE_X_RATIOS = [0.1, 0.5, 0.9]` 三个位置, y 轴取 `SAMPLE_Y_RATIOS = [0.1, 0.26, 0.42, 0.58, 0.74, 0.9]` 六个位置, 共计 `SAMPLE_POINT_COUNT = 18` 个采样点, 坐标按 ` (innerWidth * xRatio, innerHeight * yRatio )` 计算
- 网格均匀覆盖整个视口, 四角与边缘区域均在采样范围内; 任一采样点返回非根元素即认为页面已渲染真实内容, 立即终止采样且不上报, 降低页面内容偏离视口中心区域时的误报率
- 采样周期为 1 秒 (`WHITE_SCREEN_SAMPLE_INTERVAL = 1000`)
- 白屏判定条件: 连续 `MAX_WHITE_SCREEN_SAMPLE_COUNT = 10` 次采样中 18 个采样点均为空或根元素, 才判定为白屏并触发上报

根元素判定:

```typescript
const isRoot = (elem: Element) => {
  const [idSelector, classSelector, elementSelector] = getCssSelectors(elem);
  return (
    rootCssSelectors.includes(idSelector) || // 如 "#app", "#root"
    rootCssSelectors.includes(classSelector) ||
    rootCssSelectors.includes(elementSelector) // 如 "html", "body"
  );
};
```

默认 `rootCssSelectors: ["html", "body", "#app", "#root"]`, 可配置.

骨架屏场景处理:

```typescript
if (hasSkeleton) {
  // 第 1 次采样: 只记录骨架屏的 CSS 选择器集合作为基线, 不上报
  if (sampleCount === 1) return;
  // 后续采样: 选择器集合与基线不同 → 骨架屏已切换为真实内容 → 停止采样
  if (!selectorsMatchBaseline()) {
    stopWhiteScreenCheck();
    return;
  }
  // 集合始终与基线相同, 撑到第 10 次采样 → 骨架屏卡住 → 上报白屏
  if (sampleCount >= MAX_WHITE_SCREEN_SAMPLE_COUNT) report();
}
```

触发链路: 白屏检测不走事件总线. `setup()` 在 `enableWhiteScreen: true` 时直接调用 `startWhiteScreenCheck(onReport)` 启动采样, 命中白屏时通过回调把 `EventType.WhiteScreen` 事件 (`name: "WhiteScreen"`, `message: "sample count <n>"`, `extra: { sampleCount }`) 交给 reporter 发送; `destroy()` 调用 `stopWhiteScreenCheck()` 清除定时器和未触发的 load 监听.

性能优化:

- 使用 `requestIdleCallback` 在浏览器空闲时执行采样 (超时 1000ms) , 且回调内再检查 `deadline.timeRemaining() > 0 || deadline.didTimeout` 才真正采样, 避免阻塞主线程
- 页面 `readyState === "complete"` (或 load 事件) 后才开始采样
- 一旦检测到真实内容或完成上报, 立即停止定时器

---

## 首屏渲染时间 (FSP) 是如何计算的? 与 LCP 有什么区别?

FSP (First Screen Paint) 实现在 `plugins/performance/first-screen-paint.ts`, 是一个自定义指标.

实现原理:

```typescript
export function getFirstScreenPaint(
  callback: (value: number) => void,
): Cleanup {
  // 能力降级: 无 MutationObserver 时立即回调 0
  if (typeof globalThis.MutationObserver !== "function") {
    callback(0);
    return noop;
  }

  const excludedElementNames = new Set(["link", "script", "style"]);
  let latestRenderTime = 0; // 只维护一个「最晚的视口内渲染时间」

  const observer = new MutationObserver((mutationList) => {
    // 过滤条件:
    // 1. mutation.target 是 HTMLElement 且有新增节点 (addedNodes.length > 0)
    // 2. 父节点在视口内
    // 3. 新增节点是 HTMLElement、不是 link/script/style、且在视口内
    if (hasInViewportAddition(mutationList)) {
      latestRenderTime = performance.now();
    }
  });
  observer.observe(document, { childList: true, subtree: true });

  // rAF 轮询: 文档 complete 时断开 observer 并回调最晚渲染时间
  const waitForPageReady = () => {
    if (document.readyState === "complete") {
      observer.disconnect();
      callback(latestRenderTime);
      return;
    }
    requestId = requestAnimationFrame(waitForPageReady);
  };
  waitForPageReady();

  // 返回 cleanup: 插件 destroy 时取消未完成的观测 (不再回调)
  return () => {
    observer.disconnect();
    cancelAnimationFrame(requestId);
  };
}
```

视口判定 (isInViewport) : `getBoundingClientRect()` 与视口相交 (`right > 0 && bottom > 0 && left < innerWidth && top < innerHeight`) .

FSP vs LCP 对比:

| 维度     | FSP (自定义)                             | LCP (Web Vitals 标准)                             |
| -------- | ---------------------------------------- | ------------------------------------------------- |
| 定义     | 首屏所有可视 DOM 元素完成渲染的时间      | 视口内最大内容元素完成渲染的时间                  |
| 关注点   | 首屏整体完成度                           | 单个最大元素                                      |
| 实现方式 | MutationObserver 追踪所有视口内 DOM 变化 | PerformanceObserver 监听 largest-contentful-paint |
| 排除元素 | link/script/style                        | 由浏览器自动判定                                  |
| 终止条件 | `document.readyState === "complete"`     | 用户交互或页面完全加载                            |
| 适用场景 | SPA 首屏、SSR 页面                       | 通用页面                                          |

设计意图:

LCP 只关注单个最大元素, 对于 SPA 首屏由多个小组件组成的场景不够准确. FSP 追踪所有视口内 DOM 变化, 取最后一个可视元素的渲染时间, 更能反映用户感知的「首屏完成」.

---

## 性能监控插件采集了哪些指标? Web Vitals 是如何集成的?

PerformancePlugin 是 SDK 最重的插件, 采集以下指标类别:

1. Core Web Vitals (via web-vitals 库) :

| 指标 | 含义             | 采集方式   |
| ---- | ---------------- | ---------- |
| LCP  | 最大内容绘制     | `onLCP()`  |
| FCP  | 首次内容绘制     | `onFCP()`  |
| CLS  | 累积布局偏移     | `onCLS()`  |
| INP  | 交互到下一次绘制 | `onINP()`  |
| TTFB | 首字节时间       | `onTTFB()` |

指标载荷携带 `value` 与 `rating`, 且 web-vitals 自带的 metric id 会覆盖 payload 的事件 id, 便于后端归并同一指标的多次上报.

2. Navigation Timing (Performance API) :

从 `performance.getEntriesByType("navigation")` 提取, 所有值经 `Math.round` 取整并 `Math.max(0, ...)` 钳位非负, 多数以 fetchStart 为基准:

- DNS 查询耗时 (domainLookupEnd - domainLookupStart)
- TCP 连接耗时 (connectEnd - connectStart)
- TLS 握手耗时
- 首字节时间 (responseStart - requestStart)
- 内容传输耗时 (responseEnd - responseStart)
- DOM 解析耗时 (domInteractive - responseEnd)
- 资源加载耗时 (loadEventStart - domContentLoadedEventEnd)
- 重定向耗时、Unload 耗时、paintTime (最后一条 paint entry 相对 fetchStart)

3. Resource Timing (PerformanceObserver) :

- 监听 `resource` 类型的 PerformanceEntry, 每条实时 entry 上报一个 `ResourceTiming` 事件; 页面 ready 时另发一条 `ResourceList` 快照 (缓冲区内全部资源)
- 排除 fetch/xmlhttprequest/beacon 类型 (这些由 HTTP 监控覆盖) 和包含 DSN 的 URL
- 记录每个静态资源的加载耗时、大小、initiatorType; `fromCache` 由 `transferSize === 0 || encodedBodySize === 0` 推导

4. Resource Element Fallback (MutationObserver) :

- 针对不支持 PerformanceObserver resource 类型的浏览器
- 通过 MutationObserver 监听新增的 img/script/link 元素
- 在元素 load/error 事件中上报 (每个 URL 只报一次) , 能查到真实 PerformanceResourceTiming 就复用, 否则用零耗时兜底对象

5. Long Tasks:

- PerformanceObserver 监听 `longtask` 类型
- 记录超过 50ms 的长任务, 用于定位主线程阻塞

6. Memory:

- 插件 init 时调用一次 `performance.measureUserAgentSpecificMemory()` (Chrome-only, 页面需 crossOriginIsolated)
- 记录 JS 堆内存使用情况

7. FSP (自定义首屏时间) :

- 如上一节所述的 MutationObserver 方案

8. HTTP 性能 (可选, 非 PerformancePlugin 采集) :

- `enableHttpPerformance: true` 时, `core/handle-http.ts` 把成功的 XHR/Fetch 请求额外上报为 Performance 事件
- name 为 `HTTP <method>`, value 为 elapsedTime, extra 携带 method/statusCode/serverTiming
- 默认关闭 (`enableHttpPerformance: false`), 避免全量请求都产生一条性能数据

所有指标统一为 `EventType.Performance` 事件, 由 `name` 区分 (LCP/FCP/CLS/INP/TTFB/FSP/NavigationTiming/ResourceList/ResourceTiming/LongTask/Memory) ; 能力检测统一走 `supportsPerformanceEntryType()` (读取 `PerformanceObserver.supportedEntryTypes`) , 不支持的能力安全跳过; `destroy()` 逆序执行全部 cleanup.

---

## 面包屑 (Breadcrumb) 是如何实现的? 哪些事件会携带面包屑?

面包屑使用容量受限的 FIFO 缓冲 (BoundedList) 实现, 位于 `utils/data-structures.ts`; `core/breadcrumb.ts` 在其上派生 Breadcrumb 子类接入 beforeBreadcrumb 钩子.

核心实现:

```typescript
// utils/data-structures.ts: 始终保留最新的 capacity 条
export class BoundedList<T> {
  public capacity: number; // init 时被赋值为 maxBreadcrumbs (默认 30)
  private items: T[] = [];

  push(item: T): void {
    this.items.push(item);
    if (this.items.length > this.capacity) {
      this.items.splice(0, this.items.length - this.capacity); // 淘汰最旧
    }
  }

  dump(): T[] {
    return [...this.items]; // 返回拷贝, 外部无法篡改缓冲
  }

  clear(): void {
    this.items = [];
  }
}

// core/breadcrumb.ts: 写入前经过 beforeBreadcrumb 钩子
class Breadcrumb extends BoundedList<IBreadcrumbItem> {
  override push(data: IBreadcrumbItem): void {
    const { beforeBreadcrumb } = sentry.options;
    super.push(beforeBreadcrumb ? beforeBreadcrumb(data) : data);
  }
}
```

设计要点:

1. 事件按发生顺序推入, 数组本身即时间有序, dump 无需排序
2. 容量默认 30 (`maxBreadcrumbs` 可配) , 超出时 splice 掉最旧条目, 语义是「始终保留最新的 N 条」
3. `beforeBreadcrumb` 钩子在入队前同步执行, 业务可脱敏或改写单条面包屑
4. `destroy()` 时调用 `breadcrumb.clear()`, 会话状态不跨 init 泄漏

userAction 分类 (utils/event2breadcrumb.ts) :

| EventType                                | BreadcrumbType |
| ---------------------------------------- | -------------- |
| Xhr / Fetch                              | Http           |
| Click                                    | Click          |
| HashChange / History                     | Route          |
| Resource                                 | Resource       |
| Error / Vue / React / UnhandledRejection | Code Error     |
| 其余 (Performance/Custom 等)             | Custom         |

dump() 的调用时机:

`dump()` 在上报数据组装时被调用: `reporter/report-data.ts` 中 `data.breadcrumbs = breadcrumb.dump()`. 注意并非每条数据都携带面包屑: 只有错误类事件 (Error/UnhandledRejection/Resource/Vue/React/OtherFrameworks, 即 report-data.ts 顶部的 BREADCRUMB_EVENT_TYPES 集合) 会附加, 帮助后端还原故障前的用户操作路径, 也避免面包屑在批量事件上成倍放大载荷体积.

---

## 屏幕录制插件的滚动窗口机制是如何实现的?

屏幕录制基于 `@rrweb/record`, 实现在 `plugins/screen-record/`.

滚动窗口机制:

```typescript
// recorder.ts 核心逻辑 (闭包实现, 非 class)
export async function recorder(reporter: IDataReporter): Promise<Cleanup> {
  const [{ record }, pako] = await Promise.all([
    import("@rrweb/record"),
    import("pako"),
  ]);
  const recordWindow: RecordEvent[] = [];

  // 原地裁剪: 把窗口头部早于 minTimestamp 的事件 shift 掉
  const pruneWindow = (currentTimestamp: number) => {
    const minTimestamp =
      currentTimestamp - sentry.options.screenRecordDurationMs;
    while (
      recordWindow.length > 0 &&
      recordWindow[0].timestamp < minTimestamp
    ) {
      recordWindow.shift();
    }
  };

  const stopRecord = record({
    emit(e) {
      const result = recordEventSchema.safeParse(e); // looseObject({ timestamp: number })
      if (!result.success) return;
      recordWindow.push(result.data);
      pruneWindow(result.data.timestamp);
      if (sentry.shouldScreenRecord && recordWindow.length > 0) {
        reporter.send({
          ...getBaseData(),
          name: "ScreenRecord",
          type: EventType.ScreenRecord,
          event: zip(recordWindow), // JSON -> gzip -> base64 (32KB 分块编码)
          eventCount: recordWindow.length,
        });
        sentry.shouldScreenRecord = false;
      }
    },
    recordCanvas: true,
    checkoutEveryNms: sentry.options.screenRecordDurationMs,
  });
  return typeof stopRecord === "function" ? stopRecord : noop;
}
```

设计要点: `recorder` 是闭包而非 class——`recordWindow` 作为闭包变量维护滚动窗口, `pruneWindow` 原地 shift 淘汰过期事件 (不复制数组) . rrweb 的 `record()` 返回停止函数, 直接作为 cleanup 返回给插件的 destroy 链路. 动态 `import("@rrweb/record")` 和 `import("pako")` 并行加载, 避免录制库阻塞主 bundle; 加载失败时记录日志并降级为 noop. 插件构造函数接受 `{ durationMs, eventTypes }`, init 时把二者写入 SDK options (数组拷贝, 实例间不共享引用) .

触发机制:

- 不是持续上报, 而是事件驱动触发
- 当上报的事件类型匹配 `screenRecordEventTypes` (默认: Error、XHR、Fetch、Resource、UnhandledRejection) 时, `send-preflight.ts` 设置 `sentry.shouldScreenRecord = true`
- recorder 的 emit 回调检测到该标记后, 把当前滚动窗口内的 rrweb 事件作为一个独立的 ScreenRecord 事件发送 (并非附加到触发事件上) , 并把标记复位为 false

压缩流程:

```
rrweb events (JSON) → pako.gzip() → Uint8Array → base64 编码 → 字符串
```

解码使用导出的 `unzipScreenRecord()` 函数:

```
base64 字符串 → Uint8Array → pako.ungzip() → JSON.parse() → rrweb events
```

设计考量:

1. 隐私保护: 只保留最近 3 秒, 不记录用户完整操作历史
2. 体积控制: gzip 压缩后通常只有原始 JSON 的 10-20%
3. 性能影响: rrweb 本身使用 MutationObserver, 开销可控; `recordCanvas: true` 会额外记录 canvas 内容
4. 按需触发: 不是所有事件都附带录屏, 只在错误/异常时触发, 减少带宽

---

## 插件体系是如何设计的? 如何做到可插拔?

抽象基类定义 (types/plugin.ts) :

```typescript
export abstract class SentryPlugin {
  abstract init(): void;
  destroy?(): void;
}
```

注册与管理 (core/plugin-registry.ts) :

```typescript
const plugins = new Set<SentryPlugin>();

function registerPlugin(plugin: SentryPlugin): void {
  plugins.add(plugin);
}

function destroyPlugins(): void {
  plugins.forEach((p) => p.destroy?.());
  plugins.clear();
}
```

启用入口 (core/sdk-lifecycle.ts) :

```typescript
export function enablePlugin(...plugins: SentryPlugin[]): void {
  for (const plugin of plugins) {
    plugin.init();
    registerPlugin(plugin);
  }
}
```

使用方式:

```typescript
import { init, enablePlugin } from "@yukino.js/sentry";
import {
  PerformancePlugin,
  ScreenRecordPlugin,
} from "@yukino.js/sentry/plugins";

init({ dsn: "https://..." });
enablePlugin(new PerformancePlugin(), new ScreenRecordPlugin());
```

可插拔设计要点:

1. 独立入口: 插件从 `@yukino.js/sentry/plugins` 单独导入, 不引入则不打包 (tree-shaking 友好)
2. 生命周期约束: `init()` 必须实现, `destroy()` 可选但推荐
3. 无侵入核心: 插件通过事件总线订阅事件, 不修改核心代码
4. 独立销毁: `destroy()` 时遍历所有插件调用其 destroy, 清理 Observer/Timer
5. Set 存储: 天然去重, 同一插件实例不会注册两次

三个内置插件的职责:

| 插件               | 功能                                                      | 核心技术                              |
| ------------------ | --------------------------------------------------------- | ------------------------------------- |
| PerformancePlugin  | Web Vitals + Navigation/Resource Timing + Long Task + FSP | PerformanceObserver, MutationObserver |
| ScreenRecordPlugin | 错误前 3 秒操作回放                                       | rrweb, pako gzip                      |
| ExposurePlugin     | 元素曝光时长追踪                                          | IntersectionObserver                  |

---

## 框架集成 (React/Vue) 是如何实现的?

框架集成通过独立入口文件实现, 不侵入核心代码.

React 集成 (react.ts) :

```typescript
export class ReactErrorBoundary extends Component<Props, State> {
  static displayName = "ReactErrorBoundary"; // 保持 React 16 组件栈可读

  // render 阶段先把 error 写入 state, fallback 立即可见
  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    this.setState({ error, errorInfo });
    // 使用独立的 EventType.React, 原样携带 error 对象与 React 上下文
    reportFrameworkError({
      type: EventType.React,
      error,
      context: errorInfo, // ErrorInfo, 包含 componentStack
    });
  }

  override render() {
    const { error, errorInfo } = this.state;
    if (error) {
      const { fallback } = this.props;
      // fallback 支持 ReactNode 或 (error, errorInfo?) => ReactNode 渲染函数;
      // 渲染函数可能先以 errorInfo undefined 调用一次 (getDerivedStateFromError
      // 阶段 React 尚未交付 ErrorInfo) , componentDidCatch 后再带 errorInfo 渲染
      if (typeof fallback === "function") return fallback(error, errorInfo);
      return fallback ?? null;
    }
    return this.props.children ?? null;
  }
}
```

注意: ErrorBoundary 捕获不到异步回调、事件处理器和 SSR 中的错误, 这些场景用 `traceError` 手动上报.

Vue 集成 (vue.ts) :

```typescript
export const vuePlugin: Plugin = (app, options: InitOptions) => {
  const handler = app.config.errorHandler; // 保存用户原有的 errorHandler
  app.config.errorHandler = (err, vueInstance, info) => {
    reportFrameworkError({
      type: EventType.Vue,
      error: err,
      context: { vueInstance, info }, // info 如 "mounted hook"
    });
    handler?.call(null, err, vueInstance, info); // 链式调用原 errorHandler
  };
  init(options); // 插件安装时顺带初始化 SDK
};

// 使用: app.use(vuePlugin, { dsn: "..." })
```

---

## 采样率和数据过滤机制是如何工作的?

采样和过滤分布在多个层级:

1. 全局采样率 (send-preflight.ts) :

```typescript
function shouldQueuePayload(payload: TReportPayload): boolean {
  const { dsn, tracesSampleRate } = sentry.options;
  if (!dsn) return false;

  // 随机采样: tracesSampleRate=0.5 表示 50% 的事件被丢弃
  if (Math.random() > tracesSampleRate) return false;

  // 设置录屏标记
  if (sentry.options.screenRecordEventTypes.includes(payload.type)) {
    sentry.shouldScreenRecord = true;
  }
  return true;
}
```

2. API 排除 (is-excluded-api.ts) :

```typescript
// 配置: excludeApis: ["/api/health", /^https:\/\/analytics/]
function isExcludedApi(api: string): boolean {
  for (const excludedApi of sentry.options.excludeApis) {
    if (typeof excludedApi === "string") {
      if (api === excludedApi) return true; // 字符串: 严格相等匹配
    } else {
      if (excludedApi.test(api)) return true; // 正则: test 匹配
    }
  }
  return false;
}
```

3. 错误忽略 (is-ignored-error.ts) :

```typescript
// 配置: ignoreErrors: ["ResizeObserver loop", /Script error/]
function isIgnoredError(message: string): boolean {
  return sentry.options.ignoreErrors.some((pattern) =>
    typeof pattern === "string"
      ? message.includes(pattern)
      : pattern.test(message),
  );
}
```

4. beforeSend 钩子 (用户自定义过滤) :

```typescript
init({
  beforeSend: (data) => {
    if (data.url.includes("/admin")) return false; // 返回 false 拒绝上报
    return data; // 可修改后返回, 也可返回 Promise
  },
});
```

5. 错误去重 (BoundedSet) :

相同错误在 BoundedSet 容量内只上报一次 (除非 `repeatCodeError: true`) .

过滤层级总结:

```
事件产生 → excludeApis/ignoreErrors (采集层过滤)
         → BoundedSet 去重 (去重层过滤)
         → tracesSampleRate (采样层过滤)
         → beforeSend (用户钩子过滤)
         → beforeSendBatch (批量钩子过滤)
         → 最终上报
```

---

## Reporter 单例为什么使用 Proxy 实现懒加载?

Reporter 的导出使用了一个巧妙的 Proxy 模式 (`reporter/index.ts`) :

```typescript
let instance: DataReporter | null = null;

export function resetReporter(): void {
  instance?.dispose(); // 清定时器、摘 online/offline 监听、丢弃队列
  instance = null;
}

export default new Proxy({} as DataReporter, {
  get(_target, prop) {
    instance ??= new DataReporter(); // 首次属性访问时才实例化
    const value = Reflect.get(instance, prop, instance);
    return typeof value === "function" ? value.bind(instance) : value;
  },
});
```

为什么需要这种设计:

1. 避免模块加载时副作用: DataReporter 的构造函数会注册 online/offline 监听并从 localStorage 恢复上个会话的离线缓存. 如果直接 `export default new DataReporter()`, import 该模块时这些副作用就会发生——早于 init() 应用配置. Proxy 把实例化推迟到第一次真正使用 reporter 时 (此时 options 已就绪) .

2. 支持 reset: `destroy()` 调用 `resetReporter()` 把模块级 `instance` 置空并 dispose 旧实例; 下次访问时 Proxy 自动创建新实例. 直接导出实例无法实现这种重置.

3. 解决循环依赖: 多个模块 (handlers、api、plugins) 都需要 reporter, Proxy 作为中间层避免了模块间的循环引用问题.

4. this 绑定保证: `value.bind(instance)` 确保方法调用时 this 指向正确, 使用方可以安全地解构: `const { send } = reporter`.

DataReporter 实例的关键字段: 事件队列 `events`、批量定时器 `timeoutID`、恢复探测定时器 `retryTimer`、在线标志 `isOnline`、防并发标志 `isFlushing`、持久化标记 `hasPersistedCache`, 以及构造时生成的实例级 `id` (出现在每条上报数据的外层 id 字段) .

---

## 声明式点击埋点的实现原理是什么?

点击埋点采用声明式方案, 通过 DOM 属性标记需要追踪的元素.

属性约定:

| 属性                 | 含义         | 示例                                |
| -------------------- | ------------ | ----------------------------------- |
| `yukino-sentry-ev`   | 事件 ID      | `yukino-sentry-ev="btn_submit"`     |
| `yukino-sentry-msg`  | 事件描述     | `yukino-sentry-msg="提交订单"`      |
| `yukino-sentry-view` | 元素追踪标记 | `yukino-sentry-view="checkout_btn"` |
| `yukino-sentry-*`    | 自定义参数   | `yukino-sentry-price="99.9"`        |

实现逻辑 (utils/click-data.ts) :

```typescript
export function getDeclarativeClickData(
  event: MouseEvent,
): DeclarativeClickData | null {
  // 1. event.composedPath() 穿透 Shadow DOM, 过滤出 HTMLElement 路径
  const path = getComposedElementPath(event);
  const fallbackPath = path.length > 0 ? path : getElementPath(event.target);

  // 2. 寻找路径中第一个带 yukino-sentry-view/ev/msg 属性的元素
  const trackingTarget = fallbackPath.find(hasTrackingAttribute);
  if (!trackingTarget) return null;

  // 3. 组装点击数据
  return {
    ev: getEventId(fallbackPath), // 优先级: yukino-sentry-ev > title > yukino-sentry-view > 标签名
    msg: getMessage(trackingTarget), // yukino-sentry-msg > title > textContent > aria-label > 标签名
    triggerPageUrl: location.href,
    x,
    y, // 实际被点元素 (event.target, 非 HTMLElement 时退回埋点元素) 的绝对坐标: getBoundingClientRect + 滚动偏移
    params: getParams(fallbackPath), // 收集 yukino-sentry-* 自定义参数 (view/msg/ev 保留键除外)
    elementPath: dom2str(trackingTarget), // utils/dom2str.ts: 埋点元素的 CSS 选择器式祖先路径
    triggerTime: Date.now(),
  };
}
```

其中 `dom2str()` (utils/dom2str.ts, 思路对齐 Sentry 的 htmlTreeAsString) : 从被点击元素向上最多遍历 5 层 (MAX_TRAVERSE_HEIGHT = 5) , 每层生成 `tag#id.class` 形式的选择器并用 `>` 连接 (如 `body > div#app > button.btn.primary`) ; 累计长度达到 128 字符 (MAX_OUTPUT_LENGTH) 后丢弃整层选择器而非截断半个, 被点击元素本身始终保留.

事件监听安装 (decorates.ts) :

```typescript
function pubClick(): Cleanup {
  // 节流作用在 pub 本身 (clickThrottleDelay 默认 0)
  const throttledPub = throttle(pub, sentry.options.clickThrottleDelay);
  const listener = function (ctx: MouseEvent) {
    throttledPub(EventType.Click, {
      ...getBaseData(),
      type: EventType.Click,
      extra: ctx,
    });
  };
  // 冒泡阶段监听 (未传 capture)
  document.addEventListener("click", listener);
  return () => document.removeEventListener("click", listener);
}
```

声明式 vs 命令式的优势:

1. 零 JS 代码: 业务开发只需在 HTML 上加属性, 无需调用 SDK API
2. 不侵入逻辑: 不与业务事件处理耦合
3. Shadow DOM 支持: `composedPath()` 穿透 Shadow DOM 边界
4. 自动化: 配合框架的模板系统, 可以批量为组件添加追踪属性
5. 元素路径: `dom2str()` 生成 CSS 选择器式祖先路径, 最近 5 层, 128 字符上限, 超预算时丢弃整层选择器而非截断半个

---

##

## 设备指纹和用户身份体系是如何设计的?

身份体系分为三层, 实现在 `core/identity.ts` 和 `utils/sentry.ts`.

三层身份标识:

| 标识          | 来源                        | 持久化       | 用途               |
| ------------- | --------------------------- | ------------ | ------------------ |
| `anonymousId` | FingerprintJS visitorId     | localStorage | 匿名用户跨会话追踪 |
| `visitorId`   | 后端设置 (`setVisitorId()`) | 内存         | 业务侧访客标识     |
| `userId`      | 业务设置 (`setUserId()`)    | 内存         | 登录用户标识       |

三者都存放在 `sentry.options` 中, 组装上报数据时逐条附到 IReportData 外层; `getIdentity()` 返回 `{ anonymousId, visitorId, userId, hasAnonymousId, hasVisitorId }`, 其中 has 字段就是 `value !== "unknown"` 的判断.

FingerprintJS 集成:

```typescript
async function initIdentity(): Promise<void> {
  if (!sentry.options.enableFingerprint) return;

  // 优先从 localStorage 读取缓存 (key: yukino_sentry_anonymous_id)
  const cached = localStorage.getItem("yukino_sentry_anonymous_id");
  if (cached) {
    sentry.setOptions({ anonymousId: cached });
    return;
  }

  // 动态加载 FingerprintJS (避免未启用时加载 ~50KB)
  const fingerprint = await import("@fingerprintjs/fingerprintjs");
  const agent = await fingerprint.default.load();
  const result = await agent.get();
  localStorage.setItem("yukino_sentry_anonymous_id", result.visitorId);
  sentry.setOptions({ anonymousId: result.visitorId });
}
```

设备信息采集 (utils/sentry.ts, 惰性 getter + 扁平结构) :

```typescript
import { UAParser } from "ua-parser-js";

class Sentry implements ISentry {
  #deviceInfo: IDeviceInfo | null = null;

  // 首次访问 (首条上报组装时) 才解析 UA, 之后缓存复用
  get deviceInfo(): IDeviceInfo {
    this.#deviceInfo ??= collectDeviceInfo();
    return this.#deviceInfo;
  }
}

function collectDeviceInfo(): IDeviceInfo {
  const res = new UAParser().getResult();
  return {
    browserName: res.browser.name ?? UNKNOWN,
    browserVersion: res.browser.version ?? UNKNOWN,
    osName: res.os.name ?? UNKNOWN,
    osVersion: res.os.version ?? UNKNOWN,
    userAgent: res.ua,
    deviceModel: res.device.model ?? UNKNOWN,
    deviceType: res.device.type ?? UNKNOWN,
    language: getLanguage(), // navigator.language
    screenResolution: getScreenResolution(), // 如 "1920x1080"
  };
}
```

设计考量:

1. 隐私合规: FingerprintJS 默认禁用 (`enableFingerprint: false`) , 需用户主动开启; 关闭时 anonymousId 保持 "unknown"
2. 缓存优先: anonymousId 缓存到 localStorage, 避免每次加载都计算; 指纹生成失败仅记录日志, 不阻断初始化
3. 异步非阻塞: `void initIdentity()` 不阻塞 SDK 初始化
4. deviceInfo 惰性采集: UA 解析推迟到第一次上报组装时执行, 且 `sentry` 单例挂到 `globalThis.__sentry__`, 可在控制台直接查看 options 与 deviceInfo

---

## 项目的构建方案和工程化实践有哪些?

构建工具:

- 构建: Rollup (`rollup.config.ts`) , 六个入口 (index/react/vue/vite/webpack/plugins)
  - `preserveModules: true`: 保留模块结构, 利于 tree-shaking
  - 双格式输出: ESM (`.js`) + CJS (`.cjs`) , 均经 terser 压缩
  - 第三个 dts 构建产出类型声明 (`rollup-plugin-dts`)
  - 自定义插件 buildStart 清空 dist, buildEnd 把仓库 `.agents/skills/yukino-sentry` 拷贝到包内 `skills/` 目录 (随 npm 包发布的 agent skill)
  - 所有运行时依赖 (zod/web-vitals/ua-parser-js/rrweb/pako/fingerprintjs/source-map 及 react/vue/vite/webpack) 全部 external, 不打入产物

package.json exports 多入口:

```json
{
  "exports": {
    ".": { "import": "./dist/index.js", "require": "./dist/index.cjs" },
    "./react": { "import": "./dist/react.js" },
    "./vue": { "import": "./dist/vue.js" },
    "./plugins": { "import": "./dist/plugins/index.js" },
    "./vite": { "import": "./dist/vite.js" },
    "./webpack": { "import": "./dist/webpack.js" }
  }
}
```

(每个入口实际都带 types/import/require 三个条件; react/vue/vite/webpack 为 optional peerDependencies, react 支持 16-19, vite 支持 7/8, webpack 支持 4/5)

TypeScript 配置:

- `strict: true`: 全量严格模式
- `target: "ESNext"`: 不降级语法
- `moduleResolution: "Bundler"`: 适配现代打包工具

测试工程:

- Vitest + jsdom 环境
- 18 个测试文件 (test/\*.test.ts) 覆盖核心模块
- v8 coverage, 阈值 70% (lines/functions/branches/statements)
- 自定义 fake: `fake-intersection-observer.ts`、`report-payloads.ts`

依赖管理:

| 依赖                         | 用途            | 体积考量                |
| ---------------------------- | --------------- | ----------------------- |
| web-vitals                   | Core Web Vitals | ~2KB                    |
| @rrweb/record                | 屏幕录制        | 较大, 插件按需加载      |
| pako                         | gzip 压缩       | ~45KB, 仅录屏插件用     |
| ua-parser-js                 | UA 解析         | ~20KB                   |
| @fingerprintjs/fingerprintjs | 设备指纹        | ~50KB, 默认禁用         |
| zod                          | 运行时校验      | ~13KB                   |
| source-map                   | 开发期堆栈反解  | Node-only, 不进浏览器包 |

Monorepo 结构:

仓库为 pnpm workspace, 包含 `sentry` (SDK 本体) 、`client` (React demo) 、`server` (日志接收/反解服务) 三个包, SDK 独立构建发布.

---

## BoundedSet 的实现原理是什么? 为什么用 Map 而不是 Set?

```typescript
class BoundedSet<T> {
  private map = new Map<T, true>();
  private readonly capacity: number;

  has(value: T): boolean {
    return this.map.has(value);
  }

  add(value: T): void {
    if (this.map.has(value)) {
      this.map.delete(value); // 先删再插, 更新插入顺序
    }
    this.map.set(value, true);
    if (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value; // Map 迭代序 = 插入序
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }
}
```

为什么用 Map 而不是 Set:

1. 利用 Map 的插入顺序迭代保证: ES2015 规范保证 Map 按插入顺序迭代. `map.keys().next().value` 始终是最早插入的键, 即 LRU 淘汰目标.

2. Set 也有插入顺序, 理论上可以用 Set 实现. 但 Map 的 `delete` + `set` 组合更明确地表达了「刷新顺序」的语义. 实际上这里用 Set 也可以 (`set.delete(v); set.add(v)`) , 选择 Map 更多是代码风格统一.

3. O(1) 操作: has/add/delete 均为 O(1), 淘汰最旧元素也是 O(1) (取迭代器首元素) .

LRU 语义:

- 重复 add 同一个值时, 先 delete 再 set, 将其移到「最新」位置
- 超出容量时淘汰 `keys().next().value` (最旧的)
- 这保证了最近出现的错误 ID 不会被误淘汰

应用场景:

错误去重: `sentry.codeErrors = new BoundedSet<string>(1000)`, 容量 1000 意味着最多记住最近 1000 种不同错误的签名. 超出后最旧的错误签名被遗忘, 如果再次出现会重新上报 (这是可接受的, 因为 1000 种不同错误已经是极端场景) .

---

## 上报管道为什么要保持「同步快路径」? 定时器为什么要 unref?

同步快路径 (reporter/promise.ts) :

```typescript
// 无异步钩子时, 管道必须从 send() 一路同步走到传输层:
// 一个无条件 await 会把 sendBeacon 推迟一个微任务,
// 而 pagehide 触发的停留时长 flush 等不起这个微任务.
export function isPromise<T>(value: T | Promise<T>): value is Promise<T> {
  return (
    value instanceof Promise ||
    (value !== null &&
      typeof value === "object" &&
      "then" in value &&
      typeof value.then === "function")
  );
}

// 使用方式 (reporter/index.ts) :
const reportResult = runBeforeReportHook(this.id, payload);
const data = isPromise(reportResult) ? await reportResult : reportResult;
```

设计意图:

1. beforeSend/beforeSendBatch 允许返回 Promise, 但绝大多数场景是同步钩子甚至无钩子. 如果代码写成 `await hook(data)`, 即使返回值是同步对象, await 也会强制切一个微任务
2. pagehide 场景: 页面隐藏时 `flushCurrentPageDwell(true)` -> `send(payload, true)` -> `flush()` -> `sendBeacon`. 这条链路只要中间出现一次微任务切换, 页面就可能在回调恢复前销毁, beacon 永远发不出去
3. `isPromise` 守卫让同步结果走同步分支、异步结果才 await, 兼顾了钩子灵活性与卸载场景可靠性

定时器 unref (reporter/timer.ts + flush-scheduler.ts) :

```typescript
export function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  if (hasUnref(timer)) {
    timer.unref(); // 仅 Node 定时器有 unref, 浏览器句柄是 number, 安全跳过
  }
}

export function scheduleFlush(previousTimer, delay, flush) {
  if (previousTimer) clearTimeout(previousTimer);
  const nextTimer = setTimeout(() => void flush(), delay);
  unrefTimer(nextTimer);
  return nextTimer;
}
```

设计意图:

1. SDK 会在 SSR/测试等 Node 环境被 import, 批量 flush 定时器 (cacheWaitingTime) 和服务端恢复探测定时器 (60s) 如果不 unref, 会阻止 Node 进程正常退出 (vitest 挂住、脚本不结束)
2. `hasUnref` 结构判断兼容两种环境: 浏览器 setTimeout 返回 number, 没有 unref 方法, 直接跳过
3. `scheduleFlush` 统一「清旧定时器 + 起新定时器 + unref」三件事, send 的延迟批量、flush 后的 100ms 续发、恢复探测的重排都复用同一函数

---

## 路由监听是如何同时支持 History 和 Hash 模式的?

路由监听分为两处: History 模式在 `core/decorate-route.ts`, Hash 模式在 `core/decorates.ts`.

History 模式拦截 (decorate-route.ts) :

```typescript
export function pubHistory(): Cleanup {
  latestHref = getCurrentRouteUrl();

  // 1. popstate (前进/后退) : addEventListener 标准监听, 不影响用户的 onpopstate
  const popstateListener = () => {
    const from = latestHref;
    const to = getCurrentRouteUrl();
    if (from === to) {
      return;
    }
    latestHref = to;
    pub(EventType.History, {
      ...getBaseData(),
      type: EventType.History,
      from,
      to,
    });
  };
  globalThis.addEventListener("popstate", popstateListener);

  // 2. 装饰 pushState 和 replaceState, 二者共用同一个装饰器
  const historyDecorator = (oldPropsVal: History["pushState"]) => {
    return function (
      this: History,
      data: unknown,
      unused: string,
      url?: string | URL | null,
    ) {
      if (!url) {
        return oldPropsVal.call(this, data, unused, url); // 无 url 参数不追踪
      }
      const from = latestHref;
      const to = normalizeRouteUrl(url); // new URL(url, location.href).href 归一化
      // 先执行原始 pushState/replaceState, 保证事件处理器观察到目标 href
      const result = oldPropsVal.call(this, data, unused, url);
      if (from !== to) {
        latestHref = to;
        pub(EventType.History, {
          ...getBaseData(),
          type: EventType.History,
          from,
          to,
        });
      }
      return result;
    };
  };
  const cleanupPushState = decorateProp(
    globalThis.history,
    "pushState",
    historyDecorator,
  );
  const cleanupReplaceState = decorateProp(
    globalThis.history,
    "replaceState",
    historyDecorator,
  );

  return () => {
    globalThis.removeEventListener("popstate", popstateListener);
    cleanupReplaceState();
    cleanupPushState();
  };
}
```

注意: 路由变化没有统一的事件类型, History 模式发布 `EventType.History` (枚举值 "History") , Hash 模式发布 `EventType.HashChange` (枚举值 "Event hashchange") , 下游 handleHistory / handleHashChange 分别订阅处理.

Hash 模式拦截 (decorates.ts) :

```typescript
function pubHashChange(): Cleanup {
  const listener = function (ctx: HashChangeEvent) {
    pub(EventType.HashChange, {
      ...getBaseData(),
      type: EventType.HashChange,
      extra: ctx,
    });
  };
  globalThis.addEventListener("hashchange", listener);
  return () => globalThis.removeEventListener("hashchange", listener);
}
```

为什么需要装饰 pushState/replaceState:

- `pushState` 和 `replaceState` 不会触发任何原生事件 (这是 History API 的设计缺陷)
- 只有 `popstate` (前进/后退) 和 `hashchange` 有原生事件
- 因此必须通过猴子补丁拦截 pushState/replaceState 才能感知 SPA 路由变化

配置控制:

```typescript
// 可通过配置独立开关
enableHistory: true,    // 是否监听 History API
enableHashChange: true, // 是否监听 hashchange
```

路由变化的下游处理 (handle-route.ts) :

handleHistory / handleHashChange 分别订阅 EventType.History / EventType.HashChange, 事件触发后:

1. 记录面包屑 (`breadcrumb.push`, userAction 由 event2breadcrumb 生成)
2. 调用 pv-lifecycle.ts 的路由 PV 处理: 先发送上一页停留时长, 再发送新页面 PV (详见下文「PV 和页面停留时长是如何追踪的?」)

---

## PV 和页面停留时长是如何追踪的?

实现在 `core/pv-lifecycle.ts`. PV 和停留时长不是独立的事件类型, 二者都是 `type: EventType.PV`, 通过 `name` 字段区分.

PV (Page View) 追踪:

```typescript
// SDK 初始化时 (setup.ts 调用 pv-lifecycle 的初始化函数) 立即发送首次 PV, immediate = true
reporter.send(
  {
    ...getBaseData(),
    type: EventType.PV,
    name: "PageLoad",
    message: location.href,
    status: Status.OK,
    extra: {
      url: location.href,
      referrer: document.referrer,
      entryTime: Date.now(),
    },
  },
  true,
);
```

路由变化时由 handle-route.ts 调用 pv-lifecycle.ts 的路由处理函数:

```typescript
// 1. 目标 URL 经 new URL 归一化, 与当前页相同则不重复上报
// 2. 先发送上一页停留时长 (见下)
// 3. 重置当前页状态 (url/referrer/name/startedAt) , 发送新页面 PV
reporter.send(
  {
    ...getBaseData(),
    type: EventType.PV,
    name, // HistoryChange 或 HashChange
    message: url,
    status: Status.OK,
    extra: { url, referrer, entryTime },
  },
  false,
);
```

停留时长上报:

```typescript
// 过滤极短停留 (<= 100ms) , 避免路由重定向产生无意义数据
if (duration <= 100) return;

reporter.send(
  {
    ...getBaseData(),
    type: EventType.PV, // 与 PV 共用 EventType.PV, 靠 name 区分
    name: "PageDwell",
    message: page.url,
    status: Status.OK,
    extra: { url: page.url, referrer: page.referrer, duration }, // 时长字段为 extra.duration
  },
  immediate,
);
```

页面关闭/隐藏时的停留时长 (setup.ts) :

```typescript
// pagehide 在移动端比 beforeunload 可靠得多 (页签切后台/被杀都会触发)
globalThis.addEventListener("pagehide", () => {
  flushCurrentPageDwell(true); // immediate = true, 走 sendBeacon 保证发出
});
```

数据模型 (均为 type: EventType.PV) :

| name (区分字段)          | 触发时机           | extra 关键字段              |
| ------------------------ | ------------------ | --------------------------- |
| PageLoad                 | SDK 初始化         | url, referrer, entryTime    |
| HistoryChange/HashChange | 路由切换           | url, referrer, entryTime    |
| PageDwell                | 路由切换、页面关闭 | url, referrer, duration(ms) |

设计要点:

1. 100ms 阈值: 过滤路由重定向 (如 `/` -> `/home`) 产生的极短停留 (`duration <= 100` 直接丢弃)
2. pagehide 兜底: 确保用户关闭标签页或切后台时也能记录停留时长, 移动端 beforeunload 不可靠而 pagehide 稳定触发
3. sendBeacon 保证: 页面关闭时 fetch 可能被取消, sendBeacon 由浏览器保证发出; 上报管道的同步快路径保证这条链路不被微任务打断
4. SPA 友好: 不依赖页面刷新, 通过路由变化事件追踪单页内的页面切换

---

## 如果让你优化这个 SDK, 你会从哪些方面入手?

基于对源码的深入理解, 可以从以下维度优化:

1. 性能优化:

- Web Worker 上报: 将 JSON 序列化、gzip 压缩移到 Worker 线程, 避免阻塞主线程 (当前 pako 压缩在主线程执行)
- 批量 DOM 查询优化: 白屏检测每轮做 18 次 `elementFromPoint`, 该 API 依赖布局结果, 布局处于脏状态 (pending layout) 时调用会强制同步回流 (forced reflow); 可做的优化: 循环内保持连续只读、不穿插样式写入或 DOM 修改 (整批最多回流一次); 无骨架模式下发现首个非空点即可短路结束本轮, 不必查满 18 点; 采样整体已用 `requestIdleCallback` 调度到主线程空闲期执行, 避免阻塞渲染
- FSP MutationObserver 节流: 当前每次 DOM 变化都检查 `isInViewport` (触发 getBoundingClientRect) , 可以用 IntersectionObserver 替代视口判断
- rrweb 加载时机: rrweb 已通过 `import()` 动态加载 (recorder.ts) , 但 ScreenRecordPlugin 的 init 会立即触发加载; 可以进一步推迟到首次出现录屏标记时再加载, 让未发生错误的会话完全不付出加载代价

2. 可靠性优化:

- Service Worker 离线队列: localStorage 有 5MB 限制且同步阻塞, Service Worker + Cache API 可以存储更大的离线队列
- 指数退避重试: 当前 server-recovery 使用固定 60s 间隔, 可以改为指数退避 (1s -> 2s -> 4s -> ... -> 60s)
- 数据完整性校验: 离线缓存写入时添加 checksum, 防止 localStorage 数据损坏

3. 功能增强:

- Session Replay 全量录制: 当前只有错误前 3 秒, 可以提供全量录制选项 (配合采样率控制体积)
- Source Map 反解: 上报时附带 sourcemap 标识, 后端自动反解压缩后的堆栈
- 用户行为路径分析: 基于面包屑数据提供漏斗分析能力
- Performance Budget 告警: 支持配置性能预算, 超标时主动告警

4. 架构优化:

- 事件总线类型安全: 当前 `pub(type, data: TReportPayload)` 传入宽泛联合类型, EventType 与载荷类型无关联, 可以用 discriminated union 让 handler 获得精确类型
- 插件通信: 当前插件只能订阅事件总线, 无法插件间通信. 可以添加插件间消息通道 (如录屏插件通知性能插件降低采样)
- 配置热更新: 支持运行时动态修改采样率、过滤规则, 无需重新 init

5. 体积优化:

- Zod 替换: zod ~13KB, 对于固定 schema 可以用手写校验函数替代 (~1KB)
- ua-parser-js 按需: 只解析 browser/os/device 三个字段, 可以用更轻量的方案
- Tree-shaking 优化: 确保 `enableXhr: false` 时 XHR 拦截代码被完全移除

6. 可观测性:

- SDK 自身健康度: 上报 SDK 自身的错误率、丢弃率、队列积压等指标
- Debug 面板: 提供可视化调试工具, 实时查看事件流、队列状态、上报结果

---

## 上报数据模型 (IReportData) 的完整结构是怎样的? 一条错误日志最终携带哪些信息?

一条事件从采集到上报经历两次数据组装: `getBaseData()` (采集时) 和 `payloadToReportData()` (入队时) .

采集时的基础数据 (utils/get-base-data.ts) :

```typescript
function getBaseData(): IReportPayload {
  return {
    id: generateUUID(), // 事件级唯一 ID (crypto.randomUUID / getRandomValues v4 / 时间戳兜底)
    deviceId: getDeviceId(), // localStorage 持久化的设备 ID
    sessionId: getSessionId(), // sessionStorage 的会话 ID
    message: "",
    timestamp: Date.now(),
    time: new Date().toISOString(),
    name: "",
    status: Status.OK,
    type: EventType.Custom,
  };
}
```

入队时的外层包装 (reporter/report-data.ts) :

```typescript
function payloadToReportData(id, payload): IReportData {
  const { type, name, time, timestamp, message, status } = payload;
  const data: IReportData = {
    type,
    name,
    time,
    timestamp,
    message,
    status,
    id, // 外层 id 为 DataReporter 实例 ID, 事件级 ID 在 payload.id
    url: location.href, // 事件发生时的页面 URL
    userId: sentry.options.userId,
    anonymousId: sentry.options.anonymousId, // FingerprintJS, 未启用为 "unknown"
    visitorId: sentry.options.visitorId, // setVisitorId 设置, 默认 "unknown"
    projectId: sentry.options.projectId,
    sdkVersion: SDK_VERSION,
    deviceInfo: sentry.deviceInfo, // UA 解析 + 语言 + 屏幕分辨率 (惰性采集)
    payload, // 原始采集数据整体挂在 payload 字段
  };
  if (BREADCRUMB_EVENT_TYPES.has(type)) {
    data.breadcrumbs = breadcrumb.dump(); // 仅错误类事件附带面包屑
  }
  return data;
}
```

最终一条 JSError 上报数据的完整结构:

```
IReportData
├── type: "Error"
├── name: 出错脚本的 filename
├── message: 错误消息
├── status: "Error"
├── id / timestamp / time: id 为 DataReporter 实例 ID, 事件级唯一 ID 在 payload.id
├── url: location.href
├── userId / anonymousId / visitorId: 三层身份标识
├── projectId / sdkVersion: 归属信息
├── deviceInfo: { browserName, browserVersion, osName, osVersion,
│                 userAgent, deviceModel, deviceType,
│                 language, screenResolution }
├── breadcrumbs: 故障前操作轨迹 (仅错误类事件携带)
└── payload:
    ├── id: 事件级唯一 ID (generateUUID)
    ├── deviceId / sessionId: 设备与会话标识
    ├── line / column: 出错行列号 (window.onerror 路径携带, 配合 sourcemap 反解)
    └── extra: Error.stack 堆栈字符串 (Error 实例路径携带, 如 traceError/console.error)
```

设计要点:

1. 双层结构: 外层是统一的检索维度 (type/url/userId/deviceInfo) , 内层 payload 保留事件原始细节, 后端可以按外层字段建索引, 按 payload 还原现场
2. React/Vue/OtherFrameworks 框架错误额外携带 `extra: { error, stack, context }`, context 为 React ErrorInfo (componentStack) 或 Vue 的 instance + info
3. 批量错误额外携带 `batchError: true`、`batchErrorLength`、`batchErrorLastHappenTime`
4. 录屏事件携带 `event` (gzip + base64 的 rrweb 事件流) 和 `eventCount`

---

## Source Map 堆栈反解是如何实现的? 为什么生产环境用 hidden sourcemap?

反解能力实现在 `source-map/` 目录, 是 Node-only 模块, 不会打入浏览器 SDK. 分为三层:

1. 核心反解 (source-map/source-map.ts) :

```typescript
// 1) 解析堆栈字符串, 兼容 Chrome 和 Firefox 两种帧格式
const CHROME_FRAME = /^\s*at (?:(.+?)\s+)?\(?(\S+?):(\d+):(\d+)\)?\s*$/;
const FIREFOX_FRAME = /^\s*(?:(.*?)@)?(\S+?):(\d+):(\d+)\s*$/;
export function parseStack(stack: string): RawFrame[]; // 最多 30 帧

// 2) 单帧反解: 加载 map 文件 -> SourceMapConsumer 查原始位置
export async function resolveFrame(loadMap: MapLoader, frame: RawFrame) {
  const map = await loadMap(frame.url);
  return SourceMapConsumer.with(JSON.stringify(map), null, (consumer) => {
    // 浏览器行列号是 1-based, sourcemap 列号是 0-based, 需要 column - 1
    const pos = consumer.originalPositionFor({
      line: frame.line,
      column: Math.max(0, frame.column - 1),
    });
    // 附带源码片段: 出错行上下各 3 行 (SNIPPET_CONTEXT = 3)
    const content = consumer.sourceContentFor(pos.source, true);
    ...
  });
}

// 3) 整包增强: 对上报批次逐条识别错误类型并附加 sourcemap.frames
export async function enrichReportData(loadMap, records) {
  // type === "Error" 且有 line/column: 用 record.name (出错脚本 URL) 反解单帧
  // payload.extra 是堆栈字符串: 反解整条堆栈
  // type === "React"/"Vue"/"OtherFrameworks": 从 payload.extra.stack 取堆栈
  //    (payload.stack 作为旧版载荷的兜底) 反解整条堆栈
}
```

2. Map 文件加载策略 (MapLoader 抽象) :

- Vite 开发环境 (source-map/vite.ts) : 从 dev server 的内存模块图取 map, `server.moduleGraph.getModuleByUrl(url)` -> `mod.transformResult.map`, 不落盘
- 生产环境: 由后端服务持有构建产物中的 `.map` 文件做反解

3. 构建侧配合 (client demo 的 vite.config.ts) :

```typescript
export default defineConfig({
  build: {
    // hidden: 生成 sourcemap, 但产物中不追加 sourceMappingURL 注释
    sourcemap: "hidden",
  },
  plugins: [moveSourcemaps()], // closeBundle 时把所有 .map 移动到 dist/.sourcemaps
});
```

为什么用 `sourcemap: "hidden"` + 移走 .map 文件:

1. 安全: 生产 bundle 不带 `sourceMappingURL` 注释, 浏览器 DevTools 和外部用户拿不到源码; .map 文件单独收集, 只上传到内部监控平台
2. 可反解: 监控平台按「出错脚本 URL + 构建版本」匹配对应 .map, 服务端还原原始行列号和源码片段
3. 体积: .map 通常与产物同量级, 剥离后不影响用户下载体积

反解结果 (ResolvedFrame) 包含: `source` (原始文件) 、`originalLine/originalColumn`、`name` (原始函数名) 、`snippet` (出错行上下 3 行源码, highlight 标记出错行) .

---

## Vite dev-server mock 插件 (@yukino.js/sentry/vite) 是做什么的?

`sentry/src/vite.ts` 导出 `sentryPlugin` (vite) 和 `sentryPlugin7` (vite 7, 通过 `vite7@npm:vite@7.3.3` 别名同时兼容两个大版本) , 是开发环境的「mock 上报服务端」, 解决本地开发没有日志服务的问题.

工作流程:

```typescript
function buildPlugin({ dsn }: ISentryPluginOptions) {
  const url = dsn ?? DEFAULT_MOCK_DSN; // 默认 "/sentry"
  let logStream: LogStreamHandle | null = null;
  return {
    name: "vite-plugin-sentry",
    apply: "serve" as const, // 仅 dev server 生效, vite build 完全不受影响
    configureServer(server) {
      // 1. dev server 启动时创建 logs/sentry_<timestamp>.jsonl 写流
      logStream = createLogStream();
      // 2. 注册 connect 中间件, 拦截 POST <dsn> 的请求
      server.middlewares.use(
        createMockMiddleware(url, logStream.fileStream, (records) =>
          enrichReportData(server, records),
        ),
      );
    },
    closeBundle() {
      if (logStream) closeLogStream(logStream.fileStream);
    },
  };
}

export function sentryPlugin(options: ISentryPluginOptions = {}): Plugin {
  return buildPlugin(options); // vite 8
}
export function sentryPlugin7(options: ISentryPluginOptions = {}): Plugin7 {
  return buildPlugin(options); // vite 7, 同一实现两种类型签名
}
```

中间件逻辑 (node/dev-endpoint.ts, vite/webpack 共用) :

1. 匹配 `req.url === dsn && req.method === "POST"`, 其余请求 `next()` 放行
2. 收集请求体并 JSON.parse
3. 调用 `enrichReportData(server, parsedBody)` 用 dev server 内存中的 sourcemap 反解错误堆栈 (见上一节)
4. 反解后的数据以 JSONL 格式追加写入 `logs/sentry_<timestamp>.jsonl`
5. 反解失败则原样落盘, 始终返回 `{ code: 0, message: "success" }`

设计价值:

1. 本地闭环: 开发阶段无需部署日志后端, SDK 的 dsn 直接指向 dev server 路径即可完整跑通上报链路
2. 开发期即可看到反解后的源码位置: dev 环境模块未压缩但经过 esbuild/插件转换, 堆栈同样需要 map 反解
3. JSONL 格式: 一行一条批次记录, 方便 tail 观察与脚本分析 (仓库 logs/ 目录即此类产物)
4. webpack 侧对等实现 (`@yukino.js/sentry/webpack`) : `SentryWebpackPlugin` (工厂 `sentryPlugin`) 仅在 `compiler.options.devServer` 存在时生效, 包装 `devServer.setupMiddlewares` 把同一个 mock 中间件 unshift 到最前 (刻意不传 path, 避免 webpack-dev-server 剥掉 req.url 前缀破坏精确匹配) , 并 tap `compiler.hooks.assetEmitted` 收集内存文件系统中的 `.map` 产物用于反解 (精确路径 `<path>.map` 优先, 找不到再按 basename 兜底以容忍未知 publicPath) ; 另导出 `sentryMiddleware` 供手动挂载 (无 sourcemap 反解能力)

---

## 曝光 (Exposure) 插件的实现原理是什么?

ExposurePlugin (plugins/exposure/index.ts) 基于 IntersectionObserver 统计元素曝光时长, 用于广告/推荐场景的曝光归因.

核心数据结构:

```typescript
class ExposurePlugin extends SentryPlugin {
  // 按 threshold 复用 observer: 相同阈值的元素共享一个 IntersectionObserver
  private ioMap = new Map<number, IntersectionObserver>();
  // 元素 -> 曝光状态
  private targetMap = new Map<Element, ExposureState>();
}

interface ExposureState {
  readonly threshold: number; // 可见面积比例阈值, 默认 0.5
  readonly observeTime: number; // 开始观察时间
  showTime?: number; // 进入视口时间 (不在视口内时为 undefined)
  readonly params: Record<string, unknown>; // 业务自定义参数
}
```

曝光时长计算:

```typescript
new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      const targetObj = this.targetMap.get(entry.target);
      if (entry.isIntersecting) {
        targetObj.showTime = Date.now(); // 进入视口: 打点
      } else {
        if (!targetObj.showTime) return;
        const showEndTime = Date.now(); // 离开视口: 结算
        this.sendEvent(targetObj, showEndTime); // duration = showEndTime - showTime
        delete targetObj.showTime;
      }
    });
  },
  { threshold },
);
```

使用方式 (命令式 API) :

```typescript
const exposure = new ExposurePlugin();
enablePlugin(exposure);
exposure.observe({ target: bannerEl, threshold: 0.5, params: { slot: "top" } });
// 组件卸载时
exposure.unobserve(bannerEl);
```

上报数据 (EventType.Exposure) 的 extra 字段: `threshold`、`observeTime`、`showTime`、`showEndTime`、`duration`、`params`.

设计要点:

1. Observer 复用: 不按元素建 observer, 而是按 threshold 分桶共享, 大量元素曝光监控时 observer 数量恒等于阈值种类数
2. 入参 Zod 校验: `exposureTargetSchema` 校验 target 必须是 Element 实例, threshold 在 0~1 之间
3. 幂等观察: 同一元素重复 observe 不会二次注册
4. 进出配对: 只在「进入后离开」时结算一次时长, 反复进出产生多条记录, 可累加统计总曝光
5. destroy 时 disconnect 所有 observer 并清空两个 Map, 无泄漏

---

## 设备 ID 与会话 ID 是如何生成和持久化的?

实现在 `utils/session.ts`, 采用「存储介质区分生命周期」的经典方案:

```typescript
const DEVICE_ID_KEY = "yukino_sentry_device_id";
const SESSION_ID_KEY = "yukino_sentry_session_id";

// 设备 ID: localStorage, 跨会话持久
export function getDeviceId(): string {
  try {
    let deviceId = localStorage.getItem(DEVICE_ID_KEY);
    if (!deviceId) {
      deviceId = generateUUID();
      localStorage.setItem(DEVICE_ID_KEY, deviceId);
    }
    return deviceId;
  } catch {
    return generateUUID(); // 存储被禁用时每次返回新 UUID
  }
}

// 会话 ID: sessionStorage, 标签页级生命周期
export function getSessionId(): string {
  try {
    let sessionId = sessionStorage.getItem(SESSION_ID_KEY);
    if (!sessionId) {
      sessionId = generateUUID();
      sessionStorage.setItem(SESSION_ID_KEY, sessionId);
    }
    return sessionId;
  } catch {
    return generateUUID();
  }
}
```

`generateUUID()` (utils/uuid.ts) 的三级降级: `crypto.randomUUID` (仅安全上下文暴露) -> `crypto.getRandomValues` 手写 v4 (让 SDK 在纯 http 页面也可用) -> `Date.now().toString(16) + Math.random()` 兜底 (crypto 完全缺失时) .

| 标识        | 生成方式       | 存储           | 生命周期                       |
| ----------- | -------------- | -------------- | ------------------------------ |
| deviceId    | generateUUID() | localStorage   | 持久, 清缓存前不变             |
| sessionId   | generateUUID() | sessionStorage | 标签页会话级, 关页即失效       |
| anonymousId | FingerprintJS  | localStorage   | 持久, 需开启 enableFingerprint |

设计要点:

1. 惰性生成: 首次调用时才生成并写入存储, 后续直接读缓存, 保证同一设备/会话内所有事件 ID 一致
2. 存储异常兜底: localStorage/sessionStorage 不可用 (隐私模式、被禁用) 时 catch 后直接返回新的 randomUUID, 不阻塞上报
3. 与身份体系分层: deviceId/sessionId 是 SDK 自动维护的匿名标识, 不涉及隐私合规; userId/visitorId 由业务显式设置; anonymousId (FingerprintJS) 涉及浏览器指纹, 默认关闭
4. 每条事件通过 `getBaseData()` 自动附带 deviceId + sessionId, 后端可以按设备聚合错误率、按会话串联用户行为路径

---

## demo client 的文件路由改造是如何实现的?

monorepo 中的 `client` 包是 SDK 的 React demo, 它将 react-router 的配置式路由改造为文件路由 (约定式路由) , 由自研构建插件 `plugins/vite-plugin-page-routes.ts` (另有 webpack 版本) 实现.

约定: `src/pages` 目录下每个 `page.tsx` 文件即一个路由页面, 目录层级即路由层级:

```
src/pages/
├── page.tsx                -> /
├── behavior/page.tsx       -> /behavior
├── errors/page.tsx         -> /errors
├── network/page.tsx        -> /network
└── performance/page.tsx    -> /performance
```

插件工作流程:

1. `buildStart` 钩子: 递归扫描 `src/pages` 下所有 `page.tsx`, 生成 `src/generated/routes.tsx`
2. `configureServer` 钩子: dev 时用 `server.watcher` 监听 pages 目录, 文件 add/unlink 时重新生成

生成逻辑 (plugins/page-routes.js) :

```javascript
// 目录相对 pages 根的路径 -> 路由路径
export function toRoutePath(pagesDir, file) {
  const relDir = relative(pagesDir, dirname(file));
  if (relDir === "") return "/";
  return "/" + relDir.split(sep).join("/");
}

// 路由路径 -> PascalCase 组件名: /search-list -> SearchList, / -> Home
export function toComponentName(routePath) { ... }

// 生成内容: 每个页面都是 React.lazy 动态导入
imports.push(`const ${name} = lazy(() => import("${importPath}"));`);
entries.push(`  { path: "${routePath}", element: <${name} /> }`);
```

生成的 routes.tsx (实际产物节选) :

```tsx
// Auto-generated by page-routes plugin — DO NOT EDIT!!!
import { lazy } from "react";
import type { RouteObject } from "react-router-dom";

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

设计要点:

1. 代码生成而非运行时扫描: 产物是静态的 routes.tsx, 打包工具可以做 tree-shaking 和代码分割, 无运行时反射开销
2. lazy 默认分包: 每个页面独立 chunk, 路由级代码分割开箱即用
3. 写入幂等: 生成内容与已有文件一致时跳过写入, 避免触发无意义的 HMR
4. 双构建支持: 同一份生成逻辑 (page-routes.js) 被 vite 插件和 webpack 插件 (webpack-plugin-page-routes.js) 复用
5. 与监控联动: demo 以 `dsn: "/api/log"` 接入 SDK, vite dev server 通过 proxy 把 /api 转发到独立 server (8088 端口) , 由 server 端持有 dist/.sourcemaps 下的 .map 文件反解堆栈 (vite.config.ts 中 sentryPlugin mock 的 import 目前处于注释状态) , 演示「页面报错 -> 上报 -> 反解到 page.tsx 源码」的完整链路

---

## SDK 自身的调试日志 (sentryLogger) 是如何实现的?

sentryLogger (utils/logger.ts) 是 SDK 全部内部日志的出口:

1. 开关: 所有日志由 `options.debug` 控制 (每次调用实时读取 `globalThis.__sentry__?.options.debug ?? false`), 默认关闭, 生产环境零噪音; 运行时执行 `globalThis.__sentry__?.setOptions({ debug: true })` 立即生效, 无需重新 init
2. 形态: info/success/error 三级, 使用 console.groupCollapsed + 主题色前缀 (Iosevka/Maple Mono/Menlo/Cascadia Code 等宽字体) 输出
3. 结构化: 数组数据用 console.table 渲染 (可指定列) , 对象数据嵌套 console.group 展示
4. 耗时输出: success 级别支持 duration 参数, 上报批次发送成功时会输出 `Time cost Xms` (reporter/index.ts 用 performance.now() 计算 flush 耗时) , 方便定位上报管道的延迟
5. 防自捕获: error 级别输出走模块加载时提前捕获的原生 `console.error` 引用 (早于 SDK 对 console.error 的装饰) , 因此开启 debug 不会让 SDK 把自己的日志再当成错误上报, 与错误采集侧的重入标志双保险
