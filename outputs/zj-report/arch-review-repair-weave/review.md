# 架构评审报告：weave 2026-11-16

## 评审配置

- **目标仓**：D:\GitRepo\AIRepo\weave（pnpm workspace monorepo，npm 包分发）
- **架构模型（archetype）**：软件项目（纯代码包仓，无固件/硬件产物；维度集 = A/B/C/D 四维 + E 通用三维合一）
- **规则文档**：CLAUDE.md（Architecture 节）、docs/ARCHITECTURE.md、docs/ARCHITECTURE-DETAIL.md；docs/DECISIONS.md 仅作合法例外与裁决对照，不作站立规则提炼源
- **检查单版本**：阶段 0b 五维检查单（经协调者确认，severity 权重 高3/中2/低1，每维 0–20）
- **执行方式**：五维并行只读 Explore 子 Agent（阶段 1b），主会话去重合并（不复查不改写）
- **skill**：zj:code:arch-review-repair 首次实机实验（反馈见附节）

## 评分表（三段对比）

| 维度 | S1 现状分 | S2 预估优化分 | S3 实际优化分 | S1′ 批2前 | S2′ 批2预估 | S3′ 批2后盲评 |
|---|---|---|---|---|---|---|
| A 分层与依赖 | 9 | 20 | 16 | 16 | 17 | 17 |
| B 能力面装配 | 15 | 20 | 14 | 14 | 16 | 17 |
| C 数据持久化 | 14 | 20 | 16 | 16 | 19 | 17 |
| D 前端协议 | 11 | 20 | 20 | 20 | 20 | 16 |
| E 闭环与交付 | 16 | 20 | 20 | 20 | 20 | 18 |
| **合计** | **65 / 100** | **100 / 100** | **86 / 100** | **86 / 100** | **92 / 100** | **85 / 100** |

> 修复批（2026-11-16）收尾：#1 ✅90023f11 #2 ✅7460d1bb #3 ✅3f54fc41（+补漏 a7fb8b69/7ff66f47）#4 ✅a2ece7ed #5 ✅41e3fa10 #9 ✅9ba7be99 #10 ✅43df2250 #11 ✅e341059c #12 ✅a8c9b61f #14 ✅c791841f #15 ✅5eb38731 #17 ✅0c9ff40c；追加单 #18 ✅5675a62f；#6/#7 按 DECISIONS 2026-11-15 豁免、#8 挂账、#13/#16 待裁决。S3 复核由三只盲评只读子 Agent 独立盘点（不见 S1/S2）。

S2 说明：假设修复顺序表全部完成（满分定义 = 该维度无未修复发现）。S1→S2 差值 35 分，主要收益来源 = **D 维（+9，桌宠域自建 SSE/轮询收敛与备份轮询裁决）与 A 维（+11，core 纯度与 server 散写键形收敛）**；B/C/E 各 +4~6。无高危发现，S1 未出现「断链/泄漏面」级扣分——四条闭环主链（事件采集/投递/问答/渲染块）静态走查全部逐跳走通。

S2→S3 偏差逐维解释（S3 = 86）：
- **A 20→16**：S2 假设「散写清零」，复核仍见 App.tsx:507 的 `harness === 'claude'` 业务计数（中）与 cli claude.ts:99 的 `.claude` 裸字面（低，同文件 codex.ts 已走表、写法不一致）——预估对「散写边角清零」过乐观；pet 忙判据（B/D 兼）按豁免不计入。
- **B 20→14**：复核口径比 S1 更细——pet/main.ts 忙判据自抄常量（中，豁免挂账但复核盲评仍算发现）+ hooks.ts 死分支散写（低）+ hooks 事件名手抄镜像无编译对账（存疑）压分；其中 pet 项按 DECISIONS 豁免属口径分歧，非真实回归。
- **C 20→16**：修复项（harness-config/inbox/promptbox 0600、backups 归口、索引）复核全过；扣分来自复核**新发现**——`.weave/token` 可重放凭据无 mode（中）与三处非敏感文件无 mode（低）——S2 无法预估修复期新账。
- **D 20 / E 20**：全过。pet 独立页壳按豁免口径判合法；2.1.287/MCP version/maxFragmentBytes 单源核过；闭环主链逐跳齐。
- 总偏差 −14：约半数来自「豁免/挂账项在盲评口径下仍计发现」（pet 三处 + 备份轮询），半数来自修复期新发现（token mode 等）——下次预估应把「豁免项继续计分」与「修复引入新账」两项计入。

