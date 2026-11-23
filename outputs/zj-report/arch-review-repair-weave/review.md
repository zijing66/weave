# 架构评审报告：weave 2026-11-22

## 评审配置

- **目标仓**：`D:\GitRepo\AIRepo\weave`（基线 29b921d0，分组合并后 26 枚 tip）
- **Archetype**：软件项目（TypeScript pnpm monorepo：CLI + daemon/server + web + harness + SQLite + Runtime Host；无硬件信号）
- **规则文档**：站立规则 = 根 `CLAUDE.md` Architecture 节；机制细节 = `docs/ARCHITECTURE-DETAIL.md`（§1–§23）；`docs/DECISIONS.md` 仅作合法例外对照，不作提炼源
- **维度**：A 分层依赖 / B 能力面装配 / C 数据持久化 / D 前端协议 / E 闭环交付（通用三维 + 端点完备性），5 个只读子 agent 并行
- **计分口径**：5 维各 0–20；扣分 = 高 3 / 中 2 / 低 1；满分 = 该维无未修复发现
- **当批豁免/挂账项**（依据 DECISIONS / 规则文档既有裁决，S3 复核按合规处理但单列）：
  - `web/src/components/tasks/lifecycle.ts` 的 HARNESS_* 常量镜像（§5/§8 点名先例）
  - AI 助手 fetch-reader 独立流 + `text/event-stream` 第二 SSE 面（§13 明文；建议 §7 补点名）
  - 对话气泡长按留浏览器、span truncate 与 disabled 按钮原生 title（§9 裁决）
  - fragment mtime 4s 条件轮询（§20 明示机制）
  - 编排 secret / notify channel config 明文落 DB（DECISIONS 既有先例）
  - `use-conv-screen`/`back-pop` 手势辅助（待裁决，见存疑）

## 评分表（三段对比）

| 维度 | S1 现状 | S2 预估优化 | S3 实际复核（2026-11-22 盲评） |
|---|---|---|---|
| A 分层依赖 | 14 | 18 | 14（2 中 + 3 低 + 3 存疑） |
| B 能力面装配 | 16 | 19 | 13（2 中 + 1 低 + 2 存疑） |
| C 数据持久化 | 9 | 16 | 15（高已修 0b2af7f4 / 中已修 bd53036a，2 低未修） |
| D 前端协议 | 18 | 18（input.tsx 挂账） | 12（5 低，均为 matchMedia 归口与轮询形态类） |
| E 闭环交付 | 13 | 19 | 14（1 高 = 修复 16 时序缺陷已修 bda4071e；1 中登记缺项已补；1 低） |
| **合计 /100** | **70** | **90（预估，±2 余量未计）** | **S3′ = 68（修复前快照）；当批新增发现修复后 S3″ ≈ 76** |

**S2→S3 偏差解释（逐维）**：A −4——修复期没漏旧账，但盲评口径按「全仓扫描」翻出了 S1 检查单未覆盖的 web 侧四张手工镜像表（lifecycle.ts / harness-meta.tsx）与两处 harness 名硬分支（mcp-rows / toolkit）；B −6——同因：`new-session` 路由的第二份 headless 实现与 `combinedLivenessOf` 直连合并是「新增路由未按既有裁决收敛」类，S1 检查单未列；D −6——S2 把 D 估成挂账即满分，盲评全仓扫出 matchMedia 散调四处与 VisualizationFrame 轮询形态（S2 过乐观的主因）；C +（−1 vs 预估）——`pass` 键漏脱敏是修复 1 自身的漏网，属修复期新发现；E 高危时序缺陷是修复 16 自身引入、当场修掉（bda4071e）。**首跑校准结论**：修复期新发现约占 S3 偏差一半、盲评口径差占另一半，与首跑经验一致；S2 预估应按「每维 −2 新发现余量」计（本批实际 A/B/D 各 −2、C/E 各 −1，合计 −8 ≈ 校准值）。

