# dsh（DeepSeek Harness）接入：总览与优先级

> 计划状态：待执行。本目录是可落档的执行计划，按优先级排序；每一批都能独立开工、
> 独立提交、独立验收。标注 🔬 的条目是**必须先实机取证**的未知量（见
> [`04-empirical-checks.md`](./04-empirical-checks.md)）。
>
> **基线分支 = `main`**（与 `feat/zcode` 互不阻塞：两边各加自己那一行 core 表，
> 冲突面只在相邻行）。**接入深度 = 全量 P0~P2**，含随包发布的原生插件
> `@weavecode/dsh-plugin`。**Node 门槛抬到 `>=22.15`**（会话日志默认 zstd，
> 需 Node 内置 `zlib.zstdDecompress`）——三条都已由项目所有者裁决。

## 先对齐一条事实：发布面**没有** TUI

有人提到「要对接的是 TUI 的 `@deepseek-ai/dsh`」——上游自己的记录是**TUI 已被删除**，
两条裁决（都在本快照里）：

- `.agents/notes/archived/simplification/2026-08-03-explicit-config-dsh-entrypoint.md`
  —— "The CLI no longer ships a TUI application."（TUI 的 launcher、首跑 onboarding、
  app 级 PTY 夹具、终端旅程与 snapshot 一组全删）
- `.agents/notes/archived/simplification/2026-08-04-remove-tui-package.md`
  —— "The `packages/ui/tui` package is deleted without a compatibility package or alias."
  （`@deepseek-ai/dsh-tui` 连 SDK 接口一起删，**不留兼容包与别名**）

可复核的旁证三条：本快照 `packages/ui/` 不存在、全树无 `pi-tui` 引用；npm 上
`@deepseek-ai/dsh-tui` **404**，而该 scope 的首次 npm 发布是 2026-08-10（**晚于**摘除日
2026-08-03/04）⇒ 任何已发布版本都没有 TUI；`dsh --help` 里那些 `dsh tui …` /
`dsh plugin --profile tui …` 只是「自定义 profile 名」的举例，用 `tui` 当占位名
（`apps/cli/src/args.ts:96-99`、`docs/cli-help.md:54-57`），不是随包 profile。

⇒ 本计划按**发布面唯一的人工前端 = Web（浏览器）/ Desktop（Electron）**写。若实际要接的是
别处拿到的 TUI 构建（自建分支 / 内部包 / 旧镜像），**先说明来源再改计划**——形态会整体翻转：

| 面 | 没有 TUI（今天，本计划） | 有 TUI（假定） |
|---|---|---|
| 投递 | 进程内插件桥（P1） | **层② 终端** `sendText`/`sendKeys`，插件桥降为可选 |
| 中断 | 桥 `cancel` | 一记 ESC（同 claude） |
| 作答 | 结构化作答 API（`answerKind: 'structured'`） | 模态框键序（`answerKind: 'keys'`，同 claude） |
| 采集 | 会话日志尾读（`01`） | **同**（durable 日志与前端无关） |
| 定位 | 不需要 | `TERMINAL_LOCATOR_ENV` 那套 + 标题/cwd 回落 |

## Context

用户要求：把 `D:\GitRepo\AIRepo\deepseek-harness-master`（DeepSeek Harness，
`@deepseek-ai/dsh@0.2.1-rc.2`，MIT，developer preview）接成 weave 的下一个 harness，
**先体检抽象适配层、再排完整批次**。上游仓库 = `deepseek-ai/deepseek-harness`。

## 为什么值得接（结论回顾）

dsh 是**唯一把「会话历史」当一等 citizen 落成可读格式的 harness**——这恰好是 weave
看板最缺的东西：

- **append-only 会话日志**：每会话一份 `<root>/--<cwd>--/<encoded-id>/session.vN.jsonl[.zstd]`，
  一行一个 durable 事件，`docs/persistence-catalog.md` 把**全部 60+ 事件类型连字段**
  都列成了生成物（`turn/start|end`、`user/message`、`assistant/message`、`tool/call|result`、
  `compaction/*`、`approval/asked|decided`、`model/selection`、`session/title` …）；
