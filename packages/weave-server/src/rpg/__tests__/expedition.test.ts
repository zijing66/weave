import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createSessionWorktree,
  defaultWorktreeGitExec,
  type SessionWorktreeEntry,
} from '../../daemon/worktree.js';
import { anchorBranchOf, danglingRescueOptions, mergeIntoAnchoredBranch } from '../expedition.js';

/**
 * 出征全链 e2e（G2 验收②，真 git）：出征（建 worktree + 锚定）→ 分支上产出
 * （commit）→ 并回锚定分支；锚定悬空（用户删了锚分支）→ 挂起合并落 dangling。
 */
const hasGit = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'weave-test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'weave-test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
};

const git = (args: string[], cwd: string): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV });

describe('出征 → 产出 → 并回全链（真 git）', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'weave-expedition-'));
    git(['init', '-b', 'main'], root);
    git(['config', 'user.email', 'test@example.invalid'], root);
    git(['config', 'user.name', 'weave-test'], root);
    writeFileSync(path.join(root, 'base.txt'), 'base\n');
    git(['add', '-A'], root);
    git(['commit', '-qm', 'init'], root);
  });

  afterEach(() => {
    try {
      git(['worktree', 'prune'], root);
    } catch {
      /* root 已删 */
    }
    rmSync(root, { recursive: true, force: true });
  });

  const expedition = async (sessionId: string): Promise<{ entry: SessionWorktreeEntry & { anchorBranch: string; anchorSha: string }; wt: string }> => {
    const anchor = await anchorBranchOf(root, defaultWorktreeGitExec);
    expect(anchor.ok).toBe(true);
    const created = await createSessionWorktree(root, sessionId, defaultWorktreeGitExec);
    expect(created.ok).toBe(true);
    return {
      entry: {
        sessionId,
        projectId: 1,
        path: created.path!,
        branch: created.branch!,
        status: 'active',
        anchorBranch: anchor.branch!,
        anchorSha: anchor.sha!,
        at: new Date().toISOString(),
      },
      wt: created.path!,
    };
  };

  it.runIf(hasGit)('① 出征 → 分支产出 → 并回锚定分支（用户中途切走分支不影响）', async () => {
    const { entry, wt } = await expedition('abc12345');
    // 用户在会话存活期间把主干切到 feature 分支（锚定语义：并回仍恒 main@快照）
    git(['checkout', '-b', 'feature'], root);
    writeFileSync(path.join(root, 'feature.txt'), 'feature\n');
    git(['add', '-A'], root);
    git(['commit', '-qm', 'feature work'], root);
    // 角色在 worktree 里产出（commit 到出征分支）
    writeFileSync(path.join(wt, 'output.txt'), 'role output\n');
    git(['add', '-A'], wt);
    git(['commit', '-qm', 'role output'], wt);
    // 并回锚定分支（main）
    const outcome = await mergeIntoAnchoredBranch(root, entry, defaultWorktreeGitExec);
    expect(outcome).toMatchObject({ ok: true, merged: true, branch: 'main' });
    // 主干在 feature 分支上，但 main 的引用已含角色产出（对象库共享、即时可见）
    const mainHas = execFileSync('git', ['branch', '--contains', `${entry.branch}`, 'main'], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(mainHas).toContain('main');
  });

  it.runIf(hasGit)('② 锚定悬空：锚分支被删 → 挂起合并落 dangling、不改写历史', async () => {
    const { entry, wt } = await expedition('def67890');
    writeFileSync(path.join(wt, 'output.txt'), 'orphan output\n');
    git(['add', '-A'], wt);
    git(['commit', '-qm', 'orphan output'], wt);
    // 用户删了锚定分支
    git(['checkout', '-b', 'other'], root);
    git(['branch', '-D', entry.anchorBranch], root);
    const outcome = await mergeIntoAnchoredBranch(root, entry, defaultWorktreeGitExec);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.dangling).toBe(true);
    // 角色提交仍在对象库（活不丢）
    expect(git(['rev-parse', '--verify', `${entry.branch}^{commit}`], root)).toBeTruthy();
    // 三选一救援清单
    const options = danglingRescueOptions(entry.anchorBranch);
    expect(options.map((o) => o.key)).toEqual(['same-name', 'main', 'freeze']);
  });

  it.runIf(hasGit)('③ 锚分支已并过 = 幂等命中', async () => {
    const { entry, wt } = await expedition('abcdead0');
    writeFileSync(path.join(wt, 'x.txt'), 'x\n');
    git(['add', '-A'], wt);
    git(['commit', '-qm', 'x'], wt);
    expect(await mergeIntoAnchoredBranch(root, entry, defaultWorktreeGitExec)).toMatchObject({ ok: true });
    expect(await mergeIntoAnchoredBranch(root, entry, defaultWorktreeGitExec)).toMatchObject({ ok: true });
  });

  it.runIf(hasGit)('④ 冲突：临时 worktree 并回，冲突即 abort 还原、主干不脏', async () => {
    const { entry, wt } = await expedition('aaa00001');
    // 主干先行改 base.txt
    writeFileSync(path.join(root, 'base.txt'), 'user changed\n');
    git(['add', '-A'], root);
    git(['commit', '-qm', 'user change'], root);
    // 角色也改 base.txt
    writeFileSync(path.join(wt, 'base.txt'), 'role changed\n');
    git(['add', '-A'], wt);
    git(['commit', '-qm', 'role change'], wt);
    const outcome = await mergeIntoAnchoredBranch(root, entry, defaultWorktreeGitExec);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.conflict).toBe(true);
    // 主干工作区干净（abort 还原了）
    expect(git(['status', '--porcelain'], root)).toBe('');
    // 临时 merge worktree 已清
    expect(existsSync(path.join(root, '.weave', 'worktrees', `merge-${entry.sessionId.slice(0, 8)}`))).toBe(false);
  });
});
