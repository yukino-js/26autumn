---
title: "Priority Hints 与 Fetch Priority API 教程"
---

## 1. 概述

Priority Hints 是一项 Web 平台特性, 允许开发者向浏览器传达资源的相对重要性, 从而影响浏览器获取资源的优先顺序. 该特性最初以 `importance` 属性的形式提出, 经过标准化演进, 最终以 Fetch Priority API 的形式落地, 使用 `fetchpriority` 作为属性名.

它解决的核心问题是: 浏览器内置的优先级模型是通用的, 无法感知具体页面的业务语义. 例如, 浏览器不知道哪张图片是首屏主视觉、哪个脚本是交互关键路径. 通过 Priority Hints, 开发者可以把这些业务层面的知识传递给浏览器, 让资源调度更贴合实际体验需求.

需要强调的是, 这只是一个"提示" (hint) , 浏览器不保证严格遵循. 最终的调度决策仍由浏览器根据网络状况、资源类型、渲染需求等综合因素做出.

---

## 2. 浏览器默认优先级模型

在理解 Priority Hints 之前, 先了解浏览器默认如何排列资源优先级.

以 Chrome 为例, 资源被分为以下几个优先级层级 (从高到低) :

| 优先级  | 典型资源                                                            |
| ------- | ------------------------------------------------------------------- |
| Highest | 主 HTML 文档、关键 CSS (阻塞渲染的样式表)、字体 (`@font-face` 引用) |
| High    | 同步脚本、`<img>` 在视口内时                                        |
| Medium  | 较晚发现的 CSS 与脚本、部分图片                                     |
| Low     | `async` / `defer` 脚本、视口外的图片、音视频资源                    |
| Lowest  | `prefetch` 资源                                                     |

这个模型在大多数情况下运作良好, 但存在局限:

- 所有同类型资源被赋予相同优先级, 无法区分"首屏主图"和"第三屏缩略图"
- 第三方脚本 (广告、分析) 可能与关键业务脚本竞争带宽
- 开发者无法在 `preload` 场景中表达"这个预加载比那个更紧急"

Priority Hints 正是为了在这些场景中提供细粒度控制.

---

## 3. 基本语法

### 3.1 HTML 属性形式

在支持 `fetchpriority` 的 HTML 元素上添加属性:

```html
<img src="photo.webp" fetchpriority="high" />
<img src="thumbnail.webp" fetchpriority="low" />
<img src="normal.webp" fetchpriority="auto" />
```

可选值:

- `high` — 提示浏览器提升该资源的获取优先级
- `low` — 提示浏览器降低该资源的获取优先级
- `auto` — 默认值, 表示不干预浏览器的默认决策

属性值不区分大小写. 如果属性值无效或缺失, 等同于 `auto`.

### 3.2 JavaScript fetch() 形式

在 `fetch()` 的 `init` 参数中传入 `priority` 字段:

```js
const response = await fetch("/api/critical-data", {
  priority: "high",
});

const analytics = await fetch("/api/analytics-beacon", {
  priority: "low",
});

// 不传 priority 等同于 'auto'
const normal = await fetch("/api/page-content");
```

注意: HTML 属性名是 `fetchpriority`, 而 JS API 中的字段名是 `priority`.

### 3.3 支持的 HTML 元素

`fetchpriority` 属性可用于以下元素:

- `<img>` — 图片资源
- `<link>` — 预加载 (preload) 、预取 (prefetch) 、样式表等
- `<script>` — 脚本资源

注意: `<iframe>` 不支持 `fetchpriority`. 该属性在 HTML 规范中只定义于 `img`、`link`、`script` 三个元素 (早期 Priority Hints 提案 (importance 属性) 曾覆盖 iframe, 最终标准未纳入) , 主流浏览器均未实现 iframe 上的 fetchpriority.

---

## 4. 实际应用场景

### 4.1 提升 LCP 图片优先级

LCP (Largest Contentful Paint) 是 Core Web Vitals 指标之一. 如果 LCP 元素是一张图片, 提升其优先级可以缩短 LCP 时间:

