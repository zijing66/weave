# weave 机制细节

> 本文是 `CLAUDE.md` Architecture 节的**细节展开**：那里只留站立规则（一句话判「能不能这么做」），
> 机制怎么做、键形长什么样、哪一处是唯一实现，全在这里。CLAUDE.md 里的指针写成「细节：§N」，N = 本文节号。
>
> 本文不是流水账——带日期的实测、被推翻的设想、事故复盘一律在 `docs/DECISIONS.md`；
> 当前态架构图与包分层在 `docs/ARCHITECTURE.md`；各改造批次的拍板与实施过程在 `docs/plan/`。

## §1 抽象类、终端后端与 wezterm mux

抽象类全仓**仅两处**、皆为模板方法：

- `InitPipeline`（`weave-harness/src/init/pipeline.ts`，经 `@weavecode/harness` 导出）固定 init 骨架。
- `TerminalBackend`（`packages/weave-server/src/daemon/opener.ts`）固定终端后端骨架「取候选 → 按序尝试 → 全失败抛真相」，子类只填候选与真正不同的流程。

`TerminalBackend` 的要点：

- wezterm 覆写 `open` / `run` 走 mux：有活实例就在实例里落子，`open` 一个活实例都没有才回落 legacy `start`——Windows 上 `start` 恒起新 GUI 进程、不并进已开实例。
- `settings → 后端` 的唯一入口 = `terminalBackendFor(terminal, platform)`。调用方不得散写 preset 白名单。
- 「这个 preset 能不能反查已开窗口」归后端的 `enumerable`；「击键/文本归谁」归 `ownsPaneId`；「能不能把已开窗口抬到前台」归 `focusTarget`。
- **`weztermCli` 恒带 `--no-auto-start`**：cli 缺省对失联 socket 会拉起永不退出的 `wezterm-mux-server`（复盘见 `docs/DECISIONS.md`）。

新增抽象类按需即可，但扩张前先与项目所有者确认。

## §2 能力槽与 statusline / logs 面

十五能力槽（init / events / assets / resume / detect / plugins / pluginState / messaging / questions / capture / statusline / logs / config / edits / images）+ `HarnessRegistry` 统一装配。`driver.ts` 的 `HarnessCapability` 是能力槽唯一权威，server/cli/web 不自造槽清单。harness 专属实现各自落 `weave-harness/src/<name>/`（claude/、codex/），server/cli 只做装配编排，不写 harness 硬编码。「不支持也是面」：能力为 null 时同时给 `unsupportedReasons`，让前端能渲染「为什么置灰」。

### capture 槽（hook 脚本的安装面）

`CaptureSurface` = `readUserCapture` / `installUserCapture` / `uninstallUserCapture` / `stripProjectCapture` / `scriptHealth`：答「这个 harness 的 hook 声明写在哪个文件、weave 那一组长什么样」。今天两实现——claude（`~/.claude/settings.json` 的 `hooks` 键 + `.claude/helpers/hook-handler.cjs`，另有项目档）与 codex（`<CODEX_HOME>/hooks.json` + `<CODEX_HOME>/helpers/hook-handler.cjs`，**只装 user 档**）。

- **脚本正文只有一份生成器**：`claude/capture.ts` 的 `generateHookHandler(version, harness)`。harness 只决定编码进脚本的三张表（`OWN_HARNESS` / `INJECTABLE_EVENTS` / `TITLE_EFFECTIVE_EVENTS`）与注入文法；codex 的后两张都空 ⇒ 永不回注 `additionalContext`、永不改会话名。
- **投递路径与 harness 无关**：脚本按 `<projectDir>/.weave/token` 取令牌、把**原始载荷**append 进 `<cacheDir>/hooks/inbox`，daemon 的 inbox worker 按 `report.source` 挑 `EventSource`（见 §9 的单通道口径）。故接一个新 harness 只需「装声明 + 让脚本跑起来」，服务端一条 SQL 都不用改。
- **codex 侧四处与 claude 不同**：① 声明落点 `hooks.json`（`HooksFile` 形状 + `deny_unknown_fields`）；② 事件词表少几条、多一个 `Interrupt`（线名，weave 规范名是 `TurnAborted`）；③ **信任闸**（见下）；④ 项目档不装——写 `<repo>/.codex/hooks.json` 还额外要求该文件夹被 codex 标成 trusted，多一道用户自己解不了的坎。
- **信任闸**：非 builtin / 非 managed 的 handler 必须有 `[hooks.state.'<hooks.json 绝对路径>:<snake_event>:<group>:<handler>']` 的 `trusted_hash`（键形 = `codex-rs/hooks/src/lib.rs:120` 的 `hook_key`，事件段是 `pre_tool_use` 这类下划线名），否则**不执行**。哈希盖住 handler 的声明内容 ⇒ `command` 串必须**恒定**（不带版本号/时间戳），这样「Trust all and continue」点一次即跨 weave 升级长期有效；weave 不自己算这个哈希（那等于替用户签字，且算错的表现是静默不跑）。CLI 只有一次性 `--dangerously-bypass-hook-trust`，config.toml 无持久开关 ⇒ 这一下只能用户在 codex 启动那张 Review hooks 弹窗里点。
- **hook 的执行环境**：以 `current_dir = 会话 cwd` 跑；非 unix 先 `env_clear()` 再回放整份继承快照（只滤 `NON_INHERITABLE_ENV_VARS`）⇒ `WEZTERM_PANE` 还在，pane 定位（§4.10）不用为 codex 改。codex 不设 `CLAUDE_PROJECT_DIR`，脚本的项目目录回落到载荷里的 `cwd`。
- `hook_transcript_path()` 给的就是 rollout 文件路径（内部会 `ensure_rollout_materialized`）——将来 codex 的 `edits` 槽从这里读。

### logs 槽（拉取式兜底）

`LogSource` = `poll(options) → LogRecord[]` + `health()`。`events` 槽答「一份上报怎么归一」，前提是有人把上报递进来（hook 脚本写 inbox）；没有 push 面的 harness 只能拉，这个槽就是那条面。今天唯一实现 = codex（`weave-harness/src/codex/rollout.ts`），且**已降为兜底**：`capture` 装上（10s 记忆、按 `CODEX_HOME` 失效）就让位，避免同一事件入库两份。

- **尾读 rollout JSONL**：codex 把每个会话 durable 地写在 `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`（归档的在 `archived_sessions/`）。会话身份 = 首行 `session_meta.session_id`（与文件名里的 uuid 同值）；实测 `codex resume` **接着写同一个文件**（`ordinal` 续号、不重发 `session_meta`），子线程 / 归档仍可能让一个 id 跨多个文件 ⇒ 游标按**文件字节偏移**记（`<dataDir>/logs/codex/cursors.json`），不假设一 id 一文件。
- **规范化事件名**：0.163 的行形状是 `TurnItem`（`AgentMessage` / `CommandExecution` / `FileChange` / `McpToolCall` / `UserMessage`），adapter 归一成 `SessionStart` / `UserPromptSubmit` / `Stop` / `TurnAborted` / `PostToolUse`，服务端的 `turnOpen` 判据、`hasRun`、事件链配色一条 SQL 都不改。**`"Text"`（AgentMessage）与 `"text"`（UserMessage）大小写不统一**，按 `type` 逐字比会漏正文。
- **卷控三道**：白名单（只认上述几类行）、单行 512KB 上限、单拍预算（400 条 / 4MB，游标**逐行**推进——一次跳到文件尾等于静默丢事件）。首次发现的文件只回填 256KB 尾窗（2 分钟内写过且 <1MB 的从头读），7 天以上的只登记不读。
- **`cwdWhitelist` 的契约**：源自己负责路径归一（大小写 / 分隔符 / 解析），命中即把**白名单原文**回填进 `report.cwd`，调用方按原样等值匹配到项目。
- **进程内锁**：`<stateDir>/.lock` 存 pid（`pidAlive` 判活接管、60s 节流心跳）——dev 与 start 两个 daemon 共用一个数据目录时不双写同一批事件。
- **没进采集面的**（诚实清单）：`reasoning` / `token_count` / `world_state` / `turn_context` / 图片附件 / `mcp_tool_call` 的入参与结果都不是事件，dashboard 不展示；阻塞式问答的对应表位留空。

### edits 槽（会话改动汇总）

`EditsSurface` = `sessionEdits({ sessionId, transcriptPath }) → FileEdit[] | null`：`FileEdit` 是一处改动 `{ path, hunk: { before, after }, at }`，时间序、不聚合（按文件摞是 server 的事）。今天唯一实现 = `weave-harness/src/claude/edits.ts`（`CLAUDE_EDITS`），codex 没有这个槽。

- **源头是转录，不是库里的 `hook_events`**：入站时 `tool_input` 逐字段被 `capFields` 裁到 4000 字符（`weave-harness/src/shared/json-cap.ts`），大一点的 `Write.content` / `Edit.new_string` 只剩前半份——拿它拼 diff 是错的。转录一行不裁，`Old_string → new_string`、`Write.content` 原样在 `message.content[].tool_use` 里。
- **只认三个工具**：`Edit` / `Write` / `MultiEdit`（`MultiEdit.edits[]` 摊平成多条）。`Write` 记 `before: ''`（新建也是一处改动，不能消失）；`NotebookEdit` 不算——它改的是 cell 源，没有可比对的整份文本。
- **工具调用 id 去重**：中断 / 重开后同一批 assistant 条目会被重放，`tool_use.id` 是它自己的身份。
- **转录路径归 server**：`SessionProbe.transcriptPathOf`（hook 事件旁路上报进来的那条，daemon 重启后从库里最近一条事件补回），claude adapter 不自己拼 `~/.claude/projects/<slug>/`。
- **读法**：流式逐行扫（`readline` + 先按 `"tool_use"` 子串预筛再 parse），不整份进内存——实测 90MB 转录 1.4s / 909 处改动，够一次点击用；半路读崩就回 `null`，不交半份。
- **汇总与限流在 server**（`summarizeEdits`）：`GET /sessions/:id/edits` → `{ files: [{ path, hunks: [{ before, after, at, clamped? }] }], hunks, truncated }`。展示路径相对项目根（posix 分隔），项目外的保留绝对路径；单处字段裁到 200k 字符（标 `clamped: true`）、总量 4MB（超了标 `truncated: true`）——都不许假装是全份。
- **按轮取数**（`?since=&until=`，语义 **(since, until]**）：默认视图是右键锚所在的那一轮——`until` = 锚及其后第一条回复的 hook 时刻、`since` = 锚之前最近一条回复的（`editsWindowOf`，web 侧唯一判据）。下界取严格大于是因为 since（上一条回复的 hook 时刻）比上一轮最后的转录条目**晚** ~0.4–1.3s（hook 记晚一步，实测样本：UPS +0.46s ×2、Stop +0.51/+0.75/+1.32s），放宽反而漏进上一轮尾巴；上界取闭包保证这一轮一条不漏。轮与轮之间隔着「人读 + 打字 + 模型首 token」≥2s，远大于钟差 ⇒ 不会串轮。`at` 缺失或解析不了的改动没法归轮，范围视图不摆（不带参 = 全部，照旧全给）；非法 ISO 按缺省处理。**已知局限**：窗口在已加载的条目里算，贴着历史头顶右键时真实的上一条回复可能还没翻出来 → since 退化成 null、窗口变宽（多摆不少摆错）。
- **null 也是答案**：没有该槽的 harness 回 `reason: 'unsupported'`，读不到转录回 `reason: 'unreadable'`，前端如实说明「为什么这里什么都没有」，不空转、不摆空壳。
- **diff 在 web 现算**：`web/src/lib/text-diff.ts` 的 `diffLines` + `collapseDiff`，行渲染是 `components/ui/diff-rows.tsx`（与配置对照弹窗 `DiffDialog` 共用）。入口 = 对话气泡右键「改动汇总」（`SessionEditsDialog`），默认这一轮、头部可切「全部对话」（会话里还没有回复条目时隐藏切换、恒为全部）。

### images 槽（入站图采集）

`ImagesSurface` = `sessionImages({ sessionId, transcriptPath }) → PromptImageSet[] | null`：一条 user 消息 = `{ text, at, images: [{ mediaType, bytes }] }`，时间序。今天唯一实现 = `weave-harness/src/claude/images.ts`（`CLAUDE_IMAGES`）；codex 留位（它的图是独立 `ImageView` TurnItem、且侧边会话不落 rollout，形状不同）。

- **为什么读转录**：终端输入框里粘的图，hook 载荷只有一个 `[Image #N]` 占位记号，base64 根本没进 payload；图只存在于转录 user 条目的 `{type:'image', source:{type:'base64', media_type, data}}`。与 `edits` 槽同一个理由：把被裁过的事件当真会丢数据。
- **只认顶层 image 块**：工具结果（`toolUseResult` 非空的 user 条目、或包一层 `tool_result` 的内嵌图）与 assistant 条目都不算「人贴的图」，否则气泡会凭空多出图。媒体类型只认 uploads 支持的四种（png/jpeg/gif/webp），单张 ≤10MB，超了跳过不猜。
- **读法同 `edits`**：流式逐行，先按 `"type":"image"` 子串预筛再 parse；读崩回 `null`，不交半份。
- **补采在 server**（`daemon/prompt-images.ts`）：`pendingOf` 取该会话 `UserPromptSubmit` 里「带占位、还没挂 `event_images`」的事件；与转录条目**归一去占位记号后按正文全等**认领（取时间最近的一条），纯图消息两侧正文皆空、只能按时间窗口（120s）兜底——空正文没有可比的证据，超窗宁可不挂。认到就把图 `save` 进 uploads（内容寻址，重复即 no-op）并 `linkToEvent`，之后缩略图 / lightbox / 分享图全走既有路径。
- **触发恒被动**：`GET /projects/:id/hooks?sessionId=` 取事件时 `needsImageImport` 判一下，有缺口才 `importPromptImagesOnce`——**等它一拍再回响应**（历史会话不会再来事件帧，后台补完前端没有刷新时机，图会一直不出现直到重开对话）；同一会话进程内 `attempted` 只扫一次，失败静默（回 0）。**不在 ingest 里扫**：那时图可能还没落盘，且会拖慢事件管道。单次上限 64 张 / 64MB，超出的留到下次进程。代价 = 第一次打开这段对话多扫一遍转录（预筛只 parse 带 `"type":"image"` 的行）。
- **转录路径归 server**：先取库里该会话最新事件的 `transcriptPath`（daemon 重启后仍在），`SessionProbe.transcriptPathOf` 兜底；claude adapter 不自己拼 `~/.claude/projects/<slug>/`。
- **web 零改动**：`HookEventRow.images` → `conversationOf` → `ConvEntry.images` 的渲染早已在（发出去的图走同一条）；补采只是把「事件上有图」这件事补成真。

### plugins / pluginState 槽（插件安装与启用）

- **claude = 完整参考实现**（`claude/plugins.ts`）：两步 CLI（marketplace add + plugin install --scope user）、installed_plugins.json 读侧、三档 enabledPlugins 覆写（user/project/local）。
- **codex = `codex/plugins.ts`**（0.163 源码核对，DECISIONS 2026-10-21）：键形 `<name>@<marketplace>` 与 claude 同形（`PluginId::parse` = `rsplit_once('@')`），拼装/拆解规则各自实现、不跨 harness 引用。安装 = `codex plugin add <key>`（CLI 内部整目录复制进 `~/.codex/plugins/cache/<market>/<name>/<version>/` 并自动写 `[plugins."<key>"] enabled = true`）；卸载 = `plugin remove`（删缓存目录，**不级联**、不动市场注册）。市场清单认 `.claude-plugin/marketplace.json`——**与 claude 共用同一份文件**（codex 的 `MARKETPLACE_MANIFEST_RELATIVE_PATHS` 第三项就是它），weave 的 `ensureMarketManifest` 维护一次两边受益；市场名取自清单 `name` 字段而非目录名（weave 已把 name 写成市场 id，恰好对上）。市场注册 = `marketplace add <本地目录>`：本地源不复制，config.toml 记 `source_type="local"`，根 = 目录本身。
- **读侧不走 CLI**（`plugin list --json` 会拉远端目录、慢且可能联网）：已装 = 缓存目录存在（最新版本 = 字典序最大，与 server 的 `readCodexPluginSkills` 同口径）；启用态 = config.toml `[plugins]`（与 pluginState 槽同一份事实）。codex 无项目档启用面——project 读写都落全局、`pluginScopes()` 恒 `['user']`。
- **removeMarketplace 按 source 路径反查注册名**（config.toml `[marketplaces]` 里 `source == <市场目录>` 的那个键；目录名不作依据），查不到 = 未注册 → 幂等返回；级联卸载该市场插件是宿主 CLI 语义，破坏性在调用方确认。
- **无市场身份的包明确报错**：codex 的 `plugin add` 必须经市场（CLI 按名查已配置市场），weave 不发明「裸目录源」惯例。
- **pluginState 槽**（`codex/plugin-state.ts`）保留：只管 `[plugins."<key>"] enabled` 布尔，供无 plugins 槽的消费方（global-config 技能分组装饰）取用；两面对同一份 config.toml 事实，不双写。

### statusline 面

`StatuslineSurface` = `segments` / `tui` / `scriptRelPath` / `generate` / `wire`。块词表、脚本文法、`.claude/settings.json` 的 `statusLine` 键形都是 claude 知识，实现落 `weave-harness/src/claude/statusline/`；server 的 `statusline/` 只是持久化与默认值壳（`statuslineCacheDir` 与包版本归 server）。

- 「TUI 里能不能注入」由面自己的 `tui` 答；`GET /capabilities` 的 `statusline` 行是唯一派生面，web 不按 harness 名判。
- **对话页底条**（输入框下方、贴底边、各尺寸都摆）按同一份项目配置忠实渲染，但**只摆 weave 当下有数据的块**：project / session / model / time / thinking（hook 事件自带的 `effort.level`，`SessionProbe` 只放内存、最后已知）∪ 宿主渲染脚本算好落在缓存里的 `StatuslineSurface.facts`——今天 = `git` / `git_user` / `changes` 三块，读按 cwd 分片的 `git-<cwd 摘要>.json`、过期条目不认、文件缺席即当没有；缓存文件名与键形归 harness，server 只递缓存目录与目录路径。
- **整条一起横向滚动**（行不各滚各的），块多了不许折行也不许被裁。
- context / tokens / cost / rate 只活在宿主 statusline stdin 里，dashboard 这一侧没有，就不摆（与生成脚本「解析成空即丢块」同口径，绝不摆图标/标签空壳）；一块都摆不出就整条不出现。
- 这条**只读**，配置入口恒在个性化配置里那个 `StatuslinePanel`（头部标 TUI 注入），对话页不开第二处。