## 发现总表（按 severity 降序）

无「高」。以下 [中] ×12、[低] ×10（子 Agent 原文合并去重；D2 桌宠三处轮询与 B1 pet 忙判据同源，分属各维保留）。

### 中（12）

| # | file:line | 维度 | 违反条款 | 实况 |
|---|---|---|---|---|
| 1 | packages/weave-core/src/platform.ts:1-2 | A | core 只有纯类型与表（零接口） | `node:os`/`node:path` import + 带逻辑的 `detectPlatform()` |
| 2 | packages/weave-core/src/utils/fs.ts:1-2 | A | 同上 | `node:fs/promises` 的 ensureDir/writeFileIfAbsent/fileExists IO 实现 |
| 3 | packages/weave-server/src/install/settings-mcp.ts:15,57-59 | A | harness 专属键形不得在 server 自拼 | 硬编码 `.claude/settings.json` + claude 三键（enableAllProjectMcpServers 等）读写逻辑，未走能力面 |
| 4 | packages/weave-server/src/rpg/provisioning.ts:113,120 | A | harness 专属路径不得在 server 自拼 | 自拼 `path.join(dir,'.claude','helpers')` 与 settings.json 路径（内容生成部分经 harness，路径散写） |
| 5 | packages/weave-server/web/src/pet/main.ts:172 | D | 前端唯一 EventSource = lib/sse.ts | 桌宠自建第二条 `new EventSource`，未走统一通道 |
| 6 | packages/weave-server/web/src/components/BackupSection.tsx:41 | D | 不得写前端自发取数轮询 | 备份进行中每 1s setInterval fetch |
| 7 | packages/weave-server/web/src/components/BackupOverlay.tsx:38 | D | 同上 | setInterval 周期 fetch /backup 状态 |
| 8 | packages/weave-server/web/src/pet/main.ts:1055 | D | 同上 | 桌宠 15s 周期拉 sessions/dispatches/questions 三路 |
| 9 | packages/weave-server/web/src/pet/main.ts:109-137 | B | `isSessionBusy` 会话忙判据单点 | 宠物域自算忙判据 + 自抄 `STALE_TURN_MS`/`ACTIVE_WINDOW_MS` 同值常量 |
| 10 | packages/weave-server/src/config/profiles.ts:70-73 | C | local/ 档本机 0600 | harness-config 快照（可能带 API key）writeFile 未带 mode，POSIX 落 0644；同目录其余凭据文件全带 0600 |
| 11 | packages/weave-server/src/hooks/mirror.ts:196-200 | C | 旁路凭据 0600 | `appendInbox` 逐行落 token 进 `<cache>/hooks/inbox/<shard>.jsonl` 无 mode（appendOutbox:223 / promptbox.ts:107 同形，内容非凭据降档） |
| 12 | packages/weave-server/src/hooks/toolkit.ts:90 | E | 宿主版本下限单一来源（ResumeCommandSpec.minVersion） | `MIN_MOD_HOST_VERSION=[2,1,287]` 与 weave-harness/src/claude/resume.ts:31 的 `minVersion:'2.1.287'` 平行双写互不引用 |

### 低（10）

