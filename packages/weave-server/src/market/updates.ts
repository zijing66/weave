import { stat } from 'node:fs/promises';
import path from 'node:path';
import { hashSkillDir } from '../install/fingerprint.js';
import { defaultGitExec, type GitExec } from './import.js';
import { readManifest } from './manifest.js';

/**
 * 市场缓存更新检查（M4）：比对 `<dataDir>/market/<slug>/` 与来源 origin——
 * dir 源比内容 hash、git 源比本地 HEAD vs ls-remote。只读、不落库（结果由
 * 调用方存 state，重查即刷）；装面更新由既有 sync-all 从缓存传播。
 */

export type MarketUpdateStatus = 'uptodate' | 'update-available' | 'origin-missing' | 'unknown';

export interface MarketUpdateCheck {
  id: number;
  status: MarketUpdateStatus;
  checkedAt: string;
}

export interface MarketCheckTarget {
  id: number;
  /** 市场缓存目录（绝对路径）。 */
  dir: string;
}

const CHECK_TIMEOUT_MS = 15_000;

/** 市场目录 hash 的跳过集：默认 sidecar + 清单文件（origin 侧无清单，跳过不影响对称）。 */
export const MARKET_SKIP_NAMES = new Set(['.weave', '.git', 'node_modules', '.weave-market.json']);

async function existsDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function checkDirSource(cacheDir: string, origin: string): Promise<MarketUpdateStatus> {
  const originAbs = path.resolve(origin);
  if (!(await existsDir(originAbs))) return 'origin-missing';
  const [cacheHash, originHash] = await Promise.all([
    hashSkillDir(cacheDir, MARKET_SKIP_NAMES),
    hashSkillDir(originAbs, MARKET_SKIP_NAMES),
  ]);
  return cacheHash === originHash ? 'uptodate' : 'update-available';
}

async function checkGitSource(
  cacheDir: string,
  origin: string,
  execGit: GitExec,
): Promise<MarketUpdateStatus> {
  const opts = { timeout: CHECK_TIMEOUT_MS, maxBuffer: 1024 * 1024, windowsHide: true };
  try {
    const local = await execGit('git', ['-C', cacheDir, 'rev-parse', 'HEAD'], opts);
    const remote = await execGit('git', ['ls-remote', origin, 'HEAD'], opts);
    const localSha = local.stdout.trim();
    const remoteSha = remote.stdout.trim().split(/\s+/)[0] ?? '';
    if (!localSha || !remoteSha) return 'unknown';
    return localSha === remoteSha ? 'uptodate' : 'update-available';
  } catch {
    return 'unknown'; // 网络/git 失败降级，不阻塞批量
  }
}

/** 逐项检查市场缓存是否有可用更新（并发；无 manifest 的 legacy 源 → unknown）。 */
export async function checkMarketUpdates(
  targets: MarketCheckTarget[],
  opts?: { execGit?: GitExec },
): Promise<MarketUpdateCheck[]> {
  const execGit = opts?.execGit ?? defaultGitExec;
  return Promise.all(
    targets.map(async (t): Promise<MarketUpdateCheck> => {
      const manifest = await readManifest(t.dir);
      let status: MarketUpdateStatus;
      if (!manifest) {
        status = 'unknown';
      } else if (manifest.source === 'git') {
        status = await checkGitSource(t.dir, manifest.origin, execGit);
      } else {
        status = await checkDirSource(t.dir, manifest.origin);
      }
      return { id: t.id, status, checkedAt: new Date().toISOString() };
    }),
  );
}
