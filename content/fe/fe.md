---
title: "JavaScript、DOM、浏览器与网络"
description: "JavaScript 语言核心与类型语义、DOM/BOM 与事件模型、浏览器渲染流水线与内存管理、HTTP 与 TLS、缓存与跨域、网络安全与前端弹性: 一份面向工程师的前端运行时与网络基础梳理"
---

这份文档系统梳理前端工程师必须掌握的三层知识: 语言层 (JavaScript 的类型语义、原型、this、闭包、模块与异步模型), 运行时层 (DOM/BOM、事件机制、渲染流水线与存储), 网络层 (HTTP/HTTPS、缓存、跨域、连接复用与协议演进), 并延伸出安全加固、性能指标与前端弹性设计。它的目标不是罗列 API, 而是把"为什么这样设计、边界在哪里、什么情况下会失效"讲清楚, 让你在排查线上问题时能沿着机制而不是猜测去定位。适合准备系统复习的前端工程师、需要跨层判断问题的全栈工程师, 以及要把浏览器行为讲明白的技术面试参与者阅读。文中所有结论以当前稳定规范与主流浏览器实现为准, 涉及引擎差异或提案状态时会显式标注。

## JavaScript 语言核心

### 数据类型与类型检测

JavaScript 的值分为两类: 原始类型 `undefined`、`null`、`boolean`、`number`、`string`、`symbol`、`bigint`, 以及引用类型 `object`。数组、日期、正则、Map、Set 都属于 object; 函数是可调用的对象, 但 `typeof` 对它做了特判。

`typeof` 快但粗糙, 需要记住的边界:

- `typeof null === "object"`。这是最早的实现遗留: 值的类型标签为 0 时表示对象, 而 null 的机器码恰好全为 0, 修正它会破坏大量现存代码, 于是被规范化保留。
- `typeof fn === "function"`, 但函数本质上仍是对象, 这是特例分支。
- 对未声明的变量 `typeof x` 返回 `"undefined"` 而不抛错, 这是它的安全价值; 但对处于暂时性死区 (TDZ) 的 `let`/`const` 访问会抛 `ReferenceError`。
- `typeof 10n === "bigint"`, `typeof Symbol() === "symbol"`。
- `typeof document.all === "undefined"` 且 `document.all` 为假值, 这是规范 (Annex B, `IsHTMLDDA`) 特意规定的怪异行为, 用于兼容历史上以 `document.all` 检测 IE 的代码。

更可靠的检测手段:

| 目标           | 推荐做法                                                            | 说明                                                                       |
| -------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 精确内置类型   | `Object.prototype.toString.call(v)`                                 | 返回 `[object Array]`、`[object Null]` 等, 可区分 Null/Undefined/Map/Set   |
| 数组           | `Array.isArray(v)`                                                  | 跨 realm (iframe、不同 window) 有效, 而 `instanceof Array` 跨 realm 会失效 |
| 数字是否为 NaN | `Number.isNaN(v)`                                                   | 不做隐式转换; 全局 `isNaN` 会先把参数转成数字, 行为宽松                    |
| 是否为 null    | `v === null`                                                        | `typeof` 与 `toString` 之外最直接的方式                                    |
| 普通对象       | 结合 `Object.getPrototypeOf(v) === Object.prototype` 或构造函数判断 | 排除 class 实例、`Object.create(null)` 等                                  |

`Array.isArray` 存在的原因是 realm 隔离: 不同全局环境有各自的 `Array` 构造函数, 跨窗口数组用 `instanceof` 判断会得到 false, 而 `Array.isArray` 检查的是内部数组槽。

### 相等比较与隐式类型转换

`===` 是严格相等, 类型不同直接返回 false; `==` 会按规范的抽象相等比较算法做隐式转换。`==` 的规则可以归为几条:

- 类型相同则退化为 `===` (对象比较引用)。
- `null == undefined` 为 true; 这两者与其他任何值 (包括 0 与空字符串) 比较都为 false。
- 数字与字符串比较时, 字符串经 `ToNumber` 转换。
- 布尔值参与比较先转为数字 (`true` → 1, `false` → 0)。
- 对象与原始值比较时, 对象经 `ToPrimitive` 转换: 优先调用 `Symbol.toPrimitive`, 否则按 hint 依次尝试 `valueOf`、`toString`。
- bigint 可与字符串/数字做数值比较 (字符串经 `StringToBigInt`), 但 Symbol 不参与任何隐式转换, 与数字比较直接为 false。

典型的反直觉结果:

```js
[] == false    // true: [] → '' → 0, false → 0
[] == ![]      // true: ![] 为 false, 同上
[1, 2] == "1,2" // true: 数组的 toString 以逗号连接
null == 0      // false
NaN == NaN     // false, NaN 不等于任何值
```

除了严格相等, 规范还有两个等价关系需要区分。`Object.is` 与 `===` 只在两处不同: `Object.is(NaN, NaN)` 为 true, `Object.is(+0, -0)` 为 false。`SameValueZero` 则在 `Object.is` 基础上把 `+0` 与 `-0` 视为相等, 它是 `Array.prototype.includes`、`Map`/`Set` 的键比较所采用的语义, 因此 `[NaN].includes(NaN)` 为 true, 而 `[NaN].indexOf(NaN)` 为 -1。

工程上默认使用 `===` 与 `Object.is` 处理 `NaN`、`-0` 等边界, 避免 `==` 带来的隐蔽转换; 需要宽松比较时应显式调用 `Number()`、`String()` 表达意图。

### 原型、原型链与继承

每个对象都有内部槽 `[[Prototype]]`, 指向它的原型对象, 用 `Object.getPrototypeOf` 读取 (`__proto__` 是历史遗留访问器, 已被规范附录 B 要求实现提供)。函数对象额外拥有 `prototype` 属性, 该属性的 `constructor` 指回函数本身; 通过 `new` 创建实例时, 实例的 `[[Prototype]]` 被设为构造函数的 `prototype`。

```js
function Foo() {}
const f = new Foo();
Object.getPrototypeOf(f) === Foo.prototype; // true
Foo.prototype.constructor === Foo; // true
```

读取属性时, 引擎先查对象自身, 找不到就沿 `[[Prototype]]` 逐级向上, 直到 `Object.prototype` 的 `[[Prototype]]` 为 null, 这条链就是原型链。属性屏蔽 (`Shadowing`)、`hasOwnProperty` 区分自有与继承属性、方法复用都建立在这一机制上。`in` 会检查整条链, `Object.hasOwn` 与 `Object.prototype.hasOwnProperty.call` 只检查自有属性。

`new` 运算符按三步执行: 创建 `[[Prototype]]` 为 `F.prototype` 的新对象; 以该对象为 this 调用 F; 若 F 显式返回一个对象 (含函数) 则用该返回值, 否则用新对象。把这一语义手动实现时, 用 `Object.create(F.prototype)` 建实例、`Reflect.apply` 执行构造体、再判断返回值即可; 注意 `F.prototype` 为 null 时实例原型回退到 `Object.prototype`。

继承的本质是让子类 `prototype` 的 `[[Prototype]]` 指向父类 `prototype`, 同时让子类自身 (静态侧) 的 `[[Prototype]]` 指向父类构造函数, 这就是 `class extends` 的双重原型链:`Object.getPrototypeOf(Child.prototype) === Parent.prototype` 且 `Object.getPrototypeOf(Child) === Parent`。手写时用 `Object.create(Parent.prototype)` 而非 `new Parent()` 作为中间对象, 可避免父类构造体产生的多余实例属性, 这就是寄生组合式继承。

`instanceof` 的语义是"在左值的原型链上查找右值的 `prototype`", 检查的是构造函数的 `prototype` 属性而不是构造函数本身; 右值若定义了 `Symbol.hasInstance` 则调用它, 绑定函数会对目标函数递归判断。相关边界: `1 instanceof Number` 为 false (原始值不是对象), `Object.create(null) instanceof Object` 为 false, 跨 realm 不可靠, 运行期改写 `Fn.prototype` 会让旧实例的判定结果随之改变。

`class` 是原型机制的语法糖, 但存在一批语义差异:

| 维度         | 函数 + prototype                 | class                                          |
| ------------ | -------------------------------- | ---------------------------------------------- |
| 提升         | 函数声明整体提升, 可先调用后定义 | 声明提升但不初始化, 存在 TDZ                   |
| 调用方式     | 可直接调用                       | 必须 `new`, 否则抛 TypeError                   |
| 严格模式     | 取决于上下文                     | 内部代码自动严格模式                           |
| 方法可枚举性 | 直接赋值的方法可枚举             | 方法不可枚举                                   |
| 静态成员继承 | 需手动设置                       | `extends` 自动建立, `super.x` 可取父类静态成员 |

派生类构造函数中必须先调用 `super()` 才能访问 this, 因为派生类的 this 由父类构造过程创建。`super` 通过 `[[HomeObject]]` 定位父类原型, 因此把方法从对象上取出、脱离原对象调用时, `super` 会失效。私有字段 `#x` 提供真正的运行期私有化 (外部语法层面不可访问), 与下划线约定、闭包模拟、TypeScript 的 `private` (仅类型层约束) 有本质区别。

### this 的绑定规则

this 在函数调用时动态绑定, 判定优先级从高到低:

1. new 绑定: 通过 `new` 调用时指向新创建的实例。
2. 显式绑定: 通过 `call`、`apply`、`bind` 指定; 传入 `null`/`undefined` 时, 非严格模式替换为全局对象, 严格模式保持原值。
3. 隐式绑定: 以 `obj.foo()` 形式调用时指向调用点最近的那个对象; 一旦把方法赋给变量或作为回调传递, 绑定丢失, 退回默认绑定。
4. 默认绑定: 独立函数调用, 严格模式为 `undefined`, 非严格模式为全局对象 (`globalThis` 是跨环境统一获取全局对象的入口)。

特殊情况: 箭头函数没有自己的 this, 捕获定义处所在作用域的 this, 且 `call`/`bind` 无法改变; 它也没有 `arguments`、不能作为构造函数。DOM 事件监听器中普通函数的 this 是 `currentTarget` (当前绑定监听器的元素), 箭头函数则是外层词法 this。class 实例字段中的箭头函数是固定 this 的常见手段。

`call`/`apply`/`bind` 都用于显式指定 this, 区别在调用时机与传参形式: `call` 立即调用并逐个传参, `apply` 立即调用并接收数组, `bind` 不调用、返回一个永久绑定 this 且可预置部分参数的新函数。手写 bind 有两个必须处理的细节: 普通调用时使用绑定的 this, 被 `new` 调用时绑定失效、this 应为新实例。用 `new.target` 判断即可区分两者:

```js
Function.prototype.myBind = function (ctx, ...preset) {
  const fn = this;
  function bound(...args) {
    if (new.target) return new fn(...preset, ...args);
    return fn.apply(this instanceof bound ? this : ctx, preset.concat(args));
  }
  bound.prototype = Object.create(fn.prototype);
  return bound;
};
```

`this instanceof bound` 是"被 new 调用"的兜底判断, `new.target` 是更直白的表达。原生 bind 产生的函数没有自己的 `prototype` 属性, 其 `name` 为 `bound xxx`, `length` 为原函数形参数扣除预置参数个数且不小于 0。

### 作用域、提升与闭包

JavaScript 使用词法作用域: 作用域在代码书写时确定, 与调用位置无关。函数创建时保存对外部词法环境的引用, 执行时创建自己的变量环境, 层层向外形成作用域链; 标识符解析沿链由内向外查找, 找不到时抛 `ReferenceError` (非严格模式下对未声明标识符赋值会创建全局变量)。

提升的本质是执行上下文创建时先扫描声明: `var` 提升并初始化为 `undefined`, 函数声明整体提升, `let`/`const`/`class` 提升但不初始化, 声明前的访问落在暂时性死区并抛错。`let`/`const` 还具有块级作用域, 全局的 `let`/`const` 只存在于词法环境、不挂载到全局对象上。

| 维度         | var                | let                    | const                   |
| ------------ | ------------------ | ---------------------- | ----------------------- |
| 作用域       | 函数作用域         | 块级作用域             | 块级作用域              |
| 提升行为     | 初始化为 undefined | TDZ, 提前访问抛错      | TDZ, 提前访问抛错       |
| 重复声明     | 允许               | 同作用域抛 SyntaxError | 同作用域抛 SyntaxError  |
| 全局对象属性 | 挂载               | 不挂载                 | 不挂载                  |
| 重新赋值     | 允许               | 允许                   | 不允许 (对象内容仍可变) |

`const` 约束的是绑定而不是值: 对象内容仍可修改, 要冻结需 `Object.freeze` (浅冻结) 或递归深冻结。

闭包是函数与其词法环境的组合: 函数在定义时捕获外层变量, 即使外层函数已经返回, 只要内层函数仍被引用, 这些变量就不会被回收。常见用途包括数据私有化 (模块模式)、柯里化与偏函数、记忆化、一次性函数与防抖节流的状态保存、为异步回调保留上下文。经典陷阱来自 `var` 的函数作用域:

