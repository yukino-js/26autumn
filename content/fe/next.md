---
title: "Next.js 16 App Router 全栈实践"
description: "App Router 的组件边界、数据获取与请求瀑布消除、缓存与重验证模型、路由与 Metadata、流式渲染、Server Actions、图片与字体, 以及静态导出与 Next 16 的基线要点"
---

这份文档面向准备用 Next.js 16 App Router 构建生产应用的工程师. 它以"能力 + 机制 + 适用边界"为主线: 渲染策略怎么选, 服务端组件与客户端组件的边界划在哪里, 缓存有哪几层、各自的失效方式是什么, 请求瀑布如何消除, 以及 Next 16 的基线要点有哪些. 阅读前建议先了解 [React 19](react) 的渲染阶段与 Suspense 语义, 本文不再重复; 构建与打包机制见 [Vite](vite).

## 渲染策略: CSR、SSR、SSG、ISR

### 四种策略的定位

| 策略 | 何时生成 HTML            | 数据新鲜度 | 典型场景                              | 在 App Router 中的表达                         |
| ---- | ------------------------ | ---------- | ------------------------------------- | ---------------------------------------------- |
| CSR  | 浏览器运行时             | 实时       | 登录后后台、强交互面板                | 客户端组件 + 数据获取库                        |
| SSR  | 每次请求                 | 实时       | 个性化内容、依赖请求头/ Cookie 的页面 | 使用请求期 API, 或 `dynamic = "force-dynamic"` |
| SSG  | 构建时                   | 构建时快照 | 文档、营销页、不常变的博客            | 默认行为, 路由不访问请求期数据即预渲染         |
| ISR  | 构建时 + 按需/定时重验证 | 秒到天级   | 商品列表、新闻首页                    | 缓存指令 + `cacheLife` 或 `revalidate`         |

选择这三个维度就够了: 内容是否因人/因请求而变 (决定 SSR 还是预渲染), 更新频率是分钟/小时/天级还是几乎不变 (决定 ISR 的时长), 是否需要 SEO 与社交预览 (决定能否纯 CSR).

### 请求时间线

从用户视角看, CSR 与 SSR 的差别在于"看到内容"和"可交互"两个时间点落在哪里.

```text
CSR:
  HTML(空壳) ──> 下载 JS ──> 执行 JS ──> 发起数据请求 ──> 渲染内容
                                                    ^ 首屏内容

SSR / 服务端渲染:
  服务端取数 + 生成 HTML ──> 下载 JS ──> 水合
  ^ 首屏内容                              ^ 可交互

流式服务端渲染:
  服务端发出 shell ──> 立即显示骨架 ──> 数据就绪后补发该片段
  ^ 首屏内容              ^ 部分可交互
```

CSR 的问题不止是慢: 空壳 HTML 对不执行 JavaScript 的爬虫和社交平台抓取器等于不存在, 首屏内容完全依赖 JS 下载与执行. SSR 把"能生成内容"的部分前移到服务端, 代价是服务器要承担渲染成本、TTFB 可能上升, 并且必须处理水合一致性.

### 流式渲染

流式渲染把"整页就绪才发送"改为"边生成边发送": 先发送能立刻确定的 shell, 遇到尚未就绪的片段时先发送 fallback, 数据到达后再把该片段补发到同一个响应流中. 在 App Router 中, 边界由 `<Suspense>` 表达:

```tsx
export default function Page() {
  return (
    <>
      <Header />
      <Suspense fallback={<PostsSkeleton />}>
        <Posts />
      </Suspense>
      <Footer />
    </>
  );
}

async function Posts() {
  const posts = await getPosts();
  return <PostList posts={posts} />;
}
```

`Header` 与 `Footer` 随 shell 立即发送, `Posts` 所在片段在数据就绪后替换骨架. 浏览器可以更早开始解析 HTML、加载资源并在已到达的部分上做水合, 用户感知到的可交互时间因此提前.

几个使用边界: 影响布局的关键数据放入 Suspense 会引起布局偏移; 首屏 SEO 关键内容放进 fallback 会让爬虫只看到骨架; 非常快的查询加 Suspense 的调度开销可能超过收益. 另外 Suspense 本身只是"承诺边界", 它不会自动让组件变成动态渲染, 只做同步工作的组件即使被包住也会在预渲染阶段完成.