| # | file:line | 维度 | 违反条款 | 实况 |
|---|---|---|---|---|
| 13 | packages/weave-server/src/watch/classifier.ts:20 | A | harness 专属路径不散写 | 字面 `'.claude/settings.json'` 做文件分类分支 |
| 14 | packages/weave-server/src/install/global-file-assets.ts:39 | A | harness 文件名清单不散写 | server 侧自造 `CLAUDE_FILES` 文件名清单 |
| 15 | packages/weave-cli/src/init/wiring.ts:31-33 | A | 槽清单权威（边缘） | 字面 `'init'` 槽名判断；`satisfies` 保证归口，倾向合规边缘 |
| 16 | packages/weave-server/src/daemon/hooks-routes.ts:82、daemon/routes/watches.ts:31-33、daemon/routes/extension.ts:241 | B | prompt 通道可用性派生单点 | 同一「queuedPrompt‖prompt‖terminal」表达式抄三份（仅能力展示非投递层序） |
| 17 | docs/ARCHITECTURE-DETAIL.md:447 | B | 文档与实现同步 | 文档称剥装饰唯一实现 `stripInboxMarker`，该符号已不存在；现行 = `normalizePromptText`（ack-gate.ts:312）+ web `stripPromptDecor` |
| 18 | packages/weave-server/web/src/lib/hook-payload.ts:73-83 | B | harness 文法归位 | claude 中继载荷文法（ONE_WAY_NOTE/RELAY_WRAP）在 web 手抄镜像，改动需三处同步 |
| 19 | packages/weave-server/src/db/db.ts:571-574 | C | 落盘点归口 paths.ts | 迁移备份自拼 `<data>/backups/`，与 paths.ts 的 `getBackupsDir()`（`<cache>/backups/`）语义冲突且注释与实现不一致 |
| 20 | packages/weave-server/src/repositories/sessions.ts:172 | C | 高频排序索引 | `ORDER BY last_seen_at DESC` 无可用索引（sessions 百行级，暂无痛感） |
| 21 | packages/weave-server/web/src/lib/back-pop.ts:58 | D | 路由实现唯一 = route.ts（灰区） | route.ts 之外第二处 `history.pushState`（同 URL state 标记，不改位置语义） |
| 22 | packages/weave-server/src/hooks/toolkit.ts:365,371 | E | 常量单点 | 用户文案里再硬编码两份 `'2.1.287'` 字符串 |
| 23 | packages/weave-server/src/daemon/mcp/registry.ts:58-80 | E | 版本串散写（存疑倾向） | 四内建 MCP server 硬编码 `version:'0.1.0'`（独立协议版本则合法，见存疑） |

## 核对通过项要点（按维度）

- **A**：A2 harness 唯一外向依赖仅 core（package.json:48-51）；A3 web 四处 harness 引用全 `import type`、core 0 value import；A4 `abstract class` 全仓恰 2 处且落点吻合（pipeline.ts:13、opener/backend.ts:100）；A6 槽清单唯一定义 driver.ts:12-34，web lifecycle.ts 镜像属规则明载例外。
- **B**：B1 十五个唯一实现点逐个核查单份成立（pluginKey 两实现为各 harness 槽件非重复；claude-liveness.ts 为规则明载 re-export 壳）；B2 codex messaging 全 null 通道带 unsupportedReasons（codex/messaging.ts:150-156）；B3 层序特征集中 message-deliverer.ts + delivery/send.ts，7 调用方只 `.send()`；B4 五张 core 表定义仅在 weave-core，capture 生成器 `JSON.stringify(INJECTABLE_EVENTS[...])` 现生成非手抄；B5 rewind 屏文法字面只在 rewind-ui.ts，server RewindPanels 零文法字面。
- **C**：C1 全仓 0 处绕 paths.ts 自拼数据目录；C2 auth/ai/push/decision/peer-tokens/certs/inbox-targets 全 0600 + 档位全对；C3 api-log REDACT_KEYS 覆盖规则清单且多覆盖两键、请求头只记 user-agent、settings 表无凭据（stripApiKey 拆走落 0600 文件）；C4 消息正文落库仅四处全部合法（session_messages 表已 DROP）；C5 seriesBySecond/listBySession/全局搜索三路索引全覆盖，无裸 created_at 全表扫。
- **D**：D1 例外外 0 命中（FilePicker 的 confirm 是局部函数）；D2 主通道 EventSource 仅 sse.ts:131，其余 setInterval 全为动效/时钟/心跳合法；D3 pushState/replaceState 仅 route.ts（back-pop 灰区另列）；D4 fragment 端点四道闸齐全（白名单根/isInsideDir/.html/2MB 常量）；D5 prefers-color-scheme 命中均为 weave 自身 auto 主题档 JS 监听与导出产物，合法；D6 作答三道闸齐全（zod 无裸键序字段 / ANSWER_TEXT 拒全部控制字符 / ANSWER_ATOM 封闭白名单 + deliverer 二次验）。
- **E**：E1–E4 四条闭环主链逐跳走通（inbox 写读同目录口径、ackedEventId 三跳齐、问答链全跳、渲染块含续投分支与 VIZ_MAX_BYTES 同常量）；E5 伞包自包含（pack-weave.mjs 收集 externals + bundleDependencies）、生成物路径插值无写死盘符、dist 双形态入口成立；E6 weave 版本走 WEAVE_VERSION 单源、maxFragmentBytes 唯一定义 core harness.ts:360 三处同引；E7 ensureDataLayout 只 rename 不删 + 活 daemon 不动、pushBackup 滚 20 份、privacy-scan 三兜底分支齐全、迁移幂等双重判重。

