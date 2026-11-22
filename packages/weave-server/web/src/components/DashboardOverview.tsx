import { useCallback, useEffect, useRef, useState } from 'react';
import type { EChartsType } from 'echarts/core';
import { api, type SessionRow } from '@/lib/api';
import { subscribeHook } from '@/lib/sse';
import { useMetrics } from '@/hooks/use-metrics';
import { useT } from '@/i18n/I18nProvider';
import { Activity, Database, FolderKanban, HelpCircle, MessagesSquare } from 'lucide-react';
import type { SessionStatus } from '@/components/tasks/session-status';
import { Tooltip } from '@/components/ui/tooltip';

/** 图窗：1 小时 × 10 秒一格。 */
const WINDOW_MS = 3_600_000;
const BUCKET_MS = 10_000;
/** 本地缓存：24h 内可复用；超出窗口的桶在每次落图时清掉。 */
const CACHE_KEY = 'weave.dashboard.v1';
const CACHE_TTL_MS = 24 * 3_600_000;
const CACHE_WRITE_MS = 5_000;

interface Totals {
  projects: number;
  sessions: number;
  events: number;
  today: number;
}

/** 服务端帧（同一 /events 通道上的仪表盘专用帧型）。 */
type DashboardFrame =
  | { kind: 'dashboard.totals'; totals: Totals }
  | { kind: 'dashboard.series'; series: Array<{ at: string; n: number }> }
  | { kind: 'dashboard.delta'; series: Array<{ at: string; n: number }>; totals: Totals };

/** 资源监控（§13.3）：全局仪表盘只看全局（daemon / Host / Agent 合计）；
 * 逐项目、逐会话的占用在项目卡与会话卡上，数据同源 = 同一条 metrics 帧。 */


const align = (ms: number): number => Math.floor(ms / BUCKET_MS) * BUCKET_MS;
const keyOf = (ms: number): string => new Date(ms).toISOString().slice(0, 19);
const msOf = (key: string): number => Date.parse(`${key}Z`);
const clockOf = (key: string): string => {
  const d = new Date(msOf(key));
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

/** 读本地缓存（过期/损坏一律当没有，别让旧数据顶在屏幕上）。 */
function readCache(): { totals: Totals | null; buckets: Map<string, number> } {
  const empty = { totals: null, buckets: new Map<string, number>() };
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return empty;
    const parsed = JSON.parse(raw) as { savedAt?: number; totals?: Totals; buckets?: unknown };
    if (typeof parsed.savedAt !== 'number' || Date.now() - parsed.savedAt > CACHE_TTL_MS) {
      localStorage.removeItem(CACHE_KEY);
      return empty;
    }
    const oldest = keyOf(align(Date.now()) - (WINDOW_MS - BUCKET_MS));
    const buckets = new Map<string, number>();
    if (Array.isArray(parsed.buckets)) {
      for (const entry of parsed.buckets) {
        if (!Array.isArray(entry)) continue;
        const [at, n] = entry as [unknown, unknown];
        if (typeof at !== 'string' || typeof n !== 'number') continue;
        if (!Number.isFinite(msOf(at)) || at < oldest) continue;
        buckets.set(at, n);
      }
    }
    return { totals: parsed.totals ?? null, buckets };
  } catch {
    try {
      localStorage.removeItem(CACHE_KEY);
    } catch {
      // 存储不可用（隐私模式）：没有缓存也能跑
    }
    return empty;
  }
}

/**
 * 全局仪表盘（首页）：总量卡片 + 一张实时事件速率图。
 *
 * 数据 = 服务端 SSE 推送（同一条 `/events` 通道的 `dashboard.*` 帧）：
 * 连接时先收到总量、历史按 10 分钟分块流式补齐；此后只在真有事件时收增量帧，
 * 没有轮询、也没有一次性大请求。浏览器把最近一小时的桶存 localStorage（24h 过期、
 * 每次落图顺手裁掉窗口外的），刷新页面先拿缓存直接开画，等服务端的块到再校正。
 */
