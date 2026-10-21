import { describe, expect, it } from 'vitest';
import {
  ORCH_MAX_EDGES,
  ORCH_MAX_NODES,
  findCycle,
  ranksOf,
  validateOrchestration,
} from '../orchestration-graph.js';
import { graphDirections } from '../../repositories/orchestrations.js';
import type {
  OrchestrationEdge,
  OrchestrationNode,
} from '../../repositories/orchestrations.js';

function edge(from: string, to: string, id = `${from}-${to}`): OrchestrationEdge {
  return { id, from, to, text: 'go' };
}

const sessionNode = (id: string): OrchestrationNode => ({ id, kind: 'session' });
const webhookNode = (id = 'w:1'): OrchestrationNode => ({ id, kind: 'webhook' });

describe('findCycle', () => {
  it('无环 → null', () => {
    const nodes = [sessionNode('a'), sessionNode('b'), sessionNode('c')];
    expect(findCycle(nodes, [edge('a', 'b'), edge('b', 'c')])).toBeNull();
  });

  it('自环 / 双点 / 长环都认得出，且首尾同点', () => {
    expect(findCycle([sessionNode('a')], [edge('a', 'a')])).toEqual(['a', 'a']);
    expect(findCycle([sessionNode('a'), sessionNode('b')], [edge('a', 'b'), edge('b', 'a')])).toEqual([
      'a',
      'b',
      'a',
    ]);
    const long = findCycle(
      [sessionNode('a'), sessionNode('b'), sessionNode('c'), sessionNode('d')],
      [edge('a', 'b'), edge('b', 'c'), edge('c', 'd'), edge('d', 'b')],
    );
    expect(long).toEqual(['b', 'c', 'd', 'b']);
  });
});

describe('reachableFromAny（已并入入口语义，保留孤立 session 的平凡合法性）', () => {
  it('孤立 session 节点 = 自成入口的平凡编排（合法）', () => {
    expect(validateOrchestration({ nodes: [sessionNode('a')], edges: [] })).toEqual({ ok: true });
  });
});

describe('ranksOf', () => {
  it('最长路分层：汇合点取更长的那条；多源入口都是 0', () => {
    const ranks = ranksOf(
      [sessionNode('a'), sessionNode('b'), sessionNode('c'), sessionNode('d'), sessionNode('e')],
      [edge('a', 'b'), edge('b', 'c'), edge('a', 'c'), edge('c', 'd'), edge('e', 'c')],
    );
    expect(ranks.get('a')).toBe(0);
    expect(ranks.get('e')).toBe(0);
    expect(ranks.get('b')).toBe(1);
    expect(ranks.get('c')).toBe(2);
    expect(ranks.get('d')).toBe(3);
  });
});

describe('graphDirections', () => {
  it('入口 = 无入边，出口 = 无出边', () => {
    const nodes = [sessionNode('a'), sessionNode('b'), webhookNode()];
    const edges = [edge('w:1', 'a'), edge('a', 'b')];
    const { entries, exits } = graphDirections(nodes, edges);
    expect(entries.map((n) => n.id)).toEqual(['w:1']);
    expect(exits.map((n) => n.id)).toEqual(['b']);
  });
});