## §3 消息投递：层①-a 直投、中继、诊断与接口日志

### 层①-a 会话本地收件箱直投

claude 专属机制（inbox socket）；其他 harness 的 `PromptInboxSpec` = null，server 完全不尝试。

- hook 进程（会话自己的 child，继承 claude 导出的 `CLAUDE_CODE_MESSAGING_SOCKET`/`_TOKEN`）把凭据**旁路**上报（不进 payload/DB/UI）→ 消息走它直投（实测 86ms、零进程零 LLM）→ 失败即回落终端/中继/队列（层序见 §4「层序随面变」）。
- **编排域走它**（第一顺位）、**手动面不走**（恒 `forceTerminal`——直投在宿主眼里是「另一个会话发的」，要用户权威只有终端击键）。冲刷路径同样先试直投。
- **凭据落盘**：`<dataDir>/hooks/inbox-targets.json`（0600，与 auth.json 同口径的非 UI 面；唯一落点 = `InboxSocketRegistry` 的 file 参数，装配侧只传路径）。它**只解 daemon 自己的重启**——凭据活在会话进程里（socket 由它托管、token 每进程一份），daemon 重启不动它们；**会话自己** resume/重启换了 socket（旧值即废）时连不上即回落、下一次 hook 事件覆盖写回（自愈 = 每次 hook 事件覆盖刷新，值没变不重写盘）。
- **正常退出即出盘**：`SessionEnd` 进采集面后（可裁剪开关 `hooks.sessionEnd`，存量项目须重跑 `weave init`；只覆盖正常退出，kill / 关窗口不发事件）到达即 `MessageDeliverer.sessionExited`：凭据出盘 + pane 定位清 + 压队的行按「会话未运行」落定；**会话行与它的对话照常保留**（那是历史，不走删会话的级联）。
- 协议/键名归 claude adapter（`weave-harness/src/claude/prompt-inbox.ts`），server 只做通用传输（`hooks/inbox-socket.ts`）。协议出处非逆向：官方 `cross-session-messaging#the-sessions-inbox-socket`（明说该节用途含「让脚本或 hook 投递进会话」）+ CLI 自带配方。

### 中继（SendMessage）为何保留

手动面不再走它（恒终端击键），但它有三个 socket 结构上做不到的作用：

1. **具名来源**：目标看到 `Message from @weave`。注意**两条路径都是跨会话消息**——socket 直投同样被包成「Another Claude session sent a message … not typed by your user」；宿主内置规则明说这类消息永不构成用户意图 ⇒ **socket ≠ 用户权威**，宿主眼里的用户输入只有层② 终端击键。
2. **回复面**：唯一可能承载「编排保双向」的路径；今天因中继进程瞬时退出而只是理论，要做需改常驻 stream-json 长会话。
3. **覆盖非 weave 会话 / 存量未升级 hook 的项目**。跨 harness 不是它的理由（codex 无 SendMessage，落层② 终端）。

### 投递语义以官方契约为准

出处 `code.claude.com/docs/en/cross-session-messaging`：

- 中继 exit 0 只说明「已交给对方 Claude Code」——接收侧三态 Delivered / **Held**（暂扣待批）/ **Refused**（静默丢），weave 从发送侧判不了。所以 `delivered` **不是「已读」**，UI 文案别写成已读。
- 本机消息序列化超 ~100 万字符在**发送侧**拒收（我们 API 限 20k 远低于它）、同一会话快速连发也会被**发送侧**拒收 → `flushSession` **严格 1 送 1 回执**：任何一层出手都登记 `awaitingAck`，一轮只送一条，下一拍由这条的 UPS 回执触发——队列是同一个队列，不分模式/通道。
- 可达性验证走 `/status` 的 `Peer address` 与 `/list-agents`。

### 中继启动开关

- `--strict-mcp-config --disable-slash-commands` 恒开——中继不用 MCP/skills，别为它拉一遍（仍能正确应答、工具白名单照旧）。
- **禁用 `--bare`**：它快得多，但当版本下 `--tools` 白名单失效（中继跑去调 WebSearch 不投递）+ 只认 API key（OAuth 认证失败）。查到但不可用，别再试（数据见 `docs/DECISIONS.md`）。

### 投递诊断（只读）

三层「为什么送不到」的唯一诊断面 = `GET /messaging/diagnostics`（`MessageDeliverer.diagnose` + `CaptureSurface.scriptHealth`，`?project=`/`?session=` 可选）＋ `weave doctor` 那一节。四块内容：

1. 采集脚本能力位：是否 weave 生成 / 生成版本 / 能不能上报 inbox 凭据与 pane env。
2. 逐会话三通道 `ready|unavailable|unknown` 与原因码。
3. 队列条数与暂停闸。
4. 存活三态。

原因码 → 中文修法只在 server 一处。**口径恒为被动**：不真连 socket、不枚举 pane、不起中继子进程；**凭据（socket 路径 / token）永不进响应**，只出「有没有」。

查「存量项目发消息排队」先看它：**采集脚本是 init 生成物、服务与前端升级不会跟着刷**，重写判据只是文件里含 `@version weave@` 子串（与版本号无关）⇒ 重跑 `weave init` 即修，重装包不修。

### 接口日志（请求级排障面）

- 每请求一行 JSON：`ts`/`method`/`path`（含查询串）/`status`/`durationMs`/`ip`/`ua`/`req`/`res`/`resBytes`；SSE 标 `stream` 不记正文、客户端中断标 `aborted` 并保留已写出口径。
- 写入恒异步串行链、失败静默——日志不许拖慢或打断请求路径。
- 出入参先截断脱敏再落盘、**行保持 JSON 可解析**：单侧捕获 8KB（超了整段换 `[truncated body N bytes]`）、超长字符串/超长数组/过深结构各换占位符、凭据类键（password/apiKey/token/secret/authorization/cookie/x-weave-local）一律 `[redacted]`。
- **请求头只记 user-agent**——cookie / authorization / 本机令牌的值绝不落盘。
- 按本地小时切文件 `<dataDir>/logs/api/api-YYYY-MM-DDTHH.jsonl`，只留最近 24 个（写完即清）。
- 查询 = `GET /api-logs?from&to&path&method&status&limit`（**走认证门**——日志是敏感面；倒序返回、limit 缺省 200 封顶 1000）。
- 写入侧唯一实现 = `daemon/api-log.ts`，挂点 = `weaveRequestHandler` 单点（http/https 两监听共享）。

**远程排障两面皆只读、可在目标机直接取**：请求有没有到 / 走了哪条 / 耗时多少问它；「消息为什么送不到」问上面的投递诊断。

## §4 消息/编排域

设计全文 `docs/plan/session-orchestration.md`。

### 4.1 消息域 = 纯递送管道，非记录系统

消息唯一归宿是目标会话自己的转录，weave 仅投递前短暂持有（本地文件队列），送达即删、**不落任何 DB 行**。

- `MessagingSurface`（messaging 槽）声明通道能力（发现 / prompt / inject / headless / watch idleSignals / imageAttach 图片对齐）与不支持原因。
- 投递裁决唯一单点 = server 的 `MessageDeliverer`（404/409 语义拒绝；auto 忙→inject、绝无头抢占忙会话）。
- `GET /messaging/capabilities` 纯派生矩阵、无第二事实源——web 按钮与模式选项全表驱动，不写死 harness 白名单。
- 所有触发源（manual / 提醒订阅 / 编排 / webhook / cron）统一收敛到 `MessageDeliverer.send`。

### 4.2 触发源 ⊥ 投递通道

- **manual**：dashboard 唯一人工面。
- **会话提醒订阅**（`session_watches`）：触发类型集 `on_events` = `idle` / `turnEnd`(`HARNESS_LIFECYCLE[<harness>].close`) / `messageFailed`；`remaining` = 剩余次数、NULL = 持久化、**已选类型共用一个计数**。dashboard 订阅按目标 upsert——`POST /watch` 对同目标已有 pending dashboard 行**改写原行**（类型集/次数，`updateById` 拒改已落定行）而非新插影子行；会话订阅方多行合法仍走 insert。命中走 `consumeHit` CAS、同一次转场的邻接事件 1s 内合并一次；`watch.fired` 帧带 `reason`。
- **编排**：见 4.12 起。
- **不预抽 `TriggerSource` 统一接口**（三种以上触发源形态收敛后再议）。

### 4.3 手动发送：无模式选项、无通道选项

发送键就是一枚（旧的那枚箭头下拉与它记的 localStorage 已删）：路由无 `mode` 入参、恒走 prompt 通道，且**手动面恒带 `forceTerminal: true`**——直投与中继不带发送方名字，宿主也不把它们当用户输入（socket 直投被包成「另一个会话发的」、对方会话可能答给一个随机同伴），人工对话要的是用户权威。**层①-q 宿主队列例外**：codex queue 的投递在宿主眼里就是用户输入（见 4.4a），故手动面也先走它、终端击键回落。

### 4.4 层序随面变

唯一实现 = `MessageDeliverer` 的队列先行 + 两处按 `forceTerminal` 定的层序；调用方不自排。

- **手动面**（`forceTerminal` 恒开）= 层①-q 宿主队列（面声明了才试；codex queue 在宿主眼里**就是用户输入**，比终端击键更接近「用户本人发送」）→ 层② 终端。
- **编排域** = 层①-q 宿主队列 → 层①-a 直投 → 层① 中继 → 层② 终端。
- **队列冲洗同序**，且先试队列/直投——冲洗正是被「刚上报凭据的那条 hook 事件」触发的，命中最优。

`SendInput.forceTerminal` 随 promptbox 行落盘、重发沿用。pane 找不到时照旧入队等下一次冲洗（不假装送达），也不回落另两层。

### 4.4a 层①-q 宿主自带队列

`MessagingSurface.queuedPrompt`（`QueuedPromptSpec`）：宿主自己的排队投递机制，**各 harness 各自实现适配**（codex = `codex queue --thread <UUID> --message <TEXT>`，经 app-server `thread/queue/add`；claude = null）。活会话 <1s 注入、没开的会话下次 resume 自动领走。

- **在宿主眼里就是用户输入**（无带外来源位，投递正文 = 普通 user 回合）——这是它与直投/中继的本质差别，也是手动面敢走它的原因。
- **exit 0 = 已交给宿主队列即 `delivered`**；真到达由 UPS 回执核销（投递正文与 UPS 原文逐字相同，回执比对天然成立）。
- **不收图**（codex CLI 硬拒 `--images`）：带图消息跳过这层，层② 终端 bracketed paste 优先。
- **正文只进 argv、不经 shell**：win32 的 `codex` 是 npm `.cmd` 垫片，harness 探 PATH 上 `@openai/codex` 包的 bin 入口改用 `node <pkg>/bin/codex.js` 直接 spawn（`WEAVE_CODEX_BIN` 可覆盖）；探不到按裸名 spawn、失败即回落下一层。
- 一次性子进程、带超时（30s）：队列是小操作，挂住即当失败回落。

### 4.5 层① 原生中继

claude SendMessage：`claude -p --no-session-persistence --tools SendMessage,ListAgents -n weave` + stdin；中性 cwd 防幽灵 hook、不入 peer 注册表。

- **中继 = 本轮次的一次性子进程**：`detached: false`（win32 shell 模式本就非 detached）、**不设超时**（等待发生在目标会话内）、daemon 退出经 `HeadlessRunner.killAll()` 回收在飞子进程（win32 taskkill /T /F、POSIX 进程组→单进程回退），三平台同一入口。
- peer 私有帧协议/命名管**不逆向不直连**。peer 注册表 `~/.claude/sessions/<pid>.json` 经 claude adapter 取 sessionId→name。
- 目标会话窗口可见 `Message from @weave: <原文>`、idle 立即唤醒、忙则下一 tool round 到达。
- **单向注入**——中继发完即退、无接收方会话。**手动面**投递载荷头部带「无需回复」注记：`oneWay` 由触发源定（手动路由 true、编排引擎缺省 false = 编排域双向对话保留），注记随 `oneWay` 落 promptbox 行；`PromptRelaySpec.instruction` 归 harness 规格，server 只传 peer 名 + 原文 + `oneWay`。注记是文本内引导非硬闸。

### 4.6 层② 终端

**无原生 peer 消息的 harness** 如 codex；**经 `TerminalBackend` 能力方法泛化**、不散写 wezterm。

- **wezterm**：`cli list` 枚举 + `cli send-text`。
- **Windows Terminal**：wt 没有 per-pane 写入面，走 conhost 的**输入记录通道**——`AttachConsole(会话进程)` + `WriteConsoleInputW`，不抢焦点、不依赖窗口在前台。会话进程取 hook 子进程自带的 `CLAUDE_PID`，`WT_PROFILE_ID` 认世界，pane id = `wt:<pid>`；经 `powershell -EncodedCommand` 把内联 C# 送进 P/Invoke，写的是 pane 自己的 console 输入缓冲区，故与窗口是否聚焦无关。
- **Konsole**（KDE）：`KONSOLE_DBUS_SERVICE` + `KONSOLE_DBUS_SESSION` 定位，会话自带的 D-Bus `sendText` / `sendKey`，pane id = `konsole:<服务>|<会话路径>`。
- **iTerm2**：`ITERM_SESSION_ID` 定位、AppleScript `write text`——**只有文本通道，中断/作答诚实不支持**。
- Terminal.app / ghostty / gnome 按通道现实实现、没有就诚实不支持（前三者的通道就是「没有」：无 raw key 注入、无文本写入，`keystroke` 要前台故不用）。

投递配方 = bracketed paste 打原文 + no-paste CR 提交。

### 4.7 层③ promptbox 队列与判死

`<dataDir>/hooks/promptbox/<shard>.jsonl`，daemon 只写、与 handler 消费的 outbox 严格分离。

- **判死即不入队**：三层全无通路且目标已判死（`pidAliveOf === false`，与「已终止」态、两条 terminated 补射同一判据）时**不假装排队**，落 `failed` + `reason: 'offline'`（web 出中文说明、发送手势回音 toast；`send` 仍回 201——请求合法、只是这条没送出去）。冲洗时该会话队列整批落定清队（不再每轮白探 pane 枚举）。
- 判不动（null）照旧入队，**不置暂停闸**（队列已空，闸只会挡住重发这条有意的可逆出口）。
- 冲洗双触发 = weave 项目会话 ingest 事件即时 + 隐藏刷新器只在队列非空时探（扫 peer 注册表与 pane 枚举，幂等）。

### 4.8 门控、图片随附、上传与孤儿回收

- **prompt 门控** = 层① `MessagingSurface.prompt`（claude 有、codex null）**|| 层② 终端文本通道可用**，能力矩阵两者皆无才置灰。
- **图片随附**：表示法归 `MessagingSurface.imageAttach`（`ImageAttachSpec.composePrompt`——「一张图怎么被这个 harness 认出来」是 harness 知识，server 只传语义参数：原文 + 落盘图的路径/媒体类型/原名；claude = 裸绝对路径放原文后独立一行，与它自己的粘贴文法同源；codex = null 不收图，附件钮按此位置灰）。
- **投递文本在投递时经 `wireTextOf` 现合成**（唯一落点；`msg.text` 恒留用户原文——回执比对与气泡文案都靠它，队列只存 `images` 引用、重启后按现 harness 面重合成）。
- **带图消息层② 优先**：只有 bracketed paste 能把路径转成 `[Image #N]` + 真 image block，socket/中继拿到的是裸文本路径；打不进照常回落层①-a / 层①（降级为路径文本）。
- **上传件内容寻址**：`<dataDir>/uploads/<sha256>.<ext>`，`POST /uploads` / `GET /images/:id` 长缓存；**上传 ≠ 投递**。
- **孤儿回收 = 引用计数式**（`UploadRepository.pruneUnreferenced`：删「没有任何 `event_images` 引用」的文件 + 行，1h 宽限——编辑器里选了图还没发的那份此刻也无引用；三处触发 = 删会话（`purgeSession` 内、**在 `events.deleteBySession` 之后**，指针靠级联先没）/ 项目归档 / `SessionSweeper` 每轮；**被引用即永不删**，历史气泡的图不会因清理破掉；否决按会话分目录——去重失效且上传时本就无归属）。
- 回执命中把 upload id 挂到那条 UserPromptSubmit 事件上（`event_images` 指针，消息本身仍不落库）供气泡缩略图跨刷新回显；带图回执比对放宽一档（claude 的粘贴处理器会吃掉多行原文的换行）、纯图发送认空 UPS。

### 4.9 路径引用与只读预览

表示法归 `MessagingSurface.pathRefs`（`PathRefSpec` 的 `kinds` / `lines` / `expression` / `recognize`）：答「这个 harness 怎么引用项目内文件」。

