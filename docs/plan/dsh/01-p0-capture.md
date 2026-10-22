# P0 — dsh 只读看板（会话发现 + 事件链 + 对话面板）

> 批目标：dsh 里跑一轮对话，weave 列表出现该会话、事件链有骨架、对话面板有两类气泡
> （用户 prompt / 本轮回答）。**不改 dsh、不装插件、不需要用户在 dsh 侧做任何配置**。
>
> 硬前置：R1（`LogSource` 形态）、R2（入库旁路）、R3（压缩收尾笔判据）已落地；
> 🔬1（根可解析）、🔬2（帧可增量解）已取证。

---

## §0 采集通道裁决

三条候选，逐条给否决理由（证据全部来自本地仓库 `deepseek-harness-master`）：

| 候选 | 能拿到什么 | 否决理由 |
|---|---|---|
| **A. `experimental/hooks-claude-code` 桥** | 7 个事件：`SessionStart` / `UserPromptSubmit` / `PreToolUse` / `PostToolUse` / `Stop` / `SubagentStart` / `SubagentStop` | ①**配置是进程级单份**（`src/index.ts:55-70`，`configPath` 注释明说「read once at load，相对路径相对进程启动 cwd」，per-session 发现还挂着 `TODO(per-session-hook-config)`）⇒ 没有项目级落点，要改用户的全局 profile；②`Stop` 的 payload 只有 `{session_id, transcript_path:'', hook_event_name, stop_hook_active}`（`src/index.ts:340-352`）——**没有 `last_assistant_message`**，`transcript_path` 恒空 ⇒ weave 的对话面板没有回答正文、中断判定也没有转录可读；③没有 `SessionEnd` / `PreCompact` ⇒ 退出清场与压缩态都缺；④hook 子进程有超时、且在事件路径上串行 ⇒ 违反「hook 路径不得阻塞」 |
| **B. 尾读会话日志**（选定） | 60+ 种 durable 事件，含 `turn/*`、`user/message`、`assistant/message`、`tool/*`、`compaction/*`、`approval/*`、`model/selection`、`session/title` | 唯一代价是解码与格式版本跟随（见 §1/§6），换来的是一等公民级的事实源 |
| **C. 原生插件上报事件** | 进程内能拿到更多（含内存态） | P1 本来就要写插件，但**采集不走它**：进程内事件是「presentation data rather than the replay source」（`packages/core/agent/README.md:67` 原话），durable 事实仍以日志为准；两条事实源会打架 |

**结论**：采集 = 日志尾读（B）；插件（P1）只做下行投递/中断/作答，**不重复上报事件**。

---

## §1 日志格式事实与读取策略

### 事实（引用处均在 dsh 仓库内）

| 事实 | 出处 |
|---|---|
| 持久化后端 `session-persistence-jsonl`，**`root` 必填、无默认值**（「`process.cwd()` 默认会把会话文件撒得到处都是」） | `packages/session/session-persistence-jsonl/README.md:43` |
| 布局 `<root>/--<normalized-cwd>--/<encoded-id>/session.vN.jsonl[.zstd]`；会话 id 被**单射转义**成一个安全路径段；归一后同名的 cwd 共享项目目录 | 同上 `:56-70` |
| 物理世代按文件名版本号递增，运行时**选数值最高的那个**；`stat/list` 带 `formatStatus` | 同上 `:71, :83` |
| `compression` 缺省 `'zstd'`（**校验和分帧**）；`'none'` = 明文 NDJSON，「外部 reader 可直接消费」 | 同上 `:45, :95` |
| 写入 = 每批 append **一个压缩帧**并 `fsync`；崩溃后留撕裂尾帧，**只取其中完整的 JSONL 记录**；已提交前缀永不重写 | 同上「Durability and crash semantics」 |
| 头部帧就是第一帧（`JsonlHeaderLine`），带格式版本；当前已发布 **V4** | `docs/persistence-catalog.md:22-23`；`docs/session-format-status.md` |
| 事件行 = 一个 durable 事件，`type` 用 `namespace/verb` 形态（60+ 种，字段逐项在 catalog 里） | `docs/persistence-catalog.md:25-86` |

### 读取策略（三条，够用且不会失控）