## App Router 的组件模型

### 两类组件的分工

App Router 默认所有组件都是 Server Component, 只有显式标注 `'use client'` 的模块及其导入图才进入客户端包.

| 维度                 | Server Component                            | Client Component                            |
| -------------------- | ------------------------------------------- | ------------------------------------------- |
| 运行位置             | 仅服务端                                    | 服务端预渲染 + 客户端水合                   |
| 代码是否进入客户端包 | 否                                          | 是                                          |
| 可用能力             | 直接访问数据库、文件系统、环境变量、密钥    | 浏览器 API、事件处理器、生命周期与状态 Hook |
| 不能用               | `useState`、`useEffect`、事件处理器、类组件 | 直接在模块顶层读数据库、访问密钥            |
| 输出                 | 序列化后的组件树 (RSC Payload) + 首屏 HTML  | 首屏 HTML + 模块引用, 由客户端执行          |

关键区别在于 Server Component 的代码永远不会发到浏览器. 在页面里直接查询数据库, 不需要额外搭一层 API 把数据"搬"给前端; 对应的库和查询逻辑也不会出现在客户端包里.

### 'use client' 的语义

`'use client'` 标记的是模块边界, 不是单个组件. 它声明"这个文件的导出需要在客户端运行", 并且该文件导入的所有模块都会被拉进客户端图. 因此边界要尽量下压: 把交互部分单独抽成一个文件, 而不是在页面顶部加指令.

```tsx
// app/post/[id]/page.tsx —— 服务端组件, 只在服务端执行
import { LikeButton } from "./like-button";

export default async function PostPage({ params }: PageProps<"/post/[id]">) {
  const { id } = await params;
  const post = await db.post.findUnique({ where: { id } });
  if (!post) notFound();
  return (
    <article>
      <h1>{post.title}</h1>
      <LikeButton postId={post.id} initialLikes={post.likes} />
    </article>
  );
}
```

`'use client'` 的传播方向是向下的: 客户端组件可以包含其他客户端组件, 也可以接收服务端组件作为 `children`. 但服务端组件不能导入客户端组件再把它当函数调用, 只能作为元素渲染.

### 序列化边界

从服务端组件传给客户端组件的 props 必须可序列化. 函数 (事件处理器、服务端函数除外)、类实例、Symbol、可变的模块级单例都不能直接跨越这条边界.

这带来一个容易忽视的性能约束: 传递的数据会被序列化进 RSC Payload, 而序列化按对象引用去重. 同一个对象引用只发一次, 但任何会破坏引用相等的操作都会让它被重复发送:

| 操作                                                | 是否破坏去重 | 建议                                 |
| --------------------------------------------------- | ------------ | ------------------------------------ |
| 直接透传原数组                                      | 否           | 优先                                 |
| `.filter()` / `.map()` / `.slice()` / `.toSorted()` | 是           | 把原始数据传给客户端, 在客户端做转换 |
| 对象展开 `{...obj}`                                 | 是           | 只传需要的字段                       |
| `structuredClone()`                                 | 是           | 避免在传给客户端之前克隆             |

更根本的原则是只传客户端真正需要的字段. 服务端取到 50 个字段的对象却只用一个 `name`, 就应该只传 `name`, 这既减少传输量, 也避免把不该暴露的字段带进客户端.

### 组合模式

当服务端组件与客户端组件需要协作时, 常用做法是让客户端组件只负责交互外壳, 内容通过 `children` 由服务端注入:

```tsx
// ClientShell 是客户端组件, 内部有状态与交互
<ClientShell>
  <ServerContent /> {/* 服务端渲染, 代码不进客户端包 */}
</ClientShell>
```

这样客户端组件不需要知道内容的实现, 内容的取数与渲染都留在服务端. 反过来把整个页面标成客户端组件, 会让它导入的一切都进入客户端包, 是最常见的边界误用.

## 数据获取与请求瀑布消除

### 服务端直接取数

