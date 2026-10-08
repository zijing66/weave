import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type HookDispatch, type HookEventRow, type HookRule } from '@/lib/api';
import { useT } from '@/i18n/I18nProvider';
import { Badge } from '@/components/ui/badge';
import { formatTime, sessionLabel } from '@/lib/hook-payload';
import { SessionList } from './SessionList';
import {
  buildLifecycleGroups,
  ORPHAN_GROUP_ID,
} from './build-lifecycle-groups';
import { HARNESS_LIFECYCLE } from './lifecycle';
import { LifecycleMindmap } from '@/components/LifecycleMindmap';
import { HarnessIcon } from './HarnessIcon';
import { useSessionStatus, type HookFrame } from './session-status-store';
import { Activity, Check, ChevronDown, ChevronRight, Copy, Loader2 } from 'lucide-react';
import { useToast } from '@/components/Toast';
import { errorText, useActionFeedback } from '@/lib/action-feedback';

/**
 * 任务视图容器（项目级两栏）：左 = 会话列表（状态/计数/改名/拖拽目标），
 * 右 = 选中会话的分组组头列表（滚动窗口：默认最新 10 条、向上滚动加载更早）
 * + 单组合体事件链画布（默认全折叠，点击展开才按需挂载导图）。
 * 会话列表与状态来自全局状态总线（SessionStatusProvider）；本面板只自管事件链
 * 明细：SSE（App 转发的 weave:hook 帧）驱动选中会话的事件按需刷新。
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
  const { show } = useToast();
  const fb = useActionFeedback();
  const { sessions: allSessions, dispatches, statuses, refresh: refreshStatus } = useSessionStatus();
  const [rules, setRules] = useState<HookRule[]>([]);
  const [events, setEvents] = useState<HookEventRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingRun, setPendingRun] = useState<{
    dispatchId: number;
    sessionId: string;
    sessionLabel: string;
  } | null>(null);
  /** 展开组：'' = 默认全折叠（画布点击才按需挂载），其余 = 固定该组。 */
  const [expandedGroupId, setExpandedGroupId] = useState<string>('');
  /** 组头列表滚动窗口：默认最新 10 条，向上滚动/点击加载更早（折叠条级）。 */
  const [groupWindow, setGroupWindow] = useState(10);
  /** 事件游标已翻到最早（最新窗口不满一条完整批，或更早批次拉空）。 */
  const [olderExhausted, setOlderExhausted] = useState(false);
  const scrollThrottle = useRef<number | null>(null);

  /** 本项目会话：总线全量列表按 projectId 过滤（null = 首次加载中，沿用总线状态）。 */
  const sessions = useMemo(
    () => (allSessions === null ? null : allSessions.filter((s) => s.projectId === projectId)),
    [allSessions, projectId],
  );

  const refreshEvents = useCallback(
    async (sessionId: string) => {
      try {
        const list = await api.listSessionHooks(projectId, sessionId);
        setEvents(list);
        // 最新窗口不满一整批 = 已是该会话最早的事件，无需再翻页。
        setOlderExhausted(list.length < 300);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [projectId],
  );

  useEffect(() => {
    setSelectedId(initialSessionId ?? null);
    setEvents([]);
    api.listHooksRules(projectId).then(setRules).catch(() => {});
  }, [projectId, initialSessionId]);

  // 会话列表就绪后补默认选中（初始选中会话优先；用户点击后 prev 非空，不再覆盖）。
  useEffect(() => {
    setSelectedId((prev) => prev ?? sessions?.[0]?.sessionId ?? null);
  }, [sessions]);

  useEffect(() => {
    if (selectedId) void refreshEvents(selectedId);
  }, [selectedId, refreshEvents]);

  // 切会话：全折叠 + 窗口重置回最新 10 条（画布按需点开）。
  useEffect(() => {
    setExpandedGroupId('');
    setGroupWindow(10);
  }, [selectedId]);

  // ---- SSE：App 转发的 weave:hook 帧（不新开 EventSource）----
  // 会话状态、会话行计数、派发列表都由全局状态总线按同一批帧维护；本面板只
  // 按需刷新选中会话的事件链（总线的防抖 refetch 会把派发/会话行一并带上）。
  useEffect(() => {
    let refreshTimer: number | null = null;
    const onHook = (e: Event): void => {
      const f = (e as CustomEvent<HookFrame>).detail ?? {};
      if (!selectedId || f.sessionId !== selectedId) return;
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null;
        void refreshEvents(selectedId);
      }, 500);
    };
    window.addEventListener('weave:hook', onHook);
    return () => {
      window.removeEventListener('weave:hook', onHook);
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
    };
  }, [refreshEvents, selectedId]);

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
            // 头部截断未翻完时，preSession 组是上一 turn 尾巴的窗口伪影
            //（「会话引导」名不副实）——翻到底（exhausted）后才是真会话引导。
            .filter((g) => !(g.preSession && !olderExhausted))
        : [],
    [selectedId, events, dispatchBySession, olderExhausted],
  );

  const activeGroupId = useMemo(() => {
    if (expandedGroupId && groups.some((g) => g.id === expandedGroupId)) {
      return expandedGroupId;
    }
    return null; // 默认全折叠：画布点击展开才按需挂载
  }, [groups, expandedGroupId]);

  const onRename = async (sessionId: string, title: string): Promise<void> => {
    try {
      const row = await api.renameSession(sessionId, title);
      // 实际更名校验：服务器确认挂起（pendingTitle）或已直接生效（title），
      // 两者都不匹配 = 写入未落地——明确报错而不是静默显示「待生效」。
      if (row.pendingTitle !== title && row.title !== title) {
        setError(t('tasks.renameVerifyFail'));
        return;
      }
      await refreshStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  /** 在默认终端打开会话：服务端 detached spawn（`claude --resume <id>`），
      独立进程不随 daemon 退出；失败走行内错误条。 */
  const onOpenTerminal = async (sessionId: string): Promise<void> => {
    try {
      await api.openSessionTerminal(sessionId);
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
      await refreshStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // 组头列表滚动窗口（折叠条级）：**倒序**（最新组在顶），更早的向列表底部
  // 方向滚——触底自动加载：先扩渲染窗口（10 条/批），组已全渲染且事件游标
  // 还能往前时改拉更早事件（beforeId 翻页，前缀拼接）。
  const shownGroups = groups.slice(-groupWindow).reverse();
  const olderRemaining = groups.length - shownGroups.length;
  const canLoadOlderEvents = !olderExhausted && events.length > 0;
  const hasOlder = olderRemaining > 0 || canLoadOlderEvents;
  const atListEnd = (el: HTMLElement): boolean =>
    el.scrollHeight - el.scrollTop - el.clientHeight <= 8;
  const loadOlderGroups = async (): Promise<void> => {
    if (olderRemaining > 0) {
      setGroupWindow((w) => w + 10);
      return;
    }
    if (!canLoadOlderEvents || !selectedId) return;
    try {
      const older = await api.listSessionHooks(projectId, selectedId, 300, events[0]?.id);
      if (older.length === 0) {
        setOlderExhausted(true);
        return;
      }
      // 去重：旧版 daemon 忽略 beforeId 返回重复窗口时按 id 收敛（幂等）。
      const seen = new Set(events.map((x) => x.id));
      const fresh = older.filter((x) => !seen.has(x.id));
      if (fresh.length === 0) {
        setOlderExhausted(true);
        return;
      }
      if (older.length < 300) setOlderExhausted(true);
      setEvents((prev) => {
        const ids = new Set(prev.map((x) => x.id));
        return [...older.filter((x) => !ids.has(x.id)), ...prev];
      });
      setGroupWindow((w) => w + 10);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const throttleLoad = (): void => {
    const now = Date.now();
    if (scrollThrottle.current && now - scrollThrottle.current < 600) return;
    scrollThrottle.current = now;
    void loadOlderGroups();
  };
  const onListScroll = (e: React.UIEvent<HTMLDivElement>): void => {
    if (!hasOlder || !atListEnd(e.currentTarget)) return;
    throttleLoad();
  };
  /** 触底后继续下滚：内容不再位移 → scroll 不再触发，须由 wheel 补触发。 */
  const onListWheel = (e: React.WheelEvent<HTMLDivElement>): void => {
    if (!hasOlder || e.deltaY <= 0 || !atListEnd(e.currentTarget)) return;
    throttleLoad();
  };

  // 自动补拉：默认承诺「最新 10 条」——头部截断导致窗口内真组不足 10 时，
  // 静默向前翻页直到凑满或翻到底（通常一批 300 事件即够）。
  useEffect(() => {
    if (!selectedId || olderExhausted || events.length === 0) return;
    if (groups.length >= 10) return;
    void loadOlderGroups();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, groups.length, olderExhausted, events.length]);

  const onDropDispatch = (dispatchId: number, sessionId: string): void => {
    const session = (sessions ?? []).find((s) => s.sessionId === sessionId);
    setPendingRun({
      dispatchId,
      sessionId,
      sessionLabel: sessionLabel(session?.title ?? null, sessionId),
    });
  };

  /** 折叠条复制 prompt：复制该组开组 prompt 原文（1.5s 换 ✓ 反馈）。 */
  const [copiedGroupId, setCopiedGroupId] = useState<string | null>(null);
  const copyGroupPrompt = (g: { id: string; prompt?: string }): void => {
    if (!g.prompt) return;
    void navigator.clipboard.writeText(g.prompt).then(() => {
      setCopiedGroupId(g.id);
      window.setTimeout(() => setCopiedGroupId(null), 1500);
    });
  };

  const confirmRun = async (): Promise<void> => {
    if (!pendingRun) return;
    try {
      await api.runHookDispatch(pendingRun.dispatchId, pendingRun.sessionId);
      await refreshStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPendingRun(null);
    }
  };

  /** 删会话（手动）：确认 → 删（连带事件与派发）→ 刷新列表 → toast。
   *  删掉的若是当前选中项，一并清选择，避免右栏挂在已消失的会话上。 */
  const handleDeleteSession = useCallback(
    (sessionId: string) => {
      const row = sessions?.find((s) => s.sessionId === sessionId);
      const label = row ? sessionLabel(row.title, row.sessionId) : sessionId.slice(0, 8);
      if (!window.confirm(t('tasks.deleteConfirm', { id: label }))) return;
      void fb.run(
        `del:${sessionId}`,
        async () => {
          const res = await api.deleteSession(sessionId);
          if (selectedId === sessionId) setSelectedId(null);
          await refreshStatus();
          show('success', t('toast.sessionDeleted', { n: res.events }));
        },
        { fail: (e) => t('tasks.deleteFailed', { error: errorText(e) }) },
      );
    },
    [sessions, t, fb, selectedId, refreshStatus, show],
  );

  const deleteStateOf = useCallback((sessionId: string) => fb.stateOf(`del:${sessionId}`), [fb]);

  // 组头状态展示：运行中显示 harness 跑马灯动效图标，打开/关闭/失败不显示
  // ——去掉原文字状态 tag（会话状态与组头信息重复）。
  const activeStatus = statuses.get(selectedId ?? '') ?? 'open';
  const selectedHarness = sessions?.find((s) => s.sessionId === selectedId)?.harness ?? null;

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
            onClick={() => void refreshStatus()}
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
            onOpenTerminal={(id) => void onOpenTerminal(id)}
            onDelete={handleDeleteSession}
            deleteStateOf={deleteStateOf}
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
                          {sessionLabel(s.title, s.sessionId)}
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
          /* 事件区域：relative 外壳——遮罩 absolute 固定在区域底边（不随滚动
              流），内层滚动列表 flex-1 撑满可用高度 */
          <div className="relative flex min-h-0 flex-1 flex-col">
            <div
              className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto pr-1"
              onScroll={onListScroll}
              onWheel={onListWheel}
            >
            {shownGroups.map((g) => {
              const title = g.prompt ?? (g.preSession ? null : g.events[0]?.eventType ?? g.id);
              const lastEvent = g.events[g.events.length - 1];
              const timeIso = lastEvent?.createdAt ?? g.dispatches[0]?.startedAt;
              const expanded = activeGroupId === g.id;
              // 进行中 = **只有最新组**且未 Stop（g.open）且会话活跃——历史组
              // 无论 open 与否都不再亮（旧组 open 是中断，不是进行中）。
              const isLatestGroup = groups.length > 0 && g.id === groups[groups.length - 1]!.id;
              return (
                <div
                  key={g.id}
                  className="shrink-0 rounded-lg border border-white/[0.06] bg-white/[0.015]"
                >
                  {/* div role=button：内嵌复制按钮（button 嵌套 button 非法） */}
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => setExpandedGroupId(expanded ? '' : g.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setExpandedGroupId(expanded ? '' : g.id);
                      }
                    }}
                    className="flex w-full cursor-pointer items-center gap-2 px-2 py-1.5 text-left hover:bg-white/[0.03]"
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
                    {g.agentsDispatched > 0 && (
                      <Badge className="shrink-0 bg-fuchsia-900/40 text-fuchsia-300">
                        {t('tasks.groupAgents', { n: g.agentsDispatched })}
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
                    {g.prompt && (
                      <button
                        type="button"
                        title={copiedGroupId === g.id ? t('tasks.copied') : t('tasks.copyPrompt')}
                        onClick={(e) => {
                          e.stopPropagation();
                          copyGroupPrompt(g);
                        }}
                        className="shrink-0 rounded p-0.5 text-neutral-500 transition-colors hover:bg-white/[0.08] hover:text-neutral-200"
                      >
                        {copiedGroupId === g.id ? (
                          <Check className="h-3 w-3 text-emerald-400" />
                        ) : (
                          <Copy className="h-3 w-3" />
                        )}
                      </button>
                    )}
                    {(isLatestGroup && g.open && activeStatus === 'running') && (
                      <span className="shrink-0">
                        <HarnessIcon harness={selectedHarness} running />
                      </span>
                    )}
                  </div>
                  {expanded && (
                    <div className="h-[calc(100vh-330px)] min-h-[420px] max-h-[760px] shrink-0 border-t border-white/[0.06] p-1.5">
                      {/* 画布撑满事件区域可用高度（随视口），不再固定 420px；
                          合体形态 = 该 prompt 的思维导图即事件链，逐级点开。 */}
                      <div className="relative h-full rounded-md border border-white/[0.04] bg-neutral-950/40">
                        <LifecycleMindmap
                          key={`${selectedId}:${g.id}`}
                          projectId={projectId}
                          sessionId={selectedId}
                          focusGroupId={g.id}
                          focusGroup={g}
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
            {/* 底部渐变遮罩：absolute 固定在事件区域底边（不占滚动流）——
                倒序列表（最新在顶），更早 prompt 向底部滚触底自动加载 */}
            {hasOlder && (
              <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-neutral-950/95 via-neutral-950/70 to-transparent px-1 pb-1 pt-6 text-center">
                <p className="text-[10px] text-neutral-500">{t('tasks.olderHint')}</p>
                <span className="pointer-events-auto mt-1 inline-flex gap-2">
                  <button
                    type="button"
                    onClick={() => void loadOlderGroups()}
                    className="rounded-md border border-white/[0.1] bg-neutral-900/90 px-2 py-0.5 text-[11px] text-neutral-200 transition-colors hover:bg-neutral-800"
                  >
                    {olderRemaining > 0
                      ? t('tasks.loadOlder', { n: Math.min(10, olderRemaining) })
                      : t('tasks.loadOlderEvents')}
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
