import { describe, expect, it } from 'vitest';
import { tmuxSessionName } from '../adapters/tmux.js';

describe('tmuxSessionName', () => {
  it('instanceId 尾段安全化成会话名', () => {
    expect(tmuxSessionName('inst-abc-123')).toBe('weave-agent-inst-abc-123');
    expect(tmuxSessionName('a.b:c/d'.repeat(5))).toBe('weave-agent-'.concat('a.b:c/d'.repeat(5).replace(/[^a-zA-Z0-9_-]/g, '').slice(-16)));
  });

  it('空 id 兜底 x（不许空段）', () => {
    expect(tmuxSessionName('...')).toBe('weave-agent-x');
  });
});
