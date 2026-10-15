# Weave Decisions — 裁决与实测记录

CLAUDE.md 只保留当前站立规则；带日期的定案、实测记录、用户原话裁决与被推翻的旧结论一律记录在这里。append-only，新的在上。

## 2026-10-15

- **全局总览行序 = 纯活动序（用户裁决，推翻 f8aa6ea 的分桶）**：需求「给全局的任务列表，也增加项目会话相似的前端的任务排序功能」——f8aa6ea 当初落的是「活动序 + 按项目分桶（同项目相邻）」，代价是**同项目的旧会话会被压在新会话之上**。就此问过一次，用户选了「改成纯活动序（跨项目混排）」⇒ `globalOverviewRows` 退化为「按冻结序逐行取行」：冻结序里未见的新行按新在前兜底置顶、已消失的即时移除，与会话列表 `mergeNewRows` 同口径；过滤换批仍立即采用新序、不做增量合并。项目名改为行内一列承载（不再靠分组表达归属）。

- **对话视图 = 只查事件流，绝不落库**（用户裁决，本机实测）：需求「消息线程按钮改名对话；对话中仅展示用户的消息投递 + 会话 stop 时的最终总结消息」，随后两条追加「消息不落 db 库，而是查询消息」「避免冗余存储」⇒ 对话**不新增表、不复制行**，直接查既有 `hook_events`：开轮取 `UserPromptSubmit` 的 `raw.prompt`（`<task-notification>` 子代理返回不算人话，同分组口径丢），闭轮取 `Stop` 的 `raw.last_assistant_message`。覆盖实测（当机库）：最近 400 条 Stop/SubagentStop **100% 带非空 `last_assistant_message`**（均值 3.1k 字符、最长 33k），UPS 400 条里 354 条真 prompt / 46 条 task-notification / 0 条空 ⇒ 无需解析转录、无需新 API 语义。分页 = 既有会话事件路由加 `types` 参数（只取开/闭轮两类，一页 10 条事件而不是 300 条混合事件）+ `beforeId` 游标；已翻页留前端（组件状态，不开模块级缓存——重开时新页与手上不重叠就整批换新，避免留下看不见的空档）。**退场的旧做法**：web 侧那份 60s 本地隐藏（`SETTLED_VISIBLE_MS` + 一次性重渲染）删除——对话**不清理**消息；投递行改为「被同文案相邻时刻的事件条目认领即不单列」，认领不到的（Held/Refused、failed/timeout、暂停闸成因、仍在途）排对话尾部，可见期沿用服务端驻留窗口（settled 60s、failed/timeout/stalled 常驻）。对话可见历史的下界 = 事件保留期。

- **停止按钮报「找不到 pane」的真因（本机实测 2026-10-15 21:10）**：中断路径本身没问题——用**哑 pane** 端到端验证过：`wezterm cli spawn` 起一只 `node` raw 读 stdin 的 pane、把它的标题设成某历史会话标题（`✳ <session-title>`）、cwd = 该项目根 → `POST /sessions/<那个会话>/interrupt` 返回 200，且该 pane 收到**且只收到** `hex=1b`（一记 ESC）；随后 kill-pane 收摊。断言的是：`interrupt` 与 `answer` 同用 `sessionKeysTarget` → `terminalPaneFor`，键序投递这段无缺陷。409 的真因在**解析**：① 项目侧 `.claude/helpers/hook-handler.cjs` 生成于 locator 特性（5cec73e）之前 → 行形里根本没有 `terminal` 字段（本机 <project> / <project> / avic / <project> / <project> 五处 `grep -c WEZTERM_PANE` = 0，行形 = `{v,token,report,messaging}`）→ `paneEnvs` 永不落项；② 只剩「标题剥 spinner + 项目根 cwd 等值」回落，而 `--resume` 起的会话 TUI 标题回到 claude 默认「✳ Claude Code」、无题会话（`title` null，函数里直接 return null）→ 必然 0 命中。全量体检（复刻回落判据 × 当机活 pane）：weave 项目有题会话命中（0d05efc9→9394666d:9 / 300772bd→:1 / 3de0d761→:6），无题会话与其余项目大多 0 命中。⇒ 这不是停止按钮的实现问题，是**那条通道的覆盖问题**：helpers 属 init artefact、服务端同步面刻意不含它，正解 = user 档采集（`PUT /capture {harness:'claude',enabled:true}`：写一份含 locator 的 user 级脚本 + 清掉各注册项目的采集组；**只对新起会话生效**——已跑进程的 hooks 在启动时读定），或对目标项目重跑 `weave init`（脚本路径不变，进行中的会话下一次 hook 事件即生效）。同批两处小修：停止按钮与同排复制按钮的按钮形对齐会话列表（`h-5 w-5` 方框 + 边框底色，原先只有 `p-0.5` 内边距）；`TerminalBackend.sendKeys` 的 wezterm 报错文案原本写「cannot send **answer** keys」，而这条通道中断也在用 → 改中性说法。

