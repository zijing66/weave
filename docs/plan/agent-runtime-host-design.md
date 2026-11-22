# B1「Windows Runtime Host」实施设计稿

> 状态：设计（2026-11-20）。依据 = `agent-runtime-terminal-design.md` 原始方案 + `agent-runtime-terminal-gateway.md` §6 PoC 结论（全绿 + 两条附带发现）。前置 = B0 `runtime/protocol.ts` 与 `agent_instances` 表（计划 §2/§3，已完成 14f05579）。本文不碰 TerminalBackend / sessions 表 / daemon 装配既有面。

## 0. PoC 定案回顾（本稿的设计输入）

1. node-pty 预编译全通，发布链必须 `--ignore-scripts` 可用 → Host 直接 `require('node-pty')`，无本地编译兜底分支（不写用不上的代码）。
2. **Host 崩溃 = 子进程必死**（ConPTY 管道随句柄断裂，Job Object 救不了）→ 一切恢复语义只走 harness resume，进程级存活零承诺。
3. `pty.spawn('claude')` ENOENT → 适配层必须解析真实 bin 或 `cmd /c`。
4. pty 句柄拖住 node 不退 → Host 必须显式 kill/清理才能退出。

## 1. 进程结构：Host 独立于 daemon 存活

### 1.1 核心问题

本机活 daemon 是 `tsx watch` 跑 dev-entry 源码（见 `CLAUDE.local.md` §daemon）。tsx watch 热重启 = 杀子进程树，普通 `spawn` 出来的 Host 会跟着死——直接违背「daemon 重启 Host 不死」目标。且用户手动起的 daemon 若在 Windows Terminal pane 里，该 pane 是 kill-on-close 的 Job，`detached: true` 也逃不掉（libuv detached 不逃不可 breakaway 的 Job；仓内已有实测结论，见 `weave-cli/src/commands/daemon.ts:54-60` 注释）。

### 1.2 方案：WMI 断链 spawn + Host 作为 Named Pipe 常驻 server

- **spawn 方式**：daemon 经 **WMI `Win32_Process.Create`（ShowWindow=0）** 拉 Host，把 `weave-cli/src/commands/daemon.ts:61` 的 `spawnOutsideJob` 提炼为共享 util（建议落 `weave-server/src/daemon/spawn-outside-job.ts`，CLI 改引同一份）。理由：WMI 创建者在 Job 外，继承链断开，tsx watch 杀树/关 pane 都带不走 Host；仓内已有同款验证过的实现，不新造机制。失败回落 `spawn(detached:true, stdio:'ignore') + unref`（非 Job 环境下够用）。
- **Host 是 server、daemon 是 client**：Host 启动即 `net.createServer().listen('\\.\pipe\weave-runtime-host')` 常驻监听；daemon 启动时探测 pipe，通则直接握手复用，不通才 spawn。理由：角色反过来（daemon listen）则 daemon 重启期间 pipe 消失，Host 无锚点；Host 持 server 使「daemon 重连」退化为一次 `net.connect`。
- **pipe 名**：`\\.\pipe\weave-runtime-host-<dataDir 哈希短码>`。理由：固定裸名在多数据目录/多用户并存时冲突；哈希后缀保持单机唯一且无需协调。
- **单 Host 单实例**：Host = 全局唯一（同 dataDir），进程内管理全部 PTY。理由：B1 主战场是单机；per-project Host 会把对账面翻倍，无收益。

### 1.3 dev 模式（tsx watch）与生产模式（dist）的差异处理

- **Host entry 解析复用 `resolveDaemonEntry()` 口径**：ts 源码态 `node --import tsx <server>/src/runtime/host-entry.ts`，dist 态直接 `node dist/runtime/host-entry.js`。理由：与 daemon 自己的启动判定同一事实源，不另写环境嗅探。
- **dev 热重启语义**：tsx watch 重启 daemon → 老 daemon 进程树死，但 Host 在 Job 外存活，持有 pipe 与全部 PTY；新 daemon 起来 → connect pipe → 握手（§2）→ 拿到 instance 清单。**daemon 不因自身版本变化杀 Host**——Host 代码可能落后于新 daemon 是接受代价，由版本协商如实上报；Host 侧代码改动需用户显式 `weave runtime restart`（走 graceful shutdown 链，如实杀实例并落 `failed`）。理由：保 Agent 存活优先于开发便利，§11.3 禁止盲目重启。
- **生产模式**：dist Host 无热重启问题，生命周期 = 首个 headless 请求时按需 spawn（懒起），daemon 优雅停机（`start.ts` shutdown 链）只断 IPC、不动 Host；`weave daemon stop` 同理。
- **Host 空闲自退**：pipe 无连接且 0 活实例持续 10 分钟 → Host 逐个清理句柄后自退。理由：不开会话就不该有常驻进程占用；也兜底 daemon 死透后的僵尸 Host。
- **Host 不占 6420**（`CLAUDE.local.md`）：pipe 无端口，天然满足；B1 不做任何 HTTP/WebSocket 监听。

