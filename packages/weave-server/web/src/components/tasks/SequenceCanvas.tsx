import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { Harness } from '@weavecode/core/harness';
import { harnessUiOf } from '@/lib/harness-meta';
import {
  api,
  type MessagingCapability,
  type SessionMessageRow,
  type SessionRow,
  type SessionSequenceRow,
} from '@/lib/api';
import { useT } from '@/i18n/I18nProvider';
import type { MessageKey } from '@/i18n/dict';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { formatTime, sessionLabel } from '@/lib/hook-payload';
import { errorText, useActionFeedback } from '@/lib/action-feedback';
import { FeedbackIcon } from '@/components/FeedbackIcon';
import { useToast } from '@/components/Toast';
import { RefreshIconButton } from '@/components/RefreshIconButton';
import { MessageSquareText, Plus, Waypoints, X } from 'lucide-react';
import { useSessionStatus } from './session-status-store';
import { subscribeHook, type HookFrame } from '@/lib/sse';
import type { SessionStatus } from './session-status';
import { SessionStatusIcon } from './SessionStatusIcon';
import { HarnessIcon } from './HarnessIcon';
import { SessionMessages } from './SessionMessages';
import { layoutSequenceCanvas, type LaidLane } from './sequence-canvas-layout';

/**
 * 编排画布（session-orchestration 批 3 ③）：本项目会话按 harness 泳道排布
 * （在途消息计数挂在节点上）；下方 = 序列触发 builder（步 ≤3、会话与通道都按
 * 能力矩阵门控——web 只渲染不判定）+ 序列列表（进度/终态/取消）。刷新全部挂
 * SSE 总线的 hook 订阅（message.* → 线程重拉、sequence.* → 序列重拉），
 * 不新开 EventSource、不定时轮询。
 */

interface BuilderStep {
  to: string;
  text: string;
  mode: 'prompt' | 'auto' | 'inject' | 'headless';
}

const SEQ_STATUS_KEY: Record<
  SessionSequenceRow['status'],
  'tasks.statusRunning' | 'tasks.statusFailed' | 'orch.seqDone' | 'orch.seqCancelled'
> = {
  running: 'tasks.statusRunning',
  failed: 'tasks.statusFailed',
  done: 'orch.seqDone',
  cancelled: 'orch.seqCancelled',
};
const SEQ_STATUS_BADGE: Record<SessionSequenceRow['status'], string> = {
  running: 'bg-orange-900/50 text-orange-300',
  failed: 'bg-red-900/50 text-red-300',
  done: 'bg-emerald-900/40 text-emerald-300',
  cancelled: 'bg-neutral-800 text-neutral-400',
};

const MODE_KEY: Record<
  BuilderStep['mode'],
  'tasks.msgModePrompt' | 'tasks.msgModeAuto' | 'tasks.msgModeInject' | 'tasks.msgModeHeadless'
> = {
  prompt: 'tasks.msgModePrompt',
  auto: 'tasks.msgModeAuto',
  inject: 'tasks.msgModeInject',
  headless: 'tasks.msgModeHeadless',
};
const MSG_STATUS_KEY: Record<
  SessionMessageRow['status'],
  Extract<
    MessageKey,
    | 'tasks.msgStatusQueued'
    | 'tasks.msgStatusDelivering'
    | 'tasks.msgStatusInjected'
    | 'tasks.msgStatusDelivered'
    | 'tasks.msgStatusRunning'
    | 'tasks.msgStatusSucceeded'
    | 'tasks.msgStatusFailed'
    | 'tasks.msgStatusTimeout'
  >
> = {
  pending: 'tasks.msgStatusQueued',
  delivering: 'tasks.msgStatusDelivering',
  injected: 'tasks.msgStatusInjected',
  delivered: 'tasks.msgStatusDelivered',
  running: 'tasks.msgStatusRunning',
  succeeded: 'tasks.msgStatusSucceeded',
  failed: 'tasks.msgStatusFailed',
  timeout: 'tasks.msgStatusTimeout',
};

// ---------------------------------------------------------------------------
// 画布节点渲染
// ---------------------------------------------------------------------------

