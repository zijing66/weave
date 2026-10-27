import type { EnableOverride, Harness } from '@weavecode/core';
import type { InitContext, InitPipeline } from './init/pipeline.js';
import type { FileAssetCategory } from './shared/file-specs.js';

/**
 * 抽象定义的家：能力接口 + HarnessDriver + HarnessRegistry + supports
 * （槽清单以本处 HarnessCapability 为唯一权威）。
 * 依赖硬约束：本包仅依赖 @weavecode/core（永不依赖 server/cli，防 statusline/i18n 成环）。
 */

/** 可插拔能力槽——driver 声明持有哪些，注册表按能力检索。 */
export type HarnessCapability =
  | 'init'
  | 'events'
  | 'assets'
  | 'resume'
  | 'detect'
  | 'plugins'
  | 'pluginState'
  | 'messaging'
  | 'questions'
  | 'capture'
  | 'statusline'
  | 'logs'
  | 'config'
  | 'edits'
  | 'images'
  | 'commands'
  | 'provision'
  | 'liveness';

/**
 * 采集集成的 user 档状态（tool-object-model §2.6 基石）。
 */
export interface CaptureState {
  /** user 档采集组已写入 user settings（= 所有项目的事件都被采集）。 */
  installed: boolean;
  /** user 级 helper 脚本就位（installed 而脚本缺 = 半安装，重装即修复）。 */
  helperPresent: boolean;
}

/** user 档采集面读写依赖（测试注入 home）。 */
export interface CaptureDeps {
  /** 覆盖用户主目录（测试注入）；缺省 os.homedir()。 */
  home?: string;
}

/**
 * 生成脚本的健康（诊断面只读）：脚本正文即 harness 知识（它上报哪些旁路事实），
 * 故判据归各 harness，server 只聚合不自拼。
 */
export interface CaptureScriptHealth {
  /** 生效的是哪一支：user 档采集 installed 即 user，否则项目档；两处都没有 = none。 */
  source: 'user' | 'project' | 'none';
  /** 生效脚本文件在。 */
  present: boolean;
  /** 带 weave 版本标记（weave 生成物；无标记 = 用户自写，weave 不认）。 */
  weaveOwned: boolean;
  /** 标记里读到的生成版本；读不到 = null。 */
  generatedVersion: string | null;
  /** 脚本含会话 inbox 凭据上报（判据 = 正文出现 PromptInboxSpec.socketEnv）。 */
  reportsInbox: boolean;
  /** 脚本含 pane 定位 env 上报。 */
  reportsPaneEnv: boolean;
}

/**
 * 采集安装面：weave 事件采集集成（整个 dashboard 的地基）按工具对象建模，
 * user 档安装/启用是硬性要求——跨项目采集，不依赖逐项目 init。安装即启用
 * （user settings 里有采集组 = 采集在 firing，无独立启停开关）。
 */
export interface CaptureSurface {
  readonly harness: Harness;
  /** user 档采集状态。 */
  readUserCapture(deps?: CaptureDeps): Promise<CaptureState>;
  /** 幂等安装：user 级 helper 脚本 + user settings 采集组（version 语义参数，脚本标记用）。 */
  installUserCapture(deps: CaptureDeps & { version: string }): Promise<void>;
  /** 幂等停用：清扫 user settings 采集组 + 删 user 级脚本（带标记才删）。 */
  uninstallUserCapture(deps?: CaptureDeps): Promise<void>;
  /** 项目档去重：user 档接管时清扫该项目 settings 的采集组（缺/坏文件 = 已达目的）。 */
  stripProjectCapture(projectPath: string): Promise<void>;
  /** 生效采集脚本的健康（诊断面；`projectPath` 缺省只判 user 档）。 */
  scriptHealth(deps?: CaptureDeps & { projectPath?: string }): Promise<CaptureScriptHealth>;
}

/**
 * 插件**启用态**槽：只读/写「某 harness 的插件是否启用」，不含安装与市场
 * （那些在 `plugins` 槽）。Codex 无安装/市场面但有启用态（config.toml），
 * 故启用态单独成槽——路由可枚举本槽，不再写 `if (runtime === 'claude')`。
 */
export interface PluginStateSurface {
  /** 读全局启用态 map（键 = 注册键或插件名，值 = 是否启用）；缺失/损坏 → 空对象。 */
  readGlobalEnabled(): Promise<Record<string, boolean>>;
  /** 写单键（其余键保留；文件可创建）。 */
  writeGlobalEnabled(key: string, enabled: boolean): Promise<void>;
}

/** init 槽类型：以 InitContext 构造 InitPipeline 子类（图① InitTemplateClass）。 */
export type InitTemplateClass = new (ctx: InitContext) => InitPipeline;

/**
 * 事件接入源——字段名保留 `source`，结构兼容 server 的 HookAdapter
 * （实现见 `claude/event-source.ts`，批 4b 迁入）。
 */
export interface EventSource {
  readonly source: Harness;
  readonly events: readonly string[];
  normalize(report: unknown, projectId: number): unknown;
}

/**
 * 一条从外部日志读出来的原始上报 + 它的真实时刻（历史回填不能印成插入时刻）。
 * `report` 与 hook 上报同形，故 server 拿它走**同一个** `EventSource.normalize`。
 */
export interface LogRecord {
  report: { eventType: string; sessionId?: string; cwd?: string; payload: unknown };
  /** 事件真实时刻（ISO；日志行自带时间戳优先，缺失才用文件 mtime）。 */
  at: string;
}

export interface LogPollOptions {
  /** 游标 / 边读缓存落点（daemon 传 `<dataDir>/logs/<harness>`）。 */
  stateDir: string;
  /**
   * 只采这些工作目录的会话（daemon 从 projects 表 + 项目 `.weave/config.yaml` 算出）。
   * 命中即把**该目录原文**回填进 `report.cwd`——路径归一（大小写、分隔符、解析）
   * 是日志源自己的事，调用方按原样等值匹配即可。
   */
  cwdWhitelist: readonly string[];
  /** 单拍上限：到顶就返回，游标只推进到真读过的位置（下一拍续）。 */
  maxRecords?: number;
  maxBytes?: number;
}

/** 日志源健康（诊断面只读；「没数据」与「读不到」要分得开）。 */
export interface LogHealth {
  /** 宿主数据根（不存在 = 该 harness 没在本机用过）。 */
  root: string | null;
  /** 白名单内可读的日志文件数。 */
  files: number;
  /** 最近一次真读到新行的时刻（ISO）。 */
  lastPollAt: string | null;
  /** 最近一次错误（读不动 / 落盘失败）；正常为 null。 */
  lastError: string | null;
}

/**
 * 日志源槽：**拉取式**采集面。`events` 槽答「一份上报怎么归一」，前提是有人把
 * 上报递进来（hook 脚本写 inbox 文件）；没有 push 面的 harness（codex 只把会话
 * 写在自己的 rollout JSONL 里）需要第二个答案——这份数据从哪来。故本槽只负责
 * 「读出新行」，归一化仍归同一个 harness 的 `events` 槽：server 不认识任何
 * harness 的文件格式，harness 也不认识 projects 表。
 *
 * 契约：poll 幂等（游标落 `stateDir`，重启不重放）且守预算（到 maxRecords /
 * maxBytes 即返回）；只挑白名单工作目录的会话，别的一行都不产出。
 */
export interface LogSource {
  readonly harness: Harness;
  poll(options: LogPollOptions): Promise<LogRecord[]>;
  health(options: { stateDir: string }): Promise<LogHealth>;
}

