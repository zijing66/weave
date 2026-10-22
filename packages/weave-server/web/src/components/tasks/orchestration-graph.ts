import type { OrchestrationEdge, OrchestrationNode } from '@/lib/api';

/**
 * 编排图的 web 侧纯函数（可单测）：节点/边编辑 + 与服务端同判据的即时校验。
 * 服务端 `validateOrchestration` 才是权威——这里只是连线时先拒，别等提交才报错。
 */

/** 与服务端同一组上限（`hooks/orchestration-graph.ts`）。 */
export const ORCH_MAX_NODES = 24;
export const ORCH_MAX_EDGES = 64;

export interface OrchDraft {
  name: string;
  startText: string;
  nodes: OrchestrationNode[];
  edges: OrchestrationEdge[];
  cron: string | null;
}

export type ValidateDraftResult = { ok: true } | { ok: false; error: string };

/** 边 id：短序号（会话 id 本身就 36+ 字符，拼两端会顶到服务端 64 上限之外）。 */
export function newEdgeId(taken: ReadonlySet<string>): string {
  let n = taken.size + 1;
  let id = `e${n}`;
  while (taken.has(id)) id = `e${++n}`;
  return id;
}

/** webhook 节点 id：`w:<uuid>`，与任何 sessionId 不碰撞。 */
export function newWebhookNodeId(taken: ReadonlySet<string>): string {
  let id = `w:${crypto.randomUUID()}`;
  while (taken.has(id)) id = `w:${crypto.randomUUID()}`;
  return id;
}

/** 入口 = 无入边节点；出口 = 无出边节点（与服务端 `graphDirections` 同一份图语义）。 */
export function graphDirections(
  nodes: readonly OrchestrationNode[],
  edges: readonly OrchestrationEdge[],
): { entries: OrchestrationNode[]; exits: OrchestrationNode[] } {
  const hasIn = new Set(edges.map((e) => e.to));
  const hasOut = new Set(edges.map((e) => e.from));
  return {
    entries: nodes.filter((n) => !hasIn.has(n.id)),
    exits: nodes.filter((n) => !hasOut.has(n.id)),
  };
}

export function addSessionNode(draft: OrchDraft, sessionId: string): OrchDraft {
  if (draft.nodes.some((n) => n.id === sessionId)) return draft;
  return { ...draft, nodes: [...draft.nodes, { id: sessionId, kind: 'session' }] };
}

export function addWebhookNode(draft: OrchDraft): OrchDraft {
  return {
    ...draft,
    nodes: [...draft.nodes, { id: newWebhookNodeId(new Set(draft.nodes.map((n) => n.id))), kind: 'webhook' }],
  };
}

/** 去节点连带它的边。 */
export function removeNode(draft: OrchDraft, nodeId: string): OrchDraft {
  return {
    ...draft,
    nodes: draft.nodes.filter((n) => n.id !== nodeId),
    edges: draft.edges.filter((e) => e.from !== nodeId && e.to !== nodeId),
  };
}

/** 新画的边默认只写一句指令；要带上游输出就在正文里引用 `{upstream}`。 */
export function addEdge(draft: OrchDraft, from: string, to: string, text: string): OrchDraft {
  const taken = new Set(draft.edges.map((e) => e.id));
  return {
    ...draft,
    edges: [...draft.edges, { id: newEdgeId(taken), from, to, text }],
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
  nodes: readonly OrchestrationNode[],
  edges: readonly OrchestrationEdge[],
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
    if ((state.get(node.id) ?? 0) !== 0) continue;
    const found = visit(node.id);
    if (found) return found;
  }
  return null;
}

/** 分层（Kahn 最长路径，多源）：无前驱 = 0，其余 = 所有前驱最大层 + 1（人读成「第几波」）。 */
export function ranksOf(
  nodes: readonly OrchestrationNode[],
  edges: readonly OrchestrationEdge[],
): Map<string, number> {
  const indeg = new Map<string, number>();
  const out = new Map<string, string[]>();
  for (const node of nodes) {
    indeg.set(node.id, 0);
    out.set(node.id, []);
  }
  for (const edge of edges) {
    out.get(edge.from)?.push(edge.to);
    indeg.set(edge.to, (indeg.get(edge.to) ?? 0) + 1);
  }
  const rank = new Map<string, number>();
  const queue = nodes.filter((n) => (indeg.get(n.id) ?? 0) === 0).map((n) => n.id);
  for (const node of queue) rank.set(node, 0);
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
  for (const node of nodes) if (!rank.has(node.id)) rank.set(node.id, 0);
  return rank;
}

/** 总览合并图的边：多份编排的同端点边并成一条，参与对全部记在 pairs 里。 */
export interface MergedOrchEdge {
  from: string;
  to: string;
  pairs: { orchId: number; edgeId: string; text: string }[];
}

/**
 * 总览合并（纯函数，可单测）：多份编排并成一张图——节点按 id 去重（同一会话
 * 在多份编排里就是同一个节点，跨编排 n:n 扇入扇出），边按端点对合并。跨编排
 * 的成环这里不拒（单份编排各自无环，环只能来自组合），布局层 ranksOf 兜底
 * （环上节点落第 0 列）。
 */
