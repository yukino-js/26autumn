---
title: "fetchpriority 资源优先级调度与 SWR: 从 Priority Hints 到 stale-while-revalidate 的两层含义"
description: '上篇讲清 fetchpriority 属性的语义与取值、浏览器内置的资源优先级模型、它在预加载与首屏优化中的正确用法与度量; 下篇讲 SWR 的两层含义: RFC 5861 定义的 stale-while-revalidate 与 stale-if-error 缓存扩展指令的精确语义与 CDN 生态, 以及前端"先返回缓存、再后台重新验证"的数据获取模式 (手写 SWR 与 TanStack Query 对照)。'
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

`fetchpriority` 以 Firefox 132 (2024-10) 为最晚落地引擎, 在 2024 年 10 月进入 Baseline "newly available", 按 30 个月规则将于 2027 年 4 月转为 "widely available"。各主流引擎的起始支持版本:

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

---

标题里的 SWR 还有第二层含义, 而且与优先级调度在同一个问题上交汇: 数据请求的调度与新鲜度。下篇从 HTTP 缓存指令讲到前端数据获取模式。

# 下篇: SWR (stale-while-revalidate)

SWR 这个名字同时指两件事: HTTP 缓存层的 `stale-while-revalidate` 响应指令 (RFC 5861 定义, 运行在浏览器与 CDN 的 HTTP 缓存里), 以及前端数据获取层的 "先返回缓存立即渲染, 再后台重新验证" 模式 (运行在应用自己的缓存里)。两者同名, 是因为它们描述同一个取舍: 宁可先给旧数据, 也不让用户等待, 旧数据在后台被悄悄换成新的。

## 十一、HTTP 层的 SWR: 缓存扩展指令

### 11.1 RFC 9111 的新鲜度模型是前提

HTTP 缓存的基线行为由 RFC 9111 定义: 一个可缓存的响应在"新鲜生命周期"内可以直接返回, 过期 (stale) 之后原则上必须通过条件请求重新验证 (`ETag` 配 `If-None-Match`, 或 `Last-Modified` 配 `If-Modified-Since`)。新鲜时长由 `max-age` 决定 (`Expires` 头在 `max-age` 存在时被忽略); 对共享缓存, `s-maxage` 进一步覆盖 `max-age` 与 `Expires`。两条关键约束:

- `must-revalidate`、`proxy-revalidate` 与 `s-maxage` 都禁止共享缓存在验证成功之前返回过期响应。对这些响应, 不存在"先给旧数据"的余地。
- RFC 9111 规定, 缓存只有在断网, 或得到客户端/源站显式许可时才允许返回过期响应; RFC 5861 的两条扩展指令正是这种"显式许可"的标准化形式。

RFC 9111 同时规定了扩展指令的命名空间: 缓存必须忽略不认识的 Cache-Control 指令。因此 `stale-while-revalidate` 与 `stale-if-error` 天然渐进增强——不支持的实现直接忽略, 行为退回纯 `max-age` 语义。

### 11.2 stale-while-revalidate: 过期窗口内的异步重验证

```
Cache-Control: max-age=600, stale-while-revalidate=30
```

语义按时间轴分三段:

| 阶段     | 区间         | 缓存行为                                             |
| -------- | ------------ | ---------------------------------------------------- |
| fresh    | 0 至 600s    | 直接返回缓存, 不发任何请求                           |
| SWR 窗口 | 600s 至 630s | 立即返回过期缓存, 同时异步发起重新验证, 客户端不等待 |
| 窗口外   | 630s 之后    | 停止特殊优待, 下一个请求被阻塞, 走正常的同步验证     |

三个精确要点:

- 重验证成功后, 响应重新变为 fresh, 时间轴归零, 对客户端而言这段过期期完全不可见——验证延迟被藏在了窗口内。
- 窗口外的行为是"退化", 不是"报错": 缓存只是不再享受异步特权, 阻塞式验证是 RFC 9111 的标准流程。
- 异步验证只有请求落在窗口内才会被触发。缓存不应在无请求时主动验证 (RFC 5861 的安全考量是防止放大攻击), 所以低流量资源的窗口可能始终没有机会被使用。

### 11.3 stale-if-error: 出错时容忍旧数据

```
Cache-Control: max-age=600, stale-if-error=1200
```

当缓存为获取或验证响应而遇到错误时, 允许用过期的旧响应顶上, 而不是把硬错误抛给客户端。这里的"错误"有明确边界: 指导致 500、502、503、504 这四类状态码的情况 (源站报错、上游不可达、DNS 失败等)。值的含义是陈旧度的上限: 旧响应的 Age 超过 `max-age` 加 `stale-if-error` 之和后, 必须把真实的错误响应原样返回。

两个补充:

- 它也可以写在请求的 Cache-Control 里, 作用域仅限该请求; 但各浏览器目前都不支持请求侧的用法。
- 它不改变新鲜度语义: 被拿来应急的响应仍是过期的, 带有非零的 `Age` 头, 缓存应如实暴露陈旧。

### 11.4 CDN 与代理生态

两条指令的主要价值在共享缓存侧, 各生态的实现程度:

| 生态              | stale-while-revalidate                                  | stale-if-error |
| ----------------- | ------------------------------------------------------- | -------------- |
| Fastly            | 支持, 并可通过请求配置扩展窗口                          | 支持           |
| Cloudflare        | 支持                                                    | 支持           |
| Akamai 等商业 CDN | 支持 (各家配置项名称不同)                               | 支持           |
| Varnish           | 4.0 起识别两条指令                                      | 同左           |
| Squid             | 支持 stale-while-revalidate                             | 不识别         |
| Nginx (开源版)    | 不识别响应指令, 用 `proxy_cache_use_stale` 配置等价行为 | 同左           |
| 浏览器            | Chrome 曾短暂实现后移除; Firefox、Safari 未实现         | 均未实现       |

浏览器侧现状意味着: 指令带来的收益基本由 CDN 兑现; 浏览器按 RFC 9111 的要求忽略不认识的指令, 无兼容风险, 但也享受不到浏览器私有缓存的 SWR 行为。这也是前端 SWR 模式 (见十三节) 在应用层重新实现同一取舍的动机之一。

### 11.5 典型 Cache-Control 组合

| 组合                                                           | 适用对象                                                         |
| -------------------------------------------------------------- | ---------------------------------------------------------------- |
| `max-age=604800, stale-while-revalidate=86400`                 | 带内容哈希的静态资源: 一周内免验证, 过期后一天内异步更新         |
| `max-age=60, stale-while-revalidate=600, stale-if-error=86400` | 公共读接口: 一分钟新鲜, 十分钟异步刷新窗口, 出错时旧数据兜底一天 |
| `s-maxage=60, stale-while-revalidate=600, private`             | CDN 只缓存一分钟, 浏览器私有缓存可继续享受 SWR 窗口              |

注意两点: 其一, 服务端要按 `max-age` 与 `stale-while-revalidate` 之和评估最坏情况——两个值都设 600 意味着必须容忍响应最多被缓存 20 分钟; 其二, `s-maxage` 自带 must-revalidate 语义, 共享缓存对带 `s-maxage` 的响应过期后必须先验证, 因此把过长的 SWR 窗口与 `s-maxage` 同用时, 实际生效的宽松程度以具体 CDN 的实现为准。

### 11.6 适用与不适用

适合:

- 变化频率低、最终一致即可的内容: 商品详情、配置、字典数据、静态化 JSON。
- 读多写少的公共资源: 窗口内的异步验证把回源压力摊薄, 同时多数请求的延迟被完全隐藏。
- 作为可用性兜底: `stale-if-error` 让源站短暂故障 (发布、抖动) 不直接转化为用户可见的 5xx。

不适合:

| 场景         | 原因                                                              | 对策                                           |
| ------------ | ----------------------------------------------------------------- | ---------------------------------------------- |
| 个性化内容   | 响应因人而异, 过期副本可能把 A 的数据发给 B, 且共享缓存本就不该存 | `private` 或 `no-store`, 配合短 `max-age`      |
| 强一致性读   | 余额、库存、权限这类数据, 旧值可能导致错误业务决策                | `must-revalidate` 或不缓存                     |
| 写后立即读   | 提交后立刻看到旧数据是显性体验 bug                                | 短 `max-age`、`s-maxage=0`, 或在应用层主动失效 |
| 安全敏感响应 | 撤销、封禁类数据的过期使用是安全漏洞                              | `must-revalidate` 或 `no-cache`                |

一句话: SWR 是拿一致性换延迟的旋钮, 前提是业务能容忍短暂旧数据; 容忍度为零的读路径不要用。

## 十二、前端数据获取模式的 SWR

### 12.1 模式的定义与收益

HTTP 层的 SWR 由缓存在响应链路里自动执行; 前端层的 SWR 是应用代码里的显式策略, 流程固定为三步:

1. 读取时若缓存里有数据, 立即用它渲染, 不等待网络。
2. 同时 (或紧随其后) 发起后台重新验证请求。
3. 新数据返回后替换缓存, 界面就地更新。

收益是消除了"请求往返期间界面空白": 没有骨架屏等待, 二次进入页面瞬间有数据。代价与 HTTP 层一致——首次渲染的数据可能是旧的, 且必须接受"后台刷新可能失败或更晚到达"。这个模式成立的前提与十一节相同: 数据允许短暂陈旧。

### 12.2 手写 SWR: 三个能力

仓库内的手写 SWR 方案 ([前端监控与数据请求工程实践](../docs/data) 中有完整实现) 用约 155 行核心代码提供三个能力, 恰好是 SWR 模式的最小集合:

| 能力                   | 实现要点                                                                                        |
| ---------------------- | ----------------------------------------------------------------------------------------------- |
| 预加载                 | 内联脚本在 HTML 解析阶段发起请求, 早于框架 bundle 下载完成; promise 先入缓存, 结果后补          |
| 去重                   | 缓存条目同时持有 promise 与 result 两个锚点; 在途时多个消费方共享同一个 promise, 天然不重复请求 |
| stale-while-revalidate | result 已就绪时立即返回旧数据 (耗时接近 0), 同时后台静默重新验证, 新数据回来后更新缓存          |