/**
 * 资产落盘表面查询（批 4a 补全）：「某 harness 的资产落哪 / 怎么分类」的知识
 * 从 server 六处散落收敛进本接口的实现（`claude/assets.ts` / `codex/assets.ts`），
 * server 保留原函数名作薄委托——`fileAssetTargetDir` / `skillsDirFor` /
 * `classifyAgent` / `shouldIgnore` / global-config skills 常量 / codex-toml 路径。
 */
/**
 * 一条 MCP 服务器的通用形（各 harness 的落盘表示法不同：claude 是 JSON 的
 * `mcpServers[name]`，codex 是 TOML 的 `[mcp_servers.<name>]`——表示法归实现方）。
 * 类型住这里而非 server：它出现在 [[AssetSurface]] 的方法签名上，server 反向
 * import 会绕回来。
 */
export interface McpStdioConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/**
 * Streamable HTTP 形态（daemon 托管的 MCP 用这一形）：`url` 即端点，
 * `headers` 是客户端要带的头（本机令牌走它），`bearerTokenEnvVar` 只有 codex
 * 支持（Bearer 必须来自环境变量，不许写死明文）。判别靠 `'command' in cfg`。
 */
export interface McpHttpConfig {
  url: string;
  /** 宿主自己的传输标签（claude 会写 `"type": "http"`），原样保留。 */
  type?: string;
  headers?: Record<string, string>;
  bearerTokenEnvVar?: string;
}

export type McpServerConfig = McpStdioConfig | McpHttpConfig;

export interface AssetSurface {
  /** 所属 harness——按序遍历多个 surface 时回指归属（`classifyAgent` 消费）。 */
  readonly harness: Harness;

  /** 某资产类别在指定 scope 的目标目录；无该表面则抛错（同 `fileAssetTargetDir` 语义）。 */
  targetDir(
    category: FileAssetCategory,
    scope: 'project' | 'user',
    projectPath: string,
    homedir: string,
  ): string;

  /**
   * 项目内 skills 根（相对项目根，posix 分隔）：[0] 为安装写入目标，其后为
   * 只读的生态共用根（Codex 的 `.agents/skills`——它自己两处都读；installer/
   * classifier 消费）。
   */
  projectSkillsRoots(): string[];

  /**
   * 全局 skills 根（绝对路径）：[0] 为安装写入目标，其后为只读遗留根
   * （Codex 的 deprecated `~/.codex/skills`；global-config 消费）。
   */
  globalSkillsRoots(homedir: string): string[];

  /** weave 增量编辑的用户级配置文件（Claude `~/.claude/settings.json`；Codex `~/.codex/config.toml`）。 */
  userConfigFile(homedir: string): string;

  /**
   * MCP 服务器的可配置范围（project = 项目 `.mcp.json` / user = 用户级配置），
   * 空数组 = 该 harness 无 MCP 面。安装属性矩阵与 web 能力判定共源。
   */
  mcpScopes(): Array<'project' | 'user'>;

  /**
   * MCP 配置落点（安装属性矩阵的范围落点提示数据源）：project = 项目内文件
   * 相对路径（posix）、user = 用户级配置文件绝对路径；该 harness 无此 scope
   * 的 MCP 面 → undefined。web 按行渲染提示，不自拼 harness 路径。
   */
  mcpDest(scope: 'project' | 'user', homedir: string): string | undefined;

  /**
   * 读某 scope 的 MCP 服务器映射（该 harness 无此 scope / 文件缺失 → 空对象）。
   * 表示法归实现方：调用方只认名字与 `McpServerConfig`，不碰文件。
   */
  mcpRead(
    scope: 'project' | 'user',
    projectPath: string,
    homedir: string,
  ): Promise<Record<string, McpServerConfig>>;

  /** 写/覆盖一条（scope 必须在 `mcpScopes()` 内，否则抛）。 */
  mcpWrite(
    scope: 'project' | 'user',
    projectPath: string,
    homedir: string,
    name: string,
    config: McpServerConfig,
  ): Promise<void>;

  /** 删一条；返回是否真删掉了（false → 调用方给 404）。 */
  mcpRemove(
    scope: 'project' | 'user',
    projectPath: string,
    homedir: string,
    name: string,
  ): Promise<boolean>;

  /**
   * 宿主插件缓存根（Claude `~/.claude/plugins/cache`；Codex `~/.codex/plugins/cache`）；
   * 无插件机制的 harness 返回 undefined。全局技能枚举与「某路径归属谁」消费。
   */
  pluginCacheDir?(homedir: string): string;

  /**
   * 路径归属：该相对路径（posix 已归一）是否认领为本 harness 表面
   * （`classifyAgent` 消费——按 codex→claude 顺序找首个认领者，无人认领默认 claude）。
   */
  classify(relPath: string): boolean;

  /**
   * watch 忽略：本 harness 视角下该相对路径是否不在观测集
   * （`shouldIgnore` 消费——两面取 AND，任一 surface 观测即保留；
   * 项目根与 `.weave` 是中立规则，留在 server 的 `shouldIgnore`）。
   */
  ignore(relPath: string): boolean;
}

/** resume 执行规格——`args` 签名对齐 `resume-runner.ts` 现状调用（sessionId, prompt）。 */
export interface ResumeCommandSpec {
  /** false = 该 harness 无 resume 对等物（501 语义）。 */
  supported: boolean;
  /** 可执行文件名（如 `claude`；runner 可用环境变量覆盖）。 */
  bin: string;
  /** 拼 spawn 参数，如 `['--resume', sessionId, '-p', prompt]`。 */
  args(sessionId: string, prompt: string): string[];
  /**
   * true = prompt 经 stdin 传递（args 应忽略 prompt 参数、不含它）。使命：
   * win32 下命令行只剩 bin + 固定参数 + sessionId，无用户内容，runner 可安全
   * 经 shell 启动以解析 npm 的 .cmd shim（不经 shell 直接 spawn 必 ENOENT）。
   */
  promptStdin?: boolean;
  /**
   * 交互式终端打开参数（无 `-p` prompt），如 `['--resume', sessionId]`——
   * 「在默认终端打开会话」消费；缺省 = 该 harness 不支持交互式打开（501）。
   */
  openArgs?(sessionId: string): string[];
  /**
   * 交互式启动的固定旗标（置于 openArgs 之前）：只加在「终端里起交互会话」
   * 这一侧（new-session / open-terminal），无头 `args` 不带。
   */
  launchArgs?: string[];
  /**
   * 编排边级提取的无头 fork 参数：从上游会话派生一个**一次性 fork 回合**提炼
   * 信息（`['--resume', sessionId, '--fork-session', '--no-session-persistence',
   * '--session-id', forkSessionId]` 形态），不动原会话、不留转录。缺省 = 该
   * harness 无 fork 提取能力（codex 留位，调用方回落只读上游输出）。
   * `forkSessionId` 由 server 预生成并登记合成会话（ingest 侧过滤），harness 只定键形。
   */
  extractArgs?(sessionId: string, forkSessionId: string): string[];
  /**
   * `bin` 的版本下限（semver）：低于它的宿主，weave 的会话功能不可信 → 起不了
   * 新会话（UI 置灰并说明）。缺省 = 不设闸。
   */
  minVersion?: string;
  /**
   * 起会话后的引导注入文本（weave new-session spawn 成功后延时打进 pane 并提交）。
   * 使命：懒建会话档案的宿主（codex 的 rollout 首条消息才落盘）靠一条**零模型调用**
   * 的本地命令（如 `/rename <项目名>`）强制建档，会话行即刻进列表。缺省 = 该
   * harness 无需引导（claude 启动即发 SessionStart）。
   */
  bootstrapText?(projectName: string): string;
}

