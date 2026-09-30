---
title: "React 核心知识点"
---

> 本文档涵盖运行时机制、性能优化、Hooks 原理等核心主题. 每个知识点均附详细解析.

## 1. 闭包陷阱 (Stale Closure)

### 题目

请分析以下代码的输出结果, 并解释原因. 如何修复?

```jsx
function Counter() {
  const [count, setCount] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      console.log(count);
      setCount(count + 1);
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  return <span>{count}</span>;
}
```

### 解析

输出结果: 控制台每秒打印 `0`, 页面始终显示 `1`.

根因分析:

`useEffect` 的依赖数组为空 `[]`, 意味着该副作用仅在组件挂载时执行一次. 此时 `setInterval` 的回调函数捕获的是首次渲染时的 `count` 值 (即 `0`) . 由于 JavaScript 闭包的特性, 回调函数内部的 `count` 永远引用的是创建时那次渲染的快照值, 后续渲染产生的新 `count` 对该闭包不可见.

因此:

- `console.log(count)` 始终打印 `0`
- `setCount(count + 1)` 始终等价于 `setCount(0 + 1)`, 即 `setCount(1)`
- React 检测到 state 从 `0` 变为 `1` 后触发一次重渲染, 之后 `setCount(1)` 不再产生变化, 渲染停止

修复方案 (由优到劣) :

```jsx
// 方案一: 函数式更新 (推荐)
setCount((prev) => prev + 1);

// 方案二: 将 count 加入依赖数组
useEffect(() => {
  const timer = setInterval(() => {
    setCount((c) => c + 1);
  }, 1000);
  return () => clearInterval(timer);
}, [count]); // 每次 count 变化重建定时器

// 方案三: useRef 保存最新值
const countRef = useRef(count);
countRef.current = count;

useEffect(() => {
  const timer = setInterval(() => {
    console.log(countRef.current);
    setCount(countRef.current + 1);
  }, 1000);
  return () => clearInterval(timer);
}, []);
```

延伸: 为什么 `useRef` 能绕过闭包陷阱?

`useRef` 返回的是一个可变对象 `{ current: T }`, 其引用在组件整个生命周期内保持不变. 闭包捕获的是 `ref` 对象本身的引用 (不变) , 而非 `ref.current` 的值. 每次渲染时我们手动同步 `ref.current = count`, 因此闭包内通过 `ref.current` 总能读取到最新值. 本质上是将值语义转换为引用语义.

---

## 2. Re-render 陷阱与渲染机制

### 题目

以下代码中, 点击 `Parent` 的按钮后, `Child` 是否会重新渲染? 为什么? 如何避免不必要的渲染?

```jsx
function Parent() {
  const [count, setCount] = useState(0);

  const handleClick = () => setCount((c) => c + 1);

  return (
    <div>
      <button onClick={handleClick}>+1</button>
      <Child onClick={() => console.log("clicked")} />
    </div>
  );
}

function Child({ onClick }) {
  console.log("Child rendered");
  return <button onClick={onClick}>Child</button>;
}
```

### 解析

结论: 每次点击按钮, `Child` 都会重新渲染.

原因:

React 的默认渲染行为是自顶向下的: 当 `Parent` 的 state 变化触发重渲染时, 其所有子组件默认也会重新渲染——无论子组件的 props 是否实际发生变化.

此例中更严重的问题是 `onClick={() => console.log('clicked')}` 是一个内联箭头函数, 每次 `Parent` 渲染都会创建一个新的函数引用. 即使使用 `React.memo` 包裹 `Child`, 浅比较也会判定 props 变化, memo 失效.

系统性解决方案:

```jsx
// 1. React.memo + useCallback 组合
const MemoChild = React.memo(Child);

function Parent() {
  const [count, setCount] = useState(0);
  const handleClick = useCallback(() => console.log("clicked"), []);

  return (
    <div>
      <button onClick={() => setCount((c) => c + 1)}>+1</button>
      <MemoChild onClick={handleClick} />
    </div>
  );
}

// 2. 状态下沉: 将 count 移到不影响 Child 的层级
// 3. 组合模式: 通过 children 透传, 避免 props 变化
function Parent({ children }) {
  const [count, setCount] = useState(0);
  return (
    <div>
      <button onClick={() => setCount((c) => c + 1)}>+1</button>
      {children} {/* children 引用不变, 不触发重渲染 */}
    </div>
  );
}
```

