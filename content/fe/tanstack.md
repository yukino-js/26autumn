---
title: "TanStack Query 服务端状态管理: 缓存、失效与数据同步"
description: "TanStack Query v5 的服务端状态缓存模型: queryKey 与确定性哈希、staleTime/gcTime 与失效语义、写后同步与乐观更新、分页与无限查询、预取与 SSR 水合, 以及与客户端状态、表单、虚拟列表的职责边界"
---

TanStack Query 解决的不是"如何管理前端状态", 而是"如何维护一份来自远端的、随时可能过期的数据副本"。它把服务端状态抽象为一层带缓存、失效、重取与垃圾回收策略的请求缓存, 让组件只声明"我要什么数据", 而不必自己维护加载态、错误态与一致性。本文按缓存模型、失效策略、写操作、分页、预取与服务端渲染这条主线展开, 并明确它与客户端状态库、表单库、虚拟列表库的职责边界, 适合正在引入或规范使用 TanStack Query 的前端工程师阅读。

## 一、服务端状态与客户端状态的边界

把状态按"权威来源在哪"分类, 是理解这一族工具的前提:

| 维度     | 服务端状态                         | 客户端状态                   |
| -------- | ---------------------------------- | ---------------------------- |
| 所有权   | 存在远端, 可能被其他客户端修改     | 存在浏览器内, 由本地交互产生 |
| 一致性   | 需要"获取、缓存、失效、再同步"机制 | 写入即最新                   |
| 生命周期 | 与组件挂载解耦, 可被多处共享       | 通常随组件或页面生命周期销毁 |
| 典型内容 | 用户资料、列表分页、消息记录       | 主题、选中项、表单草稿、令牌 |

结论是直接的: 服务端状态用查询缓存管理, 客户端状态用原子化或订阅式 store (如 Jotai、Zustand) 管理。把远端数据塞进全局 store 再手写失效, 等价于重新实现一个更弱的查询缓存; 反过来把纯本地交互状态放进查询缓存, 则会引入毫无必要的过期与重取语义。

## 二、对象模型与缓存

### 2.1 三个核心对象

```text
QueryClient (门面, 使用方唯一入口)
  QueryCache     查询实例注册表
    Query        单个查询: queryKey -> queryHash -> state
  MutationCache  变更实例注册表
    Mutation     单次写操作: idle -> pending -> success/error
  defaultOptions / queryDefaults / mutationDefaults
```

`QueryClient` 提供 `getQueryData`、`setQueryData`、`invalidateQueries`、`query`、`infiniteQuery` 等命令式 API, 并通过 Provider 注入组件树。它同时承载全局默认配置, 生产应用通常在这里统一调整重试与重取策略:

```ts
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
    mutations: {
      retry: 0,
    },
  },
});
```

把 `refetchOnWindowFocus` 关掉、把重试降到 1, 是交互密集型应用的常见取舍: 页面不希望因焦点切换产生静默重取, 重试过多也会放大后端压力。在测试或服务端渲染等多环境场景下, 建议用工厂函数返回独立的 QueryClient, 避免多个环境共享同一份缓存。

### 2.2 queryKey 与确定性哈希

查询缓存以 `queryHash` 为键保存 Query 实例, `queryHash` 由 queryKey 经过哈希函数计算。默认哈希对普通对象的键先排序再序列化, 对数组保持元素顺序:

| 写法                                                           | 是否同一缓存              |
| -------------------------------------------------------------- | ------------------------- |
| `['todos', { status, page }]` 与 `['todos', { page, status }]` | 相同 (对象键顺序无关)     |
| `['todos', { a: 1, b: undefined }]` 与 `['todos', { a: 1 }]`   | 相同 (undefined 键被忽略) |
| `['todos', status, page]` 与 `['todos', page, status]`         | 不同 (数组顺序即语义)     |
| `['todo', 5]` 与 `['todos', 5]`                                | 不同                      |

这带来两条实践规则。其一, 把描述数据的参数写进 key 的对应层级, 数组顺序用于表达层级语义。其二, key 中不要出现随机值、时间戳或每次渲染都新建的对象 `Date` 等不可稳定序列化的值, 否则每次都会命中新缓存。key 中出现的对象按内容哈希, 因此每次渲染新建同内容对象本身无害。

QueryCache 保证相同 queryHash 复用同一个 Query 实例: 多个组件挂同一个 key 时, 共享同一份数据与同一次在途请求, 这就是请求去重的底层机制。

