import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Harness } from '@weavecode/core/harness';
import {
  api,
  type AnswerPick,
  type MessagingCapability,
  type ProjectHarness,
  type PromptLimits,
  type SessionWatchRow,
  type TerminalPreset,
  type TerminalTarget,
  type WatchOn,
} from '@/lib/api';
import { useT } from '@/i18n/I18nProvider';
import { cn } from '@/lib/utils';
import { useBackPop } from '@/lib/back-pop';
import { registerInvalidator } from '@/lib/sse';
import { harnessUiOf } from '@/lib/harness-meta';
import { Combobox } from '@/components/ui/combobox';
import { sessionLabel } from '@/lib/hook-payload';
import { SessionList, byActivity } from './SessionList';
import { SessionMessages } from './SessionMessages';
import type { LifecycleGroup } from './build-lifecycle-groups';
import { HARNESS_LIFECYCLE } from './lifecycle';
import { subscribeHook } from '@/lib/sse';
import { SessionChainPanel } from './SessionChainPanel';
import { TerminalPicker } from './TerminalPicker';
import { HarnessPicker } from './HarnessPicker';
import { TerminalPanes } from './term-panes/TerminalPanes';
import { focusSessionPanes, openPane, useTermPanes } from './term-panes/term-pane-store';
import { attachFrameView, openPaneFrame, reclaimPaneFrame, usePaneFrames, windows as paneFrameWindows } from './term-panes/pane-transfer';
import {
  openTerminalStateOf as openTerminalButtonState,
  webTerminalAvailabilityOf,
} from './conv-model';
import { SessionStatusIcon } from './SessionStatusIcon';
import { useSessionStatus } from './session-status-store';
import { AlertTriangle, ExternalLink, Loader2, Plus, X } from 'lucide-react';
import { SkeletonRows } from '@/components/ui/skeleton';
import { useToast } from '@/components/Toast';
import { FeedbackIcon } from '@/components/FeedbackIcon';
import { RefreshIconButton } from '@/components/RefreshIconButton';
import { Tooltip } from '@/components/ui/tooltip';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Resizer } from '@/components/Resizer';
import { errorText, useActionFeedback } from '@/lib/action-feedback';
import { ensureNotifyPermission, type NotifyPermission } from '@/lib/browser-notify';
import { ensurePushSubscribed } from '@/lib/push';
import { useMediaQuery } from '@/lib/use-media-query';
import { setConvScreenOpen } from '@/lib/conv-screen';
import { sweepConvCacheOrphans } from './conv-anchor-cleanup';
import { createAwaitGate } from '@/lib/await-gate';
import type { MessageKey } from '@/i18n/dict';

/** 会话列表宽度上下限（桌面；`<lg` 恒铺满，不参与）。 */
const LIST_MIN = 200;
const LIST_MAX = 420;

/** 权限失败态 → toast 文案键：成因不同口径不同（手机 HTTP 访问是 insecure 不是 denied）。 */
const NOTIFY_TOAST_KEY: Record<Exclude<NotifyPermission, 'granted'>, MessageKey> = {
  denied: 'tasks.notifyDenied',
  unsupported: 'tasks.notifyUnsupported',
  insecure: 'tasks.notifyInsecure',
};

/** 开终端「等转绿」上限：claude 启动即写存活注册表、通常 1–3s 内转绿；超过这个
 *  时限还没登记（进程当场退出之类）就放行——按钮不能永久卡在 loading 里点不动。 */
const OPEN_TERMINAL_ALIVE_MS = 30_000;

/** 一扇已挂载的对话：切走只藏不卸，草稿与已选图片都还在。 */
type ConvTarget = {
  sessionId: string;
  projectId: number;
  label: string;
  capability: MessagingCapability;
};

/**
 * 折叠条的渲染窗口：最新 `size` 组，**但展开着的那组一定在窗口里**。
 * 新 turn 落地 = 组表变长，纯 `slice(-size)` 会把最旧那一行挤出去——若那行正展开着
 * 事件链画布，整块画布会随行一起卸载，看着就是「刷新出新事件后节点全没了」。
 * 命中时把窗口往前扩到那一组（保持时序，不把该组挪到顶部）。
 */
export function windowGroups(
  groups: readonly LifecycleGroup[],
  size: number,
  activeId: string,
): readonly LifecycleGroup[] {
  const tailStart = Math.max(0, groups.length - size);
  if (!activeId) return groups.slice(tailStart);
  const idx = groups.findIndex((g) => g.id === activeId);
  return idx >= 0 && idx < tailStart ? groups.slice(idx) : groups.slice(tailStart);
}

/**
 * 任务视图容器（项目级两栏）：左 = 会话列表（状态/计数/改名/拖拽目标），
 * 右 = 选中会话的对话（选中即挂、切走只藏不卸）；没有对话面的 harness 右栏
 * 仍是事件链本尊 = 分组组头列表（滚动窗口：默认最新 10 条、向上滚动加载更早）
 * + 单组合体事件链画布（默认全折叠，点击展开才按需挂载导图），对话在场时它
 * 从对话头部那枚按钮开成弹窗。
 * 会话列表与状态来自全局状态总线（SessionStatusProvider）；本面板只自管事件链
 * 明细：SSE 总线的 hook 订阅驱动选中会话的事件按需刷新。
 */
