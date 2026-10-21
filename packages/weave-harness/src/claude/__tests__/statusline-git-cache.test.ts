import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { gitCacheKeyOf, statuslineFactsFromCache } from '../statusline/git-cache.js';

const NOW = 1_700_000_000_000;

const dirs: string[] = [];

function cacheDirWith(git: Record<string, unknown>): { dir: string; cwd: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'weave-sl-'));
  dirs.push(dir);
  const cwd = path.join('D:', 'repo', 'proj');
  writeFileSync(path.join(dir, `git-${gitCacheKeyOf(cwd)}.json`), JSON.stringify({ git }));
  return { dir, cwd };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('statuslineFactsFromCache', () => {
  it('把缓存条目翻成块 token（git 三块）', () => {
    const { dir, cwd } = cacheDirWith({
      branch: { expires: NOW + 60_000, value: 'main' },
      git_user: { expires: NOW + 3_600_000, value: { user: 'yao', email: 'yao@weave.dev' } },
      changes: { expires: NOW + 60_000, value: { added: 2, deleted: 1, files: 1 } },
    });
    expect(statuslineFactsFromCache(dir, cwd, NOW)).toEqual({
      git: { branch: 'main' },
      git_user: { user: 'yao', email: 'yao@weave.dev' },
      changes: { added: '2', deleted: '1', files: '1' },
    });
  });

  it('带上游差异条目时 git 块多出 ahead/behind/sync', () => {
    const { dir, cwd } = cacheDirWith({
      branch: { expires: NOW + 60_000, value: 'main' },
      sync: { expires: NOW + 60_000, value: { ahead: '1', behind: '2', sync: '(2↓/1↑)' } },
    });
    expect(statuslineFactsFromCache(dir, cwd, NOW)).toEqual({
      git: { branch: 'main', ahead: '1', behind: '2', sync: '(2↓/1↑)' },
    });
  });

  it('同步条目缺席或过期时 git 块只剩 branch', () => {
    const { dir, cwd } = cacheDirWith({
      branch: { expires: NOW + 60_000, value: 'main' },
      sync: { expires: NOW - 1, value: { ahead: '1', behind: '0', sync: '(1↑)' } },
    });
    expect(statuslineFactsFromCache(dir, cwd, NOW)).toEqual({ git: { branch: 'main' } });
  });

  it('过期条目、失败条目（value null）、没缓存一律不认', () => {
    const { dir, cwd } = cacheDirWith({
      branch: { expires: NOW - 1, value: 'main' },
      git_user: { expires: NOW + 1_000, value: null },
    });
    expect(statuslineFactsFromCache(dir, cwd, NOW)).toBeNull();
    expect(statuslineFactsFromCache(path.join(dir, 'nope'), cwd, NOW)).toBeNull();
  });

  it('目录摘要忽略大小写、分隔符与尾斜杠', () => {
    expect(gitCacheKeyOf('D:\\Repo\\Proj\\')).toBe(gitCacheKeyOf('d:/repo/proj'));
  });
});
