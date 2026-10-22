import { describe, expect, it } from 'vitest';
import { DashboardRateCache, RATE_BUCKET_MS, RATE_RETAIN_MS } from '../dashboard-rate.js';

/** 速率快照：10 秒桶、写入 O(1)、回填与实时取 max 不翻倍、24h 外清理。 */

const secKey = (ms: number): string => new Date(ms).toISOString().slice(0, 19);
const align = (ms: number): number => Math.floor(ms / RATE_BUCKET_MS) * RATE_BUCKET_MS;

describe('DashboardRateCache', () => {
  it('record 累加到当前 10 秒桶，bucketsFor 按对齐起点返回连续桶', () => {
    const cache = new DashboardRateCache();
    const now = 1_700_000_000_000;
    cache.record(now);
    cache.record(now + 1_000);
    cache.record(now + RATE_BUCKET_MS); // 下一桶
    const start = align(now) - 1 * RATE_BUCKET_MS;
    expect(cache.bucketsFor(start, 3)).toEqual([0, 2, 1]);
  });

  it('回填把逐秒分布折进桶，且与已计入的实时帧取 max（不翻倍）', () => {
    const cache = new DashboardRateCache();
    const now = 1_700_000_000_000;
    const b0 = align(now);
    cache.record(b0);
    cache.seed([
      { at: secKey(b0), n: 2 },
      { at: secKey(b0 + 1_000), n: 3 }, // 同桶：库 2+3=5
      { at: secKey(b0 + RATE_BUCKET_MS), n: 1 },
    ]);
    expect(cache.isSeeded).toBe(true);
    expect(cache.bucketsFor(b0, 2)).toEqual([5, 1]);
  });

  it('24h 外的桶在节流清理时丢掉', () => {
    const cache = new DashboardRateCache();
    const now = 1_700_000_000_000;
    cache.record(now - RATE_RETAIN_MS - 60_000);
    cache.record(now); // 首次 record 已跑 prune（lastPrune=0 → 立即清理）
    expect(cache.bucketsFor(align(now - RATE_RETAIN_MS - 60_000), 1)).toEqual([0]);
    expect(cache.bucketsFor(align(now), 1)).toEqual([1]);
  });
});
