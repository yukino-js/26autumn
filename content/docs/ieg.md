---
title: "NoSQL 管理端工程实践: 组件迁移、native 绑定与池化资源治理"
description: "类组件迁移函数组件的语义映射与请求竞态、ffi 调用的内存模型与进程池隔离、TCP 连接池的四类异常处理、闭包引用导致的内存泄漏排查、服务可观测性: 运行时指标、OpenTelemetry 插桩、Sentry 错误与 profiling、Grafana 告警设计"
---

这份文档整理一个 NoSQL 管理端在长期迭代中遇到的五类工程问题: 公共选择器从类组件迁移到函数组件时的语义差异与数据竞争、通过 ffi 调用 C++ 动态库时的内存模型与进程池隔离、与数据库管理端 TCP 长连接的连接池治理、JS 堆内闭包引用导致的内存泄漏排查, 以及把上述排查手段常态化的服务可观测性体系。

五部分各自独立, 但共享同一套方法论: 先界定问题的约束 (语义模型、内存归属、连接状态、可达性、数据口径), 再对比可选方案, 最后给出实现要点与边界。适合做 Node 后端稳定性治理、React 组件重构或 native 互操作的工程师参考。

## 类组件迁移到函数组件

### 迁移动机

管理端页面存在多个公共选择器, 历史上都是类组件实现: 集群选择器、备用集群选择器、数据库选择器、表选择器 (该 NoSQL 的表格式是 XML)。迁移动机来自类组件本身的几类摩擦:

- 生命周期逻辑分散: 一段副作用逻辑常散落在 componentDidMount、componentDidUpdate、componentWillUnmount 三个方法里, 读代码要来回跳; 函数组件用 useEffect 把"执行副作用加清理副作用"收敛到一处, 按逻辑单元组织。
- this 与绑定问题: 类组件的事件处理要么手动 bind, 要么写箭头函数属性, 容易踩 this 指向的坑; 函数组件全是普通闭包, 没有这类问题。
- 逻辑复用能力: 选择器之间有大量共性逻辑 (拉取选项列表、缓存、联动刷新), 类组件只能靠继承或高阶组件复用, 函数组件可以抽成自定义 hook, 复用更直接、组合更灵活。
- 性能优化手段更细: React.memo、useMemo、useCallback 可以精确控制重渲染与重复请求。
- 生态与维护: 现代 React 生态 (状态管理、路由、组件库) 都以 hooks 为中心, 统一成函数组件后代码风格一致; TypeScript 下函数组件加 hooks 的类型推导也比类的 this 类型更顺。
- 面向未来: 并发特性 (useTransition、useDeferredValue) 以 hook 形式提供, 只对函数组件友好。

### 生命周期与 hooks 的语义映射

核心难点是生命周期与 hooks 的语义并不一一对应, 机械翻译会出 bug。对应关系与注意点:

| 类组件                              | hooks 等价物                                  | 注意点                                                         |
| ----------------------------------- | --------------------------------------------- | -------------------------------------------------------------- |
| componentDidMount                   | useEffect(fn, [])                             | effect 在浏览器绘制后异步执行, 与 componentDidMount 时机有差异 |
| 需要在绘制前同步读 DOM              | useLayoutEffect                               | 用于避免闪烁或依赖布局尺寸的计算                               |
| componentDidUpdate                  | 带依赖数组的 useEffect                        | 依赖必须列全, 漏列会拿到过期值                                 |
| componentWillUnmount                | effect 返回的清理函数                         | 监听、定时器、在途请求的取消都放这里                           |
| shouldComponentUpdate               | React.memo 包裹组件, 配合 useMemo/useCallback | 引用不稳定会让 memo 失效                                       |
| getDerivedStateFromProps            | 渲染期直接计算或 useMemo                      | 优先不存第二份 state                                           |
| 错误边界 (getDerivedStateFromError) | 无 hook 等价物                                | 错误边界组件必须保留类组件                                     |

### state 的形态变化

this.state 是一个对象, setState 是合并且批量异步的; useState 是多个独立状态, 更新是整体替换。迁移时如果照搬对象形态塞进一个 useState, 更新时漏掉字段就会丢数据。正确的做法是按更新粒度拆分 state, 或改用 useReducer 把状态转移集中表达, 保证每次更新都是完整的下一状态。

### 闭包过期值与请求竞态

这是迁移中最容易踩到的问题, 分成两层:

- 闭包过期值: 函数组件里事件处理与异步回调都是闭包, 捕获的是当次渲染的 state。异步请求回来后再 setState, 可能基于过期值计算。
- 请求竞态: 选择器场景下接口响应时间不稳定, 用户连续切换筛选条件发出多个请求, 如果后发的请求先返回, 晚到的旧响应会覆盖新响应, 下拉选项与选中态错乱。

修法是在 effect 的清理函数里标记本次请求作废 (或用 AbortController 中断), 响应回来后先校验"是否仍是最新一次请求"再写入状态。稳定的请求标识加竞态校验是选择器类组件的必备逻辑。

### 避免重复请求

迁移后利用性能优化 hooks 收敛请求。两类重复请求最常见: 同一选择器在多个面板同时挂载, 每个实例各自发一次拉取选项的请求; 级联切换 (集群 -> 数据库 -> 表) 时, 传给请求 hook 的参数对象每次渲染都是新引用, hook 判定"参数变了"又发一次。解法分三层:

1. 请求参数稳定化。把传给请求 hook 的参数收敛为原始值 (例如集群 id), hook 内部再用 useMemo 把参数组装成稳定对象, 依赖数组只放原始值, 保证内容不变时引用不变。参数引用不稳定是重复请求的最大来源, 这一步不做, 后面的缓存全部失效。
2. 请求逻辑抽成自定义 hook 加模块级缓存。hook 内部读写模块级缓存 Map (key 为参数序列化后的字符串): 命中直接返回, 未命中才发请求, 多个面板挂载同一选择器时共享同一份缓存。再配一层在途请求去重, 相同 key 的请求还在飞时, 后来者复用同一个 Promise, 而不是并发再发一次。缓存条目带过期时间, 或在选项数据有变更的入口 (新增、编辑) 主动失效对应 key。
3. 渲染性能。选项列表的派生数据 (过滤、分组) 用 useMemo 缓存; onChange 等回调用 useCallback 稳定引用, 避免把新函数传给 React.memo 包裹的子组件导致 memo 失效; 选择器组件本身用 React.memo 包裹。memo、useMemo、useCallback 要成套配合, 任何一环引用不稳定, 整条 memo 链都会失效。

效果: 多面板挂载同一选择器时, 拉取请求从每个实例一次收敛为全局一次; 级联切换只请求真正变化的层级; 面板内其他状态变化引起重渲染时, 选择器子树基本被 memo 跳过。

### 用大模型批量迁移的工程方法

选择器数量多、结构相似, 适合用大模型做批量迁移, 但不能无脑托管, 实际做法是规范先行、模型生成、人工把关:

1. 先沉淀迁移规范作为约束。把生命周期映射表、state 拆分规则、竞态处理模式、命名与目录约定写成规范文档, 每次迁移作为上下文喂给模型, 保证多个组件的产出风格一致、映射规则统一。
2. 单组件批量生成。一次只迁移一个选择器, 把类组件源码加规范交给模型产出函数组件版本。第一个组件人工精修后的成品可以作为后续组件的 few-shot 示例, 越迁越稳。
3. 人工 review 聚焦高风险点。模型的机械翻译 (JSX 结构、props 透传、事件绑定) 可信度高, 精力集中在模型容易错的地方: useEffect 依赖数组是否完整、异步回调是否捕获过期 state、竞态校验是否存在、setState 合并语义是否正确转换、清理函数时机是否与原 componentWillUnmount 一致。
4. 用模型辅助验证。让模型对照新旧两版代码逐条列出行为差异清单 (副作用时机、状态更新顺序、边界处理), 人工按清单回归; 也可以让模型根据原组件行为生成测试用例, 迁移前后各跑一遍对比。
5. 小步提交、可回滚。一个选择器一次提交, 迁移加回归通过再合入, 出问题可以单独回滚。

