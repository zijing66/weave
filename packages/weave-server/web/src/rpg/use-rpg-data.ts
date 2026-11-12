import { useEffect, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type OrchestrationRunRow, type RpgGoalView, type RpgRoutingDecisionView, type RpgRoutingStatsView } from '@/lib/api';
import { subscribeHook } from '@/lib/sse';
import { useSessionStatus } from '@/components/tasks/session-status-store';

/**
 * RPG 视图数据域（观察态全派生，零新表）：角色清单 + 全量编排 + 全量 runs +
 * 会话状态总线 + 决策路由账（G6 信箱：级2 待批 + 轨迹）。SSE 单通道（kind
 * 'orchestration.'）只做失效信号，刷新走 TanStack Query——不新增轮询、不第二条
 * EventSource（§9 铁律）。
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

  // 决策路由账（G6）：级2 待批点亮顶部警报带（red）；裁决动作直接 invalidate。
  const routing = useQuery({
    queryKey: ['rpg-routing'],
    queryFn: () => api.listRoutingDecisions(),
    staleTime: 15_000,
  });

  // goal 域（G6 批4c 任务沙盘）：全局面板数据源；active 计数 = 面板入口角标。
  const goals = useQuery({
    queryKey: ['rpg-goals'],
    queryFn: () => api.listGoals(),
    staleTime: 15_000,
  });

  // 进化闭环策略档（G6 批5）：信箱底的「策略档」面板数据源（当前参数 + 版本链）。
  const profile = useQuery({
    queryKey: ['rpg-profile'],
    queryFn: () => api.getRoutingProfile(),
    staleTime: 30_000,
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
    goals: (goals.data?.goals ?? null) as RpgGoalView[] | null,
    profile: profile.data ?? null,
    routingDecisions: (routing.data?.decisions ?? null) as RpgRoutingDecisionView[] | null,
    routingPending: routing.data?.pending ?? 0,
    routingStats: (routing.data?.stats ?? null) as RpgRoutingStatsView | null,
    statuses: statusBus.statuses,
    questions: statusBus.questions,
    sessions: statusBus.sessions,
    sessionById,
  };
}

/** 便利类型（组件用）。 */
export type RpgData = ReturnType<typeof useRpgData>;
