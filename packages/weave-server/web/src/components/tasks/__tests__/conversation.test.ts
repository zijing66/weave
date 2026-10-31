import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import {
  attachDeliveries,
  conversationOf,
  countdownLabel,
  editsWindowOf,
  failedTail,
  filterThread,
  isGenerating,
  queueStatusKey,
  removableOf,
  withCommands,
  withPlan,
  withNarration,
  withPreQuestion,
  readConvCache,
  writeConvCache,
  type ConvEntry,
} from '../conv-model';
import {
  buildSegments,
  cmdChipClass,
  cmdMenuMatches,
  cmdMenuShouldOpen,
  cmdQueryIn,
  commandTokensOf,
  draftSnapshotOf,
  hasRefCandidate,
  pickerIntent,
  refSigilsOf,
  serializeDraft,
  sessionPickerIntent,
  textBeforeCaret,
} from '../draft-editor';
import { imageMarkerSegments, pipePathSegments } from '../conv-model';
import { stackUnitsOf } from '../conv-stack';
import { attachedFilesFrom } from '../attach';
import { exportConversationText, exportConversationMarkdown, exportStamp } from '../conv-export';
import { HARNESS_LIFECYCLE } from '../lifecycle';
import type { HookEventRow, SessionMessageRow, UploadFile } from '@/lib/api';

const claude = HARNESS_LIFECYCLE.claude;

const at = (min: number): string => new Date(1_700_000_000_000 + min * 60_000).toISOString();

const event = (id: number, eventType: string, raw: object): HookEventRow => ({
  id,
  projectId: 1,
  source: 'claude',
  eventType,
  sessionId: 's1',
  payload: JSON.stringify({ raw }),
  createdAt: at(id),
});

const delivery = (over: Partial<SessionMessageRow>): SessionMessageRow => ({
  id: over.id ?? 'm1',
  sessionId: 's1',
  text: over.text ?? 'hi',
  mode: over.mode ?? 'prompt',
  channel: over.channel ?? 'prompt',
  via: over.via ?? 'socket',
  status: over.status ?? 'pending',
  acked: over.acked ?? null,
  ackedEventId: over.ackedEventId ?? null,
  settledAt: over.settledAt ?? null,
  stalled: over.stalled ?? null,
  output: null,
  error: over.error ?? null,
  at: over.at ?? at(10),
  ...(over.attachments ? { attachments: over.attachments } : {}),
});

describe('conversationOf', () => {
  it('① 只取开轮 prompt 与闭轮最终总结，其余事件不进对话', () => {
    const entries = conversationOf(
      [
        event(1, 'SessionStart', {}),
        event(2, 'PreToolUse', {}),
        event(3, 'UserPromptSubmit', { prompt: '把 X 改掉' }),
        event(4, 'Notification', { message: '等人批准' }),
        event(5, 'Stop', { last_assistant_message: '改完了：X→Y' }),
      ],
      claude,
    );
    expect(entries.map((e) => [e.role, e.text, e.eventId])).toEqual([
      ['user', '把 X 改掉', 3],
      ['assistant', '改完了：X→Y', 5],
    ]);
  });

  it('② 子代理返回通知不是用户消息；空 prompt / 空总结也丢', () => {
    const entries = conversationOf(
      [
        event(1, 'UserPromptSubmit', { prompt: '<task-notification><status>completed</status>' }),
        event(2, 'UserPromptSubmit', {}),
        event(3, 'Stop', { last_assistant_message: '' }),
        event(4, 'Stop', { last_assistant_message: '  有内容  ' }),
      ],
      claude,
    );
    expect(entries.map((e) => [e.role, e.text])).toEqual([['assistant', '  有内容  ']]);
  });

  it('③ 直投消息摘掉来源标记并记 fromWeave（标记不当作正文）', () => {
    const entries = conversationOf(
      [
        event(1, 'UserPromptSubmit', { prompt: '[weave] 帮我看看这个' }),
        event(2, 'UserPromptSubmit', { prompt: '终端里自己敲的' }),
      ],
      claude,
    );
    expect(entries.map((e) => [e.text, e.fromWeave])).toEqual([
      ['帮我看看这个', true],
      ['终端里自己敲的', false],
    ]);
  });

  it('④ 中继载荷：剥掉 CC 壳与壳内单向注记，正文只剩原文并记 fromWeave', () => {
    const entries = conversationOf(
      [
        event(1, 'UserPromptSubmit', {
          prompt:
            '<cross-session-message from="uds:\\\\.\\pipe\\LOCAL\\cc-msg-1" from-name="weave" from-mode="bypass">\n' +
            '[weave one-way injection — no reply is expected: do not call SendMessage or ListAgents, just act on this prompt in this session.]\n\n' +
            '重发一次\n</cross-session-message>',
        }),
      ],
      claude,
    );
    expect(entries.map((e) => [e.text, e.fromWeave, e.fromName])).toEqual([
      ['重发一次', true, 'weave'],
    ]);
  });

  it('⑤ 别的会话自己发的 CC 会话间消息：壳也剥掉，但不是 weave 发的（挂发送方名）', () => {
    const entries = conversationOf(
      [
        event(1, 'UserPromptSubmit', {
          prompt:
            '<cross-session-message from="uds:x" from-name="weave-4e" from-mode="bypass">\n' +
            '同步一下进度\n</cross-session-message>',
        }),
      ],
      claude,
    );
    expect(entries.map((e) => [e.text, e.fromWeave, e.fromName])).toEqual([
      ['同步一下进度', false, 'weave-4e'],
    ]);
  });

  it('⑥ 压缩收尾笔落成一条分隔（正文空、带 eventId）；别的 source / 别的 harness 不落', () => {
    const events = [
      event(1, 'UserPromptSubmit', { prompt: '压之前' }),
      event(2, 'SessionStart', { source: 'compact' }),
      event(3, 'SessionStart', { source: 'startup' }),
      event(4, 'SessionStart', { source: 'compact' }),
    ];
    expect(
      conversationOf(events, claude, 'claude').map((e) => [e.role, e.text, e.eventId]),
    ).toEqual([
      ['user', '压之前', 1],
      ['compaction', '', 2],
      ['compaction', '', 4],
    ]);
    // 未报 harness（老调用）与别的 harness：没有压缩概念，SessionStart 一概不进
    expect(conversationOf([event(2, 'SessionStart', { source: 'compact' })], claude)).toEqual([]);
    expect(
      conversationOf([event(2, 'SessionStart', { source: 'compact' })], claude, 'codex'),
    ).toEqual([]);
  });

  it('⑦ 压缩开始事件（PreCompact）不是收尾笔，不落分隔', () => {
    expect(
      conversationOf([event(1, 'PreCompact', { trigger: 'auto' })], claude, 'claude'),
    ).toEqual([]);
  });

  it('⑧ 失败收尾（StopFailure）仍是一轮的回答位，但要标出来（正文是宿主报的错）', () => {
    const entries = conversationOf(
      [
        event(1, 'UserPromptSubmit', { prompt: '跑一下' }),
        event(2, 'StopFailure', {
          error: 'server_error',
          last_assistant_message: 'API Error: 500 litellm.InternalServerError',
        }),
        event(3, 'UserPromptSubmit', { prompt: '再来一次' }),
        event(4, 'Stop', { last_assistant_message: '这次成了' }),
      ],
      claude,
    );
    expect(entries.map((e) => [e.role, e.text, e.failed ?? false])).toEqual([
      ['user', '跑一下', false],
      ['assistant', 'API Error: 500 litellm.InternalServerError', true],
      ['user', '再来一次', false],
      ['assistant', '这次成了', false],
    ]);
  });
});

describe('failedTail', () => {
  const fail = { key: 'e2', eventId: 2, role: 'assistant' as const, at: at(20), text: 'API Error: 500', failed: true };

  it('尾条是失败收尾 → 尾巴上显那条错（盖过「生成中…」）', () => {
    expect(failedTail([fail], false)).toBe(fail);
  });

  it('尾条是正常回答 / 没有尾条 → 不显', () => {
    expect(failedTail([{ ...fail, failed: false }], false)).toBeNull();
    expect(failedTail([], false)).toBeNull();
  });

  it('队列里还有没送出去的行 → 不显（那是上一条的错，会读成它失败了）', () => {
    expect(failedTail([fail], true)).toBeNull();
  });
});

