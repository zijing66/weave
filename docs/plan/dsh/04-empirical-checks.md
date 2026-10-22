# 实测清单（🔬）：手法、判据、以及已结案项

> 规矩：**每条都写「假设 / 手法 / 判据 / 阻塞哪批」**。证伪了就改计划，不硬推。
> 没有 dsh 实例的项（🔬6~🔬11）必须等本机装出一个实例再做——不拿源码注释当实测。

---

## 已结案

> 编号与 `README` 的「关键结论」同一套：C1 / C2 / C4 在这里给证据链；C3（dsh 没有
> 项目级配置面）是读配置面得出的结论、不是实测项，见 [`README`](./README.md)
> §「三个独立于「怎么接」的关键结论」。

### C1 — dsh 没有随包 TUI（层② 不存在）

| 证据 | 内容 |
|---|---|
| 仓库 | `apps/` = `cli` / `desktop` / `desktop-host` / `web` / `plugin-market-generator`，无终端 UI 应用；`packages/ui/` 不存在，全树无 `pi-tui` 引用 |
| **上游裁决（最硬）** | `.agents/notes/archived/simplification/2026-08-03-explicit-config-dsh-entrypoint.md`："The CLI no longer ships a TUI application."；`.agents/notes/archived/simplification/2026-08-04-remove-tui-package.md`："The `packages/ui/tui` package is deleted without a compatibility package or alias." |
| CLI 随包 profile | `web`（浏览器 UI，默认 `127.0.0.1:3080`）/ `headless` / `acp` / `sdk` / `sdk-minimal`（`docs/cli-help.md`） |
| `dsh tui` | 只作「自定义 profile 名」的举例出现（同 `dsh rescue`）；profile 目录 `$DSH_HOME/profiles/<name>` 用户自建才有。**帮助文本里的 `tui` 是摘除前留下的占位名**（`apps/cli/src/args.ts:96-99`、`docs/cli-help.md:54-57`） |
| npm | `@deepseek-ai/dsh-tui` → **404**；`@deepseek-ai/dsh@0.2.1-rc.2` 的描述是 "dsh CLI: profile launch, plugin management, and configuration inspection"（启动器/管理器，不是 TUI）；同 scope 下 `dsh-web` / `dsh-acp` / `dsh-headless` 都是 profile 级的**服务**包，与 `apps/` 一一对应 |
| 时间线 | 首次 npm 发布 = `0.0.1-rc.1` @ 2026-08-10，**晚于** TUI 摘除日 ⇒ 任何已发布版本都不含 TUI（`registry.npmjs.org/@deepseek-ai/dsh` 的 `time` 字段） |

**结论**：投递面只能走进程内插件；`sendKeys`/`sendText` 这一层对 dsh 不成立。**除非**
实际接入目标是别处自建的 TUI 构建——那种情况下这一结论整条作废，先确认来源（`README`
「先对齐一条事实」一节列了翻转后的形态）。

### C2 — hooks 兼容层不能当采集通道

| 证据 | 内容 |
|---|---|
| `packages/experimental/hooks-claude-code/src/index.ts:55-70` | `configPath` **进程级**、load 时读一次；`TODO(per-session-hook-config)` 明说 per-session 发现还没做 |
| 同文件 `:340-352` | `base()` 只给 `{session_id, transcript_path: '', hook_event_name}`；`stopPayload()` 只多一个 `stop_hook_active` ⇒ **没有 `last_assistant_message`**，`transcript_path` 恒空 |
| 事件覆盖 | 只有 7 个：`SessionStart` / `UserPromptSubmit` / `PreToolUse` / `PostToolUse` / `Stop` / `SubagentStart` / `SubagentStop`——**无 `SessionEnd` / `PreCompact`** |
| 附带代价 | hook 有超时且在事件路径上串行执行（违反「hook 路径不得阻塞」）；要落用户的全局 profile |

**结论**：采集走会话日志（`01` §1）。

### C4 — `turn/end.reason` 就是「成败 + 中断」的权威事实

`docs/subsystems/session.md:685-730` 的 `TurnEndReasonMap` 已发布 union：

```
completed | aborted{reason} | blocked | error{error} | max-tokens | interrupted | forked
```

⇒ 「这一轮是正常收尾还是失败」「是被中断还是崩了」都不用猜、不用读转录：

- 失败（标红气泡）= `reason.kind ∈ {error, max-tokens, blocked}`（P0 靠 D5 的
  「payload 带 `failed: true`」表达，`closeFailed` 写不了同名事件）
- `aborted` = **用户取消**，而且它是**收尾笔**——回合就此真的关上
- `interrupted` = 进程崩溃后补写的收尾笔（没人按停止），`forked` = fork 种子专用

