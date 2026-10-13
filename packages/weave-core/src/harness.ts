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
  },
  /** Codex 事件待批 2 B0 调研锁定（同 HARNESS_EVENTS 闸）；空值占位，类型完整。 */
  codex: { open: '', close: [], sessionMarkers: [], subagentStop: '' },
} satisfies Record<Harness, HarnessLifecycle>;

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
