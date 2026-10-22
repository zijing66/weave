# 抽象缺口（R1~R3）：加第 4 个 harness 会撞到的三处结构性假设

> 前提：R 批次修的都是「与 dsh 名字无关」的假设——它们由 claude 那一种形态长成，
> 第四个 harness 一撞就现形。先落 R 批，P0 的改动面就压成「一个 harness 目录 + 八张表
> 各加一行」。三处的证据、目标形状、验收与提交切分如下；末尾 D1~D6 是开工前需要
> 项目所有者点头的六个形状选择（D4~D6 归 P1/P2 用，列在一处免得实现时各自发明）。
>
> R1~R3 **不受前端形态影响**（采集来自 durable 会话日志、压缩信号来自事件名）：即使对接
> 目标换成某个自建 TUI 构建，这三处照样要修——但 D6（直投目标的发现形态）只在「没有 TUI
> ⇒ 必须进程内插件」时成立，见 `README` 的「先对齐一条事实」。

---

## R1 — 采集槽只有「脚本上报」一种形态

### 现状证据

`driver.ts:60-77` 的 `CaptureSurface` 五个方法，逐条都在讲**脚本产物**：

```
readUserCapture / installUserCapture(用户级 helper 脚本 + user settings 采集组)
uninstallUserCapture / stripProjectCapture / scriptHealth
```

`CaptureScriptHealth`（`driver.ts:45-57`）的形状更是把「采集」等同于「一份文件」：
`source: 'user'|'project'|'none'`、`present`、`weaveOwned`（带 `@version weave@` 标记）、
`generatedVersion`、`reportsInbox`、`reportsPaneEnv`。

dsh 上这三样**一件都不存在**：没有脚本（daemon 自己读日志）、没有 settings 采集组
（dsh 的 hooks 要过 profile 配置，而 `weave init` 不该碰用户全局 profile）、没有
`weave init` 生成的落点（项目里只有 `.dsh/skills` 与 `AGENTS.md`）。
按现有形状实现，只能给出一个「永远 present:false / weaveOwned:false」的假对象——那会让
`weave doctor` 永远报「采集脚本缺失，请重跑 weave init」，而重跑一万次也不会有脚本。

### 目标形状（推荐）

**capture 槽加一个可选的 `logs` 成员**，同槽两种形态；**不新增能力槽**（`HarnessCapability`
仍是唯一权威，仍是十一槽）：

```ts
/** 自读采集：宿主把会话历史写在自己的日志里，daemon 直接读，没有安装物。 */
export interface LogSource {
  readonly harness: Harness;
  /** 找日志根（dsh：跑 `dsh [--profile web] --dump-config`，取 sessionPersistence.root）。 */
  roots(deps?: LogDeps): Promise<LogRoot[]>;
  /** 枚举某根下 cwd 命中的会话日志（id / path / size / mtime / 格式状态）。 */
  scan(root: string, opts: { cwd: string }): Promise<LogFile[]>;
  /** 从 offset 读新行；解码、版本校验、事件映射全归 harness。 */
  read(file: LogFile, offset: number): Promise<LogSlice>;
  /** 采集健康（doctor 与投递诊断共用）：根在不在、格式版本认不认、读到哪了。 */
  health(deps?: LogDeps): Promise<LogHealth>;
}

export interface CaptureSurface {
  // …现有五方法不变…
  /** 自读形态；null/undefined = 本 harness 靠脚本上报（claude/codex/zcode）。 */
  readonly logs?: LogSource;
}
```

**诊断装配改成一处派生**（server 侧唯一改动点）：doctor 与 `GET /messaging/diagnostics`
今天各自调 `scriptHealth`；抽出 `captureHealthOf(registry, harness)`——

```
有 capture.logs → LogHealth（根找到没 / 格式版本受支持没 / 已读到第几行）
否则有 capture    → scriptHealth（现状，逐字不变）
两者都无          → 「该 harness 无采集面」
```

理由：`/messaging/diagnostics` 与 `weave doctor` 是「为什么送不到」的唯一诊断面
（见 `CLAUDE.md`），而 dsh 的「采集没通」成因与 claude 完全不同（不是脚本旧，是根找不到
或格式版本不认识），必须在同一处给中文修法。

### 验收

- dsh 驱动注册后，`weave doctor` 的采集一节报「日志根：/…（可读）｜格式 V4 受支持｜
  已读 该会话 128 行」，不再出现「重跑 weave init」。
- claude / codex 的 doctor 输出**逐字不变**（快照断言）。
- `GET /messaging/diagnostics` 对 dsh 会话给出「投递需插件（见 P1）」而不是「采集脚本缺失」。

