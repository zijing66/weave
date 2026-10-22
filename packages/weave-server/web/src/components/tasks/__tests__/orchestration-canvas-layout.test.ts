import { describe, it, expect } from 'vitest';
import {
  ORCH_GROUP_COLLAPSED_H,
  ORCH_HOOK_H,
  ORCH_HOOK_W,
  ORCH_NODE_W,
  ORCH_ROW_H,
  layoutOrchestrationCanvas,
  type OrchCanvasSession,
} from '../orchestration-canvas-layout';
import type { OrchestrationNode } from '@/lib/api';

const sessions = new Map<string, OrchCanvasSession>([
  ['a', { sessionId: 'a', title: 'A', projectId: 1 }],
  ['b', { sessionId: 'b', title: 'B', projectId: 1 }],
  ['c', { sessionId: 'c', title: 'C', projectId: 2 }],
]);

const sessionNodes = (...ids: string[]): OrchestrationNode[] =>
  ids.map((id) => ({ id, kind: 'session' as const }));

const edges = [
  { id: 'a->b', from: 'a', to: 'b', text: '' },
  { id: 'b->c', from: 'b', to: 'c', text: '' },
];

/** 只取会话/Webhook 节点（连接点单独断言）。 */
const realNodes = (laid: ReturnType<typeof layoutOrchestrationCanvas>): string[] =>
  laid.nodes.filter((n) => n.kind !== 'hook').map((n) => n.key);

describe('layoutOrchestrationCanvas', () => {
  it('项目视图：节点按层摆列，跨层边直接连节点', () => {
    const laid = layoutOrchestrationCanvas({
      nodes: sessionNodes('a', 'b', 'c'),
      edges,
      sessions,
      groupProjects: false,
      collapsed: new Set(),
    });
    expect(realNodes(laid)).toEqual(['s:a', 's:b', 's:c']);
    const [a, b, c] = laid.nodes.filter((n) => n.kind === 'session');
    expect(a!.y).toBe(b!.y);
    expect(b!.x).toBeGreaterThan(a!.x);
    expect(c!.x).toBeGreaterThan(b!.x);
    expect(laid.edges.map((e) => `${e.from}->${e.to}`)).toEqual(['s:a->s:b', 's:b->s:c']);
  });

  it('每条连线一个连接点：摆在两层之间的空隙正中', () => {
    const laid = layoutOrchestrationCanvas({
      nodes: sessionNodes('a', 'b'),
      edges: [{ id: 'e1', from: 'a', to: 'b', text: 'go' }],
      sessions,
      groupProjects: false,
      collapsed: new Set(),
    });
    const hooks = laid.nodes.filter((n) => n.kind === 'hook');
    expect(hooks).toHaveLength(1);
    const hook = hooks[0]!;
    expect(hook.edgeKey).toBe('s:a->s:b');
    const a = laid.nodes.find((n) => n.key === 's:a')!;
    const b = laid.nodes.find((n) => n.key === 's:b')!;
    // 横向落在两张卡片之间，纵向落在两卡片中线附近。
    expect(hook.x).toBeGreaterThan(a.x + ORCH_NODE_W - 1);
    expect(hook.x + ORCH_HOOK_W).toBeLessThan(b.x + 1);
    expect(hook.y).toBeGreaterThanOrEqual(Math.min(a.y, b.y));
  });

  it('扇出到同一列的连接点上下错开（不重叠）', () => {
    const laid = layoutOrchestrationCanvas({
      nodes: sessionNodes('a', 'b', 'c'),
      edges: [
        { id: 'ab', from: 'a', to: 'b', text: 'x' },
        { id: 'ac', from: 'a', to: 'c', text: 'y' },
      ],
      sessions,
      groupProjects: false,
      collapsed: new Set(),
    });
    const hooks = laid.nodes.filter((n) => n.kind === 'hook');
    expect(hooks).toHaveLength(2);
    const [h1, h2] = hooks.sort((p, q) => p.y - q.y);
    expect(Math.abs(h1!.y - h2!.y)).toBeGreaterThanOrEqual(ORCH_HOOK_H);
  });

  it('webhook 节点摆成自己的键（w: 前缀），不属于任何项目框', () => {
    const laid = layoutOrchestrationCanvas({
      nodes: [...sessionNodes('a', 'b'), { id: 'w:1', kind: 'webhook' as const }],
      edges: [{ id: 'w->a', from: 'w:1', to: 'a', text: '' }],
      sessions,
      groupProjects: false,
      collapsed: new Set(),
    });
    expect(realNodes(laid)).toContain('w:1');
    expect(laid.edges.map((e) => `${e.from}->${e.to}`)).toEqual(['w:1->s:a']);
    expect(laid.nodes.filter((n) => n.kind === 'hook')).toHaveLength(1);
  });

  it('全局视图：每个项目一个框，框住自己的节点且两框不重叠', () => {
    const laid = layoutOrchestrationCanvas({
      nodes: sessionNodes('a', 'b', 'c'),
      edges,
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

  it('收起的项目只剩一个框：节点不摆出来，边折到框上并合并', () => {
    const laid = layoutOrchestrationCanvas({
      nodes: sessionNodes('a', 'b', 'c'),
      edges,
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
    // 端点收进分组框后不再摆连接点（连线上没有可点的钩子）。
    expect(laid.nodes.filter((n) => n.kind === 'hook')).toHaveLength(0);
  });

  it('同一项目的同列节点按行距上下排', () => {
    const laid = layoutOrchestrationCanvas({
      nodes: sessionNodes('a', 'b'),
      edges: [],
      sessions,
      groupProjects: false,
      collapsed: new Set(),
    });
    const [a, b] = laid.nodes;
    expect(b!.x).toBe(a!.x);
    expect(b!.y - a!.y).toBe(ORCH_ROW_H);
  });
});
