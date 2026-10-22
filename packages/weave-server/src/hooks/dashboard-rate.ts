/**
 * 仪表盘事件速率的进程内快照：每条 ingest 往当前 **10 秒桶** +1，保留 24 小时
 * （最多 8,640 桶，几十 KB）。读侧 O(图上的点数)，不再按请求扫 `hook_events`。
 *
 * 首次读取（daemon 刚起、桶还空）由库回填一次：拉最近一小时的逐秒分布折进桶。
 * 回填与实时帧都可能在数同一批事件，合并取 **max**（两侧各自只增，同一桶里
 * 「库里有的」∪「起进程后才计到的」用 max 近似不会翻倍）。
 */
export const RATE_BUCKET_MS = 10_000;
export const RATE_RETAIN_MS = 24 * 3_600_000;
const PRUNE_EVERY_MS = 60_000;

export class DashboardRateCache {
  /** 桶起点(ms) → 事件数。 */
  private readonly buckets = new Map<number, number>();
  private seeded = false;
  private lastPrune = 0;
  /** 总量随 ingest 累加（重启后首次读从库补种）。 */
  private events = 0;
  private today = 0;
  private dayKey = '';

  /** 首读回填是否已做过（route 决定要不要拉库）。 */
  get isSeeded(): boolean {
    return this.seeded;
  }

  /** 一条已入库事件（主线程 ingest 路径，O(1)）。 */
  record(now: number = Date.now()): void {
    const key = Math.floor(now / RATE_BUCKET_MS) * RATE_BUCKET_MS;
    this.buckets.set(key, (this.buckets.get(key) ?? 0) + 1);
    this.events += 1;
    const day = new Date(now).toDateString();
    if (day !== this.dayKey) {
      // 跨天：今日计数从 0 起（老计数本来也不该再算「今日」）
      this.dayKey = day;
      if (this.today !== 0) this.today = 0;
    }
    this.today += 1;
    this.prune(now);
  }

  /** 总量（事件总数/今日）；sessions/projects 归调用方另取。 */
  get totals(): { events: number; today: number } {
    return { events: this.events, today: this.today };
  }

  /** 重启后补种总量基线（只增不减，别覆盖已累计的增量）。 */
  seedTotals(events: number, today: number): void {
    this.events = Math.max(this.events, events);
    this.today = Math.max(this.today, today);
    this.dayKey = new Date().toDateString();
  }

  /** 最近 `steps` 个桶（含当前），用于增量帧。 */
  recentBuckets(steps: number, now: number = Date.now()): Array<{ at: string; n: number }> {
    const end = Math.floor(now / RATE_BUCKET_MS) * RATE_BUCKET_MS;
    const start = end - (steps - 1) * RATE_BUCKET_MS;
    return Array.from({ length: steps }, (_, i) => {
      const ms = start + i * RATE_BUCKET_MS;
      return {
        at: new Date(ms).toISOString().slice(0, 19),
        n: this.buckets.get(ms) ?? 0,
      };
    });
  }

  /** 回填一次：`series` 是库里逐秒键（`YYYY-MM-DDTHH:MM:SS`，UTC）。 */
  seed(series: readonly { at: string; n: number }[]): void {
    const sum = new Map<number, number>();
    for (const { at, n } of series) {
      const ms = Date.parse(`${at}Z`);
      if (!Number.isFinite(ms)) continue;
      const key = Math.floor(ms / RATE_BUCKET_MS) * RATE_BUCKET_MS;
      sum.set(key, (sum.get(key) ?? 0) + n);
    }
    for (const [key, n] of sum) this.buckets.set(key, Math.max(this.buckets.get(key) ?? 0, n));
    this.seeded = true;
  }

  /** 连续桶的计数（缺桶 = 0），`start` 必须对齐到桶起点。 */
  bucketsFor(start: number, steps: number): number[] {
    return Array.from({ length: steps }, (_, i) => this.buckets.get(start + i * RATE_BUCKET_MS) ?? 0);
  }

  /** 24h 外丢弃；节流到每分钟一次（写在热路径上，别每条都扫表）。 */
  private prune(now: number): void {
    if (now - this.lastPrune < PRUNE_EVERY_MS) return;
    this.lastPrune = now;
    const cutoff = now - RATE_RETAIN_MS;
    for (const key of this.buckets.keys()) {
      if (key < cutoff) this.buckets.delete(key);
    }
  }
}
