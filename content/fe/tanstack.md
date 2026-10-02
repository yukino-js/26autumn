---
title: "TanStack Query、TanStack Form、TanStack Virtual 技术笔记"
description: "基于 yukino-chatbot 与 yukino-codegen 真实源码, 梳理 TanStack Query v5 的缓存模型、queryKey 设计、失效策略, 以及与 Jotai、TanStack Form、TanStack Virtual 的职责分工 (leetcode 的 TanStack Start/DB 生态依赖仅作声明参考)"
---

> 本文所有"真实项目用法"均来自本机仓库 `$HOME/github/yukino-chatbot` (Jotai + TanStack Query v5 的 LLM 聊天应用, 前端为 Vite 8) 与 `$HOME/github/yukino-codegen` (TanStack Query + Form + Virtual 的代码生成平台, 前端为 Vite 7), 另参考 `$HOME/github/leetcode` (其 package.json 声明了全套 TanStack 生态依赖, 见下文). 通用机制论断均对照 `$HOME/github/yukino-chatbot/client/node_modules/@tanstack/` 下 @tanstack/query-core 5.104.0 与 @tanstack/react-query 5.104.0 的真实 TypeScript 源码核实, 出处以包内相对路径 (`src/...`) 标注.

## 一、定位: 服务端状态 vs 客户端状态

TanStack Query 解决的是服务端状态 (Server State) 问题, 而不是传统意义上的前端状态管理. 服务端状态有几个与客户端状态本质不同的特征:

| 维度     | 服务端状态                         | 客户端状态                            |
| -------- | ---------------------------------- | ------------------------------------- |
| 所有权   | 存在远端, 随时可能被其他客户端修改 | 存在浏览器内, 由本地交互产生          |
| 一致性   | 需要"获取-缓存-失效-再同步"机制    | 写入即最新, 无需同步                  |
| 生命周期 | 与组件挂载无关, 可被多处共享       | 通常随组件卸载而销毁                  |
| 典型内容 | 用户资料、列表分页、聊天记录       | 主题、当前选中的会话、表单草稿、token |

因此 TanStack Query 的核心抽象不是 store, 而是一个带缓存、失效与垃圾回收策略的请求缓存层; 而 Jotai、Zustand 这类原子化 store 负责的是客户端状态. yukino-chatbot 正是按这条边界做拆分的 (详见第八章).

### 本机安装版本事实

以下版本均从本机 `pnpm` 虚拟仓库目录 `node_modules/.pnpm` 中各包的 `package.json` 读取, 两个仓库安装的是同一套版本:

| 包                      | 安装版本 | 仓库                           |
| ----------------------- | -------- | ------------------------------ |
| @tanstack/react-query   | 5.104.0  | yukino-chatbot, yukino-codegen |
| @tanstack/query-core    | 5.104.0  | yukino-chatbot, yukino-codegen |
| @tanstack/react-form    | 1.33.5   | yukino-chatbot, yukino-codegen |
| @tanstack/form-core     | 1.33.5   | yukino-chatbot, yukino-codegen |
| @tanstack/react-virtual | 3.14.13  | yukino-chatbot, yukino-codegen |
| @tanstack/virtual-core  | 3.17.11  | yukino-chatbot, yukino-codegen |
| jotai                   | 2.20.3   | yukino-chatbot                 |
| react                   | 19.3.0   | yukino-chatbot, yukino-codegen |

以下为 `$HOME/github/leetcode/package.json` 中声明的 TanStack 生态依赖 (除 @tanstack/router-cli 外版本均写作 latest, 仅展示生态面貌, 与上表的实际安装版本无关):

    "@tanstack/devtools-event-client": "latest",
    "@tanstack/devtools-vite": "latest",
    "@tanstack/match-sorter-utils": "latest",
    "@tanstack/query-db-collection": "latest",
    "@tanstack/react-db": "latest",
    "@tanstack/react-devtools": "latest",
    "@tanstack/react-form": "latest",
    "@tanstack/react-query": "latest",
    "@tanstack/react-query-devtools": "latest",
    "@tanstack/react-router": "latest",
    "@tanstack/react-router-devtools": "latest",
    "@tanstack/react-router-ssr-query": "latest",
    "@tanstack/react-start": "latest",
    "@tanstack/react-store": "latest",
    "@tanstack/react-table": "latest",
    "@tanstack/router-cli": "^1.167.39",
    "@tanstack/store": "latest",

另外注意上表中 @tanstack/react-virtual 的安装版本是 3.14.13, 而它依赖的 @tanstack/virtual-core 是 3.17.11——react-virtual 3.14.13 的 package.json 中对 virtual-core 声明的就是精确版本 3.17.11, 两者版本号不对齐是 TanStack 生态各包独立发版的体现: core 包与框架适配包各自迭代, 版本并不同步.

## 二、核心对象模型: QueryClient、QueryCache、MutationCache

### 对象关系

```text
QueryClient (门面)
├── QueryCache (查询实例的注册表)
│     └── Query (单个查询: queryKey -> queryHash -> state)
├── MutationCache (变更实例的注册表)
│     └── Mutation (单次变更: idle -> pending -> success/error)
└── defaultOptions / queryDefaults / mutationDefaults
```

- QueryClient 是使用方唯一需要接触的入口, 提供 `getQueryData`、`setQueryData`、`invalidateQueries`、`prefetchQuery` 等命令式 API. yukino-codegen 通过工厂函数创建它, 见 `yukino-codegen/client/src/shared/query/query-client.ts`:

```ts
import { QueryClient } from "@tanstack/react-query";

export function createQueryClient(): QueryClient {
  return new QueryClient({
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
}

export const queryClient = createQueryClient();
```

