import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MetricsSampler, type MetricsSnapshot } from '../metrics-sampler.js';
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