Server Component 可以是 `async` 函数, 直接用 `await` 取数即可, 不需要额外的数据传递层. 不同分支的组件会并行执行: 页面返回的两棵子树各自 `await` 自己的数据, 互不阻塞.

```tsx
async function Header() {
  const nav = await getNav(); // 与 Sidebar 并行
  return <nav>{/* ... */}</nav>;
}

async function Sidebar() {
  const items = await getSidebar(); // 与 Header 并行
  return <aside>{/* ... */}</aside>;
}

export default function Page() {
  return (
    <div>
      <Header />
      <Sidebar />
    </div>
  );
}
```

### 消除瀑布的三种手段

瀑布指的是本可并行的异步操作被写成顺序 `await`, 每个操作都等前一个完成. 三个各需 200ms 的请求顺序执行是 600ms, 并行是 200ms; 真实链路里服务端到数据库或外部 API 的延迟常是几十到几百毫秒, 三五个串行就能产生一两秒的无谓等待.

手段一是并行: 无依赖的请求放进 `Promise.all`. 手段二是"早启动, 晚 await": 先发起所有独立请求拿到 Promise, 再在需要结果时才 `await`. 手段三是当依赖只影响部分结果时, 用 Promise 链把依赖扁平化:

```ts
const userPromise = fetchUser();
const profilePromise = userPromise.then((user) => fetchProfile(user.id));

const [user, config, profile] = await Promise.all([
  userPromise,
  fetchConfig(),
  profilePromise,
]);
```

嵌套映射时要避免"慢项阻塞": 先对所有 id 并发取 item, 再对所有 item 并发取详情, 会让最慢的那个 item 阻塞其余所有详情请求; 改成每个 item 内部自己串行、item 之间并行, 就能让快的先出结果.

`Promise.all` 是快速失败的: 任一分支 reject 整体就 reject. 需要容错时用 `Promise.allSettled`, 或者在单个分支内部捕获, 把它降级为一个可展示的错误值.

### 请求内去重与跨请求缓存

`React.cache()` 解决的是"同一次渲染中, 多个组件调用同一个查询": 它按参数做请求内去重, 保证底层只执行一次.

```ts
import { cache } from "react";

export const getCurrentUser = cache(async () => {
  const session = await auth();
  if (!session?.user?.id) return null;
  return db.user.findUnique({ where: { id: session.user.id } });
});
```

命中判定用引用相等, 因此传入字面量对象或数组参数时永远无法命中; 只在单次请求生命周期内有效, 请求结束即释放. 需要跨请求的内存缓存 (例如同一用户的连续操作命中相同数据) 则用带 `max`/`ttl` 的 LRU 缓存, 但它要考虑多实例部署下的一致性问题.

### 不能在服务端组件里放模块级可变状态

服务端进程会并发处理多个请求, 模块级变量是进程共享的, 不隔离请求. 下面这种写法会让请求 A 的渲染读到请求 B 的数据, 既是 bug 也是安全漏洞:

```tsx
// 危险
let currentUser = null;

export default async function Page() {
  currentUser = await auth();
  return <Dashboard />;
}
```

正确做法是把请求相关的数据通过 props 或 `React.cache()` 传递, 永远不要依赖可变的模块级状态.

## 缓存与重验证

### 四个缓存层级

理解 Next 的缓存, 关键是分清"缓存的是什么""作用域多大""怎么失效".

| 层级           | 缓存内容                                        | 作用域       | 失效方式                                                |
| -------------- | ----------------------------------------------- | ------------ | ------------------------------------------------------- |
| 请求内记忆     | 同一渲染过程内 URL 与选项相同的 GET 请求去重    | 单次渲染     | 渲染结束自动释放                                        |
| 数据缓存       | `fetch` 或 `use cache` 显式声明的服务端持久缓存 | 跨请求       | `revalidateTag` / `updateTag` / `revalidatePath` / 到期 |
| 预渲染产物     | 构建期生成的 HTML 与 RSC Payload                | 跨请求       | 重验证或改为动态渲染                                    |
| 客户端路由缓存 | 浏览器内存中的 RSC Payload                      | 单个浏览会话 | `router.refresh()` / 相关重验证 API / 导航              |

