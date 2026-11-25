import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Input } from '../ui/input';
import { api, type HookEventRow, type HookRule } from '@/lib/api';
import { useT } from '@/i18n/I18nProvider';
import { subscribeHook, type HookFrame } from '@/lib/sse';
import { HARNESS_ORDER } from '@/lib/harness-meta';
import { Badge } from '@/components/ui/badge';
import { Combobox } from '@/components/ui/combobox';
import { formatTime, sessionLabel } from '@/lib/hook-payload';
import {
  buildLifecycleGroups,
  ORPHAN_GROUP_ID,
} from './build-lifecycle-groups';
import { HARNESS_LIFECYCLE } from './lifecycle';
import { canInterrupt, hasTurnSignal, isSessionBusy } from './session-status';
import { LifecycleMindmap } from '@/components/LifecycleMindmap';
import { HarnessIcon } from './HarnessIcon';
import { useSessionStatus } from './session-status-store';
import {
  Activity,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Loader2,
  Search,
  Square,
  X,
} from 'lucide-react';
import { useToast } from '@/components/Toast';
import { FeedbackIcon } from '@/components/FeedbackIcon';
import { Tooltip } from '@/components/ui/tooltip';
import { errorText, useActionFeedback } from '@/lib/action-feedback';
import { copyText } from '@/lib/clipboard';
import { usePullLoad } from '@/lib/pull-load';
import { windowGroups } from './TasksPanel';
import { QuestionAnswer } from './QuestionAnswer';

/**
 * 事件链面板（会话级、数据自持）：事件拉取与拉动加载、SSE 帧驱动的防抖刷新、
 * 分组与搜索、待派发区、停止/作答——生命周期随挂载它的对话窗。主窗（inline 与
 * 链弹窗）与弹出窗共用同一份组件；数据来自全局会话状态总线（弹出窗 = 共享账），
 * 本组件不再自拼会话行判据。
 */
