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

- **Frontend fundamentals** — React, Next.js, CSS, Vite, JavaScript, and related topics.
- **Backend fundamentals** — Go, distributed systems, databases, and middleware.
- **Yukino deep dives** — source-level walkthroughs of the Yukino frontend
  (CLI, Agent, Chatbot, Sentry) and backend (YukinoCodegen, HTTP, RPC, Cache) stacks,
  verified line-by-line against local repositories.

Every document is grounded in project facts: source-code analysis is verified against the
actual repositories on disk, not invented from memory.

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
│                  #         llms.txt / llms.mdx, sitemap
├── components/    # provider, search dialog, MDX components
├── content/docs/  # Markdown content (fe / be / docs)
├── lib/           # source, shared config & layout options
├── public/        # static assets
└── packages/      # standalone packages shipped alongside the docs
    ├── swr-demo/  # SWR usage demo
    └── tags/      # video segmentation + vision-LLM tagger (Go)
```

> The `packages/` directory is a pnpm workspace. Subprojects are documented independently —
> see [`packages/tags`](./packages/tags) for the Go video-tagging CLI, for example.

## Content conventions

- Frontend/full-stack/agent notes live under `content/docs/fe`.
- Backend notes live under `content/docs/be`.
- Work notes live under `content/docs/docs`.
- Source-code analysis documents are always verified against the local workspace.
