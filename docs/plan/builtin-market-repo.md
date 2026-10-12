# Weave 内置仓与仓库维度资源管理 实施方案

## Context

用户对当前资源管理的裁决（原话要点）：

1. **内置一个 weave 仓库**，weave 特性功能 + 其他插件全部集中其中（形态参照
   `~/.claude/plugins/cache/claude-plugins-official/superpowers/5.1.0`），内置全部导入，
   包括 init 的资源也统一由这个仓库管理 —— **后续改 weave 内置 = 只动这一个仓库目录**。
2. 资源管理与 weave 两页**均以「仓库 namespace」维度管理全部资源**；`Files` 是唯一
   合并展示的视图（全局/项目文件），每个文件打所属仓库 namespace 标记；**其余模块
   按仓库 namespace 分折叠块**。
3. skill 三级折叠：仓库(namespace) → 插件文件夹（父级文件夹作汇总单位，如 `superpowers`）
   → 每个独立技能（沿用当前分卡片）。开关按**各 harness 实际支持的层级**给。
4. plugin 同构、视觉统一，**去掉「工具箱」标题**，市场为一级；裸插件归到一个分类下。
5. weave 页里**插件区与下方规则编辑合并为一块**（展示 + 编辑），不再两块。
6. weave 页插件下方的**「粘贴本地目录/git URL 回车安装」输入框移除** —— 安装来源只有
   内置仓 + 外部仓库（走资源市场）。
7. 安装/公共全局位置**优先符号链接**（跨平台，异常提示用户，如 Windows 需开发者模式）；
   **项目一律拷贝，不共享同一份副本**。

### 已确认决策（AskUserQuestion）

| 问题 | 选择 |
|---|---|
| 内置仓落位 | **源码仓单一目录，启动落到 `<dataDir>/market/weave/`**（扫描/展示/安装的唯一事实源） |
| 收拢边界 | **只收资源型**（命令/agent/技能/钩子/mods/规则包/plugin.json）；`hook-handler.cjs`、`statusline.cjs`、`CLAUDE.md`、`settings.json`、`.mcp.json` 等带项目参数的**生成物仍由代码产出** |
| 右栏资源市场面板 | **保留右栏面板** |
| 链接失败策略 | **回退 cp + UI 标出形态**（链接/副本徽标 + 开发者模式提示） |

### ✅ 右栏口径（已定，2026-02 用户复述确认）

用户先前的原话是「**不展示右侧资源市场**」，但在选项中选择了「**保留右栏面板**」。
**用户已最终确认：保留右侧栏面板** —— 矛盾消解，本方案按「右栏保留」执行。
批 7 因此**不是**撤挂载，而是把 `App.tsx:1087-1111` 的 `LibraryPanel` 口径与新的
仓库维度块对齐（R9 关闭）。

### 范围红线（全程不动）

REST 路径与语义（`/hooks/*`、`/projects/:id/toolkit*`、`/market*`、`/libraries*`）、
表名与 schema 列、SSE `type:'hook'`/`kind` 枚举、前端 `weave:hook` 协议、
CLI `weave hooks|plugins|toolkit`。**内置包的注册键保持 `name@weave` 不变**（见 D3 硬闸）。

---

## 第一章 架构决策

### D1 内置仓形态与落位

**事实源 = 源码仓内单一市场形态目录，落在资源包 `@weavecode/templates` 内**：

```
packages/weave-templates/resources/weave-market/
├── .claude-plugin/marketplace.json        # { name:"weave", owner:{name:"weave"}, plugins:[8 包] }
├── plugins/                                # toolkit 扫描根；**直接子目录 = scope**
│   ├── core-skills/{code-review,project-navigation,refactoring,testing}/
│   ├── doc-hooks/{docs-reminder,md-lint}/
│   └── session-mods/{file-guard,mission-control}/
├── rules/                                  # SPI 平铺装载根（= 今日 presets/ 平铺层）
│   ├── weave-stop-summary/
│   ├── weave-doc-update-check/
│   └── weave-cross-project-touch/
└── init/                                   # init 供源（非包、无开关）
    ├── commands/*.md  (4)
    └── agents/*.md    (4)
```

**层级是硬约束（批 0 实测确认）**：`discoverToolkitPacks` 的 `scope` 取自扫描根
**直接子目录**名，内置源 `MAX_SCAN_LEVEL=2`（root→scope→pack，`toolkit-scan.ts:236-259`）。
所以扫描根必须是「直接子目录即 scope」的那一层 —— 若按市场惯例插一层
`plugins/harness-tools/<scope>/<pack>`，包会落到 level 3 **全部不可见**，且
`scope` 从 `core-skills` 漂成 `harness-tools`（真树冒烟断言正是这两个值）。
故：**扫描根 = `<仓>/plugins/`**，`core-skills` 等 scope 直接置于其下。

**为什么 `rules/` 与 `init/` 在 `plugins/` 之外**：二者内容都会被包谓词命中
（`isToolkitPackDir` ②`weave-plugin.json`、③裸 `commands/`+`agents/`）。放进 `plugins/`
会让工具包列表从 8 变 11/12，撞掉两处真树断言，也改变「内置规则包不走 toolkit 列表、
由 SPI 平铺装载」的既有语义。扫描根是显式参数，故二者**故意置于市场面之外** ——
仍在同一个仓目录内，符合「改内置只动这一个目录」。

**键与 id 零变**：`pluginKey(pack.name, marketIdOf(pack.dir))` 的 `marketIdOf` 以
`<dataDir>/market` 为根 → `rel.split(sep)[0]` = `weave` → 键仍是 `name@weave`
（今日是 `undefined` 回落 `WEAVE_MARKETPLACE='weave'`，结果相同）。

**为什么放 `weave-templates` 而不是 `weave-server`**：该包语义就是「资源包」，已随发布
（`scripts/release.mjs:18` 顺序 `core→harness→templates→server→cli`，templates 在 server 前），
且 `weave-cli` 已依赖它、`weave-cli` 也依赖 `weave-server`。落这里只需**新增一条边
`server → templates`**（templates 仅依赖 core，无环）；落 server 则要把 commands/agents
从 templates 拔走、templates 退化为空壳，且 server 侧已有 `copy-presets.mjs` 的语义会被
内联生成物与资源混在一处。

**搬迁清单（只搬位置，内容零改）**：

| 从 | 到 |
|---|---|
| `packages/weave-templates/src/templates/commands/*.md` (4) | `<仓>/init/commands/` |
| `packages/weave-templates/src/templates/agents/*.md` (4) | `<仓>/init/agents/` |
| `packages/weave-server/src/hooks/presets/harness-tools/{core-skills,doc-hooks,session-mods}/**` | `<仓>/plugins/{core-skills,doc-hooks,session-mods}/**` |
| `packages/weave-server/src/hooks/presets/weave-*/**` (3 个规则包) | `<仓>/rules/weave-*/**` |

- `marketplace.json` 的 `plugins[]` 逐包列（`source: "./plugins/<scope>/<pack>"`）；
  **新增一致性测试**：清单条目 ↔ 实际包目录双向相等（少一条/多一条即红）。
- `copy-templates.mjs` 改为 `rm dist/resources && cp src/resources dist/resources`；
  `copy-presets.mjs` 删除（其职责并入 templates 的 copy 脚本）；`package.json` 的
  `files:["dist", ...]` 已覆盖（`fs.cp` 递归含点目录）。
- 不再保留 `src/hooks/presets/` 与 `builtinToolkitRoot()` 指向 dist 的写法。

### D2 落地：`<dataDir>/market/weave/` 与 libraries 行