- 表达式（`@p`、`@p#L起-止`、目录尾斜杠）**只在服务端产出**（列表 `GET /sessions/:id/files` 带整文件形状、带行区间走 `GET /sessions/:id/ref` 现算）；web 只当不透明字符串贴进输入框、胶囊另存服务端给的 path/kind/lines 原文、从不反解表达式。
- **反向认引用 = `recognize`（`expression` 的逆运算）**：粘贴回填时把一段现成文本还原成胶囊，走 `POST /sessions/:id/refs/recognize`。文法归 harness、**存在性归项目索引**（`hasPath` 二分查排序好的 files/dirs，不为此做一份 Set），索引里没有 / `kinds` 不认的一律不认；`ref` 回的是服务端 `expression` 归一后的形状（`@p` 归一成 `@p/` 这种差别由服务端消化）。
- **引用前后必须是空白**（行首/行尾也算）：`看@a.ts`、`@a.ts，还有`、行内反引号里包着的都不算引用——前端那条 `@` 判据与服务端同一个规矩（输入框里粘着字敲 `@` 不弹选择器），否则邮箱、中文粘连全是误弹。胶囊不是空白：紧跟胶囊再敲 `@` 也不算。
- `lines` 答「选择器摆不摆行号选择」；codex = null + `unsupportedReasons.pathRefs`（文件钮置灰）。
- 选择器手势（`FilePicker`）：**单击只挪光标**（第三栏跟着走）、**双击 / Enter 才落定**（目录行 = 进入），空格与左侧勾选框 = 加入/移出「已选」，`Ctrl/Cmd+单击` 与 `Shift+单击`（连选）是桌面加速键；触屏没有 hover 与修饰键 ⇒ 单击仍是「进入」，多选只靠**常显**的勾选框（藏起来的钮在触屏上等于没有，§11）。已选非空时底条出「插入 N 项」，一次落定一批胶囊（顺序 = 点选顺序）。落点恒为**唤出选择器时那枚 `@` 的位置**（`atRange` 交给 `insertNodes` 消费，不是末尾追加）；胶囊前后必须是空白（服务端认引用的判据）——紧贴字补一个空格、本来就空着的不重复补。`pathRefKinds` 不含 `dir` 时目录行不给「引用此文件夹」。
- **行选区 ⇄ 勾选联动**：行号点出区间（第一下起、第二下止，起点上再点一下 = 取消）即**自动勾上**该文件、取消即退勾；「只引用文件」没有区间可依，仍要手动勾或空格。勾掉带区间的那条同样退区间（两处手势一个口径）。落定时带区间的那条现算表达式（文法归服务端），其余用条目手里的 `ref`。
- **键盘优先**：导航键挂 **document 捕获阶段**（点过侧栏/面包屑/底条、焦点落到 `body` 之后照样能用），查找/跳行小输入框除外（方向键归光标）。**默认焦点在弹窗自己身上**（`tabIndex=-1`），不在搜索框——否则空格成了打字、退格还会删掉背后输入框里那个触发用的 `@`；可打印字符一律转进搜索框（打开就能直接敲）。搜索框空着时空格仍是「勾选」，打了字才归查询。方向键一走 `kbdNav` 立起，**悬停不再抢选中**，直到鼠标真动一下（`mousemove`）才把选中权交回指针。
- 第三栏答「这条选中是什么」：目录列直接子项（**只读**，下钻仍归第二栏，两栏都能进会打架）、文本给只读编辑器、图片给 `<img>`；换选中防抖 150ms + 目录/正文各一份 LRU（箭头连滑不重取）。
- 预览是**只读**编辑器（`editable.of(false)`）、**没有替换**——查找与跳行用自绘的一条小条，不用 CodeMirror 自带搜索面板（那面板恒带 Replace 一行）。
- **索引不常驻、不 watch，但重建结果落盘**（`daemon/project-files.ts`）：打开选择器第一拍带 `?fresh=1` **无条件重建**（`git ls-files`，非 git 回落枚举），之后每敲一下只走缓存。缓存不是纯 TTL：命中时先核 **git 指纹**（`.git/index` 的 mtime + size；worktree / 子模块按 `.git` 文件里那行 `gitdir:` 找过去），变了立刻重建、没变才复用（一次 lstat + 一次 stat，比一个请求本身还便宜）；**硬窗 30s**（`INDEX_TTL_MS`）兜底，因为新建的未跟踪文件不动 `.git/index`。
- **落盘 = 可弃档 `<cache>/index/<projectId>.json`**，只作 daemon 重启后的 L2（内存空着才接手，`INDEX_MAX_STALE_MS` = 10 分钟、版本/根/git 指纹全对得上才端出去）；`fresh` 永不走盘、内存里判过期的那份也不回盘上捞（否则 30s 硬窗会被悄悄拉成 10 分钟）；写是一次 `tmp + rename`、失败静默（可弃档丢一层就丢一层），启动时 `pruneFileIndexes` 删掉已不在库里的项目。内存 LRU 只留 `MAX_CACHED_PROJECTS` = 3 份。
- **别拿 `WatchService` 的 chokidar 去刷源文件**：它只挂资源面，源文件上每实体一个 `fs.watch` 的账已经量过（1.3 万文件 → 1.3 万个句柄、一次扫描 20s、24s CPU），而且事件会漏，漏了就永远陈旧；枚举一个项目比它便宜三四个数量级（本仓 650 文件 283ms，大头是两三次 git 进程）。
- **索引形状分两层（落盘只写快照那七个字段）**：`FileIndexSnapshot`（`v` / `root` / `at` / `stamp` / `files` / `dirs`）= 可序列化那一份；`FileIndex` 在它之上挂**派生态**（`lower` / `dirLower` 小写表、`children` 目录子项映射）。`enumerateIndex` 产快照、`hydrateIndex` 是「快照 → 可查索引」的唯一入口、`buildIndex = hydrate(enumerate)`；将来读盘只需 `hydrateIndex(JSON.parse(...))` 再核 `v` / `root` / `stamp`，形状不用再改。
- **匹配 = 有界 Top-N + 满档即停 + 分刀让出**：`startMatch` 只留 `limit` 条（新条目顶掉最差那条再冒泡）；最差那条已是最高档（basename 前缀）时直接收工——此时 `total` 只是**下限**、同档内的先后由扫描序定，响应带 `capped` 让前端说「前 N 条命中（还有更多）」。`matchPaths` 每刀 ~8ms 让出事件循环（30 万条全扫一两百毫秒，一口气跑完这段时间里所有请求连 SSE 写帧都得等）。档位与高亮区间口径没变（`rankOf` / `rangesOf`）。
- **目录浏览 O(子项)**：`listDirOf` 直接取 `children`；排序**等第一次浏览这个目录**才做（30 万条上建索引时全排一遍要半分钟），且共用一具 `Intl.Collator`（`localeCompare(…, {numeric:true})` 每次现造排序器：30 万条 603ms vs 26ms）。
- **子模块里的文件也在索引里**：git 只给子模块一个 gitlink（mode 160000），得各自进去再列一遍（`--recurse-submodules` 给不了 `--others`，而子模块里刚建还没 add 的正是最想引用的），gitlink 自身只当目录、不当文件；没克隆的子模块不进去问 git（空目录里 `ls-files` 会往上层仓库上溯、把外层文件挂到它名下）。

### 4.10 pane 定位：locator 优先、标题+cwd 回落

**层② 的定位与击键按会话自己上报的 pane env 走、与开窗 preset 无关**：preset 答「weave 往哪个终端开窗」，pane env 答「这个会话此刻在哪个终端」，两者只在用户从不换 preset 时重合（换成 wt 不该让活在 wezterm pane 里的会话失去停止/作答）。

分派两处各归一个事实源：

- **定位按 env 反查 preset**（`locatorPresetOf`，遍历 core 的定位键表——preset 名不散写）。
- **击键/文本按 pane id 认领后端**（`TerminalBackend.ownsPaneId`，id 表示法归后端）。
- `locateScreens` 按世界分组各问各的后端（契约仍是每会话一行）；`available` = 定位键表里有没有能打字的后端。
- **配置的后端只管开窗与 `listPanes`**（标题+cwd 启发式回落的枚举面仍只在 preset 指向的终端世界里猜，不跨世界乱打键）。

定位链路：

1. hook 子进程与目标会话同 pane、天然继承 `WEZTERM_PANE`/`WEZTERM_UNIX_SOCKET` 或 `CLAUDE_PID`（键表唯一出处 = core 的 `TERMINAL_LOCATOR_ENV`，内联进生成的 hook 脚本、同 `TITLE_EFFECTIVE_EVENTS` 先例）。
2. **键表按「内到外」排，最内层的先命中**——`wt` 必须排在 `wezterm` 前：从 wezterm shell 里起的 wt pane 会同时带着外层 `WEZTERM_*`，只有 pid 指得住真正在跑的那个会话。键表增改后存量项目须重跑 `weave init` 才有新键，采集脚本是 init 生成物、不随包升级。
3. 随每次 hook 事件旁路上报（与 inbox 凭据同口径：**逐行**字段、只放内存、不落库——inbox shard 按**项目 token** 分片，同一 claim 里常混着同项目多个会话 ⇒ 会话级事实一律逐行取，按组聚合会把 A 的 socket 记到 B 头上、消息直投进别的会话）。
4. `MessageDeliverer.notePaneEnv` 存本会话的 env → `TerminalBackend.locatePane` 用「pane 号 + 同实例 socket」反查（`weztermPaneFromEnv` 纯函数，枚举到的活 mux 里比对；`WEZTERM_*` 键缺或实例对不上即 null；wt 走 `wtPanePidFromEnv` 纯函数，pid 须仍存活）→ 命中即用、**不做任何猜测**。
5. 未上报或定位失效（pane 已关 / 换 mux / 换窗口）才回落标题剥 ✳ spinner 前缀 + cwd 匹配、歧义拒绝不打。

因此**手动调整 pane 位置天然被跟上**：会话下一次 hook 事件就带着新 pane 重报，旧值随 `forgetSession`/`forgetProject` 清；代价是「上报滞后于移动」窗口期内可能落到旧 pane——但 locator 有存在性校验，失效宁可 409 也不误注入。

### 4.11 inject / headless / auto

三模式仍是 `MessageDeliverer` 的能力（会话提醒订阅用它），但**路由与编排都不开模式选项**：`/sessions/:id/messages` 恒 `mode: 'prompt'`，编排引擎也恒投 prompt。

- inject：忙排，下一拍 additionalContext。
- headless：`promptStdin=true`——stdin 传 prompt、命令行无用户内容，win32 `.cmd` shim 由此可经 shell 安全启动；shell 模式禁 detached（实测该组合丢管道输出）。headless 终态仅内存 + SSE、daemon 重启即丢。
- auto：忙→inject、闲→headless。

### 4.12 编排 = 多入口/出口图

`orchestrations` 表 = 名字 + 起始文本 + **节点/边** + `enabled` + `cron`，一份全局共享列表。节点是对象数组：**session 节点 id = sessionId**（运行态 pending 键、`RunEvent.from/to`、画布 flash 全按它流转），**webhook 节点 id = `w:<uuid>`**（入口带 `webhookToken`，出口带 `url`/`secret`），**trigger 节点 id = `t:<uuid>`**（手动触发纯入口虚节点：只出必连，没有会话在后面——手动触发选中它时正文经出边 `{upstream}` 下发，`start()` 分流成「session 入口投首消息 / webhook·trigger 入口 fire 载荷」）。`project_id` = 入口 session 节点所属项目（入口必须同项目；webhook-only 由创建方显式给），中间节点可跨项目。

图是**任意有向 DAG**（≤24 节点 / ≤64 边，无自环 / 无重边 / 无重复边 id / 无环）。**入口 = 无入边节点、出口 = 无出边节点；中间节点只能是 session 且必须有两端方向；webhook 节点只能站两端**（两端形状 XOR 判据 + 出口 URL http(s) 校验）；**trigger 节点不可有入边**。可达性不单查：入口 = 全部无入边节点，DAG 里入边链必然落回某入口，多源可达恒真（成环已被拒）；孤立 session 节点 = 自成入口的平凡编排，合法。校验唯一实现 = `hooks/orchestration-graph.ts` 的 `validateOrchestration`——服务端写入口直接拒，web 的 `validateDraft` 同判据只做即时提示。

### 4.13 推进 = 消息传递（每到一条执行一次）

- **扇入无 join/barrier**：某会话每收一条投递、下一轮完成（`MessagingSurface.idleSignals`，claude = Stop + SessionEnd）就消费掉一条待处理、把它所有出边各投一次（`Promise.allSettled`）。
- 任务节点每收一条消息被激活一次（`state.pending[to]` 一条对一次 idle），无待处理且在飞清零即 done。
- 环被校验挡在保存时、`ORCH_MAX_DELIVERIES = 200` 兜底活环。
- **边正文变量**（服务端 `renderTemplate` 渲染，web 只当文本）：`{upstream}` = 上游这一轮最终输出（`MessageDeliverer.lastTurnOutput` 读既有 `hook_events` 的 `raw.last_assistant_message`，超 `CARRY_OUTPUT_MAX_CHARS = 4000` 截断；webhook 入口 = 触发载荷）、`{summary}` = 本边提取结果、`{session}` = 上游会话名。缺值占位原样保留 → **渲染后判残留，残留即记失败**（不投半截模板）。
- **边级提取**（`edge.extract`）：对上游会话 **fork 一个无头回合**提炼信息（`ResumeCommandSpec.extractArgs` 归 harness；claude = `--resume <sid> --fork-session --no-session-persistence --session-id <引擎自造 uuid>`，实测 2.1.296 fork 真继承上下文、转录不落盘）。fork 的 hook 事件照发 ⇒ **合成会话名单**（`hooks/synthetic-sessions.ts`）：引擎 spawn 前登记、经 `HookPipeline.pushSyntheticSessions` 全量推给 inbox worker、**行即焚**（不落库不建会话行）。不支持 fork 的 harness（`extractArgs` 缺席，codex 留位）回落 `{upstream}` 并如实记事件。`handoffPrompt` 自投总结回合与 `carryOutput` 已退役（那才是污染原会话的来源）。
- **边闸两道、先廉后贵**（顺序 = when → condition → 投递）：`when` **文本预筛**——`{upstream}`（宿主文末总结）命中任一关键词（逗号/换行分隔、大小写不敏感子串）才继续，不命中记 `stage:'condition'` 事件拦下，**fork 都不烧**；`condition` **放行判断**——对上游会话跑一次「衔接上下文的子 Agent」（能力面口径 `supportsExtract`/`extract`，claude = fork；codex 无此面），提问要求严格回答 yes/no（中英首词认法 `parseConditionAnswer`）：yes 放行，no / 判不出都**拦下不投**（用户裁决：宁可不发错包），`stage:'condition'` 事件带原因；**全部出边被拦下 run 落 done**（判断按预期工作，不是失败）。when/condition 不可设在载荷型入口（webhook/trigger）的出边——没有会话可问（校验两侧同拒）。**不走「hook 向会话补发判断 prompt」**：那是已退役 handoffPrompt 的污染路，判断一律 daemon 侧 fork。
- **自然回合自动触发**（enabled 闸）：**入口 session 恒可 + `autoFire: true` 的中间 session 节点**（节点级 opt-in，画布检查器开关）idle 且**消费前任何 run 对该会话都无 pending**（会话级判据，跨编排安全——判据取消费前快照）→ 其出边直启（不走 `start()` 的首投，`{upstream}` 就是这一轮的输出）。护栏：节点有出边（孤立节点不空转）、同编排无在飞 run、同节点 5s 冷却（Stop/SessionEnd 连拍）、可触发节点索引 TTL 10s 缓存。残余风险如实记：投递走投递器队列还没入 pending 的窗口里到达的 idle 会被误判成自然回合（毫秒级窗口）。
- **webhook 出口在 `deliver` 分流**：不经判活/`ensureOpen`/pending（它不会回话），直接 `postJson`（`hooks/handlers/webhook.ts` 抽出的共用边界：http/https、5s 超时、HMAC 头）出站 POST，body = `{orchestrationName, runId, from, text, at}`；POST 计入 inflight 与投递预算。

### 4.14 三枚触发

- **手动**：`POST :id/trigger` 可带首步消息与**入口子集**（缺省 = 全部 session 入口；选中 webhook/trigger 入口则从它们 fire 载荷而不是投首消息）。**enabled 闸只管自动路径（cron/自然回合）**——手动与 webhook 是显式行为，停用的编排仍可显式触发。
- **webhook**：`POST /webhooks/orchestrate/<节点token>`——token 归 webhook **入口节点**（仓储 insert 时补发 + 全库查重，`POST .../rotate-webhook` 按节点换发）；载荷随该入口的出边正文下发（正文里 `{upstream}` 引用载荷，模板没引用就拼在正文后，正文空 = 只转发载荷）；路由在认证豁免内，api-log 把 token 段脱敏成 `[redacted]`。
- **cron**：5 字段表达式，daemon 30s 一探、同分钟只 fire 一次、已有在跑 run 则跳过；只驱动 session 入口（webhook-only 无可定时的入口），`enabled = false` 不触发。

### 4.15 会话判死即拉起终端 + 等 socket 就绪

每一跳（含入口）都先复用 `openSessionTerminal`（与会话列表「打开会话」同一入口）等它上报存活，再经 `MessageDeliverer.awaitInboxReady` 等它随首个 hook 事件上报 inbox 凭据（`INBOX_READY_WAIT_MS`；等不到照旧回落中继/终端，不挡投递）——冷启动拉起的会话若不吃这一等，第一跳就得白起一个几十秒的中继子进程（直投实测 86ms）。拉不起来落一条失败投递、不假装推进。

### 4.16 运行日志 = `orchestration_runs`

一次触发一行：`trigger` = manual/webhook/cron、`status`、`deliveries`、整份 `state`（pending 与逐条投递记录）、`error`。

- `GET /messaging/orchestration-runs` 按 status/orchestrationId/projectId 过滤并向前翻页；`:id` 返回 **summary + state 合体**（列表行走 `toRunSummary`，web 展开行直接顶替渲染，缺 `pendingCounts` 会崩）；`POST :id/cancel`。
- 清理 = 自动 `prune`（7 天 + 每编排留 100 条，daemon 启动跑一次）＋ 手动 `DELETE /messaging/orchestration-runs?scope=finished|all`；删编排级联取消在跑 run；删会话连带清定义（`deleteMentioningSession` 按 session 节点判）。
- **daemon 重启不续跑**：`rearm` 把 running 全标 `interrupted`（编排状态不是消息，宁可重触发也不重放 prompt）。

### 4.17 实时刷新与画布

实时刷新走既有 hook 帧域的 kind 扩展：`message.*` / `watch.fired` / `question.pending` / `sideQuestion.answered` / `orchestration.run` / `orchestration.delivery`——后两条各带全量轻量态（`status`/`trigger`/`deliveries`/`pendingCounts`/`at`），画布就地更新（节点环 + 边动画 1.2s、`pendingCounts` 出待处理角标；webhook 节点的 flash 键 = 裸 `w:` id），不轮询也不扩 `DataKey`。

