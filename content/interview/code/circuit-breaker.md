---
title: "代码题：手写熔断器（Circuit Breaker）"
description: "零依赖可运行的熔断器实现与自测：CLOSED/OPEN/HALF_OPEN 三态状态机、失败阈值触发、resetTimeout 后探测恢复、half-open 限制探测数、成功重置计数，对照重试/限流/降级组成弹性四件套，连接 gRPC 与分布式容错"
---

零依赖、可直接 `node` 运行的代码题参考实现。先澄清熔断器解决什么问题（与重试的分工），再给三态状态机实现、自测与生产延伸。

:::note 运行方式
本文代码零依赖、可直接用 `node` 执行，自测输出 `ALL PASS`（用可注入时钟保证确定性）。
:::

## 题目

> 手写一个熔断器（Circuit Breaker）：下游持续失败时**快速失败**（不再真正调用），经过一段冷却后**探测恢复**，成功则恢复正常调用。

## 开口先澄清语义（必拿分）

熔断器是「弹性四件套」（限流、重试、熔断、降级）里最容易被答浅的一个。采分点在于讲清**它解决什么问题、与重试的分工**：

| 问题         | 熔断器的回答                                                                              |
| ------------ | ----------------------------------------------------------------------------------------- |
| **故障放大** | 下游已挂，继续调用只会堆积超时请求、占满线程/连接池——熔断让请求**快速失败**，不再打到下游 |
| **雪崩**     | 一个依赖挂导致调用方资源耗尽、连锁拖垮其他依赖——熔断隔离故障域                            |
| **自动恢复** | 冷却后**试探性放行**（half-open），探测成功则恢复，避免人工介入                           |

**熔断 vs 重试的分工**是高频追问：**重试**针对「偶发瞬态错误」，假设「再试一次可能成功」；**熔断**针对「持续故障」，假设「短期内再试也不会成功，别浪费资源」。两者配合：重试在熔断器内部执行（熔断打开时重试也短路），熔断是重试的「总闸」。

## 三态状态机

```text
          失败数 >= 阈值              resetTimeout 到期
CLOSED ─────────────────────> OPEN ─────────────────────> HALF_OPEN
   ^                                                        │
   │                     探测成功                            │
   └────────────────────────────────────────────────────────┤
   ^                                                        │ 探测失败
   │                                                        v
   └──────────────────────────────────────────────────── OPEN (重新计时)
```

- **CLOSED（关闭/正常）**：请求正常透传；统计失败，达到阈值跳 OPEN。
- **OPEN（打开/熔断）**：请求**立即拒绝**（fail fast，不调用下游）；经过 `resetTimeout` 后转 HALF_OPEN。
- **HALF_OPEN（半开/探测）**：放行**有限个**探测请求；成功则回 CLOSED 并清零，失败则回 OPEN 重新计时。

## 主实现

```js
class CircuitBreaker {
  constructor({
    failureThreshold = 5, // 连续失败多少次触发熔断
    resetTimeout = 30_000, // 熔断后多久进入半开探测
    halfOpenMax = 1, // 半开态最多同时放行几个探测
    now = () => Date.now(), // 可注入时钟, 便于测试
  } = {}) {
    this.failureThreshold = failureThreshold;
    this.resetTimeout = resetTimeout;
    this.halfOpenMax = halfOpenMax;
    this.now = now;
    this.state = "CLOSED";
    this.failures = 0;
    this.openedAt = 0;
    this.halfOpenAttempts = 0;
  }

  async fire(fn) {
    // OPEN: 冷却期未满 -> 快速失败; 满了 -> 转 HALF_OPEN
    if (this.state === "OPEN") {
      if (this.now() - this.openedAt >= this.resetTimeout) {
        this.state = "HALF_OPEN";
        this.halfOpenAttempts = 0;
      } else {
        throw new Error("CircuitBreaker OPEN"); // fail fast, 不调用下游
      }
    }
    // HALF_OPEN: 限制并发探测数
    if (this.state === "HALF_OPEN") {
      if (this.halfOpenAttempts >= this.halfOpenMax)
        throw new Error("CircuitBreaker HALF_OPEN probing");
      this.halfOpenAttempts++;
    }
    try {
      const result = await fn();
      this.#onSuccess();
      return result;
    } catch (err) {
      this.#onFailure();
      throw err;
    }
  }

  #onSuccess() {
    if (this.state === "HALF_OPEN") {
      this.state = "CLOSED"; // 探测成功, 恢复
      this.failures = 0;
      this.halfOpenAttempts = 0;
    } else if (this.state === "CLOSED") {
      this.failures = 0; // 成功重置失败计数
    }
  }

  #onFailure() {
    if (this.state === "HALF_OPEN") {
      this.state = "OPEN"; // 探测失败, 回到熔断并重新计时
      this.openedAt = this.now();
    } else if (this.state === "CLOSED") {
      this.failures++;
      if (this.failures >= this.failureThreshold) {
        this.state = "OPEN";
        this.openedAt = this.now();
      }
    }
  }
}
```