**当批（S3 批）新增发现与处置**：
- [高→已修] REDACT_KEYS 漏 `pass`（notify-channels SMTP 密码随 config 回显落日志）— 0b2af7f4
- [高→已修] pack-weave manifestGaps 校验跑在 cp 之前恒炸（修复 16 自身时序缺陷）— bda4071e
- [中→已修] db.ts 迁移前 VACUUM 备份库无 0600 — bd53036a
- [中→已补] 三端点 ARCHITECTURE-DETAIL 登记（harness-install-status §8、delete-batch §14a、/terminals/ws §15）— 本提交
- [中→已修] `routes/projects.ts:196` new-session 第二份 headless 实现 → `spawnHeadlessInstance` 唯一执行核（session-open.ts 导出，new-session / resume / 「在终端中打开」三处共用；判据统一 terminalBackendFor().hostsSessions）— 0c7b97d4
- [中→已修] `daemon/liveness.ts` combinedLivenessOf 经 registry liveness 槽枚举（`LivenessSurface.aliveSync` 可选位：零 spawn 面自声明；第三 harness 自动吸收）— 4e37c05a
- [中→已修] web 四张镜像表漂移闸：`lifecycle-mirror.test` 测试态直引 core 原表逐键比对——**当场抓出 codex 条目已漂移**（subagentStop/sessionExit 停旧值）并修正 — 0681038b
- [低→已修] matchMedia 归口：`useIsCoarsePointer` 单点，摘 DirectoryPickerModal 快照裸调与 RpgView 局部双镜像；theme.ts（模块级单例）/pet（非 React 树）豁免 — 6e0e154a
- [低→已修] VisualizationFrame mtime 条件轮询口径入 DECISIONS（「组件挂载期 + 条件跳过 + 组件专属数据面」三齐即豁免）+ layout.ts mergeInto 措辞定案 + protocol.ts 格式 — 60a9165f

**S3″ 复核（小口径，只核当批改动）**：等价性全过；抓出 1 中 + 2 低已修 —— liveness 首拍从模块加载期挪进首次 combinedLivenessOf()（import 不再起锁探针，primed 随测试 reset）、openSessionTerminal 503 口径复原（spawnHeadlessInstance 补 missingSupervisorStatus）、镜像闸测试 import 合并 — a22912ae。

## 发现总表（severity 降序）

### 高（0 条）

无。七条主链路全部逐跳闭合、认证门无实际泄漏、凭据落盘卫生全过。

### 中（7 条）

1. **[C1+E1 合并] api-log 脱敏键形缺口** — `packages/weave-server/src/daemon/api-log.ts:24-35` — 违反「凭据类键一律 `[redacted]`（§3）」— `REDACT_KEYS` 缺 `authtoken`（onboarding/`harness-config/models` 的 `authToken` 经 toLowerCase 后不命中表内 `auth`）、`sendkey`（Server酱）、`webhooktoken`（编排 webhook 节点 body）、`privatekey`；上述键随 8KB body 捕获明文落日志。
2. **[C2] `Accept: text/html` 整段豁免宽于文档** — `packages/weave-server/src/daemon/server.ts:648-649` — 违反「豁免 = HTML 导航 + 真实静态文件（§12）」— 静态文件判定**之前**有 accept 含 text/html 即 true 的整段豁免，任何 API GET（`/api-logs`、`/settings`、`/visualizations/fragment`）带该头即绕过认证门；实现宽于文档，属豁免面过宽设计缺口。
3. **[A1+B1] web 按 harness 名硬判 MCP 卸载 scope** — `web/src/hooks/use-asset-mutations.ts:228` — 违反「web 不按 harness 名判（Architecture）」— `(agent ?? HARNESS_ORDER[0]) === 'claude' ? scope : 'user'`，服务端 `installCapabilities()`（market.ts:233）已派生该事实；第三 harness 非 user 级 MCP 落点会静默错置。
4. **[A2] CategoryDetail 按名二分 + capabilities 缺位** — `web/src/components/CategoryDetail.tsx:245,331,495,525,595-619` — 违反「不支持也是面 / web 不按名判」— `runtimeTab === 'claude'/'codex'` 换空态文案（合法）但 :245 `runtimeTab === 'claude'` 混进 personalization 行筛选逻辑，codex 未来出 personalization 面会静默漏行。
5. **[C3] runtime POSIX socket 手拼路径绕归口** — `packages/weave-server/src/runtime/protocol.ts:220-223` — 违反「落盘点一律先在 paths.ts 归档（§16）」— `path.join(dataDir,'cache',...)` 档位正确但归口缺位，paths.ts 无对应 getter。
6. **[D1] `ui/input.tsx` 存量普遍违反** — web/src/components 约 60+ 处裸 `<input` 文本框（SettingsModal/StatuslinePanel/ConfigValueRow/FederationSection 等）— 违反「文本输入框一律 ui/input.tsx（2026-11-03 裁决）」— ui/input.tsx 仅被 11 文件消费；属存量普遍状态，需裁决「豁免存量、新代码强制」还是排期全仓收编。
7. **[E2] 新增端点文档登记缺项** — `docs/ARCHITECTURE-DETAIL.md` — 违反「对外端点登记面（文档）」— `POST /projects/delete-batch`、`GET /harness-install-status`、`GET /visualizations/stats|cleanup`、`/notify/channels`、`/terminals/ws` 无 § 条目（delete-batch 与 harness-install-status docs 全域仅代码）。