```js
for (var i = 0; i < 3; i++) setTimeout(() => console.log(i)); // 3 3 3
for (let i = 0; i < 3; i++) setTimeout(() => console.log(i)); // 0 1 2
```

第二种写法能输出正确索引, 是因为规范对 `for` 循环的 `let` 声明做了每轮迭代创建新绑定的专门处理 (`CreatePerIterationEnvironment`), 而不是文本替换式的作用域。除 `let` 外, 用 IIFE 为每轮创建函数作用域、把值作为 `setTimeout` 的第三个参数传入、或 `bind` 预置参数, 都能达到同样效果。闭包的代价是让外层变量常驻内存, 长时间持有大对象、在循环中创建大量闭包都可能导致内存占用上升。

### 模块系统: CommonJS 与 ES Module

| 维度      | CommonJS                               | ES Module                                       |
| --------- | -------------------------------------- | ----------------------------------------------- |
| 解析时机  | 运行时同步 `require`, 路径可以是表达式 | 编译期静态分析, 路径为字面量, 支持 tree-shaking |
| 绑定语义  | 导出值的拷贝 (导出对象本身是引用)      | 活绑定, 导入方读到模块内的最新值                |
| 顶层 this | `module.exports`                       | `undefined`, 且始终严格模式                     |
| 异步能力  | 同步阻塞                               | 支持顶层 await, 加载异步                        |
| 循环依赖  | 返回已执行部分的导出 (可能是半成品)    | 通过活绑定处理, 未初始化绑定访问触发 TDZ 报错   |
| 动态加载  | `require` 天然动态                     | `import()` 返回 Promise, 用于按需加载与代码分割 |

活绑定的一个直接后果是: 模块内对导出变量重新赋值, 导入方能观察到变化; 这也意味着导出不可被导入方重新赋值 (会报错)。互操作规则: Node 中 ESM 可以默认导入 CJS 模块 (整体作为默认导出), 具名导入依赖静态分析出的 `exports` 属性; CJS `require` ESM 自 Node 22.12 与 23.0 起默认启用, 要求目标 ESM 及其依赖图不含顶层 await, 否则抛 `ERR_REQUIRE_ASYNC_MODULE`, 该能力随后回移植到 Node 20.19。ESM 中 `__dirname`/`__filename` 由 `import.meta.dirname`/`import.meta.filename` 取代。浏览器只原生支持 ESM, 需要 `type="module"` 的 script, 模块默认 defer, 跨域加载受 CORS 约束; JSON 等非 JS 资源用 import attributes 声明 (`import data from "./x.json" with { type: "json" }`)。

### Proxy、Reflect 与元编程

`new Proxy(target, handler)` 创建代理以拦截对象的基本操作, handler 支持 `get`、`set`、`has`、`deleteProperty`、`ownKeys`、`getOwnPropertyDescriptor`、`defineProperty`、`apply`、`construct` 等十余种陷阱。规范对部分陷阱设置了不变量约束, 例如不可配置且不可写的属性不能被 `get` 返回与真实值不同的结果, 违反会抛 TypeError。`Reflect` 是与这些内部方法一一对应的静态方法集合, 相比 `Object` 的同名方法返回更合理的结果 (如 `defineProperty` 返回布尔值而非抛错), 并支持 `receiver` 参数修正原型链上 getter 中的 this 指向, 这正是响应式系统里 `Reflect.get(target, key, receiver)` 必须带第三个参数的原因。

`Proxy` 的典型用途是响应式系统 (读取时收集依赖、写入时派发更新, 且嵌套对象可懒代理)、数据校验、只读视图、默认值对象与负索引数组; `Proxy.revocable` 可创建可撤销代理用于权限收回。局限是不能代理原始值, 代理对象与原对象不相等 (`proxy !== target`), 作为 Map/Set 的键时与原始对象是两个键, 且有一定性能开销。

### 迭代器、生成器与常用对象工具

迭代器协议要求对象实现 `Symbol.iterator` 方法并返回一个带 `next()` 的对象, `next()` 返回 `{ value, done }`。`for...of`、展开运算符、解构、`Array.from`、`Promise.all`、`yield*`、Map/Set 构造器都基于该协议工作; 数组、字符串、Map、Set、`NodeList`、`arguments` 都是内置可迭代对象。

生成器函数 (`function*`) 是迭代器的语法糖, 同时是一类协程: 执行到 `yield` 暂停并交出值, 外部 `next(v)` 恢复执行且 v 成为 `yield` 表达式的值, 实现双向通信; `yield*` 委托给另一个可迭代对象, `return()`/`throw()` 可从外部终止或注入异常。第一次调用 `next(arg)` 的实参会被丢弃, 因为生成器体尚未执行到任何 `yield`。异步生成器配合 `for await...of` 可以顺序消费异步数据流, 分页拉取与流式读取都用它。

`async/await` 可以理解为"生成器 + Promise 自动执行器"的语法封装: 函数体在每个 `await` 处被切分, `await` 相当于 `yield` 一个 Promise, 执行器把其落定结果通过 `next(value)`/`throw(reason)` 送回函数体继续推进, 直到函数 `return`, 返回值被 `Promise.resolve` 同化。

### 拷贝、比较与不可变更新

浅拷贝只复制第一层引用, 常见手段是 `Object.assign`、展开运算符、`Array.prototype.slice`。深拷贝需要遍历整个对象图, 主流方案的边界差别很大:

| 方案                            | 支持                                                                              | 不支持或会抛错                                                                                |
| ------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `JSON.parse(JSON.stringify(v))` | 纯数据对象与数组                                                                  | undefined/函数/Symbol 丢失, Date 变字符串, Map/Set/RegExp 变空对象, BigInt 抛错, 循环引用抛错 |
| `structuredClone(v)`            | Map/Set/Date/RegExp/ArrayBuffer/TypedArray/Error/循环引用, 支持 Transferable 转移 | 函数与 DOM 节点抛 DataCloneError, 不保留原型链, getter/setter 只取当前值                      |
| 手写递归 + WeakMap              | 可逐类型定制, 可保留原型                                                          | 需要自行处理全部边界, 复杂度高                                                                |

手写递归的要点是用 `WeakMap` 记录"原对象 → 克隆对象"的映射, 并必须在递归进入子属性之前写入映射, 否则循环引用会无限递归。用 `WeakMap` 而非 `Map` 是因为它不强引用源对象, 拷贝结束后源对象可被回收。`Reflect.ownKeys` 能同时拿到字符串键与 Symbol 键, 比 `for...in` 更完整 (后者会遍历原型链且漏掉 Symbol 与不可枚举属性):

```js
function deepClone(obj, cache = new WeakMap()) {
  if (obj === null || typeof obj !== "object") return obj;
  if (cache.has(obj)) return cache.get(obj);
  if (obj instanceof Date) return new Date(obj);
  if (obj instanceof RegExp) return new RegExp(obj.source, obj.flags);
  const clone = Array.isArray(obj)
    ? []
    : Object.create(Object.getPrototypeOf(obj));
  cache.set(obj, clone);
  for (const key of Reflect.ownKeys(obj))
    clone[key] = deepClone(obj[key], cache);
  return clone;
}
```

生产代码通常直接用 `structuredClone` 或成熟的库实现, 手写版本主要用于理解机制与处理特定类型的定制需求。

深比较 (deep equal) 的核心是对不同类型分别比对: 原始值用 `Object.is`、数组按下标递归、对象先比较键集合并集再逐键递归。对象的键顺序在语义上无关, 因此比较前对键排序或用集合比较, 否则 `{a:1,b:2}` 与 `{b:2,a:1}` 会被误判不等。通用实现还需用 `WeakMap` 记录已比对的对象对来防止循环引用死循环。

不可变更新 (immutable update) 是状态管理的基石: 不原地修改, 而是返回结构共享的新对象。实现思路是写时复制加代理 (Immer 的 `produce` 就属此路线): `get` 时懒创建子草稿, 首次 `set` 时浅拷贝当前层, 收尾阶段递归把有改动的子草稿回填到父层, 整棵无改动的子树直接复用原引用。引用相等因此成为变化检测信号, 这正是 React/Redux 中浅比较与 `memo` 能成立的前提; 局限是需要额外处理 Map/Set、数组长度缩短、`deleteProperty` 与自动冻结。

### 垃圾回收与内存管理

引擎自动管理内存的核心思想是可达性: 从根对象 (全局对象、当前调用栈、待执行回调等) 出发能被访问到的对象存活, 其余视为垃圾。标记清除从根出发标记可达对象再回收未标记对象, 是现代引擎的基础算法, 天然处理循环引用。引用计数按被引用次数归零回收, 无法处理循环引用, 早期 IE 对 DOM/COM 对象采用该策略, 曾导致经典泄漏。

V8 采用分代回收 (Orinoco):

- 新生代存放生命周期短的小对象, 用 Scavenge (Cheney 半空间复制算法): From 空间满时把存活对象复制到 To 空间并交换角色; 经历两次 Scavenge 仍存活、或复制时 To 空间占用超过一定比例的对象晋升到老生代。
- 老生代用标记清除加标记整理 (碎片过多时移动对象压缩内存)。为减少全停顿, 采用增量标记 (标记与 JS 交替执行)、惰性清理、并发标记 (辅助线程后台标记) 与并行回收。
- 大对象区单独管理, 不参与复制。

常见泄漏场景: 未清理的定时器持有回调闭包、已从 DOM 移除但仍被 JS 引用的游离节点 (detached DOM)、意外累积的全局变量、闭包长期持有大对象、未解绑的事件监听器、在 DevTools 中展开过的对象因控制台引用无法释放。`WeakMap`/`WeakSet` 的键是弱引用, 不阻止回收; `WeakRef` 与 `FinalizationRegistry` 可在对象被回收后收到通知, 但回收时机不保证, 规范不建议用它们承载关键逻辑。

### 正则表达式的回溯风险

JavaScript 正则是回溯式 NFA: 贪婪量词先尽量多吃, 匹配失败后按后进先出回溯让位。嵌套量词叠加可重叠的匹配会产生指数级回溯路径, 即灾难性回溯 (ReDoS), 例如 `/(a+)+$/` 面对一长串 `a` 加一个不匹配字符时, 引擎需要枚举所有分组划分方案才宣告失败。

危险信号包括 `(x+)+`、`(x|y)*` 中分支能匹配相同前缀、连续的 `.*.*.*`。缓解手段: 改写结构避免量词嵌套、用 `{1,64}` 之类限定长度、对输入长度做上限校验、把不可信正则放到 Worker 中并配超时 (JS 正则没有超时参数), 构建期可用静态分析工具识别高风险模式。其他需要留意的点: 带 `g`/`y` 标志的正则在 `exec`/`test` 间共享 `lastIndex`, 连续 `test` 同一字符串会交替命中, 通常用 `matchAll` 替代手写 `exec` 循环; `u` 标志下 `.` 匹配完整码点并支持 `\p{Script=Han}` 属性类; ES2024 的 `v` 标志支持字符集运算 (如 `[\p{ASCII}--[aeiou]]`)。

## 异步模型与事件循环

### 事件循环的基本结构

浏览器按 HTML 规范的事件循环模型调度。任务来源包括 `setTimeout`/`setInterval`、I/O、UI 事件、脚本整体执行、`MessageChannel`/`postMessage` 等, 它们进入任务队列 (常称宏任务); 微任务队列则承接 `Promise.then/catch/finally` 的回调、`queueMicrotask`、`MutationObserver` 以及 `await` 之后的续体。规范允许存在多个任务队列, 不同来源可以有不同的调度优先级。

执行规则可以概括为:

1. 从任务队列取出一个任务执行, 直到调用栈清空。
2. 清空整个微任务队列, 执行期间新产生的微任务一并执行, 直到队列为空。
3. 必要时进入渲染步骤: 执行 `requestAnimationFrame` 回调、样式计算、布局、绘制。
4. 回到第 1 步。

由此得到几个关键推论。微任务优先级高于下一个宏任务, 也高于渲染, 因此持续产生微任务会饿死渲染导致页面卡死, 而递归 `setTimeout` 因为每轮之间浏览器有机会渲染和响应输入, 不会完全冻结页面。`Promise` 的 executor 是同步执行的, 只有回调进入微任务队列。Node.js 的事件循环是 libuv 的阶段模型 (timers、poll、check 等), 与浏览器模型不同, 且 `process.nextTick` 的优先级高于 Promise 微任务, 两个环境不要混答。

一段典型的执行顺序可以说明"同步代码 → 微任务 → 宏任务"与 `await` 切分的关系:

```text
console.log("script start");
setTimeout(() => console.log("setTimeout"), 0);
async function async1() { console.log("async1 start"); await async2(); console.log("async1 end"); }
async function async2() { console.log("async2"); }
async1();
new Promise((resolve) => { console.log("promise1"); resolve(); }).then(() => console.log("promise2"));
console.log("script end");

输出: script start → async1 start → async2 → promise1 → script end
      → async1 end → promise2 → setTimeout
```

