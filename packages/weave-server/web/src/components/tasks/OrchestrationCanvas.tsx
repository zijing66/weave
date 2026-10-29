import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Controls,
  Panel,
  ReactFlow,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  Copy,
  Globe,
  Link2,
  Maximize2,
  Minimize2,
  Plus,
  Save,
  Trash2,
  Waypoints,
  X,
  Zap,
} from 'lucide-react';
import type { Harness } from '@weavecode/core/harness';
import {
  api,
  type MessagingCapability,
  type OrchestrationNode,
  type OrchestrationRow,
  type OrchestrationRunStatus,
  type ProjectRow,
  type SessionRow,
} from '@/lib/api';
import { useT } from '@/i18n/I18nProvider';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Combobox } from '@/components/ui/combobox';
import { formatStamp, sessionLabel } from '@/lib/hook-payload';
import { errorText, useActionFeedback } from '@/lib/action-feedback';
import { FeedbackIcon } from '@/components/FeedbackIcon';
import { useToast } from '@/components/Toast';
import { RefreshIconButton } from '@/components/RefreshIconButton';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useBackPop } from '@/lib/back-pop';
import { CanvasBackground, useCanvasTintClass } from '@/components/CanvasBackground';
import { useSessionStatus } from './session-status-store';
import { SessionMessages } from './SessionMessages';
import {
  ORCH_MAX_NODES,
  addSessionNode,
  addTriggerNode,
  addWebhookNode,
  graphDirections,
  mergeOrchestrations,
  removeEdge,
  removeNode,
  validateDraft,
  type OrchDraft,
} from './orchestration-graph';
import {
  layoutOrchestrationCanvas,
} from './orchestration-canvas-layout';
import {
  RUN_STATUS_BADGE,
  RUN_STATUS_KEY,
  TRIGGER_KEY,
  asEditing,
  edgeTypes,
  emptyDraft,
  nodeTypes,
  orchIdOfRenderKey,
  serialize,
  type Editing,
} from './orchestration-canvas-nodes';
import { MessageSquare } from 'lucide-react';
import { useOrchRuns } from './use-orch-runs';
import { useOrchEdit } from './use-orch-edit';
import { useOrchOverview } from './use-orch-overview';
import { useOrchFlow } from './use-orch-flow';
import { OrchestrationSessionPicker } from './OrchestrationSessionPicker';
import { OrchestrationCronDialog } from './OrchestrationCronDialog';

/**
 * 编排画布（session-orchestration 重做版）：默认是**跨编排合并总览**——所有编排
 * 并成一张有向图（同一会话只摆一个节点，跨编排 n:n 扇入扇出，按层从左往右），
 * 只读；编排名/会话/项目筛选收窄它。编辑入口在**首节点卡片**上（点它编辑以它
 * 为入口的编排、或以它为入口新建）。选中某份编排后是编辑画布：图即编辑面。
 * 节点上的待回计数与边上的流动来自 hook 帧域的两条帧（`orchestration.run` /
 * `orchestration.delivery`，都带全量轻量态），不轮询、不新开 EventSource；
 * 下方是统一的运行日志（可筛选、可取消、可清理）。
 */


// ---------------------------------------------------------------------------
// 组件
// ---------------------------------------------------------------------------

