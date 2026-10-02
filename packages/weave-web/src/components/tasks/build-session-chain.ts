import type { Edge, Node } from '@xyflow/react';
import type { HookDispatch, HookEventRow, HookRule } from '@/lib/api';
import { parseDetail, type EventDetail } from '@/lib/hook-payload';

/**
 * 会话事件链构图（纯函数，可单测）：
 * 事件(列0) → 命中规则(列1，同规则合并计数) → 处理器(列2，按 type 去重)
 * → 派发结果(列3)。未命中任何规则的事件保留孤立节点（真实发生的采集事件）。
 * 已知缺口：log 处理器命中不落 dispatch，历史链缺该类边（图例说明，不做 schema 变更）。
 */

export const COL_X = { event: 0, rule: 340, handler: 680, dispatch: 1020 } as const;
export const ROW_Y = 120;
/** 同行多规则的纵向错开（节点高约 50px）。 */
export const RULE_OFFSET_Y = 56;
/** 事件节点上限（大会话截断，truncated=true 供 UI 提示）。 */
export const MAX_EVENT_NODES = 400;

/** 节点数据（宽形状 + kind 判别；type alias 而非 interface 以满足
 * react-flow 的 Record<string, unknown> 约束，各 kind 按需取字段）。 */
export type ChainNodeData = {
  kind: 'event' | 'rule' | 'handler' | 'dispatch';
  event?: HookEventRow;
  detail?: EventDetail;
  rule?: HookRule;
  /** 规则命中次数（kind=rule）。 */
  hits?: number;
  handlerType?: string;
  /** 经此处理器的规则数（kind=handler）。 */
  ruleCount?: number;
  dispatch?: HookDispatch;
  ruleName?: string | null;
};
export type ChainNode = Node<ChainNodeData, 'event' | 'rule' | 'handler' | 'dispatch'>;
/** 边携带定位信息（SSE 动效按 id/数据命中）。 */
export type ChainEdgeData = { ruleId?: string; eventId?: number; dispatchId?: number };
export type ChainEdge = Edge<ChainEdgeData>;

export interface ChainGraph {
  nodes: ChainNode[];
  edges: ChainEdge[];
  /** 事件数超过 MAX_EVENT_NODES 被截断。 */
  truncated: boolean;
}