1. **世代选择**：进会话目录后按文件名里的 `vN` 取最大，认 `session.v<N>.jsonl[.zstd]`；
   不认识的更高版本 ⇒ 跳过该会话并在 `LogHealth` 里记一条「格式 V{n} 未支持」，
   **绝不半解析**（上游把「拒绝解释并指名绝对路径」当规范行为）。
2. **增量解码（游标 = `{offset, rows}`）**：从上次 offset 起的字节按**完整帧**解
   （🔬2 确认一帧一 append）；解出的行追加、offset 推进到帧尾。任何解码/校验错误 ⇒
   该文件**整份重解**一次并重置游标（撕裂尾帧按上游口径只取完整记录，丢弃残行）。
3. **卷控**：单轮单文件最多解 2MB / 8 帧，解不完下一轮继续（游标在内存里）；
   每轮只处理「上轮之后有明显 mtime 变化」的文件。

> 不用 `compression: 'none'` 那条路：它要改 dsh 全局 profile，影响所有 dsh 会话的
> 磁盘占用，且用户换机/重装就丢——把成本推给用户换我们省一个依赖，不划算。

**Node 门槛**：`zlib.zstdDecompressSync` 需 Node ≥22.15（backport 版本）。本计划把
根 `package.json`、`packages/weave-server`、`packages/weave-harness` 三处
`engines.node` 抬到 `>=22.15.0`（**项目所有者已裁决**）。运行期若真缺 zstd，
`LogHealth` 给一条「请升级 Node（当前 x.y）」，不抛栈。
顺带一条事实：**dsh 自己的 floor 更高**（`^22.19.0 || >=24.0.0`），所以真用 dsh 的人
本来就在 zstd 之上——抬 22.15 不会把 dsh 用户挡在门外。

---

## §2 事件词表 → core 的八张分列表

`HARNESS_EVENTS.dsh` 用**宿主原样名**（D2 裁决），只收**采集白名单**（§3）：

```ts
dsh: [
  'turn/start', 'turn/end',
  'user/message', 'assistant/message',
  'tool/call', 'tool/result',
  'compaction/start', 'compaction/end',
  'model/selection', 'permission/preset', 'plan/mode',
  'session/title',
  'approval/asked', 'approval/decided',
  'working-directory/change',
  'subagent/descriptor', 'subagent/catalog',
]
```

其余各表：

| core 表 | dsh 取值 | 依据 / 待证 |
|---|---|---|
| `HARNESS_LIFECYCLE.open` | `user/message` | 用户发话即开轮（`turn/start` 也可能被队列/steering 触发，不是「人发的话」） |
| `.close` | `['turn/end']` | 一轮结束的唯一 durable 收尾笔 |
| `.closeFailed` | `[]`（**失败靠载荷判**，见下） | 一轮的成败都在同一个收尾事件 `turn/end` 上，而 `closeFailed` 只能写事件名 ⇒ 写了就把每一轮都标红。C4 已结案：`turn/end.reason.kind` 七取值（`completed`/`aborted`/`blocked`/`error`/`max-tokens`/`interrupted`/`forked`），`normalize` 按 `{error, max-tokens, blocked}` 往 payload 填 `failed: true`。**这条依赖 D5**（`closeFailed` 含事件名 **或** payload 带 `failed`），`00` 已列 |
| `.sessionMarkers` | `[]` | 这张表是给「会话级开/合」事件（claude 的 `SessionStart`/`SessionEnd`）用的；dsh 的轮边界已由 `open`/`close` 覆盖，`turn/start` 只入事件链、不当标记（当标记会在每轮误关组） |
| `.subagentStop` | `''` | dsh 的子代理没有「停止」事件；`subagent/descriptor` 只描述存在 |
| `.questionTools` | `['ask_user_question']` | `packages/interaction/README.md` 的 `ask_user_question` 工具 |
| `.sessionExit` | `null` | 日志里没有会话退出事件（host 是 web/desktop 进程，生命周期与 UI 同）；P1 的插件桥靠 socket 断开判存活 |
| `HARNESS_COMPACTION` | `{ start: 'compaction/start', end: 'compaction/end', endSource: null }` | R3 落地后才能这么填 |
| `HARNESS_SESSION_CONTROL` | `{ modeNames: [], modelNames: [] }` | dsh 的模式是 `permission/preset` + `plan/mode` 两套，不是 claude 那种单一模式词表；🔬 拿到词表再填（P2 可选项），今天诚实地空 |
| `HARNESS_DIRS` | `{ projectDir: '.dsh', userDir: '.dsh' }` | 项目级 skills 在 `.dsh/skills`（`docs/subsystems/skills.md:70-74`）；用户级真实落点是 `$DSH_HOME`（**可被环境变量改**），P2 的 `AssetSurface` 运行时读 env，`HARNESS_DIRS` 只作缺省展示 |
| `HARNESS_INSTRUCTION_FILES` | `['AGENTS.md']` | `packages/context/agent-instructions/src/config.ts:12`：`['AGENTS.md','CLAUDE.md']`，主名是 AGENTS.md ⇒ weave 现有的 `AGENTS.md → CLAUDE.md` 链接**直接生效**，init 不需要新动作 |
| `INJECTABLE_EVENTS` | `[]` | dsh 没有 hook 注入面；插件的 `steer`/`inject` 走 P1 的桥，与这张表无关 |
| `TITLE_EFFECTIVE_EVENTS` | `[]` | 标题不走 hook 响应当场生效；dsh 的 `session/title` 是事件（入 → `applyReportedTitle`；出 → P1 插件 rename） |