请求内去重只在组件树渲染期间生效, Route Handler 不属于 React 组件树, 因此不参与这种去重.

### fetch 的默认行为

在未启用 Cache Components 的默认模型下, `fetch` 请求默认不缓存. 一个没有设置 `cache` 选项的请求, 如果位于路由被预渲染的范围内, 会在构建时执行一次并固化进产物; 如果位于请求期 API 之后, 则每次请求都重新执行. 需要跨请求复用时要显式声明:

```ts
fetch(url, { cache: "force-cache" }); // 尽量复用
fetch(url, { cache: "no-store" }); // 每次重新拉取
fetch(url, { next: { revalidate: 3600 } }); // 一小时后过期
fetch(url, { next: { tags: ["posts"] } }); // 打标签以便按需失效
```

不依赖 `fetch` 的数据源 (数据库查询、第三方 SDK) 用 `unstable_cache` 包一层, 并同样给出 key 前缀、标签与过期时间. Route Handler 的 GET 默认是动态的, 需要静态化时显式声明 `export const dynamic = "force-static"`.

### 时间与按需重验证

Cache Components 模型下, 缓存的生命周期由 `cacheLife` 配置, 提供一组预设档位:

| 档位      | stale  | revalidate | expire |
| --------- | ------ | ---------- | ------ |
| `default` | 5 分钟 | 15 分钟    | 不过期 |
| `seconds` | 30 秒  | 1 秒       | 60 秒  |
| `minutes` | 5 分钟 | 1 分钟     | 1 小时 |
| `hours`   | 5 分钟 | 1 小时     | 1 天   |
| `days`    | 5 分钟 | 1 天       | 1 周   |
| `weeks`   | 5 分钟 | 1 周       | 30 天  |
| `max`     | 5 分钟 | 30 天      | 不过期 |

`stale` 是"可以继续提供旧数据"的窗口, `revalidate` 是后台刷新的间隔, `expire` 是超过多久必须丢弃并等待新数据.

按需失效有三个 API, 语义差别很关键:

| API                           | 调用位置                     | 下次请求的行为                                  | 适用                                      |
| ----------------------------- | ---------------------------- | ----------------------------------------------- | ----------------------------------------- |
| `revalidateTag(tag, profile)` | Server Action、Route Handler | 先返回旧数据, 后台刷新 (stale-while-revalidate) | 更新延迟可以接受, 例如商品目录、文档      |
| `updateTag(tag)`              | 仅 Server Action             | 立即过期, 下次请求等待新数据                    | 写后立即读到自己的变更 (read-your-writes) |
| `revalidatePath(path)`        | Server Action、Route Handler | 按路径失效                                      | 失效范围是页面而非数据                    |

`revalidateTag` 的第二个参数 (`cacheLife` 档位名或 `{ expire }` 对象) 决定旧数据还能被提供多久, 推荐传 `max` 获得最长的陈旧窗口; 需要写后立即读到自己的变更时改用 `updateTag`. 标签必须先被赋给缓存数据——用 `fetch` 的 `next.tags`, 或在 `use cache` 作用域内调用 `cacheTag`.

一个容易误解的点: 重验证由请求触发, 而不是由 `revalidateTag` 调用触发. 打了标签的页面在下次被访问时才刷新, 不会在调用的一瞬间全部更新. 客户端侧还有 `refresh()` 用于清除当前路由的客户端缓存并重新请求, 它不失效服务端缓存.

### Cache Components 与 use cache

下一代缓存模型由顶层配置 `cacheComponents: true` 开启. 它把缓存从"默认尽量缓存"改为"显式声明": 在函数或组件体内写 `'use cache'`, 该结果的返回值进入缓存, 参数与被捕获的值自动成为缓存键.

```ts
import { cacheLife, cacheTag } from "next/cache";

export async function getProducts() {
  "use cache";
  cacheLife("hours");
  cacheTag("products");
  return db.query("SELECT * FROM products");
}
```

指令可以放在数据处理函数上 (数据级), 也可以放在整个组件或页面上 (UI 级); 如果放在文件顶部, 该文件所有导出都会进入缓存. 缓存结果会成为静态 shell 的一部分, 从而可能被预取.

