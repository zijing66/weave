import { useSyncExternalStore } from 'react';
import { subscribeHook } from '@/lib/sse';

/**
 * 资源快照（§13.3）的唯一前端入口：daemon / Runtime Host / 各 Agent 实例的
 * CPU、内存、吞吐全来自同一条 SSE `metrics.snapshot` 帧——全局仪表盘、项目卡、
 * 会话卡各自切视图，数据源只有一个，不存在第二份接口各说各话。
 */

export interface MetricsAgentSample {
  instanceId: string;
  projectId: number;
  harnessSessionId?: string;
  harness: string;
  cpuPercent?: number;
  memRssBytes?: number;
  outputBytesPerSec?: number;
}

export interface MetricsSnapshot {
  daemon: { cpuPercent: number; memRssBytes: number };
  host: { cpuPercent: number; memRssBytes: number } | null;
  agents: MetricsAgentSample[];
  history: Array<{ at: string; daemonCpuPercent: number; hostCpuPercent?: number }>;
}

let latest: MetricsSnapshot | null = null;
const listeners = new Set<() => void>();
let wired = false;

function ensureWired(): void {
  if (wired) return;
  wired = true;
  subscribeHook((frame) => {
    if (frame.kind !== 'metrics.snapshot') return;
    latest = (frame as unknown as { snapshot: MetricsSnapshot }).snapshot;
    for (const l of listeners) l();
  }, ['metrics.']);
}

export function useMetrics(): MetricsSnapshot | null {
  ensureWired();
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => latest,
  );
}
