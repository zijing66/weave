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
  | 'statusline';

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
export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

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
   * `bin` 的版本下限（semver）：低于它的宿主，weave 的会话功能不可信 → 起不了
   * 新会话（UI 置灰并说明）。缺省 = 不设闸。
   */
  minVersion?: string;
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
 * 图片随 prompt 投递的对齐面：「一张图怎么被这个 harness 认出来」是 harness 表示法
 * （claude = 裸绝对路径，它自己的粘贴处理器按 `\.(png|jpe?g|gif|webp)$` 把路径转成
 * `[Image #N]` + 真 image block），server 只传语义参数（原文 + 落盘图的可读路径 /
 * 媒体类型 / 原文件名），怎么引用归这里。null = 该 harness 不支持收图。
 */
export interface ImageAttachSpec {
  /**
   * 把「用户原文 + 已落盘图片」合成投递 prompt 文本。images 恒非空；text 可为空
   * （纯图发送）。返回值走三条层投递，**用户原文不得被改写**（回执比对靠它做包含
   * 匹配）——只允许追加引用形态。
   */
  composePrompt(
    text: string,
    images: readonly { path: string; mediaType: string; name: string }[],
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
   * 事件弹框（不是工具、也非权限提醒的对话框，如 claude 的「Switch model?」）：
   * 事件到达且**对话框确实要弹**时返回问题面，否则 null。条件（弹不弹）是 harness
   * 知识——宿主自己有一套触发判据，猜错就成幽灵问题（面板有问、终端无框，键序
   * 会打进输入框）。落定沿用 permission 态口径（后续任何非 Notification 事件即了结）。
   */
  eventQuestion(eventType: string, raw: unknown): BlockingQuestion | null;
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
  /** 非抢占注入通道（忙排）；null = 不支持。 */
  readonly inject: InjectChannelSpec | null;
  /** 无头强制回合通道（闲投）；null = 不支持。引用 resume 槽规格对象，不复制。 */
  readonly headless: ResumeCommandSpec | null;
  /** 空闲信号事件名（watch 触发源）；空数组 = 不支持空闲订阅。 */
  readonly idleSignals: readonly string[];
  /** 注入信封渲染（缺省 = server 的 weave 统一信封）。 */
  renderEnvelope?(text: string, meta: MessageMeta): string;
  /** 图片随 prompt 的对齐面；null = 该 harness 不支持收图（web 据此置灰附件钮）。 */
  readonly imageAttach: ImageAttachSpec | null;
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
