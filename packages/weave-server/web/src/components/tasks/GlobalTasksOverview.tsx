import { useMemo, useRef, useState } from 'react';
import { useT } from '@/i18n/I18nProvider';
import { useToast } from '@/components/Toast';
import type { MessageKey } from '@/i18n/dict';
import type { SessionRow } from '@/lib/api';
import { cn } from '@/lib/utils';
import { sessionLabel } from '@/lib/hook-payload';
import { byActivity, lastSeenLabel, useActivityOrder, useFlipRows } from './SessionList';
import { STATUS_BADGE, STATUS_KEY } from './session-status';
import { SessionStatusIcon } from './SessionStatusIcon';
import { useSessionStatus } from './session-status-store';
import { AgentBadge } from '@/components/AgentBadge';
import { RefreshIconButton } from '@/components/RefreshIconButton';
import { Globe, Loader2 } from 'lucide-react';

/** 时间段快捷档（按 lastSeenAt 过滤）；custom = 起止日期双输入。 */
type RangeKey = 'all' | 'today' | '1d' | '3d' | '7d' | '30d' | 'over30' | 'custom';

const RANGE_KEYS: RangeKey[] = ['all', 'today', '1d', '3d', '7d', '30d', 'over30', 'custom'];
const RANGE_LABEL: Record<RangeKey, MessageKey> = {
  all: 'tasks.rangeAll',
  today: 'tasks.rangeToday',
  '1d': 'tasks.range1d',
  '3d': 'tasks.range3d',
  '7d': 'tasks.range7d',
  '30d': 'tasks.range30d',
  over30: 'tasks.rangeOver30',
  custom: 'tasks.rangeCustom',
};

/**
 * 行序：冻结的活动序快照，与会话列表逐行同口径（跨项目混排，不按项目分组）。
 * 冻结序落后于数据的一帧里，未见的新行按「新在前」兜底置顶；冻结序里已消失
 * 的会话即时移除。
 */
export function globalOverviewRows(
  sessions: readonly SessionRow[],
  appliedIds: readonly string[],
): SessionRow[] {
  const byId = new Map(sessions.map((s) => [s.sessionId, s] as const));
  const ordered: SessionRow[] = [];
  for (const id of appliedIds) {
    const s = byId.get(id);
    if (s) ordered.push(s);
  }
  const seen = new Set(ordered.map((s) => s.sessionId));
  return [...sessions.filter((s) => !seen.has(s.sessionId)), ...ordered];
}

/**
 * 全局任务总览（D9 只读跨项目聚合，不新造 API）：会话与状态全部取全局状态
 * 总线（SessionStatusProvider，与项目行徽标/任务视图同一份推导），行内带项目名；
 * 行点击 → App 跳进对应项目任务视图（initialSessionId）。
 * 查询条件：项目下拉 + 时间段（当天/1·3·7·30 天内/大于 30 天/自定义起止），
 * 全部客户端过滤（列表本就是最新窗口，不新造查询 API）。
 * 行序与会话列表同口径：前端活动序（`byActivity` 排、`useActivityOrder` 门控
 * 落地、`useFlipRows` 滑动动画），跨项目混排不分组——服务端列表恒 created_at
 * 倒序，活动序是前端层的事；过滤条件换批则立即采用新序，不做增量合并。
 */
