# 跨 harness 统一插件机制设计（CROSS-HARNESS-DESIGN）

> 本文档是 weave 从「Claude Code harness 注入工具」演进为**多 harness 工具控制平面**
> 的架构设计与实施批次划分。**它是演进方案，不是规范**——插件规范唯一权威仍是
> `docs/PLUGIN-SPEC.md`（本设计对其的修改随实施批次同步）；外部机制借鉴依据见
> `docs/PLUGIN-RESEARCH.md`。
>
> 当前状态：**设计已定稿，代码未实施**（批次序列见 §5，启动由用户确认）。

## 1. 关系定位与三段式现状

### 1.1 定位

**weave 是多 harness 工具的控制平面（元层）**：不替代、不 fork 任何 harness——
**生成侧**产出各 harness 的原生表面（`.claude/`、`.codex/`、指令文件），**运行侧**
以统一规则模型消费各 harness 的事件流；对用户向上提供统一的可视化、启停与分发。

### 1.2 三段式现状

| 段 | 成熟度 | 关键事实 |
|---|---|---|
| **生成侧**（`weave-cli/src/init`） | Claude 专属 | `executor.ts` 目录树只有 `.claude/`；`settings-gen`/`helpers-gen` 硬编码（`source:'claude'`、`CLAUDE_PROJECT_DIR`、marker `.claude/helpers/...`）；唯一双分叉 = `instruction-link.ts`（CLAUDE.md/AGENTS.md 单文件+软链） |
| **资产层**（install / watch / 可视化） | **已双 harness** | `'claude'|'codex'` 贯穿 skills/MCP/插件 enable 态；`GlobalSkillSource` 已是「harness×来源」二维抽象；缺口：`FILE_ASSET_SPECS.codexUserDir` 字段在值全空、`weave scan` marker 只认 `.weave|.claude` |
| **hooks 运行时**（D3/D3.1） | 接口留缝、只装 Claude | `HookAdapter.source` 已带双值，`server.ts` 按 `report.source` 分派 adapter（缝已开）；但只注册 `ClaudeCodeAdapter`，规则模型/插件校验/match 全部写死 Claude |

**结构性税**：全仓无 `Harness` 共享类型——`'claude'|'codex'` 手写重复 ≥14 处
（server 侧 11 处 + web `api.ts`/`CategoryDetail.tsx` 手抄镜像，因 web 不能 import
含 `node:fs` 的包）。

**已存在但空转的缝**（本设计的直接受益点）：

| 缝 | 现状 |
|---|---|
| `hook_events.source` 列 | 已入库、已透出 API，dispatcher/match/UI 零消费 |
| `projects.meta` 列 | 类型已声明，全仓零读写 |
| `FILE_ASSET_SPECS.codexUserDir` | 字段存在，五类资产全未赋值 |
| `HookRuleSourceSchema.kind='webhook'` | schema 占位，registry 直接跳过永不匹配 |
| web `SOURCE_STYLES.codex` 配色 | 已写好，无引用 |

### 1.3 与四方的关系

| 对象 | 关系 |
|---|---|
| **Claude Code** | weave 是其插件生态之上的安装/编排层：生成 `.claude/` 原生表面、消费其 hooks 同步注入通道；不 fork、不替代其 hooks 引擎。 |
| **Codex** | weave 是其配置面（`config.toml` / `AGENTS.md` / `.codex/`）的对等管理面；事件体系经独立 adapter 接入同一分发链（**一期目标**）。 |
| **dsh** | 只借设计不抄架构：安装状态机（`ChangeResult`）、版本门（peer import 前拦截+精确豁免）、provenance 统一（见 `PLUGIN-RESEARCH.md` §5）；不抄 Cordis 插件树与 4 层 patch 模型。 |
| **ruflo** | 理念来源（聚焦 harness 层）；weave 明确不做 agent 编排平台。 |

**已决策的范围**：通用 Harness 抽象，**一期只接通 Claude+Codex**；未来加
dsh/gemini 等只需新增 adapter 与事件注册表条目。

---

## 2. 核心抽象

### 2.1 `Harness` 类型下沉

新文件 `packages/weave-core/src/harness.ts`——**纯类型 + 纯常量，零 `node:*`、零
zod**，经 `package.json` 新增 subpath export `@weave/core/harness` 暴露给 web
（主入口 re-export `platform.ts`/`utils/fs.ts` 含 node 依赖，web 不能 import——
subpath 是最小手术）。主入口继续 re-export，全仓存量 import 路径不变。

