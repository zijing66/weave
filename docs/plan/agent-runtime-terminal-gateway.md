# Agent Runtime 与 Web Terminal 改造（评估 + 分阶段计划）

> 状态：**计划**——依据 = 用户 2026-11-20 上传的《Weave Agent Runtime & Web Terminal 设计方案》
> （原件留档：`docs/plan/agent-runtime-terminal-design.md`）。先计划落档，再对照实现；
> 每阶段完成即回本文打勾并把带日期的裁决记入 `docs/DECISIONS.md`。

## 1. 现状评估（方案 vs 本仓实测）

| 方案要求 | 本仓现状 | 差距 |
| --- | --- | --- |
| Agent 生命周期独立于终端 | **没有**。会话唯一的起法 = `openSessionTerminal`（`daemon/session-open.ts:129`）spawn 外部终端跑 harness 交互式 resume | 全缺：Runtime Host / PTY / headless 均不存在 |
| Terminal Gateway（多客户端、重放、Lease） | **没有**。终端交互全是「对已开 pane 单点打键」（`TerminalBackend.sendKeys` / `sendPromptText`），读屏 = `getPaneText` 可视屏快照，无字节流、无序号、无广播 | 全缺 |
| Dashboard Web Terminal（xterm.js） | **没有**。web 里零终端组件（grep 无 xterm 命中） | 全缺 |
| 现有 TerminalBackend 保留为 Presentation | 已有且成熟：wezterm / wt / konsole / iterm / terminal 五实现 + auto 装配，读屏、注键、隐藏、关 pane 通道齐全 | 方向一致，零改动保留 |
| 结构化事件、Question、Messaging 复用 | 已有（hook_events / QuestionTracker / MessageDeliverer 全套） | 方案明确「不替代」，直接复用 |
| Daemon 重启后 Agent 存活 | 现状 = daemon 重启不杀终端里的会话（宿主本就不归 daemon 管），但**原因是它管不了**；Runtime Host 模式下这是必须新设计的一环 | 新增设计 |
| 多实例并行 20–40 | 现状每个会话一个外部 pane，GUI 开销已实测（wezterm 软渲染 = 本机 CPU 唯一大户，见 `weave-cpu-baseline` 记忆） | headless 是解法，正中痛点 |

**结论**：方案与仓库现状不冲突、是净新增一层。三条既有铁律需要显式对齐：

1. **SSE 单通道（§9「不得再 new EventSource」）**：终端字节流是双向高频通道，SSE 不合适。
   B3 落地时在 CLAUDE.md §9 加一条例外（terminal WebSocket 唯一客户端 = `web/src/lib/terminal.ts`）。
2. **自包含发布约束**（`weave-umbrella-tgz-install`：npm -g 不解析 dependencies、
   MAX_PATH ≈ prefix+169）：**node-pty 是原生模块**——预编译二进制装不进自包含 tgz 的
   假设必须先 PoC（见 §6 开放问题 1），不通过则 Windows 侧 ConPTY 走自有 addon 或
   node:child_process + Windows API 后备路线。
3. **能力面纪律**：Harness 差异（resume、非交互启动参数）不新造 `HarnessCapabilities`
   接口——既有 `ResumeCommandSpec` / `MessagingSurface` / `QuestionsSurface` 已经是
   能力声明，Runtime 侧按槽取用，不写第二套能力面。

## 2. 落点（对齐既有目录约定）

```
packages/weave-server/src/
  runtime/
    protocol.ts            # RuntimeHostRequest/Response/Event、Terminal Stream Protocol（B0）
    instance-registry.ts   # agent_instances 内存登记 + SQLite 对账（B0/B1）
    supervisor.ts          # Runtime Host 子进程监督（spawn/heartbeat/reconnect）（B1）
    runtime-host-client.ts # daemon 侧 IPC 客户端（B1）
    adapters/
      windows-pty.ts       # ConPTY（B1 PoC）
      tmux.ts              # WSL2/Linux 持久会话（B2）
  terminal/
    session-gateway.ts    # 广播/Sequence/重放/背压（B3）
    output-buffer.ts       # Ring Buffer（B3）
    output-journal.ts      # 落盘 journal（B3）
    input-lease.ts         # 多客户端输入仲裁（B3/B5）
  agent/                   # /agents 路由 + 实例生命周期（B0 起逐步）
packages/weave-server/web/src/features/
  terminal/                # xterm.js 视图（B4）
```