### 低（11 条）

8. [A3] `install/global-config.ts:374` — `` `${pl.name}@${mp.name}` `` 裸拼插件键形，违反「唯一拼装点 = PluginSurface.pluginKey」；同文件 307/466 注释自认纪律但未对拼装侧生效——需补豁免裁决或挪进 harness 面。
9. [A4] `web/src/lib/api/hooks.ts:184-207` — `CLAUDE_HOOK_EVENTS` 是 `HARNESS_EVENTS.claude` 第二份手抄镜像（lifecycle.ts 之外），无文档豁免。
10. [B2] `daemon/ai-routes.ts:273` — 第二个 `text/event-stream` 写头点；§13 明文合法但 §7 字面未点名该例外（文档同步）。
11. [B3] `web/src/components/BackupOverlay.tsx:38` / `BackupSection.tsx:51` — 备份进度 1s 条件轮询，不在 §20 轮询豁免清单，DECISIONS 无条目——补豁免记录或改 SSE 帧。
12. [C4] `runtime/host-server.ts:61` `<data>/runtime-host.json`、`daemon/metrics-sampler.ts:292` `metrics-history.json`、`statusline/manager.ts:48` `~/.weave/statusline.json` — 三处落点 §16 三档表未列（归口/档位本身正确或可辩护）。
13. [C5] `repositories/uploads.ts:130` — `save()` 直接 `writeFileSync` 无 tmp+rename，中断留「名字=sha256、内容半截」坏件且 existsSync 永不自愈；分块路径 `adoptFromFile` 已正确。
14. [C6] `hooks/inbox-worker.ts:234` — claim 重写缺 `mode:0o600`，重写后权限回落 umask（内容为投递正文）。
15. [C7] `daemon/backup.ts:388` — 备份包写盘未设 mode（0644），包内含带 token 列的 weave.db。
16. [E3] `docs/DECISIONS.md` — 归档永久删除（4184b423 / 34d09f60）无裁决条目，违反「带日期定案进 DECISIONS」惯例。
17. [E4] `server.ts:641-645` — federation 豁免清单逐条枚举无单测守卫，新增豁免靠人工同步（现状无泄漏）。
18. [E5] `weave-templates/copy-templates.mjs` — manifest 与产物一致性无自动化校验（pack-weave 整目录 cp 兜底）。

## 核对通过项要点