画布规则：

- **总览 + 编辑双形态**：默认**未选编排** = 总览——`mergeOrchestrations` 把范围内所有编排**合并成一张图**（节点按 id 去重：同一会话只摆一个节点，跨编排 n:n 扇入扇出；边按端点对合并，`pairs` 记全来源），布局复用单图分层、单向无环；只读，编排名/会话/项目筛选收窄显隐，**无任何画布跳转**；编辑入口 = 首节点卡片（点它列出以它为入口的编排 + 新建）。选中某份 = 编辑画布。
- **只摆编排内的节点**——session 节点挂 `s:` 前缀、webhook/trigger 节点用裸 id；全局按项目分组（webhook/trigger 归所属编排的项目框）、组默认收起、首个 session 节点所在项目初始展开，项目视图全展示。
- 会话节点从受管会话里挑且**排除 1h 快速过期的 `promptless` 新会话**（能力面 prompt 列过滤）；webhook / 手动触发节点画布左上各一枚钮即加。
- **连线 = 上游卡片右栏 hook → 下游卡片左栏 hook**：节点是三栏卡片（左右栏是外接连接点，每个不同上游/下游一枚编号 hook），连线两端挂具体端口（Handle id = `in:<上游>` / `out:<下游>`——**必须按编排节点 id 拼**，渲染键 `s:<id>` 拼上去 handle 找不到、ReactFlow 静默不画，error 008 踩过）；点连接点/线段 = 选中那条边去改正文；未保存连线琥珀虚线、无效连线红虚线（`invalidEdgeIds` 逐条判）；正文标签走 HTML 层限宽换行（列间距 − 卡片宽 − 留白），不被节点盖住。
- **项目视图的入口 session 只能是本项目的会话**（中间节点可跨项目，越界由底栏警示）。
- ReactFlow 的背景样式设置条（`CanvasBackground`，编排与事件链共用）**恒从收起开始**。

**图即编辑面**：

- 点节点 / 点边开**右侧贴屏检查器**（上下通高右栏 `w-80`，会话/连线/触发/webhook 各一节）就地改（session 节点 = 打开对话 / 移除 / **自然回合触发开关（autoFire）** / 列出边；trigger 节点 = 说明 + 移除；webhook 节点 = 入口复制/轮换端点、出口填 url/secret；边 = 改投递正文（变量提示）/ 提取指令 / **文本预筛 when** / **放行条件 condition** / 删），从节点 hook 端口拖到另一节点即连边。
- 图上每一种改法与工具条**共用同一份 draft 与同一组纯函数**（`addEdge` / `addWebhookNode` / `addTriggerNode` / `removeNode` / `removeEdge` + `findCycle` 先拒环）；**边 id 是短序号**（`e1`、`e2`…，会话 id 本身 36+ 字符，拼两端会顶爆服务端 64 上限），id 只当内部键、不进展示。
- **没有单独的表单卡片**——图外那几项（名称 / 起始消息 / cron / enabled 开关）就在画布上方的工具条里，手动触发的入口多选（入口 ≥ 2 时出 checkbox 面板）也在其上；新增节点在画布左上（空画布时在占位块里），节点数/连线数与校验错误在画布内就地显示；**画布可全屏**（标题行切换，fixed 贴满视口——贴屏表单才有地方摆）。
- **破坏性确认走应用内 `ConfirmDialog`**（原生 confirm/alert 禁用）。
- 节点正文点击 = 选中（不是开对话，对话是节点上那枚图标与检查器里的按钮）。

### 4.18 消息优先、事件驱动

- 会话行在途角标 = `push 'inflightCounts'` 绝对值快照：`InflightCountsRefresher` 无定时器——`message.*` 帧驱动重算、值变才推，新 SSE 客户端接入补首帧；**不在任何 GET 里带，web 不自算**。会话行首有在途消息即挂 amber「图标 + 条数」角标（**纯指示、不可点**——对话入口就是行本体，会话行上那枚对话按钮已移除，它与行点击重复）。
- 提醒订阅 fire 的提醒 = 页面内 toast **＋** 浏览器通知（`web/src/lib/browser-notify.ts`，权限申请只在订阅手势处发起，拒绝则 toast 告知不静默）**＋ Web Push 第三条腿**。
- 订阅弹窗（`web/src/components/tasks/WatchPicker.tsx`）选类型集 + 次数/持久化。

Web Push 细节：

- dashboard 页面关掉后仍能弹：`src/hooks/push-notify.ts` 的 `PushNotifier` 订阅 hookBus，可推帧仅两处、帧 → 载荷映射单点 = `payloadFor`：`watch.fired` 仅 dashboard 订阅（watcher null，与 toast 同口径）、`question.pending` 无订阅面恒推。
- 向 `push_subscriptions` 全体订阅行群发 VAPID 签名 + aes128gcm 加密载荷（`web-push`），404/410 = 推送服务判订阅已撤销 → 删行自愈、其他错误保留行下轮重试。
- VAPID 密钥落 `<dataDir>/push.json` 0600（与 auth.json 同口径不进 settings 表）；`GET /messaging/push/key` 分发公钥、subscribe/unsubscribe 落 `push_subscriptions`（endpoint 主键、同 endpoint 覆写）。
- 浏览器侧 `web/src/lib/push.ts`——订阅动作挂订阅提醒手势静默降级（`ensurePushSubscribed` 三态 ok/unavailable/failed），设置页另有独立开关（`pushChannelState` 四态：insecure = HTTP 访问无安全上下文、unsupported = 无 SW）、失败可见告知。
- VAPID 钥轮换检测 = 既有订阅的 applicationServerKey ≠ 服务端公钥 → 退订重订（旧订阅配新钥恒 403）。
- 与页面本地通知同 tag `weave-watch-<sessionId>` 互相替换去重——双通道同达只弹一条。

### 4.19 终态驻留、未回执闸与回执比对

- **终态驻留**：delivered/injected/succeeded 在 `settledAt`+60s 内留在在途视图展示 `via`/`acked`（failed/timeout/`stalled` 常驻；**delivered 未回执的例外**——那条还没落进对话，跨过窗口也留着，回执或未回执闸落定才退场，否则队列里它先消失、闸落定时又冒出来；web 不再另设本地窗口）。
- **未回执闸**：prompt 送达 `ackStallMs`（缺省 30s）未回执、或中继/终端投递失败 → 该会话**队列冲洗暂停**（`flushSession` 闸，防继续向 Held/Refused 灌），成因消息标 `stalled` + `message.stalled` 帧。
- **斜杠命令走「短窗口」而不是「免除回执」**：以 `/` 开头的投递（判据 = `isSlashCommand`，与宿主同一条「trim 后以 `/` 开头」）分两类——**宿主内建命令**（`/compact`、`/model`、`/effort`、`/clear`…）内部执行、**不发 UPS**（实测 `/compact` 前后 8 分钟零 UPS，只有 `PreCompact`/`PreModelSwitch` 这类专属事件）；**skill/插件命令**照发一条 UPS，正文就是用户敲的那行（实测 `/minimax-xlsx  /minimax-docx` 0.6s 后到达）。故四路（中继/直投/层①-q/层②）落 `delivered` 时都进 `awaitingAck`，再按文本分派：命令走 `armCommandAck`（等 `commandAckGraceMs` 缺省 5s，UPS 先到就正常核销，过期仍未回执才按已送达收 + 解闸续排），**不布防**未回执闸；非命令照旧 `armAckWatch`。多行正文把命令写在后面不算，按普通 prompt 走。
- **解除三条路**：成因消息回执命中（解闸 + 自续排空）／手动重发（`POST /sessions/:id/messages/:mid/resend`，仅 prompt 通道 failed（含判死的 offline 行，那是有意的可逆出口）/ delivered-未回执 开放，重走三层并重新布防）／闸到点自动清除（`ackStallReleaseMs` 缺省 90s：已发出却等不来回执的那条整个从队列清除——正文只在该行里、窗口期就是给人的，解闸/撤防/续排都在 `dismiss` 里；行头带 `releaseAt` 派生的 mm:ss 倒计时，投递失败的行不清）。
- **重发 `delivered`-未回执且 `via=terminal` 的行只补一记回车**（`runTerminalSubmit`：正文早已贴进输入框，缺的就是那记提交键；重贴会在框里叠一份，用户收到两遍正文与两遍图）。
- **回合判死（`HARNESS_LIFECYCLE[<harness>].closeFailed`，claude = `StopFailure`）= 输入框恢复响应的信号**（`onSessionStopFailure`，挂点 = inbox worker 的事件判定）：API 重试态对 hook 静默（重试期间一个事件都不发，宿主只在回合放弃时冒头），那记被吞掉的回车要等到这一刻才有意义——层② 已贴进框、没回执的队头行此刻**立即补一记回车**（同上只补回车的语义），把残框提交掉，UPS 按下面的比对核销在途、闸自然解除；补不动（pane 没了 / 等的不是终端行）则回落 30s 布防与 90s 自动清除的老节拍。
- **回执先到即已送达**：投递进程的失败落定可能晚于回执（中继 exit 状态只管进程、不管送达；终端的 `sendText` 也可能在文本已进框之后才抛），故 `settleRelay` 与 `runTerminal` 的失败分支先看**当前行** `acked`——是就按已送达收、不置闸（翻成 failed 会让一个已送达的会话队列无限期停住，用户还会照着 failed 重发一遍）；`runTerminal` 的成功收尾同样用当前行而非 `write` 之前的快照，否则 write 期间到的回执会被抹掉、30s 后又被当未回执置闸。
- 慢会话误伤暂停是接受过的代价——它处理到该 prompt 时 UPS 自解闸，真卡死人手重发。
- **回执比对前先剥运输装饰**（直投的 `[weave] ` 标记，唯一实现 `stripInboxMarker`）——装饰不是正文，不剥则观测到的 prompt 恒比本体多一截、短正文（如「代码提交」）永远认不出自己。
- 长文本按「包含」认，**短文本（< 8 字符）认尾部相等**——层② 是往输入框追加，框里先在的内容只会垫在提交原文前面（实测「1」+「继续」→ 提交出来是「1继续」、两条队列行并一 →「继续继续」），整条相等在这些形态面前永不命中、「已发出」行只能一路挂到未回执闸；尾部相等仍比包含紧：宿主自己接的后文（「继续……不要」）不认，整条相等是它的特例。
- **一条 UPS 可核销多条在途**——宿主会把连着发的几次合成一次提交（终端里多行粘贴 / 队列合并），只认首条的话其余会一路挂到未回执闸、把该会话的队列误暂停，故遍历所有未回执行逐条核销（web 侧同口径：一条事件条目按 `ackedEventId` 认领多条投递行，谁也不再留在队列尾巴上）。

### 4.20 对话面板（`SessionMessages`）

任务视图右栏主区——点行本体就把它摆进右栏，挂过的切走只藏不卸、草稿与已选图片都还在；左栏与它之间的分栏桌面可拖，宽度存 localStorage `weave:tasks-list`、同 App 左右栏口径。

**内容**：

- 用户投递的 prompt ∪ 每轮 Stop 的最终总结（`raw.last_assistant_message`；中间 assistant 输出与工具活动不进——转录在会话自己那边）。
- **不落库、不复制存储**，直接查既有 `hook_events`（既有会话事件路由加 `types` 只取开/闭轮两类事件，`beforeId` 游标向前翻页），默认最新 10 条、向上**拉动**续翻（见 §11 ⑦）、翻过的页留前端（新页与手上重叠才续接，不重叠整批换新——宁可重翻也不留看不见的空档）、逐条时刻戳（跨天补月日）。
- `types` 为空（无闭轮事件的 harness）即无对话面。

**回复气泡折叠**：只展开最新那条、更早的收成三行并底部渐隐；**收/展只有底部居中那枚箭头一个入口**——正文一概不接点击，拖选复制不会被顺手收掉气泡，箭头也不做上下浮动之类的常驻动效（慢机上白烧每帧合成）；唯一实现 `SessionMessages` 的 `Collapsible`——量过 `scrollHeight` **超过六行**才给渐隐与箭头（短回复不收，收起来只多一次点击），多选态里箭头不渲染、点击仍归勾选。

**装饰与认领**：

- prompt 原文先剥**运输装饰**（唯一实现 = `web/src/lib/hook-payload.ts` 的 `stripPromptDecor`：直投的来源标记 / CC 的 `<cross-session-message>` 壳 / 壳内 weave 单向注记）——装饰不是正文，留着既在气泡里露馅、也让该条目认领不到自己的投递行（同一条消息显示两遍）。
- 剥壳后 `from-name` 非 weave 的（别的会话自己用 CC SendMessage 发的）挂发送方名 tag 与手敲 prompt 区分。
- 投递行只取 `mode='prompt'`（人工面恒 prompt 通道；编排域 inject/headless 不进），且**未被同文案相邻时刻的事件条目认领**——认领到的状态/回执/重发挂在那个气泡上不另起一条；认领不到的（Held/Refused、失败、暂停闸成因、仍在途、**已送达但气泡还没来**）**当作最新那几条气泡排在对话尾巴上**（不横占一条面；虚线框 = 还没落定）：多条时收进**同一个容器气泡**、每行一句（超了截断、点开看全文；只有一条时仍是当前那份单气泡的样子），行内保留队列那套样式（状态徽标 + 通道 + 原文 + 操作）。
- **队列里的 `delivered` 叫「已发出」不叫「已送达」**（它还没落进对话，气泡随会话自己的 UPS 事件才来；「已送达」是对话气泡上的事），**认领即退场**——真气泡接手时位置不变，同一条消息不会两处都露。

**操作三枚纯图标常显居右**：

- 重发（失败 / 被闸住）。
- 取回编辑（队尾那条还没送出去的——`pending`/`failed`/`timeout`；**已送达的不取回**，它已经在会话那边了，放回输入框再发一遍就是重复发送）。
- 移除（**凡未送达的都能移除**：排队中 / 失败 / 超时 / 暂停闸成因——闸成因不清掉，闸就没有可操作的成因行）。
  - **已发出（`delivered`）不给**：会话那边已经收到了，只是 hook 还没到、气泡随后就来，删掉等于假装撤回一条已经进了对话的消息——它的出口是重发不是删（**唯一例外 = 它正是暂停闸成因**：闸没有可操作的成因行就永远开不了）。
  - **在飞**的 `delivering` 反而**可以强制移除**——投递卡住时它就是队头、压着后面每一条都发不出去，不给动手就永远解不开：删即解闸、撤防、**就地解除卡住那一拍的泵闸**（`flushing` 挂令牌，旧拍醒来不能顺手删掉新拍的闸），落定回调按「当前行」收尾、行没了即收手（`runTerminal` 不再用 `?? msg` 把行写回来）。
  - `running` 不给（编排域的一条真实子进程，删行只是把活着的进程藏起来）。

**面板另有**：

- **输入框草稿刷新不丢**：按会话分键存 `sessionStorage`（`weave:draft:<sessionId>`），停手 250ms 写一次、发送清空即删键，重新打开面板/刷新页面原地还回来（含已落盘待发的图）。**存结构化快照、不存 HTML**——正文按「文本 + 换行」、引用胶囊按 `data-ref*` 四项还原，还原时用 `document.createElement` 重建节点（不吃不可信标记，也不怕类名/结构改版）；两个方向唯一实现 = `draftSnapshotOf` / `applyDraftSnapshot`。
- **停止按钮**贴在发送键**左侧**（生成中的会话，停它就该在发话的地方；判据见 §7）。
- **历史过滤**（全部 / 我 / 宿主名（`claude`/`codex`）/ 其他会话，纯函数 `filterThread`：别的会话经中继投进来的 prompt 归「其他会话」、weave 直投仍算「我」——判据唯一实现 `isRemotePrompt`；「生成中…/压缩会话中…/已中断」尾标是会话级状态、各档下照显，过滤后为空给专门提示别用「还没有对话」）。
- **多选导出**：桌面右键菜单、触屏双击开同一份菜单（菜单里那一项进多选），点气泡即勾选、底栏换成「已选 n 条 · 复制 · 分享图片 · 取消」，多选态里重发/删除不渲染以免抢点击。
  - **全选**范围 = **已加载的全部条目**，不随过滤变——过滤只管显示，勾选面不跟着收。
  - 复制走 `lib/clipboard.ts` 的 `copyText`、失败也 toast——HTTP 局域网无安全上下文正是它的用武之地。
  - 导出格式唯一实现 = `exportConversationText`，本地 `YYYY-MM-DD HH:mm:ss` 时刻行 + 角色行、条目间空行。
  - **分享图片** = 一枚按钮 + 小菜单「复制到剪贴板 / 下载 PNG」，渲染唯一实现 = `lib/conv-image.ts`（zero-dep canvas 卡片，正文按窗口那套 markdown 预览排——解析归 `lib/conv-markdown.ts`（纯函数、零依赖，只覆盖窗口真会渲染的那套块与行内记号；解析不出的记号原样留在文本里）；DPR 2 起、超 canvas 像素上限自动降 1，剪贴板走 `copyImage`、下载撤 URL 延 1s 兼容 Safari）。
  - **导出 HTML**（同一枚「分享」按钮的第三项）：唯一实现 = `lib/conv-html.ts` 的 `conversationHtml`（纯函数）。**单页自包含是硬约束**——样式进 `<style>`、随附图读成 `data:` URL 内联、mermaid 围栏预渲染成内联 SVG、字体用系统栈，**不引用任何外部资源**（无 `<link>`、无 `<script src>`、无 CDN）。正文来自模型输出 ⇒ 文本与属性值一律转义，链接只放行 http(s)/mailto/相对路径（`javascript:` 降成纯文本）。**自定义头**（用户配置的一段 style/script/片段）原样插在 `</head>` 前，**只在导出文件里生效、绝不在 dashboard 里渲染或执行**；多份配置存 daemon `settings` 表（`htmlExport` 一行 JSON），设置页标一份「当前使用」，导出直接用它、不在导出时弹窗选。

**事件链收进弹窗**：面板头部右上角那枚「事件链」按钮开（右栏没有对话面时事件链仍在原位），弹窗 z-50 压在 `<lg` 全屏右栏 z-40 之上、作答弹窗 z-60 又在它之上。