### 风险

- `roots()` 要跑子进程（`--dump-config`）。做成**带缓存 + 失败降级**：拿不到就回落
  `<dataDir>` 同级候选与用户手填的 settings 覆盖项（`dsh.sessionRoot`），并在诊断里说清
  用的是哪一条。
- 若将来出现第二家「自读」harness，再把 `logs` 提成独立槽；今天只有一家，不预抽。

### 提交切分

1. `driver.ts` 加 `LogSource`/`LogRoot`/`LogFile`/`LogSlice`/`LogHealth` 类型（无消费者，纯加法）。
2. server 侧 `captureHealthOf` 派生 + doctor/diagnostics 改调用点（行为对存量零变化）。
3. 测试：派生函数三态单测 + doctor 快照。

---

## R2 — 入库通道只有「inbox 文件」一个生产者

### 现状证据

整条链路三处（`packages/weave-server/src/hooks/inbox-worker.ts`）：

| 处 | 行 | 干什么 |
|---|---|---|
| worker 自举 | `:498-521` | 自开 DB 连接，组 `InboxDrainDeps`（含**完整** `ProjectRepository`、`HookEventRepository`、`SessionRepository`、全部 `adapters`），每 tick 跑 `drainInboxOnce` |
| 认领→入库 | `:93 drainInboxOnce` / `:126 drainClaim` / `:237 insertBatch` | 文件 rename 认领 → 逐行 `adapter.normalize` → `insertMany` + `hookSessions.touch` |
| 回主线程 | `:355 handleIngestedRecords` | SSE 帧、QuestionTracker、watch/sequence 引擎、`SessionProbe`、投递回执 |

dsh 的记录**不来自文件**，但后面这一整段都能直接用：`insertBatch` 就是「给一批
`HookEventInput` + 一个 project 落库」的现成原语，`handleIngestedRecords` 只吃
`InboxRecord[]`。

### 目标形状

在 worker 的同一个 tick 里加**第二个生产者**：

```ts
const tick = () => {
  const records = drainInboxOnce(deps, attempts);        // 现状：文件上报
  records.push(...drainLogTapsOnce(deps));               // 新增：自读日志
  if (records.length) parentPort?.postMessage(records);
};
```

`drainLogTapsOnce` 的动作限于三步，**不含任何 dsh 知识**：

1. 对 `adapters` 里带 `capture.logs` 的 harness 取 `roots()`（进程内缓存，遇错只记一次）；
2. `scan(root, {cwd})` —— cwd 取自**已登记的 weave 项目列表**（`projects.list()`），
   即「只读我们自己项目下的会话」，dsh 用在非 weave 项目上的会话不会被抓进来；
3. `read(file, offset)` 拿原始行 → `adapter.normalize(row, projectId)` → `insertBatch`。

配套两处小改：

- `InboxDrainDeps.projects` 的 `Pick<…, 'getByToken'>` 放宽到 `'getByToken' | 'getByPath'`
  （`cwd → project` 需要，`repositories/projects.ts:57` 已有 `getByPath`，键形是
  `projectKey` 的 `resolve()` 归一，dsh 的 cwd 正好是绝对路径）；
- 游标（每个日志文件读到第几字节、已入几行）**只放内存**——与 `SessionProbe` 同口径：
  daemon 重启即清零，靠「重新全量解一遍 + 按事件去重」补回。去重键 = `(sessionId, seq)`，
  dsh 日志每行自带 `seq`（见 `01` §1），由 `normalize` 塞进 `raw.seq`，落库前查重。

### 验收

- 手工 `printf` 追加一行到会话日志 → dashboard 200ms~1s 内出现事件（🔬2 定了帧边界才准）。
- 同一会话重复触发（进程重启）不产生重复行。
- inbox 文件路径的行为零变化（既有 `inbox-worker.test.ts` 全绿）。

### 风险

- **tick 被解码拖住**：必须给每轮设字节上限（如单轮最多解 2MB / 单文件 1 帧）与
  「解不完下一轮继续」的游标，否则大日志会把 hook 采集一起卡住（hook 路径不得阻塞
  是硬约束）。
- Windows 上文件句柄/rename 竞争：只读打开 + 允许 `EACCES`（`weave-wezterm-mux-facts`
  记过 statSync EACCES 的坑），失败下轮重试即可。

### 提交切分

1. `drainLogTapsOnce` + 游标 + 单测（假 LogSource，不碰 dsh）。
2. `InboxDrainDeps.projects` 放宽 + 按 `raw.seq` 去重。
3. worker tick 接入 + 一条端到端（假来源 → 事件落库 → 主线程收到记录）。

