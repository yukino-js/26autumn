---
title: "代码题：JS 手写防抖与节流"
description: "零依赖可运行的 debounce / throttle 实现与自测：leading/trailing 双沿、cancel/flush、maxWait、时间戳与定时器组合、rAF 帧级节流，对照前端工程与监控 SDK 的真实用法"
---

零依赖、可直接 `node` 运行的代码题参考实现。先澄清防抖与节流的语义差异与双沿行为，再给主实现、对照实现、自测与生产延伸。

:::note 运行方式
本文代码零依赖、可直接用 `node`（ESM，顶层 await）执行，自测输出 `ALL PASS`。测试用真实定时器，等待留足余量避免抖动。
:::

## 题目

> 用 JS 手写 `debounce(fn, wait)` 与 `throttle(fn, wait)`，支持 `leading`/`trailing` 双沿触发、`cancel()` 取消与 `flush()` 立即执行。

## 开口先澄清语义（必拿分）

防抖与节流是面试高频题，但多数人只会背「防抖看结果、节流看过程」。真正的采分点是**双沿语义**与**边界 API**：

| 概念       | 防抖 debounce                                  | 节流 throttle                            |
| ---------- | ---------------------------------------------- | ---------------------------------------- |
| 核心语义   | 事件停止触发 `wait` 后才执行（**看最终状态**） | 每 `wait` 至多执行一次（**看过程节奏**） |
| 连续触发   | 不断推迟，只在最后一次后执行                   | 按固定节奏执行，不推迟                   |
| 典型场景   | 搜索框输入、窗口 resize 后重排、按钮防连点     | 滚动上报、鼠标移动、高频埋点             |
| `leading`  | 第一次触发立即执行                             | 第一次触发立即执行                       |
| `trailing` | 停止后执行最后一次（默认）                     | 节奏末尾补一次（默认）                   |

还要主动声明三个边界 API：**`cancel()`**（取消待执行的尾沿调用，组件卸载时防泄漏）、**`flush()`**（立即执行待执行的尾沿调用，表单提交前强制落定）、**`maxWait`**（防抖在持续高频触发下也要保证「至少每 maxWait 执行一次」，否则永远不执行——这其实让防抖退化成节流）。

## 实现选型对照

| 方案                    | 原理                           | 优点                           | 缺点                              |
| ----------------------- | ------------------------------ | ------------------------------ | --------------------------------- |
| 纯定时器（setTimeout）  | 每次触发清旧定时器、设新定时器 | 实现简单、尾沿精确             | 首沿需额外标志                    |
| 纯时间戳                | 记录上次执行时间，间隔够就执行 | 首沿天然立即执行               | 尾沿不会补触发（停止后不再执行）  |
| **时间戳 + 定时器组合** | 时间戳管首沿、定时器管尾沿     | leading/trailing 都能精确控制  | 实现稍复杂（**本题主解**）        |
| requestAnimationFrame   | 每帧至多一次                   | 与渲染帧对齐、页面隐藏自动暂停 | 仅浏览器、节奏是帧率而非任意 wait |

> 事实依据：`content/fe/fe.md:826` 把防抖节流归为「用定时器或时间戳控制执行时机；leading/trailing 组合；执行间隔要能取消与立即触发（flush）」；`content/fe/fe.md:299` 指出「做『帧级节流』时用 rAF 替代定时器，天然与渲染帧对齐」。

## 主实现 · debounce（定时器 + 双沿）

```js
function debounce(fn, wait, { leading = false, trailing = true } = {}) {
  let timer = null; // 尾沿定时器
  let lastArgs = null; // 最近一次触发的参数

  // 尾沿执行: 只有 trailing 为真才真正调用 fn
  function invokeTrailing() {
    timer = null;
    const args = lastArgs;
    lastArgs = null;
    if (trailing && args) fn(...args);
  }

  function debounced(...args) {
    const first = timer === null; // 是否处于静默期起点
    lastArgs = args;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(invokeTrailing, wait); // (重)设尾沿
    if (first && leading) {
      // leading: 立即执行本次参数, 并清掉 lastArgs 避免尾沿重复执行同一次
      fn(...args);
      lastArgs = null;
    }
  }

  debounced.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    lastArgs = null;
  };
  debounced.flush = () => {
    if (timer === null) return; // 没有待执行的尾沿
    clearTimeout(timer);
    timer = null;
    const args = lastArgs;
    lastArgs = null;
    if (args) fn(...args);
  };
  debounced.pending = () => timer !== null;
  return debounced;
}
```

