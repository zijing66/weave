import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, stat } from 'node:fs/promises';
import { HARNESS_DIRS, type Harness, logger } from '@weavecode/core';
import { t } from '../i18n/index.js';
import type { PromptPort } from './prompt.js';

/**
 * init 收尾：交互式询问一次「是否把本次 init 的生成物提交为一个 commit」。
 *
 * 提交面 = 固定候选路径（CLAUDE.md / AGENTS.md / .mcp.json / selected 的
 * harness 目录 / .weave）逐路径 `git add -- <path>`——绝不 `git add -A`（不带
 * 用户工作区无关改动）、绝不 `-f`（不替用户推翻自己的 ignore 决定）。嵌套
 * 自忽略 `.gitignore` 保证 harness/.weave 目录内只有 gitignore 文件本身入库。
 *
 * 任何异常只降级为 warn + `failed` 结果，绝不向上传播——init 的文件成果
 * 不因本机 git 环境问题（未配 user.email、git 不在 PATH）而回滚。
 */

/**
 * Walk up from `startDir` to find the enclosing git repository root (a
 * directory containing `.git`). Returns null when outside a repository, or
 * when `.git` is a file (worktree/submodule) — weave does not resolve gitdirs
 * and leaves those alone.
 */
export async function findGitRepoRoot(startDir: string): Promise<string | null> {
  let dir = path.resolve(startDir);
  for (;;) {
    try {
      const st = await stat(path.join(dir, '.git'));
      return st.isDirectory() ? dir : null;
    } catch {
      // no .git here — keep walking up
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export interface GitResult {
  stdout: string;
  stderr: string;
  /** 进程退出码；spawn 层失败（ENOENT 等）由实现直接抛出。 */
  code: number;
}

/** git 调用缝：数组传参无 shell；非零退出不抛（语义由调用方判读）。 */
export type GitExec = (
  file: string,
  args: string[],
  options: { cwd: string },
) => Promise<GitResult>;

const execFileAsync = promisify(execFile);

export const defaultGitExec: GitExec = async (file, args, options) => {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, {
      cwd: options.cwd,
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    return { stdout: String(stdout), stderr: String(stderr), code: 0 };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      code?: number | string;
      stdout?: string;
      stderr?: string;
    };
    // 数字 code = 进程非零退出（git 语义交给调用方）；其余（ENOENT/
    // timeout signal）是 spawn 层失败，上抛由 commitInitOutputs 降级。
    if (typeof e.code === 'number') {
      return { stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? ''), code: e.code };
    }
    throw err;
  }
};

/** 固定候选路径（相对 targetDir）：selected 驱动 harness 目录，存在才列。 */
export async function collectCommitPaths(
  targetDir: string,
  selected: Harness[],
): Promise<string[]> {
  const candidates = [
    'CLAUDE.md',
    'AGENTS.md',
    '.mcp.json',
    ...selected.map((h) => HARNESS_DIRS[h].projectDir),
    '.weave',
  ];
  const present: string[] = [];
  for (const rel of candidates) {
    try {
      await lstat(path.join(targetDir, rel));
      if (!present.includes(rel)) present.push(rel);
    } catch {
      // absent — skip
    }
  }
  return present;
}

export type CommitOutcomeStatus =
  | 'committed'
  | 'declined'
  | 'no-changes'
  | 'skipped'
  | 'not-repo'
  | 'failed';

export interface CommitOutcome {
  status: CommitOutcomeStatus;
  /** 成功提交时的短 sha。 */
  sha?: string;
  /** 本次提交的文件数。 */
  count?: number;
}

export interface CommitInitOptions {
  targetDir: string;
  interactive: boolean;
  selected: Harness[];
  prompt: PromptPort;
  execGit?: GitExec;
}

export const COMMIT_MESSAGE = 'chore: weave init 生成初始化产物';

export async function commitInitOutputs(opts: CommitInitOptions): Promise<CommitOutcome> {
  try {
    return await runCommit(opts);
  } catch (err) {
    logger.warn(t('init.commit.failed', { error: err instanceof Error ? err.message : String(err) }));
    return { status: 'failed' };
  }
}

async function runCommit({
  targetDir,
  interactive,
  selected,
  prompt,
  execGit = defaultGitExec,
}: CommitInitOptions): Promise<CommitOutcome> {
  // 1) 非 git 仓库 → 整体跳过（不提问）
  if (!(await findGitRepoRoot(targetDir))) return { status: 'not-repo' };

  // 2) commit 是写操作：非交互/非 TTY 不提问也不提交（不沿用 confirm 的静默 true）
  if (!interactive || !process.stdin.isTTY || !process.stdout.isTTY) return { status: 'skipped' };

  // 3) 暂存区须干净：用户已有预暂存时不自动提交（git commit 会带上整个 index）
  const pre = await execGit('git', ['diff', '--cached', '--quiet'], { cwd: targetDir });
  if (pre.code !== 0) {
    if (pre.code === 1) {
      logger.dim(t('init.commit.preStaged'));
      return { status: 'skipped' };
    }
    throw new Error(pre.stderr.trim() || `git diff --cached exited ${pre.code}`);
  }

  // 4) 无变更不提问（status 看得见 untracked，且不污染 index）
  const paths = await collectCommitPaths(targetDir, selected);
  if (paths.length === 0) return { status: 'no-changes' };
  const status = await execGit('git', ['status', '--porcelain', '--', ...paths], {
    cwd: targetDir,
  });
  if (status.code !== 0) {
    throw new Error(status.stderr.trim() || `git status exited ${status.code}`);
  }
  if (!status.stdout.trim()) return { status: 'no-changes' };

  // 5) 唯一一次提问
  const detail = t('init.commit.detail', { paths: paths.join(', ') });
  if (!(await prompt.confirm(t('init.commit.question'), detail))) return { status: 'declined' };

  // 6) 逐路径 pathspec add（被根 ignore 拒绝的收集 warn，不拖垮其余）
  const ignored: string[] = [];
  for (const p of paths) {
    const add = await execGit('git', ['add', '--', p], { cwd: targetDir });
    if (add.code !== 0) ignored.push(p);
  }
  if (ignored.length > 0) logger.warn(t('init.commit.pathIgnored', { paths: ignored.join(', ') }));

  // 7) 提交前复核：add 全失败/无变化 → 不 commit
  const staged = await execGit('git', ['diff', '--cached', '--quiet'], { cwd: targetDir });
  if (staged.code === 0) {
    logger.warn(t('init.commit.failed', { error: 'nothing staged after git add' }));
    return { status: 'no-changes' };
  }
  if (staged.code !== 1) {
    throw new Error(staged.stderr.trim() || `git diff --cached exited ${staged.code}`);
  }
  const files = await execGit('git', ['diff', '--cached', '--name-only'], { cwd: targetDir });
  const count = files.stdout.split('\n').filter(Boolean).length;

  // 8) commit（单 -m，不打开编辑器；cwd=targetDir，子目录提交整仓由闸 3 保护）
  const commit = await execGit('git', ['commit', '-m', COMMIT_MESSAGE], { cwd: targetDir });
  if (commit.code !== 0) {
    throw new Error(commit.stderr.trim() || commit.stdout.trim() || `git commit exited ${commit.code}`);
  }

  // 9) 结果：短 sha + 文件数
  const shaOut = await execGit('git', ['rev-parse', '--short', 'HEAD'], { cwd: targetDir });
  const sha = shaOut.code === 0 ? shaOut.stdout.trim() : '';
  logger.success(t('init.commit.done', { sha, count }));
  return { status: 'committed', sha, count };
}