启用后有一条重要的约束: 未被缓存、又不在 `<Suspense>` 内的异步读取会让构建报错 (开发时呈现阻塞路由提示). 处理方式只有两种——用 `'use cache'` 声明缓存并给出生命周期, 或者用 `<Suspense>` 包住, 让它在请求时流式填充. 短生命周期的缓存 (例如 `seconds` 档位) 会被自动排除出预渲染, 变成动态空洞.

### 与其他缓存手段的关系

`React.cache()`、LRU、模块级 Promise 和上面的缓存层并不互斥: `React.cache()` 负责请求内去重, LRU 负责跨请求的内存复用, 模块级 Promise 适合"进程内只初始化一次"的静态资源加载. 但它们都不参与 Next 的持久化数据缓存, 也就不会被 `revalidateTag` 失效, 混用时要清楚各自的失效边界.

## 路由、布局与导航

### 文件约定

App Router 用目录结构与文件约定表达路由与渲染行为:

| 文件            | 作用                                       |
| --------------- | ------------------------------------------ |
| `page.tsx`      | 路由对应的页面, 使该路径可访问             |
| `layout.tsx`    | 共享外壳, 在导航时保持挂载并保留状态       |
| `template.tsx`  | 类似 layout, 但每次导航都重新挂载          |
| `loading.tsx`   | 该段的即时加载态, 内部即一个 Suspense 边界 |
| `error.tsx`     | 该段的错误边界 (必须是客户端组件)          |
| `not-found.tsx` | 该段未命中时的界面, 由 `notFound()` 触发   |
| `default.tsx`   | 并行路由中缺少匹配时的回退                 |
| `route.ts`      | Route Handler, 与 `page` 互斥              |

动态段用 `[slug]` 表示, 捕获所有后续段用 `[...slug]`, 可选捕获用 `[[...slug]]`, 路由组用 `(group)` 只影响组织方式不影响 URL.

### params 与 searchParams 必须异步访问

请求期 API 只支持异步访问. 以下内容都只能 `await`:

- `params` 在 `layout`、`page`、`route`、`default` 以及图片元数据文件中是 Promise.
- `searchParams` 在 `page` 中是 Promise.
- `cookies()`、`headers()`、`draftMode()` 返回 Promise.

```tsx
export default async function Page({
  params,
  searchParams,
}: PageProps<"/post/[id]">) {
  const { id } = await params;
  const query = await searchParams;
  // ...
}
```

用 `npx next typegen` 可以生成 `PageProps`、`LayoutProps`、`RouteContext` 等全局类型助手, 让 `await props.params` 的字段类型与路由结构对应, 避免手写类型漂移.

### 动态路由与静态参数

动态段默认在请求时解析. 想让已知的取值在构建期预渲染, 用 `generateStaticParams` 返回参数列表; 这样这些路径可以静态化, 未列出的路径按 `dynamicParams` 的配置决定是报 404 还是请求时生成. 与 `generateStaticParams` 组合的 `use cache` 可以同时覆盖预渲染参数与运行期参数.

### 导航与预取

`<Link>` 默认会对可视区域内的链接预取目标路由的 RSC Payload. Next 16 的导航系统做了两处优化: 共享布局在预取多个 URL 时只下载一次 (布局去重), 以及只预取缓存中缺失的部分 (增量预取). 代价是可能出现更多次独立请求, 但总传输量更小.

导航到尚未就绪的路由时, `loading.tsx` 提供即时反馈; 已经挂载的布局不会重新渲染, 因此布局中的状态 (例如未受控的输入或滚动容器) 会保留.

## Metadata 与 SEO

### 静态与动态 metadata

`metadata` 对象适合不依赖请求的固定信息, `generateMetadata` 适合需要取数或依赖路由参数的场景. 两者可以放在 layout 与 page 中, 逐层合并, 更靠近页面的定义优先.

```tsx
export async function generateMetadata({
  params,
}: PageProps<"/post/[id]">): Promise<Metadata> {
  const { id } = await params;
  const post = await getPost(id);
  return {
    title: post.title,
    description: post.excerpt,
    openGraph: { images: [post.cover] },
  };
}
```

