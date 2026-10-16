import type { Harness, HarnessCompaction, HarnessLifecycle } from '@weavecode/core/harness';

/**
 * mirror @weavecode/core/harness.ts HARNESS_LIFECYCLE，改那边同步这里
 * （web 运行时不能 import core 值——import type 纪律，故常量镜像而非 re-export；
 * 先例：TasksPanel.tsx:17-25 mirror HookBusMessage）。
 */
export const HARNESS_LIFECYCLE = {
  claude: {
    open: 'UserPromptSubmit',
    close: ['Stop'],
    sessionMarkers: ['SessionStart', 'SessionEnd'],
    subagentStop: 'SubagentStop',
    questionTools: ['AskUserQuestion', 'ExitPlanMode'],
  },
  /** Codex 事件 B0 闸门未开，空值占位（与 core 同步）。 */
  codex: {
    open: '',
    close: [],
    sessionMarkers: [],
    subagentStop: '',
    questionTools: [],
  },
} satisfies Record<Harness, HarnessLifecycle>;

/** mirror @weavecode/core/harness.ts HARNESS_COMPACTION，改那边同步这里。 */
export const HARNESS_COMPACTION = {
  claude: { start: 'PreCompact', end: 'SessionStart', endSource: 'compact' },
  codex: { start: null, end: null, endSource: null },
} satisfies Record<Harness, HarnessCompaction>;

/**
 * 该事件是不是「压缩会话」那一笔（收尾笔）：压缩信号表的 `end` 与 `endSource`
 * 双双对上才算——谁在压缩是 harness 知识，调用方不写事件名。
 */
export function isCompactionEnd(
  harness: string | null | undefined,
  eventType: string,
  rawSource: unknown,
): boolean {
  if (harness == null) return false;
  const spec = HARNESS_COMPACTION[harness as Harness];
  if (!spec?.end || !spec.endSource) return false;
  return eventType === spec.end && rawSource === spec.endSource;
}