推理链是: 同步段依次执行, `async1` 在 `await` 处暂停, `await` 之后的代码作为微任务入队, Promise 的 executor 同步执行; 同步段结束后先清空微任务队列 (先入队的 `async1 end` 先于 `promise2`), 最后才进入下一个宏任务。顺序不唯一的情形只出现在多个微任务来源交叉时, 此时以"入队顺序"为准。

### Promise 的语义与组合方法

Promise 是一个三态状态机: `pending`、`fulfilled`、`rejected`, 状态只能单向流转一次且不可逆。核心语义包括: executor 同步执行, `resolve`/`reject` 决定终态与值; `then` 注册回调并返回新 Promise, 回调总是异步 (微任务) 执行, 从而支持链式调用; Promise 解析过程 (Promise Resolution Procedure) 会对 thenable 递归吸收其状态, 保证不同实现之间的互操作; 链上的值传递规则是返回普通值则下一个 `then` 收到该值、返回 Promise 则等待其落定、抛异常则进入 rejected 分支, `onRejected` 缺省时错误向下穿透。

规范对 thenable 的处理有几个容易漏掉的点: `then` 属性的读取要放在 `try` 中 (getter 可能抛错), 同一个 thenable 的 `resolve`/`reject` 只允许生效一次 (需要 `called` 标志), 把 Promise 的 resolve 指向它自身必须抛 TypeError (链式循环检测)。真实实现还应监听 `unhandledrejection` 捕获未被处理的拒绝。

四个静态组合方法的语义差别必须分清:

| 方法                 | 完成条件                               | 失败条件                                                       | 典型场景                          |
| -------------------- | -------------------------------------- | -------------------------------------------------------------- | --------------------------------- |
| `Promise.all`        | 全部 fulfilled, 按输入顺序返回结果数组 | 任一 rejected 立即整体 reject (其余任务不会取消, 仍在后台执行) | 并发聚合, 任一必需依赖失败即失败  |
| `Promise.allSettled` | 等待全部落定, 永不 reject              | 无                                                             | 需要完整结果或逐个处理失败        |
| `Promise.race`       | 第一个落定者 (无论成败) 决定结果       | 同上                                                           | 超时控制 (请求与延时 reject 竞速) |
| `Promise.any`        | 第一个 fulfilled 者胜出                | 全部 rejected 时以 `AggregateError` 拒绝 (`errors` 含全部原因) | 多源容灾取最快成功                |

手写组合方法的关键是计数器加保序写入: 为每个输入记录下标, 完成数达到总数时统一 resolve, 因此即使后发的请求先返回, 结果数组仍与输入顺序一致。需要注意空数组边界 (`Promise.all([])` 立即 resolve 为空数组) 与 `Promise.resolve` 对非 Promise 输入的包装。

### async/await 的行为细节

`await` 之后的代码都是微任务; `await` 一个非 Promise 值也会经过 `Promise.resolve` 包装, 因此至少产生一次微任务等待。函数体内用 `try/catch` 捕获被 await 的拒绝, 函数体外通过返回 Promise 的 `catch` 或全局 `unhandledrejection` 兜底。常见的性能陷阱是在循环中串行 `await` 本可并发的请求, 应先 `map` 出 Promise 数组再 `Promise.all`。ESM 顶层可以直接 `await`, 它会阻塞该模块及其导入方的求值, 适合初始化异步资源, 但也会推迟整张模块图的执行。async 函数之间是协作式调度, 不存在抢占, 仍是单线程模型。

超时与取消的现代做法是 `AbortController`: 同一个 `signal` 可以传给多个 `fetch` 和 `addEventListener` 组成统一取消域, `AbortSignal.timeout(ms)` 提供超时信号, `AbortSignal.any([...])` 组合多个信号。

### 定时器与帧调度

`setTimeout(fn, delay)` 的语义是"至少 delay 毫秒后把回调放入任务队列", 实际执行时间受多重因素推后: 主线程繁忙、当前任务或微任务队列未清空; 规范规定嵌套层级超过 5 层的定时器最小间隔被钳制为 4ms; 后台标签页的定时器被节流, 现代浏览器还有更激进的节流策略; 定时器本身有最小分辨率, 回调耗时也会造成后续漂移。需要稳定节拍的场景 (如倒计时显示) 应基于时间戳校准: 记录起始时间, 每 tick 用当前时间与起始时间的差值计算剩余, 而不是累加 delay。`scheduler.postTask` 提供带优先级的任务调度并支持 `delay` 与 `AbortSignal` 取消, Chromium 已支持, 其他引擎覆盖不全, 使用前应特性检测。

`requestAnimationFrame(cb)` 在浏览器下一帧绘制前调用回调并传入高精度时间戳, 与显示器刷新率对齐 (60Hz 约 16.7ms, 高刷屏更短), 页面隐藏时自动暂停。它在渲染步骤中先于样式计算与布局执行, 是集中进行 DOM 写操作、避免布局抖动的位置; 每帧只执行一次, 持续动画需要在回调内再次注册。做"帧级节流"时用它替代定时器, 天然与渲染帧对齐。

`requestIdleCallback(cb, { timeout })` 在浏览器空闲时段调用回调并传入 `IdleDeadline`, `timeRemaining()` 给出本帧剩余空闲时间, `didTimeout` 表示是否因超时强制执行。它适合日志上报、预计算等低优先级任务; 回调中应避免大量修改 DOM (会迫使布局在回调内同步发生), 修改工作应拆到 rAF 中。部分引擎 (如 Safari) 默认未启用该 API, 需要特性检测与降级。两者的常见配合是 rIC 做数据准备、rAF 做 DOM 更新, 即时间切片。

## DOM、事件与 Web Component

### 事件流与监听器选项

DOM 事件流包含捕获、目标、冒泡三个阶段: 事件从 window 沿 DOM 树向下传播到目标节点的父级 (捕获), 到达 target (目标), 再向上冒泡回 window。`addEventListener` 的第三个参数决定监听器挂在哪个阶段; 目标节点上的捕获型与冒泡型监听器按注册顺序执行。`event.target` 是事件真正发生的节点, `event.currentTarget` 是当前正在执行监听器的节点。

完整签名是 `target.addEventListener(type, listener, options)`, 第三个参数历史上是布尔值 `useCapture`, 现代规范扩展为选项对象:

| 选项      | 默认值 | 作用                                                   |
| --------- | ------ | ------------------------------------------------------ |
| `capture` | false  | true 在捕获阶段触发                                    |
| `once`    | false  | 执行一次后自动移除                                     |
| `passive` | false  | 承诺不调用 `preventDefault`, 浏览器可立即滚动而不等 JS |
| `signal`  | 无     | 传入 `AbortSignal`, 调用 `abort()` 即可批量移除监听器  |

同一 target 上 `type`、`listener`、`capture` 三者完全相同的重复注册会被忽略; 移除时 `capture` 标志必须匹配, `once`/`passive`/`signal` 不参与匹配。第二个参数也可以传实现了 `handleEvent` 方法的对象。

并非所有事件都冒泡: `focus`/`blur`、`mouseenter`/`mouseleave`、资源加载的 `load`/`error` 都不冒泡。对应的可冒泡替代是 `focusin`/`focusout`、`mouseover`/`mouseout`。但不冒泡不等于不参与传播: 捕获阶段与 `bubbles` 标志无关, 因此 `load`/`error` 仍能被祖先的捕获监听器观察到, 这也是资源加载错误监控的标准手段。`mouseenter`/`mouseleave` 虽然同样可被捕获, 但它们会对指针进入链路上的每个元素逐一派发, 捕获端一次收到一串事件、语义复杂, 实践中事件委托一律用 `mouseover`/`mouseout` 配合 `relatedTarget` 判断进出。

`passive: true` 针对的是滚动性能: `touchstart`/`touchmove`/`wheel` 的默认行为是滚动, 而监听器可能调用 `preventDefault` 取消滚动, 浏览器必须同步执行完监听器才能决定是否滚动, 主线程繁忙时滚动被阻塞。`passive: true` 是开发者对浏览器的承诺, 浏览器可立即开始滚动。Chromium 对 window、document、body 上的这几类事件默认采用 passive, 旧代码若依赖 `preventDefault` 阻止滚动 (如下拉刷新) 必须显式传 `{ passive: false }`。

原生事件对象不会被复用: 传播结束后 `target`、`type` 等属性依然可读, 只有 `currentTarget` 会在派发结束后按规范重置为 null。常被误认为"事件被清空"的是早期 React 版本的合成事件池化机制, 它在回调结束后清空属性, 该机制已被移除。

### 事件委托与传播控制

事件委托利用冒泡把子元素的监听器统一挂到共同祖先上, 通过 `event.target` 配合 `closest` 判断事件来源并分发。优点是显著减少监听器数量、动态增删子元素无需重新绑定、便于在统一入口做埋点与权限拦截; 代价是每次事件都要执行匹配逻辑, 深层 DOM 上的高频事件 (mousemove、scroll) 有一定开销, 且链条中若有人调用 `stopPropagation` 祖先就收不到事件。使用 `closest` 后应校验结果是否仍在容器内, 否则可能越权处理容器外的元素。

三个传播与默认行为控制 API 的作用完全不同: `stopPropagation()` 阻止事件继续在传播路径上移动, 但同一节点上注册的其他监听器仍会执行; `stopImmediatePropagation()` 在此基础上连同一节点后续监听器也不再执行; `preventDefault()` 阻止默认行为 (链接跳转、表单提交、右键菜单、文本选中), 与传播无关。内联 `onclick` 属性中 `return false` 等价于 `preventDefault`; 通过 `addEventListener` 或 DOM0 赋值的回调里 `return false` 没有任何效果; jQuery 回调中的 `return false` 是框架封装的 `preventDefault` 加 `stopPropagation`。`event.defaultPrevented` 可查询默认行为是否已被阻止, 供多层组件协作时判断。

### 自定义事件与合成事件

用 `CustomEvent` 构造函数创建事件, `detail` 携带任意数据, `dispatchEvent` 同步派发; 事件可取消且被 `preventDefault` 阻止时返回 false, 否则返回 true:

```js
const evt = new CustomEvent("user:login", {
  detail: { uid: 42 },
  bubbles: true, // 需要委托或祖先监听时必须开启, 默认 false
  cancelable: true,
  composed: true, // 允许事件穿透 Shadow DOM 边界
});
node.dispatchEvent(evt);
```

`bubbles` 默认为 false, 很多"自定义事件没反应"的问题源于忘记开启。合成事件的 `isTrusted` 为 false, 浏览器据此区分真实用户操作, 涉及剪贴板、全屏、弹窗等权限敏感能力时合成事件不会被认可。自定义事件同样遵循捕获/冒泡, 可用于跨组件、跨框架解耦, Web Component 对外通信也以它为标准方式。

### DOM 操作的成本与批量更新

DOM 操作慢的原因有三层: DOM 是渲染引擎中的原生对象, JS 访问需要跨语言调用; 修改 DOM 可能使样式与布局失效, 触发样式重算、重排、重绘甚至整帧流水线; 读写交错会引发强制同步布局 (layout thrashing) ——写入使布局失效后立刻读取 `offsetTop`、`getBoundingClientRect`、`clientWidth` 等几何属性, 浏览器必须立即完成一次完整布局才能返回正确值, 循环中交替读写会把一次布局放大成 N 次。

优化手段围绕"减少次数、分离读写、缩小范围"展开:

- 批量修改: 用 `DocumentFragment` 集中插入、离线构建后整体替换、先在 `display: none` 状态下修改再显示, 把多次重排合并为一次。
- 读写分离: 先一次性读完需要的几何值缓存到变量, 再统一写样式。
- 缩小影响面: 用 `contain: layout paint` 与 `content-visibility: auto` 限定布局与绘制范围; 复杂动画元素用绝对/固定定位脱离文档流。
- 变更类名代替逐条修改 `style`, 需要批量换色等场景用 CSS 变量驱动。
- 用 `ResizeObserver`/`IntersectionObserver` 替代轮询几何属性。
- 动画只改 `transform`/`opacity`, 交给合成线程处理。

### 观察者 API: Mutation、Intersection、Resize

三者都是异步回调的观察者模式, 用于替代低效的轮询与已废弃的同步 Mutation Events。

`MutationObserver` 监听 DOM 变化, 回调以微任务批量触发, 参数是 `MutationRecord` 数组, 配置项包括 `childList`、`attributes`、`characterData`、`subtree`、`attributeOldValue` 等。用途包括富文本编辑器状态同步、水印防篡改、第三方脚本 DOM 监控; 回调中再次修改 DOM 会触发新一轮记录, 需要防止死循环。

`IntersectionObserver` 异步监听目标元素与视口 (或指定 root 祖先) 的交叉状态, 可配置 `root`、`rootMargin` (支持正负值, 用于提前或延后触发)、`threshold` (0 到 1 的数组, 交叉比例跨过阈值才回调)。典型用途是懒加载、无限滚动、曝光埋点、视频自动播放暂停; 相比 scroll 监听加 `getBoundingClientRect`, 它由浏览器在合成阶段计算, 不阻塞主线程。较新的规范还提供 `isVisible` 用于真实可见性 (被遮挡、透明) 判断。

