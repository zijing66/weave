# 层④ 候选：以 channel（MCP 推送）取代中继进程（计划，未实施）

> 状态：**计划**——用户 2026-10-15 定调「可以计划，然后集成在内置工具中，并默认启用」。
> 未写一行实现代码。依据 = `code.claude.com/docs/en/channels` + `channels-reference`
> （Claude Code **研究预览**功能）。

## 动机

今天的投递（层①）是「起一个受限 claude 进程 → 让它调 SendMessage」：**每条消息
一次 CLI 启动**（本机实测 7–38s 不等，见 `session-orchestration.md` 中继启动开关一节），
且发送语义完全依赖 `SendMessage` 工具在我方进程里跑起来。channels 给了另一条路：

> A channel is an MCP server that pushes events into a Claude Code session so Claude
> can react to things happening outside the terminal. …Claude Code spawns it as a
> subprocess and communicates over stdio.

即 **会话自己拉起一个 MCP server，外部事件由该 server 推给会话**——这条路径里
**没有「为发一条消息而起一个 claude」的成本**：零启动、零额外 token、即时。

## 目标形态（用户定调）

1. weave 出一个**内置 channel MCP server**（`weave-channel`，Node 实现，不依赖 Bun；
   官方 telegram/discord 那套要 Bun，我们自建不受此限）。
2. **随 weave 内置工具一起分发**（内置插件/内置 MCP 同一条安装路径），
   **默认启用**：`weave init` 装到项目的 MCP 配置里（`McpServerConfig` 既有能力面），
   用户不配置也能用。
3. 会话启动时由 Claude Code 拉起该 server；server 与 **daemon** 建立回连
   （本机 socket/HTTP + 既有 `x-weave-local` 本机令牌口径），daemon 侧
   `MessageDeliverer` 的层① 从「中继 spawn」改为「channel 推送」。
4. 能力面照旧：`HarnessCapability.messaging` 的 prompt 通道语义不变，
   只换实现（`MessagingSurface.prompt` 里加一个 channel 规格，和中继规格并列，
   由装配侧按「装了没 / 活没活」选择）——web、路由、投递裁决**零改动**。

## 文档已核实的关键事实（决定可行性，2026-10-15 抓 `channels-reference`）

1. **载荷**：`notifications/claude/channel`，`content` 为纯字符串（+ 可选 `meta`
   路由属性）→ daemon 推任意文本可行；到达时在会话上下文里包一层 `<channel>` 标签。
2. **忙闲语义是原生的**（正合我们层③ 的语义）：*"Events queue into the session and are
   processed in order. If several notifications arrive while Claude is busy, they're
   delivered together on the next turn and Claude handles them as a group."* → 运行中
   会话的「忙则下一拍」不用我们排队（promptbox 只剩「会话没开」这一支）。
3. **无回执**：*"Claude Code doesn't acknowledge notifications"*；`await` 只保证写进
   传输；**若该会话没把我们的 server 当 channel 加载（或被组织策略挡），事件被静默
   丢弃、不返回任何错误**。→ 单向 channel 的 `delivered` 比中继**更不可信**；要回执
   只能靠 **reply tool**（见下）或会话自己的 idle 事件（序列编排已用后者）。
4. **加载方式**（决定「默认启用」怎么落）：① MCP 配置里加一条 server 条目
   （`.mcp.json` 项目级 / `~/.claude.json` 用户级——**weave 已在管 MCP 配置**）；
   ② 会话启动**必须带旗标**：研究预览期自定义 channel 不在 allowlist，要用
   `claude --dangerously-load-development-channels server:<名>`，启动时**弹全屏警告
   要求人工确认**，且本项目首次还要再确认一次「Use this MCP server」。注册成功后
   启动横幅下有暗色提示 `Channels (experimental) messages from server:<名> inject
   directly in this session`。→ **无法静默自动化**（这是官方安全设计，不该绕）：
   只有 **weave 自己拉起的会话**（`openSessionTerminal` = 我们 spawn `claude --resume`）
   能替用户带上旗标；用户自己开的会话要回落中继。
