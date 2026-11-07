---
title: "代码题：JS 手写 Promise.all / race / allSettled / any"
description: "零依赖可运行的 Promise 四个静态方法实现与自测: all 顺序保持与快速失败、race 首个 settled、allSettled 全量落定、any 首个 fulfilled 与 AggregateError, 对照原生行为与并发池延伸"
---

零依赖、可直接 `node` 运行的代码题参考实现。先澄清四个方法的语义差异，再给实现、自测与生产延伸。

:::note 运行方式
本文代码零依赖、可直接用 `node` 执行，自测输出 `ALL PASS`，并与原生 `Promise` 行为对照一致。
:::

## 题目

> 用 JS 手写 `Promise.all`、`Promise.race`、`Promise.allSettled`、`Promise.any`。

## 开口先澄清语义（必拿分）

四个方法都接收一个可迭代的 promise 集合，但**落定条件与结果形状**各不相同——这是采分点：

| 方法         | 何时落定                       | 结果形状                               | 失败语义                                        |
| ------------ | ------------------------------ | -------------------------------------- | ----------------------------------------------- |
| `all`        | **全部** fulfilled             | 按**输入顺序**的值数组                 | **任一** rejected 立即整体 reject（快速失败）   |
| `race`       | **第一个** settled（无论成败） | 该 promise 的值或原因                  | 第一个是 reject 就 reject                       |
| `allSettled` | **全部** settled               | `{status, value/reason}[]`，按输入顺序 | **永不 reject**（空数组也 resolve）             |
| `any`        | **第一个** fulfilled           | 该值                                   | **全部** rejected 才 reject（`AggregateError`） |

还要主动声明三个共性细节：① **输入先 `Promise.resolve(p)` 包裹**——兼容非 promise 值（同步值立即 fulfilled）；② **`all`/`allSettled` 的结果顺序必须与输入顺序一致**，不能按完成顺序（用下标写入而非 push）；③ **空数组的边界**——`all`/`allSettled` resolve 空数组，`race` 永不落定，`any` reject `AggregateError`。

## 主实现

```js
// all: 全部成功才 resolve(按输入顺序), 任一失败立即 reject
function promiseAll(promises) {
  return new Promise((resolve, reject) => {
    const arr = Array.from(promises);
    const n = arr.length;
    if (n === 0) return resolve([]); // 空数组立即 resolve
    const results = new Array(n);
    let remaining = n;
    arr.forEach((p, i) => {
      Promise.resolve(p).then(
        (v) => {
          results[i] = v; // 按下标写入, 保证顺序
          if (--remaining === 0) resolve(results);
        },
        (e) => reject(e), // 任一 reject 立即整体 reject (快速失败)
      );
    });
  });
}

// race: 第一个 settled (无论成败) 决定结果
function promiseRace(promises) {
  return new Promise((resolve, reject) => {
    for (const p of promises) {
      Promise.resolve(p).then(resolve, reject);
    }
    // 空可迭代: 永不落定 (与原生一致)
  });
}

// allSettled: 等全部落定, 永不 reject
function promiseAllSettled(promises) {
  return new Promise((resolve) => {
    const arr = Array.from(promises);
    const n = arr.length;
    if (n === 0) return resolve([]);
    const results = new Array(n);
    let remaining = n;
    arr.forEach((p, i) => {
      Promise.resolve(p).then(
        (value) => {
          results[i] = { status: "fulfilled", value };
          if (--remaining === 0) resolve(results);
        },
        (reason) => {
          results[i] = { status: "rejected", reason };
          if (--remaining === 0) resolve(results);
        },
      );
    });
  });
}

// any: 第一个 fulfilled 即 resolve, 全部 rejected 才 reject(AggregateError)
function promiseAny(promises) {
  return new Promise((resolve, reject) => {
    const arr = Array.from(promises);
    const n = arr.length;
    if (n === 0)
      return reject(new AggregateError([], "All promises were rejected"));
    const errors = new Array(n);
    let remaining = n;
    arr.forEach((p, i) => {
      Promise.resolve(p).then(
        (v) => resolve(v), // 第一个 fulfilled 立即 resolve
        (e) => {
          errors[i] = e; // 按下标收集原因
          if (--remaining === 0)
            reject(new AggregateError(errors, "All promises were rejected"));
        },
      );
    });
  });
}
```

三个实现要点：① **`all` 用 `remaining` 计数而非 `results.length`**——因为按下标写入时数组长度一开始就是 n（`new Array(n)`），不能用长度判断完成数；② **`race` 直接 `then(resolve, reject)`**——第一个 settled 的 promise 调用 resolve/reject 后，后续 promise 的 resolve/reject 是 no-op（promise 只能落定一次），天然实现「首个获胜」；③ **`any` 与 `all` 是对偶的**——把 `all` 的成功/失败角色互换、把 reject 的原因收集成数组，就是 `any`。

## 自测（输出 ALL PASS）

