import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ensureGitExcludes, excludeEntries } from '../init/git-exclude';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'weave-gitexclude-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

const excludeOf = async (repo = tmpDir): Promise<string> =>
  readFile(path.join(repo, '.git', 'info', 'exclude'), 'utf-8');

describe('excludeEntries', () => {
  it('lists the local instruction file of every harness plus .weave/token', () => {
    const entries = excludeEntries();
    expect(entries).toContain('CLAUDE.local.md');
    expect(entries).toContain('AGENTS.override.md');
    expect(entries).toContain('.weave/token');
  });
});

describe('ensureGitExcludes', () => {
  it('writes the weave block into info/exclude when absent', async () => {
    await mkdir(path.join(tmpDir, '.git', 'info'), { recursive: true });
    await writeFile(path.join(tmpDir, '.git', 'info', 'exclude'), 'orig\n');
    await ensureGitExcludes(tmpDir);
    const text = await excludeOf();
    expect(text).toContain('orig\n'); // 用户既有内容原样保留
    expect(text).toContain('# weave:start');
    expect(text).toContain('CLAUDE.local.md');
    expect(text).toContain('AGENTS.override.md');
    expect(text).toContain('# weave:end');
  });

  it('is idempotent — a second run leaves the file byte-identical', async () => {
    await mkdir(path.join(tmpDir, '.git', 'info'), { recursive: true });
    await ensureGitExcludes(tmpDir);
    const first = await excludeOf();
    await ensureGitExcludes(tmpDir);
    expect(await excludeOf()).toBe(first);
  });

  it('creates info/ when the repo has no info dir yet', async () => {
    await mkdir(path.join(tmpDir, '.git'), { recursive: true });
    await ensureGitExcludes(tmpDir);
    expect(await excludeOf()).toContain('# weave:start');
  });

  it('no-op outside a git repository', async () => {
    await ensureGitExcludes(tmpDir);
    // 无 .git → 没有任何落盘（目录都不该出现）
    await expect(excludeOf()).rejects.toThrow();
  });

  it('leaves a half-written block alone (does not guess)', async () => {
    await mkdir(path.join(tmpDir, '.git', 'info'), { recursive: true });
    await writeFile(path.join(tmpDir, '.git', 'info', 'exclude'), '# weave:start\nFOO\n');
    await ensureGitExcludes(tmpDir);
    expect(await excludeOf()).toBe('# weave:start\nFOO\n');
  });

  it('skips writing when the block already exists (even with other content)', async () => {
    await mkdir(path.join(tmpDir, '.git', 'info'), { recursive: true });
    const pre = `user rule\n# weave:start\nX\n# weave:end\ntrailing\n`;
    await writeFile(path.join(tmpDir, '.git', 'info', 'exclude'), pre);
    await ensureGitExcludes(tmpDir);
    expect(await excludeOf()).toBe(pre);
  });
});
