import { describe, it, expect } from 'vitest';
import { BUCKET_ORDER, tagsOf } from '../file-tags';

describe('BUCKET_ORDER', () => {
  it('holds the 13-word taxonomy in lexical order', () => {
    expect([...BUCKET_ORDER]).toEqual([
      'skill',
      'mcp',
      'hooks',
      'workflow',
      'rules',
      'command',
      'agent',
      'output-style',
      'instructions',
      'settings',
      'plugin',
      'mods',
      'other',
    ]);
  });
});

describe('tagsOf', () => {
  it('gives mods files both plugin and mods tags', () => {
    expect(tagsOf('mods', '.claude/plugins/foo/mods/bar.md')).toEqual(['plugin', 'mods']);
  });

  it('folds helper into hooks', () => {
    expect(tagsOf('helper', '.claude/helpers/h.sh')).toEqual(['hooks']);
  });

  it('folds rule into rules', () => {
    expect(tagsOf('rule', '.claude/rules/r.md')).toEqual(['rules']);
  });

  it('keeps workflow on its own tag', () => {
    expect(tagsOf('workflow', '.claude/workflows/w.md')).toEqual(['workflow']);
  });

  it('maps hook scripts under .claude/hooks/ (other category) to hooks', () => {
    expect(tagsOf('other', '.claude/hooks/x.sh')).toEqual(['hooks']);
  });

  it('falls back to other for unknown categories', () => {
    expect(tagsOf('future-thing', '.claude/whatever.md')).toEqual(['other']);
    expect(tagsOf('other', '.claude/notes.md')).toEqual(['other']);
  });

  it('passes plugin straight through', () => {
    expect(tagsOf('plugin', '.claude/plugins/p.md')).toEqual(['plugin']);
  });
});