迁移是重构不是重写, 验收标准是行为完全一致: 交互流程、联动逻辑、边界 case 要逐条回归; 选择器之间还有级联关系 (选集群后才能选数据库、表), 一个组件迁移后联动方也要回归。

## 进程池与 ffi 内存模型

### 场景约束

管理端中表文件的格式是 XML, Node 服务需要对文件做解密与解析。解密与解析由 C++ 实现并编译成 .so 动态链接库, JS 侧通过 ffi-napi 调用。这三条约束决定了后续所有设计:

- 第三方只提供二进制 .so, 没有源码, 因此无法直接改写 native 实现。
- native 代码存在内存泄漏这类不稳定因素, 且崩溃会带走宿主进程。
- 解析每次都要创建大对象 (部分属性是大 buffer), 高频分配会给 GC 带来压力。

对应的三条主线是: 用 valgrind 定位 C++ 侧内存泄漏; 用进程池把 .so 调用隔离到子进程, 避免崩溃影响主服务; 用对象池复用解析上下文对象, 并保持对象结构稳定以降低 GC 压力。

### 进程池与线程池的选型

两者参数模型基本一致, 关键差异在故障隔离:

| 维度     | 线程池 (worker_threads)                               | 进程池                                     |
| -------- | ----------------------------------------------------- | ------------------------------------------ |
| 地址空间 | 共享进程地址空间                                      | 每个 worker 独立地址空间                   |
| 通信开销 | 小, 可直接共享内存                                    | 大, 需要序列化或 IPC                       |
| 崩溃影响 | 任一线程内 native 崩溃 (segfault、abort) 带走整个进程 | 子进程崩溃只影响自己, 主进程重建新进程即可 |
| 资源成本 | 低                                                    | 高 (fork、加载 .so、初始化运行时)          |
| 适用场景 | native 代码可信、追求低延迟                           | native 代码不可信、需要崩溃与堆外泄漏隔离  |

本场景选进程池: .so 是第三方 C++ 代码, 崩溃隔离的收益大于进程间通信的开销。

### 池参数模型

以 generic-pool 为例, 参数模型如下:

| 参数                                               | 含义                                       | 调优思路                                                                      |
| -------------------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------- |
| max                                                | worker 数量上限, 决定并发天花板            | CPU 密集型任务参考 CPU 核数; 进程池还要按"单进程峰值内存乘以 max"估算内存约束 |
| min                                                | 常驻最小数量                               | 持续有请求就设大于 0 避免冷启动毛刺; 明显有波峰波谷就设小一些配合空闲回收     |
| acquireTimeoutMillis                               | 从池中获取 worker 的等待超时               | 要大于单次任务的 P99 耗时, 避免误杀正常慢请求, 同时不能让调用方无限等待       |
| maxWaitingClients                                  | 排队等待队列上限, 与超时共同构成背压       | 池满时快速报错, 避免请求在队列里无限堆积                                      |
| idleTimeoutMillis                                  | 空闲多久后回收 (数量高于 min 的部分)       | 突发型流量的空闲回收可以释放内存                                              |
| evictionRunIntervalMillis / numTestsPerEvictionRun | 空闲驱逐检查的周期与每次检查数量           | 与 idleTimeout 配合控制回收节奏                                               |
| testOnBorrow                                       | 借出时是否调用 factory.validate 做健康检查 | 进程池可在这里检查子进程是否存活, 避免把已崩溃的进程借给调用方                |
| fifo                                               | 是否按先进先出复用空闲 worker              | 按负载形态选择                                                                |

一个容易踩的实现细节: generic-pool 的 validate 只挂在借出路径上, testOnReturn 配置即使被解析也不会在归还路径触发校验, 归还前的校验需要在业务侧自己做。

### valgrind 的原理与排查流程

valgrind 是动态分析框架, 最常用的 memcheck 工具用于排查内存错误与内存泄漏。

原理:

- 采用动态二进制插桩 (dynamic binary instrumentation): 不修改源码、不需要重新编译, 程序运行在 valgrind 的虚拟 CPU 上, valgrind 在程序加载时把机器指令逐段翻译、插入检查代码后再执行。
- memcheck 为程序的每一个内存字节维护两份影子状态: 该字节是否可寻址 (addressable, 是否属于合法分配的内存), 以及该字节的值是否已定义 (defined)。所有内存读写指令都被插桩检查这两个状态。
- 基于这套机制可以检测: 读写已释放的内存 (use after free)、越界读写、使用未初始化的值、new/delete 与 malloc/free 不匹配, 以及内存泄漏。
- 泄漏检测原理: 程序退出前, memcheck 扫描所有寄存器、栈与全局数据中仍指向堆内存的指针, 把堆块分类为 definitely lost (没有任何指针指向, 确定泄漏)、indirectly lost (指向它的内存本身也泄漏)、possibly lost (指针指向块内部而非块起始, 疑似泄漏)、still reachable (仍有指针可达, 通常不算问题)。
- 代价: 插桩执行比原生慢一个数量级以上, 内存占用也显著增加, 适合定向排查, 不适合常态运行。

调用 .so 的 Node 进程中, ffi-napi 加载的动态库在同一进程内, 会被一起插桩:

```sh
valgrind --tool=memcheck \
  --leak-check=full \
  --show-leak-kinds=definite,possible \
  --track-origins=yes \
  --log-file=valgrind.log \
  node parse-xml.js
```

排查步骤:

1. 构造最小输入: 准备一份典型的 XML 表文件, 写一个只调用 .so 解密加解析的入口, 减少 Node 自身的噪音。更干净的做法是用 C++ 写一个最小复现程序, 只走解析路径。
2. 跑 valgrind 拿到报告, 关注 definitely lost 的条目, 每条都带分配点的调用栈。
3. 读调用栈定位分配点: 报告的栈会指向 protobuf 内部的分配路径, 结合 C++ 侧代码确认是哪类对象没有释放。本场景最终定位到解析产生的 message 对象在部分路径上没有正确释放, 每次解析都漏一点, 长时间运行后进程内存持续增长。
4. 用 suppression 过滤无关噪音: Node、glibc 等运行时的已知泄漏写进 suppression 文件, 让报告聚焦业务代码。
5. 修复后复测: 同样的输入再跑一遍, 确认 definitely lost 归零; 再长跑观察 RSS 是否稳定。

如果能改 C++ 源码并重新编译, AddressSanitizer (ASan) 是更快的替代方案, 运行时开销远小于 valgrind, 但需要带 -fsanitize=address 重新构建; valgrind 的优势是零编译、对现成的 .so 二进制直接可用, 排查第三方二进制时这个特性很关键。

### ffi 调用的内存模型

结论先行: 分情况。标量参数是拷贝, 不共享; Buffer 与指针参数是共享内存; JS GC 只能管理 JS 侧分配的内存, C++ 侧分配的内存不受 JS GC 控制。

调用机制:

- ffi-napi 底层基于 libffi。JS 侧声明 C 函数签名 (参数类型、返回类型), ffi-napi 通过 dlopen 加载 .so、dlsym 找到符号, 调用时按 ABI 把参数组装成 C 能理解的布局再跳转执行。
- 标量类型 (int、double 等) 按值拷贝进寄存器或栈, C++ 侧拿到的是副本, 两边互不影响。

Buffer 与指针场景是真正的共享内存:

