import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import {
  attachDeliveries,
  conversationOf,
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
  settledAt: over.settledAt ?? null,
  stalled: over.stalled ?? null,
  output: null,
  error: over.error ?? null,
  at: over.at ?? at(10),
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
});

describe('attachDeliveries', () => {
  const userEntry = { key: 'e1', eventId: 1, role: 'user' as const, at: at(10), text: 'hi' };

  it('① 同文案且时刻相近的投递行挂到该气泡上（不重复渲染）', () => {
    const thread = attachDeliveries(
      [userEntry],
      [delivery({ id: 'm1', text: 'hi', at: at(10), status: 'delivered', settledAt: at(10) })],
    );
    expect(thread).toHaveLength(1);
    expect(thread[0]!.pipe?.id).toBe('m1');
  });

  it('② 认领不到的（失败/暂停闸成因等）留在尾巴上，按时刻升序', () => {
    const thread = attachDeliveries(
      [userEntry],
      [
        delivery({ id: 'm-late', text: '没送达的', at: at(30), status: 'failed' }),
        delivery({ id: 'm-early', text: '卡住的', at: at(20), status: 'delivered', stalled: true }),
        delivery({ id: 'm3', text: 'hi', at: at(9), status: 'delivered' }),
      ],
    );
    // e1 被最近的 m3 认领；两个没被认领的按时刻升序挂在尾巴上
    expect(thread.map((e) => e.pipe?.id ?? e.key)).toEqual(['m3', 'm-early', 'm-late']);
  });

  it('③ 认领取时刻最近的一条（失败的旧行不抢新行的气泡）', () => {
    const thread = attachDeliveries(
      [userEntry],
      [
        delivery({ id: 'm-old', text: 'hi', at: at(8), status: 'failed' }),
        delivery({ id: 'm-new', text: 'hi', at: at(10), status: 'delivered', settledAt: at(10) }),
      ],
    );
    expect(thread.map((e) => e.pipe?.id ?? e.key)).toEqual(['m-new', 'm-old']);
  });

  it('④ 直投消息只出现一条：摘掉来源标记的条目认领得到它自己的投递行', () => {
    const entries = conversationOf(
      [event(1, 'UserPromptSubmit', { prompt: '[weave] 帮我看看这个' })],
      claude,
    );
    const thread = attachDeliveries(
      entries,
      [delivery({ id: 'm1', text: '帮我看看这个', at: at(1), status: 'delivered', settledAt: at(1) })],
    );
    expect(thread).toHaveLength(1);
    expect(thread[0]!.pipe?.id).toBe('m1');
  });

  it('⑤ 中继带壳的原文也认领得到（Claude Code 把会话间消息裹了壳，原文在里面）', () => {
    const thread = attachDeliveries(
      [{ ...userEntry, text: '<cross-session-message from="uds:x">hi</cross-session-message>' }],
      [delivery({ id: 'm2', text: 'hi', at: at(10), status: 'delivered', settledAt: at(10) })],
    );
    expect(thread).toHaveLength(1);
    expect(thread[0]!.pipe?.id).toBe('m2');
  });

  it('⑥ 短文案只认全等：「ok」不会被含着它的别的条目认走', () => {
    const thread = attachDeliveries(
      [{ ...userEntry, text: '好，ok，我看看' }],
      [delivery({ id: 'm3', text: 'ok', at: at(10), status: 'failed' })],
    );
    expect(thread.map((e) => e.pipe?.id ?? e.key)).toEqual(['e1', 'm3']);
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
