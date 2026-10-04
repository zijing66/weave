import { describe, it, expect } from 'vitest';
import type { HookDispatch, HookEventRow } from '@/lib/api';
import type { LifecycleGroup } from '@/components/tasks/build-lifecycle-groups';
import { layoutMindmap } from './LifecycleMindmap';

const ev = (id: number, eventType = 'PostToolUse'): HookEventRow => ({
  id,
  projectId: 1,
  source: 'claude',
  eventType,
  sessionId: 's1',
  payload: '{}',
  createdAt: '2026-10-04T10:00:00.000Z',
});

const dispatch = (id: number, eventId: number | null, status: HookDispatch['status'] = 'pending'): HookDispatch => ({
  id,
  ruleId: 'r1',
  eventId,
  sessionId: null,
  prompt: 'do it',
  status,
  mode: 'auto',
  output: null,
  error: null,
  startedAt: '2026-10-04T10:00:01.000Z',
  finishedAt: null,
});

const group = (over: Partial<LifecycleGroup>): LifecycleGroup => ({
  id: 'turn:1',
  events: [],
  dispatches: [],
  subagentStops: 0,
  ...over,
});

describe('layoutMindmap', () => {
  it('折叠态：每组一个 depth0 节点，叶子 y 顺序占槽', () => {
    const groups = [
      group({ id: 'turn:1', events: [ev(1, 'UserPromptSubmit')] }),
      group({ id: 'turn:2', events: [ev(3, 'UserPromptSubmit')] }),
    ];
    const { nodes, edges } = layoutMindmap(groups, new Set());
    expect(nodes).toHaveLength(2);
    expect(nodes.every((n) => n.depth === 0)).toBe(true);
    expect(nodes.map((n) => n.y)).toEqual([0, 84]);
    expect(edges).toHaveLength(0);
  });

  it('展开组：事件子节点 depth1，父节点 y 取子中点', () => {
    const groups = [
      group({
        id: 'turn:1',
        events: [ev(1, 'UserPromptSubmit'), ev(2), ev(3, 'Stop')],
      }),
    ];
    const { nodes, edges } = layoutMindmap(groups, new Set(['g:turn:1']));
    const root = nodes.find((n) => n.key === 'g:turn:1')!;
    const kids = nodes.filter((n) => n.depth === 1);
    expect(kids).toHaveLength(3);
    expect(root.y).toBe((kids[0].y + kids[2].y) / 2);
    expect(edges.map((e) => e.id)).toEqual([
      'g:turn:1->e:1',
      'g:turn:1->e:2',
      'g:turn:1->e:3',
    ]);
  });

  it('展开事件挂指令，展开指令出执行详情：depth 逐层 +1', () => {
    const groups = [
      group({
        id: 'turn:1',
        events: [ev(1), ev(2)],
        dispatches: [dispatch(10, 1)],
      }),
    ];
    const { nodes } = layoutMindmap(groups, new Set(['g:turn:1', 'e:1']));
    expect(nodes.find((n) => n.key === 'd:10')?.depth).toBe(2);
    const { nodes: deeper } = layoutMindmap(
      groups,
      new Set(['g:turn:1', 'e:1', 'd:10']),
    );
    expect(deeper.find((n) => n.key === 'd:10:detail')?.depth).toBe(3);
  });

  it('pending 指令路径高光沿 event → group 回传', () => {
    const groups = [
      group({
        id: 'turn:1',
        events: [ev(1), ev(2)],
        dispatches: [dispatch(10, 2, 'pending'), dispatch(11, 1, 'succeeded')],
      }),
    ];
    const { nodes } = layoutMindmap(groups, new Set(['g:turn:1', 'e:1', 'e:2']));
    expect(nodes.find((n) => n.key === 'd:10')?.highlight).toBe(true);
    expect(nodes.find((n) => n.key === 'e:2')?.highlight).toBe(true);
    expect(nodes.find((n) => n.key === 'g:turn:1')?.highlight).toBe(true);
    // succeeded 不高光、其父事件不染
    expect(nodes.find((n) => n.key === 'd:11')?.highlight).toBe(false);
    expect(nodes.find((n) => n.key === 'e:1')?.highlight).toBe(false);
  });

  it('游离指令组（无事件）：指令直挂 prompt 根下 depth1', () => {
    const groups = [group({ id: 'orphan', dispatches: [dispatch(10, null)] })];
    const { nodes } = layoutMindmap(groups, new Set(['g:orphan']));
    expect(nodes.find((n) => n.key === 'd:10')?.depth).toBe(1);
  });
});
