import type { Harness, HarnessLifecycle } from '@weavecode/core/harness';

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
  },
  /** Codex 事件 B0 闸门未开，空值占位（与 core 同步）。 */
  codex: { open: '', close: [], sessionMarkers: [], subagentStop: '' },
} satisfies Record<Harness, HarnessLifecycle>;
