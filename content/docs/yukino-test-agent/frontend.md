---
title: "前端架构"
description: "React 19 + TanStack Start 前端全景: 文件式路由、应用外壳、项目详情九 Tab、组件分层、tRPC + TanStack Query 数据流、主题系统与共享 lib/hooks。"
---

# 前端架构

前端是一个跑在 **TanStack Start** (SSR 元框架) 上的 **React 19** 应用: 文件式路由 + tRPC 类型安全数据层 + Tailwind v4 + shadcn/ui。全英文界面, shadcn `new-york` 风格 (zinc 基色), 底层原语用 **Base UI** (`@base-ui/react`), 图标统一 lucide-react, toast 提示用 sonner。

技术栈速览 (`package.json`):

| 维度   | 选型                                                                   |
| ------ | ---------------------------------------------------------------------- |
| 视图   | React 19 (`react` / `react-dom`), React Compiler (babel preset 开启)   |
| 元框架 | TanStack Start (`@tanstack/react-start`) + Vite 8 + Nitro              |
| 路由   | TanStack Router (文件式, `tsr generate`), `defaultPreload: "intent"`   |
| 数据   | TanStack Query + tRPC v11 (`@trpc/tanstack-react-query`), superjson    |
| 样式   | Tailwind CSS v4 (`@tailwindcss/vite`) + tw-animate-css, oklch 主题变量 |
| 组件库 | shadcn/ui (new-york / zinc), 原语来自 `@base-ui/react`                 |
| 校验   | zod v4 (与后端共用同一套 router 入参 schema)                           |

源码根在 `src/`, 通过 Node 子路径别名映射: `package.json` 的 `"imports": { "#/*": "./src/*" }` 让所有模块用 `#/components/...`、`#/lib/...`、`#/server/...` 引用, 避免相对路径地狱。

## 路由: 文件式生成 (routeTree)

路由树不手写, 由 `tsr generate` 从 `src/routes/` 目录结构生成到 `src/routeTree.gen.ts` (文件头自述 "**You should NOT make any changes in this file**")。**勿手改**; 新增/改名路由文件后运行 `pnpm generate-routes` (即 `tsr generate`, `tsr.config.json` 仅 `{ "target": "react" }`)。

路由实例在 `src/router.tsx` 的 `getRouter()` 里创建: `createTanStackRouter({ routeTree, context, scrollRestoration: true, defaultPreload: "intent", defaultPreloadStaleTime: 0 })`, 并用 `Wrap` 注入 `TanstackQueryProvider`, 再调 `setupRouterSsrQueryIntegration` 让 SSR 阶段的查询数据能随 HTML 脱水/补水。`defaultPreload: "intent"` 表示鼠标悬停即预加载目标路由数据。

| 路由                                 | 文件                                    | 用途                                                     |
| ------------------------------------ | --------------------------------------- | -------------------------------------------------------- |
| `/`                                  | `index.tsx`                             | `beforeLoad` 抛 `redirect` 到 `/dashboard`               |
| `/dashboard`                         | `dashboard.tsx`                         | 平台级统计与近期活动 (`stats.overview`)                  |
| `/projects`                          | `projects/index.tsx`                    | 项目列表, 关键字过滤, 增删改 (`ProjectDialog`)           |
| `/projects/$projectId`               | `projects/$projectId.tsx`               | 项目详情, 9 个 Tab (搜索参数 `?tab=`)                    |
| `/projects/$projectId/cases/$caseId` | `projects/$projectId/cases/$caseId.tsx` | 用例详情: 结构化步骤、执行历史、版本回滚、编辑/运行/删除 |
| `/testcases`                         | `testcases.tsx`                         | 项目维度的用例浏览器 (`ProjectPicker` + `?pid=`)         |
| `/pipeline`                          | `pipeline/index.tsx`                    | 某项目的流水线运行列表 + 新建运行 + Quick start          |
| `/pipeline/$runId`                   | `pipeline/$runId.tsx`                   | 运行详情: 阶段时间线 + 逐用例评审 (运行中 2s 轮询)       |
| `/executions`                        | `executions/index.tsx`                  | 项目维度的执行列表 (`ProjectPicker` + `?pid=`)           |
| `/executions/$executionId`           | `executions/$executionId.tsx`           | 执行详情: 步骤、截图、录像、AI 复核、人工裁定            |
| `/settings`                          | `settings.tsx`                          | LLM 档案 (text/vision) 与环境信息                        |
| `/api/trpc/$`                        | `api.trpc.$.tsx`                        | tRPC HTTP 处理器 (GET + POST)                            |
| `/api/files/$`                       | `api.files.$.tsx`                       | 证据文件服务 (含路径穿越防护)                            |
| `/api/report/$`                      | `api.report.$.tsx`                      | HTML 报告服务 (project / execution 两种)                 |