**启动装配时（唯一实现点，仿 `daemon/hook-pipeline.ts` 的先例）把仓落地为
`<dataDir>/market/weave/`，并登记为一条 `libraries` 行。**

- 触发：daemon 启动时比对包内仓的版本标记与已落地标记，不一致则 `rm -rf` 后整目录 `cp`。
  标记复用 `market/manifest.ts` 的 `MANIFEST_FILE`（`.weave-market.json`，
  `source:'dir'`、`origin` = 包内绝对路径、`importedAt`），不新增格式。
- 行形态：`libraries.add({ path: 'market/weave', kind: 'both' })`（`toRelPosix` 已有）。
  **`marketIdOf` 天然得出 id `weave`** → 所有内置包键 = `name@weave`，与今日完全一致。
- ~~**落地用复制而非链接**~~ → **修订为链接（失败回退复制）**，见批 2 的「D2 修订说明」：
  落点是只读包内容而非数据，「公共全局位置优先链接」直接适用；变址由「启动比对
  `realpath`、不一致即重铺」覆盖；写入风险为零（扫描缓存在兄弟目录 `.weave-scans/`）。
- **守卫**（`daemon/server.ts` 的 market 路由）：
  - `DELETE /market/weave` → 409（内置仓不可删）；
  - `POST /market/refresh` 命中内置仓 → 重新从包落地（= 「更新内置」语义，天然幂等）；
  - `POST /market/check-updates` 跳过内置仓（无远程源）。
- 副作用：`GET /market` 自动多出 `weave（内置）` 一行；右栏与中栏都以「仓库」为单位渲染它，
  无需特判。

### D3 扫描/装载源切换与 provenance 口径

- `builtinToolkitRoot()`（`hooks/toolkit-scan.ts:69-73`）→ **改为「内置仓的 `plugins/` 根」**
  = `<dataDir>/market/weave/plugins`。`discoverToolkitSources()` 仍返回
  `{ root: <该根>, provenance: 'builtin' }`。
- `marketLibraryRoots()`（`market/resolve.ts:38-49`）**须排除内置仓**（按 `marketIdOf==='weave'`），
  否则同一棵树会被扫两遍（一遍 builtin、一遍 market）→ 重复包。
- `plugin-loader.ts:634` 的内置平铺根 `<dist>/hooks/presets/` → 改为
  `<dataDir>/market/weave/plugins/weave-rules`（其 `weave-plugin.json` 深度发现走既有
  `discoverWeavePackDirs`）。
- **硬闸：内置包注册键与包 id 零变**（`name@weave`、`core-skills/*` 等 id 不变）。
  受影响断言：`toolkit-server.test.ts:122`（`packs.every(p => p.provenance==='builtin')`
  仍是真，但**扫描根路径变了**，该测试须在测试环境先把仓落地）、`toolkit-scan.test.ts`
  文末「内置真实树冒烟」——两者归**显式修订组**，与被修订实现同批同 commit。
- `ToolkitProvenance` 枚举**不新增第三值**：内置仓 = `'builtin'`，其余市场 = `'market'`。

### D4 namespace 字段：web 不解析 `@`

`web 只渲染不解析（@ 后 = 所属市场）`是 CLAUDE.md 的硬约束，而现在服务端自己就在解析
（`install/global-config.ts:297` `key.split('@')[0]`）。三级折叠的 L1 需要市场名，**不得**
让 web 去 split。

- 在 `PluginSurface`（`weave-harness/src/driver.ts:153-182`）**新增一个方法**
  `pluginNamespace(key: string): string`（键形知识留在 harness，唯一拼装点旁边放唯一拆解点），
  `claude/plugins.ts` 实现为 `key.split('@')[1] ?? WEAVE_MARKETPLACE`。
- 服务端在**已有的**资源载荷上补一个显式字段 `namespace: string`（或 `market`），
  经 `pluginSurfaceFor('claude').pluginNamespace(...)` 取值：
  - `GlobalSkillGroup`（`install/global-config.ts:61`，已带 `pluginKey`）
  - `MarketPluginAsset`（`install/scanner.ts`，已带 `key`）
  - `ToolkitPackInfo`（toolkit 列表）
  - `HookPluginInfo`（`/hooks/plugins`）
- 顺带把 `global-config.ts:297` 的裸 `split('@')` 改为经 surface 取（同一批）。
- web 侧**只用 `namespace` 字段**分块；`<name>@<ns>` 仍作可见徽标渲染（既有口径）。

### D5 链接优先：装面链接、项目复制、形态由 lstat 读出

现状：`market/install-link.ts` 的 `linkOrCopy`/`removeInstalled` 已存在（Windows 用
**junction = 免特权**，`EPERM/EEXIST/ENOTSUP` → 静默回退 `cp`），但**只有 2 个调用点**
（`install/global-config.ts:219/230` 的全局 skill 装/卸）。

- **⚠ 原语必须先迁到 harness（架构硬约束）**：`linkOrCopy`/`removeInstalled` 现在在
  **server**（`weave-server/src/market/install-link.ts`），而要用它的 `syncMarketplace`
  在 **harness**（`claude/plugins.ts`）。直接从 harness 引用 server 会新增
  `@weavecode/harness → @weavecode/server` —— 违反「`harness → core` 是 harness 唯一外向依赖」。
  **做法**：原语迁到 `weave-harness/src/shared/install-link.ts`（该目录已存在，
  同处已放 `shared/file-specs.ts`；且「如何装进全局装面」本就是 harness 知事，
  因为全局根 `~/.claude/skills` 与 `~/.agents/skills` 是 harness 专属），经
  `@weavecode/harness` 导出；**server 侧 `market/install-link.ts` 保留为同名薄委托**
  （`export * from '@weavecode/harness'` 级），使既有 2 个消费者
  （`install/global-config.ts:12` 与其测试）**零改** —— 这与本仓已有的
  「global-config 的 CC 实现迁入 claude/、server 保同名薄委托」先例同构。
  测试随之迁到 `harness/src/__tests__/install-link.test.ts`（或保留 server 侧但改为
  对薄委托的转发断言）。
- **扩用**：`claude/plugins.ts` 的 `syncMarketplace`（:221-274）今日把包 `cp` 进
  `~/.claude/weave-marketplace/plugins/<name>` —— 改为 `linkOrCopy`，链接指向内置仓/市场内
  的包目录。这是**去重最大的一笔**（内置插件今日至少 3 份：源目录 → weave-marketplace → CC cache）。
  ⚠ CC 自己 `plugin install` 复制进 `~/.claude/plugins/cache/**` 的那一份**是 CC 自己的**，
  不可链接（超出 weave 管辖），明确不做。
- **项目一律 `cp`**（`install/installer.ts:90` 现状）：不动。
- **形态不落盘，读时 lstat 判定**：新增只读函数 `installForm(absPath): 'link' | 'copy' | 'absent'`
  （与 `removeInstalled` 同处 = harness `shared/install-link.ts`），用
  `lstat().isSymbolicLink()` 判定；随既有枚举端点把 `form` 字段带给前端。
  **不新增持久状态**（免迁移、免失真）。
  *批 0 已实测*：Windows 下 `lstat(junction).isSymbolicLink() === true`，`realpath` 指回源目录
  —— 与 `removeInstalled` 的既有假设一致，**无删穿源目录风险**。
- **链接判定结果写进 UI**（批 6）：全局资源行尾徽标 `链接` / `副本`；副本态给一次性提示
  「Windows 可在『设置 ▸ 系统 ▸ 开发者选项』开启开发者模式后重装以改用链接」。
  文案须准确：**目录**链接在 Windows 走 junction 免特权，只有**文件级**符号链接才需要开发者模式。
