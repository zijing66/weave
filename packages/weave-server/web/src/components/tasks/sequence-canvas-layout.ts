import type { Harness } from '@weavecode/core/harness';
import type { SessionMessageRow, SessionRow } from '@/lib/api';
import { HARNESS_ORDER } from '@/lib/harness-meta';

/**
 * 编排画布布局（纯函数，可单测）：会话按 harness 泳道分列（名表序，未知
 * harness 归末列），泳道内按输入序（状态总线列表 = 新在前）纵向排布；消息
 * 为边——只有两端会话都在画布上的会话间消息才成边（dashboard/cli 投递无
 * 源节点，由节点的「收」计数承载）。
 */

/** 渲染节点宽（对齐 SequenceCanvas 节点的 w-[260px]）。 */
export const SEQ_NODE_W = 260;
/** 节点估高（视口适配用，非布局值）。 */
export const SEQ_NODE_H = 52;
/** 泳道内行距。 */
export const SEQ_ROW_H = 92;
/** 泳道列距（列间空隙 = SEQ_LANE_W - SEQ_NODE_W）。 */
export const SEQ_LANE_W = 380;
/** 泳道标签块占的高（首行节点上方留白）。 */
export const SEQ_LANE_HEADER_H = 56;

export interface LaidSessionNode {
  /** `s:<sessionId>`（ReactFlow 节点 id）。 */
  key: string;
  session: SessionRow;
  lane: number;
  row: number;
  x: number;
  y: number;
}

export interface LaidMessageEdge {
  /** `m:<messageId>`。 */
  key: string;
  message: SessionMessageRow;
  sourceKey: string;
  targetKey: string;
}

export interface LaidLane {
  harness: Harness | null;
  /** 泳道左缘 x（节点 x 与标签 x 同值）。 */
  x: number;
  count: number;
}

export interface LaidSequenceCanvas {
  nodes: LaidSessionNode[];
  edges: LaidMessageEdge[];
  lanes: LaidLane[];
}

/** 会话 → 泳道序（名表序；未知/null 归末尾），只给在场 harness 开道。 */
function laneIndex(harness: Harness | null | undefined): number {
  if (harness != null && HARNESS_ORDER.includes(harness)) return HARNESS_ORDER.indexOf(harness);
  return HARNESS_ORDER.length;
}

export function layoutSequenceCanvas(
  sessions: readonly SessionRow[],
  /** 去重后的会话间消息（调用方从各会话线程聚合，每条恰一次）。 */
  messages: readonly SessionMessageRow[],
): LaidSequenceCanvas {
  const present = new Map<number, { harness: Harness | null; count: number }>();
  for (const s of sessions) {
    const idx = laneIndex(s.harness);
    const lane = present.get(idx) ?? { harness: s.harness ?? null, count: 0 };
    lane.count += 1;
    present.set(idx, lane);
  }
  // 泳道编号重排为出现序（0..n-1），未知 harness 列恒在最后。
  const orderedIdx = [...present.keys()].sort((a, b) => a - b);
  const remap = new Map(orderedIdx.map((idx, i) => [idx, i]));
  const lanes: LaidLane[] = orderedIdx.map((idx, i) => ({
    harness: present.get(idx)!.harness,
    x: i * SEQ_LANE_W,
    count: present.get(idx)!.count,
  }));

  const nextRow = lanes.map(() => 0);
  const nodeOf = new Map<string, LaidSessionNode>();
  const nodes: LaidSessionNode[] = [];
  for (const s of sessions) {
    const lane = remap.get(laneIndex(s.harness)) ?? 0;
    const row = nextRow[lane]!;
    nextRow[lane] = row + 1;
    const node: LaidSessionNode = {
      key: `s:${s.sessionId}`,
      session: s,
      lane,
      row,
      x: lane * SEQ_LANE_W,
      y: SEQ_LANE_HEADER_H + row * SEQ_ROW_H,
    };
    nodeOf.set(s.sessionId, node);
    nodes.push(node);
  }

  const edges: LaidMessageEdge[] = [];
  for (const m of messages) {
    // 两端都在画布上才成边；dashboard/cli 投递（fromSessionId null）天然落空。
    const source = m.fromSessionId != null ? nodeOf.get(m.fromSessionId) : undefined;
    const target = nodeOf.get(m.toSessionId);
    if (!source || !target) continue;
    edges.push({
      key: `m:${m.id}`,
      message: m,
      sourceKey: source.key,
      targetKey: target.key,
    });
  }
  return { nodes, edges, lanes };
}

/** 每会话线程 → 会话间消息去重切片：双向线程里每条会话间消息恰出现一次
 *  （在发送方的线程里 fromSessionId === 自己）；dashboard/cli 投递无源端，
 *  不进边集合（接收计数走全量线程）。 */
export function outgoingOf(threadBySession: ReadonlyMap<string, SessionMessageRow[]>): SessionMessageRow[] {
  const out: SessionMessageRow[] = [];
  for (const [sessionId, list] of threadBySession) {
    for (const m of list) if (m.fromSessionId === sessionId) out.push(m);
  }
  return out;
}