```html
<!-- 首屏主视觉图片 -->
<img
  src="/images/hero-banner.webp"
  fetchpriority="high"
  alt="产品主视觉"
  width="1200"
  height="600"
/>
```

配合 `preload` 使用效果更佳, 尤其是当图片 URL 需要运行时才能确定时:

```html
<link
  rel="preload"
  as="image"
  href="/images/hero-banner.webp"
  fetchpriority="high"
/>
```

如果图片在 CSS `background-image` 中定义, 浏览器发现它的时机较晚 (需要先下载并解析 CSS) , 此时用 `preload` + `fetchpriority="high"` 可以显著提前加载:

```html
<link
  rel="preload"
  as="image"
  href="/images/css-background-hero.webp"
  fetchpriority="high"
/>
```

### 4.2 降低非关键图片优先级

页面中首屏以下的图片、缩略图、装饰性图片等, 可以降低优先级以避免与关键资源争抢带宽:

```html
<!-- 首屏以下的图片 -->
<img src="/images/section-2-photo.webp" fetchpriority="low" loading="lazy" />

<!-- 缩略图列表 -->
<img src="/thumbs/item-01.webp" fetchpriority="low" width="80" height="80" />
```

`fetchpriority="low"` 与 `loading="lazy"` 可以组合使用. `loading="lazy"` 控制的是"何时开始加载" (进入视口附近才加载) , `fetchpriority` 控制的是"加载时的优先级" (一旦开始加载, 在队列中的排位) . 两者解决不同层面的问题, 互不冲突.

### 4.3 控制脚本优先级

```html
<!-- 关键交互脚本, 提升优先级 -->
<script src="/js/app-core.js" fetchpriority="high"></script>

<!-- 第三方分析脚本, 降低优先级 -->
<script
  src="https://analytics.example.com/tracker.js"
  fetchpriority="low"
  async
></script>

<!-- 广告脚本, 降低优先级 -->
<script
  src="https://ads.example.com/widget.js"
  fetchpriority="low"
  async
></script>
```

典型场景: 页面依赖一个核心 JS 文件来渲染交互界面, 同时还需要加载若干第三方脚本 (分析、广告、客服聊天) . 将第三方脚本标记为 `low`, 可以让浏览器优先下载和执行核心脚本.

### 4.4 预加载与预取的优先级控制

```html
<!-- 预加载当前页面的关键字体 -->
<link
  rel="preload"
  as="font"
  type="font/woff2"
  href="/fonts/main.woff2"
  crossorigin
  fetchpriority="high"
/>

<!-- 预加载当前页面的关键数据 -->
<link
  rel="preload"
  as="fetch"
  href="/api/page-config.json"
  fetchpriority="high"
  crossorigin
/>

<!-- 预取下一页面的资源, 降低优先级避免影响当前页面 -->
<link rel="prefetch" href="/next-page/bundle.js" fetchpriority="low" />
<link rel="prefetch" href="/next-page/data.json" fetchpriority="low" />
```

`prefetch` 本身就是低优先级行为 (利用空闲带宽提前获取未来可能需要的资源) , 加上 `fetchpriority="low"` 是双重保障, 确保它不会在当前页面资源紧张时抢占带宽.

### 4.5 iframe 优先级

`<iframe>` 不支持 `fetchpriority`: 该属性只定义在 `img`、`link`、`script` 上, 早期 Priority Hints 提案 (importance 属性) 曾覆盖 iframe, 最终标准未纳入, 主流浏览器也没有实现. 对非关键 iframe (如社交媒体嵌入) , 可改用 `loading="lazy"` 延迟加载或在需要时再动态插入; 对关键 iframe (如支付组件) , 将其放在 HTML 靠前位置并减少前置的阻塞资源即可.

### 4.6 动态 fetch 请求的优先级

```js
// 用户搜索建议 — 高优先级, 用户正在等待
async function fetchSuggestions(query) {
  const res = await fetch(`/api/suggestions?q=${encodeURIComponent(query)}`, {
    priority: "high",
    signal: abortController.signal,
  });
  return res.json();
}

// 后台数据同步 — 低优先级, 不阻塞用户操作
async function syncTelemetry(payload) {
  await fetch("/api/telemetry", {
    method: "POST",
    priority: "low",
    body: JSON.stringify(payload),
    headers: { "Content-Type": "application/json" },
    keepalive: true,
  });
}

// 预取下一页数据 — 低优先级
async function prefetchNextPage(pageId) {
  const res = await fetch(`/api/pages/${pageId}`, {
    priority: "low",
  });
  const data = await res.json();
  cache.set(pageId, data);
}
```