三个易错点：① **`leading` 执行后要把 `lastArgs` 置空**，否则同一次触发会被尾沿再执行一遍；② **`trailing:false` 时尾沿定时器仍要设**（用于 `first` 判定与后续触发的节奏），只是 `invokeTrailing` 里不调用 fn；③ **`flush` 是显式动作**，无视 `trailing` 强制落定待执行参数。面试时把「定时器管尾沿、`first` 标志管首沿、`trailing` 决定尾沿是否真正调用」这三句讲清，比逐行背代码更重要。

## 主实现 · throttle（时间戳 + 尾沿定时器）

```js
function throttle(fn, wait, { leading = true, trailing = true } = {}) {
  let last = 0; // 上次执行时间
  let timer = null;
  let lastArgs = null;

  function invoke(now) {
    last = now;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    const args = lastArgs;
    lastArgs = null;
    if (args) fn(...args);
  }

  function throttled(...args) {
    const now = Date.now();
    if (last === 0 && !leading) last = now; // 关闭 leading 时, 首次不立即执行
    lastArgs = args;
    const remaining = wait - (now - last);
    if (remaining <= 0 || remaining > wait) {
      // 距上次执行已超过 wait: 立即执行 (时间戳管首沿/节奏)
      invoke(now);
    } else if (timer === null && trailing) {
      // 在节奏窗口内: 安排一个尾沿调用, 保证最后一次不丢
      timer = setTimeout(() => invoke(Date.now()), remaining);
    }
  }
  throttled.cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    last = 0;
    lastArgs = null;
  };
  return throttled;
}
```

节流的关键是「**时间戳管节奏、尾沿定时器保证最后一次不丢**」：时间戳让每次执行间隔 ≥ wait（首沿立即执行），尾沿定时器让「最后一次触发」不会因落在节奏窗口内而被丢弃。`remaining > wait` 的判断是为了处理系统时间被回拨的极端情况（回拨时 remaining 会异常大，此时应立即执行而非设一个超长定时器）。

## 自测（输出 ALL PASS）

```js
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function assert(cond, msg) {
  if (!cond) throw new Error("FAIL: " + msg);
}

// 1. debounce 默认 trailing: 连续触发只在停止后执行一次, 拿到最后一次参数
{
  let calls = [];
  const d = debounce((v) => calls.push(v), 30);
  d(1);
  d(2);
  d(3);
  assert(calls.length === 0, "debounce 触发期间不执行");
  await sleep(60);
  assert(calls.join(",") === "3", "debounce 只执行最后一次, 参数为 3");
}

// 2. debounce leading + trailing:false: 第一次立即执行, 尾沿不再补
{
  let calls = [];
  const d = debounce((v) => calls.push(v), 30, {
    leading: true,
    trailing: false,
  });
  d(1);
  d(2);
  assert(calls.join(",") === "1", "leading 立即执行第一次");
  await sleep(60);
  assert(calls.join(",") === "1", "trailing:false 不再补执行");
}

// 3. debounce leading + trailing: 两次独立 burst 各执行首尾
{
  let calls = [];
  const d = debounce((v) => calls.push(v), 30, {
    leading: true,
    trailing: true,
  });
  d(1);
  await sleep(60); // 第一次 burst 结束
  d(2);
  await sleep(60); // 第二次 burst 结束
  assert(calls.join(",") === "1,2", "两次独立 burst 各执行");
}

// 4. debounce cancel: 取消待执行的尾沿
{
  let n = 0;
  const d = debounce(() => n++, 30);
  d();
  d.cancel();
  await sleep(60);
  assert(n === 0, "cancel 后不执行");
}

// 5. debounce flush: 立即执行待执行的尾沿
{
  let n = 0;
  const d = debounce(() => n++, 30);
  d();
  d.flush();
  assert(n === 1, "flush 立即执行");
  await sleep(60);
  assert(n === 1, "flush 后尾沿不再重复执行");
}

// 6. throttle: 高频触发按节奏执行, 次数远少于触发次数
{
  let n = 0;
  const t = throttle(() => n++, 30);
  for (let i = 0; i < 10; i++) {
    t();
    await sleep(10);
  } // 共约 100ms
  await sleep(60);
  assert(n >= 3 && n <= 5, "throttle 按节奏执行, n=" + n);
}

// 7. throttle leading:false: 首次不立即执行, 尾沿补一次
{
  let n = 0;
  const t = throttle(() => n++, 30, { leading: false });
  t();
  assert(n === 0, "leading:false 首次不立即执行");
  await sleep(60);
  assert(n === 1, "尾沿补执行一次");
}

// 8. throttle cancel
{
  let n = 0;
  const t = throttle(() => n++, 30);
  t(); // leading 立即执行一次
  t();
  t.cancel();
  const afterCancel = n;
  await sleep(60);
  assert(n === afterCancel, "cancel 后尾沿不执行");
}

console.log("ALL PASS");
```