describe('attachDeliveries', () => {
  const userEntry = { key: 'e1', eventId: 1, role: 'user' as const, at: at(10), text: 'hi' };

  it('① 同文案且时刻相近的投递行挂到该气泡上（不重复渲染）', () => {
    const { thread } = attachDeliveries(
      [userEntry],
      [delivery({ id: 'm1', text: 'hi', at: at(10), status: 'delivered', settledAt: at(10) })],
    );
    expect(thread).toHaveLength(1);
    expect(thread[0]!.pipe?.id).toBe('m1');
  });

  it('② 认领不到的（失败/暂停闸成因/还没送达）不进对话，归发送端队列面，按时刻升序', () => {
    const { thread, outbox } = attachDeliveries(
      [userEntry],
      [
        delivery({ id: 'm-late', text: '没送达的', at: at(30), status: 'failed' }),
        delivery({ id: 'm-early', text: '卡住的', at: at(20), status: 'delivered', stalled: true }),
        delivery({ id: 'm3', text: 'hi', at: at(9), status: 'delivered' }),
      ],
    );
    // e1 被最近的 m3 认领；气泡只有事件那一条，两个没认领的排进发送端
    expect(thread.map((e) => e.pipe?.id ?? e.key)).toEqual(['m3']);
    expect(outbox.map((m) => m.id)).toEqual(['m-early', 'm-late']);
  });

  it('③ 认领取时刻最近的一条（失败的旧行不抢新行的气泡）', () => {
    const { thread, outbox } = attachDeliveries(
      [userEntry],
      [
        delivery({ id: 'm-old', text: 'hi', at: at(8), status: 'failed' }),
        delivery({ id: 'm-new', text: 'hi', at: at(10), status: 'delivered', settledAt: at(10) }),
      ],
    );
    expect(thread.map((e) => e.pipe?.id ?? e.key)).toEqual(['m-new']);
    expect(outbox.map((m) => m.id)).toEqual(['m-old']);
  });

  it('④ 直投消息只出现一条：摘掉来源标记的条目认领得到它自己的投递行', () => {
    const entries = conversationOf(
      [event(1, 'UserPromptSubmit', { prompt: '[weave] 帮我看看这个' })],
      claude,
    );
    const { thread } = attachDeliveries(
      entries,
      [delivery({ id: 'm1', text: '帮我看看这个', at: at(1), status: 'delivered', settledAt: at(1) })],
    );
    expect(thread).toHaveLength(1);
    expect(thread[0]!.pipe?.id).toBe('m1');
  });

  it('⑤ 中继带壳的原文也认领得到（Claude Code 把会话间消息裹了壳，原文在里面）', () => {
    const { thread } = attachDeliveries(
      [{ ...userEntry, text: '<cross-session-message from="uds:x">hi</cross-session-message>' }],
      [delivery({ id: 'm2', text: 'hi', at: at(10), status: 'delivered', settledAt: at(10) })],
    );
    expect(thread).toHaveLength(1);
    expect(thread[0]!.pipe?.id).toBe('m2');
  });

  it('⑥ 中继投递的转录条目认领得回自己的投递行（壳+注记不是正文，否则会重复一条）', () => {
    const entries = conversationOf(
      [
        event(1, 'UserPromptSubmit', {
          prompt:
            '<cross-session-message from="uds:x" from-name="weave" from-mode="bypass">\n' +
            '[weave one-way injection — no reply is expected: do not call SendMessage or ListAgents, just act on this prompt in this session.]\n\n' +
            '帮我看看这个\n</cross-session-message>',
        }),
      ],
      claude,
    );
    const { thread } = attachDeliveries(
      entries,
      [delivery({ id: 'm1', text: '帮我看看这个', at: at(1), status: 'delivered', settledAt: at(1) })],
    );
    expect(thread).toHaveLength(1);
    expect(thread[0]!.pipe?.id).toBe('m1');
  });

  it('⑦ 短文案只认全等：「ok」不会被含着它的别的条目认走', () => {
    const { thread, outbox } = attachDeliveries(
      [{ ...userEntry, text: '好，ok，我看看' }],
      [delivery({ id: 'm3', text: 'ok', at: at(10), status: 'failed' })],
    );
    expect(thread.map((e) => e.pipe?.id ?? e.key)).toEqual(['e1']);
    expect(outbox.map((m) => m.id)).toEqual(['m3']);
  });

  it('⑧ 已送达但气泡还没来的留在队列里（「发出去了、还没落进对话」正是要显示的那段）', () => {
    const { outbox } = attachDeliveries(
      [userEntry],
      [
        delivery({ id: 'm-sent', text: '已进收件箱', at: at(20), status: 'delivered' }),
        delivery({ id: 'm-pending', text: '还在队里', at: at(21), status: 'pending' }),
        delivery({ id: 'm-blocked', text: '等回执超时', at: at(22), status: 'delivered', stalled: true }),
      ],
    );
    expect(outbox.map((m) => m.id)).toEqual(['m-sent', 'm-pending', 'm-blocked']);
  });

  it('⑨ 气泡一到它就退出队列（同一条消息只在一处露面）', () => {
    const rows = [
      delivery({ id: 'm1', text: 'hi', at: at(10), status: 'delivered', settledAt: at(10) }),
    ];
    expect(attachDeliveries([], rows).outbox.map((m) => m.id)).toEqual(['m1']);
    expect(attachDeliveries([userEntry], rows).outbox).toEqual([]);
  });

  it('⑩ 一条 UPS 核销了几条在途，它们就都归这一条气泡（合成 UPS 不能留下永久尾巴）', () => {
    const rows = [
      delivery({ id: 'm1', text: '第一句', at: at(10), status: 'delivered', acked: true, ackedEventId: 7 }),
      delivery({ id: 'm2', text: '第二句', at: at(11), status: 'delivered', acked: true, ackedEventId: 7 }),
    ];
    const entry: ConvEntry = { ...userEntry, eventId: 7, text: '第一句\n第二句' };
    expect(attachDeliveries([entry], rows).outbox).toEqual([]);
  });
});

describe('removableOf（队列里的行能不能删）', () => {
  it('① 未送达的都能删：排队中 / 失败 / 超时', () => {
    for (const status of ['pending', 'failed', 'timeout'] as const) {
      expect(removableOf(delivery({ status })), status).toBe(true);
    }
  });

  it('② 投递卡住的行（delivering）能强制移除——它就是压着后面的队头；running 是编排域的真实子进程，不删', () => {
    expect(removableOf(delivery({ status: 'delivering' }))).toBe(true);
    expect(removableOf(delivery({ status: 'running' }))).toBe(false);
  });

  it('③ 已发出且拿到回执（delivered + acked）不删——会话确实收到了，只是气泡还没到', () => {
    expect(removableOf(delivery({ status: 'delivered', acked: true }))).toBe(false);
  });

  it('④ 暂停闸的成因行都能删：没送出去的、已发出却没回执的（它就是压住整队的队头，等超时才给按钮等于锁住用户）', () => {
    expect(removableOf(delivery({ status: 'failed', stalled: true }))).toBe(true);
    expect(removableOf(delivery({ status: 'delivered', stalled: true }))).toBe(true);
    expect(removableOf(delivery({ status: 'delivered', acked: null }))).toBe(true);
    expect(removableOf(delivery({ status: 'delivered', acked: false }))).toBe(true);
  });
});

describe('queueStatusKey（队列行的状态文案）', () => {
  it('① 已发出未回执 = 已发出；已回执的命令行（内建命令没有气泡）= 已执行', () => {
    expect(queueStatusKey(delivery({ status: 'delivered', acked: null }))).toBe('tasks.msgStatusSent');
    expect(queueStatusKey(delivery({ status: 'delivered', acked: true }))).toBe('tasks.msgStatusExecuted');
  });

  it('② 其余状态照旧（排队中 / 投递中 / 失败）', () => {
    expect(queueStatusKey(delivery({ status: 'pending' }))).toBe('tasks.msgStatusQueued');
    expect(queueStatusKey(delivery({ status: 'delivering' }))).toBe('tasks.msgStatusDelivering');
    expect(queueStatusKey(delivery({ status: 'failed' }))).toBe('tasks.msgStatusFailed');
  });
});

describe('countdownLabel（暂停闸成因行的清除读数）', () => {
  it('① mm:ss 取整向上、归零不显负数', () => {
    const at = new Date(10 * 60_000).toISOString();
    expect(countdownLabel(at, 10 * 60_000 - 572_000)).toBe('9:32');
    expect(countdownLabel(at, 10 * 60_000 - 9_000)).toBe('0:09');
    expect(countdownLabel(at, 10 * 60_000)).toBe('0:00');
    expect(countdownLabel(at, 11 * 60_000)).toBe('0:00');
  });
});

