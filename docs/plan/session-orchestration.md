# 跨会话编排：消息面、空闲订阅与可视化编排 设计方案

## Context

用户原话（两轮）：

> 继续增强 weave 的功能设计，尤其是参考 claude code 的订阅消息以及 sendmessage
> 机制，实现手动可视化跨会话的编排；以及跨 harness 工具以及跨项目的会话编排，
> 甚至考虑局域网内的会话编排。

> 补充描述，这些功能均抽象实现，然后不同 harness 进行适配，因为都是参考
> claude code，所以对于 claude code 功能是完整的，但是其他 harness 工具需要
> 额外适配，或者可能不支持，需要在编排时，正确管理支持状态和编排控制，
> 也是好好设计一个抽象类的设计。

诉求拆解：

1. **参考模型移植** —— Claude Code 的订阅消息（notify_when_idle）与 SendMessage 机制；
2. **能力面抽象** —— 消息/订阅/编排一律面向抽象实现，harness 各自适配；claude 是
   完整参考实现，其他 harness 部分支持或不支持，必须显式声明；
3. **支持状态管理与编排控制** —— 编排层（server 路由 / web / CLI）按能力面裁决：
   支持什么、置灰什么、拒绝时给出语义原因；
4. **手动可视化编排** —— dashboard 点对点跨会话操作面（人发起，非自动规则）；
5. **跨 harness / 跨项目 / 局域网** —— 目标会话不受边界限制；LAN 远期预留。

---

## 第一章 参考模型：Claude Code 机制拆解

本机实测观察（Claude Code 跨会话面）：

| 机制 | 语义 |
|---|---|
| **ListAgents** | 枚举可寻址同侪：名字 `[ref]`、busy/idle、started。地址 = 名字，重名用 `[ref]` 消歧。 |
| **SendMessage** | `{to, message, notify_when_idle?}`。异步投递——消息在**接收方的下一个 tool round** 到达；忙时排队**不打断**；不同权限模式可暂存待批或拒绝；消息以 `<cross-session-message from="…">` 信封到达；**回复 = from 即 to**。 |
| **notify_when_idle** | 一次性纯订阅：对端下一次转 idle（或退出）时收到一记通知，之后订阅自动失效。免轮询。 |

提炼为**语义四件套**（本方案的目标不变量）：

1. **寻址** —— 稳定标识 + 人可读名 + 消歧；
2. **非抢占投递** —— 消息永远等接收方的自然边界（下一回合），不杀不抢；
3. **忙排闲投** —— 忙时排队、闲时可强制开拍（idle 会话仍能被「叫醒干活」）；
4. **一次性订阅** —— 免轮询的 idle/exit 通知，触发即焚。

---

## 第二章 weave 现状基座：通道三有、原语全无

### 2.1 参考模型 → weave 映射

| Claude Code | weave 对等物 | 现状 |
|---|---|---|
| ListAgents | `GET /sessions`（全局 200 条）+ `deriveSessionStatus` 五态（running/failed/open/closed/terminated） | ✅ 已有 |
| SendMessage → **忙会话** | **outbox 注入通道**：`appendOutbox(hooksDir, token, [{sessionId, text}])` → 该会话下一 hook 事件随 additionalContext 进会话（`hooks/mirror.ts`） | ✅ 通道已有，仅规则域（deferred/crossProjectOnly）消费 |
| SendMessage → **闲会话** | **无头投递通道**：ResumeRunner `claude --resume <sid> -p <prompt>`（transcript 续回合、输出收集、超时、并发闸、SSE） | ✅ 通道已有，仅指令池派发消费 |
| notify_when_idle | Stop / SessionEnd / liveness-terminated 事件触发的一次性 watch | ❌ 新建（触发源 dispatcher.onIngest 单点现成） |
| 消息收件箱 / 回复 | web 消息线程视图 + CLI | ❌ 新建 |
| 云端/远端会话 | LAN 联邦 peer daemon | ❌ L5 预留 |

### 2.2 通道细节（已核实）

- **注入通道**：`<dataDir>/hooks/outbox/<shard>.jsonl` 行 `{sessionId, text, at}`，hook 消费即删行，200 行有界。跨端契约稳定（`mirror.ts` 头注释）。**这就是「忙排」的排队语义本体**——写进去的消息在下一拍自然送达，永不抢占。
- **无头通道**：`ResumeRunner`（`hooks/resume-runner.ts`）spawn detached、同 session 并发闸、终态 succeeded/failed/timeout + SSE `dispatch.started/finished`。规格来自 resume 槽（`CLAUDE_RESUME`，`weave-harness/src/claude/resume.ts`）。
- **判活/状态**：`claude-liveness.ts` 三态（不误判）+ `turnOpen`（最后一条 UserPromptSubmit 晚于 Stop/SessionEnd）+ web `session-status-store` SSE 实时总线。**auto 裁决所需的「忙/闲」判定现成**。
- **订阅触发源**：dispatcher.onIngest 是全部事件的单点（Stop/SessionEnd 到达即可触发 watch）；SessionSweeper 与 liveness 刷新器覆盖 terminated。
- **跨项目**：sessions 全局列表；ResumeRunner 按 会话→项目→cwd 定位 spawn，无项目边界障碍；outbox 按项目 token 分片，天然跨项目。**跨项目编排零新基建**。
- **codex 现状**：`HARNESS_EVENTS.codex = []`（B0 闸门）→ 无事件即无会话发现；`INJECTABLE_EVENTS.codex = []`；resume 槽 `supported:false` 语义。

**结论：投递与判定通道全部现成。缺的是——把通道从「规则驱动的自动域」解放为「点对点的手动编排原语」，抽象成 harness 能力面，加一次性 watch 触发器，加 UI/CLI 操作面。**

---

## 第三章 消息能力面：`MessagingSurface`（抽象设计核心）

### 3.1 形态：接口能力槽，非模板方法抽象类

抽象类全仓仅两处模板方法（`InitPipeline` / `TerminalBackend`），本面**不新增抽象类**——
消息能力没有「固定骨架 + 子类填差异」的模板结构，它是**每 harness 一份声明式规格 +
少数纯函数**，与 `PluginSurface` / `PluginStateSurface` 同形：接口进 `driver.ts`，实现落
`weave-harness/src/<name>/`，`HarnessRegistry` 统一装配，server/web/cli 只经面取用。

### 3.2 槽位与装配（照 pluginState 槽先例，P2 已验证的路径）

- `driver.ts`：`HarnessCapability` 增加 `'messaging'`；`HarnessDriver` 增加
  `messaging?: MessagingSurface`。
