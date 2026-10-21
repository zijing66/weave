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

<!-- weave:end -->

<!-- 以下节写在标记块外：weave init 只按 weave:start/end 合并标记块，块外人工内容 append-only 保留（packages/weave-cli/src/init/claudemd-gen.ts mergeClaudeMd）。 -->

## Architecture

> 每条只答一件事：**能不能这么做**。机制怎么做、键形长什么样、哪处是唯一实现，写在 `docs/ARCHITECTURE-DETAIL.md`（下文 §N = 该文节号）；
> 带日期的裁决、实测与被推翻的旧结论写在 `docs/DECISIONS.md`。改架构须同步这两处。

- **抽象类全仓仅两处**、皆为模板方法：`InitPipeline`（`weave-harness/src/init/pipeline.ts`）固定 init 骨架；`TerminalBackend`（`packages/weave-server/src/daemon/opener.ts`）固定「取候选 → 按序尝试 → 全失败抛真相」，子类只填候选与真正不同的流程。`settings → 后端` 唯一入口 = `terminalBackendFor`，`enumerable` / `ownsPaneId` / `focusTarget` 这些能力归后端，调用方不得散写 preset 白名单。扩张抽象类之前先与项目所有者确认。（§1）
- **十三能力槽**（init / events / assets / resume / detect / plugins / pluginState / messaging / questions / capture / statusline / logs / config）+ `HarnessRegistry` 统一装配；`driver.ts` 的 `HarnessCapability` 是槽清单唯一权威，server/cli/web 不自造槽清单。harness 专属实现各自落 `weave-harness/src/<name>/`，server/cli 只做装配编排、不写 harness 硬编码。不支持也是面（null 同时给 `unsupportedReasons`，前端才答得出「为什么置灰」）。（§2）
- **配置面**（资源管理「配置」视图）：文件落点、键形、托管键判据、模型接口文法都归 `config` 槽（今天只有 claude），server 只装配「取档 → 读改写 → 快照与漂移」、web 只渲染，项目路径由 server 查库得出、绝不收前端路径。**词表是官方文档的生成物**（`pnpm gen:catalog`），不手抄、运行期不联网；说明文案用英文原文。托管键（`hooks` / `permissions` / `enabledPlugins` / `env.WEAVE_ENABLED` / weave 自己的 `statusLine` / `$comment`）**表单只读**——那是 `weave init` 写进去的，逃生口是原始 JSON。写盘只替换该档词表可见的顶层键、未知键原样保留；快照落 `local/`（可能带 key，不迁移）；**切换与「用文件覆盖库」必须先弹 diff 交用户确认**，本面板的写入口都同步激活快照，故漂移只来自外部改文件。（§17）
- **statusline 面**：块词表、脚本文法、`statusLine` 键形都是 claude 知识，落 `weave-harness/src/claude/statusline/`；`GET /capabilities` 的 `statusline` 行是唯一派生面，web 不按 harness 名判。对话页底条按同一份配置忠实渲染，但**只摆 weave 当下有数据的块**（没有就不摆，绝不摆空壳）、整条一起横向滚动、一块都摆不出就整条不出现；只读，配置入口恒在 `StatuslinePanel`。（§2）
- **logs 面**（拉取式采集，替代 hook 推送）：`LogSource.poll` 只回 `HookReport` + 事件**真实时刻**，故归一化/入库/SSE 全走既有路径、**不为新 harness 改 SQL**；行文名先翻成 `HARNESS_EVENTS` 既有 canonical 词表再生效（加词会让 `turnOpen` / 分组 / 样式全部失效）。**游标逐行推进**（一次跳到文件尾 = 静默丢事件）、路径归一是日志源自己的事（`report.cwd` 回白名单原文，server 按原样等值匹配）、轮询必跑在 inbox worker 线程复用同一条 DB 连接。（§2）
- **消息域 = 纯递送管道，非记录系统**：消息唯一归宿是目标会话自己的转录，队列送达即删、不落任何 DB 行。投递裁决唯一单点 = `MessageDeliverer`；`GET /messaging/capabilities` 纯派生矩阵，web 按钮与选项全表驱动、不写死 harness 白名单；触发源 ⊥ 投递通道，**不预抽 `TriggerSource`**。（§4）
- **手动面恒终端**：`/sessions/:id/messages` 无 `mode` 入参、恒 prompt 通道，且恒带 `forceTerminal: true` = 只剩层② 终端击键——直投与中继在宿主眼里都是「另一个会话发的」，要用户权威只有终端击键。**层序随面变**（手动 = 只剩层②；编排 = 直投 → 中继 → 终端），唯一实现 = `MessageDeliverer`，调用方不自排；队列冲洗同序。（§4）
- **投递语义以官方契约为准**：中继 exit 0 只说明「已交给对方」，接收侧可能 Held/Refused ⇒ `delivered` **不是「已读」**，UI 文案别写成已读；严格 **1 送 1 回执**，同一会话快速连发会在发送侧被拒。（§3）
- **投递可靠性**：回执未到（`ackStallMs`）/ 投递失败 → 该会话冲洗暂停（闸），解除 = 回执命中 / 手动重发 / 到点自动清除。**回执先到即已送达**——失败落定按「当前行」判、不看投递前的快照；回执比对先剥运输装饰，短文本认尾部相等（层② 往框里追加、残文只会垫在前面），一条 UPS 可核销多条在途；回合判死（`closeFailed`）= 输入框恢复响应的信号，在飞的层② 队头行立即补一记回车、不等闸的节拍。判死（`pidAliveOf === false`）即不入队，落 `failed` + `offline`，不假装排队。（§4）
- **层①-a 直投**（claude 专属，其他 harness `PromptInboxSpec` = null）：凭据随 hook 事件**旁路**上报（不进 payload/DB/UI），落盘只解 daemon 自己的重启、`SessionEnd` 到达即出盘并落定压队行（会话行与对话照常保留）。协议/键名归 claude adapter，server 只做通用传输。（§3）
- **中继（SendMessage）为何保留**：手动面已不走它，但它有 socket 结构上做不到的三件事——具名来源、回复面、覆盖非 weave 会话。启动开关 `--strict-mcp-config --disable-slash-commands` 恒开；**禁用 `--bare`**（该版本下 `--tools` 白名单失效 + 只认 API key）。中继是每轮次一次性子进程：不设超时、daemon 退出统一回收。（§3）
- **投递诊断只读**：三层「为什么送不到」的唯一诊断面 = `GET /messaging/diagnostics` + `weave doctor`，口径恒被动（不连 socket、不枚举 pane、不起中继），凭据只出「有没有」。采集脚本是 init 生成物、不随包升级 ⇒ 存量项目「发消息排队」先看它：重跑 `weave init` 即修，重装包不修。（§3）
- **接口日志**：每请求一行 JSON，写入恒异步串行、失败静默——日志不许拖慢或打断请求路径；截断脱敏后行仍须是合法 JSON，凭据类键与请求头（除 user-agent）绝不落盘；`GET /api-logs` 走认证门。写入侧唯一实现 = `daemon/api-log.ts`，挂点 = `weaveRequestHandler` 单点。（§3）
- **编排**：多份命名编排（表 + 图 + cron + webhook token）；项目编排 = 起始会话属于该项目的子集，节点与投递可跨项目，项目视图的起点只能是本项目会话。图是任意有向图，校验唯一实现 = `validateOrchestration`（服务端写入口直接拒，web 同判据只做即时提示）；推进 = 消息传递（一条投递对一次 idle），`ORCH_MAX_DELIVERIES` 兜底活环；边可带**上游这一轮的最终输出**（`carryOutput`，正文可空 = 只转发那段，上游没输出就不带）；有边要带输出时**先向该会话要一份「交接总结」再往下传**（`handoffPrompt`，空 = 内置那句；总结投不出去就照旧 fan-out）——原始最终输出对下游常常只有半句结论，这一轮由引擎自己排，不是 hook/plugin；起点判死即拉起终端。**daemon 重启不续跑**（running → `interrupted`）。运行日志 = `orchestration_runs`；实时刷新走既有 hook 帧域 kind 扩展，不轮询、不扩 `DataKey`；画布只摆编排内的会话，图即编辑面（连线与表单共用同一份 draft 与同一组纯函数）。（§4）
- **图片与路径引用归能力面**：`imageAttach`（一张图怎么被这个 harness 认出来）/ `pathRefs`（怎么引用项目内文件）答表示法，server 只传语义参数；表达式只在服务端产出，web 当不透明字符串、从不反解。**反向认引用也是能力面**（`pathRefs.recognize`，粘贴回填把表达式还原成胶囊），存在性由服务端按项目索引判；**引用前后必须是空白**，web 弹不弹选择器与服务端认不认同一个判据（胶囊不算空白）。上传 ≠ 投递；孤儿回收按引用计数，**被引用即永不删**（历史气泡的图不会破）。（§4.9）
- **项目文件索引不 watch、不常驻**：打开选择器即重建（`?fresh=1`），其余时候按 `.git/index` 指纹重验、硬窗兜底——**别拿既有的 chokidar 去刷源文件**（每实体一个句柄，账已量过，事件还会漏）。重建结果落 `cache/index/` 只作 daemon 重启后的种子（内存空着才接手、`fresh` 永不走盘）。匹配满档即停（`capped` 时报的是下限）、分刀让出事件循环，`total` 与「前 N 条」口径据此出文案。（§4.9）
- **pane 定位 = locator 优先、标题+cwd 回落**：按会话自己上报的 pane env 走、与开窗 preset 无关（定位按 env 反查 preset、击键按 pane id 认领后端）；命中即用**不做任何猜测**，失效宁可 409 也不误注入。定位键表唯一出处 = core 的 `TERMINAL_LOCATOR_ENV`（按「内到外」排），增改后存量项目须重跑 `weave init`。（§4）
- **对话面板**（`SessionMessages`）：内容 = 用户 prompt ∪ 每轮 Stop 的最终总结，**不落库、不复制存储**，直接查既有 `hook_events`；投递行被同文案事件认领即退场，认领不到的排在对话尾巴上（队列里的 `delivered` 叫「已发出」不叫「已送达」）。操作出场有白名单：`delivered` 不给删（它已经在会话那边了），在飞的 `delivering` 反而可强制移除（否则队头压死全队）。嵌入右栏形态不套卡片壳、头部只有「事件链」。（§4.20）
- **会话列表顺序**：顺序只由前端活动序决定（`byActivity`：lastSeenAt 倒序、createdAt 决胜），经 1 分钟周期统一落地 + FLIP；服务端列表恒 `created_at` 倒序——**活动序是前端层的事**，不要在服务端排、也不要让行随事件实时抖动。保留策略两档（`PROMPTLESS_GRACE_MS` 快速过期 / 收到过 prompt 的按 `sessions.idleDays`），判据与期限唯一实现 = `listWithCounts` 的 `autoDeleteAt`。**宿主已丢弃的空壳会话不等那 1 小时**（claude 一句没说就退出：id 连转录一起删、不发 SessionEnd、注册表自清）——判据唯一实现 = `shellDiscardedByClaude`（注册表查无登记 + 过豁免窗），`pidAliveOf` 的「空壳不判」不动。（§4.21）
- **提醒订阅 = 三腿**：页面 toast ＋ 浏览器通知 ＋ Web Push（页面关掉也能弹）。权限申请只在订阅手势处发起、拒绝则明说；VAPID 密钥落 `local/push.json`（0600，不进 settings 表），404/410 删订阅行自愈；与本地通知同 tag 去重。**新挂起待答只提醒、不自动弹框**，作答入口恒为手动点。（§4.18 §5）
- **阻塞式问答**：规格归 `questions` 槽（阻塞工具清单、静默权限模式名单、事件弹框判据、问题面解析、键序），状态机唯一实现 = `QuestionTracker`；作答只能走层② `sendKeys`（模态框只吃键盘），键序过服务端白名单（作答面不能变成注入通道）。计划正文来源随宿主版本变，批阅入口仍是那枚「回答」。（§5）
- **旁路会话** = 消息域唯一记录系统（`side_questions` 表）：只有 TUI 通道，回答由 `MessagingSurface.sideQuestion.answerOf` 认领，认领到即补一记 ESC（不收宿主面板，后续投递会白丢）。codex 留位不实现。（§6）
- **会话中断**：`interrupt` = 经 `TerminalBackend.sendKeys` 向 pane 打**一记** ESC、与 preset 无关；hook 域没有中断事件 ⇒「已中断」真相只在转录里，解析唯一实现 = `interruptMarkerAt`，`transcriptPath` 与模型/模式最后已知只放 `SessionProbe` 内存。停止按钮判据唯一 = `canInterrupt`。**键送出去 ≠ 宿主停了**：路由等一拍回读标记答 `interrupted`（true/false/null，判不了绝不猜），false 才按标题+cwd 补打一记且**落到同一个 pane 就不打**（`sent:false`）；web 不许拿「已送出停止」冒充「已停」。（§7）
- **模型最后已知重启后可回读**：换模型那把闩同样只在内存，但**不新增存储**——闩空着（daemon 重启）时回读库里这条会话最近一条 `HARNESS_SESSION_CONTROL[<harness>].modelFactEvents` 事件（换模型落定 / 重开会话），判据仍是「转录照会的还等于事件的 `from_model`（剥网关前缀比）⇒ 事件说的算」，最新一条是重开则不补（模型交还宿主重定）。不补的话「换完就放着」的会话重启后会一直停在切换前那个模型——转录只在本轮 assistant 条目上照会，而那一轮往往在切换前就发出去了。**live 重开一拍就闩默认**：`--resume` 事件不带 model（宿主把模型落回默认），`startedModelOf` 直接答全局配置的默认模型（`defaultModelOf`：env 块 `ANTHROPIC_MODEL` → 顶层 `model` 键换真名 → `sonnet` 档），上一轮的转录照会不许顶到新条目落地。解析唯一实现 = `dbModelFactResolver`（事件名归表、键形归 claude adapter 的 `switchedModelOf`）。（§7）
- **项目「已接入 harness」= init 选择结果**（`projectHarnesses` 读 `.weave/config.yaml`），**不用 marker 探测**（探测器答「目录结构像不像」，这里问「用户 init 时装了什么」）。`new-session` 收 `harness`：非法 400 / 未接入 409 / 已接入但起不了（无裸 bin 或版本不够）501。**宿主版本下限是 resume 槽的字段**（`ResumeCommandSpec.minVersion`，claude = `2.1.287`），探不到版本不拦；`canStartSession` = 有裸 bin **且**版本过闸，`version`/`minVersion` 随行下发只为让 UI 说明原因。web 侧**只要项目选中了 harness 就恒弹 `HarnessPicker`**（一枚也展开，起不了的置灰并说明原因）——不再有「1 个直接起」；不落会话行的 harness（`sessionMarkers` 为空）新建后不等新行。不要求本项目已开终端——没有就自己开一个。（§8）
- **压缩态**：信号归 core `HARNESS_COMPACTION`；实时态 = `deriveSessionStatus` 的 `compacting`（压在回合逻辑之前，压缩期间宿主不发 hook 事件）。「会话忙」唯一判据 = `isSessionBusy`（running ‖ compacting）。（§8）
- **数据目录三档**（唯一分档口径 = `packages/weave-server/src/db/paths.ts` 的 `dataRoots`，落盘点一律先在这里归档、不在别处拼路径）：`data/`（`weave.db*`、`market/`、`uploads/`、`plugins/`）**迁移整档带走**；`local/`（`auth.json`、`ai.json`、`push.json`、`certs/`、`initial-password`、自启脚本）**本机专属、不迁移**；`cache/`（`index/`、`logs/`、`statusline/`、`hooks/`、`tmp/`、`daemon.json`）**可弃、不迁移**。`libraries.path` 的相对基就是 `data/`（搬市场副本不改库记录）。旧顶层散放由 `ensureDataLayout` 一次性搬：**只 rename 从不删**、幂等、活 daemon 占着数据目录就整个不动；`hooks/` `statusline/` 搬完在旧位置留目录链接——写那两个目录的是 `weave init` 生成到项目里的脚本（路径写死在生成那一刻），**故改布局后存量项目须重跑 `weave init`**，重装包不修。（§16）
- **依赖硬约束**：`@weavecode/harness → @weavecode/core` 是唯一 harness 外向依赖；core 只放纯类型与表（`HARNESS_*` 注册表）。
- web 仅 `import type` 引用 core/harness（tsconfig paths + vite alias 源码直引）。
- 面向抽象与接口编程：harness 专属格式/路径/键形不得在 server/cli/web 自拼或散写，一律经能力面取，server 只传语义参数。插件键形 `<name>@<marketplace>` 唯一拼装点 = `PluginSurface.pluginKey(name, market?)`（`weave-harness/src/driver.ts`）；市场身份唯一实现 = `packages/weave-server/src/market/identity.ts` 的 `marketIdOf`（包在 `<dataRoot>/market/<id>/` 下 → `name@<id>`，否则 `name@weave`）；web 只渲染不解析键形。
- **SSE 单通道**：dashboard ↔ 服务端只有 `GET /events`；前端唯一客户端 = `web/src/lib/sse.ts`，**不得再 `new EventSource`、不得写定时轮询**（心跳判活与重连是唯一例外）。断流补发归 `SseHub` 一处（帧编号 + 环形缓冲 + `?since=`），补不齐只发 `resync` 整页重来、不给半截帧；中枢不得常驻订阅源，无人在看必须摘。数据层走 TanStack Query，刷新只走 SSE 信号。（§9）
- **位置即 URL**（唯一实现 = `web/src/lib/route.ts`）：URL 是唯一真源，手势只 `navigate()`，状态从 `parseRoute` 单向落下；卡片内部的视图态（tab/弹窗/滚动）不进 URL。（§10）
- **web 移动端适配**：断点 `lg` 二分、断点与指针查询唯一入口 = `use-media-query.ts`；改布局的八条硬约束（`dvh`、hover 按钮常显、拖拽传感器分流、列同构收缩、`min-h-0`、触屏右键等价手势、拉动加载、`<lg` 对话开则 AI 助手退场）见 §11——破一条即触屏不可用。（§11）
- **dashboard 认证**：口令材料落 `<dataDir>/local/auth.json`（0600）**不进 settings 表**；改密只认本机令牌（CLI `weave chpass`），web 无改密入口、401 一律回登录页。`bindHost`（服务端听哪）与 `DAEMON_HOST`（客户端连哪）是两个概念，不得混用。HTTPS 双监听与 HTTP 同一 handler，访问地址枚举唯一实现 = `accessUrls`。（§12）
- **AI 助手**：走服务端代理，key 落 `local/ai.json`（0600，只写不回显、不进 settings 表）；流式解析全站唯一落点 = `web/src/lib/ai.ts`；`docs/FEATURES.md` 是 `findDocsDir` 的判据文件**不可删**。（§13）
- **资源管理三层**（市场副本 / 安装卸载 / 启停）互不越级：删市场副本 ≠ 卸载，停用 ≠ 卸载。（§14）
- **终端落点与可见屏幕**：落点单位、上限、分块同为一个「可见屏幕」，上限唯一常量 = `MAX_PANES_PER_SCREEN`；会话 → 屏幕归 `locateScreens`，`SessionTerminal` id 格式归后端、server/web 不自拼；**投递路径的定位必须实时枚举**（缓存会把消息落进刚关的 pane）。三处「开终端类」按钮的 loading 一律挂到「已进入」才收圈（闸唯一实现 = `await-gate.ts`，不轮询、不订阅）——不要再写「POST 一返回就收圈」。（§15）
- **项目行「唤出终端」= 卡片弹层**：能力归后端 `focusTarget`，无通道的 preset 走基类明确拒绝（409），调用方不判 preset、web 不认终端名。抬窗只有 Windows 有，抓手只能是 HWND（终端 CLI 都不给窗口号）⇒ 按「**OS 窗口标题 = 该窗口某个 pane 的标题**」认窗：先按进程收窄，比较前先归一（剥 spinner 字与 `[活动 tab/总数]` 前缀），**唯一命中才抬、歧义如实报错不猜**；其他平台的 wezterm 到 `activate-pane` 为止。（§15）
- **提交/推送前的隐私体检**：`.githooks/{pre-commit,pre-push}` 只是薄壳，判据唯一实现 = `scripts/privacy-scan.mjs`（只需 node，零依赖）——**只扫新增行**；高置信度凭据（私钥头 / token 前缀 / `secret` 一类键上的长随机值 / `Bearer …`）拦，低置信度（邮箱 / 家目录路径 / 非回环 IPv4）只提示不拦（拦噪声只会逼人 `--no-verify`）；打印恒为**脱敏形状**、绝不回显原文，确认是假值就在该行写 `privacy-scan: ignore`；取 diff 失败 / 超 20MB / 没装 node 一律跳过不拦（hook 不许拖慢或拖断提交）。安装每 clone 一次 = `git config core.hooksPath .githooks`（POSIX 克隆还要 `chmod +x .githooks/*`）。
- 架构总纲参考 `docs/plan/template-method-harness-refactor.md`；带日期的裁决、实测记录与被推翻的旧结论记 `docs/DECISIONS.md`——本文件只留当前站立规则，不记流水账。