```ts
export type Harness = 'claude' | 'codex';   // 一期闭合联合；加 harness = 加一项

export const HARNESS_EVENTS: Record<Harness, readonly string[]> = {
  claude: [/* 现 CLAUDE_HOOK_EVENTS 七事件迁入 */],
  codex:  [/* 11+ 事件，批 2 B0 调研锁定（BACKLOG §10-6） */],
};

/** inject（同步 additionalContext）白名单——按 harness 分表 */
export const INJECTABLE_EVENTS: Record<Harness, readonly string[]> = {
  claude: [/* 现 INJECTABLE_HOOK_EVENTS 迁入 */],
  codex:  [],   // 待调研 Codex 同步注入通道；无则永久为空
};

/** 落盘表面映射：模板/资产按 target 分流的单一事实源 */
export const HARNESS_DIRS: Record<Harness, { projectDir: string; userDir: string }> = {
  claude: { projectDir: '.claude', userDir: '.claude' },
  codex:  { projectDir: '.codex',  userDir: '.codex' },
};
```

≥14 处手写 `'claude'|'codex'` 统一为 `import type { Harness } from '@weave/core/harness'`；
存量别名（`InstallAgent`、`AssetAgent` 等）保留为 `type X = Harness` 兼容层，不强行改名。

### 2.2 事件面注册表：按 harness 声明 + PascalCase 规范名

- **不做并集大表**（会让 Codex 不支持的事件出现在白名单，凭空造出非法规则）；
- **不用交集**（会砍掉 Codex 独有事件 Interrupt/PreCompact/PermissionRequest，丧失接入价值）；
- **规范名约定**：两边事件名同为 PascalCase 且高度重合，统一用 Claude 风格作规范名；
  事件名/payload 差异由 adapter 归一吸收，dispatcher 只见规范名；
- 一切按 harness 的校验（inject 白名单、requires.events、规则匹配）都查
  `Record<Harness, …>` 表，**不存在全局事件数组**。`CLAUDE_HOOK_EVENTS` /
  `INJECTABLE_HOOK_EVENTS` 保留为 `HARNESS_EVENTS.claude` / `INJECTABLE_EVENTS.claude`
  的兼容 re-export。

### 2.3 规则模型泛化（方案 b：`source.kind` → `hook-event` + `harness`）

```ts
HookRuleSourceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('hook-event'),
    harness: z.enum(['claude', 'codex', 'any']),
    event: z.string().min(1),
  }),
  z.object({ kind: z.literal('webhook'), routeId: z.string().min(1) }),
  // 读兼容：存量 hook_rules.source 里的 'claude-event'，仅读侧 normalize 消化
  z.object({ kind: z.literal('claude-event'), event: z.string().min(1) }),
]);
```

**各落点**：

| 位置 | 改动 |
|---|---|
| `registry.ts` `load()` | 读侧把 `claude-event` normalize 为 `hook-event{harness:'claude'}`（内存层转换，下次 update 落新形，**不写数据迁移脚本**）；索引键**保持 event 单键**（`candidates(event)` 签名不变，bucket 内规则自带 harness） |
| `dispatcher.ts` `match()` | 首行新增：`kind==='hook-event' && harness!=='any' && harness!==ctx.source → false` |
| `IngestContext`（dispatcher.ts:22-28） | 新增 `source: Harness`——`server.ts` 调 `onIngest` 时把 `input.source` 传入（修掉现况丢 source 的缝） |
| `filter` | **不加 harness 字段**——harness 是规则的「来源面」属性而非过滤条件，长在 `source` 上语义才自洽；filter 保持 toolNames/pathGlobs/crossProjectOnly 三维 |
| `validateHandler`（registry.ts:91-108） | `inject` 要求 `kind==='hook-event'` **且 harness 为具体值（拒绝 `'any'`**——两 harness 注入通道不同，白名单必须按 harness 查）；白名单查 `INJECTABLE_EVENTS[source.harness]`；`plugin` handler 要求 `kind==='hook-event'`（'any' 允许） |
| web | `HandlerConfig` 补 `plugin` 分支、规则表单暴露 harness 选择、事件下拉按 harness 过滤 |