- **A**：harness 外向依赖仅 core（23 处 import 全 core，core 零系统 IO import）✅；web value import 全仓仅 1 处且实为 type 续行 ✅；键形拆解全走 parsePluginKey、marketIdOf 唯一 ✅；abstract class 恰两处（注意实际落点 opener/backend.ts，文档写 opener.ts 待同步）✅；server 无业务 harness 名分支 ✅；HARNESS_* 镜像仅 lifecycle.ts 一处 ✅。
- **B**：HarnessCapability 恰 22 槽一字不差 ✅；unsupportedReasons 三层（面/装配/web 渲染）贯通 ✅；liveness 判据全在 harness、server 纯并图 ✅；rewind server 零转录解析 ✅；编排/watch/extension 全经 deliverer.send ✅；terminalBackendFor 唯一构造地、无旁路 new ✅；EventSource/WebSocket 各唯一、upgrade 单点 ✅；词表生成物带头齐全、运行时不联网 ✅。
- **C**：dataRoots 全 getter 逐落点核对无档位错置 ✅；11 处凭据文件全部 tmp+rename+0600 ✅；消息域零 INSERT（side_questions 唯一例外）✅；上传引用计数与三处触发点正确 ✅；快照 local 档 + 20 份备份 + scan-cache root 校验在位 ✅；fragment 白名单 + isInsideDir 跨盘安全 + maxFragmentBytes 单一常量四处同取 ✅；索引/缓存 TTL 与清理在位 ✅；capFields 4KB 与 edits 限流常量单点 ✅。
- **D**：原生 confirm/alert/prompt 全仓 0 命中 ✅；EventSource/WS/历史 API 单点 ✅；移动端八条逐条核对通过（dvh/传感器分流/长按/双击例外/pull-load 唯一实现）✅；harness 名命中均为常量镜像与展示分支 ✅；fragment srcdoc+CSP+sandbox、导出 HTML 全转义+safeHref+无外部资源 ✅；dangerouslySetInnerHTML 唯一命中且输入已过滤 ✅。
- **E**：七条主链路（init/采集/投递/终端/问答/归档删除/编排）逐跳链闭合 ✅；孤儿能力清点零死链（新增端点全有消费点）✅；部署脚本引用文件全存在、无本机路径固化、端口语义一致 ✅；版本单一来源 + bump 七处写齐 + pack 幂等 + prebuilds 裁剪有测试 ✅；认证门逐接口对照（/health /auth /webhooks token /federation per-peer /mcp /terminals/ws upgrade）全真实校验 ✅；FEDERATION_SERVICES 8 行与分发 8 分支差集为零 ✅。

## 存疑待人工

1. `api-log.ts:24` — `authToken` 漏脱敏需运行时验证：实测一次 POST /harness-config/models 后查 api-logs 是否明文（静态已判高概率泄漏，修复不依赖验证结论）。
2. `repositories/hook-dispatches.ts:42` — `hook_dispatches.prompt` 列落投递正文：D3 规则派发审计账 vs「消息域不落库」例外只有 side_questions 的规则文本，需裁决补例外。
3. `server.ts:649` — `Accept: text/html` 豁免是有意设计还是应收敛到「静态文件存在才豁免」（发现 2 的修复方向需用户定：改代码收敛 or 文档如实放宽）。
4. `web/src/lib/back-pop.ts:58` — 返回手势栈独立 pushState，算不算「位置即 URL」第二实现（语义上压标记条目、不改落点）。
5. `StatuslinePanel.tsx:409` — 裸 PointerSensor 未按指针分流（桌面设置页内拖拽，触屏降级为短距拖动），需验机定性。
6. `hooks/toolkit.ts:203` — `harness === 'claude' && isCcPluginPack` 特判：合法形状耦合还是应下沉 surface 语义。
7. `routes/market.ts:229-231` — `pluginSurfaceOf` 的 claude 注入回落（自称存量测试形态），建议随存量测试清理收编。

## 修复顺序表

按优先级链：泄漏面 > 归口缺位 > 散写收敛 > 部署一致 > 文档同步。

