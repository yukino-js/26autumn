---
title: "前端技术笔记: JavaScript、DOM、BOM、浏览器与网络"
---

本文档梳理 JavaScript 语言、DOM/BOM、浏览器原理与网络的核心知识点, 内容由浅入深, 力求准确、专业, 并覆盖常见的延伸方向.

## 第一部分 JavaScript 语言核心

### typeof 与数据类型检测有哪些陷阱

A: JavaScript 有 8 种数据类型, 其中 7 种原始类型为 undefined、null、boolean、number、string、symbol、bigint, 加上引用类型 object (function 是可调用的 object 子类型) .

typeof 的常见结果与陷阱:

- typeof null === 'object'. 这是语言最早期的历史遗留 bug: 早期实现中值的类型标签为 0 时表示对象, 而 null 的机器码表示恰好全为 0, 被误判为 object. 修正它会破坏大量现存代码, 因此被保留至今.
- typeof 一个函数返回 'function', 但函数本质上仍是对象, typeof 对它是特例处理.
- typeof 一个未声明的变量返回 'undefined' 且不报错, 这是 typeof 的安全机制; 但对 let/const 声明前访问 (暂时性死区) 会抛 ReferenceError.
- typeof Symbol() === 'symbol', typeof 10n === 'bigint'.
- typeof document.all === 'undefined', 这是规范特意规定的怪异行为, 用于兼容旧浏览器中通过 document.all 检测 IE 的代码.

更可靠的类型检测手段:

- Object.prototype.toString.call(v) 返回 '[object Xxx]' 形式, 可区分 Array、Date、RegExp、Map、Set、Null、Undefined 等.
- Array.isArray 判断数组, 且能跨 iframe 等不同的全局环境工作, 而 instanceof 跨 realm 会失效.
- Number.isNaN 判断 NaN, 不会做隐式转换, 比全局 isNaN 更严格.
- 判断 null 应直接使用 v === null.
- 判断 plain object 还需结合 Object.getPrototypeOf 排除 class 实例等场景.

### 宽松相等与严格相等的区别及隐式类型转换规则

A: === 是严格相等, 不做类型转换, 类型不同直接返回 false. == 是宽松相等, 类型不同时会按规范的 Abstract Equality Comparison 算法做隐式转换后比较.

== 的核心规则:

- 类型相同则按 === 比较 (对象比较引用) .
- null == undefined 为 true, 且它们与其他任何值比较都为 false (包括 null == 0) .
- number 与 string 比较时, string 通过 ToNumber 转换.
- boolean 参与比较时先转成 number (true → 1, false → 0) .
- 一边是对象、一边是原始值时, 对象通过 ToPrimitive 转换: 优先调用 Symbol.toPrimitive, 否则按 hint 依次尝试 valueOf、toString.
- bigint 与 number 可以互相比较数值; Symbol 不能与 number 转换比较.

经典例子:

```js
[] == false   // true: [] → '' → 0, false → 0
[] == ![]     // true: ![] 为 false, 同上
'' == 0       // true
null == 0     // false
NaN == NaN    // false, NaN 不等于任何值包括自身
[1,2] == '1,2' // true: 数组 toString 为 '1,2'
```

补充: Object.is 与 === 几乎一致, 区别只有两处: Object.is(NaN, NaN) 为 true, Object.is(+0, -0) 为 false. 还常延伸讨论为什么应避免 ==: 转换规则难以记忆、容易引入隐蔽 bug, 团队规范通常要求默认使用 ===.

### 原型与原型链是什么

A: 每个对象都有一个内部槽 [[Prototype]], 指向它的原型对象, 可以通过 Object.getPrototypeOf 或 `__proto__` (历史遗留但已被 ECMAScript 附录 B 规范化、HTML 规范要求浏览器实现的访问器) 访问. 函数对象额外拥有一个 prototype 属性, 该属性的 constructor 指回函数本身. 当通过 new 创建实例时, 实例的 [[Prototype]] 会被设为构造函数的 prototype.

三者的关系:

```js
function Foo() {}
const f = new Foo();
Object.getPrototypeOf(f) === Foo.prototype; // true
Foo.prototype.constructor === Foo; // true
```

读取属性时, 引擎先查对象自身, 查不到就沿 [[Prototype]] 逐级向上查找, 直到 Object.prototype, 其 [[Prototype]] 为 null, 链到此结束, 这条链就是原型链. 属性屏蔽、hasOwnProperty 区分自有属性与继承属性、方法复用都建立在这一机制上.

继承的本质是让子类 prototype 的 [[Prototype]] 指向父类 prototype:

```js
function Child() {}
Child.prototype = Object.create(Parent.prototype);
Child.prototype.constructor = Child;
```

常见延伸: Object.create(null) 创建的对象没有原型, 适合作为纯字典使用, 避免 `__proto__`、constructor 等键名冲突 (这也是原型链污染攻击的防御手段之一) ; 运行期通过 `__proto__` 或 Object.setPrototypeOf 修改原型会导致引擎去优化 (隐藏类失效) , 应优先在创建时用 Object.create 或 class 确定原型.

### new 操作符做了什么

A: new 调用构造函数时按以下步骤执行:

1. 创建一个全新的空对象, 将其 [[Prototype]] 设为构造函数的 prototype.
2. 以该对象为 this 执行构造函数体.
3. 如果构造函数显式返回一个对象 (或函数) , 则 new 的结果是这个返回值; 否则结果是第 1 步创建的对象.

手写实现:

```js
function myNew(Fn, ...args) {
  const obj = Object.create(Fn.prototype);
  const ret = Fn.apply(obj, args);
  return ret !== null && (typeof ret === "object" || typeof ret === "function")
    ? ret
    : obj;
}
```

深入延伸:

- 箭头函数没有 prototype、没有 [[Construct]] 内部方法, 不能作为构造函数, new 时会抛 TypeError.
- new.target 可以在函数内部判断是否通过 new 调用: 普通调用时为 undefined, new 调用时为构造函数本身. ES class 的构造器依赖它做校验.
- 继承场景下 new.target 指向最末端实际被 new 的类, 可用于实现抽象基类.
- 构造函数里 return 一个原始值会被忽略, return 一个对象则会替换默认实例.

### instanceof 的原理是什么

A: A instanceof B 的语义是: 在 A 的原型链上查找是否存在 B.prototype. 注意它检查的不是构造函数本身, 而是构造函数的 prototype 属性.

手写实现:

```js
function myInstanceof(obj, Fn) {
  if (typeof Fn !== "function")
    throw new TypeError("Right-hand side must be callable");
  let proto = Object.getPrototypeOf(obj);
  while (proto !== null) {
    if (proto === Fn.prototype) return true;
    proto = Object.getPrototypeOf(proto);
  }
  return false;
}
```

注意点:

- 基本类型不是对象, 1 instanceof Number 为 false, 但 new Number(1) instanceof Number 为 true.
- instanceof 跨 realm (如 iframe、不同 window) 不可靠: 不同全局环境有各自的 Array, 跨窗口数组用 instanceof Array 判断为 false, 这也是 Array.isArray 存在的意义.
- 函数可以通过 Symbol.hasInstance 自定义 instanceof 行为.
- 修改 Fn.prototype 的指向后, 旧实例与新 prototype 的 instanceof 结果会变化, 因为判断发生在查询时刻.

### this 指向的判定规则

A: this 在函数调用时动态绑定, 按优先级从高到低有四条规则:

1. new 绑定: 通过 new 调用时, this 指向新创建的实例.
2. 显式绑定: 通过 call、apply、bind 指定 this. 若传入 null/undefined, 非严格模式下会替换为全局对象, 严格模式下保持原样.
3. 隐式绑定: 作为对象方法调用 obj.foo(), this 指向调用点最近的对象. 要注意隐式丢失: 把方法赋值给变量再调用、作为回调传入, 都会退回默认绑定.
4. 默认绑定: 独立函数调用, 严格模式下 this 为 undefined, 非严格模式下为全局对象 (浏览器中即 window, ES2020 起可用 globalThis 统一获取) .

特殊规则:

- 箭头函数没有自己的 this, 它捕获定义时所在作用域的 this, 且不可被 call/bind 改变; 箭头函数也没有 arguments、不能作构造函数.
- DOM 事件监听器中, 普通函数的 this 是 currentTarget (当前绑定监听器的元素) , 箭头函数则是外层词法 this.
- class 的方法与静态块遵循同样的规则; 类字段中的箭头函数是固定 this 的常用手段, React class 组件常用它绑定事件回调.

判定口诀: 先看是不是 new, 再看 call/apply/bind, 再看是不是对象打点调用, 都不是就是默认绑定.

### call apply bind 的区别与手写实现

A: 三者都用于显式指定 this. call(thisArg, a, b, ...) 立即调用并逐个传参; apply(thisArg, [a, b]) 立即调用并以数组传参; bind(thisArg, a, b) 不调用, 返回一个永久绑定 this (并可预置部分参数) 的新函数.

手写 bind, 需处理两个细节: 一是作为普通函数调用时使用绑定的 this, 二是被 new 调用时绑定失效、this 应为新实例 (否则 new 出来的对象 this 指向错误) :

```js
Function.prototype.myBind = function (ctx, ...preset) {
  if (typeof this !== "function") throw new TypeError("not callable");
  const fn = this;
  function bound(...args) {
    return fn.apply(this instanceof bound ? this : ctx, preset.concat(args));
  }
  bound.prototype = Object.create(fn.prototype);
  return bound;
};
```

延伸:

- 硬绑定之后再 bind 一次, this 不会变, bind 的结果不可覆盖.
- apply 与 call 性能在现代引擎中差别不大, 历史上 apply 传数组略慢的说法已不成立.
- 常见用途: 借用方法 (Array.prototype.slice.call(arguments), 现代写法是 [...args]) 、回调固定上下文、偏函数 (partial application) .

### 闭包是什么 有什么用途

A: 闭包是函数与其词法环境的组合: 函数在定义时捕获外层作用域的变量环境, 即使外层函数已经返回, 只要内部函数还被引用, 这些变量就不会被回收, 仍然可被读写.

典型用途:

- 数据私有化 (模块模式) : 通过 IIFE 返回只暴露方法的对象, 内部变量外部无法直接访问.
- 柯里化与偏函数: 固定部分参数, 返回接收剩余参数的函数.
- 记忆化 memoize: 缓存计算结果.
- 一次性函数 once、防抖节流内部保存状态.
- 回调中保存上下文状态, 如循环中为每个异步任务保留当前的 i (let 块级作用域 + 闭包, 或 IIFE) .

经典知识点:

```js
for (var i = 0; i < 3; i++) {
  setTimeout(() => console.log(i)); // 3 3 3, 共享同一个 i
}
for (let i = 0; i < 3; i++) {
  setTimeout(() => console.log(i)); // 0 1 2, 每次迭代生成新的词法环境
}
```

代价与风险: 闭包会让外层变量常驻内存, 不使用时应注意解除引用; 在循环中创建大量闭包或闭包持有大对象, 会造成内存占用上升甚至泄漏.

### 作用域 作用域链与变量提升

A: JavaScript 使用词法作用域 (静态作用域) , 作用域在代码书写时确定, 与调用位置无关. 函数创建时会保存对其外部词法环境的引用, 函数执行时再创建自己的变量环境, 层层向外引用形成作用域链, 标识符解析沿链由内向外查找, 找不到则抛 ReferenceError (赋值形式在 sloppy 模式会创建全局变量) .

变量提升的本质是执行上下文创建时先扫描声明: var 提升并初始化为 undefined、函数声明整体提升、let/const 提升但不初始化 (声明前的暂时性死区 TDZ 内访问抛 ReferenceError) , 而 let/const/class 额外具有块级作用域 (for 循环头每次迭代新建绑定, 闭包因此能拿到正确索引) , 且全局 let/const 只存在于词法环境、不挂载到 window.

### var let const 的区别

A: 从五个维度对比:

1. 作用域: var 是函数作用域, let/const 是块级作用域.
2. 提升行为: var 提升并初始化为 undefined; let/const 提升但处于 TDZ, 提前访问报错.
3. 重复声明: var 允许重复声明, let/const 同一作用域内重复声明抛 SyntaxError.
4. 全局对象属性: 全局 var 挂到 window, let/const 不挂.
5. 绑定可变性: const 声明的绑定不可重新赋值, 但如果是对象, 对象内容仍然可变; 要冻结内容需 Object.freeze (浅冻结) 或递归深冻结.

工程建议: 默认使用 const, 需要重新赋值时用 let, 避免使用 var. const 能向阅读者传达“这个绑定不会变”的意图, 也便于引擎和静态工具分析.

### 深拷贝的实现方式与循环引用处理

A: 浅拷贝只复制第一层引用, 如 Object.assign、展开运算符、Array.prototype.slice. 深拷贝需要递归复制整个对象图.

常见方案及其局限:

- JSON.parse(JSON.stringify(obj)): 会丢失 undefined、function、Symbol, Date 变字符串, Map/Set/RegExp 变空对象, BigInt 直接抛错, 遇到循环引用抛错, 且丢失原型链. 只适合纯数据.
- structuredClone(obj): 浏览器与 Node 17+ 原生支持, 基于结构化克隆算法, 支持 Map、Set、Date、RegExp、ArrayBuffer、TypedArray、循环引用; 但不支持函数、DOM 节点、Proxy、getter/setter, 且不会保留原型链 (class 实例被拷贝成 plain object) .
- 手写递归: 用 WeakMap 记录已拷贝对象解决循环引用, 并针对特殊类型做分支处理:

```js
function deepClone(obj, cache = new WeakMap()) {
  if (obj === null || typeof obj !== "object") return obj;
  if (cache.has(obj)) return cache.get(obj);
  if (obj instanceof Date) return new Date(obj);
  if (obj instanceof RegExp) return new RegExp(obj.source, obj.flags);
  if (obj instanceof Map) {
    const m = new Map();
    cache.set(obj, m);
    obj.forEach((v, k) => m.set(deepClone(k, cache), deepClone(v, cache)));
    return m;
  }
  if (obj instanceof Set) {
    const s = new Set();
    cache.set(obj, s);
    obj.forEach((v) => s.add(deepClone(v, cache)));
    return s;
  }
  const clone = Array.isArray(obj)
    ? []
    : Object.create(Object.getPrototypeOf(obj));
  cache.set(obj, clone);
  for (const key of Reflect.ownKeys(obj)) {
    clone[key] = deepClone(obj[key], cache);
  }
  return clone;
}
```

用 WeakMap 而不用 Map 的原因是不强引用源对象, 避免拷贝过程本身造成内存滞留. 生产环境一般推荐 lodash.cloneDeep 或原生 structuredClone.

### 防抖与节流的区别与实现

A: 防抖 debounce: 事件触发后等待 N 毫秒, 若期间再次触发则重新计时, 只在静默期满后执行一次. 适合搜索输入联想、窗口 resize 结束后的重算、表单自动保存.

```js
function debounce(fn, delay) {
  let timer = null;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}
```

节流 throttle: 固定时间窗口内最多执行一次, 稀释触发频率. 适合 scroll、mousemove、拖拽、按钮防连点. 可用时间戳或定时器实现:

```js
function throttle(fn, interval) {
  let last = 0;
  return function (...args) {
    const now = Date.now();
    if (now - last >= interval) {
      last = now;
      fn.apply(this, args);
    }
  };
}
```

延伸: leading/trailing 双触发的完整版实现 (lodash 支持) ; 与时间戳版相比定时器版能保证最后一次也会执行; 动画场景可用 requestAnimationFrame 做“帧级节流”, 天然与渲染帧对齐; React 中注意防抖函数需用 useRef/useMemo 固定, 否则每次渲染生成新实例导致失效.

### class 与原型继承的关系

A: ES6 class 本质是原型机制的语法糖, typeof Foo === 'function', 实例方法定义在 Foo.prototype 上. 但它不是简单等价物, 存在以下语义差异:

- class 声明会提升但不初始化 (处于 TDZ, 声明前访问抛 ReferenceError) , 而函数声明会整体提升.
- class 内部代码自动运行在严格模式.
- class 的方法不可枚举 ([[Enumerable]] 为 false) , 而直接给 prototype 赋值的方法默认可枚举.
- class 必须通过 new 调用, 直接调用抛 TypeError.
- extends 做了两件事: 设置子类 prototype 的原型为父类 prototype (实例继承) , 同时设置子类本身的原型为父类 (静态成员继承) , 即 Object.getPrototypeOf(SubClass) === ParentClass.
- 派生类构造函数中必须先调用 super() 才能访问 this, 因为派生类的 this 由父类构造过程创建.
- super 在方法中通过 [[HomeObject]] 定位父类原型, 这也是把对象方法简单复制到别处后 super 失效的原因.
- 私有字段 #x 提供真正的运行期私有化 (外部语法层面无法访问) , 区别于下划线约定和闭包模拟; 还有静态私有成员与私有方法.

静态方法、getter/setter、静态初始化块 (static \{\}) 都是 class 的组成部分, 理解其底层仍是原型即可推导出全部行为.

### CommonJS 与 ES Module 的区别

A: 核心区别:

1. 加载时机与方式: CommonJS 在运行时同步 require, 模块路径可以是表达式; ESM 在编译期静态分析 import/export, 路径必须是字面量, 因此打包器能做 tree-shaking 与作用域提升.
2. 绑定语义: CJS 导出的是值的拷贝 (module.exports 对象的快照语义, 导出对象本身是引用) ; ESM 导出的是活绑定 (live binding) , 模块内修改变量, 导入方读到的是最新值.
3. this 与严格模式: ESM 顶层 this 为 undefined 且始终严格模式; CJS 顶层 this 是 module.exports.
4. 异步能力: ESM 支持顶层 await, 加载过程是异步的; CJS 同步阻塞.
5. 循环依赖处理: CJS 遇到循环时返回已执行部分的 exports (半成品) ; ESM 通过活绑定处理, 未初始化的绑定访问会触发 TDZ 报错.
6. 动态导入: ESM 用 import() 返回 Promise, 实现按需加载与代码分割; CJS 的 require 天然就是动态调用.

互操作: Node 中 ESM 可以 default import CJS 模块 (整体作为默认导出) , CJS 不能 require ESM (新版 Node 已在部分场景放开同步 require ESM) . 浏览器只原生支持 ESM, 需要 type="module" 的 script 标签, 模块默认 defer 且跨域受 CORS 约束.

### Proxy 与 Reflect 是什么

A: Proxy 可以创建一个对象的代理, 拦截并自定义对象的基本操作. 通过 new Proxy(target, handler) 定义, handler 支持 get、set、has、deleteProperty、ownKeys、getOwnPropertyDescriptor、defineProperty、apply (拦截函数调用) 、construct (拦截 new) 等 13 种 trap. 部分 trap 有不变量约束, 例如不可配置不可写的属性不能被 get 返回不同的值.

Reflect 是与 Proxy trap 一一对应的静态方法集合, 它把对象的内部方法 ([[Get]]、[[Set]] 等) 以函数形式暴露, 并且相比 Object 同名方法返回更合理的结果 (如 defineProperty 返回布尔值而非抛错) , 还支持 receiver 参数修正原型链上 getter 中的 this 指向, 这也是 Vue3 中 get trap 里用 Reflect.get(target, key, receiver) 的原因.

典型应用:

- 响应式系统: Vue3 用 Proxy 代理整个对象, get 时 track 收集依赖、set 时 trigger 派发更新, 解决了 Vue2 Object.defineProperty 无法监听新增属性、数组下标的问题, 且是懒代理 (嵌套对象访问到才代理) .
- 数据校验、只读视图、负索引数组、默认值对象.
- Proxy.revocable 创建可撤销代理, 用于权限收回场景.

局限: 不能代理原始值; 代理对象与原对象不相等 (proxy !== target) 会影响 Map/Set 以对象为键的场景; 有一定性能开销.

### 迭代器与生成器是什么

A: 迭代器协议约定: 对象实现 Symbol.iterator 方法, 返回一个带 next() 的对象, next() 返回 \{ value, done \}. for...of、展开运算符、解构赋值、Promise.all、Array.from 都基于该协议工作. 数组、字符串、Map、Set、NodeList、arguments 都内置可迭代.

手动实现一个可迭代对象:

```js
const range = {
  [Symbol.iterator]() {
    let cur = 0;
    return {
      next: () =>
        cur < 3
          ? { value: cur++, done: false }
          : { value: undefined, done: true },
    };
  },
};
[...range]; // [0, 1, 2]
```

生成器 function* 是迭代器的语法糖, 同时是协程的实现: 执行到 yield 暂停并交出值, next(v) 恢复执行且 v 成为 yield 表达式的值, 实现双向通信; yield* 委托给另一个可迭代对象; return()/throw() 可从外部终止或注入异常.

深层价值: async/await 就是“生成器 + Promise 自动执行器”的语法封装; 异步生成器 (async function\*) 配合 for await...of 可以顺序消费异步数据流, 如分页拉取、流式读取.

### JavaScript 的垃圾回收机制

A: JS 引擎自动管理内存, 核心思想是可达性: 从根对象 (全局对象、当前调用栈、事件回调队列等) 出发能被访问到的对象是存活的, 其余视为垃圾.

主要算法:

- 标记清除: 从根出发标记所有可达对象, 然后清除未标记对象. 这是现代引擎的基础算法, 解决了循环引用问题 (只要整体不可达就会被回收) .
- 引用计数: 记录对象被引用次数, 归零即回收. 无法处理循环引用, 早期 IE 的 DOM/COM 对象用此策略, 曾导致经典泄漏.

V8 的分代回收 (Orinoco) :