### 2.3 staleTime、gcTime 与默认行为

两个时间选项常被混淆, 它们管的是不同事情:

- `staleTime` 决定"数据多久算过期"。过期不代表立即请求, 只是在合适的时机 (挂载、窗口聚焦、网络重连) 允许后台重取。
- `gcTime` 决定"数据没人观察后多久被删除"。它只影响内存回收, 不影响是否过期。

| 选项                   | 默认值                           | 说明                                     |
| ---------------------- | -------------------------------- | ---------------------------------------- |
| `staleTime`            | `0` (拿到即过期)                 | 默认下每次挂载、窗口聚焦都会允许后台重取 |
| `gcTime`               | 浏览器 5 分钟, 服务端 `Infinity` | 服务端每个请求本就新建缓存, 无需回收     |
| `retry`                | 客户端 3, 服务端 0               | 失败后静默重试                           |
| `retryDelay`           | 指数退避, 有上限                 | 配合重试使用                             |
| `refetchOnWindowFocus` | `true`                           | 窗口重新聚焦时重取过期查询               |
| `refetchOnReconnect`   | `true`                           | 网络重连时重取                           |
| `structuralSharing`    | `true`                           | 深度比对, 未变化部分保留旧引用           |

`staleTime` 除数字外还支持两个特殊值, 语义有细微差别:

| 值         | 行为                                                                                      |
| ---------- | ----------------------------------------------------------------------------------------- |
| `Infinity` | 不因过期而重取, 但 `invalidateQueries` 仍能使它失效                                       |
| `'static'` | 永不重取, 连 `invalidateQueries` 也对其无效, 且会屏蔽 `"always"` 形式的聚焦/挂载/重连重取 |

因此 `'static'` 适合"应用运行期间不会变化"的数据, 例如启动时拉取的特性开关、登录后加载的权限、静态参照表; 如果仍希望手动失效生效, 用 `Infinity`。

一条数据可以同时"已过期"和"仍在缓存中": 此时组件挂载会先用旧数据渲染, 同时在后台重取, 重取完成后原地替换。这是 TanStack Query 默认的"缓存优先、后台刷新"策略。

### 2.4 失效语义: invalidateQueries

失效是保证写后一致性的主力 API。它的行为可以拆成两步: 先把匹配的 Query 标记为 stale (该标记会覆盖 `staleTime`), 再对默认 `type: 'active'` 的匹配项发起后台重取——只有当前被组件观察的查询会立即重取, 未挂载的查询仅被标记, 等下次挂载再拉。

匹配规则是关键。默认走前缀式部分匹配: 过滤 key 中的每一位都必须与目标 key 的对应位置相等, 因此过滤 key 越短命中范围越大。

```ts
// 命中 ['todos']、['todos', { page: 1 }] 等所有以 todos 开头的查询
queryClient.invalidateQueries({ queryKey: ["todos"] });

// 只精确命中 ['todos'] 本身
queryClient.invalidateQueries({ queryKey: ["todos"], exact: true });

// 需要更细粒度时用谓词函数
queryClient.invalidateQueries({
  predicate: (query) =>
    query.queryKey[0] === "todos" && query.queryKey[1]?.version >= 10,
});

// 只标记过期、不触发重取
queryClient.invalidateQueries({ queryKey: ["todos"], refetchType: "none" });
```

这套匹配语义与 queryKey 的分层设计是一体两面: key 组织成从粗到细的层级树后, "按资源根失效整个域"与"按参数精确失效一条"都只是选择匹配范围。

MutationCache 收集 `useMutation` 产生的变更实例, 它与查询缓存的区别在于不参与 `invalidateQueries` 的匹配——该 API 只作用于查询缓存。变更实例同样按 `gcTime` 回收, 失活且非 pending 时被移除。

### 2.5 structuralSharing

每次成功获取后, 新数据会与旧数据做深度比对, 未变化的子树保留旧引用, 只有变化的部分换新引用。它的收益在配合 `select` 或 `React.memo` 时最明显: 列表中没有变化的行引用稳定, 不会因一次后台刷新而整树重渲染。

结构性共享只适用于 JSON 兼容的值。若 queryFn 返回 Map、Set 或含循环引用的对象, 会打印明确警告, 此时应关闭 `structuralSharing` 或改造返回值; 也可以传入自定义函数, 自定义"是否视为变化"的判定。

