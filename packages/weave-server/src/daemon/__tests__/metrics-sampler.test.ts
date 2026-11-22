import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MetricsSampler, type MetricsSnapshot, type ProcessTreeReading } from '../metrics-sampler.js';
import type { ResourceReportPayload } from '../../runtime/protocol.js';
import type { HookBusMessage } from '../../hooks/bus.js';

/** supervisor 桩：记录订阅者，测试里手动喂 Host 帧。 */
function stubSupervisor() {
  const handlers: Array<(f: { type: string; payload?: unknown }) => void> = [];
  return {
    onEvent: (cb: (f: { type: string; payload?: unknown }) => void) => {
      handlers.push(cb);
      return () => {};
    },
    emit: (frame: { type: string; payload?: unknown }) => {
      for (const h of handlers) h(frame);
    },
  };
}

function report(over: Partial<ResourceReportPayload> = {}): ResourceReportPayload {
  return {
    hostId: 'h1',
    hostCpuPercent: 3.2,
    hostMemRssBytes: 64 * 1024 * 1024,
    instances: [],
    at: Date.now(),
    ...over,
  };
}

describe('MetricsSampler', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('daemon 自身采样进快照、帧走 metrics.snapshot', () => {
    const sup = stubSupervisor();
    const frames: HookBusMessage[] = [];
    const sampler = new MetricsSampler({
      bus: { emit: (m) => frames.push(m) },
      supervisor: sup,
      instances: { listHeadless: () => [] },
    });
    sampler.start();
    const snap = frames.find((f) => f.kind === 'metrics.snapshot') as {
      snapshot: MetricsSnapshot;
    };
    expect(snap).toBeDefined();
    expect(snap.snapshot.daemon.cpuPercent).toBeGreaterThanOrEqual(0);
    expect(snap.snapshot.daemon.memRssBytes).toBeGreaterThan(0);
    expect(snap.snapshot.host).toBeNull(); // 还没有 Host 自报
    expect(snap.snapshot.agents).toEqual([]);
    sampler.stop();
  });

  it('Host resource.updated 帧 → 快照；过期窗后回 null', () => {
    const sup = stubSupervisor();
    const sampler = new MetricsSampler({
      bus: { emit: () => {} },
      supervisor: sup,
      instances: { listHeadless: () => [] },
    });
    sampler.start();
    sup.emit({ type: 'resource.updated', payload: report() });
    expect(sampler.snapshot().host).toMatchObject({ cpuPercent: 3.2 });
    vi.advanceTimersByTime(31_000); // 过 HOST_STALE_MS
    expect(sampler.snapshot().host).toBeNull();
    sampler.stop();
  });

  it('Host 实例吞吐差分进 Agent 行；shouldSampleAgents=false 不打枪（CPU/Mem 缺席）', () => {
    const sup = stubSupervisor();
    let agentsShouldRun = false;
    const sampler = new MetricsSampler({
      bus: { emit: () => {} },
      supervisor: sup,
      instances: {
        listHeadless: () => [
          {
            id: 'wvt-1',
            projectId: 1,
            harness: 'claude',
            status: 'running',
            executionMode: 'headless',
            workingDirectory: '/x',
            command: 'claude',
            osPid: 1234,
            harnessSessionId: 'sess-1',
            createdAt: new Date().toISOString(),
          },
        ],
      },
      shouldSampleAgents: () => agentsShouldRun,
    });
    sampler.start();
    sup.emit({
      type: 'resource.updated',
      payload: report({ instances: [{ instanceId: 'wvt-1', osPid: 1234, outputBytes: 1000 }] }),
    });
    vi.advanceTimersByTime(60_000);
    sup.emit({
      type: 'resource.updated',
      payload: report({ instances: [{ instanceId: 'wvt-1', osPid: 1234, outputBytes: 4000 }] }),
    });
    vi.advanceTimersByTime(60_000); // 下一拍才差分出速率
    const agent = sampler.snapshot().agents.find((a) => a.instanceId === 'wvt-1');
    expect(agent).toBeDefined();
    expect(agent!.outputBytesPerSec).toBe(50); // (4000-1000)/60s
    expect(agent!.cpuPercent).toBeUndefined(); // 没人看 → 不采 Agent 进程
    expect(agent!.harnessSessionId).toBe('sess-1');
    sampler.stop();
  });

  it('PTY 包装壳归因到子树里真正的 TUI 宿主；首拍 RSS 即时报，CPU 等差分', async () => {
    const sup = stubSupervisor();
    const rows = [
      // 实例 1：PTY 根 = cmd.exe 包装壳，真宿主是子进程 claude.exe
      { id: 'wvt-1', osPid: 100, harnessSessionId: 'sess-1' },
      // 实例 2：PTY 根自己就是宿主（无包装壳）
      { id: 'wvt-2', osPid: 300, harnessSessionId: 'sess-2' },
    ].map((r) => ({
      projectId: 1,
      harness: 'claude',
      status: 'running',
      executionMode: 'headless',
      workingDirectory: '/x',
      command: 'claude',
      createdAt: new Date().toISOString(),
      ...r,
    }));
    let claudeCpu = 40;
    const tree = (): Promise<Map<number, ProcessTreeReading>> =>
      Promise.resolve(
        new Map<number, ProcessTreeReading>(
          [
            { pid: 100, parentPid: 90, processKey: '100', cpuSeconds: 1, memRssBytes: 4.6 * 1024 * 1024, wrapper: true }, // cmd.exe
            { pid: 200, parentPid: 100, processKey: '200', cpuSeconds: claudeCpu, memRssBytes: 320 * 1024 * 1024 }, // claude.exe
            { pid: 300, parentPid: 90, processKey: '300', cpuSeconds: 12, memRssBytes: 210 * 1024 * 1024 },
          ].map((p) => [p.pid, p]),
        ),
      );
    const sampler = new MetricsSampler({
      bus: { emit: () => {} },
      supervisor: sup,
      instances: { listHeadless: () => rows },
      processTree: tree,
    });
    sampler.start();
    await vi.advanceTimersByTimeAsync(60_000);
    let snap = sampler.snapshot();
    const a1 = snap.agents.find((a) => a.instanceId === 'wvt-1')!;
    const a2 = snap.agents.find((a) => a.instanceId === 'wvt-2')!;
    expect(a1.memRssBytes).toBe(320 * 1024 * 1024); // 不是壳的 4.6MiB
    expect(a2.memRssBytes).toBe(210 * 1024 * 1024);
    expect(a1.cpuPercent).toBeUndefined(); // 首拍无差分基线
    claudeCpu = 100;
    await vi.advanceTimersByTimeAsync(60_000);
    snap = sampler.snapshot();
    const a1b = snap.agents.find((a) => a.instanceId === 'wvt-1')!;
    expect(a1b.cpuPercent).toBeCloseTo(100, 0); // (100-40)/60s * 100
    sampler.stop();
  });

  it('同 pid 换进程（重启/复用）或累计倒退 → CPU 缺席重建基线，绝不为负', async () => {
    const sup = stubSupervisor();
    const rows = [
      { id: 'wvt-1', osPid: 300, harnessSessionId: 'sess-1' },
    ].map((r) => ({
      projectId: 1,
      harness: 'claude',
      status: 'running',
      executionMode: 'headless',
      workingDirectory: '/x',
      command: 'claude',
      createdAt: new Date().toISOString(),
      ...r,
    }));
    // 三拍：正常差分 → 累计倒退 → PID 复用成新进程（processKey 变）
    let cpuSeconds = 50;
    let processKey = 'A';
    const tree = (): Promise<Map<number, ProcessTreeReading>> =>
      Promise.resolve(
        new Map<number, ProcessTreeReading>(
          [
            { pid: 300, parentPid: 90, processKey, cpuSeconds, memRssBytes: 100 },
          ].map((p) => [p.pid, p]),
        ),
      );
    const sampler = new MetricsSampler({
      bus: { emit: () => {} },
      supervisor: sup,
      instances: { listHeadless: () => rows },
      processTree: tree,
    });
    sampler.start();
    await vi.advanceTimersByTimeAsync(60_000); // 首拍落基线（cpuSeconds=50）
    cpuSeconds = 110; // 正常差分：60s 内 60s CPU = 100%
    await vi.advanceTimersByTimeAsync(60_000);
    let agent = sampler.snapshot().agents.find((a) => a.instanceId === 'wvt-1')!;
    expect(agent.cpuPercent).toBeCloseTo(100, 0);
    cpuSeconds = 90; // 累计倒退（进程换了）：缺席而非负数
    await vi.advanceTimersByTimeAsync(60_000);
    agent = sampler.snapshot().agents.find((a) => a.instanceId === 'wvt-1')!;
    expect(agent.cpuPercent).toBeUndefined();
    cpuSeconds = 150;
    processKey = 'B'; // PID 被新进程复用：缺席，本拍只重建基线
    await vi.advanceTimersByTimeAsync(60_000);
    agent = sampler.snapshot().agents.find((a) => a.instanceId === 'wvt-1')!;
    expect(agent.cpuPercent).toBeUndefined();
    cpuSeconds = 210; // 新进程生命周期内差分恢复
    await vi.advanceTimersByTimeAsync(60_000);
    agent = sampler.snapshot().agents.find((a) => a.instanceId === 'wvt-1')!;
    expect(agent.cpuPercent).toBeCloseTo(100, 0);
    sampler.stop();
  });

  it('历史环形：1 分钟一格、上限 60、首连 attach 一帧全量', () => {
    const sup = stubSupervisor();
    const frames: HookBusMessage[] = [];
    const sampler = new MetricsSampler({
      bus: { emit: (m) => frames.push(m) },
      supervisor: sup,
      instances: { listHeadless: () => [] },
    });
    sampler.start();
    frames.length = 0;
    for (let i = 0; i < 80; i++) {
      vi.advanceTimersByTime(60_000);
      vi.advanceTimersByTime(10_000); // sampleDaemon 也拍（history 由它落点）
    }
    sampler.attach();
    const last = frames[frames.length - 1] as { snapshot: MetricsSnapshot };
    expect(last.snapshot.history.length).toBe(60);
    expect(last.snapshot.history[0].daemonCpuPercent).toBeGreaterThanOrEqual(0);
    sampler.stop();
  });
});
