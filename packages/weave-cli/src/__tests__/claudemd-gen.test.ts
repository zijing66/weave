import { describe, it, expect } from 'vitest';
import { generateClaudeMd } from '../init/claudemd-gen';

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
});
