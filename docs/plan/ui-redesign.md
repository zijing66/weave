# Weave UI 信息架构重设计实施方案（分支 feat/hooks）

## Context

现有 UI 分类卡 6 张（skills/mcp/commands/personalization/hooks/tasks），全局与项目级分类模糊、卡片重复；文件资产树无高度约束、无 tab；hooks 面板 6 区块纵向过长且指令池与画布割裂；任务视图全平铺 + `ASC LIMIT` 取最旧窗口导致大会话不可读；CC 原生包被复制进项目 `.claude/plugins/`（应为全局安装+项目启用）；`plugin_states` 无项目维度导致启用串项目；右栏资产库仅支持本地目录且存绝对路径（迁移即断）。

本计划把 UI 收敛为 **4 分类卡 + 文件资产核心页 + Weave 双形态 + 任务分层 + 资源市场 + 左栏快捷操作**，并**落档架构纪律进 CLAUDE.md**。继承 `docs/plan/template-method-harness-refactor.md` 的架构总纲：

- 全仓唯一 abstract class 仍是 `InitPipeline`，本计划不新增 abstract class，只扩能力接口；
- harness 专属能力一律走 `@weave/harness` 能力槽（EventSource/AssetSurface/ResumeCommandSpec/Detector，**本计划新增 PluginSurface**），实现各自落 `weave-harness/src/claude/`、`src/codex/`，server/cli 只装配编排；
- 依赖硬约束 `@weave/harness → @weave/core` 唯一，core 只放纯类型与表；web 仅 `import type` 引 core/harness；
- daemon 自身状态（plugin_states / projects.meta / 事件表 / 资源市场）直接改 server，不走 harness 接口；但「装到 harness 表面」的目标路径解析必须复用 AssetSurface，不新写 harness 路径硬编码。

**范围红线（全程不动）**：REST `/hooks/*`、CLI `weave hooks|plugins|toolkit`、表名（hook_rules/hook_dispatches/hook_events/plugin_states/sessions/projects/libraries schema 列）、SSE `type:'hook'` 与 `kind` 枚举、前端 `weave:hook` 事件协议。「hooks→Weave」只改 UI 文案与前端分类 key。

**用户已确认的决策**：① 全局/项目统一 4 卡（文件资产/个性化设置/任务/Weave），Skill/MCP 降级为文件资产页内 tab；② plugin 与 mods 合并一个 tab；③ plugin_states 启用按项目真隔离；④ 全局任务视图 = 跨项目只读总览（点进跳项目）；⑤ Hooks 改名「Weave」；⑥ CC 插件仅全局安装、项目只控启用（weave 自有 plugin 不受影响）；⑦ 快捷按钮复用右键菜单既有回调；⑧ 资产库→资源市场（git+本地目录统一收纳 dataDir，全局 symlink 优先/项目复制优先）。

每批铁律：`pnpm build && pnpm build:web && pnpm test` 全 0 + 中文提交（正文写明本批硬闸：零改 X 条 / 修订 Y 条及理由）。

---

## 第一章 架构决策（10 项）

### D1. MainCategory 收敛为 4 key

`type MainCategory = 'files' | 'personalization' | 'tasks' | 'weave'`，旧 6 key 一步删除；skills/mcp 降级为文件资产页内部状态 `AssetTab = 'skills' | 'mcp' | 'plugins'`（状态上提 App，受控传入 CategoryDetail 与 LibraryPanel）。

- `'commands'` 改名 `'files'`（标签本就是「文件资产」，key 是历史误名）；`'hooks'` 改名 `'weave'`——**仅前端类型与文案**，dict key 前缀 `hooks.*`、`catbar.hooks` 保留（只改 value），REST/CLI/表名/SSE 不动。
- 可一步删除理由：`mainCategory` 只存 React state（App.tsx:75，无持久化无 API 契约），TS 联合 + switch 穷尽编译期收口。
- 消费点：CategoryBar.tsx:16-33（类型+卡表+countFor/badgeFor）、CategoryDetail.tsx 分支、App.tsx:75/168/194/614-619/755-778/860、LibraryPanel.tsx:152-165/497-510。
- runtime tab（Claude/Codex/全部）保持正交，`showRuntimeTabs` 收敛为 `files | personalization` 两分类共用；weave/tasks 不显示。
- 全局隐藏 tasks（App.tsx:758）在批 6 放开。
- 计数合并：`skills/mcp/commands/outdatedSkills/outdatedMcp` → `files` + `outdated`；`hooksRules/personalization/sessions/statuslineSource` 保留；全局 sessions 改跨项目数（批 6）。
- LibraryPanel 跟随：`category==='files'` 时按 assetTab 显示 Skills/MCP/文件模板区（Plugins 无模板给空态）；`categoryLabel` 同步 4 key。

