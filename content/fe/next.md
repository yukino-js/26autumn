---
title: "React + Next.js 技术笔记"
---

## 一、React 核心概念与渲染机制

### React 的渲染流程是怎样的? 什么是 Virtual DOM?

React 的渲染分为两个阶段:

Render 阶段 (协调/Reconciliation) :

1. 触发更新 (setState、props 变化、Context 变化、父组件重渲染)
2. React 调用组件函数, 生成新的 React Element 树 (Virtual DOM)
3. 将新树与旧树进行 Diff (Fiber 协调) , 计算出最小变更集 (React 18 起通过 Fiber 节点的 flags/subtreeFlags 标记副作用, 不再维护单独的 Effect List 链表)

Commit 阶段 (提交) :

1. React 将变更一次性应用到真实 DOM
2. 执行生命周期/Effect 的清理和设置
3. 浏览器进行 Layout 和 Paint

Virtual DOM 的本质:

Virtual DOM 是 JavaScript 对象 (React Element) , 是对真实 DOM 的轻量描述. 它的价值不在于"比直接操作 DOM 更快", 而在于:

- 提供声明式编程模型: 开发者描述"UI 应该是什么样", 而非"如何一步步修改 DOM"
- 批量更新: 多次 setState 合并为一次 DOM 操作
- 跨平台: 同一套描述可以渲染到 DOM、Native、Canvas 等目标
- 最小化 DOM 操作: 通过 Diff 算法找出最少的真实 DOM 变更

```tsx
// React Element 本质
const element = {
  type: "div",
  props: {
    className: "container",
    children: [
      { type: "h1", props: { children: "Hello" } },
      { type: "p", props: { children: "World" } },
    ],
  },
};
```

延伸: React 18 引入的 Automatic Batching 使得即使在 setTimeout、Promise 回调中的多次 setState 也会自动合并为一次渲染, 而 React 17 及之前只在 React 事件处理器中批处理.

---

### React Fiber 架构解决了什么问题?

React 15 的 Stack Reconciler 是递归同步的: 一旦开始 Diff, 就必须一次性遍历完整棵树, 无法中断. 对于大型组件树, 这会导致主线程长时间阻塞, 产生掉帧 (jank) .

Fiber 的核心思想: 将渲染工作拆分为可中断的小单元 (Unit of Work) , 每个 Fiber 节点就是一个工作单元.

Fiber 节点的数据结构:

```typescript
interface Fiber {
  type: any; // 组件类型
  key: string | null;
  stateNode: any; // DOM 节点或类实例

  // 树结构 (链表)
  return: Fiber | null; // 父节点
  child: Fiber | null; // 第一个子节点
  sibling: Fiber | null; // 下一个兄弟节点

  // 双缓冲
  alternate: Fiber | null; // 指向另一棵树的对应节点

  // 更新相关
  pendingProps: any;
  memoizedProps: any;
  memoizedState: any;
  updateQueue: any;

  // 副作用
  flags: number; // 副作用标记 (Placement, Update, Deletion...)
  lanes: Lanes; // 优先级
}
```

Fiber 带来的能力:

| 能力                | 说明                                 |
| ------------------- | ------------------------------------ |
| 可中断渲染          | 高优先级更新可以打断低优先级渲染     |
| 优先级调度          | 用户输入 > 动画 > 数据更新           |
| 时间切片            | 每帧只做一部分工作, 剩余让出主线程   |
| Suspense            | 组件可以"暂停"等待异步数据           |
| Concurrent Features | startTransition、useDeferredValue 等 |

双缓冲 (Double Buffering) : React 维护两棵 Fiber 树——current (当前显示) 和 workInProgress (正在构建) . 更新完成后一次性切换指针, 避免中间状态暴露给用户.

---

### React 的并发特性 (Concurrent Features) 有哪些?

React 18+ 的并发特性允许应用同时准备多个版本的 UI, 根据优先级决定先展示哪个.

核心 API:

| API                | 用途                                    | 场景                   |
| ------------------ | --------------------------------------- | ---------------------- |
| `startTransition`  | 标记非紧急更新                          | 搜索结果过滤、Tab 切换 |
| `useTransition`    | 获取 isPending 状态 + startTransition   | 带 loading 的导航      |
| `useDeferredValue` | 延迟某个值的更新                        | 输入框实时搜索         |
| `Suspense`         | 声明式异步边界                          | 数据加载、代码分割     |
| `use()`            | 在组件中读取 Promise/Context (React 19) | 配合 Suspense 使用     |
| `Activity`         | 保持隐藏组件的状态 (React 19.2)         | Tab 面板、下拉菜单     |

startTransition 示例:

```tsx
import { startTransition } from "react";

function SearchPage() {
  const [input, setInput] = useState("");
  const [results, setResults] = useState([]);

  function handleChange(e) {
    // 紧急更新: 立即更新输入框
    setInput(e.target.value);

    // 非紧急更新: 可以被高优先级更新打断
    startTransition(() => {
      setResults(filterLargeList(e.target.value));
    });
  }

  return (
    <>
      <input value={input} onChange={handleChange} />
      <ResultsList results={results} />
    </>
  );
}
```

useDeferredValue 示例:

```tsx
function Search({ items }: { items: Item[] }) {
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const isStale = query !== deferredQuery;

  const filtered = useMemo(
    () => items.filter((item) => fuzzyMatch(item, deferredQuery)),
    [items, deferredQuery],
  );

  return (
    <>
      <input value={query} onChange={(e) => setQuery(e.target.value)} />
      <div style={{ opacity: isStale ? 0.7 : 1 }}>
        <ResultsList results={filtered} />
      </div>
    </>
  );
}
```

两者的区别:

- `startTransition`: 你控制"何时发起非紧急更新" (包裹 setState 调用)
- `useDeferredValue`: 你控制"某个值延迟生效" (包裹值本身) , 适合无法控制 setState 来源的场景 (如来自 props)

---

### 什么是 React Server Components (RSC) ? 与 SSR 有何区别?

SSR (Server-Side Rendering) :

- 在服务器上执行组件渲染, 生成 HTML 字符串发送给客户端
- 客户端需要下载完整的 JavaScript Bundle 并进行水合 (Hydration)
- 所有组件最终都在客户端运行
- 目的: 加速首屏展示 (FCP) , 改善 SEO

