import { useEffect, useMemo, useRef, useState } from 'react';
import { refreshDashboard } from '@/lib/api/client';
import { subscribeHook } from '@/lib/sse';

/**
 * 事件速率读面（会议室指标卡）：复用 dashboard 速率面——同一条 /events 通道的
 * `dashboard.*` 帧域 + 同一份 localStorage 缓存（DashboardOverview 的种子），
 * 零新端点、零第二条 SSE。这里只留会议室需要的最小桶账（1 小时 × 10s），
 * 总量卡不要；长驻组件才挂（场景卸载即摘订阅，SSE 中枢不养无人看的订阅）。
 */

const WINDOW_MS = 3_600_000;
const BUCKET_MS = 10_000;
const CACHE_KEY = 'weave.dashboard.v1';
const CACHE_TTL_MS = 24 * 3_600_000;

type DashboardFrame =
  | { kind: 'dashboard.series'; series: Array<{ at: string; n: number }> }
  | { kind: 'dashboard.delta'; series: Array<{ at: string; n: number }> };

const align = (ms: number): number => Math.floor(ms / BUCKET_MS) * BUCKET_MS;
const keyOf = (ms: number): string => new Date(ms).toISOString().slice(0, 19);
const msOf = (key: string): number => Date.parse(`${key}Z`);

function readCacheBuckets(): Map<string, number> {
  const buckets = new Map<string, number>();
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return buckets;
    const parsed = JSON.parse(raw) as { savedAt?: number; buckets?: unknown };
    if (typeof parsed.savedAt !== 'number' || Date.now() - parsed.savedAt > CACHE_TTL_MS) {
      return buckets;
    }
    const oldest = keyOf(align(Date.now()) - (WINDOW_MS - BUCKET_MS));
    if (Array.isArray(parsed.buckets)) {
      for (const entry of parsed.buckets) {
        if (!Array.isArray(entry)) continue;
        const [at, n] = entry as [unknown, unknown];
        if (typeof at !== 'string' || typeof n !== 'number') continue;
        if (!Number.isFinite(msOf(at)) || at < oldest) continue;
        buckets.set(at, n);
      }
    }
  } catch {
    // 存储不可用（隐私模式）：没有缓存也能跑
  }
  return buckets;
}

/** 最近 1 小时逐 10s 桶（旧→新，缺格补 0）+ 最近 1 分钟计数（= dashboard 速率卡口径）。 */
export function useRateSeries(): { rate: number | null; series: number[] | null } {
  const buckets = useRef<Map<string, number>>(new Map());
  const [tick, setTick] = useState(0);

  useEffect(() => {
    buckets.current = readCacheBuckets();
    setTick((n) => n + 1);
    // SSE 连接早于本组件挂载：首连那份分块已经过去了，打一枪让服务端重推
    void refreshDashboard().catch(() => {});
    return subscribeHook((frame) => {
      if (!frame.kind?.startsWith('dashboard.')) return;
      const f = frame as unknown as DashboardFrame;
      if (f.kind !== 'dashboard.series' && f.kind !== 'dashboard.delta') return;
      const oldest = keyOf(align(Date.now()) - (WINDOW_MS - BUCKET_MS));
      for (const { at, n } of f.series) {
        if (at >= oldest) buckets.current.set(at, n);
      }
      for (const key of buckets.current.keys()) {
        if (key < oldest) buckets.current.delete(key);
      }
      setTick((n) => n + 1);
    }, ['dashboard.']);
  }, []);

  return useMemo(() => {
    void tick;
    if (buckets.current.size === 0) return { rate: null, series: null };
    const end = align(Date.now());
    const steps = WINDOW_MS / BUCKET_MS;
    const series: number[] = [];
    for (let ms = end - (steps - 1) * BUCKET_MS; ms <= end; ms += BUCKET_MS) {
      series.push(buckets.current.get(keyOf(ms)) ?? 0);
    }
    // 速率 = 最近 1 分钟（6 格），与 dashboard 速率卡同一口径
    const rate = series.slice(-6).reduce((sum, n) => sum + n, 0);
    return { rate, series };
  }, [tick]);
}
