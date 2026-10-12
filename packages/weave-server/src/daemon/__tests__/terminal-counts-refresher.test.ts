import { describe, it, expect, vi } from 'vitest';
import { DataBus, type DataFrame } from '../data-bus.js';
import { TerminalCountsRefresher } from '../terminal-counts-refresher.js';

/** 收集总线上推出去的帧。 */
function collect(bus: DataBus): DataFrame[] {
  const frames: DataFrame[] = [];
  bus.subscribe((f) => frames.push(f));
  return frames;
}

describe('DataBus', () => {
  it('hasSubscribers 随订阅/退订变化（「有没有人在看」的判据）', () => {
    const bus = new DataBus();
    expect(bus.hasSubscribers()).toBe(false);
    const unsubscribe = bus.subscribe(() => {});
    expect(bus.hasSubscribers()).toBe(true);
    unsubscribe();
    expect(bus.hasSubscribers()).toBe(false);
  });
});

describe('TerminalCountsRefresher', () => {
  it('只在值变化时推帧（相同取值不重复推）', async () => {
    const bus = new DataBus();
    const frames = collect(bus);
    let counts: Record<number, number> = { 1: 0 };
    const refresher = new TerminalCountsRefresher(async () => ({ ...counts }), bus);

    await refresher.tick();
    await refresher.tick();
    expect(frames).toHaveLength(1); // 首次推，同值第二次不推

    counts = { 1: 2 };
    await refresher.tick();
    expect(frames).toHaveLength(2);
    expect(frames[1]).toEqual({ key: 'terminalCounts', payload: { counts: { 1: 2 } } });
  });

  it('没人看时不探（shouldRun 为假直接跳过，一次子进程都不起）', async () => {
    const bus = new DataBus();
    const snapshot = vi.fn(async () => ({ 1: 1 }));
    let watching = false;
    const refresher = new TerminalCountsRefresher(snapshot, bus, { shouldRun: () => watching });

    await refresher.tick();
    expect(snapshot).not.toHaveBeenCalled();

    watching = true;
    await refresher.tick();
    expect(snapshot).toHaveBeenCalledTimes(1);
  });

  it('refreshNow 无视「没人看」，但仍只在值变化时推', async () => {
    const bus = new DataBus();
    const frames = collect(bus);
    const refresher = new TerminalCountsRefresher(async () => ({ 1: 1 }), bus, {
      shouldRun: () => false,
    });

    await refresher.refreshNow();
    expect(frames).toHaveLength(1); // 用户动作 → 立刻对账
    await refresher.refreshNow();
    expect(frames).toHaveLength(1); // 值没变 → 不重复推
  });

  it('探测失败不推不抛，下一个周期照常恢复', async () => {
    const bus = new DataBus();
    const frames = collect(bus);
    let broken = true;
    const refresher = new TerminalCountsRefresher(async () => {
      if (broken) throw new Error('wezterm cli 挂死');
      return { 1: 3 };
    }, bus);

    await expect(refresher.tick()).resolves.toBeUndefined();
    expect(frames).toHaveLength(0); // 失败不推、角标保留旧值

    broken = false;
    await refresher.tick();
    expect(frames).toHaveLength(1);
  });

  it('防重入：上一次扫描未完成时跳过本次（探测要 spawn 子进程）', async () => {
    const bus = new DataBus();
    const frames = collect(bus);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const snapshot = vi.fn(async () => {
      await gate;
      return { 1: 1 };
    });
    const refresher = new TerminalCountsRefresher(snapshot, bus);

    const first = refresher.tick();
    const second = refresher.tick(); // 应被跳过
    release();
    await Promise.all([first, second]);

    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(frames).toHaveLength(1);
  });
});
