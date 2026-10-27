---
title: "generic-pool：Promise 化通用资源池的源码级解析"
description: "从资源池要解决的竞态出发，逐层拆解 generic-pool 的借还生命周期、工厂契约、超时排队、双向链表与优先级队列、空闲驱逐、配置默认值与停机语义，并给出连接池场景的实践建议"
local_path: "$HOME/Downloads/node-pool"
---

本文以 generic-pool 3.9.0 的源码为准，面向需要在 Node.js 中复用数据库连接、HTTP 客户端、浏览器实例等昂贵资源，并希望真正理解池内部行为的工程师。全文从“资源池要解决什么竞态”讲起，逐层展开借出、归还、销毁、排队、超时、驱逐与停机机制，并指出若干容易被文档表述或直觉误导的边界。读者只需要熟悉 Promise 与 Node 事件循环，不需要预先了解该库的内部实现。

## 一、资源池要解决的问题与竞态模型

资源池要同时满足两个看似矛盾的诉求：**复用**，避免频繁创建销毁昂贵资源；**限流**，限制同时被占用的资源数量。串行场景下两件事都很简单，困难全部来自并发：

- 多个调用方同时申请而可用资源不足，必须排队；排队期间有人超时退出，队列要保持正确。
- 资源创建是异步的，创建在途的资源也算潜在供给，否则会重复创建、冲破上限。
- 归还与销毁交错：归还时资源可能已损坏，销毁时可能还有等待者。
- 池可以动态扩容到上限，也可以收缩到下限，扩容与收缩的触发点分散在多处。

在 Node.js 里，所有这些操作都跑在单线程事件循环上，因此库内没有任何锁或原子操作；并发安全来自两点：对共享计数与队列的修改都在同步执行的函数体内完成，异步回调只负责恢复调度。理解这一点非常重要——它解释了为什么库中没有互斥锁，也解释了为什么“池的大小上限只对单个进程生效”：多进程部署时每个进程各有一个池。

库用一组内部计数定义容量语义，这是后续所有机制的公共语言（对应 `Pool.js` 中的三个 getter）：

| 计数                                 | 口径                                                             | 语义                                         |
| ------------------------------------ | ---------------------------------------------------------------- | -------------------------------------------- |
| `_potentiallyAllocableResourceCount` | 空闲数 + 借出校验中的资源 + 归还校验中的资源 + 创建在途数        | 未来可能满足请求的资源总量，用于防止重复创建 |
| `size`（内部 `_count`）              | 全量资源集合 `_allObjects` + 创建在途 `_factoryCreateOperations` | 已存在的资源数，不含销毁在途                 |
| `spareResourceCapacity`              | `max` 减去池大小                                                 | 还能创建多少个资源                           |

其中“归还校验中的资源”一项（`_testOnReturnResources`）在当前实现里恒为零，原因见第四节。

## 二、组装式内核：数据结构与驱逐策略都是注入的

模块入口 `index.js` 只暴露一个工厂函数 `createPool` 和四个类，它把默认的驱逐策略、空闲队列和优先级队列组装进池对象：

```js
// index.js 的实际导出
module.exports = {
  Pool,
  Deque,
  PriorityQueue,
  DefaultEvictor,
  createPool(factory, config) {
    return new Pool(DefaultEvictor, Deque, PriorityQueue, factory, config);
  },
};
// Pool 的构造签名：Evictor, Deque, PriorityQueue, factory, options
```

也就是说，池主体不依赖具体的数据结构，而是依赖三个可替换的契约：

| 接口       | 需要提供的能力                                 | 默认实现                         |
| ---------- | ---------------------------------------------- | -------------------------------- |
| 驱逐策略   | 依据配置、资源包装与当前空闲数同步返回是否驱逐 | `DefaultEvictor`，只比较空闲时长 |
| 空闲队列   | 双端插入删除、访问首尾、长度、可迭代           | `Deque`，双向链表实现的双端队列  |
| 优先级队列 | 入队、出队、访问首尾、长度                     | `PriorityQueue`，按优先级分槽    |

这种设计的收益是：驱逐策略可以替换成自定义实现（例如带连通性探活的策略），队列结构可以替换成别的实现。由于四个符号都直接导出，完全可以绕过工厂函数自行组装：`new Pool(MyEvictor, MyDeque, MyPriorityQueue, factory, config)`；`index.d.ts` 中的 `IEvictor`、`IDeque`、`IPriorityQueue` 接口就是这三份契约的类型化描述。代价是构造函数参数顺序属于内部约定，替换任何一个依赖都要自己保证契约一致；日常使用仍推荐 `createPool`。

自定义驱逐策略最有价值的场景是引入探活：默认策略只看时间戳，可以在自定义实现里对空闲较久的资源先做一次廉价连通性检查再决定是否淘汰。注意策略的 `evict` 方法必须**同步**返回布尔值（不能返回 Promise），因此探活只能基于已有状态或异步预取的结果。替换队列的收益较小，且有一个隐藏契约：默认的等待队列（`Queue`）在入队时会直接读取被入队对象的 `promise` 属性并挂拒绝钩子，因此任何自定义优先级队列都必须容纳“带 `promise` 的请求对象”，不能把元素当成不透明数据处理。

池主体在构造时一次性建立全部记账结构，之后只修改不重建：