**两种形态共用面板本体**（`embedded` 嵌入右栏 / 编排画布仍是浮窗）：

- **嵌入形态头部只有那枚「事件链」，没有挂起与关闭**（右栏就是这扇对话，关掉等于空出一块；挂起/关闭只在浮窗）。
- 嵌入形态也**不套卡片壳**（没有圆角与边框——右栏本身就是这扇对话，再描一圈只是多一道多余的线；卡片壳是浮窗才要的）。
- 浮窗那套尺寸才是原尺寸行为：宽度跟屏幕走（视口 62%、1100px 封顶，`<lg` 仍铺满）、桌面可拖角改大小（localStorage 记住）与拖标题栏挪位。

### 4.21 会话列表顺序与闲置移除

- **顺序 = 前端活动序**（`SessionList` 的 `byActivity`：lastSeenAt 倒序、createdAt 决胜——活跃上浮/新会话置顶/静默沉底）。行数据随事件流实时刷新，顺序只由 1 分钟周期统一落地 + FLIP 滑动动画（成员增删只做增行/删行、新行即时置顶，既有行不随会话更新重排），不随事件实时抖动。服务端列表恒 created_at 倒序，活动序是前端层的事。
- **全局总览同口径**——`GlobalTasksOverview` 同一份冻结活动序逐行渲染（**跨项目混排、不按项目分组**），共用同一套门控（`useActivityOrder`）与 FLIP（`useFlipRows`），过滤条件换批则立即采用新序、不做增量合并。
- **会话行随首个事件即建**——含仅一条 SessionStart 的新会话，建档侧不按事件类型挑拣（「新建会话马上出现在列表」靠它）。
- **保留策略两档**：没等到用户 prompt 的新会话 1 小时快速过期（`PROMPTLESS_GRACE_MS`）；收到过 prompt 的会话 = 无操作 n 天后自动移除（n = settings `sessions.idleDays`，缺省 90，设置页可调并标出两条策略）——判据与期限唯一实现 = `listWithCounts` 的 `autoDeleteAt`（= lastSeenAt + 该档窗），`SessionSweeper` 过期即 purge（复用手动删会话级联）、web 行内剩余存活倒计时 tag（天/时/分三档）。
- **宿主丢弃的空壳提前清**（不等上面那 1 小时）：claude 开出来一句没说就退出时会把 session id 连转录一起删——**不发 SessionEnd、写 0 条转录、注册表自清**，weave 这边只剩一条 SessionStart，用户看到的就是「claude 里没了，会话列表还在」。判据唯一实现 = `daemon/claude-liveness.ts` 的 `shellDiscardedByClaude`（harness=claude ‖ 仅一条 SessionStart ‖ 注册表查无登记 ‖ 已过 `CLAUDE_REG_GRACE_MS` 豁免窗），由 `SessionSweeper` 同 tick 清走；**`pidAliveOf` 的「空壳不判」不动**（那是状态/投递面不猜），仍有登记的一律照旧走保活期。存活图由 `startSessionSweeper` 这个共用装配点注入（`livenessOf`），入口不自接线。`/continue`、compact 留下的幽灵行（注册表里也没有）同样 90 秒后被清——照本次裁决接受（它们是同一 pid 下的废行，事件跟在新 id 后面流）。

## §5 阻塞式问答

规格归 `questions` 槽（`BlockingPromptSpec`，claude 落 `weave-harness/src/claude/questions.ts`）：

- 阻塞工具清单。
- 权限 Notification 类型。
- 静默权限模式名单：该模式下宿主结构上不弹对话框，其 permission_prompt 恒为噪声；名单是「宿主是否可能问人」的事实，只放结构上不可能弹框的模式；模式名是 harness 知识，不得散写进 server。
- 事件弹框判据（`eventQuestion`）：不是工具、也非权限提醒的对话框（claude 的「Switch model?」）——事件到达且**对话框确实要弹**才给问题面；弹不弹是 harness 知识，猜错即幽灵问题。采集面 = 可裁剪开关 `hooks.preModelSwitch`（Pre 置位 / Post 落定成对登记，存量项目须重跑 `weave init`）。
- 问题面解析：AskUserQuestion 的 toolInput 全量解析；ExitPlanMode toolInput 恒空 → 合成固定两选项（`1` = 批准并切会话默认模式、`2` = 拒绝，文案取宿主模态框原文）；解析不出 → OPAQUE 兜底「看得见阻塞、无远程作答面」。
- **预览形态** = 单选 && 任一选项带 preview（多选即使带预览也落旧形态）——每选项归一化出 `preview` 文案（超 2000 字符或含不可见/双向字符 → withhold 文案、无可见内容 → 「No preview available」、缺省 → null 且不计入判据）+ `previewMode`。

### 选项键序

**原子序列**：宿主 TUI 把一次写入的连续字符当粘贴——两个数字一起到 = 什么都没选，故 `keys: readonly string[]` 每元素独立成键、deliverer 逐个写并留间隔。

- 单选数字 = 选中即推进、多选数字 = 只勾选不推进、Tab = 下一问（空作答也合法）。
- **预览形态的键 ≠ 旧形态**：数字只挪高亮、提交另需一记回车（`commit`），且备注只挂在挪动过高亮的选项上 → 选项行 `keys` 恒两键「先挪到目标、再落该问的 1..n」，单词问退化成一键。
- **整 call 一次提交**：宿主模态框 = 逐问 tab + 收尾屏，`n≥2 || 任一问多选` 时面尾追加合成收尾屏 `submit: true`（Submit answers / Cancel，不是宿主的问题 tab）——键序 = 逐问选项原子 + 未答/多选补 Tab + 收尾屏 `\t`+数字；多选**不许**逐项提交，那会把会话卡在勾选态。
- **宿主自有尾行**：`n+1` = Other 自定义输入（多选还要走位键（↓×选项数）与收尾键（Tab→内联 Submit），单选只要收尾 CR）；`n+2` = Chat about this（按下即结束整个提问）。旧形态两行都有，随选项面下发，server/web 不自造。
- **预览形态没有 Other 行**，自定义文本走宿主 `n` 那行（未聚焦时提示按 n）——备注只随高亮选项一起发，「只填备注、没挪高亮」在宿主里答成字面量 `(notes only)`，而空备注 + 没挪高亮在宿主里是死局（什么都不发生、会话继续挂着）→ 单词问**不出备注行**（宿主结构上没有挂载点），「选了输入行必须有文本」那条服务端闸反手挡住空备注。

### 状态机 `QuestionTracker`

内存态，挂 `handleIngestedRecords`——hookBus 帧不带 toolName，挂点必须在解析后的 payload 上。

- 置位：PreToolUse(阻塞工具) / Notification(permission_prompt) / 事件弹框（`spec.eventQuestion` 认出来的，kind = `switch`）。
- 清除：PostToolUse(同名) / UserPromptSubmit / Stop（question 态）；任意非 Notification 事件（permission 与 switch 态；switch 的落定笔 = PostModelSwitch，答「No, go back」宿主不发事件、留待下文清）。
- **已中断也是一条清除**：用户手动了结掉那个对话框之后，ESC 打断多半连 Stop 都不发、没有事件可等 ⇒ 摘除在**读路惰性**做，`snapshot` / `get` 顺手删掉，不另起定时器。
- 权限确认不带工具面，由 tracker 补最近 PreToolUse 上下文。
- **置位前的噪声闸**：静默权限模式下的 permission_prompt、以及阻塞工具自己 PreToolUse 后 ~6s 补发的那条（claude 对 AskUserQuestion/ExitPlanMode 恒发，归属 = lastPreTool）一律丢；真对话框归属待批的非阻塞工具、照常置位。
- 重启 `seedFromDb` 每会话重放最近 12 事件重建。

### 作答路由

`GET /messaging/questions` + `POST /sessions/:id/answer`：整份 `answers[]`（questionKey + options 下标 + 可选 text）→ 拼装唯一实现 `hooks/answer-keys.ts` 的 `composeAnswerAtoms` → **服务端白名单**（按原子：首原子必须是键原子、其余可为键原子或无控制字符文本——文本里夹 CR/ESC 就是任意键序注入，作答面不能变成注入通道）→ `MessageDeliverer.answer` 逐个经层② 终端 `sendKeys`（`TerminalBackend.sendKeys`，wezterm = `cli send-text --no-paste` 裸字节、CR 即回车）打进 pane——模态框只吃键盘，inbox/中继投递答不了。

pane 定位复用层② 的 locator 优先 + 标题/cwd 回落（同一条 `terminalPaneFor`；剥离正则字符集含 `◐` 输入等待态）。作答成功即 `markAnswered` 乐观摘问（防键序漏进已关模态框的输入框），PostToolUse 到达照常整条清除。

### 作答面（web）

- 不占新 SSE/DataKey：待答面并进会话状态总线的帧驱动 500ms 防抖重拉（失败静默降级）。
- 入口：会话行问答图标（amber + 问题数角标）→ `QuestionAnswer` 弹窗。形态由面自己定：
  - 带收尾屏 = 逐问单选/多选勾选 + 输入行随文本一起发、底部按钮按收尾屏选项下发（宿主原文 Submit answers / Cancel）、未答完禁用提交。
  - 不带收尾屏 = 单问点行即答。
  - **预览形态** = 左选项（`›` 高亮 / `N.` / `✓` 选中、**不渲染描述**）| 右预览原文 + `Notes:` 行 + 不编号的「Chat about this」，点行只挪高亮、提交走收尾屏或底部发送键；`chat` 行任一形态按下即结束整 call。
  - 问题/选项文案保留会话原文、只有 UI chrome 走 i18n。
- **弹窗尺寸按形态各记一份**（缺省 plain 448 宽/高随内容、preview 880×560；桌面右下角拖角调整存 localStorage、上限同 `max-h` 的 dvh 口径），`<lg` 整屏单列——拖角只桌面有，预览左右分栏在窄屏塌成上下堆叠。
- **组头「问答 ×n」计数**与 `BlockingPromptSpec.blockingTools` 共用 `HARNESS_LIFECYCLE[<harness>].questionTools`（谁是问答工具只说一处；web 经 `tasks/lifecycle.ts` 常量镜像）。
- **新挂起待答只提醒、不自动弹框**：QuestionTracker 在「无 → 有」转场广播 `question.pending` 帧（`seedFromDb` 重放不算新发生、不播），web 收到默认开三腿提醒（页面 toast + 浏览器通知 + Web Push，同 watch.fired 口径、tag `weave-question-<sid>`，但无订阅概念——阻塞提醒该是默认的，不进 watch 触发类型集）。
- **刻意不自动弹作答框**——作答入口恒为手动点：会话行提问图标 / 组头「待答」tag / 事件链画布根节点 tag / **对话窗尾部那枚「回答」**（`SessionMessages` 尾部与「生成中…」同行，门控 = 待答面在场；开的是同一个待答弹窗，关掉不丢入口、答完待答面没了按钮随之消失）——几个入口共用 TasksPanel 的 `answerFor` 一份状态（它在待答面消失时一并归位，否则残留目标会让该会话下次挂起「无点击自动弹脸」）。
- `QuestionAnswer` 弹层因此抬到 z-60——同为 `fixed` 门户在 z-50 按挂载先后分胜负，先开作答再开对话窗就会把弹窗压在底下。
- 会话删除级联 = `purgeSession` 的 `questions`（空会话清扫器同口径）。

### 计划正文当对话气泡

`BlockingPromptSpec.plan`，claude 落 `weave-harness/src/claude/plan.ts`；`GET /sessions/:id/plan` 只读取最近一次 ExitPlanMode 交出的那一份，按提交事件的位置插进对话流。

- 正文来源随宿主版本变——老模型塞 `tool_input.plan`，2.1.296 起 `tool_input` **恒空**、正文只在前一步写计划文件那次 Write/Edit 的 content 里（计划文件默认 `~/.claude/plans/<slug>.md`，可被 `plansDirectory` 挪走，故只按「某个 `plans` 目录下的 `.md`」认形状；Post 的 `tool_response.filePath` 指同一份文件，但那是批准之后才到、多半已被宿主删），事件里都没有才现读文件。
- **正文在事件里整份保真**：采集面的 4KB 叶子裁剪不裁计划形状的 `tool_input`——裁了气泡就只剩前 4000 字符、尾巴挂个「…」。
- 批阅入口**不新开一处**，仍是那枚「回答」。

## §6 旁路会话

claude = `/btw`，入口 = 对话面板头部**事件链左侧**那枚按钮 → `SideQuestionDialog`；能力面 false 即不渲染。

宿主侧问查询开着 `skipTranscript`——**问题与回答都不落任何文件**（宿主面板的 btw 历史只在它自己的内存里），`claude -p` 也不支持 `/btw` ⇒ **只有 TUI 通道**（层② 终端击键，与 `/model` 同一条 `MessageDeliverer.askSideQuestion`）。

因此这是消息域里**唯一的记录系统**：

- 问句由 weave 自己记（`side_questions` 表 / `repositories/side-questions.ts`）。
- 回答由之后那条采集事件认领——判据归 harness 能力面 `MessagingSurface.sideQuestion`（`SideQuestionSpec.command/validate/answerOf`；claude 的 `answerOf` = `SubagentStop` 且宿主**没给这个 agent 留转录**（普通 / skill 子 agent 都有 `subagents/agent-*.jsonl`，skipTranscript 的 fork 才没有）+ 压缩摘要形态排除 + **后台任务进度播报排除**（单行 ≤80 字符、无 CJK、进行体动词开头——这类 narration fork 与侧问回答事件形状逐字节相同，不加门会先到抢答、真回答被静默丢弃），server/web 不认识宿主事件名）。
- 认领 = 该会话**最早一条 pending 且提问在 10 分钟窗口内**的行（条件更新、幂等；窗口外落 `timeout`，读列表前惰性跑一次、不另起定时器）；人工在宿主面板里发的侧问没有 pending 行、天然不认领。认领后行在 **30s 稳定窗**内仍可被**严格更高分**候选替换（`answerScore`：语种一致 +2、长度 ≥120 +1、与问句 bigram Dice ≥0.15 +1，纯机械；平分保持现任 = 先到者赢），替换重发 `sideQuestion.answered` 帧；窗闭落定才发收尾 ESC——误认领被替换就不再多打一记。

**宿主的 btw 面板是 local JSX UI、开着就一直吃键盘**（字母与方向键都是它自己的快捷键）⇒ 不收起来，weave 后续打到这个 pane 的层② 投递会落进面板里白丢一条：故**认领到回答的那一刻补一记 ESC**（`MessageDeliverer.interrupt`，ESC 就是面板的关闭键；主回合在跑时这一记由面板消费、回合不受影响——代价是用户若已自己关掉面板而回合在跑，这记会打断那一轮，故只打这一次、不延时也不重试）。

界面：

- 问与答都走对话那套 markdown 预览（同一个 `AssistantMarkdown`）。
- 每条旁路是一根**折叠条**（头部 = 时刻 + 问句摘要 + 状态，点开才是完整问答；**最新那条缺省展开**，新到的也自动展开、翻更早的旧条不重弹）。
- 复制与「选中分享」照对话面板同口径（右键/触屏双击开菜单进多选、底栏换工具条，出图复用 `renderConversationImage`）。
- 实时刷新 = 既有 hook 帧域的 kind 扩展 `sideQuestion.answered`（web 收到即重拉一页，不做增量协议）。
- 删会话级联 = `purgeSession` 的 `sideQuestions`（空会话清扫器同口径）。
- 命令文法与形态校验归 harness（`/btw <原文>`、单行、≤2000 字符），server 只传用户原文。
- codex 的「侧边聊天」留位不实现（`sideQuestion: null` + `unsupportedReasons.sideQuestion`）。

## §7 会话中断与 `SessionProbe`

`POST /sessions/:id/interrupt` → `MessageDeliverer.interrupt`：经层② 终端 `TerminalBackend.sendKeys` 向 pane 打**一记** ESC（连打两记是 claude 的历史回退菜单；与开窗 preset 无关，层② 门控见 §4）。pane 定位同 `terminalPaneFor`（locator 优先 + 标题/cwd 回落）。

**一记之后要自证，键送出去 ≠ 宿主停了**：路由打完键等一拍（`INTERRUPT_CONFIRM_WAIT_MS` = 1.2s）回读转录，回 `interrupted: true | false | null`（true = 出现比打键前更新的中断标记；false = 转录在、没有新标记；null = 判不了：没探针 / 转录路径未知）。**false 时按标题+cwd 补打一记**（`interrupt(id, 'heuristic', <第一记的 pane>)`）——pane env 指着旧 pane（会话换过窗口）时第一记落进的是别人的输入行，宿主一声不响，而投递侧照样拿 exit 0（实机 2026-10-21：8c85b9c7 连按三次全 200、转录里一个标记都没有，同一分钟另一会话 0.5 秒即中断）。**补打落到同一个 pane 就不打**（`sent:false`，第二记会在 claude 里开出历史回退菜单）；web 依 `interrupted === false` 报错提示，不再拿「已送出停止」冒充「已停」。

**locator 覆盖度 = 那条通道的覆盖度**：项目侧 `.claude/helpers/hook-handler.cjs` 若是加 locator 之前生成的（脚本里没有 `terminal` 字段）就永不落 `paneEnvs`，只剩标题等值回落，而 `--resume` 起的会话 TUI 标题回 claude 默认、无题会话（`title` null）直接判无 → 这类会话一律 409「Session pane not found」。跨项目一次性覆盖靠 user 档采集（`PUT /capture`），或对该项目重跑 `weave init`。

### web 入口与判据

两个入口：事件链最新组头**折叠条的停止按钮** + **对话面板发送键左侧同款一枚**（共用 `interrupt:<id>` fb 键，同转同灭），两处**共用判据** `session-status.ts` 的 `canInterrupt`。

