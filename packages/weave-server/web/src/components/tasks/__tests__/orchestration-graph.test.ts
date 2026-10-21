import { describe, it, expect } from 'vitest';
import {
  addEdge,
  addSessionNode,
  addWebhookNode,
  findCycle,
  graphDirections,
  ranksOf,
  removeNode,
  validateDraft,
  type OrchDraft,
} from '../orchestration-graph';

const draft = (over: Partial<OrchDraft> = {}): OrchDraft => ({
  name: 'chain',
  startText: '',
  nodes: [
    { id: 'a', kind: 'session' },
    { id: 'b', kind: 'session' },
  ],
  edges: [{ id: 'a->b', from: 'a', to: 'b', text: 'go' }],
  cron: null,
  ...over,
});

/** 校验失败时的错误文案（通过时给空串，比较用）。 */
const errorOf = (d: OrchDraft): string => {
  const res = validateDraft(d);
  return res.ok ? '' : res.error;
};

const sessionNode = (id: string) => ({ id, kind: 'session' as const });
const webhookNode = (id = 'w:1') => ({ id, kind: 'webhook' as const });

describe('orchestration draft editing', () => {
  it('加会话节点 / webhook 节点；删节点连带它的边', () => {
    const withHook = addWebhookNode(draft({ edges: [] }));
    expect(withHook.nodes).toHaveLength(3);
    expect(withHook.nodes[2]!.kind).toBe('webhook');
    expect(withHook.nodes[2]!.id.startsWith('w:')).toBe(true);

    const added = addSessionNode(withHook, 'c');
    expect(added.nodes.map((n) => n.id)).toEqual(['a', 'b', withHook.nodes[2]!.id, 'c']);

    const removed = removeNode(draft(), 'a');
    expect(removed.nodes).toEqual([sessionNode('b')]);
    expect(removed.edges).toEqual([]);
  });

  it('加边生成短 id，成环由校验拦住', () => {
    const withBack = addEdge(draft(), 'b', 'a', 'back');
    expect(withBack.edges.map((e) => e.id)).toEqual(['a->b', 'e2']);
    expect(validateDraft(withBack)).toEqual({
      ok: false,
      error: 'Cycle detected: a → b → a',
    });
  });

  it('边 id 不随会话 id 长度伸缩（UUID 两端也顶不破服务端 64 上限）', () => {
    const a = 'e62f6fa7-8c10-4a51-acd5-4f7fd56a0112';
    const b = '9c05d2f1-3b47-4c6a-8d21-0f5e9a8b7c6d';
    const next = addEdge(
      draft({ nodes: [sessionNode(a), sessionNode(b)], edges: [] }),
      a,
      b,
      '',
    );
    const id = next.edges[0]!.id;
    expect(id.length).toBeLessThanOrEqual(64); // 服务端 zod：edge id max(64)
  });
});

describe('orchestration graph helpers', () => {
  it('graphDirections：入口 = 无入边，出口 = 无出边', () => {
    const nodes = [sessionNode('a'), sessionNode('b'), webhookNode()];
    const edges = [
      { id: 'w->a', from: 'w:1', to: 'a', text: '' },
      { id: 'a->b', from: 'a', to: 'b', text: '' },
    ];
    const { entries, exits } = graphDirections(nodes, edges);
    expect(entries.map((n) => n.id)).toEqual(['w:1']);
    expect(exits.map((n) => n.id)).toEqual(['b']);
  });

  it('findCycle 返回环路径（无环 null）', () => {
    const edges = [
      { id: '1', from: 'a', to: 'b', text: '' },
      { id: '2', from: 'b', to: 'c', text: '' },
      { id: '3', from: 'c', to: 'b', text: '' },
    ];
    const nodes = [sessionNode('a'), sessionNode('b'), sessionNode('c')];
    expect(findCycle(nodes, edges)).toEqual(['b', 'c', 'b']);
    expect(findCycle(nodes, [edges[0]!])).toBeNull();
  });

  it('孤立 session 节点 = 自成入口的平凡编排（合法）', () => {
    expect(validateDraft(draft({ nodes: [sessionNode('a')], edges: [] }))).toEqual({ ok: true });
  });

  it('ranksOf 按最长路径分层（多源入口都是第 0 层）', () => {
    const nodes = [sessionNode('a'), sessionNode('b'), sessionNode('c'), sessionNode('d')];
    const edges = [
      { id: '1', from: 'a', to: 'b', text: '' },
      { id: '2', from: 'a', to: 'c', text: '' },
      { id: '3', from: 'b', to: 'd', text: '' },
      { id: '4', from: 'c', to: 'd', text: '' },
    ];
    const ranks = ranksOf(nodes, edges);
    expect([ranks.get('a'), ranks.get('b'), ranks.get('c'), ranks.get('d')]).toEqual([0, 1, 1, 2]);
  });
});

describe('validateDraft', () => {
  it('通过一份合法图', () => {
    expect(validateDraft(draft())).toEqual({ ok: true });
  });

  it('节点越界、重边都被拒', () => {
    expect(errorOf(draft({ edges: [{ id: '1', from: 'a', to: 'x', text: '' }] }))).toContain(
      'outside the node set',
    );
    const dup = draft({
      edges: [
        { id: '1', from: 'a', to: 'b', text: '' },
        { id: '2', from: 'a', to: 'b', text: '' },
      ],
    });
    expect(errorOf(dup)).toContain('Duplicate edge');
  });

  it('空正文只在 webhook 入口的出边上放行', () => {
    expect(errorOf(draft({ edges: [{ id: 'a->b', from: 'a', to: 'b', text: ' ' }] }))).toContain(
      'has no message',
    );
    expect(
      validateDraft(
        draft({
          nodes: [webhookNode(), sessionNode('a')],
          edges: [{ id: 'w->a', from: 'w:1', to: 'a', text: '' }],
        }),
      ),
    ).toEqual({ ok: true });
  });

  it('webhook 节点：两端形状与出口 URL 判据', () => {
    // 同时有入边和出边 = 中间节点，拒。
    expect(
      errorOf(
        draft({
          nodes: [sessionNode('a'), sessionNode('b'), sessionNode('c'), webhookNode()],
          edges: [
            { id: '1', from: 'a', to: 'b', text: 'go' },
            { id: '2', from: 'b', to: 'w:1', text: 'go' },
            { id: '3', from: 'w:1', to: 'c', text: 'go' },
          ],
        }),
      ),
    ).toContain('both inbound and outbound');
    // 出口缺合法 URL，拒。
    expect(
      errorOf(
        draft({
          nodes: [sessionNode('a'), webhookNode()],
          edges: [{ id: '1', from: 'a', to: 'w:1', text: 'go' }],
        }),
      ),
    ).toContain('http(s)');
    // 出口给了合法 URL，过。
    expect(
      validateDraft(
        draft({
          nodes: [sessionNode('a'), { id: 'w:1', kind: 'webhook', url: 'https://example.com/hook' }],
          edges: [{ id: '1', from: 'a', to: 'w:1', text: 'go' }],
        }),
      ),
    ).toEqual({ ok: true });
  });
});