- ⚠**提示的作用域（批 4 实机踩出）**：`form` 只陈述事实，不等于「可操作」。实机
  `GET /projects/10/skills/global` 显示：CC 插件所带技能（`claude-plugin` / `codex-plugin`
  分组，落在 `~/.claude/plugins/cache/**`、`~/.codex/plugins/cache/**`）**全是 copy** ——
  那是 CC 解引用后自行复制的，weave 无法决定（H3 已确认）。故「副本 → 开开发者模式重装」
  这句提示**只能出现在 weave 能决定形态的地方**（全局 skill 安装、weave 市场铺包），
  对 CC 自有缓存区的副本不得照搬，否则是误导。

### D6 UI：仓库维度折叠块（三级）

`资源管理`（`files` 卡）与 `weave` 两页的 Skills/Plugins 模块统一改为：

```
L1 仓库 namespace 折叠块
   ├ 本地            （手动安装/裸资源，无 namespace）
   ├ weave（内置）
   └ <外部市场 id>   如 claude-plugins-official
   └ L2 插件文件夹折叠块（父级文件夹 = 汇总单位，如 superpowers）
        └ L3 每个独立技能/插件行（沿用当前分卡片 / 现有行样式）
```

- **L1 默认展开 / L2 默认折叠**（与用户描述一致：「市场折叠块默认折叠，展开后…再展开才是
  每个独立技能」）。复用 `LibraryPanel.tsx:1189-1237` 的 `TemplateSection` 折叠原语 ——
  **抽成共享组件**（该文件内联，另有多处各自 `useState<Set>` + chevron 的重复；
  按 CLAUDE.md「不新增抽象类」是不冲突的：这是组件不是类，但仍**优先改现有文件**、
  只在该原语被第三个调用点复用时才抽出）。
- 折叠状态用**展开集**（默认空）而非折叠集：数据异步到达时保住用户已展开项
  （`LibraryPanel.tsx:340-341` 已有此先例与注释）。
- 开关粒度**按 harness 实际支持**，不造统一开关：

| 层级 | 可用开关 |
|---|---|
| 全局技能（CC 插件所带） | 按插件组 power 按钮 → `api.putPluginEnabled`（`SkillGrid.tsx:428-457` 现状） |
| 项目技能 | 卸载（`SkillGrid.tsx:138-161` 现状），无开停 |
| toolkit 包 | 按项目 `Switch` → `api.toggleToolkit`（`ToolkitSection.tsx:189-194`） |
| weave 规则包 | 按项目 `effective` 开关 → `api.toggleHookPlugin(projectId)` |
| MCP | 三态循环（`McpGrid.tsx:30-40`） |
| codex 侧无对等物 | 不给开关（`codex/index.ts:8-11` 明确无插件机制） |

### D7 weave 页：插件区与规则编辑合并 + 移除粘贴安装

- **合并**：今日 `HooksPanel.tsx` 三块 —— 插件卡（:622-634）→ 画布卡（:637-686）→
  规则列表卡（:957-1066）+ 弹窗表单（:688-954）。SPI 规则本就**归属**某个插件包
  （`hook_rules.plugin_id`），所以合并成：**每个仓库/插件包一块，块内同时承载
  「该包的开停」与「该包的规则列表 + 编辑入口」**；`plugin_id IS NULL` 的裸规则归到
  「本地规则」一块。画布卡保留（它是数据流可视化，不是重复编辑面）。
- **移除**：`HooksPluginsSection.tsx:188-211` 的粘贴安装输入（含 `installSrc` 状态、
  `install()` 处理体、`hooks.plugins.installPlaceholder` / `install` / `installing` 词条）。
  该组件从此**只展示 + 启停**。词条按 CLAUDE.md 的 i18n 口径 zh/en 成对删。
- **顺带消重**：同一批 weave 插件今日在 **3 处**渲染（`HooksPanel` 用
  `api.toggleHookPlugin`、`LibraryPanel` 插件区自带 Switch 用 `api.toggleToolkit`、
  `ToolkitSection.tsx:200-203` 用注释显式过滤掉它们）。合并后**weave 页为唯一承载**，
  `LibraryPanel` 的插件区与 `ToolkitSection` 的过滤注释同批对齐（保留原过滤，注释改为
  指向新归属）。

### D8 Files 合并视图 + namespace 标记

`Files` 是唯一合并展示：全局/项目文件都进同一棵树，**每个文件挂所属仓库 namespace 标记**。

- 数据侧：`GET /assets` / `GET /global-file-assets` / `GET /projects/:id/skills/global`
  的每一项补 `namespace`（D4 同一字段口径）。
- 前端：`lib/file-tags.ts` 既有 tag 体系上**加一类 namespace tag**（渲染层，`file-tags.ts`
  已有 `tagsOf` 汇总点）。零后端 schema 改动。

### D9 init 的 commands/agents 改由仓供应

- `templateRegistry.getCommandsSourceDir()/getAgentsSourceDir()`
  （`weave-templates/src/index.ts:77-85`）→ 指向 `<仓>/init/{commands,agents}`；
  `MANIFEST` 由「手写 8 条」改为**扫描仓内 `init/`**（保证「改仓即改内置」）。
- **init 与 toolkit 的接缝因此消失**：`<仓>/init/` 在扫描根 `<仓>/plugins/` 之外，
  `isToolkitPackDir` ③（裸 `commands/`+`agents/`）不会命中它 → 不会多出一个可启停的
  `weave-assets` 包，也就不存在「init 复制的文件与 toolkit 启停互相删」的问题（D1 布局
  直接消掉了这个 seam，原方案里的兼容规则不再需要）。命令/agent 今日本就没有开关层级，
  与「按 harness 实际支持的级别给开关」一致。
- `getSkillsSourceDir()` 现指向不存在的目录（`copySkills` 是静默 no-op，
  `claude.ts:441-457`）—— 本次**不借机塞技能**（技能由 `core-skills` 等包提供，符合仓的划分），
  但把该 no-op 的注释改为指向仓内 `plugins/*/skills` 的口径，避免下一个人再踩。

### D10 架构合规自检（逐条对 CLAUDE.md，实施时不得破）

| CLAUDE.md 约束 | 本方案如何满足 |
|---|---|
| 全仓唯一 abstract class = `InitPipeline`，**不新增其他抽象类** | 本方案**零新增 abstract class**。仓库维度折叠 = **React 组件**（非类）；市场/落地/装配 = 普通模块与函数。D6 的折叠原语**优先改现有文件内联**，仅在出现第三个调用点时抽成共享组件。 |
| 六能力槽 + `HarnessRegistry` 统一装配；harness 专属实现落 `weave-harness/src/<name>/`；**server/cli 只做装配编排，不写 harness 硬编码** | 唯一需要新增的能力面方法 = `PluginSurface.pluginNamespace(key)`（D4），实现落 `claude/plugins.ts`，codex 不注册（其本就无插件机制）。server 只经 `pluginSurfaceFor(...)` 取值。 |
| **`@weavecode/harness → @weavecode/core` 是唯一 harness 外向依赖** | ⚠ 本方案原有一处**会破这条**（D5 从 harness 引 server 的 `linkOrCopy`），已修正为**原语上迁 harness `shared/`、server 保薄委托**。无其他新增反向边；`server → templates`（D1）是 server 的**外向**依赖，不违反此条。 |
| core 只放纯类型与表（`HARNESS_*` 注册表） | 仓内资源与路径解析**不进 core**；`linkOrCopy` 这类 fs 原语也**不进 core**（改放 harness `shared/`）。core 零改动。 |
| web 仅 `import type` 引 core/harness | 新增字段（`namespace`/`form`）都是 **API 载荷**，不是 web 对 harness 的运行时引用。web 零新增 core/harness 导入。 |
| harness 专属格式/路径/键形不得在 server/cli/web 自拼或散写，一律经能力面取 | L1 折叠需要「市场名」，而键形是 harness 知事 —— 由 D4 的能力面方法供值；**web 绝不 split `@`**。顺带修掉服务端既有的裸 `key.split('@')[0]`（`global-config.ts:297`）。 |
| 插件注册键形唯一拼装点 = `PluginSurface.pluginKey` | 键形生成点不变（`claude/plugins.ts:152-154`）；新增的拆解点紧邻它，同文件、同属 harness。 |
| 市场身份判据唯一实现 = `market/identity.ts` 的 `marketIdOf` | D2/D3 全程复用 `marketIdOf`（内置仓靠它天然得出 id `weave`），**不新增第二处判据**；`marketLibraryRoots` 的排除逻辑也调用它而非另写路径比较。 |
| 不新增顶层目录；优先改现有文件 | 仓落在**已存在的** `packages/weave-templates/` 内（`resources/`），不新增包、不新增顶层目录。 |

