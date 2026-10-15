# weave

> This file is managed by [weave](https://github.com/zijing66/weave) — a coding-agent harness.
> Re-run `weave init` to regenerate.

<!-- weave:start -->
## 行为准则

- 遵循本项目既有的代码约定与模式
- 优先改既有文件，不要新建
- 不为任务之外的东西加功能、做重构或引入抽象
- 三行相似代码好过一处过早抽象
- 除非「为什么」不明显，否则不写注释
- 代码里绝不写多段解释
- 不为不可能发生的状态加错误处理

## 文件组织

- 源码：`src/`
- 测试：与源文件同目录的 `*.test.ts` 或 `__tests__/` 目录
- 配置文件放项目根目录
- 沿用既有目录结构——不要新造顶层目录

## 技能

可复用技能放 harness 自己的技能目录（Claude Code 为 `.claude/skills/`）：一个技能一个目录、内含 `SKILL.md`；任务命中某个技能时按名调用。

## weave 注入的消息

以 `[weave] ` 开头的用户消息来自 weave 控制台的直投，不是坐在终端前的人手打的：

- 去掉该标记后的全文就是完整指令，**照它执行**；
- 不要把标记当内容复述，也不必就这条消息回话（这条路径没有回复面）；
- **只有直投这一条路径带标记**：中继、终端兜底、注入三条路径的投递都不带——所以「没有标记」不等于「用户手打」，别据此判断来源。

<!-- weave:end -->

<!-- 以下节写在标记块外：weave init 只按 weave:start/end 合并标记块，块外人工内容 append-only 保留（packages/weave-cli/src/init/claudemd-gen.ts mergeClaudeMd）。 -->

## Architecture

- 抽象类全仓**仅两处**、皆为模板方法：`InitPipeline`（`weave-harness/src/init/pipeline.ts`，经 `@weavecode/harness` 导出）固定 init 骨架；`TerminalBackend`（`packages/weave-server/src/daemon/opener.ts`）固定终端后端骨架「取候选 → 按序尝试 → 全失败抛真相」，子类只填候选与真正不同的流程（wezterm 覆写 `run` 走 mux），`settings → 后端` 的唯一入口 = `terminalBackendFor`，「这个 preset 能不能反查已开窗口」归后端的 `enumerable`——调用方不得散写 preset 白名单。本条曾写作「不新增其他抽象类」，那是**过时描述**而非禁令；新增抽象类按需即可，但扩张前先与项目所有者确认。
- 九能力槽（init / events / assets / resume / detect / plugins / pluginState / messaging / capture）+ `HarnessRegistry` 统一装配；`driver.ts` 的 `HarnessCapability` 是能力槽唯一权威，server/cli/web 不自造槽清单。harness 专属实现各自落 `weave-harness/src/<name>/`（claude/、codex/），server/cli 只做装配编排，不写 harness 硬编码。
- **层①-a 会话本地收件箱直投**（claude 专属机制：inbox socket；其他 harness 的 `PromptInboxSpec` = null，server 完全不尝试）：hook 进程（会话自己的 child，继承 claude 导出的 `CLAUDE_CODE_MESSAGING_SOCKET`/`_TOKEN`）把凭据**旁路**上报（不进 payload/DB/UI，**纯内存**）→ 手动面（`oneWay`）消息走它直投（实测 86ms、零进程零 LLM）→ 失败即回落中继/终端/队列。**凭据每会话进程一份**（resume 后 socket 名重生成，旧值即废）→ **不持久化**；自愈靠「每次 hook 事件覆盖刷新」+「首次中继投递会把凭据带回来」。协议/键名归 claude adapter（`weave-harness/src/claude/prompt-inbox.ts`），server 只做通用传输（`hooks/inbox-socket.ts`）。协议出处非逆向：官方 `cross-session-messaging#the-sessions-inbox-socket`（明说该节用途含「让脚本或 hook 投递进会话」）+ CLI 自带配方。<br>
- **中继（SendMessage）为何保留**（用户问「web 端还需不需要」）：手动面已被 socket 取代（仅作回落），但它有三个 socket 结构上做不到的作用——①**来源语义**（目标看到 `Message from @weave`，Claude Code 认定「来自另一个会话」并施加跨会话限制；socket 是裸 user 文本 = 用户权威）；②**回复面**（唯一可能承载「编排保双向」的路径；今天因中继进程瞬时退出而只是理论，要做需改常驻 stream-json 长会话）；③**覆盖非 weave 会话 / 存量未升级 hook 的项目**。跨 harness 不是它的理由（codex 无 SendMessage，落层② 终端）。<br>
- **投递语义以官方契约为准**（`code.claude.com/docs/en/cross-session-messaging`）：中继 exit 0 只说明「已交给对方 Claude Code」——接收侧三态 Delivered/**Held**（暂扣待批）/**Refused**（静默丢）weave 从发送侧判不了，所以 `delivered` **不是「已读」**，UI 文案别写成已读；本机消息序列化超 ~100 万字符在**发送侧**拒收（我们 API 限 20k 远低于它）、同一会话快速连发也会被**发送侧**拒收 → `flushSession` 节流（一轮 ≤5 条、条间 ≥1s）；可达性验证走 `/status` 的 `Peer address` 与 `/list-agents`。<br>
- **中继启动开关（实测 2026-10-15，本机）**：`--strict-mcp-config --disable-slash-commands` 恒开——中继不用 MCP/skills，别为它拉一遍（实测仍能正确应答、工具白名单照旧）。**禁用 `--bare`**：它快 ~9×（38s→2.5s）但当版本下 `--tools` 白名单失效（实测中继跑去调 WebSearch 不投递）+ 只认 API key（OAuth 认证失败）——查到但不可用，别再试。<br>
- **消息/编排域**（设计全文 `docs/plan/session-orchestration.md`）：**消息域 = 纯递送管道，非记录系统**——消息唯一归宿是目标会话自己的转录，weave 仅投递前短暂持有（本地文件队列），送达即删、**不落任何 DB 行**（`session_messages` 表已退役，`fromKind` 概念随之删除）。`MessagingSurface`（messaging 槽）声明通道能力（发现 / prompt / inject / headless / watch idleSignals）与不支持原因，投递裁决唯一单点 = server 的 `MessageDeliverer`（404/409 语义拒绝；auto 忙→inject、绝无头抢占忙会话）；`GET /messaging/capabilities` 纯派生矩阵、无第二事实源——web 按钮与模式选项全表驱动，不写死 harness 白名单。触发源 ⊥ 投递通道：manual（dashboard 唯一人工面）、会话提醒订阅（`session_watches`：触发类型集 `on_events` = `idle`/`turnEnd`(`HARNESS_LIFECYCLE[<harness>].close`)/`messageFailed`，`remaining` = 剩余次数、NULL = 持久化、**已选类型共用一个计数**，命中走 `consumeHit` CAS、同一次转场的邻接事件 1s 内合并一次；`watch.fired` 帧带 `reason`）、序列各是「一张表 + 一个引擎」的加法模块，统一收敛到 `MessageDeliverer.send`，**不预抽 `TriggerSource` 统一接口**（三种以上触发源形态收敛后再议）。手动发送**无模式选项**（用户终局定案「默认就是 sendmessage+积压消息，降级时通过 terminal send-text」）：弹窗纯文本发送，路由无 `mode` 入参、恒走 prompt 通道按优先级自动完成，降级（层① 缺位 → 层②）也是全自动的——prompt 通道**三层投递**：层① 原生中继（claude SendMessage：`claude -p --no-session-persistence --tools SendMessage,ListAgents -n weave` + stdin，中性 cwd 防幽灵 hook、不入 peer 注册表；**中继 = 本轮次的一次性子进程**——`detached: false`（win32 shell 模式本就非 detached）、**不设超时**（等待发生在目标会话内）、daemon 退出经 `HeadlessRunner.killAll()` 回收在飞子进程（win32 taskkill /T /F、POSIX 进程组→单进程回退），三平台同一入口；peer 私有帧协议/命名管**不逆向不直连**；目标会话窗口可见 `Message from @weave: <原文>`、idle 立即唤醒、忙则下一 tool round 到达；**单向注入**——中继发完即退、无接收方会话，**手动面**投递载荷头部带「无需回复」注记（`oneWay` 由触发源定：手动路由 true、序列引擎缺省 false = 编排域双向对话保留；注记随 `oneWay` 落 promptbox 行；`PromptRelaySpec.instruction` 归 harness 规格，server 只传 peer 名 + 原文 + `oneWay`；注记是文本内引导非硬闸）；peer 注册表 `~/.claude/sessions/<pid>.json` 经 claude adapter 取 sessionId→name）→ 层② 终端 send-text 兜底（**无原生 peer 消息的 harness** 如 codex；**经 `TerminalBackend` 能力方法泛化**、不散写 wezterm——wezterm 实现（`cli list` 枚举 + `cli send-text`），Terminal.app/ghostty 按通道现实实现、没有就诚实不支持；pane↔会话映射 = 标题剥 ✳ spinner 前缀 + cwd 匹配、歧义拒绝不打；投递配方 = bracketed paste 打原文 + no-paste CR 提交）→ 层③ promptbox 队列（`<dataDir>/hooks/promptbox/<shard>.jsonl`，daemon 只写、与 handler 消费的 outbox 严格分离），冲洗双触发 = weave 项目会话 ingest 事件即时 + 隐藏刷新器只在队列非空时探（扫 peer 注册表与 pane 枚举，幂等）。prompt 门控 = 层① `MessagingSurface.prompt`（claude 有、codex null）**|| 层② 终端文本通道可用**（随 settings/机器变），能力矩阵两者皆无才置灰。inject（忙排，下一拍 additionalContext）/ headless（`promptStdin=true`：stdin 传 prompt、命令行无用户内容，win32 `.cmd` shim 由此可经 shell 安全启动，shell 模式禁 detached——实测该组合丢管道输出）/ auto（忙→inject 闲→headless）三模式保留为编排域显式选项，序列步另可选 `prompt`（完成判据 = idle 推进，同 inject 口径；步级前置校验按 mode 验对应通道，prompt 列 = 原生中继 ‖ 终端兜底，与能力矩阵同源派生）；headless 终态仅内存 + SSE、daemon 重启即丢。序列（`session_sequences`）表保留（编排状态非消息），步状态 = 引擎内存 + `sequence.*` 帧驱动，重启时在途步标 interrupted 不自动重发（在途 injected/delivered 续等 idle；未确认步同样不补 fire——避免重复 prompt）；hop 上限 = 步数 ≤3。实时刷新走既有 hook 帧域的 kind 扩展（`message.*` / `watch.fired` / `sequence.*`），无 invalidate 语义不扩 `DataKey`。**消息优先事件驱动**：会话行在途角标 = `push 'inflightCounts'` 绝对值快照（`InflightCountsRefresher` 无定时器——`message.*` 帧驱动重算、值变才推，新 SSE 客户端接入补首帧；**不在任何 GET 里带，web 不自算**），会话行的消息线程图标有在途消息即转 amber + 计数角标；提醒订阅 fire 的提醒 = 页面内 toast **＋** 浏览器通知（`web/src/lib/browser-notify.ts`，权限申请只在订阅手势处发起，拒绝则 toast 告知不静默），订阅弹窗（`web/src/components/tasks/WatchPicker.tsx`）选类型集 + 次数/持久化。**终态驻留 + 未回执闸（2026-10-15 定案）**：delivered/injected/succeeded 在 `settledAt`+60s 内留在在途视图展示 `via`/`acked`（failed/timeout/`stalled` 常驻；web 同口径本地隐藏，一次性重渲染非轮询）；prompt 送达 `ackStallMs`（缺省 120s）未回执、或中继/终端投递失败 → 该会话**队列冲洗暂停**（`flushSession` 闸，防继续向 Held/Refused 灌），成因消息标 `stalled` + `message.stalled` 帧；解除 = 成因消息回执命中（解闸 + 自续排空）或手动重发（`POST /sessions/:id/messages/:mid/resend`，仅 prompt 通道 failed / delivered-未回执 开放，重走三层并重新布防）。慢会话误伤暂停是接受过的代价——它处理到该 prompt 时 UPS 自解闸，真卡死人手重发。
- 依赖硬约束：`@weavecode/harness → @weavecode/core` 是唯一 harness 外向依赖；core 只放纯类型与表（`HARNESS_*` 注册表）。
- web（`packages/weave-server/web`）仅 `import type` 引用 core/harness（tsconfig paths + vite alias 源码直引）。
- 面向抽象与接口编程、避免硬编码：harness 专属格式/路径/键形不得在 server、cli、web 内自拼或散写，一律经能力面（`PluginSurface` / `AssetSurface` 等）取；server 只传语义参数（如「包名 + 市场身份」），harness 负责自己的表示法。
- 插件注册键形 `<name>@<marketplace>` 是 harness 知识，唯一拼装点 = `PluginSurface.pluginKey(name, market?)`（`weave-harness/src/driver.ts`）；server/cli 不自拼键形，web 只渲染不解析（`@` 后 = 所属市场 = 插件的 namespace）。
- 市场身份判据唯一实现 = `packages/weave-server/src/market/identity.ts` 的 `marketIdOf`（包在 `<dataDir>/market/<id>/` 下 → `name@<id>`，否则 weave 自建市场 `name@weave`）；scanner 与 toolkit 同源取用，不得各自实现。
- **SSE 单通道**：dashboard ↔ 服务端只有一条事件流 = `GET /events`（`packages/weave-server/src/daemon/server.ts` 的 `handleSse`），帧形 `data: {type: ...}`——`asset`/`project`/`hook` 是既有域；`push`（后端已算好载荷，前端直写状态）与 `invalidate`（只给 `key`，前端按 key 调既有 fetcher 重拉）是数据域，键表见 `daemon/data-bus.ts` 的 `DataKey`。前端唯一客户端 = `packages/weave-server/web/src/lib/sse.ts`，**不得再 `new EventSource`、不得写定时轮询**；无事件源的数据（终端窗口数、会话存活）由后端隐藏刷新器（形状同 `daemon/terminal-counts-refresher.ts`）只在值变化时推、且只在有 SSE 客户端时才探。
- **web 移动端适配**（`packages/weave-server/web`）：断点 `lg` 二分——桌面三栏原样保留，`<lg` 单列 + 左右栏滑出抽屉；桌面 inline 栏与移动抽屉复用同一 JSX 常量、`isDesktop` 互斥渲染（不双挂载/双请求），断点与指针查询唯一入口 = `web/src/lib/use-media-query.ts`。改/新增 web 布局的硬约束：①视口高度用 `dvh` 不用 `vh`；桌面向 `calc(100dvh-常量)` 的减数是桌面横排预算，`<lg` 上方堆叠更多内容必失真 → 窄屏改视口比例（事件链画布 `h-[52dvh]`）；②hover 才可见的操作按钮触屏不可达 → 补 `max-lg:opacity-100` 一类常显；③拖拽传感器按 `(pointer: fine)` 分流（鼠标 PointerSensor 位移 5px / 触屏 TouchSensor 长按 200ms 容差 8px），不裸用 PointerSensor；④固定宽列（列头/数据行）必须同构收缩（同一组 width 工具类），放不下的列折进行内第二行（`basis-full`）或 `hidden lg:block`，不做横向滚动；⑤纵向 flex 堆叠的下区要 `min-h-0` 才能收缩，否则被外层 `overflow-hidden` 裁掉。
- **dashboard 密码认证**（监听可放开的前提）：`daemon/dashboard-auth.ts` 的 `AuthService`——口令材料（scrypt hash / 会话签名密钥 / 本机令牌）落 `<dataDir>/auth.json`（0600），**不进 settings 表**（那是 UI 可读配置面，`GET /settings` 直出）；凭据三种 = 密码、无状态签名会话 cookie（`weave_session`，30 天，改密轮换密钥即全失效）、本机令牌 `x-weave-local`（CLI 与 hooks 免密——同机同用户可读 auth.json = 本机即管理员）。门在 `server.ts` 的 `handleRequest`（`deps.auth` 可注入，**缺省不装 = 开放**，存量测试口径），豁免 `/health`、`/auth/*` 与「HTML 导航 + 真实静态文件」（登录页必须未认证可载）；**改密只认本机令牌**（`PUT /auth/password` ← CLI `weave chpass <新密码>`），dashboard 不提供改密操作；web 侧 401 一律打回登录页、未登录干脆不建 SSE 连接（唯一认证态 store = `web/src/lib/auth.ts`）。首启随机初始密码写 `<dataDir>/initial-password`，由 CLI 领取一次即刻删除（daemon detached 启动，打印必丢）。监听绑定 = settings `server.bindHost`（默认 `0.0.0.0`，可改回 `127.0.0.1`）；**`DAEMON_HOST`（客户端连哪）与 bindHost（服务端听哪）是两个概念**，不得混用。
- **AI 助手**（dashboard 右下角浮层，配置齐才显示）：走**服务端代理**——web 只发会话历史，`daemon/ai-routes.ts` 按 OpenAI 兼容协议（`POST {baseUrl}/chat/completions`）带 key 转发并把增量转成自家 `{delta}/{done}/{error}` 帧；**api key 落 `<dataDir>/ai.json`（0600），与 auth.json 同口径——不进 UI 可读的 settings 表，只写不回显**（`PUT /settings` 的 `ai.apiKey` 是只写字段，GET/PUT 只回派生布尔 `apiKeySet`）；地址/模型在 settings 表 `ai.baseUrl`/`ai.model`。系统上下文由 `daemon/ai-context.ts` 装配三源（`docs/ARCHITECTURE.md` + `docs/FEATURES.md` + `<dataDir>/market/weave` 下 `SKILL.md`，经 `builtinMarketDir` 定位不硬编码路径），**docs 找不到即降级只注入技能**（`/ai/status` 的 `docsFound` 供 UI 提示），刻意不做进程内缓存（文件读取毫秒级，不缓存让改文档即时生效）。流式解析全站唯一落点 = `web/src/lib/ai.ts`（`EventSource` 只支持 GET，故用 fetch-reader 手工解帧），别处不得再造一套。**流式能力短期记忆**：网关/模型对 `stream:true` 能不能用，试一次就记（键 = 地址#模型，进程内不落库，`STREAM_MEMO_TTL_MS` 24 小时）——记「不行」期间直接走非流式，省掉每次白试的失败往返（LiteLLM 这类网关对 `stream:true` 恒定 500）；**TTL 到期自动忘掉再试一次 = 周期性试探**，试通即转回流式；「流式被拒」与「回 200 但非 SSE（网关无视 stream）」都算「不行」。
- **资源管理三层模型**：①市场副本层（`<dataDir>/market/<id>/` 导入/移除，LibraryPanel 资源市场侧栏；移除 = 删副本 + 注销宿主市场（`PluginSurface.removeMarketplace` 按落点反查注册名，best-effort；宿主级联卸载该市场的插件含数据，UI 有破坏性确认），非插件装面副本不级联）②安装/卸载层（数据目录 → 装到目标位与卸回：项目 skills/files/MCP、toolkit 包、全局个人 skills 软链、CC 插件包经 `POST /projects/:id/plugins/uninstall`→`PluginSurface.uninstall`，harness 注册表级、与市场源存亡无关）③启用/停用层（包开关/Switch/settings 落盘）。各层操作互不越级：删市场副本 ≠ 卸载，停用 ≠ 卸载。
- 架构总纲参考 `docs/plan/template-method-harness-refactor.md`。