三个 `/api/*` 路由用 TanStack Start 的 `server.handlers` 写纯服务端处理器 (不走 React 组件):

- `api.trpc.$`: `fetchRequestHandler({ req, router: trpcRouter, endpoint: "/api/trpc" })`, 处理前先 `ensureRecovered()` (进程重启后把残留的 `running`/`pending` 后台任务标记为 failed, 避免 UI 出现幽灵运行态, 见[架构总览](architecture));
- `api.files.$`: 把请求路径解析为 `OUTPUT_DIR` 内的证据文件并回传, `resolveOutputPath` 拒绝任何逃逸出 `OUTPUT_DIR` 的路径, 命中则带 `Cache-Control: public, max-age=3600` 与按扩展名映射的 `Content-Type` (`contentTypeFor`: png/jpg/webp/gif/webm/mp4/html/md/json);
- `api.report.$`: 按 `/{kind}/{id}` 分发——`project` 走 `buildProjectReport` (可带 `?requirementId=` / `?workflowRunId=`), `execution` 走 `buildExecutionReport`, 其余 404。

## 应用外壳 (`__root.tsx`)

根路由 `createRootRouteWithContext<MyRouterContext>()` 同时声明 `shellComponent: RootDocument` 与 `component: RootLayout`:

- **`RootDocument`** (文档壳): `<html lang="en" suppressHydrationWarning>`, `<head>` 里先内联 `THEME_INIT_SCRIPT` 再 `<HeadContent/>`, `<body>` 末尾放 TanStack Devtools (右下角, 挂 Router 面板与 Query 面板) 与 `<Scripts/>`;
- **`RootLayout`** (布局): `SidebarProvider` 包裹 `AppSidebar` + `SidebarInset`; `SidebarInset` 内是 sticky 顶栏 (`SidebarTrigger` + "Yukino Test Agent" 标题) 与主内容区 `<Outlet/>`; 最外层挂全局 `<Toaster richColors position="top-right"/>`;
- **`NotFound`**: 404 页, 提供 "Back to dashboard" 与 "Go back" (调 `router.history.back()`) 两个出口。

侧边栏 (`components/AppSidebar.tsx`) 是 `<Sidebar collapsible="icon" variant="inset">`——可折叠成只剩图标条的 inset 样式。结构: `SidebarHeader` 放 logo + 名称 (Sparkles 渐变徽标 + "Yukino Test Agent / AI Test Platform"), `SidebarContent` 放导航组 "Workspace", `SidebarFooter` 放 "Theme" + `ThemeToggle`, 末尾 `SidebarRail`。

导航项由 `NAV` 数组驱动, 每项带 `to` / `label` / `icon` / `match`:

| to            | label      | icon            | match  |
| ------------- | ---------- | --------------- | ------ |
| `/dashboard`  | Dashboard  | LayoutDashboard | prefix |
| `/projects`   | Projects   | FolderKanban    | prefix |
| `/testcases`  | Test Cases | ListChecks      | prefix |
| `/pipeline`   | Pipeline   | Workflow        | prefix |
| `/executions` | Executions | PlayCircle      | prefix |
| `/settings`   | Settings   | Settings        | exact  |

`isActive` 按 `match` 高亮: `exact` 只在路径完全相等时亮; `prefix` 在路径相等或以 `${to}/` 开头时亮, 让嵌套路由 (如 `/projects/abc`) 仍点亮父项。

## 项目详情的 Tab 架构 (`/projects/$projectId`)

`$projectId.tsx` 用搜索参数 `?tab=` 驱动 9 个 Tab。`validateSearch` 把不在 `TABS` 白名单里的值回退到 `overview`; 切换时 `navigate({ search: { tab: value }, replace: true })` (用 `replace` 避免每次切 Tab 都堆历史条目)。加载时渲染 Skeleton, 项目不存在时给 "Project not found" 空态。

