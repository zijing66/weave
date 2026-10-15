# Weave Decisions — 裁决与实测记录

CLAUDE.md 只保留当前站立规则；带日期的定案、实测记录、用户原话裁决与被推翻的旧结论一律记录在这里。append-only，新的在上。

## 2026-10-15

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
