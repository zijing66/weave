# Weave — 功能总览（当前态）

> weave 是多 harness 的 coding-agent 管理工具：`weave init` 往项目里注入 harness 能力，后台 daemon 采集事件，web dashboard 提供全局项目 × 会话的统一视图。支持 Claude Code 与 Codex 两个 harness（能力差异见 `docs/ARCHITECTURE.md` 的槽表；行为硬约束见仓库 `CLAUDE.md` 的 Architecture 节）。
> 本文只列**当前已实现**的功能。安装与命令速查另见内置技能 `weave-user-guide`。

## 一、CLI 命令面（8 个顶层命令）

| 命令 | 作用 | 常用参数 |
|---|---|---|
| `weave init` | 在当前项目初始化 harness：目录树（`.claude/`、`.weave/`）、settings 合并、helpers、`.mcp.json`、CLAUDE.md 生成块、skills/commands/agents 模板、插件模板注入 | `-p minimal/default/full`、`--force`、`--no-interactive`、`-d <dir>`、`--harness claude,codex`、`--hooks` |
| `weave uninstall` | 移除 init 生成物（init 提交恰为 HEAD 时回滚指针，否则生成卸载提交） | `-d <dir>` |
| `weave status` | 查看当前项目 harness 状态 | `-d <dir>` |
| `weave daemon start\|stop\|status` | 管理后台守护进程（start 不开浏览器） | — |
| `weave dashboard` | 在浏览器打开 web 控制台（必要时先起 daemon） | `--no-open` |
| `weave scan` | 扫描并注册 weave 已初始化的项目 | `-d <dir>` |
| `weave chpass <新密码>` | 修改 dashboard 登录密码（本机执行免旧密码；dashboard 端无改密入口） | — |
| `weave doctor` | 诊断本机与 weave server 的接线（检出是否注册、daemon 可达性）**+ 消息投递诊断**（采集脚本是否 weave 生成并上报凭据 / 逐会话三通道可用性与队列积压，中文修法提示） | `-d <dir>` |

init 的写文件纪律：`.weave/` 内 weave 自有文件可刷新、用户文件仅追加合并不覆盖；CLAUDE.md 只有 `weave:start/end` 块是生成的；根 `.gitignore` 与用户改过的嵌套 `.gitignore` 永不覆写；`.claude/`、`.weave/` 各带自忽略 `.gitignore`（想跟踪项目级插件源需窄例外，见第五节）。

## 二、daemon 与 dashboard 功能域

**项目列表**：前端活动序（lastSeenAt 倒序、新会话置顶、静默沉底，1 分钟周期统一落地 + FLIP 动画）；行内开终端 / 开资源管理器快捷（终端窗口数角标，后端隐藏刷新器探测）；「有更新待同步（n）— 点击立即同步」角标（对照已装资产与库源 + 项目自有 weave 源 `.weave/plugins` 的模板漂移；`push` 帧绝对值快照优先、hover 懒拉兜底，源变更 / 同步落地 / 新客户端接入即对账；点击 `sync-all` 覆盖物化模板）；autoSync 开关（开着则后台自动同步）；归档（清空历史会话与管道文件、可恢复）；拖拽排序；已接入 harness 标签（init 选择结果，每 harness 一枚 `harness-meta` 配色的 tag）。

**会话列表**：顺序 = 前端活动序（lastSeenAt 倒序、活跃上浮、静默沉底；1 分钟周期统一落地 + FLIP 滑动，既有行不随事件抖动）；数据随 SSE 事件流实时刷新；**按终端分块**（同一块可见屏幕上的会话聚成一块，块头标终端 + 会话数；块里只有一个会话也照样立块头——块头答的是「这块屏在哪」，反查不到所在屏幕的行不分组、原位留在块外）；表头「新建会话」——把 harness 裸 bin 打进本项目**已打开的终端**（复用其 pane 分屏；**一块可见屏幕最多 6 个 pane**，满了只能新开终端），起哪个 harness 由本项目 init 选择结果定（多个能起的弹窗选、一个直接起、一个都起不了置灰）；没有已开终端（终端数角标为 0）时置灰、服务端同时 409 把关；行内改名（`pending_title` 随下一拍 hook 回执生效）；行内开终端（按钮 loading 一直挂到该会话转绿为止——`pidAlive` 由 liveness push 补丁，30s 兜底放行，防在「已 spawn、绿还没到」的空窗里重复点出第二个 `claude --resume`；**三处「开终端」按钮同口径**：会话行等转绿、项目行等终端角标上涨、表头「新建会话」等新会话行落进列表，共用 `lib/await-gate.ts` 一把闸——数据一变 poke 一次、命中或超时才收圈，没有「POST 一返回就收圈」的按钮了）；在途消息角标（`push` 帧绝对值快照，事件驱动非轮询）+ 对话图标 amber 态；**新建会话的首个 hook 事件一落就进行列表**（仅一条 SessionStart 也算，不再等首条 prompt）；无 prompt 幽灵会话 10 分钟自动清理（行内倒计时 tag 就是剩余保留时间）；会话删除走级联清理。**会话状态七态**（运行中 / 压缩中 / 失败 / 打开 / 关闭 / 已终止 / **已中断**）由 `session-status.ts` 单点推导，行状态点、项目行计数、事件链组头、对话弹窗尾标全部同源；**已中断** = 用户按 ESC 打断这一轮——hook 域没有这个事件（实测 45 次里 41 次连 Stop 都不发），服务端读 claude **转录尾部**的中断标记判定（晚于最后一条事件才算，故自愈），展示口径同「打开」，且不再露停止按钮。

