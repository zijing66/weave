# 新 harness 插件化接入：现状审计与收口计划

> 问题：**接入第三个 harness（非 claude/codex）时，是否完全不用改共用代码、纯插件化接入？**
>
> 结论：**当前不行**——四层都有违例，但根因高度集中，收口路径清晰。
>
> 本文档 = 现状审计（as-is，带 file:line 证据）+ 收口计划（开发合同）+ 验收清单。
> 与 `docs/CROSS-HARNESS-DESIGN.md` 互补：那份是**能力演进设计**（批 0–5，加什么能力），
> 本文是**harness 无关性收口**（去掉什么耦合，让加 harness 退化为加表行）。
>
> 审计方式：四个只读子agent 按层并行扫描（core+harness 装配根 / server / web / cli），
> 条目为**扫描所得、逐条在实施时复核**（见 §5 每阶段硬闸）。

---

## 1. 判定

| 层 | 零改动可行？ | 违例规模 | 一句话性质 |
|---|---|---|---|
| weave-core + harness 装配根 | ✗ | 3 真违例 + 4 扩表点 | `Harness` 闭合联合 + 3 份未派生的 `z.enum` |
| weave-server/src | ✗ | ~20 文件 / 40+ 调用点 | 二元枚举（响应桶 / 白名单 / 目录表） |
| weave-server/web/src | ✗ | 20+ 处 | 手写镜像联合 + **路径知识泄漏进前端** |
| weave-cli/src | ✗ | 6 文件 | 表面行 / 指令文件名 / 卸载白名单 / 文案 |

**最小面估计**：即使第三 harness 只走 detect + init + assets（像 codex 那样缺席
events/resume/plugins），仍需动约 15 个既有文件。

---

## 2. 根因（其余违例都是它的表现）

**根因一：`Harness` 是闭合二元联合。**
`packages/weave-core/src/harness.ts:10` `export type Harness = 'claude' | 'codex'`。
所有 `satisfies Record<Harness, …>` 的编译期催补建立在其上（这是**好机制**），
但 core 内还有 **3 处手写 `z.enum(['claude','codex'])` 不派生**——
`types.ts:52`（HookRuleSource）、`:252`（RuntimeConfig）、`:277`（InitOptions）——
编译器在这三处失明：新 harness 的规则 / 运行时配置 / `--harness` 全被 schema 静默挡掉。

**根因二：能力面机制本身干净，但只在「动态查表处」生效。**
`driver.ts` 六接口无 harness 知识泄漏（仅注释举例）；`assetSurfaceFor` /
`pluginSurfaceFor` / `harnesses.get` / `byCapability` 处对新 harness 天然透明；
codex 证明了**能力槽可缺席**（不声明 plugins 槽，被 400/501 显式拒绝而非静默兜底）。
但凡写死二元的地方（响应桶、白名单、目录枚举、来源枚举、路径判据），
新 harness 一律落 claude 兜底或被拒。

---

## 3. 判定标准（本计划的验收边界）

「**零改共用代码**」定义为：加第 N 个 harness 只允许两类改动——

1. **新增** `packages/weave-harness/src/<name>/` 目录（驱动实现，含按需缺席的槽）；
2. **纯声明行**（表 / 注册表，无逻辑）：
   - `weave-core/src/harness.ts` 的 harness 名表 +1
   - `weave-harness` 的 driver 表 +1
   - 上述两表已由 `satisfies` 保证漏加即编译失败

**不允许**：任何 server / web / cli / core 的**条件分支、白名单、桶、路径字面量**
因新 harness 而修改；任何 `z.enum` 手写字面量；任何前端路径/正则知识。

> 注：把「名表」本身也做成运行时发现（外部包可装 weave harness 驱动）是更远的
> 目标，属真正的外部插件化，**不在本计划**（见 §6 开放问题）。

---

## 4. 违例总表

分级：**A**=表驱动/注册扩一行即可（合法但需知晓）；**B**=能力面已覆盖（无需改）；
**C**=硬编码违例（接新 harness 必改，本计划的收口对象）。

### 4.1 core + harness 装配根

