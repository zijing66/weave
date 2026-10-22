import type { HookEventBus } from '../hooks/bus.js';
import type { HookEventRepository } from '../repositories/hook-events.js';
import type { ProjectRepository } from '../repositories/projects.js';
import type { SessionRepository } from '../repositories/sessions.js';
import { RATE_BUCKET_MS, type DashboardRateCache } from '../hooks/dashboard-rate.js';

/** 图窗：1 小时 × 10 秒一格。 */
export const DASHBOARD_WINDOW_MS = 3_600_000;
/** 历史按块流式下发（一帧 = 10 分钟），首帧就能开画，不用等整段查完。 */
const SERIES_CHUNK = 60;
/** 增量合并窗：有事件才推，1 秒内的事件并成一帧（事件密集时不刷屏）。 */
const DELTA_COALESCE_MS = 1_000;
/** 项目/会话数变化很慢：最多一分钟重取一次（事件/今日随 ingest 累加，零查询）。 */
const META_REFRESH_MS = 60_000;

export interface DashboardPushDeps {
  rate: DashboardRateCache;
  events: Pick<HookEventRepository, 'countAll' | 'countSince' | 'seriesBySecond'>;
  sessions: Pick<SessionRepository, 'countAll'>;
  projects: Pick<ProjectRepository, 'list'>;
  bus: Pick<HookEventBus, 'emit' | 'subscribe'>;
}

/**
 * 仪表盘推送（事件驱动）：
 * - **连接时**（SseHub 首个订阅者 attach）先推总量，再把一小时历史按 10 分钟分块
 *   流式推下去——每块一到前端就能画，不等整段查完；
 * - **之后**只在真有 `event.ingested` 时推增量（1 秒合并），没有数据就不发帧；
 * - 速率读进程内快照，只有 daemon 起来后第一次 attach 才回填一次库。
 */
export function startDashboardPusher(deps: DashboardPushDeps): {
  attach: () => void;
  stop: () => void;
} {
  let pending = false;
  let meta = { projects: 0, sessions: 0 };
  let metaAt = 0;

  const refreshMeta = (): void => {
    meta = { projects: deps.projects.list().length, sessions: deps.sessions.countAll() };
    metaAt = Date.now();
  };

  const totals = (): { projects: number; sessions: number; events: number; today: number } => ({
    ...meta,
    ...deps.rate.totals,
  });

  /** 首连快照：总量 + 分块历史（微任务里发——attach 那一刻总线订阅刚建好）。 */
  const attach = (): void => {
    queueMicrotask(() => {
      const now = Date.now();
      const steps = DASHBOARD_WINDOW_MS / RATE_BUCKET_MS;
      const end = Math.floor(now / RATE_BUCKET_MS) * RATE_BUCKET_MS;
      const start = end - (steps - 1) * RATE_BUCKET_MS;
      const projectIds = deps.projects.list().map((p) => p.id);
      if (!deps.rate.isSeeded) {
        // 回填与总量基线同一拍做：都是「这个进程第一次有人看」才需要
        deps.rate.seed(deps.events.seriesBySecond(projectIds, new Date(start).toISOString()));
        deps.rate.seedTotals(
          deps.events.countAll(),
          deps.events.countSince(
            projectIds,
            new Date(new Date(now).setHours(0, 0, 0, 0)).toISOString(),
          ),
        );
        refreshMeta();
      }
      if (Date.now() - metaAt > META_REFRESH_MS) refreshMeta();
      const at = new Date(now).toISOString();
      deps.bus.emit({ kind: 'dashboard.totals', at, totals: totals() });
      for (let offset = 0; offset < steps; offset += SERIES_CHUNK) {
        const len = Math.min(SERIES_CHUNK, steps - offset);
        const chunkStart = start + offset * RATE_BUCKET_MS;
        const counts = deps.rate.bucketsFor(chunkStart, len);
        deps.bus.emit({
          kind: 'dashboard.series',
          at,
          series: counts.map((n, i) => ({
            at: new Date(chunkStart + i * RATE_BUCKET_MS).toISOString().slice(0, 19),
            n,
          })),
        });
      }
    });
  };

  // 事件驱动：只在真有入库事件时标脏，定时器只是把它合并成一帧
  const off = deps.bus.subscribe((message) => {
    if (message.kind === 'event.ingested') pending = true;
  });
  const timer = setInterval(() => {
    if (!pending) return;
    pending = false;
    if (Date.now() - metaAt > META_REFRESH_MS) refreshMeta();
    deps.bus.emit({
      kind: 'dashboard.delta',
      at: new Date().toISOString(),
      // 最近 12 格：跨过桶边界时前后两格都对得上
      series: deps.rate.recentBuckets(12),
      totals: totals(),
    });
  }, DELTA_COALESCE_MS);
  timer.unref?.();

  return {
    attach,
    stop: () => {
      off();
      clearInterval(timer);
    },
  };
}
