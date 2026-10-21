import type { OrchestrationEdge, OrchestrationNode } from '../repositories/orchestrations.js';
import { graphDirections } from '../repositories/orchestrations.js';

/** 每份编排的规模上限（布局与画布可读性）。 */
export const ORCH_MAX_NODES = 24;
export const ORCH_MAX_EDGES = 64;
/** 每 run 的投递上限：环路兜底（成环已被静态拒，这是运行时最后一道闸）。 */
export const ORCH_MAX_DELIVERIES = 200;

export interface OrchestrationGraph {
  nodes: readonly OrchestrationNode[];
  edges: readonly OrchestrationEdge[];
}

export type ValidateResult = { ok: true } | { ok: false; error: string };

/**
 * 编排图校验（POST/PUT 唯一权威）：规模、节点一致、自环/重边、成环、方向形状、
 * 多入口可达。web 另有同判据的即时镜像（连线时先拒），最终仍以这里为准。
 */
export function validateOrchestration(graph: OrchestrationGraph): ValidateResult {
  const { nodes, edges } = graph;
  if (nodes.length === 0) return { ok: false, error: 'At least one node is required' };
  if (nodes.length > ORCH_MAX_NODES) {
    return { ok: false, error: `At most ${ORCH_MAX_NODES} nodes per orchestration` };
  }
  const ids = new Set<string>();
  for (const node of nodes) {
    if (ids.has(node.id)) return { ok: false, error: `Duplicate node ${node.id}` };
    ids.add(node.id);
    if (node.kind === 'webhook' && !node.id.startsWith('w:')) {
      return { ok: false, error: `Webhook node id must start with "w:": ${node.id}` };
    }
  }
  if (edges.length > ORCH_MAX_EDGES) {
    return { ok: false, error: `At most ${ORCH_MAX_EDGES} edges per orchestration` };
  }
  const edgeIds = new Set<string>();
  const pairs = new Set<string>();
  for (const edge of edges) {
    if (edgeIds.has(edge.id)) return { ok: false, error: `Duplicate edge id ${edge.id}` };
    edgeIds.add(edge.id);
    if (!ids.has(edge.from) || !ids.has(edge.to)) {
      return { ok: false, error: `Edge ${edge.id} references a node outside the node set` };
    }
    if (edge.from === edge.to) return { ok: false, error: `Self-loop on ${edge.from}` };
    const pair = `${edge.from}->${edge.to}`;
    if (pairs.has(pair)) return { ok: false, error: `Duplicate edge ${edge.from}→${edge.to}` };
    pairs.add(pair);
  }
  const { entries } = graphDirections(nodes, edges);
  const hasIn = new Set(edges.map((e) => e.to));
  const hasOut = new Set(edges.map((e) => e.from));
  const webhookEntryIds = new Set(entries.filter((n) => n.kind === 'webhook').map((n) => n.id));
  // 空正文只在两处合法：webhook 入口的出边（载荷就是正文）、设了提取指令的边
  // （`{summary}` 填充）。
  const mute = edges.find(
    (edge) => !edge.text.trim() && !webhookEntryIds.has(edge.from) && !edge.extract?.trim(),
  );
  if (mute) return { ok: false, error: `Edge ${mute.from}→${mute.to} has no message` };
  for (const node of nodes) {
    if (node.kind !== 'webhook') continue;
    // webhook 节点只能站在图的两端：入口（只出）或出口（只入），不当中间节点。
    if (hasIn.has(node.id) && hasOut.has(node.id)) {
      return { ok: false, error: `Webhook node ${node.id} cannot have both inbound and outbound edges` };
    }
    if (!hasIn.has(node.id) && !hasOut.has(node.id)) {
      return { ok: false, error: `Webhook node ${node.id} is not connected` };
    }
  }
  for (const node of nodes) {
    if (node.kind !== 'webhook' || !hasIn.has(node.id)) continue;
    // 出口 webhook 必须给出合法的出站 URL（入口的 token 由仓储补发，不在这验）。
    const url = node.url ?? '';
    let parsed: URL | null = null;
    try {
      parsed = new URL(url);
    } catch {
      parsed = null;
    }
    if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
      return { ok: false, error: `Webhook node ${node.id} needs a valid http(s) URL` };
    }
  }
  const cycle = findCycle(nodes, edges);
  if (cycle) return { ok: false, error: `Cycle detected: ${cycle.join(' → ')}` };
  // 可达性不再单查：入口 = 全部无入边节点，DAG 里每个节点的入边链必然落回某个
  // 入口（成环已被拒），多源可达恒真。
  return { ok: true };
}

/** 三色 DFS：返回环路（首尾同一节点），无环 → null。 */
export function findCycle(
  nodes: readonly Pick<OrchestrationNode, 'id'>[],
  edges: readonly Pick<OrchestrationEdge, 'from' | 'to'>[],
): string[] | null {
  const out = new Map<string, string[]>();
  for (const node of nodes) out.set(node.id, []);
  for (const edge of edges) {
    const list = out.get(edge.from);
    if (list) list.push(edge.to);
  }
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];

  const visit = (node: string): string[] | null => {
    state.set(node, 1);
    stack.push(node);
    for (const next of out.get(node) ?? []) {
      const seen = state.get(next) ?? 0;
      if (seen === 1) return [...stack.slice(stack.indexOf(next)), next];
      if (seen === 0) {
        const found = visit(next);
        if (found) return found;
      }
    }
    stack.pop();
    state.set(node, 2);
    return null;
  };

  for (const node of nodes) {
    if ((state.get(node.id) ?? 0) === 0) {
      const found = visit(node.id);
      if (found) return found;
    }
  }
  return null;
}

/** 最长路分层（画布列位，多源）：无前驱 = 0；有环时环上节点恒 0（校验先行，正常到不了）。 */
export function ranksOf(
  nodes: readonly Pick<OrchestrationNode, 'id'>[],
  edges: readonly Pick<OrchestrationEdge, 'from' | 'to'>[],
): Map<string, number> {
  const indegree = new Map<string, number>(nodes.map((node) => [node.id, 0]));
  const out = new Map<string, string[]>(nodes.map((node) => [node.id, []]));
  for (const edge of edges) {
    out.get(edge.from)?.push(edge.to);
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  }
  const ranks = new Map<string, number>(nodes.map((node) => [node.id, 0]));
  const queue = nodes.filter((node) => (indegree.get(node.id) ?? 0) === 0).map((node) => node.id);
  for (let i = 0; i < queue.length; i++) {
    const node = queue[i]!;
    for (const next of out.get(node) ?? []) {
      ranks.set(next, Math.max(ranks.get(next) ?? 0, (ranks.get(node) ?? 0) + 1));
      const left = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, left);
      if (left === 0) queue.push(next);
    }
  }
  return ranks;
}
