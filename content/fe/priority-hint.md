---
title: "Priority Hints 与 fetchpriority: 资源优先级调度实践"
description: "讲清 fetchpriority 属性的语义与取值、浏览器内置的资源优先级模型、它在预加载与首屏优化中的正确用法, 以及可度量的收益、风险与不该使用的时机。"
---

浏览器在加载页面时, 会为每个资源分配一个内部优先级, 并据此决定请求的发起顺序与带宽分配。这个模型是通用的、基于资源类型的, 它无法知道页面上哪张图片是首屏主视觉、哪个脚本是交互关键路径。Priority Hints 就是让开发者把这类业务知识以 `fetchpriority` 属性 (以及 `fetch()` 的 `priority` 选项) 的形式传达给浏览器的机制。本文说明它的语义边界、与 `preload`/`loading="lazy"` 等特性的分工、可度量的收益, 以及它不适用的情况, 适合负责首屏性能与资源加载策略的前端工程师阅读。

## 一、它解决什么问题

内置优先级模型对同类资源一视同仁: 所有视口内的图片都是同一个优先级, 浏览器分不清"首屏主图"和"第三屏缩略图"; 第三方脚本也可能与关键业务脚本竞争带宽; 在多个 `preload` 之间也无法表达轻重缓急。Priority Hints 的价值就是在这三个场景中提供细粒度信号。

需要先明确它的定位: 这只是一个提示 (hint), 浏览器不保证遵循。最终的调度决策仍由浏览器根据网络状况、资源类型、解码与渲染需求综合做出。它改变的是同一批并发请求之间的相对顺序, 而不是单个请求的下载速度。

## 二、浏览器默认的优先级模型

以 Chrome 的资源优先级分层为例, 大致如下 (不同引擎的具体分层与命名不完全一致, 此处用于建立直觉):

| 层级    | 典型资源                                     |
| ------- | -------------------------------------------- |
| Highest | 主 HTML 文档、阻塞渲染的关键 CSS             |
| High    | 同步脚本、视口内的图片、被可见文本引用的字体 |
| Medium  | 较晚发现的 CSS 与脚本、部分图片              |
| Low     | `async`/`defer` 脚本、视口外图片、音视频     |
| Lowest  | `prefetch` 资源                              |

这个模型在多数页面上是合理的, 因此覆盖它的默认行为属于例外而非常态。开发者应只在有明确性能问题或明确业务语义时介入。

还要理解这个内部优先级最终如何作用到网络上, 才能解释"为什么有时看不出效果"。在 HTTP/1.1 下, 每个源有固定的并发连接上限, 优先级主要决定"哪个请求先占用空闲连接", 即排队顺序; 连接一旦被占满, 低优先级请求只能等待。在 HTTP/2 与 HTTP/3 下, 所有请求复用一条连接, 优先级被映射为流 (stream) 的相对权重与依赖, 决定的是带宽如何在并发流之间分配, 浏览器还会按 RFC 9218 的 `Priority` 头 (urgency 与 incremental 两个参数) 把提示告知服务端。因此同一处 `fetchpriority` 改动, 在 HTTP/1.1 上表现为"更早开始下载", 在 HTTP/2/3 上更多表现为"分到更多带宽"; 当页面资源很少、连接远未饱和时, 两种协议下都可能观察不到差异。

## 三、语义与取值

### 3.1 HTML 属性

`fetchpriority` 是一个枚举属性, 可取值只有三个:

| 取值   | 含义                                                   |
| ------ | ------------------------------------------------------ |
| `high` | 相对其他外部资源以更高优先级获取                       |
| `low`  | 相对其他外部资源以更低优先级获取                       |
| `auto` | 不设置偏好, 由浏览器自行决策; 缺省值与非法值都等同于此 |

```html
<img src="hero.webp" fetchpriority="high" />
<img src="thumbnail.webp" fetchpriority="low" />
<img src="normal.webp" fetchpriority="auto" />
```

属性值不区分大小写。属性名是 `fetchpriority`, 全小写, 不带连字符。

