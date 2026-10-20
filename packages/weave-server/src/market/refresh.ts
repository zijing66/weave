import { stat } from 'node:fs/promises';
import { defaultGitExec, importFromDir, importFromGit, type GitExec } from './import.js';
import { readManifest, writeManifest } from './manifest.js';
import type { LibraryRepository } from '../repositories/libraries.js';
import type { MarketCheckTarget } from './updates.js';

/**
 * 市场缓存刷新（M4 一键更新的服务端半程）：dir 源重拷、git 源重 clone——
 * 复用 import 的同源覆盖分支（containment 双检、libraryId 不变），成功后
 * git 源回写 manifest.commit（启用预留位）。装面传播仍走既有 sync-all。
 */

export type RefreshStatus = 'refreshed' | 'origin-missing' | 'failed' | 'skipped';

export interface RefreshResult {
  id: number;
  status: RefreshStatus;
  /** git 源刷新后回写的 commit（dir 源无）。 */
  commit?: string;
}

export interface RefreshDeps {
  libraries: LibraryRepository;
  /** 覆盖数据根（测试注入）；默认 getDataRoot()。 */
  dataRoot?: string;
  /** 覆盖 git 执行（测试注入假 exec）。 */
  execGit?: GitExec;
}

async function existsDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/** 逐项刷新市场缓存（并发）；无 manifest 的 legacy 源跳过、origin 缺失不删缓存。 */
export async function refreshMarketItems(
  targets: MarketCheckTarget[],
  deps: RefreshDeps,
): Promise<RefreshResult[]> {
  return Promise.all(
    targets.map(async (t): Promise<RefreshResult> => {
      const manifest = await readManifest(t.dir);
      if (!manifest) return { id: t.id, status: 'skipped' };
      if (manifest.source === 'dir' && !(await existsDir(manifest.origin))) {
        return { id: t.id, status: 'origin-missing' };
      }
      try {
        if (manifest.source === 'git') {
          const res = await importFromGit(manifest.origin, deps);
          const commit = await readHead(res.dir, deps.execGit ?? defaultGitExec);
          if (commit) {
            const next = { ...(await readManifest(res.dir))!, commit };
            await writeManifest(res.dir, next);
            return { id: t.id, status: 'refreshed', commit };
          }
          return { id: t.id, status: 'refreshed' };
        }
        await importFromDir(manifest.origin, deps);
        return { id: t.id, status: 'refreshed' };
      } catch {
        return { id: t.id, status: 'failed' };
      }
    }),
  );
}

async function readHead(dir: string, execGit: GitExec): Promise<string | undefined> {
  try {
    const r = await execGit(
      'git',
      ['-C', dir, 'rev-parse', 'HEAD'],
      { timeout: 15_000, maxBuffer: 1024 * 1024, windowsHide: true },
    );
    const sha = r.stdout.trim();
    return sha || undefined;
  } catch {
    return undefined;
  }
}
