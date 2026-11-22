# Weave Agent Runtime & Web Terminal 设计方案
> 文档类型：技术架构设计 / 实施规格\
> 项目：Weave\
> 目标：将 Weave 从 Coding Agent Harness 扩展为跨平台 Agent Runtime、Web Terminal 与 Agent Workbench\
> 适用环境：Windows、WSL2、Linux、macOS\
> 目标规模：20～40 个并行 Agent\
> Agent 类型：Claude Code、Codex CLI，以及未来可扩展的其他 Coding Agent\
> 状态：Proposal
---
## 1. 背景与目标
### 1.1 当前问题
Weave 已经具备 Coding Agent Harness、Daemon、Dashboard、Hook 事件收集、Inbox Socket、Messaging、Question Tracking 和 Terminal Backend 等基础能力。
但当前架构仍然存在一个关键限制：
Agent 的运行、交互和可视化在一定程度上依赖外部终端窗口。
这带来几个问题：
1. 每个 Agent 需要占用一个终端窗口或 Pane。
2. 大量 WezTerm Pane 会增加 GUI 和系统资源开销。
3. Dashboard 不能完全替代终端进行实时交互。
4. 浏览器、终端和 Agent 生命周期之间存在耦合。
5. Daemon 或终端窗口关闭后，运行状态和恢复能力不够统一。
6. Windows、WSL2、Linux、macOS 的终端机制不同，难以形成统一的运行体验。
### 1.2 核心目标
将 Weave 升级为：
**Agent Runtime + Terminal Gateway + Web Workbench + Control Plane**
用户可以通过三种方式访问同一个 Agent：
- Headless Mode：完全脱离终端窗口运行。
- Dashboard Mode：直接在 Dashboard 中查看和操作终端。
- External Attach Mode：通过 Windows Terminal、WezTerm、tmux 或 Weave CLI 打开终端。
三种模式共享同一个 Agent Instance、同一份运行状态和同一条终端输出流。
不能因为打开 Dashboard 或外部终端，就创建第二个 Agent 进程。
### 1.3 核心体验
用户可以：
 1. 在 Dashboard 创建 Claude Code 或 Codex Agent。
 2. Agent 在后台运行，不需要打开终端窗口。
 3. Dashboard 中直接查看原始 ANSI 终端输出。
 4. 在 Dashboard 中输入命令、回答问题、确认审批。
 5. 随时打开外部终端接管同一个 Agent。
 6. 关闭浏览器后 Agent 继续执行。
 7. 重新打开 Dashboard 后恢复终端视图。
 8. Daemon 重启后重新连接原有 Agent Runtime。
 9. 查看历史输出和 Agent 结构化事件。