export function TasksPanel({
  projectId,
  initialSessionId,
  onSelectSession,
  projectLabel,
  harnesses,
}: {
  projectId: number;
  /** 初始选中会话（全局总览跳转用）；不传则默认最新会话。 */
  initialSessionId?: string;
  /** 选中/取消选中会话 → 写 URL（三级位置，App 统一落）。 */
  onSelectSession?: (sessionId: string | null) => void;
  /** 项目目录名（对话弹窗标题副行；CategoryDetail 按 projectId 解好）。 */
  projectLabel: string;
  /** 本项目已接入的 harness（init 选择结果，与项目卡标签同源）。 */
  harnesses: ProjectHarness[];
}) {
  const t = useT();
  const { show } = useToast();
  const fb = useActionFeedback();
  const {
    sessions: allSessions,
    statuses,
    inflight: inflightCounts,
    failedDeliveries,
    questions,
    refresh: refreshStatus,
  } = useSessionStatus();
  // <lg 两屏走查：列表态 ⇄ 右栏全屏态（点会话进、收起回），桌面恒双栏 inline。
  const isDesktop = useMediaQuery('(min-width: 1024px)');
  // 会话列表宽度：桌面可拖（同 App 左右栏的口径：localStorage 记住 + clamp）
  const [listW, setListW] = useState<number>(() => {
    const v = Number(localStorage.getItem('weave:tasks-list'));
    return Number.isFinite(v) && v > 0 ? Math.min(LIST_MAX, Math.max(LIST_MIN, v)) : 288;
  });
  useEffect(() => localStorage.setItem('weave:tasks-list', String(listW)), [listW]);
  const [paneOpen, setPaneOpen] = useState(false);
  // 移动端返回键/侧滑 = 收起会话抽屉（`<lg` 点会话滑出的那块全屏右栏）
  useBackPop(paneOpen, () => {
    setPaneOpen(false);
    return true;
  });
  /** 事件链弹窗：右栏被对话占着时从对话头部那枚按钮开（右栏没对话面时事件链仍在原位）。 */
  const [chainDialog, setChainDialog] = useState(false);
  // 深链/跳转带入的会话直接作为初始选中（路由即真源）；不带入才留给列表就绪后
  // 的兜底去选最新。
  const [selectedId, setSelectedId] = useState<string | null>(initialSessionId ?? null);
  /** 已落过的三级位置（项目 + 会话）：本面板自己点出来的选中会经 URL 回写成同值 prop，
   *  按这份账认回声，免得每次点会话都重设一遍并闪高亮。 */
  const appliedSel = useRef<{ project: number; sessionId: string | null }>({
    project: projectId,
    sessionId: initialSessionId ?? null,
  });
  const [, setError] = useState<string | null>(null);
  const [pendingRun, setPendingRun] = useState<{
    dispatchId: number;
    sessionId: string;
    sessionLabel: string;
  } | null>(null);
  // 移动端返回键/侧滑逐层退：拖拽执行确认 → 事件链弹窗（后挂的先退）
  useBackPop(pendingRun != null, () => {
    setPendingRun(null);
    return true;
  });
  useBackPop(chainDialog, () => {
    setChainDialog(false);
    return true;
  });
  /** 待答弹窗目标（会话行图标与事件链组头/画布 tag 共开同一份；null = 关）。 */
  const [answerFor, setAnswerFor] = useState<string | null>(null);
  /** 全局总览跳转定位：该会话行高亮边框（3s 后移除）。 */
  const [highlightId, setHighlightId] = useState<string | null>(null);

  /** 本项目会话：总线全量列表按 projectId 过滤（null = 首次加载中，沿用总线状态）。 */
  const projectSessions = useMemo(
    () => (allSessions === null ? null : allSessions.filter((s) => s.projectId === projectId)),
    [allSessions, projectId],
  );

  /** harness 筛选（'' = 全部）：只作用于列表与计数，不动选中态与右栏。 */
  const [harnessFilter, setHarnessFilter] = useState<Harness | ''>('');
  const sessions = useMemo(
    () =>
      projectSessions === null || harnessFilter === ''
        ? projectSessions
        : projectSessions.filter((s) => s.harness === harnessFilter),
    [projectSessions, harnessFilter],
  );

  /** 会话行的同步影子：等「转绿」时要现读最新行，拿不到下一次 render 的闭包。 */
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  /** 服务端正在为它拉起终端的会话（`message.opening` 帧 = 投递前对判死目标走
   *  `ensureOpen`，最长 15s）：会话行的终端按钮这期间必须转圈并禁用，否则再点一次
   *  会 spawn 第二个 resume 抢同一会话。失败不收绿也要收圈，故挂兜底超时。 */
  const [openingIds, setOpeningIds] = useState<ReadonlySet<string>>(() => new Set());
  const openingTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const clearOpening = useCallback((sessionId: string): void => {
    const timer = openingTimers.current[sessionId];
    if (timer) {
      clearTimeout(timer);
      delete openingTimers.current[sessionId];
    }
    setOpeningIds((prev) => {
      if (!prev.has(sessionId)) return prev;
      const next = new Set(prev);
      next.delete(sessionId);
      return next;
    });
  }, []);
  useEffect(
    () =>
      subscribeHook(
        (frame) => {
          if (frame.kind !== 'message.opening') return;
          const ids = (frame.targets ?? []).filter(
            (id) => sessionsRef.current?.find((s) => s.sessionId === id)?.pidAlive !== true,
          );
          if (ids.length === 0) return;
          setOpeningIds((prev) => new Set([...prev, ...ids]));
          for (const id of ids) {
            const existing = openingTimers.current[id];
            if (existing) clearTimeout(existing);
            openingTimers.current[id] = setTimeout(
              () => clearOpening(id),
              OPEN_TERMINAL_ALIVE_MS,
            );
          }
        },
        ['message.opening'],
      ),
    [clearOpening],
  );

  /** 「等已进入」的闸：会话行一变就 poke 一次——开终端与新建会话两个按钮的
   *  loading 都挂到命中（或超时）为止，不轮询。行转绿即摘掉服务端的拉起态。 */
  const gate = useRef(createAwaitGate(OPEN_TERMINAL_ALIVE_MS));
  useEffect(() => {
    gate.current.poke();
    for (const s of sessions ?? []) {
      if (s.pidAlive) clearOpening(s.sessionId);
    }
  }, [sessions, clearOpening]);
  useEffect(() => () => gate.current.releaseAll(), []);
  useEffect(
    () => () => {
      for (const timer of Object.values(openingTimers.current)) clearTimeout(timer);
    },
    [],
  );

  /** 等该会话的 claude 进程转绿（或超时）：开终端按钮的 loading 一直挂到这时为止
   *  ——「已 spawn、绿还没到」的空窗里，多点是再起一个 claude --resume 抢同一会话。
   *  转绿判据（以及判不动时的超时放行）都在这里收口。 */
  const waitTerminalAlive = useCallback(
    (sessionId: string): Promise<void> =>
      gate.current.wait(
        `alive:${sessionId}`,
        () => sessionsRef.current?.some((s) => s.sessionId === sessionId && s.pidAlive) === true,
      ),
    [],
  );

  /** 等该会话的进程熄灭（或超时）：关 pane 按钮的 loading 挂到这时为止——
   *  「已关、图标还没暗」的空窗里按钮还在转圈，点不动也不会重复关。 */
  const waitTerminalClosed = useCallback(
    (sessionId: string): Promise<void> =>
      gate.current.wait(
        `closed:${sessionId}`,
        () => sessionsRef.current?.some((s) => s.sessionId === sessionId && !s.pidAlive) === true,
      ),
    [],
  );

  /** 等新会话行落进列表（或超时）：新建会话的 loading 挂到这时为止——spawn 是异步的
   *  （新窗 pane 起来、claude 再发 SessionStart 才落行），POST 一返回就收圈等于
   *  「点完看不出有没有生效」，用户会再点一次起出第二个。 */
  /** 等该会话在 Runtime Host 里的实例完成绑定（按钮转绿）——headless 起来后
   *  会话行要等首条 hook 事件才带 webInstanceId。 */
  const waitWebInstance = useCallback(
    (sessionId: string): Promise<void> =>
      gate.current.wait(
        `webinst:${sessionId}`,
        () =>
          sessionsRef.current?.some((s) => s.sessionId === sessionId && !!s.webInstanceId) === true,
      ),
    [],
  );

  const waitNewSession = useCallback(
    (known: ReadonlySet<string>): Promise<void> =>
      gate.current.wait(
        `new:${projectId}`,
        () => sessionsRef.current?.some((s) => !known.has(s.sessionId)) === true,
      ),
    [projectId],
  );


  // 三级位置从外面变（深链 / 前进后退 / 全局总览跳转）才落：换项目必落，同项目同值 = 回声
  useEffect(() => {
    const next = initialSessionId ?? null;
    const prev = appliedSel.current;
    if (prev.project === projectId && prev.sessionId === next) return;
    appliedSel.current = { project: projectId, sessionId: next };
    setSelectedId(next);
    // 跳转带入的会话不自动开事件链 drawer（drawer 只由点会话进入），
    // 会话行高亮边框 3s 指位后移除。
    if (next) {
      setHighlightId(next);
      window.setTimeout(() => setHighlightId((cur) => (cur === next ? null : cur)), 3000);
    }
  }, [projectId, initialSessionId]);
  // 消息能力矩阵（服务端 MessagingSurface 纯派生）：按钮门控与弹窗模式选项的
  // 唯一真源——web 只渲染不判定，不写死 harness 白名单。完整表不过滤（不支持
  // 的面也在），行内各按钮按字段自取。
  const [messagingCaps, setMessagingCaps] = useState<MessagingCapability[] | null>(null);
  // prompt 长度策略（core 常量的服务端投影）：输入框预检与「将整块粘贴」提示都用它
  const [promptLimits, setPromptLimits] = useState<PromptLimits | null>(null);
  const refreshMessagingCaps = useCallback(() => {
    api
      .messagingCapabilities()
      .then((r) => {
        setMessagingCaps(r.capabilities);
        setPromptLimits(r.promptLimits);
      })
      .catch(() => {});
  }, []);

  // 会话列表收纳阈值（全局设置 sessions.archiveDays；0 = 关闭收纳）：设置保存推
  // invalidate('settings')，这里也挂同一失效器。
  const [archiveDays, setArchiveDays] = useState(5);
  useEffect(() => {
    api
      .getDaemonSettings()
      .then((r) => setArchiveDays(r.settings.sessions?.archiveDays ?? 5))
      .catch(() => {});
    return registerInvalidator('settings', () =>
      api
        .getDaemonSettings()
        .then((r) => setArchiveDays(r.settings.sessions?.archiveDays ?? 5))
        .catch(() => {}),
    );
  }, []);
  useEffect(() => {
    refreshMessagingCaps();
  }, [refreshMessagingCaps]);
  // prompt 列合成终端通道（随 settings 变）——设置保存推 invalidate('settings')
  // 帧，接到重拉上，按钮门控不卡旧值。
  useEffect(
    () => registerInvalidator('settings', refreshMessagingCaps),
    [refreshMessagingCaps],
  );
  const capabilityMap = useMemo(() => {
    const m = new Map<Harness, MessagingCapability>();
    for (const c of messagingCaps ?? []) m.set(c.harness, c);
    return m;
  }, [messagingCaps]);

  // 空闲订阅面（批 2）：全部 pending，面板只渲染本 dashboard 订的行
  //（watcherSessionId === null）——会话订阅由服务端注入通知，不占铃铛。
  const [watches, setWatches] = useState<SessionWatchRow[] | null>(null);
  const refreshWatches = useCallback(() => {
    api.listSessionWatches().then(setWatches).catch(() => {});
  }, []);
  useEffect(() => {
    refreshWatches();
  }, [refreshWatches]);
  const dashboardWatches = useMemo(() => {
    const m = new Map<string, SessionWatchRow>();
    for (const w of watches ?? []) {
      if (w.watcherSessionId === null) m.set(w.targetSessionId, w);
    }
    return m;
  }, [watches]);
  const watchOf = useCallback(
    (sessionId: string) => dashboardWatches.get(sessionId),
    [dashboardWatches],
  );
  const watchStateOf = useCallback((sessionId: string) => fb.stateOf(`watch:${sessionId}`), [fb]);
  /** 在途消息条数（总线 push 快照）：会话行消息图标的 amber + 角标。 */
  const inflightOf = useCallback(
    (sessionId: string) => inflightCounts.get(sessionId) ?? 0,
    [inflightCounts],
  );
  /** 常驻失败行条数（同帧 failed 快照）：会话行消息图标的红 = 错误色（优先展示）。 */
  const failedOf = useCallback(
    (sessionId: string) => failedDeliveries.get(sessionId) ?? 0,
    [failedDeliveries],
  );
  /** 待答阻塞问题（总线随帧刷新）：会话行问答图标的 amber + 角标。 */
  const questionOf = useCallback(
    (sessionId: string) => questions.get(sessionId),
    [questions],
  );
  /** 远程作答：整 call 一次提交，成功即乐观摘问（服务端口径），失败 toast
   *  （键序没进终端，可重试）。 */
  const onAnswerQuestion = useCallback(
    (sessionId: string, answers: AnswerPick[]): void => {
      void fb.run(
        `answer:${sessionId}`,
        async () => {
          await api.answerQuestion(sessionId, answers);
          await refreshStatus();
        },
        { fail: (e) => t('tasks.answerFailed', { error: errorText(e) }) },
      );
    },
    [fb, t, refreshStatus],
  );
  const answerStateOf = useCallback(
    (sessionId: string) => fb.stateOf(`answer:${sessionId}`),
    [fb],
  );
  /** 停止会话：向 pane 打一记 ESC（长工具卡住 / API 报错重试 / 模态框都吃这一记），
   *  读屏确认没停再补一记 Ctrl+C。宿主在工具执行窗口里两记都会吞——这时服务端答
   *  `confirmed:false`，就地如实说「没停」，不摆成功态。 */
  const onInterrupt = useCallback(
    (sessionId: string): void => {
      void fb.run(
        `interrupt:${sessionId}`,
        async () => {
          const r = await api.interruptSession(sessionId);
          if (r.confirmed === false) show('info', t('tasks.stopUnconfirmed'));
          else show('success', t('tasks.stopOk'));
        },
        { fail: (e) => t('tasks.stopFail', { error: errorText(e) }) },
      );
    },
    [fb, t, show],
  );
  const interruptStateOf = useCallback(
    (sessionId: string) => fb.stateOf(`interrupt:${sessionId}`),
    [fb],
  );
  const onSubscribeWatch = useCallback(
    (sessionId: string, on: WatchOn[], times: number | null): void => {
      void fb.run(
        `watch:${sessionId}`,
        async () => {
          // 订阅 = 用户手势：此刻申请通知权限（须在手势里，浏览器才弹窗）。
          // 拒绝/不支持/HTTP 访问皆退化为页面内 toast——明确告知成因，不静默降级。
          const permission = await ensureNotifyPermission();
          if (permission !== 'granted') show('info', t(NOTIFY_TOAST_KEY[permission]));
          // 同一手势里尽量把推送也订上（页面关掉后仍可达的通道）；失败静默
          // 降级到「页面开着才提醒」，不打扰订阅本身。
          await ensurePushSubscribed();
          await api.createSessionWatch(sessionId, { on, times });
          refreshWatches();
        },
        { fail: (e) => t('tasks.watchFailed', { error: errorText(e) }) },
      );
    },
    [fb, t, show, refreshWatches],
  );

  const onUnwatch = useCallback(
    (sessionId: string): void => {
      const existing = dashboardWatches.get(sessionId);
      if (!existing) return;
      void fb.run(
        `watch:${sessionId}`,
        async () => {
          await api.deleteSessionWatch(sessionId, existing.id);
          refreshWatches();
        },
        { fail: (e) => t('tasks.unwatchFailed', { error: errorText(e) }) },
      );
    },
    [fb, t, dashboardWatches, refreshWatches],
  );

  // watch.fired 帧：订阅落定（fire 即失效）→ 重拉订阅面，铃铛归位。
  useEffect(() => subscribeHook(() => refreshWatches(), ['watch.fired']), [refreshWatches]);

  // 待答面无了（答完/解除/被换掉）而弹窗已随之自关 → 目标一并归位；否则 answerFor
  // 还留着旧会话 id，该会话下次挂起会「无点击自动弹脸」。
  useEffect(() => {
    if (answerFor && !questionOf(answerFor)?.questions.length) setAnswerFor(null);
  }, [answerFor, questionOf]);

  // 会话列表就绪后补默认选中（初始选中会话优先；用户点击后 prev 非空，不再覆盖）。
  // 「最新」= 活动序第一条（lastSeenAt 倒序），与服务端列表的 created_at 序区分。
  useEffect(() => {
    setSelectedId(
      (prev) =>
        prev ??
        sessions?.slice().sort((a, b) => byActivity(a, b, statuses))[0]?.sessionId ??
        null,
    );
  }, [sessions, statuses]);

  // 打开项目时顺手清对话缓存的孤儿（会话已被 sweeper 清掉的，conv 缓存只剩
  // TTL 兜底、anchor 更是只写不删）：按服务端现存会话清单对账（用户裁决 2026-11-20）。
  useEffect(() => {
    if (allSessions === null) return;
    sweepConvCacheOrphans(new Set(allSessions.map((s) => s.sessionId)));
  }, [allSessions]);


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

  /** 终端预设（设置页选项，默认 web）：`web` = 会话起在 Runtime Host、右栏同区
   *  在对话与终端之间切换；其他 preset 仍是外部终端窗口（null = 还没取到）。 */
  const [terminalPreset, setTerminalPreset] = useState<TerminalPreset | null>(null);
  useEffect(() => {
    const load = (): void => {
      void api
        .getDaemonSettings()
        .then((b) => setTerminalPreset(b.settings.terminal.preset))
        .catch(() => {});
    };
    load();
    return registerInvalidator('settings', load);
  }, []);
  const webMode = terminalPreset === 'web';

  /** worktree 隔离（B5 最小切片）：弹层里的开关态，面板重开不丢；下一次起会话生效。 */
  const [worktreeNewSession, setWorktreeNewSession] = useState(false);
  /** headless（B4 Agent Runtime）：起在 Runtime Host、不开外部终端窗，Web 终端交互。 */
  const [headlessNewSession, setHeadlessNewSession] = useState(false);
  /** 打开中的 Web 终端：右栏 pane 集合（分屏），窗口级 store、跨会话/刷新保活。 */
  const termPanes = useTermPanes();
  const panelPaneCount = Object.values(termPanes.panes).filter((p) => p.slot === 'panel').length;

  /** 对话头部的终端入口：Web 预设恒在（没实例则置灰说明）；其他预设只给真有
      headless 实例的会话摆，免得每个对话都多一枚用不上的按钮。 */
  const webTerminalEntry = (
    sessionId: string,
  ): { available: boolean; reason?: 'busy' | 'gone'; onOpen: () => void } | null => {
    const row = projectSessions?.find((x) => x.sessionId === sessionId);
    if (!webMode && !row?.webInstanceId) return null;
    const avail = webTerminalAvailabilityOf(row ?? {});
    return {
      available: avail === 'live' || avail === 'resume',
      reason: avail === 'busy' ? ('busy' as const) : avail === 'gone' ? ('gone' as const) : undefined,
      onOpen: () => runOpenTerminal(sessionId),
    };
  };

  /** 新建会话：在项目**已打开的终端**里起一个新会话（服务端把 harness 裸 bin
      打进该项目既有 pane 的分屏；没有已开终端时 409——按钮也据此置灰）。
      fb 键按项目隔离：loading 在途吞连点，防重复 spawn。
      **loading 挂到新会话行进列表为止**（同开终端口径——「已 spawn、行还没到」的
      空窗里按钮还在转圈、点不动，不会多起一个 claude）；不落会话行的 harness
      （生命周期表里没有会话标记事件，如 codex）没有新行可等，POST 回即收圈。 */
  const runNewSession = useCallback(
    (harness?: Harness): void => {
      void fb.run(
        `newSession:${projectId}`,
        async () => {
          if (headlessNewSession || webMode) {
            // headless（B4）：Runtime Host 持 PTY。**停在对话面**——会话行绑定
            // 落地后终端按钮转绿，再点那一下才进 TUI。
            const known = new Set((sessionsRef.current ?? []).map((s) => s.sessionId));
            await api.startHeadlessSession(projectId, harness);
            if (harness && HARNESS_LIFECYCLE[harness].sessionMarkers.length === 0) return;
            await waitNewSession(known);
            // 落在新会话的对话面（选中即挂对话；终端等用户再点那一下）。
            const created = sessionsRef.current?.find((s) => !known.has(s.sessionId));
            if (created) {
              setSelectedId(created.sessionId);
              if (!isDesktop) setPaneOpen(true);
            }
            return;
          }
          const known = new Set((sessionsRef.current ?? []).map((s) => s.sessionId));
          await api.startProjectSession(projectId, harness, worktreeNewSession);
          if (harness && HARNESS_LIFECYCLE[harness].sessionMarkers.length === 0) return;
          await waitNewSession(known);
        },
        { fail: (e) => t('tasks.newSessionFailed', { error: errorText(e) }) },
      );
    },
    [fb, projectId, t, waitNewSession, worktreeNewSession, headlessNewSession, webMode, isDesktop],
  );

  /** 起会话的 harness 弹层（锚在按钮下方，同项目列表的终端弹层口径）：项目选中的
   *  harness **全列**，起不了的置灰并在行内说明——只有一个也照样展开，选哪个恒由用户点。 */
  const [harnessPicker, setHarnessPicker] = useState<{
    x: number;
    y: number;
    anchor: HTMLElement;
  } | null>(null);
  const canNewSession = harnesses.length > 0;
  /** 起会话在途（spawn 要几秒）：按钮同置灰——只转圈不禁用的话，看着像没反应又点一次。
      连点的真去重在 `fb.run`（loading 吞重复调用），这里只是把同一事实摆到按钮上。 */
  const newSessionBusy = fb.stateOf(`newSession:${projectId}`) === 'loading';
  const onNewSession = useCallback((anchor: HTMLElement): void => {
    const rect = anchor.getBoundingClientRect();
    setHarnessPicker((cur) => (cur ? null : { x: rect.left, y: rect.bottom + 4, anchor }));
  }, []);

  /** 多终端选择弹窗（项目开着多个终端时才现形）。 */
  const [terminalPicker, setTerminalPicker] = useState<{
    sessionId: string;
    targets: TerminalTarget[];
  } | null>(null);

  const openTerminalStateOf = useCallback(
    (sessionId: string) =>
      openTerminalButtonState(fb.stateOf(`openTerm:${sessionId}`), openingIds.has(sessionId)),
    [fb, openingIds],
  );

  /** 关 pane（退出会话）：先弹应用内确认（closePaneTarget）——一键杀宿主的键，
      误触代价太大，红按钮 + 二次确认都为它设。确认后走 runClosePane。 */
  const [closePaneTarget, setClosePaneTarget] = useState<{ sessionId: string; label: string } | null>(null);
  const handleClosePane = useCallback(
    (sessionId: string) => {
      const row = sessions?.find((s) => s.sessionId === sessionId);
      const label = row ? sessionLabel(row.title, row.sessionId) : sessionId.slice(0, 8);
      setClosePaneTarget({ sessionId, label });
    },
    [sessions],
  );

  /** 关掉会话所在的 pane（退出会话）：宿主随 pane 一起退出，会话行与它的对话
      照常保留（那是历史），之后仍可 --resume 接回。fb 键按会话隔离，loading 挂到
      图标熄灭为止（同开终端口径——「已关、绿还没暗」的空窗里按钮转圈点不动）。
      失败 toast 带服务端中文修法（找不到 pane / 该终端没这个通道都不静默）。 */
  const runClosePane = useCallback(
    (sessionId: string): void => {
      void fb.run(
        `closePane:${sessionId}`,
        async () => {
          await api.closeSessionPane(sessionId);
          await refreshStatus();
          await waitTerminalClosed(sessionId);
          show('success', t('toast.sessionPaneClosed'));
        },
        { fail: (e) => t('tasks.closePaneFailed', { error: errorText(e) }) },
      );
    },
    [fb, t, refreshStatus, waitTerminalClosed],
  );
  const closePaneStateOf = useCallback(
    (sessionId: string) => fb.stateOf(`closePane:${sessionId}`),
    [fb],
  );

  /** 已挂载的对话：选中哪个会话就挂哪个（能力矩阵按 harness 解不出能力的不挂，
   *  右栏留在事件链）。挂上就不再卸——切走只是藏起来，草稿与已选图片都还在。 */
  const [convs, setConvs] = useState<ReadonlyMap<string, ConvTarget>>(new Map());
  const openConv = useCallback(
    (sessionId: string): void => {
      // 现读影子，不把 sessions 放进依赖：否则每条 SSE 事件都换一次身份，
      // 关掉的对话会被下一次列表刷新自动重挂回来。
      const row = sessionsRef.current?.find((s) => s.sessionId === sessionId);
      const capability = row?.harness ? capabilityMap.get(row.harness) : undefined;
      if (!capability) return;
      setConvs((prev) => {
        if (prev.has(sessionId)) return prev;
        const next = new Map(prev);
        next.set(sessionId, {
          sessionId,
          projectId: row?.projectId ?? projectId,
          label: sessionLabel(row?.title ?? null, sessionId),
          capability,
        });
        return next;
      });
    },
    [capabilityMap, projectId],
  );
  useEffect(() => {
    if (selectedId) openConv(selectedId);
  }, [selectedId, openConv]);

  /** 对话弹出（分屏第三批）：弹到独立框架页（独立路由 /pane-frame，不加载
   *  dashboard）；一个框架页 = 一个项目（同项目会话都贴进这一页，wezterm 贴
   *  pane 同款，≤6）。右栏原位置留占位条 + 切回；占位状态直接从 storage 记录
   *  派生：持窗关闭（记录被删）或切回（returning → 记录删除）后自动恢复对话
   *  显示，同一对话不会双挂。 */
  const paneFrames = usePaneFrames();
  const projectFrame = useMemo(
    () => paneFrames.find((p) => p.projectId === projectId && p.state === 'active') ?? null,
    [paneFrames, projectId],
  );
  const poppedConvs = useMemo(() => {
    const map: Record<string, { frameId: string; label: string }> = {};
    if (!projectFrame) return map;
    // 认账不只种子会话：贴进同一页的第二个对话也占位（否则它弹出后右栏原地还
    // 摆着对话本体，同一对话双挂两处）。
    for (const v of Object.values(projectFrame.views)) {
      if (v.kind === 'conversation') map[v.sessionId] = { frameId: projectFrame.frameId, label: v.label };
    }
    return map;
  }, [projectFrame]);
  const popoutConversation = useCallback(
    (sessionId: string): void => {
      const conv = convs.get(sessionId);
      if (!conv || poppedConvs[sessionId]) return;
      try {
        openPaneFrame(
          {
            projectId: conv.projectId,
            projectLabel,
            sessionId,
            label: conv.label,
          },
          'width=900,height=720',
        );
      } catch {
        // 浏览器拦了弹窗：对话留在右栏
      }
    },
    [convs, poppedConvs, projectLabel],
  );
  const reclaimConversation = useCallback(
    (sessionId: string): void => {
      const popped = poppedConvs[sessionId];
      if (!popped) return;
      reclaimPaneFrame(popped.frameId);
    },
    [poppedConvs],
  );
  /** 点会话（行本体或对话图标）= 选中它并挂上它的对话；<lg 进全屏态。 */
  const focusSession = useCallback(
    (sessionId: string): void => {
      setSelectedId(sessionId);
      appliedSel.current = { project: projectId, sessionId };
      onSelectSession?.(sessionId);
      openConv(sessionId);
      // Web 终端与对话同区、同生命周期：切会话时别家 pane 让位（detach，进程照跑）
      focusSessionPanes(sessionId);
      if (!isDesktop) setPaneOpen(true);
    },
    [openConv, isDesktop, onSelectSession, projectId],
  );

  /** <lg 时右栏只在选中会话且 paneOpen 时渲染——从列表卡片触发的任何跳转
      （进终端 / headless 落对话）必须同时选中该会话并展开滑出层，否则状态设了、
      屏上没东西（点了没反应）。 */
  const focusOnMobile = useCallback(
    (sessionId: string): void => {
      if (isDesktop) return;
      setSelectedId(sessionId);
      appliedSel.current = { project: projectId, sessionId };
      onSelectSession?.(sessionId);
      openConv(sessionId);
      setPaneOpen(true);
    },
    [isDesktop, projectId, onSelectSession, openConv],
  );

  /** 进 Web 终端视图：本项目的框架页已弹出 → 终端贴进那一页（wezterm 贴 pane，
     幂等）并聚焦持窗；否则开主窗 pane（同实例已开即聚焦；满/跨窗重复 toast
     说明）。<lg 时同上——选中会话并展开滑出层，终端才看得见。 */
  const showWebTerminal = useCallback(
    (sessionId: string, instanceId: string, label: string): void => {
      const frame = paneFrames.find((f) => f.projectId === projectId && f.state === 'active');
      if (frame) {
        const res = attachFrameView(frame.frameId, { kind: 'terminal', instanceId, label, sessionId });
        if (!res.ok && res.reason === 'limit') show('error', t('tasks.paneLimit'));
        paneFrameWindows.get(frame.frameId)?.focus();
        return;
      }
      const res = openPane({ instanceId, label, slot: 'panel', sessionId });
      if (!res.ok && res.reason === 'limit') show('error', t('tasks.paneLimit'));
      if (!res.ok && res.reason === 'other-window') show('error', t('tasks.paneOtherWindow'));
      focusOnMobile(sessionId);
    },
    [paneFrames, projectId, focusOnMobile, show, t],
  );

  /** 在默认终端打开会话：服务端 detached spawn（`claude --resume <id>`），
      独立进程不随 daemon 退出。fb 键按会话隔离——loading 在途吞连点（防重复
      spawn），成功无 toast（窗口弹出即反馈），失败 toast。
      `target` = 多终端弹窗选定的附加目标（缺省由服务端自动选落点）。
      **loading 一直挂到图标转绿**：开完先补一次会话行刷新（绿尽早到），再到
      pidAlive 为止（liveness push 补丁、超时兜底）——绿即已开（按钮同时被
      pidAlive 禁用），中间那段空窗里按钮还在转圈、点不动，不会多起一个 claude
      抢同一会话。 */
  const runOpenTerminal = useCallback(
    (sessionId: string, target?: string): void => {
      void fb.run(
        `openTerm:${sessionId}`,
        async () => {
          const row = sessionsRef.current?.find((s) => s.sessionId === sessionId);
          const label = harnessUiOf((row?.harness ?? 'claude') as Harness).label;
          // 有活实例（Web 终端 preset 下的会话就在 Runtime Host 里）→ 直接进 TUI。
          if (row?.webInstanceId) {
            showWebTerminal(sessionId, row.webInstanceId, label);
            return;
          }
          // 其他 preset 下也可能有 headless 实例（弹层里勾过）：先接上，别另起进程抢会话。
          const pid = row?.projectId;
          if (pid != null) {
            const inst = (await api.listAgentInstances(pid)).find(
              (i) => i.harnessSessionId === sessionId && (i.status === 'running' || i.status === 'starting'),
            );
            if (inst) {
              showWebTerminal(sessionId, inst.id, harnessUiOf(inst.harness as Harness).label);
              return;
            }
          }
          // 没实例：走唯一入口开会话（宿主形态归终端后端）。headless 起来后停在
          // 对话面——按钮转绿，再点一下才进 TUI（用户口径）。<lg 时对话面在滑出
          // 层里，得选中并展开才看得见（同 showWebTerminal 的移动端口径）。
          const opened = await api.openSessionTerminal(sessionId, target);
          await refreshStatus();
          if (opened.instanceId) {
            await waitWebInstance(sessionId);
            focusOnMobile(sessionId);
            return;
          }
          await waitTerminalAlive(sessionId);
        },
        { fail: (e) => t('errors.openFailed', { error: errorText(e) }) },
      );
    },
    [fb, t, refreshStatus, waitTerminalAlive, waitWebInstance, showWebTerminal, focusOnMobile],
  );

  /** 点终端按钮：现拉可附加目标（实时枚举，不复用角标轮询数据）——
   *  多个**放得下**的 → 弹窗选（满的照列但置灰，看得见原因）；0/1 个 → 直接开
   *  （自动落点自己挑放得下的 tab，全满就新开终端；拉不到列表也不阻塞打开）。 */
  const onOpenTerminal = useCallback(
    (sessionId: string): void => {
      // Web 终端没有「项目终端窗口」可选：直接走实例 attach（无实例由
      // runOpenTerminal 如实报因，按钮本身也已置灰）。
      if (webMode) {
        runOpenTerminal(sessionId);
        return;
      }
      const projectId = sessions?.find((s) => s.sessionId === sessionId)?.projectId ?? null;
      if (projectId == null) {
        runOpenTerminal(sessionId);
        return;
      }
      // 快路：会话已有屏幕定位（全局总线 terminalTopology 帧的会话→可见屏幕）
      // = 该项目必然有开着的终端，直接开（自动落点后端自己挑放得下的 tab）——
      // 省掉点击路径上的实时枚举（spawn wezterm cli ~1s）。无定位才现拉候选判断。
      const row = sessions?.find((s) => s.sessionId === sessionId);
      if (row?.terminal) {
        runOpenTerminal(sessionId);
        return;
      }
      api
        .listProjectTerminals(projectId)
        .then((targets) => {
          if (targets.filter((target) => !target.full).length > 1) {
            setTerminalPicker({ sessionId, targets });
          } else {
            runOpenTerminal(sessionId);
          }
        })
        .catch(() => runOpenTerminal(sessionId));
    },
    [sessions, runOpenTerminal, webMode],
  );
  /** 右栏主体是对话还是事件链：选中会话解不出对话面（无闭轮事件的 harness）→ 事件链。 */
  const hasConv = selectedId !== null && convs.has(selectedId);
  // 整屏对话盖住右下角：AI 浮球（`fixed bottom-4 right-4`）该退场（见 lib/conv-screen）
  useEffect(() => {
    setConvScreenOpen(!isDesktop && paneOpen && hasConv);
  }, [isDesktop, paneOpen, hasConv]);
  useEffect(() => () => setConvScreenOpen(false), []);
  // 对话面没了（换到没有对话面的会话）就收掉事件链弹窗，别让它挂在那儿
  useEffect(() => {
    if (!hasConv) setChainDialog(false);
  }, [hasConv]);

  /** 抽屉头与拖拽目标用的选中行/状态（原链态块残留的读侧，链本体已拆 SessionChainPanel）。 */
  const selectedRow = projectSessions?.find((s) => s.sessionId === selectedId);
  const activeStatus = statuses.get(selectedId ?? '') ?? 'open';

  const onDropDispatch = (dispatchId: number, sessionId: string): void => {
    const session = (sessions ?? []).find((s) => s.sessionId === sessionId);
    setPendingRun({
      dispatchId,
      sessionId,
      sessionLabel: sessionLabel(session?.title ?? null, sessionId),
    });
  };

  /** 拖拽确认执行：与待派发行内按钮同一把 fb 键——同 tick 连点/弹窗内连点都
      只 POST 一次（弹窗点击即关，按钮先于 await 卸载，天然也只有一次）。 */
  const confirmRun = (): void => {
    if (!pendingRun) return;
    const { dispatchId, sessionId } = pendingRun;
    setPendingRun(null);
    void fb.run(
      `dispatch:${dispatchId}`,
      async () => {
        await api.runHookDispatch(dispatchId, sessionId);
        await refreshStatus();
      },
      { fail: (e) => t('tasks.dispatchRunFailed', { error: errorText(e) }) },
    );
  };

  /** 删会话（手动）：先弹应用内确认（deleteTarget），确认后删（连带事件与派发）
   *  → 刷新列表 → toast。删掉的若是当前选中项，一并清选择，避免右栏挂在已消失的会话上。 */
  const [deleteTarget, setDeleteTarget] = useState<{ sessionId: string; label: string } | null>(null);
  const handleDeleteSession = useCallback(
    (sessionId: string) => {
      const row = sessions?.find((s) => s.sessionId === sessionId);
      const label = row ? sessionLabel(row.title, row.sessionId) : sessionId.slice(0, 8);
      setDeleteTarget({ sessionId, label });
    },
    [sessions],
  );
  const confirmDeleteSession = (): void => {
    if (!deleteTarget) return;
    const { sessionId } = deleteTarget;
    setDeleteTarget(null);
    void fb.run(
      `del:${sessionId}`,
      async () => {
        const res = await api.deleteSession(sessionId);
        if (selectedId === sessionId) {
          setSelectedId(null);
          appliedSel.current = { project: projectId, sessionId: null };
          onSelectSession?.(null);
        }
        await refreshStatus();
        show('success', t('toast.sessionDeleted', { n: res.events }));
      },
      { fail: (e) => t('tasks.deleteFailed', { error: errorText(e) }) },
    );
  };

  const deleteStateOf = useCallback((sessionId: string) => fb.stateOf(`del:${sessionId}`), [fb]);

  /** 右栏主体：选中会话有对话面 → 对话（事件链改从头部按钮开弹窗）；
   *  解不出能力（无闭轮事件的 harness）→ 仍是事件链本尊。 */
  const paneEl = (
    <div className="flex min-w-0 min-h-0 flex-1 flex-col">
      {/* Web 终端与对话同区（默认对话）：右栏 pane 集合（分屏 grid，拖 pane 头
          重排/拖出本窗转移）；X 只关 pane（detach），Runtime Host 里的 TUI 进程照常跑。 */}
      {panelPaneCount > 0 && (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
          <TerminalPanes slot="panel" />
        </div>
      )}
      {/* 双开告警：选中会话有多个活实例（Web 终端 PTY + 外部终端 resume）——
          两份进程写同一份转录。处置只给「关闭 Web 实例」：外部那个不是 weave
          起的进程，不碰；关完这里自然消失（下一拍 /sessions 带回新计数）。 */}
      {(() => {
        const row = sessions?.find((s) => s.sessionId === selectedId);
        if (!row || (row.liveInstances ?? 0) <= 1) return null;
        return (
          <div className="mb-1 flex shrink-0 flex-wrap items-center gap-2 rounded-md border border-red-400/30 bg-red-500/10 px-2 py-1.5 text-11 text-red-200">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-red-300" />
            <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
              {t('tasks.duplicateInstancesHint', { n: row.liveInstances ?? 0 })}
            </span>
            {row.webInstanceId && (
              <button
                type="button"
                onClick={() => handleClosePane(row.sessionId)}
                className="shrink-0 rounded border border-red-400/40 bg-red-500/10 px-2 py-0.5 text-11 text-red-200 transition-colors hover:bg-red-500/20"
              >
                {t('tasks.closeWebInstance')}
              </button>
            )}
          </div>
        );
      })()}
      {/* 已挂载的对话全在（非选中项只藏不卸，草稿与已选图片都还在） */}
      <div className={cn('flex min-h-0 min-w-0 flex-1 flex-col', panelPaneCount > 0 && 'hidden')}>
      {/* 已弹出到独立框架页的对话：占位条 + 切回（对话本体藏不卸，切回零重放）。
          与对话同生命周期——只随**选中的那个**会话显形，切走即让位。 */}
      {selectedId && poppedConvs[selectedId] && (
        <div
          key={selectedId}
          className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 rounded-md border border-dashed border-edge/[0.12] text-xs text-neutral-500"
        >
          <span className="flex items-center gap-1.5">
            <ExternalLink className="size-3.5 text-neutral-600" />
            {poppedConvs[selectedId]!.label} · {t('tasks.panePoppedOut')}
          </span>
          <button
            type="button"
            onClick={() => reclaimConversation(selectedId)}
            className="shrink-0 rounded bg-blue-500/20 px-2 py-0.5 text-xs text-blue-300 transition-colors hover:bg-blue-500/30"
          >
            {t('tasks.paneReclaim')}
          </button>
        </div>
      )}
      {[...convs.values()].map((c) => (
        <SessionMessages
          key={c.sessionId}
          embedded
          sessionId={c.sessionId}
          projectId={c.projectId}
          label={c.label}
          projectLabel={projectLabel}
          capability={c.capability}
          promptLimits={promptLimits}
          minimized={c.sessionId !== selectedId || poppedConvs[c.sessionId] != null}
          answerPending={!!questionOf(c.sessionId)}
          onOpenAnswer={() => setAnswerFor(c.sessionId)}
          onInterrupt={onInterrupt}
          interruptStateOf={interruptStateOf}
          onOpenChain={() => setChainDialog(true)}
          webTerminal={webTerminalEntry(c.sessionId)}
          onPopout={poppedConvs[c.sessionId] ? undefined : () => popoutConversation(c.sessionId)}
        />
      ))}
      {/* 能力矩阵在途时不摆事件链（openConv 还挂不上对话，摆了必闪一拍）；
          就绪后解不出能力的会话才真回落到事件链。 */}
      {!hasConv &&
        (messagingCaps === null ? (
          <p className="flex min-h-0 flex-1 items-center justify-center gap-1.5 text-xs text-neutral-600">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {t('hooks.loading')}
          </p>
        ) : (
          <SessionChainPanel sessionId={selectedId ?? ''} projectId={projectId} />
        ))}
      </div>
    </div>
  );

  return (
    <div className="flex flex-col lg:flex-row h-full min-h-0 gap-3 lg:gap-0">
      {/* 左栏：会话列表。<lg 独占全高（右栏收进全屏滑出层），桌面恒双栏、宽度可拖。 */}
      <aside
        style={isDesktop ? { width: listW } : undefined}
        className="flex w-full max-lg:min-h-0 max-lg:flex-1 lg:shrink-0 flex-col gap-2 overflow-y-auto border-r-0 lg:border-r border-edge/[0.06] pr-0 lg:pr-3"
      >
        {/* 头行容器查询（.tasks-head 见 index.css）：侧栏可拖、容器窄 ≠ 视口窄。
            恒单行不换行：退场次序（用户裁决）= 按钮文字先退（图标+tooltip 兜底）→
            下拉收缩截断（文字不隐藏）→ 计数退场 → 刷新按钮恒居右不退场。 */}
        <div className="tasks-head flex min-w-0 items-center gap-x-2">
          <h3 className="shrink-0 whitespace-nowrap text-sm font-semibold text-neutral-200">
            {t('tasks.listTitle')}
          </h3>
          <span className="new-session-count shrink-0 text-11 text-neutral-500">
            {sessions === null ? t('hooks.loading') : String(sessions.length)}
          </span>
          {/* 新建会话：不依赖已开终端——落点由终端后端自决（复用本项目的 pane
              分屏，没有就新开一个；连实例都没开时服务端报因，前端 toast 转达）。
              弹层恒列本项目选中的全部 harness（起不了的置灰并在行里说明原因），
              所以只有「一个 harness 都没接入」才置灰。 */}
          <Tooltip
            label={
              newSessionBusy
                ? t('tasks.newSessionStarting')
                : harnesses.length === 0
                  ? t('tasks.newSessionNoHarness')
                  : t('tasks.newSessionTip')
            }
            side="top"
          >
            <button
              type="button"
              disabled={!canNewSession || newSessionBusy}
              onClick={(e) => onNewSession(e.currentTarget)}
              className={cn(
                'mr-1 inline-flex min-w-0 items-center gap-1 whitespace-nowrap rounded-md border border-edge/[0.1] bg-neutral-900/90 px-2 py-0.5 text-11 transition-colors',
                !canNewSession
                  ? 'cursor-not-allowed text-neutral-600'
                  : 'text-neutral-200 hover:bg-neutral-800',
                newSessionBusy && 'cursor-progress opacity-70 hover:bg-neutral-900/90',
              )}
            >
            <FeedbackIcon
              state={fb.stateOf(`newSession:${projectId}`)}
              className="h-3 w-3 shrink-0"
              icon={<Plus className="h-3 w-3" />}
            />
            {/* 容器 <180px 按钮文字退场（图标恒在，tooltip 有全称）；宽时恢复 */}
              <span className="new-session-label min-w-0">{t('tasks.newSession')}</span>
            </button>
          </Tooltip>
          {/* harness 筛选：只过滤列表行与计数；选中态与右栏不受影响。
              窄时收缩截断（文字不隐藏，用户裁决）；trigger 内部已 truncate。 */}
          <Combobox
            value={harnessFilter}
            onChange={(v) => setHarnessFilter(v as Harness | '')}
            title={t('tasks.harnessFilterAll')}
            placeholder={t('tasks.harnessFilterAll')}
            clearLabel={t('tasks.harnessFilterAll')}
            className="min-w-0 max-w-36 shrink rounded bg-neutral-900 px-1 py-0.5 text-10"
            options={harnesses.map((h) => ({ value: h.id, label: harnessUiOf(h.id).label }))}
          />
          <RefreshIconButton
            className="ml-auto"
            title={t('tasks.refresh')}
            onClick={async () => {
              const err = await refreshStatus();
              show(err ? 'error' : 'success', err ?? t('tasks.refreshed'));
            }}
          />
        </div>
        {/* 拉取失败走全局 toast（store 层弹、自动消失），不再常驻红条 */}
        {sessions === null ? (
          // 首拉未回：会话行骨架（形状同真实行），比转圈更能顶住首屏
          <SkeletonRows rows={8} className="p-0" />
        ) : sessions.length === 0 ? (
          <p className="text-xs text-neutral-600">{t('tasks.emptySessions')}</p>
        ) : (
          <SessionList
            sessions={sessions}
            statuses={statuses}
            selectedId={selectedId}
            highlightId={highlightId}
            onSelect={focusSession}
            onRename={(id, title) => void onRename(id, title)}
            onDropDispatch={onDropDispatch}
            onOpenTerminal={onOpenTerminal}
            openTerminalStateOf={openTerminalStateOf}
            onClosePane={handleClosePane}
            closePaneStateOf={closePaneStateOf}
            capabilities={messagingCaps === null ? null : capabilityMap}
            inflightOf={inflightOf}
            failedOf={failedOf}
            questionOf={questionOf}
            onAnswer={onAnswerQuestion}
            answerStateOf={answerStateOf}
            answerFor={answerFor}
            onSetAnswerFor={setAnswerFor}
            watchOf={watchOf}
            watchStateOf={watchStateOf}
            onSubscribeWatch={onSubscribeWatch}
            onUnwatch={onUnwatch}
            onDelete={handleDeleteSession}
            deleteStateOf={deleteStateOf}
            archiveDays={archiveDays}
            webMode={webMode}
          />
        )}
      </aside>

      {/* 桌面：右栏 inline 常驻（对话，或没有对话面时的事件链） */}
      {isDesktop && (
        <>
          <Resizer
            onResize={(d) => setListW((w) => Math.min(LIST_MAX, Math.max(LIST_MIN, w + d)))}
            title={t('tasks.resizeList')}
          />
          {paneEl}
        </>
      )}

      {/* <lg：点会话 → 右栏全屏右侧滑出（同 paneEl），收起回列表。收起只藏不卸
          ——挂载态跟着走，再展开时草稿与已选图片都还在。 */}
      {!isDesktop && selectedId && (
        <div className={paneOpen ? 'fixed inset-0 z-40' : 'hidden'}>
          <div className="absolute inset-0 flex flex-col bg-neutral-950 drawer-right">
            <div className="h-11 shrink-0 flex items-center gap-2 px-4 border-b border-edge/[0.06] frosted">
              <span className="truncate text-sm font-semibold text-neutral-200">
                {sessionLabel(selectedRow?.title ?? null, selectedId)}
              </span>
              {selectedRow?.harness && (
                <span className="shrink-0">
                  <SessionStatusIcon status={activeStatus} harness={selectedRow.harness} />
                </span>
              )}
              <Tooltip label={t('app.mobileDrawerClose')} className="ml-auto" side="top">
                <button
                  onClick={() => setPaneOpen(false)}
                  className="rounded-lg p-1.5 text-neutral-500 hover:text-neutral-200 hover:bg-neutral-800/60 transition-colors"
                >
                  <X className="h-4 w-4" />
                </button>
              </Tooltip>
            </div>
            <div className="flex min-h-0 flex-1 flex-col p-3">{paneEl}</div>
          </div>
        </div>
      )}

      {/* 拖拽执行确认 */}
      {pendingRun && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="w-80 rounded-lg border border-edge/[0.1] bg-neutral-900 p-4 shadow-xl">
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
                className="rounded-md px-3 py-1.5 text-xs text-neutral-400 hover:bg-edge/[0.06]"
              >
                {t('hooks.cancel')}
              </button>
              <button
                type="button"
                onClick={confirmRun}
                className="rounded-md bg-blue-600/80 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500"
              >
                {t('hooks.runConfirmYes')}
              </button>
            </div>
          </div>
        </div>
      )}
      {/* 删会话确认弹窗：替代原生 window.confirm */}
      <ConfirmDialog
        open={deleteTarget !== null}
        title={t('tasks.deleteSession')}
        message={deleteTarget ? t('tasks.deleteConfirm', { id: deleteTarget.label }) : ''}
        confirmLabel={t('common.confirm')}
        onConfirm={confirmDeleteSession}
        onClose={() => setDeleteTarget(null)}
      />

      {/* 关 pane 确认弹窗：杀掉宿主进程，必须二次确认 */}
      <ConfirmDialog
        open={closePaneTarget !== null}
        title={t('tasks.closePaneTitle')}
        message={closePaneTarget ? t('tasks.closePaneConfirm', { id: closePaneTarget.label }) : ''}
        confirmLabel={t('common.confirm')}
        onConfirm={() => {
          if (closePaneTarget) runClosePane(closePaneTarget.sessionId);
        }}
        onClose={() => setClosePaneTarget(null)}
      />

      {/* 会话终端附加：项目开着多个终端时才弹窗选（列表按最近活跃排序） */}
      {terminalPicker && (
        <TerminalPicker
          targets={terminalPicker.targets}
          busy={fb.stateOf(`openTerm:${terminalPicker.sessionId}`) === 'loading'}
          projectId={sessions?.find((s) => s.sessionId === terminalPicker.sessionId)?.projectId ?? null}
          onPick={(targetId) => {
            const { sessionId } = terminalPicker;
            setTerminalPicker(null);
            runOpenTerminal(sessionId, targetId);
          }}
          onClose={() => setTerminalPicker(null)}
        />
      )}

      {/* 新建会话的 harness 选择（项目选中几个就列几个，起不了的置灰）：按钮下方的卡片弹层 */}
      {harnessPicker && (
        <HarnessPicker
          harnesses={harnesses}
          x={harnessPicker.x}
          y={harnessPicker.y}
          anchor={harnessPicker.anchor}
          worktree={worktreeNewSession}
          onWorktreeChange={setWorktreeNewSession}
          headless={headlessNewSession}
          onHeadlessChange={setHeadlessNewSession}
          headlessImplied={webMode}
          onPick={(harness) => {
            setHarnessPicker(null);
            runNewSession(harness);
          }}
          onClose={() => setHarnessPicker(null)}
        />
      )}

      {/* 事件链弹窗：右栏被对话占着时从这里看（右栏没有对话面时事件链仍在原位）。
          z-50 压在 <lg 的全屏右栏（z-40）之上；作答弹窗 z-60 又在它之上。 */}
      {chainDialog && hasConv && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => setChainDialog(false)}
        >
          <div
            className="flex h-[86%] w-full max-w-6xl flex-col overflow-hidden rounded-xl border border-edge/[0.08] bg-neutral-950 p-3 shadow-mac"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex shrink-0 items-center justify-end">
              <Tooltip label={t('app.mobileDrawerClose')} side="top">
                <button
                  type="button"
                  aria-label={t('app.mobileDrawerClose')}
                  onClick={() => setChainDialog(false)}
                  className="rounded-lg p-1.5 text-neutral-500 transition-colors hover:bg-neutral-800/60 hover:text-neutral-200"
                >
                  <X className="h-4 w-4" />
                </button>
              </Tooltip>
            </div>
            <div className="flex min-h-0 flex-1 flex-col">
              <SessionChainPanel sessionId={selectedId ?? ''} projectId={projectId} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