export function GlobalTasksOverview({
  projects,
  onOpenSession,
}: {
  projects: { id: number; path: string; name: string }[];
  onOpenSession: (projectId: number, sessionId: string) => void;
}) {
  const t = useT();
  const { show } = useToast();
  const { sessions, statuses, error, refresh } = useSessionStatus();
  const [projectFilter, setProjectFilter] = useState<number | 'all'>('all');
  const [range, setRange] = useState<RangeKey>('all');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');

  /** 项目 + 时间段过滤（lastSeenAt 落入区间才保留）。 */
  const filtered = useMemo(() => {
    const list = sessions ?? [];
    const now = Date.now();
    const today0 = new Date();
    today0.setHours(0, 0, 0, 0);
    return list.filter((s) => {
      if (projectFilter !== 'all' && s.projectId !== projectFilter) return false;
      const ts = Date.parse(s.lastSeenAt);
      switch (range) {
        case 'today':
          return ts >= today0.getTime();
        case '1d':
          return ts >= now - 86_400_000;
        case '3d':
          return ts >= now - 3 * 86_400_000;
        case '7d':
          return ts >= now - 7 * 86_400_000;
        case '30d':
          return ts >= now - 30 * 86_400_000;
        case 'over30':
          return ts < now - 30 * 86_400_000;
        case 'custom': {
          if (fromDate) {
            const f = Date.parse(`${fromDate}T00:00:00`);
            if (Number.isFinite(f) && ts < f) return false;
          }
          if (toDate) {
            const u = Date.parse(`${toDate}T23:59:59.999`);
            if (Number.isFinite(u) && ts > u) return false;
          }
          return true;
        }
        default:
          return true;
      }
    });
  }, [sessions, projectFilter, range, fromDate, toDate]);

  // 行序 = 活动序（同会话列表口径）：sortedIds 随事件流实时算，落地序只在成员
  // 变化或周期 tick 时取快照（见 useActivityOrder）；过滤条件换批走 filterKey。
  const filterKey = `${projectFilter}|${range}|${fromDate}|${toDate}`;
  const sortedIds = useMemo(
    () => filtered.slice().sort(byActivity).map((s) => s.sessionId),
    [filtered],
  );
  const appliedIds = useActivityOrder(sortedIds, filterKey);

  const rows = useMemo(() => {
    const nameOf = new Map(projects.map((p) => [p.id, p.name]));
    return globalOverviewRows(filtered, appliedIds).map((session) => ({
      session,
      projectName:
        session.projectId == null
          ? t('tasks.overviewUnknownProject')
          : nameOf.get(session.projectId) ?? t('tasks.overviewUnknownProject'),
    }));
  }, [filtered, appliedIds, projects, t]);

  const rowEls = useRef(new Map<string, HTMLLIElement>());
  useFlipRows(rowEls);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Globe className="h-3.5 w-3.5 text-sky-400" />
        <h3 className="text-sm font-semibold text-neutral-200">{t('tasks.overviewTitle')}</h3>
        <span className="text-[11px] text-neutral-500">
          {sessions === null
            ? t('hooks.loading')
            : filtered.length === (sessions?.length ?? 0)
              ? String(filtered.length)
              : `${filtered.length} / ${sessions?.length ?? 0}`}
        </span>
        <RefreshIconButton
          className="ml-auto"
          title={t('tasks.refresh')}
          onClick={async () => {
            const err = await refresh();
            show(err ? 'error' : 'success', err ?? t('tasks.refreshed'));
          }}
        />
      </div>

      {/* 查询条件：项目 + 时间段（客户端过滤，不新造 API） */}
      <div className="flex flex-wrap items-center gap-1.5 px-2">
        <select
          value={projectFilter === 'all' ? '' : String(projectFilter)}
          onChange={(e) => setProjectFilter(e.target.value === '' ? 'all' : Number(e.target.value))}
          className="rounded-md border border-edge/[0.08] bg-neutral-900 px-2 py-1 text-xs text-neutral-200"
        >
          <option value="">{t('tasks.overviewAllProjects')}</option>
          {projects.map((p) => (
            <option key={p.id} value={String(p.id)}>
              {p.name}
            </option>
          ))}
        </select>
        <span className="flex overflow-hidden rounded-md border border-edge/[0.08]">
          {RANGE_KEYS.map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setRange(k)}
              className={cn(
                'px-2 py-1 text-[11px] transition-colors',
                range === k
                  ? 'bg-neutral-800 text-neutral-100'
                  : 'text-neutral-500 hover:bg-neutral-800/50',
              )}
            >
              {t(RANGE_LABEL[k])}
            </button>
          ))}
        </span>
        {range === 'custom' && (
          <span className="flex items-center gap-1 text-[11px] text-neutral-500">
            <input
              type="date"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
              aria-label={t('tasks.rangeFrom')}
              className="rounded-md border border-edge/[0.08] bg-neutral-900 px-1.5 py-0.5 text-[11px] text-neutral-200"
            />
            —
            <input
              type="date"
              value={toDate}
              onChange={(e) => setToDate(e.target.value)}
              aria-label={t('tasks.rangeTo')}
              className="rounded-md border border-edge/[0.08] bg-neutral-900 px-1.5 py-0.5 text-[11px] text-neutral-200"
            />
          </span>
        )}
      </div>

      {error && (
        <p className="rounded border border-red-500/30 bg-red-950/30 px-2 py-1 text-[11px] text-red-300">
          {error}
        </p>
      )}
      {sessions === null ? (
        <p className="flex items-center gap-1.5 text-xs text-neutral-600">
          <Loader2 className="h-3 w-3 animate-spin" />
          {t('hooks.loading')}
        </p>
      ) : rows.length === 0 ? (
        <p className="text-xs text-neutral-600">{t('tasks.overviewEmpty')}</p>
      ) : (
        <>
          {/* 列头与行同构收缩（<lg 项目列收窄、状态列自然宽、事件/时间列隐藏
              ——两条数据折进行内第二行），否则窄屏 shrink-0 定列互相挤压错位。 */}
          <div className="flex items-center gap-3 px-2 text-[10px] text-neutral-600">
            <span className="w-32 max-lg:w-24 shrink-0">{t('tasks.overviewProject')}</span>
            <span className="min-w-0 flex-1">{t('tasks.overviewSession')}</span>
            <span className="w-20 max-lg:w-auto shrink-0">{t('tasks.overviewStatus')}</span>
            <span className="w-16 shrink-0 text-right hidden lg:block">{t('tasks.overviewEvents')}</span>
            <span className="w-16 shrink-0 text-right hidden lg:block">{t('tasks.overviewTime')}</span>
          </div>
          <ul className="space-y-1">
            {rows.map(({ session: s, projectName }) => {
              const status = statuses.get(s.sessionId) ?? 'open';
              const clickable = s.projectId != null;
              return (
                <li
                  key={s.sessionId}
                  ref={(el) => {
                    if (el) rowEls.current.set(s.sessionId, el);
                    else rowEls.current.delete(s.sessionId);
                  }}
                >
                  <div
                    role={clickable ? 'button' : undefined}
                    tabIndex={clickable ? 0 : undefined}
                    onClick={
                      clickable
                        ? () => onOpenSession(s.projectId as number, s.sessionId)
                        : undefined
                    }
                    onKeyDown={
                      clickable
                        ? (e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              onOpenSession(s.projectId as number, s.sessionId);
                            }
                          }
                        : undefined
                    }
                    title={clickable ? sessionLabel(s.title, s.sessionId) : undefined}
                    className={cn(
                      'flex flex-wrap lg:flex-nowrap items-center gap-3 rounded-md border px-2 py-1.5',
                      clickable
                        ? 'cursor-pointer border-edge/[0.06] bg-edge/[0.015] hover:bg-edge/[0.04]'
                        : 'border-edge/[0.04] opacity-60',
                    )}
                  >
                    <span
                      className="w-32 max-lg:w-24 shrink-0 truncate rounded bg-neutral-800/80 px-1.5 py-0.5 text-[10px] text-neutral-300"
                      title={projectName}
                    >
                      {projectName}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-xs font-medium text-neutral-200">
                      {sessionLabel(s.title, s.sessionId)}
                    </span>
                    {s.harness && (
                      <AgentBadge agent={s.harness} className="shrink-0 px-1 text-[10px]" />
                    )}
                    <span className="flex w-20 max-lg:w-auto shrink-0 items-center gap-1.5">
                      <SessionStatusIcon status={status} harness={s.harness} />
                      {/* STATUS_BADGE 形如 'bg-x text-y'——取字色段做行内文字色 */}
                      <span className={cn('text-[10px]', STATUS_BADGE[status].split(' ')[1])}>
                        {t(STATUS_KEY[status])}
                      </span>
                    </span>
                    <span className="hidden lg:block w-16 shrink-0 text-right text-[10px] text-neutral-500">
                      {t('tasks.events', { n: s.eventCount ?? 0 })}
                    </span>
                    <span className="hidden lg:block w-16 shrink-0 text-right text-[10px] text-neutral-500">
                      {lastSeenLabel(t, s.lastSeenAt, Date.now())}
                    </span>
                    {/* <lg：事件/时间折到第二行（basis-full 强制换行），数据不丢 */}
                    <span className="lg:hidden flex basis-full gap-3 text-[10px] text-neutral-500">
                      <span>{t('tasks.events', { n: s.eventCount ?? 0 })}</span>
                      <span>{lastSeenLabel(t, s.lastSeenAt, Date.now())}</span>
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
