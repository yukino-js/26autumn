---
title: "前端架构"
---

# 前端架构

React 19 + TanStack Router/Query + Tailwind v4 + shadcn/ui, 全英文界面, shadcn new-york 风格 (zinc 基色)。

## 文件式路由 (routes/)

路由树由 `tsr generate` 生成到 `src/routeTree.gen.ts` (**勿手改**; 新增/改名路由后运行 `pnpm generate-routes`)。

| 路由                                 | 用途                                           |
| ------------------------------------ | ---------------------------------------------- |
| `/` (index.tsx)                      | 重定向到 `/dashboard` (307)                    |
| `/dashboard`                         | 平台级统计与近期活动 (`stats.overview`)        |
| `/projects`                          | 项目列表, 增删改 (`ProjectDialog`)             |
| `/projects/$projectId`               | 项目详情, 7 个 Tab (搜索参数 `?tab=`)          |
| `/projects/$projectId/cases/$caseId` | 用例详情: 结构化步骤、历史、版本回滚           |
| `/testcases`                         | 项目维度的用例浏览器 (`ProjectPicker` + `pid`) |
| `/pipeline`                          | 某项目的流水线运行列表 + 新建运行              |
| `/pipeline/$runId`                   | 运行详情: 阶段时间线 + 逐用例评审              |
| `/executions`                        | 项目维度的执行列表                             |
| `/executions/$executionId`           | 执行详情: 步骤、截图、录像、AI 复核、人工裁定  |
| `/settings`                          | LLM 档案 (文本/视觉) 与环境信息                |
| `/api/trpc/$`                        | tRPC HTTP 处理器                               |
| `/api/files/$`                       | 证据文件服务 (含路径穿越防护)                  |
| `/api/report/$`                      | HTML 报告服务                                  |

## 应用外壳 (__root.tsx)

- `RootDocument`: `<html lang="en">` + 主题内联脚本 + `<HeadContent/>` + Devtools + `<Scripts/>`;
- `RootLayout`: `SidebarProvider` 包裹 `AppSidebar` (可折叠 inset 侧边栏) + `SidebarInset` (顶部 sticky header + 主内容区) + 全局 `<Toaster richColors/>`;
- 侧边栏导航项 (`AppSidebar.tsx`): Dashboard、Projects、Test Cases、Pipeline、Executions、Settings, lucide 图标, 支持 `prefix`/`exact` 高亮匹配。

## 项目详情的 Tab 架构

`/projects/$projectId` 用搜索参数 `?tab=` 驱动 7 个 Tab; `validateSearch` 校验非法值并回退 `overview`; 切换用 `navigate({ search: { tab }, replace: true })`。

| Tab          | 组件              | 内容                                                   |
| ------------ | ----------------- | ------------------------------------------------------ |
| overview     | `OverviewTab`     | 项目信息、PRD 编辑/上传                                |
| analysis     | `AnalysisTab`     | 触发代码分析、查看后端/前端事实与状态机                |
| requirements | `RequirementsTab` | 需求版本、PRD、测试点抽取                              |
| generation   | `GenerationTab`   | 选择模式/需求/档案生成用例、覆盖缺口                   |
| cases        | `CasesPanel`      | 用例列表、批量执行、导入导出、删除                     |
| mindmap      | `MindmapTab`      | 用例脑图 (树 + Markdown 导出, `server/lib/mindmap.ts`) |
| coverage     | `CoverageTab`     | 覆盖率矩阵 (计划 vs 实际)                              |

## 组件分层

- `components/ui/`: shadcn/ui 基础组件 22 个 (alert/alert-dialog/badge/breadcrumb/button/card/checkbox/collapsible/dialog/dropdown-menu/input/label/popover/progress/scroll-area/select/separator/sheet/sidebar/skeleton/slider/sonner/switch/table/tabs/textarea/tooltip), 由 `pnpm dlx shadcn@latest add <name>` 添加;
- `components/`: 应用级共享组件——`AppSidebar`、`PageHeader`、`StatusBadge` (tone→语义色)、`EmptyState`、`ProjectPicker`、`ProjectDialog`、`ThemeToggle`;
- `components/project/`、`components/executions/`: 功能面板 (7 个 Tab + `ExecutionsPanel`/`ScreenshotViewer`)。

## 数据请求模式 (tRPC + TanStack Query)

```tsx
const trpc = useTRPC();

// 查询
const { data, isLoading } = useQuery(trpc.projects.get.queryOptions({ pid }));

// 变更 (带成功/失败提示与查询失效)
const mutation = useMutation(
  trpc.projects.create.mutationOptions({
    onSuccess: () => {
      toast.success("Project created");
      queryClient.invalidateQueries({
        queryKey: trpc.projects.list.queryKey(),
      });
    },
    onError: (error) => toast.error(error.message),
  }),
);

// 异步任务: 变更返回 jobId → 轮询
const startMutation = useMutation(
  trpc.generation.start.mutationOptions({
    onSuccess: (result) => setJobId(result.jobId),
  }),
);
const job = useJobPoller(jobId);
```

- **文件上传走 base64**: 前端 `FileReader` 读为 base64, tRPC 入参传 `{ filename, base64 }`, 服务端 `Buffer.from(base64, 'base64')` 还原 (PRD 上传仅接受 `.md`/`.txt`);
- 格式化 (`lib/format.ts`) 与状态展示 (`lib/enums.ts` 的 `meta` + `StatusBadge`) 全局复用;
- 任务完成副作用统一放在 `useEffect` 中并用 `finishedRef` 去重 (见[架构总览](/base/yukino-agent-test/architecture))。

## 主题系统 (明/暗)

- 自定义实现: 在 `<html>` 上切换 `.dark`/`.light` 类, 选择 (`light`/`dark`/`auto`) 持久化到 `localStorage`;
- `__root.tsx` 内联 `THEME_INIT_SCRIPT`: 首屏绘制前读取 localStorage 与 `prefers-color-scheme` 并设置类名与 `colorScheme`, **避免主题闪烁 (FOUC)**; auto 模式下解析为系统偏好;
- `hooks/use-theme.ts` 提供切换逻辑, `ThemeToggle` 提供 UI;
- shadcn 主题变量定义在 `src/styles.css`。

## hooks

- `use-job-poller.ts`: `useJobPoller` (1200ms 轮询, 终态自动停) 与 `useJobCompletion` (终态恰好触发一次);
- `use-theme.ts`: 主题模式读取/切换;
- `use-mobile.ts`: 移动端断点 (侧边栏自适应)。