- JS 把 Buffer 传给 C++ 函数时, 传的是这块内存的地址, C++ 侧直接在这块内存上读写, 零拷贝; C++ 写入的内容 JS 侧立刻可见。解密、解析这类场景正是这样用的: JS 分配 buffer, C++ 原地写入解析结果。
- 共享带来两个必须注意的问题:
  - 生命周期: C++ 侧只在同步调用期间使用这块内存是安全的; 如果 C++ 把指针存下来异步使用, 而 JS 侧已经没人引用这个 Buffer, GC 可能回收它, C++ 侧就拿到悬垂指针。规避方式是 JS 侧保持引用直到 C++ 用完, 或者 C++ 侧同步拷贝走。
  - 小 Buffer 的池化陷阱: Node 对小于 `Buffer.poolSize >>> 1` 的 Buffer 会从共享内存池切片分配 (poolSize 长期默认为 8KB, 阈值即 4KB; Node v26.3.0 起默认提升为 64KB, 阈值相应变为 32KB)。把这种切片的地址交给 C++ 有越界读写相邻数据的风险, 传给 native 的 buffer 应用 `Buffer.allocUnsafeSlow` 或确保独立分配。

C++ 侧分配的内存不受 JS GC 控制:

- .so 内部用 malloc/new 分配内存 (例如解析出的 message), 把指针返回给 JS 后, 这块内存完全在 V8 堆外, JS GC 看不见它、不会回收它。
- 唯一的释放途径是 JS 侧显式再调一次 .so 提供的释放函数 (例如 destroy_message), 用 ffi 声明这个函数并在用完后调用。
- 实践中可以用 try/finally 保证释放一定执行; 也可以用 FinalizationRegistry 在 JS 包装对象被 GC 时触发释放, 但 GC 时机不可控, 只能作为兜底。
- 如果忘了释放, 表现是 Node 进程 RSS 持续增长但 V8 堆内存正常。这类泄漏要用 valgrind 或 ASan 在 native 侧排查, 用 heap snapshot 查不到。两个指标的口径差异、查看 API 与这一现象的成因见下一节。

这也解释了为什么进程池是合适的隔离层: 堆外泄漏与崩溃都发生在子进程里, 最坏情况下重启子进程就能恢复, 主服务的内存曲线保持稳定。

### RSS 与 V8 堆内存: 两个口径的内存

"RSS 持续增长但 V8 堆内存正常"之所以成立, 是因为这两个词统计的根本不是同一块内存。

**RSS (Resident Set Size)** 是操作系统口径的进程级指标: 进程当前实际驻留在物理内存中的页总量, 涵盖进程地址空间里所有常驻部分 —— V8 堆、native 堆 (C++ 侧 malloc/new 分配的块)、Buffer 与 ArrayBuffer 的后备存储、可执行文件与共享库的代码段、各线程的栈、显式 mmap 的映射。OOM killer 与容器内存限制针对的也是这个口径的物理占用, 所以 RSS 才是"这个进程到底吃了多少内存"的最终答案。

**V8 堆**是 V8 垃圾回收器管理的对象存储区, 按空间 (space) 组织: new_space (新生代)、old_space (老生代)、code_space (JIT 代码)、large_object_space (大对象) 等。里面只存放 JS 对象, 且只有从 GC root 可达的对象才会留下。`heapTotal` 是 V8 已向操作系统申请到的堆容量, `heapUsed` 是其中被存活对象占用的部分 —— 它是"托管区"口径, 天然不包含任何 native 分配。

两者的关系是包含: V8 堆只是 RSS 的组成部分之一。差异可以归成三点:

| 维度     | RSS                                                                 | V8 堆 (heapTotal/heapUsed)    |
| -------- | ------------------------------------------------------------------- | ----------------------------- |
| 统计主体 | 操作系统 (进程页表)                                                 | V8 引擎 (GC 托管区)           |
| 覆盖范围 | 全部驻留物理内存: V8 堆、native 堆、Buffer 后备、代码段、栈、共享库 | 仅 JS 对象所在的各 heap space |
| 回收机制 | OS 不主动回收, 进程退出或显式 free/munmap 才释放                    | V8 GC 按可达性自动回收        |

**查看 API。** JS 侧的第一入口是 `process.memoryUsage()`, 五个字段各有口径:

| 字段         | 含义                                                 |
| ------------ | ---------------------------------------------------- |
| rss          | 进程驻留的物理内存总量, 即上述 OS 口径               |
| heapTotal    | V8 已申请的堆容量                                    |
| heapUsed     | V8 堆中存活对象的占用量                              |
| external     | 绑定到 JS 对象的 C++ 对象内存 (含 Buffer 的后备存储) |
| arrayBuffers | external 中属于 ArrayBuffer 后备存储的部分           |

一个能直接验证口径差异的实验: 分配一个 10MB 的 Buffer, `external` 与 `arrayBuffers` 各涨约 10MB, 而 `heapUsed` 几乎不动 —— Buffer 的数据体从来就不在 V8 堆里, JS 堆里只有那个几十字节的包装对象。

更细的明细还有三层:

- `process.memoryUsage.rss()`: 只返回 RSS 的轻量接口, 跳过 V8 堆统计的采集开销, 适合监控里高频采样。
- `v8.getHeapStatistics()`: V8 内部视角, 除 used_heap_size、heap_size_limit 外, 还有 malloced_memory (V8 自身 malloc 的内存)、external_memory、number_of_detached_contexts (已分离但未回收的 context 数, 本身就是泄漏线索) 等字段; `v8.getHeapSpaceStatistics()` 再按 space 细分容量。
- `process.report.getReport()` (或 `node --report-on-signal`): 生成诊断报告, 内含内存汇总与 libuv 句柄列表, 返回的是对象而非 JSON 字符串。

OS 侧不依赖 Node API 也能看: Linux 读 `/proc/<pid>/status` 的 VmRSS 或 `/proc/<pid>/smaps_rollup`; `ps -o rss -p <pid>` 各平台通用; macOS 用 `vmmap <pid>` 能看到分区明细 (V8 堆、malloc 区、共享库各占多少)。

**为什么 native 泄漏表现为"RSS 涨、V8 堆正常"。** 把泄漏块的归属代入上面的口径就清楚了:

1. .so 里 new 出来的 message 落在 native 堆 (glibc malloc 的 arena), 属于进程驻留内存, 每泄漏一块, RSS 就垫高一截;
2. 这块内存不在任何 V8 space 里, V8 GC 只按 JS 可达性回收, 对 native 分配零感知, 所以 heapTotal/heapUsed 完全平稳;
3. heap snapshot 记录的是 JS 对象及其保留链, native 块在快照里至多以某个 Buffer 的大小标注出现; ffi 场景里 JS 侧拿到的只是指针值本身, 泄漏的 C++ 块不计入 external, 于是 JS 侧唯一能观测到的信号就是 rss;
4. 排查工具随之分裂: 堆内泄漏用 heap snapshot 看对象保留链, 堆外泄漏只能到 native 侧用 valgrind/ASan 看分配点调用栈 (见前文 valgrind 小节)。

两个容易误判的相邻现象值得区分:

- RSS 冲高后不回落不等于泄漏: glibc malloc 出于 arena 缓存与碎片考虑, free 掉的内存不一定还给 OS。判断泄漏看的是"长期单调增长"的趋势线, 而不是单次峰值是否回落。
- external/arrayBuffers 持续上涨也不是 native 泄漏: 那是 JS 侧 Buffer/ArrayBuffer 用得多或被引用住, 属于堆内问题, heap snapshot 能查到保留链。

这套"先看 rss 与 heapUsed 两条曲线的相对走势, 再决定用哪套工具"的分诊方法, 在后文闭包泄漏排查一节会再次出现, 两处共用同一条原则: 判断泄漏先分清在哪个堆。

### 从 ffi 迁移到 N-API Addon

随着解析调用量与数据量上升, 评估并迁移到 C++ Addon (基于 N-API / node-addon-api) 的方案。收益:

- 调用开销更低: ffi-napi 每次调用都要经 libffi 做运行时参数组装 (JS 值到 C ABI 布局), 类型转换全靠运行时描述; Addon 直接通过 N-API 读写 JS 值, 没有这层中间转换, 高频调用场景差距明显。
- 大数据零拷贝更自然: Addon 可以直接接收 ArrayBuffer 并在 C++ 侧原地处理, 解析结果也可以包成 external buffer 返回, 不需要像 ffi 那样围绕裸指针手工管理。
- 内存管理可与 GC 联动: N-API 支持给 external 内存挂 finalize 回调, JS 侧包装对象被 GC 回收时自动触发 C++ 侧释放, 堆外内存泄漏的敞口变小。
- 异步能力完整: CPU 密集的解析可以用 AsyncWorker 丢进 libuv 线程池执行, 不阻塞事件循环; 跨线程回传结果有 ThreadSafeFunction 兜底。ffi-napi 的异步支持弱, 之前只能靠进程池顺带解决阻塞问题。
- 类型表达更强: 可以直接在 C++ 侧构造 JS 对象、数组返回, 不用把解析结果序列化成 buffer 再在 JS 侧二次解析, 省一次编解码。
- ABI 稳定: N-API 保证跨 Node 版本 ABI 兼容, Addon 不需要跟随 Node 小版本反复重编, 解决了老式 NAN addon 的痛点。

代价:

- 编译与分发成本: ffi-napi 是纯 JS 层加 dlopen, 拿来即用; Addon 要走 node-gyp 构建, CI 需要维护编译工具链, 多平台多 Node 版本要产出对应的 prebuild 产物, 发布链路明显变重。
- 迭代耦合: .so 更新只需替换二进制, JS 侧无感; Addon 的接口变更要同时改 C++ 与 JS 两侧并重新编译发布, 迭代节奏被绑在一起。
- 崩溃隔离并未解决: 这是最容易误判的一点。Addon 运行在 Node 主进程地址空间内, C++ 侧崩溃依然会带走整个进程。因此迁移到 Addon 之后进程池的隔离层仍然保留, Addon 跑在池内的子进程里。Addon 解决性能与内存管理问题, 进程池解决故障隔离问题, 两者是叠加关系而不是替代关系。
- 开发与调试门槛: 需要掌握 N-API 的引用计数、handle scope、ThreadSafeFunction 等概念, native 崩溃的排查依然要靠 valgrind 或 ASan 这套工具链。

小结: ffi-napi 适合快速接入一个现成 .so、调用量不大的阶段; 当调用频率与数据体积上来, 且希望堆外内存与 GC 联动时, N-API Addon 更合适; 无论用哪种绑定方式, 第三方 C++ 代码的崩溃风险都要靠进程池兜底。

### 其他绑定与迁移形态

围绕"JS 进程里调用 .so"这条链路, 除 ffi-napi 与 N-API Addon 之外还有几类形态:

| 形态                  | 前提                                  | 收益                                                         | 代价                                                     |
| --------------------- | ------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------- |
| napi-rs 等现代工具链  | 团队具备 Rust 工程能力                | 跨平台预编译产物由框架托管, Rust 内存安全减少一类 native bug | 仍不解决崩溃隔离, 进程池要保留                           |
| 独立解析服务 (服务化) | 解析量大到需要独立伸缩, 或多方复用    | 崩溃与内存泄漏圈在服务内, 可独立扩容、发布、重启             | 多一跳网络与序列化 (大 buffer 传输成本高), 运维成本增加  |
| WASM 编译             | 能拿到 C++ 源码并通过 Emscripten      | 线性内存边界受控, 越界是 trap 而非崩溃, 省去多平台编译产物   | 现成 .so 无法直接转 wasm, 性能通常低于原生               |
| 纯 JS 重写            | 解析量不大, 或压测证明瓶颈不在 native | 消灭绑定成本、崩溃风险与堆外内存问题, 类型直接对齐 TS        | CPU 密集场景性能可能不够, 解密逻辑要逐位兼容, 验证成本高 |
| 命令行子进程封装      | 低频、粗粒度调用                      | 实现最简单, 崩溃隔离天然成立                                 | 每次调用都有进程创建开销, 大 buffer 走管道传输成本高     |

选型看三个维度: 有没有源码 (没有源码就排除 WASM 与纯 JS 重写, 只能在绑定方式与服务化之间选)、调用量与数据量 (决定对调用开销与序列化开销的敏感度)、对崩溃与内存风险的容忍度 (决定隔离层级: 进程内到子进程到独立服务)。拿到源码可优先评估 WASM 或纯 JS 重写; 调用量继续涨或需要多方复用则走服务化。

## TCP 连接池与连接异常处理

### 连接池的价值

管理端需要与数据库管理服务通信, 协议是 TCP 长连接。连接池在请求到来时借出一条连接, 用完归还复用:

- 省建连成本: TCP 三次握手加上对端的认证握手, 每次现建连都是毫秒级开销, 高频请求下累积明显。
- 控制连接数量: 对端对单个来源的连接数有限制, 连接池把并发连接数收敛到 max 以内, 不会把对端打满。
- 复用与预热: 常驻连接让请求直接命中热连接, 延迟稳定。

但 TCP 长连接不是"建好就永远可用", 连接池的核心难点正是异常处理: 连接失败、超时、对端主动关闭、静默断开, 每一种都要有明确策略。

### factory 模型

连接池围绕一个 factory 定义连接的生命周期, 异常处理的所有策略都落在这三个函数与池参数的配合上:

- create: 创建并初始化连接, 内部完成建连、认证握手, 并挂上 error 与 close 事件监听 (Node 的 socket 没有 error 监听器时, 一次错误会抛未捕获异常打崩进程)。create 内部必须带连接超时, 因为 TCP 连接可能长时间挂起 (被防火墙丢包时既不通也不拒), 超时要主动销毁并抛错。
- destroy: 彻底关闭 socket、释放文件描述符。
- validate: 借出前校验连接是否可用 (testOnBorrow 开启时调用), 通常检查存活标记并做协议层 ping。

不要在 create 里做无限重试。重试应由池的按需重建加上层有限次重试组成, create 内部死循环重试会把池卡死。

### 异常一: 连接失败

场景: 对端不可达 (网络故障、对端宕机、端口未监听), 或认证握手被拒绝, 此时 create 抛错。处理要点:

- 区分错误类型: 认证失败是配置错误, 重试没有意义, 应该快速失败并告警; 网络类错误 (ECONNREFUSED、超时) 可以交给池的重建机制。
- 池层面: create 失败后, 排队方在 acquireTimeoutMillis 内拿不到连接就抛错, 上层捕获后返回降级响应 (例如"管理服务暂时不可用"), 而不是让请求挂死。
- 背压: acquireTimeout 与 maxWaitingClients 共同限制排队规模, 池满时快速报错。

### 异常二: 请求超时

场景: 连接本身是通的, 但某次请求发出去后对端迟迟不响应 (对端负载高、请求卡住、中间链路丢包)。处理要点:

- 请求级超时: 每次在连接上发请求都带超时计时, 超过阈值判定失败。超时与连接失败要分开统计, 前者说明对端处理能力问题, 后者说明连通性问题。
- 超时后的连接处置是关键: 请求超时意味着这条连接上的协议状态已经不可信, 对端可能稍后把迟到的响应发回来, 污染下一个借用者的请求。正确做法是销毁这条连接, 让池补一条新的, 而不是归还复用。
- 归纳成一条原则: 任何让连接状态变得不确定的错误, 一律销毁, 绝不归还。只有明确"连接还干净"的场景 (业务层返回错误码、连接本身正常) 才归还。
- 是否重试: 读类请求可以换一条连接重试一次; 写类请求要看对端操作是否幂等, 不幂等就不能盲目重试。

### 异常三: 对端主动关闭连接