10. 多个 Agent 并行运行，并由 Dashboard 统一管理。
---
## 2. 架构设计原则
### 2.1 Agent 生命周期独立于终端
Agent Instance 是运行实体。
Terminal 是访问和展示 Agent 的一种方式。
不能将以下概念混为一谈：
- Agent Instance ID
- Harness Session ID
- Codex Thread ID
- OS Process ID
- PTY ID
- tmux Session ID
- tmux Pane ID
- Dashboard Client ID
它们需要独立标识，并通过关联关系连接。
### 2.2 Dashboard 不是 Agent 的运行容器
浏览器关闭、页面刷新、用户切换路由，都不应该影响 Agent 进程。
Agent 必须由 Runtime Host 管理，而不是由 React 组件或浏览器 WebSocket 管理。
### 2.3 Terminal Backend 与 Agent Runtime 分离
现有 TerminalBackend 主要负责外部终端窗口和 Pane 控制。
新架构需要增加 Agent Process Runtime。
两者职责不同：
| 模块 | 负责内容 |
| --- | --- |
| Agent Runtime | 创建、启动、停止和监控 Agent 进程 |
| PTY Backend | 提供终端输入输出和尺寸控制 |
| Terminal Gateway | 管理终端连接、广播、缓冲、重放 |
| Terminal Presentation | 打开外部终端窗口和 Attach |
| Harness Adapter | 管理 Claude Code、Codex 的协议和会话能力 |
| Dashboard | 展示终端、状态、审批、任务和资源信息 |
### 2.4 统一体验，不强求统一底层
不同平台使用适合自己的实现：
- Windows：ConPTY / node-pty。
- WSL2：tmux + PTY。
- Linux：PTY，必要时使用 tmux。
- macOS：PTY，必要时使用 tmux。
所有平台对上提供统一 Runtime API 和 Terminal Stream Protocol。
---
## 3. 总体架构
```
flowchart TB
    UI[Weave Dashboard]
    WEBTERM[xterm.js Web Terminal]
    WORKBENCH[Agent Workbench]
    CLI[Weave CLI Attach]
    EXT[External Terminal]
    UI --> WEBTERM
    UI --> WORKBENCH
    CLI --> TG
    EXT --> TP
    subgraph SERVER[Weave Server]
        API[HTTP API]
        DAEMON[Daemon]
        DB[(SQLite)]
        TG[Terminal Gateway]
        REG[Instance Registry]
        MSG[Messaging / Questions]
        API --> DAEMON
        DAEMON --> DB
        DAEMON --> REG
        DAEMON --> TG
        DAEMON --> MSG
    end
    subgraph HOST[Runtime Host]
        SUP[Process Supervisor]
        RM[Runtime Manager]
        PTY[PTY Backend]
        TP[Terminal Presentation]
        HA[Harness Adapter]
        RM --> SUP
        RM --> PTY
        RM --> HA
        TP --> PTY
    end
    TG <-->|IPC| RM
    TG <--> WEBTERM
    TG <--> CLI
    TP --> EXT
```
### 3.1 分层说明
**Control Plane**
负责：
- Agent 创建和管理。
- Instance 生命周期。
- 项目和工作目录管理。
- Agent 调度。
- 资源统计。
- 权限和审批。
- 结构化事件管理。
**Runtime Plane**
负责：
- 启动 Agent 进程。
- 持有 PTY。
- 管理 stdin/stdout。
- 进程退出检测。
- 进程重连和恢复。
- 资源采样。
**Terminal Plane**
负责：
- 终端输出广播。
- 输入路由。
- WebSocket 连接。
- 输出序号。
- 输出缓冲。
- 历史重放。
- 多客户端 Attach。
- 终端尺寸协商。
**Presentation Plane**
负责：
- Dashboard Web Terminal。
- Windows Terminal。
- WezTerm。
- tmux。
- CLI Attach。
---
## 4. Agent Runtime Host
### 4.1 设计目标
新增 Runtime Host，作为独立子进程运行。
建议第一阶段仍然放在 `packages/weave-server` 内实现，不立即拆成独立 npm Package。
Runtime Host 负责实际 Agent 进程的生命周期。
Daemon 负责管理和协调，不直接持有所有 Agent 的 PTY 句柄。
### 4.2 进程结构
```
weave daemon
    |
    | IPC
    |
    +---- Runtime Host
              |
              +---- Agent Instance A
              |       |
              |       +---- PTY A
              |
              +---- Agent Instance B
              |       |
              |       +---- PTY B
              |
              +---- Agent Instance C
                      |
                      +---- PTY C
```
### 4.3 Runtime Host 职责
 1. 创建 Agent 进程。
 2. 分配 PTY。
 3. 管理进程 PID。
 4. 接收 stdin。
 5. 读取 stdout/stderr。
 6. 监听进程退出。
 7. 保存终端输出缓冲。
 8. 维护 Instance 状态。
 9. 响应 Daemon 的控制请求。