字段的继承与覆盖遵循固定规则: `title` 的子级定义会被父级模板包装 (通过 `title.template`), `openGraph` 与 `twitter` 这类对象会逐字段合并, 而数组字段 (如 `keywords`) 由子级整体替换父级.

### 约定式元数据文件

除了在组件里导出 metadata, 还可以用文件约定生成: `sitemap.ts`、`robots.ts`、`manifest.ts`、`opengraph-image`、`twitter-image`、`icon`、`apple-icon`. 图片类文件可以用 JSX 与样式动态生成, 适合按文章标题批量产出社交卡片. 图片生成函数的 `params` 与 `id` 也是 Promise (`generateImageMetadata` 接收同步的 `params`).

需要注意 `generateMetadata` 与页面渲染的关系: 它参与渲染并可能阻塞首字节. 对不影响首屏可见内容、但依赖较慢数据的元数据, 应谨慎评估是否放进 `generateMetadata`.

## Server Actions 与表单

### 定义与调用

Server Action 是一个用 `'use server'` 标注的异步函数, 可以直接从客户端组件调用. Next 在构建期把它编译成一个引用, 客户端拿到的只是加密后的标识, 真正的函数体留在服务端.

```ts
"use server";

import { updateTag } from "next/cache";

export async function createPost(formData: FormData) {
  const title = String(formData.get("title"));
  const post = await db.post.create({ data: { title } });
  updateTag("posts");
  updateTag(`post-${post.id}`);
}
```

它可以直接作为 `<form action={...}>` 的 action, 也可以作为按钮的事件处理器. 在表单场景下, 即使 JavaScript 尚未加载完成, 浏览器仍会以原生表单提交的方式把请求发给服务端, 这是渐进增强的来源.

### 与 React 19 表单 Hook 的配合

Actions 的 pending 与返回值由 React 的表单 Hook 消费:

| Hook             | 来源        | 用途                                        |
| ---------------- | ----------- | ------------------------------------------- |
| `useActionState` | `react`     | 管理 Action 的返回状态、dispatch 与 pending |
| `useFormStatus`  | `react-dom` | 在表单子组件中读取 pending, 无需 prop 传递  |
| `useOptimistic`  | `react`     | 提交期间展示乐观结果, 失败自动回滚          |

典型组合是: 表单用 `useActionState` 拿到 `formAction` 与状态, 提交按钮用 `useFormStatus` 自行禁用自己, 列表用 `useOptimistic` 立即插入待确认条目.

### 安全

Server Action 本质上是公开的 HTTP 端点, 客户端可以构造任意参数调用它. 因此每个 Action 内部都必须独立完成验证、认证与授权, 不能依赖调用方是"自己人".

```ts
"use server";

export async function updateProfile(input: unknown) {
  const data = schema.parse(input); // 1. 校验输入
  const session = await verifySession(); // 2. 认证
  if (!session) throw new Error("unauthorized");
  if (session.user.id !== data.userId) throw new Error("forbidden"); // 3. 授权
  await db.user.update({ where: { id: data.userId }, data });
}
```

框架提供的额外保障有三点: Action 请求体默认上限 1MB (可用 `experimental.serverActions.bodySizeLimit` 调整); 未使用的 Server Function 会在构建期从客户端包中移除, 不会留下公开端点; 内联 Action 捕获的闭包变量在发送给客户端前会被加密. 多实例或自托管部署时, 需要为所有实例配置同一个稳定密钥, 否则闭包解密会失败.

还有两个容易忽略的边界: Action 不是通用 API, 需要给第三方调用的接口应当用 Route Handler; Action 内部抛出的错误信息会被暴露给客户端, 敏感细节要自行包装.

### after: 响应之后的副作用

`after()` 用于登记"响应发送之后执行、且不阻塞响应"的工作, 适合分析上报、审计日志、通知发送、缓存失效. 即使响应过程中抛错或调用了 `notFound`/`redirect`, 已登记的回调仍会执行.

`after` 回调中能否调用 `cookies()`/`headers()` 取决于所在位置: 在 Route Handler 与 Server Action 中可以直接调用; 在 Server Component (含 page、layout、`generateMetadata`) 中禁止, 会运行时报错, 因为 Next 需要在渲染期追踪哪些组件访问了请求数据. 服务端组件的正确写法是在渲染期读取, 再通过闭包传给回调.

