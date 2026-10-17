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
    'SubagentStop',
    'Notification',
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
  /** Codex 事件待批 2 B0 调研锁定（BACKLOG §10-6）；一期不注册（B0 闸门）。 */
  codex: [] as const,
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
  /** 正常关闭组的事件。 */
  close: readonly string[];
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
    close: ['Stop'],
    sessionMarkers: ['SessionStart', 'SessionEnd'],
    subagentStop: 'SubagentStop',
    questionTools: ['AskUserQuestion', 'ExitPlanMode'],
    sessionExit: 'SessionEnd',
  },
  /** Codex 事件待批 2 B0 调研锁定（同 HARNESS_EVENTS 闸）；空值占位，类型完整。 */
  codex: {
    open: '',
    close: [],
    sessionMarkers: [],
    subagentStop: '',
    questionTools: [],
    sessionExit: null,
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
  },
  /** Codex 待调研；空值占位，类型完整。 */
  codex: { modeNames: [], modelNames: [] },
} satisfies Record<Harness, HarnessSessionControl>;

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