describe('filterThread', () => {
  const thread: ConvEntry[] = [
    { key: 'e1', role: 'user', at: at(1), text: '问' },
    { key: 'e2', role: 'assistant', at: at(2), text: '答' },
    { key: 'e3', role: 'user', at: at(3), text: '再问' },
  ];

  it('① 全部 = 原序不动（不改手上的顺序）', () => {
    expect(filterThread(thread, 'all').map((e) => e.key)).toEqual(['e1', 'e2', 'e3']);
  });

  it('② 「我」「宿主回复」各留一半，仍按原时序', () => {
    expect(filterThread(thread, 'user').map((e) => e.key)).toEqual(['e1', 'e3']);
    expect(filterThread(thread, 'assistant').map((e) => e.key)).toEqual(['e2']);
  });

  it('⑤ 别的会话投递的 prompt 归「其他会话」，不再算进「我」', () => {
    const mixed: ConvEntry[] = [
      ...thread,
      // 别的会话经中继发来的（带 from-name、不是 weave 自己）
      { key: 'r1', role: 'user', at: at(4), text: '上游会话来的', fromWeave: false, fromName: 'sess-abc' },
      // dashboard 直投（weave 发的 = 用户自己发话，仍算「我」）
      { key: 'w1', role: 'user', at: at(5), text: '我叫它做的', fromWeave: true, fromName: 'weave' },
    ];
    expect(filterThread(mixed, 'user').map((e) => e.key)).toEqual(['e1', 'e3', 'w1']);
    expect(filterThread(mixed, 'remote').map((e) => e.key)).toEqual(['r1']);
    expect(filterThread(mixed, 'all')).toHaveLength(5);
  });

  it('③ 不原地改数组（过滤只影响显示）', () => {
    const out = filterThread(thread, 'all');
    expect(out).not.toBe(thread);
    expect(thread).toHaveLength(3);
  });

  it('④ 压缩分隔只在「全部」里露面（它不是谁发的）', () => {
    const withDivider: ConvEntry[] = [
      ...thread,
      { key: 'e4', role: 'compaction', at: at(4), text: '' },
    ];
    expect(filterThread(withDivider, 'all').map((e) => e.role)).toEqual([
      'user',
      'assistant',
      'user',
      'compaction',
    ]);
    expect(filterThread(withDivider, 'user').map((e) => e.key)).toEqual(['e1', 'e3']);
    expect(filterThread(withDivider, 'assistant').map((e) => e.key)).toEqual(['e2']);
  });
});

describe('withPlan（计划正文当一条对话气泡）', () => {
  const thread: ConvEntry[] = [
    { key: 'e1', eventId: 1, role: 'user', at: at(1), text: '问' },
    { key: 'e9', eventId: 9, role: 'assistant', at: at(9), text: '答' },
  ];

  it('① 没有计划 = 原样返回（不凭空多一条）', () => {
    expect(withPlan(thread, null).map((e) => e.key)).toEqual(['e1', 'e9']);
  });

  it('② 按提交那条事件的位置插进事件流（不是甩在尾巴上）', () => {
    const out = withPlan(thread, { eventId: 5, at: at(5), text: '# 计划' });
    expect(out.map((e) => [e.key, e.role, e.plan])).toEqual([
      ['e1', 'user', undefined],
      ['p5', 'assistant', true],
      ['e9', 'assistant', undefined],
    ]);
  });

  it('③ 计划是最新的（提交后还没有收尾总结）→ 排在尾上', () => {
    const out = withPlan(thread, { eventId: 20, at: at(20), text: '# 计划' });
    expect(out.map((e) => e.key)).toEqual(['e1', 'e9', 'p20']);
  });

  it('④ 正文为空不摆（计划文件没写到 / 取不到）', () => {
    expect(withPlan(thread, { eventId: 5, at: at(5), text: '   ' }).map((e) => e.key)).toEqual([
      'e1',
      'e9',
    ]);
  });
});

describe('withPreQuestion（提问前说明当一条对话气泡）', () => {
  const thread: ConvEntry[] = [
    { key: 'e1', eventId: 1, role: 'user', at: at(1), text: '问' },
    { key: 'e9', eventId: 9, role: 'assistant', at: at(9), text: '答' },
  ];

  it('① 没有说明 = 原样返回（不凭空多一条）', () => {
    expect(withPreQuestion(thread, null).map((e) => e.key)).toEqual(['e1', 'e9']);
  });

  it('② 按时刻插进时间线（摆在提问气泡之前）', () => {
    const out = withPreQuestion(thread, { at: at(5), text: '先说结论' });
    expect(out.map((e) => [e.key, e.role, e.preQuestion])).toEqual([
      ['e1', 'user', undefined],
      ['q' + at(5), 'assistant', true],
      ['e9', 'assistant', undefined],
    ]);
  });

  it('③ 比所有条目都晚 → 排在尾上（提问还没被 UPS 认领时）', () => {
    const out = withPreQuestion(thread, { at: at(20), text: '先说结论' });
    expect(out.map((e) => e.key)).toEqual(['e1', 'e9', 'q' + at(20)]);
  });

  it('④ 正文为空不摆', () => {
    expect(withPreQuestion(thread, { at: at(5), text: '   ' }).map((e) => e.key)).toEqual([
      'e1',
      'e9',
    ]);
  });
});

describe('withNarration（转录补采的中间输出当对话气泡）', () => {
  const thread: ConvEntry[] = [
    { key: 'e1', eventId: 1, role: 'user', at: at(1), text: '问' },
    { key: 'e9', eventId: 9, role: 'assistant', at: at(9), text: '收尾那句' },
  ];

  it('① 没有旁白 = 原样返回（不凭空多一条）', () => {
    expect(withNarration(thread, null).map((e) => e.key)).toEqual(['e1', 'e9']);
    expect(withNarration(thread, []).map((e) => e.key)).toEqual(['e1', 'e9']);
  });

  it('② 按时刻插进时间线（写工具前后的中间段落回到原位）', () => {
    const out = withNarration(thread, [{ at: at(5), text: '先说结论：改三处。' }]);
    expect(out.map((e) => [e.key, e.role, e.narration])).toEqual([
      ['e1', 'user', undefined],
      ['n' + at(5) + ':0', 'assistant', true],
      ['e9', 'assistant', undefined],
    ]);
  });

  it('③ 与 close 气泡同文案（首尾空白差异不算）的跳过——Stop.lam 本来就在', () => {
    const out = withNarration(thread, [
      { at: at(3), text: '收尾那句' },
      { at: at(3.5), text: ' 收尾那句 ' },
    ]);
    expect(out.map((e) => e.key)).toEqual(['e1', 'e9']);
  });

  it('④ 时刻缺失的旁白不摆（插哪儿都是猜）', () => {
    const out = withNarration(thread, [{ at: null, text: '没有时刻的一段' }]);
    expect(out.map((e) => e.key)).toEqual(['e1', 'e9']);
  });

  it('⑤ 多段按各自时刻各归各位', () => {
    const out = withNarration(thread, [
      { at: at(5), text: '第一段' },
      { at: at(7), text: '第二段' },
    ]);
    expect(out.map((e) => e.text)).toEqual(['问', '第一段', '第二段', '收尾那句']);
  });
});

describe('isGenerating（尾上「回复还在路上」）', () => {
  it('① 回合开着 + 尾条是我说的那句 → 生成中', () => {
    expect(isGenerating('running', 'user')).toBe(true);
  });

  it('② 自动压缩后尾条换成压缩分隔，仍算回复在路上（不然这一轮永远不显）', () => {
    expect(isGenerating('running', 'compaction')).toBe(true);
  });

  it('③ 压缩中与尾条是谁无关', () => {
    expect(isGenerating('compacting', 'assistant')).toBe(true);
    expect(isGenerating('compacting', undefined)).toBe(true);
  });

  it('④ 尾条已是回复 / 回合没开 → 不算', () => {
    expect(isGenerating('running', 'assistant')).toBe(false);
    expect(isGenerating('open', 'user')).toBe(false);
    expect(isGenerating('interrupted', 'user')).toBe(false);
    expect(isGenerating(undefined, 'user')).toBe(false);
    expect(isGenerating('running', undefined)).toBe(false);
  });
});

