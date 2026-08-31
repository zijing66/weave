import { describe, it, expect } from 'vitest';
import { classifyAsset, normalizeRelPath } from '../classifier.js';

describe('normalizeRelPath', () => {
  it('converts backslashes to forward slashes', () => {
    expect(normalizeRelPath('.claude\\skills\\foo\\SKILL.md')).toBe(
      '.claude/skills/foo/SKILL.md',
    );
  });

  it('strips leading ./ and /', () => {
    expect(normalizeRelPath('./.claude/skills/x')).toBe('.claude/skills/x');
    expect(normalizeRelPath('/.claude/skills/x')).toBe('.claude/skills/x');
  });
});

describe('classifyAsset', () => {
  it.each([
    ['.mcp.json', 'mcp'],
    ['.claude/settings.json', 'settings'],
    ['.claude/settings.local.json', 'settings'],
    ['.claude/skills/foo/SKILL.md', 'skill'],
    ['.claude/commands/review.md', 'command'],
    ['.claude/agents/coder.md', 'agent'],
    ['.claude/helpers/format.sh', 'helper'],
    ['.claude/todos/abc.md', 'other'],
    ['.weave/token', 'other'],
    ['README.md', 'other'],
  ])('classifies %s as %s', (relPath, category) => {
    expect(classifyAsset(relPath)).toBe(category);
  });

  it('classifies backslash paths correctly', () => {
    expect(classifyAsset('.claude\\skills\\foo\\SKILL.md')).toBe('skill');
    expect(classifyAsset('.claude\\commands\\review.md')).toBe('command');
  });
});