- 新生代: 存放存活时间短的小对象, 用 Scavenge 算法 (Cheney 半空间复制) : From 空间满时把存活对象复制到 To 空间并交换角色. 经历两次 Scavenge 仍存活、或复制时 To 空间占用超过 25% 的对象会晋升到老生代.
- 老生代: 标记清除 + 标记整理 (碎片过多时移动对象压缩内存) . 为减少全停顿 (stop-the-world) , 采用增量标记 (交替执行一小段标记与 JS) 、惰性清理、并发标记 (辅助线程后台标记) 与并行回收.
- 大对象区单独管理, 不参与复制.

常见内存泄漏场景: 未清理的定时器持有回调闭包; 已移除的 DOM 仍被 JS 引用 (detached DOM) ; 全局变量意外累积; 闭包长期持有大对象; 事件监听器未解绑; console.log 的对象在 DevTools 中无法释放.

相关 API: WeakMap/WeakSet 弱引用不阻止键被回收; WeakRef 与 FinalizationRegistry 可在对象被回收后收到通知 (规范不建议依赖其做关键逻辑, 回收时机不保证) .

## 第二部分 异步编程与事件循环

### 事件循环 Event Loop 的机制是什么

A: 浏览器遵循 HTML 规范定义的事件循环模型. 核心结构:

- 任务队列 (task queue, 常称宏任务) : setTimeout/setInterval、I/O、UI 事件、script 整体执行、MessageChannel、postMessage. 规范允许存在多个任务队列, 不同来源的任务可以有不同的调度优先级.
- 微任务队列 (microtask queue) : Promise.then/catch/finally 的回调、queueMicrotask、MutationObserver、await 之后的续体.

执行规则:

1. 从任务队列取一个任务执行 (调用栈清空为止) .
2. 执行完一个任务后, 清空整个微任务队列 (执行期间新产生的微任务也一并执行, 直到队列空) .
3. 必要时进入渲染步骤: 样式计算、布局、绘制; requestAnimationFrame 回调在绘制之前执行.
4. 回到第 1 步.

关键推论:

- 微任务优先级高于下一个宏任务, 也高于渲染. 持续产生微任务会饿死渲染, 页面卡死但 setTimeout 递归则不会 (每轮之间浏览器有机会渲染和响应输入) .
- await 之后的代码是微任务; Promise 的 executor 是同步执行的, 只有回调进入微任务队列.
- Node.js 的事件循环是 libuv 实现的阶段模型 (timers、poll、check 等) , 与浏览器模型不同, Node 中还有 process.nextTick 这个比 Promise 更高的微任务队列. 浏览器场景与 Node 场景不要混答.

### Promise 的原理与手写实现

A: Promise 是一个状态机, 三种状态: pending、fulfilled、rejected, 状态只能单向流转一次 (pending → fulfilled 或 pending → rejected) , 不可逆. 核心语义:

- executor 同步执行; resolve/reject 决定终态与值.
- then(onFulfilled, onRejected) 注册回调并返回新 Promise, 回调总是异步 (微任务) 执行, 形成链式调用.
- Promise Resolution Procedure: resolve 的值如果是 thenable (带 then 方法的对象) , 会调用其 then 并“吸收”其状态, 这保证不同 Promise 实现可互操作; resolve 一个 Promise 本身时, 新 Promise 跟随它的状态.
- 链上的值传递规则: 回调返回普通值则下一个 then 收到该值; 返回 Promise 则等待其落定; 抛异常则进入 rejected 分支; onRejected 缺省时错误向下穿透.

极简手写骨架:

```js
class MyPromise {
  constructor(executor) {
    this.state = "pending";
    this.value = undefined;
    this.callbacks = [];
    const settle = (state, value) => {
      if (this.state !== "pending") return;
      if (value instanceof MyPromise) {
        value.then(
          (v) => settle(state === "fulfilled" ? "fulfilled" : state, v),
          (r) => settle("rejected", r),
        );
        return;
      }
      this.state = state;
      this.value = value;
      queueMicrotask(() => this.callbacks.forEach((cb) => cb()));
    };
    try {
      executor(
        (v) => settle("fulfilled", v),
        (r) => settle("rejected", r),
      );
    } catch (e) {
      settle("rejected", e);
    }
  }
  then(onF, onR) {
    return new MyPromise((resolve, reject) => {
      const run = () => {
        try {
          const cb = this.state === "fulfilled" ? onF : onR;
          if (typeof cb !== "function") {
            (this.state === "fulfilled" ? resolve : reject)(this.value);
            return;
          }
          const ret = cb(this.value);
          ret instanceof MyPromise ? ret.then(resolve, reject) : resolve(ret);
        } catch (e) {
          reject(e);
        }
      };
      this.state === "pending" ? this.callbacks.push(run) : queueMicrotask(run);
    });
  }
}
```

真实实现需完整处理 thenable 的递归吸收、resolvePromise 的防循环引用 (resolve 自身会抛 TypeError) 等细节, 可对照 Promise/A+ 规范.

补充: unhandledrejection 事件可捕获未被 catch 的拒绝; Promise 无法取消, 常见取消方案是 AbortController + 包装 race.

### Promise.all allSettled race any 的区别

A: 四个静态组合方法的差异:

- Promise.all: 全部 fulfilled 才按输入顺序返回结果数组; 任何一个 rejected 立即整体 reject (快速失败) , 但其余 Promise 不会取消, 仍在后台执行.
- Promise.allSettled: 等待全部落定, 绝不 reject, 返回 [\{ status: 'fulfilled', value \} | \{ status: 'rejected', reason \}] 数组, 适合需要完整结果的场景.
- Promise.race: 第一个落定的 (无论成败) 决定整体结果.
- Promise.any: 第一个 fulfilled 的胜出; 全部 rejected 时以 AggregateError 拒绝 (其 errors 属性含全部原因) .

手写 Promise.all 要点: 计数器 + 保序写入 + 快速失败:

```js
Promise.myAll = function (iterable) {
  return new Promise((resolve, reject) => {
    const items = [...iterable];
    if (items.length === 0) return resolve([]);
    const results = new Array(items.length);
    let done = 0;
    items.forEach((p, i) => {
      Promise.resolve(p).then((v) => {
        results[i] = v;
        if (++done === items.length) resolve(results);
      }, reject);
    });
  });
};
```

典型应用: 并发请求聚合用 all/allSettled; 超时控制用 race (请求与延时 reject 竞速) ; 多源容灾取最快成功用 any.

### async await 的原理是什么

A: async 函数本质上是“生成器函数 + 自动执行器 (spawn) + Promise”的语法糖. 编译视角: 函数体在每个 await 处被切分, await 表达式相当于 yield 一个 Promise, 执行器把该 Promise 的落定结果通过 next(value)/throw(reason) 送回函数体继续执行, 直到函数 return, async 函数的返回值被包装成 Promise (经 Promise.resolve 同化) .

行为细节:

- await 后的一切代码都是微任务; await 一个非 Promise 值也会包一层 Promise.resolve, 仍产生至少一次微任务等待.
- 错误处理: 函数体内用 try/catch 捕获 await 的拒绝; 函数体外通过返回 Promise 的 catch 或 unhandledrejection 兜底.
- 常见性能陷阱: 在循环中串行 await 本可并发的请求, 应先 map 出 Promise 数组再 Promise.all.
- 顶层 await: ESM 模块顶层可直接 await, 会阻塞该模块及其导入方的求值, 适合初始化异步资源, 但会延迟模块图执行.
- async 函数并发模型: 每个 async 函数独立推进, 不存在抢占, 仍是单线程协作式调度.

### 宏任务与微任务经典输出题

A: 经典题目:

```js
console.log("script start");

setTimeout(() => console.log("setTimeout"), 0);

async function async1() {
  console.log("async1 start");
  await async2();
  console.log("async1 end");
}
async function async2() {
  console.log("async2");
}

async1();

new Promise((resolve) => {
  console.log("promise1");
  resolve();
}).then(() => console.log("promise2"));

console.log("script end");
```

输出顺序:

```
script start
async1 start
async2
promise1
script end
async1 end
promise2
setTimeout
```

推理过程: 同步代码依次输出 script start、async1 start、async2 (await 处暂停, 后续进入微任务队列) 、promise1 (executor 同步) 、script end. 同步结束后清空微任务队列: 先 async1 end (先注册的 await 续体) , 再 promise2. 最后进入下一个宏任务 setTimeout. 核心要点: executor 同步、await 切分、微任务清空优先于宏任务.

### requestAnimationFrame 与 requestIdleCallback

A: requestAnimationFrame(cb): 告诉浏览器下一帧绘制前调用 cb, 回调收到高精度时间戳. 特点:

- 与显示器刷新率对齐 (60Hz 时约 16.7ms, 高刷屏更短) , 动画用它可避免丢帧与撕裂.
- 回调运行在渲染步骤中样式/布局之前, 是读写 DOM 的最佳时机场所.
- 后台标签页会暂停, 天然省电.
- 每帧只执行一次, 需要持续动画要在回调里再次注册.

requestIdleCallback(cb, \{ timeout \}): 在浏览器空闲时段调用, cb 收到 IdleDeadline, deadline.timeRemaining() 告知本帧剩余空闲时间, deadline.didTimeout 表示是否因超时强制执行. 适合低优先级任务: 日志上报、预计算、非关键数据同步. 注意: 空闲回调中应避免直接大量修改 DOM (可能迫使布局在回调内同步发生) , 修改 DOM 的工作应拆到 rAF 中; Safari 自 26 (2025-09) 起正式默认提供, 更早的 Safari 版本需 setTimeout 降级.

两者常配合做时间切片: rIC 做数据准备, rAF 做 DOM 更新.

### setTimeout 为什么不准时

A: setTimeout(fn, delay) 的语义是“至少 delay 毫秒后把回调放入任务队列”, 实际执行时间受多重因素影响:

1. 主线程繁忙: 若当前任务或微任务队列未清空, 回调必须等待, 延迟被拉长.
2. 嵌套钳制: HTML 规范规定嵌套定时器超过 5 层后, 最小间隔被钳制为 4ms.
3. 后台标签页节流: 非激活标签的定时器通常被限制为每秒最多一次, 现代浏览器还有更激进的 intensive throttling (后台超过 5 分钟且无声等情况可每分钟一次) .
4. 最小分辨率与系统定时器精度本身有限.
5. 回调自身执行耗时会造成后续累积漂移.

对策: 动画用 rAF; 需要稳定节拍的场景 (如倒计时显示) 应基于时间戳校准 (记录起始时间, 每 tick 用 Date.now() 差值计算, 而非累加 delay) ; 高精度后台计时可放到 Web Worker 中 (Worker 不受后台标签节流限制) ; 调度类需求可用 setInterval 自校准或 scheduler.postTask (优先级调度, 支持 delay 与 AbortSignal 取消; Chrome 94+/Firefox 142+ 已支持, Safari 尚未) .

## 第三部分 DOM 与事件

### DOM 事件流的三个阶段

A: DOM Level 2 定义的事件流包含三个阶段:

1. 捕获阶段: 事件从 window 沿 DOM 树向下传播到目标节点的父级.
2. 目标阶段: 事件到达 target. 目标节点上捕获型与冒泡型监听器按注册顺序执行 (旧规范曾规定目标阶段不分捕获冒泡, 现代实现统一按注册顺序) .
3. 冒泡阶段: 事件从目标向上冒泡回 window.

要点:

- addEventListener 第三个参数决定监听器挂在捕获还是冒泡阶段.
- event.target 是事件真正发生的节点 (deepest ) , event.currentTarget 是当前正在执行监听器的节点.
- 并非所有事件都冒泡: focus/blur、mouseenter/mouseleave、load、error (资源加载) 等不冒泡; 对应的可冒泡替代是 focusin/focusout、mouseover/mouseout. focus/blur、load 这类事件仍可在捕获阶段被祖先监听, 但 mouseenter/mouseleave 完全不参与传播 (只在目标上触发) , 无法通过捕获委托.
- event.composedPath() 返回完整传播路径 (含 Shadow DOM 内部节点, 取决于 composed 与 shadow mode) .
- 事件对象在传播中被复用, 异步读取其属性需先保存.

### addEventListener 的三个参数分别是什么

A: 完整签名: target.addEventListener(type, listener, options), 第三个参数历史上是布尔值 useCapture, 现代规范扩展为 options 对象.

第一个参数 type: 事件类型字符串, 如 'click'、'scroll'、自定义事件名.

第二个参数 listener: 回调函数, 或实现了 handleEvent 方法的对象 (EventListener 接口) . 回调接收事件对象, 普通函数内 this 指向 currentTarget, 箭头函数继承外层 this.

第三个参数: 布尔值时等价于 \{ capture \}; 对象形式支持四个选项:

- capture: 默认 false. true 表示在捕获阶段触发, false 在冒泡阶段触发.
- once: 默认 false. true 表示回调执行一次后自动移除, 省去手动 removeEventListener.
- passive: 默认 false. true 表示承诺不调用 preventDefault, 浏览器可立即滚动而不等待 JS 执行结果, 用于优化 touch/wheel 滚动性能; 在 passive 监听器里调 preventDefault 无效并产生警告. Chrome 对 window/document/body 上的 touchstart、touchmove、wheel 默认 passive 为 true, 需要阻止默认行为时必须显式传 \{ passive: false \}.
- signal: 传入 AbortSignal, 调用对应 AbortController 的 abort() 即可移除监听器, 比手动保存引用再 removeEventListener 更方便, 且可批量移除.

其他细节:

- 同一 target 上 type、listener、capture 三者完全相同的重复注册会被忽略 (once/passive 差异不影响去重判定) .
- removeEventListener 需要 capture 标志匹配才能成功移除, once/passive/signal 不参与匹配.
- 这是标准要点, 也是判断是否跟进现代 DOM API 的标准 (once/passive/signal 三件套) .

### 事件委托的原理与优缺点

A: 原理: 利用事件冒泡, 把子元素的监听器统一挂到共同祖先上, 通过 event.target (配合 closest 向上匹配选择器) 判断事件来源并分发处理.

```js
list.addEventListener("click", (e) => {
  const item = e.target.closest("li[data-id]");
  if (!item || !list.contains(item)) return;
  handle(item.dataset.id);
});
```

优点:

- 大幅减少监听器数量, 降低内存占用与绑定开销, 对长列表收益明显.
- 动态增删子元素无需重新绑定.
- 统一入口便于埋点、权限拦截等横切逻辑.

缺点与注意:

- 不冒泡的事件无法直接委托 (focus/blur 用 focusin/focusout 代替; mouseenter/leave 不冒泡但 mouseover/out 可委托并配合 relatedTarget 判断边界) .
- 每次事件都要执行匹配逻辑, 深层树 + 高频事件 (mousemove、scroll) 有一定开销.
- 委托链条中若有人 stopPropagation, 祖先收不到事件, 混用时要小心.
- closest 选择器写错、忘记校验 contains 会导致越权处理外部元素.

### stopPropagation stopImmediatePropagation preventDefault 的区别

A: 三者作用完全不同:

- stopPropagation(): 阻止事件继续传播, 当前节点之后的捕获/冒泡路径上的其他节点收不到事件, 但同一节点上注册的其他监听器仍会执行.
- stopImmediatePropagation(): 在 stopPropagation 基础上, 连同一节点上排在后面的其他监听器也不再执行.
- preventDefault(): 阻止默认行为, 与传播无关. 例如链接跳转、表单提交、右键菜单、文本选中、拖放. 它不影响冒泡.

组合判断:

- 阻止传播不阻止默认行为, 反之亦然.
- passive: true 的监听器中 preventDefault 无效.
- 内联属性事件 (onclick="...; return false") 中 return false 仅等价于 preventDefault (取消默认行为, 不阻止传播) ; addEventListener 或 DOM0 赋值 (element.onclick = fn) 的回调里 return false 没有任何效果; jQuery 事件回调里的 return false 则是框架自己封装的 preventDefault + stopPropagation 组合.
- event.cancelBubble 是 stopPropagation 的旧式别名; event.defaultPrevented 可查询是否已被阻止默认行为, 多层组件协作时可据此决定是否再处理.

### passive 事件监听器与滚动性能

A: 背景: touchstart/touchmove/wheel 事件的默认行为是滚动, 而监听器可能调用 preventDefault 取消滚动, 浏览器必须同步执行完监听器才能决定是否滚动, 主线程繁忙时滚动被阻塞, 表现为页面滚动卡顿.

passive: true 是开发者对浏览器的承诺: 这个监听器不会调用 preventDefault. 浏览器因此可以立即开始滚动, 事件照常派发但默认行为不可取消, 滚动帧率显著提升.

要点:

- Chrome 从 56 起把 window、document、body 上的 touchstart/touchmove 默认设为 passive, wheel 随后也默认 passive; 这是“ Intervention ”级别的默认行为变更, 旧代码若依赖 preventDefault 阻止滚动 (如下拉刷新组件) , 必须显式 \{ passive: false \}.
- 特性检测: 通过定义带 getter 的对象探测浏览器是否读取 passive 属性.
- 除滚动类事件外, passive 对其他事件没有实际收益.
- React 17 之前合成事件统一委托到 document, 恰好落入浏览器对 document/window 上 touchstart/touchmove/wheel 默认 passive 的干预, onTouchMove/onWheel 里 preventDefault 无效是常见坑; React 17 起事件挂到根容器, 这几类事件仍默认按 passive 注册, 需要阻止默认行为时应通过 ref 挂原生监听器并显式传 \{ passive: false \}.

### 如何创建与派发自定义事件

A: 使用 CustomEvent 构造函数, detail 字段携带任意数据, dispatchEvent 派发:

```js
const evt = new CustomEvent("user:login", {
  detail: { uid: 42 },
  bubbles: true, // 需要委托/祖先监听时必须开启
  cancelable: true, // 允许 preventDefault
  composed: true, // 允许事件穿透 Shadow DOM 边界
});
node.dispatchEvent(evt);
```

要点:

- dispatchEvent 是同步执行的: 派发后所有监听器执行完毕才返回, 返回值表示默认行为是否被阻止.
- Event 与 CustomEvent 的区别仅在于后者多了 detail.
- bubbles 默认 false, 很多“自定义事件没反应”的 bug 源于忘记开启.
- 合成事件的 isTrusted 为 false, 浏览器据此区分真实用户操作, 涉及剪贴板、全屏、弹窗等权限敏感操作时合成事件不会被认可.
- 常见用途: 跨组件/跨框架解耦通信 (如微前端间广播) 、DOM 事件总线、Web Component 对外暴露语义化事件 (shadow 内组件 detail 变化时派发自定义事件是对外通信的标准做法) .
- 与原生事件一致, 自定义事件同样遵循捕获/冒泡, 可用事件委托统一处理.

### 为什么 DOM 操作慢 如何优化

A: DOM 操作慢的原因:

1. DOM 是浏览器渲染引擎中的 C++ 对象, JS 通过绑定层跨语言访问, 每次调用都有跨界成本.
2. 修改 DOM 可能使样式与布局失效, 触发样式重算、重排、重绘甚至整帧流水线.
3. 读写交错会引发强制同步布局 (layout thrashing) : 写入使布局失效后立刻读取 offsetTop、getBoundingClientRect、clientWidth 等几何属性, 浏览器被迫立即完成一次完整布局才能返回正确值; 循环中读写交替会把一次布局放大成 N 次.

优化手段:

- 批量修改: 使用 DocumentFragment 集中插入; 先 cloneNode 离线修改再整体替换; display:none 下批量改再显示 (合并为一次重排) .
- 读写分离: 先读完所有需要的几何值, 再统一写 (FastDOM 库就是封装这个模式) .
- 减少节点数量: 虚拟列表、分页、content-visibility: auto 跳过屏外渲染.
- 变更类名代替逐条修改 style; 用 CSS 变量驱动批量样式变化.
- 动画用 transform/opacity, 走合成层不触发布局 (见「合成层是什么 为什么 transform 动画更流畅」) .
- 避免频繁访问会强制布局的属性, 必要时用 ResizeObserver/IntersectionObserver 代替轮询.

### Virtual DOM 的原理与 key 的作用

A: Virtual DOM 是用轻量 JS 对象描述 UI 结构的一层抽象. 渲染流程: 状态变化 → 重新执行渲染函数生成新 vdom 树 → 与旧树 diff → 计算最小 DOM 操作集 → patch 到真实 DOM.

diff 的核心启发式 (以 React 为例, 把 O(n^3) 的通用树编辑距离降为 O(n)) :

- 同层比较: 只比较同一层级的节点, 不跨层移动子树.
- 类型不同直接销毁重建 (div 换 span、组件类型变化) .
- 列表通过 key 标识身份: 有 key 的节点在新旧列表间按 key 匹配, 能复用就移动位置, 不能复用才创建/删除.

key 的作用与 index 作 key 的坑: key 帮助框架建立稳定的节点身份映射. 用数组下标作 key 时, 列表逆序、插入、删除会导致节点身份错乱——框架复用了错误的 DOM 与组件状态, 表现为输入框内容错位、动画错乱、内部状态串项. 只有纯静态、永不重排的列表才可以安全使用 index.

对 vdom 的客观评价:

- 价值在于声明式编程模型、批量更新、跨平台渲染 (React Native/SSR) , 而不是“一定更快”——vdom diff 本身有 CPU 与内存开销, 极端性能场景手写 DOM 或细粒度响应式更快.
- 细粒度响应式 (Vue3 的 block tree + patch flag 编译时优化、Svelte/Solid 编译为精准 DOM 指令、preact signals 类方案) 正在绕过或缩小 vdom diff 的成本, 这是延伸.

### Web Component 的原理是什么

A: Web Component 是浏览器原生支持的组件化方案, 由三项技术组成:

