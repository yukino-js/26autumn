---
title: "React 19 核心与运行时原理"
description: "从一次更新的完整生命周期讲到 Fiber 协调、Hooks 链表、Lanes 优先级与批处理, 并覆盖 React 19 的 Actions、use、ref 作为 prop 等新增与稳定 API, 以及性能优化的有效条件"
---

这份文档面向已经会写 React、但想搞清楚它为什么这样工作的工程师. 内容以运行时机制为主线: 一次状态更新经历了哪些阶段, Fiber 如何把递归渲染变成可中断的工作循环, Hooks 为什么必须按顺序调用, 并发特性与 Actions 建立在什么调度模型之上. 读完应当能解释"为什么这里会读到旧值""为什么 memo 没有生效""为什么这个 Suspense 没有复用旧 UI"这类问题, 并能据此做取舍, 而不是记住一批 API 用法. 需要渲染框架层面的落地实践, 见 [Next.js](next); 构建与打包见 [Vite](vite).

## 一次更新的完整生命周期

### 渲染阶段与提交阶段

React 把一次更新拆成两个性质完全不同的阶段. 理解这条分界线, 是理解后续所有机制的前提.

| 阶段     | 常见叫法                       | 做的事情                                                                    | 能否中断       | 能否产生可见副作用 |
| -------- | ------------------------------ | --------------------------------------------------------------------------- | -------------- | ------------------ |
| 第一阶段 | Render / 协调 (reconciliation) | 调用组件函数, 生成新元素树, 与旧 Fiber 树对比, 标记需要变更的节点           | 能             | 不能               |
| 第二阶段 | Commit / 提交                  | 把变更一次性写入真实 DOM, 执行 ref 回调、layout effect、effect 的清理与重建 | 不能, 同步走完 | 能                 |

Render 阶段可能被反复开始、中断、丢弃、重来. 因此这个阶段里读到的任何中间状态都不该被外部系统观察到. 组件函数、`useMemo` 工厂、reducer 都运行在 Render 阶段, 所以它们必须是纯的: 给定相同输入得到相同输出, 不改外部变量, 不发请求, 不写 DOM. 反过来, 只有在 Commit 阶段之后才允许与外部世界交互, 这正是 effect 存在的意义.

渲染阶段的产物不是"新的 DOM", 而是一棵带着副作用标记的 Fiber 树; 提交阶段才是把这些标记翻译成最小化的 DOM 操作.

### Virtual DOM 的定位

React Element 是普通 JavaScript 对象, 描述"界面应该长什么样", 而不是一个真实的 DOM 节点, 也不是组件实例. 把它称作 Virtual DOM 容易引出一个错误前提: 它比手动操作 DOM 更快. 实际上直接写 DOM 通常更快, 因为它跳过了对比这一步.

React Element 真正提供的价值在于:

- 声明式描述, 开发者只声明目标状态, 不描述从旧状态到新状态的迁移步骤.
- 更新合并, 同一次事件中多次状态变更被合并为一次提交.
- 可对比, 有了新旧两棵描述树, 才能自动计算出最小 DOM 变更集.
- 跨平台, 同一棵描述树可以交给不同渲染器输出为 DOM、原生视图或字符串.

### 双缓冲与树切换

React 内部同时维护两棵 Fiber 树. 屏幕上已经呈现的那棵叫 current, 正在构建的那棵叫 workInProgress. 两棵树中位置对应的节点通过 `alternate` 互相引用.

更新时, React 在 workInProgress 树上干活, current 树保持不动, 因此用户看到的画面在整个 Render 阶段都不受影响. 当 workInProgress 构建完成并进入提交阶段, React 直接切换根节点的指针, 让 workInProgress 成为新的 current. 这就是双缓冲 (double buffering): 用一次指针切换代替大量可见的中间状态.

同一个 Fiber 节点在两次更新之间会被复用, 但它的 `alternate` 指向另一棵树中的对应节点, 所以"当前值"和"正在计算的值"不会互相污染.

## 函数组件与闭包

### 快照语义

每次渲染都是一次独立的函数调用. 这次调用里通过参数和 Hooks 拿到的所有值, 都被绑定在本次调用的作用域中, 后续渲染产生的新值不会改变已经创建的那个闭包. 换句话说, props 和 state 在单次渲染内是常量.