| 级别 | file:line | 问题 | 收口 |
|---|---|---|---|
| A | `weave-core/src/harness.ts:10,16,34,41,62` | `Harness` 联合 + `HARNESS_EVENTS`/`INJECTABLE_EVENTS`/`HARNESS_DIRS`/`HARNESS_LIFECYCLE` 四表 | 保留（`satisfies` 已保证漏加报错）；名表收敛为单一数组并派生联合 |
| A | `weave-harness/src/registry-wiring.ts:11-12` | 逐 id 硬编码 `register(CLAUDE_DRIVER)`/`register(CODEX_DRIVER)` | 改遍历 driver 表 |
| A | `weave-harness/src/index.ts:6-7` | 手写 `export * from './claude/index.js'` 等 | driver 表统一 re-export |
| **C** | `weave-core/src/types.ts:52` | `harness: z.enum(['claude','codex','any'])` 手写 | 由 `HARNESS_KEYS` 派生单一 enumeration |
| **C** | `weave-core/src/types.ts:252` | `harnesses: z.array(z.enum(['claude','codex']))`（RuntimeConfig） | 同上 |
| **C** | `weave-core/src/types.ts:277` | 同上（InitOptions） | 同上 |
| **C** | `weave-harness/src/shared/file-specs.ts:29-31` | `userDir?` / `codexUserDir?` **按 harness 名硬编码成列**，第三 harness 无列可放 | 改 `perHarness?: Partial<Record<Harness, …>>` 或路径知识完全下放各 `AssetSurface` |
| 次 | `weave-core/src/harness-checks.ts:24-27` | Claude 专属 check 住 core（`weave status` 用） | 下沉 harness 实现（非阻塞） |
| 次 | `weave-cli/src/init/wiring.ts:8-9,32-35` | per-id `unregister`+`register` 挂 init 槽 | 与 driver 表合并，遍历挂载 |

六槽 × 双 harness 完整度（新 harness 的参照成本）：

| 槽 | claude | codex | 说明 |
|---|---|---|---|
| init | ✅ | ⚠️ 半残（仅 ensureDirs/copySkills，余 skip） | init 槽由 cli 层注册（harness 根故意不持） |
| events | ✅ | ❌ `null` | 仅 claude 有落地样板 |
| assets | ✅ | ⚠️ skills-only | 受 `file-specs.ts` 硬列限制 |
| resume | ✅ | ❌ `null`（501 语义） | 仅 claude |
| detect | ✅ | ✅ | 最轻（3 成员），新建成本最低 |
| plugins | ✅ | ❌ 不声明槽 | 缺席先例，合法 |

### 4.2 weave-server/src