**全局任务总览**：跨项目聚合（项目下拉 + 时间段筛选，客户端过滤）；行序与会话列表同口径（同一份冻结活动序，跨项目混排不分组）；行点击跳进对应项目任务视图。

**事件链（LifecycleMindmap）**：会话事件的树状生命周期图——转场节点、subagent 子树、指令挂点；pending 指令路径 amber 高光沿 event → group 回传。画布底纹与底色可调（网格 / 点阵 / 十字 / 无 + 默认 / 蓝 / 紫 / 绿 / 琥珀底色，画布右下角一枚小工具条），深浅色自动适配、选择存 localStorage，事件链 / 编排画布 / hooks 链路三处共用同一份偏好。

**指令池（hooks dispatches）**：规则触发的指令走 pending → injected → running → succeeded/failed/timeout 生命周期；`auto`（事件自动派发）/ `manual`（人工补派）两模式；指令链路与事件链联动高光。

**hooks 规则与插件面**：规则包（内置 `rules/` + 市场安装）可启停；插件按 builtin / user / project 三作用域加载，项目级启停覆写；插件热重载（文件变更防抖重扫）；插件包安装 / 卸载（走 harness 能力面）。

**问答面**：阻塞式问题（AskUserQuestion / 计划确认 / 权限确认）的远程作答——会话行问答角标 + 弹窗按钮镜像终端模态框的键序作答。三种形态都由面自己决定：多问 / 多选面按宿主同款渲染成「逐问勾选 + 收尾屏」表单，一次性提交整份作答（未答完禁用提交）；单问单选的单问面点行即答；**预览形态**（宿主对「单选 + 任一选项带预览」换的左右分栏）渲染成「左选项 | 右预览原文 + `Notes:` 备注行」，选项行只挪高亮（提交另按发送键）、尾行「Chat about this」不编号、**没有** Other 行、不渲染选项描述。弹窗尺寸按形态给缺省（预览形态宽得多），桌面可拖右下角调整、按形态各记一份，`<lg` 整屏单列（不出现拖角、预览分栏塌成上下堆叠）。权限确认自动补最近工具上下文；daemon 重启后从事件重放重建待答面。