`harness:'any'` 是一等能力：跨 harness 同名规则只写一条（如「所有 PostToolUse 里
md 改动都记日志」）。

**弃 (a)（filter 加 harness、kind 仍叫 claude-event）**：kind 名不副实是语义谎言，
validateHandler/plugin-loader/索引注释全要为「名不副实的 kind」打补丁；改动量与
(b) 相同。**弃 (c)（索引复合键 `harness:event`）**：强制规则归属单一 harness，
`'any'` 无处安放；改 `candidates()` 签名波及全部单测；性能收益在百级规则量下无意义。

**代价（如实）**：① schema 永久携带 legacy 分支（或定移除窗口）；② `'any'` 依赖
「规范名跨 harness 同义」——`toolNames/pathGlobs` 这类结构 filter 在 Codex 上可能
失配，须写入规则作者文档；③ 建规则的表单/CLI 要暴露 harness 选择。

### 2.4 manifest 扩展

| 字段 | 决策 | 理由 |
|---|---|---|
| `targets?: Harness[]` | **默认 `['claude']`** | fail-safe：存量插件全是 Claude 语义，默认全含会静默把旧插件规则打到 Codex 会话（事件同名即命中）。显式 `targets: ['claude','codex']` 才跨 harness。代价 = 跨 harness 插件多写一行 |
| `requires.events` 校验 | 改为 `events ⊆ ∪(HARNESS_EVENTS[t])`（t ∈ targets） | 事件用规范名，不必按 harness 分组声明；并集校验 = 每个事件至少被一个 target 支持，否则整插件 rejected（现行为不变）。`subscribe.events` 同改 |
| 规则的 `source.harness` 缺省 | 加载时补齐：未写 → `targets.length===1 ? targets[0] : 'any'` | 规则作者不必重复 manifest 信息；显式写了以规则为准 |
| `templates` 按 target 分流 | 结构不变，落盘按 targets 映射到 `HARNESS_DIRS`；codex agents 转换器就绪前 **skip + warn，不 fail** | 与能力 C 的转换器批次解耦；两处消费（`executor.ts` Step 6b、`plugin-templates.ts`）共用同一分流 helper，避免第三处硬编码 |
| `config` 类型化 userConfig | **可选批 5**，不阻塞主线 | 按 `PLUGIN-RESEARCH.md` §5.1（type/default/enum/required → 加载校验 + dashboard 自动表单），独立可弃 |

### 2.5 provenance 统一

插件身份统一为 **`<id>@<source>`**（`builtin | global-dir | project-dir | inline |
git | npm`），替代「origin 枚举 + installed.json 附带信息」的分裂表达。落点：
`plugin-loader.ts` 的插件状态结构、`plugin-installer.ts` installed.json、CLI
`weave plugins list` 与 dashboard 徽标同源渲染。

**三正交原则**（全文反复引用的设计约束）：

> **provenance 管「从哪来」，targets 管「给谁用」，规则 harness 管「匹配谁」——三者互不混用。**

---

## 3. 四能力设计

### 能力 A：跨 harness 插件包改造（批 1，无前置）

**目标**：插件从「Claude 专属规则包」升级为「声明 targets 的跨 harness 包」。

**文件级改动**：

| 文件 | 改动 |
|---|---|
| `weave-core/src/harness.ts`（新）+ `package.json` | Harness 类型、事件注册表、subpath export |
| `weave-core/src/types.ts` | `HookRuleSourceSchema` 泛化、manifest `targets`、兼容 re-export |
| `weave-server/src/hooks/registry.ts` | 读侧 normalize、validateHandler 按 harness 白名单 |
| `weave-server/src/hooks/dispatcher.ts` | `IngestContext.source`、match 首行 harness 过滤 |
| `weave-server/src/daemon/server.ts` | `onIngest` 传 `input.source` |
| `weave-server/src/hooks/plugin-loader.ts` | targets 展开、requires/subscribe 并集校验、规则 source 补齐、provenance 字段 |
| `weave-cli/src/init/plugin-templates.ts` + `executor.ts` Step 6b | target 分流（共用 helper） |
| `weave-web/src/lib/api.ts` + 规则表单 + `CategoryDetail.tsx` | Harness import、HandlerConfig plugin 分支、source 编辑 |
| `docs/PLUGIN-SPEC.md` | **随批同步（硬性交付）** |