## 生产延伸

### 1. rAF 帧级节流（浏览器渲染场景）

滚动、鼠标移动、拖拽这类「与渲染同步」的高频事件，用 `requestAnimationFrame` 节流比定时器更合适：rAF 回调在浏览器下一帧绘制前执行、与显示器刷新率对齐（60Hz 约 16.7ms）、**页面隐藏时自动暂停**，天然避免「后台标签页空转」。模式是「事件里只置脏标志 + 注册一次 rAF，rAF 回调里消费脏标志」：

```js
function rafThrottle(fn) {
  let queued = false;
  let lastArgs = null;
  return function (...args) {
    lastArgs = args;
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      fn.apply(this, lastArgs);
    });
  };
}
```

这正是 [AI 流式前端专题](/interview/qa/ai-streaming-ui) 里「rAF 拉取把渲染频率钳制在帧率」的同一思路——**把高频事件收敛到帧边界**。

### 2. maxWait：防抖退化为节流的边界

纯防抖在「持续高频触发」下永远不执行（每次触发都重置定时器）。`maxWait` 给一个上限：即使一直在触发，也保证「至少每 maxWait 执行一次」。这让防抖在语义上退化为节流——lodash 的 `debounce(fn, wait, { maxWait })` 就是这个用途（如「输入停止 300ms 后搜索，但最长每 1s 至少搜一次」）。实现上是在每次触发时额外比较「距上次真正执行的时间是否 ≥ maxWait」，是则强制执行一次。

### 3. 与项目经验的连接

- **监控 SDK 的曝光与滚动上报**：`@yukino.js/sentry` 的元素曝光、滚动深度、性能采样都是高频事件，用节流（或 rAF）把上报频率钳制在可接受范围，避免「采集本身拖垮页面」。
- **搜索框 / 自动补全**：yukino-chat 的 `@` 文件提及补全、命令面板的模糊搜索，输入侧用防抖（停止输入后再发请求），配合 [Promise 并发池](/interview/code/promise-concurrency) 限制并发、`AbortController` 取消过期请求。
- **窗口 resize / 虚拟滚动重算**：yukino-chat 的 `useVisualViewport`、虚拟列表的 `measureElement` 重算，用防抖（resize 停止后重排）或 rAF 节流（滚动中跟手）。

面试时能把「手写 debounce/throttle」上升到「为什么监控用节流、搜索用防抖、渲染用 rAF」，并说出 `cancel`/`flush`/`maxWait` 的真实用途，就是从「背模板」到「懂取舍」的分水岭。

---

**延伸阅读**

- [Promise 并发池](/interview/code/promise-concurrency)：防抖/节流常与并发限制、请求取消组合使用。
- [JS 手写限流器](/interview/code/rate-limiter)：服务端侧的速率控制（令牌桶/滑动窗口），与前端防抖节流互补。
- [AI 流式前端专题题库](/interview/qa/ai-streaming-ui)：rAF 帧级节流在流式渲染里的落地。
- [前端监控 SDK 题库](/interview/qa/frontend-monitoring-sdk)：高频采集事件的节流与上报治理。
- [JavaScript 与 TypeScript 题库](/interview/qa/js-ts-language)：闭包、this 绑定、定时器与事件循环。