10. Daemon 重启后允许重新连接。
### 4.4 IPC 通信
Windows 使用 Named Pipe。
Linux、WSL2、macOS 使用 Unix Domain Socket。
建议定义统一 IPC 协议：
```
interface RuntimeHostRequest {
  id: string;
  type: string;
  instanceId?: string;
  payload?: unknown;
}
interface RuntimeHostResponse {
  id: string;
  success: boolean;
  payload?: unknown;
  error?: string;
}
```
事件协议：
```
interface RuntimeHostEvent {
  eventId: string;
  instanceId: string;
  sequence: number;
  type:
    | "instance.started"
    | "instance.exited"
    | "instance.error"
    | "terminal.output"
    | "terminal.resize"
    | "resource.updated";
  timestamp: number;
  payload: unknown;
}
```
### 4.5 Daemon 重启策略
Daemon 重启不应该默认杀死 Runtime Host。
Runtime Host 继续持有 Agent 进程和 PTY。
Daemon 重启后：
1. 启动或发现 Runtime Host。
2. 建立 IPC。
3. 完成版本协商。
4. 查询所有 Instance。
5. 对账 SQLite 中的记录。
6. 恢复 Terminal Gateway 订阅。
7. 更新 Dashboard 状态。
Runtime Host 必须提供：
- Heartbeat。
- IPC Authentication。
- Protocol Version。
- Instance Listing。
- Instance Reconciliation。
- Graceful Shutdown。
注意：Runtime Host 崩溃时，Windows 子进程是否继续存活取决于进程监督和 Job Object 等机制。需要单独验证，不能假设普通 PTY 句柄可以重新获取。
---
## 5. Agent Instance 数据模型
不建议把大量 PTY 和 Process 字段直接塞入现有 `sessions` 表。
新增独立的 `agent_instances` 表。
### 5.1 Agent Instance
```
interface AgentInstance {
  id: string;
  projectId: string;
  harness: "claude" | "codex" | string;
  runtimeHostId: string;
  status:
    | "created"
    | "starting"
    | "running"
    | "waiting_input"
    | "waiting_approval"
    | "paused"
    | "exited"
    | "failed"
    | "recovering";
  executionMode: "headless" | "interactive";
  workingDirectory: string;
  command: string;
  args: string[];
  osPid?: number;
  harnessSessionId?: string;
  harnessThreadId?: string;
  ptyId?: string;
  terminalSessionId: string;
  createdAt: number;
  startedAt?: number;
  exitedAt?: number;
  exitCode?: number;
  errorMessage?: string;
}
```
### 5.2 关联表
建议按需要增加：
- `runtime_hosts`
- `agent_instances`
- `terminal_sessions`
- `terminal_clients`
- `terminal_output_segments`
不要将 OS PID 作为 Agent Instance 的主键。
PID 可能复用，也可能因为进程恢复而发生变化。
### 5.3 数据职责
| 数据 | 存储位置 |
| --- | --- |
| 项目、Agent Instance | SQLite |
| Harness Session ID | SQLite |
| OS PID | Runtime Host + SQLite 快照 |
| PTY 实时句柄 | Runtime Host 内存 |
| tmux Session ID | SQLite |
| Terminal Client | 内存为主 |
| Terminal Sequence | SQLite + Runtime Host |
| 原始输出 | Ring Buffer + Durable Journal |
| Hook 事件 | 现有 Hook Event 体系 |
| 问题和审批 | 现有 Question / Messaging 体系 |
现有 Hook Event 仍然是结构化事件的事实来源，不要用终端输出替代它。
---
## 6. Terminal Gateway
这是整个改造的核心组件之一。
Dashboard、CLI 和外部终端都不应该直接连接 Agent 进程。
所有终端访问统一经过 Terminal Gateway。
### 6.1 主要职责
 1. 管理 Terminal Session。
 2. 绑定 Agent Instance。
 3. 接收 PTY 输出。
 4. 广播给多个客户端。
 5. 分配输出 Sequence。
 6. 提供历史输出重放。
 7. 管理输入控制权。
 8. 管理客户端连接状态。
 9. 协调终端尺寸。