---

## 5. 与相关特性的关系

### 5.1 与 loading="lazy" 的区别

| 维度     | `loading="lazy"`     | `fetchpriority`               |
| -------- | -------------------- | ----------------------------- |
| 控制层面 | 何时发起请求         | 请求在队列中的优先级          |
| 作用时机 | 资源进入视口前不加载 | 资源开始加载后影响调度        |
| 适用元素 | `<img>`, `<iframe>`  | `<img>`, `<link>`, `<script>` |
| 可组合   | 是                   | 是                            |

两者正交, 可以组合: `loading="lazy" fetchpriority="low"` 表示"晚点再加载, 加载时也排后面".

### 5.2 与 preload / prefetch / preconnect 的配合

- `preload`: 告诉浏览器"这个资源当前页面一定会用到, 尽早获取". 配合 `fetchpriority="high"` 可以在多个 preload 之间建立优先级梯度.
- `prefetch`: 告诉浏览器"这个资源未来可能用到, 空闲时获取". 配合 `fetchpriority="low"` 进一步确保不影响当前页面.
- `preconnect`: 提前建立 TCP/TLS 连接, 与 `fetchpriority` 无直接关系, 但可以配合使用.

### 5.3 与 HTTP 优先级 (Extensible Priorities, RFC 9218) 的关系

HTTP/2 和 HTTP/3 协议层也有优先级机制 (Stream Priorities / Extensible Priorities) . 浏览器的资源优先级调度最终会映射到协议层的流优先级. `fetchpriority` 是应用层的开发者信号, 它影响浏览器内部的调度决策, 浏览器再据此设置协议层的优先级参数. 开发者通常不需要直接操作协议层优先级.

---

## 6. 性能度量与验证

### 6.1 使用 Chrome DevTools

在 Chrome DevTools 的 Network 面板中:

1. 打开 Network 面板, 刷新页面
2. 右键点击列标题, 勾选 "Priority" 列
3. 观察每个资源的 Priority 值 (Highest / High / Medium / Low / Lowest)
4. 对比添加 `fetchpriority` 前后的变化

在 Performance 面板中:

1. 录制一段加载过程
2. 在 Network 行中观察资源的瀑布图排列
3. 确认关键资源是否更早开始下载

### 6.2 使用 Lighthouse

Lighthouse 的 "Preload Largest Contentful Paint image" 审计项 (audit id 为 prioritize-lcp-image) 检测 LCP 图片是否因缺少 preload 而发现过晚, 并建议 preload 配合 fetchpriority 使用; 新版 Lighthouse 已以 Performance Insights (如 lcp-discovery-insight) 取代该独立审计项.

### 6.3 使用 PerformanceObserver 度量 LCP

```js
const observer = new PerformanceObserver((list) => {
  const entries = list.getEntries();
  const lastEntry = entries[entries.length - 1];
  console.log("LCP time:", lastEntry.startTime, "ms");
  console.log("LCP element:", lastEntry.element);
});

observer.observe({ type: "largest-contentful-paint", buffered: true });
```

### 6.4 使用 Resource Timing 分析

```js
const observer = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    if (entry.initiatorType === "img" || entry.initiatorType === "link") {
      console.log({
        name: entry.name,
        duration: entry.duration,
        startTime: entry.startTime,
        transferSize: entry.transferSize,
      });
    }
  }
});

observer.observe({ type: "resource", buffered: true });
```

通过对比关键资源的 `startTime` 和 `duration`, 可以验证优先级调整是否生效.

### 6.5 使用 web-vitals 库

```js
import { onLCP, onINP, onCLS } from "web-vitals";

onLCP((metric) => {
  console.log("LCP:", metric.value, "ms");
  // 上报到分析平台
  navigator.sendBeacon(
    "/analytics",
    JSON.stringify({
      name: "LCP",
      value: metric.value,
      id: metric.id,
    }),
  );
});
```

