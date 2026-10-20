import type { OrchestrationEdge } from '../repositories/orchestrations.js';

/** 每份编排的规模上限（布局与画布可读性）。 */
export const ORCH_MAX_NODES = 24;
export const ORCH_MAX_EDGES = 64;
/** 每 run 的投递上限：环路兜底（成环已被静态拒，这是运行时最后一道闸）。 */
export const ORCH_MAX_DELIVERIES = 200;

export interface OrchestrationGraph {
  startSessionId: string;
  nodes: readonly string[];
  edges: readonly OrchestrationEdge[];
}

export type ValidateResult = { ok: true } | { ok: false; error: string };

/**
 * 编排图校验（POST/PUT 唯一权威）：规模、节点一致、自环/重边、可达性、成环。
 * web 另有同判据的即时镜像（连线时先拒），最终仍以这里为准。
 */
export function validateOrchestration(graph: OrchestrationGraph): ValidateResult {
  const { startSessionId, nodes, edges } = graph;
  if (nodes.length === 0) return { ok: false, error: 'At least one node is required' };
  if (nodes.length > ORCH_MAX_NODES) {
    return { ok: false, error: `At most ${ORCH_MAX_NODES} nodes per orchestration` };
  }
  const set = new Set<string>();
  for (const node of nodes) {
    if (set.has(node)) return { ok: false, error: `Duplicate node ${node}` };
    set.add(node);
  }
  if (!set.has(startSessionId)) {
    return { ok: false, error: 'Start session must be part of the node set' };
  }
  if (edges.length > ORCH_MAX_EDGES) {
    return { ok: false, error: `At most ${ORCH_MAX_EDGES} edges per orchestration` };
  }
  const ids = new Set<string>();
  const pairs = new Set<string>();
  for (const edge of edges) {
    if (ids.has(edge.id)) return { ok: false, error: `Duplicate edge id ${edge.id}` };
    ids.add(edge.id);
    if (!set.has(edge.from) || !set.has(edge.to)) {
      return { ok: false, error: `Edge ${edge.id} references a node outside the node set` };
    }
    if (edge.from === edge.to) return { ok: false, error: `Self-loop on ${edge.from}` };
    const pair = `${edge.from}->${edge.to}`;
    if (pairs.has(pair)) return { ok: false, error: `Duplicate edge ${edge.from}→${edge.to}` };
    pairs.add(pair);
  }
  const mute = edges.find((edge) => !edge.text.trim() && edge.carryOutput !== true);
  if (mute) return { ok: false, error: `Edge ${mute.from}→${mute.to} has no message` };
  const cycle = findCycle(nodes, edges);
  if (cycle) return { ok: false, error: `Cycle detected: ${cycle.join(' → ')}` };
  const unreachable = nodes.filter((node) => !reachableFrom(startSessionId, edges).has(node));
  if (unreachable.length > 0) {
    return { ok: false, error: `Node ${unreachable[0]} is unreachable from the start session` };
  }
  return { ok: true };
}

/** 三色 DFS：返回环路（首尾同一节点），无环 → null。 */
export function findCycle(
  nodes: readonly string[],
  edges: readonly Pick<OrchestrationEdge, 'from' | 'to'>[],
): string[] | null {
  const out = new Map<string, string[]>();
  for (const node of nodes) out.set(node, []);
  for (const edge of edges) out.get(edge.from)?.push(edge.to);
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
    if ((state.get(node) ?? 0) === 0) {
      const found = visit(node);
      if (found) return found;
    }
  }
  return null;
}

export function reachableFrom(
  start: string,
  edges: readonly Pick<OrchestrationEdge, 'from' | 'to'>[],
): Set<string> {
  const out = new Map<string, string[]>();
  for (const edge of edges) {
    const list = out.get(edge.from);
    if (list) list.push(edge.to);
    else out.set(edge.from, [edge.to]);
  }
  const seen = new Set<string>([start]);
  const queue = [start];
  while (queue.length > 0) {
    for (const next of out.get(queue.pop()!) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen;
}

/** 最长路分层（画布列位）：无前驱 = 0；有环时环上节点恒 0（校验先行，正常到不了）。 */
export function ranksOf(
  nodes: readonly string[],
  edges: readonly Pick<OrchestrationEdge, 'from' | 'to'>[],
): Map<string, number> {
  const indegree = new Map<string, number>(nodes.map((node) => [node, 0]));
  const out = new Map<string, string[]>(nodes.map((node) => [node, []]));
  for (const edge of edges) {
    out.get(edge.from)?.push(edge.to);
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  }
  const ranks = new Map<string, number>(nodes.map((node) => [node, 0]));
  const queue = nodes.filter((node) => (indegree.get(node) ?? 0) === 0);
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