describe('validateOrchestration', () => {
  const base = {
    nodes: [sessionNode('a'), sessionNode('b')],
    edges: [edge('a', 'b')],
  };

  it('合法图通过', () => {
    expect(validateOrchestration(base)).toEqual({ ok: true });
  });

  it('空节点集拒绝', () => {
    expect(validateOrchestration({ nodes: [], edges: [] })).toMatchObject({ ok: false });
  });

  it('重复节点 / 端点越界 / 自环 / 重边各自拒绝', () => {
    expect(validateOrchestration({ ...base, nodes: [sessionNode('a'), sessionNode('a')] })).toMatchObject({
      error: expect.stringContaining('Duplicate node'),
    });
    expect(
      validateOrchestration({ ...base, edges: [edge('a', 'z')] }),
    ).toMatchObject({ error: expect.stringContaining('outside the node set') });
    expect(validateOrchestration({ ...base, edges: [edge('a', 'a')] })).toMatchObject({
      error: expect.stringContaining('Self-loop'),
    });
    expect(
      validateOrchestration({
        ...base,
        edges: [edge('a', 'b', 'e1'), edge('a', 'b', 'e2')],
      }),
    ).toMatchObject({ error: expect.stringContaining('Duplicate edge') });
  });

  it('空正文只在 webhook 入口的出边上合法', () => {
    expect(validateOrchestration({ ...base, edges: [edge('a', 'b')] })).toEqual({ ok: true });
    expect(
      validateOrchestration({ ...base, edges: [{ ...edge('a', 'b'), text: '  ' }] }),
    ).toMatchObject({ error: expect.stringContaining('has no message') });
    expect(
      validateOrchestration({
        nodes: [webhookNode(), sessionNode('a')],
        edges: [{ ...edge('w:1', 'a'), text: '' }],
      }),
    ).toEqual({ ok: true });
  });

  it('webhook 节点：id 前缀、两端形状、出口 URL 各自判据', () => {
    expect(
      validateOrchestration({
        nodes: [{ id: 'hook', kind: 'webhook' }, sessionNode('a')],
        edges: [edge('hook', 'a')],
      }),
    ).toMatchObject({ error: expect.stringContaining('"w:"') });
    expect(
      validateOrchestration({
        nodes: [sessionNode('a'), sessionNode('b'), sessionNode('c'), webhookNode()],
        edges: [edge('a', 'b'), edge('b', 'w:1'), edge('w:1', 'c')],
      }),
    ).toMatchObject({ error: expect.stringContaining('both inbound and outbound') });
    expect(
      validateOrchestration({
        nodes: [webhookNode(), sessionNode('a')],
        edges: [],
      }),
    ).toMatchObject({ error: expect.stringContaining('not connected') });
    expect(
      validateOrchestration({
        nodes: [sessionNode('a'), webhookNode()],
        edges: [edge('a', 'w:1')],
      }),
    ).toMatchObject({ error: expect.stringContaining('http(s)') });
    expect(
      validateOrchestration({
        nodes: [sessionNode('a'), { id: 'w:1', kind: 'webhook', url: 'https://example.com/h' }],
        edges: [edge('a', 'w:1')],
      }),
    ).toEqual({ ok: true });
  });

  it('成环 → 报出环路', () => {
    const result = validateOrchestration({
      nodes: [sessionNode('a'), sessionNode('b')],
      edges: [edge('a', 'b'), edge('b', 'a')],
    });
    expect(result).toEqual({ ok: false, error: 'Cycle detected: a → b → a' });
  });

  it('多入口独立子图合法（各自触发，互不等待）', () => {
    expect(
      validateOrchestration({
        nodes: [sessionNode('a'), sessionNode('b'), sessionNode('c')],
        edges: [edge('a', 'b'), edge('c', 'b')],
      }),
    ).toEqual({ ok: true });
  });

  it('规模上限', () => {
    const many = Array.from({ length: ORCH_MAX_NODES + 1 }, (_, i) => sessionNode(`n${i}`));
    expect(validateOrchestration({ nodes: many, edges: [] })).toMatchObject({
      error: expect.stringContaining(String(ORCH_MAX_NODES)),
    });
    const nodes = [sessionNode('m0'), sessionNode('m1'), sessionNode('m2'), sessionNode('m3')];
    const edges = Array.from({ length: ORCH_MAX_EDGES + 1 }, (_, i) =>
      edge(nodes[i % 4]!.id, nodes[(i + 1) % 4]!.id, `e${i}`),
    );
    expect(validateOrchestration({ nodes, edges })).toMatchObject({
      error: expect.stringContaining(String(ORCH_MAX_EDGES)),
    });
  });
});
