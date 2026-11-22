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
  /** 该进程的磁盘 IO 速率（读+写字节/秒，与 CPU 同拍差分）；缺席 = 本拍没采到。 */
  diskBytesPerSec?: number;
}

export interface SystemSample {
  cpuPercent: number;
  memTotalBytes: number;
  memUsedBytes: number;
  disks: Array<{ mount: string; totalBytes: number; usedBytes: number }>;
  /** 机器整体磁盘繁忙度 %（性能占用，非空间）；采不到缺席。 */
  diskActivePercent?: number;
}

export interface SystemHistoryPoint {
  at: string;
  cpuPercent: number;
  memUsedBytes: number;
  memTotalBytes: number;
  diskUsedBytes: number;
  diskTotalBytes: number;
}

export interface MetricsSnapshot {
  daemon: { cpuPercent: number; memRssBytes: number };
  host: { cpuPercent: number; memRssBytes: number } | null;
  agents: MetricsAgentSample[];
  history: Array<{ at: string; daemonCpuPercent: number; hostCpuPercent?: number }>;
  /** 全局系统读数（整机 CPU/内存/磁盘）；采不到 = null。 */
  system: SystemSample | null;
  /** 系统时序环形（10s 一格，最长 24h）。 */
  systemHistory: SystemHistoryPoint[];
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
