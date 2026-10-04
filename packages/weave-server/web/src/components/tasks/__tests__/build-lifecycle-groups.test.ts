import { describe, it, expect } from 'vitest';
import { buildLifecycleGroups, PRE_SESSION_GROUP_ID, ORPHAN_GROUP_ID } from '../build-lifecycle-groups';
import { HARNESS_LIFECYCLE } from '../lifecycle';
import type { HookDispatch, HookEventRow } from '@/lib/api';

const claude = HARNESS_LIFECYCLE.claude;

const event = (id: number, eventType = 'PreToolUse', payload = '{}'): HookEventRow => ({
  id,
  projectId: 1,
  source: 'claude',
  eventType,
  sessionId: 's1',
  payload,
  createdAt: new Date(1_700_000_000_000 + id * 1000).toISOString(),
});

const promptEvent = (id: number, prompt: string): HookEventRow =>
  event(id, 'UserPromptSubmit', JSON.stringify({ raw: { prompt } }));

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

describe('buildLifecycleGroups', () => {
  it('① 无 Stop 的中断 turn：下个开组事件 / SessionEnd / 事件尾关组并 open:true', () => {
    // 下个 UserPromptSubmit + SessionEnd 双边界
    const groups = buildLifecycleGroups(
      [promptEvent(1, '在吗'), event(2), event(3, 'SessionEnd'), promptEvent(4, '继续'), event(5, 'Stop')],
      [],
      claude,
    );
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ id: 'turn:1', open: true, prompt: '在吗' });
    expect(groups[0]!.events.map((e) => e.id)).toEqual([1, 2, 3]);
    expect(groups[1]).toMatchObject({ id: 'turn:4' });
    expect(groups[1]!.open).toBeUndefined(); // Stop 正常结束
    expect(groups[1]!.events.map((e) => e.id)).toEqual([4, 5]);

    // 事件尾边界
    const tail = buildLifecycleGroups([promptEvent(1, 'hi'), event(2)], [], claude);
    expect(tail).toHaveLength(1);
    expect(tail[0]).toMatchObject({ id: 'turn:1', open: true });
  });

  it('② 首 prompt 前散事件 → preSession 伪组（无 prompt，标题素材=事件名）', () => {
    const groups = buildLifecycleGroups(
      [event(1, 'SessionStart'), event(2, 'Notification'), promptEvent(3, '开工'), event(4, 'Stop')],
      [],
      claude,
    );
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ id: PRE_SESSION_GROUP_ID, preSession: true });
    expect(groups[0]!.prompt).toBeUndefined();
    expect(groups[0]!.events.map((e) => e.eventType)).toEqual(['SessionStart', 'Notification']);
    expect(groups[1]!.id).toBe('turn:3');
  });

  it('③ SubagentStop 不独立成组：留在组内并计数', () => {
    const groups = buildLifecycleGroups(
      [promptEvent(1, 'p'), event(2), event(3, 'SubagentStop'), event(4, 'SubagentStop'), event(5, 'Stop')],
      [],
      claude,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]!.events.map((e) => e.id)).toEqual([1, 2, 3, 4, 5]);
    expect(groups[0]!.subagentStops).toBe(2);
  });

  it('④ dispatch 按 eventId 归组；null 与窗口外 → orphan 游离组单列', () => {
    const groups = buildLifecycleGroups(
      [promptEvent(1, 'a'), event(2), promptEvent(3, 'b'), event(4, 'Stop')],
      [
        dispatch({ id: 11, eventId: 2 }),
        dispatch({ id: 12, eventId: 3 }),
        dispatch({ id: 13, eventId: null }), // 手工 resume
        dispatch({ id: 14, eventId: 999 }), // 事件在最新窗口外
      ],
      claude,
    );
    expect(groups.map((g) => g.id)).toEqual(['turn:1', 'turn:3', ORPHAN_GROUP_ID]);
    expect(groups[0]!.dispatches.map((d) => d.id)).toEqual([11]);
    expect(groups[1]!.dispatches.map((d) => d.id)).toEqual([12]);
    const orphan = groups[2]!;
    expect(orphan.dispatches.map((d) => d.id)).toEqual([13, 14]);
    expect(orphan.events).toEqual([]);
    expect(orphan.preSession).toBeUndefined();
    expect(orphan.open).toBeUndefined();
  });

  it('⑤ SessionStart/SessionEnd 只作标记不切组', () => {
    // 首 prompt 前 SessionStart 归引导组；收尾 SessionEnd 追加进已关组，不新开组
    const groups = buildLifecycleGroups(
      [event(1, 'SessionStart'), promptEvent(2, 'p'), event(3, 'Stop'), event(4, 'SessionEnd')],
      [],
      claude,
    );
    expect(groups.map((g) => g.id)).toEqual([PRE_SESSION_GROUP_ID, 'turn:2']);
    expect(groups[1]!.events.map((e) => e.eventType)).toEqual(['UserPromptSubmit', 'Stop', 'SessionEnd']);
    expect(groups[1]!.open).toBeUndefined(); // 标记不把正常结束改成中断

    // open 组遇会话标记按中断关组（SessionEnd 属①边界；中途 resume 的 SessionStart 同理）
    const mid = buildLifecycleGroups([promptEvent(1, 'p'), event(2, 'SessionStart')], [], claude);
    expect(mid).toHaveLength(1);
    expect(mid[0]).toMatchObject({ open: true });
    expect(mid[0]!.events.map((e) => e.id)).toEqual([1, 2]);
  });

  it('表驱动：注入非 claude 表按表分组，claude 事件名不被硬编码识别', () => {
    const synthetic = {
      open: 'TurnOpen',
      close: ['TurnClose'],
      sessionMarkers: ['EpochStart', 'EpochEnd'],
      subagentStop: 'ChildDone',
    } as const;
    const groups = buildLifecycleGroups(
      [
        event(1, 'SessionStart'), // claude 标记名 → 表外，仅作散事件
        event(2, 'TurnOpen'),
        event(3, 'SubagentStop'), // claude 子代理名 → 表外，不计数
        event(4, 'ChildDone'),
        event(5, 'TurnClose'),
      ],
      [],
      synthetic,
    );
    expect(groups.map((g) => g.id)).toEqual([PRE_SESSION_GROUP_ID, 'turn:2']);
    expect(groups[1]!.events.map((e) => e.id)).toEqual([2, 3, 4, 5]);
    expect(groups[1]!.subagentStops).toBe(1); // 只认表内的 ChildDone
    expect(groups[1]!.open).toBeUndefined(); // 只认表内的 TurnClose
    expect(groups[0]!.events.map((e) => e.id)).toEqual([1]);
  });

  it('prompt 取 payload.raw.prompt；缺失/坏 payload 无 prompt 字段', () => {
    const withPrompt = buildLifecycleGroups([promptEvent(1, '修复登录'), event(2, 'Stop')], [], claude);
    expect(withPrompt[0]!.prompt).toBe('修复登录');

    const bare = buildLifecycleGroups([event(1, 'UserPromptSubmit'), event(2, 'Stop')], [], claude);
    expect('prompt' in bare[0]!).toBe(false);

    const broken = buildLifecycleGroups(
      [event(1, 'UserPromptSubmit', 'not-json'), event(2, 'Stop')],
      [],
      claude,
    );
    expect('prompt' in broken[0]!).toBe(false);
  });

  it('并发：新 prompt 不提前关旧组——旧组等自己的 Stop（按 prompt_id 归属）才正常结束', () => {
    const pid = (id: number, p: string): HookEventRow =>
      event(id, 'PreToolUse', JSON.stringify({ raw: { prompt_id: p } }));
    const ups = (id: number, p: string): HookEventRow =>
      event(id, 'UserPromptSubmit', JSON.stringify({ raw: { prompt_id: p, prompt: `P-${p}` } }));
    const stop = (id: number, p: string): HookEventRow =>
      event(id, 'Stop', JSON.stringify({ raw: { prompt_id: p } }));

    // A 执行中用户提前提交 B：Stop_A 晚于 UPS_B 到达
    const groups = buildLifecycleGroups(
      [ups(1, 'A'), pid(2, 'A'), ups(3, 'B'), pid(4, 'B'), pid(5, 'A'), stop(6, 'A'), stop(7, 'B')],
      [],
      claude,
    );
    expect(groups.map((g) => g.id)).toEqual(['turn:1', 'turn:3']);
    const a = groups[0]!;
    const b = groups[1]!;
    expect(a.events.map((e) => e.id)).toEqual([1, 2, 5, 6]); // Stop_A 精确归回 A 组
    expect(b.events.map((e) => e.id)).toEqual([3, 4, 7]);
    expect(a.promptId).toBe('A');
    // 等到了自己的 Stop = 正常结束，不误标「未正常结束」
    expect(a.open).toBeUndefined();
    expect(b.open).toBeUndefined();
  });

  it('并发中断：旧组始终没等到自己的 Stop → 才标未正常结束', () => {
    const ups = (id: number, p: string): HookEventRow =>
      event(id, 'UserPromptSubmit', JSON.stringify({ raw: { prompt_id: p } }));
    const stop = (id: number, p: string): HookEventRow =>
      event(id, 'Stop', JSON.stringify({ raw: { prompt_id: p } }));

    const groups = buildLifecycleGroups([ups(1, 'A'), ups(2, 'B'), stop(3, 'B')], [], claude);
    expect(groups.map((g) => g.id)).toEqual(['turn:1', 'turn:2']);
    expect(groups[0]).toMatchObject({ open: true }); // A 没有 Stop → 未正常结束
    expect(groups[1]!.open).toBeUndefined(); // B 正常
  });

  it('派发子代理：PostToolUse.agentId 计入 agentsDispatched 并登记归组锚', () => {
    const dispatch = (id: number, agentId: string, toolUseId: string): HookEventRow =>
      event(
        id,
        'PostToolUse',
        JSON.stringify({
          toolResponse: { isAsync: true, agentId, resolvedModel: 'm1' },
          raw: { tool_use_id: toolUseId },
        }),
      );
    const groups = buildLifecycleGroups(
      [promptEvent(1, '派发'), dispatch(2, 'agent-x', 'call-1'), event(3, 'Stop')],
      [],
      claude,
    );
    expect(groups[0]!.agentsDispatched).toBe(1);
    expect(groups[0]!.agentsDispatched).toBeDefined();
  });

  it('task-notification 不开新组：按 tool-use-id 归回派发所在组（与原事件闭环）', () => {
    const dispatch = (id: number, agentId: string, toolUseId: string): HookEventRow =>
      event(
        id,
        'PostToolUse',
        JSON.stringify({
          toolResponse: { isAsync: true, agentId, resolvedModel: 'm1' },
          raw: { tool_use_id: toolUseId },
        }),
      );
    const notif = (id: number, agentId: string, toolUseId: string): HookEventRow =>
      event(
        id,
        'UserPromptSubmit',
        JSON.stringify({
          raw: {
            prompt: `<task-notification>\n<task-id>${agentId}</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<status>completed</status>\n</task-notification>`,
          },
        }),
      );
    // 派发在 turn:1；通知晚到（甚至在下一轮之后）也归回 turn:1，不开「通知 prompt」组
    const groups = buildLifecycleGroups(
      [
        promptEvent(1, '派发'),
        dispatch(2, 'agent-x', 'call-1'),
        event(3, 'Stop'),
        promptEvent(4, '下一轮'),
        notif(5, 'agent-x', 'call-1'),
        event(6, 'Stop'),
      ],
      [],
      claude,
    );
    expect(groups.map((g) => g.id)).toEqual(['turn:1', 'turn:4']); // 通知不成组
    expect(groups[0]!.events.map((e) => e.id)).toEqual([1, 2, 3, 5]); // 归回派发组
    expect(groups[1]!.events.map((e) => e.id)).toEqual([4, 6]);
    expect(groups[1]!.prompt).toBe('下一轮'); // 组头不被 XML 污染
  });

  it('task-notification 匹配不到派发（窗口外）：回落挂靠仍不开组', () => {
    const orphanNotif = event(
      2,
      'UserPromptSubmit',
      JSON.stringify({
        raw: { prompt: '<task-notification>\n<task-id>ghost</task-id>\n</task-notification>' },
      }),
    );
    const groups = buildLifecycleGroups([promptEvent(1, 'hi'), orphanNotif, event(3, 'Stop')], [], claude);
    expect(groups).toHaveLength(1); // 不因通知多出一组
    expect(groups[0]!.events.map((e) => e.id)).toEqual([1, 2, 3]);
    expect(groups[0]!.prompt).toBe('hi');
  });
});
