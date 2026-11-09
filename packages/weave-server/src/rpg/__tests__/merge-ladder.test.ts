import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDatabase } from '../../db/db.js';
import { defaultWorktreeGitExec } from '../../daemon/worktree.js';
import {
  MergeLadderRepository,
  conflictSignature,
  ensureRerereLocal,
  runMergeLadder,
} from '../merge-ladder.js';

/**
 * 合并梯（G2 段3）验收④：机械层 + rerere 层真 git 闭环；AI 修补层注入 mock；
 * 每层落账 rpg_merge_ladder；AI resolved 两次同形冲突才记进 rerere cache。
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

describe('合并梯三层闭环', () => {
  let root: string;
  let db: ReturnType<typeof openDatabase>;
  let ladder: MergeLadderRepository;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'weave-ladder-'));
    git(['init', '-b', 'main'], root);
    git(['config', 'user.email', 'test@example.invalid'], root);
    git(['config', 'user.name', 'weave-test'], root);
    writeFileSync(path.join(root, 'a.txt'), 'base\n');
    git(['add', '-A'], root);
    git(['commit', '-qm', 'init'], root);
    db = openDatabase(':memory:');
    ladder = new MergeLadderRepository(db);
  });

  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  /** 造一次冲突现场（合并 worktree = repo 本身 detached 到 intoBranch 顶）。 */
  let setupSeq = 0;
  const conflictSetup = (roleChange: string, mainChange: string): { roleBranch: string } => {
    const name = `exp-${++setupSeq}`;
    git(['checkout', '-b', name], root);
    writeFileSync(path.join(root, 'a.txt'), roleChange);
    git(['add', '-A'], root);
    git(['commit', '-qm', 'role change'], root);
    const roleBranchHead = git(['rev-parse', 'HEAD'], root).trim();
    git(['checkout', 'main'], root);
    writeFileSync(path.join(root, 'a.txt'), mainChange);
    git(['add', '-A'], root);
    git(['commit', '-qm', 'main change'], root);
    return { roleBranch: roleBranchHead };
  };

  it.runIf(hasGit)('① 机械层：干净合并直落 ok', async () => {
    git(['checkout', '-b', 'exp-1'], root);
    writeFileSync(path.join(root, 'b.txt'), 'role\n');
    git(['add', '-A'], root);
    git(['commit', '-qm', 'role adds b'], root);
    const res = await runMergeLadder(
      { exec: defaultWorktreeGitExec, ladder, projectId: 1 },
      root,
      'exp-1',
      'main',
    );
    expect(res).toMatchObject({ ok: true, layer: 'mechanical', outcome: 'ok' });
    expect(git(['status', '--porcelain'], root)).toBe('');
    expect(ladder.listByProject(1)).toHaveLength(1);
  });

  it.runIf(hasGit)('② rerere 层：同形冲突第二次自动重放（先例复用）', async () => {
    // 第一跑：冲突 → 梯子打回（rerere 记下 preimage 形状）
    const first = conflictSetup('role\n', 'main\n');
    const firstRun = await runMergeLadder(
      { exec: defaultWorktreeGitExec, ladder, projectId: 1 },
      root,
      first.roleBranch,
      'main',
    );
    expect(firstRun.ok).toBe(false);
    // 种先例：把 postimage 写进 rerere 刚记的 preimage 桶（=「有人解过一次同形冲突」）
    const cacheDir = path.join(root, '.git', 'rr-cache');
    const hashes = readdirSync(cacheDir);
    expect(hashes.length).toBeGreaterThan(0);
    for (const h of hashes) writeFileSync(path.join(cacheDir, h, 'postimage'), 'resolved both\n');
    // 回退 main 到冲突前（reset --hard 回 preimage 记录前状态不可行——main 没动过，
    // 冲突只在工作区；rerere cache 已留账）。直接重并同一分支：同 preimage 哈希。
    git(['reset', '-q', '--hard', 'main'], root);
    const secondRun = await runMergeLadder(
      { exec: defaultWorktreeGitExec, ladder, projectId: 1 },
      root,
      first.roleBranch,
      'main',
    );
    expect(secondRun).toMatchObject({ ok: true, layer: 'rerere' });
    expect(git(['status', '--porcelain'], root)).toBe('');
    expect(ladder.listByProject(1).some((r) => r.layer === 'rerere' && r.outcome === 'replay')).toBe(true);
  });

  it.runIf(hasGit)('③ AI 修补层（mock）：resolved 两次同形才进 rerere cache；打回落 returned', async () => {
    const enterCache: string[] = [];
    const { roleBranch } = conflictSetup('role\n', 'main\n');
    const deps = {
      exec: defaultWorktreeGitExec,
      ladder,
      projectId: 1,
      aiRepair: async () => ({ outcome: 'resolved' as const, reason: 'both sides kept, called in sequence' }),
      enterRerereCache: async (_r: string, sig: string) => enterCache.push(sig),
    };
    const res1 = await runMergeLadder(deps, root, roleBranch, 'main');
    expect(res1).toMatchObject({ ok: true, layer: 'ai', outcome: 'resolved' });
    expect(enterCache).toHaveLength(0);
    const res2 = await runMergeLadder(deps, root, roleBranch, 'main');
    expect(res2.ok).toBe(true);
    expect(enterCache).toHaveLength(1);
    expect(ladder.countAiResolved(conflictSignature(['a.txt']))).toBeGreaterThanOrEqual(2);
  });

  it.runIf(hasGit)('④ 打回：AI unsolvable → 冲突带报告打回（returned 档）', async () => {
    const { roleBranch } = conflictSetup('role\n', 'main\n');
    const res = await runMergeLadder(
      {
        exec: defaultWorktreeGitExec,
        ladder,
        projectId: 1,
        aiRepair: async () => ({ outcome: 'unsolvable' as const, reason: 'value conflict, needs god' }),
      },
      root,
      roleBranch,
      'main',
    );
    expect(res).toMatchObject({ ok: false, layer: 'returned', outcome: 'returned' });
    expect(res.report).toContain('a.txt');
    expect(git(['status', '--porcelain'], root)).toBe('');
  });

  it.runIf(hasGit)('⑤ rerere 只落 repo-local（不动全局）', async () => {
    expect(await ensureRerereLocal(root, defaultWorktreeGitExec)).toBe(true);
    expect(git(['config', '--local', 'rerere.enabled'], root).trim()).toBe('true');
  });
});
