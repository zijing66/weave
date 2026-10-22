import { describe, expect, it, vi } from 'vitest';
import { DashboardRateCache } from '../../hooks/dashboard-rate.js';
import { startDashboardPusher } from '../dashboard-pusher.js';

/** 仪表盘推送：连接时分块补历史；此后只在有事件时推增量（1 秒合并）。 */

type Frame = { kind: string; series?: unknown; totals?: unknown };

function harness() {
  const rate = new DashboardRateCache();
  const frames: Frame[] = [];
  const handlers: Array<(m: { kind: string }) => void> = [];
  const deps = {
    rate,
    events: {
      countAll: () => 100,
      countSince: () => 7,
      seriesBySecond: () => [{ at: '2026-10-22T05:00:00', n: 3 }],
    },
    sessions: { countAll: () => 44 },
    projects: { list: () => [{ id: 1 }, { id: 2 }] },
    bus: {
      emit: (m: Frame) => frames.push(m),
      subscribe: (fn: (m: { kind: string }) => void) => {
        handlers.push(fn);
        return () => {};
      },
    },
  };
  return { rate, frames, handlers, deps };
}

describe('startDashboardPusher', () => {
  it('attach 先推总量，再按块推一小时历史（6 × 60 格）', async () => {
    const { frames, deps } = harness();
    const pusher = startDashboardPusher(deps as never);
    try {
      pusher.attach();
      await Promise.resolve(); // attach 的帧在微任务里发（总线订阅刚建好）
      expect(frames[0]).toMatchObject({ kind: 'dashboard.totals' });
      const series = frames.filter((f) => f.kind === 'dashboard.series');
      expect(series).toHaveLength(6);
      for (const f of series) expect((f.series as unknown[]).length).toBe(60);
    } finally {
      pusher.stop();
    }
  });

  it('有 event.ingested 才推增量；没有事件不发帧', () => {
    vi.useFakeTimers();
    try {
      const { rate, frames, handlers, deps } = harness();
      const pusher = startDashboardPusher(deps as never);
      try {
        handlers[0]!({ kind: 'event.ingested' });
        rate.record();
        vi.advanceTimersByTime(1_000);
        const deltas = frames.filter((f) => f.kind === 'dashboard.delta');
        expect(deltas).toHaveLength(1);
        expect(deltas[0]!.totals).toMatchObject({ events: 1, sessions: 44, projects: 2 });

        // 再过两拍都没有新事件：不发帧
        vi.advanceTimersByTime(2_000);
        expect(frames.filter((f) => f.kind === 'dashboard.delta')).toHaveLength(1);
      } finally {
        pusher.stop();
      }
    } finally {
      vi.useRealTimers();
    }
  });
});
