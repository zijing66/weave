import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Controls,
  Handle,
  MarkerType,
  Panel,
  Position,
  ReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  ChevronDown,
  ChevronRight,
  Copy,
  Globe,
  Link2,
  MessageSquare,
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
  type OrchestrationRunRow,
  type OrchestrationRunStatus,
  type OrchestrationTrigger,
  type ProjectRow,
  type SessionRow,
} from '@/lib/api';
import { useT } from '@/i18n/I18nProvider';
import type { MessageKey } from '@/i18n/dict';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Combobox } from '@/components/ui/combobox';
import { formatStamp, sessionLabel } from '@/lib/hook-payload';
import { errorText, useActionFeedback } from '@/lib/action-feedback';
import { FeedbackIcon } from '@/components/FeedbackIcon';
import { useToast } from '@/components/Toast';
import { RefreshIconButton } from '@/components/RefreshIconButton';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { copyText } from '@/lib/clipboard';
import { usePullLoad } from '@/lib/pull-load';
import { CanvasBackground, useCanvasTintClass } from '@/components/CanvasBackground';
import { useSessionStatus } from './session-status-store';
import { subscribeHook, type HookFrame } from '@/lib/sse';
import type { SessionStatus } from './session-status';
import { SessionStatusIcon } from './SessionStatusIcon';
import { SessionMessages } from './SessionMessages';
import {
  ORCH_MAX_EDGES,
  ORCH_MAX_NODES,
  addEdge,
  addSessionNode,
  addWebhookNode,
  findCycle,
  graphDirections,
  removeEdge,
  removeNode,
  validateDraft,
  type OrchDraft,
} from './orchestration-graph';
import {
  ORCH_GROUP_HEADER_H,
  ORCH_NODE_H,
  ORCH_NODE_W,
  layoutOrchestrationCanvas,
  type OrchLaidEdge,
} from './orchestration-canvas-layout';
import { OrchestrationSessionPicker } from './OrchestrationSessionPicker';
import { OrchestrationCronDialog } from './OrchestrationCronDialog';

/**
 * 编排画布（session-orchestration 重做版）：一份命名编排 = 一张任意有向图，
 * 画布只摆**这份编排里的会话**（项目视图平铺；全局视图按项目分组、默认收起，
 * 点项目头展开）。节点上的待回计数与边上的流动来自 hook 帧域的两条帧
 * （`orchestration.run` / `orchestration.delivery`，都带全量轻量态），不轮询、
 * 不新开 EventSource。定义就编辑在图上（节点/边检查器）与画布上方的工具条里；
 * 下方是统一的运行日志（可筛选、可取消、可清理）。
 */

/** 一次投递的点亮时长（边与节点同口径）。 */
const FLASH_MS = 1200;
/** 运行日志一页条数。 */
const RUN_PAGE = 30;

const RUN_STATUS_KEY: Record<OrchestrationRunStatus, MessageKey> = {
  running: 'orch.statusRunning',
  done: 'orch.statusDone',
  failed: 'orch.statusFailed',
  cancelled: 'orch.statusCancelled',
  interrupted: 'orch.statusInterrupted',
};
const RUN_STATUS_BADGE: Record<OrchestrationRunStatus, string> = {
  running: 'bg-sky-900/50 text-sky-300',
  done: 'bg-emerald-900/40 text-emerald-300',
  failed: 'bg-red-900/40 text-red-300',
  cancelled: 'bg-neutral-800 text-neutral-400',
  interrupted: 'bg-amber-900/40 text-amber-300',
};
const TRIGGER_KEY: Record<OrchestrationTrigger, MessageKey> = {
  manual: 'orch.triggerManual',
  webhook: 'orch.triggerWebhook',
  cron: 'orch.triggerCron',
};

const emptyDraft = (): OrchDraft => ({
  name: '',
  startText: '',
  nodes: [],
  edges: [],
  cron: null,
});

const draftOf = (row: OrchestrationRow): OrchDraft => ({
  name: row.name,
  startText: row.startText,
  nodes: row.nodes.map((n) => ({ ...n })),
  edges: row.edges.map((e) => ({ ...e })),
  cron: row.cron,
});

/** 脏判定用：字段序固定，比较的只是内容。 */
const serialize = (draft: OrchDraft): string =>
  JSON.stringify([
    draft.name,
    draft.startText,
    draft.nodes.map((n) => [n.id, n.kind, n.webhookToken ?? '', n.url ?? '', n.secret ?? '']),
    draft.edges.map((e) => [e.id, e.from, e.to, e.text, e.extract ?? '']),
    draft.cron,
  ]);

interface Editing {
  /** null = 还没保存过的新编排。 */
  id: number | null;
  draft: OrchDraft;
  /** 保存时的快照（脏标记）。 */
  base: string;
}

const asEditing = (row: OrchestrationRow): Editing => {
  const draft = draftOf(row);
  return { id: row.id, draft, base: serialize(draft) };
};

// ---------------------------------------------------------------------------
// 画布节点
// ---------------------------------------------------------------------------

type SessionNodeData = {
  sessionId: string;
  label: string;
  projectLabel: string;
  harness: Harness | null;
  status: SessionStatus;
  /** 入口 = 没有入边（触发从这里进来），出口 = 没有出边；中间节点两者皆否。 */
  isEntry: boolean;
  pending: number;
  hot: boolean;
  missing: boolean;
  selected: boolean;
  /** 点节点本体 = 选中编辑；这枚小钮 = 直接看它的对话。 */
  onOpen: (sessionId: string) => void;
};
type SessionFlowNode = Node<SessionNodeData, 'orchSession'>;

