---
title: "代码题：手写指数退避重试（含抖动）"
description: "零依赖可运行的 retry 实现与自测: 指数退避、full/equal/none 三种抖动、shouldRetry 错误分级、Retry-After 优先、AbortSignal 可中断睡眠、maxDelay 封顶, 对照 LLM Provider 重试、gRPC 可靠性与 SSE 重连"
---

零依赖、可直接 `node` 运行的代码题参考实现。先澄清重试的语义边界（哪些能重试、退避与抖动、幂等），再给主实现、自测与生产延伸。

:::note 运行方式
本文代码零依赖、可直接用 `node`（ESM，顶层 await）执行，自测输出 `ALL PASS`。
:::

## 题目

> 手写一个 `retry(fn, options)`：失败后按**指数退避 + 抖动**重试，支持「哪些错误可重试」「最大次数」「最大延迟」「Retry-After 优先」「可被 AbortSignal 中断」。

## 开口先澄清语义（必拿分）

重试看似简单，但「无脑重试」是分布式系统故障扩散的主要来源。采分点在于讲清四个边界：

| 维度               | 要点                                                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| **哪些错误可重试** | 瞬态错误（429 限流、5xx、网络抖动、超时）可重试；**非瞬态错误（4xx 鉴权/参数错、业务拒绝）不可重试**——重试无意义且拖慢失败反馈 |
| **幂等性**         | **只对幂等操作自动重试**；非幂等操作（扣款、下单）重试会放大副作用，需业务层幂等键/去重表                                      |
| **退避 + 抖动**    | 固定间隔重试会让「同时失败的一批客户端」在同一时刻再次打过来（惊群）；指数退避拉开间隔，**抖动打散重试时刻**                   |
| **Retry-After**    | 服务端返回 429/503 时常带 `Retry-After`，**应优先遵循服务端建议**而非自己的退避值                                              |

## 退避与抖动选型对照

| 策略                       | 延迟公式                               | 特点                                 |
| -------------------------- | -------------------------------------- | ------------------------------------ |
| 固定间隔                   | `delay`                                | 简单，但惊群严重                     |
| 指数退避（none）           | `min(maxDelay, base × factor^attempt)` | 拉开间隔，但同批失败者仍同步重试     |
| **指数退避 + full jitter** | `random(0, exp)`                       | **AWS 推荐**：完全打散，平均延迟更低 |
| 指数退避 + equal jitter    | `exp/2 + random(0, exp/2)`             | 保底一半延迟 + 一半随机，折中        |

> 事实依据：`content/be/middleware.md` 的 gRPC 可靠性章节明确「重试需要显式配置：可重试状态码集合、最大尝试次数、指数退避与抖动，且只应对幂等操作启用」；`content/docs/yukino/llm.md` 的 LLM Provider 重试是「最多 3 次、Retry-After 优先（支持秒数与 HTTP 日期）、否则指数退避、限流基数更大、可中断睡眠」。

## 主实现

```js
// 可中断睡眠: AbortSignal 触发时提前 reject
const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (signal) {
      if (signal.aborted) {
        clearTimeout(t);
        reject(signal.reason ?? new Error("aborted"));
        return;
      }
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(t);
          reject(signal.reason ?? new Error("aborted"));
        },
        { once: true },
      );
    }
  });

// 计算第 attempt 次重试的延迟
function backoffDelay(attempt, { baseDelay, maxDelay, factor, jitter }) {
  const exp = Math.min(maxDelay, baseDelay * Math.pow(factor, attempt));
  if (jitter === "full") return Math.random() * exp; // [0, exp)
  if (jitter === "equal") return exp / 2 + Math.random() * (exp / 2); // [exp/2, exp)
  return exp; // none
}

async function retry(fn, options = {}) {
  const {
    retries = 3, // 最大重试次数 (不含首次)
    baseDelay = 200,
    maxDelay = 10_000,
    factor = 2,
    jitter = "full",
    shouldRetry = () => true, // 错误分级: 返回 false 立即抛
    onRetry, // (err, attempt, delay) => void 观测钩子
    signal,
  } = options;

  let attempt = 0;
  for (;;) {
    try {
      return await fn(attempt);
    } catch (err) {
      // 不可重试 / 次数耗尽: 抛出最后一个错误
      if (attempt >= retries || !shouldRetry(err, attempt)) throw err;
      // Retry-After 优先于自身退避
      let delay = backoffDelay(attempt, {
        baseDelay,
        maxDelay,
        factor,
        jitter,
      });
      if (err && typeof err.retryAfterMs === "number")
        delay = Math.min(maxDelay, err.retryAfterMs);
      onRetry?.(err, attempt, delay);
      await sleep(delay, signal); // 可中断
      attempt++;
    }
  }
}
```