/** 消息通道名——支持矩阵与原因文案的键。 */
export type MessagingChannel =
  | 'discovery'
  | 'prompt'
  | 'inject'
  | 'headless'
  | 'watch'
  | 'sideQuestion'
  | 'pathRefs';

/** 非抢占注入通道规格：注入可骑乘的事件（hook-handler 在这些事件上消化 outbox 行）。 */
export interface InjectChannelSpec {
  rideEvents: readonly string[];
}

/**
 * prompt 通道中继规格（消息域重塑）：用受限 headless 进程调 harness 原生
 * peer 消息（claude SendMessage）投到已开的目标会话。设计见
 * docs/plan/session-orchestration.md 消息域重塑节。
 */
export interface PromptRelaySpec {
  /** 中继命令（固定参数）；投递指令全文走 stdin——命令行无用户内容，win32 .cmd shim 可安全经 shell 启动。 */
  readonly bin: string;
  readonly args: readonly string[];
  /** 目标会话里消息显示的发送方名（claude：`-n <senderName>`）。 */
  readonly senderName: string;
  /**
   * 中继 stdin 指令全文（server 只传语义参数：peer 寻址名 + 原文 + 单向标记）。
   * `oneWay`（手动面）：中继会话发完即退、没有接收面，载荷须带「无需回复」注记，
   * 否则目标会把消息当聊天、回给一个已消失的 @senderName。编排域（序列步）传
   * false——**双向对话保留**，注记不加，原样投递。
   */
  instruction(peerName: string, text: string, opts: { oneWay: boolean }): string;
  /** sessionId → peer 寻址名（在 peer 注册表中登记 = 会话开着才有）；null = 未登记，走终端兜底或排队。 */
  resolve(sessionId: string): { name: string } | null;
}

/**
 * 附件类型：`image` = 宿主认得图（claude 的粘贴处理器按
 * `\.(png|jpe?g|gif|webp)$` 把路径变成 `[Image #N]` 占位 + 真 image block）；
 * `file` = 其它文件，**宿主没有附件形态**，提示词里只有一条路径，由模型自己读。
 */
export type AttachKind = 'image' | 'file';

/**
 * 附件随 prompt 投递的对齐面：「一个已落盘的文件怎么被这个 harness 认出来」是
 * harness 表示法（claude = 裸绝对路径、一行一条），server 只传语义参数（原文 +
 * 落盘件的可读路径 / 媒体类型 / 原文件名），怎么引用归这里。null = 该 harness
 * 不接受任何附件。
 */
export interface AttachSpec {
  /** 收哪些类型；`image` 缺席 = 图片入口不摆，`file` 缺席 = 文件入口不摆。 */
  readonly kinds: readonly AttachKind[];
  /**
   * 把「用户原文 + 已落盘附件」合成投递 prompt 文本。files 恒非空；text 可为空
   * （纯附件发送）。返回值走三条层投递，**用户原文不得被改写**（回执比对靠它做包含
   * 匹配）——只允许追加引用形态。原文里已含某附件路径（web 占位胶囊的原地展开）
   * 时该附件不再追加；删掉胶囊路径即从原文消失，追加自动恢复。
   */
  composePrompt(
    text: string,
    files: readonly { path: string; mediaType: string; name: string }[],
  ): string;
}

/** 一条项目内路径的类型（`PathRefSpec.kinds` 的取值）。 */
export type PathRefKind = 'file' | 'dir';

/** 引用的一段行区间：1 基、含两端（`start === end` 即单行）。 */
export interface PathRefLines {
  start: number;
  end: number;
}

/**
 * 路径引用面：「一条项目内路径怎么被这个 harness 认出来」是 harness 表示法
 * （claude = `@<相对路径>` 的 mention 文法），server 只传路径与类型，web 只把
 * 服务端回给的表达式**当不透明字符串**贴进输入框——两侧都不自拼。null = 该
 * harness 没有这种引用文法（入口不渲染）。
 */
export interface PathRefSpec {
  /** 该 harness 能引用什么。 */
  readonly kinds: readonly PathRefKind[];
  /** 认不认行区间（false = 选择器只给整文件/整目录引用，不摆设行号选择）。 */
  readonly lines: boolean;
  /** 贴进 prompt 的表达式；path 为项目相对路径（会话 cwd = 项目根）。 */
  expression(input: { path: string; kind: PathRefKind; lines?: PathRefLines }): string;
  /**
   * `expression` 的逆运算：从一段**现成文本**里认出引用表达式（粘贴回填 /
   * 取回队列消息时把表达式还原成胶囊）。只认文法、不问存在——「这个路径真在
   * 项目里吗」是调用方拿文件索引判的，不归文法。
   */
  recognize(text: string): RecognizedRef[];
}

/** `PathRefSpec.recognize` 认出的一处引用：`start`/`end` 是在原文里的下标区间。 */
export interface RecognizedRef {
  start: number;
  end: number;
  /** 原文那一段（调用方可以拿 `expression` 归一后替换）。 */
  ref: string;
  path: string;
  kind: PathRefKind;
  lines?: PathRefLines;
}

/**
 * 旁路会话（宿主 TUI 里的侧问，claude = `/btw`）规格：问一次不打断主回合的
 * 轻量提问。**宿主既不留转录也不发 prompt 事件**（claude 侧问查询 `skipTranscript`），
 * 问题与回答都不落任何文件——所以「谁发的谁记」：weave 打出去的提问自己记，
 * 回答按这里给的判据从采集事件里认领。null = 该 harness 没有这种机制。
 */
export interface SideQuestionSpec {
  /** 提问命令（命令文法归 harness，server 只传用户原文）。 */
  command(question: string): string;
  /** 形态校验：单行、无控制字符（CR 会提前提交）、长度上限。 */
  validate(question: string): { ok: true; text: string } | { ok: false; error: string };
  /**
   * 这条采集事件是不是一次旁路回答；是就返回全文，否则 null。
   * 判据归 harness（claude：`SubagentStop` 且宿主没给这个 agent 留转录——
   * 普通子 agent 与 skill 子 agent 都有转录，skipTranscript 的 fork 才没有）。
   */
  answerOf(eventType: string, payload: unknown): string | null;
  /**
   * 读屏通道（codex = `/side`）：宿主的侧边会话 ephemeral——零落盘、零 hook
   * 事件，回答只能从 pane 屏幕取。声明了它，server 走「开面板 → 发问句 →
   * 轮询读屏 → 关面板」的同步路径；缺省 = 事件认领路径（claude）。
   */
  screen?: SideQuestionScreenSpec;
  /** 发起侧问的前置条件说明（不满足时 409 文案直用）；缺省 = 无前置。 */
  prerequisite?: string;
}

