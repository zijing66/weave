/**
 * Agent Instance 对账（B0 纯函数）：daemon 重连 Runtime Host 后，把 Host 自报的
 * 活实例清单与库里的 `agent_instances` 行对齐。设计依据 =
 * docs/plan/agent-runtime-terminal-gateway.md（PoC 定案：Host 死 = 子进程死，
 * 故「Host 不再报告的活行」判 failed 而不是 recovering——不盲目重启）。
 */
import type { AgentInstanceRecord, AgentInstanceStatus } from './protocol.js';

/** Host 自报的单个活实例摘要（daemon 侧只关心这三样刷新事实）。 */
export interface HostInstanceSummary {
  id: string;
  osPid?: number;
  harnessSessionId?: string;
}

export interface ReconcilePlan {
  /** Host 还在报的行：刷新 pid / harness 会话 id（任一变化才进清单）。 */
  refresh: Array<{ id: string; osPid?: number; harnessSessionId?: string }>;
  /** 库里是活态、Host 不再报的行：判 failed（进程必死，见 PoC）。 */
  lost: Array<{ id: string; errorMessage: string }>;
  /** Host 报了、库里没有的行（daemon 换库 / Host 先于落库启动）：待登记。 */
  unknown: HostInstanceSummary[];
}

/** 终态：exited / failed 之后永不再动（重连对账跳过它们）。 */
export function isTerminalStatus(status: AgentInstanceStatus): boolean {
  return status === 'exited' || status === 'failed';
}

export function reconcileInstances(
  known: AgentInstanceRecord[],
  live: HostInstanceSummary[],
): ReconcilePlan {
  const byId = new Map(live.map((s) => [s.id, s]));
  const plan: ReconcilePlan = { refresh: [], lost: [], unknown: [] };
  const seen = new Set<string>();
  for (const row of known) {
    const sum = byId.get(row.id);
    if (!sum) {
      if (!isTerminalStatus(row.status)) {
        plan.lost.push({ id: row.id, errorMessage: 'runtime host no longer reports this instance' });
      }
      continue;
    }
    seen.add(row.id);
    if (sum.osPid !== row.osPid || sum.harnessSessionId !== row.harnessSessionId) {
      plan.refresh.push({
        id: row.id,
        osPid: sum.osPid,
        harnessSessionId: sum.harnessSessionId,
      });
    }
  }
  for (const sum of live) {
    if (!seen.has(sum.id)) plan.unknown.push(sum);
  }
  return plan;
}
