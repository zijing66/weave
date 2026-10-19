import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { StatuslineFacts } from '../../driver.js';

/** 与生成脚本 initCache 同一套目录摘要：大小写不敏感、分隔符归一、去尾斜杠。 */
export function gitCacheKeyOf(cwd: string): string {
  return createHash('sha1')
    .update(cwd.toLowerCase().replace(/\\/g, '/').replace(/\/+$/, ''))
    .digest('hex')
    .slice(0, 16);
}

interface GitCacheEntry {
  expires?: number;
  value?: unknown;
}

interface GitCacheFile {
  git?: Record<string, GitCacheEntry | undefined>;
}

/**
 * 渲染脚本把 git 三块的结果按目录分片落在 `git-<cwd 摘要>.json` 里（同一项目
 * 的会话共享，TTL 见生成脚本）。dashboard 要摆同样的块就从这儿取——不做 git
 * 探测、不算第二份事实：过期的条目一律不认（渲染侧同样会重探，认了就会和 TUI
 * 对不上），文件读不到 / 条目不在即返回 null。
 */
export function statuslineFactsFromCache(
  cacheDir: string,
  cwd: string,
  now: number = Date.now(),
): StatuslineFacts | null {
  let data: GitCacheFile;
  try {
    data = JSON.parse(
      readFileSync(path.join(cacheDir, `git-${gitCacheKeyOf(cwd)}.json`), 'utf-8'),
    ) as GitCacheFile;
  } catch {
    return null;
  }
  const fresh = (key: string): unknown => {
    const entry = data.git?.[key];
    if (!entry || typeof entry.expires !== 'number' || entry.expires <= now) return null;
    return entry.value ?? null;
  };

  const facts: StatuslineFacts = {};
  const branch = fresh('branch');
  if (typeof branch === 'string' && branch) facts.git = { branch };
  const user = fresh('git_user') as { user?: string; email?: string } | null;
  if (user && typeof user === 'object' && user.user) {
    facts.git_user = { user: user.user, email: user.email ?? '' };
  }
  const changes = fresh('changes') as {
    added?: number;
    deleted?: number;
    files?: number;
  } | null;
  if (changes && typeof changes === 'object') {
    facts.changes = {
      added: String(changes.added ?? 0),
      deleted: String(changes.deleted ?? 0),
      files: String(changes.files ?? 0),
    };
  }
  return Object.keys(facts).length > 0 ? facts : null;
}