- `claude/messaging.ts`：`createClaudeMessaging()`——**完整参考实现**。
- `codex/messaging.ts`：`createCodexMessaging()`——**显式不支持面**（全通道 null +
  原因文案，不是缺席——缺席无法渲染「为什么置灰」）。
- `registry-wiring.ts` 的 `HARNESS_DRIVERS` 两个 driver 各挂 `messaging` 槽（`satisfies`
  穷尽催补不变）。
- server `surfaces.ts`：`messagingSurfaceFor(harness)` + `messagingSurfaces()` 访问器
  （照 `pluginStateFor` 先例）。
- CLAUDE.md「六能力槽」表述随批 1 更新：清单以 `driver.ts` 的 `HarnessCapability`
  为唯一权威（现 7 值 + messaging = 8；pluginState 本就未入清单，一并补正）。

### 3.3 接口定义（草案）

```ts
/** 消息通道名——支持矩阵与原因文案的键。 */
export type MessagingChannel = 'discovery' | 'inject' | 'headless' | 'watch';

/** 非抢占注入通道规格（忙排）。 */
export interface InjectChannelSpec {
  /** 注入可骑乘的事件（hook-handler 在这些事件上消化 outbox 行）。 */
  rideEvents: readonly string[];
}

/** 消息元——信封渲染入参。 */
export interface MessageMeta {
  fromLabel: string;   // 发起方展示名（dashboard / 会话标题 / cli）
  at: string;           // ISO
  mode: string;
}

/** 单 harness 的消息能力面：声明式规格，执行在 server 的 MessageDeliverer。 */
export interface MessagingSurface {
  readonly harness: Harness;

  /** 会话发现：该 harness 会话能否成为编排目标（ListAgents 对等物）。 */
  readonly discovery: boolean;

  /** 非抢占注入通道（忙排）；null = 不支持。 */
  readonly inject: InjectChannelSpec | null;

  /** 无头强制回合通道（闲投）；null = 不支持。引用 resume 槽规格对象，不复制。 */
  readonly headless: ResumeCommandSpec | null;

  /** 空闲信号事件名（watch 触发源）；空数组 = 不支持空闲订阅。 */
  readonly idleSignals: readonly string[];

  /** 注入信封渲染：消息文本 → 该 harness 注入通道要的形态。缺省 = weave 统一信封。 */
  renderEnvelope?(text: string, meta: MessageMeta): string;

  /** 不支持通道的语义原因（409 文案与 UI tooltip 直用，server 透传不自写）。 */
  readonly unsupportedReasons?: Partial<Record<MessagingChannel, string>>;
}
```

### 3.4 harness 适配矩阵

| 能力 | claude（参考实现） | codex（现状） |
|---|---|---|
| discovery | `true`（hook 事件流建档） | `false`——「codex 事件面待 B0 调研（BACKLOG §10-6），会话不可发现」 |
| inject | `{ rideEvents: INJECTABLE_EVENTS.claude }`（引用 core 表，不自写清单） | `null`——「codex 无同步注入通道（B0 调研，无则永久不支持）」 |
| headless | `CLAUDE_RESUME`（**同一对象引用**，resume 槽单源） | `null`——「codex resume 规格待 B0 调研」 |
| idleSignals | `['Stop', 'SessionEnd']`（值源自 `HARNESS_LIFECYCLE.claude` 的 close + sessionMarkers，不手抄） | `[]`——同 discovery 原因 |
| renderEnvelope | 缺省（weave 统一信封） | —— |

**新 harness 接入 = 实现一个 `MessagingSurface` + 挂槽注册，server/web/CLI 零改动。**
codex 后续 B0 解锁也只改 `codex/messaging.ts` 一个文件的声明，编排层（路由裁决、UI
矩阵、画布门控、watch 引擎）不动——这是本面存在的全部意义。

### 3.5 支持状态模型（正确管理支持状态）

server 启动时（或首查时）从 `messagingSurfaces()` 派生**全 harness 支持矩阵**：

```jsonc
// GET /messaging/capabilities —— 纯派生视图，无第二事实源
{ "capabilities": [
  { "harness": "claude", "discovery": true, "inject": true, "headless": true, "watch": true },
  { "harness": "codex", "discovery": false, "inject": false, "headless": false, "watch": false,
    "unsupportedReasons": { "discovery": "…", "inject": "…", "headless": "…", "watch": "…" } } ] }
```

- 矩阵是**派生视图**（面 → 矩阵的纯函数），无第二份事实源。
- web 按 `session.harness` 查矩阵渲染**会话支持徽标**：全通道 / 仅注入 / 仅无头 /
  不可编排 + 原因 tooltip；web 只渲染不判定。
- CLI 同矩阵做输出列与命令门控。

### 3.6 编排控制（MessageDeliverer 裁决表）

投递引擎是唯一裁决点（server 内，无 harness 硬编码——一切问题问面）：

| # | 条件 | 动作 |
|---|---|---|
| 1 | 目标会话不存在 | 404（发现失败的天然形态） |
| 2 | 双通道皆 null | 409 + `unsupportedReasons` 文案 |
| 3 | mode=inject，inject=null | 409 + 原因 |
| 4 | mode=headless，headless=null | 409 + 原因 |
| 5 | mode=**auto**，忙（turnOpen） | inject 投递（不支持则 409「忙会话无法非抢占投递」——**绝不无头抢占忙会话**） |
| 6 | mode=**auto**，闲 | headless 投递（不支持则 409「闲会话无法唤醒」） |
| 7 | watch，idleSignals 空 | 409 + 原因 |

auto 的裁决基准 `turnOpen` 已由 `listWithCounts` 算好（harness 无关列）。

**UI 门控**（同一矩阵的第二消费点）：发消息按钮在双通道皆无时置灰 + 原因；模式选择器
只列支持的模式（auto 在任一通道可用时可选，按上表降级）；watch 按钮随 idleSignals 置灰；
批 3 画布连线时按通道校验目标节点（不支持某通道的边建不出来）。

### 3.7 单源约束（防平行事实源）

- headless 规格引用 `CLAUDE_RESUME` 对象，不复制（resume 槽仍是唯一规格源）；
- `rideEvents` / `idleSignals` 的**取值**引用 core 的 `INJECTABLE_EVENTS` /
  `HARNESS_LIFECYCLE`，claude 实现内引用而非手抄清单；
- 信封缺省渲染在 server 单点（weave 协议，非 harness 知识），面只在确有 harness 特殊
  形态时覆写。

---

