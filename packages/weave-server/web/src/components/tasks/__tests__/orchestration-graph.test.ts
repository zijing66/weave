import { describe, it, expect } from 'vitest';
import {
  addEdge,
  addNode,
  findCycle,
  ranksOf,
  reachableFrom,
  removeNode,
  validateDraft,
  type OrchDraft,
} from '../orchestration-graph';

const draft = (over: Partial<OrchDraft> = {}): OrchDraft => ({
  name: 'chain',
  startSessionId: 'a',
  startText: '',
  handoffPrompt: '',
  nodes: ['a', 'b'],
  edges: [{ id: 'a->b', from: 'a', to: 'b', text: 'go' }],
  cron: null,
  ...over,
});

/** 校验失败时的错误文案（通过时给空串，比较用）。 */
const errorOf = (d: OrchDraft): string => {
  const res = validateDraft(d);
  return res.ok ? '' : res.error;
};

describe('orchestration draft editing', () => {
  it('加节点时首个节点自动成为起点', () => {
    const empty = draft({ nodes: [], edges: [], startSessionId: '' });
    expect(addNode(empty, 'x')).toMatchObject({ nodes: ['x'], startSessionId: 'x' });
  });

  it('删节点连带它的边，起点顺延到剩下的第一个', () => {
    const next = removeNode(draft(), 'a');
    expect(next.nodes).toEqual(['b']);
    expect(next.edges).toEqual([]);
    expect(next.startSessionId).toBe('b');
  });

  it('加边默认带上游输出', () => {
    expect(addEdge(draft(), 'b', 'c', '')).toMatchObject({
      edges: [{ id: 'a->b' }, { from: 'b', to: 'c', carryOutput: true }],
    });
  });

  it('加边生成稳定 id，成环由校验拦住', () => {
    const withBack = addEdge(draft(), 'b', 'a', 'back');
    expect(withBack.edges.map((e) => e.id)).toEqual(['a->b', 'b->a']);
    expect(validateDraft(withBack)).toEqual({
      ok: false,
      error: 'Cycle detected: a → b → a',
    });
  });
});

describe('orchestration graph helpers', () => {
  it('findCycle 返回环路径（无环 null）', () => {
    const edges = [
      { id: '1', from: 'a', to: 'b', text: '' },
      { id: '2', from: 'b', to: 'c', text: '' },
      { id: '3', from: 'c', to: 'b', text: '' },
    ];
    expect(findCycle(['a', 'b', 'c'], edges)).toEqual(['b', 'c', 'b']);
    expect(findCycle(['a', 'b'], [edges[0]!])).toBeNull();
  });

  it('reachableFrom 只算得从起点走得到的', () => {
    const edges = [{ id: '1', from: 'a', to: 'b', text: '' }];
    expect([...reachableFrom(['a', 'b', 'c'], edges, 'a')].sort()).toEqual(['a', 'b']);
  });

  it('ranksOf 按最长路径分层', () => {
    const edges = [
      { id: '1', from: 'a', to: 'b', text: '' },
      { id: '2', from: 'a', to: 'c', text: '' },
      { id: '3', from: 'b', to: 'd', text: '' },
      { id: '4', from: 'c', to: 'd', text: '' },
    ];
    const ranks = ranksOf(['a', 'b', 'c', 'd'], edges, 'a');
    expect([ranks.get('a'), ranks.get('b'), ranks.get('c'), ranks.get('d')]).toEqual([0, 1, 1, 2]);
  });
});

describe('validateDraft', () => {
  it('通过一份合法图', () => {
    expect(validateDraft(draft())).toEqual({ ok: true });
  });

  it('起点不在节点集里、不可达、重边都被拒', () => {
    expect(validateDraft(draft({ startSessionId: 'x' }))).toMatchObject({ ok: false });
    expect(errorOf(draft({ nodes: ['a', 'b', 'c'] }))).toContain('unreachable');
    const dup = draft({
      edges: [
        { id: '1', from: 'a', to: 'b', text: '' },
        { id: '2', from: 'a', to: 'b', text: '' },
      ],
    });
    expect(errorOf(dup)).toContain('Duplicate edge');
  });

  it('空正文要带「上游输出」才放行', () => {
    expect(errorOf(draft({ edges: [{ id: 'a->b', from: 'a', to: 'b', text: ' ' }] }))).toContain(
      'has no message',
    );
    expect(
      validateDraft(
        draft({ edges: [{ id: 'a->b', from: 'a', to: 'b', text: '', carryOutput: true }] }),
      ),
    ).toEqual({ ok: true });
  });
});
