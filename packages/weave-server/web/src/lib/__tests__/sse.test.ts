import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * lib/sse 的契约：
 *   1. 全站只有一条连接（懒创建、退订不关）——这是「单个 SSE 接口」的实现基础；
 *   2. 分发按帧域拆面：`invalidate` 按 key 调重拉函数、`push` 按 key 送 payload、
 *      `subscribeFrame` 按类型、`subscribeHook` 按 kind（全量/精确/前缀）——
 *      各订阅面互不挤占（单槽 Map 的教训见 settings 那条用例）。
 */

/** 最小 EventSource 替身：只保留 lib/sse 用到的那几面。 */
class FakeEventSource {
  static latest: FakeEventSource | null = null;
  onmessage: ((ev: { data: string; lastEventId?: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(readonly url: string) {
    FakeEventSource.latest = this;
  }

  close(): void {
    this.closed = true;
  }

  /** 推一帧（序列化后走 onmessage，和真实链路一致）；`id` = 服务端的 `id:` 行。 */
  emit(payload: unknown, id?: string): void {
    this.onmessage?.({ data: JSON.stringify(payload), lastEventId: id ?? '' });
  }
}

vi.stubGlobal('EventSource', FakeEventSource);

/** 认证态是 SSE 的门：stub `/auth/status` 置已登录后再订阅（真实路径 refreshAuth）。 */
async function markAuthenticated(): Promise<void> {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ authenticated: true }), { status: 200 })),
  );
  const { refreshAuth } = await import('../auth');
  await refreshAuth();
}