三个实现要点：① **OPEN 态的快速失败不调用 `fn`**——这是熔断的核心价值（省资源、防雪崩），测试里用「fn 是否被调用」验证；② **HALF_OPEN 限制并发探测数**（`halfOpenMax`）——避免冷却到期瞬间一大批请求同时涌入刚恢复的下游，把它再次打挂；③ **探测失败回 OPEN 并重新计时**——不是立即再探测，而是再等一个 `resetTimeout`，给下游恢复时间。

## 自测（输出 ALL PASS）

```js
function assert(cond, msg) {
  if (!cond) throw new Error("FAIL: " + msg);
}

let t = 1000;
const now = () => t; // 可注入时钟

// 1. CLOSED 成功透传
{
  const cb = new CircuitBreaker({
    failureThreshold: 2,
    resetTimeout: 100,
    now,
  });
  const r = await cb.fire(() => "ok");
  assert(r === "ok" && cb.state === "CLOSED", "CLOSED 透传");
}
// 2. 失败累积到阈值 -> OPEN
{
  const cb = new CircuitBreaker({
    failureThreshold: 2,
    resetTimeout: 100,
    now,
  });
  for (let i = 0; i < 2; i++) {
    try {
      await cb.fire(() => {
        throw new Error("x");
      });
    } catch (e) {}
  }
  assert(cb.state === "OPEN", "阈值后 OPEN");
}
// 3. OPEN 快速失败 (不调用 fn)
{
  const cb = new CircuitBreaker({
    failureThreshold: 1,
    resetTimeout: 100,
    now,
  });
  try {
    await cb.fire(() => {
      throw new Error("x");
    });
  } catch (e) {}
  assert(cb.state === "OPEN", "已 OPEN");
  let called = false,
    err = null;
  try {
    await cb.fire(() => {
      called = true;
      return "ok";
    });
  } catch (e) {
    err = e;
  }
  assert(!called && err && /OPEN/.test(err.message), "OPEN 快速失败不调用 fn");
}
// 4. OPEN 经过 resetTimeout -> HALF_OPEN -> 探测成功 -> CLOSED
{
  const cb = new CircuitBreaker({
    failureThreshold: 1,
    resetTimeout: 100,
    now,
  });
  try {
    await cb.fire(() => {
      throw new Error("x");
    });
  } catch (e) {}
  assert(cb.state === "OPEN", "OPEN");
  t += 100; // 经过 resetTimeout
  const r = await cb.fire(() => "recovered");
  assert(
    r === "recovered" && cb.state === "CLOSED",
    "HALF_OPEN 探测成功 -> CLOSED",
  );
}
// 5. HALF_OPEN 探测失败 -> 回到 OPEN
{
  const cb = new CircuitBreaker({
    failureThreshold: 1,
    resetTimeout: 100,
    now,
  });
  try {
    await cb.fire(() => {
      throw new Error("x");
    });
  } catch (e) {}
  t += 100;
  let err = null;
  try {
    await cb.fire(() => {
      throw new Error("still bad");
    });
  } catch (e) {
    err = e;
  }
  assert(
    cb.state === "OPEN" && err.message === "still bad",
    "HALF_OPEN 探测失败 -> OPEN",
  );
}
// 6. HALF_OPEN 限制探测数 (halfOpenMax=1): 并发第二个被拒
{
  const cb = new CircuitBreaker({
    failureThreshold: 1,
    resetTimeout: 100,
    halfOpenMax: 1,
    now,
  });
  try {
    await cb.fire(() => {
      throw new Error("x");
    });
  } catch (e) {}
  t += 100;
  let resolveFirst;
  const first = cb.fire(
    () =>
      new Promise((r) => {
        resolveFirst = r;
      }),
  ); // 第一个探测挂起
  let err = null;
  try {
    await cb.fire(() => "second");
  } catch (e) {
    err = e;
  }
  assert(err && /HALF_OPEN/.test(err.message), "HALF_OPEN 限制探测数");
  resolveFirst("first-done");
  await first;
  assert(cb.state === "CLOSED", "探测成功后 CLOSED");
}
// 7. CLOSED 成功后重置失败计数
{
  const cb = new CircuitBreaker({
    failureThreshold: 3,
    resetTimeout: 100,
    now,
  });
  try {
    await cb.fire(() => {
      throw new Error("x");
    });
  } catch (e) {} // failures=1
  try {
    await cb.fire(() => {
      throw new Error("x");
    });
  } catch (e) {} // failures=2
  await cb.fire(() => "ok"); // 成功, failures 重置为 0
  try {
    await cb.fire(() => {
      throw new Error("x");
    });
  } catch (e) {} // failures=1
  try {
    await cb.fire(() => {
      throw new Error("x");
    });
  } catch (e) {} // failures=2
  assert(cb.state === "CLOSED", "成功重置计数, 未达阈值仍 CLOSED");
}

console.log("ALL PASS");
```

