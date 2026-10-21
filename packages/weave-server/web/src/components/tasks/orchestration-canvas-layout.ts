import type { OrchestrationEdge, OrchestrationNode } from '@/lib/api';
import { ranksOf } from './orchestration-graph';

/**
 * 编排画布布局（纯函数，可单测）：节点按层（入口在左、每波右推一列）排布；
 * 全局视图额外给每个项目画一个分组框，框住它自己的会话——收起的项目只剩
 * 一个框（带会话数），展开才摆出里面的会话。webhook 节点不属于任何项目，
 * 归「未知项目」（id 0）框。项目框按「不重叠」的纵向带排：同一列上两个项目
 * 不会叠在一起。
 */

/** 节点宽（对齐画布节点的 w-[220px]）。 */
export const ORCH_NODE_W = 220;
/** 节点高。 */
export const ORCH_NODE_H = 56;
/** 层间距（列）。 */
export const ORCH_COL_W = 320;
/** 同列节点的行距。 */
export const ORCH_ROW_H = 84;
/** 分组框的内边距（上下左右）与头部高。 */
export const ORCH_GROUP_PAD = 14;
export const ORCH_GROUP_HEADER_H = 30;
/** 收起的分组框高。 */
export const ORCH_GROUP_COLLAPSED_H = 44;

export interface OrchCanvasSession {
  sessionId: string;
  title: string | null;
  projectId: number | null;
}

export interface OrchLaidNode {
  /** ReactFlow 节点 id：`s:<sessionId>` / `w:<uuid>` / `g:<projectId>`。 */
  key: string;
  kind: 'session' | 'webhook' | 'group';
  x: number;
  y: number;
  /** 编排节点 id（session 节点 = sessionId；webhook = w:<uuid>）。 */
  nodeId?: string;
  projectId?: number;
  /** 分组框尺寸（kind = group 时有效）。 */
  width?: number;
  height?: number;
  /** 收起时被藏起的节点数。 */
  hidden?: number;
}

export interface OrchLaidEdge {
  /** 渲染边 id（跨项目合并后一对端点只有一条）。 */
  key: string;
  from: string;
  to: string;
  /** 参与合并的原始边（编辑/动效用）。 */
  edgeIds: string[];
}

export interface OrchCanvasLayout {
  nodes: OrchLaidNode[];
  edges: OrchLaidEdge[];
}

export interface OrchLayoutInput {
  nodes: readonly OrchestrationNode[];
  edges: readonly OrchestrationEdge[];
  sessions: ReadonlyMap<string, OrchCanvasSession>;
  /** 全局视图 = true：按项目分组（可收起）；项目视图 = false：只摆节点。 */
  groupProjects: boolean;
  /** 收起的分组（项目 id；未知项目的节点归 0）。 */
  collapsed: ReadonlySet<number>;
}

/** 节点所属项目（session 查表；webhook 不属于项目，归「未知项目」框）。 */
function projectOf(sessions: ReadonlyMap<string, OrchCanvasSession>, node: OrchestrationNode): number {
  return node.kind === 'webhook' ? 0 : (sessions.get(node.id)?.projectId ?? 0);
}

