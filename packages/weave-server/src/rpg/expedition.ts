import path from 'node:path';
import type { WorktreeGitExec, SessionWorktreeEntry } from '../daemon/worktree.js';

/**
 * 出征（G2 段2，方案 C / G线设计 §三）：给角色在目标项目上开 worktree 会话，
 * **并回目标分支 = 出征起手快照锚定的分支**（锚定后用户切走分支不影响闭环——
 * 并的是快照 ref 不是「当时的当前」；B5 既有 mergeSessionWorktree 并「当下的
 * 当前分支」，出征分支并「锚定的那支」）。锚定悬空（锚分支被删/重置致合并断裂）
 * = 挂起合并不改写历史、状态落 dangling，三选一救援由上层裁决。
 */

export interface AnchorResult {
  ok: boolean;
  branch?: string;
  sha?: string;
  error?: string;
}

/** 起手锚定：读目标项目当前分支名 + 头 commit（快照，之后不跟用户切分支走）。 */
export async function anchorBranchOf(
  projectPath: string,
  exec: WorktreeGitExec,
): Promise<AnchorResult> {
  const head = await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: projectPath });
  if (head.code !== 0) return { ok: false, error: 'cannot resolve current branch' };
  const branch = head.stdout.trim();
  const sha = await exec('git', ['rev-parse', 'HEAD'], { cwd: projectPath });
  if (sha.code !== 0) return { ok: false, error: 'cannot resolve HEAD' };
  return { ok: true, branch, sha: sha.stdout.trim() };
}

export type ExpeditionMergeOutcome =
  | { ok: true; merged: true; branch: string; layer: 'mechanical' }
  | { ok: false; merged: false; conflict: boolean; dangling: boolean; error: string };

/**
 * 并回锚定分支（合并梯第 0 层机械）：merge 前先验锚分支还活着——被删/重置 =
 * **锚定悬空**：不并、不改写历史（角色提交作为孤儿仍在 object store）、登记落
 * `dangling`，三选一救援（并回同名新分支 / 并回主支 / 冻结）由上层呈级2。
 * 冲突 = `merge --abort` 还原主干原状 + `conflict:true`（进合并梯第 1 层）。
 */
export async function mergeIntoAnchoredBranch(
  projectPath: string,
  entry: SessionWorktreeEntry & { anchorBranch: string },
  exec: WorktreeGitExec,
): Promise<ExpeditionMergeOutcome> {
  const anchor = entry.anchorBranch;
  const verify = await exec('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${anchor}`], {
    cwd: projectPath,
  });
  if (verify.code !== 0) {
    return {
      ok: false,
      merged: false,
      conflict: false,
      dangling: true,
      error: `anchored branch ${anchor} no longer exists — expedition commits remain in the object store`,
    };
  }
  const ancestor = await exec('git', ['merge-base', '--is-ancestor', entry.branch, anchor], {
    cwd: projectPath,
  });
  if (ancestor.code === 0) {
    return { ok: true, merged: true, branch: anchor, layer: 'mechanical' };
  }
  // 主干工作区不能 checkout 到锚分支（可能被用户占着）：并回走**临时 worktree**
  // ——同一 object store / refs，物理隔离用户的检出（可见性铁律：永不写对方工作区）。
  const tmpWt = path.join(projectPath, '.weave', 'worktrees', `merge-${entry.sessionId.slice(0, 8) || 'x'}`);
  const add = await exec('git', ['worktree', 'add', '--detach', tmpWt, anchor], { cwd: projectPath });
  if (add.code !== 0) {
    return {
      ok: false,
      merged: false,
      conflict: false,
      dangling: false,
      error: (add.stderr || add.stdout).trim().split('\n').slice(-3).join(' | ') || 'cannot open merge worktree',
    };
  }
  try {
    const merge = await exec('git', ['merge', '--no-edit', '--no-ff', entry.branch], { cwd: tmpWt });
    if (merge.code === 0) {
      // detach 形态检出：merge commit 落在游离头上——快照 ref 归位（branch 即快照）
      const upd = await exec('git', ['update-ref', `refs/heads/${anchor}`, 'HEAD'], { cwd: tmpWt });
      if (upd.code !== 0) {
        return { ok: false, merged: false, conflict: false, dangling: false, error: 'merge succeeded but ref update failed' };
      }
      return { ok: true, merged: true, branch: anchor, layer: 'mechanical' };
    }
    const output = `${merge.stderr}\n${merge.stdout}`;
    await exec('git', ['merge', '--abort'], { cwd: tmpWt });
    if (/CONFLICT/i.test(output)) {
      return { ok: false, merged: false, conflict: true, dangling: false, error: 'merge conflicts at anchored branch' };
    }
    return {
      ok: false,
      merged: false,
      conflict: false,
      dangling: false,
      error: output.trim().split('\n').slice(-3).join(' | ') || 'git merge failed',
    };
  } finally {
    await exec('git', ['worktree', 'remove', '--force', tmpWt], { cwd: projectPath });
  }
}

/** 锚定悬空的救援去向清单（上层呈给用户三选一；纯函数便于单测与 UI 复用）。 */
export function danglingRescueOptions(anchorBranch: string): Array<{ key: 'same-name' | 'main' | 'freeze'; describe: string }> {
  return [
    { key: 'same-name', describe: `merge into a recreated branch named "${anchorBranch}" (auto when not diverged)` },
    { key: 'main', describe: 'merge into the main branch via the three-layer ladder' },
    { key: 'freeze', describe: 'freeze the worktree pending a level-2 decision' },
  ];
}