- **API 报错可观测性实测（本机）**：报错**只落转录 JSONL**，hook 域没有这个信号——`{"type":"assistant","isApiErrorMessage":true,"error":"server_error|invalid_request|unknown","apiErrorStatus":400|402|500,"message":{"model":"<synthetic>", usage 全 0}}`，紧邻一条 `{"type":"system","subtype":"turn_duration"}` = **该 turn 已结束**（之后是人补一句「继续」）。反证：全库 `notification_type` 只观测到 `idle_prompt`(359)/`permission_prompt`(95)/`agent_needs_input`(2)/`agent_completed`(1) 四种，无 error 类；最近 400 条 Stop/Notification 的 `last_assistant_message` 无一条是报错原文。规模：199 个会话里 25 个中招、共 70 条；报错前静默 p50=4s / p90=739s / max=3457s（长尾 = ESC 唯一有用的窗口）。文本三类语义：`500 litellm.InternalServerError - Connection error` / `Request timed out` = 可重试；`402 ... Insufficient Balance` = 重试无用；`400 ... exceeds the model's maximum context length` / `Prompt is too long · automatic compaction failed` = 须 /compact 或新会话。据此**会话中断**能力的语义边界 = ESC 只救在途重试，报错落定后该重发（规则见 CLAUDE.md）。
- **会话中断落地**（6e64d1e 服务端 + 64add74 web）：`POST /sessions/:id/interrupt` 打一记 ESC；停止按钮落事件链最新组头折叠条，不按 running 门控。ESC 裸字节可达实测：`wezterm cli send-text --no-paste` + raw 模式 stdin 收到 `1b`。CLI 不提供停止命令（用户裁决「cli 不需要」）。
- **终态驻留 + 未回执闸定案**：delivered/injected/succeeded 在 `settledAt`+60s 内留在在途视图展示 `via`/`acked`；prompt 送达 `ackStallMs`（缺省 120s）未回执、或中继/终端投递失败 → 该会话队列冲洗暂停（`flushSession` 闸），成因消息标 `stalled`。规则全文见 CLAUDE.md「消息/编排域」。
- **中继启动开关实测（本机）**：`--strict-mcp-config --disable-slash-commands` 恒开（实测仍能正确应答、工具白名单照旧）；`--bare` 快 ~9×（38s→2.5s）但当版本 `--tools` 白名单失效（实测中继跑去调 WebSearch 不投递）+ 只认 API key（OAuth 认证失败）——查到但不可用，禁用。

## 2026-10-14

- **手动发送无模式选项终局定案**（9398d37）：用户原话「默认就是 sendmessage+积压消息，降级时通过 terminal send-text」→ 手动路由无 `mode` 入参、恒走 prompt 通道，降级（层① 缺位 → 层②）全自动。
- **消息域不落 DB 定案**（f8a792f）：`session_messages` 表退役、`fromKind` 概念删除——消息唯一归宿是目标会话自己的转录，weave 仅投递前短暂持有（本地文件队列）。
- **中继（SendMessage）保留裁决**（85cefba）：起因 = 用户问「web 端还需不需要」；裁决保留，三个 socket 做不到的作用（来源语义 / 回复面 / 覆盖非 weave 会话与存量未升级 hook 的项目）见 CLAUDE.md。

## 2026-10-13

- **抽象类条目改判**（e6ff553）：Architecture 该条曾写作「不新增其他抽象类」，判定为**过时描述**而非禁令——现状全仓仅两处模板方法（`InitPipeline` / `TerminalBackend`），新增抽象类按需即可、扩张前与项目所有者确认。
