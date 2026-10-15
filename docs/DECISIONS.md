# Weave Decisions — 裁决与实测记录

CLAUDE.md 只保留当前站立规则；带日期的定案、实测记录、用户原话裁决与被推翻的旧结论一律记录在这里。append-only，新的在上。

## 2026-10-15

- **终态驻留 + 未回执闸定案**：delivered/injected/succeeded 在 `settledAt`+60s 内留在在途视图展示 `via`/`acked`；prompt 送达 `ackStallMs`（缺省 120s）未回执、或中继/终端投递失败 → 该会话队列冲洗暂停（`flushSession` 闸），成因消息标 `stalled`。规则全文见 CLAUDE.md「消息/编排域」。
- **中继启动开关实测（本机）**：`--strict-mcp-config --disable-slash-commands` 恒开（实测仍能正确应答、工具白名单照旧）；`--bare` 快 ~9×（38s→2.5s）但当版本 `--tools` 白名单失效（实测中继跑去调 WebSearch 不投递）+ 只认 API key（OAuth 认证失败）——查到但不可用，禁用。

## 2026-10-14

- **手动发送无模式选项终局定案**（9398d37）：用户原话「默认就是 sendmessage+积压消息，降级时通过 terminal send-text」→ 手动路由无 `mode` 入参、恒走 prompt 通道，降级（层① 缺位 → 层②）全自动。
- **消息域不落 DB 定案**（f8a792f）：`session_messages` 表退役、`fromKind` 概念删除——消息唯一归宿是目标会话自己的转录，weave 仅投递前短暂持有（本地文件队列）。
- **中继（SendMessage）保留裁决**（85cefba）：起因 = 用户问「web 端还需不需要」；裁决保留，三个 socket 做不到的作用（来源语义 / 回复面 / 覆盖非 weave 会话与存量未升级 hook 的项目）见 CLAUDE.md。

## 2026-10-13

- **抽象类条目改判**（e6ff553）：Architecture 该条曾写作「不新增其他抽象类」，判定为**过时描述**而非禁令——现状全仓仅两处模板方法（`InitPipeline` / `TerminalBackend`），新增抽象类按需即可、扩张前与项目所有者确认。
