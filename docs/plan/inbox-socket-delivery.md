# 层①-a：经 Inbox Socket 直投（已实施）

> 状态：**已实施**（2026-10-15）。本机 2.1.296 + native Windows 实测通过。
> 依据 = 官方 `cross-session-messaging#the-sessions-inbox-socket` 小节 + CLI 自己
> 打印的注入配方（`--debug` 的 `[uds-messaging] Inject messages …` INFO 行）。
>
> **落地位置（harness 隔离：机制归 claude adapter，server 只留通用传输）**
> - 规格：`weave-harness/src/claude/prompt-inbox.ts`（`CLAUDE_PROMPT_INBOX`：
>   两个 env 名 + 平台认证要求 + 组帧），经 `MessagingSurface.promptInbox` 声明；
>   codex = `null` → server 完全不尝试。
> - 传输：`weave-server/src/hooks/inbox-socket.ts`（连/写/关/超时 + 内存注册表）。
> - 凭据上报：hook 脚本（`capture.ts` 生成，env 名取自同一规格）把
>   `{socket, token}` 写进 inbox 行**旁路字段** → worker 交给主线程注册表
>   （**不进 payload、不落库、不进 UI、不写日志**）。
> - 分派：手动面（`oneWay`）socket 优先 → 失败回落中继 → 终端 → 队列；
>   编排域仍先走中继（保留 `Message from @weave` 来源语义）。
> - 回执：会话自己的 `UserPromptSubmit`（`payload.raw.prompt`）与在途条目匹配
>   （剥掉 `<cross-session-message …>` 外壳后比对）→ `acked` + `message.acknowledged` 帧。
>
> **中继为何保留**：见 CLAUDE.md 同名条目——①来源语义（跨会话限制 vs 用户权威）
> ②唯一可能的回复面 ③覆盖非 weave 会话/存量未升级 hook 的项目。
> **凭据不持久化**：每会话进程一份（resume 后 socket 名重生成）；自愈 =
> 每次 hook 事件覆盖刷新 + 首次中继投递把凭据带回。
> **待定**：要不要在 socket 载荷前加 `[weave]` 来源前缀（现状 = 完全等同用户输入）。

## 为什么（现状对照）

| 路径 | 一条消息的成本 | 状态 |
|---|---|---|
| 现层①：每条消息起一个受限 claude 中继 | **7.4–38.3s** + token | 可用（唯一在用的） |
| channels（MCP 推送） | ≈0 | **本机功能门未开**（实测 `channels feature is not currently available`） |
| **Inbox Socket 直投** | **实测 86ms**，无进程、无 LLM | **已验证可用** ✅ |

## 已证实的协议（官方文档 + CLI 打印的配方，非逆向）

会话启动即导出两个环境变量给**该会话自己的 hooks 与 Bash 命令**（在任何 hook 之前导出，
含 `SessionStart`）：

- `CLAUDE_CODE_MESSAGING_SOCKET` = `\\.\pipe\LOCAL\cc-msg-<32hex>`（Windows 命名管；
  macOS/Linux 为 unix socket，`/status` 的 `Peer address` 行同值）
- `CLAUDE_CODE_MESSAGING_TOKEN` = per-session token（本机实测 len=32）

投递 = 连上该 socket，按行（`\n` 分隔）先写 auth 行、再写消息行，然后关连接：

```json
{"type":"auth","token":"<CLAUDE_CODE_MESSAGING_TOKEN>"}
{"type":"user","message":{"role":"user","content":"<要注入的文本>"}}
```

- **native Windows 必须带 auth 行**（文档：首行非合法 auth 行则关闭连接、什么都不投递）；
  macOS/Linux 可选。
- 一条连接必须 **30s 内发出完整一行**（超时被关）：先把要发的内容准备好再连。
- 接收侧照常走它自己的 inbound controls（`crossSessionInbound` / Held / Refused /
  尺寸与突发上限）——直投**不绕过**任何闸。
- **own-child 信任**：无 `crossSessionInbound` 值时，「会话自己的 child 进程（hook / Bash）
  回投自己的 socket」会被验证并直接投递；Windows 上验证的唯一依据就是 auth 行里的 token。
  → weave 的 hook 正是「会话自己的 child」✓。

## 本机实测记录

```
SOCKET = \\.\pipe\LOCAL\cc-msg-495d5d3bde46589a7ef53f7dfbc651a8   （本会话 env）
TOKEN  present = True  len=32
node inject.mjs "<哨兵文本>"            → inject ok: 86ms
DB 佐证：hook_events id=33333 session=3de0d761 type=UserPromptSubmit
         prompt = "<哨兵文本>"（裸文本，无 cross-session-message 外壳）
```

## 架构（拟）

1. **取地址/令牌**：weave 已装在项目里的 hook 进程天然继承这两个变量 → hook-handler
   把 `{sessionId, socket, token}` 上报 daemon（**内存态，token 不落 settings、不进 UI、
   不写日志**）。
2. **投递后端**：`MessageDeliverer` 的 prompt 通道加一个 socket 后端（与「中继」并列，
   同一能力面），可用即用；无 socket/token（非 weave 项目、messaging 关闭）→ **回落中继**
   → 再回落终端 send-text → 再回落队列（现有四层不变）。
3. **回执（同一份验证顺手拿到）**：消息到达会触发接收会话的 `UserPromptSubmit`，
   payload 里就是我们注入的原文 → 与在途条目匹配即置 `acknowledged`（真回执），
   并据此核销队列。**中继/终端路径同样受益**（终端的投递此前完全没有回执）。
4. **来源标注**：socket 消息是**裸 user 文本**（不像 SendMessage 会带
   `Message from @weave`）→ 载荷由 weave 自己加前缀标注来源，语义与现「单向注记」同源。

## 风险与边界

- **依赖私有程度**：协议由官方文档小节 + CLI 自带配方公开，但仍是「实现细节级」公开
  （不像 `SendMessage` 工具那样是稳定契约）→ 保留中继作回落是硬要求，且需版本探测
  （socket 连不上 / auth 被拒 → 立即回落）。
- **token 与 socket 是本机同用户可读的凭据**：只在内存持有、不落库不进 UI；daemon 重启
  后由下次 hook 事件重新上送（hooks 每次都会带）。
- **覆盖面**：只有装了 weave hooks 的会话才有 hooks 上报地址 → 非 weave 项目/main
  conversation 之外仍走中继。
- **CLAUDE.md 那条「peer 私有帧协议/命名管不逆向不直连」需改写**：其立论前提（协议私有、
  只能逆向）已被官方文档 + CLI 配方推翻；新口径 = **「经文档化的 inbox socket 投递（auth
  行按平台要求）」，仍禁止对同行私有协议做未文档化的猜测式直连**。
