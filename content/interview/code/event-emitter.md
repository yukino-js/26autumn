---
title: "代码题：JS 手写 EventEmitter（发布订阅）"
description: "零依赖可运行的发布订阅实现与自测：on/off/once/emit、Map<type,Set> 存储、单处理器异常隔离、订阅返回清理函数、通配符与异步扩展，对照 @yukino.js/sentry 事件总线的工程取舍"
---

零依赖、可直接 `node` 运行的代码题参考实现。先澄清发布订阅的语义边界，再给主实现、对照实现、自测与生产延伸。

:::note 运行方式
本文代码零依赖、可直接用 `node` 执行，自测输出 `ALL PASS`。
:::

## 题目

> 用 JS 手写一个 `EventEmitter`（发布订阅 / 事件总线）：支持 `on(type, handler)` 订阅、`off(type, handler)` 取消、`once(type, handler)` 只触发一次、`emit(type, ...args)` 发布。

## 开口先澄清语义（必拿分）

发布订阅看似简单，但面试官在意的是一组容易被忽略的语义边界，答之前先问清或主动声明：

| 维度             | 两种取向                                       | 后果                                                                         |
| ---------------- | ---------------------------------------------- | ---------------------------------------------------------------------------- |
| **同步 vs 异步** | `emit` 同步逐个调用处理器 / 异步（微任务）调度 | 同步语义简单、可预测；异步避免阻塞但顺序与错误传播更复杂。本题主解用**同步** |
| **错误隔离**     | 一个处理器抛错是否中断其余处理器               | 不隔离会让一个坏消费者拖垮整条链；**每个处理器单独 try/catch** 是生产级要求  |
| **重复订阅**     | 同一 handler 对同一 type 订阅两次算几个        | 用**数组**会触发两次，用 **Set** 天然去重只触发一次                          |
| **遍历期增删**   | emit 过程中 off / on 是否影响本次派发          | 直接遍历活集合会漏调或重复调；**先快照再遍历**保证本次派发稳定               |
| **返回值**       | 订阅是否返回清理函数                           | 返回 `() => off(...)` 让生命周期管理更清晰（React effect / SDK 销毁常用）    |

## 存储选型对照

| 方案                           | 去重                    | 删除复杂度               | 顺序   | 适用                                    |
| ------------------------------ | ----------------------- | ------------------------ | ------ | --------------------------------------- |
| `Map<type, handler[]>`（数组） | 否（同 handler 可重复） | `O(n)`（splice/indexOf） | 插入序 | 需要允许重复订阅、需要严格顺序          |
| **`Map<type, Set<handler>>`**  | **是（天然去重）**      | **`O(1)`（Set.delete）** | 插入序 | **本题主解**、监控 SDK 事件总线         |
| 继承 Node `EventEmitter`       | 否                      | O(n)                     | 插入序 | Node 环境、需要 maxListeners 等成熟特性 |

> 事实依据：`content/fe/yukino-sentry.md:171-177` 的事件总线正是 `Map<EventType, Set<TEventHandler>>`——「用集合而非数组存储处理器（天然去重、删除 O(1)），类型被约束为事件枚举，并且不继承任何平台自带的事件发射器，保持零依赖与更小体积」，且「每个处理器单独 try/catch：一个消费者抛错不会中断其余消费者，也不会把异常抛回生产者」。

## 主实现 · Map + Set + 异常隔离

