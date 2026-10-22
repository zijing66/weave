# 编排 MCP：把编排能力作为 weave 内置 MCP 暴露

> 计划状态：待执行。本文只定「能不能这么做」与分期边界，机制细节落 `docs/ARCHITECTURE-DETAIL.md` 对应节。

## 目标与边界

- 编排的**唯一事实源仍是 daemon 的编排仓储**（`orchestrations` / `orchestration_runs`）；MCP 只是另一张入口，不复制状态。
- MCP 服务**随 daemon 启动/退出**，作为 weave 的内置 MCP 自动注册到宿主（claude / codex），用户不需要手工装。
- 工具面覆盖编排的读、写、校验、触发、观测；**修改编排后 MCP 侧立刻可见**（见「同步」）。
- 不做：跨机器的远程 MCP 暴露（只本机回环 + 本机令牌）；不替代 web 画布。

## 进程与生命周期

两种形态，二选一（建议 A）：

- **A. daemon 派生 stdio 子进程**：`weave mcp orchestration`（stdio 传输），daemon 启动时 spawn、退出时回收；宿主配置里写 `command: weave, args: ["mcp", "orchestration"]`。优点：与宿主集成最稳，不占端口。缺点：一个宿主一个进程（可接受，工具调用转发到 daemon）。
- **B. daemon 内置 HTTP MCP 端点**：`POST /mcp`（Streamable HTTP），与 dashboard 同监听/同认证。优点：单进程、天然随 daemon 起停。缺点：宿主侧对不同传输的支持参差，且要把 MCP 会话状态塞进 HTTP handler。

鉴权：本机回环 + `x-weave-local` 本机令牌（读 `local/auth.json`），不接受会话 cookie；不监听 0.0.0.0。

## 工具面（草案）

| 工具 | 说明 |
| --- | --- |
| `list_orchestrations` | 列表（含 projectId / enabled / cron / nextRunAt） |
| `get_orchestration` | 详情（nodes / edges / startText） |
| `validate_orchestration` | 只校验不落库（唯一实现复用 `validateOrchestration`） |
| `create_orchestration` | 建（**必须支持 enabled:false**，见 942a83ad 的教训） |
| `update_orchestration` | 改（部分字段；与 web 同判据） |
| `delete_orchestration` | 删 |
| `trigger_orchestration` | 手动触发（可带 text / entries 覆盖） |
| `get_run` / `list_runs` | 运行态与事件（pending / deliveries / 失败原因） |
| `cancel_run` | 取消在飞 run |
| `list_sessions` | 建编排时选节点用（只读最小字段） |

工具用**通用动词**而不是「每份编排一个工具」：编排是数据，工具是操作。这样「新增/修改编排」天然同步——没有需要重建的工具注册表。

## 同步（修改编排时 MCP 侧怎么办）

- **默认（推荐）**：MCP 每次调用都转发到 daemon 的 HTTP API（同一认证），**零缓存**——任何来源（web 画布 / CLI / MCP 自身）改了编排，下一次 `list/get` 直接看到新值。这是「同步」的最强形式，也没有缓存失效问题。
- **可选**：若将来把「每份编排」暴露成 MCP **resource**（`weave://orchestrations/<id>`），resource 列表需要缓存；届时订阅 daemon 的 SSE `orchestration.run` / 定义变更事件（必要时补一个 `orchestration.changed` 帧）刷新，且**补不齐就整表重拉**（同 SseHub 的 resync 口径），不做增量补丁。

## 安全

- 只暴露本机回环；令牌从 `local/auth.json` 读，**MCP 工具的参数与响应都不回显令牌**。
- `trigger` 是唯一有副作用的写动作：保留 `enabled` 门与 `ORCH_MAX_DELIVERIES` 兜底；工具层不做额外自动触发。
- 日志：与 dashboard 同口径（接口日志脱敏），MCP 调用不新增明文落盘。

## 框架选型（请项目所有者裁决）

| 方案 | 许可 | 优点 | 代价 |
| --- | --- | --- | --- |
| **A. 官方 `@modelcontextprotocol/sdk`（TS）** | MIT | 协议权威实现；stdio/HTTP 都现成；显式 JSON schema，和本仓 TS 栈零摩擦；无额外抽象 | 样板略多（每个工具一段 schema + handler） |
| B. `fastmcp`（TS） | MIT | 高层封装，工具定义短；内置 resources/prompts 抽象 | 引入一层框架语义，版本演进快；出问题要穿透两层 |
| C. `mcp-framework` | MIT | 装饰器 + 目录扫描，多工具时整齐 | 对「一个域、十来个工具」偏重；魔法多 |
| D. 自建 JSON-RPC 桥（零依赖） | — | 完全可控 | MCP 的 initialize/tools/list/call、会话与错误语义都要自己实现，不划算 |
| E. Python FastMCP | MIT | 生态成熟 | 与仓库 TS 栈不一致，多一个运行时/发布面 |

**推荐 A**：编排工具面不大（~10 个），官方 SDK 的显式 schema 正好够用，且不给仓库增加框架依赖。

## 分期