### D11 全套装配入口仍单点

新装配（仓落地 + 内置行登记）**必须与 `wireHookFilePipeline` 同样落在两个入口共用的
单一实现点**（`daemon/start.ts` 与 `daemon/dev-entry.ts` 共用），并受结构守卫测试保护 ——
这是本项目已踩过的坑（`dev-entry.ts` 曾漏装配整条 hook 管道），本方案沿用同一纪律。

---

## 第二章 前置验证 H1–H5（批 0，结论不过不进后续批）

| # | 待验 | 不过的后果与回退 |
|---|---|---|
| **H1** | ⚠**最高优先**：Windows 下 `lstat(junction).isSymbolicLink()` 是否为 `true`。`install-link.ts:36-43` 的 `removeInstalled` 完全依赖它 —— 若为 `false`，卸载会把链接当普通目录 `rm -rf`，**直接删穿到源目录**。这是**既有数据丢失风险**，与本次改动无关但必须先修。 | ✅**已实测不成立**（win32 + junction：`isSymbolicLink() === true`，`isDirectory() === false`，`realpath` 指回源）。**无此风险，无需前置修复批**。 |
| **H2** | `fs.cp(src, dist, {recursive})` 是否完整带上 `.claude-plugin/` 点目录；npm `files:["dist"]` 是否发布它；仓内 `.claude-plugin/marketplace.json` 是否会让 CC 在**本仓**误识别出一个市场。 | ✅**前半已实测通过**（`fs.cp` 递归完整带上 `.claude-plugin/` 与深层包文件）。后半（npm 发布 + CC 误识别）待批 1 用 `npm pack --dry-run` 复核；若误识别：清单改为**落地时合成**。 |
| **H3** | `claude plugin marketplace add <dir>` 对 `plugins[].source` 指向 junction（`~/.claude/weave-marketplace/plugins/<name>` → 仓内包目录）是否正常工作，`plugin install` 是否成功。 | ✅**已实测通过**（junction 即使指向市场**之外**亦可用：`marketplace add` + `install` 均成功）。⚠两条限制：① CC 自己的 `cache/**` 永远是实体副本→**D5 收益口径收敛为「消掉 weave 那层副本」**；② `validate` 不跟随符号链接→批 1 清单测试须**另行校验真实路径**。 |
| **H4** | `libraries` 新增内置行对现有断言的影响面：`data.test` 的 libraries 幂等、`library-index`、`updates-server`、`apply-update`、`fs-server`、`GET /market` 行数与 `market-roots.test`（`marketLibraryRoots` 现含内置仓会双重扫描）。 | 修复点单一（`marketLibraryRoots` 按 `marketIdOf` 排除内置仓，复用唯一判据）；`market-roots.test:99-100` 自建临时行**预期零改**；**6 个待核测试**（`data/fs-server/install-server/market-updates-server/updates-server/library-index`）批 2 逐条确认。 |
| **H5** | 内置仓落地后，内置真树冒烟的既有断言（`toolkit-scan.test.ts` 文末、`toolkit-server.test.ts:122`）在新扫描根下是否仍成立；测试环境是否需先落地仓。 | ✅**已定位**：3 个测试文件硬编码 `BUILTIN_ROOT`（`toolkit-scan.test.ts:18`、`toolkit-toggle.test.ts:37`、`toolkit-server.test.ts:24`）。**保持 scope 层级时语义全部成立**，只需改指新根 → 归显式修订组。层级约束已固化进 D1。 |

**批 0 交付**：`docs/plan/builtin-market-verification.md` 记录每项结论与依据（命令 + 实测输出）。

---

## 第三章 分批实施

每批铁律：**`pnpm build && pnpm build:web && pnpm test` 全 0**（高负载用
`--maxWorkers=1`，bash 通道会挂死→走 PowerShell）+ 中文 commit（正文写本批硬闸：
零改 X 条 / 修订 Y 条及理由）。

### ☑ 批 0 —— 前置验证 H1–H5（H1 不成立，无前置修复批）
- 只在必要时改代码；**H1 若命中，其修复作为本方案前置的独立 commit**。
- 产物：`docs/plan/builtin-market-verification.md`（H1–H5 逐项实测；H1 结论 = 无删穿风险）。

### ☑ 批 1 —— 内置仓成立（搬迁 + 重指内置根，行为零变）—— `9691518`

- 新建 `packages/weave-templates/resources/weave-market/`，按 D1 **搬入**（非复制）全部资源，内容零改。
- 同批把**内置根的指向**改到新位置（否则包会消失）：
  - `toolkit-scan.ts:69-73` 的 `builtinToolkitRoot()` → 包内 `<templates>/resources/weave-market/plugins`；
  - `plugin-loader.ts:634` 的平铺装载根 → `<templates>/resources/weave-market/rules`；
  - `templateRegistry` 的 commands/agents 源 → `<仓>/init/*`（D9）。
- 改：`copy-templates.mjs`（拷贝 `resources/`，删 `dist/resources` 后 `cp`）、删
  `weave-server/copy-presets.mjs` 及其 build 钩子、`weave-server/package.json` 增
  `@weavecode/templates` 依赖、`weave-templates/package.json` 的 build。
- 新增：清单一致性测试（`marketplace.json` ↔ `plugins/` 下包目录双向相等）；
  **按 H3 结论，该测试须校验仓内实体目录的真实路径**（`claude plugin validate` 不跟随链接）。
- 硬闸（显式修订组，同批同 commit）：3 个测试文件的 `BUILTIN_ROOT`
  （`toolkit-scan.test.ts:18`、`toolkit-toggle.test.ts:37`、`toolkit-server.test.ts:24`）
  改指新根 —— 8 个包 id、`scope: 'core-skills'`、`provenance === 'builtin'` **语义零变**。
- **本批只搬位置**：内置包仍从**包内**目录扫描，尚未落地 dataDir（那是批 2）。
  故 `pnpm test` 全绿即证明搬迁无行为变化；`name@weave` 键与包 id 零变（D1 硬闸）。

**实施记录（批 1 完成）**：

