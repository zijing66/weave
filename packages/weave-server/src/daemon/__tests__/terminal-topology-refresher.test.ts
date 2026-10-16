import { describe, it, expect, vi } from 'vitest';
import { DataBus, type DataFrame } from '../data-bus.js';
import { TerminalTopologyRefresher, type TerminalTopology } from '../terminal-topology-refresher.js';

/** 只关心计数的那批用例：终端世界其余字段留空。 */
const topo = (counts: Record<number, number>): TerminalTopology => ({ counts, terminals: {} });

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

describe('TerminalTopologyRefresher', () => {
  it('只在值变化时推帧（相同取值不重复推）', async () => {
    const bus = new DataBus();
    const frames = collect(bus);
    let counts: Record<number, number> = { 1: 0 };
    const refresher = new TerminalTopologyRefresher(async () => topo({ ...counts }), bus);

    await refresher.tick();
    await refresher.tick();
    expect(frames).toHaveLength(1); // 首次推，同值第二次不推

    counts = { 1: 2 };
    await refresher.tick();
    expect(frames).toHaveLength(2);
    expect(frames[1]).toEqual({ key: 'terminalTopology', payload: topo({ 1: 2 }) });
  });

  it('会话所在屏幕变化同样触发推帧（分块面与计数面同一条快照）', async () => {
    const bus = new DataBus();
    const frames = collect(bus);
    const screen = { id: 'abcd1234:0:1', windowId: 0, tabId: 1, tabsInWindow: 2 };
    let terminals: TerminalTopology['terminals'] = { s1: screen };
    const refresher = new TerminalTopologyRefresher(
      async () => ({ counts: { 1: 1 }, terminals }),
      bus,
    );

    await refresher.tick();
    await refresher.tick();
    expect(frames).toHaveLength(1); // 会话没动 → 不推

    terminals = { s1: null };
    await refresher.tick();
    expect(frames).toHaveLength(2);
    expect(frames[1]).toEqual({ key: 'terminalTopology', payload: { counts: { 1: 1 }, terminals } });
  });

  it('没人看时不探（shouldRun 为假直接跳过，一次子进程都不起）', async () => {
    const bus = new DataBus();
    const snapshot = vi.fn(async () => topo({ 1: 1 }));
    let watching = false;
    const refresher = new TerminalTopologyRefresher(snapshot, bus, { shouldRun: () => watching });

    await refresher.tick();
    expect(snapshot).not.toHaveBeenCalled();

    watching = true;
    await refresher.tick();
    expect(snapshot).toHaveBeenCalledTimes(1);
  });

  it('refreshNow 无视「没人看」，但仍只在值变化时推', async () => {
    const bus = new DataBus();
    const frames = collect(bus);
    const refresher = new TerminalTopologyRefresher(async () => topo({ 1: 1 }), bus, {
      shouldRun: () => false,
    });

    await refresher.refreshNow();
    expect(frames).toHaveLength(1); // 用户动作 → 立刻对账
    await refresher.refreshNow();
    expect(frames).toHaveLength(1); // 值没变 → 不重复推
  });

  it('探测失败不推不抛，下一个周期照常恢复；lastSnapshot 保留旧值', async () => {
    const bus = new DataBus();
    const frames = collect(bus);
    let broken = false;
    const refresher = new TerminalTopologyRefresher(async () => {
      if (broken) throw new Error('wezterm cli 挂死');
      return topo({ 1: 3 });
    }, bus);

    await refresher.tick();
    expect(frames).toHaveLength(1);
    expect(refresher.lastSnapshot).toEqual(topo({ 1: 3 }));

    broken = true;
    await refresher.tick();
    expect(frames).toHaveLength(1); // 失败不推、角标保留旧值
    expect(refresher.lastSnapshot).toEqual(topo({ 1: 3 })); // 快照也不回退
  });

  it('新客户端接入：先补上次快照帧，再后台对账推差量；还没探过则不补', async () => {
    const bus = new DataBus();
    const frames = collect(bus);
    let counts: Record<number, number> = { 1: 0 };
    const refresher = new TerminalTopologyRefresher(async () => topo({ ...counts }), bus);

    refresher.onSubscriberJoin(); // 还没探过：不补帧、只触发首探
    await vi.waitFor(() => expect(frames).toHaveLength(1));
    expect(frames[0]).toEqual({ key: 'terminalTopology', payload: topo({ 1: 0 }) });

    counts = { 1: 4 };
    refresher.onSubscriberJoin(); // 已有快照：同值补帧 + 后台对账推差量
    await vi.waitFor(() => expect(frames).toHaveLength(3));
    expect(frames[1]).toEqual({ key: 'terminalTopology', payload: topo({ 1: 0 }) });
    expect(frames[2]).toEqual({ key: 'terminalTopology', payload: topo({ 1: 4 }) });
  });

  it('启动饱和窗口内 tick 跳过探测，refreshNow（用户动作）穿透', async () => {
    const bus = new DataBus();
    const snapshot = vi.fn(async () => topo({ 1: 1 }));
    const refresher = new TerminalTopologyRefresher(snapshot, bus, { graceMs: 60_000 });
    refresher.start();

    await refresher.tick();
    expect(snapshot).not.toHaveBeenCalled(); // 窗口内不探（陈旧值路径）

    await refresher.refreshNow();
    expect(snapshot).toHaveBeenCalledTimes(1); // 用户动作不受限

    refresher.stop();
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
      return topo({ 1: 1 });
    });
    const refresher = new TerminalTopologyRefresher(snapshot, bus);

    const first = refresher.tick();
    const second = refresher.tick(); // 应被跳过
    release();
    await Promise.all([first, second]);

    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(frames).toHaveLength(1);
  });
});
