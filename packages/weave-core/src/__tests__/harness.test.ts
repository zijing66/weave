import { describe, it, expect } from 'vitest';
import {
  HARNESS_COMPACTION,
  HARNESS_EVENTS,
  HARNESS_LIFECYCLE,
  INJECTABLE_EVENTS,
  TITLE_EFFECTIVE_EVENTS,
} from '../harness';

describe('TITLE_EFFECTIVE_EVENTS', () => {
  it('覆盖全部 harness 键，且 ⊆ INJECTABLE_EVENTS（能生效的必先可注入）', () => {
    expect(Object.keys(TITLE_EFFECTIVE_EVENTS).sort()).toEqual(Object.keys(HARNESS_EVENTS).sort());
    for (const [harness, events] of Object.entries(TITLE_EFFECTIVE_EVENTS)) {
      for (const event of events) {
        expect((INJECTABLE_EVENTS[harness as keyof typeof INJECTABLE_EVENTS] as readonly string[])).toContain(event);
      }
    }
  });

  it('claude：SessionStart/UserPromptSubmit——Claude Code 只在此应用 sessionTitle', () => {
    expect(TITLE_EFFECTIVE_EVENTS.claude).toEqual(['SessionStart', 'UserPromptSubmit']);
  });
});

describe('HARNESS_COMPACTION', () => {
  it('覆盖 HARNESS_EVENTS 的全部 harness 键', () => {
    expect(Object.keys(HARNESS_COMPACTION).sort()).toEqual(Object.keys(HARNESS_EVENTS).sort());
  });

  it('claude：PreCompact 起、SessionStart(source=compact) 收', () => {
    expect(HARNESS_COMPACTION.claude).toEqual({
      start: 'PreCompact',
      end: 'SessionStart',
      endSource: 'compact',
    });
  });

  it('claude：两个信号事件都在采集面内（不在面内 = 表里写了也收不到）', () => {
    expect(HARNESS_EVENTS.claude).toContain('PreCompact');
    expect(HARNESS_EVENTS.claude).toContain('SessionStart');
  });

  it('codex 占位全 null（无压缩信号）', () => {
    expect(HARNESS_COMPACTION.codex).toEqual({ start: null, end: null, endSource: null });
  });
});

describe('HARNESS_LIFECYCLE', () => {
  it('覆盖 HARNESS_EVENTS 的全部 harness 键', () => {
    expect(Object.keys(HARNESS_LIFECYCLE).sort()).toEqual(Object.keys(HARNESS_EVENTS).sort());
  });

  it('claude 分组关键字段（D7 表形）', () => {
    expect(HARNESS_LIFECYCLE.claude).toEqual({
      open: 'UserPromptSubmit',
      close: ['Stop', 'StopFailure'],
      closeFailed: ['StopFailure'],
      sessionMarkers: ['SessionStart', 'SessionEnd'],
      subagentStop: 'SubagentStop',
      questionTools: ['AskUserQuestion', 'ExitPlanMode'],
      sessionExit: 'SessionEnd',
    });
  });

  it('codex：TurnAborted 只进 close 不进 closeFailed（用户自己断的不算失败）', () => {
    expect(HARNESS_LIFECYCLE.codex).toEqual({
      open: 'UserPromptSubmit',
      close: ['Stop', 'TurnAborted'],
      closeFailed: [],
      sessionMarkers: ['SessionStart'],
      subagentStop: '',
      questionTools: [],
      sessionExit: null,
    });
  });

  it('开/关组与标记事件都在采集面内（表外事件收不到，分组会失效）', () => {
    for (const harness of ['claude', 'codex'] as const) {
      const spec = HARNESS_LIFECYCLE[harness];
      const names = [spec.open, ...spec.close, ...spec.closeFailed, ...spec.sessionMarkers];
      for (const name of names) expect(HARNESS_EVENTS[harness]).toContain(name);
    }
  });
});