1. Custom Elements (自定义元素) :
   - customElements.define('my-card', class extends HTMLElement \{...\}) 注册新标签.
   - 生命周期回调: connectedCallback (插入文档) 、disconnectedCallback (移出) 、attributeChangedCallback (observedAttributes 声明的属性变化) 、adoptedCallback (跨文档移动) .
   - 支持自主元素 (extends HTMLElement) 与自定义内置元素 (extends HTMLButtonElement + is="my-btn", Safari 不支持后者) .
2. Shadow DOM (影子 DOM) :
   - this.attachShadow(\{ mode: 'open' \}) 创建与主文档隔离的子树, 内部结构与样式默认不对外暴露, 外部样式也不会渗入 (继承属性与 CSS 变量除外) , 实现真正的 DOM/CSS 封装.
   - slot 机制 (默认插槽与具名插槽) 支持内容分发, slotchange 事件可感知分发变化.
   - 样式相关伪类: :host、:host()、:host-context()、::slotted(), 以及 ::part() 显式暴露内部元素供外部定制.
   - Declarative Shadow DOM (template shadowrootmode) 支持纯 HTML/SSR 场景.
3. HTML Templates (template 元素) :
   - template 内容不参与渲染、不加载资源、不可查询, 通过 template.content.cloneNode(true) 按需实例化, 是组件模板的标准载体.

补充能力:

- 事件在 Shadow 边界做 retargeting (对外 target 显示为宿主) , composed: true 的事件可穿出 Shadow (见「Shadow DOM 的样式隔离与事件机制」) .
- ElementInternals 让自定义元素参与表单 (formAssociated) 、管理可访问性状态.
- Constructable Stylesheets (adoptedStyleSheets) 实现 Shadow 间共享样式表.
- 生态: Lit 是最流行的开发库; 框架方面 Angular/Vue 可直接消费, React 19 起完善了对自定义元素属性与事件的支持. 浏览器原生、无框架锁定、可 SSR, 是其核心卖点.

### Shadow DOM 的样式隔离与事件机制

A: 样式隔离规则:

- Shadow 树内部定义的 style 只作用于树内; 外部样式表与选择器无法选中树内元素.
- 例外穿透: CSS 继承属性 (color、font 等) 会照常继承进 Shadow; CSS 自定义属性 (变量) 无视边界, 是对外暴露主题能力的标准方式.
- 主动开放通道: ::part() + part/exportparts 属性让宿主暴露指定内部元素供外部样式定制; ::slotted() 只能选中插槽的直接子节点 (一层) , 不能深入.
- :host 选中宿主元素, :host(.active) 可按宿主状态设置内部样式; :host-context(selector) 根据祖先环境切换主题 (使用时注意其把组件与环境耦合) .
- Constructable Stylesheets: new CSSStyleSheet() + shadowRoot.adoptedStyleSheets, 避免每个实例重复插入 style 标签.

事件机制:

- 事件在 Shadow 边界发生 retargeting: 外部监听器看到的 event.target 是宿主元素, 内部实现细节被隐藏; 内部监听器看到的仍是真实目标.
- 只有 composed: true 的事件才会穿越 Shadow 边界继续传播到外部 (原生 UI 事件如 click、input、focusin 默认 composed; mouseenter/mouseleave 等不 composed; focus/blur 本身 composed 但不冒泡, 祖先只能在捕获阶段观察到; 自定义事件需显式设置) .
- composedPath() 返回包含 Shadow 内部节点的完整路径 (closed 模式下对外隐藏内部节点) .
- slot 分发的元素在事件路径上同时包含“扁平树”位置, 理解事件路径要以扁平树而非原 DOM 树为准.

### MutationObserver IntersectionObserver ResizeObserver

A: 三者都是“观察者”模式的异步回调 API, 替代低效的轮询与同步事件.

MutationObserver: 监听 DOM 变化, 回调以微任务批量触发, 参数为 MutationRecord 数组.

```js
new MutationObserver(records => {...}).observe(node, {
  childList: true, attributes: true, characterData: true,
  subtree: true, attributeOldValue: true
});
```

它取代的是同步触发、性能极差的 Mutation Events (DOMNodeInserted 等, 已废弃) . 用途: 富文本编辑器同步、水印防篡改、第三方脚本 DOM 监控. 注意回调中再次修改 DOM 会触发新一轮记录, 需防止死循环.

IntersectionObserver: 异步监听目标元素与视口 (或指定 root 祖先) 的交叉状态. 配置 root、rootMargin (可正负, 提前/延后触发) 、threshold (0~1 数组, 交叉比例过档才回调) . 典型用途: 懒加载图片、无限滚动、曝光埋点、视频自动播放暂停. 相比 scroll 监听 + getBoundingClientRect, 它由浏览器在合成/空闲时计算, 不阻塞主线程, 精度与性能都更优. v2 还增加了 isVisible 真实可见性 (遮挡、透明度) 检测.

ResizeObserver: 监听元素内容盒/边框盒尺寸变化 (contentBoxSize、borderBoxSize、devicePixelContentBoxSize) , 解决 window resize 无法感知元素级尺寸变化的问题, 用于响应式组件、图表自适应、文本溢出检测. 回调在布局之后绘制之前执行, 回调内修改尺寸要小心“ResizeObserver loop completed with undelivered notifications”循环警告.

### preact 的 signal 核心原理与浏览器的 Signal API

A: preact signals (@preact/signals-core) 是细粒度响应式原语, 核心由三部分组成:

1. signal(value): 可写信号. 读取 .value 时建立依赖, 写入时通知订阅者. 实现上, 系统维护一个全局的“当前正在求值的计算上下文”指针: signal 的 getter 检测到该指针非空时, 把自己记录为当前上下文的依赖 (依赖收集 track) ; setter 触发时遍历依赖列表把订阅者标记为过期并调度通知 (trigger) .
2. computed(fn): 惰性派生信号. 它采用 push-pull 混合模型: 依赖变更时只是把 computed 标记为 dirty (push) , 真正重新执行 fn 是在下次被读取时 (pull) , 因此未被使用的派生值零开销; 同时用版本号/全局版本计数避免重复计算与菱形依赖问题.
3. effect(fn): 立即执行并订阅其依赖, 依赖变化时重新调度执行; batch(fn) 把多次写入合并, 批量结束才统一通知, 避免级联抖动.

与框架结合时, 组件渲染就是一个 effect: 渲染中读到的 signal 直接订阅到组件级更新, 无需 vdom 全树 diff, 状态变更可精确到文本节点级更新, 这是 signals 类方案性能优势的来源. React 集成则通过 useSignals() (babel 转换或 hook) 让组件重渲染订阅信号.

浏览器/标准侧的 Signal API: 指 TC39 的 JavaScript Signals 标准化提案 (proposal-signals) , 目标是把框架间各自实现的响应式核心收敛为语言级原语, 便于框架互操作与 DevTools 支持. 提案 API 形态为:

- Signal.State: 可写信号, 通过 .get()/.set() 读写.
- Signal.Computed: 惰性计算信号, 缓存 + 脏检查 (push-pull 语义与 preact 一致) .
- Signal.subtle.Watcher: 底层观察者, watch(signal) 后用 getPending() 取出变更的信号再主动拉取值; 刻意不内建 effect, 把调度策略留给框架.
- Signal.subtle.untrack 等用于在回调中解除依赖收集.

该提案目前仍处于标准化推进阶段 (Stage 1 之后持续打磨, 尚无浏览器原生全量实现) , 使用前需要 polyfill. 注意不要与 AbortSignal 混淆: AbortSignal 是已广泛实现的取消机制 API (配合 AbortController 用于 fetch 取消、addEventListener 移除等) , 二者只是名字相似.

## 第四部分 BOM 与浏览器 API

### BOM 包含哪些内容

A: BOM (Browser Object Model) 是浏览器提供给 JS 操作浏览器窗口的一组对象模型, 核心是 window, 它同时是 JS 的全局对象. 主要包括:

- window: 全局对象, 提供 alert/confirm/prompt、open/close、setTimeout 等定时器、scrollTo/scrollBy、resizeTo、getComputedStyle、matchMedia (媒体查询监听) 、requestAnimationFrame 等.
- location: 当前 URL 信息与导航控制.
- history: 会话历史栈操作.
- navigator: 浏览器与设备信息, 以及 clipboard、geolocation、serviceWorker、sendBeacon 等能力入口.
- screen: 屏幕尺寸、可用区域、方向.
- frames/self/top/parent/opener: 窗口层级关系引用.
- IndexedDB、Cache Storage、Web Storage 等存储接口也挂在 window 下.

BOM 与 DOM 的关系: DOM 是文档对象模型 (document 及其节点树) , BOM 是围绕窗口的浏览器能力集合; window.document 是两者交汇点. BOM 长期没有统一标准, 由 HTML 规范中的 window 相关章节和各浏览器事实行为共同定义.

### location history navigator 常用 API

A: location:

- 解析属性: href、protocol、host (含端口) 、hostname、port、pathname、search、hash、origin.
- 操作: assign(url) 跳转并保留历史; replace(url) 跳转不留下历史条目; reload() 刷新; 直接给 location.href/hash 赋值等效于 assign.
- URLSearchParams 解析与构造查询串, 支持 get/getAll/set/append/排序遍历; 现代代码推荐配合 URL 类 (new URL(href, base)) 做解析与拼接.

history:

- length、back()、forward()、go(n).
- pushState(state, title, url) / replaceState: 不触发页面加载地修改 URL 与历史条目, 是 SPA history 路由的基础.
- popstate 事件: 只在用户点击前进/后退或调用 back/go 时触发, pushState 本身不触发, 需要自己派发或封装.
- state 对象随历史条目存储 (结构化克隆, 有大小限制, 浏览器崩溃恢复时可还原) .
- scrollRestoration = 'manual' 可接管 SPA 的滚动位置还原.

navigator:

- userAgent 及更现代的 User-Agent Client Hints (getHighEntropyValues) ; 语言 languages; onLine 与 online/offline 事件; connection (NetworkInformation: effectiveType、downlink、rtt、saveData) .
- hardwareConcurrency (逻辑核数, 常用于决定 Worker 池大小) 、deviceMemory.
- sendBeacon(url, data): 页面卸载时也能可靠发送小数据, 埋点上报首选 (POST、无响应回调、排队由浏览器保证) .
- clipboard 读写 (需权限与安全上下文) 、geolocation、permissions.query、storage.persist() 申请持久存储、serviceWorker 注册入口.

### 前端路由 hash 与 history 模式的实现

A: 两种模式都依赖“改变 URL 不刷新页面”的能力, 由 JS 接管渲染.

hash 模式:

- 修改 location.hash 不产生请求, 触发 hashchange 事件.
- 兼容性好 (包括老浏览器与 file:// 协议) , 服务端零配置.
- 缺点: URL 带 # 不美观; # 后的内容不发送到服务端, SEO 与分享直链场景受限.

history 模式:

- history.pushState/replaceState 修改 URL 无刷新; 用户前进后退时监听 popstate 做渲染.
- 需要服务端配合: 所有路由路径 fallback 到 index.html, 否则直接访问/刷新子路径会 404.

最小实现思路:

```js
class Router {
  constructor(routes) {
    this.routes = routes;
    window.addEventListener("popstate", () => this.render(location.pathname));
    document.addEventListener("click", (e) => {
      const a = e.target.closest("a[data-link]");
      if (!a) return;
      e.preventDefault();
      history.pushState(null, "", a.href);
      this.render(location.pathname);
    });
    this.render(location.pathname);
  }
  render(path) {
    const view = this.routes[path] || this.routes["/404"];
    document.querySelector("#app").innerHTML = view();
  }
}
```

要点: 拦截内部链接点击、处理 popstate、处理锚点与滚动还原 (history.scrollRestoration) 、404 兜底、服务端 rewrite 规则 (nginx try_files $uri /index.html) .

### 页面生命周期事件有哪些

A: 加载阶段 (document.readyState 经历 loading → interactive → complete) :

- readystatechange: 状态切换时触发.
- DOMContentLoaded: HTML 解析完成且 defer/模块脚本执行完毕时触发; 不等待图片等子资源, 但会等待阻塞脚本的样式表 (脚本需要查询样式) .
- window load: 所有资源 (图片、样式、iframe 等) 加载完成.

卸载与可见性阶段 (Page Lifecycle API) :

- beforeunload: 可提示用户确认离开 (现代浏览器忽略自定义文案, 且要求用户与页面有过交互才允许弹窗) .
- unload: 历史遗留, 移动端不可靠, 且会阻止 bfcache, 规范上不建议使用.
- pagehide: 卸载统一入口, event.persisted 表示页面是否进入 bfcache (前进后退缓存) .
- pageshow: 每次显示时触发, persisted 为 true 表示从 bfcache 恢复, 需在此恢复定时器、重连 WebSocket 等.
- visibilitychange (document.visibilityState: visible/hidden) : 标签页切换, 用于暂停视频、轮询降频、上报数据.
- freeze/resume: Chrome 冻结后台页面时触发, 用于释放非必要资源.

实践建议: 埋点与状态持久化放在 visibilitychange (hidden) + pagehide, 而不是 beforeunload/unload; 发送用 navigator.sendBeacon 或 fetch keepalive.

### 跨窗口与跨标签页通信方式

A: 常见方案:

1. postMessage: window.postMessage(message, targetOrigin, transfer) 是跨源通信的标准方式 (iframe 与父页面、window.open 的 opener/child) . 数据走结构化克隆, 可传 Transferable (ArrayBuffer、MessagePort、OffscreenCanvas) 零拷贝转移. 接收方必须校验 event.origin 与 event.source, 防止任意站点注入消息.
2. BroadcastChannel: 同源 (协议+域名+端口) 下所有标签页/iframe/Worker 间发布订阅, API 极简: new BroadcastChannel('app') + postMessage/onmessage. 注意发消息的上下文自己收不到自己的消息.
3. localStorage + storage 事件: 写 storage 时其他同源标签页收到 storage 事件 (本标签页收不到) , 可传递小数据, 兼容性好, 常作降级方案.
4. SharedWorker: 同源页面共享一个 Worker, 通过 port 收发消息, 可做集中式状态/连接管理.
5. Service Worker 中转: clients.matchAll + postMessage 可实现离线场景下的页面间通信.
6. IndexedDB/Cache API + 轮询: 低频场景可用.

选型: 跨源 iframe 用 postMessage; 同源多标签实时同步 (登录态广播、编辑锁) 首选 BroadcastChannel; 需要兼容旧浏览器退回 storage 事件.

### Web Worker 与 Service Worker

A: Web Worker:

- 在独立线程运行脚本, 无 DOM 访问权, 与主线程通过 postMessage 通信 (结构化克隆; Transferable 转移所有权实现零拷贝, 如大 ArrayBuffer) .
- 类型: DedicatedWorker (单页面专用) 、SharedWorker (同源多页面共享) .
- 用途: CPU 密集计算 (编解码、加密、大数据处理、Canvas 离屏渲染 OffscreenCanvas) , 避免阻塞主线程导致掉帧.
- 限制: 无法访问 window/document/localStorage (可用 IndexedDB) ; 脚本需同源或 CORS; 创建有成本, 适合任务池化复用.

Service Worker:

- 本质是注册在某个 scope 下的可编程网络代理: 页面发出的请求先经过 SW 的 fetch 事件, 可由缓存、网络或合成响应应答, 从而实现离线可用 (PWA 核心) .
- 生命周期: register → install (通常预缓存静态资源) → waiting → activate (清理旧缓存, clients.claim() 立即接管) → fetch/message 事件; 更新遵循字节对比 + skipWaiting.
- 运行在独立线程, 无 DOM; 要求 HTTPS (localhost 除外) ; 页面卸载后仍可被事件唤醒 (push、background sync、periodic sync) .
- 与页面通信: postMessage + clients.matchAll, 或 BroadcastChannel.
- 实践: 版本化缓存名、activate 中删除旧版本、谨慎使用 skipWaiting (避免页面与 SW 版本错配) , Workbox 可封装常见策略.

两者对比: Worker 为计算而生, 生命周期跟随页面; SW 为网络而生, 生命周期由浏览器管理、可脱离页面存活.

## 第五部分 浏览器渲染原理

### 浏览器渲染流水线是怎样的

A: 从字节到像素的主线 (以 Blink 为例) :

1. 解析: HTML 字节流经解码、分词 (tokenization) 、树构建生成 DOM. 解析是流式增量的, 浏览器会边下载边解析边渲染; 预加载扫描器 (preload scanner) 在主解析器阻塞时提前发现 script/link/img 等资源并行发起请求.
2. CSS 解析生成 CSSOM; CSS 是渲染阻塞资源 (渲染树需要完整 CSSOM) , 且会阻塞其后的脚本执行.
3. 合并 DOM + CSSOM 生成渲染树 (只含可见节点, display:none 与 head 等不入树) .
4. Style/Layout (布局/重排) : 计算每个节点的精确几何信息 (盒模型、位置、尺寸) . 现代实现中 style 计算与 layout 是分开的 pass.
5. Paint (绘制) : 把节点转成绘制指令列表 (display list) , 并按层 (layer) 分组.
6. Raster (光栅化) : 把绘制指令转成位图像素, 通常分块 (tile) 在光栅线程池完成, 可用 GPU 加速.
7. Composite (合成) : 合成线程把各层的位图按变换、裁剪、透明度合成为最终帧, 提交给显示.

JS 可以在解析阶段介入 (同步脚本阻塞解析器) , 也可以在渲染之后通过修改 DOM/样式使流水线部分阶段失效重跑. 理解这条流水线是分析重排重绘、层合成与性能优化的基础.

### 重排与重绘是什么 如何减少

A: 重排 (reflow/layout) : 几何属性变化导致重新计算布局, 之后必然紧跟重绘. 触发源: 增删可见节点、改变尺寸/位置类样式 (width、margin、font-size) 、窗口 resize、字体加载完成、读取会强制同步布局的属性 (offsetTop、scrollTop、getBoundingClientRect 等, 在布局脏的情况下读取会强制立即布局) .

重绘 (repaint) : 外观变化但不影响几何, 如 color、background、visibility、box-shadow, 只重跑绘制阶段 (不经过布局) .

成本关系: 重排 > 重绘 > 仅合成 (composite only, transform/opacity 变化由合成线程直接处理, 主线程空闲, 见「合成层是什么 为什么 transform 动画更流畅」) .

优化清单:

- 合并 DOM 变更 (fragment、一次 class 切换代替多条 style 写入) .
- 读写分离, 避免强制同步布局; 循环外读取几何值.
- 对动画元素使用 transform/opacity, 并配合 will-change 或 translateZ(0) 提升为独立合成层.
- 复杂动画元素用 position: fixed/absolute 脱离文档流, 缩小重排影响面.
- 使用 CSS containment (contain: layout paint) 与 content-visibility 限定影响范围.
- 列表局部更新代替整体重建; 必要时 virtual list.

### 合成层是什么 为什么 transform 动画更流畅

A: 现代浏览器把页面拆成多个合成层 (GraphicsLayer) , 各层独立光栅化为位图, 最后由合成线程在 GPU 中按层的变换与透明度拼合成帧.

层提升 (layer promotion) 的常见条件: 3D transform (translateZ(0)、translate3d) 、will-change: transform/opacity、对 transform/opacity 做 CSS 动画或 transition、video、canvas、position: fixed (部分内核) 、filter、与其他层叠上下文重叠时的被动提升.

为什么 transform/opacity 动画流畅: 这类属性变化只需要合成线程对已光栅化的位图做矩阵变换或透明度混合, 不触发主线程的样式计算、布局与绘制. 即便主线程被 JS 占满, 合成线程驱动的动画 (compositor animation) 依然不掉帧——这也是 CSS transform 动画比 left/top 动画流畅的本质.

注意事项:

- 层不是免费的: 每层占用显存/内存, 大量 translateZ(0) 会造成“层爆炸”, 移动端尤其明显.
- will-change 是“将要变化”的提示, 应在使用前短期添加、结束后移除, 长期滥用反而浪费资源.
- 某些样式会破坏层的独立性 (如父级 overflow 裁剪、filter 形成包含块) , 导致动画回落到主线程.
- 用 DevTools 的 Layers 面板可直观查看层边界与提升原因.

### CSS 与 JS 的渲染阻塞 async 与 defer 的区别

A: 阻塞行为:

- CSS 是渲染阻塞资源: 构建渲染树必须等 CSSOM 完成, 未加载完的样式表会推迟首次渲染; 媒体查询不匹配的样式表 (如 print) 不阻塞渲染但仍会下载.
- CSS 还会阻塞其后脚本的执行: 脚本可能读取样式, 浏览器必须保证脚本拿到最新的 CSSOM.
- 同步 JS 是解析阻塞资源: script 标签 (无异步属性) 下载并执行期间, HTML 解析暂停; 这既是首屏杀手, 也是把脚本放 body 底部或加异步属性的原因.

script 加载方式对比:

- 普通 script: 遇到即阻塞解析, 下载完立即执行.
- async: 下载与解析并行, 下载完成后立即暂停解析来执行; 执行顺序不保证, 适合独立脚本 (统计、广告) .
- defer: 下载与解析并行, HTML 解析完成后按文档顺序执行, 在 DOMContentLoaded 之前; 适合有依赖关系的业务脚本.
- type="module": 默认 defer 行为 (下载含依赖图) , 也可加 async 变为尽快执行.
- 动态创建的 script 默认 async = true.

补充: preload scanner 会提前发现这些资源并行下载; 对关键第三方域名用 preconnect 预热连接; 内联关键脚本可省去一次 RTT 但失去缓存.

### 关键渲染路径与 preload prefetch preconnect

A: 关键渲染路径 (CRP) 是首屏渲染所必需的资源与处理步骤: HTML → CSSOM → (阻塞渲染的) JS → 渲染树 → 布局 → 绘制. 优化目标是最小化关键资源数量、关键字节数与关键路径长度 (RTT 次数) : 内联关键 CSS、拆分并延迟非关键 JS、给字体和首图最高优先级.

资源提示 (resource hints) :

- dns-prefetch: 仅提前做 DNS 解析, 成本最低.
- preconnect: 提前完成 DNS + TCP + TLS 握手, 为即将使用的第三方源省掉数百毫秒; 注意不要对太多源使用, 连接本身有成本.
- preload: 以高优先级提前下载当前页面马上要用、但发现较晚的资源 (字体、CSS 中的背景图、JS 动态加载的模块) , 必须带 as 属性 (font 还需 crossorigin) ; preload 只下载不执行.
- prefetch: 低优先级预取下一次导航可能用到的资源, 空闲时才下载.
- fetchpriority="high/low": 直接提示浏览器某资源的相对优先级 (如 LCP 图片设 high) .
- Speculation Rules API (prerender/prefetch 规则声明) : 现代 Chrome 对整页做推测性预渲染, 取代已废弃的 prerender 资源提示.

### 浏览器多进程架构

A: 以 Chrome 为例的多进程模型:

- Browser 进程: UI、地址栏、书签、导航协调、权限与存储管理.
- Renderer 渲染进程: 负责 HTML/CSS/JS 执行与绘制, 运行在沙箱中, 默认按站点 (site, 即 scheme + eTLD+1) 隔离实例——站点隔离 (Site Isolation) 让不同站点的页面运行在不同渲染进程 (同一站点下不同源的多个页面仍共用进程), 是缓解 Spectre 类侧信道攻击的关键防线.
- GPU 进程: 处理光栅化与合成的 GPU 调用, 独立于渲染进程以隔离驱动崩溃.
- Network Service 进程: 网络栈独立成服务进程.
- Utility/Plugin 进程: 音视频解码、扩展等按需拆分.

渲染进程内的线程:

- 主线程: JS 执行、样式、布局、绘制指令生成.
- 合成线程 (compositor) : 接收输入事件 (滚动优先走合成线程, 除非有非 passive 监听) 、层合成、驱动 compositor 动画.
- 光栅工作线程池: 分块光栅化.
- Worker 线程: Web Worker/Service Worker 各自独立线程.

架构收益: 单标签崩溃不影响整体、安全沙箱、并行利用多核; 代价是内存开销 (Chrome 对进程数有上限并会把同站点页面合并到同一进程) . iframe 与跨源 iframe (OOPIF) 也受益于站点隔离而分进程渲染.

## 第六部分 浏览器存储与缓存

### cookie localStorage sessionStorage IndexedDB 的区别

A: 四个维度对比:

容量: cookie 约 4KB (且每个域数量有限制) ; localStorage/sessionStorage 一般 5~10MB; IndexedDB 可用磁盘配额的大头 (通常可达数百 MB 以上, 受 StorageManager 配额约束) .

生命周期: cookie 由 Expires/Max-Age 决定, 缺省为会话级; localStorage 永久 (除非主动清除) ; sessionStorage 随标签页会话结束 (刷新保留, 关闭标签销毁) ; IndexedDB 永久.

传输与作用域: cookie 每次同源 (且匹配 Domain/Path) 请求自动携带, 可被服务端读写; Web Storage 纯客户端, 不参与请求; sessionStorage 按标签页隔离 (即使同源不同标签也互不可见) ; localStorage 与 IndexedDB 同源共享.

API 与能力: cookie 操作是字符串解析, 繁琐; Web Storage 是同步 KV 接口, 阻塞主线程且只能存字符串 (对象需 JSON 序列化) ; IndexedDB 是异步事务型 NoSQL 数据库, 支持索引、游标、版本升级、存结构化克隆对象与二进制.

选型建议: 会话凭证用 HttpOnly cookie (而非 localStorage, 防 XSS 窃取) ; 跨标签共享的小配置用 localStorage; 表单草稿等标签内状态用 sessionStorage; 大体积结构化数据、离线应用、文件缓存用 IndexedDB (推荐 idb 等轻封装) ; 更大的响应缓存走 Cache API.

### cookie 的重要属性有哪些

A: 核心属性:

- Expires / Max-Age: 过期时间, 缺省为会话 cookie (浏览器关闭即失效, 实际各浏览器对“会话恢复”处理有差异) . Max-Age 优先级高于 Expires.
- Domain: 指定生效域名. 不带 Domain 时是 host-only (仅当前主机) ; 显式设置 Domain=example.com 则包含所有子域. 只能设置为当前域或其父域.
- Path: 路径前缀匹配才携带.
- Secure: 仅 HTTPS 发送.
- HttpOnly: JS 无法通过 document.cookie 读取, 抵御 XSS 偷取凭证 (但不能防 CSRF, 因为请求仍会自动带 cookie) .
- SameSite: 跨站请求携带策略. Strict 完全不带; Lax 允许顶层导航 GET 携带 (Chrome 自 80 起把缺省值改为 Lax) ; None 总是携带但必须同时 Secure. 它是防 CSRF 的第一道防线, 也直接影响第三方嵌入场景 (iframe 内 cookie 属于跨站, 需要 SameSite=None; Secure) .
- Partitioned (CHIPS) : 把第三方 cookie 按顶层站点分区存储, 替代全面禁用第三方 cookie 后的跨站存储方案.
- 前缀约定: Host- (要求 Secure、无 Domain、Path=/) 与 Secure- (要求 Secure) , 服务端可据此校验 cookie 未被低权限子域篡改.

安全实践: 会话 cookie 组合使用 HttpOnly + Secure + SameSite=Lax/Strict + \_\_Host- 前缀; 敏感操作再叠加 CSRF Token.

### HTTP 强缓存与协商缓存

A: 浏览器请求一个资源时的决策链: 先查强缓存, 命中且未过期则直接使用 (不发请求, 状态码 200, 标注 from memory/disk cache) ; 否则发请求并带上协商缓存标识, 由服务器决定返回 304 (用缓存) 还是 200 (新内容) .

强缓存:

- Cache-Control: max-age=秒数: 相对过期时间, 优先级高于 Expires.
- Expires: HTTP/1.0 的绝对时间, 受客户端时钟影响.
- 其他指令: no-store 完全不存; no-cache 可以存但每次用前必须向服务器验证 (不是“不缓存”) ; public/private 控制共享缓存 (CDN) 是否可存; immutable 声明内容永不变 (配合 hash 文件名, 刷新页面也不验证) ; must-revalidate 过期后必须验证; stale-while-revalidate 允许先用过期内容同时后台验证; stale-if-error 出错时允许用旧内容兜底.
- 启发式缓存: 响应没有显式缓存头但有 Last-Modified 时, 浏览器可按 (Date - Last-Modified) × 10% 估算新鲜期, 依赖此行为不可控, 应显式设置.

协商缓存:

- Last-Modified / If-Modified-Since: 秒级精度.
- ETag / If-None-Match: 内容指纹, 优先级更高 (见「ETag 与 Last-Modified 的区别」) .
- 命中返回 304 Not Modified, 无响应体.

工程组合: HTML 用 no-cache (每次验证) 保证及时更新; 带内容 hash 的静态资源用 max-age=31536000, immutable 长期强缓存; API 按需使用 ETag 减少传输.

### ETag 与 Last-Modified 的区别

A: 工作机制: 两者都是协商缓存的验证器. Last-Modified 记录资源最后修改时间 (秒级) , 客户端用 If-Modified-Since 带回; ETag 是服务器生成的版本标识 (内容 hash 或版本号) , 客户端用 If-None-Match 带回. 请求同时带两者时, ETag 优先判定.

差异:

- 精度: Last-Modified 只有秒级, 一秒内多次修改无法区分; ETag 精确到内容版本.
- 成本: ETag 计算 (如 hash) 比读 mtime 略贵, 但通常可接受.
- 语义陷阱: 文件内容没变但 mtime 变了 (重新部署、文件重写) 会让 Last-Modified 失效而 ETag 仍可命中; 分布式集群各机器 mtime 不一致也会干扰 Last-Modified.
- 强/弱验证器: ETag 前缀 W/ 表示弱验证器, 只要求语义等价 (如 gzip 压缩后字节不同但内容等价) , 适用于不改变语义的转换; 强 ETag 要求字节级一致, Range 请求依赖强验证器.
- If-None-Match: \* 用于“仅当资源不存在时”语义 (防止并发覆盖, 配合 PUT) .

### Service Worker 缓存策略

A: 常见运行时缓存策略 (Workbox 中的同名策略) :

- Cache First: 先查缓存, 命中直接返回, 否则请求网络并写入缓存. 适合带 hash 的静态资源.
- Network First: 先走网络, 成功后更新缓存, 失败回落缓存. 适合对新鲜度敏感但需离线兜底的 API/页面.
- Stale While Revalidate: 立即返回缓存 (若有) , 同时后台请求并更新缓存, 下次访问拿到新内容. 适合头像、非关键数据, 体验与新鲜度折中.
- Cache Only / Network Only: 纯离线资源或必须实时的请求.

骨架代码:

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
      return cached || fetching;
    })(),
  );
});
```

配套实践:

- 预缓存: install 事件中 caches.open('precache-vN').addAll([...]) 缓存应用外壳 (App Shell) , 版本号随构建变化.
- activate 中删除旧版本缓存, 避免配额膨胀; clients.claim() 让新 SW 立即接管页面.
- 更新策略: skipWaiting 加速生效但要防止“新 SW 服务旧页面”导致的资源版本错配, 常见做法是提示用户刷新.
- Navigation Preload 让导航请求与 SW 启动并行, 降低 SW 冷启动对首屏的影响.
- 只缓存 GET; 注意响应类型 (opaque 跨域响应不可读且占配额) .

## 第七部分 网络基础与 HTTP

### 从输入 URL 到页面展示发生了什么

A: 完整链路 (以 HTTPS 站点为例) :

1. URL 解析与预处理: 解析协议、主机、路径; 检查 HSTS 列表, 若在列表中 (或已收到过 STS 响应头) 直接改写为 https.
2. 缓存检查: 先看浏览器内存/磁盘缓存与 Service Worker, 强缓存命中则直接使用, 跳过网络.
3. DNS 解析: 浏览器缓存 → 系统缓存 → hosts 文件 → 递归解析器, 依次查询根、顶级域 (.com) 、权威服务器得到 A/AAAA 记录; CDN 场景按调度策略返回就近节点 IP.
4. 建立连接: TCP 三次握手; HTTPS 再做 TLS 握手 (TLS 1.3 为 1-RTT, 会话复用可 0-RTT) ; HTTP/2 通过 ALPN 协商, HTTP/3 则直接走 QUIC (UDP) .
5. 发送请求: 浏览器自动带上 Cookie、缓存验证头等; 若命中协商缓存条件, 服务端返回 304.
6. 服务端处理: 负载均衡、网关、应用服务、数据库, 返回响应 (可能经历 301/302/307/308 重定向链) .
7. 渲染流水线: 流式解析 HTML 构建 DOM、解析 CSS 构建 CSSOM、执行 JS、布局、绘制、合成 (细节见「浏览器渲染流水线是怎样的」) , 期间边下载边渲染.
8. 后续: DOMContentLoaded → 懒加载/异步数据请求 → load 事件 → 用户交互, 空闲时执行 prefetch 等低优先级任务.

回答思路: 按“导航阶段 (1-4) → 请求响应 (5-6) → 解析渲染 (7-8) ”三段展开, 并把缓存、CDN、HTTP/2 多路复用、渲染流水线作为可深挖的延伸主动点出.

### TCP 三次握手与四次挥手

A: 三次握手:

1. 客户端发送 SYN (seq=x) , 进入 SYN_SENT.
2. 服务端回 SYN+ACK (seq=y, ack=x+1) , 进入 SYN_RCVD.
3. 客户端回 ACK (ack=y+1) , 双方进入 ESTABLISHED.

为什么不是两次: 两次无法让服务端确认客户端的接收能力 (双向的初始序列号都需要对方确认) ; 且无法防止历史失效的连接请求 (网络中滞留的旧 SYN 突然到达) 让服务端白白建立连接浪费资源. 三次握手让双方互认了彼此的发送与接收能力及初始序列号.

四次挥手:

1. 主动方发 FIN (我要发完了) , 进入 FIN_WAIT_1.
2. 被动方回 ACK, 进入 CLOSE_WAIT; 主动方收到后进入 FIN_WAIT_2. 此时被动方可能还有数据要发, 因此 ACK 与 FIN 不能合并.
3. 被动方数据发完, 发 FIN, 进入 LAST_ACK.
4. 主动方回 ACK, 进入 TIME_WAIT, 等待 2MSL 后关闭; 被动方收到 ACK 即关闭.

为什么挥手是四次: TCP 全双工, 两个方向需独立关闭; 被动方的 ACK 与 FIN 通常分开发送 (还有数据要传) .

TIME_WAIT 存在的意义: 保证最后一个 ACK 若丢失, 对方重发 FIN 时还能再确认一次; 同时让本次连接的旧报文在 2MSL 内从网络中消逝, 避免污染下一次相同四元组的连接. 大量短连接导致 TIME_WAIT 堆积是经典后端问题 (可用连接复用/HTTP keep-alive 缓解) .

### HTTPS 与 TLS 握手过程

A: HTTPS = HTTP over TLS, 提供机密性 (对称加密传输数据) 、完整性 (MAC/AEAD 校验) 、身份认证 (证书链) .

TLS 1.2 握手 (2-RTT) :

1. ClientHello: 支持的版本、加密套件列表、客户端随机数、SNI (指示目标域名, 支持虚拟主机) 、ALPN (协商 h2/http1.1) .
2. ServerHello: 选定套件、服务端随机数.
3. Certificate: 服务器证书链.
4. ServerKeyExchange (ECDHE 参数) 与 ServerHelloDone.
5. 客户端验证证书: 链路到受信 CA、域名匹配、有效期、吊销状态 (OCSP/CRL, OCSP Stapling 由服务器附带签名的吊销状态) . 随后发送 ClientKeyExchange (ECDHE 公钥) , 双方用两个随机数 + ECDHE 共享秘密算出会话密钥.
6. ChangeCipherSpec + Finished: 互发加密后的校验消息, 握手完成, 之后用对称算法 (AES-GCM、ChaCha20-Poly1305) 加密应用数据.

TLS 1.3 的改进:

- 1-RTT: ClientHello 直接携带 key_share (猜测的密钥交换参数) , ServerHello 之后的一切 (含证书) 都加密.
- 0-RTT 会话恢复: 用 PSK 在早期数据中直接发送加密的应用数据, 但有重放风险, 只适合幂等请求.
- 移除 RSA 密钥交换, 强制前向安全性 (PFS) ; 精简加密套件.

常见延伸: 对称加密快用于数据、非对称加密用于认证与密钥协商的分工; 中间人为何无法伪造证书 (CA 私钥签名 + 浏览器内置根证书) ; SNI 明文与 ECH 加密扩展.

### HTTP/1.1 的队头阻塞问题

A: HTTP/1.1 中一个 TCP 连接上请求必须串行: 前一个响应完整返回后才能复用连接发下一个请求 (keep-alive 只解决连接复用, 不解决并发) . 前一个响应慢, 后面全部排队, 这就是应用层队头阻塞.

历史补救与副作用:

- 浏览器对同一域名开 6 个左右 TCP 连接并发请求.
- 域名分片 (把资源拆到多个子域绕开单域连接数限制) .
- 资源合并 (雪碧图、打包合并 JS/CSS) 、内联小资源, 用“少请求”换性能.
- 管线化 (pipelining) 允许连续发多个请求, 但响应仍需按序返回, 队头阻塞依旧, 且代理兼容性差, 默认被禁用.

这些 workaround 带来新问题: 连接建立开销 (TCP+TLS 握手成本×6) 、拥塞控制互相竞争、缓存粒度变粗 (合并文件一改全改) . HTTP/2 的多路复用从协议层解决了应用层队头阻塞 (见「HTTP/2 的核心特性」) , 于是合并与域名分片在 H2 时代反而变成反模式. 注意 H2 只解决了 HTTP 层队头阻塞, TCP 层的队头阻塞 (丢包导致后续数据等待重传) 由 HTTP/3 解决 (见「HTTP/3 与 QUIC 解决了什么问题」) .

### HTTP/2 的核心特性

A: HTTP/2 在保留 HTTP 语义 (方法、状态码、头部) 的前提下重写了传输层:

1. 二进制分帧: 引入二进制帧层, 消息被拆成帧 (HEADERS、DATA 等) , 每个帧带 stream id; 取代 H1 的文本协议, 解析更高效.
2. 多路复用: 一个 TCP 连接上多个 stream 的帧交错传输、独立优先级, 请求/响应并行, 彻底解决 HTTP 层队头阻塞; 浏览器对同一源只需一个连接.
3. HPACK 头部压缩: 静态表 (常见头名值) + 动态表 (连接内增量维护) + Huffman 编码, 显著压缩重复的头部 (Cookie、UA 等) .
4. 流优先级: 依赖树 + 权重, 客户端可提示资源加载顺序 (实际各服务器支持程度不一, RFC 9218 又引入了新的优先级方案) .
5. 服务器推送 (Server Push) : 服务端主动推送关联资源. 实践表明收益不稳定、缓存协调复杂, Chrome 已于 106 版本移除支持, 属于“了解即可的历史知识”.
6. 流控制: 基于 WINDOW_UPDATE 的按流流量控制.

部署事实: 浏览器只支持基于 TLS 的 h2 (通过 ALPN 协商) , 所以启用 H2 必须先上 HTTPS. 遗留短板: 单个 TCP 丢包会阻塞所有流 (传输层队头阻塞) , 这是 HTTP/3 的动机.

### HTTP/3 与 QUIC 解决了什么问题

A: QUIC 把传输层从 TCP 换成 UDP 之上的用户态可靠传输协议, HTTP/3 是跑在 QUIC 上的 HTTP 语义映射. 解决的问题:

1. TCP 队头阻塞: TCP 按字节流保序, 一个包丢失, 其后所有数据都要等重传. QUIC 原生多流, 每个流独立做可靠性与排序, 丢包只阻塞所在流.
2. 握手延迟: QUIC 把传输与 TLS 1.3 握手合一, 新连接 1-RTT; 会话恢复时 0-RTT 直接发加密数据 (同样有重放风险) .
3. 连接迁移: TCP 连接由四元组 (源/目的 IP+端口) 标识, Wi-Fi 切蜂窝网络即断连; QUIC 用 Connection ID 标识连接, 网络切换后连接可无缝延续.
4. 协议僵化 (ossification) : TCP 在内核态, 中间设备 (NAT、防火墙) 对未知选项的干扰使 TCP 难以演进; QUIC 在用户态实现、报文除最小头外整体加密, 迭代快且抗中间件干扰.
5. 头部压缩改用 QPACK: 适配乱序到达, 避免 HPACK 在乱序流上的解码阻塞.

现状与挑战: 主流浏览器与大型 CDN 已广泛支持 (通过 Alt-Svc 头或 HTTPS DNS 记录发现) ; UDP 被部分企业网络限速/封锁、用户态协议栈 CPU 开销更高是主要落地障碍.

### DNS 解析过程

A: 以解析 www.example.com 为例:

1. 查本地缓存: 浏览器 DNS 缓存 → 操作系统缓存 → hosts 文件.
2. 交给递归解析器 (通常由运营商或公共 DNS 如 8.8.8.8/223.5.5.5 提供) , 递归解析器自己也有缓存.
3. 缓存未命中时递归解析器迭代查询: 先问根服务器 (.) 得到 .com 顶级域服务器地址; 再问 TLD 服务器得到 example.com 权威服务器地址; 最后问权威服务器得到 www.example.com 的 A/AAAA 记录.
4. 结果按 TTL 逐级缓存并返回给客户端.

进阶点:

- 记录类型: A (IPv4) 、AAAA (IPv6) 、CNAME (别名, 权威应答可链式) 、MX、TXT (验证与 SPF) 、NS、CAA、HTTPS/SVCB (可携带 ALPN 与 IP 提示, 支持 HTTP/3 发现与 ECH) .
- CDN 依赖 DNS 调度: 权威服务器根据来源 IP/运营商返回就近节点 (GeoDNS) , 配合 Anycast.
- 前端优化: dns-prefetch 提前解析第三方域名; preconnect 更进一步.
- 安全与隐私: 传统 DNS 明文可被劫持/监听, DoH (DNS over HTTPS, 443 端口) 与 DoT (853 端口 TLS) 加密查询; DNSSEC 提供应答签名验证防篡改.
- TTL 与故障切换的矛盾: TTL 短则切换快但查询频繁, 长则变更生效慢.

### 常见 HTTP 方法与状态码

A: 方法 (注意语义属性) :

- GET: 获取资源, 安全、幂等、可缓存.
- POST: 提交处理 (创建/触发操作) , 非幂等, 一般不缓存.
- PUT: 整体替换资源, 幂等; PATCH: 部分修改, 不保证幂等.
- DELETE: 删除, 幂等.
- HEAD: 同 GET 但无响应体, 用于探活/取元信息.
- OPTIONS: 查询能力, CORS 预检使用.
- CONNECT: 建立隧道 (代理) ; TRACE: 回环诊断 (常被禁) .

状态码:

- 1xx: 100 Continue (大 body 先探路) 、101 Switching Protocols (WebSocket 升级) 、103 Early Hints (提前下发 preload 头) .
- 2xx: 200 OK; 201 Created; 202 Accepted (异步受理) ; 204 No Content; 206 Partial Content (Range, 断点续传/视频拖动) .
- 3xx: 301 永久重定向 (浏览器会缓存, 方法可能改写为 GET) ; 302 Found 临时; 303 See Other (POST 后跳 GET) ; 304 Not Modified; 307/308 临时/永久且严格保持原方法与 body.
- 4xx: 400 参数错误; 401 未认证 (需登录) ; 403 已认证但无权限; 404; 405 方法不允许; 408 请求超时; 409 冲突 (并发编辑) ; 410 永久删除; 413 体过大; 415 媒体类型不支持; 422 语义校验失败; 429 限流 (配合 Retry-After) ; 431 头部过大.
- 5xx: 500 服务内部错误; 502 网关拿到无效上游响应; 503 不可用 (维护/过载, 可带 Retry-After) ; 504 网关等待上游超时.

易混点: 401 vs 403 (认证 vs 授权) ; 301 vs 302 vs 307 vs 308 (永久性与方法保持) ; 502 vs 504 (上游响应非法 vs 上游超时) .

### GET 与 POST 的区别

A: 语义层面 (规范定义的区别, 也是最本质的) :

- GET 是安全且幂等的读取操作, 语义上不应产生副作用; POST 是提交给服务器处理, 语义由资源自定义 (创建、下单、触发动作) .
- 缓存: GET 默认可缓存、可收藏、可预取; POST 默认不缓存 (除非响应显式允许) .
- 参数位置: GET 惯例把参数放 query string; POST 放 body. 注意规范并未禁止 GET 带 body, 但许多中间件会忽略, 实践中不使用.
- 幂等性影响行为: 浏览器回退/刷新 GET 无提示, 刷新 POST 会提示“确认重新提交表单”; 爬虫与预取只敢动 GET.
- 数据形式: GET 的 query 只能是 URL 编码文本; POST 的 body 支持多种 Content-Type (application/x-www-form-urlencoded、multipart/form-data、application/json、二进制) .
- 长度限制: 规范不限 URL 长度, 但浏览器与服务器有实际限制 (数 KB 到数 MB 不等) , 所以“GET 有长度限制”是实现限制而非协议限制.
- 安全误区: GET 参数出现在 URL, 会留在浏览器历史、服务器日志、Referer 中, 不宜放敏感信息; 但 POST 在 HTTP 下同样是明文, 安全性取决于 HTTPS 而非方法.
- 跨域角度: GET/POST (满足简单请求条件) 不一定触发预检, 但携带 JSON 的 POST 会触发 OPTIONS 预检 (见「CORS 跨域机制」) .

### CORS 跨域机制

A: CORS 是浏览器实施、服务器配合的跨源放行机制. 核心事实: 跨域请求通常已经发出去了 (非简单请求除外) , 浏览器拦截的是“把响应交给 JS 读取”这一步; 所以服务端不能靠 CORS 阻止请求到达, CSRF 防护不能依赖 CORS.

简单请求 (不触发预检) : 方法为 GET/HEAD/POST, 且头部仅限 safelist (Accept、Accept-Language、Content-Language、Content-Type 取值为 text/plain、multipart/form-data、application/x-www-form-urlencoded, 以及 Range 等) . 简单请求直接发送, 服务器需在响应中返回 Access-Control-Allow-Origin (匹配 Origin 或 \*) , 浏览器校验通过才把响应交给 JS.

预检请求: 不满足简单条件 (如 JSON Content-Type、自定义头 X-Token、PUT/DELETE) 时, 浏览器先发 OPTIONS 预检, 携带 Access-Control-Request-Method 与 Access-Control-Request-Headers; 服务器回应 Access-Control-Allow-Origin、Allow-Methods、Allow-Headers、Access-Control-Max-Age (预检结果缓存时长, 减少重复 OPTIONS) . 预检通过后才发真实请求.

凭证模式: fetch credentials: 'include' 或 XHR withCredentials 携带 Cookie 时, Access-Control-Allow-Origin 不能是 \*, 必须精确匹配 Origin, 且需 Access-Control-Allow-Credentials: true; SameSite 属性会进一步限制跨站携带.

其他要点:

- Access-Control-Expose-Headers 决定 JS 能读取哪些非 safelist 响应头 (如 X-Total-Count) .
- 失败时浏览器只在控制台报错, JS 拿到的只是笼统的网络错误, 不带状态码.
- Private Network Access 的后继方案 Local Network Access: 公网页面访问内网/本机地址需用户本地网络权限授权 (fetch 可用 targetAddressSpace 提示目标地址空间; Chrome 已由预检方案转向权限提示, 自 142 起逐步推进) .
- no-cors 模式得到的是 opaque 响应 (不可读、状态为 0) , 仅用于不依赖结果的场景.

### 跨域解决方案有哪些

A: 生产环境方案:

1. CORS: 标准做法, 服务端按「CORS 跨域机制」配置响应头, 首选.
2. 反向代理: nginx/网关把 api.example.com 代理到前端同源的 /api 路径下, 对浏览器而言是同源请求; 开发期用 devServer proxy (webpack/vite) 同理.
3. postMessage + iframe: 两个页面互嵌时通过 postMessage 通信 (需双方配合, 校验 origin) , 适合嵌入式 SDK.
4. WebSocket: 不受同源策略限制, 服务端校验 Origin 头即可, 适合实时双向场景.
5. JSONP: 利用 script 标签不受同源限制, 服务端返回回调包裹的数据. 只支持 GET、无错误处理、有 XSS 注入风险, 仅历史系统兼容使用.
6. 开发专用: 浏览器关闭安全策略 (--disable-web-security) 仅限本地调试, 绝不能作为方案.

历史/特殊手段 (了解即可) : document.domain 降级 (已废弃方向, 现代浏览器默认禁用) 、window.name 传数据、CORS 代理 (cors-anywhere 类, 注意把 Cookie 发给第三方的安全风险) .

相关补充: 跨源资源嵌入还有 CORP (Cross-Origin-Resource-Policy) 、COEP/COOP (跨源隔离, SharedArrayBuffer 的前提) 等新机制, 属于站点加固而非跨域数据方案.

### WebSocket 原理 与 SSE 的对比

A: WebSocket:

- 握手复用 HTTP/1.1: 客户端发 Upgrade: websocket、Connection: Upgrade、Sec-WebSocket-Key (base64 随机值) 、Sec-WebSocket-Version、可选 Sec-WebSocket-Protocol (子协议) ; 服务器回 101 Switching Protocols 与 Sec-WebSocket-Accept (Key + 固定 GUID 的 SHA-1 base64) , 之后连接升级为双向数据帧协议, 脱离 HTTP 语义.
- 帧协议: opcode (文本/二进制/ping/pong/close) 、FIN 分片、客户端到服务端必须掩码 (masking, 防代理缓存投毒) ; 支持 ArrayBuffer/Blob 二进制.
- 心跳与重连: 协议有 ping/pong, 但应用层通常自定义心跳检测 NAT 超时断链; 断线不会自动重连, 需应用实现指数退避重连与会话恢复.
- 安全: wss 走 TLS; 服务端应校验 Origin 头防跨站劫持 (WebSocket 不受 SOP 约束) .

SSE (Server-Sent Events) :

- 基于普通 HTTP 长响应 (Content-Type: text/event-stream) , 服务端持续写 data: 行, 浏览器 EventSource 解析.
- 单向 (服务端 → 客户端) , 只传文本 (UTF-8) , 可带 event 名与 id.
- 内置自动重连 (retry 字段控制间隔) 与 Last-Event-ID 断线续传.
- HTTP/1.1 下同域 6 连接限制会占坑, HTTP/2 下多路复用无此问题.

选型: 双向高频 (聊天、协作编辑、游戏) 用 WebSocket; 服务端单向推送 (通知、行情、日志流、AI 流式输出) 用 SSE 更简单且自带重连; 极端实时 (音视频、低延迟游戏) 考虑 WebTransport/WebRTC DataChannel.

### 同源策略是什么

A: 同源策略 (Same-Origin Policy) 规定: 只有当协议、域名 (主机) 、端口三者完全相同时, 两个文档才属于同源, 浏览器才允许它们不受限地互访. 它隔离的主要是“读”能力:

受限行为:

- 跨源读取 DOM (iframe.contentDocument) 、JS 对象 (window.open 的句柄) .
- 跨源 AJAX/fetch 读取响应 (CORS 可显式放行) .
- 跨源访问 localStorage、IndexedDB、Cookie (按域隔离) .

不受限 (历史遗留的“嵌入与导航”通道, 也是攻击面来源) :

- 标签加载: script、img、link、video/audio、iframe 可跨源嵌入 (JSONP 正是利用 script 标签; 响应以 opaque 形式存在, JS 读不到内容) .
- 表单提交可跨源 (写操作, 响应被导航掉) ——CSRF 的温床.
- 窗口导航 location.href 可跨源.

补充概念: origin (三元组) 与 site (eTLD+1, 如 a.b.example.com 与 c.example.com 同站不同源) ; SameSite cookie 用的是“站”的概念. 跨源隔离 (COOP+COEP) 可让页面进入 crossOriginIsolated 状态以使用 SharedArrayBuffer 等高精度能力.

## 第八部分 网络安全

### XSS 攻击类型与防御

A: XSS (跨站脚本) 是攻击者把恶意脚本注入到受信页面中执行, 从而窃取凭证、伪造操作、篡改页面.

三种类型:

- 存储型: 恶意内容持久化在服务端 (评论、昵称) , 所有访问者触发, 危害最大.
- 反射型: 恶意内容藏在 URL 参数中, 被服务端直接回显到响应里, 需要诱导点击构造好的链接.
- DOM 型: 完全发生在前端, 如把 location.hash 的值直接 innerHTML 到页面, 服务端不可见, 传统 WAF 难以拦截.

防御体系:

1. 输出编码 (根本手段) : 按输出上下文分别编码——HTML 文本转义 < > & " '; 属性上下文注意无引号属性; JS 字符串上下文用 Unicode 转义; URL 参数 encodeURIComponent; 富文本场景白名单过滤 (DOMPurify) , 黑名单过滤注定被绕过.
2. 避免危险 API: 优先 textContent 而非 innerHTML; 杜绝 eval/new Function; React 的 dangerouslySetInnerHTML、Vue 的 v-html 只在可信消毒后使用 (框架默认的插值转义已经挡掉大部分注入) .
3. CSP (Content-Security-Policy) : 纵深防御. script-src 用 nonce 或 hash 白名单内联脚本, 配合 strict-dynamic; 禁用 unsafe-inline/unsafe-eval 后注入脚本无法执行; report-uri/report-to 收集违规上报.
4. HttpOnly Cookie: 让会话凭证无法被 JS 读取, 把损失从“盗号”降为“在会话内冒用”.
5. Trusted Types: 浏览器级约束危险 sink (innerHTML 等) 只接受经策略函数处理的对象, 从源头收敛 DOM XSS.
6. 其他: X-XSS-Protection 已废弃且曾引入新问题, 应显式设 0; 对子域与上传内容做隔离域; 输入校验只是辅助, 不能替代输出编码.

### CSRF 原理与防御

A: 原理: 浏览器对目标站点发起请求时会自动携带该站点的 Cookie (ambient authority ) . 攻击者在自己的页面上构造指向目标站点的请求 (自动提交的表单、img/fetch) , 用户若已登录目标站点, 请求就带着其凭证完成转账、改密等操作. 攻击者读不到响应 (受 SOP 限制) , 但攻击本身只需要“发出请求”.

防御手段 (分层) :

1. SameSite Cookie: Lax (Chrome 默认) /Strict 下跨站请求不携带 Cookie, 直接瓦解大部分 CSRF; 需要跨站携带 (SSO、第三方嵌入) 的场景必须 SameSite=None; Secure, 并配合下面的 token.
2. CSRF Token (同步器模式) : 服务端下发不可预测的 token (渲染进表单或经接口下发) , 写操作必须携带, 服务端校验. 攻击者跨源读不到 token, 伪造不了.
3. 双重提交 Cookie: token 同时放 Cookie 与请求头/参数, 服务端比对两者一致. 跨源页面能带 Cookie 但读不到值、也无法写自定义头.
4. 自定义头防线: 要求写接口必须带自定义头 (如 X-Requested-With) . 表单无法加自定义头, 跨源 fetch 加自定义头会触发预检, 不通过则被拦.
5. Origin/Referer 校验与 Fetch Metadata (Sec-Fetch-Site/Mode/Dest/User) : 服务端据此识别跨站来源并拒绝.
6. 规范设计: GET 不产生副作用; 敏感操作加二次验证 (短信、密码、验证码) .

注意: HttpOnly 不防 CSRF (请求自动带 Cookie, 与 JS 能否读无关) ; JSON 接口同样可能因 Content-Type 可被表单伪造 (text/plain 拼 JSON) 而中招, 不能只靠“接口只收 JSON”假设.

### 点击劫持与防御

A: 点击劫持 (UI Redressing) : 攻击者把目标站点用透明 iframe 覆盖在诱导按钮上, 用户以为点击的是“抽奖”, 实际点击的是目标站点的“确认转账”. 变种包括拖拽劫持、光标劫持 (cursorjacking) .

防御:

- CSP frame-ancestors (现代首选) : frame-ancestors 'self' 或列出允许嵌入的祖先源, 粒度细、可枚举多个来源, 优先级高于 X-Frame-Options.
- X-Frame-Options: DENY / SAMEORIGIN: 传统响应头, 只支持两种取值, 无法枚举多个允许域.
- frame-busting JS (if (top !== self) top.location = self) : 不可靠——可被 sandbox 属性、CSP、禁用 JS 等方式绕过, 只能作兜底.
- 组合拳之外的缓解: SameSite Cookie 让 iframe 内的目标站点处于未登录状态, 攻击自然失效; 关键操作加二次确认/验证码.

相关场景: 第三方合法嵌入 (支付、地图) 需要在 frame-ancestors 中精确授权; 检测页面是否被嵌套也可用 window.self !== window.top 做埋点监控.

### 中间人攻击与 HSTS

A: 中间人攻击 (MITM) : 攻击者位于通信路径上 (伪造 Wi-Fi、ARP 欺骗、受控代理、DNS 劫持) , 窃听或篡改双方流量. HTTPS 通过证书认证 + 加密传输抵御: 中间人无法伪造合法证书 (无法通过 CA 链校验) , 篡改密文会被完整性校验发现.

SSL Stripping 与 HSTS: 用户习惯输入裸域名, 首个请求常是 http://, 中间人可在降级到 HTTP 的这一刻劫持 (sslstrip) . HSTS (Strict-Transport-Security) 让浏览器记住“此站只走 HTTPS”, 之后自动把 http 改写为 https:

- max-age: 记忆时长; includeSubDomains: 覆盖子域; preload: 申请进入浏览器内置预载列表.
- 预载列表解决“首次访问仍是 HTTP”的信任建立 (TOFU) 空窗期, 主流浏览器内置.
- 副作用: 证书配置错误期间用户无任何绕过入口, 上线前需充分验证.

配套加固:

- 证书透明度 (CT 日志) : CA 签发必须记录公开日志, 便于发现误签/盗签.
- OCSP Stapling: 服务器附带时间戳化的吊销状态, 兼顾隐私与性能.
- 混合内容: HTTPS 页面加载 HTTP 资源会被浏览器阻止 (active mixed content) 或自动升级 (upgrade-insecure-requests 指令) , 部署 HSTS 同时要清理旧资源链接.
- 证书固定 (pinning) : App 内常用; Web 端的 HPKP 因误配可导致站点永久不可访问已被废弃.
- 站内敏感 Cookie 加 Secure 与 \_\_Host- 前缀, 防止经 HTTP 通道泄露或被同站子域污染.

## 第九部分 性能优化

### 核心 Web 指标 Core Web Vitals

A: Google 定义的用户体验量化指标, 也是搜索排名信号:

- LCP (Largest Contentful Paint, 最大内容绘制) : 视口内最大图片/文本块渲染完成的时间, 目标 ≤ 2.5s. 优化方向: TTFB (CDN、缓存、SSR) 、资源优先级 (preload 首图、fetchpriority=high) 、图片压缩与现代格式、消除渲染阻塞.
- INP (Interaction to Next Paint, 交互到下一次绘制) : 2024 年 3 月起正式取代 FID. 衡量一次交互 (点击、键盘、触摸) 从输入到绘制下一帧的完整耗时 (输入延迟 + 处理时长 + 呈现延迟) , 取页面生命周期内的高分位值, 目标 ≤ 200ms. 比 FID 更严格: FID 只看首次交互的输入延迟. 优化方向: 拆分长任务 (scheduler.yield/postTask) 、减少主线程 JS、事件回调瘦身、延后非关键工作、避免巨型 DOM.
- CLS (Cumulative Layout Shift, 累积布局偏移) : 衡量非预期布局抖动, 目标 ≤ 0.1. 来源: 无尺寸图片/视频、动态注入的广告与横幅、字体替换 (FOUT) 、异步内容插入. 对策: 媒体元素写死宽高或 aspect-ratio、为嵌入位预留空间、font-display 配合 size-adjust 字体描述符、新内容插入到用户视线下方或响应用户操作.

辅助指标: TTFB (后端与 CDN 链路) 、FCP、TBT (实验室环境近似 INP) . 采集方式: 真实用户监控用 web-vitals 库 (基于 PerformanceObserver) 上报; 实验室用 Lighthouse/WebPageTest; CrUX 与 Search Console 提供群体数据. 实践中强调“用 RUM 数据定位最差 75 分位, 再对症下药”.

### 长列表渲染优化

A: 核心思路是减少同时存在的 DOM 节点数与每帧工作量:

1. 虚拟列表 (windowing) : 只渲染可视区 + overscan 缓冲区的行, 外层容器撑出总高度, 滚动时复用/重建节点. 固定行高实现简单; 动态行高需预估高度 + 实测缓存 + 滚动位置校正 (react-window 的 VariableSizeList、tanstack-virtual) . 十万级数据从“直接卡死”降为流畅滚动.
2. 分页与无限滚动: IntersectionObserver 监听哨兵元素加载下一页, 配合加载态与错误重试.
3. 单行渲染轻量化: 行组件 memo、稳定 key、事件委托代替每行绑定监听器、行内避免复杂选择器与深层嵌套.
4. 时间切片: 非首屏数据分片渲染 (rIC/postTask) , 避免一次性长任务阻塞交互; React 并发特性 (useTransition) 把列表更新标记为非紧急.
5. CSS 手段: content-visibility: auto + contain-intrinsic-size 让浏览器跳过屏外行的渲染 (接近“免费”的原生虚拟化, 但不减少 DOM 节点数) ; contain: layout paint 隔离行布局影响.
6. 数据层: 窗口化数据而非全量入状态; 大数据量排序过滤放 Web Worker; 传输用流式或二进制格式.
7. 极端场景: 表格/图形密集列表用 Canvas 渲染 (如 Luckysheet 类) , 牺牲可访问性换性能.

注意虚拟列表的代价: Ctrl+F 页面内查找失效、SEO 不友好、动态高度与滚动锚定复杂, 需要按场景权衡.

### 前端加载性能优化手段

A: 按“减少体积 → 减少请求 → 加快传输 → 优化执行”四步梳理:

减少体积:

- 构建压缩: minify、tree-shaking、scope hoisting; 产物用 brotli/gzip 传输压缩 (brotli 静态预压缩 .br) .
- 代码分割: 路由级懒加载 + 组件级懒加载 + 第三方大库按需引入/替换轻量方案; 分析工具 (source-map-explorer、rsdoctor) 定位冗余.
- 图片: WebP/AVIF、srcset/sizes 响应式、懒加载 loading="lazy" 或 IntersectionObserver、占位 (LQIP/骨架) ; 图标用 SVG sprite.
- 字体: 子集化 (fonttools) 、woff2、font-display: swap、preload 关键字体.

减少请求与调度优先级:

- HTTP/2/3 多路复用下不必强行合并, 但应控制请求总数与瀑布深度; 内联关键 CSS, defer 非关键 JS.
- preload/prefetch/preconnect/fetchpriority 精准调度 (见「关键渲染路径与 preload prefetch preconnect」) ; 路由跳转前预取数据与代码.

加快传输:

- CDN 就近分发 + 边缘缓存; 静态资源 hash 命名 + 一年强缓存 immutable, HTML no-cache 保证发版即时生效.
- HTTP/3/QUIC 降低弱网握手与队头阻塞成本; 开启 TLS 会话复用.
- 接口优化: 聚合接口/BFF、字段裁剪、分页、ETag 协商缓存.

优化执行与架构:

- SSR/SSG/流式渲染 (Streaming SSR) 缩短 FCP/LCP, islands/选择性 hydration 减少 hydration 成本.
- 长任务拆分、主线程减负, 重计算移入 Web Worker; 第三方脚本治理 (async/defer、facade 模式延迟加载、Partytown 移入 Worker) .
- Service Worker 预缓存 App Shell, 二次访问接近秒开.
- 建立性能预算 (bundle 大小、LCP/INP 目标) 并在 CI 中卡控, 用 RUM 持续观测真实用户指标.

## 第十部分 工程化与框架进阶

### Tree-shaking 的原理与失效场景

A: Tree-shaking 指打包器在构建期移除未被使用的导出代码 (dead code elimination 的模块级形态) , 其前提是 ESM 的静态结构: import/export 在编译期即可确定依赖关系, 不需要执行代码就能画出"哪些导出被谁引用"的图. CJS 的 require 是运行时动态调用, 无法可靠静态分析, 因此基本不可 tree-shake.

工作流程 (以 Rollup/webpack 为例) :

1. 构建模块图, 标记每个模块的导出与导入.
2. 从入口出发做可达性分析, 标记被使用的导出 (webpack 的 usedExports) .
3. 结合副作用分析决定能否删除: 一个未被引用的导出若其模块顶层代码有副作用 (修改全局、polyfill、注册样式) , 仍不能整体删除.
4. 由压缩器 (terser/esbuild/SWC minifier) 在生成阶段真正删除死代码.

常见失效场景:

- 模块含顶层副作用且 package.json 未声明 "sideEffects": false (或数组白名单, 注意 CSS 引入要保留 `*.css`) .
- 代码被 Babel/TS 转译成 CJS (如 tsconfig module: commonjs) , 静态结构丢失; 应保留 ESM 输出交给打包器.
- 重导出整包 (export \* from 'lib') 配合动态属性访问、类的静态方法挂载、装饰器等让分析器无法确认"未使用".
- `/*#__PURE__*/` 注释缺失时, 函数调用形式的导出初始化 (如 styled() 返回值) 被视为有副作用而保留; 组件库构建时需要工具自动注入 PURE 标记.
- lodash 这类 CJS 库整包引入; 应换 lodash-es 或 babel-plugin-import 之类的按需转换.

验证手段: 构建产物用 source-map-explorer/rsdoctor 分析; 对疑似未删除的模块检查其 sideEffects 声明与转译产物格式.

### webpack 与 vite 的核心差异与 HMR 原理

A: 核心差异在开发模式的架构:

- webpack dev: 启动时对整个应用做一次完整打包 (bundle-based) , 产物存内存由 dev server 提供, 项目越大冷启动越慢.
- vite dev: 基于浏览器原生 ESM (unbundled) , 启动时只预构建第三方依赖 (CJS 转 ESM、合并小文件减少请求数, 历史上由 esbuild 承担) , 业务源码按需编译——浏览器请求哪个模块才现场转换哪个, 冷启动与项目规模基本无关.
- 生产构建: webpack 用自身; vite 在 v7 及之前默认用 Rollup, v8 (2026 年发布) 起默认切换为 Rust 实现的 Rolldown (兼容大部分 Rollup 插件 API, 开发期依赖预构建也统一由其承担) . 生产环境仍然打包, 因为纯 ESM 的深层请求瀑布与 HTTP 开销在生产不可接受.

HMR (热模块替换) 原理:

1. dev server 通过 WebSocket 与页面保持连接, 文件变化后编译该模块并推送更新消息.
2. 运行时按模块图向上查找"接受更新"的边界: 模块通过 import.meta.hot.accept (vite) 或 module.hot.accept (webpack) 声明自己能消化哪些子模块的更新.
3. 找到边界则执行新模块代码并调用 accept 回调完成局部替换 (React 通过 react-refresh 保留组件 state, Vue 的 SFC 天然按组件为边界) ; 找不到边界则冒泡到入口, 退化为整页刷新.
4. vite 的更新粒度是原生 ESM 模块, 通过给 import URL 加时间戳强制浏览器重新拉取, 并沿 importers 链失效相关模块.

延伸: esbuild 为什么快 (Go 编写、并行、AST 一次遍历、不做类型检查) ; Rust 工具链 (Rspack、Rolldown、Turbopack、oxc) 正在以兼容 API 重写这一层; babel/tsc 在链路中被降级为"只做语法降级/只做类型检查".

### SSR 同构与 Hydration 的原理与常见问题

A: SSR (服务端渲染) 指在服务端把组件树渲染成 HTML 直出, 首屏无需等 JS 即可显示内容, 改善 FCP/LCP 与 SEO. 同构指同一套组件代码在服务端 (renderToString/renderToPipeableStream) 与客户端各执行一次.

Hydration (注水) : 客户端 JS 加载后不重建 DOM, 而是复用服务端 HTML——遍历已有 DOM 与虚拟树建立对应关系、绑定事件监听器、恢复组件状态, 使静态 HTML 变为可交互应用.

常见问题与对策:

- Hydration mismatch: 服务端与客户端渲染结果不一致 (随机数、Date.now、仅客户端可知的状态如登录态/窗口宽度) 导致告警甚至整树重建. 对策: 把不确定内容延迟到挂载后渲染 (useEffect 后再显示) 、双端使用相同的数据快照.
- 双端环境差异: 服务端没有 window/document, 需要守卫或依赖注入; 数据请求在服务端完成后要序列化进 HTML (注意 XSS: JSON 注入需转义 <) 交给客户端复用, 避免二次请求.
- 性能问题: TTI 滞后于 FCP ("能看不能点") , 大型页面 hydration 本身是长任务. 演进方案: 流式 SSR (renderToPipeableStream 边生成边下发) 、选择性/渐进 hydration (React 18 Suspense 分块, 交互优先) 、islands 架构 (Astro, 只 hydrate 交互岛屿) 、React Server Components (服务端组件的代码与数据不进客户端 bundle) .
- 与 SSG/ISR 的取舍: 内容稳定用构建期静态化, 个性化强才用请求期 SSR, 中间态用增量静态再生.

### 微前端的核心问题 JS 沙箱与样式隔离

A: 微前端把多个可独立开发部署的子应用聚合到一个宿主页面, 核心难题是隔离与通信.

JS 沙箱方案:

- 快照沙箱: 子应用挂载前记录 window 快照, 卸载时还原差异. 实现简单但只支持单实例, 且遍历 window 成本高 (qiankun 旧版降级方案) .
- Proxy 沙箱: 用 Proxy 包一层 fakeWindow, 子应用代码通过 with(proxyWindow) 或函数参数注入的方式访问"window", 写操作落在 fakeWindow 上不污染真实全局, 支持多实例并存 (qiankun legacy 主力方案) . 逃逸点: 直接引用 globalThis、setTimeout 回调里的隐式全局、原型链修改.
- iframe/ShadowRealm 类: 天然硬隔离. 无界 (wujie) 用 iframe 承载 JS 执行 + 主文档承载 DOM 渲染, 规避了 iframe 的 UI 局限; ShadowRealm 是 TC39 提案方向.

样式隔离方案:

- 工程约定: BEM 前缀、CSS Modules、构建期给子应用样式统一加 scope 前缀 (postcss 插件改写选择器) .
- 运行时: qiankun 的 strictStyleIsolation 用 Shadow DOM 包裹子应用 (弹窗挂 body 会逃逸, 兼容成本高) ; experimentalStyleIsolation 运行时改写选择器加 data 属性前缀.
- 子应用切换时的样式表增删管理 (劫持 appendChild 记录动态插入的 style/link) .

配套机制: 路由分发 (劫持 history 或基于 single-spa 的生命周期) 、应用间通信 (CustomEvent/发布订阅/props 注入, 避免共享可变全局状态) 、公共依赖复用 (externals、Module Federation 共享作用域) . Module Federation 是另一条路线: 构建期声明 remote/shared, 把"微应用"降维成"运行时按需加载的远程模块", 没有沙箱但共享一套运行时.

### 前端错误监控体系与 sourcemap 还原

A: 采集层需要覆盖的错误类型与手段:

- JS 运行时错误: window.onerror (能拿到 message/source/lineno/colno/error 对象) 与 window.addEventListener('error'); 跨域脚本报 "Script error." 时需要脚本响应加 CORS 头且 script 标签加 crossorigin 属性才能拿到细节.
- 资源加载错误: error 事件不冒泡但可在捕获阶段监听 (addEventListener('error', fn, true)) , 据 target 区分 img/script/link.
- 异步错误: unhandledrejection 捕获未处理的 Promise 拒绝; 框架层错误用 React ErrorBoundary (只捕获渲染期错误, 事件回调/异步不覆盖) 、Vue 的 app.config.errorHandler.
- 接口错误: 拦截 fetch/XHR (包装原型方法) 记录状态码、耗时、请求上下文.
- 白屏检测: 采样点 elementsFromPoint 判定关键区域是否有有效渲染, 或结合 MutationObserver 与超时兜底.

上报设计: 错误按"类型 + message + 堆栈前几帧"计算指纹去重与聚合; 采样率与限流防止雪崩 (详见监控 SDK 限流实践) ; 上报用 sendBeacon 或 fetch keepalive 保证页面卸载时不丢; 附带 release 版本、用户与环境维度、面包屑 (用户最近的操作轨迹) .

sourcemap 还原: 生产代码经压缩混淆, 堆栈中的 (file.js:1:23456) 需要还原到源码位置. 构建时生成 hidden sourcemap (不在产物中暴露 sourceMappingURL) , 上传到监控平台 (如 Sentry 按 release 关联) ; 服务端用 source-map 库根据行列号反查原始文件、行号与源码片段. 要点: sourcemap 绝不部署到公网; 版本必须与产物严格对应 (release + dist 标识) , 否则还原错位; 对 App 内嵌 H5 还需处理 JSBridge 注入代码导致的行号偏移.

## 第十一部分 服务降级 熔断与限流

### 什么是服务降级 它和服务熔断有什么区别

A: 服务降级 (Degradation) 是在系统整体负载过高或下游服务不可用时, 主动放弃部分非核心功能, 保证核心链路可用的策略. 比如电商大促期间关闭评价、推荐等非核心接口, 只保留下单、支付链路.

服务熔断 (Circuit Breaker) 是一种保护机制: 当对某个下游服务的调用失败率达到阈值时, 自动"断开"对该服务的调用, 直接返回错误或 fallback 结果, 经过一段时间后尝试"半开"恢复.

核心区别:

- 降级是主动的、全局的策略, 通常由运维或业务决策触发, 目的是在资源不足时保核心.
- 熔断是被动的、局部的保护, 由错误率自动触发, 目的是防止级联故障.
- 降级的粒度通常是整个功能模块; 熔断的粒度通常是对某个具体下游服务的调用.

两者可以配合使用: 熔断触发后, 对调用方而言就是一次降级 (走 fallback 逻辑) .

### 熔断器的三种状态是怎么流转的

A: 经典熔断器有三个状态:

1. Closed (关闭) : 正常状态, 请求正常通过. 内部维护一个失败计数器, 每次调用失败时 +1, 成功时清零 (或按滑动窗口统计) .

2. Open (打开) : 当失败率超过阈值 (如 50%) 或连续失败次数超过阈值 (如 5 次) , 熔断器切换到 Open 状态. 所有请求直接走 fallback, 不再发送到下游服务. 同时启动一个超时计时器.

3. Half-Open (半开) : 超时计时器到期后, 熔断器切换到 Half-Open 状态, 允许少量探测请求通过 (如 1 个) . 如果探测请求成功, 认为下游恢复, 切换到 Closed; 如果失败, 切回 Open 重新计时.

实际工程中 (如 Hystrix、Sentinel) 还有一些细节:

- 滑动窗口: 用最近 N 秒或最近 N 次请求作为统计窗口, 而不是从启动开始累计.
- 最小请求数: 在窗口期内请求数不足时不触发熔断, 避免小样本误判.
- 慢调用熔断: 除了错误率, 还可以对慢调用比例做熔断 (如 P99 超过 3s 的请求占比超过 30%) .

### 常见的限流算法有哪些 各自适用什么场景

A: 四种主流限流算法:

1. 固定窗口计数器 (Fixed Window Counter) :
   - 原理: 每个时间窗口 (如 1 秒) 维护一个计数器, 请求到来时 +1, 超过阈值则拒绝. 窗口结束时重置.
   - 优点: 实现简单, 内存开销小.
   - 缺点: 临界问题——窗口切换瞬间可能承受 2 倍流量 (上一个窗口末尾 + 下一个窗口开头) .
   - 适用: 对精度要求不高的粗粒度限流.

2. 滑动窗口计数器 (Sliding Window Counter) :
   - 原理: 将时间窗口细分为多个子窗口, 统计滑动范围内的请求数. 或者用滑动日志 (记录每个请求的时间戳) .
   - 优点: 解决了固定窗口的临界问题, 流量控制更平滑.
   - 缺点: 子窗口越多内存开销越大; 滑动日志方式在请求量大时内存开销高.
   - 适用: 需要精确控制速率的场景.

3. 漏桶 (Leaky Bucket) :
   - 原理: 请求进入桶中, 以固定速率流出 (被处理) . 桶满时拒绝新请求.
   - 优点: 输出速率恒定, 对下游保护效果好.
   - 缺点: 无法处理突发流量 (即使桶有空余, 突发请求也只能以固定速率处理) .
   - 适用: 需要严格限制处理速率的场景 (如消息队列消费、日志写入) .

4. 令牌桶 (Token Bucket) :
   - 原理: 以固定速率向桶中放入令牌, 请求需要获取令牌才能被处理. 桶满时丢弃多余令牌. 桶空时拒绝请求.
   - 优点: 允许一定程度的突发流量 (桶中积累的令牌可以一次性被消耗) .
   - 缺点: 突发流量可能瞬时打高下游.
   - 适用: 大多数 API 限流场景 (如 Google API、AWS API Gateway 默认用令牌桶) .

令牌桶 vs 漏桶的关键区别: 令牌桶允许突发 (桶中有令牌时可以快速处理多个请求) , 漏桶强制匀速 (不管桶中有多少请求, 都以固定速率处理) .

### 前端如何实现服务降级

A: 前端降级策略按层次:

1. UI 降级:
   - 非核心组件延迟加载或隐藏 (如评论区、推荐列表) .
   - 动画降级: prefers-reduced-motion 媒体查询关闭动画, 或低端设备关闭复杂动画.
   - 图片降级: 使用低分辨率图片、WebP 格式, 或使用 placeholder.

2. 数据降级:
   - 接口超时或失败时展示缓存数据 (stale-while-revalidate) .
   - 使用本地兜底数据 (如默认配置、预置的静态数据) .
   - 减少请求频率 (关闭轮询、延长 refreshInterval) .

3. 功能降级:
   - 关闭非核心功能开关 (feature flag) , 如实时通知、在线聊天.
   - 降级复杂的富文本编辑器为 textarea.
   - 关闭 WebSocket 实时推送, 降级为定时 HTTP 轮询.

4. 加载策略降级:
   - 骨架屏 -> loading spinner -> 纯文本.
   - 预加载的资源改为按需加载.
   - 关闭 Service Worker 缓存更新, 直接使用缓存.

实现层面通常通过配置中心下发降级开关:

```typescript
interface DegradeConfig {
  enableRecommendation: boolean;
  enableAnimation: boolean;
  enableRealtime: boolean;
  imageQuality: "high" | "medium" | "low";
}
```

前端在启动时拉取降级配置, 根据配置决定加载哪些模块、使用哪种渲染策略.

### 限流在前端和后端分别怎么做

A: 后端限流:

1. 网关层限流 (如 Nginx、Kong、AWS API Gateway) :
   - Nginx 的 limit_req (漏桶) 和 limit_conn (并发连接数限制) .
   - 在入口层挡住大部分超限请求, 保护后端服务.

2. 应用层限流 (如 Sentinel、Hystrix、自研) :
   - 基于令牌桶或滑动窗口.
   - 可以按接口、用户、IP、租户等多维度限流.
   - Sentinel 还支持热点参数限流 (如某个商品 ID 的请求频率) .

3. 分布式限流:
   - 使用 Redis + Lua 脚本实现分布式令牌桶 (Redisson 提供了开箱即用的实现) .
   - 或使用 etcd / ZooKeeper 做协调.
   - 难点: 分布式场景下时钟不同步、网络延迟导致的限流精度问题.

前端限流:

1. 请求并发控制:
   - 限制同时发出的请求数 (如最多 6 个并发请求) .
   - 实现一个请求队列, 超出并发上限的请求排队等待.

2. 请求节流/防抖:
   - 按钮点击防抖 (debounce) : 避免用户连续点击触发多次请求.
   - 搜索输入节流 (throttle) : 限制搜索请求频率.

3. 重试策略:
   - 指数退避 (exponential backoff) : 失败后等待 1s, 2s, 4s, 8s...
   - 添加抖动 (jitter) : 避免大量请求在同一时刻重试 (惊群效应) .

4. 请求合并 (batching) :
   - 短时间内多次触发的请求合并为一次批量请求.
   - 如 React Query 的 queryClient 自动合并相同 key 的请求.

### 分布式系统中如何做全链路降级

A: 全链路降级的核心思想: 从入口到存储, 每一层都有降级预案, 在流量洪峰时逐级降级.

1. CDN 层:
   - 启用静态兜底页面 (预渲染的 HTML) .
   - 延长缓存 TTL, 减少回源请求.
   - 关闭动态内容的 CDN bypass.

2. 网关层:
   - 限流: 按用户/IP/接口限流.
   - 降级: 直接返回预设的兜底响应 (如"系统繁忙, 请稍后重试") .
   - 灰度: 按百分比放行请求.

3. 服务层 (BFF / 微服务) :
   - 熔断下游服务调用.
   - 非核心服务降级 (如推荐服务不可用时返回热门列表) .
   - 降低超时时间 (从 3s 降到 500ms) , 快速失败.

4. 缓存层:
   - 延长缓存过期时间 (热点数据永不过期) .
   - 缓存穿透时返回空值或默认值.
   - 开启本地缓存 (进程内 LRU) , 减少 Redis 压力.

5. 数据库层:
   - 关闭复杂查询 (如全文搜索、多表 JOIN) .
   - 只读操作走从库.
   - 写入降级: 异步写入消息队列, 延迟持久化.

6. 前端层:
   - 上述前端降级策略.
   - 展示"当前访问人数过多"的友好提示.

关键实践:

- 降级预案要提前准备并演练 (如定期做压测和降级演练) .
- 降级开关要能快速下发 (秒级生效) , 通常通过配置中心 (如 Apollo、Nacos) .
- 降级后要有监控告警, 知道哪些服务在降级状态.
- 恢复时要有灰度策略, 避免流量突然全部涌入.

### Sentinel 和 Hystrix 在熔断限流上的对比

A: Hystrix (Netflix, 已停维) :

- 隔离策略: 线程池隔离 (每个服务调用独立线程池) , 防止单个服务拖垮整个系统. 也有信号量隔离模式.
- 熔断: 基于滑动窗口 (最近 N 次请求) 的失败率.
- 限流: 有限, 主要通过并发线程数限制.
- 实时指标: 滑动窗口 (RxJava 实现) .
- 动态规则: 支持多种数据源.
- 缺点: 线程池隔离引入了线程切换开销, 高并发下性能损耗明显.

Sentinel (Alibaba) :

- 隔离策略: 信号量隔离 (轻量级) , 不使用独立线程池.
- 熔断: 支持慢调用比例、异常比例、异常数三种熔断策略.
- 限流: 功能丰富——QPS 限流、热点参数限流、集群限流、系统自适应保护.
- 实时指标: 滑动窗口 (LeapArray 数据结构, 基于时间片的环形数组) .
- 动态规则: 支持 Nacos、ZooKeeper、Apollo、文件等多种数据源.
- 控制台: 提供可视化的流量监控和规则管理.
- 优点: 性能更好 (信号量隔离无线程切换) , 功能更丰富.

实际选型:

- 新项目推荐 Sentinel, 社区活跃、功能全.
- 已有 Hystrix 的项目可以考虑迁移到 Resilience4j (Hystrix 的继任者) .
- Go 生态可以用 go-zero 内置的限流熔断、或自研.

### 如何设计一个自适应限流算法

A: 自适应限流 (Adaptive Rate Limiting) 的核心: 根据系统实时负载自动调整限流阈值, 而不是使用固定的 QPS 上限.

一种常见实现 (类似 BBR 拥塞控制算法) :

1. 实时采集系统指标:
   - CPU 使用率.
   - 当前在途请求数 (in-flight requests) .
   - 平均 RT (响应时间) .
   - 最大吞吐量 (maxPass, 最近窗口内通过的最大 QPS) .
   - 最小 RT (minRt, 最近窗口内的最小平均响应时间) .

2. 计算系统最大承载能力:
   - maxInFlight = maxPass \* minRt / 1000 (Little's Law: L = lambda \* W) .
   - 即: 系统能同时处理的最大在途请求数 = 最大吞吐量 \* 最小响应时间.

3. 决策逻辑:
   - 当前在途请求数 < maxInFlight \* 安全系数: 放行.
   - 当前在途请求数 >= maxInFlight \* 安全系数: 拒绝.
   - 安全系数通常取 0.8-0.9, 留出余量.

4. CPU 使用率兜底:
   - 当 CPU 使用率超过阈值 (如 90%) 时, 无论上述计算结果如何, 直接触发限流.

Sentinel 的系统自适应保护就是这个思路. 它的好处是能根据系统实际能力动态调整, 而不是依赖人工设定的固定阈值.

### 前端监控 SDK 的上报限流怎么做

A: 监控 SDK 的上报限流需要平衡两个目标: 不丢失关键错误信息, 同时不打爆后端.

实现策略:

1. 采样率控制:
   - 全局采样: 配置 sampleRate = 0.1, 只有 10% 的错误上报.
   - 分层采样: 不同类型的错误设置不同采样率 (JS Error 全量上报, Performance 数据 1% 采样) .

2. 错误去重:
   - 相同指纹 (错误类型 + 堆栈前几帧) 的错误在时间窗口内只上报一次.
   - 使用 LRU 缓存维护已上报错误的指纹.

3. 速率限制:
   - 每秒最多上报 N 条 (如 10 条) , 超出的进入队列.
   - 队列满时按优先级丢弃 (性能数据优先丢弃, JS Error 保留) .

4. 批量上报:
   - 错误先进入缓冲区, 每 5-10 秒批量发送一次.
   - 减少请求次数, 提高单次请求的传输效率.

5. 后端反馈控制:
   - 后端返回 429 (Too Many Requests) 时, SDK 自动降低上报频率.
   - 后端可以下发动态采样率配置, 全局调控流量.

6. 离线缓冲:
   - 上报失败的数据暂存 localStorage.
   - 网络恢复后分批刷盘, 避免瞬时洪峰.

### 熔断和降级在 BFF 层如何落地

A: BFF 层作为前后端之间的中间层, 是熔断和降级落地的关键位置.

1. 熔断下游 RPC 服务:

```typescript
class CircuitBreaker {
  private state: "closed" | "open" | "half-open" = "closed";
  private failures = 0;
  private lastFailureTime = 0;
  private threshold = 5;
  private timeout = 30000;