延伸: `React.memo` 的浅比较具体比较什么? 对引用类型有何影响?

`React.memo` 默认使用 `Object.is` 对每个 prop 进行浅比较. 对于基本类型 (number、string、boolean) 比较值; 对于引用类型 (object、array、function) 比较引用地址. 因此:

- 每次渲染新建的对象字面量 `{}`、数组 `[]`、箭头函数 `() => {}` 都会导致 memo 失效
- 必须配合 `useMemo` (缓存对象/数组) 和 `useCallback` (缓存函数) 使用
- 可传入第二个参数自定义比较函数: `React.memo(Comp, areEqual)`

---

## 3. React Fiber 架构

### 题目

请解释 React Fiber 的核心设计目标、数据结构, 以及它如何实现可中断渲染.

### 解析

设计目标:

React 15 的 Stack Reconciler 采用递归方式同步遍历整棵组件树. 一旦组件树规模庞大, 主线程会被长时间占用 (超过 16ms) , 导致动画掉帧、用户输入无响应. Fiber 的核心目标是:

1. 可中断 (Interruptible) : 将渲染工作拆分为小单元, 可在任意单元间暂停
2. 可恢复 (Resumable) : 暂停后可从断点继续, 无需从头开始
3. 可优先级调度 (Prioritizable) : 高优先级任务 (用户输入) 可打断低优先级任务 (数据预取)

Fiber 节点数据结构:

```typescript
interface FiberNode {
  // 节点标识
  tag: WorkTag; // 组件类型 (FunctionComponent, ClassComponent, HostComponent...)
  key: null | string;
  type: any; // 组件函数/类/DOM 标签名
  stateNode: any; // 对应的 DOM 节点或类实例

  // 树结构 (链表化)
  return: Fiber | null; // 父节点
  child: Fiber | null; // 第一个子节点
  sibling: Fiber | null; // 下一个兄弟节点
  alternate: Fiber | null; // 双缓冲: 指向另一棵树中的对应节点

  // 状态与副作用
  pendingProps: any;
  memoizedProps: any;
  memoizedState: any; // Hooks 链表头 (函数组件)
  updateQueue: any; // 更新队列

  // 副作用标记
  flags: Flags; // Placement | Update | Deletion | ...
  subtreeFlags: Flags; // 子树的副作用 (React 18 优化)
  deletions: Fiber[] | null;

  // 优先级
  lanes: Lanes;
  childLanes: Lanes;
}
```

关键设计: 链表化树结构

传统树遍历依赖递归 (调用栈不可控) . Fiber 将树结构转化为 `child → sibling → return` 的链表, 用 `while` 循环遍历:

```
    App
   / | \
  A  B  C
 / \
D   E

遍历顺序: App → A → D → E → B → C → (return to App)
```

每处理完一个 Fiber 节点 (称为一个 "unit of work") , 检查是否需要让出主线程:

```javascript
// 简化版工作循环
function workLoopConcurrent() {
  while (workInProgress !== null && !shouldYield()) {
    performUnitOfWork(workInProgress);
  }
}

function shouldYield() {
  return getCurrentTime() >= deadline; // 默认 5ms 时间片
}
```

双缓冲 (Double Buffering) 机制:

React 维护两棵 Fiber 树:

- current 树: 当前屏幕上显示的内容
- workInProgress 树: 正在构建的新内容

通过 `alternate` 指针互相引用. 渲染完成后, React 一次性将 `current` 指针切换到 workInProgress 树 (commit 阶段) , 避免中间状态暴露给用户.

两阶段模型:

| 阶段     | 名称          | 特征                               | 可中断?  |
| -------- | ------------- | ---------------------------------- | -------- |
| 第一阶段 | Render (协调) | 构建 workInProgress 树, 标记副作用 | 可中断   |
| 第二阶段 | Commit        | 操作真实 DOM, 执行生命周期/副作用  | 同步执行 |

---

## 4. Virtual DOM 与 Diff 算法