/** 读屏通道的 harness 侧文法（屏幕形态是版本耦合知识，判据全在这里）。 */
export interface SideQuestionScreenSpec {
  /** 开侧边面板的键序（如 `/side` + 提交键）。 */
  openKeys: string;
  /** 提交键（实测 CR 单发比连体稳——TUI 启动/切换面板时常吃掉连体的 CR）。 */
  submitKey: string;
  /** 关面板键（codex = ctrl+c）。 */
  closeKey: string;
  /**
   * 屏幕上有没有开着的侧边面板（收尾键序的前置闸：面板已被用户关掉时，
   * closeKey 会落进主线程语境——忙时弹中断确认菜单、闲时直接退出 TUI，
   * 盲打比不收尾糟得多）。
   */
  panelOpen(screen: string): boolean;
  /**
   * 从屏幕文本提取回答。`before` = 问句发出前的屏幕快照（区分新旧内容）；
   * `done` = 回合已落定（还在跑时 false，调用方继续轮询）；`answer` = null 且
   * done = 判不出（如实落 timeout，不猜——屏幕文法随宿主版本变）。
   */
  extractAnswer(
    question: string,
    before: string,
    now: string,
  ): { answer: string | null; done: boolean };
}

/** 信封渲染入参。 */
export interface MessageMeta {
  /** 发起方展示名（dashboard / 会话标题 / cli）。 */
  fromLabel: string;
  at: string;
  mode: string;
}

/**
 * 阻塞式问答的选项（含作答键序——宿主模态框只吃键盘）。键序给的是**原子表**：
 * 每个元素 = 一次独立击键写。宿主把同一批到达的多个文本字符当成一次粘贴/过滤
 * 输入（实测「11」把数字当筛选字串、一个都不选），故「数字 + 数字」必须分两次发。
 */
export interface BlockingQuestionOption {
  /** 击键原子（`[1-9]` 选项序号 / `\t` 下一个 tab / `\r` 回车 / `\x1b[B` 下移 / `n` 备注框）。 */
  keys: readonly string[];
  label: string;
  description?: string | null;
  /** 宿主自有尾行「自定义输入」：keys 只选中该行（多选 = 勾选），文本由作答侧拼在中间。 */
  input?: boolean;
  /** input 行：进文本框前要打的焦点键（多选 = 下移该行之前的行数；单选数字即变文本框，不给）。 */
  textFocus?: readonly string[];
  /** input 行：文本之后要打的键（多选 = 移出文本框到内联 Next/Submit 再回车；单选 = 回车）。 */
  textTail?: readonly string[];
  /** 宿主自有尾行「结束整个提问去聊天」：按下 keys 即结束提问，后续键序不再打。 */
  chat?: boolean;
  /** 预览模式右栏原文（该选项被高亮时宿主显示的东西；含宿主「不展示/无预览」的占位串）。 */
  preview?: string | null;
  /** 预览模式：keys 只挪高亮，**提交另需这一串**——但同问选了 input 行时由该行的尾键提交。 */
  commit?: readonly string[];
}

/** 阻塞式问答的问题面（PreToolUse 载荷归一化；web 直渲染，选项原文展示）。 */
export interface BlockingQuestion {
  /** 稳定键（作答路由定位：`<tool>:<头或问句前缀>`；提交步 = `<tool>:submit`）。 */
  key: string;
  header?: string | null;
  question: string;
  options: readonly BlockingQuestionOption[];
  multiSelect: boolean;
  /** 提交步：宿主模态框尾部的「提交/取消」屏（`questions≥2 || 任一 multiSelect` 才有）——
   *  不是宿主的第 n 个问题 tab，web 把它渲染成弹窗底部的动作。 */
  submit?: boolean;
  /** 宿主预览模式（单选且任一选项带 `preview`）：左右分栏（选项 | 预览），尾行只有 chat，
   *  自定义文本走 `n` 备注行。选项文案与描述在宿主这一形态下**不渲染**（右栏取而代之）。 */
  previewMode?: boolean;
}

/** 一次工具调用带的计划内容（正文 / 计划文件路径，两样都可能缺）。 */
export interface PlanDraft {
  /** 正文（模型直接给的，或写计划文件那次调用带的 content）。 */
  text: string | null;
  /** 计划文件路径：正文不在事件里时由 server 现读（批准后宿主可能已删）。 */
  filePath: string | null;
}

/**
 * 计划模式面：ExitPlanMode 交出的「待批阅的计划」。正文两条来源——老模型塞在
 * `tool_input.plan` 里；2.1.296 起 tool_input 恒空，宿主改成让模型先把计划写进
 * 计划文件（路径随计划模式提醒下发，宿主自己不留副本），故正文也可能只在那次
 * Write/Edit 的 content 里。dashboard 拿它当一条对话气泡摆出来给人批阅。
 */
export interface PlanSpec {
  /** 提交计划待批阅的工具名。 */
  readonly tool: string;
  /** 写计划文件用的工具名（正文在这类调用的 content 里）。 */
  readonly writeTools: readonly string[];
  /** 计划文件路径里必有的一段：择行用（把整轮 Write 都捞回来太重）。 */
  readonly fileHint: string;
  /** 这次工具调用带的计划内容；与计划无关返回 null。 */
  draftOf(toolName: string | null, toolInput: unknown, toolResponse: unknown): PlanDraft | null;
}

/** 阻塞提问前模型写下的说明正文（转录里认）。 */
export interface PreQuestionText {
  /** 该条 assistant 消息的时刻（ISO UTC，转录 timestamp）。 */
  at: string;
  text: string;
}

/**
 * 阻塞式交互面（会话卡住等输入：AskUserQuestion / 计划确认 / 权限确认）：
 * 哪些工具会挂起、权限通知类型、问题面归一化与作答键序全归 harness——
 * server 只做状态机与终端传输，web 只渲染不拼键序。
 */
export interface BlockingPromptSpec {
  /** 计划模式规格；null = 该 harness 没有计划概念（不摆计划气泡）。 */
  readonly plan: PlanSpec | null;
  /** 阻塞工具名：PreToolUse 置位、PostToolUse 同名清除。 */
  readonly blockingTools: readonly string[];
  /** 权限确认的 Notification 类型（raw.notification_type）；null = 无此机制。 */
  readonly permissionNotificationType: string | null;
  /**
   * 宿主在此（些）权限模式（raw.permission_mode）下**不弹**权限对话框——
   * 该时段的权限 Notification 恒为噪声，server 直接忽略；空数组 = 无模式概念。
   */
  readonly silentPermissionModes: readonly string[];
  /**
   * 权限确认的问题面。选项行数与键义**随宿主形态变**（同一份 3 行面发给 2 行对话框
   * 会把「别再问」打成「拒绝」），故上下文要带齐形态判据：最近一次 PreToolUse 的
   * 工具面 + Notification 正文 + 会话当时的权限模式。
   */
  permissionQuestion(context: {
    toolName: string | null;
    toolInput: unknown;
    /** 宿主对话框原文（Notification 的 raw.message）；缺键 = null。 */
    message: string | null;
    /** 会话当时的权限模式（latch 自 raw.permission_mode）；null = 未知。 */
    permissionMode: string | null;
  }): BlockingQuestion;
  /** 阻塞工具的 PreToolUse toolInput → 问题列表（含合成问题：计划确认的 toolInput 恒空）。 */
  parseQuestions(toolName: string, toolInput: unknown): BlockingQuestion[];
  /**
   * 事件弹框（不是工具、也非权限提醒的对话框，如 claude 的「Switch model?」、
   * codex 的审批框）：事件到达且**对话框确实要弹**时返回问题面，否则 null。条件
   * （弹不弹）是 harness 知识——宿主自己有一套触发判据，猜错就成幽灵问题（面板
   * 有问、终端无框，键序会打进输入框）。落定沿用 permission 态口径（后续任何非
   * Notification 事件即了结）。载荷 = 归一化视图（toolName/toolInput 已提升到
   * 顶层；raw 里的同名键被 compactRaw 折叠成引用，读工具面必须走顶层）。
   */
  eventQuestion(
    eventType: string,
    payload: { raw: unknown; toolName: string | null; toolInput: unknown },
  ): BlockingQuestion | null;
  /**
   * 阻塞提问前模型写下的说明正文（转录尾部最后一条阻塞工具调用之前的 assistant
   * 文本；claude 把一条 assistant 消息拆成相邻多行，正文与工具调用同 message.id）。
   * 阻塞提问不发 Stop ⇒ hook 事件里没有这段话，转录是唯一来源。null = 没有
   * （没在提问 / 提问前没写字）。
   */
  preQuestion?(transcriptPath: string | null): Promise<PreQuestionText | null>;
}

