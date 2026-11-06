import { describe, it, expect } from 'vitest';
import { layoutOrchestrationLR } from '../orchestration-lr-layout';
import { ORCH_COL_W, ORCH_ROW_H } from '../orchestration-canvas-layout';
import type { OrchestrationNode } from '@/lib/api';

const sessionNodes = (...ids: string[]): OrchestrationNode[] =>
  ids.map((id) => ({ id, kind: 'session' as const }));

const linear = [
  { from: 'a', to: 'b' },
  { from: 'b', to: 'c' },
];

describe('layoutOrchestrationLR', () => {
  it('拓扑分层：x = 层号 × 列距，入口在第 0 层', () => {
    const { positions, maxRank } = layoutOrchestrationLR(sessionNodes('a', 'b', 'c'), linear);
    expect(maxRank).toBe(2);
    expect(positions.get('a')).toMatchObject({ x: 0, rank: 0 });
    expect(positions.get('b')!.x).toBe(ORCH_COL_W);
    expect(positions.get('c')!.x).toBe(ORCH_COL_W * 2);
  });

  it('最长路径分层：菱形里汇合点落最深的波', () => {
    const { positions } = layoutOrchestrationLR(
      sessionNodes('a', 'b', 'c', 'd'),
      [
        { from: 'a', to: 'b' },
        { from: 'a', to: 'c' },
        { from: 'b', to: 'd' },
        { from: 'c', to: 'd' },
      ],
    );
    expect(positions.get('b')!.rank).toBe(1);
    expect(positions.get('c')!.rank).toBe(1);
    expect(positions.get('d')!.rank).toBe(2);
    // 菱形对称：b 与 c 同层不同行。
    expect(positions.get('b')!.y).not.toBe(positions.get('c')!.y);
  });

  it('层内 y 按 barycenter 排：无已落位前驱保持输入序', () => {
    const { positions } = layoutOrchestrationLR(
      sessionNodes('x1', 'x2', 'x3', 'd'),
      [
        { from: 'x1', to: 'd' },
        { from: 'x2', to: 'd' },
      ],
    );
    expect(positions.get('x1')!.y).toBe(0);
    expect(positions.get('x2')!.y).toBe(ORCH_ROW_H);
    expect(positions.get('x3')!.y).toBe(ORCH_ROW_H * 2);
    expect(positions.get('d')!.rank).toBe(1);
  });

  it('环兜底：环上节点落第 0 列且算法终止（防死循环护栏）', () => {
    const { positions, maxRank } = layoutOrchestrationLR(
      sessionNodes('a', 'r1', 'r2', 'b'),
      [
        ...linear,
        { from: 'r1', to: 'r2' },
        { from: 'r2', to: 'r1' },
        { from: 'a', to: 'b' },
      ],
    );
    expect(positions.get('r1')!.rank).toBe(0);
    expect(positions.get('r2')!.rank).toBe(0);
    expect(positions.get('a')!.rank).toBe(0);
    expect(positions.get('b')!.rank).toBe(1);
    expect(maxRank).toBeGreaterThanOrEqual(1);
  });

  it('悬空边（端点不在节点集）不炸布局', () => {
    const { positions } = layoutOrchestrationLR(sessionNodes('a'), [{ from: 'ghost', to: 'a' }]);
    expect(positions.get('a')!.rank).toBe(0);
  });

  it('空图：无落点、maxRank = -1', () => {
    const { positions, maxRank } = layoutOrchestrationLR([], []);
    expect(positions.size).toBe(0);
    expect(maxRank).toBe(-1);
  });

  it('大环图不挂死：三节点互指全部落 0 层', () => {
    const { positions } = layoutOrchestrationLR(
      sessionNodes('p', 'q', 'r'),
      [
        { from: 'p', to: 'q' },
        { from: 'q', to: 'r' },
        { from: 'r', to: 'p' },
      ],
    );
    for (const id of ['p', 'q', 'r']) expect(positions.get(id)!.rank).toBe(0);
  });
});
