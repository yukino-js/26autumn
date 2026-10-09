#!/usr/bin/env node
/**
 * Provision the reference repositories used for research in this workspace.
 *
 * Existing checkouts are refreshed with `git pull`; missing ones are cloned,
 * have their dependencies installed, and are indexed with CodeGraph.
 * Every repository is processed concurrently.
 *
 * Usage: node install.js [--dry-run]
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const TARGET_DIR = path.join(os.homedir(), "Downloads");
const REGISTRY = "https://registry.npmmirror.com";
const dryRun = process.argv.includes("--dry-run");

/**
 * @typedef {object} Repository
 * @property {string} name - directory name inside TARGET_DIR
 * @property {string} url - clone URL used when the directory is missing
 * @property {string[] | null} install - dependency install command, null when the project needs none
 */

/** @type {Repository[]} */
const repositories = [
  {
    name: "a2ui",
    url: "git@github.com:a2ui-project/a2ui.git",
    install: ["npm", "install", `--registry=${REGISTRY}`],
  },
  {
    name: "claude-code",
    url: "git@github.com:claude-code-best/claude-code.git",
    install: ["bun", "install"],
  },
  {
    name: "codegraph",
    url: "git@github.com:colbymchenry/codegraph.git",
    install: ["npm", "install", `--registry=${REGISTRY}`],
  },
  {
    name: "codex",
    url: "org-14957082@github.com:openai/codex.git",
    install: null,
  },
  {
    name: "insforge",
    url: "git@github.com:insforge/insforge.git",
    install: ["npm", "install", `--registry=${REGISTRY}`],
  },
  {
    name: "insforge-mcp",
    url: "git@github.com:insforge/insforge-mcp.git",
    install: ["npm", "install", `--registry=${REGISTRY}`],
  },
  {
    name: "langchainjs",
    url: "git@github.com:langchain-ai/langchainjs.git",
    install: ["pnpm", "install", `--registry=${REGISTRY}`],
  },
  {
    name: "langgraphjs",
    url: "git@github.com:langchain-ai/langgraphjs.git",
    install: ["pnpm", "install", `--registry=${REGISTRY}`],
  },
  {
    name: "openspec",
    url: "git@github.com:Fission-AI/openspec.git",
    install: ["pnpm", "install", `--registry=${REGISTRY}`],
  },
  {
    name: "superpowers",
    url: "git@github.com:obra/superpowers.git",
    install: ["pnpm", "install", `--registry=${REGISTRY}`],
  },
  {
    name: "pi",
    url: "git@github.com:earendil-works/pi.git",
    install: ["npm", "install", `--registry=${REGISTRY}`],
  },
  {
    name: "open-code-review",
    url: "git@github.com:alibaba/open-code-review.git",
    install: ["go", "mod", `tidy`],
  },
  {
    name: "formily",
    url: "git@github.com:alibaba/formily.git",
    install: ["yarn", "install", `--registry=${REGISTRY}`],
  },
  {
    name: "node-pool",
    url: "git@github.com:coopernurse/node-pool.git",
    install: ["npm", "install", `--registry=${REGISTRY}`],
  },
];

const nameWidth = Math.max(...repositories.map((repo) => repo.name.length));

/**
 * Prefix every line of a repository's output so concurrent runs stay readable.
 * @param {string} name
 * @returns {string}
 */
function tag(name) {
  return `[${name}]`.padEnd(nameWidth + 2);
}

/**
 * Run one command, streaming its output under the repository's tag.
 * @param {string} name - repository tag used as the log prefix
 * @param {string[]} argv - command followed by its arguments
 * @param {string} cwd
 * @returns {Promise<void>} rejects when the command cannot start or exits non-zero
 */
function run(name, argv, cwd) {
  const [command, ...args] = argv;
  const label = tag(name);
  console.log(`${label} $ ${argv.join(" ")}`);
  if (dryRun) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding("utf8");
      let rest = "";
      stream.on("data", (chunk) => {
        const lines = (rest + chunk).split("\n");
        rest = lines.pop() ?? "";
        for (const line of lines) {
          if (line.trim()) console.log(`${label} ${line}`);
        }
      });
      stream.on("end", () => {
        if (rest.trim()) console.log(`${label} ${rest}`);
      });
    }

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code}`));
    });
  });
}

/**
 * Refresh a repository index. `codegraph sync` fails on a directory that was
 * never indexed, so build the first index with `codegraph init` instead.
 * @param {string} name
 * @param {string} dir
 * @returns {Promise<void>}
 */
async function reindex(name, dir) {
  const command = existsSync(path.join(dir, ".codegraph")) ? "sync" : "init";
  await run(name, ["codegraph", command], dir);
}

/**
 * Pull an existing checkout, or clone, install and index a missing one.
 * @param {Repository} repo
 * @returns {Promise<void>}
 */
async function provision(repo) {
  const dir = path.join(TARGET_DIR, repo.name);

  if (existsSync(path.join(dir, ".git"))) {
    await run(repo.name, ["git", "pull"], dir);
    await reindex(repo.name, dir);
    return;
  }

  await run(repo.name, ["git", "clone", repo.url, repo.name], TARGET_DIR);
  if (repo.install) await run(repo.name, repo.install, dir);
  await run(repo.name, ["codegraph", "init"], dir);
  await run(repo.name, ["codegraph", "sync"], dir);
}

async function main() {
  console.log(
    `${dryRun ? "Dry run: provisioning" : "Provisioning"} ${repositories.length} repositories in ${TARGET_DIR}`,
  );

  const settled = await Promise.allSettled(repositories.map(provision));
  const failures = settled
    .map((result, index) => ({ result, repo: repositories[index] }))
    .filter(({ result }) => result.status === "rejected");

  if (failures.length === 0) {
    console.log(`${repositories.length} repositories ready`);
    return;
  }

  for (const { result, repo } of failures) {
    console.error(
      `${tag(repo.name)} failed: ${result.reason?.message ?? result.reason}`,
    );
  }
  console.error(
    `${failures.length} of ${repositories.length} repositories failed`,
  );
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