这带来一个反直觉的结论: 在事件处理器或 effect 中异步执行的回调, 看到的是创建它的那次渲染的值, 而不是"最新值". 这不是 bug, 而是为了让同一份 UI 描述内部自洽——如果一次渲染中途读到别的渲染的值, 渲染就不纯了.

### 闭包陷阱的成因

一个典型写法是空依赖的 effect 里启动定时器, 回调中读取 state:

```jsx
function Counter() {
  const [count, setCount] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      console.log(count);
      setCount(count + 1);
    }, 1000);
    return () => clearInterval(timer);
  }, []); // 只在挂载时执行一次

  return <span>{count}</span>;
}
```

effect 只运行一次, 它的回调被永久绑定在首次渲染的作用域上, `count` 永远是 0. 于是 `setCount(count + 1)` 每次都在表达 `setCount(1)`, 状态从 0 到 1 之后就再没有变化, 页面停住, 而日志每秒打印 0.

问题不在 `useEffect`, 而在"回调捕获了创建时的快照, 却被要求长期运行". 解决办法就是切断这种耦合.

### 四种解法对比

| 解法           | 做法                             | 读值时机                          | 适用场景                           | 代价                         |
| -------------- | -------------------------------- | --------------------------------- | ---------------------------------- | ---------------------------- |
| 函数式更新     | `setCount((c) => c + 1)`         | 由 React 在计算新状态时传入最新值 | 新状态只依赖旧状态                 | 只能拿到 state, 拿不到 props |
| 依赖数组       | 把 `count` 加入 deps             | 每次相关值变化时重建回调          | 回调确实依赖某个值                 | 会重建定时器/订阅            |
| ref 保存最新值 | 渲染时同步 `ref.current = count` | 读取时取 `ref.current`            | 需要在长期回调中读最新 props/state | 需手动同步, 容易漏           |
| Effect Event   | `useEffectEvent` 包装回调        | 调用时读取最新值                  | effect 内部需要调用"最新"回调      | 只能在 effect 中调用         |

ref 之所以能绕过闭包, 是因为闭包捕获的是 ref 对象本身的引用, 而这个引用在组件整个生命周期内不变; 变得只是它内部的 `current` 字段. 本质上是用引用语义替代值语义.

`useEffectEvent` 是这件事的官方归纳: 它返回一个函数, 这个函数在调用时读取最新的 props 与 state, 但不需要出现在依赖数组里. 规则很明确——返回的函数只能从 effect 内部调用, 不能传递给子组件, 也不应写进依赖数组.

### 依赖数组的模型

把 effect 理解为"与外部系统同步"比把它理解为"生命周期钩子"更准确. 依赖数组描述的是"哪些输入变了就需要重新同步", 清理函数描述的是"如何断开上一次同步". 每个 effect 负责一个独立的同步关注点.

由此可以推出两条常见错误:

- 依赖里放对象或数组字面量, 每次渲染都是新引用, 同步被无限重做. 应当把依赖收敛到基本类型字段, 或在确实需要整体对象时保证引用稳定.
- 用 effect 去同步一个可以从现有数据算出来的状态, 会引入额外的渲染轮次并让状态出现漂移. 派生值应该在渲染期直接计算.

## Fiber: 可中断的渲染

### 工作单元与链表化树

朴素的协调是递归同步遍历: 一旦开始就必须走完, 中途无法把主线程让给别人. 组件树很大时, 主线程会被长时间占用, 动画掉帧, 输入无响应.

Fiber 的核心改动是把递归换成循环, 把树结构补上父指针与兄弟指针, 从而可以在任意节点之间停下来再继续:

```typescript
interface FiberNode {
  tag: WorkTag; // 组件类型: 函数组件、类组件、宿主节点等
  type: unknown; // 组件函数 / 类 / DOM 标签名
  key: string | null;
  stateNode: unknown; // 对应的 DOM 节点或类实例

  return: FiberNode | null; // 父节点
  child: FiberNode | null; // 第一个子节点
  sibling: FiberNode | null; // 下一个兄弟节点
  alternate: FiberNode | null; // 双缓冲中的对应节点

  pendingProps: unknown;
  memoizedProps: unknown;
  memoizedState: unknown; // 函数组件中是 Hooks 链表头
  updateQueue: unknown;

  flags: number; // 本节点需要做的变更
  subtreeFlags: number; // 子树变更的聚合, 用于提前剪枝
  deletions: FiberNode[] | null;
  lanes: number; // 本节点上的待处理优先级
  childLanes: number; // 子树上的待处理优先级
}
```