### canonical raw 键（adapter 的职责，server/web 不改）

weave 的 web 侧读的是**归一化 payload 的固定键**（`web/src/lib/hook-payload.ts:116`
的 `turnSummaryOf` 读 `raw.last_assistant_message`，`promptOf` 读 `raw.prompt`）。
dsh 的 `normalize` 负责把宿主语义搬进这些键——**这是 adapter 的翻译工作，不是把
claude 的键名硬塞进 dsh**：

| 归一化 payload 键 | dsh 来源 |
|---|---|
| `eventType` | 行的 `type` |
| `prompt` | `user/message` 的文本块拼接——**只取 `source` 属于「人打的」那几种**（`user/message` 同时承载 `agent.inject()` 合成上下文与目标续轮，`docs/persistence-catalog.md` 明说三类；取值表见 🔬11） |
| `last_assistant_message` | 该轮**最后一条** `assistant/message` 的文本块拼接（`turn/end` 行落地时回填；见 §4 的「轮末回填」） |
| `toolName` / `toolInput` / `toolResponse` | `tool/call` / `tool/result`（截断口径沿用 claude 的 `capFields`） |
| `cwd` | 头部帧的 cwd（`working-directory/change` 之后取最新） |
| `seq` | 行的 `seq`（去重键，见 R2） |
| `raw` | 保留 dsh 原始行（同样的字段截断/脱敏规则） |

> `last_assistant_message` 的填法有个先后问题：`turn/end` 与 `assistant/message` 是
> 两条独立记录，回答文本先落、收尾笔后落。做法 = adapter 在**轮末**（`turn/end`）
> 产出那条事件时，把它前面已缓存的最后一条 assistant 文本填进去；`assistant/message`
> 自身不入库（白名单里保留它只为缓存，见 §3）。

---

## §3 采集白名单与卷控

**白名单**（只这些进 `hook_events`）：`turn/start`、`turn/end`、`user/message`、
`assistant/message`（仅用于轮末回填，**不单独入库**）、`tool/call`、`tool/result`
（只留 `toolName` + 成功/失败 + 时长，响应体截断）、`compaction/start`、`compaction/end`、
`model/selection`、`permission/preset`、`plan/mode`、`session/title`、`approval/asked`、
`approval/decided`、`working-directory/change`、`subagent/descriptor`。

**明确丢弃**（它们量最大、对看板零价值）：`request/header`、`request/context`、
`step/start|end`、`assistant/attempt`、`agent/inbox/*`、`llm/retry*`、`image/offload`、
`feedback/*`、`team/*`、`todo/write`、`goal/change`、`workspace/changes`、`job/*`、
`schedule/*`、`hook/invoked|result`、`system/message`、`developer/message`、`command/*`、
`deliverables/presented`、`session-log-deepseek/*`、`session/end-seed`、
`session/title-llm-request`、`web/*`、`tool-workflow/*`、`tool/ptc-dispatch*`。

