import type {
  Harness,
  HarnessCompaction,
  HarnessLifecycle,
  HarnessSessionControl,
} from '@weavecode/core/harness';

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
    sessionExit: 'SessionEnd',
  },
  /** Codex 事件 B0 闸门未开，空值占位（与 core 同步）。 */
  codex: {
    open: '',
    close: [],
    sessionMarkers: [],
    subagentStop: '',
    questionTools: [],
    sessionExit: null,
  },
} satisfies Record<Harness, HarnessLifecycle>;

/** mirror @weavecode/core/harness.ts HARNESS_COMPACTION，改那边同步这里。 */
export const HARNESS_COMPACTION = {
  claude: { start: 'PreCompact', end: 'SessionStart', endSource: 'compact' },
  codex: { start: null, end: null, endSource: null },
} satisfies Record<Harness, HarnessCompaction>;

/** mirror @weavecode/core/harness.ts HARNESS_SESSION_CONTROL，改那边同步这里。 */
export const HARNESS_SESSION_CONTROL = {
  claude: {
    modeNames: ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'],
    modelNames: ['default', 'opus', 'sonnet', 'haiku', 'fable'],
  },
  codex: { modeNames: [], modelNames: [] },
} satisfies Record<Harness, HarnessSessionControl>;

/** 该 harness 的执行模式词表（宿主自己的名字，展示原样）；空 = 无此概念。 */
export function modeNamesFor(harness: string | null | undefined): readonly string[] {
  if (harness == null) return [];
  return HARNESS_SESSION_CONTROL[harness as Harness]?.modeNames ?? [];
}

/** 该 harness 的模型别名词表（稳定别名，网关具体 ID 走自填）；空 = 无此概念。 */
export function modelNamesFor(harness: string | null | undefined): readonly string[] {
  if (harness == null) return [];
  return HARNESS_SESSION_CONTROL[harness as Harness]?.modelNames ?? [];
}

/**
 * 模式按钮的文字色：按词表**位次**取色，不硬编码 harness 的模式名——加模式自动
 * 落进下一位。词表末位（bypassPermissions）天然落在警示红，关掉权限闸得一眼认出。
 * 词表外的模式名（宿主将来加的）认不出 → null，调用方回落中性灰。
 */
const MODE_TINTS = ['#cbd5e1', '#38bdf8', '#a78bfa', '#2dd4bf', '#fbbf24', '#f87171'];

export function modeTintFor(harness: string | null | undefined, mode: string | null): string | null {
  if (!mode) return null;
  const i = modeNamesFor(harness).indexOf(mode);
  return i >= 0 ? MODE_TINTS[i % MODE_TINTS.length] : null;
}

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