function SessionNode({ data }: NodeProps<SessionFlowNode>) {
  const t = useT();
  const {
    sessionId,
    label,
    projectLabel,
    harness,
    status,
    isEntry,
    pending,
    hot,
    missing,
    selected,
    onOpen,
  } = data;
  return (
    <div
      style={{ width: ORCH_NODE_W, height: ORCH_NODE_H }}
      title={missing ? t('orch.unknownSession') : label}
      className={cn(
        'group flex items-center gap-2 rounded-lg border bg-neutral-900/95 px-2 shadow-mac transition-colors',
        hot ? 'border-teal-400/70 ring-1 ring-teal-400/40' : 'border-edge/[0.08]',
        selected && 'border-sky-400/70 ring-2 ring-sky-500/40',
        missing ? 'opacity-50' : 'hover:border-blue-500/40',
      )}
    >
      {/* 连线锚点：右出左入（消息沿起点往右流）。可见才拖得动，编辑面靠它连线。 */}
      <Handle
        type="target"
        id="l"
        position={Position.Left}
        className="!h-2 !w-2 !border-0 !bg-neutral-600"
      />
      <Handle
        type="source"
        id="r"
        position={Position.Right}
        className="!h-2 !w-2 !border-0 !bg-neutral-600 hover:!bg-teal-400"
      />
      <SessionStatusIcon status={status} harness={harness} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1">
          <span className="min-w-0 truncate text-xs font-medium text-neutral-100">{label}</span>
          {isEntry && (
            <Badge className="shrink-0 bg-teal-900/50 text-[9px] text-teal-300">
              {t('orch.entryTag')}
            </Badge>
          )}
        </span>
        <span className="flex items-center gap-1">
          <span className="min-w-0 truncate text-[10px] text-neutral-500">{projectLabel}</span>
          {pending > 0 && (
            <Badge className="shrink-0 animate-pulse bg-amber-900/50 text-[9px] text-amber-300">
              {t('orch.pendingTag', { n: pending })}
            </Badge>
          )}
        </span>
      </span>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onOpen(sessionId);
        }}
        title={t('orch.openChat')}
        aria-label={t('orch.openChat')}
        className="nodrag shrink-0 rounded p-1 text-neutral-500 opacity-0 transition-opacity hover:bg-edge/[0.08] hover:text-neutral-200 group-hover:opacity-100 max-lg:opacity-100"
      >
        <MessageSquare className="h-3 w-3" />
      </button>
    </div>
  );
}

type GroupNodeData = {
  label: string;
  count: number;
  collapsed: boolean;
  hidden: number;
  onToggle: () => void;
};
type GroupFlowNode = Node<GroupNodeData, 'orchGroup'>;

