import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  type HookDispatch,
  type HookEventRow,
  type HookRule,
  type SessionRow,
} from '@/lib/api';
import { useT } from '@/i18n/I18nProvider';
import { Badge } from '@/components/ui/badge';
import { formatTime } from '@/lib/hook-payload';
import { SessionList } from './SessionList';
import {
  buildLifecycleGroups,
  ORPHAN_GROUP_ID,
} from './build-lifecycle-groups';
import { HARNESS_LIFECYCLE } from './lifecycle';
import { LifecycleMindmap } from '@/components/LifecycleMindmap';
import { deriveSessionStatus, STATUS_KEY, type SessionStatus } from './session-status';
import { Activity, ChevronDown, ChevronRight, Loader2 } from 'lucide-react';

/** App 转发的 hook 帧（mirror bus.ts 的 HookBusMessage，字段按 kind 可选）。 */
interface HookFrame {
  kind?: string;
  sessionId?: string | null;
  ruleId?: string;
  eventId?: number;
  dispatchId?: number;
  status?: string;
}

/**
 * 任务视图容器（项目级两栏）：左 = 会话列表（状态/计数/改名/拖拽目标），
 * 右 = 选中会话的分组组头列表（滚动窗口：默认最新 10 条、向上滚动加载更早）
 * + 单组合体事件链画布（默认全折叠，点击展开才按需挂载导图）。
 * SSE（App 转发的 weave:hook 帧）驱动：500ms 防抖 refetch + overlay 即时状态。
 */