- **对话面板那枚是一枚 ESC 键帽**：位置与尺寸恒在恒方（`h-6 w-6`，窄屏 `h-8 w-8`，与发送键、换行键同高同排），只是回合开着才可按。
- 事件链组头那枚仍是**回合开着才露**（含卡在报错重试时的长静默：hook 事件静默超窗口、状态回落 `open`，那正是最需要这一记的时候）。
- **回合已关（收到 Stop，正常收尾）/ 失败落定 / 关闭 / 终止 / 已中断一律不露**（正常收尾后不再残留按钮）。
- `turnOpen` 未知（旧 daemon、以及无回合开合信号的 harness——`hasTurnSignal` 认生命周期表，codex 的 `open` 还是空占位）才按状态兜底（`isSessionBusy`）。

### 「已中断」态

hook 域**没有**中断事件（45 次 ESC 实测里 41 次连 Stop 都不发），故打断之后 `turnOpen` 一直开着、会话永远卡「生成中」——真相只在转录里（claude 补一条 user 消息 `[Request interrupted by user]`，工具调用进行中被中断是 `… for tool use`）。

- 解析按 harness 各归各的 adapter（server 只读不解析格式）：claude = `weave-harness/src/claude/transcript.ts` 的 `interruptMarkerAt`（转录 user 条目 `[Request interrupted by user`）；codex = `weave-harness/src/codex/transcript.ts` 的 `codexInterruptMarkerAt`（rollout 的 `event_msg`/`turn_aborted` 行，实测 0.163）。两套标记**互不相交**（对方的标记串不会出现在自己的转录里），`SessionProbe.factsOf` 两个都跑取更新者——probe 不必知道会话是哪个 harness（调用方也没传）。
- `transcriptPath` 由 hook 事件旁路带来、存 `daemon/session-probe.ts` 的 `SessionProbe`（**只放内存**，与 paneEnv / inbox 凭据同口径：不落库、daemon 重启即清零、靠下一次 hook 事件补回；尾读 64KB 并按文件大小缓存；删会话随 `purgeSession` 的 `probe` 清）。
- 判据 = 标记**晚于** `sessions.last_seen_at`（自愈——之后任何事件都盖过它）。
- `GET /sessions` 只对 `turnOpen === true` 的行带 `interruptedAt`，另有 5s 的 `interruptRefresher`（同 `SnapshotRefresher`，key `sessionInterrupt`）把新标记推给 web。
- web 状态机第 7 态 `interrupted`（`deriveSessionStatus`，**压在压缩/回合逻辑之前**，进程内再比一次 `interruptedAt > freshest`——推帧可能落在本地新事件之后），展示口径同「打开」（`countSessionsByHarness` 计进「打开」、状态点取中性石板色），且**不再露停止按钮**（`canInterrupt` 排除它——这一轮已经停下来了，`turnOpen` 还挂着是它没发 Stop，不是还有活）。

### `SessionProbe` 记的其余事实

- **换模型**：`PostModelSwitch` 的 `to_model` 进闩锁、取更晚的那个——换模型不在转录里留条目，标签靠它才跟得上；事件名与键形归 claude adapter 的 `switchedModelOf`，server 不自拼。
- **闩扛不过重启 ⇒ 回读库**：闩在内存，daemon 一重启就没了，而转录只在本轮 assistant 条目上照会模型 ⇒「换完就放着」的会话重启后一直停在切换前那个模型（实测窗口：切换 17:35:23 → dev daemon 重启 17:37:18 → 转录 17:40:39 才照会，见 DECISIONS 同日）。兜底 = `session-probe.ts` 的 `dbModelFactResolver`：取库里这条会话最近一条 `HARNESS_SESSION_CONTROL[<harness>].modelFactEvents` 事件（claude = `PostModelSwitch` + `SessionStart`），**是换模型**才拿 `from_model` 跟转录此刻照会的值比（`bareModelName` 剥网关前缀），相同即宿主还没跑过新一轮 → 用 `to_model` 锁进闩；**最新一条是 `SessionStart`** 就什么都不补（`--resume` 把模型交还宿主重定，旧答案作废）。每个会话 daemon 生命周期内只问一次（`probed`；`sessionStarted` / `forget` 清掉）。
- **开/恢复会话**：`SessionStart` 的 `startedModelOf`——带真名（startup / compact）就以它为准；`--resume` 的 raw 里**不带** `model`（实测，40 条抽样恒 null），但重开 = 宿主把模型落回默认，**默认值就写在全局配置里**：`defaultModelOf` 读同一份 settings.json（env 块 `ANTHROPIC_MODEL` → 顶层 `model` 键、别名经 `ANTHROPIC_DEFAULT_<别名>_MODEL` 换真名 → 内建 `sonnet` 档）直接答上并经 `noteModel` 闩死——不答的话转录里上一轮的照会会顶着旧模型直到第一轮新条目落地（8c85b9c7 实测：上一轮 deepseek-flash、重开实际落 ftm）。转录新照会 / `PostModelSwitch` 照旧接管；重启回读那拍仍按上条「重开不补」（回读侧没有可比对的 `from_model`）。清闩重读只剩不带值的 harness 降级路径（否则新照会恰好等于切换闩的 stale 时，标签永远停在关会话之前那个模型）。
- **执行模式同归它、且事件优先**——每条 hook 事件都带 `raw.permission_mode`、答的是「此刻」，转录里最后一条 `permissionMode` 只到上一次写条目为止（宿主切模式既不落转录、也没有专门事件），故 `noteMode` 逐条覆盖、`currentMode` 事件优先转录兜底，键形归 adapter 的 `permissionModeOf`。
- web 的模式 chip 在切出去之后、新模式被事件回报之前显示「切换中…」（60s 没事件就回落最后已知——下一个模式由宿主自己算、还会被 settings 过滤，猜就是撒谎）。
- **思考强度（effort）同归它**：工具/回合类事件每条带 `raw.effort.level`（`effortLevelOf`），`noteEffort` 逐条覆盖、`currentEffort` 只放内存——状态栏 `thinking` 块与对话控制行的 slider 同吃这一个事实。
- **思考强度的调整入口**（对话控制行）：词表归 core 表 `HARNESS_SESSION_CONTROL[<harness>].effortLevels`（claude = `low/medium/high/xhigh/max`，codex = 空——0.163 无程序化通道，见 DECISIONS 同日取证）；命令形态归 `MessageDeliverer.setEffort`（`/effort <档位>` 经层② sendText，与 `/model` 同一通道、同一「整行粘贴」理由），档位**过词表白名单**（封闭枚举，表外 400 不打键）。**模型能力差异不进表**：同一 harness 各模型支持档位不同，宿主自己降档并提示（claude 的 cap 语义），下一轮事件的 `effort.level` 回报自动纠正显示——weave 不读宿主运行时 cap（拿不到）。web 控件 = `EnumSlider`（拖动中只本地预览、松手/方向键才提交，裁决归 `enum-slider-core.commitOf`），不做 pending 态（事件几秒内就到，不同于「可能永远不来事件」的 Shift+Tab）。

### 语义边界

层② 只负责把那一记键送进 pane，宿主怎么收尾不归它管——宿主 abort 杀的是它自己起的 shell，**孙进程可能被孤儿化**（Windows 不级联杀），停止后仍见到残留进程是宿主行为不是键没到。

ESC 只救**在途**（内部重试 / 长工具卡住）的静默窗口；报错已落定（转录里 `isApiErrorMessage` 记录 + `turn_duration`）时 turn 已结束，该做的是**重发**不是 ESC——证据见 `docs/DECISIONS.md`。CLI 不提供停止命令（用户裁决「cli 不需要」）。

## §8 项目 harness 接入与压缩态

### 「已接入 harness」= init 选择结果

存在 `.weave/config.yaml` 的 `harnesses`；server 唯一读点 = `daemon/project-harnesses.ts` 的 `projectHarnesses`。

- **不用 marker 探测**：init 恒建 `AGENTS.md → CLAUDE.md` 链接，codex 探测器对任何 weave 项目都假阳性（探测答「目录结构像不像」，这里问「用户 init 时装了什么」）；老项目 / 未 weave 化无该字段回落注册表首个。
- `GET /projects`（含 `/archived`）逐行带 `harnesses: {id, canStartSession, version?, minVersion?}[]`，项目卡标签与「新建会话」的 harness 选项同源取数。`canStartSession` = resume 槽有裸 bin **且探到的宿主版本过 `resume.minVersion`**；`version`/`minVersion` 只为让 UI 说明为什么置灰。
- **版本闸是 resume 槽的字段**（`ResumeCommandSpec.minVersion`，宿主版本要求是 harness 知识、不散写 server）：claude = `2.1.287`（与 `MIN_MOD_HOST_VERSION` 同一档——hook 面 / 问答键序 / 计划正文都按这版起写）。探测 = `<bin> --version` 取首个 semver（win32 上 npm shim 是 `.cmd`，须走 shell），**10 分钟缓存、并发共用一次 spawn**（缓存的正是在飞的那个 promise，`GET /projects` 逐项目取版本不会起一串子进程），**失败不缓存**；**探不到不拦**——与 mod 版本闸同口径（拿不到 ≠ 不兼容，低误报优先）。
- `POST /projects/:id/new-session` 收 `harness`：非法 400、未接入 409、已接入但起不了（无裸 bin 或版本不够）501，缺省取已接入里第一个能起的。
- **codex 的 resume 槽有裸 bin**（`codex` 起新会话，`codex exec resume <id> -` 是无头形、prompt 走 stdin）但**没有 `openArgs`**——交互式 resume 要 codex 自己的 session id，而 weave 不收 codex 事件（`CODEX_EVENT_SOURCE = null`）、手里没有这个 id ⇒「在终端打开 codex 会话」仍 501。
- **web 侧只要项目选中了 harness 就恒弹 `HarnessPicker`**（一枚也展开，不再「1 个直接起」——用户要看见有哪几个、为什么起不了）：起不了的置灰并在行内说明原因（版本偏低带出实际版本与下限，其余为「暂不支持新建交互会话」），行与按钮都挂原生 `title`；只有「一个 harness 都没接入」才把按钮置灰。
- 不落会话行的 harness（`HARNESS_LIFECYCLE[<harness>].sessionMarkers` 为空，今天 = codex）**不等新行**：新建会话的 loading 挂到「新会话行进列表」为止，但这类 harness 永远不会有行到来，等就是白转满 `OPEN_TERMINAL_ALIVE_MS`（30s）⇒ POST 回即收圈。
- **不要求本项目已开终端**——没有就自己开一个（落点由终端后端自决：复用同项目 tab，没有就在活实例里新窗口）。

### 压缩态

信号归 core `HARNESS_COMPACTION`，web 经 `tasks/lifecycle.ts` 常量镜像——谁是压缩事件是 harness 知识，server/web 不自拼。

- 表两项：`start` = 压缩开始事件（claude = `PreCompact`，**唯一实时信号**：最新事件是它即压缩中）；`end` + `endSource` = 收尾笔（claude = `SessionStart` 且 `raw.source='compact'`，事件链标记认它）；全 null = 该 harness 无压缩概念（codex 待调研）。
- **只登记 `PreCompact`**，不采 PostCompact 的 bulk 摘要（`compact_summary`）——实时态不需要它。
- 实时态 = web `deriveSessionStatus` 的 `compacting`，**压在回合逻辑之前**（压缩期间宿主一个 hook 事件都不发，走 turnOpen/静默窗会判成 `open`；自带更宽的 10min 超窗兜底，防会话被杀在压缩中永久卡「压缩中」）。
- 会话行状态、对话面板尾标（`生成中…` → `压缩会话中…`）与组头转圈同源；「会话忙」判据单点 = `isSessionBusy`（running ‖ compacting），`countSessionsByHarness` 按它把压缩中计成运行中（项目行不掉成「打开」）。
- 采集面：`PreCompact` 是**可裁剪采集开关**（`hooks.preCompact`，随 weave init 写进项目 settings）→ **存量项目须重跑 `weave init` 才有实时态**；收尾笔 `SessionStart` 早就在采集面里，故事件链那一笔的「压缩会话」tag 对存量会话即时可见。

## §9 SSE 单通道与数据层

dashboard ↔ 服务端只有一条事件流 = `GET /events`（`packages/weave-server/src/daemon/server.ts` 的 `handleSse`），帧形 `data: {type: ...}`——`asset`/`project`/`hook` 是既有域；`push`（后端已算好载荷，前端直写状态）与 `invalidate`（只给 `key`，前端按 key 调既有 fetcher 重拉）是数据域，键表见 `daemon/data-bus.ts` 的 `DataKey`。前端唯一客户端 = `web/src/lib/sse.ts`。

**心跳与判死是一对**：服务端每 25s 写一帧 `{type:'ping'}`（`SSE_HEARTBEAT_MS`），客户端 65s 没见任何帧即关掉重建（`STREAM_SILENT_MS`）。中间的代理 / 移动网络会**静默**掐断空闲流（EventSource 既不报错也不重连），dashboard 会停在旧帧上直到刷新页面。这个判活定时器是「不写定时轮询」的唯一例外，只判活、不取数。

**断流补发归中枢一处**（`daemon/sse-hub.ts` 的 `SseHub`，`weaveRequestHandler` 建一份、两监听共享）：

- 三个源只订阅一次 → 每帧编号 `id: <纪元>-<序号>`（纪元 = 进程随机，认得出「这是重启前的序号」）→ 环形缓冲 1000 帧 → 各连接各写一份。
- 客户端记住最后收到的帧 id，重建连接带 `?since=` 回去补齐（`lib/sse.ts` 的 `lastEventId`——**我们重建的是新 EventSource 对象，浏览器不会替它带 `Last-Event-ID`**；同一个对象上的原生重连才带，服务端两处都认且 **header 优先**——查询串是旧的，认它会把收过的帧重放一遍）。
- 心跳**不带 id**，不挪 offset。
- **补不齐就整页重来**：纪元不同 / 缓冲已滚过去 / 断开期间没人听（最后一个连接走后 60s 摘源，那段帧是真丢了）→ 服务端只发 `{type:'resync'}`、不给半截帧，前端 `location.reload()`（`sessionStorage` 记时刻，10s 内不连刷）——宁可重来一遍，也不留一个悄悄缺帧的界面。
- **中枢不得常驻订阅源**：隐藏刷新器靠 `DataBus.hasSubscribers()` 判有没有人在看，宽限期（`UNWIRE_GRACE_MS`）只为让刷新页面/网络抖动落在同一条流里，一过必须摘。
- 订阅按帧域拆面——`subscribeFrame` 按帧类型、`subscribePush` 按载荷 key、`subscribeHook` 按 kind（支持 `message.` 尾点前缀）、`registerInvalidator` 失效域（一 key 多注册者）——组件不收裸流、不走 window 事件转发（例外 = 页面专属独立流，如 AI 助手的 fetch-reader 流式）。

**数据层走 TanStack Query**：`['projects']` 域先行（SSE 帧经 `registerInvalidator`/`subscribeFrame` 桥到 `invalidateQueries`），其余域按同一范式逐个并入、不抢跑；全局缺省 `staleTime: Infinity` + `refetchOnWindowFocus: false` + `retry: false`——刷新只走 SSE 信号，个别查询按需覆写。

**无事件源的数据**（项目终端数（单位 = 可见屏幕，wezterm = tab——与「选哪个终端」弹窗同口径）+ 会话所在可见屏幕、会话存活）由后端隐藏刷新器（形状同 `daemon/terminal-topology-refresher.ts`）只在值变化时推、且只在有 SSE 客户端时才探。

## §10 位置即 URL

唯一实现 = `web/src/lib/route.ts`。

- 三级位置 = `/p/<项目 id>/<卡片>[/<会话 id>]`，全局面 = `/g/<卡片>`，根 `/` 只在启动时被 replace 到当下该在的那一处。
- **URL 是唯一真源**：手势只调 `navigate()`（push，后退/前进走 `popstate`），状态由 App 的一条 effect 从 `parseRoute` 落下，反方向不再回写，卡片内部的视图态（tab/弹窗/滚动）不进 URL。
- 卡片键白名单派生自 `MAIN_CATEGORIES`，未知键回落 `tasks`；项目已不存在（归档/删除的旧链接）replace 到全局。
- 深链刷新不需要服务端改路由：daemon 的 `serveStatic` 已把未知路径回落 `index.html`，且 HTML 导航在认证门豁免内。
- 任务视图的三级选中经 `onSelectSession` 往上报，面板自己点出来的选中会经 URL 回写成同值 prop——按 `appliedSel` 那份账认回声，不重设也不闪高亮。

## §11 web 移动端适配

断点 `lg` 二分——桌面三栏原样保留，`<lg` 单列 + 左右栏滑出抽屉；桌面 inline 栏与移动抽屉复用同一 JSX 常量、`isDesktop` 互斥渲染（不双挂载/双请求），断点与指针查询唯一入口 = `web/src/lib/use-media-query.ts`。

改/新增 web 布局的硬约束：

1. 视口高度用 `dvh` 不用 `vh`；桌面向 `calc(100dvh-常量)` 的减数是桌面横排预算，`<lg` 上方堆叠更多内容必失真 → 窄屏改视口比例（事件链画布 `h-[52dvh]`）。
2. hover 才可见的操作按钮触屏不可达 → 补 `max-lg:opacity-100` 一类常显。
3. 拖拽传感器按 `(pointer: fine)` 分流（鼠标 PointerSensor 位移 5px / 触屏 TouchSensor 长按 200ms 容差 8px），不裸用 PointerSensor。
4. 固定宽列（列头/数据行）必须同构收缩（同一组 width 工具类），放不下的列折进行内第二行（`basis-full`）或 `hidden lg:block`，不做横向滚动。
5. 纵向 flex 堆叠的下区要 `min-h-0` 才能收缩，否则被外层 `overflow-hidden` 裁掉。
6. **右键面触屏给等价手势**（触屏没有右键这回事）：默认长按 450ms、位移 >8px 即取消（不夺滚动/拖拽），**只在粗指针下挂**（`useMediaQuery('(pointer: coarse)')`），触屏下 `onContextMenu` 只 `preventDefault`（压掉原生菜单）不开自家菜单，且**长按生效后抬手补的那个 click 要吞掉**（否则会顺手点选/把刚开的菜单关掉；账本见 `ProjectList`）。**对话面板（`SessionMessages` 气泡）例外走双击**——同一条气泡、两击间 ≤300ms、位移 >8px 即取消，开的是桌面右键那一份菜单（多选只是菜单里的一项，长按不再直接进多选），气泡挂 `touch-manipulation` 压掉移动浏览器双击缩放，桌面端仍只有右键。
7. **滚动加载一律拉动触发**（唯一实现 = `web/src/lib/pull-load.ts`）：贴边本身不加载、贴边后**继续**滚/拖够 120px 才取一页（预设加载与「刚贴边就取」都让用户没得选），一拉一页、离开边沿才重新上膛；位移用 `transform: translateY` 让位——**不进布局**，否则与翻页的 `scrollHeight` 补偿打架，提示条是绝对定位叠层；`overscroll-contain` 管住滚轮/触屏串动。今天两处：对话面板往顶、事件链往底。
8. **`<lg` 的整屏对话一开，AI 助手（浮球 + 那扇弹窗）整个退场**——它钉在右下角，正是对话发送区的位置，让位也挤（浮球位置归 `AiAssistant` 一处）；置位方在对话侧（`TasksPanel` 依 `!isDesktop && paneOpen && hasConv` 写 `lib/conv-screen` 的模块级 store，卸载即清），`AiAssistant` 用 `useConvScreenOpen` 订阅后返回 null——只是不渲染，会话历史留在内存、抽屉关掉照旧；桌面不触发（三栏并排，对话是右栏、盖不到右下角）。

