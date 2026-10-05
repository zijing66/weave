import { describe, it, expect } from 'vitest';
import type { HookDispatch, HookEventRow } from '@/lib/api';
import { summarizeEvent } from '@/lib/hook-payload';
import type { LifecycleGroup } from '@/components/tasks/build-lifecycle-groups';
import { layoutMindmap } from './LifecycleMindmap';

const ev = (id: number, eventType = 'PostToolUse', payload = '{}'): HookEventRow => ({
  id,
  projectId: 1,
  source: 'claude',
  eventType,
  sessionId: 's1',
  payload,
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
  agentsDispatched: 0,
  ...over,
});

/** 派发证据事件：PostToolUse + toolResponse.agentId（异步子代理）。 */
const dispatchEv = (
  id: number,
  agentId: string,
  toolUseId: string,
  model = 'mimo-v2.6-flash',
): HookEventRow =>
  ev(
    id,
    'PostToolUse',
    JSON.stringify({
      toolResponse: { isAsync: true, status: 'async_launched', agentId, resolvedModel: model },
      raw: { tool_use_id: toolUseId },
    }),
  );

/** SubagentStop（agent_id 归属派发）。 */
const subStop = (id: number, agentId: string): HookEventRow =>
  ev(id, 'SubagentStop', JSON.stringify({ raw: { agent_id: agentId } }));

/** task-notification（UserPromptSubmit 携带子代理返回 XML）。 */
const notif = (id: number, agentId: string, toolUseId: string): HookEventRow =>
  ev(
    id,
    'UserPromptSubmit',
    JSON.stringify({
      raw: {
        prompt: `<task-notification>\n<task-id>${agentId}</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<status>completed</status>\n<summary>Agent "x" finished</summary>\n</task-notification>`,
      },
    }),
  );