10. 执行输出缓冲和背压。
### 6.2 建议模块
```
packages/weave-server/src/
  runtime/
    manager.ts
    supervisor.ts
    instance-registry.ts
    runtime-host-client.ts
    protocol.ts
  terminal/
    session-gateway.ts
    session-registry.ts
    session-broker.ts
    output-buffer.ts
    output-journal.ts
    input-router.ts
    client-registry.ts
    terminal-protocol.ts
  runtime/adapters/
    windows-pty.ts
    linux-pty.ts
    macos-pty.ts
    tmux.ts
```
以上为建议目录，不代表当前仓库已经存在这些文件。
### 6.3 Terminal Stream Protocol
终端数据必须作为字节流处理。
不能只保存普通字符串。
ANSI 控制序列、光标定位、颜色、全屏 TUI 都需要完整保留。
建议协议：
```
interface TerminalOutputEvent {
  instanceId: string;
  terminalSessionId: string;
  sequence: number;
  timestamp: number;
  encoding: "base64";
  data: string;
}
```
输入协议：
```
interface TerminalInputEvent {
  instanceId: string;
  clientId: string;
  inputLeaseId: string;
  data: string;
}
```
尺寸协议：
```
interface TerminalResizeEvent {
  instanceId: string;
  cols: number;
  rows: number;
  clientId: string;
}
```
所有输出按 Instance 维持单调递增的 Sequence。
### 6.4 浏览器重连
客户端连接时：
```
interface TerminalAttachRequest {
  instanceId: string;
  lastSequence?: number;
  cols: number;
  rows: number;
  mode: "readonly" | "interactive";
}
```
服务端：
1. 验证用户权限。
2. 验证 Instance 存在。
3. 返回当前 Sequence。
4. 重放缺失输出。
5. 切换实时输出订阅。
6. 根据权限决定是否允许输入。
如果历史输出不完整，需要返回明确的 Gap 标记，不能假装已经完整恢复。
### 6.5 输出恢复策略
建议三层存储：
**第一层：Ring Buffer**
保存最近一段终端字节流。
作用：快速恢复浏览器连接。
**第二层：Durable Output Journal**
将输出按时间或大小分段写入磁盘。
作用：长期追溯和历史查看。
**第三层：Terminal Checkpoint**
周期性保存终端模拟器状态或屏幕快照。
作用：降低恢复时需要重放的字节数量。
重要：仅保存普通文本无法完整恢复 TUI 画面。需要保留原始字节流、尺寸变化事件，以及可选的终端状态快照。
---
## 7. Dashboard Web Terminal
### 7.1 技术选择
建议使用 xterm.js。
xterm.js 是浏览器端终端模拟器，不是 PTY Backend。
它负责：
- ANSI 渲染。
- 光标控制。
- 颜色和字体。
- 键盘输入。
- 滚动。
- 终端尺寸。
- 全屏 TUI。
- 粘贴和快捷键。
PTY 仍然由 Runtime Host 管理。
### 7.2 Dashboard 交互结构
建议一个 Agent Terminal 页面包含三个区域：
```
+-------------------------------------------------------+
| Agent: Claude Code      Running     CPU 12%   Memory  |
+-------------------------------------------------------+
|                                                       |
|                                                       |
|                 xterm.js Terminal                    |
|                                                       |
|                                                       |
+-------------------------------------------------------+
| Input / Approval / Interrupt / Attach                 |
+-------------------------------------------------------+
| Events | Messages | Questions | Logs | Resources      |
+-------------------------------------------------------+
```
### 7.3 两种终端展示模式
**Terminal Mode**
完全终端体验：
- 原始 ANSI 输出。
- 键盘输入。
- TUI。
- 滚动。
- 全屏程序。
- 终端尺寸控制。
**Workbench Mode**
终端与 Agent 管理结合：
- 当前 Agent 状态。
- 当前任务。
- Hook 事件。
- Agent 消息。
- 审批问题。
- CPU / Memory。
- 文件变更。
- 中断和重试。
Workbench 的结构化信息来自现有事件系统，不要通过解析终端文本生成状态。
### 7.4 多终端管理
不要一次性在 Dashboard 渲染 40 个完整 xterm.js 实例。
建议：
- Agent Overview 展示轻量状态。
- 只有选中的 Agent 创建完整终端模拟器。
- 最近访问的终端可以保留短期缓存。
- 非活跃终端降低 UI 更新频率。
- 多 Agent 输出由 Gateway 统一接收和缓冲。
- 每个终端限制最大 Scrollback。
- 页面切换不影响 Agent 进程。
### 7.5 前端建议目录
```
packages/weave-server/src/
  web/
    features/
      terminal/
        TerminalView.tsx
        TerminalToolbar.tsx
        TerminalTabs.tsx
        TerminalConnection.ts
        useTerminal.ts
      workbench/
        AgentOverview.tsx
        AgentWorkspace.tsx
        AgentStatus.tsx
        AgentEvents.tsx
        AgentQuestions.tsx
        AgentResources.tsx
```
---
## 8. Headless / Dashboard / External Attach
三个入口共享同一个 Instance。
### 8.1 Headless Mode
运行方式：
```
weave agent start --harness claude --headless
```
特点：
- 不打开终端窗口。
- Runtime Host 持有 Agent 进程。
- PTY 输出进入 Terminal Gateway。
- Dashboard 可以随时连接。
- 浏览器关闭不影响 Agent。
### 8.2 Dashboard Mode
用户在 Dashboard 创建 Agent。
```
Dashboard
   |
   v
Agent Instance
   |
   v
Runtime Host
   |
   v
PTY
   |
   v
Terminal Gateway
   |
   v
xterm.js
```
Dashboard 关闭后，PTY 和 Agent 继续运行。
### 8.3 External Attach Mode
用户可以通过 CLI：
```
weave agent attach <instance-id>
```
也可以：
```
weave agent attach <instance-id> --readonly
```
Windows 可以通过 Weave CLI Attach Client 连接 Terminal Gateway。
也可以由 Weave 调用 Windows Terminal 打开 Attach Client。
不要尝试让另一个普通终端程序直接接管 Windows ConPTY 的原始句柄。
Windows ConPTY 的跨客户端访问应由 Terminal Bridge 实现。
Linux、WSL2 和 macOS 可以结合 tmux 实现原生 Attach。
### 8.4 同一 Instance 的多客户端
```
                 Agent Instance
                       |
                      PTY
                       |
                Terminal Gateway
                  /     |      \
                 /      |       \
           Dashboard   CLI    External
```
多个客户端可以只读查看。
默认只允许一个客户端拥有输入控制权。
---
## 9. 多客户端输入仲裁
多个客户端同时写入同一个终端可能造成输入乱序。
必须设计 Input Lease。
### 9.1 控制权机制
每个 Terminal Session：
- 多个 Read-only Client。
- 最多一个 Write Client。
- Write Client 持有 Lease。
- Lease 定期 Heartbeat。
- 超时后释放控制权。
- 其他用户可申请接管。
### 9.2 接口
```
interface InputLease {
  instanceId: string;
  clientId: string;
  leaseId: string;
  expiresAt: number;
}
```
建议操作：
```
request_control
grant_control
heartbeat
release_control
take_control
```
### 9.3 尺寸控制
终端尺寸是共享资源。
建议默认由 Write Client 决定 cols / rows。
Read-only Client 不应随意改变 PTY 尺寸。
如果 Dashboard 和外部终端同时查看，可以采用固定逻辑尺寸，并允许用户显式切换控制端。
---
## 10. 跨平台 Runtime 实现
### 10.1 Windows
推荐路线：
- Windows 原生 PTY：ConPTY。
- Node 接入：先验证 node-pty。
- Runtime Host 独立运行。
- 使用 Job Objects 或可靠的 Supervisor 策略管理子进程。
- Dashboard 和 CLI 通过 Terminal Gateway 连接。
需要验证：
 1. Node.js 22.5+。
 2. pnpm Workspace。
 3. Windows x64。
 4. Windows ARM64。
 5. 原生模块安装和加载。
 6. npm 自包含发布包。
 7. 全新机器安装。
 8. Runtime Host 崩溃恢复。
 9. 子进程生命周期。
