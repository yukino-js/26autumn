---
title: "generic-pool 源码解析: Promise 化通用资源池的借还、排队与空闲驱逐机制"
description: "基于本机克隆 $HOME/Downloads/node-pool (npm 包 generic-pool 3.9.0, HEAD ee5db9d) 的源码级解析: acquire/release/destroy 生命周期、工厂契约、Deferred 超时排队、双向链表 Deque 与 PriorityQueue、DefaultEvictor 空闲回收与配置默认值逐项考据"
---

> 本机器路径: `$HOME/Downloads/node-pool`

generic-pool 是一个零运行时依赖的 Node.js 通用资源池库, README (第 7 行) 对定位的自述是 "Generic resource pool with Promise based API. Can be used to reuse or throttle usage of expensive resources such as database connections." — 即对数据库连接这类昂贵资源做复用与限流。本文基于本机克隆的完整源码整理: lib/ 下 18 个文件共 1604 行, 其中 Pool.js 一个文件 744 行, 占近一半; 所有结论均标注文件路径与行号, 可直接跳转核对。

## 一、项目快照

本机克隆 HEAD 为 ee5db9d (完整哈希 ee5db9ddb54ce3a142fde3500116b393d4f2f755, 提交于 2022-10-02, 内容是合并 PR #301 补充 TypeScript 类型)。`git describe --tags` 输出 v3.9.0-3-gee5db9d, 即 HEAD 在 v3.9.0 标签之后 3 个提交, 仓库内最新 tag 仍是 v3.9.0。

| 指标          | 数值 (出处)                                                           |
| ------------- | --------------------------------------------------------------------- |
| npm 包名      | generic-pool (package.json name)                                      |
| 描述          | "Generic resource pooling for Node.JS" (package.json description)     |
| 版本          | 3.9.0 (package.json version; CHANGELOG 标注发布于 2022-09-10)         |
| HEAD          | ee5db9d, 2022-10-02, 合并 regevbr/types 的 PR #301                    |
| 上游仓库      | coopernurse/node-pool (package.json repository), 作者 James Cooper    |
| License       | MIT (package.json license; README 版权行 2010-2016)                   |
| Node 版本要求 | engines 字段 `node >= 4` (package.json:283-285)                       |
| 运行时依赖    | 无, package.json 只有 devDependencies                                 |
| 入口与发布物  | main 为 index.js; files 字段只发布 index.d.ts、index.js、lib 三项     |
| 类型定义      | index.d.ts, 头注释说明派生自 DefinitelyTyped 的 generic-pool 类型     |
| 测试          | tap ^8.0.0, `npm test` 即 `tap test/*-test.js` (package.json scripts) |
| Lint          | eslint ^4.9.0 + prettier ^1.7.4 (README:381 亦有说明)                 |
| 关键词        | pool / pooling / throttle (package.json keywords)                     |

当前源码中恰好有两处定时器 `.unref()` 调用点: `_applyDestroyTimeout` 的销毁超时 race (Pool.js:157) 与驱逐调度定时器 (Pool.js:405)。两者都不会阻止 Node 进程退出; 后者是周期性定时器, 这一点直接决定了即使把 `evictionRunIntervalMillis` 设成非 0, 空闲驱逐器也不会挂住事件循环。

lib/ 目录 18 个文件与职责 (行数为 `wc -l` 实测):

| 文件                            | 行数 | 职责                                        |
| ------------------------------- | ---- | ------------------------------------------- |
| lib/Pool.js                     | 744  | 池主体: 借还、创建销毁、驱逐调度、计数      |
| lib/PoolOptions.js              | 109  | 用户选项归一化                              |
| lib/PoolDefaults.js             | 34   | 默认值集中定义                              |
| lib/Deque.js                    | 106  | 双向链表实现的双端队列, 存放空闲资源        |
| lib/DoublyLinkedListIterator.js | 100  | 可删除当前节点的链表游标迭代器              |
| lib/DoublyLinkedList.js         | 94   | 双向链表, 注释自称 Wikipedia 版本的 JS 移植 |
| lib/ResourceRequest.js          | 76   | 等待中的 acquire 请求, 带超时               |
| lib/PriorityQueue.js            | 69   | 按优先级分槽的请求队列                      |
| lib/PooledResource.js           | 49   | 资源包装: 状态机与四个时间戳                |
| lib/Deferred.js                 | 49   | 类 jQuery Deferred 的 Promise 包装          |
| lib/Queue.js                    | 35   | 单个优先级槽的队列, 兼管超时自动出队        |
| lib/ResourceLoan.js             | 29   | 借据: 只能 resolve 的 Deferred              |
| lib/errors.js                   | 27   | ExtendableError 与 TimeoutError             |
| lib/DefaultEvictor.js           | 23   | 默认驱逐策略: 只比较空闲时长                |
| lib/DequeIterator.js            | 20   | Deque 迭代器, 解包链表节点                  |
| lib/factoryValidator.js         | 16   | 工厂对象形状校验                            |
| lib/utils.js                    | 13   | reflector: 吞掉结果的等待工具               |
| lib/PooledResourceStateEnum.js  | 11   | 资源状态枚举                                |

## 二、总体架构: 构造函数注入的组装式内核

模块入口 index.js 只有 13 行, 它揭示了整个库的组装方式 — 驱逐策略与两个队列数据结构不是 Pool 内部写死的, 而是构造函数参数:

```js
const Pool = require("./lib/Pool");
const Deque = require("./lib/Deque");
const PriorityQueue = require("./lib/PriorityQueue");
const DefaultEvictor = require("./lib/DefaultEvictor");
module.exports = {
  Pool: Pool,
  Deque: Deque,
  PriorityQueue: PriorityQueue,
  DefaultEvictor: DefaultEvictor,
  createPool: function (factory, config) {
    return new Pool(DefaultEvictor, Deque, PriorityQueue, factory, config);
  },
};
```

Pool 的构造签名是 `constructor(Evictor, Deque, PriorityQueue, factory, options)` (Pool.js:44)。index.d.ts 相应地定义了 IEvictor、IDeque、IPriorityQueue 三个接口, 说明类型层面也允许替换实现。README:95 建议用户始终通过 createPool 建池而不是直接 new Pool, 理由是构造签名未来可能变化。

Pool 内部的记账结构在构造函数中一次性建齐 (Pool.js:49-124):

| 字段                      | 类型              | 用途                                        | 行号 |
| ------------------------- | ----------------- | ------------------------------------------- | ---- |
| _config                   | PoolOptions       | 归一化后的配置                              | 49   |
| _waitingClientsQueue      | PriorityQueue     | 等待资源的请求队列, 槽数取 priorityRange    | 61   |
| _factoryCreateOperations  | Set               | 进行中的 factory.create Promise             | 67   |
| _factoryDestroyOperations | Set               | 进行中的 factory.destroy Promise            | 73   |
| _availableObjects         | Deque             | 空闲资源双端队列                            | 80   |
| _testOnBorrowResources    | Set               | 正在做借出校验的资源                        | 86   |
| _testOnReturnResources    | Set               | 预留的归还校验集合, 实际永远为空 (见第四节) | 92   |
| _validationOperations     | Set               | 进行中的 validate Promise                   | 98   |
| _allObjects               | Set               | 全部未销毁的 PooledResource                 | 104  |
| _resourceLoans            | Map               | 借出资源对象到 ResourceLoan 借据的映射      | 110  |
| _evictionIterator         | DequeIterator     | 在空闲队列上循环游走的驱逐游标              | 116  |
| _evictor                  | Evictor 实例      | 驱逐策略对象                                | 118  |
| _scheduledEviction        | timer 句柄或 null | 下一轮驱逐的 setTimeout 句柄                | 124  |

数据流概览:

```text
   acquire(priority)
        |
        v
  +------------------------------+  派发并登记借据    +-----------+
  | _waitingClientsQueue         |----------------->| 用户代码  |
  | PriorityQueue(ResourceRequest)|  resolve(obj)    +-----------+
  +------------------------------+                        |
        ^                                          release / destroy
        |  _dispense 驱动派发                             |
  +------------------------------+                        v
  | _availableObjects (Deque)    |<-----------------------+
  | 空闲 PooledResource          |   idle 后重新入队
  +------------------------------+
        ^               |
        |               | _evict 周期扫描, evictor 判定超时
  +------------------------------+
  | factory.create/destroy/      |
  | validate (三个 Set 跟踪在途)  |
  +------------------------------+
```

Pool 继承 EventEmitter (Pool.js:24), 对外只发两种事件, 事件名常量定义在 Pool.js:21-22: factoryCreateError 与 factoryDestroyError。

## 三、工厂对象契约

Pool 构造函数第一件事就是调用 factoryValidator(factory) (Pool.js:47)。校验逻辑在 lib/factoryValidator.js: create 与 destroy 必须是函数, validate 可以缺省, 但若给出则必须是函数, 否则同步抛 TypeError。

| 方法     | 必需 | 调用点                        | 期望返回                      | 失败后果                                                                  |
| -------- | ---- | ----------------------------- | ----------------------------- | ------------------------------------------------------------------------- |
| create   | 是   | _createResource (Pool.js:319) | Promise, resolve 出新资源对象 | reject 时 emit factoryCreateError, 并重新触发 _dispense (Pool.js:336-339) |
| destroy  | 是   | _destroy (Pool.js:137)        | Promise, resolve 表示销毁完成 | reject 或超时 emit factoryDestroyError (Pool.js:142-147)                  |
| validate | 否   | _testOnBorrow (Pool.js:175)   | Promise, resolve 布尔值       | resolve 为 false 时 invalidate 并销毁该资源 (Pool.js:184-188)             |

三个方法的返回值都会被 `this._Promise.resolve(...)` 包一层 (Pool.js:139、176、320-321), 因此工厂返回同步值或任意 thenable 都可以, README:121 也明确写了这一点。

一个值得记录的代码事实: `factory.validate` 在整个 lib/ 中只有 _testOnBorrow 一处调用 (Pool.js:175)。也就是说 validate 只服务于借出校验 (testOnBorrow), 归还路径与驱逐路径都不会调用它 — 驱逐器只按空闲时长判断, 不做连通性探活 (详见第四、九节)。

## 四、PooledResource 与五状态生命周期

lib/PooledResourceStateEnum.js 定义了五个状态, 源码注释即为语义:

| 状态       | 源码注释                            | 含义                 |
| ---------- | ----------------------------------- | -------------------- |
| ALLOCATED  | In use                              | 已借出               |
| IDLE       | In the queue, not in use            | 在空闲队列中         |
| INVALID    | Failed validation                   | 校验失败或已进入销毁 |
| RETURNING  | Resource is in process of returning | 归还处理中           |
| VALIDATION | Currently being tested              | 正在做借出校验       |

PooledResource (lib/PooledResource.js) 是资源对象的包装, 持有 obj 本体、state 与四个 Date.now() 时间戳: creationTime (构造时写入)、lastBorrowTime、lastReturnTime、lastIdleTime。新建资源的初始状态是 IDLE (PooledResource.js:16)。状态迁移方法及其在 Pool.js 中的调用点:

| 方法         | 状态迁移          | 刷新时间戳     | Pool.js 调用点                      |
| ------------ | ----------------- | -------------- | ----------------------------------- |
| allocate()   | 迁移到 ALLOCATED  | lastBorrowTime | 287 (派发给等待者时)                |
| deallocate() | 迁移到 IDLE       | lastReturnTime | 526 (release)、556 (destroy)        |
| invalidate() | 迁移到 INVALID    | 无             | 134 (_destroy 开头)、185 (校验失败) |
| test()       | 迁移到 VALIDATION | 无             | 173 (_testOnBorrow)                 |
| idle()       | 迁移到 IDLE       | lastIdleTime   | 564 (进入空闲队列时)                |
| returning()  | 迁移到 RETURNING  | 无             | 无任何调用点                        |

两处与直觉不符、但经全仓 grep 核实的代码事实:

1. RETURNING 状态与 returning() 方法在 lib/ 与 test/ 中均无调用点, 属于预留的死代码。
2. testOnReturn 选项有默认值 (PoolDefaults.js:13)、有解析逻辑 (PoolOptions.js:63-66)、Pool 里也预留了 _testOnReturnResources 集合并把它计入潜在可分配资源数 (Pool.js:92、668), 但 release() 路径 (Pool.js:512-531) 从不调用 validate, 该集合永远是空的。结论: v3.9.0 中 testOnReturn 是被接受但无实际行为的选项。

因此资源真实经历的状态只有四个: IDLE、VALIDATION (仅 testOnBorrow 开启时)、ALLOCATED、INVALID (销毁前瞬间)。

## 五、acquire 借出全流程

acquire(priority) 的入口逻辑 (Pool.js:440-471) 按顺序做五件事:

1. 若池未启动且 autostart 为 false, 先调用 start() 懒启动 (Pool.js:441-443)。
2. 若池处于 draining 状态, 直接返回 rejected Promise, 错误文本 "pool is draining and cannot accept work" (Pool.js:445-449)。
3. 快速拒绝检查 (Pool.js:452-461): 仅当四个条件同时成立 — `spareResourceCapacity < 1`、available 队列为空、配置了 maxWaitingClients、等待队列长度已达上限 — 才 reject "max waitingClients count exceeded"。换言之 maxWaitingClients 是池饱和时才生效的上限; 只要还有空闲或可创建容量, 请求依然会入队。特别地, 配置 `maxWaitingClients: 0` 即得到 "饱和即失败" 的快速失败语义。
4. 构造 ResourceRequest (携带 acquireTimeoutMillis) 并按 priority 入 _waitingClientsQueue (Pool.js:463-467)。
5. 调用 _dispense() 尝试立即满足请求, 然后返回 resourceRequest.promise (Pool.js:468-470)。

priority 参数的 JSDoc (Pool.js:433-436) 说明: 取 0 到 priorityRange - 1 之间的整数, 数字越小优先级越高, 缺省为 0。这里有一个 README 与代码不一致的点: README:288 的示例注释声称不带 priority 的 acquire() 会进入最低优先级队列, 但按 PriorityQueue.enqueue 的归一化逻辑 (PriorityQueue.js:30), undefined 会被折算为 0, 与 acquire(0) 进同一个最高优先级槽。以代码为准: 缺省 priority 等于最高优先级 0。

### _dispense: 唯一的补给调度点

_dispense (Pool.js:216-265) 是创建与派发的总调度, 核心计算如下:

```js
const resourceShortfall =
  numWaitingClients - this._potentiallyAllocableResourceCount;

const actualNumberOfResourcesToCreate = Math.min(
  this.spareResourceCapacity,
  resourceShortfall,
);
for (let i = 0; actualNumberOfResourcesToCreate > i; i++) {
  this._createResource();
}
```

流程分解:

1. 等待数为 0 直接短路返回 (Pool.js:221-227)。
2. 计算缺口 resourceShortfall = 等待请求数 - 潜在可分配资源数, 再与剩余容量取 min, 循环调用 _createResource (Pool.js:229-238)。
3. 若 testOnBorrow 开启, 把至多 "等待数减去已在测数" 个空闲资源搬进校验流程 _testOnBorrow (Pool.js:242-253)。
4. 若 testOnBorrow 关闭, 直接派发 min(空闲数, 等待数) 个资源 (Pool.js:256-264)。

三个计数口径 (Pool.js:664-693) 是理解容量行为的关键:

| 计数                               | 公式                                                       | 语义                                                                                 |
| ---------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| _potentiallyAllocableResourceCount | `available + testOnBorrow 中 + testOnReturn 中 + 创建在途` | 未来可能满足请求的资源数, 防止重复创建 (JSDoc 自嘲 "the name is awful", Pool.js:661) |
| _count (即 size)                   | `_allObjects.size + _factoryCreateOperations.size`         | 已存在加创建在途, 不含销毁在途 (Pool.js:680-682)                                     |
| spareResourceCapacity              | `max - _count`                                             | 距上限还能创建多少 (Pool.js:688-693)                                                 |

### _createResource: 创建不直发

_createResource (Pool.js:317-340) 调用 factory.create() 并用 Promise.resolve 包装; 成功后 new PooledResource、加入 _allObjects、经 _addPooledResourceToAvailableObjects 进入空闲队列 (Pool.js:322-326); 整个过程由 _trackOperation 把 Promise 挂入/移出 _factoryCreateOperations 集合 (Pool.js:299-312)。无论成功失败都会再次触发 _dispense (Pool.js:330、338), 失败时额外 emit factoryCreateError。

关键设计: 新建资源不直接交给某个等待者, 而是先进空闲队列, 由重新触发的 _dispense 统一再分配。这样 testOnBorrow 校验、fifo 顺序、优先级出队全部收敛到同一个出口 _dispatchPooledResourceToNextWaitingClient。

### 派发出口与竞态兜底

_dispatchPooledResourceToNextWaitingClient (Pool.js:273-290) 从优先级队列 dequeue 一个请求; 若队列为空或请求已不是 PENDING 状态 (等待期间超时了), 就把资源放回空闲队列 (Pool.js:275-283); 否则创建 ResourceLoan 借据、登记进 _resourceLoans、调用 allocate() 并 resolve 请求, 用户拿到的就是裸资源对象 pooledResource.obj (Pool.js:285-288)。这是 "请求超时自动出队" (第七节 Queue) 之外的第二道竞态兜底。

testOnBorrow 路径 (_testOnBorrow, Pool.js:166-194): 从空闲队列 shift 出资源, 置为 VALIDATION 态并加入 _testOnBorrowResources, 调用 factory.validate; 结果为 false 则 invalidate、_destroy、重新 _dispense; 为 true 则走上述统一派发出口。

## 六、release / destroy / use 归还路径

release(resource) (Pool.js:512-531):

1. 按资源对象查 _resourceLoans 借据, 查不到直接 reject "Resource not currently part of this pool" — 归还非本池借出的对象会被拒绝。
2. 删除借据并 resolve 它 (让 drain 的等待逻辑感知, 见第十一节)。
3. deallocate() 后调用 _addPooledResourceToAvailableObjects 重新入队 (fifo 决定进队尾还是队头), 再触发 _dispense。
4. 返回已 resolve 的 Promise。

destroy(resource) (Pool.js:542-561) 前半段与 release 相同, 区别是第 3 步改调 _destroy(pooledResource), 资源不再回到空闲队列。适用于用户明知资源已损坏 (连接断开、事务污染) 的场景, README:200 亦如此建议。

_destroy (Pool.js:132-151) 的内部顺序值得注意:

1. 先 invalidate() 并从 _allObjects 移除 (Pool.js:134-135) — 计数立即下降, 销毁是否完成不影响容量核算。
2. 调用 factory.destroy(obj); 若配置了 destroyTimeoutMillis, 用 _applyDestroyTimeout 把销毁 Promise 与一个定时器 Promise 做 race, 定时器到期 reject 一个消息为 "destroy timed out" 的 Error, 且定时器带 `.unref()` (Pool.js:153-160)。
3. 销毁 Promise 由 _trackOperation 挂入 _factoryDestroyOperations, 失败 (含超时) 时 emit factoryDestroyError (Pool.js:142-147)。
4. 最后调用 _ensureMinimum() 立即补齐 min 缺口 (Pool.js:150)。

由第 1、4 步可推出一个实际后果: factory.destroy 挂起时, 旧资源已不占池内计数, 新资源又会被立刻补建, 真实世界中的资源总数 (池内加销毁挂起) 可以短暂超过 max。destroyTimeoutMillis 超时也只发事件、不做任何强制清理。

use(fn, priority) (Pool.js:478-491) 是 acquire 加自动归还的便捷封装: fn resolve 则 release, fn reject 则 destroy 资源并继续抛出, 与 README:261 的描述一致。

_ensureMinimum (Pool.js:345-353): 计算 `min - _count` 的缺口并循环 _createResource; draining 状态下直接短路, 不再补池。

## 七、等待的 Promise 化: Deferred 家族

lib/Deferred.js 是整个异步等待体系的基类, 注释自称 "a bit like a Jquery deferred": 构造时创建一个 Promise 并把 resolve/reject 捕获为成员; 状态常量 PENDING、FULFILLED、REJECTED 挂在类上 (Deferred.js:45-47); resolve 与 reject 都带状态守卫, 只有 PENDING 时才生效, 天然幂等 (Deferred.js:27-41)。

三个子类各司其职:

| 类              | 角色              | 关键行为                                                          |
| --------------- | ----------------- | ----------------------------------------------------------------- |
| ResourceRequest | 一次 acquire 等待 | 可超时的 Deferred, 超时 reject TimeoutError                       |
| ResourceLoan    | 一张借据          | reject() 被覆写为空操作, 借据只能 resolve (ResourceLoan.js:22-26) |
| Deferred 本体   | 派发时的状态判据  | Pool.js:277 用 `state !== Deferred.PENDING` 判断请求是否已超时    |

ResourceRequest (lib/ResourceRequest.js) 的超时机制:

1. 构造函数收到 ttl, 仅当 `ttl !== undefined` 才设置定时器 (ResourceRequest.js:27-29)。配合 PoolOptions 只在 truthy 时赋值 acquireTimeoutMillis (PoolOptions.js:73-76), 未配置时该属性是 undefined — 请求永不过时。PoolDefaults 里的 null 是永远传不到这里的死默认值, 源码注释也写着 "FIXME: no defaults!" (PoolDefaults.js:22-25)。
2. setTimeout(delay) 校验 `isNaN(ttl) || ttl <= 0` 时抛 "delay must be a positive int" (ResourceRequest.js:38-40); 定时时长用 `Math.max(ttl - age, 0)` 按请求创建时间校正 (ResourceRequest.js:42-51), 保证重复设置时总等待时间不漂移。
3. 超时触发 _fireTimeout, reject 一个 errors.TimeoutError("ResourceRequest timed out") (ResourceRequest.js:61-63); TimeoutError 继承自库内 ExtendableError, name 取构造函数名 (errors.js:3-22)。
4. resolve 与 reject 都先 removeTimeout 清定时器 (ResourceRequest.js:65-73)。

超时请求如何不残留在队列里? 答案在 lib/Queue.js — PriorityQueue 每个槽用的队列。Queue 继承 Deque, 但完全覆写了 push: 入队时给请求的 promise 挂一个 catch, 一旦拒绝原因的 name 是 "TimeoutError", 就把对应链表节点直接摘除 (Queue.js:20-32)。类头注释也自问 "is this the best place for this?" — 这是超时自动出队的实现点, 与第五节派发时的 PENDING 检查构成双保险。

PriorityQueue (lib/PriorityQueue.js) 本身很薄: 构造时建 `Math.max(+size | 0, 1)` 个 Queue 槽 (至少 1 个, PriorityQueue.js:11); enqueue 的归一化表达式为 `(priority && +priority | 0) || 0`, 越界 (负数或不小于槽数) 一律钳到最后一个槽即最低优先级 (PriorityQueue.js:30-38), 与 README:278 的描述一致; dequeue 从 0 号槽开始找第一个非空槽 shift (PriorityQueue.js:41-48); head 从高优先级向低找, tail 反向从最低优先级槽找 (PriorityQueue.js:50-66)。默认 priorityRange 为 1 时, 整个 PriorityQueue 退化为一条普通 FIFO 队列。

ResourceLoan 的意义在 drain: release/destroy 时 loan.resolve() (Pool.js:523、553), drain 的 __allResourcesReturned 正是等待所有借据 Promise 落定 (Pool.js:601-606)。借据 "只能 resolve" 的约束保证了这个等待永远不会因拒绝而中断。

## 八、容量控制与底层数据结构

### max 与 min 的归一化

PoolOptions.js:88-94 对两者先 parseInt 再夹逼:

```js
this.max = Math.max(isNaN(this.max) ? 1 : this.max, 1);
this.min = Math.min(isNaN(this.min) ? 0 : this.min, this.max);
```

即: max 缺省 1、下限 1; min 缺省 0、超过 max 时被静默钳到 max — 与 README:127-128 的文档行为一致 ("If this is set >= max, the pool will silently set the min to equal max")。min 的维持由 _ensureMinimum 负责, 触发点在 start() 与每次 _destroy 之后 (Pool.js:150、425)。

### fifo 决定空闲队列是队列还是栈

归还/新建资源入队走 _addPooledResourceToAvailableObjects (Pool.js:563-570): 先 idle() 刷新 lastIdleTime, 然后 fifo 为 true 时 push 到队尾, 为 false 时 unshift 到队头; 借出侧永远从队头 shift (Pool.js:171、205)。因此:

| fifo        | 行为                   | 效果                                                        |
| ----------- | ---------------------- | ----------------------------------------------------------- |
| true (默认) | 归还进队尾, 借出取队头 | FIFO, 最老的资源最先被复用, 各资源使用均匀                  |
| false       | 归还进队头, 借出取队头 | LIFO 栈, 最近归还的资源最先被再次借出, 冷资源沉底等着被驱逐 |

README:133 的表述与此吻合: fifo 为 false 时 "turns the pool's behaviour from a queue into a stack"。对数据库连接池场景, LIFO 让热连接持续复用、冷连接自然超时被驱逐, 是常见取向 (见第十四节)。

### DoublyLinkedList 与 Deque

DoublyLinkedList (lib/DoublyLinkedList.js) 注释自称是 Wikipedia 双向链表条目的直接 JS 移植: 节点是含 prev、next、data 三个字段的普通对象, 由静态方法 createNode 生成 (DoublyLinkedList.js:85-91); insertBeginning、insertEnd、insertAfter、insertBefore、remove 维护 head、tail、length, 全部是 O(1) 指针操作 (DoublyLinkedList.js:24-82)。remove 会把被摘除节点的 prev/next 置 null — 这个细节被迭代器用作 "脱离检测" 的依据。

Deque (lib/Deque.js) 在链表上包出双端队列: shift、unshift、push、pop、head、tail、length, 以及 iterator、reverseIterator 和 Symbol.iterator 三种迭代入口 (Deque.js:18-103)。空闲资源队列 _availableObjects 就是一个 Deque。

DoublyLinkedListIterator (lib/DoublyLinkedListIterator.js) 是驱逐器的基础设施, 类头注释描述得很精确: 首次 next 之前游标跟踪 head (或 reverse 时的 tail), 因此可以先在空链表上创建迭代器、后加元素再迭代; next 返回标准迭代器结果对象; reset() 回卷游标重新开始; remove() 摘除当前游标节点 (DoublyLinkedListIterator.js:51-60); _isCursorDetached 以 "prev/next 均为 null 且不是 head/tail" 启发式判断节点已脱离链表 (DoublyLinkedListIterator.js:90-97), 注释也承认把节点从一个链表挪到另一个链表可以骗过它。DequeIterator 只是把 next 结果里的节点解包成 node.data 的薄包装 (DequeIterator.js:8-17)。

Pool 构造时就创建了 _evictionIterator 并在整个生命周期复用 (Pool.js:116), 依靠 reset 实现 "无限循环游走"。

## 九、空闲回收与 DefaultEvictor

### 调度

驱逐器默认不运行。start() 调用 _scheduleEvictorRun (Pool.js:424、398-407): 仅当 `evictionRunIntervalMillis > 0` 时注册 setTimeout, 回调里先 _evict() 再递归调用 _scheduleEvictorRun 排下一轮; 定时器带 `.unref()`, 不会阻止进程退出。drain() 完成时 _descheduleEvictorRun 清掉定时器 (Pool.js:409-414、587)。

### _evict 主循环

_evict (Pool.js:355-396) 每轮至多检查 `min(numTestsPerEvictionRun, 空闲数)` 个资源, README:270 解释了这个上限的动机: 防止池很大时一次检查阻塞应用。循环体用 _evictionIterator.next() 游走:

1. done 且空闲队列已空: reset 游标并返回 (Pool.js:370-373, 注释说明这是防止死循环的安全检查)。
2. done 但队列非空: reset 游标后 continue, 即从头再走 (Pool.js:376-379)。
3. 对每个资源调用 `evictor.evict(evictionConfig, resource, availableObjects.length)`, evictionConfig 只装三个字段: softIdleTimeoutMillis、idleTimeoutMillis、min (Pool.js:360-364)。
4. 判定为 true 则 iterator.remove() 摘除节点并 _destroy(resource) (Pool.js:390-394)。

一个由代码推得的细节: DoublyLinkedList.remove 会把被摘节点的 next 置 null, 因此 remove 之后迭代器的下一次 next 会推进到 null、判定 done 并 reset — 同一轮驱逐中每摘除一个资源, 扫描就从队头重新开始, 但 testsHaveRun 计数保留, 不会突破每轮检查上限。

### DefaultEvictor 判定逻辑

lib/DefaultEvictor.js 全文 23 行, evict 方法核心:

```js
evict(config, pooledResource, availableObjectsCount) {
  const idleTime = Date.now() - pooledResource.lastIdleTime;

  if (
    config.softIdleTimeoutMillis > 0 &&
    config.softIdleTimeoutMillis < idleTime &&
    config.min < availableObjectsCount
  ) {
    return true;
  }

  if (config.idleTimeoutMillis < idleTime) {
    return true;
  }

  return false;
}
```

| 条件                                                                           | 结果 | 语义                                             |
| ------------------------------------------------------------------------------ | ---- | ------------------------------------------------ |
| `softIdleTimeoutMillis > 0` 且空闲时长超过它, 且 `min < availableObjectsCount` | 驱逐 | 软超时: 只收缩超出 min 的富余空闲资源            |
| 空闲时长超过 idleTimeoutMillis                                                 | 驱逐 | 硬超时: 无视 min, 一律可驱逐                     |
| 其余                                                                           | 保留 | 默认 softIdleTimeoutMillis 为 -1, 软超时永不生效 |

空闲时长的基准是 lastIdleTime, 它在资源进入空闲队列时由 idle() 刷新 (PooledResource.js:39-42, Pool.js:564) — 即 "最后一次变为空闲" 的时刻, 而不是最后一次归还时刻 (两者在 release 路径上几乎同时, 但新建资源从未借出也有 lastIdleTime)。

硬超时与 min 的交互会产生 churn: idleTimeoutMillis 路径驱逐时不看 min, 而 _destroy 末尾的 _ensureMinimum (Pool.js:150) 又会立刻把池补回 min — 若 min 大于 0 且空闲超时较短, 池内连接会周期性地销毁重建。README:306-317 关于 "进程退出前卡 30 秒" 的 draining 章节描述的正是驱逐器与 min 共同作用下的定时器滞留问题 (当前 HEAD 中驱逐定时器与销毁定时器均已 unref, 周期性定时器不再挂住事件循环)。

## 十、配置项与默认值逐项考据

PoolDefaults.js 集中声明默认值, PoolOptions.js 负责归一化。两者的关系有一个陷阱: PoolDefaults 中 acquireTimeoutMillis、destroyTimeoutMillis、maxWaitingClients 三项的 null 上方写着注释 "FIXME: no defaults!", 而 PoolOptions 对这三项根本不做 falsy 回退 — 未配置时属性保持 undefined, PoolDefaults 的 null 是死值。

| 选项                      | PoolDefaults | 实际生效默认 | 归一化方式 (PoolOptions.js)             | 备注                                                                   |
| ------------------------- | ------------ | ------------ | --------------------------------------- | ---------------------------------------------------------------------- |
| max                       | null         | 1            | parseInt 后 `Math.max(x, 1)` (89, 93)   | 下限 1                                                                 |
| min                       | null         | 0            | parseInt 后 `Math.min(x, max)` (91, 94) | 超 max 被钳到 max                                                      |
| fifo                      | true         | true         | typeof 布尔检查 (56)                    | false 即 LIFO 栈                                                       |
| priorityRange             | 1            | 1            | falsy 回退 (57)                         | PriorityQueue 内部再保底 1 个槽                                        |
| testOnBorrow              | false        | false        | typeof 布尔检查 (59-62)                 | 需要 factory.validate                                                  |
| testOnReturn              | false        | false        | typeof 布尔检查 (63-66)                 | 已解析但归还路径无实现 (第四节)                                        |
| autostart                 | true         | true         | typeof 布尔检查 (68-71)                 | false 时由 start() 或首次 acquire 启动                                 |
| evictionRunIntervalMillis | 0            | 0            | falsy 回退 (96-97)                      | 不大于 0 则驱逐器关闭                                                  |
| numTestsPerEvictionRun    | 3            | 3            | falsy 回退 (98-99)                      | 传 0 会被吞回 3                                                        |
| softIdleTimeoutMillis     | -1           | -1           | falsy 回退 (100-101)                    | 传 0 会变回 -1; -1 表示软超时禁用                                      |
| idleTimeoutMillis         | 30000        | 30000        | falsy 回退 (102-103)                    | 传 0 会变回 30000                                                      |
| acquireTimeoutMillis      | null         | undefined    | truthy 才 parseInt (73-76)              | 未配置即永不超时                                                       |
| destroyTimeoutMillis      | null         | undefined    | truthy 才 parseInt (78-81)              | 未配置即销毁不做超时 race                                              |
| maxWaitingClients         | null         | undefined    | 不为 undefined 才 parseInt (83-86)      | 未配置即等待队列无上限; 0 表示饱和即拒绝                               |
| Promise                   | 全局 Promise | 全局 Promise | 非 null 即用 opts.Promise (105)         | 可注入 bluebird 等, Pool.js:331-333 的注释还留着对 bluebird 警告的规避 |

两类归一化陷阱值得单独强调:

1. falsy 吞噬。evictionRunIntervalMillis、numTestsPerEvictionRun、softIdleTimeoutMillis、idleTimeoutMillis 四项用 `opts.x || defaults.x` 回退 (PoolOptions.js:96-103), 显式传 0 不会生效: numTestsPerEvictionRun 传 0 变 3, softIdleTimeoutMillis 传 0 变 -1, idleTimeoutMillis 传 0 变 30000。布尔项因为用 typeof 检查, 传 false 是安全的。
2. 非法超时的两种表现。acquireTimeoutMillis 传负数能通过 PoolOptions 的 truthy 检查, 但会在第一次 acquire 构造 ResourceRequest 时同步抛出 "delay must be a positive int" (ResourceRequest.js:38-40, Pool.js:463-466) — 注意是同步 throw 而非 rejected Promise。destroyTimeoutMillis 传负数则表现为 setTimeout 收到负延时, 立即触发超时 race。

## 十一、start / ready / drain / clear 生命周期管理

start() (Pool.js:416-426) 有三个触发点: 构造时 autostart 为 true (Pool.js:127-129); autostart 为 false 时首次 acquire 懒启动 (Pool.js:441-443); 用户显式调用。方法内先做 draining 与已启动双重守卫, 然后只做两件事: 调度驱逐器、_ensureMinimum 预建 min 个资源。

ready() (Pool.js:644-656) 以 100ms 间隔轮询 `available >= min`, 达标即 resolve。它没有超时上限, 若 min 个资源始终建不出来 (例如工厂一直失败) 会永远轮询; 轮询定时器也未 unref。

drain() (Pool.js:580-589) 是优雅停机入口, 置 _draining 为 true 后按序等待:

1. __allResourceRequestsSettled (Pool.js:591-598): 取 _waitingClientsQueue.tail 的 promise 用 reflector 等待。tail 是最低优先级槽的最后一个请求 (PriorityQueue.js:59-66); 源码 FIXME 注释自己承认, 若请求乱序 settle, 等 tail 不严格等价于等全部 — 这是已知的近似实现。
2. __allResourcesReturned (Pool.js:601-606): 收集所有借据的 promise 做 Promise.all, 上方注释自嘲 "this is a horrific mess"。借据只能 resolve (第七节), 所以这一步必然落定。
3. 最后 _descheduleEvictorRun 停掉驱逐定时器 (Pool.js:587)。

drain 之后: acquire 一律 reject (Pool.js:445-449), _ensureMinimum 不再补池 (Pool.js:346-348)。

clear() (Pool.js:619-636) 强制销毁全部空闲资源, 分三步: 先等所有在途 factory.create 落定 — 防止 clear 在池生命早期调用时 "漏掉" 刚发起的创建 (回归测试即 test/GH-159-test.js, 其工厂类模拟一半创建带延时的情形); 然后遍历 _availableObjects 逐个 _destroy; 最后等全部销毁操作落定。clear 不回收仍被借出的资源, 也不阻止后续 acquire; Pool.js:613-617 的 JSDoc 特别提醒: min 大于 0 且未 draining 时, clear 掉的空闲资源会被立刻补建, 想真正清空应先把 min 置 0 — README:325-332 推荐的停机组合是 drain 后再 clear。

lib/utils.js 的 reflector 是 drain/clear 的粘合剂: `promise.then(noop, noop)`, 把任意 Promise 变成 "只表示完成、不携带值也不会拒绝" 的等待对象 (utils.js:11-13)。

## 十二、可观测性: 计数属性与事件

Pool 暴露的只读属性全部是即时计算的 getter:

| 属性                  | 实现                        | 含义                              | 行号    |
| --------------------- | --------------------------- | --------------------------------- | ------- |
| size                  | _count                      | 池内资源加创建在途 (不含销毁在途) | 699-701 |
| available             | _availableObjects.length    | 空闲数                            | 707-709 |
| borrowed              | _resourceLoans.size         | 已借出数                          | 715-717 |
| pending               | _waitingClientsQueue.length | 等待中的 acquire 数               | 723-725 |
| spareResourceCapacity | `max - _count`              | 剩余可创建容量                    | 688-693 |
| max / min             | 配置值                      | 上下限                            | 731-741 |

isBorrowedResource(resource) (Pool.js:502-504) 即 `_resourceLoans.has(resource)`, 同步返回布尔值, 用于判断某对象是否正处于从本池借出的状态。README:342-370 的 "Pool info" 一节列举的就是这批属性。

事件只有两个, 均定义于 Pool.js:21-22:

| 事件                | 触发点      | 说明                                                 |
| ------------------- | ----------- | ---------------------------------------------------- |
| factoryCreateError  | Pool.js:337 | factory.create 的 Promise 被拒绝时                   |
| factoryDestroyError | Pool.js:146 | factory.destroy 被拒绝或 destroyTimeoutMillis 超时时 |

README:222-226 提醒: 这两个事件没有监听器时错误会被静默丢弃 (EventEmitter 对非 error 命名事件的行为), 生产环境应当挂监听做日志或告警。

## 十三、类型定义与测试工程

index.d.ts 头三行注明其派生自 DefinitelyTyped 的 generic-pool 类型 (标注对应 node-pool 3.1)。类型面的要点: `Pool<T>` 继承 EventEmitter; `Factory<T>` 接口要求 create 与 destroy, validate 可选; Options 接口列出 13 个可配置项 (未收录 testOnReturn 与 Promise); IEvictor、IDeque、IPriorityQueue 三个接口与构造函数注入的参数一一对应; PooledResourceStateEnum 以字符串枚举导出。

test/ 目录 8 个文件, 跑在 tap 上:

| 文件                                | 主题                                                    |
| ----------------------------------- | ------------------------------------------------------- |
| generic-pool-test.js                | 主战场, README:377 说多数用例是从旧 espresso 测试移植的 |
| generic-pool-acquiretimeout-test.js | acquire 超时行为                                        |
| generic-pool-destroytimeout-test.js | destroyTimeoutMillis 行为                               |
| GH-159-test.js                      | clear() 早期调用漏销毁的回归 (fix #159)                 |
| resource-request-test.js            | ResourceRequest 定时器语义                              |
| doubly-linked-list-test.js          | 链表操作                                                |
| doubly-linked-list-iterator-test.js | 迭代器游标/删除/脱离语义                                |
| utils.js                            | 测试辅助, 提供 ResourceFactory                          |

工程面小结: 零运行时依赖加 `node >= 4` 的 engines 声明意味着库只用了 ES6 类与原生 Promise 这一层语言特性; 代码风格由 eslint 加 prettier 约束; npm 发布物只含 index.js、index.d.ts 与 lib/。

## 十四、与中间件连接池场景的对应

generic-pool 常被用作 pg、mysql、redis 等客户端之上的池化层。把库内机制与成熟连接池 (如 Java 侧 HikariCP、Druid) 的常见概念对齐, 有助于选型与配置 (对应关系为语义类比, 非代码事实):

| generic-pool 机制                         | 连接池场景对应物                                 |
| ----------------------------------------- | ------------------------------------------------ |
| max / min                                 | 最大连接数 / 最小空闲连接数                      |
| acquire 加 acquireTimeoutMillis           | getConnection 及其获取超时                       |
| maxWaitingClients                         | 等待队列上限, 饱和快速失败 (传 0 即不排队)       |
| testOnBorrow 加 factory.validate          | 借出探活, validate 内可做 PING 或 SELECT 1       |
| fifo 为 false (LIFO)                      | 优先复用最近归还的热连接, 冷连接沉底待驱逐       |
| evictionRunIntervalMillis                 | 空闲回收线程的巡检周期                           |
| idleTimeoutMillis / softIdleTimeoutMillis | 空闲连接强制回收阈值 / 保留 min 的柔性回收阈值   |
| numTestsPerEvictionRun                    | 单轮巡检的连接数上限, 防阻塞                     |
| drain 加 clear                            | 优雅停机: 停止接客、等在途归还、销毁全部空闲连接 |
| use(fn)                                   | withConnection 风格的回调式使用, 失败自动销毁    |
| factoryCreateError / factoryDestroyError  | 建连失败、断连关闭失败的监控埋点                 |
| opts.Promise                              | 注入 bluebird 等库以统一 Promise 语义            |

一个按数据库场景组织的示例 (工厂为虚构驱动, 结构仿 README:34-55):

```js
const genericPool = require("generic-pool");

const pool = genericPool.createPool(
  {
    create: () => DbDriver.createClient(),
    destroy: (client) => client.disconnect(),
    validate: (client) =>
      client.ping().then(
        () => true,
        () => false,
      ),
  },
  {
    max: 10,
    min: 2,
    testOnBorrow: true,
    acquireTimeoutMillis: 5000,
    maxWaitingClients: 100,
    evictionRunIntervalMillis: 10000,
    numTestsPerEvictionRun: 5,
    idleTimeoutMillis: 30000,
    fifo: false,
  },
);

pool.on("factoryCreateError", (err) => logger.warn(err));
pool.on("factoryDestroyError", (err) => logger.warn(err));
```

结合源码, 在该场景下需要留意的边界 (均为前文各节代码事实的汇总):

1. 没有后台探活。驱逐器只比较时间戳 (DefaultEvictor.js:4-20), validate 只在 testOnBorrow 借出时调用; 空闲连接中途断掉不会被主动发现, 要么开 testOnBorrow 承受借出延迟, 要么接受拿到坏连接后走 destroy 路径。
2. testOnReturn 选项无效 (第四节), 归还校验需要在业务代码里自行完成。
3. 计数与队列的正确性完全建立在 Node 单线程事件循环上, 库内没有任何锁或原子操作; 多进程/多线程部署时每个进程需各自建池, max 是单池上限而非全局上限。
4. factory.destroy 挂起会触发 "计数已减、实物未亡、min 立即补建" 的窗口 (第六节), 对句柄数敏感的资源应配置 destroyTimeoutMillis 并监听 factoryDestroyError。
5. 超时请求自动出队依赖 Queue 的 catch 钩子与派发时的 PENDING 检查双保险 (第七、五节), 用户不需要也无法取消一个已发出的 acquire, 只能靠 acquireTimeoutMillis 让它自行失败。

## 附: 本文事实核验清单

- HEAD 与版本: `git -C $HOME/Downloads/node-pool log -1` 输出 ee5db9d (2022-10-02), `git describe --tags` 输出 v3.9.0-3-gee5db9d; package.json version 为 3.9.0。
- 行数: lib/ 18 个文件 `wc -l` 合计 1604 行, Pool.js 744 行。
- 死代码结论 (RETURNING、testOnReturn、PoolDefaults 三个 null) 均由全仓 grep 核验调用点后得出。
- README 与代码不一致处 (acquire 缺省优先级) 以 PriorityQueue.js:30 的归一化代码为准。
