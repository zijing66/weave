import { describe, it, expect } from 'vitest';
import { classifyAgent, classifyAsset, normalizeRelPath } from '../classifier.js';

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
    // Instruction files count at any depth, not only the project root …
    ['CLAUDE.md', 'instructions'],
    ['AGENTS.md', 'instructions'],
    ['docs/CLAUDE.md', 'instructions'],
    ['packages/app/AGENTS.md', 'instructions'],
    // … but a directory prefix wins, so a CLAUDE.md inside a skill folder
    // stays part of that skill instead of escaping to the instructions bucket.
    ['.claude/skills/foo/CLAUDE.md', 'skill'],
    ['.claude/commands/CLAUDE.md', 'command'],
  ])('classifies %s as %s', (relPath, category) => {
    expect(classifyAsset(relPath)).toBe(category);
  });

  it('classifies backslash paths correctly', () => {
    expect(classifyAsset('.claude\\skills\\foo\\SKILL.md')).toBe('skill');
    expect(classifyAsset('.claude\\commands\\review.md')).toBe('command');
    expect(classifyAsset('docs\\CLAUDE.md')).toBe('instructions');
  });
});

describe('classifyAgent', () => {
  it.each([
    ['CLAUDE.md', 'claude'],
    ['docs/CLAUDE.md', 'claude'],
    ['AGENTS.md', 'codex'],
    ['docs/AGENTS.md', 'codex'],
    ['.codex/config.toml', 'codex'],
    ['.codex/AGENTS.md', 'codex'],
    ['.claude/commands/review.md', 'claude'],
    ['README.md', 'claude'],
  ])('classifies %s as %s', (relPath, agent) => {
    expect(classifyAgent(relPath)).toBe(agent);
  });
});
