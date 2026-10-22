import { describe, it, expect } from 'vitest';
import {
  ORCH_GROUP_COLLAPSED_H,
  ORCH_GROUP_HEADER_H,
  ORCH_GROUP_PAD,
  ORCH_ROW_H,
  layoutOrchestrationCanvas,
  layoutOrchestrationOverview,
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

describe('layoutOrchestrationCanvas', () => {
  it('项目视图：节点按层摆列，跨层边直接连节点', () => {
    const laid = layoutOrchestrationCanvas({
      nodes: sessionNodes('a', 'b', 'c'),
      edges,
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

  it('webhook 节点摆成自己的键（w: 前缀），不属于任何项目框', () => {
    const laid = layoutOrchestrationCanvas({
      nodes: [...sessionNodes('a', 'b'), { id: 'w:1', kind: 'webhook' as const }],
      edges: [{ id: 'w->a', from: 'w:1', to: 'a', text: '' }],
      sessions,
      groupProjects: false,
      collapsed: new Set(),
    });
    expect(laid.nodes.map((n) => n.key)).toContain('w:1');
    expect(laid.edges.map((e) => `${e.from}->${e.to}`)).toEqual(['w:1->s:a']);
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

describe('layoutOrchestrationOverview', () => {
  const block = (key: string, ids: string[], edgeList: { id: string; from: string; to: string }[]) => ({
    key,
    label: `编排 ${key}`,
    nodes: sessionNodes(...ids),
    edges: edgeList.map((e) => ({ ...e, text: '' })),
  });

  it('每份编排一块：键带 o<id>: 前缀，块纵向不重叠、各带分组框', () => {
    const laid = layoutOrchestrationOverview({
      blocks: [
        block('1', ['a', 'b'], [{ id: 'e1', from: 'a', to: 'b' }]),
        block('2', ['c'], []),
      ],
      sessions,
      collapsed: new Set(),
    });
    // 分组框垫底（ReactFlow 后者画在上面），成员键带编排前缀。
    expect(laid.nodes.filter((n) => n.kind === 'group').map((n) => n.key)).toEqual([
      'o1:g',
      'o2:g',
    ]);
    expect(laid.nodes.filter((n) => n.kind === 'session').map((n) => n.key)).toEqual([
      'o1:s:a',
      'o1:s:b',
      'o2:s:c',
    ]);
    expect(laid.edges).toEqual([
      { key: 'o1:s:a->o1:s:b', from: 'o1:s:a', to: 'o1:s:b', edgeIds: ['e1'] },
    ]);
    // 两块不重叠：第二块的框顶在第一块框底之下。
    const [g1, g2] = laid.nodes.filter((n) => n.kind === 'group');
    expect(g2!.y).toBeGreaterThanOrEqual(g1!.y + g1!.height! + ORCH_GROUP_PAD);
    // 框头之下才是成员。
    const a = laid.nodes.find((n) => n.key === 'o1:s:a')!;
    expect(a.y).toBeGreaterThanOrEqual(g1!.y + ORCH_GROUP_HEADER_H + ORCH_GROUP_PAD);
  });

  it('跨编排的同名会话不碰撞（前缀隔离）', () => {
    const laid = layoutOrchestrationOverview({
      blocks: [block('1', ['a'], []), block('2', ['a'], [])],
      sessions,
      collapsed: new Set(),
    });
    const keys = laid.nodes.filter((n) => n.kind === 'session').map((n) => n.key);
    expect(new Set(keys).size).toBe(2);
    expect(keys).toEqual(['o1:s:a', 'o2:s:a']);
  });

  it('收起的块只剩框：成员不摆、边全丢、hidden 计数', () => {
    const laid = layoutOrchestrationOverview({
      blocks: [block('1', ['a', 'b'], [{ id: 'e1', from: 'a', to: 'b' }])],
      sessions,
      collapsed: new Set(['1']),
    });
    expect(laid.nodes).toHaveLength(1);
    const g = laid.nodes[0]!;
    expect(g.kind).toBe('group');
    expect(g.key).toBe('o1:g');
    expect(g.height).toBe(ORCH_GROUP_COLLAPSED_H);
    expect(g.hidden).toBe(2);
    expect(laid.edges).toEqual([]);
  });

  it('空节点的块不摆', () => {
    const laid = layoutOrchestrationOverview({
      blocks: [block('1', [], []), block('2', ['c'], [])],
      sessions,
      collapsed: new Set(),
    });
    expect(laid.nodes.map((n) => n.key)).toEqual(['o2:g', 'o2:s:c']);
  });
});
