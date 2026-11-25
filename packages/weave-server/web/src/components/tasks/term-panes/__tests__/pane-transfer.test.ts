import { describe, expect, it } from 'vitest';
import { validPaneTransfer } from '../pane-transfer';

const base = {
  schema: 2 as const,
  frameId: 'f1',
  projectId: 1,
  projectLabel: 'p',
  state: 'active' as const,
  seedSessionId: 's1',
  label: 'l',
};

describe('validPaneTransfer', () => {
  it('接受对话视图', () => {
    expect(
      validPaneTransfer({
        ...base,
        views: { 'conversation:s1': { kind: 'conversation', label: 'l', sessionId: 's1' } },
        layout: null,
      }),
    ).toBe(true);
  });

  // 回归：`else if` 曾挂在 terminal 分支上，带 instanceId 的合法终端视图被误判非法，
  // 含终端的框架页记录被当作「已删除」→ 弹出窗自关
  it('接受带 instanceId 的终端视图', () => {
    expect(
      validPaneTransfer({
        ...base,
        views: {
          'conversation:s1': { kind: 'conversation', label: 'l', sessionId: 's1' },
          'terminal:s1': { kind: 'terminal', instanceId: 'wvi-1', label: 'l', sessionId: 's1' },
        },
        layout: null,
      }),
    ).toBe(true);
  });

  it('拒绝空 instanceId 的终端视图与未知 kind', () => {
    expect(
      validPaneTransfer({
        ...base,
        views: { 'terminal:s1': { kind: 'terminal', instanceId: '', label: 'l', sessionId: 's1' } },
        layout: null,
      }),
    ).toBe(false);
    expect(
      validPaneTransfer({
        ...base,
        views: { x: { kind: 'weird', label: 'l', sessionId: 's1' } },
        layout: null,
      }),
    ).toBe(false);
  });
});