```js
class EventEmitter {
  #handlers = new Map(); // type -> Set<handler>

  /** 订阅; 返回清理函数, 调用即取消订阅 */
  on(type, handler) {
    if (typeof handler !== "function")
      throw new TypeError("handler must be a function");
    let set = this.#handlers.get(type);
    if (!set) {
      set = new Set();
      this.#handlers.set(type, set);
    }
    set.add(handler); // Set 天然去重: 同一 handler 重复 on 只存一份
    return () => this.off(type, handler);
  }

  /** 只触发一次: 包装一层, 触发后自动 off */
  once(type, handler) {
    const wrapper = (...args) => {
      this.off(type, wrapper); // 先 off 再调用, 避免 handler 内再 emit 同类型时重入
      handler(...args);
    };
    // 记录原始 handler -> wrapper 的映射, 让 off(type, handler) 也能取消 once
    wrapper.__original = handler;
    return this.on(type, wrapper);
  }

  /** 取消订阅; 不传 handler 则清空该 type 的全部订阅 */
  off(type, handler) {
    const set = this.#handlers.get(type);
    if (!set) return false;
    if (handler === undefined) {
      this.#handlers.delete(type);
      return true;
    }
    // 直接删除, 或删除「以 handler 为原始的 once 包装」
    let removed = set.delete(handler);
    if (!removed) {
      for (const fn of set) {
        if (fn.__original === handler) {
          set.delete(fn);
          removed = true;
          break;
        }
      }
    }
    if (set.size === 0) this.#handlers.delete(type); // 清空集合, 防内存泄漏
    return removed;
  }

  /** 发布: 同步逐个调用, 每个处理器单独 try/catch 隔离异常 */
  emit(type, ...args) {
    const set = this.#handlers.get(type);
    if (!set || set.size === 0) return false;
    // 先快照再遍历: emit 过程中的 on/off 不影响本次派发
    for (const handler of [...set]) {
      try {
        handler(...args);
      } catch (err) {
        // 异常隔离: 一个消费者抛错不中断其余消费者, 也不抛回生产者
        // 生产环境这里应接到调试日志 / 错误上报, 而不是 console
        if (typeof this.onError === "function")
          this.onError(err, type, handler);
      }
    }
    return true;
  }

  /** 某 type 的订阅数 (诊断用) */
  listenerCount(type) {
    return this.#handlers.get(type)?.size ?? 0;
  }

  /** 清空全部订阅 (销毁用) */
  removeAll() {
    this.#handlers.clear();
  }
}
```

## 自测（输出 ALL PASS）

```js
function assert(cond, msg) {
  if (!cond) throw new Error("FAIL: " + msg);
}

// 1. 基本 on/emit
{
  const bus = new EventEmitter();
  const seen = [];
  bus.on("evt", (x) => seen.push("a:" + x));
  bus.on("evt", (x) => seen.push("b:" + x));
  bus.emit("evt", 1);
  assert(seen.join(",") === "a:1,b:1", "on/emit 顺序与参数");
}

// 2. Set 去重: 同一 handler 重复 on 只触发一次
{
  const bus = new EventEmitter();
  let n = 0;
  const h = () => n++;
  bus.on("evt", h);
  bus.on("evt", h);
  bus.emit("evt");
  assert(n === 1, "重复订阅去重");
  assert(bus.listenerCount("evt") === 1, "listenerCount 去重");
}

// 3. off 取消; 返回的清理函数
{
  const bus = new EventEmitter();
  let n = 0;
  const dispose = bus.on("evt", () => n++);
  bus.emit("evt");
  dispose(); // 清理函数
  bus.emit("evt");
  assert(n === 1, "清理函数取消订阅");
}

// 4. once 只触发一次
{
  const bus = new EventEmitter();
  let n = 0;
  bus.once("evt", () => n++);
  bus.emit("evt");
  bus.emit("evt");
  assert(n === 1, "once 只触发一次");
  assert(bus.listenerCount("evt") === 0, "once 触发后自动清理");
}

// 5. off(type, handler) 能取消 once 注册的原始 handler
{
  const bus = new EventEmitter();
  let n = 0;
  const h = () => n++;
  bus.once("evt", h);
  bus.off("evt", h); // 用原始 handler 取消 once
  bus.emit("evt");
  assert(n === 0, "off 原始 handler 取消 once");
}

// 6. 异常隔离: 一个处理器抛错不中断其余
{
  const bus = new EventEmitter();
  const errs = [];
  bus.onError = (e) => errs.push(e.message);
  const seen = [];
  bus.on("evt", () => seen.push("first"));
  bus.on("evt", () => {
    throw new Error("boom");
  });
  bus.on("evt", () => seen.push("third"));
  bus.emit("evt");
  assert(seen.join(",") === "first,third", "异常隔离: 抛错处理器之后的仍执行");
  assert(errs[0] === "boom", "异常被 onError 捕获");
}

// 7. 遍历期增删: emit 中 off 不影响本次派发 (快照)
{
  const bus = new EventEmitter();
  const seen = [];
  const h2 = () => seen.push("h2");
  bus.on("evt", () => {
    seen.push("h1");
    bus.off("evt", h2); // 派发中取消 h2
  });
  bus.on("evt", h2);
  bus.emit("evt");
  // 快照遍历: h2 在本次派发仍被调用 (off 只影响下一次)
  assert(seen.join(",") === "h1,h2", "快照遍历: 派发中 off 不影响本次");
  bus.emit("evt");
  assert(seen.join(",") === "h1,h2,h1", "下一次派发 h2 已取消");
}

// 8. emit 无订阅返回 false; 有订阅返回 true
{
  const bus = new EventEmitter();
  assert(bus.emit("nope") === false, "无订阅返回 false");
  bus.on("evt", () => {});
  assert(bus.emit("evt") === true, "有订阅返回 true");
}

console.log("ALL PASS");
```

