import type {
  OrchestrationRunEvent,
  OrchestrationRunRow,
  OrchestrationRunStatus,
} from '@/lib/api';
import { RUN_STATUS_KEY } from './orchestration-canvas-nodes';
import type { MessageKey } from '@/i18n/dict';

/**
 * 任务状态机看板（run 状态机的镜子，只读）：列 = run 状态词表的固定序，
 * 分列是纯派生（数据零新增——runs 表 + RunEvent 全够），不做任何 run CRUD。
 */

/** 看板列序：先活动态再终态（终态内部按词表序）。 */
export const RUN_BOARD_COLUMNS: readonly OrchestrationRunStatus[] = [
  'running',
  'done',
  'failed',
  'cancelled',
  'interrupted',
];

export interface RunBoardColumn {
  status: OrchestrationRunStatus;
  labelKey: MessageKey;
  runs: OrchestrationRunRow[];
}

/** 按状态分列：每列内按开始时间倒序（新在前）；空状态也出列（列头恒可见）。 */
export const groupRunsByStatus = (runs: readonly OrchestrationRunRow[]): RunBoardColumn[] => {
  const buckets = new Map<OrchestrationRunStatus, OrchestrationRunRow[]>();
  for (const status of RUN_BOARD_COLUMNS) buckets.set(status, []);
  for (const run of runs) {
    buckets.get(run.status)?.push(run);
  }
  return RUN_BOARD_COLUMNS.map((status) => ({
    status,
    labelKey: RUN_STATUS_KEY[status],
    runs: (buckets.get(status) ?? []).sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    ),
  }));
};

/** 看板卡上的流转历史条目：run 自身的起止 + RunEvent 时间线按时刻归并。 */
export interface RunTimelineEntry {
  at: string;
  kind: 'start' | 'finish' | 'event';
  event?: OrchestrationRunEvent;
}

export const buildRunTimeline = (run: OrchestrationRunRow): RunTimelineEntry[] => {
  const entries: RunTimelineEntry[] = [{ at: run.createdAt, kind: 'start' }];
  for (const event of run.state?.events ?? []) entries.push({ at: event.at, kind: 'event', event });
  if (run.finishedAt) entries.push({ at: run.finishedAt, kind: 'finish' });
  return entries.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
};