三个实现要点：① **`fn(attempt)` 把尝试次数传给业务**，让业务能按次数调整行为（如最后一次降级）；② **可中断睡眠**——退避等待期间用户/上游取消时立即 reject，不必等完整个退避周期（这正是 LLM Provider 重试的 `interruptibleSleep`）；③ **Retry-After 优先**——服务端比客户端更知道自己多久能恢复，遵循它能避免「客户端按自己的节奏反复撞墙」。

## 自测（输出 ALL PASS）

```js
function assert(cond, msg) {
  if (!cond) throw new Error("FAIL: " + msg);
}

// 1. 首次成功不重试
{
  let n = 0;
  const r = await retry(
    () => {
      n++;
      return "ok";
    },
    { retries: 3 },
  );
  assert(r === "ok" && n === 1, "首次成功");
}
// 2. 失败两次后成功
{
  let n = 0;
  const r = await retry(
    () => {
      n++;
      if (n < 3) throw new Error("fail");
      return "ok";
    },
    { retries: 3, baseDelay: 1, jitter: "none" },
  );
  assert(r === "ok" && n === 3, "重试到第 3 次成功");
}
// 3. 耗尽重试抛最后一个错误 (retries=2 共执行 3 次)
{
  let n = 0,
    err = null;
  try {
    await retry(
      () => {
        n++;
        throw new Error("e" + n);
      },
      { retries: 2, baseDelay: 1, jitter: "none" },
    );
  } catch (e) {
    err = e;
  }
  assert(err.message === "e3" && n === 3, "耗尽重试");
}
// 4. shouldRetry=false 立即抛, 不重试
{
  let n = 0,
    err = null;
  try {
    await retry(
      () => {
        n++;
        throw new Error("fatal");
      },
      { retries: 5, shouldRetry: (e) => e.message !== "fatal", baseDelay: 1 },
    );
  } catch (e) {
    err = e;
  }
  assert(n === 1 && err.message === "fatal", "不可重试立即抛");
}
// 5. 退避递增 (jitter=none): delay = base × factor^attempt
{
  const delays = [];
  try {
    await retry(
      () => {
        throw new Error("x");
      },
      {
        retries: 3,
        baseDelay: 10,
        factor: 2,
        jitter: "none",
        onRetry: (e, a, d) => delays.push(d),
      },
    );
  } catch (e) {}
  assert(delays.join(",") === "10,20,40", "退避递增 " + delays.join(","));
}
// 6. maxDelay 封顶
{
  const delays = [];
  try {
    await retry(
      () => {
        throw new Error("x");
      },
      {
        retries: 4,
        baseDelay: 10,
        factor: 10,
        maxDelay: 50,
        jitter: "none",
        onRetry: (e, a, d) => delays.push(d),
      },
    );
  } catch (e) {}
  assert(
    delays.every((d) => d <= 50) && delays[1] === 50,
    "maxDelay 封顶 " + delays.join(","),
  );
}
// 7. Retry-After 优先于自身退避
{
  const delays = [];
  try {
    await retry(
      () => {
        const e = new Error("429");
        e.retryAfterMs = 5;
        throw e;
      },
      {
        retries: 2,
        baseDelay: 1000,
        jitter: "none",
        onRetry: (e, a, d) => delays.push(d),
      },
    );
  } catch (e) {}
  assert(
    delays.every((d) => d === 5),
    "Retry-After 优先 " + delays.join(","),
  );
}
// 8. full jitter 落在 [0, exp) 内
{
  const delays = [];
  try {
    await retry(
      () => {
        throw new Error("x");
      },
      {
        retries: 3,
        baseDelay: 100,
        jitter: "full",
        onRetry: (e, a, d) => delays.push(d),
      },
    );
  } catch (e) {}
  assert(
    delays.every((d, i) => d >= 0 && d <= 100 * Math.pow(2, i)),
    "full jitter 范围",
  );
}
// 9. AbortSignal 中断退避等待
{
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 5);
  let err = null;
  try {
    await retry(
      () => {
        throw new Error("x");
      },
      { retries: 10, baseDelay: 50, jitter: "none", signal: ac.signal },
    );
  } catch (e) {
    err = e;
  }
  assert(
    err && (err.name === "AbortError" || err.message === "aborted"),
    "abort 中断",
  );
}

console.log("ALL PASS");
```