工厂函数 `createQueryClient` 的意义在于: 每个运行环境 (浏览器、测试、未来的 SSR 请求) 都拿到独立的缓存实例, 避免跨环境串缓存. yukino-chatbot 则直接导出单例 `queryClient`, 见 `yukino-chatbot/client/src/api/query-client.ts`:

```ts
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 1000 * 60 * 5, // 5 minutes
    },
  },
});
```

两个项目都把 `refetchOnWindowFocus` 关掉、把 queries 的 `retry` 降到 1, 这是交互密集型应用的常见取舍: 页面不希望因焦点切换产生静默重拉, 重试过多也会放大后端压力.

### QueryCache 与 queryHash 去重

QueryCache 以 queryHash 为键保存 Query 实例. queryHash 由 queryKey 经 `hashQueryKeyByOptions` 计算, 默认实现是 `hashKey` (`@tanstack/query-core/src/utils.ts:266`、`src/utils.ts:284`):

```ts
export function hashKey(queryKey: QueryKey | MutationKey): string {
  return JSON.stringify(queryKey, (_, val) =>
    isPlainObject(val)
      ? Object.keys(val)
          .sort()
          .reduce((result, key) => {
            result[key] = val[key];
            return result;
          }, {} as any)
      : val,
  );
}
```

两个要点:

1. 普通对象的键在序列化前会先排序, 所以 `["app", { a: 1, b: 2 }]` 与 `["app", { b: 2, a: 1 }]` 的哈希相同, 键书写顺序不影响缓存命中.
2. 数组元素顺序不参与排序, `["a", 1]` 与 `["a", 2]`、`[1, "a"]` 都是不同的 key, 数组顺序即语义, 这正是 queryKey 分层设计的基础.

QueryCache 的 `build` 方法 (源码见 `@tanstack/query-core/src/queryCache.ts` 中 `build` 方法, 注释示例位于 `src/queryCache.ts:141`) 保证: 相同 queryHash 复用同一个 Query 实例, 多个组件挂同一个 key 时共享一份数据与一次在途请求.

### invalidateQueries 的实现

`invalidateQueries` 是失效策略的核心, 实现位于 `@tanstack/query-core/src/queryClient.ts:469`:

```ts
invalidateQueries<TTaggedQueryKey extends QueryKey = QueryKey>(
  filters?: InvalidateQueryFilters<TTaggedQueryKey>,
  options: InvalidateOptions = {},
): Promise<void> {
  return notifyManager.batch(() => {
    this.#queryCache.findAll(filters).forEach((query) => {
      query.invalidate()
    })

    if (filters?.refetchType === 'none') {
      return Promise.resolve()
    }
    return this.refetchQueries(
      {
        ...filters,
        type: filters?.refetchType ?? filters?.type ?? 'active',
      },
      options,
    )
  })
}
```

语义拆解:

1. 先找出所有匹配 filters 的 Query, 逐个调用 `query.invalidate()`. `Query.prototype.invalidate` 只是把 state 置为 `isInvalidated: true` 并通知观察者 (`@tanstack/query-core/src/query.ts:574`), 本身不发请求.
2. 除非 `refetchType` 为 `'none'`, 否则紧接着对匹配集合做 `refetchQueries`, 默认 `type: 'active'`, 即只重新拉取当前有组件在观察的查询; 未挂载的查询仅被标记为过期, 下次挂载时才拉取.

匹配规则在 `matchQuery` (`@tanstack/query-core/src/utils.ts:175`): 传了 `exact: true` 时按 queryHash 精确匹配; 默认走 `partialMatchKey` (`src/utils.ts:300`) 做前缀式部分匹配——过滤 key 中出现的每一位都必须在目标 key 的对应位置相等, 过滤 key 越短命中范围越大. 这就解释了为什么用 `["user"]` 做失效 key 能覆盖 `["user", "current"]` 和 `["user", "list", params]` 整棵子树.

### MutationCache 与 Mutation 状态机

MutationCache 收集 `useMutation` 产生的 Mutation 实例. Mutation 的状态机在 `@tanstack/query-core/src/mutation.ts` 中, 状态流转与对应代码位置:

| 状态    | 触发                      | 源码位置              |
| ------- | ------------------------- | --------------------- |
| idle    | 初始状态                  | `src/mutation.ts:531` |
| pending | `execute` 开始            | `src/mutation.ts:477` |
| success | mutationFn 成功返回       | `src/mutation.ts:488` |
| error   | mutationFn 抛出或重试耗尽 | `src/mutation.ts:499` |

Mutation 实例同样登记在 MutationCache 中 (`src/mutationCache.ts:157`), 并继承 Removable 的 `gcTime` 回收: 失去观察者且状态不为 pending 时从缓存移除, 仍在 pending 时顺延一个 `gcTime` (`src/mutation.ts:203` 的 `scheduleGc`、`src/mutation.ts:212-220` 的 `optionalRemove`). 它与 Query 的区别在于不参与 `invalidateQueries` 的失效匹配 (该 API 只作用于查询缓存); 设置 mutationKey 后, 可以用 `useMutationState` 或 `MutationCache.findAll` 按 key/状态过滤变更实例. Mutation 的职责是承载一次写操作的生命周期回调 (onMutate/onSuccess/onError/onSettled) 与全局状态查询 (`useMutationState`).

### gc: 缓存回收

Query 与 Mutation 都继承自 Removable (`@tanstack/query-core/src/removable.ts`). 当一个查询失去所有观察者后, `scheduleGc` 会启动一个 `gcTime` 定时器, 到期调用 `optionalRemove()` 把自己从缓存中移除 (`src/removable.ts:23-31`, 其中 `optionalRemove()` 的调用在 `src/removable.ts:28`):

```ts
protected updateGcTime(newGcTime: number | undefined): void {
  // Default to 5 minutes (Infinity for server-side) if no gcTime is set
  this.gcTime = Math.max(
    this.gcTime || 0,
    newGcTime ?? (isServerEnvironment() ? Infinity : 5 * 60 * 1000),
  )
}
```