遍历顺序是深度优先: 有子节点就往下, 没有就找兄弟, 都没有就沿 `return` 回溯. `subtreeFlags` 与 `childLanes` 是两处关键剪枝——如果某棵子树没有任何待处理变更或没有任何待处理优先级, React 可以整棵跳过, 连组件函数都不调用. 后续小节讲的重渲染优化, 最终都要落到这两个字段上.

### 让出主线程

每处理完一个 Fiber 节点就是一个工作单元, 处理完检查是否该把主线程还回去:

```javascript
function workLoopConcurrent() {
  while (workInProgress !== null && !shouldYieldToHost()) {
    workInProgress = performUnitOfWork(workInProgress);
  }
}
```

`shouldYieldToHost` 依据时间片预算判断. 让出后, 调度器先处理浏览器需要做的事 (绘制、输入), 之后再回到这个循环继续. 因为工作单元之间没有递归栈依赖, 恢复时只需要从 `workInProgress` 继续, 不需要从头再来.

这也是为什么函数组件不能是 generator 或 async: 中断点由 React 在 Fiber 层面管理, 而不是由语言层面的协程管理.

### Lanes 优先级模型

每次更新都会被分配到一个优先级 (lane), 记录在触发更新的 Fiber 及其祖先链上. 渲染时 React 挑选当前最高优先级的 lane 集合, 只渲染携带这些 lane 的子树.

优先级从高到低大致是:

- 同步更新, 例如离散的用户输入与 `flushSync` 包裹的更新, 不可被打断.
- 连续交互, 例如拖拽、滚动这类持续产生的输入.
- 普通默认更新, 例如一般的 `setState`.
- transition 更新, 由 `startTransition` / `useTransition` / Actions 标记, 可被上面几类打断.
- 空闲与离屏更新, 优先级最低, 在有空闲时处理.

优先级不是"任务队列顺序", 而是可以同时存在于同一棵树上的一组位. 高优先级更新打断了低优先级渲染时, 已经完成的低优先级工作并不会全部作废: 未被影响的子树可以直接复用.

### 优先级模型的边界

调度是协作式的, 不改变 JavaScript 单线程的事实. 它优化的是"让主线程及时响应", 不是"让计算更快". 一个单次渲染就耗掉上百毫秒的组件, 即使标记为 transition, 每个工作单元本身仍然要跑完才能让出; 这种情况下真正有效的做法是拆分组件、减少单位工作量或虚拟化列表.

## 协调与 Diff

### 三个启发式前提

精确计算两棵树的最小编辑距离是 O(n³), 对上千节点的界面不可用. React 用三条假设把它降到接近 O(n):

| 前提               | 含义                                                             | 代价                         |
| ------------------ | ---------------------------------------------------------------- | ---------------------------- |
| 类型不同则结构不同 | 旧节点与新节点类型 (或组件引用) 不同时, 直接销毁整棵旧子树并新建 | 类型变化无法复用任何下层节点 |
| 同级比较           | 只在同一层级内比较, 不跨层移动节点                               | 位置变化被当作删除加新建     |
| key 标识身份       | 同层节点用 key 判断是否为同一个逻辑节点                          | key 使用不当会导致状态错配   |

这三条假设是整个协调算法的契约. 违反它们不会报错, 只会让 React 做出代价更高或语义错误的选择.

### 单节点与多节点流程

单节点更新的判定很短: key 不同或类型不同就重建, 都相同就复用 DOM 节点并只更新属性.

列表类更新走两轮:

1. 第一轮从左到右逐个对比, 遇到不可复用的节点就停下.
2. 第二轮把剩余的旧节点放进以 key 为索引的映射, 再遍历剩余的新节点, 命中可复用节点时根据其原位置是否在"已处理的最右位置"之后决定是否需要移动.

移动的判定依赖一个记录遍历过程中已见最大旧索引的变量: 如果当前可复用节点的旧索引更小, 说明它相对前面的节点向后移动了, 需要打上插入标记.

### key 的语义