---

## 7. 浏览器兼容性

截至 2025 年的支持情况:

| 浏览器           | HTML `fetchpriority` | JS `fetch({ priority })` | 备注           |
| ---------------- | -------------------- | ------------------------ | -------------- |
| Chrome           | 101+                 | 101+                     | 完整支持       |
| Edge             | 101+                 | 101+                     | 与 Chrome 同步 |
| Firefox          | 132+                 | 132+                     | 较晚支持       |
| Safari           | 17.2+                | 17.2+                    | 部分行为差异   |
| Samsung Internet | 19+                  | 19+                      | —              |
| iOS Safari       | 17.2+                | 17.2+                    | —              |

对于不支持的浏览器, `fetchpriority` 属性会被静默忽略, 不会产生任何错误或副作用. JS 中传入 `priority` 字段在不支持的浏览器中同样被忽略. 因此这是一个天然渐进增强的特性, 无需 polyfill 或特性检测即可安全使用.

如果确实需要特性检测:

```js
// 检测 HTML 属性支持
const supportsFetchPriority = "fetchPriority" in HTMLImageElement.prototype;

// 检测 fetch priority 支持 (较复杂, 通常不需要)
```

---

## 8. 最佳实践

### 8.1 优先优化 LCP 资源

这是 `fetchpriority` 投入产出比最高的场景. 找到页面的 LCP 元素 (通常是首屏大图或标题文字) , 确保它以最高优先级加载:

```html
<img src="/hero.webp" fetchpriority="high" width="1200" height="630" alt="" />
```

### 8.2 不要滥用 high

如果所有资源都标记为 `high`, 等于没有标记. `high` 应该只用于真正关键的少数资源 (通常一个页面 1-3 个) . 其余非关键资源用 `low`, 大部分资源保持 `auto` 让浏览器自行决策.

### 8.3 降低第三方资源的优先级

第三方脚本 (分析、广告、社交插件) 通常不是用户体验的关键路径, 但它们往往体积大、数量多. 统一标记为 `low`:

```html
<script
  src="https://cdn.analytics.com/v3.js"
  async
  fetchpriority="low"
></script>
<script src="https://cdn.ads.com/loader.js" async fetchpriority="low"></script>
```

### 8.4 与 loading="lazy" 组合使用

对于首屏以下的图片, 同时使用两者:

```html
<img
  src="/gallery/photo-07.webp"
  loading="lazy"
  fetchpriority="low"
  width="400"
  height="300"
/>
```

### 8.5 在 preload 之间建立梯度

当页面有多个 preload 时, 用 `fetchpriority` 区分轻重缓急:

```html
<!-- 最关键: LCP 图片 -->
<link rel="preload" as="image" href="/hero.webp" fetchpriority="high" />

<!-- 次关键: 主字体 -->
<link rel="preload" as="font" href="/fonts/main.woff2" crossorigin />

<!-- 一般: 非关键数据 -->
<link
  rel="preload"
  as="fetch"
  href="/api/sidebar.json"
  fetchpriority="low"
  crossorigin
/>
```

### 8.6 避免与浏览器默认行为冲突

浏览器的默认优先级模型经过多年优化, 在大多数情况下是合理的. 只在有明确性能问题或明确业务需求时才覆盖默认值. 不必要的干预可能反而降低性能.

### 8.7 在真实网络条件下测试

优先级调整的效果在快速网络下不明显, 在慢速网络 (3G、弱 4G) 或高并发资源加载时效果显著. 测试时使用 Chrome DevTools 的 Network Throttling 模拟慢速网络.

---

## 9. 常见误区

### 误区一: fetchpriority 能加快资源下载速度

它不能改变带宽或服务器响应速度. 它改变的是多个并发请求之间的调度顺序. 如果页面只有一个资源需要加载, 设置 `high` 没有任何效果.

### 误区二: fetchpriority 等同于 preload

`preload` 改变的是资源被"发现"的时机 (提前告知浏览器这个资源的存在) , `fetchpriority` 改变的是资源在加载队列中的"排位". 两者解决不同问题, 经常配合使用但不可互相替代.