type SessionNodeData = {
  session: SessionRow;
  status: SessionStatus;
  capable: boolean;
  received: number;
  onOpenMessages: (sessionId: string) => void;
};
type SessionFlowNode = Node<SessionNodeData, 'seqSession'>;

function SessionNode({ data }: NodeProps<SessionFlowNode>) {
  const t = useT();
  const { session, status, capable, received, onOpenMessages } = data;
  return (
    <div
      className={cn(
        'flex w-[260px] items-center gap-2 rounded-lg border border-edge/[0.08] bg-neutral-900/95 px-2 py-1.5 shadow-mac transition-colors',
        capable ? 'cursor-pointer hover:border-blue-500/40' : 'cursor-default',
      )}
      onClick={() => capable && onOpenMessages(session.sessionId)}
      title={capable ? t('tasks.messageTooltip') : session.sessionId}
    >
      {/* 隐藏锚点仅作连线锚定：右出左入。 */}
      <Handle type="target" id="l" position={Position.Left} style={{ visibility: 'hidden' }} />
      <Handle type="source" id="r" position={Position.Right} style={{ visibility: 'hidden' }} />
      <SessionStatusIcon status={status} harness={session.harness} />
      <div className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium text-neutral-100">
          {sessionLabel(session.title, session.sessionId)}
        </span>
        <span className="block truncate text-[10px] text-neutral-500">
          {t('orch.received', { n: received })}
        </span>
      </div>
      {/* 可收消息徽标：能力真源 = 服务端 MessagingSurface 派生矩阵（表驱动）。 */}
      {capable && <MessageSquareText className="h-3 w-3 shrink-0 text-teal-400/70" />}
    </div>
  );
}

type LaneFlowNode = Node<{ lane: LaidLane }, 'seqLane'>;

function LaneNode({ data }: NodeProps<LaneFlowNode>) {
  const t = useT();
  const { lane } = data;
  return (
    <div className="flex w-[260px] items-center gap-2 border-b border-dashed border-edge/[0.1] pb-1.5">
      <HarnessIcon harness={lane.harness} />
      <span className="text-[11px] font-medium uppercase tracking-wide text-neutral-400">
        {lane.harness == null ? t('orch.unknownLane') : harnessUiOf(lane.harness).label}
      </span>
      <span className="text-[10px] text-neutral-600">{t('catbar.items', { n: lane.count })}</span>
    </div>
  );
}

const nodeTypes = { seqSession: SessionNode, seqLane: LaneNode };

// ---------------------------------------------------------------------------
// 组件
// ---------------------------------------------------------------------------

