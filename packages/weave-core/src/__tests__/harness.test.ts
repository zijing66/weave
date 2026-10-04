import { describe, it, expect } from 'vitest';
import { HARNESS_EVENTS, HARNESS_LIFECYCLE } from '../harness';

describe('HARNESS_LIFECYCLE', () => {
  it('覆盖 HARNESS_EVENTS 的全部 harness 键', () => {
    expect(Object.keys(HARNESS_LIFECYCLE).sort()).toEqual(Object.keys(HARNESS_EVENTS).sort());
  });

  it('claude 分组关键字段（D7 表形）', () => {
    expect(HARNESS_LIFECYCLE.claude).toEqual({
      open: 'UserPromptSubmit',
      close: ['Stop'],
      sessionMarkers: ['SessionStart', 'SessionEnd'],
      subagentStop: 'SubagentStop',
    });
  });

  it('codex 占位条目类型完整（B0 闸门，事件表仍空）', () => {
    expect(HARNESS_LIFECYCLE.codex).toEqual({
      open: '',
      close: [],
      sessionMarkers: [],
      subagentStop: '',
    });
    expect(HARNESS_EVENTS.codex).toHaveLength(0);
  });
});
