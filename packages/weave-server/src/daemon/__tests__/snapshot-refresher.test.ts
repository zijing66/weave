import { describe, it, expect, vi } from 'vitest';
import { DataBus, type DataFrame } from '../data-bus.js';
import { SnapshotRefresher } from '../snapshot-refresher.js';

/** 收集总线上推出去的帧。 */
function collect(bus: DataBus): DataFrame[] {
  const frames: DataFrame[] = [];
  bus.subscribe((f) => frames.push(f));
  return frames;
}

describe('SnapshotRefresher', () => {
  it('只在值变化时推帧（相同快照不重复推）', () => {
    const bus = new DataBus();
    const frames = collect(bus);
    let alive: Record<string, boolean> = { s1: true };
    const refresher = new SnapshotRefresher(() => ({ alive }), bus, { key: 'sessionLiveness' });

    refresher.tick();
    refresher.tick();
    expect(frames).toHaveLength(1); // 首推后同值不再推

    alive = { s1: true, s2: false }; // 新会话进来 + s1 仍活
    refresher.tick();
    expect(frames).toHaveLength(2);
    expect(frames[1]).toEqual({ key: 'sessionLiveness', payload: { alive: { s1: true, s2: false } } });

    alive = { s1: false }; // s1 死了、s2 判定不出来（null 不进快照）
    refresher.tick();
    expect(frames).toHaveLength(3);
  });

  it('没人看时不探（shouldRun 为假直接跳过，注册表都不读）', () => {
    const bus = new DataBus();
    const snapshot = vi.fn(() => ({ s1: true }));
    let watching = false;
    const refresher = new SnapshotRefresher(snapshot, bus, {
      key: 'sessionLiveness',
      shouldRun: () => watching,
    });

    refresher.tick();
    expect(snapshot).not.toHaveBeenCalled();

    watching = true;
    refresher.tick();
    expect(snapshot).toHaveBeenCalledTimes(1);
  });

  it('快照抛错不推不抛，下一个周期照常恢复', () => {
    const bus = new DataBus();
    const frames = collect(bus);
    let broken = true;
    const refresher = new SnapshotRefresher(
      () => {
        if (broken) throw new Error('注册表目录读不了');
        return { alive: { s1: true } };
      },
      bus,
      { key: 'sessionLiveness' },
    );

    expect(() => refresher.tick()).not.toThrow();
    expect(frames).toHaveLength(0); // 失败不推、图标保留旧值

    broken = false;
    refresher.tick();
    expect(frames).toHaveLength(1);
  });

  it('start 起一个定时器、stop 关停；重复 start/stop 幂等', () => {
    vi.useFakeTimers();
    try {
      const bus = new DataBus();
      const frames = collect(bus);
      let alive: Record<string, boolean> = { s1: true };
      const refresher = new SnapshotRefresher(() => ({ alive }), bus, {
        key: 'sessionLiveness',
        intervalMs: 15_000,
      });

      refresher.start();
      refresher.start(); // 不重复起
      vi.advanceTimersByTime(60_000);
      expect(frames).toHaveLength(1); // 首拍推一次，同值后续拍全静默

      alive = { s1: false };
      vi.advanceTimersByTime(15_000);
      expect(frames).toHaveLength(2);

      refresher.stop();
      refresher.stop(); // 不炸
      alive = { s1: true };
      vi.advanceTimersByTime(60_000);
      expect(frames).toHaveLength(2); // 停了就不推
    } finally {
      vi.useRealTimers();
    }
  });
});
