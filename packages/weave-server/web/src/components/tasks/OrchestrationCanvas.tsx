import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  Handle,
  MarkerType,
  Panel,
  Position,
  ReactFlow,
  getSmoothStepPath,
  type Connection,
  type Edge,
  type EdgeProps,
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
  Maximize2,
  MessageSquare,
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
  addTriggerNode,
  addWebhookNode,
  findCycle,
  graphDirections,
  invalidEdgeIds,
  mergeOrchestrations,
  removeEdge,
  removeNode,
  validateDraft,
  type MergedOrchEdge,
  type OrchDraft,
} from './orchestration-graph';
import {
  ORCH_COL_W,
  ORCH_GROUP_HEADER_H,
  ORCH_NODE_H,
  ORCH_NODE_W,
  layoutOrchestrationCanvas,
  type OrchLaidEdge,
} from './orchestration-canvas-layout';
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
    draft.nodes.map((n) => [n.id, n.kind, n.webhookToken ?? '', n.url ?? '', n.secret ?? '', n.autoFire ?? false]),
    draft.edges.map((e) => [e.id, e.from, e.to, e.text, e.extract ?? '', e.condition ?? '', e.when ?? '']),
    draft.cron,
  ]);

interface Editing {
  /** null = 还没保存过的新编排。 */
  id: number | null;
  draft: OrchDraft;
  /** 保存时的快照（脏标记）。 */
  base: string;
  /**
   * 项目归属（仅无 session 入口的编排可编辑——session 入口的编排由服务端从
   * 入口派生；webhook-only 必须显式给，画布定义行的项目选择器写这里）。
   */
  projectId: number | null;
}

/** 一份编排的实时运行态（帧驱动；终态帧即清，画布辉光跟着收）。 */
interface LiveRun {
  runId: number;
  status: OrchestrationRunStatus;
  deliveries: number;
  pendingCounts: Record<string, number>;
}

const asEditing = (row: OrchestrationRow): Editing => {
  const draft = draftOf(row);
  return { id: row.id, draft, base: serialize(draft), projectId: row.projectId };
};

// ---------------------------------------------------------------------------
// 画布节点
// ---------------------------------------------------------------------------

/** 卡片里的一枚外接连接点：管着一条连线（点它 = 选中那条边）。 */
interface PortItem {
  /** 端口 id 的邻居部分（下游 = `out:<下游>`；上游 = `in:<上游>`）。 */
  neighbor: string;
  /** 连线 id（编辑面用于选中；总览为空）。 */
  edgeId?: string;
  /** 悬停说明：hookN → 下游会话名 / 来自上游会话名。 */
  hint: string;
}

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
  /** run 进行中且该节点有待回投递：外圈呼吸辉光（运行前沿）。 */
  running: boolean;
  missing: boolean;
  selected: boolean;
  /** 首节点卡片可点（出「编辑/新建编排」面板）。 */
  pickable: boolean;
  inPorts: PortItem[];
  outPorts: PortItem[];
  /** 点连接点 = 选中那条连线（编辑面）。 */
  onPickPort?: (edgeId: string) => void;
  /** 点节点本体 = 选中编辑；这枚小钮 = 直接看它的对话。 */
  onOpen: (sessionId: string) => void;
};
type SessionFlowNode = Node<SessionNodeData, 'orchSession'>;

/**
 * 三栏卡片的左右 hook 栏：一枚枚外接连接点（纵向均分）。连接点本身就是
 * ReactFlow 的 Handle（id = `in:<上游>` / `out:<下游>`），所以线与点是同一个
 * 东西——依附关系一眼可见，拖线也从这儿起手。
 */
function PortRail({ ports, side }: { ports: PortItem[]; side: 'in' | 'out' }) {
  if (ports.length === 0) {
    // 没有边也给一个锚点：新建的第一条连线才有地方起手（编辑面）。
    return (
      <Handle
        type={side === 'in' ? 'target' : 'source'}
        position={side === 'in' ? Position.Left : Position.Right}
        className="!h-2 !w-2 !border-0 !bg-neutral-700/60 hover:!bg-teal-400"
      />
    );
  }
  return (
    <>
      {ports.map((port, i) => {
        const pct = `${((i + 1) / (ports.length + 1)) * 100}%`;
        return (
          <Handle
            key={`${side}:${port.neighbor}`}
            type={side === 'in' ? 'target' : 'source'}
            id={`${side === 'in' ? 'in' : 'out'}:${port.neighbor}`}
            position={side === 'in' ? Position.Left : Position.Right}
            style={{ top: pct }}
            title={port.hint}
            className="!h-2.5 !w-2.5 !border-0 !bg-teal-500/70 hover:!bg-teal-300"
          />
        );
      })}
    </>
  );
}