### 题目

请描述 React 的 Diff 算法策略, 并解释为什么它的时间复杂度是 O(n) 而非 O(n³).

### 解析

传统树 Diff 的复杂度:

两棵树的完整 Diff 需要 O(n³) 时间复杂度 (编辑距离问题) . 对于包含 1000 个节点的树, 意味着 10⁹ 次比较, 不可接受.

React 的三个假设 (启发式策略) :

1. 不同类型的元素产生不同的树
   - 若根节点类型变化 (如 `<div>` → `<span>`, 或 `<ComponentA>` → `<ComponentB>`) , 直接销毁旧树并从头构建新树
   - 旧组件实例调用 `componentWillUnmount`, 新实例从头挂载

2. 同级元素通过 `key` 标识
   - 只比较同层级节点, 不跨层级移动
   - `key` 用于在同级列表中识别节点身份

3. 只做同层比较
   - 即使一个节点从树的 A 位置移动到 B 位置, React 也视为"删除 A + 新建 B", 而非"移动"

单节点 Diff:

```
新节点 vs 旧节点:
1. key 不同 → 删除所有旧节点, 创建新节点
2. key 相同, type 不同 → 删除旧节点, 创建新节点
3. key 相同, type 相同 → 复用 DOM, 更新 props
```

多节点 Diff (列表 Diff) :

React 对列表采用两轮遍历:

```
第一轮: 从左到右逐一对比
- 节点可复用 → 继续
- 节点不可复用 → 跳出第一轮

第二轮: 处理剩余节点
- 将旧节点放入 Map (key → fiber)
- 遍历新节点, 在 Map 中查找可复用节点
- 通过 lastPlacedIndex 判断是否需要移动
```

为什么 key 不能用 index?

```jsx
// 反例: 在列表头部插入元素
// 旧列表: [A, B, C]  → key: [0, 1, 2]
// 新列表: [X, A, B, C] → key: [0, 1, 2, 3]

// React 认为:
// key=0: A → X (更新)
// key=1: B → A (更新)
// key=2: C → B (更新)
// key=3: 新增 C
// 实际只需一次插入, 却触发了 3 次更新 + 1 次插入
```

使用稳定唯一 key (如 id) 时, React 能正确识别节点身份, 最小化 DOM 操作.

---

## 5. React 性能优化体系

### 题目

请系统性地阐述 React 应用的性能优化策略, 从渲染、内存、网络三个维度展开.

### 解析

### 5.1 渲染优化

| 策略                | 适用场景                        | 注意事项                                 |
| ------------------- | ------------------------------- | ---------------------------------------- |
| `React.memo`        | 纯展示组件, props 变化频率低    | 需配合 `useCallback`/`useMemo`, 否则无效 |
| `useMemo`           | 缓存计算密集型结果              | 有内存开销, 勿滥用                       |
| `useCallback`       | 缓存传递给子组件的回调          | 仅对 memo 子组件有意义                   |
| 状态下沉            | 高频变化的 state 仅影响局部 UI  | 最本质的优化, 减少渲染范围               |
| 组合模式 (children) | 父组件 state 变化不应影响子组件 | 利用 children 引用稳定性                 |
| `useDeferredValue`  | 大列表搜索、输入联想            | React 18 并发特性                        |
| `useTransition`     | 非紧急状态更新                  | 标记为 transition, 可被打断              |
| 虚拟化列表          | 长列表 (>1000 条)               | react-window / react-virtuoso            |

### 5.2 内存优化

```jsx
// 1. 及时清理副作用
useEffect(() => {
  const ws = new WebSocket(url);
  ws.onmessage = handleMessage;
  return () => ws.close(); // 防止内存泄漏
}, [url]);

// 2. 避免在闭包中持有大对象
useEffect(() => {
  const largeData = fetchLargeData();
  // 定时器闭包持有 largeData 引用
  const timer = setInterval(() => process(largeData), 1000);
  return () => clearInterval(timer);
}, []);

// 3. 使用 WeakRef / WeakMap 缓存可回收对象
const cache = new WeakMap();
```

### 5.3 网络与加载优化