10. 安装和升级。
不能在验证前假定 node-pty 已满足 Weave 的发布和部署约束。
### 10.2 WSL2
推荐使用 tmux 作为第一优先级的持久终端后端。
例如：
```
tmux new-session -d -s weave-agent-001
tmux send-keys -t weave-agent-001 "claude" Enter
tmux capture-pane -p -t weave-agent-001
tmux attach -t weave-agent-001
```
正式实现需要考虑：
- Session 命名规则。
- Pane ID。
- Session 生命周期。
- 多客户端 Attach。
- 输出采集。
- 输入控制权。
- tmux 断开和重连。
- WSL 发行版关闭后的恢复策略。
### 10.3 Linux
提供两种模式：
- Native PTY。
- tmux Persistent Session。
### 10.4 macOS
第一阶段可以使用 Native PTY。
tmux 作为可选持久化后端。
### 10.5 跨平台能力矩阵
| 能力 | Windows | WSL2 | Linux | macOS |
| --- | --- | --- | --- | --- |
| Headless | ConPTY | tmux / PTY | PTY | PTY |
| Dashboard Terminal | 支持 | 支持 | 支持 | 支持 |
| External Attach | Weave CLI | tmux / CLI | tmux / CLI | CLI / tmux |
| Daemon 重启恢复 | Runtime Host | tmux | tmux 可选 | PTY / tmux |
| PTY 持久性 | Supervisor 设计 | tmux | tmux 可选 | tmux 可选 |
| 多客户端 | Gateway | tmux / Gateway | Gateway | Gateway |
统一的是 API、协议和体验，不是底层终端技术。
---
## 11. Session Persistence 与恢复
必须明确区分三种情况。
### 11.1 浏览器关闭
预期行为：
- Agent 继续运行。
- Runtime Host 继续持有 PTY。
- Gateway 继续接收输出。
- Ring Buffer 继续更新。
- Durable Journal 继续记录。
重新打开 Dashboard：
- 重新连接 Instance。
- 获取 Last Sequence。
- 重放历史输出。
- 继续实时订阅。
### 11.2 Daemon 重启
预期行为：
- Runtime Host 不退出。
- Agent 进程不退出。
- PTY 不释放。
- Daemon 重启后重新连接 Host。
- 恢复 Instance Registry。
- 恢复 Terminal Gateway。
### 11.3 Runtime Host 崩溃
不能保证所有平台上的 PTY 句柄都可以无损恢复。
应区分：
- Agent 子进程仍然存活。
- Agent 子进程已经退出。
- tmux Session 仍然存在。
- PTY 已经失效。
- Harness Session 可以恢复。
恢复时：
1. 检查 Runtime Host。
2. 检查 OS Process。
3. 检查 tmux Session。
4. 检查 Harness Session。
5. 恢复可恢复的 Instance。
6. 无法恢复时标记为 `recovering` 或 `failed`。
7. 由用户确认是否启动新的恢复实例。
禁止盲目重新启动 Agent，避免重复执行任务。
### 11.4 系统重启
系统重启后，原来的 OS 进程通常已经不存在。
不能承诺原进程继续执行。
应通过：
- Weave Instance 元数据。
- Harness 原生 Session Resume。
- Terminal Output Journal。
- Hook Event 历史。
- 工作目录和 Git 状态。
实现可追溯、可恢复的工作流。
**会话不丢失的定义：运行中断线可重新连接，历史输出可追溯，Harness 支持的会话可以恢复；不代表系统重启后原 OS 进程仍然存活。**
---
## 12. 与现有 Weave 能力集成
### 12.1 TerminalBackend
保留现有 TerminalBackend。
继续负责：
- 打开外部终端。
- 寻找已有窗口和 Pane。
- 发送按键。
- 读取屏幕。
- 关闭 Pane。
- 唤出或隐藏终端窗口。
但逐步将其定位为 Terminal Presentation，而不是 Agent Runtime。
### 12.2 Inbox Socket
保留现有 Claude Inbox Socket。
普通 Prompt 继续优先使用 Inbox Socket 投递。
不要因为新增 PTY 就将所有 Prompt 重新改为终端键盘注入。
### 12.3 Harness Adapter
Claude Code 和 Codex 的协议差异应保留在各自 Harness Adapter 内。
需要统一的能力包括：
```
interface HarnessCapabilities {
  supportsResume: boolean;
  supportsStructuredEvents: boolean;
  supportsNativePromptDelivery: boolean;
  supportsApprovalEvents: boolean;
  supportsInterrupt: boolean;
  supportsSessionDiscovery: boolean;
}
```
实际能力应通过适配器声明，不能假设所有 Harness 都支持同样的操作。
### 12.4 Questions / Approval
保留现有 QuestionTracker 和审批体系。
输入操作由 Runtime Input Surface 承接。
不要将 QuestionTracker 与 PTY Backend 耦合。
### 12.5 Interrupt
明确区分：
- Graceful Interrupt。
- Harness Native Interrupt。
- Ctrl+C。
- ESC。
- OS Process Termination。
强制终止应作为最后手段。
---
## 13. 性能设计
### 13.1 目标
支持 20～40 个 Agent Instance 并行存在。
但不要求 40 个 Agent 同时高强度运行。
应区分：
- Running。
- Waiting Input。
- Waiting Approval。
- Idle。
- Background。
- Exited。
等待审批的 Agent 不应该占用活动执行槽。
### 13.2 终端输出优化
1. 每个 Instance 独立 Ring Buffer。
2. 限制单个 Agent 缓冲大小。
3. 输出批量发送。
4. 使用背压机制。
5. 非活跃终端降低刷新频率。
6. 历史日志分段压缩。
7. Dashboard 只渲染活跃终端。
8. WebSocket 断开不影响 Agent。
9. 输出写入失败不能阻塞 PTY 主循环。
### 13.3 资源管理
> **现状（2026-11-21 标注）**：资源监控 v1 已落地（`daemon/metrics-sampler.ts`）——daemon 与 Runtime Host 零开销自采（10s，Host 走 `resource.updated` IPC 事件自报）、Agent 进程 60s 一枪批量查 pid（Windows = PowerShell、POSIX = /proc，仅有人看时才打；2026-11-21 用户裁决 60s 粒度）、每实例 PTY 吞吐、1 小时历史环形；帧 = 既有 SSE 通道 `metrics.snapshot`，Dashboard 头部资源卡渲染。WS 延迟 / Dashboard 渲染耗时与 §6.5 的 Durable Output Journal / Terminal Checkpoint 仍未实现；§13.2 已落地 = 双层 ring（Host 512KB + Gateway 256 条）、背压/gap 帧、非阻塞写、Input Lease、Dashboard 只渲染选中实例（分段压缩 / 批量发送 / 非活跃降刷新未做）。
建议先从 8～12 个活跃 Agent 开始测试，再逐步提高并行数。
这是初始压测策略，不是固定的系统上限。
需要统计：
- Agent CPU。
- Agent Memory。
- Runtime Host CPU。
- Runtime Host Memory。
- PTY 输出吞吐。
- Dashboard 渲染耗时。
- WebSocket 延迟。
- Output Journal 写入延迟。
### 13.4 Git Worktree
每个具备独立写入能力的 Agent，原则上使用独立 Git Worktree。
避免多个 Agent 同时修改同一个工作目录。
---
## 14. 安全设计
Runtime Host 可以执行真实 Shell 命令，因此属于高权限组件。
必须建立安全边界。
### 14.1 命令启动
不能允许 Dashboard 直接传入任意命令并立即执行。
建议：
- 只允许从注册的 Agent Definition 启动。
- executable 白名单或受控配置。
- 校验工作目录。
- 校验参数。
- 限制环境变量。
- 明确 Shell 启动策略。
- 危险操作需要审批。
### 14.2 Terminal 输入
输入控制权需要授权。
不能因为客户端能够读取终端，就自动允许它写入终端。
### 14.3 IPC
Runtime Host IPC 必须验证身份。
不能只依靠本地 Socket 路径作为安全机制。
### 14.4 LAN
Dashboard LAN 访问需要：
- 身份认证。
- 权限控制。
- TLS 或可信网络保护。
- 输入操作审计。
- 敏感环境变量保护。
---
## 15. 实施计划
建议分阶段交付，不进行一次性大规模重写。
### B0：Runtime 基础协议
目标：确定数据模型和架构边界。
任务：
- 定义 AgentInstance。
- 定义 RuntimeHost 协议。
- 定义 TerminalSession。
- 定义 Terminal Stream Protocol。
- 定义状态机。
- 定义 SQLite Migration。
- 定义 Harness Capability。
验收：
- 类型和接口确定。
- 不破坏现有 Session。
- 不影响现有 Daemon。
- 不影响现有 WezTerm Backend。
### B1：Windows Runtime Host
目标：在 Windows 上实现脱离终端窗口运行。
任务：
- Runtime Host 子进程。
- Windows PTY PoC。
- Agent Process Lifecycle。
- stdout/stderr 读取。
- stdin 输入。
- 退出码。
- Heartbeat。
- Daemon 重连。
验收：
- 不打开 WezTerm 也能启动 Agent。
- 浏览器关闭后 Agent 继续运行。
- Daemon 重启后 Agent 继续运行。
- Runtime Host 可以查询 Instance。
- 能正确处理进程退出。
### B2：WSL2 tmux Adapter
目标：实现持久化终端会话。
任务：
- tmux Session Manager。
- Session Registry。
- Pane Discovery。
- 输入和输出。
- Attach / Detach。
- tmux 状态对账。
验收：
- WSL2 中可以创建 Headless Agent。
- 可以在 Dashboard 中访问。
- 可以使用 tmux Attach。
- 多客户端可以查看同一个 Session。
### B3：Terminal Gateway
目标：统一所有终端访问。
任务：
- WebSocket。
- Output Ring Buffer。
- Sequence。
- Output Journal。
- 历史重放。
- Input Lease。
- 多客户端管理。
- Resize 管理。
- 背压。
验收：
- 输出不依赖浏览器连接。
- 浏览器重连可以恢复输出。
- 多客户端输入不会无序写入。
- 能检测历史输出缺口。
### B4：Dashboard Web Terminal
目标：Dashboard 完整替代常规终端查看和交互。
任务：
- 引入 xterm.js。
- Terminal View。
- Terminal Toolbar。
- Terminal Tabs。
- 终端连接管理。
- Workbench 布局。
- 结构化事件面板。
- Questions / Approval 集成。
验收：
- Claude Code 可在 Dashboard 内交互。
- Codex 可在 Dashboard 内交互。
- ANSI 和 TUI 正常显示。
- 浏览器关闭后 Agent 不退出。
- 重新进入页面可以恢复会话。
### B5：External Attach
目标：Dashboard 和外部终端共享同一个 Agent。
任务：
- `weave agent attach`。
- Read-only Attach。
- Write Lease。
- Take Control。
- Windows Terminal 启动集成。
- WezTerm 兼容。
- tmux Attach。
验收：
- Dashboard 和外部终端访问同一个 Instance。
- 不重复启动 Agent。
- 输入控制权明确。
- 外部终端退出不影响 Agent。
### B6：完整跨平台与稳定性
目标：完善 Linux、macOS 和长时间运行能力。
任务：
- Linux Native PTY。
- macOS Native PTY。
- Runtime Host Supervisor。
- 系统重启后的恢复向导。
- 长时间运行压力测试。
- 资源管理。
- 故障注入。
- 安装包和发布验证。
验收：
- 各平台使用统一 Runtime API。
- 运行状态可以恢复或明确标记不可恢复。
- 20～40 个 Agent Instance 管理稳定。
- 资源使用可观测。
---
## 16. 测试与验收标准
### 16.1 生命周期测试
- 启动 Agent。
- 停止 Agent。
- 强制终止 Agent。
- Agent 自然退出。
- Daemon 重启。
- Runtime Host 重启。
- 浏览器关闭。
- 浏览器刷新。
- 网络断开。
- 网络恢复。
### 16.2 终端兼容性
测试：
- ANSI Color。
- 光标定位。
- 进度条。
- 多行输出。
- 输入历史。
- 粘贴。
- Ctrl+C。
- ESC。
- 全屏 TUI。
- 终端尺寸变化。
- 长时间输出。
### 16.3 并发测试
测试：
- 10 个 Agent。
- 20 个 Agent。
- 40 个 Agent。
- 多个 Dashboard Client。
- 多个只读 Attach。
- 多个输入控制权申请。
- 大量输出同时到达。
- 输出客户端背压。
### 16.4 恢复测试
必须验证：
1. 浏览器关闭，Agent 继续运行。
2. Daemon 重启，Agent 继续运行。
3. Runtime Host 故障时，不发生重复启动。
4. tmux Session 存在时，可以重新 Attach。
5. PTY 不可恢复时，状态能够准确反映。
6. 系统重启后能够查询历史和 Harness Resume 能力。
### 16.5 发布测试
- Node 版本兼容。
- Windows 原生模块安装。
- pnpm Workspace。
- npm 自包含包。
- Windows x64。
- Windows ARM64。
- Linux。
- macOS。
- 干净机器安装。
- 升级和卸载。
---
## 17. 最终产品形态
建议将 Weave Dashboard 逐步演化为三个核心界面。
### 17.1 Agent Overview
统一查看所有 Agent：
- Agent 状态。
- Harness 类型。
- 当前任务。
- CPU / Memory。
- 所属项目。
- 当前工作目录。
- 是否等待审批。
- 是否正在运行。
### 17.2 Agent Terminal
查看单个 Agent 的完整终端：
- 原始终端输出。
- ANSI / TUI。
- 输入。
- 中断。
- Attach。
- 输出历史。
- 连接状态。
### 17.3 Agent Workspace
围绕 Agent 展开完整工作空间：
- Terminal。
- Tasks。
- Messages。
- Questions。
- Approvals。
- Hooks。
- File Changes。
- Git。
- Resources。
---
## 18. 关键技术决策
| 问题 | 建议决策 |
| --- | --- |
| 是否必须打开终端窗口 | 否，支持 Headless |
| Dashboard 是否可以直接交互 | 可以，使用 xterm.js |
| Dashboard 是否管理 Agent 进程 | 否，由 Runtime Host 管理 |
| 是否保留 WezTerm | 保留，作为外部终端适配器 |
| 是否引入 node-pty | Windows PoC 优先验证 |
| WSL2 使用什么 | 优先 tmux |
| 是否支持多客户端 | 支持，多读一写 |
| 是否允许浏览器关闭后继续运行 | 必须支持 |
| Daemon 重启是否保留 Agent | 必须支持 |
| 系统重启是否保证原进程恢复 | 不保证，依靠 Harness Resume 和恢复流程 |
| 是否保存原始终端输出 | 是，字节流 + Sequence |
| 是否保存结构化 Agent 事件 | 复用现有 Hook / Question / Messaging |
| 是否重写现有 TerminalBackend | 不重写，逐步明确职责 |
| 是否新建第二套 Orchestrator | 不建议 |
---
## 19. 开放问题与实施前验证
以下问题需要通过 PoC 和源码审查确定，不能直接假设已有实现满足要求：
 1. node-pty 与当前 Node.js 版本和自包含发布策略的兼容性。
 2. Windows Runtime Host 崩溃时，Agent 子进程的存活和恢复策略。
 3. Windows ConPTY 的尺寸、输入和输出控制边界。
 4. Claude Code 和 Codex 的非交互启动参数、会话恢复和输入能力。
 5. Codex 的原生会话恢复是否能满足目标交互模式。
 6. tmux 输出捕获和原始 PTY 字节流之间的差异。
 7. Terminal Journal 的存储格式、轮转和磁盘限额。
 8. 服务端终端状态快照的实现方式。
 9. Dashboard 多终端同时渲染的性能上限。
