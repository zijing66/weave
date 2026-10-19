# P1：ZCode 投递

> 目标：dashboard 手动面能把一条消息真送进 zcode 会话（层② 终端击键），送不到时
> 进层③ 队列等冲洗，**编排域 inject** 能把非抢占注入随 hook 事件带进会话。
> 不承诺：层① 原生中继、inbox 直投、无头强制回合、旁路问、图片。
>
> 依赖：P0（事件采集通）、R2（inject 镜像分条）。

## 1. 一句话结论

**P1 不改 server 一行投递代码，只填 `weave-harness/src/zcode/messaging.ts` 的一张能力表。**
理由在下面逐条给出处：ZCode 在 weave 的三层投递模型里，恰好每一层都能用「已存在的
通用机制」落到，唯独没有的两个专用机制（原生 peer 中继 / inbox socket）本来就在
`MessagingSurface` 上声明为可空。

## 2. 通道裁决

| 通道 | 裁决 | 出处 / 理由 |
|---|---|---|
| `discovery` | **true** | P0 已让 zcode 会话进列表；发现即成立 |
| `prompt`（层① 原生 peer 中继） | **null** | 见 §3：ZCode 的 `SendMessage` 不是 peer 消息 |
| `promptInbox`（层①-a 直投） | **null** | socket + token 是 claude 专有机制（`CLAUDE_CODE_MESSAGING_SOCKET`）；ZCode 不导出这类凭据 |
| `inject`（忙排非抢占） | **`{ rideEvents: INJECTABLE_EVENTS.zcode }`** | weave 已有的 outbox 机制：注入规则随 hook 事件的 `additionalContext` 进会话。ZCode 的 `HookSpecificOutput` 联合支持 `additionalContext`（`contracts/src/hooks/index.ts:174-194`） |
| `headless`（闲投） | **null**（P1） | `-p` 能不能从 stdin 读 prompt 未取证（🔬4）；不在 P1 验收面 |
| `idleSignals` | **`['Stop']`** | `HARNESS_LIFECYCLE.zcode.close`；zcode 无 `SessionEnd`，故不追加会话终点 |
| `imageAttach` | **null**（P1） | 不走假设：ZCode 输入框收不收裸路径待 🔬。置 null 即附件钮灰，是诚实的默认 |
| `sideQuestion` | **null** | ZCode 没有 `/btw`（源码全仓 grep 无该子命令）；也没有 claude 那种「skipTranscript 的 fork 子 agent → SubagentStop」链路（ZCode 无 `SubagentStop` 事件） |
| `unsupportedReasons` | 逐条中文 | 每个 null 都写清「为什么 + 怎么办」，UI tooltip 直用 |

## 3. 为什么 `prompt` 必须是 null（这条最容易搞错）

ZCode **有**一个叫 `SendMessage` 的工具（`contracts/src/tools/send-message.ts:4`），
名字与 claude 的 peer 消息工具撞车，但语义完全不同：

```ts
to: z.string().describe("Recipient: local agent ID returned by Agent (format agent_<uuid>).")
```

收件人是**本会话内部的子 agent**（`agent_<uuid>`），不是另一个会话。claude 的
`SendMessage` 寻址 `~/.claude/sessions/<pid>.json` 的 peer 注册表、可以把消息投进
另一个正在跑的会话；ZCode 的这个不行。

⇒ `PromptRelaySpec` 无法为 zcode 构造：`bin/args/instruction` 那套「受限 headless
进程调宿主自己的 peer 消息」在 ZCode 上没有落点。硬凑成 `zcode -p --tools SendMessage`
只会把消息发给一个不存在的子 agent。

**ZCode 真正的跨会话面是 SessionMailbox**（`core/src/hooks/session-mailbox.ts` +
`adapters/src/mailbox/index.ts`）：`<root>/<sid>/unread/*.json`，宿主自己在
`UserPromptSubmit` / `PostToolUse` / `Stop` 三个事件上 drain，drain 结果作为
`additionalContext` 进上下文；`Stop` 上还会带 `continue: true` 让回合接着跑。
这正是 README 里排在 P3 的那条实验——**它不该在 P1 混进来**，原因见 §7。

## 4. `weave-harness/src/zcode/messaging.ts` 的形状

```ts
import { HARNESS_LIFECYCLE, INJECTABLE_EVENTS } from '@weavecode/core';
import type { MessagingSurface } from '../driver.js';

export const ZCODE_MESSAGING: MessagingSurface = {
  harness: 'zcode',
  discovery: true,
  prompt: null,
  promptInbox: null,
  inject: { rideEvents: INJECTABLE_EVENTS.zcode },
  headless: null,
  idleSignals: [...HARNESS_LIFECYCLE.zcode.close],
  imageAttach: null,
  sideQuestion: null,
  unsupportedReasons: {
    prompt: 'ZCode 的 SendMessage 只能发给本会话的子 agent，没有跨会话 peer 消息通道——改走终端',
    promptInbox: 'ZCode 不向 hook 导出会话内收件箱凭据',
    headless: '待取证：zcode -p 能否从 stdin 读 prompt',
    imageAttach: '待取证：ZCode 输入框是否识别裸图片路径',
    sideQuestion: 'ZCode 没有 /btw 旁路问',
  },
};
```