| 项 | 结果 |
|---|---|
| 落位修正 | 仓落 `packages/weave-templates/src/resources/weave-market/`（**在 `src/` 下**，非包根）。两态 `__dirname` 分别是 `src/`（`--conditions=development`）与 `dist/`（发布），同一表达式 `path.join(__dirname,'resources','weave-market')` 两态皆准。`register.tsx` 是 TS 文件，故 `tsconfig` 加 `exclude: ["src/resources"]`（沿用 server 原先排除 `src/hooks/presets` 的先例）。 |
| 搬迁 | 45 文件 `git mv`，**全部 100% 相似度**（零内容改动）。 |
| 新增单点 | 模板包导出 `builtinMarketRoot()` / `builtinPacksRoot()` / `builtinRulesRoot()` —— 仓布局的唯一知情处；server 只取用（`toolkit-scan.ts` 与 `plugin-loader.ts` 各一处），不自拼路径。 |
| 包边 | 新增 `weave-server → @weavecode/templates`（方向与发布顺序 `core→harness→templates→server→cli` 一致，无环）；`pnpm install` 建链、lockfile 已更新。 |
| 清理 | 删 `weave-server/copy-presets.mjs` 及根 build 脚本对它的调用；`weave-server/tsconfig.json` 的 `exclude` 去掉已不存在的 `src/hooks/presets`。 |
| MANIFEST | 保持**手写**（未改扫描）：命令/agent 的 `.md` 无 frontmatter，描述是手写摘要，扫描会丢描述。仅把 `sourcePath` 改指 `resources/weave-market/init/*`。 |
| 新增测试 | `packages/weave-templates/src/__tests__/builtin-market.test.ts`（6 例）：三区齐备、`plugins/` 直接子目录不得自身是包（钉死层级硬约束）、`rules/` 平铺、`init/` 非包、清单 ↔ CC 包双向一致、每个 `source` 指向仓内**实体**目录（H3：`validate` 不跟随链接须自校）。 |
| 硬闸 | 零改：`hooks-server` / `toolkit-loader` / `market` / `harness` 全部零改。显式修订组 5 条：4 个测试的 `BUILTIN_ROOT` + `templates/registry.test.ts` 的源目录断言。 |
| 门禁 | `pnpm build` / `build:web` 全 0；全仓 **1106/1107** —— 唯一失败是并行会话在改的 `web/src/i18n/dict/tasks.ts`（`tasks.status*` 键 zh/en 不一致）与其 `dict.test.ts` 门禁，与本批无关（本批零 i18n 改动）。 |

**踩坑记录**：`weave-server/src/hooks/presets` 目录**无法 rename**（`EPERM`）—— daemon 的 mods watcher（chokidar）握着该目录句柄；同级 `market`/`db`/`statusline`/`handlers` 均可正常改名，`mv`/`git mv` 同目录改名也失败。**绕开办法：逐文件搬迁**（文件级 rename 不受影响），最后用 `rmdir` 回收空目录，未打断运行中的 daemon。

**批 3 并入本批**：批 3 的实质内容（`getCommandsSourceDir`/`getAgentsSourceDir` 改指仓内 `init/`、`getSkillsSourceDir` 的 no-op 注释收口）必须与搬迁同批完成，否则 init 会指向不存在的路径；MANIFEST 又决定保持手写。故 **批 3 已由本批吸收，不再单独成批**（下述批 3 条目作废）。

### ☑ 批 2 —— 落地 + 扫描源切换 —— `4100282`

- 新增落地模块（落 `packages/weave-server/src/market/`，不进 harness）：
  `ensureBuiltinMarket()`（版本标记比对 → `rm -rf` + `cp` + 写 `.weave-market.json` + upsert
  `libraries` 行）与 `builtinMarketRoot()`。
- 改：`toolkit-scan.ts:69-73` 的 `builtinToolkitRoot()` → 仓内 `plugins/`；
  `market/resolve.ts:38-49` 的 `marketLibraryRoots()` 排除内置仓；
  `plugin-loader.ts:634` 平铺根 → 仓内 `weave-rules`；
  `daemon/server.ts` 的 market 路由加内置仓守卫（DELETE→409、refresh→重新落地、
  check-updates 跳过）。
- 装配落**单一实现点**（D11）：`daemon/start.ts` + `daemon/dev-entry.ts` 共用函数，
  并加结构守卫断言（入口必须调它、不得各自 `cp`）。
- 硬闸：**内置包注册键与包 id 零变**；`market-roots.test.ts`（排除内置仓后行为不变）零改；
  libraries 相关断言按 H4 结论处置。

**实施记录（批 2 完成）**：

| 项 | 结果 |
|---|---|
| 落点形态 | **链接（失败回退复制）**，非计划原定的「复制」。理由见 D2 修订：落点是只读包内容、不是数据，「公共全局位置优先链接」直接适用；且开发态 `__dirname` 落在 `src/`，链接让「改仓即改内置」**无需重建即生效**（实测：`<dataDir>/market/weave` → `packages/weave-templates/src/resources/weave-market`）。 |
| 幂等 | 落点已指向当前源（`realpath` 相等）→ `changed:false` 不动盘；源变更或落点是旧复制件 → `removeInstalled`（lstat 判定）后重铺。 |
| 行登记 | `libraries.add({path:'market/weave', kind:'both'})` 幂等（`INSERT OR IGNORE`）；即使 DB 重建也会补回。 |
| 排除 | `marketLibraryRoots` 按 `isBuiltinMarketDir` 排除 —— 实测「总包数 11、无重复」印证排除生效（否则每个内置包出现两条）。 |
| 路由守卫 | DELETE 命中内置 → 409；refresh 命中内置 → 重新落地；check-updates 跳过内置。另**加固**：DELETE 的删除原语由裸 `rm -rf` 换成 `removeInstalled`（市场落点现在可能是链接，裸 rm 会删穿到包内/外部源 —— 既有隐患，与引入链接直接相关）。 |
| 装配 | 两入口都在 `loadAllPlugins` **之前** `await ensureBuiltinMarket`；新增结构守卫测试钉住顺序与「入口不自拼链接原语」。 |
| 新增测试 | `market/__tests__/builtin.test.ts`（6 例，含「重铺不删穿源」「排除内置仍收其它市场根」）、`daemon/__tests__/builtin-market-wiring.test.ts`（3 例）。 |
| 硬闸 | 零改：`hooks-server` / `toolkit-toggle` / `toolkit-scan` / `install` / `harness` 全部零改。显式修订组 1 条：`toolkit-loader.test.ts` 的 `loadAllPlugins` 冒烟（须重定向 dataDir 并先落地）。 |
| 新增不变量 | **库实例的 `dataDir` 必须与 `getDataDir()` 同根**（生产态是默认值）。落地写 `<dataDir>/market/weave`，而装载根由 `getDataDir()` 推导；不同根就错位，表现为「内置包静默消失」。已在测试注释中写明。 |
| 门禁 | `pnpm build` / `build:web` 全 0；全仓 **105 文件 / 1117 测试全绿**。实机：`/market` 列出内置行（tags: command 4 / agent 4 / plugin 11 / mods 2），内置包仍 8 个。 |

**D2 修订说明**：计划原写「落地用复制而非链接，理由：目标是 npm 包安装目录，跨升级会变址」。
实测与权衡后改为**链接**：①用户明确要求「公共全局位置优先符号链接」；②复制会在数据目录
里再存一份内置资源，与该需求的去重初衷相悖；③变址问题由「启动时比对 `realpath`、不一致
就重铺」覆盖；④写入风险为零（落点是只读包内容，扫描缓存写在兄弟目录 `.weave-scans/`）。

### ☒ 批 3 —— init 供源切换（D9）·已并入批 1

- 改：`weave-templates/src/index.ts` 的 `getCommandsSourceDir/getAgentsSourceDir`
  → 仓内 `init/{commands,agents}`；`MANIFEST` 改为扫仓；`getSkillsSourceDir` 注释收口。
- 硬闸：`weave-cli/src/__tests__/executor.test.ts`、`helpers-gen.test.ts`
  与 init 相关用例（复制来源路径变化）；`init-no-overwrite` 语义零改。
