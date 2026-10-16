import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gitClassify } from '../git-classify.js';

/**
 * 自动/手动分界：不进 git（ignored ∪ 非 git 仓库）= 自动同步；
 * 会进 git（tracked ∪ untracked-but-not-ignored）= 只报不写。
 */

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(path.join(tmpdir(), 'weave-gitclass-'));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

function git(...args: string[]): void {
  execFileSync('git', ['-C', projectDir, ...args], { stdio: 'ignore' });
}

describe('gitClassify', () => {
  it('非 git 仓库：全部 auto（全算「不进 git」）', async () => {
    writeFileSync(path.join(projectDir, 'CLAUDE.md'), '# mine');
    const c = await gitClassify(projectDir, ['CLAUDE.md', '.claude/helpers/hook-handler.cjs']);
    expect(c.kindOf('CLAUDE.md')).toBe('outside');
    expect(c.kindOf('.claude/helpers/hook-handler.cjs')).toBe('outside');
    expect(c.classOf('CLAUDE.md')).toBe('auto');
    expect(c.classOf('.claude/helpers/hook-handler.cjs')).toBe('auto');
  });

  it('git 仓库三态：tracked=manual、ignored=auto、untracked 未 ignore=manual', async () => {
    writeFileSync(path.join(projectDir, '.gitignore'), 'ignored*\n.claude/\n');
    writeFileSync(path.join(projectDir, 'tracked.md'), 'v1');
    writeFileSync(path.join(projectDir, 'ignored.md'), 'v1');
    writeFileSync(path.join(projectDir, 'untracked.md'), 'v1');
    mkdirSync(path.join(projectDir, '.claude', 'helpers'), { recursive: true });
    writeFileSync(
      path.join(projectDir, '.claude', 'helpers', 'hook-handler.cjs'),
      '// @version weave@0.0.1\n',
    );
    git('init');
    git('add', '.gitignore', 'tracked.md');

    const c = await gitClassify(projectDir, [
      'tracked.md',
      'ignored.md',
      'untracked.md',
      '.claude/helpers/hook-handler.cjs',
    ]);

    expect(c.kindOf('tracked.md')).toBe('tracked');
    expect(c.classOf('tracked.md')).toBe('manual');

    expect(c.kindOf('ignored.md')).toBe('ignored');
    expect(c.classOf('ignored.md')).toBe('auto');

    // 未跟踪但没被 ignore → 下次 git add 就进 → 归手动
    expect(c.kindOf('untracked.md')).toBe('untracked');
    expect(c.classOf('untracked.md')).toBe('manual');

    expect(c.kindOf('.claude/helpers/hook-handler.cjs')).toBe('ignored');
    expect(c.classOf('.claude/helpers/hook-handler.cjs')).toBe('auto');
  });

  it('tracked 优先于 ignored：进了 git 即便命中 ignore 规则也算 manual', async () => {
    writeFileSync(path.join(projectDir, '.gitignore'), '*.md\n');
    writeFileSync(path.join(projectDir, 'kept.md'), 'v1');
    git('init');
    git('add', '-f', '.gitignore', 'kept.md');

    const c = await gitClassify(projectDir, ['kept.md']);
    expect(c.kindOf('kept.md')).toBe('tracked');
    expect(c.classOf('kept.md')).toBe('manual');
  });

  it('空路径清单不炸', async () => {
    git('init');
    const c = await gitClassify(projectDir, []);
    expect(c.classOf('anything')).toBe('auto');
  });
});