- 代码分割: `React.lazy` + `Suspense` 按路由/组件级别分割
- 预加载: `<link rel="preload">` 或 `import()` 提前触发
- 服务端渲染 (SSR) / 流式渲染: 减少首屏白屏时间
- React 18 Streaming SSR: `renderToPipeableStream`, 分块发送 HTML
- 数据预取: 在路由级别并行加载数据, 避免瀑布流请求

### 5.4 性能度量

```jsx
// React Profiler API
<Profiler id="App" onRender={onRenderCallback}>
  <App />
</Profiler>;

function onRenderCallback(id, phase, actualDuration, baseDuration) {
  // actualDuration: 本次渲染实际耗时
  // baseDuration: 无优化时的预估耗时
}
```

工具链: React DevTools Profiler → Chrome Performance → 自定义埋点.

---

## 6. Hooks 为什么只能在组件顶层调用

### 题目

React 官方规定 Hooks 不能在条件语句、循环或嵌套函数中调用. 请从实现原理层面解释这一约束的根本原因.

### 解析

根本原因: Hooks 依赖调用顺序来标识自身.

函数组件没有类组件的 `this` 实例来存储状态. React 内部为每个函数组件维护一个 Hooks 链表 (挂载在 Fiber 节点的 `memoizedState` 上) :

```
FiberNode.memoizedState → Hook1 → Hook2 → Hook3 → null
                           ↑        ↑        ↑
                        useState  useEffect  useMemo
```

每个 Hook 节点的结构:

```typescript
interface Hook {
  memoizedState: any; // 当前状态值
  baseState: any; // 基础状态
  baseQueue: Update[]; // 未处理的更新队列
  queue: UpdateQueue; // 更新队列
  next: Hook | null; // 指向下一个 Hook (链表)
}
```

渲染时如何匹配 Hook?

React 通过一个全局游标 (`currentHook` 指针) 按顺序遍历链表. 每次调用 `useState`/`useEffect` 等 API 时, 内部执行:

```javascript
// 简化版
function mountWorkInProgressHook() {
  const hook = { memoizedState: null, next: null };
  // 追加到链表尾部
  workInProgressHook.next = hook;
  workInProgressHook = hook;
  return hook;
}

function updateWorkInProgressHook() {
  // 从 current 树中取出对应位置的 Hook
  const nextCurrentHook = currentHook.next;
  currentHook = nextCurrentHook;
  return currentHook;
}
```

如果允许条件调用会怎样?

```jsx
function BadComponent({ flag }) {
  const [name, setName] = useState("Alice"); // Hook #0

  if (flag) {
    const [age, setAge] = useState(25); // Hook #1 (有时存在)
  }

  const [color, setColor] = useState("red"); // Hook #1 or #2 ???
}
```

当 `flag` 从 `true` 变为 `false` 时:

- 第一次渲染链表: `name → age → color` (3 个节点)
- 第二次渲染链表: `name → color` (2 个节点)

游标走到第 2 个位置时, 第一次取到 `age` 的 Hook, 第二次取到 `color` 的 Hook. 状态错位, 产生不可预测的 bug.

为什么不用 key/名称来标识 Hook?

1. 性能: 链表按序访问是 O(1), 引入 key 查找变为 O(n)
2. API 设计: 无需用户手动命名, 减少心智负担
3. 静态检查: ESLint 规则 `react-hooks/rules-of-hooks` 在编码/静态检查阶段即可检测违规

React Compiler 现状:

React Compiler 已于 2025 年 10 月发布 1.0 并可用于生产, 以独立的 Babel 插件形式启用, 兼容 React 17+. 它在编译期自动插入记忆化 (等效于自动 memo/useMemo/useCallback) , 但 Hooks 必须无条件调用的规则并未放宽——编译器同样依赖调用顺序稳定这一前提, 底层链表结构没有改变.

---

## 7. setState 批量更新机制

### 题目

请解释 React 17 与 React 18 中 `setState` 批量更新 (Batching) 的差异, 并分析以下代码的输出.