`unsupportedReasons` 的文案口径与 claude/codex 相同（中文、面向用户、说明替代路径）。

## 5. server 侧为什么零改动（推定链条）

`MessageDeliverer` 的层序是「直投先行 + 两处按 `oneWay` 定的层序」：

- **手动面（`oneWay=true`）**：直投 → 层② 终端 → 层① 中继。
  zcode：直投 null（`promptInbox`）→ 层② 终端 ✅ → 层① null（`prompt`）。⇒ 落到层②。
- **编排域（`oneWay=false`）**：层① 中继 → 层② 终端。
  zcode：层① null → 层② 终端。⇒ 同样落到层②。
- 层③ 队列：所有层都失败时入队，与 harness 无关。
- **prompt 门控** = `MessagingSurface.prompt || 层② 终端文本通道可用`，zcode 靠后半句过闸。
- **`forceTerminal`（强制终端）**：本就把层序收窄成只剩层②——对 zcode 与自动档等价。

⇒ `messaging.ts` 填完，`GET /messaging/capabilities` 的派生矩阵自动正确，
web 的按钮与模式选项全表驱动、不写死 harness，无需改。

**唯一要核的一处**：「层② 终端文本通道可用」这个判断在 server 里读的是后端的
`available`（`TerminalBackend` 能力面），与 harness 无关 ⇒ 不涉及 zcode。
落到具体终端后端时，pane 定位见 §6。

## 6. 层② 的落地细节

### 6.1 pane 定位：locator 键都在，只有 `wt` 的 pid 缺

层② 的 pane 定位靠会话自己上报的 pane env（hook 子进程继承会话进程的环境变量）。
ZCode 的 hook 子进程照样继承环境，故：

| 终端 | 定位键 | zcode 上是否可用 |
|---|---|---|
| wezterm | `WEZTERM_PANE` / `WEZTERM_UNIX_SOCKET` | ✅ 继承即有 |
| konsole | `KONSOLE_DBUS_SERVICE` / `KONSOLE_DBUS_SESSION` | ✅ |
| iTerm2 | `ITERM_SESSION_ID` | ✅ |
| Windows Terminal | `CLAUDE_PID`（会话进程 pid） | ⚠️ ZCode 不导出该键（`configured-runner-input.ts:79-85` 只有 session/project/plugin 四类） |

落法：生成脚本里 pid 字段取 `process.env.CLAUDE_PID || String(process.ppid)`。
`weave-harness` 的键表来源是 core 的 `TERMINAL_LOCATOR_ENV`（唯一出处），
**不要在 zcode 模块里另抄一份键表**——改的是生成脚本里 `terminalEnv()` 读 pid 的那一句。
🔬5：Windows 上 hook 子进程的 ppid 是否就是 zcode 会话进程（会否中间夹一层 shell）。

### 6.2 投递配方：bracketed paste + 提交键

沿用 `MessageDeliverer` 的既有配方（bracketed paste 打原文 + 关掉 paste 后一记 CR）。
ZCode 的 TUI 是否是 Ink/React 一类的行编辑器、认不认 bracketed paste，🔬4。
**不认时的降级**：逐字符写入 + CR（现有 `sendKeys` 那套），可能触发自动补全误触——
届时把「不走 paste」记进 `TerminalBackend` 的既有分派里，而不是在 zcode 模块里分叉。

### 6.3 回执：`raw.prompt` 直通，不需要改 server

`inbox-worker.ts:412-419` 用 `promptTextOf(payload)` 取 `payload.raw.prompt`，
再交给 `MessageDeliverer.onSessionPrompt` 做比对。ZCode 的
`UserPromptSubmitHookInput` 字段名就是 `prompt`（`contracts/src/hooks/index.ts:119`），
且 `createCompatibleHookStdin` 用 `{...input}` 全量透传 ⇒ `raw.prompt` 存在。

⇒ 回执链路（剥运输装饰 → 长文本包含 / 短文本整条相等 → 一条 UPS 核销多条）全部复用，
零改动。**这也是 P1 最值得先跑验收的原因**：它同时证明了采集、pane 定位、
终端写入、回执比对四条链都对。

## 7. 为什么 SessionMailbox 不并进 P1

三个硬理由，都是「现在做会留下还不能自洽的语义」：