describe('lib/sse', () => {
  beforeEach(() => {
    FakeEventSource.latest = null;
    vi.resetModules(); // 模块级 handlers/invalidators/source 每个用例都要是干净的
  });

  it('懒创建：首次订阅才建连接，多个订阅者共用同一条；退订不关流', async () => {
    await markAuthenticated();
    const { subscribeSse } = await import('../sse');

    const offA = subscribeSse(() => {});
    const source = FakeEventSource.latest;
    expect(source).not.toBeNull();

    const offB = subscribeSse(() => {});
    expect(FakeEventSource.latest).toBe(source); // 没有第二条连接

    offA();
    offB();
    expect(source!.closed).toBe(false); // SPA 生命周期内复用，不因没人听就断
  });

  it('未登录不建连；认证态翻到已登录即补连', async () => {
    const { subscribeSse } = await import('../sse');
    const off = subscribeSse(() => {});
    expect(FakeEventSource.latest).toBeNull(); // 未登录：连上也是 401，不建连

    await markAuthenticated();
    expect(FakeEventSource.latest).not.toBeNull(); // 认证态订阅者把既有订阅补连
    off();
  });

  it('invalidate 帧按 key 调注册的重拉函数；push / 未注册 / 已退订都不调', async () => {
    await markAuthenticated();
    const { subscribeSse, registerInvalidator } = await import('../sse');
    const offSubscribe = subscribeSse(() => {});
    const calls: string[] = [];
    const offInvalidator = registerInvalidator('projects', () => calls.push('projects'));
    const source = FakeEventSource.latest!;

    source.emit({ type: 'invalidate', key: 'projects' });
    expect(calls).toEqual(['projects']);

    // push 帧带 payload = 后端已算好，由订阅者写状态，不该触发重拉
    source.emit({ type: 'push', key: 'projects', payload: { counts: { 1: 2 } } });
    expect(calls).toEqual(['projects']);

    source.emit({ type: 'invalidate', key: 'nobody-registered' }); // 未注册不炸
    expect(calls).toEqual(['projects']);

    offInvalidator();
    source.emit({ type: 'invalidate', key: 'projects' });
    expect(calls).toEqual(['projects']); // 退订后不再触发

    offSubscribe();
  });

  it('同一 key 的多个注册者都被调到，退订只摘自己', async () => {
    await markAuthenticated();
    const { subscribeSse, registerInvalidator } = await import('../sse');
    const offSubscribe = subscribeSse(() => {});
    const calls: string[] = [];
    // 三处都关心 settings（设置弹窗 / 会话面板能力矩阵 / AI 助手浮层），
    // 单槽 Map 时只有最后注册的那个收得到——AI 助手就落后成「要刷新页面才出现」。
    const offA = registerInvalidator('settings', () => calls.push('a'));
    const offB = registerInvalidator('settings', () => calls.push('b'));
    const offC = registerInvalidator('settings', () => calls.push('c'));
    const source = FakeEventSource.latest!;

    source.emit({ type: 'invalidate', key: 'settings' });
    expect(calls).toEqual(['a', 'b', 'c']);

    offB();
    source.emit({ type: 'invalidate', key: 'settings' });
    expect(calls.slice(3)).toEqual(['a', 'c']); // 摘了 b，其余照旧

    offA();
    offC();
    expect(() => source.emit({ type: 'invalidate', key: 'settings' })).not.toThrow();
    expect(calls.length).toBe(5); // 全退订后没人接，也不炸

    offSubscribe();
  });

  it('按帧类型订阅（subscribeFrame）：只收该类型，退订即停', async () => {
    await markAuthenticated();
    const { subscribeSse, subscribeFrame } = await import('../sse');
    const offSubscribe = subscribeSse(() => {});
    const seen: string[] = [];
    const off = subscribeFrame<{ relPath: string }>('asset', (f) => seen.push(f.relPath));
    const source = FakeEventSource.latest!;

    source.emit({ type: 'project' }); // 别的类型的帧不该进来
    expect(seen).toEqual([]);
    source.emit({ type: 'asset', relPath: 'a.md' });
    expect(seen).toEqual(['a.md']);

    off();
    source.emit({ type: 'asset', relPath: 'b.md' });
    expect(seen).toEqual(['a.md']);
    offSubscribe();
  });

  it('push 帧按 key 订阅（subscribePush）：payload 直达，key 不匹配不打扰', async () => {
    await markAuthenticated();
    const { subscribeSse, subscribePush } = await import('../sse');
    const offSubscribe = subscribeSse(() => {});
    const seen: number[] = [];
    const off = subscribePush<{ counts: Record<string, number> }>('inflightCounts', (p) => {
      seen.push(p.counts['s1'] ?? -1);
    });
    const source = FakeEventSource.latest!;

    source.emit({ type: 'push', key: 'updates', payload: { counts: { p1: 2 } } });
    expect(seen).toEqual([]);
    source.emit({ type: 'push', key: 'inflightCounts', payload: { counts: { s1: 3 } } });
    expect(seen).toEqual([3]);

    off();
    source.emit({ type: 'push', key: 'inflightCounts', payload: { counts: { s1: 4 } } });
    expect(seen).toEqual([3]);
    offSubscribe();
  });

  it('hook 帧订阅（subscribeHook）：全量 / 精确 kind / 前缀 kind 各收各的', async () => {
    await markAuthenticated();
    const { subscribeSse, subscribeHook } = await import('../sse');
    const offSubscribe = subscribeSse(() => {});
    const all: string[] = [];
    const exact: string[] = [];
    const prefix: string[] = [];
    const offAll = subscribeHook((f) => all.push(f.kind ?? '?'));
    const offExact = subscribeHook((f) => exact.push(f.kind ?? '?'), ['watch.fired']);
    const offPrefix = subscribeHook((f) => prefix.push(f.kind ?? '?'), ['message.']);
    const source = FakeEventSource.latest!;

    source.emit({ type: 'hook', kind: 'event.ingested', sessionId: 's1' });
    expect(all).toEqual(['event.ingested']);
    expect(exact).toEqual([]);
    expect(prefix).toEqual([]);

    source.emit({ type: 'hook', kind: 'message.delivered', sessionId: 's1' });
    expect(all).toEqual(['event.ingested', 'message.delivered']);
    expect(exact).toEqual([]);
    expect(prefix).toEqual(['message.delivered']);

    source.emit({ type: 'hook', kind: 'watch.fired', targetSessionId: 's2' });
    expect(exact).toEqual(['watch.fired']);
    expect(prefix).toEqual(['message.delivered']); // watch.fired 不带 message. 前缀

    offExact();
    source.emit({ type: 'hook', kind: 'watch.fired', targetSessionId: 's3' });
    expect(exact).toEqual(['watch.fired']); // 退订后不再收
    expect(all.length).toBe(4); // 全量订阅者不受影响

    offAll();
    offPrefix();
    offSubscribe();
  });

  it('断流自愈：心跳照旧就不动，安静过阈值才重建连接', async () => {
    vi.useFakeTimers();
    try {
      await markAuthenticated();
      const { subscribeSse } = await import('../sse');
      const off = subscribeSse(() => {});
      const first = FakeEventSource.latest!;

      vi.advanceTimersByTime(20_000);
      first.emit({ type: 'ping' }); // 心跳到场 = 链路还活着
      vi.advanceTimersByTime(30_000);
      expect(FakeEventSource.latest).toBe(first);

      vi.advanceTimersByTime(70_000); // 之后一直安静 → 判死重建
      expect(FakeEventSource.latest).not.toBe(first);
      expect(first.closed).toBe(true);
      off();
    } finally {
      vi.useRealTimers();
    }
  });

  it('重建连接带回最后收到的帧 id，服务端据此补发；心跳不带 id 不挪 offset', async () => {
    vi.useFakeTimers();
    try {
      await markAuthenticated();
      const { subscribeSse } = await import('../sse');
      const off = subscribeSse(() => {});
      const first = FakeEventSource.latest!;
      expect(first.url).not.toContain('since='); // 首连没有 offset 可带

      first.emit({ type: 'hook', kind: 'event.ingested' }, 'abc123-7');
      first.emit({ type: 'ping' }); // 心跳不挪 offset

      vi.advanceTimersByTime(80_000); // 静默判死 → 重建（阈值 65s，巡检每 15s 一拍）
      const second = FakeEventSource.latest!;
      expect(second).not.toBe(first);
      expect(second.url).toContain('since=abc123-7');
      off();
    } finally {
      vi.useRealTimers();
    }
  });

  it('resync 帧 = 漏掉的帧补不回来：整页重来，10 秒内不连刷', async () => {
    // node 环境没有这两个浏览器全局，直接挂上去、用完还原。
    const globals = globalThis as unknown as Record<string, unknown>;
    const saved = { location: globals.location, sessionStorage: globals.sessionStorage };
    const reload = vi.fn();
    const store = new Map<string, string>();
    globals.location = { reload };
    globals.sessionStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    vi.useFakeTimers();
    try {
      await markAuthenticated();
      const { subscribeSse } = await import('../sse');
      const seen: string[] = [];
      const off = subscribeSse((f) => seen.push(f.type));
      const source = FakeEventSource.latest!;

      source.emit({ type: 'resync' });
      expect(reload).toHaveBeenCalledTimes(1);
      expect(seen).toEqual([]); // 重载后什么都不缺，不再往下分发

      source.emit({ type: 'resync' }); // 刚刷过还漏：别把页面刷成幻灯片
      expect(reload).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(11_000);
      source.emit({ type: 'resync' });
      expect(reload).toHaveBeenCalledTimes(2);
      off();
    } finally {
      vi.useRealTimers();
      globals.location = saved.location;
      globals.sessionStorage = saved.sessionStorage;
    }
  });
});
