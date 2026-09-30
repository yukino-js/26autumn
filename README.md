<div align="center">

# 26autumn

**A personal technical knowledge base — frontend, backend, and the Yukino family of projects.**

Built with [Next.js](https://nextjs.org/) and [Fumadocs](https://fumadocs.dev/),
deployed to GitHub Pages at <https://yukino-js.github.io/26autumn/>.

![Next.js](https://img.shields.io/badge/Next.js-16-000000?logo=next.js&logoColor=white)
![Fumadocs](https://img.shields.io/badge/Fumadocs-16-171717)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)
![pnpm](https://img.shields.io/badge/pnpm-workspace-F69220?logo=pnpm&logoColor=white)
![License: MIT](https://img.shields.io/badge/License-MIT-f5a623.svg)

</div>

---

## What is this?

`26autumn` is a static documentation site that collects technical notes written during
study, internships, and work. It covers three broad areas:

- **Frontend** (`content/fe`) — React, Next.js, CSS, Vite, TanStack Query, Formily,
  plus source-level walkthroughs of the Yukino frontend family
  (Coding Agent CLI & source, agent, agent2, chatbot, chat, sentry).
- **Backend** (`content/be`) — Go, MySQL, Redis, ClickHouse, Kafka, middleware,
  plus the Yukino Go series (http, rpc, cache, codegen).
- **Work notes & research** (`content/docs`) — TikTok/IEG/data engineering retrospectives,
  protocol research (A2UI, MCP Apps, WebContainer), and coding-agent / AI-framework
  surveys (CodeGraph, Claude Code, Codex, pi, OpenCodeReview, insforge, LangChain.js,
  LangGraph.js, OpenSpec).

Every document is grounded in project facts: source-code analysis is verified against the
actual repositories on disk, not invented from memory. Research docs cite the local clone
path and the HEAD commit they were written against.

## Getting started

Prerequisites: **Node.js 20+** and **pnpm**.

```sh
pnpm install
pnpm dev       # start the dev server with HMR (http://localhost:3000/26autumn)
```

| Command          | Description                            |
| ---------------- | -------------------------------------- |
| `pnpm dev`       | Start the local dev server             |
| `pnpm build`     | Statically export the site into `out/` |
| `pnpm typecheck` | Type-check the site                    |
| `pnpm lint`      | Lint and auto-fix with ESLint          |
| `pnpm format`    | Format the repo with Prettier          |

## Repository layout

```
26autumn/
├── app/           # routes: home, docs catch-all, search API,
│                  #         llms.txt / llms-full.txt / llms.mdx,
│                  #         sitemap, robots.txt
├── components/    # provider, search dialog, MDX components
├── content/       # Markdown content, served from the site root
│   ├── fe/        # frontend / full-stack / agent notes
│   ├── be/        # backend notes
│   └── docs/      # work notes & open-source project research
├── lib/           # source loader, shared config & layout options
├── public/        # static assets
├── .research/     # local read-only mirrors of the researched repositories
│                  # (git-ignored); REPO-FACTS.md records their HEAD commits,
│                  # remotes and mirror mapping, and is tracked
└── install.js     # provisions the research repositories under $HOME/Downloads
                   # (clone or pull, install deps, index with CodeGraph)
```

## Content conventions

- Frontend/full-stack/agent notes live under `content/fe`.
- Backend notes live under `content/be`.
- Work notes and open-source research live under `content/docs`.
- Each section has a `meta.json` that controls the sidebar order.
- Source-code analysis documents are always verified against the local workspace,
  and research docs record the clone path, HEAD commit, and snapshot date.
