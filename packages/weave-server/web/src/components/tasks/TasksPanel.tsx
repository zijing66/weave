import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Harness } from '@weavecode/core/harness';
import {
  api,
  type AnswerPick,
  type HookDispatch,
  type HookEventRow,
  type HookRule,
  type MessagingCapability,
  type ProjectHarness,
  type SessionWatchRow,
  type TerminalTarget,
  type WatchOn,
} from '@/lib/api';
import { useT } from '@/i18n/I18nProvider';
import { cn } from '@/lib/utils';
import { registerInvalidator } from '@/lib/sse';
import { HARNESS_ORDER } from '@/lib/harness-meta';
import { Badge } from '@/components/ui/badge';
import { formatTime, sessionLabel } from '@/lib/hook-payload';
import { SessionList } from './SessionList';
import { SessionMessages } from './SessionMessages';
import { TerminalPicker } from './TerminalPicker';
import { HarnessPicker } from './HarnessPicker';
import {
  buildLifecycleGroups,
  ORPHAN_GROUP_ID,
} from './build-lifecycle-groups';
import { HARNESS_LIFECYCLE } from './lifecycle';
import { canInterrupt, hasTurnSignal, isSessionBusy } from './session-status';
import { LifecycleMindmap } from '@/components/LifecycleMindmap';
import { HarnessIcon } from './HarnessIcon';
import { useSessionStatus } from './session-status-store';
import { subscribeHook, type HookFrame } from '@/lib/sse';
import { SkeletonRows } from '@/components/ui/skeleton';
import { Activity, Check, ChevronDown, ChevronRight, Copy, Loader2, Plus, Search, Square, X } from 'lucide-react';
import { useToast } from '@/components/Toast';
import { FeedbackIcon } from '@/components/FeedbackIcon';
import { RefreshIconButton } from '@/components/RefreshIconButton';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { errorText, useActionFeedback } from '@/lib/action-feedback';
import { copyText } from '@/lib/clipboard';
import { ensureNotifyPermission, type NotifyPermission } from '@/lib/browser-notify';
import { ensurePushSubscribed } from '@/lib/push';
import { useMediaQuery } from '@/lib/use-media-query';
import { usePullLoad } from '@/lib/pull-load';
import { createAwaitGate } from '@/lib/await-gate';
import type { MessageKey } from '@/i18n/dict';

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
 * 任务视图容器（项目级两栏）：左 = 会话列表（状态/计数/改名/拖拽目标），
 * 右 = 选中会话的分组组头列表（滚动窗口：默认最新 10 条、向上滚动加载更早）
 * + 单组合体事件链画布（默认全折叠，点击展开才按需挂载导图）。
 * 会话列表与状态来自全局状态总线（SessionStatusProvider）；本面板只自管事件链
 * 明细：SSE 总线的 hook 订阅驱动选中会话的事件按需刷新。
 */