export function SequenceCanvas({
  projectId,
  projectLabel,
}: {
  projectId: number;
  /** 项目目录名（对话弹窗标题副行；CategoryDetail 按 projectId 解好）。 */
  projectLabel: string;
}) {
  const t = useT();
  const fb = useActionFeedback();
  const { show } = useToast();
  const { sessions: allSessions, statuses } = useSessionStatus();
  const sessions = useMemo(
    () => (allSessions === null ? null : allSessions.filter((s) => s.projectId === projectId)),
    [allSessions, projectId],
  );
  /** 状态总线每帧 refetch 都换数组身份——线程重拉只看会话 id 集是否真的变了。 */
  const sessionIdsKey = useMemo(
    () => (sessions ?? []).map((s) => s.sessionId).sort().join(','),
    [sessions],
  );
  const sessionsRef = useRef<SessionRow[] | null>(null);
  sessionsRef.current = sessions;

  // 消息能力矩阵（服务端 MessagingSurface 纯派生）：builder 会话/通道门控的
  // 唯一真源——web 只渲染不判定，不写死 harness 白名单。
  const [messagingCaps, setMessagingCaps] = useState<MessagingCapability[] | null>(null);
  useEffect(() => {
    api.messagingCapabilities().then(setMessagingCaps).catch(() => {});
  }, []);
  const capabilityMap = useMemo(() => {
    const m = new Map<Harness, MessagingCapability>();
    for (const c of messagingCaps ?? []) m.set(c.harness, c);
    return m;
  }, [messagingCaps]);
  const capabilityOf = useCallback(
    (sessionId: string): MessagingCapability | undefined => {
      const row = sessionsRef.current?.find((s) => s.sessionId === sessionId);
      return row?.harness != null ? capabilityMap.get(row.harness) : undefined;
    },
    [capabilityMap],
  );

  // 停止会话（对话弹窗头部那枚）：与任务视图组头同一实现。
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

  // 每会话消息线程（N 次拉取聚合）：边与收发计数都从这里派生。
  const [threads, setThreads] = useState<Map<string, SessionMessageRow[]> | null>(null);
  const refreshThreads = useCallback(async (): Promise<void> => {
    const list = sessionsRef.current;
    if (!list) return;
    try {
      const next = new Map<string, SessionMessageRow[]>();
      await Promise.all(
        list.map(async (s) => {
          next.set(s.sessionId, await api.listSessionMessages(s.sessionId));
        }),
      );
      setThreads(next);
    } catch {
      // daemon 未连：保持上次数据
    }
  }, []);
  useEffect(() => {
    setThreads(null);
    void refreshThreads();
  }, [refreshThreads, sessionIdsKey]);

  // 序列面：服务端一张全量表，这里按「任一步目标命中本项目会话」过滤。
  const [sequences, setSequences] = useState<SessionSequenceRow[] | null>(null);
  const refreshSequences = useCallback((): void => {
    api.listSessionSequences().then(setSequences).catch(() => {});
  }, []);
  useEffect(() => {
    refreshSequences();
  }, [refreshSequences, sessionIdsKey]);
  const projectSequences = useMemo(() => {
    if (!sequences) return null;
    const ids = new Set((sessions ?? []).map((s) => s.sessionId));
    return sequences.filter((seq) => seq.steps.some((step) => ids.has(step.to)));
  }, [sequences, sessions]);
  /** 步触发的在途消息（进度/终态着色）：threads 全量平铺索引（键 = 管道发号）。 */
  const messageById = useMemo(() => {
    const m = new Map<string, SessionMessageRow>();
    for (const list of threads?.values() ?? []) for (const msg of list) m.set(msg.id, msg);
    return m;
  }, [threads]);

  // SSE：message.* → 线程重拉（仅本目会话定向）；sequence.* → 序列重拉
  //（帧不带项目语义，防抖后一次 GET 足够便宜）。均 500ms 防抖合并。
  useEffect(() => {
    let threadTimer: number | null = null;
    let seqTimer: number | null = null;
    const onHook = (f: HookFrame): void => {
      if (f.kind?.startsWith('message.')) {
        const mine =
          !f.sessionId ||
          (sessionsRef.current ?? []).some((s) => s.sessionId === f.sessionId);
        if (!mine) return;
        if (threadTimer !== null) window.clearTimeout(threadTimer);
        threadTimer = window.setTimeout(() => {
          threadTimer = null;
          void refreshThreads();
        }, 500);
      } else if (f.kind?.startsWith('sequence.')) {
        if (seqTimer !== null) window.clearTimeout(seqTimer);
        seqTimer = window.setTimeout(() => {
          seqTimer = null;
          refreshSequences();
        }, 500);
      }
    };
    const off = subscribeHook(onHook, ['message.', 'sequence.']);
    return () => {
      off();
      if (threadTimer !== null) window.clearTimeout(threadTimer);
      if (seqTimer !== null) window.clearTimeout(seqTimer);
    };
  }, [refreshThreads, refreshSequences]);

  // ---- 画布 ----
  const laid = useMemo(() => layoutSequenceCanvas(sessions ?? []), [sessions]);
  /** 在途消息总量（各会话线程和；表头计数，无会话间边语义）。 */
  const inFlight = useMemo(() => {
    let n = 0;
    for (const list of threads?.values() ?? []) n += list.length;
    return n;
  }, [threads]);

  const openMessages = useCallback(
    (sessionId: string): void => {
      const row = sessionsRef.current?.find((s) => s.sessionId === sessionId);
      const capability = row?.harness != null ? capabilityMap.get(row.harness) : undefined;
      if (!row || !capability) return;
      setMessagesTarget({
        sessionId,
        projectId: row.projectId ?? projectId,
        label: sessionLabel(row.title, sessionId),
        capability,
        minimized: false,
      });
    },
    [capabilityMap, projectId],
  );

  const flowNodes: Node[] = useMemo(() => {
    const laneNodes: Node[] = laid.lanes.map((lane, i) => ({
      id: `lane:${i}`,
      type: 'seqLane',
      position: { x: lane.x, y: 0 },
      data: { lane },
      draggable: false,
      selectable: false,
    }));
    const sessionNodes: Node[] = laid.nodes.map((n) => {
      const s = n.session;
      const cap = s.harness != null ? capabilityMap.get(s.harness) : undefined;
      const thread = threads?.get(s.sessionId);
      return {
        id: n.key,
        type: 'seqSession',
        position: { x: n.x, y: n.y },
        data: {
          session: s,
          status: statuses.get(s.sessionId) ?? 'open',
          capable: !!cap && (cap.inject || cap.headless),
          received: thread?.length ?? 0,
          onOpenMessages: openMessages,
        },
        draggable: true,
      };
    });
    return [...laneNodes, ...sessionNodes];
  }, [laid, capabilityMap, statuses, threads, openMessages]);

  // ---- 触发 builder ----
  const [builderName, setBuilderName] = useState('');
  const [builderSteps, setBuilderSteps] = useState<BuilderStep[]>([
    { to: '', text: '', mode: 'auto' },
  ]);
  /** 可收消息的会话（能力矩阵门控——prompt/inject/headless 任一通道在场）。 */
  const capableSessions = useMemo(
    () =>
      (sessions ?? []).filter((s) => {
        if (s.harness == null) return false;
        const cap = capabilityMap.get(s.harness);
        return !!cap && (cap.prompt || cap.inject || cap.headless);
      }),
    [sessions, capabilityMap],
  );
  const capableKey = capableSessions.map((s) => s.sessionId).join(',');
  // 目标会话消失（删除/停采）→ 清选择保文本，模式回 auto（诚实降级，不留幽灵值）。
  useEffect(() => {
    const live = new Set(capableKey ? capableKey.split(',') : []);
    setBuilderSteps((prev) =>
      prev.some((s) => s.to !== '' && !live.has(s.to))
        ? prev.map((s) =>
            s.to !== '' && !live.has(s.to) ? { to: '', text: s.text, mode: 'auto' } : s,
          )
        : prev,
    );
  }, [capableKey]);

  const setStep = (i: number, patch: Partial<BuilderStep>): void => {
    setBuilderSteps((prev) => prev.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  };
  /** 换目标后通道若不被新会话支持 → 回 auto（门控与 SessionMessages 同口径）。 */
  const onStepTarget = (i: number, to: string): void => {
    const cap = to ? capabilityOf(to) : undefined;
    setBuilderSteps((prev) =>
      prev.map((s, j) => {
        if (j !== i) return s;
        const modeOk =
          s.mode === 'auto' ||
          (s.mode === 'prompt' && !!cap?.prompt) ||
          (s.mode === 'inject' && !!cap?.inject) ||
          (s.mode === 'headless' && !!cap?.headless);
        return modeOk ? { ...s, to } : { ...s, to, mode: 'auto' as const };
      }),
    );
  };
  const stepsValid =
    builderSteps.length > 0 && builderSteps.every((s) => s.to !== '' && s.text.trim() !== '');

  const trigger = (): void => {
    if (!stepsValid) return;
    void fb.run(
      'seq:create',
      async () => {
        await api.createSequence({
          name: builderName.trim() || undefined,
          steps: builderSteps.map((s) => ({ to: s.to, text: s.text.trim(), mode: s.mode })),
        });
        setBuilderName('');
        setBuilderSteps([{ to: '', text: '', mode: 'auto' }]);
        await Promise.all([refreshSequences(), refreshThreads()]);
      },
      { fail: (e) => t('orch.triggerFailed', { error: errorText(e) }) },
    );
  };

  const cancelSequence = (id: number): void => {
    void fb.run(
      `seqCancel:${id}`,
      async () => {
        await api.cancelSequence(id);
        await refreshSequences();
      },
      { fail: (e) => t('orch.seqCancelFailed', { error: errorText(e) }) },
    );
  };

  // ---- 序列列表 ----
  const [expandedSeqId, setExpandedSeqId] = useState<number | null>(null);

  /** 对话弹窗目标（能力矩阵按 harness 已解出该行的能力）。挂起只藏不卸，
   *  再点同一会话的入口即还原。 */
  const [messagesTarget, setMessagesTarget] = useState<{
    sessionId: string;
    projectId: number;
    label: string;
    capability: MessagingCapability;
    minimized: boolean;
  } | null>(null);

  const stepLabel = (to: string): string => {
    const row = (sessions ?? []).find((s) => s.sessionId === to);
    return sessionLabel(row?.title ?? null, to);
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Waypoints className="h-3.5 w-3.5 text-teal-400" />
        <h3 className="text-sm font-semibold text-neutral-200">{t('orch.title')}</h3>
        <span className="text-[11px] text-neutral-500">
          {threads === null ? t('hooks.loading') : t('orch.messages', { n: inFlight })}
        </span>
        <RefreshIconButton
          className="ml-auto"
          title={t('tasks.refresh')}
          onClick={() => {
            void refreshThreads();
            refreshSequences();
          }}
        />
      </div>

      {/* 画布：会话泳道 + 消息边（本视图自管高度，外层沿用页面滚动）。 */}
      <div className="relative h-[420px] rounded-lg border border-edge/[0.06] bg-neutral-950/40">
        {sessions === null ? (
          <p className="flex h-full items-center justify-center text-xs text-neutral-500">
            {t('hooks.loading')}
          </p>
        ) : sessions.length === 0 ? (
          <p className="flex h-full items-center justify-center px-6 text-center text-xs text-neutral-600">
            {t('orch.canvasEmpty')}
          </p>
        ) : (
          <ReactFlow
            nodes={flowNodes}
            nodeTypes={nodeTypes}
            fitView
            fitViewOptions={{ maxZoom: 1, padding: 0.12 }}
            minZoom={0.15}
            maxZoom={1.5}
            nodesDraggable
            nodesConnectable={false}
            deleteKeyCode={null}
          >
            <Background gap={14} size={1} color="rgba(255,255,255,0.06)" />
            <Controls showInteractive={false} />
          </ReactFlow>
        )}
        <p className="pointer-events-none absolute bottom-1 left-2 text-[10px] text-neutral-600">
          {t('orch.hint')}
        </p>
      </div>

      {/* 触发 builder：步 ≤3（hop 上限）；会话/通道均按能力矩阵门控。 */}
      <div className="rounded-lg border border-edge/[0.06] bg-edge/[0.015] p-2">
        <div className="flex flex-wrap items-center gap-2 pb-1.5">
          <span className="text-xs font-medium text-neutral-200">{t('orch.builderTitle')}</span>
          <span className="text-[10px] text-neutral-500">{t('orch.builderHint')}</span>
        </div>
        {capableSessions.length === 0 ? (
          <p className="py-1 text-[11px] text-neutral-600">{t('orch.noCapableSessions')}</p>
        ) : (
          <div className="space-y-1.5">
            <input
              value={builderName}
              onChange={(e) => setBuilderName(e.target.value)}
              placeholder={t('orch.namePlaceholder')}
              className="w-56 rounded border border-edge/[0.1] bg-neutral-950 px-2 py-1 text-[11px] text-neutral-100 placeholder:text-neutral-600 focus:outline-none focus:border-blue-500/40"
            />
            {builderSteps.map((step, i) => {
              const cap = step.to ? capabilityOf(step.to) : undefined;
              return (
                <div key={i} className="flex flex-wrap items-center gap-1.5">
                  <span className="shrink-0 rounded bg-teal-900/40 px-1.5 py-0.5 text-[10px] font-medium text-teal-300">
                    {i + 1}
                  </span>
                  <select
                    value={step.to}
                    onChange={(e) => onStepTarget(i, e.target.value)}
                    title={t('orch.stepTarget')}
                    className="shrink-0 rounded border border-edge/[0.08] bg-neutral-900 px-1.5 py-1 text-[11px] text-neutral-200"
                  >
                    <option value="">{t('orch.stepTarget')}…</option>
                    {capableSessions.map((s) => (
                      <option key={s.sessionId} value={s.sessionId}>
                        {sessionLabel(s.title, s.sessionId)}
                      </option>
                    ))}
                  </select>
                  <select
                    value={step.mode}
                    onChange={(e) => setStep(i, { mode: e.target.value as BuilderStep['mode'] })}
                    title={t('orch.stepMode')}
                    className="shrink-0 rounded border border-edge/[0.08] bg-neutral-900 px-1.5 py-1 text-[11px] text-neutral-200"
                  >
                    <option value="auto">{t('tasks.msgModeAutoHint')}</option>
                    {cap?.prompt && (
                      <option value="prompt">{t('tasks.msgModePromptHint')}</option>
                    )}
                    {cap?.inject && <option value="inject">{t('tasks.msgModeInjectHint')}</option>}
                    {cap?.headless && (
                      <option value="headless">{t('tasks.msgModeHeadlessHint')}</option>
                    )}
                  </select>
                  <input
                    value={step.text}
                    onChange={(e) => setStep(i, { text: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        trigger();
                      }
                    }}
                    placeholder={t('orch.stepText')}
                    className="min-w-[12rem] flex-1 rounded border border-edge/[0.1] bg-neutral-950 px-2 py-1 text-[11px] text-neutral-100 placeholder:text-neutral-600 focus:outline-none focus:border-blue-500/40"
                  />
                  {builderSteps.length > 1 && (
                    <button
                      type="button"
                      title={t('orch.removeStep')}
                      onClick={() =>
                        setBuilderSteps((prev) => prev.filter((_, j) => j !== i))
                      }
                      className="shrink-0 rounded p-1 text-neutral-500 transition-colors hover:bg-edge/[0.08] hover:text-neutral-200"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </div>
              );
            })}
            <div className="flex items-center gap-2 pt-0.5">
              <button
                type="button"
                disabled={builderSteps.length >= 3}
                onClick={() =>
                  setBuilderSteps((prev) =>
                    prev.length >= 3 ? prev : [...prev, { to: '', text: '', mode: 'auto' }],
                  )
                }
                className="inline-flex items-center gap-1 rounded-md border border-edge/[0.1] bg-neutral-900/90 px-2 py-1 text-[11px] text-neutral-300 transition-colors hover:bg-neutral-800 disabled:opacity-40"
              >
                <Plus className="h-3 w-3" />
                {t('orch.addStep')}
              </button>
              <button
                type="button"
                disabled={!stepsValid || fb.stateOf('seq:create') === 'loading'}
                onClick={trigger}
                className="inline-flex items-center gap-1 rounded bg-teal-700/80 px-2.5 py-1 text-[11px] font-medium text-white transition-colors hover:bg-teal-600 disabled:opacity-40"
              >
                <FeedbackIcon
                  state={fb.stateOf('seq:create')}
                  className="h-3 w-3"
                  icon={<Waypoints className="h-3 w-3" />}
                />
                {t('orch.trigger')}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* 序列列表：本项目目标的序列（进度/终态/逐步明细/取消）。 */}
      <div>
        <div className="flex items-center gap-2 pb-1.5">
          <span className="text-xs font-medium text-neutral-200">{t('orch.sequencesTitle')}</span>
          <span className="text-[11px] text-neutral-500">
            {projectSequences === null ? '' : String(projectSequences.length)}
          </span>
        </div>
        {projectSequences === null ? (
          <p className="text-xs text-neutral-600">{t('hooks.loading')}</p>
        ) : projectSequences.length === 0 ? (
          <p className="text-xs text-neutral-600">{t('orch.seqEmpty')}</p>
        ) : (
          <ul className="space-y-1.5">
            {projectSequences.map((seq) => {
              const expanded = expandedSeqId === seq.id;
              const total = seq.steps.length;
              const cur = seq.status === 'done' ? total : Math.min(seq.cursor + 1, total);
              return (
                <li
                  key={seq.id}
                  className="rounded-lg border border-edge/[0.06] bg-edge/[0.015]"
                >
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => setExpandedSeqId(expanded ? null : seq.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setExpandedSeqId(expanded ? null : seq.id);
                      }
                    }}
                    className="flex w-full cursor-pointer flex-wrap items-center gap-x-2 gap-y-1 px-2 py-1.5 text-left hover:bg-edge/[0.03]"
                  >
                    <Badge className={cn('shrink-0', SEQ_STATUS_BADGE[seq.status])}>
                      {t(SEQ_STATUS_KEY[seq.status])}
                    </Badge>
                    <span
                      className="min-w-0 flex-1 truncate text-xs text-neutral-200"
                      title={seq.name || `#${seq.id}`}
                    >
                      {seq.name || t('orch.seqNameFallback', { id: seq.id })}
                    </span>
                    <span className="shrink-0 text-[10px] text-neutral-500">
                      {t('orch.seqProgress', { cur, n: total })}
                    </span>
                    <span className="shrink-0 text-[10px] text-neutral-600">
                      {formatTime(seq.createdAt)}
                    </span>
                    {seq.status === 'running' && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          cancelSequence(seq.id);
                        }}
                        disabled={fb.stateOf(`seqCancel:${seq.id}`) === 'loading'}
                        className="inline-flex shrink-0 items-center gap-1 rounded border border-red-500/30 px-1.5 py-0.5 text-[10px] text-red-300 transition-colors hover:bg-red-950/40 disabled:opacity-40"
                      >
                        {t('orch.seqCancel')}
                      </button>
                    )}
                  </div>
                  {seq.error && (
                    <p className="break-words border-t border-edge/[0.04] px-2 py-1 text-[11px] text-red-400/80">
                      {seq.error}
                    </p>
                  )}
                  {expanded && (
                    <ul className="space-y-1 border-t border-edge/[0.04] px-2 py-1.5">
                      {seq.steps.map((step, i) => {
                        const msg = step.messageId != null ? messageById.get(step.messageId) : undefined;
                        return (
                          <li key={i} className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                            <span className="shrink-0 rounded bg-teal-900/40 px-1.5 py-px text-[10px] font-medium text-teal-300">
                              {i + 1}
                            </span>
                            <span className="shrink-0 truncate text-[11px] text-neutral-300">
                              {stepLabel(step.to)}
                            </span>
                            <Badge className="shrink-0 bg-neutral-800 text-neutral-400">
                              {t(MODE_KEY[step.mode])}
                            </Badge>
                            <Badge
                              className={cn(
                                'shrink-0',
                                msg
                                  ? msg.status === 'succeeded'
                                    ? 'bg-emerald-900/40 text-emerald-300'
                                    : msg.status === 'failed' || msg.status === 'timeout'
                                      ? 'bg-red-900/40 text-red-300'
                                      : 'bg-sky-900/40 text-sky-300'
                                  : 'bg-neutral-900 text-neutral-500',
                              )}
                            >
                              {msg ? t(MSG_STATUS_KEY[msg.status]) : t('orch.seqStepPending')}
                            </Badge>
                            <span
                              className="min-w-0 flex-1 truncate text-[11px] text-neutral-500"
                              title={step.text}
                            >
                              {step.text}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* 会话对话：用户投递 + 每轮 Stop 的最终总结（复用任务视图弹窗）；挂起只藏
          不卸，再点同一会话的入口即还原。 */}
      {messagesTarget && (
        <SessionMessages
          key={messagesTarget.sessionId}
          sessionId={messagesTarget.sessionId}
          projectId={messagesTarget.projectId}
          label={messagesTarget.label}
          projectLabel={projectLabel}
          capability={messagesTarget.capability}
          minimized={messagesTarget.minimized}
          onInterrupt={onInterrupt}
          interruptStateOf={interruptStateOf}
          onMinimize={() =>
            setMessagesTarget((t) => (t ? { ...t, minimized: true } : t))
          }
          onClose={() => setMessagesTarget(null)}
        />
      )}
    </div>
  );
}