## 存疑待人工

1. **pet 域架构定位**（web/src/pet/）：独立 WebView2 小窗还是 web 前端管辖内？裁决决定发现 5/8/9 是否豁免（独立客户端则 D2/B1 的 pet 命中降档）。
2. **备份轮询例外**（发现 6/7）：用户显式长任务进度跟踪，与「后端驱动轮询」例外精神相近——进例外清单（规则文档补一句）还是收敛为 SSE 帧驱动，需裁决。
3. **orchestrations.nodes 内嵌 webhookToken / notify_channels.config 内嵌 secret**（db.ts:208-215）：表注释声明「认证门后有意回显重验」，是否算 §3「凭据不进库」的边界扩张，需人定并回写规则文档。
4. **GET /settings 回显 ai/decision apiKey**（settings-statusline.ts:50-55）：注释「掩码展示」与「密钥永不回显」自相矛盾；api-log 落盘侧已脱敏，行为本身是否合规需确认意图。
5. **内建 MCP server `version:'0.1.0'`**（registry.ts）：随 weave 发版（应接 WEAVE_VERSION）还是各 server 独立协议版本（合法），静态判不出意图。
6. **`MessagingChannel` 类型无 queuedPrompt/promptInbox 的 reasons 槽**（driver.ts:361-369）：claude `queuedPrompt:null`、codex `promptInbox:null` 无处写原因——「不支持也是面」的类型面缺口还是有意豁免。
7. **questions 槽的 `plan:null`/`permissionNotificationType:null`**（codex/questions.ts:95-97）：BlockingPromptSpec 无 reasons 字段，§2「不支持也是面」是否覆盖 questions 槽规则未明说。
8. **装饰归一出口三处并存**（prompt.ts / ack-gate normalizePromptText / web hook-payload.ts）：直投已不加前缀故当前自洽，但中继壳文法变更需三处同步；是否收紧单一归一出口需裁决。
9. **`WEAVE_SKIP_MOD_VERSION_CHECK=1` 旁路**（toolkit.ts:358）：运维兜底还是可误用的版本闸旁路，文档未声明。
10. **需运行时验证**：inbox 并发分片认领竞争、UPS 长文本「包含」匹配对宿主 chunk 拼接的实况、伞包 tgz 实装冷启动（externals 树 prune 后无缺模块）。
12. **S3 复核新增（修复期补发现）**：① `.weave/token`（registry.ts:36、rpg/provisioning.ts:493）写项目采集 token 无 mode——可重放凭据按 umask 0644 落盘（中）；② mirror write 分片 / daemon.json / uploads 无 mode（低，内容非敏感）；③ `~/.weave` statusline 模板与 `<dataDir>/statusline/` 双目录并存语义待统一（低）；④ rename 后未补 chmod 的口径不齐（mirror.ts:224、promptbox，Windows 下 rename 可能丢属性，低）；⑤ orchestrations webhook secret 明文落库的豁免边界（同存疑 3）。
13. **S3 复核新增（A/B 维）**：① App.tsx:507 组件内 `harness === 'claude'` 业务计数散写（中，修复期漏项）；② cli claude.ts:99 `.claude` 裸字面与同文件 codex.ts 走表不一致（低）；③ web hooks.ts `harness === 'codex' ? A : A` 死分支（低）；④ web hooks 事件名手抄镜像无编译对账、App.tsx:439 家目录白名单走查根清单归属，待人工裁定（存疑）。
11. **rpg expedition/merge-ladder/expedition-session 测试本机高波动**（修复期发现，非评审项）：基线与改动下各跑多轮失败集每轮不同（EPERM 清理临时目录 / 5s 超时类环境性失败，基线自己也失败）；修复按「相对基线不新增错误」口径收货，波动根因待查（疑似真 git 子进程 + Windows 目录句柄释放时序）。