RSC (React Server Components) :

- 组件在服务器上执行, 但永远不会发送其 JavaScript 到客户端
- 输出的是序列化的 React Element (RSC Payload) , 不是 HTML 字符串
- 客户端不需要下载 Server Component 的代码
- 目的: 减少客户端 Bundle 体积, 直接在服务端访问数据源

核心区别对比:

| 维度      | SSR                                  | RSC                             |
| --------- | ------------------------------------ | ------------------------------- |
| 输出      | HTML 字符串                          | RSC Payload (序列化的 React 树) |
| JS Bundle | 包含所有组件代码                     | 只包含 Client Component 代码    |
| 水合      | 需要完整水合                         | Server Component 无需水合       |
| 数据获取  | 需要额外机制 (getServerSideProps 等) | 组件内直接 async/await          |
| 交互性    | 水合后完全交互                       | Server Component 无状态、无交互 |
| 运行时机  | 每次请求                             | 每次请求 (或构建时)             |

Next.js App Router 中的组合:

```tsx
// app/page.tsx — Server Component (默认)
import ClientCounter from "./ClientCounter";

export default async function Page() {
  // 直接在服务端访问数据库, 无需 API 层
  const posts = await db.post.findMany();

  return (
    <div>
      <h1>Blog</h1>
      <ClientCounter initialCount={posts.length} />
      {posts.map((post) => (
        <article key={post.id}>{post.title}</article>
      ))}
    </div>
  );
}
```

```tsx
// app/ClientCounter.tsx
"use client";
import { useState } from "react";

export default function ClientCounter({
  initialCount,
}: {
  initialCount: number;
}) {
  const [count, setCount] = useState(initialCount);
  return <button onClick={() => setCount((c) => c + 1)}>Count: {count}</button>;
}
```

RSC 的限制 (Server Component 不能做的事) :

- 不能使用 useState、useEffect 等客户端 Hook
- 不能使用浏览器 API (window、localStorage)
- 不能添加事件处理器 (onClick 等)
- 不能使用 class 组件

---

## 二、为什么需要 SSR? CSR vs SSR vs SSG vs ISR

### 为什么需要服务端渲染 (SSR) ?

纯 CSR (Client-Side Rendering) 的问题:

1. 首屏白屏时间长: 浏览器需要下载 HTML (空壳) -> 下载 JS Bundle -> 执行 JS -> 发起数据请求 -> 渲染内容. 在弱网环境下, 用户可能等待 3-5 秒看到内容.

2. SEO 不友好: 搜索引擎爬虫 (尤其是非 Google 的) 可能无法执行 JavaScript, 导致抓取到空白页面.

3. 性能指标差: LCP (Largest Contentful Paint) 、FCP (First Contentful Paint) 等 Core Web Vitals 指标恶化.

4. 社交分享预览缺失: Open Graph 爬虫不执行 JS, 无法生成正确的分享卡片.

SSR 如何解决:

```
CSR 时间线:
|--HTML(空)--|--JS下载--|--JS执行--|--API请求--|--渲染--|
                                                    ^ 用户看到内容

SSR 时间线:
|--HTML(含内容)+API请求(服务端)--|--JS下载--|--水合--|
^ 用户看到内容                              ^ 可交互
```

SSR 的代价:

- 服务器负载增加 (每次请求都要渲染)
- TTFB (Time to First Byte) 可能增加
- 需要处理水合不匹配问题
- 开发复杂度提升 (需要处理服务端/客户端环境差异)

---

### CSR、SSR、SSG、ISR 各自的适用场景是什么?

| 策略 | 渲染时机            | 适用场景                       | Next.js 实现                                   |
| ---- | ------------------- | ------------------------------ | ---------------------------------------------- |
| CSR  | 客户端运行时        | 后台管理系统、实时数据仪表盘   | `'use client'` + useEffect                     |
| SSR  | 每次请求时服务端    | 个性化内容、实时数据、需要 SEO | Server Component / `dynamic = 'force-dynamic'` |
| SSG  | 构建时              | 博客、文档、营销页             | 默认行为 (静态生成)                            |
| ISR  | 构建时 + 按需重验证 | 电商列表、新闻首页             | `revalidate = 60`                              |

选型决策树:

1. 内容是否每次请求都不同?
   - 是 -> SSR (如用户个人主页、购物车)
   - 否 -> 继续判断

2. 内容更新频率如何?
   - 几乎不变 -> SSG (如文档、关于页面)
   - 定期更新 (分钟/小时级) -> ISR (如博客列表、商品页)

3. 是否需要 SEO?
   - 是 -> 优先 SSG/ISR/SSR
   - 否 (如登录后的后台) -> CSR 即可

Next.js App Router 中的配置:

```tsx
// SSG (默认)
export default async function Page() {
  const data = await fetch("https://api.example.com/posts", {
    cache: "force-cache",
  });
  return <PostList posts={data} />;
}

// ISR: 每 60 秒重验证
export const revalidate = 60;

// SSR: 每次请求都重新获取
export const dynamic = "force-dynamic";

// 按需重验证
import { revalidatePath, revalidateTag } from "next/cache";
revalidatePath("/blog");
revalidateTag("posts");
```

---

### Next.js App Router 的渲染模型是怎样的?

Next.js App Router 采用 React Server Components 作为默认渲染模型, 核心特征:

1. 组件分类:

```
Server Components (默认)
  - 在服务器上执行
  - 可以直接访问数据库、文件系统
  - 不发送 JS 到客户端
  - 不能使用 useState/useEffect/事件处理器

Client Components ('use client')
  - 在服务器上预渲染 (SSR) + 客户端水合
  - 可以使用所有 React Hook
  - 可以添加事件处理器
  - JS 会发送到客户端
```

2. 渲染流程:

```
请求到达
  -> 服务器执行 Server Components
  -> 生成 RSC Payload (序列化的 React 树)
  -> 同时渲染出首屏 HTML (Client Components 在 HTML 中渲染为真实 DOM, 在 Payload 中记录为模块引用)
  -> 发送 HTML + RSC Payload 到客户端
  -> 客户端下载 Client Component 的 JS
  -> 水合 Client Components (绑定事件、恢复状态)
  -> 页面可交互
```

3. 数据获取模型 (并行化) :

