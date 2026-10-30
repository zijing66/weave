/**
 * Harness 类型与注册表——纯类型 + 纯常量（零 node、零 zod）。
 *
 * 经 `@weavecode/core/harness` subpath 暴露给 web：主入口 re-export platform/fs
 * 含 node 依赖，web 不能 import；web 直引的 core 源 = 本文件与 tool.ts。
 * 接口与 Registry 不在这里（会与 @weavecode/harness 成环），见该包 driver.ts。
 */

/**
 * harness 名单表——**全仓唯一名单来源**：`Harness` 联合、zod 值域
 * （`types.ts` 的三处 schema）、`HARNESS_KEYS` 皆由此派生。
 * 加 harness = 这里加一项（下面四表由 `satisfies Record<Harness, …>` 催补，
 * 漏加即编译失败）。
 */
export const HARNESS_NAMES = ['claude', 'codex'] as const;

/** 一期闭合联合；从名单表派生（不手写 union，防与名单脱节）。 */
export type Harness = (typeof HARNESS_NAMES)[number];

/**
 * 读侧归一/校验：该值是否属于 harness 名单。全仓统一用它，
 * **不得再写 `x === 'claude' || x === 'codex'`**（加 harness 必漏改）。
 */
export function isHarness(value: unknown): value is Harness {
  return typeof value === 'string' && (HARNESS_NAMES as readonly string[]).includes(value);
}

/**
 * 事件采集面注册表——按 harness 声明，不设全局事件数组（CROSS §2.2：
 * 并集会造出非法规则、交集会砍掉独有事件）。规范名为 PascalCase。
 */
export const HARNESS_EVENTS = {
  claude: [
    'PreToolUse',
    'PostToolUse',
    'UserPromptSubmit',
    'SessionStart',
    'Stop',
    /** 回合因 API 错误收尾时**代替 Stop** 发（rate_limit / auth / billing…，带 error）——
     *  不登记它这一轮的收尾就永远等不到。无决策控制，纯通知。 */
    'StopFailure',
    'SubagentStop',
    'Notification',
    /** 工具执行失败（抛错 / MCP 错误结果；带 error / is_interrupt / duration_ms）——
     *  权限拒绝与执行前校验拒绝都不发（那是 PermissionDenied / 无事件）。 */
    'PostToolUseFailure',
    /** 即将向用户请求工具权限（比 permission_prompt 的 ~6s 延迟即时；带
     *  permission_suggestions）。可编程 allow/deny，weave 只采集不裁决。 */
    'PermissionRequest',
    /** auto 模式分类器拒绝工具调用（带 reason）——仅 auto 模式发。 */
    'PermissionDenied',
    /** 子代理启动（agent_id / agent_type）——与 SubagentStop 成对，生命周期补全。 */
    'SubagentStart',
    /** 压缩开始（宿主在压缩前发，携带 trigger=manual/auto）——压缩态的实时信号。 */
    'PreCompact',
    /** 会话退出（宿主进程收尾时发，只覆盖正常退出：kill / 关窗口不发）——退出即清的信号。 */
    'SessionEnd',
    /** 模型切换确认（`/model <名>` / 模型选择器 / fast mode 升档前发，带 from/to 与
     *  prompt_cache_warm）——宿主那句「Switch model?」的信号，问题面由它合成。 */
    'PreModelSwitch',
    /** 模型切换落定（切换真发生后发）——确认框了结的信号（答「No, go back」不发）。 */
    'PostModelSwitch',
  ] as const,
  /**
   * Codex 采集（主源 = codex hooks，兜底尾读 rollout JSONL）——事件名是**规范名**：
   * codex 的线名（`Interrupt` / `task_complete` / …）由 adapter 归一，服务端与 web
   * 只认这一列。0.163 的 hooks 引擎载荷与 claude 逐字同形。
   */
  codex: [
    /** 会话开始：hook 的 `SessionStart`，或 rollout 首行 `session_meta`（新开 / resume / fork）。 */
    'SessionStart',
    /** 用户输入（hook 的 `UserPromptSubmit`；rollout 兜底读 `user_message` / `item_completed(UserMessage)`）。 */
    'UserPromptSubmit',
    /** 回合收尾（hook 的 `Stop` 自带 `last_assistant_message`；rollout 兜底靠行序补位）。 */
    'Stop',
    /** 回合被中断——codex 线名是 `Interrupt`，adapter 翻成规范名。 */
    'TurnAborted',
    /** 工具执行收尾（hook 的 `PostToolUse`；rollout 兜底读 `CommandExecution` / `FileChange` / `McpToolCall`）。 */
    'PostToolUse',
    /** 会话退出（hook 的 `SessionEnd`，只覆盖正常退出）——退出即清的信号。 */
    'SessionEnd',
    /** 压缩开始（带 trigger=manual/auto）。 */
    'PreCompact',
    /** 压缩收尾。 */
    'PostCompact',
    /** 子代理启动（agent_id / agent_type）——与 SubagentStop 成对。 */
    'SubagentStart',
    /** 子代理收尾（带 last_assistant_message 与 agent_transcript_path）。 */
    'SubagentStop',
    /** 即将向用户弹审批对话框（exec / apply_patch / 权限授予 / MCP 工具；带
     *  tool_name / tool_input / permission_mode）——对话框本身是 transient 事件
     *  不落 rollout，hook 是唯一采集口。weave 只采集不裁决（不回 decision）。 */
    'PermissionRequest',
  ] as const,
} satisfies Record<Harness, readonly string[]>;