## 三、useQuery 的状态轴与默认行为

### 3.1 status 与 fetchStatus

查询结果有两个正交的状态轴, 理解它们才能正确渲染各种界面:

| 轴            | 取值                            | 含义                              |
| ------------- | ------------------------------- | --------------------------------- |
| `status`      | `pending` / `success` / `error` | 有没有可展示的数据                |
| `fetchStatus` | `idle` / `fetching` / `paused`  | 当前是否在请求, paused 为离线挂起 |

常见的组合状态:

| 组合                   | 界面含义               |
| ---------------------- | ---------------------- |
| `pending` + `fetching` | 首屏加载, 展示骨架     |
| `success` + `fetching` | 有旧数据, 正在后台刷新 |
| `success` + `idle`     | 数据就绪且无在途请求   |
| `error` + `idle`       | 重试耗尽后的终态       |

对应的布尔字段是: `isPending` 表示还没有数据可展示, `isFetching` 表示当前有在途请求 (含成功后的后台刷新), `isLoading` 是二者交集, 即首屏加载。

### 3.2 条件查询

`enabled: false` 时查询不发起请求, 常用于依赖尚未就绪的场景。需要注意它的语义边界: `enabled` 只是暂停拉取, 组件仍然持有查询观察者; 真正"按条件换数据"应该把条件放进 queryKey。

当查询依赖一个可能为空的参数时, 有两种稳妥写法: 用一个占位 key 避免把 `undefined` 混进真实 key 空间, 并在 queryFn 内做防御性断言, 因为 TypeScript 无法阻止 queryFn 被其他路径调用。

### 3.3 React 绑定层

React 绑定层很薄: `useBaseQuery` 用 QueryObserver 订阅核心缓存, 通过 `useSyncExternalStore` 接入 React 18+ 的并发渲染, 并对结果对象做属性访问追踪, 以减少不必要的重渲染。因此升级到并发渲染后, 查询状态的读取是安全的。

## 四、queryKey 的分层设计

queryKey 是缓存的地址。把它组织成从粗到细的层级树, 才能让失效操作按任意粒度进行。集中式 key 工厂是这里最有效的工程手段:

```ts
export const queryKeys = {
  user: {
    all: ["user"] as const,
    current: ["user", "current"] as const,
    listPage: (params: UserQueryRequest) => ["user", "list", params] as const,
  },
  app: {
    all: ["app"] as const,
    byId: (id: AppId) => ["app", "byId", id] as const,
    myList: (params: AppQueryRequest) => ["app", "my", params] as const,
    adminList: (params: AppQueryRequest) => ["app", "admin", params] as const,
  },
} as const;
```

| 层         | 示例                              | 失效语义                       |
| ---------- | --------------------------------- | ------------------------------ |
| 资源根     | `queryKeys.user.all`              | 命中 user 域全部查询           |
| 固定子键   | `queryKeys.user.current`          | 只命中当前用户查询             |
| 参数化函数 | `queryKeys.user.listPage(params)` | 参数并入 key, 不同参数互不覆盖 |

三点设计意图:

- 全部用 `as const` 固化字面量类型, 配合类型工具可让 `setQueryData` 等操作获得精确的类型推导。
- 列表查询把整个参数对象放进 key, 借助对象键排序, 同一组过滤条件无论字段书写顺序如何都命中同一缓存。
- 分页查询把页码与游标并入 key, 页与页各自独立缓存, 翻页不覆盖上一页。

对小应用, 就近导出的 key 常量已足够; 一旦失效需求变复杂 (例如"登出时清掉所有会话与历史"), 分散的 key 就容易漏。是否引入集中工厂, 取决于失效操作是否已经成为跨模块的一致性负担。

## 五、useMutation 与写后同步

### 5.1 状态机与回调时序

Mutation 的状态流转是 `idle -> pending -> success | error`, 由 `mutate` 驱动。回调的执行顺序固定:

```text
onMutate (MutationCache 级 -> 选项级)
  -> mutationFn
  -> onSuccess / onError
  -> onSettled
```

全局级回调可在创建 QueryClient 时通过 mutationCache 配置, 适合统一的错误上报。局部错误处理通常放在调用 `mutate` 时传入的第二个参数里。需要注意 mutation 的重试默认值是 0, 与查询的重试默认值 (客户端 3) 分开——写操作重试可能造成重复提交, 保持默认或显式设为 0 更安全。