数据模型：`agent_instances` 表进 `db/db.ts` 的 schema（本仓无独立 migrations 目录，
建表语句集中在 `SCHEMA`；新表按既有模式追加 + 对账幂等）。
`terminal_clients` 内存为主；`runtime_hosts` 视 B1 实测再决定是否落库。

## 3. 阶段计划（对方案 §15，验收逐条可测）

### B0 Runtime 基础协议（纯类型 + schema，零行为变化）✅ 2026-11-20（14f05579）
- [x] `runtime/protocol.ts`：AgentInstance 状态机（created→starting→running→
  waiting_input/approval→…→exited/failed/recovering）、RuntimeHost IPC 消息、
  Terminal Stream Protocol（`encoding:"base64"` 字节流、单调 sequence）。
- [x] `agent_instances` 表 + registry 对账纯函数（含测试）。
- [x] 标识纪律进协议注释：instanceId / harnessSessionId / osPid / ptyId 互不混用。
- 验收：两个 tsc + 既有测试全绿；不触碰 sessions 表、daemon 装配、TerminalBackend。

### B1 Windows Runtime Host（本机主战场，先行）✅ 2026-11-20（04d5185e）
- [x] node-pty PoC：Node 22 + pnpm + win32 x64 下预编译加载、装进自包含 tgz 后
  全新目录 `npm -g` 安装可用（**这条不过，B1 换路线，不硬上**）。