key 只需要在同一层级的兄弟之间唯一, 作用是让 React 在两次渲染之间认出"这还是同一个逻辑节点". 认出之后的直接后果是: 该节点的 DOM、state、ref 都会被保留, 只更新变化的属性.

这也解释了为什么 key 变化等价于"卸载旧的并挂载新的": 输入框会失焦、滚动位置会重置、动画会重启、子组件 effect 会重新执行. 有时这正是想要的效果——用 key 强制重置一个复杂组件的心态或内部状态, 是比写重置逻辑更简洁的手段.

### index 作为 key 的代价

在列表头部插入元素时, 用下标作 key 会让每个已有元素的 key 都平移一位:

```jsx
// 旧列表 [A, B, C] 的 key 是 0,1,2
// 新列表 [X, A, B, C] 的 key 变成 0,1,2,3
// React 看到的是: key 0 从 A 变成 X, key 1 从 B 变成 A, ...
// 于是三次更新一次新增, 而不是一次新增
```

即使列表项是纯展示组件, 这次插入也会造成多余的属性更新; 如果列表项内部有未受控的输入或状态, 还会串位. 正确做法是用数据本身的稳定 id. 只有在列表只增删尾部、且元素没有内部状态时, 下标才勉强可用.

## Hooks 的实现原理与规则

### 链表与游标

函数组件没有实例对象来挂载状态, React 把状态放在 Fiber 节点的 `memoizedState` 上, 组织成一条单向链表. 每个 Hook 对应一个链表节点, 保存自己的状态值与更新队列:

```text
Fiber.memoizedState ─> Hook#0 ─> Hook#1 ─> Hook#2 ─> null
                        useState  useEffect  useMemo
```

渲染过程中 React 用一个游标按顺序在这条链表上移动. 挂载时, 每次调用 Hook 都在链表尾部追加一个节点; 更新时, 每次调用 Hook 都从 current 树上取出对应位置的节点并前进游标. 同一个 Hook 的"身份"不是名字, 也不是调用者给的对象, 而是它在链表中的位置.

### 顺序必须稳定的原因

既然身份是位置, 那么两次渲染之间的调用顺序必须完全一致. 条件调用会破坏这个前提:

```jsx
function Bad({ flag }) {
  const [name, setName] = useState(""); // 位置 0
  if (flag) {
    const [age, setAge] = useState(0); // 位置 1, 有时不存在
  }
  const [color, setColor] = useState(""); // flag 为真时是位置 2, 否则是位置 1
}
```

`flag` 从真变假后, 原本属于 `age` 的位置 1 被 `color` 取走, `setColor` 会去写 `age` 的数据. 状态发生错位是静默的, 不会抛错, 只会产生难以定位的异常行为.

由此得到两条规则: Hooks 只在组件或自定义 Hook 的顶层调用; 不在条件、循环、嵌套函数或提前 return 之后调用. 自定义 Hook 之所以可以复用, 是因为它最终会被内联展开到调用方函数的同一层, 链表顺序在展开后依然固定.

### 为什么不用名字或 key 标识

- 性能: 顺序访问是常数开销, 引入名称查找会让每次 Hook 调用多一次映射查询.
- API 体感: 不需要用户为每个 Hook 起唯一名字, 减少心智负担和命名冲突.
- 静态可检查: 规则简单到可以在编码期由 lint 规则直接判定, 不必等到运行时.

最后一点很关键: 顺序约束之所以能被普遍遵守, 是因为它可以在写代码时被自动检查, 而不是靠运行时兜底.

### React Compiler 与规则的关系

React Compiler 在编译期分析组件的依赖关系, 自动插入记忆化, 让大部分手写的 `useMemo`、`useCallback`、`memo` 变得不必要. 它并没有放宽 Hooks 的调用规则: 编译器同样以"调用顺序稳定、组件是纯函数"为前提做分析, 底层链表结构与游标机制没有改变. 编译期规则诊断由配套的 ESLint 预设提供, 运行时支持通过 `react/compiler-runtime` 子路径暴露.

这意味着编译器解决的是组件级重复计算, 不解决架构层面的问题: 请求瀑布、代码分割、服务端缓存、错误的状态划分, 仍然需要人来设计.

## 状态更新与批处理

### 更新队列与函数式更新

每次 `setState` 都是把一条更新记录追加到该 Hook 的更新队列, 而不是立即修改变量. 更新记录里保存的可能是新值, 也可能是一个函数.