**消息域**：三个触发源 × 自动三层投递。手动发送（dashboard 弹窗，无模式选项——恒走 prompt 通道按优先级自动完成）、会话提醒订阅、**多份命名编排**（任意有向图，成环在保存时拒、单次运行投递预算 200 兜底；消息传递推进——源会话每完成一轮就投递所有出边，目标每收一条被激活一次；目标判死自动拉起终端、拉起后等它的 inbox 凭据就绪再投（到达前启动 + socket 就绪）；连线可勾「附带源会话这一轮的输出」（正文只写指令也行——那就只转发上游那段最终输出；上游还没说过话就不带、整条没有可送内容则记一次失败不投空消息）；有边要带输出时**先向源会话要一份「交接总结」再往下传**（`handoffPrompt` 可改，空则用内置那句；总结那一轮结束才 fan-out，投不出去就照旧直接 fan-out）；手动 / **webhook**（载荷作首步消息）/ **cron**（可视化表达式）三种触发；一次触发一行运行日志，全局统一列表可查、自动留 7 天 + 每编排 100 条并可手动清理；重启后在跑的 run 标 interrupted 不自动续跑）。prompt 通道：**①-a 会话 inbox socket 直投**（毫秒级、零进程，编排域排第一；手动面恒走终端以保证用户权威）→ ①原生中继（claude SendMessage，目标会话可见 `Message from @weave`）→ ②终端 send-text 兜底（经终端后端泛化，bracketed paste + CR 提交）→ ③promptbox 队列（daemon 写、hook 消费，双触发冲洗）。投递终态在途视图可查 `via` / 回执；prompt 送达未回执或投递失败会暂停该会话队列冲洗，回执命中或手动重发解闸。 **对话弹窗**（会话行图标）：用户投递的 prompt + 每轮 Stop 的最终总结（`raw.last_assistant_message`），不落库、只查既有事件流（开/闭轮两类事件 + `beforeId` 游标翻页）——默认最新 10 条、向上**拉动**加载更早（贴顶不取，继续滚/拖够一截才取一页）、已翻页留前端、逐条时刻戳；投递行的 `via`/回执/重发挂在被认领的气泡上，Held/失败/暂停闸成因排在尾部；两侧气泡都走 markdown 预览（同一渲染器，用户原文的段落保留软换行）——**发送（右）蓝底、回复（左）中性灰**，一眼分得开；**发送键左侧**带**停止按钮**（判据 = 回合开着才露、已中断不露，与事件链组头同源）、**历史过滤**（全部 / 我发的 / 回复）与**多选导出**（桌面右键菜单、触屏长按进入；**全选** = 已加载的全部条目，不随过滤变；勾选后**复制到剪贴板**（带本地 `YYYY-MM-DD HH:mm:ss` 时刻戳）或**分享图片**——canvas 卡片，正文按窗口那套 markdown 预览排（标题/列表/代码块/引用/表格都照着画），可复制到剪贴板或下载 PNG）；窗口宽度默认跟屏幕走（宽屏优先，桌面可拖角改大小、拖标题栏挪位），窄屏铺满单列。 **投递诊断**（只读）：`GET /messaging/diagnostics`（`?project=` / `?session=` 可选）汇总「采集脚本 × 会话 × 通道 × 队列」——脚本是否 weave 生成、生成版本、能否上报 inbox 凭据与 pane env；逐会话列出直投 / 中继 / 终端三通道各自 `ready / unavailable / unknown` 与原因、队列条数、暂停闸、存活三态、提示码；`weave doctor` 打一节人类可读版（中文修法）。**纯被动派生**（不连 socket、不枚举 pane、不起中继子进程），**凭据（socket 路径 / token）永不进响应**。

**提醒订阅**：按会话订阅触发类型集（`idle` 空闲 / `turnEnd` 回合结束 / `messageFailed` 投递失败）+ 次数（NULL = 持久化）；命中经三通道通知——页面内 toast、浏览器系统通知（安全上下文 + SW）、Web Push（页面关掉仍可达，VAPID + aes128gcm，订阅撤销自愈）。触发即重新拉取目标会话状态。

**AI 助手**（dashboard 右下角浮层，配置齐才显示）：服务端代理转发到 OpenAI 兼容端点（`POST {baseUrl}/chat/completions`），流式增量转自家 `{delta}/{done}/{error}` 帧；网关不支持流式时自动记 24 小时并降级非流式；api key 只写不回显。

**设置面**：`server.bindHost`（默认 `0.0.0.0`，可改回 `127.0.0.1`）、`server.tlsPort`（HTTPS 双监听，0 = 关）、`ai.baseUrl` / `ai.model` / `ai.apiKey`（只写，GET 只回 `apiKeySet`）、终端后端预设。

**资源管理三层**（互不越级）：①市场副本层——资源市场侧栏导入 / 移除（`market/<id>/` 副本，移除插件装面副本有破坏性确认；本地目录导入走跨平台目录树选择器，顶部一行完整绝对路径——树里勾选即在其中显示，也可直接粘贴路径加入选择）；②安装/卸载层——装到项目 skills / 文件资产 / MCP / 工具箱包 / 全局个人 skills / harness 插件注册表；③启用/停用层——包开关 / settings 落盘。**工具箱**五形态包：`skill` / `rule` / `mod`（hooks 规则 + 处理器）/ `hook` / `surface`（裸 agents/commands 解包进项目 `.claude/`）。**全局文件资产**：`~/.claude`、`~/.codex` 下受控白名单文件树管理。市场更新检查（`check-updates`）与刷新（`refresh`）。

**harness 配置面**（资源管理第三枚视图 tab「配置」）：按官方文档词表接管 claude 的配置文件——`~/.claude/settings.json`（用户）、`<项目>/.claude/settings.json`（项目）、`.claude/settings.local.json`（项目本地）、`~/.claude.json`（全局键）四档。词表是文档生成物（248 键 / 17 分组 / 391 环境变量，含 experimental 项），**所有键都可见**：未配置的给「写入」（按文档 Default 落值），Boolean 出开关、枚弹出下拉、数组/对象出 JSON 框，也可切原始 JSON 视图整份编辑；weave 托管的键（hooks / permissions / enabledPlugins / WEAVE_ENABLED / weave 的状态栏 / `$comment`）表单只读并标注指向哪块面板。写盘只替换该档词表内的顶层键、未知键（`~/.claude.json` 里的 `projects` 等）原样保留，每次写前留备份（20 份可回滚）。**多份本地配置**（仅用户/全局两档）：新建 / 复制 / 改名 / 删除，切换前弹 **diff modal** 确认再整体覆盖；打开面板读的是文件最新内容，与激活快照不一致时顶部横幅提示「看差异」/「用文件覆盖库」。**模型**：填网关地址 + key（缺省取配置里的 `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`）拉模型列表，一键写进 `model`；key 只写不回显。codex 暂无配置面，页签下给占位说明。