场景: 对端有自己的空闲连接回收策略、例行重启、发布维护, 会主动关闭连接, JS 侧收到 socket 的 close 或 FIN。处理要点:

- 连接上必须挂 error 与 close 事件监听, 监听后把连接标记为不可用, 并从池中驱逐。
- 池内感知: 要么通过事件回调主动驱逐 (pool.destroy), 要么依赖 testOnBorrow 在下次借出时用 ping 探活发现失效再销毁重建。两种机制并存时, 事件驱动是主路径, 探活是兜底。
- 规避对端空闲回收: 如果对端的空闲超时是已知的 (例如 5 分钟), 池的 idleTimeoutMillis 应设置得比对端更短, 让己方先回收空闲连接, 减少"借到一条对端已关闭的连接"的概率; 也可以发应用层心跳保活。
- 半关闭的细节: 对端发 FIN 只表示它不再发数据。Node 的 net.Socket 默认 allowHalfOpen=false, 收到 FIN 会自动 end 并触发 close, 半关闭只在显式开启 allowHalfOpen 时成立。因此判断连接可用性不能只看"socket 没报错", 要结合协议层 ping 的结果。

### 异常四: 静默断开

这是最隐蔽的一类: 中间网络设备重启、NAT 映射过期、链路丢包, 连接两端都没有收到 FIN/RST, 从 JS 侧看这条连接"一切正常", 直到下次写数据才发现不通, 或者请求发出去石沉大海。三层防御缺一不可:

- TCP keepalive: 开启 socket 的 keepalive 并设置较短的探测间隔, 让操作系统尽早发现死连接。默认的两小时探测间隔在生产环境基本没有意义, 必须调短。
- 应用层心跳: 比 keepalive 更可靠, 定期在协议层发 ping 并期待 pong, 连续 N 次无响应就判定连接死亡并驱逐。keepalive 探测包由对端内核的 TCP 协议栈直接应答, 不经过业务代码, 只能证明链路与对端协议栈活着; 心跳走业务协议, 能证明对端应用层还活着。
- 请求超时兜底: 即使前两者都漏了, 请求级超时仍能保证调用方不会永久挂起, 超时后按"状态不确定"原则销毁连接。

### 通用原则与可观测性

- 连接状态不确定就销毁: 超时、半关闭、写失败之后, 连接一律 destroy 由池重建, 绝不把脏连接归还给下一个借用者。
- 连接级错误与请求级错误分开: 业务错误码 (查询的表不存在) 不影响连接可用性, 正常归还; 传输层错误才触发销毁重建。
- 池自动补位: 销毁连接后池按 min 配置重建, 保证常驻容量; create 失败不会让池缩容到无法恢复。
- 有限重试加幂等前提: 失败请求换连接重试一次, 写操作以幂等为前提; 重试风暴比对端宕机本身更危险。
- 可观测性: 暴露池的借用等待时长、排队数、创建失败率、销毁原因分布。连接池的问题大多是从指标异常开始的。

### 与进程池的对照

进程池隔离的是"C++ .so 崩溃"这类进程内风险, TCP 连接池管理的是"跨进程、跨机器的连接生命周期"风险。两者都用了 generic-pool, 但 factory 的语义完全不同: 前者的 worker 是子进程, 健康检查是进程存活; 后者的 worker 是 TCP 连接, 健康检查是协议层探活。池化模型是通用的, 异常处理策略必须贴着被池化资源的特性设计。

## 闭包引用导致的内存泄漏排查

### 泄漏成立的两个条件

Node 服务长时间运行后堆内存持续缓慢增长、不随 GC 回落, 排查后定位到闭包引用导致的内存泄漏: 一些函数闭包捕获了大对象引用 (解析后的 XML 表数据、请求上下文), 而这些闭包被定时器、事件监听或长生命周期结构持有, 导致大对象永远可达。

机制层面:

- JS 函数在创建时捕获所在作用域的变量引用, 形成闭包。V8 中体现为函数对象上挂着一个 context 链, 指向它引用的外层变量集合。
- V8 的 GC 是标记-清除 (mark-and-sweep): 从 GC roots (全局对象、执行栈、活跃的内部结构) 出发标记所有可达对象, 不可达的才回收。
- 闭包只要被引用, 它捕获的变量就保持可达。所以问题不是"对象被闭包引用", 而是"闭包被长生命周期的东西引用, 且闭包捕获了不该长期持有的大对象"。

泄漏成立需要两个条件同时满足: 闭包捕获了大对象 (或会持续增长的结构); 闭包被长生命周期载体持有, 例如未清理的 setInterval/setTimeout、未移除的事件监听器、挂到全局或模块级变量上的回调、没有淘汰策略的缓存。只满足其一不会泄漏: 闭包捕获大对象但自身很快不可达, GC 正常回收; 闭包长期存活但只捕获小标量, 没有实际影响。

### 典型泄漏模式

- 定时器持有闭包: setInterval 没有清理, 闭包一直活着, 它捕获的数据永远可达。修复方式是保存句柄, 在明确的生命周期点 clearInterval/clearTimeout, 服务类对象要有 dispose 语义。
- 事件监听器未移除: 每次请求都注册监听、从不 removeListener, 监听回调的闭包累积, 每个都捕获了当次请求上下文。修复方式是注册与移除成对出现; EventTarget 类 API 可以用 `{ once: true }` 或 AbortController 的 signal 统一管理移除; 经典 EventEmitter 维护好对应的 removeListener。
- 闭包意外捕获大作用域: 同一作用域创建的所有闭包共享同一个 context, 只要有一个闭包捕获了大对象, 另一个只用了小变量、却被长生命周期持有的闭包也会让大对象一起常驻。V8 只把被内层函数引用的变量放进作用域的 context, 但共享 context 意味着捕获面是"整个 context"而不是"单个闭包实际用到的变量"。修复方式是缩小闭包捕获面: 把大对象的使用收敛到局部, 注册回调前把需要的字段提取成小变量, 必要时把注册逻辑拆到独立函数, 切断与大作用域的联系。
- 缓存只进不出: 缓存 Map 挂在全局, 闭包写入后没有任何淘汰路径。修复方式是加淘汰策略, 容量上限用 LRU, 或键是对象时改用 WeakMap, 让条目随键的回收自动消失。
- 被遗忘的全局引用: 调试时把大对象挂到 global 或模块顶层变量, 上线后没有移除。代码审查中禁止随手挂全局, 调试代码不进主干。

### 排查手段

1. 先确认现象, 区分堆内还是堆外。用 process.memoryUsage() 观察 heapUsed 与 rss: heapUsed 持续涨说明是 V8 堆内问题 (闭包泄漏属于这类); rss 涨而 heapUsed 平稳则要往 native 侧查, 用 valgrind 或 ASan 定位。判断泄漏先分清在哪个堆。
2. heap snapshot 三次快照对比法 (核心手段)。在服务稳定后拍第一次快照; 执行可疑操作 N 次 (例如反复触发解析请求); 再拍第二次; 手动触发 GC 后拍第三次。用 Comparison 视图对比第一次与第三次, 只看新增且未被回收的对象, 泄漏对象会成批出现。
3. 看保留链 (retainers)。选中可疑对象查看保留链, 保留链会一路指到 GC root。闭包泄漏的典型形态是对象到闭包到函数, 再到某个全局的定时器、监听器或 Map。保留链的终点就是修复的入口。
4. 定位闭包的捕获内容。在快照里函数节点可以看到它关联的 context 对象, 展开能看到闭包实际捕获了哪些变量, 确认是否意外捕获了大对象。
5. 辅助手段。Allocation instrumentation on timeline 适合定位"哪个操作路径在持续分配"; 生产环境不方便接调试器时, 可以周期性打 heapUsed 指标, 结合发布变更记录二分定位引入泄漏的版本。