## 生产延伸

### 1. 通配符订阅（`*` / 命名空间）

监控与日志系统常需要「订阅所有事件」或「订阅某命名空间下所有事件」。实现要点：维护一个独立的通配符处理器集合，`emit(type)` 时除了精确匹配的处理器，再遍历通配符集合，把 `(type, ...args)` 一并传入。代价是每次 emit 多一轮遍历，且通配符处理器要自己按 type 过滤——所以通配符适合「诊断 / 全量录制」，不适合高频热路径。

### 2. 异步派发与背压

同步 `emit` 在处理器很多或很慢时会阻塞发布者。两种异步化：① **微任务调度**——`emit` 把派发推进 `queueMicrotask`，发布者不被阻塞，但错误无法同步捕获、顺序变成「本轮同步代码之后」；② **带背压的队列**——处理器返回 Promise 时，用串行队列（类似 [Promise 并发池](/interview/code/promise-concurrency)）逐个 await，避免一次性并发打满下游。监控 SDK 选同步派发 + 异常隔离，正是为了「可预测、不丢事件、不阻塞采集」。

### 3. maxListeners 与内存泄漏告警

Node 的 `EventEmitter` 默认在某 type 的监听器超过 10 个时打印 `MaxListenersExceededWarning`——这是「忘记 off 导致泄漏」的早期信号。自定义实现可加一个 `maxListeners` 阈值，超过时经 `onError` 或调试日志告警。配合「订阅返回清理函数」的约定，能把「订阅了忘记取消」这类泄漏挡在代码评审阶段。

### 4. 与项目经验的连接

`@yukino.js/sentry` 的事件总线就是这套模式的工业级落地：八类采集源（错误 / HTTP / PV / 性能 / 点击 / 曝光 / 白屏 / 录屏）只**发布**原始事件，上报、面包屑、录屏各自作为**消费者**订阅；用 `Map<EventType, Set<handler>>` 天然去重、删除 O(1)；每个处理器单独 try/catch 隔离；每个订阅自带清理函数，SDK 销毁时「按注册的逆序一次性还原，再清空全部总线订阅」，因此可以安全地从页面中完整移除（适合测试重置、微前端卸载）。面试时能把「手写 EventEmitter」上升到「为什么监控 SDK 用发布订阅解耦采集与上报」，就是从「会写」到「懂设计」的分水岭。

---

**延伸阅读**

- [Promise 并发池](/interview/code/promise-concurrency)：异步派发的背压控制（串行 / 并发上限）。
- [JS 手写限流器](/interview/code/rate-limiter)：事件驱动系统里常用的令牌桶 / 滑动窗口限流。
- [前端监控 SDK 题库](/interview/qa/frontend-monitoring-sdk)：本题事件总线的项目来源（@yukino.js/sentry 的发布订阅总线）。
- [JavaScript 与 TypeScript 题库](/interview/qa/js-ts-language)：闭包、Set/Map、this 绑定等语言基础。
