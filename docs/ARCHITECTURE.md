# weave 架构总览

> 本文是**当前态**架构速览，四图走完：包分层 → 能力槽装配 → 运行时拓扑 → 工具对象模型与资源三层。
> 行为硬约束见仓库 `CLAUDE.md` 的 Architecture 节；各改造批次的拍板与实施记录在 `docs/plan/`（总纲：`template-method-harness-refactor.md`）。
> 图随代码演进：改架构须同步改图。

## 一、包结构与依赖

```mermaid
flowchart TD
  subgraph core["@weavecode/core · 纯类型与表（零接口，防环）"]
    H1["src/harness.ts<br/>Harness 名单表 · HARNESS_EVENTS / DIRS /<br/>LIFECYCLE / INSTRUCTION_FILES（加 harness = 表加一项）"]
    H2["src/tool.ts<br/>ToolScope · EnableOverride · ToolStateRow<br/>（工具对象模型的行形状）"]
  end

  subgraph hpkg["@weavecode/harness · 抽象定义的家"]
    D1["driver.ts ★槽清单唯一权威<br/>9 能力槽接口 + HarnessDriver<br/>+ HarnessRegistry（先到先得）"]
    D2["init/pipeline.ts<br/>InitPipeline（模板方法①）"]
    D3["registry-wiring.ts<br/>HARNESS_DRIVERS 总表<br/>+ createRuntimeRegistry"]
    subgraph CL["claude/ · 8 槽实现"]
      C1["assets · events · resume · detect ·<br/>plugins · pluginState · messaging · capture"]
    end
    subgraph CX["codex/ · 4 槽实现"]
      X1["assets · detect · pluginState · messaging<br/>（events / resume / plugins 无对等物，永不注册）"]
    end
  end

  subgraph spkg["@weavecode/server"]
    S1["daemon/ · server.ts HTTP+SSE · opener.ts<br/>TerminalBackend（模板方法②）"]
    S2["hooks/ · pipeline + 无头核<br/>（resume / headless / message-deliverer）"]
    S3["install/ · capabilities 能力矩阵唯一事实源<br/>market/ · identity（marketIdOf）"]
    S4["repositories/ · node:sqlite"]
    subgraph WEB["web/ · React dashboard"]
      W1["lib/sse.ts ★唯一 EventSource"]
      W2["通用控件 · McpGrid / SkillGrid PackBlock<br/>三态循环 · GROUP_VIEW_SCOPES 摆放"]
    end
  end

  subgraph clipkg["@weavecode/cli"]
    K1["commands/ · init / scan / status …"]
    K2["init/wiring.ts ★init 槽装配点<br/>（unregister 后携带 init 重注册）"]
  end

  subgraph tpl["@weavecode/templates"]
    T1["内置资源 weave-market<br/>（core-skills 插件包）+ TemplateRegistry"]
  end

  subgraph umbrella["@weavecode/weave · 伞包"]
    U1["bundle 聚合发布"]
  end

  hpkg -->|"唯一外向依赖"| core
  spkg --> core
  spkg --> hpkg
  spkg --> tpl
  clipkg --> core
  clipkg --> hpkg
  clipkg --> spkg
  clipkg --> tpl
  tpl --> core
  umbrella --> clipkg & core & hpkg & spkg & tpl
  WEB -.->|"仅 import type（paths + vite alias 源码直引）"| core
  WEB -.->|"仅 import type"| hpkg
```

要点：

- **core 只有纯类型与表**（`HARNESS_*` 注册表），接口不进 core（会与 harness 成环）。
- **`harness → core` 是 harness 唯一外向依赖**；server/cli 只做装配编排，不写 harness 硬编码。
- **web 仅 `import type` 引用 core/harness**——tsconfig paths + vite alias 直引源码，运行时零依赖。
- 抽象类全仓仅两处、皆为模板方法：`InitPipeline`（harness，固定 init 骨架）与 `TerminalBackend`（server/daemon/opener.ts，固定「取候选 → 按序尝试 → 全失败抛真相」；wezterm 覆写 `run` 走 mux；`settings → 后端` 唯一入口 = `terminalBackendFor`）。

## 二、能力槽装配

```mermaid
flowchart LR
  CD["CLAUDE_DRIVER<br/>（claude/index.ts）"]
  XD["CODEX_DRIVER<br/>（codex/index.ts）"]
  KD["init 模板<br/>weave-cli/init/harnesses/"]
  W["registry-wiring<br/>HARNESS_DRIVERS 总表"]
  R[("HarnessRegistry<br/>register → disposer<br/>byCapability 检索")]
  SF["server surfaces.ts<br/>薄委托（*SurfaceFor / *Surfaces）"]
  CLI["cli 消费方<br/>init / scan / status"]
  WEB["web<br/>只渲染不解析"]

  CD & XD --> W --> R
  KD -->|"unregister + 携带 init 重注册"| R
  R --> SF
  R --> CLI
  SF -->|"能力矩阵 + REST"| WEB
```

| 能力槽（`HarnessCapability`） | claude | codex | 主要消费面 |
|---|:---:|:---:|---|
| `init` | ✅（模板在 cli 半球） | ✅ | `weave init` |
| `events` | ✅ | ❌ 永不注册 | hooks adapter（事件采集） |
| `assets` | ✅ | ✅ | file-assets / 安装能力矩阵 |
| `resume` | ✅ | ❌（unsupported 先例） | open-terminal / 无头回合 |
| `detect` | ✅ | ✅ | scan / status 标记识别 |
| `plugins` | ✅ | ❌ | 插件包安装 / 市场维护 |
| `pluginState` | ✅ | ✅ | `/plugins/state` 三档覆写 |
| `messaging` | ✅ | 注册显式不支持面（全 null + reasons） | 消息投递裁决 |
| `capture` | ✅ | —（未注册） | user 档事件采集 |

