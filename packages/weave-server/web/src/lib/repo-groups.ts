/**
 * 仓库维度一级分组（资源管理与 weave 两页共用）：L1 = 仓库 namespace，
 * 无 namespace 的资源并成一块「本地」。Skills 与 Plugins 讲的是同一个维度，
 * 各写一份必然漂移——故 L1 的实现只此一处。
 */

export interface RepoGroup<T> {
  key: string;
  /** undefined = 本地（非任何市场所出：手装/裸资源）。 */
  namespace?: string;
  /** 该仓库下的成员（技能包、工具包…按输入序）。 */
  groups: T[];
}

export const LOCAL_REPO_KEY = '__local__';

/** 按仓库 namespace 聚合；「本地」排最前，其余按市场名排序。 */
export function groupByRepo<T extends { namespace?: string }>(groups: T[]): RepoGroup<T>[] {
  const byRepo = new Map<string, RepoGroup<T>>();
  for (const g of groups) {
    const key = g.namespace ?? LOCAL_REPO_KEY;
    const entry: RepoGroup<T> = byRepo.get(key) ?? {
      key,
      ...(g.namespace !== undefined ? { namespace: g.namespace } : {}),
      groups: [],
    };
    entry.groups.push(g);
    byRepo.set(key, entry);
  }
  return [...byRepo.values()].sort((a, b) =>
    a.namespace === undefined
      ? -1
      : b.namespace === undefined
        ? 1
        : a.namespace.localeCompare(b.namespace),
  );
}

/** 折叠集切换（各级共用）。 */
export function toggleIn(set: Set<string>, key: string): Set<string> {
  const next = new Set(set);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}
