---
title: "代码题：手写虚拟滚动（窗口计算）"
description: "零依赖可运行的虚拟滚动窗口计算实现与自测: 定高列表的 startIndex/endIndex/offsetY/totalHeight 纯函数计算、overscan、渲染数与总量无关, 延伸动态高度 measureElement、贴底滚动, 对照 yukino-chat/yukino-chatbot 的 TanStack Virtual 落地"
---

零依赖、可直接 `node` 运行的代码题参考实现。先澄清虚拟滚动解决什么问题（以及它不解决什么），再给窗口计算的纯函数实现、自测与生产延伸。

:::note 运行方式
本文代码零依赖、可直接用 `node` 执行，自测输出 `ALL PASS`。
:::

## 题目

> 手写虚拟滚动（Virtual Scroll）的核心：给定滚动位置、视口高度、条目总数与条目高度，计算**当前应渲染哪些条目**（起止下标、偏移、总高度），让 DOM 只渲染可见区域。

## 开口先澄清语义（必拿分）

虚拟滚动是长列表性能的标准解法，但有一个**最容易被答错的认知**，采分点就在澄清它：

| 认知                       | 正解                                                                        |
| -------------------------- | --------------------------------------------------------------------------- |
| 「虚拟滚动让列表加载更快」 | ✗ 它**只减少 DOM 节点数**，不减少数据量                                     |
| 「虚拟滚动减少传输量」     | ✗ 传输量靠**服务端分页 + 字段裁剪**，虚拟滚动管的是「已拿到的数据如何渲染」 |
| 「虚拟滚动减少内存」       | ✗ 数据仍全在内存，它省的是 **DOM 节点的创建/布局/绘制成本**                 |

**虚拟滚动的本质**：列表有 N 条数据，但任意时刻视口只能看到 ~10 条，那就只渲染这 ~10 条（加上下少量 overscan），用一个撑开总高度的占位元素保证滚动条正确，渲染窗口随滚动平移。DOM 节点数从 O(N) 降到 O(视口可见数)。

## 核心结构：spacer + translated window

```text
外层容器 (overflow: auto, 固定高度, 监听 scroll)
└── 占位元素 (height = totalHeight, 撑开滚动条)
    └── 渲染窗口 (transform: translateY(offsetY), 只含 start..end 的条目)
```

- **占位元素**高度 = `itemCount × itemHeight`，让滚动条反映真实总高度。
- **渲染窗口**只包含 `[startIndex, endIndex]` 的条目，用 `translateY(offsetY)` 平移到正确的视觉位置。
- 滚动时重算 `startIndex/endIndex/offsetY`，React 只 diff 这一小段。

## 主实现 · 窗口计算（纯函数，可测）

```js
// 定高虚拟滚动的窗口计算
function computeVirtualWindow({
  scrollTop,
  viewportHeight,
  itemCount,
  itemHeight,
  overscan = 3, // 上下各多渲染几条, 避免快速滚动露白
}) {
  if (itemCount <= 0)
    return {
      startIndex: 0,
      endIndex: -1,
      offsetY: 0,
      totalHeight: 0,
      rendered: 0,
    };

  const firstVisible = Math.floor(scrollTop / itemHeight); // 视口顶部第一条
  const visibleCount = Math.ceil(viewportHeight / itemHeight); // 视口能容纳几条

  const startIndex = Math.max(0, firstVisible - overscan);
  const endIndex = Math.min(
    itemCount - 1,
    firstVisible + visibleCount + overscan,
  );

  return {
    startIndex,
    endIndex,
    offsetY: startIndex * itemHeight, // 渲染窗口相对列表顶部的偏移
    totalHeight: itemCount * itemHeight, // 撑开滚动条的总高度
    rendered: endIndex - startIndex + 1,
  };
}
```

三个要点：① **`overscan`**（上下各多渲染几条）避免快速滚动时露白，代价是多渲染几个节点；② **`startIndex`/`endIndex` 都要 clamp**（`Math.max(0, ...)` / `Math.min(itemCount-1, ...)`），防止越界；③ **渲染数与总量无关**——1000 条和 100000 条，同视口渲染的节点数相同，这正是虚拟滚动的价值。

## 自测（输出 ALL PASS）