### D2. 文件资产页布局

- 页面纵向：标题/计数 → runtime tab → KIND chips（**裸 token**）→ 目录树（`max-h-[45vh] overflow-y-auto` 固定高内滚）→ AssetTab 行（Skills/MCP/Plugins）→ 对应面板。
- 树过滤：Skills→`category==='skill'`；MCP→`category==='mcp'`；Plugins→`.weave/plugins/`∪`.weave/toolkit/`∪`.claude/plugins/`（watch 已观测，归类 other，零后端改动）。
- **并集规则**：通用文件资产（instructions/command/agent/workflow/rule/output-style/helper/settings/other）任何 tab 下保留显示——它们是计数与 chips 主体；tab 只切换 skill/mcp/plugin 三类专属文件显隐。过滤单点在 CategoryDetail，要改严格 tab-only 单点可改。
- MCP 启停开关原样；Plugins tab 内容 = 新组件 `PluginAssetsPanel`（组合 HooksPluginsSection + ToolkitSection，两组件零内部改动）。
- 全局模式：`global-file-assets.ts` 白名单 `SKIP_DIRS={skills,plugins}` 保留现状（global-file-assets.test:49-53 零改）；全局三 tab 面板照常，Plugins tab 树空给空态文案。

### D3. plugin_states 按项目隔离

**每项目启用覆盖写 `projects.meta`，`plugin_states` 表保持全局（=「默认启用」开关），不改表零迁移。**

- 数据形：`meta.plugins = { syncedAt: string|null, enabled: Record<string, boolean> }`（与既有 `meta.toolkit.enabled[]` 同构，getMeta/setMeta 已有）。
- 生效单点（新模块 `src/hooks/plugin-project-state.ts`）：`effective(project,id)` = enabled[id] 存在→用之；否则 syncedAt 存在→false（已同步未启用）；否则回落全局行（=现状，存量测试零改动）。
- 「同步后默认不启用」：同步动作写 syncedAt + 对无显式记录的已知插件补 `enabled=false`（显式选择永不被覆盖）。
- 串项目修复：toolkit 按项目 enable 改写 `meta[A].enabled[id]=true`，**不再 flip 全局 plugin_states**（toolkit.ts:386-408 级联移除）。
- 匹配门控：`dispatcher.match()`（dispatcher.ts:242-254）追加 `rule.plugin_id!=null && !effective(ctx.project.id, rule.plugin_id)` 不命中；未同步项目回落全局→现状语义；fail-closed 只影响插件规则。
- 不改表理由：全局语义被 plugin-loader.test:188/265、hooks-server.test:435、toolkit-toggle.test:254 锁定，复合主键需重建表+断言重写；meta 方案零迁移、回滚删字段即可。
- 全局「默认启用」= 既有 `/hooks/plugins/:id/toggle`（路径不变）；项目级 = 参数扩展（`GET /hooks/plugins?projectId=`、toggle body 可选 projectId）。

### D4. CC 原生包全局安装落点

**新增能力槽 `HarnessCapability += 'plugins'`、接口 `PluginSurface`（driver.ts），Claude 实现落 `claude/plugins.ts`；Codex 不注册（仿 resume.ts unsupported 先例）；server toolkit.ts 只经 registry 编排。**