- **格式版本显式**（`SESSION_FORMAT_VERSION` = V4 已发布，带迁移器与 `formatStatus`），
  外部读取被上游**明确允许**：`compression: 'none'` 就是「给外部 reader 吃的 NDJSON」
  （`packages/session/session-persistence-jsonl/README.md:95`）；
- **进程内能力面齐**：`ctx.sessionController` 能对**冷/热会话**做 prompt / 队列改写 /
  cancel / rename（`packages/api/session-controller/README.md`），`ctx.approval` 是
  fail-closed 的阻塞审批面（`packages/interaction/README.md`）——即：**投递与作答不必靠
  终端击键**，靠一个进程内插件就行；
- 指令文件读 `AGENTS.md` → `CLAUDE.md`（`packages/context/agent-instructions/src/config.ts:12`），
  项目级 skills 落 `.dsh/skills`（`docs/subsystems/skills.md:70-74`）——weave 现有
  `AGENTS.md → CLAUDE.md` 链接与 skills 装面都能直接复用。

## 三个独立于「怎么接」的关键结论

**C1 — 没有随包 TUI，因此没有「层② 终端」**（`apps/` = `cli`/`desktop`/`desktop-host`/
`web`/`plugin-market-generator`；npm 上 `@deepseek-ai/dsh-tui` 404；`docs/cli-help.md`
里的 `dsh tui` 只是「自定义 profile 名」的举例）。会话跑在**浏览器/Electron UI** 里，
host 进程没有可打字的 pane。⇒ 投递必须走**进程内插件**，`/interrupt`、`sendKeys`
这一整层对 dsh 不成立。

**C2 — 采集不能靠 hooks bridge，只能自己读日志**（证据见
[`01-p0-capture.md`](./01-p0-capture.md) §0）：dsh 的两个 hook 兼容层
（`experimental/hooks-claude-code`、`hooks-codex`）是**进程级单份配置**
（`config.ts` 的 `configPath` 注释 + `TODO(per-session-hook-config)`），且 `Stop` 的
payload 只有 `{session_id, transcript_path:'', hook_event_name, stop_hook_active}`
（`src/index.ts:340-352`）——**没有 `last_assistant_message`，`transcript_path` 恒空**，
weave 的对话面板与中断判定都无从取数。事件覆盖也只有 7 个，`SessionEnd` /
`PreCompact` 都没有。

**C3 — dsh 没有项目级配置面**：hooks、MCP 都只在 **profile**（`$DSH_HOME/profiles/<name>`
的 `cordis.patch.yml`）里声明，`mcp-client` 一行一个 server
（`packages/mcp/mcp-client/README.md:12`）。项目本地只有 `.dsh/skills`。
⇒ weave 的 MCP 装卸面对 dsh **诚实置灰**（写用户全局 profile 会波及所有项目），
`AGENTS.md` 与 skills 装面照常。

## 与 claude / codex / zcode 的结构差异

| 差异 | claude | codex | zcode | **dsh** |
|---|---|---|---|---|
| 交互面 | TUI | TUI | TUI | **浏览器 UI / Electron**（无 TUI） |
| 采集通道 | 项目级 hook 脚本 → inbox | 无 | 用户级 hook 脚本 → inbox | **daemon 直读会话日志** |
| 采集是否要装东西 | 要（init 生成脚本） | — | 要（用户级） | **不要**（`weave init` 只登记项目） |
| 会话存储 | JSONL 转录（尾读 64KB） | 无 | SQLite | **zstd 分帧 NDJSON，V4，带格式状态** |
| 回合收尾信号 | `Stop.raw.last_assistant_message` | — | 同 claude | **`turn/end` + 该轮 `assistant/message`** |
| 压缩信号 | `PreCompact` / `SessionStart(source=compact)` | — | 同 claude | **`compaction/start` / `compaction/end`**（无 `source` 键） |
| 投递层 | ① socket 直投 + ①中继 + ②终端 + ③队列 | ②终端 | ②终端 + ③队列 | **①插件桥 + ③队列**（无 ②） |
| 作答面 | 模态框键序 | — | 模态框键序 | **结构化 API**（`ctx.approval` / user-questions），不需要键序 |
| 项目级资产 | `.claude/` | `.codex/` | `.zcode/` | **`.dsh/skills`**（其余用户级） |
| MCP | 两档两份 JSON | `config.toml` | 同 claude | **仅 profile 级** ⇒ 置灰 |
| 指令文件 | `CLAUDE.md` | `AGENTS.md` | `CLAUDE.md` | `AGENTS.md`（主名，与 codex 同） |

