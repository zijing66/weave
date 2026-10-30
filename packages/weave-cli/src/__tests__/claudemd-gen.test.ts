import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { setLocale } from '../i18n/index';
import {
  generateClaudeMd,
  generateClaudeMdSection,
  mergeClaudeMd,
} from '../init/claudemd-gen';

// 托管块按 locale 生成（默认 locale 是 zh-CN）：本文件按英文断言，末尾另有一条
// 中文用例。文件级隔离，改全局 locale 不会漏到别的测试文件。
beforeAll(() => setLocale('en'));
afterAll(() => setLocale('zh-CN'));

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

  it('不广告市场里的命令：默认 preset 的 commands/agents 都不装，写进块就是假的', () => {
    const md = generateClaudeMd({ template: 'full', projectName: 'p' });
    expect(md).not.toContain('/review');
    expect(md).not.toContain('/scaffold');
  });

  it('技能段落点是 harness 自己的目录（不是项目根 skills/）', () => {
    const md = generateClaudeMd({ template: 'minimal', projectName: 'p' });
    expect(md).toContain('.claude/skills/');
    expect(md).not.toContain('live in `skills/`');
  });

  it('渲染块落点写进托管块（每条模板都有）：项目内或临时目录的 weave/ 子目录', () => {
    for (const t of ['minimal', 'standard', 'full'] as const) {
      const md = generateClaudeMd({ template: t, projectName: 'p' });
      expect(md).toContain('## Render Blocks');
      expect(md).toContain('system temp dir');
      expect(md).toContain('U+E200');
    }
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

  it('按 locale 生成：zh-CN 出中文块，英文键不泄漏', () => {
    setLocale('zh-CN');
    const section = generateClaudeMdSection({ template: 'full', projectName: 'p' });
    expect(section).toContain('## 行为准则');
    expect(section).toContain('## 安全');
    expect(section).not.toContain('## Behavioral Rules');
    setLocale('en');
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