```tsx
async function Header() {
  const nav = await fetchNav()  // 与 Sidebar 并行
  return <header>{nav.map(...)}</header>
}

async function Sidebar() {
  const items = await fetchSidebar()  // 与 Header 并行
  return <aside>{items.map(...)}</aside>
}

export default function Page() {
  return (
    <div>
      <Header />
      <Sidebar />
    </div>
  )
}
```

4. Streaming + Suspense:

```tsx
import { Suspense } from "react";

export default function Page() {
  return (
    <div>
      <Header /> {/* 立即发送 */}
      <Suspense fallback={<Skeleton />}>
        <SlowDataSection /> {/* 数据就绪后流式发送 */}
      </Suspense>
      <Footer /> {/* 立即发送 */}
    </div>
  );
}
```

---

## 三、水合 (Hydration) 机制深度解析

### 什么是水合 (Hydration) ? 为什么需要它?

定义: 水合是 React 在客户端"接管"服务端渲染的静态 HTML 的过程. React 将事件监听器、状态、Effect 绑定到已有的 DOM 节点上, 使静态 HTML 变为可交互的应用.

为什么需要:

SSR 输出的 HTML 是"死"的——它只是字符串, 没有事件绑定、没有状态管理. 水合让 React 在不重新创建 DOM 的前提下, 赋予这些节点交互能力.

水合过程:

```
1. 浏览器接收并解析 HTML -> 用户看到内容 (FCP)
2. 浏览器下载 React + 应用 JS Bundle
3. React 执行, 生成 Virtual DOM
4. React 将 Virtual DOM 与已有 DOM 进行"对账" (Reconciliation)
5. 绑定事件监听器 (onClick、onChange 等)
6. 恢复/初始化状态 (useState 的初始值)
7. 执行 useEffect
8. 页面变为可交互 (TTI)
```

水合的代价:

- 需要下载完整的 Client Component JS Bundle
- 水合过程本身消耗 CPU (对大型页面可能 100-500ms)
- 水合完成前页面不可交互 ("恐怖谷": 看得到但点不动)
- 要求服务端和客户端渲染输出一致

React 18 的改进——Selective Hydration:

React 18 支持部分水合:

- 配合 Suspense, 可以只水合用户正在交互的部分
- 如果用户点击了尚未水合的区域, React 会优先水合该区域
- 大幅降低 TTI

---

### 水合不匹配 (Hydration Mismatch) 的常见原因和解决方案?

水合不匹配发生在: 服务端渲染的 HTML 与客户端 React 首次渲染的 Virtual DOM 不一致.

常见原因:

| 原因                   | 示例                                | 解决方案                          |
| ---------------------- | ----------------------------------- | --------------------------------- |
| 使用浏览器 API         | `window.innerWidth`、`localStorage` | 在 useEffect 中读取, 或用内联脚本 |
| 时间/日期              | `new Date().toLocaleString()`       | `suppressHydrationWarning`        |
| 随机值                 | `Math.random()` 生成 ID             | 使用 `useId()` 或服务端传递       |
| 浏览器扩展             | 注入额外 DOM 节点                   | 无法控制, 忽略                    |
| 条件渲染依赖客户端状态 | `typeof window !== 'undefined'`     | 使用 `useEffect` + state          |
| 嵌套错误               | `<p><div></div></p>`                | 修正 HTML 结构                    |

解决方案一: suppressHydrationWarning (已知且无害的不匹配)

```tsx
function Timestamp() {
  return <span suppressHydrationWarning>{new Date().toLocaleString()}</span>;
}
```

解决方案二: 客户端状态 + useEffect (需要客户端数据)

```tsx
function WindowWidth() {
  const [width, setWidth] = useState(0);

  useEffect(() => {
    setWidth(window.innerWidth);
  }, []);

  return <span>Width: {width}</span>;
}
```

解决方案三: 内联脚本 (避免闪烁, 见下文「如何避免水合导致的视觉闪烁?」)

---

### 如何避免水合导致的视觉闪烁?

问题场景: 主题切换 (dark/light mode) . 如果用 `useEffect` 读取 localStorage 中的主题偏好, 用户会先看到默认主题 (如 light) , 然后闪烁切换到 dark.

错误方案一: 直接读取 localStorage (SSR 报错)

```tsx
const theme = localStorage.getItem("theme") || "light";
// 服务端没有 localStorage, 直接报错
```

错误方案二: useEffect 读取 (闪烁)

```tsx
const [theme, setTheme] = useState("light");
useEffect(() => {
  setTheme(localStorage.getItem("theme") || "light");
}, []);
// 先渲染 light -> 水合后切换 dark -> 视觉闪烁
```

正确方案: 同步内联脚本

```tsx
function ThemeWrapper({ children }: { children: ReactNode }) {
  return (
    <>
      <div id="theme-wrapper">{children}</div>
      <script
        dangerouslySetInnerHTML={{
          __html: `
            (function() {
              try {
                var theme = localStorage.getItem('theme') || 'light';
                var el = document.getElementById('theme-wrapper');
                if (el) el.className = theme;
              } catch (e) {}
            })();
          `,
        }}
      />
    </>
  );
}
```

原理: 内联脚本在 HTML 解析时同步执行, 在 React 水合之前就已经将正确的 class 应用到 DOM. React 水合时看到的 DOM 已经是正确状态, 不会产生不匹配, 用户也不会看到闪烁.

Next.js 中的推荐做法:

```tsx
// app/layout.tsx
export default function RootLayout({ children }) {
  return (
    <html suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `
              document.documentElement.classList.toggle(
                'dark',
                localStorage.theme === 'dark' ||
                (!('theme' in localStorage) &&
                  matchMedia('(prefers-color-scheme: dark)').matches)
              )
            `,
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
```

---

### Selective Hydration 和 Streaming SSR 是什么?

Streaming SSR:

传统 SSR 是"全有或全无"的: 服务器必须等所有数据就绪才能发送 HTML. Streaming SSR 允许服务器分块 (chunk) 发送 HTML:

```
传统 SSR:
[等待所有数据...] -> [发送完整 HTML] -> [下载 JS] -> [水合全部]

Streaming SSR:
[发送 Shell HTML] -> [发送 Suspense fallback]
                  -> [数据就绪, 发送实际内容]
                  -> [下载 JS] -> [水合已到达的部分]
```