```js
function assert(cond, msg) {
  if (!cond) throw new Error("FAIL: " + msg);
}

// 1. 顶部: startIndex=0, 渲染 可见数+overscan
{
  const w = computeVirtualWindow({
    scrollTop: 0,
    viewportHeight: 500,
    itemCount: 1000,
    itemHeight: 50,
    overscan: 3,
  });
  assert(
    w.startIndex === 0 &&
      w.endIndex === 13 &&
      w.offsetY === 0 &&
      w.totalHeight === 50000 &&
      w.rendered === 14,
    "顶部 " + JSON.stringify(w),
  );
}
// 2. 滚动到 1000: firstVisible=20, start=17, end=33, offsetY=850
{
  const w = computeVirtualWindow({
    scrollTop: 1000,
    viewportHeight: 500,
    itemCount: 1000,
    itemHeight: 50,
    overscan: 3,
  });
  assert(
    w.startIndex === 17 && w.endIndex === 33 && w.offsetY === 850,
    "滚动 " + JSON.stringify(w),
  );
}
// 3. 接近底部: endIndex 不超过 itemCount-1
{
  const w = computeVirtualWindow({
    scrollTop: 49500,
    viewportHeight: 500,
    itemCount: 1000,
    itemHeight: 50,
    overscan: 3,
  });
  assert(
    w.endIndex === 999 && w.startIndex <= 999,
    "底部 " + JSON.stringify(w),
  );
}
// 4. 条目很少: endIndex 封顶
{
  const w = computeVirtualWindow({
    scrollTop: 0,
    viewportHeight: 500,
    itemCount: 5,
    itemHeight: 50,
    overscan: 3,
  });
  assert(
    w.startIndex === 0 && w.endIndex === 4 && w.rendered === 5,
    "少量 " + JSON.stringify(w),
  );
}
// 5. 空列表
{
  const w = computeVirtualWindow({
    scrollTop: 0,
    viewportHeight: 500,
    itemCount: 0,
    itemHeight: 50,
  });
  assert(
    w.startIndex === 0 &&
      w.endIndex === -1 &&
      w.rendered === 0 &&
      w.totalHeight === 0,
    "空列表",
  );
}
// 6. 渲染数量恒定 (与总量无关)
{
  const a = computeVirtualWindow({
    scrollTop: 5000,
    viewportHeight: 500,
    itemCount: 1000,
    itemHeight: 50,
    overscan: 3,
  });
  const b = computeVirtualWindow({
    scrollTop: 5000,
    viewportHeight: 500,
    itemCount: 100000,
    itemHeight: 50,
    overscan: 3,
  });
  assert(a.rendered === b.rendered, "渲染数与总量无关");
}
// 7. overscan=0: 只渲染可见
{
  const w = computeVirtualWindow({
    scrollTop: 0,
    viewportHeight: 500,
    itemCount: 1000,
    itemHeight: 50,
    overscan: 0,
  });
  assert(
    w.startIndex === 0 && w.endIndex === 10 && w.rendered === 11,
    "overscan=0 " + JSON.stringify(w),
  );
}

console.log("ALL PASS");
```

## 生产延伸

### 1. 动态高度：measureElement + 位置缓存

定高是理想情况，真实列表条目高度不一（聊天气泡、富文本）。动态高度的做法：① 先用**估算高度**算初始窗口；② 条目渲染后用 `ResizeObserver` / `measureElement` 测真实高度，写进**位置缓存**（每条目 `{ top, height }` 的前缀和）；③ 用前缀和二分查找 `scrollTop` 落在哪个条目。TanStack Virtual 的 `estimateSize` + `measureElement` 就是这套。代价是要处理「测量后总高度变化导致滚动跳动」。

### 2. 聊天列表的贴底滚动

聊天场景（最新消息在底部）的虚拟滚动还要处理**贴底**：新消息到来时，若用户已贴底则自动滚到底，若用户在翻阅历史则不打扰。实现是「近底检测」（`scrollHeight - scrollTop - clientHeight < 阈值`）+ `ResizeObserver` 监听内容高度变化（流式输出会让气泡增高）。yukino-chat 的消息列表正是这套（见 [AI 流式前端专题](/interview/qa/ai-streaming-ui)）。

### 3. 与项目经验的连接

- **yukino-chat 消息列表**：用 TanStack Virtual（`@tanstack/react-virtual`）窗口化渲染消息，`estimateSize` 估算 + `measureElement` 实测，配合贴底滚动与流式气泡增高。
- **yukino-chatbot**：长会话历史用虚拟滚动 + React.memo 隔离已定型消息，流式期间只有尾部气泡渲染。
- **管理后台长表**：yukino-chat 的管理端用户表用虚拟化 + spacer 行保持真实表格语义（见 yukino-chat 题库）。
- **与分页的分工**：虚拟滚动管「已加载数据的渲染」，服务端分页管「按需拉取数据」——长列表通常两者结合（分页拉数据 + 虚拟滚动渲染当前页）。

面试时能把「手写虚拟滚动」上升到「只减 DOM 不减传输、定高 vs 动态高度 measureElement、overscan 权衡、贴底滚动、与分页的分工」，并从「DOM 节点数 O(N)→O(视口)」讲清价值，就是从「背概念」到「懂渲染性能」的分水岭。

---

**延伸阅读**

- [AI 流式前端专题题库](/interview/qa/ai-streaming-ui)：聊天列表贴底滚动、流式气泡增高与虚拟滚动的配合。
- [React 与浏览器题库](/interview/qa/react-and-browser)：reconciliation、memo、ResizeObserver、渲染性能。
- [Yukino Chat 自托管 IM 与内嵌 Agent 项目深挖题库](/interview/qa/yukino-chat-project)：消息列表虚拟化的真实落地（TanStack Virtual + 贴底滚动）。
- [防抖与节流](/interview/code/debounce-throttle)：滚动事件的高频处理（rAF 帧级节流）。
- [前端工程化题库](/interview/qa/frontend-engineering)：长列表性能与渲染优化的工程视角。