## §12 dashboard 认证与 HTTPS 双监听

### 认证

`daemon/dashboard-auth.ts` 的 `AuthService`——口令材料（scrypt hash / 会话签名密钥 / 本机令牌）落 `<dataDir>/auth.json`（0600），**不进 settings 表**（那是 UI 可读配置面，`GET /settings` 直出）。

凭据三种：

- 密码。
- 无状态签名会话 cookie（`weave_session`，30 天，改密轮换密钥即全失效）。
- 本机令牌 `x-weave-local`（CLI 与 hooks 免密——同机同用户可读 auth.json = 本机即管理员）。

要点：

- 门在 `server.ts` 的 `handleRequest`（`deps.auth` 可注入，**缺省不装 = 开放**，存量测试口径），豁免 `/health`、`/auth/*` 与「HTML 导航 + 真实静态文件」（登录页必须未认证可载）。
- **改密只认本机令牌**（`PUT /auth/password` ← CLI `weave chpass <新密码>`），dashboard 不提供改密操作。
- web 侧 401 一律打回登录页、未登录干脆不建 SSE 连接（唯一认证态 store = `web/src/lib/auth.ts`）。
- 首启随机初始密码写 `<dataDir>/initial-password`，由 CLI 领取一次即刻删除（daemon detached 启动，打印必丢）。
- 监听绑定 = settings `server.bindHost`（默认 `0.0.0.0`，可改回 `127.0.0.1`）；**`DAEMON_HOST`（客户端连哪）与 bindHost（服务端听哪）是两个概念**，不得混用。

### HTTPS 双监听

settings `server.tlsPort`，默认 6443、0 = 关。

- daemon 自签证书（`<dataDir>/certs/`，selfsigned 纯 JS 无 openssl 依赖；SAN = 全部非 internal IPv4 + localhost + hostname，换 IP/临期 7 天内自动重签）起第二个 https listener。
- 与 HTTP **同一 handler**（`weaveRequestHandler` 单点建、fingerprint 缓存两监听共享；两个 daemon 入口接线别各建一份）。
- 端口被占/证书失败一律降级仅警告，HTTP 不受影响。
- 访问地址枚举唯一实现 = `daemon/tls.ts` 的 `accessUrls`（`weave daemon status` / `weave dashboard` 与 `GET /settings` 的 `urls` 同源派生，CLI/web 不自拼）。
- 手机浏览器要系统通知就必须走 https origin——浏览器只在安全上下文（HTTPS/localhost）开放 Notifications API；Android Chromium 还只认 SW 的 `registration.showNotification()`（`web/src/lib/browser-notify.ts` SW 优先、构造器兜底）。
- 全站**唯一** Service Worker = `web/public/sw.js`，三件事：push 弹通知、通知点击聚焦、**预载壳**。预载壳只缓存构建产物（`/assets/` 内容哈希、`/fonts/`、logo）与 shell HTML 一条；`/api/` 与非 GET 一律不拦。HTML 走「网络优先 + 1.8s 超时回落缓存」，dev（`/@vite/client`）与无 `/assets/` 引用的页面不入缓存，故本地开发零影响。旧产物条目不清（升级瞬间老页面还会懒加载老 hash），整档淘汰靠 `SHELL` 常量改名。

## §13 AI 助手

dashboard 右下角浮层，配置齐才显示。走**服务端代理**——web 只发会话历史，`daemon/ai-routes.ts` 按 OpenAI 兼容协议（`POST {baseUrl}/chat/completions`）带 key 转发并把增量转成自家 `{delta}/{done}/{error}` 帧。

- **api key 落 `<dataDir>/ai.json`（0600）**，与 auth.json 同口径——不进 UI 可读的 settings 表，只写不回显（`PUT /settings` 的 `ai.apiKey` 是只写字段，GET/PUT 只回派生布尔 `apiKeySet`）；地址/模型在 settings 表 `ai.baseUrl`/`ai.model`。
- 系统上下文由 `daemon/ai-context.ts` 装配三源（`docs/ARCHITECTURE.md` + `docs/FEATURES.md` + `<dataDir>/market/weave` 下 `SKILL.md`，经 `builtinMarketDir` 定位不硬编码路径）；**docs 找不到即降级只注入技能**（`/ai/status` 的 `docsFound` 供 UI 提示），刻意不做进程内缓存（文件读取毫秒级，不缓存让改文档即时生效）。
- 流式解析全站唯一落点 = `web/src/lib/ai.ts`（`EventSource` 只支持 GET，故用 fetch-reader 手工解帧），别处不得再造一套。
- **流式能力短期记忆**：网关/模型对 `stream:true` 能不能用，试一次就记（键 = 地址#模型，进程内不落库，`STREAM_MEMO_TTL_MS` 24 小时）——记「不行」期间直接走非流式，省掉每次白试的失败往返（LiteLLM 这类网关对 `stream:true` 恒定 500）；**TTL 到期自动忘掉再试一次 = 周期性试探**，试通即转回流式；「流式被拒」与「回 200 但非 SSE（网关无视 stream）」都算「不行」。
- **三源保鲜归 `ai-prompt-auditor` 子 agent**（本仓库**项目级插件** `.weave/plugins/ai-prompt-auditor/`——开发自用，不进内置市场、不对用户分发；该根 daemon 按项目加载、init 把 `manifest.templates` 物化进 `.claude/`，插件模板不受核心组件开关门控；`.weave/.gitignore` 的窄例外 `!plugins/` 让源入库，`ensureNestedGitignore` 只在文件缺席时写、绝不覆写用户改过的 `.gitignore`；`/audit-ai-prompt` 触发）：按事实源逐条对锚代码、产出差异清单并直接改源文件，改完跑 `builtin-market.test.ts` 回归。
- `docs/FEATURES.md` 是 `findDocsDir` 的判据文件（存在性 marker）**不可删**。

## §14 资源管理三层模型

1. **市场副本层**（`<dataDir>/market/<id>/` 导入/移除，LibraryPanel 资源市场侧栏）——移除 = 删副本 + 注销宿主市场（`PluginSurface.removeMarketplace` 按落点反查注册名，best-effort；宿主级联卸载该市场的插件含数据，UI 有破坏性确认），非插件装面副本不级联。
2. **安装/卸载层**（数据目录 → 装到目标位与卸回）——项目 skills/files/MCP、toolkit 包、全局个人 skills 软链、CC 插件包经 `POST /projects/:id/plugins/uninstall`→`PluginSurface.uninstall`，harness 注册表级、与市场源存亡无关。
3. **启用/停用层**——包开关/Switch/settings 落盘。

各层操作互不越级：删市场副本 ≠ 卸载，停用 ≠ 卸载。

## §15 终端落点、可见屏幕与唤出终端

### 可见屏幕 = 落点单位

会话落进已开终端的单位、上限与分块**同为一个「可见屏幕」**（wezterm = 一个 tab；这个单位的定义归各后端——不支持分屏的后端没有「挤在同一块屏里」这回事，不设限、每会话一个窗口/tab）。

上限唯一常量 = `daemon/opener.ts` 的 `MAX_PANES_PER_SCREEN`，三处执行点：

- 几何规则 `planWeztermGrid`（网格长满即 null）。
- 复用挑选 `pickWeztermTab`（满的 tab 跳过 → 全满自然落到新窗口）。
- 定点附加 `runInWeztermAt`（选了满的目标**明确拒绝**，不擅自换地方）。

`AttachTarget.full` 是同一事实下发给前端（选择器照列但置灰，「只有一个直接开」的自动判定只数放得下的）。

### 会话 → 所在屏幕

归后端能力面 `TerminalBackend.locateScreens`（与 `locatePane` 同一份旁路 pane env，纯函数 `sessionScreensFromEnvs`；无枚举能力的后端空表 = 不分组）——`SessionTerminal`（id + 窗口/Tab 号 + 同窗口 tab 数）**id 格式归后端、server/web 不自拼**。

数据面吃既有隐藏刷新（`daemon/terminal-topology-refresher.ts` 快照 = `{counts, terminals}`，帧键 `terminalTopology`）：`GET /sessions` 回上次快照、增量经 push 帧补丁行（web 不自算、不新开探测）；`locateScreens` 走 10s 探活缓存（展示滞后无感），而**投递路径的定位必须实时枚举**（缓存会把消息落进刚关的 pane）。

web 分块唯一实现 = `SessionList` 的 `groupByTerminal`（同屏会话聚成一块，块位 = 首成员位置、块内保持活动序；**块里只有一个会话也照样立块头**——块头答的是「这块屏在哪」，与会话数无关；反查不到的行不分组、原位留在块外）。

### 三处「开终端类」按钮的 loading 同口径

一律挂到「已进入」才收圈（会话行等该会话转绿 / 项目行等该项目终端角标上涨 / 表头「新建会话」等新会话行落进列表），闸唯一实现 = `web/src/lib/await-gate.ts`（数据一变 `poke` 一次、命中或超时放行，**不轮询、不订阅**；`fb.run` 的 loading 在途吞连点靠它撑住），超时兜底不可撤（判据探不到时宁可提前收圈）。不要再写「POST 一返回就收圈」的按钮。

### 项目行「唤出终端」= 卡片弹层

`POST /projects/:id/focus-terminal`。项目行的终端钮不再直接开窗——弹层列本项目已开的终端（`GET /projects/:id/terminals` 的卡片，点一张 = 切到前台）＋末尾常驻一枚「+」照旧开新终端，没有终端时只剩「+」；列表空而角标非零 = 该 preset 不能枚举已开窗口，如实说一句，不装作没有。

- 唤出能力归后端（`TerminalBackend.focusTarget(dir, targetId)`，id 取自同一份卡片数据），无通道的 preset 走基类明确拒绝（409），调用方不判 preset、web 不认终端名。
- **Windows 上抬窗口的唯一抓手 = HWND**，而终端 CLI 都不给窗口号（`wezterm cli activate-pane` 只切 mux 内部焦点、既不抬窗口也不解最小化；`set-tab-title`/`set-window-title` 不落 OS 标题；wt 只有 stdin 通道）⇒ 按「**OS 窗口标题 = 该窗口某个 pane 的标题**」认窗：
  1. 先按进程收窄（wezterm = GUI pid，一个进程多个窗口；wt = pane pid 往上的祖先里找 `WindowsTerminal.exe`，一窗一进程）。
  2. 再按标题消歧——**比较前先归一**（剥 spinner 字与 `[活动 tab/总数]` 前缀），**唯一命中才抬，歧义如实报错不猜**。
  3. 抬 = `ShowWindow(SW_RESTORE)` + 接前台线程与目标线程的输入队列后 `SetForegroundWindow`（Windows 前台锁会吞掉裸调用）。
- 这层抬窗只有 Windows 有；其他平台的 wezterm 到 `activate-pane` 为止（那边未实机验证），其余后端诚实不支持。

## §16 数据目录三档与搬迁

`<dataDir>`（Windows = `%APPDATA%\weave`）下按**能不能迁移**分三档，路径全部只从 `db/paths.ts` 取（`dataRoots()` 是唯一分档口径，下面每个 getter 都落定在一档里）：

| 档 | 内容 | 迁移 |
| --- | --- | --- |
| `data/` | `weave.db`（含 `-wal`/`-shm`/`weave.db.bak-*`）、`market/`（资源市场副本）、`uploads/`（对话图片）、`plugins/`（已装插件内容） | 带走 |
| `local/` | `auth.json`（dashboard 口令）、`ai.json`（AI key）、`push.json`（VAPID）、`certs/`、`initial-password`、`weave-autostart.vbs` | 不迁移：换机器 = 重设口令、重填 key、重签证书、重开自启 |
| `cache/` | `index/`、`logs/`（含 `logs/api`）、`statusline/`、`hooks/`、`tmp/`、`daemon.json` | 不迁移 |

`libraries.path` 的相对基就是 `data/`（`market/<id>` 这类 posix 相对路径），所以市场副本从 `<dataDir>/market` 搬到 `<dataDir>/data/market` **不需要改任何一行库记录**。

### 一次性搬迁（`db/layout.ts`）

旧版顶层散放 → 三档，`ensureDataLayout()` 在 daemon 启动（`startDaemon` 第一句）与 `weave doctor` 开头各跑一次：

- **只 rename、从不删除**：目标已存在就记 `kept` 跳过（旧文件留着供人核对）；rename 失败（被活进程开着 / 权限）同样跳过，下次启动再来一遍。幂等，搬完源就不在。
- **活 daemon 占着数据目录时整个不动**（`liveDaemonPid` 看 `<cache>/daemon.json` 与 `<root>/daemon.json` 的 pid，`process.kill(pid,0)` 探活）：搬走库与流水文件会把运行中的 daemon 拆散。
- **`hooks/` 与 `statusline/` 搬完要在旧位置留目录链接**（win32 junction、其余 symlink）：往这两个目录写的是 `weave init` 生成到项目里的脚本（hook 采集脚本、statusline helper），落点写死在生成那一刻——包里改了路径，存量脚本仍往老位置写，事件就进了没人读的目录。留链接后老脚本照旧写进 `cache/`；下次 `weave init` 换成新脚本后链接只是个空壳。**故改布局后存量项目须重跑 `weave init`**（重装包不修）。
- 两个位置都有同名目录（搬完脚本又写了一次）→ 先**合并**（同名文件不覆盖）再补链接，别干看着丢事。

### 搬迁后自带绝对路径的两类存量

`data/` 整档走 rename，但**里面存着绝对路径的缓存与外部注册不会自己跟着改**：

- **旁挂扫描缓存** `<data>/market/.weave-scans/<库名>/scans.json`：`skills[].dirPath` / `files[].filePath` / `mcp[].sourcePath` 都是扫描当时的绝对路径。搬迁后库路径变了而缓存还在，命中就拿到旧路径，同步时 `cp` 源不存在 → `400 ENOENT ... lstat '<旧路径>'`。故 `scans.json` 记一个 `root`，读侧 `root !== libPath` 整份作废重扫（`install/scan-cache.ts`）——缓存里的绝对路径只有在根没动过时才可信。
- **宿主侧市场注册**（`~/.claude/plugins/known_marketplaces.json`、`~/.claude/settings.json` 的 `extraKnownMarketplaces`）：装市场包时由 `claude plugin marketplace add <数据目录内市场目录>` 写入，路径是写死的绝对路径。搬迁后这些注册指向已不存在的旧位置（宿主启动时报市场加载失败），**须重新 `marketplace add` 或把路径改到 `<dataDir>/data/market/<id>`**；weave 不再自动改写宿主的配置文件。

## §17 配置面（资源管理 · 接管 harness 配置文件）

第 13 个能力槽 `config`：`HarnessDriver.config?: ConfigSurface`。词表（文件落点 / 键形 / 托管键 / 模型接口文法）全归 harness，两个实现 = `weave-harness/src/claude/config.ts`（`CLAUDE_CONFIG`，JSON）与 `weave-harness/src/codex/config.ts`（`CODEX_CONFIG`，TOML）；server 只做「取档 → 读改写 → 快照与漂移」的装配，web 只渲染。无此槽的 harness → `GET /harness-config/catalog` 回 `supported:false`，前端渲染占位、不写 harness 名白名单（能力清单由 `GET /capabilities` 的 `config` 行给）。

**活文件的表示格式归 harness**：`ConfigSurface.rawFormat`（`'json' | 'toml'`）+ `parseRaw` / `serializeRaw`——原始视图的编辑语言、快照与漂移 diff 的两侧文本、catalog 响应都按它走；server 不写 `JSON.parse` 硬编码。

### claude 的四档文件（`ConfigSurface.files(ctx)`）

| id | 落点 | 文档 Scope | 快照 |
| --- | --- | --- | --- |
| `user` | `~/.claude/settings.json` | `user` | 有 |
| `project` | `<project>/.claude/settings.json` | `project` | 无 |
| `projectLocal` | `<project>/.claude/settings.local.json` | `local` | 无 |
| `global` | `~/.claude.json` | `global` | 有 |

项目路径由 server 按 `projectId` 查库得出，**绝不接受前端传路径**。`project*` 两份不含快照（`files[].profiles:false`）：它们是项目级、随项目走，快照只对「本机全局语境」有意义。

### codex 的两档文件与 TOML 语义

| id | 落点 | 快照 |
| --- | --- | --- |
| `user` | `~/.codex/config.toml`（`CODEX_HOME` 缺省 `~/.codex`） | 有 |
| `project` | `<project>/.codex/config.toml` | 无 |