10. LAN 访问下的 Terminal Input 权限和审计策略。
---
## 20. 最终建议
Weave 不应该继续以“一个 Agent 对应一个外部终端窗口”为核心模型。
应该转变为：
**一个 Agent Instance，由 Runtime Host 管理；一个 Terminal Session，由 Terminal Gateway 管理；多个客户端可以访问同一个 Session。**
这会带来三个重要变化：
1. Agent 可以完全脱离终端窗口运行。
2. Dashboard 可以成为主要交互入口，而不是单纯的监控面板。
3. 外部终端成为可选的 Attach 客户端，而不是 Agent 的运行依赖。
最终架构：
```
                Weave Dashboard
                       |
                 Terminal Gateway
                       |
                  Agent Instance
                       |
                  Runtime Host
                       |
                    PTY
                       |
                 Claude / Codex
                       |
             External Attach Clients
                       |
                Weave CLI / tmux
```
实施优先级：
**先解决 Agent 进程生命周期，再解决终端数据通道，最后建设 Dashboard 交互体验。**
不要先做漂亮的 Web Terminal，再回头解决 Agent 运行和恢复问题。
最重要的架构约束：
- Agent 不能依赖浏览器存活。
- Agent 不能依赖外部 GUI 终端存活。
- Daemon 不应该直接拥有所有 Agent 的 PTY 生命周期。
- Terminal 输出与结构化 Agent Event 必须分离。
- 所有客户端必须访问同一个 Agent Instance。
- 所有跨平台实现必须遵循统一 Runtime 和 Terminal Protocol。
这套方案应当作为 Weave 下一阶段 Agent Runtime 改造的技术基准。