| 级别 | file:line | 问题 |
|---|---|---|
| **C** | `daemon/server.ts:889-893` | `GET plugins/enabled` 响应桶写死 `{ claude, codex }` |
| **C** | `daemon/server.ts:907-913` | `PUT plugins/enabled` 白名单 `!== 'claude' && !== 'codex'` → 400 |
| **C** | `daemon/server.ts:931-938` | `POST plugins/uninstall` `runtime !== 'claude'` → 400 |
| **C** | `daemon/server.ts:806-815` | `GET mcp` 固定三桶 `{ project, global, codex }` |
| **C** | `daemon/server.ts:664-685,739-748` | MCP 安装/卸载 `if (agent === 'codex')` 二分，新 harness 写进 claude 文件 |
| **C** | `daemon/hooks-routes.ts:362` | `src !== 'claude' && src !== 'codex'` → 400 |
| **C** | `daemon/start.ts:124`、`dev-entry.ts:115` | `harnesses.get('claude')?.resume` 写死 |
| **C** | `daemon/claude-liveness.ts:44,74` | `~/.claude/sessions` + `harness !== 'claude'` 早退（文件名即 harness 知识） |
| **C** | `install/capabilities.ts:32-54` | `installCapabilities()` 全量硬编码两 harness 的 surfaces（前端禁用判据的事实源） |
| **C** | `install/global-config.ts:47-51,100,220,235,423-445,452-496,502` | `GlobalSkillSource` 联合 + `CODEX_PLUGINS_CACHE` 未走面 + agent 二分 + 四组写死 + source 字符串分支 + `.codex` 段判据 |
| **C** | `install/updates.ts:196-202,316-324` | 写死四条 skill surface + codex MCP |
| **C** | `install/apply-update.ts:65,86` | 项目 skill 根未走 surface，`agent === 'codex'` 二分 |
| **C** | `install/global-file-assets.ts:27-68` | `CLAUDE_DIRS`/`CODEX_DIRS`/`ROOTS`/`PLUGIN_SUBTREE_ROOT` 全硬编码 |
| **C** | `install/reader.ts:57-66` | 允许根写死 `.mcp.json`/`CLAUDE.md`/`AGENTS.md`/`.claude/`/`.codex/` |
| **C** | `install/settings-mcp.ts:14` | `SETTINGS_FILE = '.claude/settings.json'` |
| **C** | `install/scanner.ts:12,102` | `targets.includes('claude')` + `.claude-plugin/plugin.json` |
| **C** | `install/codex-toml.ts`（整模块） | Codex TOML 表示法物理落在 server（违反「专属格式不得 server 自拼」） |
| **C** | `hooks/toolkit.ts`（:124,196,200,214,424,436,521,537,612,641,676,710） | `targets.includes('claude')`、`detectClaudeVersion` spawn、`pluginSurfaceFor('claude')` 兜底 |
| **C** | `hooks/toolkit-scan.ts:55,67` | `CC_MANIFEST_DIR='.claude-plugin'`、`DEFAULT_TARGETS=['claude']` |
| **C** | `hooks/mirror.ts:75` | `hookSourceHarness(...) !== 'claude'` 早退 |
| **C** | `hooks/plugin-loader.ts:418,461` | 仅对 `CLAUDE_HOOK_EVENTS` 校验（非按 `HARNESS_EVENTS[harness]`） |
| **C** | `hooks/resume-runner.ts:2,82-85` | 缺省 `CLAUDE_RESUME`/`WEAVE_CLAUDE_BIN` |
| **C** | `watch/classifier.ts:13-29,42` | 路径前缀写死 + 只查 `[codex, claude]` 两面 |
| **C** | `watch/watch-service.ts:38,251-253` | ignore 只并两面；agent 由 `.codex`/`.agents` 段推导 |
| **C** | `watch/plugin-mods.ts:57,92` | `.claude-plugin/plugin.json` 与 `.claude`/`.weave` 上界 |
| **C** | `repositories/sessions.ts:15,99` | `harness?: 'claude' \| 'codex' \| null` 联合 + 手写归一 |
| **C** | `statusline/*`（整模块） | Claude Code statusline 格式假设 + `/statusline/*` 路由无 runtime 参数 |
| B | `install/file-assets.ts:36`、`installer.ts:73`、`hooks/registry.ts:119`、`daemon/hooks-routes.ts:367-370` | 已走能力面/表 |
| A | （server 层无——只会按字面量查 core 表） | |

### 4.3 weave-server/web/src

