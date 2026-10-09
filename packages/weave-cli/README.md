# @weavecode/cli

CLI entry point for [weave](https://github.com/zijing66/weave) — a
coding-agent harness for Claude Code (and friends). Provides the `weave`
command: project init, daemon management, and the local dashboard.

```bash
npm install -g @weavecode/cli
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
| `weave daemon start\|stop\|status` | Manage the local daemon |
| `weave dashboard` | Open the dashboard in a browser |
| `weave statusline preview` | Preview the statusline |

Requires Node.js >= 22.5.

## License

Apache-2.0
