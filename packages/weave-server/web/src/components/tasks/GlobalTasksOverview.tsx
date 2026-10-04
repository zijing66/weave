import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type HookDispatch, type SessionRow } from '@/lib/api';
import { useT } from '@/i18n/I18nProvider';
import { cn } from '@/lib/utils';
import { formatTime } from '@/lib/hook-payload';
import { deriveSessionStatus, STATUS_DOT, STATUS_KEY, type SessionStatus } from './session-status';
import { Globe, Loader2 } from 'lucide-react';

/**
 * 全局任务总览（D9 只读跨项目聚合，不新造 API）：listSessions() 无参 +
 * listHookDispatches 全局窗口，按 projectId 分组展示；行点击 → App 跳进
 * 对应项目任务视图（initialSessionId）。状态推导复用 deriveSessionStatus，
 * dispatch 按会话归并（等价于按该项目的 dispatch 过滤）。
 */
export function GlobalTasksOverview({
  projects,
  onOpenSession,
}: {
  projects: { id: number; path: string; name: string }[];
  onOpenSession: (projectId: number, sessionId: string) => void;
}) {
  const t = useT();
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [dispatches, setDispatches] = useState<HookDispatch[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .listSessions()
      .then(setSessions)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    api
      .listHookDispatches({ limit: 200 })
      .then(setDispatches)
      .catch(() => {}); // 派发列表失败不阻断总览（状态降级为 lastSeenAt）
  }, []);

  useEffect(() => {
    setSessions(null);
    load();
  }, [load]);

  const statuses = useMemo(() => {
    const bySession = new Map<string, HookDispatch[]>();
    for (const d of dispatches) {
      if (!d.sessionId) continue;
      const list = bySession.get(d.sessionId) ?? [];
      list.push(d);
      bySession.set(d.sessionId, list);
    }
    const map = new Map<string, SessionStatus>();
    for (const s of sessions ?? []) {
      const mine = bySession.get(s.sessionId) ?? [];
      const latest = mine[0]; // 全局列表按 startedAt 倒序，首条最新
      map.set(
        s.sessionId,
        deriveSessionStatus({
          lastSeenAt: s.lastSeenAt,
          hasRunningDispatch: mine.some((d) => d.status === 'running'),
          latestDispatchFailed:
            latest !== undefined && (latest.status === 'failed' || latest.status === 'timeout'),
        }),
      );
    }
    return map;
  }, [sessions, dispatches]);

  // 按 projectId 分组：会话本就按活跃倒序，按首次出现分桶即「同项目相邻 + 组间按最新活跃」。
  const rows = useMemo(() => {
    const nameOf = new Map(projects.map((p) => [p.id, p.name]));
    const order: number[] = [];
    const buckets = new Map<number, SessionRow[]>();
    for (const s of sessions ?? []) {
      const key = s.projectId ?? -1;
      if (!buckets.has(key)) {
        buckets.set(key, []);
        order.push(key);
      }
      buckets.get(key)!.push(s);
    }
    return order.flatMap((key) =>
      buckets.get(key)!.map((session) => ({
        session,
        projectName:
          key === -1
            ? t('tasks.overviewUnknownProject')
            : nameOf.get(key) ?? t('tasks.overviewUnknownProject'),
      })),
    );
  }, [sessions, projects, t]);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Globe className="h-3.5 w-3.5 text-sky-400" />
        <h3 className="text-sm font-semibold text-neutral-200">{t('tasks.overviewTitle')}</h3>
        <span className="text-[11px] text-neutral-500">
          {sessions === null ? t('hooks.loading') : String(sessions.length)}
        </span>
        <button
          type="button"
          onClick={load}
          className="ml-auto text-[11px] text-neutral-500 hover:text-neutral-200"
        >
          {t('tasks.refresh')}
        </button>
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
          <div className="flex items-center gap-3 px-2 text-[10px] text-neutral-600">
            <span className="w-32 shrink-0">{t('tasks.overviewProject')}</span>
            <span className="min-w-0 flex-1">{t('tasks.overviewSession')}</span>
            <span className="w-20 shrink-0">{t('tasks.overviewStatus')}</span>
            <span className="w-16 shrink-0 text-right">{t('tasks.overviewEvents')}</span>
            <span className="w-16 shrink-0 text-right">{t('tasks.overviewTime')}</span>
          </div>
          <ul className="space-y-1">
            {rows.map(({ session: s, projectName }) => {
              const status = statuses.get(s.sessionId) ?? 'idle';
              const clickable = s.projectId != null;
              return (
                <li key={s.sessionId}>
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
                    title={clickable ? s.sessionId : undefined}
                    className={cn(
                      'flex items-center gap-3 rounded-md border px-2 py-1.5',
                      clickable
                        ? 'cursor-pointer border-white/[0.06] bg-white/[0.015] hover:bg-white/[0.04]'
                        : 'border-white/[0.04] opacity-60',
                    )}
                  >
                    <span
                      className="w-32 shrink-0 truncate rounded bg-neutral-800/80 px-1.5 py-0.5 text-[10px] text-neutral-300"
                      title={projectName}
                    >
                      {projectName}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-xs font-medium text-neutral-200">
                      {s.title ?? s.sessionId.slice(0, 8)}
                    </span>
                    <span className="flex w-20 shrink-0 items-center gap-1.5">
                      <span className={cn('h-2 w-2 shrink-0 rounded-full', STATUS_DOT[status])} />
                      <span className="text-[10px] text-neutral-400">{t(STATUS_KEY[status])}</span>
                    </span>
                    <span className="w-16 shrink-0 text-right text-[10px] text-neutral-500">
                      {t('tasks.events', { n: s.eventCount ?? 0 })}
                    </span>
                    <span className="w-16 shrink-0 text-right text-[10px] text-neutral-500">
                      {formatTime(s.lastSeenAt)}
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