/**
 * 回合内事件表——「工具正在执行」的正面信号（turnOpen 的补充判据）：
 * claude 宿主对「回合运行中发来的消息」先发 UPS（入队时刻）、再收上一回合的
 * Stop，出队开跑的新回合**不再发第二条 UPS** ⇒ 「最后 UPS 晚于最后 Stop」在这类
 * 排队回合上误判已关。最后收尾之后仍有工具事件 = 回合实际还开着。
 * 只收工具执行三态——Notification（idle 提示）/ SubagentStop（away 总结）在
 * 回合收尾后也会来，不算回合在跑。
 */
export const HARNESS_TOOL_EVENTS = {
  claude: ['PreToolUse', 'PostToolUse', 'PostToolUseFailure'] as const,
  codex: ['PostToolUse'] as const,
} satisfies Record<Harness, readonly string[]>;

/**
 * inject（同步 additionalContext）白名单——按 harness 分表。
 * 规则的 harness 为 'any' 时不允许 inject（两 harness 注入通道不同）。
 */
export const INJECTABLE_EVENTS = {
  claude: ['PostToolUse', 'UserPromptSubmit', 'SessionStart', 'Stop', 'SubagentStop'] as const,
  /** 待调研 Codex 同步注入通道；无则永久为空。 */
  codex: [] as const,
} satisfies Record<Harness, readonly string[]>;

/**
 * sessionTitle 生效事件表——hookSpecificOutput.sessionTitle 只在这些事件被
 * Claude Code 真正应用；工具事件（PostToolUse/Stop 等）下发即弃（hook_success
 * 落档但 custom-title 不变，2.1.296 实测）。改名交付（hook-handler）与回执
 * 落定（dispatcher）都以此表为门——在非生效事件交付并落定，会把 pending 误清
 * 而会话从未更名，改名从此永不再投递。
 */
export const TITLE_EFFECTIVE_EVENTS = {
  claude: ['SessionStart', 'UserPromptSubmit'] as const,
  /** Codex 无标题通道；空值占位，类型完整。 */
  codex: [] as const,
} satisfies Record<Harness, readonly string[]>;

/**
 * 全 harness 事件**并集**——插件 manifest 的 `requires.events` /
 * `subscribe.events` 校验值域。插件不绑单一 harness，故按全集校验；
 * 有事件的 harness 只有 claude 时，并集即 `HARNESS_EVENTS.claude`（行为不变）。
 */
export const HARNESS_EVENT_UNION: readonly string[] = [
  ...new Set(Object.values(HARNESS_EVENTS).flat()),
];

/** 落盘表面映射：模板/资产按 target 分流的单一事实源。 */
export const HARNESS_DIRS = {
  claude: { projectDir: '.claude', userDir: '.claude' },
  codex: { projectDir: '.codex', userDir: '.codex' },
} satisfies Record<Harness, { projectDir: string; userDir: string }>;

/**
 * 指令文件名注册表——harness 的「项目指令文件」知识单点（Claude Code 读
 * CLAUDE.md，Codex 读 AGENTS.md）。`weave init` 的指令文件合一（instruction-link）、
 * 卸载的指令文件清扫与白名单、init 提交候选路径皆由此派生，不得在 cli 内写字面量。
 * 数组首项 = 合一时持有内容的主名（合一时主名在前、次名链到主名）。
 */
export const HARNESS_INSTRUCTION_FILES = {
  claude: ['CLAUDE.md'] as const,
  codex: ['AGENTS.md'] as const,
} satisfies Record<Harness, readonly string[]>;

/** 指令文件名（由注册表派生，不手写 union）。 */
export type InstructionFile = (typeof HARNESS_INSTRUCTION_FILES)[Harness][number];