### 3.2 fetch() 的 priority 选项

JavaScript 侧的对应入口是 `fetch()` 初始化参数中的 `priority` 字段。注意字段名与 HTML 属性名不同, 这里写作 `priority`:

```js
// 用户正在等待的搜索建议: 提高优先级
await fetch(`/api/suggestions?q=${encodeURIComponent(query)}`, {
  priority: "high",
  signal: abortController.signal,
});

// 后台埋点上报: 降低优先级, 不阻塞用户操作
await fetch("/api/telemetry", {
  method: "POST",
  priority: "low",
  keepalive: true,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});
```

不传 `priority` 即等同 `auto`。

### 3.3 支持范围

`fetchpriority` 在 HTML 规范中只定义于三个元素:

| 元素       | 用途                            |
| ---------- | ------------------------------- |
| `<img>`    | 图片资源                        |
| `<link>`   | `preload`、`prefetch`、样式表等 |
| `<script>` | 脚本资源                        |

此外 SVG 中有同名的 `fetchpriority` 属性, 作用于 `image`、`feImage`、`script` 三个 SVG 元素, 用于 SVG 内引用的外部资源; 它比 HTML 属性更晚标准化, 兼容面更窄。

`<iframe>` 不支持该属性, 主流浏览器也未实现。对非关键 iframe (如第三方嵌入), 应改用 `loading="lazy"` 延迟加载或在需要时动态插入; 对关键 iframe, 把它放在 HTML 靠前的位置并减少其前面的阻塞资源更有效。

## 四、与相邻资源提示的关系

这些特性经常被混用, 但它们作用在不同环节:

| 特性                                | 作用层面                                     | 与 fetchpriority 的关系                                    |
| ----------------------------------- | -------------------------------------------- | ---------------------------------------------------------- |
| `preload`                           | 提前告知浏览器"这个资源一定会用到", 提前发现 | 组合使用, 在多个 preload 间建立优先级梯度                  |
| `prefetch`                          | 空闲时获取"未来可能用到"的资源               | 本身就是低优先级, 再标 `low` 是双重保障                    |
| `preconnect` / `dns-prefetch`       | 提前建立连接、解析 DNS, 不涉及具体资源       | 与 fetchpriority 无直接关系, 可并行使用                    |
| `loading="lazy"`                    | 控制图片/iframe 何时开始加载 (进入视口附近)  | 正交, 可组合: 晚点加载且加载时排后面                       |
| `modulepreload` / `async` / `defer` | 控制脚本的加载与执行时机                     | `fetchpriority` 只影响加载排队, 不改变执行时机             |
| HTTP 扩展优先级 (RFC 9218)          | 协议层的流优先级                             | 浏览器把应用层提示映射为协议层参数, 开发者通常无需直接操作 |

最需要分清的是 `preload` 与 `fetchpriority`: 前者改变资源被发现的时机, 后者改变资源在加载队列中的排位。它们解决不同问题, 经常配合但不可互相替代。

## 五、典型优化场景

### 5.1 提升 LCP 图片优先级

投入产出比最高的场景是首屏主视觉图片 (LCP 元素)。两种情况区别对待:

```html
<!-- 图片在 HTML 中直接出现: 加属性即可 -->
<img
  src="/images/hero.webp"
  fetchpriority="high"
  width="1200"
  height="630"
  alt=""
/>

<!-- 图片由 CSS background-image 定义: 发现时机晚, 用 preload 提前 -->
<link
  rel="preload"
  as="image"
  href="/images/css-hero.webp"
  fetchpriority="high"
/>
```

响应式主图要把优先级提示与候选集一起声明: `<img>` 上的 `fetchpriority` 作用于 `srcset`/`sizes` 最终选中的那个候选; 若主图由 CSS 或脚本注入、需要用 `preload` 提前发现, 则要在 `<link>` 上同时给出 `imagesrcset` 与 `imagesizes`, 否则浏览器只能预加载固定的一张, 与真正渲染的候选不一致时反而浪费带宽。`<picture>` 的 `<source>` 不支持 `fetchpriority`, 提示必须写在 `<img>` 上。

