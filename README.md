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

## Built-in resources

Everything weave ships — the `weave init` commands and agents, the built-in
skills/hooks/rules plugin packs, and the rule packs loaded into the engine —
lives in one marketplace-shaped directory:

```
packages/weave-templates/resources/weave-market/
├── .claude-plugin/marketplace.json   # the repo's own manifest
├── plugins/<scope>/<pack>/           # toolkit packages (skills, hooks, mods)
├── rules/<pack>/                     # rule packs loaded by the weave engine
└── init/{commands,agents}/           # what `weave init` copies in
```

On daemon start it is materialized at `<configDir>/weave/market/weave/` as a
**link to that directory** (a copy where links are unavailable), and it is the
single source for scanning, listing and installing:

- **to change what weave ships, edit that directory** — nothing is generated
  from code-side lists any more;
- a dev checkout links to `src/resources/…`, so content edits are live for the
  next scan/restart; `pnpm build` copies it to `dist/resources/…` for the
  published package;
- from the dashboard it can only be browsed and toggled: migrating, deleting and
  update-checking are refused — it is owned by weave and re-materialized on
  every daemon start.

External repos are separate: import them through the dashboard's resource market
(`<configDir>/weave/market/<id>/`), and their packages show up as their own
namespace block next to the built-in `weave` one.

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
