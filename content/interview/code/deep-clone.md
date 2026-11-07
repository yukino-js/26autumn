---
title: "代码题：JS 手写深拷贝"
description: "零依赖可运行的 deepClone 实现与自测: 递归 + WeakMap 处理循环引用、Date/RegExp/Map/Set/Array/普通对象、保留原型与 symbol 键与访问器属性, 对照 JSON 法与 structuredClone 的缺陷与边界"
---

零依赖、可直接 `node` 运行的代码题参考实现。先澄清深拷贝的语义边界与常见错误答案，再给主实现、自测与生产延伸。

:::note 运行方式
本文代码零依赖、可直接用 `node` 执行，自测输出 `ALL PASS`。
:::

## 题目

> 用 JS 手写一个 `deepClone(value)`，正确拷贝嵌套对象/数组，并处理 `Date`、`RegExp`、`Map`、`Set`、循环引用、原型与 symbol 键。

## 开口先澄清语义（必拿分）

深拷贝是高频题，但多数人只会 `JSON.parse(JSON.stringify(x))`——这恰恰是**错误答案**，采分点在于说清它的缺陷：

| `JSON.parse(JSON.stringify(x))` 的缺陷 | 后果                  |
| -------------------------------------- | --------------------- |
| 丢弃 `undefined`、函数、symbol         | 这些键直接消失        |
| `Date` 变成 ISO 字符串                 | 类型丢失，不再是 Date |
| `RegExp`、`Map`、`Set` 变成 `{}`       | 内容全丢              |
| `NaN`/`Infinity` 变成 `null`           | 数值失真              |
| **循环引用直接抛 `TypeError`**         | 无法拷贝含环对象      |
| 丢失原型（class 实例变普通对象）       | 方法丢失              |

正确的深拷贝要回答：**拷贝到什么深度、哪些类型要特殊处理、循环引用怎么办、原型与不可枚举属性要不要保留**。

## 实现选型对照

| 方案                           | 循环引用 | 特殊类型                             | 原型/函数               | 适用                         |
| ------------------------------ | -------- | ------------------------------------ | ----------------------- | ---------------------------- |
| `JSON.parse(JSON.stringify())` | ✗ 抛错   | ✗ 丢失                               | ✗ 丢失                  | 仅纯 JSON 数据               |
| `structuredClone`（原生）      | ✓        | ✓ Date/RegExp/Map/Set/ArrayBuffer 等 | ✗ 函数/DOM/类方法不支持 | 浏览器/Node 17+ 的结构化数据 |
| **递归 + WeakMap（本题主解）** | ✓        | ✓ 可定制                             | ✓ 可保留原型            | 通用、可控                   |
| `lodash.cloneDeep`             | ✓        | ✓                                    | ✓                       | 生产直接用                   |

## 主实现 · 递归 + WeakMap

```js
function deepClone(value, seen = new WeakMap()) {
  // 原始值与函数: 按值/引用直接返回 (函数通常不克隆, 共享引用)
  if (value === null || typeof value !== "object") return value;
  // 循环引用: 已克隆过就直接返回缓存的副本
  if (seen.has(value)) return seen.get(value);

  if (value instanceof Date) return new Date(value.getTime());
  if (value instanceof RegExp) return new RegExp(value.source, value.flags);

  if (value instanceof Map) {
    const clone = new Map();
    seen.set(value, clone); // 先登记再递归, 否则环会无限递归
    for (const [k, v] of value)
      clone.set(deepClone(k, seen), deepClone(v, seen));
    return clone;
  }
  if (value instanceof Set) {
    const clone = new Set();
    seen.set(value, clone);
    for (const v of value) clone.add(deepClone(v, seen));
    return clone;
  }
  if (Array.isArray(value)) {
    const clone = [];
    seen.set(value, clone);
    for (let i = 0; i < value.length; i++) clone[i] = deepClone(value[i], seen);
    return clone;
  }

  // 普通对象 / 类实例: 保留原型
  const clone = Object.create(Object.getPrototypeOf(value));
  seen.set(value, clone);
  // Reflect.ownKeys 含 symbol 键与不可枚举键
  for (const key of Reflect.ownKeys(value)) {
    const desc = Object.getOwnPropertyDescriptor(value, key);
    if ("value" in desc) desc.value = deepClone(desc.value, seen); // 数据属性深拷贝
    // 访问器属性 (get/set) 原样复制描述符, 不求值
    Object.defineProperty(clone, key, desc);
  }
  return clone;
}
```

四个实现要点：① **WeakMap 必须在递归之前登记**（`seen.set(value, clone)` 在遍历子属性之前），否则循环引用会无限递归栈溢出；② **用 WeakMap 而非 Map**——键是对象，WeakMap 的弱引用让原对象可被 GC，不泄漏；③ **`Reflect.ownKeys` 而非 `for...in`**——前者含 symbol 键与不可枚举键，后者只有可枚举字符串键；④ **访问器属性（getter/setter）原样复制描述符**，不能求值后当数据属性存（否则 getter 的动态语义丢失）。

## 自测（输出 ALL PASS）

