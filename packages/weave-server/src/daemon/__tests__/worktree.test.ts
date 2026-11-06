import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createSessionWorktree,
  mergeSessionWorktree,
  sessionWorktreeBranch,
  sessionWorktreeDir,
  sweepWorktreeMerges,
  readWorktreeRegistry,
  upsertWorktreeEntry,
  claimPendingSessionWorktree,
  PENDING_WT_PREFIX,
  type SessionWorktreeEntry,
} from '../worktree.js';

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

const write = (root: string, rel: string, body = ''): void => {
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, body);
};

let root: string;
let hooksDir: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'weave-wt-'));
  hooksDir = mkdtempSync(path.join(tmpdir(), 'weave-wt-hooks-'));
  git(['init', '-b', 'main'], root);
  git(['config', 'user.email', 'test@example.invalid'], root);
  git(['config', 'user.name', 'weave-test'], root);
  write(root, 'a.txt', 'base\n');
  git(['add', '-A'], root);
  git(['commit', '-qm', 'init'], root);
});

afterEach(() => {
  // 先 prune 再删：worktree 登记在 root/.git 里，直接 rm 会留悬登记（无所谓，目录都删了）
  try {
    git(['worktree', 'prune'], root);
  } catch {
    // root 已不在（个别用例删过）
  }
  rmSync(root, { recursive: true, force: true });
  rmSync(hooksDir, { recursive: true, force: true });
});

const entryOf = (sessionId: string): SessionWorktreeEntry => {
  const entries = readWorktreeRegistry(hooksDir);
  const entry = entries[sessionId];
  if (!entry) throw new Error(`no registry entry for ${sessionId}`);
  return entry;
};

/** 建 + 登记（路由侧两步合一的镜像；单测里拆开验登记读写）。 */
async function createAndRegister(sessionId: string): Promise<SessionWorktreeEntry> {
  const r = await createSessionWorktree(root, sessionId);
  if (!r.ok || !r.path || !r.branch) throw new Error(r.error ?? 'create failed');
  upsertWorktreeEntry(hooksDir, {
    sessionId,
    projectId: 1,
    path: r.path,
    branch: r.branch,
    status: 'active',
    at: new Date().toISOString(),
  });
  return entryOf(sessionId);
}