要点：

- 槽清单**唯一权威** = `weave-harness/src/driver.ts` 的 `HarnessCapability`；server/cli/web 不自造槽清单（本表随代码走）。
- 「不支持也是面」：messaging 对 codex 同样注册——全 null + `unsupportedReasons`，「为什么置灰」必须可渲染。
- 加第三 harness = `weave-harness/src/<name>/` 一个目录 + core 名单表一项 + `HARNESS_DRIVERS` 一行 +（若需 init 面）cli 一个模板文件。

## 三、运行时拓扑

```mermaid
flowchart TD
  CC["claude 宿主进程<br/>（hooks 经 capture 组上报）"]
  CX2["codex 宿主进程"]
  subgraph daemon["@weavecode/server · daemon"]
    HP["hooks pipeline<br/>adapter → dispatcher → sqlite mirror<br/>→ watch-engine（空闲订阅）→ inbox / sweeper"]
    SSE["handleSse ★GET /events 单通道<br/>帧域 asset / project / hook + push / invalidate"]
    REF["隐藏刷新器（terminal-counts 形状）<br/>有 SSE 客户端才探 · 变化才推"]
    MSG["message-deliverer 裁决表<br/>inject（忙排 outbox）｜headless（闲投 resume）"]
    AUTH["认证门 · deps.auth<br/>密码 / 会话 cookie / x-weave-local 本机令牌<br/>（豁免 /health、/auth/*、HTML 与静态文件）"]
    OP["TerminalBackend 候选链<br/>（settings → terminalBackendFor）"]
    DB[("node:sqlite<br/>projects · sessions · hook_events<br/>session_messages · watches …")]
  end
  subgraph web["web dashboard（React）"]
    WSSE["lib/sse.ts 唯一 EventSource"]
    UI["面板 + 通用控件"]
  end
  subgraph dataDir["<dataDir> 数据目录"]
    MKT["market/&lt;id&gt;/ · 市场副本层"]
    OBX["hooks outbox（token 分片）"]
  end
  WEAVE["weave cli（HTTP 客户端）"]

  CC -->|"hook 事件"| HP
  CX2 -.->|"events 槽未开"| HP
  HP --> DB
  HP --> OBX
  OBX -->|"随下一拍 hook 送达"| CC
  HP <-->|"事件 → SSE 帧"| SSE
  REF --> SSE
  SSE -->|"data: {type,…}"| WSSE
  WSSE --> UI
  UI -->|"REST（api.ts，带会话 cookie）"| AUTH
  WEAVE -->|"REST（带本机令牌）"| AUTH
  AUTH -->|"放行 → 各路由"| HP
  MSG -->|"headless spawn 宿主 CLI"| CC
  OP -->|"开终端窗口"| CC
  OP -->|"开终端窗口"| CX2
  MKT --- HP
```

要点：

- **SSE 单通道**：dashboard ↔ 服务端只有 `GET /events` 一条事件流；无事件源的数据（终端窗口数、会话存活）由后端隐藏刷新器补，前端不得 `new EventSource`、不得轮询。
- **inject 回程**：消息投递的 inject 通道写 outbox，随目标会话下一拍 hook 送达（非抢占）；headless 通道走共享无头核（与 resume dispatch 同实例 = 同会话并发闸跨域生效）。
- **市场身份判据**唯一实现 = `server/market/identity.ts` 的 `marketIdOf`；插件注册键形 `<name>@<marketplace>` 唯一拼装点 = `PluginSurface.pluginKey`。
- **认证门**：`deps.auth`（`daemon/dashboard-auth.ts`）装在 `handleRequest` 最前——会话 cookie（浏览器）/ 本机令牌（CLI 与 hooks）二者认一；改密只走 CLI（本机令牌），web 无改密入口，401 一律回登录页。**绑定**：settings `server.bindHost` 默认 `0.0.0.0`（局域网可达，由上面的认证兜底），CLI 客户端仍连 `127.0.0.1`（`DAEMON_HOST` 与 bindHost 是两个概念）。

## 四、工具对象模型与资源三层

```mermaid
flowchart LR
  subgraph model["ToolStateRow（core/tool.ts）· 每 (harness, key, scope) 一行"]
    ROW["installScopes 可装档位 · install<br/>enable: on/off/inherit（null = 无启停语义）<br/>effective = 链 local &gt; project &gt; user 回落解析"]
  end
  API["GET / PUT /plugins/state<br/>PUT 校验与 GET 装配同分支：<br/>安装面三档三态 · 仅启用面（codex）user on/off"]
  subgraph webCtl["web 通用控件（harness 无关）"]
    CYC["循环钮 nextStateOf 按行判据<br/>（installScopes.length，与 server PUT 同分支）"]
    POS["GROUP_VIEW_SCOPES 摆放元数据<br/>global: user 档 · project: project+local 档"]
  end
  subgraph layers["资源三层模型（互不越级）"]
    L1["①市场副本层 · market/&lt;id&gt;/ 导入/移除"]
    L2["②安装/卸载层 · 数据目录 → 目标位（skills/files/MCP/插件包）"]
    L3["③启停层 · Switch / settings 落盘"]
  end

  CYC --> API
  POS --> CYC
  API --> ROW
  L1 ~~~ L2 ~~~ L3
```

要点：

- 工具对象模型：不同 harness 的工具功能统一为**行**的形状，前端按行自带的 `installScopes` / `enable` 判据渲染安装与启停，不点名 harness。
- 三层资源操作互不越级：删市场副本 ≠ 卸载，停用 ≠ 卸载；装/卸走能力面（`PluginSurface.uninstall` 等），server 只传语义参数。