消费侧按 "result 命中 -> promise 复用 -> 冷启动重建" 三级降级, 任何接入状态下都能正确工作。它与 HTTP 层 SWR 的结构对应关系是直接的: "result 命中" 对应 fresh 期直接返回, "后台静默重新验证" 对应 SWR 窗口内的异步验证; 区别在于它没有窗口参数, 采用"每次命中都后台刷新"的激进策略, 适合分钟级以下变化的低频数据。

### 12.3 与 TanStack Query v5 缓存模型的对照

[TanStack Query](tanstack) 是通用服务端状态库, 其默认策略就是 SWR: 一条数据可以同时"已过期"和"仍在缓存中", 此时组件挂载先用旧数据渲染, 同时后台重取, 完成后原地替换——官方称之为"缓存优先、后台刷新"。与手写方案的差异在工程覆盖面:

| 维度       | 手写 SWR                                                        | TanStack Query v5                                                          |
| ---------- | --------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 缓存结构   | 全局 Map, 条目含 promise / result / timestamp                   | QueryCache 按 queryHash 存 Query, key 经确定性哈希 (对象键排序)            |
| 新鲜度判定 | 无 TTL, 每次命中都后台刷新                                      | `staleTime` 参数化: 过期只是"允许重取", 触发时机是挂载、窗口聚焦、网络重连 |
| 失效控制   | 无主动失效 (TTL、主动失效、按 key 过期策略是几十行内的演进方向) | `invalidateQueries` 前缀匹配 + 写后直写 + 乐观更新回滚                     |
| 请求去重   | promise 在途复用                                                | 相同 queryKey 共享同一 Query 实例与在途请求                                |
| 预加载     | 内联脚本, 早于 bundle                                           | `queryClient.query` / `usePrefetchQuery`, 运行在 bundle 内                 |
| 失败处理   | 后台刷新失败保留旧数据, 下次消费再重试                          | `retry` / `retryDelay` 指数退避, 离线 `paused` 挂起                        |
| 能力覆盖   | 刻意只做三件事                                                  | 分页、无限滚动、SSR 水合、持久化等完整能力                                 |

最关键的分野仍是预加载时机: 手写方案把请求发起点提前到 HTML 解析阶段的内联脚本, 此时 bundle 还在下载, 网络请求与脚本加载并行——任何运行在 bundle 内部的库都无法利用这个时间窗口, 因为库本身就是 bundle 的一部分。库的预取最早也只能在应用初始化后触发。这正是 MPA 多页、老新框架共存的存量项目选择手写方案的决策点; 新项目若需要失效、写后同步、分页等能力, TanStack Query 的成熟度则是净收益。

## 十三、交叉点: 后台重新验证请求的优先级

上篇的 `fetchpriority` 与下篇的 SWR 在一处相遇: 后台重新验证发起的请求, 用户看不见、不阻塞交互, 正适合标记低优先级。

```js
// SWR 的后台重新验证: 用户已在渲染旧数据, 这个请求不与任何等待竞争
await fetch("/api/selector-options", { priority: "low" });
```

三个要点:

- 浏览器缓存层面, `stale-while-revalidate` 触发的验证请求由浏览器/CDN 自行调度, 开发者无法也不应干预其优先级; 应用层面, SWR 的重新验证请求走 `fetch()`, `priority` 选项完全可控。
- `low` 只改变排队顺序, 不取消请求, 也不会"导致不加载" (上篇误区之一); 但验证请求被压得越久, 缓存里停留的旧数据就越久。对带 TTL 或激进刷新的实现, 要确保低优先级不至于让重新验证长期完不成, 最终把用户拖入一次同步等待。
- 服务端视角的对应建议同 RFC 5861: 重新验证应以"有消费触发"为前提, 不做无请求的主动全量预热, 避免请求放大。

## 十四、两层 SWR 的对照小结

| 维度       | HTTP 层的 SWR                     | 前端层的 SWR                                           |
| ---------- | --------------------------------- | ------------------------------------------------------ |
| 定义来源   | RFC 5861 (RFC 9111 的扩展指令)    | 应用层数据获取模式, 以 swr / TanStack Query 等库为代表 |
| 声明方式   | 服务端 `Cache-Control` 响应指令   | 应用代码策略 (TTL / staleTime / 每次命中刷新)          |
| 生效位置   | 浏览器 HTTP 缓存与 CDN/代理       | 应用自己的内存缓存 (Map / QueryCache)                  |
| 新鲜度旋钮 | `max-age` + SWR 窗口秒数          | staleTime / 过期策略                                   |
| 触发重验证 | 请求落在窗口内                    | 组件挂载、窗口聚焦、主动失效                           |
| 失败兜底   | `stale-if-error` 按秒数容忍旧数据 | 保留旧数据, 下次消费重试                               |

两层的哲学完全一致: 拿一致性换延迟, 把重新验证藏到用户感知之外; 差异只在生效位置与调参方式。而 `fetchpriority` 恰好为前端层的后台重取请求提供了调度信号——让"看不见的请求"排在"看得见的请求"后面。
