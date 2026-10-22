# P1 — 原生插件与投递（`@weavecode/dsh-plugin`）

> 批目标：在 dashboard 里对 dsh 会话发一条 prompt，它出现在 dsh 的对话里并开始跑；
> 「停止」能把当前回合 cancel；队列/取消的语义与 claude 手动面同口径。
>
> 硬前置：P0 已落（要有会话 id 与事件链才能寻址与判回执）、🔬6/🔬7/🔬8 已取证。

---

## §1 为什么投递必须进程内

| 候选 | 为什么不成立 |
|---|---|
| **层② 终端击键** | 没有 TUI（C1）。会话跑在浏览器/Electron 里，host 进程没有可打字的 pane——`sendKeys`/`sendText` 对 dsh 无对象 |
| **ACP 外部投递**（`dsh --profile acp`） | ACP 有 `session/resume` + `session/prompt` + `session/cancel`（`packages/acp/acp/README.md:69,72`），但它是**另一个 host 进程**：会话持久化后端只有「进程内单写者认领」（`session-persistence-jsonl/README.md:107`），web 里正开着的会话被第二个进程 append 大概率写坏或直接被拒。**只能对冷会话生效**，对活着的会话等于没用 |
| **hook 桥注入**（`PreStepDecision` / `additionalContexts`） | 见 `01` §0：进程级单份配置 + 用户全局 profile 污染 + hook 超时在事件路径上 |
| **进程内插件**（选定） | 插件跑在 dsh 自己的 host 里，`ctx.sessionController` 与 agent handle 是**官方支持的进程内 API**：prompt（可 resume 冷会话）/ 队列改写 / cancel / rename（`packages/api/session-controller/README.md`、`packages/core/agent/README.md:47,89-91`）。零子进程、零键序、有结构化回执 |

一句话：**dsh 把「投递」做成了 API，claude 把它做成了键盘。** 我们按它给的那条走。

> 唯一会推翻本节的前提：接入目标其实是**别处自建的 TUI 构建**（发布面没有 TUI，证据见
> `04` 的 C1 与 `README` 的「先对齐一条事实」）。若真有一个 dsh TUI，层② 立刻成立
> ——投递改 `sendText`、中断改一记 ESC、作答改键序，本批可整体降级为可选。

---

## §2 包形态

新包 `packages/weave-dsh-plugin/`（发布名 `@weavecode/dsh-plugin`，与伞包同一个
`@weavecode` scope）：

```jsonc
{
  "name": "@weavecode/dsh-plugin",
  "version": "<跟 weave 版本走>",
  "engines": { "node": ">=22.15.0", "dsh": "^0.2.0" },   // engines.dsh 是 dsh 的准入闸
  "dsh": { "manifestVersion": 1, "bundle": { "patch": "./cordis.patch.yml" } },
  "main": "dist/index.js"
}
```

`cordis.patch.yml` 就一行插件行（**行 id 固定**，便于 weave 幂等改写）：

```yaml
- id: weave-dsh-bridge
  name: '@weavecode/dsh-plugin'
  config:
    runtimePath: '~/.dsh/weave-bridge.json'
```

- **`engines.dsh`**：dsh 在挂载前按它判准入（`packages/boot/app-boot/README.md` 的
  「Before a profile imports a plugin…」）。声明 `^0.2.0` 的含义 = 「0.2.x 的插件面我
  敢接」；dsh 升 minor 时它会把我们**跳过并列出 `skippedBundles`**，而不是崩在某个
  未知 API 上——这正是我们要的行为。
- **安装**：`dsh plugin --profile web add link:<伞包内该目录的绝对路径>`（本地
  `link:` 是官方支持的 spec，`packages/boot/plugin-manager/README.md`）。weave 侧封装成
  `weave init`（选中 dsh 时）的一个用户级步骤，并另给一枚独立子命令做补装/卸载
  （`weave dsh bridge install|remove`，**新命令、名字待定**——现有 CLI 只有
  init/uninstall/status/daemon/dashboard/scan/chpass/doctor）。
- **运行时配置不进 patch**：插件只读**一个 weave 自己拥有的文件**
  `~/.dsh/weave-bridge.json`（0600）——`{ protocol: 1, dataDir, sessionRoot? }`。
  好处：dataDir 变了只改这一个文件，不用重写用户的 `cordis.patch.yml`（与
  `<dataDir>/hooks/inbox-targets.json` 同口径：非 UI 面、0600）。
- **伞包打包**：`packages/weave-dsh-plugin` 必须进伞包 tgz（自包含分发是硬约束），
  并预编译到 `dist/`（dsh host 里没有 tsx）。

---

## §3 桥协议

### 端口与凭据

- 每个 dsh host 进程起**一个**桥（不是每会话一个）：Windows = 命名管道
  `\\.\pipe\weave-dsh-<pid>`，POSIX = `<dataDir>/hooks/dsh/bridge-<pid>.sock`。