/**
 * 会话本地收件箱直投规格（层①-a，**harness 专属机制**：claude = inbox socket）。
 * server 只做通用传输（连地址 → 写帧 → 关），协议与键名归 harness；无此机制的
 * harness 声明 null（缺席无法渲染「为什么置灰」）。
 */
export interface PromptInboxSpec {
  /** 会话把「可直投地址」导出的环境变量名（hook 脚本据此读取上报）。 */
  readonly socketEnv: string;
  /** 会话把「凭据」导出的环境变量名。 */
  readonly tokenEnv: string;
  /** 该平台是否必须带认证（claude：native Windows 必须，POSIX 可选）。 */
  requiresAuthOn(platform: string): boolean;
  /** 组帧：一次连接要写的完整字节串（分隔符由 harness 定）。token = null 即无凭据。 */
  frame(input: { token: string | null; text: string }): string;
}

/**
 * 宿主自带的排队投递（codex queue）：消息写进目标会话自己的队列——活会话 <1s 注入、
 * 没开的会话下次 resume 自动领走，且**在宿主眼里就是用户输入**（没有带外来源位）。
 * 这层比终端击键更接近「用户本人发送」，故手动面也允许走它（层序见 MessageDeliverer）。
 *
 * `command` 一次给全 bin + argv：win32 的 `codex` 是 npm `.cmd` 垫片，CreateProcess
 * 不认，必须由 harness 换成可直接 spawn 的入口（node + 包 bin）；用户正文只出现在
 * argv 里、不经 shell 拼接。
 */
export interface QueuedPromptSpec {
  command(sessionId: string, text: string): { bin: string; args: string[] };
  /** 单次超时（毫秒）——队列是一次性小操作，挂住即当失败回落下一层。 */
  readonly timeoutMs?: number;
}

/**
 * 会话 pane 定位 env 的信源。hook 旁路上报的 env 生在会话自己的进程树里才可信
 * （claude）；hook 由宿主共享 daemon 代跑的 harness（codex）env 冻结在 daemon
 * 启动地，系统性失真——改信 weave 起会话时的 spawn 回执起点（`launch`）。
 */
export type PaneEnvSource = 'hook' | 'launch';

/**
 * 会话消息能力面（session-orchestration 批 1）：每 harness 一份声明式规格，
 * server 的 MessageDeliverer 按面裁决支持状态与编排控制；claude = 完整参考实现，
 * codex = 显式不支持面（缺席无法渲染「为什么置灰」）。设计见
 * docs/plan/session-orchestration.md 第三章。
 */
export interface MessagingSurface {
  readonly harness: Harness;
  /** 会话发现：该 harness 会话能否成为编排目标。 */
  readonly discovery: boolean;
  /** prompt 通道（层① 原生 peer 消息中继）；null = 无原生机制（层② 终端 send-text 兜底或层③ 队列）。 */
  readonly prompt: PromptRelaySpec | null;
  /** 会话本地收件箱直投（层①-a，毫秒级）；null = 该 harness 没有这类机制。 */
  readonly promptInbox: PromptInboxSpec | null;
  /** 宿主自带的排队投递（宿主侧队列）；null = 该 harness 没有这类机制。 */
  readonly queuedPrompt: QueuedPromptSpec | null;
  /** 非抢占注入通道（忙排）；null = 不支持。 */
  readonly inject: InjectChannelSpec | null;
  /** 无头强制回合通道（闲投）；null = 不支持。引用 resume 槽规格对象，不复制。 */
  readonly headless: ResumeCommandSpec | null;
  /** 空闲信号事件名（watch 触发源）；空数组 = 不支持空闲订阅。 */
  readonly idleSignals: readonly string[];
  /** 会话 pane 定位 env 的信源（hook 旁路上报 vs weave 起会话的 spawn 回执起点）。 */
  readonly paneEnvSource: PaneEnvSource;
  /** 注入信封渲染（缺省 = server 的 weave 统一信封）。 */
  renderEnvelope?(text: string, meta: MessageMeta): string;
  /** 附件随 prompt 的对齐面；null = 该 harness 不收附件（web 据此置灰附件钮）。 */
  readonly attach: AttachSpec | null;
  /** 项目内路径的引用文法；null = 该 harness 没有这种文法（web 据此不渲染入口）。 */
  readonly pathRefs: PathRefSpec | null;
  /** 旁路会话（侧问）；null = 该 harness 没有这种机制（web 据此不渲染入口）。 */
  readonly sideQuestion: SideQuestionSpec | null;
  /** 不支持通道的语义原因（409 文案与 UI tooltip 直用）。 */
  readonly unsupportedReasons?: Partial<Record<MessagingChannel, string>>;
}

/** detect 返回结构（批 5 定）：harness 标识 + `dir` 下是否命中其标记。 */
export interface DetectResult {
  harness: Harness;
  present: boolean;
}

/** 探测策略——scan/status 认 harness 标记，批 5 消费（scan/status/meta 三处）。 */
export interface Detector {
  /** 识别标记（如 `.claude` / `CLAUDE.md`）。 */
  markers: readonly string[];
  /** `dir` 下是否命中该 harness 标记。 */
  present(dir: string): boolean;
  /** 执行探测并返回结果。 */
  detect(dir: string): DetectResult;
}

/** installed_plugins.json（schema v2）单键值：安装记录数组（每键可多版本）。 */
export interface InstalledPluginRecord {
  scope?: PluginScope;
  installPath?: string;
  version?: string;
  installedAt?: string;
  lastUpdated?: string;
}

/** 安装 scope（宿主三分：user / project / local）——每条安装记录按自己的 scope 卸。 */
export type PluginScope = 'user' | 'project' | 'local';

/** 全局安装结果（幂等命中已装时同样返回）。 */
export interface PluginInstallInfo {
  /** 注册键 = `<name>@<marketplace>`。 */
  key: string;
  /** 调用前已装（幂等短路，未跑安装链）。 */
  alreadyInstalled: boolean;
  scope?: string;
  /** 插件缓存目录（installed_plugins.json 的 installPath）。 */
  installPath?: string;
  version?: string;
}

/**
 * 市场身份：**外部市场导入**的包按它自己所属的市场安装（键形 `<name>@<market>`），
 * 不占 weave 的自建市场。缺省（不带）= weave 自己的包（内置包 / SPI 插件）→
 * 走自建市场 `@weave`。
 */
export interface MarketplaceRef {
  /** 市场名 = CC 键 `<name>@<market>` 的后半段（如 `claude-code-playground`）。 */
  name: string;
  /** 市场目录（内含 `.claude-plugin/marketplace.json`）；仅 globalInstall 消费。 */
  dir?: string;
}