**复用**：HookAdapter 已开的 source 分派缝、chokidar 热重载、`plugin_states` 级联启停、`writeFileIfAbsent` 语义。

### 能力 B：外部 hook 与跨项目 harness 交互（批 2，依赖 A，**B0 调研硬闸门**）

**目标**：Codex 事件流入同一 ingest→match→dispatch 链；dispatch/session 归因 harness+项目；resume 按 harness 分派；web 投送目标统一。

- **B0 前置调研**：Codex hooks 实际接入形态——投递方式（stdin/shell/config.toml）、
  payload 结构、是否需要 Codex 侧 forwarder（对标 `.claude/helpers/hook-handler.cjs`）。
  **锁 schema 才开 B 主批**（BACKLOG §2「等 schema 稳定」原则；§10-6 提示
  「11+ 事件体系存在」的调研使该前提可能已过时，故调研本身立即可做）。
- `weave-server/src/hooks/codex-adapter.ts`（新）实现既有 `HookAdapter`；
  `daemon/start.ts`、`dev-entry.ts` 注册双 adapter（`server.ts:194-198` 按 source 分派已就绪）。
- DB 三列（见 §4）：`sessions.harness`、`hook_dispatches.harness/project_id`。
- `resume-runner.ts`：硬绑 `claudeBin` 改为命令表
  `HARNESS_RESUME: Record<Harness, { bin, args(sessionId, prompt) }>`
  （claude: `claude --resume <id> -p <prompt>`；codex 等价物待 B0——**无 resume 等价物则
  codex dispatch 降级「仅复制投送」**，runner 返回明确 501 语义、UI 标注，不静默失败）。
- web：投送目标统一为「dispatch/session 自带的 project+harness」，消除 HooksPanel
  （全量会话）与 TasksPanel（锁单项目）的语义分裂；`hook_events.source` 消费闭环
  （事件流按 harness 筛选/徽标，接上 `SOURCE_STYLES.codex`）。
- `weave scan` marker 扩展认 `.codex`（codex-only 项目可注册）。

**复用**：HookAdapter 接口、`sessions.listWithCounts()`（可不传 projectId）、
`crossProjectOnly` filter（语义不变）、`hook_events.source` 已有列。

### 能力 C：agent 统一管理（批 3，依赖 A）

**目标**：agents 双 harness（Claude `.md` / Codex `.toml`）、插件模板生命周期定型、`weave add/remove` 落地。

- `weave-templates/src/index.ts`：`TemplateEntry` 加 `targets: Harness[]`——
  skills `['claude','codex']`、commands `['claude']`（Codex prompts 面已删，BACKLOG §8 结案）、
  agents `['claude','codex']`；插件模板缺省 `['claude']`。
- `install/file-assets.ts`：`agent` spec 补 codex 项目/用户面（对称 `codexUserDir`）；
  「Codex per-project surface is skills-only」的文件头注释前提被 BACKLOG §10-3 修正，同步改。
- **`.md → .toml` 转换器**：新 `install/agent-convert.ts`，以官方转换器语义为参照，
  **复用 `install/codex-toml.ts` 行级增量编辑器**落盘；`.claude/agents/*.md` 源 →
  `.codex/agents/*.toml` 目标。
- **`weave add/remove` 命令**（`weave-cli/src/commands/{add,remove}.ts`，注册进
  `cli.ts`）：查 TemplateEntry（带 targets）→ 按 target 经 `fileAssetTargetDir` 解析
  → 落盘；remove 用 checksum / `@version weave@` 标记区分用户改写。与 HTTP install
  通道共用 file-assets 解析层，**不新建第三套落盘逻辑**。
- **插件模板生命周期决策 = 保持「安装时刻拷贝」，不做 daemon 持续下发**：
  与 weave「落盘即拥有、标记清扫、用户可改」的资产哲学一致；同步 = 三通道显式刷新
  （init 拷贝 / `weave plugins install` 重装 / `weave add` 按需补拷），用户修改由
  checksum 保护。代价（写明为产品语义）：插件更新后模板不自动同步。

**复用**：扩展点③动态注册（register/getPluginEntries）、instruction-link 成对文件范式、codex-toml 增量编辑器、`codexUserDir` 字段位。

### 能力 D：统一工具链管理（批 4，依赖 B、C，可与 C 部分并行）