- 传新值时, 队列里的记录是"把状态设为这个值".
- 传函数时, 队列里的记录是"对这个函数应用当前状态".

React 在 Render 阶段按顺序执行队列中的记录, 计算最终状态. 这就是函数式更新不受闭包影响的原理: 函数在计算时才拿到当时的最新状态, 而不是在事件处理器创建时就把值定死.

```jsx
// 直接赋值: 两次都是基于同一个旧值, 结果只加 1
setCount(count + 1);
setCount(count + 1);

// 函数式更新: 队列依次应用, 结果加 2
setCount((c) => c + 1);
setCount((c) => c + 1);
```

### 自动批处理

同一轮同步执行中触发的多次状态更新, 会被合并进同一个渲染周期. 这一点与调用点无关: 事件处理器、`setTimeout` 回调、Promise 回调、原生事件监听器中的更新都会被批处理.

批处理发生在调度层. 每次更新只是改变 Fiber 上的 lanes 并请求调度; 调度器发现已经有同优先级任务在排队时不会重复调度, 于是多次入队最终只对应一次渲染.

需要注意, 批处理合并的是"渲染次数", 不是"状态变更次数". 更新队列里的每一条记录都会执行. 因此两个函数式更新叠加会得到加 2 的结果, 而两个基于同一旧值的直接赋值只会得到加 1.

### flushSync 与退出批处理

当确实需要"更新后立刻读取 DOM"时, 可以用 `flushSync` 把包裹的更新立即提交:

```jsx
import { flushSync } from "react-dom";

flushSync(() => setCount((c) => c + 1));
// 到这里 DOM 已经更新
```

代价是放弃了这一轮批处理, 每次调用都会同步走完 Render 与 Commit. 在事件处理器中大量使用会让调度退化为同步渲染. 更常见的正确做法是把"读取 DOM"挪进 layout effect, 而不是用 `flushSync` 强行同步.

### 更新不改变闭包

一个反复出现的误解是"调用了 setState, 后面的代码就能看到新值". 不会. 本次渲染作用域中的变量在生命周期内是常量, 状态更新只是排入队列, 新值出现在下一次渲染的函数调用中. 事件处理器里 `console.log(count)` 打印的永远是本次渲染的值.

## 并发特性

### 协作式调度

并发渲染不是多线程, 而是单线程内的协作式调度: 把渲染拆成工作单元, 每个单元结束后检查是否需要让出, 高优先级更新可以打断低优先级渲染, 被打断的渲染可以稍后恢复或直接丢弃.

它带来的用户可见收益是: 紧急更新 (输入、悬停、点击反馈) 可以插队到非紧急更新 (筛选长列表、切换 Tab 内容) 之前, 界面保持响应.

### useTransition 与 useDeferredValue

两者都建立在 transition 优先级之上, 区别在于控制点: 一个控制更新的产生端, 一个控制更新的消费端.

| 维度     | useTransition                              | useDeferredValue                           |
| -------- | ------------------------------------------ | ------------------------------------------ |
| 控制点   | 你调用 setState 的地方                     | 你读取值的地方                             |
| 返回值   | `[isPending, startTransition]`             | 延迟后的值                                 |
| 前提     | 能改写产生更新的代码                       | 值的来源可能不受控制, 例如来自 props       |
| 典型用法 | 搜索框即时显示输入, 结果列表按低优先级更新 | 大列表按输入过滤, 列表暂时落后于输入框     |
| 额外能力 | 提供 pending 状态, 可据此显示加载指示      | 可比较延迟值与当前值, 判断是否处于过期状态 |

`useDeferredValue` 还有一个常被忽略的参数形式: 可以传入初始值, 让子树在首次渲染时使用一个便宜的占位内容, 之后再用真实值渲染.

### Suspense 的语义

Suspense 是一个"承诺边界": 被它包住的子树如果读到了尚未就绪的异步资源 (实现上是抛出 Promise), React 就会暂停这棵子树, 显示最近的 fallback, 等资源就绪后重新渲染.

在并发模式下, 是否替换已显示内容取决于这次更新是否被标记为 transition:

- 被 transition 标记的更新会保持旧 UI 可见, 直到新内容就绪, 避免 fallback 一闪而过.
- 紧急更新 (初始挂载、普通 setState) 会立即显示 fallback.

