---
title: "代码题：JS 手写基础系列（curry/compose/instanceof/new/bind/flat/deepEqual）"
description: "零依赖可运行的 JS 手写基础合集与自测：柯里化、compose/pipe、instanceof 原型链、new 的返回对象覆盖、call/apply/bind 与 bind 作构造器、flat 递归展平、deepEqual 含 NaN 与 symbol 键，每题给采分点与陷阱"
---

零依赖、可直接 `node` 运行的代码题参考实现。这是 JS 面试最高频的一批「手写基础题」合集——每题都短，但采分点在于**讲清语义边界与陷阱**，而不是背模板。

:::note 运行方式
本文代码零依赖、可直接用 `node` 执行，自测输出 `ALL PASS`。
:::

## 为什么这些题高频

这些题考的不是算法难度，而是**对 JS 语言机制的理解**：原型链、this 绑定、闭包、`Symbol`、`Object.is`、描述符。面试官用它们快速判断「你是真懂 JS 还是只会用框架」。每题的采分点都在「边界情况」——下面逐题给出实现 + 陷阱。

## 1. curry（柯里化）

```js
function curry(fn) {
  return function curried(...args) {
    if (args.length >= fn.length) return fn.apply(this, args);
    return (...more) => curried.apply(this, [...args, ...more]);
  };
}
```

**采分点**：① 用 `fn.length`（形参个数）判断「参数是否收齐」；② 收齐就 `apply` 执行，未收齐返回一个继续收集的新函数；③ 支持 `c(1)(2)(3)`、`c(1,2)(3)`、`c(1)(2,3)` 多种调用形态。**陷阱**：`fn.length` 不含默认参数与 rest 参数之后的形参，对 `(a, b=1, ...rest)` 这类签名会失真——生产柯里化要额外处理。

## 2. compose / pipe（函数组合）

```js
const compose =
  (...fns) =>
  (x) =>
    fns.reduceRight((v, f) => f(v), x); // 右到左
const pipe =
  (...fns) =>
  (x) =>
    fns.reduce((v, f) => f(v), x); // 左到右
```

**采分点**：① `compose` 右到左（`compose(f,g)(x) === f(g(x))`，数学记法），`pipe` 左到右（更符合阅读顺序）；② 用 `reduce`/`reduceRight` 把函数串成数据管道。**陷阱**：空函数列表时 `reduce` 无初值会抛错——这里传了 `x` 作初值，空列表返回 `x` 本身（合理）。Redux 的 `compose`、lodash 的 `flow`/`flowRight` 就是这个。

## 3. instanceof（原型链查找）

```js
function myInstanceof(obj, Ctor) {
  if (obj === null || (typeof obj !== "object" && typeof obj !== "function"))
    return false; // 原始值直接 false
  let proto = Object.getPrototypeOf(obj);
  const target = Ctor.prototype;
  while (proto !== null) {
    if (proto === target) return true;
    proto = Object.getPrototypeOf(proto); // 沿原型链上溯
  }
  return false;
}
```

**采分点**：① `instanceof` 的本质是「沿 obj 的原型链查找是否出现 `Ctor.prototype`」；② 原始值（数字、字符串）直接返回 false；③ 用 `Object.getPrototypeOf` 而非已废弃的 `__proto__`。**陷阱**：跨 realm（iframe / vm）时 `instanceof` 会失效（不同 realm 的 `Array.prototype` 不是同一个对象），此时要用 `Array.isArray` 或 `Object.prototype.toString.call`。

## 4. new（构造器调用）

```js
function myNew(Ctor, ...args) {
  const obj = Object.create(Ctor.prototype); // 1. 创建对象, 原型指向 Ctor.prototype
  const ret = Ctor.apply(obj, args); // 2. 以 obj 为 this 执行构造器
  // 3. 构造器返回对象/函数则用它, 否则返回 obj
  return ret !== null && (typeof ret === "object" || typeof ret === "function")
    ? ret
    : obj;
}
```

**采分点**：new 的四步——创建空对象、链接原型、绑定 this 执行、**判断返回值**。最容易被漏的是第 4 步：**构造器显式返回对象/函数时，new 的结果是那个返回值而非 this**（返回原始值则被忽略）。

## 5. call / apply / bind（this 绑定）