- PluginSurface 职责（CC 专属知识全收进 claude/）：`projectPluginDir()`→`.claude/plugins`；`globalInstall(srcDir)`→CC 全局位（H1/H5 待验证：`~/.claude/plugins/cache/<marketplace>/<name>/<version>/` + `installed_plugins.json` 登记）；`readInstalled()/isInstalled(id)`；`setProjectEnabled/readProjectEnabled`→项目 `.claude/settings.json` 的 `enabledPlugins`（H3 待验证）；全局 settings 的 enabledPlugins 读写自 `global-config.ts:535-574` 迁入，**server 保留同名导出薄委托**（global-config.test 零改）。
- toolkit.ts 改造（批 3）：buildFilePlan 删 ccPack 分支（:162-171）；enable 保留 mod 版本闸 → ccPack 走 globalInstall（幂等）+ setProjectEnabled(true)；computeEnabled 改判据「全局已装 && 项目 enabledPlugins 开」；disable 只关项目启用、**全局安装保留**；存量项目副本读时自愈（按 checksum 删副本并重写 record，仿 healMeta；list 返回 legacyCopies）；新端点 `POST /toolkit/legacy-copies/cleanup` + ToolkitSection 警示/清理按钮。

### D5. 画布改造（指令可视化）

- HooksPanel 画布加**第 5 列 dispatch**（`COL_X.dispatch=1280`），**指令池列表（:1404-1507）整体移除**，执行交互迁到节点。
- dispatch 节点：状态徽标+规则名+时间+prompt 两行 clamp（hover 全文）+复制按钮；draggable（复用 setDispatchDrag）。
- 分簇：有 sessionId → y 对齐目标 session 行 + `dispatch→session` 边；pending（sessionId null）→ 列顶「待指派」簇（= 移除列表后 pending 查看处，CardHeader 挂待指计数）。
- 执行：拖节点 → 既有 SessionNode drop（:298-303）→ 既有确认条（:1510）零改动；节点 hover「选择会话 ▾ + ▶」（runDrafts :1471-1501 迁入节点，仍走 `POST /hooks/dispatches/:id/run`）。
- 高亮：`dispatch.created` SSE → ① 规则节点边框闪烁（复用 pulseRuleId + weave-edge-flash :575/:742-752）② dispatch 节点入场 ripple 900ms（复制 TasksPanel.tsx:150-155 模式）。
- 双形态：全局 = 插件管理（安装/卸载/链路/「默认启用」+每项目同步设置）+ 规则表/表单 + 画布；项目 = 项目插件启用列表（批 4 API）+ 画布 + 规则编辑；开关默认态由 D3 effective 决定，徽标区分「已同步未启用 / 未同步跟随全局」。

### D6. 事件取数最新窗口

`HookEventRepository.listBySession` 改 `ORDER BY id DESC LIMIT n` 取最新窗口 + **reverse 返回升序**；不做游标（repositories/hook-events.ts:54-59）。id 单调=插入序，消解时间戳并列；reverse 后返回序与现状一致，build-session-chain/TasksPanel 零适配。server clampLimit 默认 100/上限 500 不动。硬闸：data.test.ts:40 只断长度→零改。`beforeId` 翻页留增量 API（BACKLOG）。

### D7. 任务分组算法（前端启发式）

**core 新增纯表 `HARNESS_LIFECYCLE`（weave-core/src/harness.ts，与 HARNESS_EVENTS 同处），web 镜像 + 纯函数分组（零 schema）**——分组差异是 harness 知事，server/web 均不写 `if (source==='claude')` 散落判断。

- 表形 `Record<Harness, {open; close; sessionMarkers; subagentStop}>`（claude：UserPromptSubmit / ['Stop'] / ['SessionStart','SessionEnd'] / SubagentStop）。
- web 镜像 `tasks/lifecycle.ts`（锚定注释先例：TasksPanel.tsx:17-25 mirror HookBusMessage）；纯函数 `tasks/build-lifecycle-groups.ts` + 单测：升序 events+dispatches → `groups[] = {id, prompt?, events, dispatches, open?, preSession?}`。
- 边界：① 无 Stop 的中断 turn：遇下一 UserPromptSubmit/SessionEnd/尾关组，`open:true` → 组头「未正常结束」徽标；② 首 prompt 前散事件 → 「会话引导」伪组（preSession）；③ subagent 无 agentId：SubagentStop 不独立成组，组内高亮 + 组头「子代理完成 ×n」（启发式明示）；④ dispatch 归组：`eventId ∈ 组内事件集`（零 schema），null → 「游离指令」区；⑤ SessionStart/End 只作标记不切组。
- 组内复用 `buildSessionChain` **零改动**（输入换单组切片），MAX_EVENT_NODES=400 降为组内兜底。