> `team/*` 与 `subagent/*` 的完整可视化（dsh 的多 agent 协作）**不承诺**在本批：
> 后者只留 `subagent/descriptor` 一枚标记，前者整组丢弃。理由 = 没有真实数据判断
> 它们的量与 weave 画布的映射关系（列进 `04` 的「后续可选」）。

**首次发现某项目的回填**：见该项目第一次出现时，取**最近 20 个会话**、每会话只取
白名单事件、且每会话上限 2000 行；已回填过的项目记一行内存标记（重启允许重来，
去重键挡重复）。不回填 = 用户打开 dashboard 看到一片空白，会以为没接上。

---

## §4 dsh 模块清单（`packages/weave-harness/src/dsh/`）

| 文件 | 内容 | 关键约定 |
|---|---|---|
| `index.ts` | `DSH_DRIVER`：`id:'dsh'`、`displayName:'DeepSeek Harness'`、本批 `capabilities:['events','detect']`（P2 补 `assets`；`capture` 不含——dsh 没有安装物，采集健康走 `logs`） | 加进 `registry-wiring.ts:15` 的 `HARNESS_DRIVERS`（`satisfies` 催补） |
| `event-source.ts` | `DshEventSource implements EventSource`：`normalize(row, projectId)` → `HookEventInput`；白名单过滤；轮末回填；canonical raw 键映射（§2 表） | 纯函数、无状态（同 `ClaudeEventSource`） |
| `logs.ts` | `LogSource` 实现：`roots()`（跑 `--dump-config`，缓存 5 分钟）+ `scan()` + `health()` | **唯一出口**：server 任何地方都不得拼 dsh 路径 |
| `log-decode.ts` | 帧解码（`zlib.zstdDecompressSync` / 明文两路）、头部帧解析、世代选择、撕裂尾处理 | 与 `logs.ts` 拆开：解码可单测，不碰文件系统 |
| `detect.ts` | markers = `['.dsh']`（**不用 AGENTS.md**：它对任何 weave 项目都真阳性，`CLAUDE.md` 明令） | 与 `canStartSession` 无关 |
| `assets.ts` / `questions.ts` / `messaging.ts` | P2 / P2 / P1 才落地 | 本批留空文件或直接不建 |

cli 侧：`packages/weave-cli/src/init/harnesses/dsh.ts` = **空壳管线**（`weave init` 对 dsh
只写 `.weave/config.yaml` 的 `harnesses` 行 + 既有的 `AGENTS.md` 链接；不生成任何
dsh 文件），加进 `init/wiring.ts:19` 的 `HARNESS_INIT_TEMPLATES`。

### 加一个 harness 的落点清单（照这张表核，漏一个就编译失败或静默半接上）

| # | 落点 | 形态 |
|---|---|---|
| 1 | `core/harness.ts` 的 `HARNESS_NAMES` | 加 `'dsh'`（联合类型与 `isHarness` 由它派生） |
| 2~9 | 同文件八张 `satisfies Record<Harness, …>` 表 | `HARNESS_EVENTS` / `INJECTABLE_EVENTS` / `TITLE_EFFECTIVE_EVENTS` / `HARNESS_DIRS` / `HARNESS_INSTRUCTION_FILES` / `HARNESS_LIFECYCLE` / `HARNESS_COMPACTION` / `HARNESS_SESSION_CONTROL`（漏一行即编译失败） |
| 10 | `weave-harness/src/registry-wiring.ts:15` | `HARNESS_DRIVERS` 加 `dsh: DSH_DRIVER`（`satisfies` 催补） |
| 11 | `weave-cli/src/init/wiring.ts:19` | `HARNESS_INIT_TEMPLATES` 加 `dsh: DshInitTemplate` |
| 12 | web `lib/harness-meta.ts` | `HARNESS_UI` 加一行（页签顺序由键序派生） |
| 13 | web `components/tasks/lifecycle.ts` | 镜像三张表（`HARNESS_LIFECYCLE` / `COMPACTION` / `SESSION_CONTROL`），**改 core 必须同步这里** |

展示名不单独进 i18n：它归 driver 的 `displayName`；CLI 的 `harness.*` 词条都是诊断文案，
与 harness 名单无关。

web 侧：`web/src/lib/harness-meta.ts` 的 `HARNESS_UI` 加一行（显示名 / 配色 / 图标）。
`HARNESS_ORDER` 由该表键序派生，页签数组自动跟上。

---

