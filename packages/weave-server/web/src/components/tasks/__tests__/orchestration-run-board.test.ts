import { describe, expect, it } from 'vitest';
import type { OrchestrationRunRow } from '@/lib/api';
import {
  RUN_BOARD_COLUMNS,
  buildRunTimeline,
  groupRunsByStatus,
} from '../orchestration-run-board';

const run = (over: Partial<OrchestrationRunRow> & { id: number }): OrchestrationRunRow => ({
  orchestrationId: 1,
  orchestrationName: 'demo',
  projectId: 1,
  trigger: 'manual',
  status: 'running',
  deliveries: 0,
  error: null,
  createdAt: '2026-11-07T10:00:00Z',
  finishedAt: null,
  updatedAt: '2026-11-07T10:00:00Z',
  pendingCounts: {},
  ...over,
});

describe('groupRunsByStatus', () => {
  it('按 run 状态词表分五列，空状态也出列（列头恒可见）', () => {
    const cols = groupRunsByStatus([]);
    expect(cols.map((c) => c.status)).toEqual(RUN_BOARD_COLUMNS);
    expect(cols.every((c) => c.runs.length === 0)).toBe(true);
  });

  it('分列正确：running 进运行中列，done/failed 各归其列', () => {
    const cols = groupRunsByStatus([
      run({ id: 1, status: 'running' }),
      run({ id: 2, status: 'done' }),
      run({ id: 3, status: 'failed' }),
      run({ id: 4, status: 'done' }),
    ]);
    const byStatus = new Map(cols.map((c) => [c.status, c.runs.map((r) => r.id)]));
    expect(byStatus.get('running')).toEqual([1]);
    expect(byStatus.get('done')).toEqual([2, 4]);
    expect(byStatus.get('failed')).toEqual([3]);
    expect(byStatus.get('cancelled')).toEqual([]);
    expect(byStatus.get('interrupted')).toEqual([]);
  });

  it('列内按开始时间倒序（新在前）', () => {
    const cols = groupRunsByStatus([
      run({ id: 1, status: 'done', createdAt: '2026-11-07T10:00:00Z' }),
      run({ id: 2, status: 'done', createdAt: '2026-11-07T11:00:00Z' }),
      run({ id: 3, status: 'done', createdAt: '2026-11-07T09:00:00Z' }),
    ]);
    expect(cols[1].runs.map((r) => r.id)).toEqual([2, 1, 3]);
  });
});

describe('buildRunTimeline', () => {
  it('起止 + RunEvent 按时刻归并成时间线', () => {
    const row = run({
      id: 7,
      createdAt: '2026-11-07T10:00:00Z',
      finishedAt: '2026-11-07T10:05:00Z',
      state: {
        pending: {},
        events: [
          { at: '2026-11-07T10:03:00Z', from: 'a', to: 'b', edgeId: 'e1', ok: true },
          { at: '2026-11-07T10:01:00Z', from: '', to: 'a', edgeId: '', ok: true },
        ],
      },
    });
    const timeline = buildRunTimeline(row);
    expect(timeline.map((e) => e.kind)).toEqual(['start', 'event', 'event', 'finish']);
    expect(new Date(timeline[1].at).getTime()).toBeLessThan(new Date(timeline[2].at).getTime());
  });

  it('无事件无收尾 → 只剩 start 一条', () => {
    expect(buildRunTimeline(run({ id: 8 }))).toEqual([
      { at: '2026-11-07T10:00:00Z', kind: 'start' },
    ]);
  });
});