### D8. 分层 UI 与 fitView

**组头列表 + 单组画布（accordion）**：右栏纵向组头（prompt 摘要/时间/事件数/dispatch 数/状态徽标/展开折叠）+ 展开组渲染现有 SessionFlowCanvas（每组一图）。`viewKey = 会话id:组id`——切组/会话首帧 fitView；组内 SSE 新增只 setNodes 不重建（现状语义），视口不跳。不采用多组拼接折叠画布（fitView 仍全图缩放，P1-1 换形态复现）。P1-1 截断方案不再需要。

### D9. 全局任务总览端点

**不新造 API**：`GET /sessions` 的 projectId 本就可选（hooks-routes.ts:249-257 → 跨项目 DESC LIMIT 200，sessions.ts:61-77）；web `api.listSessions(projectId?)` 签名已可选（api.ts:777）。总览 = `listSessions()` 无参 + `listHookDispatches({limit:200})`（本就全局），前端按 projectId 分组。新组件 `GlobalTasksOverview`：只读聚合，行点击 → `setGlobalMode(false)+loadProject+setMainCategory('tasks')+initialSessionId`；TasksPanel 加 `initialSessionId?: string`。

### D10. 资产库 → 资源市场

新 server 模块 `src/market/`（daemon 自身能力**不进 harness**），收纳 = 一律复制/clone 进 `<getDataDir()>/market/<resourceId>/` 成唯一事实源（连同 sqlite 整目录迁移他机）；`libraries.path` 语义改「相对 getDataDir() 的 posix 路径」+ 读侧兼容；全局安装 symlink 优先失败回退复制；项目安装保持 cp。**git 更新检查独立 BACKLOG 批**（清单预留 url/commit）。

- 改名 UI 文案层：`library.*` 词条改「资源市场 / Resource Market」（key 前缀保留）。
- API（新 `/market` 路由组；`POST /libraries` 保留 legacy）：`GET /market` 清单；`POST /market {kind:'dir',path}` / `{kind:'git',url}` 导入；`DELETE /market/:id` 先卸装面再删目录；`POST /libraries/:id/market-import` 显式迁入。
- 路径兼容（**迁移兼容闸**）：读侧单点 `resolveLibraryPath(row)`——相对→join dataDir；绝对且在 dataDir 内→惰性 UPDATE 为相对；绝对且在 dataDir 外→legacy 外部源原地可用，UI 显式「迁入市场」（不自动 copy）。buildLibraryIndex/扫描/安装统一走 resolve，**schema 零变更**。Windows：posix 分隔符入库、join 还原；导入用 cp；symlink 只在装面用。
- 清单 `<dataDir>/market/<id>/.weave-market.json`（source/origin/git url/commit/importedAt），不加表列。
- 全局装 symlink：目标经 `AssetSurface.globalSkillsRoots()/targetDir()` 解析（**不新写 harness 路径硬编码**）→ symlink 指市场目录；EPERM/EEXIST/ENOTSUP → 回退 cp；卸载按 lstat 区分（链接删链接、复制删目录——防删穿市场源）。watch follow symlink 既有兼容（global-config.ts:96-115）。
- 项目装保持 cp（installer.ts:89 现状，指纹/updates 不换轨）。
- 安全：git 用 execFile 数组传参（**无 shell**）；URL 协议白名单 https/ssh（禁 ext::/--upload-pack 向量）；clone 超时+输出截断；目标 path.resolve 必须落 dataDir 内；resourceId slug 白名单。

---

## 第二章 分批实施（9 批）

### 文件簇与并发