export function mergeOrchestrations(
  blocks: readonly {
    orchId: number;
    nodes: readonly OrchestrationNode[];
    edges: readonly OrchestrationEdge[];
  }[],
): { nodes: OrchestrationNode[]; edges: MergedOrchEdge[]; orchIdsOf: Map<string, number[]> } {
  const nodeById = new Map<string, OrchestrationNode>();
  const orchIdsOf = new Map<string, number[]>();
  for (const block of blocks) {
    for (const node of block.nodes) {
      if (!nodeById.has(node.id)) nodeById.set(node.id, node);
      const ids = orchIdsOf.get(node.id) ?? [];
      if (!ids.includes(block.orchId)) ids.push(block.orchId);
      orchIdsOf.set(node.id, ids);
    }
  }
  const edgeByPair = new Map<string, MergedOrchEdge>();
  for (const block of blocks) {
    for (const edge of block.edges) {
      if (!nodeById.has(edge.from) || !nodeById.has(edge.to)) continue;
      const key = `${edge.from}->${edge.to}`;
      const found = edgeByPair.get(key);
      const pair = { orchId: block.orchId, edgeId: edge.id, text: edge.text };
      if (found) found.pairs.push(pair);
      else edgeByPair.set(key, { from: edge.from, to: edge.to, pairs: [pair] });
    }
  }
  return { nodes: [...nodeById.values()], edges: [...edgeByPair.values()], orchIdsOf };
}

/**
 * 单条边的问题清单（画布上逐条描红/虚线用）：端点不存在、空正文（webhook
 * 入口出边与带提取的边除外）、落在环上的边。整图能不能存仍以 `validateDraft`
 * 为准（它只报第一处，这里报全部）。
 */
export function invalidEdgeIds(draft: OrchDraft): Set<string> {
  const nodeIds = new Set(draft.nodes.map((n) => n.id));
  const { entries } = graphDirections(draft.nodes, draft.edges);
  const webhookEntryIds = new Set(
    entries.filter((n) => n.kind === 'webhook').map((n) => n.id),
  );
  const bad = new Set<string>();
  for (const edge of draft.edges) {
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
      bad.add(edge.id);
      continue;
    }
    if (!edge.text.trim() && !webhookEntryIds.has(edge.from) && !edge.extract?.trim()) {
      bad.add(edge.id);
    }
  }
  const cycle = findCycle(draft.nodes, draft.edges);
  if (cycle) {
    for (let i = 0; i < cycle.length - 1; i++) {
      const edge = draft.edges.find((e) => e.from === cycle[i] && e.to === cycle[i + 1]);
      if (edge) bad.add(edge.id);
    }
  }
  return bad;
}

/** 提交前的即时校验（服务端仍是权威，错误文案两边同义）。 */
export function validateDraft(draft: OrchDraft): ValidateDraftResult {
  if (!draft.name.trim()) return { ok: false, error: 'Name is required' };
  if (draft.nodes.length === 0) return { ok: false, error: 'At least one node is required' };
  if (draft.nodes.length > ORCH_MAX_NODES) {
    return { ok: false, error: `At most ${ORCH_MAX_NODES} nodes per orchestration` };
  }
  if (draft.edges.length > ORCH_MAX_EDGES) {
    return { ok: false, error: `At most ${ORCH_MAX_EDGES} edges per orchestration` };
  }
  const ids = new Set<string>();
  for (const node of draft.nodes) {
    if (ids.has(node.id)) return { ok: false, error: `Duplicate node ${node.id}` };
    ids.add(node.id);
    if (node.kind === 'webhook' && !node.id.startsWith('w:')) {
      return { ok: false, error: `Webhook node id must start with "w:": ${node.id}` };
    }
  }
  const pairs = new Set<string>();
  for (const edge of draft.edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to)) {
      return { ok: false, error: `Edge ${edge.id} references a node outside the node set` };
    }
    if (edge.from === edge.to) return { ok: false, error: `Self-loop on ${edge.from}` };
    const pair = `${edge.from}->${edge.to}`;
    if (pairs.has(pair)) return { ok: false, error: `Duplicate edge ${edge.from} → ${edge.to}` };
    pairs.add(pair);
  }
  const { entries } = graphDirections(draft.nodes, draft.edges);
  const hasIn = new Set(draft.edges.map((e) => e.to));
  const hasOut = new Set(draft.edges.map((e) => e.from));
  const webhookEntryIds = new Set(entries.filter((n) => n.kind === 'webhook').map((n) => n.id));
  // 空正文只在两处合法：webhook 入口的出边（载荷就是正文）、设了提取指令的边。
  const mute = draft.edges.find(
    (edge) => !edge.text.trim() && !webhookEntryIds.has(edge.from) && !edge.extract?.trim(),
  );
  if (mute) return { ok: false, error: `Edge ${mute.from} → ${mute.to} has no message` };
  for (const node of draft.nodes) {
    if (node.kind !== 'webhook') continue;
    // webhook 节点只能站在图的两端：入口（只出）或出口（只入），不当中间节点。
    if (hasIn.has(node.id) && hasOut.has(node.id)) {
      return {
        ok: false,
        error: 'Webhook nodes cannot have both inbound and outbound edges',
      };
    }
    if (!hasIn.has(node.id) && !hasOut.has(node.id)) {
      return { ok: false, error: 'A webhook node is not connected' };
    }
  }
  for (const node of draft.nodes) {
    if (node.kind !== 'webhook' || !hasIn.has(node.id)) continue;
    // 出口 webhook 必须给出合法的出站 URL（入口的 token 由服务端补发，不在这验）。
    let parsed: URL | null = null;
    try {
      parsed = new URL(node.url ?? '');
    } catch {
      parsed = null;
    }
    if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
      return { ok: false, error: 'Webhook exit nodes need a valid http(s) URL' };
    }
  }
  const cycle = findCycle(draft.nodes, draft.edges);
  if (cycle) return { ok: false, error: `Cycle detected: ${cycle.join(' → ')}` };
  // 可达性不再单查：入口 = 全部无入边节点，DAG 里每个节点的入边链必然落回某个
  // 入口（成环已被拒），多源可达恒真。
  return { ok: true };
}