export function TasksPanel({
  projectId,
  initialSessionId,
}: {
  projectId: number;
  /** 初始选中会话（全局总览跳转用）；不传则默认最新会话。 */
  initialSessionId?: string;
}) {
  const t = useT();
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [rules, setRules] = useState<HookRule[]>([]);
  const [dispatches, setDispatches] = useState<HookDispatch[]>([]);
  const [events, setEvents] = useState<HookEventRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingRun, setPendingRun] = useState<{
    dispatchId: number;
    sessionId: string;
    sessionLabel: string;
  } | null>(null);
  /** SSE 即时状态覆盖（帧已到、refetch 未回；refetch 完成后以 API 为准清除）。 */
  const [overlay, setOverlay] = useState<Map<string, SessionStatus>>(new Map());
  /** 展开组：null = 自动跟随最新组，'' = 用户全部折叠，其余 = 固定该组。 */
  /** 展开组：'' = 默认全折叠（画布点击才按需挂载），其余 = 固定该组。 */
  const [expandedGroupId, setExpandedGroupId] = useState<string>('');
  /** 组头列表滚动窗口：默认最新 10 条，向上滚动/点击加载更早（折叠条级）。 */
  const [groupWindow, setGroupWindow] = useState(10);
  const scrollThrottle = useRef<number | null>(null);

  const refreshSessions = useCallback(async () => {
    try {
      const list = await api.listSessions(projectId);
      setSessions(list);
      setSelectedId((prev) => prev ?? list[0]?.sessionId ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [projectId]);

  const refreshDispatches = useCallback(async () => {
    try {
      setDispatches(await api.listHookDispatches({ limit: 200 }));
    } catch {
      // 派发列表失败不阻断面板（状态推导降级为 lastSeenAt）
    }
  }, []);

  const refreshEvents = useCallback(
    async (sessionId: string) => {
      try {
        setEvents(await api.listSessionHooks(projectId, sessionId));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [projectId],
  );

  useEffect(() => {
    setSelectedId(initialSessionId ?? null);
    setEvents([]);
    void refreshSessions();
    void refreshDispatches();
    api.listHooksRules(projectId).then(setRules).catch(() => {});
  }, [projectId, initialSessionId, refreshSessions, refreshDispatches]);

  useEffect(() => {
    if (selectedId) void refreshEvents(selectedId);
  }, [selectedId, refreshEvents]);

  // 切会话：全折叠 + 窗口重置回最新 10 条（画布按需点开）。
  useEffect(() => {
    setExpandedGroupId('');
    setGroupWindow(10);
  }, [selectedId]);

  // ---- SSE：App 转发的 weave:hook 帧（不新开 EventSource）----
  useEffect(() => {
    const timers: number[] = [];
    let refreshTimer: number | null = null;

    const refetchAll = (): void => {
      void (async () => {
        await Promise.allSettled([refreshSessions(), refreshDispatches()]);
        if (selectedId) await refreshEvents(selectedId).catch(() => {});
        // API 数据已回，overlay 完成使命（started/finished 的行状态已落库）
        setOverlay(new Map());
      })();
    };
    const debounceRefetch = (): void => {
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null;
        refetchAll();
      }, 500);
    };

    const onHook = (e: Event): void => {
      const f = (e as CustomEvent<HookFrame>).detail ?? {};
      switch (f.kind) {
        case 'event.ingested': {
          if (f.sessionId) {
            // 左栏计数/lastSeen 本地即时 +1（refetch 兜底校准）
            setSessions((prev) =>
              prev?.map((s) =>
                s.sessionId === f.sessionId
                  ? {
                      ...s,
                      eventCount: (s.eventCount ?? 0) + 1,
                      lastSeenAt: new Date().toISOString(),
                    }
                  : s,
              ) ?? prev,
            );
          }
          break;
        }
        case 'dispatch.started': {
          if (f.sessionId) {
            setOverlay((prev) => new Map(prev).set(f.sessionId as string, 'running'));
          }
          break;
        }
        case 'dispatch.finished': {
          if (!f.sessionId) break;
          setOverlay((prev) => {
            const next = new Map(prev);
            if (f.status === 'failed' || f.status === 'timeout') {
              next.set(f.sessionId as string, 'failed');
            } else {
              next.delete(f.sessionId as string); // succeeded → 交还 API 数据
            }
            return next;
          });
          break;
        }
        default:
          break;
      }
      debounceRefetch();
    };

    window.addEventListener('weave:hook', onHook);
    return () => {
      window.removeEventListener('weave:hook', onHook);
      for (const id of timers) window.clearTimeout(id);
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
    };
  }, [refreshSessions, refreshDispatches, refreshEvents, selectedId]);

  const dispatchBySession = useMemo(() => {
    const m = new Map<string, HookDispatch[]>();
    for (const d of dispatches) {
      if (!d.sessionId) continue;
      const list = m.get(d.sessionId) ?? [];
      list.push(d);
      m.set(d.sessionId, list);
    }
    return m;
  }, [dispatches]);

  const statuses = useMemo(() => {
    const map = new Map<string, SessionStatus>();
    for (const s of sessions ?? []) {
      const mine = dispatchBySession.get(s.sessionId) ?? [];
      const latest = mine[0]; // 全局列表按 startedAt 倒序，组内首条最新
      // events 为时间升序，末条最新（仅选中会话已加载）
      const newestEvent = s.sessionId === selectedId ? events[events.length - 1] : undefined;
      map.set(
        s.sessionId,
        deriveSessionStatus({
          lastSeenAt: s.lastSeenAt,
          latestEventAt: newestEvent?.createdAt,
          latestEventType: newestEvent?.eventType,
          hasRunningDispatch: mine.some((d) => d.status === 'running'),
          latestDispatchFailed:
            latest !== undefined && (latest.status === 'failed' || latest.status === 'timeout'),
          overlay: overlay.get(s.sessionId),
        }),
      );
    }
    return map;
  }, [sessions, dispatchBySession, events, selectedId, overlay]);

  // 分组（D7 表驱动）：每组一套事件+派发切片，构图/画布只吃当前展开组。
  // SSE refetch 后重算：新 UserPromptSubmit 开新组、组内事件归当前 open 组、
  // 窗口尾无 open 归最后组——组 id 稳定（turn:<事件id>），展开态不跳。
  // 游离指令组不进组头列表（无生命周期从属、顺序异常——由「待派发」区承载）。
  const groups = useMemo(
    () =>
      selectedId
        ? buildLifecycleGroups(
            events,
            dispatchBySession.get(selectedId) ?? [],
            HARNESS_LIFECYCLE.claude,
          ).filter((g) => g.id !== ORPHAN_GROUP_ID)
        : [],
    [selectedId, events, dispatchBySession],
  );

  const activeGroupId = useMemo(() => {
    if (expandedGroupId && groups.some((g) => g.id === expandedGroupId)) {
      return expandedGroupId;
    }
    return null; // 默认全折叠：画布点击展开才按需挂载
  }, [groups, expandedGroupId]);

  const onRename = async (sessionId: string, title: string): Promise<void> => {
    try {
      await api.renameSession(sessionId, title);
      await refreshSessions();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  /** 待派发行的目标会话（缺省 = 最近活跃会话）。 */
  const [assign, setAssign] = useState<Record<number, string>>({});
  /** 待派发清单：未投送的 pending 指令，且规则作用于本项目（本项目+全局规则）。 */
  const pendingToDispatch = useMemo(
    () =>
      dispatches.filter(
        (d) =>
          d.status === 'pending' &&
          d.sessionId === null &&
          rules.some((r) => r.id === d.ruleId),
      ),
    [dispatches, rules],
  );
  const runDispatch = async (dispatchId: number, sessionId: string): Promise<void> => {
    try {
      await api.runHookDispatch(dispatchId, sessionId);
      await refreshDispatches();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // 组头列表滚动窗口（折叠条级）：滚动到顶自动加载更早 10 条，600ms 节流。
  const shownGroups = groups.slice(-groupWindow);
  const olderRemaining = groups.length - shownGroups.length;
  const onListScroll = (e: React.UIEvent<HTMLDivElement>): void => {
    if (olderRemaining <= 0 || e.currentTarget.scrollTop > 8) return;
    const now = Date.now();
    if (scrollThrottle.current && now - scrollThrottle.current < 600) return;
    scrollThrottle.current = now;
    setGroupWindow((w) => w + 10);
  };

  const onDropDispatch = (dispatchId: number, sessionId: string): void => {
    const session = (sessions ?? []).find((s) => s.sessionId === sessionId);
    setPendingRun({
      dispatchId,
      sessionId,
      sessionLabel: session?.title ?? sessionId.slice(0, 8),
    });
  };

  const confirmRun = async (): Promise<void> => {
    if (!pendingRun) return;
    try {
      await api.runHookDispatch(pendingRun.dispatchId, pendingRun.sessionId);
      await refreshDispatches();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPendingRun(null);
    }
  };

  return (
    <div className="flex h-full min-h-0 gap-3">
      {/* 左栏：会话列表 */}
      <aside className="flex w-72 shrink-0 flex-col gap-2 overflow-y-auto border-r border-white/[0.06] pr-3">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-neutral-200">{t('tasks.listTitle')}</h3>
          <span className="text-[11px] text-neutral-500">
            {sessions === null ? t('hooks.loading') : String(sessions.length)}
          </span>
          <button
            type="button"
            onClick={() => void refreshSessions()}
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
        ) : sessions.length === 0 ? (
          <p className="text-xs text-neutral-600">{t('tasks.emptySessions')}</p>
        ) : (
          <SessionList
            sessions={sessions}
            statuses={statuses}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onRename={(id, title) => void onRename(id, title)}
            onDropDispatch={onDropDispatch}
          />
        )}
      </aside>

      {/* 右栏：组头列表 + 单组画布（D8 accordion，每组一图） */}
      <section className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 pb-2">
          <Activity className="h-3.5 w-3.5 text-rose-400" />
          <h3 className="text-sm font-semibold text-neutral-200">{t('tasks.chainTitle')}</h3>
          <span className="ml-auto text-[10px] text-neutral-600">{t('tasks.legendNote')}</span>
        </div>

        {/* 待派发区：未投送的 pending 指令——选活跃会话后派发（结果在事件链高亮） */}
        {pendingToDispatch.length > 0 && (
          <div className="mb-2 shrink-0 rounded-lg border border-amber-500/20 bg-amber-500/[0.04] px-2 py-1.5">
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] font-medium text-amber-300">
                {t('tasks.dispatchQueue', { n: pendingToDispatch.length })}
              </span>
              <span className="text-[10px] text-amber-200/50">{t('tasks.dispatchHint')}</span>
            </div>
            <ul className="mt-1 space-y-1">
              {pendingToDispatch.map((d) => {
                const target = assign[d.id] ?? sessions?.[0]?.sessionId ?? '';
                return (
                  <li key={d.id} className="flex items-center gap-2">
                    <span
                      className="min-w-0 flex-1 truncate text-[11px] text-neutral-300"
                      title={d.prompt}
                    >
                      {d.prompt}
                    </span>
                    <select
                      value={target}
                      onChange={(e) => setAssign((prev) => ({ ...prev, [d.id]: e.target.value }))}
                      className="shrink-0 rounded border border-white/[0.08] bg-neutral-900 px-1.5 py-0.5 text-[11px] text-neutral-200"
                    >
                      {(sessions ?? []).map((s) => (
                        <option key={s.sessionId} value={s.sessionId}>
                          {s.title ?? s.sessionId.slice(0, 8)}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      disabled={!target}
                      onClick={() => void runDispatch(d.id, target)}
                      className="shrink-0 rounded bg-emerald-700/80 px-2 py-0.5 text-[11px] font-medium text-white transition-colors hover:bg-emerald-600 disabled:opacity-40"
                    >
                      {t('tasks.dispatchRun')}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {!selectedId ? (
          <p className="flex min-h-0 flex-1 items-center justify-center text-xs text-neutral-600">
            {t('tasks.selectHint')}
          </p>
        ) : groups.length === 0 ? (
          <p className="flex min-h-0 flex-1 items-center justify-center text-xs text-neutral-600">
            {t('tasks.chainEmpty')}
          </p>
        ) : (
          <div
            className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto pr-1"
            onScroll={onListScroll}
          >
            {/* 顶部渐变遮罩：更早 prompt 未加载的 affordance——向上滚动自动加载，
                也可点击按钮增量/全量加载（默认只展示最新 10 条折叠条） */}
            {olderRemaining > 0 && (
              <div className="pointer-events-none sticky top-0 z-10 -mx-1 bg-gradient-to-b from-neutral-950/95 via-neutral-950/70 to-transparent px-1 pb-5 pt-1 text-center">
                <p className="text-[10px] text-neutral-500">{t('tasks.olderHint')}</p>
                <span className="pointer-events-auto mt-1 inline-flex gap-2">
                  <button
                    type="button"
                    onClick={() => setGroupWindow((w) => w + 10)}
                    className="rounded-md border border-white/[0.1] bg-neutral-900/90 px-2 py-0.5 text-[11px] text-neutral-200 transition-colors hover:bg-neutral-800"
                  >
                    {t('tasks.loadOlder', { n: Math.min(10, olderRemaining) })}
                  </button>
                  <button
                    type="button"
                    onClick={() => setGroupWindow((w) => w + groups.length)}
                    className="rounded-md border border-white/[0.1] bg-neutral-900/90 px-2 py-0.5 text-[11px] text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-neutral-200"
                  >
                    {t('tasks.loadAll')}
                  </button>
                </span>
              </div>
            )}
            {shownGroups.map((g) => {
              const title = g.prompt ?? (g.preSession ? null : g.events[0]?.eventType ?? g.id);
              const lastEvent = g.events[g.events.length - 1];
              const timeIso = lastEvent?.createdAt ?? g.dispatches[0]?.startedAt;
              const expanded = activeGroupId === g.id;
              return (
                <div
                  key={g.id}
                  className="shrink-0 rounded-lg border border-white/[0.06] bg-white/[0.015]"
                >
                  <button
                    type="button"
                    onClick={() => setExpandedGroupId(expanded ? '' : g.id)}
                    className="flex w-full items-center gap-2 px-2 py-1.5 text-left hover:bg-white/[0.03]"
                  >
                    {expanded ? (
                      <ChevronDown className="h-3.5 w-3.5 shrink-0 text-neutral-500" />
                    ) : (
                      <ChevronRight className="h-3.5 w-3.5 shrink-0 text-neutral-500" />
                    )}
                    <span
                      className="min-w-0 flex-1 truncate text-xs font-medium text-neutral-200"
                      title={title ?? undefined}
                    >
                      {title ?? ''}
                    </span>
                    {g.preSession && (
                      <Badge className="shrink-0 bg-sky-900/40 text-sky-300">
                        {t('tasks.groupPreSession')}
                      </Badge>
                    )}
                    {g.open && (
                      <Badge className="shrink-0 bg-amber-900/40 text-amber-300">
                        {t('tasks.groupOpen')}
                      </Badge>
                    )}
                    {g.subagentStops > 0 && (
                      <Badge className="shrink-0 bg-purple-900/40 text-purple-300">
                        {t('tasks.groupSubagent', { n: g.subagentStops })}
                      </Badge>
                    )}
                    {timeIso && (
                      <span className="shrink-0 text-[10px] text-neutral-500">
                        {formatTime(timeIso)}
                      </span>
                    )}
                    <span className="shrink-0 text-[10px] text-neutral-500">
                      {t('tasks.events', { n: g.events.length })}
                    </span>
                    <span className="shrink-0 text-[10px] text-neutral-500">
                      {t('tasks.groupDispatches', { n: g.dispatches.length })}
                    </span>
                    <Badge className="shrink-0 bg-neutral-800 text-neutral-400">
                      {t(STATUS_KEY[statuses.get(selectedId) ?? 'idle'])}
                    </Badge>
                  </button>
                  {expanded && (
                    <div className="h-[420px] shrink-0 border-t border-white/[0.06] p-1.5">
                      {/* 合体形态：该 prompt 的思维导图即事件链——层级 =
                          prompt → hook 事件（subagent 分型）→ 命中规则 → 处理器 →
                          派发结果（箭头流动动效），逐级点开。 */}
                      <div className="relative h-full rounded-md border border-white/[0.04] bg-neutral-950/40">
                        <LifecycleMindmap
                          key={`${selectedId}:${g.id}`}
                          projectId={projectId}
                          sessionId={selectedId}
                          focusGroupId={g.id}
                        />
                        <p className="pointer-events-none absolute bottom-1 left-2 text-[10px] text-neutral-700">
                          {t('tasks.legendNote')}
                        </p>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* 拖拽执行确认 */}
      {pendingRun && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="w-80 rounded-lg border border-white/[0.1] bg-neutral-900 p-4 shadow-xl">
            <p className="text-sm text-neutral-200">
              {t('hooks.runConfirm', {
                id: pendingRun.dispatchId,
                session: pendingRun.sessionLabel,
              })}
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setPendingRun(null)}
                className="rounded-md px-3 py-1.5 text-xs text-neutral-400 hover:bg-white/[0.06]"
              >
                {t('hooks.cancel')}
              </button>
              <button
                type="button"
                onClick={() => void confirmRun()}
                className="rounded-md bg-blue-600/80 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500"
              >
                {t('hooks.runConfirmYes')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