## 第四章 架构决策

### D1 新消息域，不复用指令池

> **2026-10-15 重塑后注**：`session_messages` 新表已被「纯文件管道」定案取代
> （见「消息域重塑」节）——消息域不再入库；`hook_dispatches` 不复用的三条理由
> 与投递执行复用（`appendOutbox` / `runPrompt`）不变。

- 新表 `session_messages` + 新路由 + 新 SSE kinds；指令池（`hook_dispatches`，ruleId
  非空、规则驱动）保持自动域语义不动。
- 不复用原因：① ruleId 硬耦合——点对点消息没有规则；② 状态机不同——消息需要
  from/to/送达回执，dispatch 的 `injected` 是「规则命中即注入」语义；③ 自动域与
  手动域混表会让归档清理、60s 去重、`findRecentAuto` 互相污染。
- **投递执行复用**：注入走 `appendOutbox`（harness 能力面门控后），无头走 ResumeRunner
  泛化出的 `runPrompt` 核心（dispatch 适配器与 message 适配器共用并发闸/超时/输出收集）。

### D3 空闲订阅：`session_watches`（notify_when_idle 对等物）

- 行：`{watcherSessionId?（null=dashboard）, targetSessionId, notify文本?, firedAt?}`，
  **one-shot**（firedAt 落定即失效）。
- 触发点单点 = dispatcher.onIngest 见**目标会话**的 `idleSignals`（经目标会话 harness
  的面取，非散写 Stop/SessionEnd）；terminated（liveness 判死）由既有 sweeper/刷新器
  路径补射（claude 有注册表判死，其余 harness 靠 SessionEnd 信号）。
- fire 语义：watcher 是会话 → notify 文本经 watcher 会话 harness 的面走 outbox 注入
  （它自己下一拍收到）；watcher 是 dashboard → SSE push + toast。一次性、免轮询。

### D4 寻址与回复

- 主键 = sessionId（全局唯一）；UI 辅以 title 模糊匹配。
- 消息行带 `fromSessionId`——**回复 = from 即 to**（UI 一键回）。
- LAN（L5）扩展 `<machine>:<sessionId>` 前缀寻址，一期恒本地。

### D5 信封与递归防护

- 缺省信封（weave 协议，server 单点渲染）：
  `[weave message] from=<label> at=<iso> mode=<m>` + 正文。
- 正文中嵌入 `WEAVE_MSG` 标记（同 `DISPATCH_MARKER` 思路）：消息→事件→消息的编排链是
  **特性**，但批 3 序列编排必须带 hop 上限（默认 3）防环。

### D6 可视化编排形态（分批演进，全部经能力面门控）

1. **批 1 基座**：会话行/卡片「发消息」入口（按矩阵门控）+ 消息线程视图（双向时间线，
   from/to/状态/时间）+ SSE 实时。
2. **批 2**：会话行「空闲时提醒我」（watch，按 idleSignals 门控）+ `watch.fired` toast。
3. **批 3**：**编排画布**——会话为节点（活/忙状态灯 + 支持徽标）、消息为边（复用
   LifecycleMindmap 的 TNode/layout 思路，数据域换 sessions×messages；连线时按目标
   通道支持校验）；**序列编排器**——手动触发的多步消息模板链（hop 上限）。
   分组维度 = 项目 / harness 泳道切换。

### D7 CLI 发起面：`weave msg`（已移除）

> 2026-10-14 产品定案：人在终端直接在目标会话窗口输入，CLI 注入面无必要——整树
> 删除（ls / send / watch / reply），`sessionEnv` 槽随唯一消费者摘除；web 为唯一
> 人工注入面，watch 走会话列表铃铛。历史形态见批 3 实施记录①，定案见「批后修复
> 与定案」③。

### D8 局域网联邦（设计预留，L5 不实现）

- 消息与会话模型带 `origin`（一期恒 `local`）。
- 联邦形态：peer daemon 注册表（手动添加 `host:port` + pairing token；mDNS 自动发现
  为增强）；路由单点 `MessageRouter`：目标会话不在本地 sessions → 查 peer 表 → 转发。
- **能力协商**：peer 握手互报 `messaging/capabilities` 矩阵——远端 harness 支持状态
  与本地同构呈现（联邦下的支持状态管理复用第三章）。
- **安全红线**：无头投递到远端 = 对端机器的执行级信任 → pairing 显式授权、联邦默认
  关闭、一期转发仅 inject 模式（远端强制回合白名单后放）。

---

## 第五章 数据与协议

> **2026-10-15 重塑后注**：`session_messages` 表已退役（消息域不再入库，仅
> 本地文件、消费即删）；`session_watches` 仍真。消息路由与帧语义见「消息域
> 重塑」节，下方消息表仅存历史参考。

```sql
CREATE TABLE session_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_kind TEXT NOT NULL,        -- 'dashboard' | 'session' | 'cli'
  from_session_id TEXT,            -- 会话发起时；dashboard/cli 为 NULL
  to_session_id TEXT NOT NULL,
  text TEXT NOT NULL,
  mode TEXT NOT NULL,             -- 'inject' | 'headless' | 'auto'
  status TEXT NOT NULL,           -- 'queued' | 'injected' | 'running'
                                  -- | 'succeeded' | 'failed' | 'timeout'
  output TEXT, error TEXT,
  created_at TEXT NOT NULL,
  delivered_at TEXT, finished_at TEXT
);

CREATE TABLE session_watches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  watcher_session_id TEXT,        -- NULL = dashboard 订阅（SSE/toast）
  target_session_id TEXT NOT NULL,
  notify TEXT,                    -- 注入 watcher 会话的文本；dashboard 订阅可空
  fired_at TEXT,                  -- one-shot 落定
  created_at TEXT NOT NULL
);
```

- 路由（挂既有 `handleHooksRoutes` 的 `/sessions` 前缀）：
  `GET/POST /sessions/:id/messages`、`POST/DELETE /sessions/:id/watch`、
  `GET /messaging/capabilities`。
- SSE：既有 `type:'hook'` 帧新增 kind `message.created/delivered/finished`（终态统称，
  对齐 `dispatch.finished`）、`watch.fired`；线程刷新走**同帧**——web 按 `weave:hook`
  事件（kind=message.*）以 `sessionId` 定向重拉，不扩 DataKey（无发射源的键 = 死键）。
- 会话删除/项目归档连带清理两表（对齐 `deleteBySession/deleteByProject` 惯例）。
- 送达回执（可选增强，后批）：outbox 行加可选 `mid`，hook-handler 消费后经下一条
  HookReport 回执 `deliveredMessageIds` → `injected` 升级为「已确认送达」。