describe('serializeDraft（composer DOM → 要发出去的原文）', () => {
  interface Fake {
    nodeType: number;
    nodeValue?: string | null;
    tagName?: string;
    childNodes: Fake[];
    getAttribute(name: string): string | null;
  }
  const el = (tagName: string, childNodes: Fake[] = [], attrs?: Record<string, string>): Fake => ({
    nodeType: 1,
    tagName,
    childNodes,
    getAttribute: (name) => attrs?.[name] ?? null,
  });
  const text = (s: string): Fake => ({ nodeType: 3, nodeValue: s, childNodes: [], getAttribute: () => null });
  const draft = (childNodes: Fake[]): Node => el('DIV', childNodes) as unknown as Node;

  it('① 纯文本原样吐出', () => {
    expect(serializeDraft(draft([text('你好'), text('世界')]))).toBe('你好世界');
  });

  it('② 胶囊取 data-ref（harness 表达式），不是它显示的那截', () => {
    const chip = el('SPAN', [text('@src/a.ts')], { 'data-ref': '@src/a.ts' });
    expect(serializeDraft(draft([text('看下 '), chip, text(' 这里')]))).toBe('看下 @src/a.ts 这里');
  });

  it('③ 换行：浏览器插的 <br> 还原成 \\n', () => {
    expect(serializeDraft(draft([text('a'), el('BR'), text('b')]))).toBe('a\nb');
  });

  it('④ 空行占位的裸 <br> 不算一条换行（空框序列化应为空）', () => {
    expect(serializeDraft(draft([el('BR')]))).toBe('');
    expect(serializeDraft(draft([]))).toBe('');
  });

  it('⑤ 没挂载 / 不是元素 = 空串（不抛）', () => {
    expect(serializeDraft(null)).toBe('');
  });

  it('⑥ 命令胶囊还原成 /name，后面的参数照常拼上', () => {
    const chip = el('SPAN', [text('/model')], { 'data-cmd': 'model' });
    expect(serializeDraft(draft([chip, text(' opus')]))).toBe('/model opus');
  });

  it('⑥-b 附件占位胶囊：文件原地展开成落盘路径，图片独立成行（前后补行边界）', () => {
    const fileChip = el('SPAN', [text('notes.md')], {
      'data-attach': 'a'.repeat(64),
      'data-attach-name': 'notes.md',
      'data-attach-path': 'D:/up/notes.md',
      'data-attach-media': 'text/markdown',
    });
    expect(serializeDraft(draft([text('先读 '), fileChip, text(' 再说')]))).toBe(
      '先读 D:/up/notes.md 再说',
    );
    const imgChip = el('SPAN', [text('shot.png')], {
      'data-attach': 'b'.repeat(64),
      'data-attach-name': 'shot.png',
      'data-attach-path': 'D:/up/shot.png',
      'data-attach-media': 'image/png',
    });
    // 句中：前后补换行（宿主粘贴处理器只认独立成行的图片路径）
    expect(serializeDraft(draft([text('看 '), imgChip]))).toBe('看 \nD:/up/shot.png');
    // 行首 + 后面已是换行：不重复补
    expect(serializeDraft(draft([imgChip, text('\n下一行')]))).toBe('D:/up/shot.png\n下一行');
  });

  it('⑥-c 附件胶囊缺 path 属性（旧快照）= 文件也序列化为空串，不猜', () => {
    const chip = el('SPAN', [text('notes.md')], {
      'data-attach': 'a'.repeat(64),
      'data-attach-media': 'text/markdown',
    });
    expect(serializeDraft(draft([chip]))).toBe('');
  });

  it('⑥-d 附件胶囊进快照（a/p/n/m 四元组），快照序列化与 DOM 序列化同值', () => {
    const chip = el('SPAN', [text('notes.md')], {
      'data-attach': 'a'.repeat(64),
      'data-attach-name': 'notes.md',
      'data-attach-path': 'D:/up/notes.md',
      'data-attach-media': 'text/markdown',
    });
    const root = draft([text('先读 '), chip]);
    const snap = draftSnapshotOf(root as unknown as HTMLElement, []);
    expect(snap?.parts).toEqual([
      { t: '先读 ' },
      { a: 'a'.repeat(64), p: 'D:/up/notes.md', n: 'notes.md', m: 'text/markdown' },
    ]);
    // 快照的 parts 走 applyDraftSnapshot 还原后序列化应同值——这里只验「存」半边：
    // 还原半边依赖 document（node 测试环境没有），由活体验证兜底
  });

  it('⑥-a 粘贴快路：整段没有「行首/空白后的 @」就不必问服务端认引用', () => {
    expect(hasRefCandidate('普通一段话，没有任何引用')).toBe(false);
    expect(hasRefCandidate('邮箱 foo@bar.com 不算')).toBe(false);
    expect(hasRefCandidate('看 @src/a.ts')).toBe(true);
    expect(hasRefCandidate('@src/a.ts')).toBe(true);
    expect(hasRefCandidate('第一行\n@src/b.ts')).toBe(true);
  });

  it('⑥ 敲完 `@` 该不该弹选择器：前面必须是空白，`\\@` 是转义', () => {
    const before = (root: Node, container: Fake, off: number): string =>
      textBeforeCaret(root, { startContainer: container, startOffset: off } as unknown as Range);
    const alone = text('@');
    expect(pickerIntent(before(draft([text('看看 '), alone]), alone, 1))).toBe('open');
    expect(pickerIntent(before(draft([text('行尾换行\n'), alone]), alone, 1))).toBe('open');
    // 换行是 <br>：行首那枚 `@` 前面同样是空白（Range.toString() 不吐这个换行）
    expect(pickerIntent(before(draft([text('上一行'), el('BR'), alone]), alone, 1))).toBe('open');
    // 粘着字的都不弹：邮箱、中文
    const mail = text('foo@');
    expect(pickerIntent(before(draft([mail]), mail, 4))).toBe('ignore');
    const cjk = text('看@');
    expect(pickerIntent(before(draft([cjk]), cjk, 2))).toBe('ignore');
    const esc = text('\\@');
    expect(pickerIntent(before(draft([esc]), esc, 2))).toBe('escape');
    // 光标落在容器上（不在文本节点里）：只取它前面那些兄弟
    const root = el('DIV', [text(' '), text('@'), text('后面的字')]);
    expect(pickerIntent(before(root as unknown as Node, root, 2))).toBe('open');
    const glued = el('DIV', [text('看'), text('@')]);
    expect(pickerIntent(before(glued as unknown as Node, glued, 2))).toBe('ignore');
  });

  it('⑦ 胶囊不是空白：紧跟胶囊的 `@` 不弹，胶囊后面留了空格才弹', () => {
    const chip = el('SPAN', [text('@src/a.ts')], { 'data-ref': '@src/a.ts' });
    const tail = text('@');
    const tight = textBeforeCaret(draft([chip, tail]), {
      startContainer: tail,
      startOffset: 1,
    } as unknown as Range);
    expect(pickerIntent(tight)).toBe('ignore');
    const spaced = text('@');
    const before = textBeforeCaret(draft([chip, text(' '), spaced]), {
      startContainer: spaced,
      startOffset: 1,
    } as unknown as Range);
    expect(pickerIntent(before)).toBe('open');
  });

  it('⑧ `#` 会话引用同判据：前面必须空白，`\\#` 是转义', () => {
    expect(sessionPickerIntent('#')).toBe('open');
    expect(sessionPickerIntent('看看 #')).toBe('open');
    expect(sessionPickerIntent('看#')).toBe('ignore');
    expect(sessionPickerIntent('\\#')).toBe('escape');
  });

  it('⑨ 会话目标胶囊：序列化展开成 `#<id>` 收件人标注（发送 = 本会话的 prompt）、进快照（ss/n）', () => {
    const chip = el('SPAN', [text('#目标会话')], {
      'data-session-target': 'sess-b',
      'data-session-name': '目标会话',
    });
    // 正文只出 id：名字会重名也会改，胶囊上显示名字是给人看的
    expect(serializeDraft(draft([chip, text('帮我看下这个报错')]))).toBe('#sess-b帮我看下这个报错');
    const root = draft([text('帮我看下 '), chip, text(' 这个报错')]);
    const snap = draftSnapshotOf(root as unknown as HTMLElement, []);
    expect(snap?.parts).toEqual([{ t: '帮我看下 ' }, { ss: 'sess-b', n: '目标会话' }, { t: ' 这个报错' }]);
  });

  it('⑩ placeholder 的触发符只摆 harness 真能敲的：`#` 恒有、`@` 看能力面、`$` 随候选清单', () => {
    const modes = [
      { kind: 'slash', sigil: '/', named: true },
      { kind: 'bash', sigil: '!', named: true },
    ] as const;
    expect(refSigilsOf(true, modes, null)).toEqual(['@', '#', '/', '!']);
    // codex 形状：无 `!` bash、skill 走 `$`，且 `$` 只随候选出现（清单没拉到就不摆）
    expect(refSigilsOf(true, [{ kind: 'slash', sigil: '/', named: true }], null)).toEqual(['@', '#', '/']);
    const skill = { name: 'x', description: '', source: 'skill', sigil: '$' } as const;
    expect(refSigilsOf(false, [{ kind: 'slash', sigil: '/', named: true }], [skill])).toEqual([
      '#',
      '/',
      '$',
    ]);
  });
});

