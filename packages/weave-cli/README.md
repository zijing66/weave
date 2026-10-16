# @weavecode/cli

CLI entry point for [weave](https://github.com/zijing66/weave) — a
coding-agent harness for Claude Code (and friends). Provides the `weave`
command: project init, daemon management, and the local dashboard.

Installed as part of
[`@weavecode/weave`](https://www.npmjs.com/package/@weavecode/weave) — this
package is `private` in the monorepo and is not published on its own.

```bash
npm install -g @weavecode/weave
weave init
weave daemon start
weave dashboard
```

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

Requires Node.js >= 22.5.

## License

Apache-2.0