function GroupNode({ data }: NodeProps<GroupFlowNode>) {
  const t = useT();
  const { label, count, collapsed, hidden, onToggle } = data;
  return (
    <div className="pointer-events-none relative h-full w-full rounded-xl border border-dashed border-edge/[0.14] bg-edge/[0.015]">
      <div
        className="pointer-events-auto flex items-center gap-1.5 px-2.5"
        style={{ height: ORCH_GROUP_HEADER_H }}
      >
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={!collapsed}
          className="flex items-center gap-1 rounded px-1 py-0.5 text-neutral-400 transition-colors hover:bg-edge/[0.08] hover:text-neutral-100"
        >
          {collapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          <span className="max-w-[10rem] truncate text-[11px] font-medium">{label}</span>
        </button>
        <span className="text-[10px] text-neutral-600">{count}</span>
        {collapsed && hidden > 0 && (
          <span className="text-[10px] text-neutral-600">
            {t('orch.groupHidden', { n: hidden })}
          </span>
        )}
      </div>
    </div>
  );
}

type WebhookNodeData = {
  /** 入口（无入边，端点可复制/轮换）或出口（无出边，url/secret 在检查器里填）。 */
  direction: 'entry' | 'exit';
  hot: boolean;
  selected: boolean;
  missing: boolean;
};
type WebhookFlowNode = Node<WebhookNodeData, 'orchWebhook'>;

function WebhookNode({ data }: NodeProps<WebhookFlowNode>) {
  const t = useT();
  const { direction, hot, selected, missing } = data;
  return (
    <div
      style={{ width: ORCH_NODE_W, height: ORCH_NODE_H }}
      title={missing ? t('orch.webhookUnconnected') : undefined}
      className={cn(
        'flex items-center gap-2 rounded-lg border bg-neutral-900/95 px-2 shadow-mac transition-colors',
        hot ? 'border-teal-400/70 ring-1 ring-teal-400/40' : 'border-edge/[0.08]',
        selected && 'border-sky-400/70 ring-2 ring-sky-500/40',
        missing ? 'opacity-50' : 'hover:border-blue-500/40',
      )}
    >
      {direction === 'exit' && (
        <Handle
          type="target"
          id="l"
          position={Position.Left}
          className="!h-2 !w-2 !border-0 !bg-neutral-600"
        />
      )}
      {direction === 'entry' && (
        <Handle
          type="source"
          id="r"
          position={Position.Right}
          className="!h-2 !w-2 !border-0 !bg-neutral-600 hover:!bg-teal-400"
        />
      )}
      <Globe className="h-4 w-4 shrink-0 text-violet-400" />
      <span className="min-w-0 flex-1 truncate text-xs font-medium text-neutral-100">
        {t(direction === 'entry' ? 'orch.webhookEntry' : 'orch.webhookExit')}
      </span>
      <Badge
        className={cn(
          'shrink-0 text-[9px]',
          direction === 'entry'
            ? 'bg-violet-900/50 text-violet-300'
            : 'bg-neutral-800 text-neutral-400',
        )}
      >
        {t(direction === 'entry' ? 'orch.entryTag' : 'orch.exitTag')}
      </Badge>
    </div>
  );
}

const nodeTypes = { orchSession: SessionNode, orchWebhook: WebhookNode, orchGroup: GroupNode };

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
      return list.length > 0 ? asEditing(list[0]) : null;
    });
  }, [list]);

  const draft = editing?.draft ?? null;
  const dirty = editing != null && serialize(editing.draft) !== editing.base;
  const order = editing?.id ?? null;
  /** 帧回调要读「此刻选的是哪份」，订阅只挂一次。 */
  const selectedRef = useRef<number | null>(null);
  selectedRef.current = order;

  const patch = useCallback((fn: (d: OrchDraft) => OrchDraft): void => {
    setEditing((prev) => (prev ? { ...prev, draft: fn(prev.draft) } : prev));
  }, []);

  /** 图上选中的东西（会话 id / 边的原始 id）：右侧检查器跟着它长。 */
  const [sel, setSel] = useState<{ kind: 'node' | 'edge'; id: string } | null>(null);
  useEffect(() => setSel(null), [order]);

  // ---- 画布范围：筛选 + 分组收起 ----
  const [sessionQuery, setSessionQuery] = useState('');
  const [projectQuery, setProjectQuery] = useState('');
  /** 用户亲手翻过的分组；null = 还没动过（只展开起点所在的项目）。 */
  const [groupTouched, setGroupTouched] = useState<Set<number> | null>(null);

  /** 换一份编排：分组的「翻动」记录回到未动过。 */
  useEffect(() => setGroupTouched(null), [order]);

  /** 默认展开的分组 = 第一个 session 节点所属项目（没定过就都收着）。 */
  const primaryProject = useMemo(() => {
    const first = draft?.nodes.find((n) => n.kind === 'session');
    return first ? (sessionById.get(first.id)?.projectId ?? null) : null;
  }, [draft?.nodes, sessionById]);

  const expandedGroups = useMemo<ReadonlySet<number>>(
    () => groupTouched ?? new Set(primaryProject == null ? [] : [primaryProject]),
    [groupTouched, primaryProject],
  );

  const canvasSessions = useMemo(() => {
    const m = new Map<string, { sessionId: string; title: string | null; projectId: number | null }>();
    for (const node of draft?.nodes ?? []) {
      if (node.kind !== 'session') continue;
      const row = sessionById.get(node.id);
      m.set(node.id, {
        sessionId: node.id,
        title: row?.title ?? null,
        projectId: row?.projectId ?? null,
      });
    }
    return m;
  }, [draft?.nodes, sessionById]);

  const visible = useMemo(() => {
    if (!draft) return null;
    const q = sessionQuery.trim().toLowerCase();
    const pq = projectQuery.trim().toLowerCase();
    const nodes = draft.nodes.filter((node) => {
      const row = node.kind === 'session' ? sessionById.get(node.id) : undefined;
      const label =
        node.kind === 'webhook'
          ? t('orch.webhookEntry')
          : sessionLabel(row?.title ?? null, node.id);
      const hit = !q || label.toLowerCase().includes(q) || node.id.toLowerCase().includes(q);
      if (!hit) return false;
      if (!groupProjects || !pq) return true;
      return projectName(row?.projectId ?? null).toLowerCase().includes(pq);
    });
    return { nodes, edges: draft.edges };
  }, [draft, sessionQuery, projectQuery, sessionById, groupProjects, projectName, t]);

  const groupCounts = useMemo(() => {
    const m = new Map<number, number>();
    for (const node of visible?.nodes ?? []) {
      const pid =
        node.kind === 'webhook' ? 0 : (sessionById.get(node.id)?.projectId ?? 0);
      m.set(pid, (m.get(pid) ?? 0) + 1);
    }
    return m;
  }, [visible, sessionById]);

  const collapsedGroups = useMemo(() => {
    if (!groupProjects) return new Set<number>();
    return new Set([...groupCounts.keys()].filter((id) => !expandedGroups.has(id)));
  }, [groupProjects, groupCounts, expandedGroups]);

  // ---- 实时态（两条编排帧带全量轻量态：就地更新、不重拉） ----
  const [live, setLive] = useState<{
    runId: number;
    status: OrchestrationRunStatus;
    deliveries: number;
    pendingCounts: Record<string, number>;
  } | null>(null);
  /** 正在点亮的边 / 节点（键 = 边 id 或 `s:<会话>`，值 = 到期时刻）。 */
  const [flash, setFlash] = useState<Record<string, number>>({});
  const flashRef = useRef(flash);
  flashRef.current = flash;

  // 亮完自己灭（纯动效计时，不取数据）。
  useEffect(() => {
    const timer = window.setInterval(() => {
      const now = Date.now();
      const prev = flashRef.current;
      const next = Object.fromEntries(Object.entries(prev).filter(([, until]) => until > now));
      if (Object.keys(next).length !== Object.keys(prev).length) setFlash(next);
    }, 300);
    return () => window.clearInterval(timer);
  }, []);

  // ---- 运行日志（统一视图：全局看全部，项目视图看该项目起的那些） ----
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

      if (selectedRef.current === orchId) {
        setLive((prev) => ({
          runId,
          status: status ?? prev?.status ?? 'running',
          deliveries: frame.deliveries ?? prev?.deliveries ?? 0,
          pendingCounts: frame.pendingCounts ?? prev?.pendingCounts ?? {},
        }));
      }

      if (frame.kind === 'orchestration.delivery') {
        const to = frame.to ?? '';
        // 节点键：session 挂 `s:` 前缀，webhook 节点直接用它的 `w:` id。
        const key = frame.edgeId ? frame.edgeId : to.startsWith('w:') ? to : `s:${to}`;
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

  // 运行日志往上拉（贴底后继续拉才取下一页）。
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

  // ---- 对话弹窗 ----
  const onInterrupt = useCallback(
    (sessionId: string): void => {
      void fb.run(
        `interrupt:${sessionId}`,
        async () => {
          const res = await api.interruptSession(sessionId);
          if (res.interrupted === false) {
            show('error', t('tasks.stopUnconfirmed'));
            return;
          }
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

  // ---- 画布布局 ----
  const laid = useMemo(() => {
    if (!visible || !draft) return null;
    return layoutOrchestrationCanvas({
      nodes: visible.nodes,
      edges: visible.edges,
      sessions: canvasSessions,
      groupProjects,
      collapsed: collapsedGroups,
    });
  }, [visible, draft, canvasSessions, groupProjects, collapsedGroups]);

  const flowNodes: Node[] = useMemo(() => {
    if (!laid || !draft) return [];
    const now = Date.now();
    const entryIds = new Set(graphDirections(draft.nodes, draft.edges).entries.map((n) => n.id));
    return laid.nodes.map((n) => {
      if (n.kind === 'group') {
        const pid = n.projectId ?? 0;
        return {
          id: n.key,
          type: 'orchGroup',
          position: { x: n.x, y: n.y },
          style: { width: n.width, height: n.height },
          draggable: false,
          selectable: false,
          data: {
            label: projectName(pid),
            count: groupCounts.get(pid) ?? 0,
            collapsed: (n.hidden ?? 0) > 0,
            hidden: n.hidden ?? 0,
            // 以「此刻的展开集」为底再翻这个：收起态记成显式集合，翻回来即回原样。
            onToggle: () => {
              const next = new Set([...groupCounts.keys()].filter((id) => expandedGroups.has(id)));
              if (next.has(pid)) next.delete(pid);
              else next.add(pid);
              setGroupTouched(next);
            },
          },
        };
      }
      if (n.kind === 'webhook') {
        const nodeId = n.nodeId ?? '';
        const node = draft.nodes.find((x) => x.id === nodeId);
        return {
          id: n.key,
          type: 'orchWebhook',
          position: { x: n.x, y: n.y },
          draggable: false,
          data: {
            direction: entryIds.has(nodeId) ? ('entry' as const) : ('exit' as const),
            hot: (flash[nodeId] ?? 0) > now,
            missing: !node,
            selected: sel?.kind === 'node' && sel.id === nodeId,
          },
        } satisfies Node;
      }
      const sessionId = n.nodeId ?? '';
      const row = sessionById.get(sessionId);
      const pending = live?.pendingCounts[sessionId] ?? 0;
      return {
        id: n.key,
        type: 'orchSession',
        position: { x: n.x, y: n.y },
        draggable: false,
        data: {
          sessionId,
          label: sessionLabel(row?.title ?? null, sessionId),
          projectLabel: projectName(row?.projectId ?? null),
          harness: row?.harness ?? null,
          status: statuses.get(sessionId) ?? 'open',
          isEntry: entryIds.has(sessionId),
          pending,
          hot: (flash[`s:${sessionId}`] ?? 0) > now,
          missing: !row,
          selected: sel?.kind === 'node' && sel.id === sessionId,
          onOpen: openMessages,
        },
      } satisfies Node;
    });
  }, [
    laid,
    draft,
    sessionById,
    statuses,
    live,
    flash,
    groupCounts,
    expandedGroups,
    projectName,
    openMessages,
    sel,
  ]);

  const flowEdges: Edge[] = useMemo(() => {
    if (!laid || !draft) return [];
    const now = Date.now();
    const edgeById = new Map(draft.edges.map((e) => [e.id, e] as const));
    return laid.edges.map((e: OrchLaidEdge) => {
      const hot = e.edgeIds.some((id) => (flash[id] ?? 0) > now);
      const picked = sel?.kind === 'edge' && e.edgeIds.includes(sel.id);
      const texts = e.edgeIds.map((id) => edgeById.get(id)?.text ?? '');
      const first = texts[0] ?? '';
      const label =
        first.length > 16 ? `${first.slice(0, 16)}…` : first || undefined;
      return {
        id: e.key,
        source: e.from,
        target: e.to,
        type: 'smoothstep',
        animated: hot,
        interactionWidth: 24,
        style: hot
          ? { stroke: '#2dd4bf', strokeWidth: 2 }
          : picked
            ? { stroke: '#38bdf8', strokeWidth: 2 }
            : { strokeWidth: 1.5 },
        markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
        ...(label
          ? {
              label,
              labelBgPadding: [4, 2] as [number, number],
              labelBgStyle: { fill: 'rgb(23 23 23 / 0.85)' },
              labelStyle: { fill: '#a3a3a3', fontSize: 10 },
            }
          : {}),
      } satisfies Edge;
    });
  }, [laid, draft, flash, sel]);

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

  /**
   * 加一条连线：自环、重边、成环、条数上限都在本地先拒（服务端同判据才是权威）。
   * 成功回新边的 id——图上拖出来的那条要立刻选中，正文就在检查器里填。
   */
  const tryAddEdge = (from: string, to: string): string | null => {
    if (!draft) return null;
    if (!from || !to) {
      setEdgeError(t('orch.edgeInvalid'));
      return null;
    }
    if (from === to) {
      setEdgeError(t('orch.edgeSelf'));
      return null;
    }
    if (draft.edges.some((e) => e.from === from && e.to === to)) {
      setEdgeError(t('orch.edgeExists'));
      return null;
    }
    if (draft.edges.length >= ORCH_MAX_EDGES) {
      setEdgeError(t('orch.edgeLimit', { max: ORCH_MAX_EDGES }));
      return null;
    }
    const next = addEdge(draft, from, to, '');
    const cycle = findCycle(next.nodes, next.edges);
    if (cycle) {
      setEdgeError(`${t('orch.edgeCycle')}：${cycle.join(' → ')}`);
      return null;
    }
    setEdgeError(null);
    patch(() => next);
    return next.edges[next.edges.length - 1]?.id ?? null;
  };

  /** 渲染节点 id → 编排节点 id：session 挂 `s:` 前缀，webhook 用裸 `w:` id；`g:` 不参与连线。 */
  const orchNodeIdOf = (flowNodeId: string | undefined): string | null => {
    if (!flowNodeId) return null;
    if (flowNodeId.startsWith('s:')) return flowNodeId.slice(2);
    if (flowNodeId.startsWith('w:')) return flowNodeId;
    return null;
  };

  /** 从节点右侧圆点拖到另一个节点 = 连一条边，随即选中好去写正文。 */
  const connectEdge = (c: Connection): void => {
    const from = orchNodeIdOf(c.source);
    const to = orchNodeIdOf(c.target);
    if (!from || !to) return;
    const id = tryAddEdge(from, to);
    if (id) setSel({ kind: 'edge', id });
  };

  /** 渲染边 id 是布局合并后的键，选中的必须是底下那条原始边。 */
  const selectEdge = (flowEdgeId: string): void => {
    const real = laid?.edges.find((e) => e.key === flowEdgeId)?.edgeIds[0];
    if (real) setSel({ kind: 'edge', id: real });
  };

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

  const save = (): void => {
    if (!editing || !check?.ok) return;
    // webhook-only 编排没有 session 入口可派生项目，带上画布所在项目。
    const hasSessionEntry =
      graphDirections(editing.draft.nodes, editing.draft.edges).entries.some(
        (n) => n.kind === 'session',
      ) || editing.draft.nodes.some((n) => n.kind === 'session');
    const body = {
      name: editing.draft.name.trim(),
      startText: editing.draft.startText,
      ...(hasSessionEntry ? {} : projectId != null ? { projectId } : {}),
      nodes: editing.draft.nodes,
      edges: editing.draft.edges,
      cron: editing.draft.cron,
    };
    void fb.run(
      'orch:save',
      async () => {
        const res =
          editing.id == null
            ? await api.createOrchestration(body)
            : await api.updateOrchestration(editing.id, body);
        setEditing(asEditing(res.orchestration));
        setList((prev) => {
          if (!prev) return [res.orchestration];
          const found = prev.some((row) => row.id === res.orchestration.id);
          return found
            ? prev.map((row) => (row.id === res.orchestration.id ? res.orchestration : row))
            : [res.orchestration, ...prev];
        });
        show('success', t('orch.saved'));
        // 编排卡的计数归 App，改完定义报一声（同 HooksPanel 的 rules 事件）。
        window.dispatchEvent(new Event('weave:orchestrations-changed'));
      },
      { fail: (e) => t('orch.saveFailed', { error: errorText(e) }) },
    );
  };

  // 破坏性动作走应用内确认弹窗（原生 confirm/alert 一律不用）。
  const [confirmState, setConfirmState] = useState<{
    title: string;
    message: string;
    confirmLabel: string;
    action: () => void;
  } | null>(null);

  const remove = (): void => {
    if (!editing) return;
    if (editing.id == null) {
      setEditing(null);
      return;
    }
    const name = editing.draft.name.trim() || t('orch.untitled');
    const id = editing.id;
    setConfirmState({
      title: t('orch.deleteOrch'),
      message: t('orch.deleteConfirm', { name }),
      confirmLabel: t('orch.deleteOrch'),
      action: () => {
        void fb.run(
          'orch:delete',
          async () => {
            await api.deleteOrchestration(id);
            setEditing(null);
            setList((prev) => prev?.filter((row) => row.id !== id) ?? prev);
            show('success', t('orch.deleted'));
            window.dispatchEvent(new Event('weave:orchestrations-changed'));
            void refreshRuns();
          },
          { fail: (e) => t('orch.deleteFailed', { error: errorText(e) }) },
        );
      },
    });
  };

  const trigger = (): void => {
    if (!editing || editing.id == null) return;
    void fb.run(
      'orch:trigger',
      async () => {
        const res = await api.triggerOrchestration(editing.id!, {
          ...(triggerText.trim() ? { text: triggerText.trim() } : {}),
          ...(triggerEntries ? { entries: triggerEntries } : {}),
        });
        setTriggerText('');
        show('success', t('orch.triggerOk', { id: res.runId }));
        void refreshRuns();
      },
      { fail: (e) => t('orch.triggerFailed', { error: errorText(e) }) },
    );
  };

  const rotate = (nodeId: string): void => {
    if (!editing || editing.id == null) return;
    const id = editing.id;
    setConfirmState({
      title: t('orch.rotate'),
      message: t('orch.rotateConfirm'),
      confirmLabel: t('orch.rotate'),
      action: () => {
        void fb.run(
          'orch:rotate',
          async () => {
            const res = await api.rotateOrchestrationWebhook(id, nodeId);
            setList((prev) =>
              prev?.map((row) =>
                row.id === id
                  ? {
                      ...row,
                      nodes: row.nodes.map((n) =>
                        n.id === nodeId ? { ...n, webhookToken: res.webhookToken } : n,
                      ),
                    }
                  : row,
              ) ?? prev,
            );
            setEditing((prev) =>
              prev && prev.id === id
                ? {
                    ...prev,
                    draft: {
                      ...prev.draft,
                      nodes: prev.draft.nodes.map((n) =>
                        n.id === nodeId ? { ...n, webhookToken: res.webhookToken } : n,
                      ),
                    },
                  }
                : prev,
            );
            show('success', t('orch.rotate'));
          },
          { fail: (e) => t('orch.rotateFailed', { error: errorText(e) }) },
        );
      },
    });
  };

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

  /** 当前列表里这份编排的行（启用开关读它，编辑态的 enabled 不进 draft）。 */
  const current = (list ?? []).find((row) => row.id === order) ?? null;

  const copyEndpoint = (token: string): void => {
    const endpoint = `${window.location.origin}/webhooks/orchestrate/${token}`;
    void copyText(endpoint).then((ok) =>
      show(ok ? 'success' : 'error', ok ? t('orch.copied') : t('common.copyFailed')),
    );
  };

  const livePending = live
    ? Object.values(live.pendingCounts).reduce((sum, n) => sum + n, 0)
    : 0;

  // 图上选中的东西（选中态即编辑态：节点改归属/删、边改正文/删）。
  const selNode =
    sel?.kind === 'node' && draft?.nodes.some((n) => n.id === sel.id) ? sel.id : null;
  const selNodeKind = selNode ? draft?.nodes.find((n) => n.id === selNode)?.kind ?? null : null;
  const selEdge =
    sel?.kind === 'edge' ? (draft?.edges.find((e) => e.id === sel.id) ?? null) : null;
  const selNodeOut = selNode ? (draft?.edges ?? []).filter((e) => e.from === selNode) : [];
  /** 节点显示名：session 用会话标题，webhook 用端点角色名。 */
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
      return sessionLabel(sessionById.get(nodeId)?.title ?? null, nodeId);
    },
    [draft, sessionById, t],
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
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

      {/* 选择 / 命名 / 保存（图外的定义项都在这几条工具条上，没有单独的表单卡片） */}
      <div className="flex flex-wrap items-center gap-1.5">
        <Combobox
          value={editing?.id != null ? String(editing.id) : ''}
          onChange={(v) => {
            const row = (list ?? []).find((r) => String(r.id) === v);
            setEditing(row ? asEditing(row) : null);
          }}
          title={t('orch.listLabel')}
          placeholder={list === null ? t('hooks.loading') : t('orch.new')}
          className="min-w-[10rem] max-w-[16rem] rounded bg-neutral-900 px-1.5 py-1 text-[11px]"
          options={(list ?? []).map((row) => ({
            value: String(row.id),
            label: row.name || t('orch.untitled'),
          }))}
        />
        <button
          type="button"
          onClick={() =>
            setEditing({ id: null, draft: emptyDraft(), base: serialize(emptyDraft()) })
          }
          className="inline-flex items-center gap-1 rounded-md border border-edge/[0.1] bg-neutral-900/90 px-2 py-1 text-[11px] text-neutral-300 transition-colors hover:bg-neutral-800"
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
              className="min-w-[10rem] flex-1 rounded border border-edge/[0.1] bg-neutral-950 px-2 py-1 text-[11px] text-neutral-100 placeholder:text-neutral-600 focus:border-blue-500/40 focus:outline-none"
            />
            {dirty && <span className="text-[10px] text-amber-400/80">{t('orch.unsaved')}</span>}
            <button
              type="button"
              disabled={!canSave}
              onClick={save}
              title={check && !check.ok ? check.error : t('orch.save')}
              className="inline-flex items-center gap-1 rounded-md border border-edge/[0.1] bg-neutral-900/90 px-2 py-1 text-[11px] text-neutral-200 transition-colors hover:bg-neutral-800 disabled:opacity-40"
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
              className="inline-flex items-center gap-1 rounded-md border border-red-500/30 px-2 py-1 text-[11px] text-red-300 transition-colors hover:bg-red-950/40 disabled:opacity-40"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          </>
        )}
      </div>

      {/* 自动触发：起始消息 / 定时（webhook 端点归节点自己的检查器） */}
      {editing && draft && (
        <div className="flex flex-wrap items-center gap-1.5">
          <input
            value={draft.startText}
            onChange={(e) => patch((d) => ({ ...d, startText: e.target.value }))}
            placeholder={t('orch.startTextHint')}
            title={t('orch.startTextLabel')}
            className="min-w-[12rem] flex-1 rounded border border-edge/[0.1] bg-neutral-950 px-2 py-1 text-[11px] text-neutral-100 placeholder:text-neutral-600 focus:border-blue-500/40 focus:outline-none"
          />
          <button
            type="button"
            onClick={() => setCronOpen(true)}
            className={cn(
              'shrink-0 rounded-md border px-2 py-1 text-[11px] transition-colors',
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
                'shrink-0 rounded-md border px-2 py-1 text-[11px] transition-colors',
                current.enabled
                  ? 'border-emerald-400/40 bg-emerald-500/10 text-emerald-200'
                  : 'border-edge/[0.1] text-neutral-400 hover:bg-edge/[0.06]',
              )}
            >
              {t(current.enabled ? 'orch.enabledOn' : 'orch.enabledOff')}
            </button>
          )}
        </div>
      )}

      {/* 手动触发：入口 ≥ 2 时先选跑哪些（缺省全部 session 入口） */}
      {editing && draft && (
        <div className="flex flex-wrap items-center gap-1.5">
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
                      'inline-flex max-w-[12rem] items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] transition-colors',
                      checked
                        ? 'border-teal-400/40 bg-teal-500/10 text-teal-200'
                        : 'border-edge/[0.1] text-neutral-400 hover:bg-edge/[0.06]',
                    )}
                  >
                    {entry.kind === 'webhook' ? <Globe className="h-2.5 w-2.5" /> : null}
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
            className="min-w-[10rem] flex-1 rounded border border-edge/[0.1] bg-neutral-950 px-2 py-1 text-[11px] text-neutral-100 placeholder:text-neutral-600 focus:border-blue-500/40 focus:outline-none"
          />
          <button
            type="button"
            disabled={editing.id == null || fb.stateOf('orch:trigger') === 'loading'}
            onClick={trigger}
            className="inline-flex items-center gap-1 rounded bg-teal-700/80 px-2.5 py-1 text-[11px] font-medium text-white transition-colors hover:bg-teal-600 disabled:opacity-40"
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

      {/* 画布 */}
      <div className={cn('relative h-[420px] rounded-lg border border-edge/[0.06]', tintClass)}>
        {draft === null ? (
          <p className="flex h-full items-center justify-center px-6 text-center text-xs text-neutral-600">
            {list === null ? t('hooks.loading') : t('orch.empty')}
          </p>
        ) : draft.nodes.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
            <p className="text-xs text-neutral-600">{t('orch.canvasEmpty')}</p>
            <button
              type="button"
              onClick={() => setPickerOpen(true)}
              className="inline-flex items-center gap-1 rounded border border-edge/[0.1] px-2 py-1 text-[11px] text-neutral-300 transition-colors hover:bg-edge/[0.06]"
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
            fitView
            fitViewOptions={{ maxZoom: 1, padding: 0.12 }}
            minZoom={0.15}
            maxZoom={1.5}
            nodesDraggable={false}
            nodesConnectable
            deleteKeyCode={null}
            onConnect={connectEdge}
            onNodeClick={(_, node) => {
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
              className="nopan flex max-w-[calc(100%-1rem)] flex-wrap items-center gap-1"
              onClick={(e) => e.stopPropagation()}
            >
              {groupProjects && (
                <input
                  value={projectQuery}
                  onChange={(e) => setProjectQuery(e.target.value)}
                  placeholder={t('orch.filterProject')}
                  className="w-28 rounded border border-edge/[0.1] bg-neutral-950/90 px-1.5 py-0.5 text-[10px] text-neutral-100 placeholder:text-neutral-600 focus:border-blue-500/40 focus:outline-none"
                />
              )}
              <input
                value={sessionQuery}
                onChange={(e) => setSessionQuery(e.target.value)}
                placeholder={t('orch.filterSession')}
                className="w-32 rounded border border-edge/[0.1] bg-neutral-950/90 px-1.5 py-0.5 text-[10px] text-neutral-100 placeholder:text-neutral-600 focus:border-blue-500/40 focus:outline-none"
              />
              <button
                type="button"
                disabled={draft.nodes.length >= ORCH_MAX_NODES}
                onClick={() => setPickerOpen(true)}
                title={t('orch.addNode')}
                className="inline-flex items-center gap-1 rounded border border-edge/[0.1] bg-neutral-950/90 px-1.5 py-0.5 text-[10px] text-neutral-300 transition-colors hover:bg-edge/[0.06] disabled:opacity-40"
              >
                <Plus className="h-3 w-3" />
                {t('orch.addNode')}
              </button>
              <button
                type="button"
                disabled={draft.nodes.length >= ORCH_MAX_NODES}
                onClick={() => patch(addWebhookNode)}
                title={t('orch.addWebhook')}
                className="inline-flex items-center gap-1 rounded border border-edge/[0.1] bg-neutral-950/90 px-1.5 py-0.5 text-[10px] text-neutral-300 transition-colors hover:bg-edge/[0.06] disabled:opacity-40"
              >
                <Globe className="h-3 w-3" />
                {t('orch.addWebhook')}
              </button>
              <span className="rounded bg-neutral-950/90 px-1.5 py-0.5 text-[10px] text-neutral-500">
                {t('orch.summary', { nodes: draft.nodes.length, edges: draft.edges.length })}
              </span>
              {visible != null && visible.nodes.length === 0 && (
                <span className="rounded bg-neutral-950/90 px-1.5 py-0.5 text-[10px] text-neutral-500">
                  {t('orch.noMatch')}
                </span>
              )}
            </Panel>
            {/* 点节点 / 点边 = 就地编辑那一份定义（右侧检查器）。 */}
            {selNode && draft && selNodeKind === 'session' && (
              <Panel
                position="top-right"
                className="nopan w-56 space-y-1.5 rounded-lg border border-edge/[0.12] bg-neutral-900/95 p-2 shadow-mac"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex items-center gap-1">
                  <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-neutral-100">
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
                    className="inline-flex items-center gap-1 rounded border border-edge/[0.1] px-1.5 py-0.5 text-[10px] text-neutral-300 transition-colors hover:bg-edge/[0.06]"
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
                    className="inline-flex items-center gap-1 rounded border border-red-500/30 px-1.5 py-0.5 text-[10px] text-red-300 transition-colors hover:bg-red-950/40"
                  >
                    <Trash2 className="h-3 w-3" />
                    {t('orch.removeNode')}
                  </button>
                </div>
                <div className="space-y-1 border-t border-edge/[0.06] pt-1">
                  <span className="text-[10px] text-neutral-500">{t('orch.edgesLabel')}</span>
                  {selNodeOut.length === 0 ? (
                    <p className="text-[10px] text-neutral-600">{t('orch.nodeNoEdges')}</p>
                  ) : (
                    <ul className="space-y-0.5">
                      {selNodeOut.map((edge) => (
                        <li key={edge.id}>
                          <button
                            type="button"
                            onClick={() => setSel({ kind: 'edge', id: edge.id })}
                            className="flex w-full items-center gap-1 rounded px-1 py-0.5 text-left text-[10px] text-neutral-300 hover:bg-edge/[0.08]"
                          >
                            <Link2 className="h-2.5 w-2.5 shrink-0 text-neutral-600" />
                            <span className="min-w-0 flex-1 truncate">{nodeLabel(edge.to)}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </Panel>
            )}
            {selEdge && (
              <Panel
                position="top-right"
                className="nopan w-60 space-y-1.5 rounded-lg border border-edge/[0.12] bg-neutral-900/95 p-2 shadow-mac"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex items-center gap-1">
                  <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-neutral-100">
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
                  rows={3}
                  placeholder={t('orch.edgeText')}
                  title={t('orch.edgeVars')}
                  className="w-full resize-y rounded border border-edge/[0.1] bg-neutral-950 px-1.5 py-1 text-[10px] text-neutral-100 placeholder:text-neutral-600 focus:border-blue-500/40 focus:outline-none"
                />
                <p className="text-[9px] leading-relaxed text-neutral-600">{t('orch.edgeVars')}</p>
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
                  rows={2}
                  placeholder={t('orch.edgeExtractHint')}
                  title={t('orch.edgeExtract')}
                  className="w-full resize-y rounded border border-edge/[0.1] bg-neutral-950 px-1.5 py-1 text-[10px] text-neutral-100 placeholder:text-neutral-600 focus:border-blue-500/40 focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => {
                    patch((d) => removeEdge(d, selEdge.id));
                    setSel(null);
                  }}
                  className="inline-flex items-center gap-1 rounded border border-red-500/30 px-1.5 py-0.5 text-[10px] text-red-300 transition-colors hover:bg-red-950/40"
                >
                  <Trash2 className="h-3 w-3" />
                  {t('orch.removeEdge')}
                </button>
              </Panel>
            )}
            {/* webhook 节点检查器：入口管端点（复制/轮换），出口填 url/secret。 */}
            {selNode && draft && selNodeKind === 'webhook' && (
              <Panel
                position="top-right"
                className="nopan w-64 space-y-1.5 rounded-lg border border-edge/[0.12] bg-neutral-900/95 p-2 shadow-mac"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex items-center gap-1">
                  <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-neutral-100">
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
                          <code className="block truncate rounded bg-neutral-950 px-1.5 py-1 font-mono text-[10px] text-neutral-400">
                            {token
                              ? `${window.location.origin}/webhooks/orchestrate/${token}`
                              : t('orch.endpointMissing')}
                          </code>
                          <div className="flex flex-wrap items-center gap-1">
                            <button
                              type="button"
                              disabled={!token}
                              onClick={() => token && copyEndpoint(token)}
                              className="inline-flex items-center gap-1 rounded border border-edge/[0.1] px-1.5 py-0.5 text-[10px] text-neutral-300 transition-colors hover:bg-edge/[0.06] disabled:opacity-40"
                            >
                              <Copy className="h-2.5 w-2.5" />
                              {t('orch.copyEndpoint')}
                            </button>
                            {editing?.id != null && (
                              <button
                                type="button"
                                disabled={fb.stateOf('orch:rotate') === 'loading'}
                                onClick={() => rotate(selNode)}
                                className="rounded border border-edge/[0.1] px-1.5 py-0.5 text-[10px] text-neutral-300 transition-colors hover:bg-edge/[0.06] disabled:opacity-40"
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
                      className="w-full rounded border border-edge/[0.1] bg-neutral-950 px-1.5 py-1 font-mono text-[10px] text-neutral-100 placeholder:text-neutral-600 focus:border-blue-500/40 focus:outline-none"
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
                      className="w-full rounded border border-edge/[0.1] bg-neutral-950 px-1.5 py-1 font-mono text-[10px] text-neutral-100 placeholder:text-neutral-600 focus:border-blue-500/40 focus:outline-none"
                    />
                  </>
                )}
                <button
                  type="button"
                  onClick={() => {
                    patch((d) => removeNode(d, selNode));
                    setSel(null);
                  }}
                  className="inline-flex items-center gap-1 rounded border border-red-500/30 px-1.5 py-0.5 text-[10px] text-red-300 transition-colors hover:bg-red-950/40"
                >
                  <Trash2 className="h-3 w-3" />
                  {t('orch.removeNode')}
                </button>
              </Panel>
            )}
            {/* 状态行贴底居中：连线被拒 > 起点未定 / 校验不过 > 操作提示。 */}
            <Panel position="bottom-center" className="pointer-events-none max-w-[70%]">
              <p
                title={statusText}
                className={cn(
                  'min-w-0 truncate text-[10px]',
                  statusWarn ? 'text-amber-400/80' : 'text-neutral-600',
                )}
              >
                {statusText}
              </p>
            </Panel>
          </ReactFlow>
        )}
      </div>

      {/* 运行日志（统一视图：全局看全部，项目视图看该项目起的那些） */}
      <div>
        <div className="flex flex-wrap items-center gap-2 pb-1.5">
          <span className="text-xs font-medium text-neutral-200">{t('orch.runsTitle')}</span>
          <span className="text-[11px] text-neutral-500">{runs === null ? '' : runs.length}</span>
          <Combobox
            value={runStatus}
            onChange={(v) => setRunStatus(v as OrchestrationRunStatus | '')}
            title={t('orch.runStatusAll')}
            placeholder={t('orch.runStatusAll')}
            className="rounded bg-neutral-900 px-1 py-0.5 text-[10px]"
            options={(Object.keys(RUN_STATUS_KEY) as OrchestrationRunStatus[]).map((s) => ({
              value: s,
              label: t(RUN_STATUS_KEY[s]),
            }))}
          />
          <input
            value={runText}
            onChange={(e) => setRunText(e.target.value)}
            placeholder={t('orch.runFilterName')}
            className="w-32 rounded border border-edge/[0.1] bg-neutral-950 px-1.5 py-0.5 text-[10px] text-neutral-100 placeholder:text-neutral-600 focus:border-blue-500/40 focus:outline-none"
          />
          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              disabled={fb.stateOf('orch:clear:finished') === 'loading'}
              onClick={() => clearRuns('finished')}
              className="rounded border border-edge/[0.1] px-1.5 py-0.5 text-[10px] text-neutral-300 transition-colors hover:bg-edge/[0.06] disabled:opacity-40"
            >
              {t('orch.runsClearFinished')}
            </button>
            <button
              type="button"
              disabled={fb.stateOf('orch:clear:all') === 'loading'}
              onClick={() => clearRuns('all')}
              className="rounded border border-red-500/30 px-1.5 py-0.5 text-[10px] text-red-300 transition-colors hover:bg-red-950/40 disabled:opacity-40"
            >
              {t('orch.runsClearAll')}
            </button>
          </div>
        </div>
        {runDetailError && (
          <p className="pb-1 text-[10px] text-red-400/80">
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
                        <span className="shrink-0 text-[10px] text-neutral-500">
                          {t(TRIGGER_KEY[row.trigger])}
                        </span>
                        <span className="shrink-0 text-[10px] text-neutral-500">
                          {t('orch.runDeliveries', { n: row.deliveries })}
                        </span>
                        {pending > 0 && (
                          <span className="shrink-0 text-[10px] text-amber-400/80">
                            {t('orch.runPending', { n: pending })}
                          </span>
                        )}
                        <span
                          className="shrink-0 text-[10px] text-neutral-600"
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
                            className="inline-flex shrink-0 items-center gap-1 rounded border border-red-500/30 px-1.5 py-0.5 text-[10px] text-red-300 transition-colors hover:bg-red-950/40 disabled:opacity-40"
                          >
                            {t('orch.runCancel')}
                          </button>
                        )}
                      </div>
                      {row.error && (
                        <p className="break-words border-t border-edge/[0.04] px-2 py-1 text-[11px] text-red-400/80">
                          {row.error}
                        </p>
                      )}
                      {expanded && (
                        <div className="space-y-1 border-t border-edge/[0.04] px-2 py-1.5">
                          {row.finishedAt && (
                            <p className="text-[10px] text-neutral-600">
                              {t('orch.runFinished', {
                                time: new Date(row.finishedAt).toLocaleString(),
                              })}
                            </p>
                          )}
                          {detail == null ? (
                            <p className="text-[10px] text-neutral-600">{t('hooks.loading')}</p>
                          ) : events.length === 0 ? (
                            <p className="text-[10px] text-neutral-600">
                              {t('orch.runEventsEmpty')}
                            </p>
                          ) : (
                            <>
                              <p className="text-[10px] text-neutral-500">
                                {t('orch.runEvents', { n: events.length })}
                              </p>
                              <ul className="space-y-0.5">
                                {events.map((event, i) => (
                                  <li
                                    key={i}
                                    className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5"
                                  >
                                    <span className="shrink-0 font-mono text-[10px] text-neutral-600">
                                      {formatStamp(event.at)}
                                    </span>
                                    <span className="shrink-0 text-[10px] text-neutral-300">
                                      {event.from ? nodeLabel(event.from) : t('orch.triggerManual')}
                                    </span>
                                    <Link2 className="h-2.5 w-2.5 shrink-0 text-neutral-600" />
                                    <span className="shrink-0 text-[10px] text-neutral-300">
                                      {nodeLabel(event.to)}
                                    </span>
                                    <Badge
                                      className={cn(
                                        'shrink-0',
                                        event.ok
                                          ? 'bg-emerald-900/40 text-emerald-300'
                                          : 'bg-red-900/40 text-red-300',
                                      )}
                                    >
                                      {event.ok ? 'ok' : 'failed'}
                                    </Badge>
                                    {event.error && (
                                      <span className="min-w-0 flex-1 break-words text-[10px] text-red-400/70">
                                        {event.error}
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
                <span className="rounded bg-neutral-950/90 px-2 py-0.5 text-[10px] text-neutral-400">
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