| Tab            | 组件              | 内容                                                                      |
| -------------- | ----------------- | ------------------------------------------------------------------------- |
| `overview`     | `OverviewTab`     | 项目信息卡 (git/本地路径、目标 URL、PRD 状态、技术栈徽标) + PRD 编辑/上传 |
| `analysis`     | `AnalysisTab`     | 触发静态分析、查看后端/前端事实与状态机 (`useJobPoller` 进度)             |
| `requirements` | `RequirementsTab` | 需求版本 CRUD、需求级 PRD 上传、测试点抽取 (触发 `requirements.analyze`)  |
| `incremental`  | `IncrementalTab`  | 增量需求分析: 基线快照、变更 diff、人工确认变更/回归、增量生成            |
| `generation`   | `GenerationTab`   | 选模式/需求/档案生成用例、覆盖缺口、历史版本                              |
| `cases`        | `CasesPanel`      | 用例列表、过滤、批量执行、导入导出、复制、删除                            |
| `mindmap`      | `MindmapTab`      | 用例脑图 (四级树 + Markdown / XMind 导出, `server/lib/mindmap.ts`)        |
| `executions`   | `ExecutionsPanel` | 执行列表 (分组/过滤/分页) + 批量 AI 复核 + 重跑                           |
| `coverage`     | `CoverageTab`     | 覆盖率矩阵 (计划 vs 实际, `server/lib/coverage.ts`)                       |

注意 `mindmap` 与 `executions` 的 `TabsContent` 顺序与 `TabsTrigger` 声明略有交错, 但 `value` 一一对应, 不影响行为。

## 组件分层

- **`components/ui/`** — shadcn/ui 基础组件, **27 个**: `alert` `alert-dialog` `badge` `breadcrumb` `button` `card` `checkbox` `collapsible` `dialog` `dropdown-menu` `input` `label` `popover` `progress` `scroll-area` `select` `separator` `sheet` `sidebar` `skeleton` `slider` `sonner` `switch` `table` `tabs` `textarea` `tooltip`。全部基于 `@base-ui/react` 原语 (如 `dialog.tsx` 引 `@base-ui/react/dialog`, `button.tsx` 引 `@base-ui/react/button`), 按 `components.json` 的 new-york / zinc 约定生成, 用 shadcn CLI 添加;
- **`components/`** — 应用级共享组件, **8 个**: `AppSidebar` (导航外壳)、`PageHeader` (标题/描述/右对齐 actions)、`StatusBadge` (tone→语义色徽章, 支持 `dot`/`pulse`)、`EmptyState` (虚线空态面板)、`ProjectPicker` (项目下拉, 内部查 `projects.list`)、`ProjectDialog` (项目创建/编辑表单)、`QuickStartDialog` (一键创建项目+需求+PRD)、`ThemeToggle` (明/暗/跟随系统);
- **`components/project/`** — 项目功能面板, **10 个文件**: 8 个 Tab 组件 (`OverviewTab`/`AnalysisTab`/`RequirementsTab`/`IncrementalTab`/`GenerationTab`/`CasesPanel`/`MindmapTab`/`CoverageTab`; 第 9 个 executions Tab 复用 `components/executions/` 下的 `ExecutionsPanel`), 外加 `CaseEditDialog` (手工创建/编辑用例与结构化步骤)、`CaseReviewDialog` (AI 评审结果: pass/suspect/fail/unavailable + 问题清单);
- **`components/executions/`** — 执行面板 **2 个**: `ExecutionsPanel` (列表+批量复核+重跑)、`ScreenshotViewer` (截图展示 + 归一化 bbox 高亮框)。

`Button` 支持 Base UI 的 `render` 属性渲染成路由链接 (`render={<Link to=... />}` + `nativeButton={false}`), 全站的 "链接伪装成按钮" 都用这个模式。

## 数据请求模式 (tRPC + TanStack Query)

tRPC 客户端在 `integrations/tanstack-query/root-provider.tsx` 用 `createTRPCClient` + `httpBatchStreamLink({ transformer: superjson, url })` 建立, 指向相对路径 `/api/trpc` (服务端渲染时回退 `http://localhost:${PORT ?? 3000}/api/trpc`)。`getContext()` 新建一个 `QueryClient` (其 `dehydrate`/`hydrate` 默认用 superjson 序列化) 并经 `createTRPCOptionsProxy` 连同 tRPC client 一起放进路由 context; `router.tsx` 的 `Wrap` 用它渲染 `TanstackQueryProvider`。`useTRPC()` 由 `integrations/trpc/react.ts` 的 `createTRPCContext<TRPCRouter>()` 导出。