## 图片与字体

### next/image

`<Image>` 在构建与运行期承担尺寸推断、格式协商、按需缩放与懒加载.

| 属性               | 作用                               | 注意                                                          |
| ------------------ | ---------------------------------- | ------------------------------------------------------------- |
| `width` / `height` | 固定尺寸, 用于预留空间避免布局偏移 | 尺寸未知时改用 `fill`                                         |
| `fill`             | 填满最近的定位父容器               | 父容器必须有定位与尺寸                                        |
| `sizes`            | 告诉浏览器不同断点下的展示宽度     | 使用 `fill` 或响应式布局时应提供, 否则默认按 100vw 下载过大图 |
| `preload`          | 预加载首屏关键图片并立即加载       | 优先级提示用 `fetchPriority` prop 配合                        |
| `quality`          | 输出质量                           | 服务端需允许该取值                                            |
| `unoptimized`      | 跳过优化, 直接输出原图             | 静态导出或无法运行图片服务时使用                              |

图片默认值: `minimumCacheTTL` 为 14400 秒 (4 小时), 默认 `qualities` 为 `[75]`, `imageSizes` 不含 16px, `maximumRedirects` 为 3, 并默认禁止优化内网地址. 自定义 `quality` 取值、内网图源与远程图源都需要在配置中显式允许.

### next/font

`next/font` 在构建期下载字体文件并随应用一起自托管, 浏览器不再向字体服务商发起请求. 它同时生成尺寸调整量 (size-adjust) 以减少字体替换引起的布局偏移, 并支持预加载与 `display` 策略配置.

```tsx
import { Inter } from "next/font/google";

const inter = Inter({ subsets: ["latin"], display: "swap" });

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={inter.className}>
      <body>{children}</body>
    </html>
  );
}
```

字体的加载策略要结合首屏内容判断: 用于首屏正文的字体应当预加载, 只用于特定组件的装饰字体不必占用首屏带宽.

## 静态导出与部署形态

### 静态导出

`output: "export"` 让 `next build` 输出纯静态站点 (默认目录 `out`). Server Component 在构建期渲染进静态 HTML 与 RSC Payload, 客户端导航与客户端组件照常工作, 因此可以部署到任意静态托管.

代价是失去一切需要 Node 服务端或请求时数据的特性. 明确不被支持的能力包括:

- 依赖请求的 Route Handler; 静态 GET Handler 需声明 `dynamic = "force-static"`.
- `cookies()`, `headers()`, `draftMode()`.
- Server Actions.
- ISR 与动态重验证.
- 默认 loader 的图片优化 (需配合 `unoptimized` 或自定义 loader).
- `proxy`, `rewrites`, `redirects`, `headers` 等请求期配置.
- `dynamicParams: true` 的动态路由, 以及没有 `generateStaticParams` 的动态路由.
- 拦截路由.

这类配置在开发阶段遇到不支持的用法会直接报错, 有助于尽早发现. 常见做法是配合 `basePath` 部署到子路径, 并用 `images.unoptimized` 关闭图片优化服务.

### 服务端部署形态

需要动态能力时, 有两种主要形态:

- 常规 Node 服务: `next build` 后用 `next start` 启动, 适合自托管与容器化.
- 独立产物: `output: "standalone"` 会基于静态分析只复制页面实际需要的文件到 `.next/standalone`, 包括剪裁后的 `node_modules`, 并生成一个最小 `server.js`. 适合精简容器镜像, 但 `public` 与 `.next/static` 需要按需复制或交给 CDN.

输出文件追踪在 monorepo 中要显式设置追踪根目录, 否则项目目录之外的文件不会被包含.

## Next 16 的基线要点

