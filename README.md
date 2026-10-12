# weave

Coding-agent harness for Claude Code (and friends): inject skills, commands,
agents, hooks, and an MCP surface into any project, and watch what the agent
does from a local dashboard.

```bash
npm install -g @weavecode/cli
weave init          # scaffold a project
weave dashboard     # open the local dashboard
```

## What it does

- **`weave init`** — writes the harness files a project needs (`.claude/`
  helpers, hooks, settings, `.mcp.json`), merging into user files instead of
  overwriting them. Multi-harness: Claude Code and Codex.
- **`weave daemon`** — a local daemon (HTTP + SQLite) that ingests hook events,
  stores sessions, and serves the dashboard. Hooks never call it over HTTP:
  events append to `<configDir>/weave/hooks/inbox/` (a daemon worker thread
  claims and ingests them, then deletes the file), so collection and rule-driven
  injection keep working while the daemon is down. Upgrade note: a project's
  `.claude/helpers/hook-handler.cjs` is only refreshed by `weave init`, so
  re-run it in projects initialized before this change (older scripts post to a
  removed endpoint and would report nothing).
- **`weave dashboard`** — a web UI for projects, sessions, hooks, plugins, and
  installs. Served by the daemon itself.
- **`weave scan` / `weave status` / `weave statusline`** — project discovery,
  harness status, and a statusline preview.

## Commands

| Command | What it does |
| --- | --- |
| `weave init` | Scaffold harness files into a project |
| `weave scan` | Discover and register projects |
| `weave status` | Show harness status for a project |
| `weave daemon start\|stop\|status` | Manage the local daemon |
| `weave dashboard` | Open the dashboard in a browser |
| `weave statusline preview` | Preview the statusline |

## Packages

| Package | Role |
| --- | --- |
| [`@weavecode/cli`](https://www.npmjs.com/package/@weavecode/cli) | CLI entry point (`weave` command) |
| [`@weavecode/server`](https://www.npmjs.com/package/@weavecode/server) | Daemon: HTTP, SQLite, hook ingestion, dashboard host |
| [`@weavecode/harness`](https://www.npmjs.com/package/@weavecode/harness) | Harness drivers and the init pipeline |
| [`@weavecode/templates`](https://www.npmjs.com/package/@weavecode/templates) | Built-in skill, command, and agent templates |
| [`@weavecode/core`](https://www.npmjs.com/package/@weavecode/core) | Shared types and tables |

## Development

```bash
pnpm install
pnpm build        # tsc -b + template/preset copy
pnpm build:web    # dashboard bundle → packages/weave-server/web/dist
pnpm test
pnpm dev          # CLI from source
pnpm dev:server   # daemon from source
pnpm dev:web      # dashboard on :9527
```

Requires Node.js >= 22.5 (uses `node:sqlite`).

## Publishing

```bash
node scripts/release.mjs <version>   # bump, build, pnpm -r publish
```

Packages publish under the `@weavecode` scope to the public npm registry.
`workspace:` dependencies are rewritten by `pnpm publish` — do not use
`npm publish` directly.

## License

Apache-2.0. See [LICENSE](./LICENSE) and
[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
