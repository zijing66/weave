import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import {
  attachDeliveries,
  conversationOf,
  imagesFrom,
  exportConversationText,
  exportStamp,
  filterThread,
  isGenerating,
  removableOf,
  spliceNewline,
  readConvCache,
  writeConvCache,
  type ConvEntry,
} from '../SessionMessages';
import { HARNESS_LIFECYCLE } from '../lifecycle';
import type { HookEventRow, SessionMessageRow } from '@/lib/api';

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
  ...(over.images ? { images: over.images } : {}),
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
});

describe('removableOf（队列里的行能不能删）', () => {
  it('① 未送达的都能删：排队中 / 失败 / 超时', () => {
    for (const status of ['pending', 'failed', 'timeout'] as const) {
      expect(removableOf(delivery({ status })), status).toBe(true);
    }
  });

  it('② 在飞的不删（落定回调会把行写回来），已送达的不删（内容已在会话里）', () => {
    expect(removableOf(delivery({ status: 'delivering' }))).toBe(false);
    expect(removableOf(delivery({ status: 'running' }))).toBe(false);
    expect(removableOf(delivery({ status: 'delivered' }))).toBe(false);
  });

  it('③ 暂停闸成因一律能删——它不清掉，闸就没有可操作的成因行', () => {
    expect(removableOf(delivery({ status: 'delivered', stalled: true }))).toBe(true);
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

  it('② 「我发的」「回复」各留一半，仍按原时序', () => {
    expect(filterThread(thread, 'user').map((e) => e.key)).toEqual(['e1', 'e3']);
    expect(filterThread(thread, 'assistant').map((e) => e.key)).toEqual(['e2']);
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

describe('spliceNewline（移动端换行钮）', () => {
  it('① 尾部追加，光标跟到新行后', () => {
    expect(spliceNewline('abc', 3, 3)).toEqual({ text: 'abc\n', caret: 4 });
  });

  it('② 插在中间，后半截原样接上', () => {
    expect(spliceNewline('abcd', 2, 2)).toEqual({ text: 'ab\ncd', caret: 3 });
  });

  it('③ 选中一段 = 覆盖掉选区', () => {
    expect(spliceNewline('abcdef', 1, 4)).toEqual({ text: 'a\nef', caret: 2 });
  });

  it('④ 空输入框就一个换行', () => {
    expect(spliceNewline('', 0, 0)).toEqual({ text: '\n', caret: 1 });
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
      { user: '我', assistant: '会话' },
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
      { user: 'Me', assistant: 'Session' },
    );
    expect(text).toBe('[2026-10-16 01:02:03] Me\n第一行\n第二行');
    expect(exportConversationText([], { user: '我', assistant: '会话' })).toBe('');
  });

  it('④ 压缩分隔不进导出（导出的是说了什么，不是时间线排版）', () => {
    const text = exportConversationText(
      [
        { key: 'e1', role: 'user', at: ts(1, 0, 0), text: 'A' },
        { key: 'e2', role: 'compaction', at: ts(1, 1, 0), text: '' },
        { key: 'e3', role: 'assistant', at: ts(1, 2, 0), text: 'B' },
      ],
      { user: '我', assistant: '会话' },
    );
    expect(text).toBe('[2026-10-16 01:00:00] 我\nA\n\n[2026-10-16 01:02:00] 会话\nB');
  });
});

describe('随附图', () => {
  const img = (id: string, name = 'a.png') => ({ id, name, mediaType: 'image/png' });

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
    expect(entries[0]?.images?.[0]?.id).toBe('a'.repeat(64));
  });

  it('`[Image #N]` 是宿主输入框的占位、不是正文：有图就剥掉，没图（图丢了）才留', () => {
    const prompt = '[Image #6]消息重复了[Image #7]检查并修复';
    const withImage = conversationOf(
      [{ ...event(3, 'UserPromptSubmit', { prompt }), images: [img('a'.repeat(64))] }],
      claude,
    );
    expect(withImage[0]?.text).toBe('消息重复了检查并修复');
    const withoutImage = conversationOf([event(4, 'UserPromptSubmit', { prompt })], claude);
    expect(withoutImage[0]?.text).toBe(prompt);
  });

  it('认领放宽一档：带图的投递行比空白更宽（粘贴处理连多行 chunk）', () => {
    const { thread } = attachDeliveries(
      [{ key: 'e3', eventId: 3, role: 'user', at: at(3), text: '第一行\n第二行（够长）' }],
      [delivery({ id: 'm1', text: '第一行第二行（够长）', at: at(3), images: [img('a'.repeat(64))] })],
    );
    expect(thread).toHaveLength(1);
    expect(thread[0]?.pipe?.id).toBe('m1');
  });

  it('纯图发送（正文为空）也成一条，投递行认领后不再另起尾巴', () => {
    const { thread } = attachDeliveries(
      [{ key: 'e3', eventId: 3, role: 'user', at: at(3), text: '', images: [img('a'.repeat(64))] }],
      [delivery({ id: 'm1', text: '', at: at(3), images: [img('a'.repeat(64))] })],
    );
    expect(thread).toHaveLength(1);
    expect(thread[0]?.images).toHaveLength(1);
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
          images: [img('a'.repeat(64))],
        },
      ],
      [delivery({ id: 'm1', text: '看看这个', at: at(3), images: [img('a'.repeat(64))] })],
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
          images: [img('a'.repeat(64))],
        },
      ],
      [delivery({ id: 'm1', text: '', at: at(3), images: [img('a'.repeat(64))] })],
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
          images: [img('a'.repeat(64))],
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
          images: [img('a'.repeat(64))],
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
          images: [img('a'.repeat(64), 'shot.png'), img('b'.repeat(64), 'two.png')],
        },
      ],
      { user: '我', assistant: '会话' },
    );
    expect(text).toBe(
      '[2026-10-16 09:00:00] 我\n' + '看看这个\n' + '[Image #1] shot.png\n' + '[Image #2] two.png',
    );
  });
});