`ResizeObserver` 监听元素的尺寸变化, 回调提供 `contentBoxSize`、`borderBoxSize`、`devicePixelContentBoxSize`, 解决 window resize 无法感知元素级尺寸变化的问题, 用于响应式组件、图表自适应、文本溢出检测。回调在布局之后、绘制之前执行, 回调内修改尺寸可能触发迭代, 需要留意浏览器给出的循环警告。

### Web Component 与 Shadow DOM

Web Component 由三项技术组成。Custom Elements 通过 `customElements.define('my-card', class extends HTMLElement {...})` 注册新标签, 生命周期回调包括 `connectedCallback` (插入文档)、`disconnectedCallback` (移出)、`attributeChangedCallback` (配合 `observedAttributes` 声明的属性)、`adoptedCallback` (跨文档移动); 自主元素继承 `HTMLElement`, 定制内置元素继承具体标签并配合 `is` 属性, 后者在部分引擎上支持不完整。

Shadow DOM 通过 `attachShadow({ mode: 'open' })` 创建与主文档隔离的子树:

- 内部结构与样式默认不对外暴露, 外部样式表与选择器无法选中树内元素, 实现真正的 DOM/CSS 封装。
- 穿透通道有两类: 可继承属性 (color、font 等) 会照常继承进 Shadow, CSS 自定义属性能无视边界, 是对外暴露主题能力的标准方式。
- `:host` 选中宿主本身, `:host(.active)` 按宿主状态设置内部样式, `:host-context(selector)` 依据祖先环境切换主题 (使用时注意它把组件与环境耦合)。
- `::slotted()` 只能选中插槽的直接子节点 (一层), 不能深入; `::part()` 配合 `part`/`exportparts` 是受控开放的定制通道。
- `mode: 'closed'` 时 `element.shadowRoot` 返回 null, 外部脚本无法访问影子树, 隔离更强但调试与扩展更难。
- Constructable Stylesheets (`new CSSStyleSheet()` 加 `adoptedStyleSheets`) 可在多个实例间共享样式表, 避免每个实例重复插入 style 标签。

事件在 Shadow 边界发生 retargeting: 外部监听器看到的 `event.target` 是宿主元素, 内部监听器看到的仍是真实目标。只有 `composed: true` 的事件才穿越边界继续传播, 原生 UI 事件 (click、input、focusin) 默认 composed, `mouseenter`/`mouseleave` 等不 composed; 自定义事件需显式设置。`composedPath()` 返回含 Shadow 内部节点的完整路径, slot 分发的元素在事件路径上按扁平树定位, 理解路径要以扁平树为准。HTML Templates 的 `template` 内容不参与渲染、不加载资源、不可查询, 通过 `template.content.cloneNode(true)` 按需实例化, 是组件模板的标准载体; Declarative Shadow DOM (`template shadowrootmode`) 让纯 HTML/SSR 场景也能声明影子树。

补充能力: `ElementInternals` 让自定义元素参与表单 (`formAssociated`) 并管理可访问性状态; 生态上 Lit 是最常用的开发库, React 19 起完善了对自定义元素属性与事件的支持。

### Virtual DOM 与 key

Virtual DOM 是用轻量 JS 对象描述 UI 结构的一层抽象。渲染流程是: 状态变化后重新执行渲染函数生成新树, 与旧树 diff 得出最小 DOM 操作集, 再 patch 到真实 DOM。diff 的核心启发式 (以 React 为例) 把通用树编辑距离的立方复杂度降为线性: 只比较同层节点, 不跨层移动子树; 类型不同直接销毁重建; 列表通过 key 标识身份, 有 key 的节点按 key 在新旧列表间匹配, 能复用就移动位置, 不能复用才创建或删除。

key 的关键作用是建立稳定的节点身份映射。用数组下标作 key 时, 列表逆序、插入、删除都会让身份错位: 框架复用了错误的 DOM 与组件状态, 表现为输入框内容错位、动画错乱、内部状态串项。只有纯静态、永不重排的列表才可以安全使用下标。对 vdom 的客观评价是: 它的价值在声明式编程模型、批量更新与跨平台渲染 (React Native/SSR), 而不是"一定更快"——diff 本身有 CPU 与内存开销; 细粒度响应式方案 (编译期优化的 Vue 模板、Svelte/Solid 的编译产物、signals 类方案) 正在绕过或缩小这层成本。

## BOM 与浏览器 API

### BOM 的组成与常用接口

BOM (Browser Object Model) 是浏览器提供给 JS 操作窗口的一组对象, 核心是 `window`, 它同时是 JS 的全局对象。主要成员包括: window 本身 (定时器、`getComputedStyle`、`matchMedia`、`requestAnimationFrame`、滚动控制等), `location` (URL 与导航), `history` (会话历史栈), `navigator` (浏览器与设备信息及能力入口), `screen` (屏幕信息), `frames`/`self`/`top`/`parent`/`opener` (窗口层级), 以及挂在 window 下的 IndexedDB、Cache Storage、Web Storage 等存储接口。DOM 与 BOM 的交汇点是 `window.document`。BOM 长期没有统一标准, 由 HTML 规范的 window 章节与各浏览器事实行为共同定义。

`location` 的解析属性包括 `href`、`protocol`、`host` (含端口)、`hostname`、`port`、`pathname`、`search`、`hash`、`origin`; 操作上 `assign(url)` 跳转并保留历史, `replace(url)` 跳转但不留历史条目, `reload()` 刷新, 直接给 `location.href`/`hash` 赋值等效于 `assign`。查询串推荐用 `URLSearchParams` 解析与构造, URL 解析与拼接用 `URL` 类完成。

`history` 提供 `length`、`back()`、`forward()`、`go(n)` 与 `pushState`/`replaceState`。`pushState`/`replaceState` 可以在不触发页面加载的情况下修改 URL 与历史条目, 是 SPA 路由的基础; `popstate` 只在用户前进后退或调用 `go`/`back`/`forward` 时触发, `pushState` 本身不触发, 需要框架自行封装。`state` 对象随历史条目以结构化克隆存储, 浏览器崩溃恢复时可以还原; `history.scrollRestoration = 'manual'` 可接管 SPA 的滚动位置还原。

`navigator` 的常用能力: `userAgent` 与更现代的 User-Agent Client Hints (`userAgentData.getHighEntropyValues`), `languages`, `onLine` 与 online/offline 事件, `connection` (NetworkInformation: `effectiveType`、`downlink`、`rtt`、`saveData`), `hardwareConcurrency` (逻辑核数, 常用于决定 Worker 池大小) 与 `deviceMemory`, `clipboard` 读写 (需权限与安全上下文), `geolocation`, `permissions.query`, `storage.persist()` 申请持久存储, `serviceWorker` 注册入口。其中 `userAgentData`、`connection`、`deviceMemory` 为 Chromium 系引擎的能力, 使用前应特性检测。`navigator.sendBeacon(url, data)` 能在页面卸载时可靠发送小数据, 是埋点上报的首选 (POST、无响应回调、排队由浏览器保证)。

### 前端路由的两种模式

hash 模式修改 `location.hash` 不产生请求, 触发 `hashchange` 事件; 兼容性好, 服务端零配置, 缺点是 URL 带 `#` 且 `#` 之后的内容不发送到服务端, 直链分享与 SEO 场景受限。history 模式用 `pushState`/`replaceState` 修改 URL 无刷新, 用户前进后退时监听 `popstate` 渲染; 需要服务端把所有路由路径 fallback 到入口 HTML, 否则直接访问或刷新子路径会 404。

一个最小实现需要处理四件事: 拦截内部链接点击并调用 `pushState`、监听 `popstate` 重新渲染、做 404 兜底与滚动还原、在服务端配置 rewrite。SPA 路由的实际复杂度集中在嵌套路由匹配、异步数据预取、滚动锚点与转场动画上, 而不在 URL 切换本身。

### 页面生命周期与可见性

加载阶段 `document.readyState` 经历 `loading` → `interactive` → `complete`, 对应的事件是: `readystatechange` 在状态切换时触发; `DOMContentLoaded` 在 HTML 解析完成且 defer/模块脚本执行完毕后触发, 不等待图片等子资源, 但会等待阻塞脚本的样式表; `window` 的 `load` 在所有资源 (图片、样式、iframe 等) 加载完成后触发。

卸载与可见性阶段由 Page Lifecycle API 描述: `beforeunload` 可提示用户确认离开 (现代浏览器忽略自定义文案, 且要求用户与页面有过交互); `unload` 是历史遗留, 移动端不可靠且会阻止 bfcache, 规范上不建议使用; `pagehide` 是卸载统一入口, `event.persisted` 表示页面是否进入 bfcache; `pageshow` 每次显示时触发, `persisted` 为 true 表示从 bfcache 恢复, 需要在此恢复定时器、重连 WebSocket 等; `visibilitychange` 配合 `document.visibilityState` 用于暂停视频、降低轮询频率、上报数据; `freeze`/`resume` 在页面被冻结或恢复时触发, 用于释放非必要资源。

实践建议是把埋点与状态持久化放在 `visibilitychange` (hidden) 与 `pagehide`, 发送用 `navigator.sendBeacon` 或 `fetch` 的 `keepalive`, 而不是依赖 `beforeunload`/`unload`。使用 bfcache 时还要注意: 页面恢复后缓存的定时器不会继续运行, 需要重新建立。

### 跨窗口与跨标签通信

| 方案                | 范围                               | 特点                                                                                              |
| ------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------- |
| `postMessage`       | 跨源 iframe / `window.open` 的窗口 | 标准跨源方案, 数据走结构化克隆, 支持 Transferable 零拷贝转移, 接收方必须校验 `origin` 与 `source` |
| `BroadcastChannel`  | 同源的所有标签页/iframe/Worker     | 发布订阅模型, API 极简, 发送方自己收不到自己的消息                                                |
| `storage` 事件      | 同源标签页                         | 写 localStorage 时其他标签收到事件 (本标签不收到), 可传小数据, 兼容性好, 常作降级方案             |
| `SharedWorker`      | 同源页面                           | 共享一个 Worker, 通过 port 通信, 可做集中式状态或连接管理                                         |
| Service Worker 中转 | 同源页面                           | `clients.matchAll` 加 `postMessage`, 离线场景也可用                                               |

选型原则: 跨源 iframe 用 `postMessage` 并严格校验来源; 同源多标签实时同步 (登录态广播、编辑锁) 首选 `BroadcastChannel`; 需要兼容旧环境时退回 `storage` 事件; 低频场景可用 IndexedDB/Cache 加轮询。

### Web Worker 与 Service Worker

Web Worker 在独立线程运行脚本, 没有 DOM 访问权, 与主线程通过 `postMessage` 通信 (结构化克隆, 大 ArrayBuffer 可用 Transferable 转移所有权实现零拷贝)。类型上分 DedicatedWorker (单页面专用) 与 SharedWorker (同源多页面共享)。用途是 CPU 密集计算 (编解码、加密、大数据处理、`OffscreenCanvas` 离屏渲染), 避免阻塞主线程导致掉帧。限制包括: 无法访问 window/document/localStorage (可用 IndexedDB), 脚本需同源或满足 CORS, 创建有成本因此适合任务池化复用。

Service Worker 是注册在某个 scope 下的可编程网络代理: 页面发出的请求先经过它的 `fetch` 事件, 可由缓存、网络或合成响应应答, 从而实现离线可用。生命周期是 `register` → `install` (通常预缓存静态资源) → `waiting` → `activate` (清理旧缓存, `clients.claim()` 立即接管页面) → 处理 `fetch`/`message` 事件; 更新遵循字节对比加 `skipWaiting`。它运行在独立线程、没有 DOM, 要求 HTTPS (localhost 除外), 页面卸载后仍可被 push、background sync 等事件唤醒, 与页面之间通过 `postMessage` 加 `clients.matchAll` 通信。

```js
self.addEventListener("fetch", (e) => {
  e.respondWith(
    (async () => {
      const cached = await caches.match(e.request);
      const fetching = fetch(e.request)
        .then((res) => {
          const copy = res.clone();
          caches.open("runtime-v1").then((c) => c.put(e.request, copy));
          return res;
        })
        .catch(() => cached);
      return cached || fetching; // stale-while-revalidate
    })(),
  );
});
```

这段骨架展示了运行时缓存的通用套路: 先尝试缓存以尽快响应, 同时在后台更新缓存。四种常见策略分别是 Cache First (适合带 hash 的静态资源)、Network First (适合需要新鲜度但需离线兜底的 API/页面)、Stale While Revalidate (体验与新鲜度折中, 适合头像等非关键数据)、Cache Only / Network Only。配套实践包括: 在 `install` 中预缓存 App Shell, 缓存名带版本号; 在 `activate` 中删除旧版本避免配额膨胀; 谨慎使用 `skipWaiting` (避免新 SW 服务旧页面导致资源版本错配); 用 Navigation Preload 让导航请求与 SW 启动并行; 只缓存 GET 请求, 注意 opaque 跨域响应不可读且占用配额。

## 浏览器工作原理

### 渲染流水线

从字节到像素的主线可以概括为:

```text
HTML 字节 → 分词 → DOM ─┐
CSS 字节  → 词法/语法 → CSSOM ─┴→ 渲染树 → Style → Layout → Paint(绘制指令) → Raster(分块光栅化) → Composite
```

1. 解析: HTML 字节流经解码、分词、树构建生成 DOM。解析是流式增量的, 浏览器边下载边解析边渲染; 预加载扫描器 (preload scanner) 在主解析器被脚本阻塞时提前发现并并行请求 script/link/img 等资源。
2. CSS 解析生成 CSSOM。CSS 是渲染阻塞资源 (构建渲染树需要完整 CSSOM), 并且会阻塞其后脚本的执行, 因为脚本可能读取样式。
3. 合并 DOM 与 CSSOM 生成渲染树, 只含可见节点 (`display: none` 的子树与 head 等不进入)。
4. Style/Layout: 计算每个节点的精确几何信息, 现代实现中样式计算与布局是不同的阶段。
5. Paint: 把节点转成绘制指令列表并按层分组。
6. Raster: 把绘制指令转成位图, 通常分块 (tile) 在光栅线程池完成, 可 GPU 加速。
7. Composite: 合成线程把各层位图按变换、裁剪、透明度合成为最终帧提交显示。

理解这条流水线是分析重排重绘、层合成与性能优化的共同基础: 任何优化手段本质上都是在减少参与某个阶段的节点数、触发次数或作用范围。

### 重排、重绘与强制同步布局

重排 (reflow/layout) 是几何属性变化触发的重新布局, 之后必然紧跟重绘。触发源包括增删可见节点、改变尺寸或位置类样式、窗口 resize、字体加载完成后文本度量变化、以及读取会强制布局的几何属性。重绘 (repaint) 是外观变化但不影响几何 (color、background、visibility、box-shadow), 只重跑绘制阶段。仅合成 (composite only) 则是 `transform`/`opacity` 的变化交由合成线程处理, 主线程空闲。成本关系是重排 > 重绘 > 仅合成。

优化清单: 合并 DOM 变更 (fragment、一次 class 切换代替多条 style 写入); 读写分离, 先在循环外读完几何值; 对动画元素使用 `transform`/`opacity` 并配合 `will-change`; 让复杂动画元素脱离文档流缩小重排影响面; 用 `contain`/`content-visibility` 限定影响范围; 列表局部更新代替整体重建。需要特别注意强制同步布局: 写入使布局失效后立刻读取 `offsetTop`、`scrollTop`、`getBoundingClientRect` 等属性, 会迫使浏览器立即完成一次布局, 循环中读写交替会把一次布局放大成 N 次。

### 合成层与 GPU 加速

现代浏览器把页面拆成多个合成层 (GraphicsLayer), 各层独立光栅化为位图, 最后由合成线程在 GPU 中按变换与透明度拼合成帧。常见提升条件包括 3D transform (`translateZ(0)`、`translate3d`)、`will-change: transform/opacity`、正在对 `transform`/`opacity` 做动画或过渡、`video`/`canvas`、`filter`/`backdrop-filter`、部分内核下的 `position: fixed`, 以及与已有层重叠时的隐式提升。

`transform`/`opacity` 动画流畅的本质是: 这类变化只需合成线程对已光栅化的位图做矩阵变换或透明度混合, 不触发主线程的样式计算、布局与绘制; 即便主线程被 JS 占满, 合成线程驱动的动画依然不掉帧。这与 `left`/`top` 动画形成对比, 后者每帧都要走完布局与绘制。

注意事项: 层不是免费的, 每层占用显存与内存, 大量 `translateZ(0)` 会造成层爆炸, 移动端尤其明显; `will-change` 是"将要变化"的提示, 应在使用前短期添加、结束后移除; 某些样式会破坏层的独立性 (父级裁剪、filter 形成包含块) 导致动画回落到主线程; 层提升还会创建层叠上下文并改变 fixed/absolute 后代的包含块。定位这类问题可以用开发者工具的 Layers 面板查看层边界与提升原因。

### 阻塞资源与 async/defer

CSS 是渲染阻塞资源: 构建渲染树必须等 CSSOM 完成, 未加载完的样式表会推迟首次渲染; 媒体查询不匹配的样式表 (如 `print`) 不阻塞渲染但仍会下载。CSS 还会阻塞其后脚本的执行, 因为浏览器必须保证脚本拿到最新的 CSSOM, 而脚本又阻塞 HTML 解析, 于是一条慢 CSS 会间接冻结整个页面解析。

同步 JS 是解析阻塞资源: 没有异步属性的 script 在下载并执行期间会暂停 HTML 解析。几种加载方式的差别:

| 方式            | 下载            | 执行时机                               | 顺序保证  | 适用                  |
| --------------- | --------------- | -------------------------------------- | --------- | --------------------- |
| 普通 script     | 阻塞解析        | 下载完立即执行                         | 是        | 关键内联逻辑          |
| `async`         | 与解析并行      | 下载完立即执行 (会中断解析)            | 否        | 独立脚本 (统计、广告) |
| `defer`         | 与解析并行      | 解析完成后、DOMContentLoaded 之前      | 是        | 有依赖关系的业务脚本  |
| `type="module"` | 并行 (含依赖图) | 默认 defer 行为, 加 `async` 则尽快执行 | 是 (默认) | 模块化代码            |

动态创建的 script 默认 `async = true`。除属性外, 用 preload scanner 让资源尽早被发现、对关键第三方域名做 `preconnect` 预热、内联关键脚本省一次 RTT (代价是失去缓存) 也是常用手段。

### 关键渲染路径与资源提示

关键渲染路径 (CRP) 是首屏渲染所必需的资源与步骤。优化的三个方向是最小化关键资源数量、关键字节数与关键路径长度 (RTT 次数): 内联关键 CSS、拆分并延迟非关键 JS、给字体与首图最高优先级。

| 提示              | 作用                                   | 注意                                              |
| ----------------- | -------------------------------------- | ------------------------------------------------- |
| `dns-prefetch`    | 仅提前做 DNS 解析                      | 成本最低                                          |
| `preconnect`      | 提前完成 DNS 加 TCP 加 TLS 握手        | 连接本身有成本, 不宜对过多源使用                  |
| `preload`         | 高优先级提前下载当前页面马上要用的资源 | 必须带 `as`, 字体还需 `crossorigin`; 只下载不执行 |
| `prefetch`        | 低优先级预取后续导航可能用到的资源     | 空闲时才下载                                      |
| `fetchpriority`   | 提示单个资源的相对优先级               | 如 LCP 图片设 `high`                              |
| Speculation Rules | 声明 prerender/prefetch 规则           | 声明式控制后续导航的预渲染与预取                  |

### 多进程与多线程架构

以 Chromium 为例的进程模型: Browser 进程负责 UI、地址栏、导航协调、权限与存储管理; Renderer 渲染进程负责 HTML/CSS/JS 执行与绘制, 运行在沙箱中, 默认按站点 (scheme 加 eTLD+1) 隔离实例, 即站点隔离 (Site Isolation), 这是缓解 Spectre 类侧信道攻击的关键防线 (同一站点下不同源的页面仍可能共用进程); GPU 进程处理光栅化与合成的 GPU 调用; Network Service 进程承载网络栈; Utility 进程按需承载音视频解码与扩展等。

渲染进程内的线程包括: 主线程 (JS 执行、样式、布局、绘制指令生成), 合成线程 (接收输入事件、层合成、驱动合成器动画——滚动优先走合成线程, 除非页面上存在非 passive 的滚动类监听), 光栅工作线程池 (分块光栅化), 以及各自的 Worker 线程。架构收益是单标签崩溃不影响整体、安全沙箱、并行利用多核; 代价是内存开销, 因此浏览器对进程数设有上限并会把同站点页面合并到同一进程。跨源 iframe (OOPIF) 同样受益于站点隔离而分进程渲染。

## 浏览器存储与缓存

### 存储方案对比

| 维度       | cookie                              | localStorage        | sessionStorage                    | IndexedDB                        | Cache API                        |
| ---------- | ----------------------------------- | ------------------- | --------------------------------- | -------------------------------- | -------------------------------- |
| 容量       | 约 4KB, 每域数量有限                | 约 5 到 10MB        | 约 5 到 10MB                      | 受存储配额约束, 可达数百 MB 以上 | 同 IndexedDB, 受配额约束         |
| 生命周期   | 由 Expires/Max-Age 决定, 缺省会话级 | 永久                | 随标签页会话 (刷新保留, 关闭销毁) | 永久                             | 永久, 由脚本管理                 |
| 随请求发送 | 是                                  | 否                  | 否                                | 否                               | 否                               |
| 作用域     | 同源并按 Domain/Path 匹配           | 同源共享            | 按标签页隔离                      | 同源共享                         | 同源共享                         |
| API 形态   | 字符串解析, 繁琐                    | 同步 KV, 只存字符串 | 同步 KV                           | 异步事务型数据库, 支持索引与游标 | 面向 Request/Response 的异步缓存 |

选型建议: 会话凭证用 `HttpOnly` cookie 而非 localStorage, 以降低 XSS 窃取风险; 跨标签共享的小配置用 localStorage; 表单草稿等标签内状态用 sessionStorage; 大体积结构化数据、离线数据与文件用 IndexedDB (推荐轻封装库); HTTP 响应缓存走 Cache API 并配合 Service Worker。

### cookie 的关键属性

- `Expires` / `Max-Age`: 过期时间, 缺省为会话 cookie; `Max-Age` 优先级高于 `Expires`。
- `Domain`: 不设置时是 host-only (仅当前主机); 显式设置则包含子域, 且只能设置为当前域或其父域。
- `Path`: 路径前缀匹配才携带。
- `Secure`: 仅 HTTPS 发送。
- `HttpOnly`: JS 无法通过 `document.cookie` 读取, 抵御 XSS 窃取凭证; 它不防 CSRF, 因为请求仍会自动携带 cookie。
- `SameSite`: `Strict` 完全不带, `Lax` 允许顶层导航的 GET 携带 (Chrome 80 起缺省值为 Lax), `None` 总是携带但必须同时设置 `Secure`; 它是防 CSRF 的第一道防线, 也直接影响第三方嵌入场景 (iframe 内的 cookie 属于跨站)。
- `Partitioned` (CHIPS): 把第三方 cookie 按顶层站点分区存储, 是在限制第三方 cookie 背景下的跨站存储方案。
- 前缀约定: `__Host-` 要求 `Secure`、无 `Domain`、`Path=/`; `__Secure-` 要求 `Secure`; 服务端可据此校验 cookie 未被低权限子域篡改。

会话 cookie 的组合实践是 `HttpOnly` 加 `Secure` 加 `SameSite=Lax/Strict` 加 `__Host-` 前缀, 敏感操作再叠加 CSRF Token。

## 网络协议与传输

### 从输入 URL 到页面展示

以 HTTPS 站点为例, 完整链路可以分三段理解。

导航阶段: 解析 URL 并检查 HSTS 列表, 命中则把 http 改写为 https; 检查内存缓存、磁盘缓存与 Service Worker, 强缓存命中直接使用并跳过网络; 做 DNS 解析得到 A/AAAA 记录 (CDN 场景按调度策略返回就近节点 IP); 建立连接, `TCP` 三次握手后做 TLS 握手 (TLS 1.3 为 1-RTT, 会话复用可 0-RTT), HTTP/2 通过 ALPN 协商, HTTP/3 直接走基于 UDP 的 QUIC。

请求响应阶段: 浏览器自动带上 Cookie 与缓存验证头; 若命中协商缓存条件, 服务端返回 304; 服务端经过负载均衡、网关、应用与存储返回响应, 可能经历若干次重定向 (301/302/307/308 语义不同)。HTTP/1.1 下 keep-alive 复用连接, 但同域并发受连接数限制; HTTP/2/3 下同一连接多路复用, 不再需要域名分片。

解析渲染阶段: 流式解析 HTML 构建 DOM、解析 CSS 构建 CSSOM、执行 JS、布局、绘制、合成, 期间边下载边渲染; 之后是 DOMContentLoaded、异步数据请求、load, 空闲时执行 prefetch 等低优先级任务。

### TCP 与 TLS

TCP 三次握手的目的是让双方互认彼此的发送与接收能力以及初始序列号: 客户端发 SYN (seq=x), 服务端回 SYN+ACK (seq=y, ack=x+1), 客户端回 ACK (ack=y+1)。两次握手无法让服务端确认客户端的接收能力, 也无法阻止网络中滞留的过期 SYN 让服务端白白建立连接。四次挥手则不同: 主动方发 FIN, 被动方先回 ACK (此时可能还有数据要发, 因此 ACK 与 FIN 通常不能合并), 数据发完后再发 FIN, 主动方回 ACK 并进入 TIME_WAIT 等待 2MSL。TIME_WAIT 存在的意义是保证最后一个 ACK 丢失时对方重发 FIN 还能被确认, 同时让本次连接的旧报文在 2MSL 内从网络消逝, 避免污染后续相同四元组的连接。大量短连接导致 TIME_WAIT 堆积是经典后端问题, 连接复用可以缓解。