describe('layoutMindmap', () => {
  it('折叠态：每组一个 depth0 节点，叶子 y 顺序占槽', () => {
    const groups = [
      group({ id: 'turn:1', events: [ev(1, 'UserPromptSubmit')] }),
      group({ id: 'turn:2', events: [ev(3, 'UserPromptSubmit')] }),
    ];
    const { nodes, edges } = layoutMindmap(groups, new Set());
    expect(nodes).toHaveLength(2);
    expect(nodes.every((n) => n.depth === 0)).toBe(true);
    expect(nodes.map((n) => n.y)).toEqual([0, 128]); // ROW_H=128（行距大于节点高，DAG 连线可见）
    expect(edges).toHaveLength(0);
  });

  it('展开组：事件子节点 depth1，父节点 y 取子中点；组内时序链 + 闭环回边', () => {
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
    // 实际调用顺序成链（非放射 DAG）+ 末事件闭环回根（一次 prompt 完成闭环）
    expect(edges.map((e) => e.id)).toEqual([
      'g:turn:1->e:1',
      'e:1->e:2',
      'e:2->e:3',
      'e:3->g:turn:1',
    ]);
    expect(edges.find((e) => e.id === 'e:3->g:turn:1')?.closure).toBe(true);
  });

  it('命中链层级：事件 → 规则 → 指令（明细走点击面板，指令为叶子）；已知类型时插入处理器层', () => {
    const groups = [
      group({
        id: 'turn:1',
        events: [ev(1), ev(2)],
        dispatches: [dispatch(10, 1)],
      }),
    ];
    // ruleInfo 缺省：跳过处理器层，event(1) → rule(2) → dispatch(3)
    const { nodes } = layoutMindmap(groups, new Set(['g:turn:1', 'e:1']));
    expect(nodes.find((n) => n.key === 'e:1:r:r1')?.depth).toBe(2);
    expect(nodes.find((n) => n.key === 'd:10')?.depth).toBe(3);
    // 无 detail 子层：指令是叶子、无折叠按钮；有/无触发指令决定事件的折叠按钮
    expect(nodes.find((n) => n.key === 'd:10')?.expandable).toBe(false);
    expect(nodes.find((n) => n.key === 'e:1')?.expandable).toBe(true);
    expect(nodes.find((n) => n.key === 'e:2')?.expandable).toBe(false);

    // 已知 handler 类型：rule 与 dispatch 之间插入 handler 层
    const info = new Map([['r1', { name: '规则一', handlerType: 'inject' }]]);
    const { nodes: withHandler } = layoutMindmap(groups, new Set(['g:turn:1', 'e:1']), info);
    expect(withHandler.find((n) => n.key === 'e:1:r:r1:h')?.kind).toBe('handler');
    expect(withHandler.find((n) => n.key === 'e:1:r:r1:h')?.depth).toBe(3);
    expect(withHandler.find((n) => n.key === 'd:10')?.depth).toBe(4);
    expect(withHandler.find((n) => n.key === 'e:1:r:r1')?.ruleName).toBe('规则一');
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

  it('SubagentStop 是时序前驱的分叉子节点（depth+1），不再与主链事件并列', () => {
    const groups = [
      group({
        id: 'turn:1',
        events: [ev(1, 'UserPromptSubmit'), ev(2, 'PostToolUse'), ev(3, 'SubagentStop')],
      }),
    ];
    const { nodes, edges } = layoutMindmap(groups, new Set(['g:turn:1']));
    const sub = nodes.find((n) => n.key === 'e:3')!;
    expect(sub.kind).toBe('subagent');
    // 分叉：挂在时序前驱 e:2 下（depth = 前驱 +1），不进主链
    expect(sub.depth).toBe(2);
    // 主链（不含 SubagentStop）+ 闭环回根 + 分叉边（walk 先生成，顺序不作断言）
    expect(new Set(edges.map((e) => e.id))).toEqual(
      new Set(['g:turn:1->e:1', 'e:1->e:2', 'e:2->g:turn:1', 'e:2->e:3']),
    );
    // 无触发指令的子代理是叶子——不给折叠按钮（明细点节点看）
    expect(sub.expandable).toBe(false);
  });

  it('连续 Pre/PostToolUse 折成簇默认收起，展开还原成员时序竖链', () => {
    const groups = [
      group({
        id: 'turn:1',
        events: [
          ev(1, 'UserPromptSubmit'),
          ev(2, 'PreToolUse'),
          ev(3, 'PostToolUse'),
          ev(4, 'PreToolUse'),
          ev(5, 'PostToolUse'),
          ev(6, 'Stop'),
        ],
      }),
    ];
    // 收起态：主链 = 根 → e:1 → 簇 c:2 → e:6 → 根（成员不占位）
    const collapsed = layoutMindmap(groups, new Set(['g:turn:1']));
    const cluster = collapsed.nodes.find((n) => n.key === 'c:2')!;
    expect(cluster.kind).toBe('cluster');
    expect(cluster.depth).toBe(1);
    expect(cluster.expandable).toBe(true);
    expect(cluster.expanded).toBe(false);
    expect(cluster.clusterEvents?.map((e) => e.id)).toEqual([2, 3, 4, 5]);
    expect(collapsed.nodes.some((n) => n.key === 'e:2')).toBe(false);
    expect(new Set(collapsed.edges.map((e) => e.id))).toEqual(
      new Set(['g:turn:1->e:1', 'e:1->c:2', 'c:2->e:6', 'e:6->g:turn:1']),
    );

    // 展开态：成员回树（depth2）+ 簇→成员竖链（时序，vertical）
    const open = layoutMindmap(groups, new Set(['g:turn:1', 'c:2']));
    expect(open.nodes.find((n) => n.key === 'e:2')?.depth).toBe(2);
    expect(
      open.nodes.filter((n) => ['e:2', 'e:3', 'e:4', 'e:5'].includes(n.key)),
    ).toHaveLength(4);
    expect(new Set(open.edges.map((e) => e.id))).toEqual(
      new Set([
        'g:turn:1->e:1',
        'e:1->c:2',
        'c:2->e:2',
        'e:2->e:3',
        'e:3->e:4',
        'e:4->e:5',
        'e:5->c:2',
        'c:2->e:6',
        'e:6->g:turn:1',
      ]),
    );
    // 首尾（簇↔子节点）虚线，子节点之间实线时序
    expect(open.edges.find((e) => e.id === 'c:2->e:2')?.dashed).toBe(true);
    expect(open.edges.find((e) => e.id === 'e:5->c:2')?.closure).toBe(true);
    expect(open.edges.find((e) => e.id === 'e:2->e:3')?.vertical).toBe(true);
    expect(open.edges.find((e) => e.id === 'e:2->e:3')?.dashed).toBeUndefined();
    // 收起态无尾回边（成员隐藏，链路保持现状）
    expect(collapsed.edges.some((e) => e.closure && e.source.startsWith('c:'))).toBe(false);
  });

  it('孤立工具事件与命中指令的工具事件不进簇', () => {
    const groups = [
      group({
        id: 'turn:1',
        events: [ev(1, 'UserPromptSubmit'), ev(2), ev(3), ev(4, 'Stop')],
        dispatches: [dispatch(10, 3)],
      }),
    ];
    const { nodes } = layoutMindmap(groups, new Set(['g:turn:1']));
    // e:3 有命中指令（业务信息）不入簇；e:2 因段被打断退化为孤立节点 → 无簇
    expect(nodes.some((n) => n.kind === 'cluster')).toBe(false);
    expect(nodes.find((n) => n.key === 'e:2')).toBeTruthy();
    expect(nodes.find((n) => n.key === 'e:3')?.expandable).toBe(true);
  });

  it('派发环：agentId 证据节点挂 SubagentStop 与 task-notification，已返回成闭环', () => {
    const groups = [
      group({
        id: 'turn:1',
        agentsDispatched: 1,
        events: [
          ev(1, 'UserPromptSubmit'),
          dispatchEv(2, 'a4b7cd62', 'call_1'),
          ev(3, 'PostToolUse'),
          subStop(4, 'a4b7cd62'),
          notif(5, 'a4b7cd62', 'call_1'),
          ev(6, 'Stop'),
        ],
      }),
    ];
    const { nodes, edges } = layoutMindmap(groups, new Set(['g:turn:1']), new Map(), 'sess-model');
    const anchor = nodes.find((n) => n.key === 'e:2')!;
    expect(anchor.agentId).toBe('a4b7cd62');
    expect(anchor.model).toBe('mimo-v2.6-flash'); // resolvedModel 显著展示
    expect(anchor.agentRunning).toBe(false); // 收到返回 → 非执行中
    // 环成员挂锚下（depth = 锚+1），不进主链
    const sub = nodes.find((n) => n.key === 'e:4')!;
    const note = nodes.find((n) => n.key === 'e:5')!;
    expect(sub.depth).toBe(anchor.depth + 1);
    expect(note.depth).toBe(anchor.depth + 1);
    expect(note.kind).toBe('notification');
    // 环链：锚→SubagentStop→notification→锚（闭环回边）
    expect(new Set(edges.map((e) => e.id))).toEqual(
      new Set([
        'g:turn:1->e:1',
        'e:1->e:2',
        'e:2->e:3',
        'e:3->e:6',
        'e:6->g:turn:1',
        'e:2->e:4',
        'e:4->e:5',
        'e:5->e:2',
      ]),
    );
    expect(edges.find((e) => e.id === 'e:5->e:2')?.closure).toBe(true);
    expect(edges.find((e) => e.id === 'e:4->e:5')?.vertical).toBe(true);
    // 组根 model tag（会话级）
    expect(nodes.find((n) => n.key === 'g:turn:1')?.model).toBe('sess-model');
  });

  it('派发环执行中：未收到 task-notification → 不画闭环', () => {
    const groups = [
      group({
        id: 'turn:1',
        open: true, // 进行中/未正常结束：没有 Stop 这一闭环事件
        events: [ev(1, 'UserPromptSubmit'), dispatchEv(2, 'a4b7cd62', 'call_1'), subStop(4, 'a4b7cd62')],
      }),
    ];
    const { nodes, edges } = layoutMindmap(groups, new Set(['g:turn:1']));
    const anchor = nodes.find((n) => n.key === 'e:2')!;
    expect(anchor.agentRunning).toBe(true);
    // 有锚→成员链，但没有 成员→锚 的闭环回边
    expect(edges.map((e) => e.id)).toContain('e:2->e:4');
    expect(edges.some((e) => e.closure && e.source === 'e:4')).toBe(false);
    // 主链同理：组 open（未等到 Stop）→ 末事件不闭环回根
    expect(edges.some((e) => e.closure && e.target === 'g:turn:1')).toBe(false);
  });

  it('派发即生子节点：环空且执行中 → 占位子代理节点挂在锚下', () => {
    const groups = [
      group({
        id: 'turn:1',
        events: [ev(1, 'UserPromptSubmit'), dispatchEv(2, 'a4b7cd62', 'call_1')],
      }),
    ];
    const { nodes, edges } = layoutMindmap(groups, new Set(['g:turn:1']));
    const ph = nodes.find((n) => n.key === 'e:2:agent')!;
    expect(ph).toMatchObject({
      kind: 'subagent',
      depth: 2, // 挂锚（depth 1）下
      agentId: 'a4b7cd62',
      model: 'mimo-v2.6-flash',
      agentRunning: true,
      expandable: false,
    });
    expect(ph.event).toBeUndefined(); // 占位——真实事件到达后替换
    // 锚 → 占位的分叉链；占位未返回 → 环上无闭环回边
    expect(edges.map((e) => e.id)).toContain('e:2->e:2:agent');
    expect(edges.some((e) => e.closure && e.source === 'e:2:agent')).toBe(false);
  });
});

describe('summarizeEvent — 按 hook 类型提取完整信息', () => {
  it('UserPromptSubmit 取 raw.prompt', () => {
    const e = ev(1, 'UserPromptSubmit', JSON.stringify({ raw: { prompt: '修复 403 报错' } }));
    expect(summarizeEvent(e)).toBe('修复 403 报错');
  });

  it('PostToolUse 展示 tool 参数与结果首行（不只路径）', () => {
    const e = ev(
      2,
      'PostToolUse',
      JSON.stringify({
        toolName: 'Bash',
        toolInput: { command: 'pnpm test\n' },
        toolResponse: { stdout: '870 passed' },
      }),
    );
    expect(summarizeEvent(e)).toBe('Bash pnpm test → 870 passed');
  });

  it('Notification 取 message；SubagentStop 取结束消息', () => {
    expect(
      summarizeEvent(
        ev(3, 'Notification', JSON.stringify({ raw: { message: 'waiting for input', notification_type: 'idle_prompt' } })),
      ),
    ).toBe('idle_prompt · waiting for input');
    expect(
      summarizeEvent(
        ev(4, 'SubagentStop', JSON.stringify({ raw: { last_assistant_message: '梳理完毕' } })),
      ),
    ).toBe('梳理完毕');
  });

  it('task-notification 取 status/summary，不展示整段 XML', () => {
    const e = notif(5, 'agent-x', 'call-1');
    expect(summarizeEvent(e)).toBe('completed · Agent "x" finished');
  });
});
