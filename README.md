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
study, internships, and work. It covers three broad areas:

- **Frontend** (`content/fe`) — JavaScript/DOM/browser fundamentals, CSS, React,
  Next.js, Vite, TanStack, Priority Hints, plus the Yukino
  frontend family (coding-agent CLI and its internals, codegen, MCP server,
  agent, agent2, chatbot, chat, sentry).
- **Backend** (`content/be`) — Go, MySQL, Redis, ClickHouse, Kafka, backend
  middleware, a generic-pool source analysis, and the Yukino Go series
  (http, rpc, orm, cache, agent proxy, infrastructure components, AI apps).
- **Work notes & research** (`content/docs`) — TikTok/IEG/data engineering retrospectives,
  protocol research (A2UI, A2UI Express, MCP Apps, WebContainer), coding-agent surveys
  (CodeGraph, Claude Code, Codex, pi, OpenCodeReview), and AI framework/platform surveys
  (insforge, LangChain.js, LangGraph.js, OpenSpec, Superpowers).

Every document is grounded in project facts: source-code analysis is verified against the
actual repositories on disk, not invented from memory.

## Getting started

Prerequisites: **Node.js 20+** and **pnpm**.

```sh
pnpm install
pnpm dev       # start the dev server with HMR (http://localhost:3000/26autumn/)
```

| Command          | Description                                 |
| ---------------- | ------------------------------------------- |
| `pnpm dev`       | Start the local dev server                  |
| `pnpm build`     | Statically build the site into `doc_build/` |
| `pnpm preview`   | Preview the built site locally              |
| `pnpm typecheck` | Type-check theme and config                 |
| `pnpm lint`      | Lint and auto-fix with ESLint               |
| `pnpm format`    | Format the repo with Prettier               |

## Repository layout

```
26autumn/
├── rspress.config.ts   # site config: base, nav, llms, sitemap, mermaid, markdown
├── styles.css          # brand colors and font stacks (global styles)
├── content/            # Markdown content, served from the site root
│   ├── index.md        # home page (pageType: home, hero + features frontmatter)
│   ├── _meta.json      # root sidebar order
│   ├── fe/             # frontend / full-stack / agent notes
│   ├── be/             # backend notes
│   ├── docs/           # work notes & open-source project research
│   └── public/         # static assets (favicon, robots.txt)
└── install.js          # provisions the reference repositories under $HOME/Downloads
                        # (clone or pull, install deps, index with CodeGraph)
```

## Content conventions

- Frontend/full-stack/agent notes live under `content/fe`.
- Backend notes live under `content/be`.
- Work notes and open-source research live under `content/docs`.
- Each section has a `_meta.json` that controls the sidebar order;
  `{"type": "section-header", "label": "..."}` inserts a group header.
- Section index pages (`fe/index.md`, `be/index.md`, `docs/index.md`) set
  `overview: true` to render child pages as cards.
- Source-code analysis documents are always verified against the local workspace.

## Authoring features

- **Mermaid** — fenced ` ```mermaid ` blocks render as diagrams (dark-mode aware)
  via `rspress-plugin-mermaid`.
- **Code groups** — use the built-in `Tabs` / `Tab` components in `.mdx` files
  (JSX is only parsed in `.mdx`, not `.md`); `PackageManagerTabs` is available
  for package-manager command variants:

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

- **Callouts** — built-in `:::tip` / `:::note` / `:::warning` / `:::danger` /
  `:::details` containers and GitHub-style `[!NOTE]` alerts.
- **Line numbers** — enabled globally via `markdown.showLineNumbers`.
- **LLM outputs** — `llms.txt`, `llms-full.txt`, and a Markdown version of every
  page are generated at build time; each doc page exposes copy/view-as-markdown
  actions through `themeConfig.llmsUI`.
- **Search** — built-in local full-text search, no extra configuration.
- **Sitemap & robots** — `sitemap.xml` via `@rspress/plugin-sitemap`,
  `robots.txt` served from `content/public/`.