**目标**：项目级 harness 能力清单 + 跨项目聚合视图 + 按 harness 启停（类 Claude plugin 机制的管理面）。

- **`projects.meta` 写入时机**（现零读写）：init/scan 注册时探测写入
  `{ harnesses: Harness[], detectedAt, capabilities }`（探 `.claude/`、`.codex/`、
  CLAUDE.md/AGENTS.md 存在性；capabilities 记 hooks 组 marker/helpers/statusline/skills 面）；
  watch 事件时低成本重估（目录存在性检查）。
- **inventory API**：新 `GET /inventory` 聚合 项目 × harness × 资产类别 × 插件启用态，
  复用 `GlobalSkillSource` 四分组、Codex plugins enable 读取（`global-config.ts:541-622`）、
  `FILE_ASSET_SPECS` 表。
- **dashboard 视图**：新增跨项目「总览」视图（行 = 项目，列 = harness 徽标 × 资产计数 × 插件数）；
  **六分类卡保持不动**（维度是资产类别，与 harness 正交）；`RuntimeTab` 二级 tab 复用。
- **按 harness 启停（一期边界写死）**：项目级 `meta.disabledHarnesss`（meta JSON 内，
  不加列），作用 = weave 对该 harness 的**管理动作**（install/watch 同步/status 提示）
  静默跳过；**不回滚 harness 已注入物**（卸载走 remove）、不改 harness 自身配置；
  总闸不放 daemon settings（避免两级开关语义打架）。

---

## 4. 数据库与迁移

**约束**：无迁移基建——`SCHEMA` 的 `CREATE TABLE IF NOT EXISTS` 不给旧库补列；
延续 `PRAGMA table_info` 探测 + `ALTER TABLE ADD COLUMN` 兜底（既有先例
`migrateHookRulesColumns`；cdbc159 教训：**带新列的 `CREATE INDEX` 必须在补列之后**，
`cols.size === 0` 守卫表不存在的情形）。

**新增列集中清单**（实施时只允许在本节增删）：

| 表 | 列 | 类型 | 写入点与理由 |
|---|---|---|---|
| `sessions` | `harness` | `TEXT NOT NULL DEFAULT 'claude'` | 会话归属 harness；旧库回填正确（现状只有 ClaudeCodeAdapter，历史会话全是 claude） |
| `hook_dispatches` | `harness` | `TEXT NOT NULL DEFAULT 'claude'` | dispatcher insert 时写 `ctx.source`，冗余免 join |
| `hook_dispatches` | `project_id` | `INTEGER REFERENCES projects(id) ON DELETE SET NULL`，可空 | dispatcher insert 时写 `ctx.project.id`；跨项目聚合免经 session 三跳（session_id 本身可空） |

- **零加列项**：`hook_events.source`、`projects.meta`——已存在，从「空转」变「消费」。
- **JSON 列无迁移**：`hook_rules.source` 里的 `claude-event` 走 §2.3 读侧 normalize，
  不写 UPDATE；兼容窗口与移除条件随批 0 记入代码注释。
- **实施要求**：三处新列收敛进泛化的 `migrateColumns(db)`（现 `migrateHookRulesColumns`
  改名扩展），延续 PRAGMA 探测范式；新增列带索引则索引建在补列之后。
- **不加的列**（防膨胀）：`hook_rules` 不加 harness 列（长在 source JSON 内，随规则
  原子读写）；`hook_events` 不加 harness（source 即是）。

---

## 5. 实施批次序列（未启动）

依赖链：**`0 → 1 → {2, 3} → 4`**，批 5 独立可弃。每批铁律：
`pnpm build && pnpm build:web && pnpm test` 退出码全 0；中文提交
`<type>(<scope>): <description>`。

