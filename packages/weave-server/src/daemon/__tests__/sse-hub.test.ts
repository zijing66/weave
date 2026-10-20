import { describe, it, expect, vi, afterEach } from 'vitest';
import { DataBus } from '../data-bus.js';
import { SseHub } from '../sse-hub.js';

interface Out {
  id: string;
  data: string;
}

/** 一个「连接」：收自己那份帧，外加退订把手。 */
function collect(hub: SseHub): { frames: Out[]; off: () => void } {
  const frames: Out[] = [];
  const off = hub.subscribe((f) => frames.push(f));
  return { frames, off };
}

describe('SseHub', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('源只订阅一次：每个连接各收一份，不是每人向源订一遍', () => {
    const bus = new DataBus();
    const hub = new SseHub({ dataBus: bus });
    const a = collect(hub);
    const b = collect(hub);

    bus.emit({ key: 'projects' });

    expect(a.frames.map((f) => f.data)).toEqual(['{"type":"invalidate","key":"projects"}']);
    expect(b.frames.map((f) => f.data)).toEqual(a.frames.map((f) => f.data));
  });

  it('断线重连按 offset 补发：只补漏掉的那些，顺序与实时流一致', () => {
    const bus = new DataBus();
    const hub = new SseHub({ dataBus: bus });
    const a = collect(hub);

    bus.emit({ key: 'projects' });
    const last = a.frames[0].id; // 客户端最后收到的那帧
    a.off(); // 断流
    bus.emit({ key: 'settings' });
    bus.emit({ key: 'assets' });

    const replay = hub.replay(last);
    expect(replay.gap).toBe(false);
    expect(replay.frames.map((f) => f.data)).toEqual([
      '{"type":"invalidate","key":"settings"}',
      '{"type":"invalidate","key":"assets"}',
    ]);

    // 首连（没有 offset）不补发任何东西，也不算漏。
    expect(hub.replay(null)).toEqual({ frames: [], gap: false });
  });

  it('补不齐就报 gap：纪元不同（daemon 重启）或缓冲已经滚过去', () => {
    const bus = new DataBus();
    const hub = new SseHub({ dataBus: bus });
    collect(hub);

    expect(hub.replay('deadbeef-7')).toEqual({ frames: [], gap: true }); // 上一次 daemon 的序号
    expect(hub.replay('garbage')).toEqual({ frames: [], gap: true });

    for (let i = 0; i < 2000; i += 1) bus.emit({ key: 'assets' });
    // 缓冲只留最后 1000 帧：拿一个早被挤掉的 offset 回来就补不齐了。
    expect(hub.replay(`${hub.epoch}-500`).gap).toBe(true);
    expect(hub.replay(`${hub.epoch}-1500`).gap).toBe(false);
  });

  it('没有连接就不订阅源（隐藏刷新器靠 DataBus 订阅数判活），宽限期内重连不算漏', () => {
    vi.useFakeTimers();
    const bus = new DataBus();
    const hub = new SseHub({ dataBus: bus });
    const a = collect(hub);
    bus.emit({ key: 'projects' });
    const last = a.frames[0].id;
    a.off();

    // 刷新页面、网络抖动、判死重建都落在宽限期里：源照挂、帧照收，重连接着走。
    vi.advanceTimersByTime(59_000);
    expect(bus.hasSubscribers()).toBe(true);
    const again = collect(hub);
    expect(hub.replay(last)).toEqual({ frames: [], gap: false });
    bus.emit({ key: 'assets' });
    expect(again.frames).toHaveLength(1);
    again.off();

    // 宽限期一过就摘源：没人看的时候不该继续挂监听（那会把隐藏刷新器永远唤醒）。
    vi.advanceTimersByTime(60_000);
    expect(bus.hasSubscribers()).toBe(false);
    // 断档期间的帧是真丢了，客户端拿断档前的 offset 回来必须整页重来。
    expect(hub.replay(last)).toEqual({ frames: [], gap: true });

    // 新连接重新订阅，不靠谁去显式唤醒。
    const fresh = collect(hub);
    bus.emit({ key: 'settings' });
    expect(fresh.frames).toHaveLength(1);
    expect(bus.hasSubscribers()).toBe(true);
  });
});