/** 左/右 hook 栏的可视连接点：和 Handle 同一纵向位置（卡片里长出连接点）。 */
function PortColumn({
  ports,
  side,
  onPick,
}: {
  ports: PortItem[];
  side: 'in' | 'out';
  onPick?: (edgeId: string) => void;
}) {
  return (
    <div className="relative w-9 shrink-0">
      {ports.map((port, i) => (
        <button
          key={port.neighbor}
          type="button"
          title={port.hint}
          aria-label={port.hint}
          onClick={(e) => {
            // 点连接点 = 选中它管的连线，不要顺带把节点也选中。
            e.stopPropagation();
            if (port.edgeId) onPick?.(port.edgeId);
          }}
          style={{ top: `${((i + 1) / (ports.length + 1)) * 100}%` }}
          className={cn(
            'nodrag absolute left-1/2 flex h-4 w-4 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full text-[8px] font-semibold ring-1 transition-colors',
            side === 'in'
              ? 'bg-teal-950/70 text-teal-300/90 ring-teal-500/25 hover:bg-teal-900/80'
              : 'bg-teal-800/50 text-teal-100 ring-teal-400/40 hover:bg-teal-700/70',
          )}
        >
          {i + 1}
        </button>
      ))}
    </div>
  );
}

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
    running,
    missing,
    selected,
    pickable,
    inPorts,
    outPorts,
    onPickPort,
    onOpen,
  } = data;
  return (
    <div
      style={{ width: ORCH_NODE_W, height: ORCH_NODE_H }}
      title={missing ? t('orch.unknownSession') : label}
      className={cn(
        'group flex rounded-lg border bg-neutral-900/95 shadow-mac transition-colors',
        hot ? 'border-teal-400/70 ring-1 ring-teal-400/40' : 'border-edge/[0.08]',
        selected && 'border-sky-400/70 ring-2 ring-sky-500/40',
        running && 'orch-node-running',
        pickable && 'cursor-pointer',
        missing ? 'opacity-50' : 'hover:border-blue-500/40',
      )}
    >
      <PortRail ports={inPorts} side="in" />
      <PortRail ports={outPorts} side="out" />
      <PortColumn ports={inPorts} side="in" onPick={onPickPort} />
      {/* 中栏：会话本体 */}
      <div className="flex min-w-0 flex-1 items-center gap-2 border-x border-edge/[0.06] px-2">
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
          <span className="mt-0.5 flex items-center gap-1">
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
      <PortColumn ports={outPorts} side="out" onPick={onPickPort} />
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
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
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
  running: boolean;
  selected: boolean;
  missing: boolean;
  /** 首节点卡片可点（出「编辑编排」面板）。 */
  pickable: boolean;
  inPorts: PortItem[];
  outPorts: PortItem[];
};
type WebhookFlowNode = Node<WebhookNodeData, 'orchWebhook'>;

function WebhookNode({ data }: NodeProps<WebhookFlowNode>) {
  const t = useT();
  const { direction, hot, running, selected, missing, pickable, inPorts, outPorts } = data;
  return (
    <div
      style={{ width: ORCH_NODE_W, height: ORCH_NODE_H }}
      title={missing ? t('orch.webhookUnconnected') : undefined}
      className={cn(
        'flex rounded-lg border bg-neutral-900/95 shadow-mac transition-colors',
        hot ? 'border-teal-400/70 ring-1 ring-teal-400/40' : 'border-edge/[0.08]',
        selected && 'border-sky-400/70 ring-2 ring-sky-500/40',
        running && 'orch-node-running',
        pickable && 'cursor-pointer',
        missing ? 'opacity-50' : 'hover:border-blue-500/40',
      )}
    >
      <PortRail ports={inPorts} side="in" />
      <PortRail ports={outPorts} side="out" />
      <PortColumn ports={inPorts} side="in" />
      <div className="flex min-w-0 flex-1 items-center gap-2 border-x border-edge/[0.06] px-2">
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
      <PortColumn ports={outPorts} side="out" />
    </div>
  );
}