| # | sev | file:line | 违反 | 修法一句 | 验证 |
|---|---|---|---|---|---|
| 1 | 中 | api-log.ts:24-35 | 脱敏键形缺口 | ✅ cfc5a59c REDACT_KEYS 补 `authtoken`/`sendkey`/`webhooktoken`/`privatekey`（精确键，toLowerCase 后比对） | api-log 测试全绿 |
| 2 | 中 | server.ts:648-649 | 豁免宽于文档 | ✅ cd633888 豁免收敛到「公开端点 + 真实静态文件」；未认证导航回 SPA 外壳（isNavigationRequest） | static-api / dashboard-auth 测试 17+ 绿 |
| 3 | 中 | use-asset-mutations.ts:228 | web 按名判 scope | ✅ 0f2a15a1 handleUninstallMcp 改经 capabilitiesOf('mcp') 派生 | web tsc |
| 4 | 中 | CategoryDetail.tsx:245 等 | 按名二分混进筛选 | ✅ ac79266a personalization 面显隐与 mcpUpdates 过滤改经能力矩阵；文案分支保留 | web tsc |
| 5 | 中 | runtime/protocol.ts:220 | 路径绕归口 | ✅ e3bf4f8f paths.ts 补 getRuntimeSocketDir，ipcPathFor 改调用 | 包根 tsc |
| 6 | 低 | uploads.ts:130 | 无 tmp+rename | ✅ 0866bfbb save() 补 tmp+rename 同盘原子写 | repositories 测试 19 绿 |
| 7 | 低 | inbox-worker.ts:234 | 重写缺 0600 | ✅ 8a96826d writeFileSync 补 mode 0o600 | 包根 tsc |
| 8 | 低 | backup.ts:388 | 备份包 0644 | ✅ 8a96826d 写盘补 mode 0o600 | 包根 tsc |
| 9 | 低 | global-config.ts:374 | 键形裸拼 | ✅ d4f2fe9d 改经 pluginSurfaceFor('codex').pluginKey | install 测试 196 绿 |
| 10 | 低 | web api/hooks.ts:184 | 第二镜像 | ✅ 6f7f2b67 删镜像，直引 core HARNESS_EVENTS.claude（源码 alias 既有） | web tsc |
| 11 | 低 | 三处落点 | §16 表缺行 | ✅ f65a3380 §16 表补 runtime-host.json（data 档）/metrics-history.json（cache 档）/~/.weave/statusline.json | doc-only |
| 12 | 低 | DECISIONS.md | 删除裁决缺条目 | ✅ f65a3380 补 2026-11-22 永久删除裁决条目 | doc-only |
| 13 | 低 | ARCHITECTURE-DETAIL §7 | AI SSE 例外未点名 | ✅ f65a3380 §9 订阅拆面句补「AI fetch-reader 流是第二 SSE 面（§13）」 | doc-only |
| 14 | 低 | BackupOverlay/Section | 轮询无豁免记录 | ✅ f65a3380 DECISIONS 补「备份进行中条件轮询豁免」（页面专属短命任务态，不扩 SSE 帧） | doc-only |
| 15 | 低 | server.ts:641 | 豁免无守卫 | ✅ 059c60f4 补「豁免清单与 federation per-peer 门一致」单测（带 auth 实例验 401 语义） | federation-routes 测试 6 绿 |
| 16 | 低 | copy-templates.mjs | manifest 无校验 | ✅ 3b69abce packWeaveTgz 循环内 manifestGaps 校验（main/types/bin/exports 引用文件须真实存在）；时序缺陷盲评抓出已修 bda4071e | pack-weave 测试 5 绿 |
| 17 | 中（挂账） | web 60+ 处裸 input | ui/input.tsx 纪律 | 用户裁决：存量豁免（新代码强制）写入规则文档，或排期全仓收编 | ✅ 15a5b533+79a3ba20（2026-11-22 全仓收编：73+1 处文本框换 `<Input`，checkbox/radio/file/color/range 与 ui/ 基础件内部豁免） |

## S1→S2 主要收益来源

C 维（9→16）：脱敏缺口、豁免收敛、归口补齐三条中项 + 三个低项全可修；E 维（13→19）：文档登记与守卫类全 doc-only/单测可清。D 维保留扣减（input.tsx 挂账）。