export function layoutOrchestrationCanvas(input: OrchLayoutInput): OrchCanvasLayout {
  const { nodes, edges, sessions, groupProjects, collapsed } = input;
  const ranks = ranksOf(nodes, edges);

  // 分组：项目 → 节点（保持节点输入序），列序取组内最小层。
  const groups = new Map<number, OrchestrationNode[]>();
  for (const node of nodes) {
    const projectId = projectOf(sessions, node);
    const list = groups.get(projectId) ?? [];
    list.push(node);
    groups.set(projectId, list);
  }
  const groupOrder = [...groups.keys()].sort((a, b) => {
    const minRank = (id: number): number =>
      Math.min(...(groups.get(id) ?? []).map((n) => ranks.get(n.id) ?? 0));
    return minRank(a) - minRank(b) || a - b;
  });

  const laidNodes: OrchLaidNode[] = [];
  /** 分组框单独收：全部排在最前（ReactFlow 后者画在上面，框必须垫底）。 */
  const groupNodes: OrchLaidNode[] = [];
  /** 每一列当前已占到的 y（分组带依次下叠，同列不重叠）。 */
  const columnCursor = new Map<number, number>();
  /** 编排节点 id → 渲染节点 key。 */
  const nodeKeyOf = new Map<string, string>();

  for (const projectId of groupProjects ? groupOrder : [null]) {
    const members = groupProjects
      ? (groups.get(projectId as number) ?? [])
      : [...nodes];
    const isCollapsed = groupProjects && collapsed.has(projectId as number);
    const rankOfMember = (n: OrchestrationNode): number => ranks.get(n.id) ?? 0;
    const minRank = Math.min(...members.map(rankOfMember));
    const maxRank = Math.max(...members.map(rankOfMember));
    const span: number[] = [];
    for (let r = minRank; r <= maxRank; r++) span.push(r);
    const baseY = Math.max(0, ...span.map((r) => columnCursor.get(r) ?? 0));
    const top = groupProjects ? baseY + ORCH_GROUP_HEADER_H + ORCH_GROUP_PAD : baseY;

    // 同一列内的成员按节点序上下排。
    const rowCursor = new Map<number, number>();
    let maxBottom = top;
    for (const member of members) {
      const rank = rankOfMember(member);
      const row = rowCursor.get(rank) ?? 0;
      rowCursor.set(rank, row + 1);
      const x = rank * ORCH_COL_W;
      const y = top + row * ORCH_ROW_H;
      const key = member.kind === 'webhook' ? member.id : `s:${member.id}`;
      if (isCollapsed) {
        nodeKeyOf.set(member.id, `g:${projectId}`);
        continue;
      }
      const node: OrchLaidNode = {
        key,
        kind: member.kind,
        nodeId: member.id,
        projectId: groupProjects ? (projectId as number) : undefined,
        x,
        y,
      };
      laidNodes.push(node);
      nodeKeyOf.set(member.id, key);
      maxBottom = Math.max(maxBottom, y + ORCH_NODE_H);
    }

    if (groupProjects) {
      const left = minRank * ORCH_COL_W - ORCH_GROUP_PAD;
      const width = (maxRank - minRank) * ORCH_COL_W + ORCH_NODE_W + ORCH_GROUP_PAD * 2;
      const height = isCollapsed
        ? ORCH_GROUP_COLLAPSED_H
        : maxBottom - baseY + ORCH_GROUP_PAD;
      groupNodes.push({
        key: `g:${projectId}`,
        kind: 'group',
        projectId: projectId as number,
        x: left,
        y: baseY,
        width,
        height,
        ...(isCollapsed ? { hidden: members.length } : {}),
      });
      const nextY = baseY + height + ORCH_GROUP_PAD * 2;
      for (const r of span) columnCursor.set(r, nextY);
    } else if (members.length > 0) {
      const nextY = maxBottom + ORCH_GROUP_PAD * 2;
      for (const r of span) columnCursor.set(r, nextY);
    }
  }

  // 边：端点映射到渲染节点；跨项目（或收起后同组）的合并成一条。
  const merged = new Map<string, OrchLaidEdge>();
  for (const edge of edges) {
    const from = nodeKeyOf.get(edge.from);
    const to = nodeKeyOf.get(edge.to);
    if (!from || !to || from === to) continue;
    const key = `${from}->${to}`;
    const found = merged.get(key);
    if (found) found.edgeIds.push(edge.id);
    else merged.set(key, { key, from, to, edgeIds: [edge.id] });
  }

  return { nodes: [...groupNodes, ...laidNodes], edges: [...merged.values()] };
}