describe('imagesFrom（剪贴板 / 拖放取图）', () => {
  const f = (name: string, type: string): File => new File(['x'], name, { type });
  const dt = (spec: { items?: { kind: string; type: string; file: File | null }[]; files?: File[] }): DataTransfer =>
    ({
      items: (spec.items ?? []).map((i) => ({
        kind: i.kind,
        type: i.type,
        getAsFile: () => i.file,
      })),
      files: spec.files ?? [],
    }) as unknown as DataTransfer;

  it('移动浏览器只填 items（iOS Safari 的 files 恒空）→ 仍取到图', () => {
    const shot = f('shot.png', 'image/png');
    const got = imagesFrom(dt({ items: [{ kind: 'file', type: 'image/png', file: shot }] }));
    expect(got.map((x) => x.name)).toEqual(['shot.png']);
  });

  it('桌面 files 兜底（items 空）', () => {
    const got = imagesFrom(dt({ files: [f('a.jpg', 'image/jpeg'), f('b.gif', 'image/gif')] }));
    expect(got.map((x) => x.name)).toEqual(['a.jpg', 'b.gif']);
  });

  it('文字项不吞：只取 kind=file，非图文件不进', () => {
    const got = imagesFrom(
      dt({
        items: [
          { kind: 'string', type: 'text/plain', file: null },
          { kind: 'file', type: 'image/png', file: f('shot.png', 'image/png') },
          { kind: 'file', type: 'application/pdf', file: f('doc.pdf', 'application/pdf') },
        ],
      }),
    );
    expect(got.map((x) => x.name)).toEqual(['shot.png']);
  });

  it('剪贴板项不带 type 时按扩展名认（移动浏览器偶发）', () => {
    const got = imagesFrom(dt({ items: [{ kind: 'file', type: '', file: f('photo.webp', '') }] }));
    expect(got.map((x) => x.name)).toEqual(['photo.webp']);
  });

  it('没有 clipboardData（或全是文字）→ 空表，调用方据此不压默认粘贴', () => {
    expect(imagesFrom(null)).toEqual([]);
    expect(imagesFrom(dt({ items: [{ kind: 'string', type: 'text/plain', file: null }] }))).toEqual([]);
    expect(imagesFrom(dt({ files: [f('doc.pdf', 'application/pdf')] }))).toEqual([]);
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

  it('只留尾巴若干条（长会话的翻页历史不一直堆在会话存储里）', () => {
    writeConvCache(
      's1',
      Array.from({ length: 70 }, (_, i) => conv(i + 1)),
    );
    const cached = readConvCache('s1')!;
    expect(cached).toHaveLength(60);
    expect(cached[0]!.eventId).toBe(11);
    expect(cached[59]!.eventId).toBe(70);
  });

  it('过期的、写坏的、没写过的都当没有（缓存是加速不是功能）', () => {
    store.set('weave:conv:s1', JSON.stringify({ at: 0, entries: [conv(1)] }));
    expect(readConvCache('s1')).toBeNull();
    store.set('weave:conv:s1', '{ 这不是 json');
    expect(readConvCache('s1')).toBeNull();
    expect(readConvCache('从没写过')).toBeNull();
  });
});