export interface GlobalInstallOptions {
  /** 插件名覆盖（缺省读 srcDir 的 `.claude-plugin/plugin.json`）。 */
  name?: string;
  /** 无 manifest 包在 marketplace 目标副本合成最小 plugin.json 用（不写源目录）。 */
  version?: string;
  description?: string;
  /** 市场身份：给出即按该市场安装（缺省走 weave 自建市场）。 */
  marketplace?: MarketplaceRef;
}

/**
 * 插件安装与启用面（批 3）：harness 的「全局安装 + 项目启用」知识全部收在
 * 实现（`claude/plugins.ts`）——marketplace/installed_plugins/项目 settings
 * 的路径与键形不外泄，server 只经本接口编排（H1-H5 结论见
 * docs/plan/cc-plugin-verification.md）。
 */
export interface PluginSurface {
  /** 项目插件位（绝对路径）。宿主不扫描该目录——仅存量副本与清理语义消费。 */
  projectPluginDir(projectPath: string): string;
  /** 注册键 `<name>@<marketplace>`（键形是 harness 知识，实现期就已定，不外泄给
   *  调用方拼装）；`market` 缺省 = weave 自建市场。 */
  pluginKey(name: string, market?: string): string;
  /** `pluginKey` 的逆运算。与拼装点成对——键形知识只留同一处，服务端与 web 都
   *  不得自己 split `@`。`market` = 插件的 namespace（市场身份）。 */
  parsePluginKey(key: string): { name: string; market: string };
  /** 全局安装（两步 CLI 链；幂等：已装直接返回安装信息）。 */
  globalInstall(srcDir: string, opts?: GlobalInstallOptions): Promise<PluginInstallInfo>;
  /** 读 installed_plugins.json 的插件映射（缺失/损坏 → 空对象）。 */
  readInstalled(): Promise<Record<string, InstalledPluginRecord[]>>;
  /** 插件是否已全局安装（`market` 缺省 = weave 自建市场）。 */
  isInstalled(name: string, market?: string): Promise<boolean>;
  /** 卸载（与 harness CLI 对齐；幂等——未安装直接返回；marketplace 源保留）。
   *  逐 scope 卸：每条安装记录按**它自己的** scope 删（全局记录 `--scope user`、
   *  项目记录 `--scope project`）——漏删的残留记录会让宿主继续列出"已安装"。 */
  uninstall(name: string, market?: string): Promise<void>;
  /** 注销市场（按注册时的落点路径反查注册名；幂等——未注册直接返回）。
   *  **宿主语义：连带级联卸载该市场的全部插件（含其数据）**——调用方须先过
   *  破坏性确认。server 只传市场目录这一语义参数，known_marketplaces 的文件
   *  位置、名键、CLI 子命令都是 harness 自己的表示法。 */
  removeMarketplace(marketDir: string): Promise<void>;
  /** 项目 settings 的 enabledPlugins（键 `name@<market>`；缺省 false）。 */
  readProjectEnabled(projectPath: string, name: string, market?: string): Promise<boolean>;
  /** 写项目 enabledPlugins 单键（其余键保留，文件可创建）。 */
  setProjectEnabled(
    projectPath: string,
    name: string,
    enabled: boolean,
    market?: string,
  ): Promise<void>;
  /** 全局 settings 的 enabledPlugins 全量读（键为 `name@marketplace`）。 */
  readGlobalEnabled(): Promise<Record<string, boolean>>;
  /** 全局 settings 单键写（其余键保留，文件可创建）。 */
  writeGlobalEnabled(key: string, enabled: boolean): Promise<void>;
  /** 插件可装/可启用档位（installScopes 数据行；行行携带于 ToolStateRow）。 */
  pluginScopes(): readonly PluginScope[];
  /** 三档 enabledPlugins 覆写读（local > project > user 链原料；键 = 注册键；
   *  未列 = 无覆写 = inherit——区别于显式 false）。 */
  readEnabledOverrides(
    projectPath: string,
  ): Promise<Record<PluginScope, Record<string, boolean>>>;
  /** 写某档覆写（'on'/'off' 写单键；'inherit' 删该档键 = 回落下一档；
   *  其余键保留，文件可创建）。 */
  setEnabledOverride(
    projectPath: string,
    scope: PluginScope,
    key: string,
    state: EnableOverride,
  ): Promise<void>;
}

/** 生成状态栏脚本的运行参数——两样都是调用方（server）的事实：缓存落点归
 *  dataDir 布局，版本号归包身份；harness 不自取。 */
export interface StatuslineGenerateContext {
  cacheDir: string;
  version: string;
}

/**
 * 状态栏面：宿主能不能被注入自定义状态栏、能填哪些块、脚本落在哪、怎么接线。
 *
 * 「哪几块」是 harness 知识（claude 的块来自它 statusline stdin JSON 的字段），
 * 故词表与渲染器都归各 harness 的实现；server 只做持久化与装配、web 只渲染
 * 能力表给出来的块。`tui: 'none'` 的 harness 不是「没做」，而是宿主结构上没有
 * 这个面（如 codex 的 `tui.status_line` 只能选内置条目、不接受 shell 命令）。
 */
export interface StatuslineSurface {
  /** 该 harness 的状态栏能填哪些块（key 由 harness 定义，web 只认这串）。 */
  readonly segments: readonly string[];
  /** TUI 通道：`injectable` = 能注入宿主 TUI；`none` = 宿主没有这个面。 */
  readonly tui: 'injectable' | 'none';
  /** 脚本相对项目根的落点（posix，供 init 漂移检测比对面）。 */
  readonly scriptRelPath: string;
  /** 生成宿主运行的渲染脚本（配置形状归 harness，槽位不做假设）。 */
  generate(config: unknown, ctx: StatuslineGenerateContext): string;
  /** 把宿主指针接到脚本上（claude = `.claude/settings.json` 的 `statusLine` 键）。 */
  wire(projectPath: string, opts: { scriptPath: string; refreshInterval: number }): Promise<void>;
  /**
   * 渲染脚本已经算好、留在缓存里的块事实（key = segment key，值 = token 表）——
   * dashboard 侧要摆同样的块就从这儿取，不自算第二份。没有缓存即 null。
   */
  facts?(cacheDir: string, cwd: string): StatuslineFacts | null;
}

/** 缓存里的块事实：与 `buildPreviewItems` 吃的 token 表同形。 */
export type StatuslineFacts = Record<string, Record<string, string>>;

/**
 * 配置档位：host 读配置文件的四个落点。`global` 指宿主单独放「全局 config」键的
 * 那个文件（claude = `~/.claude.json`，与 settings 文件不是一回事）。
 */
export type ConfigFileId = 'user' | 'project' | 'projectLocal' | 'global';

/** 一个档位的落点；`profiles` = 该档支持本地多份配置（快照/切换）。 */
export interface ConfigFileSpec {
  id: ConfigFileId;
  path(ctx: { projectPath: string | null; homedir: string }): string;
  profiles: boolean;
}

/**
 * 词表里的一条键。条目的**类型原文**（含枚举说明）来自官方文档，web 自己决定控件；
 * `options` 只是从类型文案里认出来的候选值，认窄了不致命（前端始终留手填口）。
 */