## 修复顺序表

优先级链：归口缺位 > 散写收敛 > 部署一致 > 文档同步（无断链/泄漏/固化缺陷，故无第一梯队）。验证方式：`npx tsc --noEmit`（包根）+ web 的 tsc（改 web 必跑）+ 相关测试。

| 序 | severity | file:line | 违反条款 | 修法一句 | 验证 |
|---|---|---|---|---|---|
| 1 | 中 | core/src/platform.ts + utils/fs.ts | core 零接口纯度 | platform/fs 移出 core（落 harness 或 server 的 shared），core 留类型与表 | 两 tsc + core/harness 测试 |
| 2 | 中 | config/profiles.ts:70-73 | local 0600 | harness-config 写入口补 `mode:0o600`+chmod（对齐同目录其余凭据文件写法） | 单测断言 mode（Windows 下仅核对调用参数） |
| 3 | 中 | hooks/mirror.ts:196-200 | 旁路凭据 0600 | appendInbox 改走 writeJsonLedger 或补 mode:0o600 | 同上 |
| 4 | 中 | install/settings-mcp.ts:15,57-59 | 键形经能力面 | 三键读写下沉 claude ConfigSurface/AssetSurface，server 只传语义参数 | 两 tsc + settings 相关测试 |
| 5 | 中 | rpg/provisioning.ts:113,120 | 路径经能力面 | `.claude` 路径改经 harness 面（DIRS 表/能力面取） | tsc + provisioning 测试 |
| 6 | 中 | pet/main.ts:172 + 1055 | SSE 单通道 | pet 收编进 lib/sse.ts 单通道；15s 对账轮询改 SSE invalidate 驱动或并入统一客户端 | web tsc + 手动过桌宠 |
| 7 | 中 | pet/main.ts:109-137 | 忙判据单点 | pet 复用 isSessionBusy/deriveSessionStatus（或经 store 订阅），删自抄常量 | web tsc |
| 8 | 中 | BackupSection/BackupOverlay | 轮询裁决 | 待存疑 2 裁决：进例外清单（规则文档补条款）或改帧驱动 | doc-only 或 web tsc |
| 9 | 中 | toolkit.ts:90 | 版本下限单源 | MIN_MOD_HOST_VERSION 改引 ResumeCommandSpec.minVersion（或反向），文案两处从常量拼装 | tsc + toolkit 测试 |
| 10 | 低 | watch/classifier.ts:20、install/global-file-assets.ts:39、wiring.ts:31-33 | 散写收敛 | 三处字面改经 core 表/能力面（wiring.ts 可判合规不动） | tsc |
| 11 | 低 | hooks-routes/watches/extension 三处 | 派生单点 | prompt 通道可用性派生收敛为 deliverer（或 surfaces）一个方法 | tsc |
| 12 | 低 | ARCHITECTURE-DETAIL.md:447 | 文档同步 | stripInboxMarker 条目改写为 normalizePromptText + stripPromptDecor 现状 | doc-only |
| 13 | 低 | web hook-payload.ts:73-83 | 文法镜像 | 待存疑 8 裁决；不动则注释标注三处同步义务 | doc-only |
| 14 | 低 | db/db.ts:571-574 | 归口 paths.ts | `<data>/backups/` 进 paths.ts 立 getter（与 cache backups 分名），修正注释 | tsc |
| 15 | 低 | repositories/sessions.ts:172 | 索引 | 补 `idx_sessions_last_seen(last_seen_at)` 单列索引（量级小，可随下次 schema 迁移顺带） | 迁移测试 |
| 16 | 低 | web back-pop.ts:58 | 路由灰区 | 待裁决；倾向规则文档为「同 URL state 标记」补豁免句 | doc-only |
| 17 | 低 | mcp/registry.ts:58-80 | 版本语义 | 待存疑 5 裁决；若随 weave 发版则接 WEAVE_VERSION | tsc |
| 18 | — | install/role-manifests.ts（追加单） | persona 源头回写 | COORDINATOR_PERSONA 补「会话消息通道与等待纪律」节（照物化版逐字） | tsc |