---

## 第六章 分批实施

| 批 | 内容 | 依赖 |
|---|---|---|
| **批 1** 能力面 + 消息闭环 | `MessagingSurface` 槽 + claude/codex 两实现 + 装配 + capabilities 端点；两表 + `MessageDeliverer`（裁决表）+ ResumeRunner 抽 `runPrompt` 核心 + 路由 + SSE + web 发消息/线程视图（含支持徽标与门控） | 无 |
| **批 2** 空闲订阅 | watch 引擎（onIngest idleSignals + **terminated 补射**，catch-up 语义见第七章；循环形态若引入须带过期上限）+ dashboard toast + 会话间通知注入 | 批 1 |
| **批 3** 可视化编排 + CLI | 编排画布（节点+边+通道门控）+ 序列编排器（hop 上限）+ `weave msg` | 批 1、2 |
| **批 4** codex 对齐 | B0 落地后**只改 `codex/messaging.ts` 声明**（发现/注入/无头逐项点亮），server/web/CLI 零改动 | B0 调研 |
| **批 5** 局域网联邦 | origin 字段批 1 已带；peer 注册 + MessageRouter + capabilities 互报 + pairing 安全面；**触发源形态 = remote，入参面不变**（第七章） | 批 1–3 稳定后 |
| **批 6** 定时投递（候选） | daemon 侧 scheduler 表（cron/一次性，durable 天然成立）+ `from_kind='scheduler'`，**复用 MessageDeliverer 全套零改动**；抖动纪律与载荷自包含见第七章 | 批 1 稳定后评估 |
| **批 7** 消息域重塑 | prompt 通道（claude SendMessage 受限中继 + promptbox 队列）+ `session_messages` 退役（不入库、纯文件管道）+ web 在途视图 + 序列 interrupted 语义（设计见「消息域重塑」节） | 批 1–3 |

### 批 1 实施记录（2026-10-14 落库）

后端 + web 全量落地，与设计的偏差与定案：

- **HeadlessRunner 抽取（重于设计的「抽 runPrompt 核心」）**：无头执行核心独立成
  `hooks/headless-runner.ts`（per-run `state.settled` 守卫），ResumeRunner 重写为
  薄适配——校验链与 dispatch 帧不变，`headless` 依赖可注入。dispatch 域与 message 域
  **共享同一 HeadlessRunner 实例**（start.ts/dev-entry.ts 两处装配）：同会话绝不双
  spawn 由共享并发闸保证，MessageDeliverer 无自己的 spawn 状态。
- **能力线形定案**：`HarnessCapability` 数组加 `'messaging'`（数组线形，非对象）；
  claude 面声明式规格落 `claude/messaging.ts`（headless 直接引用 `CLAUDE_RESUME`
  对象，契约测试 `toBe` 断言单源）；codex 面全 null + 四通道 unsupportedReasons
  （英文文案）。`GET /messaging/capabilities` 纯派生矩阵（discovery/inject/headless/
  watch + reasons），web 只渲染。
- **bus 帧命名定案**：`message.created / message.delivered / message.finished`
  （finished 带 `status: succeeded|failed|timeout`），SSE 仍走既有 `type:'hook'` 帧形。
- **前端刷新不扩 DataKey**（回退初版方案）：无发射源的键=死键；SessionMessages 弹窗
  直接订阅 `weave:hook` 帧（kind=message.*、sessionId 定向、500ms 防抖重拉，照
  TasksPanel 先例），App.tsx 零改动。
- **裁决表实现**：resolveChannel 返回 `ResolvedChannel | {reason}`（对象判别，
  避免通道名字符串与拒绝原因撞型）；auto 忙→inject 绝不无头抢占、闲→headless。
- **web 形态**：SessionList 行内「消息线程」按钮按能力矩阵门控（表驱动，不写死
  harness）；SessionMessages 弹窗 = 双向时间线（**以会话为锚**：它收到的靠右、它
  发出的靠左）+ 模式选择器（auto 恒在，inject/headless 按矩阵门控）+ 状态徽标 +
  输出折叠 details；发送走 fb 三态 + 失败 toast。
- **清理联动**：删会话/归档项目连带消息行（archive purged 计数含 `messages`，
  双向端任一落在该项目即算）。
- **CLAUDE.md**：「七能力槽」已随本批更正（红线预告项）。

验证：harness 契约 5/5、deliverer 裁决 15/15、web dict/tasks 38/38、合并态全量
server 88 文件 867/867 绿；两 tsc（server+harness 包根、web）全绿。

### 批 2 实施记录（2026-10-14 落库）

watch 引擎 + 路由 + web 铃铛面全量落地，与设计的偏差与定案：

- **触发点从 dispatcher 迁到 ingest 消费链**（设计原文「dispatcher.onIngest 单点」）：
  实际挂 `handleIngestedRecords`（inbox-worker，消息域）——dispatcher 是规则自动域，
  有 `readHooksEnabled` 早退门控，watch 不该被规则开关连坐；消息域与规则域分离，
  dispatcher 零改动。
- **`created()` 即时 fire 超设计补齐**：订阅落库时目标已空闲（`turnOpenOf===false`
  服务端基线）→ 立即 fire 不等下一拍——「空闲时提醒我」点在空闲会话上，答案就是
  现在；turnOpen 未知（null，行刚消失的竞态）不猜，留给 ingest/补射路径。
- **fire 同步化**：markFired CAS 先行 + bus.emit 均同步，`fire()` 收敛为同步方法
  （返回是否真的落定）；inject 投递 fire-and-forget、拒绝不回滚不重试（one-shot
  已落定）。CAS 即同批 Stop+SessionEnd 双事件与「补射 × ingest 竞速」的统一收敛点
  ——三路径任意竞速都只有一条副作用。
- **路由集超设计**：新增 `GET /messaging/watches`（pending 全量；web 自行按
  `watcherSessionId===null` 过滤 dashboard 行——会话订阅由服务端注入通知，不占铃铛）。
  POST 校验链：目标面 idleSignals 空 → 409（reason 优先面声明）；watcher 会话的
  inject 通道缺席 → 409（fire 时必然无声丢弃，提前拒）。
- **sweep 补射挂既有时钟**（7.3-1 落地）：`SessionSweeper.sweep()` 清空循环**之后**
  调 `sweepTerminated()`——同 tick 内刚清掉的空会话的 watch 拿到确定性释放；判死
  数据源 = `listWithCounts()` 行（带 harness/lastSeenAt/eventCount 计算字段）过
  `pidAliveOf`，目标行消失 = 等待不可解 → fire；null 不猜。