| 结构                        | 用途                                                         |
| --------------------------- | ------------------------------------------------------------ |
| `_waitingClientsQueue`      | 按优先级分槽的 acquire 请求队列，槽数由 `priorityRange` 决定 |
| `_factoryCreateOperations`  | 进行中的创建 Promise，参与容量与潜在供给计算                 |
| `_factoryDestroyOperations` | 进行中的销毁 Promise，用于停机时等待                         |
| `_availableObjects`         | 双端队列，存放当前空闲可借的资源                             |
| `_testOnBorrowResources`    | 正在做借出校验的资源                                         |
| `_testOnReturnResources`    | 预留给归还校验的集合，当前实现永远为空                       |
| `_validationOperations`     | 进行中的校验 Promise                                         |
| `_allObjects`               | 所有未销毁的资源包装对象                                     |
| `_resourceLoans`            | 借出资源对象到借据的映射，用于校验归还合法性                 |
| `_evictionIterator`         | 在空闲队列上循环游走的迭代器                                 |
| `_evictor`                  | 注入的驱逐策略实例                                           |
| `_scheduledEviction`        | 下一轮驱逐的定时器句柄                                       |

数据流可以概括为：acquire 进入等待队列，调度函数 `_dispense` 按缺口创建资源或派发空闲资源；资源归还后回到空闲队列并再次触发调度；驱逐器周期性扫描空闲队列，把超时资源销毁。

```text
  acquire(priority)
        |
        v
  +------------------------------+   派发并登记借据   +-----------+
  | 等待队列 (优先级队列)         |----------------->| 用户代码  |
  +------------------------------+   resolve(obj)   +-----------+
        ^                                            |
        |  调度函数驱动派发                            |
  +------------------------------+   归还 / 销毁       |
  | 空闲队列 (双端队列)           |<-------------------+
  +------------------------------+
        ^            |
        |            | 驱逐器周期扫描，判定超时后销毁
  +------------------------------+
  | 工厂的 create/destroy/validate |
  | 三个集合跟踪在途操作           |
  +------------------------------+
```

池主体继承 `EventEmitter`，只对外发送两种事件：`factoryCreateError` 与 `factoryDestroyError`。这两个事件名都不叫 `error`，因此没有监听器时错误会被静默丢弃——生产环境必须显式挂监听（详见第十二节）。

## 三、工厂契约与参数校验

池在构造时首先通过 `factoryValidator` 校验工厂对象的形状：

| 方法     | 是否必需 | 期望返回                      | 失败后果                                       |
| -------- | -------- | ----------------------------- | ---------------------------------------------- |
| create   | 是       | Promise，resolve 出新资源     | reject 时发送 `factoryCreateError`，并重新调度 |
| destroy  | 是       | Promise，resolve 表示销毁完成 | reject 或超时发送 `factoryDestroyError`        |
| validate | 否       | Promise，resolve 为布尔值     | 仅当严格 resolve 为 `false` 时把资源作废并销毁 |

校验规则很严格：`create` 与 `destroy` 必须是函数，否则构造函数同步抛出 TypeError；`validate` 可以不传，但传了就必须是函数。三个方法的返回值都会被 `this._Promise.resolve(...)` 统一包一层，因此工厂返回同步值或任意 thenable 也可以，不必严格返回原生 Promise。

校验失败的判定是与 `false` 的**严格相等**（`isValid === false`）：校验 Promise resolve 为 `undefined`、`null`、`0` 等任何非 `false` 的值都按校验通过处理，因此校验函数必须保证失败分支显式 resolve `false`。

有一个容易忽视的代码事实：`validate` 在整个实现里只有借出校验（`_testOnBorrow`）一处调用。也就是说，validate 只服务于“借出前的探活”，归还路径与驱逐路径都不会调用它。这直接决定了两条边界：归还时资源是否健康不由池负责判断，驱逐器也不会在淘汰前做连通性探测。若业务需要“脏资源不入池”，必须在归还前的业务代码里自行校验并改走 `pool.destroy` 路径。

反过来，**开启 `testOnBorrow` 却不提供 `validate`，是一种会静默损坏池的误用**。借出校验路径直接调用 `this._factory.validate(pooledResource.obj)` 而不做存在性检查，缺失时抛出 TypeError。在最常见的“首个请求触发创建”的流程里，这个错误发生在创建完成后的 `.then` 回调中，会被创建失败分支接住并以 `factoryCreateError` 事件发出（事件内容正是 `this._factory.validate is not a function`）；若调用 acquire 时恰好已有空闲资源，则同一个 TypeError 会从 acquire 同步抛出。两种入口的后果相同且更麻烦：此时资源已经从空闲队列移出并登记进 `_testOnBorrowResources`，异常打断了后续处理，这个包装对象会永久滞留在借出校验集合中——它既不在空闲队列、也没有借据，却仍被计入潜在可分配数与池大小，等于永久占掉一个名额；对应的申请则永远挂在等待队列里。实际表现是“池明明没满，`acquire` 却再也不返回”，而唯一的线索是一个很容易被忽略的事件。结论是 `testOnBorrow: true` 与 `factory.validate` 必须成对出现。

## 四、资源包装与状态机

池不直接持有工厂返回的对象，而是用 `PooledResource` 包装记录状态与时间戳。状态枚举 `PooledResourceStateEnum` 有五个取值，但并非都真正被使用：

| 状态       | 含义                 | 是否实际出现           |
| ---------- | -------------------- | ---------------------- |
| IDLE       | 空闲，在队列中       | 是                     |
| ALLOCATED  | 已借出               | 是                     |
| VALIDATION | 正在做借出校验       | 是，仅在开启借出校验时 |
| INVALID    | 校验失败或已进入销毁 | 是，销毁前的瞬间       |
| RETURNING  | 归还处理中           | 否，预留状态           |