### 修复进度（2026-11-16 修复批收尾）

- ✅ #1 `90023f11`（core platform/fs 移 harness shared）
- ✅ #2 `7460d1bb`（harness-config 0600）
- ✅ #3 `3f54fc41` + 补漏 `a7fb8b69` / `7ff66f47`（hooks 账面 0600）
- ✅ #4 `a2ece7ed`（MCP 三键族下沉 AssetSurface.mcpEnableRead/Write）
- ✅ #5 `41e3fa10`（rpg provisioning 经 HARNESS_DIRS）
- 🚫 #6 按 DECISIONS 2026-11-15「pet 维持独立页壳不改」豁免，本批不动（pet EventSource/轮询维持现状）
- 🚫 #7 同上豁免（pet 忙判据自抄常量维持现状）
- ⏸ #8 例外裁决挂账（备份轮询暂保留，待存疑 2 裁决后进例外清单或改帧驱动）
- ✅ #9 `9ba7be99`（CLAUDE_MIN_HOST_VERSION 单源 + 文案拼装）
- ✅ #10 `43df2250`（classifier/global-file-assets 经 HARNESS_DIRS；wiring 槽名 satisfies 钉死）
- ✅ #11 `e341059c`（MessageDeliverer.promptChannelOf 静态派生单点）
- ✅ #12 `a8c9b61f`（doc-only：normalizePromptText 现状改写）
- ✅ #14 `c791841f`（getDbMigrationsBackupDir getter + 注释一致化）
- ✅ #15 `5eb38731`（idx_sessions_last_seen 索引）
- ✅ #17 `0c9ff40c`（内建 MCP version 接 WEAVE_VERSION）
- ✅ #18 `5675a62f`（追加单：COORDINATOR_PERSONA 回写，独立 fix(chore) 提交）
- 未动（待裁决，doc-only 类）：#13 / #16（存疑 8/灰区裁决未下，维持现状）

## S3′ 批 2 盲评（2026-11-16）

豁免单（盲评提示只给豁免、不给旧分旧发现）：pet 三处（EventSource/轮询/忙判据，DECISIONS 2026-11-15）、备份轮询（挂账）、orchestrations/notify_channels secret 落库（存疑 3）、GET /settings 回显（存疑 4）、hook-payload.ts 文法镜像（挂账）、back-pop.ts pushState（灰区挂账）。

