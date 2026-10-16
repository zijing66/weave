# @weavecode/weave

All-in-one install for [weave](https://github.com/zijing66/weave) — the CLI,
daemon + dashboard, harness drivers, and the built-in resource repo pulled in
by a single npm package, with the `weave` command wired up directly (works
with npm and pnpm alike — transitive bins are not linked under pnpm, so this
package ships its own shim).

```bash
npm install -g @weavecode/weave
weave init
weave daemon start
weave dashboard
```

The five weave packages are bundled inside this tarball (they are `private` in
the monorepo and are not published separately), so a global install pulls this
one artifact and nothing else from the registry. The command table lives in
[@weavecode/cli](https://github.com/zijing66/weave/tree/main/packages/weave-cli#readme).

Requires Node.js >= 22.5.

## License

Apache-2.0