在 Next.js 中通过 Suspense 实现:

```tsx
export default function Page() {
  return (
    <>
      <Header /> {/* 立即流式发送 */}
      <Suspense fallback={<PostsSkeleton />}>
        <Posts /> {/* 数据就绪后流式发送替换 skeleton */}
      </Suspense>
    </>
  );
}
```

Selective Hydration (选择性水合) :

React 18 的特性, 配合 Streaming SSR 使用:

1. 不需要等所有 JS 下载完才开始水合
2. 先水合已到达的、优先级高的部分
3. 如果用户与尚未水合的区域交互 (点击) , React 会:
   - 记录该交互
   - 优先水合该区域
   - 水合完成后重放交互

效果: 用户感知到的 TTI 大幅降低——即使页面只水合了 30%, 用户点击的那 30% 已经是可交互的.

---

## 四、消除请求瀑布流 (CRITICAL)

### 什么是请求瀑布流? 为什么它是性能第一杀手?

定义: 请求瀑布流 (Request Waterfall) 是指多个本可并行的异步操作被写成顺序 `await`, 导致每个操作都必须等待前一个完成才开始.

为什么是第一杀手:

假设三个 API 各需 200ms:

- 顺序执行: 200 + 200 + 200 = 600ms
- 并行执行: max(200, 200, 200) = 200ms

在真实场景中, 服务端到数据库/外部 API 的延迟可能是 50-500ms, 3-5 个顺序请求轻松产生 1-2 秒的无谓等待.

典型反模式:

```typescript
export async function GET(request: Request) {
  const session = await auth(); // 200ms
  const config = await fetchConfig(); // 200ms (等 auth 完成才开始)
  const data = await fetchData(); // 200ms (等 config 完成才开始)
  return Response.json({ data, config });
}
// 总耗时: 600ms, 实际只需 200ms
```

Vercel 工程团队的结论: 消除瀑布流带来的性能提升通常是 2-10 倍, 远超其他任何单项优化.

---

### 如何用 Promise.all() 消除独立操作的瀑布流?

核心原则: 没有数据依赖的异步操作必须并行执行.

```typescript
// 错误: 顺序执行, 3 次网络往返
const user = await fetchUser();
const posts = await fetchPosts();
const comments = await fetchComments();

// 正确: 并行执行, 1 次网络往返时间
const [user, posts, comments] = await Promise.all([
  fetchUser(),
  fetchPosts(),
  fetchComments(),
]);
```

API Route 中的模式——"早启动, 晚 await":

```typescript
export async function GET(request: Request) {
  // 立即启动所有独立操作
  const sessionPromise = auth();
  const configPromise = fetchConfig();

  // 需要 session 结果的操作在 await 后启动
  const session = await sessionPromise;
  const [config, data] = await Promise.all([
    configPromise,
    fetchData(session.user.id),
  ]);

  return Response.json({ data, config });
}
```

注意事项:

- `Promise.all` 是 fail-fast 的: 任一 Promise reject, 整体 reject
- 如果需要容错, 使用 `Promise.allSettled`
- 不要对有关联的操作强行并行 (会导致竞态条件)

---

### 如何处理有依赖关系的并行化?

当操作之间存在部分依赖时, 需要更精细的并行策略.

场景: `fetchProfile` 依赖 `fetchUser` 的结果, 但 `fetchConfig` 与两者无关.

方案一: 手动 Promise 链

```typescript
const userPromise = fetchUser();
const profilePromise = userPromise.then((user) => fetchProfile(user.id));

const [user, config, profile] = await Promise.all([
  userPromise,
  fetchConfig(),
  profilePromise,
]);
```

方案二: better-all 库 (自动依赖分析)

```typescript
import { all } from "better-all";

const { user, config, profile } = await all({
  async user() {
    return fetchUser();
  },
  async config() {
    return fetchConfig();
  },
  async profile() {
    return fetchProfile((await this.$.user).id);
  },
});
```

嵌套并行获取——避免慢项阻塞:

```typescript
// 错误: 一个慢的 getChat 阻塞所有 getUser
const chats = await Promise.all(chatIds.map((id) => getChat(id)));
const authors = await Promise.all(chats.map((chat) => getUser(chat.author)));

// 正确: 每个 item 独立链式获取
const chatAuthors = await Promise.all(
  chatIds.map((id) => getChat(id).then((chat) => getUser(chat.author))),
);
```

这样即使 100 个 chat 中有 1 个特别慢, 其他 99 个的 author 获取不受影响.

---

### 什么是 Defer Await 模式?

原则: 将 `await` 推迟到真正需要结果的分支中, 避免阻塞不需要的代码路径.

场景一: 条件跳过

```typescript
// 错误: skipProcessing 为 true 时仍然等待了 fetchUserData
async function handleRequest(userId: string, skipProcessing: boolean) {
  const userData = await fetchUserData(userId);
  if (skipProcessing) return { skipped: true };
  return processUserData(userData);
}

// 正确: 只在需要时获取
async function handleRequest(userId: string, skipProcessing: boolean) {
  if (skipProcessing) return { skipped: true };
  const userData = await fetchUserData(userId);
  return processUserData(userData);
}
```

场景二: 先检查廉价条件, 再 await 远程标志

```typescript
// 错误: 即使 someCondition 为 false, 也支付了 getFlag() 的网络开销
const someFlag = await getFlag();
if (someFlag && someCondition) {
  /* ... */
}

// 正确: 先检查同步条件
if (someCondition) {
  const someFlag = await getFlag();
  if (someFlag) {
    /* ... */
  }
}
```

场景三: 渐进式获取

```typescript
// 错误: 总是获取 permissions, 即使 resource 不存在
async function updateResource(resourceId: string, userId: string) {
  const permissions = await fetchPermissions(userId);
  const resource = await getResource(resourceId);
  if (!resource) return { error: "Not found" };
  if (!permissions.canEdit) return { error: "Forbidden" };
  return await updateResourceData(resource, permissions);
}

// 正确: 按需获取
async function updateResource(resourceId: string, userId: string) {
  const resource = await getResource(resourceId);
  if (!resource) return { error: "Not found" };

  const permissions = await fetchPermissions(userId);
  if (!permissions.canEdit) return { error: "Forbidden" };

  return await updateResourceData(resource, permissions);
}
```

