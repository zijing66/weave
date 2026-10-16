# weave

Coding-agent harness for Claude Code (and friends): inject skills, commands,
agents, hooks, and an MCP surface into any project, and watch what the agent
does from a local dashboard.

[![npm](https://img.shields.io/npm/v/@weavecode/weave.svg)](https://www.npmjs.com/package/@weavecode/weave)
[![license](https://img.shields.io/npm/l/@weavecode/weave.svg)](./LICENSE)

```bash
npm install -g @weavecode/weave
weave init          # scaffold a project
weave dashboard     # start the daemon (if it is not running) and open the UI
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
- **`weave scan` / `weave status`** — project discovery and harness status.

## Dashboard

- **Sessions** — every project's sessions, with live status (running /
  compacting / interrupted) and a per-turn event chain.
- **Blocking questions** — AskUserQuestion, plan approvals and permission
  prompts are surfaced in the browser and answered by injecting the option
  keystrokes into that session's pane; a new prompt raises a toast, a system
  notification and a Web Push message.
- **Messaging** — send a prompt to any session from the dashboard (a session's
  own inbox socket first, then terminal text injection, then the native peer
  relay), read the conversation next to the session, and interrupt a running
  turn with one ESC.
- **Watch subscriptions** — subscribe to a session's idle / turn-end /
  message-failed transitions and get notified in-page, as a system
  notification, and by Web Push once the page is closed.
- **Resource market** — import a marketplace and install its
  skills/commands/agents/hooks/plugins into a project or globally, then toggle
  them; the packages weave ships are one such market.
- **LAN access** — an optional HTTPS listener with a self-signed certificate,
  so a phone on the same network can open the dashboard (and receive push
  notifications); dashboard login is password-protected (`weave chpass`).

## Built-in resources

Everything weave ships — the `weave init` commands and agents, the built-in
skills/hooks/rules plugin packs, and the rule packs loaded into the engine —
lives in one marketplace-shaped directory:

```
packages/weave-templates/src/resources/weave-market/
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
| `weave doctor` | Diagnose local wiring (registration, token, daemon) |
| `weave daemon start\|stop\|status` | Manage the local daemon |
| `weave dashboard` | Open the dashboard in a browser (starting the daemon if needed) |
| `weave chpass <new password>` | Change the dashboard login password (locally, no old password needed) |
| `weave uninstall` | Remove weave's init outputs from a project (rolls back the init commit when it is HEAD, otherwise commits the removal) |

## Packages

One artifact is published — [`@weavecode/weave`](https://www.npmjs.com/package/@weavecode/weave),
a self-contained bundle: the compiled CLI, daemon, dashboard and built-in
resources, with every runtime dependency packed inside the tarball, so a global
install needs nothing else from the registry. The repo's layers below are
`private` and are never published on their own.

| Package | Role |
| --- | --- |
| `packages/weave` (`@weavecode/weave`) | The published bundle: CLI + daemon + dashboard + resources |
| `packages/weave-cli` (`@weavecode/cli`) | CLI entry point (`weave` command) |
| `packages/weave-server` (`@weavecode/server`) | Daemon: HTTP, SQLite, hook ingestion, dashboard host |
| `packages/weave-harness` (`@weavecode/harness`) | Harness drivers and the init pipeline |
| `packages/weave-templates` (`@weavecode/templates`) | Built-in market (skills, commands, agents, rules) |
| `packages/weave-core` (`@weavecode/core`) | Shared types and tables |

## Requirements

- **Node.js >= 22.5** (the daemon stores data with `node:sqlite`).
- **Claude Code** and/or **Codex** installed and on `PATH` — weave drives them,
  it does not bundle them.
- Optional: a terminal backend weave can address panes in (**wezterm** today).
  Session interrupt and remote answering work by writing keystrokes into the
  session's pane, so they need one.

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
node scripts/release.mjs <version>   # bump every package, build, publish components with pnpm, then publish the umbrella tgz
```

Packages publish under the `@weavecode` scope to the public npm registry.
`workspace:` dependencies are rewritten by `pnpm publish` — do not use
`npm publish` directly.

## License

Apache-2.0. See [LICENSE](./LICENSE) and
[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