```jsx
function App() {
  const [count, setCount] = useState(0);
  const [flag, setFlag] = useState(false);

  const handleClick = () => {
    setCount((c) => c + 1);
    setCount((c) => c + 1);
    setFlag((f) => !f);
    console.log(count); // ?

    setTimeout(() => {
      setCount((c) => c + 1);
      setFlag((f) => !f);
      console.log(count); // ?
    }, 0);
  };

  return <button onClick={handleClick}>Click</button>;
}
```

### 解析

### React 17 的行为

React 17 仅在 React 事件处理函数 和 生命周期方法 中进行批量更新. 在 `setTimeout`、`Promise.then`、原生事件监听器等异步上下文中, 每次 `setState` 都会立即触发一次重渲染.

```
// React 17 输出:
// 事件处理中: console.log(count) → 0 (state 尚未更新)
//   setCount + setCount + setFlag → 批量合并为 1 次渲染

// setTimeout 中: console.log(count) → 0 (闭包中的旧值)
//   setCount → 触发第 1 次渲染
//   setFlag  → 触发第 2 次渲染
//   共 2 次渲染
```

### React 18 的行为 (Automatic Batching)

React 18 引入自动批量更新: 无论在何种上下文中 (事件处理、setTimeout、Promise、原生事件) , 连续的 `setState` 都会被自动合并为一次渲染.

```
// React 18 输出:
// 事件处理中: console.log(count) → 0
//   setCount + setCount + setFlag → 1 次渲染

// setTimeout 中: console.log(count) → 0 (闭包旧值)
//   setCount + setFlag → 1 次渲染 (自动批量)
```

### 实现原理

```javascript
// React 18 内部简化逻辑
function dispatchSetState(fiber, queue, action) {
  const update = createUpdate(action);
  enqueueUpdate(fiber, queue, update);

  // 关键: 不再判断是否在 React 事件上下文中
  // 统一通过调度器安排更新
  scheduleUpdateOnFiber(fiber, lane);
}

// 调度器将同一 lane 的更新合并到同一个渲染周期
function scheduleUpdateOnFiber(fiber, lane) {
  markUpdateLaneFromFiberToRoot(fiber, lane);
  ensureRootIsScheduled(root); // 微任务/宏任务级别去重
}
```

### 如何退出批量更新?

```jsx
import { flushSync } from "react-dom";

const handleClick = () => {
  flushSync(() => {
    setCount((c) => c + 1); // 立即渲染
  });
  flushSync(() => {
    setFlag((f) => !f); // 立即渲染
  });
  // 共 2 次渲染
};
```

### 函数式更新 vs 直接赋值

```jsx
// 直接赋值: 基于闭包中的旧值
setCount(count + 1);
setCount(count + 1); // 两次都是 count + 1, 最终只 +1

// 函数式更新: 基于最新 state
setCount((c) => c + 1);
setCount((c) => c + 1); // 链式执行, 最终 +2
```

函数式更新的 action 会被放入更新队列, 在 render 阶段依次对 `baseState` 执行, 因此不受闭包影响.

---

## 8. React 并发模式与调度

### 题目

请解释 React 18 的并发渲染 (Concurrent Rendering) 机制, 以及 `useTransition` 和 `useDeferredValue` 的区别与适用场景.

### 解析

### 并发渲染核心思想

并发渲染并非多线程, 而是单线程内的协作式调度:

1. 将渲染工作拆分为多个小任务 (Fiber 单元)
2. 每个任务执行后检查是否需要让出主线程 (`shouldYield`)
3. 高优先级更新可打断低优先级更新
4. 被中断的渲染可稍后恢复或丢弃重来

### 优先级模型 (Lanes)

```
SyncLane           → 用户输入、flushSync (最高优先级)
InputContinuousLane → 拖拽、滚动等连续交互
DefaultLane        → 普通 setState
TransitionLane     → useTransition 标记的更新 (低优先级)
IdleLane           → 空闲时执行 (简化示意; 源码中 OffscreenLane 的优先级比它更低)
```

### useTransition vs useDeferredValue

```jsx
// useTransition: 标记"产生更新"的过程为低优先级
const [isPending, startTransition] = useTransition();

const handleSearch = (e) => {
  setInputValue(e.target.value); // 高优先级: 输入框立即响应
  startTransition(() => {
    setSearchQuery(e.target.value); // 低优先级: 搜索结果可延迟
  });
};

// useDeferredValue: 延迟"消费更新"的时机
const [query, setQuery] = useState("");
const deferredQuery = useDeferredValue(query);

// query 立即更新, deferredQuery 在空闲时才跟上
const results = useMemo(() => searchItems(deferredQuery), [deferredQuery]);
```

