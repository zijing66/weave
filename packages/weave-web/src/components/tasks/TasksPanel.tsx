import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  api,
  type HookDispatch,
  type HookEventRow,
  type HookRule,
  type SessionRow,
} from '@/lib/api';
import { useT } from '@/i18n/I18nProvider';
import { SessionList } from './SessionList';
import { deriveSessionStatus, type SessionStatus } from './session-status';
import { Activity, Loader2 } from 'lucide-react';

/**
 * 任务视图容器（项目级两栏）：左 = 会话列表（状态/计数/改名/拖拽目标），
 * 右 = 选中会话的事件链画布（批 2 落地，当前为占位空态）。
 * 批 1 为静态状态推导；SSE 实时化在批 3。
 */
export function TasksPanel({ projectId }: { projectId: number }) {
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
    setSelectedId(null);
    setEvents([]);
    void refreshSessions();
    void refreshDispatches();
    api.listHooksRules(projectId).then(setRules).catch(() => {});
  }, [projectId, refreshSessions, refreshDispatches]);

  useEffect(() => {
    if (selectedId) void refreshEvents(selectedId);
  }, [selectedId, refreshEvents]);

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
        }),
      );
    }
    return map;
  }, [sessions, dispatchBySession, events, selectedId]);

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

      {/* 右栏：事件链画布（批 2 落地） */}
      <section className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 pb-2">
          <Activity className="h-3.5 w-3.5 text-rose-400" />
          <h3 className="text-sm font-semibold text-neutral-200">{t('tasks.chainTitle')}</h3>
        </div>
        <div className="flex min-h-0 flex-1 items-center justify-center rounded-lg border border-white/[0.06] bg-neutral-950/40">
          {!selectedId ? (
            <p className="text-xs text-neutral-600">{t('tasks.selectHint')}</p>
          ) : events.length === 0 ? (
            <p className="text-xs text-neutral-600">{t('tasks.chainEmpty')}</p>
          ) : (
            <p className="text-xs text-neutral-600">
              {t('tasks.chainTitle')} · {events.length} · rules {rules.length}
            </p>
          )}
        </div>
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