5. **双向可行**：channel 可暴露标准 MCP tool（官方示例就叫 `reply`）让会话回写 →
   这正是「编排保留双向对话」缺的那块（今天中继是瞬时进程，回复无处可去）。
   代价：该 tool 的 schema + instructions 会进入**每个**挂载会话的上下文（每回合
   token 开销）→ 默认单向、双向按需开。

## 结论（对「冷启动效率 + 编排功能是否满足」的回答）

- **冷启动：满足，且是数量级改善**——每条消息从「一次 claude CLI 启动（本机实测
  7.4–38.3s + token）」变成「本机 stdio 写一行（毫秒、无 LLM）」。成本模型从
  **每条消息**挪到**每个会话**（多一个瘦 server 进程，需实测内存）。
- **编排：核心满足，且两处更强**——投递语义不变；忙时排队原生；双向由 reply tool
  补齐；完成判据仍走目标会话的 idle 信号，无需新事件源。
- **但有三条代价**：研究预览契约可能变 → 双通道回落必须有；单向无回执（静默丢弃）
  → `delivered` 要重新措辞或补 reply 回执；双向会往每个会话上下文塞一个 tool schema。
- 因此「默认启用」的准确落法 = **MCP 条目默认写入 + weave 拉起的会话默认带旗标**，
  用户自拉会话回落中继；人工确认对话框保持人工（不绕）。

## 必须解决的开放问题

| # | 问题 | 现状/倾向 |
|---|---|---|
| 1 | **研究预览**：官方可能改契约 | 需要「按能力探测 + 失败回落中继」的双通道装配，不能硬依赖 |
| 2 | 默认启用 = 每个会话都拉起一个 MCP server（内存/启动成本换掉了中继成本） | 需要实测：常驻 MCP 的开销 vs 每条消息一次 CLI 启动的开销；若常驻更贵，退「按需启用」 |
| 3 | 目标会话没装/没启 channel 时怎么办 | 回落层① 中继（今天的行为），能力矩阵如实声明 |
| 4 | 推送载荷的**归属与语义**：channel 事件是「外部平台消息进来」，不是「用户 prompt」 | 需要确认接收侧呈现（是否等同用户输入、是否走同一权限/审批面）；我方 oneWay 注记语义是否仍成立 |
| 5 | 回连安全 | channel server 由会话拉起、与 daemon 同机同用户 → 复用本机令牌（`auth.json` 0600）口径；**不新造信任边界** |
| 6 | 接收侧拒收语义 | 与文档三态一致（Delivered/Held/Refused），channel 路径能否提供比中继更好的**回执**（能否拿到「已交到 Claude」的确认）——若能量化，则 `delivered` 可升级为真回执 |

## 落地顺序（建议）

1. **原型探路**（不接入 weave）：手写最小 channel MCP，验证「daemon 侧推送 → 会话
   收到并处理」的闭环 + 呈现形态；记录冷启开销。
2. **能力面归位**：`PromptChannelSpec`（channel 版）与 `PromptRelaySpec` 并列，
   `MessageDeliverer` 按「channel 活 → 用它；否则中继」裁决（与层①→层② 同一口诀）。
3. **内置分发包**：随 weave 内置工具分发 + `weave init` 默认写进项目 MCP 配置 +
   `weave doctor`/能力矩阵如实报告「装了没、活没活」。
4. **默认启用**：默认开、可关（settings 开关），全程保留中继回落。

## 与既有设计的关系

- **不动**触发源 ⊥ 投递通道的划分：channel 只是提示层① 的另一种实现。
- **不废**中继：它是没有 channel 时的兜底，也是 channel 契约变化时的安全网。
- 层②（终端 send-text）与层③（promptbox 队列）不受影响。