| 维度     | `useTransition`                | `useDeferredValue`                     |
| -------- | ------------------------------ | -------------------------------------- |
| 控制点   | 更新的生产端 (setState 调用处) | 更新的消费端 (渲染读取处)              |
| 适用场景 | 你能修改 setState 的调用方式   | 你无法控制 state 的来源 (如来自 props) |
| 返回值   | `[isPending, startTransition]` | 延迟后的值                             |
| 典型用例 | 搜索输入、Tab 切换             | 大列表过滤、第三方组件的 props         |

### Suspense 与并发的关系

```jsx
<Suspense fallback={<Skeleton />}>
  <AsyncComponent /> {/* 内部 throw Promise */}
</Suspense>
```

Suspense 在并发模式下获得完整能力:

- 已显示内容不会被 fallback 闪烁替换 (保持旧 UI 直到新内容就绪) , 前提是该更新被 transition 包裹; 紧急更新 (如初始挂载、非 transition 的 setState) 仍会立即显示 fallback
- 配合 `useTransition` 可避免加载态闪烁

---

## 9. useEffect 与生命周期映射

### 题目

`useEffect` 是否等同于 `componentDidMount` + `componentDidUpdate` + `componentWillUnmount` 的组合? 请深入分析其执行时机与心智模型.

### 解析

结论: 不等同. 将 `useEffect` 简单映射为生命周期方法是常见的心智模型误区.

### 执行时机对比

```
类组件:
render → DOM 更新 → componentDidMount/componentDidUpdate (同步, 阻塞绘制)

函数组件:
render → DOM 更新 → 浏览器绘制 → useEffect (异步, 不阻塞绘制)
                    → useLayoutEffect (同步, 阻塞绘制)
```

- `useEffect` 在浏览器完成绘制之后异步执行 (通过 `Scheduler` 调度为普通优先级任务)
- `useLayoutEffect` 在 DOM 变更后、绘制前同步执行, 等价于 `componentDidMount/Update` 的时机

### 正确的心智模型: 同步效应

`useEffect` 的设计意图是将组件与外部系统同步:

```jsx
// 组件与外部系统 (WebSocket、DOM API、第三方库) 的同步
useEffect(() => {
  const connection = createConnection(serverUrl, roomId);
  connection.connect();
  return () => connection.disconnect();
}, [serverUrl, roomId]); // 依赖变化 = 重新同步
```

核心原则:

- 每个 `useEffect` 表达一个独立的同步关注点
- 依赖数组描述"何时需要重新同步"
- 清理函数描述"如何断开上一次同步"

### 常见陷阱

```jsx
// 陷阱一: 对象/数组依赖导致无限循环
useEffect(() => {
  fetchData(options);
}, [options]); // options 每次渲染都是新对象

// 修复: 依据基本类型依赖用 useMemo 重建稳定引用 (或直接把 effect 依赖改为 options.a 等基本类型)
const stableOptions = useMemo(
  () => ({ a: options.a, b: options.b }),
  [options.a, options.b],
);

// 陷阱二: 在 useEffect 中同步更新 state 导致循环
useEffect(() => {
  setDerived(computeFrom(props)); // 每次 props 变化 → 渲染 → effect → setState → 渲染...
}, [props]);

// 修复: 渲染期间直接计算 (派生状态不需要 effect)
const derived = useMemo(() => computeFrom(props), [props]);
```

### Strict Mode 下的双重调用

React 18+ 开发模式 (需启用 StrictMode) 下, `useEffect` 会执行 mount → unmount → mount 序列:

```
第一次 mount: 执行 effect
模拟 unmount: 执行 cleanup
第二次 mount: 再次执行 effect
```

目的: 强制开发者编写正确的清理逻辑, 为并发模式下组件的"卸载-重挂载"做准备.

---

## 10. React 状态管理设计哲学

### 题目