HTTPS 是 HTTP over TLS, 提供机密性 (对称加密传输数据)、完整性 (MAC/AEAD 校验) 与身份认证 (证书链)。TLS 1.2 需要 2-RTT: ClientHello 携带版本、加密套件、客户端随机数、SNI (指示目标域名以支持虚拟主机) 与 ALPN; ServerHello 选定参数; 服务器发送证书链与密钥交换参数; 客户端校验证书链到受信 CA、域名匹配、有效期与吊销状态 (OCSP/CRL, 服务器可用 OCSP Stapling 附带签名的吊销信息), 双方用随机数与 ECDHE 共享秘密推导会话密钥; 最后互发 Finished, 之后用对称算法 (AES-GCM、ChaCha20-Poly1305) 加密应用数据。TLS 1.3 的改进是: ClientHello 直接携带 key_share, 实现 1-RTT 并加密后续全部握手内容 (含证书); 会话恢复时可用 PSK 实现 0-RTT (但有重放风险, 只适合幂等请求); 移除了 RSA 密钥交换, 强制前向安全性, 并精简了加密套件。SNI 在传统握手中是明文的, ECH (Encrypted Client Hello) 是加密它的扩展方向。

### HTTP/1.1 到 HTTP/3

HTTP/1.1 在一个 TCP 连接上请求必须串行: 前一个响应完整返回后才能复用连接发下一个请求, keep-alive 只解决连接复用而不解决并发, 这就是应用层队头阻塞。历史的补救手段包括对同域开约六个 TCP 连接、域名分片、资源合并与内联、管线化 (响应仍需按序返回, 且代理兼容性差, 默认被禁用)。这些 workaround 带来新问题: 连接建立开销成倍增加、拥塞控制互相竞争、缓存粒度变粗。

HTTP/2 在保留 HTTP 语义的前提下重写传输层:

- 二进制分帧: 消息拆成带 stream id 的帧 (HEADERS、DATA 等), 取代文本协议, 解析更高效。
- 多路复用: 一个连接上多个 stream 的帧交错传输, 请求响应并行, 从协议层解决应用层队头阻塞, 因此资源合并与域名分片在 H2 时代反而成为反模式。
- HPACK 头部压缩: 静态表加连接内动态表再加 Huffman 编码, 显著压缩重复头部。
- 流优先级: 早期用依赖树加权重, 服务器支持程度不一, RFC 9218 又引入了新的可扩展优先级方案。
- 流控制: 基于 WINDOW_UPDATE 的按流流量控制。
- 服务器推送: 实践收益不稳定且缓存协调复杂, 浏览器均已停止支持, 属于了解即可的历史机制。

部署事实是浏览器只支持基于 TLS 的 h2 (通过 ALPN 协商), 所以启用 H2 必须先上 HTTPS。H2 的遗留短板是单个 TCP 丢包会阻塞该连接上的所有流, 这是传输层队头阻塞, 也是 HTTP/3 的动机。

HTTP/3 把传输层换成在 UDP 之上、由用户态实现的 QUIC, 解决四类问题: TCP 队头阻塞 (QUIC 原生多流, 每个流独立做可靠性与排序, 丢包只阻塞所在流); 握手延迟 (传输与 TLS 1.3 握手合一, 新连接 1-RTT, 会话恢复 0-RTT); 连接迁移 (TCP 由四元组标识, 网络切换即断连, QUIC 用 Connection ID 标识, 切换后可无缝延续); 协议僵化 (TCP 在内核态, 中间设备会干扰未知选项, QUIC 在用户态且报文除最小头外整体加密, 迭代更快)。头部压缩改用 QPACK 以适配乱序到达。落地挑战主要是部分网络对 UDP 的限速或封锁, 以及用户态协议栈带来的 CPU 开销。

### DNS 解析

以解析一个域名到 IPv4 地址为例: 先查本地缓存 (浏览器 DNS 缓存、操作系统缓存、hosts 文件), 未命中则交给递归解析器 (运营商或公共 DNS), 递归解析器自己也有缓存; 仍然未命中时它做迭代查询, 依次问根服务器得到顶级域服务器地址、问顶级域服务器得到权威服务器地址、问权威服务器得到 A/AAAA 记录, 结果按 TTL 逐级缓存返回。

需要了解的记录类型: A (IPv4)、AAAA (IPv6)、CNAME (别名)、MX、TXT (验证与邮件策略)、NS、CAA (限制可签发证书的 CA)、HTTPS/SVCB (可携带 ALPN 与 IP 提示, 支持 HTTP/3 发现与 ECH)。CDN 依赖 DNS 调度: 权威服务器根据来源 IP 与运营商返回就近节点, 常配合 Anycast。前端侧可用 `dns-prefetch` 提前解析第三方域名、`preconnect` 更进一步。安全与隐私方向上, 传统 DNS 明文可被劫持或监听, DoH (DNS over HTTPS) 与 DoT (DNS over TLS) 加密查询, DNSSEC 提供应答签名验证。TTL 的设置存在切换速度与查询频率的权衡。

### 方法与状态码

方法的语义属性 (安全、幂等、可缓存) 决定了中间件与浏览器如何对待请求:

| 方法    | 语义                         | 幂等   | 典型用途       |
| ------- | ---------------------------- | ------ | -------------- |
| GET     | 获取资源, 安全可缓存         | 是     | 读取           |
| POST    | 提交处理, 非幂等, 一般不缓存 | 否     | 创建、触发动作 |
| PUT     | 整体替换资源                 | 是     | 更新           |
| PATCH   | 部分修改                     | 不保证 | 局部更新       |
| DELETE  | 删除                         | 是     | 删除           |
| HEAD    | 同 GET 但无响应体            | 是     | 探活、取元信息 |
| OPTIONS | 查询能力                     | 是     | CORS 预检      |
| CONNECT | 建立隧道                     | 否     | 代理           |

常用状态码按类别记忆: 1xx 中 `100 Continue` 用于大 body 先探路, `101 Switching Protocols` 用于协议升级, `103 Early Hints` 可提前下发 preload 提示; 2xx 中 `200`、`201 Created`、`202 Accepted` (异步受理)、`204 No Content`、`206 Partial Content` (Range 断点续传与视频拖动); 3xx 中 `301` 永久重定向 (浏览器会缓存, 且可能把方法改写为 GET)、`302` 临时、`303 See Other` (POST 后跳 GET)、`304 Not Modified`、`307`/`308` 严格保持原方法与 body; 4xx 中 `400`、`401` (未认证)、`403` (已认证但无权限)、`404`、`405` (方法不允许)、`408`、`409` (并发冲突)、`410`、`413`、`415`、`422` (语义校验失败)、`425 Too Early` (0-RTT 重放风险)、`429` (限流, 可配合 `Retry-After`)、`431`; 5xx 中 `500`、`502` (网关拿到无效上游响应)、`503` (不可用, 可带 `Retry-After`)、`504` (网关等待上游超时)。

易混点是 `401` 与 `403` (认证与授权的区别)、`301`/`302`/`307`/`308` (永久性与方法保持)、`502` 与 `504` (上游响应非法与上游超时)。

### GET 与 POST 的区别

语义层面的区别是最本质的: GET 是安全且幂等的读取操作, 语义上不应产生副作用; POST 是提交给服务器处理, 具体语义由资源定义。由此派生出可缓存性 (GET 默认可缓存、可收藏、可预取; POST 默认不缓存)、刷新与回退行为 (GET 无提示, 刷新 POST 会提示重新提交)、爬虫与预取只敢动 GET。参数位置是惯例: GET 把参数放查询串, POST 放 body; 规范并未禁止 GET 带 body, 但许多中间件会忽略, 实践中不使用。数据形式上 GET 的查询串只能是 URL 编码文本, POST 支持多种 `Content-Type` (form-urlencoded、multipart/form-data、JSON、二进制)。

两个常见误区: "GET 有长度限制"是实现限制而非协议限制, 浏览器与服务器各自设有上限; GET 参数会留在浏览器历史、服务器日志与 Referer 中因此不宜放敏感信息, 但 POST 在 HTTP 下同样是明文, 安全性取决于是否使用 HTTPS 而非方法本身。从跨域角度看, 满足简单请求条件的 GET/POST 不触发预检, 但携带 JSON 的 POST 会触发 OPTIONS 预检。

### 同源策略与 CORS

同源策略规定只有当协议、域名 (主机)、端口三者完全相同, 两个文档才同源, 浏览器才允许它们不受限互访。它隔离的主要是"读"能力: 跨源读取 DOM (`iframe.contentDocument`) 与 JS 对象 (window.open 的句柄)、跨源 fetch 读取响应、跨源访问 localStorage/IndexedDB/cookie。不受限的是历史遗留的嵌入与导航通道: `script`/`img`/`link`/`video` 等标签可跨源加载 (响应以 opaque 形式存在, JS 读不到内容), 表单可跨源提交 (写操作, 响应被导航掉, 是 CSRF 的基础), 窗口导航可跨源。相关概念上, origin 是三元组, site 是 eTLD+1 (如 `a.b.example.com` 与 `c.example.com` 同站不同源), SameSite cookie 用的是"站"。

CORS 是浏览器实施、服务器配合的跨源放行机制。核心事实是: 跨域请求通常已经发出去了, 浏览器拦截的是"把响应交给 JS 读取"这一步, 因此服务端不能靠 CORS 阻止请求到达, CSRF 防护也不能依赖 CORS。

| 类别     | 判定条件                                                                                                                      | 交互                                                                                                                                                              |
| -------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 简单请求 | 方法为 GET/HEAD/POST, 且头部限于 safelist (Accept、Accept-Language、Content-Language、Content-Type 取特定三值, 以及 Range 等) | 直接发送, 服务器返回 `Access-Control-Allow-Origin` (匹配 Origin 或 `*`), 浏览器校验通过才交出响应                                                                 |
| 预检请求 | 不满足上述条件 (如 JSON Content-Type、自定义头、PUT/DELETE)                                                                   | 先发 OPTIONS 并带 `Access-Control-Request-Method`/`-Headers`, 服务器回应 Allow-Origin、Allow-Methods、Allow-Headers、`Access-Control-Max-Age`, 通过后才发真实请求 |
| 凭证模式 | fetch `credentials: 'include'` 或 XHR `withCredentials`                                                                       | `Allow-Origin` 不能是 `*`, 必须精确匹配 Origin 且返回 `Access-Control-Allow-Credentials: true`; SameSite 会进一步限制                                             |

其他要点: `Access-Control-Expose-Headers` 决定 JS 能读取哪些非 safelist 响应头; 预检结果会被缓存, 但各引擎对 `Max-Age` 有各自的上限; 失败时浏览器只在控制台报错, JS 拿到的只是笼统的网络错误且不带状态码; `no-cors` 模式得到的是 opaque 响应 (不可读、状态为 0), 仅用于不依赖结果的场景; 公网页面访问内网或本机地址正在被纳入权限模型 (Local Network Access), 需要用户授权, 使用前应做特性检测。跨源隔离相关的是另一组加固机制: CORP (Cross-Origin-Resource-Policy)、COOP/COEP, 页面进入 `crossOriginIsolated` 状态后才能使用 SharedArrayBuffer 等高精度能力。

生产环境中跨域问题的解决顺序是: 首选服务端正确配置 CORS; 其次用反向代理把接口收敛到同源路径 (开发期用 dev server proxy, 生产用网关); 需要嵌入第三方页面时用 `postMessage` 并校验来源; 实时双向场景用 WebSocket (不受同源策略限制, 服务端校验 `Origin`)。JSONP 只支持 GET 且无错误处理、有注入风险, 仅用于历史系统兼容; `document.domain` 降级已被现代浏览器默认禁用。

### WebSocket 与 SSE

WebSocket 的握手复用 HTTP/1.1: 客户端发送 `Upgrade: websocket`、`Connection: Upgrade`、`Sec-WebSocket-Key` (base64 随机值)、`Sec-WebSocket-Version` 与可选的子协议; 服务器返回 `101 Switching Protocols` 与 `Sec-WebSocket-Accept` (Key 加固定 GUID 的 SHA-1 后 base64), 之后连接升级为双向帧协议, 脱离 HTTP 语义。帧头包含 opcode (文本/二进制/ping/pong/close)、FIN 分片标志; 客户端到服务端的帧必须掩码 (masking, 防止中间代理缓存投毒), 支持 ArrayBuffer/Blob 二进制。协议层有 ping/pong, 但应用层通常自定义心跳以检测 NAT 超时断链; 断线不会自动重连, 需要实现指数退避重连与会话恢复。安全上应使用 `wss` 并让服务端校验 `Origin` 头, 因为 WebSocket 不受同源策略约束。

SSE (Server-Sent Events) 基于普通 HTTP 长响应 (`Content-Type: text/event-stream`), 服务端持续写入 `data:` 行, 浏览器用 `EventSource` 解析。它是单向的 (服务端到客户端), 只传 UTF-8 文本, 可带事件名与 id; 内置自动重连 (间隔由 `retry` 字段控制) 与 `Last-Event-ID` 断线续传。HTTP/1.1 下同域六连接限制会占坑, HTTP/2 下多路复用无此问题。