  async call<T>(fn: () => Promise<T>, fallback: () => T): Promise<T> {
    if (this.state === "open") {
      if (Date.now() - this.lastFailureTime > this.timeout) {
        this.state = "half-open";
      } else {
        return fallback();
      }
    }
    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (e) {
      this.onFailure();
      return fallback();
    }
  }

  private onSuccess() {
    this.failures = 0;
    this.state = "closed";
  }

  private onFailure() {
    this.failures++;
    this.lastFailureTime = Date.now();
    if (this.failures >= this.threshold) {
      this.state = "open";
    }
  }
}
```

2. 降级策略:
   - 推荐服务熔断 -> 返回热门列表 (兜底数据) .
   - 用户画像服务熔断 -> 返回默认推荐.
   - 评论服务熔断 -> 隐藏评论模块 (返回空数组, 前端不渲染) .

3. 超时控制:
   - 给每个下游 RPC 调用设置独立超时 (核心服务 3s, 非核心服务 500ms) .
   - 使用 Promise.race 实现超时中断.

4. 限流:
   - 按用户 ID 限流: 防止单个用户频繁请求.
   - 按接口限流: 防止某个接口被打爆.
   - 使用令牌桶或滑动窗口.

5. 监控与告警:
   - 记录每次熔断触发、降级触发、限流触发的事件.
   - 上报到监控系统, 配置告警规则.
   - 提供运营面板查看各服务的熔断/降级状态.

## 第十二部分 算法实现

本部分基于本仓库相邻的手写源码库 (`$HOME/github/h/chucks/js` 目录, 35 个源码文件) 逐文件编排, 每题含源码解读、深入解析、进阶延伸.

| #   | 题目                                | 对应文件             | 核心要点                       |
| --- | ----------------------------------- | -------------------- | ------------------------------ |
| 1   | 手写 call / apply / bind            | apply-call-bind.js   | this 绑定、Symbol、new.target  |
| 2   | 循环闭包输出与修复                  | closure.js           | 闭包、IIFE、let 块级作用域     |
| 3   | 累加式柯里化                        | curry.js             | 柯里化、参数聚合、空参触发     |
| 4   | 防抖与四种节流                      | debounce-throttle.js | 定时器、leading/trailing       |
| 5   | 装饰器求值顺序                      | decorator.ts         | TS 装饰器四类、求值时序        |
| 6   | 深拷贝 (循环引用)                   | deep-clone.js        | WeakMap、类型分支              |
| 7   | 寄生组合式继承                      | extends.js           | 原型链、静态继承               |
| 8   | 手写 Array.prototype.flat           | flat.js              | 递归/DFS、稀疏数组             |
| 9   | 手写 instanceof                     | instanceof.js        | 原型链遍历、Symbol.hasInstance |
| 10  | 让普通对象可迭代                    | iterator.js          | Symbol.iterator、生成器        |
| 11  | 手写 map / reduce + 串行 Promise 链 | map-reduce.js        | 稀疏数组、reduce 链式 then     |
| 12  | 类字段初始化顺序 (米哈游题)         | miHoYo.js            | 字段初始化时序、方法重写陷阱   |
| 13  | 手写 new 操作符                     | new.js               | 构造函数返回值规则             |
| 14  | 手写 Promise (A+ 规范)              | promise.js           | 状态机、回调队列、链式         |
| 15  | 用 rAF 实现 setTimeout/setInterval  | timer.js             | 渲染帧、时间戳比对             |
| 16  | 手写 requestAnimationFrame polyfill | polyfill/index.js    | 60fps 对齐、批量回调、取消     |
| 17  | JSON 深比较                         | lc/lc2628.ts         | 递归、键序无关比较             |
| 18  | 基于 fn.length 的柯里化             | lc/lc2632.js         | 函数 length 属性               |
| 19  | 手写 JSON.stringify                 | lc/lc2633.js         | 递归序列化                     |
| 20  | Promise 并发池 (4 种实现)           | lc/lc2636.js         | 并发控制、迭代器共享           |
| 21  | 对齐语义的节流                      | lc/lc2676.js         | nextCallTime 调度              |
| 22  | Proxy 无限对象                      | lc/lc2690.js         | Proxy get 陷阱                 |
| 23  | 手写 Immer produce                  | lc/lc2691.js         | 写时复制、草稿代理             |
| 24  | 深度不可变对象                      | lc/lc2692.js         | Proxy set/apply 拦截           |
| 25  | 对象 Diff                           | lc/lc2700.js         | 递归差分                       |
| 26  | 深合并 deepMerge                    | lc/lc2755.js         | 键并集递归                     |
| 27  | 查询批处理器                        | lc/lc2756.ts         | 批量合并、节流窗口             |
| 28  | 循环生成器                          | lc/lc2757.js         | generator 双向通信、负数取模   |
| 29  | Date.prototype.nextDay              | lc/lc2758.js         | 日期进位、padStart             |
| 30  | promisify                           | lc/lc2776.ts         | 回调转 Promise                 |
| 31  | 手写 Promise.allSettled (找 Bug)    | lc/lc2795.js         | 计数器、缺陷分析               |
| 32  | delayAll                            | lc/lc2821.js         | 高阶函数包装                   |
| 33  | JSON 转矩阵                         | lc/lc3675.js         | 路径展开、列对齐               |

### 题目 1| 手写 call / apply / bind

源码解读: 用 Symbol() 生成唯一键把函数挂到上下文对象上再调用, 从而改变 this; bind2 返回的 Bound 函数通过 new.target 判断是否被 new 调用——若是则改为构造 fn 的实例.

深入解析:

- 为什么用 Symbol() 而不是固定字符串键? ——避免与 ctx 已有属性冲突, 且 delete ctx[prop] 后不留痕迹.
- ctx 为 null/undefined 时原生行为是绑定到全局对象 (非严格模式) 或保持 undefined (严格模式) , 如何兼容? 传入原始值 (如数字) 时原生会装箱为包装对象.
- new.target 是 ES6 元属性 (meta property) , 它让函数感知自己的调用方式; bind2 中利用它区分构造调用与普通调用, 这是手写 bind 最容易丢分的一步.
- 原生 bind 产生的函数没有 prototype, 且其 length/name 会被重写 (bound xxx) .

参考实现:

```js
Function.prototype.bind2 = function (ctx, ...args) {
  const fn = this;
  return function Bound(...rest) {
    if (new.target) return new fn(...args, ...rest);
    const prop = Symbol();
    ctx[prop] = fn;
    const ret = ctx[prop](...args, ...rest);
    delete ctx[prop];
    return ret;
  };
};
```

进阶延伸: bind 链式调用 fn.bind(a).bind(b) 的 this 是什么? (永远是最先绑定的 a) ; 如何让 Bound 函数继承原函数的 prototype (Bound.prototype = Object.create(fn.prototype)) ; 软绑定 (softBind) 是什么场景?

### 题目 2| 循环闭包输出与修复

源码解读: 第一个循环中 5 个 setTimeout 回调共享同一个 var i, 宏任务执行时循环已结束, 输出 6 6 6 6 6; 第二个循环用 IIFE 把每轮的 j 捕获进独立函数作用域, 输出 1 2 3 4 5.

深入解析:

- var 声明提升 + 函数作用域 -> 所有回调闭包引用同一词法环境记录 (Environment Record) .
- 四种修复的本质差异:
  1. IIFE: 每轮创建新函数作用域;
  2. let: ES6 为 for 循环体每次迭代创建新的词法环境 (per-iteration binding) , 这是规范 13.7.4.8 节的特殊处理;
  3. setTimeout 第三参: setTimeout(cb, t, arg) 会把 arg 作为回调入参传入;
  4. bind 预设参数: setTimeout(console.log.bind(null, i), ...).
- 计时并不精确: 宏任务排队 + 最小延迟 (浏览器对嵌套 >=5 层的定时器强制 >=4ms) .

### 题目 3| 累加式柯里化

源码解读: curry 内部维护 aggregatedArgs 数组, 每次调用把参数推入并返回自身; 以空参调用作为求值信号, 触发 fn.apply(this, aggregatedArgs).

深入解析:

- 两种柯里化范式: 固定元数 (依赖 fn.length) 与可变参数 (依赖终止信号或隐式转换) .
- 隐式转换版本的关键: 给返回函数挂载 valueOf, 返回聚合结果; 注意 === 不会触发转换, 只有 == 或数学运算/String() 才会.
- fn.apply(this, ...) 保留 this, 柯里化函数作为方法调用时不丢上下文.

参考实现 (隐式转换版) :

```js
function curry(fn) {
  const all = [];
  const curried = (...args) => {
    all.push(...args);
    return curried;
  };
  curried.valueOf = () => fn(...all);
  curried.toString = () => String(fn(...all));
  return curried;
}
```

### 题目 4| 防抖与四种节流

源码解读:

- debounce: 每次调用清掉旧定时器重排, 只有停止触发 delay 后才执行 (trailing) .
- throttle (时间戳版) : 比较 Date.now() 与上次执行时间, 立即执行 (leading) , 但停止触发后不会补最后一次 (无 trailing) .
- throttle2 (定时器版) : timer 存在期间直接丢弃调用 (leading, 无 trailing 补偿) .
- throttle3: 维护 nextCallTime, 用 Math.max(0, nextCallTime - now) 计算延迟, 每次调用都会重排定时器, 保证最后一次调用一定在节流窗口结束时执行 (trailing 语义) .

深入解析:

- 时间戳版 vs 定时器版的经典缺陷对比: 前者边界时刻停止触发会丢尾, 后者首次触发有延迟.
- 高阶 API: cancel (清 timer + 重置状态) 、flush (有挂起调用则立即执行并返回结果) .
- 防抖在输入联想、resize 的场景; 节流在 scroll、鼠标轨迹上报的场景.

### 题目 5| 装饰器求值顺序

源码解读: 文件演示了 TS 实验性装饰器的四种形态——类装饰器 (target 是构造函数) 、属性装饰器 (target 是原型, 无 descriptor) 、方法装饰器 (多一个 PropertyDescriptor) 、参数装饰器 (多一个 paramIndex) .

深入解析:

- 旧版 (experimentalDecorators) 求值顺序: 实例成员先于静态成员, 每个成员先应用参数装饰器、再应用方法/访问器/属性装饰器 (按声明顺序) , 随后是构造函数的参数装饰器, 类装饰器最后. 装饰器表达式自上而下求值, 调用自下而上 (洋葱模型) .
- 属性装饰器拿不到 PropertyDescriptor (因为实例属性不在原型上) , 所以无法拦截赋值.
- TS 5.0 标准装饰器签名完全不同: (value, context), context 含 kind/name/access/addInitializer, 不再有 target/descriptor 三元组.
- 装饰器叠加 emitDecoratorMetadata 会生成 design:type / design:paramtypes / design:returntype 元数据 (reflect-metadata) , 这是 Angular/NestJS 依赖注入的根基.

### 题目 6| 深拷贝 循环引用

源码解读: deepClone 用 WeakMap 记录"原对象 -> 克隆对象"映射解决循环引用; 特判 Date (new Date(obj)) 与 RegExp (拷贝 source/flags/lastIndex) ; 用 for...in + hasOwnProperty 只拷贝自身可枚举属性.

深入解析:

- 用 WeakMap 而非 Map: 键弱引用, 拷贝结束后原对象可被 GC, 且天然支持对象键.
- 必须在递归之前 seen.set(obj, clone), 否则循环引用死循环.
- 源码的盲区: for...in 会遍历原型链 (靠 hasOwnProperty 过滤) 但漏掉 Symbol 键与不可枚举属性; 不处理 Map/Set/Promise/Function/BigInt 包装对象.
- 对比方案: structuredClone (原生, 支持 Map/Set/ArrayBuffer/循环引用, 但不支持函数、DOM、原型上的 getter/setter) ; JSON.parse(JSON.stringify()) (丢 undefined/函数/Symbol/循环引用直接抛错、Date 变字符串) .

### 题目 7| 寄生组合式继承

源码解读: extendsImpl 用 Object.create(Parent.prototype) 创造干净的中间对象作为 Child.prototype (避免 new Parent() 带来的多余实例属性) , 修正 constructor 指针, 并用 Object.setPrototypeOf(Child, Parent) 继承静态成员.

深入解析:

- 六种继承演进: 原型链继承 -> 构造函数继承 -> 组合继承 -> 原型式 -> 寄生式 -> 寄生组合式 (只调一次父构造函数、原型链干净) .
- Object.setPrototypeOf(Child, Parent) 对应 ES6 class extends 中 Child.proto === Parent 这一双重原型链.
- ES6 class 转译后大致就是寄生组合式 + 静态继承 + super 的 [[HomeObject]] 语义.

### 题目 8| 手写 Array.prototype.flat

源码解读: flat2 基于 reduce + concat + 原生 flat(depth-1) 递归降维; flat3 用显式 DFS 收集到结果数组.

深入解析:

- 原生 flat 对空位的处理: [1, , 2].flat() -> [1, 2], 空位被丢弃.
- for...of/for 循环会把 hole 读成 undefined, 必须用 i in arr 或 hasOwnProperty 判空位.
- 递归版爆栈深度约 1 万层 (V8 默认栈约 1MB) ; 迭代版用栈 [\{arr, depth\}] 展开.

参考实现 (迭代版) :

```js
function flat(arr, depth = 1) {
  const stack = arr.map((item) => [item, depth]);
  const res = [];
  while (stack.length) {
    const [item, d] = stack.pop();
    if (Array.isArray(item) && d > 0) {
      stack.push(...item.map((sub) => [sub, d - 1]));
    } else {
      res.push(item);
    }
  }
  return res.reverse();
}
```

### 题目 9| 手写 instanceof

源码解读: instanceofV2 沿 Object.getPrototypeOf 一路向上找 right.prototype; 找到返回 true, 到达 null 返回 false.

深入解析:

- 规范算法 (OrdinaryHasInstance) : 若 right 有 [Symbol.hasInstance] 方法, 调用它; 若 right 不可调用抛 TypeError; bound 函数则对目标函数递归 instanceof.
- 跨 realm (iframe) 问题: 不同全局环境的 Array 不相等, [] instanceof Array 跨窗口为 false——所以大型库用 Array.isArray.
- Object.create(null) 的对象 instanceof Object 为 false (原型链无 Object.prototype) .

### 题目 10| 让普通对象可迭代

源码解读: 方式一给 obj 挂生成器方法 [Symbol.iterator], for...of 自动消费 yield 的值; 方式二用 Object.defineProperty 定义不可枚举、不可写、不可配置的迭代器属性.

深入解析:

- 迭代协议三件套: 可迭代协议 (Symbol.iterator 返回迭代器) 、迭代器协议 (next() 返回 \{value, done\}) 、生成器是两者的语法糖.
- for...of 只找 Symbol.iterator, 与 for...in (枚举字符串键、含原型链) 完全正交.
- 消费方式盘点: for...of、扩展运算符、解构、Array.from、Promise.all、yield\*、Map/Set 构造器.

### 题目 11| 手写 map reduce 与 Promise 串行链

源码解读: map2 用 new Array(len) 预分配 + i in this 跳过空位; reduce2 处理 initialValue 缺省; 末尾 bootstrap 用 reduce((p, t) => p.then(t), Promise.resolve(val)) 把异步任务数组串成顺序链.

深入解析:

- 原生 map 保留稀疏性: [1, , 2].map(x => x\*2) 结果仍有空位; reduce 版本把空位写成 undefined 实值——这是经典的易错点.
- reduce 无初始值时, 首个存在的元素为累加器, 从第二个元素开始迭代; 空数组无初始值抛 TypeError.
- p.then(curTask) 串行原理: 每个 then 返回新 Promise, 注册时机保证任务按序排队.

### 题目 12| 类字段初始化顺序

源码解读: new Child() 的执行序列:

1. super() 进入 Parent: 先初始化 Parent 的实例字段;
2. 执行 Parent 构造体;
3. this.run() 调用的是子类原型上的重写方法 (动态派发) ;
4. super() 返回后, 初始化 Child 自己的实例字段——覆盖第 3 步赋的值;
5. 执行 Child 构造体.

深入解析:

- 字段初始化时机 ([[Define]] 语义) : 基类在构造体开头初始化; 派生类在 super() 返回后立即初始化——所以派生类字段必然覆盖父类构造期间对同名属性的写入.
- 父类构造函数中调用 this.run() 触发动态派发到子类方法, 此时子类字段尚未初始化——这是 Java/C# 中都存在的"构造器调用虚方法"反模式.
- class fields 使用 `[[Define]]` (定义在实例自身) , 而构造体内 this.x = ... 是 `[[Set]]`——同名场景下行为差异 (如原型上有 setter 时, field 不触发 setter, 赋值会触发) .

### 题目 13| 手写 new 操作符

源码解读: newV2 三步: Object.create(Constructor.prototype) 建实例 -> Constructor.apply(obj, args) 执行构造体 -> 若返回对象则用返回值否则用新建对象.

参考实现:

```js
function newV2(Ctor, ...args) {
  const obj = Object.create(Ctor.prototype ?? Object.prototype);
  const res = Reflect.apply(Ctor, obj, args);
  return (typeof res === "object" && res !== null) || typeof res === "function"
    ? res
    : obj;
}
```

深入解析:

- new 的完整语义 (Construct 内部方法) : 创建 [[Prototype]] 为 F.prototype 的对象 -> 以 new.target = F 调用 -> 返回值若是 Object (含函数) 则取之, 否则取新建对象.
- F.prototype 为 null 时, 实例原型回退到 Object.prototype; 箭头函数没有 prototype 也没有 [[Construct]], new 抛 TypeError.

### 题目 14| 手写 Promise

源码解读: PromiseV2 实现状态机 (pending/resolved/rejected) + 双回调队列 + then 返回新 Promise 的链式; 处理回调返回值是 Promise 时的"解包".

深入解析 (对照源码找偏差) :

- 异步执行缺失: 规范 2.2.4 要求 onFulfilled/onRejected 必须在执行栈仅含平台代码时调用.
- thenable 解包不完整: 只判断 instanceof PromiseV2, 而规范要求对任何含 then 方法的对象递归解包, 且 then 的 getter 抛错要 reject、多次调用要忽略 (called 标志) .
- resolve 一个自身必须抛 TypeError: Chaining cycle detected.
- 微任务调度: 浏览器用 queueMicrotask/MutationObserver, Node 用 process.nextTick.

参考骨架 (关键片段) :

```js
const resolvePromise = (p2, x, resolve, reject) => {
  if (p2 === x) return reject(new TypeError("Chaining cycle"));
  if (x instanceof MyPromise)
    return x.then((y) => resolvePromise(p2, y, resolve, reject), reject);
  if (x !== null && (typeof x === "object" || typeof x === "function")) {
    let called = false;
    try {
      const then = x.then;
      if (typeof then === "function") {
        then.call(
          x,
          (y) => {
            if (called) return;
            called = true;
            resolvePromise(p2, y, resolve, reject);
          },
          (r) => {
            if (called) return;
            called = true;
            reject(r);
          },
        );
      } else resolve(x);
    } catch (e) {
      if (!called) reject(e);
    }
  } else resolve(x);
};
```

### 题目 15| 用 rAF 实现 setTimeout setInterval

源码解读: useSetTimeout 在 rAF 回调里比对 Date.now() - startTime >= timeout, 到点执行并 cancelAnimationFrame 自清理; useSetInterval 到点后重置 startTime = currentTime 并循环.

深入解析:

- rAF 与垂直同步 (VSYNC) 对齐 (通常 60Hz 约 16.7ms) , 后台标签页 rAF 完全暂停, 而 setTimeout 被节流到 >=1s.
- 源码 setInterval2 的漂移: startTime = currentTime 把回调执行耗时计入下一周期, 长期运行会累积漂移; 修正方案是 startTime += interval (按计划网格对齐) .
- 高精度计时为什么用 performance.now() 而非 Date.now() (单调时钟 vs 系统时钟可被校时改动) .

### 题目 16| 手写 requestAnimationFrame polyfill

源码解读: 以 frameDuration = 1000/60 为帧长, 用"上一次帧回调计划时刻"算 nextCallDelay 对齐帧边界; 所有本帧注册的回调先入队 taskQueues, 到点后克隆队列统一执行 (本帧内新注册的回调进入下一帧) ; cancelAnimationFrame 打 cancelled 标记惰性删除.

深入解析:

- "克隆队列 + 清空原队列"是规范行为: 防止回调里递归注册导致同帧无限循环.
- 首帧延迟计算: latestCallTimestamp 记录的是计划触发时刻而非真实触发时刻, 保证连续调用的帧间隔均匀.
- 真实浏览器 rAF 回调参数是 DOMHighResTimeStamp (该帧的 VSYNC 时刻) , polyfill 传 performance.now().

### 题目 17| JSON 深比较

源码解读: areDeeplyEqual 分三种情况: 非对象用 ===; 双数组按索引递归; 双对象比较键集合 (排序后逐键递归) ; 一数组一对象直接 false.

深入解析:

- 键排序使得比较与键的插入顺序无关——这是 JSON 对象键无序语义的正确处理.
- 通用版循环引用防护: 用 WeakMap\<o1, o2> 记忆已比对的对象对.
- 与 React 的 shallowEqual 对比 (只比一层 + Object.is) .

### 题目 18| 基于 fn.length 的柯里化

源码解读: 与题目 3 的"空参触发"不同, 这里用 fn.length (形参个数) 作为聚合目标: 累计参数达到 argsCnt 即执行.

深入解析:

- fn.length 统计第一个默认值参数或剩余参数之前的形参数: function f(a, b=1, ...rest)\{\} 的 length 是 1.
- 源码用 aggregatedArgs.length === argsCnt: 严格相等意味着一次传超量参数永不触发——应改为 >= 更健壮.

### 题目 19| 手写 JSON.stringify

源码解读: 字符串加双引号; 非对象原始值 String(obj); 数组递归 map+join; 对象用 Object.entries 拼 "key": value.

深入解析:

- 原生序列化规则: 顶层 undefined/function/Symbol -> 返回 undefined (不是字符串) ; Date 走 toJSON (toISOString) ; BigInt 抛 TypeError.
- 循环引用检测: 递归栈上维护 Set, 进入对象 add、离开 delete.
- 第二参 replacer (函数/数组白名单) 与第三参 space (缩进) 的实现方式.

### 题目 20| Promise 并发池

源码解读: 四种实现四种思路——

1. promisePool: 先启动前 n 个, 每个完成后从 pendingQueue 取下一个 (链式接力) ;
2. promisePool2: 共享同一个数组迭代器, n 个 worker 各自 for (const [i, task] of iter) 争抢任务——迭代器状态天然互斥 (JS 单线程同步段内 next() 原子) ;
3. promisePool3: 共享游标 idx++, worker 循环取任务;
4. promisePool4: 维护 workQueue: Set, 任务完成即 delete, 集合满 n 时 await Promise.race 腾出位置.

参考实现 (游标法) :

```js
async function promisePool(funcs, n) {
  const res = new Array(funcs.length);
  let idx = 0;
  const worker = async () => {
    while (idx < funcs.length) {
      const cur = idx++;
      res[cur] = await funcs[cur]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, funcs.length) }, worker));
  return res;
}
```

深入解析:

- 方案 2/3 的精髓: 利用单线程同步段的不可分割性——iter.next()/idx++ 在 await 之间不会被其他 worker 抢占, 无需锁.
- 这就是 p-limit / 前端图片批量上传 / 接口并发限制的标准模型.

### 题目 21| 对齐语义的节流

源码解读: 维护 nextCallTime, 每次调用按 max(0, nextCallTime - now) 延迟执行, 执行后把 nextCallTime 推到 now + t; 因为每次都 clearTimeout 重排, 最后一次调用一定执行 (trailing) , 且执行间隔不小于 t.

深入解析:

- 首次调用 nextCallTime = 0 -> delay 为 0 立即执行, 天然带 leading.
- 与 debounce 的本质区别: debounce 每次重置完整 delay; 本节流以 nextCallTime 为锚, 窗口不随新调用无限后移.

### 题目 22| Proxy 无限对象

源码解读: createInfiniteObject 返回一个 get 陷阱永远返回 () => p 的 Proxy——任意属性访问都得到"返回该属性名字符串"的函数.

参考实现 (路径累积) :

```js
function createInfiniteObject(path = []) {
  return new Proxy(function () {}, {
    get: (_, p) => createInfiniteObject([...path, String(p)]),
    apply: () => path.join("."),
  });
}
```

深入解析:

- get(target, p, receiver) 中 p 是 string | symbol; 注意 Symbol.toPrimitive / Symbol.toStringTag / then 等特殊键会被语言内部访问.
- Proxy 不可 polyfill (需要引擎级拦截) , 这是它改写响应式系统设计 (Vue3) 的原因.

### 题目 23| 手写 Immer produce

源码解读: ImmutableHelper.produce(recipe) 是 Immer 核心机制的精简实现: createDraft 用 Proxy 包装对象, get 时懒创建子草稿、set 时写时复制 (首次修改浅拷贝 base, 之后写入 copy) ; finalize 递归收尾: 子草稿有变化则回填到父 copy, 整棵子树无修改则返回 state.base 保持引用不变.

深入解析:

- 结构共享 (structural sharing) : 引用相等性 = 变化检测信号, 这是 React/Redux 纯函数状态更新的基石.
- 写时复制时机: 第一次 set 才浅拷贝 base.
- 局限性 (对照真 Immer) : 未处理 Map/Set、数组长度缩短、delete 操作 (需 deleteProperty 陷阱) 、冻结产物 (autoFreeze) .

### 题目 24| 深度不可变对象

源码解读: makeImmutable 返回深层代理: get 拦截把对象值递归 proxify; set 一律抛错; 数组的 7 个变更方法 (pop/push/shift/unshift/splice/sort/reverse) 被替换为带 apply 陷阱的 Proxy, 调用即抛错.

深入解析:

- 三类写入面都要封死: set (对象属性) 、set 中数组分支 (下标写入) 、变更方法 (push 等不经过 set 陷阱的对外 API) .
- Object.freeze 是浅冻结且静默失败 (严格模式才抛错) ——深冻结需要递归 + freeze, 与本题的代理式"只读视图"是两种路线.

### 题目 25| 对象 Diff

源码解读: objDiff 递归对比两个对象共有键: 叶子值不等返回 [oldVal, newVal], 数组与对象类型不匹配整体返回 [obj1, obj2]; 只在 obj2 中存在的键被忽略.

深入解析:

- 源码的键处理约定: 只比较共有键 (新增/删除键被忽略) , 这与"深比较"语义不同.
- 这就是 React 状态 diff、JSON Patch (RFC 6902) 、协作编辑 OT/CRDT 的入门模型.

### 题目 26| 深合并 deepMerge

源码解读: deepMerge(obj1, obj2): 任一非对象或"一数组一对象"时取 obj2; 否则对两对象键的并集递归合并, 数组对数组按下标合并.

深入解析:

- new Set([...keys1, ...keys2]) 求并集保持插入序; key in obj 区分"键不存在"与"键存在值为 undefined".
- 与 Object.assign / 展开运算符 (浅合并, 后者覆盖前者整支替换) 的本质差异.
- 合并结果永远是新对象/新数组 (不修改输入) , 符合不可变更新范式.

### 题目 27| 查询批处理器

源码解读: getValue(key) 把 [resolve, key] 推入队列并触发 consume; consume 在非节流窗口且队列非空时执行 batchQuery——把当前队列整体取出, 调用批量接口 queryMultiple(keys), 再按下标把结果分发给各 Promise.

深入解析:

- "队列快照"技巧: const queries = this.queries; this.queries = []——先换引用再异步处理, 期间新进的 key 进入下一轮.
- 这就是 GraphQL DataLoader 的核心思想 (DataLoader 用微任务/帧合并 + 缓存) .

### 题目 28| 循环生成器

源码解读: cycleGenerator(arr, startIndex) 无限循环: yield arr[idx] 的返回值是下次 next(v) 传入的 v, 步进 idx = ((idx + v) % len + len) % len——双重取模兼容负数步进.

深入解析:

- 生成器的双向通信: yield expr 整体是表达式, 求值结果是下一次 next(arg) 的实参; 第一次 next(arg) 的实参被丢弃 (生成器体尚未执行到任何 yield) .
- 负数取模修正: -1 % 5 === -1 (JS 取余保留被除数符号) , (x % n + n) % n 归一到 [0, n).
- 生成器 + Promise = 协程 (co 库 / redux-saga) 的原理, async/await 本质就是"Promise 驱动的生成器执行器".

### 题目 29| Date.prototype.nextDay

源码解读: nextDay 以当前日期新建 Date, setDate(getDate() + 1) 依赖 Date 的自动进位 (1 月 32 日 -> 2 月 1 日) , 再手工拼 YYYY-MM-DD.

深入解析:

- setDate 溢出进位是规范行为 (MakeDay) , 比手写"每月天数表 + 闰年"可靠得多.
- 月份 getMonth() 从 0 起——补零前 +1, 经典踩坑点.
- 跨时区/夏令时切换日, "加一天"与"加 24h"不等价 (setDate(+1) 是日历日, +86400000 是物理时长) .
- 扩展原生原型的争议——生产应封装工具函数或使用 Temporal API (取代 Date 的新标准, Chrome 144+/Firefox 139+ 已原生支持, Safari 尚未).

### 题目 30| promisify

源码解读: promisify(fn) 把"回调在前" (fn(callback, ...args), callback(data, err)) 的函数包装为返回 Promise 的版本: err 非空 reject, 否则 resolve data.

深入解析:

- 两种回调约定差异: LC 风格 (data, err) vs Node 风格 error-first (err, data)——分支条件相反.
- util.promisify 的行为: 依赖被转换函数的 this, 包装函数内要 fn.call(this, ...); 还支持 fn[util.promisify.custom] 自定义符号.
- 回调被调用多次的防护 (called 标志) ——Promise 自身已幂等 (settled 后忽略后续调用) , 天然免疫.

### 题目 31| 手写 Promise.allSettled 找 Bug

源码解读: promiseAllSettled2 是正确范式: 计数器 + 每个任务 then/catch 写入对应下标、finally 里计数达到总数即 resolve. 而第一版藏了两个 bug:

1. functions.map((fn, i) => \{ fn[i](<>); ... \})——回调形参 fn 就是函数本身, fn[i] 是 undefined, 调用立即抛 TypeError;
2. map 回调没有 return 那个 Promise, 得到的 promises 数组全是 undefined, Promise.all([undefined...]) 立即 resolve.

深入解析:

- 四类静态方法的语义差异是必考口述: all (快速失败) 、allSettled (永不 reject) 、race (第一个 settled 者胜出) 、any (第一个 fulfilled 胜出, 全败抛 AggregateError) .
- 计数器法 vs Promise.all(map) 法: 前者手动 resolve 一次, 注意空数组边界.

### 题目 32| delayAll

源码解读: delayAll(functions, ms) 返回新函数数组: 每个新函数调用时先 setTimeout(ms), 再执行原函数并把结果通过 resolve(fn()) 交给外层 Promise——利用了 Promise 对 thenable 的自动解包.

深入解析:

- resolve(fn()) 的解包语义: fn() 返回 Promise 时, 外层 Promise 吸收其状态.
- 延迟在"调用时"开始而非"创建时"——高阶函数返回的是惰性包装.
- 若 fn() 同步抛错, 发生在 setTimeout 回调内——错误不会进 Promise 链: 严谨实现应 try \{ resolve(fn()) \} catch (e) \{ reject(e) \}.

### 题目 33| JSON 转矩阵

源码解读: jsonToMatrix 把 JSON 对象数组展平成表: DFS 遍历每个对象, 叶子值记录到"路径 -> 值" (数组下标也并入路径) ; 收集全部路径去重、字典序排序作为列头; 每个对象一行, 缺列补 "".

深入解析:

- 字典序排序的坑: "a.10" < "a.2" (按字符比较) , 正确做法是 localeCompare 的 numeric: true 选项.
- 空对象/空数组没有叶子 -> 该对象贡献零列; 整行全 "".
- 应用: JSON 数据导出 Excel/CSV、低代码表格列推导、日志结构化展开.

## 第十三部分 补充深入专题

### TypeScript 转为 JS 的每一个过程

A: TypeScript 编译器 (tsc) 本质是一个"带类型擦除的转译器", 从源码到 JS 产物经历 6 个阶段:

1. 扫描 (Scanner / Lexer) : 源码文本 -> Token 流. const x: number = 1 被切分为 const、x、:、number、=、1 等 token, 跳过空白与注释 (注释会以 trivia 形式挂在 token 上供 emitter 保留) .

2. 解析 (Parser) : Token 流 -> AST (抽象语法树) . TS 的 AST 节点带完整的位置信息 (pos/end) , 且语法错误不中断解析 (错误恢复机制, 为 IDE 服务) .

3. 绑定 (Binder) : 遍历 AST 建立符号表 (Symbol Table) ——每个声明生成 Symbol, 记录作用域归属 (Container -> locals) . 此阶段把"同名标识符"关联到同一个 Symbol, 为类型检查提供名称解析基础.

4. 类型检查 (Checker) : 核心阶段——
   - 类型推断: 从初始化表达式、上下文 (contextual typing) 反推类型;
   - 类型标注验证: 检查赋值兼容性 (结构化类型 / duck typing, 而非名义类型) ;
   - 控制流分析 (CFA) : if (typeof x === 'string') 分支内收窄类型, 基于赋值流图 (flow graph) ;
   - 泛型实例化、条件类型求值、协变/逆变检查 (strictFunctionTypes 下方法参数双变、函数参数逆变) .
   - 注意: 类型错误不阻断编译 (除非 noEmitOnError) ——因为类型信息只用于检查, 不影响转译结果.

5. 转换 (Transformer) : AST -> AST 的降级变换, 按 target 决定应用哪些 transformer:
   - 类型擦除: 删除所有类型标注、接口、类型别名、as 断言、! 非空断言 (纯删除, 零运行时成本) ;
   - TS 独有语法展开: enum -> IIFE 生成双向映射对象; namespace -> IIFE 闭包; 参数属性 (constructor(private x)) -> 构造体内赋值语句;
   - 装饰器 (旧版) : 类与方法调用改写为 \_\_decorate([...], target, key, descriptor) 辅助函数调用; emitDecoratorMetadata 额外注入 Reflect.metadata("design:type", ...);
   - 语法降级: async/await -> \_\_awaiter + 生成器状态机 (target < ES2017, ES2017 及以上保留原生 async) ; class -> 函数 + 原型赋值 (<=ES5) ; ?. / ?? -> 临时变量 + 三元表达式;
   - 模块转换: ESM import/export -> CJS 的 require/exports.x (module: commonjs 时) .

6. 发射 (Emitter) : 变换后 AST -> 输出文本, 三种产物:
   - .js: 打印 AST (printer) , 按 removeComments/sourceMap 等选项处理;
   - .d.ts: 从符号表+类型信息生成声明文件 (只导出面可见的类型签名) ;
   - .js.map: VLQ 编码的 sourcemap, 建立产物位置与源码位置的映射.

补充深挖点:

- tsc vs transpileModule vs swc/esbuild/babel: transpileModule 走"单文件、无类型检查"快速通道 (无法处理 const enum 等需跨文件信息的特性) ; swc/esbuild 只做扫描/解析/降级/发射 (Rust/Go 实现快 10-100 倍) , 不做类型检查——所以现代工程链路是"esbuild/swc 负责转译 + tsc --noEmit 负责类型检查".
- 增量编译: incremental: true 生成 .tsbuildinfo (签名哈希 + 依赖图) , 二次编译跳过未变化文件.
- Language Service: 同一套编译器 API 驱动 VS Code 的跳转/补全/重构——binder/checker 结果常驻内存, 编辑时增量重解析.

### V8 性能优化 隐藏类 内联缓存 逃逸分析

A: 隐藏类 (Hidden Class / Map / Shape) :

- 对象属性按添加顺序形成转换链: \{\} -> \{x\} -> \{x, y\} 每一步生成新 Map, 记录属性名 -> 偏移量.
- 同形状对象共享 Map -> 属性访问编译为固定偏移的机器码.
- 优化守则: 构造函数里按固定顺序初始化全部属性; 避免 delete (退化为字典模式 dictionary mode) ; 避免运行期增删属性/改原型; 不同形状的对象别混进同一个数组/多态调用点.

内联缓存 (Inline Cache, IC) :

- 属性访问字节码处记录"上次对象的 Map + 命中偏移".
- 单态 (monomorphic) : 总是同 Map -> 直接比较 Map 后按偏移取值, 极快.
- 多态 (polymorphic, 2-4 种 Map) : 小跳转表.
- 超态 (megamorphic) : 退化哈希查表——热点代码要避免.
- TurboFan 基于 IC 反馈做推测优化: 假设类型不变直接生成机器码 + 去优化 (deopt) 检查点 (假设失败回退字节码) .

逃逸分析 (Escape Analysis) : JIT 证明对象不逃逸出函数 (不外传、不存堆) -> 标量替换: 对象不分配, 字段拆成局部变量 (栈上寄存器分配) , 省掉堆分配与 GC.

其他:

- 函数内联 (inlining) : 小函数直接展开.
- 数组 ElementsKind: PACKED*SMI -> PACKED_DOUBLE -> PACKED_ELEMENTS 单向迁移, 稀疏数组变 HOLEY*\* 甚至字典——保持数组紧凑、同类型.
- 数字: 31 位内整数走 SMI (指针 tagged) 不开箱, 超出变 HeapNumber.
- 字符串: cons string (拼接先存切片树) 、sliced string、intern 化.

要点: 写"JIT 友好"代码 = 形状稳定 + 类型稳定 + 热点函数小而纯.

### ES 新特性核心要点

A: 尾调用优化 (PTC, ES6 规范) : 严格模式下 return f(...) 复用当前栈帧——理论上递归阶乘可 O(1) 栈. 现实: 只有 Safari/JSC 实现, V8 曾实现后移除——要记住"规范有、引擎没普及, 别依赖".

BigInt: 任意精度整数 (123n) ; 不能与 Number 混算 (显式转换) ; typeof 1n === 'bigint'; JSON 序列化抛错; BigInt.asIntN(64, x) 固定位宽截断. 应用: 雪花 ID、时间戳纳秒、区块链数值.

其他常考:

- ?. / ??: ?? 只判 null/undefined (0/''/false 有效) , 与 || 的本质差异; ?.() / ?.[] / 可选链短路返回 undefined; a?.b.c 中 a 为 nullish 时整个链短路.
- 逻辑赋值 ??= / &&= / ||=.
- Array.prototype.at(-1)、findLast.
- Object.hasOwn (替代 hasOwnProperty.call) .
- 顶层 await (ES2022) ; 类私有字段 #x (真私有, 运行时不可访问, 与 TS private 的"类型层私有"本质不同) .
- Object.groupBy / Map.groupBy (ES2024; 原 Array.prototype.group 提案最终改为静态方法落地) ; Promise.withResolvers (ES2024) ; structuredClone (注意它是 HTML 标准的 Web API 而非 ECMAScript 特性) .
- 正则 d 标志 (indices, 捕获组起止下标) 、命名捕获组、后行断言.
- ES2025 已落地 (2025-06 定稿): Set 集合方法 (union/intersection/difference 等) 、Iterator Helpers (Iterator.prototype.map/filter/take 等) 、Promise.try、RegExp.escape、Float16Array, 现代浏览器基本都已原生支持.
- import attributes (`import ... with` 语法) 与 JSON modules 未列入 ES2025 正式清单, 但已获跨浏览器支持 (MDN Baseline 2025, 2025-04 起) , 正式收入 ECMA-262 版本稍晚.
- 在途提案: Temporal (取代 Date, 仍处 Stage 3; Chrome 144+/Firefox 139+ 已原生提供, Safari 尚未) 、Record & Tuple (#\{...\} 深不可变 + 值相等 ===) 、Decorator (Stage 3, 已落地 TS 5) 、Pattern Matching.

### 正则引擎与灾难性回溯

A: NFA 回溯模型: JS 正则是回溯式 NFA——贪婪量词先尽量多吃, 匹配失败按"后进先出"回溯让位.

灾难性回溯 (ReDoS) 成因: 嵌套量词 + 可重叠匹配——/(a+)+$/ 对 "aaaaaaaaaaaaaaaaaaaaX" 的划分方案数是指数级 (2^n 种分组) , 引擎全试一遍才宣告失败.

识别与防御:

- 危险信号: (x+)+、(x|y)\* 内部分支可匹配相同前缀、.\*.\*.\* 连续贪婪.
- 防御: 改写为原子化结构 (a+ 外不再套量词) 、限定长度 \{1,64\}、用 possessive 思路拆匹配、输入长度校验、worker 中执行 + 超时杀掉 (JS 正则无超时参数) .
- 工具: safe-regex、recheck 静态分析.

其他深挖:

- lastIndex 与 g/y 标志: 全局正则在 exec/test 间共享 lastIndex (同一个正则对象连续 test 结果交替的坑) .
- 命名捕获组 (?`<year>`\d\{4\}) 与 matchAll (返回迭代器, 避免 exec 循环) .
- Unicode: u 标志下 . 匹配码点 (含代理对) 、\p\{Script=Han\} 属性类.
- v 标志 (ES2024) : 字符集运算 [\p\{ASCII\}--[aeiou]].
- 性能: 编译正则缓存 (字面量只编译一次) 、避免不必要捕获组 (用 (?:...)) .

### fetch 与 XHR 的细节对比

A: fetch 的坑 (高频) :

- HTTP 错误状态不 reject: 404/500 照常 resolve, 要检查 response.ok 或 status——只有网络故障/CORS/DNS 失败才 reject.
- 凭证策略: fetch 默认 credentials: 'same-origin' (同源请求带 Cookie, 跨源不带) , 跨源要带 Cookie 需显式 credentials: 'include'.
- 无原生超时: 用 AbortController + setTimeout 自实现.
- 无上传进度事件 (响应体 ReadableStream 只有下载进度; duplex: 'half' 只是允许流式发送请求体, 仍拿不到网络层上传进度, 精确进度要用 XHR 的 upload.onprogress) .
- 响应体只能读一次 (bodyUsed, clone() 备份) .

AbortController (现代取消模型) :

```js
const ctrl = new AbortController();
fetch(url, { signal: ctrl.signal });
ctrl.abort(); // fetch reject: AbortError; 同时中止 TCP 读取
```

同一 signal 可传给多个 fetch/addEventListener——统一取消域; AbortSignal.timeout(5000)、AbortSignal.any([...]) 组合信号.

流式能力: response.body.getReader() 逐块读取 (SSE 客户端、大文件边下边处理、for await 消费) ; request body 传 ReadableStream 需 duplex: 'half'.

XHR 尚存的场景: 上传进度事件 (xhr.upload.onprogress) 、同步请求 (async: false, 已废弃勿用) 、老环境兼容.

深挖: keepalive: true (页面卸载时小数据上报, beacon 的 fetch 版) ; redirect: 'manual' 观察重定向; referrerPolicy 控制 Referer 泄漏; cache 选项与 HTTP 缓存的互动; Node 18+ 全局 fetch (undici) 与浏览器实现的差异 (无 CORS、有连接池配置) .