### 5.2 三种写后策略

写操作完成后如何让缓存与远端一致, 常见三种策略, 复杂度与一致性各不相同:

| 策略     | 做法                                   | 适用                                         |
| -------- | -------------------------------------- | -------------------------------------------- |
| 纯包装   | 只包装 mutationFn, 不动缓存            | 界面更新不依赖缓存, 例如流式输出、事件型接口 |
| 写后失效 | onSuccess 中按层级 `invalidateQueries` | 写操作影响面大、服务端为权威                 |
| 写后直写 | onSuccess 中 `setQueryData` 写入响应体 | 响应体本身就是完整的最新实体                 |

写后失效的要点是按影响面选择失效范围: 修改一条详情时, 既失效该条 (按 id 前缀精确失效), 也失效所属列表域 (更新可能影响任意列表的排序与可见性); 新增或删除只影响列表, 因此只需失效列表域。

写后直写的典型是登录: 登录响应本身包含完整的当前用户信息, 直接写入 `current` 缓存即可, 无需等下一次请求; 登出则对称地把当前用户置空, 界面同步退出, 再失效整个域兜底。选择哪种策略, 取决于响应体是否为权威且完整的实体数据。

### 5.3 乐观更新

乐观更新让界面在服务端确认前就反映用户操作, 代价是需要自己处理回滚。标准流程由五个步骤组成:

```ts
useMutation({
  mutationFn: updateTodo,
  onMutate: async (variables) => {
    // 1. 取消同 key 的在途请求, 防止它们覆盖乐观值
    await queryClient.cancelQueries({
      queryKey: queryKeys.todo.byId(variables.id),
    });
    // 2. 保存旧值快照用于回滚
    const previous = queryClient.getQueryData(
      queryKeys.todo.byId(variables.id),
    );
    // 3. 立即写入乐观值
    queryClient.setQueryData(queryKeys.todo.byId(variables.id), (old) => ({
      ...old,
      ...variables,
    }));
    return { previous };
  },
  onError: (_err, variables, context) => {
    // 4. 失败时用快照回滚
    if (context?.previous) {
      queryClient.setQueryData(
        queryKeys.todo.byId(variables.id),
        context.previous,
      );
    }
  },
  onSettled: (_data, _error, variables) => {
    // 5. 无论成败, 最终以服务端为准
    void queryClient.invalidateQueries({ queryKey: queryKeys.todo.all });
  },
});
```

四条硬约束:

- 乐观写入的 key 必须与查询侧完全一致, 最好由同一份 key 工厂生成, 否则写了等于没写。
- `cancelQueries` 不能省略, 否则在途旧请求的响应可能在后到达并覆盖乐观值, 表现为界面闪回旧数据。
- 回滚只能靠 `onMutate` 中保存的快照, 库本身不提供自动回滚。
- `onSettled` 的失效是最终一致性兜底。若业务能接受"服务端永远成功", 也可以只在 `onError` 中处理。

对低频、响应快的管理类写操作, 乐观更新带来的复杂度往往不划算, 写后失效更简单可靠; 对高频、交互手感要求高的操作 (勾选、拖拽、即时编辑), 乐观更新收益明显。

### 5.4 命令式读取变更状态

Mutation 不参与失效匹配, 但它可以通过 `useMutationState` 或 `MutationCache.findAll` 按 key 或状态过滤。设置 `mutationKey` 后, 可以在其他组件里读取"某类变更是否正在提交/最近是否失败", 适合全局提交指示器或统一的失败提示。

## 六、分页与无限查询

分页有两种形态, 取舍清晰:

| 形态                         | 适用                 | 优点                         | 代价                           |
| ---------------------------- | -------------------- | ---------------------------- | ------------------------------ |
| 参数并入 key 的普通 useQuery | 页码式导航、管理后台 | 每页独立缓存与失效, 逻辑简单 | 滚动加载需自己拼接             |
| `useInfiniteQuery`           | 滚动信息流、聊天记录 | 多页自动聚合, 游标语义内建   | pages 整体缓存, 局部失效不灵活 |

`useInfiniteQuery` 的核心是由使用方提供的两个游标函数: `getNextPageParam(lastPage, allPages)` 与可选的 `getPreviousPageParam`。拉下一页时, 取上一页 `getNextPageParam` 的返回值作为新 pageParam; `hasNextPage` 即"`getNextPageParam` 返回非 null"。返回结果额外提供 `fetchNextPage`、`fetchPreviousPage`、`isFetchingNextPage` 等字段。