---

### 如何利用 Suspense 边界实现流式渲染?

核心思想: 不要让数据获取阻塞整个页面的渲染. 将需要数据的部分包裹在 Suspense 中, 其余部分立即渲染.

```tsx
// 错误: 整个页面等待数据
async function Page() {
  const data = await fetchData();
  return (
    <div>
      <Sidebar />
      <Header />
      <DataDisplay data={data} />
      <Footer />
    </div>
  );
}

// 正确: 只有 DataDisplay 等待数据
function Page() {
  return (
    <div>
      <Sidebar />
      <Header />
      <Suspense fallback={<Skeleton />}>
        <DataDisplay />
      </Suspense>
      <Footer />
    </div>
  );
}

async function DataDisplay() {
  const data = await fetchData();
  return <div>{data.content}</div>;
}
```

共享 Promise 模式 (use Hook) :

```tsx
function Page() {
  const dataPromise = fetchData();

  return (
    <Suspense fallback={<Skeleton />}>
      <DataDisplay dataPromise={dataPromise} />
      <DataSummary dataPromise={dataPromise} />
    </Suspense>
  );
}

function DataDisplay({ dataPromise }: { dataPromise: Promise<Data> }) {
  const data = use(dataPromise);
  return <div>{data.content}</div>;
}
```

两个组件共享同一个 Promise, 只发起一次请求.

何时不用 Suspense:

- 影响布局的关键数据 (会导致布局偏移)
- 首屏 SEO 关键内容
- 非常快的查询 (Suspense 开销不值得)

---

## 五、Bundle 体积优化 (CRITICAL)

### 什么是 Barrel File? 为什么它严重影响性能?

Barrel File 是一个重新导出多个模块的入口文件 (通常是 `index.js`/`index.ts`) :

```typescript
// components/index.ts (Barrel File)
export { Button } from "./Button";
export { TextField } from "./TextField";
export { Dialog } from "./Dialog";
// ... 可能有数千个 re-export
```

问题:

当你写 `import { Check } from 'lucide-react'` 时:

1. 打包器需要解析 `lucide-react` 的入口文件
2. 入口文件 re-export 了 1583 个图标模块
3. 即使你只用 1 个图标, 开发模式下也需要加载所有模块
4. 运行时开销: 200-800ms 的冷启动时间

为什么 Tree-shaking 不够:

- 如果库被标记为 external (不打包) , bundler 无法优化
- 如果打包以启用 tree-shaking, 构建时间大幅增加
- 某些库的副作用标记不完善, tree-shaking 无法安全移除

解决方案:

```tsx
// Next.js: optimizePackageImports 目前仍位于 experimental 配置下 (Next 16.3 源码
// dist/server/config-shared.d.ts 中 ExperimentalConfig 仍包含该字段)
// lucide-react、@mui/material、react-icons、@headlessui/react 等常用库默认已启用,
// 只需为默认列表之外的库在 next.config.js 的 experimental 下追加配置
module.exports = {
  experimental: {
    optimizePackageImports: ["my-icon-lib", "@acme/ui"],
  },
};

// 非 Next.js 项目: 直接从子路径导入
import Button from "@mui/material/Button";
```

受影响的常见库: `lucide-react`、`@mui/material`、`react-icons`、`@headlessui/react`、`@radix-ui/react-*`、`lodash`、`date-fns`、`rxjs`

效果: 15-70% 更快的开发启动、28% 更快的构建、40% 更快的冷启动.

---

### 如何使用动态导入 (Dynamic Import) 优化首屏加载?

原则: 首屏不需要的重型组件不应该包含在主 Bundle 中.

next/dynamic 基本用法:

```tsx
import dynamic from "next/dynamic";

// 禁用 SSR (纯客户端组件, 如 Monaco Editor)
const MonacoEditor = dynamic(
  () => import("./monaco-editor").then((m) => m.MonacoEditor),
  {
    ssr: false,
  },
);

// 带 loading 状态
const Dashboard = dynamic(() => import("./Dashboard"), {
  loading: () => <DashboardSkeleton />,
});
```

注意: App Router 中 `ssr: false` 的 dynamic 只能在 Client Component 内使用, Server Component 中不允许 (会构建报错) .

条件加载模式:

```tsx
function AnimationPlayer({ enabled }: { enabled: boolean }) {
  const [frames, setFrames] = useState<Frame[] | null>(null);

  useEffect(() => {
    if (enabled && !frames && typeof window !== "undefined") {
      import("./animation-frames.js").then((mod) => setFrames(mod.frames));
    }
  }, [enabled, frames]);

  if (!frames) return <Skeleton />;
  return <Canvas frames={frames} />;
}
```

静态可分析路径的重要性:

```typescript
// 错误: bundler 无法确定要打包哪些模块
const Page = await import(PAGE_MODULES[pageName]);

// 正确: 显式映射
const PAGE_MODULES = {
  home: () => import("./pages/home"),
  settings: () => import("./pages/settings"),
} as const;
const Page = await PAGE_MODULES[pageName]();
```

---

### 第三方库的延迟加载策略有哪些?

策略一: next/dynamic + ssr: false

```tsx
const Analytics = dynamic(
  () => import("@vercel/analytics/react").then((m) => m.Analytics),
  {
    ssr: false,
  },
);
```

策略二: next/script 的 strategy 属性

```tsx
import Script from 'next/script'

<Script src="https://analytics.example.com/script.js" strategy="afterInteractive" />
<Script src="https://chat.example.com/widget.js" strategy="lazyOnload" />
```

策略三: requestIdleCallback 延迟初始化

```tsx
useEffect(() => {
  const initAnalytics = () => {
    import("./analytics").then((mod) => mod.init());
  };
  if ("requestIdleCallback" in window) {
    requestIdleCallback(initAnalytics);
  } else {
    setTimeout(initAnalytics, 1);
  }
}, []);
```

策略四: 基于 Feature Flag 的条件加载

```tsx
useEffect(() => {
  if (flags.newEditorEnabled && typeof window !== "undefined") {
    void import("./new-editor").then((mod) => mod.init());
  }
}, [flags.newEditorEnabled]);
```

---

### 什么是基于用户意图的预加载?