- [x] Runtime Host 子进程（Named Pipe IPC）+ daemon 重连对账。
- [x] 生命周期：spawn / stdin / stdout / 退出码 / heartbeat / graceful shutdown。
- [x] Job Object 验证：Host 崩溃后 Agent 子进程存活策略实测（不假设可恢复）。
- 验收（2026-11-20 实测，`%TEMP%\weave-pty-poc\probe-e2e.mjs` / `probe-claude.mjs`）：
  **全过**——E2E 七项（握手/坏 token 拒/spawn/输出捕获/退出码/单调 sequence/
  Host 死后对账判 failed）+ 真 claude TUI 冒烟（bin 解析链 + Kitty/OSC/bracketed
  paste 全捕获）。**B1 收尾亦全过**（77e38c23 + 11a15d6c）：supervisor/合并通道
  挂入 start.ts 与 dev-entry.ts 两处装配（30s 自愈重试）、headless 层② =
  `HeadlessTerminal` 实现 `PromptTerminal`（instanceId 形 pane id 直投 stdin）、
  WMI 真拓扑终验六项全过（断链 spawn/连接/实例/父子链/**daemon 死后 Host 与
  实例存活**）。两条实测新定案：① Host spawn 后须等 8s（tsx 冷加载 + 原生模块
  >1.5s 才监听）；② **dataDir 必须走 argv**——WMI Create 的进程环境来自
  WmiPrvSE，不继承调用方 env。
- 依 `CLAUDE.local.md`：daemon 由用户手动起，会话只起 Runtime Host 子进程（不占 6420）。

### B2 WSL2 tmux Adapter ✅ 2026-11-20（ab780c99）
- [x] tmux session 命名规则（`weave-agent-<短码>`）、send-keys、capture-pane -e、
  resize、清单对账（`adapters/tmux.ts`）。
- [x] **实测定案**：`capture-pane -e` 是重绘等价序列（保 ANSI 色、丢 OSC/原始
  字节，`[39m` 归位而非 `[0m`）——重放语义 = **快照重建**，与 ConPTY 字节流型
  并列同一协议（TerminalOutputEvent 序列号统一，快照一次一号）。本机 Ubuntu-
  26.04 + tmux 3.6 六项活体验证全过（spawn/ANSI 快照/send-keys/resize/list/kill）。
- 验收：WSL2 持久会话全链已通；「Dashboard 可见」待 B4（Web Terminal）点亮后
  复验；tmux 原生 attach 本机即 tmux attach 命令（多客户端 = tmux 自带能力）。

### B3 Terminal Gateway ✅ 2026-11-20（b6aab843）
- [x] WebSocket 端点 `/terminals/ws`（RFC6455 零依赖自实现——自包含发布纪律；
  认证与 HTTP/SSE 同判据 cookie/localToken）+ Ring Buffer + sequence 重放 +
  gap 标记 + Input Lease（多读一写、15s 心跳、超时接管）+ resize 归 Write
  Client + 背压（可写缓冲超限断开，重连重放兜底）。
- [x] CLAUDE.md §9 例外条款已同步（唯一 WS 例外 = 终端流；B4 前端唯一客户端
  = `web/src/lib/terminal.ts`）。
- [x] **E2E 六项全过**（probe-b3.mjs）：attach ack / 输出广播 / 无 Lease stdin
  拒绝 / Lease 授予 / Lease stdin 注入回声 / 重连重放。
- [x] 两条实测定案：① PTY canonical 模式下 node stdin data 事件要 CR 才送达
  （TUI harness 吃 raw 键序不受影响）；② bin 绝对路径直接 spawn（`where` 不吃
  绝对路径——resolver 已修）。**Gateway 不懂传输**：下行经端点注入的 send
  （裸 NDJSON ≠ WS 帧——初版直写 socket 客户端 1006 的教训）。
- 验收：断开重连恢复输出 ✅、缺口显式标记 ✅（gap 帧 + Host ring 补拉）、
  多客户端写不乱序 ✅（Lease 唯一写者）、输出写失败不阻塞 PTY ✅（背压断开）。

### B4 Dashboard Web Terminal
- [x] xterm.js（依赖装进 web，非 server）；只渲染选中实例，scrollback 上限。
- [x] Workbench 最小闭环：HarnessPicker 加 headless 开关 → `startHeadlessSession` →
  TasksPanel 全屏弹层挂 `TerminalView`（xterm）+ 「打开 Web 终端」重开入口
  （`listAgentInstances` 活实例重进即恢复）。**实测定案**：① TLS 监听是独立
  server 实例，`/terminals/ws` 的 upgrade 必须两处同挂（不挂会把 WS 当普通请求
  回落 SPA 200）；② stdin 与 output 都是原文字符串（node-pty 已按 UTF-8 解码、
  保留 ANSI；协议注释里的 `encoding:"base64"` 是 B0 旧设想，实际未采用），前端
  xterm `onData` 原样直传、`term.write(data)` 原样渲染即可。
- 2026-11-20 真实浏览器验收发现四处断链（此前手写 WS 探针直连 daemon ≠ 浏览器
  链路，原「B4 完成」判断过早撤回）并当日修复：
  1. **dev server 黑屏断流** = Vite 只代理 `/api`，`/terminals/ws` 未配 `ws:true`。
  2. **连上仍黑屏** = Gateway 首次 attach（无 `lastSequence`）不重放 Host ring——
     TUI 停在提示页时永远等不来新输出；改为首次接入从 0 整段重放（单测锁定）。
  3. **「只读（输入权被占用）」误报** = `requestControl()` 在 WS open 前发出被静默
     丢弃 + lease 心跳先设 leaseId 再 stop 被自己清空；修后文案三分（申请中/被
     占用/已解锁）。
  4. **会话列表打不开 headless 会话** = `WEAVE_INSTANCE_ID` 注入了 env 但全链无
     消费者、`agent_instances.harness_session_id` 恒 NULL：core 加
     `RUNTIME_INSTANCE_ENV`（claude capture 采集键随 terminal 旁路上报）→
     ingest 首事件回写 `bindSession`（首绑即定；`updatePid` 改 COALESCE 防对账
     刷掉）→ API/`AgentInstanceRow` 带 `harnessSessionId` → 会话行「打开终端」
     命中活实例即转 Web 终端（外部 resume 会另起进程，不走）；顶栏入口改为
     选中会话对号 → 单实例直开 → 多实例弹选单（不猜「最后一个」）。附带：
     `HeadlessTerminal.locatePane` 的层② 定位信源由此接通。**注意：hook-handler
     生成物不随包升级——存量项目须重跑 `weave init` 才带新采集键**。
- 验收：真 claude headless 实例 WS attach + lease 授予 + stdin 逐字符回显全通
  （探针 = `.weave/previews/ws-attach-test.mjs`）；实例长跑与 WS 客户端连接/断开
  解耦（关浏览器不退）✅；重进恢复 = 重开入口重连 attach + ring 重放 ✅。
  2026-11-20 真实浏览器已复验 Vite 代理、Lease、首屏 TUI 恢复：旧 Host 不支持
  `instance.replay` 时，拿到 Lease 后用 PTY resize 触发 Claude 重绘，屏幕可见。
  这只恢复当前屏幕，不把旧终端输出伪装成完整历史；普通 gap 与旧 Host 协议不兼容
  已分开标记。
- [x] 2026-11-20 浏览器复验（独立 session `weavewt`，Vite dev server）：
  ① 收起弹层后实例仍 `running`，重开入口接回同一实例、TUI 与输入权恢复；
  ② 页面存活时强断终端 WS → `TerminalClient` 自动重连（带 `lastSequence`）、
     新连接拿到 Lease、屏上 `已连接 · 输入已解锁`；控制台不再报
     `broken close frame containing invalid UTF-8`（三处协议修复：close 帧状态码
     按 2 字节写、pong 原样回 Buffer、重放不再与实时输出交错——见
     `session-gateway.test.ts` 新增两条）；
  ③ **旧 DB 历史兼容**：点开 11/18 已关闭、无 `agent_instances` 绑定的旧会话，
     对话正文照常从 `hook_events` 读出——升级不要求该会话曾有 Runtime 实例。
- **终端预设 `web` 与「开会话」单一入口（2026-11-20 用户裁决）**：Web 终端不再是
  HarnessPicker 里的开关，而是设置页与 wt/wezterm/… 并列的终端预设（**默认第一位**，
  选中后新会话恒起 headless，开关退成「恒开」说明）。**开会话仍然只有一条入口**
  （`openSessionTerminal` / `POST /sessions/:id/open-terminal`）：宿主形态由终端后端
  自答（`TerminalBackend.hostsSessions`，web = `headless`、其余 = `window`），路由与
  前端不按 preset 分叉、没有第二个 `open-headless` 路由。交互口径：对话与 Web 终端
  共用右栏同区、默认对话，对话头部与会话卡片的终端按钮进同一处（X 只收起，TUI 照跑）；
  **已关闭的会话点按钮就地 headless resume**（判据与外部终端开窗同一份
  `resolveResume`：harness 可解、有 `openArgs`、转录还在），起来后**停在对话面**，
  实例绑定落地按钮转绿，再点才进 TUI；**正跑在外部终端里的会话接不过来**（置灰并
  说明「先关掉那个终端」）。会话卡片「已开终端」描绿边（选中蓝边优先），列表头那枚
  旧的「重开 Web 终端」按钮退役。
- [ ] 会话行精确对号 headless 实例（`harnessSessionId` 绑定）：存量项目需重跑
  `weave init` 让 hook-handler 带上 `WEAVE_INSTANCE_ID` 采集键，再产生新事件才会
  首绑；本次老实例仍为 null，未按「项目唯一活实例」猜绑，故不算通过。
- **历史边界**：既有 `hook_events` DB 历史与 Harness 原生转录继续作为对话/事件历史，
  不迁移、不删除；B4 的 Host ring 只负责短期终端字节恢复，Durable Output Journal /
  Terminal Checkpoint 属于后续稳定性阶段，当前不声称已有长期 ANSI 输出档案。
  codex TUI 交互留待 B5/B6 汇总验。

### B5 External Attach
- [x] `weave agent attach [--readonly]`：CLI 连 Gateway（Windows 不做 ConPTY 句柄
  转让，attach 客户端即 Terminal Bridge）；tmux 平台原生 attach。
  2026-11-20 落地（e328e5ae）：`weave agent attach [--readonly] [sessionId]`——
  CLI 自实现客户端 WS（`writeClientFrame` 掩码帧，服务端 parseFrame 解），
  sessionId 缺省取第一条活 headless 实例；input lease 授予后 TTY 进 raw、键盘
  原样进 stdin、下行原样写 stdout，Ctrl+C 交宿主 TUI。实机验证：readonly 与
  interactive 双通（weave-5b 实例，输出实时桥进、`❯` 提示行重绘正常）。
  2026-11-20 补齐（b23908ba）：Ctrl+Q（0x11）本地拦截 detach；readonly 零 stdin
  转发、不申请 lease；lease.released/denied 转只读；teardown 幂等 + 全量句柄清理
  （heartbeat/stdin/resize/raw mode），action 正常 resolve 不再 process.exit；
  握手 key 与掩码改 randomBytes、ping 回 pong。实测：readonly attach 活实例 +
  Ctrl+Q 干净退出（exit 0）。
- 验收：外部终端与 Dashboard 同一实例、不重复起、输入控制权明确、外终端退出不影响 Agent。✅（同实例广播实测：CLI 与 web 两端同时看到彼此的键入）

### B6 跨平台收尾与稳定性
- [x] 跨平台 IPC 与命令解析（588d75ae）：`runtimePipePath` 分形——Windows Named
  Pipe 不变；POSIX = data 根 `cache/` 下 `.sock` 文件（stale socket 启动前探活清理：
  活 Host 如实拒绝、死文件 unlink；shutdown 时 unlink）。`posix-bin-resolver`：
  `which` 命中 direct（shebang 可直接 execvp）、未命中回落 `/bin/sh -c`；Windows
  resolver 不动。**POSIX 分支本机（Windows）不可实机验，仅单测覆盖，如实标注**。
- [x] 8→12→40 实例压测 + 资源采样（2026-11-20 探针 `%TEMP%\weave-b6-probe\load.mts`，
  实例 = ping 轻进程、独立临时数据目录、不碰活 daemon）：三档全 running
  （8/8、12/12、40/40），spawn 均摊 ~780ms/个（ConPTY 冷启动），Host RSS
  231MB@8 → 322MB@12 → 671MB@40，事件流 1088 帧、replay 正常、收尾零残留
  （kill 时 node-pty 内部 console-list 子代理打 `AttachConsole failed` 噪声，不影响结果）。
- [x] 故障注入（同探针 `fault.mts`）：① 优雅停机（`shutdown.graceful` IPC——
  Windows 下 Node 的 SIGTERM 是硬杀、信号处理器不触发，优雅通道恒走 IPC 请求）=
  Host exit 0、实例受管全部终止；② 硬杀 Host = 实例随之死（ConPTY 断链，与
  PoC #2 定案一致）——新 Host 重启接管 pipe、实例清单如实归零。
- [x] 恢复向导（6582f389）：判据面 = 终端终态如实到达——① Gateway attach 前校验
  Host 活实例清单，死实例回致命 `error{fatal:true}` 不装「已连接」（Host 暂不可达
  不拦，网络抖动照常重连）；② `instance.exited` 广播到终端客户端；③ TerminalClient
  收 fatal/exited 即 `gone()` 停心跳停重连；④ TerminalView 转终态「已退出」并引导
  走会话终端按钮 resume（实例 failed 后 `webInstanceId` 消失、按钮自动回 resume 态，
  既有链路）。实机验证：活 daemon 上 attach 不存在实例 → `instance not found`
  fatal 帧真实到达。
- [x] tmux 平台原生 attach、WSL2 实机验（2026-11-20，Ubuntu-24.04 / tmux 3.4，
  探针 `%TEMP%\weave-b6-probe\tmux-probe.mts`）：① spawn detached 会话（pane id
  `%N` 形）；② capture-pane 保 ANSI 快照两次内容推进（重绘等价序列成立）；
  ③ resize；④ `list-sessions -F` 对账（pid/paneId）；⑤ send-keys 字面量 + 裸键
  Enter 注入、回显在屏；⑥ kill-session 零残留。tmux 原生 attach 面 = 会话名恒
  `weave-agent-*` 可辨识，用户在 WSL 里 `tmux attach -t <名>` 即直接进同一实例
  （capture/keys 双通道并存）。Linux/macOS 裸机（非 WSL）仍无环境，如实标注。
- **WSL Agent 事件回流不可用（2026-11-20 实测 + 用户裁决「tmux 是一整套方案」）**：
  B2 验证的 tmux adapter 只是**传输面**（weave 驱动 WSL 里的会话）；「会话的事件
  回流」（hook → inbox → daemon）在 Windows daemon 下对 WSL 内 Agent **三重不可见**：
  ① hooks 声明在 Windows 侧 `~/.claude/settings.json`，WSL 的 claude 读
  `/home/<user>/.claude/settings.json`（不存在）；② hook-handler 按运行时平台
  自算落点（`process.platform !== 'win32'` → `~/.config/weave/cache/hooks/inbox`），
  Linux 进程写进 WSL 文件系统，Windows daemon 的 `%APPDATA%` inbox 永远取不到；
  ③ 转录在 WSL home（`/home/.../*.jsonl`），Windows fs 打不开。**定案：不做跨
  边界桥**——weave daemon 跑在 WSL = 完整 Linux 方案（默认 PTY、tmux 可选），
  跑在 Windows = 仅 Windows 方案；想在 WSL 用 weave = 在 WSL 里跑一套独立
  daemon（两套库互不相见是接受面，不是缺陷）。
- 验收：20–40 实例管理稳定；不可恢复状态如实标注。（40 实例管理稳定 ✅ 2026-11-20）

## 4. 与既有面的边界（防越权）

- TerminalBackend 一行不改：外部终端仍是 Presentation，与 Runtime 并列（方案 §12.1）。
- Inbox Socket / 层② 投递优先级不动：headless 实例的 prompt 投递在 B1 先走
  `MessageDeliverer` 既有层序，层② = Host stdin（等同 sendText），不自造第三通道。
- 中断：headless 下 `interrupt` 的键梯子（ESC_KITTY→ESC→Ctrl+B，§7）原样打进
  Host stdin——读屏判据改读 Gateway 输出流，键序本身复用。
- QuestionTracker 不与 PTY 耦合：问答键序经 Lease 持有者注入，裁决仍归 Tracker。

## 5. 风险与顺序原则

- **先生命周期、再数据通道、最后体验**（方案 §20）；禁止先做漂亮 Web Terminal。
- 最大技术风险 = node-pty × 自包含发布（B1 第一件事，卡住即调整路线，成本最低点）。
- 次风险 = Windows Host 崩溃后 PTY 句柄不可恢复（方案已承认，落 `recovering/failed`
  如实标注 + 用户确认，不盲目重启）。
- 40 实例目标是管理规模不是并发承诺；等待审批不占执行槽。

## 6. 实施前必须 PoC 的清单（2026-11-20 实机验证完毕，探针 = `%TEMP%\weave-pty-poc`）

| # | 验证项 | 结果 |
| --- | --- | --- |
| 1 | node-pty 预编译 × 自包含 tgz × 深路径 | ✅ **通过**。prebuild.js 下载全部平台 `.node`（无本地编译）；带 prebuilds 打 tgz → 深路径（前缀 125 字符）`npm install --ignore-scripts` → require + ConPTY spawn 全通。注意：本机 npm allowScripts 策略会拦 install 脚本——发布链必须**离线可用**（--ignore-scripts 也通），不能依赖用户机跑 install 脚本 |
| 2 | Host 崩溃 → Agent 子进程存活 | ❌ **Host 退出 = 子进程立即死**（ConPTY 管道随句柄关闭断裂，Job Object 救不了）。定案：崩溃恢复只走 harness resume，状态机如实落 `failed`，不承诺进程级存活（与方案 §11.3 一致） |
| 3 | claude TUI 进 ConPTY + 字节流捕获 | ✅ 完整渲染；原始流含 Kitty 握手（`ESC[<u` / `ESC[>5u`）、OSC、bracketed paste、sync output——字节流协议路线成立；中断键序复用 §7 梯子 |
| 4 | resize / stdin 写入 | ✅ |
| 5 | tmux capture-pane 保真度 | 未验（B2 阶段在 WSL2 实机做，无 WSL 环境时如实标注） |
| — | **平台包不混装**（2026-11-20 用户裁决） | ✅ `pack-weave.mjs` 暂存阶段按目标平台裁 `prebuilds/`（实测裁到只剩 win32-x64 后照常可用）；跨平台发布 = 每平台一枚 tgz。不采用 optionalDependencies + os/cpu（伞包 tgz 离线安装链上取不到可选依赖）。单枚通吃全平台则混入 +15MB 压缩体积，按平台出包为准 |
| — | 附带发现 | ① `pty.spawn('claude')` 直调 error 2：npm shim 不能被 CreateProcess 解析，Host 适配层须 `cmd /c` 或解析真实 bin；② node 进程被 pty 句柄拖住不退——Host 须显式管理句柄生命周期 |

**总裁决（2026-11-20）**：Windows 主战场全项可行，B1 无阻塞，按 §3 顺序实施。