### 修复后如何验证

用同样的三次快照法复测: 执行 N 次操作后, Comparison 视图里不应再有该类型的新增对象残留, heapUsed 曲线恢复锯齿形 (涨后被 GC 拉回)。

与其他问题的关联: 堆外的 native 泄漏表现为 RSS 涨而 heapUsed 平稳, 用 valgrind 排查; 本文的闭包泄漏是 JS 堆内问题, heapUsed 涨, 用 heap snapshot 排查。React 侧的闭包泄漏同样常见, useEffect 里注册的监听、定时器如果不在清理函数里释放, 组件卸载后闭包依然存活, 这也是组件迁移规范里要求严格检查清理函数的原因。

## 服务可观测性: 插桩、抓栈与三支柱落地

前文的内存排查依赖 heap snapshot、process.memoryUsage() 这类手动、按需的观测手段。要让同样的判断在生产环境持续成立, 需要把它们常态化: 持续产出指标、链路、错误与 profile 四类数据, 在其上建立看板与告警。这一节讲 JS 插桩、抓栈与 CPU Profiling 在企业级 Node 项目中的落地, 以及 Prometheus、Grafana、OpenTelemetry、Sentry 的组合方式 (Prometheus、Grafana、OpenTelemetry 的中间件侧机制与选型见 [后端中间件与基础设施](../be/middleware))。

### 三支柱与数据生产手段: 总述

可观测性数据按回答的问题分为三支柱:

| 支柱               | 回答的问题           | 数据形态                           | 典型工具             |
| ------------------ | -------------------- | ---------------------------------- | -------------------- |
| metrics            | 系统整体状态如何     | 聚合时序, 便宜、可长期保留、可告警 | Prometheus + Grafana |
| traces             | 这一次请求经历了什么 | 单请求的因果链, 跨服务串联         | OpenTelemetry        |
| errors 与 profiles | 具体错在哪、慢在哪   | 栈级数据, 直接指向函数与代码行     | Sentry               |

- metrics 是聚合口径: 单点成本极低, 适合大盘趋势与阈值告警, 但看不到任何一次具体请求; 前文"先看 rss 与 heapUsed 两条曲线的相对走势"的分诊, 常态化之后就是 metrics 看板。
- traces 记录单请求因果链: 每一跳的 span 与耗时, 回答跨服务慢请求卡在哪一段。
- errors 与 profiles 是栈级数据: 错误报告带异常堆栈, profile 带调用栈样本, 都直接回答"哪个函数哪一行"。

JS 插桩与抓栈是后两类数据的生产手段: traces 来自插桩 (在函数或请求的入口出口记录起止时间), profiles 来自抓栈 (周期性对调用栈做快照)。两种范式的本质区别、开销模型与取舍在 [插桩与抓栈的理论与方法](tiktok) 里已系统展开, 服务端与设备端是同一套理论, 只是实现载体不同。metrics 的生产手段则不同: 不插桩也不抓栈, 而是读取运行时暴露的计数器与快照 (process.memoryUsage()、v8.getHeapSpaceStatistics()、perf_hooks 等)。

### 运行时指标: RSS、V8 堆与事件循环

prom-client (15.1.3) 的 collectDefaultMetrics 一行代码注册全套默认指标, 是 Node 运行时指标的事实标准。按观测对象分组:

**内存类。** 指标口径与上文 "RSS 与 V8 堆内存: 两个口径的内存" 一节完全对齐 —— process_resident_memory_bytes 就是 OS 口径的 RSS, nodejs_heap_* 是 V8 托管区口径。数据源可以从源码直接确认: heap 系列指标取自 process.memoryUsage() 的 heapTotal/heapUsed/external 三个字段, heap space 系列取自 v8.getHeapSpaceStatistics(), RSS 指标在 Linux 上读 `/proc/<pid>/status` 的 VmRSS、其他平台读 process.memoryUsage() 的 rss 字段:

| 指标                                                                   | 含义                                                                       |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| process_resident_memory_bytes                                          | RSS, 进程驻留物理内存, OOM killer 与容器限制针对的口径                     |
| process_heap_bytes / process_virtual_memory_bytes                      | OS 口径的进程堆 (Linux 的 VmData) 与虚拟内存 (VmSize)                      |
| nodejs_heap_size_total_bytes / nodejs_heap_size_used_bytes             | V8 已申请的堆容量 / 存活对象占用                                           |
| nodejs_external_memory_bytes                                           | 绑定到 JS 对象的 C++ 对象内存 (含 Buffer 后备存储)                         |
| nodejs_heap_space_size_total_bytes / nodejs_heap_space_size_used_bytes | 按 space 细分的容量与占用, 带 space 标签 (new、old、code、large_object 等) |

**CPU 类。** process_cpu_seconds_total、process_cpu_user_seconds_total、process_cpu_system_seconds_total 均为累计秒数的 Counter, 用 rate() 折算使用率; 用户态与系统态分开, 便于区分"业务代码忙"与"内核调用忙"。

**事件循环类。** nodejs_eventloop_lag_seconds 及 min/max/mean/stddev 与 p50/p90/p99 分位数变体 (nodejs_eventloop_lag_min_seconds、nodejs_eventloop_lag_max_seconds、nodejs_eventloop_lag_mean_seconds、nodejs_eventloop_lag_stddev_seconds、nodejs_eventloop_lag_p50_seconds、nodejs_eventloop_lag_p90_seconds、nodejs_eventloop_lag_p99_seconds)。底层是 `perf_hooks.monitorEventLoopDelay({resolution})` 的统计值, 采样精度由 eventLoopMonitoringPrecision 控制, 默认 10ms。

**GC 类。** nodejs_gc_duration_seconds 是 Histogram, 带 kind 标签区分 GC 类型 (major、minor、incremental、weakcb); 底层用 perf_hooks.PerformanceObserver 观察 entryTypes ['gc'], 按 entry.detail.kind 归类 (NODE_PERFORMANCE_GC_MAJOR 即 major GC), 分桶可用 gcDurationBuckets 自定义。

**句柄、文件描述符与其他。** nodejs_active_handles 与 nodejs_active_handles_total、nodejs_active_requests 与 nodejs_active_requests_total、nodejs_active_resources 与 nodejs_active_resources_total 反映 libuv 侧活跃的句柄、请求与资源; process_open_fds 与 process_max_fds 是文件描述符用量与上限, 连接池泄漏这类问题 (见上文 TCP 连接池一节) 在这里有直接信号; process_start_time_seconds 与 nodejs_version_info 提供启动时间与版本元数据。

collectDefaultMetrics(config) 支持五个配置: register (自定义 Registry)、prefix (指标名前缀)、labels (附加公共标签)、eventLoopMonitoringPrecision、gcDurationBuckets。包内另有 Counter、Gauge、Histogram、Summary 四类自定义指标, 以及 Registry 与 Pushgateway (供短生命周期任务推送)。

自定义业务指标用同一套 API。以请求延迟 Histogram 为例:

```js
const httpDuration = new client.Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request latency in seconds",
  labelNames: ["method", "route", "status_class"],
  buckets: [0.01, 0.05, 0.1, 0.3, 1, 3],
});
```

标签基数纪律是自定义指标的第一约束: 标签值必须是有限可枚举集合 (路由模板、状态码段、操作类型), 不要把 userId、原始 URL、traceId 放进标签 —— 标签组合数就是时间序列数, 基数失控会直接压垮存储与查询。

OTel 路线: 项目已接入 OpenTelemetry 时, 指标可并入同一体系。PrometheusExporter (继承 MetricReader) 以 `{port, endpoint}` 配置启动内置 HTTP server 暴露 /metrics, Prometheus 照常抓取。semantic-conventions (1.40.0) 定义的一组实验性进程与事件循环指标名: `nodejs.eventloop.delay.{min,max,mean,stddev}`、nodejs.eventloop.time、nodejs.eventloop.utilization、process.cpu.time、process.cpu.utilization、process.memory.usage、process.memory.virtual、process.context_switches、process.disk.io —— 语义与 prom-client 默认指标一一对应, 只是命名风格不同; 两条路线选一条, 不要重复采集。