export function TasksPanel({
  projectId,
  initialSessionId,
  projectLabel,
  harnesses,
}: {
  projectId: number;
  /** 初始选中会话（全局总览跳转用）；不传则默认最新会话。 */
  initialSessionId?: string;
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
    dispatches,
    statuses,
    inflight: inflightCounts,
    questions,
    refresh: refreshStatus,
  } = useSessionStatus();
  // <lg 两屏走查：列表态 ⇄ 右栏全屏态（点会话进、收起回），桌面恒双栏 inline。
  const isDesktop = useMediaQuery('(min-width: 1024px)');
  const [paneOpen, setPaneOpen] = useState(false);
  /** 事件链弹窗：右栏被对话占着时从对话头部那枚按钮开（右栏没对话面时事件链仍在原位）。 */
  const [chainDialog, setChainDialog] = useState(false);
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
  /** 待答弹窗目标（会话行图标与事件链组头/画布 tag 共开同一份；null = 关）。 */
  const [answerFor, setAnswerFor] = useState<string | null>(null);
  /** 组头列表滚动窗口：默认最新 10 条，向上滚动/点击加载更早（折叠条级）。 */
  const [groupWindow, setGroupWindow] = useState(10);
  /** 折叠条搜索：按组头可见文字过滤（开组 prompt 为主）；空串 = 不过滤。 */
  const [search, setSearch] = useState('');
  /** 全局总览跳转定位：该会话行高亮边框（3s 后移除）。 */
  const [highlightId, setHighlightId] = useState<string | null>(null);
  /** 事件游标已翻到最早（最新窗口不满一条完整批，或更早批次拉空）。 */
  const [olderExhausted, setOlderExhausted] = useState(false);
  /** 事件拉取中——空窗期不得冒充「该会话还没有采集到事件」。 */
  const [loading, setLoading] = useState(false);
  /** 事件链滚动列表（拉动加载要现读它的位置）。 */
  const listRef = useRef<HTMLDivElement | null>(null);

  /** 本项目会话：总线全量列表按 projectId 过滤（null = 首次加载中，沿用总线状态）。 */
  const sessions = useMemo(
    () => (allSessions === null ? null : allSessions.filter((s) => s.projectId === projectId)),
    [allSessions, projectId],
  );

  /** 会话行的同步影子：等「转绿」时要现读最新行，拿不到下一次 render 的闭包。 */
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  /** 「等已进入」的闸：会话行一变就 poke 一次——开终端与新建会话两个按钮的
   *  loading 都挂到命中（或超时）为止，不轮询。 */
  const gate = useRef(createAwaitGate(OPEN_TERMINAL_ALIVE_MS));
  useEffect(() => {
    gate.current.poke();
  }, [sessions]);
  useEffect(() => () => gate.current.releaseAll(), []);

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
  const waitNewSession = useCallback(
    (known: ReadonlySet<string>): Promise<void> =>
      gate.current.wait(
        `new:${projectId}`,
        () => sessionsRef.current?.some((s) => !known.has(s.sessionId)) === true,
      ),
    [projectId],
  );

  const refreshEvents = useCallback(
    async (sessionId: string) => {
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
    },
    [projectId],
  );

  useEffect(() => {
    setSelectedId(initialSessionId ?? null);
    // 全局总览跳转带入初始会话：不自动开事件链 drawer（drawer 只由点会话进入），
    // 会话行高亮边框 3s 指位后移除。
    if (initialSessionId) {
      setHighlightId(initialSessionId);
      window.setTimeout(
        () => setHighlightId((cur) => (cur === initialSessionId ? null : cur)),
        3000,
      );
    }
    api.listHooksRules(projectId).then(setRules).catch(() => {});
  }, [projectId, initialSessionId]);

  // 消息能力矩阵（服务端 MessagingSurface 纯派生）：按钮门控与弹窗模式选项的
  // 唯一真源——web 只渲染不判定，不写死 harness 白名单。完整表不过滤（不支持
  // 的面也在），行内各按钮按字段自取。
  const [messagingCaps, setMessagingCaps] = useState<MessagingCapability[] | null>(null);
  const refreshMessagingCaps = useCallback(() => {
    api.messagingCapabilities().then(setMessagingCaps).catch(() => {});
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
   *  打不进终端的原因由 409 文案说清（没开窗口、终端不支持文本）。 */
  const onInterrupt = useCallback(
    (sessionId: string): void => {
      void fb.run(
        `interrupt:${sessionId}`,
        async () => {
          await api.interruptSession(sessionId);
          show('success', t('tasks.stopOk'));
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
  useEffect(() => {
    setSelectedId((prev) => prev ?? sessions?.[0]?.sessionId ?? null);
  }, [sessions]);

  // 切会话：清空上一会话的事件与游标，全折叠 + 窗口重置回最新 10 条
  // （画布按需点开）——不清会闪现上一会话的组头。
  useEffect(() => {
    setEvents([]);
    setOlderExhausted(false);
    setExpandedGroupId('');
    setGroupWindow(10);
    setSearch('');
    if (selectedId) void refreshEvents(selectedId);
  }, [selectedId, refreshEvents]);

  // ---- SSE：总线 hook 帧（不新开 EventSource）----
  // 会话状态、会话行计数、派发列表都由全局状态总线按同一批帧维护；本面板只
  // 按需刷新选中会话的事件链（总线的防抖 refetch 会把派发/会话行一并带上）。
  useEffect(() => {
    let refreshTimer: number | null = null;
    const onHook = (f: HookFrame): void => {
      if (!selectedId || f.sessionId !== selectedId) return;
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null;
        void refreshEvents(selectedId);
      }, 500);
    };
    const off = subscribeHook(onHook);
    return () => {
      off();
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

  // 会话归属 harness：分组生命周期表按它取（D7——分组差异是 harness 知识，
  // 不写死 claude 表；无事件流/未知 harness 回落名表首项的表）。
  const selectedHarness = sessions?.find((s) => s.sessionId === selectedId)?.harness ?? null;
  const selectedLifecycle = HARNESS_LIFECYCLE[selectedHarness ?? HARNESS_ORDER[0] ?? 'claude'];

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
            selectedLifecycle,
          ).filter((g) => g.id !== ORPHAN_GROUP_ID)
            // 头部截断未翻完时，preSession 组是上一 turn 尾巴的窗口伪影
            //（「会话引导」名不副实）——翻到底（exhausted）后才是真会话引导。
            .filter((g) => !(g.preSession && !olderExhausted))
        : [],
    [selectedId, events, dispatchBySession, olderExhausted, selectedLifecycle],
  );

  const activeGroupId = useMemo(() => {
    if (expandedGroupId && groups.some((g) => g.id === expandedGroupId)) {
      return expandedGroupId;
    }
    return null; // 默认全折叠：画布点击展开才按需挂载
  }, [groups, expandedGroupId]);

  /** 折叠条搜索：按组头可见文字（开组 prompt，缺失回落首事件类型）过滤；空 query 不过滤。 */
  const query = search.trim().toLowerCase();
  const matchedGroups = useMemo(() => {
    if (!query) return null;
    return groups.filter(
      (g) =>
        (g.prompt ?? (g.preSession ? '' : g.events[0]?.eventType ?? '')).toLowerCase().includes(
          query,
        ),
    );
  }, [groups, query]);

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
          await api.openSessionTerminal(sessionId, target);
          await refreshStatus();
          await waitTerminalAlive(sessionId);
        },
        { fail: (e) => t('errors.openFailed', { error: errorText(e) }) },
      );
    },
    [fb, t, refreshStatus, waitTerminalAlive],
  );

  /** 新建会话：在项目**已打开的终端**里起一个新会话（服务端把 harness 裸 bin
      打进该项目既有 pane 的分屏；没有已开终端时 409——按钮也据此置灰）。
      fb 键按项目隔离：loading 在途吞连点，防重复 spawn。
      **loading 挂到新会话行进列表为止**（同开终端口径——「已 spawn、行还没到」的
      空窗里按钮还在转圈、点不动，不会多起一个 claude）。 */
  const runNewSession = useCallback(
    (harness?: Harness): void => {
      void fb.run(
        `newSession:${projectId}`,
        async () => {
          const known = new Set((sessionsRef.current ?? []).map((s) => s.sessionId));
          await api.startProjectSession(projectId, harness);
          await waitNewSession(known);
        },
        { fail: (e) => t('tasks.newSessionFailed', { error: errorText(e) }) },
      );
    },
    [fb, projectId, t, waitNewSession],
  );

  /** 能起交互会话的已接入 harness（本项目 init 选择结果 ∩ 有 resume 槽裸 bin）。 */
  const startableHarnesses = useMemo(
    () => harnesses.filter((h) => h.canStartSession).map((h) => h.id),
    [harnesses],
  );
  /** 多个能起的才弹窗选（同「终端附加目标」口径）；单个直接起、0 个按钮置灰。 */
  const [harnessPicker, setHarnessPicker] = useState(false);
  const canNewSession = startableHarnesses.length > 0;
  /** 起会话在途（spawn 要几秒）：按钮同置灰——只转圈不禁用的话，看着像没反应又点一次。
      连点的真去重在 `fb.run`（loading 吞重复调用），这里只是把同一事实摆到按钮上。 */
  const newSessionBusy = fb.stateOf(`newSession:${projectId}`) === 'loading';
  const onNewSession = useCallback((): void => {
    if (startableHarnesses.length > 1) {
      setHarnessPicker(true);
      return;
    }
    runNewSession(startableHarnesses[0]);
  }, [startableHarnesses, runNewSession]);

  /** 多终端选择弹窗（项目开着多个终端时才现形）。 */
  const [terminalPicker, setTerminalPicker] = useState<{
    sessionId: string;
    targets: TerminalTarget[];
  } | null>(null);

  /** 点终端按钮：现拉可附加目标（实时枚举，不复用角标轮询数据）——
   *  多个**放得下**的 → 弹窗选（满的照列但置灰，看得见原因）；0/1 个 → 直接开
   *  （自动落点自己挑放得下的 tab，全满就新开终端；拉不到列表也不阻塞打开）。 */
  const onOpenTerminal = useCallback(
    (sessionId: string): void => {
      const projectId = sessions?.find((s) => s.sessionId === sessionId)?.projectId ?? null;
      if (projectId == null) {
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
    [sessions, runOpenTerminal],
  );
  const openTerminalStateOf = useCallback(
    (sessionId: string) => fb.stateOf(`openTerm:${sessionId}`),
    [fb],
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
  /** 点会话（行本体或对话图标）= 选中它并挂上它的对话；<lg 进全屏态。 */
  const focusSession = useCallback(
    (sessionId: string): void => {
      setSelectedId(sessionId);
      openConv(sessionId);
      if (!isDesktop) setPaneOpen(true);
    },
    [openConv, isDesktop],
  );
  const closeConv = useCallback((sessionId: string): void => {
    setChainDialog(false);
    setConvs((prev) => {
      if (!prev.has(sessionId)) return prev;
      const next = new Map(prev);
      next.delete(sessionId);
      return next;
    });
  }, []);
  /** 右栏主体是对话还是事件链：选中会话解不出对话面（无闭轮事件的 harness）→ 事件链。 */
  const hasConv = selectedId !== null && convs.has(selectedId);
  // 对话面没了（关掉或换到没有对话面的会话）就收掉事件链弹窗，别让它挂在那儿
  useEffect(() => {
    if (!hasConv) setChainDialog(false);
  }, [hasConv]);

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
  /** 派发执行：fb 键按 dispatch 隔离——loading 在途吞连点防重复 POST，失败 toast。 */
  const runDispatch = useCallback(
    (dispatchId: number, sessionId: string): void => {
      void fb.run(
        `dispatch:${dispatchId}`,
        async () => {
          await api.runHookDispatch(dispatchId, sessionId);
          await refreshStatus();
        },
        { fail: (e) => t('tasks.dispatchRunFailed', { error: errorText(e) }) },
      );
    },
    [fb, refreshStatus, t],
  );

  // 组头列表滚动窗口（折叠条级）：**倒序**（最新组在顶），更早的向列表底部
  // 方向滚——触底自动加载：先扩渲染窗口（10 条/批），组已全渲染且事件游标
  // 还能往前时改拉更早事件（beforeId 翻页，前缀拼接）。
  const shownGroups = matchedGroups
    ? matchedGroups.slice().reverse()
    : groups.slice(-groupWindow).reverse();
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
  /** 拉动加载（向下那头）：触底后继续滚/拖才取更早，且一拉只取一批。 */
  const pull = usePullLoad({
    axis: 'bottom',
    getEdge: () => atListEnd(listRef.current),
    onFire: () => void loadOlderGroups(),
    enabled: hasOlder,
  });

  // 自动补拉：默认承诺「最新 10 条」——头部截断导致窗口内真组不足 10 时，
  // 静默向前翻页直到凑满或翻到底（通常一批 300 事件即够）。
  useEffect(() => {
    if (!selectedId || olderExhausted || events.length === 0) return;
    if (groups.length >= 10) return;
    void loadOlderGroups();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, groups.length, olderExhausted, events.length]);

  // 搜索态自动前翻：折叠条搜索须覆盖整条会话（只搜已加载窗口会漏）——query
  // 非空时先扩满渲染窗口，再逐批拉更早事件直到翻到底；普通浏览路径不受影响。
  useEffect(() => {
    if (!query || !selectedId || olderExhausted || events.length === 0) return;
    if (groups.length > groupWindow) {
      setGroupWindow(groups.length);
      return;
    }
    const timer = window.setTimeout(() => {
      void loadOlderGroups();
    }, 250);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, selectedId, olderExhausted, events.length, groups.length, groupWindow]);

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
    void copyText(g.prompt).then((ok) => {
      if (!ok) {
        show('error', t('common.copyFailed'));
        return;
      }
      setCopiedGroupId(g.id);
      window.setTimeout(() => setCopiedGroupId(null), 1500);
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
        if (selectedId === sessionId) setSelectedId(null);
        await refreshStatus();
        show('success', t('toast.sessionDeleted', { n: res.events }));
      },
      { fail: (e) => t('tasks.deleteFailed', { error: errorText(e) }) },
    );
  };

  const deleteStateOf = useCallback((sessionId: string) => fb.stateOf(`del:${sessionId}`), [fb]);

  // 组头状态展示：运行中显示 harness 跑马灯动效图标，打开/关闭/失败不显示
  // ——去掉原文字状态 tag（会话状态与组头信息重复）。
  const activeStatus = statuses.get(selectedId ?? '') ?? 'open';

  const selectedRow = sessions?.find((s) => s.sessionId === selectedId);

  /** 停止按钮露不露（事件链组头与对话弹窗共用同一判据）：回合开合信号不可信的
   *  harness（codex）传 undefined 让判据回落到状态。 */
  const stoppable = canInterrupt(
    activeStatus,
    hasTurnSignal(selectedRow?.harness) ? selectedRow?.turnOpen : undefined,
  );

  // 链路区（右栏）：桌面 inline 与 <lg 全屏滑出复用同一 JSX 常量（isDesktop
  // 互斥渲染，不双挂载）——展开态/滚动窗口等状态都在面板级，两态共用。
  const chainEl = (
    <section className="flex min-w-0 min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 pb-2">
        <Activity className="h-3.5 w-3.5 shrink-0 text-rose-400" />
        <h3 className="shrink-0 text-sm font-semibold text-neutral-200">{t('tasks.chainTitle')}</h3>
        <div className="relative w-36 shrink-0 lg:w-44">
          <Search className="pointer-events-none absolute left-1.5 top-1/2 h-3 w-3 -translate-y-1/2 text-neutral-600" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('tasks.searchPlaceholder')}
            className="h-6 w-full rounded border border-white/[0.08] bg-neutral-900 pl-6 pr-5 text-[11px] text-neutral-200 placeholder:text-neutral-600 focus:border-white/20 focus:outline-none"
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
          <span className="shrink-0 text-[10px] text-neutral-500">
            {t('tasks.searchMatches', { n: matchedGroups.length })}
          </span>
        )}
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
                      disabled={!target || fb.stateOf(`dispatch:${d.id}`) === 'loading'}
                      onClick={() => runDispatch(d.id, target)}
                      className="inline-flex shrink-0 items-center gap-1 rounded bg-emerald-700/80 px-2 py-0.5 text-[11px] font-medium text-white transition-colors hover:bg-emerald-600 disabled:opacity-40"
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

        {!selectedId ? (
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
          /* 事件区域：relative 外壳——遮罩 absolute 固定在区域底边（不随滚动
              流），内层滚动列表 flex-1 撑满可用高度 */
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
                <div
                  key={g.id}
                  className="shrink-0 rounded-lg border border-white/[0.06] bg-white/[0.015]"
                >
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
                    className="flex w-full flex-wrap cursor-pointer items-center gap-2 px-2 py-1.5 text-left hover:bg-white/[0.03]"
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
                      (isLatestGroup && isSessionBusy(activeStatus) ? (
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
                    {isLatestGroup && questionOf(selectedId) && (
                      <button
                        type="button"
                        title={t('tasks.answerActiveTooltip', {
                          // 不含收尾屏：它不是宿主的问题 tab
                          n: questionOf(selectedId)!.questions.filter((q) => !q.submit).length,
                        })}
                        onClick={(e) => {
                          e.stopPropagation();
                          setAnswerFor(selectedId);
                        }}
                        className="shrink-0 rounded bg-amber-900/50 px-1 py-px text-[10px] font-medium leading-tight text-amber-300 transition-colors hover:bg-amber-900/70 hover:text-amber-200"
                      >
                        {t('tasks.answerPendingTag')}
                      </button>
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
                        className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded border border-white/[0.08] bg-white/[0.02] text-neutral-500 transition-colors hover:border-white/[0.16] hover:bg-white/[0.08] hover:text-neutral-200"
                      >
                        {copiedGroupId === g.id ? (
                          <Check className="h-3 w-3 text-emerald-400" />
                        ) : (
                          <Copy className="h-3 w-3" />
                        )}
                      </button>
                    )}
                    {(isLatestGroup && g.open && isSessionBusy(activeStatus)) && (
                      <span className="shrink-0">
                        <HarnessIcon harness={selectedHarness} running />
                      </span>
                    )}
                    {/* 停止：最新组头（该会话当前那一折）上的会话级动作——回合开着才露
                        （含卡在 API 报错重试时的长静默，那是 ESC 唯一有用的一记），
                        正常收尾后不残留。判据唯一实现 = canInterrupt。 */}
                    {isLatestGroup && stoppable && (
                      <button
                        type="button"
                        title={t('tasks.stopTooltip')}
                        onClick={(e) => {
                          e.stopPropagation();
                          onInterrupt(selectedId);
                        }}
                        className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded border border-white/[0.08] bg-white/[0.02] text-neutral-500 transition-colors hover:border-white/[0.16] hover:bg-white/[0.08] hover:text-red-300"
                      >
                        <FeedbackIcon
                          state={fb.stateOf(`interrupt:${selectedId}`)}
                          className="h-3 w-3"
                          icon={<Square className="h-3 w-3" />}
                        />
                      </button>
                    )}
                  </div>
                  {expanded && (
                    <div className="h-[52dvh] min-h-[280px] lg:h-[calc(100dvh-330px)] lg:min-h-[420px] max-h-[760px] shrink-0 border-t border-white/[0.06] p-1.5">
                      {/* 画布撑满事件区域可用高度（随视口），不再固定 420px；
                          合体形态 = 该 prompt 的思维导图即事件链，逐级点开。
                          <lg 会话列表折到画布上方，330px 桌面预算失真 → 改按视口
                          比例取高，展开后组头仍在首屏内；dvh 随移动端地址栏伸缩。 */}
                      <div className="relative h-full rounded-md border border-white/[0.04] bg-neutral-950/40">
                        <LifecycleMindmap
                          key={`${selectedId}:${g.id}`}
                          projectId={projectId}
                          sessionId={selectedId}
                          harness={selectedHarness}
                          focusGroupId={g.id}
                          focusGroup={g}
                          running={isLatestGroup && isSessionBusy(activeStatus)}
                          answerable={isLatestGroup && !!questionOf(selectedId)}
                          onOpenAnswer={() => setAnswerFor(selectedId)}
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
            </div>
            {/* 底部渐变遮罩：absolute 固定在事件区域底边（不占滚动流）——
                倒序列表（最新在顶），更早 prompt 向底部滚触底自动加载 */}
            {hasOlder && (
              <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-neutral-950/95 via-neutral-950/70 to-transparent px-1 pb-1 pt-6 text-center">
                <p className="text-[10px] text-neutral-500">
                  {pull.px > 0 ? t('tasks.pullMoreEvents') : t('tasks.olderHint')}
                </p>
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
  );

  /** 右栏主体：选中会话有对话面 → 对话（事件链改从头部按钮开弹窗）；
   *  解不出能力（无闭轮事件的 harness）→ 仍是事件链本尊。 */
  const paneEl = (
    <div className="flex min-w-0 min-h-0 flex-1 flex-col">
      {/* 已挂载的对话全在（非选中项只藏不卸，草稿与已选图片都还在） */}
      {[...convs.values()].map((c) => (
        <SessionMessages
          key={c.sessionId}
          embedded
          sessionId={c.sessionId}
          projectId={c.projectId}
          label={c.label}
          projectLabel={projectLabel}
          capability={c.capability}
          minimized={c.sessionId !== selectedId}
          answerPending={!!questionOf(c.sessionId)}
          onOpenAnswer={() => setAnswerFor(c.sessionId)}
          onInterrupt={onInterrupt}
          interruptStateOf={interruptStateOf}
          onOpenChain={() => setChainDialog(true)}
          onClose={() => closeConv(c.sessionId)}
        />
      ))}
      {!hasConv && chainEl}
    </div>
  );

  return (
    <div className="flex flex-col lg:flex-row h-full min-h-0 gap-3">
      {/* 左栏：会话列表。<lg 独占全高（链路收进全屏滑出层），桌面恒双栏。 */}
      <aside className="flex w-full lg:w-72 max-lg:min-h-0 max-lg:flex-1 lg:shrink-0 flex-col gap-2 overflow-y-auto border-r-0 lg:border-r border-white/[0.06] pr-0 lg:pr-3">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-neutral-200">{t('tasks.listTitle')}</h3>
          <span className="text-[11px] text-neutral-500">
            {sessions === null ? t('hooks.loading') : String(sessions.length)}
          </span>
          {/* 新建会话：不依赖已开终端——落点由终端后端自决（复用本项目的 pane
              分屏，没有就新开一个；连实例都没开时服务端报因，前端 toast 转达）。
              起哪个 harness = 本项目已接入里能起交互会话的那些（0 个才置灰）。 */}
          <button
            type="button"
            disabled={!canNewSession || newSessionBusy}
            title={
              newSessionBusy
                ? t('tasks.newSessionStarting')
                : startableHarnesses.length === 0
                  ? t('tasks.newSessionNoHarness')
                  : t('tasks.newSessionTip')
            }
            onClick={onNewSession}
            className={cn(
              'inline-flex items-center gap-1 rounded-md border border-white/[0.1] bg-neutral-900/90 px-2 py-0.5 text-[11px] transition-colors',
              !canNewSession
                ? 'cursor-not-allowed text-neutral-600'
                : 'text-neutral-200 hover:bg-neutral-800',
              newSessionBusy && 'cursor-progress opacity-70 hover:bg-neutral-900/90',
            )}
          >
            <FeedbackIcon
              state={fb.stateOf(`newSession:${projectId}`)}
              className="h-3 w-3"
              icon={<Plus className="h-3 w-3" />}
            />
            {t('tasks.newSession')}
          </button>
          <RefreshIconButton
            className="ml-auto"
            title={t('tasks.refresh')}
            onClick={async () => {
              const err = await refreshStatus();
              show(err ? 'error' : 'success', err ?? t('tasks.refreshed'));
            }}
          />
        </div>
        {error && (
          <p className="rounded border border-red-500/30 bg-red-950/30 px-2 py-1 text-[11px] text-red-300">
            {error}
          </p>
        )}
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
            onOpenMessages={focusSession}
            inflightOf={inflightOf}
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
          />
        )}
      </aside>

      {/* 桌面：右栏 inline 常驻（对话，或没有对话面时的事件链） */}
      {isDesktop && paneEl}

      {/* <lg：点会话 → 右栏全屏右侧滑出（同 paneEl），收起回列表。收起只藏不卸
          ——挂载态跟着走，再展开时草稿与已选图片都还在。 */}
      {!isDesktop && selectedId && (
        <div className={paneOpen ? 'fixed inset-0 z-40' : 'hidden'}>
          <div className="absolute inset-0 flex flex-col bg-neutral-950 drawer-right">
            <div className="h-11 shrink-0 flex items-center gap-2 px-4 border-b border-white/[0.06] frosted">
              <span className="truncate text-sm font-semibold text-neutral-200">
                {sessionLabel(selectedRow?.title ?? null, selectedId)}
              </span>
              {selectedRow?.harness && (
                <span className="shrink-0">
                  <HarnessIcon harness={selectedRow.harness} />
                </span>
              )}
              <button
                onClick={() => setPaneOpen(false)}
                className="ml-auto rounded-lg p-1.5 text-neutral-500 hover:text-neutral-200 hover:bg-neutral-800/60 transition-colors"
                title={t('app.mobileDrawerClose')}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="flex min-h-0 flex-1 flex-col p-3">{paneEl}</div>
          </div>
        </div>
      )}

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
          onPick={(targetId) => {
            const { sessionId } = terminalPicker;
            setTerminalPicker(null);
            runOpenTerminal(sessionId, targetId);
          }}
          onClose={() => setTerminalPicker(null)}
        />
      )}

      {/* 新建会话的 harness 选择（多个能起的才现形） */}
      {harnessPicker && (
        <HarnessPicker
          harnesses={startableHarnesses}
          onPick={(harness) => {
            setHarnessPicker(false);
            runNewSession(harness);
          }}
          onClose={() => setHarnessPicker(false)}
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
            className="flex h-[86dvh] w-full max-w-6xl flex-col overflow-hidden rounded-xl border border-white/[0.08] bg-neutral-950 p-3 shadow-mac"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex shrink-0 items-center justify-end">
              <button
                type="button"
                title={t('app.mobileDrawerClose')}
                aria-label={t('app.mobileDrawerClose')}
                onClick={() => setChainDialog(false)}
                className="rounded-lg p-1.5 text-neutral-500 transition-colors hover:bg-neutral-800/60 hover:text-neutral-200"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="flex min-h-0 flex-1 flex-col">{chainEl}</div>
          </div>
        </div>
      )}
    </div>
  );
}