选型: 双向高频 (聊天、协作编辑、游戏) 用 WebSocket; 服务端单向推送 (通知、行情、日志流、AI 流式输出) 用 SSE 更简单且自带重连; 极端实时 (音视频、低延迟交互) 考虑 WebTransport/WebRTC DataChannel。

### HTTP 缓存

浏览器请求资源时的决策链是先查强缓存, 命中且未过期则直接使用 (不发请求, 状态码 200, 标注 from memory/disk cache); 否则发请求并带上协商缓存标识, 由服务器决定返回 304 (用缓存) 还是 200 (新内容)。

强缓存由 `Cache-Control` 控制, 常用指令:

| 指令                     | 含义                                                  |
| ------------------------ | ----------------------------------------------------- |
| `max-age=秒`             | 相对过期时间, 优先级高于 `Expires`                    |
| `no-store`               | 完全不存储                                            |
| `no-cache`               | 可以存储, 但每次使用前必须向服务器验证 (不是"不缓存") |
| `public` / `private`     | 控制共享缓存 (CDN) 是否可存                           |
| `immutable`              | 内容永不变, 配合 hash 文件名可在刷新时也不验证        |
| `must-revalidate`        | 过期后必须验证                                        |
| `stale-while-revalidate` | 允许先返回过期内容同时在后台验证                      |
| `stale-if-error`         | 上游出错时允许用旧内容兜底                            |

`Expires` 是 HTTP/1.0 的绝对时间, 受客户端时钟影响。响应没有显式缓存头但带 `Last-Modified` 时, 浏览器可以按 `Date` 与 `Last-Modified` 的间隔取一定比例作为启发式新鲜期, 依赖该行为不可控, 应显式设置。

协商缓存用验证器: `Last-Modified`/`If-Modified-Since` 的精度是秒级, `ETag`/`If-None-Match` 是内容指纹且优先级更高, 请求同时带两者时以 ETag 判定。两者差异在于精度 (一秒内多次修改无法区分)、语义陷阱 (内容没变但 mtime 变了会让 `Last-Modified` 失效, 分布式集群各机器 mtime 不一致也会干扰它)、验证器强度 (`W/` 前缀表示弱验证器, 只要求语义等价, 适用于 gzip 这类不改变语义的转换; 强 ETag 要求字节级一致, Range 请求依赖强验证器), 以及 `If-None-Match: *` 的"仅当资源不存在时"语义 (常用于避免并发覆盖)。

工程组合是: HTML 用 `no-cache` 保证每次验证; 带内容 hash 的静态资源用长 `max-age` 加 `immutable`; API 按需使用 ETag 减少传输。

## 网络安全与可观测

### XSS: 类型与防御

XSS 是攻击者把恶意脚本注入受信页面执行, 从而窃取凭证、伪造操作、篡改页面。三种类型: 存储型 (恶意内容持久化在服务端, 所有访问者触发, 危害最大)、反射型 (恶意内容藏在 URL 参数中被回显, 需诱导点击)、DOM 型 (完全发生在前端, 如把 `location.hash` 直接 `innerHTML` 进页面, 服务端不可见, 传统 WAF 难以拦截)。

防御按层次组织:

1. 输出编码是根本手段。按输出上下文分别编码: HTML 文本转义 `< > & " '`; 属性上下文注意无引号属性; JS 字符串上下文用 Unicode 转义; URL 参数用 `encodeURIComponent`; 富文本用白名单过滤 (如 DOMPurify), 黑名单过滤注定被绕过。
2. 避免危险 API: 优先 `textContent` 而非 `innerHTML`, 避免 `eval`/`new Function`; React 的 `dangerouslySetInnerHTML`、Vue 的 `v-html` 只在消毒后使用 (框架默认插值转义已挡掉大部分注入)。
3. CSP 是纵深防御: 用 nonce 或 hash 白名单内联脚本并配合 `strict-dynamic`, 禁用 `unsafe-inline`/`unsafe-eval` 后注入脚本无法执行, 用 `report-to` 收集违规。
4. `HttpOnly` cookie 让凭证无法被 JS 读取, 把损失从盗号降为在会话内冒用。
5. Trusted Types 在浏览器层面约束危险汇聚点只接受经策略处理的对象, 从源头收敛 DOM XSS。
6. 其他: `X-XSS-Protection` 已废弃且曾引入新问题, 应显式设为 `0`; 对子域与用户上传内容做隔离域; 输入校验只是辅助, 不能替代输出编码。

### CSRF: 原理与防御

CSRF 利用的是浏览器会自动为目标站点携带 cookie 这一事实。攻击者在自己的页面构造指向目标站点的请求, 用户若已登录, 请求就带着凭证完成转账、改密等操作; 攻击者读不到响应 (受同源策略限制), 但攻击只需要"发出请求"。

分层防御: `SameSite` cookie 让跨站请求不携带凭证, 直接瓦解大部分 CSRF; CSRF Token (同步器模式) 要求写操作携带服务端下发的不可预测 token, 跨源页面读不到; 双重提交 cookie 把 token 同时放 cookie 与请求头, 服务端比对一致性 (跨源页面能带 cookie 但读不到值, 也无法写自定义头); 要求写接口必须带自定义头 (表单无法添加, 跨源 fetch 添加会触发预检); 用 `Origin`/`Referer` 校验与 Fetch Metadata (`Sec-Fetch-Site`/`Mode`/`Dest`/`User`) 识别跨站来源并拒绝; 在规范设计上保证 GET 不产生副作用, 敏感操作加二次验证。

两个常见误解需要纠正: `HttpOnly` 不防 CSRF (请求自动带 cookie, 与 JS 能否读取无关); JSON 接口也可能被伪装——表单虽不能发任意 Content-Type, 但可以用 `text/plain` 拼出 JSON 字符串, 因此不能只靠"接口只收 JSON"这一假设。

### 点击劫持与传输层攻击

点击劫持是把目标站点用透明 iframe 覆盖在诱导按钮上, 用户以为点击的是别的功能, 实际点在目标站点的敏感操作上。防御首选 CSP 的 `frame-ancestors` (粒度细、可枚举多个来源, 优先级高于 `X-Frame-Options`); `X-Frame-Options: DENY|SAMEORIGIN` 是传统响应头, 只支持两种取值; `frame-busting` 脚本 (判断 `top !== self` 后跳转) 可被 sandbox、CSP、禁用 JS 绕过, 只能作兜底; 让 iframe 内的目标站点处于未登录状态 (SameSite) 也能让攻击失效。

中间人攻击的防御依赖 HTTPS 的证书认证与加密传输: 攻击者无法伪造能通过 CA 链校验的证书, 篡改密文会被完整性校验发现。但用户习惯输入裸域名, 首个请求常是 http, 攻击者可在这一刻降级劫持 (SSL Stripping), HSTS 让浏览器记住"此站只走 HTTPS"从而堵住这个窗口: `max-age` 指定记忆时长, `includeSubDomains` 覆盖子域, `preload` 申请进入浏览器内置预载列表以解决首次访问的信任空窗。副作用是一旦证书配置错误, 用户没有任何绕过入口, 因此上线前需充分验证。配套加固包括证书透明度日志 (便于发现误签与盗签)、OCSP Stapling (服务器附带盖章的吊销状态, 兼顾隐私与性能)、混合内容清理 (HTTPS 页面加载 HTTP 资源会被阻止或自动升级)、以及给敏感 cookie 加 `Secure` 与 `__Host-` 前缀。

### 错误监控与 sourcemap 还原

采集层需要覆盖的错误类型: JS 运行时错误 (window 的 `error` 事件与 `addEventListener('error')`; 跨域脚本报 `Script error.` 时需要脚本响应加 CORS 头且 script 标签加 `crossorigin` 才能拿到细节); 资源加载错误 (`error` 事件不冒泡, 但可在捕获阶段监听, 依 `target` 区分 img/script/link); 异步错误 (`unhandledrejection`; 框架层 React ErrorBoundary 只捕获渲染期错误, Vue 有 `app.config.errorHandler`); 接口错误 (包装 fetch/XHR 原型方法记录状态码、耗时与上下文); 白屏检测 (用 `elementsFromPoint` 采样判定关键区域是否有有效渲染, 或结合 `MutationObserver` 与超时兜底)。

上报设计上, 错误按"类型加 message 加堆栈前几帧"计算指纹做去重与聚合, 用采样率与限流防止雪崩, 用 `sendBeacon` 或 `fetch keepalive` 保证页面卸载时不丢, 并附带版本、用户与环境维度以及用户最近操作轨迹作为面包屑。

sourcemap 还原的流程是: 构建时生成不在产物中暴露引用地址的 sourcemap, 上传到监控平台并按版本关联; 服务端用 source-map 库根据行列号反查原始文件、行号与源码片段。要点是 sourcemap 绝不能部署到公网, 版本必须与产物严格对应否则还原错位; App 内嵌页面还需处理 JSBridge 注入代码导致的行号偏移。

## 性能优化

### 核心 Web 指标

| 指标                   | 含义                                                                                          | 目标 (75 分位) | 主要优化方向                                                                                          |
| ---------------------- | --------------------------------------------------------------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------- |
| LCP (最大内容绘制)     | 视口内最大图片或文本块的渲染完成时间                                                          | ≤ 2.5s         | 降低 TTFB (CDN、缓存、SSR)、资源优先级 (preload 首图、fetchpriority)、图片压缩与格式、消除渲染阻塞    |
| INP (交互到下一次绘制) | 一次交互从输入到下一帧绘制的完整耗时 (输入延迟加处理时长加呈现延迟), 取页面生命周期内的高分位 | ≤ 200ms        | 拆分长任务、减少主线程 JS、事件回调瘦身、延后非关键工作、避免巨型 DOM                                 |
| CLS (累积布局偏移)     | 非预期布局抖动的累积量                                                                        | ≤ 0.1          | 媒体元素写死宽高或用 aspect-ratio、为嵌入位预留空间、字体加载策略、把新内容插到视线下方或响应用户操作 |

INP 自 2024 年 3 月起正式取代 FID, 二者的区别是 FID 只看首次交互的输入延迟, 而 INP 覆盖整个生命周期且包含处理与呈现时间, 更接近真实体验。辅助指标包括 TTFB、FCP 与实验室环境下的 TBT。采集方式上, 真实用户监控用 web-vitals 库基于 `PerformanceObserver` 上报, 实验室用 Lighthouse/WebPageTest, 群体数据看 CrUX 与 Search Console。实践中强调先用 RUM 数据定位最差分位, 再对症下药。

### 长列表渲染

核心思路是减少同时存在的 DOM 节点数与每帧工作量:

1. 虚拟列表 (windowing): 只渲染可视区加缓冲区的行, 外层容器撑出总高度, 滚动时复用或重建节点。固定行高实现简单; 动态行高需要预估高度、实测缓存与滚动位置校正。
2. 分页与无限滚动: 用 `IntersectionObserver` 监听哨兵元素加载下一页, 配合加载态与错误重试。
3. 单行渲染轻量化: 行组件 memo、稳定 key、事件委托代替每行绑定监听器、避免行内复杂选择器。
4. 时间切片: 非首屏数据分片渲染, 用 React 的并发特性 (如 `useTransition`) 把列表更新标记为非紧急。
5. CSS 手段: `content-visibility: auto` 加 `contain-intrinsic-size` 让浏览器跳过屏外行的渲染, 接近原生虚拟化但不减少 DOM 节点数。
6. 数据层: 窗口化数据而非全量入状态, 大数据量的排序过滤放 Web Worker, 传输用流式或二进制格式。

虚拟列表的代价是页面内查找失效、SEO 不友好、动态高度与滚动锚定复杂, 需要按场景权衡。

### 加载性能

按"减少体积、减少请求、加快传输、优化执行"四步梳理。减少体积方面: 构建期 minify、tree-shaking、作用域提升, 产物用 brotli/gzip 传输压缩; 路由级与组件级代码分割, 第三方大库按需引入; 图片用 WebP/AVIF 与 `srcset`/`sizes`, 懒加载用 `loading="lazy"` 或 `IntersectionObserver`; 字体做子集化、用 woff2、配合 `font-display` 与 preload。

调度方面: HTTP/2/3 多路复用下不必强行合并, 但应控制请求总数与瀑布深度; 内联关键 CSS, 非关键 JS 用 defer; 用 preload/prefetch/preconnect/fetchpriority 精准调度; 路由跳转前预取数据与代码。

传输方面: CDN 就近分发与边缘缓存; 静态资源 hash 命名加一年强缓存与 immutable, HTML 用 no-cache 保证发版即时生效; HTTP/3 降低弱网下的握手与队头阻塞成本; 接口层做聚合、字段裁剪、分页与协商缓存。

