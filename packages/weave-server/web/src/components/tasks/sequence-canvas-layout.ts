import type { Harness } from '@weavecode/core/harness';
import type { SessionRow } from '@/lib/api';
import { HARNESS_ORDER } from '@/lib/harness-meta';

/**
 * 编排画布布局（纯函数，可单测）：会话按 harness 泳道分列（名表序，未知
 * harness 归末列），泳道内按输入序（状态总线列表 = 新在前）纵向排布。
 * 消息不再是边——管道态不记录发起方（消息域重塑：在途视图只答「投给谁」），
 * 会话间收发不成图；在途量由节点计数与表头承载。
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

export interface LaidLane {
  harness: Harness | null;
  /** 泳道左缘 x（节点 x 与标签 x 同值）。 */
  x: number;
  count: number;
}

export interface LaidSequenceCanvas {
  nodes: LaidSessionNode[];
  lanes: LaidLane[];
}

/** 会话 → 泳道序（名表序；未知/null 归末尾），只给在场 harness 开道。 */
function laneIndex(harness: Harness | null | undefined): number {
  if (harness != null && HARNESS_ORDER.includes(harness)) return HARNESS_ORDER.indexOf(harness);
  return HARNESS_ORDER.length;
}

export function layoutSequenceCanvas(sessions: readonly SessionRow[]): LaidSequenceCanvas {
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
    nodes.push(node);
  }

  return { nodes, lanes };
}
