/**
 * Harness 类型与注册表——纯类型 + 纯常量（零 node、零 zod）。
 *
 * 经 `@weave/core/harness` subpath 暴露给 web：主入口 re-export platform/fs
 * 含 node 依赖，web 不能 import；本文件是唯一被 web 直引的 core 源。
 * 接口与 Registry 不在这里（会与 @weave/harness 成环），见该包 driver.ts。
 */

/** 一期闭合联合；加 harness = 加一项。 */
export type Harness = 'claude' | 'codex';

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

/** 落盘表面映射：模板/资产按 target 分流的单一事实源。 */
export const HARNESS_DIRS = {
  claude: { projectDir: '.claude', userDir: '.claude' },
  codex: { projectDir: '.codex', userDir: '.codex' },
} satisfies Record<Harness, { projectDir: string; userDir: string }>;

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
 * 可选 harness 键序（= `HARNESS_EVENTS` 的键）：
 * `--harness` flag 值域与 init 交互多选的选项表共用（批 5）。
 */
export const HARNESS_KEYS = Object.keys(HARNESS_EVENTS) as Harness[];
