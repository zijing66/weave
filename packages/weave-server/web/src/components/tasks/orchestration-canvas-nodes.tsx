import { Handle, Position, BaseEdge, EdgeLabelRenderer, getSmoothStepPath, type EdgeProps, type Node, type NodeProps } from '@xyflow/react';
import type { Harness } from '@weavecode/core/harness';
import type {
  OrchestrationRow,
  OrchestrationRunStatus,
  OrchestrationTrigger,
} from '@/lib/api';
import { cn } from '@/lib/utils';
import { useT } from '@/i18n/I18nProvider';
import type { MessageKey } from '@/i18n/dict';
import { Badge } from '@/components/ui/badge';
import { SessionStatusIcon } from './SessionStatusIcon';
import type { SessionStatus } from './session-status';
import { ORCH_COL_W, ORCH_GROUP_HEADER_H, ORCH_NODE_H, ORCH_NODE_W } from './orchestration-canvas-layout';
import type { OrchDraft } from './orchestration-graph';
import { ChevronDown, ChevronRight, Globe, MessageSquare, Zap } from 'lucide-react';

/** 一次投递的点亮时长（边与节点同口径）。 */
export const FLASH_MS = 1200;
/** 运行日志一页条数。 */
export const RUN_PAGE = 30;

export const RUN_STATUS_KEY: Record<OrchestrationRunStatus, MessageKey> = {
  running: 'orch.statusRunning',
  done: 'orch.statusDone',
  failed: 'orch.statusFailed',
  cancelled: 'orch.statusCancelled',
  interrupted: 'orch.statusInterrupted',
};
export const RUN_STATUS_BADGE: Record<OrchestrationRunStatus, string> = {
  running: 'bg-sky-900/50 text-sky-300',
  done: 'bg-emerald-900/40 text-emerald-300',
  failed: 'bg-red-900/40 text-red-300',
  cancelled: 'bg-neutral-800 text-neutral-400',
  interrupted: 'bg-amber-900/40 text-amber-300',
};
export const TRIGGER_KEY: Record<OrchestrationTrigger, MessageKey> = {
  manual: 'orch.triggerManual',
  webhook: 'orch.triggerWebhook',
  cron: 'orch.triggerCron',
};

export const emptyDraft = (): OrchDraft => ({
  name: '',
  startText: '',
  nodes: [],
  edges: [],
  cron: null,
});

export const draftOf = (row: OrchestrationRow): OrchDraft => ({
  name: row.name,
  startText: row.startText,
  nodes: row.nodes.map((n) => ({ ...n })),
  edges: row.edges.map((e) => ({ ...e })),
  cron: row.cron,
});

/** 脏判定用：字段序固定，比较的只是内容。 */
export const serialize = (draft: OrchDraft): string =>
  JSON.stringify([
    draft.name,
    draft.startText,
    draft.nodes.map((n) => [n.id, n.kind, n.webhookToken ?? '', n.url ?? '', n.secret ?? '', n.autoFire ?? false]),
    draft.edges.map((e) => [e.id, e.from, e.to, e.text, e.extract ?? '', e.condition ?? '', e.when ?? '']),
    draft.cron,
  ]);