- **purge/archive 联动不计数**：`deleteBySession`/`deleteByProject`（双端 OR）挂上，
  但 purged 返回形状不变（archive 测试零改动）——行数极少的域不值得为计数改公共
  API 形状。
- **web prop 改造**：SessionList 的 `messagers` 过滤集 → 完整
  `capabilities: ReadonlyMap<Harness, MessagingCapability>`（行内按字段判：
  消息按钮 inject||headless、铃铛 watch 位）——「表驱动门控」不再预过滤，未来加
  按位零改动。铃铛形态：Bell（未订）/ BellRing amber（已订，点击取消）；fb 键
  `watch:<sessionId>`，`watch.fired` 帧重拉订阅面。
- **App toast**：SSE hook 帧分支 `watch.fired && watcherSessionId===null` → info
  toast（label 查会话表回落 id 前 8 位）；会话订阅的通知已由服务端注入其线程
  （message.* 帧走面板弹窗），App 不重复打扰。`HookFrame` 镜像加
  watchId/targetSessionId/watcherSessionId 三字段。
- **镜像修正**：api.ts `MessagingCapability.unsupportedReasons` 批 1 笔误写成
  `string[]`，实为按通道键对象（无消费方，随手修）。

验证：watch-engine 15/15、sweeper 扩展 6/6、全量 server 89 文件 883/883 绿、
web 10 文件 89/89 绿；两 tsc（server+harness 包根、web）全绿。

### 批 3 实施记录（2026-10-15 落库，三笔：① CLI `9f9ca8d` ② 引擎 `a0624e7` ③ 画布 `47da60c`）

**① CLI 发起面（`weave msg`；2026-10-14 整树移除，见「批后修复与定案」③）**：

- **`MessagingSurface.sessionEnv` 新槽**：会话内 env 变量名是 harness 知识——claude 声明
  `CLAUDE_CODE_SESSION_ID`，CLI 经 registry 面取，不散写 harness env 名。这是 D4「agent
  在会话内发起编排」的寻址底座：CLI 进程读自己的 sessionEnv 即知 fromSessionId。
- `weave msg ls [ref]`（可寻址会话表 + 线程查看，MSG 列按能力矩阵门控）/ `send <ref> <text>
  [--mode]`（fromKind=cli，会话内自动带 from）/ `watch <ref> [--notify]`（会话内 = 通知
  注入本会话；会话外 = dashboard 订阅）/ `reply <text>`（from 即 to，D4）。
- 寻址三级：精确 id → id 前缀 → 标题模糊，多命中带候选报错；纯函数单测覆盖。

**② 序列编排器（server）**：

- **无状态引擎设计**：`SequenceEngine` 无内存权威态，全部状态在 `session_sequences` 行
  （steps JSON 携带 messageId——步触发后回填，是重启恢复的判据）；`cursor` = 正在等待
  完成的步下标。步完成判据按通道分叉：headless 步 = bus `message.finished` 帧
  （messageId 匹配 `steps[cursor]`）；inject 步 = ingest 到达目标会话 idleSignals 事件
  （经面取，与 WatchEngine 同口径同竞态）。步完成 → `advanceCursor` CAS（同批
  Stop+SessionEnd 双事件只赢一次）→ fire 下一步；终态 `finish` CAS。
- **hop 上限定案 = steps ≤ 3**（D5 防环）：路由 400 直拒，引擎不数 hop——步数即链长，
  上限在创建点收口比运行时计数更简单。
- **同步失败窗口补判**：headless 同步失败路径（isBusy 竞态/spawn throw）在 send 返回前
  就发 finished 帧——彼时 messageId 尚未落库、帧匹配不上，故 send 返回后按消息行终态
  补判（succeeded → advance；failed/timeout → finish）。`rearm()` 对称覆盖宕机窗口：
  未触发步（messageId null）→ 补 fire；injected → 续等；running → finish failed
  「daemon restarted during headless step」；已落终态但帧未达 → 按行终态补推进。
- **trigger await 化**：路由创建即 `await trigger(row)` 后重读行再返回——响应带
  `steps[0].messageId`（画布首步状态可即时渲染）。
- **骑乘竞态已知残差**：inject 步的 idle 推进可能在骑乘 Stop 事件上提前一拍
  （additionalContext 使宿主续跑，Stop 本身是 injectable 事件）——与 WatchEngine 同
  口径，引擎头注释记录，不另加机制；inject 到死闲会话永不推进（用户显式选择非抢占）。
- 路由步级前置校验（404/400/409 带步号）；bus 帧 `sequence.step` / `sequence.finished`
  走既有 hook 帧形透传；级联四处（purge `deleteMentioning` / archive
  `deleteByProject` / sweeper `sweepTerminated` / inbox `onEvent`）。
- **顺带补批 2 缺口**：start.ts/dev-entry.ts 的 sweeper 调用此前漏传
  `watches: sessionWatches`（purge 的 watch 级联在两入口失效）——随本批装配补上。

**③ 编排画布（web）**：

- **挂载定案：新 `MainCategory 'orchestrate'` 第五卡**（Waypoints/teal）——App.tsx 零
  改动（selectCategory 泛型本就吃新枚举；画布自管高度不进 'tasks' 的 overflow-hidden
  特例）；`countFor` 复用项目会话数。编译器替我们找到的第二个穷举点：LibraryPanel
  `categoryLabel` 补分支。
- **布局纯函数抽离**（`sequence-canvas-layout.ts`，可单测）：会话按 harness 泳道分列
  （名表序、未知归末列、只给在场 harness 开道），泳道内纵排；消息为边——两端会话
  都在画布上才成边（dashboard/cli 投递无源端，由节点「收」计数承载）。
- **线程聚合 N 次拉取**：每会话 `listSessionMessages` 聚合，取「本会话发出」切片去重
  （双向线程里每条会话间消息恰出现一次）；重拉只看会话 id 集是否真变（状态总线每帧
  refetch 都换数组身份，不能挂身份依赖）。
- **门控全表驱动**：builder 目标会话按 inject||headless 过滤、通道选项按所选会话能力
  展开（与 SessionMessages 同口径）；目标会话消失诚实降级（清选择保文本回 auto），
  不留幽灵值。
- **SSE 防抖同族**：`message.*` 帧定向本项目会话重拉线程、`sequence.*` 重拉序列
  （帧不带项目语义，防抖后一次 GET 足够便宜）；序列列表按「任一步目标命中本项目
  会话」客户端过滤（服务端一张全量表，`deleteMentioning` 同判据）。