describe('buildSegments（粘贴时把表达式还原成胶囊）', () => {
  const ref = (start: number, end: number, path: string) => ({
    start,
    end,
    ref: `@${path}`,
    path,
    kind: 'file' as const,
  });

  it('① 一个认不出的都没有 → 整段纯文本', () => {
    expect(buildSegments('随便说说', [])).toEqual([{ kind: 'text', text: '随便说说' }]);
  });

  it('② 中间夹着的认出来 → 切成交替的片段', () => {
    expect(buildSegments('看 @src/a.ts 这里', [ref(2, 11, 'src/a.ts')])).toEqual([
      { kind: 'text', text: '看 ' },
      { kind: 'ref', item: { ref: '@src/a.ts', target: { path: 'src/a.ts', kind: 'file' } } },
      { kind: 'text', text: ' 这里' },
    ]);
  });

  it('③ 行区间跟着胶囊走', () => {
    const segs = buildSegments('@src/a.ts#L3-5', [
      { ...ref(0, 14, 'src/a.ts'), ref: '@src/a.ts#L3-5', lines: { start: 3, end: 5 } },
    ]);
    expect(segs).toEqual([
      {
        kind: 'ref',
        item: {
          ref: '@src/a.ts#L3-5',
          target: { path: 'src/a.ts', kind: 'file', lines: { start: 3, end: 5 } },
        },
      },
    ]);
  });

  it('④ 重叠 / 越界的认领跳过，原文字一个不丢', () => {
    const segs = buildSegments('@a/b.ts @c/d.ts', [ref(0, 7, 'a/b.ts'), ref(3, 6, 'x'), ref(8, 99, 'y')]);
    expect(segs).toEqual([
      { kind: 'ref', item: { ref: '@a/b.ts', target: { path: 'a/b.ts', kind: 'file' } } },
      { kind: 'text', text: ' @c/d.ts' },
    ]);
  });
});

describe('导出到剪贴板', () => {
  // 本地时区构造，期望值不带时区假设
  const ts = (h: number, m: number, s: number): string =>
    new Date(2026, 9, 16, h, m, s).toISOString();

  it('① 时刻戳 = 本地 YYYY-MM-DD HH:mm:ss（补零，粘到别处带得走日期）', () => {
    expect(exportStamp(ts(9, 8, 5))).toBe('2026-10-16 09:08:05');
    expect(exportStamp(ts(23, 59, 59))).toBe('2026-10-16 23:59:59');
  });

  it('② 时刻 + 角色各成一行，条目间空行', () => {
    const text = exportConversationText(
      [
        { key: 'e1', role: 'user', at: ts(9, 38, 52), text: '帮我把这个功能对齐一下' },
        { key: 'e2', role: 'assistant', at: ts(9, 41, 3), text: '已对齐，改了三个文件。' },
      ],
      { user: '我', assistant: '会话', plan: '计划' },
    );
    expect(text).toBe(
      '[2026-10-16 09:38:52] 我\n' +
        '帮我把这个功能对齐一下\n' +
        '\n' +
        '[2026-10-16 09:41:03] 会话\n' +
        '已对齐，改了三个文件。',
    );
  });

  it('③ 正文原样（多行/装饰已剥的原文不再加工），空选集给空串', () => {
    const text = exportConversationText(
      [{ key: 'e9', role: 'user', at: ts(1, 2, 3), text: '第一行\n第二行' }],
      { user: 'Me', assistant: 'Session', plan: 'Plan' },
    );
    expect(text).toBe('[2026-10-16 01:02:03] Me\n第一行\n第二行');
    expect(exportConversationText([], { user: '我', assistant: '会话', plan: '计划' })).toBe('');
  });

  it('④ 计划条目在角色行带上计划 tag（收着的气泡也照全文导出）', () => {
    const text = exportConversationText(
      [
        {
          key: 'p5',
          role: 'assistant',
          plan: true,
          at: ts(2, 0, 0),
          text: '# 计划\n第 1 步\n第 2 步\n第 3 步\n第 4 步\n第 5 步\n第 6 步\n第 7 步',
        },
      ],
      { user: '我', assistant: '会话', plan: '计划' },
    );
    expect(text).toBe(
      '[2026-10-16 02:00:00] 会话 · 计划\n' +
        '# 计划\n第 1 步\n第 2 步\n第 3 步\n第 4 步\n第 5 步\n第 6 步\n第 7 步',
    );
  });

  it('⑤ 压缩分隔不进导出（导出的是说了什么，不是时间线排版）', () => {
    const text = exportConversationText(
      [
        { key: 'e1', role: 'user', at: ts(1, 0, 0), text: 'A' },
        { key: 'e2', role: 'compaction', at: ts(1, 1, 0), text: '' },
        { key: 'e3', role: 'assistant', at: ts(1, 2, 0), text: 'B' },
      ],
      { user: '我', assistant: '会话', plan: '计划' },
    );
    expect(text).toBe('[2026-10-16 01:00:00] 我\nA\n\n[2026-10-16 01:02:00] 会话\nB');
  });

  it('⑥ 渲染块引用行剥行保文（私有区字符粘出去是乱码）', () => {
    const ref = '\u{e200}visualize\u{e202}{"path":"D:/x/a.html"}\u{e201}';
    const text = exportConversationText(
      [{ key: 'e1', role: 'assistant', at: ts(1, 0, 0), text: `结论如下\n\n${ref}\n\n完` }],
      { user: '我', assistant: '会话', plan: '计划' },
    );
    expect(text).toBe('[2026-10-16 01:00:00] 会话\n结论如下\n\n完');
    expect(text).not.toContain('\u{e200}');
  });
});