核心思想: 在用户"即将需要"某个重型模块时提前加载, 利用 hover/focus 等用户意图信号触发预加载.

```tsx
function EditorButton({ onClick }: { onClick: () => void }) {
  const preload = () => {
    if (typeof window !== "undefined") {
      void import("./monaco-editor");
    }
  };

  return (
    <button onMouseEnter={preload} onFocus={preload} onClick={onClick}>
      Open Editor
    </button>
  );
}
```

时间线对比:

```
无预加载: [hover] -> [click] -> [下载 300KB ~500ms] -> [渲染]
有预加载: [hover] -> [后台下载] -> [click] -> [立即渲染]
```

React DOM 的 preloadModule API:

```tsx
import { preloadModule } from "react-dom";

<a
  href="/dashboard"
  onMouseEnter={() => preloadModule("/dashboard.js", { as: "script" })}
>
  Dashboard
</a>;
```

---

## 六、服务端性能优化 (HIGH)

### React.cache() 和 LRU Cache 分别解决什么问题?

React.cache()——请求内去重:

```typescript
import { cache } from "react";

export const getCurrentUser = cache(async () => {
  const session = await auth();
  if (!session?.user?.id) return null;
  return await db.user.findUnique({ where: { id: session.user.id } });
});
```

在单次请求中, 无论多少个组件调用 `getCurrentUser()`, 数据库查询只执行一次.

重要限制:

- 使用 `Object.is` (引用相等) 判断缓存命中
- 内联对象参数永远无法命中缓存
- 只在单次请求生命周期内有效

LRU Cache——跨请求缓存:

```typescript
import { LRUCache } from "lru-cache";

const cache = new LRUCache<string, any>({
  max: 1000,
  ttl: 5 * 60 * 1000,
});

export async function getUser(id: string) {
  const cached = cache.get(id);
  if (cached) return cached;
  const user = await db.user.findUnique({ where: { id } });
  cache.set(id, user);
  return user;
}
```

对比:

| 维度     | React.cache()            | LRU Cache                |
| -------- | ------------------------ | ------------------------ |
| 生命周期 | 单次请求                 | 跨请求 (TTL 控制)        |
| 适用场景 | 组件树中多处调用同一查询 | 用户连续操作命中相同数据 |
| 内存管理 | 请求结束自动释放         | 需要配置 max/ttl         |

---

### 为什么不能在 RSC 中使用模块级可变状态?

根本原因: 服务端多个请求可能并发执行在同一个进程中. 模块级变量是进程共享的, 不是请求隔离的.

```tsx
// 危险: 模块级可变状态
let currentUser: User | null = null;

export default async function Page() {
  currentUser = await auth(); // 请求 A 设置
  return <Dashboard />;
}

async function Dashboard() {
  return <div>{currentUser?.name}</div>; // 可能读到请求 B 的数据
}
```

竞态条件: 请求 A 设置 `currentUser = Alice`, 请求 B 覆盖为 `Bob`, 请求 A 的 Dashboard 渲染出 "Bob"——安全漏洞.

正确做法: 通过 props 传递

```tsx
export default async function Page() {
  const user = await auth();
  return <Dashboard user={user} />;
}

function Dashboard({ user }: { user: User | null }) {
  return <div>{user?.name}</div>;
}
```

---

### RSC 序列化边界有哪些注意事项?

原则一: 只传递客户端需要的字段

```tsx
// 错误: 序列化全部 50 个字段
async function Page() {
  const user = await fetchUser();
  return <Profile user={user} />;
}

// 正确: 只传需要的字段
async function Page() {
  const user = await fetchUser();
  return <Profile name={user.name} />;
}
```

原则二: 避免重复序列化

RSC 序列化按对象引用去重:

```tsx
// 错误: toSorted() 创建新引用, 数组被序列化两次
<ClientList usernames={usernames} usernamesOrdered={usernames.toSorted()} />

// 正确: 在客户端做转换
<ClientList usernames={usernames} />
```

破坏去重的操作: `.toSorted()`、`.filter()`、`.map()`、`.slice()`、`{...obj}`、`structuredClone()`

---

### Server Actions 的安全最佳实践是什么?

Server Actions 本质上是公开的 HTTP 端点.

```typescript
"use server";

import { verifySession } from "@/lib/auth";
import { z } from "zod";

const schema = z.object({
  userId: z.string().uuid(),
  name: z.string().min(1).max(100),
});

export async function updateProfile(data: unknown) {
  // 1. 输入验证
  const validated = schema.parse(data);
  // 2. 认证
  const session = await verifySession();
  if (!session) throw new Error("Unauthorized");
  // 3. 授权
  if (session.user.id !== validated.userId) throw new Error("Forbidden");
  // 4. 执行
  await db.user.update({
    where: { id: validated.userId },
    data: { name: validated.name },
  });
  return { success: true };
}
```

安全清单: 每个 Action 内部独立验证认证和授权、使用 zod 验证输入、不信任客户端传递的 ID、限制错误信息暴露.

---

### after() 函数的作用和使用场景?

`after()` 在响应发送后执行非阻塞操作.

```tsx
import { after } from "next/server";

export async function POST(request: Request) {
  await updateDatabase(request);

  after(async () => {
    await logUserAction({ userAgent: (await headers()).get("user-agent") });
  });

  return Response.json({ status: "success" });
}
```

适用: 分析上报、审计日志、通知发送、缓存失效. 即使响应失败或重定向, `after()` 仍会执行.

---

## 七、客户端数据获取 (MEDIUM-HIGH)

### SWR 解决了什么问题? 与 React Query 有何异同?

SWR 核心能力: 请求去重、缓存与重验证 (stale-while-revalidate) 、焦点重验证、轮询、乐观更新.

```tsx
import useSWR from "swr";

function UserList() {
  const { data: users, error, isLoading } = useSWR("/api/users", fetcher);
  if (error) return <Error />;
  if (isLoading) return <Skeleton />;
  return (
    <ul>
      {users.map((u) => (
        <li key={u.id}>{u.name}</li>
      ))}
    </ul>
  );
}
```

SWR vs React Query:

| 维度     | SWR                 | React Query    |
| -------- | ------------------- | -------------- |
| 体积     | ~4KB                | ~12KB          |
| 理念     | 极简、HTTP 缓存语义 | 功能全面       |
| DevTools | 无                  | 有             |
| 适用     | 中小型、Vercel 生态 | 大型、复杂缓存 |