type TriggerNodeData = {
  hot: boolean;
  selected: boolean;
  missing: boolean;
  inPorts: PortItem[];
  outPorts: PortItem[];
};
type TriggerFlowNode = Node<TriggerNodeData, 'orchTrigger'>;

/** 手动触发入口（虚节点）：手动触发选中它时，正文经出边 {upstream} 下发。 */
function TriggerNode({ data }: NodeProps<TriggerFlowNode>) {
  const t = useT();
  const { hot, selected, missing, inPorts, outPorts } = data;
  return (
    <div
      style={{ width: ORCH_NODE_W, height: ORCH_NODE_H }}
      className={cn(
        'flex rounded-lg border bg-neutral-900/95 shadow-mac transition-colors',
        hot ? 'border-teal-400/70 ring-1 ring-teal-400/40' : 'border-edge/[0.08]',
        selected && 'border-sky-400/70 ring-2 ring-sky-500/40',
        missing ? 'opacity-50' : 'hover:border-blue-500/40',
      )}
    >
      <PortRail ports={inPorts} side="in" />
      <PortRail ports={outPorts} side="out" />
      <PortColumn ports={inPorts} side="in" />
      <div className="flex min-w-0 flex-1 items-center gap-2 border-x border-edge/[0.06] px-2">
        <Zap className="h-4 w-4 shrink-0 text-amber-300" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-neutral-100">
          {t('orch.triggerNode')}
        </span>
        <Badge className="shrink-0 bg-amber-900/50 text-[9px] text-amber-300">
          {t('orch.entryTag')}
        </Badge>
      </div>
      <PortColumn ports={outPorts} side="out" />
    </div>
  );
}

const nodeTypes = {
  orchSession: SessionNode,
  orchWebhook: WebhookNode,
  orchTrigger: TriggerNode,
  orchGroup: GroupNode,
};

/**
 * 自定义边：smoothstep 折线 + 触发（hot）时沿路径滑一颗光点（`animateMotion`
 * 沿 path 走，方向即消息流向），叠加 ReactFlow 自带的虚线滚动双保险。
 * 正文标签走 HTML 层（`EdgeLabelRenderer`）：限宽在列间空隙里换行，不用单行
 * `…` 截断，也不会被节点卡片盖住（标签宽度 = 列间距 − 两侧留白）。
 */
function OrchFlowEdge({
  id,
  sourceX,
  sourceY,
  sourcePosition,
  targetX,
  targetY,
  targetPosition,
  markerEnd,
  style,
  interactionWidth,
  data,
}: EdgeProps): React.ReactElement {
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });
  const hot = (data?.hot as boolean | undefined) ?? false;
  const label = (data?.label as string | undefined) ?? '';
  const tone = (data?.tone as 'new' | 'invalid' | undefined) ?? undefined;
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        style={style}
        interactionWidth={interactionWidth}
      />
      {hot && (
        <circle r={3.5} fill="#2dd4bf">
          <animateMotion dur="0.9s" repeatCount="indefinite" path={path} />
        </circle>
      )}
      {label !== '' && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              // 标签只占连接点之后的空隙：不与节点卡片叠（标签层在节点之下）。
              maxWidth: ORCH_COL_W - ORCH_NODE_W - 24,
            }}
            className={cn(
              'pointer-events-none select-none whitespace-pre-wrap break-words rounded px-1 py-0.5 text-[10px] leading-4',
              // 文字过多只露前三行，余下省略（display:-webkit-box 才能钳行数）
              'line-clamp-3',
              'bg-neutral-950/85',
              tone === 'invalid'
                ? 'text-red-300/90 ring-1 ring-red-500/30'
                : tone === 'new'
                  ? 'text-amber-200/90 ring-1 ring-amber-500/25'
                  : 'text-neutral-400',
            )}
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const edgeTypes = { orchFlow: OrchFlowEdge };

/** 节点的 flash 键（session 挂 `s:` 前缀；webhook/trigger 用裸 id）。 */
function nodeFlashKey(nodeId: string): string {
  return nodeId.startsWith('w:') || nodeId.startsWith('t:') ? nodeId : `s:${nodeId}`;
}