两条路线都是拉取模型: Prometheus 按固定周期主动抓取每个实例的 /metrics, 服务端不推送、不维护上报状态, 只负责备好一份当前快照。

### OpenTelemetry: 自动插桩与手动 span

本机核实的包版本: api 1.9.1、sdk-trace-base 2.7.0、sdk-metrics 2.7.0、sdk-node 0.222.0、exporter-prometheus 0.215.0、semantic-conventions 1.40.0。

装配入口是 NodeSDK, 关键选项:

| 选项                         | 用途                                                         |
| ---------------------------- | ------------------------------------------------------------ |
| instrumentations             | 自动插桩库数组                                               |
| serviceName                  | 服务名, 全部遥测数据的归属坐标                               |
| resource / resourceDetectors | 资源属性与自动探测 (主机、容器、环境)                        |
| spanProcessors               | span 处理器数组, 负责导出; 注意单数形式 spanProcessor 已废弃 |

一个真实的企业落地实例 (agent 服务的 observability 模块): 用 NodeSDK 装配自定义 SpanProcessor (Langfuse 导出器) 把 trace 导出到 Langfuse; 未配置密钥时整个模块降级为 no-op, 业务路径完全不受影响, 初始化失败也只记日志不抛错; initObservability 与 shutdownObservability 成对, 退出时 sdk.shutdown() 冲刷残余 span。这个 "NodeSDK + spanProcessors + 优雅降级" 的模式值得照抄: 可观测性是增强项而非依赖项, 自身故障必须被吞掉。

自动插桩库生态 (本机核实的清单) 按类别:

| 类别           | 库                                                                        |
| -------------- | ------------------------------------------------------------------------- |
| HTTP 框架      | http、express、koa、connect、hapi                                         |
| 数据库与缓存   | ioredis、mongodb、mongoose、mysql、mysql2、knex、generic-pool、dataloader |
| 消息与 RPC     | kafkajs、amqplib、grpc、aws-sdk、aws-lambda                               |
| 日志           | pino、bunyan                                                              |
| 网络与文件系统 | net、fs、dns                                                              |
| 其他           | graphql                                                                   |

开启后, 框架请求出入口、数据库调用、消息收发自动生成带耗时与属性的 span, 不改一行业务代码。这是企业语境下 JS 插桩的主路径: 标准层 (HTTP、DB、消息) 交给自动插桩全覆盖, 不手写探针。

手动 span 是补充: 用 tracer.startActiveSpan 在中间件层包 span、在关键业务路径埋 span (事务核心步骤、大文件解析、模型调用), 用 attributes 记录业务坐标 (租户、操作类型、数据规模)。自动插桩保证链路连续不断, 手动 span 保证关键业务节点可见。

跨服务上下文传播靠 traceparent 请求头: 出口请求自动注入当前 trace 上下文, 下游入口自动还原, 多个服务的 span 因此串成同一条 trace。

导出侧 OTLP 全家桶齐备: trace 有 exporter-trace-otlp-http、exporter-trace-otlp-grpc、exporter-trace-otlp-proto 三种协议, metrics 与 logs 各有对应的 exporter-metrics-otlp-_、exporter-logs-otlp-_; 后端是 Prometheus 时也可改用上一节的 PrometheusExporter 直接暴露 /metrics。

### Sentry Node: 错误、性能与持续 profiling

@sentry/node (10.49.0) 整体构建在 OpenTelemetry 之上: 依赖 @opentelemetry/api、core、instrumentation, 并内置 http、express、koa、ioredis、mongodb、mysql2、knex、graphql、kafkajs 等 instrumentation 库 —— 性能数据的采集路径直接复用 OTel 自动插桩, Sentry 提供的是上报、聚合、检索与告警平台。

错误上报就是错误场景下的抓栈, 一条错误事件携带:

- 完整异常堆栈: 抛出时刻的调用栈帧, 定位代码位置与调用路径的直接材料。
- includeLocalVariables 选项: 开启 LocalVariables 集成后, 报告在堆栈上附带每一帧的局部变量值, 大量错误不必本地复现就能从现场值判断成因。
- source map 还原: 上传 source map 后, 平台把编译压缩过的栈帧映射回源文件与行号, 栈直接呈现源码视角。

性能监控由 tracesSampleRate / tracesSampler 控制 trace 采样率。

持续 profiling 是 v10 的能力, 相关选项:

| 选项                                 | 语义                                                             |
| ------------------------------------ | ---------------------------------------------------------------- |
| profileSessionSampleRate             | profile 会话采样率, 默认 0 (关闭), 按会话采样                    |
| profileLifecycle: 'manual'           | 默认值, 手动控制 profiling 的启停                                |
| profileLifecycle: 'trace'            | profiler 随根 span 自动启停, 被采样的 trace 自动附带一段 profile |
| profilesSampleRate / profilesSampler | 已废弃, v10 之前配合 @sentry/profiling-node 的旧用法             |

trace 模式把 profiling 挂进 trace 生命周期: 请求被采样就顺带采集 CPU profile, 问题发生时调用链与同一时刻的栈样本同时可得, 免去"去生产复现一次"的环节。

ESM 项目注意 registerEsmLoaderHooks (默认 true): ESM 没有 require hook, 自动插桩依赖 loader hooks 生效; 包的导出入口 '.', './import', './loader', './init', './preload' 对应不同的加载与预加载方式。

Sentry 侧告警分两类: issue alert 针对错误事件 (新错误出现、错误回归、出现次数突增), metric alert 针对聚合指标 (错误率、延迟的阈值与持续时长)。前者回答"出了什么新错误", 后者回答"整体水位是否越线"。

### CPU Profiling: 生产环境的按需抓栈

生产 CPU profiling 有三种形态, 对应不同的问题节奏:

| 形态           | 手段                                                | 适用                              |
| -------------- | --------------------------------------------------- | --------------------------------- |
| 启动即采       | node --cpu-prof 家族参数, 退出落盘 .cpuprofile      | 可复现问题、短生命周期进程        |
| 运行时按需     | inspector.Session 调 Profiler API, 抓完即停         | 线上定向排查, 信号或管理端点触发  |
| 持续 profiling | Sentry profileLifecycle: 'trace', 随采样 trace 附带 | 常态化, profile 与 trace 天然关联 |

**启动即采。** --cpu-prof 开启采集, --cpu-prof-dir 指定输出目录, --cpu-prof-interval 设置采样间隔, --cpu-prof-name 指定文件名, 进程退出时自动落盘 .cpuprofile。适合两类场景: 问题能稳定复现时带参数跑一遍即可; CLI、构建脚本这类短生命周期进程没有运行时挂载的机会, 只能启动即采。

**运行时按需。** 通过 inspector.Session 依次调用 V8 Profiler 协议: Profiler.enable、`Profiler.setSamplingInterval({interval})` (interval 单位微秒, 越小越精细、开销越高)、Profiler.start 开始采集, 观察窗口结束后 Profiler.stop 取回 profile 并立即停止。触发方式通常是进程信号或受保护的管理端点。纪律: 有问题才开, 抓完即停, 不做无采样的长期开启。

**持续 profiling。** 即 Sentry 的 profileLifecycle: 'trace', 无需人工触发, 开销由采样率控制。

profile 的数据结构是 `{nodes, startTime, endTime, samples, timeDeltas}`: nodes 是压缩调用树, samples 记录每次采样的栈顶节点 id, timeDeltas 是相邻样本的间隔。从样本聚合出火焰图的方法 (inclusive/self 归因、横轴是样本占比不是时间、顶层宽平台是 self 热点) 与设备端完全一致, 见 [插桩与抓栈的理论与方法](tiktok), 此处不重复展开。