| 级别 | file:line | 问题 |
|---|---|---|
| **C** | `lib/api.ts:534-537` | `PluginEnabledMap { claude; codex }` 手写两键 |
| **C** | `lib/api.ts:396-400` | `McpServerMap { project; global; codex }` 具名桶 |
| **C** | `lib/api.ts:505-509` | `GlobalSkillSource` 手写四值联合 |
| **C** | `lib/api.ts:279`、`tasks/session-status.ts:109,137,147` | `SessionRow.harness` / `HarnessKey` 手写联合 + rank 硬编码 |
| **C** | `lib/api.ts:112-131` | `{ kind: 'claude-event' }` legacy + `hookSourceHarness` 硬编 |
| **C** | `lib/install-capabilities.ts:42-45,59` | 回落 `[{harness:'claude'},{harness:'codex'}]` + `claudeOnly/codexOnly` 二元 reasonKey |
| **C** | `lib/hook-payload.ts:43-44` | `SOURCE_STYLES` 仅两色 |
| **C** | `components/CategoryDetail.tsx:252-271` | 运行时页签数组写死 + 标签字面 `'Claude'`/`'Codex'`（未进 dict） |
| **C** | `components/CategoryDetail.tsx:173-179` | `startsWith(runtimeTab)` + `startsWith('claude')?'claude':…:null` 推断 |
| **C** | `components/CategoryDetail.tsx:208-215` | MCP rows 按 codex/否则 claude 分叉 |
| **C** | `components/CategoryDetail.tsx:61-65` | `agentOf` 路径回落（`.codex/`、`AGENTS.md`）——**前端路径知识** |
| **C** | `components/CategoryDetail.tsx:302,350,371,396,421,436` | `CodexPlaceholder` + `!== 'claude'`/`!== 'codex'` 空态二分 |
| **C** | `components/SkillGrid.tsx:422,711-730` | `startsWith('claude')?'claude':'codex'` + `groupSkillRows` 正则只认两根 |
| **C** | `components/SkillGrid.tsx:122` | `claude-personal`/`codex-personal` 白名单 |
| **C** | `components/SkillDetailDrawer.tsx:36,444` | `SKILL_PREFIX_RE` + `root: agent==='codex'?'.codex':'.claude'` |
| **C** | `components/AgentBadge.tsx:17,28` | `const codex = agent === 'codex'`；未知即显示 claude |
| **C** | `components/tasks/HarnessIcon.tsx:14,18,25`、`SessionStatusIcon.tsx:14` | 形参手写联合 + 二分 |
| **C** | `components/StatuslinePanel.tsx:710`、`ToolkitSection.tsx:383` | `<AgentBadge agent="claude" />` 硬编 |
| **C** | `components/LibraryPanel.tsx:1174-1226,771,783` | `AgentToggle` 两值 + 标签三分支 + codex 路径提示 + `targetAgent:'claude'` |
| **C** | `components/tasks/SessionList.tsx:150` | 「打开终端」按钮 `harness === 'claude'` 门控 |
| **C** | `components/tasks/TasksPanel.tsx:158`、`LifecycleMindmap.tsx:239,1021` | 硬编 `HARNESS_LIFECYCLE.claude` |
| **C** | `App.tsx:78,82,285,347,358` | 初始 state 两键 + skill 路径正则 |
| **C** | `lib/file-tags.ts:34,42` | `.claude/helpers/`、`.claude/hooks/` 路径判据 |
| **C** | `i18n/dict/{hooks,library,toolkit,assets,tasks,statusline}.ts` | 专名词条（部分动态 key 编译强制催补：`hooks.harness.*`） |
| A | `lib/api.ts:70,539`、`CategoryDetail.tsx:68`、`SkillGrid.tsx:75`、`tasks/lifecycle.ts:8`、`HooksPanel.tsx:93` | 直引 `Harness` / `Record` 穷尽催补 —— 自动扩 ✅ |

### 4.4 weave-cli/src

| 级别 | file:line | 问题 |
|---|---|---|
| **C** | `commands/status.ts:75-85` | 表面行写死 6 条 `.claude/*` + `if (detected.includes('codex'))` 特判 |
| **C** | `init/instruction-link.ts:42-43` | `CLAUDE.md`/`AGENTS.md` 两名合一逻辑写死 |
| **C** | `init/uninstall.ts:88,340,515` | `WEAVE_MANAGED_PATHS` 白名单 + 指令文件循环（同文件 `:201 sweepHarness` 已表驱动，**自相矛盾**） |
| **C** | `i18n/dict/zh.ts:36-37,93,137`、`en.ts:38-39,96,147` | 帮助文本枚举 harness、banner 写死「Claude Code」、statusline 路径写死 |
| **C** | `init/executor.ts:30,95` | 通用契约 `SurfaceRecords` 挂在 claude 专属模块（结构兼容不报错，但「家」错） |
| A | `init/wiring.ts:8-9,32-35`、`init/harness-checks.ts:21-46` | init 槽注册点 / check 文案表——扩行即可 |
| B | `commands/scan.ts:13-24`、`status.ts:63-74`、`init/executor.ts:91-104,179-186` | 走 `byCapability('detect')` / `HARNESS_DIRS` 表 |

---

## 5. 收口计划（开发合同）

阶段依赖：**P0 → {P1, P3, P4} → P5**；P2 独立（结构搬家，风险自持）。