## 生产延伸

### 1. 错误分级：shouldRetry 的真实写法

生产里 `shouldRetry` 要按错误类型分级：网络错误 / 超时 / 429 / 5xx 可重试；401/403（鉴权）/ 400（参数）/ 业务拒绝码不可重试。LLM Provider 的重试正是这套——把传输层异常归类为 NetworkError / RateLimitError / ServerError（可重试）与鉴权/请求错误（不可重试），上下文超限则走「压缩后重试」而非退避重试（见 [Yukino Code 执行内核题库](/interview/qa/yukino-code-engine) 的错误自愈）。

### 2. 重试预算与熔断

无限重试会放大故障。生产要加**重试预算**（如「错误率超过 X% 时停止重试」）与**熔断器**（连续失败后快速失败一段时间，不再尝试）。重试 + 熔断 + 限流 + 降级是「弹性四件套」——`content/be/middleware.md` 把「用超时、重试、熔断、降级作为标准配置」列为贯穿全文的实践原则，并指出「默认无超时、无上限重试是分布式系统故障扩散的主要来源」。

### 3. 与项目经验的连接

- **SSE 客户端重连**：[SSE 客户端与重连退避](/interview/code/sse-retry) 的重连就是「指数退避 + 抖动 + 可中断」，且要带游标（last_seq）做幂等重放，避免重复消费。
- **LLM Provider 重试**：yukino-code 的 `llmRetryDelay` 最多 3 次、Retry-After 优先、限流基数比服务端错误更大、可中断睡眠、**只在「本轮无可见输出」时重放**（已流出的内容无法撤回，重放会重复）。
- **gRPC 重试**：只对幂等操作启用，指定可重试状态码集合、最大尝试次数、指数退避与抖动。
- **MCP / 外部依赖降级**：yukino-agent 的 MCP 连接失败降级为空工具集而非无限重试，是「重试有界 + 降级兜底」的取舍。

面试时能把「手写重试」上升到「错误分级、幂等前提、抖动防惊群、Retry-After、重试预算与熔断」，就是从「会写循环」到「懂弹性设计」的分水岭。

---

**延伸阅读**

- [SSE 客户端与重连退避](/interview/code/sse-retry)：重连退避 + 游标幂等重放的完整落地。
- [JS 手写限流器](/interview/code/rate-limiter)：弹性四件套里的「限流」，与重试/熔断/降级配合。
- [Yukino Code 执行内核与上下文工程题库](/interview/qa/yukino-code-engine)：LLM Provider 的错误分类、退避与「无可见输出才重放」。
- [中间件与分布式基础设施题库](/interview/qa/middleware-infrastructure)：gRPC 可靠性（超时/重试/KeepAlive）与弹性实践原则。
- [Promise 并发池](/interview/code/promise-concurrency)：批量任务的重试常与并发限制组合。