```html
<link
  rel="preload"
  as="image"
  href="/hero-800.webp"
  imagesrcset="/hero-800.webp 800w, /hero-1600.webp 1600w"
  imagesizes="100vw"
  fetchpriority="high"
/>
```

在框架里这一属性同样可用, 但写法随 JSX 属性命名规则变为驼峰: React 19 的 `<img fetchPriority="high">`、`<script fetchPriority>`、`<link fetchPriority>` 会被渲染为对应的小写 HTML 属性; Next.js 的 `<Image>` 用 `preload` 表达提前发现与立即加载, `fetchPriority` prop 落到 `<img>` 与预加载 `<link>` 的 `fetchpriority` 上。

同时给出宽高可以避免布局偏移, 这与优先级调整是两件互补的事。若 LCP 元素是文本, 则应优先优化字体加载与阻塞资源, 给图片调优先级没有意义。

### 5.2 降低非关键图片优先级

首屏以下、缩略图、装饰性图片可以降低优先级, 避免与关键资源争抢带宽。与懒加载组合时, 二者各自解决一个问题:

```html
<img
  src="/gallery/photo-07.webp"
  loading="lazy"
  fetchpriority="low"
  width="400"
  height="300"
  alt=""
/>
```

`loading="lazy"` 让它在接近视口前不加载, `fetchpriority="low"` 让它在真正加载时排在后面。需要注意 `low` 只是降低排位, 不是延迟或取消: 网络空闲时它照样立即下载。

### 5.3 控制脚本优先级

页面依赖一个核心脚本来渲染交互界面, 同时又加载若干第三方脚本 (分析、广告、客服) 时, 把第三方统一标为低优先级, 让浏览器优先下载核心脚本:

```html
<script src="/js/app-core.js" fetchpriority="high"></script>

<script
  src="https://analytics.example.com/tracker.js"
  async
  fetchpriority="low"
></script>
<script
  src="https://ads.example.com/widget.js"
  async
  fetchpriority="low"
></script>
```

注意 `fetchpriority` 不改变脚本的执行语义, `async`/`defer` 与模块依赖顺序仍由原有规则决定。

### 5.4 在 preload 之间建立梯度

当页面有多个 `preload` 时, 用 `fetchpriority` 区分轻重缓急:

```html
<link rel="preload" as="image" href="/hero.webp" fetchpriority="high" />
<link
  rel="preload"
  as="font"
  type="font/woff2"
  href="/fonts/main.woff2"
  crossorigin
/>
<link rel="prefetch" href="/next-page/data.json" fetchpriority="low" />
```

`prefetch` 资源默认已是低优先级, 再标 `low` 是为了确保当前页面资源紧张时不会抢占带宽。

### 5.5 动态请求

对运行时发起的请求, `priority` 适合区分"用户正在等待"和"后台进行"两类流量。搜索建议、自动补全属于前者; 埋点、日志上报、预取下一页数据属于后者。配合 `AbortController` 取消过期请求, 效果比单纯调优先级更明显。

## 六、收益的度量与验证

优先级调整在快速网络下往往看不出差别, 在慢速网络或高并发资源加载时才明显。验证时先模拟慢速网络, 再观察关键资源的开始下载时间。

在 Chrome DevTools 的 Network 面板中, 右键列标题勾选 Priority 列, 即可看到每个资源的优先级标签; 对比调整前后关键资源的排位与瀑布图位置。Performance 面板则用于观察整体加载过程中关键资源是否更早开始。

用 PerformanceObserver 可以度量 LCP 本身:

```js
new PerformanceObserver((list) => {
  const entries = list.getEntries();
  const last = entries[entries.length - 1];
  console.log("LCP:", last.startTime, "ms", "element:", last.element);
}).observe({ type: "largest-contentful-paint", buffered: true });
```

用 Resource Timing 可以确认具体资源的下载时机是否提前:

```js
new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    if (entry.initiatorType === "img" || entry.initiatorType === "link") {
      console.log(
        entry.name,
        entry.startTime,
        entry.duration,
        entry.transferSize,
      );
    }
  }
}).observe({ type: "resource", buffered: true });
```