```ts
const query = useInfiniteQuery({
  queryKey: ["feed", channelId],
  queryFn: ({ pageParam }) => fetchFeed({ channelId, cursor: pageParam }),
  initialPageParam: null,
  getNextPageParam: (lastPage) => lastPage.nextCursor ?? null,
});
```

聊天记录这类"只向后追加、按时间游标翻页"的数据是 `useInfiniteQuery` 的经典场景; 管理端"按页码跳转加过滤条件"则普通分页更合适, 因为每页独立失效比整体 pages 缓存更灵活。

## 七、预取、服务端渲染与持久化

### 7.1 预取

预取的本质是"在组件挂载前把数据写进缓存"。命令式入口是 `queryClient.query(options)` 与 `queryClient.infiniteQuery(options)`: 二者返回 Promise、可 `await`、会应用 `select`, 并在未显式指定时默认 `retry: false` (命令式调用没有组件承接重试)。三种常见意图对应三种写法:

| 意图                                    | 写法                                                           |
| --------------------------------------- | -------------------------------------------------------------- |
| 取到数据并等待 (可读结果、可捕获错误)   | `await queryClient.query(options)`                             |
| 即发即忘的纯预取 (不关心结果与错误)     | `void queryClient.query(options).catch(noop)`                  |
| 已有新鲜缓存则直接用, 否则拉取 (ensure) | `await queryClient.query({ ...options, staleTime: "static" })` |

ensure 语义的关键在 `staleTime: "static"`: 有缓存数据时它永不视为过期、直接返回缓存; 无缓存数据时仍会发起请求。

```ts
// 路由跳转前预取; 缓存 10 秒内有效则不重拉
await queryClient.query({
  queryKey: queryKeys.app.byId(id),
  queryFn: () => getAppById(id),
  staleTime: 10_000,
});
```

推荐把查询选项抽成可复用的 `queryOptions(...)` 结果, 让同一份选项同时服务于 `useQuery` 与命令式 API, 避免两者的 key 或 queryFn 漂移。React 侧另有在渲染期触发预取的 `usePrefetchQuery`。

### 7.2 SSR 水合

服务端渲染链路分三步: 服务端用 `dehydrate(client)` 把缓存序列化为纯数据, 随 HTML 下发; 客户端用 `hydrate(client, dehydratedState)` 还原缓存; React 层用 `HydrationBoundary` 组件把水合数据接入组件树。水合后的查询与正常查询无异, 该过期的过期, 该回收的回收。由于服务端的 gcTime 默认为 `Infinity`, 服务端不会因为无人观察而回收数据。

### 7.3 缓存持久化

`persistQueryClient` 可以把缓存写入 localStorage 或 IndexedDB, 用于离线可用或冷启动加速。它需要配合缓存版本号与允许持久化的条件, 否则升级数据结构后可能读到不兼容的旧缓存。需要注意区分: 客户端偏好设置适合持久化, 服务端状态一般不做本地持久化, 除非有明确的离线需求。

## 八、Devtools 与调试

React Query Devtools 以独立面板形式挂载, 直观展示:

- 缓存中每个查询的 key、状态轴、数据新鲜度 (fresh/stale/inactive)。
- 查询的观察者数量、最近一次更新时间、在途请求。
- 变更实例列表及其状态, 便于排查"提交后缓存为何没更新"。
- 手动触发失效、重取、移除缓存, 验证失效范围是否符合预期。

调试时的常用判断顺序: 先看 key 是否命中预期缓存 (排查 key 漂移), 再看查询是 fresh 还是 stale (排查 staleTime 配置), 然后看是否有 active observer (排查是否被标记却未重取), 最后看 mutation 的 onSuccess 是否真的触发了失效。

## 九、与客户端状态、表单、虚拟化的职责边界

TanStack Query 只负责服务端状态, 与相邻库的边界可以用一张表说清:

| 需求                       | 归属                             | 说明           |
| -------------------------- | -------------------------------- | -------------- |
| 远端数据、需要过期与重同步 | Query                            | 服务端状态     |
| 本地交互状态、UI 开关      | Jotai / Zustand / 组件状态       | 客户端状态     |
| 表单字段值与校验           | 表单库 (如 TanStack Form)        | 只在本地下沉   |
| 长列表 DOM 虚拟化          | 虚拟列表库 (如 TanStack Virtual) | 只管测量与定位 |