export function DashboardOverview({
  sessions,
  statuses,
}: {
  sessions: SessionRow[] | null;
  statuses: Map<string, SessionStatus>;
}) {
  const t = useT();
  const el = useRef<HTMLDivElement | null>(null);
  const chart = useRef<EChartsType | null>(null);
  /** 分钟桶（UTC 秒键）→ 计数；缓存种子 + 服务端块/增量都落在这一张表里。 */
  const buckets = useRef<Map<string, number>>(new Map());
  const totalsRef = useRef<Totals | null>(null);
  const lastWrite = useRef(0);
  const [totals, setTotals] = useState<Totals | null>(null);
  const [rate, setRate] = useState<number | null>(null);
  const metrics = useMetrics();

  const running = [...statuses.values()].filter((s) => s === 'running' || s === 'compacting').length;

  /** 当前窗口的图数据 + 卡片；顺手裁剪和落缓存。 */
  const render = useCallback(() => {
    const end = align(Date.now());
    const steps = WINDOW_MS / BUCKET_MS;
    const start = end - (steps - 1) * BUCKET_MS;
    const oldest = keyOf(start);
    const labels: string[] = [];
    const data: number[] = [];
    for (let ms = start; ms <= end; ms += BUCKET_MS) {
      const key = keyOf(ms);
      labels.push(clockOf(key));
      data.push(buckets.current.get(key) ?? 0);
    }
    // 窗口外的桶清掉：缓存与内存都不会越攒越大
    for (const key of buckets.current.keys()) {
      if (key < oldest) buckets.current.delete(key);
    }
    setTotals(totalsRef.current);
    // 速率卡 = 最近 1 分钟（6 格），与 1 小时图窗分开看
    setRate(data.slice(-6).reduce((sum, n) => sum + n, 0));
    chart.current?.setOption({ xAxis: { data: labels }, series: [{ data }] });

    const now = Date.now();
    if (now - lastWrite.current < CACHE_WRITE_MS) return;
    lastWrite.current = now;
    try {
      localStorage.setItem(
        CACHE_KEY,
        JSON.stringify({
          savedAt: now,
          totals: totalsRef.current,
          buckets: [...buckets.current],
        }),
      );
    } catch {
      // 配额/隐私模式：缓存写不进去就算了，不影响实时帧
    }
  }, []);

  // 图只建一次：echarts 走动态 import（按需模块，独立 chunk——其它页面不付这份钱）
  useEffect(() => {
    let disposed = false;
    let ro: ResizeObserver | null = null;
    void (async () => {
      const [core, charts, components, renderers] = await Promise.all([
        import('echarts/core'),
        import('echarts/charts'),
        import('echarts/components'),
        import('echarts/renderers'),
      ]);
      if (disposed || !el.current) return;
      core.use([charts.LineChart, components.GridComponent, components.TooltipComponent, renderers.CanvasRenderer]);
      const textColor = getComputedStyle(el.current).color;
      // canvas 不吃 rem：按根字号实算 px（浏览器字号偏好变了图表字跟着走）
      const remPx = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      // 窄屏最多摆得下 7 个时刻（每 10 分钟一个），桌面上可以每 5 分钟一个
      const labelInterval = el.current.clientWidth < 520 ? 59 : 29;
      const c = core.init(el.current, undefined, {
        renderer: 'canvas',
        // 高分屏按 2x 封顶：再高对折线图没有肉眼收益，只多烧像素
        devicePixelRatio: Math.min(window.devicePixelRatio || 1, 2),
      });
      c.setOption({
        animation: false,
        grid: { left: 4, right: 8, top: 10, bottom: 0, containLabel: true },
        tooltip: {
          trigger: 'axis',
          confine: true,
          backgroundColor: 'rgba(17, 24, 39, 0.92)',
          borderWidth: 0,
          textStyle: { color: '#e5e7eb', fontSize: 0.6875 * remPx },
        },
        xAxis: {
          type: 'category',
          boundaryGap: false,
          data: [] as string[],
          axisLine: { lineStyle: { color: 'rgba(148, 163, 184, 0.25)' } },
          axisTick: { show: false },
          // 360 格按宽度抽稀（只标到分），不然轴密得糊成一片
          axisLabel: {
            color: textColor,
            fontSize: 0.625 * remPx,
            interval: labelInterval,
            formatter: (v: string) => v.slice(0, 5),
          },
        },
        yAxis: {
          type: 'value',
          minInterval: 1,
          splitLine: { lineStyle: { color: 'rgba(148, 163, 184, 0.14)' } },
          axisLabel: { color: textColor, fontSize: 0.625 * remPx },
        },
        series: [
          {
            type: 'line',
            data: [] as number[],
            smooth: 0.25,
            showSymbol: false,
            lineStyle: { width: 1.5, color: '#60a5fa' },
            areaStyle: {
              color: {
                type: 'linear',
                x: 0,
                y: 0,
                x2: 0,
                y2: 1,
                colorStops: [
                  { offset: 0, color: 'rgba(96, 165, 250, 0.28)' },
                  { offset: 1, color: 'rgba(96, 165, 250, 0)' },
                ],
              },
            },
          },
        ],
      });
      chart.current = c;
      ro = new ResizeObserver(() => c.resize());
      ro.observe(el.current);
      render();
    })();
    return () => {
      disposed = true;
      ro?.disconnect();
      chart.current?.dispose();
      chart.current = null;
    };
  }, [render]);

  // 缓存先行 + 服务端推送：先拿本地缓存开画，块/增量到了就就地校正（都是「以服务端为准」）
  useEffect(() => {
    const cached = readCache();
    if (cached.totals) totalsRef.current = cached.totals;
    for (const [key, n] of cached.buckets) buckets.current.set(key, n);
    render();
    // SSE 连接早于本组件挂载：首连那份分块已经过去了，打一枪让服务端重推
    void api.refreshDashboard().catch(() => {});

    return subscribeHook((frame) => {
      if (!frame.kind?.startsWith('dashboard.')) return;
      const f = frame as unknown as DashboardFrame;
      if (f.kind === 'dashboard.totals') {
        totalsRef.current = f.totals;
      } else if (f.kind === 'dashboard.series') {
        // 历史块：服务端是权威，直接覆盖这段
        for (const { at, n } of f.series) buckets.current.set(at, n);
      } else {
        for (const { at, n } of f.series) buckets.current.set(at, n);
        totalsRef.current = f.totals;
      }
      render();
    }, ['dashboard.', 'metrics.']);
  }, [render]);

  const cards = [
    {
      icon: MessagesSquare,
      label: t('dashboard.sessions'),
      value: totals?.sessions ?? sessions?.length ?? null,
      hint: t('dashboard.sessionsHint', { n: running }),
      tone: 'text-blue-400',
    },
    {
      icon: Database,
      label: t('dashboard.events'),
      value: totals?.events ?? null,
      hint: totals ? t('dashboard.eventsHint', { n: totals.today }) : '',
      tone: 'text-emerald-400',
    },
    {
      icon: FolderKanban,
      label: t('dashboard.projects'),
      value: totals?.projects ?? null,
      hint: t('dashboard.projectsHint'),
      tone: 'text-violet-400',
    },
    {
      icon: Activity,
      label: t('dashboard.rate'),
      value: rate,
      hint: t('dashboard.rateHint'),
      tone: 'text-amber-400',
    },
  ];

  return (
    <section className="mb-3 space-y-2">
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4 lg:gap-3">
        {cards.map((c) => (
          <div key={c.label} className="rounded-xl border border-edge/[0.06] bg-neutral-900/40 p-3">
            <div className="flex items-center gap-1.5 text-11 text-neutral-500">
              <c.icon className={`h-3.5 w-3.5 ${c.tone}`} />
              <span className="truncate">{c.label}</span>
            </div>
            <div className="mt-1 text-xl font-semibold tabular-nums text-neutral-200 lg:text-2xl">
              {c.value === null ? '—' : c.value.toLocaleString()}
            </div>
            <div className="truncate text-10 text-neutral-600">{c.hint}</div>
          </div>
        ))}
      </div>

      <div className="rounded-xl border border-edge/[0.06] bg-neutral-900/40 p-3">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-xs font-semibold text-neutral-300">{t('dashboard.chartTitle')}</span>
          <span className="text-10 text-neutral-500">{t('dashboard.chartHint')}</span>
          <span className="ml-auto inline-flex items-center gap-1 text-10 text-emerald-400/90">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
            {t('dashboard.live')}
          </span>
        </div>
        <div ref={el} className="mt-1 h-[150px] text-neutral-400 lg:h-[190px]" />
      </div>

      <div className="rounded-xl border border-edge/[0.06] bg-neutral-900/40 p-3">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-xs font-semibold text-neutral-300">{t('dashboard.resourcesTitle')}</span>
          <Tooltip label={t('dashboard.resourcesHint')} side="top">
            <HelpCircle className="h-3 w-3 cursor-help text-neutral-500 hover:text-neutral-300" />
          </Tooltip>
        </div>
        {metrics === null ? (
          <div className="mt-2 text-11 text-neutral-600">{t('dashboard.resourcesWaiting')}</div>
        ) : (
          <>
            <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
              <ResourceCard
                label={t('dashboard.resDaemon')}
                cpuPercent={Math.round(metrics.daemon.cpuPercent * 10) / 10}
                memRssBytes={metrics.daemon.memRssBytes}
                series={metrics.history.map((h) => h.daemonCpuPercent)}
                t={t}
              />
              <ResourceCard
                label={t('dashboard.resHost')}
                cpuPercent={metrics.host?.cpuPercent}
                memRssBytes={metrics.host?.memRssBytes}
                series={metrics.history.map((h) => h.hostCpuPercent).filter((v): v is number => v !== undefined)}
                t={t}
              />
              <ResourceCard
                label={t('dashboard.resAgentsTotal')}
                cpuPercent={
                  metrics.agents.some((a) => a.cpuPercent !== undefined)
                    ? metrics.agents.reduce((s, a) => s + (a.cpuPercent ?? 0), 0)
                    : undefined
                }
                memRssBytes={metrics.agents.reduce((s, a) => s + (a.memRssBytes ?? 0), 0)}
                series={[]}
                t={t}
              />
            </div>
            {metrics.agents.length === 0 && (
              <div className="mt-2 text-11 text-neutral-600">{t('dashboard.resNoAgents')}</div>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(0)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

/** 一张资源卡：CPU%（含 12 点 mini 趋势）+ RSS。cpu undefined = 该项缺席（如实显示 —）。 */
function ResourceCard({
  label,
  cpuPercent,
  memRssBytes,
  series,
  t,
}: {
  label: string;
  cpuPercent: number | undefined;
  memRssBytes: number | undefined;
  series: number[];
  t: ReturnType<typeof useT>;
}) {
  const tail = series.slice(-12);
  const max = Math.max(10, ...tail);
  return (
    <div className="rounded-lg border border-edge/[0.06] bg-neutral-900/60 p-2.5">
      <div className="text-11 text-neutral-500">{label}</div>
      <div className="mt-0.5 flex items-baseline gap-3">
        <span className="text-lg font-semibold tabular-nums text-neutral-200">
          {cpuPercent === undefined ? '—' : `${cpuPercent}%`}
        </span>
        <span className="text-11 tabular-nums text-neutral-500">
          {cpuPercent === undefined ? '' : t('dashboard.resCpu')}
        </span>
      </div>
      <div className="mt-0.5 text-11 tabular-nums text-neutral-500">
        {memRssBytes === undefined ? '—' : fmtBytes(memRssBytes)}
      </div>
      {tail.length > 0 && (
        <div className="mt-1.5 flex h-6 items-end gap-0.5" aria-hidden="true">
          {tail.map((v, i) => (
            <div
              key={i}
              className="w-1.5 rounded-sm bg-blue-400/40"
              style={{ height: `${Math.max(4, Math.min(100, (v / max) * 100))}%` }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