export function OrchestrationCanvas({
  projectId,
  projects,
}: {
  /** null = 全局视图（跨项目分组）；数字 = 项目视图（只列该项目的编排）。 */
  projectId: number | null;
  projects: ProjectRow[];
}) {
  const t = useT();
  const tintClass = useCanvasTintClass();
  const fb = useActionFeedback();
  const { show } = useToast();
  const { sessions, statuses } = useSessionStatus();
  const groupProjects = projectId == null;

  const sessionById = useMemo(() => {
    const m = new Map<string, SessionRow>();
    for (const s of sessions ?? []) m.set(s.sessionId, s);
    return m;
  }, [sessions]);

  const projectName = useCallback(
    (id: number | null): string =>
      (id == null ? undefined : projects.find((p) => p.id === id)?.name) ??
      t('orch.unknownProject'),
    [projects, t],
  );

  // 消息能力矩阵（服务端 MessagingSurface 纯派生）：可编排的会话 = 有 prompt
  // 通道的那些（引擎只用 prompt 通道），web 不写死 harness 白名单。
  const [messagingCaps, setMessagingCaps] = useState<MessagingCapability[] | null>(null);
  useEffect(() => {
    api
      .messagingCapabilities()
      .then(setMessagingCaps)
      .catch(() => {});
  }, []);
  const capabilityMap = useMemo(() => {
    const m = new Map<Harness, MessagingCapability>();
    for (const c of messagingCaps ?? []) m.set(c.harness, c);
    return m;
  }, [messagingCaps]);

  // ---- 编排列表（全局共享；项目视图按起始会话所属项目过滤） ----
  const [list, setList] = useState<OrchestrationRow[] | null>(null);
  const refreshList = useCallback(async (): Promise<void> => {
    try {
      setList(await api.listOrchestrations(projectId ?? undefined));
    } catch {
      // daemon 未连：保持上次数据
    }
  }, [projectId]);
  useEffect(() => {
    setList(null);
    void refreshList();
  }, [refreshList]);

  const [editing, setEditing] = useState<Editing | null>(null);
  useEffect(() => {
    if (list === null) return;
    setEditing((prev) => {
      if (prev) {
        // 新建中的草稿不抢；选中的那份被删（或换了范围）才清掉。
        if (prev.id == null) return prev;
        return list.some((row) => row.id === prev.id) ? prev : null;
      }
      // 默认不选：总览模式展示所有编排（点节点/编排名才进入某一份）。
      return null;
    });
  }, [list]);

  const draft = editing?.draft ?? null;
  const dirty = editing != null && serialize(editing.draft) !== editing.base;
  const order = editing?.id ?? null;
  /** 画布全屏（对话弹窗同款语义）：编辑表单贴屏右侧才有地方摆。 */
  const [canvasFull, setCanvasFull] = useState(false);

  // 移动端返回键/侧滑逐层退：全屏 → 编辑中的编排（脏草稿先弹确认）→ 关画布。
  // 没开任何东西时不占返回键。
  useBackPop(canvasFull || editing != null, () => {
    if (canvasFull) {
      setCanvasFull(false);
      return true;
    }
    if (dirty) {
      setConfirmState({
        title: t('orch.dirtyCloseTitle'),
        message: t('orch.dirtyCloseConfirm'),
        confirmLabel: t('orch.dirtyCloseAction'),
        action: () => setEditing(null),
      });
      return true;
    }
    setEditing(null);
    return true;
  });

  const patch = useCallback((fn: (d: OrchDraft) => OrchDraft): void => {
    setEditing((prev) => (prev ? { ...prev, draft: fn(prev.draft) } : prev));
  }, []);

  /** 图上选中的东西（会话 id / 边的原始 id）：右侧检查器跟着它长。 */
  const [sel, setSel] = useState<{ kind: 'node' | 'edge'; id: string } | null>(null);
  /** 总览里点开的首节点（编辑/新建编排面板挂在它上面）。 */
  const [entryPick, setEntryPick] = useState<string | null>(null);
  /** 总览里点开的连接点（那条连线在各编排里的正文，只读）。 */
  const [edgeInfo, setEdgeInfo] = useState<string | null>(null);
  useEffect(() => {
    setSel(null);
    setEntryPick(null);
    setEdgeInfo(null);
  }, [order]);

  // ---- 画布范围：筛选 + 分组收起 ----
  const [sessionQuery, setSessionQuery] = useState('');
  const [projectQuery, setProjectQuery] = useState('');
  /** 总览的编排名筛选（空 = 全部编排参与合并）。 */
  const [orchQuery, setOrchQuery] = useState('');
  /** 用户亲手翻过的分组；null = 还没动过（编辑画布只展开起点所在的项目，总览全展开）。 */
  const [groupTouched, setGroupTouched] = useState<Set<number> | null>(null);

  /** 换一份编排：分组的「翻动」记录回到未动过。 */
  useEffect(() => setGroupTouched(null), [order]);

  /** 默认展开的分组 = 第一个 session 节点所属项目（没定过就都收着）。 */
  const primaryProject = useMemo(() => {
    const first = draft?.nodes.find((n) => n.kind === 'session');
    return first ? (sessionById.get(first.id)?.projectId ?? null) : null;
  }, [draft?.nodes, sessionById]);

  /** 展开集：null = 未收窄（总览默认全展开）。 */
  const expandedGroups = useMemo<ReadonlySet<number> | null>(
    () =>
      groupTouched ?? (draft ? new Set(primaryProject == null ? [] : [primaryProject]) : null),
    [groupTouched, draft, primaryProject],
  );

  /** 节点筛选谓词（编辑画布与总览共用）：会话名/节点 id 命中 + 全局视图的项目过滤。 */
  const nodeMatches = useCallback(
    (node: OrchestrationNode): boolean => {
      const q = sessionQuery.trim().toLowerCase();
      const pq = projectQuery.trim().toLowerCase();
      const row = node.kind === 'session' ? sessionById.get(node.id) : undefined;
      const label =
        node.kind === 'webhook'
          ? t('orch.webhookEntry')
          : sessionLabel(row?.title ?? null, node.id);
      if (q && !label.toLowerCase().includes(q) && !node.id.toLowerCase().includes(q)) {
        return false;
      }
      if (groupProjects && pq) {
        return projectName(row?.projectId ?? null).toLowerCase().includes(pq);
      }
      return true;
    },
    [sessionQuery, projectQuery, sessionById, groupProjects, projectName, t],
  );

  const visible = useMemo(() => {
    if (!draft) return null;
    return { nodes: draft.nodes.filter(nodeMatches), edges: draft.edges };
  }, [draft, nodeMatches]);

  /**
   * 总览（未选编排的默认面）：跨编排合并成一张图——节点按 id 去重（同一会话
   * 一个节点，跨编排 n:n 扇入扇出）、边按端点对合并；编排名筛选先收窄参与合并
   * 的编排，会话/项目筛选再裁节点（端点被裁掉的边跟着退场）。
   */
  const overview = useMemo(() => {
    if (list == null || editing != null) return null;
    const oq = orchQuery.trim().toLowerCase();
    const rows = list.filter((row) => !oq || (row.name || '').toLowerCase().includes(oq));
    const merged = mergeOrchestrations(
      rows.map((row) => ({ orchId: row.id, nodes: row.nodes, edges: row.edges })),
    );
    const nodes = merged.nodes.filter(nodeMatches);
    const nodeIds = new Set(nodes.map((n) => n.id));
    const edges = merged.edges.filter((e) => nodeIds.has(e.from) && nodeIds.has(e.to));
    return { rows, merged, nodes, edges };
  }, [list, editing, orchQuery, nodeMatches]);

  const canvasSessions = useMemo(() => {
    const m = new Map<string, { sessionId: string; title: string | null; projectId: number | null }>();
    const nodes = draft?.nodes ?? overview?.nodes ?? [];
    for (const node of nodes) {
      if (node.kind !== 'session') continue;
      const row = sessionById.get(node.id);
      m.set(node.id, {
        sessionId: node.id,
        title: row?.title ?? null,
        projectId: row?.projectId ?? null,
      });
    }
    // webhook/trigger 虚节点跟着编排走：编辑面 = 这份编排的项目；总览 = 含它的第一份编排的项目。
    for (const node of nodes) {
      if (node.kind === 'session') continue;
      const pid =
        draft != null
          ? (order != null
              ? (list?.find((r) => r.id === order)?.projectId ?? null)
              : (projectId ?? null))
          : (overview?.rows.find((r) => r.id === (overview.merged.orchIdsOf.get(node.id) ?? [])[0])
              ?.projectId ?? null);
      m.set(node.id, { sessionId: node.id, title: null, projectId: pid });
    }
    return m;
  }, [draft, overview, sessionById, order, list, projectId]);

  const groupCounts = useMemo(() => {
    const m = new Map<number, number>();
    for (const node of visible?.nodes ?? []) {
      const pid = canvasSessions.get(node.id)?.projectId ?? 0;
      m.set(pid, (m.get(pid) ?? 0) + 1);
    }
    return m;
  }, [visible, canvasSessions]);

  /** 收起的分组（counts = 当前面板的节点计数）：总览未动过 = 一个不收。 */
  const collapsedFrom = useCallback(
    (counts: ReadonlyMap<number, number>): ReadonlySet<number> => {
      if (!groupProjects) return new Set<number>();
      const open = expandedGroups ?? new Set(counts.keys());
      return new Set([...counts.keys()].filter((id) => !open.has(id)));
    },
    [groupProjects, expandedGroups],
  );

  const collapsedGroups = useMemo(
    () => collapsedFrom(groupCounts),
    [collapsedFrom, groupCounts],
  );


  // ---- 对话弹窗 ----
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

  // 判定引擎信号（边面板提示用）：决策模型配没配（settings 派生，一次拉取）。
  const [decisionConfigured, setDecisionConfigured] = useState<boolean | null>(null);
  useEffect(() => {
    api
      .getDaemonSettings()
      .then((s) => setDecisionConfigured(!!s.settings.decision?.apiKeySet || !!(s.settings.decision?.baseUrl && s.settings.decision?.model)))
      .catch(() => setDecisionConfigured(null));
  }, []);

  const [messagesTarget, setMessagesTarget] = useState<{
    sessionId: string;
    projectId: number;
    label: string;
    projectLabel: string;
    capability: MessagingCapability;
    minimized: boolean;
  } | null>(null);

  const openMessages = useCallback(
    (sessionId: string): void => {
      const row = sessionById.get(sessionId);
      const capability = row?.harness != null ? capabilityMap.get(row.harness) : undefined;
      if (!row || !capability) return;
      setMessagesTarget({
        sessionId,
        projectId: row.projectId ?? 0,
        label: sessionLabel(row.title, sessionId),
        projectLabel: projectName(row.projectId),
        capability,
        minimized: false,
      });
    },
    [sessionById, capabilityMap, projectName],
  );


  // 破坏性动作走应用内确认弹窗（原生 confirm/alert 一律不用）。
  const [confirmState, setConfirmState] = useState<{
    title: string;
    message: string;
    confirmLabel: string;
    action: () => void;
  } | null>(null);

  // 运行日志域：分页/SSE 帧/liveRuns/flash/展开详情/清理取消（hook 自持）
  const {
    runs, runStatus, setRunStatus,
    runText, setRunText, expandedRunId, runDetail, runDetailError,
    liveRuns, flash, live,
    refreshRuns, toggleRun, clearRuns, cancelRun,
    runsEl, pull,
  } = useOrchRuns({
    projectId,
    order,
    list,
    fb,
    t,
    show,
    setConfirmState,
  });

  // ---- 画布布局 ----
  const laidOverview = useMemo(() => {
    if (!overview) return null;
    const counts = new Map<number, number>();
    for (const node of overview.nodes) {
      const pid = canvasSessions.get(node.id)?.projectId ?? 0;
      counts.set(pid, (counts.get(pid) ?? 0) + 1);
    }
    const laid = layoutOrchestrationCanvas({
      nodes: overview.nodes,
      edges: overview.edges.map((e) => ({
        id: `${e.from}->${e.to}`,
        from: e.from,
        to: e.to,
        text: e.pairs[0]?.text ?? '',
      })),
      sessions: canvasSessions,
      groupProjects,
      collapsed: collapsedFrom(counts),
    });
    return { laid, counts };
  }, [overview, sessionById, canvasSessions, groupProjects, collapsedFrom]);

  // 总览画布域：合并图节点/边 + 编辑入口手势（hook 自持）
  const {
    enterOrchestration, entryOrchestrations, pickEntry, overviewFlowNodes, overviewFlowEdges,
  } = useOrchOverview({
    overview,
    laidOverview,
    flash,
    list,
    setEditing,
    setEdgeInfo,
    setEntryPick,
    openMessages,
    expandedGroups,
    setGroupTouched,
    liveRuns,
    statuses,
    sessionById,
    projectName,
    t,
  });

  // 编辑画布构建域：布局/边色调/flowNodes/flowEdges（hook 自持）
  const { laid, edgeTone, flowNodes, flowEdges } = useOrchFlow({
    visible,
    draft,
    editing,
    canvasSessions,
    groupProjects,
    collapsedGroups: collapsedGroups ?? new Set(),
    flash,
    sel,
    setSel,
    live,
    statuses,
    sessionById,
    groupCounts,
    setGroupTouched,
    projectName,
    openMessages,
    expandedGroups,
    t,
  });

  // ---- 定义编辑 ----
  const check = draft ? validateDraft(draft) : null;
  /** 项目视图的入口 session 必须属于本项目（中间节点可跨项目）；全局不限。 */
  const entryProjectsMisplaced = useMemo(() => {
    if (!draft || groupProjects) return false;
    const { entries } = graphDirections(draft.nodes, draft.edges);
    return entries.some((n) => {
      if (n.kind !== 'session') return false;
      const row = sessionById.get(n.id);
      return row == null || row.projectId !== projectId;
    });
  }, [draft, groupProjects, sessionById, projectId]);
  const canSave = !!draft && !!check?.ok && dirty && fb.stateOf('orch:save') !== 'loading';
  const [triggerText, setTriggerText] = useState('');
  /** 手动触发的入口子集（null = 全部 session 入口）；仅入口 ≥ 2 时出选择面。 */
  const [triggerEntries, setTriggerEntries] = useState<string[] | null>(null);
  const manualEntryChoices = useMemo(
    () => (draft ? graphDirections(draft.nodes, draft.edges).entries : []),
    [draft],
  );
  const [pickerOpen, setPickerOpen] = useState(false);
  const [cronOpen, setCronOpen] = useState(false);
  const [edgeError, setEdgeError] = useState<string | null>(null);

  /** 项目视图里入口 session 落到了别的项目上（中间节点跨项目是允许的）。 */
  const statusText =
    edgeError ??
    (entryProjectsMisplaced
      ? t('orch.startNeeded')
      : check && !check.ok
        ? check.error
        : t('orch.hint'));
  const statusWarn = !!edgeError || entryProjectsMisplaced || (!!check && !check.ok);

  // 编辑面操作域：加边/连线/选边/保存/删除/触发/轮换/复制端点
  /** 当前列表里这份编排的行（启用开关读它，编辑态的 enabled 不进 draft）。 */
  const current = (list ?? []).find((row) => row.id === order) ?? null;

  const {
    orchNodeIdOf, connectEdge, selectEdge,
    save, remove, trigger, rotate, copyEndpoint,
  } = useOrchEdit({
    editing,
    setEditing,
    draft,
    patch,
    check,
    setEdgeError,
    setSel,
    laid,
    projectId,
    setList,
    triggerText,
    setTriggerText,
    triggerEntries,
    fb,
    t,
    show,
    setConfirmState,
    refreshRuns,
  });

  /** 候选 = 全部受管会话（节点可跨项目，收窄到起点那一条）。 */
  const candidates = useMemo(
    () =>
      (sessions ?? []).filter((s) => {
        if (s.promptless) return false;
        const cap = s.harness != null ? capabilityMap.get(s.harness) : undefined;
        return !!cap?.prompt;
      }),
    [sessions, capabilityMap],
  );

  const nextRunAt = useMemo(
    () => (list ?? []).find((r) => r.id === order)?.nextRunAt ?? null,
    [list, order],
  );


  const livePending = live
    ? Object.values(live.pendingCounts).reduce((sum, n) => sum + n, 0)
    : 0;

  /** 编辑中的草稿是否没有任何 session 节点（纯 webhook/trigger）→ 服务端要求显式 projectId。 */
  const needsProject = !!draft && !draft.nodes.some((n) => n.kind === 'session');

  // 图上选中的东西（选中态即编辑态：节点改归属/删、边改正文/删）。
  const selNode =
    sel?.kind === 'node' && draft?.nodes.some((n) => n.id === sel.id) ? sel.id : null;
  const selNodeKind = selNode ? draft?.nodes.find((n) => n.id === selNode)?.kind ?? null : null;
  const selEdge =
    sel?.kind === 'edge' ? (draft?.edges.find((e) => e.id === sel.id) ?? null) : null;
  const selNodeOut = selNode ? (draft?.edges ?? []).filter((e) => e.from === selNode) : [];
  /** 节点显示名：session 用会话标题，webhook/trigger 用端点角色名。 */
  const nodeLabel = useCallback(
    (nodeId: string): string => {
      if (nodeId.startsWith('w:')) {
        const { entries } = draft
          ? graphDirections(draft.nodes, draft.edges)
          : { entries: [] as OrchestrationNode[] };
        return t(
          entries.some((n) => n.id === nodeId) ? 'orch.webhookEntry' : 'orch.webhookExit',
        );
      }
      if (nodeId.startsWith('t:')) return t('orch.triggerNode');
      return sessionLabel(sessionById.get(nodeId)?.title ?? null, nodeId);
    },
    [draft, sessionById, t],
  );

  return (
    <div className="space-y-3">
      {/* 画布（全屏 = 对话弹窗同款：fixed 贴满视口；放大钮在画布右上角，检查器开着时左移让位） */}
      <div
        className={cn(
          // 高度在非全屏时必须显式给（子元素全绝对定位，塌 0 = 整块画布消失）
          'relative h-[420px] rounded-lg border border-edge/[0.06]',
          tintClass,
          // 全屏铺不透明底：网格照常画，但身后页面内容不许透出来（对话弹窗同款 bg）
          canvasFull && 'fixed inset-0 z-[80] h-auto rounded-none border-0 bg-neutral-900',
        )}
      >
        <button
          type="button"
          onClick={() => setCanvasFull((v) => !v)}
          title={t(canvasFull ? 'orch.canvasExitFull' : 'orch.canvasFull')}
          aria-label={t(canvasFull ? 'orch.canvasExitFull' : 'orch.canvasFull')}
          className={cn(
            'absolute top-2 z-30 rounded border border-edge/[0.1] bg-neutral-900/90 p-1 text-neutral-400 transition-colors hover:text-neutral-100',
            // 右上角有面板就让位：检查器（w-80）> 总览的连线信息/首节点面板（w-64/w-60）。
            (selNode && draft) || selEdge
              ? 'right-[21rem]'
              : entryPick != null || edgeInfo != null
                ? 'right-[17.5rem]'
                : 'right-2',
          )}
        >
          {canvasFull ? <Minimize2 className="h-3 w-3" /> : <Maximize2 className="h-3 w-3" />}
        </button>
        {draft === null && (list === null || list.length === 0) ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
            <p className="text-xs text-neutral-600">
              {list === null ? t('hooks.loading') : t('orch.empty')}
            </p>
            {list !== null && list.length === 0 && (
              <button
                type="button"
                onClick={() =>
                  setEditing({ id: null, draft: emptyDraft(), base: serialize(emptyDraft()), projectId: projectId ?? null })
                }
                className="inline-flex items-center gap-1 rounded border border-edge/[0.1] px-2 py-1 text-11 text-neutral-300 transition-colors hover:bg-edge/[0.06]"
              >
                <Plus className="h-3 w-3" />
                {t('orch.new')}
              </button>
            )}
          </div>
        ) : draft === null && (overview == null || overview.nodes.length === 0) ? (
          <p className="flex h-full items-center justify-center px-6 text-center text-xs text-neutral-600">
            {t('orch.noMatch')}
          </p>
        ) : draft === null ? (
          /* 总览（默认面）：所有编排合并成一张图，只读；编辑入口在首节点卡片上。 */
          <ReactFlow
            key="overview"
            nodes={overviewFlowNodes}
            edges={overviewFlowEdges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            fitView
            fitViewOptions={{ maxZoom: 1, padding: 0.12 }}
            minZoom={0.15}
            maxZoom={1.5}
            nodesDraggable={false}
            nodesConnectable={false}
            deleteKeyCode={null}
            onNodeClick={(_, node) => pickEntry(orchNodeIdOf(node.id))}
            onEdgeClick={(_, edge) => setEdgeInfo(edge.id)}
            onPaneClick={() => {
              setEntryPick(null);
              setEdgeInfo(null);
            }}
          >
            <CanvasBackground />
            <Controls showInteractive={false} />
            <Panel
              position="top-left"
              // 右缘给右上角的家伙们让路（放大钮 / 首节点·连线信息面板）：
              // 面板拉伸到满宽时刷新钮不该压上它们。
              className={cn(
                'nopan space-y-1',
                entryPick != null || edgeInfo != null
                  ? 'max-w-[calc(100%-18.5rem)]'
                  : 'max-w-[calc(100%-3.5rem)]',
              )}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex max-w-full flex-wrap items-center gap-1.5">
                <Waypoints className="h-3.5 w-3.5 text-teal-400" />
                <h3 className="text-sm font-semibold text-neutral-200">{t('orch.title')}</h3>
                {liveRuns.size > 0 && (
                  <Badge className="bg-sky-900/50 text-sky-300">{t('orch.statusRunning')}</Badge>
                )}
                <RefreshIconButton
                  className="ml-auto"
                  title={t('tasks.refresh')}
                  onClick={() => {
                    void refreshList();
                    void refreshRuns();
                  }}
                />
              </div>
              <div className="flex max-w-full flex-wrap items-center gap-1.5">
                <Combobox
                  value={editing?.id != null ? String(editing.id) : ''}
                  onChange={(v) => {
                    const row = (list ?? []).find((r) => String(r.id) === v);
                    setEditing(row ? asEditing(row) : null);
                  }}
                  title={t('orch.listLabel')}
                  placeholder={list === null ? t('hooks.loading') : t('orch.overviewAll')}
                  className="min-w-[10rem] max-w-[16rem] rounded bg-neutral-900 px-1.5 py-1 text-11"
                  options={[
                    { value: '', label: t('orch.overviewAll') },
                    ...(list ?? []).map((row) => ({
                      value: String(row.id),
                      label: row.name || t('orch.untitled'),
                    })),
                  ]}
                />
                <button
                  type="button"
                  onClick={() =>
                    setEditing({ id: null, draft: emptyDraft(), base: serialize(emptyDraft()), projectId: projectId ?? null })
                  }
                  className="inline-flex items-center gap-1 rounded-md border border-edge/[0.1] bg-neutral-900/90 px-2 py-1 text-11 text-neutral-300 transition-colors hover:bg-neutral-800"
                >
                  <Plus className="h-3 w-3" />
                  {t('orch.new')}
                </button>
              </div>
              <div className="flex max-w-full flex-wrap items-center gap-1">
                <input
                  value={orchQuery}
                onChange={(e) => setOrchQuery(e.target.value)}
                placeholder={t('orch.filterOrch')}
                className="w-32 rounded border border-edge/[0.1] bg-neutral-950/90 px-1.5 py-0.5 text-xs text-neutral-100 placeholder:text-neutral-600 focus:border-blue-500/40 focus:outline-none"
              />
              {groupProjects && (
                <input
                  value={projectQuery}
                  onChange={(e) => setProjectQuery(e.target.value)}
                  placeholder={t('orch.filterProject')}
                  className="w-28 rounded border border-edge/[0.1] bg-neutral-950/90 px-1.5 py-0.5 text-xs text-neutral-100 placeholder:text-neutral-600 focus:border-blue-500/40 focus:outline-none"
                />
              )}
              <input
                value={sessionQuery}
                onChange={(e) => setSessionQuery(e.target.value)}
                placeholder={t('orch.filterSession')}
                className="w-32 rounded border border-edge/[0.1] bg-neutral-950/90 px-1.5 py-0.5 text-xs text-neutral-100 placeholder:text-neutral-600 focus:border-blue-500/40 focus:outline-none"
              />
              <span className="rounded bg-neutral-950/90 px-1.5 py-0.5 text-11 text-neutral-500">
                {t('orch.summary', {
                  nodes: overview!.nodes.length,
                  edges: overview!.edges.length,
                })}
              </span>
              </div>
            </Panel>
            {/* 首节点面板：编辑以它为入口的编排，或以它为入口新建一份。 */}
            {entryPick != null && (
              <Panel
                position="top-right"
                className="nopan w-60 space-y-1.5 rounded-lg border border-edge/[0.12] bg-neutral-900/95 p-2 shadow-mac"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex items-center gap-1">
                  <span className="min-w-0 flex-1 truncate text-11 font-medium text-neutral-100">
                    {entryPick.startsWith('w:')
                      ? t('orch.webhookEntry')
                      : sessionLabel(sessionById.get(entryPick)?.title ?? null, entryPick)}
                  </span>
                  <button
                    type="button"
                    onClick={() => setEntryPick(null)}
                    title={t('common.close')}
                    aria-label={t('common.close')}
                    className="shrink-0 rounded p-0.5 text-neutral-500 hover:text-neutral-200"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
                {entryOrchestrations(entryPick).map((row) => (
                  <button
                    key={row.id}
                    type="button"
                    onClick={() => {
                      setEntryPick(null);
                      enterOrchestration(row);
                    }}
                    className="flex w-full items-center gap-1 rounded px-1 py-1 text-left text-11 text-neutral-200 transition-colors hover:bg-edge/[0.08]"
                  >
                    <Waypoints className="h-3 w-3 shrink-0 text-teal-400" />
                    <span className="min-w-0 flex-1 truncate">
                      {row.name || t('orch.untitled')}
                    </span>
                  </button>
                ))}
                {!entryPick.startsWith('w:') && (
                  <button
                    type="button"
                    onClick={() => {
                      const d = addSessionNode(emptyDraft(), entryPick);
                      setEntryPick(null);
                      setEditing({ id: null, draft: d, base: serialize(d), projectId: projectId ?? null });
                    }}
                    className="flex w-full items-center gap-1 rounded border border-dashed border-edge/[0.14] px-1 py-1 text-left text-11 text-neutral-400 transition-colors hover:bg-edge/[0.06] hover:text-neutral-200"
                  >
                    <Plus className="h-3 w-3 shrink-0" />
                    {t('orch.newFromEntry')}
                  </button>
                )}
              </Panel>
            )}
            {/* 连接点（只读）：这条线在各份编排里的正文，点各自编排去改。 */}
            {edgeInfo != null && overview != null && (
              <Panel
                position="top-right"
                className="nopan w-64 space-y-1.5 rounded-lg border border-edge/[0.12] bg-neutral-900/95 p-2 shadow-mac"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex items-center gap-1">
                  <span className="min-w-0 flex-1 truncate text-11 font-medium text-neutral-100">
                    {nodeLabel(orchIdOfRenderKey(edgeInfo.split('->')[0] ?? '') ?? '')}
                    {' → '}
                    {nodeLabel(
                      orchIdOfRenderKey(
                        edgeInfo.slice((edgeInfo.split('->')[0] ?? '').length + 2),
                      ) ?? '',
                    )}
                  </span>
                  <button
                    type="button"
                    onClick={() => setEdgeInfo(null)}
                    title={t('common.close')}
                    aria-label={t('common.close')}
                    className="shrink-0 rounded p-0.5 text-neutral-500 hover:text-neutral-200"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
                {(() => {
                  const [fromKey, toKey] = edgeInfo.split('->');
                  const pairKey = `${orchIdOfRenderKey(fromKey ?? '')}->${orchIdOfRenderKey(toKey ?? '')}`;
                  return (overview.edges.find((e) => `${e.from}->${e.to}` === pairKey)?.pairs ?? []).map(
                    (pair) => {
                      const name =
                        list?.find((row) => row.id === pair.orchId)?.name || t('orch.untitled');
                      return (
                        <div key={`${pair.orchId}:${pair.edgeId}`} className="space-y-0.5">
                          <span className="block truncate text-11 text-neutral-500">{name}</span>
                          <p className="break-words whitespace-pre-wrap rounded bg-neutral-950 px-1.5 py-1 text-11 text-neutral-300">
                            {pair.text.trim() || t('orch.edgeTextEmpty')}
                          </p>
                        </div>
                      );
                    },
                  );
                })()}
                <p className="text-10 leading-relaxed text-neutral-600">
                  {t('orch.edgeInfoHint')}
                </p>
              </Panel>
            )}
            <Panel position="bottom-center" className="pointer-events-none max-w-[70%]">
              <p className="min-w-0 truncate text-11 text-neutral-600">
                {t('orch.overviewHint')}
              </p>
            </Panel>
          </ReactFlow>
        ) : draft.nodes.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
            <p className="text-xs text-neutral-600">{t('orch.canvasEmpty')}</p>
            <button
              type="button"
              onClick={() => setPickerOpen(true)}
              className="inline-flex items-center gap-1 rounded border border-edge/[0.1] px-2 py-1 text-11 text-neutral-300 transition-colors hover:bg-edge/[0.06]"
            >
              <Plus className="h-3 w-3" />
              {t('orch.addNode')}
            </button>
          </div>
        ) : (
          <ReactFlow
            key={editing?.id ?? 'new'}
            nodes={flowNodes}
            edges={flowEdges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            fitView
            fitViewOptions={{ maxZoom: 1, padding: 0.12 }}
            minZoom={0.15}
            maxZoom={1.5}
            nodesDraggable={false}
            nodesConnectable
            deleteKeyCode={null}
            onConnect={connectEdge}
            onNodeClick={(_, node) => {
              // 点连接点 = 选中那条连线（正文/提取就在面板里改）。
              if (node.id.startsWith('h:')) {
                selectEdge(node.id);
                return;
              }
              const nodeId = orchNodeIdOf(node.id);
              if (nodeId) setSel({ kind: 'node', id: nodeId });
            }}
            onEdgeClick={(_, edge) => selectEdge(edge.id)}
            onPaneClick={() => {
              setSel(null);
              setEdgeError(null);
            }}
          >
            <CanvasBackground />
            <Controls showInteractive={false} />
            <Panel
              position="top-left"
              // 右缘给右上角的家伙们让路（放大钮 / 贴屏检查器）：
              // 面板拉伸到满宽时刷新钮不该压上它们。
              className={cn(
                'nopan space-y-1',
                (selNode && draft) || selEdge
                  ? 'max-w-[calc(100%-22rem)]'
                  : 'max-w-[calc(100%-3.5rem)]',
              )}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex max-w-full flex-wrap items-center gap-1.5">
                <Waypoints className="h-3.5 w-3.5 text-teal-400" />
                <h3 className="text-sm font-semibold text-neutral-200">{t('orch.title')}</h3>
                {live && live.status === 'running' && (
                  <Badge className="bg-sky-900/50 text-sky-300">
                    {t('orch.statusRunning')} · {t('orch.runDeliveries', { n: live.deliveries })}
                    {livePending > 0 && ` · ${t('orch.runPending', { n: livePending })}`}
                  </Badge>
                )}
                <RefreshIconButton
                  className="ml-auto"
                  title={t('tasks.refresh')}
                  onClick={() => {
                    void refreshList();
                    void refreshRuns();
                  }}
                />
              </div>
              <div className="flex max-w-full flex-wrap items-center gap-1.5">
                <Combobox
                  value={editing?.id != null ? String(editing.id) : ''}
                  onChange={(v) => {
                    const row = (list ?? []).find((r) => String(r.id) === v);
                    setEditing(row ? asEditing(row) : null);
                  }}
                  title={t('orch.listLabel')}
                  placeholder={list === null ? t('hooks.loading') : t('orch.overviewAll')}
                  className="min-w-[10rem] max-w-[16rem] rounded bg-neutral-900 px-1.5 py-1 text-11"
                  options={[
                    { value: '', label: t('orch.overviewAll') },
                    ...(list ?? []).map((row) => ({
                      value: String(row.id),
                      label: row.name || t('orch.untitled'),
                    })),
                  ]}
                />
                <button
                  type="button"
                  onClick={() =>
                    setEditing({ id: null, draft: emptyDraft(), base: serialize(emptyDraft()), projectId: projectId ?? null })
                  }
                  className="inline-flex items-center gap-1 rounded-md border border-edge/[0.1] bg-neutral-900/90 px-2 py-1 text-11 text-neutral-300 transition-colors hover:bg-neutral-800"
                >
                  <Plus className="h-3 w-3" />
                  {t('orch.new')}
                </button>
                {editing && draft && (
                  <>
                    <input
                      value={draft.name}
                      onChange={(e) => patch((d) => ({ ...d, name: e.target.value }))}
                      placeholder={t('orch.namePlaceholder')}
                      title={t('orch.nameLabel')}
                      className="min-w-[10rem] flex-1 rounded border border-edge/[0.1] bg-neutral-950 px-2 py-1 text-xs text-neutral-100 placeholder:text-neutral-600 focus:border-blue-500/40 focus:outline-none"
                    />
                    {dirty && <span className="text-11 text-amber-400/80">{t('orch.unsaved')}</span>}
                    <button
                      type="button"
                      disabled={!canSave}
                      onClick={save}
                      title={check && !check.ok ? check.error : t('orch.save')}
                      className="inline-flex items-center gap-1 rounded-md border border-edge/[0.1] bg-neutral-900/90 px-2 py-1 text-11 text-neutral-200 transition-colors hover:bg-neutral-800 disabled:opacity-40"
                    >
                      <FeedbackIcon
                        state={fb.stateOf('orch:save')}
                        className="h-3 w-3"
                        icon={<Save className="h-3 w-3" />}
                      />
                      {t('orch.save')}
                    </button>
                    <button
                      type="button"
                      disabled={fb.stateOf('orch:delete') === 'loading'}
                      onClick={remove}
                      title={t('orch.deleteOrch')}
                      className="inline-flex items-center gap-1 rounded-md border border-red-500/30 px-2 py-1 text-11 text-red-300 transition-colors hover:bg-red-950/40 disabled:opacity-40"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                    {needsProject && (
                      <Combobox
                        value={editing.projectId != null ? String(editing.projectId) : ''}
                        onChange={(v) =>
                          setEditing((prev) =>
                            prev
                              ? { ...prev, projectId: v === '' ? null : Number(v) }
                              : prev,
                          )
                        }
                        title={t('orch.projectLabel')}
                        placeholder={t('orch.projectRequired')}
                        className="min-w-[10rem] rounded bg-neutral-900 px-1.5 py-1 text-11"
                        options={projects.map((p) => ({
                          value: String(p.id),
                          label: p.name,
                        }))}
                      />
                    )}
                  </>
                )}
              </div>
              <div className="flex max-w-full flex-wrap items-center gap-1">
              {groupProjects && (
                <input
                  value={projectQuery}
                  onChange={(e) => setProjectQuery(e.target.value)}
                  placeholder={t('orch.filterProject')}
                  className="w-28 rounded border border-edge/[0.1] bg-neutral-950/90 px-1.5 py-0.5 text-xs text-neutral-100 placeholder:text-neutral-600 focus:border-blue-500/40 focus:outline-none"
                />
              )}
              <input
                value={sessionQuery}
                onChange={(e) => setSessionQuery(e.target.value)}
                placeholder={t('orch.filterSession')}
                className="w-32 rounded border border-edge/[0.1] bg-neutral-950/90 px-1.5 py-0.5 text-xs text-neutral-100 placeholder:text-neutral-600 focus:border-blue-500/40 focus:outline-none"
              />
              <button
                type="button"
                disabled={draft.nodes.length >= ORCH_MAX_NODES}
                onClick={() => setPickerOpen(true)}
                title={t('orch.addNode')}
                className="inline-flex items-center gap-1 rounded border border-edge/[0.1] bg-neutral-950/90 px-1.5 py-0.5 text-11 text-neutral-300 transition-colors hover:bg-edge/[0.06] disabled:opacity-40"
              >
                <Plus className="h-3 w-3" />
                {t('orch.addNode')}
              </button>
              <button
                type="button"
                disabled={draft.nodes.length >= ORCH_MAX_NODES}
                onClick={() => patch(addWebhookNode)}
                title={t('orch.addWebhook')}
                className="inline-flex items-center gap-1 rounded border border-edge/[0.1] bg-neutral-950/90 px-1.5 py-0.5 text-11 text-neutral-300 transition-colors hover:bg-edge/[0.06] disabled:opacity-40"
              >
                <Globe className="h-3 w-3" />
                {t('orch.addWebhook')}
              </button>
              <button
                type="button"
                disabled={draft.nodes.length >= ORCH_MAX_NODES}
                onClick={() => patch(addTriggerNode)}
                title={t('orch.addTrigger')}
                className="inline-flex items-center gap-1 rounded border border-edge/[0.1] bg-neutral-950/90 px-1.5 py-0.5 text-11 text-neutral-300 transition-colors hover:bg-edge/[0.06] disabled:opacity-40"
              >
                <Zap className="h-3 w-3" />
                {t('orch.addTrigger')}
              </button>
              <span className="rounded bg-neutral-950/90 px-1.5 py-0.5 text-11 text-neutral-500">
                {t('orch.summary', { nodes: draft.nodes.length, edges: draft.edges.length })}
              </span>
              {visible != null && visible.nodes.length === 0 && (
                <span className="rounded bg-neutral-950/90 px-1.5 py-0.5 text-11 text-neutral-500">
                  {t('orch.noMatch')}
                </span>
              )}
              </div>
              {/* 触发行：起始消息 / 手动触发设置（入口子集 + 一次性正文）/ 定时与启用 / 触发一次。 */}
              {editing && (
              <div className="flex max-w-full flex-wrap items-center gap-1.5">
                <input
                  value={draft.startText}
                  onChange={(e) => patch((d) => ({ ...d, startText: e.target.value }))}
                  placeholder={t('orch.startTextHint')}
                  title={t('orch.startTextLabel')}
                  className="min-w-[12rem] flex-1 rounded border border-edge/[0.1] bg-neutral-950 px-2 py-1 text-xs text-neutral-100 placeholder:text-neutral-600 focus:border-blue-500/40 focus:outline-none"
                />
                {manualEntryChoices.length > 1 && (
                  <div className="flex flex-wrap items-center gap-1">
                    {manualEntryChoices.map((entry) => {
                      const checked = triggerEntries?.includes(entry.id) ?? false;
                      return (
                        <button
                          key={entry.id}
                          type="button"
                          onClick={() =>
                            setTriggerEntries((prev) => {
                              const base = prev ?? manualEntryChoices.map((n) => n.id);
                              return base.includes(entry.id)
                                ? base.filter((x) => x !== entry.id)
                                : [...base, entry.id];
                            })
                          }
                          title={nodeLabel(entry.id)}
                          className={cn(
                            'inline-flex max-w-[12rem] items-center gap-1 rounded border px-1.5 py-0.5 text-11 transition-colors',
                            checked
                              ? 'border-teal-400/40 bg-teal-500/10 text-teal-200'
                              : 'border-edge/[0.1] text-neutral-400 hover:bg-edge/[0.06]',
                          )}
                        >
                          {entry.kind === 'webhook' ? <Globe className="h-2.5 w-2.5" /> : null}
                          {entry.kind === 'trigger' ? <Zap className="h-2.5 w-2.5" /> : null}
                          <span className="min-w-0 truncate">{nodeLabel(entry.id)}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
                <input
                  value={triggerText}
                  onChange={(e) => setTriggerText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      trigger();
                    }
                  }}
                  placeholder={t('orch.triggerTextTitle')}
                  className="min-w-[10rem] flex-1 rounded border border-edge/[0.1] bg-neutral-950 px-2 py-1 text-xs text-neutral-100 placeholder:text-neutral-600 focus:border-blue-500/40 focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => setCronOpen(true)}
                  className={cn(
                    'shrink-0 rounded-md border px-2 py-1 text-11 transition-colors',
                    draft.cron
                      ? 'border-violet-400/40 bg-violet-500/10 text-violet-200'
                      : 'border-edge/[0.1] text-neutral-300 hover:bg-edge/[0.06]',
                  )}
                >
                  {draft.cron ? t('orch.cronBadge', { expr: draft.cron }) : t('orch.cronSet')}
                </button>
                {editing.id != null && current && (
                  <button
                    type="button"
                    disabled={fb.stateOf('orch:enabled') === 'loading'}
                    onClick={() => {
                      const id = editing.id!;
                      void fb.run(
                        'orch:enabled',
                        async () => {
                          const res = await api.updateOrchestration(id, { enabled: !current.enabled });
                          setList((prev) =>
                            prev?.map((row) => (row.id === id ? res.orchestration : row)) ?? prev,
                          );
                        },
                        { fail: (e) => t('orch.saveFailed', { error: errorText(e) }) },
                      );
                    }}
                    title={t('orch.enabledHint')}
                    className={cn(
                      'shrink-0 rounded-md border px-2 py-1 text-11 transition-colors',
                      current.enabled
                        ? 'border-emerald-400/40 bg-emerald-500/10 text-emerald-200'
                        : 'border-edge/[0.1] text-neutral-400 hover:bg-edge/[0.06]',
                    )}
                  >
                    {t(current.enabled ? 'orch.enabledOn' : 'orch.enabledOff')}
                  </button>
                )}
                <button
                  type="button"
                  disabled={editing.id == null || fb.stateOf('orch:trigger') === 'loading'}
                  onClick={trigger}
                  className="inline-flex items-center gap-1 rounded bg-teal-700/80 px-2.5 py-1 text-11 font-medium text-white transition-colors hover:bg-teal-600 disabled:opacity-40"
                >
                  <FeedbackIcon
                    state={fb.stateOf('orch:trigger')}
                    className="h-3 w-3"
                    icon={<Zap className="h-3 w-3" />}
                  />
                  {t('orch.triggerOnce')}
                </button>
              </div>
              )}
            </Panel>
            {/* 点节点 / 点边 = 就地编辑那一份定义（右侧贴屏检查器，上下通高）。 */}
            {((selNode && draft) || selEdge) && (
              <Panel
                position="top-right"
                className="nopan !m-0 w-80 overflow-y-auto rounded-none border-l border-edge/[0.12] bg-neutral-900/95 !bottom-0 p-2.5 shadow-mac"
                onClick={(e) => e.stopPropagation()}
              >
              {selNode && draft && selNodeKind === 'session' && (
                <div className="space-y-1.5 border-b border-edge/[0.08] pb-2.5">
                <div className="flex items-center gap-1">
                  <span className="min-w-0 flex-1 truncate text-11 font-medium text-neutral-100">
                    {sessionLabel(sessionById.get(selNode)?.title ?? null, selNode)}
                  </span>
                  <button
                    type="button"
                    onClick={() => setSel(null)}
                    title={t('common.close')}
                    aria-label={t('common.close')}
                    className="shrink-0 rounded p-0.5 text-neutral-500 hover:text-neutral-200"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
                <div className="flex flex-wrap items-center gap-1">
                  <button
                    type="button"
                    onClick={() => openMessages(selNode)}
                    className="inline-flex items-center gap-1 rounded border border-edge/[0.1] px-1.5 py-0.5 text-11 text-neutral-300 transition-colors hover:bg-edge/[0.06]"
                  >
                    <MessageSquare className="h-3 w-3" />
                    {t('orch.openChat')}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      patch((d) => removeNode(d, selNode));
                      setSel(null);
                    }}
                    className="inline-flex items-center gap-1 rounded border border-red-500/30 px-1.5 py-0.5 text-11 text-red-300 transition-colors hover:bg-red-950/40"
                  >
                    <Trash2 className="h-3 w-3" />
                    {t('orch.removeNode')}
                  </button>
                </div>
                {/* 中间节点可勾「自然回合触发下游」（入口恒可，不用勾）。 */}
                {!graphDirections(draft.nodes, draft.edges).entries.some((n) => n.id === selNode) && (
                  <button
                    type="button"
                    onClick={() =>
                      patch((d) => ({
                        ...d,
                        nodes: d.nodes.map((n) =>
                          n.id === selNode ? { ...n, autoFire: !n.autoFire } : n,
                        ),
                      }))
                    }
                    title={t('orch.autoFireHint')}
                    className={cn(
                      'w-full rounded border px-1.5 py-1 text-11 transition-colors',
                      draft.nodes.find((n) => n.id === selNode)?.autoFire
                        ? 'border-teal-400/40 bg-teal-500/10 text-teal-200'
                        : 'border-edge/[0.1] text-neutral-400 hover:bg-edge/[0.06]',
                    )}
                  >
                    {t(
                      draft.nodes.find((n) => n.id === selNode)?.autoFire
                        ? 'orch.autoFireOn'
                        : 'orch.autoFireOff',
                    )}
                  </button>
                )}
                <div className="space-y-1 border-t border-edge/[0.06] pt-1">
                  <span className="text-11 text-neutral-500">{t('orch.edgesLabel')}</span>
                  {selNodeOut.length === 0 ? (
                    <p className="text-11 text-neutral-600">{t('orch.nodeNoEdges')}</p>
                  ) : (
                    <ul className="space-y-0.5">
                      {selNodeOut.map((edge) => (
                        <li key={edge.id}>
                          <button
                            type="button"
                            onClick={() => setSel({ kind: 'edge', id: edge.id })}
                            className="flex w-full items-center gap-1 rounded px-1 py-0.5 text-left text-11 text-neutral-300 hover:bg-edge/[0.08]"
                          >
                            <Link2 className="h-2.5 w-2.5 shrink-0 text-neutral-600" />
                            <span className="min-w-0 flex-1 truncate">{nodeLabel(edge.to)}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                </div>
              )}
              {selEdge && (
                <div className="space-y-1.5 border-b border-edge/[0.08] pb-2.5">
                <div className="flex items-center gap-1">
                  <span className="min-w-0 flex-1 truncate text-11 font-medium text-neutral-100">
                    {nodeLabel(selEdge.from)}
                    {' → '}
                    {nodeLabel(selEdge.to)}
                  </span>
                  <button
                    type="button"
                    onClick={() => setSel(null)}
                    title={t('common.close')}
                    aria-label={t('common.close')}
                    className="shrink-0 rounded p-0.5 text-neutral-500 hover:text-neutral-200"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
                <textarea
                  value={selEdge.text}
                  onChange={(e) => {
                    const text = e.target.value;
                    patch((d) => ({
                      ...d,
                      edges: d.edges.map((x) => (x.id === selEdge.id ? { ...x, text } : x)),
                    }));
                  }}
                  rows={5}
                  placeholder={t('orch.edgeText')}
                  title={t('orch.edgeVars')}
                  className="w-full resize-y rounded border border-edge/[0.1] bg-neutral-950 px-1.5 py-1 text-xs text-neutral-100 placeholder:text-neutral-600 focus:border-blue-500/40 focus:outline-none"
                />
                <p className="text-10 leading-relaxed text-neutral-600">{t('orch.edgeVars')}</p>
                <textarea
                  value={selEdge.extract ?? ''}
                  onChange={(e) => {
                    const extract = e.target.value;
                    patch((d) => ({
                      ...d,
                      edges: d.edges.map((x) =>
                        x.id === selEdge.id ? { ...x, extract: extract || undefined } : x,
                      ),
                    }));
                  }}
                  rows={3}
                  placeholder={t('orch.edgeExtractHint')}
                  title={t('orch.edgeExtract')}
                  className="w-full resize-y rounded border border-edge/[0.1] bg-neutral-950 px-1.5 py-1 text-xs text-neutral-100 placeholder:text-neutral-600 focus:border-blue-500/40 focus:outline-none"
                />
                <textarea
                  value={selEdge.when ?? ''}
                  onChange={(e) => {
                    const when = e.target.value;
                    patch((d) => ({
                      ...d,
                      edges: d.edges.map((x) =>
                        x.id === selEdge.id ? { ...x, when: when || undefined } : x,
                      ),
                    }));
                  }}
                  rows={2}
                  placeholder={t('orch.edgeWhenHint')}
                  title={t('orch.edgeWhen')}
                  className="w-full resize-y rounded border border-edge/[0.1] bg-neutral-950 px-1.5 py-1 text-xs text-neutral-100 placeholder:text-neutral-600 focus:border-blue-500/40 focus:outline-none"
                />
                <textarea
                  value={selEdge.condition ?? ''}
                  onChange={(e) => {
                    const condition = e.target.value;
                    patch((d) => ({
                      ...d,
                      edges: d.edges.map((x) =>
                        x.id === selEdge.id ? { ...x, condition: condition || undefined } : x,
                      ),
                    }));
                  }}
                  rows={4}
                  placeholder={t('orch.edgeConditionHint')}
                  title={t('orch.edgeCondition')}
                  className="w-full resize-y rounded border border-edge/[0.1] bg-neutral-950 px-1.5 py-1 text-xs text-neutral-100 placeholder:text-neutral-600 focus:border-blue-500/40 focus:outline-none"
                />
                {/* 判定引擎信号：谁在判这条边（决策模型配了先问它，判不准回落 fork）。 */}
                {decisionConfigured !== null && (
                  <p className="text-10 leading-relaxed text-neutral-600">
                    {t('orch.judgeEngine')}:{' '}
                    <span className={decisionConfigured ? 'text-teal-400/80' : 'text-neutral-500'}>
                      {decisionConfigured ? t('orch.judgeEngineDecision') : t('orch.judgeEngineFork')}
                    </span>
                  </p>
                )}
                <button
                  type="button"
                  onClick={() => {
                    patch((d) => removeEdge(d, selEdge.id));
                    setSel(null);
                  }}
                  className="inline-flex items-center gap-1 rounded border border-red-500/30 px-1.5 py-0.5 text-11 text-red-300 transition-colors hover:bg-red-950/40"
                >
                  <Trash2 className="h-3 w-3" />
                  {t('orch.removeEdge')}
                </button>
                </div>
              )}
              {selNode && draft && selNodeKind === 'trigger' && (
                <div className="space-y-1.5 border-b border-edge/[0.08] pb-2.5">
                  <div className="flex items-center gap-1">
                    <span className="min-w-0 flex-1 truncate text-11 font-medium text-neutral-100">
                      {t('orch.triggerNode')}
                    </span>
                    <button
                      type="button"
                      onClick={() => setSel(null)}
                      title={t('common.close')}
                      aria-label={t('common.close')}
                      className="shrink-0 rounded p-0.5 text-neutral-500 hover:text-neutral-200"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                  <p className="text-10 leading-relaxed text-neutral-600">
                    {t('orch.triggerNodeHint')}
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      patch((d) => removeNode(d, selNode));
                      setSel(null);
                    }}
                    className="inline-flex items-center gap-1 rounded border border-red-500/30 px-1.5 py-0.5 text-11 text-red-300 transition-colors hover:bg-red-950/40"
                  >
                    <Trash2 className="h-3 w-3" />
                    {t('orch.removeNode')}
                  </button>
                </div>
              )}
              {/* webhook 节点检查器：入口管端点（复制/轮换），出口填 url/secret。 */}
              {selNode && draft && selNodeKind === 'webhook' && (
                <div className="space-y-1.5 pb-2.5">
                <div className="flex items-center gap-1">
                  <span className="min-w-0 flex-1 truncate text-11 font-medium text-neutral-100">
                    {nodeLabel(selNode)}
                  </span>
                  <button
                    type="button"
                    onClick={() => setSel(null)}
                    title={t('common.close')}
                    aria-label={t('common.close')}
                    className="shrink-0 rounded p-0.5 text-neutral-500 hover:text-neutral-200"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
                {graphDirections(draft.nodes, draft.edges).entries.some((n) => n.id === selNode) ? (
                  <>
                    {(() => {
                      const node = draft.nodes.find((n) => n.id === selNode);
                      const token = node?.webhookToken ?? null;
                      return (
                        <>
                          <code className="block truncate rounded bg-neutral-950 px-1.5 py-1 font-mono text-11 text-neutral-400">
                            {token
                              ? `${window.location.origin}/webhooks/orchestrate/${token}`
                              : t('orch.endpointMissing')}
                          </code>
                          <div className="flex flex-wrap items-center gap-1">
                            <button
                              type="button"
                              disabled={!token}
                              onClick={() => token && copyEndpoint(token)}
                              className="inline-flex items-center gap-1 rounded border border-edge/[0.1] px-1.5 py-0.5 text-11 text-neutral-300 transition-colors hover:bg-edge/[0.06] disabled:opacity-40"
                            >
                              <Copy className="h-2.5 w-2.5" />
                              {t('orch.copyEndpoint')}
                            </button>
                            {editing?.id != null && (
                              <button
                                type="button"
                                disabled={fb.stateOf('orch:rotate') === 'loading'}
                                onClick={() => rotate(selNode)}
                                className="rounded border border-edge/[0.1] px-1.5 py-0.5 text-11 text-neutral-300 transition-colors hover:bg-edge/[0.06] disabled:opacity-40"
                              >
                                {t('orch.rotate')}
                              </button>
                            )}
                          </div>
                        </>
                      );
                    })()}
                  </>
                ) : (
                  <>
                    <input
                      value={draft.nodes.find((n) => n.id === selNode)?.url ?? ''}
                      onChange={(e) => {
                        const url = e.target.value;
                        patch((d) => ({
                          ...d,
                          nodes: d.nodes.map((n) => (n.id === selNode ? { ...n, url } : n)),
                        }));
                      }}
                      placeholder={t('orch.webhookUrlHint')}
                      className="w-full rounded border border-edge/[0.1] bg-neutral-950 px-1.5 py-1 font-mono text-xs text-neutral-100 placeholder:text-neutral-600 focus:border-blue-500/40 focus:outline-none"
                    />
                    <input
                      value={draft.nodes.find((n) => n.id === selNode)?.secret ?? ''}
                      onChange={(e) => {
                        const secret = e.target.value;
                        patch((d) => ({
                          ...d,
                          nodes: d.nodes.map((n) =>
                            n.id === selNode ? { ...n, secret: secret || undefined } : n,
                          ),
                        }));
                      }}
                      placeholder={t('orch.webhookSecretHint')}
                      className="w-full rounded border border-edge/[0.1] bg-neutral-950 px-1.5 py-1 font-mono text-xs text-neutral-100 placeholder:text-neutral-600 focus:border-blue-500/40 focus:outline-none"
                    />
                  </>
                )}
                <button
                  type="button"
                  onClick={() => {
                    patch((d) => removeNode(d, selNode));
                    setSel(null);
                  }}
                  className="inline-flex items-center gap-1 rounded border border-red-500/30 px-1.5 py-0.5 text-11 text-red-300 transition-colors hover:bg-red-950/40"
                >
                  <Trash2 className="h-3 w-3" />
                  {t('orch.removeNode')}
                </button>
                </div>
              )}
              </Panel>
            )}
            {/* 状态行贴底居中：连线被拒 > 起点未定 / 校验不过 > 操作提示。 */}
            <Panel position="bottom-center" className="pointer-events-none max-w-[70%]">
              <p
                title={statusText}
                className={cn(
                  'min-w-0 truncate text-11',
                  statusWarn ? 'text-amber-400/80' : 'text-neutral-600',
                )}
              >
                {statusText}
              </p>
              {edgeTone.size > 0 && (
                <p className="truncate text-center text-10 text-neutral-600">
                  {t('orch.edgePendingHint')}
                </p>
              )}
            </Panel>
          </ReactFlow>
        )}
      </div>

      {/* 运行日志（统一视图：全局看全部，项目视图看该项目起的那些） */}
      <div>
        <div className="flex flex-wrap items-center gap-2 pb-1.5">
          <span className="text-xs font-medium text-neutral-200">{t('orch.runsTitle')}</span>
          <span className="text-11 text-neutral-500">{runs === null ? '' : runs.length}</span>
          <Combobox
            value={runStatus}
            onChange={(v) => setRunStatus(v as OrchestrationRunStatus | '')}
            title={t('orch.runStatusAll')}
            placeholder={t('orch.runStatusAll')}
            className="rounded bg-neutral-900 px-1 py-0.5 text-11"
            options={(Object.keys(RUN_STATUS_KEY) as OrchestrationRunStatus[]).map((s) => ({
              value: s,
              label: t(RUN_STATUS_KEY[s]),
            }))}
          />
          <input
            value={runText}
            onChange={(e) => setRunText(e.target.value)}
            placeholder={t('orch.runFilterName')}
            className="w-32 rounded border border-edge/[0.1] bg-neutral-950 px-1.5 py-0.5 text-xs text-neutral-100 placeholder:text-neutral-600 focus:border-blue-500/40 focus:outline-none"
          />
          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              disabled={fb.stateOf('orch:clear:finished') === 'loading'}
              onClick={() => clearRuns('finished')}
              className="rounded border border-edge/[0.1] px-1.5 py-0.5 text-11 text-neutral-300 transition-colors hover:bg-edge/[0.06] disabled:opacity-40"
            >
              {t('orch.runsClearFinished')}
            </button>
            <button
              type="button"
              disabled={fb.stateOf('orch:clear:all') === 'loading'}
              onClick={() => clearRuns('all')}
              className="rounded border border-red-500/30 px-1.5 py-0.5 text-11 text-red-300 transition-colors hover:bg-red-950/40 disabled:opacity-40"
            >
              {t('orch.runsClearAll')}
            </button>
          </div>
        </div>
        {runDetailError && (
          <p className="pb-1 text-11 text-red-400/80">
            {t('orch.runDetailFailed', { error: runDetailError })}
          </p>
        )}
        {runs === null ? (
          <p className="text-xs text-neutral-600">{t('hooks.loading')}</p>
        ) : runs.length === 0 ? (
          <p className="text-xs text-neutral-600">{t('orch.runsEmpty')}</p>
        ) : (
          <div className="relative">
            <div
              ref={runsEl}
              onScroll={pull.syncEdge}
              onWheel={(e) => pull.wheel(e.deltaY, e.deltaMode)}
              onTouchStart={(e) => pull.touchStart(e.touches[0]?.clientY ?? 0)}
              onTouchMove={(e) => pull.touchMove(e.touches[0]?.clientY ?? 0)}
              onTouchEnd={pull.touchEnd}
              onTouchCancel={pull.touchEnd}
              className="max-h-[360px] overflow-y-auto overscroll-contain"
            >
              <ul
                className="space-y-1"
                style={pull.px > 0 ? { transform: `translateY(${-pull.px}px)` } : undefined}
              >
                {runs.map((run) => {
                  const expanded = expandedRunId === run.id;
                  const detail = runDetail[run.id];
                  const row = detail ?? run;
                  const pending = Object.values(row.pendingCounts).reduce((sum, n) => sum + n, 0);
                  const events = detail?.state?.events ?? [];
                  return (
                    <li key={run.id} className="rounded-lg border border-edge/[0.06] bg-edge/[0.015]">
                      <div
                        role="button"
                        tabIndex={0}
                        onClick={() => toggleRun(run.id)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            toggleRun(run.id);
                          }
                        }}
                        className="flex w-full cursor-pointer flex-wrap items-center gap-x-2 gap-y-1 px-2 py-1.5 text-left hover:bg-edge/[0.03]"
                      >
                        <Badge className={cn('shrink-0', RUN_STATUS_BADGE[row.status])}>
                          {t(RUN_STATUS_KEY[row.status])}
                        </Badge>
                        <span className="min-w-0 flex-1 truncate text-xs text-neutral-200">
                          {row.orchestrationName || t('orch.untitled')}
                        </span>
                        <span className="shrink-0 text-11 text-neutral-500">
                          {t(TRIGGER_KEY[row.trigger])}
                        </span>
                        <span className="shrink-0 text-11 text-neutral-500">
                          {t('orch.runDeliveries', { n: row.deliveries })}
                        </span>
                        {pending > 0 && (
                          <span className="shrink-0 text-11 text-amber-400/80">
                            {t('orch.runPending', { n: pending })}
                          </span>
                        )}
                        <span
                          className="shrink-0 text-11 text-neutral-600"
                          title={`${t('orch.runStarted', { time: new Date(row.createdAt).toLocaleString() })}`}
                        >
                          {formatStamp(row.createdAt)}
                        </span>
                        {row.status === 'running' && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              cancelRun(run.id);
                            }}
                            disabled={fb.stateOf(`orch:runCancel:${run.id}`) === 'loading'}
                            className="inline-flex shrink-0 items-center gap-1 rounded border border-red-500/30 px-1.5 py-0.5 text-11 text-red-300 transition-colors hover:bg-red-950/40 disabled:opacity-40"
                          >
                            {t('orch.runCancel')}
                          </button>
                        )}
                      </div>
                      {row.error && (
                        <p className="break-words border-t border-edge/[0.04] px-2 py-1 text-11 text-red-400/80">
                          {row.error}
                        </p>
                      )}
                      {expanded && (
                        <div className="space-y-1 border-t border-edge/[0.04] px-2 py-1.5">
                          {row.finishedAt && (
                            <p className="text-11 text-neutral-600">
                              {t('orch.runFinished', {
                                time: new Date(row.finishedAt).toLocaleString(),
                              })}
                            </p>
                          )}
                          {detail == null ? (
                            <p className="text-11 text-neutral-600">{t('hooks.loading')}</p>
                          ) : events.length === 0 ? (
                            <p className="text-11 text-neutral-600">
                              {t('orch.runEventsEmpty')}
                            </p>
                          ) : (
                            <>
                              <p className="text-11 text-neutral-500">
                                {t('orch.runEvents', { n: events.length })}
                              </p>
                              <ul className="space-y-0.5">
                                {events.map((event, i) => (
                                  <li
                                    key={i}
                                    className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5"
                                  >
                                    <span className="shrink-0 font-mono text-11 text-neutral-600">
                                      {formatStamp(event.at)}
                                    </span>
                                    <span className="shrink-0 text-11 text-neutral-300">
                                      {event.from ? nodeLabel(event.from) : t('orch.triggerManual')}
                                    </span>
                                    <Link2 className="h-2.5 w-2.5 shrink-0 text-neutral-600" />
                                    <span className="shrink-0 text-11 text-neutral-300">
                                      {nodeLabel(event.to)}
                                    </span>
                                    <Badge
                                      className={cn(
                                        'shrink-0',
                                        event.ok
                                          ? event.stage === 'defer'
                                            ? 'bg-neutral-800 text-neutral-400'
                                            : event.stage === 'condition'
                                              ? 'bg-teal-900/40 text-teal-300'
                                              : 'bg-emerald-900/40 text-emerald-300'
                                          : event.stage === 'condition'
                                            ? 'bg-amber-900/40 text-amber-300'
                                            : 'bg-red-900/40 text-red-300',
                                      )}
                                    >
                                      {event.ok
                                        ? event.stage === 'defer'
                                          ? 'deferred'
                                          : event.stage === 'condition'
                                            ? 'judged'
                                            : 'ok'
                                        : event.stage === 'condition'
                                          ? 'skipped'
                                          : 'failed'}
                                    </Badge>
                                    {event.stage === 'condition' && event.source && (
                                      <Badge className="shrink-0 bg-neutral-800 text-10 text-neutral-400">
                                        {event.source === 'decision-model'
                                          ? t('orch.judgeDecision')
                                          : event.source === 'fork'
                                            ? t('orch.judgeFork')
                                            : event.source}
                                      </Badge>
                                    )}
                                    {(event.detail || event.error) && (
                                      <span
                                        className={cn(
                                          'min-w-0 flex-1 break-words text-11',
                                          event.ok
                                            ? 'text-neutral-500'
                                            : event.stage === 'condition'
                                              ? 'text-amber-400/70'
                                              : 'text-red-400/70',
                                        )}
                                      >
                                        {event.ok ? (event.detail ?? '') : (event.error ?? '')}
                                      </span>
                                    )}
                                  </li>
                                ))}
                              </ul>
                            </>
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
            {pull.px > 0 && (
              <div
                aria-hidden
                className="pointer-events-none absolute bottom-1 left-0 right-0 flex justify-center"
              >
                <span className="rounded bg-neutral-950/90 px-2 py-0.5 text-11 text-neutral-400">
                  {t('orch.runsPullHint')}
                </span>
              </div>
            )}
          </div>
        )}
      </div>

      {pickerOpen && draft && (
        <OrchestrationSessionPicker
          sessions={candidates}
          projects={projects}
          selected={new Set(draft.nodes.filter((n) => n.kind === 'session').map((n) => n.id))}
          onPick={(sessionId) => patch((d) => addSessionNode(d, sessionId))}
          onClose={() => setPickerOpen(false)}
        />
      )}

      {/* 破坏性动作的应用内确认（原生 confirm/alert 不用）。 */}
      <ConfirmDialog
        open={confirmState != null}
        title={confirmState?.title ?? ''}
        message={confirmState?.message ?? ''}
        confirmLabel={confirmState?.confirmLabel ?? ''}
        onConfirm={() => confirmState?.action()}
        onClose={() => setConfirmState(null)}
      />

      {cronOpen && draft && (
        <OrchestrationCronDialog
          expr={draft.cron}
          nextRunAt={nextRunAt}
          onApply={(expression) => {
            patch((d) => ({ ...d, cron: expression }));
            setCronOpen(false);
          }}
          onClear={() => {
            patch((d) => ({ ...d, cron: null }));
            setCronOpen(false);
          }}
          onClose={() => setCronOpen(false)}
        />
      )}

      {messagesTarget && (
        <SessionMessages
          key={messagesTarget.sessionId}
          sessionId={messagesTarget.sessionId}
          projectId={messagesTarget.projectId}
          label={messagesTarget.label}
          projectLabel={messagesTarget.projectLabel}
          capability={messagesTarget.capability}
          minimized={messagesTarget.minimized}
          onInterrupt={onInterrupt}
          interruptStateOf={interruptStateOf}
          onMinimize={() => setMessagesTarget((prev) => (prev ? { ...prev, minimized: true } : prev))}
          onClose={() => setMessagesTarget(null)}
        />
      )}
    </div>
  );
}