流式服务端渲染也建立在同一套语义上: 服务端先发出外层 shell 与 fallback, 数据就绪后再把对应片段补发到同一个 HTML 流中.

### Activity

`Activity` 用 `mode="visible" | "hidden"` 控制子树:

- hidden 时 DOM 与状态被保留, effect 被清理 (相当于"隐藏但不卸载").
- 回到 visible 时恢复显示并重新执行 effect.

它适合频繁切换、但重建代价高的界面: Tab 面板、下拉内容、模态框. 用条件渲染实现同样效果时会丢失内部状态与滚动位置, 用 CSS 隐藏又会保留不必要的订阅与计时器; Activity 把两者折中为"保留状态、停掉副作用".

## React 19 的 Actions 与新增 API

### Actions 模型

处理一次异步提交, 通常要手动维护 pending、error、乐观值几套状态. Actions 把"提交一个异步操作"变成一等概念: 传给表单 `action` 或事件处理器的异步函数就是一个 Action, React 跟踪它的生命周期 (进行中、成功、失败), 并在需要时自动以 transition 优先级执行其中的更新.

Action 内部的更新默认可被打断, 因此界面在提交过程中仍然响应输入. 这与手动 `setIsLoading` 加 `await` 的写法相比, 少了一套容易出错的并行状态.

### 三个配套 Hook

| API              | 导入来源    | 职责                                           | 关键规则                                                                         |
| ---------------- | ----------- | ---------------------------------------------- | -------------------------------------------------------------------------------- |
| `useActionState` | `react`     | 管理 Action 的返回值、dispatch 与 pending 标志 | 接收 `(action, initialState, permalink?)`, 返回 `[state, formAction, isPending]` |
| `useFormStatus`  | `react-dom` | 在子组件中读取父级表单的提交状态               | 必须在 `<form>` 的子组件内调用, 不通过 props 传递 pending                        |
| `useOptimistic`  | `react`     | 在等待服务端确认期间展示乐观值, 失败后自动回滚 | 乐观值只在该 Action 的 pending 期间有效                                          |

```jsx
import { useActionState } from "react";
import { useFormStatus } from "react-dom";

function SubmitButton() {
  const { pending } = useFormStatus();
  return <button disabled={pending}>更新</button>;
}

function UpdateName({ updateName }) {
  const [state, formAction, isPending] = useActionState(updateName, null);
  return (
    <form action={formAction}>
      <input name="name" />
      <SubmitButton />
      {state?.error && <p>{state.error}</p>}
    </form>
  );
}
```

`useActionState` 的第三个参数用于渐进增强: 在 JavaScript 尚未加载时, 表单提交会先导航到该 permalink 对应的页面, 由服务端处理.

`useOptimistic` 的第二个参数是一个归约函数, 描述"把一条待确认的操作叠加到当前列表上"的规则; 一旦 Action 结束 (无论成功还是失败), React 会丢掉乐观层, 回到真实数据上重新渲染.

### use

`use` 用于在渲染期读取一个 Promise 或 Context:

```jsx
function Comments({ commentsPromise }) {
  const comments = use(commentsPromise);
  return comments.map((c) => <p key={c.id}>{c.text}</p>);
}
```

它与其他 Hook 有几处本质区别:

- 它是唯一允许在条件分支与循环中调用的 Hook; 但仍必须在组件或自定义 Hook 中调用, 不能放进 `try`/`catch`, 也不能在事件处理器或类组件中调用.
- 读取 Promise 时, 未就绪会挂起最近的 Suspense 边界; 读取 Context 时等价于 `useContext`.
- 传入的 Promise 必须来自组件外部 (上层组件创建后传入或由服务端创建). 在渲染函数里新建 Promise, 每次渲染都是新引用, 会不断挂起, 永远无法完成.

`react-dom` 还导出一个 `browser()` 资源函数, 配合 `use` 使用可以让子树退出服务端渲染: 服务端渲染时触发最近的 fallback, 客户端水合后不再挂起, 组件正常渲染. 它遵循 `use` 的调用规则.

### ref 作为 prop 与清理函数

React 19 起, 函数组件可以直接从 props 接收 `ref`, 不必再用 `forwardRef` 包一层. 类型层面只需在 props 类型里声明该字段:

```tsx
interface FieldProps {
  label: string;
  ref?: React.Ref<HTMLInputElement>;
}

function Field({ label, ref }: FieldProps) {
  return (
    <label>
      {label}
      <input ref={ref} />
    </label>
  );
}
```

函数组件不再需要 `forwardRef` 包装: 通过 props 传递 ref, 少一层包装组件.

ref 回调用法的另一处变化是允许返回清理函数:

```jsx
<div
  ref={(node) => {
    if (!node) return;
    subscribe(node);
    return () => unsubscribe(node);
  }}
/>
```

节点从 `null` 变为元素、或从元素变回 `null` 时都会调用回调. 返回清理函数后, React 会在"需要断开上一次绑定"时调用它, 而不需要开发者自己维护"上一次的节点"这类记录.

### 其他稳定能力

- `useEffectEvent`: 把"读取最新 props/state 但不应成为依赖"的回调从 effect 中抽离, 是闭包陷阱的官方解法. 返回的函数只能在 effect 内调用, 不写进依赖数组.
- `<ViewTransition>`: 包裹需要动画的子树, 在被 transition 标记的更新引起挂载、卸载或样式变化时, 借助浏览器 View Transition API 播放对应动画. 默认交叉淡入淡出, 可通过类名或 `onEnter`/`onExit`/`onShare`/`onUpdate` 定制. 配合 `addTransitionType` 可以为同一次状态更新附加原因标记, 从而按方向或语义播放不同动画. 目前仅支持 DOM 平台.
- Fragment ref: 给 `<Fragment ref={...}>` 传入 ref 会得到一个 Fragment 实例, 可以成组地操作该 Fragment 的一级子 DOM 而不改变结构. 能力包括事件订阅与派发、`focus`/`focusLast`/`blur`、对接 IntersectionObserver 与 ResizeObserver 的 `observeUsing`/`unobserveUsing`, 以及 `getClientRects`、`getRootNode`、`scrollIntoView`. 适合需要"把一组兄弟节点当成一个整体"处理焦点或观察尺寸的场景.
- 服务端组件中直接渲染 Context Provider: 从客户端模块导入的 Context 可以在服务端组件里直接作为 Provider 使用, 不必再额外导出一个只做包装的客户端组件.

## 错误边界与错误处理

### 类组件错误边界

React 中没有 Hook 版的错误边界, 捕获子树渲染错误的能力由类组件的两个方法提供, 二者至少要实现一个:

```jsx
class Boundary extends React.Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    reportToMonitoring(error, info.componentStack);
  }

  render() {
    if (this.state.error) return <Fallback />;
    return this.props.children;
  }
}
```

`getDerivedStateFromError` 在 Render 阶段调用, 用于把错误转成状态并渲染兜底 UI, 因此必须是纯函数; `componentDidCatch` 在 Commit 阶段调用, 适合上报日志这类副作用.

错误边界能捕获的范围有明确边界: 它捕获的是子组件渲染、生命周期与构造函数中抛出的错误. 事件处理器中的错误、异步回调中的错误、服务端渲染中的错误、错误边界自身抛出的错误都不在捕获范围内. 异步流程需要自己用 try/catch 或 Promise 的 catch 处理.

### 与 Suspense 的配合

Suspense 处理的是"还没准备好", 错误边界处理的是"出错了", 两者职责不同但常常相邻放置: 用错误边界包住 Suspense, 就能同时给出加载态和失败态. 服务端渲染时, 错误边界还能让某个片段失败后不影响页面其余部分, 只是该片段降级为兜底 UI.

## 性能优化与常见误区

### 记忆化的有效条件

`memo` 默认用 `Object.is` 逐字段浅比较 props. 基本类型比较值, 对象、数组、函数比较引用. 因此记忆化要生效, 需要同时满足几个条件:

| 条件                 | 说明                                                      |
| -------------------- | --------------------------------------------------------- |
| 组件是纯的           | 相同 props 必须渲染出相同结果, 否则跳过渲染会掩盖逻辑错误 |
| props 引用稳定       | 传给它的对象、数组、函数不能每次渲染都新建                |
| 比较成本低于渲染成本 | 组件的渲染必须足够贵, 否则浅比较本身就是净开销            |
| 上游确实会频繁重渲染 | 如果父组件很少重渲染, 记忆化几乎没有收益                  |