export interface ConfigKeySpec {
  key: string;
  /** 文档主题（分组表头）。 */
  group: string;
  type: string;
  options?: readonly string[];
  /** 文档默认值原文（展示用，不是结构化值）。 */
  default?: string;
  description: string;
  /** 该键在哪个文件生效；`managed` = 只在组织托管设置里认。 */
  scope: 'any' | 'managed' | 'user' | 'project' | 'local' | 'global';
  deprecated?: boolean;
  /** 由「Fields for」表补出的子字段（文档没有独立条目）。 */
  nested?: boolean;
  /**
   * 值的容器形状：`map` = 键名由用户起（模型名、技能名…，拼不成点号路径）、
   * `array` = 有序列表。有它时 `fields` / `valueType` + `valueOptions` 描述**值**。
   */
  shape?: 'map' | 'array';
  /** 值（map）/ 元素（array）是对象时，它有哪些字段。 */
  fields?: readonly ConfigFieldSpec[];
  /** 值（map）/ 元素（array）是标量时的类型与枚举；`fields` 非空则以字段为准。 */
  valueType?: string;
  valueOptions?: readonly string[];
}

/** 对象值的一个字段（`type` / `options` 与顶层键同文法，控件也同一套）。 */
export interface ConfigFieldSpec {
  name: string;
  type: string;
  options?: readonly string[];
  description?: string;
}

/** 数组里的一条 weave 托管条目：`path` 是数组的点号路径，`entry` 是那条的当前值。 */
export interface ConfigManagedEntry {
  path: string;
  entry: string;
}

/** `env` 块里可写的环境变量（值恒为字符串，`kind` 只决定输入控件）。 */
export interface ConfigEnvVarSpec {
  name: string;
  description: string;
  kind: 'string' | 'boolean' | 'number' | 'list' | 'enum' | 'path';
  options?: readonly string[];
}

export interface ConfigCatalog {
  groups: readonly string[];
  keys: readonly ConfigKeySpec[];
  envVars: readonly ConfigEnvVarSpec[];
}

/** 模型列表接口返回的一条（字段名归 harness，web 只认 id/name）。 */
export interface ConfigModelOption {
  id: string;
  name?: string;
  createdAt?: string;
}

/**
 * 配置面：一个 harness 的配置文件**词表 + 读写**。
 *
 * 为什么整块归 harness：文件落点、键形、哪些键是 weave 自己写进去的（改了就断
 * 采集/插件/statusline）、模型列表接口的文法，全是 harness 知识；server 只做
 * 存储、深路径合并与 HTTP 传输，web 只渲染词表。
 */
export interface ConfigSurface {
  readonly harness: Harness;
  /** 该 harness 的配置文件档位（project 档在 `projectPath` 缺省时路径无意义）。 */
  files(ctx: { projectPath: string | null; homedir: string }): ConfigFileSpec[];
  /** 某档可见的词表（`global` 档只列本档生效的键）。 */
  catalog(file: ConfigFileId): ConfigCatalog;
  /** 读该档的配置；文件不存在 → 空对象。`global` 档只回本档可见的键。 */
  read(file: ConfigFileId, ctx: { projectPath: string | null; homedir: string }): Promise<Record<string, unknown>>;
  /** 整体写（原子）：`global` 档只把可见键并回文件，其余键原样保留。 */
  write(
    file: ConfigFileId,
    ctx: { projectPath: string | null; homedir: string },
    values: Record<string, unknown>,
  ): Promise<void>;
  /**
   * weave 写进去的键（按当前值判，如 statusLine 只有指向 weave 脚本时才算）：
   * 表单里只读并指向对应面板——手改会把采集/插件/statusline 改坏。
   */
  managedKeys(values: Record<string, unknown>): readonly string[];
  /**
   * weave 写进数组里的条目（行级托管）：只有这些行只读，同一个数组里用户自己的行照常
   * 增删——按「整个数组」判会把 30 条用户规则一起锁死。
   */
  managedEntries(values: Record<string, unknown>): readonly ConfigManagedEntry[];
  /**
   * 模型列表（HTTP 调宿主自己的 API）。`baseUrl` / 凭据缺省时由实现从配置里取；
   * 传输在实现侧，server 只传语义参数。`homedir` 供实现解析配置里的相对路径
   * （codex 的 `model_catalog_json` 相对 CODEX_HOME）。`file` 让实现知道当前
   * 档位——项目档缺地址/凭据时可继承 user 档的 env（claude）。
   */
  models(input: {
    values: Record<string, unknown>;
    file?: ConfigFileId;
    homedir?: string;
    baseUrl?: string | null;
    apiKey?: string | null;
    authToken?: string | null;
    timeoutMs?: number;
  }): Promise<{ models: ConfigModelOption[]; baseUrl: string; credential: string }>;
  /** 活文件的表示格式（raw 视图的编辑语言；快照/漂移 diff 也按它渲染）。 */
  readonly rawFormat: 'json' | 'toml';
  /** 活文件原文 → 值对象（解析失败抛错，调用方给 400）。 */
  parseRaw(text: string): Record<string, unknown>;
  /** 值对象 → 活文件原文（write 落盘前的最后一跳，格式归 harness）。 */
  serializeRaw(values: Record<string, unknown>): string;
}

/** 一处改动：改前 → 改后。宿主只给片段（claude 的 Edit 就是 old_string/new_string）就只摆片段。 */
export interface EditHunk {
  /** 改前的文本；整文件新写 = 空串（「新建」在汇总里也是一处改动，不能消失）。 */
  before: string;
  /** 改后的文本。 */
  after: string;
}

/** 按时间序返回的一处改动（同一文件可以有多条，汇总归 server）。 */
export interface FileEdit {
  /** 文件绝对路径——相对项目的展示名由 server 算，宿主不拼。 */
  path: string;
  hunk: EditHunk;
  /** 这处改动的时刻（ISO）；宿主没带 → null。 */
  at: string | null;
}

/**
 * 会话改动面（「这次对话把哪些文件改成了什么样」）：读哪、怎么认改文件的调用都是
 * harness 知识（claude = 转录里的 Edit/Write/MultiEdit 工具调用），server 不解析
 * 宿主格式，只按文件汇总后交前端渲染 diff。
 */
export interface EditsSurface {
  /** 该会话的全部改动（时间序）；读不到（无转录 / 路径未知 / 半路出错）→ null（不猜）。 */
  sessionEdits(req: {
    sessionId: string;
    /** 转录路径（server 的探针答，宿主不自己拼目录）；null = 不知道在哪。 */
    transcriptPath: string | null;
  }): Promise<FileEdit[] | null>;
}

/** 一张粘贴进宿主输入框的图（转录里的 image block 解出来的原始字节）。 */
export interface PromptImage {
  /** MIME（`image/png` 这类）；认不出的类型上游就该丢掉。 */
  mediaType: string;
  bytes: Uint8Array;
}

/** 转录里的一条 user 消息 + 它随附的图（时间序）。 */
export interface PromptImageSet {
  /** 该条消息的正文（宿主保留 `[Image #N]` 占位——匹配事件时按它归一比对）。 */
  text: string;
  /** 消息时刻（ISO）；宿主没带 → null。 */
  at: string | null;
  images: PromptImage[];
}

/**
 * 入站图采集面：宿主输入框里粘的图**只活在转录**（hook 载荷只有 `[Image #N]` 占位），
 * server 因此在这里问「这段对话里的图长什么样」，再自己落 uploads + 挂到开轮事件。
 * 缺这个槽 = 该 harness 的入站图无处可取（对话里只剩占位记号）。
 */