| 批 | 内容 | 触达面 | 批内硬闸 |
|---|---|---|---|
| **批 0 类型地基** | `harness.ts` 下沉 + subpath export；≥14 处换 `Harness`；`IngestContext.source` + match 首行过滤；规则 `hook-event` 泛化 + 读侧 normalize；validateHandler 按 harness 白名单；web HandlerConfig plugin 分支与 source 编辑 | weave-core、server hooks、daemon/server.ts、web ≈10–15 文件 | **存量 hook 规则测试零改动通过**（读兼容生效） |
| **批 1 能力 A** | manifest targets / requires·subscribe 并集校验 / 规则 source 补齐 / templates target 分流（共用 helper）/ provenance `<id>@<source>` / **PLUGIN-SPEC 同步** | plugin-loader、plugin-installer、plugin-templates、executor、SPEC、fixtures ≈8–12 文件 | fixtures/changelog-reminder 回归过；「声明 codex 但转换器未就绪 → skip+warn」有用例 |
| **批 2 能力 B** | **B0 调研先行** → codex-adapter、双 adapter 注册、DB 三列（`migrateColumns` 泛化）、resume 命令表分派、web 投送统一 + source 消费、scan marker 认 `.codex` | codex-adapter、start/dev-entry、db、resume-runner、hooks-routes、web ≈10–15 文件 | **B0 未锁 schema 不开主批**；codex 降级路径有用例；旧库补列幂等用例 |
| **批 3 能力 C** | TemplateEntry.targets、file-assets codex 面、md→toml 转换器、`weave add/remove`、插件模板三通道一致 | weave-templates、install、cli commands ≈8–10 文件 | 转换 round-trip 测试；remove checksum 不删用户改写 |
| **批 4 能力 D** | projects.meta 写入、`GET /inventory`、dashboard 总览视图、按 harness 启停、SOURCE_STYLES codex 消费 | repositories/projects、server、web 新视图 ≈8–10 文件 | meta 探测幂等；启停边界（不回滚已注入物）有用例 |
| **批 5（可选）A′** | manifest config 类型化 userConfig、loader 校验、dashboard 表单生成 | types、plugin-loader、web ≈5–8 文件 | schema 拒绝用例；无 schema 存量插件兼容 |

**空转缝随批清理**：web plugin 分支 → 批 0；`hook_events.source` 消费 → 批 2；
`FILE_ASSET_SPECS.codexUserDir` → 批 3；`projects.meta`、`SOURCE_STYLES` → 批 4。

---

## 6. 风险与开放问题

| # | 风险 | 处置 |
|---|---|---|
| 1 | **Codex hooks 实际接入面未锁**（BACKLOG §2「实验特性」与 §10-6「11+ 事件体系」冲突；事件存在 ≠ 可外接） | B0 调研硬闸门；本设计不承诺 B 主批时间 |
| 2 | Codex 是否有同步注入通道（Claude 的 `additionalContext` 是官方同步 hook 输出） | `INJECTABLE_EVENTS.codex` 可为空 → codex 规则只许 log/webhook/manual；`harness:'any'` 的 inject 被 validateHandler 拒绝正是前置防线 |
| 3 | resume 的 codex 等价物（`codex resume <id>` 是否存在/语义对等） | 待 B0；无则降级「仅复制投送」，API/UI 明确表达 |
| 4 | 规范名同名异义：`'any'` 规则跨 harness 命中依赖事件名同义 | payload 差异由 adapter 吸收；结构 filter（toolNames/pathGlobs）在 Codex 可能失配 → 写入规则作者文档 |
| 5 | web 类型镜像治理：subpath 需验证 vite 对 exports 条件的解析 | 本轮**只换 Harness 一族，不顺手全量下沉**（防范围蔓延）；其余镜像（BACKLOG §9.2）另案 |
| 6 | `DEFAULT 'claude'` 依赖「现库 source 全为 claude」的事实 | 写进 db.ts 迁移注释；语义争议时回退方案 = NULL=未知 |
| 7 | **插件模板「拷贝不同步」是产品决策** | 已定：保持拷贝 + 显式刷新（§3 能力 C），与资产哲学一致 |
| 8 | `targets` 默认 `['claude']`：跨 harness 插件作者易漏写，Codex 下静默不生效 | `weave plugins validate` 输出 targets 生效面（对齐 `PLUGIN-RESEARCH.md` §5 静态 uses 清单思路） |

---

## 附：关联文档

- `docs/PLUGIN-SPEC.md` —— 插件规范唯一权威（现状，未含本设计的 targets 等字段）
- `docs/PLUGIN-RESEARCH.md` —— dsh 与 Claude Code mods 对比研究（本设计的借鉴依据）
- `docs/BACKLOG.md` —— 双 harness 现状与高难度项（§2 Codex hooks、§10-3 Codex agents、§10-6 事件体系）
- `docs/FEATURES.md` —— 功能范围（D3 hooks、D3.1 插件系统、C3/C4 add/remove 规划）