## 优先级与依赖

```
R1 采集面「自读」变体 ─┐
R2 入库旁路复用（worker）├─→ P0 只读看板 ─→ P1 原生插件/投递 ─→ P2 问答/资产
R3 压缩表 endSource 可空 ┘        （P1 需要 P0 的 dsh 模块；P2 需要 P1 的桥）
```

- **R 批次与 dsh 解耦**：修的是「第 4 个 harness 会撞到」的结构性假设，与 dsh 名字无关；
  先落可以把 P0 的改动面压到「只加一个 harness 目录 + 八张分列表各一行」。
- **P1 硬依赖 P0**：插件不采集事件（事件已由日志尾读覆盖），只做**下行**；但下行要按
  `sessionId` 寻址，而那套 id/cwd 事实是 P0 打下的。
- **P2 硬依赖 P1**：作答与投递共用同一条插件桥协议。

## 批次总表

| 批 | 目标 | 主要改动面 | 依赖 | 工作量 | 可验信号（摘要） |
|---|---|---|---|---|---|
| **R1** | 采集槽支持「daemon 直读」harness | `driver.ts` 加 `LogSource`（`roots/scan/read`）+ `CaptureSurface` 增「无安装物」表达能力 | — | 1 天 | dsh 驱动声明后，`weave doctor` 报「日志可读/根已找到」而不是「采集脚本缺失」 |
| **R2** | 入库通道可被第二个生产者复用 | `inbox-worker.ts` 内加旁路 poller + `cwd → project` 解析；`hook-pipeline.ts` 不改 | R1 | 0.5~1 天 | 手工往会话日志追加一行，dashboard 200ms 内出现事件 |
| **R3** | 压缩收尾笔不要求 `raw.source` | `core/harness.ts` 类型 + `web/lib/.../lifecycle.ts:79 isCompactionEnd` | — | 0.5 天 | 只填 `end` 的 harness 也能在对话面板画出压缩分隔 |
| **P0** | dsh 只读看板（会话可发现、事件链、对话面板） | engines 抬版、core 八表加行 + web 镜像、`weave-harness/src/dsh/`、`cli/init/harnesses/dsh.ts`、web `harness-meta` | R1~R3、🔬1~🔬5 | 3~4 天 | dsh 里跑一轮对话，weave 列表出现会话、事件链有骨架、对话面板两条气泡 |
| **P1** | 原生插件 + 投递/中断 | 新包 `packages/weave-dsh-plugin/` + server 桥（socket）+ `MessageDeliverer` 接线 | P0、🔬6~🔬8、🔬11 | 4~5 天 | 从 dashboard 发一条 prompt，dsh 会话面板里出现且开始跑；停止按钮能 cancel |
| **P2** | 问答/审批 + 资产面 | `dsh/questions.ts`、`dsh/assets.ts`、插件 `approval` 接线 | P1、🔬9~🔬10 | 2~3 天 | weave 弹窗能答 dsh 的审批；`.dsh/skills` 能装能卸；MCP 页签诚实置灰 |
| — | 不承诺 | 从 weave 新建 dsh 会话、dsh 团队（`team/*`）协作面可视化 | — | — | 见 `01` §6 的「已知不接」 |

## 实测前置（🔬）

全部手法与判据见 [`04-empirical-checks.md`](./04-empirical-checks.md)。摘要：