几个常见边界:

- 同一事实的两面。服务端返回的"当前用户"进查询缓存; 由它派生出的"是否已登录"布尔值属于客户端派生状态, 用选择器或派生原子表达即可, 不必再进缓存。
- 令牌与请求头。认证令牌是客户端状态, 交给 store 并在请求客户端统一注入, 不要放进 queryKey。把令牌放进 key 会导致登录态变化时所有缓存 key 失效重来。
- 表单与提交。表单库负责字段值、校验与提交时机, Query 负责请求生命周期; 两者在提交点汇合, 即表单的 `onSubmit` 调用 mutation, 用 mutation 的 pending 状态禁用按钮。
- 流式与瞬态数据。流式增量 (如 SSE 逐字输出) 是瞬态客户端状态, 若逐块写入查询缓存会引发高频缓存更新; 更适合用 ref 或局部状态承接, 结束后一次性提交。
- 虚拟列表。虚拟化只负责把可视项渲染出来, 数据来源仍是查询缓存; 但滚动请求下一页时应触发 `fetchNextPage`, 而不是把滚动位置写进缓存。

## 十、常见陷阱

1. queryKey 里放不可稳定序列化的值 (随机数、时间戳、每次新建且内容会变的对象), 导致每次渲染都命中新缓存; 或把 `undefined` 之外的空值混进真实 key 空间。用占位 key 或 key 工厂约束。
2. 保持 `staleTime` 默认 0 却忘了关 `refetchOnWindowFocus`, 表现为切回标签页就请求刷屏。应在 QueryClient 默认值里统一处理。
3. mutation 成功后只改了本地 UI 状态、不失效缓存, 列表仍旧直到手动刷新。对策是把 `invalidateQueries` 写进 hook 的 `onSuccess`, 而不是散落在页面里。
4. 误以为 `gcTime` 控制过期。`gcTime` 只负责无人观察后的删除, 过期由 `staleTime` 决定; 调大 `gcTime` 不会减少请求, 只会多占内存。
5. 用 `enabled` 模拟"卸载": 组件仍持有观察者, 只是不发请求。真正换数据应把条件放进 queryKey。
6. `setQueryData` 的 key 与查询侧不一致。手写字面量极易差一个字段, 导致"写了缓存但没生效", 应坚持用同一份 key 工厂。
7. 期望 mutation 跟随查询的重试次数。mutation 默认 `retry: 0`, 写操作重试可能重复提交。
8. 乐观更新忘写 `cancelQueries`, 在途旧请求覆盖乐观值。
9. 无过滤条件地调用 `invalidateQueries`, 等于全站重取; 生产代码应始终传明确的 key 前缀。
10. `structuralSharing` 与非 JSON 数据冲突, 控制台警告且引用稳定失效, 此时应关闭该特性或改造返回值。

## 十一、适用场景与选型建议

适合使用:

- 数据来自远端、需要缓存与后台同步的应用。列表、详情、分页、无限滚动都能直接用现成能力表达。
- 需要请求去重与统一加载/错误态的场景。同一 key 被多处使用只发一次请求。
- 需要写后一致性策略的场景。失效、直写、乐观更新三种手段按业务成本选择。
- 需要预取与服务端渲染水合的应用。路由切换前预取、SSR 首屏直出都能复用同一套缓存模型。

不适合或需谨慎:

- 纯客户端状态 (主题、开关、草稿)。放进查询缓存只会带来无意义的过期与重取; 用 Jotai、Zustand 或组件状态即可。
- 高频、瞬态的流式数据。逐块写入缓存的收益低于开销, 应放在 ref 或局部状态里。
- 极简的一次性数据获取。没有跨组件共享与失效需求时, 直接 `fetch` 加组件状态更轻。

与替代方案相比: 手写请求缓存需要自行实现去重、过期、失效、重试与竞态处理, 复杂度容易被低估; SWR 提供了相近的缓存模型但失效与命令行 API 的覆盖面更窄; 服务端框架内置的数据获取约定在渲染模型上更贴合, 但把缓存能力绑定到了框架。TanStack Query 的位置是框架无关的通用服务端状态层, 只要应用里有"多处以不同方式消费同一份远端数据"的需求, 它带来的收益通常就能覆盖引入成本。