/** 任务分组生命周期表的条目形状（D7）——分组差异是 harness 知识。 */
export interface HarnessLifecycle {
  /** 开启一个 turn 组的事件（组头）。 */
  open: string;
  /** 关闭组的事件（一轮对话结束，含失败收尾）。 */
  close: readonly string[];
  /** `close` 里**非正常**收尾的那部分（组头照「未正常结束」标，不冒充正常闭环）。 */
  closeFailed: readonly string[];
  /** 只作标记的会话级事件（open 组遇之按中断关组，其余不切组）。 */
  sessionMarkers: readonly string[];
  /** 组内计数、不独立成组。 */
  subagentStop: string;
  /**
   * 阻塞式问答工具（组头「问答 ×n」计数；`questions` 规格的 blockingTools 共用
   * 此表——谁是问答工具只说一处）。空数组 = 该 harness 无阻塞问答。
   */
  questionTools: readonly string[];
  /**
   * 会话退出事件（旁路事实——inbox 凭据 / pane 定位——随进程作废的信号）；
   * null = 该 harness 没有这个概念。与 `close` 不同义：`close` 是一轮对话结束，
   * 这个是一整个会话结束。**只覆盖正常退出**（kill / 关窗口不发）。
   */
  sessionExit: string | null;
}

/**
 * 任务分组生命周期表（D7）——server/web 分组一律经表参数，
 * 不散落 `if (source==='claude')`；web 经 tasks/lifecycle.ts 常量镜像。
 */
export const HARNESS_LIFECYCLE = {
  claude: {
    open: 'UserPromptSubmit',
    close: ['Stop', 'StopFailure'],
    closeFailed: ['StopFailure'],
    sessionMarkers: ['SessionStart', 'SessionEnd'],
    subagentStop: 'SubagentStop',
    questionTools: ['AskUserQuestion', 'ExitPlanMode'],
    sessionExit: 'SessionEnd',
  },
  /**
   * Codex（主源 hooks，兜底 rollout；事件名见 HARNESS_EVENTS.codex）。
   * `TurnAborted` 只进 `close` 不进 `closeFailed`：用户按 ESC 自己断掉的回合
   * 若落「失败」态，比说「打开」更误导。codex 没有「回合因 API 错误收尾」的
   * 独立事件，故 `closeFailed` 恒空。
   */
  codex: {
    open: 'UserPromptSubmit',
    close: ['Stop', 'TurnAborted'],
    closeFailed: [],
    sessionMarkers: ['SessionStart', 'SessionEnd'],
    subagentStop: 'SubagentStop',
    questionTools: [],
    sessionExit: 'SessionEnd',
  },
} satisfies Record<Harness, HarnessLifecycle>;

/** 压缩信号表的条目形状（谁在压缩、哪些事件是压缩）——压缩差异是 harness 知识。 */
export interface HarnessCompaction {
  /** 压缩开始事件：置实时「压缩中」态的唯一信号（最新事件是它即压缩中）。 */
  start: string | null;
  /** 压缩收尾事件类型（`start` 之后宿主发的那一笔）；无则 null。 */
  end: string | null;
  /** 收尾事件的 `raw.source` 取值——同类型事件有多种来源（startup/resume/clear/compact）时用它认出来。 */
  endSource: string | null;
}

/**
 * 压缩信号表——「会话在压缩上下文」按 harness 声明（web 经 tasks/lifecycle.ts
 * 常量镜像）：压缩态 = 最新事件是 `start`（后续任何事件 / 超窗自然顶掉）；
 * 事件链那一笔 = `end` 事件且 raw.source === `endSource`。全 null = 该 harness
 * 无压缩概念。claude 的收尾笔是 `SessionStart(source=compact)`（实测压缩串 =
 * PreCompact → 摘要 → 收尾重启，收尾笔早就在采集面里，故事件链标记对存量会话
 * 即时可见；而实时态要看 `start`，须重跑 weave init 才有）。
 */
export const HARNESS_COMPACTION = {
  claude: { start: 'PreCompact', end: 'SessionStart', endSource: 'compact' },
  /** Codex 待调研；空值占位，类型完整。 */
  codex: { start: null, end: null, endSource: null },
} satisfies Record<Harness, HarnessCompaction>;