## §5 会话发现与项目归属

1. **只采集「已接入 dsh 的 weave 项目」**：`daemon/project-harnesses.ts` 的
   `projectHarnesses(projectPath)` 含 `dsh` 才算候选（唯一读点，不新增探测）。
2. **根发现**：`roots()` = `dsh [--profile web] --dump-config` 输出里
   `@deepseek-ai/dsh-session-persistence-jsonl` 那一行的 `config.root`（🔬1）。
   失败回落：settings 覆盖项 `dsh.sessionRoot`（新键，缺省空）→ 都拿不到则
   `LogHealth` 报「找不到会话日志根」并给修法（手动填或确认 dsh 版本）。
3. **cwd → 项目**：优先取**头部帧里的 cwd**（真值），回落目录名 `--<normalized-cwd>--`
   （归一可能损信息：Windows 盘符/大小写）。归一化后与 `projectKey()`（`resolve()`）
   比较；命中就采，不命中即跳过（dsh 在非 weave 项目里的会话不进看板）。
4. **多根**：`roots()` 返回数组（🔬10 决定桌面版是否另有一根）；同一 sessionId 在两根
   都出现时取 mtime 更新的那份。
5. **sessionId**：用 dsh 的会话 id 原文（路径里那份是转义形态，**不从路径反推**）。

---

## §6 已知不接（诚实列出，避免"看起来接上了"）

| 项 | 原因 | 用户可见后果 |
|---|---|---|
| 从 weave「新建会话」 | dsh 没有 TUI、`resume` 槽为空 ⇒ `canStartSession: false`；会话由用户在 dsh web/desktop 里开 | 项目卡上的新建会话按钮对 dsh 置灰；会话仍会被自动发现 |
| 会话退出信号 | 日志里没有 `SessionEnd` 等价物 | 会话行按闲置/过期策略回收（`sessions.idleDays`），不即时消失 |
| 「已中断」第 7 态 | **不需要**：dsh 取消后照样落收尾笔 `turn/end`（`reason.kind = 'aborted'`），回合**真的关掉** ⇒ 不会像 claude 那样卡在「生成中」。而 weave 的 `interrupted` 态存在的前提正是「宿主不发收尾笔」，它的判据也绑在转录标记上（`SessionProbe.interruptedAt` ← 旁路上报的 `transcriptPath`），dsh 这条路整条不存在 | 取消后会话行直接回「打开」，事件链上那一轮带 `aborted` 收尾；**行上不会出现「已中断」tag**（若产品上要，得另立一条载荷判据并改 web 判据，不在本计划） |
| 崩溃/OS 杀掉进程 | 没有 `SessionEnd` 等价物，`interrupted`（崩溃孤儿补写）也可能压根没机会落 | 会话行按闲置策略回收 |
| 事件链的中间过程 | 丢弃 `step/*`、`request/*` | 画布只摆「轮 / 工具 / 压缩 / 审批」骨架 |
| 子代理与团队协作 | 见 §3 的「不承诺」 | 画布上看不出 dsh 的子 agent |
| 模型名标签 | `model/selection` 的取值形态待 🔬（可能是 route id 而非别名） | 顶部模型标签可能显示原始 id 或不显示 |

---

## §7 验收

1. `weave init`（选中 dsh）后 `.weave/config.yaml` 出现 `harnesses: [..., dsh]`，
   且**没有**任何新文件落进项目（除了既有 AGENTS.md 链接）。
2. dsh web 里对一个 weave 项目发一句 prompt、等它答完：weave 会话列表 1s 内出现该会话，
   标题取 `session/title`（没有就回落 id 前 8 位）。
3. 对话面板两条气泡（我发的 / 它的回答），内容与 dsh UI 一致；向上翻页可拿回填的历史。
4. 事件链摆出 `turn` 组与其中的工具节点；压缩位置有分隔。
5. `weave doctor` 的 dsh 一节：日志根可读、格式 V4 受支持、已读行数；把根改名后
   报「找不到根」并给修法（**升版/降级 path 都验**）。
6. 两个 daemon 重启（`weave daemon restart`）后不产生重复事件行。
7. 单测：`log-decode` 的帧边界/撕裂尾/未知版本三组；`event-source` 的白名单与
   canonical 键映射；`scan` 的 cwd 命中与大小写。
