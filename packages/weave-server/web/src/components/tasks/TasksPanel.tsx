import { useCallback, useEffect, useMemo, useState } from 'react';
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
import { buildSessionChain } from './build-session-chain';
import {
  buildLifecycleGroups,
  ORPHAN_GROUP_ID,
  type LifecycleGroup,
} from './build-lifecycle-groups';
import { HARNESS_LIFECYCLE } from './lifecycle';
import { SessionFlowCanvas } from './SessionFlowCanvas';
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

function LegendDot({ className, label }: { className: string; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <span className={`h-2 w-2 rounded-full ${className}`} />
      {label}
    </span>
  );
}

/**
 * 默认展开组：最新组（events 是 D6 最新窗口，末组数据最完整；orphan 垫底无
 * 事件不作默认，全 orphan 时取首组）。未手动点过则跟随最新——新开 turn 时
 * 自动切过去；一旦点击即固定该组（同会话切组保持）。
 */
function defaultGroupId(groups: LifecycleGroup[]): string | null {
  for (let i = groups.length - 1; i >= 0; i--) {
    if (groups[i]!.id !== ORPHAN_GROUP_ID) return groups[i]!.id;
  }
  return groups[0]?.id ?? null;
}

/**
 * 任务视图容器（项目级两栏）：左 = 会话列表（状态/计数/改名/拖拽目标），
 * 右 = 选中会话的分组组头列表 + 单组事件链画布（D8 accordion，每组一图）。
 * SSE（App 转发的 weave:hook 帧）驱动：500ms 防抖 refetch + overlay 即时状态 +
 * 边脉冲/注入波纹动效。
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
  /** 正在脉冲的边 id（rule.matched，500ms）。 */
  const [pulseEdgeId, setPulseEdgeId] = useState<string | null>(null);
  /** 正在波纹的派发 id（dispatch.created status=injected，900ms）。 */
  const [rippleId, setRippleId] = useState<number | null>(null);
  /** 展开组：null = 自动跟随最新组，'' = 用户全部折叠，其余 = 固定该组。 */
  const [expandedGroupId, setExpandedGroupId] = useState<string | null>(null);

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

  // 切会话：展开态重置回默认（跟随最新组）；同会话内切组由点击驱动保持。
  useEffect(() => {
    setExpandedGroupId(null);
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
        case 'rule.matched': {
          if (f.ruleId && f.eventId) {
            setPulseEdgeId(`e:ev${f.eventId}->rule:${f.ruleId}`);
            timers.push(window.setTimeout(() => setPulseEdgeId(null), 500));
          }
          break;
        }
        case 'dispatch.created': {
          if (f.status === 'injected' && f.dispatchId) {
            setRippleId(f.dispatchId);
            timers.push(window.setTimeout(() => setRippleId(null), 900));
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
  const groups = useMemo(
    () =>
      selectedId
        ? buildLifecycleGroups(
            events,
            dispatchBySession.get(selectedId) ?? [],
            HARNESS_LIFECYCLE.claude,
          )
        : [],
    [selectedId, events, dispatchBySession],
  );

  const activeGroupId = useMemo(() => {
    if (!groups.length) return null;
    if (expandedGroupId === '') return null; // 用户全部折叠
    if (expandedGroupId !== null && groups.some((g) => g.id === expandedGroupId)) {
      return expandedGroupId;
    }
    return defaultGroupId(groups);
  }, [groups, expandedGroupId]);

  const activeGroup = groups.find((g) => g.id === activeGroupId) ?? null;

  const chain = useMemo(() => {
    if (!selectedId || !activeGroup) return { nodes: [], edges: [], truncated: false };
    const graph = buildSessionChain({
      events: activeGroup.events,
      dispatches: activeGroup.dispatches,
      rules,
    });
    return {
      truncated: graph.truncated,
      edges: graph.edges.map((e) =>
        e.id === pulseEdgeId ? { ...e, className: 'weave-edge-flash' } : e,
      ),
      nodes: graph.nodes.map((n) =>
        n.type === 'dispatch' && n.data.dispatch?.id === rippleId
          ? { ...n, data: { ...n.data, ripple: true } }
          : n,
      ),
    };
  }, [selectedId, activeGroup, rules, pulseEdgeId, rippleId]);

  const onRename = async (sessionId: string, title: string): Promise<void> => {
    try {
      await api.renameSession(sessionId, title);
      await refreshSessions();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
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
          {chain.truncated && (
            <Badge className="bg-amber-900/40 text-amber-300">
              {t('tasks.chainTruncated', { n: chain.nodes.filter((n) => n.type === 'event').length })}
            </Badge>
          )}
          <span className="ml-auto flex items-center gap-2 text-[10px] text-neutral-600">
            <LegendDot className="bg-blue-400" label={t('tasks.legendEvent')} />
            <LegendDot className="bg-blue-500" label={t('tasks.legendRule')} />
            <LegendDot className="bg-purple-400" label={t('tasks.legendHandler')} />
            <LegendDot className="bg-neutral-400" label={t('tasks.legendDispatch')} />
          </span>
        </div>
        {!selectedId ? (
          <p className="flex min-h-0 flex-1 items-center justify-center text-xs text-neutral-600">
            {t('tasks.selectHint')}
          </p>
        ) : groups.length === 0 ? (
          <p className="flex min-h-0 flex-1 items-center justify-center text-xs text-neutral-600">
            {t('tasks.chainEmpty')}
          </p>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto pr-1">
            {groups.map((g) => {
              const title =
                g.prompt ??
                (g.preSession || g.id === ORPHAN_GROUP_ID
                  ? null
                  : g.events[0]?.eventType ?? g.id);
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
                    {g.id === ORPHAN_GROUP_ID && (
                      <Badge className="shrink-0 bg-neutral-800 text-neutral-300">
                        {t('tasks.groupOrphan')}
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
                      {chain.nodes.length === 0 ? (
                        <p className="flex h-full items-center justify-center text-xs text-neutral-600">
                          {t('tasks.chainEmpty')}
                        </p>
                      ) : (
                        <div className="relative h-full rounded-md border border-white/[0.04] bg-neutral-950/40">
                          <SessionFlowCanvas
                            nodes={chain.nodes}
                            edges={chain.edges}
                            viewKey={`${selectedId}:${g.id}`}
                            emptyHint={t('tasks.chainEmpty')}
                          />
                          {/* log 规则命中不落库的图例缺口说明 */}
                          <p className="pointer-events-none absolute bottom-1 left-2 text-[10px] text-neutral-700">
                            {t('tasks.legendNote')}
                          </p>
                        </div>
                      )}
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
