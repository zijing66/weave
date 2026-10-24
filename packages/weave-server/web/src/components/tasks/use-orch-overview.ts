import { useCallback, useMemo } from 'react';
import { MarkerType, type Edge, type Node } from '@xyflow/react';
import type { OrchCanvasLayout, OrchLaidEdge } from './orchestration-canvas-layout';
import { sessionLabel } from '@/lib/hook-payload';
import type { MergedOrchEdge } from './orchestration-graph';
import { graphDirections, mergeOrchestrations } from './orchestration-graph';
import type { LiveRun, PortItem } from './orchestration-canvas-nodes';
import { asEditing, nodeFlashKey, orchIdOfRenderKey } from './orchestration-canvas-nodes';
import type { SessionStatus } from './session-status';
import type { OrchestrationRow, SessionRow } from '@/lib/api';
import type { Dispatch, SetStateAction } from 'react';
import type { TFunc } from '@/i18n/t';

/**
 * 总览画布域（未选编排）：合并图只读 + 实时动效。enterOrchestration/pickEntry
 * 是编辑入口的两个手势；overviewFlowNodes/overviewFlowEdges 把合并图 + 布局 +
 * flash 辉光拼成 ReactFlow 的节点/边。
 */
export function useOrchOverview(deps: {
  /** 合并图（跨编排去重）。 */
  overview: {
    merged: ReturnType<typeof mergeOrchestrations>;
    nodes: ReturnType<typeof mergeOrchestrations>['nodes'];
    edges: MergedOrchEdge[];
  } | null;
  /** 总览布局产物（laid + 每项目节点数）。 */
  laidOverview: { laid: OrchCanvasLayout; counts: Map<number, number> } | null;
  /** 会话行（总览节点渲染要读 title/harness/status）。 */
  sessionById: ReadonlyMap<string, SessionRow>;
  /** 项目名（节点副行）。 */
  projectName: (projectId: number | null) => string;
  /** 正在点亮的边/节点（键 → 到期时刻）。 */
  flash: Record<string, number>;
  /** 编排清单（entryOrchestrations 全表找）。 */
  list: readonly OrchestrationRow[] | null;
  setEditing: (e: ReturnType<typeof asEditing> | null) => void;
  setEdgeInfo: (v: string | null) => void;
  setEntryPick: (v: string | null) => void;
  /** 节点卡片上的「看对话」手势（SessionNode 的 onOpen）。 */
  openMessages: (sessionId: string) => void;
  /** 分组展开态（总览节点渲染要读）。 */
  expandedGroups: ReadonlySet<number> | null;
  setGroupTouched: Dispatch<SetStateAction<Set<number> | null>>;
  /** 实时运行态（节点 pending 求和）。 */
  liveRuns: ReadonlyMap<number, LiveRun>;
  /** 会话状态总线。 */
  statuses: ReadonlyMap<string, SessionStatus>;
  t: TFunc;
}) {
  const {
    overview, laidOverview, flash, list, setEditing, setEdgeInfo, setEntryPick,
    openMessages, expandedGroups, setGroupTouched, liveRuns, statuses,
    sessionById, projectName, t,
  } = deps;

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

  return { enterOrchestration, entryOrchestrations, pickEntry, overviewFlowNodes, overviewFlowEdges };
}