export function buildSessionChain(input: {
  /** 时间升序（服务端 listBySession）。 */
  events: HookEventRow[];
  /** 该会话的派发（含 log 不落库的缺口）。 */
  dispatches: HookDispatch[];
  /** 全局 + 本项目规则（解析 handler.type / 规则名）。 */
  rules: HookRule[];
}): ChainGraph {
  const { events, dispatches, rules } = input;
  const truncated = events.length > MAX_EVENT_NODES;
  const shown = truncated ? events.slice(0, MAX_EVENT_NODES) : events;
  const ruleById = new Map(rules.map((r) => [r.id, r]));

  const nodes: ChainNode[] = [];
  const edges: ChainEdge[] = [];
  const seenEdgePairs = new Set<string>();

  // ---- 1. 事件节点（列 0，按时间行排布） ----
  const eventRow = new Map<number, number>();
  shown.forEach((event, i) => {
    eventRow.set(event.id, i);
    nodes.push({
      id: `ev:${event.id}`,
      type: 'event',
      position: { x: COL_X.event, y: i * ROW_Y },
      data: { kind: 'event', event, detail: parseDetail(event.payload) },
    });
  });

  // ---- 2. 派发按事件分组（dispatch.eventId 归属） ----
  const dispatchByEvent = new Map<number, HookDispatch[]>();
  const orphanDispatches: HookDispatch[] = [];
  for (const d of dispatches) {
    if (d.eventId != null && eventRow.has(d.eventId)) {
      const list = dispatchByEvent.get(d.eventId) ?? [];
      list.push(d);
      dispatchByEvent.set(d.eventId, list);
    } else if (d.eventId == null) {
      orphanDispatches.push(d); // 手工 resume 派发等，挂行末
    }
  }

  // ---- 3. 规则节点（按 ruleId 合并；y = 首次命中事件行，同行多规则错开） ----
  const hitsByRule = new Map<string, { firstRow: number; count: number }>();
  for (const [eventId, list] of dispatchByEvent) {
    const row = eventRow.get(eventId)!;
    for (const d of list) {
      const agg = hitsByRule.get(d.ruleId);
      if (agg) {
        agg.count++;
        agg.firstRow = Math.min(agg.firstRow, row);
      } else {
        hitsByRule.set(d.ruleId, { firstRow: row, count: 1 });
      }
    }
  }

  const ruleNodeY = new Map<string, number>();
  // 同一事件行命中的多条规则在行内错开（按 ruleId 排序保证确定性）
  const rulesByRow = new Map<number, string[]>();
  for (const [ruleId, agg] of hitsByRule) {
    const list = rulesByRow.get(agg.firstRow) ?? [];
    list.push(ruleId);
    rulesByRow.set(agg.firstRow, list);
  }
  for (const [row, ruleIds] of rulesByRow) {
    ruleIds.sort();
    ruleIds.forEach((ruleId, j) => {
      const rule = ruleById.get(ruleId);
      if (!rule) return; // 规则已删：节点跳过，dispatch 节点仍画（ruleName=null）
      const offset = (j - (ruleIds.length - 1) / 2) * RULE_OFFSET_Y;
      const y = row * ROW_Y + offset;
      ruleNodeY.set(ruleId, y);
      const agg = hitsByRule.get(ruleId)!;
      nodes.push({
        id: `rule:${ruleId}`,
        type: 'rule',
        position: { x: COL_X.rule, y },
        data: { kind: 'rule', rule, hits: agg.count },
      });
    });
  }

  // ---- 4. 边 事件 → 规则（同对去重） ----
  for (const [eventId, list] of dispatchByEvent) {
    for (const d of list) {
      const key = `${eventId}->${d.ruleId}`;
      if (seenEdgePairs.has(key)) continue;
      if (!ruleNodeY.has(d.ruleId)) continue; // 规则已删无节点
      seenEdgePairs.add(key);
      edges.push({
        id: `e:ev${eventId}->rule:${d.ruleId}`,
        source: `ev:${eventId}`,
        target: `rule:${d.ruleId}`,
        data: { ruleId: d.ruleId, eventId },
      });
    }
  }

  // ---- 5. 处理器节点（被引用的 handler.type 去重，y = min 引用规则 y） ----
  const handlerRows = new Map<string, { y: number; rules: Set<string> }>();
  for (const [ruleId, y] of ruleNodeY) {
    const rule = ruleById.get(ruleId);
    if (!rule) continue;
    const agg = handlerRows.get(rule.handler.type);
    if (agg) {
      agg.y = Math.min(agg.y, y);
      agg.rules.add(ruleId);
    } else {
      handlerRows.set(rule.handler.type, { y, rules: new Set([ruleId]) });
    }
  }
  for (const [handlerType, { y, rules: ruleIds }] of handlerRows) {
    nodes.push({
      id: `h:${handlerType}`,
      type: 'handler',
      position: { x: COL_X.handler, y },
      data: { kind: 'handler', handlerType, ruleCount: ruleIds.size },
    });
    for (const ruleId of ruleIds) {
      edges.push({
        id: `e:rule:${ruleId}->h:${handlerType}`,
        source: `rule:${ruleId}`,
        target: `h:${handlerType}`,
        data: { ruleId },
      });
    }
  }

  // ---- 6. 派发结果节点（y = 对应事件行；孤儿挂行末） ----
  let orphanRow = shown.length;
  const pushDispatch = (d: HookDispatch, y: number): void => {
    const rule = ruleById.get(d.ruleId);
    nodes.push({
      id: `d:${d.id}`,
      type: 'dispatch',
      position: { x: COL_X.dispatch, y },
      data: { kind: 'dispatch', dispatch: d, ruleName: rule?.name ?? null },
    });
    if (rule && ruleNodeY.has(rule.id)) {
      edges.push({
        id: `e:h:${rule.handler.type}->d:${d.id}`,
        source: `h:${rule.handler.type}`,
        target: `d:${d.id}`,
        data: { ruleId: rule.id, dispatchId: d.id },
      });
    }
  };

  for (const [eventId, list] of dispatchByEvent) {
    const row = eventRow.get(eventId)!;
    list
      .slice()
      .sort((a, b) => a.id - b.id)
      .forEach((d, j) => pushDispatch(d, row * ROW_Y + j * (RULE_OFFSET_Y / 2)));
  }
  for (const d of orphanDispatches) pushDispatch(d, orphanRow++ * ROW_Y);

  return { nodes, edges, truncated };
}