- 序列行：状态徽标 + 进度（cursor+1/n）+ 逐步明细（messageId 反查消息行状态着色，
  未触发显式「未触发」）+ running 可取消；点击可收消息节点开 SessionMessages 弹窗。

验证：① CLI 寻址纯函数 10 例 + harness 契约 9/9；② engine 20 + 路由 6 + sweeper 1，
全量 910/910；③ 布局纯函数 4 例，web 93/93、全仓 126 文件 1320/1320 绿；两 tsc
（server+harness 包根、web）全绿。

### 批后修复与定案（2026-10-14，四笔：`5ee36f0` + `509f393` + `a4bfac3` + `7c51d45`）

**① 无头回合 win32 ENOENT 根治（`promptStdin` 契约）**：`claude` 在 Windows 上是
npm 的 `.cmd` shim，`CreateProcess` 不认、不经 shell spawn 必 ENOENT（批 1 在
resume-runner 注释里显式延后的「生产细节」）。修法进契约而不进 runner 私有逻辑：
`ResumeCommandSpec.promptStdin?: boolean`——true 时 args 不含 prompt、prompt 经
stdin 传递（实测 `claude --resume <sid> -p` 读管道），命令行只剩裸名 bin + 固定参数
+ sessionId（uuid），**无用户内容**，win32 由此可安全经 shell 启动（joined 单串、
免 node 对 args+shell 的 DEP0190 警告；bin 为带路径覆盖值时不走 shell、直接 spawn
真实 exe）。实测踩掉的第二个坑：**win32 下 `shell+detached` 组合管道输出全丢**
（exit=0 但 stdout 空），故 shell 模式必关 detached——POSIX 的进程组强杀语义
不变。端到端实机验证：shell 单串 + stdin prompt + resume 临时会话回复成功。

**② 手动发送缺省 inject（产品语义定案）**：人机消息不该无头抢占——已有窗口的会话
下一拍 hook 事件注入，未开的会话入 outbox 队列、**随其下次 SessionStart 加载**
（`INJECTABLE_EVENTS.claude` 本就含 SessionStart，无需新机制）。落点：路由缺省
（`POST /sessions/:id/messages` body.mode 缺省 auto→inject）、CLI `weave msg send`
默认与 `reply`、web 弹窗初始选项（inject 不支持的面回 auto）。`auto` 的「忙→inject、
闲→headless」语义**原样保留**——它是编排的语义（序列步驱动无人值守会话），显式选
它的人知道自己在干什么；缺省即安全。

**③ CLI 发起面移除（产品定案，`a4bfac3`）**：人在终端就直接在目标会话窗口输入，
CLI 注入面无必要——`weave msg`（ls / send / watch / reply）**整树删除**，消息注入收敛
web 单入口（会话消息弹窗 + 编排画布），watch 订阅走 web 会话列表铃铛（引擎零改动）。
`MessagingSurface.sessionEnv` 槽随之摘除（唯一消费者是 CLI 的会话内身份定位；D7 记为
已移除）；`fromKind='cli'` 亦清理（`7c51d45`）——union 收敛 `'dashboard' | 'session'`
（`'session'` 由 watch 引擎产出；用户 DB 实测零 cli 行，无历史渲染包袱），路由
fromKind/fromSessionId 入参面保留（批 5 联邦转发正需）。

### 消息域重塑（2026-10-15 产品定案）：prompt 通道 + 纯文件管道

用户四轮定案（原话）：

> 「不对，我的会话消息是给会话发prompt，不是headless」
> 模式收敛拍板：**prompt 缺省 + 三模式保留**（后经下两条收敛为：手动面
> 仅 prompt，三模式留给编排域；中途一度改口「默认选自动」，终局再收敛
> 「前端不要选模式、按优先级自动完成、只有降级操作」——降级发生在
> prompt 通道**内部**（层① → 层②），见「手动弹窗无模式选项」条）
> 「会话消息不要入库，仅落本地文件，消息消费后就移除了」
> 「会话消息选项记得清理」「claude 自身不是有 sendmessage 机制吗，不要
> 通过 terminal 完成」

**总纲：消息域 = 纯递送管道，不是记录系统。** 消息的唯一归宿是目标会话
自己的转录（claude 的 jsonl），weave 只在投递前短暂持有；送达即删，无任何
DB 行。D1 的 `session_messages` 表、第五章的消息 SQL、批 1/3 的线程视图与
messageId 反查，均被本定案重塑。

**存储模型**：

```
发送 → <dataDir>/hooks/promptbox/<shard>.jsonl（本地文件队列，daemon 只写）
     → 送达（按模式分叉，见下）
     → 移除（文件行删除；无 DB 行、无归档）
```

- **`session_messages` 表退役**：停写 + `DROP TABLE IF EXISTS`（现存行均为
  测试数据随表删）；`SessionMessageRepository` 与消息域 DB 级联全数移除。
  `fromKind` 概念随之退役——管道无来源记录，`fromLabel` 只活在 inject 信封
  渲染里（路由 fromKind/fromSessionId 入参面保留，批 5 联邦正需）。
- **prompt 队列独立成 `promptbox/`，与 outbox 严格分离**：outbox 行由目标
  会话内 handler 消费成 additionalContext（跨端契约不动）；prompt 行由
  **daemon** 冲洗，handler 永不碰。

**prompt 通道三层投递**（用户定案 2026-10-15 两轮合成：先「claude 原生
SendMessage、不走 terminal」，后补「不支持 sendMessage 的 harness 回退
send-text、注意多终端」——早期「send-text 作主通道」作废，但 send-text 本身
**不作废**，降为兜底层）：**层① 原生中继**（harness 有 peer 消息机制）→
**层② 终端 send-text 兜底**（无原生机制的 harness）→ **层③ promptbox 队列**
（都不行，等待）。

**层① 原生中继**（claude；spike E2E 实测定案）：

- claude 每个持久会话在 peer 注册表 `~/.claude/sessions/<pid>.json` 登记
  `sessionId/name/status/messagingSocketPath`（命名管 `\\.\pipe\LOCAL\
  cc-msg-<32hex>`，私有帧协议 `uds-messaging` + inbox auth——**weave 不
  逆向、不直连**，走公开工具契约）。
