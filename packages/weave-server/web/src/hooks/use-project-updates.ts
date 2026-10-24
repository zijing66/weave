import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type UpdateReport, type ProjectUpdateSummary } from '@/lib/api';
import { subscribePush } from '@/lib/sse';

/**
 * 项目更新域：选中项目的完整报告（顶栏「n 个更新」）+ 每行懒加载的计数缓存
 * （行内角标 + 「待 init」提醒）。`listUpdates` 每轮都要在项目里起 git 子进程
 * （Windows 上数百毫秒），而 `asset` 帧是成批到的——同一项目的在飞请求直接复用，
 * 别一帧一次。push 帧（updates）到达后整体覆盖计数缓存，与 hover 懒拉同源不双源。
 */
export function useProjectUpdates() {
  const [updates, setUpdates] = useState<UpdateReport | null>(null);
  // Per-project update summary — hover-lazy + cached per project id. Carries
  // both the badge count and the 「待 init」 reminder (same fetch, one cache).
  const [updatesMap, setUpdatesMap] = useState<
    Record<number, { available: number; needsInit: boolean }>
  >({});

  // `listUpdates` 每轮都要在项目里起 git 子进程（Windows 上数百毫秒），而 `asset`
  // 帧是成批到的——同一项目的在飞请求直接复用，别一帧一次。
  const updatesFlight = useRef<Map<number, Promise<UpdateReport>>>(new Map());
  const fetchUpdates = useCallback((projectId: number): Promise<UpdateReport> => {
    const flying = updatesFlight.current.get(projectId);
    if (flying) return flying;
    const p = api.listUpdates(projectId).finally(() => updatesFlight.current.delete(projectId));
    updatesFlight.current.set(projectId, p);
    return p;
  }, []);

  const refreshUpdates = useCallback(
    (projectId: number) => {
      fetchUpdates(projectId).then(setUpdates).catch(() => {});
    },
    [fetchUpdates],
  );

  // 行内 updates 计数：行 hover 懒加载 + 按 id 缓存（listUpdates 要算指纹，
  // 不做全量预拉）；force 供行同步后重拉。
  const ensureUpdates = useCallback(
    (projectId: number, force = false) => {
      if (!force && updatesMap[projectId] !== undefined) return;
      fetchUpdates(projectId)
        .then((r) => {
          setUpdatesMap((prev) => ({
            ...prev,
            [projectId]: { available: r.available, needsInit: r.needsInit },
          }));
        })
        .catch(() => {});
    },
    [updatesMap, fetchUpdates],
  );

  // 项目更新摘要（角标条数 + 待 init 提醒）：绝对值快照整体覆盖（含 0/false =
  // 归零）——与 hover 懒拉共用同一个 updatesMap，push 到达后即以它为准，不双源。
  useEffect(
    () =>
      subscribePush<{ counts: Record<number, ProjectUpdateSummary> }>('updates', (p) =>
        setUpdatesMap(p.counts ?? {}),
      ),
    [],
  );

  return { updates, setUpdates, updatesMap, setUpdatesMap, fetchUpdates, refreshUpdates, ensureUpdates };
}