export function SessionChainPanel({ sessionId, projectId }: { sessionId: string; projectId: number }) {
  const t = useT();
  const fb = useActionFeedback();
  const { show } = useToast();
  const { sessions, statuses, questions, dispatches, refresh: refreshStatus } = useSessionStatus();
  const [, setError] = useState<string | null>(null);
  const [events, setEvents] = useState<HookEventRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [rules, setRules] = useState<HookRule[]>([]);
  /** 展开组：'' = 默认全折叠（画布点击才按需挂载），其余 = 固定该组。 */
  const [expandedGroupId, setExpandedGroupId] = useState<string>('');
  /** 组头列表滚动窗口：默认最新 10 条，向上滚动/点击加载更早（折叠条级）。 */
  const [groupWindow, setGroupWindow] = useState(10);
  /** 折叠条搜索：按组头可见文字过滤（开组 prompt 为主）；空串 = 不过滤。 */
  const [search, setSearch] = useState('');
  /** 事件游标已翻到最早（最新窗口不满一条完整批，或更早批次拉空）。 */
  const [olderExhausted, setOlderExhausted] = useState(false);
  /** 事件链滚动列表（拉动加载要现读它的位置）。 */
  const listRef = useRef<HTMLDivElement | null>(null);

  const row = sessions?.find((s) => s.sessionId === sessionId) ?? null;
  const status = statuses.get(sessionId) ?? 'open';
  const harness = row?.harness ?? null;
  const lifecycle = HARNESS_LIFECYCLE[harness ?? HARNESS_ORDER[0] ?? 'claude'];
  const entry = questions.get(sessionId) ?? null;
  const [answerOpen, setAnswerOpen] = useState(false);

  const refreshEvents = useCallback(async () => {
    setLoading(true);
    try {
      const list = await api.listSessionHooks(projectId, sessionId);
      // SSE 刷新只替换「最新窗口」尾部，保留已向前翻到的更早批次——否则长 turn
      // 把窗口截成尾巴时，补拉永远被下一条 hook 帧打回原点、收不了敛。
      setEvents((prev) => {
        if (prev.length === 0) return list;
        const head = list[0]?.id ?? Number.POSITIVE_INFINITY;
        return [...prev.filter((x) => x.id < head), ...list];
      });
      // 已翻到最早后不再被满批窗口「复活」；不满一批 = 确实到头。
      setOlderExhausted((was) => was || list.length < 300);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [projectId, sessionId]);

  useEffect(() => {
    setEvents([]);
    setOlderExhausted(false);
    setExpandedGroupId('');
    setGroupWindow(10);
    setSearch('');
    void refreshEvents();
  }, [refreshEvents]);

  // 本会话的 hook 帧 → 防抖刷新事件链（只认自己 sessionId，不因别的会话抖动）。
  useEffect(() => {
    let refreshTimer: number | null = null;
    const onHook = (f: HookFrame): void => {
      if (f.sessionId !== sessionId) return;
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null;
        void refreshEvents();
      }, 500);
    };
    return subscribeHook(onHook);
  }, [refreshEvents, sessionId]);

  useEffect(() => {
    api.listHooksRules(projectId).then(setRules).catch(() => {});
  }, [projectId]);

  const dispatchBySession = useMemo(() => {
    const m = new Map<string, (typeof dispatches)[number][]>();
    for (const d of dispatches) {
      if (!d.sessionId) continue;
      const list = m.get(d.sessionId) ?? [];
      list.push(d);
      m.set(d.sessionId, list);
    }
    return m;
  }, [dispatches]);

  const groups = useMemo(
    () =>
      buildLifecycleGroups(events, dispatchBySession.get(sessionId) ?? [], lifecycle)
        .filter((g) => g.id !== ORPHAN_GROUP_ID)
        // 头部截断未翻完时，preSession 组是上一 turn 尾巴的窗口伪影——翻到底后才是真会话引导。
        .filter((g) => !(g.preSession && !olderExhausted)),
    [events, dispatchBySession, sessionId, olderExhausted, lifecycle],
  );

  const activeGroupId = useMemo(() => {
    if (expandedGroupId && groups.some((g) => g.id === expandedGroupId)) return expandedGroupId;
    return null; // 默认全折叠：画布点击展开才按需挂载
  }, [groups, expandedGroupId]);

  /** 折叠条搜索：按组头可见文字（开组 prompt，缺失回落首事件类型）过滤。 */
  const query = search.trim().toLowerCase();
  const matchedGroups = useMemo(() => {
    if (!query) return null;
    return groups.filter(
      (g) => (g.prompt ?? (g.preSession ? '' : g.events[0]?.eventType ?? '')).toLowerCase().includes(query),
    );
  }, [groups, query]);

  /** 待派发清单：未投送的 pending 指令，且规则作用于本项目（本项目+全局规则）。 */
  const pendingToDispatch = useMemo(
    () =>
      dispatches.filter(
        (d) => d.status === 'pending' && d.sessionId === null && rules.some((r) => r.id === d.ruleId),
      ),
    [dispatches, rules],
  );
  /** 待派发行的目标会话（缺省 = 最近活跃会话）。 */
  const [assign, setAssign] = useState<Record<number, string>>({});
  const runDispatch = useCallback(
    (dispatchId: number, target: string): void => {
      void fb.run(
        `dispatch:${dispatchId}`,
        async () => {
          await api.runHookDispatch(dispatchId, target);
          await refreshStatus();
        },
        { fail: (e) => t('tasks.dispatchRunFailed', { error: errorText(e) }) },
      );
    },
    [fb, refreshStatus, t],
  );

  // 组头列表滚动窗口（折叠条级）：**倒序**（最新组在顶），更早的向列表底部滚触底加载。
  const shownGroups = matchedGroups
    ? matchedGroups.slice().reverse()
    : windowGroups(groups, groupWindow, expandedGroupId).slice().reverse();
  const olderRemaining = groups.length - shownGroups.length;
  const canLoadOlderEvents = !olderExhausted && events.length > 0;
  const hasOlder = olderRemaining > 0 || canLoadOlderEvents;
  const atListEnd = (el: HTMLElement | null): boolean =>
    !!el && el.scrollHeight - el.scrollTop - el.clientHeight <= 1;
  const loadOlderGroups = async (): Promise<void> => {
    if (olderRemaining > 0) {
      setGroupWindow((w) => w + 10);
      return;
    }
    if (!canLoadOlderEvents) return;
    try {
      const older = await api.listSessionHooks(projectId, sessionId, 300, events[0]?.id);
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
  /** 拉动加载（向下那头）：触底后继续滚/拖才取更早，且一拉只取一批。 */
  const pull = usePullLoad({
    axis: 'bottom',
    getEdge: () => atListEnd(listRef.current),
    onFire: () => void loadOlderGroups(),
    enabled: hasOlder,
  });

  // 自动补拉：默认承诺「最新 10 条」——头部截断导致窗口内真组不足 10 时静默向前翻页。
  useEffect(() => {
    if (olderExhausted || events.length === 0) return;
    if (groups.length >= 10) return;
    void loadOlderGroups();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, groups.length, olderExhausted, events.length]);

  // 搜索态自动前翻：折叠条搜索须覆盖整条会话——query 非空时先扩满渲染窗口再逐批拉。
  useEffect(() => {
    if (!query || olderExhausted || events.length === 0) return;
    if (groups.length > groupWindow) {
      setGroupWindow(groups.length);
      return;
    }
    const timer = window.setTimeout(() => {
      void loadOlderGroups();
    }, 250);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, olderExhausted, events.length, groups.length, groupWindow]);

  /** 折叠条复制 prompt：复制该组开组 prompt 原文（1.5s 换 ✓ 反馈）。 */
  const [copiedGroupId, setCopiedGroupId] = useState<string | null>(null);
  const copyGroupPrompt = (g: { id: string; prompt?: string }): void => {
    if (!g.prompt) return;
    void copyText(g.prompt).then((ok) => {
      if (!ok) {
        show('error', t('common.copyFailed'));
        return;
      }
      setCopiedGroupId(g.id);
      window.setTimeout(() => setCopiedGroupId(null), 1500);
    });
  };

  /** 停止按钮露不露：回合开合信号不可信的 harness 传 undefined 让判据回落到状态。 */
  const stoppable = canInterrupt(status, hasTurnSignal(row?.harness) ? row?.turnOpen : undefined);
  const onInterrupt = (): void => {
    void fb.run(
      `interrupt:${sessionId}`,
      async () => {
        await api.interruptSession(sessionId);
      },
      { fail: (e) => t('tasks.stopFail', { error: errorText(e) }) },
    );
  };

  return (
    <section className="flex min-w-0 min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 pb-2">
        <Activity className="h-3.5 w-3.5 shrink-0 text-rose-400" />
        <h3 className="shrink-0 text-sm font-semibold text-neutral-200">{t('tasks.chainTitle')}</h3>
        <div className="relative w-36 shrink-0 lg:w-44">
          <Search className="pointer-events-none absolute left-1.5 top-1/2 h-3 w-3 -translate-y-1/2 text-neutral-600" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('tasks.searchPlaceholder')}
            className="h-6 w-full rounded border border-edge/[0.08] bg-neutral-900 pl-6 pr-5 text-11 text-neutral-200 placeholder:text-neutral-600 focus:border-edge/20 focus:outline-none"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch('')}
              className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-0.5 text-neutral-600 transition-colors hover:text-neutral-200"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
        {matchedGroups && (
          <span className="shrink-0 text-10 text-neutral-500">
            {t('tasks.searchMatches', { n: matchedGroups.length })}
          </span>
        )}
        <span className="ml-auto text-10 text-neutral-600">{t('tasks.legendNote')}</span>
      </div>

      {/* 待派发区：未投送的 pending 指令——选活跃会话后派发（结果在事件链高亮）。
          派发账来自全局状态总线（弹出窗 = 共享账），任一窗派发全窗可见。 */}
      {pendingToDispatch.length > 0 && (
        <div className="mb-2 shrink-0 rounded-lg border border-amber-500/20 bg-amber-500/[0.04] px-2 py-1.5">
          <div className="flex items-center gap-1.5">
            <span className="text-11 font-medium text-amber-300">
              {t('tasks.dispatchQueue', { n: pendingToDispatch.length })}
            </span>
            <span className="text-10 text-amber-200/50">{t('tasks.dispatchHint')}</span>
          </div>
          <ul className="mt-1 space-y-1">
            {pendingToDispatch.map((d) => {
              const target = assign[d.id] ?? sessions?.[0]?.sessionId ?? '';
              return (
                <li key={d.id} className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-11 text-neutral-300" title={d.prompt}>
                    {d.prompt}
                  </span>
                  <Combobox
                    value={target}
                    onChange={(v) => setAssign((prev) => ({ ...prev, [d.id]: v }))}
                    className="shrink-0 rounded bg-neutral-900 px-1.5 py-0.5 text-11"
                    options={(sessions ?? []).map((s) => ({
                      value: s.sessionId,
                      label: sessionLabel(s.title, s.sessionId),
                    }))}
                  />
                  <button
                    type="button"
                    disabled={!target || fb.stateOf(`dispatch:${d.id}`) === 'loading'}
                    onClick={() => runDispatch(d.id, target)}
                    className="inline-flex shrink-0 items-center gap-1 rounded bg-emerald-700/80 px-2 py-0.5 text-11 font-medium text-white transition-colors hover:bg-emerald-600 disabled:opacity-40"
                  >
                    <FeedbackIcon state={fb.stateOf(`dispatch:${d.id}`)} className="h-3 w-3" />
                    {t('tasks.dispatchRun')}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {!sessionId ? (
        <p className="flex min-h-0 flex-1 items-center justify-center text-xs text-neutral-600">
          {t('tasks.selectHint')}
        </p>
      ) : loading && events.length === 0 ? (
        <p className="flex min-h-0 flex-1 items-center justify-center gap-1.5 text-xs text-neutral-600">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {t('hooks.loading')}
        </p>
      ) : events.length === 0 ? (
        <p className="flex min-h-0 flex-1 items-center justify-center text-xs text-neutral-600">
          {t('tasks.chainEmpty')}
        </p>
      ) : groups.length === 0 ? (
        /* 有事件、但最新窗口被长 turn 截成尾巴（没有 prompt 可开组）——正在向
           前补拉更早批次，不得冒充「该会话还没有采集到事件」。 */
        <p className="flex min-h-0 flex-1 items-center justify-center gap-1.5 text-xs text-neutral-600">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {t('tasks.chainCatchUp')}
        </p>
      ) : matchedGroups && matchedGroups.length === 0 ? (
        /* 搜索无命中：更早批次还在补拉时不能断言无匹配（继续转圈），翻到底才落定。 */
        <p className="flex min-h-0 flex-1 items-center justify-center gap-1.5 text-xs text-neutral-600">
          {olderExhausted ? (
            t('tasks.searchNoMatch')
          ) : (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t('tasks.chainCatchUp')}
            </>
          )}
        </p>
      ) : (
        /* 事件区域：relative 外壳——遮罩 absolute 固定在区域底边（不随滚动流），
            内层滚动列表 flex-1 撑满可用高度 */
        <div className="relative flex min-h-0 flex-1 flex-col">
          <div
            ref={listRef}
            className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain pr-1"
            onScroll={pull.syncEdge}
            onWheel={(e) => pull.wheel(e.deltaY, e.deltaMode)}
            onTouchStart={(e) => pull.touchStart(e.touches[0]?.clientY ?? 0)}
            onTouchMove={(e) => pull.touchMove(e.touches[0]?.clientY ?? 0)}
            onTouchEnd={pull.touchEnd}
            onTouchCancel={pull.touchEnd}
          >
            {/* 拉动位移：正文整体往上让位（transform 不进布局） */}
            <div
              className="flex shrink-0 flex-col gap-1"
              style={pull.px > 0 ? { transform: `translateY(-${pull.px}px)` } : undefined}
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
                  <div key={g.id} className="shrink-0 rounded-lg border border-edge/[0.06] bg-edge/[0.015]">
                    {/* div role=button：内嵌复制按钮（button 嵌套 button 非法）。
                        flex-wrap：窄屏一排徽标放不下（手机上加号角标更多），不折行会把
                        最右的复制/停止按钮挤出可视区。 */}
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
                      className="flex w-full flex-wrap cursor-pointer items-center gap-2 px-2 py-1.5 text-left hover:bg-edge/[0.03]"
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
                      {g.open &&
                        (isLatestGroup && isSessionBusy(status) ? (
                          <Badge className="shrink-0 bg-emerald-900/40 text-emerald-300">
                            {t('tasks.groupRunning')}
                          </Badge>
                        ) : (
                          <Badge className="shrink-0 bg-amber-900/40 text-amber-300">
                            {t('tasks.groupOpen')}
                          </Badge>
                        ))}
                      {/* 最新组被挂起（AskUserQuestion/计划/权限确认）：组头亮待答
                          tag，点击即远程作答——与画布根节点 tag、会话行图标同开一弹窗。 */}
                      {isLatestGroup && entry && (
                        <Tooltip label={t('tasks.answerActiveTooltip', {
                          // 不含收尾屏：它不是宿主的问题 tab
                          n: entry.questions.filter((q) => !q.submit).length,
                        })}>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setAnswerOpen(true);
                            }}
                            className="shrink-0 rounded bg-amber-900/50 px-1 py-px text-10 font-medium leading-tight text-amber-300 transition-colors hover:bg-amber-900/70 hover:text-amber-200"
                          >
                            {t('tasks.answerPendingTag')}
                          </button>
                        </Tooltip>
                      )}
                      {g.questions > 0 && (
                        <Badge className="shrink-0 bg-teal-900/40 text-teal-300">
                          {t('tasks.groupQuestions', { n: g.questions })}
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
                        <span className="shrink-0 text-10 text-neutral-500">{formatTime(timeIso)}</span>
                      )}
                      <span className="shrink-0 text-10 text-neutral-500">
                        {t('tasks.events', { n: g.events.length })}
                      </span>
                      <span className="shrink-0 text-10 text-neutral-500">
                        {t('tasks.groupDispatches', { n: g.dispatches.length })}
                      </span>
                      {g.prompt && (
                        <Tooltip label={copiedGroupId === g.id ? t('tasks.copied') : t('tasks.copyPrompt')}>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              copyGroupPrompt(g);
                            }}
                            className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded border border-edge/[0.08] bg-edge/[0.02] text-neutral-500 transition-colors hover:border-edge/[0.16] hover:bg-edge/[0.08] hover:text-neutral-200"
                          >
                            {copiedGroupId === g.id ? (
                              <Check className="h-3 w-3 text-emerald-400" />
                            ) : (
                              <Copy className="h-3 w-3" />
                            )}
                          </button>
                        </Tooltip>
                      )}
                      {isLatestGroup && g.open && isSessionBusy(status) && (
                        <span className="shrink-0">
                          <HarnessIcon harness={harness} running />
                        </span>
                      )}
                      {/* 停止：最新组头（该会话当前那一折）上的会话级动作——回合开着才露。
                          判据唯一实现 = canInterrupt。 */}
                      {isLatestGroup && stoppable && (
                        <Tooltip label={t('tasks.stopTooltip')}>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              onInterrupt();
                            }}
                            className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded border border-edge/[0.08] bg-edge/[0.02] text-neutral-500 transition-colors hover:border-edge/[0.16] hover:bg-edge/[0.08] hover:text-red-300"
                          >
                            <FeedbackIcon
                              state={fb.stateOf(`interrupt:${sessionId}`)}
                              className="h-3 w-3"
                              icon={<Square className="h-3 w-3" />}
                            />
                          </button>
                        </Tooltip>
                      )}
                    </div>
                    {expanded && (
                      <div className="h-[52%] min-h-[280px] lg:h-[calc(100%-330px)] lg:min-h-[420px] max-h-[760px] shrink-0 border-t border-edge/[0.06] p-1.5">
                        {/* 画布撑满事件区域可用高度（随视口），不再固定 420px；
                            合体形态 = 该 prompt 的思维导图即事件链，逐级点开。 */}
                        <div className="relative h-full rounded-md border border-edge/[0.04] bg-neutral-950/40">
                          <LifecycleMindmap
                            key={`${sessionId}:${g.id}`}
                            projectId={projectId}
                            sessionId={sessionId}
                            harness={harness}
                            focusGroupId={g.id}
                            focusGroup={g}
                            running={isLatestGroup && isSessionBusy(status)}
                            answerable={isLatestGroup && !!entry}
                            onOpenAnswer={() => setAnswerOpen(true)}
                          />
                          <p className="pointer-events-none absolute bottom-1 left-2 text-10 text-neutral-600">
                            {t('tasks.legendNote')}
                          </p>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
          {/* 底部渐变遮罩：absolute 固定在事件区域底边（不占滚动流）——
              倒序列表（最新在顶），更早 prompt 向底部滚触底自动加载 */}
          {hasOlder && (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-neutral-950/95 via-neutral-950/70 to-transparent px-1 pb-1 pt-6 text-center">
              <p className="text-10 text-neutral-500">
                {pull.px > 0 ? t('tasks.pullMoreEvents') : t('tasks.olderHint')}
              </p>
              <span className="pointer-events-auto mt-1 inline-flex gap-2">
                <button
                  type="button"
                  onClick={() => void loadOlderGroups()}
                  className="rounded-md border border-edge/[0.1] bg-neutral-900/90 px-2 py-0.5 text-11 text-neutral-200 transition-colors hover:bg-neutral-800"
                >
                  {olderRemaining > 0
                    ? t('tasks.loadOlder', { n: Math.min(10, olderRemaining) })
                    : t('tasks.loadOlderEvents')}
                </button>
                <button
                  type="button"
                  onClick={() => setGroupWindow((w) => w + groups.length)}
                  className="rounded-md border border-edge/[0.1] bg-neutral-900/90 px-2 py-0.5 text-11 text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-neutral-200"
                >
                  {t('tasks.loadAll')}
                </button>
              </span>
            </div>
          )}
        </div>
      )}

      {/* 待答作答弹窗（组件自带，主窗/弹出窗同一枚）：数据走独立 API。 */}
      {answerOpen && entry && (
        <QuestionAnswer
          label={sessionLabel(row?.title ?? null, sessionId)}
          entry={entry}
          busy={fb.stateOf(`answer:${sessionId}`) === 'loading'}
          onAnswer={(answers) => {
            void fb.run(
              `answer:${sessionId}`,
              async () => {
                await api.answerQuestion(sessionId, answers);
                await refreshStatus();
              },
              { fail: (e) => t('tasks.answerFailed', { error: errorText(e) }) },
            );
          }}
          onClose={() => setAnswerOpen(false)}
        />
      )}
    </section>
  );
}