- 投递 = 受限 headless 中继：`claude -p --no-session-persistence
  --tools SendMessage,ListAgents -n weave` + stdin 指令（**中性 cwd**——
  避开项目 hooks 报幽灵事件；`--no-session-persistence` = 不入 peer 注册
  表零污染；实测 15.8s 全环、目标窗口可见 `Message from @weave: <原文>`、
  idle 立即唤醒、忙则下一 tool round 到达）。
- 中继显示名 `-n weave`——**原文即消息体**，不加信封（claude 的消息头
  `Message from @weave:` 自带出处）。
- **单向注入（只对手动面）**（用户 2026-10-15 追问「sendmessage 对其他会话
  来说是在聊天、会回消息，可不可以要求不回复，我只是想给模板会话注入
  prompt」，随即补「注意，sendmessage 在会话编排功能中，还是需要保留双向
  对话的」）：中继指令末尾是「发完即 stop」，进程随即退出——手动面**根本
  没有接收方会话**，目标若按聊天习惯回一条，回的是个已消失的 @weave（打空、
  无害但白烧一轮），故手动面投递载荷**头部带单向注记**（`[weave one-way
  injection — no reply is expected: …]`）。**编排域（序列步）不置该标记**：
  那是要保留的双向对话，载荷原样投递、注记不加（`oneWay` 由触发源决定：
  手动路由 true、序列引擎缺省 false）。注记随 `oneWay` 落 promptbox 行，
  daemon 重启后冲洗不丢。weave 能控的只有两样：中继进程的 stdin 指令 +
  投递载荷文本；目标的回不回是 model 判断，没有可设置的协议级「免回复」
  开关——所以注记是**文本内引导**而非硬闸，属诚实能力声明的一部分。指令
  全文归 harness 规格（`PromptRelaySpec.instruction`，claude adapter 实现），
  server 只传 peer 寻址名 + 原文 + `oneWay`。

**层② 终端 send-text 兜底**（无原生 peer 消息的 harness，如 codex）——**经
`TerminalBackend` 抽象泛化，不散写 wezterm**（用户定案「多终端支持，不仅是
wezterm，还有 terminal、ghostty」）：

- 后端新增文本通道能力（枚举 prompt pane + 注入文本），**按后端诚实声明**：
  wezterm 实现（`cli list` 枚举 pane、`cli send-text` 注入，多 mux 走既有
  mux 枚举基建）；Terminal.app / ghostty 按各自通道现实实现，没有通道的后端
  默认不支持、不谎报——未来哪个后端有了通道 = 实现该方法即点亮，调用方零改动。
- pane↔会话映射（spike 实测）：pane 标题 == 会话标题（忙时 ✳ spinner 前缀
  剥掉再比）且 pane cwd == 项目路径；**歧义（多 pane 命中）拒绝不打**。
- 投递配方（字节级实测）：send-text 缺省 bracketed paste 打原文（内含 CR 是
  字面内容、不会提交）+ `--no-paste` 补一记 CR 提交。
- **没开的会话**：入 promptbox 队列，双触发冲洗——① weave 项目会话由 ingest
  事件即时触发；② 隐藏刷新器（形状同 `terminal-counts-refresher`：只在队列
  非空时探）扫 peer 注册表（层① 目标）与 pane 枚举（层② 目标），幂等。
- 门控分两层合成：`MessagingSurface.prompt`（层① 原生，claude 声明中继规格；
  codex 等**不支持 sendMessage 的面声明 null + 原因**）+ 终端文本通道可用性
  （层②，`TerminalBackend` 能力、随 settings/机器变）。**能力矩阵 `prompt`
  列 = 原生 || 终端兜底可用**，两者皆无才置灰（409 + `unsupportedReasons.prompt`
  ＋终端无通道原因）；未来 harness 自带等价机制 = 实现自己的 prompt 规格，
  server/web 零改动点亮。peer 注册表读取（sessionId→name/存活）是 harness
  知识，落 claude adapter。
- **手动弹窗无模式选项**（用户定案「选项清理」+ 终局改口「前端不要选 auto
  还是什么模式了，按照优先级自动完成，只有降级操作」「默认就是 sendmessage+
  积压消息，降级时，通过 terminal send-text」）：纯文本框 + 发送，恒走
  prompt 通道——默认 = 层① 原生 SendMessage 中继，会话没开 = 积压入
  promptbox 队列；降级（无原生机制的 harness）= 层② 终端 send-text，
  **全自动、无入参**（路由无 mode 字段）。inject/headless/auto 只活在
  编排域（序列步显式选项），手动面 409 语义保留（层①② 皆无才置灰）。
- **三模式保留（inject/headless/auto）为编排域显式选项**（序列步 / 画布
  连线 / watch notify），编排语义不变；序列步新增 prompt 模式（完成判据 =
  idle 推进，同 inject 口径）：
  - inject：outbox 行（既有通道不动）；
  - headless：进程终态仅**内存 + SSE**，不落库；daemon 重启即丢（显式高级
    选项的合理代价）；`promptStdin` 契约不动；
  - auto：忙→inject 闲→headless 裁决不动。
- **web 线程视图 → 在途视图**：daemon 聚合 promptbox 文件 ∪ 内存态（中继
  运行中 / headless 运行中），`GET /sessions/:id/messages` 改读聚合源，
  `message.*` 帧的 id 改为管道发号（非 DB 主键）；送达即从列表消失，
  「历史」在会话自己的转录里。
- **序列引擎适配**：`session_sequences` 表保留（编排状态非消息）；
  `steps[].messageId` 语义改为管道发号的内存关联（不再反查消息行）；
  步 mode 增 `prompt`（步级前置校验按 mode 验对应通道：prompt = 原生中继
  ‖ 终端兜底，与能力矩阵同源）；画布步状态着色改 `sequence.*` 帧驱动；
  **重启时未确认步标记 interrupted、不重发**（宁可人续，不往会话重复打
  prompt）——取代批 3 的 rearm 补 fire 语义，已在途 injected/delivered 步
  续等 idle 不受影响。hop 上限（步数 ≤3）不动。
- **watch 通知**：同样纯管道（outbox 行、消费即删），本就非历史——零改动。
- **`MessageDeliverer` 裁决单点保留**：能力矩阵、404/409 语义拒绝、auto
  忙闲裁决全不变；只有落点从「DB 行 + outbox」变「文件队列 + 内存态」。

**实施批次**：① prompt spike（已毕，结论如上）→ ② 存储切换（已毕：表退役 +
promptbox + deliverer 管道化 + 中继 runner + peer 注册表 adapter + 层②
send-text 兜底：TerminalBackend 文本通道能力 + wezterm 实现 + pane 映射 +
队列双触发冲洗 + capabilities prompt 列）→ ③ web（已毕：弹窗纯 prompt 发送 +
在途视图；画布步 mode 加 prompt 选项待随 ④ 点亮）→ ④ 序列引擎适配（已毕：
步 mode `prompt` + 按 mode 的步级前置校验、interrupted 语义取代补 fire；
剩画布选项一处属 web 面）。