## 2. IPC：Named Pipe 消息协议

### 2.1 传输与帧

- `node:net` over `\\.\pipe\...`，**NDJSON 帧**（每行一条 JSON，UTF-8）。理由：零依赖、可 `cat` 调试、与既有 JSONL ledger 习惯一致；长度前缀帧在 B1 体量下无必要。

### 2.2 三形消息（全部从 B0 `runtime/protocol.ts` import，双侧同包零转换）

- **请求** `RuntimeHostRequest {id, type, instanceId?, payload?}`：`hello`、`ping`、`instance.spawn`、`instance.stdin`、`instance.resize`、`instance.kill`、`instances.list`、`shutdown.graceful`。
- **响应** `RuntimeHostResponse {id, ok, payload? | error?}`。
- **事件** `RuntimeHostEvent {eventId, instanceId, sequence, type, timestamp, payload}`：`instance.started/exited/error`、`terminal.output`（base64 字节 + 单调 sequence）、`terminal.resize`。sequence 按 instance 单调递增（B3 重放的锚点，B1 就立好）。

### 2.3 握手、认证、版本协商

- daemon `connect` 后立即发 `hello{protocolVersion, weaveVersion, localToken}`；Host 自读 `getAuthPath()` 的 auth.json（**「本机即管理员」既有口径**，与 CLI `localTokenHeader` 同信源），`safeEqual` 校验 localToken，失败即断开连接。理由：Named Pipe 本机默认 ACL 已限同用户，令牌校验再挡同机提权面（方案 §14.3）；不引入新凭据体系。
- Host 回 `ack{hostId, protocolVersion, weaveVersion, instances[]}`——握手完成即免费完成一次清单自报，对账（§4）接着跑。hostId = 首启生成随机短码，持久 `<data>/runtime-host.json`（含 startedAt），配合 `runtime_hosts` 是否落库的计划 §2 裁决：**B1 不落库**，hostId 只活在握手与 `agent_instances.runtimeHostId` 列，重连时以 pipe 存在性 + hostId 稳定性判「同一个 Host」。
- `protocolVersion` 不匹配：daemon 发 `shutdown.graceful`（带 reason='protocol'）→ 等退出 → 重 spawn。理由：老协议 Host 留着必然对不上账，与其带病运行不如受控重启。

### 2.4 心跳与失联语义（单向）

daemon 每 5s `ping`，3 次失败 → 标记 Host `unreachable`，SSE/dashboard 报状态，**不杀不重启**；pipe 重连成功即恢复。Host 侧对 daemon 失联**零动作**（实例继续跑，ring buffer 继续写）。理由：失败方向只有 daemon→Host，Host 永远不该因「没人管」自杀——那正是本设计要消灭的故障模式。

## 3. Host 内部结构（`src/runtime/`）

```
runtime/
  host-entry.ts          # 独立入口（§1.3），装配 HostServer
  host-server.ts         # pipe server + 握手 + 请求路由 + 事件泵
  instance-manager.ts    # per-instance PTY 生命周期
  windows-bin-resolver.ts# claude/codex bin 解析（§5.1）
  spawn-outside-job.ts   # WMI util（自 CLI daemon.ts 提炼，双向引用）
  adapters/windows-pty.ts# node-pty 薄封装（spawn/write/resize/kill/onData/onExit）
  supervisor.ts          # daemon 侧：探测/spawn/重连/对账编排（计划 §2 落点）
  runtime-host-client.ts # daemon 侧 IPC client（NDJSON + 请求/响应关联 + 订阅）
```

### 3.1 per-instance 管理