包装对象持有资源本体 `obj`、状态 `state` 以及四个时间戳：`creationTime` 在构造时写入，`lastBorrowTime`、`lastReturnTime`、`lastIdleTime` 初始为 `null`，由对应的状态迁移方法刷新。新建资源的初始状态是 IDLE。

迁移方法及其触发时机：

| 方法       | 迁移到     | 刷新时间戳     | 触发时机             |
| ---------- | ---------- | -------------- | -------------------- |
| allocate   | ALLOCATED  | lastBorrowTime | 资源派发给等待者时   |
| deallocate | IDLE       | lastReturnTime | 归还或销毁前         |
| invalidate | INVALID    | 无             | 销毁开头、校验失败时 |
| test       | VALIDATION | 无             | 借出校验开始时       |
| idle       | IDLE       | lastIdleTime   | 资源进入空闲队列时   |
| returning  | RETURNING  | 无             | 无任何调用点         |

两处与直觉不符、经全仓检索确认的结论：

1. `returning()` 方法与 RETURNING 状态没有任何调用点，属于预留但未启用的代码。资源真实经历的状态只有四个：空闲、借出校验中、已借出、销毁前。
2. `testOnReturn` 选项有默认值、有解析逻辑，池里也预留了 `_testOnReturnResources` 集合并把它计入潜在可分配数，但归还路径从不调用 `validate`，该集合永远是空的。结论是：归还校验在当前版本中是被接受但没有任何行为的选项，不要依赖它。

`lastIdleTime` 的基准值得单独说明：它在资源进入空闲队列时由 `idle()` 刷新，记录的是“最后一次变为空闲的时刻”，而不是“最后一次归还时刻”。两者在归还路径上几乎同时（`release` 先 `deallocate` 再入队触发 `idle`），但新建资源从未借出也有空闲时间——这决定了驱逐器对新资源同样按空闲时长判断。

## 五、acquire：借出全流程

`acquire(priority)` 按固定顺序做几件事：

1. 若池未启动且关闭了 `autostart`，先懒启动（`start()`）。
2. 若池处于排空状态，直接返回失败的 Promise，提示池正在排空、不再接受工作。
3. 快速失败检查：只有当剩余容量为零、空闲队列为空、配置了 `maxWaitingClients`、且等待队列长度已达到该上限这四个条件**同时成立**，才立即以 `max waitingClients count exceeded` 失败。这意味着等待上限是“池饱和时才生效”的上限；只要还有空闲或可创建的容量，请求依然入队。把等待上限配成 0，就得到“饱和即立即失败、不排队”的语义。
4. 构造 `ResourceRequest`（携带申请超时），按优先级放入等待队列。
5. 触发 `_dispense()` 尝试立即满足请求，然后返回请求的 Promise。

优先级参数取 0 到 `priorityRange - 1` 之间的整数，数值越小优先级越高，缺省为 0。这里有一处 README 与代码不一致需要以代码为准：README 示例声称不传优先级会进入最低优先级队列，但 `PriorityQueue.enqueue` 的归一化逻辑 `(priority && +priority | 0) || 0` 把未定义折算为 0，因此**缺省优先级等于最高优先级**。若确实需要区分优先级，显式传值即可。

### 5.1 调度函数：唯一的补给点

`_dispense` 负责“创建足够的资源”和“派发可用资源”两件事，核心是缺口计算：

