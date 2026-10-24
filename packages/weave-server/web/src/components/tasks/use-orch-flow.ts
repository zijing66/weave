import { useMemo } from 'react';
import { MarkerType, type Edge, type Node } from '@xyflow/react';
import type { OrchLaidEdge } from './orchestration-canvas-layout';
import { layoutOrchestrationCanvas } from './orchestration-canvas-layout';
import { graphDirections, invalidEdgeIds, type OrchDraft } from './orchestration-graph';
import { nodeFlashKey, orchIdOfRenderKey } from './orchestration-canvas-nodes';
import type { Editing } from './orchestration-canvas-nodes';
import type { OrchCanvasSession } from './orchestration-canvas-layout';
import type { LiveRun, PortItem } from './orchestration-canvas-nodes';
import { sessionLabel } from '@/lib/hook-payload';
import type { SessionRow } from '@/lib/api';
import type { SessionStatus } from './session-status';
import type { Dispatch, SetStateAction } from 'react';
import type { TFunc } from '@/i18n/t';

/**
 * 编辑画布构建域：布局（laid）、新增/无效边的虚线色调（edgeTone）、
 * flowNodes/flowEdges（flash 辉光、选中高亮、端口映射、正文标签）。
 */
export function useOrchFlow(deps: {
  /** 筛选后的当前编排（visible：节点过滤后的 draft 投影）。 */
  visible: { nodes: OrchDraft['nodes']; edges: OrchDraft['edges'] } | null;
  draft: OrchDraft | null;
  editing: Editing | null;
  /** 会话行（布局与节点渲染）。 */
  canvasSessions: ReadonlyMap<string, OrchCanvasSession>;
  groupProjects: boolean;
  collapsedGroups: ReadonlySet<number>;
  /** 正在点亮的边/节点。 */
  flash: Record<string, number>;
  /** 选中态（边高亮 + 节点点击写回）。 */
  sel: { kind: 'edge' | 'node'; id: string } | null;
  setSel: (s: { kind: 'edge' | 'node'; id: string } | null) => void;
  /** 选中编排的实时态（节点 running 辉光）。 */
  live: LiveRun | null;
  /** 会话状态总线（节点状态图标）。 */
  statuses: ReadonlyMap<string, SessionStatus>;
  /** 会话行（节点渲染）。 */
  sessionById: ReadonlyMap<string, SessionRow>;
  /** 每项目节点数（分组框角标）。 */
  groupCounts: Map<number, number>;
  setGroupTouched: Dispatch<SetStateAction<Set<number> | null>>;
  /** 项目名（节点副行）。 */
  projectName: (projectId: number | null) => string;
  /** 「看对话」手势。 */
  openMessages: (sessionId: string) => void;
  /** 分组展开态。 */
  expandedGroups: ReadonlySet<number> | null;
  t: TFunc;
}) {
  const {
    visible, draft, editing, canvasSessions, groupProjects, collapsedGroups,
    flash, sel, setSel, live, statuses, sessionById, groupCounts, setGroupTouched,
    projectName, openMessages, expandedGroups, t,
  } = deps;
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
  return { laid, edgeTone, flowNodes, flowEdges };
}