---

### 如何优化事件监听器的性能?

1. 共享单一监听器 (N 个组件 = 1 个 listener) :

使用模块级 Map 注册回调 + `useSWRSubscription` 共享单一全局监听器.

2. Passive Event Listeners (消除滚动延迟) :

```typescript
document.addEventListener("touchstart", handler, { passive: true });
document.addEventListener("wheel", handler, { passive: true });
```

浏览器不再等待监听器执行完毕才开始滚动. 适用于不调用 `preventDefault()` 的场景.

---

### localStorage 使用的最佳实践?

1. 版本化 key: `userConfig:v2`, 支持 Schema 迁移
2. 只存必要字段: 不存完整 API 响应, 避免存 token/PII
3. 始终 try-catch: 隐私模式、配额超限时会抛异常
4. 缓存读取: 用 Map 缓存 `getItem` 结果, 监听 `storage` 事件失效

---

## 八、重渲染优化 (MEDIUM)

### React 重渲染的触发条件和优化策略总览?

触发条件: state 变化、父组件重渲染、Context 值变化、外部 store 变化.

优化策略:

| 策略              | API                     |
| ----------------- | ----------------------- |
| 组件提取 + memo   | `React.memo()`          |
| 派生值替代状态    | 直接计算                |
| 函数式 setState   | `setState(prev => ...)` |
| useDeferredValue  | 延迟昂贵渲染            |
| startTransition   | 非紧急更新              |
| useRef 替代 state | 瞬态值                  |
| useMemo           | 昂贵计算缓存            |

---

### 为什么不能在组件内部定义组件?

每次父组件渲染时, 内部定义的组件都是全新的函数引用. React 通过引用判断组件类型——引用变了就完全卸载旧实例并挂载新实例.

症状: 输入框失去焦点、动画重启、Effect 反复执行、滚动位置重置.

修复: 提取到外部, 通过 props 传递数据.

---

### useMemo/useCallback 的正确使用姿势? 什么时候不该用?

该用: 昂贵计算、传给 memo 组件的引用类型 props、作为其他 Hook 依赖的值.

不该用: 简单原始值计算 (`a || b`) 、不传给子组件的内部值、React Compiler 已启用时.

memo 默认参数陷阱:

```tsx
// 错误: () => {} 每次都是新引用
const Comp = memo(function Comp({ onClick = () => {} }) { ... })

// 正确: 提取为常量
const NOOP = () => {}
const Comp = memo(function Comp({ onClick = NOOP }) { ... })
```

---

### 什么是派生状态? 为什么不应该用 Effect 同步状态?

可从 props/state 计算得出的值不应独立存储为 state. 用 Effect 同步会导致额外渲染和状态漂移.

```tsx
// 错误
const [fullName, setFullName] = useState("");
useEffect(() => {
  setFullName(first + " " + last);
}, [first, last]);

// 正确
const fullName = first + " " + last;
```

---

### useDeferredValue 和 startTransition 的区别与使用场景?

| 维度     | startTransition      | useDeferredValue |
| -------- | -------------------- | ---------------- |
| 控制什么 | 何时发起更新         | 某个值何时生效   |
| 适用     | 能控制 setState 调用 | 值来自 props     |

`useTransition` 额外提供 `isPending` 状态, 替代手动 `setIsLoading`.

---

### 函数式 setState 更新为什么重要?

1. 避免闭包陷阱: 始终操作最新 state
2. 稳定回调引用: useCallback 无需依赖 state
3. 防止 bug: 消除最常见的 React 闭包错误来源

```tsx
// 稳定且安全
const removeItem = useCallback((id: string) => {
  setItems((curr) => curr.filter((item) => item.id !== id));
}, []);
```

---

### useRef 用于瞬态值的模式?

频繁变化但不影响 JSX 输出的值 (鼠标位置、动画帧、计时器 ID) 用 ref 存储, 避免 60fps 重渲染. 直接操作 DOM 的 `style.transform` 实现零重渲染动画.

---

## 九、渲染性能优化 (MEDIUM)

### content-visibility 如何优化长列表渲染?

```css
.message-item {
  content-visibility: auto;
  contain-intrinsic-size: 0 80px;
}
```

浏览器跳过视口外元素的布局和绘制. 1000 条消息只渲染可见的约 10 条, 初始渲染速度提升约 10 倍. 相比虚拟滚动, 实现更简单、DOM 完整 (可访问性好) .

---

### React DOM Resource Hints 有哪些? 如何使用?

| API                   | 作用           |
| --------------------- | -------------- |
| `prefetchDNS(href)`   | 预解析 DNS     |
| `preconnect(href)`    | 预建立连接     |
| `preload(href, opts)` | 预下载资源     |
| `preloadModule(href)` | 预下载 ES 模块 |
| `preinit(href, opts)` | 预下载并执行   |

在 Server Component 中使用尤其有效: 资源提示嵌入 HTML `<head>`, 浏览器解析 HTML 时就开始加载.

---

### useTransition 替代手动 loading 状态的优势?

- 自动管理 pending 状态 (即使 async 抛错也正确重置)
- 新 transition 自动取消旧的 pending
- 可中断: 高优先级更新打断进行中的 transition
- 代码更简洁: 少一个 useState

---

### 条件渲染中 && 运算符的陷阱?

`0` 和 `NaN` 是 falsy 但 React 会渲染为文本.

```tsx
// 错误: count=0 时渲染出 "0"
{
  count && <Badge>{count}</Badge>;
}

// 正确
{
  count > 0 ? <Badge>{count}</Badge> : null;
}
```

---

## 十、JavaScript 性能微优化 (LOW-MEDIUM)

### 什么是布局抖动 (Layout Thrashing) ? 如何避免?

交替进行 DOM 样式写入和布局读取, 强制浏览器每次读取时同步回流.

```typescript
// 错误
el.style.width = "100px";
const w = el.offsetWidth; // 强制回流
el.style.height = "200px";
const h = el.offsetHeight; // 又回流

// 正确: 批量写入, 最后读取
el.style.width = "100px";
el.style.height = "200px";
const rect = el.getBoundingClientRect(); // 1 次回流
```

React 中优先使用 CSS class 而非内联样式操作.