- `Map<instanceId, {pty, osPid, cols, rows, status, startedAt, ring}>`；`instanceId` 由 daemon 生成并在 `instance.spawn` 请求携带（标识纪律：instanceId/harnessSessionId/osPid/ptyId 互不混用，B0 协议注释已定）。
- spawn 成功 → `instance.started{osPid}`；`pty.onExit` → `instance.exited{exitCode, exitedAt}`，行保留 5 分钟后从内存淘汰（历史归 DB）。理由：窗口期让 daemon 补拉终态，防事件丢失造成僵尸行。
- **stdout 背压**：Host 侧 pipe 写队列超阈值（4MB/instance）→ 合并丢弃 `terminal.output`（落一个 `terminal.gap` 标记事件），**控制类事件（instance.*）永不丢**。理由：PoC 证实句柄拖进程——同步阻塞写会拖死 PTY 读循环；方案 §13.2「输出写失败不阻塞 PTY」在 Host 侧的第一道闸。

### 3.2 Ring buffer（Host 必须有，不只 B3）

- per-instance 环形 buffer（默认 512KB 字节，Host 总额 16MB，LRU 淘汰非活跃实例），存 base64 chunk + sequence + resize 事件。
- **理由（关键决策）**：daemon/tsx 重启的空窗期输出必须留在 Host，重连后 daemon 带 `lastSequence` 补拉；B3 Gateway 的重放/journal 是它的下游持久层，不是替代。没有 Host ring，「daemon 重启恢复终端视图」根本不成立。

### 3.3 句柄生命周期（POC 附带发现②的正面解）

- Host 任何退出路径都走同一条 `shutdownAll()`：逐实例 `pty.kill()`（等待 onExit，2s 超时）→ `server.close()` → `process.exit(0)`。挂 `SIGTERM/SIGINT/exit` handler 兜底；**禁止裸 return**——pty 句柄会拖住 node 事件循环不退（PoC 实测）。
- 触发面：daemon `shutdown.graceful` 请求、空闲自退（§1.3）、版本协商失败重换。杀实例前 daemon 先把 DB 行落 `exited/failed`，Host 只管进程。

## 4. daemon 重启重连对账

daemon 启动链（`start.ts` / `dev-entry.ts` 装配段）插入 supervisor 初始化：

1. connect pipe（超时 3s）→ 失败则 `spawnOutsideJob` 起 Host → 重试 connect。
2. 握手（§2.3）拿 `instances[]`。
3. **对账三向**（纯函数进 B0 `instance-registry.ts`，单测覆盖）：
   - **DB 有 ∩ Host 有**：校验 runtimeHostId/osPid/sequence 水位，不一致以 Host 为运行态真源、DB 覆写。
   - **DB 有 ∩ Host 无**（headless 非 exited/failed 行）：= Host 曾崩溃，PoC #2 保证子进程已死 → 直接落 `failed`（`errorMessage: 'runtime host exited'`），UI 提供 resume 入口（既有 `ResumeCommandSpec` 同源，不新造）。**不自动重启**——§11.3 禁止盲目重拉。
   - **Host 有 ∩ DB 无**（孤儿实例）：= DB 被备份还原/换库。Host **不杀不藏**，上报 orphan 清单，daemon 在 dashboard 显式列出让用户逐个裁决（adopt 重建行 / kill）。理由：还原场景里「静默收编」和「静默杀掉」都会造成不可解释的数据丢失。
4. 对账后 daemon 补拉各实例 `lastSequence` 之后的 ring 增量，重建 Gateway 视图（B1 阶段先落内存，B3 接管）。

## 5. Claude/codex 启动适配

### 5.1 bin 解析（`windows-bin-resolver.ts`，POC 附带发现①）

解析链，成功即缓存：
1. `where <bin>` → 命中裸 `.exe` → 直接 spawn。
2. 命中 `.cmd`/`.ps1`（npm shim）→ **读 shim 文本解析出真实 JS 入口** → `[process.execPath, '<cli.js>', ...args]` spawn。理由：少一层 shell 进程树、拿到 claude 真实 pid（liveness/中断键序都受益），与 `CLAUDE_RESUME.promptStdin` 的「命令行无用户内容」原则同构。
3. 解析失败 → 回落 `cmd.exe /c <bin> <args>`（PoC 验证可行）。理由：shim 形态随 npm 版本变，回落保底通路。

参数拼装完全复用 `ResumeCommandSpec`（`bin`/`launchArgs`/`openArgs`/`args`）——headless 交互会话用 `openArgs`（无 `-p`，进 PTY 后由用户/投递继续），**server 不写 harness 命令硬编码**（openSessionTerminal 同纪律）。

### 5.2 env 注入与 TERMINAL_LOCATOR_ENV_KEYS 的裁决