---

## R3 — 压缩收尾笔强制要求 `raw.source`

### 现状证据

`packages/weave-core/src/harness.ts:189` 的 `HARNESS_COMPACTION` 是
`{ start, end, endSource }`；web 唯一判据 `packages/weave-server/web/src/components/tasks/lifecycle.ts:79`：

```ts
if (!spec?.end || !spec.endSource) return false;
return eventType === spec.end && rawSource === spec.endSource;
```

claude 的形状是 `SessionStart` 且 `source === 'compact'`——**同一事件名有多种来源**，
所以需要 `endSource` 区分。dsh 的压缩收尾笔是独立事件 `compaction/end`，**没有 source
键**，二者信息量不同，但现有判据把它们混成一种：不写 `endSource` 就等于「没有收尾笔」，
对话面板里的压缩分隔永远画不出来。

### 目标形状

`endSource: string | null`（类型上早就是 null，只是判据没兑现）：

```ts
if (!spec?.end) return false;                                  // 没有收尾笔
if (spec.endSource == null) return eventType === spec.end;     // 不按来源区分
return eventType === spec.end && rawSource === spec.endSource;
```

只在 web 一处改实现 + core 一处改注释（`endSource` 的 JSDoc 从「同类型事件有多种来源时用它
认出来」补一句「null = 该 harness 的收尾笔是独立事件，不看 source」）。

### 验收

- claude 行为零变化（既有 `compaction.test.ts` 全绿）。
- 给 dsh 填 `{ start: 'compaction/start', end: 'compaction/end', endSource: null }` 后，
  对话面板在压缩位置画出分隔（🔬 拿真实日志验证事件成对出现）。

### 风险

极低。反面风险是有人误以为 `endSource: null` 表示「该 harness 无压缩」——core 注释里
写明「无压缩 = `end: null`，不是 `endSource: null`」。

### 提交切分

一笔（core 注释 + web 判据 + 测试）。

---

## 待裁决点（开工前需项目所有者点头）

| 编号 | 点 | 推荐 | 反面 |
|---|---|---|---|
| **D1** | 自读采集放哪 | `CaptureSurface` 加可选 `logs`（同槽两形态，十一槽不变） | 新开第 12 个能力槽（`CLAUDE.md` 要求扩张前先确认，且今天只有一家自读） |
| **D2** | 事件名形态 | **原样用 dsh 的斜杠名**（`turn/start`、`approval/asked`…） | 转成 PascalCase（读者对不上 dsh 文档；且要编一张映射表，永不平移） |
| **D3** | 图片随附表达法 | P2 先落「裸路径文本」；结构化 image block 形态等插件桥跑通再议 | 现在就给 `ImageAttachSpec` 加结构化形态（为一个尚未验证的通道扩接口） |
| **D4** | 作答形态 | `BlockingQuestionOption.keys` 允许空数组 + `BlockingPromptSpec` 加 `answerKind: 'keys' \| 'structured'`，`MessageDeliverer.answer` 按它分派（dsh 走结构化作答，web 零改动） | 给 dsh 单开一路作答路由（作答变两套实现）——详见 `03` §2 |
| **D5** | 「同名事件、成败看载荷」怎么表达 | `QuestionTracker` 与 web 的失败标记各加一条可选判据（harness 提供 `settlesOn(eventType, raw, phase)` / adapter 在 payload 填 `failed: true`），**一次改完，不要分两次加形状** | 给 dsh 造一套平行的事件名（`turn/failed`）——伪造宿主事件名，事件链里会变成「dsh 有个不存在的事件」 |
| **D6** | 直投目标的「发现形态」 | `PromptInboxSpec` 加判别键 `discover: 'env' \| 'rendezvous'`（claude = 会话导出 env + hook 上报；dsh = 插件自己写目标文件）；传输层（`hooks/inbox-socket.ts`）不动 | 新开一个成员/新开一路投递——同一件事（地址 + token + 一帧字节）会有两份实现 |

D2 的落地细节：`HARNESS_EVENTS.dsh` 里的名字带 `/`，`core/harness.ts:30` 那句
「规范名为 PascalCase」改成「规范名 = 宿主自己的事件名；claude/codex/zcode 是
PascalCase，dsh 是 `namespace/verb`」。核过 server/web：**没有任何地方按 PascalCase
校验或拆名字**（`HARNESS_LIFECYCLE`/`HARNESS_COMPACTION` 都是整串相等比较），
插件 `requires.events` 的校验走 `HARNESS_EVENT_UNION` 同一份名单，无需额外改动。