执行与架构方面: SSR/SSG/流式渲染缩短首屏可见时间, islands 与选择性 hydration 降低注水成本; 长任务拆分、重计算移入 Worker; 第三方脚本治理 (async/defer、facade 模式延迟加载); Service Worker 预缓存 App Shell; 建立性能预算并在 CI 中卡控。相关机制 (tree-shaking 的失效场景、SSR 与 hydration 的常见问题、微前端的隔离方案、HMR 原理) 细节较多, 见 [Vite 与构建](vite) 与 [React](react) 文档。

## 前端弹性: 降级、限流与上报

### 降级与熔断

服务降级是在系统负载过高或下游不可用时主动放弃部分非核心功能以保住核心链路; 服务熔断是当对某个下游的调用失败率达到阈值时自动断开调用、直接走兜底, 经过冷却期后半开探测恢复。区别在于降级通常是主动的、全局的策略, 熔断是被动的、局部的保护机制。经典的熔断器状态机:

```text
Closed ──失败率/连续失败数超阈值──▶ Open ──冷却计时到期──▶ Half-Open
  ▲                                                            │
  └──────────── 探测请求成功 ◀──────────────────────────────────┘
                探测请求失败 ──▶ 回到 Open 重新计时
```

工程实现还需要滑动窗口统计 (只看最近一段时间或最近 N 次请求)、最小请求数 (样本不足时不熔断, 排除误判) 与慢调用熔断 (除错误率外, 对 P99 超时的请求占比做阈值)。前端侧的降级策略分几层: UI 层延迟加载或隐藏非核心组件、按 `prefers-reduced-motion` 或设备能力关闭动画、图片降级为低分辨率; 数据层在接口超时或失败时展示缓存数据或本地兜底数据、降低轮询频率; 功能层用开关关闭实时通知、把复杂编辑器降级为纯文本、把 WebSocket 降级为定时轮询; 加载策略层按骨架屏、loading、纯文本的次序降级。开关通常由配置中心下发, 前端启动时拉取并据此决定加载哪些模块。

### 限流算法与前端限流

| 算法         | 原理                                             | 优点                         | 缺点                                   |
| ------------ | ------------------------------------------------ | ---------------------------- | -------------------------------------- |
| 固定窗口计数 | 每个时间窗口维护计数器, 超阈值拒绝, 窗口结束重置 | 实现简单, 内存开销小         | 窗口切换瞬间可能承受约两倍流量         |
| 滑动窗口计数 | 把窗口细分或记录请求时间戳, 统计滑动范围         | 流量更平滑                   | 子窗口或日志越多内存开销越大           |
| 漏桶         | 请求入桶, 以固定速率流出, 桶满拒绝               | 输出速率恒定, 保护下游效果好 | 无法利用突发, 即便有容量也只能匀速处理 |
| 令牌桶       | 以固定速率放入令牌, 请求取到令牌才处理           | 允许一定程度的突发流量       | 突发可能瞬时打高下游                   |

令牌桶与漏桶的关键区别就是是否允许突发: 令牌桶在桶中有令牌时可以快速放行多个请求, 漏桶强制匀速。前端的限流不依赖这些服务端算法, 而是围绕用户体验做: 限制并发请求数并让超出的请求排队 (并发池), 用防抖处理按钮连点、用节流限制搜索与滚动上报频率, 失败重试用指数退避并加入抖动避免惊群, 短时间内多次触发的同类请求做合并 (批量查询), 以及用 `AbortController` 取消已过期的请求。

### 监控上报的限流

监控 SDK 需要同时满足"不丢关键错误"与"不打爆后端", 常见组合是: 全局与分层采样 (性能数据低采样率、JS 错误全量); 按指纹在时间窗口内去重; 每秒最多上报固定条数, 队列满时按优先级丢弃; 批量缓冲后定时发送以减少请求数; 收到 429 后自动降频, 也接受服务端下发的动态采样率; 上报失败的数据暂存本地, 网络恢复后分批补发。判定的优先级通常是 JS 运行时错误高于接口错误, 高于性能与行为数据。

## 语言与运行时进阶

### TypeScript 的编译流水线

TypeScript 编译器本质是带类型擦除的转译器, 从源码到产物经过六个阶段: 扫描 (源码切成 Token, 注释以 trivia 形式挂在 Token 上供输出阶段保留); 解析 (Token 生成 AST, 语法错误不中断解析, 便于 IDE 继续工作); 绑定 (遍历 AST 建立符号表, 把同名标识符关联到同一 Symbol, 为名称解析提供基础); 类型检查 (类型推断、赋值兼容性、基于流图的控制流分析做类型收窄、泛型实例化与条件类型求值等, 类型错误默认不阻断编译, 因为类型信息不参与转译结果); 转换 (按 target 做降级: 删除类型标注与断言、把 enum 展开为立即执行函数、把装饰器改写为 `__decorate` 辅助调用、把 `async/await` 降级为生成器状态机、把 ESM 改写为 CJS 等); 发射 (把 AST 打印为 JS, 从符号表与类型信息生成声明文件, 生成 VLQ 编码的 sourcemap)。

```text
源码 → Scanner → Parser → Binder(符号表) → Checker(类型) → Transformer(降级) → Emitter
                              │                                          │
                              └──────── 类型信息只用于检查 ──────────────┘
```

工程含义: 类型标注在运行期零成本 (纯删除), 但类型检查与转译是两件事, 因此现代链路普遍用原生实现 (Rust/Go) 的转译器负责降级、用 `tsc --noEmit` 单独负责类型检查。增量编译通过 `.tsbuildinfo` 记录签名与依赖图, 二次编译跳过未变化文件。语言服务 (Language Service) 复用同一套编译器 API 驱动编辑器的跳转、补全与重构, 编辑时增量重解析。

### V8 的执行与优化

隐藏类 (Hidden Class, 也称 Map 或 Shape) 是 V8 加速属性访问的核心: 对象按属性添加顺序形成转换链, 每一步生成新 Map 并记录属性名到偏移量的映射; 形状相同的对象共享 Map, 属性访问就能编译为固定偏移的机器码。由此得到几条编码守则: 构造函数里按固定顺序初始化全部属性; 避免 `delete` (会退化为字典模式); 避免运行期增删属性或修改原型; 不要让不同形状的对象混进同一个数组或同一个多态调用点。

内联缓存 (Inline Cache) 在属性访问字节码处记录"上次对象的 Map 与命中偏移": 单态 (总是同一个 Map) 直接比较 Map 后按偏移取值, 最快; 多态 (少数几种 Map) 走小跳转表; 超态则退化为哈希查表, 热点代码要避免。TurboFan 基于 IC 反馈做推测优化, 假设失败时按检查点去优化回退字节码。现代 V8 已形成 Ignition (解释器)、Sparkplug (基线编译)、Maglev (中层 JIT)、TurboFan (顶层优化) 的多层执行管线, 代码按热度逐级晋升。逃逸分析可以在证明对象不逃逸出函数时做标量替换, 把对象字段拆成局部变量, 省掉堆分配与 GC。

其他要点: 函数内联会把小函数直接展开; 数组有元素种类 (PACKED_SMI、PACKED_DOUBLE、PACKED_ELEMENTS 等) 且单向迁移, 稀疏或类型混杂会退化为 HOLEY 甚至字典模式, 保持数组紧凑与同类型很重要; 小整数以 SMI 内联在指针中, 超出范围才分配为堆上的数字对象; 字符串拼接先以 cons string 保存切片树, 截取可能产生 sliced string。总体原则是让形状与类型稳定、热点函数小而纯。

### 与框架、标准相关的近期演进

顶层 await 与类私有字段已进入稳定标准; `Object.hasOwn`、`Array.prototype.at`、`findLast` 等补齐了常用操作; 正则的 `d` 标志提供捕获组下标, `v` 标志引入字符集运算; ES2024 落地了 `Object.groupBy`/`Map.groupBy`、`Promise.withResolvers` 与 `v` 标志; ES2025 定稿了 Set 集合方法 (union/intersection/difference 等)、Iterator Helpers、`Promise.try`、`RegExp.escape`、`Float16Array` 与 import attributes。`structuredClone` 需要特别注意: 它是 HTML 标准的 Web API 而非 ECMAScript 特性, 因此不受语言版本约束。

提案方向上需要区分"已成标准"与"仍在推进": Temporal 已进入标准轨道, 引擎支持仍在逐步落地, 生产使用前务必做特性检测或引入 polyfill; 装饰器已由 TypeScript 5 起按标准形式实现; 浏览器端的 JavaScript Signals 提案 (Signal.State、Signal.Computed、Signal.subtle.Watcher) 仍处于早期阶段, 其定位是把各框架的响应式核心语义收敛为语言级原语, 以便框架互操作与工具支持, 目前仍需 polyfill 或框架自带实现; 它容易与 `AbortSignal` 混淆, 后者是已广泛落地的取消机制。模式匹配、值类型 (原 Record & Tuple 方向) 等仍在提案阶段, 不应在产品代码中依赖。

## 手写实现专题

手写实现的价值不在背代码, 而在把规范语义逼到边界: 每个实现都会暴露一两个容易被忽略的行为。下表按主题归纳关键点。

| 实现对象              | 核心机制                                                        | 容易忽略的边界                                                                             |
| --------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `call`/`apply`/`bind` | 用唯一键把函数临时挂到目标对象上调用; `new.target` 区分构造调用 | 目标为 null 时的严格/非严格差异; 原始值 this 会被装箱; bind 结果的 `length` 要扣除预置参数 |
| `new`                 | 建对象、设原型、执行构造体、判断返回值                          | `F.prototype` 为 null 时回退到 `Object.prototype`; 箭头函数没有 `[[Construct]]`            |
| `instanceof`          | 沿原型链查找右值的 `prototype`                                  | `Symbol.hasInstance` 优先; 跨 realm 不可靠                                                 |
| 防抖与节流            | 用定时器或时间戳控制执行时机                                    | leading/trailing 组合; 执行间隔要能取消与立即触发 (flush)                                  |
| 柯里化                | 累积参数直到满足元数或收到终止信号                              | 用 `fn.length` 时, 默认值与剩余参数会截断计数; 参数超过元数时用 `>=` 判定                  |
| 深拷贝                | WeakMap 记录已拷贝对象, 按类型分支                              | 必须在递归前写入映射; 需要覆盖 Symbol 键与不可枚举属性                                     |
| 深比较与深合并        | 按类型分支递归, 对象比较键集合的并集或共有键                    | 键顺序无关; 区分"键不存在"与"值为 undefined"                                               |
| Promise               | 状态机加回调队列, 解析过程吸收 thenable                         | thenable 的 `then` 读取要 try; 只允许落定一次; 返回自身要抛错                              |
| Promise 并发池        | 共享游标或迭代器, 每个 worker 循环取任务                        | 单线程同步段的 `idx++` 不需要锁; 并发数取任务数与上限的较小值                              |
| `flat`                | 递归或显式栈实现降维                                            | 稀疏数组的空位要被丢弃, 迭代时用 `i in arr` 判断                                           |
| 不可变更新            | 代理加写时复制, 收尾回填                                        | 未改动的子树必须复用原引用, 否则失去结构共享的意义                                         |
| 批量查询              | 队列快照后清空, 异步统一处理                                    | 先换引用再异步处理, 期间新请求进入下一轮                                                   |
| 生成器循环            | `yield` 表达式接收下次 `next` 的实参                            | 负数步进要用双重取模归一到非负区间; 首次 `next` 的实参被丢弃                               |
| 请求重试              | 指数退避加抖动, 配合超时与取消                                  | 只对幂等请求重试; 用 `AbortSignal` 避免页面跳转后回调仍执行                                |

几个共通的实现思路值得记住。其一, 用"唯一键临时挂载后删除"或代理来改变调用上下文, 本质是在模拟引擎的内部槽。其二, 用单线程同步段的不可分割性替代锁, 并发池的游标法就是典型。其三, 用引用相等作为变化信号, 是不可变更新与框架浅比较能够成立的前提。其四, 把协议或规范的边界条件 (空数组、稀疏数组、循环引用、负数、边界时间) 当作测试用例, 而不是当作异常处理。

## 适用场景与小结

这份文档覆盖的是"语言语义、浏览器运行时与网络协议"这条主线, 它的用途不是替代 API 手册, 而是在遇到现象时提供可推断的模型:

- 排查异步顺序、状态错乱、内存增长问题时, 回到事件循环、微任务、闭包与可达性分析这条链路。
- 排查布局抖动、动画掉帧、页面卡顿问题时, 回到渲染流水线、强制同步布局与合成层这条链路。
- 排查请求失败、缓存不生效、跨域被拦、首屏慢的问题时, 回到 HTTP 语义、缓存验证器、同源策略与连接复用这条链路。
- 排查被注入、请求被伪造、数据被窃取的问题时, 回到输出编码、CSP、SameSite 与传输层信任这条链路。

需要与替代材料配合的地方也很明确: 具体框架的行为差异看 [React](react) 与 [Next.js](next), 构建工具与产物优化看 [Vite](vite), 样式与布局机制看 [CSS](css); 服务端的限流、熔断与中间件实现属于后端范畴, 前端只需理解其语义与降级配合方式。最后一条经验是: 把每个结论都落到"机制在哪一层、边界条件是什么、验证方式是什么", 比记住零散结论更有价值。
