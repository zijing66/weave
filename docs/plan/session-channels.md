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