生产环境通常用 web-vitals 采集字段数据, 把 LCP 与资源时序上报到分析平台, 按真实用户的网络条件评估收益:

```js
import { onLCP } from "web-vitals";

onLCP((metric) => {
  navigator.sendBeacon(
    "/analytics",
    JSON.stringify({ name: "LCP", value: metric.value, id: metric.id }),
  );
});
```

评估时的原则是: 以同一页面调整前后的字段数据对比为准, 不看单次实验室数据的抖动。如果 LCP 元素并非图片, 或页面的瓶颈在服务端响应时间 (TTFB), 那么调整资源优先级不会有可观测收益。

## 七、兼容性与降级

`fetchpriority` 以 Safari 17.2 (2023-12) 为最晚落地引擎, 在 2024 年初进入 Baseline "newly available", 并按 30 个月规则于 2026 年中转为 "widely available"。各主流引擎的起始支持版本:

| 引擎                | 支持起始版本 |
| ------------------- | ------------ |
| Chrome / Edge       | 101          |
| Firefox             | 132          |
| Safari / iOS Safari | 17.2         |
| Samsung Internet    | 19           |

HTML 属性与 `fetch()` 的 `priority` 选项的支持起步版本基本同步。

对不支持的浏览器, 该属性会被静默忽略, 不产生错误也没有副作用; `fetch()` 中多传的 `priority` 字段同样被忽略。因此这是一个天然渐进增强的特性, 不需要 polyfill 或特性检测即可安全使用。若确实需要检测, 可以通过 `'fetchPriority' in HTMLImageElement.prototype` 判断 HTML 属性是否受支持。

相比之下, `loading="lazy"` 已是广泛可用的特性, 兼容面更广; 在不支持 `fetchpriority` 的环境中, 懒加载仍能承担大部分"降低非关键资源影响"的职责。

## 八、常见误区

- 认为它能加快资源下载速度。它不改变带宽或服务端响应速度, 只改变并发请求之间的调度顺序。页面只有一个资源待加载时, 标 `high` 没有任何效果。
- 把 `fetchpriority` 等同于 `preload`。前者是排队, 后者是提前发现资源, 常常一起用但不可互换。
- 认为 `low` 会导致资源不加载。它只降低排位, 资源最终仍会加载。
- 认为各浏览器行为一致。`fetchpriority` 的影响程度完全由浏览器决定, 不同引擎的调度策略并不相同, 应以目标用户的主要浏览器为基准测试。
- 给所有图片都加 `high`。这等于没有信号, 还会损害原本由浏览器正确判断的资源顺序。

## 九、何时不该用

- 没有明确的性能问题或业务语义时。浏览器默认模型已经过长期优化, 无依据的覆盖可能反而降低性能。
- 页面瓶颈不在资源竞争时。若 LCP 受 TTFB、字体阻塞、渲染主线程长任务拖累, 调整 `fetchpriority` 收效甚微, 应先处理真正的瓶颈。
- 试图用它替代掉正确的基础优化时。图片未压缩、未设置尺寸、脚本未拆分、关键 CSS 未内联等问题, 不是优先级提示能解决的。
- 元素不受支持时。对 `<iframe>`、`<video>` 等元素设置该属性没有意义。

## 十、小结

Priority Hints 是一个小而精确的工具: 用 `high`/`low`/`auto` 三个信号, 在浏览器默认模型之上补充业务语义。合理的使用方式是:

- 只给真正关键的少数资源标 `high` (通常一个页面 1 到 3 个), 重点是 LCP 元素。
- 把第三方脚本、首屏以下图片、预取资源标 `low`, 首屏以下图片同时用 `loading="lazy"`。
- 用 `preload` 解决"发现太晚", 用 `fetchpriority` 解决"排位靠后", 二者配合而非替代。
- 大部分资源保持 `auto`。每加一个标记都应有可度量的理由, 并在慢速网络下用 DevTools 与字段数据验证。