这解释了一个常见现象: 加了 `memo` 却没有效果, 通常是因为某个内联箭头函数或对象字面量每次都产生新引用, 浅比较直接失败. 正确顺序是先保证引用稳定 (`useCallback`、`useMemo`, 或把值提到组件外部), 再谈 `memo`.

`useMemo` 与 `useCallback` 本身也有成本: 它们要保存依赖并做比较. 对 `a || b` 这类计算, 缓存反而是负优化. 它们的主要价值在于给下游的 `memo` 子组件或 Hook 依赖提供稳定引用, 以及缓存真正昂贵的计算.

### 派生状态

能从现有 props 与 state 计算出来的值, 不应该再单独存一份 state. 重复存储会带来两个问题: 首次渲染后到 effect 执行前存在一个不一致的中间状态, 以及需要额外的 effect 与渲染轮次去同步.

正确做法是在渲染期直接计算, 需要缓存时用 `useMemo`. 只有当"用户修改后应当覆盖派生结果"时, 才值得把值提升为状态.

### 常见误区清单

| 现象                 | 根因                                      | 修正                              |
| -------------------- | ----------------------------------------- | --------------------------------- |
| 回调读到旧值         | 回调捕获了某次渲染的快照                  | 函数式更新、ref、`useEffectEvent` |
| memo 失效            | props 中有每次新建的引用                  | 稳定引用或自定义比较函数          |
| 输入框失焦、动画重启 | 组件在父组件内部定义, 每次渲染都是新类型  | 把组件提到模块顶层                |
| 列表状态错位         | 用下标或随机数作 key                      | 使用稳定 id                       |
| 无意义的额外渲染     | 用 effect 同步派生状态                    | 渲染期直接计算                    |
| 渲染出 `0`           | `count && <X />` 在 count 为 0 时渲染数字 | 改成显式布尔判断                  |
| effect 无限循环      | 依赖里放了每次新建的对象或数组            | 依赖收敛到基本类型或稳定引用      |
| 订阅与计时器泄漏     | 没有在清理函数中断开                      | 每个 effect 返回对应的清理逻辑    |

### 度量

优化前先定位. React DevTools 的 Profiler 能记录每次渲染的耗时与触发原因, 组件面板中的高亮显示可以直观看出哪些组件在无谓地重渲染. `Profiler` 组件则以编程方式收集同一条数据, 适合接入自定义埋点:

```jsx
<Profiler
  id="App"
  onRender={(id, phase, actualDuration, baseDuration) => {
    record(id, phase, actualDuration, baseDuration);
  }}
>
  <App />
</Profiler>
```

`actualDuration` 是本次渲染实际耗时, `baseDuration` 是不做任何记忆化时的估算值, 两者差距就是记忆化省下的工作.

## 适用场景与选型建议

这些机制知识的直接用途有三类.

第一类是排错. 闭包旧值、memo 失效、状态错位、水合不匹配这几类问题, 表面症状彼此相似, 只有理解渲染快照、引用比较与 Hooks 链表, 才能快速定位到真正的原因, 而不是靠试错改依赖数组.

第二类是取舍. 并发特性、`memo`、`useDeferredValue` 都不是默认应该施加的优化:

| 需求                   | 优先考虑                              | 不建议                         |
| ---------------------- | ------------------------------------- | ------------------------------ |
| 输入框与重结果列表联动 | `useDeferredValue` 或 `useTransition` | 在输入处理器里同步计算全部结果 |
| 长列表渲染             | 虚拟化、内容可见性优化                | 只加 `memo` 而不减少节点数量   |
| 昂贵计算的重复执行     | `useMemo`                             | 对廉价计算也缓存               |
| 深层组件共享低频配置   | Context                               | 用 Context 承载高频变化的值    |
| 服务端数据             | 专用的数据获取库                      | 手工在 effect 里管理缓存与失效 |

第三类是边界判断. 当组件单次渲染本身就超过一帧预算时, 调度层面的优先级无法救场, 需要从数据结构和组件拆分入手; 当状态复杂到需要跨组件协调时, 引入状态管理库通常比继续叠加 Context 更划算. 相关实践见 [TanStack Query](tanstack) 与 [Next.js](next).

需要说明的一点: 本页描述的优先级档位、让出策略属于调度模型的定性说明. 具体的 lane 划分与时间片预算是实现细节, 会随版本调整, 不应作为业务代码的依赖前提.