export interface Editing {
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
export interface LiveRun {
  runId: number;
  status: OrchestrationRunStatus;
  deliveries: number;
  pendingCounts: Record<string, number>;
}

export const asEditing = (row: OrchestrationRow): Editing => {
  const draft = draftOf(row);
  return { id: row.id, draft, base: serialize(draft), projectId: row.projectId };
};

// ---------------------------------------------------------------------------
// 画布节点
// ---------------------------------------------------------------------------

/** 卡片里的一枚外接连接点：管着一条连线（点它 = 选中那条边）。 */
export interface PortItem {
  /** 端口 id 的邻居部分（下游 = `out:<下游>`；上游 = `in:<上游>`）。 */
  neighbor: string;
  /** 连线 id（编辑面用于选中；总览为空）。 */
  edgeId?: string;
  /** 悬停说明：hookN → 下游会话名 / 来自上游会话名。 */
  hint: string;
}

export type SessionNodeData = {
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
export type SessionFlowNode = Node<SessionNodeData, 'orchSession'>;

/**
 * 三栏卡片的左右 hook 栏：一枚枚外接连接点（纵向均分）。连接点本身就是
 * ReactFlow 的 Handle（id = `in:<上游>` / `out:<下游>`），所以线与点是同一个
 * 东西——依附关系一眼可见，拖线也从这儿起手。
 */
export function PortRail({ ports, side }: { ports: PortItem[]; side: 'in' | 'out' }) {
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
export function PortColumn({
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
            'nodrag absolute left-1/2 flex h-4 w-4 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full text-9 font-semibold ring-1 transition-colors',
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

export function SessionNode({ data }: NodeProps<SessionFlowNode>) {
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
              <Badge className="shrink-0 bg-teal-900/50 text-10 text-teal-300">
                {t('orch.entryTag')}
              </Badge>
            )}
          </span>
          <span className="mt-0.5 flex items-center gap-1">
            <span className="min-w-0 truncate text-11 text-neutral-500">{projectLabel}</span>
            {pending > 0 && (
              <Badge className="shrink-0 animate-pulse bg-amber-900/50 text-10 text-amber-300">
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

export type GroupNodeData = {
  label: string;
  count: number;
  collapsed: boolean;
  hidden: number;
  onToggle: () => void;
};
export type GroupFlowNode = Node<GroupNodeData, 'orchGroup'>;

export function GroupNode({ data }: NodeProps<GroupFlowNode>) {
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
          <span className="max-w-[10rem] truncate text-11 font-medium">{label}</span>
        </button>
        <span className="text-11 text-neutral-600">{count}</span>
        {collapsed && hidden > 0 && (
          <span className="text-11 text-neutral-600">
            {t('orch.groupHidden', { n: hidden })}
          </span>
        )}
      </div>
    </div>
  );
}

export type WebhookNodeData = {
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
export type WebhookFlowNode = Node<WebhookNodeData, 'orchWebhook'>;

export function WebhookNode({ data }: NodeProps<WebhookFlowNode>) {
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
            'shrink-0 text-10',
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

export type TriggerNodeData = {
  hot: boolean;
  selected: boolean;
  missing: boolean;
  inPorts: PortItem[];
  outPorts: PortItem[];
};
export type TriggerFlowNode = Node<TriggerNodeData, 'orchTrigger'>;

/** 手动触发入口（虚节点）：手动触发选中它时，正文经出边 {upstream} 下发。 */
export function TriggerNode({ data }: NodeProps<TriggerFlowNode>) {
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
        <Badge className="shrink-0 bg-amber-900/50 text-10 text-amber-300">
          {t('orch.entryTag')}
        </Badge>
      </div>
      <PortColumn ports={outPorts} side="out" />
    </div>
  );
}

export const nodeTypes = {
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
export function OrchFlowEdge({
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
              'pointer-events-none select-none whitespace-pre-wrap break-words rounded px-1 py-0.5 text-11 leading-4',
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

export const edgeTypes = { orchFlow: OrchFlowEdge };

/** 节点的 flash 键（session 挂 `s:` 前缀；webhook/trigger 用裸 id）。 */
export function nodeFlashKey(nodeId: string): string {
  return nodeId.startsWith('w:') || nodeId.startsWith('t:') ? nodeId : `s:${nodeId}`;
}

/** 渲染节点键 → 编排节点 id（`s:<会话>` → 会话 id，`w:`/`t:` 原样，分组框 = null）。 */
export function orchIdOfRenderKey(key: string): string | null {
  if (key.startsWith('s:')) return key.slice(2);
  if (key.startsWith('w:') || key.startsWith('t:')) return key;
  return null;
}
