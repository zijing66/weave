import { useQuery } from '@tanstack/react-query';
import type { ProjectRow } from '@/lib/api';
import { PROJECTS_QUERY } from '@/hooks/use-projects';
import { useFederatedPeerBuckets } from './use-federated-peers';

/**
 * `#` 会话引用选择器的数据面（组件无关，主窗与弹出窗同一份）：
 * - 项目列表：PROJECTS_QUERY（staleTime Infinity，主窗早已拉过时 TanStack 缓存直接命中）
 *   + sessionStorage 种子（`weave:shuttle-projects`）——弹出窗冷启动先吃种子出账，
 *   后台拉新替换；写读同形，跨窗共享的是缓存不是状态。
 * - 联邦对端账：选择器开着才拉（原样）。
 */
const SEED_KEY = 'weave:shuttle-projects';

function readSeed(): ProjectRow[] {
  try {
    const raw = sessionStorage.getItem(SEED_KEY);
    if (!raw) return [];
    const p = JSON.parse(raw) as { at?: number; projects?: ProjectRow[] };
    return Array.isArray(p.projects) ? p.projects : [];
  } catch {
    return [];
  }
}

function writeSeed(projects: ProjectRow[]): void {
  try {
    sessionStorage.setItem(SEED_KEY, JSON.stringify({ at: Date.now(), projects }));
  } catch {
    // 配额满不致命：种子只是冷启动加速
  }
}

export function useShuttleData(enabled: boolean): {
  projects: ProjectRow[];
  federatedPeers: ReturnType<typeof useFederatedPeerBuckets>;
} {
  const projectsQuery = useQuery({ ...PROJECTS_QUERY, enabled });
  // 种子先行：查询没回来时先用 sessionStorage 里的旧账（可能为空数组 = 没种子）
  const projects = projectsQuery.data ?? readSeed();
  if (projectsQuery.data) writeSeed(projectsQuery.data);
  const federatedPeers = useFederatedPeerBuckets(enabled);
  return { projects, federatedPeers };
}
