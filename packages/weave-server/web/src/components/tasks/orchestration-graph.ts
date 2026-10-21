import type { OrchestrationEdge } from '@/lib/api';

/**
 * 编排图的 web 侧纯函数（可单测）：节点/边编辑 + 与服务端同判据的即时校验。
 * 服务端 `validateOrchestration` 才是权威——这里只是连线时先拒，别等提交才报错。
 */

/** 与服务端同一组上限（`hooks/orchestration-graph.ts`）。 */
export const ORCH_MAX_NODES = 24;
export const ORCH_MAX_EDGES = 64;

export interface OrchDraft {
  name: string;
  startSessionId: string;
  startText: string;
  handoffPrompt: string;
  nodes: string[];
  edges: OrchestrationEdge[];
  cron: string | null;
}

export type ValidateDraftResult = { ok: true } | { ok: false; error: string };

/**
 * 边 id：短序号。会话 id 本身就 36+ 字符，拼两端会把 id 顶到服务端 64 上限之外
 * （真会话画第一根线就保存失败）；id 只当内部键用，运行日志与画布都不展示它。
 */
export function newEdgeId(taken: ReadonlySet<string>): string {
  let n = taken.size + 1;
  let id = `e${n}`;
  while (taken.has(id)) id = `e${++n}`;
  return id;
}

export function addNode(draft: OrchDraft, sessionId: string): OrchDraft {
  if (draft.nodes.includes(sessionId)) return draft;
  return {
    ...draft,
    nodes: [...draft.nodes, sessionId],
    startSessionId: draft.startSessionId || sessionId,
  };
}

/** 去节点连带它的边；起点的继任 = 剩下的第一个节点。 */
export function removeNode(draft: OrchDraft, sessionId: string): OrchDraft {
  const nodes = draft.nodes.filter((id) => id !== sessionId);
  return {
    ...draft,
    nodes,
    edges: draft.edges.filter((e) => e.from !== sessionId && e.to !== sessionId),
    startSessionId: draft.startSessionId === sessionId ? (nodes[0] ?? '') : draft.startSessionId,
  };
}

/** 新画的边默认带「上游输出」：新边多半只写一句指令，没有上游结论就没有信息量。 */
export function addEdge(draft: OrchDraft, from: string, to: string, text: string): OrchDraft {
  const taken = new Set(draft.edges.map((e) => e.id));
  return {
    ...draft,
    edges: [...draft.edges, { id: newEdgeId(taken), from, to, text, carryOutput: true }],
  };
}

export function removeEdge(draft: OrchDraft, edgeId: string): OrchDraft {
  return { ...draft, edges: draft.edges.filter((e) => e.id !== edgeId) };
}

/**
 * 三色 DFS 找环：返回 `a → b → a` 形状的环路径（无环 = null）。
 * 与 server 同判据（同样返回环上路径，文案层面各自渲染）。
 */
export function findCycle(
  nodes: readonly string[],
  edges: readonly OrchestrationEdge[],
): string[] | null {
  const out = new Map<string, string[]>();
  for (const node of nodes) out.set(node, []);
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
      const s = state.get(next) ?? 0;
      if (s === 1) return [...stack.slice(stack.indexOf(next)), next];
      if (s === 0) {
        const found = visit(next);
        if (found) return found;
      }
    }
    stack.pop();
    state.set(node, 2);
    return null;
  };
  for (const node of nodes) {
    if ((state.get(node) ?? 0) !== 0) continue;
    const found = visit(node);
    if (found) return found;
  }
  return null;
}

/** 从起点出发能到的节点集（可达性校验用）。 */
export function reachableFrom(
  nodes: readonly string[],
  edges: readonly OrchestrationEdge[],
  start: string,
): Set<string> {
  const out = new Map<string, string[]>();
  for (const node of nodes) out.set(node, []);
  for (const edge of edges) out.get(edge.from)?.push(edge.to);
  const seen = new Set<string>();
  const stack = [start];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (seen.has(node)) continue;
    seen.add(node);
    for (const next of out.get(node) ?? []) stack.push(next);
  }
  return seen;
}

/** 分层（Kahn 最长路径）：起点层 0，其余 = 所有前驱最大层 + 1（人读成「第几波」）。 */
export function ranksOf(
  nodes: readonly string[],
  edges: readonly OrchestrationEdge[],
  startSessionId: string,
): Map<string, number> {
  const indeg = new Map<string, number>();
  const out = new Map<string, string[]>();
  for (const node of nodes) {
    indeg.set(node, 0);
    out.set(node, []);
  }
  for (const edge of edges) {
    out.get(edge.from)?.push(edge.to);
    indeg.set(edge.to, (indeg.get(edge.to) ?? 0) + 1);
  }
  const rank = new Map<string, number>();
  if (nodes.includes(startSessionId)) rank.set(startSessionId, 0);
  const queue = nodes.filter((n) => (indeg.get(n) ?? 0) === 0);
  for (const node of queue) if (!rank.has(node)) rank.set(node, 0);
  while (queue.length > 0) {
    const node = queue.shift()!;
    const base = rank.get(node) ?? 0;
    for (const next of out.get(node) ?? []) {
      rank.set(next, Math.max(rank.get(next) ?? 0, base + 1));
      const left = (indeg.get(next) ?? 0) - 1;
      indeg.set(next, left);
      if (left === 0) queue.push(next);
    }
  }
  for (const node of nodes) if (!rank.has(node)) rank.set(node, 0);
  return rank;
}

/** 提交前的即时校验（服务端仍是权威，错误文案两边同义）。 */
export function validateDraft(draft: OrchDraft): ValidateDraftResult {
  if (!draft.name.trim()) return { ok: false, error: 'Name is required' };
  if (draft.nodes.length === 0) return { ok: false, error: 'At least one node is required' };
  if (draft.nodes.length > ORCH_MAX_NODES) {
    return { ok: false, error: `At most ${ORCH_MAX_NODES} nodes per orchestration` };
  }
  if (!draft.startSessionId || !draft.nodes.includes(draft.startSessionId)) {
    return { ok: false, error: 'Start session must be part of the node set' };
  }
  if (draft.edges.length > ORCH_MAX_EDGES) {
    return { ok: false, error: `At most ${ORCH_MAX_EDGES} edges per orchestration` };
  }
  const pairs = new Set<string>();
  for (const edge of draft.edges) {
    if (!draft.nodes.includes(edge.from) || !draft.nodes.includes(edge.to)) {
      return { ok: false, error: `Edge ${edge.id} references a node outside the node set` };
    }
    if (edge.from === edge.to) return { ok: false, error: `Self-loop on ${edge.from}` };
    const pair = `${edge.from}->${edge.to}`;
    if (pairs.has(pair)) return { ok: false, error: `Duplicate edge ${edge.from} → ${edge.to}` };
    pairs.add(pair);
  }
  const mute = draft.edges.find((edge) => !edge.text.trim() && edge.carryOutput !== true);
  if (mute) return { ok: false, error: `Edge ${mute.from} → ${mute.to} has no message` };
  const cycle = findCycle(draft.nodes, draft.edges);
  if (cycle) return { ok: false, error: `Cycle detected: ${cycle.join(' → ')}` };
  const reachable = reachableFrom(draft.nodes, draft.edges, draft.startSessionId);
  const orphan = draft.nodes.find((node) => !reachable.has(node));
  if (orphan) return { ok: false, error: `Node ${orphan} is unreachable from the start session` };
  return { ok: true };
}