落地影响：这一点**反而否掉了 weave 的「已中断」第 7 态对 dsh 的适用性**——那个态存在的
前提是「宿主不落收尾笔」（claude 实测 45 次 ESC 里 41 次连 `Stop` 都不发），而 dsh
取消后照样落 `turn/end`，会话行直接回「打开」，不需要靠转录标记补判。故 P0 不接
`interruptedAt`（它的判据绑在 `SessionProbe` 的 claude 转录标记上，dsh 没有那条路）。

---

## 待测

### 🔬1 — `--dump-config` 能不能解析出日志根

- **假设**：`dsh --profile web --dump-config` 的输出里能找到
  `@deepseek-ai/dsh-session-persistence-jsonl` 那一行及其 `config.root`（绝对路径）。
- **手法**：`dsh --profile web --dump-config > dump.yml`，另跑 `--dump-default-config`
  对比（后者不含用户层）；若 web profile 的 root 由 launcher 注入而非 patch 文件，
  再查 `apps/desktop*` 的 profile 加载路径。
- **判据**：能在 dump 里**唯一定位**一个绝对路径，且该路径下确有 `--<cwd>--/` 目录；
  dump 里有多份候选时以「实际有会话落盘的那份」为准。
- **阻塞**：P0（硬前置）。拿不到 ⇒ 只能让用户手填 settings，必须先说清。

### 🔬2 — 日志是「一次 append 一帧」的独立 zstd 帧

- **假设**：每批写入 = 文件尾部追加**一个完整的 zstd 帧**；帧之间彼此独立（可从任意
  帧边界开始解）。
- **手法**：
  1. 跑一轮对话，记下 `stat` 前后大小；
  2. `node -e "zlib.zstdDecompressSync(fs.readFileSync(p))"` 全量解 → 行数应等于
     `docs/persistence-catalog.md` 的事件数；
  3. **取第 2 帧起的字节**单独解（用「首帧长度 = 解出的第一个完整记录 + 帧头」定位：
     先全量解、再按 zstd 魔数 `0x28 0xB5 0x2F 0xFD` 扫描帧起点的偏移）→ 若能解出后续行，
     证明帧独立、可增量；
  4. 截断最后一帧的尾 8 字节再解 → 期望「只出完整记录 / 明确报错」，不静默丢中间帧；
  5. 10MB 级别文件测一次全量解耗时（判卷控参数）。
- **判据**：③ 成功且 ④ 的行为可预测 ⇒ 增量游标方案成立；否则退回「每轮全量解 + 按
  `seq` 去重」。
- **阻塞**：P0（硬前置）。

### 🔬3 — 头部帧带真 `cwd` 与 `sessionId`

- **假设**：第一帧是 `JsonlHeaderLine`，含会话 id 与真实 cwd（盘上目录名是**归一后**的，
  Windows 盘符/大小写可能丢信息）。
- **手法**：取一个会话文件，解第一帧，与目录名 `--…--` 比对；再造一个大小写不同的项目
  路径，看目录名与头部 cwd 的差异。
- **判据**：头部 cwd 与 `projectKey()`（`resolve()` 结果）能相等 ⇒ 用头部；不能 ⇒ 用目录名
  并记录归一规则。
- **阻塞**：P0（项目归属）。

### 🔬4 — `turn/end` 的实测取值（C4 的核对）

- **手法**：正常答完一轮 / 用 dsh 的停止按钮中断一轮 / 构造一次 API 错误（错 provider
  或断网）各跑一次，各读一次 `turn/end.reason.kind`。
- **判据**：分别落 `completed` / `aborted` / `error`；**关键是确认「取消之后确实有
  `turn/end` 落到盘上」**（这决定 P0 要不要补中断态）。若取消只发内存态事件、盘上没有
  收尾笔 ⇒ 回合会一直挂在「生成中」，那就得补一条 `aborted` 的兜底口径并把 D5 的载荷
  判据扩到中断（**这才是唯一会反悔本计划的地方**）。
- **阻塞**：P0（失败气泡），非硬前置。

### 🔬5 — `assistant/message` 怎么取文本

- **假设**：`assistant/message` 里嵌了「产生该消息的紧凑计时 stream」；纯文本要按 block
  拼装（剥 thinking / tool_use 块）。
- **手法**：取一条真实事件，打印 `content`/`stream` 的 block 类型分布；写一个纯函数
  `textOf(message)`，把结果与 dsh UI 里那一轮的显示文本逐字比较（含 markdown 原样）。