```js
function myCall(fn, thisArg, ...args) {
  thisArg = thisArg == null ? globalThis : Object(thisArg); // null/undefined -> 全局; 原始值装箱
  const key = Symbol("fn"); // 用 Symbol 避免与已有属性冲突
  thisArg[key] = fn;
  const result = thisArg[key](...args); // 作为 thisArg 的方法调用, this 即 thisArg
  delete thisArg[key]; // 清理, 不污染对象
  return result;
}

function myBind(fn, thisArg, ...preset) {
  return function bound(...later) {
    if (new.target) {
      // 作为构造器调用: 忽略绑定的 this, 用 new 语义
      const obj = Object.create(fn.prototype);
      const ret = fn.apply(obj, [...preset, ...later]);
      return ret !== null &&
        (typeof ret === "object" || typeof ret === "function")
        ? ret
        : obj;
    }
    return fn.apply(thisArg, [...preset, ...later]); // 偏应用: 预设参数 + 后续参数
  };
}
```

**采分点**：① `call` 的原理是「把函数临时挂成对象的方法再调用」，this 自然指向该对象；② 用 `Symbol` 做临时键避免冲突，调用后 `delete` 清理；③ `thisArg` 为 null/undefined 时指向全局，原始值要装箱（`Object(thisArg)`）；④ **bind 的两大语义**——偏应用（预设参数）+ **作为构造器调用时忽略绑定的 this**（`new.target` 判断），这是最容易被漏的边界。

## 6. flat（数组展平）

```js
function flat(arr, depth = 1) {
  return depth > 0
    ? arr.reduce(
        (acc, v) => acc.concat(Array.isArray(v) ? flat(v, depth - 1) : v),
        [],
      )
    : arr.slice();
}
function flatInfinity(arr) {
  return arr.reduce(
    (acc, v) => acc.concat(Array.isArray(v) ? flatInfinity(v) : v),
    [],
  );
}
```

**采分点**：① `depth` 控制展平层数，每递归一层减 1，到 0 停止；② `Infinity` 版无条件递归；③ 用 `reduce + concat`。**陷阱**：原生 `Array.prototype.flat` 会跳过空槽（sparse array holes），手写版用 reduce 也会跳过（reduce 不遍历空槽）——但若要保留空槽需特殊处理。深层嵌套用递归会爆栈，超深数组应改显式栈。

## 7. deepEqual（深比较）

```js
function deepEqual(a, b) {
  if (Object.is(a, b)) return true; // 处理 NaN === NaN 与 +0/-0
  if (
    typeof a !== "object" ||
    typeof b !== "object" ||
    a === null ||
    b === null
  )
    return false; // 原始值不等 / null
  if (Array.isArray(a) !== Array.isArray(b)) return false; // 数组 vs 对象不等
  const ka = Reflect.ownKeys(a),
    kb = Reflect.ownKeys(b); // 含 symbol 与不可枚举
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!kb.includes(k) || !deepEqual(a[k], b[k])) return false;
  }
  return true;
}
```

**采分点**：① 用 `Object.is` 而非 `===`——正确处理 `NaN`（`Object.is(NaN,NaN)===true`）与区分 `+0/-0`；② 先判原始值与 null；③ 数组与对象要区分（`Array.isArray`）；④ 用 `Reflect.ownKeys` 含 symbol 键与不可枚举键。**陷阱**：① 循环引用会无限递归（生产版要传 WeakMap 记录已比较对，见 [深拷贝](/interview/code/deep-clone) 的同款处理）；② `Date`/`RegExp`/`Map`/`Set` 需要特殊比较（本基础版只处理普通对象与数组，生产要扩展）。

## 自测（输出 ALL PASS）

