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
 * 陈旧豁免窗：TTL 过期但窗内的**好值**照摆。git 事实是展示性数据——非活跃仓库
 * （TUI 不在跑、没人动 git）的过期值就是现值，条目过期即消失只会让对话窗底条的
 * git 块无故蒸发（2026-11-07 用户实测：有时 git 信息不显示）。超过硬窗（一天没
 * 任何会话碰过这仓库）才不认。失败探测条目（value=null）没有旧值可摆，不豁免。
 */
const STALE_GRACE_MS = 24 * 60 * 60_000;

/**
 * 渲染脚本把 git 三块的结果按目录分片落在 `git-<cwd 摘要>.json` 里（同一项目
 * 的会话共享，TTL 见生成脚本）。dashboard 要摆同样的块就从这儿取——不做 git
 * 探测、不算第二份事实：TTL 内的值照读；过期的条目走陈旧豁免窗（见上）——
 * 渲染侧 TTL 到点自己重探，两边只在「仓库刚变、TUI 还没跑下一次渲染」的秒级
 * 窗口里可能差一拍，可接受。文件读不到 / 条目不在即返回 null。
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
    if (!entry || typeof entry.expires !== 'number' || entry.value == null) return null;
    // TTL 内 → 现值；过期但窗内 → 陈旧豁免（好值照摆）；超窗/失败条目 → null。
    return entry.expires > now || entry.expires > now - STALE_GRACE_MS ? entry.value : null;
  };

  const facts: StatuslineFacts = {};
  const branch = fresh('branch');
  if (typeof branch === 'string' && branch) {
    facts.git = { branch };
    const sync = fresh('sync') as { ahead?: string; behind?: string; sync?: string } | null;
    if (sync && typeof sync === 'object' && sync.sync) {
      facts.git.ahead = sync.ahead ?? '';
      facts.git.behind = sync.behind ?? '';
      facts.git.sync = sync.sync;
    }
  }
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