```js
const numWaitingClients = this._waitingClientsQueue.length;
if (numWaitingClients < 1) return;

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

缺口等于等待数减去潜在可分配数，再与剩余容量取较小值。潜在可分配数包含创建在途的资源，因此连续多次触发调度不会重复创建；剩余容量保证创建总量不越过上限。创建完成或失败后都会再次触发 `_dispense`，形成“创建 -> 入库 -> 再分配”的闭环。

派发部分分两条路径：若开启了 `testOnBorrow`，调度会把至多“等待数减去已在校验数（`_testOnBorrowResources.size`）”个空闲资源搬进校验流程；若关闭了校验，则直接派发“空闲数与等待数的较小值”个资源。两条路径最终都汇聚到同一个派发出口 `_dispatchPooledResourceToNextWaitingClient`。

### 5.2 创建不直发

一个关键设计是：新建的资源不会直接交给某个等待者，而是先进入空闲队列（`_createResource` 的成功回调里调用 `_addPooledResourceToAvailableObjects`），再由重新触发的调度统一分配。这样借出校验、先进先出顺序、优先级出队全部收敛到同一个出口，避免出现“创建路径绕过队列规则”的漏洞。创建过程由 `_factoryCreateOperations` 集合跟踪，成功与失败都会把 Promise 从集合中移除并重新调度；失败时额外发送 `factoryCreateError` 事件。

### 5.3 派发出口与竞态兜底

派发出口从优先级队列 `dequeue` 取出一个请求，然后判断请求是否仍然有效：

- 队列为空（取出 `undefined`），或取出的请求状态不是 `Deferred.PENDING`（说明它在等待期间已经超时被拒绝），就把资源放回空闲队列，不做派发。
- 否则创建借据 `ResourceLoan`、以裸资源对象为键登记进 `_resourceLoans`、调用 `pooledResource.allocate()`，并 resolve 请求，把裸资源对象交给调用方。

这里的 PENDING 状态检查是超时竞态的第二道兜底：即使超时请求没有及时从队列中摘除，派发时也会发现它已失效并把资源让给下一位。

## 六、release、destroy 与 use：归还路径

`release(resource)` 的流程：

1. 用资源对象查 `_resourceLoans`，查不到就返回失败的 Promise，提示 `Resource not currently part of this pool`。归还一个非本池借出的对象会被拒绝，这是防止串池使用的重要校验。
2. 删除借据并 resolve 它——这一步让停机排空逻辑能够感知“这笔借出已经结束”。
3. `deallocate()` 把资源标记为空闲，再按 FIFO/LIFO 策略放回空闲队列。
4. 触发 `_dispense`，可能立即满足其它等待者，然后返回已 resolve 的 Promise。

`destroy(resource)` 的前半段与归还相同（查借据、删借据、resolve、deallocate），区别是第三步改为执行内部销毁 `_destroy`，资源不再回到空闲队列，随后同样触发 `_dispense`。它适用于调用方明确知道资源已损坏的场景，例如连接已断开或事务状态被污染。内部销毁有几个值得注意的顺序：

1. 先 `invalidate()` 并从 `_allObjects` 中移除。计数立即下降，销毁是否完成不影响容量核算。
2. 调用工厂的 `destroy`；若配置了 `destroyTimeoutMillis`，则把销毁 Promise 与一个定时器 Promise 做 `Promise.race`，定时器到期以 `destroy timed out` 拒绝，且该定时器调用了 `unref`，不阻止进程退出。
3. 销毁 Promise 由 `_factoryDestroyOperations` 集合跟踪，失败（含超时）时发送 `factoryDestroyError` 事件。
4. 最后调用 `_ensureMinimum()` 立即补齐下限缺口。

由第 1 步与第 4 步可以推出一个实际后果：当工厂的销毁一直挂起时，旧资源已经不再计入池内大小，而新资源又会被立即补建，真实世界的资源总数（池内 + 销毁挂起）可以短暂超过上限。销毁超时也只是发送事件，不做任何强制清理。因此对句柄数敏感的资源应当配置 `destroyTimeoutMillis` 并监听 `factoryDestroyError`，及时发现“销毁泄露”。

便捷封装 `use(fn, priority)` 把申请与归还合并成一次调用，第二个参数是可选优先级，会原样透传给 `acquire`（`index.d.ts` 的类型声明里漏掉了这个参数，以实现为准）。行为是：`fn` 返回的 Promise resolve 则自动 `release`，reject 则自动 `destroy` 并把拒绝原因继续抛出。注意这里只覆盖 fn 返回 rejected Promise 的情形：**若 fn 同步抛出异常**（例如非 async 函数直接 throw），release 与 destroy 两条分支都不会执行，资源将永久停留在已借出状态而泄露——`borrowed` 保持 1、工厂的 destroy 始终未被调用。fn 应优先写成 async 函数。`use` 适合“取资源、做一件事、还资源”的短生命周期用法，不适合需要跨函数持有资源的场景。

补池逻辑 `_ensureMinimum` 会计算“`min` 减去池大小”的缺口并逐个创建，但在排空状态下直接短路，不再补池。

## 七、等待的 Promise 化：Deferred 家族

整个异步等待体系建立在一个 `Deferred` 基类上：构造时创建一个 Promise 并把 resolve、reject 捕获为成员；状态常量是 `PENDING`、`FULFILLED`、`REJECTED`；resolve 与 reject 都带状态守卫，只有处于 PENDING 才生效，因此天然幂等。

三个角色各司其职：

| 类                  | 角色                | 关键行为                                  |
| ------------------- | ------------------- | ----------------------------------------- |
| `ResourceRequest`   | 一次 acquire 的等待 | 可超时，超时后以 `TimeoutError` 拒绝      |
| `ResourceLoan`      | 一张借出凭证        | `reject` 被覆写为空操作，只能被 resolve   |
| `Deferred` 状态常量 | 派发时的状态判据    | 用 `state !== PENDING` 判断请求是否已超时 |

`ResourceRequest` 的超时机制有五个细节：

1. 只有申请超时值不是 `undefined` 时才设置定时器。未配置时属性保持 `undefined`，请求永不过时；`PoolDefaults` 里的 `null` 是传不到这里的“死默认值”（见第十节）。
2. `setTimeout(delay)` 校验时长必须是正整数（`isNaN(ttl) || ttl <= 0` 即抛），否则**同步**抛出 `delay must be a positive int`。注意这是同步抛出而不是失败 Promise，调用方必须处理。
3. 定时时长会按请求的创建时间校正：`Math.max(ttl - age, 0)`，保证重复设置时总等待时间不漂移。
4. 超时触发时以 `TimeoutError`（`lib/errors.js` 中继承自 Error 的可扩展错误类）拒绝；resolve 与 reject 都会先清除定时器。
5. 这个定时器**没有调用 `unref`**，与驱逐定时器、销毁超时定时器不同。因此只要还有一个带超时的申请在等待，事件循环就不会自然退出：配置了申请超时后，即使脚本主体已经执行完，进程仍会被拖到定时器触发、请求被拒绝之后才结束。写“发一个申请就退出”的脚本化任务时，这一点会让进程多活一个超时周期。

超时请求如何不残留在队列里？答案是等待队列 `Queue`（`Deque` 的子类）覆写了 `push`：入队时给请求的 Promise 挂一个 catch 钩子，钩子对拒绝原因的 `name` 字段做字符串比较，等于 `"TimeoutError"` 就把对应的链表节点直接从底层链表摘除。注意这是**按名字匹配而不是按类型匹配**，任何 `name` 为 `TimeoutError` 的错误都会触发出队。这套“超时自动出队”与派发出口的 PENDING 状态检查构成双保险，两者缺一都会留下边界缺陷：只有前者，派发时仍可能取到一个刚被拒绝的请求并把资源浪费掉；只有后者，超时请求会一直占着队列长度，把等待上限与 `pending` 计数撑大，最终让池在“看起来满员”的状态下拒绝新请求。

`PriorityQueue` 本身很薄：构造时按槽数建立一组 `Queue` 子队列，槽数至少为 1（`Math.max(+size | 0, 1)`）；入队时把优先级归一化为整数，越界（负数或不小于槽数）一律钳到最后一个槽，即最低优先级；`dequeue` 从 0 号槽开始找第一个非空槽取出。`head` 从高优先级向低找，`tail` 从最低优先级槽反向找。当 `priorityRange` 为 1 时，整个结构退化为一条普通先进先出队列，这也是默认行为。

借据“只能 resolve”的约束有一个明确目的：停机排空时要等待所有借出资源归还，等待的对象是所有借据的 Promise。借据落定只有归还或销毁这一条路径，因此“等待落定”严格等价于“资源确实回到了池里或被销毁”，排空不会因为借据以其它方式落定而被提前放行；反过来，这笔等待也严格依赖每个借用方最终归还资源。

## 八、容量控制与底层数据结构

上限与下限在 `PoolOptions` 解析时会被归一化：`max` 缺省为 1、下限为 1（`Math.max(isNaN ? 1 : max, 1)`）；`min` 缺省为 0，超过 `max` 时会被静默钳到 `max`（`Math.min(isNaN ? 0 : min, max)`），而不是报错。下限的维持由 `_ensureMinimum` 负责，触发点包括 `start()` 时与每次 `_destroy` 之后。

`fifo` 选项决定空闲队列是队列还是栈（`_addPooledResourceToAvailableObjects` 与派发出口的 `shift` 组合）：

| 取值         | 归还位置     | 借出位置   | 效果                                                         |
| ------------ | ------------ | ---------- | ------------------------------------------------------------ |
| true（默认） | 队尾 push    | 队头 shift | 先进先出，最老的资源最先被复用，各资源使用均匀               |
| false        | 队头 unshift | 队头 shift | 后进先出，最近归还的资源最先被再次借出，冷资源沉底等待被驱逐 |

对数据库连接池场景，后进先出往往是有意的选择：热连接持续被复用、冷连接自然超时被回收，与连接可能在空闲后失效的特点吻合。

底层数据结构是一条“双向链表 -> 双端队列 -> 迭代器”的链条：

- `DoublyLinkedList` 的节点只含 `prev`、`next`、`data` 三个字段，插入与删除都是常数时间的指针操作。`remove` 会把被摘除节点的前后指针置空，这个细节被迭代器用作“脱离检测”的依据。
- `Deque` 在链表上包出队头/队尾的插入与删除（`shift`/`unshift`/`push`/`pop`），以及正向 `iterator()`、反向 `reverseIterator()` 和 `[Symbol.iterator]` 三种遍历入口。空闲资源队列就是一个 `Deque`。
- `DoublyLinkedListIterator` 支持先创建、后添加元素再迭代（首次 `next` 前游标跟踪头/尾节点）；`next` 返回标准迭代器结果；`reset` 把游标回卷重新开始；`remove` 摘除当前游标节点。它用“前后指针均为空且不是头尾节点”的启发式判断节点是否已脱离链表，这一点有已知局限——把节点从一个链表挪到另一个链表可以骗过它。
- `DequeIterator` 只是把链表节点解包成 `data` 的薄包装。池在构造时就创建了驱逐游标 `_evictionIterator` 并在整个生命周期复用，靠 `reset` 回卷实现“无限循环游走”。

## 九、空闲回收与默认驱逐策略

驱逐器默认不运行。`start()` 时仅当 `evictionRunIntervalMillis > 0` 才注册定时器，回调里先执行一轮 `_evict` 再递归排下一轮；定时器调用了 `unref`，不阻止进程退出；排空完成时 `_descheduleEvictorRun` 清除定时器。

每轮驱逐最多检查“`numTestsPerEvictionRun` 与当前空闲数”的较小值个资源，这个上限的动机是防止池很大时一次扫描阻塞应用。循环用驱逐游标游走空闲队列：

- 游标走完（`done`）且空闲队列已空：回卷游标并结束本轮，这是防止死循环的安全检查。
- 游标走完但队列非空：回卷游标后 `continue`，即从头再走。
- 对每个资源调用驱逐策略的 `evict` 判定；判定为驱逐则用游标 `remove` 摘除节点并 `_destroy` 该资源。

一个由代码可推出的细节：链表 `remove` 会把被摘节点的前后指针都置空，因此摘除之后迭代器的下一次 `next` 会把游标推进到空、判定 `done` 并回卷——同一轮中每摘除一个资源，扫描就从队头重新开始，但已检查计数 `testsHaveRun` 保留，不会突破每轮上限。

用一个可复现的例子把这条规则钉死：池 `max: 5`、FIFO、驱逐间隔 50 毫秒、每轮检查 2 个、硬超时 120 毫秒；先借出再归还 5 个资源，让它们按 1 到 5 的顺序躺在空闲队列里。前几轮驱逐时空闲时长还没到 120 毫秒，游标依次走过 1、2、3、4 却一个都不淘汰；等到某一轮游标走到 5，判定超时并摘除，摘除立刻触发回卷，同一轮的第二个名额从队头重新检查并淘汰 1；此后每轮都是“淘汰一个、回卷、再从队头淘汰一个”，最终销毁顺序是 5、1、2、3、4，而不是直觉上的 1、2、3、4、5，且每一轮严格只检查 2 个。这个例子同时暴露了一个容量规划上的后果：每轮检查上限配合游标回卷，会让队尾资源在若干轮里被反复跳过——池越大、每轮上限越小，清空一批同时超时的空闲资源所需的轮数就越多。

`DefaultEvictor` 只比较空闲时长，逻辑可以压缩成两段判断：

```js
evict(config, pooledResource, availableObjectsCount) {
  const idleTime = Date.now() - pooledResource.lastIdleTime;

  // 软超时：只收缩超出下限的富余空闲资源
  if (config.softIdleTimeoutMillis > 0 &&
      config.softIdleTimeoutMillis < idleTime &&
      config.min < availableObjectsCount) {
    return true;
  }

  // 硬超时：无视下限，一律可驱逐
  if (config.idleTimeoutMillis < idleTime) {
    return true;
  }
  return false;
}
```

三种情形的语义：

| 条件                                           | 结果 | 语义                           |
| ---------------------------------------------- | ---- | ------------------------------ |
| 软超时大于零、空闲时长超过它、且空闲数大于下限 | 驱逐 | 软超时只收缩超出下限的富余资源 |
| 空闲时长超过硬超时                             | 驱逐 | 硬超时无视下限，一律可驱逐     |
| 其余                                           | 保留 | 软超时默认 -1（关闭）          |

硬超时与下限的交互会产生一种“抖动”：硬超时路径不看下限，而销毁末尾的 `_ensureMinimum` 又会立即把池补回下限。若 `min > 0` 且空闲超时较短，池内连接会周期性地销毁重建。此外，驱逐策略只比较时间戳，不会做连通性探测，因此“空闲期间已经断掉的连接”不会被主动发现——要么开启借出校验承担借出延迟，要么接受拿到坏连接后走销毁路径。

## 十、配置项与默认值

默认值集中在 `PoolDefaults`，解析在 `PoolOptions`。这里有一个陷阱：三项“未提供默认值”的选项（`acquireTimeoutMillis`、`destroyTimeoutMillis`、`maxWaitingClients`）在默认配置里是 `null`，而解析逻辑对它们不做回退——只有传了值才写入属性，因此未配置时属性保持 `undefined`，默认配置里的 `null` 是死值。

| 选项                      | 实际生效默认 | 归一化方式                | 备注                                     |
| ------------------------- | ------------ | ------------------------- | ---------------------------------------- |
| max                       | 1            | 转为整数后与 1 取较大值   | 下限为 1                                 |
| min                       | 0            | 转为整数后与 max 取较小值 | 超过 max 被静默钳到 max                  |
| fifo                      | true         | 严格布尔检查              | 关闭即后进先出栈                         |
| priorityRange             | 1            | 逻辑或回退到默认          | 队列内部再保底一个槽                     |
| testOnBorrow              | false        | 严格布尔检查              | 需要工厂提供 validate                    |
| testOnReturn              | false        | 严格布尔检查              | 已解析但归还路径无实现                   |
| autostart                 | true         | 严格布尔检查              | 关闭后由 start 或首次 acquire 触发       |
| evictionRunIntervalMillis | 0            | 逻辑或回退到默认          | 不大于零则驱逐器关闭                     |
| numTestsPerEvictionRun    | 3            | 逻辑或回退到默认          | 传 0 会被吞回 3                          |
| softIdleTimeoutMillis     | -1           | 逻辑或回退到默认          | 传 0 会变回 -1，-1 表示关闭              |
| idleTimeoutMillis         | 30000        | 逻辑或回退到默认          | 传 0 会变回 30000                        |
| acquireTimeoutMillis      | undefined    | 真值才转整数              | 未配置即永不超时                         |
| destroyTimeoutMillis      | undefined    | 真值才转整数              | 未配置即销毁不做超时竞速                 |
| maxWaitingClients         | undefined    | 非 undefined 才转整数     | 未配置即等待队列无上限；0 表示饱和即拒绝 |
| Promise                   | 全局 Promise | 非空（`!= null`）即采用   | 可注入第三方 Promise 实现                |

两类归一化陷阱需要特别注意：

1. **假值吞噬**。用逻辑或回退的数值选项一共有五个，其中三个在显式传零时语义被悄悄改写：`numTestsPerEvictionRun` 传 0 会变回 3（无法用 0 表达“单轮不检查”），`softIdleTimeoutMillis` 传 0 会变回 -1（无法表达“空闲即可回收”），`idleTimeoutMillis` 传 0 会变回 30000（无法表达“立即回收”）。另外两个传零是无害的：`priorityRange` 传 0 变回 1，而队列内部本来也会保底一个槽；`evictionRunIntervalMillis` 传 0 经逻辑或仍是 0，恰好就是“关闭驱逐”的本意。布尔选项走 `typeof === "boolean"` 严格检查，传 `false` 是安全的。
2. **非法超时的两种表现**。`acquireTimeoutMillis` 传负数能通过解析的真值检查，但会在构造 `ResourceRequest` 时同步抛出 `delay must be a positive int`——注意是同步抛出而非失败 Promise；`destroyTimeoutMillis` 传负数则表现为 `setTimeout` 收到负延时、立即触发超时竞速。

## 十一、生命周期：启动、就绪、排空与清空

`start()` 有三个入口：构造时 `autostart` 为真则自动启动；关闭 autostart 后首次 `acquire` 时懒启动；用户显式调用。方法内先做排空与已启动双重守卫，然后只做两件事：调度驱逐器（`_scheduleEvictorRun`）、预建下限数量的资源（`_ensureMinimum`）。

`ready()` 以固定 100 毫秒间隔轮询“`available` 是否达到 `min`”，达标即 resolve。它没有超时上限，若下限资源始终建不出来（例如工厂一直失败）会永远轮询；轮询定时器也**不会** `unref`，会阻塞进程退出，因此不要把就绪等待当作可以无条件依赖的兜底。

`drain()` 是优雅停机入口，置 `_draining` 标志后按序等待：

1. 等待所有等待中的请求落定：取等待队列 `tail` 请求的 Promise，用 `reflector` 包一层等待。源码注释自己承认这是一个已知近似——如果请求乱序落定，等尾部并不严格等价于等全部。
2. 等待所有借出资源归还：收集全部借据的 Promise 一起 `Promise.all`。借据只能 resolve，这一步没有异常路径，但也严格依赖每个借出资源真的被归还——存在永不归还的泄露借据时，排空会一直挂起（见第十四节场景五）。
3. 停止驱逐定时器。

排空之后，`acquire` 一律被拒绝，`_ensureMinimum` 也不再补池。

`clear()` 会强制销毁全部空闲资源，分三步：先等待所有创建在途落定（防止在池生命早期调用时“漏掉”刚发起的创建）；然后遍历空闲队列逐个 `_destroy`；最后等待全部销毁落定。清空不回收仍被借出的资源，也不阻止后续申请。

这里有一个必须知道的实现细节：清空只是遍历空闲队列、对每个包装对象调用 `_destroy`，而 `_destroy` 只把对象作废并移出 `_allObjects`，**不会把它从空闲队列里摘除**。于是清空之后，空闲队列里残留的是一批状态为 INVALID 的包装对象：`size` 已经归零，`available` 却仍然等于清空前的空闲数，两个计数自相矛盾。更严重的是，如果没有先排空，后续申请会照常从空闲队列头部 `shift` 出这些作废对象并派发给调用方——确实可能拿到一个已经被工厂销毁过的资源。这正是“先排空、再清空”不只是风格建议、而是正确性要求的原因：排空之后 `acquire` 一律被拒绝，残留的作废对象再也没有机会被派发出去。

另一条提醒：当 `min > 0` 且未排空时，清空掉的空闲资源会被 `_destroy` 末尾的补池逻辑立即补建，想真正清空应先把下限置零。

## 十二、可观测性：计数属性与事件

池暴露的只读属性都是即时计算的 getter：

| 属性                  | 含义                                        |
| --------------------- | ------------------------------------------- |
| size                  | `_allObjects.size` + 创建在途，不含销毁在途 |
| available             | 空闲队列长度                                |
| borrowed              | `_resourceLoans.size`，已借出数             |
| pending               | 等待队列长度，等待中的申请数                |
| spareResourceCapacity | `max` - size，剩余可创建容量                |
| max / min             | 配置的上下限                                |

判断某个对象是否正处于从本池借出的状态，用 `isBorrowedResource(resource)` 即可，内部就是查借出映射，同步返回布尔值。需要留意 `available` 与 `size` 的口径差异：前者是空闲队列长度，后者是全量集合加创建在途，而 `clear()` 会让两者出现“`size` 为 0、`available` 不为 0”的矛盾状态（见第十一节），做监控告警时不要把 `available > size` 当成不可能事件。

事件只有两个：

| 事件                | 触发时机               | 说明                   |
| ------------------- | ---------------------- | ---------------------- |
| factoryCreateError  | 创建 Promise 被拒绝时  | 创建失败，池会重新调度 |
| factoryDestroyError | 销毁被拒绝或销毁超时时 | 销毁未正常完成         |

这两个事件名都不是 `error`，因此没有监听器时不会被当作未处理错误抛出，而是静默丢弃。生产环境应当挂上监听并接入日志或告警，否则“创建一直失败”或“销毁一直超时”会完全不可见。

## 十三、常见误用与生产实践

把前面各节的边界汇总成一份排查与配置清单：

- **没有后台探活**。驱逐器只比较时间戳，`validate` 只在借出时调用。空闲连接中途断掉不会被主动发现。要么开启借出校验承受每次借出的额外延迟，要么接受偶尔拿到坏连接并走销毁路径。
- **归还校验无效**。`testOnReturn` 被接受但没有任何行为，归还前的健康判断必须在业务代码里完成。
- **上限是单进程的**。库内没有锁，计数器只在单进程内一致；多进程或多线程部署时每个进程各自建池，上限需要按进程数放大或改用集中式限流。
- **销毁挂起会短暂超容**。销毁时计数已减、实物未亡、下限又立即补建，真实资源总数可能超过上限；对句柄敏感的资源应配置销毁超时并监听 `factoryDestroyError`。
- **申请无法取消**。调用方无法撤销一个已发出的申请，只能通过申请超时让它自行失败。`maxWaitingClients: 0` 配合申请超时可以实现“快速失败”的背压语义。
- **use 的同步异常泄露资源**。`use(fn)` 中 fn 同步抛出时资源既不归还也不销毁，永久停留在已借出状态；fn 应为 async 函数或保证不同步抛异常。
- **就绪等待可能永不返回**。下限长期无法满足时轮询会一直进行，且轮询定时器阻塞进程退出；应配合申请超时与创建失败事件来感知。
- **假值吞噬**。`numTestsPerEvictionRun`、`softIdleTimeoutMillis`、`idleTimeoutMillis` 三项显式传零无效，配置时要用非零的合法值。
- **清空不等于停机**。未排空且下限大于零时，清空后资源会被立即补建；更关键的是清空不会把作废对象从空闲队列摘除，未排空时后续申请可能拿到已销毁的资源——停机必须先 `drain` 再 `clear`。
- **借出校验必须配校验方法**。开启 `testOnBorrow` 却不提供 `validate`，会让资源永久滞留在借出校验集合里、对应的申请永远挂起，而错误只以一次 `factoryCreateError` 事件（或一次同步 TypeError）的形式出现。
- **申请超时的定时器不会 `unref`**。带超时的等待会拖住事件循环，进程不会在“没事可做”时立刻退出；驱逐定时器与销毁超时定时器则相反，不会阻止退出。

## 十四、时序与竞态的几个关键场景

单线程事件循环并不意味着没有竞态，只是竞态表现为“回调交错的顺序”而不是“内存竞争”。几个典型场景值得逐个推演：

**场景一：创建在途时又来了一批申请。** 创建在途的资源被计入潜在可分配数，因此缺口计算不会为同一批需求重复创建；创建完成后资源进入空闲队列并再次触发调度，新到的申请会被立即满足。如果没有这项计数，高并发下会创建远超上限的资源。

**场景二：请求即将超时，资源恰好可用。** 两条路径同时推进——超时路径把请求从队列中摘除并拒绝，派发路径从队列取出请求。派发出口会检查请求是否仍处于 PENDING：如果已被拒绝，就跳过它并把资源放回队列交给下一位。摘除与状态检查共同保证不会把资源派发给一个已经失败的请求，也不会因为超时而丢失资源。

**场景三：归还与销毁交错发生。** 资源被借出时会在借出映射里登记一张借据；归还或销毁都以“能从映射里查到借据”为前提，查不到即拒绝，且处理时先删除借据。这保证同一个资源不会被归还两次，也不会被归还到错误的池。

**场景四：销毁内部失败或挂起。** 作废并移出全量集合发生在调用工厂销毁之前，因此计数立即下降、补池立即进行，真实的资源总数可能短暂超过上限；如果销毁超时，只发送事件而不做强制清理。这解释了为什么 `factoryDestroyError` 必须被监控，否则会积累“池外”的资源。

**场景五：排空与在途借出。** 排空会等待等待队列落定和所有借据落定；借据只能被 resolve 的约束保证这个等待不会因异常中断。若此时仍有调用方正在使用资源，排空会一直等到它归还。因此优雅停机的前提是应用能够停止发起新的长任务并及时归还资源。

**场景六：驱逐与借出同时进行。** 驱逐从空闲队列摘除资源，借出也从空闲队列取资源。两者都在同步代码段内完成对队列的修改，单线程下不会同时操作同一个节点：要么资源先被借出、驱逐看不到它，要么先被摘除、借出拿不到它。

## 十五、与连接池场景的对应与选型建议

把库内机制与成熟连接池的常见概念对齐，有助于配置时形成直觉：

| 库内机制                                  | 连接池对应物                                     |
| ----------------------------------------- | ------------------------------------------------ |
| max / min                                 | 最大连接数 / 最小空闲连接数                      |
| acquire + acquireTimeoutMillis            | 获取连接及其获取超时                             |
| maxWaitingClients                         | 等待队列上限，饱和快速失败                       |
| testOnBorrow + validate                   | 借出探活，校验内可做连通性检查                   |
| fifo 关闭（后进先出）                     | 优先复用最近归还的热连接，冷连接沉底待驱逐       |
| evictionRunIntervalMillis                 | 空闲回收巡检周期                                 |
| idleTimeoutMillis / softIdleTimeoutMillis | 空闲连接强制回收阈值 / 保留下限的柔性回收阈值    |
| numTestsPerEvictionRun                    | 单轮巡检的连接数上限，防止阻塞                   |
| drain + clear                             | 优雅停机：停止接客、等在途归还、销毁全部空闲连接 |
| use(fn)                                   | 回调式“取连接、执行、归还”，失败自动销毁         |
| factoryCreateError / factoryDestroyError  | 建连失败、断连关闭失败的监控埋点                 |

一个按数据库场景组织的配置骨架（工厂为示意）：

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

选型建议：

- 如果只需要“限制并发数”，而不关心资源的健康、复用质量与优雅停机，用信号量或简单的 Promise 池更轻。
- 如果需要“连接复用 + 动态扩缩容 + 空闲回收 + 优雅停机”，并且资源生命周期较长，使用这一套机制更合适。
- 无论用哪个库，都要为申请设置超时、为销毁设置超时、监听失败事件，并把池的大小与下游容量一起规划，而不是各自独立配置。
- 对于连接失效频繁的场景，优先用借出校验而不是归还校验（后者在此库中无效），并在业务侧对“确实损坏”的资源显式走销毁路径。