| 阶段 | 内容 | 触达面 | 硬闸 |
|---|---|---|---|
| **P0 core 闸门** | ① `harness.ts` 名表收敛为单一 `HARNESS_NAMES` 数组，`Harness` 由其派生；② `types.ts` 三处 `z.enum` 改派生；③ 新建 `HARNESS_DRIVERS: Record<Harness, HarnessDriver>` 单表（`satisfies` 穷尽），`registry-wiring` 遍历注册、`index.ts` 由表导出；④ `file-specs.ts` 硬列改 `perHarness` 映射 | core、harness 根、shared | 存量测试零改动通过；名表漏加一行 → 编译失败（负例验证） |
| **P1 server 枚举收口** | 响应桶/白名单改 registry 驱动（`plugins/enabled`、`plugins/uninstall`、`mcp`、`hooks-routes`）；目录/来源枚举改遍历 `byCapability('assets')`（`capabilities.ts`、`global-config.ts`、`updates.ts`、`apply-update.ts`、`global-file-assets.ts`、`reader.ts`、`watch/*`、`scanner.ts`、`sessions.ts`）；事件集改 `HARNESS_EVENTS[harness]`（`plugin-loader`、`mirror`）；resume 缺省改按会话 harness 取 | server ~20 文件 | 全量 server 测试绿；新 harness（stub）不被白名单拒 |
| **P2 专属格式下沉** | `codex-toml.ts`、`statusline/*`、`claude-liveness.ts` 迁入 `weave-harness/src/<name>/`，server 经能力面取 | harness 包 + server 装配 | 迁移后行为零变（测试零改动）；server 不再 import 专属格式模块 |
| **P3 web 解耦** | ① 建 harness 元数据单点表（显示名/色/图标/页签标签/安装目标），理想由服务端 `/capabilities` 下发；② 手写镜像联合改引 `Harness`/`Record<Harness,…>`；③ **删除前端路径知识**（`agentOf`、`groupSkillRows` 正则、`SKILL_PREFIX_RE`、`file-tags` 判据、App 正则），只信 `AssetEntry.agent`；④ 二元分支改查表；⑤ i18n 专名参数化 | web ~20 文件 | web tsc + build:web 绿；dict 测试绿；无 `startsWith('claude')` 一类推断残留 |
| **P4 cli 收口** | `status.ts` 表面行由 `AssetSurface` 派生；`instruction-link.ts` 指令文件名下沉 harness；`uninstall.ts` 白名单派生（对齐 `sweepHarness`）；`SurfaceRecords` 从 claude 模块上提；i18n 帮助文本动态、banner 去专名 | cli 6 文件 | cli 测试绿；`weave status` 输出对 stub harness 正确 |
| **P5 验收（stub harness 零改动）** | 新增测试夹具 harness（`__fixtures__/stub-harness`，不入发布）：仅名表 + driver 表两行 + 新目录；断言全系统编译/运行/stub 可探测/可出现在 capabilities 与页签 | 测试夹具 | **除两处声明行外，`git diff` 对 shared 代码为空** |

**每阶段铁律**：`pnpm build`（各包）+ `build:web` + 全量测试退出码 0；中文提交
`<type>(<scope>): <描述>`；只 add 本阶段文件（并行会话期复核暂存列）。

---

## 6. 开放问题与不做的事

1. **名表本身运行时化**（外部包装 weave harness 驱动，连 core 都不改）——更远目标，
   本计划不做；P0 只保证「名表 + 驱动表两行」。
2. **`hookSourceHarness` / `claude-event` 兼容窗**——随 `CROSS-HARNESS-DESIGN` 批 0
   的兼容策略处置，本计划不动语义。
3. **statusline / codex-toml 的归属**：P2 只搬家不改语义；两模块的能力槽化
   （是否值得升为第 7、8 槽）需与项目所有者确认后再定。
4. **审计条目可能有误**（子agent 扫描所得，未逐条人工复核）——以实施阶段
   逐条**当场复核**为准；发现误报在本文档标注而非默默跳过。

---

## 附：关联文档

- `docs/CROSS-HARNESS-DESIGN.md` —— 跨 harness 能力演进设计（批 0–5，互补）
- `docs/plan/template-method-harness-refactor.md` —— 六能力槽 + registry 架构总纲
- `docs/BACKLOG.md` —— 双 harness 现状与高难度项
