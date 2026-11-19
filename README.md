<div align="center">

# 26autumn

**A personal technical knowledge base — frontend, backend, and the Yukino family of projects.**

Built with [Rspress](https://rspress.rs/), deployed to GitHub Pages at
<https://yukino-js.github.io/26autumn/>.

![Rspress](https://img.shields.io/badge/Rspress-2-0095ff)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)
![pnpm](https://img.shields.io/badge/pnpm-workspace-F69220?logo=pnpm&logoColor=white)
![License: MIT](https://img.shields.io/badge/License-MIT-f5a623.svg)

</div>

---

## What is this?

`26autumn` is a static documentation site that collects technical notes written during
study, internships, and work. It covers four broad areas:

- **Frontend** (`content/fe`) — TanStack Query server-state caching, Priority Hints and
  the two meanings of SWR, plus four Yukino source analyses: `yukino-codegen`,
  `yukino-mcp`, `yukino-chatbot`, `yukino-chat`.
- **Backend** (`content/be`) — the ClickHouse/Kafka manual, backend middleware and
  infrastructure (etcd, groupcache, gRPC, Prometheus/Grafana, OpenTelemetry),
  `generic-pool` and WANProxy source analyses, and the Yukino Go series
  (`yukino_http`, `yukino_rpc`, `yukino_orm`, `yukino_cache`, `agent`, `agent_proxy`,
  infrastructure components, `task_flow`).
- **Work notes & research** (`content/docs`) — TikTok/IEG/data engineering retrospectives,
  Docker/Kubernetes and the JSError auto-fix sandbox, protocol research (A2UI, MCP Apps),
  coding-agent surveys (Claude Code, Pi), AI framework surveys (LangChain.js, LangGraph.js),
  and three source-analysis columns: `yukino` (the coding-agent CLI), `yukino-dev-agent`,
  and `yukino-ecomm-agent`.
- **Interview prep** (`content/interview`) — the HR-interview track: narrative and resume
  story, behavioural and stress question banks, JD matching, motivation and planning,
  Tencent culture and values, business outlook, real questions, process signals, and a
  practice workbook. Technical question banks are not maintained here.

Every document is grounded in project facts: source-code analysis is verified against the
actual repositories on disk, **not invented from memory**.

## Getting started

Prerequisites: **Node.js 22.12+** (Mermaid 12 requires it) and **pnpm** (`pnpm@12.10.1`).

```sh
pnpm install
pnpm dev       # dev server with HMR (http://localhost:3000/26autumn/)
```

| Command          | Description                                        |
| ---------------- | -------------------------------------------------- |
| `pnpm dev`       | Start the local dev server                         |
| `pnpm build`     | Statically build the site into `doc_build/`        |
| `pnpm preview`   | Preview the built site locally                     |
| `pnpm typecheck` | Type-check `rspress.config.ts` with `tsc --noEmit` |
| `pnpm lint`      | Lint and auto-fix with ESLint                      |
| `pnpm format`    | Format the repo with Prettier                      |
| `pnpm git:push`  | Stage, commit and push `main` to `origin`          |

## Repository layout

```
26autumn/
├── rspress.config.ts   # base, lang, llms, sitemap, mermaid, markdown
├── styles.css          # brand palette, typography, tables, callouts, diagrams
├── content/            # Markdown content, served from the site root
│   ├── index.md        # home page (pageType: home, hero + features)
│   ├── _nav.json       # top navbar items
│   ├── fe/             # frontend / full-stack / agent notes
│   ├── be/             # backend notes
│   ├── docs/           # work notes & open-source project research
│   ├── interview/      # interview prep (currently the HR-interview track)
│   └── public/         # favicon.ico, favicon.svg, robots.txt
├── install.js          # shallow-clone/pull 9 reference repos into $HOME/Downloads
└── doc_build/          # generated output (gitignored)
```

## Content conventions

- This site complements the `h` knowledge base (`~/github/h/docs`): fundamentals already
  covered there (CSS/JS, network, Go, MySQL/Redis, React/Next/Vite, Sentry) are not
  duplicated here. Only supplementary topics and source-analysis notes are kept.
- Frontend/full-stack/agent notes live under `content/fe`.
- Backend notes live under `content/be`.
- Work notes and open-source research live under `content/docs`.
- Interview prep lives under `content/interview`; the HR track is `content/interview/hr`,
  registered as a `dir` entry in `content/interview/_meta.json`.
- The top navbar comes from `content/_nav.json`; `themeConfig.nav` is intentionally
  unset so Rspress auto-generates nav and per-section sidebars.
- Each section has a `_meta.json` controlling sidebar order;
  `{"type": "section-header", "label": "..."}` inserts a group header.
- Section index pages (`fe/index.md`, `be/index.md`, `docs/index.md`,
  `interview/index.md`) set `overview: true` to render child pages as cards.
- **Provenance frontmatter** — source-analysis pages declare `local_path` and
  `local_commit`. `local_commit` is the HEAD of the repository that owns
  `local_path` (nested paths such as `apps/agent` resolve to their repository root).
- **Fact baseline** — each source-analysis page opens with a `:::note 事实基线`
  callout naming the checkout and commit. Every path, symbol, constant and API in
  the page must be locatable in that checkout.
- Documentation is kept in sync with the current code only. Removed modules,
  deprecated APIs and compatibility shims are deleted, not described as
  alternatives; **no backward-compatibility notes are retained**.

## Authoring features

- **Mermaid** — fenced ` ```mermaid ` blocks render as diagrams via
  `rspress-plugin-mermaid` (Mermaid 12, client-rendered after hydration);
  `flowchart`, `sequenceDiagram` and `stateDiagram-v2` are used throughout. The plugin
  is pinned to `layout: "dagre"` + `look: "classic"` in `rspress.config.ts` so existing
  diagrams keep their previous layout instead of Mermaid 12's new defaults.
- **Code groups** — all current pages are `.md`; JSX components are parsed only
  in `.mdx`. In `.md` files, code groups are expressed as **consecutive fenced
  code blocks with bold labels**. For `.mdx` pages, `Tab` / `Tabs` and
  `PackageManagerTabs` are exported from `@rspress/core/theme`:

  ````mdx
  import { Tab, Tabs } from "@rspress/core/theme";

  <Tabs>
    <Tab label="pnpm">

  ```bash
  pnpm add @rspress/core
  ```

    </Tab>
    <Tab label="npm">

  ```bash
  npm install @rspress/core
  ```

    </Tab>
  </Tabs>
  ````

- **Callouts** — `:::tip` / `:::note` / `:::warning` / `:::danger` / `:::details`
  containers, plus tables, **bold** key terms, _emphasis_ and code blocks with
  language tags.
- **Line numbers** — enabled globally via `markdown.showLineNumbers`.
- **LLM outputs** — `llms.txt`, `llms-full.txt` and a Markdown version of every
  page are generated at build time; copy / view-as-Markdown actions come from
  `themeConfig.llmsUI`.
- **Search** — built-in local full-text search, no extra configuration.
- **Sitemap & robots** — `sitemap.xml` is generated by Rspress' built-in `sitemap`
  config (`siteUrl` = `siteOrigin` + `base`); the legacy `@rspress/plugin-sitemap`
  dependency has been dropped. `robots.txt` is served from `content/public/`.
