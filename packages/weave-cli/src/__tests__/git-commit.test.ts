import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { PromptPort } from '../init/prompt';
import {
  commitInitOutputs,
  collectCommitPaths,
  findGitRepoRoot,
  type GitExec,
  type GitResult,
} from '../init/git-commit';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'weave-gitcommit-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

/** 临时把 stdin/stdout 标成 TTY（commit 的交互闸），用完还原。 */
async function withTTY<T>(run: () => Promise<T>): Promise<T> {
  const origIn = process.stdin.isTTY;
  const origOut = process.stdout.isTTY;
  (process.stdin as { isTTY?: boolean }).isTTY = true;
  (process.stdout as { isTTY?: boolean }).isTTY = true;
  try {
    return await run();
  } finally {
    (process.stdin as { isTTY?: boolean }).isTTY = origIn;
    (process.stdout as { isTTY?: boolean }).isTTY = origOut;
  }
}

const promptConfirm = (answer: boolean): PromptPort =>
  ({ confirm: vi.fn(async () => answer), multiselect: vi.fn() }) as unknown as PromptPort;

/** 记录每次调用并按 argv 分派返回值的假 git。 */
function fakeGit(route: (args: string[]) => GitResult): { exec: GitExec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: GitExec = vi.fn(async (_file, args) => {
    calls.push(args);
    return route(args);
  });
  return { exec, calls };
}

const ok = (stdout = ''): GitResult => ({ stdout, stderr: '', code: 0 });
const exit = (code: number, stderr = ''): GitResult => ({ stdout: '', stderr, code });

describe('findGitRepoRoot', () => {
  it('finds a .git directory upward, rejects a .git file', async () => {
    await mkdir(path.join(tmpDir, '.git'));
    const nested = path.join(tmpDir, 'a', 'b');
    await mkdir(nested, { recursive: true });
    expect(await findGitRepoRoot(nested)).toBe(tmpDir);

    await rm(path.join(tmpDir, '.git'), { recursive: true });
    await writeFile(path.join(tmpDir, '.git'), 'gitdir: elsewhere');
    expect(await findGitRepoRoot(tmpDir)).toBeNull();
  });
});

describe('collectCommitPaths', () => {
  it('lists only present candidates, harness dirs driven by selected', async () => {
    await writeFile(path.join(tmpDir, 'CLAUDE.md'), '#');
    await writeFile(path.join(tmpDir, 'AGENTS.md'), '#');
    await mkdir(path.join(tmpDir, '.claude'));
    await mkdir(path.join(tmpDir, '.codex')); // 未选中 → 不入列
    await mkdir(path.join(tmpDir, '.weave'));
    const paths = await collectCommitPaths(tmpDir, ['claude']);
    expect(paths).toEqual(['CLAUDE.md', 'AGENTS.md', '.claude', '.weave']);
  });
});