describe('createSessionWorktree', () => {
  it.skipIf(!hasGit)('git 仓里建出 worktree 目录与分支，cwd 指向它', async () => {
    const r = await createSessionWorktree(root, 'sess-abcdef12');
    expect(r.ok).toBe(true);
    expect(r.path).toBe(sessionWorktreeDir(root, 'sess-abcdef12'));
    expect(r.branch).toBe('weave/session-sess-abc');
    expect(existsSync(r.path!)).toBe(true);
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], r.path!).trim()).toBe(
      'weave/session-sess-abc',
    );
  });

  it.skipIf(!hasGit)('幂等：同一会话二次请求原样命中，不重建', async () => {
    const first = await createSessionWorktree(root, 'sess-dup');
    const second = await createSessionWorktree(root, 'sess-dup');
    expect(second).toEqual(first);
  });

  it.skipIf(!hasGit)('非 git 仓：unsupported=true（409 语义，不炸）', async () => {
    const plain = mkdtempSync(path.join(tmpdir(), 'weave-wt-plain-'));
    try {
      const r = await createSessionWorktree(plain, 'sess-1');
      expect(r.ok).toBe(false);
      expect(r.unsupported).toBe(true);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it.skipIf(!hasGit)('git 不在 PATH：unsupported=true', async () => {
    const r = await createSessionWorktree(root, 'sess-1', async () => {
      throw new Error('git is not available on PATH');
    });
    expect(r.unsupported).toBe(true);
  });
});

describe('mergeSessionWorktree', () => {
  it.skipIf(!hasGit)('干净并回：会话分支的改动落进主干，登记可落 merged', async () => {
    const entry = await createAndRegister('sess-clean');
    write(entry.path, 'b.txt', 'from worktree\n');
    git(['add', '-A'], entry.path);
    git(['commit', '-qm', 'wt work'], entry.path);
    const outcome = await mergeSessionWorktree(root, entry);
    expect(outcome.ok).toBe(true);
    expect(git(['log', '--oneline', '-3'], root)).toContain('wt work');
    expect(existsSync(path.join(root, 'b.txt'))).toBe(true);
  });

  it.skipIf(!hasGit)('幂等：分支已是祖先（登记丢失后重试）直接命中不重并', async () => {
    const entry = await createAndRegister('sess-again');
    write(entry.path, 'c.txt', 'x\n');
    git(['add', '-A'], entry.path);
    git(['commit', '-qm', 'once'], entry.path);
    expect((await mergeSessionWorktree(root, entry)).ok).toBe(true);
    // 登记丢了再并一次：merge-base --is-ancestor 命中 → ok 且不再产生新提交
    const before = git(['rev-parse', 'HEAD'], root).trim();
    const second = await mergeSessionWorktree(root, entry);
    expect(second.ok).toBe(true);
    expect(git(['rev-parse', 'HEAD'], root).trim()).toBe(before);
  });

  it.skipIf(!hasGit)('冲突：不并、abort 还原主干、如实报 conflict——worktree 完好', async () => {
    const entry = await createAndRegister('sess-clash');
    // 主干先改同一行
    write(root, 'a.txt', 'main side\n');
    git(['add', '-A'], root);
    git(['commit', '-qm', 'main change'], root);
    // worktree 改同一行
    write(entry.path, 'a.txt', 'worktree side\n');
    git(['add', '-A'], entry.path);
    git(['commit', '-qm', 'wt change'], entry.path);
    const outcome = await mergeSessionWorktree(root, entry);
    expect(outcome.ok).toBe(false);
    expect(outcome.conflict).toBe(true);
    // 主干无残留（abort 生效）：没有 MERGE_HEAD、工作区还是 main side
    expect(existsSync(path.join(root, '.git', 'MERGE_HEAD'))).toBe(false);
    expect(git(['rev-parse', 'HEAD'], root).trim()).toBe(git(['rev-parse', 'main'], root).trim());
    // worktree 目录与分支都还在（用户自己解冲突的现场保留）
    expect(existsSync(entry.path)).toBe(true);
    expect(git(['rev-parse', '--verify', `${entry.branch}^{commit}`], root).trim().length).toBe(40);
  });

  it.skipIf(!hasGit)('分支被用户删了：如实报错，不重建不硬并', async () => {
    const entry = await createAndRegister('sess-gone');
    git(['worktree', 'remove', entry.path], root);
    git(['branch', '-D', entry.branch], root);
    const outcome = await mergeSessionWorktree(root, entry);
    expect(outcome.ok).toBe(false);
    expect(outcome.conflict).toBe(false);
    expect(outcome.error).toContain('no longer exists');
  });
});

describe('sweepWorktreeMerges（并回驱动）', () => {
  const scan = (sessions: Array<{ sessionId: string; harness?: 'claude'; lastEventType?: string | null }>) =>
    sweepWorktreeMerges({
      sessions,
      projectPathOf: () => root,
      hooksDir,
    });

  it.skipIf(!hasGit)('退出事件（SessionEnd）到 → 并回 + 清 worktree + 登记清零（无残留）', async () => {
    const entry = await createAndRegister('sess-exit');
    write(entry.path, 'd.txt', 'done\n');
    git(['add', '-A'], entry.path);
    git(['commit', '-qm', 'wt done'], entry.path);
    const n = await scan([{ sessionId: 'sess-exit', harness: 'claude', lastEventType: 'SessionEnd' }]);
    expect(n).toBe(1);
    // 目录与分支清干净（并回后无残留）
    expect(existsSync(entry.path)).toBe(false);
    expect(
      execFileSync('git', ['branch', '--list', 'weave/session-sess-exi'], { cwd: root, encoding: 'utf8' }).trim(),
    ).toBe('');
    // 主干拿到改动
    expect(existsSync(path.join(root, 'd.txt'))).toBe(true);
    // 登记清零
    expect(readWorktreeRegistry(hooksDir)['sess-exit']).toBeUndefined();
  });

  it.skipIf(!hasGit)('退出事件没到：不动（会话还活着）', async () => {
    await createAndRegister('sess-live');
    const n = await scan([{ sessionId: 'sess-live', harness: 'claude', lastEventType: 'Stop' }]);
    expect(n).toBe(0);
    expect(existsSync(entryOf('sess-live').path)).toBe(true);
  });

  it.skipIf(!hasGit)('冲突场景：状态落 conflict、worktree 保留，下一拍不重复并', async () => {
    const entry = await createAndRegister('sess-cfl');
    write(root, 'a.txt', 'main side\n');
    git(['add', '-A'], root);
    git(['commit', '-qm', 'main change'], root);
    write(entry.path, 'a.txt', 'wt side\n');
    git(['add', '-A'], entry.path);
    git(['commit', '-qm', 'wt change'], entry.path);
    const n = await scan([{ sessionId: 'sess-cfl', harness: 'claude', lastEventType: 'SessionEnd' }]);
    expect(n).toBe(1);
    const after = readWorktreeRegistry(hooksDir)['sess-cfl']!;
    expect(after.status).toBe('conflict');
    expect(existsSync(entry.path)).toBe(true);
    // 再扫一轮：非 active 不重并
    const again = await scan([{ sessionId: 'sess-cfl', harness: 'claude', lastEventType: 'SessionEnd' }]);
    expect(again).toBe(0);
  });

  it.skipIf(!hasGit)('重启恢复：登记在盘上，重启后第一拍把没接完的并回接上', async () => {
    // 模拟重启：登记已落盘（上一进程写的），扫描无状态依赖
    const entry = await createAndRegister('sess-rearm');
    write(entry.path, 'e.txt', 'rearmed\n');
    git(['add', '-A'], entry.path);
    git(['commit', '-qm', 'rearm'], entry.path);
    // 「新进程」直接扫（同一个 hooksDir，登记是从盘上读的）
    const n = await scan([{ sessionId: 'sess-rearm', harness: 'claude', lastEventType: 'SessionEnd' }]);
    expect(n).toBe(1);
    expect(existsSync(path.join(root, 'e.txt'))).toBe(true);
  });
});

describe('claimPendingSessionWorktree（占位认领）', () => {
  it.skipIf(!hasGit)('cwd 命中占位登记 → 改绑真实 sessionId，目录与分支不动', async () => {
    const key = PENDING_WT_PREFIX + 'uuid-1';
    const pending = await createAndRegister(key);
    const claimed = claimPendingSessionWorktree(hooksDir, 'sess-real-9', pending.path);
    expect(claimed).not.toBeNull();
    expect(claimed!.sessionId).toBe('sess-real-9');
    expect(claimed!.path).toBe(pending.path);
    expect(claimed!.branch).toBe(sessionWorktreeBranch(key));
    expect(readWorktreeRegistry(hooksDir)[key]).toBeUndefined();
    expect(readWorktreeRegistry(hooksDir)['sess-real-9']).toBeDefined();
  });

  it.skipIf(!hasGit)('cwd 不命中 / 无 sessionId：原样 null，登记不动', () => {
    expect(claimPendingSessionWorktree(hooksDir, 'sess-x', path.join(root, 'nowhere'))).toBeNull();
    expect(claimPendingSessionWorktree(hooksDir, 'sess-x', null)).toBeNull();
  });
});