/** 渲染节点键 → 编排节点 id（`s:<会话>` → 会话 id，`w:`/`t:` 原样，分组框 = null）。 */
function orchIdOfRenderKey(key: string): string | null {
  if (key.startsWith('s:')) return key.slice(2);
  if (key.startsWith('w:') || key.startsWith('t:')) return key;
  return null;
}

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

  // ---- 实时态（两条编排帧带全量轻量态：就地更新、不重拉） ----
  // 按编排记账：总览模式下所有编排的运行态与动效都要跟，不只选中的那份。
  const [liveRuns, setLiveRuns] = useState<ReadonlyMap<number, LiveRun>>(new Map());
  /** 选中那份的实时态（头部徽标与编辑画布的 pending 都读它）。 */
  const live = order != null ? (liveRuns.get(order) ?? null) : null;
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
  /** 正在点亮的边 / 节点（键 = `o<编排id>:e:<边id>` 或 `o<编排id>:n:<节点键>`，值 = 到期时刻）。 */
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

  /** 总览布局：合并图复用单图布局（全局视图按项目分组收起，同编辑画布机制）。 */
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

  /** 新增（未保存）与无效的连线：都用虚线画（新增琥珀、无效红）。 */
  const edgeTone = useMemo(() => {
    if (!editing) return new Map<string, 'new' | 'invalid'>();
    let baseIds = new Set<string>();
    try {
      const parsed = JSON.parse(editing.base) as unknown[];
      const baseEdges = Array.isArray(parsed[3]) ? (parsed[3] as unknown[][]) : [];
      baseIds = new Set(baseEdges.map((e) => String(e[0])));
    } catch {
      baseIds = new Set();
    }
    const invalid = invalidEdgeIds(editing.draft);
    const m = new Map<string, 'new' | 'invalid'>();
    for (const edge of editing.draft.edges) {
      if (invalid.has(edge.id)) m.set(edge.id, 'invalid');
      else if (!baseIds.has(edge.id)) m.set(edge.id, 'new');
    }
    return m;
  }, [editing]);

  const flowNodes: Node[] = useMemo(() => {
    if (!laid || !draft) return [];
    const now = Date.now();
    const orchId = editing?.id ?? null;
    const entryIds = new Set(graphDirections(draft.nodes, draft.edges).entries.map((n) => n.id));
    const labelOf = (id: string): string =>
      id.startsWith('w:')
        ? t(entryIds.has(id) ? 'orch.webhookEntry' : 'orch.webhookExit')
        : sessionLabel(sessionById.get(id)?.title ?? null, id);
    /** 入向 hook（左栏）：一条入边一枚，标题写「hookN ← 上游」。 */
    const insOf = (nodeId: string): PortItem[] =>
      draft.edges
        .filter((edge) => edge.to === nodeId)
        .map((edge, i) => ({
          neighbor: edge.from,
          edgeId: edge.id,
          hint: `hook${i + 1} ← ${labelOf(edge.from)}`,
        }));
    /** 出向 hook（右栏）：一条出边一枚，标题写「hookN → 下游」。 */
    const outsOf = (nodeId: string): PortItem[] =>
      draft.edges
        .filter((edge) => edge.from === nodeId)
        .map((edge, i) => ({
          neighbor: edge.to,
          edgeId: edge.id,
          hint: `hook${i + 1} → ${labelOf(edge.to)}`,
        }));
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
              const open = expandedGroups ?? new Set(groupCounts.keys());
              const next = new Set([...groupCounts.keys()].filter((id) => open.has(id)));
              if (next.has(pid)) next.delete(pid);
              else next.add(pid);
              setGroupTouched(next);
            },
          },
        };
      }
      if (n.kind === 'trigger') {
        const nodeId = n.nodeId ?? '';
        return {
          id: n.key,
          type: 'orchTrigger',
          position: { x: n.x, y: n.y },
          draggable: false,
          data: {
            hot: orchId != null && (flash[`o${orchId}:n:${nodeFlashKey(nodeId)}`] ?? 0) > now,
            selected: sel?.kind === 'node' && sel.id === nodeId,
            missing: !draft.nodes.some((x) => x.id === nodeId),
            inPorts: [],
            outPorts: outsOf(nodeId),
          },
        } satisfies Node;
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
            hot: orchId != null && (flash[`o${orchId}:n:${nodeFlashKey(nodeId)}`] ?? 0) > now,
            running: false,
            missing: !node,
            selected: sel?.kind === 'node' && sel.id === nodeId,
            pickable: false,
            inPorts: insOf(nodeId),
            outPorts: outsOf(nodeId),
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
          hot: orchId != null && (flash[`o${orchId}:n:${nodeFlashKey(sessionId)}`] ?? 0) > now,
          running: live?.status === 'running' && pending > 0,
          missing: !row,
          selected: sel?.kind === 'node' && sel.id === sessionId,
          pickable: false,
          inPorts: insOf(sessionId),
          outPorts: outsOf(sessionId),
          onOpen: openMessages,
          onPickPort: (edgeId: string) => setSel({ kind: 'edge', id: edgeId }),
        },
      } satisfies Node;
    });
  }, [
    laid,
    draft,
    editing,
    sessionById,
    statuses,
    live,
    flash,
    groupCounts,
    expandedGroups,
    projectName,
    openMessages,
    sel,
    t,
  ]);

  const flowEdges: Edge[] = useMemo(() => {
    if (!laid || !draft) return [];
    const now = Date.now();
    const orchId = editing?.id ?? null;
    const edgeById = new Map(draft.edges.map((e) => [e.id, e] as const));
    // 一条连线 = 上游卡片右栏那枚 hook → 下游卡片左栏那枚 hook；正文标签挂在线上。
    // 端点被收进分组框时没有端口，退回无 handle 的一整段。
    return laid.edges.map((e: OrchLaidEdge): Edge => {
      const hot =
        orchId != null && e.edgeIds.some((id) => (flash[`o${orchId}:e:${id}`] ?? 0) > now);
      const picked = sel?.kind === 'edge' && e.edgeIds.includes(sel.id);
      const tone = e.edgeIds.map((id) => edgeTone.get(id)).find(Boolean);
      const text = e.edgeIds.map((id) => edgeById.get(id)?.text ?? '').find((x) => x.trim()) ?? '';
      const stroke = hot
        ? { stroke: '#2dd4bf', strokeWidth: 2 }
        : picked
          ? { stroke: '#38bdf8', strokeWidth: 2 }
          : tone === 'invalid'
            ? { stroke: '#ef4444', strokeWidth: 1.5, strokeDasharray: '5 4' }
            : tone === 'new'
              ? { stroke: '#f59e0b', strokeWidth: 1.5, strokeDasharray: '5 4' }
              : { strokeWidth: 1.5 };
      // 端口挂在**编排节点 id** 上（`s:<会话>` 是渲染键，端口是 `out:<会话>`）。
      const fromId = orchIdOfRenderKey(e.from);
      const toId = orchIdOfRenderKey(e.to);
      return {
        id: e.key,
        source: e.from,
        target: e.to,
        ...(fromId != null && toId != null
          ? { sourceHandle: `out:${toId}`, targetHandle: `in:${fromId}` }
          : {}),
        type: 'orchFlow',
        animated: hot,
        interactionWidth: 24,
        data: { hot, ...(text ? { label: text } : {}), ...(tone ? { tone } : {}) },
        style: stroke,
        markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
      };
    });
  }, [laid, draft, editing, flash, sel, edgeTone]);

  // ---- 总览画布（未选编排）：合并图只读 + 实时动效；编辑入口在首节点卡片上 ----
  const enterOrchestration = useCallback((row: OrchestrationRow): void => {
    setEditing(asEditing(row));
  }, []);

  /** 以该节点为入口的编排（全部列表里找，不受当前筛选影响）。 */
  const entryOrchestrations = useCallback(
    (nodeId: string): OrchestrationRow[] =>
      (list ?? []).filter((row) =>
        graphDirections(row.nodes, row.edges).entries.some((n) => n.id === nodeId),
      ),
    [list],
  );

  /** 点节点卡片：出「编辑/新建编排」面板（任何会话都能当新编排的首节点）。 */
  const pickEntry = useCallback((nodeId: string | null): void => {
    if (nodeId == null) return;
    setEdgeInfo(null);
    setEntryPick(nodeId);
  }, []);

  const overviewFlowNodes: Node[] = useMemo(() => {
    if (!overview || !laidOverview) return [];
    const now = Date.now();
    const hasIn = new Set(overview.edges.map((e) => e.to));
    const labelOf = (id: string): string =>
      id.startsWith('w:')
        ? t(hasIn.has(id) ? 'orch.webhookExit' : 'orch.webhookEntry')
        : sessionLabel(sessionById.get(id)?.title ?? null, id);
    const insOf = (nodeId: string): PortItem[] =>
      overview.edges
        .filter((edge) => edge.to === nodeId)
        .map((edge, i) => ({
          neighbor: edge.from,
          hint: `hook${i + 1} ← ${labelOf(edge.from)}`,
        }));
    const outsOf = (nodeId: string): PortItem[] =>
      overview.edges
        .filter((edge) => edge.from === nodeId)
        .map((edge, i) => ({
          neighbor: edge.to,
          hint: `hook${i + 1} → ${labelOf(edge.to)}`,
        }));
    return laidOverview.laid.nodes.map((n) => {
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
            count: laidOverview.counts.get(pid) ?? 0,
            collapsed: (n.hidden ?? 0) > 0,
            hidden: n.hidden ?? 0,
            onToggle: () => {
              const open = expandedGroups ?? new Set(laidOverview.counts.keys());
              const next = new Set(
                [...laidOverview.counts.keys()].filter((id) => open.has(id)),
              );
              if (next.has(pid)) next.delete(pid);
              else next.add(pid);
              setGroupTouched(next);
            },
          },
        };
      }
      if (n.kind === 'trigger') {
        const nodeId = n.nodeId ?? '';
        return {
          id: n.key,
          type: 'orchTrigger',
          position: { x: n.x, y: n.y },
          draggable: false,
          data: {
            hot: false,
            selected: false,
            missing: false,
            inPorts: [],
            outPorts: overview.edges
              .filter((edge) => edge.from === nodeId)
              .map((edge, i) => ({ neighbor: edge.to, hint: `hook${i + 1} → ${labelOf(edge.to)}` })),
          },
        } satisfies Node;
      }
      const nodeId = n.nodeId ?? '';
      const orchIds = overview.merged.orchIdsOf.get(nodeId) ?? [];
      const hot = orchIds.some(
        (oid) => (flash[`o${oid}:n:${nodeFlashKey(nodeId)}`] ?? 0) > now,
      );
      const pickable = !nodeId.startsWith('w:') || entryOrchestrations(nodeId).length > 0;
      if (n.kind === 'webhook') {
        return {
          id: n.key,
          type: 'orchWebhook',
          position: { x: n.x, y: n.y },
          draggable: false,
          data: {
            direction: hasIn.has(nodeId) ? ('exit' as const) : ('entry' as const),
            hot,
            running: false,
            missing: false,
            selected: false,
            pickable,
            inPorts: insOf(nodeId),
            outPorts: outsOf(nodeId),
          },
        } satisfies Node;
      }
      const srow = sessionById.get(nodeId);
      // 待回 = 各在跑编排对该会话的 pending 之和（跨编排 n:n，一个节点可同时
      // 收多份编排的投递）。
      let pending = 0;
      for (const oid of orchIds) {
        const lr = liveRuns.get(oid);
        if (lr?.status === 'running') pending += lr.pendingCounts[nodeId] ?? 0;
      }
      return {
        id: n.key,
        type: 'orchSession',
        position: { x: n.x, y: n.y },
        draggable: false,
        data: {
          sessionId: nodeId,
          label: sessionLabel(srow?.title ?? null, nodeId),
          projectLabel: projectName(srow?.projectId ?? null),
          harness: srow?.harness ?? null,
          status: statuses.get(nodeId) ?? 'open',
          isEntry: !hasIn.has(nodeId),
          pending,
          hot,
          running: pending > 0,
          missing: !srow,
          selected: false,
          pickable,
          inPorts: insOf(nodeId),
          outPorts: outsOf(nodeId),
          onOpen: openMessages,
        },
      } satisfies Node;
    });
  }, [
    overview,
    laidOverview,
    sessionById,
    statuses,
    liveRuns,
    flash,
    projectName,
    openMessages,
    entryOrchestrations,
    expandedGroups,
    t,
  ]);

  const overviewFlowEdges: Edge[] = useMemo(() => {
    if (!overview || !laidOverview) return [];
    const now = Date.now();
    // 合并边按端点对回查（laid 的 edgeIds 就是合成的 `${from}->${to}`）。
    const pairByKey = new Map<string, MergedOrchEdge>();
    for (const e of overview.edges) pairByKey.set(`${e.from}->${e.to}`, e);
    return laidOverview.laid.edges.map((e: OrchLaidEdge): Edge => {
      const merged = pairByKey.get(e.edgeIds[0] ?? '');
      const hot =
        merged?.pairs.some((p) => (flash[`o${p.orchId}:e:${p.edgeId}`] ?? 0) > now) ?? false;
      const text = merged?.pairs.find((p) => p.text.trim())?.text ?? '';
      const fromId = orchIdOfRenderKey(e.from);
      const toId = orchIdOfRenderKey(e.to);
      return {
        id: e.key,
        source: e.from,
        target: e.to,
        ...(fromId != null && toId != null
          ? { sourceHandle: `out:${toId}`, targetHandle: `in:${fromId}` }
          : {}),
        type: 'orchFlow',
        animated: hot,
        interactionWidth: 24,
        data: { hot, ...(text ? { label: text } : {}) },
        style: hot ? { stroke: '#2dd4bf', strokeWidth: 2 } : { strokeWidth: 1.5 },
        markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
      };
    });
  }, [overview, laidOverview, flash]);

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
    if (flowNodeId.startsWith('w:') || flowNodeId.startsWith('t:')) return flowNodeId;
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

  /**
   * 渲染边的 id 是布局合并后的键（两段各带 `::a` / `::b` 后缀），选中的必须是
   * 底下那条原始边。连接点节点 id 是 `h:<边键>`，同一条线点哪儿都落到同一处。
   */
  const selectEdge = (flowEdgeId: string): void => {
    const baseKey = flowEdgeId.startsWith('h:')
      ? flowEdgeId.slice(2)
      : flowEdgeId.replace(/::[ab]$/, '');
    const real = laid?.edges.find((e) => e.key === baseKey)?.edgeIds[0];
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
    // 项目归属：有 session 节点 = 服务端从入口派生（不传）；无 session 节点
    // （纯 webhook/trigger 编排）= 必须显式给——画布定义行的项目选择器写
    // editing.projectId（全局视图新建时必选，否则服务端 400）。
    const hasSessionNode = editing.draft.nodes.some((n) => n.kind === 'session');
    const body = {
      name: editing.draft.name.trim(),
      startText: editing.draft.startText,
      ...(hasSessionNode ? {} : { projectId: editing.projectId ?? projectId ?? undefined }),
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
            (selNode && draft) || selEdge ? 'right-[21rem]' : 'right-2',
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
                className="inline-flex items-center gap-1 rounded border border-edge/[0.1] px-2 py-1 text-[11px] text-neutral-300 transition-colors hover:bg-edge/[0.06]"
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
              className="nopan max-w-[calc(100%-1rem)] space-y-1"
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
                  className="min-w-[10rem] max-w-[16rem] rounded bg-neutral-900 px-1.5 py-1 text-[11px]"
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
                  className="inline-flex items-center gap-1 rounded-md border border-edge/[0.1] bg-neutral-900/90 px-2 py-1 text-[11px] text-neutral-300 transition-colors hover:bg-neutral-800"
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
                className="w-32 rounded border border-edge/[0.1] bg-neutral-950/90 px-1.5 py-0.5 text-[10px] text-neutral-100 placeholder:text-neutral-600 focus:border-blue-500/40 focus:outline-none"
              />
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
              <span className="rounded bg-neutral-950/90 px-1.5 py-0.5 text-[10px] text-neutral-500">
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
                  <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-neutral-100">
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
                    className="flex w-full items-center gap-1 rounded px-1 py-1 text-left text-[11px] text-neutral-200 transition-colors hover:bg-edge/[0.08]"
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
                    className="flex w-full items-center gap-1 rounded border border-dashed border-edge/[0.14] px-1 py-1 text-left text-[11px] text-neutral-400 transition-colors hover:bg-edge/[0.06] hover:text-neutral-200"
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
                  <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-neutral-100">
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
                          <span className="block truncate text-[10px] text-neutral-500">{name}</span>
                          <p className="break-words whitespace-pre-wrap rounded bg-neutral-950 px-1.5 py-1 text-[10px] text-neutral-300">
                            {pair.text.trim() || t('orch.edgeTextEmpty')}
                          </p>
                        </div>
                      );
                    },
                  );
                })()}
                <p className="text-[9px] leading-relaxed text-neutral-600">
                  {t('orch.edgeInfoHint')}
                </p>
              </Panel>
            )}
            <Panel position="bottom-center" className="pointer-events-none max-w-[70%]">
              <p className="min-w-0 truncate text-[10px] text-neutral-600">
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
              className="nopan max-w-[calc(100%-1rem)] space-y-1"
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
                  className="min-w-[10rem] max-w-[16rem] rounded bg-neutral-900 px-1.5 py-1 text-[11px]"
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
                        className="min-w-[10rem] rounded bg-neutral-900 px-1.5 py-1 text-[11px]"
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
              <button
                type="button"
                disabled={draft.nodes.length >= ORCH_MAX_NODES}
                onClick={() => patch(addTriggerNode)}
                title={t('orch.addTrigger')}
                className="inline-flex items-center gap-1 rounded border border-edge/[0.1] bg-neutral-950/90 px-1.5 py-0.5 text-[10px] text-neutral-300 transition-colors hover:bg-edge/[0.06] disabled:opacity-40"
              >
                <Zap className="h-3 w-3" />
                {t('orch.addTrigger')}
              </button>
              <span className="rounded bg-neutral-950/90 px-1.5 py-0.5 text-[10px] text-neutral-500">
                {t('orch.summary', { nodes: draft.nodes.length, edges: draft.edges.length })}
              </span>
              {visible != null && visible.nodes.length === 0 && (
                <span className="rounded bg-neutral-950/90 px-1.5 py-0.5 text-[10px] text-neutral-500">
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
                  className="min-w-[12rem] flex-1 rounded border border-edge/[0.1] bg-neutral-950 px-2 py-1 text-[11px] text-neutral-100 placeholder:text-neutral-600 focus:border-blue-500/40 focus:outline-none"
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
                            'inline-flex max-w-[12rem] items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] transition-colors',
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
                  className="min-w-[10rem] flex-1 rounded border border-edge/[0.1] bg-neutral-950 px-2 py-1 text-[11px] text-neutral-100 placeholder:text-neutral-600 focus:border-blue-500/40 focus:outline-none"
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
                      'w-full rounded border px-1.5 py-1 text-[10px] transition-colors',
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
                </div>
              )}
              {selEdge && (
                <div className="space-y-1.5 border-b border-edge/[0.08] pb-2.5">
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
                  rows={5}
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
                  rows={3}
                  placeholder={t('orch.edgeExtractHint')}
                  title={t('orch.edgeExtract')}
                  className="w-full resize-y rounded border border-edge/[0.1] bg-neutral-950 px-1.5 py-1 text-[10px] text-neutral-100 placeholder:text-neutral-600 focus:border-blue-500/40 focus:outline-none"
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
                  className="w-full resize-y rounded border border-edge/[0.1] bg-neutral-950 px-1.5 py-1 text-[10px] text-neutral-100 placeholder:text-neutral-600 focus:border-blue-500/40 focus:outline-none"
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
                  className="w-full resize-y rounded border border-edge/[0.1] bg-neutral-950 px-1.5 py-1 text-[10px] text-neutral-100 placeholder:text-neutral-600 focus:border-blue-500/40 focus:outline-none"
                />
                {/* 判定引擎信号：谁在判这条边（决策模型配了先问它，判不准回落 fork）。 */}
                {decisionConfigured !== null && (
                  <p className="text-[9px] leading-relaxed text-neutral-600">
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
                  className="inline-flex items-center gap-1 rounded border border-red-500/30 px-1.5 py-0.5 text-[10px] text-red-300 transition-colors hover:bg-red-950/40"
                >
                  <Trash2 className="h-3 w-3" />
                  {t('orch.removeEdge')}
                </button>
                </div>
              )}
              {selNode && draft && selNodeKind === 'trigger' && (
                <div className="space-y-1.5 border-b border-edge/[0.08] pb-2.5">
                  <div className="flex items-center gap-1">
                    <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-neutral-100">
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
                  <p className="text-[9px] leading-relaxed text-neutral-600">
                    {t('orch.triggerNodeHint')}
                  </p>
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
              )}
              {/* webhook 节点检查器：入口管端点（复制/轮换），出口填 url/secret。 */}
              {selNode && draft && selNodeKind === 'webhook' && (
                <div className="space-y-1.5 pb-2.5">
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
                </div>
              )}
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
              {edgeTone.size > 0 && (
                <p className="truncate text-center text-[9px] text-neutral-600">
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
                                      <Badge className="shrink-0 bg-neutral-800 text-[9px] text-neutral-400">
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
                                          'min-w-0 flex-1 break-words text-[10px]',
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