| 簇 | 成员 | 串行链 |
|---|---|---|
| W1 web 主链 | App.tsx、CategoryBar、CategoryDetail、LibraryPanel、FileAssetTree、dict/assets、dict/hooks(catbar 段)、dict/tasks | 批1→批2→批6→批8 |
| W2 web HooksPanel | HooksPanel、HooksPluginsSection、lib/api.ts、dict/hooks | 批7（可与批6 并发） |
| W3 web tasks | tasks/lifecycle.ts(新)、build-lifecycle-groups.ts(新)、TasksPanel、SessionFlowCanvas、GlobalTasksOverview.tsx(新) | 批5→批6 |
| WL 资源市场 web | LibraryPanel、dict/library | 批2→批9（可与批6/7 并发） |
| S1 server toolkit/harness | toolkit.ts、toolkit-routes、global-config、weave-harness/{driver,claude,codex}、ToolkitSection、dict/toolkit | 批3→批4 |
| S2 server 事件/分发 | hook-events、dispatcher、hooks-routes、sync-scheduler | 批4 与批5 可并发 |
| S3 server 资源市场 | 新 src/market/**、repositories/libraries、daemon/server.ts(路由) | 批4→批9（server.ts 热点串行） |
| X | CLAUDE.md | 批8（可提前单独提交） |

**依赖 DAG**：批1→批2→批6→批8；批3→批4→批7；批5→批6；批2/批4→批9。可并发对：{批1,批3}、{批2,批3,批5}、{批6,批7}、{批9,批6/7}。

### 批 1 —— 信息架构收敛：4 分类卡（纯 web）
- 改：CategoryBar（4 key/四卡/countFor·badgeFor 合并）、App（初始重置 `skills→files` :75/:168/:194、`hooks→weave` :614-619、categoryData :266-303、hidden 暂留 tasks）、CategoryDetail（分支收敛，skills/mcp 先整体移入 files 分支保功能，AssetTab 留批2）、LibraryPanel（files 暂三区全显、categoryLabel 4 key）、dict/assets（删 catbar.skills/mcp/commands 增 catbar.files）、dict/hooks（catbar.hooks value→Weave，key 不动）。
- 硬闸：dict.test 键对齐（zh/en 同批同改）；无分类卡快照测试→绿；skill-stats 零改。
- 与批3 并发 OK。

### 批 2 —— 文件资产页核心入口（web）
- 改：FileAssetTree（删 KIND_LABELS :37-47 翻译层裸 token 直出、树 `max-h-[45vh] overflow-y-auto`）、CategoryDetail（AssetTab 受控、D2 并集过滤、三面板互斥、runtime tab 不动）、App（assetTab 上提重置）、LibraryPanel（files 分区按 assetTab 互斥）、**新 PluginAssetsPanel.tsx**、dict/assets（删 fileTree.kind.* 18 条成对、增 tab 词条与空态）。
- 硬闸：dict.test 成对删加；**global-file-assets.test:49-53 零改**；skill-stats/harness assets.test 零改。
- 可与批3/批5 并发；批9 依赖本批。

### 批 3 —— CC 原生包全局安装纠正（harness 能力槽 + server 管线）
- 架构：PluginSurface 定义 driver.ts、实现 claude/plugins.ts、codex 不注册；global-config 的 CC enabledPlugins/installed_plugins **实现迁入 claude/、server 薄委托**；server 零新增 CC 硬编码。
- 改：driver.ts（capability+'plugins'、接口）、**新 claude/plugins.ts**（H1-H5 结论落这）、claude/index 补槽、codex/index 不注册、harness 导出、toolkit.ts（buildFilePlan 删 ccPack :162-171、enable/disable 接 surface、computeEnabled 改判据、record 自愈清副本、list 报 legacyCopies、头注释改写）、global-config 薄委托（导出名不变）、toolkit-routes（`POST /toolkit/legacy-copies/cleanup`）、ToolkitSection+dict/toolkit、**新 harness __tests__/plugins.test.ts**。
- 硬闸（**显式修订组**）：toolkit-toggle 闸①（:119-135 `.claude/plugins` 落项目断言→「项目零副本+全局位落盘+toolkit 记录仍写」）、闸②（:139-148 改写保护对象改全局位）、闸④（:195 无 CC 条目）、闸⑤（:323 → 两项目全局位一致+各自 enabledPlugins）；**mod 版本闸 :203-242 零改**（勘误：原 :152-176 已漂移，实测锚点见 cc-plugin-verification.md）；global-config.test:195-211 零改；harness assets.test 零改；toolkit-server/toolkit-loader 预期零改执行核查。
- **前置 H1-H5 验证不过不进批**。

### 批 4 —— 插件启用按项目隔离 + 同步扩展（server 自身状态）
- 改：**新 hooks/plugin-project-state.ts**（effective 三分支 + syncPlugins 写 syncedAt/补 false）、dispatcher match 加 plugin_id 项目门控、hooks-routes（GET ?projectId=、toggle 可选 projectId，路径不变）、toolkit.ts（weave 成分 enable/disable 改写 meta、移除 :386-408 全局级联）、sync-scheduler（tick 追加 syncPlugins，同 autoSync 同 60s）、daemon/server.ts sync-all（:875-896 追加插件同步，返回 additive）。
- 硬闸：plugin-loader.test:188/265、hooks-server.test:435-470 **零改**；**toolkit-toggle:254-266 显式修订**（states→meta+effective）；新增 plugin-project-state.test + dispatcher 门控用例。
- 批3 后；与批5 可并发。

### 批 5 —— 事件取数最新窗口 + 分组算法（server + core + web）
- 改：hook-events.ts（DESC + reverse 升序）、core/harness.ts（HARNESS_LIFECYCLE 表+导出+表测试）、**新 web tasks/lifecycle.ts**（镜像+锚定注释）、**新 tasks/build-lifecycle-groups.ts+单测**（四类边界用例）；TasksPanel/SessionFlowCanvas 不动。
- 硬闸：data.test:40 零改；hooks-server 事件端点预期零改；build-session-chain/session-status 零改。
- 与批1-3 并发 OK。

### 批 6 —— 项目任务分层视图 + 全局总览（web）
- 改：TasksPanel（组头列表+单组画布、chain 输入换组切片、dispatches 归组、SSE 落组、initialSessionId、viewKey 会话id:组id）、SessionFlowCanvas（key 注释/最小改）、**新 GlobalTasksOverview.tsx**、CategoryDetail（tasks 分支 `isGlobal ? Overview : TasksPanel`）、App（hidden 移 tasks :758、openSessionInProject 跳转、全局 sessions 跨项目计数）、dict/tasks（成对新增）。
- 硬闸：session-status、build-session-chain、dict.test 全零改（词条只增）。
- 批1、2、5 后；**可与批7 并发**。

### 批 7 —— Weave 分类双形态（画布 dispatch 列 + 指令可视化 + 文案改名）
- 改：HooksPanel（COL_X+DispatchNode+nodeTypes；buildGraph 接 dispatches 对齐 session 行/pending 待指派簇+边；删 :1404-1507 指令池与右卡，runDrafts/copyPrompt 迁节点；Header 待指计数；SSE pulseRuleId 复用+新 ripple；global/project 形态分区）、HooksPluginsSection（可选 projectId，项目态显 effective 开关，安装/卸载仅全局）、lib/api.ts（listHookPlugins/toggleHookPlugin 参数扩展）、dict/hooks（约 10-20 条 value 调整 key 全保留）+dict/settings（settings.hooks value 提法）。
- 硬闸：**hooks-server.test 零改**（API 向后兼容）；dict.test 值改不影响键。
- 批1+批4+批3 文案后；与批6 并发 OK。

### 批 8 —— 左栏快捷操作 + CLAUDE.md 架构落档
- 改：ProjectList（行 :102-129 hover 按钮簇挂 HealthBadge ml-auto 位：①autoSync 开关 ②手动同步（updates>0 换有更新形态+角标）③资源管理器 ④终端；opacity-0 group-hover 显现，**右键菜单保留**；新 props autoSyncOf/updatesOf/onToggleAutoSync/onSyncNow，explorer/terminal 复用既有回调）、App（handleSyncAll:528-539/handleToggleAutoSync:569-579 参数化、configMap 批量轻拉+updatesMap hover 懒加载、顶栏 :707-751 改同回调）、dict/app 词条。
- **CLAUDE.md 落档**：`weave:start` **标记块外**（文件末尾）新增 `## Architecture`——唯一 abstract class=InitPipeline、能力槽与 harness 目录归属、`@weave/harness → @weave/core` 唯一依赖与 core 纯表、web 仅 import type；块外人工维护 init 不覆盖。
- 硬闸：dict.test 成对加词条；CLAUDE.md 无测试。W1 链尾（批6 后）；CLAUDE.md 部分可提前单独提交。

### 批 9 —— 资源市场（Resource Market）
- 架构：server daemon 自身能力（新 src/market/，不进 harness）；装面路径全经 AssetSurface；web 仅 LibraryPanel+dict/library。
- 改：**新 src/market/**：import.ts（本地复制+git clone：execFile 数组、URL 白名单、超时、containment）、resolve.ts（相对/绝对兼容+惰性改写）、manifest.ts（.weave-market.json）、install-link.ts（symlink 优先+cp 回退+卸载 lstat 区分）；repositories/libraries（读侧接 resolve）、library-index（消费 resolved）、daemon/server.ts（/market 路由组+market-import；POST /libraries 保留 legacy）、global-config/installer 全局装改 install-link（目标经 AssetSurface）、LibraryPanel（改名、git/本地双入口、来源徽标、legacy 迁入按钮、git 元数据）、dict/library、lib/api.ts（market 客户端）、**新 market/__tests__**（导入/解析与惰性改写/containment/symlink 成功与 EPERM 回退双分支/卸载 lstat 区分/git URL 校验——假 execFile 不联网）。
- 硬闸：**迁移兼容闸**——data.test libraries 幂等零改；library-index/installer/updates-server/apply-update/fs-server「预期零改执行核查」；若全局装 symlink 触碰 installer.test cp 断言→**显式修订组**（改「链接或回退复制」双形态）声明；dataDir 内/外绝对路径迁移用例新增。
- 批2+批4 后；可与批6/7 并发。**明确不做**：git fetch 远程更新（BACKLOG 独立批）。

---

## 第三章 风险清单

- **R1 meta 语义迁移**：effective 单点+三分支单测；回滚删 meta.plugins 即回旧行为；门控 fail-closed；toolkit-toggle :254 修订与 effective 同批防中间态。
- **R2 i18n 词条量**：en 强制类型+dict.test 双闸；词条随批走、zh/en 同 commit 不留半套键。
- **R3 存量测试硬闸**：
  - 零改组：dict.test(1,2,6,7,8,9)｜data.test:40+libraries 幂等(5,9)｜plugin-loader.test:188/265(4)｜hooks-server.test:435-470+事件端点(4,5,7)｜global-config.test:195-211(3)｜global-file-assets.test:49-53(2)｜library-index/installer/updates-server/apply-update/fs-server(9 核查)｜build-session-chain/session-status(5,6)｜harness assets.test(3)｜project-config.test(4,8)｜skill-stats(1,2)。
  - 显式修订组（随批重写、理由进提交信息）：toolkit-toggle 闸①②④⑤(批3)｜toolkit-toggle:254-266(批4)｜installer.test 全局 cp 断言(批9 核查后定双形态)｜toolkit-server/toolkit-loader 若含 CC 断言(批3/4 核查后定)。
- **R4 CC 机制不确定点（H1-H5，验证不过不进批 3）**：
  - H1 installed_plugins.json(v2) 注册源、installPath→cache：文档/`claude plugin --help` + 手工注入实验；fallback：surface 内 spawn `claude plugin install <local-path>`。
  - H5 本地 pack `name@weave` key、marketplace 可不在 known_marketplaces：实验；fallback：weave 自管全局位+本地 marketplace 条目；再不行降级「全局位+指引确认」。
  - H2 mod 与 CC 包同机制：本机 `claude --version`+实验；fallback：mod 专属分支留在 surface 内。
  - H3 项目 settings enabledPlugins 覆盖全局、key=`name@marketplace`：实验；fallback：settings.local.json 或 CC CLI，surface 内换实现接口不变。
  - H4 项目 `.claude/plugins/` 副本是否被 CC 加载：实验；若会加载→清理前强提示、按钮显式不自动删。
- **R5 分组启发式误判**：组头「推断分组/未正常结束」徽标；events 不裁剪，分组是视图切片可退平铺。
- **R6 大会话性能**：最新窗口 ≤500 + 单组渲染 + 每组 fitView；dispatches limit=200 现状保留。
- **R7 共享文件热点**：App.tsx(批1/2/6/8 串行)、daemon/server.ts(批4/9)、toolkit.ts(批3/4)、dict/hooks.ts(批1/7)；每批门禁后中文提交。
- **R8 sync-all/调度耦合**：插件同步返回 additive；tick 内失败不中断资产同步（try/catch 分段，finally 防重入）。
- **R9 symlink 跨平台**：Windows EPERM 回退分支双分支断言；卸载先 lstat——把链接当目录递归删会删穿市场源，install-link 单点+专项测试。
- **R10 git 导入安全**：白名单+execFile 无 shell+超时+输出截断+dataDir containment+slug 白名单；测试假 execFile 断言参数数组。
- **R11 libraries 双语义错位**：resolve 单点收 repositories/libraries 读侧；惰性改写仅限 dataDir 内；外部绝对路径永不改写、显式迁入才复制。

---

## 第四章 门禁与验收纪律

1. 每批：实现 → 三门禁全 0 → 中文 commit（正文写「本批硬闸：零改 X 条 / 修订 Y 条及理由」）→ 下一批。
2. 修订组测试与被修订实现**同批同 commit**，不留跨批中间态。
3. 批 3 前置 H1-H5 验证记录（结论进提交信息或 docs 附注）。
4. 每批结束在批次标题前勾 ☑。
5. 人工走查（非门禁）：批2 树固定高+三 tab 联动；批6 组头/单组画布/全局跳转；批7 dispatch 列拖拽执行与闪烁；批8 行 hover 四按钮；批9 双导入/symlink 卸载/legacy 迁入。
6. BACKLOG：① git 远程更新检查/拉取（消费 .weave-market.json）；② 任务游标翻页（beforeId）与跨项目 dispatch 分页。
7. **计划落盘**：本计划批准后先存 `docs/plan/ui-redesign.md` 再进批 1。

## 附录 — 现状行号锚点

- 分类/详情：CategoryBar.tsx:16-33；CategoryDetail.tsx:200-343；App.tsx:75,168,194,266-303,614-619,707-751,758,762-769,860；LibraryPanel.tsx:151-165,497-510。
- 文件树：FileAssetTree.tsx:37-64,134-170,466；watch/classifier.ts；global-file-assets.ts SKIP_DIRS；watch-service.ts:33（.weave 不忽略）。
- 插件：hooks-routes.ts:142-200；plugin-installer.ts:114-182；plugin-loader.ts:183-216,312-325,593-637；toolkit.ts:162-171,386-408,495-556；db.ts:64-69；dispatcher.ts:241-254；global-config.ts:535-574。
- 同步：project-config.ts:16-63；sync-scheduler.ts:55-74；server.ts:875-896,1139-1143,280-297；statusline/manager.ts:25-30,88-108。
- 任务：TasksPanel.tsx:41-389；build-session-chain.ts:12-17,48-207；SessionFlowCanvas.tsx:47；session-status.ts:28-44；hook-events.ts:54-59（ASC 问题）；sessions.ts:61-77（跨项目已支持）。
- 画布/指令：HooksPanel.tsx:273-360,368-371,379-479,575,699,742-752,900-915,972-1021,1404-1507,1510；bus.ts:8-44。
- 左栏：ProjectList.tsx:102-129,134-166；App.tsx:528-539,569-579,581-592。
- i18n：dict/index.ts（合并+en 强制）、dict.test.ts；dict/hooks.ts:4,142；settings.ts:10-11,23-25。
- CC 本机证据（2026-10-04）：`~/.claude/plugins/installed_plugins.json`（version 2、scope user、installPath→cache）；`~/.claude/settings.json` enabledPlugins（`name@marketplace`→bool）。