## 第七章 机制族参考：CronCreate 与「触发源 ⊥ 投递通道」（架构参考）

Claude Code 的定时任务机制（CronCreate）与 SendMessage 是**同一投递底座的两个前端**——
本方案将其拆解为架构参考：功能以**触发源粒度**解耦，而不是在投递引擎里加分支。

### 7.1 CronCreate 机制拆解

| 维度 | 设计 | 对本方案的启示 |
|---|---|---|
| 触发 | 5 字段 cron（本地时区）+ one-shot / recurring 两态 | one-shot 即焚与我们 watch 的 `fired_at` 同型 |
| 载荷 | `prompt` 字符串，到点**合成一条用户回合消息**注入会话——不是回调，与 SendMessage 进同一非抢占队列 | 时间只是触发源；投递通道零差异 |
| 门控 | 只在会话空闲（非查询中）发射 | 非抢占不变量与消息域/notify_when_idle 三处同源 |
| 持久 | session-only（随会话死）vs durable（落盘、重启续命、**错过的 one-shot 下次启动补射**） | 补射 = watch terminated 补射同型 |
| 上限 | recurring 7 天自动过期 | 防僵尸订阅的硬上限 |
| 防踩踏 | 避整点/半点 + 确定性抖动（周期 10% 封顶 15min） | 批 5 联邦与批 6 定时的注记 |

孪生件 ScheduleWakeup：**相对时长**自排程（非日历时刻），按 prompt cache TTL 选延迟——
「自定节奏续跑」原语；weave 的隐藏刷新器（探测定时 + 只在值变化时推 + 有订阅者才探）
已是同族纪律。

### 7.2 同构洞察：触发源 ⊥ 投递通道 ⊥ 能力面

CronCreate 与 SendMessage 共用「载荷入队 → 非抢占 → 回合边界送达」的底座，差异只在
**何时/为何入队**。对本方案即三轴独立演化：

| 触发源（何时/为何入队） | 形态 | 批次 |
|---|---|---|
| manual | dashboard 按钮（唯一人工面；CLI `weave msg` 已移除） | 批 1/3 |
| lifecycle event（idle） | watch 引擎 onIngest idleSignals | 批 2 |
| rule（hook 规则自动域） | dispatcher 既有链——**留在 dispatch 域不合并**（D1 边界） | 已有 |
| time | daemon 侧 scheduler 表，`from_kind='scheduler'` | 批 6 候选 |
| remote（LAN） | MessageRouter 转发，远端经同形面裁决 | 批 5 |

每个触发源 = **一个加法模块**（各自一张表/一个引擎），统一收敛到 `MessageDeliverer.send`
的同一入参面；投递引擎、裁决表、能力面、支持矩阵、web/CLI 全部零改动。这是消息机制
作为架构参考的本体：**解耦靠正交入参面达成，不靠框架**。

### 7.3 已决定的落点

1. **批 2 补射语义**（直接可抄）：durable one-shot 的「重启后补发错过任务」= watch 的
   terminated 补射同型——daemon 重启或目标异常终止（未打 Stop）后，扫未 fire 且目标
   已 terminated 的 watch 补 fire。
2. **循环订阅硬上限**：session_watches 一期仅 one-shot；若引入「每次空闲都通知」的
   recurring 形态，必须带 7 天式过期上限（防僵尸订阅）。
3. **批 6 候选（定时投递）**：daemon 常驻 = Claude Code 的 durable 档免费获得——
   scheduler 表（cron/一次性）+ 到点经 MessageDeliverer 投递，`from_kind='scheduler'`，
   裁决/通道/信封全复用。防踩踏抖动（避整点、确定性偏移）进该批设计注记；联邦态下
   各 daemon 只调度**自己的出站**，不做跨机全局调度表。
4. **载荷自包含纪律**：定时/watch 触发的 notify 文本必须自包含（接收会话上下文可能
   已被压缩/过期）——信封 `fromLabel/at/mode` 之外，触发类消息须带「为何此刻收到」
   （如 `trigger=watch:<target> idle` / `trigger=schedule:<name>`）。
5. **插件化边界（红线）**：触发源先以「命名模块 + 落库表」形态存在，**不预抽
   `TriggerSource` 统一接口**——仅当第三种以上触发源落地且形态收敛时再议（届时按
   CLAUDE.md 与项目所有者确认）。功能解耦由 7.2 的正交性保证，框架化是后置选项而非
   前提。

---

## 范围红线（全程不动）

- `hook_dispatches` 表与指令池语义（规则自动域）；
- `mirror/inbox/outbox` 跨端契约（只消费 `appendOutbox`，不改行形；回执增强为可选后批）；
- **不新增抽象类**（全仓仍仅 `InitPipeline` / `TerminalBackend` 两处模板方法；
  `MessagingSurface` 是接口能力槽，与 `PluginSurface` 同形）；
- 能力槽清单以 `driver.ts` `HarnessCapability` 为唯一权威——messaging 入列，
  CLAUDE.md「六能力槽」表述随批 1 更正（本项目所有者已拍板）；
- SSE 仍单通道（新 kind 走既有帧形；web 仍只 `sse.ts` 一个客户端、不轮询）；
- web 只渲染不判定（支持状态判定在 server，web 查矩阵渲染）；
- hooks 非阻塞不变式：消息动作全部异步（outbox 追加 / detached spawn / fire-and-forget 转发）。

## 测试策略

- **能力面契约测试**：claude 面 = 全通道矩阵 + 单源引用断言（headless 引用同一
  `CLAUDE_RESUME` 对象）；codex 面 = 全 null + reasons 齐全；「新 harness 只加实现」
  的装配测试（registry 挂槽 / 摘槽，消费方行为随面翻转）。
- `MessageDeliverer` 裁决表逐行测试（上表 7 条，含 codex 目标 409 原因文案）。
- ResumeRunner 抽核心：既有 dispatch 测试闭式迁移 + message 适配器新测
  （回执/终态/并发闸复用验证）。
- watch：idleSignals 触发（经面取事件名，非散写）、一次性失效、terminated 补射、
  dashboard/会话双投递形态。
- web：tsc 两跑（包根 + web）+ 组件测试镜像派生逻辑（支持徽标、模式选择器门控）。