- 新增：`<仓>/init/` 不被 `isToolkitPackDir` 命中的守卫用例（确认工具包列表仍是 8 个）。

### ☑ 批 4 —— 链接优先 + 形态暴露（D5）—— `afe2d06`

- 改：`harness/src/claude/plugins.ts` 的 `syncMarketplace` cp → `linkOrCopy`（同包引用）。
- 新增：`installForm(absPath)`（lstat 判定，只读、无新状态）并接到既有枚举端点。
- 硬闸：`harness/src/__tests__/plugins.test.ts`（假 exec 断言，链接形态不影响参数数组）
  —— 预期零改，执行核查；`install-link` 既有测试零改。
- 前置：H3 通过。

**实施记录（批 4 完成）**：

| 项 | 结果 |
|---|---|
| 原语上迁 | `weave-harness/src/shared/install-link.ts`（`linkOrCopy` / `removeInstalled` / 新增 `installForm`），经 `@weavecode/harness` 导出；server 的 `market/install-link.ts` 变**同名薄委托**，既有 2 个消费点零改；测试随原语迁 harness（git 识别为 R073 重命名）。 |
| 铺包改链接 | `syncMarketplace` 链接优先。**两处必须退回复制**：① 缺 CC 清单（要就地合成 manifest）；② 源带 `node_modules`/`.git`（复制会 filter 掉，链接会原样暴露）。 |
| 配套加固 | ① `syncMarketplace` 清旧目标：裸 `rm -rf` → `removeInstalled`；② `ensureMarketManifest` 对链接形态的市场目录直接返回（就地写清单会穿过链接写进包内；内置仓的清单随包发布，无需维护）。 |
| 形态暴露 | `installForm`（lstat 读侧判定、不落状态）→ `GlobalSkillEntry.form`，经既有 `GET /projects/:id/skills/global` 下发。两处构造点（个人组 / 插件组）同批补齐。 |
| 新增测试 | harness `install-link.test.ts` +2 例（`installForm` 三分支、用户手改后判定随之变）；`plugins.test.ts` +3 例（链接形态、带依赖树退回复制、**重装不删穿源**）。 |
| 硬闸 | 零改：`hooks-server` / `toolkit-*` / install-updater 全零改。显式修订组 1 条：`GlobalSkillEntry` 增字段。 |
| 门禁 | `build` / `build:web` 全 0；全仓 **105 文件 / 1123 测试全绿**。 |
| 实机 | `form` 已下发。**发现**：CC 插件所带技能全是 `copy`（CC 解引用后自行复制，weave 不可控）→ 已把「开发者模式提示」的作用域限定写进 D5。 |

### ☑ 批 5 —— UI：Skills 仓库维度三级折叠（D6）—— `bc1f914`

- 改：`SkillGrid.tsx`（L1 仓库块 + L2 包块 + L3 现有卡片；开关粒度按表）、
  `CategoryDetail.tsx`（skills tab 装配）、`lib/api.ts`（载荷加 `namespace`）、
  `i18n/dict/assets.ts`（成对新增词条）。
- 抽共享折叠原语**仅当**出现第三个调用点时（否则改现有文件内联）。
- 硬闸：`skill-stats` 零改；`dict.test` zh/en 成对；`install-capabilities.test` 零改。

**实施记录（批 5 完成）**：

| 项 | 结果 |
|---|---|
| L1 维度 | 由「来源（个人/插件）」改为**仓库 namespace**，由服务端经 harness 面拆键下发（`PluginSurface.parsePluginKey`，与 `pluginKey` 成对；`global-config.ts` 的裸 `split('@')` 同批收口）。codex 无 plugins 槽，其 namespace 就地取缓存路径的市场名。 |
| 三级结构 | L1 仓库块 → L2 插件包块（抽出 `PackBlock`）→ L3 技能卡片（原样）。个人组（无 namespace）并成一块「本地」，**L2 层省略**（直接铺卡片）。 |
| 默认态 | 市场块**默认折叠**（用户口径：「claude-plugins-official 插件市场折叠块（默认折叠）」）；「本地」例外默认展开——否则首屏是全折叠空壳。段头展开/折叠按钮同时覆盖两级。**注**：D6 原写「L1 默认展开」，此处按用户更明确的表述改为「市场块默认折叠」，仅「本地」展开。 |
| 顺带改动 | 全局技能行补 `agent`——「本地」把 claude/codex 两个 personal 组合并成一个扁平网格后，卡片靠它区分 runtime，也是网格内唯一 key 的来源。已核实抽屉只在**项目态**消费 `agent`（`SkillDetailDrawer` 的全局分支不读），行为零变。 |
| 新增 | `groupByRepo` 纯函数 + `SkillGrid.test.ts`（5 例）；i18n `namespaceTip` / `packCount` 成对。 |
| 硬闸 | 零改：项目态技能网格 / `skill-stats` / `file-tags` / `dict.test`。 |
| 门禁 | `build` / `build:web` 全 0；全仓 **106 文件 / 1134 测试全绿**。 |

### ☑ 批 6 —— UI：Plugins 仓库块 + weave 页合并 + 移除粘贴安装（D6/D7）
- 改：`ToolkitSection.tsx`（去「工具箱」标题、市场为一级、裸插件归一类、形态徽标）、
  `PluginAssetsPanel.tsx`、`HooksPanel.tsx`（插件区与规则编辑合并、裸规则归「本地规则」）、
  `HooksPluginsSection.tsx`（**删 :188-211 粘贴安装输入** + `installSrc`/`install()`）、
  `LibraryPanel.tsx` 插件区（与新归属对齐）、`dict/hooks.ts` + `dict/toolkit.ts`（成对词条）。
- 链接/副本徽标 + 开发者模式提示（D5 文案准确性要求）。
- 硬闸：`hooks-server.test.ts`（API 向后兼容，唯一受影响的是 `POST /hooks/plugins` 失去
  前端调用方 —— **端点保留**，只撤 UI 入口）。

**实施记录（批 6 完成）**：