**statusline**：默认 / 全局两档状态栏配置预览与编辑（块的增删、拖拽排序、模板与配色、电源线合并）。配置同时驱动 claude 的 TUI 状态栏（生成 `.claude/helpers/statusline.cjs` 并接到 `settings.json`），**对话页底部也有一条**：按同一份配置忠实渲染，但只摆 weave 当下有数据的块（项目 / 会话 / 模型 / 时刻），宿主 stdin 才有的字段（context / tokens / cost / rate）不摆，一块都摆不出就整条不出现；git 三块（分支 / 身份 / 改动行数）取宿主渲染脚本落在缓存里的那份（同 TTL 口径，过期不认，不自己跑 git）；`thinking` 取 hook 事件自带的 `effort.level`；整条**横向滚动**（块多了不折行、不被裁，行不各滚各的）；这条**只读**，配置的唯一入口是个性化配置里那个面板（面板头部标「TUI 注入」），「哪些 harness 会注入 TUI」由能力表答（今天只有 claude）。对话页输入框**顶边可拖高**（2~20 行，记住），会话浮窗的**尺寸与位置**也都记住（localStorage）。

**fs 浏览**：服务端受控的文件树浏览（`/fs/roots`、`/fs/children`），供资产选择器等消费。

## 三、认证与网络

- 口令材料落 `<dataDir>/auth.json`（0600）：密码（scrypt hash）、30 天无状态签名会话 cookie、本机令牌 `x-weave-local`（CLI 与 hooks 免密——同机同用户即管理员）。
- 改密只走 CLI（`weave chpass`）；web 侧 401 一律打回登录页、未登录不建 SSE 连接；`/health`、`/auth/*` 与静态资源豁免。
- 监听：HTTP 按 `server.bindHost`；可选自签 HTTPS 第二监听（`server.tlsPort`，证书自动重签、失败降级仅警告）；访问地址枚举由 `weave daemon status` 与 `GET /settings` 的 `urls` 同源给出。手机浏览器要系统通知必须走 https origin。

## 四、采集与数据

- Claude Code 的 hook 事件经采集管线入 daemon → sqlite 镜像 + SSE 帧推送（`asset` / `project` / `hook` 是既有帧域，`push` / `invalidate` 是数据域）。
- inject 通道回程走 outbox（随目标会话下一拍 hook 送达，非抢占）；promptbox 队列与 outbox 严格分离。
- 数据目录 = `<configDir>/weave/`：`daemon.json`、`auth.json`、`ai.json`、`push.json`、`market/`、`hooks/`、`certs/`、`weave.db`。
- 事件有全局保留期；收到过 prompt 的长会话只按保留期清理，绝不走自动删。

## 五、项目级插件根（`<project>/.weave/plugins/`）

放在约定位置即被识别（项目作用域，不全局化）：

- `weave-plugin.json` 声明 `rules` / `handlers` / `mcpServers` / `templates`；daemon 按项目加载（scope = project）并热重载；`weave init` 把 `templates`（skills / commands / agents）物化进项目 `.claude/`，插件模板不受核心组件开关门控（插件被识别即 opt-in）。
- 想让源进版本库：`.weave/.gitignore` 加窄例外（`!plugins/` + `!plugins/**`）——init 不会覆写用户改过的嵌套 `.gitignore`。
- weave 仓库自用示例：`ai-prompt-auditor`（`/audit-ai-prompt`）。

## 六、AI 助手上下文与保鲜

- 系统上下文由 `daemon/ai-context.ts` 现场装配、无缓存：固定前言 + `docs/ARCHITECTURE.md` + `docs/FEATURES.md`（本文）+ 内置市场全部 `SKILL.md`（上限 40 文件 / 60k 字符）。`docs/FEATURES.md` 是 docs 命中判据文件（存在性 marker），**不可删**；安装态找不到 docs 则降级只注入技能（`/ai/status` 的 `docsFound` 可查）。
- 三源新鲜度由项目级插件 `ai-prompt-auditor` 子 agent 专职审计（抽取主张 → 对照代码权威 → 差异清单 → 直接修复 → 回归测试）。