---

### 数组操作的性能最佳实践?

1. Set/Map 替代 includes/find: O(n) -> O(1)
2. 构建索引 Map: 1000x1000 = 1M ops -> 2K ops
3. 合并多次遍历为一次
4. flatMap 替代 map + filter
5. toSorted() 替代 sort(): 不可变, 不破坏 React 状态
6. 循环找最值替代排序: O(n) vs O(n log n)
7. 长度预检查: 数组比较前先检查 length

---

### requestIdleCallback 的使用场景和分片处理模式?

将非关键工作推迟到浏览器空闲时: 分析上报、localStorage 持久化、预取资源.

分片处理大任务:

```typescript
function processChunk(deadline: IdleDeadline) {
  while (index < items.length && deadline.timeRemaining() > 0) {
    processItem(items[index]);
    index++;
  }
  if (index < items.length) requestIdleCallback(processChunk);
}
requestIdleCallback(processChunk);
```

带 `{ timeout: 2000 }` 保证最迟执行时间.

---

## 十一、React 常见陷阱 (Pitfalls)

### useEffect 的常见误用和正确心智模型?

正确心智模型: Effect 是"与外部系统同步"的逃生舱口, 不是"响应状态变化执行逻辑"的通用工具.

常见误用:

1. 用 Effect 做事件处理 -> 应放在事件处理器中
2. 用 Effect 同步派生状态 -> 应渲染时直接计算
3. 依赖数组过宽 (`[user]` 而非 `[user.id]`)
4. 在 Effect 中读取只在回调中使用的订阅值

正确使用场景: 订阅外部系统、浏览器 API 交互、数据获取 (无 SWR/RQ 时) 、动画控制.

---

### 闭包陷阱 (Stale Closure) 是什么? 如何避免?

回调捕获了某次渲染的 state, 后续渲染中仍引用旧值.

解决方案:

1. 函数式 setState: `setState(prev => ...)`
2. useRef 保存最新值
3. useEffectEvent (React 最新 API)
4. 正确的依赖数组

---

### React 中状态提升 vs Context vs 状态管理库如何选型?

| 方案            | 适用                      |
| --------------- | ------------------------- |
| Props           | 2-3 层共享                |
| Context         | 低频全局数据 (主题、语言) |
| Zustand/Jotai   | 中大型、高频更新          |
| Redux Toolkit   | 大团队、复杂逻辑          |
| URL State       | 可分享状态                |
| SWR/React Query | 服务端数据                |

原则: 能用 props 就用 props; Context 适合写少读多; 高频更新需拆分 Context; 服务端数据用专门工具.

---

### key 的正确使用方式和常见错误?

- 不要用 index 作 key (列表增删时状态错乱)
- 使用稳定的唯一 ID
- 不要用 `Math.random()` 作 key
- key 只需在同级兄弟中唯一

---

## 十二、高级模式

### useEffectEvent 解决了什么问题?

在 Effect 中需要调用使用最新 props/state 的回调, 但不想让它成为 Effect 依赖. `useEffectEvent` 在 React 19.2 转正 (此前为实验性) .

```tsx
const onSearchEvent = useEffectEvent(onSearch);

useEffect(() => {
  const timeout = setTimeout(() => onSearchEvent(query), 300);
  return () => clearTimeout(timeout);
}, [query]); // 不需要 onSearch 作为依赖
```

规则: `useEffectEvent` 返回的函数不应出现在依赖数组中.

---

### Activity 组件的用途和原理?

频繁切换显示/隐藏的昂贵组件, 用 `Activity` (React 19.2+) 保持状态和 DOM:

```tsx
<Activity mode={activeTab === "chat" ? "visible" : "hidden"}>
  <ChatPanel />
</Activity>
```

hidden 时: DOM 保留、Effect cleanup; visible 时: 恢复显示、Effect 重新 setup. 适用于 Tab 面板、下拉菜单、模态框.

---

### React Compiler 对性能优化的影响?

React Compiler 自动进行组件级记忆化 (等效于自动 memo/useMemo/useCallback) . 它已于 2025 年 10 月发布 1.0, 以独立 Babel 插件启用, 兼容 React 17+, 需手动接入 (Next.js 可通过 next.config 的 reactCompiler 选项开启) .

启用后无需手动: useMemo、useCallback、React.memo、静态 JSX 提升.

仍需手动处理: 消除瀑布流、代码分割、服务端缓存、Bundle 优化、状态设计.

Compiler 解决"组件级记忆化", 不解决"架构级性能".

---

### Next.js 中的缓存策略全景图?

| 层级                | 机制           | 作用域   | 失效方式           |
| ------------------- | -------------- | -------- | ------------------ |
| Request Memoization | fetch 自动去重 | 单次请求 | 请求结束释放       |
| Data Cache          | fetch 持久缓存 | 跨请求   | revalidatePath/Tag |
| Full Route Cache    | 整页 HTML      | 跨请求   | revalidate/dynamic |
| Router Cache        | 客户端路由缓存 | 用户会话 | 导航/refresh       |

注意: 自 Next.js 15 起, fetch 默认不再缓存 (相当于 no-store) , Data Cache 需要显式 opt-in (cache: "force-cache" 或 next.revalidate) . Next.js 16 引入可选的 Cache Components (cacheComponents 配置, 即 PPR 演进方向) , 通过 use cache 指令声明缓存边界, 正在把缓存从"默认全开"转变为"显式声明"模型.

补充缓存:

- `React.cache()`: 非 fetch 异步操作的请求内去重
- LRU Cache: 跨请求的内存缓存
- 模块级 Promise: 静态 I/O 只加载一次

```tsx
// 静态缓存
fetch(url, { cache: "force-cache" });
// 动态获取
fetch(url, { cache: "no-store" });
// 定时重验证
fetch(url, { next: { revalidate: 3600 } });
// 标签重验证
fetch(url, { next: { tags: ["posts"] } });
revalidateTag("posts");
```

---

## 参考资料

- Vercel React Best Practices (v1.0.0, January 2026)
- React 官方文档: https://react.dev
- Next.js 官方文档: https://nextjs.org
- SWR: https://swr.vercel.app
- better-all: https://github.com/shuding/better-all
- node-lru-cache: https://github.com/isaacs/node-lru-cache
