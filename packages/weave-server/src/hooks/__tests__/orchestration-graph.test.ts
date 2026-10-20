import { describe, expect, it } from 'vitest';
import {
  ORCH_MAX_EDGES,
  ORCH_MAX_NODES,
  findCycle,
  ranksOf,
  reachableFrom,
  validateOrchestration,
} from '../orchestration-graph.js';
import type { OrchestrationEdge } from '../../repositories/orchestrations.js';

function edge(from: string, to: string, id = `${from}-${to}`): OrchestrationEdge {
  return { id, from, to, text: 'go' };
}

describe('findCycle', () => {
  it('无环 → null', () => {
    expect(findCycle(['a', 'b', 'c'], [edge('a', 'b'), edge('b', 'c')])).toBeNull();
  });

  it('自环 / 双点 / 长环都认得出，且首尾同点', () => {
    expect(findCycle(['a'], [edge('a', 'a')])).toEqual(['a', 'a']);
    expect(findCycle(['a', 'b'], [edge('a', 'b'), edge('b', 'a')])).toEqual(['a', 'b', 'a']);
    const long = findCycle(
      ['a', 'b', 'c', 'd'],
      [edge('a', 'b'), edge('b', 'c'), edge('c', 'd'), edge('d', 'b')],
    );
    expect(long).toEqual(['b', 'c', 'd', 'b']);
  });
});

describe('reachableFrom', () => {
  it('只算沿边可达的那些', () => {
    const seen = reachableFrom('a', [edge('a', 'b'), edge('b', 'c')]);
    expect([...seen].sort()).toEqual(['a', 'b', 'c']);
    expect(reachableFrom('a', [edge('b', 'c')]).has('c')).toBe(false);
  });
});

describe('ranksOf', () => {
  it('最长路分层：汇合点取更长的那条', () => {
    const ranks = ranksOf(
      ['a', 'b', 'c', 'd'],
      [edge('a', 'b'), edge('b', 'c'), edge('a', 'c'), edge('c', 'd')],
    );
    expect([...ranks]).toEqual([
      ['a', 0],
      ['b', 1],
      ['c', 2],
      ['d', 3],
    ]);
  });
});

describe('validateOrchestration', () => {
  const base = { startSessionId: 'a', nodes: ['a', 'b'], edges: [edge('a', 'b')] };

  it('合法图通过', () => {
    expect(validateOrchestration(base)).toEqual({ ok: true });
  });

  it('起始不在节点集 / 空节点集', () => {
    expect(validateOrchestration({ ...base, startSessionId: 'z' })).toMatchObject({ ok: false });
    expect(validateOrchestration({ ...base, nodes: [], edges: [] })).toMatchObject({ ok: false });
  });

  it('重复节点 / 端点越界 / 自环 / 重边各自拒绝', () => {
    expect(validateOrchestration({ ...base, nodes: ['a', 'a'] })).toMatchObject({
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

  it('空正文只在「带上游输出」时合法（否则等于投一条空消息）', () => {
    expect(validateOrchestration({ ...base, edges: [edge('a', 'b')] })).toEqual({ ok: true });
    expect(
      validateOrchestration({ ...base, edges: [{ ...edge('a', 'b'), text: '  ' }] }),
    ).toMatchObject({ error: expect.stringContaining('has no message') });
    expect(
      validateOrchestration({ ...base, edges: [{ ...edge('a', 'b'), text: '', carryOutput: true }] }),
    ).toEqual({ ok: true });
  });

  it('成环 → 报出环路', () => {
    const result = validateOrchestration({
      startSessionId: 'a',
      nodes: ['a', 'b'],
      edges: [edge('a', 'b'), edge('b', 'a')],
    });
    expect(result).toEqual({ ok: false, error: 'Cycle detected: a → b → a' });
  });

  it('不可达节点拒绝', () => {
    expect(
      validateOrchestration({ startSessionId: 'a', nodes: ['a', 'b', 'c'], edges: [edge('a', 'b')] }),
    ).toMatchObject({ error: expect.stringContaining('unreachable') });
  });

  it('规模上限', () => {
    const many = Array.from({ length: ORCH_MAX_NODES + 1 }, (_, i) => `n${i}`);
    expect(validateOrchestration({ startSessionId: 'n0', nodes: many, edges: [] })).toMatchObject({
      error: expect.stringContaining(String(ORCH_MAX_NODES)),
    });
    const nodes = Array.from({ length: 4 }, (_, i) => `m${i}`);
    const edges = Array.from({ length: ORCH_MAX_EDGES + 1 }, (_, i) =>
      edge(nodes[i % 4]!, nodes[(i + 1) % 4]!, `e${i}`),
    );
    expect(validateOrchestration({ startSessionId: 'm0', nodes, edges })).toMatchObject({
      error: expect.stringContaining(String(ORCH_MAX_EDGES)),
    });
  });
});
