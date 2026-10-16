import { describe, it, expect } from 'vitest';
import { isCompactionEnd } from '../lifecycle';

describe('isCompactionEnd（「这一笔是压缩」的判据）', () => {
  it('claude：SessionStart 且 raw.source=compact 才算（类型对、来源不对都不算）', () => {
    expect(isCompactionEnd('claude', 'SessionStart', 'compact')).toBe(true);
    expect(isCompactionEnd('claude', 'SessionStart', 'startup')).toBe(false);
    expect(isCompactionEnd('claude', 'SessionStart', 'resume')).toBe(false);
    expect(isCompactionEnd('claude', 'SessionStart', undefined)).toBe(false);
    expect(isCompactionEnd('claude', 'UserPromptSubmit', 'compact')).toBe(false);
    // 压缩开始事件不是「那一笔」（实时态另有判据）
    expect(isCompactionEnd('claude', 'PreCompact', 'compact')).toBe(false);
  });

  it('无压缩信号的 harness / 未知来源一律不认（表里全 null 即无压缩概念）', () => {
    expect(isCompactionEnd('codex', 'SessionStart', 'compact')).toBe(false);
    expect(isCompactionEnd(null, 'SessionStart', 'compact')).toBe(false);
    expect(isCompactionEnd(undefined, 'SessionStart', 'compact')).toBe(false);
  });
});
