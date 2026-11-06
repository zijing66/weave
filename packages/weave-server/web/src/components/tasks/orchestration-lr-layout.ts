import type { OrchestrationNode } from '@/lib/api';
import { ORCH_COL_W, ORCH_ROW_H } from './orchestration-canvas-layout';

/**
 * 编排总览 LR 布局（纯函数，可单测）：拓扑分层从左往右——x = 拓扑层（第几波），
 * y = 层内排位。层内序做一次 barycenter：按前驱已定的 y 求均值再排，减少连线
 * 交叉；无已落位前驱的节点保持输入序。环兜底：Kahn 走不完的节点（环只可能
 * 来自跨编排组合，单份编排各自无环）统一落第 0 列，迭代由出队计数兜住不挂死。
 * 编排图规模小（≤24 节点），零依赖够用，不引 dagre/elkjs。
 */

export interface OrchLRPlacement {
  x: number;
  y: number;
  /** 拓扑层号（第几波，入口 = 0）。 */
  rank: number;
}

export interface OrchLRLayout {
  /** 编排节点 id → 落点（图里每个节点都有）。 */
  positions: Map<string, OrchLRPlacement>;
  /** 最大层号（空图 = -1）。 */
  maxRank: number;
}

export function layoutOrchestrationLR(
  nodes: readonly OrchestrationNode[],
  edges: readonly { from: string; to: string }[],
): OrchLRLayout {
  const ids = nodes.map((n) => n.id);
  const idSet = new Set(ids);
  const out = new Map<string, string[]>();
  const preds = new Map<string, string[]>();
  const indeg = new Map<string, number>();
  for (const id of ids) {
    out.set(id, []);
    preds.set(id, []);
    indeg.set(id, 0);
  }
  for (const edge of edges) {
    if (!idSet.has(edge.from) || !idSet.has(edge.to) || edge.from === edge.to) continue;
    out.get(edge.from)!.push(edge.to);
    preds.get(edge.to)!.push(edge.from);
    indeg.set(edge.to, (indeg.get(edge.to) ?? 0) + 1);
  }

  // Kahn 最长路径分层；成环时余下节点进不了队列，统一落第 0 列。
  const rank = new Map<string, number>();
  const queue = ids.filter((id) => (indeg.get(id) ?? 0) === 0);
  for (const id of queue) rank.set(id, 0);
  let head = 0;
  let processed = 0;
  while (head < queue.length) {
    const id = queue[head++]!;
    processed++;
    const base = rank.get(id) ?? 0;
    for (const next of out.get(id) ?? []) {
      rank.set(next, Math.max(rank.get(next) ?? 0, base + 1));
      const left = (indeg.get(next) ?? 0) - 1;
      indeg.set(next, left);
      if (left === 0) queue.push(next);
    }
  }
  if (processed < ids.length) {
    for (const id of ids) if (!rank.has(id)) rank.set(id, 0);
  }

  const byRank = new Map<number, string[]>();
  for (const id of ids) {
    const r = rank.get(id) ?? 0;
    const list = byRank.get(r);
    if (list) list.push(id);
    else byRank.set(r, [id]);
  }

  const yOf = new Map<string, number>();
  const barycenter = (id: string): number => {
    const placed = (preds.get(id) ?? []).filter((p) => yOf.has(p));
    if (placed.length === 0) return Number.MAX_SAFE_INTEGER;
    return placed.reduce((sum, p) => sum + (yOf.get(p) ?? 0), 0) / placed.length;
  };
  const ranks = [...byRank.keys()].sort((a, b) => a - b);
  for (const r of ranks) {
    const members = byRank.get(r)!;
    const ordered = [...members].sort((a, b) => barycenter(a) - barycenter(b));
    ordered.forEach((id, i) => yOf.set(id, i * ORCH_ROW_H));
  }

  const positions = new Map<string, OrchLRPlacement>();
  let maxRank = -1;
  for (const id of ids) {
    const r = rank.get(id) ?? 0;
    maxRank = Math.max(maxRank, r);
    positions.set(id, { x: r * ORCH_COL_W, y: yOf.get(id) ?? 0, rank: r });
  }
  return { positions, maxRank };
}