上面的 `updateGcTime` 实现位于 `src/removable.ts:33-39`, 其中的 `Math.max` 保证同一条数据被多处以不同 gcTime 观察时取最长值. 默认值事实 (见 `@tanstack/query-core/src/types.ts:317` 的 `gcTime` 注释): 浏览器环境默认 5 分钟, 服务端环境 (SSR) 默认 `Infinity`——因为服务端每个请求本来就会创建新的 QueryClient, 无需回收.

注意区分: gcTime 决定"多久没人看就删掉缓存", staleTime 决定"多久算过期需要重拉". 一条数据可以"过期但仍留在缓存里" (stale 且未被 gc), 此时组件挂载会先用旧数据渲染, 同时后台重新拉取.

## 三、useQuery 关键选项与生命周期

### status 与 fetchStatus 双轨

`useQuery` 的结果有两个正交的状态轴:

| 轴          | 取值                            | 含义                               |
| ----------- | ------------------------------- | ---------------------------------- |
| status      | `pending` / `success` / `error` | 有没有数据可展示                   |
| fetchStatus | `idle` / `fetching` / `paused`  | 当前是否在请求 (paused 为离线挂起) |

组合出常见的界面状态: `pending + fetching` 首屏加载; `success + fetching` 有旧数据时的后台刷新; `error + idle` 重试耗尽后的终态. 对应到布尔字段: `isPending` 表示还没有数据可展示, `isFetching` 表示当前有在途请求 (含成功后的后台刷新), `isLoading` 是二者的交集 (`isPending && isFetching`, 即首屏加载).

React 绑定层非常薄: `useBaseQuery` 用 `QueryObserver` 订阅核心缓存, 通过 `useSyncExternalStore` 接入 React 18+ 的并发渲染, 并用 `trackResult` 做属性访问追踪以减少不必要的重渲染 (`@tanstack/react-query/src/useBaseQuery.ts:95`、`src/useBaseQuery.ts:138`).

### 默认值速查表

以下默认值来自 `@tanstack/query-core/src/types.ts` 的 JSDoc 与实现代码:

| 选项                 | 默认值                           | 源码依据                                          |
| -------------------- | -------------------------------- | ------------------------------------------------- |
| staleTime            | 0 (拿到即过期)                   | `src/query.ts:473` `isStaleByTime(staleTime = 0)` |
| gcTime               | 浏览器 5 分钟, SSR 为 `Infinity` | `src/removable.ts:35`、`src/types.ts:317`         |
| retry                | 客户端 3, 服务端 0               | `src/types.ts:289`                                |
| retryDelay           | 指数退避, 上限 30 秒             | `src/types.ts:301`                                |
| refetchOnWindowFocus | true                             | `src/types.ts:486`                                |
| refetchOnReconnect   | true (networkMode 非 always 时)  | `src/types.ts:498`                                |
| structuralSharing    | true (通过 `replaceEqualDeep`)   | `src/utils.ts:464-480`                            |

staleTime 为 0 意味着: 默认配置下每次组件挂载、每次窗口重新聚焦 (且数据已过期) 都会触发后台重新拉取. 两个真实项目都显式调大了 staleTime 并关闭了聚焦重拉 (见第二章), 这是生产应用的常规操作.

### 5.104.0 的关键 API: `staleTime: 'static'` 与 `queryClient.query`

本机安装的 5.104.0 源码中, 有三处 API 事实需要在使用前明确:

1. staleTime 除数字外还支持字面量 `'static'`, 表示"永不视为过期" (`@tanstack/query-core/src/query.ts:418-424`, 判断走 `resolveQueryValue(observer.options.staleTime, this) === 'static'`; `isStaleByTime` 在 `src/query.ts:479` 对该字面量直接返回 `false`).
2. 命令式取数入口是 `queryClient.query()` 与 `queryClient.infiniteQuery()` (`src/queryClient.ts` 的这两个方法, JSDoc 说明 `query()` "replaces the deprecated `fetchQuery`", 见 `src/queryClient.ts:551-552`). `ensureQueryData`、`fetchQuery`、`prefetchQuery`、`fetchInfiniteQuery`、`prefetchInfiniteQuery` 均带 `@deprecated` 标记 (`src/queryClient.ts:196`、`src/queryClient.ts:607`、`src/queryClient.ts:641`、`src/queryClient.ts:700`、`src/queryClient.ts:723`), JSDoc 指向 `query()`/`infiniteQuery()`. 新入口语义合并: 缓存未过期时直接返回缓存数据, 过期时拉取; 按 `staleTime: 'static'` 调用等价于 `ensureQueryData`, 吞掉错误用 `.catch(noop)` 等价于 `prefetchQuery`.
3. 命令式 `query()` 在没有显式传入时默认 `retry: false` (`src/queryClient.ts:584`), 因为没有组件来承接重试.

### 条件拉取: enabled

`enabled: false` 时查询不发起请求, 常用于依赖尚未就绪的场景. 两个项目都大量使用该模式.

yukino-codegen 的 `client/src/shared/query/hooks/use-app-queries.ts`:

```ts
export function useAppById(appId: AppId | undefined): UseQueryResult<AppVo> {
  return useQuery({
    queryKey: appId ? queryKeys.app.byId(appId) : ["app", "byId", "disabled"],
    queryFn: () => {
      if (!appId) {
        throw new Error("appId is required");
      }
      return getAppById(appId);
    },
    enabled: appId !== undefined,
  });
}
```

这里的写法有两处工程细节值得记录:

1. key 在参数缺省时切换为占位 key `["app", "byId", "disabled"]`, 避免把 `undefined` 混进真实 key 空间; 同时保证 hook 规则 (queryKey 必须始终存在) 不被违反.
2. queryFn 内部仍做了一次防御性断言, 因为 TypeScript 无法在运行时阻止 queryFn 被其它路径调用.

同一模式也出现在 `client/src/shared/query/hooks/use-chat-history-queries.ts` 的 `useAppChatHistoryPage` (`enabled: appId !== undefined`).

yukino-chatbot 的 `client/src/hooks/queries/use-chat-history.ts` 则把"临时会话不发请求"的语义也塞进 enabled:

```ts
export const CHAT_HISTORY_QUERY_KEY = (sessionId: string) =>
  ["chatHistory", sessionId] as const;

export function useChatHistory(sessionId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: CHAT_HISTORY_QUERY_KEY(sessionId ?? ""),
    queryFn: async () => {
      const { data } = await fetchClient.post<HistoryResponse>(
        "/ai/chat/get-chat-history-list",
        { session_id: sessionId },
      );
      return data;
    },
    enabled: !!sessionId && sessionId !== "temp" && enabled,
  });
}
```

### 结构性共享 structuralSharing

每次成功拉取后, 新数据会与旧数据做深度比对, 相等的子树保留旧引用, 只有变化的部分换新引用. 实现是 `replaceEqualDeep` (`@tanstack/query-core/src/utils.ts:340`), 开关逻辑在 `src/utils.ts:464-480`: `structuralSharing` 可以是自定义函数, 也可以设为 `false` 关闭; 默认开启时若数据无法 JSON 序列化, 会打印明确的警告 (提示关闭 structuralSharing 或让 queryFn 返回可序列化数据, `src/utils.ts:472`).

它的实际收益: 配合 `useQuery` 的 `select` 或 React.memo 时, 未变化行的引用稳定, 避免列表整树重渲染. 对 yukino-chatbot 这类聊天应用尤其重要——消息列表很长, 每次轮询或失效重拉若整体换新引用, 所有消息项都会重渲染.

## 四、queryKey 分层设计与失效策略

### key 工厂模式

