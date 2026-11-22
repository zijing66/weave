/**
 * sessionStorage 对话缓存/锚点的孤儿清扫（用户裁决 2026-11-20）：会话已被 sweeper
 * 清掉后，`weave:conv:<id>` 只能等 TTL 过期或被 LRU 逐出，`weave:conv-anchor:<id>`
 * 更是只写不删、永远残着。打开项目时对着服务端现存会话清单对一次账即可。
 */

const CONV_PREFIX = 'weave:conv:';
const ANCHOR_PREFIX = 'weave:conv-anchor:';

/** 只认 `weave:conv:` 前缀（不带 `weave:conv-anchor:`），锚点键不在返回里。 */
const convCacheKeys = (): string[] => {
  const keys: string[] = [];
  for (let i = 0; i < sessionStorage.length; i += 1) {
    const key = sessionStorage.key(i);
    if (key?.startsWith(CONV_PREFIX) && !key.startsWith(ANCHOR_PREFIX)) keys.push(key);
  }
  return keys;
};

const sessionIdOf = (key: string, prefix: string): string => key.slice(prefix.length);

/** 清掉会话已不存在的对话缓存与滚动锚；`alive` 之外都算孤儿。 */
export function sweepConvCacheOrphans(alive: ReadonlySet<string>): void {
  try {
    for (const key of convCacheKeys()) {
      if (!alive.has(sessionIdOf(key, CONV_PREFIX))) sessionStorage.removeItem(key);
    }
    const anchorKeys: string[] = [];
    for (let i = 0; i < sessionStorage.length; i += 1) {
      const key = sessionStorage.key(i);
      if (key?.startsWith(ANCHOR_PREFIX)) anchorKeys.push(key);
    }
    for (const key of anchorKeys) {
      if (!alive.has(sessionIdOf(key, ANCHOR_PREFIX))) sessionStorage.removeItem(key);
    }
  } catch {
    // 存储被禁（隐私模式）：清扫不是功能，静默跳过
  }
}