export interface ImagesSurface {
  /** 带图的那几条 user 消息（时间序）；读不到（无转录 / 路径未知 / 半路出错）→ null（不猜）。 */
  sessionImages(req: {
    sessionId: string;
    /** 转录路径（server 的探针答，宿主不自己拼目录）；null = 不知道在哪。 */
    transcriptPath: string | null;
  }): Promise<PromptImageSet[] | null>;
}

/**
 * 聊天窗口 `/` 提示里的一条命令：内建命令来自宿主（版本快照，随升级复核），
 * 其余按目录现扫（自定义命令 / skill / 插件 skill）。
 */
export interface HarnessCommand {
  /** 不含触发符；插件/skill 命令带 `<plugin>:<skill>` 形态。 */
  name: string;
  /** 一句话说明（skill 取 SKILL.md frontmatter）。 */
  description: string;
  /** 参数提示（形如 `<model>` / `<file>`）；没有参数就省略。 */
  argsHint?: string;
  source: 'builtin' | 'command' | 'skill' | 'plugin';
  /** 触发符：缺省 `/`；codex 的 skill 是 `$name`。前端按它展示与插胶囊。 */
  sigil?: '/' | '$';
}

/** 转录里的一条命令执行记录（内建命令不发 hook 事件，只有转录记着）。 */
export interface CommandExecution {
  name: string;
  args: string;
  /** 执行时刻（ISO UTC）。 */
  at: string;
  /** 宿主回显的输出原文；命令没有输出就省略。 */
  output?: string;
}

/**
 * 命令面：聊天窗口 `/` 的候选清单 + 命令执行的返显。
 * `executions` 答 null = 该 harness 的转录不记命令执行（前端如实说明，不空转）。
 */
export interface CommandsSurface {
  readonly harness: Harness;
  /** 该会话此刻可用的命令（项目级命令按项目路径现扫；`homedir` 缺省 = 本机家目录）。 */
  list(req: { projectPath: string; homedir?: string }): Promise<HarnessCommand[]>;
  /** 转录里的命令执行（时间序）；读不到（无转录 / 路径未知 / 半路出错）→ null（不猜）。 */
  executions(transcriptPath: string | null): Promise<CommandExecution[] | null>;
}

/**
 * 安装形态检查面（init 环境备置消费）：答「这台机器上该 harness 的多副面孔是否
 * 互相打架」。有桌面端 + CLI 双形态的 harness（codex）在此声明冲突判据与修法；
 * 单形态 harness（claude）不补槽——没有冲突可言，调用方按槽缺席跳过。
 */
export interface ProvisionCheck {
  /** 桌面端（GUI app）是否在本机。 */
  desktopApp: boolean;
  /** 共享后台（daemon 包）是否在本机。 */
  daemonPackage: boolean;
  /** 检出的冲突（英文原文，i18n 由调用方包一层）。 */
  warnings: readonly string[];
  /** 每条冲突对应的官方修法命令。 */
  hints: readonly string[];
}

export interface ProvisionSurface {
  readonly harness: Harness;
  check(bin: string): Promise<ProvisionCheck>;
}

/**
 * 会话存活面：答「这个 harness 的会话进程还活着吗」。判据是 harness 专属知识
 * （claude = `~/.claude/sessions/<pid>.json` 注册表 + kill 0；codex = thread-writer-locks
 * 独占锁），server 不自拼。探测是异步批量（codex 的锁探针要 spawn PowerShell），
 * 消费方要同步 map——由装配层缓存（见 server 的 liveness 装配助手）。
 */
export interface LivenessSurface {
  readonly harness: Harness;
  /**
   * 批量探测给定会话的存活。只输出**判得动**的条目（判不动的会话不进 map，
   * 上游把「查不到」当未知，不许误判死）；`ids` 缺省 = 全量。
   */
  alive(ids?: readonly string[]): Promise<Map<string, boolean>>;
}

/**
 * 会话标题读写面：宿主侧**用户自定义名**（codex = thread name，落 session_index
 * 与 sqlite threads.name）的读/写通道。读 = 宿主持久层 diff 采纳（TUI 改名反显
 * 前端）；写 = 官方 RPC（thread/name/set，前端改名进宿主）。claude 不挂此槽——
 * 它的名字通道是 hook session_title 双向管线，不经这里。
 */
export interface SessionTitleSurface {
  readonly harness: Harness;
  /** 宿主侧当前用户自定义名；无名/无文件返回 null（宿主清除名字时置空串 → null）。 */
  sessionTitleOf(sessionId: string): Promise<string | null>;
  /** 经官方通道写宿主侧名字；trim 后空串抛错，宿主拒绝/超时/协议不认识抛错。 */
  setSessionTitle(sessionId: string, name: string): Promise<void>;
}

/** 单个 harness 的驱动：id/displayName 必填，能力槽按批次补齐。 */
export interface HarnessDriver {
  id: Harness;
  displayName: string;
  capabilities: readonly HarnessCapability[];
  init?: InitTemplateClass;
  events?: EventSource;
  assets?: AssetSurface;
  resume?: ResumeCommandSpec;
  detect?: Detector;
  plugins?: PluginSurface;
  pluginState?: PluginStateSurface;
  messaging?: MessagingSurface;
  questions?: BlockingPromptSpec;
  capture?: CaptureSurface;
  statusline?: StatuslineSurface;
  logs?: LogSource;
  config?: ConfigSurface;
  edits?: EditsSurface;
  images?: ImagesSurface;
  commands?: CommandsSurface;
  provision?: ProvisionSurface;
  liveness?: LivenessSurface;
  /** 不入 capabilities 清单——无 web 面，消费点仅 server 两处（dispatcher diff 采纳 / PATCH rename RPC）。 */
  titles?: SessionTitleSurface;
}

/**
 * 能力槽注册表：先到先得（同 id 重复注册抛错，对齐插件先加载者胜）；
 * `register` 返回 disposer 恢复注册前快照（cordis effect 语义）。
 */
export class HarnessRegistry {
  private readonly drivers = new Map<Harness, HarnessDriver>();

  /** 注册驱动；重复 id 抛错。disposer 幂等，只移除自己注册的那份（不误删后继同 id 注册）。 */
  register(driver: HarnessDriver): () => void {
    if (this.drivers.has(driver.id)) {
      throw new Error(`harness driver already registered: ${driver.id}`);
    }
    this.drivers.set(driver.id, driver);
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      if (this.drivers.get(driver.id) === driver) this.drivers.delete(driver.id);
    };
  }

  /** 按 id 取驱动，缺失返回 undefined。 */
  get(id: Harness): HarnessDriver | undefined {
    return this.drivers.get(id);
  }

  /** 全部驱动（注册顺序的快照数组）。 */
  all(): HarnessDriver[] {
    return [...this.drivers.values()];
  }

  /** 声明了该能力的驱动（按注册顺序）。 */
  byCapability(capability: HarnessCapability): HarnessDriver[] {
    return this.all().filter((d) => d.capabilities.includes(capability));
  }

  /** 取某 harness 的 init 槽类型；未注册或未补槽返回 undefined。 */
  initFor(id: Harness): InitTemplateClass | undefined {
    return this.drivers.get(id)?.init;
  }

  /** 按 id 移除驱动；返回是否存在。 */
  unregister(id: Harness): boolean {
    return this.drivers.delete(id);
  }
}

/** driver 是否声明拥有该能力。 */
export function supports(driver: HarnessDriver, capability: HarnessCapability): boolean {
  return driver.capabilities.includes(capability);
}