| 编号 | 未知量 | 阻塞哪批 | 现状 |
|---|---|---|---|
| C1 | 有没有随包 TUI（决定层② 是否存在） | 全部 | ✅ **已结案：没有** |
| C2 | hooks bridge 能否供 weave 采集 | P0 | ✅ **已结案：不能**（进程级配置 + 无 assistant 文本） |
| C3 | dsh 有没有项目级配置面（决定 MCP 装卸做不做得了） | P2 | ✅ **已结案：没有**——hooks / MCP 只在 profile 里，项目本地仅 `.dsh/skills` |
| C4 | 收尾笔能不能区分「正常 / 失败 / 被中断」 | P0/P1 | ✅ **已结案：`turn/end.reason.kind` 七取值已发布**（`completed`/`aborted`/`blocked`/`error`/`max-tokens`/`interrupted`/`forked`） |
| 🔬1 | `dsh --dump-config` 能否解析出会话日志 root（且 web/desktop 用哪份 profile） | P0 | 待测（**硬前置**） |
| 🔬2 | 日志是否为「一批一帧」的独立 zstd 帧，Node 内置能否逐帧增量解 | P0 | 待测（**硬前置**） |
| 🔬3 | 头部帧是否带真 `cwd` 与 `sessionId`（盘上目录名是有损归一） | P0 | 待测 |
| 🔬4 | C4 的实测核对（真跑一遍 completed / aborted / error） | P0 | 部分结案，待实测核对 |
| 🔬5 | `assistant/message` 的 content block 形状（取文本、剥 thinking/tool） | P0（面板质量） | 待测 |
| 🔬6 | 插件能否拿到**每次 durable append**（不只是内存态事件） | P1 | 待测 |
| 🔬7 | `sessionController.prompt` 对 **live** 会话的语义（排队/打断/接收回执） | P1 | 待测（**硬前置**） |
| 🔬8 | 插件包的安装形态（`link:` / 私有 registry）与 `engines.dsh` 准入 | P1 | 待测 |
| 🔬9 | `ctx.approval` / user-questions 的作答接口能否由插件代为 resolve | P2 | 待测 |
| 🔬10 | dsh 桌面版与 web 是否共用同一 root（决定要不要多根支持） | P0/P2 | 待测 |
| 🔬11 | `user/message.source` 的取值表（区分人打的 / weave 投的 / 合成注入） | P1（回执判据） | 待测 |

## 文档索引

| 文件 | 内容 |
|---|---|
| [`00-abstraction-gaps.md`](./00-abstraction-gaps.md) | R1~R3 三处抽象缺口：现状证据 / 目标形状 / 验收 / 风险 / 提交切分 + D1~D6 待裁决点 |
| [`01-p0-capture.md`](./01-p0-capture.md) | P0 只读看板：采集通道裁决、日志格式事实、事件映射表、采集白名单、dsh 模块清单、降级项 |
| [`02-p1-plugin-delivery.md`](./02-p1-plugin-delivery.md) | P1 原生插件：为什么必须进程内、包形态、桥协议、`MessageDeliverer` 接线、中断 |
| [`03-p2-questions-assets.md`](./03-p2-questions-assets.md) | P2 问答/审批与资产：结构化作答面、`.dsh/skills` 两档、MCP 为什么置灰 |
| [`04-empirical-checks.md`](./04-empirical-checks.md) | 全部 🔬 的手法与判据 + 已结案 C1/C2/C4 的证据链（C3 见上文「关键结论」） |

## 与既有文档的关系

- 本目录只写「怎么接 dsh」与「接之前先修什么」，**不重复** `docs/ARCHITECTURE.md`
  的十一槽口径；槽清单仍以 `driver.ts` 的 `HarnessCapability` 为唯一权威。
- 落地过程中产生的**带日期裁决**（例如「为什么 dsh 不注册 `resume`、`statusline`、
  `sideQuestion`」「zstd 增量解码实测数据」「插件桥为什么用 socket 而不是文件 spool」）
  按仓库约定写进 `docs/DECISIONS.md`，不留在本目录。
- 本计划**会新增一处抽象**（`LogSource`，见 `00` 的 D1）——按 `CLAUDE.md` 的规矩，
  开工前需项目所有者点头；其余全部是既有槽的填法。
- `docs/CROSS-HARNESS-DESIGN.md:52,56` 与 `docs/PLUGIN-RESEARCH.md` 早已把 dsh 当
  「设计借鉴对象」引用，本计划是**第一次真接**，两者不冲突：前者谈形态，这里谈接线。
- 抽象缺口（R 批次）修完后，`CLAUDE.md` 的 Architecture 节需要补：①采集面有「脚本上报」
  与「daemon 直读」两种形态；②「投递层的层② 依赖 TUI 是否存在」这条事实。**只在
  R/P 批次落完时**改，计划期不动 `CLAUDE.md`。