```js
function assert(cond, msg) {
  if (!cond) throw new Error("FAIL: " + msg);
}

// 1. 原始值
{
  assert(
    deepClone(1) === 1 &&
      deepClone("s") === "s" &&
      deepClone(null) === null &&
      deepClone(undefined) === undefined,
    "原始值",
  );
}
// 2. Date / RegExp 深拷贝且类型保留
{
  const d = deepClone(new Date(123));
  assert(d instanceof Date && d.getTime() === 123, "Date");
  const r = deepClone(/ab+c/gi);
  assert(
    r instanceof RegExp && r.source === "ab+c" && r.flags === "gi",
    "RegExp",
  );
}
// 3. 嵌套对象/数组深拷贝, 改副本不影响原
{
  const o = { a: 1, b: { c: [1, 2, { d: 3 }] } };
  const cl = deepClone(o);
  cl.b.c[2].d = 99;
  assert(o.b.c[2].d === 3, "原对象不受影响");
  assert(cl.b.c[2].d === 99, "副本独立");
}
// 4. Map / Set 深拷贝
{
  const m = new Map([["k", { v: 1 }]]);
  const cm = deepClone(m);
  cm.get("k").v = 99;
  assert(m.get("k").v === 1 && cm.get("k").v === 99, "Map 深拷贝");
  const s = new Set([{ x: 1 }]);
  const cs = deepClone(s);
  [...cs][0].x = 99;
  assert([...s][0].x === 1 && [...cs][0].x === 99, "Set 深拷贝");
}
// 5. 循环引用不死循环
{
  const o = { name: "a" };
  o.self = o;
  const cl = deepClone(o);
  assert(cl.self === cl && cl.name === "a", "循环引用");
}
// 6. 原型保留 (class 实例的方法仍可用)
{
  class P {
    constructor() {
      this.x = 1;
    }
    m() {
      return this.x;
    }
  }
  const cl = deepClone(new P());
  assert(cl instanceof P && cl.m() === 1, "原型保留");
}
// 7. symbol 键
{
  const sym = Symbol("s");
  const cl = deepClone({ [sym]: 1, a: 2 });
  assert(cl[sym] === 1 && cl.a === 2, "symbol 键");
}
// 8. 访问器属性 (getter) 原样复制为访问器
{
  const cl = deepClone({
    get now() {
      return 42;
    },
  });
  assert(cl.now === 42, "getter 可求值");
  assert(
    typeof Object.getOwnPropertyDescriptor(cl, "now").get === "function",
    "getter 保留为访问器",
  );
}
// 9. 数组保持类型与长度
{
  const cl = deepClone([1, 2, 3]);
  assert(Array.isArray(cl) && cl.length === 3, "数组");
}
// 10. 函数按引用返回 (不克隆)
{
  const f = () => 1;
  assert(deepClone({ fn: f }).fn === f, "函数按引用");
}

console.log("ALL PASS");
```

## 生产延伸

### 1. structuredClone 的边界

原生 `structuredClone`（浏览器与 Node 17+）能处理循环引用、Date/RegExp/Map/Set/ArrayBuffer/TypedArray 等结构化数据，但**不能克隆函数、DOM 节点、类的方法（原型链丢失，class 实例变普通对象）、Symbol**。所以「拷贝一个含方法的 class 实例」或「拷贝含函数的配置对象」时，structuredClone 会抛错或丢东西——这正是手写 deepClone（保留原型）仍有价值的场景。

### 2. 性能与栈深度

递归深拷贝对**超深嵌套**会栈溢出（每层一个调用帧），对**超大对象**有性能开销。生产优化：① 用显式栈替代递归避免爆栈；② 对已知纯 JSON 数据用 structuredClone（原生实现更快）；③ 不可变数据结构（Immer、persistent data structure）用「结构共享」避免全量拷贝——只复制被修改的路径。

### 3. 与项目经验的连接

- **yukino-code 的 `conversation.fork()`**：fork 子代理时用 `structuredClone` 复制父对话历史（含长期记忆注入标志、usage anchor），正是「深拷贝一个含嵌套结构的快照」的真实场景。
- **yukino-codegen 的 transcript 重建**：客户端从事件流重建对话时，对消息对象做深拷贝避免共享引用被后续事件污染。
- **缓存副本隔离**：[LRU 缓存](/interview/code/lru-cache) 返回对象时，若调用方可能修改，需深拷贝避免「缓存值被外部改脏」（或约定缓存值只读）。

面试时能把「手写深拷贝」上升到「JSON 法的六类缺陷、structuredClone 的边界、WeakMap 防环、原型与访问器保留、结构共享优化」，就是从「背模板」到「懂语义」的分水岭。

---

**延伸阅读**

- [JavaScript 与 TypeScript 题库](/interview/qa/js-ts-language)：原型链、描述符、WeakMap、symbol 等语言基础。
- [LRU 缓存](/interview/code/lru-cache)：缓存副本隔离与深拷贝的关系。
- [EventEmitter 发布订阅](/interview/code/event-emitter)：事件载荷的拷贝隔离（避免消费者改脏共享对象）。
- [Yukino Code 执行内核与上下文工程题库](/interview/qa/yukino-code-engine)：conversation.fork() 的 structuredClone 快照复制。
