import { describe, it, expect, vi } from 'vitest';
import { HookEventBus } from '../bus.js';
import { NotifyFanout } from '../notify-fanout.js';
import type { NotifyChannelRow } from '../../repositories/notify-channels.js';

/**
 * 外发扇出：与 Web Push 同一份载荷口径（watcher 非 null 的 watch 不外发），
 * 启用通道全收、逐通道失败隔离、绝不把异常带回总线。
 */

const channel = (id: string): NotifyChannelRow => ({
  id,
  kind: 'wecom',
  name: id,
  config: { url: 'https://qy.example/hook' },
  enabled: true,
  createdAt: new Date().toISOString(),
});

const makeFanout = (sendImpl: (channel: NotifyChannelRow) => Promise<{ ok: boolean; status: string }>) => {
  const bus = new HookEventBus();
  const send = vi.fn(async (c: NotifyChannelRow) => sendImpl(c));
  new NotifyFanout({
    channels: { listEnabled: () => [channel('a'), channel('b')] },
    bus,
    labelOf: (id) => `name-${id}`,
    sendImpl: send as never,
  });
  return { bus, send };
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const fireWatch = (bus: HookEventBus, watcherSessionId: string | null) =>
  bus.emit({
    kind: 'watch.fired',
    watchId: 1,
    targetSessionId: 's1',
    watcherSessionId,
    reason: 'idle',
    at: new Date().toISOString(),
  });

describe('NotifyFanout', () => {
  it('watch.fired（dashboard 订阅）发给全部启用通道', async () => {
    const { bus, send } = makeFanout(async () => ({ ok: true, status: 'succeeded' }));
    fireWatch(bus, null);
    await flush();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]![1]).toMatchObject({
      title: 'weave',
      body: 'Session name-s1 is now idle',
      tag: 'weave-watch-s1',
    });
  });

  it('会话对会话的 watch（watcher 非 null）不外发', async () => {
    const { bus, send } = makeFanout(async () => ({ ok: true, status: 'succeeded' }));
    fireWatch(bus, 'watcher');
    await flush();
    expect(send).not.toHaveBeenCalled();
  });

  it('question.pending 外发', async () => {
    const { bus, send } = makeFanout(async () => ({ ok: true, status: 'succeeded' }));
    bus.emit({ kind: 'question.pending', sessionId: 's1', harness: 'claude', count: 1, at: new Date().toISOString() });
    await flush();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]![1]).toMatchObject({ tag: 'weave-question-s1' });
  });

  it('单通道抛异常不影响其他通道，且不抛回 emit', async () => {
    let n = 0;
    const { bus, send } = makeFanout(async () => {
      n += 1;
      if (n === 1) throw new Error('boom');
      return { ok: true, status: 'succeeded' };
    });
    expect(() => fireWatch(bus, null)).not.toThrow();
    await flush();
    expect(send).toHaveBeenCalledTimes(2);
  });
});