describe('导出 Markdown', () => {
  // 本地时区构造，期望值不带时区假设
  const ts = (h: number, m: number, s: number): string =>
    new Date(2026, 9, 16, h, m, s).toISOString();

  it('① 单条 = 纯正文（markdown 原样，不带文档头与角色行）', () => {
    const md = exportConversationMarkdown(
      [{ key: 'e1', role: 'assistant', at: ts(9, 0, 0), text: '# 标题\n\n正文一段。' }],
      { user: '我', assistant: '会话', plan: '计划', title: '会话 A' },
    );
    expect(md).toBe('# 标题\n\n正文一段。');
  });

  it('② 多条 = 对话记录：文档头（标题+时刻+条数）+ 每条角色行', () => {
    const md = exportConversationMarkdown(
      [
        { key: 'e1', role: 'user', at: ts(9, 0, 0), text: 'A' },
        { key: 'e2', role: 'assistant', at: ts(9, 1, 0), text: 'B' },
      ],
      { user: '我', assistant: '会话', plan: '计划', title: '会话 A' },
    );
    const head = md.slice(0, md.indexOf('\n\n###'));
    // 文档头时刻 = 导出当下（不绑死日期），条数 = 过滤压缩分隔后的条数
    expect(head).toMatch(/^# 会话 A\n\n\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} · 2$/);
    expect(md).toContain('### [2026-10-16 09:00:00] 我\n\nA');
    expect(md).toContain('### [2026-10-16 09:01:00] 会话\n\nB');
  });

  it('③ 压缩分隔不进导出；计划条目在角色行带计划 tag', () => {
    const md = exportConversationMarkdown(
      [
        { key: 'e1', role: 'user', at: ts(1, 0, 0), text: 'A' },
        { key: 'e2', role: 'compaction', at: ts(1, 1, 0), text: '' },
        { key: 'e3', role: 'assistant', plan: true, at: ts(1, 2, 0), text: 'B' },
      ],
      { user: '我', assistant: '会话', plan: '计划', title: 'T' },
    );
    expect(md).toContain('· 2');
    expect(md).not.toContain('compaction');
    expect(md).toContain('### [2026-10-16 01:02:00] 会话 · 计划\n\nB');
  });
});

describe('随附图', () => {
  const img = (id: string, name = 'a.png'): UploadFile & { path?: string } => ({
    id,
    name,
    mediaType: 'image/png',
  });

  it('开轮事件带的图挂到对话条目上（气泡缩略图的源）', () => {
    const entries = conversationOf(
      [
        {
          ...event(3, 'UserPromptSubmit', { prompt: '看看这个' }),
          images: [img('a'.repeat(64))],
        },
      ],
      claude,
    );
    expect(entries[0]?.attachments?.[0]?.id).toBe('a'.repeat(64));
  });

  it('`[Image #N]` 占位记号保留在正文里（气泡按它把图内联回原位置），没图的条目照原样', () => {
    const prompt = '[Image #6]消息重复了[Image #7]检查并修复';
    const withImage = conversationOf(
      [{ ...event(3, 'UserPromptSubmit', { prompt }), images: [img('a'.repeat(64))] }],
      claude,
    );
    expect(withImage[0]?.text).toBe(prompt);
    const withoutImage = conversationOf([event(4, 'UserPromptSubmit', { prompt })], claude);
    expect(withoutImage[0]?.text).toBe(prompt);
  });

  it('认领放宽一档：带图的投递行比空白更宽（粘贴处理连多行 chunk）', () => {
    const { thread } = attachDeliveries(
      [{ key: 'e3', eventId: 3, role: 'user', at: at(3), text: '第一行\n第二行（够长）' }],
      [delivery({ id: 'm1', text: '第一行第二行（够长）', at: at(3), attachments: [img('a'.repeat(64))] })],
    );
    expect(thread).toHaveLength(1);
    expect(thread[0]?.pipe?.id).toBe('m1');
  });

  it('纯图发送（正文为空）也成一条，投递行认领后不再另起尾巴', () => {
    const { thread } = attachDeliveries(
      [{ key: 'e3', eventId: 3, role: 'user', at: at(3), text: '', attachments: [img('a'.repeat(64))] }],
      [delivery({ id: 'm1', text: '', at: at(3), attachments: [img('a'.repeat(64))] })],
    );
    expect(thread).toHaveLength(1);
    expect(thread[0]?.attachments).toHaveLength(1);
  });

  it('带图正文在会话那侧变成 `[Image #N]` 占位 → 认领得到（不然同一条显示两遍）', () => {
    const { thread } = attachDeliveries(
      [
        {
          key: 'e3',
          eventId: 3,
          role: 'user',
          at: at(3),
          text: '看看这个[Image #1]',
          attachments: [img('a'.repeat(64))],
        },
      ],
      [delivery({ id: 'm1', text: '看看这个', at: at(3), attachments: [img('a'.repeat(64))] })],
    );
    expect(thread).toHaveLength(1);
    expect(thread[0]?.pipe?.id).toBe('m1');
  });

  it('纯图发送：会话那侧只剩占位（正文空）时也认领得到', () => {
    const { thread } = attachDeliveries(
      [
        {
          key: 'e3',
          eventId: 3,
          role: 'user',
          at: at(3),
          text: '[Image #1]',
          attachments: [img('a'.repeat(64))],
        },
      ],
      [delivery({ id: 'm1', text: '', at: at(3), attachments: [img('a'.repeat(64))] })],
    );
    expect(thread).toHaveLength(1);
    expect(thread[0]?.pipe?.id).toBe('m1');
  });

  it('占位胶囊原地展开的图片路径行：会话那侧换成占位记号后照样认领得到', () => {
    const path = 'D:/up/shot.png';
    const { thread } = attachDeliveries(
      [
        {
          key: 'e3',
          eventId: 3,
          role: 'user',
          at: at(3),
          text: '看这个\n[Image #1]',
          attachments: [{ ...img('a'.repeat(64)), path }],
        },
      ],
      [
        delivery({
          id: 'm1',
          text: `看这个\n${path}`,
          at: at(3),
          attachments: [{ ...img('a'.repeat(64)), path }],
        }),
      ],
    );
    expect(thread).toHaveLength(1);
    expect(thread[0]?.pipe?.id).toBe('m1');
  });

  it('回执记了事件 id：文案对不上（重发只补的那记回车提交了整个输入框）也只算一条', () => {
    const { thread } = attachDeliveries(
      [
        {
          key: 'e3',
          eventId: 3,
          role: 'user',
          at: at(30),
          text: '消息重复了检查并修复，一条消息出现了2次',
          attachments: [img('a'.repeat(64))],
        },
      ],
      [
        delivery({
          id: 'm1',
          text: '检查并修复，一条消息出现了2次',
          at: at(1),
          status: 'delivered',
          settledAt: at(30),
          acked: true,
          ackedEventId: 3,
          attachments: [img('a'.repeat(64))],
        }),
      ],
    );
    expect(thread).toHaveLength(1);
    expect(thread[0]?.pipe?.id).toBe('m1');
  });

  it('占位放宽只对有图的投递行生效：没图就是对不上，投递行只留在发送端', () => {
    const { thread, outbox } = attachDeliveries(
      [{ key: 'e3', eventId: 3, role: 'user', at: at(3), text: '看看这个[Image #1]' }],
      [delivery({ id: 'm1', text: '看看这个', at: at(3) })],
    );
    expect(thread).toHaveLength(1);
    expect(outbox.map((m) => m.id)).toEqual(['m1']);
  });

  it('导出按 claude 占位列图（`[Image #N] 文件名`），跟在正文后', () => {
    const text = exportConversationText(
      [
        {
          key: 'e1',
          role: 'user',
          at: new Date(2026, 9, 16, 9, 0, 0).toISOString(),
          text: '看看这个',
          attachments: [img('a'.repeat(64), 'shot.png'), img('b'.repeat(64), 'two.png')],
        },
      ],
      { user: '我', assistant: '会话', plan: '计划' },
    );
    expect(text).toBe(
      '[2026-10-16 09:00:00] 我\n' + '看看这个\n' + '[Image #1] shot.png\n' + '[Image #2] two.png',
    );
  });

  it('imageMarkerSegments：记号处内联回图（按序对应），文本段原样', () => {
    const a = img('a'.repeat(64), 'one.png');
    const b = img('b'.repeat(64), 'two.png');
    const segs = imageMarkerSegments('前[Image #1]中[Image #2]后', [a, b]);
    expect(segs).toEqual([
      { kind: 'text', text: '前' },
      { kind: 'image', image: a },
      { kind: 'text', text: '中' },
      { kind: 'image', image: b },
      { kind: 'text', text: '后' },
    ]);
    // 记号比图多：多出的记号当文本（宿主没真配上图）
    const extra = imageMarkerSegments('[Image #1][Image #2]', [a]);
    expect(extra).toEqual([
      { kind: 'image', image: a },
      { kind: 'text', text: '[Image #2]' },
    ]);
    // 没图：整段当文本（记号是死文本，照原样显示）
    expect(imageMarkerSegments('看[Image #1]', [])).toEqual([{ kind: 'text', text: '看[Image #1]' }]);
  });

  it('pipePathSegments：按投递行原文里的路径位置切段（图回用户摆的位置）', () => {
    const a = img('a'.repeat(64), 'one.png');
    const b = img('b'.repeat(64), 'two.png');
    a.path = 'D:\\shots\\one.png';
    b.path = 'D:\\shots\\two.png';
    // 用户原文：图夹在句中——宿主侧记号聚在开头，投递行原文里位置完好
    const segs = pipePathSegments(
      `先看这张\nD:\\shots\\one.png\n再对比\nD:\\shots\\two.png\n谢谢`,
      [a, b],
    );
    expect(segs).toEqual([
      { kind: 'text', text: '先看这张\n' },
      { kind: 'image', image: a },
      { kind: 'text', text: '\n再对比\n' },
      { kind: 'image', image: b },
      { kind: 'text', text: '\n谢谢' },
    ]);
    // 认不出路径（终端手贴的老消息 / 路径被改写）：null = 退回记号切段
    expect(pipePathSegments('正文里没有路径', [a])).toBeNull();
    // 路径重复出现：取首现位置（indexOf 语义）
    const dup = pipePathSegments(`D:\\shots\\one.png 提到 D:\\shots\\one.png 两次`, [a]);
    expect(dup).toEqual([
      { kind: 'image', image: a },
      { kind: 'text', text: ' 提到 D:\\shots\\one.png 两次' },
    ]);
  });
});

describe('attachedFilesFrom（剪贴板 / 拖放取文件）', () => {
  const f = (name: string, type: string): File => new File(['x'], name, { type });
  const dt = (spec: {
    items?: { kind: string; type: string; file: File | null; dir?: boolean }[];
    files?: File[];
  }): DataTransfer =>
    ({
      items: (spec.items ?? []).map((i) => ({
        kind: i.kind,
        type: i.type,
        getAsFile: () => i.file,
        ...(i.dir === undefined ? {} : { webkitGetAsEntry: () => ({ isDirectory: i.dir }) }),
      })),
      files: spec.files ?? [],
    }) as unknown as DataTransfer;

  it('移动浏览器只填 items（iOS Safari 的 files 恒空）→ 仍取到图', () => {
    const shot = f('shot.png', 'image/png');
    const got = attachedFilesFrom(dt({ items: [{ kind: 'file', type: 'image/png', file: shot }] }));
    expect(got.map((x) => x.name)).toEqual(['shot.png']);
  });

  it('桌面 files 兜底（items 空）', () => {
    const got = attachedFilesFrom(dt({ files: [f('a.jpg', 'image/jpeg'), f('b.gif', 'image/gif')] }));
    expect(got.map((x) => x.name)).toEqual(['a.jpg', 'b.gif']);
  });

  it('拖进来的文件夹不是上传件（size=0 的假 File 会占格再失败）', () => {
    const got = attachedFilesFrom(
      dt({
        items: [
          { kind: 'file', type: '', file: f('repo', ''), dir: true },
          { kind: 'file', type: 'text/plain', file: f('notes.txt', 'text/plain'), dir: false },
        ],
      }),
    );
    expect(got.map((x) => x.name)).toEqual(['notes.txt']);
  });

  it('文字项不吞：只取 kind=file（图与普通文件都收，类型门在 stageFiles）', () => {
    const got = attachedFilesFrom(
      dt({
        items: [
          { kind: 'string', type: 'text/plain', file: null },
          { kind: 'file', type: 'image/png', file: f('shot.png', 'image/png') },
          { kind: 'file', type: 'application/pdf', file: f('doc.pdf', 'application/pdf') },
        ],
      }),
    );
    expect(got.map((x) => x.name)).toEqual(['shot.png', 'doc.pdf']);
  });

  it('剪贴板项不带 type 也照收（类型由 stageFiles 按 MIME/扩展名判）', () => {
    const got = attachedFilesFrom(dt({ items: [{ kind: 'file', type: '', file: f('photo.webp', '') }] }));
    expect(got.map((x) => x.name)).toEqual(['photo.webp']);
  });

  it('没有 clipboardData（或全是文字）→ 空表，调用方据此不压默认粘贴', () => {
    expect(attachedFilesFrom(null)).toEqual([]);
    expect(attachedFilesFrom(dt({ items: [{ kind: 'string', type: 'text/plain', file: null }] }))).toEqual([]);
    expect(attachedFilesFrom(dt({ files: [f('doc.pdf', 'application/pdf')] })).map((x) => x.name)).toEqual([
      'doc.pdf',
    ]);
  });
});

describe('对话缓存（sessionStorage）', () => {
  const store = new Map<string, string>();
  const conv = (id: number, over: Partial<ConvEntry> = {}): ConvEntry => ({
    key: `e${id}`,
    eventId: id,
    role: 'user',
    at: at(id),
    text: `t${id}`,
    ...over,
  });

  beforeEach(() => {
    store.clear();
    vi.stubGlobal('sessionStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('写进去读回来：条目与时序原样，投递行不进缓存', () => {
    const entries = [conv(1), conv(2), conv(3, { role: 'assistant', pipe: delivery({ id: 'm9' }) })];
    writeConvCache('s1', entries);
    expect(readConvCache('s1')).toEqual([conv(1), conv(2), conv(3, { role: 'assistant' })]);
    expect(readConvCache('别的会话')).toBeNull();
  });

  it('只留尾巴若干条（滑动窗口 100 条；长会话的翻页历史不一直堆在会话存储里）', () => {
    writeConvCache(
      's1',
      Array.from({ length: 120 }, (_, i) => conv(i + 1)),
    );
    const cached = readConvCache('s1')!;
    expect(cached).toHaveLength(100);
    expect(cached[0]!.eventId).toBe(21);
    expect(cached[99]!.eventId).toBe(120);
  });

  it('过期的、写坏的、没写过的都当没有（缓存是加速不是功能）', () => {
    store.set('weave:conv:s1', JSON.stringify({ at: 0, entries: [conv(1)] }));
    expect(readConvCache('s1')).toBeNull();
    store.set('weave:conv:s1', '{ 这不是 json');
    expect(readConvCache('s1')).toBeNull();
    expect(readConvCache('从没写过')).toBeNull();
  });
});

describe('editsWindowOf（按轮取数的窗口）', () => {
  const conv = (id: number, over: Partial<ConvEntry> = {}): ConvEntry => ({
    key: `e${id}`,
    eventId: id,
    role: 'user',
    at: at(id),
    text: `t${id}`,
    ...over,
  });

  it('回复锚：上界是自己、下界是前一条回复', () => {
    const entries = [
      conv(1, { role: 'assistant' }),
      conv(2),
      conv(3, { role: 'assistant' }),
      conv(4),
      conv(5, { role: 'assistant' }),
    ];
    expect(editsWindowOf(entries, 'e3')).toEqual({ since: at(1), until: at(3) });
  });

  it('用户锚：取包夹它的两条回复；同一轮里的气泡窗口相同', () => {
    const entries = [
      conv(1, { role: 'assistant' }),
      conv(2),
      conv(3, { role: 'assistant' }),
      conv(4),
      conv(5, { role: 'assistant' }),
    ];
    expect(editsWindowOf(entries, 'e4')).toEqual({ since: at(3), until: at(5) });
    expect(editsWindowOf(entries, 'e2')).toEqual(editsWindowOf(entries, 'e3'));
  });

  it('尾巴上的用户条目（回合还在跑）：until = null', () => {
    const entries = [conv(1, { role: 'assistant' }), conv(2)];
    expect(editsWindowOf(entries, 'e2')).toEqual({ since: at(1), until: null });
  });

  it('会话开头没有更早的回复：since = null', () => {
    const entries = [conv(1), conv(2, { role: 'assistant' })];
    expect(editsWindowOf(entries, 'e1')).toEqual({ since: null, until: at(2) });
  });

  it('全程没有回复条目 → 双 null（退化为全部）；找不到的 key 同样', () => {
    expect(editsWindowOf([conv(1), conv(2)], 'e1')).toEqual({ since: null, until: null });
    expect(editsWindowOf([conv(1)], 'e999')).toEqual({ since: null, until: null });
  });
});

describe('commandTokensOf（气泡里的命令 token 识别）', () => {
  type Src = 'builtin' | 'command' | 'skill' | 'plugin';
  const table: Record<string, { source: Src; inline?: boolean }> = {
    'compact': { source: 'builtin' },
    'model': { source: 'builtin' },
    'goal': { source: 'builtin' },
    'init': { source: 'builtin', inline: true },
    'deploy': { source: 'command', inline: true },
    'minimax-docx': { source: 'skill', inline: true },
    'plug:design': { source: 'plugin', inline: true },
    'triage': { source: 'skill', inline: true },
  };
  /** codex 的 skill 走 `$`；其余一律 `/`。 */
  const src = (sigil: '/' | '$', name: string): { source: Src; sigil: '/' | '$'; inline?: boolean } | undefined => {
    const hit = sigil === '$' ? (name === 'triage' ? table[name] : undefined) : table[name];
    return hit ? { source: hit.source, sigil, inline: hit.inline } : undefined;
  };

  it('句首的官方命令：名字成 token，参数留作文字', () => {
    expect(commandTokensOf('/compact', src)).toEqual([{ cmd: 'compact', source: 'builtin', sigil: '/' }]);
    expect(commandTokensOf('  /model opus  ', src)).toEqual([
      { text: '  ' },
      { cmd: 'model', source: 'builtin', sigil: '/' },
      { text: ' opus  ' },
    ]);
    expect(commandTokensOf('/goal 完成\n然后提交', src)).toEqual([
      { cmd: 'goal', source: 'builtin', sigil: '/' },
      { text: ' 完成\n然后提交' },
    ]);
  });

  it('inline 命令可以插在句中任何位置（前后须空白）', () => {
    expect(commandTokensOf('帮我用 /minimax-docx 生成文档', src)).toEqual([
      { text: '帮我用 ' },
      { cmd: 'minimax-docx', source: 'skill', sigil: '/' },
      { text: ' 生成文档' },
    ]);
    expect(commandTokensOf('/plug:design 和 /minimax-docx', src)).toEqual([
      { cmd: 'plug:design', source: 'plugin', sigil: '/' },
      { text: ' 和 ' },
      { cmd: 'minimax-docx', source: 'skill', sigil: '/' },
    ]);
    // 自定义命令也是 prompt 型（claude mention 扫描认它）
    expect(commandTokensOf('先 /deploy 再说', src)).toEqual([
      { text: '先 ' },
      { cmd: 'deploy', source: 'command', sigil: '/' },
      { text: ' 再说' },
    ]);
  });

  it('codex 的 skill 用 `$`（同样是空白包围、可插句中）', () => {
    expect(commandTokensOf('请用 $triage 看一下', src)).toEqual([
      { text: '请用 ' },
      { cmd: 'triage', source: 'skill', sigil: '$' },
      { text: ' 看一下' },
    ]);
  });

  it('inline 命令贴着字就不认（与引用表达式同一条判据）', () => {
    expect(commandTokensOf('用/minimax-docx生成', src)).toEqual([{ text: '用/minimax-docx生成' }]);
    expect(commandTokensOf('/minimax-docx，帮我', src)).toEqual([{ text: '/minimax-docx，帮我' }]);
    expect(commandTokensOf('价格$5', src)).toEqual([{ text: '价格$5' }]);
  });

  it('非 inline 命令只在整条输入开头：句中不认（多行第二行的行首也不算）', () => {
    expect(commandTokensOf('看看 /model', src)).toEqual([{ text: '看看 /model' }]);
    expect(commandTokensOf('第一行\n/compact 第二行', src)).toEqual([
      { text: '第一行\n/compact 第二行' },
    ]);
    // inline 的内建（prompt 型）不受此限
    expect(commandTokensOf('记得 /init 一下', src)).toEqual([
      { text: '记得 ' },
      { cmd: 'init', source: 'builtin', sigil: '/' },
      { text: ' 一下' },
    ]);
  });

  it('认不出的名字当普通文字', () => {
    expect(commandTokensOf('/nope', src)).toEqual([{ text: '/nope' }]);
    expect(commandTokensOf('a/b', src)).toEqual([{ text: 'a/b' }]);
    expect(commandTokensOf('/', src)).toEqual([{ text: '/' }]);
  });

  it('胶囊配色：skill / 插件红，官方与自定义命令黄', () => {
    expect(cmdChipClass('skill')).toContain('red');
    expect(cmdChipClass('plugin')).toContain('red');
    expect(cmdChipClass('builtin')).toContain('amber');
    expect(cmdChipClass('command')).toContain('amber');
    expect(cmdChipClass(undefined)).toContain('amber');
  });
});

describe('cmdQueryIn / cmdMenuShouldOpen / cmdMenuMatches（菜单触发与候选池）', () => {
  const commands = [
    { name: 'compact', description: '', source: 'builtin' as const },
    { name: 'init', description: '', source: 'builtin' as const, inline: true },
    { name: 'deploy', description: '', source: 'command' as const, inline: true },
    { name: 'triage', description: '', source: 'skill' as const, sigil: '$' as const, inline: true },
  ];

  it('触发位识别：空白后的触发符 + 片段，head 判据 = 整条输入开头', () => {
    expect(cmdQueryIn('/com')).toEqual({ sigil: '/', query: 'com', head: true });
    expect(cmdQueryIn('  /com')).toEqual({ sigil: '/', query: 'com', head: true });
    expect(cmdQueryIn('看看 /mo')).toEqual({ sigil: '/', query: 'mo', head: false });
    expect(cmdQueryIn('第一行\n/com')).toEqual({ sigil: '/', query: 'com', head: false });
    expect(cmdQueryIn('$tri')).toEqual({ sigil: '$', query: 'tri', head: true });
    // 贴着字不算触发位
    expect(cmdQueryIn('abc/def')).toBeNull();
    // 名字字符集外的尾巴不算片段
    expect(cmdQueryIn('/com.')).toBeNull();
  });

  it('菜单开闸：开头位只要有该触发符的候选就开；句中要有 inline 候选才开', () => {
    expect(cmdMenuShouldOpen(commands, '/', true)).toBe(true);
    expect(cmdMenuShouldOpen(commands, '/', false)).toBe(true); // init/deploy 是 inline
    expect(cmdMenuShouldOpen(commands, '$', false)).toBe(true);
    // 全是非 inline 的候选时句中不开
    const builtinOnly = [{ name: 'compact', description: '', source: 'builtin' as const }];
    expect(cmdMenuShouldOpen(builtinOnly, '/', false)).toBe(false);
    expect(cmdMenuShouldOpen(builtinOnly, '/', true)).toBe(true);
  });

  it('候选池：句中滤掉非 inline；前缀优先、包含殿后、截 40', () => {
    expect(cmdMenuMatches(commands, '/', '', true).map((c) => c.name)).toEqual(['compact', 'init', 'deploy']);
    expect(cmdMenuMatches(commands, '/', '', false).map((c) => c.name)).toEqual(['init', 'deploy']);
    expect(cmdMenuMatches(commands, '$', '', true).map((c) => c.name)).toEqual(['triage']);
    // 前缀命中排前
    const pool = [
      ...commands,
      { name: 'deploy-fast', description: '', source: 'command' as const, inline: true },
    ];
    expect(cmdMenuMatches(pool, '/', 'depl', false).map((c) => c.name)).toEqual(['deploy', 'deploy-fast']);
  });
});

describe('withCommands（命令执行插进对话流）', () => {
  const conv = (id: number, over: Partial<ConvEntry> = {}): ConvEntry => ({
    key: `e${id}`,
    eventId: id,
    role: 'user',
    at: at(id),
    text: `msg ${id}`,
    ...over,
  });

  it('按时刻插入，气泡是 /name + 参数，回显挂在同一条上', () => {
    const entries = [conv(1), conv(3, { role: 'assistant' })];
    const out = withCommands(entries, [
      { name: 'compact', args: '', at: at(2), output: 'Compacted' },
    ]);
    expect(out.map((e) => e.key)).toEqual(['e1', 'x' + at(2) + ':compact', 'e3']);
    expect(out[1]).toMatchObject({
      role: 'user',
      text: '/compact',
      commandOutput: 'Compacted',
    });
  });

  it('晚于所有事件的执行排在尾巴（正在发生的命令）', () => {
    const out = withCommands([conv(1)], [{ name: 'model', args: 'opus', at: at(9) }]);
    expect(out[out.length - 1]).toMatchObject({ text: '/model opus' });
  });

  it('没有记录面（null）或空表 → 原样返回', () => {
    const entries = [conv(1)];
    expect(withCommands(entries, null)).toEqual(entries);
    expect(withCommands(entries, [])).toEqual(entries);
  });
});

describe('stackUnitsOf（连续过程输出折成叠层）', () => {
  const narr = (id: number, at: string): ConvEntry => ({
    key: `n${id}`,
    role: 'assistant',
    at,
    text: `段${id}`,
    narration: true,
  });
  const user = (id: number, at: string): ConvEntry => ({
    key: `u${id}`,
    role: 'user',
    at,
    text: '问',
  });
  const close = (id: number, at: string): ConvEntry => ({
    key: `e${id}`,
    role: 'assistant',
    at,
    text: '答',
  });

  it('① 连续 narration 折成一组；单段不成叠', () => {
    const entries = [user(1, 'a'), narr(2, 'b'), narr(3, 'c'), close(4, 'd')];
    const units = stackUnitsOf(entries);
    expect(units).toEqual([
      { kind: 'entry', entry: entries[0] },
      { kind: 'group', group: { key: 'stk:n2', at: 'c', segs: [entries[1], entries[2]] } },
      { kind: 'entry', entry: entries[3] },
    ]);
  });

  it('② 中间插最终消息即断组（各成一叠或单条）', () => {
    const entries = [narr(1, 'a'), close(2, 'b'), narr(3, 'c')];
    const units = stackUnitsOf(entries);
    expect(units).toHaveLength(3);
    expect(units[0]).toEqual({ kind: 'entry', entry: entries[0] });
    expect(units[2]).toEqual({ kind: 'entry', entry: entries[2] });
  });

  it('③ 多选态（flat）整叠摊平成独立条目', () => {
    const entries = [narr(1, 'a'), narr(2, 'b'), narr(3, 'c')];
    const units = stackUnitsOf(entries, true);
    expect(units.map((u) => (u.kind === 'entry' ? u.entry.key : 'GROUP'))).toEqual([
      'n1',
      'n2',
      'n3',
    ]);
  });

  it('④ 全是 narration 也只折一叠；空表出空表', () => {
    const entries = [narr(1, 'a'), narr(2, 'b')];
    expect(stackUnitsOf(entries)).toEqual([
      { kind: 'group', group: { key: 'stk:n1', at: 'b', segs: entries } },
    ]);
    expect(stackUnitsOf([])).toEqual([]);
  });
});
