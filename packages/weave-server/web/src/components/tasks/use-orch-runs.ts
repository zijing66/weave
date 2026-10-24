import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type OrchestrationRunRow, type OrchestrationRunStatus } from '@/lib/api';
import { errorText, type ActionFeedback } from '@/lib/action-feedback';
import { subscribeHook, type HookFrame } from '@/lib/sse';
import { usePullLoad } from '@/lib/pull-load';
import { FLASH_MS, RUN_PAGE, type LiveRun } from './orchestration-canvas-nodes';
import type { TFunc } from '@/i18n/t';

/**
 * 运行日志域：列表分页（runFilters/refreshRuns/loadMoreRuns）、SSE 两条编排帧
 * （orchestration.run / orchestration.delivery——liveRuns 就地更新、flash 点亮、
 * 新 run 防抖重拉）、展开详情（toggleRun）、清理与取消（clearRuns/cancelRun）、
 * 日志容器的拉动加载。实时态（liveRuns/flash）也归这里——画布节点/边的辉光
 * 都读它们。
 */
export function useOrchRuns(deps: {
  projectId: number | null;
  /** 当前编辑的编排 id（live = liveRuns.get(order)）。 */
  order: number | null;
  /** 编排清单（实时态对账：被删编排的 live 态跟着清）。 */
  list: readonly { id: number }[] | null;
  fb: ActionFeedback;
  t: TFunc;
  show: (kind: 'success' | 'error', msg: string) => void;
  /** 确认弹窗（清理要走应用内确认）。 */
  setConfirmState: (s: {
    title: string;
    message: string;
    confirmLabel: string;
    action: () => void;
  }) => void;
}) {
  const { projectId, order, list, fb, t, show, setConfirmState } = deps;
/** 按编排记账的实时运行态（总览模式下所有编排都要跟，不只选中的那份）。 */
const [liveRuns, setLiveRuns] = useState<ReadonlyMap<number, LiveRun>>(new Map());
/** 选中那份的实时态（头部徽标与编辑画布的 pending 都读它）。 */
const live = order != null ? (liveRuns.get(order) ?? null) : null;
/** 正在点亮的边 / 节点（键 = `o<编排id>:e:<边id>` 或 `o<编排id>:n:<节点键>`，值 = 到期时刻）。 */
const [flash, setFlash] = useState<Record<string, number>>({});
const flashRef = useRef(flash);
flashRef.current = flash;

/** 编排被删：它的实时态跟着清。 */
useEffect(() => {
  if (list == null) return;
  setLiveRuns((prev) => {
    let changed = false;
    const next = new Map<number, LiveRun>();
    for (const [id, run] of prev) {
      if (list.some((row) => row.id === id)) next.set(id, run);
      else changed = true;
    }
    return changed ? next : prev;
  });
}, [list]);

/** 亮完自己灭（纯动效计时，不取数据）。 */
useEffect(() => {
  const timer = window.setInterval(() => {
    const now = Date.now();
    const prev = flashRef.current;
    const next = Object.fromEntries(Object.entries(prev).filter(([, until]) => until > now));
    if (Object.keys(next).length !== Object.keys(prev).length) setFlash(next);
  }, 300);
  return () => window.clearInterval(timer);
}, []);

const [runs, setRuns] = useState<OrchestrationRunRow[] | null>(null);
const [nextBefore, setNextBefore] = useState<number | null>(null);
const [runsLoading, setRunsLoading] = useState(false);
const [runStatus, setRunStatus] = useState<OrchestrationRunStatus | ''>('');
const [runText, setRunText] = useState('');
const [debouncedRunText, setDebouncedRunText] = useState('');
const [expandedRunId, setExpandedRunId] = useState<number | null>(null);
const expandedRunRef = useRef(expandedRunId);
expandedRunRef.current = expandedRunId;
const [runDetail, setRunDetail] = useState<Record<number, OrchestrationRunRow>>({});
const [runDetailError, setRunDetailError] = useState<string | null>(null);
const runsRef = useRef<OrchestrationRunRow[] | null>(null);
runsRef.current = runs;

useEffect(() => {
  const timer = window.setTimeout(() => setDebouncedRunText(runText.trim()), 300);
  return () => window.clearTimeout(timer);
}, [runText]);

const runFilters = useCallback(
  () => ({
    projectId: projectId ?? undefined,
    status: runStatus || undefined,
    text: debouncedRunText || undefined,
    limit: RUN_PAGE,
  }),
  [projectId, runStatus, debouncedRunText],
);

const refreshRuns = useCallback(async (): Promise<void> => {
  setRunsLoading(true);
  try {
    const page = await api.listOrchestrationRuns(runFilters());
    setRuns(page.runs);
    setNextBefore(page.nextBefore);
    // 对账：列表里已落终态的 run，实时态里还挂着的清掉（daemon 重启把
    // running 改 interrupted 不发帧，只有这里能收掉残留辉光）。
    setLiveRuns((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const [orchId, run] of prev) {
        const row = page.runs.find((r) => r.id === run.runId);
        if (row && row.status !== 'running') {
          next.delete(orchId);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  } catch {
    // daemon 未连：保持上次数据
  } finally {
    setRunsLoading(false);
  }
}, [runFilters]);

useEffect(() => {
  setRuns(null);
  setNextBefore(null);
  void refreshRuns();
}, [refreshRuns]);

const loadMoreRuns = useCallback(async (): Promise<void> => {
  if (nextBefore == null) return;
  setRunsLoading(true);
  try {
    const page = await api.listOrchestrationRuns({ ...runFilters(), before: nextBefore });
    setRuns((prev) => {
      const seen = new Set((prev ?? []).map((r) => r.id));
      return [...(prev ?? []), ...page.runs.filter((r) => !seen.has(r.id))];
    });
    setNextBefore(page.nextBefore);
  } catch {
    // 失败保持现状，下次拉动再试
  } finally {
    setRunsLoading(false);
  }
}, [nextBefore, runFilters]);

/** 新起的运行（帧里的 runId 还不在手上）才重拉一页；其余就地更新。 */
const runsTimer = useRef<number | null>(null);
const scheduleRunsRefresh = useCallback((): void => {
  if (runsTimer.current !== null) return;
  runsTimer.current = window.setTimeout(() => {
    runsTimer.current = null;
    void refreshRuns();
  }, 500);
}, [refreshRuns]);

useEffect(() => {
  const onHook = (frame: HookFrame): void => {
    if (frame.kind !== 'orchestration.run' && frame.kind !== 'orchestration.delivery') return;
    const orchId = frame.orchestrationId;
    const runId = frame.runId;
    if (orchId == null || runId == null) return;
    const status = (frame.status as OrchestrationRunStatus | undefined) ?? undefined;

    setLiveRuns((prev) => {
      // 终态帧：清掉这条（辉光/徽标跟着收）。
      if (status && status !== 'running') {
        if (!prev.has(orchId)) return prev;
        const done = new Map(prev);
        done.delete(orchId);
        return done;
      }
      const cur = prev.get(orchId);
      const next = new Map(prev);
      next.set(orchId, {
        runId,
        status: status ?? cur?.status ?? 'running',
        deliveries: frame.deliveries ?? cur?.deliveries ?? 0,
        pendingCounts: frame.pendingCounts ?? cur?.pendingCounts ?? {},
      });
      return next;
    });

    if (frame.kind === 'orchestration.delivery') {
      const to = frame.to ?? '';
      // 节点键：session 挂 `s:` 前缀，webhook 节点直接用它的 `w:` id；边/节点键都带
      // 编排前缀（总览与编辑同一套键，跨编排的短边 id e1/e2 不碰撞）。
      const key = frame.edgeId
        ? `o${orchId}:e:${frame.edgeId}`
        : `o${orchId}:n:${to.startsWith('w:') ? to : `s:${to}`}`;
      const until = Date.now() + FLASH_MS;
      setFlash((prev) => ({ ...prev, [key]: until }));
    }

    const known = runsRef.current?.some((row) => row.id === runId) ?? false;
    if (!known) {
      if (runsRef.current !== null) scheduleRunsRefresh();
      return;
    }
    setRuns((prev) =>
      prev?.map((row) =>
        row.id === runId
          ? {
              ...row,
              status: status ?? row.status,
              deliveries: frame.deliveries ?? row.deliveries,
              pendingCounts: frame.pendingCounts ?? row.pendingCounts,
              ...(status && status !== 'running' ? { finishedAt: frame.at ?? row.finishedAt } : {}),
            }
          : row,
      ) ?? prev,
    );
    // 终态补一笔详情：展开着的那行要跟着落定（错误信息只在详情里）。
    if (status && status !== 'running' && expandedRunRef.current === runId) {
      void api
        .getOrchestrationRun(runId)
        .then((res) => setRunDetail((prev) => ({ ...prev, [runId]: res.run })))
        .catch(() => {});
    }
  };
  const off = subscribeHook(onHook, ['orchestration.']);
  return () => {
    off();
    if (runsTimer.current !== null) {
      window.clearTimeout(runsTimer.current);
      runsTimer.current = null;
    }
  };
}, [scheduleRunsRefresh]);

/** 日志容器（拉动加载的边缘判定读它）。 */
const runsEl = useRef<HTMLDivElement | null>(null);
const pull = usePullLoad({
  axis: 'bottom',
  getEdge: () => {
    const el = runsEl.current;
    return !!el && el.scrollHeight - el.scrollTop - el.clientHeight <= 1;
  },
  onFire: () => void loadMoreRuns(),
  enabled: nextBefore !== null && !runsLoading,
});

const toggleRun = useCallback(
  (runId: number): void => {
    if (expandedRunId === runId) {
      setExpandedRunId(null);
      return;
    }
    setExpandedRunId(runId);
    setRunDetailError(null);
    void api
      .getOrchestrationRun(runId)
      .then((res) => setRunDetail((prev) => ({ ...prev, [runId]: res.run })))
      .catch((e) => setRunDetailError(errorText(e)));
  },
  [expandedRunId],
  );

const clearRuns = (scope: 'finished' | 'all'): void => {
  setConfirmState({
    title: t('orch.runsTitle'),
    message: t(scope === 'all' ? 'orch.runsClearAllConfirm' : 'orch.runsClearFinishedConfirm'),
    confirmLabel: scope === 'all' ? t('orch.runsClearAll') : t('orch.runsClearFinished'),
    action: () => {
      void fb.run(
        `orch:clear:${scope}`,
        async () => {
          const res = await api.clearOrchestrationRuns(scope, projectId ?? undefined);
          show('success', t('orch.runsCleared', { n: res.deleted }));
          await refreshRuns();
        },
        { fail: (e) => t('orch.runsClearFailed', { error: errorText(e) }) },
      );
    },
  });
};

const cancelRun = (runId: number): void => {
  void fb.run(
    `orch:runCancel:${runId}`,
    async () => {
      await api.cancelOrchestrationRun(runId);
      await refreshRuns();
    },
    { fail: (e) => t('orch.runCancelFailed', { error: errorText(e) }) },
  );
};

  return {
    runs, setRuns, runsRef, nextBefore, runsLoading, runStatus, setRunStatus,
    runText, setRunText, expandedRunId, setExpandedRunId, runDetail, runDetailError,
    liveRuns, flash, live,
    refreshRuns, loadMoreRuns, toggleRun, clearRuns, cancelRun,
    runsEl, pull,
  };
}