queryKey 是缓存的地址. 好的设计把 key 组织成从粗到细的层级树, 让失效操作可以按任意粒度进行. yukino-codegen 的 `client/src/shared/query/query-keys.ts` 是一份完整的工厂实现:

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
    awesomeList: (params: AppQueryRequest) =>
      ["app", "awesome", params] as const,
    adminList: (params: AppQueryRequest) => ["app", "admin", params] as const,
  },
  chatHistory: {
    all: ["chatHistory"] as const,
    byApp: (appId: AppId) => ["chatHistory", "app", appId] as const,
    byAppPaged: (
      appId: AppId,
      params: { pageSize: number; lastCreateTime?: string },
    ) => ["chatHistory", "app", appId, params] as const,
    adminList: (params: ChatHistoryQueryRequest) =>
      ["chatHistory", "admin", params] as const,
  },
} as const;
```

层级解读:

| 层         | 示例                                                            | 失效语义                             |
| ---------- | --------------------------------------------------------------- | ------------------------------------ |
| 资源根     | `queryKeys.user.all` 即 `["user"]`                              | 命中 user 域全部查询                 |
| 固定子键   | `queryKeys.user.current` 即 `["user", "current"]`               | 只命中当前用户查询                   |
| 参数化函数 | `queryKeys.user.listPage(params)` 即 `["user", "list", params]` | 把请求参数并入 key, 不同参数互不覆盖 |

三点设计意图:

1. 全部用 `as const` 固化字面量类型, 配合 `InferDataFromTag` 等类型工具可以让 `setQueryData(queryKeys.user.current, data)` 获得精确的数据类型推导.
2. 列表查询把整个 params 对象放进 key, 得益于 `hashKey` 对对象键排序, 同一组过滤条件无论字段书写顺序如何都命中同一缓存.
3. `byAppPaged` 的参数类型同时接受页码 (`pageSize`) 与可选游标 (`lastCreateTime`), 整个 params 对象进入 key, 页与页各自独立缓存, 翻页不覆盖上一页.

对比 yukino-chatbot 的 key 组织 (`client/src/hooks/queries/use-sessions.ts`、`use-chat-history.ts`): 采用就近导出的常量与函数 (`SESSIONS_QUERY_KEY = ["sessions"]`、`CHAT_HISTORY_QUERY_KEY(sessionId)`), 没有集中工厂. 这在小型应用里足够, 但一旦失效需求变复杂 (例如"登出时清掉所有会话与历史"), 分散的 key 就容易漏. 两个仓库的对比正好说明了 key 工厂模式的适用阈值.

### 失效模式实例: 写后失效

yukino-codegen 的 `client/src/shared/query/hooks/use-app-mutations.ts` 展示了典型的"按层级失效":

```ts
export function useUpdateApp(): UseMutationResult<
  boolean,
  Error,
  AppUpdateRequest
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: updateApp,
    onSuccess: (_data, variables) => {
      void client.invalidateQueries({
        queryKey: queryKeys.app.byId(variables.id),
      });
      void client.invalidateQueries({ queryKey: queryKeys.app.all });
    },
  });
}
```

- `invalidateQueries({ queryKey: queryKeys.app.byId(variables.id) })` 精确失效被修改的那条详情 (按前缀匹配, 命中以该 id 开头的 key).
- `invalidateQueries({ queryKey: queryKeys.app.all })` 失效整个 app 域, 覆盖我的列表、精选列表、管理列表等所有分页视图——因为更新可能影响任意一个列表的排序或可见性.

新增与删除 (`useAddApp`、`useDeleteApp`、`useDeleteAppByAdmin`) 则只失效 `app.all`, 因为它们必然影响列表而不存在需要单独失效的详情条目; 管理端的 `useUpdateAppByAdmin` 与 `useUpdateApp` 结构一致, 同样先失效 `app.byId(variables.id)` 再失效 `app.all`.

### 写后直写: setQueryData 同步当前用户

yukino-codegen 的 `client/src/shared/query/hooks/use-user-mutations.ts` 用了另一种模式——登录响应本身就包含完整的当前用户信息, 直接写入缓存, 无需等下一次请求:

```ts
export function useLogin(): UseMutationResult<
  LoginUserVo,
  Error,
  UserLoginRequest
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: login,
    onSuccess: (data) => {
      client.setQueryData(queryKeys.user.current, data);
      void client.invalidateQueries({ queryKey: queryKeys.user.all });
    },
  });
}
```

登出是对称操作 (`useLogout`): `client.setQueryData(queryKeys.user.current, null)` 立即把当前用户置空, 界面同步退出, 再失效整个 user 域兜底.

### 常用缓存操作对照

| API                 | 发请求           | 改缓存   | 典型场景                    |
| ------------------- | ---------------- | -------- | --------------------------- |
| `invalidateQueries` | 对 active 查询会 | 标记过期 | 写操作后按域刷新            |
| `refetchQueries`    | 强制             | 否       | 手动刷新按钮                |
| `setQueryData`      | 否               | 直接写   | 响应数据即最新实体          |
| `getQueryData`      | 否               | 只读     | 乐观更新前取快照            |
| `removeQueries`     | 否               | 删除     | 登出时彻底清缓存            |
| `queryClient.query` | 缓存过期才发     | 写入结果 | 命令式预取 / 路由加载前取数 |

## 五、useMutation 与乐观更新

### 项目中的真实形态

两个项目的 mutation 分三档:

1. 纯包装型: 只包 mutationFn, 不做任何缓存操作. yukino-chatbot 的 `client/src/hooks/queries/use-send-message.ts`、`use-register.ts` 均属此类——发消息后界面更新走流式回调而非缓存失效.
2. 写后失效型: yukino-codegen 的 app/user 域全部 mutation, 模式见第四章.
3. 写后直写型: yukino-codegen 的 `useLogin`/`useLogout`.

### 乐观更新与回滚机制

乐观更新的标准流程 (基于 QueryClient 已有 API 组合, 两个项目当前未使用, 此处为机制说明):

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
  onError: (_err, _variables, context) => {
    // 4. 失败时用快照回滚
    if (context?.previous) {
      queryClient.setQueryData(
        queryKeys.todo.byId(_variables.id),
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

关键约束:

- 乐观写入的 key 必须与查询侧完全一致 (同一工厂函数生成), 否则写了等于没写.
- `cancelQueries` 不能省: 如果取消前有一个在途的旧请求, 它的响应会在 onMutate 之后到达并覆盖乐观值.
- 回滚只能靠 onMutate 里保存的快照, TanStack Query 不提供自动回滚.
- onSettled 的失效是最终一致性兜底; 若业务能接受"服务端永远成功", 也可以只在 onError 里失效.

yukino-codegen 选择"成功后失效"而非乐观更新是合理的: 其 mutation 多为管理类低频操作 (增删应用、改资料), 服务端响应快, 乐观更新带来的复杂度不划算; 而登录/登出用 setQueryData 直写, 是因为响应体本身就是权威数据.

### Mutation 的回调时序

`useMutation` 选项级回调与全局回调的执行顺序: onMutate (MutationCache 级 -> 选项级) -> mutationFn -> onSuccess/onError -> onSettled. 全局级回调在 `new QueryClient({ mutationCache: ... })` 或通过 `queryClient.getMutationCache().subscribe` 配置, 适合统一的错误上报. 两个项目都未配置全局 mutationCache, 错误处理放在各 hook 的调用侧 (例如 yukino-chatbot 登录页在 `mutate` 的第二个参数里传 onSuccess/onError).

## 六、缓存预取与 SSR hydration

### 预取

预取的本质是"在组件挂载前把数据写进缓存". 5.104.0 的命令式入口是 `queryClient.query()` (`@tanstack/query-core/src/queryClient.ts` 中 `query` 方法, JSDoc 明确说明它取代 `fetchQuery` 与 `ensureQueryData`):

```ts
// 路由跳转前预取, 缓存 10 秒内有效则不重拉
await queryClient.query({
  queryKey: queryKeys.app.byId(id),
  queryFn: () => getAppById(id),
  staleTime: 10_000,
});
```

行为要点 (源码 `src/queryClient.ts` `query` 方法): 先 `queryCache.build` 拿到 (或创建) Query, 再用 `isStaleByTime` 判断是否过期, 未过期直接返回 `query.state.data`, 过期才 `query.fetch`; 命令式调用默认 `retry: false`. React 侧还提供渲染期预取 Hook `usePrefetchQuery` (`@tanstack/react-query/src/usePrefetchQuery.tsx`) 与 `queryOptions` 辅助函数 (`src/queryOptions.ts`), 后者让同一份选项同时服务于 `useQuery` 与命令式 API, 是 v5 推荐的做法.

### SSR hydration

SSR 链路: 服务端用 `dehydrate(client)` 把缓存序列化为纯数据 (`@tanstack/query-core/src/hydration.ts:208`, 单条查询的序列化在 `src/hydration.ts:149`), 随 HTML 下发; 客户端用 `hydrate(client, dehydratedState)` 还原 (`src/hydration.ts:265`), React 层由 `HydrationBoundary` 组件包装 (`@tanstack/react-query/src/HydrationBoundary.tsx`). 被水合的查询进入缓存后与正常查询无异, 该过期的过期、该 gc 的 gc.

本机事实: yukino-chatbot 与 yukino-codegen 都是纯 Vite SPA, 未使用 `dehydrate`/`hydrate`/`HydrationBoundary` (两仓库 `client/src` 全量 grep 无命中). yukino-codegen 的 `client/src/app/app-providers.tsx` 里有一个名字相近的 `AuthHydrationGate`, 但它是自研的鉴权门控组件: 它在 zustand store (`client/src/shared/auth/user-store.ts`) 的 `status` 为 `idle` 时触发 `hydrate()`, 该函数直接调用 `getCurrentUser()` 而不是走 Query 缓存, 加载完成前渲染 fallback, 与 TanStack Query 的水合机制无关.

### 缓存持久化

TanStack Query 另有 `@tanstack/react-query-persist-client` 提供基于 `persistQueryClient` 的持久化 (写入 localStorage/IndexedDB 等). 本机两个项目均未安装该包; yukino-chatbot 需要持久化的都是客户端状态, 走的是 Jotai 的 `atomWithStorage` (见第八章), 这是"服务端状态不落本地"的典型取舍.

## 七、useInfiniteQuery 与分页

### 机制

`useInfiniteQuery` 把多页数据聚合为一个 pages 数组, 核心在于两个由使用方提供的游标函数: `getNextPageParam(lastPage, allPages)` 与 `getPreviousPageParam`. 聚合拉取逻辑在 `@tanstack/query-core/src/infiniteQueryBehavior.ts`: 拉下一页时取上一页的 `getNextPageParam` 返回值作为新 pageParam (`src/infiniteQueryBehavior.ts:85`、`src/infiniteQueryBehavior.ts:101`), `hasNextPage` 即"getNextPageParam 返回非 null" (`src/infiniteQueryBehavior.ts:159-164`). 返回结果额外提供 `fetchNextPage`/`fetchPreviousPage`/`isFetchingNextPage` 等字段.

### 项目现状与选型理由

本机事实: 两个项目均未使用 `useInfiniteQuery` (全量 grep 无命中). yukino-codegen 的分页查询走的是"参数并入 key 的普通 useQuery", 见 `client/src/shared/query/query-keys.ts` 的 `byAppPaged`:

```ts
byAppPaged: (
  appId: AppId,
  params: { pageSize: number; lastCreateTime?: string },
) => ["chatHistory", "app", appId, params] as const,
```

使用侧 `useAppChatHistoryPage` (`client/src/shared/query/hooks/use-chat-history-queries.ts`) 以 `AppChatHistoryParams` 即 `{ current, pageSize }` 构造 key, 每页独立缓存, 并以 `enabled: appId !== undefined` 控制拉取时机; 同文件的 `useAdminChatHistoryPage` 则用 `chatHistory.adminList(params)` 把过滤条件整体并入 key.

两种分页形态的取舍:

| 形态                             | 适用                 | 优点                         | 代价                             |
| -------------------------------- | -------------------- | ---------------------------- | -------------------------------- |
| 普通分页 useQuery (codegen 现状) | 页码式导航、管理后台 | 每页独立缓存与失效, 逻辑简单 | 跨页滚动加载需自己拼接           |
| useInfiniteQuery                 | 滚动信息流、聊天历史 | 多页自动聚合、游标语义内建   | pages 是整体缓存, 局部失效不灵活 |

聊天记录这类"只向后追加、按时间游标翻页"的数据, 是 useInfiniteQuery 的经典场景; 管理端"按页码跳转 + 过滤条件"则是普通分页更合适. codegen 的聊天历史页当前是页码参数 + 普通 useQuery, 但 key 工厂 `byAppPaged` 的参数类型里已经预留了可选游标 `lastCreateTime`, 后续若要接"上拉加载更多"交互, 切到 useInfiniteQuery 只需改 hooks 层.

## 八、与 Jotai 的职责分工 (yukino-chatbot)

yukino-chatbot 同时引入了 Jotai 2.20.3 与 TanStack Query 5.104.0, 边界划分清晰: 服务端状态进 Query 缓存, 客户端状态进 Jotai 原子.

### 状态归属表

| 状态                      | 载体                                                              | 出处                                                                      |
| ------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 登录 token                | `tokenAtom` + localStorage 同步                                   | `yukino-chatbot/client/src/stores/auth.ts`                                |
| 是否已登录                | `isAuthenticatedAtom` (派生原子)                                  | 同上                                                                      |
| 会话列表 (服务端)         | `useSessions` 查询, key 为 `["sessions"]`                         | `yukino-chatbot/client/src/hooks/queries/use-sessions.ts`                 |
| 历史消息 (服务端)         | `useChatHistory` 查询, key 为 `["chatHistory", sessionId]`        | `yukino-chatbot/client/src/hooks/queries/use-chat-history.ts`             |
| 当前会话 id、临时会话标记 | `currentSessionIdAtom`、`tempSessionAtom`                         | `yukino-chatbot/client/src/stores/chat.ts`                                |
| 选中模型、流式中、加载中  | `selectedModelAtom`、`isStreamingAtom`、`loadingAtom`             | 同上                                                                      |
| 主题、语言、默认模型偏好  | `themeAtom`、`languageAtom`、`modelAtom` (均为 `atomWithStorage`) | `yukino-chatbot/client/src/stores/settings.ts`                            |
| 登录/注册请求             | `useMutation`                                                     | `yukino-chatbot/client/src/hooks/queries/use-login.ts`、`use-register.ts` |

### 一个完整的跨库流程: 登录

yukino-chatbot 登录页 (`client/src/pages/login/index.tsx`) 串起了 Form、Mutation、Jotai 三个库:

```tsx
const form = useForm({
  defaultValues: { username: "", password: "" },
  validators: { onChange: loginSchema },
  onSubmit: ({ value }) => {
    loginMutation.mutate(
      { username: value.username, password: value.password },
      {
        onSuccess: ({ code, token, message }) => {
          if (code === 1000 && token) {
            setToken(token); // Jotai write atom: 写 tokenAtom + localStorage
            navigate("/menu");
          }
        },
      },
    );
  },
});
```

流程: TanStack Form 负责字段值与校验 -> `useLogin` (useMutation) 负责请求生命周期 -> 成功后通过 Jotai 的 write-only 原子 `setTokenAtom` 把 token 落进客户端状态 (`stores/auth.ts` 中该原子同时维护 localStorage) -> 路由跳转. token 不进入任何 query key; 请求侧由 `fetchClient` (axios 实例) 统一附带, 与缓存层解耦.

流式消息 (`client/src/hooks/queries/use-stream-message.ts`) 则是另一个边界案例: 它用 `useMutation` 只是借用其 pending/error 状态管理, 流内容通过回调传出——调用侧 (`client/src/pages/ai-chat/index.tsx`) 的 `onChunk` 只写 `streamTextRef` (热路径避免逐 chunk 触发 re-render), 流结束后才把完整内容提交进 Jotai 的会话原子. 整个过程中流式增量都不进 Query 缓存, 因为它是瞬态客户端状态, 既不需要缓存也不需要失效.

### 分工判据

1. 数据有远端权威来源、需要过期与同步语义 -> Query.
2. 数据由本地交互产生、生命周期与页面绑定 -> Jotai.
3. 同一事实的两面: 服务端返回的"当前用户"用 Query (`queryKeys.user.current`), 本地派生的"是否已登录"布尔值用派生原子 (chatbot) 或选择器 (codegen).
4. 需要持久化的客户端偏好走 `atomWithStorage`; 服务端状态不做本地持久化.

## 九、TanStack Form 与 TanStack Virtual

### TanStack Form 1.33.5

@tanstack/react-form 1.33.5 (核心 @tanstack/form-core 1.33.5) 是框架无关的表单状态库, 特点: 字段级订阅 (字段变化只重渲染该字段的渲染函数)、类型推导到字段路径、验证器可绑定 Standard Schema (源码 `@tanstack/form-core/src/standardSchemaValidator.ts`, zod schema 因此可以直接传给 `validators`).

yukino-chatbot 登录页 (`client/src/pages/login/index.tsx`) 的真实用法, 覆盖三个核心概念:

1. 表单级配置: `useForm` 传 `defaultValues` 与 `validators.onChange`——校验器直接绑定 zod schema (`loginSchema`), 每次变更即校验.
2. 字段级渲染: `form.Field` 以 render props 暴露 `field.state.value`、`field.state.meta.errors`、`field.handleChange`、`field.handleBlur`, 字段之外不重渲染.
3. 提交桥接: `onSubmit` 里调用 `loginMutation.mutate`, 并用 `loginMutation.isPending` 禁用提交按钮——表单库管值与校验, Query 管请求, 两者在提交点汇合.

yukino-codegen 在 `client/src/pages/user-login/user-login-page.tsx`、`user-register/user-register-page.tsx`、`app-edit/app-edit-form.tsx` 三处沿用同一套组合: `useForm` 管字段与校验, 提交时在 `onSubmit` 里调用 `useMutation` 的 hook; 区别只在校验触发器, 这三处用 `validators.onSubmit` 绑定 zod schema, 而 chatbot 登录页用 `validators.onChange`.

### TanStack Virtual 3.14.13

@tanstack/react-virtual 3.14.13 (核心 @tanstack/virtual-core 3.17.11) 是纯测量+定位的虚拟化引擎, 不接管 DOM 结构. yukino-chatbot 消息列表 (`client/src/pages/ai-chat/components/message-list/index.tsx`) 的用法:

```tsx
const virtualizer = useVirtualizer({
  count: messages.length,
  getScrollElement: () => parentRef.current,
  estimateSize: () => 120,
  overscan: 5,
});
```

配合渲染侧的标准三段式: 外层容器挂 `parentRef` 并监听 onScroll; 内层撑开 `virtualizer.getTotalSize()` 的总高度; 只渲染 `virtualizer.getVirtualItems()` 返回的可视项, 每项用绝对定位 + `translateY(virtualRow.start)` 摆放, 并挂 `virtualizer.measureElement` 让真实高度回写测量缓存 (消息气泡高度不定, 必须实测).

该文件还处理了两个聊天场景特有的难题, 值得记录:

1. 流式内容增长钉底: 流式气泡通过直接 DOM 写入更新, 不经过 React state, 因此用 ResizeObserver 观察列表主体, 高度增长且用户处于底部附近 (`NEAR_BOTTOM_THRESHOLD = 80` px) 时调用 `virtualizer.scrollToIndex(messages.length - 1, { align: "end" })` 钉底; 用户向上翻阅时不打断.
2. 自动滚动只响应消息数变化: 滚动 effect 的依赖是 `messages.length` 与末条消息 role, 流式增量不会反复触发.

## 十、常见陷阱

结合源码机制与两个项目的实践, 列出高频陷阱:

1. queryKey 里放不可序列化或非稳定引用的值. key 会被 `JSON.stringify`, Date 会变成字符串、函数与 class 实例会丢失; 每次渲染新建的参数对象本身无害 (哈希按内容算), 但如果对象内含随机值或时间戳, 会导致每次渲染都命中新缓存.
2. staleTime 保持默认 0 而忘了关 `refetchOnWindowFocus`. 表现为切回标签页就请求刷屏. 两个真实项目都在 QueryClient 默认值里处理了这一点.
3. mutation 成功后只改了 UI 状态不失效缓存. 列表视图仍旧, 直到用户手动刷新. 对策: 把 `invalidateQueries` 写进 hook 的 onSuccess, 而不是散落在页面里 (yukino-codegen 的做法).
4. 在条件分支里调用 hook, 或用 `enabled` 模拟"卸载". `enabled` 只是暂停拉取, 组件仍持有 observer; 真正按条件换数据应把条件放进 queryKey.
5. setQueryData 的 key 与查询侧不一致. 手写 key 字面量极易与工厂函数生成的 key 差一个字段, 导致"写了缓存但没生效". 坚持用同一份 key 工厂.
6. 误以为 gcTime 控制过期. gcTime 只负责无人观察后的删除; 过期由 staleTime 决定. 把 gcTime 调大不会减少请求, 只会多占内存.
7. 期望 mutation 跟随 queries 的 retry 次数. `MutationOptions.retry` 的默认值是 0 (`@tanstack/query-core/src/types.ts:1341`), 与 queries 的客户端 3 分开; yukino-codegen 在 `mutations: { retry: 0 }` 里又显式写了一遍, chatbot 则依赖默认值. 写操作重试可能造成重复提交.
8. 乐观更新忘写 cancelQueries. 在途旧请求的响应会覆盖乐观值, 表现为"界面闪回旧数据".
9. structuralSharing 与非 JSON 数据冲突. queryFn 返回 Map、Set、含循环引用的对象时, 控制台会出现"Structural sharing requires data to be JSON serializable"警告 (`@tanstack/query-core/src/utils.ts:472`), 此时应关闭 structuralSharing 或改造返回值.
10. 用 invalidateQueries 不带 queryKey. 无过滤条件时命中缓存中所有查询, 等于全站重拉; 生产代码应始终传明确的 key 前缀.

## 十一、出处与版本汇总

### 真实项目出处索引

| 事实                                                               | 出处                                                                                                                    |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| QueryClient 单例与默认值 (retry 1, 聚焦重拉关闭, staleTime 5 分钟) | `yukino-chatbot/client/src/api/query-client.ts`                                                                         |
| QueryClientProvider 位于应用根部                                   | `yukino-chatbot/client/src/App.tsx`                                                                                     |
| createQueryClient 工厂 (staleTime 30 秒, mutations retry 0)        | `yukino-codegen/client/src/shared/query/query-client.ts`                                                                |
| Provider 组合 (Query + Router + AuthBoundary)                      | `yukino-codegen/client/src/app/app-providers.tsx`                                                                       |
| queryKey 工厂                                                      | `yukino-codegen/client/src/shared/query/query-keys.ts`                                                                  |
| useQuery + enabled 模式                                            | `yukino-codegen/client/src/shared/query/hooks/use-app-queries.ts`、`use-chat-history-queries.ts`、`use-user-queries.ts` |
| 写后失效 / setQueryData 模式                                       | `yukino-codegen/client/src/shared/query/hooks/use-app-mutations.ts`、`use-user-mutations.ts`                            |
| Jotai 客户端状态 (token/会话/偏好)                                 | `yukino-chatbot/client/src/stores/auth.ts`、`chat.ts`、`settings.ts`                                                    |
| Form + Mutation + Atom 登录流程                                    | `yukino-chatbot/client/src/pages/login/index.tsx`                                                                       |
| Virtual 消息列表                                                   | `yukino-chatbot/client/src/pages/ai-chat/components/message-list/index.tsx`                                             |
| 流式 mutation 不进缓存                                             | `yukino-chatbot/client/src/hooks/queries/use-stream-message.ts`                                                         |

### query-core 源码索引 (5.104.0)

路径相对于 `node_modules/.pnpm/@tanstack+query-core@5.104.0/node_modules/@tanstack/query-core/`.

| 机制                                            | 源码位置                                                                                                  |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| queryKey 哈希 (对象键排序)                      | `src/utils.ts:266` `hashQueryKeyByOptions`、`src/utils.ts:284` `hashKey`                                  |
| 失效匹配                                        | `src/utils.ts:175` `matchQuery`、`src/utils.ts:300` `partialMatchKey`                                     |
| invalidateQueries 流程                          | `src/queryClient.ts:469`                                                                                  |
| Query.invalidate (仅置位不发请求)               | `src/query.ts:574`                                                                                        |
| staleTime 判断 (默认 0, 支持 `'static'`)        | `src/query.ts:473` `isStaleByTime`、`src/query.ts:418-424`                                                |
| gcTime 默认值 (浏览器 5 分钟, SSR Infinity)     | `src/removable.ts:35`、`src/types.ts:317`                                                                 |
| retry 默认值 (客户端 3, 服务端 0)               | `src/types.ts:289`                                                                                        |
| 结构性共享                                      | `src/utils.ts:340` `replaceEqualDeep`、`src/utils.ts:464-480`                                             |
| Mutation 状态机                                 | `src/mutation.ts:477`、`src/mutation.ts:488`、`src/mutation.ts:499`、`src/mutation.ts:531`                |
| 命令式 query / fetchQuery 弃用                  | `src/queryClient.ts:607`、`src/queryClient.ts:641`、`src/queryClient.ts:196`                              |
| dehydrate / hydrate                             | `src/hydration.ts:208`、`src/hydration.ts:265`、`src/hydration.ts:149`                                    |
| infinite 游标推进                               | `src/infiniteQueryBehavior.ts:85`、`src/infiniteQueryBehavior.ts:132`、`src/infiniteQueryBehavior.ts:159` |
| React 绑定 (useSyncExternalStore + trackResult) | `@tanstack/react-query/src/useBaseQuery.ts:95`、`src/useBaseQuery.ts:138`                                 |

### 版本声明

本文基于 2026-09-30 本机实际安装: @tanstack/react-query 与 @tanstack/query-core 均为 5.104.0, @tanstack/react-form 1.33.5, @tanstack/react-virtual 3.14.13 (virtual-core 3.17.11), jotai 2.20.3, react 19.3.0. 文中行号对应当前安装的源码快照, 升级版本后需重新核对.
