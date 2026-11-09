import { useEffect, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type OrchestrationRunRow } from '@/lib/api';
import { subscribeHook } from '@/lib/sse';
import { useSessionStatus } from '@/components/tasks/session-status-store';

/**
 * RPG 视图数据域（观察态全派生，零新表）：角色清单 + 全量编排 + 全量 runs +
 * 会话状态总线。SSE 单通道（kind 'orchestration.'）只做失效信号，刷新走
 * TanStack Query——不新增轮询、不第二条 EventSource（§9 铁律）。
 */

export function useRpgData() {
  const qc = useQueryClient();
  const statusBus = useSessionStatus();

  const roles = useQuery({
    queryKey: ['rpg-roles'],
    queryFn: () => api.listRoles(),
    staleTime: 30_000,
  });

  const orchestrations = useQuery({
    queryKey: ['rpg-orchestrations'],
    queryFn: () => api.listOrchestrations(),
    staleTime: 30_000,
  });

  const runs = useQuery({
    queryKey: ['rpg-runs'],
    queryFn: () => api.listOrchestrationRuns({ limit: 50 }),
    staleTime: 15_000,
  });

  // 编排帧 → 失效（runs 与 flash 由既有 SSE 帧域推；这里只拉清单层面的新鲜账）
  useEffect(() => {
    return subscribeHook(() => {
      void qc.invalidateQueries({ queryKey: ['rpg-runs'] });
    }, ['orchestration.']);
  }, [qc]);

  const sessionById = useMemo(() => {
    const map = new Map<string, NonNullable<typeof statusBus.sessions>[number]>();
    for (const s of statusBus.sessions ?? []) map.set(s.sessionId, s);
    return map;
  }, [statusBus.sessions]);

  return {
    roles: roles.data?.roles ?? null,
    orchestrations: orchestrations.data ?? null,
    runs: (runs.data?.runs ?? null) as OrchestrationRunRow[] | null,
    statuses: statusBus.statuses,
    questions: statusBus.questions,
    sessionById,
  };
}

/** 便利类型（组件用）。 */
export type RpgData = ReturnType<typeof useRpgData>;