入参 schema 与后端同源——前端调用 `trpc.xxx.method` 时 TypeScript 直接推导出完整入参/返回类型, 编译期即可发现字段拼写错误。典型用法:

```tsx
const trpc = useTRPC();
const queryClient = useQueryClient();

// 查询: queryOptions 产出与 useQuery 兼容的 options
const { data, isLoading } = useQuery(
  trpc.projects.get.queryOptions({ pid: projectId }),
);

// 变更: mutationOptions 里挂成功/失败回调, 成功后按 queryKey 失效相关查询
const mutation = useMutation(
  trpc.projects.delete.mutationOptions({
    onSuccess: async () => {
      toast.success("Project deleted");
      await queryClient.invalidateQueries({
        queryKey: trpc.projects.list.queryKey(),
      });
    },
    onError: (error) => toast.error(error.message),
  }),
);

// 异步任务: 变更返回 jobId → useJobPoller 轮询 → finishedRef 保证副作用只跑一次
const [jobId, setJobId] = useState<string | null>(null);
const job = useJobPoller(jobId);
const finishedRef = useRef<string | null>(null);

const startMutation = useMutation(
  trpc.generation.start.mutationOptions({
    onSuccess: (result) => setJobId(result.jobId),
  }),
);

useEffect(() => {
  if (job.isTerminal && jobId && finishedRef.current !== jobId) {
    finishedRef.current = jobId;
    if (job.isFailed) toast.error(job.error ?? "Generation failed");
    else toast.success("Case generation complete");
    invalidate(); // 批量失效相关查询
    setJobId(null);
  }
}, [job.isTerminal, job.isFailed, job.error, jobId]);
```

约定与细节:

- **异步任务统一走 jobId 轮询**: 长耗时操作 (生成、分析、批量执行、批量复核、重跑) 的 mutation 立即返回 `jobId`, 前端用 `useJobPoller` 跟踪; 完成副作用 (toast + 失效查询) 统一放在 `useEffect` 里并用 `finishedRef` 按 jobId 去重, 防止重复触发;
- **文件上传走 base64**: 前端 `FileReader.readAsDataURL` 读成 data URL, 截掉 `data:...;base64,` 前缀后把 `{ filename, base64 }` 作为 tRPC 入参, 服务端 `Buffer.from(base64, "base64")` 还原。PRD 上传接受 `.md` / `.markdown` / `.txt` / `.pdf` / `.docx` (`lib/prd.ts` 的 `ALLOWED_PRD_EXTS`, 上限 20 MB); 服务端 `parsePrdText` 对 `.md/.markdown/.txt` 按 UTF-8、`.pdf` 用 `unpdf`、`.docx` 用 `mammoth` 抽文本, 客户端 `validatePrdFile` 先行拦截以提前报错;
- **格式化与状态展示全局复用**: 日期/时长/百分比/相对时间用 `lib/format.ts`, 枚举码→文案/色调用 `lib/enums.ts` 的 `meta()` + `StatusBadge` (见下)。

## 主题系统 (明 / 暗 / 跟随系统)

自研实现 (不依赖 next-themes), 在 `<html>` 上切换 `.dark` / `.light` 类:

- **`ThemeToggle`** 持有模式状态 (`light` / `dark` / `auto`), 持久化到 `localStorage.theme`; `applyThemeMode` 解析 `auto` 为 `prefers-color-scheme` 的真实偏好, 设置 `.dark`/`.light` 类、`data-theme` 属性 (`auto` 时移除) 与 `style.colorScheme`; `auto` 模式下还监听 `matchMedia` 变化实时跟随系统;
- **`THEME_INIT_SCRIPT`** (`__root.tsx` 内联): 在首屏任何绘制前读取 `localStorage.theme` 与 `prefers-color-scheme`, 同步算出解析主题并打好类名与 `colorScheme`, **避免主题闪烁 (FOUC)**; 无效/缺省值回退 `auto`;
- **Tailwind v4 dark 变体**: `styles.css` 用 `@custom-variant dark (&:is(.dark *))` 让 `dark:` 前缀跟随 `.dark` 类; 主题变量 (oklch 色) 在 `:root` (亮) 与 `.dark` (暗) 双份定义, 并额外定义语义色 `--success` / `--warning` / `--info` 及一整套 `--sidebar-*`;
- **`useResolvedTheme`** (`hooks/use-theme.ts`): 通过 `MutationObserver` 观察 `<html>` 的 class 变化, 实时返回当前 `light`/`dark`; 供 `ui/sonner.tsx` 的 Toaster 包装组件同步 toast 主题;
- 字体在 `@theme inline` 里声明 sans 用 Inter、mono 用 JetBrains Mono。