## 生产延伸

### 1. 滑动窗口失败率（而非连续失败计数）

主实现用「连续失败计数」，简单但对偶发成功敏感（一次成功就清零）。生产熔断器（如 Hystrix、resilience4j）常用**滑动窗口失败率**：在最近 N 次调用（或最近 T 时间）的窗口内，失败率超过阈值才熔断——更稳健，能区分「持续故障」与「偶发抖动」。窗口可用环形数组或按时间桶实现。

### 2. 熔断打开后的降级

熔断器快速失败后，调用方拿到的是「熔断错误」，此时应走**降级路径**：返回缓存值、默认值、简化结果，或把请求转入异步队列。熔断（快速失败）+ 降级（兜底响应）是配合的——熔断决定「要不要调下游」，降级决定「不调下游时返回什么」。

### 3. 与项目经验的连接

- **弹性四件套**：[JS 手写限流器](/interview/code/rate-limiter)（限流）+ [指数退避重试](/interview/code/retry-backoff)（重试）+ 本题（熔断）+ 降级，是分布式容错的标准组合。`content/be/middleware.md` 把「用超时、重试、熔断、降级作为标准配置」列为贯穿全文的实践原则。
- **gRPC 可靠性**：gRPC 客户端的重试 + 超时 + KeepAlive 与熔断配合，避免「对已挂的服务端持续重试」放大故障。
- **yukino-agent 的 MCP 降级**：MCP 连接失败降级为空工具集（而非无限重试），是「熔断 + 降级」在 Agent 工具层的取舍。
- **缓存击穿防护**：[Go singleflight 与两级 LRU](/interview/code/go-singleflight) 的 singleflight 防击穿，与熔断的「故障隔离」同属「保护下游」的思路。

面试时能把「手写熔断器」上升到「三态状态机、与重试的分工、滑动窗口失败率、half-open 限流探测、熔断 + 降级配合」，就是从「背状态机」到「懂弹性设计」的分水岭。

---

**延伸阅读**

- [JS 手写限流器](/interview/code/rate-limiter)：弹性四件套之「限流」。
- [指数退避重试](/interview/code/retry-backoff)：弹性四件套之「重试」，与熔断的分工。
- [Go singleflight 与两级 LRU](/interview/code/go-singleflight)：singleflight 防击穿，与熔断同属「保护下游」。
- [中间件与分布式基础设施题库](/interview/qa/middleware-infrastructure)：gRPC 可靠性与弹性实践原则。
- [分布式组件与一致性题库](/interview/qa/distributed-components)：分布式容错、故障隔离的通用原理。
