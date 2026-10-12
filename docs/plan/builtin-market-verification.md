# 内置仓方案 前置验证记录（H1–H5）

对应方案：`.claude/plans/builtin-market-repo.md` 第二章。**本文件是批 0 的交付物**，
结论决定后续批次能否按原计划进入。环境：win32 / Node v24.19.0 /
Claude Code CLI 直接调用宿主的 `~/.claude/plugins/` 注册表。

---

## H1 —— Windows 下 `lstat(junction).isSymbolicLink()` 是否为 true

**为什么查**：`weave-server/src/market/install-link.ts` 的 `removeInstalled` 完全依赖
这一判定决定走 `unlink`（只删链接）还是 `rm -rf`（递归删目录）。若 junction 不被识别为
链接，卸载会把链接当普通目录递归删，**删穿到源目录**——既有数据丢失风险。

**实测**（临时目录造 `junction` → 源目录各含 `SKILL.md` 与嵌套文件）：

```
platform           = win32
symlink type used  = junction
lstat(target).isSymbolicLink() = true
lstat(target).isDirectory()    = false
realpath(target) == realpath(src) = true
BRANCH => unlink（安全：只删链接）
```

**结论：✅ 不成立，无此风险。** `removeInstalled` 的既有假设在 win32 + junction 下正确，
不需要前置修复批。（顺带确认：junction 的目标路径参与 `realpath` 解析，指回源目录。）

---

## H2 —— `fs.cp` 递归是否带上点目录 `.claude-plugin/`

**为什么查**：仓采用市场形态，清单在 `.claude-plugin/marketplace.json`。若拷贝动作
丢掉点目录，仓落 dist 后清单缺失，`pluginKey`/市场解析全线失效。

**实测**（`cp(src, dst, { recursive: true, force: true })`，src 含 `.claude-plugin/`
与四层深的包文件）：

```
dst readdir          = [ '.claude-plugin', 'plugins' ]
dot dir copied?      = true
marketplace.json ok  = 17 bytes
deep pack file ok    = 4 bytes
```

**结论：✅ 通过。** `fs.cp` 递归完整带上点目录与深层文件；`copy-templates.mjs`
的现有写法（`rm` 后 `cp`）可直接沿用，仓无需特殊处理点目录。

**遗留（批 1 复核）**：① `npm pack --dry-run` 确认 `files: ["dist"]` 是否发布
`dist/resources/weave-market/.claude-plugin/`；② 仓内静态存在的 `.claude-plugin/`
是否会让 CC 在 **weave 本仓**误识别出一个市场（预期不会：注册市场必须显式
`marketplace add`）。若②命中，改为**落地时合成清单**，仓内只留 `plugins/`。

---

## H3 —— CC CLI 是否接受 junction 形态的包源

**为什么查**：这是 D5「去重最大一笔」的前提 —— 计划把
`~/.claude/weave-marketplace/plugins/<name>` 从**复制**改成**链接**，指向
`<dataDir>/market/weave/plugins/...`（即市场目录**之外**）。

**实测**（造 `weave-h3-probe` 市场仓，`plugins/h3-probe` 为指向市场外源目录的 junction）：

1. `claude plugin validate <market>` —— 只读，权威：

   > ⚠ `plugins[0].source`: Local source "./plugins/h3-probe" is or traverses a symlink,
   > so `plugins\h3-probe\.claude-plugin\plugin.json` was not read — validation never
   > follows one. **Install dereferences symlinks that stay inside the marketplace,
   > so this entry still loads.** Validate the real path separately.

2. `claude plugin marketplace add <market>` → `✔ Successfully added marketplace: weave-h3-probe`
3. `claude plugin install h3-probe@weave-h3-probe --scope user --json` → `"outcome":"ok"`（**成功**）
4. 落盘形态：`installPath = ~/.claude/plugins/cache/weave-h3-probe/h3-probe/0.0.1`，
   内容是 `.claude-plugin/plugin.json` + `skills/probe-skill/SKILL.md` 的**实体副本**
   （CC 已解引用 junction 并复制）。

**结论：✅ 通过。** 两点必须写进实现：

- junction 源**可用**，即使指向市场之外 —— D5 的链接方案成立。
- ⚠ **CC 自己的 `plugins/cache/**` 永远是实体副本**（CC 解引用后复制），这份**不可链接**
  （超出 weave 管辖）。所以 D5 的收益口径要收敛为：**消除 weave 自己那层
  `weave-marketplace/plugins/<name>` 副本**，不是「全局只剩一份」。