- **分层合并是 codex 自己的事**（PackagedDefaults < MDM < System < EnterpriseManaged < User < Project < SessionFlags，递归表合并、标量/数组整体替换）——weave 只编辑单档文件，不模拟合并；但 **project 档的词表剥掉 codex loader 的 `PROJECT_LOCAL_CONFIG_DENYLIST` 12 键**（`model_providers` / `profiles` / `notify` / `otel` 等，project 层写了也被无视，生成器标 `scope:'user'`）。
- **信任闸**：project `.codex/config.toml` 只在目录被 codex 信任（`[projects."<path>"] trust_level`）时生效——weave 如实展示文件内容，信任与否是用户在 codex 里点的事。
- **TOML 写入保格式**（`codex/toml.ts`）：行级增量编辑（注释/键序/无关节原样），`setTomlValueInText` / `removeTomlValueInText` 走点号路径；inline 父表（`tui = {…}`）深层写入时提升为 section 挪到 EOF（原位插头会吞父节余键）；损坏 TOML 拒读写（`CodexTomlCorruptError`）。`serializeRaw`（整份重建）只用于 raw 视图整写与快照回放。
- **托管判据 v1 从宽**：weave 的 MCP 安装（`[mcp_servers.weave]`）与插件启停（`[plugins."<key>"] enabled`）和用户在 codex 里手编同一张表是**两扇门写同一个值**，不上锁（`managedEntries` 恒空）；只把 `mcp_servers.weave` 标出来提示来源。
- **models()**：codex 无可匿名调的 HTTP 模型接口；`model_catalog_json` 指向的本地 JSON（codex-rs `ModelsResponse`，取 `slug` / `display_name`）是自定义 provider 唯一可靠词表源，没配就诚实回空。

### 词表 = 官方文档/schema 的生成物

- claude：`settings-reference.md`（设置键）+ `env-vars.md`（环境变量）→ `scripts/gen-claude-catalog.mjs` → `settings-catalog.generated.ts`（307 键 / 17 组 / 391 env）。重生成 `pnpm gen:catalog`（`--from <目录>` 走已下载的 md）。
- codex：codex-rs 同仓提交的 `core/config.schema.json` → `scripts/gen-codex-catalog.mjs` → `config-catalog.generated.ts`（426 键 / 17 组）。重生成 `pnpm gen:codex-catalog`（`--from <codex-rs 目录>`）。枚举/说明/默认值是 schema 英文原文；`tui.keymap`（171 叶键位表）与 `notice`（宿主状态记账）整键折叠；固定属性与 map 并存的键（`agents` / `apps` / `plugins`）两面都出（父键标 map + 固定属性照常递归）。

运行期**不联网**；说明文案是官方英文原文（截断、剥链接），不翻译——翻错了比英文原文更难核。

- 键 = **点号路径**（`sandbox.filesystem.allowWrite`），嵌套结构天然在路径里；`README` 表格里的 `Fields for <key>` 解析成子键。
- 档位可见性：`global` 档只给 `scope === 'global'` 的键、且不给 env 表；其余档 = `any` + 本档专属。**`read()` 同口径投影**——档外的键既不展示也不写回。
- 类型不是猜的：`Boolean` / 枚举（文档 `one of` 或列举的引号值 → `options`）各自的控件由 `options` 有无决定；类型串太长的按分号截断并标 `…`。

### 值形状：`shape` / `fields` / `valueType`

标量之外的值要能**逐字段/逐项**编辑，靠 `ConfigKeySpec` 上这四个字段答「值长什么样」（都从文档的 Type 从句派生，不是手写）：

| 字段 | 答什么 |
| --- | --- |
| `shape: 'map'` | 键名由用户起（模型名、插件 ID）→ 拼不成点号路径的子键，web 用「一行一键」编辑器 |
| `shape: 'array'` | 有序列表，**一律标出**（连标量数组也是：weave 的托管条目锁在行上，整段文本域做不到按行只读） |
| `fields[]` | 值（map）/ 元素（array）是对象时有哪些字段，各带自己的 `type` / `options` |
| `valueType` + `valueOptions` | 没有 `fields` 时值（map）/ 元素（array）是标量：类型与枚举 |

解析上的两个坑（都踩过）：

- **`options` 不再是万金油**。Type 从句里的项目符号两种都长一样（`* \`x\`: …`），带引号的是**取值**、不带引号的是**字段名**；全塞进 `options` 会让 `modelSettings` 这类对象键出成一个下拉框。现在分开：字段进 `fields`，取值进该字段的 `options` 或 `valueOptions`。
- **map 的「to」之前说的是键**（`object mapping <model name> to an object with …`），只解析「to」之后的从句，否则键名（`plugin-name@marketplace-name`）会被当成字段。

文档只在从句里写「with `a`, `b`, and `c` arrays of prose rules」的对象键（`autoMode`、`spinnerVerbs`），生成器补出子键、类型取共用那句。散文化的数组元素（`modelPicker.options` 等 8 个键）与 `modelPricing.overrides` 落**覆盖表** `weave-harness/src/claude/config-shapes.ts`（按点号路径索引，harness 知识、不进生成物）；`config.test.ts` 兜住「文档改名后覆盖表静默失效」与「数组类键缺 `fields`」。

### 托管判据：weave 真写进去的那一部分

两个面，粒度不同：

- `managedKeys(values)` 答**整个键**是 weave 的：`['$comment','hooks','env.WEAVE_ENABLED']` + `statusLine`（仅当命令指向 weave，判据 = `statusLineIsWeave`）。web 渲染成 `<Lock/>` + 「weave 托管」并指向对应面板。
- `managedEntries(values)` 答**行级**托管，只报值里真在的：`permissions.allow` / `permissions.deny` 里 `weave init` 加的那 6 条（常量 = `settings-gen.ts` 的 `WEAVE_PERMISSIONS_ALLOW` / `_DENY`，与 init/uninit 同一来源）；`enabledPlugins` 里以 `@weave` 结尾的键（weave 只写自己市场的插件，`figma@claude-plugins-official` 这类用户装的不是 weave 的）。web 把这几行标只读，同一容器里用户自己的行照常增删。

**`permissions` / `enabledPlugins` 不整键托管**：以前按「顶层键存在」判（`MANAGED_PATHS` 含它们），结果一条 weave 规则都没有的文件也被整块锁死，连 `defaultMode`（`bypassPermissions` 就是它的取值）都改不了、用户从官方市场装的插件也动不了。判据必须是内容而不是键在不在。

**为什么托管**：这些是 `weave init` / 状态栏 / 插件面写进去的，表单删了会被下一次 init 合并加回来，用户看到「改了又变回来」。逃生口是原始文件视图，那里照写不误。

### 写盘语义

`write(file, ctx, values)`：读**原文** → 只替换「该档词表可见的顶层键」→ tmp+rename 原子写、2 空格 + 尾换行。未知键与没动过的键**保持原位**（就着原对象改、新键追加在末尾）——改成「先收集未知键再拼回去」会让整份文件的键序翻个面，`settings.json` 进版本库的项目每次写都多一大片假 diff。`deletes` 靠 `applyUpdates` 的 `remove:true`（深路径删），危险段（`__proto__` / `constructor` / `prototype` / 空段）一律拒。`global` 档因此只碰文档列出的键，`projects` / `oauthAccount` 等宿主自己的键原样留着。读上限 2MB；文件不存在 = `{}`；非法 JSON 直接抛（**不覆盖**）。

- 原始视图（`PUT /harness-config/raw`）先 `surface.parseRaw`（格式归 harness）再走同一个 `write`，所以「原始文件里删掉一个键」只在词表内键上生效，未知键不会被顺手清掉。
- 每次写前 `pushBackup`（`backups/<file>-<ts>.json`，留最近 20 份），`restoreBackup` 反向写回。

### 快照 / 漂移 / 切换

落点 `<local>/harness-config/<harness>/`（`getHarnessConfigDir()`）：`profiles.json`（`{ file: { activeId, profiles[] } }`）+ `<file>-<id>.json`（整份快照）+ `backups/`。放 `local/` 是因为**快照里可能带 API key**：本机专属、不进 settings 表、不随迁移带走。

- **漂移只来自外部改文件**：本面板的写入口（values / raw / 切换 / 恢复）每次都把结果同步进激活快照，故 `liveText !== activeText` 必然意味着有人在外面改了文件。打开面板即比，横幅里给「看差异」/「用文件覆盖库」（`acceptDrift`）。
- **切换是两拍**：`activate` 不带 `confirm` → 只回 `{ requiresConfirm, liveText, profileText }`，web 弹 `DiffDialog` 交用户确认；带 `confirm:true` 才备份 + 整体覆盖 + `setActive`。**不先弹 diff 就覆盖等于偷偷改宿主配置**。
- diff 是自写的行级 LCS（`web/src/lib/text-diff.ts`，`MAX_LINES` 超限退化成整段替换），不引依赖；比对文本 = `surface.serializeRaw(values)`（格式归 harness），两侧同口径才不会满屏假差异。

### 拉模型列表

`POST /harness-config/models`：baseUrl 取 入参 → 配置 `env.ANTHROPIC_BASE_URL` → `https://api.anthropic.com`（尾部 `/v1` 收齐后再拼 `/v1/models?limit=1000`，因为有人会把 `/v1` 一起填）；凭据取 入参 → `env.ANTHROPIC_API_KEY`（`x-api-key`）→ `env.ANTHROPIC_AUTH_TOKEN`（`Authorization: Bearer`）。响应只回 `{ models, baseUrl, credential }`——**key 永不回显**，`credential` 只是个「用的哪一种」的标签。10s 超时，非 2xx 带状态码与 200 字正文。

### web 侧

`资源管理` 页第三枚视图 tab「配置」→ `HarnessConfigPanel`（harness 页签即 `GET /capabilities` 的 `config` 列表）：档位选择、快照条、搜索/过滤、**配置树**、模型卡、原始文件视图（编辑语言随 `rawFormat`：claude=JSON / codex=TOML，即时校验同语言）、备份行、漂移横幅。**档位按视图分工**：项目页只摆 `project`（+ claude 的 `projectLocal`），全局页只摆 `user`（+ claude 的 `global`）——在项目语境里顺手改到全机配置是最容易出事的一类误操作。裁的是「怎么摆」不是「能不能读」。

树怎么拼（`buildConfigTree`，纯函数在 `web/src/lib/config-form.ts`）：

- **顺序先按文件**：文件里出现过的键按 JSON 原文顺序立节点，词表有、文件没有的键再接在后面——看第一眼就是自己那份文件的形状。
- **同层父节点合并**：文件里的 `sandbox.enabled` 与词表的 `sandbox` 落到同一个 `sandbox` 节点，节点自带 spec 只在「没有子节点」时才出控件（`hooks` 这种整体就是一张 JSON 的键不拆开、出 JSON 框；`sandbox` 出的是子键）。
- **词表没收的键照实列出来**（`extra`，只读 + 标「词表未收录」）：文件里真有而文档没写的键，隐瞒它就等于让人以为文件是干净的；改这类键只能走原始文件视图。
- **`env` 也是树上的一支**（claude；codex 词表无 env 块）：孩子 = 已设置的变量（`env.*` 由面板按 `catalog.envVars` 现拼 spec，**值的控件按变量 `kind` 出**：Boolean→开关、枚举→下拉、number、list），搜索时再补文档里命中的（上限 50）；节点底部一行输入框，候选就是文档里那 391 个变量名（统一 Combobox：虚拟滚动 + 可搜 + 自由输入，说明文字在变量名下一行小字），选中即落一条 `env.<NAME>` 待保存。不再单独开一块 env 区。
- **默认展开只到「里面有已配置值」的对象**：一屏先看到自己配了什么，没配的嵌套结构折着；搜索或过滤生效时强制全开（否则命中项藏在折起来的分支里）。「全部展开/收起」把这些选择落成显式状态。
- **过滤默认档 = 「已配置」**：文件里没有 key 的键默认不出现（用户原话「隐藏指的就是没有 key 的场景」），「全部」才把词表里未配置的亮出来，「只看未配置」反向。搜索时三档都放行命中项。
- 叶子行 = 键名 + 按类型出的控件（Boolean→开关、枚举→下拉、数字→输入、对象→JSON 框），未设置的给「写入」（写文档 Default），info 钮展开说明+文档分组+默认值。
- **整棵树是内联树，不是两列表单**：每一行 = `箭头 + 名称 + "=" + 控件`（顶层键同样），**没有对齐的固定名称列**。`shape` 的逐项编辑器（`ConfigValueRow` 内的 `MapField` / `ListField`，外面套 `ShapedField` 折叠壳——折起来只露条数，≤3 项默认展开）用同一形态：条目 = `EntryNode`（map 可改键名 / 数组只显示 `#n`，行尾 ↻ 清空、🗑 删除），对象值**递归成缩进子树**（`ValueNode`）：词表字段按序、其余实际键接在后面，自由键的键名可直接改，对象数组同级递归，标量数组仍是多行框。深层对象（`mcp_servers.<name>.oauth` / `env`）不再是 JSON 框——实际键一行一个，`+` 加一行、`🗑` 删一行、`↻` 清空该节点。**草稿留在节点本地**（`committed` 记最近一次提交的 JSON，只有外部值真变了才回灌）——否则键名还没敲完就整份回写、行会当场消失；全空的行（空串/空对象）不写进文件。
- **折叠**：只有搜索强制全开（命中项不能藏在折起来的分支里）；过滤档不影响折叠——默认档「已配置」下曾因 `filter !== 'all'` 恒真，点箭头毫无反应。
- **待保存条**：顶栏「N 处待保存」悬停即列清单（每条 `路径 → 新值/删除`，值压成一行、超 80 字截断）；env 的 key 一经选定就落成待保存行（值下一步填），不再要一次「写入」。
- **托管锁到行**：`view.managedEntries` 里属于这个数组路径的那几条渲染成只读文本 + 锁标，同一数组里用户自己的行照常增删（判据与 `managedKeys` 互补：整键锁 vs 行锁）。

纯函数落 `web/src/lib/config-form.ts`（`buildConfigTree` / `pruneTree` / `treeHasValue` / type→控件 / 点号路径→值 / 文本→值 / `shapeOf` + map 条目与元素字段的读写 `mapEntriesOf`·`mapOfEntries`·`fieldValueOf`·`withFieldValue`·`emptyItemOf`）与 `text-diff.ts`。

## §18 首页仪表盘（全局总览）

全局模式的默认（任务）页顶部 = `DashboardOverview`：四张总量卡（接管会话 / 事件总数 / 项目 / 近 1 分钟事件）+ 一张事件速率图（1 小时 × 360 格，每格 10 秒）。只在 `globalMode && mainCategory === 'tasks'` 摆，切到别的分类不跟。

**数据全部走 SSE 推送，没有一次性拉取的 HTTP 面**（仍是 §9 的单通道：不加第二条 EventSource，只在既有 `/events` 上多了 `dashboard.*` 帧型）：

- **连接即流式补历史**：`SseHub` 的 `onAttach`（首个订阅者 / 宽限期后重挂）→ `startDashboardPusher` 先推一帧 `dashboard.totals`，再把这一小时按 10 分钟分块推 `dashboard.series`（6 帧）——前端每收到一块就落一段图，不等整段查完。SSE 连接早于仪表盘组件挂载（App 启动就建），首连那份会被错过 ⇒ 组件挂载时打一枪 **`POST /dashboard/refresh`（空载荷）** 让服务端重推一次；数据本身仍只走 SSE。
- **此后事件驱动**：pusher 订阅 `event.ingested`，1 秒内的入库事件合并成一帧 `dashboard.delta`（最近 12 格 + 总量）；**没有事件就不发帧**，不设空转节拍。
- **速率读进程内快照**：`DashboardRateCache`（`hooks/dashboard-rate.ts`）——每条 ingest 往当前 **10 秒桶** +1（主线程 `handleIngestedRecords`，O(1)），总量/今日同拍累加；保留 24h（清理节流到每分钟）。只有 daemon 起来后**首次 attach** 才从库回填一次（`HookEventRepository.seriesBySecond`，按项目循环走 `(project_id, created_at)` 索引——裸 `WHERE created_at >=` 是整表扫），回填与已计入帧取 **max**，不翻倍。项目/会话数最多一分钟重取一次；事件/今日零查询。
- **浏览器侧缓存**（`localStorage` 键 `weave.dashboard.v1`，5 秒节流写）：存最近一小时的桶 + 总量，**24h 过期**、每次落图顺手裁掉窗口外的桶（过期/损坏/超配额一律当没有）；刷新页面先拿缓存直接开画，服务端块到了就地覆盖、增量到了就地更新——服务端不必为「刚打开」多算一遍。**不落盘**：服务端只有进程内桶（24h 上限 8,640 个，节流清理），仪表盘不新增任何表或文件，磁盘不会因此增长。
- **偏移量**：传输层沿用 §9 的帧编号 + `?since=` 补发，断线重连能续上；仪表盘帧与其它 hook 帧同一套序号，不另造协议。

web 侧 ECharts 走**动态 import + 按需模块**（`echarts/core` + `LineChart` + `GridComponent` + `TooltipComponent` + `CanvasRenderer`），独立 chunk、只在仪表盘挂载时加载；`animation:false`，每次帧只 `setOption({xAxis:{data}, series:[{data}]})`；容器尺寸变化用 `ResizeObserver`；轴标签按容器宽度抽稀（窄屏每 10 分钟、桌面每 5 分钟）。

## §19 回合完成判定（classify handler · 已退役 2026-10-23）

> **已退役**：与编排的「自然回合（autoFire）+ when 预筛 + condition 判断」是同一件事的两套实现，裁决收敛进编排画布（触发/过滤/判断的唯一配置入口；见 §4.13 边闸两道与本节存档）。`HandlerConfigSchema` 与 `dispatcher.runClassifyAsync` **保留兼容读**——存量 classify 规则仍会执行，但 UI 不再露出、不可创建/编辑，删一条少一条。

退役前的机制（存档）：规则来源 = `Stop`（`raw.last_assistant_message` 即本轮最终输出）。预筛（`prefilter` 任一关键词命中才继续，零成本）→ fork 无头子 agent 判定（复用 `edgeExtract.run`，模型只回一行 JSON `{label, reason?}`）→ `label` 命中 `routes[].label` 才 `postJson` 出站（可带 `secret` HMAC）→ `cooldownMs`（默认 10 分钟）防下游回投的回环。fork 不支持的 harness 判定拿不到结果，按 `no label` 结束（不报错）。