1. **P0**：stdio MCP 子进程 + 只读工具（list/get/validate/list_runs/list_sessions）+ `trigger`；注册写进宿主配置（`weave mcp install`）。
2. **P1**：写工具（create/update/delete/cancel_run）与 enabled 语义；错误文案与 web 同源。
3. **P2**：资源化（每份编排一个 resource）与 SSE 变更同步；HTTP 传输形态按宿主支持情况再评估。

## 验收

- 同一份编排：web 建 → MCP `list` 立刻可见；MCP 改 → web 画布刷新即见（零缓存口径）。
- 触发链路与 web 触发完全一致（同 `MessageDeliverer`、同运行日志）。
- daemon 退出 → MCP 子进程被回收；daemon 重启 → 宿主下次调用自动拉起。

## 决策与可行性（2026-10-22）

**已裁决**：MCP 形态 = A（daemon 派生 stdio 子进程）；框架 = A（官方 `@modelcontextprotocol/sdk`）。

### 会话预热与「投递前拉起、回执后再投」

**现状（已具备）**：

- `OrchestrationEngine.deliver`：`aliveOf(to) === false` → `ensureOpen(to)`（装配 = `openSessionTerminal` + 等 claude 注册表落名，最多 8s）→ `awaitInboxReady` → `deliverer.send`；拉起失败记 `target session is not open: …`，**不盲投**。
- `reviveOrDrop`：在飞 run 里会话中途死掉 → 拉一次，仍失败则丢掉该会话的 pending 并落原因。
- `openSessionTerminal` 已有能力门：harness 无交互式 resume → 501；转录缺失 → 409；项目/会话缺失 → 404。

**结论**：**「投递前先告知 daemon、拉起目标、拿到回执再投」的顺序已经存在**；将来做动态路由时，只要在调用 `deliver` 之前解析出目标 id，这条保证天然复用，**没有结构障碍**。

**要补的缺口**：

1. **启动时预拉起**：`start()` 只对入口走 `deliver`（入口死会被拉起），其余节点是「投递到才拉」。要「编排启动时相关链路会话都起来」，需按**从本次所选入口可达的 session 节点集合**预跑 `ensureOpen`（webhook 节点不预热）。
2. **单飞**：`fireEdges` 对多条出边并发投递，同一目标并发 `ensureOpen` 会开两个 pane → 按 sessionId 做 single-flight。
3. **回执口径升级**：现在的 ack = 注册表出现 pid（进程起来），不是「可接收输入」。建议 ack = 注册表 alive **且**（capture 在场时）等到该会话的 `SessionStart` 事件；等不到按超时失败，不盲投。项目 90 的 claude capture 已在场（inbox + paneEnv 都为 true），该口径可用。
4. **并发与预算**：预热并发上限 2、总预算 ~20s；超预算节点保持懒加载（投递时再 ensure），避免一次拉起十几个 claude 打满 CPU。
5. **副作用面**：预热会发 `SessionStart`；若该会话是**别的**编排的入口，可能被 `maybeAutoFire` 当成自然回合触发。现在「有 pending 才算编排回合」挡不住刚起、无 pending 的 SessionStart → 预热拉起的会话首轮打标记，`maybeAutoFire` 见标记跳过（或把 SessionStart 排除出 auto-fire 的 idleSignals）。
6. **观测**：预热失败不能静默——在 run 事件里落 `stage:'prewarm'`（原因沿用 openSessionTerminal 的 404/409/501 语义），画布能看到「哪个节点没起来、为什么」；同一 run 内失败节点不重复拉起。
7. **非 claude 的局限**：`aliveOf` 对 codex 等返回 `null`（判不动），于是**不会自动拉起**（只有明确 false 才拉）。要让 codex 会话可预热，得先在 `resume`/liveness 槽补一个能力位——这是独立的一小步。

**取舍**：预起来但该分支不走 = 多开一个终端（用户可关）；入口先投、目标并行预热，预热不阻塞入口首投。

### 追补裁决（2026-10-22，第二轮）

- **#1 不预拉起整条链路**：编排启动时不为所有可达节点预热会话；仍按「投递到才 ensure」。
- **#2 单飞**：同一 sessionId 的 `ensureOpen` 必须 single-flight（并发边只拉起一次）。
- **#3 回执升级**：ack = 注册表 alive +（capture 在场时）该会话的 `SessionStart` 事件；超时按失败记，不盲投。
- **#4 并发口径确认**：投递不是 fork 子 agent——消息进目标会话自己的队列，同一会话严格 1 送 1 回执、后续排队，**单节点并发天然为 1**；fork 只用于边级 `extract`。可控性由队列保证，不需要额外并发池。
- **#5 消除副作用**：编排拉起/投递唤醒的会话，其首个 `SessionStart` 不得被 `maybeAutoFire` 当成自然回合（打「编排拉起」标记，或把 SessionStart 排除出 auto-fire 的 idleSignals）。
- **#6 补观测**：ensure/拉起结果落 run 事件（`stage:'ensure'`：sessionId、ok、耗时、失败原因），画布与 run 详情可见；同一 run 内失败节点不重复拉起。
- **#7 codex 补全**：给 resume/liveness 槽补能力位，使 codex 会话也能判活、被自动拉起——这与「在会话列表里打开 codex 会话」是同一份能力，补一次两处受益。