- **判据**：与 UI 文本一致（允许尾部空白差异）；块类型清单落进 `weave-harness/src/dsh/`
  的注释。
- **阻塞**：P0（对话面板质量）。

### 🔬6 — 插件能拿到「每次 durable append」

- **假设**：插件能订阅到会话的每个 durable 事件（或至少有 live 事件 + 持久化回调）。
- **手法**：写一个 5 行探针插件（`apply(ctx){ ctx.on('*', e => console.log(e)) }`
  视 dsh 的事件 API 而定），`dsh plugin --profile web add link:<probe>` 装上，跑一轮，
  看收到哪些事件、是否含 `turn/end`。
- **判据**：能拿到「回合结束」与「需要作答」两类即可（P1 只需要下行；上行已有日志）。
  **拿不到也不阻塞 P1**——P1 的下行不依赖插件读事件，只有 P2 的「审批面实时性」依赖它。
- **阻塞**：P1（弱依赖）/ P2（强依赖）。

### 🔬7 — `sessionController.prompt` 对 live 会话的语义

- **假设**：对**正在跑**的会话 prompt 会被排队（而不是拒绝或并发插入）；对**没打开**的
  会话会 resume 再跑。
- **手法**：探针插件里挂一个 HTTP/管道入口（借用 P1 的桥壳），从外部：①空闲时发；
  ②回合进行中发；③对已关闭的会话发。各观察 dsh UI 与日志里的 `user/message` / `turn/*`。
- **判据**：①立即起一轮；②排队且只在本轮结束后起新轮（不合流、不丢）；③冷会话被拉起
  或明确拒绝——**两种都可接受，但必须写清**（决定 `02` §7 的第 2 行）。
- **阻塞**：P1（硬前置）。

### 🔬8 — 插件包怎么装（Windows 优先）

- **手法**：`dsh plugin --profile web add link:<abs>`；再故意把 `engines.dsh` 写成
  `^9.0.0` 重装，看是否被**跳过并报 skippedBundles**；`dsh plugin --profile web remove`
  看残留（`node_modules`、patch 行、profile 的 `package.json`）。
- **判据**：装后 `dsh web` 启动即挂上；版本不符时**跳过而不崩**；卸载后 profile 里
  无残留行与目录。
- **阻塞**：P1。

### 🔬9 — 审批能不能被插件代为作答

- **假设**：`ctx.approval` 是「向 answerer 链提问」的接口；插件能注册 answerer 或直接
  对某条 request 作答。
- **手法**：探针插件注册 answerer（或拦截 `approval/asked` 对应的请求），对一个会弹审批
  的工具调用回答 allow/deny，验证工具是否执行/被拦。
- **判据**：两种答案都生效；且**没有 answerer 时宿主仍正常弹窗**（fail-closed 不被我们
  破坏）。
- **阻塞**：P2（硬前置）。

### 🔬10 — 桌面版与 web 是否共用同一 root

- **手法**：装 dsh 桌面版（`apps/desktop` 的产物），开一个会话，比对它落的 root 与
  `dsh web` 的 root。
- **判据**：同根 ⇒ 单根假设成立；不同根 ⇒ `roots()` 必须支持多根（`01` §5 已预留）。
- **阻塞**：P0（弱，单根可先跑）/ P2（强）。

### 🔬11 — `user/message.source` 的取值表

- **假设**：`user/message.source` 能区分「人打的 prompt」「`agent.inject()` 合成上下文」
  「目标续轮」三种（`docs/persistence-catalog.md` 的 `user/message` 注释明说了这三类）。
- **手法**：正常发一句 + 触发一次注入（如让子目录 AGENTS.md 生效）+ flow 续轮，各取一条
  事件看 `source`。
- **判据**：能把「人打的 / weave 投的 / 合成的」分开 ⇒ 回执认领只认前两类里文本匹配的
  那条，否则会被合成注入事件误认成回执（`02` §4.3 的正确性直接靠它）。
- **阻塞**：P1（回执判据）。

---

## 后续可选（不进本计划承诺）

| 项 | 为什么现在不做 |
|---|---|
| `team/*` 与 `subagent/*` 的完整可视化 | 没有真实数据判断量与画布映射；先丢，用户真需要再立项 |
| 从 weave 新建 dsh 会话 | dsh 没有可起的交互面；插件能 create，但用户看不见那个会话在哪开 |
| dsh 插件市场并入 weave 资源市场 | 两套插件模型（bundle vs market）不该硬并 |
| `HARNESS_SESSION_CONTROL`（模式/模型切换按钮） | 需先拿 `permission/preset` 与 `model/selection` 的完整取值表（另开 🔬） |