describe('commitInitOutputs', () => {
  it('not-repo: skips silently with zero prompt/exec calls', async () => {
    const { exec, calls } = fakeGit(() => ok());
    const prompt = promptConfirm(true);
    const out = await commitInitOutputs({
      targetDir: tmpDir, // 无 .git
      interactive: true,
      selected: ['claude'],
      prompt,
      execGit: exec,
    });
    expect(out.status).toBe('not-repo');
    expect(calls).toHaveLength(0);
    expect(prompt.confirm).not.toHaveBeenCalled();
  });

  it('non-interactive: skipped with zero prompt/exec calls (safe default)', async () => {
    await mkdir(path.join(tmpDir, '.git'));
    const { exec, calls } = fakeGit(() => ok());
    const prompt = promptConfirm(true);
    const out = await commitInitOutputs({
      targetDir: tmpDir,
      interactive: false, // --no-interactive：不提问也不提交
      selected: ['claude'],
      prompt,
      execGit: exec,
    });
    expect(out.status).toBe('skipped');
    expect(calls).toHaveLength(0);
    expect(prompt.confirm).not.toHaveBeenCalled();
  });

  it('non-TTY: skipped with zero prompt/exec calls even when interactive', async () => {
    await mkdir(path.join(tmpDir, '.git'));
    const { exec, calls } = fakeGit(() => ok());
    const prompt = promptConfirm(true); // 假 confirm 返回 true——仍不得提交
    const out = await commitInitOutputs({
      targetDir: tmpDir,
      interactive: true,
      selected: ['claude'],
      prompt,
      execGit: exec,
    });
    expect(out.status).toBe('skipped');
    expect(calls).toHaveLength(0);
    expect(prompt.confirm).not.toHaveBeenCalled();
  });

  it('pre-staged index: skipped without asking', async () => {
    await mkdir(path.join(tmpDir, '.git'));
    const { exec, calls } = fakeGit((args) =>
      args[1] === '--cached' && args[2] === '--quiet' ? exit(1) : ok(),
    );
    const prompt = promptConfirm(true);
    const out = await withTTY(() =>
      commitInitOutputs({
        targetDir: tmpDir,
        interactive: true,
        selected: ['claude'],
        prompt,
        execGit: exec,
      }),
    );
    expect(out.status).toBe('skipped');
    expect(prompt.confirm).not.toHaveBeenCalled();
    expect(calls.every((a) => a[1] !== 'add')).toBe(true);
  });

  it('no changes on the candidate paths: no question', async () => {
    await mkdir(path.join(tmpDir, '.git'));
    await mkdir(path.join(tmpDir, '.claude'));
    const { exec } = fakeGit((args) =>
      args[1] === '--porcelain' ? ok('') : ok(),
    );
    const prompt = promptConfirm(true);
    const out = await withTTY(() =>
      commitInitOutputs({
        targetDir: tmpDir,
        interactive: true,
        selected: ['claude'],
        prompt,
        execGit: exec,
      }),
    );
    expect(out.status).toBe('no-changes');
    expect(prompt.confirm).not.toHaveBeenCalled();
  });

  it('declined: no add/commit calls, index untouched', async () => {
    await mkdir(path.join(tmpDir, '.git'));
    await mkdir(path.join(tmpDir, '.claude'));
    const { exec, calls } = fakeGit((args) =>
      args[1] === '--porcelain' ? ok('?? .claude/.gitignore') : ok(),
    );
    const prompt = promptConfirm(false);
    const out = await withTTY(() =>
      commitInitOutputs({
        targetDir: tmpDir,
        interactive: true,
        selected: ['claude'],
        prompt,
        execGit: exec,
      }),
    );
    expect(out.status).toBe('declined');
    expect(calls.some((a) => a[0] === 'add')).toBe(false);
    expect(calls.some((a) => a[0] === 'commit')).toBe(false);
  });

  it('accepted: pathspec add per path, then commit with the fixed message', async () => {
    await mkdir(path.join(tmpDir, '.git'));
    await mkdir(path.join(tmpDir, '.claude'));
    let staged = false;
    const { exec, calls } = fakeGit((args) => {
      const key = args.join(' ');
      if (key === 'diff --cached --quiet') return staged ? exit(1) : ok();
      if (args[1] === '--porcelain') return ok('?? CLAUDE.md');
      if (args[0] === 'add') {
        staged = true;
        return ok();
      }
      if (key === 'diff --cached --name-only') return ok('CLAUDE.md\n.claude/.gitignore');
      if (args[0] === 'commit') return ok();
      if (args[1] === '--short') return ok('abc1234');
      return ok();
    });
    const prompt = promptConfirm(true);
    const out = await withTTY(() =>
      commitInitOutputs({
        targetDir: tmpDir,
        interactive: true,
        selected: ['claude'],
        prompt,
        execGit: exec,
      }),
    );
    expect(out).toMatchObject({ status: 'committed', sha: 'abc1234', count: 2 });
    const adds = calls.filter((a) => a[0] === 'add');
    expect(adds.length).toBeGreaterThan(0);
    for (const a of adds) {
      expect(a).toContain('--'); // pathspec 分隔符防路径被解析成选项
      expect(a[2]).toMatch(/^(CLAUDE\.md|AGENTS\.md|\.mcp\.json|\.claude|\.codex|\.weave)$/);
    }
    const commit = calls.find((a) => a[0] === 'commit');
    expect(commit).toEqual(['commit', '-m', 'chore: weave init 生成初始化产物']);
    for (const c of calls) {
      expect(c).not.toContain('-A'); // 绝不整仓 add
      expect(c).not.toContain('-f'); // 绝不强制覆盖 ignore
    }
    expect(prompt.confirm).toHaveBeenCalledTimes(1);
  });

  it('a path rejected by gitignore warns but does not sink the rest', async () => {
    await mkdir(path.join(tmpDir, '.git'));
    await mkdir(path.join(tmpDir, '.claude'));
    await writeFile(path.join(tmpDir, 'CLAUDE.md'), '#');
    let staged = false;
    const { exec, calls } = fakeGit((args) => {
      if (args.join(' ') === 'diff --cached --quiet') return staged ? exit(1) : ok();
      if (args[1] === '--porcelain') return ok('?? CLAUDE.md');
      if (args[0] === 'add') {
        // CLAUDE.md 被根 ignore 拒绝，.claude 成功
        if (args[2] === 'CLAUDE.md') return exit(1, 'ignored by .gitignore');
        staged = true;
        return ok();
      }
      if (args.join(' ') === 'diff --cached --name-only') return ok('.claude/.gitignore');
      if (args[0] === 'commit') return ok();
      if (args[1] === '--short') return ok('def5678');
      return ok();
    });
    const out = await withTTY(() =>
      commitInitOutputs({
        targetDir: tmpDir,
        interactive: true,
        selected: ['claude'],
        prompt: promptConfirm(true),
        execGit: exec,
      }),
    );
    expect(out.status).toBe('committed');
    expect(calls.filter((a) => a[0] === 'add')).toHaveLength(2);
  });

  it('commit failure (e.g. missing user.email) degrades to failed, never throws', async () => {
    await mkdir(path.join(tmpDir, '.git'));
    await mkdir(path.join(tmpDir, '.claude'));
    let staged = false;
    const { exec } = fakeGit((args) => {
      if (args.join(' ') === 'diff --cached --quiet') return staged ? exit(1) : ok();
      if (args[1] === '--porcelain') return ok('?? CLAUDE.md');
      if (args[0] === 'add') {
        staged = true;
        return ok();
      }
      if (args.join(' ') === 'diff --cached --name-only') return ok('CLAUDE.md');
      if (args[0] === 'commit') return exit(1, 'Author identity unknown');
      return ok();
    });
    const out = await withTTY(() =>
      commitInitOutputs({
        targetDir: tmpDir,
        interactive: true,
        selected: ['claude'],
        prompt: promptConfirm(true),
        execGit: exec,
      }),
    );
    expect(out.status).toBe('failed');
  });

  it('spawn-level git failure (ENOENT) degrades to failed, never throws', async () => {
    await mkdir(path.join(tmpDir, '.git'));
    const exec: GitExec = vi.fn(async () => {
      throw new Error('spawn git ENOENT');
    });
    const out = await withTTY(() =>
      commitInitOutputs({
        targetDir: tmpDir,
        interactive: true,
        selected: ['claude'],
        prompt: promptConfirm(true),
        execGit: exec,
      }),
    );
    expect(out.status).toBe('failed');
  });
});