```js
function assert(cond, msg) {
  if (!cond) throw new Error("FAIL: " + msg);
}

// curry: 多种调用形态
{
  const add = (a, b, c) => a + b + c;
  const c = curry(add);
  assert(c(1)(2)(3) === 6 && c(1, 2)(3) === 6 && c(1)(2, 3) === 6, "curry");
}
// compose 右到左 / pipe 左到右
{
  const inc = (x) => x + 1,
    dbl = (x) => x * 2;
  assert(compose(inc, dbl)(3) === 7, "compose: dbl(3)=6 -> inc=7");
  assert(pipe(dbl, inc)(3) === 7, "pipe: dbl(3)=6 -> inc=7");
}
// instanceof
{
  assert(myInstanceof([], Array) === true, "[] instanceof Array");
  assert(myInstanceof([], Object) === true, "[] instanceof Object");
  assert(myInstanceof({}, Array) === false, "{} 不是 Array");
  class A {}
  class B extends A {}
  assert(myInstanceof(new B(), A) === true, "继承链");
  assert(myInstanceof(1, Number) === false, "原始值 false");
}
// new
{
  function P(name) {
    this.name = name;
  }
  P.prototype.hi = function () {
    return "hi " + this.name;
  };
  const p = myNew(P, "x");
  assert(p.name === "x" && p.hi() === "hi x" && p instanceof P, "new 基本");
  function Q() {
    return { custom: true };
  }
  assert(myNew(Q).custom === true, "new 返回对象覆盖 this");
}
// call / bind
{
  function f(a, b) {
    return this.x + a + b;
  }
  assert(myCall(f, { x: 1 }, 2, 3) === 6, "call");
  const b = myBind(f, { x: 1 }, 2);
  assert(b(3) === 6, "bind 偏应用");
  function P(n) {
    this.n = n;
  }
  const BP = myBind(P, null, "v");
  const inst = new BP();
  assert(inst instanceof P && inst.n === "v", "bind 作构造器");
}
// flat
{
  assert(
    JSON.stringify(flat([1, [2, [3, [4]]]], 1)) === "[1,2,[3,[4]]]",
    "flat 1 层",
  );
  assert(
    JSON.stringify(flat([1, [2, [3, [4]]]], 2)) === "[1,2,3,[4]]",
    "flat 2 层",
  );
  assert(
    JSON.stringify(flatInfinity([1, [2, [3, [4]]]])) === "[1,2,3,4]",
    "flat Infinity",
  );
}
// deepEqual
{
  assert(deepEqual({ a: 1, b: [1, 2] }, { a: 1, b: [1, 2] }) === true, "相等");
  assert(deepEqual({ a: 1 }, { a: 2 }) === false, "值不等");
  assert(deepEqual({ a: 1 }, { a: 1, b: 2 }) === false, "键数不等");
  assert(deepEqual([1, 2], [1, 2]) === true, "数组相等");
  assert(deepEqual(NaN, NaN) === true, "NaN");
  assert(deepEqual({ a: 1 }, null) === false, "null");
}

console.log("ALL PASS");
```

## 生产延伸

### 1. 这些手写题与真实库的对应

| 手写题          | 真实库/场景                                                            |
| --------------- | ---------------------------------------------------------------------- |
| curry           | lodash `curry`、ramda、参数化配置工厂                                  |
| compose/pipe    | Redux `compose`、lodash `flow`、中间件洋葱模型（Koa/gRPC 拦截器）      |
| instanceof      | 类型守卫、跨 realm 用 `Symbol.hasInstance` 定制                        |
| new             | 框架的依赖注入容器、工厂函数                                           |
| call/apply/bind | 函数借用（`Array.prototype.slice.call(arguments)`）、事件回调绑定 this |
| flat            | 嵌套数据展平、`Array.prototype.flat`                                   |
| deepEqual       | 测试断言（jest `toEqual`）、React `memo` 的自定义比较、状态 diff       |

### 2. 与项目经验的连接

- **compose 的洋葱模型**：gRPC 拦截器、Koa 中间件都是「compose 一串处理函数」，请求按注册顺序进入、响应按相反顺序返回（见 [中间件与分布式基础设施题库](/interview/qa/middleware-infrastructure) 的 gRPC 拦截器）。
- **deepEqual 与缓存/状态 diff**：yukino-chat 的主题切换、yukino-codegen 的团队成员列表「按内容签名去重」，本质都是深比较/哈希比较避免无谓更新。
- **bind 作构造器**：依赖注入容器里「预绑定部分参数再 new」是常见模式。

面试时能把「手写 bind」上升到「偏应用 + 作构造器时忽略绑定 this」、把「手写 deepEqual」上升到「Object.is 处理 NaN、Reflect.ownKeys 含 symbol、循环引用要 WeakMap」，就是从「背模板」到「懂机制」的分水岭。

---

**延伸阅读**

- [深拷贝](/interview/code/deep-clone)：deepEqual 的孪生题，循环引用同样用 WeakMap 处理。
- [EventEmitter 发布订阅](/interview/code/event-emitter)：call/apply/bind 的 this 绑定在事件回调里的真实应用。
- [Promise 并发池](/interview/code/promise-concurrency)：compose 在异步管道里的延伸。
- [JavaScript 与 TypeScript 题库](/interview/qa/js-ts-language)：原型链、this、闭包、Symbol、描述符的语言基础。
- [中间件与分布式基础设施题库](/interview/qa/middleware-infrastructure)：compose 洋葱模型在 gRPC 拦截器/Koa 中间件里的落地。
