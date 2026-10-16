# @weavecode/server

Weave daemon — HTTP API, SQLite data layer, hook ingestion (a file-based inbox
consumed by a worker thread), and static hosting for the dashboard SPA.

Part of [weave](https://github.com/zijing66/weave). Installed as part of
[`@weavecode/weave`](https://www.npmjs.com/package/@weavecode/weave) rather than
used directly — this package is `private` in the monorepo and is not published
on its own.

Requires Node.js >= 22.5 (uses `node:sqlite`).

## Built-in resources

Weave's built-in commands, agents, plugin packs and rule packs are one
marketplace-shaped repo shipped by `@weavecode/templates` under
`src/resources/weave-market/` (`dist/resources/weave-market/` in the built
package). On start the daemon materializes it at
`<configDir>/weave/market/weave/` (a link to that directory) and scans it as the
built-in market: **changing what weave ships means editing that directory**, not
code-side lists. See the root [README](../../README.md#built-in-resources).

## License

Apache-2.0