| 要点                  | 内容                                                               | 说明                                          |
| --------------------- | ------------------------------------------------------------------ | --------------------------------------------- |
| Turbopack 默认构建器  | `next dev` 与 `next build` 默认使用 Turbopack                      | 自定义 webpack 配置需显式传 `--webpack`       |
| 请求拦截用 `proxy.ts` | 文件约定为 `proxy.ts`, 导出名为 `proxy` 的函数 (或默认导出)        | 运行时为 Node.js, 不支持 edge runtime         |
| 请求期 API 全异步     | `params`/`searchParams`/`cookies`/`headers`/`draftMode` 只能 await | 同步访问不受支持, `next typegen` 提供类型支持 |
| Cache Components      | `cacheComponents: true` 引入 `'use cache'` 与 `cacheLife`          | 未缓存的异步读取需要 Suspense 包裹            |
| React Compiler        | 顶层 `reactCompiler` 选项, 依赖 `babel-plugin-react-compiler`      | 默认不开启, 开启后编译时间上升                |
| 图片默认值            | `minimumCacheTTL` 4 小时、`qualities: [75]`、禁止优化内网地址等    | 自定义 quality 与远程/内网图源需显式配置      |
| 运行时要求            | Node.js 20.9+, TypeScript 5.1+                                     | 本地与 CI 环境需满足                          |
| Lint 工具链           | 无内置 lint 命令, 直接使用 ESLint 或 Biome CLI                     | 插件默认使用扁平配置                          |
| 输出目录分离          | dev 输出到 `.next/dev`, 与 build 独立                              | 可并行执行 dev 与 build                       |

## 常见性能问题与处理

| 现象                   | 根因                                           | 处理                                              |
| ---------------------- | ---------------------------------------------- | ------------------------------------------------- |
| 首屏 TTFB 高           | 顺序 await 造成请求瀑布, 或首屏等待非关键数据  | 并行取数、把非关键片段放进 Suspense               |
| 客户端包过大           | 边界过早上移, 服务端逻辑被拉进客户端           | 把 `'use client'` 下推到最小交互单元              |
| 页面切换慢             | 目标路由数据未预取或缓存未命中                 | 依赖 `<Link>` 预取, 合理设置缓存生命周期          |
| 数据更新后仍显示旧内容 | 只更新了数据库, 没有失效对应缓存               | 按读一致性强弱选择 `updateTag` 或 `revalidateTag` |
| 全局样式闪烁           | 主题等偏好只在客户端读取                       | 用内联脚本在水合前设定, 并允许该节点水合差异      |
| 图片引起布局偏移       | 未提供尺寸或 `sizes`                           | 使用固定尺寸或 `fill` + `sizes`                   |
| 构建报未缓存读取错误   | 启用了 Cache Components 但存在未包裹的异步读取 | 加 `'use cache'` 或包进 Suspense                  |

## 适用场景与选型建议

适合用 App Router 的情形: 内容型站点需要 SEO 与快速首屏; 全栈应用希望在同一仓库内直连数据库、减少 API 层; 需要按段流式渲染与细粒度缓存; 团队已经接受 React Server Components 的边界约束.

不太适合的情形: 纯客户端后台面板, 数据全部来自既有后端 API 且不需要 SEO, 引入 App Router 反而增加概念负担; 无法运行 Node 服务端又依赖 ISR、Server Actions、动态路由等能力时, 只能退回静态导出并接受能力裁剪; 需要把渲染与数据层彻底解耦、由多语言服务分别承担时, 以独立 BFF 加纯前端框架的组合更直接.

几个具体取舍建议:

| 需求                       | 建议                                                         |
| -------------------------- | ------------------------------------------------------------ |
| 内容基本不变               | 静态生成, 需要时按路径重验证                                 |
| 分钟到小时级更新           | 缓存 + 定时重验证, 用标签做按需失效                          |
| 写后必须立即读到最新       | Server Action 内用 `updateTag`                               |
| 允许短暂陈旧以换取更快响应 | `revalidateTag(tag, "max")`                                  |
| 强交互且不需要 SEO 的模块  | 客户端组件 + 客户端数据获取库, 见 [TanStack Query](tanstack) |

最后一条经验值得强调: 缓存策略是产品语义问题, 不是纯技术问题. "数据可以旧多久"应当由业务决定, 再翻译成缓存档位与失效方式; 反过来从 API 出发去猜语义, 很容易做出用户看到过期价格或永远刷不新的页面这类问题.