- ⚠ `validate` **不跟随符号链接** —— 批 1 的清单一致性测试必须**另行校验真实路径**
  （即对仓内实体目录校验），不能只 `validate` 市场仓。

**可回滚性验证**：`uninstall` + `marketplace remove` 后，
`known_marketplaces.json` 与 `installed_plugins.json` 的 SHA256 与实验前**完全一致**
（`9EB61CDE…` / `560EE218…`），既有 3 个市场、8 个插件零变化。
唯一残留是 CC 未清空的 `cache/weave-h3-probe/`，已手工删除。

---

## H4 —— 内置仓登记为 `libraries` 行的涟漪面

**为什么查**：D2 把内置仓登记为 `libraries` 行，而 `marketLibraryRoots()`
（`market/resolve.ts:38-49`）返回「`<dataDir>/market/` 内的库行」作为 toolkit 扫描源与
plugin-loader 装载源。不等 `<dataDir>/market/weave` 排除掉，同一棵树会被扫两遍
（一遍 `builtin`、一遍 `market`）→ 重复包 / 重复开关。

**已定位**：

- 修复点单一：`marketLibraryRoots()` 内按 `marketIdOf(abs) === 'weave'` 排除
  （复用既有唯一判据，不新写路径比较）。
- `market-roots.test.ts:99-100`（`expect(marketLibraryRoots(libraries)).toEqual([marketRoot])`）
  自建临时 libraries，**预期零改**，批 2 执行核查。
- **待核清单**（批 2 逐条确认是否断言 libraries 行数/清单长度）：
  `src/__tests__/data.test.ts`、`fs-server.test.ts`、`install-server.test.ts`、
  `market-updates-server.test.ts`、`updates-server.test.ts`；
  `src/install/__tests__/library-index.test.ts`。
- `GET /market` 未发现行数断言 → 新增内置行预期零改。

---

## H5 —— 内置真树测试在扫描根变更下的涟漪面

**为什么查**：D1 的目录层级是硬约束（扫描根的直接子目录 = `scope`，内置源
`MAX_SCAN_LEVEL=2`）。已读源码确认 `scope` 取自 `level === 0` 的目录名
（`toolkit-scan.ts:236-259`），故仓布局必须是 `<仓>/plugins/<scope>/<pack>/`，
多插一层会让包落到 level 3 而**全部不可见**。

**已定位：3 个测试文件各自硬编码旧的内置根**（均指向 `src/hooks/presets/harness-tools/`）：

| 文件 | 行 |
|---|---|
| `src/hooks/__tests__/toolkit-scan.test.ts` | `:18`（`BUILTIN_ROOT`）、`:225`、`:252-253` |
| `src/hooks/__tests__/toolkit-toggle.test.ts` | `:37`、`:144`、`:301-303`、`:372-373` |
| `src/__tests__/toolkit-server.test.ts` | `:24`、`:67`、`:252` |

三者中的真树断言（8 个包 id、`scope: 'core-skills'`、`provenance === 'builtin'`）在
**新扫描根 + 保持 scope 层级**时**语义全部成立**，只需把 `BUILTIN_ROOT` 改指
`packages/weave-templates/resources/weave-market/plugins/`。归**显式修订组**，
与被修订实现同批同 commit。

**测试环境注意**：`toolkit-server.test.ts` 经 daemon 装配走真实内置根，批 2 落地到
`<dataDir>/market/weave` 后，该测试须先确保仓已落地（或在测试里注入 `builtinRoot`，
该注入点已存在：`toolkit.ts:322` 的 `this.deps.builtinRoot ?? builtinToolkitRoot()`）。

---

## 汇总

| # | 结论 | 对方案的影响 |
|---|---|---|
| H1 | ✅ 不成立 | 删除「H1 命中则前置独立修复批」的预案；批 0 无代码改动 |
| H2 | ✅ 通过（后半批 1 复核） | 仓内点目录可直接静态存在 |
| H3 | ✅ 通过（附两条限制） | D5 链接方案成立；**收益口径收敛**为「消掉 weave 自己那层副本」；批 1 清单测试须校验真实路径 |
| H4 | 已知修复点 + 6 个待核测试 | `marketLibraryRoots` 加排除；批 2 逐条核查 |
| H5 | 3 个测试文件的 `BUILTIN_ROOT` 归显式修订组 | 层级约束已固化进 D1 |

**批 0 无代码改动、无提交**（H1 未命中，不需要前置修复批）。后续按批 1 起进入实现。