- **A 17**：五条硬规则全过、抽象类恰两处、core 零 node 实测零命中。扣分 = statusline.ts web 镜像群（WEAVE_VERSION='0.1.0' 已实际漂移，中）+ server hooks 管线散写事件名字面量（中）+ 插件路径/claude 特判等 7 低。
- **B 17**：四唯一实现点（层序/promptChannelOf/rewind 文法/TERMINAL_LOCATOR_ENV）全成立。扣分 = rpg 域 + DashboardOverview 六处内联重编 `running||compacting`（中）+ server 第二 pluginKey 拼装点带失实注释（低）+ mcp 路由 schema 手写 harness 枚举（低）。
- **C 17**：0600 全数合规（含本批 token/daemon.json/mirror/promptbox chmod 补记、uploads 0644）。扣分 = mirror.ts:166 MirrorWriter.write 独漏 mode+chmod（中）+ layout.ts mergeInto rmSync 与同名校验文件静默丢（低）+ inbox-worker 毒丸回写无 mode（低）。
- **D 16**：SSE 单通道/原生控件禁用/位置即 URL/作答三闸全过。扣分 = 全站大量裸 `<input>`/`<textarea>` 不走 ui/input.tsx（中，面广）+ VisualizationFrame 4s mtime 轮询（中，注释自认轻量轮询）+ 渲染块文法镜像未豁免（低）。
- **E 18**：四闭环主链逐跳全通、版本单源核过、privacy-scan 三兜底齐。扣分 = claude/config.ts MAX_BYTES 硬编码未引 VISUALIZATION_PROTOCOL.maxFragmentBytes（低）+ mergeInto rmSync（低，同 C-2）。

S2′→S3′ 偏差（−7）解释：D 维预估 20 过乐观——裸输入面与渲染块热更轮询是 S1/S3 两轮都未被点名的存量面（S3 轮 D 满分因当时检查单口径未覆盖）；C 维 −2 与 E 维 −2 为盲评新翻出的账面边角（MirrorWriter.write 漏 mode、MAX_BYTES 字面量）；A/B 均高于 S3 轮，批 2 修复被盲评确认生效。

## 修复批 2（2026-11-16，S3 复核新增项）

- ✅ 批1 `2b7cf75a`（`.weave/token` 可重放凭据落盘补 0600——registry.ts + rpg/provisioning.ts）
- ✅ 批2 `32c1c3a5`（App.tsx 项目档 mcp 计数改 installScopes 行判据，不点名 harness）
- ✅ 批3 `d6be9f97`（cli claude init `.claude` 目录走 HARNESS_DIRS）
- ✅ 批4 `a19b34d2`（web hooks.ts injectableEventsOf 死三元删除）
- ✅ 批5 `386819c4`（mirror/promptbox rename 落定后补 chmod 0600）
- ✅ 批6 `379f743e`（daemon.json 状态文件落盘 0600）
- ✅ 批7 `186320d7`（uploads 附件落盘显式 0644）
- 存疑 3（orchestrations/notify_channels secret 落库）、#13（web 文法镜像）、#16（back-pop 灰区）按裁决不动；pet 三处与备份轮询维持 DECISIONS 2026-11-15 豁免。

## skill 反馈（首次实机实验）

1. **「呈现给用户确认」在编排场景指代不明**：skill 写「用户」，实机跑在协调者-执行者两会话协作下，确认方实为派单会话。建议补「编排场景确认方 = 派单会话（或其转达的用户）」。
2. **DECISIONS.md 的角色未写明**：任务单把 DECISIONS.md 列进「站立规则文档」，但它按项目自身约定是带日期裁决记录（含被推翻旧结论），直接提炼会把历史结论当现行规则。本次处置：站立规则只取 CLAUDE.md/ARCHITECTURE(.md/-DETAIL)，DECISIONS 仅作合法例外对照。建议 skill 显式写明此类文档的角色。
3. **阶段 0b 三项输入已被派单预填时无跳过分支说明**：本次按已填处理未重复询问，skill 宜补一句。
4. **E 维「走通」的证据形态未定义**：闭环核对与 A–D 的 file:line 偏差盘点输出形态不同，skill 未说明通过证据长什么样；本次按「逐跳落点 file:line」作证据（可行，建议固化）。
5. **「核对身份类检查项先确认归口」条款实效好**（正面）：本次 B1 十五点核查未出现假不一致，条款保留。
6. example-checklist-weave.md 形态标杆有效，但内容已落后于目标仓现状（22 槽/rewind/ALS 等均新于旧单）——印证 skill「不硬编码进流程」的设计，建议给该参考件加「时效性提示」头注。