```js
function assert(cond, msg) {
  if (!cond) throw new Error("FAIL: " + msg);
}

// all: 顺序保持 + 全部成功
{
  const r = await promiseAll([Promise.resolve(1), 2, Promise.resolve(3)]);
  assert(r.join(",") === "1,2,3", "all 顺序保持(含同步值)");
}
// all: 任一失败立即 reject
{
  let rej = null;
  try {
    await promiseAll([
      Promise.resolve(1),
      Promise.reject(new Error("x")),
      Promise.resolve(3),
    ]);
  } catch (e) {
    rej = e;
  }
  assert(rej && rej.message === "x", "all 快速失败");
}
// all: 空数组 resolve 空数组
{
  const r = await promiseAll([]);
  assert(Array.isArray(r) && r.length === 0, "all 空数组");
}
// race: 第一个 settled 是 reject
{
  let rej = null;
  try {
    await promiseRace([
      new Promise((res) => setTimeout(() => res(1), 30)),
      Promise.reject(new Error("fast")),
    ]);
  } catch (e) {
    rej = e;
  }
  assert(rej && rej.message === "fast", "race reject 先到");
}
// race: 第一个 settled 是 resolve
{
  const r = await promiseRace([
    new Promise((res) => setTimeout(() => res("slow"), 30)),
    Promise.resolve("fast"),
  ]);
  assert(r === "fast", "race resolve 先到");
}
// allSettled: 混合成败, 永不 reject, 顺序保持
{
  const r = await promiseAllSettled([
    Promise.resolve(1),
    Promise.reject(new Error("e")),
    Promise.resolve(3),
  ]);
  assert(r[0].status === "fulfilled" && r[0].value === 1, "allSettled[0]");
  assert(
    r[1].status === "rejected" && r[1].reason.message === "e",
    "allSettled[1]",
  );
  assert(r[2].status === "fulfilled" && r[2].value === 3, "allSettled[2]");
}
// any: 第一个 fulfilled
{
  const r = await promiseAny([
    Promise.reject(new Error("a")),
    Promise.resolve("ok"),
    Promise.resolve("later"),
  ]);
  assert(r === "ok", "any 第一个 fulfilled");
}
// any: 全部 reject -> AggregateError
{
  let rej = null;
  try {
    await promiseAny([
      Promise.reject(new Error("a")),
      Promise.reject(new Error("b")),
    ]);
  } catch (e) {
    rej = e;
  }
  assert(
    rej instanceof AggregateError && rej.errors.length === 2,
    "any AggregateError",
  );
}
// any: 空数组 -> AggregateError
{
  let rej = null;
  try {
    await promiseAny([]);
  } catch (e) {
    rej = e;
  }
  assert(rej instanceof AggregateError, "any 空数组 AggregateError");
}
// 与原生 allSettled 行为对照
{
  const native = await Promise.allSettled([
    Promise.resolve(1),
    Promise.reject(new Error("e")),
  ]);
  const mine = await promiseAllSettled([
    Promise.resolve(1),
    Promise.reject(new Error("e")),
  ]);
  assert(
    JSON.stringify(native.map((x) => x.status)) ===
      JSON.stringify(mine.map((x) => x.status)),
    "allSettled 与原生一致",
  );
}

console.log("ALL PASS");
```

## 生产延伸

### 1. all 的快速失败 vs allSettled 的容错

`Promise.all` 适合「全部必须成功才有意义」的场景（如一个事务内的多个前置请求），任一失败就整体失败、其余结果作废；`Promise.allSettled` 适合「尽力而为、逐个处理」的场景（如批量上报、批量预取），每个结果独立处理、不因个别失败中断。**面试常追问「批量请求里一个失败要不要影响其他」，答案就是 all 与 allSettled 的取舍**。

### 2. any + AggregateError 的降级链

`Promise.any` 适合「多源竞速、取第一个可用」的场景（如多个 CDN 镜像竞速加载、多个 LLM provider 竞速响应）。全部失败时抛 `AggregateError`，其 `errors` 数组保留了每个源的失败原因，便于诊断「为什么所有源都不可用」。

### 3. race 的两个经典用法

① **超时控制**：`Promise.race([request, timeout])`，`timeout` 是一个 `wait(ms).then(() => Promise.reject(new Error("timeout")))`，谁先落定谁获胜；② **取消语义的雏形**：配合 `AbortController`，race 让「请求」与「取消信号」竞争。注意 race 不会取消落败的 promise（它们仍在后台跑），真正的取消要靠 `AbortController`。

### 4. 与并发池的关系

`Promise.all` 是「**无并发上限**」的——一次性发起所有 promise。当任务量大时（如 1000 个请求），会瞬间打满下游。此时要用 [Promise 并发池](/interview/code/promise-concurrency)：把任务分批、限制同时在途数量，本质是「受控的 all」。面试时把「all 无上限 → 并发池限流」这条演进线讲出来，就是从「会用 API」到「懂工程」的分水岭。

### 5. 与项目经验的连接

- **yukino-chatbot / yukino-chat 的多 provider 竞速**：多个 LLM provider 可用 `any` 竞速取第一个可用响应，失败降级到下一个。
- **SSE / 流式请求的超时**：[SSE 客户端与重连退避](/interview/code/sse-retry) 里用 race 实现「连接超时」与「AbortController 取消」。
- **监控 SDK 的批量上报**：`@yukino.js/sentry` 的批量上报用 allSettled 容错——单条上报失败不影响其余，失败的进离线缓存重试。

---

**延伸阅读**

- [Promise 并发池](/interview/code/promise-concurrency)：`all` 的受控版本（并发上限 + 结果顺序）。
- [SSE 客户端与重连退避](/interview/code/sse-retry)：race 做超时、AbortController 做取消的真实落地。
- [JavaScript 与 TypeScript 题库](/interview/qa/js-ts-language)：Promise 状态机、微任务、事件循环基础。
- [前端监控 SDK 题库](/interview/qa/frontend-monitoring-sdk)：批量上报的容错与离线重试。
