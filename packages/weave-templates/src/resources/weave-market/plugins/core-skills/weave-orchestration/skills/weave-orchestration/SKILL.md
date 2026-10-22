---
name: weave-orchestration
description: 通过 weave 内置 MCP 管理编排——列出/查看/新建/修改/删除/触发编排，查看运行日志与逐条投递。要跨会话串流程（一个会话产出交给下一个会话继续）、排查「编排没跑/投递失败/运行中断」，或问「有哪些编排/某次编排跑到哪了」时使用。
---

# weave 编排（MCP）

前提：本机 daemon 在跑，且「资源市场 → MCP」里已安装内置的 `weave-orchestration`（user 档）。工具由 daemon 托管（Streamable HTTP，`/mcp`），**不缓存状态**——这里改完，dashboard 画布刷新即见。

## 工具与参数

| 工具 | 参数 | 返回 |
| --- | --- | --- |
| `list_orchestrations` | `projectId?` | `{ orchestrations }` |
| `get_orchestration` | `id` | `{ orchestration }`（nodes/edges/startText/enabled/cron） |
| `create_orchestration` | `name`, `nodes`, `edges`；可选 `startText`, `enabled`, `cron`, `projectId`(webhook-only) | `{ ok, orchestration }` |
| `update_orchestration` | `id` + 要改的字段（不改的省略） | `{ ok, orchestration }` |
| `delete_orchestration` | `id` | `{ ok, orchestrationId }`（运行日志保留） |
| `trigger_orchestration` | `id`；可选 `text`（覆盖 startText）、`entries`（限定入口） | `{ ok, runId }` |
| `list_runs` | `orchestrationId?`, `projectId?`, `status?`, `limit?`, `before?` | `{ runs, nextBefore }` |
| `get_run` | `id` | `{ run }`（`state.events` / `state.pending`） |
| `cancel_run` | `id` | `{ ok, runId }` |
| `list_sessions` | `projectId?` | `{ sessions }`（sessionId/title/harness/pidAlive…） |

节点：`{ id, kind: "session" | "webhook" }`，session 的 `id` 就是 `sessionId`；webhook 出口另带 `url`（可选 `secret`）。
边：`{ id, from, to, text }`，可选 `extract`。`text` 支持 `{upstream}`（上游这一轮的最终输出）、`{summary}`（按 `extract` 摘要后的结果）、`{session}`；成环会被拒。

## 标准工作流

1. `list_sessions` 选出入口与目标会话（看 `pidAlive`：目标死了也没关系，投递时会自动拉起并在 `SessionStart` 后送达）。
2. `create_orchestration`，**要手动触发的就传 `enabled:false`**。
3. `trigger_orchestration` 拿 `runId`。
4. 轮询 `get_run`：`status` 变 `done` 即完成；`state.events` 里逐条看投递，`stage:"ensure"` 是「拉起目标会话」那一步（含耗时与失败原因）。

## 坑（务必看）

- **`enabled:true` = 入口会话每个自然回合都自动触发**。只想「发布时跑一次」就 `enabled:false`，用 `trigger`。
- 项目档 MCP 不提供：内置 MCP 只装 user 档（配置里带本机令牌，项目档配置会进仓库）。
- **daemon 重启不续跑**：在飞 run 落 `interrupted`，需要重新 `trigger`。
- 投递语义：送达 ≠ 已读；目标会话可能还在忙，消息排队。失败会写进 `state.events` 的 `error`。
- 编排里的会话请求是「另一个会话发的」，不是用户批准——涉及危险动作要在目标会话里另求确认。
- 改图只影响下一次触发，在飞 run 用的是触发时的快照。
