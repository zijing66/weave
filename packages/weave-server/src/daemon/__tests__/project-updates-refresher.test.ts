import { describe, it, expect, vi } from 'vitest';
import { DataBus, type DataFrame } from '../data-bus.js';
import { HookEventBus } from '../../hooks/bus.js';
import { ProjectUpdatesRefresher } from '../project-updates-refresher.js';

/** 收集总线上推出去的帧。 */
function collect(bus: DataBus): DataFrame[] {
  const frames: DataFrame[] = [];
  bus.subscribe((f) => frames.push(f));
  return frames;
}

/** 一条插件重载帧（项目插件根变更时 loader 广播的那种）。 */
function reloaded(bus: HookEventBus): void {
  bus.emit({
    kind: 'plugin.reloaded',
    pluginId: 'ai-prompt-auditor',
    status: 'active',
    ruleCount: 1,
    at: new Date().toISOString(),
  });
}

describe('ProjectUpdatesRefresher', () => {
  it('只在值变化时推帧（绝对值快照含 0）', async () => {
    const bus = new DataBus();
    const frames = collect(bus);
    let counts: Record<number, number> = { 1: 0, 2: 1 };
    const refresher = new ProjectUpdatesRefresher(
      async () => ({ ...counts }),
      bus,
      new HookEventBus(),
    );

    await refresher.refreshNow();
    await refresher.refreshNow();
    expect(frames).toHaveLength(1); // 首次推，同值第二次不推

    counts = { 1: 0, 2: 0 };
    await refresher.refreshNow();
    expect(frames).toHaveLength(2);
    expect(frames[1]).toEqual({ key: 'updates', payload: { counts: { 1: 0, 2: 0 } } });
  });

  it('没人看时不重算；refreshNow(true)（同步落地）穿透', async () => {
    const bus = new DataBus();
    const snapshot = vi.fn(async () => ({ 1: 1 }));
    const refresher = new ProjectUpdatesRefresher(snapshot, bus, new HookEventBus(), () => false);

    await refresher.refreshNow();
    expect(snapshot).not.toHaveBeenCalled();

    await refresher.refreshNow(true);
    expect(snapshot).toHaveBeenCalledTimes(1);
  });

  it('plugin.reloaded 帧驱动重算（项目插件源变更 → 角标）', async () => {
    const bus = new DataBus();
    const hookBus = new HookEventBus();
    const frames = collect(bus);
    const snapshot = vi.fn(async () => ({ 1: 2 }));
    new ProjectUpdatesRefresher(snapshot, bus, hookBus);

    expect(snapshot).not.toHaveBeenCalled();
    reloaded(hookBus);
    await vi.waitFor(() => expect(frames).toHaveLength(1));
    expect(frames[0]).toEqual({ key: 'updates', payload: { counts: { 1: 2 } } });
    expect(snapshot).toHaveBeenCalledTimes(1);
  });

  it('新客户端接入：先补上次快照帧（值没变也补），再后台对账推差量', async () => {
    const bus = new DataBus();
    const frames = collect(bus);
    let counts: Record<number, number> = { 1: 0 };
    const refresher = new ProjectUpdatesRefresher(
      async () => ({ ...counts }),
      bus,
      new HookEventBus(),
    );

    refresher.onSubscriberJoin(); // 还没算过：不补帧，只触发首算
    await vi.waitFor(() => expect(frames).toHaveLength(1));
    expect(frames[0]).toEqual({ key: 'updates', payload: { counts: { 1: 0 } } });

    counts = { 1: 2 };
    refresher.onSubscriberJoin(); // 已有快照：无条件补帧（旧值）+ 后台对账推差量
    await vi.waitFor(() => expect(frames).toHaveLength(3));
    expect(frames[1]).toEqual({ key: 'updates', payload: { counts: { 1: 0 } } });
    expect(frames[2]).toEqual({ key: 'updates', payload: { counts: { 1: 2 } } });
  });

  it('扫描失败不推不抛，触发源下一次照常恢复', async () => {
    const bus = new DataBus();
    const hookBus = new HookEventBus();
    const frames = collect(bus);
    let broken = false;
    const snapshot = vi.fn(async () => {
      if (broken) throw new Error('读盘失败');
      return { 1: 3 };
    });
    new ProjectUpdatesRefresher(snapshot, bus, hookBus);

    reloaded(hookBus);
    await vi.waitFor(() => expect(frames).toHaveLength(1));

    broken = true;
    reloaded(hookBus);
    await vi.waitFor(() => expect(snapshot).toHaveBeenCalledTimes(2));
    expect(frames).toHaveLength(1); // 失败不推，角标保持旧值
  });

  it('防重入：上一次重算未完成时跳过本次', async () => {
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
    const refresher = new ProjectUpdatesRefresher(snapshot, bus, new HookEventBus());

    const first = refresher.refreshNow(true);
    const second = refresher.refreshNow(true); // 应被跳过
    release();
    await Promise.all([first, second]);

    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(frames).toHaveLength(1);
  });
});