1. **叫不醒闲着的会话**。drain 只在 `UserPromptSubmit` / `PostToolUse` / `Stop` 三处发生
   （`core/src/hooks/session-mailbox.ts:44-50`）。会话停在输入框等你说下一句时，
   这三个事件一个都不会来，写进 `unread/` 的邮件就一直躺着。
   而层② 终端击键正是能叫醒它的那条路 ⇒ 即便做了 mailbox，**层② 仍是必需品**，
   mailbox 只能是「忙时更快的一条捷径」，不是替代品。
2. **送进上下文 ≠ 用户消息**。drain 结果以 `<session-message source="mailbox" …>`
   形式作为 `additionalContext` 进上下文，不是一条 user 消息 ⇒ **不会触发
   `UserPromptSubmit`** ⇒ weave 现有的回执判据（UPS 原文比对）**认不出来**，
   那条消息会一直挂在「已发出、未回执」，120s 后把该会话的队列冲洗闸关上。
   要做就得为它单开一套回执口径（例如按 `PostToolUse` 之后的模型输出里出现回声），
   这是**新的判据**，不是加法。
3. **邮件永不清除**。`drainUnread` 把文件 `rename` 到 `read/`，不删
   （`adapters/src/mailbox/index.ts:40`）⇒ 长期使用会在 `~/.zcode/mailbox/<sid>/read/`
   无限堆积。这不是 weave 的文件，我们要么接受（脏）要么清理（越界）。

⇒ 维持 README 的排期：P3 实验项，做的时候要**同时**交出「回执口径」与
「read/ 增长处置」两个答案，而不是只把文件写进去。验收门槛：直投 < 1s 到达、
且不误触暂停闸。

## 8. 已知不给的面（写清，避免以后被当缺陷）

| 面 | 状态 | 用户看到什么 |
|---|---|---|
| 发消息的「自动」档降级链 | 只有层② + 队列 | 发送键正常工作；光标旁那枚通道选择器仍可用（选「强制终端」对 zcode 与自动档等价） |
| 编排序列的 `inject` | ✅ 可用（走 outbox） | 序列步选 inject 能跑 |
| 编排序列的 `headless` / `auto` | 不可用 | 步级前置校验按 mode 验通道 → 选 headless 直接给出不支持原因，不静默失败 |
| 旁路问（对话窗头部那枚按钮） | 不渲染 | 能力面 `sideQuestion: null` ⇒ 按钮不出现 |
| 图片随附 | 附件钮灰 | `imageAttach: null` |
| 会话「已中断」态 | 不出现 | 打断后停「生成中」直到下一条事件（见 P0 §7.1） |

## 9. 验收

1. **能力矩阵**：`GET /messaging/capabilities` 的 zcode 行 =
   `discovery✅ / prompt❌ / inject✅ / headless❌ / watch✅ / imageAttach❌ / sideQuestion❌`，
   与上表一致；`unsupportedReasons` 有中文原因。
2. **手动面投递**：对一个已开 zcode 会话发一条消息 → 文本出现在 zcode 输入框并被提交、
   zcode 开始回答；`GET /sessions/:id/messages` 或对话面板上该条从队列退场、
   挂在对应 UPS 气泡上（**不是**「已送达」写成「已读」）。
3. **回执核销**：连发三条（不同文本）→ 三条各自被自己的 UPS 核销；宿主把三条合成
   一次提交时，一条 UPS 核销三条（既有遍历逻辑）。
4. **层③ 队列**：把 zcode 窗口关掉（pane 找不到）→ 发送仍回 201，行落 `pending`/入队；
   重开窗口后下一轮冲洗送达。
5. **判死**：会话进程退出后发 → 落 `failed` + `reason: 'offline'`，web 出中文说明，
   **不入队、不假装排队**；「重发」可逆。
6. **inject**：在 zcode 事件上建一条 inject 规则 → 镜像文档含它（R2 的产物）→
   下一拍 `PostToolUse` 后会话上下文里出现注入内容（🔬4 一并取证）。
7. **强制终端**：发送键旁选「强制终端」→ 仍只走层②，成功。
8. 两个 tsc + 三个包测试全绿。

## 10. 提交切分

| 提交 | 内容 | 可独立验收 |
|---|---|---|
| P1-1 | `zcode/messaging.ts`（能力表 + 文案）+ 注册进 driver | 能力矩阵正确（验收 1、8） |
| P1-2 | 生成脚本的 pid 回落（`CLAUDE_PID \|\| process.ppid`）+ pane 定位取证 | 验收 2、3 |
| P1-3 | 🔬4/🔬5 结论落地（paste 配方 / ppid 真值）+ 队列与判死的实机回归 | 验收 4、5、6、7 |

P1-2 与 P1-3 的取证结果按仓库约定写进 `docs/DECISIONS.md`（带日期）。