- **凭据**：插件启动时生成一枚随机 token，把 `{ protocol, pid, addr, token, sessions: [{sessionId, cwd}] }`
  写到 `<dataDir>/hooks/dsh/targets-<pid>.json`（0600）。daemon 只读这张表，
  **token 永不进响应/日志**（与 `inbox-targets.json` 同一纪律）。
- **存活**：连不上 ⇒ 该 host 已死。插件 `dispose` 时删 targets 文件；文件残留而连不上
  按「失效」处理（同 pane locator 的「宁可 409 也不误投」）。

### 帧

一行一个 JSON（NDJSON），请求/响应按 `id` 配对：

```jsonc
// daemon → 插件
{ "id": "m-42", "kind": "prompt", "sessionId": "…", "text": "…", "images": [{ "path": "…", "mime": "image/png" }] }
{ "id": "m-43", "kind": "cancel", "sessionId": "…" }
{ "id": "m-44", "kind": "answer", "sessionId": "…", "answers": [ … ] }   // P2
// 插件 → daemon
{ "id": "m-42", "ok": true, "ack": "delivered" }        // 已进队列/已投给 agent
{ "id": "m-42", "ok": false, "reason": "session-not-live" }
```

`ack` 只有两态——`delivered`（已交给 dsh）与失败。**它仍然不是「已读」**：真正的回执
是 P0 那条 `user/message` 落进日志（见 §5）。

### 命令 → dsh API

| kind | 调什么 | 说明 |
|---|---|---|
| `prompt` | `ctx.sessionController.prompt(sessionId, content)` | 官方语义含「resolve **or resume** an ordinary Session」⇒ 冷会话也能投（🔬7 证 live 语义） |
| `steer` / `inject` | agent handle `steer()` / `inject()` | 忙时注入（`inject` 进下一个 step 的上下文、不唤醒）——**这是 dsh 的 inject 通道，比 claude 的 additionalContext 更直接** |
| `cancel` | `agent.cancel({ kind: 'user' })` | 「与用户自己按停止完全一样」；是否 `keepInbox` 见 §7 |
| `rename` | `sessionController` 的改名 | dashboard 改名 → dsh 标题（P0 只有入向） |
| `answer` | `ctx.approval` / user-questions 的 resolve | P2 |

---

## §4 weave 侧接线

### 4.1 直投规格复用（`00` 待裁决清单里的 D6）

`PromptInboxSpec`（`driver.ts:392`）今天是「会话导出环境变量 → hook 上报」的形态。
dsh 是「插件写 rendezvous 文件」。**同一件事的两种上报形态**，故在规格里加一个判别键，
不新开成员：

```ts
export interface PromptInboxSpec {
  /** 凭据怎么来：env = 会话导出环境变量（claude）；rendezvous = 会话侧写目标文件（dsh 插件）。 */
  readonly discover: 'env' | 'rendezvous';
  // env 形态（claude）沿用三字段；rendezvous 形态用 addr 表路径 + 帧语法
}
```

server 侧 `hooks/inbox-socket.ts` 与 `InboxSocketRegistry` 的传输层不用改（它只认
「地址 + token + 一帧字节」），新增的是「目标从哪读」——一处分支。

### 4.2 层序

`MessageDeliverer` 对 dsh 手动面（`oneWay`）的层序**收窄成两段**：

```
直投（插件桥） → 层③ 队列
```

- 没有层① 中继（dsh 无 peer 消息机制）、没有层② 终端（C1）。
- 队列冲洗同序（先直投）；判死即不入队（`pidAliveOf` 口径对 dsh 换成「targets 文件不在
  或连不上」）。
- **「强制终端」选项对 dsh 不出现**：`available`（定位键表里有能打字的后端）为 false，
  web 按能力矩阵自动隐藏；后端 409 文案换成「dsh 会话没有终端 pane」。

### 4.3 回执判据

`handleIngestedRecords` 今天用字面量 `record.input.eventType === 'UserPromptSubmit'`
（`inbox-worker.ts:420`）认投递回执。dsh 的回执事件是 `user/message`。
**改成按生命周期表取 `HARNESS_LIFECYCLE[source].open`**（claude/zcode 都正好等于
`UserPromptSubmit`，codex 无事件面）——一处改动，顺带消掉一个写死的 harness 事实。

dsh 这边还多一道闸：`user/message` 同时承载 `agent.inject()` 的合成上下文与目标续轮
（`docs/persistence-catalog.md`），若不按 `source` 过滤，一次文件变更通知就能把在途消息
「认领」成已送达。⇒ 回执认领只认 **source 属于「人打的」那几种 + 文本匹配**（取值表见
🔬11；匹配规则沿用 `stripPromptDecor` + 短文本整条相等等既有口径）。

### 4.4 中断

`POST /sessions/:id/interrupt` → `MessageDeliverer.interrupt` → 对 dsh 走桥的 `cancel`
（而不是 `sendKeys`）。判据不变（`canInterrupt`：回合开着才露）。