## 共享 lib

- **`lib/enums.ts`** — 展示层枚举元数据的单一事实源。`EnumMeta = { label, tone, description }`, `tone` 取值 `info` / `primary` / `success` / `danger` / `warning`。导出各域映射: `CASE_EXECUTION_STATUS_META`、`EXECUTION_RECORD_STATUS_META`、`AI_REVIEW_VERDICT_META`、`ERROR_CATEGORY_META`、`FAILURE_CATEGORY_META`、`CASE_TYPE_META`、`CASE_SOURCE_META`、`REQUIREMENT_STATUS_META`、`ANALYSIS_STATUS_META`、`WORKFLOW_STATUS_META`、`STAGE_STATUS_META`、`REVIEW_STATUS_META`、`PRIORITY_META`, 外加 `STAGE_LABELS` (阶段名→英文标签)。`meta(mapping, code)` 返回带兜底的 `EnumMeta & { code }` (未知码回退 `label=code ?? "Uncategorized"`、`tone="info"`), 数据库存稳定英文码、UI 只渲染这里的文案;
- **`lib/format.ts`** — 无依赖格式化工具: `formatDate`、`formatDateShort`、`formatDuration` (ms/s/m/h 逐级)、`formatPercent`、`formatNumber`、`truncateText`、`timeAgo` (相对时间 "5m ago");
- **`lib/types.ts`** — 与后端契约对齐的前端域类型: `StructuredStep` (`ui_action` / `input` / `state_assert` / `capture` 四类步骤 + `UiSelector`)、`Endpoint`/`Entity`/`StateMachineSpec` 等分析事实、`TestPoint`/`GeneratedCase`、`RunnerResult`/`ExecutionStepRecord`、`LlmProfileDict`、`JobState` (`pending`/`running`/`completed`/`failed` + `current`/`total` 进度) 等;
- **`lib/utils.ts`** — `cn(...inputs)`, 用 `clsx` + `tailwind-merge` 合并 className, 是全站样式合并的唯一入口 (shadcn 组件内部另引 `cn` 包);
- **`lib/prd.ts`** — PRD 上传前置校验: `ALLOWED_PRD_EXTS`、`MAX_PRD_MB` (20)、`PRD_ACCEPT` (file input 的 `accept`)、`validatePrdFile` (扩展名 + 大小), 与后端 `parsePrdText` 守卫保持一致。

## hooks

- **`use-job-poller.ts`** — `useJobPoller(jobId, intervalMs = 1200)`: 用 `trpc.jobs.get` 轮询后台任务, `refetchInterval` 在任务到达终态 (`completed` / `failed`) 时自动返回 `false` 停轮询; 返回 `{ job, isRunning, isTerminal, isCompleted, isFailed, progress, isLoading, error, message }`, `progress` 为 `current / total`。同文件还导出 `useJobCompletion(jobId, onDone)`, 在到达终态时恰好触发一次回调;
- **`use-theme.ts`** — `useResolvedTheme()`: 见主题系统一节, 供 Toaster 等组件感知当前明暗;
- **`use-mobile.ts`** — `useIsMobile()`: 以 `MOBILE_BREAKPOINT = 768` 判断移动端并监听 `matchMedia` 变化, 供侧边栏等做自适应。

## 相关页面

- [架构总览](architecture) — 分层视图、任务模型与崩溃恢复 (`ensureRecovered`)
- [数据模型](data-model) — 前端读取的 26 张表与主键约定
- [浏览器执行](execution) — `ScreenshotViewer` / 录像等证据的产生侧
- [API 与配置参考](api) — tRPC 过程清单与环境变量