### 误区三: 设置 low 会导致资源不加载

`low` 只是降低优先级, 不是延迟或取消. 资源最终仍会加载, 只是在带宽竞争时排在后面. 如果网络空闲, `low` 资源照样立即下载.

### 误区四: 所有浏览器行为一致

不同浏览器对 `fetchpriority` 的实现细节有差异. Chrome 的实现最为成熟, Safari 和 Firefox 的调度策略可能不完全相同. 应以目标用户的主要浏览器为基准进行测试.

---

## 10. 完整示例: 电商首页优化

以下是一个电商首页的 HTML 片段, 展示如何综合运用 `fetchpriority`:

```html
<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>示例商城</title>

    <!-- 关键 CSS -->
    <link rel="stylesheet" href="/css/critical.css" />

    <!-- LCP 图片: 首屏主 Banner, 最高优先级 -->
    <link
      rel="preload"
      as="image"
      href="/images/summer-sale-banner.webp"
      fetchpriority="high"
    />

    <!-- 主字体 -->
    <link
      rel="preload"
      as="font"
      type="font/woff2"
      href="/fonts/brand.woff2"
      crossorigin
    />

    <!-- 预取商品分类页数据, 低优先级 -->
    <link rel="prefetch" href="/api/categories" fetchpriority="low" />
  </head>
  <body>
    <!-- 首屏主 Banner — LCP 元素 -->
    <img
      src="/images/summer-sale-banner.webp"
      fetchpriority="high"
      width="1440"
      height="480"
      alt="夏季促销主视觉"
    />

    <!-- 核心交互脚本 -->
    <script src="/js/app.js" fetchpriority="high"></script>

    <!-- 商品列表图片 — 正常优先级 -->
    <section class="products">
      <img src="/products/item-01.webp" width="300" height="300" alt="商品1" />
      <img src="/products/item-02.webp" width="300" height="300" alt="商品2" />
      <img src="/products/item-03.webp" width="300" height="300" alt="商品3" />
    </section>

    <!-- 首屏以下 — 懒加载 + 低优先级 -->
    <section class="recommendations">
      <img
        src="/recs/item-04.webp"
        loading="lazy"
        fetchpriority="low"
        width="200"
        height="200"
        alt="推荐1"
      />
      <img
        src="/recs/item-05.webp"
        loading="lazy"
        fetchpriority="low"
        width="200"
        height="200"
        alt="推荐2"
      />
      <img
        src="/recs/item-06.webp"
        loading="lazy"
        fetchpriority="low"
        width="200"
        height="200"
        alt="推荐3"
      />
    </section>

    <!-- 第三方脚本 — 全部低优先级 -->
    <script
      src="https://analytics.example.com/sdk.js"
      async
      fetchpriority="low"
    ></script>
    <script
      src="https://chat.example.com/widget.js"
      async
      fetchpriority="low"
    ></script>
    <script
      src="https://ads.example.com/pixel.js"
      async
      fetchpriority="low"
    ></script>
  </body>
</html>
```

这个示例的策略总结:

- 1 个 `high` 图片 (LCP Banner) + 1 个 `high` 脚本 (核心交互)
- 首屏以下图片用 `lazy` + `low` 组合
- 第三方脚本全部 `async` + `low`
- `prefetch` 资源标记 `low` 避免抢占当前页面带宽
- 大部分资源保持默认, 让浏览器自行调度

---

## 11. 规范与参考资源

- Fetch Priority 规范: https://fetch.spec.whatwg.org/#request-priority
- HTML 规范中的 fetchpriority 属性: https://html.spec.whatwg.org/multipage/urls-and-fetching.html#fetch-priority-attribute
- Chrome 开发者文档: https://developer.chrome.com/docs/devtools/network/reference
- web.dev 文章 "Optimize LCP": https://web.dev/articles/optimize-lcp
- web.dev 文章 "Fetch Priority": https://web.dev/articles/fetch-priority
- HTTP Extensible Priorities (RFC 9218): https://www.rfc-editor.org/rfc/rfc9218