cancel 之后那一轮会以 `turn/end.reason.kind = 'aborted'` 收尾（C4）——**那是真收尾笔**，
回合就此关上、会话行回「打开」。所以 dsh 不需要 weave 的「已中断」第 7 态（它存在的前
提恰恰是 claude 不发收尾笔），也不需要 `SessionProbe` 那套转录尾读。若 🔬4 实测发现
「取消只发内存态事件、盘上没有收尾笔」，回合就会挂在「生成中」，那才需要在 P1 补一条
`aborted` 的兜底口径（与 D5 同路：载荷判据），届时另记 `docs/DECISIONS.md`。

---

## §5 回执、暂停闸与重发

三层语义与 claude 手动面完全对齐，只有「回执事件」不同：

| 环节 | claude | dsh |
|---|---|---|
| 投递成功 | 中继 exit 0 / socket 写入成功 | 桥 `ack: 'delivered'` |
| 回执（真进了会话） | `UserPromptSubmit` eventType | `user/message`（P0 采集带入） |
| 未回执闸 | `ackStallMs`（缺省 120s） | 同 |
| 重发 | `POST /sessions/:id/messages/:mid/resend` | 同（**不需要**「只补一记回车」那条特例：dsh 没有输入框，重发就是再投一次；`via=terminal` 的分支对 dsh 恒不命中） |

> 这条顺序很关键：`ack` 只说明「dsh 收下了」，真正「落进对话」要等日志。所以
> **不能**把桥的 ack 当回执用——否则 Held/Refused 的语义在 dsh 上会变成「已送达」的谎。

---

## §6 图片（本批不开）

`ImageAttachSpec`（`driver.ts`）今天是「怎么把图片拼进一段文本」；桥是结构化通道
（可以直接给 image block），两者形态不同。本批 `imageAttach: null`（附件钮置灰），
P2 用 🔬 验过「插件传图在 dsh 里真能成为 image block」再开，形态见 `00` D3。

---

## §7 降级与失败语义（逐条写死，免得实现时各自发挥）

| 情形 | 行为 |
|---|---|
| targets 表里没有该 host / 连不上 | 该会话直投不可用 → 落层③ 队列；诊断报「桥未安装/未运行」 |
| 桥在但 `session-not-live` | 用 `sessionController.prompt` 的 resume 语义再试一次（🔬7 决定是否可行）；仍失败即入队 |
| `cancel` 时回合已结束 | 回 `ok:false, reason:'no-active-turn'`；web 的停止按钮本就按 `canInterrupt` 门控，属竞态，不弹错 |
| 插件与 dsh 版本不匹配（engines.dsh 拒绝） | dsh 启动时把 bundle 列进 `skippedBundles` 并打印；weave 侧表现为「桥不可用」+ 诊断原因码「版本不匹配，运行 `weave doctor` 看支持范围」 |
| daemon 重启 | targets 文件还在（插件没退出）⇒ 重启后首条消息照样直投；插件重启则生成新文件，旧文件按失效清理 |
| 用户卸载插件 | 直投消失，退化为「只读看板 + 队列」；**不在 dsh 里留下任何残留**（bundle 由 `dsh plugin remove` 摘干净，weave 只删自己那份 runtime 文件） |

---

## §8 验收

1. dsh web 里开一个 weave 项目的会话 → dashboard 发一句「你好」→ dsh 面板 1s 内出现
   （标 `Message from @weave` 由 adapter 决定是否加，见 §9），回合开始跑；2s 内该条消息
   在 dashboard 变成「已发出」并在日志回执到达后变回执态。
2. 会话忙时再发一条：走 `steer`（不影响正在跑的回合），dsh 侧下一 step 看到。
3. 点「停止」→ dsh 回合被 cancel（不是杀进程）；按钮随 `turn/end` 收起。
4. 杀掉 dsh host（关窗口）→ 再发一条：不假装排队成功，落 `failed/offline` 或入队后
   冲洗判死清队（与 claude 同口径）。
5. 卸载插件后重跑 1 → 退化为队列 + 诊断给修法，dashboard 不崩、不重复投递。
6. 单测：桥协议（假插件 server 验 daemon 侧；假 daemon 验插件 handler）、层序裁决、
   回执按 `lifecycle.open` 认领、`ack ≠ 回执` 的暂停闸路径。

---

## §9 待决细节（实现时按这条走，不另开会）

- 标不标 `Message from @weave`：dsh 的 `prompt` 源可带 `source`（`user-rpc` / `principal`），
  adapter 能把「weave 投的」与「人打的」分开（P0 的 `stripPromptDecor` 已有对位）。
  **推荐标**：会话自己（以及 dsh 的模型）该知道「这条不是用户手打的」。
- `cancel` 的 `keepInbox`：**默认 false**（用户按停止＝连排队一起清，与 dsh 自己的停止
  按钮一致）；weave 队列那份不受影响（那是 weave 的队列）。