--prof 是另一条路径: V8 记录采样 tick 的原始日志, 离线用自带的 tick processor 分析, 属引擎级分析手段, 能看到时间在 JS 代码、GC、编译代码之间的分布, 适合判断"慢在业务代码还是引擎本身"。

与指标联动是企业环境的用法: 平时不开 profiling, CPU 告警 (rate(process_cpu_seconds_total[5m]) 异常) 或事件循环延迟告警 (nodejs_eventloop_lag_max_seconds 超阈值) 触发后再按需抓 profile, 同时可以用 process.report.getReport() 落一份诊断报告 (内存汇总与 libuv 句柄列表) 保留现场。指标回答"什么时候出了问题", profiling 回答"当时 CPU 在干什么"。

### Grafana 看板与告警设计

看板按观测对象分区, 每区一行:

| 分区     | 面板内容                                            | 主要指标                                                                                                                    |
| -------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 内存     | rss、heapUsed、external 三线叠加; 按 space 的堆占用 | process_resident_memory_bytes、nodejs_heap_size_used_bytes、nodejs_external_memory_bytes、nodejs_heap_space_size_used_bytes |
| 事件循环 | lag 的均值与最大值                                  | nodejs_eventloop_lag_mean_seconds、nodejs_eventloop_lag_max_seconds                                                         |
| GC       | 单位时间 GC 耗时占比, 按 kind 拆分                  | rate(nodejs_gc_duration_seconds_sum[5m])                                                                                    |
| 请求     | QPS、延迟分位、错误率                               | 自定义业务 Histogram 与 Counter                                                                                             |

内存面板直接服务前文的分诊法: rss 与 heapUsed 同图叠加, 两条曲线的相对走势一眼可辨堆内还是堆外问题。

告警规则示例 (指标名均出自上文核实的默认指标集; http_request_duration_seconds 为自定义业务 Histogram):

```yaml
groups:
  - name: node-service
    rules:
      # 内存泄漏趋势: 按最近 1 小时斜率外推 6 小时后的 RSS
      - alert: NodeMemoryLeakTrend
        expr: predict_linear(process_resident_memory_bytes[1h], 6 * 3600) > 1.5 * 1024 * 1024 * 1024
        for: 30m
      # 堆压力: 堆占用/堆容量持续高位
      - alert: NodeHeapPressure
        expr: nodejs_heap_size_used_bytes / nodejs_heap_size_total_bytes > 0.9
        for: 10m
      # GC 压力: 单位时间 GC 耗时占比超阈值
      - alert: NodeGcPressure
        expr: rate(nodejs_gc_duration_seconds_sum[5m]) > 0.3
        for: 10m
      # 事件循环延迟: 最大 lag 持续超阈值
      - alert: NodeEventLoopLag
        expr: nodejs_eventloop_lag_max_seconds > 0.1
        for: 5m
      # 延迟 SLO: P99 超阈值
      - alert: HttpP99LatencyHigh
        expr: histogram_quantile(0.99, sum(rate(http_request_duration_seconds_bucket[5m])) by (le)) > 1
        for: 10m
```

规则设计要点:

- 内存泄漏用 predict_linear 做趋势外推而非固定阈值: RSS 绝对值受实例规格与流量影响, "按当前斜率 6 小时后越过红线"才是泄漏的强信号, 对应上文"长期单调增长才算泄漏"的判断标准。
- SLO 告警推荐多窗口燃烧率: 短窗口高燃烧率 (快速发现) 与长窗口低燃烧率 (抑制误报) 两条规则配合定级, 兼顾灵敏度与噪音。
- 堆压力与 GC 告警联看: nodejs_heap_size_used_bytes/nodejs_heap_size_total_bytes 持续高位且 rate(nodejs_gc_duration_seconds_sum[5m]) 同步上升, 说明堆逼近上限、GC 在做无用功, 随后通常伴随事件循环延迟上升。
- 事件循环延迟可先用 avg_over_time(nodejs_eventloop_lag_mean_seconds[5m]) 看平滑趋势, 告警则用 max 口径抓尖峰。

告警设计原则:

- 症状优先于原因: 告警指向用户可感知的症状 (错误率、延迟、内存水位、事件循环延迟), 原因级异常 (单次 GC 变慢、某个句柄增多) 放看板辅助排查, 不做半夜叫醒人的触发器。
- SLO 燃烧率分级: 高燃烧率短窗口立即响应, 低燃烧率长窗口降级为工作时间通知。
- 按严重度路由: Alertmanager 按 severity 路由, 相关告警分组去重, 维护窗口静默, 配合抑制规则避免级联风暴。
- 抑制告警疲劳: 每条告警必须有对应的处理动作, 长期无人响应的告警要么降级要么删除。

分工上, Grafana unified alerting 负责规则定义与可视化 (可直接以 Prometheus 为数据源), Alertmanager 负责告警的分组、路由、静默、抑制与通知渠道; 纯 Prometheus 体系中规则写在 Prometheus rules 文件, Alertmanager 承接通知。

### 分工与选型

| 维度     | metrics                                    | traces               | errors             | profiles                                              |
| -------- | ------------------------------------------ | -------------------- | ------------------ | ----------------------------------------------------- |
| 成本     | 极低, 聚合数值                             | 中, 按请求采样       | 低, 出错才上报     | 较高, 栈采样, 靠采样率控制                            |
| 粒度     | 实例级聚合                                 | 单请求因果链         | 单次错误事件       | 单会话/单请求的时间切片                               |
| 典型问题 | 内存泄漏趋势、堆压、GC 压力、容量          | 跨服务慢请求定位     | 异常堆栈与错误成因 | CPU 热点、事件循环阻塞点                              |
| 工具     | prom-client 或 OTel + Prometheus + Grafana | OpenTelemetry + OTLP | Sentry             | --cpu-prof、inspector Profiler、Sentry 持续 profiling |

回到全文的方法论: 先界定问题, 再选工具。内存问题先分清堆内堆外 (rss 与 heapUsed 的相对走势), 再决定用 metrics 看趋势还是 heap snapshot 抓对象; 性能问题先分清聚合还是单请求, 再决定看 metrics 看板还是拉 traces 链路; CPU 热点由指标发现、由 profile 定位。可观测性不是工具堆叠, 而是让每一类问题都有"看得见、报得出来、定位得下去"的数据源。

## 适用场景与结论

- 组件迁移: 适合有明确映射规范、结构相似的组件批量重构。核心风险不在语法翻译, 而在 effect 依赖完整性、setState 合并语义、异步闭包过期值与请求竞态; 错误边界这类无 hook 等价物的组件必须保留类组件。
- native 绑定: 现成 .so、调用量不大时 ffi-napi 是成本最低的接入方式; 调用频率与数据体积上升、需要堆外内存与 GC 联动时迁移到 N-API Addon; 无论哪种绑定, 只要 native 代码不可信, 进程池的隔离层都不能省。
- 池化资源: 进程池解决崩溃与堆外泄漏的隔离, 连接池解决连接复用与状态治理。参数 (max、min、超时、驱逐) 的取值必须结合被池化资源的成本与故障特征, 通用默认值不足以覆盖生产场景。
- 内存排查: 先分清堆内堆外, 堆内用 heap snapshot 三次对比加保留链, 堆外用 valgrind 或 ASan; 修复后必须用同一套观测手段复测, 否则无法确认泄漏已收敛。
- 可观测性: 指标看聚合趋势 (RSS、堆压、GC、事件循环延迟), traces 看单请求因果链, errors 与 profiles 做栈级定位; 告警以症状与 SLO 燃烧率为准, 内存泄漏用 predict_linear 看趋势, CPU 与事件循环告警触发按需 profiling。
