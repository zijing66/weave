import { describe, it, expect } from 'vitest';
import {
  generateClaudeMd,
  generateClaudeMdSection,
  mergeClaudeMd,
} from '../init/claudemd-gen';

describe('generateClaudeMd', () => {
  it('includes the project name as H1', () => {
    const md = generateClaudeMd({ template: 'minimal', projectName: 'my-proj' });
    expect(md).toContain('# my-proj');
  });

  it('includes behavioral rules in every template', () => {
    for (const t of ['minimal', 'standard', 'full'] as const) {
      const md = generateClaudeMd({ template: t, projectName: 'p' });
      expect(md).toContain('## Behavioral Rules');
    }
  });

  it('excludes file-org rules in minimal template', () => {
    const md = generateClaudeMd({ template: 'minimal', projectName: 'p' });
    expect(md).not.toContain('## File Organization');
  });

  it('includes file-org rules in standard template', () => {
    const md = generateClaudeMd({ template: 'standard', projectName: 'p' });
    expect(md).toContain('## File Organization');
  });

  it('includes security rules only in full template', () => {
    const full = generateClaudeMd({ template: 'full', projectName: 'p' });
    expect(full).toContain('## Security');
    const standard = generateClaudeMd({ template: 'standard', projectName: 'p' });
    expect(standard).not.toContain('## Security');
  });

  it('always lists weave commands', () => {
    const md = generateClaudeMd({ template: 'minimal', projectName: 'p' });
    expect(md).toContain('/review');
    expect(md).toContain('/test');
  });

  it('is deterministic for the same inputs', () => {
    const a = generateClaudeMd({ template: 'full', projectName: 'p' });
    const b = generateClaudeMd({ template: 'full', projectName: 'p' });
    expect(a).toBe(b);
  });

  it('wraps its content in weave markers so re-init can replace the block', () => {
    const md = generateClaudeMd({ template: 'standard', projectName: 'p' });
    expect(md).toContain('<!-- weave:start -->');
    expect(md).toContain('<!-- weave:end -->');
  });
});

describe('generateClaudeMdSection', () => {
  it('contains the weave markers and no H1 title', () => {
    const section = generateClaudeMdSection({ template: 'minimal', projectName: 'p' });
    expect(section).toContain('<!-- weave:start -->');
    expect(section).toContain('<!-- weave:end -->');
    expect(section).not.toContain('# p\n');
  });
});

describe('mergeClaudeMd', () => {
  const section = (): string =>
    generateClaudeMdSection({ template: 'standard', projectName: 'p' });

  it('appends the block to a user CLAUDE.md, preserving user content', () => {
    const user = '# My project\n\nMy own instructions here.\n';
    const merged = mergeClaudeMd(user, section());
    expect(merged.startsWith(user.replace(/\s+$/, '')+'\n\n<!-- weave:start -->')).toBe(true);
    expect(merged).toContain('My own instructions here.');
  });

  it('is idempotent — merging twice does not duplicate the block', () => {
    const once = mergeClaudeMd('# User\n\ncontent\n', section());
    const twice = mergeClaudeMd(once, section());
    expect(twice).toBe(once);
    expect(twice.match(/<!-- weave:start -->/g)?.length).toBe(1);
  });

  it('replaces an existing weave block, keeping content outside it', () => {
    const withBlock = mergeClaudeMd('# User\n\nbefore\n', section());
    const nextSection = generateClaudeMdSection({ template: 'full', projectName: 'p' });
    const replaced = mergeClaudeMd(withBlock, nextSection);
    expect(replaced).toContain('## Security'); // full template adds it
    expect(replaced.match(/<!-- weave:start -->/g)?.length).toBe(1);
    expect(replaced).toContain('# User');
    expect(replaced).toContain('before');
  });

  it('refreshes the block of a weave-generated file in place', () => {
    const fresh = generateClaudeMd({ template: 'minimal', projectName: 'p' });
    const next = generateClaudeMdSection({ template: 'full', projectName: 'p' });
    const merged = mergeClaudeMd(fresh, next);
    expect(merged).toContain('# p');
    expect(merged).toContain('## Security');
    expect(merged.match(/<!-- weave:start -->/g)?.length).toBe(1);
  });
});