/** 会话控制面的条目形状（执行模式切换 / 模型切换）——差异是 harness 知识。 */
export interface HarnessSessionControl {
  /**
   * 执行模式取值词表（宿主自己的名字，展示原样）。空 = 该 harness 无执行模式
   * 概念、没有切换这回事。**切换是一记键，不按这张表轮转**——宿主自己算下一个
   * 模式（实测还会被计划提案、auto 闸插手），故表只供识别与展示。
   */
  modeNames: readonly string[];
  /**
   * 模型名候选（宿主**别名**，如 claude 的 default/opus/sonnet/haiku/fable）。
   * 只收稳定别名——网关会增删的具体模型 ID 不进表，由用户按 `/model <名字>` 自填
   * （名字形态由服务端验）。空 = 无模型切换概念。
   */
  modelNames: readonly string[];
  /**
   * 宣告「此刻跑的是哪个模型」的事件名：换模型落定、以及把模型交还宿主重定的
   * 会话重开。只用于 daemon 重启后**回读库**补那个内存闩——取这几类里最新的
   * 一条，落定事件才答得出新值，最新是重开则旧答案作废（不补）。空 = 无从回读。
   */
  modelFactEvents: readonly string[];
  /**
   * 思考强度（推理档位）可调词表（宿主自己的名字，展示原样）。空 = 该 harness
   * 没有程序化调整通道（控件不渲染）。**模型能力差异不进表**——同一 harness 里
   * 各模型的支持档位不同，宿主自己降档并回报，表只给全梯子供白名单与展示。
   */
  effortLevels: readonly string[];
}

/**
 * 会话控制面表——「怎么切执行模式 / 模型」按 harness 声明（web 经
 * tasks/lifecycle.ts 常量镜像）；键序与命令形态不在本表（那是服务端投递键序的
 * 事，见 message-deliverer，同 ESC 先例）。全空 = 该 harness 无此概念。
 */
export const HARNESS_SESSION_CONTROL = {
  claude: {
    modeNames: ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'],
    modelNames: ['default', 'opus', 'sonnet', 'haiku', 'fable'],
    modelFactEvents: ['PostModelSwitch', 'SessionStart'],
    effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  /** Codex 待调研；空值占位，类型完整。 */
  codex: { modeNames: [], modelNames: [], modelFactEvents: [], effortLevels: [] },
} satisfies Record<Harness, HarnessSessionControl>;

/**
 * 渲染块协议——对话内嵌可视化的引用行文法与 fragment 契约（跨 harness 统一，
 * 模型侧由 skill 教；文法与 codex Desktop 的 visualize 引用行兼容）。
 * 识别唯一实现 = web 的 visualizeSegments；服务端只读端点的白名单与大小上限
 * 亦从此表取值。suffix 可缺席（codex TUI 实测如此）。
 */
export const VISUALIZATION_PROTOCOL = {
  /** 引用行开头：U+E200 + `visualize` + U+E202，其后紧跟 JSON。 */
  referencePrefix: '\u{e200}visualize\u{e202}',
  /** 引用行结尾（可缺席）。 */
  referenceSuffix: '\u{e201}',
  /**
   * 同义写法（识别侧一并接受，生成侧仍以上面的 canonical 形为准）：模型实测
   * 会把三枚私有区字符整组写成 LANGUAGE TAG 区（U+E200→U+E0000、U+E202→
   * U+E0001、U+E201→U+E0002）——屏上全不可见、语义一致，认不出整块就静默
   * 退化成普通文本（2026-10-30 转录实测）。**降级形（裸 `visualize`）也认**：
   * 压缩摘要这一层常把不可见字符整个吃掉，模型据摘要复述时写出的就是裸行
   * （同日实测两条，都在压缩之后）。裸行只在一整行恰好是 `visualize` + 合法
   * JSON 且带 path 时才成立，正文里的提及（带前缀文字 / 反引号包裹）不命中。
   */
  referencePrefixAliases: ['\u{e0000}visualize\u{e0001}', 'visualize'],
  referenceSuffixAliases: ['\u{e0002}'],
  /** fragment 文件大小上限（字节）。 */
  maxFragmentBytes: 1024 * 1024,
} as const;

/**
 * 可选 harness 键序（= 名单表）：`--harness` flag 值域与 init 交互多选的
 * 选项表共用（批 5）。经名单表派生而非 `Object.keys(HARNESS_EVENTS)`——
 * 单一来源，顺序即名单顺序。
 */
export const HARNESS_KEYS: readonly Harness[] = HARNESS_NAMES;

/**
 * 全部 harness 的指令文件名（按名表顺序去重）。首项为主名（合一时持有内容），
 * 其后为次名（链到主名）——`weave init` 的合一、卸载清扫与提交候选共用此序。
 */
export const INSTRUCTION_FILES: readonly InstructionFile[] = [
  ...new Set(HARNESS_KEYS.flatMap((h) => [...HARNESS_INSTRUCTION_FILES[h]])),
];
