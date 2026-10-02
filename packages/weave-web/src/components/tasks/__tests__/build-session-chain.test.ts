import { describe, it, expect } from 'vitest';
import { buildSessionChain, MAX_EVENT_NODES } from '../build-session-chain';
import type { HookDispatch, HookEventRow, HookRule } from '@/lib/api';

const rule = (id: string, handlerType: 'inject' | 'manual' | 'log' | 'webhook'): HookRule => ({
  id,
  name: `规则-${id}`,
  enabled: true,
  priority: 0,
  projectId: null,
  source: { kind: 'claude-event', event: 'PostToolUse' },
  filter: {},
  handler:
    handlerType === 'inject'
      ? { type: 'inject', template: 'x' }
      : handlerType === 'manual'
        ? { type: 'manual', template: 'x' }
        : handlerType === 'webhook'
          ? { type: 'webhook', url: 'https://x.dev/h' }
          : { type: 'log' },
  timeoutMs: 10_000,
  record: true,
  origin: 'user',
  pluginId: null,
});

const event = (id: number, eventType = 'PostToolUse'): HookEventRow => ({
  id,
  projectId: 1,
  source: 'claude',
  eventType,
  sessionId: 's1',
  payload: JSON.stringify({ toolName: 'Edit' }),
  createdAt: new Date(1_700_000_000_000 + id * 1000).toISOString(),
});

const dispatch = (over: Partial<HookDispatch>): HookDispatch => ({
  id: over.id ?? 1,
  ruleId: over.ruleId ?? 'r-inject',
  eventId: over.eventId ?? null,
  sessionId: 's1',
  prompt: 'p',
  status: over.status ?? 'pending',
  mode: 'manual',
  output: null,
  error: null,
  startedAt: new Date(1_700_000_000_000).toISOString(),
  finishedAt: null,
});

describe('buildSessionChain', () => {
  const rules = [rule('r-inject', 'inject'), rule('r-manual', 'manual'), rule('r-log', 'log')];

  it('事件 → 合并规则（hits/同行错开）→ 处理器去重 → 派发节点与边', () => {
    const events = [event(1), event(2, 'Stop')];
    const dispatches = [
      dispatch({ id: 11, ruleId: 'r-inject', eventId: 1, status: 'injected' }),
      dispatch({ id: 12, ruleId: 'r-manual', eventId: 1 }),
      dispatch({ id: 13, ruleId: 'r-inject', eventId: 2 }), // 同规则第二次命中
    ];
    const { nodes, edges, truncated } = buildSessionChain({ events, dispatches, rules });

    expect(truncated).toBe(false);
    const byId = new Map(nodes.map((n) => [n.id, n]));

    // 事件节点
    expect(byId.has('ev:1')).toBe(true);
    expect(byId.has('ev:2')).toBe(true);

    // 规则合并：r-inject hits=2；r1/r2 同在事件行 0 → 错开 ±28
    const rInject = byId.get('rule:r-inject')!;
    expect((rInject.data as { hits: number }).hits).toBe(2);
    const rManual = byId.get('rule:r-manual')!;
    expect(rInject.position.y).not.toBe(rManual.position.y);
    expect(Math.abs(rInject.position.y - rManual.position.y)).toBe(56);

    // 处理器按 type 去重（log 无命中不出现）
    expect(byId.has('h:inject')).toBe(true);
    expect(byId.has('h:manual')).toBe(true);
    expect(byId.has('h:log')).toBe(false);

    // 派发节点
    expect(byId.has('d:11')).toBe(true);
    expect(byId.has('d:13')).toBe(true);

    // 边：事件→规则、规则→处理器、处理器→派发
    const edgeIds = new Set(edges.map((e) => e.id));
    expect(edgeIds.has('e:ev1->rule:r-inject')).toBe(true);
    expect(edgeIds.has('e:ev1->rule:r-manual')).toBe(true);
    expect(edgeIds.has('e:ev2->rule:r-inject')).toBe(true);
    expect(edgeIds.has('e:rule:r-inject->h:inject')).toBe(true);
    expect(edgeIds.has('e:h:inject->d:11')).toBe(true);
    expect(edgeIds.has('e:h:manual->d:12')).toBe(true);

    // 事件边携带定位数据（SSE 动效用）
    const hit = edges.find((e) => e.id === 'e:ev1->rule:r-inject')!;
    expect(hit.data).toMatchObject({ ruleId: 'r-inject', eventId: 1 });
  });

  it('无 dispatch 的事件保留孤立节点；规则已删的派发画节点但无规则边', () => {
    const events = [event(1), event(2)];
    const dispatches = [
      dispatch({ id: 21, ruleId: 'deleted-rule', eventId: 2, status: 'failed' }),
      dispatch({ id: 22, ruleId: 'r-manual', eventId: null }), // 孤儿（手工 resume）
    ];
    const { nodes, edges } = buildSessionChain({ events, dispatches, rules });
    const byId = new Map(nodes.map((n) => [n.id, n]));

    expect(byId.has('ev:1')).toBe(true); // 孤立事件保留
    expect(byId.has('rule:deleted-rule')).toBe(false);
    expect(byId.has('d:21')).toBe(true); // 派发仍画
    expect((byId.get('d:21')!.data as { ruleName: string | null }).ruleName).toBeNull();
    expect(byId.has('d:22')).toBe(true); // 孤儿挂行末

    expect(edges.some((e) => e.source === 'ev:2' && e.target.includes('deleted-rule'))).toBe(false);
    // 孤儿派发无 rule 节点 → 无 handler 边
    expect(edges.some((e) => e.target === 'd:22')).toBe(false);
  });

  it('事件超上限截断并置 truncated', () => {
    const events = Array.from({ length: MAX_EVENT_NODES + 5 }, (_, i) => event(i + 1));
    const { nodes, truncated } = buildSessionChain({ events, dispatches: [], rules });
    expect(truncated).toBe(true);
    expect(nodes.filter((n) => n.type === 'event')).toHaveLength(MAX_EVENT_NODES);
  });

  it('同事件同规则多条派发只产生一条事件→规则边（去重）', () => {
    const events = [event(1)];
    const dispatches = [
      dispatch({ id: 31, ruleId: 'r-inject', eventId: 1 }),
      dispatch({ id: 32, ruleId: 'r-inject', eventId: 1 }),
    ];
    const { edges, nodes } = buildSessionChain({ events, dispatches, rules });
    expect(edges.filter((e) => e.id === 'e:ev1->rule:r-inject')).toHaveLength(1);
    expect(nodes.filter((n) => n.type === 'dispatch')).toHaveLength(2);
  });
});