在大型 React 应用中, 如何设计状态管理架构? 请对比 Context、Redux、Zustand、Jotai 的设计哲学与适用边界.

### 解析

### 状态分类

| 类型           | 示例                 | 推荐方案                         |
| -------------- | -------------------- | -------------------------------- |
| 服务器状态     | API 数据、缓存       | TanStack Query / SWR / RTK Query |
| 全局客户端状态 | 用户信息、主题、权限 | Zustand / Jotai / Redux Toolkit  |
| 局部 UI 状态   | 表单输入、弹窗开关   | useState / useReducer            |
| URL 状态       | 路由参数、查询条件   | React Router / nuqs              |
| 跨组件共享状态 | 列表选中项、拖拽状态 | Context (低频) / Zustand (高频)  |

### Context 的局限

```jsx
// Context 的问题: 任何消费者组件都会因 Provider value 变化而重渲染
const ThemeContext = createContext();

function App() {
  const [theme, setTheme] = useState("dark");
  const [user, setUser] = useState(null);

  // theme 或 user 任一变化, 所有消费者都重渲染
  return (
    <ThemeContext.Provider value={{ theme, user }}>
      <Page />
    </ThemeContext.Provider>
  );
}
```

Context 适用场景: 低频更新、全局配置 (主题、语言、当前用户) . 高频更新的状态不应放入 Context.

### 各方案对比

| 维度       | Redux Toolkit           | Zustand               | Jotai              |
| ---------- | ----------------------- | --------------------- | ------------------ |
| 范式       | Flux (单向数据流)       | 发布-订阅             | 原子化 (自底向上)  |
| 样板代码   | 中等 (slice 模式已简化) | 极少                  | 极少               |
| 选择性订阅 | `useSelector`           | `useStore(selector)`  | 天然原子级         |
| 中间件     | 丰富 (thunk, saga)      | 内置 (persist, immer) | 有限               |
| DevTools   | 完善                    | 支持                  | 支持               |
| 适用规模   | 大型团队、复杂业务流    | 中大型, 追求简洁      | 中小型, 原子化思维 |
| 学习曲线   | 较陡                    | 平缓                  | 平缓               |

### 设计原则

1. 状态就近原则: 状态放在最近的公共祖先, 避免不必要的全局化
2. 单一数据源: 同一份数据只在一个地方定义, 其他地方派生
3. 最小化状态: 能从已有状态计算得出的, 不要额外存储
4. 服务端状态与客户端状态分离: 不要用 Redux 管理 API 缓存
5. 不可变更新: 所有状态更新必须返回新引用, 保证 React 能正确检测变化

---

## 附加题: 手写实现

### 实现一个简化版 useState

```javascript
let hookIndex = 0;
let hooks = [];
let isMount = true;

function useState(initialValue) {
  const currentIndex = hookIndex;

  if (isMount) {
    hooks[currentIndex] = {
      state: typeof initialValue === "function" ? initialValue() : initialValue,
      queue: [],
    };
  }

  const hook = hooks[currentIndex];

  // 处理队列中的更新
  while (hook.queue.length > 0) {
    const action = hook.queue.shift();
    hook.state = typeof action === "function" ? action(hook.state) : action;
  }

  const setState = (action) => {
    hook.queue.push(action);
    render(); // 触发重渲染
  };

  hookIndex++;
  return [hook.state, setState];
}

function render() {
  hookIndex = 0;
  isMount = false;
  // 重新执行组件函数...
}
```

### 实现一个简化版 useDebounce

```javascript
function useDebounce(value, delay = 300) {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedValue(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return debouncedValue;
}
```

---

## 知识掌握维度

| 层级 | 期望                                                                            |
| ---- | ------------------------------------------------------------------------------- |
| 基础 | 能正确回答闭包陷阱、批量更新、memo 使用; 理解 Fiber 设计目标                    |
| 进阶 | 能深入 Fiber 链表结构与调度原理; 理解 Lanes 优先级模型; 能设计状态管理架构      |
| 深入 | 能从编译器视角理解 Hooks 约束; 能设计并发渲染下的数据流方案; 能主导性能治理体系 |

---

_本文档由 Yukino 编写, 最后更新: 2026-07-21_