| 项 | 结果 |
|---|---|
| 一级维度抽取 | L1 分组从 `SkillGrid` 抽到 `web/src/lib/repo-groups.ts`（`groupByRepo` / `toggleIn` / `LOCAL_REPO_KEY`）——Skills 与 Plugins 讲同一个维度，两份实现必然漂移。`SkillGrid.test.ts` 随实现迁为 `lib/__tests__/repo-groups.test.ts`（+`toggleIn` 用例）。 |
| Plugins 三级 | `ToolkitSection`：L1 仓库 namespace（内置仓显示为 `weave` + 「内置」徽标）→ L2 scope 文件夹（父级文件夹作汇总单位）→ L3 包行。**默认全展开**（包行本身是可操作面，藏起来反而要点两下）+ 「全部展开/折叠」。移除「工具箱」总标题与「Claude Plugins / 表面工具包」成分分组（那切法看不出包属于哪个市场）；无市场归属的包（裸插件/手加目录）并成一块「本地」。codex 运行态隐藏 CC 包的旧过滤原样保留。 |
| namespace 供给 | `ToolkitPackInfo.namespace` = `marketIdOf(pack.dir)`（内置落地在 `market/weave/` → 天然 `weave`，与市场列表的仓库行同名）；web 只读字段，不解析路径。 |
| 装面形态徽标 | 只出现在 **weave 决定得了形态** 的地方：全局个人技能行（`~/.claude/skills`、`~/.agents/skills`）标「链接/副本」，「本地」块头带一行图例与提示。文案按 D5 的准确性要求写：目录链接在 Windows 走 junction、**通常无需**开发者模式，只有链接创建被环境禁用时才提开发者模式；CC 自有 `plugins/cache/**` 的副本（H3 实测全为 copy）不标——那是 CC 解引用后自己复制的。 |
| weave 页合并 | 插件卡 + 规则列表卡合并为「插件与规则」一块：块内先「本地规则」（`plugin_id` 空的裸规则——新建的规则都落这里），后按插件包成块，**每块的规则就在该块内**（可折叠、默认展开，无规则的插件不给折叠头）。画布卡保留（它是数据流可视化，不是重复编辑面）。 |
| 移除粘贴安装 | `HooksPluginsSection` 删 :188-211 输入框 + `installSrc` / `install()` / `installing` 与 5 条词条；新增 `renderRules(plugin)` 插槽（规则 JSX 与增删改交互留在 HooksPanel，它已持有表单与编辑态）。**`POST /hooks/plugins` 端点保留**（硬闸）。 |
| i18n | 新增 `repo.*`（共享一级维度）、`hooks.pluginsAndRules` / `hooks.localRules` / `hooks.plugins.expand,│collapse`、`toolkit.scopeRoot` / `toolkit.expandAll*`；删 `toolkit.title` / `toolkit.groupClaude` / `toolkit.groupPacks` / `toolkit.claudeGroupHint`、`hooks.rulesTitle` / `hooks.plugins.title`、`hooks.plugins.install*`。`library.*` 与 `platform` 文案里的「资源管理 · 工具箱」改「资源管理 ▸ Plugins」。`dict.test` zh/en 成对。 |
| 副作用修复 | 门禁逼出一处**写穿链接**：`importLibraryIntoMarket` 对已在市场内的库补清单时，若该库是内置仓（落点 = 指向包内容的链接）会把 `.weave-market.json` **写进 `packages/weave-templates/src/resources/weave-market/`**（实测已在包目录里留下一份，已清除）。同批加拒入 + 回归用例（D2「写入风险为零」的前提由此闭合）。 |
| 硬闸 | 零改：`hooks-server` / `toolkit-scan` / `install-capabilities` / `skill-stats` / `file-tags` / 项目态技能网格。显式修订组 2 条：`toolkit-toggle.test.ts` 闸⑤ 的 strip 集合加 `namespace`（与 `key` 同源，随来源而异）；`market-roots.test.ts` 补 `namespace` 断言 + 新增「内置仓落地后 namespace = weave」用例。 |
| 门禁 | `pnpm build` / `pnpm build:web` 全 0；全仓 **106 文件 / 1122 测试全绿**。 |
| 协作事故 | 本批与并行会话共用一个工作区：我用 `git update-index --cacheinfo` 只想暂存 api.ts 的**单个 hunk**，却覆盖了并行会话刚暂存的同文件条目 → 其 `ef1eebb`（移除 daemon token 鉴权）的 api.ts 那 4 行被我的 hunk 顶替、token 移除随之回退。已在 00c591f 一并恢复。**教训：共享工作区不做索引级操作**（对方 `git commit` 提交的是整个索引）。 |

### ☑ 批 7 —— Files 合并视图 namespace 标记 + 右栏口径对齐（D8）
- 改：`lib/file-tags.ts`（namespace tag）、`FileAssetTree.tsx`、`server.ts` 的
  `/assets`+`/global-file-assets`（补 `namespace`）、`LibraryPanel.tsx`（右栏口径与新
  仓库维度对齐；用户已定 **保留右栏面板**）。
- 硬闸：`global-file-assets.test:49-53` 零改；`file-tags.test` 按新增 tag 同批补。

**实施记录（批 7 完成）**：

| 项 | 结果 |
|---|---|
| 归属判据（全局） | `installedPluginNamespaces(home)`（`install/global-config.ts` 新增导出）：从宿主安装记录 `installed_plugins.json` 的 `installPath` + `parsePluginKey` 取「目录 → 市场」，`listGlobalFileAssets` 按**最长前缀**给命中文件挂 `namespace`。**不猜缓存目录形状**（`cache/<market>/<plugin>/<version>` 是 CC 的实现细节）——装了哪些版本、装在哪儿全随记录走。 |
| 归属判据（项目） | `projectFileNamespaces(projectPath)`（`hooks/toolkit.ts` 新增导出）：落盘记录 `.weave/toolkit/<id>.json` 是唯一能回答「谁铺的」的事实（记录里有 `sourceDir`，市场身份经 `marketIdOf`）。`/assets` 据此给命中文件挂 `namespace`。 |
| 无仓库可归的 | 用户自己写的文件、init 铺的文件（不在记录内）、手加目录的包（`marketIdOf` = undefined）——**不打标记**（而不是统统标「本地」：Files 里的标记语义是「哪个仓库铺的」，没有就不标）。 |
| 前端标记 | `lib/file-tags.ts` 新增 `NAMESPACE_TAG`：与类别 tag 同壳但换描边（`border-neutral-700` + 透明底）——类别是固定词表（彩字），namespace 是**数据**（仓库名），它不进 `BUCKET_ORDER`、不进 chips 计数、不吃 `KIND_COLORS`。`FileAssetTree` 行内排在类别 tag 之后，tooltip 复用 `repo.namespaceTip`。 |
| 右栏口径对齐 | `marketItem` 载荷补 `builtin` / `namespace`（`namespace` = `marketIdOf(row.path, marketDir)`，内置仓 = `weave` —— 与左侧那一级块同名）；`MarketItem.source` 增 `'builtin'` 值。右栏内置仓行：徽标由「外部源」改「内置」（同 `toolkit.prov.builtin` 文案与配色）、**不摆「迁入市场」与删除按钮**（服务端对此恒 409 / 拒绝，落点还是指向包内容的链接）、行名 tooltip 指向 `repo.namespaceTip` 说明它就是左侧那个块名。 |
| 硬闸 | 零改：`hooks-server` / `toolkit-scan` / `/market` 路由语义 / `AssetEntry` 既有字段。`global-file-assets.test` 的既有断言（含 mods 判定、symlink 判定）逐条未动；只把夹具 `installed_plugins.json` 由 `{}` 换成真实安装记录（原用例只断言该文件存在且 category=plugin，故不受影响）+ 新增一条 namespace 用例。 |
| 门禁 | `pnpm build` 全 0；全仓 **107 文件 / 1133 测试全绿**（含并行会话新增的 `terminal-counts-refresher.test` 6 例）。`pnpm build:web` 的 `tsc` 只报 `web/src/App.tsx:726/730 refreshTerminalCounts` 未定义 —— **并行会话的未完成改动**（`M App.tsx`，非本批文件），本批 web 文件单独 `tsc --noEmit` 无错。 |
| 协作约束 | `daemon/server.ts` 同时承载并行会话的 WIP（`dataBus` / `terminalRefresher` / `readTerminalCounts`）与批 7 的两处 hunk（`/assets` 装饰、`marketItem`）。本批**不提交该文件**（提交它会连带未完成的实现，且它 import 的两个新模块仍未跟踪）；其 hunk 留在工作区，随对方提交落地。 |

### ☑ 批 8 —— 收尾
- `README.md`（根 + `weave-server`）写「改内置 = 改 `resources/weave-market/`」的入口说明。
- `.claude/plans/` → `docs/plan/`（本方案归档），执行状态回写。

**实施记录（批 8 完成）**：