- **键表不走**：headless pane 里没有 wezterm/wt/konsole 注入任何 locator env，`TERMINAL_LOCATOR_ENV_KEYS` 的语义（「同机唯一定位一个 pane」）对 Host 的 PTY 天然不存在——注入假键只会污染 hook 采集。层② 定位由**结构化通道替代**：daemon 侧给 MessageDeliverer 装配一个 headless 版 PromptTerminal 适配器，pane id = instanceId，投递 = IPC `instance.stdin`（`sendPromptText` 形态，等同既有 sendText）。既有层序（层① inbox socket → 层② → 队列）一个不动，只是层② 多一个后端。理由：复用既有投递链与能力矩阵，不自造第三通道（计划 §4 边界）。
- **新增 env**：`WEAVE_INSTANCE_ID=<instanceId>`、`WEAVE_RUNTIME_HEADLESS=1`，供 hook 采集把事件归到实例。理由：实例归因走结构化旁路，而非解析终端文本（方案 §7.3 红线）。
- **cwd 白名单**：只允许 `ProjectRepository` 已注册路径（对齐 openSessionTerminal 的 project 校验）；命令来源仅 harness resume/launch 规格，不接受 dashboard 任意命令（方案 §14.1）。

## 6. 状态机与 DB 写入边界

### 6.1 状态机（B0 定义，Host/daemon 分工）

`created → starting → running → waiting_input/waiting_approval → exited | failed | recovering`
- `starting/running` 翻转由 Host 事件驱动；`waiting_input/approval` 由既有 QuestionTracker/hook 事件体系驱动（**不进 Host**——问答裁决归 daemon，Host 只透传键序，计划 §4）。
- `failed` 两个固定来源：Host 崩溃对账（§4）、spawn/pty 错误。`recovering` B1 不使用（无进程级恢复可言，如实 `failed` + resume 入口）。

### 6.2 写入边界：**daemon 是 agent_instances 的唯一 writer**

| 数据 | 归属 |
| --- | --- |
| PTY 句柄、ptyId、实时 cols/rows、ring buffer、sequence 游标、内存 status | Host（易失，不落库） |
| 标识行（id/projectId/harness/runtimeHostId/executionMode）、状态、workingDirectory、command/args、osPid 快照、harnessSessionId、createdAt/startedAt/exitedAt、exitCode/errorMessage | `agent_instances` 表（daemon 写） |
| sequence 水位 | DB 每实例一列，daemon 周期（5s 或批量事件时）flush；重连对账锚点 |

理由：① SQLite 单写者纪律——Host 开第二个连接会在 WAL 上与 daemon 打架（仓内 shutdown 链注释已实测过 `database is locked`）；② Host 保持「哑执行者」，崩溃恢复语义集中在对账逻辑一处。Host 不读不写 DB，表结构追加进 `db/db.ts` 集中式 SCHEMA（仓内无 migrations 目录，按既有模式）。

### 6.3 事件 → DB 的映射

Host 事件到达 daemon → supervisor 更新内存 registry → 按状态迁移写 `agent_instances`（只在状态列实际变化时写）。`terminal.output` 不落库（B1），只走 ring；journal 是 B3 的事。

## 7. 验收对照（计划 §3 B1 验收的落点）

- 不开 WezTerm 起 claude/codex：`instance.spawn` + bin resolver + ConPTY。
- 浏览器没开也照跑：Host 生命周期与浏览器无关（§1）。
- daemon 优雅重启后 Host 重连对账：§2.4 + §4；**dev tsx watch 热重启专项验证**（WMI 断链是否真把 Host 留下，验收脚本：改一行 server 源码触发 watch 重启，断言 pipe 仍通、实例仍 running）。
- 进程退出正确落 exited：onExit → event → daemon 写库（§6.3）。
- 崩溃路径：taskkill /F Host → 对账全落 failed（§4）。

## 8. 实施顺序与风险

1. `spawn-outside-job.ts` 提炼（无行为变化，CLI 改引）→ 2. B0 前置类型 + 表 → 3. host-entry/host-server/instance-manager（先 spawn/exit/stdin/resize，ring 后补）→ 4. supervisor + 对账 → 5. bin resolver → 6. MessageDeliverer headless 通道（最小面：只 deliverPrompt 层②）。
- 最大残留风险：**tsx watch 杀树的实现细节**（tsx 版本若改用 Job 而非进程树枚举，WMI 路径仍应存活但必须实测——验收第 3 条专项覆盖）。次风险：shim 解析对 PowerShell 版 shim 的覆盖，回落 `cmd /c` 兜底。
