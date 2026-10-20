import { describe, it, expect } from 'vitest';
import {
  ORCH_GROUP_COLLAPSED_H,
  ORCH_ROW_H,
  layoutOrchestrationCanvas,
  type OrchCanvasSession,
} from '../orchestration-canvas-layout';

const sessions = new Map<string, OrchCanvasSession>([
  ['a', { sessionId: 'a', title: 'A', projectId: 1 }],
  ['b', { sessionId: 'b', title: 'B', projectId: 1 }],
  ['c', { sessionId: 'c', title: 'C', projectId: 2 }],
]);

const edges = [
  { id: 'a->b', from: 'a', to: 'b', text: '' },
  { id: 'b->c', from: 'b', to: 'c', text: '' },
];

describe('layoutOrchestrationCanvas', () => {
  it('项目视图：会话按层摆列，跨层边直接连会话节点', () => {
    const laid = layoutOrchestrationCanvas({
      nodes: ['a', 'b', 'c'],
      edges,
      startSessionId: 'a',
      sessions,
      groupProjects: false,
      collapsed: new Set(),
    });
    expect(laid.nodes.map((n) => n.key)).toEqual(['s:a', 's:b', 's:c']);
    const [a, b, c] = laid.nodes;
    expect(a!.y).toBe(b!.y);
    expect(b!.x).toBeGreaterThan(a!.x);
    expect(c!.x).toBeGreaterThan(b!.x);
    expect(laid.edges.map((e) => `${e.from}->${e.to}`)).toEqual(['s:a->s:b', 's:b->s:c']);
  });

  it('全局视图：每个项目一个框，框住自己的会话且两框不重叠', () => {
    const laid = layoutOrchestrationCanvas({
      nodes: ['a', 'b', 'c'],
      edges,
      startSessionId: 'a',
      sessions,
      groupProjects: true,
      collapsed: new Set(),
    });
    const groups = laid.nodes.filter((n) => n.kind === 'group');
    expect(groups.map((g) => g.projectId)).toEqual([1, 2]);
    const [g1, g2] = groups;
    for (const group of groups) {
      const inside = laid.nodes.filter(
        (n) => n.kind === 'session' && n.projectId === group.projectId,
      );
      expect(inside.length).toBe(group.projectId === 1 ? 2 : 1);
      for (const node of inside) {
        expect(node.x).toBeGreaterThanOrEqual(group.x!);
        expect(node.y).toBeGreaterThanOrEqual(group.y!);
        expect(node.x + 220).toBeLessThanOrEqual(group.x! + group.width!);
      }
    }
    // 项目框之间不重叠（不同列就不必错行，同列才往下叠）。
    const overlaps = (a: typeof g1, b: typeof g2): boolean =>
      a!.x < b!.x + b!.width! &&
      b!.x < a!.x + a!.width! &&
      a!.y < b!.y + b!.height! &&
      b!.y < a!.y + a!.height!;
    expect(overlaps(g1, g2)).toBe(false);
  });

  it('收起的项目只剩一个框：会话不摆出来，边折到框上并合并', () => {
    const laid = layoutOrchestrationCanvas({
      nodes: ['a', 'b', 'c'],
      edges,
      startSessionId: 'a',
      sessions,
      groupProjects: true,
      collapsed: new Set([1, 2]),
    });
    expect(laid.nodes.filter((n) => n.kind === 'session')).toHaveLength(0);
    const g1 = laid.nodes.find((n) => n.projectId === 1)!;
    expect(g1.height).toBe(ORCH_GROUP_COLLAPSED_H);
    expect(g1.hidden).toBe(2);
    expect(laid.edges).toEqual([
      { key: 'g:1->g:2', from: 'g:1', to: 'g:2', edgeIds: ['b->c'] },
    ]);
  });

  it('同一项目的同列会话按行距上下排', () => {
    const laid = layoutOrchestrationCanvas({
      nodes: ['a', 'b'],
      edges: [],
      startSessionId: 'a',
      sessions,
      groupProjects: false,
      collapsed: new Set(),
    });
    const [a, b] = laid.nodes;
    expect(b!.x).toBe(a!.x);
    expect(b!.y - a!.y).toBe(ORCH_ROW_H);
  });
});