| 项 | 结果 |
|---|---|
| 根 `README.md` | 新增 `## Built-in resources`：画出仓的布局（`.claude-plugin/marketplace.json` + `plugins/<scope>/<pack>` + `rules/<pack>` + `init/{commands,agents}`），写明落点 `<configDir>/weave/market/weave/` 是**指向该目录的链接**、所以「改内置 = 改那个目录」；并声明内置仓不可迁入/删除/查更新，外部仓走资源市场、以自己的 namespace 块并列。 |
| `packages/weave-server/README.md` | 新增 `## Built-in resources` 段（daemon 视角：启动按 `@weavecode/templates` 的 `resources/weave-market/` 落地并当内置市场扫描），指向根 README 那一节。 |
| 归档口径 | 方案与验证记录的**规范副本在 `docs/plan/`（随仓跟踪、已提交）**；`.claude/plans/` 只留本地草稿副本（`.claude/.gitignore` 内、不入库），不再是事实源。 |
| 执行状态 | 批 0 ☑（H1 **不成立**：win32 下 `lstat(junction).isSymbolicLink()` 为 true，`removeInstalled` 走 unlink，无删穿风险，故无前置修复批；产物 = `docs/plan/builtin-market-verification.md`）；批 3 并入批 1（☒）；批 1/2/4/5/6/7/8 全 ☑。 |
| 遗留（不属本方案范围） | ① `daemon/server.ts` 里批 7 的两处 hunk 尚未提交（该文件正被并行会话的 WIP 占用，见批 7 记录）——**已随并行会话的 `4e36f14` 落库**；② 早期 `weave init` 过的项目仍跑旧 HTTP hook 脚本（`.claude/helpers/hook-handler.cjs` 只由 init 刷新）→ 需在那些项目重跑 `weave init`；启动时的陈旧脚本检测尚未做。 |
| 遗留（批 7 未闭合的接缝） | SSE 的 `asset` 实时帧不带 `namespace`（watcher 不知道文件是谁铺的），而 web 收到帧是**就地打补丁**（`App.tsx` 的 `subscribeSse` 回调自建 `AssetEntry`）→ 在编辑器里改一个属于某仓库的文件时，那一行的仓库标记会消失到下次 `/assets` 全量刷新；走 UI 的安装/卸载不受影响（handler 里已有 `refreshAssets`）。修法二选一：① 帧上补 `namespace`（`handleSse` 的 asset 订阅里按帧查一次 `projectFileNamespaces(projectPath)`，注意写帧顺序）；② 前端保留旧条目的 `namespace` + 新文件触发一次去抖 `refreshAssets`。**已转交 SSE/终端工作线的并行会话**（该文件是它的当前改动面），谁先动谁做。 |

---

## 状态总览（全部完成）

| 批 | 内容 | 状态 |
|---|---|---|
| 0 | H1–H5 前置验证（H1 不成立，无修复批） | ☑ |
| 1 | 内置仓成立：搬迁 + 重指内置根（含批 3 的 init 供源切换） | ☑ `9691518` |
| 2 | 落地 `<dataDir>/market/weave/` + 扫描源切换 | ☑ `4100282` |
| 4 | 链接优先 + 装面形态暴露（原语上迁 harness） | ☑ `afe2d06` |
| 5 | UI：Skills 仓库维度三级折叠 | ☑ `bc1f914` |
| 6 | UI：Plugins 仓库块 + weave 页插件/规则合并 + 移除粘贴安装 | ☑ `00c591f` `60ee9bd` |
| 7 | Files 合并视图 namespace 标记 + 右栏内置仓口径对齐 | ☑ `d298658` |
| 8 | README 入口说明 + 归档与状态回写 | ☑ |

---

## 第四章 风险清单

- **R1（最高，既有）** junction 卸载删穿源目录：H1，独立修复批先于一切。
- **R2 内置仓双重扫描**：`marketLibraryRoots` 与 `discoverToolkitSources` 同时命中
  `<dataDir>/market/weave` → 重复包/重复开关。单点排除 + 专项测试。
- **R3 键形与 id 漂移**：搬仓极易顺手改 id/name，而坐键 `name@weave` 是 UI 与测试的锚。
  以「键与 id 零变」为批 2 硬闸。
- **R4 web 解析 `@`**：三级折叠的诱惑就是前端 split。以 D4 的 surface 方法堵死，
  并顺带修掉服务端 `global-config.ts:297` 的裸 split。
- **R5 i18n 词条量**：删「粘贴安装」3 条 + 新增仓库/层级/形态约 10-15 条，zh/en 同批同 commit。
- **R6 用户文件误删**：toolkit disable 按 sha256 记录删；init 复制的文件不在记录内
  （D9 定死），须有回归用例。
- **R7 共享文件热点**：`daemon/server.ts`（批 2/7）、`LibraryPanel.tsx`（批 6/7）、
  `dict/hooks.ts`（批 6）——每批门禁后即提交。
- **R8 链接形态文案失准**：目录 junction 免特权、文件符号链接才需开发者模式；
  文案若笼统说「需开发者模式」会误伤。写入批 6 验收项。
- **R9 右栏矛盾未决**：批 7 的形态取决于用户最终口径；前 6 批不受影响（已缓解）。

---

## 第五章 门禁与验收纪律

1. 每批：实现 → 三门禁全 0 → 中文 commit（写本批硬闸：零改/修订条数及理由）→ 下一批。
2. 修订组测试与被修订实现**同批同 commit**，不留跨批中间态。
3. **批 0 的 H1 若命中，其修复先于批 1**，并单独声明（既有数据丢失风险）。
4. 人工走查（非门禁）：批 5 三级折叠默认态与数据异步到达后不丢展开项；批 6 徽标
   链接/副本双形态 + 粘贴安装入口确已消失 + 规则随包成块；批 7 Files 的 namespace 标记。
5. 每批结束在标题前勾 ☑。

## 附录 — 现状行号锚点

- 右栏市场面板：`App.tsx:1087-1111`；标题 `dict/library.ts:50`；导入入口
  `LibraryPanel.tsx:448-461`（目录选择器）、`:462+`（git URL）；折叠原语
  `LibraryPanel.tsx:1189-1237`；展开集先例 `:340-341`。
- weave 页三块：`HooksPanel.tsx:622-634`（插件卡）、`:637-686`（画布）、
  `:688-954`（表单）、`:957-1066`（规则列表）；粘贴安装 `HooksPluginsSection.tsx:188-211`；
  三处重复渲染的过滤注释 `ToolkitSection.tsx:200-203`、`PluginAssetsPanel.tsx:6-9`。
- 内置资源现状：`weave-templates/src/index.ts:15-27`（MANIFEST）、`:67-85`（源目录）；
  `weave-server/src/hooks/presets/**`；`toolkit-scan.ts:69-73`（`builtinToolkitRoot`）、
  `:264-266`（`discoverToolkitSources`）；`copy-presets.mjs`、`copy-templates.mjs`。
- 市场身份与键：`market/identity.ts:12-17`（`marketIdOf`）、`market/manifest.ts:6-24`、
  `market/resolve.ts:13-49`（`resolveLibraryPath`/`toRelPosix`/`marketLibraryRoots`）；
  `harness/src/claude/plugins.ts:26,152-154`（`pluginKey`）、`:221-274`（`syncMarketplace`）。
- 链接：`weave-server/src/market/install-link.ts:11-43`（`linkOrCopy`/`removeInstalled`，
  **批 4 上迁 harness `src/shared/install-link.ts`**）；调用点
  `install/global-config.ts:208-230`（server，保薄委托后零改）与
  `harness/src/claude/plugins.ts:221-274`（`syncMarketplace`，批 4 改为链接）。
- 装配双入口：`daemon/start.ts`、`daemon/dev-entry.ts`；既有单点范例
  `daemon/hook-pipeline.ts` 的 `wireHookFilePipeline` + 结构守卫
  `daemon/__tests__/hook-pipeline-wiring.test.ts`。
- 服务端解析键形（待收口）：`install/global-config.ts:297` `key.split('@')[0]`。
